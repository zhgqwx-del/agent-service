# openai/codex 源码级分析：协议与架构参考（2026-09-22）

> 快照：`oss-refs/codex` @ `f4389de` (2026-09-22, "Add explicit gateway login control and authentication status (#47170)")，单 commit 浅克隆。所有路径相对 `codex-rs/`，行号以该快照为准。
> 目的：为 `agent-runner`（HTTP+SSE 后端 agent API）+ 无状态 `agent-router` 的协议与架构设计提供一手参照。横向协议对比见 `07-agent-server-protocol-survey.md`，本文只讲 codex。

## 0. 一句话结论

- codex 的对外协议 = **`app-server`**：类 JSON-RPC（不带 `jsonrpc:"2.0"` 字段）的 **thread → turn → item** 三级模型，164 个 client→server 请求、11 个 server→client 请求（审批/反向工具调用）、84 个通知、1 个 client 通知。传输是 stdio / unix socket / **WebSocket**（axum，带 JWT 或 capability-token 鉴权）+ 出站 relay 的 "remote control"。
- **`WireApi` 至今只有 `Responses`**，`wire_api = "chat"` 在反序列化阶段直接报错（`model-provider-info/src/lib.rs:117-131`）。仓库里 **没有** 任何 `chat/completions` 客户端。第三方 `base_url` 走 `[model_providers.<id>]`，但必须是 Responses 兼容端点。
- 核心引擎是单进程、单用户（一个 `AuthManager`、一个 `CODEX_HOME`）；多租户/分布式不是它的设计目标，但它把 **执行环境**（`exec-server`）和 **存储**（`ThreadStore` trait）都抽象成了可远程的接口，这两个切面值得直接照抄。
- 许可证 Apache-2.0（`LICENSE`、`Cargo.toml:163`），`NOTICE` 只额外声明 Ratatui (MIT)。

---

## 1. app-server 协议

### 1.1 传输层

| 传输 | 代码 | 说明 |
|---|---|---|
| `stdio://`（默认） | `app-server-transport/src/transport/stdio.rs` | 每行一个 JSON 消息 |
| `unix://[PATH]` | `.../unix_socket.rs` | 默认 `$CODEX_HOME/app-server-control/app-server-control.sock`，配合 `app-server-startup.lock` 做单实例（`transport/mod.rs:52-76`） |
| `ws://IP:PORT` | `.../websocket.rs:129-171` | axum；`/readyz`、`/healthz` GET，其余路径全部 upgrade 为 WS；**拒绝带 `Origin` 头的请求**（防浏览器 CSRF，`:93-108`）；非 loopback 监听必须配鉴权，否则拒绝启动（`:136-143`） |
| `off` | | 只跑 remote control |

CLI 入口 `app-server/src/main.rs:32-78`：`--listen URL`、`--session-source`、`--ws-auth capability-token|signed-bearer-token`、`--ws-token-file/--ws-token-sha256`、`--ws-shared-secret-file/--ws-issuer/--ws-audience/--ws-max-clock-skew-seconds`（`app-server-transport/src/transport/auth.rs:28-80`）。JWT 校验拒绝 `alg=none`、要求 `exp`、支持多 audience（`auth.rs:306-366`）。

WS 出站队列 `WEBSOCKET_OUTBOUND_CHANNEL_CAPACITY = 32*1024`（`websocket.rs:47`），内部通道 128（`transport/mod.rs:26`）；超限返回 `-32001 OVERLOADED`（`mod.rs:52`）。

每个连接有 `ConnectionId`，绑定到 `AuthManager` 的 `owner_generation`；登录用户切换会使旧连接排队中的工作失效（`app-server-transport/src/connection_auth.rs:9-50`）。**这就是"单用户"假设的落点。**

### 1.2 消息信封

`app-server-protocol/src/rpc.rs`：

```rust
// rpc.rs:1-2  "We do not do true JSON-RPC 2.0, as we neither send nor expect the "jsonrpc": "2.0" field."
pub enum RequestId { String(String), Integer(i64) }                      // :17-21, untagged
pub struct JSONRPCRequest { id, method, params?, trace?: W3cTraceContext } // :45-55
pub struct JSONRPCNotification { method, params? }                          // :59-64
pub struct JSONRPCResponse { id, result }                                   // :68-71
pub struct JSONRPCError { error: {code, message, data?}, id }               // :75-88
```

服务端通知额外包一层 `ServerNotificationEnvelope`（`protocol/common.rs:2023-2036`）：`{ "method": "...", "params": {...}, "emittedAtMs": 1234 }`——`emitted_at_ms` 在 fan-out 到各连接**之前**打一次（`app-server/src/outgoing_message.rs:890-895`），同一通知发给多个连接时间戳一致（测试 `send_server_notification_to_connections_reuses_timestamp`）。

错误码（`app-server/src/error_code.rs`）：`-32600 invalid request`、`-32601 method not found`、`-32602 invalid params`、`-32603 internal`、`-32001 overloaded`；字符串码 `input_too_large`；drain 期间返回 `-32600 "Server is draining; retry after reconnecting"`。

`initialize`（`protocol/v1.rs:29-79`）：`clientInfo{name,title,version}` + `capabilities{experimentalApi, requestAttestation, optOutNotificationMethods[], extensions{}}`；响应 `userAgent, codexHome, platformFamily, platformOs`。**`optOutNotificationMethods` 是按连接屏蔽通知的机制**，`experimentalApi=true` 才能看到带 `#[experimental("...")]` 的方法/字段（宏在 `common.rs:90-104` 与 `experimental_api.rs`）。

### 1.3 方法目录（`app-server-protocol/src/protocol/common.rs`）

四个宏各生成一个 enum + 序列化：`client_request_definitions!`（`:498-1482`）、`server_request_definitions!`（`:1746-1900`）、`server_notification_definitions!`（`:1901-2021`）、`client_notification_definitions!`（`:2038-2040`）。

| 类别 | 数量 | 备注 |
|---|---|---|
| Client → Server 请求 | **164**（其中 63 个标 `#[experimental]`） | v1 遗留的 `newConversation/sendUserMessage/...` 已全部删除，只剩 `initialize`、`getAuthStatus`、`getConversationSummary`、`gitDiffToRemote`、`fuzzyFileSearch` 等几个无前缀方法 |
| Server → Client 请求 | **11**（9 new + 2 deprecated） | 审批 / 反向工具调用 / 用户输入 |
| Server → Client 通知 | **84** | |
| Client → Server 通知 | **1** (`initialized`) | |

**分组要点**（wire name）：

- **Thread 生命周期**：`thread/start`, `thread/resume`, `thread/fork`, `thread/archive|unarchive|delete`, `thread/unsubscribe`, `thread/list`, `thread/read`, `thread/loaded/list`, `thread/turns/list`, `thread/items/list`, `thread/timeline/list`[exp], `thread/search`[exp], `thread/name/set`, `thread/metadata/update`, `thread/settings/update`[exp], `thread/compact/start`, `thread/revert`, `thread/shellCommand`, `thread/inject_items`, `thread/goal/*`, `thread/queue/*`[exp], `thread/attachment/*`, `threadSection/*`, `thread/backgroundTerminals/*`[exp], `thread/realtime/*`[exp]
- **Turn**：`turn/start`, `turn/steer`, `turn/interrupt`, `turn/settings/update`[exp]
- **Server→Client 请求（审批等）**：`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/tool/requestUserInput`, `item/permissions/requestApproval`, `item/tool/call`（动态工具反向委托）, `mcpServer/elicitation/request`, `account/chatgptAuthTokens/refresh`, `attestation/generate`, `currentTime/read`[exp]
- **Item 通知**：`item/started`, `item/completed`, `item/agentMessage/delta`, `item/plan/delta`, `item/reasoning/summaryTextDelta|summaryPartAdded|textDelta`, `item/commandExecution/outputDelta|terminalInteraction`, `item/fileChange/patchUpdated`（`outputDelta` 已废弃）, `item/mcpToolCall/progress`, `item/autoApprovalReview/started|completed`, `rawResponseItem/completed`（内部/Cloud 用）
- **Turn/Thread 通知**：`turn/started`, `turn/completed`, `turn/diff/updated`, `turn/plan/updated`, `thread/started`, `thread/status/changed`, `thread/closed`, `thread/tokenUsage/updated`, `thread/compacted`（废弃，改用 `contextCompaction` item）, `serverRequest/resolved`, `hook/started|completed`, `error`, `warning`, `deprecationNotice`
- **模型/Provider**：`model/list`, `modelProvider/capabilities/read`, 通知 `model/rerouted`, `model/verification`, `modelProvider/authRecoveryStarted|Completed`
- **MCP**：`mcpServerStatus/list`, `config/mcpServer/reload`, `mcpServer/tool/call`, `mcpServer/resource/read`, `mcpServer/oauth/login`, `mcpServer/event/stream/start|stop`[exp]，通知 `mcpServer/startupStatus/updated`, `mcpServer/oauthLogin/completed`
- **Skills / Plugins / Hooks / Apps**：`skills/list`, `skills/extraRoots/set`, `skills/config/write`, `skills/changed`(n); `plugin/list|search|installed|reconcile|read|install|uninstall|skill/read|share/*`, `marketplace/add|remove|upgrade`; `hooks/list`; `app/list|read|installed`
- **Auth / Account**：`account/login/start|cancel`, `account/logout`, `account/read`, `account/rateLimits/read`, `account/usage/read`, `account/bedrock/*`, `getAuthStatus`; 通知 `account/updated`, `account/rateLimits/updated`, `account/login/completed`
- **Config**：`config/read`, `config/value/write`, `config/batchWrite`, `configRequirements/read`, `externalAgentConfig/*`（导入 Claude Code 等外部 agent 配置）
- **执行原语（旁路 agent）**：`command/exec` + `command/exec/write|terminate|resize` + 通知 `command/exec/outputDelta`；`process/spawn|writeStdin|kill|resizePty`[exp]；`fs/readFile|writeFile|createDirectory|getMetadata|readDirectory|remove|copy|watch|unwatch`
- **环境（远程执行）**：`environment/add|info|status`[exp]，通知 `thread/environment/connected|disconnected`
- **Remote control**：`remoteControl/enable|disable|status/read|pairing/start|pairing/status|client/list|client/revoke`[exp]
- **其他**：`review/start`, `feedback/upload`, `permissionProfile/list`, `collaborationMode/list`, `project/*`, `memory/*`, `rollout/compress`, `userVerification/*`, `windowsSandbox/*`, `server/diagnostics`

### 1.4 Thread / Turn / Item 数据模型

**Thread**（`protocol/v2/thread_data.rs:204-290`）：`id`(UUIDv7)、`sessionId`（同一 fork 树共享）、`forkedFromId`、`parentThreadId`（子 agent）、`preview`、`ephemeral`、`section`、`projectId`、`historyMode: legacy|paginated`、`modelProvider`、`model`、`reasoningEffort`、`createdAt/updatedAt/recencyAt`(秒)、`status`、`path`、`cwd`、`cliVersion`、`originator`、`source: cli|vsCode|exec|appServer|custom|subAgent|unknown`、`agentNickname/agentRole`、`gitInfo`、`name`、`turns[]`（只有 resume/fork/read(includeTurns) 才填）。

**ThreadStatus**（`thread.rs:1649-1668`）：`{type: notLoaded | idle | systemError | active{activeFlags: [waitingOnApproval | waitingOnUserInput]}}`。

**Turn**（`thread_data.rs:386-405`）：`id`(UUIDv7)、`items[]`、`itemsView: notLoaded|summary|full`、`status: completed|interrupted|failed|inProgress`（`turn.rs:33-38`）、`error?: {message, codexErrorInfo, additionalDetails, misalignment}`、`startedAt/completedAt`(秒)、`durationMs`。

**ThreadItem**（`protocol/v2/item.rs:232-420`，`#[serde(tag="type", rename_all="camelCase")]`）共 **20 种**：

| type | 关键字段 | 状态枚举 |
|---|---|---|
| `userMessage` | `id, clientId?, content: UserInput[]` | |
| `hookPrompt` | `fragments[]` | |
| `agentMessage` | `text, phase: commentary\|finalAnswer, memoryCitation?, delivery?, questions?` | |
| `functionCallOutput` | `name, namespace?, output` | |
| `plan`[exp] | `text` | |
| `reasoning` | `summary[], content[]` | |
| `commandExecution` | `command, cwd, processId?, source, commandActions[], aggregatedOutput?, exitCode?, durationMs?, pluginId?, scriptPath?` | `inProgress\|completed\|failed\|declined` |
| `fileChange` | `changes[{path,kind,diff}], status` | 同上 |
| `mcpToolCall` | `server, tool, arguments, result?, error?, mcpAppUi?, readOnlyHint?, durationMs?` | `inProgress\|completed\|failed` |
| `dynamicToolCall` | `namespace?, tool, arguments, contentItems?, success?` | 同上 |
| `collabAgentToolCall` | `tool, senderThreadId, receiverThreadIds[], prompt?, model?, agentsStates{}` | `+interrupted` |
| `subAgentActivity` | `kind, agentThreadId, agentPath` | |
| `webSearch` / `imageView` / `sleep` / `imageGeneration` | | |
| `enteredReviewMode` / `exitedReviewMode` | `review` | |
| `contextCompaction` | `id` | |

**UserInput**（`turn.rs:420-450`）：`text{text, textElements[]}`, `image{url|fileId, detail?}`, `localImage{path}`, `audio{url}`, `localAudio{path}`, `skill{name,path}`, `mention{name,path}`。

**审批决策**（`item.rs:64-127`）：
- `CommandExecutionApprovalDecision`: `accept | acceptForSession | acceptWithExecpolicyAmendment{execpolicyAmendment} | applyNetworkPolicyAmendment{...} | decline | cancel`（decline=拒绝但 turn 继续；cancel=拒绝并中断 turn）
- `FileChangeApprovalDecision`: `accept | acceptForSession | decline | cancel`
- 核心层 `ReviewDecision`（`protocol/src/protocol.rs:4153-4185`）多一个 `TimedOut`，映射为 `decline`。

**审批策略**（`v2/shared.rs:177-186`）：`AskForApproval = untrusted | on-request | never | granular{sandboxApproval, rules, skillApproval, requestPermissions, mcpElicitations}`；`ApprovalsReviewer = user | auto_review`（`:245-255`，auto_review 用一个 Guardian 子 agent 自动审）；`SandboxMode = read-only | workspace-write | danger-full-access`。

### 1.5 请求参数要点

`thread/start`（`thread.rs:62-166`）：`model, modelProvider, serviceTier, cwd, approvalPolicy, approvalsReviewer, sandbox | permissions(profile id), config{}(任意 config.toml 覆盖), baseInstructions, developerInstructions, ephemeral, historyMode, dynamicTools[], environments[], projectId, experimentalRawEvents`。响应 `thread, model, modelProvider, cwd, approvalPolicy, sandbox: SandboxPolicy, reasoningEffort, instructionSources[]`。

`turn/start`（`turn.rs:167-282`）：`threadId, input: UserInput[], clientUserMessageId?, cwd?, approvalPolicy?, sandboxPolicy?, permissions?, model?, effort?, summary?, outputSchema?(JSON Schema 约束最终回复), collaborationMode?, additionalContext{}, responsesapiClientMetadata{}, environments[]`——**大部分覆盖项"对本 turn 及后续 turn 生效"**。响应 `{turn}`。
- 活跃 turn 期间再 `turn/start` → 核心 `TurnInputMode::StartOrSteer`（`protocol/src/turn_input.rs:134-142`）变成 steer；显式 `turn/steer` 要求 `expectedTurnId` 匹配（`turn.rs:293-318`）。
- `turn/interrupt{threadId, turnId}`。

`thread/resume`（`thread.rs:354-434`）：`threadId | path`，可覆盖 model/provider/sandbox/config；`excludeTurns` 只返回元数据；`initialTurnsPage{limit, sortDirection, itemsView}` 顺带一页 turn；响应含 `turnsBackwardsCursor / itemsBackwardsCursor`。`history: Vec<ResponseItem>` 字段标 "FOR CODEX CLOUD"——云端可以把历史直接塞进来而不读磁盘。

### 1.6 时间戳、排序、重放、分页

- 通知信封 `emittedAtMs`；`item/started.startedAtMs`、`item/completed.completedAtMs`（`item.rs:1332-1420`）；审批请求 `startedAtMs`；`ThreadItemEntry{turnId, item, startedAtMs?, completedAtMs?}`（`thread.rs:1758-1770`）。Thread/Turn 级用**秒**，item/通知级用**毫秒**——不统一，是历史包袱。
- **没有全局单调序号**。顺序靠 per-thread 的 listener task 串行发送（`app-server/src/thread_state.rs:31-70` `ThreadListenerCommand`，把 resume 响应、goal/queue 更新与事件流排在同一队列里）；`thread/timeline/list` 才有 `position: u64`（`thread.rs:1803-1845`，实验）。
- **重放 = 拉快照 + 原子订阅 + 重发挂起请求**（`app-server/src/request_processors/thread_lifecycle.rs:780-812`）：`thread/resume` 命中已加载线程时，走 `SendThreadResumeResponse`：先发 resume 响应（含历史或分页游标）、补发 token usage、再 `replay_requests_to_connection_for_thread`（`outgoing_message.rs:446-465`）把该线程所有**未决的 server→client 请求（审批）原样重发给新连接**。这是断线后仍能回答审批的关键。
- 某个连接回答了审批后，向该线程所有订阅连接广播 `serverRequest/resolved{threadId, requestId}`（`thread_lifecycle.rs:864-887`），其他客户端据此收起弹窗。
- 分页统一 `{cursor?, limit?, sortDirection?} → {data[], nextCursor?, backwardsCursor?}`（`thread.rs:1705-1785`）；`backwardsCursor` 用于反向翻页并"再次包含锚点以捕获更新"。`thread/list` 过滤：`modelProviders[]`, `sourceKinds[]`, `archived`, `cwd`, `projectId`, `sectionId`, `searchTerm`, `parentThreadId | ancestorThreadId`, `originators[]`（"仅托管后端支持，本地拒绝"→ 暗示 OpenAI 有服务端版本）。
- 多连接订阅：`ThreadStateManager.threads[thread_id].connection_ids`（`thread_state.rs:417-424`），`thread/start`/`thread/resume` 自动订阅，`thread/unsubscribe` 返回 `notLoaded|notSubscribed|unsubscribed`；线程事件只发给订阅连接（`thread_lifecycle.rs:335-341` 构造 `ThreadScopedOutgoingMessageSender`），账号/配置类通知广播。
- 优雅停机：`TurnAdmission`（`app-server/src/turn_admission.rs`）drain 后新 turn 直接拒绝，等在途 permit 归零。

### 1.7 反向工具调用（客户端工具）

`thread/start.dynamicTools: DynamicToolSpec[]`（`protocol/src/dynamic_tools.rs:13-40`，`function{name, description, inputSchema, deferLoading}` 或 `namespace{name, tools[]}`）→ 模型调用时服务端发 `item/tool/call{threadId, turnId, callId, namespace?, tool, arguments}` 请求，客户端回 `{contentItems[], success}`（`item.rs:1652-1670`）。这就是 ACP `session/request_permission` 之外的另一条"服务端向客户端要东西"的通道，同时也用于 `item/tool/requestUserInput{questions[{id, header, question, isOther, isSecret, options[]}], isBlocking, autoResolutionMs}`。

---

## 2. WireApi 与 Provider（验证 2026-09-14 笔记）

`model-provider-info/src/lib.rs`：

```rust
// :95
const CHAT_WIRE_API_REMOVED_ERROR: &str = "`wire_api = \"chat\"` is no longer supported.\nHow to fix: set `wire_api = \"responses\"` in your provider config.\nMore info: https://github.com/openai/codex/discussions/7782";

// :99-106
/// Wire protocol that the provider speaks.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum WireApi {
    /// The Responses API exposed by OpenAI at `/v1/responses`.
    #[default]
    Responses,
}

// :117-131  手写 Deserialize：
//   "responses" => Ok(Self::Responses),
//   "chat"      => Err(serde::de::Error::custom(CHAT_WIRE_API_REMOVED_ERROR)),
//   _           => Err(unknown_variant(&value, &["responses"])),
```

结论：**早前笔记正确且更严格了**——不仅不支持 chat，连 `ollama-chat` provider id 也被移除并报错（`:97`）。`grep -rln "chat/completions" --include='*.rs'` 全仓库零命中。

`ModelProviderInfo`（`:134-200`）：`name, base_url?, model_catalog_url?, env_key?, env_key_instructions?, experimental_bearer_token?, auth?(命令生成 bearer), gateway_oauth?, aws?(SigV4), wire_api, query_params?, http_headers?, env_http_headers?, request_max_retries?, stream_max_retries?, stream_idle_timeout_ms?, websocket_connect_timeout_ms?, requires_openai_auth, supports_websockets, supports_standalone_web_search`。`#[schemars(deny_unknown_fields)]`。

内置 provider（`:643-675`）：`openai`、`amazon-bedrock`、`amazon-bedrock-runtime`、`ollama`、`lmstudio`——**全部 `WireApi::Responses`**。注释原话："We do not want to be in the business of adjucating which third-party providers are bundled ... Users are encouraged to add to `model_providers` in config.toml"。用户自定义 provider 通过 `config/src/config_toml.rs:326-327` 的 `model_providers: HashMap<String, ModelProviderInfo>` 合并（`merge_configured_model_providers`, `:680-716`），不允许覆盖内置 id（Bedrock 除外）。

模型 HTTP 客户端在 `codex-api/`（`endpoint/responses.rs` SSE、`endpoint/responses_websocket.rs` Responses-over-WS，`provider.rs:36-106` 负责 `url_for_path` 与 `http→ws` scheme 转换）。还有一个 `responses-api-proxy` crate：本地反代注入 API key / dump 请求，配置成 `[model_providers.codex-responses-api-proxy] base_url='http://127.0.0.1:60001/v1' wire_api='responses'`。

**对我们的含义**：国内模型走 OpenAI-compatible `chat/completions` 时，codex 这条链路完全不可复用；需要自己写 chat→内部 item 的适配器，或者在网关层做 chat→Responses 的协议转换（但 Responses 的 `reasoning`/`previous_response_id`/`function_call` item 语义比 chat 丰富，反向转换有损）。

---

## 3. Core 架构（`core/` ≈ 134k 行非测试代码）

### 3.1 SQ/EQ 内部协议

`protocol/src/protocol.rs`：`Submission{id, op: Op, trace?, parent_turn_id?}`（`:193-200`）与 `Event{id, msg: EventMsg}`（`:1340-1346`）。`Op` 约 28 个变体（`:601-`）：`Interrupt, TurnInput{request, mode: StartOrSteer|StartIfIdle|ContinueIfIdle|Steer}, RecoverTurn, SuspendTurnAndShutdown, ThreadSettings, TurnSettings, ExecApproval, PatchApproval, ResolveElicitation, UserInputAnswer, RequestPermissionsResponse, DynamicToolResponse, RefreshMcpServers, ReloadUserConfig, Compact, Review, Shutdown, RunUserShellCommand, RealtimeConversation*, ...`。`EventMsg` **83 个变体**（`:1358-`，`#[serde(tag="type", rename_all="snake_case")]`）：`TurnStarted/TurnComplete/TurnAborted, ItemStarted/ItemCompleted, AgentMessageContentDelta, ReasoningContentDelta, ExecCommandBegin/OutputDelta/End, PatchApplyBegin/Updated/End, McpToolCallBegin/End, ExecApprovalRequest, ApplyPatchApprovalRequest, RequestUserInput, DynamicToolCallRequest, ElicitationRequest, TokenCount, ContextCompacted, PlanUpdate, TurnDiff, CollabAgent*, SubAgentActivity, HookStarted/Completed, RawResponseItem, ...`。

`app-server-protocol/src/protocol/event_mapping.rs`（614 行）+ `app-server/src/bespoke_event_handling.rs`（3.9k 行）负责把内部 `EventMsg` 投影为对外的 v2 通知；也就是说 **对外协议是内部事件的"视图"**，两者解耦。

### 3.2 Session / Turn / Thread

- `core/src/session/session.rs:55-96` `Session`：注释 "A session has at most 1 running task at a time, and can be interrupted by user input"。持有 `tx_event`、`agent_status: watch`、`state: Mutex<SessionState>`、`active_turn: Mutex<Option<ActiveTurn>>`、`input_queue`、`services`、MCP 刷新/预热、`tool_policy`、`isolation`。
- `SessionConfiguration`（`:100-140`）：provider、`step_settings`、environments、base/developer instructions、permission profile、sandbox 参数、`codex_home`、`disabled_plugin_ids`。
- `core/src/session/turn_context.rs:305` `TurnContext`；`core/src/session/turn.rs`（3k 行）是 turn 主循环。
- `core/src/codex_thread.rs:184-193` `CodexThread{session, io, session_source, rollout_path, ...}`；`core/src/thread_manager.rs:233` `ThreadManager` 管内存中的线程，`StartThreadOptions{config, ...}`（`:250`），子 agent 通过 `InternalSessionParent` 继承 auth 与预算（`:242-248`）。

### 3.3 工具路由与沙箱

- `core/src/tools/router.rs:74-81` `ToolRouter{registry, model_visible_specs, tool_mode, code_mode_tool_names, ...}`；`registry.rs` 记录每个工具的 `exposure` 与 `runtime.supports_parallel_tool_calls()`（`:507-509`），`parallel.rs` 做并行调用。
- 三个 trait 定义在 `core/src/tools/sandboxing.rs`：`Approvable<Req>`（`:309`，`sandbox_permissions / should_bypass_approval / exec_approval_requirement / wants_no_sandbox_approval`）、`Sandboxable`（`:343`，`sandbox_preference / escalate_on_failure`）、`ToolRuntime<Req,Out>: Approvable + Sandboxable`（`:364`，`run(req, &SandboxAttempt, &ToolCtx)`）。`orchestrator.rs:122` `ToolOrchestrator::run` 统一做：网络审批 → 沙箱尝试 → 失败升级重试（escalate）→ 审批。
- 处理器目录 `core/src/tools/handlers/`：`shell/unified_exec`（PTY）、`apply_patch`、`view_image`、`plan`、`request_user_input`、`request_permissions`、`request_plugin_install`、`mcp`/`mcp_resource`/`tool_search`、`multi_agents`（spawn/send/wait/close 子 agent）、`new_context_window`、`get_context_remaining`、`sleep`、`wait_for_environment`、`dynamic`（客户端工具）。
- 沙箱类型 `protocol/src/sandbox.rs:10-16`：`None | MacosSeatbelt | LinuxSeccomp | WindowsRestrictedToken | WindowsMxc`。策略 `SandboxPolicy`（`protocol.rs:1072-1090`）：`DangerFullAccess | ReadOnly{network_access} | ExternalSandbox{network_access} | WorkspaceWrite{writable_roots[], network_access, exclude_tmpdir_env_var, exclude_slash_tmp}`。实现：`sandboxing/`（seatbelt `.sbpl` 模板、landlock、bwrap、windows）、`linux-sandbox/`（"no_new_privs + seccomp + bubblewrap"，`src/lib.rs:1-5`）、`windows-sandbox-rs/`、`mxc-sandbox/`、`network-proxy/`（受管网络出口，配合 `NetworkPolicyAmendment` 审批）。**`ExternalSandbox` 变体就是给"我在容器里，别再套沙箱"用的。**
- 执行策略 `execpolicy/`（`.rules` 文件，`AcceptWithExecpolicyAmendment` 会追加规则）。

### 3.4 MCP

- 客户端：`codex-mcp/`（catalog、connection_manager、elicitation、oauth、tool_catalog_cache、`codex_apps`= OpenAI 托管 Apps MCP）+ `rmcp-client/`（rmcp 封装）。传输配置 `config/src/mcp_types.rs:564-600`：`stdio{command,args,env,env_vars,cwd}` | `streamable_http{url, bearer_token_env_var, http_headers, env_http_headers, http_headers_helper}`。
- MCP elicitation 直接映射为 server→client 请求 `mcpServer/elicitation/request`；MCP 工具审批走 elicitation 而非 `commandExecution` 审批（`item.rs:91-93` 注释）。
- **`codex mcp-server` 子命令已不存在**（`cli/src/main.rs:142-240` 无该变体），对外统一走 app-server；`codex mcp add|list|get|remove|login|logout` 只管理外部 MCP 配置。

### 3.5 Skills

- `skills/` crate：`SkillMetadata{name, description, short_description, interface{display_name, icons, brand_color, default_prompt}, dependencies{tools[{type, value, transport, command, url, oauth_callback_port}]}, policy{allow_implicit_invocation, products[]}, path_to_skills_md, scope, plugin_id}`（`skills/src/model.rs:8-95`）。
- 发现根目录（`ext/skills/src/host_roots.rs:73-131`），按 config layer 从高到低：Project 层 `<project>/.codex/skills`（scope=Repo）+ 仓库内每级目录的 `.agents/skills`（`:137-185`）；User 层 `$CODEX_HOME/skills`（deprecated）+ `~/.agents/skills` + system cache；System 层 `/etc/codex/skills`（config 文件夹来自 `config/src/loader/mod.rs:75` 的 `/etc/codex/config.toml`，scope=Admin）。`SkillScope = User|Repo|System|Admin`（`protocol.rs:3880-3885`）。
- 调用方式：`UserInput::Skill{name, path}` 显式 @ 提及，或模型隐式调用（`allow_implicit_invocation` 默认 true）。`skills/extraRoots/set` 允许客户端临时追加根。

### 3.6 Plugins / Hooks / Extensions

- Plugin manifest（`plugin/src/manifest.rs:9-58`）：`name, version, description, keywords, paths, interface{display_name, category, capabilities, logo, screenshots, ...}, skills[], onboarding_skill, mcp_servers, apps, hooks`。Marketplace 概念（`core-plugins/`：`marketplace_add/remove/upgrade`, `npm_source`, `plugin_bundle_archive`, `marketplace_policy`）。Plugin id 格式 `<plugin>@<marketplace>`。
- Hooks（`hooks/`）事件名与 Claude Code 对齐（`hooks/src/schema.rs:103-125`）：`PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, SessionStart, UserPromptSubmit, SubagentStart, SubagentStop, Stop, Interrupt`；handler 类型 `Command | Prompt | Agent | McpTool`（`hooks/src/config_rules.rs` 中 `HookHandlerConfig::*`）；结果 `Success | FailedContinue | FailedAbort`（`types.rs:15-23`）。运行时 `hook/started|completed` 通知对外可见。
- 内部扩展点 `ext/extension-api/src/contributors.rs`：`McpServerContributor, ContextContributor, ThreadLifecycleContributor, TurnLifecycleContributor, TurnInputContributor, ConfigContributor, TokenUsageContributor, SkillInvocationContributor, ToolContributor, ToolLifecycleContributor, ApprovalReviewContributor, TurnItemContributor`，加 `TurnStartAdmission`、`UserInstructionsProvider`。`ext/` 下 16 个一等扩展（agent、guardian-v2、memories、web-search、image-generation、goal、queue、skills、mcp、connectors...）都通过这组 trait 挂进 core——**这是 codex 内部"插件化 core"的真正机制**，与用户可见的 plugin/hook 是两回事。

### 3.7 Rollout 持久化

- 文件：`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<YYYY-MM-DDThh-mm-ss>-<thread_id>[_<rollout_id>].jsonl`（`rollout/src/recorder.rs:1727-1737`，`rollout_file_name.rs:60-72`；归档移到 `archived_sessions/`，`lib.rs:84-85`），可 zstd 压缩（`rollout/compress`）。
- 每行 `RolloutLine{timestamp, ordinal?: u64, ...flatten(item)}`（`history/src/lib.rs:302-307`）；`RolloutItem` wire 形式 `{type: session_meta|response_item|compacted|turn_context|event_msg|token_usage_record|world_state|inter_agent_communication|retained_context|security_risk_score|realtime_item, payload: {...}}`（`history/src/rollout_payload.rs:23-60`）。
- `SessionMeta`（`protocol.rs:3117-3170`）：`session_id`(根线程 id)、`id`、`forked_from_id`、`forked_from_ordinal_exclusive`、`parent_thread_id`、`timestamp`、`cwd`、`originator`、`cli_version`、`source`、`model_provider`、`base_instructions`、`dynamic_tools`、`history_mode`、`history_base`(继承另一 rollout 的前缀，fork 用)、`creator_user_id/creator_account_id`。
- 持久化策略 `rollout/src/policy.rs:44-119`：`ResponseItem` 存 Message/Reasoning/FunctionCall(+Output)/CustomToolCall/WebSearchCall/Compaction 等；`EventMsg` 只存里程碑（`ItemCompleted`(paginated 模式全存)、`TokenCount`、`TurnStarted/Complete/Aborted`、`ThreadSettingsApplied`…），**delta 不落盘**。
- `ThreadHistoryMode::Paginated`（新）vs `Legacy`：paginated 把 `TurnItem` 完整写入 rollout，使 `thread/turns/list`、`thread/items/list` 可按游标读；legacy 需要在 resume 时从 ResponseItem 重建（`core/src/session/rollout_reconstruction.rs`）。`codex migrate-rollouts` 做迁移。
- 元数据索引：SQLite（`state/` crate，`rollout/src/state_db.rs`），`thread/list.useStateDbOnly` 可跳过 JSONL 扫描修复。
- **存储抽象** `thread-store/src/store.rs:88-530` `trait ThreadStore`：`create_thread / resume_thread / append_items / persist_thread / flush_thread / load_history / prepare_fork / revert_thread / read_thread / list_threads / list_turns / list_items / list_timeline / search_threads / archive / delete / thread_sections / attachments / projects`。crate 文档："Implementations are responsible for resolving that id to local rollout files, RPC requests, or any other backing store"。默认实现 `local/`（JSONL+SQLite）与 `in_memory.rs`。

### 3.8 Compaction

`core/src/compact.rs`：本地 compaction 用模型生成摘要，`COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`（`:60`），`run_inline_auto_compact_task`（自动触发）与 `run_compact_task`（`thread/compact/start` / `Op::Compact`），`build_compacted_history`（`:672`）把摘要 + 保留的用户消息拼成新历史；`compact_remote_v2.rs` 走服务端 compaction（Responses API 的 `Compaction` item，`MAX_RETAINED_AGENT_MESSAGE_TOKENS = 10_000`）。落盘为 `RolloutItem::Compacted{message, replacement_history, window_id/previous_window_id, compaction_response_id, latest_token_usage_record}`（`history/src/lib.rs:214-232`），resume 时从最后一个 compacted 起读，不必扫全文件。对外通知 `item/completed{type: contextCompaction}`。

---

## 4. 远程 / 云端形态

| 形态 | 代码 | 设计要点 |
|---|---|---|
| `codex exec` 非交互 | `exec/src/cli.rs`, `exec_events.rs:11-36` | `--json` 输出 JSONL：`thread.started, turn.started, turn.completed{usage}, turn.failed, item.started/updated/completed, error`；item 类型 `agent_message, reasoning, command_execution, file_change, mcp_tool_call, collab_tool_call, web_search, todo_list, error`（`:107-132`）。`--output-schema FILE`、`--output-last-message`、`--ephemeral`、`resume/fork/review` 子命令。**TS/Python SDK（`sdk/`）就是 spawn 这个 CLI 读 JSONL**（`sdk/typescript/README.md`），不是 app-server 客户端。 |
| `codex app-server --listen ws://` | §1.1 | 多连接 + 按线程订阅；JWT/capability token；单用户 |
| app-server daemon | `app-server-daemon/` | "Managed app-server lifecycle, serialized across CLI invocations and the updater"；`codex agents` 浏览共享 daemon 上的所有会话；重启后从 `$CODEX_HOME/app-server-daemon/loaded-threads.json` 恢复已加载线程（`transport/mod.rs:57-64`, `app-server/src/daemon_thread_recovery.rs`） |
| Remote control | `app-server-transport/src/transport/remote_control/` | 本地 app-server **出站**注册到 OpenAI relay（`protocol.rs:1-30` `EnrollRemoteServerRequest{name, os, arch, app_server_version, installation_id}` → `{server_id, environment_id, remote_control_token}`），配对码 pairing；手机/网页客户端经 relay 发同一套 JSON-RPC。类似 Claude Code Remote Control。 |
| **exec-server（远程执行环境）** | `exec-server/`, `exec-server-protocol/src/protocol.rs` | 独立 JSON-RPC 服务：`process/start|write|read|signal|terminate`、`fs/readFile|writeFile|readDirectory|walk|open|readBlock|...`、`http/request`、`environment/info|status`；本地 `ws://`，远程经 Noise 加密 relay（protobuf 帧带 `seq/ack/ack_bits/resume`，`README.md:110-135`）或 AWS SigV4 direct。app-server 侧 `environment/add{environmentId, execServerUrl}`，`thread/start.environments[] / turn/start.environments[]` 选择环境；`SandboxPolicy::ExternalSandbox` 配套。**这是 codex 把"agent 循环"与"代码执行沙箱"拆成两个进程/两台机器的正式接口。** |
| Codex Cloud | `cloud-tasks-client/src/api.rs:136` `trait CloudBackend{list_tasks, get_task_summary, get_task_diff, get_task_messages, apply_task, create_task, ...}` | 走 `chatgpt.com/backend-api/wham/tasks/*`，只是任务浏览/应用 diff，不暴露云端 agent 协议。云端复用 app-server 的痕迹：`thread/resume.history`、`experimentalRawEvents`、`rawResponseItem/completed`、`thread/list.originators`。 |

服务端部署相关的其他点：
- W3C trace context 随请求传（`JSONRPCRequest.trace`），Submission 也带 `trace`，`otel/` crate 导出。
- `server/diagnostics`、`/healthz`、`/readyz`。
- 配置分层 `ConfigLayerSource = PackagedDefaults | System | Mdm | EnterpriseManaged | User | Project | SessionFlags`（`host_roots.rs:118-125` 引用），企业托管配置可以锁死 `model_provider`/`model_providers`（README "Managed model provider requirements"）。
- Auth 模式 `AuthMode`（`common.rs:22-62`）：`apikey | chatgpt | chatgptAuthTokens(外部宿主注入) | headers | agentIdentity | personalAccessToken | bedrockApiKey | bedrockAccessKeys`。`headers` = "Backend auth supplied as request headers"，`agentIdentity` = 容器内 `CODEX_ACCESS_TOKEN` JWT——都是给托管环境用的。

---

## 5. 规模与许可证

- `LICENSE` Apache-2.0；`codex-rs/Cargo.toml:163 license = "Apache-2.0"`，edition 2024；`NOTICE`：Copyright 2025 OpenAI，含 Ratatui (MIT) 派生代码。
- 工作区 150 个 member crate（`Cargo.toml` `members`），Rust 总计约 **188 万行**，去掉 `*_tests.rs`/`tests.rs`/`tests/` 后约 **100 万行**。

| crate | 总行 | 非测试 | 作用 |
|---|---|---|---|
| tui | 413,854 | 278,845 | 终端 UI |
| core | 406,916 | 134,112 | 引擎 |
| app-server | 181,030 | 49,351 | RPC 服务 |
| exec-server | 58,052 | 31,700 | 远程执行环境 |
| core-plugins | 47,669 | 25,795 | 插件/marketplace |
| cli | 38,909 | 27,621 | |
| app-server-protocol | 35,355 | 34,279 | **对外协议类型（含 TS/JSON schema 导出）** |
| rmcp-client | 34,741 | 18,179 | |
| thread-store | 33,859 | 22,954 | 存储抽象 |
| protocol | 30,466 | 27,275 | 内部 SQ/EQ 类型 |
| network-proxy | 29,909 | 22,334 | |
| config | 29,540 | 22,248 | |
| windows-sandbox-rs | 28,227 | 24,599 | |
| codex-mcp | 24,287 | 12,698 | |
| state | 24,182 | 20,349 | SQLite |
| login | 20,916 | 9,793 | |
| app-server-transport | 18,433 | 14,583 | stdio/uds/ws/remote-control |
| rollout | 16,583 | 11,424 | JSONL |
| codex-api | 16,169 | 13,229 | Responses HTTP/WS 客户端 |
| hooks | 15,671 | 11,657 | |
| exec | 12,030 | 4,331 | `codex exec` |
| linux-sandbox | 11,847 | 7,042 | |
| sandboxing | 10,097 | 4,135 | |
| app-server-daemon | 9,408 | 6,627 | |
| model-provider / model-provider-info | 7,868 / 1,852 | 6,208 / 922 | |
| history | 3,000 | 2,435 | RolloutItem 类型 |
| skills | 2,594 | 1,520 | |
| exec-server-protocol | 2,574 | 2,310 | |
| ext/* (16 crates) | 62,438 | | 内部扩展 |

`app-server-protocol` 会导出 TypeScript（`schema/typescript/*.ts`，96 个文件）和 JSON Schema（`schema/json/`），这些生成物本身也是 Apache-2.0，可以直接拿来当 `agent-runner` 客户端类型的起点。

---

## 6. 可直接借鉴到 agent-runner 协议的部分

按 Apache-2.0 可以**逐字复制**（保留 LICENSE/NOTICE 与来源声明）的是 `app-server-protocol/src/protocol/v2/{thread_data,turn,item,shared,notification}.rs` 里的类型定义和 `schema/typescript/`、`schema/json/` 生成物；不应复制的是 ChatGPT 账号、Bedrock、realtime、Windows 沙箱、userVerification、remote control 这些与我们无关的分支。

### 6.1 资源命名（直接采用）

- 三级资源 `thread / turn / item`，id 全部 **UUIDv7**（时间有序，便于分页游标与分片）。`sessionId` 作为 fork 树根 id、`parentThreadId` 作为子 agent 归属——两个字段都保留。
- 方法命名 `<resource>/<verb>` + 子资源 `item/commandExecution/requestApproval` 这种"item 类型作为路径段"的风格，映射到 HTTP 就是：
  - `POST /threads`, `GET /threads?cursor&limit&sortDirection&archived&modelProviders[]&sourceKinds[]&cwd&projectId&searchTerm&parentThreadId`
  - `GET /threads/{id}`（`includeTurns`）、`POST /threads/{id}/resume|fork|archive|unarchive|compact|revert|interrupt`、`DELETE /threads/{id}`
  - `GET /threads/{id}/turns`、`GET /threads/{id}/items?turnId`（同一分页信封）
  - `POST /threads/{id}/turns`（= `turn/start`，返回 `{turn}`），`POST /threads/{id}/turns/{turnId}/steer`（带 `expectedTurnId` 前置条件），`POST /threads/{id}/turns/{turnId}/interrupt`
  - 审批作为一等资源：`POST /threads/{id}/approvals/{approvalId}` 回 `{decision}`；`GET /threads/{id}/approvals?pending=true` 对应 codex 的 `replay_requests_to_connection_for_thread`。
- `Thread.status = {type: notLoaded|idle|systemError|active{activeFlags:[waitingOnApproval|waitingOnUserInput]}}` 和 `Turn.status = inProgress|completed|interrupted|failed` 直接采用；这比 A2A 的 `input-required` 状态位更细，比 OpenCode 的 `session.idle` 更显式。

### 6.2 事件信封（采用 + 补一个序号）

- 通知形态 `{method, params, emittedAtMs}` 改成 SSE 的 `event: <method>` + `data: {threadId, turnId?, itemId?, ..., emittedAtMs}`；`method` 命名照抄：`thread/started`, `thread/status/changed`, `turn/started`, `turn/completed`, `turn/diff/updated`, `turn/plan/updated`, `item/started`, `item/completed`, `item/agentMessage/delta`, `item/reasoning/summaryTextDelta`, `item/commandExecution/outputDelta`, `item/fileChange/patchUpdated`, `item/mcpToolCall/progress`, `thread/tokenUsage/updated`, `serverRequest/resolved`, `hook/started|completed`, `error`, `warning`, `deprecationNotice`。
- **codex 缺的**：全局单调 `seq`。它靠单进程 per-thread listener 串行保证顺序；我们多副本必须给每条持久化事件一个 per-thread 单调 `seq`（可用 `thread/timeline/list.position` 的思路），SSE 用 `id: <seq>` + `Last-Event-ID` 重放。delta 类事件沿用 codex 的做法：**不落盘、不占 seq**（`rollout/src/policy.rs:94-119` 只持久化里程碑事件）。
- `item/started` 与 `item/completed` 都携带**完整 item 快照**而不是 patch——客户端实现简单，代价是重复字节；对 `commandExecution.aggregatedOutput` 这种大字段可以在 completed 里做截断 + 单独 `GET /items/{id}/output`。
- `initialize.capabilities.optOutNotificationMethods[]` → 我们的 SSE 订阅加 `?exclude=item/reasoning/*` 之类的过滤，省移动端流量。
- 时间戳统一用毫秒（codex 秒/毫秒混用是教训）。

### 6.3 Item 类型清单（裁剪后采用）

保留 `userMessage, agentMessage{phase: commentary|finalAnswer}, reasoning{summary[], content[]}, commandExecution, fileChange, mcpToolCall, dynamicToolCall(客户端工具), plan, webSearch, subAgentActivity, collabAgentToolCall, contextCompaction, functionCallOutput`；状态枚举 `inProgress|completed|failed|declined`（`declined` 用于审批被拒，比 AG-UI 只有 error 更准确）。删掉 `hookPrompt, imageView, sleep, imageGeneration, enteredReviewMode/exitedReviewMode`（或归入 `custom{kind}`）。`UserInput` 的 `text{text, textElements[]} | image | skill{name,path} | mention{name,path}` 也直接用，`skill`/`mention` 变体让 "@技能" 在协议层可见。

### 6.4 重放 / 断线恢复（照抄流程，换存储）

codex 的 resume 流程（`thread_lifecycle.rs:780-812`）是目前看到的最完整版本：

1. `thread/resume` 返回线程元数据 + 最近一页 turns（`initialTurnsPage`）+ 反向游标（`turnsBackwardsCursor / itemsBackwardsCursor`），**同一原子操作内把连接加入订阅**；
2. 补发 `thread/tokenUsage/updated`；
3. **重发所有未决审批请求**（原 `requestId` 不变）；
4. 之后事件正常流。
5. 任何客户端回答审批后广播 `serverRequest/resolved{threadId, requestId}`。

映射到 HTTP+SSE：`POST /threads/{id}/resume` → 响应体含快照与游标；随后 `GET /threads/{id}/events?after=<seq>` 打开流，服务端先 flush 挂起审批（作为带原 id 的事件重发），再 tail。多副本下"未决审批"必须落库（codex 只在内存 `request_id_to_callback`，`outgoing_message.rs:149-158`），这是我们要补的。

### 6.5 审批流（采用决策枚举与策略枚举）

- 决策：`accept | acceptForSession | acceptWithExecpolicyAmendment{rule} | decline | cancel`（decline=继续 turn，cancel=中断 turn）；文件改动 `accept | acceptForSession | decline | cancel`。`acceptForSession` 对应 ACP 的 `allow_always` 但作用域明确为 session；`Amendment` 让"以后都允许 `npm test`"变成可持久化的规则对象，值得做。
- 策略：`approvalPolicy = untrusted | on-request | never | granular{...}` + `sandbox = read-only | workspace-write | danger-full-access` 两个正交轴，在 `thread/start` 与 `turn/start` 都可覆盖且"对后续 turn 生效"。`approvalsReviewer = user | auto_review` 预留一个"由 LLM 子 agent 审"的插槽。
- 审批请求负载：`{threadId, turnId, itemId, approvalId?, startedAtMs, reason?, command?, cwd?, commandActions[]（结构化解析出的 read/write/search 动作）, proposedExecpolicyAmendment?, availableDecisions[]}`——`availableDecisions` 让服务端控制 UI 展示哪些按钮，直接抄。
- 超时：核心层 `ReviewDecision::TimedOut → decline`，我们在审批资源上加 `expiresAt`。

### 6.6 其他可搬的设计

- **`experimental` 分级**：方法/字段级 `#[experimental("thread/start.foo")]`，客户端 `initialize` 时声明 `experimentalApi` 才可见、schema 导出也按此过滤——用 OpenAPI 扩展 `x-experimental` 复现。
- **`thread/start.config{}` 任意配置覆盖 + `baseInstructions/developerInstructions` 分离 + `outputSchema` 约束最终回复**：BYOK 与多租户场景下，把 provider/model/sandbox/instructions 作为 thread 级可覆盖参数，turn 级再覆盖。
- **`dynamicTools` + `item/tool/call` 反向委托**：让 agent-router 侧或前端注册工具而无需 MCP 服务器；`deferLoading` + `namespace` 用于工具数量大时按需加载。
- **`environments[]` + exec-server 协议**：agent-runner 自己不执行代码，把 `process/*`、`fs/*`、`http/request` 委托给按租户隔离的 exec-server（容器内跑 `SandboxPolicy::ExternalSandbox`）。exec-server 的 JSON-RPC 方法表和 relay 帧的 `seq/ack/resume` 语义可直接借用。
- **`ThreadStore` trait**（`thread-store/src/store.rs:88-530`）作为存储接口签名参考：`create/resume/append_items/persist/flush/load_history/prepare_fork/revert/read/list/list_turns/list_items/search/archive/delete` + sections/attachments/projects。我们实现成 Postgres/对象存储，但方法面与参数结构照抄可以少踩坑。
- **Rollout 记录形态** `{timestamp, ordinal, type, payload}` + `Compacted{replacement_history, window_id, latest_token_usage_record}`：resume 从最后一个 compacted 起读，token 用量快照随 compaction 保存——直接用于我们的事件表设计。
- **Skills 发现层级** `Admin(/etc) > System cache > User(~/.agents/skills) > Repo(.agents/skills, .codex/skills)` 与 `SkillMetadata.dependencies.tools[]`（声明所需 MCP）——多租户下把 Admin/User 换成"平台/租户/用户"三级即可。
- **Hook 事件名**与 Claude Code 完全一致（`PreToolUse/PostToolUse/PermissionRequest/PreCompact/PostCompact/SessionStart/UserPromptSubmit/SubagentStart/SubagentStop/Stop/Interrupt`），我们沿用同一命名可以兼容两家的 hook 配置。

### 6.7 不要抄的

- 单 `AuthManager`/单 `CODEX_HOME` 的连接鉴权模型（`ConnectionAuth.owner_generation`）——我们需要 per-request principal。
- 秒/毫秒混用的时间戳；无 seq 的通知流；内存态未决审批表。
- `WireApi` 只支持 Responses：国内 chat/completions 模型需要自建适配层，codex 的 `codex-api` 客户端无法复用。
- Realtime/voice、userVerification、Windows 沙箱、ChatGPT 账号/rate-limit/credits 相关的 40+ 个方法。
