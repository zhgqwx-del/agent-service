# 开源 / 商用 Agent 服务端协议横向调研（2026-09-22）

> 目的：为 agent-runner 的对外 API 选型提供参照。每节按「资源命名 · 事件信封 · 断线恢复 · 审批流 · 许可证」记录。标注 **[未核实]** 的条目未能从一手资料确认。

## 1. Agent Client Protocol (ACP) — Zed
https://agentclientprotocol.com/protocol/overview · Apache-2.0

- 传输：JSON-RPC 2.0，agent 必须支持 stdio（客户端 spawn agent 子进程），HTTP/SSE 可选。`protocolVersion=1`。
- 客户端→agent：`initialize`, `authenticate`, `session/new|prompt|load|resume|list|close|delete|set_mode|set_config_option`；通知 `session/cancel`。
- agent→客户端：`session/request_permission`, `fs/read_text_file`, `fs/write_text_file`, `terminal/*`, `elicitation/create`；通知 `session/update`。
- 命名：只有 `sessionId`；一个 turn = 一次 `session/prompt` 请求到响应。无 run/thread 对象。
- 信封：`session/update{sessionId, update:{sessionUpdate: agent_message_chunk|agent_thought_chunk|user_message_chunk|tool_call|tool_call_update|plan|available_commands_update|current_mode_update|config_option_update}}`。`tool_call{toolCallId,title,kind(read|edit|delete|move|search|execute|think|fetch|switch_mode|other),status(pending|in_progress|completed|failed),content[],locations,rawInput,rawOutput}`。`session/prompt` 响应 `{stopReason: end_turn|max_tokens|max_turn_requests|refusal|cancelled}`。
- 恢复：`session/load` 由 agent **重放全部历史**为 `session/update` 后再应答；`session/resume` 不重放直接重连。
- 审批：`session/request_permission{toolCall, options[{optionId,name,kind: allow_once|allow_always|reject_once|reject_always}]}` → `{outcome:{outcome:"selected",optionId}}` 或 `cancelled`。

## 2. A2A — Linux Foundation（Google 贡献）
https://a2a-protocol.org · Apache-2.0

- v1.0 proto-first，三种绑定：JSON-RPC / gRPC / REST。操作：`SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`, push-notification config CRUD, `GetExtendedAgentCard`。
- 命名：`Task{id, contextId, status{state,message,timestamp}, artifacts[], history[]}`；`Message{role, parts[], messageId, taskId, contextId}`；`Part: text|file|data`。`contextId` ≈ thread。
- 状态：`submitted, working, input-required, completed, canceled, failed, rejected, auth-required`。
- 流：SSE，每条 `data:` 是 `Task | Message | TaskStatusUpdateEvent{final} | TaskArtifactUpdateEvent{append,lastChunk}`。
- 恢复：`SubscribeToTask` 重开 SSE，**无游标重放**，只拿当前 Task + 后续事件。
- 审批：无 RPC，靠 `input-required` 状态 + 再发一条同 `taskId` 的消息。
- 发现：`/.well-known/agent-card.json`。

## 3. AG-UI — CopilotKit
https://docs.ag-ui.com · MIT

- 命名：`threadId`（会话）、`runId`（一次执行）、`parentRunId`。**无服务端 session 对象**，客户端持有 `messages` 与 `state`。
- 输入 `RunAgentInput{threadId, runId, state?, messages[], tools[], context[], forwardedProps, resume?}`。
- 传输：HTTP POST，响应 SSE 或 protobuf（`application/vnd.ag-ui.event+proto`）。
- 事件：`RUN_STARTED/FINISHED/ERROR`, `STEP_STARTED/FINISHED`, `TEXT_MESSAGE_START/CONTENT/END/CHUNK`, `TOOL_CALL_START/ARGS/END/CHUNK/RESULT`, `STATE_SNAPSHOT`, `STATE_DELTA`（RFC6902）, `MESSAGES_SNAPSHOT`, `REASONING_*`, `ACTIVITY_*`, `SUBAGENT_*`, `RAW`, `CUSTOM`。
- 恢复：无服务端重放；客户端下一轮重发完整 `messages+state`。
- 审批：无内置 RPC，用客户端工具调用或 `resume[]`。

## 4. Vercel AI SDK UI Message Stream Protocol (v5+)
https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol · Apache-2.0

- SSE，头 `x-vercel-ai-ui-message-stream: v1`，每条 `data:` 是一个 part，终止 `data: [DONE]`。
- Part：`start{messageId}`, `finish`, `abort`, `start-step`, `finish-step`, `text-start/-delta/-end{id}`, `reasoning-*`, `source-url`, `file`, `tool-input-start/-delta/-available/-error`, `tool-approval-request{toolCallId,approvalId}`, `tool-approval-response`, `tool-output-available/-error/-denied`, `data-*`（带 `id` 做 reconcile，`transient:true` 不持久化）, `message-metadata`, `error`。
- 恢复：`useChat({resume:true})` → `GET /api/chat/[id]/stream`；服务端用 `resumable-stream`（Redis pub/sub）保留活跃流；无活跃流返回 204。客户端断开 ≠ 取消。
- 审批：`needsApproval` 工具 → `tool-approval-request` → `addToolApprovalResponse` → `tool-output-available|denied`。

## 5. OpenAI Responses API + Conversations API
https://developers.openai.com/api/docs/guides/streaming-responses · 专有 API，SDK Apache-2.0

- 命名：`response`（一个 turn，`resp_`）、`item`（`msg_`/`fc_`/`rs_`）、`conversation`（`conv_`）。
- Items：`message`, `function_call`, `function_call_output`, `reasoning`, `mcp_call`, `custom_tool_call`, `shell_call`, 各类内置工具 call；`status: in_progress|completed|incomplete`。
- 流：SSE，每个事件带 `type` + 单调递增 `sequence_number`。`response.created/queued/in_progress/completed/failed/incomplete`, `response.output_item.added/done`, `response.content_part.added/done`, `response.output_text.delta/done`, `response.function_call_arguments.delta/done`, `response.reasoning_*`, `response.mcp_*`, `error`。
- 状态链：`previous_response_id`（`store:true`，30 天）或 `conversation`。Conversations API：`POST /v1/conversations`, `GET|POST /v1/conversations/{id}/items`（分页 `after/limit/order`）。
- 后台 + 恢复：`background:true` → `GET /v1/responses/{id}?stream=true&starting_after=<sequence_number>`；`POST /v1/responses/{id}/cancel`。
- 审批：MCP `require_approval` → `mcp_approval_request` item → `mcp_approval_response` 输入项。

## 6. Anthropic Claude Managed Agents（beta）
https://platform.claude.com/docs/en/managed-agents/overview · 专有

- 资源：`agents`（版本化：model/system/tools/mcp_servers/skills）、`environments`、`sessions`、session `events`、`threads`（多 agent）、`vaults`、memory stores、webhooks。
- Session：`POST /v1/sessions{agent, environment_id, initial_events?, budget?}`；状态 `idle|running|rescheduling|terminated`。
- 输入事件：`POST /v1/sessions/{id}/events{events:[user.message | user.interrupt | user.tool_confirmation{tool_use_id, result: allow|deny} | user.custom_tool_result | user.define_outcome | system.message]}`。每个持久化事件有 `id(sevt_)` 和 `processed_at`。
- 流：`GET /v1/sessions/{id}/events/stream`，每条 `data:` 是一个事件 `{type,id,...}`。输出类型：`agent.message`, `agent.thinking`, `agent.tool_use{evaluated_permission}`, `agent.tool_result`, `agent.mcp_tool_use/_result`, `agent.custom_tool_use`, `agent.thread_context_compacted`, `session.status_running/idle{stop_reason}/rescheduled/terminated`, `session.error`, `session.usage`, `span.model_request_start/end`。可选 token 级 `event_start/event_delta`（只在流里，不持久化）。
- `stop_reason.type`: `end_turn | requires_action{event_ids[]} | max_tokens | max_turns | budget_reached`。
- 恢复：全量历史持久化，`GET /v1/sessions/{id}/events`（分页、`types[]`）。推荐「先开流、再列历史、按 id 去重、再 tail」。流本身**无 Last-Event-ID 游标**。
- 审批：工具策略 `always_ask` → `agent.tool_use{evaluated_permission:"ask"}` → `session.status_idle{requires_action}` → `user.tool_confirmation`。

## 7. LangGraph Platform / Agent Server
https://docs.langchain.com/langsmith/agent-server-api · `langgraph` MIT，**`langgraph-api` 服务端 Elastic License 2.0**

- 资源：`assistants`、`threads`（checkpointer 持久化）、`runs`、`store`、`crons`。
- 端点：`POST /threads`, `POST /threads/search`, `GET|POST /threads/{id}/state`, `POST /threads/{id}/history`, `POST /threads/{id}/runs`（后台）, `.../runs/stream`, `.../runs/wait`, `GET .../runs/{run_id}`, `.../join`, `GET .../runs/{run_id}/stream`（加入流）, `.../cancel`；无状态 `POST /runs[/stream|/wait]`。
- Run body 亮点：`input` xor `command{update,resume,goto}`，`stream_mode`（values|updates|messages|events|custom|debug|tasks|checkpoints），`stream_resumable`，`on_disconnect: cancel|continue`，`multitask_strategy: reject|interrupt|rollback|enqueue`，`if_not_exists: reject|create`，`webhook`，`after_seconds`。
- 状态：run `pending|running|error|success|timeout|interrupted`；thread `idle|busy|interrupted|error`。
- 恢复：`stream_resumable:true` + `GET .../runs/{run_id}/stream` 带 `Last-Event-ID`（`-1` 全量重放）。
- HITL：`interrupt(value)` → run `interrupted` → 新 run 带 `command.resume`。

## 8. Claude Agent SDK / Claude Code stream-json
https://code.claude.com/docs/en/agent-sdk · SDK MIT，CLI 专有

- `query(prompt, options) -> AsyncIterator[Message]`；`ClaudeSDKClient` 持会话。
- 消息类型（= `--output-format stream-json`）：`system{subtype:init, session_id}`、`assistant{content:[text|thinking|tool_use]}`、`user`（tool result；子 agent 消息带 `parent_tool_use_id`）、`result{subtype, total_cost_usd, usage, permission_denials}`、`stream_event{event:<原生 SSE>}`。
- 选项：`resume`, `continue_conversation`, `fork_session`, `session_id`, `permission_mode: default|acceptEdits|plan|dontAsk|bypassPermissions|auto`, `can_use_tool(...) -> Allow{updated_input}|Deny{message,interrupt}`, `hooks{PreToolUse|PostToolUse|UserPromptSubmit|Stop|SubagentStop|PreCompact|Notification|SessionStart|SessionEnd|PermissionRequest|Elicitation}`, `max_turns`, `mcp_servers`, `setting_sources`, `session_store` 适配器（跨主机恢复）。
- 持久化：`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`。
- Remote Control：本地进程只出站 HTTPS，注册到 Anthropic 后轮询；无公开线协议。

## 9. OpenCode `opencode serve`
https://opencode.ai/docs/server/ · MIT · repo 已迁至 anomalyco/opencode

- Hono；`OPENCODE_SERVER_PASSWORD` 基础认证；OpenAPI 3.1 在 `GET /doc`。
- 命名：`session`（id, parentID, share）、`message`（role, parts[]）、`part`（text|reasoning|tool{state: pending|running|completed|error}|step-start|step-finish|file|snapshot|patch）、`permission`。无 run 对象，`session.idle` 标记 turn 结束。
- 路由：`GET /global/health|event`, `GET /event`, `GET|POST /session`, `GET|PATCH|DELETE /session/:id`, `/session/:id/children|todo|abort|fork|share|revert|summarize`, `POST /session/:id/permissions/:permissionID{response: once|always|reject}`, `GET|POST /session/:id/message`, `POST /session/:id/prompt_async`, `/session/:id/command|shell`, `GET|PATCH /config`, `GET /config/providers`, `GET /provider[/auth]`, `PUT /auth/:id`, `GET /agent`, `GET|POST /mcp`, `GET /lsp|formatter|find|file|project|path|vcs|command`, `POST /instance/dispose`, `/tui/*`。
- 事件总线：进程级单 `Bus`；`GET /event` 订阅当前 instance 全部事件，`GET /global/event` 跨 instance。首个事件 `server.connected`，之后 `data:{type, properties}`。类型：`session.created/updated/deleted/idle/error/compacted/diff`, `message.updated/removed`, `message.part.updated/delta/removed`, `permission.asked/replied/updated`, `file.edited`, `file.watcher.updated`, `lsp.client.diagnostics`, `todo.updated`, `tui.*`。客户端按 `properties.sessionID` 过滤。
- 恢复：**总线无游标**；重连后 `GET /session/:id/message` 重建，再 tail `/event`。
- 审批：`permission.asked{id, sessionID, title, metadata}` 阻塞直到 `POST /session/:id/permissions/:id`。

## 横向对比

| | 会话/线程 | 一次执行 | 条目 | 流信封 | 重放游标 | 审批 RPC |
|---|---|---|---|---|---|---|
| ACP | `sessionId` | prompt turn → `stopReason` | tool_call / message chunk | JSON-RPC `session/update` | `session/load` 重放历史 | `session/request_permission` |
| A2A | `contextId` | `Task` | Message / Artifact / Part | JSON-RPC over SSE，`final` | `SubscribeToTask` 无游标 | 无；`input-required` |
| AG-UI | `threadId` | `runId` | messages / tool calls | 类型化事件，SSE 或 protobuf | 无；客户端重发 | 无；客户端工具 |
| AI SDK | chat id / `messageId` | step | parts | SSE `{type}` + `[DONE]` | `resume:true` + Redis | `tool-approval-request/response` |
| OpenAI | `conversation` / `previous_response_id` | `response` | `item` | SSE + `sequence_number` | `starting_after=N` | MCP approval items |
| Managed Agents | `session`（+`thread`） | 到 `session.status_idle` | events (`sevt_`) | SSE `{type,id}` | 列历史 + id 去重 | `user.tool_confirmation` |
| LangGraph | `thread_id` | `run_id` | checkpoints | SSE `event:/data:` | `Last-Event-ID` | `interrupt()` + `command.resume` |
| Claude SDK | `session_id` | turn → `result` | content blocks | NDJSON | `--resume` 从 jsonl | `can_use_tool` / hooks |
| OpenCode | `session` | 到 `session.idle` | message → parts | SSE `{type, properties}` 全局总线 | 无；重新 GET | `POST .../permissions/:id` |

## 对 agent-runner 协议设计的启发

1. **需要一个显式的 run/turn 资源**。OpenCode 和 ACP 没有 run 对象，导致「取消谁」「重放谁」「计费归谁」都靠 session 隐式承担；LangGraph / AG-UI / OpenAI 都有。建议 `session → turn → item/event` 三级。
2. **事件必须有单调游标**。OpenAI 的 `sequence_number`、LangGraph 的 `Last-Event-ID`、prior PoC 的 `seq` 是同一件事。OpenCode 的全局总线无游标是服务端多副本下最先崩的点。
3. **审批要做成一等资源**（有 id、可列出、可超时），而不是像 A2A 那样退化为状态位。ACP 的 `allow_once|allow_always|reject_once|reject_always` 四选项与 OpenCode 的 `once|always|reject` 基本等价，可以直接采用。
4. **Managed Agents 的「先开流、再列历史、按 id 去重」+ `requires_action{event_ids}`** 是唯一同时解决了「多 turn 挂起等审批」和「断线」的设计，值得借鉴到 turn 状态机里。
5. **AI SDK 的 `transient` 事件**（不持久化的 delta）与 prior 方案的「heartbeat 不占 seq」是同一原则：token 级 delta 走流不落库，里程碑事件才持久化。
6. **Agent 定义要版本化**（Managed Agents 的 `agents` 资源）：多租户下 system prompt / tools / mcp / skills 的组合必须是可引用、可回滚的对象，而不是每次请求传一坨配置。
