# API 完备性评审（对照 `docs/design/00-architecture.md` §5 / §7 / §11 / §14）

> 评审对象：`apps/agent-runner`（M1 已宣称完成）+ `packages/protocol|core|store|providers`。
> 评审时间：2026-09-26。评审口径：**外部客户端**（只有 HTTP + 本文档，没有源码）能否照 §5 写出正确的客户端。
> 结论一句话：M1 的**会话/轮次/事件/审批主干可用**，但对外协议在四处**与文档不一致且会让客户端写错**（流式错误一律 200、`model` 字段形状、`busyPolicy=queue` 静默降级、`image`/`skill`/`mention` 输入被静默丢弃），另有**用户级隔离未实现**、**无 OpenAPI/SDK**（§11 明确列在 M1 交付里）。

---

## 1. 端点矩阵（§5.2 逐行）

图例：✅ 已实现 · ◐ 部分实现 · ✖ 未实现。"归属"按 §11 里程碑判定。

### 1.1 Agent 定义

| 设计端点 | 状态 | 证据 | 归属 |
|---|---|---|---|
| `POST /v1/agents` | ✅ | `apps/agent-runner/src/app.ts:67`（201 + 定义快照，`version=1`） | M1 |
| `GET /v1/agents` | ◐ | `app.ts:73`：分页有 `cursor/limit`，但 `Pagination.sortDirection`（`packages/protocol/src/common.ts:103`）被忽略 | M1 |
| `GET /v1/agents/{id}` | ✅ | `app.ts:77`，支持 `?version=`（文档未写此参数） | M1 |
| `PUT /v1/agents/{id}` | ✅ | `app.ts:83`，`version = prev.version + 1`，新版本另存 | M1 |
| `GET /v1/agents/{id}/versions` | ✖ | 无路由；`SessionStore` 也没有 `listAgentVersions`（`packages/store/src/types.ts:83-85` 只有 create/get/list） | **M1 scope**（§5.2 明确列出、DDL `agent_versions` 已在 `packages/store/migrations/0001_init.sql:19` 存在，补一个查询即可） |

### 1.2 Session

| 设计端点 | 状态 | 证据 | 归属 |
|---|---|---|---|
| `POST /v1/sessions` | ✅ | `app.ts:110` → `host.createSession`（`packages/core/src/session/host.ts:131`） | M1 |
| `GET /v1/sessions?cursor&limit&userId` | ◐ | `app.ts:115`。`cursor/limit/userId` 生效，但**`userId` 无授权校验**（见 §5.2）；`sortDirection` 被忽略；额外支持文档未声明的 `includeArchived` | M1 |
| `GET /v1/sessions/{id}` | ◐ | `app.ts:119`。只按 `tenantId` 校验（`host.ts:162`），**未按 §5.1 的 `principal=(tenantId,userId)` 校验** | M1 |
| `DELETE /v1/sessions/{id}` | ◐ | `app.ts:120`。MySQL 是软删（`packages/store/src/mysql/store.ts:142-146`，置 `deleted_at_ms`），memory 是硬删（`packages/store/src/memory.ts:83-91`）→ 两个实现语义不一致；且不中断进行中的 turn、不释放租约、`events/items/turns/approvals` 不做任何标记 | M1（一致性）/ M4（清理任务） |
| `POST .../archive` | ✖ | 无路由。底层能力已具备：`CommitBatch.sessionPatch.archivedAtMs`（`store/src/types.ts:42`）、DDL 列、`listSessions(includeArchived)` 都在——只差一个端点，现状是"归档字段存在但永远为空" | **M1 scope**（低成本，且 `includeArchived` 参数目前是死参数） |
| `POST .../fork` | ✖ | 无路由；`Session.parentSessionId`（`protocol/src/session.ts:25`）与 `CreateSessionRequest.parentSessionId`（同 :72）已预留，但没有历史拷贝逻辑 | M2/M3（§5.2 未标里程碑，fork 语义牵涉 items 复制与 seq 重排，建议排 M3） |
| `POST .../compact` | ✖ | 无路由，无摘要级压缩。只有便宜级裁剪 `pruneToolResults`（`packages/core/src/context/history.ts:107`）；`ContextCompactionItem` schema 与投影都在（`history.ts:63`），但**没有任何代码生产它** | **M1 收尾**（`docs/PROGRESS.md:20` 已自认） |
| `POST .../resume` | ◐ | `app.ts:125`。返回 `{session, recentTurns, pendingApprovalIds, lastSeq}`。**但没有做 §4.3 / codex 要求的"重发未决 `approval/requested`"**，只给了 id 列表；客户端拿到 id 后无法得知 `toolName/args/expiresAt`（要再打 `GET .../approvals`） | ◐ M1 |

### 1.3 Turn / Item / Event / Approval

| 设计端点 | 状态 | 证据 | 归属 |
|---|---|---|---|
| `POST /v1/sessions/{id}/turns`（`stream=true` → SSE） | ◐ | `app.ts:132-178`。SSE 主干正确（先订阅后启动、`session/status/changed{idle}` 关流）。**缺陷见 §5.1：流已开始后的所有错误都变成 HTTP 200 + `error` 事件（且 `seq:0`）** | ◐ M1 |
| 同上（`stream=false` → 202 + turnId） | ✅ | `app.ts:148-151`，返回 `202 {turn, steered}` | M1 |
| `GET .../turns` | ✅ | `app.ts:179`，`cursor/limit/sortDirection` 全生效（`store/src/mysql/store.ts:217`） | M1 |
| `GET .../turns/{turnId}` | ✅ | `app.ts:184` | M1 |
| `POST .../turns/{turnId}/interrupt` | ✅ | `app.ts:190` → `host.interrupt`（`host.ts:570`），等 `state.done` 后回最终 turn | M1 |
| `POST .../turns/{turnId}/steer` | ✅ | `app.ts:191`，202；`expectedTurnId` 前置校验（`host.ts:562`） | M1 |
| `POST .../turns/{turnId}/tool-results`（动态工具回填） | ◐ | `app.ts:196`。**§5.2 的端点表里根本没有这个端点**；§7.1 承诺的是 `POST .../items/{id}/result`。且路径里的 `turnId` 被完全忽略（按 `sessionId+toolCallId` 定位，`host.ts:591`） | 文档需更正 |
| `GET .../items?turnId&cursor` | ◐ | `app.ts:205`。**没有 `cursor`**，改用 `afterSeq`；返回 `{data}` 无 `nextCursor`，`limit` 上限 1000（与 `Pagination` 的 200 不一致）→ 客户端无法按统一分页协议翻页 | ◐ M1 |
| `GET .../items/{itemId}/output`（大输出） | ✖ | 无路由。`Item.outputRef`（`protocol/src/item.ts:66`）永远为空：`FsBlobStore` 在 `apps/agent-runner/src/main.ts:14` 被 `void new FsBlobStore(...)` **实例化后直接丢弃**，从未注入 `SessionHost` | **M1 收尾**（大工具输出现在整段塞进 `items.body` JSON） |
| `GET .../events?after=&exclude=` | ◐ | `app.ts:210`，`Last-Event-ID` 已接（`app.ts:214`，Hono header 大小写不敏感）。`exclude` 不校验白名单，见 §5.3 | ◐ M1 |
| `GET .../approvals?pending=true` | ✅ | `app.ts:220` | M1 |
| `POST .../approvals/{approvalId}` | ◐ | `app.ts:224`。四档决策齐全（`host.ts:535`）。但只有**当前 runner 内存里有 pending** 才能决策，否则抛 `session_lease_conflict`（`host.ts:544`）——单节点没问题，多节点必须靠 router | M1 ok / M2 依赖 |

### 1.4 Provider / 工具 / 扩展 / 全局

| 设计端点 | 状态 | 证据 | 归属 |
|---|---|---|---|
| `GET /v1/providers` | ✅ | `app.ts:93`，租户 BYOK + 平台 preset 合并（`packages/providers/src/service.ts:69`），`apiKey` 只写不读 | M1 |
| `PUT /v1/providers/{id}` | ✅ | `app.ts:94` | M1 |
| `DELETE /v1/providers/{id}` | ✅ | `app.ts:98` | M1 |
| `POST /v1/providers/{id}` | ✖ | 无；PUT 即 upsert（`service.ts:53`）。**`README.md:49` 声称有 `GET /v1/providers/{id}`，实际没有单条 GET 路由** | 文档需更正 |
| `GET /v1/models` | ✅ | `app.ts:103`，按 principal 可见 provider 展开 | M1 |
| `GET /v1/tools` | ◐ | `app.ts:107`。目前只有 2 个内置工具：`current_time`、`web_fetch`（`packages/core/src/tools/builtin/index.ts:6,39`）。§7.1 承诺的 `http_request`（SSRF 白名单）与"结构化数据工具"**未实现**；返回体没有 MCP / 动态工具（符合现状） | ◐ M1（`http_request`）/ M3（MCP） |
| `POST/GET/DELETE /v1/mcp-servers`、`.../tools`、`.../refresh` | ✖ | 无任何 MCP 代码（全仓 `grep -i mcp` 只命中 schema 里的 `mcpServers` 字段与 id 前缀）。`AgentDefinition.mcpServers`（`protocol/src/agent.ts:32`）被接受但**完全无效** | M3（§11 明确） |
| `POST/GET/DELETE /v1/skills`、`GET /v1/skills/{name}` | ✖ | 无。`SkillSource` 接口预留（`host.ts:37-39`），`main.ts` 从不注入 → `skills` 恒为 `[]`；`AgentDefinition.skills` 被接受但无效 | M3（§11 明确） |
| `GET /v1/usage?sessionId\|userId&from&to` | ✖ | 无路由。数据已入账（`host.ts:426` → `store.appendUsage`，DDL `usage_ledger` + 两个时间索引已建）；`SessionStore` 没有任何 usage **读**方法 | **M1 收尾**（`docs/PROGRESS.md:21` 已自认；只差一个查询方法 + 端点） |
| `GET /healthz` | ✅ | `app.ts:53` | M1 |
| `GET /readyz` | ◐ | `app.ts:54`，drain 时 503（`main.ts:42` 置 `ready=false`）。只反映 drain，不反映 MySQL/Redis 可达性——刚启动、DB 断开时仍回 `ready` | ◐ M1 / M4 |
| `GET /v1/capabilities` | ◐ | `app.ts:55`。字段**硬编码**：`mcp:[]`、`skills:false` 与现状一致，但 `replay.hotWindowMs: 3_600_000` 在 memory bus（无 Redis）下不成立，`dynamicTools:true/byok:true` 不随配置变化 | ◐ M1 |
| `GET /metrics` | ✖ | 无。全仓无 prometheus / OTel 依赖（`package.json` 只有 hono/zod/mysql2/ioredis 系） | M4（§11），但 §5.2 把它列进对外协议表 → 文档需标注里程碑 |
| `GET /openapi.json` | ✖ | 无。`package.json` 未引入 `@hono/zod-openapi`（§10 选型里写了）；`packages/sdk/` 目录不存在 | **M1 scope**（§11 M1 交付栏第一项就是"协议包 + OpenAPI"；`docs/PROGRESS.md:15` 却把它排到了 M2） |

### 1.5 未在 §5.2 声明、但已实现的端点

| 端点 | 证据 | 处理建议 |
|---|---|---|
| `POST .../turns/{turnId}/tool-results` | `app.ts:196` | 写进 §5.2 Turn 行（并与 §7.1 的 `items/{id}/result` 统一措辞） |
| `GET /v1/sessions?includeArchived=` | `app.ts:116` | 与 `archive` 端点一起补进文档 |
| `GET /v1/agents/{id}?version=` | `app.ts:78` | 写进文档 |

---

## 2. 事件类型矩阵（§5.4 逐行 vs `packages/protocol/src/event.ts` vs `host.ts` 实际 emit）

| 设计事件 | schema 声明 | 实际发出 | 证据 |
|---|---|---|---|
| `session/created` | ✅ `event.ts:22` | ✅ | `host.ts:156` |
| `session/status/changed` | ✅ `event.ts:23` | ✅ | `host.ts:298`（active）/ `host.ts:631`（idle）/ `host.ts:490-496` / `host.ts:522`（waitingOnApproval 进出） |
| `session/compacted` | ✅ `event.ts:24` | **✖ 从不发出** | 全仓无 `type: "session/compacted"`。压缩未实现（§1.2 `POST .../compact`） |
| `turn/started` | ✅ `event.ts:26` | ✅ | `host.ts:296` |
| `turn/completed{status,stopReason}` | ✅ `event.ts:28`（`stopReason` 为顶层字段，`status` 在 `turn.status` 里） | ✅ | `host.ts:630`。`StopReason` 比文档多一个 `max_output_tokens`（`common.ts:94`），文档 §5.4 未列 |
| `turn/steered` | ✅ `event.ts:27` | ✅ | `host.ts:566` |
| `item/started` / `item/completed` | ✅ `event.ts:35-36` | ✅ | `host.ts:375,398,412,447,451,494` 等 |
| `item/*` 的 type 枚举 | ◐ | — | 文档列 `mcpToolCall \| dynamicToolCall \| plan \| subAgentActivity`，**schema 里都没有**（`item.ts:94-103` 只有 8 种）；MCP/动态工具统一折叠成 `toolCall{kind: builtin\|mcp\|dynamic\|skill}`（`item.ts:24,53`）。反过来 schema 多一个文档未声明的 `systemNotice`（`item.ts:86`） |
| `item/agentMessage/delta` | ✅ `event.ts:57`（live） | ✅ | `host.ts:379` |
| `item/reasoning/delta` | ✅ `event.ts:58` | ✅ | `host.ts:384` |
| `item/toolCall/argsDelta` | ✅ `event.ts:59` | ✅ | `host.ts:388`。**信封被复用出了问题**：`itemId` 填的是 `state.agentItemId`（agentMessage 的 item），`toolCallId` 塞进 `delta` 字符串前缀（`${toolCallId}:${delta}`），客户端无法按 schema 解析 |
| `item/mcpToolCall/progress` | **✖ schema 未声明** | ✖ | §5.4 声明了；`event.ts` 无此成员；`EngineSink.onToolProgress` 存在但 host 实现是空函数（`host.ts:437`） |
| `approval/requested` / `approval/resolved` | ✅ `event.ts:38-39` | ✅ | `host.ts:495,520` |
| resume 时重发未决 `approval/requested` | — | ✖ | `app.ts:125` 只回 id 列表 |
| `usage/updated` | ✅ `event.ts:41` | ✅ | `host.ts:419`，每 step 一次，含 cache read/write 归一化字段 |
| `hook/started` / `hook/completed` | **✖ schema 未声明** | ✖ | 全仓无 hook 代码（§7.5 整节未实现）→ M3 |
| `warning` | ✅ `event.ts:53` | **✖ 从不发出** | 全仓无 `type: "warning"`。按 §6.5 应至少在"thinking 丢弃""工具修复（`projectItems.repaired`）"时发；现在只写 `log.warn`（`host.ts:263`） |
| `error` | ✅ `event.ts:54` | ◐ | `host.ts:629`（turn 失败）+ `app.ts:169`（流内启动失败，**伪造 `seq: 0`**，见 §5.1） |
| `heartbeat` | ✅ `event.ts:60` | ✅ | `apps/agent-runner/src/sse.ts:52`，10s，不带 `id:` |

**声明但永不发出**：`session/compacted`、`warning`。
**文档声明但 schema 里没有**：`item/mcpToolCall/progress`、`hook/started`、`hook/completed`，以及 item 的 `mcpToolCall/dynamicToolCall/plan/subAgentActivity` 四种类型。
**发出但文档未声明**：item 类型 `systemNotice`；`StopReason.max_output_tokens`。

---

## 3. 错误码矩阵（§5.5 vs `packages/protocol/src/errors.ts` vs 实际抛出点）

| 码 | 状态码 | 声明 | 可达性 | 证据 |
|---|---|---|---|---|
| `invalid_request` | 400 | §5.5 ✅ | ✅ 可达 | `app.ts:38`（zod 校验）、`auth.ts:32`（缺 `X-User-Id`）、`host.ts:237`、`providers/src/service.ts:100`（模型不在 provider 里） |
| `unauthorized` | 401 | §5.5 ✅ | ✅ | `auth.ts:19,21` |
| `not_found` | 404 | §5.5 ✅ | ✅ | 多处；跨租户与不存在同码（`host.ts:162`，有测试） |
| `session_busy` | 409 | §5.5 ✅ | ◐ **只在同 runner 内存里有活跃 turn 且 `busyPolicy≠steer` 时可达**（`host.ts:233`）。`busyPolicy=queue` 走同一分支 → 见 §4。跨 runner 的忙碌返回的是 `session_lease_conflict` 而不是 `session_busy` | `host.ts:225-234` |
| `session_lease_conflict` | 409 | §5.5 ✅（标"内部"） | ✅ 可达 | `host.ts:241`（抢租约失败）、`host.ts:544`（审批在别的 runner）、`host.ts:577`（interrupt 在别的 runner）。**但 §4.2 要求的响应头 `X-Owner` 全仓不存在**，`ownerAddr` 只在 `error.details` 里 → router 的重路由契约未落地 |
| `idempotency_conflict` | 409 | §5.5 ✅ | ✅ | `app.ts:140,142` |
| `limits_exceeded` | 422 | §5.5 ✅ | **✖ 不可达**（全仓无抛出点）。安全阀不是拒绝请求，而是优雅终止 turn（`turn/completed{stopReason: max_steps\|...}`，`host.ts:604-612`） | — |
| `quota_exceeded` | 429 | §5.5 ✅ | **✖ 不可达**：无配额/熔断实现（§7.4 的 key 池与三级配额未写） | M4 |
| `provider_error` | 502 | §5.5 ✅ | **✖ 作为 HTTP 状态不可达**：厂商错误变成 `turn.error.code="provider_error"` + `error` 事件（`host.ts:617,629`）。`providers/src/service.ts` 只抛 `not_found`/`invalid_request`/`internal_error` | — |
| `draining` | 503 | §5.5 ✅ | ◐ `host.ts:220` 抛出，但**流式路径下会被降级成 200 + error 事件**（§5.1）；非流式路径可达 | — |
| `forbidden` | 403 | **§5.5 未声明** | ✖ 不可达（无抛出点） | `errors.ts:6` |
| `approval_expired` | 410 | **§5.5 未声明** | ✅ 可达 | `host.ts:542` |
| `internal_error` | 500 | **§5.5 未声明** | ✅ 可达 | `app.ts:49`、`service.ts:104` |

错误信封：`{error:{code,message,details?,retryable?}}`（`errors.ts:36`），§5.5 只给了码表没给信封形状 → 文档需补。

---

## 4. 请求信封矩阵（§5.3 逐字段）

| 字段 | 设计 | 状态 | 运行时实际行为 / 证据 |
|---|---|---|---|
| `input[].{type:"text"}` | ✅ | ✅ | `protocol/src/item.ts:6`，上限 500k 字符 |
| `input[].{type:"image",url}` | ✅ 示例 `oss://...` | ◐ **形状对、语义错** | schema 接受任意 URL（`item.ts:7`，`z.string().url()` 连 `oss://` 都过）。但 `packages/core/src/engine/pi.ts:161` 把 `url` 原样塞进 pi 的 `ImageContent.data`，而 pi 对 openai-completions 的序列化是 `` url: `data:${mimeType};base64,${data}` ``（`pi-ai/dist/api/openai-completions.js:941`）→ 客户端传 `https://...` 或 `oss://...` 会被拼成 `data:image/png;base64,https://...` 发给厂商。**没有 blob 取回、没有 base64 入口、没有校验 `ModelSpec.input` 是否含 `image`** |
| `input[].{type:"skill",name}` | ✅ | ◐ **静默丢弃** | schema 接受（`item.ts:9`）→ `host.ts:236` 过滤掉非 text/image → 引擎永远看不到；但**完整 `req.input` 仍被写进 `userMessage` item**（`host.ts:280`），客户端 `GET .../items` 会看到自己传的 skill 部分被"记录"了，误以为生效。下一轮历史投影同样过滤（`history.ts:69`）。若客户端**只**传 skill/mention → `400 invalid_request "input must contain text or image parts"` |
| `input[].{type:"mention",name}` | ✅ | ◐ 同上 | `item.ts:10`；`capabilities` 里连一个可探测的 feature 位都没有（`skills:false` 只覆盖 skill） |
| `model` | 设计写 **字符串** `"deepseek/deepseek-v4"` | ◐ 形状不一致 | 实现要求 **对象** `ModelRef.partial()`（`protocol/src/session.ts:87`），与 `agent.model` 浅合并（`host.ts:251`）。照文档发字符串 → 400 |
| `limits` | ✅ "只能收紧" | ◐ | `host.ts:259` `mergeLimits(agent.limits, req.limits)`。**缺 §6.3 要求的 config 层**，且 `mergeLimits`（`common.ts:74-86`）的 fallback 只在"没有任何层提供该值"时生效 → agent 未设 `maxSteps` 时，请求里写 `maxSteps: 1000` 会被接受（>默认 20），"策略只能收紧"不成立，也没有硬顶 |
| `busyPolicy: steer\|queue\|reject` | ✅ 三档 | ◐ **`queue` 静默降级为 reject** | `protocol/src/agent.ts:9` 接受三档；`host.ts:225-234` 只区分 `steer` / 其他 → `queue` 得到 `409 session_busy`。`docs/PROGRESS.md:19` 已自认。对客户端是**协议谎言**：请求被接受、语义被换掉 |
| `dynamicTools[]` | ✅ | ✅ | `host.ts:255` → `DynamicToolBridge.asTool`（`packages/core/src/tools/dynamic.ts:11`），5 分钟超时回填错误结果；回填端点 `app.ts:196`。注意：**只在生成该工具的 runner 内存里**（`host.ts:591` 先判 `active.has`），跨节点必须靠 router |
| `metadata` | ✅ | **✖ 静默丢弃** | `StartTurnRequest.metadata`（`session.ts:93`）有默认值，但 `host.startTurn` 从不读它；`Turn` schema（`session.ts:43-61`）没有 `metadata` 字段，DDL `turns` 也没有 → 客户端传的 turn 级元数据永久丢失（session 级 `metadata` 是生效的，`host.ts:153`） |
| `stream: false` | ✅ 202 + turnId | ✅ | `app.ts:148-151`，返回 `202 {turn, steered}`（比文档多一个 `steered`） |
| `Idempotency-Key` | 设计写"**必填**" | ◐ | `app.ts:136` 完全可选；不传就没有幂等。另有一个坑：key 先占位再执行（`app.ts:138`），**失败不回滚** → 请求因 404/busy/provider 失败后，同 key 重试在 24h 内永远拿 `409 idempotency_conflict "still in progress"`（`memory.ts:177`、`mysql/store.ts:298`，无 release/delete 接口） |

---

## 5. 外部客户端会撞上的协议级问题

### 5.1 流式路径把所有错误变成 `200 + error{seq:0}`（最严重）

`app.ts:156` 一旦进入 `sseResponse`，Hono 的 `streamSSE` 立刻回 200 并刷出响应头；`host.startTurn` 在 `attach` 回调里执行（`app.ts:165`），它抛出的 `session_busy` / `session_lease_conflict` / `draining` / provider `not_found` / `invalid_request(model 不存在)` 全部被 `app.ts:167-173` 转成一条 SSE `error` 事件。后果：

1. §5.5 的状态码在**默认路径（`stream` 默认 true，`session.ts:92`）上全部不可达**；客户端无法用 HTTP 状态区分"没开始"和"开始后失败"。
2. §4.2 步骤 2 要求 runner 回 `409 + X-Owner` 给 router 做一次重路由——流式路径永远回 200，**M2 的 router 重路由无法工作**（且 `X-Owner` 头全仓未实现）。
3. 该 error 事件被强制 `seq: 0`（`app.ts:169`），而 `sse.ts:27` 会把 `seq` 写成 SSE `id:` → 客户端的 `Last-Event-ID` 变成 `0`，重连时 `?after=0` 从头全量重放。这违反 §5.4 "delta/非持久化事件不带 id" 的约定。
4. `app.ts:172` 在流已开始后 `throw e`，会再次进入 `app.onError` 尝试 `c.json(...)`。

**修法（M1 收尾）**：把"能失败"的前置动作（busy 判定、租约抢占、provider/model 解析、draining 检查）提到 `sseResponse` 之前，失败按 §5.5 返回 HTTP 状态；流内发生的错误才用 `error` 事件，且**不带 `seq`**（`live` 信封）。

### 5.2 用户级隔离没有实现（§5.1 承诺 `principal=(tenantId,userId)` 贯穿所有存取）

- `host.getSession` 只按 tenant 查（`host.ts:162` → `store.getSession(tenantId, sessionId)`），`GET/DELETE /v1/sessions/{id}`、`items`、`events`、`turns`、`approvals` 全部只做租户级校验 → **同租户任意 `X-User-Id` 可以读写别人的会话**（只要知道 session id）。
- `GET /v1/sessions` 的 `userId` 参数**不校验**是否等于 `X-User-Id`（`app.ts:117`：`q.userId ?? (principal.userId || undefined)`）→ 传 `?userId=<别人>` 即可列举他人会话；不传 `X-User-Id` 且不传 `userId` 时列出**全租户**会话。
- `POST /v1/sessions` 允许 body 里的 `userId` 覆盖 `X-User-Id`（`host.ts:141`）。

在"service key = 租户，`X-User-Id` = 该租户声明的终端用户"的信任模型里，这**可能是有意为之**（服务端调用方本来就能代表任何用户）。但 §5.1 的措辞与之矛盾，必须二选一：要么实现 user 级校验，要么在文档里明确写"`X-User-Id` 只用于归因与默认过滤，不构成授权边界"。

### 5.3 `exclude` 无白名单 → 客户端能把自己的流挂死

`parseExclude`（`app.ts:233`）接受任意字符串，`EXCLUDABLE_EVENT_TYPES`（`protocol/src/event.ts:74`）导出了却从未被使用。流式 turn 的结束条件是收到 `session/status/changed{idle}`（`app.ts:162`）；客户端只要 `?exclude=session/status/changed`（文档 §5.2 的示例是 `exclude=item/reasoning/*`，暗示支持通配——实际是精确匹配）就会得到一个**永不结束的 SSE**。同理 `exclude=turn/completed` 会让客户端永远等不到终态。

### 5.4 分页游标可用性

| 端点 | cursor | 问题 |
|---|---|---|
| `GET /v1/agents`、`/v1/sessions`、`.../turns` | ✅ 可用 | MySQL 侧 `id < ?` + `ORDER BY id DESC` + `limit+1` 探测（`mysql/store.ts:101,133,220`），返回 `nextCursor`，语义正确 |
| memory store | ◐ | `paginate`（`memory.ts:32`）用 `findIndex(key===cursor)+1`，**游标行不存在时静默回到第一页** → 翻页客户端可能无限循环。与 MySQL 行为不一致（conformance 套件未覆盖） |
| `GET .../items` | ✖ | 无 cursor / 无 `nextCursor`，只有 `afterSeq`（`app.ts:205-208`）。文档写的是 `cursor` |
| `GET /v1/providers`、`/v1/models`、`/v1/tools`、`.../approvals` | ✖ | 都是 `{data}` 全量，无分页（会话审批数量可以很大） |
| `sortDirection` | ◐ | `Pagination` 声明了（`common.ts:103`），只有 `listTurns` 用（`mysql/store.ts:218`）；agents/sessions 忽略 |

### 5.5 `Last-Event-ID` / 断线续订

- `GET .../events`：✅ 正确接入（`app.ts:214`，`after` 优先于头，非法值回落 -1；seq 从 1 开始递增，`mysql/store.ts:166`，所以 `after=0` = 全量）。
- `POST .../turns`（流式）：**不接** `Last-Event-ID`，固定从 `session.lastSeq` 起（`app.ts:154`）。这是合理的（turn 起点），但文档 `README.md:44` 声称 "`Last-Event-ID` / `?after=` 可续订"，对 POST 不成立。
- `subscribe` 的重放只读 MySQL（`host.ts:191`），从不把 `afterSeq` 传给 `bus.subscribe`（`store/src/types.ts:163` 的热窗口参数永远是 undefined）→ Redis Stream 热重放（§4.4）**写了但没用**。
- 没有 `retry:` 字段、没有 `X-Protocol-Version` 响应头。

### 5.6 内容协商与状态码

- SSE 响应只设 `X-Accel-Buffering: no` + `Cache-Control: no-cache`（`sse.ts:17-18`），不检查 `Accept`；客户端发 `Accept: application/json` 也会拿到 `text/event-stream`。
- 幂等重放（`app.ts:143`）在**流式请求**下返回 `200 application/json {turn}` —— 客户端在等 SSE，拿到 JSON，类型完全不同且没有任何 header 提示（除自定义 `Idempotency-Replayed`）。
- `DELETE` 返回 204 ✅；`POST /v1/agents` 201 ✅；`PUT /v1/agents/{id}` 返回 200（新建了新版本，200 合理）。

### 5.7 OpenAPI / SDK（§10、§11 M1）

`GET /openapi.json` 无实现，`@hono/zod-openapi` 未引入，`packages/sdk/` 不存在。外部客户端目前只能读 `packages/protocol/src/*.ts`（zod）或 `README.md` 的 curl 片段。§11 把 OpenAPI 写在 **M1 交付**里，`docs/PROGRESS.md:15` 把它挪到了 M2 —— 二者需对齐，且这是"外部可调用"这个硬约束（§1 #1）的直接依赖项。

---

## 6. 配置 / 运维面

| 项 | 设计 | 状态 | 证据 |
|---|---|---|---|
| `/metrics` | §5.2 列出；§11 归 M4 | ✖ | 无依赖、无路由 |
| 结构化日志 | §14 #7（M2） | ✖ | 全部是 `console.log/warn/error` 纯文本（`main.ts:41,51`；`host.ts:112` 默认 `console`），无 requestId / tenantId / sessionId 字段，无脱敏级别 |
| trace 传播（W3C `traceparent`） | §14 #7 | ✖ | 全仓无 `traceparent` / OTel |
| 优雅下线 drain | §4.3 / §11 M2 | ◐ | SIGTERM → `ready=false` → `host.drain(30s)` → `server.close()`（`main.ts:40-49`）。`drain` 只是**轮询等 active 清空，超时后 abort**（`host.ts:715-729`），**没有 §4.3 承诺的"step 边界 checkpoint"**（`docs/PROGRESS.md:14` 已自认）。另：`server.close()` 在 drain 之后调用，drain 期间新请求仍被接受（只有 `startTurn` 会被 `draining` 拒绝，且流式下降级为 200） |
| readiness 语义 | — | ◐ | 只反映 drain，不探测 MySQL/Redis（`app.ts:54`） |
| 配置校验 | — | ✅ | `apps/agent-runner/src/config.ts` 用 zod 校验全部 env，有默认值；`SECRETS_MASTER_KEY` 默认 `00...`（开发可用、生产危险，无"生产必须覆盖"的断言） |
| `LOG_LEVEL` | — | ◐ | `config.ts:25` 定义了但**代码中从不读取** |
| 平台 provider 注入 | §7.4 | ◐ | 从 env 单个 preset 注入（`main.ts:18-27`）；**无 key 池、无轮换、无熔断、无 fallback 执行**（`ProviderConfig.fallback` 字段存在但没有消费者） |

---

## 7. 数据生命周期（§14 #6）

| 承诺 | 状态 | 证据 |
|---|---|---|
| schema 预留 `deleted_at` | ◐ | **只有 `sessions.deleted_at_ms`**（`migrations/0001_init.sql:45`）。`turns/items/events/approvals/usage_ledger` 都没有 `deleted_at`，也没有级联标记 |
| 软删除 | ◐ | MySQL 软删（`mysql/store.ts:142`）且 `getSession`/`listSessions` 过滤（:123,:129）；**memory store 是硬删**（`memory.ts:83`）→ 两实现语义分叉，conformance 套件未覆盖此差异 |
| 软删后子资源仍可读 | ⚠️ 半泄漏 | `getTurn/listItems/readEvents/listApprovals` 都**不经过 session 的删除检查**（`mysql/store.ts:213,226,...` 只按 `session_id` 过滤）。但路由层每次都先 `host.getSession` → 404（`app.ts:180,197,206,213,221`），所以对外不泄漏；一旦有人绕过路由层直接用 store 就会读到已删数据 |
| 保留期 / 归档任务（events >90 天 分区到 OSS） | ✖ | 无分区、无归档、无清理任务；`events` 表无 `emitted_at_ms` 之外的分区键设计 |
| 用户删除（PIPL 个人信息删除权） | ✖ | 无 `DELETE /v1/users/{id}` 之类端点，`SessionStore` 无按 userId 批量删除/匿名化的方法；`user_id` 已在每张会话相关表上（DDL 各表），实现成本不高 |
| 附件 / 大输出生命周期 | ✖ | `BlobStore` 未接线（`main.ts:14`），`outputRef` 永远为空 |
| 审计日志 | ✖ | 无 |
| 导出 | ✖ | 无（`GET .../items` 可近似替代，但无分页游标） |
| `docs/design/04-data-lifecycle.md` | ✖ | §14 #6 要求"M1 schema 定稿前"补齐，文件不存在 |

---

## 8. 优先级清单

### 8.1 M1 收尾必须补（不补则当前 API 对外部客户端是**错的或不可用的**）

| # | 事项 | 为什么是"错" | 落点 |
|---|---|---|---|
| 1 | **流式 turn 的错误必须回 HTTP 状态码**：把 busy / lease / draining / provider 解析全部前移到 `sseResponse` 之前；流内错误事件去掉伪造的 `seq:0` | §5.5 全部状态码在默认路径不可达；客户端的 `Last-Event-ID` 被污染成 0；M2 router 的 409 重路由契约无法工作 | `apps/agent-runner/src/app.ts:132-178`、`sse.ts:27` |
| 2 | **补 `X-Owner` 响应头**（`session_lease_conflict` 时） | §4.2 步骤 2 明写的 router 契约，现在只在 `error.details` 里 | `app.ts` onError / `host.ts:241` |
| 3 | **`busyPolicy=queue` 要么实现、要么拒绝**：schema 里先移除 `queue`（或路由层返回 `invalid_request: queue not supported`） | 现在是"接受请求、悄悄换语义"，客户端无法察觉 | `protocol/src/agent.ts:9`、`host.ts:225` |
| 4 | **`model` 字段形状对齐**：实现的对象形式更好 → 改文档 §5.3；同时保留字符串 `"provider/model"` 的兼容解析更友好 | 照文档写的客户端必然 400 | `protocol/src/session.ts:87` / 设计文档 |
| 5 | **`image` 输入端到端打通或明确拒绝**：要么接 BlobStore 取回 + base64，要么 schema 只接受 `data:` URI，要么校验 `ModelSpec.input` 后 400 | 现在会把 URL 当 base64 发给厂商，属于静默数据损坏 | `packages/core/src/engine/pi.ts:161`、`protocol/src/item.ts:7` |
| 6 | **`skill` / `mention` 输入部分要么实现、要么 400 拒绝**（M3 前建议 400 + `capabilities.skills:false` 对齐） | 现在被静默丢弃，却仍写进 `userMessage` item，客户端以为生效 | `host.ts:236`、`history.ts:69` |
| 7 | **`metadata`（turn 级）落库或从 schema 移除** | 静默丢弃 | `protocol/src/session.ts:93`、`Turn` schema |
| 8 | **`exclude` 加白名单校验**（用已有的 `EXCLUDABLE_EVENT_TYPES`），并支持文档里写的 `item/reasoning/*` 通配 | 客户端能把自己的 SSE 挂死 | `app.ts:233`、`protocol/src/event.ts:74` |
| 9 | **幂等键失败回滚**（或占位记录带"失败"终态） | 一次失败会让同 key 在 24h 内永久 409 | `app.ts:136-146`、`store` 两个实现 |
| 10 | **`GET /openapi.json` + `packages/sdk`** | §11 M1 交付栏第一项；"任意外部客户端可调用"的前提 | 新增（`@hono/zod-openapi`） |
| 11 | **`GET /v1/usage`** | §11 M1 验收隐含计费归因；数据已入库只差读接口 | `store` 新增 usage 查询 + 路由 |
| 12 | **`POST .../compact` + 摘要级压缩 + `session/compacted` 事件** | schema 声明了却永不发出；长会话没有出路 | `packages/core`、`app.ts` |
| 13 | **`POST .../archive`**（`includeArchived` 现在是死参数）与 **`GET /v1/agents/{id}/versions`** | §5.2 明确列出、底层已就绪 | `app.ts` |
| 14 | **`items/{itemId}/output` + BlobStore 接线** | `void new FsBlobStore(...)` 是明显的未接线 | `apps/agent-runner/src/main.ts:14` |
| 15 | **`warning` 事件至少接一处**（`projectItems.repaired`、thinking 丢弃）或从 schema 移除 | 声明但永不发出 | `host.ts:263` |
| 16 | **`limits` 硬顶**：`mergeLimits` 增加不可超越的 config 层 | 现在 agent 未设限时请求可以自己放大到任意值 | `protocol/src/common.ts:74` |
| 17 | **用户级隔离**：按 §5.2 决策——实现 `userId` 校验，或在文档中降级 `X-User-Id` 的语义 | 现在同租户可跨用户读写会话 | `host.ts:162`、`app.ts:115-119` |
| 18 | **memory / MySQL store 语义对齐**（软删、游标不存在的行为）并进 conformance 套件 | 测试用 memory、生产用 MySQL，行为不同 | `memory.ts:32,83`、`store/test/conformance.ts` |
| 19 | **`http_request` 内置工具**（§7.1 一期承诺） | `GET /v1/tools` 现在只有 2 个工具 | `packages/core/src/tools/builtin/` |
| 20 | **`docs/design/04-data-lifecycle.md`**（§14 #6 要求"M1 schema 定稿前"），至少确定 `deleted_at` 覆盖面与用户删除接口形状 | schema 现在只有 `sessions.deleted_at_ms` | 文档 + migration |

### 8.2 M2 / M3 / M4 计划内（现状可接受，但文档应标注里程碑）

| 事项 | 里程碑 | 说明 |
|---|---|---|
| `apps/agent-router`、owner 目录查询、SSE 反代、409 重路由 | M2 | 依赖 8.1 #1/#2 先修好 |
| drain 的 step 边界 checkpoint | M2 | 现在是"等 + 超时 abort" |
| 结构化日志 + `traceparent` + `docs/design/05-observability.md` | M2（§14 #7） | |
| `/v1/mcp-servers` 全家族、`toolCall{kind:"mcp"}` 实际产生、`item/mcpToolCall/progress` | M3 | `AgentDefinition.mcpServers` 目前是无效字段，capabilities 已诚实地报 `mcp:[]` |
| `/v1/skills` 全家族、skills 注入、`{type:"skill"}` 输入、`skills_guard` | M3 | capabilities 已报 `skills:false` |
| `hook/started` / `hook/completed` 事件 + §7.5 hooks/middleware/webhook | M3 | 事件类型连 schema 都还没有，先定 schema |
| 子 agent（`subAgentActivity` item、`plan` item） | M3（§14 #3） | |
| `POST .../fork` | M3 | 需要定义 items 复制与 seq 语义 |
| `quota_exceeded` / key 池 / 熔断 / `fallback` 执行 | M4 | 错误码已预留 |
| `/metrics` + OTel + `prompt_cache_hit_ratio` 面板 | M4 | §5.2 与 §11 的里程碑归属需在文档里统一 |
| events 分区归档到 OSS、保留期任务、用户删除 | M4（设计 M1 定稿） | |
| 重池 / exec-server / `sandbox != "none"` | M4+ | `AgentDefinition.sandbox` 只接受 `"none"`，诚实 |

### 8.3 文档需更正（代码故意偏离设计，且**代码是对的**）

| # | 设计说法 | 代码现状 | 该改哪边 |
|---|---|---|---|
| 1 | §5.3 `"model": "deepseek/deepseek-v4"`（字符串） | `ModelRef{provider,model,reasoning?}` 对象 | **改文档**（对象能表达 reasoning 档位；可额外兼容字符串） |
| 2 | §5.4 item 类型含 `mcpToolCall / dynamicToolCall` | 折叠成 `toolCall{kind: builtin\|mcp\|dynamic\|skill}` | **改文档**（折叠更好：客户端一套渲染逻辑） |
| 3 | §5.4 未列 `systemNotice` item、未列 `StopReason.max_output_tokens` | 都已实现且有用 | **改文档**（补上） |
| 4 | §7.1 动态工具回填端点 `POST .../items/{id}/result` | 实现是 `POST .../turns/{turnId}/tool-results`（按 `toolCallId` 定位，`turnId` 未校验） | **两边都改**：文档补进 §5.2；代码应校验 `turnId` 或干脆改成 `.../items/{itemId}/result`（itemId 更符合 §5.2 的资源风格） |
| 5 | §5.2 `GET .../items?turnId&cursor` | 实际是 `?turnId&afterSeq&limit`，无 `nextCursor` | **改代码**（统一分页协议），或文档明确 items 用 seq 游标 |
| 6 | §5.2 `Idempotency-Key` **必填** | 可选 | **改文档**为"强烈建议；不传则无幂等保证"（强制必填会劝退简单客户端） |
| 7 | §5.5 未列 `forbidden` / `approval_expired(410)` / `internal_error(500)`，也没给错误信封形状 | `errors.ts` 有 13 个码 + `{error:{code,message,details,retryable}}` 信封 | **改文档**（补码表与信封；`forbidden` 若确实不用则从 `errors.ts` 删除） |
| 8 | §5.5 `422 limits_exceeded` | 安全阀改为优雅终止 turn，不返回 422 | **改文档**：把 422 限定为"请求的 limits 与租户策略冲突"，并写明"运行期触发上限 → `turn/completed{stopReason}`" |
| 9 | §5.5 `502 provider_error` | 厂商错误在 turn 内部（`turn.error` + `error` 事件） | **改文档**：说明 502 只用于"turn 尚未创建就确定厂商不可用"的情形 |
| 10 | §5.2 `GET /metrics` 与协议同表 | M4 才做 | **改文档**：在 §5.2 全局行标注里程碑 |
| 11 | §5.2 `exclude=item/reasoning/*` 暗示通配 | 精确匹配 | 建议**改代码**支持前缀通配（客户端体验），否则改文档 |
| 12 | §5.1 `principal=(tenantId,userId)` 贯穿所有存取 | 只有 tenant 是授权边界 | 见 8.1 #17，**必须二选一并写清** |
| 13 | `README.md:49` 声称 `GET /v1/providers/{id}` | 无此路由 | **改 README**（或补路由） |
| 14 | `README.md:44` 声称流式 POST 支持 `Last-Event-ID` 续订 | 只有 `GET .../events` 支持 | **改 README** |
| 15 | §11 M1 交付含 OpenAPI；`docs/PROGRESS.md:15` 把它列进 M2 下一步 | 未实现 | **对齐两处**（建议按 §11 留在 M1 收尾） |
| 16 | `capabilities.replay.hotWindowMs=3600000` 硬编码 | memory bus 无热窗口；MySQL 侧其实是永久可重放 | **改代码**：按实际配置计算（或改成 `persistedRetentionMs` + `hotWindowMs` 两个字段） |
