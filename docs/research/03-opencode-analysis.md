# opencode 源码级分析：作为 agent-runner 的可嵌入性评估

- 分析对象：`oss-refs/opencode`，commit `fe3f3a4`（v1.18.32，2026-09-21）
- 目的：判断 opencode 内核能否/如何复用到 `agent-runner`（HTTP+SSE、多租户、分布式、BYOK、国产模型）
- 所有路径均相对 `packages/`，行号为该 commit 下的行号。HTTP 路由与事件名已由前序调研覆盖，本文只看内部结构。

> 重要背景：这一版 opencode 已经完成了大规模 Effect 化重构，出现了明显的 **v1 / v2 双轨**：
> - v1：`packages/opencode/src/*`（真正在 `opencode serve` 里跑的 session loop、tool、permission、provider）。
> - v2："`@opencode-ai/core`"（`packages/core`，33k 行）+ "`@opencode-ai/server`"（`packages/server`，1.7k 行）+ "`@opencode-ai/llm`"（`packages/llm`，9.5k 行）。v2 里有独立的 `SessionRunner`、`SessionInput`(steer/queue)、`SessionContextEpoch`、持久化 `PermissionTable`、`EventV2` 事件溯源，但目前**尚未被 `opencode serve` 的 session 路由使用**（`grep SessionRunner opencode/src/server` 为空；`server/src/handlers/session.ts` 只做 CRUD）。
> 评估必须区分"今天能跑的 v1"和"设计更好但尚未闭环的 v2"。

---

## 1. Instance / Context 模型

### 1.1 请求如何绑定到目录

- 入口中间件 `opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts:86-88`：
  ```ts
  function defaultDirectory(request, url) {
    return url.searchParams.get("directory") || request.headers["x-opencode-directory"] || process.cwd()
  }
  ```
  v2 的 `server/src/location.ts:29-39` 同样读取 `location[directory]` / `x-opencode-directory` / `x-opencode-workspace`，兜底 `process.cwd()`。
- 带 `sessionID` 的路由由 `server/src/middleware/session-location.ts:43-45` 反查 `SessionTable.directory`，即 **session 与目录是持久绑定的**（session 表有 `directory`、`workspace_id`、`project_id` 列，`core/src/session/sql.ts:22-66`）。
- `cli/cmd/serve.ts:10-12` 明确注释："Server loads instances per-request via x-opencode-directory header — no need for an ambient project InstanceContext at startup"。

### 1.2 Instance 的实现（v1）

- `InstanceContext = { directory, worktree, project }`（`opencode/src/project/instance-context.ts:5-9`）。
- **AsyncLocalStorage 已基本退场**：`util/local-context.ts` 仍保留一个 ALS 封装，但 `InstanceContext.context.provide` 只在 `cli/bootstrap.ts:7` 和 `control-plane/workspace-context.ts:12-16`（workspaceID）使用；业务代码全部改为 Effect 的 `Context.Reference`：`effect/instance-ref.ts:5` `InstanceRef`。`effect/bridge.ts:5-12` 是 Effect→Promise 回调的桥，仍需手工还原 workspace ALS。
- **每目录状态缓存** `effect/instance-state.ts:26-45`：`InstanceState.make(init)` 底层是 `ScopedCache.make({ capacity: Number.POSITIVE_INFINITY, lookup: () => init(ctx) })`，key 为 `ctx.directory`。全仓库 23 处 `InstanceState.make`（Provider、Permission、SessionRunState、Config、MCP、LSP……），每个都是 **无上限 Map**，只能被 `disposeInstance(directory)` 显式失效（`effect/instance-registry.ts:10-12`）。
- **Instance 仓库** `project/instance-store.ts:37-203`：`cache = new Map<string, Entry>()`，`load()` 按目录去重（Deferred 并发合并），`boot()` 调用 `project.fromDirectory` + `InstanceBootstrap.run`；提供 `dispose/disposeDirectory/disposeAll/reload`。**没有 LRU / TTL / 上限**，只有进程退出时的 finalizer。
- **每实例 bootstrap 做的事** `project/bootstrap.ts:32-46`：加载 config → `plugin.init()`（可能触发 npm install）→ 并发初始化 `lsp / shareNext / format / vcs / snapshot / project`。也就是说每个目录 = 一组 LSP 子进程 + 文件监视 + git 快照 + 插件实例。
- **结论：N 个 Instance 可以在同一进程共存**（这是 `serve` 的默认工作方式），但代价是 per-directory 的重资源、无驱逐策略、内存随目录数单调增长。

### 1.3 v2 的 LocationServiceMap

`core/src/location-services.ts:84-112`：用 Effect `LayerMap.make((ref: Location.Ref) => ...,{ idleTimeToLive: "60 minutes" })` 按 `Location.Ref{directory, workspaceID}` 构建一整组服务（Config/Agent/Tool/Permission/Skill/SessionRunnerLLM…共 37 个 node），**有 60 分钟空闲 TTL**——这是 v2 相对 v1 在多实例上的实质改进。

### 1.4 进程级单例清单（文件路径）

| 单例 | 位置 | 说明 |
|---|---|---|
| `Global.Path.{home,data,cache,config,state,tmp,bin,log,repos}` | `core/src/global.ts:17-31` | 由 XDG + `os.homedir()` 派生；**模块顶层 `await fs.mkdir(...)`**（35-43 行）与 `Flock.setGlobal`（33 行）——import 即副作用 |
| SQLite 单库 | `core/src/database/database.ts:43-57` | `path()` 固定为 `$XDG_DATA/opencode/opencode.db`（或 `OPENCODE_DB`），`makeGlobalNode` 全局一份 |
| `auth.json` | `opencode/src/auth/index.ts:10` | `Global.Path.data/auth.json`，进程级 BYOK 凭据文件 |
| `AppRuntime` | `opencode/src/effect/app-runtime.ts:111-118` | `ManagedRuntime.make(AppLayer, { memoMap })`，模块级常量 |
| `GlobalBus` | `opencode/src/bus/global.ts:11-18` | Node `EventEmitter`，进程内广播（SSE 的源） |
| `Flag.*` | `core/src/flag/flag.ts` | 全部读 `process.env`，模块加载时快照 |
| `pendingOAuthTransports` | `opencode/src/mcp/index.ts:111` | 模块级 `Map` |
| `disposers` | `opencode/src/effect/instance-registry.ts:1` | 模块级 `Set` |
| models.dev 目录缓存 | `core/src/models-dev.ts:162` | 写 `Global.Path.cache` |
| Server 密码 | `opencode/src/server/auth.ts:18-41` | 单一 `OPENCODE_SERVER_PASSWORD` Basic Auth，无用户概念 |

---

## 2. 存储

### 2.1 后端：SQLite（drizzle-orm），不是 JSON 文件

- `core/src/database/database.ts:22-37`：WAL、`busy_timeout=5000`、`foreign_keys=ON`，启动跑 `DatabaseMigration.apply`。
- 驱动通过 package.json 条件导出切换：`core/package.json:27-28` `#sqlite` → `sqlite.bun.ts`(bun:sqlite) / `sqlite.node.ts`；`opencode/package.json:24-29` 同理 `#db`。
- `opencode/src/storage/storage.ts` 仍保留旧的 **JSON 文件 KV**（`file(dir,key)=join(dir,...key)+".json"`，53-59 行接口 `read/update/write/list/remove`），主要用于历史迁移（`MIGRATIONS` 81-240 行）和少量非核心数据。
- **可插拔性**：`Database.Service` 是 Effect `Context.Service`，`layerFromPath(filename)`（39-41 行）可注入任意文件；但所有查询直接写 drizzle SQLite 方言（`core/src/session/sql.ts`、`opencode/src/session/message-v2.ts:98-110`），**没有存储接口抽象**，换 Postgres/MySQL 需要重写 SQL 层（drizzle 方言不同）。

### 2.2 Schema（`core/src/session/sql.ts`）

- `session`（22-66）：`id, project_id(FK), workspace_id, parent_id, slug, directory, path, title, version, share_url, summary_*, cost, tokens_*, revert(json), permission(json ruleset), agent, model(json), time_*, time_compacting, time_archived`。
- `message`（68-80）：`id, session_id, time_*, data(json = 整个 V1 Message Info)`；`part`（82-98）：`id, message_id, session_id, data(json = Part)`。即 **消息/部件的结构体整体 JSON 化存一列**，仅索引 `(session_id,time_created,id)`。
- v2 新表：`session_message`（119-138，带 `seq`）、`session_input`（140-166，`delivery: "steer"|"queue"`，`admitted_seq/promoted_seq`）、`session_context_epoch`（168-176）。
- `permission` 表（`core/src/permission/sql.ts`，v2）：`project_id, action, resource` 持久化 "always allow"。
- `event` 表（`core/src/event.ts:78-86`）：v2 事件按 `aggregate_id + seq` 持久化，支持按 seq 回放（**这是 SSE 断线续传的正确基础**）。

### 2.3 一轮对话的历史加载

- v1 loop 每个 step 都从 DB 重新读全量：`opencode/src/session/prompt.ts:1091-1093` `MessageV2.filterCompactedEffect(sessionID)` → `message-v2.ts:578-580` `filterCompacted(stream(sessionID))`。**DB 是唯一真相，不在内存缓存消息**——这意味着 loop 天然能拾取在 step 之间写入的新用户消息（排队/引导）。
- `filterCompacted`（525-576 行）：找最近一个 `assistant.summary===true && finish && !error` 的消息作为分界，重排为 `[compaction-user, summary, ...retained tail, continue-user]`。

### 2.4 压缩 / Prefix-cache

- `session/compaction.ts`：常量 `PRUNE_MINIMUM=20_000`, `PRUNE_PROTECT=40_000`, `TOOL_OUTPUT_MAX_CHARS=2_000`, `MIN/MAX_PRESERVE_RECENT_TOKENS=2_000/15_000`（28-33）。`isOverflow`（203）+ `overflow.ts:10-33`：`usable = model.limit.input ?? (context - maxOutput)`，`count >= usable` 触发。`prune()`（273-315）把老的工具输出截断到 2k 字符。`process()` 用同模型生成摘要写入 `summary: true` 的 assistant 消息。
- **Context Epoch（v2）** `core/src/session/context-epoch.ts` + `core/src/system-context/index.ts:5-19`：system prompt 被建模为一组可独立刷新的 `Source`，首次 admit 时生成 `baseline` 文本 + 结构化 `Snapshot` 存进 `session_context_epoch`，后续只在源变化或 compaction 后 `replace`。目的就是 **让 system prefix 在多轮间字节级稳定以命中 prompt cache**。v1 路径没有这一层，v1 system 每轮由 `sys.environment(model)+instructions+mcp+skills` 重新拼（`prompt.ts:1261-1272`）。
- Provider 侧 cache hook：`provider/transform.ts:364-379` 为 Anthropic/Bedrock/Copilot 注入 `cacheControl: ephemeral`；`1310-1322` 为 OpenAI/Azure/xAI/Mistral/DeepInfra/Cerebras 注入 `promptCacheKey = sessionID`。`llm/src/cache-policy.ts:1-40`：native 路径的 `"auto"` 策略 = tools 末尾 + system 末尾 + 最新 user 消息三处断点。

---

## 3. Agent Loop（v1，`opencode/src/session/`）

规模：`prompt.ts` 1631 行、`processor.ts` 732、`llm.ts` 404、`compaction.ts` 608、`tools.ts` 590、`session.ts` 1016、`message-v2.ts` 741、`run-state.ts` 151、`retry.ts` 209；目录合计 8.1k 行。

### 3.1 结构

```
Service.prompt(input)          prompt.ts:1052-1071
  ├ createUserMessage → DB
  ├ session.permission 覆盖（input.tools → allow/deny 规则）
  └ loop(sessionID) = SessionRunState.ensureRunning(sessionID, onInterrupt, runLoop)   run-state.ts:95-101
        runLoop(sessionID)     prompt.ts:1080-1341
          while(true):
            status=busy; msgs = filterCompacted(DB)                         1091
            latest(msgs) → lastUser/lastAssistant/finished/tasks             1095
            退出判定: lastAssistant.finish ∉ {tool-calls,unknown} && 无 tool part   1109-1129
            step++; step==1 → fork title()                                   1131-1139
            task=tasks.pop(): "subtask" → handleSubtask (子 session)        1144
                              "compaction" → compaction.process              1149
            overflow 预检 → compaction.create(auto)                          1161-1167
            agent 解析; maxSteps=agent.steps??∞; isLastStep                  1169-1179
            reminders.apply; 建 assistant msg 写 DB                          1182-1201
            handle = processor.create({assistantMessage, sessionID, model})  1213
            tools = SessionTools.resolve(...)                                1226
            system = env+instructions+mcp+skills (+structured-output)        1261-1272
            result = handle.process({system, messages, tools, model,...})    1275
            result: "stop"→break | "compact"→compaction.create→continue | "continue"
```

- `processor.ts` 把 `LLMEvent` 流投影成 Part 更新：`reasoning-start/delta/end`、`tool-input-*`、`tool-call`（331）、`tool-result`（383）、`tool-error`、`step-start/finish`、`text-*`、`finish`。有 `doom_loop` 检测（373，重复同参数调用触发权限询问），`Effect.retry(SessionRetry.policy(...))`（674-680）。返回 `"compact" | "stop" | "continue"`（30 行）。
- 工具在 `processor` 中并发执行（588 行 `concurrency: "unbounded"`），工具 ctx 为 `tool/tool.ts:37-45` `{sessionID, messageID, agent, abort: AbortSignal, callID, metadata(), ask()}`。

### 3.2 Abort / 并发 / 排队

- `run-state.ts:35-49`：每目录一个 `Map<SessionID, Runner>`；`ensureRunning` 保证一个 session 只有一个 loop fiber；`cancel`（72-81）中断 fiber 并取消 background jobs。`prompt` 在 busy 时**不报错而是把消息写入 DB，由正在跑的 loop 下一 step 拾取**（因为每 step 重读 DB）。`assertNotBusy`（66-70）只在 shell/command 路径用。
- 中断时 `finalizeInterruptedAssistant`（1203-1211）给 assistant 打 `AbortError` 并写完成时间。
- v2 `core/src/session/input.ts:245-290`：`promoteSteers`（delivery="steer"，插队到当前 step 之后）/ `promoteNextQueued`（delivery="queue"，等 idle）；`run-coordinator.ts` 提供 `run/wake/interrupt/drain`。这是更清晰的"steering"模型，但 v1 loop 未接入。

### 3.3 子 agent（`task` 工具）

- `tool/task.ts:159` 创建 `parentID: ctx.sessionID` 的子 session；`202/233` 通过 `ops.prompt` **在同一进程内递归跑 loop**；`253/263` 在 `experimentalBackgroundSubagents` 下 `forkIn(scope)` 后台运行。`prompt.ts:255-370` `handleSubtask` 处理 `subtask` part，带独立 `AbortController`（323）。
- 成本：每个 assistant 消息带 `cost/tokens`，累计到 session 表；上限只有 `agent.steps`（1178）和 context overflow，没有按用户/租户的预算控制。

---

## 4. 权限模型

- 规则：`PermissionV1.Rule{permission, pattern, action: allow|deny|ask}`，`opencode/src/permission/index.ts:29-37` `evaluate()` = 所有 ruleset 扁平后 **`findLast`** 通配匹配（后者覆盖前者），默认 `ask`。规则来源：全局/项目 config（`fromConfig` 186-198）、agent 定义、session 表 `permission` 列（prompt 时 `input.tools` 写入）、本实例已批准的 `approved`。
- **pending 存放**：`permission/index.ts:46-64` `InstanceState`（按目录）内存 `Map<ID, {info, deferred: Deferred}>`；`ask()`（67-107）发布 `Event.Asked` 后 `Deferred.await`，**没有超时**；`reply()`（109-167）`once|always|reject`，`always` 追加到内存 `approved`（146-151）并批量放行同 session 同 pattern 的其他 pending。
- **重启后**：实例 finalizer（54-61）把所有 pending `Deferred.fail(RejectedError)`；进程重启则 pending 直接消失，loop fiber 也没了，assistant 消息停留在未完成状态；`approved` 列表丢失。v2 `core/src/permission.ts:117-125` 同样是内存 `Map` + Deferred，但 "always" 会写 `PermissionTable`（`permission/saved.ts`）按 `project_id+action+resource` 持久化。
- 插件钩子 `permission.ask`（`plugin/src/index.ts:261`）可在评估后改写 `status`。

---

## 5. 扩展性

### 5.1 MCP（`opencode/src/mcp/index.ts`，1.8k 行目录）

- 三种传输：`StdioClientTransport`（本地子进程，经 `CrossSpawnSpawner`，7-9/33/207 行）、`StreamableHTTPClientTransport`、`SSEClientTransport`（272/279）。远程默认启用 OAuth（240-260，`McpOAuthProvider`，回调路径 `OAUTH_CALLBACK_PATH`，token 存 `Global.Path.data`），可 `oauth: false` 关闭。连接有 `timeout`（161/218-226）。客户端按目录 `InstanceState` 缓存。
- 工具名前缀 `mcp_<server>_<tool>`；资源列出/读取工具受 `read` 权限控制（`permission/index.ts:206`）。

### 5.2 Skills（`opencode/src/skill/index.ts`）

- 扫描模式：`.claude/skills/**/SKILL.md`、`.agents/skills/**/SKILL.md`（`CLAUDE_EXTERNAL_DIR/AGENTS_EXTERNAL_DIR`，21-25 行），`.opencode/{skill,skills}/**/SKILL.md`；范围：`~/.config/opencode`、`~/.claude`、`~/.agents`（`path.join(global.home, dir)`，191 行）以及从 `directory` 向上到 `worktree` 的每一层（197 行 `Filesystem.up`）。另有 `config.skills.paths`（211）和 `config.skills.urls`（远程索引，`skill/discovery.ts` 下载到 `Global.Path.cache/skills`）。frontmatter 解析用 `gray-matter`。`tool/skill.ts` 是 `skill` 工具，把 SKILL.md 正文注入。

### 5.3 插件（`plugin/src/index.ts`）

`Hooks` 接口（约 215-340 行）：`dispose, event, config, tool{}, auth, provider(models), "chat.message", "chat.params", "chat.headers", "permission.ask", "command.execute.before", "tool.execute.before", "tool.execute.after", "shell.env", "experimental.chat.messages.transform", "experimental.chat.system.transform", "experimental.session.compacting", "experimental.compaction.autocontinue", "experimental.text.complete", "tool.definition"`。插件入参 `PluginInput{client: SDK client, project, directory, worktree}`（57-60）。
加载：`opencode/src/plugin/loader.ts:82-140`，npm 规格的插件 **运行时 `Npm.add` 安装到 `Global.Path.cache`** 再 `import()`；本地 `.opencode/plugin/*.ts` 直接 import。

### 5.4 自定义工具 / Agent

- `tool/registry.ts:185-192`：glob `{tool,tools}/*.{js,ts}` 于每个 config 目录，动态 `import()`；Zod 参数。
- Agent：`agent/agent.ts`，从 config `agent.*` 与 `.opencode/agent/*.md`（frontmatter）加载；字段含 `mode: primary|subagent`, `steps`, `permission`, `tools`, `model`。

### 5.5 配置解析顺序（`config/config.ts`）

`OPENCODE_CONFIG_CONTENT`(env 内联) → 全局 `~/.config/opencode/{config.json,opencode.json,opencode.jsonc}`（272-274）→ `OPENCODE_CONFIG` 指定文件 → 从 worktree 向下到 directory 的每层 `opencode.json(c)` / `.opencode/` → 远程 `<url>/.well-known/opencode`（374-392，可带 auth）。合并用 `mergeDeep`，`instructions` 等数组去重拼接（42-51）。变量替换 `{env:X}`、`{file:path}`。

### 5.6 BYOK

- 凭据来源（`provider/provider.ts:1400-1440` 的 `InstanceState` 初始化 + 各 provider 的 `dep.auth/env/config`）：① `auth.json`（`Auth.Service`，进程级文件）；② `config.provider.<id>.options.{apiKey,baseURL,headers,...}`；③ 环境变量（`env.all()`，如 `DEEPSEEK_API_KEY`）；④ 插件 `auth` 钩子（OAuth 类）。模型目录来自 models.dev（`core/src/models-dev.ts`，缓存到 `Global.Path.cache`，可 `OPENCODE_MODELS_URL/PATH` 覆盖或禁用拉取），`config.provider.*.models` 可增补自定义模型。
- **粒度**：Provider 状态是 **每目录一份**（`InstanceState`），config 也是每目录；因此"每请求不同 apiKey"在 v1 里没有原生支持——只能靠每租户一个目录 + 该目录下的 `opencode.json`，或插件 `chat.headers`/`chat.params` 钩子在请求前改写。v2 `core/src/credential.ts` 有独立 `Credential` 服务但同样按 Location 缓存。
- SDK 实例缓存 `s.sdk: Map<string, BundledSDK>`（1416）与 `languages: Map<string, LanguageModelV3>`（1409），key 含 provider+options；未列入 `BUNDLED_PROVIDERS`（114-139）的 `api.npm` 会 **运行时 `Npm.add` 安装**（1841-1847）。

---

## 6. Provider 层

- **两套并存**：
  1. AI SDK 路径（默认）：`opencode/src/session/llm.ts:280-330` `streamText({ model: wrapLanguageModel(...), providerOptions: ProviderTransform.providerOptions(...) })`，`session/llm/ai-sdk.ts` 把 `fullStream` 适配成 `LLMEvent`。版本：`ai@6.0.168`、`@ai-sdk/openai-compatible@2.0.41`（有本地 patch，仅修复 error chunk 透传）、`@ai-sdk/openai@3.0.88`、`@ai-sdk/anthropic@3.0.111`、`@ai-sdk/alibaba@1.0.17`（根 `package.json` catalog）。
  2. Native 路径 `@opencode-ai/llm`（`packages/llm`，6.8k 行主体）：**零 AI SDK 依赖**，`dependencies` 仅 `effect, @opencode-ai/schema, aws4fetch, @smithy/*`（`llm/package.json`）。自带协议实现 `protocols/{openai-chat, openai-compatible-chat, openai-responses, anthropic-messages, gemini, bedrock-converse}.ts`，`route/client.ts` 是 Route/Endpoint/Auth/Transport 抽象。由 `OPENCODE_EXPERIMENTAL_NATIVE_LLM` 开关（`effect/runtime-flags.ts:54`），不支持的模型自动回退 AI SDK（`llm.ts:224-267`，设计说明见 `session/llm/AGENTS.md`）。
- **国产模型**：
  - OpenAI-compatible profiles：`llm/src/providers/openai-compatible-profile.ts` 内置 deepseek/groq/openrouter/together 等 baseURL，`openai-compatible.ts:22-38` `configure({provider, baseURL, apiKey})` 可任意指定（qwen/kimi 只需给 baseURL）。
  - `reasoning_content`：`llm/src/protocols/openai-chat.ts:77/147` schema 收发，`257-260` 回传给 assistant 消息，`419-427` 流式 `reasoning-delta`；`provider/transform.ts:335-337` AI SDK 路径同样把 `reasoning_content` 塞回历史消息。
  - 专项修补：`transform.ts:33-38` 识别 kimi/moonshot 域名；`304` deepseek；`536` kimi-k2；`1296-1307` `alibaba-cn`（DashScope）自动加 `enable_thinking: true`。models.dev 目录里有 `alibaba-cn`、`deepseek`、`moonshotai` 等 provider。
  - 工具调用流式：`openai-chat.ts:414-427` 处理 `delta.tool_calls` 增量；`stream_options.include_usage`（360）。
- Prompt cache hook：见 2.4。

---

## 7. 多租户阻碍（具体清单）

1. **进程级路径与文件**：`Global.Path.*` 全部派生自 `os.homedir()`（`core/src/global.ts`），`auth.json`、`opencode.db`、`models.dev` 缓存、插件/npm 缓存、LSP 二进制（`lsp/server.ts` 44 处引用，183/552/600 行直接从 GitHub 下载）、`skills` 缓存共用一套目录。租户间没有任何隔离。
2. **单 SQLite 库**：`database.ts:43-57`，一进程一库文件；`busy_timeout=5000`，写多时排队；无法跨机器共享（NFS + SQLite 是反模式）。
3. **Session 与本地目录强绑定**：`session.directory` 是 NOT NULL 列，所有工具（`tool/shell.ts:383,611`、`read.ts:233`、`edit.ts:79`）以 `InstanceState.context.directory` 作为 cwd/沙箱边界（`instance-context.ts:18-24` `containsPath`），路径外访问触发 `external_directory` 权限。没有"虚拟工作区"抽象。
4. **子进程**：bash 工具（`ChildProcessSpawner.spawn`，`shell.ts:484`）、MCP stdio、LSP、git（snapshot/vcs）、格式化器、`Npm.add`（bun/npm install）。全是 host 级进程，无 seccomp/容器边界。
5. **无界缓存**：`InstanceState` `capacity: Infinity`（`instance-state.ts:31`）、`InstanceStore` 无驱逐（`instance-store.ts:43`）、Provider `sdk/languages` Map、`runners` Map、MCP client Map、`pendingOAuthTransports`。v2 `LayerMap` 才有 60 min TTL。
6. **运行时安装**：provider SDK（`provider.ts:1841-1847`）、npm 插件（`plugin/loader.ts:94-101`）、LSP、远程 skills，都会在请求路径上触发网络下载和写盘。
7. **安全假设单用户**：`OPENCODE_SERVER_PASSWORD` 单密码 Basic Auth（`server/auth.ts`）；权限 `ask` 的回复无鉴权归属；`x-opencode-directory` 可指向任意本机路径；`process.cwd()` 兜底。
8. **事件总线进程内**：`GlobalBus` 是 `EventEmitter`（`bus/global.ts`），SSE 只能订阅本进程；v2 `EventV2` 虽持久化到 SQLite 但仍单机。
9. **权限 pending 内存态**：见第 4 节，重启即丢。
10. **Bun 偏好**：核心有 bun/node 双实现（`#sqlite`、`#pty`、`#fff`），直接 `Bun.*` 调用仅 4 处（`core/src/npm.ts`、`skill/discovery.ts`、`plugin/index.ts`、`plugin/openai/ws.ts`），Node 可跑但需验证；`@ff-labs/fff-bun`、`bun-pty` 为 bun 原生依赖。
11. **能否不带 CLI 导入核心**：`opencode/package.json` `exports: {"./*": "./src/*.ts"}` + `bin`；`src/index.ts` 就是 yargs CLI 入口（1-30 行全是 command import），**不应导入**。可直接 `import "opencode/server/server"`（`Server.listen`，`server/server.ts:73`）或 `opencode/session/prompt` 等深路径；但任何深路径都会传递 import `core/global.ts` 触发 `mkdir` 副作用，以及 `AppRuntime` 模块级 ManagedRuntime。`opencode` 包是 `private: true`、未发布、无构建产物（TS 源直出），只能以 workspace/子模块方式引用。

---

## 8. 规模

| 包 | TS 行数（不含 test） | 运行时依赖数 |
|---|---|---|
| `packages/opencode` | 81,331（其中 `cli/` 21,860、`session/` 8,121、`server/` 7,683、`plugin/` 6,094、`tool/` 5,198、`provider/` 4,413、`acp/` 3,661、`lsp/` 3,311、`config/` 2,082、`mcp/` 1,827） | **99**（含 9 个 workspace 包；20 个 `@ai-sdk/*`、OpenTelemetry、opentui、tree-sitter、yargs 等） |
| `packages/core` (`@opencode-ai/core`) | 32,983 | 64（含 5 workspace；同样 20 个 `@ai-sdk/*`、drizzle、node-pty、bun-pty、npmcli/arborist） |
| `packages/llm` (`@opencode-ai/llm`) | 9,533 | **5**（effect、schema、aws4fetch、@smithy×2） |
| `packages/server` | 1,682 | 4 |
| `packages/plugin` | 1,612 | 4 |
| `packages/protocol` | 1,582 | 2 |
| `packages/schema` | 3,387 | 1 |
| `packages/codemode` | 6,878 | 3 |
| `packages/session-ui` | 20,295 | (前端) |

Effect 版本 `4.0.0-beta.83`（beta），drizzle `1.0.0-rc.2`——两大基础库都在预发布线，跟随升级成本高。

---

## 9. 对 agent-runner 的三种复用方案评估 (A/B/C)

### 方案 A：每用户/每会话一个 opencode server 子进程或容器

**做法**：agent-router 按 `userID`/`sessionID` 路由到一个 `opencode serve` 实例（容器内 `HOME` 独立），用 `x-opencode-directory` 指向该用户工作区；opencode 自带的 control-plane 已经有 `Target{type:"remote", url, headers}` + `proxyRemote`（`workspace-routing.ts:29-41,113-145`）证明它自己也是这样做远端 workspace 的。

- 优点
  - 零改造即可获得完整能力：loop、compaction、MCP(stdio/OAuth)、skills、插件、LSP、权限 ask/reply、SSE。
  - 租户隔离最彻底（HOME、DB、auth.json、子进程、缓存全部按容器隔离），第 7 节 1-7 条全部被容器边界吸收。
  - 升级 opencode 只是换镜像。
- 缺点
  - **成本/密度**：每个实例启动即 bootstrap（config、插件、LSP、git 快照、models.dev 拉取），常驻内存以百 MB 计。20M DAU 下按活跃会话计算，需要海量容器 + 冷启动调度（预热池、休眠/唤醒），本质是在做 "Codespaces/Sandboxes" 平台。
  - 每实例仍是单密码 Basic Auth、`process.cwd()` 兜底、允许任意目录——必须由网络层封死，只允许 router 访问。
  - 会话状态在容器本地 SQLite，容器销毁 = 历史丢失，需要外挂持久卷或 export/import 同步（有 `cli/cmd/export|import`）。
  - 权限询问、SSE 订阅都要求 router 与同一实例保持亲和（sticky）；实例重启会丢 pending permission。
  - 无法做跨用户的统一模型账单/限流，只能在 router 侧靠 LLM 网关。
- 适用：低并发、高价值的"云端 IDE agent"场景；不适合 20M DAU 的消费级聊天类 agent。

### 方案 B：把 `@opencode-ai/core` / `opencode/src/session` 作为库嵌入自建多租户服务

**做法**：以 git submodule/workspace 引入，构造自己的 Effect Layer 图，替换 `Database.Service`、`Global`、`Auth`、`Location`，用 `InstanceStore.provide(ctx, effect)` 或 v2 `LocationServiceMap.get(ref)` 为每个请求注入租户上下文。

- 优点
  - 复用最有价值的算法层：loop（`prompt.ts`）、`processor.ts` 事件投影、`compaction`/`prune`、`MessageV2` 转换、`ProviderTransform`（1.9k 行各家模型的怪癖修补）、skill/agent 解析、plugin 钩子体系。
  - Effect 服务化后理论上一切可注入（`Database.layerFromPath`、`LayerNode.Replacements`）。
- 缺点
  - **`private: true` 的 TS 源码包，无发布产物**，只能 vendoring 整棵仓库；`opencode` 99 依赖、`core` 64 依赖（含 20 个 AI SDK provider、node-pty、bun-pty、arborist）都会被拖进服务端；Effect 4 beta + drizzle rc 的 API 稳定性差。
  - 租户隔离要靠"每租户一个目录"来伪装 InstanceContext，`session.directory NOT NULL`、工具的 cwd 语义、`Global.Path` 顶层副作用、`auth.json`、单 SQLite 都必须 fork 改；`InstanceState` 无上限缓存要自己加驱逐；`GlobalBus`/`EventV2` 要换成 Redis/Kafka；权限 Deferred 要改成持久化 + 超时。这些改动分散在 23 个 `InstanceState.make` 和上百个 `Global.Path` 引用点，**和上游会持续冲突**。
  - v1 loop 与 v2（SessionRunner/SessionInput/ContextEpoch/EventV2）正处在迁移中，嵌入哪一套都要赌上游方向；v2 目前并未被自己的 server 使用。
  - 分布式（无状态 runner、跨机 SSE、任务漂移）在 opencode 里完全没有概念，"session 只在一个进程有一个 fiber" 的假设需要自建分布式锁替代 `SessionRunState`。
- 适用：只做单机/少量节点、且愿意深度 fork 的团队。对 20M DAU + 无状态 router 的目标不合适。

### 方案 C：只复用 `@opencode-ai/llm` + 协议/设计，其余自研

**做法**：
1. 直接使用/移植 `packages/llm`（5 个依赖、无 AI SDK）作为 LLM 传输层：`openai-compatible-chat` 协议覆盖 qwen/kimi/deepseek，`reasoning_content` 与流式 tool_calls 已实现，`cache-policy` 与 `LLMEvent` 事件模型可原样采用；`openai-compatible.ts:configure({provider, baseURL, apiKey})` 天然支持 **每请求传 apiKey**（BYOK 无需全局状态）。
2. 借鉴（而非引用）以下设计：
   - 事件/Part 模型与 SSE 事件命名（前序调研已覆盖），以及 v2 `event` 表 `aggregate_id+seq` 的持久化回放。
   - 会话表结构 `session/message/part`（JSON 列 + 索引）改造到 Postgres；`session_input(delivery: steer|queue, admitted_seq/promoted_seq)` 的排队/插话模型。
   - `SessionContextEpoch`/`SystemContext` 的"稳定 system baseline + 快照比对"设计用于 prefix cache。
   - `compaction.ts` 的阈值与 prune 策略、`filterCompacted` 的重排规则。
   - `ProviderTransform` 中对国产模型的修补（`enable_thinking`、kimi 域名识别、`reasoning_content` 回填）。
   - 权限规则 `findLast` 通配语义与 `once|always|reject`，改为持久化 pending + TTL。
   - 插件钩子清单、Skill 目录约定（`.claude/skills`、`.agents/skills`、SKILL.md frontmatter）、agent markdown 格式，保持与生态兼容。
   - MCP：直接用 `@modelcontextprotocol/sdk` 三种 transport，参考 `mcp/index.ts` 的 OAuth provider 与超时封装。
3. 自研：多租户上下文（tenant/user/session 显式参数而非目录）、Postgres/Redis 存储与事件总线、分布式 session 锁、工具沙箱（远程执行器）、预算/限流。

- 优点
  - 引入面最小、依赖最干净；LLM 层是 opencode 里唯一"可独立发布形态"的包（自带 `exports` 子路径，无 Global/DB 耦合）。
  - 多租户、分布式、每请求 BYOK 等硬约束从第一天在架构里，不与上游对抗。
  - 上游演进（v1→v2）对我们只是"参考更新"，不构成升级风险。
- 缺点
  - 需要自己实现 loop/processor/compaction/tool 执行/权限（约 8-10k 行工作量参考 `session/` 目录规模），初期功能面弱于 opencode。
  - `packages/llm` 同样是 `private: true`、依赖 Effect 4 beta，需要 vendoring 并可能做去 Effect 化（或接受 Effect）。
  - 失去与 opencode TUI/桌面端/SDK 的直接兼容（若前端希望复用 opencode 客户端，需要在协议层保持兼容）。

### 推荐

**以 C 为主线，A 作为特定场景补充，不选 B。**

- 目标是 20M+ DAU、无状态 router、跨机分布式、多用户隔离、每请求 BYOK——这些在 opencode 里要么不存在（分布式、租户）、要么是硬编码反向假设（单 HOME、单 SQLite、目录即租户、进程内 EventEmitter、无界缓存、运行时 npm install）。B 方案的 fork 改动面（第 7 节 11 条）远大于自研核心 loop，且要背 Effect 4 beta + 163 个依赖。
- C 的具体切入点：vendoring `packages/llm`（或以它为蓝本写一个 <5k 行的 OpenAI-compatible 客户端），采用其 `LLMEvent`/`LLMRequest`/`cache-policy`；用 `packages/schema` 的 session/message/part/event schema 作为我们协议的起点（这样未来若要接 opencode 客户端也容易）；参考 `session/prompt.ts:1080-1341` 与 `processor.ts` 写自己的 loop，把"每 step 重读存储、DB 为真相"的原则保留（它天然支持排队/插话与跨节点接管）。
- A 适合作为"需要真实文件系统 + LSP + bash 的重型编码场景"的可选后端：router 把这类会话调度到按用户隔离的 opencode 容器，仍走同一套对外协议。这样通用聊天/工具型 agent 走自研 runner（高密度），编码型走容器化 opencode（高能力），两者共享协议层。
