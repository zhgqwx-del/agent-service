# 04 · pi 与 deepseek-harness 作为可内嵌 agent loop 的源码级分析

> 分析对象：
> - **pi**（`oss-refs/pi`，commit `1a584a7`，2026-09-22，monorepo 版本 0.87.0）
> - **deepseek-harness / dsh**（`oss-refs/deepseek-harness`，commit `ddefc45`，2026-09-17，版本 0.1.6-alpha.2）
>
> dsh 的 MCP 与 Skills 子系统已在 [`partials/dsh-mcp-skills-subsystem.md`](partials/dsh-mcp-skills-subsystem.md) 中分析，本文不重复。
> 目标问题：两者能否作为 `agent-runner`（HTTP+SSE、多用户多会话、BYOK、无状态 `agent-router` 前置、分布式部署）的内嵌 agent loop；若能，需要替换哪些"缝"。
> 文中路径均相对各自仓库根目录；行号对应上述 commit。

---

## 0. 一句话结论

- **pi**：`@earendil-works/pi-ai` + `@earendil-works/pi-agent-core` 是真正的纯库（无 TUI、无 `process.exit`/`chdir`/stdin/信号处理），并且在 0.8x 时代新增了一层**为服务端设计的 durable harness**（`AgentHarness` / `Session` / `Storage` 抽象、显式 `Context` 传参、操作状态机、崩溃恢复）。provider 层原生覆盖 deepseek / moonshot(kimi) / qwen / zai(智谱) / minimax，并支持**每次调用注入 `apiKey` / `headers` / `fetch` / `env`**——这是 BYOK 多租户最关键的一条。缺点是 harness 层仍标注 WIP（存储格式 4 未稳定、`watchSession` 未实现、JSONL 快照压缩未实现），且发版极快（近一周三个版本，每版都有 Breaking Changes）。
- **dsh**：架构是"cordis 插件容器 + 数十个 capability seam"，核心 loop（`dsh-agent-loop`）本身很干净，也有可替换的 `SessionPersistence` 抽象类；但整个系统**以单用户桌面/本机为前提**：凭据通过进程级 `credentials` seam 解析（`GenerateOptions` 没有 `apiKey`）、身份是 `$DSH_HOME/.anonymous-user-id`、`deepseek-official` 适配器**默认**把 `x-deepseek-harness-user-id` 头、`dsh_plugin_packages` 与**整段增量会话日志 `dsh_session_log`** 附在请求体上发往 DeepSeek 端点、Web host 明确"无 TLS / 无鉴权 / 无 origin 策略"。CONTRIBUTING 明确不接受外部 PR，README 明确"将有破坏性变更"。
- **推荐**：以 **pi-ai（provider 层）+ pi-agent-core（`Agent`/`agentLoop` 或 `AgentHarness`）** 作为 agent-runner 的内嵌 loop 基座，自己实现 `Storage`/`SessionRepo`（Postgres/Redis）与 `ExecutionEnv`（沙箱）两个缝；dsh 作为设计参考（MCP 配置模型、`scrubbedParentEnv`、crash-repair、event-sourced log 的事件词表），不作为依赖。

---

## 1. pi

### 1.1 包结构与可内嵌性（a）

`packages/*`（全部 0.87.0，MIT，`engines.node >= 22.19`）：

| 包 | 角色 | 运行时依赖数 | 纯库？ |
|---|---|---|---|
| `pi-ai` (`packages/ai`) | 多 provider LLM 适配层 | 10（`@anthropic-ai/sdk`、`@aws-sdk/client-bedrock-runtime`、`@google/genai`、`openai`、`partial-json`、`typebox`、`pi-telemetry`、proxy-agent×2、`@smithy/node-http-handler`） | 是。唯一的 `process.stdin`/`process.exit` 在 `src/cli.ts:48,96,118`（独立 CLI 入口，不被库导出路径引用） |
| `pi-agent-core` (`packages/agent`) | `Agent` 类 + `agentLoop` + durable `AgentHarness` + session 存储抽象 | 7（`chord`、`pi-ai`、`pi-telemetry`、`diff`、`ignore`、`typebox`、`yaml`） | 是。`grep -E 'process\.(exit|chdir|stdin|on\("SIG)'` 为 0 命中；`homedir()` 仅在 `src/harness/env/nodejs.ts:62-64`（`~` 展开） |
| `pi-session-backend-sqlite-node` (`packages/session-backends/sqlite-node`) | `node:sqlite` 版 `SessionRepo` | 2 | 是 |
| `pi-server` / `pi-client` / `pi-protocol` | 实验性 Unix socket + CBOR 路由层（facet-service RPC） | 3 / 2 / 2 | 是，但 README 自称 Experimental |
| `pi-durable` (`packages/durable`) | "Pico v5" 下一代 durable runtime，目前只导出 `MemoryStorage` | 2 | 是，但仅骨架 |
| `chord` | 应用组合运行时（services/replicated state/RPC/plugins） | 1（esbuild） | 是 |
| `pi-telemetry` | vendor-neutral telemetry 契约 | 0 | 是 |
| `pi-coding-agent` (`packages/coding-agent`) | 交互式 coding agent CLI + SDK | 17（含 `pi-tui`、`chalk`、`jiti`、`undici`、`photon-node`…） | **否**：`process.exit`/信号处理散布在 20 个文件（`src/main.ts`、`src/modes/*`、`src/experimental/*` 等）；配置根目录 `getAgentDir()` = `~/.pi/agent`（`src/config.ts:528-533`），`createAgentSession()` 默认 `cwd: process.cwd()`、`agentDir: ~/.pi/agent`（`docs/sdk.md:345-352`） |
| `pi-tui` | 终端 UI | 2 | 不需要 |

**两个可用的公共 API 层级**：

**层级 A：`Agent` 类 / `agentLoop`（进程内、非 durable，最薄）** — `packages/agent/src/agent.ts`、`agent-loop.ts`

```ts
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";

const models = createModels();              // 实例级注册表，非全局单例（models.ts:757）
models.setProvider(deepseekProvider());     // providers/deepseek.ts:6-16
const model = models.getModel("deepseek", "deepseek-chat")!;

const agent = new Agent({
  initialState: { systemPrompt, model, tools: [readTool, bashTool] },
  streamFn: (m, ctx, opts) =>
    models.streamSimple(m, ctx, { ...opts, apiKey: tenantKey, headers: { "x-tenant": tid } }), // 每次调用注入 BYOK
  getApiKey: async (provider) => vault.lookup(userId, provider),   // agent-loop.ts:400 每次 LLM 调用前解析
  toolExecution: "parallel",
  beforeToolCall: async ({ toolCall }) => policy.check(userId, toolCall),
  finishTurn: async ({ message }) => (++turns >= MAX_TURNS ? { action: "end" } : undefined), // 自定义步数上限
  transformContext: async (msgs) => compactIfNeeded(msgs),
  sessionId,
});
const unsub = agent.subscribe(async (ev) => sse.write(ev));  // 事件列表见 §1.3
await agent.prompt("...");                                   // agent.ts:370
agent.steer(msg); agent.followUp(msg); agent.abort(); await agent.waitForIdle(); // agent.ts:296,301,338,347
// 恢复：agent.state.messages = loadedMessages; await agent.continue();     // agent.ts:381
```

**层级 B：`AgentHarness`（durable、显式 `Context`、可挂任意 `Storage`）** — `packages/agent/src/harness/agent-harness.ts`

```ts
import { AgentHarness, BACKGROUND_CONTEXT, type Session } from "@earendil-works/pi-agent-core";
import { SqliteSessionRepo, createNodeSqliteFactory } from "@earendil-works/pi-session-backend-sqlite-node";

const repo = new SqliteSessionRepo({ directory, databaseFactory: createNodeSqliteFactory() }); // 或自研 SessionRepo
const session = await repo.open(meta, ctx);          // SessionRepo: create/open/list/delete/fork（session/types.ts:592-604）
const { harness, open } = await AgentHarness.create({ // agent-harness.ts:518-536, 622
  session, models, model, tools, systemPrompt, retry: { enabled: true, maxRetries: 3, baseDelayMs: 1000 },
  compaction: { enabled: true, reserveTokens: 16_000, keepRecentTokens: 20_000 },
  toolContext: () => ({ env: sandboxEnvForTenant(userId) }),
}, ctx);
harness.hooks.on("before_tool", async (e, ctx) => policy(e));      // HookMap: agent-harness.ts:430-500
harness.events.on((ev, ctx) => sse.write(ev));                      // HarnessEventPayload: agent-harness.ts:255-373
const lane = await harness.lane("main", ctx);                       // AgentLane: agent-harness.ts:538-581
if (open.length) await lane.resume(ctx);                            // 崩溃后由任意节点接管
await lane.prompt("...", undefined, ctx);                           // 或 accept()+drive() 由外部调度器驱动
await lane.steer(msg, undefined, ctx); await lane.abort(ctx);
```

harness 层的每个异步公共方法都带显式尾参 `Context`（`docs/harness.md` §0.2："Shared receivers never retain a caller Context or discover one through `AsyncLocalStorage`"），`context.abortSignal` 承载单请求取消——这是为 RPC/服务端形态设计的签名。

唯一的进程级全局：`setDefaultStreamFn()`（`src/stream-fn.ts:12`），仅在省略 `streamFn` 时使用，可以不碰。

### 1.2 会话持久化（b）

**层级 A（coding-agent `SessionManager`）**：JSONL，树形 `id/parentId`，v3 格式（`packages/coding-agent/docs/session-format.md`），路径 `~/.pi/agent/sessions/--<cwd>--/<ts>_<id>.jsonl`。可 `SessionManager.inMemory(cwd, {id}, entries)` 从任意来源装入再 `refreshContext()`（`docs/sdk.md` 0.87.0 Breaking Changes 段）。这是 CLI 产品的格式，接口不是为可插拔设计的。

**层级 B（agent-core harness）**：真正可插拔。`packages/agent/src/harness/session/types.ts`：

- `Storage`（:455-471）：`commit(writes[])`（原子事务，全有或全无）、`getEntries`、`getValue/scanValues/readList`、`scanBranch/scanBranchStructure/scanEntries/scanUsage`、`getStats`、`close`。三种持久形态：**append-only entry 树**（message / compaction / branch_summary / custom）、**可变 values/lists**（typed address）、**append-only usage ledger**（`docs/harness.md` §0.3）。
- `Session`（:530-565）：`beginMutation/mutate`（排他 mutation line）、`branch/createBranch`、`setValue/appendList`、`setName/setLabel`。
- `SessionRepo<TMetadata>`（:592-604）：`create / open / list / delete / fork`。
- 现成实现：`MemorySessionRepo`（`session/memory.ts:334`）、`JsonlSessionRepo`（`session/jsonl/repo.ts:46`，文件名 `<ts>_<id>.jsonl`）、`SqliteSessionRepo`（独立包，每 session 一个 `.sqlite` 或共享容器）。有**一致性测试套件** `harness/session/testing/conformance/{storage,session-repo}.ts`（920 + 1185 行）可直接跑自研后端。
- 操作状态机把**每次 durable 转换后的完整状态**写在 `pi.op.state`（"durable restart point"，§0.3 规则 3），恢复时读取即可从对应阶段继续，不重放日志；tool 调用带 `replay: "safe" | "never"` 语义（§0.5）。**异地节点恢复**：`AgentHarness.create()` 返回 `open: OpenOperation[]`，`lane.resume(ctx)` 继续；文档明确"a session lives in one place"、"exactly one host-assigned owner may hold a writable Session at a time"、后端"implement no cross-process lease, lock, fence, heartbeat, or takeover"（`packages/session-backends/sqlite-node/README.md`、`harness.md` §0.6）。即：**可以在任意节点打开并恢复，但单写者租约需由 agent-router / 自研 Storage 保证**。文档 Part 6 预留了"partitioned retention (Postgres)"，未实现。

### 1.3 Agent loop（c）

**核心文件**：`packages/agent/src/agent-loop.ts`（898 行）。`agentLoop()`（:37）/`agentLoopContinue()`（:70）→ `runLoop()`（:162）。

- **外层/内层双循环**（:177-311）：内层处理 tool call 与 steering，外层在自然停止后检查 follow-up 队列。
- **Steering / follow-up**：`getSteeringMessages()` 在开始（:175）、每个 turn 后（:290）轮询；`getFollowUpMessages()` 只在无 tool call 且无 steering 时轮询（:301）。`Agent` 类用 `MessageQueue`（`agent.ts:146-171`）实现 `"one-at-a-time" | "all"` 两种模式。
- **工具执行**：`executeToolCalls()`（:643 `Promise.all`）默认 `parallel`：顺序 preflight（`beforeToolCall`），并发执行允许的工具，`tool_execution_end` 按完成顺序发，但 toolResult message 按 assistant 源顺序落库；任一工具 `executionMode: "sequential"` 则整批串行（README "Tool execution mode"）。`stopReason === "length"` 时整批 tool call 直接判失败（:266-270）。
- **hook 点**（`AgentLoopConfig`，`types.ts:189-`）：`convertToLlm`（必需）、`transformContext`、`getApiKey`、`prepareRequest`（每次 provider 请求前）、`beforeToolCall`（可 block + terminate）、`afterToolCall`（可改写结果）、`finishTurn`（`{action:"end"|"continue"}`）、`prepareNextTurn`。
- **压缩**：loop 本身不做；`harness/compaction/compaction.ts`（865 行）提供 `shouldCompact / prepareCompaction / compact / generateSummary` 等纯函数；harness 层按 `reason: "manual" | "threshold" | "overflow"` 自动触发（`runtime/drive/structural.ts:139, 403, 572`）。
- **重试**：层级 A 无（依赖 pi-ai SDK 级 `maxRetries`/`maxRetryDelayMs`，`ai/src/types.ts:167-180`）；层级 B 有 `RetryPolicy {enabled, maxRetries, baseDelayMs, maxAgentDelayMs}`，在 `runtime/drive/response.ts:280-399` 于 durable 边界调度并发 `retry_scheduled/retry_start/retry_end` 事件。
- **上限**：**没有内建 max-steps / max-cost**。loop 靠 `finishTurn` 返回 `{action:"end"}` 或 `abort()` 终止；usage 逐条记账（`UsageRow`、`usage` 事件带 `totals`），成本上限需在 `finishTurn`/`after_response` 中自建。
- **层级 A 事件**（`AgentEvent`，README "Event Types"）：`agent_start`、`agent_end`、`turn_start`、`turn_end`、`message_start`、`message_update`（仅 assistant，带 `assistantMessageEvent` 增量：`text_delta`/`thinking_delta`/`toolcall_delta`…）、`message_end`、`tool_execution_start`、`tool_execution_update`、`tool_execution_end`。
- **层级 B 事件**（`HarnessEventPayload`，`agent-harness.ts:255-373`）：`run_start / run_resume / run_suspend / run_end / operation_abort / fault / handler_error / turn_start / turn_end / retry_scheduled / retry_start / retry_end / message_start / message_update(+frame) / message_end(+entryId) / tool_start / tool_update / tool_end / entry_added / queue_update / value_update / config_update / compaction_start / compaction_end / navigation_start / navigation_end / lane_created / usage`。
- **`Agent.subscribe()` 监听器被 await**（注册顺序），`agent_end` 是 barrier——把 SSE flush / DB 落库挂在这里天然有序。

### 1.4 扩展性（d）

- **MCP：没有。** `packages/coding-agent/README.md:537`："No MCP. Build CLI tools with READMEs, or build an extension that adds MCP support." agent-core 只有 `AgentTool`/`AgentHarnessTool` 契约（`harness/types.ts:108-122`：`execute(toolCallId, params, onUpdate, toolContext, invocation, context)`，`invocation.getMemo/setMemo` 用于安全重放），MCP → 工具的桥接需自己写（这是几十行的事：把 MCP `inputSchema` 作为 `parameters`，转发 `callTool`）。
- **Skills：有，且在 agent-core。** `Skill {name, description, content, filePath, disableModelInvocation}`（`harness/types.ts:49-60`），`loadSkills / loadSourcedSkills`（`harness/skills.ts:51,86`），通过 `AgentHarnessResources {skills, promptTemplates}`（:73-81）挂到 harness，`lane.skill(name, extra, ctx)`、`lane.promptFromTemplate(...)` 显式触发。coding-agent 的发现路径（`.pi/skills`、`.agents/skills`、`~/.agents/skills`）在 `DefaultResourceLoader` 中，可整体替换为自研 `ResourceLoader`。
- **Hooks / 扩展点**：
  - agent-core harness：`HookMap`（`agent-harness.ts:430-500`）11 个：`before_run / before_drive / before_run_end / transform_context / before_request / before_payload / after_response / before_tool / after_tool / before_compaction / before_navigation`，均为进程内类型化函数，带 `lane`、`runId`、`Context`。
  - coding-agent 扩展系统（`docs/extensions.md`）：TypeScript 文件由 `jiti` 从 `~/.pi/agent/extensions`、`.pi/extensions` 加载，事件链 `session_start → input → before_agent_start → agent_start → turn_start → context → context_with_system → before_provider_headers → before_provider_request → after_provider_response → tool_execution_start → tool_call → tool_result → turn_end → agent_end → agent_before_settle → agent_settled`；API `pi.registerTool / registerCommand / registerProvider / sendMessage / setModel / on(...)`。这层绑定 TUI 与文件系统，**服务端不应复用**，但 hook 词表值得照搬。
- **自定义工具**：`AgentTool {name, label, description, parameters: TypeBox schema, executionMode?, execute(toolCallId, params, signal, onUpdate)}`（README "Tools"）。内置 `read/write/edit/bash/image` 在 `harness/tools/*`，全部通过 `ExecutionEnv = FileSystem & Shell` 接口（`harness/types.ts:275-407`）访问文件/进程；Node 实现 `harness/env/nodejs.ts`（`spawn` 在 :153, :264）。**换成沙箱/远程执行只需实现这两个接口。**

### 1.5 Provider 层（e）

`packages/ai/src/providers/`：`deepseek`、`moonshotai` / `moonshotai-cn`、`kimi-coding`、`qwen-token-plan{,-cn,-individual}`、`zai` / `zai-coding-cn`（智谱）、`minimax` / `minimax-cn`、`xiaomi*`、`ant-ling`，加上 openai / anthropic / google / vertex / bedrock / azure / openrouter / groq / cerebras / mistral / xai / together / fireworks / nvidia / huggingface / baseten / cloudflare / github-copilot / opencode / vercel-ai-gateway。国内五家全部原生存在，模型目录由 `providers/data/*.json` 生成。

`api/openai-completions.ts`（1726 行）对 chat-completions 方言的处理：

- **reasoning**：读取 `reasoning_content | reasoning | reasoning_text` 三种字段（:268, :605-626）映射为 `thinking` 块；回放时按 `compat.requiresReasoningContentOnAssistantMessages`（`types.ts:694`）补空 `reasoning_content`。
- **thinkingFormat**（`types.ts:696-707`）：`openai | openrouter | deepseek | together | baseten | zai | qwen | chat-template | qwen-chat-template | string-thinking | ant-ling`；deepseek 分支 `thinking: {type}` + `reasoning_effort`（:921），qwen 分支 `enable_thinking`（:886）。
- **缓存 token**：`prompt_tokens_details.cached_tokens ?? prompt_cache_hit_tokens ?? cached_tokens`（:1523-1530，注释明确 DeepSeek/Kimi 语义），转成统一 `Usage {input, output, cacheRead, cacheWrite, cost}`。
- **tool-call 参数流式**：`partialArgs` 累积 + `parseStreamingJson()`（`partial-json`）增量解析（:459, :650），发 `toolcall_delta`。
- **compat 自动探测**：`detectCompat()`（:1585-）按 provider id 或 baseUrl（`deepseek.com`、`api.moonshot.`、`open.bigmodel.cn`…）推断 `maxTokensField`、`supportsDeveloperRole` 等；`Model.compat` 可覆盖（`types.ts:1005`）。
- **BYOK / 每请求注入**：`ProviderRequestOptions`（`types.ts:131-181`）含 `apiKey`、`headers`（可 `null` 抑制默认头）、`fetch`、`env`（provider 作用域环境覆盖，优先于 `process.env`，`utils/provider-env.ts:42-48`）、`onPayload`、`onResponse`、`timeoutMs`、`maxRetries`、`signal`。`ModelsImpl.applyAuth()`（`models.ts:648-677`）："Explicit request options win per-field"。`createModels({credentials, modelsStore, authContext})`（:244-248, :757）是**实例**而非模块单例。→ **每个租户一个 `Models` 实例或同一实例 + 每次调用传 `apiKey`，均可，且不依赖 process env。**
- 自定义 OpenAI 兼容端点：`createProvider({id, baseUrl, api: openAICompletionsApi(), models, auth})`（`providers/deepseek.ts` 即模板）。

### 1.6 多租户阻碍（f）

| 项 | agent-core / pi-ai | coding-agent |
|---|---|---|
| HOME 路径 | 无（仅 `~` 展开） | `~/.pi/agent`（`config.ts:528`）：settings/auth/models/sessions/extensions |
| 全局注册表 | `setDefaultStreamFn()` 可不用 | `ModelRuntime`、`SettingsManager` 进程级 |
| process env 凭据 | `envApiKeyAuth([...])` 只是默认 fallback（`providers/deepseek.ts:12`），显式 `apiKey` 优先 | `auth.json` + env |
| 子进程 | `harness/env/nodejs.ts` `spawn`（bash 工具）——通过 `Shell` 接口可换 | `cross-spawn`、`jiti` 加载扩展 |
| 文件系统假设 | `FileSystem.cwd` 字段，接口化 | 强假设（`cwd`、AGENTS.md 发现、`.pi/`） |
| 单写者 | 存储层不做租约（需 router 保证） | JSONL 文件锁 `proper-lockfile` |
| 遥测 / 外联 | `pi-telemetry` 契约为 no-op 默认；`getPiUserAgent()` 只是 UA 字符串 | `provider-attribution.ts:40-62`：仅对 OpenRouter/NVIDIA/Cloudflare 加归因头，受 `enableInstallTelemetry` 控制；无 phone-home |
| 服务端模式 | `pi-server`（Unix socket，实验性，"peer authentication remains application policy"） | `--mode rpc`（stdin/stdout JSONL）、`experimental/mini`（tui→server→per-session worker 子进程，unix socket `~/.pi/agent/experimental/mini.sock`）、`experimental/coordinator`；均为**本机单用户**拓扑 |

结论：**只取 pi-ai + pi-agent-core（+ 自研 Storage/ExecutionEnv）时，没有硬阻碍**。coding-agent、pi-server、mini 不要进服务端进程。

### 1.7 项目健康（g）

- 本地为 shallow clone（1 commit、0 tag）；按 `packages/coding-agent/CHANGELOG.md`：**0.87.0（2026-09-21）、0.86.1（09-20）、0.86.0（09-19）**、0.85.1（09-05）——一周三版。
- 破坏性变更策略：每个版本 CHANGELOG 单列 `### Breaking Changes`；`packages/agent/CHANGELOG.md` 中 "Breaking" 出现 12 次；0.87.0 就移除了 `shouldStopAfterTurn`、改了 `SessionEntry` 联合与 `TurnEndEvent` 形状。**0.x 语义，无兼容承诺**，但每次都给迁移说明。
- CONTRIBUTING：新贡献者的 issue/PR **默认自动关闭**，维护者每日复核；"core is minimal"，功能应做成扩展。供应链：直接依赖精确固定、`min-release-age=2`、shrinkwrap、`npm audit` 定时。
- 文档量大（`packages/agent/docs/harness.md` 1468 行规范 + 38 条不变量 + 一致性测试）；同时 §0.9 自述未完成项：JSONL 快照压缩、`watchSession` 抛 `SliceNotImplemented`、telemetry 只有工具 hook span、search 未实现、**存储格式 4 "WIP (pre-stabilization): shapes may change in place without migrations"**。

---

## 2. deepseek-harness（dsh）

### 2.1 包结构与可内嵌性（a）

- pnpm monorepo，`packages/<group>/<pkg>` 共 **291 个 package.json**，全部 `@deepseek-ai/dsh-*`，0.1.6-alpha.2，MIT；底座是 vendored 的 **cordis**（`vendor/cordis`、`loader`、`schemastery`…）插件容器，一切能力都是 `ctx.plugin(...)` 挂载的 Service。
- 核心 spine（`packages/core/README.md`）：`scope`（纯库）、`session`（`ctx.sessions`，append-only 事件日志）、`system-prompt`、`tools`（`ctx.tools`）、`agent`（`Agent` 契约 + 注册表 `ctx.agents`）、`agent-loop`（`ctx.agentLoop`，默认驱动，"swappable"）。
- 纯库性：`core/`、`session/`、`tools/`、`fs/`、`llm/` 组内 `process.exit`/`chdir`/`stdin`/`SIG*` 均为 0；`process.exit` 只在 `apps/cli/src/process-shutdown.ts:24`、`args.ts:191`、`boot/`、`sdk/`（各 2 处）。**HOME 依赖**集中在 `util/home-paths`（`resolveDshHome()`：显式 > `$DSH_HOME` > `~/.dsh`，`src/index.ts:84-99`）并被 `credentials`(6)、`boot`(4)、`shell`(4)、`llm`(2)、`settings`(1) 引用；`boot()` 一开始就 `ctx.provide('dshHomePath', dshHomePath)`（`app-boot/src/index.ts:940`）。
- 依赖：`dsh-agent-loop` 4 个 deps + **11 个 peer**（cordis、agent、invariants、llm、scope、session、session-persistence、session-projection、settings、system-prompt、tools）；`dsh-agent` 0 deps + 9 peers。即使"最小"嵌入也要拉起 7-8 个插件（见测试 `packages/core/agent-loop/tests/agent.spec.ts:13-24`）。

**进程内嵌入的最小形态**（来自上述测试，非公开文档）：

```ts
import { Context } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import LlmRuntime, { createUserMessage } from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";

const ctx = new Context();
await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjectionRegistry);
await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(AgentRegistry);
await ctx.plugin(AgentLoop, { agents: [] });
ctx.llm.registerAdapter(["myqwen"], myAdapter);           // 实现 LlmAdapter.stream(GenerateOptions)
// 持久化：再 ctx.plugin(MySessionPersistence)（继承 abstract SessionPersistence）
const { agent, dispose } = await ctx.agents.create({ /* CreateAgentOptions: meta{cwd,...}, agentOptions{provider,model,reasoningEffort,maxTokens} */ });
ctx.on("session/event", ...); ctx.on("agent/assistant-stream", ...); ctx.on("agent/status", ...);
agent.followup(createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } })); // agent/src/types.ts
agent.steer(msg); agent.inject(msg); agent.cancel(cause); await agent.whenIdle(); await dispose();
// 恢复：await ctx.agents.resume({ resumeSessionId, agentOptions })
```

产品级入口是 `boot('dsh', cordis.yml)`（`app-boot/src/index.ts:917`）读取 profile YAML（`bundle/base` 89 个插件、`web-app` 74、`sdk-minimal` 32、`headless` 2 + base）。

### 2.2 会话持久化（b）

- **可插拔抽象**：`abstract class SessionPersistence extends Service`（`packages/session/session-persistence/src/index.ts:135-200`）：`create(header) / open(id, 'read'|'write') / flush() / stat(id) / list()`；`SessionHandle`（`handle.ts:59`）：`read(offset,len) / append(events) / flush() / close()`，`write` 打开即**原子声明单写者**（`SessionAlreadyOwnedError`）。
- **格式**：event-sourced 日志，`SessionEvent {type, seq, time, data, ignorable?}`（`core/session/src/types.ts:470-490`），事件词表（`known-event-types.ts`，由脚本生成）：`turn/start|end`、`step/start|end`、`user/message`、`assistant/message|attempt`、`tool/call|result`、`request/header|context`、`compaction/*`、`llm/retry*`、`model/selection`、`agent/inbox/spliced`、`approval/*`、`subagent/*`、`team/*`…共 60 余种；未知非 `ignorable` 事件**拒绝重建**（防新版本日志被旧版本读坏）。已发布格式 v0→v1→v2→v3 各有冻结解码器包。
- **默认后端** `session-persistence-jsonl`：每 session 一目录、不可变 generation 文件、可选 zstd、内核级写锁（`src/index.ts:865-869`），根目录**必填无默认**（:90-94）。
- **异地恢复**：`ctx.agents.resume()` → `open(id,'write')`；`core/session/src/repair.ts` 对中断日志做确定性修补（`TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN` 合成错误结果，补 `step/end`、`turn/end`）。`session-checkpoint-policy` 保证"模型请求、顶层工具副作用、完成的 step 在下一动作前落盘"。**只要自研 `SessionPersistence`（对象存储/DB）并自行处理跨节点租约，即可在另一节点恢复。** 但 dsh 没有 pi 那样"从 durable 状态点继续执行中的操作"的语义——恢复后是"修补日志 + 等待下一次 followup"，而不是"继续未完成的 tool 批次"。

### 2.3 Agent loop（c）

- **核心文件**：`packages/core/agent-loop/src/agent.ts`（620 行）+ `tool-calls.ts`（290 行）+ `inbox.ts`。`kick()`（:227）循环 `turn()`（:265）；`turn` 内循环 `preStep()`（:240：claim inbox → `systemPrompt.assemble` → waterfall hook `agent/pre-step`）→ `step()` → `agent/turn-stopping`（:317）。turn/step 边界全部 `session.append(...)`。
- **工具执行**：`tool-calls.ts:42-234`：按 `ctx.tools.executionMode()`（工具声明 `isConcurrencySafe(args)`，`tools/src/index.ts:1282-1287`）分为 parallel 池与 exclusive 屏障，池大小 `maxParallelToolCalls` 默认 **10**（`constants.ts`，用户设置可改 `index.ts:299-313`）。工具定义 `ToolDefinition {execute(args, exec), output, finalizeContent?, timeoutMs?, isConcurrencySafe?, presentCall?, presentResult?}`（`tools/src/index.ts:216-`）。
- **Steering / follow-up**：`Agent.send(message, target: InboxTarget, wakeup)`，别名 `followup`（own turn）、`steer`（nearest step）、`inject`（next pre-step 上下文，不唤醒）；inbox 变更本身是 durable 事件 `agent/inbox/spliced`。
- **压缩**：独立 capability `compaction/`（`compaction-basic` 按 `thresholdRatio` 触发，`compaction-tool-result-pruner`、`compaction-image-offload`），事件 `compaction/start|prune|summary|end`。
- **重试**：`llm-retry` 插件在 step 边界重试（`normal` 有界 / `always` 无限），事件 `llm/retry-started`、`llm/retry`。
- **上限**：无 max-steps/max-cost（`grep maxSteps|stepLimit` 无命中）；`guard/` 提供重复调用提醒与 `tools/execute` deadline。`AgentOptions.maxTokens` 可限单次输出（`agent/src/runtime-types.ts:34`）。`turn/end.reason` 含 `max-tokens` 粘性标记。
- **事件**（cordis `ctx.on`）：`agent/created|disposed|status|error|pre-step|request|request-error|assistant-stream|turn-stopping`；`tools/change|pre-execute|execute|post-execute|result`；`llm/stream|adapters-updated`；`session/created|disposed|event`。`agent/assistant-stream` 的 `AssistantStreamFrame {start|chunk|end}` 带 `attemptId/revision/index`，`end.outcome` 指向已提交的 `assistant/message` seq——SSE 可直接转发。

### 2.4 Provider 层（e）

- 两个适配器：**`llm-deepseek`**（provider id 固定 `deepseek-official`，`src/index.ts:57`；chat-completions 与 Messages 两种协议）和 **`llm-pi-ai`**（直接依赖 `@earendil-works/pi-ai ^0.85.1`，`package.json:44`，把 pi-ai 的全部 provider 目录与自定义 OpenAI 兼容网关暴露为路由）。→ **dsh 自己对国内其它厂商（qwen/kimi/zhipu/minimax）的支持就是通过 pi-ai 实现的**。
- chat-completions 方言（`llm-deepseek/src/protocols/chat-completions/`）：`delta.reasoning_content` → reasoning 块（`translate.ts:157`）；回放时 assistant 消息带 `reasoning_content`（`serialize.ts:226`）；缓存 `prompt_tokens_details.cached_tokens ?? prompt_cache_hit_tokens`（`translate.ts:56`）。
- **BYOK 阻碍**：`GenerateOptions`（`llm/llm/src/types.ts:457-494`）字段为 `provider, model, reasoningEffort, messages, system, tools, temperature, maxTokens, stop, signal, sessionId, purpose`——**没有 `apiKey`/`headers`/`fetch`**。密钥由适配器在请求时经 `ctx.get('credentials').resolve(apiKeyEnv)` 解析（`llm-deepseek/src/index.ts:84-96`；`CredentialProvider` 抽象类 `credentials/credentials/src/index.ts:170-256`），凭据引用来自 settings 文件的 provider 路由配置。要做每用户 BYOK，必须自写 `LlmAdapter` 或自写一个"按当前 agent ctx 解析"的 `CredentialProvider`，而 `resolve(ref)` 签名里没有 agent/session 维度。

### 2.5 多租户阻碍与遥测（f）

- **遥测/外联（代码位置）**：
  - `x-deepseek-harness-user-id`（每个授权模型请求）、`x-deepseek-harness-session-id`、`x-deepseek-harness-compact: 1`：`llm-deepseek/src/protocols/chat-completions/adapter.ts:257-268`（Messages 协议同样）。user-id 来自 `identity/anonymous-user-id`：`$DSH_HOME/.anonymous-user-id` 文件里的随机 UUID（`src/index.ts:20-30`）。`user-agent` 由 `llm/llm/src/attribution.ts:64-68` 生成。
  - **`dsh_plugin_packages`**（完整活跃插件包清单）：`llm/plugin-package-inventory-deepseek/src/index.ts:33-39` `enabled` **默认 `true`**，`:193-204` 注册到 `ctx.deepseekLlmApiExtensions`；base bundle 挂载（`bundle/base/cordis.patch.yml:77-78`）。
  - **`dsh_session_log`**（增量**完整会话日志**作为请求体顶层字段上传）：`session/session-log-deepseek/src/index.ts:37-46` `enabled` **默认 `true`**，`:159-170` 注册；base bundle 挂载（`cordis.patch.yml:43-44`）。接受回执落为事件 `session-log-deepseek/delivery-accepted`。
  - 生效范围：仅 `deepseek-official` 适配器，但"sends the additions to its resolved baseURL, including a configured gateway"（`docs/deepseek-llm-api-wire-extensions.md`）；`llm-pi-ai` 路由不发。对 agent-runner 而言：**若用 dsh 直连 DeepSeek，必须在组合里显式关闭这两个插件或不挂载 `deepseek-llm-api-extensions`**，否则用户会话原文会随请求上传。
  - `session-telemetry-otel`：OTel logs，`FEEDBACK_ONLY | DISABLED` 模式，base bundle 挂载（:191-192）。
- **进程级单例**：`dshHomePath`（settings、credentials、skills、sessions 根目录）、`.anonymous-user-id`、`settings` 文件 seam、`credentials-local`（env > `.env`）——都是"一个进程 = 一个用户"的形状。cordis 的 scoped `agent.ctx` 只隔离**注册**（工具/prompt 段/事件），不隔离凭据与存储根。
- **子进程**：`shell-local`、`subprocess-local`、`terminal`、MCP stdio、`sandbox`（bwrap/Landlock/Seatbelt）、`ssh`——都是 capability seam，可不挂载。
- **服务端/守护形态**：
  - **SDK 模式**（`packages/sdk`）：子进程 stdio 上的 NDJSON JSON-RPC，仅 3 个请求（`initialize`、`session/prompt`、`shutdown`）+ 4 个通知（`session.event`——**"every session in the runtime, unfiltered"**、`session.status`、`subagent.started/finished`）。无 session 列表/恢复/取消方法；`initialize` 一次决定模型路由。Python SDK 同协议并自带运行时 wheel。
  - **ACP 模式**（`packages/acp`，`dsh --profile acp`）：标准 Agent Client Protocol，支持 create/resume/list/close session、选模型、挂 MCP、cancel；"trusted programs" 自动化用，无鉴权。
  - **Web 模式**（`host/webserver` + `api/gateway` Typert RPC）：`127.0.0.1` 默认，`0.0.0.0` 时"carries no TLS, authentication, or origin policy of its own"（`host/webserver/README.md:39,113`）。
  - **headless**：一次一任务，退出。
  - 均无"多用户、按用户隔离凭据/存储"的概念；`SAFETY.md:15`："Do not rely on DeepSeek Harness as the sole security control for untrusted workloads."

### 2.6 项目健康（g）

- 版本：`0.1.6-alpha.2`（唯一 tag `dsh-v0.1.6-alpha.2`，shallow clone）；README:13："developer preview… **THERE WILL BE COMPATIBILITY-BREAKING CHANGES**"。无 CHANGELOG 文件；`packages/README.md` 只把 `experimental/`、`test-support/`、`util/`、`runtime-diagnostics/` 列为低兼容承诺，其余"product — stable API"（与 README 的 alpha 声明矛盾）。
- CONTRIBUTING："We are sorry that we cannot accept external pull requests at the moment"——只接受 Discussions 与生态插件。
- 文档密度极高（每包 README + `docs/subsystems/*` + `.agents/notes` 决策记录，中英双语），但架构复杂度也极高：291 个包、cordis 容器、Typert 类型图、自研 `schemastery`。
- 依赖面：核心包 deps 少（`agent` 0、`agent-loop` 4），但 peer 链与 vendored cordis 意味着**无法只拿 loop 不拿容器**。

---

## 3. 对比表

| 维度 | pi（pi-ai + pi-agent-core） | deepseek-harness |
|---|---|---|
| 纯库核心 | `pi-ai`、`pi-agent-core`、sqlite backend：0 处 process.exit/chdir/stdin/SIG | `core/`、`session/`、`tools/`、`llm/` 组：0 处；但必须启动 cordis `Context` + 7 个插件 |
| 创建/运行/流/中止/恢复 API | `new Agent({...})` / `prompt` / `subscribe` / `abort` / `continue`；或 `AgentHarness.create` / `lane.prompt|accept+drive` / `events.on` / `lane.abort` / `lane.resume` | `ctx.agents.create|resume` / `agent.followup|steer|inject` / `ctx.on('agent/assistant-stream')` / `agent.cancel` / `whenIdle` |
| 显式 Context / 取消 | harness 层每个方法尾参 `Context`（含 abortSignal、telemetry parent） | cordis ctx + `AbortSignal` in `GenerateOptions` |
| 会话存储抽象 | `Storage`(12 方法) / `Session` / `SessionRepo`(5 方法)；Memory / JSONL / SQLite；一致性测试套件 | `abstract SessionPersistence`(5 方法) + `SessionHandle`(4 方法)；JSONL(+zstd)；格式迁移链 v0→v3 |
| 异地恢复 | 有 durable 操作状态机，可从中断的 tool 批次继续（`replay: safe/never`）；单写者由宿主保证 | 日志 repair 合成缺失边界后可 resume；单写者由 `open(id,'write')` 在后端内声明 |
| 工具并行 | 默认 parallel，按工具 `executionMode` 降级串行 | parallel 池（默认 10）+ exclusive 屏障，按 `isConcurrencySafe(args)` |
| steering/follow-up | steer / followUp 两队列，`one-at-a-time|all` | inbox：followup / steer / inject 三 target，durable |
| 压缩 | 纯函数 + harness 自动（threshold/overflow） | 独立插件（basic/pruner/image-offload） |
| 重试 | harness `RetryPolicy`（durable 边界） | `llm-retry` 插件（step 边界） |
| 步数/成本上限 | 无内建；`finishTurn` 自建 | 无内建；`maxTokens`/guard deadline |
| 事件 | A 层 10 种；B 层 28 种（含 retry/compaction/usage） | `agent/*` 9 种 + `tools/*` 6 种 + 60 余种 durable `session/event` |
| MCP | 无（需自桥接，工具契约简单） | 有（stdio/streamable-http，无 OAuth）—见 partial |
| Skills | agent-core 原生 `Skill` + `Resources` | `skill` provider 注册表—见 partial |
| Hooks | harness 11 个类型化 hook | cordis 事件 + waterfall（`agent/pre-step`、`tools/pre-execute`…） |
| 国内模型 | deepseek / moonshot(-cn) / kimi-coding / qwen×3 / zai×2 / minimax(-cn) / xiaomi / ant-ling 原生 | `deepseek-official` 原生；其余经 `llm-pi-ai`（即 pi-ai） |
| chat-completions 方言 | `reasoning_content|reasoning|reasoning_text`、11 种 `thinkingFormat`、3 种 cache 字段、partial-json 工具参数流、baseUrl 自动 compat | `reasoning_content`、`prompt_cache_hit_tokens`；其它交给 pi-ai |
| 每请求 BYOK | **是**：`apiKey/headers/fetch/env` 每次调用注入，`Models` 为实例 | **否**：`GenerateOptions` 无 apiKey；经进程级 `credentials` seam |
| HOME/单例 | 核心无；coding-agent `~/.pi/agent` | `$DSH_HOME`（settings/credentials/identity/sessions）贯穿 |
| 遥测/外联 | 无 phone-home；OpenRouter/NVIDIA/CF 归因头可关 | `x-deepseek-harness-*` 头 + **默认开启**的 `dsh_plugin_packages`、`dsh_session_log` 上传 |
| 服务端模式 | `--mode rpc`(stdio)、`pi-server`(unix socket, 实验)、`mini`(本机多进程) | SDK JSON-RPC(stdio)、ACP、Web(无鉴权)、headless |
| 版本节奏 | 0.87.0 / 0.86.1 / 0.86.0（一周三版），每版列 Breaking | 0.1.6-alpha.2，"THERE WILL BE BREAKING CHANGES" |
| 外部贡献 | 新人 PR 自动关闭，维护者复核 | 不接受外部 PR |
| 核心依赖数 | pi-ai 10（含 4 个厂商 SDK）、agent-core 7 | agent-loop 4 + 11 peer + vendored cordis |
| License | MIT | MIT |

---

## 4. 作为 agent-runner 内嵌 agent loop 的可行性

### 4.1 推荐

**选 pi：`@earendil-works/pi-ai` + `@earendil-works/pi-agent-core`，锁定 0.87.x，vendored 或 pin 精确版本。** 理由：

1. 它们本来就是库，没有任何 process 级副作用；`Models` 是实例、`apiKey/headers/fetch/env` 每次调用可注入——BYOK 与租户隔离在 provider 层零改造。
2. 国内五家 provider 与 chat-completions 方言差异（`reasoning_content`、cache 字段、`enable_thinking`/`thinking:{type}`、`max_tokens` 字段名）已经覆盖并有 `compat` 覆盖点；dsh 自己也是靠 pi-ai 覆盖非 DeepSeek 厂商。
3. `AgentHarness` 的 `Storage`/`SessionRepo` 抽象 + 一致性测试是为服务端持久化设计的；显式 `Context` 尾参正好对应 agent-router → runner 的请求取消传播。
4. 事件模型细（28 种，含 retry/compaction/usage），SSE 直接映射。

**不选 dsh 作为依赖**的理由：BYOK 需要改 LLM seam 或自写 adapter；身份/凭据/存储根都是进程级；默认上传会话日志与插件清单；必须拖 cordis 容器与 ≥7 个 peer 插件；alpha 且不接受外部 PR。但 dsh 的以下设计**直接借鉴**：MCP 配置模型与工具命名规则（见 partial）、`scrubbedParentEnv`、`ignorable` 事件标记 + 未知事件拒绝重建、`repair.ts` 的确定性日志修补、`isConcurrencySafe(args)` 按参数判并发、inbox 三 target 语义。

### 4.2 两条路线（pi 内部）

- **路线 A（先行）：`Agent` 类 + 自研会话落库。** 每个 HTTP 请求：从 DB 载入 `AgentMessage[]` → `new Agent({initialState:{messages,...}, streamFn, getApiKey})` → `subscribe` 转 SSE → `prompt()` → `agent_end` barrier 内落库。无 durable 操作状态，但简单、稳定（`Agent`/`agentLoop` API 自 0.5x 起变化小）。适合 MVP 与"一次请求一个 turn 序列"的无状态 runner。
- **路线 B（目标）：`AgentHarness` + 自研 `SessionRepo`（Postgres）。** 得到崩溃恢复、`accept/drive` 可由外部调度器驱动（"A serving layer may instead schedule `drive` calls through alarms, jobs…"，harness.md §0.2）、durable steer/followUp 队列、`usage` 事件。风险：格式 4 WIP、`watchSession` 未实现、Postgres 分区仅规划。建议在路线 A 稳定后，用 conformance 测试驱动自研 Storage 再切换。

### 4.3 需要替换/实现的缝（多租户服务端）

| # | 缝 | pi 侧接口 | agent-runner 实现 |
|---|---|---|---|
| 1 | 模型/凭据 | `createModels({credentials})` + `streamFn` 包装 `models.streamSimple(model, ctx, {apiKey, headers, fetch, env, signal})`；`getApiKey(provider)`（`agent-loop.ts:400`） | 每租户/每请求从 BYOK 配置解析；自定义 `fetch` 注入出站代理、超时、审计；`Model.compat` 为自建端点显式配置 |
| 2 | 会话存储 | 路线 A：`agent.state.messages` 装/卸；路线 B：`Storage`（`session/types.ts:455`）、`SessionRepo`（:592） | Postgres（entries/values/usage 三表）+ Redis 队列；跑 `harness/session/testing/conformance` |
| 3 | 单写者租约 | pi 明确不做（harness.md §0.6） | agent-router 按 sessionId 一致性哈希 + Storage 层 fencing token（`commit()` 带 owner 版本） |
| 4 | 执行环境 | `ExecutionEnv = FileSystem & Shell`（`harness/types.ts:275-407`）；`AgentTool.execute` | 替换 `NodeExecutionEnv` 为沙箱/远程执行（或直接不挂 bash/edit 工具）；`toolContext` 携带租户身份 |
| 5 | MCP → 工具 | `AgentHarnessTool`（`harness/types.ts:108`） | 自写桥：MCP `inputSchema` → `parameters`，`callTool` → `execute`；命名/截断规则照 dsh；每租户独立 MCP 连接池 |
| 6 | Skills | `Resources.skills[]`（`harness/types.ts:73`）+ `lane.skill()` | 从对象存储/DB 装载，不用 `loadSkills` 的文件系统发现 |
| 7 | 压缩策略 | `transformContext` / `CompactionSettings` / `before_compaction` hook | 按模型 contextWindow 与租户配额设阈值 |
| 8 | 步数/成本上限 | `finishTurn` / `after_response` / `usage` 事件 | runner 内 turn 计数 + usage 累计，超限返回 `{action:"end"}` 并发 SSE 结束原因 |
| 9 | 取消 | `agent.abort()` / `Context.abortSignal` | HTTP 连接断开 → abort；router 转发 cancel 到持有 session 的 runner |
| 10 | 遥测 | `pi-telemetry` `TelemetryContext`（默认 no-op） | 接 OTel；pi 无外联需关闭 |
| 11 | 不要引入的包 | `pi-coding-agent`、`pi-tui`、`pi-server`、`experimental/*` | — |

### 4.4 风险与对策

- **发版速度与 Breaking**：pin 精确版本 + vendored 打包；升级前跑自有 conformance/契约测试；关注 `packages/agent/CHANGELOG.md` 的 Breaking 段。
- **harness 层未稳定**：把 `AgentHarness` 用法封在 runner 的一个适配模块内，对外只暴露自定义 `RunnerEvent`；路线 A 兜底。
- **pi-ai 体积**（4 个厂商 SDK 为直接依赖）：接受；或只 import `@earendil-works/pi-ai/providers/<x>` 子路径（`api/*.lazy.ts` 已做惰性加载）。
- **无 MCP**：自建桥一次性成本低，且可控（dsh 的实现证明桥接只需一个 `ctx.tools.register` 等价物）。
