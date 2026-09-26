# 08 · 构建 / 打包 / Docker / CI / 测试基建评审

审阅对象：`agent-service` monorepo（上线前）。
环境：Node v24.21.0（fnm）、pnpm 12.5.1、本地 infra（redis 6379 / mysql 8.0.26 3306）。
本报告中每一条"已验证"都是实际跑出来的，命令与输出见各条目。

---

## 0. 一句话结论

**当前状态不能上线。** 打包本身（esbuild）质量相当高——产物只内联自己的 workspace 代码、字节级可重现、迁移文件随包可用、pi 的懒加载 provider 在 external 之后仍然正常。但是：

1. `Dockerfile` **从来没有构建成功过**——runtime stage 的 `pnpm install --prod` 必然失败（已实测，两个独立原因）。
2. 即使修好安装，容器里的服务**也监听在 127.0.0.1**，外部（含 router）访问不到，而 HEALTHCHECK 恰好也走 127.0.0.1，把这个问题完全掩盖。
3. CI **不构建镜像**，所以上面两条永远不会被发现。
4. `pnpm test` 当前是**红的**（仓库里躺着一个别的评审留下的 `ztmp-probe.test.ts`，15 个用例全失败）。
5. `--coverage` 没有任何阈值，纯装饰；没有任何 lint/format；`.dockerignore` 不存在，含真实 `sk-` key 的 `.env` 会进构建上下文。

---

## 1. 严重（Blocker，上线前必须修）

### B1 · Docker runtime stage 的 `pnpm install --prod` 必然失败（两个原因）

`Dockerfile:19-21`

```
COPY --from=build /app/apps/${APP}/package.json ./package.json
COPY --from=build /app/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --prod && pnpm store prune   # 实际写的是 --no-frozen-lockfile
```

**实测（复刻 runtime stage：只放 app 的 package.json + 根 lockfile）：**

```
$ pnpm install --prod --no-frozen-lockfile
Error:   × installing dependencies
  ╰─▶ Failed to resolve dependency tree: Failed to resolve dependency: Cannot
      resolve package from workspace because workspace packages were not
      loaded into the resolver
```

原因一：`apps/agent-runner/package.json:13-16` 的 `dependencies` 里有四个 `workspace:*`
（`@agent-service/core|protocol|providers|store`）。`--prod` 只跳过 `devDependencies`，这四个在
`dependencies` 里必须被解析；而 runtime stage 没有 `pnpm-workspace.yaml`，也没有 `packages/`，
`workspace:` 协议无从解析 → 安装失败 → **镜像根本构建不出来**。

原因二：把 workspace 依赖去掉再试，安装继续到最后一步后仍然非零退出：

```
+ @earendil-works/pi-ai 0.87.0 ... （113 个包装完）
Error: ERR_PNPM_IGNORED_BUILDS
  ╰─▶ Ignored build scripts: @google/genai@2.21.0, esbuild@0.28.2, protobufjs@7.6.6
```

pnpm 12 在有被忽略的 build script 时**以非零码退出**。而白名单
（`package.json:34-40` 的 `pnpm.onlyBuiltDependencies`、`pnpm-workspace.yaml:4-7` 的 `allowBuilds`）
都只存在于根清单/根 workspace 文件，runtime stage 一个都没有 → `RUN` 失败。

原因三（不致命但同样错）：`--no-frozen-lockfile` 在清单与 lockfile 的 importer 不匹配时会**放弃 lockfile
重新向 registry 解析**。实测 `zod: ^3.24.4` 解析到 `3.25.76`。也就是说即使装成功了，镜像里的第三方版本
**与 CI 测过的版本不是同一批**，构建不可重现。

**修法（二选一，推荐 A）：**

- **A：让 workspace 依赖在 runtime stage 不存在。** bundle 已经把 `@agent-service/*` 全部内联
  （见 §3 验证），它们本质上是 build-time 依赖。把 app 清单里的四个 `workspace:*` 移到
  `devDependencies`，runtime `pnpm install --prod --frozen-lockfile` 就不需要 workspace 了。
  但仍需把根 `pnpm-workspace.yaml`（或等效的 `onlyBuiltDependencies`）一起 COPY 进 runtime stage，
  否则 ERR_PNPM_IGNORED_BUILDS 照样触发。
- **B：在 build stage 用 `pnpm deploy --filter <app> --prod --legacy /out` 生成一个自包含目录**，
  runtime stage 只 `COPY --from=build /out/node_modules ./node_modules`，完全不在 runtime 跑 pnpm，
  顺带去掉 `corepack enable` 和网络依赖。见 §8 的完整 Dockerfile。

### B2 · 容器里服务只监听 127.0.0.1，HEALTHCHECK 掩盖了这一点

`apps/agent-runner/src/config.ts:5` `RUNNER_HOST` 默认 `127.0.0.1`；
`apps/agent-router/src/config.ts:5` `ROUTER_HOST` 默认 `127.0.0.1`。
`Dockerfile` 没有设置任何一个。

结果：容器内 `serve({hostname:"127.0.0.1"})` 只绑定 loopback，**宿主 / k8s Service / router 都连不上**。
而 `Dockerfile:27` 的 HEALTHCHECK 用 `fetch('http://127.0.0.1:...')`，在容器内部当然通过 →
容器状态 healthy，流量却 100% 打不进去。这是最典型的"健康检查骗过自己"。

修：`ENV RUNNER_HOST=0.0.0.0 ROUTER_HOST=0.0.0.0`（或在 config 里让 `NODE_ENV=production` 时默认
`0.0.0.0`），并让 HEALTHCHECK 依然走 127.0.0.1（那是对的，只是不能是唯一的绑定地址）。

### B3 · router 的 HEALTHCHECK 端口和 EXPOSE 都是错的

`Dockerfile:24` `EXPOSE 8787`；`Dockerfile:27`
`process.env.RUNNER_PORT||process.env.ROUTER_PORT||8787`。

- router 的默认端口是 **8080**（`apps/agent-router/src/config.ts:4`），不是 8787。以 `APP=agent-router`
  构建、不显式给 `ROUTER_PORT` 时，健康检查去探 8787 → **永远 unhealthy** → 编排系统无限重启。
- 优先级也反了：如果部署环境（例如同一个 ConfigMap）同时注入了 `RUNNER_PORT` 和 `ROUTER_PORT`，
  router 会去探 `RUNNER_PORT`。
- `EXPOSE` 是单值的，无法同时描述两个 app。

修：`ARG APP` 时一并 `ARG PORT`，`ENV PORT=${PORT}` / `EXPOSE ${PORT}`，健康检查只读 `PORT`。

### B4 · 仓库里躺着会让 `pnpm test` 整体失败的残留测试文件

`apps/agent-runner/test/ztmp-probe.test.ts`（19 KB，另一轮安全评审的探针）被
`vitest.config.ts:4` 的 `include: ["apps/*/test/**/*.test.ts"]` 命中。实测：

```
 Test Files  1 failed | 10 passed | 1 skipped (12)
      Tests  15 failed | 124 passed | 1 skipped (140)
TypeError: The "path" argument must be of type string ... （PROBE_LOG 未设置）
```

即 **CI 的 `test` job 现在是红的**。上线前要么删掉，要么改成不依赖 `PROBE_LOG` 的正式用例
（里面 P1/P2/P5/P12/P13 描述的都是真问题，值得转正）。顺便：`ztmp-`/`*.probe.*` 这类临时文件
应该进 `.gitignore` 或用 `vitest.config.ts` 的 `exclude` 兜住。

### B5 · `.dockerignore` 不存在：含真实 API key 的 `.env` 进入构建上下文

仓库根没有 `.dockerignore`（`ls -a` 已确认）。`docker build .` 会把整个目录发给 daemon，包括：

- `.env` —— 实测里面是**真实的 DashScope key**（`API_KEY=sk-b…`）。它虽然没被任何 `COPY` 引用，
  但已经进了 daemon 的构建上下文与 BuildKit 缓存，任何 `COPY . .` 的手误就会直接进镜像层。
- `.git/`（含全部历史）、`coverage/`、`node_modules/`、`apps/*/dist/`、`spikes/`。
- `COPY apps ./apps`（`Dockerfile:7`）会把宿主机的 `apps/*/dist`（含 macOS 上 `tsc -b` 生成的
  未打包 `main.js`，见 B6）和 `apps/*/node_modules`（darwin-arm64 的 esbuild 二进制）拷进 linux 镜像。

`.dockerignore` 见 §8。

### B6 · `tsc -b`（`pnpm typecheck`）会用未打包的 `main.js` 覆盖 bundle

`apps/agent-runner/tsconfig.json` 的 `outDir: dist` 与 `scripts/build-app.mjs:33` 的
`outfile = apps/<app>/dist/main.js` 是**同一个文件**。`pnpm typecheck`
（`package.json:12`）第一步是 `tsc -b tsconfig.json`，它是会 emit 的。实测：

```
$ pnpm build            # 150434 bytes，bundle
$ npx tsc -b tsconfig.json --force
$ ls -la apps/agent-runner/dist/main.js
-rw-r--r--  3806 ...     # 变成 tsc 的未打包输出
$ head -2 apps/agent-runner/dist/main.js
import { serve } from "@hono/node-server";
import { PiEngine, ... } from "@agent-service/core";   # node 解析不到 src/*.ts → 启动即崩
```

今天 CI 侥幸没爆，只因为 `test` job（跑 typecheck）和 `build` job（跑 build）是两个独立 job。
但：本地 `pnpm build` 之后随手 `pnpm typecheck` 就会把产物毁掉且毫无提示；任何人把 typecheck
加进 `build` job 或 Dockerfile，镜像立刻带上一个必崩的 `main.js`。

另外 `pnpm build` **不清空 dist**，所以 `apps/agent-runner/dist/` 里现在同时有
`app.js / auth.js / config.js / sse.js / end-user-auth.js + *.d.ts + *.map`（tsc 产物）和
`main.js`（bundle）。它们都会被 `COPY --from=build /app/apps/${APP}/dist ./dist` 装进镜像。

修：把 app 的 `tsc` 输出改到独立目录（`"outDir": ".tsbuild"`，只为 `.d.ts`/类型检查服务），
并在 `build-app.mjs` 里先 `rm -rf` 再 build。见 §8。

---

## 2. 高（上线前强烈建议修）

### H1 · CI 从不构建 Docker 镜像

`.github/workflows/ci.yml` 只有 `test` 和 `build`（`pnpm build` + `check-dist-boot`）两个 job，
**没有任何一步 `docker build`**。B1/B2/B3 全部是"只要构建一次镜像就必然暴露"的问题，却一次都没暴露。
这是本次评审里最值得记住的一条：门禁没有覆盖真正的交付物。

### H2 · `--coverage` 没有阈值，等于没有门禁

`ci.yml:72` 跑了 `--coverage` 并上传 artifact（`ci.yml:82-88`），但 `vitest.config.ts` 里
**没有 `coverage.thresholds`**，覆盖率降到 0 也能绿。实测当前值（`AGENT_SERVICE_INTEGRATION=1`，
排除 cluster 与 ztmp-probe）：

| 范围 | Statements | Branches | Functions | Lines |
|---|---|---|---|---|
| 默认（仅被 import 的文件，含测试辅助文件） | 78.70% | 64.05% | 74.61% | 83.37% |
| 只算 `packages/*/src` + `apps/*/src`（含未被测到的文件） | **69.20%** | **56.75%** | **64.98%** | **73.82%** |

第二行才是真实水位。具体配置见 §7.1。低点分布：

- `apps/agent-router/src/*` —— `app.ts` / `config.ts` / `main.ts` / `registry.ts **全部 0%**。
  router 没有任何单元测试，唯一覆盖来自 cluster job（另一个 job，且 `describe.skipIf` 默认跳过）。
- `packages/core/src/context/compact.ts` —— **5.26%**。压缩逻辑基本没测。
- `packages/store/src/blob/fs.ts` —— **0%**。
- `packages/store/src/mysql/store.ts` —— 59.25% / 47.09% branch。
- `apps/agent-runner/src/app.ts` —— 61.72% / 43.75% branch（HTTP 层主体）。

### H3 · `build` job 不对 bundle 跑任何测试，且只验证了 runner + memory store

`scripts/check-dist-boot.mjs:8` 硬编码 `apps/agent-runner/dist/main.js`：

- **router 的 bundle 从来没有被启动过**。它的 external 集合不同（`@hono/node-server / hono / ioredis / zod`），
  一次 import 失败就是线上事故。
- `ci.yml:108` 用 `STORE: memory`，所以 bundle 的 **MySQL 迁移路径从未在 CI 被走过**。
  `scripts/build-app.mjs:53` 把 `packages/store/migrations` 拷到 `dist/migrations`，
  `packages/store/src/mysql/store.ts:50-66` 靠 `dirname(fileURLToPath(import.meta.url))` 找它——
  这条路径只在本机被我手工验证过（见 §3）。CI 应该起一个 MySQL 让 bundle 真正迁移一次。
- 除了 `/healthz`（`apps/agent-runner/src/app.ts:74`，一个无条件 `c.text("ok")`）之外没有任何断言。
  这个探针**在几乎所有回归下都会通过**。至少应该打 `/readyz`（`app.ts:75`，接 `deps.ready()`）
  加一次 `POST /v1/agents` 的 201。

### H4 · 完全没有 lint / format

无 eslint / prettier / biome / oxlint / editorconfig（已确认）。对一个马上要多人维护的服务，
至少需要能挡住：`no-floating-promises`（这个 codebase 到处是 `void this.handle(...)`、
`setInterval(async …)`，正是浮空 Promise 的高发区）、`no-unused-vars`、
`require-await`、统一格式。最小方案见 §7.2。

### H5 · 镜像体积：121 MB 的 prod 依赖，其中约 45 MB 永远不会被用到

实测 runner 的 prod `node_modules` = **121 MB**，大头全部来自 `@earendil-works/pi-ai` 的
传递依赖（它是无条件 `dependencies`）：

```
17M  openai@6.40.0
14M  @anthropic-ai/sdk@0.124.0
11M  @google/genai@2.21.0
 6M  @smithy/core  (+ @aws-sdk/client-bedrock-runtime 系列)
 9M  web-streams-polyfill
```

本服务只走 `openai-completions`（`packages/providers` 里只注册这一种 api），
Anthropic / Google / Bedrock 三套 SDK 是纯负担。`node:24-slim` ≈ 220 MB，合计 ≈ 350 MB+。

可做的：
- 镜像基座换 `node:24-alpine`（mysql2/ioredis 都是纯 JS，无原生模块，可行）；
- 或者反过来把 `@earendil-works/pi-ai` 也 **inline 进 bundle** 并让 esbuild tree-shake 掉未用的
  lazy provider——但注意 §3.4：pi 的 lazy 加载是 `import("./openai-completions.js")` 相对路径动态 import，
  一旦内联 esbuild 会把**所有** `*.lazy.js` 引用到的实现一起打进来，反而更大。所以务实的做法是
  向 pi 提 issue 把重 SDK 挪到 `optionalDependencies`，短期先接受体积。

### H6 · source map（含完整 TypeScript 源码）会进生产镜像

`scripts/build-app.mjs:40` `sourcemap: true`，且 esbuild 默认 `sourcesContent: true`。实测：

```
apps/agent-runner/dist/main.js.map   319 KB, sources: 33, sourcesContent: true
apps/agent-router/dist/main.js.map    67 KB
```

也就是说 `.map` 里带着 `packages/*/src/**` 的**完整原文**，
`COPY --from=build .../dist ./dist` 会把它一起装进镜像。

建议：保留 map（线上栈追踪很有价值）但 `sourcesContent: false`，源码由 CI artifact / sourcemap 服务保管；
或至少在最终镜像里不 COPY `*.map`。二选一，不要两边都不做。

### H7 · `USER node` + root 所有权：blob 写入必然 EACCES

`Dockerfile:19-23`：所有 `COPY --from=build` 都没有 `--chown`，`pnpm install` 也是 root 跑的，
随后 `USER node`。产物只读没问题，但
`apps/agent-runner/src/config.ts:12` `BLOB_DIR` 默认 `./.data/blobs`，相对 `WORKDIR /app`，
即 `/app/.data/blobs`，属主 root、模式 755 → `FsBlobStore.put`
（`packages/store/src/blob/fs.ts:15` 的 `mkdir(..., {recursive:true})`）会 **EACCES**。
第一次需要落 blob 的请求就 500。

修：`RUN mkdir -p /app/.data/blobs && chown -R node:node /app/.data`（或 `VOLUME` + `--chown=node:node`），
并给 `COPY --from=build` 加 `--chown=node:node`。

---

## 3. 打包审计（esbuild）——做得对的部分，含验证方式

这一节整体是**好评**，记录下来以免后续重构把它改坏。

### 3.1 只内联 `@agent-service/*`：已验证

`scripts/build-app.mjs:20-31` 的 `externalize-third-party` 插件逻辑正确：
`onResolve` filter `/^[^./]|^\.\.?\//` 命中裸规范符与相对路径，相对路径 `return null` 交回 esbuild，
裸规范符里只有 `@agent-service/` 前缀放过去内联，其余全部 `external: true`。

**验证方式**（不看代码、直接看产物 banner）：

```
$ grep -oE '^// .*' apps/agent-runner/dist/main.js | sort -u
// apps/agent-runner/src/{app,auth,config,end-user-auth,main,sse}.ts
// packages/core/src/{ids,engine/pi,context/{assemble,history},session/host,tools/{dynamic,types,builtin/index}}.ts
// packages/protocol/src/*.ts
// packages/providers/src/{presets,secrets,service}.ts
// packages/store/src/{types,memory,mysql/store,redis/bus,redis/lease,blob/fs}.ts
```

**没有一行第三方代码**。router 同理（只有 `apps/agent-router/src/*` + `packages/protocol/src/*`）。

### 3.2 external 集合与 app 清单的 diff：runner 一致，router 有 2 个未声明

从产物里抽出全部 external import：

| runner bundle 的 external | 在 `apps/agent-runner/package.json` 的 dependencies？ |
|---|---|
| `@earendil-works/pi-agent-core` | ✅ |
| `@earendil-works/pi-ai` | ✅ |
| `@earendil-works/pi-ai/api/openai-completions.lazy` | ✅（深层导入，见 3.3） |
| `@hono/node-server` | ✅ |
| `hono`, `hono/body-limit`, `hono/streaming` | ✅ |
| `ioredis`, `jose`, `mysql2/promise`, `typebox`, `zod` | ✅ |
| `node:crypto/dns/fs/net/path/url` | 内置 |

**runner 的依赖清单完全覆盖 bundle 的 external，无缺失、无多余。** （`@agent-service/providers` 同时
出现在 `dependencies` 和 `devDependencies`，重复声明，无害但应删掉 devDependencies 里那一条。）

router bundle 的 external：`@hono/node-server`, `hono`, `ioredis`, `zod`, `node:crypto` ——
全部在清单里。✅

### 3.3 深层导入与 `node:` 前缀的边界

- **深层导入**：`@earendil-works/pi-ai/api/openai-completions.lazy` 被正确标成 external。
  运行时能解析，因为 pi-ai 的 `exports` 里有 `"./api/*": {"import": "./dist/api/*.js"}`（已核对
  `node_modules/.pnpm/@earendil-works+pi-ai@0.87.0.../package.json`）。**但这是脆的**：
  esbuild 不校验 external 深层路径是否真的在 `exports` 里，写错一个子路径要到容器启动才炸。
  建议 `check-dist-boot.mjs` 保留并扩到 router（见 H3）——它正是这类错误唯一的网。
- **`node:` 前缀 vs 裸内置**：`scripts/build-app.mjs:43` 的 `external: ["node:*"]` 是**冗余的**——
  插件已经把所有裸规范符（含 `fs`、`path`）标成 external。两者行为一致，无冲突。可以删，
  但保留也无害（它只是 belt-and-braces）。
- **绝对路径导入**（`/abs/x.js`）不被 filter 命中，走 esbuild 默认解析 → 会被内联。当前无此用法。
- **workspace 包的子路径导入**（例如 `@agent-service/store/migrations`）会 `return null` 走 exports map，
  而 `packages/store/package.json` 只导出 `"."` → 会构建失败。当前无此用法，但要知道这条边界。

### 3.4 pi 的 lazy provider 加载在打包后仍然正常：已验证

`pi-ai/dist/api/openai-completions.lazy.js:2`：

```js
export const openAICompletionsApi = () => lazyApi(() => import("./openai-completions.js"));
```

这是**相对路径**的动态 import。因为整个 `@earendil-works/pi-ai` 是 external，这段代码
在运行时由 node 在 `node_modules` 里解析，esbuild 完全不介入 → **打包不影响它**。

同时确认 pi 内部有若干变量规范符动态 import（`env-api-keys.js:13`、`auth/context.js:10`、
`auth/oauth/load.js:17`、`api/bedrock-converse-stream.lazy.js:18`，形如
`import(__rewriteRelativeImportExtension(specifier))`）。这些**如果被内联**，esbuild 会报
"This dynamic import will not be bundled" 并在运行时炸。当前 external 策略恰好避开了。
**结论：不要把 pi 内联进 bundle**（这也和 H5 的"缩体积"诉求冲突，取舍要有意识）。

### 3.5 迁移文件拷贝：已验证端到端可用

`scripts/build-app.mjs:53` 拷 `packages/store/migrations` → `dist/migrations`；
`packages/store/src/mysql/store.ts:50-66` 的候选路径里 `join(here, "migrations")` 命中。

实测（bundle + 真 MySQL）：

```
$ STORE=mysql MYSQL_URL=mysql://root@127.0.0.1:3306/agent_service_test \
  SECRETS_MASTER_KEY=... RUNNER_PORT=8793 node apps/agent-runner/dist/main.js
$ curl http://127.0.0.1:8793/healthz   -> ok
$ curl http://127.0.0.1:8793/readyz    -> ready     # 说明 5 个迁移全部执行成功
```

两个小问题：
- `build-app.mjs:53` **无条件**给两个 app 都拷迁移，`apps/agent-router/dist/migrations` 是纯垃圾
  （router 不依赖 `@agent-service/store`）。
- `cp(..., {recursive:true})` 不删旧文件。删掉一个迁移再 build，旧 `.sql` 仍留在 dist 里，
  而 `migrate()`（`store.ts:90`）是"目录里所有 `.sql` 排序后执行"，会执行一个已经从源码里删掉的迁移。
  低概率但很难查。build 前 `rm -rf dist` 一并解决。

### 3.6 `dist/package.json = {type:"module"}`：可以接受，但理由要写对

`build-app.mjs:51`。这是必要的：bundle 是 ESM `.js`，而在 Docker runtime stage 里
`/app/package.json` 是 app 的清单（本身有 `"type":"module"`），所以 `dist/package.json` 在那里是冗余的；
但在**本地**从仓库根跑 `node apps/agent-runner/dist/main.js` 时，最近的 `package.json` 是
`apps/agent-runner/package.json`（也有 `type:module`）——所以严格说两种场景下它都是冗余的。
留着无害（它让 `dist/` 自包含、可以整目录搬走），但 `build-app.mjs:46-47` 的注释
（"migrations are read at runtime relative to the store package; keep the path resolvable"）
挂在 `define: { "process.env.BUNDLED": '"1"' }` 上是**错的**：全仓库 `grep BUNDLED` 只有这一处，
**这个 define 是死代码**，而且注释描述的是下面 `cp` 那行的事。删掉 define、把注释挪位。

### 3.7 可重现性：已验证字节一致

```
$ pnpm build && shasum -a 256 apps/*/dist/main.js
cea0af65...  apps/agent-runner/dist/main.js
822fd1ad...  apps/agent-router/dist/main.js
$ pnpm build && shasum -a 256 apps/*/dist/main.js     # 完全相同
```

无时间戳、无内容哈希注入。✅ 前提是 external 版本不漂（这正是 B1 原因三破坏的东西）。

---

## 4. CI 审计（`.github/workflows/ci.yml`）

### 做对的

- `concurrency` + `cancel-in-progress`（`ci.yml:9-11`）✅
- `pnpm/action-setup@v4` 在 `actions/setup-node@v4` **之前**、`cache: pnpm`（`ci.yml:46-52`）——
  顺序正确，pnpm store 确实被缓存了（这条在很多仓库里是反的）。除此之外没有别的缓存
  （esbuild / vitest 无需缓存，可以不管）。
- `node-version-file: .node-version` **被正确使用**（`ci.yml:51`）。但 `.node-version` 内容是
  `24`（不是 `24.21.0`），setup-node 会解析成 24 的最新补丁版 → 与本机不严格一致，也意味着
  某天 Node 24 的新补丁会静默改变 CI 行为。建议 pin 完整版本（`engines: ">=24"` 保持宽松即可）。
- `--exclude 'test/cluster/**'`（`ci.yml:72`）**在 vitest 4 下写法是对的**，已核对实现：
  CLI `--exclude` → `argv.cliExclude`（`vitest/dist/chunks/cac.*.js:2325-2327`），
  最终 `resolved.exclude.push(...resolved.cliExclude)`（`coverage.*.js:355`）——是**追加**，
  不会覆盖 `**/node_modules/**` / `**/dist/**` 等默认排除。实测文件清单从 12 个变 11 个，符合预期。
- store conformance **确实在 CI 跑了两套后端**：`ci.yml:69-71` 设了
  `AGENT_SERVICE_INTEGRATION=1` / `MYSQL_TEST_URL` / `REDIS_TEST_URL`，
  `packages/store/test/mysql-redis.test.ts:10` 的分支被打开。本机复现：
  `memory.test.ts (11 tests)` + `mysql-redis.test.ts (11 tests)`，数量一致。✅
- 不需要任何真实 secret（`ci.yml:14-15` 的 `SECRETS_MASTER_KEY` 是全 `1` 的测试 key）。
  这是**可接受**的：它是 32 字节的确定性测试常量，不是凭据。两点小建议——
  ①名字上标注（`SECRETS_MASTER_KEY_TEST_ONLY` 或加注释已有，够了）；
  ②它写在 workflow 级 `env`，对 `build` job 也生效（`check-dist-boot` 需要它，所以是必要的），
  但要确保永远不会有 job 把它当真 key 用去连真实后端。当前没有。

### 缺的

| 缺什么 | 影响 | 建议 |
|---|---|---|
| Docker 构建 | B1/B2/B3 永不暴露（**最重要**） | 加 `docker build --build-arg APP=agent-runner`，再 `docker run` 打 `/readyz` |
| coverage 阈值 | `--coverage` 装饰品 | §7.1 |
| lint / format | 风格漂移 + 浮空 Promise 无人管 | §7.2 |
| 对 bundle 跑测试 | `build` job 只验证了一个 `c.text("ok")` | H3 |
| matrix | 只有 ubuntu + Node 24 单点。本项目只部署 linux/node24，**不加 matrix 是可以接受的**；但开发机是 macOS，`deploy/local/infra.sh` 只在 mac 可用，建议至少加 `macos-latest` 跑非集成的单测 | 低优先 |
| 依赖审计 | 无 `pnpm audit`；注意 `pnpm-workspace.yaml:8-12` 有 `minimumReleaseAgeExclude` 白名单（说明确实开了 minimumReleaseAge 供应链策略，这点是好的） | 加 `pnpm audit --prod --audit-level=high`（`continue-on-error: true` 起步） |
| "集成测试真的跑了"的断言 | `mysql-redis.test.ts:23-26` 的 else 分支是一个 `it.skip`，忘记设 env 时 CI 依然全绿 | CI 里加一步断言 mysql/redis conformance 的用例数 > 0，或改成 env 缺失时 `throw` |

### cluster job 的 flake 风险（`ci.yml:75-80`）

1. **端口 TOCTOU**：`test/cluster/harness.ts:15-23` 的 `freePort()` 绑 0 端口、拿到号、关闭，
   然后子进程再去绑。3 runner + 1 router + fake vendor 共 5 次，GitHub runner 上窗口不小，
   撞端口就是一次难以复现的失败。改成把 `0` 直接交给子进程（让它自己 bind 0 并把实际端口打到 stdout，
   harness 从日志里读），或失败重试。
2. **`startCluster` 无 try/catch**：`harness.ts:110-190`。第 2 个 runner 起不来时抛异常，
   而 `takeover.test.ts:13-16` 的 `afterEach` 只清理已赋值的 `cluster` ——
   此时 `cluster` 还是 `undefined` → **已经 spawn 的 runner 进程和 FakeVendor 的监听 socket 全部泄漏**，
   后续用例端口/DB 冲突，最终 job 挂到 20 分钟超时。必须包 try/catch 并在失败路径上 `stop()`。
3. **时间常数偏紧**：`takeover.test.ts:81` 用 `ttftMs: 8_000` 配 `leaseTtlMs: 2_000`，
   `waitHttp` 只给 30 s 等 `/readyz`（`harness.ts:26`），而 runner 是 `node --import tsx` 现场转译启动。
   CI 冷缓存下 3 个 runner 串行启动很容易接近 30 s。建议 `waitHttp` 提到 60 s，
   并给 cluster job 加 `retry`（GitHub 层面用 `nick-fields/retry`，或 vitest `retry: 1`）。
4. cluster job 与 unit job 在**同一个 job** 里串行，共用 `timeout-minutes: 20`；4 个用例的
   `testTimeout` 加起来是 600 s，加上 unit + typecheck + 安装，余量不多。建议拆成独立 job。

---

## 5. Fake vendor 保真度（`packages/testkit/src/fake-vendor.ts` vs pi 的真实解析器）

对照 `oss-refs/pi/packages/ai/src/api/openai-completions.ts`（1726 行，客户端真正的解析路径）。

### 5.1 已忠实复现的（并且确认客户端真的会走这条路）

| fake vendor 行为 | 客户端处理位置 | 结论 |
|---|---|---|
| `delta.reasoning_content` | `openai-completions.ts:605` 的 `["reasoning_content","reasoning","reasoning_text"]` 取第一个非空 | ✅ 顺序正确，fake 选的正是 DeepSeek/DashScope 的那个字段 |
| 三种缓存方言 | `parseChunkUsage` `:1522-1524`：`prompt_tokens_details.cached_tokens ?? prompt_cache_hit_tokens ?? cached_tokens` | ✅ 三个都会被读到，`dialect.test.ts:104-117` 三份都断言了定价 |
| 末尾 `choices: []` + `usage` 的独立 chunk（`fake-vendor.ts:175`） | `:562-567`：先 `if (chunk.usage)`，再 `choices[0]` 为 undefined → `continue` | ✅ 这是真实厂商（含 `stream_options.include_usage`）的行为 |
| `: keep-alive` 注释行（`:159`） | OpenAI SDK 的 SSE 解码器丢弃注释行 | ✅ |
| tool_call 参数分片，首片带 id/name（`:168-169`） | `ensureToolCallBlock` `:494-549` + `:645-651` 的 `partialArgs` 累加 | ✅ |
| `finish_reason: length` 与 `content_filter` | `mapStopReason` `:1554-1578`（`content_filter` → `stopReason:"error"` → `:688` 抛错） | ✅ `dialect.test.ts:127-145` 的"截断则丢弃全部 tool call"是很好的用例 |
| HTTP 4xx/5xx + `retry-after` | `retryProviderRequest` | ✅ 结构可表达 |
| 中途 `res.destroy()` 断流 | catch 分支 `:700-720` | ✅ |
| `stream: true` 请求参数与 `max_tokens` 字段名 | `:819`、`:829` | ✅ `dialect.test.ts:158-167` 断言了 |

### 5.2 未复现、且**确实要紧**的方言行为

按"上线后踩坑概率 × 排查成本"排序：

1. **200 响应体里的错误对象（内容审核 / 限流的 SSE 形式）** —— 最高价值缺口。
   DashScope 与 DeepSeek 都会在 HTTP 200 的 SSE 流里发
   `data: {"code":"DataInspectionFailed","message":"..."}` 或 `data: {"error":{...}}` 然后直接关流。
   客户端路径：这种 chunk 没有 `choices` → `:567` `continue` → 流结束 → `:696`
   抛 **`Stream ended without finish_reason`**。也就是说线上遇到内容审核拦截，
   用户看到的是一句与真实原因毫无关系的错误。fake vendor 只能造 HTTP 级错误
   （`fake-vendor.ts:107-110`），**造不出这一种**。建议给 `ScriptedReply` 加
   `sseError?: unknown`（在若干 delta 之后 `send(sseError)` 再 `res.end()` 不发 `[DONE]`），
   并让服务层把它映射成一个有意义的错误码。
2. **tool_call 的 `index` 语义**。fake 永远发"稳定、递增、互不相同的 index，且 id/name 只在首片"
   （`fake-vendor.ts:165-170`）。真实厂商有三种变体，客户端**专门为它们写了代码**，
   却一条都没被测到：
   - 续片**不带 `index`**（只有 `function.arguments`）→ 客户端靠 `toolCallBlocksById` 兜底（`:498-500`）；
   - 多个并行 tool call **index 全是 0**、靠 id 区分 → `toolCallBlocksByIndex` 会错误合并；
   - `id` 在**第二片**才出现 → `:638-641` 的 `if (!block.id && toolCall.id)`。
   这是最容易在线上产生"参数拼接错位"的地方，务必补。
3. **`choice.usage`（Moonshot/Kimi 的非标准位置）** —— 客户端有显式 fallback
   `:569-573`（`if (!chunk.usage && (choice as any).usage)`），fake vendor 的 `kimi` 方言
   只是把 `cached_tokens` 提到标准 `usage` 顶层（`fake-vendor.ts:199-201`），
   **产生不了 `choices[0].usage`**。Kimi 方言其实没测到它最特别的那一点。
4. **每个 chunk 都带 `usage`（累计值）**。DashScope 兼容模式会在每个 chunk 上带 `usage`。
   客户端是"后来者覆盖"（`:562-564`），语义正确；但我们自己的计费 ledger
   （`host.ts` 的 usage 累加）如果按事件累加就会重复计费。fake 只在最后一个 chunk 发
   （`fake-vendor.ts:175`），这条**完全没覆盖**。
5. **`usage` 的字段优先级**。`:1523` 是 `prompt_tokens_details.cached_tokens ?? prompt_cache_hit_tokens ?? cached_tokens`。
   真实存在同时返回两个的网关（注释里提到 chutes.ai 同时给两份 reasoning）。
   fake 的 `switch`（`:191-204`）**互斥**，优先级从未被验证。
6. **`prompt_tokens_details.cache_write_tokens`**（`:1525` 会读，参与 `totalTokens` 与定价）
   fake 从不发 → `cacheWrite` 计价路径是死代码。
7. **非流式路径是死代码**。`fake-vendor.ts:111` 的 `if (body.stream === false)` 与
   `nonStreamBody()`（`:115-130`，包括它在 `message` 上放 `reasoning_content`）
   **永远不会被 pi 触发**：`openai-completions.ts:819` 恒定 `stream: true`。
   要么删掉这段（少 16 行假保真度），要么写一个直接打 fake vendor 的 dialect 测试来守住它。
   注意区分：服务自己的 `POST /turns {"stream":false}` 是 HTTP 层的事，和上游厂商无关。
8. **`[DONE]` 缺失**。fake 恒发（`:176`）。真实网关（尤其是被 nginx 截断时）会直接 EOF。
   客户端行为可表达（`:696` 抛 `Stream ended without finish_reason`），但没测。
   建议加 `omitDone?: boolean`。
9. **`role` / 空 delta 的分片形态**。fake 只在开头发一次 `{role:"assistant",content:""}`（`:160`）。
   真实流里有：重复的 role delta、`content: null`、`delta: {}`、
   以及**流中段**出现 `choices: []`（Azure 与部分网关的首 chunk）。客户端全都 `continue`/跳过
   （`:587-590` 的 `length > 0` 判断、`:567` 的 `!choice` 判断），行为正确但零覆盖。
10. **`finish_reason` 与最后一段内容同 chunk**。fake 用一个独立的空 delta chunk 发
    finish_reason（`:172`）；大多数厂商是**和最后一个 content delta 合在同一个 chunk**。
    这会影响"delta 顺序 / item 收尾"的边界（`host.test.ts:370-387` 测的正是这个），
    但测的是 fake 的形态，不是真实形态。
11. **DashScope `incremental_output`**。pi 全仓库只发 `enable_thinking`
    （`openai-completions.ts:886-897`，thinkingFormat `qwen`），**从不发 `incremental_output`**。
    在 DashScope 的 **OpenAI 兼容模式**下输出默认就是增量的，所以今天没问题。
    但如果有人把 provider 的 `baseUrl` 指到 DashScope **原生** `/api/v1/services/aigc/...`，
    delta 会变成"累计全文"，客户端逐段 `block.text += delta` 会得到 O(n²) 的重复文本。
    fake vendor 应该提供一个 `cumulativeDeltas?: boolean` 方言开关，把这个失败模式钉死在测试里
    （即便结论是"我们只支持兼容模式"，也该有一个断言来表达这件事）。
12. **429 重试后成功**。`dialect.test.ts:169-176` 只脚本了一个 429，
    所以走的是"重试耗尽"。fake 的队列语义（`fake-vendor.ts:106` `queue.shift()`）
    天然支持 `[{httpError:429},{text:"ok"}]` 来测"重试后成功"，白白浪费了。

### 5.3 小结

fake vendor 的**已覆盖部分质量很高**（比大多数项目的 mock 强），文件头注释（`:9-14`）列的 5 条
自称"逐条对照厂商文档验证过"也确实都对得上客户端代码。它的问题不是"造假"，
而是**只造了 happy path 的方言**：所有"客户端专门写了兜底代码"的分支（index 缺失、
choice.usage、流内错误、无 `[DONE]`、累计 delta）恰好一条都造不出来。
上线前至少补 §5.2 的 1、2、7、8 这四项。

---

## 6. 测试质量

### 6.1 删掉功能仍然会通过的测试

| 位置 | 问题 |
|---|---|
| `packages/providers/test/dialect.test.ts:183-184` | `if (answer && answer.type === "agentMessage") expect(answer.text.length).toBeGreaterThan(0)` —— **断言在 `if` 里面**。"断流前已流出的文本要保留"这个行为如果整体没了（一个 item 都不写），测试**照样绿**。改成先 `expect(answer).toBeDefined()`。 |
| `test/cluster/takeover.test.ts:61-72` | `if (direct.status === 409) { …断言 X-Owner… } else { expect(direct.status).toBe(202) }` —— 两条分支都接受。把 409 + `X-Owner` + router 重试这一整套删掉、让非 owner 直接 202，测试仍然绿。这恰好是这个 job 存在的理由。 |
| `test/cluster/takeover.test.ts:141-142` | `expect(replayed).toEqual(seqs.slice(0, replayed.length))` —— 自引用长度。`replayed` 为空数组时**永远通过**。前面 `waitFor` 等的是 `replay.events.length`，而 `replayed` 是再过滤 `e.id !== undefined` 之后的，两者不是一回事。 |
| `test/cluster/takeover.test.ts:124` | `expect(turns.filter(inProgress).length).toBeLessThanOrEqual(1)` —— 0 也过。 |
| `packages/core/test/host.test.ts:376` | `expect(started).toBeGreaterThanOrEqual(0)` —— 只是在说 `findIndex` 找到了；下一行的 `toBeLessThan(firstDelta)` 才是真断言。冗余但无害。 |
| `packages/core/test/host.test.ts:339-341` | `expect(turn?.status === "inProgress" \|\| turn?.status === "failed").toBe(true)` —— 两种都接受，注释也承认了。可以，但要意识到这条几乎测不到东西。 |

### 6.2 时序依赖 / CI flake 风险

- `host.test.ts:353` `expect(elapsed).toBeLessThan(3000)`（`drain(500)` 之后）。这是唯一一条
  **墙钟断言**。余量 6 倍，在 GitHub runner 上大概率安全，但属于"某天会莫名红一次"的类型。
  更稳的写法是断言 `drain` 的返回/状态而不是耗时。
- `host.test.ts:170-177` `approvalTtlMs: 150` + `waitIdle(5000)`：超时方向是单调的，安全。
- `host.test.ts:204` `maxWallClockMs: 100` vs `delayMs: 500`：安全。
- `host.test.ts:234/251/263` `delayMs: 300` 用来保证"第二个 startTurn 撞在第一个还在跑的时候"。
  CI 卡顿时第一个可能已经结束 → 测试**变成 vacuous 而不是变红**（更糟）。
  建议用显式同步（engine 暴露一个"已进入 step"的 promise）而不是 sleep。
- `dialect.test.ts:63-71` `run()` 轮询 300×20 ms = 6 s 上限，配 `ttftMs ≤ 8000`（cluster 里）；
  dialect 里最大 `ttftMs` 是 30 ms，安全。
- cluster 的时序问题见 §4。

### 6.3 缺失的 teardown / 泄漏

- **`packages/core/test/host.test.ts` 完全没有 `afterEach`。** `setup()`（`:38-59`）返回的 `unsub`
  **一次都没被调用**，`host.drain()` 只在两个用例里调了（`:351`、`:368`）。
  `SessionHost` 会开 lease 续租 `setInterval`（`packages/core/src/session/host.ts:398`）
  和 wall-clock `setTimeout`（`:406`），只在 turn 收尾时 `clearInterval`（`:812`）。
  任何"故意让 turn 悬着"的用例（`:269` 的 lease 抢占、`:319` 的 fence 丢失）都会**泄漏一个
  2 秒周期的定时器**，一直跑到进程退出。今天靠 vitest 强制结束 worker 掩盖，
  但这正是"vitest 挂在最后不退出"类问题的来源。加一个 `afterEach` 统一 `unsub()` + `drain(100)`。
- **`apps/agent-runner/test/http.test.ts` 也没有 `afterEach`**，同样每个用例新建一个 `SessionHost`。
- ✅ `apps/agent-runner/test/auth.test.ts:19-23` 用 `servers` 数组 + `afterEach` 关闭所有
  jwks/introspection HTTP server，做得对。
- ✅ `packages/providers/test/dialect.test.ts:26-30` 关 fake vendor，做得对。
  但 `:147-156` 那个用例在一个 `it` 里建了**两个** harness，把模块级 `vendor` 覆盖了；
  作者靠 `:151` 手工 `await q.vendor.stop()` 补上——能work，但这种模式很容易在下次改动时漏。
- ✅ `packages/store/test/conformance.ts` 每个 `it` 里都 `await store.close()` / `lease.close()` /
  `bus.close()`（`:52,62,96,134,152,163,179,194,223,231,258`）。MySQL pool 与 Redis 连接不泄漏。
  这是全仓库 teardown 做得最好的地方。
- **`test/cluster/harness.ts:110-190` `startCluster` 无 try/catch** —— 见 §4 第 2 条，最严重的泄漏点。

### 6.4 跨用例共享可变状态

- `dialect.test.ts:26` `let vendor`（见上）。
- `takeover.test.ts:11` `let cluster` —— 配 `afterEach` 是标准写法，但对 `startCluster` 抛异常的情况无效。
- `auth.test.ts:19` `let servers` —— 正确重置。
- 各 `setup()`/`makeApp()` 都新建 `MemorySessionStore`，无跨用例共享。✅
- **进程外共享状态**：cluster 测试在**每个** `startCluster` 里 `DROP DATABASE` +
  `redis.flushdb()`（`harness.ts:118-126`），而 `mysql-redis.test.ts` 用的是
  `agent_service_test` / redis db 1，cluster 用 `agent_service_cluster` / db 3 —— 隔离正确。✅
  但这也意味着 cluster 测试**绝对不能并行**，这是 `fileParallelism: false` 的真正来源。

### 6.5 `fileParallelism: false` 的代价

实测非 cluster 的 11 个文件串行 **9.73 s**（`host.test.ts` 一个人占 4.3 s）。
代价目前很小，但它是**全局**设置，为了两个需要独占资源的文件（`test/cluster/*`、
`packages/store/test/mysql-redis.test.ts`）惩罚了所有纯内存测试。随着 core/router 测试补齐会线性变差。

建议：改用 vitest `projects` 把"纯内存并行" / "独占串行"分开（配置见 §7.1 的注释），
或者对独占文件用 `describe.sequential` + `test.concurrent` 的反向策略。
短期不动也可以接受——但要把 `vitest.config.ts:7` 的注释从"cluster tests"扩到
"cluster tests **and the mysql/redis conformance suite**"，因为后者同样共享 DB。

---

## 7. 具体交付物

### 7.1 `vitest.config.ts`（含实测得出的覆盖率阈值）

阈值取自实测值下调 3 个点左右（只统计 `src`，`all: true` 计入未被 import 的文件）：
实测 **statements 69.20 / branches 56.75 / functions 64.98 / lines 73.82**。

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "test/**/*.test.ts"],
    // 挡住临时/探针文件，避免 ztmp-probe 那类残留把门禁弄红
    exclude: ["**/node_modules/**", "**/dist/**", "**/ztmp-*.test.ts", "**/*.probe.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // cluster 测试会 spawn 真实进程，mysql/redis conformance 共享同一个库：
    // 文件级并行会互抢端口与数据库。
    // TODO: 换成 vitest `projects`，让纯内存的那批重新并行起来。
    fileParallelism: false,

    coverage: {
      provider: "v8",
      // 只统计产品代码：测试辅助文件（fake-vendor / fake-engine / conformance）
      // 本来就接近 100%，会把整体数字虚高约 9 个点。
      include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
      exclude: ["**/*.d.ts", "packages/*/src/index.ts", "apps/*/src/main.ts"],
      all: true,
      reporter: ["text", "html", "json", "lcov"],
      reportsDirectory: "coverage",
      // 实测基线（2026-09，AGENT_SERVICE_INTEGRATION=1，排除 test/cluster）：
      //   statements 69.20 / branches 56.75 / functions 64.98 / lines 73.82
      // 门槛设在基线下方 3 个点：挡住回退，不挡住正常波动。只许上调，不许下调。
      thresholds: {
        statements: 66,
        branches: 53,
        functions: 61,
        lines: 70,
        // 单文件门槛暂不开：agent-router/src 与 context/compact.ts 目前是 0~5%，
        // 补完测试后再打开 perFile。
        perFile: false,
      },
    },
  },
});
```

> 注意：`main.ts` / `index.ts` 放进 `coverage.exclude` 是因为它们是入口/桶文件，
> 覆盖率没有意义；但 **`apps/agent-router/src/{app,registry,config}.ts` 必须留在统计里**，
> 它们现在是 0%，正是需要被门禁盯住的地方。上面的阈值已经把这块 0% 计入了。

配套的 CI 调整：

```yaml
      - name: Unit and integration tests
        env:
          AGENT_SERVICE_INTEGRATION: "1"
          MYSQL_TEST_URL: mysql://root@127.0.0.1:3306/agent_service_test
          REDIS_TEST_URL: redis://127.0.0.1:6379/1
        run: pnpm vitest run --coverage --exclude 'test/cluster/**'

      # 集成测试"真的跑了"的断言：忘记设 env 时上面那步照样会绿。
      - name: Assert the mysql/redis conformance suite actually ran
        run: |
          node -e '
            const r = require("./coverage/coverage-final.json");
            const hit = Object.keys(r).some((f) => f.includes("store/src/mysql/store.ts"));
            if (!hit) { console.error("mysql store was never loaded: integration suite did not run"); process.exit(1); }
          '
```

### 7.2 最小 lint / format 方案

推荐 **Biome**：单个二进制同时做 format + lint，零插件、零 `eslint.config.js` 依赖地狱，
在 monorepo 上 <1 s。（若团队已经习惯 eslint，第二方案见下。）

`biome.json`：

```json
{
  "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
  "files": {
    "includes": ["apps/**/*.ts", "packages/**/*.ts", "test/**/*.ts", "scripts/**/*.mjs"],
    "ignoreUnknown": true
  },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 140 },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "suspicious": {
        "noExplicitAny": "warn",
        "noConsole": "off"
      },
      "complexity": { "noExcessiveCognitiveComplexity": "off" },
      "nursery": { "noFloatingPromises": "error" },
      "style": { "useImportType": "error", "noNonNullAssertion": "off" }
    }
  },
  "assist": { "actions": { "source": { "organizeImports": "on" } } }
}
```

`package.json` 增加：

```json
"lint": "biome check .",
"lint:fix": "biome check --write .",
"format": "biome format --write ."
```

devDependencies 增加 `"@biomejs/biome": "^2.0.0"`。CI 在 typecheck 之前插一步：

```yaml
      - name: Lint and format check
        run: pnpm lint
```

> `noNonNullAssertion: off` 是刻意的——这个 codebase 在测试里大量用 `!`，一次性禁掉会淹掉信号。
> `noFloatingPromises` 是这里**最有价值的一条规则**：`fake-vendor.ts:76` 的
> `void this.handle(...)`、`host.ts:916` 的裸 `setTimeout(async …)`、
> `main.ts` 的 `void shutdown()` 都属于这一类，值得逐个确认是有意还是漏了 `await`。

替代方案（eslint 路线，最小集）：
`eslint` + `typescript-eslint` 的 `strictTypeChecked` 的一个子集 +
`prettier` + `eslint-config-prettier`，只开
`@typescript-eslint/no-floating-promises`、`no-misused-promises`、`await-thenable`、
`require-await`、`consistent-type-imports`。需要 `parserOptions.projectService`，
配置和 CI 时间都比 Biome 重一个量级；收益主要是那几条类型感知规则（Biome 的
`noFloatingPromises` 目前在 nursery，成熟度略低）。**如果团队在意 `no-misused-promises`
这类需要类型信息的规则，选 eslint；否则选 Biome。**

### 7.3 `.dockerignore`

```
# VCS 与本地环境
.git
.gitignore
.github

# 密钥与本地配置（.env 里有真实的 sk- key，绝不能进构建上下文）
.env
.env.*
!.env.example

# 依赖与产物：runtime stage 自己装、build stage 自己编
node_modules
**/node_modules
dist
**/dist
*.tsbuildinfo
**/*.tsbuildinfo
.tsbuild
**/.tsbuild

# 测试与报告
coverage
test
**/test
*.test.ts

# 与镜像无关的东西
docs
spikes
deploy/local
scripts/demo.sh
scripts/lib
README.md
.data
.DS_Store
```

> `test` / `**/test` 被排除是安全的：Dockerfile 只跑 `pnpm install` + `pnpm build`，
> 不跑测试。如果以后想在镜像里跑测试，需要把这两行去掉。

### 7.4 `Dockerfile` 修正版（修 B1/B2/B3/B5/H5/H6/H7）

```dockerfile
# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:24-slim

# ---------- deps: 只为依赖装一层，源码变更不失效 ----------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.5.1 --activate
# 只拷清单，让这一层可以被缓存
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/agent-runner/package.json ./apps/agent-runner/
COPY apps/agent-router/package.json ./apps/agent-router/
COPY packages/core/package.json      ./packages/core/
COPY packages/protocol/package.json  ./packages/protocol/
COPY packages/providers/package.json ./packages/providers/
COPY packages/store/package.json     ./packages/store/
COPY packages/testkit/package.json   ./packages/testkit/
RUN --mount=type=cache,id=pnpm,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && pnpm install --frozen-lockfile

# ---------- build: 打 bundle，并用 pnpm deploy 产出自包含的 prod node_modules ----------
FROM deps AS build
ARG APP=agent-runner
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
RUN pnpm build
# 关键：在"有 workspace 上下文"的这一层解决 prod 依赖，而不是在 runtime stage 里
# --legacy 产出普通的 node_modules 目录树；workspace: 依赖已被 bundle 内联，这里只装第三方
RUN --mount=type=cache,id=pnpm,target=/pnpm-store \
    pnpm --filter "@agent-service/${APP#agent-}" deploy --prod --legacy /deploy \
 || pnpm deploy --filter "./apps/${APP}" --prod --legacy /deploy

# ---------- runtime: 不装任何东西，不需要 pnpm / corepack / 网络 ----------
FROM ${NODE_IMAGE} AS runtime
ARG APP=agent-runner
ARG PORT=8787
WORKDIR /app
ENV NODE_ENV=production \
    PORT=${PORT} \
    RUNNER_PORT=${PORT} \
    ROUTER_PORT=${PORT} \
    RUNNER_HOST=0.0.0.0 \
    ROUTER_HOST=0.0.0.0 \
    BLOB_DIR=/data/blobs \
    NODE_OPTIONS=--enable-source-maps
COPY --from=build --chown=node:node /deploy/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/${APP}/dist ./dist
# 可写目录（USER node 不能写 root 拥有的 /app）
RUN mkdir -p /data/blobs && chown -R node:node /data
VOLUME ["/data"]
USER node
EXPOSE ${PORT}
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
```

要点说明：
- `RUNNER_HOST/ROUTER_HOST=0.0.0.0` 修 **B2**；单一 `PORT` 同时喂给 `EXPOSE`、两个 app 的端口变量
  和 HEALTHCHECK，修 **B3**。
- runtime stage 不再跑 `pnpm install`，B1 的三个原因一次性消失；顺带去掉了运行镜像里的
  pnpm/corepack 和构建期的 registry 访问。
- `pnpm deploy --prod --legacy` 是官方给 Docker 的答案；如果你们的 pnpm 12 上
  `--filter` 的写法不同，退路是"在 build stage 把 app 的 `workspace:*` 依赖用
  `node -e` 从清单里剔掉再 `pnpm install --prod --frozen-lockfile --ignore-workspace`"。
  **无论走哪条，都必须在 CI 里真的 build 一次**（见 H1）。
- 健康检查从 `/healthz`（无条件 `ok`）改到 `/readyz`（真的看 `deps.ready()`，
  `apps/agent-runner/src/app.ts:75`）。
- `--enable-source-maps` 配合 H6 的建议：把 `sourcesContent` 关掉但保留 map，
  线上栈追踪仍然可读，源码不外泄。

### 7.5 `scripts/build-app.mjs` 建议改动（配 §3.6 / B6 / H6）

```js
// 1) 先清空，避免 tsc 残留与已删除的迁移混进产物
import { rm } from "node:fs/promises";
const outdir = resolve(ROOT, "apps", app, "dist");
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

// 2) 生产不带源码正文；本地保留完整 map
sourcemap: true,
sourcesContent: process.env.NODE_ENV !== "production",

// 3) 删掉死掉的 define（全仓库没人读 process.env.BUNDLED），
//    并把 "migrations are read at runtime" 这条注释挪到下面的 cp 那行
//    （不要 define: { "process.env.BUNDLED": '"1"' }）

// 4) 只有需要 store 的 app 才拷迁移
if (app === "agent-runner") {
  await cp(resolve(ROOT, "packages/store/migrations"), resolve(outdir, "migrations"), { recursive: true });
}
```

并把 `apps/*/tsconfig.json` 的 `"outDir": "dist"` 改成 `"outDir": ".tsbuild"`
（它只服务类型检查与 `.d.ts`，不是交付物），`.gitignore` 加 `**/.tsbuild/`。
这样 `pnpm typecheck` 再也不可能覆盖 bundle（B6 根治）。

---

## 8. 建议的修复顺序

| # | 事项 | 严重度 | 预估 |
|---|---|---|---|
| 1 | 删/转正 `ztmp-probe.test.ts`，让 `pnpm test` 变绿（B4） | Blocker | 10 min |
| 2 | 加 `.dockerignore`（B5） | Blocker | 5 min |
| 3 | 重写 Dockerfile（B1+B2+B3+H7），**并在 CI 里 build + run + 打 `/readyz`**（H1） | Blocker | 半天 |
| 4 | `tsc` 输出目录与 bundle 分离 + build 前清 dist（B6、§3.5 的陈旧迁移） | Blocker | 20 min |
| 5 | `check-dist-boot.mjs` 扩到 router，并加一个 `STORE=mysql` 的启动矩阵（H3） | High | 半天 |
| 6 | 落地 §7.1 的覆盖率阈值 + §7.2 的 lint（H2、H4） | High | 半天 |
| 7 | fake vendor 补 §5.2 的 1/2/7/8（流内错误、index 语义、删死代码、缺 `[DONE]`） | High | 1 天 |
| 8 | `startCluster` 加 try/catch；`host.test.ts`/`http.test.ts` 加 `afterEach`（§6.3） | High | 2 h |
| 9 | 修 §6.1 的 4 条 vacuous 断言 | Medium | 1 h |
| 10 | `sourcesContent: false`（H6）、router 不拷迁移、删死 define（§3.6） | Medium | 20 min |
| 11 | 镜像瘦身（H5）、`.node-version` pin 到完整版本、`pnpm audit` | Low | 按需 |
| 12 | 用 vitest `projects` 换掉全局 `fileParallelism: false`（§6.5） | Low | 按需 |
