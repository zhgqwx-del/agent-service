# 本地开发、手动体验与 CI 构建指南

本文是理解和操作当前 `agent-service` 的长期维护入口，回答三类问题：本地需要启动什么、怎样手动体验、GitHub Actions 实际构建和验证什么。

里程碑完成度以 `docs/PROGRESS.md` 顶部快照和最后一节为准；本文只描述操作方式和交付产物，不替代进度记录。

## 1. 服务、基础设施与代码库

本项目当前只有两个应用服务：

| 组件 | 默认地址 | 是否独立进程 | 职责 |
| --- | --- | --- | --- |
| `agent-router` | `http://127.0.0.1:8080` | 是 | 对外入口、runner 发现、session owner 路由、SSE 透传和一次安全重路由 |
| `agent-runner` | `http://127.0.0.1:8787` | 是 | 鉴权、Agent Runtime API、模型执行、session/turn/item/event/approval 生命周期 |
| MySQL | `127.0.0.1:3306` | 是，外部基础设施 | 业务真相、持久事件、配置和 usage ledger |
| Redis | `127.0.0.1:6379` | 是，外部基础设施 | 租约、fence、owner 目录和事件热扇出 |
| `packages/sdk` | — | 否 | 供客户端使用的 TypeScript SDK |
| `protocol/core/store/providers/testkit` | — | 否 | 被 runner/router 或测试加载的内部代码库 |

正式客户端应访问 router 的 `8080`。runner 的 `8787` 用于开发诊断和对照，不应当成为生产环境的公网入口。

当前本地拓扑覆盖已实现的 M1/M2 主链路，包括 Archive v2、fenced tombstone 与 reliable terminal-event outbox dispatcher。dispatcher 是每个 runner 内部的工作循环，不是第三个应用服务或镜像；ownership manifest/Blob 接线、erasure/export、legacy 补偿和物理 purge 尚未完成。M3 的 MCP/skills/hooks 和 M4 的生产化能力会在实现后加入本文；尚未实现的模块不会因为出现在设计文档中就成为可启动服务。

## 2. 一次性准备

前置条件：

- Node.js 24；
- pnpm 12.5.1（仓库由 `packageManager` 固定版本）；
- `curl`；
- 当前开发机约定位置上的 MySQL 8 和 Redis；如自行提供兼容实例，需要绕过下文会无条件调用 `infra.sh` 的统一入口，分别启动应用和测试；
- Python 3，`scripts/demo.sh` 用它解析响应、构造后续请求并执行断言。

```bash
cd /Users/zhangguoqiang/ai-workspace/claude-workspace/meetyou/agent-service

fnm install 24
fnm use 24
corepack enable
corepack prepare pnpm@12.5.1 --activate

node -v
pnpm -v
pnpm install --frozen-lockfile

test -f .env || cp .env.example .env
```

编辑本机 `.env`：

- 无模型费用的启动、smoke 和主测试不要求填写 `API_KEY`；
- 真实模型 turn、`verify-real` 和 acceptance 必须填写 `API_KEY`；`API_BASE_URL` 和 `DEFAULT_MODEL` 有 DashScope/qwen 默认值，可按所用 provider 覆盖；
- 使用 `openssl rand -hex 32` 生成独立的 `SECRETS_MASTER_KEY`；
- `.env` 不得提交，也不得把密钥复制到命令日志、文档或问题报告中。

`scripts/local-service.sh` 会读取 `.env`，但不会主动打印其中的值。当前只有 `RUNNER_PORT`、`ROUTER_PORT`、`RUNNER_ID`、`RUNNER_ADDR`、`RUNNERS`、`REDIS_URL` 和 `SESSION_TOMBSTONE_ENABLED` 保证显式命令行值优先；其它同名值可能被 `.env` 覆盖，使用前应检查配置来源，但不要打印密钥。

## 3. 启动与停止完整本地栈

```bash
scripts/local-service.sh start
scripts/local-service.sh status
scripts/local-service.sh smoke
```

`start` 的顺序是：

1. 通过 `deploy/local/infra.sh` 启动 MySQL 和 Redis；
2. 从 TypeScript 源码启动一个 runner；
3. 从 TypeScript 源码启动一个 router，并等待其发现健康 runner。

runner 启动后会同时启动 lifecycle outbox dispatcher；停止时先 drain session，再等待当前 dispatcher pass 结束。`.env.example` 与本地脚本将 `SESSION_TOMBSTONE_ENABLED` 设为 `1` 方便完整体验；生产默认必须保持 `0`，直到完成第 9 节的 capability rollout。

`smoke` 不调用真实模型，验证两端 readiness、两份 OpenAPI、router 转发和未鉴权请求返回 `401`。

日志和停止命令：

```bash
scripts/local-service.sh logs
scripts/local-service.sh status

scripts/local-service.sh stop  # 只停 router/runner，保留 MySQL/Redis
scripts/local-service.sh down  # 停 router/runner/MySQL/Redis
```

应用 PID 和日志保存在未提交的 `.local-run/`。`stop` 发送 `SIGTERM`，让 runner 有界 drain；超时会保留现场并报错，不会擅自强杀。

### 基础设施脚本的机器边界

`deploy/local/infra.sh` 是当前 macOS 开发机的适配脚本，默认查找：

- `~/.local/bin/redis-server` 和 `redis-cli`；
- `/usr/local/bin/mysqld` 和 `mysql`；
- `~/.local/var` 下的数据目录。

其它机器可用 `REDIS_BIN`、`REDIS_CLI`、`MYSQLD`、`MYSQL` 覆盖路径。`deploy/local/compose.yaml` 只启动 MySQL/Redis，应用仍从宿主机启动；使用 Compose 或其它兼容实例时不要执行会再次调用 `infra.sh` 的 `local-service.sh start/verify`，而应按第 7 节的两条源码命令启动应用，并直接运行下面的等价门禁。后续会为统一入口增加显式的外部基础设施模式。

```bash
pnpm check:secrets
pnpm check:api
pnpm typecheck
AGENT_SERVICE_INTEGRATION=1 MYSQL_TEST_URL="$MYSQL_URL" REDIS_TEST_URL="$REDIS_URL" \
  pnpm vitest run --coverage --exclude 'test/cluster/**'
node scripts/assert-suites-ran.mjs
MYSQL_MIGRATION_TEST_URL="$MYSQL_URL" pnpm test:migrations
AGENT_SERVICE_CLUSTER=1 CLUSTER_MYSQL_URL="$CLUSTER_MYSQL_URL" CLUSTER_REDIS_URL="$CLUSTER_REDIS_URL" \
  pnpm vitest run test/cluster
pnpm build:check
```

`deploy/local/infra.sh reset-db` 会删除并重建 `agent_service`、`agent_service_test`，不会重建 `agent_service_cluster`；同时会对该 Redis 实例执行全局 `FLUSHALL`。它不是普通重启步骤。

## 4. 手动查看服务

从对外入口检查：

```bash
BASE=http://127.0.0.1:8080

curl -i "$BASE/healthz"
curl -i "$BASE/readyz"
curl -sS "$BASE/v1/capabilities" | python3 -m json.tool
curl -sS "$BASE/openapi.json" | python3 -m json.tool

# 预期 401；证明 wildcard API 请求确实经 router 到达 runner
curl -i "$BASE/v1/agents"
```

直接检查 runner：

```bash
curl -i http://127.0.0.1:8787/readyz
curl -sS http://127.0.0.1:8787/v1/capabilities | python3 -m json.tool
curl -sS http://127.0.0.1:8787/openapi.json | python3 -m json.tool
```

两端提供同一份 OpenAPI 3.1 契约。当前没有内置 Swagger/Scalar 页面，可把 `http://127.0.0.1:8080/openapi.json` 导入 Postman、Insomnia 或 Swagger Editor。

router 的 `/_router/targets` 会暴露内部 runner 地址和可选 session owner，因此默认返回 `404`。只有显式配置 `ROUTER_ADMIN_TOKEN`、重启服务并携带对应 bearer token 后才开放。

## 5. 手动体验 Agent Runtime

推荐通过统一入口运行十阶段流程：

```bash
scripts/local-service.sh acceptance
```

它固定经 router 调用，覆盖：鉴权、agent/session、SSE turn、消息历史、断线重放、幂等、跨轮上下文、安全阀、同 tenant 的 user 隔离、请求体限制与 BYOK。跨 tenant 隔离由自动测试覆盖。该命令使用真实模型，会产生少量费用。

`scripts/demo.sh` 单独运行时默认直连 runner；若要显式经 router 运行：

```bash
BASE=http://127.0.0.1:8080 scripts/demo.sh
```

README 的 API 速览提供创建 agent、session 和 turn 的逐步 `curl` 示例。手动体验部署形态时，应把其中的 `localhost:8787` 换成 `localhost:8080`。

拿到 `SESSION_ID` 后，可单独体验可逆生命周期；下列请求都应经 router：

```bash
H=(-H "Authorization: Bearer dev-key" -H "X-User-Id: u_42" -H "Content-Type: application/json")
curl -sS -X POST "$BASE/v1/sessions/$SESSION_ID/archive" "${H[@]}"
curl -sS "$BASE/v1/sessions?includeArchived=true" "${H[@]}"
# archived 期间创建 turn 应返回 409 session_archived，读取 session/items/events 仍可用
curl -sS -X POST "$BASE/v1/sessions/$SESSION_ID/unarchive" "${H[@]}"
```

archive active turn 会返回 `409 session_busy`；先 interrupt 并等待 turn 结算后再重试。archive 会清空 session 级工具授权并结算异常遗留审批，unarchive 不恢复旧授权。

要体验 DELETE，请另建一个可丢弃的 idle session；该操作对普通 API 不可逆：

```bash
DELETE_SESSION_ID=sess_...
curl -i -X DELETE "$BASE/v1/sessions/$DELETE_SESSION_ID" "${H[@]}"
curl -i "$BASE/v1/sessions/$DELETE_SESSION_ID" "${H[@]}"  # 预期 404
curl -i -X DELETE "$BASE/v1/sessions/$DELETE_SESSION_ID" "${H[@]}"  # 同 owner 重试仍为 204
```

DELETE 经同一队列、lease/fence 原子写入 terminal `session/deleted`、单调 generation 和 durable cleanup intents；active session 返回 `409 session_busy`，存在任何未删除 child 的 parent 返回 `409 session_has_children`。runner 内置 dispatcher 会用 claim lease 和有上限退避可靠重投 `session.tombstoned` 对应的 durable event；短暂故障持续重试，确定损坏的 intent 才 dead-letter。投递是 at-least-once，相同 event `seq` 可能出现多次并由订阅路径去重。当前 `purge_after_ms = NULL`、purge intent 不可领取，dispatcher 也不会处理它，因此 `404` 表示普通 API 已隐藏，并不表示磁盘或数据库内容已物理清除。

外部客户端只能调用公开 DELETE；router 会在 gate/fleet 校验后将其改写为 runner 的版本化内部 POST，剥离任何客户端伪造的内部 header，并注入与 runner 一致的 `INTERNAL_ROUTER_TOKEN`。该内部路径不进入 OpenAPI/SDK，直接经 router 调用返回 404；production runner 端口还必须由网络策略限制为 router/运维平面可达。

当前 `scripts/demo.sh approval` 不会完成一条人工审批交互；审批状态机由自动测试覆盖。后续若增加交互式审批 demo，应在此处补充。

## 6. 四级验证路径

```bash
scripts/local-service.sh smoke
# 无真实模型费用；检查正在运行的服务和路由

scripts/local-service.sh verify
# 无真实模型费用；运行 secret/API drift/typecheck、MySQL/Redis 集成、
# 0007→0008 与 0008→0009 历史迁移、真实多进程 cluster、SDK 打包和两个应用 bundle 启动门禁

scripts/local-service.sh verify-real
# 读取本机 .env，只跑真实 provider E2E，会产生费用

scripts/local-service.sh acceptance
# 从 router 完成端到端人工体验，会产生费用
```

日常开发至少运行与修改范围匹配的定向测试；合并或里程碑冻结前运行完整 `verify`。真实模型路径只有在明确需要时运行，不能把未重跑的历史结果描述为本轮结果。

## 7. 本地源码进程与生产构建产物

本地 `start` 使用：

```text
node --import tsx apps/agent-runner/src/main.ts
node --import tsx apps/agent-router/src/main.ts
```

生产构建使用：

```bash
pnpm build
```

等价顺序：

```text
构建 @agent-service/sdk
node scripts/build-app.mjs agent-runner
node scripts/build-app.mjs agent-router
```

SDK 和两个应用分别生成：

- `packages/sdk/dist/` 中的 JavaScript、类型声明及 source maps；
- `apps/agent-runner/dist/main.js`；
- `apps/agent-router/dist/main.js`；
- 对应 source map、`dist/package.json` 和 SQL migrations。

这些是 Node 24 的单文件 ESM bundle，不是 Windows `.exe` 或 Linux ELF 原生机器码。构建会内联 `@agent-service/*` workspace 代码，但第三方包仍由 production `node_modules` 提供。因此单独复制 `dist/main.js` 不是完整的裸 VM 发布包。

`pnpm build:check` 在 `pnpm build` 之后还会：

1. 对 SDK 执行真实 `pnpm pack`，在隔离 consumer 中验证包名 import 和 TypeScript 声明；
2. 用原生 Node（不使用 `tsx`）启动 runner/router bundle；
3. 验证 readiness、capabilities、router 转发和两端 OpenAPI 精确一致。

如果未来明确采用裸 VM，应增加带校验和的 `bundle + migrations + production node_modules` 发布归档和 systemd 单元。当前最完整、最可重复的部署产物是 OCI 镜像。

## 8. GitHub Actions 构建与验证

`.github/workflows/ci.yml` 对 push 到 `main` 和 pull request 运行。

### `test` job

GitHub 启动 MySQL 8 和 Redis 8 service container，然后执行：

1. 凭据扫描；
2. frozen-lockfile 安装；
3. OpenAPI/生成 SDK 漂移检查；
4. 源码与测试的 TypeScript 全量检查；
5. 单元及 MySQL/Redis 集成测试和覆盖率门槛；
6. 断言集成套件没有被环境错误静默 skip；
7. 固定 0007 历史库到 0008、固定 0008 历史库到 0009 的真实 MySQL 迁移测试；
8. 真实 runner/router 多进程 cluster 测试；
9. `pnpm build:check`；
10. 上传 coverage artifact。

MySQL 和 Redis 是拉取的第三方 service images，不是本仓库构建的产品服务。

### `image` matrix job 的两个运行实例

CI 用同一个 Dockerfile 分别传入：

```text
APP=agent-runner
APP=agent-router
```

得到两个独立 Linux OCI image：

```text
agent-service/agent-runner:ci
agent-service/agent-router:ci
```

每个镜像都包含 Node 24 slim、该应用的 bundle、迁移文件和 production dependencies。CI 会实际启动镜像并检查外部可达性、OpenAPI 和 Docker healthcheck；runner 还验证最新迁移已执行及生产 bootstrap 路径。

当前 workflow 使用 `load: true` 供本 job 启动验证，没有把镜像 push 到 registry。SDK `.tgz` 也是临时验证后删除；当前明确上传的 GitHub Actions artifact 只有 coverage。

## 9. 从本地到未来生产的交付语义

目标 promotion 链是：

```text
本地开发与定向测试
→ 本地完整 verify
→ GitHub Actions 全部门禁
→ 构建一次 router/runner 不可变镜像
→ 同一 image digest 部署 staging
→ 预发验收
→ 同一 digest 灰度到 production
```

staging/production 不重新编译镜像。环境差异只通过受控配置和 Secret 注入；两个环境不共享 MySQL、Redis、对象存储、密钥或 service key。

tombstone 保持在 exact protocol family `2026-10-08`，作为 additive capability 激活。发布时先由 API gateway 暂停精确 session DELETE（或整体切换 router 池），部署新 router 且保持 `SESSION_TOMBSTONE_ENABLED=0`，排空全部旧 router，再滚动新 runner；确认每个健康 runner 都声明 `tombstone` 后才把新 router gate 设为 `1`。router 会在显式 gate 之外持续检查全健康 fleet，任一健康旧 runner 存在时 DELETE 都返回可重试 `503`。仅逐个替换旧 router 而不先阻断 DELETE 不安全，因为旧 router 没有这个 gate；runner 端口也必须保持内网不可直连，否则会绕过 router gate。

这套 activation gate 只覆盖同一 protocol family 内的 additive tombstone rollout。未来真正改变 protocol version 时仍需全量 drain 的维护窗口协调切换或整组 blue-green，除非再实现 version range/按版本路由。

没有云资源时，仍可完成业务代码、协议、迁移、memory/MySQL/Redis 实现、本地多进程与容器测试、故障注入、指标定义和部署模板设计。以下结论必须等待真实环境：云网络和权限正确性、KMS/对象存储/IdP 集成、Kubernetes 滚动发布、真实告警链路、备份恢复目标、云 Redis 灾备以及生产容量。

## 10. 文档维护规则

当服务、命令、端口、CI job、构建产物或里程碑能力发生变化时，同一提交更新本文。不要复制 `docs/review/` 或 `docs/research/` 的历史测试数量；准确完成度继续以 `docs/PROGRESS.md` 最新一节和当前 CI 为准。
