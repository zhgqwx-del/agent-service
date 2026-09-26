# 前期 Harness 调研的批判性摘要（面向 agent-router / agent-runner 新方案）

> 来源：`/Users/zhangguoqiang/Desktop/meetyou/agent-runtime-方案/` 下的三份文档
> - 文档 01：`01-四个开源Harness对比评测.md`（2026-09-14，四仓库 clone 实读）
> - 文档 04：`04-Harness复用边界与自研清单.md`（2026-09-14，2026-09 修订）
> - 文档 07：`07-PoC与deepseek-harness对比.md`（2026-09-15，容器内实测）
>
> 前提差异必须先讲清：**那三份文档服务的是一个"语音记录/分析 App"**，它的 agent 只有业务工具、没有代码执行、主链路被降级成 `maxSteps=2` 的固定工作流，因此结论是"不需要 code-agent harness，需要 conversation-agent runtime"。
> **新方案（agent-runner 类比 `opencode serve`，要 MCP / skills / plugins / BYOK，20M+ DAU 分布式）与那个前提有根本冲突。** 本文逐条区分：哪些是"产品无关的源码事实"（可直接继承），哪些是"由旧产品前提推导出的结论"（要重新推导，部分要翻转）。
>
> 快照时间：四个仓库均为 2026-09-14 前后的 HEAD（文档 01 附录），现在是 2026-09-22，一周内的上游变化未覆盖。

---

## 1. 产品无关的事实：四个 harness 逐一盘点

以下事实来自源码实读，与旧产品前提无关，可直接作为新方案的输入。凡引用均标注文档号 + 章节。

### 1.1 一页总表

| | opencode | deepseek-harness (dsh) | codex | pi |
|---|---|---|---|---|
| 仓库 / 语言 | `sst/opencode`，TS，**Bun 优先**（Node 次等分支） | `deepseek-ai/deepseek-harness`，TS / Node ≥22.19，ESM only，pnpm | `openai/codex`，Rust 1.95 / edition 2024，Cargo + Bazel | `earendil-works/pi`，TS，ESM only，Node ≥22.19 |
| 许可证 | MIT | MIT | Apache-2.0 | MIT |
| 体量 | 541K 行 TS + 141K TSX，约 82% 是 TUI/桌面/Web/SaaS | 406K 行非测试 + **452K 行测试 / 1,021 spec**；268 个 workspace 包 | 1.73M 行（非测试 944K）；179 crate / 1,487 依赖 | 约 186K 行；544 个 test 文件 |
| 版本状态 | v1→v2 大重构中（v1 `packages/opencode`，v2 `packages/core`） | **`0.1.5-rc.2`，无正式 release**；`SAFETY.md` 明示"非生产就绪" | PR #45345，高频迭代 | 0.85.1；4 个月 45 个 minor，`AGENTS.md` 明写不保向后兼容 |
| 可作为库嵌入 | 部分：`packages/llm`（20.5K 行、5 个运行时依赖）可独立剥离；整体 serve 不行 | 可：内核 7 个 `ctx.plugin()`，实测 20 包 / 12 MB / 冷 import 79 ms / RSS +21.4 MB | 差：无 cargo feature 裁剪，144 个 feature flag 只关行为不减体积 | 最好：`pi-ai` + `pi-agent-core`，零进程副作用（见 1.5） |
| Provider 层 / 国内模型 | DeepSeek 内置 profile，`reasoning_content` 方言显式支持；通义/豆包/Kimi 各改一行 | `llm-pi-ai` 三协议含 `openai-completions`，`baseURL`+`api`+`apiKeyEnv` 一行 YAML 接任意兼容端点 | **否决**：`WireApi` 枚举只剩 `Responses`，`"chat"` 显式报错，全仓 0 处 `chat/completions` | 45 个内置 provider，含 `deepseek`、`moonshotai(-cn)`、`kimi-coding`、`qwen-*`、`zai`、`minimax`、`xiaomi`；缺豆包（一个文件） |
| MCP | 有（stdio 为主，per-directory 共享，容量无上限） | 有（`@deepseek-ai/dsh-mcp`，stdio + HTTP，per-plugin-instance，静态 `cordis.yml`） | 有（stdio 为主，LRU 32 / TTL 30min，唯一考虑有界的实现） | **无**（`coding-agent/README.md:499` "No MCP."，产品决策） |
| Skills | 有（目录 + SKILL.md + 渐进加载，4 字段） | 有（provider seam：`list()` 元数据 + `get(locator)` 正文） | 有（完整软件包概念：依赖 / policy / scope，含 token 预算截断） | 无（文档未提及 skill 体系） |
| Plugins | 弱：运行时 `Npm.add()` + 动态 `import()`；tool 目录 glob 动态 import | **最彻底**："Everything is a Plugin"，vendored Cordis 4.0.2，**agent loop 本身可替换**（`AgentRegistry.setFactory()`） | hooks 目录（15.7K 行，每 hook spawn 子进程）、插件市场 | 无插件体系；三层 API（L1 函数 / L2 类 / L3 harness）靠代码组合 |
| 会话存储 | 进程内 Map + 本地；`sync/README.md` "only one device is allowed to write"；v2 自陈 TODO "durable multi-node ownership" | `SessionPersistence` 抽象类，官方只有本地 JSONL 实现 | `ThreadStore` trait，最规整；换后端一个文件 + 官方回归测试 `remote_thread_store.rs` | `Storage`（12 方法）+ `SessionRepo`（5 方法），树形 append-only Entry 链，Memory / JSONL / SQLite 三实现 + **conformance 测试套件** |
| 进程级 HOME 单例 | `Global.Path.data`（XDG），`core/src/global.ts` 顶层 `await mkdir ×7` | `$DSH_HOME`（`packages/util/home-paths/src/index.ts:18`），25 处 HOME 解析贯穿存储/凭据/配置 | `CODEX_HOME` + `AuthManager` 单例 | 默认 JSONL 落盘但可换；无全局 |
| 沙箱 | **无**（grep `landlock\|seatbelt\|seccomp\|bwrap` 0 命中） | 有但是 same-world confinement（共享 host kernel + fs） | 最强（bwrap+seccomp / Landlock / Seatbelt / AppContainer），有 `SandboxPolicy::ExternalSandbox` | 无（README "no built-in permission system"） |
| 内置轮数/成本上限 | 有 step 限制 | 有 `timeout-policy` 插件，**无成本阀** | 无（`turn_admission.rs` 87 行只管关机 drain） | **无，一行都没有** |

来源：文档 01 §0 表、§1.1、§2.1、§3.1、§4.1、§5.1、§5.2；文档 04 §3.1、§4.1；文档 07 §1。

### 1.2 opencode（文档 01 §1）

**产品无关的关键事实：**

- `packages/llm`（20,526 行）是可独立剥离的资产：6 个协议适配器（anthropic-messages / openai-chat / openai-responses / openai-compatible-chat / gemini / bedrock-converse）+ 11 个 provider；运行时依赖只有 `effect` / `@opencode-ai/schema` / `aws4fetch` / `@smithy/eventstream-codec` / `@smithy/util-utf8`，**不依赖 ai-sdk 或 openai sdk**。DeepSeek 已是内置 profile（`openai-compatible-profile.ts`），`openai-chat.ts` 四处显式处理 `reasoning_content` / `reasoning_effort`。`cache-policy.ts` 在最后一个 tool 定义 / 最后一条 system / 最新 user message 三处打缓存断点（§1.2）。
- **Context Epoch**（v2 `CONTEXT.md`）：baseline system context 在一个 epoch 内逐字节不可变并持久化，变更以 mid-conversation system message 追加（§1.3）。配套 `session/overflow.ts` 阈值判定与两级压缩常量 `PRUNE_MINIMUM=20_000` / `PRUNE_PROTECT=40_000` / `TOOL_OUTPUT_MAX_CHARS=2_000`。
- **`opencode serve` 在服务端会爆的地方（§1.4 表）** —— 这一条对新方案尤其重要，因为新方案的 runner 明确以 `opencode serve` 为参照：
  - `effect/instance-state.ts:31` 的 `ScopedCache` `capacity: POSITIVE_INFINITY` 无 TTL；每个新 directory 触发 `project/bootstrap.ts` 起 LSP 子进程 + git snapshot + `@parcel/watcher`。
  - 认证是 `OPENCODE_SERVER_PASSWORD` 单口令 HTTP Basic，**无 user 无 tenant**；`x-opencode-directory` 可传任意绝对路径且无前缀校验 → 配 read/write/shell 工具 = 任意文件读写 + RCE。
  - `permission/index.ts:32` 默认 `{action:"ask"}` → `Deferred.await` 无超时无默认拒绝 → 无 UI 回复则 session 永久 busy。
  - `provider.ts:1846` 运行时 `Npm.add()` → `import()`；tool 目录 glob `{tool,tools}/*.{js,ts}` 动态 import。
  - `core/src/global.ts` 顶层副作用：import 即建 7 个 XDG 目录。
  - 实测：仅 import `effect + ai + @ai-sdk/* + drizzle + mcp-sdk + otel` RSS 111.5 MB（`effect` 一个包 +57.9 MB），冷 import 1,877 ms；`packages/opencode` 非 workspace 依赖 568 MB / 671 包；19 个 `patchedDependencies`；`packages/app` 依赖私有 repo `github:anomalyco/ghostty-web`，`bun install` 直接 403。真实 serve 进程估 150–250 MB。
- MCP 实现细节（文档 04 §3.1）：`mcp/index.ts:347-357` **把整个父进程 `process.env` 原样传给 MCP 子进程**（服务端 = 凭据泄漏）；`mcp/index.ts:417-436` 用 `pgrep -P` 递归清理孤儿子孙进程（值得抄）。OAuth token 存 `Global.Path.data/mcp-auth.json`，key 是 server 名，无用户维度（`mcp/auth.ts:37-38`），回调绑 `127.0.0.1`（`oauth-callback.ts:6`）。
- Skill（文档 04 §4.1）：`skill/index.ts:37-42` 只有 name / description / location / content 四字段；system prompt 放 name+description，模型调 `skill(name)` 才注入正文。`skill/discovery.ts` 有远端 `<url>/index.json` 拉取但先落盘到本机缓存，`discovery.ts:39` "有文件就不重新下"，version 字段没用于失效。
- `SystemContext` 增量机制（文档 04 §5 附加，`packages/core/src/system-context/index.ts:32-39`）：`Source<A>` 带 `baseline` / `update` / `removed` 三渲染 + `unavailable` 第三态，用于"skill 列表 / 工具列表中途变了，不改 system prompt 而在对话尾追加增量消息"。

**判定（§1.5）**：取 `packages/llm` + `packages/schema`（约 24K 行），抄 Context Epoch 与压缩常量，其余不碰；不用 `sdk-next` 做底座（要求 Effect 4 beta + Bun，v2 内核自陈 11 项未完成，恰含多节点所有权和 durable status）。

### 1.3 deepseek-harness（文档 01 §2；文档 07 全文）

**产品无关的关键事实：**

- Cordis 4.0.2（vendored，2,693 行）：Context 是依赖容器，Plugin 是 `(ctx, config)` 回调，所有注册可逆。`docs/architecture.md` 原文 *"Every part of the product is a plugin, including the model adapter, the tool registry, the session log, and the agent loop itself... There is no privileged core to patch."* 可替换 ctx key 逐条核对存在：`ctx.llm` / `ctx.tools` / `ctx.agents.setFactory()` / `ctx.sessionPersistence` / `ctx.storage` / `ctx.fs` / `ctx.subprocess` / `ctx.shell` / `ctx.sandbox` / `ctx.subagents` / `ctx.compaction` / `ctx.userApproval` / `ctx.userQuestions` / `ctx.credentials` / `ctx.settings` / `ctx.sessionTitle` / `ctx.sessionTelemetry`（§2.2）。
- **`Context.isolate()`**（`vendor/cordis/src/context.ts:115`）：同进程内 `ctx.isolate('llm')` 之下挂另一个 `ctx.llm`，父作用域不受影响；`packages/preset/agent-presets` 已用它做"一个进程跑不同 preset 的 session 状态互不干扰"（§2.2）。
- **"Model-visible means logged"** 硬不变量：模型历史从 append-only session log **投影**（`deriveMessages()`），压缩不删日志只追加 summary 并标 shadowed，重放确定性复现；system prompt 也走日志（`system/message` surface node）。配套 `systemPromptUpdate: 'in-history'` 能力：非空更新 append 在缓存前缀之后（§2.3）。
- Provider：`llm-deepseek`（715 行，DeepSeek 专用，`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 一等公民，`types.ts:163`）；`llm-pi-ai`（约 3,300 行，`provider.ts:48` 的 `PROTOCOLS = {openai-completions, openai-responses, anthropic-messages}`）。`LlmAdapter` 抽象类**只有一个抽象方法** `stream(options): AsyncIterable<StreamChunk>`（§2.4）。
- **遥测合规问题**（§2.4）：`llm-deepseek` 默认上报 header `x-deepseek-harness-user-id`（`$DSH_HOME` 匿名 UUID）、`x-deepseek-harness-session-id`，body 字段 `dsh_plugin_packages`（**默认启用，上报完整插件清单**）；`dsh_session_log`（上报会话日志）默认关闭但代码在。见 `docs/deepseek-llm-api-wire-extensions.md`。
- 服务端会爆的地方（§2.5 表）：`SAFETY.md` "must not be treated as secure or production-ready"；`$DSH_HOME` 进程单例；SDK wire "no per-session close or prompt-cancel method — SDK-created agents remain live until process shutdown"（`packages/sdk/server/README.md:125-126`）；`session.event` 是 "every session in the runtime, unfiltered"（`packages/sdk/protocol/README.md:43`）；`sessionPersistence.list()` 是 "every stored session visible to this process"；沙箱是 same-world confinement（`packages/sandbox/sandbox/README.md`）；`sdk-minimal` 的 `cordis.patch.yml` 默认 `mode: danger-full-access` + `workspaceRoot: process.cwd()`。
- **好消息**：无进程级污染（`process.chdir` 0，`process.env.X =` 0）；内核有 `AgentHandle.dispose()` 与 `agent.cancel(cause)` —— agent 不释放是 SDK wire 缺陷，不是内核缺陷（§2.5 末）。
- 库调用实测（§2.7；文档 07 §1、§5.1）：挂载 7 个 `ctx.plugin()`（`packages/test-support/agent-loop-testkit/src/index.ts:68-77`：`LlmRuntime` / `SessionStore` / `SessionProjectionRegistry` / `SystemPrompt` / `ToolRuntime` / `AgentRegistry` / `AgentLoop`），传递依赖 20 个 `@deepseek-ai/*` 包。**npm `latest` dist-tag 指向坏版本**（`dsh-llm` 0.0.1-rc.1，`dsh-agent-loop` 0.1.0-rc.6，仓库 0.1.5-rc.2）→ `TOOL_RUNTIME_SCHEDULER` 导出缺失；15 个直接依赖 pin 到 `@0.1.5-rc.2` 后 7/7 import 成功。持续维护税。
- MCP（文档 04 §3.1、§3.5）：`mcp-client/src/index.ts:1-11` "Each plugin instance connects to one MCP server; load multiple instances in `cordis.yml`" —— **没有运行时动态注册一个用户的 MCP server 的路径**；`transport.ts:21-23` `scrubbedParentEnv()` 做了凭据清洗；`connection.ts:1-15` outage-scoped 重连预算（crash-looping 服务器不会无限重启）。无 OAuth，只有静态 headers。MCP client 本体 1,158 行 src / 3,043 行 test。
- Skill（文档 04 §4.2）：`packages/skill/skill/src/index.ts` 的 provider seam —— `SkillResourceBase` 为 `directory | url | opaque`，`SkillCandidate` 带 `rank` + opaque `locator`；`list()` 只返回元数据，`get(locator)` 才加载正文。这是唯一能直接接 DB 的形状。
- 前向引用：`initialize` 握手钉死模型路由（SDK 形态确定，库形态未验证），见 §4。

### 1.4 codex（文档 01 §3）

**产品无关的关键事实：**

- 否决理由与产品无关：`model-provider-info/src/lib.rs:61` `CHAT_WIRE_API_REMOVED_ERROR`，`WireApi` 枚举只剩 `Responses`；`create_model_provider` 工厂硬编码，无注册表、无 `Arc<dyn ModelProvider>` 注入口。接国内模型要 2,000–4,000 行 Rust fork 或外挂 `/v1/responses → /chat/completions` 翻译网关（有参照物 `codex-rs/responses-api-proxy/`）。耦合还在加深（`responses_websocket`、`remote_compaction: V2`、`prompt_cache_key`）（§3.3）。
- **可抄的设计**（§3.2）：`app-server-protocol` 宏 DSL 单一真源（`protocol/common.rs` 约 2,900 行）导出 720 个 `.d.ts` + 310 个 JSON Schema；166 个 Client Request（`thread/*` 42、`turn/*` 4、`skills/*`、`mcpServer/*`…）、11 个 Server→Client 反向请求（审批、**`item/tool/call` 动态工具反向委派**）、约 90 个 Notification。声明式串行化域 `serialization: thread_or_path(...)`；`ServerNotificationEnvelope.emitted_at_ms`；`JSONRPCRequest.trace: Option<W3cTraceContext>`；`turn/steer`；`thread/start.{ephemeral, dynamicTools, base_instructions, config, model_provider}` per-thread 覆盖；`ThreadStore` trait。
- 服务端硬伤（§3.4 表）：`CHANNEL_CAPACITY = 128` 静默丢 delta（`app-server-transport/src/transport/mod.rs:22`，`in_process.rs:26` 自陈 "event fanout may drop notifications under saturation"）；`CODEX_HOME` + `AuthManager` 单例；`turn_admission.rs` 只 87 行；"only one native worker per app-server"；`rollout/src/writer_lock.rs` 文件锁阻止多副本共享 PVC；Guardian（`core/src/guardian/` 21 文件）另开模型会话审批每次工具调用；会自己上网（`models_refresh_worker` / analytics 14.8K 行 / `update_loop` / `main.rs:117` 默认反连 OpenAI）；hooks 每个 spawn 子进程。
- 沙箱最强且有 `SandboxPolicy::ExternalSandbox`（"我已在容器里别再套一层"）—— K8s 部署模式（§3.4）。
- Skill 相关（文档 04 §4.1）：`skills/src/model.rs:6-20` `SkillMetadata` 带 `interface` / `dependencies` / `policy` / `scope` / `plugin_id`；`SkillToolDependency` 让 skill 声明依赖的 MCP server（`core/src/mcp_skill_dependencies.rs` 531 行）；`skills/src/invocation.rs:13-30` tokenize shell 命令识别隐式 skill 调用；`ext/skills/src/render.rs:17-27` 目录预算 = context window 2%，上限 10k token，超了逐级截断并告知模型。
- MCP OAuth（文档 04 §3.2）：`rmcp-client/src/oauth.rs:92,1012-1024` `KEYRING_SERVICE = "Codex MCP Credentials"`，key = hash(type, url, headers)，无用户维度；回调绑 127.0.0.1；OAuth 部分约 7,000 行非测试，其中 `www_authenticate.rs`（233 行，RFC 9728）、`oauth_client_registration.rs`（139 行，RFC 7591）、`oauth_callback.rs:1-31`（RFC 9700 §4.4 mix-up 防御）几乎可照抄规格。
- 构建体积（§3.5）：CI 超时 Windows release 120 分钟；三个 git 依赖补丁指向 `openai-oss-forks`。

### 1.5 pi（文档 01 §4）

**产品无关的关键事实：**

- 分层（`package.json` 实证，§4.2）：`packages/ai` 24,383 行 `@earendil-works/pi-ai`；`packages/agent` 25,305 行 `@earendil-works/pi-agent-core`（dependencies 只有 7 项，**不含 `pi-tui`**）；`packages/tui` / `coding-agent` 只属于 CLI。core entry 不碰 fs/child_process（`node:` import 只在 `harness/env/nodejs.ts` 独立入口）。装机 `pi-agent-core` 3.5 MB，`pi-ai` 4.1 MB。
- 三层 API（§4.3）：L1 `agent-loop.ts`（803 行）无状态函数 `agentLoop(prompts, context, config, signal, streamFn)`；L2 `agent.ts`（592 行）`class Agent` `prompt/steer/followUp/abort/subscribe/state`；**L3 `harness/agent-harness.ts`（622 行）`AgentHarness<TContext>` + `AgentLane`**：durable 状态机，`harness/session/types.ts` 15+ operation 状态，`harness/runtime/drive/recovery.ts` 崩溃恢复配合工具 `replay?: "never" | "safe"`；`AgentLane.drive()` 让调用方掌控事件泵，一次 operation 可拆到多请求/多 worker 推进。
- Provider（§4.4）：45 个 `KnownProvider`；**per-model 约 28 个 `compat` 方言开关**（`thinkingFormat` 含 `deepseek` / `qwen` / `zai` / `chat-template`…，`thinkingTokenBudgetField` 含 vLLM / DashScope / llama.cpp 三种字段名，`maxTokensField`、`requiresReasoningContentOnAssistantMessages` 等）；`samplingParams` 透传 `top_k` / `min_p`；`cacheRetention` / `sessionAffinityFormat` / `Usage` 分 `cacheRead/cacheWrite/cacheWrite1h` + `ModelCostTier` 阶梯计价。流式 13 变体 discriminated union，每事件带 `partial: AssistantMessage`。
- **进程副作用实测全部为零**（§4.5 表）：库包内 `process.exit` / `process.chdir` / `process.on` / `process.env[...]=` / `process.stdout` / `setInterval` 全 0；`console.warn` 1 处（`agent/src/proxy.ts:398`）；3 处 `setTimeout` 全 `.unref()`。`cwd` 是 `FileSystem` 接口字段而非 `process.cwd()`；Context 是 Go 风格显式传递（chord），零 AsyncLocalStorage。**`ProviderRequestOptions` 提供 per-request `apiKey` / `env` / `headers` / `fetch` 注入**。
- 存储（§4.6）：`Storage`（12 方法）+ `SessionRepo`（5 方法），树形 append-only Entry 链带 `parentId`（支持 fork / 分支导航），KV + List + usage ledger，`CustomEntry` + `entryProjectors`。三实现 Memory / JSONL / `@earendil-works/pi-session-backend-sqlite-node`。**conformance 套件** `packages/agent/src/harness/session/testing/conformance/{storage,session-repo}.ts` 通过 `./harness/session/testing` 子路径导出。Postgres 实现估 1,200–1,800 行。
- 坑（§4.7 表）：`ai/src/session-resources.ts:12` `cleanupSessionResources()` 不传 sessionId 则清所有租户（跨租户炸弹）；**无任何轮数/成本/时间上限**（只靠 `shouldStopAfterTurn` 回调）；`SessionMutation` 进程内互斥、`AgentLane` 返回 `LaneBusy`，两个 pod 同时 open 会写坏 entry 链；`openai-codex-responses.ts:880-882` 三个进程级 Map 无 LRU；`/compat` 全局注册表（README 劝 new bundled apps 不要用）；`pi-ai` 硬依赖 `@aws-sdk/client-bedrock-runtime` / `@anthropic-ai/sdk` / `@google/genai` / `openai`；`pi-server` experimental + Unix socket + CBOR + 无认证；README 第 12 行新贡献者 issue/PR 默认自动关闭。
- **无 MCP、无子 agent、无 skill、无 plugin** —— 明确的产品决策。旧文档写"对本场景大概是好事"（§4.7 最后一行），新方案下这是缺口（见 §2）。

### 1.6 四家共有的多租户结构性缺陷（文档 01 §5.2；文档 04 §1.4）

| 缺陷 | opencode | dsh | codex | pi |
|---|---|---|---|---|
| 进程级 HOME 单例 | `Global.Path.data` | `$DSH_HOME` | `CODEX_HOME` | 默认 JSONL（可换） |
| 认证 | 单口令 Basic | HMAC cookie + launch token（本机浏览器） | 进程级单一身份 | 无（纯库） |
| 会话列表有 tenant 维度 | 无 | 无 | 无 | 无（`SessionRepo` 可自己实现） |
| 事件流 tenant 过滤 | 按 directory | 无（SDK 全广播） | 按连接 | 按 harness 实例 |
| session 单写者 | 进程内 Map | 抢占式 owner（`open('write')`，`session-persistence/src/index.ts:153`） | 文件锁 | 进程内互斥（`LaneBusy`） |
| 分布式所有权 | 无（v2 TODO） | 无 | 无 | 无 |
| K8s/Helm/compose、per-request 租户上下文、用户表、租户配额、水平扩容文档 | 五项全无 | 五项全无（`anonymous-user-id/README.md` 反证 "Do not use it to identify a user"；"multi-tenant" 出现 2 处都是"还没做"） | 五项全无（`network_policy.rs:32` "without tenant or session identity"） | 五项全无 |

文档 04 §1 的源码证据：opencode desktop 是 Electron + 本地 loopback sidecar（`packages/desktop/src/main/index.ts:373-391`，`randomUUID()` 口令，模块级单例 `let server`）；codex `app-server` 的 `--listen ws://` 是"一个用户从别的设备连自己的机器"（`connection_auth.rs` 绑认证所有者）；dsh webserver 的 `host: '127.0.0.1' | '0.0.0.0'`（`packages/host/webserver/src/index.ts:60`）。**结论：四家的"服务端"形态都是 per-user 进程拓扑，不是共享多租户服务。这一条与产品无关，新方案直接继承。**

---

## 2. 旧结论在新 brief 下：哪些成立、哪些翻转

新 brief 的四个约束对旧结论的冲击点：(a) 通用 agent runtime，明确要 MCP / skills / plugins / BYOK；(b) 20M+ DAU 分布式；(c) 多用户多会话隔离 + 粘性路由；(d) router 无状态 + runner 有状态、历史入云存储；(e) 允许嵌入开源 agent 作 loop。

| # | 旧结论 | 出处 | 新 brief 下 | 理由 |
|---|---|---|---|---|
| 1 | 四个 harness 全是"单机单用户 CLI 编码工具"形态，多租户所需的一切结构性缺失 | 01 §0、§5.2；04 §1.4 | **成立** | 源码事实，与产品无关。20M DAU 下 tenant 存储 / 鉴权 / 配额 / 分布式所有权仍然全部自写 |
| 2 | codex 否决（Responses API 锁死） | 01 §3.3、§5.1 | **成立** | 国内模型只提供 chat/completions；新 brief 第 5 条明确要求。但其 `app-server-protocol` 作为 runner 对外 HTTP/SSE 协议的规格书**价值上升**（runner 要被任意外部客户端调用） |
| 3 | 形态 A（SDK/子进程 + 多部署）不可行：状态归属、事件全广播、agent 不释放 | 07 §2 | **成立** | 结构性问题，与流量模型无关。新 brief 的 router→runner 粘性路由正是对"状态归属"问题的正确回应，但不能靠 dsh SDK 进程池实现 |
| 4 | 形态 B（库调用）可行，dsh 内核实测 21.4 MB / 79 ms | 07 §1、§3 | **成立且更重要** | 新 brief 第 6 条"嵌入开源 agent 作 loop"就是形态 B。三个接缝（§4）是必付成本 |
| 5 | "不需要 code-agent harness，需要 conversation-agent runtime" | 04 §6、07 §4.2 | **翻转** | 旧前提是"agent 只有业务工具、无代码执行、maxSteps=2"。新 brief 是通用 harness 能力，多步自主循环是常态 |
| 6 | 主链路 `maxSteps=2` 固定编排，dsh loop 的优势（工具配对、压缩事务、崩溃恢复三态、并发 commit 严格按序、不变量检查器）大部分失效 | 07 §3.3 | **翻转** | 通用 runtime 下这些优势全部回到"刚需"。文档 07 §4.3 自己写的改口条件第一条"主链路确实需要多步自主编排（`maxSteps > 4`）→ 推荐形态 B 全量"，新 brief 满足 |
| 7 | harness 复用面收缩到一个点：remote MCP 客户端 | 04 §6、§8；07 §5.6 | **翻转** | 复用面重新扩大：loop、压缩、MCP、skill、plugin 架构都在候选内。但"运行时层（会话、持久化、拓扑）自研"这半句仍成立 |
| 8 | MCP 代码零复用价值、只有规格有价值；stdio MCP 在服务端不成立 | 04 §3 | **一半成立一半翻转** | stdio 内存算术（每会话 3 个 × 60 MB）成立，remote MCP 为主仍是正确方向；但"MCP 不用或可选"翻转为**必须支持**，且要有运行时 per-user 动态注册（dsh 静态 `cordis.yml` 不满足）。§3.4 的七项自写清单（OAuth 多租户绑定、KMS token、分布式刷新单飞、SSRF、配额熔断、cache key 含 user、prompt 注入）从"将来可能"变成"一期必做" |
| 9 | Skill 可退化成"纯 prompt 资产"，不需要资源目录物化 | 04 §4.3 | **翻转** | 前提是"业务工具里不该有 bash/read"。通用 runtime 若提供文件/shell 工具，skill 的 `scripts/` `reference/` 必须物化到会话工作区或虚拟 FS —— 文档明说"这部分四个 harness 零参考" |
| 10 | Skill 建议自研（运营资产、后台可改） | 04 §4.4 | **部分成立** | dsh provider seam 形状仍是最佳参考；但通用 runtime 的 skill 来源可能是用户上传/仓库目录，不只是运营后台。codex 的 token 预算截断策略仍应抄 |
| 11 | pi "无 MCP、无子 agent" 对本场景是好事 | 01 §4.7 | **翻转** | 变成缺口。选 pi 意味着 MCP / skills / plugins 三块全部自建 |
| 12 | pi 是技术首选（方案 A/B） | 01 §6 | **动摇** | pi 的干净嵌入、per-request `fetch`/`apiKey` 注入（BYOK 天然契合）、L3 durable 状态机仍是四家最优；但新 brief 要的扩展性它一样不给。dsh 的 "everything is a plugin" 在新 brief 下权重大幅上升 |
| 13 | dsh 的插件架构"值得当内核用，但现在是单机开发者工具形态" | 01 §2.6 | **成立，且天平向 dsh 倾斜** | `Context.isolate()` 是四家里唯一现成的进程内多租户隔离原语；`setFactory` 让 loop 可替换；但非生产就绪 / rc 版本 / npm tag 问题 / `$DSH_HOME` 25 处 / Cordis 学习曲线全部照付 |
| 14 | per-session 沙箱在任何链路都不成立（沙箱成本是模型 3–5 倍、并发上限不够、冷启吃光首字预算） | 04 §2、§6 | **前提失效，需重算** | 旧推导依赖"agent 无代码执行工具"。通用 runtime 若提供 shell/file 工具，沙箱不是可选项而是安全底线（opencode `x-opencode-directory` 越权 + RCE 是活例子）。成本算术仍有效，但结论从"不要沙箱"变成"必须决定 runner 到底给不给代码执行"（见 §5 开放问题） |
| 15 | 同步/异步共用一套内核、只换安全阀 | 04 §6 | **成立** | 通用 runtime 天然如此：安全阀（steps / wall clock / cost）作为 per-session/per-tenant 配置 |
| 16 | 首字 < 1.5 s 硬约束；opencode 1,877 ms 冷 import 出局 | 04 §2.3 | **待定** | 新 brief 未给首字目标。但常驻 runner 进程冷 import 只发生一次，不再是 per-turn 成本；opencode 的问题变成 RSS（150–250 MB/进程）而非冷启 |
| 17 | `HarnessAdapter` 抽象保留：可验证退路 + A/B 接缝 | 04 §6 | **成立且升级** | 新 brief 的 runner 就该以 adapter 边界封装 embedded agent；`native` / `dsh` / `pi` 三实现跑同一套测试 |
| 18 | 八条生产坑做成回归测试是最高 ROI 产出 | 04 §5、§7 | **成立** | 见 §3 |
| 19 | 流量模型：7.5M turn/天、峰值并发 17,500–69,500 | 04 §2、07 §2.3 | **失效，需重算** | 那是 5,000 万用户语音 App 的模型。20M DAU 通用 agent 的 turn/DAU、平均 turn 时长、工具调用密度都不同，所有依赖这些数字的账（沙箱、MCP 内存、进程数）要重新算 |
| 20 | BYOK 未讨论 | — | **新增维度** | 三份文档没有 BYOK 概念。可继承的相关事实：pi 的 per-request `apiKey`/`headers`/`fetch` 注入（01 §4.5）；dsh 的 `apiKeyEnv` 是环境变量语义（01 §2.4），per-user key 需要 per-request 覆盖入口；dsh SDK 的 `initialize` 握手钉死路由（07 §3.5）与 per-user 模型配置直接冲突；opencode `provider.ts:1846` 运行时 `Npm.add()` 装 provider 包在多租户下不可接受 |

---

## 3. 八条生产坑 + 复用边界分层（按新 brief 重述）

### 3.1 八条坑（文档 04 §5；文档 07 §6 已在旧 PoC 实现其中三条）

这八条是"别人用生产事故换来的清单"，与产品无关，通用 runtime 下每条都比旧产品更重要（因为多步循环、工具并发、模型切换、压缩全是常态）。

| # | 坑 | 出处（源码） | 新 brief 下的重要度 | 回归测试断言（04 §7 实验 B） |
|---|---|---|---|---|
| 1 | 合成 tool_result 的 id 必须稳定（`UUIDv5(固定命名空间, "fco:<原call id>")`），否则 prompt cache 归零；症状是"功能正确只是变贵"，DeepSeek 命中/未命中价差 50 倍 | codex `core/src/context_manager/normalize.rs:18-19, 136-145` | 高：BYOK 下用户自己付模型钱，cache 归零直接是用户成本投诉 | 缺 tool_result 历史两次归一化 → 合成 id 完全相同（sha256 前缀比对） |
| 2 | `finish_reason == max-tokens` 时丢弃**全部** tool call（不只最后一个），非法 JSON 保留原始字符串、空串 → `{}` | dsh `llm/src/assembler.ts:137-140`、`agent-loop/src/tool-calls.ts:104-111`；pi / opencode 都没有 | 极高：通用 runtime 有 shell/file 工具时截断的 arguments 是安全问题 | mock `finish_reason: "length"` + 半个 tool_call → 0 个执行 |
| 3 | 换模型前先用旧模型压缩（`comp_hash`），reasoning 的 providerMetadata 剥离、reasoning 降级为 text；缺失 hash 不触发 | codex `core/src/session/turn.rs:1262-1340`、`compact_model_fallback.rs:8-20`；opencode `session/message-v2.ts:245, 362-372` `differentModel` | 极高：BYOK + 多厂商意味着同一会话内换模型是常态 | 中途换模型 → providerMetadata 剥离、reasoning 降级 |
| 4 | 崩溃恢复三态 `TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN` + write-ahead 的 `tool/call` 日志（先 `appendToolCall` 再 `prepare`）；判断权交给模型但给明确规则 | dsh `core/session/src/repair.ts:14-18, 99-110`、`agent-loop/src/tool-calls.ts:165-170` | 极高：runner 有状态且要跨 pod 漂移，恢复语义是 router/runner 契约的一部分 | `tool/call` 落盘后 kill → 恢复后模型收到 `TOOL_OUTCOME_UNKNOWN` 指导语 |
| 5 | 读 provider 报告的"丢弃了 thinking block"（Anthropic `inputTransformations`）并告警，否则推理连续性静默消失 | opencode `session/processor.ts:439-452` | 中：国内厂商对应字段未知（开放问题） | mock 报告丢弃 → 告警指标 |
| 6 | 并发工具：dispatch 可乱序，commit 严格按模型顺序；工具执行可能改注册表 → barrier；`Promise.allSettled` 等全部 in-flight | dsh `agent-loop/src/tool-calls.ts:86, 146-161, 200-206, 232-236` | 极高：MCP 工具 + 插件工具并发是通用 runtime 常态 | 3 个并发工具第 3 个先完成 → 落库顺序 1,2,3 |
| 7 | 取消顺序：先让任务观察 cancellation 再清 pending approvals，否则历史里写成"用户拒绝"而非"用户中断"；"discard late proofs" | codex `core/src/tasks/mod.rs:531-534` | 高：外部客户端可随时断开 SSE / 取消 turn | pending approval 时取消 → 历史是"中断" |
| 8 | 两级压缩：便宜级只清 tool 输出内容、保留配对、迟滞（>20k 才动）、幂等单调、保护 skill 输出；工具配对算法从内容重算而非 step 标记；压缩是事务（surface 变了丢弃摘要、shrink 比较）；`cache.read + cache.write` 也算 context 占用；362 行运行时不变量检查器 | opencode `session/compaction.ts:273-308`、`session/overflow.ts:22-33`；dsh `compaction/src/tool-pairing.ts`（127 行）、`compaction-basic/src/region.ts:118-230`、`compaction/src/invariant.ts` | 极高：长会话 + 大工具输出 | 超长上下文含 cache.read → 触发压缩、切点配对平衡、摘要更短 |

附加一条（04 §5 附加）：opencode `SystemContext` 增量机制 —— skill 列表 / 工具列表 / MCP 工具目录中途变了，不改 system prompt，而在对话尾追加"XX 变了，此列表取代前一份"。新 brief 下 MCP server 热插拔、插件动态启用是高频事件，这条从"有价值"升为"必需"。约 300 行。

旧 PoC 已实现并有测试的三条（07 §6）：#2（`test/truncation.test.ts` 7 条，变异测试 6 条失败）、#4（`src/agent/repair.ts`，`test/repair.test.ts` 10 条）、#8 的工具配对部分（`src/context/tool-pairing.ts` 86 行，19 条测试）。**这三份实现是可迁移到新 runner 的资产**，无论 loop 选谁。

### 3.2 复用边界分层（旧：01 §0 最终建议 + 04 §6；新：按新 brief 重排）

旧版三层：第一层直接复用库（`pi-ai` 或 opencode `packages/llm`）；第二层移植设计不移植代码（dsh 日志投影不变量、opencode Context Epoch、codex app-server 协议）；第三层完全自写（租户/会话/存储、鉴权、并发所有权、业务工具）。旧版最后把复用面收缩到"remote MCP 客户端一个包"（04 §6）。

**新 brief 下的分层：**

**A. 直接作为库复用（版本 pin + adapter 层收敛升级冲击）**

| 候选 | 拿什么 | 依据 | 新 brief 相关的条件 |
|---|---|---|---|
| `pi-ai` | 统一 provider + 流式 + 28 个 compat 方言 + 分项计费；**per-request `apiKey` / `headers` / `fetch` 注入** | 01 §4.4、§4.5 | BYOK 天然契合；用 `createModels()` 实例化 API，禁 `/compat`，禁 `openai-codex` provider，禁 `cleanupSessionResources()` 无参调用；esbuild 只 import 需要的 `/providers/<x>` 子路径避开 AWS SDK |
| opencode `packages/llm` + `packages/schema` | 6 协议 / 11 provider / `cache-policy.ts`；5 个依赖 | 01 §1.2、§1.5 | 替代 `pi-ai` 的选项；代价是引入 `effect`（+57.9 MB RSS，01 §1.4） |
| dsh 内核（7 plugin / 20 包） | agent loop + 压缩 + 工具运行时 + `Context.isolate()` + 日志投影 | 01 §2.7；07 §1、§5.1 | 全 pin `@0.1.5-rc.2`；必须 `llm-pi-ai` 而非 `llm-deepseek`（遥测）；三个接缝（§4）必付；`$DSH_HOME` 25 处要换成 per-request 上下文 |
| `@deepseek-ai/dsh-mcp` | stdio + HTTP MCP client、outage-scoped 重连、`scrubbedParentEnv()`、工具命名空间/schema 清洗 | 04 §3.1、§3.5；07 §5.6 | 可单独引，不扛 Cordis 树。缺 OAuth、缺运行时动态注册 —— 这两块自写 |
| `pi-agent-core` L3 `AgentHarness` | durable operation 状态机 + `AgentLane.drive()` + `replay: "never"|"safe"` + 存储 conformance 套件 | 01 §4.3、§4.6 | 若选 pi 作 loop。Postgres `Storage`/`SessionRepo` 1,200–1,800 行跑官方 conformance |

**B. 移植设计、不移植代码**

- dsh "Model-visible means logged" + 从日志投影历史 + `systemPromptUpdate: 'in-history'`（01 §2.3）—— 与新 brief "历史入云存储、可迁移"直接对应：云存储里存的就是 append-only 日志，模型消息是投影。
- opencode Context Epoch + `SystemContext` 增量（01 §1.3；04 §5 附加）。
- codex `app-server-protocol`（01 §3.2）作为 runner 对外 HTTP/SSE 协议的规格书：`thread/*` / `turn/*` / `skills/*` / `mcpServer/*` 的请求面、`item/tool/call` 反向委派（外部客户端提供动态工具 —— 通用 runtime 的关键扩展点）、`turn/steer`、per-thread 覆盖（`model_provider` per-thread = BYOK 的协议形状）、`emitted_at_ms`、W3C trace、声明式串行化域（= 粘性路由 / 单写者的协议表达）。Apache-2.0 可直接复制类型定义。
- codex skill 的 token 预算截断（04 §4.1）、`SkillToolDependency`（skill 声明依赖的 MCP server）—— 通用 runtime 下 skill 与 MCP 的耦合是真实需求。
- dsh skill provider seam（`list()` 元数据 + `get(locator)` 正文，04 §4.2）。
- codex OAuth 的 RFC 9728 / 7591 / 9700 实现作为规格（04 §3.3）。
- opencode `pgrep -P` 孤儿进程清理（04 §3.1）—— 若允许 stdio MCP。
- codex `SandboxPolicy::ExternalSandbox` 语义（01 §3.4）—— 若 runner 跑在容器内。

**C. 完全自写（四家都不给，且新 brief 下比旧版多）**

旧版四块：租户/会话/存储、鉴权、并发所有权、业务工具。新版：

1. `agent-router`：JWT → tenant/user/session；session-id 一致性哈希 → runner；Redis 租约 + fencing token（01 §4.7 对策；07 §3.1）；SSE attach 与 turn 推进不在同一 pod 时的事件重放（`seq` + `?after=`，07 §5.3）。
2. `agent-runner` 内：per-request 租户上下文替代所有 HOME 单例；事件流按 tenant/session 过滤；agent 生命周期释放（dsh 内核有 `dispose()`，SDK wire 没有）；安全阀（steps / tool 数 / wall clock / cost）—— 四家里只有 opencode 有 step 限制、dsh 有 timeout，**没有一家有成本阀**（01 §5.2）。
3. 云存储层：实现 dsh `SessionPersistence` 或 pi `Storage`/`SessionRepo` 或自定义；先本地 DB（SQLite/Postgres）后可迁移。pi 的 conformance 套件是唯一现成验收工具。
4. MCP 多租户层（04 §3.3、§3.4，估 3,000–5,200 行生产代码 + 4,000–8,000 行测试）：per-user 动态注册、remote-first、OAuth redirect 落在自己域名且 `state` 编码 `(userId, serverId, nonce)`、KMS 信封加密 + 撤销级联、分布式刷新单飞、SSRF/内网 CIDR/DNS rebinding 防护、per-user 配额熔断、工具目录 cache key 含 user、第三方 tool description 的 prompt 注入防护。
5. Skill 多租户层（04 §4.4，1,800–3,200 行不含资源物化；若有 bash/read 工具再加 0–900 行资源物化）。
6. **Plugin 多租户层（文档完全未覆盖）**：dsh 插件是进程级 `cordis.yml` 静态配置；opencode 是运行时 `Npm.add()` + 动态 import（服务端 = 供应链 RCE）。"用户级插件"在多租户共享进程里如何加载、隔离、限资源，三份文档零参考。
7. **BYOK 层（文档完全未覆盖）**：用户模型密钥的存储（可类比 04 §3.4 第 2 条的 KMS 信封加密）、per-request 注入（pi 有入口、dsh 待验证、opencode 走全局 provider 配置）、per-user 出口代理/配额/熔断（pi per-request `fetch` 注入可承载）、遥测不外泄（dsh `llm-deepseek` 默认上报）。
8. 沙箱/权限层：若 runner 提供代码执行工具，需要容器级隔离 + `ExternalSandbox` 语义 + 审批超时默认拒绝（对照 opencode `permission/index.ts:32` 无超时的反例）。

---

## 4. dsh 库模式的三个接缝与遥测问题（文档 07 §3.4、§3.5、§5；文档 01 §2.4、§2.7）

### 4.1 接缝 A：持久化（"最脏的一块"，07 §5.2）

`packages/session/session-persistence/src/index.ts:135` 抽象类：

```ts
abstract class SessionPersistence extends Service {
  abstract create(header: SessionHeader, options?): Promise<SessionHandle>
  abstract open(id: SessionId, access: SessionAccess, options?): Promise<SessionHandle>
  abstract flush(): Promise<void>
  abstract stat(id: SessionId, options?): Promise<SessionPersistenceSnapshot | undefined>
  abstract list(options?): Promise<readonly SessionPersistenceSnapshot[]>
}
```

官方只有 `session-persistence-jsonl`（一 session 一本地文件）。要自写 Postgres/云存储实现，需处理：

- `SessionPersistenceRevision`（dsh 自己的乐观并发版本号）与你的单写者租约 + fencing token 是**两套并发控制**，建议租约是唯一权威、revision 退化为校验位。
- `SessionFormatUnsupportedError` / `SessionPersistenceCorruptionError` 要映射到你的 `turn.failed` reason 枚举。
- **两套 session 真相源要合成一套**：你的事件日志主键 `(session_id, seq)` append-only、SSE 是投影；dsh `SessionHandle` 有自己的读写模型。两者必须是同一份数据的两个视图，否则崩溃恢复不知信谁。
- `open('write')` 是进程级原子抢占单写者所有权（`index.ts:153`），跨 pod 无效。
- 文档 07 §5.5 的判断"接缝 A 成本高于它替掉的 300 行"**建立在 `maxSteps=2` 前提上**；新 brief 下被替掉的不是 300 行而是整个多步 loop + 压缩 + 恢复，这个核算要重做。

**与新 brief 的对应**："历史入云存储、本地 DB 先行可迁移" = 这个接缝必须一期就做，且 runner 的粘性/所有权语义要和 dsh 的 revision 打通。

### 4.2 接缝 B：事件桥（07 §5.3）

dsh 吐 `agent/assistant-stream` 等自有事件；runner 对外协议要带 `seq`（session 内单调）、脱敏、`?after=` 补齐语义。翻译层必须在 `emit` 之前发生：翻译失败 → turn 失败，而不是事件丢失（事件日志是真相，SSE 只是投影）。新 brief 下外部客户端多样，这个翻译层同时是协议稳定性边界。

### 4.3 接缝 C：模型路由（07 §3.5、§5.4）

SDK wire 原文：*"The server resolves the exact route during initialization and rejects `session/prompt` until that handshake succeeds."* → SDK 形态一个进程一个模型路由。库形态下 `LlmRuntime` 是自己 `ctx.plugin()` 挂的，**大概率**绕开，但文档明确标注：

> 我没有实测过「同一个 Context 内按 turn 切换模型路由」。`LlmRuntime` 的路由是 plugin 级配置，按 turn 切可能需要每个模型一棵 Cordis 子树（`ctx.isolate()`），也可能有现成的 per-request 覆盖入口。

**新 brief 下这条从"分层模型路由"升级为 BYOK 核心问题**：每个用户可能有不同的 baseURL + key + 模型名，如果只能靠 `ctx.isolate()` 每用户一棵子树，要测 N 万租户下的内存与泄漏；如果有 per-request 覆盖入口，接缝 C 基本消失。文档 07 §5.7 的半天最小实验（内存版 `SessionPersistence` + 7 plugin + 三条断言：事件桥行数、按 turn 切模型、外部 `AbortSignal` 能否传到 fetch）**尚未执行**。

### 4.4 遥测合规（01 §2.4；07 §3.4）

`llm-deepseek` 适配器默认：

- header `x-deepseek-harness-user-id`（`$DSH_HOME` 的匿名 UUID）、`x-deepseek-harness-session-id`
- body `dsh_plugin_packages`（**默认启用**，上报完整插件清单）
- body `dsh_session_log`（上报会话日志）默认关闭但代码在

规格见 `docs/deepseek-llm-api-wire-extensions.md`。旧对策是"必须用 `llm-pi-ai` 而非 `llm-deepseek`"。**新 brief 下问题更重**：BYOK 意味着请求用用户自己的 key 打到用户指定的端点，任何默认外发的标识/清单都是"平台替用户泄露平台内部信息"或"把用户 A 的插件清单发给用户 B 配置的端点"。除了换适配器，还要在出口层（pi 的 per-request `fetch` 或自建 HTTP 层）做 header 白名单审计。

### 4.5 其他库模式代价（07 §3.4 表）

Cordis 必读（`docs/cordis-primer.md`）；版本 pin 地狱（15+ 包手工对齐）；非生产就绪声明；`$DSH_HOME` 25 处；无成本阀；上游 PR #3977 跟版税。文档 07 §4.3 给出的"改口全用 dsh"四个条件：主链路 `maxSteps > 4`（**新 brief 已满足**）、团队 2 人以上愿意深入 Cordis、dsh 发到 1.0 撤掉非生产声明、npm 发布流程修好。后三条未满足。

---

## 5. 文档没有回答、但对新 brief 关键的开放问题

1. **runner 到底给不给代码执行工具（bash / write / edit）？** 这是所有下游决策的分岔点：沙箱要不要（04 §2 的成本算术）、skill 资源目录要不要物化（04 §4.3）、`x-opencode-directory` 类越权面要不要防、审批协议要不要。三份文档的前提是"不给"，新 brief 说"通用 harness 能力"但未明确。
2. **stdio MCP 是否允许？** 04 §3.1 算术（每会话 3 × 60 MB）说共享进程里不成立；但用户自带的 MCP server 大量是 `npx`/`uvx` stdio 形态。是只支持 remote MCP，还是给 stdio MCP 单独的 per-user 容器池（回到沙箱账）？
3. **dsh 库模式按 turn / 按用户切换模型路由是否可行**（07 §3.5、§5.4）—— BYOK 的前置条件，未实测。
4. **`Context.isolate()` 作为多租户原语的规模表现**：文档只说 preset 场景在用（01 §2.2），没有 N 万租户 / 每租户一棵子树的内存、GC、泄漏数据。
5. **pi 路线下 MCP / skills / plugins 的自建成本**：文档只估了 MCP 多租户层（3,000–5,200 行）和 skill 层（1,800–3,200 行），没有估 plugin 体系；也没有估在 pi 的三层 API 上做扩展点的成本。
6. **多租户共享进程内的 plugin 隔离模型**：dsh 静态 `cordis.yml`、opencode 运行时 `Npm.add()`，两种都不是"用户级插件"。用户插件是代码（要沙箱/worker 隔离）还是声明式配置（MCP + skill + prompt 的组合）？
7. **BYOK 密钥的存储与出口控制**：文档没有 BYOK。可类比 04 §3.4 的 OAuth token 管理（KMS 信封加密、撤销、审计），但 per-user 出口代理、SSRF（用户填任意 baseURL）、配额熔断都要重新设计。
8. **国内厂商是否报告 thinking block 丢弃**（04 §5 ⑤）：文档明说"未查到公开文档"。
9. **流量模型重算**：20M DAU 通用 agent 的 turn/DAU、turn 时长、工具密度、并发 session 数，决定 runner pod 数与内存预算。旧数字（7.5M turn/天、17,500–69,500 并发）不可用。
10. **首字延迟目标**：新 brief 未给。它决定 opencode 系（`effect` 重依赖）是否可接受、MCP 冷连接是否可阻塞（codex 1000 ms grace vs dsh 阻塞等待，04 §2.3）。
11. **opencode v2 `packages/core` 的进展**：01 §1.5 说它自陈 11 项未完成含多节点所有权与 durable status；一周后状态未知。若 v2 完成"durable multi-node ownership"，opencode 的评分会变。
12. **runner 对外协议的选型**：codex app-server 协议（JSON-RPC 风格）vs opencode serve 的 REST + SSE vs 自定义。文档只说"抄 codex 的设计"，没有评估外部客户端兼容性（新 brief 要求"任何外部客户端可调"）。
13. **审批/权限协议在无人值守场景的默认值**：opencode 默认 `ask` 无超时（01 §1.4）、codex Guardian 另开模型会话审批（01 §3.4）。通用 runtime 被外部程序调用时谁来回答审批，超时后默认拒绝还是默认放行，文档没有给出设计。
14. **文档 07 §5.7 的 `DshAdapter` 最小实验和 04 §7 的三个实验均未执行**，所有关于 dsh 库模式的结论仍是分析而非实证（除 import 开销）。

---

## 6. 给新方案的一句话摘要

产品无关的事实全部继承：codex 出局；四家都是 per-user 进程拓扑、多租户全部自写；形态 A 不可行、形态 B 可行；`pi-ai` / opencode `packages/llm` 是现成 provider 层；八条坑做成回归测试。**要翻转的是"不需要 harness"这个总结论及其下游**：新 brief 下多步 loop、MCP、skills、plugins 是刚需，dsh 的插件架构与 loop 质量从"用不上"变成"最有价值"，pi 的"无 MCP 无插件"从优点变缺口，沙箱与 skill 资源物化从"不需要"变成"取决于 runner 是否提供代码执行工具"，而这一条正是文档没回答、新方案第一个要拍板的问题。
