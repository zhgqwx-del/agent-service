# OpenClaw 与 Hermes Agent 源码级分析（面向 agent-runner 的可复用性评估）

> 仓库快照（本地 clone，未重新拉取）：
> - **openclaw**：`oss-refs/openclaw`，commit `91f0839d`（2026-09-22），TypeScript / Node ≥24.16，pnpm workspace，MIT（`LICENSE`，OpenClaw Foundation）。
> - **hermes-agent**：`oss-refs/hermes-agent`，commit `dcf7256`（2026-09-22），Python 3.11–3.13，MIT（`LICENSE`，Nous Research）。
>
> 两者都是 **"local-first 个人 agent + 多渠道消息网关"** 定位，不是多租户服务端。本文按 a–h 八个维度逐项实读，最后给出对 agent-runner（HTTP+SSE、MCP/skills/plugins、BYOK、20M+ DAU 分布式、无状态 agent-router 前置）的启发。所有引用给出路径与行号；docs 引用为项目自带文档（两者的 docs 都非常详尽，且与代码同步维护，是比源码更高效的入口）。
>
> 阅读方法：先读 `docs/`、`AGENTS.md`、architecture 文档，再只读关键源码（协议表、agent loop、session schema、provider 插件、hook 表）。两个仓库都极大（openclaw 883MB，hermes 292MB 含依赖），本文没有通读全部源码。

---

## 0. 一页结论

| 维度 | openclaw | hermes-agent | 对 agent-runner 的含义 |
|---|---|---|---|
| 定位 | 单机 Gateway 守护进程，"一个 Gateway = 一个信任域"，多租户靠 **每租户一个容器（fleet cell）** | 单机 Gateway + CLI，"一个 profile = 一套 HERMES_HOME"，multiplex 只隔离 profile，**明确不做终端用户鉴权** | 两者都没有解决我们的核心问题（一个进程服务多用户），但都给出了清晰的"为什么不做"的边界说明 |
| 客户端协议 | **WebSocket + 自定义 req/res/event 帧**，TypeBox schema，~460 个核心 RPC 方法，~60 种事件 | 三套：ACP(stdio JSON-RPC)、TUI JSON-RPC(stdio/WS)、**OpenAI 兼容 HTTP + `/v1/runs` SSE** | hermes 的 `/v1/runs` 家族（create / status / events SSE / approval / steer / stop + Idempotency-Key）是最接近 agent-runner 需求的现成设计 |
| session 键 | `agent:<agentId>:<scope...>`，主会话 `agent:main:main`；`dmScope` 决定按 peer/channel 隔离 | `agent:{namespace}:{platform}:{chat_type}:{chat_id}` | 两者都是"路由键"而非"授权键"（openclaw 文档原话：session ID selects routing, does not authorize） |
| 并发 | 每 session 一条 lane 串行 + 全局 lane 限流；durable `activeWriterRunId` 写栅栏；steer/followup/collect/interrupt 四种排队模式 | 同步 `AIAgent`，gateway 用 10 线程池跑 turn；SQLite `session_turn_leases` 租约串行化同一会话 | 两者的"每会话串行 + 写栅栏/租约"思路可直接搬到分布式（换成 Redis/DB 租约） |
| agent loop | `packages/agent-core`（8.2K 行，源自 pi-mono，MIT）+ `src/agents/embedded-agent-runner/`（碎成 100+ 文件） | `run_agent.py` facade + `agent/conversation_loop.py` + 30 个 `agent/turn_*.py` 阶段文件，**同步阻塞式** | openclaw 的 agent-core 事件模型干净可抄；hermes 的同步线程模型不适合 Node/asyncio 服务端，但阶段划分（preflight/overflow/truncation/recovery）是好清单 |
| 持久化 | 每 agent 一个 `openclaw-agent.sqlite`（`node:sqlite`），全局 `state/openclaw.sqlite`；session tree/branch/fork/rewind 全在库里 | 单 `state.db`（SQLite + FTS5），`sessions`/`messages` 两张主表 + 租约/压缩锁/委托表 | 两者都是本地 SQLite，不可插拔；agent-runner 需要自己的 store 接口，但 hermes 的 `sessions` 列设计（lineage、usage、cost、handoff）值得参考 |
| skills | `SKILL.md` + YAML frontmatter（Agent Skills 标准），7 级来源优先级，ClawHub 注册中心（`clawhub.ai/api/v1`） | 同格式；Skills Hub 聚合 **skills.sh + ClawHub + GitHub + 官方**，带 `skills_guard.py` 威胁扫描（~400 条正则） | 格式已事实标准化；hermes 的多源聚合 + 安装前扫描是可抄的运营设计 |
| plugins/hooks | 以 capability 注册为主（`api.registerProvider/Channel/...`），17 个 typed hook | `register_*` 20 余个 API + ~30 个 hook + **middleware**（可改写 LLM/tool 调用） | hook 命名可直接对齐（`before_tool_call`/`pre_tool_call`），hermes 的 middleware 是更适合服务端策略注入的抽象 |
| MCP | 客户端（stdio/SSE/streamable-http，含 OAuth）+ 服务端（`openclaw mcp serve` 暴露渠道会话） | 客户端（`tools/mcp_tool*.py` 21 个文件，trust 分级、OAuth、schema cache）+ `mcp_serve.py` 服务端 | 两者的 MCP 都是**进程级**连接池，hermes 文档自认"process-global, first profile wins"——多租户下必须改成每用户/每请求作用域 |
| 模型层 | `KnownApi` 9 种；国产模型全部以 **extension 插件**形式存在（deepseek/moonshot/kimi-coding/minimax/qwen/zai/qianfan/volcengine/stepfun/...），`api: "openai-completions"` | `ProviderProfile` 声明式 dataclass；`plugins/model-providers/` 含 deepseek/kimi-coding/minimax/qwen-oauth/stepfun/xiaomi/zai/alibaba | 两者都把 provider 收敛为"声明 + 少量 quirk 钩子"，且都覆盖了我们要的国产模型；hermes 的 `ProviderProfile` 更薄，最易移植 |
| failover | auth-profile 轮换 → 模型 fallback 链，turn-local 不改 session 选择 | credential pool 轮换 → `fallback_providers` 链 → auxiliary 独立链；带 rate-limit reset 时间的 bench | 三层结构一致，可直接采纳 |
| 沙箱 | 默认关；docker/podman/ssh/openshell/crabbox 五种后端；`mode: off/non-main/all`，`scope: agent/session/shared` | 7 种终端后端（local/docker/ssh/modal/daytona/singularity/vercel）；默认 local | 都是"Gateway 在宿主，只把工具执行推到沙箱"，与我们"runner 本身在容器里"不同 |
| 审批 | exec approvals：`deny/allowlist/ask/auto/full` + 会话 permission mode `read-only/guarded/workspace/full`，LLM reviewer | `tools/approval.py` 危险命令正则 + `once/session/always` + guardian LLM + yolo | 两者都是"人在回路"的单用户模型；agent-runner 只需 `pre_tool_call` 策略钩子 + 异步审批事件 |
| 多租户阻塞点 | `~/.openclaw` 状态目录锁、进程级插件注册表、全局 WS 鉴权 = operator 全权、node:sqlite 单文件 | `HERMES_HOME` ContextVar、`os.environ` 写入 33 处、MCP/工具注册表进程级、10 线程池 | 两者都是"一进程一信任域"，改造成本 > 重写核心 |
| 体量 | `src/` 非测试 TS **2.47M 行 / 12,112 文件**，测试 3.99M 行；65 个运行时依赖；171 个 extension | Python 非测试 **825K 行 / 2,117 文件**，测试 1.21M 行 / 4,949 文件；37 个核心依赖 + 46 个 extras | 都不可能整体嵌入；只能抽包（openclaw 的 `packages/*`）或抄设计（hermes） |

---

## 1. OpenClaw

### 1a. 进程/服务架构

**Gateway 守护进程。** 一台主机一个长驻 Gateway，拥有所有消息面（WhatsApp/Telegram/Slack/Discord/...），控制面客户端（macOS app、CLI、Web UI、自动化）和"节点"（iOS/Android/headless）都通过 **WebSocket** 连到 `127.0.0.1:18789`（`docs/concepts/architecture.md:10-25`）。

**线协议**（`docs/concepts/architecture.md:70-95`）：
- 文本帧 JSON；首帧必须是 `connect`（带设备身份、challenge 签名、role/scope）。
- 请求 `{type:"req", id, method, params}` → 响应 `{type:"res", id, ok, payload|error}`；服务端推送 `{type:"event", event, payload, seq?, stateVersion?}`。
- 副作用方法（`send`、`agent`）要求 **幂等键**，服务端短期去重缓存。
- 事件不重放，客户端断线后要自己刷新（"Events are not replayed. Clients must refresh on gaps"）。
- 协议由 TypeBox schema 定义，生成 JSON Schema 再生成 Swift 模型（`packages/gateway-protocol/src/schema.ts`）。

**方法与事件表。** 核心方法的权威表在 `src/gateway/methods/core-descriptors.ts`（710 行，**460 行方法记录**，每行 `[name, family, scope, since, policy]`），事件表在 `src/gateway/server-methods-list.ts:36-103`（~60 个事件：`agent`、`chat`、`session.*`、`sessions.changed`、`exec.approval.requested/resolved`、`question.requested`、`cron`、`task`、`node.*`、`device.pair.*`、`plugins.*`、`skills.changed` 等）。与 agent-runner 相关的方法族：

- agent 执行：`agent`、`agent.wait`、`agent.identity.get`
- 会话：`sessions.list/subscribe/messages.subscribe/create/send/abort/patch/reset/delete/compact/fork/rewind/branches.list/branches.switch/recover/search/usage/...`
- 聊天：`chat.send/history/abort/inject/message.get/metadata`
- 模型：`models.list/probe/authStatus/authLogin/authSetApiKey/authOrderSet`
- 工具/MCP：`tools.catalog/effective/invoke`、`mcp.app.listTools/callTool/readResource/...`、`mcp.authLogin`
- skills：`skills.status/search/detail/install/update/library.*/proposals.*/curator.*`（skills 相关方法 30+ 个）
- plugins：`plugins.list/search/install/setEnabled/uninstall/reload/inspect/catalog.*`
- cron：`cron.get/list/add/update/remove/run/runs/status`
- 审批：`exec.approval.request/waitDecision/resolve/grants.*`、`approval.get/resolve/history`
- 多 agent：`agents.list/create/update/delete/files.*/workspace.*`

每个方法带 operator scope（`operator.admin/write/read/approvals/pairing`，`docs/gateway/operator-scopes.md`），这是它唯一的授权维度。

**agent 运行序列**（`docs/concepts/agent-loop.md` "Run sequence"）：`agent` RPC 校验参数、按 `sessionKey`/`sessionId` 解析会话、写 session 元数据、**立即返回 `{runId, acceptedAt}`**；`agentCommand` 解析模型/thinking、加载 skills snapshot、调用 `runEmbeddedAgent`；`subscribeEmbeddedAgentSession` 把运行时事件桥接到 `agent` 事件流的三个 stream：`lifecycle`（`start|finishing|end|error`）、`assistant`（delta）、`tool`（start/update/end）；`agent.wait` 等 lifecycle end/error 返回 `{status: ok|error|timeout}`（默认 30s，不取消运行）。

**Session 键与隔离。** 单 agent 模式主会话键 `agent:main:main`（`docs/concepts/multi-agent.md` "Single-agent mode"）。DM 隔离由 `session.dmScope` 决定：`main`（所有 DM 共享一个会话，默认）/ `per-peer` / `per-channel-peer` / `per-account-channel-peer`（`docs/concepts/session.md:57-64`）。文档警告：不开隔离时"Alice's private messages would be visible to Bob"。

**并发模型**（`docs/concepts/queue.md`）：
- lane-aware FIFO：每个 session key 一条 `session:<key>` lane（并发 1），再进全局 `main` lane（默认并发 `max(8, CPU*4)`），`subagent` lane 默认 8；`agents.defaults.maxConcurrent` 封顶。
- 运行中收到新消息的四种模式：`steer`（注入当前运行，默认）/ `followup`（排队下一轮）/ `collect`（静默窗口合并）/ `interrupt`（中止并跑最新）；500ms debounce，`cap: 20`，超出 `drop: "summarize"`。
- **写栅栏**：被接纳的 run 先记录 durable `activeWriterRunId`，每次 transcript 追加/重写都带 `expectedWriterRunId`，提交事务里校验，被取代的 run 无法提交陈旧数据（`docs/concepts/agent-loop.md` "Queueing and concurrency"）。另外有状态目录锁防止两个 Gateway 进程共用同一状态目录。

**多用户 / 多 agent / 多账户，做到什么程度：**
- **多 agent**（`docs/concepts/multi-agent.md`）：一个 Gateway 进程里跑多个隔离 agent，每个 agent = 自己的 workspace + `agentDir`（`~/.openclaw/agents/<id>/agent/`）+ 自己的 `openclaw-agent.sqlite`（会话 + auth profile + 模型注册表）；**binding** 把渠道账号（某个 Slack workspace、某个 WhatsApp 号）路由到某个 agent。这是"多人格/多号"，不是"多用户"。
- **多用户模式**（`docs/concepts/multi-user.md`）：多位**受信任的**操作员共用一个 agent，提供 creator/owner/participants 三层归属、presence、owner 过滤、会话可见性（Shared/Read-only/Suggest/Draft）、personal model accounts（每人自己的 provider 凭证，存在 `state/openclaw.sqlite` 的身份作用域记录里，`users.linkAuthProfile`）。文档明确："Session ownership, visibility ... are **usability features, not security boundaries**. If people must not access each other's sessions, tools, credentials, or files, give them separate agents or separate gateway/host trust boundaries."
- **多租户**（`docs/gateway/multi-tenant-hosting.md`）：默认安全模型是 "one trusted operator boundary per Gateway, not hostile multi-tenant isolation inside one shared Gateway"。`openclaw fleet` 为每个租户起一个 **cell**（完整 Gateway 容器，独立 state、凭证、workspace、token、loopback 端口、独立 bridge 网络）。"An authenticated operator inside one Gateway has a trusted control-plane role. **Session IDs select routing; they do not authorize one tenant against another.**" Fleet 明确不提供：共享 ingress router、精简的 per-tenant 进程、远程 cell 宿主、租户自助/计费面。
- **OpenAI 兼容 HTTP**（`docs/gateway/openai-http-api.md`）：`/v1/chat/completions`、`/v1/models`、`/v1/embeddings`、`/v1/responses`，默认关闭；文档要求"Treat this endpoint as **full operator access** to the gateway instance ... Keep it on loopback/tailnet/private ingress only"。

### 1b. Agent loop

**代码位置**（`docs/agent-runtime-architecture.md` "Runtime Layout"）：
- `packages/agent-core/`（`@openclaw/agent-core`，非测试 **8,210 行**）：可复用 agent 核心——`agent-loop.ts`（1,604 行）、`agent.ts`（759）、`agent-stream-response.ts`（410）、`harness/compaction/compaction.ts`（1,050）、`harness/session/tool-result-pairing.ts`（427）、`stream-steering.ts`、`turn-interruption.ts`。`THIRD_PARTY_NOTICES.md:7-15` 说明它源自 Mario Zechner 的 **pi-mono**（MIT）；类型与 pi-agent-core 几乎同构。
- `src/agents/embedded-agent-runner/`：OpenClaw 自己的 attempt loop，碎成 `run/attempt-*.ts` 几十个文件（`attempt-prompt-build`、`attempt-history-prepare`、`attempt-exec-approval-continuation`、`attempt-sessions-yield`、`attempt-settle`...），`compact*.ts` 十几个文件，`model.*.ts` 十几个文件。
- `src/agents/agent-hooks/`：compaction safeguard、compaction instructions、context pruning。
- `src/llm/` + `packages/ai/`（33.9K 行）：provider transport；`packages/ai/src/transports/openai-completions-stream.ts`（731 行）是 OpenAI 兼容流式实现。

**核心类型**（`packages/agent-core/src/types.ts`）：
- `ToolExecutionMode = "sequential" | "parallel"`（:35），`QueueMode = "all" | "one-at-a-time"`（:43）。
- `AgentLoopConfig`（:214）：`model`、`thinkingLevel`、`convertToLlm(messages)`（AgentMessage → LLM Message 的转换，契约"must not throw"）、`transformContext`（LLM 调用前的上下文裁剪/注入）、`getSteeringMessages`、`toolExecution`、各类 hook。
- `AgentContext`（:598）：`systemPrompt`、`messages`、`tools`。
- **`AgentEvent`**（:614-653）：`agent_start` / `agent_end{messages}` / `turn_start` / `turn_end{message,toolResults}` / `message_start` / `message_update{assistantMessageEvent}` / `message_end` / `tool_execution_start{toolCallId,toolName,args}` / `tool_execution_update{partialResult}` / `tool_execution_end{result,isError,executionStarted?,errorKind?}`。这就是 pi 的事件模型。
- 自定义消息角色（:412-494）：`bashExecution`、`custom`、`branchSummary`、`compactionSummary`——压缩摘要作为一等消息类型进 transcript。

**工具调用**：`agent-loop.ts:506-522`——若 `config.toolExecution !== "sequential"` 且没有任何工具自带 `executionMode: "sequential"`，则整批并行；否则串行。steering 消息在每个检查点（工具批次前/后、串行调用之间）被拉取（:157, :419, :574-605），串行模式下未启动的调用会被跳过并标 `STEERING_TOOL_SKIP_MESSAGE`。工具参数用 TypeBox 校验（`validation.ts`），失败标 `errorKind: "argument-validation"`。还有 tool-loop 检测（`ToolLoopIntervention{kind:"critical-tool-loop"}`, `ToolLoopWarning`）。

**压缩/上下文**（`docs/concepts/compaction.md`）：自动压缩默认开（新配置默认 `compaction.mode: "safeguard"`，带摘要质量审计）；触发条件是接近上下文上限**或** provider 返回 overflow 错误（匹配几十种 provider 特定错误串，然后压缩重试）；压缩边界不切开 tool call/result 对；CJK 字符计入 chunk 估算；完整历史留在磁盘，压缩只改变模型下一轮看到的内容；压缩前提醒 agent 先把重要笔记写进 memory 文件；请求在工具调用完成后被拒时，可"compact and continue from recorded results"，不重放已完成动作。另有 `src/context-engine/` 可插拔 context engine（`docs/concepts/context-engine.md`）。

**限制与中止**（`docs/concepts/agent-loop.md` "Timeouts"）：`agents.defaults.timeoutSeconds` 默认 **172800s（48h）**；模型 idle 超时 cloud 120s / self-hosted 300s；`models.providers.<id>.timeoutSeconds` 覆盖 provider HTTP 超时；`agent.wait` 30s 只是等待超时。审批等待会暂停执行预算。结束路径：agent timeout、AbortSignal、Gateway 断连/RPC 超时。运行中出现 2 分钟无进展则诊断为 `session.long_running` / `session.stalled` / `session.stuck`，超过阈值（≥5min 且 ≥3× 警告阈值）才 abort-drain。

**流式事件**：Gateway 层把 agent-core 事件投影为 `agent` 事件的 `lifecycle` / `assistant` / `tool` 三个 stream，chat 层再合成 `delta` / `final` / `error` / `aborted`（`docs/concepts/agent-loop.md` "Chat channel handling"）。

### 1c. Session 持久化

- **位置**（`docs/openclaw-agent-runtime.md` "Clean slate reset" 表）：`~/.openclaw`（或 `$OPENCLAW_STATE_DIR`）下：`openclaw.json` 配置；`state/openclaw.sqlite` 共享状态库；`agents/<agentId>/agent/openclaw-agent.sqlite` 每 agent 的会话 + auth profile；`workspace/` 默认工作区。
- **驱动**：`node:sqlite` 的 `DatabaseSync`（`src/state/agent-provenance.kernel.ts:1`），schema 版本化（`package.json:4-8` `schemaVersions: {state: 17, agent: 23}`），迁移在 `src/state/openclaw-agent-db-*.ts`（`session_conversations`、`session_nodes`、`session_windows`、`transcript_events`、`session_members`、`board_widgets`...）。
- **模型**：会话是树（`session_nodes`），支持 `sessions.branches.list/switch`、`sessions.rewind`、`sessions.fork`、checkpoint 恢复；有 `session_state_events` 信号日志 + watcher cursor 供父子 agent 感知变化（`docs/concepts/session-state.md`）。
- **可插拔性**：无。SQLite 文件是硬编码的（外加 legacy JSONL 迁移源）。`session.store` 配置只是换物理文件路径。
- **恢复语义**：按 `sessionKey` 解析到当前 `sessionId`；`/new`/`/reset` 开新会话；`sessions.recover` 处理 Gateway 重启后的活跃 run（`docs/gateway/restart-recovery.md`）。

### 1d. 扩展性

**Skills**（`docs/tools/skills.md`）：目录 + `SKILL.md`，YAML frontmatter `name/description/metadata.openclaw.{emoji,requires.bins,install[],os}`（例 `skills/github/SKILL.md:1-22`）。7 级加载优先级：`<workspace>/skills` > `<workspace>/.agents/skills` > `~/.agents/skills` > `<state-dir>/skills` > workshop skills > bundled > `extraDirs`+plugin skills；按 env/config/二进制存在性过滤；grouped layout 最多 6 层深；per-agent allowlist（`agents.entries.*.skills`）。仓库自带 77 个 skill 文件（`skills/`）。**ClawHub**：`src/skills/lifecycle/clawhub*.ts`，API 基址 `https://clawhub.ai/api/v1`（源码内 190 处引用），`openclaw skills search/verify/install/update`，安装前 `verify` + `security.installPolicy` + `before_install` hook + `skills.securityVerdicts`；还有 "Skill Workshop"（agent 起草 skill 提案，人审批，`skills.proposals.*` 十几个方法）。

**Plugins**（`docs/plugins/architecture.md`）：manifest `openclaw.plugin.json` + `package.json` 的 `openclaw` 字段（`extensions/skills/prompts/themes` 资源清单）；在进程内加载、注册进中央 registry。**Capability 注册**：`registerProvider`（文本推理）、`registerCliBackend`、`registerEmbeddingProvider`、`registerSpeechProvider`、`registerRealtimeTranscriptionProvider`、`registerRealtimeVoiceProvider`、`registerMediaUnderstandingProvider`、`registerTranscriptSourceProvider`、`registerImage/Music/VideoGenerationProvider`、`registerWebFetchProvider`、`registerWebSearchProvider`、`registerChannel`、`registerGatewayDiscoveryService`、`registerMigrationProvider`。仓库有 **171 个 extension**（渠道、provider、memory、sandbox、观测...）。

**Hook 点**（`docs/concepts/agent-loop.md` "Plugin hooks" 表）：`before_model_resolve`、`before_prompt_build`（可注入 `prependContext/systemPrompt/appendSystemContext`，可用 `toolsAllow` 收窄工具面）、`before_agent_reply`（可接管本轮返回合成回复）、`agent_end`、`before_compaction`/`after_compaction`（只观察）、`before_tool_call`/`after_tool_call`（`{block:true}` 终止）、`before_install`、`tool_result_persist`（同步改写落库的工具结果）、`message_received/sending/sent`（`{cancel:true}`）、`session_start/end`、`gateway_start/stop`。另有 Gateway 内部 `HOOK.md` 脚本 hook（`agent:bootstrap`、`command:new/reset/stop`）。

**MCP**：客户端 `mcp.servers` 配置，transport `streamable-http` / `sse` / `stdio`，含 headers、OAuth（`mcp.authLogin`）、TLS、超时、并行工具提示、include/exclude 过滤，session 级 server/tool 拒绝（`docs/tools/mcp.md`）；热重载时"unchanged servers keep their connections and cached tools"。服务端：`openclaw mcp serve` 把渠道会话暴露为 MCP 工具（`src/mcp/channel-server.ts`、`tools-stdio-server.ts`）。`src/mcp/` 非测试仅 2,258 行——MCP 是薄层，大头在 `@modelcontextprotocol/sdk`。

**自定义工具**：`src/agents/agent-tools*.ts` 定义 + 插件 `registerTool`；`tools.invoke` RPC / `docs/gateway/tools-invoke-http-api.md` 可直接调单个工具。**Agents/personas**：`agents.entries.<id>`（workspace、agentDir、model、skills、sandbox、bindings），workspace 内 `AGENTS.md/SOUL.md/USER.md`。**Cron**（`docs/automation/cron-jobs.md`）：Gateway 内置调度器，`src/cron/` 40K 行，one-shot/cron 表达式，`--session main` 注入系统事件或隔离会话，投递到渠道/webhook；`cron.*` RPC。**Memory**（`docs/concepts/memory.md`）：workspace 内 Markdown 文件 `USER.md`、`MEMORY.md`、`memory/YYYY-MM-DD.md`、`DREAMS.md`；`memory.search` RPC；memory-core / memory-lancedb / memory-wiki / active-memory / honcho 等插件。

### 1e. 模型/provider 层

- **API 族**（`packages/llm-core/src/types.ts:17-26`）：`openai-completions`、`mistral-conversations`、`openai-responses`、`azure-openai-responses`、`openai-chatgpt-responses`、`anthropic-messages`、`bedrock-converse-stream`、`google-generative-ai`、`google-vertex`；`Api = KnownApi | string` 允许自定义。
- **国产模型**全部是 `extensions/` 下的 provider 插件：`deepseek`、`moonshot`、`kimi-coding`、`minimax`、`qwen`、`alibaba`、`zai`（智谱）、`qianfan`、`volcengine`、`stepfun`、`xiaomi`、`tencent`、`byteplus`、`longcat`、`gmi`、`novita` 等。以 `extensions/deepseek/` 为例：`index.ts` 用 `defineSingleProviderPluginEntry({ id, provider: { catalog, matchesContextOverflowError, wrapStreamFn(thinking 包装), resolveThinkingProfile, resolveUsageAuth, fetchUsageSnapshot, ...buildProviderReplayFamilyHooks({family:"openai-compatible"}), ...buildProviderToolCompatFamilyHooks("deepseek") } })`；`provider-catalog.ts:5-11` 返回 `{ baseUrl, api: "openai-completions", models }`。即：**一个国产 provider ≈ 一个 catalog + 几个 quirk 钩子**。
- **BYOK / 配置形状**（`docs/concepts/model-providers/custom-providers.md`）：`models.providers.<id> = { baseUrl, apiKey: "${MOONSHOT_API_KEY}", api: "openai-completions", models: [{id, name, input?, compat?}] }`，`agents.defaults.model.primary = "moonshot/kimi-k3"`，`fallbacks: [...]`。凭证存 per-agent sqlite 的 auth profile store（OAuth + API key，多 profile 轮换）；多用户模式下有 personal model accounts（见 1a）。
- **每 agent 路由**：`agents.entries.<id>.model`；per-purpose model slots（`docs/gateway/config-agents/models.md`）；插件 harness 按 provider 路由选择（`agentRuntime.id`，`docs/agent-runtime-architecture.md` "Runtime Selection"）。
- **Failover**（`docs/concepts/model-failover.md`）：先在当前 provider 内做 bounded 同模型重试（保留部分输出），再 **auth-profile 轮换 + 冷却**，再 **模型 fallback 链**；fallback 是 turn-local，不改 session 选择；诊断记录 `model_fallback_chain_stopped` 原因。thinking 参数不支持时会去掉 thinking 重试。
- 辅助包：`packages/tool-call-repair`（3.7K 行）修复模型以纯文本输出的 tool call（对国产模型很有用）；`packages/retry`（360 行）。

### 1f. 沙箱/安全

- **沙箱**（`docs/gateway/sandboxing/modes-scope-and-backend.md`）：默认 **off**；`mode: off | non-main | all`，`scope: agent | session | shared`，`backend: docker | podman | ssh | openshell | crabbox`。"The Gateway process always stays on the host; only tool execution moves into the sandbox." 命名 operator role 可强制 `sandbox: "required"`。文档自评 "not a perfect security boundary"。
- **审批**：exec approvals（`docs/tools/exec-approvals.md`）`deny / allowlist / ask / auto / full` + 可执行文件 real-path/hash 绑定；会话 **permission mode**（`docs/gateway/permission-modes.md`）`read-only / guarded / workspace / full`，`workspace` 模式用 LLM reviewer 决定 allow/deny/ask；`exec.approval.*` 事件 + RPC 走异步人审。`full` 需要 `operator.admin`。
- **鉴权**：Gateway `auth.mode: token | password | none | trusted-proxy`，设备配对 + challenge 签名（`docs/gateway/protocol/auth.md`）；operator scopes；审计账本（`docs/gateway/audit.md`，只记元数据）。

### 1g. 多租户阻塞点

1. **信任模型**：一个 Gateway 一个 operator 信任域；WS token = 全权；HTTP `/v1/chat/completions` 同样是 full operator access。没有"请求级用户身份 → 会话授权"的层。
2. **HOME/状态目录耦合**：`src/config/state-dir.ts:12-30` 用 `os.homedir()` 推导 `~/.openclaw`；每 agent 一个 sqlite 文件 + 状态目录进程锁（`src/infra/gateway-lock.ts`）；workspace 是文件系统目录（skills、memory、bootstrap 文件都从里面读）。
3. **进程级单例**：插件 registry、渠道 registry、模型 catalog、MCP 连接池都是进程级（`src/plugins/` 152K 行，`listLoadedChannelPlugins()` 等）；`src/global-state.ts` 全局 CLI flag。
4. **子进程**：exec 工具、CLI backend（codex/claude CLI）、沙箱 docker CLI、node-pty、playwright——都是宿主进程 spawn。
5. **规模**：`src/` 非测试 2.47M 行、`src/gateway` 420K 行、`src/agents` 495K 行，文件按功能碎片化到极致（`server-methods/` 369 个非测试文件、`embedded-agent-runner/run/` 上百个 `attempt-*.ts`）。可读性靠 docs 而不是代码。

### 1h. 体量与许可

- **License**：MIT（`LICENSE`）；`THIRD_PARTY_NOTICES.md` 声明 agent core 改编自 pi-mono（MIT，Mario Zechner），并依赖 `@earendil-works/pi-tui`。
- **行数**（`find | xargs cat | wc -l`，排除 node_modules/dist，`.ts/.tsx/.js/.mjs/.swift/.kt/.rs/.md`）：

| 目录 | 行数 | 备注 |
|---|---|---|
| `src/` | 6.46M（非测试 TS 2.47M / 12,112 文件；`*.test.ts` 3.99M） | gateway 420K、agents 495K、plugins 153K、cron 40K、skills 33K、sessions 11K、llm 3.5K、mcp 2.3K（均非测试） |
| `packages/` | 237K | agent-core 8.2K、llm-core 1.9K、ai 33.9K、tool-call-repair 3.7K、retry 0.4K（非测试） |
| `extensions/` | 2.82M（含测试） | 171 个插件目录 |
| `apps/` | 740K | macOS/iOS/Android |
| `ui/` | 1.21M | Web Control UI |
| `docs/` | 314K | 1,415 文件 |
| `test/` | 670K；`scripts/` 209K；`crates/` 16.6K（Rust） | |

- **依赖**：`package.json` 运行时依赖 **65** 个（`@anthropic-ai/sdk`、`openai`、`@google/genai`、`@mistralai/mistralai`、`@modelcontextprotocol/sdk`、`@agentclientprotocol/sdk`、`express`、`ws`、`kysely`、`typebox`、`zod`、`grammy`、`playwright-core`、`@lydell/node-pty`、`koffi`...），devDeps 63；Node `>=24.16.0 <25 || >=26.1.0`；pnpm 12。

---

## 2. Hermes Agent

### 2a. 进程/服务架构

**入口**（`website/docs/developer-guide/architecture.md` "System Overview"）：CLI（`cli.py`）、Gateway（`gateway/run.py`）、ACP（`acp_adapter/`）、Batch Runner、API Server、Python Library——全部驱动同一个 `AIAgent`（`run_agent.py`）。设计原则表："Platform-agnostic core: One AIAgent class serves CLI, gateway, ACP, batch, and API server."

**三套外部协议**（`website/docs/developer-guide/programmatic-integration.md`）：

1. **ACP**（stdio JSON-RPC）：IDE 用。
2. **TUI gateway JSON-RPC**（`tui_gateway/server.py`，stdio 或 WS）：方法目录（:41-60）`prompt.submit / prompt.background / session.steer / session.create / session.list / session.active_list / session.activate / session.close / session.interrupt / session.history / session.compress / session.branch / session.title / session.usage / session.status / clarify.lock / config.get|set / commands.catalog / client.capabilities / gateway.capabilities / command.resolve / command.dispatch / reload.mcp / process.stop / delegation.status / subagent.interrupt|steer / spawn_tree.* / image.attach`。事件（:83）：`message.delta / message.complete / tool.start / tool.generating / tool.complete / gateway.ready / request.cancel` + 会话生命周期。**服务端→客户端请求**（:87-100）：`approval`、`clarify`、`sudo`、`secret`、`vault.*`、`connection` 是带 id 的 JSON-RPC 请求，客户端用同 id 响应；客户端需先 `client.capabilities{server_requests:true}` 声明。`session.resume` 结果带 `inflight`（未落库的进行中 turn）和 `open_requests`，供断线重连重建 UI（:102）。另有 **Pi-style RPC 映射表**（:106-124）：`prompt/steer/follow_up/abort/set_model/compact/get_state/get_messages/switch_session/fork/ui_request` 一一对应。
3. **OpenAI 兼容 API Server**（`gateway/platforms/api_server.py` + 6 个 sibling，共 7,383 行；`aiohttp`）：端点（:126-155）`POST /v1/chat/completions`（SSE）、`POST /v1/responses`（stateful，`previous_response_id`）、**`POST /v1/runs` → 202 `{run_id}`、`GET /v1/runs/{id}`、`GET /v1/runs/{id}/events`（SSE）、`POST /v1/runs/{id}/approval`、`POST /v1/runs/{id}/steer`、`POST /v1/runs/{id}/stop`**、`GET /v1/capabilities`、`GET /v1/models`、`/api/jobs/*`（cron）、`/api/sessions/*`、`/health`。Header：`X-Hermes-Session-Id`（transcript 作用域，`/new` 时轮换）、`X-Hermes-Session-Key`（长期记忆作用域，格式如 `agent:main:webui:dm:user-42`，`api_server.py:75-76, 1684-1696`）、`Idempotency-Key`（`api_server_run_idempotency.py`，durable 预留，重启后仍可重放，返回 `Idempotency-Replayed: true`）。run 事件（`api_server_runs.py`）：`run.queued/started/completed/failed/cancelled/interrupted/steered/stopping`、`message.delta`、`message.interim`、`tool.started/completed`（带 `preview` 截断 500 字符 + 秘密脱敏）、`approval.request/responded`、`subagent.start/complete`。未消费的事件缓冲 5 分钟过期；gateway 关闭时活跃 run 持久化为 `interrupted`。

**Session 键**（`gateway-internals.md` "Session Key Format"）：`agent:{namespace}:{platform}:{chat_type}:{chat_id}`，namespace 是 `main` 或 multiplex 下的 profile 名（`gateway/session.py::build_session_key`，文档强调"Never construct session keys manually"）。`gateway/session_identity.py::resolve_identity` 每个入站事件**先**规范化出一个冻结的 `RoutingIdentity`（哪个 bot 收到 / 谁可接纳 / 在哪个 profile 运行），再派生键（`gateway/AGENTS.md` "Profile scope"）。

**并发**：`AIAgent` 是**同步阻塞**的（`agent-loop.md` "The synchronous orchestration engine"）；gateway 是 asyncio 事件循环 + `ThreadPoolExecutor(max_workers=10)` 跑 turn（`gateway/run.py:60 _TURN_MAX_WORKERS = 10`，`:62` housekeeping 4）。同一会话的串行化靠两层守卫（`gateway-internals.md` "Two-Level Message Guard"：base adapter 的 `_active_sessions` 排队 + runner 的 `_running_agents` 拦截）和 SQLite **`session_turn_leases(conversation_id PK, holder, acquired_at, expires_at)`**（`hermes_state_common.py:524-529`）；API server 文档："Session turn leases serialize concurrent writers and refresh the transcript after a contended wait." 运行中的新消息按 `display.busy_input_mode` steer/redirect/queue；`/stop`、`/approve` 等 bypass 两层守卫内联分发。gateway 缓存 `AIAgent` 实例（`gateway/run_agent_cache.py`，TTL/LRU 驱逐时先 flush memory）。

**多用户 / 多账户，做到什么程度：**
- **Profile**：`hermes -p <name>` → 独立 `HERMES_HOME`（`<root>/profiles/<name>/`）、config、memory、state.db、gateway PID；"Profiles are independent islands on purpose"（`AGENTS.md:104-115`）。
- **Multiplexing**（`website/docs/developer-guide/multiplexing-gateway.md`）：一个 gateway 进程服务所有 profile（默认开），用 ContextVar 的 `HERMES_HOME` override（`hermes_constants.py:18`）+ `agent/secret_scope.py` 做每 profile 作用域。"Known limitations" 表（:301-312）列出仍是进程级的：MCP 发现与工具注册（"first profile to build an agent wins"）、终端/沙箱 env、内置工具 registry、provider/capability registries、HTTP listener/进程锁。**Non-goals**（:314-320）："Multiplexing isolates *profiles*; it does not authenticate or authorize *end users*. A profile is a configuration, not a person."
- **渠道授权**（`gateway-internals.md` "Authorization"）：allow-all flag → 平台 allowlist → DM pairing 码 → 全局 allow-all → 默认拒绝。这是"谁能跟 bot 说话"，不是数据隔离。
- API server 用单个 `API_SERVER_KEY` Bearer 鉴权；多用户前端（Open WebUI）靠 `X-Hermes-Session-Key` 区分记忆作用域（`api-server.md:650-660`），信任完全在前端。

### 2b. Agent loop

**代码**：`run_agent.py`（1,609 行 facade）→ `agent/conversation_loop.py`（1,745 行，`run_conversation()` 主体）+ **30 个 `agent/turn_*.py` 阶段文件**（`turn_iteration_prep / turn_preflight / turn_preflight_gate / turn_request_assembly / turn_api_request / turn_api_call / turn_api_error / turn_response_intake / turn_response_check / turn_tool_round / turn_tool_validation / turn_overflow / turn_truncation / turn_context_compaction / turn_recovery / turn_recovery_autorecover / turn_retry_state / turn_stop_gates / turn_empty_response / turn_final_response / turn_finalizer / turn_usage / turn_liveness / turn_facade_lease ...`）+ `agent/tool_executor.py` + `model_tools.py`（987 行，`handle_function_call()`）+ `tools/registry.py`（1,012 行）。

**三种 API 模式**（`agent-loop.md` "API Modes"）：`chat_completions`（默认，`openai.OpenAI`）、`codex_responses`、`anthropic_messages`（经 `anthropic_adapter.py` 转换）。解析顺序：显式 `api_mode` → provider 检测 → base URL 启发式 → 默认 chat_completions。**内部消息格式统一为 OpenAI 风格 dict**（`role/content/tool_calls`，reasoning 存 `assistant_msg["reasoning"]`），严格角色交替（"Never two assistant messages in a row ... Only `tool` role can have consecutive entries"）。

**Turn 生命周期**（"Turn Lifecycle"）：生成 task_id → 追加 user → 构建/复用缓存 system prompt → preflight 压缩检查（>50% 上下文）→ 组装 API messages（按模式转换）→ 注入 ephemeral 层（预算警告、上下文压力）→ Anthropic cache 标记 → **`_interruptible_api_call`**（HTTP 在后台线程，主线程等 response/interrupt/timeout，中断时丢弃线程结果，不注入部分响应）→ 解析：有 tool_calls 则执行并循环，否则落库、flush memory、返回。

**工具执行**：单个调用直接在主线程；多个调用用 `ThreadPoolExecutor`，`agent/tool_executor.py:124 _MAX_TOOL_WORKERS = 8`；交互式工具（`clarify`）强制串行；结果按原始顺序回填。流程：registry 解析 → `pre_tool_call` hook → 危险命令检查（`tools/approval.py`）→ 执行 → `post_tool_call` → 追加 tool 消息。`todo/memory/session_search/delegate_task` 四个"agent 级工具"在 `tool_executor.py` 被拦截，直接改 agent 状态（`model_tools.py:607 _AGENT_LOOP_TOOLS`）。registry 里 `register()` 调用 59 处（`tools/*.py`），`toolsets.py` 定义 60 个 toolset；每个平台 adapter 选一个基础 toolset。

**回调面**（"Callback Surfaces"）：`tool_progress_callback / thinking_callback / reasoning_callback / clarify_callback / step_callback / stream_delta_callback / tool_gen_callback / status_callback`——不是事件流，是构造时注入的回调；各入口（CLI/gateway/ACP/API）各自把回调翻译成自己的事件。

**限制与 failover**："Budget and Fallback Behavior"：`IterationBudget` 默认 **500** 次迭代（`agent.max_turns`），子 agent 独立预算封顶 `delegation.max_iterations`（默认 50）；主模型 429/5xx/401/403 时按 `fallback_providers` 顺序切换并**继续本会话**；401/403 先尝试刷新凭证；Codex 推理只输出无可见文本连续 3 次也触发 fallback。

**压缩**（"Compression and Persistence" + `website/docs/developer-guide/context-compression-and-caching.md`）：preflight >50% 或 gateway 间隙 >85%；压缩前先 flush memory；中间轮次摘要，保留最后 N 条（`compression.protect_last_n` 默认 20）；tool call/result 对不拆；**压缩产生新的 session lineage（child session，`sessions.parent_session_id`）**。`agent/context_engine.py:47 class ContextEngine(ABC)` 可插拔（`should_compress / compress / prune_tool_results_only / select_context / on_turn_complete / handle_tool_call ...`），`plugins/context_engine/` 提供实现。核心不变量（`AGENTS.md:19-26`）："Per-conversation prompt caching is sacred"——系统提示词在会话期间字节级稳定，slash 命令改 skills/tools/memory 默认延迟到下一会话生效。

### 2c. Session 持久化

- **位置**：`get_hermes_home()/state.db`（`website/docs/developer-guide/session-storage.md`），SQLite + FTS5（`messages_fts`、`messages_fts_cjk`、`messages_fts_trigram` 三个虚表——中文检索有专门处理）。
- **Schema**（`hermes_state_common.py:328` `SCHEMA_SQL`）：`sessions`（id, source, user_id, session_key, chat_id, chat_type, thread_id, model, model_config, system_prompt_hash → `system_prompts(hash)` 去重表, parent_session_id（压缩 lineage）, started_at/ended_at/end_reason, message_count/tool_call_count, input/output/cache_read/cache_write/reasoning_tokens, cwd/git_branch/git_repo_root, billing_provider/billing_mode/estimated_cost_usd/actual_cost_usd/pricing_version, title, handoff_state/handoff_platform, compression_failure_* 计数与冷却, profile_name, transport_profile, rewind_count, archived/pinned/hidden, tool_names）；`messages`（id, session_id, role, content, tool_call_id, tool_calls, tool_name, effect_disposition, ...）；`session_turn_leases`、`compression_locks`、`conversation_generations`、`async_delegations`、`gateway_routing`、`gateway_heartbeats`、`session_model_usage`。文件级健康处理（WAL 孤儿、零字节库隔离）在 `hermes_state_dbfile.py`。
- **可插拔性**：无（21 个 `hermes_state_*.py` sibling 全部围绕 SQLite）。memory provider 可插拔，但 transcript 不可。
- **恢复**：`/resume`、`hermes chat --resume`、`session.resume`（TUI gateway）；API server 用 `X-Hermes-Session-Id` 或 `session_id` 加载活跃 transcript；`prompt.submit` 支持 `truncate_before_row_id + confirm_truncate` 的 rewind（`programmatic-integration.md:66-81`）。

### 2d. 扩展性

**Skills**：`skills/<category>/<name>/SKILL.md`（58 个内置，`optional-skills/` 另有官方可选）。frontmatter（`skills/apple/apple-reminders/SKILL.md:1-13`）：`name / description / version / author / license / platforms / metadata.hermes.tags / prerequisites.commands`。**Skills Hub**（`tools/skills_hub*.py`，共 ~4.6K 行含 guard）：多源聚合——`skills_hub_skillssh.py`（`https://skills.sh/api/search` + sitemap 全量目录 ~20k，内容从 GitHub 取）、`skills_hub_clawhub.py:66`（`https://clawhub.ai/api/v1`，"Every skill is community trust"）、`skills_hub_github.py`、`skills_hub_official.py`、自定义 tap（`hermes skills tap add <repo>`）；`skills_hub_models.py` 定义 `SkillSource/SkillMeta/SkillBundle` + trust level；**`tools/skills_guard.py:61-433`** 安装前威胁扫描（pipe-to-shell、读凭证、/tmp 暂存外传、prompt injection/jailbreak 等几百条正则，分 critical/high 等级）；`skill_provenance.py`、`skill_ledger.py`、`skill_linter.py`。同时兼容 "Agent Plugins v1" 便携包（`plugin.json + skills/ + mcp.json`，`plugins/index.md` "Portable Agent Plugins v1 packages"）。

**Plugins**（`hermes_cli/plugins.py`）：三个发现源 `~/.hermes/plugins/`、`.hermes/plugins/`、pip entry points；`plugin.yaml` + `register(ctx)`。ctx API（行号）：`register_tool`(:460)、`register_cli_command`(:649)、`register_command`(:663，slash)、`register_context_engine`(:702)、`register_context_reference`(:723)、`register_memory_provider`(:739)、`register_dashboard_auth_provider`(:751)、`register_platform`(:793)、`register_platform_handler`(:843)、`register_auxiliary_task`(:867)、`register_redaction_patterns`(:902)、**`register_hook`(:916)**、**`register_middleware`(:920)**、`register_system_prompt_section`(:940)、`register_skill`(:997)、`register_source`(:1096，secret source)、`register_approval_transport`(:434)。`plugin.yaml` 的 `kind` 区分 `model-provider / platform / memory / context_engine / ...`。

**Hook 点**（`hermes_cli/plugins.py` 字面量 + `plugins/index.md` "Hook reference"）：`pre_tool_call`（可返回 `{"action":"block"}`）、`post_tool_call`、`pre_llm_call`（每 turn 一次）、`post_llm_call`、`pre_api_request` / `post_api_request` / `api_request_error`（每次 provider 请求）、`on_session_start / on_session_end / on_session_finalize / on_session_reset`、`on_stream_start / on_stream_delta / on_stream_end`、`on_interim_message`、`pre_command`、`pre_gateway_dispatch`、`pre_approval_request / post_approval_response`、`pre_transcription`、`pre_verify`、`after_memory`、`on_skill_lifecycle`、`after_install_path`、`gateway_platform_event`、`kanban_*`、`on_unload`。hook 分派有超时与 fail-closed 集合（`hermes_cli/plugins_dispatch.py:164-208`）。**Middleware**（`website/docs/developer-guide/middleware.md`）：与 observer hook 区分的"改变行为"接口——可改写 LLM 请求 kwargs、改写 tool 参数、**包装 LLM 执行回调和 tool 执行回调**同时保留重试/流式/中断/审批语义；文档明确用途"local policy, request shaping, tracing, adaptive routing, cache control, sandbox selection, or handoff to runtimes such as NeMo Relay"。Gateway 级还有 `HOOK.yaml + handler.py` 目录 hook（`gateway:startup / session:start|end|reset / agent:start|step|end / command:*`）和 config.yaml 里的 shell hook。

**MCP**：客户端 `tools/mcp_tool*.py`（21 个文件）：`mcp_servers.<name>` 配置，stdio + streamable-http（`mcp_tool.py:157-160` 兼容 mcp SDK 1.24/2.0 两种 API）、OAuth（device/provider/manager 三个文件）、schema cache、health、death supervisor、sampling；**trust 分级**（`mcp_tool.py:475-478` `trust: full | untrusted`，untrusted 服务器上写能力工具需要审批，缺省 full）。服务端 `mcp_serve.py`（stdio）：暴露会话列表/历史/发消息/事件轮询/审批——docstring 自述"Matches OpenClaw's 9-tool channel bridge surface"。

**自定义工具**：`tools/<name>.py` 顶层 `registry.register(name, toolset, schema, handler, check_fn=...)`，import 时自注册；`check_fn` 结果进程级 TTL 缓存（`AGENTS.md:154-175` 强调"Surface capability is a property of the SESSION, never of the process env"——按会话变化的能力应走 toolset 解析器而不是 `check_fn`）。**Footprint Ladder**（`AGENTS.md:133-152`）是很好的扩展决策指南：扩展现有代码 → CLI 命令 + skill → `check_fn` 门控工具 → plugin → MCP server（目录）→ 新核心工具（最后手段），理由是"Every model tool is sent on every API call"。**Personas**：`SOUL.md` + profile；无 openclaw 那种多 agent binding。**Cron**（`cron-internals.md`）：`~/.hermes/cron/jobs.json` 原子写；四种 schedule（相对延迟、interval、cron 表达式、ISO 时间）；模型侧 `cronjob_manage` 单工具；每次 job 新建无历史 `AIAgent`，注入附加 skills，投递到平台；gateway 循环里 tick。**Memory**：`MEMORY.md/USER.md` 文件 + `agent/memory_provider.py` ABC（`initialize → system_prompt_block / prefetch / sync_turn → tool dispatch → shutdown`，一次只能一个外部 provider），`plugins/memory/` 有 honcho/mem0/supermemory/hindsight/byterover/openviking/retaindb/holographic。

### 2e. 模型/provider 层

- **`ProviderProfile`**（`providers/base.py:41-80`）：声明式 dataclass——`name, api_mode="chat_completions", aliases, display_name, signup_url, env_vars, base_url, models_url, auth_type (api_key|oauth_device_code|oauth_external|copilot|aws_sdk), auth_handler, refresh_credential, classify_api_error, supports_vision, supports_prompt_cache_key, native_reasoning_details_type, fallback_models, model_aliases, default_headers, fixed_temperature (OMIT_TEMPERATURE 哨兵), default_max_tokens, unsupported_response_formats, default_aux_model, build_api_kwargs_extras()`。docstring："Provider profiles are DECLARATIVE ... They do NOT own client construction, credential rotation, or streaming. Those stay on AIAgent."
- **内置注册表** `hermes_cli/auth.py:248 PROVIDER_REGISTRY`（`_REGISTRY_ROWS` 行表 + 插件镜像 `sync_plugin_provider_registry()`）。**插件 provider**（`plugins/model-providers/`）：`actual ai-gateway alibaba alibaba-coding-plan anthropic arcee azure-foundry bedrock commandcode copilot copilot-acp custom deepinfra deepseek fireworks gemini gmi huggingface kilocode kimi-coding meta-ai minimax nebius-token-factory nous novita nvidia ollama-cloud openai-codex opencode-zen openrouter qwen-oauth router stepfun upstage vertex xai xiaomi zai`。`plugins/model-providers/deepseek/__init__.py:49-56`：`DeepSeekProfile(name="deepseek", env_vars=("DEEPSEEK_API_KEY",), base_url="https://api.deepseek.com/v1", fallback_models=("deepseek-v4-pro","deepseek-flash"), unsupported_response_formats=("json_schema",))` + `build_api_kwargs_extras` 处理 V4 `thinking`/`reasoning_effort`。**一个国产 provider ≈ 30 行声明**。
- **BYOK / 配置**：`~/.hermes/.env` 只放密钥（`AGENTS.md:80-83` "`.env` is for secrets only"），`config.yaml` 放 `model.default / model.base_url / model.provider`，`fallback_providers: [{provider, model}]`，`auxiliary.*` 独立链；`custom` provider = 任意 OpenAI 兼容 base_url。凭证解析统一在 `hermes_cli/runtime_provider.py::resolve_runtime_provider()` → `(api_mode, api_key, base_url)`，CLI/gateway/cron/ACP/auxiliary 共用（`architecture.md` "Provider Resolution"）。
- **每会话路由**：TUI `session.create` 接受 `model/provider` 覆盖；gateway `/model` 命令写 `_session_model_overrides`（`api_server.py:1994-2011`）；API server 支持 per-request model（`api-server.md:365`）。
- **Failover**（`fallback-providers.md`）：credential pools（同 provider 多 key 轮换）→ 主模型 fallback（跨 provider，"mid-session without losing your conversation"）→ auxiliary 独立链；rate-limit 响应带 reset 时间则精确 bench，否则 60s→4h 指数退避。

### 2f. 沙箱/安全

- **终端后端**（`tools/environments/`）：`local / docker / ssh / modal / managed_modal / daytona / singularity / vercel_sandbox`，默认 local；`docker_egress.py`、`file_sync.py`、`env_passthrough.py`、`credential_files.py` 处理沙箱内凭证与文件同步。与 openclaw 同样是"agent 在宿主，终端在沙箱"。
- **审批**（`tools/approval.py:1-10` docstring）：facade + `approval_detection`（hardline/dangerous 正则）、`approval_floors`（预门控 block、allowlist）、`approval_prompt`（CLI / 插件 transport / MCP elicitation）、`approval_gateway_wait`（阻塞式 gateway 往返）、`approval_smart`（guardian LLM）、`approval_human_wait`；选项 `once / session / always`（:385-388），yolo 模式，denial breaker；multiplex 下 `always` 不跨 profile 泄漏（:332-333）。`execute_code` 单独门控。
- **鉴权**：API server 单 Bearer key + CORS allowlist；渠道 allowlist/pairing；秘密脱敏（`register_redaction_patterns`，事件 preview 强制脱敏）；依赖精确 pin（`pyproject.toml` 注释：为应对 PyPI 供应链攻击，"every direct dep is exact-pinned"，provider 特定依赖懒安装）。

### 2g. 多租户阻塞点

1. **同步核心 + 线程池**：`AIAgent` 阻塞式，gateway 10 线程；高并发下就是 10 个并行 turn。整套 ContextVar 传播（70 处 `ContextVar(`）都是为了让线程池里的 worker 带上正确 profile。
2. **`HERMES_HOME` 与文件系统**：config/.env/state.db/skills/memory/cron jobs.json/logs 全在 home 目录；`hermes_constants.py:18` 用 ContextVar override 做多 profile，但 `os.environ` 写入在 agent/gateway/tools 里有 33 处。
3. **进程级注册表**：文档自列（`multiplexing-gateway.md:301-312`）——MCP 发现、内置工具 registry、provider/capability registries、终端 env、HTTP listener、进程锁。`check_fn` 结果进程级 TTL 缓存（`tools/registry.py`）。
4. **信任模型**：profile ≠ 用户；API 单 key；`X-Hermes-Session-Key` 完全信任调用方。
5. **子进程**：terminal 工具、browser、MCP stdio、TTS/STT 外部命令、`hermes` 自身 CLI 子命令（Footprint Ladder 第 2 档鼓励 agent 跑 `hermes <subcommand>`）。
6. **facade + siblings 风格**：`hermes_state.py`（21 个 sibling）、`gateway/run.py`（15）、`tools/mcp_tool.py`（15）——sibling 函数内 late-import facade，测试要 patch facade；模块间耦合靠约定。

### 2h. 体量与许可

- **License**：MIT（`LICENSE`，Nous Research 2025）。
- **行数**（`.py/.ts/.tsx/.js/.md/.rs`，排除 `.venv`/`node_modules`）：

| 目录 | 行数 | 备注 |
|---|---|---|
| 全部 `.py` 非测试 | **825K / 2,117 文件** | 根目录 `.py` 31K |
| `tests/` | 1.21M / 4,949 文件 | `AGENTS.md` 称 ~39k tests |
| `hermes_cli/` | 232K | CLI 子命令、setup、plugins loader、web routers |
| `agent/` | 124K | loop、turn 阶段、providers、memory、compression、prompt |
| `tools/` | 114K | 322 文件（含 MCP、skills hub、browser、environments） |
| `plugins/` | 98K | model-providers / platforms / memory / context_engine / kanban / image_gen |
| `gateway/` | 93K | run.py 6,069 行 + 15 sibling；api_server 7.4K |
| `skills/` | 65K（Markdown） | 58 个 SKILL.md |
| `ui-tui/` 102K（TS/Ink）、`tui_gateway/` 37K、`web/` 57K、`website/` 256K、`cron/` 17K、`acp_adapter/` 4.5K、`evals/` 22.5K | | |

- **依赖**：`pyproject.toml` 核心依赖 **37** 个（`openai`、`httpx`、`pydantic`、`fastapi`、`uvicorn`、`websockets`、`croniter`、`tenacity`、`rich`、`prompt_toolkit`、`PyJWT`、`cryptography`、`psutil`、`Pillow`...），**46 个 extras**（`anthropic`、`mcp`、`slack`、`matrix`、`honcho`、`mem0`、`modal`、`daytona`、`bedrock`、`vertex`、`feishu`、`dingtalk`...）；Python `>=3.11,<3.14`；`uv.lock`。

---

## 3. 逐维度对比表

| 维度 | openclaw | hermes-agent |
|---|---|---|
| 语言 / 运行时 | TS，Node ≥24.16（用 `node:sqlite`） | Python 3.11–3.13，同步核心 |
| 守护进程 | 单 Gateway，WS 控制面 + 消息面 + HTTP 复用一个端口 | 单 Gateway（asyncio）+ 独立 API server（aiohttp）+ TUI gateway（stdio/WS） |
| 客户端协议 | 自定义 WS 帧（req/res/event + connect 握手 + 幂等键），TypeBox 生成 schema | JSON-RPC 2.0（ACP、TUI）+ OpenAI 兼容 HTTP + `/v1/runs` SSE |
| 方法数 | ~460 核心 RPC（`core-descriptors.ts`） | TUI ~40 方法；HTTP ~20 端点 |
| run 生命周期事件 | `lifecycle{start,finishing,end,error}` / `assistant` / `tool` 三 stream | `run.queued/started/completed/failed/cancelled/interrupted/steered/stopping`、`message.delta/interim`、`tool.started/completed`、`approval.request/responded`、`subagent.*` |
| 服务端→客户端请求 | 事件 `exec.approval.requested` / `question.requested` + RPC `*.resolve` | JSON-RPC 反向请求（`approval/clarify/sudo/secret`）+ HTTP `POST /v1/runs/{id}/approval` |
| session 键 | `agent:<agentId>:<...>`，`dmScope` 四档 | `agent:{ns}:{platform}:{chat_type}:{chat_id}` |
| 同会话串行 | 内存 lane + durable `activeWriterRunId` 写栅栏 | 两层内存守卫 + SQLite `session_turn_leases` |
| 跨会话并发上限 | `agents.defaults.maxConcurrent`（默认 `max(8, CPU*4)`） | `_TURN_MAX_WORKERS = 10` |
| 忙时新消息 | steer / followup / collect / interrupt | steer / redirect / queue（`busy_input_mode`） |
| agent loop 核心 | `packages/agent-core`（pi 血统，事件驱动，async） | `conversation_loop.py` + 30 个 turn 阶段（回调驱动，同步） |
| 并行工具 | 默认并行，工具可声明 sequential；steering 检查点 | 多调用线程池 8；交互式工具强制串行 |
| 迭代/时间上限 | 48h 执行预算，模型 idle 120/300s | 500 次迭代，子 agent 50 |
| 压缩 | 阈值 + overflow 错误触发；safeguard 质量审计；compactionSummary 为消息类型 | preflight 50% / gateway 85%；child session lineage；ContextEngine ABC 可插拔 |
| 持久化 | 每 agent sqlite（树形 session、branch/fork/rewind、信号日志） | 单 state.db（sessions/messages + FTS5 中英文、租约、usage/cost 列） |
| 持久化可插拔 | 否 | 否 |
| skills 格式 | `SKILL.md` + `metadata.openclaw.{requires,install}` | `SKILL.md` + `metadata.hermes.tags` + `prerequisites` |
| skills 注册中心 | ClawHub（自家）+ Workshop 提案流 | skills.sh + ClawHub + GitHub + 官方 + tap；`skills_guard` 扫描 |
| plugin 模型 | capability 注册（17 类）+ 17 typed hook + HOOK.md | `register_*` 17 个 + ~30 hook + **middleware** |
| MCP client | stdio/sse/streamable-http，OAuth，session 级过滤 | stdio/streamable-http，OAuth，trust 分级，schema cache |
| MCP server | 有（渠道桥） | 有（渠道桥，对齐 openclaw） |
| provider 抽象 | `KnownApi` 9 族 + provider 插件（catalog + quirk hooks） | `api_mode` 3 种 + `ProviderProfile` dataclass |
| 国产模型 | deepseek / moonshot / kimi-coding / minimax / qwen / alibaba / zai / qianfan / volcengine / stepfun / xiaomi / tencent / byteplus / longcat | deepseek / kimi-coding / minimax / qwen-oauth / alibaba(-coding-plan) / zai / stepfun / xiaomi |
| BYOK | `models.providers.<id>.{baseUrl, apiKey, api, models}`；per-agent auth profile；多用户 personal accounts | `.env` 密钥 + `config.yaml`；`custom` provider；per-session 覆盖 |
| failover | 同模型 bounded 重试 → auth profile 轮换 → 模型链（turn-local） | credential pool → `fallback_providers` 链（会话内切换）→ auxiliary 链 |
| 沙箱 | docker/podman/ssh/openshell/crabbox，默认关，`scope: agent/session/shared` | local/docker/ssh/modal/daytona/singularity/vercel，默认 local |
| 审批 | exec approvals 5 档 + permission mode 4 档 + LLM reviewer + 审计账本 | 正则 + `once/session/always` + guardian LLM + yolo |
| 多用户 | trusted operators 共用；ownership/presence/visibility 是 UX 不是安全 | 无；profile ≠ 用户；API 单 key |
| 多租户 | fleet：每租户一个容器 | 无 |
| 非测试代码 | 2.47M 行 TS（src）+ 237K packages | 825K 行 Python |
| 运行时依赖 | 65 | 37 + 46 extras |
| License | MIT（含 pi-mono MIT 声明） | MIT |

---

## 4. 对 agent-runner 的启发与可复用点

### 4.1 值得移植的设计

1. **Run 资源模型 + SSE 事件（抄 hermes `/v1/runs`）。** `POST /runs` 立即返回 `run_id`（202），`GET /runs/{id}` 轮询状态，`GET /runs/{id}/events` SSE 可断开重连，`POST /runs/{id}/{stop|steer|approval}` 控制；`Idempotency-Key` 在开始工作前 durable 预留，重放返回 `Idempotency-Replayed: true`。这与 agent-router 无状态前置天然匹配：router 只需把 `run_id` 路由到持有该 run 的 runner（或从共享事件总线回放）。事件命名可直接采用 hermes 的 `run.* / message.delta / message.interim / tool.started / tool.completed / approval.request / subagent.*`，并补上 openclaw 的 `lifecycle.finishing`（"模型已结束、正在落库/投递"）这一相位。事件 `preview` 截断 + 强制脱敏、未消费缓冲 5 分钟过期、关机时把活跃 run 落为 `interrupted` 三条运营细节都值得照搬。
2. **agent 事件模型（抄 openclaw/pi `AgentEvent`）。** `agent_start/end`、`turn_start/end`、`message_start/update/end`、`tool_execution_start/update/end{executionStarted, errorKind}` 是清晰的内部事件契约；把它和对外 SSE 事件分开（openclaw 就是 agent-core 事件 → gateway 三 stream → chat delta/final 三层投影）。
3. **每会话串行 + durable 写栅栏/租约。** openclaw 的 `activeWriterRunId` + `expectedWriterRunId` 事务校验，hermes 的 `session_turn_leases(conversation_id, holder, expires_at)`。分布式版本：Redis/DB 上的会话租约（带 TTL 与 holder=runner 实例 id），transcript 追加时 CAS 校验 writer；这直接解决"同一会话两个 runner 同时写"的问题，也是 router 把同会话请求粘到同一 runner 的兜底。
4. **忙时输入策略四档**（openclaw `steer / followup / collect / interrupt`）+ steering 只在工具边界注入（"lets an already-running tool finish, skips sequential calls that have not started"）。agent-runner 至少要支持 `steer` 和 `interrupt`，并把策略作为 run 参数而不是全局配置。
5. **Provider 声明式 profile（抄 hermes `ProviderProfile`）+ openclaw 的 quirk hook 命名。** 国产模型在两者中都只是"base_url + env key + 几个 quirk（thinking 参数、不支持 json_schema、fixed temperature、reasoning_content 回显）"。agent-runner 的 BYOK 配置形状建议直接用 openclaw 的 `{ baseUrl, apiKey, api: "openai-completions", models: [{id, name, input, compat}] }`，quirk 用 hermes 的 `build_api_kwargs_extras / classify_api_error / unsupported_response_formats` 字段化，避免 20 个布尔 flag。
6. **三层 failover**：同模型 bounded 重试（保留部分输出）→ 同 provider 凭证轮换（带 rate-limit reset 时间的 bench）→ 跨 provider 模型链；fallback 是 turn-local，不改 session 的模型选择（openclaw），或明确记录 `runtime.{provider,model}` 供计费归因（hermes `GET /runs/{id}` 的 `runtime` 字段）。
7. **压缩不变量**：tool call/result 对不拆、CJK 计数、压缩摘要作为一等消息类型进 transcript（openclaw `compactionSummary`）、压缩产生 child session lineage（hermes `parent_session_id`）、overflow 错误匹配后"compact and continue from recorded results"不重放工具、压缩前先 flush memory。以及 hermes 的核心纪律"system prompt 在会话内字节级稳定，以保住 prefix cache"——对按 token 计费的 20M DAU 产品这是成本问题。
8. **Skills 格式与来源优先级**：`SKILL.md` + frontmatter 已是两家共同事实标准（Agent Skills）；openclaw 的 7 级来源优先级映射到我们就是 `请求级 > 用户级 > 租户级 > 平台内置`；hermes 的多源 Hub 抽象（`SkillSource` 接口 + trust level + 安装前 `skills_guard` 扫描 + provenance ledger）是运营一个 skills 市场所需的最小集合。
9. **Hook + Middleware 双层扩展**：observer hook（`pre/post_tool_call`、`pre/post_llm_call`、`pre/post_api_request`、`on_session_*`）只观察；middleware 可改写 LLM kwargs / tool args 并包装执行回调。服务端策略（租户配额、内容安全、模型路由、审计）用 middleware 实现比在 hook 里返回 `{block:true}` 更干净。hook 分派要有超时和 fail-closed 集合（`plugins_dispatch.py`）。
10. **hermes 的 Footprint Ladder**：新能力优先级"扩展现有 → CLI+skill → 门控工具 → plugin → MCP → 核心工具"，理由是每个核心工具都进每次 API 调用的 prompt。agent-runner 的工具面应该按会话/租户解析（hermes "capability is a property of the SESSION, never of the process env"），不能靠进程级 `check_fn` 缓存。
11. **MCP trust 分级**（hermes `trust: full | untrusted`，untrusted 上写工具需审批）和 openclaw 的 session 级 server/tool 拒绝列表——租户自带 MCP server 时必需。
12. **协议由 schema 生成**（openclaw TypeBox → JSON Schema → 客户端模型）；hermes `client.capabilities` / `gateway.capabilities` / `GET /v1/capabilities` 的能力协商。agent-router 与 runner 之间、runner 与客户端之间都应有 capability 声明而不是版本号猜测。

### 4.2 值得引入的代码（均 MIT，可直接 vendoring，需保留版权声明）

| 代码 | 位置 | 规模 | 用途 | 引入方式 |
|---|---|---|---|---|
| **agent loop 核心** | `openclaw/packages/agent-core/src/{agent-loop,agent,agent-stream-response,types,validation,stream-steering,turn-interruption}.ts` | ~4K 行 | 事件驱动 loop、并行/串行工具、steering 检查点、tool-loop 检测 | 依赖 `@openclaw/ai`、`@openclaw/llm-core`、`normalization-core`、`typebox`；更干净的做法是直接取上游 **pi-mono 的 `@earendil-works/pi-agent-core`**（同一血统，MIT，`THIRD_PARTY_NOTICES.md:7-15`），我们的 03 号文档已评估过 pi |
| **压缩与 tool 配对** | `packages/agent-core/src/harness/compaction/{compaction,utils,branch-summarization,summarization-completion}.ts`、`harness/session/tool-result-pairing.ts`、`harness/utils/truncate.ts` | ~2.5K 行 | 压缩切点、tool call/result 配对、CJK 估算、截断 | 纯函数为主，可抄 |
| **OpenAI 兼容流式 transport** | `openclaw/packages/ai/src/transports/openai-completions-stream.ts`（731 行）+ `openai-completions-dsml.ts`、`internal/openai-completions-compat.ts` | ~1.5K 行 | chat completions 流解析、reasoning/thinking 字段、compat 开关 | 可抄；注意它绑定 `@openclaw/llm-core` 的消息类型 |
| **tool-call-repair** | `openclaw/packages/tool-call-repair/src/` | 3.7K 行，仅依赖 normalization-core | 修复模型把 tool call 当纯文本输出的情况（国产模型常见） | 整包 vendoring |
| **retry / retry-after** | `openclaw/packages/retry/src/`、`packages/ai/src/internal/retry-after.ts` | ~400 行 | 带 `Retry-After` 解析的退避 | 抄 |
| **skills frontmatter 解析** | `openclaw/packages/markdown-core/src/frontmatter.ts` + `src/skills/loading/frontmatter.ts`（含 brew/go/uv 安装规格校验） | ~500 行 | SKILL.md 解析与 `requires/install` 规范化 | 抄解析部分 |
| **skills 威胁扫描** | `hermes/tools/skills_guard.py:61-433` | ~400 行正则表 | 安装前扫描 pipe-to-shell、凭证读取、外传、prompt injection | 正则表语言无关，可翻译为 TS |
| **Skills Hub 多源抽象** | `hermes/tools/skills_hub_models.py`（`SkillSource/SkillMeta/SkillBundle`）、`skills_hub_skillssh.py`、`skills_hub_clawhub.py`、`skills_hub_github.py` | ~2K 行 | skills.sh / ClawHub / GitHub 三源检索与安装 | 抄接口与 API 端点（`https://skills.sh/api/search`、`https://clawhub.ai/api/v1`） |
| **provider profile 表** | `hermes/providers/base.py` + `plugins/model-providers/{deepseek,kimi-coding,minimax,zai,stepfun,xiaomi,alibaba}/__init__.py`；`openclaw/extensions/{deepseek,moonshot,minimax,qwen,zai,...}/models.ts` | 每个 30–200 行 | 国产模型 base_url、模型目录、thinking 参数、overflow 错误正则（openclaw `matchesContextOverflowError`） | 抄数据与 quirk 逻辑 |
| **Runs API 语义** | `hermes/gateway/platforms/api_server_runs.py`、`api_server_run_idempotency.py` | ~2K 行 Python | run 状态机、事件缓冲、幂等存储 | Python 不能直接用，作为规格参考 |
| **session schema** | `hermes/hermes_state_common.py:328-600` | DDL | `sessions` 的 usage/cost/lineage/handoff 列、`session_turn_leases`、`compression_locks` | 作为 agent-runner 会话表设计参考 |
| **协议 schema** | `openclaw/packages/gateway-protocol/src/schema.ts` | TypeBox | `agent`、`sessions.*`、`chat.*` 参数与事件 payload 定义 | 参考字段命名，不建议整套采用（WS 帧格式与我们 HTTP+SSE 不同） |

不建议引入的代码：`src/gateway/*`（420K 行，与 WS/渠道/设备配对强耦合）、`src/agents/embedded-agent-runner/*`（碎片化到需要读 docs 才能理解调用顺序）、hermes `gateway/run.py`（6K 行 facade + 15 sibling，同步线程模型）、两者的 SQLite 状态层。

### 4.3 要避免的

1. **"一进程一信任域"的假设。** 两家都把"session ID 只做路由不做授权"写进文档，并各自用"每租户一个容器"（openclaw fleet）或"profile ≠ 用户"（hermes multiplex）划清边界。agent-runner 必须从第一天起把 `tenant_id/user_id` 作为每个请求的 principal，会话、skills、MCP 连接、凭证、memory、cron 都以 principal 作用域存取；任何进程级 registry/缓存都必须按 principal 分片或禁止。
2. **HOME 目录 / workspace 文件系统作为状态载体。** 两家的 skills、memory（`MEMORY.md`）、bootstrap（`AGENTS.md/SOUL.md`）、cron（`jobs.json`）、审批状态都是文件。分布式 runner 需要对象存储/DB 后端 + 明确的"workspace 物化"步骤（openclaw 沙箱模式已经有"materialized copies, not the original host paths"的雏形）。
3. **同步阻塞式 agent loop + 固定线程池**（hermes）。10 个 worker 的上限和 ContextVar 传播链路是 Python 世界的妥协，Node/asyncio 服务端不应复制。
4. **WS 自定义帧协议 + 设备配对握手**（openclaw）。对 local-first 多端产品合理，对经 router 的 HTTP+SSE 服务是负担；只借鉴 req/res/event 三分和幂等键要求。
5. **单 API key 全权 + 信任客户端传的 session key**（hermes `API_SERVER_KEY` + `X-Hermes-Session-Key`；openclaw HTTP 端点 = full operator access）。
6. **无限执行预算**（openclaw 默认 48h、hermes 500 迭代）。服务端需要按租户/模型的硬预算（时间、迭代、token、成本），并像 openclaw 那样把预算暂停/恢复与审批等待关联。
7. **进程内热重载插件 + 进程级 MCP 连接池**。MCP stdio 子进程、插件 `import` 时自注册（hermes `registry.register()` at import time）都会在多租户下变成资源泄漏与串扰；MCP 连接应按（principal, server）键做池化与 TTL。
8. **代码规模膨胀的路径**。openclaw 在一年内长到 2.47M 行非测试 TS + 171 个 extension，hermes 825K 行 Python；两者都靠超长 docs/AGENTS.md 维持可导航性。agent-runner 应把渠道、桌面、TTS、浏览器等一律排除在核心外（hermes 的"narrow waist"原则），核心只保留 run/session/model/tool/skill/mcp/hook 六件事。
9. **把"人在回路审批"做成 loop 的阻塞点。** 两者的审批都是 CLI/聊天里等人回复；agent-runner 应把审批建模为 run 的 `waiting_for_approval` 状态 + 事件 + 独立 endpoint（hermes 已这样做），并允许审批超时后由策略自动 deny。
