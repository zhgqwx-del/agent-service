# agent-router / agent-runner 架构方案（v0.1，2026-09-22）

> 状态：**已采用的 2026-09-22 架构基线**。本文保留调研阶段（`docs/research/01–07`）形成设计时的目标态与原始缺口；核心决策已经实施并经过后续评审。当前实现范围、验证结果和剩余事项以 `docs/PROGRESS.md` 的顶部快照及最后一节为准。

---

## 0. 一页结论

| 问题 | 结论 | 依据 |
|---|---|---|
| agent loop 用什么 | **内嵌 `@earendil-works/pi-ai` + `pi-agent-core`**（MIT），封在自研 `AgentEngine` 接口后面；保留自研 loop 作为第二实现 | research 04 §4、05 §4.2、01 §3.2 |
| opencode / dsh / codex / openclaw / hermes 怎么用 | 都**不作为运行时依赖**。opencode 取 `packages/llm` 的方言修补与 v2 schema 设计；dsh 取 MCP 配置模型、`scrubbedParentEnv`、日志修补；codex 取 `thread/turn/item` 协议与审批枚举；openclaw 取 `tool-call-repair`、BYOK 配置形状、忙时输入四档；hermes 取 `/v1/runs` 语义、`skills_guard`、provider profile | research 03 §9、04 §4.1、05 §4、06 §6 |
| 服务拆分 | **独立无状态 `agent-router` + 有状态 `agent-runner`**。前期方案的"对等转发"被否定：通用 harness 的 runner 负载曲线（内存/fd/子进程）与 router（连接/鉴权/限流）不同，且要对外开放 | research 02 §1.2(a) |
| 一致性保证 | 路由只是效率优化；**正确性只由 runner 侧 Redis 租约 + fencing token 保证**（DB 写入带 `WHERE fence_token=?`） | research 02 §1.1、§3.3 |
| 路由键 | `sessionId`，不是 `userId`；工作区放对象存储，runner 本地只做缓存 | research 02 §1.2(b) |
| 对外协议 | HTTP + SSE；资源 `agents / sessions / turns / items / events / approvals`；每条持久化事件有 per-session 单调 `seq`；delta 不落库不占 seq；审批是一等资源且有 `expiresAt` | research 06 §6、07 结论 |
| 存储 | MySQL（sessions/turns/items/events-milestone/approvals/配置）+ Redis（租约、所有权目录、Streams 热重放、配额）+ 对象存储（大输出/附件/工作区）。本地先单库 MySQL，schema 预留 `user_id` 分片键 | research 02 §4 |
| 代码执行 / 沙箱 | **一期不提供** shell/文件工具。runner 分"轻池"（API 工具 + 远程 MCP，1,000 turn/进程）与"重池"（按 agent 配置起沙箱，走 exec-server 协议）；一期只建轻池，预留接口 | research 02 §5.3、06 §6.6 |
| MCP | 必须支持；**远程 streamable-http 优先**，stdio 只在重池；按租户动态注册，SSRF/配额/命名空间自写 | research 01 §2 #8、partials/dsh-mcp |
| Skills / Plugins | Skills 用 `SKILL.md` 标准，来源三级（平台/租户/用户），存 DB + 对象存储；Plugins 一期 = 平台部署的进程内 hook 包 + 租户级 webhook hook，**不在共享进程加载用户代码** | research 05 §4.1 #8/#9、01 §3.2 C6 |
| BYOK | 租户级 provider 配置 CRUD，KMS 信封加密，per-request 注入 pi 的 `apiKey/headers/fetch`；全局 key 池 / 配额 / 熔断状态在 Redis | research 04 §4.3 #1、02 §1.2(f) |
| 技术栈 | TypeScript / Node 24+，pnpm monorepo，Hono，mysql2 + drizzle，ioredis，zod-openapi | §10 |

---

## 1. 目标与约束

来自需求简报的硬约束：

1. 类 `opencode serve` 的后端 agent API，任意外部客户端可调用。
2. 通用 harness 能力：MCP、skills、插件、BYOK。
3. 生产分布式部署，20M+ DAU。
4. 多用户多会话隔离；同一用户/会话的请求连续、一致。
5. 独立路由服务 `agent-router`（无状态）+ `agent-runner`（有状态），历史入云端存储、可迁移。
6. 模型以国内厂商为主（qwen / kimi / deepseek），OpenAI chat/completions 兼容。
7. 允许嵌入开源 agent 作为 loop（router → runner → agent）。

**非目标**（一期明确不做）：TUI/桌面端、多渠道（IM）接入、语音/ASR、产品级记忆层（前期方案 05 的三层记忆属于业务层，runner 只提供注入钩子）、自建推理。

---

## 2. 调研结论摘要

七份报告在 `docs/research/`。结论按仓库：

| 仓库 | 一句话 | 我们拿什么 |
|---|---|---|
| **pi**（0.87.0, MIT） | `pi-ai` / `pi-agent-core` 是真正的纯库：零 process 副作用，`Models` 是实例，每次调用可注入 `apiKey/headers/fetch`；deepseek/moonshot/qwen/zai/minimax 内置，`reasoning_content` 三种拼法 + 3 种 cache 字段都处理；`AgentHarness` 有可插拔 `Storage/SessionRepo` + conformance 测试。缺 MCP、缺步数/成本上限、不做租约；发版快且每版有 Breaking | **作为 loop + provider 层内嵌**，pin 精确版本 |
| **deepseek-harness**（0.1.6-alpha, MIT） | 插件架构最彻底，loop 干净（并发池 10、durable inbox、日志修补），但凭据/身份/存储根全是进程级；`deepseek-official` 适配器**默认**上传 `x-deepseek-harness-user-id`、插件清单、完整会话日志；alpha、不接外部 PR | 只借设计：MCP 配置 schema 与工具命名规则、`scrubbedParentEnv`、`repair.ts`、`isConcurrencySafe(args)` |
| **opencode**（v1.18.32, MIT） | v1 是 81K 行 + 99 依赖的单机应用，v2（`@opencode-ai/core/server/llm`）有更好的原语（`SessionInput` steer/queue、`ContextEpoch`、`EventV2` aggregate+seq、持久化 permission 表）但未接入 server。`private:true` 无发布物，Effect 4 beta。11 条多租户阻碍 | 只借设计：`packages/llm` 的方言修补、v2 schema、`SessionInput`、`ContextEpoch`、compaction 阈值、权限规则语义。**方案 A（容器化 opencode）保留为重池的候选后端** |
| **codex**（Apache-2.0） | `WireApi` 仍只有 `Responses`，`"chat"` 被显式拒绝，国内模型接不上；但 `app-server-protocol`（164 请求 / 84 通知，thread→turn→item，UUIDv7，审批决策枚举，resume 重发未决审批）是最完整的服务端 agent 协议规格 | 协议类型定义逐字复制（保留 NOTICE）；`ThreadStore` trait 签名；exec-server 拆分 |
| **openclaw**（MIT） | 2.47M 行，"一个 Gateway = 一个信任域"，多租户靠每租户一个容器；agent-core 是 pi 血统 | `packages/tool-call-repair`（国产模型把 tool call 当文本输出的修复）、`{baseUrl, apiKey, api, models[]}` BYOK 形状、steer/followup/collect/interrupt 四档、`activeWriterRunId` 写栅栏 |
| **hermes-agent**（Python, MIT） | 825K 行，同步 loop + 10 线程池；但 `/v1/runs`（202 + SSE + stop/steer/approval + durable Idempotency-Key）几乎就是我们要的 API；`skills_guard` 安装前威胁扫描；声明式 `ProviderProfile` | `/v1/runs` 语义、`skills_guard` 正则表、provider profile 数据、`session_turn_leases` DDL |
| **前期方案 + PoC** | 6,042 行 TS PoC，151 测试。可带走：事件信封与 seq 水位线、SSE 无损重放、`openai-compatible.ts`、`resilient.ts`、安全阀、`length` 丢弃 tool call、write-ahead + 崩溃恢复两码、压缩配对、前缀稳定化机制。**代码级缺陷**：租约从不续期、无 fencing token、runtime 不回收、历史只在内存、跨副本 250ms 轮询 | 带走上述模块的设计与测试，重写分布式部分 |

四家共有的结构性事实（与产品无关）：全部是单用户进程拓扑，HOME 单例，无租户维度，无分布式所有权，无成本阀。**多租户、分布式、BYOK 三块在所有开源 harness 里都是零，必须自写。**

---

## 3. 总体架构

```
 外部客户端（App / Web / 服务端调用 / opencode-compatible 客户端）
        │  HTTPS  Authorization: Bearer <service api key>   X-User-Id / 端用户 JWT
        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 接入层（现有 API Gateway / nginx / envoy）                                 │
│   TLS · WAF · 全局限流 · SSE 直通（X-Accel-Buffering: no，idle ≥ 90s）      │
└───────────────────────────────┬─────────────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ agent-router（无状态，N 副本）                                              │
│   1. 透传外部身份；权威 service/user 鉴权仍由 runner 完成                    │
│   2. 幂等：透传 Idempotency-Key；仅对带 key 的 turn POST 允许安全重路由      │
│   3. 定位：owner:{sessionId} → runnerAddr；无 owner → 一致性哈希 / 最少负载  │
│   4. 反向代理（SSE 不缓冲）；runner 回 409 lease_conflict → 重查目录重路由一次 │
│   5. 非 session 类请求（agents/providers/skills CRUD）直接打任意 runner      │
│   只有连接态，没有业务态；可随时重启                                          │
└──────────┬─────────────────────────┬────────────────────────────────────┘
           │                         │
┌──────────▼──────────┐   ┌──────────▼──────────┐   ┌──────────────────────┐
│ agent-runner 轻池    │   │ agent-runner 重池    │   │ （可选）容器化 opencode │
│ 无 shell/fs 工具     │   │ 按 agent 配置起沙箱   │   │ 作为重池的另一种后端    │
│ API 工具 + 远程 MCP  │   │ exec-server 协议     │   │ 同一对外协议            │
│ ~1,000 turn/进程     │   │ 独立容量、独立 SLO    │   │ 二期再评估              │
└──────────┬──────────┘   └──────────┬──────────┘   └──────────────────────┘
           │                         │
           ▼ runner 内部
┌─────────────────────────────────────────────────────────────────────────┐
│ HTTP(Hono) → TenantContext → SessionHost（租约 + fencing + 单写者）        │
│   → AgentEngine（pi adapter | native）→ ToolRuntime（内置 / MCP 桥 / 动态） │
│   → ProviderGateway（BYOK 解析 · key 池 · 配额 · 熔断 · 方言）               │
│   → EventLog（seq 分配 · 先落库再扇出）→ SSE writer                          │
│   Hooks/Middleware（PreToolUse … Stop；租户策略；审计）                     │
└──────┬───────────────────┬───────────────────┬──────────────────────────┘
       ▼                   ▼                   ▼
┌─────────────┐   ┌────────────────┐   ┌─────────────────┐   ┌───────────────┐
│ MySQL        │   │ Redis           │   │ 对象存储 (OSS)   │   │ 模型厂商 API   │
│ sessions     │   │ lease/fence     │   │ 大工具输出       │   │ deepseek/qwen │
│ turns/items  │   │ owner 目录      │   │ 附件/工作区      │   │ kimi/zhipu…   │
│ events(里程碑)│   │ Streams 热重放  │   │ 冷事件分区       │   │ 自建 vLLM     │
│ approvals    │   │ 配额/key 池     │   └─────────────────┘   └───────────────┘
│ agents/skills│   │ sharded pub/sub │
│ provider cfg │   └────────────────┘
│ usage_ledger │
│ idem receipts│
└─────────────┘
```

**服务边界**：

| 服务 | 状态 | 扩缩容依据 | 一期 |
|---|---|---|---|
| agent-router | 无状态（仅 SSE 代理连接态） | 连接数 / QPS | 是 |
| agent-runner（轻池） | turn 内有状态，turn 间无状态 | 并发 turn 数 × 内存 | 是 |
| agent-runner（重池） | 同上 + 沙箱生命周期 | 沙箱数 | 否，预留接口 |
| exec-server | 每会话/每租户沙箱 | 沙箱数 | 否，预留协议 |
| llm-quota（逻辑组件） | 状态在 Redis | — | 作为 runner 内库实现 |

---

## 4. 有状态性与分布式一致性

### 4.1 三层有状态性（沿用前期方案，结论不变）

| 层次 | 要求 | 不满足的后果 |
|---|---|---|
| 一个 turn 之内 | **强制单所有者** | 两个 writer → seq 冲突、工具重复执行，数据损坏 |
| 同 session 跨 turn | 优选亲和 | 只是变慢（上下文冷启动） |
| 同用户跨 session | 不需要 | — |

### 4.2 所有权与租约

```
Redis:
  lease:{sessionId}   = {runnerId, fence, expiresAt}     SET NX PX，续期 Lua 脚本校验 runnerId
  fence:{sessionId}   = 单调递增整数（INCR），每次成功抢占 +1
  owner:{sessionId}   = runnerAddr（供 router 查询；TTL 略长于 lease）

MySQL:
  sessions.fence_token   = 最近一次成功写入的 fence
  所有写入：UPDATE ... WHERE session_id=? AND fence_token<=?   （旧 fence 的写被拒绝）
  events 追加：INSERT ... 前在同一事务内校验并推进 sessions.next_seq 与 fence
```

runner 处理 `POST /sessions/{id}/turns` 的顺序：

1. 校验租户/用户归属（不属于 → 404，不泄漏存在性），并为解析后的 turn 请求计算语义 hash。
2. 从 MySQL 查 completed receipt；同 key 异 hash → `409 idempotency_conflict`，可直接安全重放时返回原 turn。
3. 抢租约；失败 → `409 session_lease_conflict`，响应头 `X-Owner: <runnerAddr>`，router 仅在 turn POST 带 `Idempotency-Key` 时重路由。
4. 获得租约后立即启动 TTL/3 续期，重读 session 和 receipt，必要时修复孤儿 turn；续期失败立即 abort，之后任何写入都会被 fence 拒绝。
5. 从 MySQL 装载最近 compaction 之后的 items，完成 model/tools/context preflight，再把 turn、首条 user item、events 和 completed receipt 放入同一个 fenced 事务；事务若检测到 legacy pending，则不写入任何数据并返回 `409 idempotency_conflict`。提交后才启动 engine。
6. turn 结束（`session.idle`）后租约保留一个短窗口（默认 60s）供下一 turn 命中亲和，之后释放并删 `owner`。

### 4.3 故障场景

| 场景 | 行为 |
|---|---|
| router 重启 | 客户端 SSE 断；客户端带 `Last-Event-ID` 重连到任意 router → 查 owner → 续订 |
| runner 崩溃（turn 中） | 租约过期；下一请求由新 runner 抢占（fence+1）；`repairSession` 按 write-ahead 的 `tool.call.started` 把孤儿分为 `TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN`；turn 记为 `interrupted` 并发 `turn/completed{status:interrupted}` |
| runner 发布/缩容 | drain：拒绝新 turn，等进行中 turn 到 **step 边界**做 checkpoint（items 已落库）后释放租约；超时则 abort |
| 路由完全失效（随机落点） | 每次多一跳 + 上下文冷启动，**不会**出现双 writer |
| 客户端断开 SSE | 不等于取消（沿用 AI SDK / hermes 语义）；turn 继续跑，事件进 Redis Stream，`?after=` 补齐；显式取消走 `POST .../interrupt` |
| 审批等待期间 runner 重启 | 审批是 DB 资源（不是内存 Deferred）；resume 时按 codex 流程**重发未决审批**；超过 `expiresAt` 按策略自动 decline |

### 4.4 事件扇出与重放

- 每条**持久化**事件：`(session_id, seq)` 主键，先落 MySQL 再 `XADD` 到 `stream:{sessionId}`（Redis Streams，TTL 1h，MAXLEN 近似裁剪）。
- **delta 类事件**（`item/agentMessage/delta`、`item/reasoning/delta`、`item/mcpToolCall/progress`）只进 Stream，不落库，不占 seq（SSE `id:` 沿用上一条持久化事件的 seq，客户端按 itemId 拼接）。
- SSE 订阅：`?after=<seq>` 或 `Last-Event-ID` → 先从 MySQL 读 `> seq` 的里程碑事件，再切到 Stream tail；超过 1h 的断线只能拿到里程碑 + 最终文本，**写进协议**。
- 20M DAU 中档下 Stream 消息量峰值 15–30 万 msg/s：Redis 按 sessionId 分片（Cluster + sharded pub/sub 或多实例哈希）；超过阈值时切 Kafka 按 sessionId 分区，接口不变。

---

## 5. 对外协议（agent-router 公网入口 / agent-runner 执行 API v1）

命名综合 codex（thread/turn/item）、opencode（session）、hermes（runs）。对外叫 **session**（与简报一致），内部结构就是 codex 的 thread。所有 id 用 UUIDv7。

本节保留总体目标态；当前真正可调用、由 CI 锁定的端点和 schema 以仓库提交的 `packages/protocol/openapi.json` 为准。表中 MCP、Skills、hooks、`fork`、`GET /metrics` 等目标态能力仍属于 M3/M4，不能因为列在架构基线中就视为已实现。

### 5.1 鉴权

双层：`Authorization: Bearer <service_api_key>`（→ `tenantId`，服务级）+ `X-User-Id`（或租户配置的端用户 JWT，→ `userId`）。`principal = (tenantId, userId)` 贯穿所有存取；任何进程级缓存都按 principal 分片。

### 5.2 资源与端点

| 资源 | 端点 | 说明 |
|---|---|---|
| Agent 定义（版本化） | `POST/GET /v1/agents`，`GET/PUT /v1/agents/{id}`，`GET /v1/agents/{id}/versions` | `{name, instructions, model, tools[], mcpServers[], skills[], limits, approvalPolicy, sandbox}`；每次 PUT 生成新版本；session 引用 `agentId@version` |
| Session | `POST /v1/sessions`，`GET /v1/sessions?cursor&limit&userId`，`GET /v1/sessions/{id}`，`DELETE`，`POST .../archive`，`POST .../fork`，`POST .../compact`，`POST .../resume` | `resume` 返回快照 + 游标 + 未决审批（codex 流程） |
| Blob | `POST /v1/sessions/{id}/blobs`，`GET /v1/sessions/{id}/blobs/{blobId}`，`GET /v1/sessions/{id}/items/{itemId}/output` | 当前支持 image 原始字节上传和大工具结果读取；外部只见 owner-scoped opaque `blobId`，声明 MIME 必须匹配文件签名，执行模型必须支持 image input，staging 与 item 同事务绑定后才可读 |
| Turn | `POST /v1/sessions/{id}/turns`（`stream=true` 直接 SSE；`false` 返回 202 + turnId），`GET .../turns`，`GET .../turns/{turnId}`，`POST .../turns/{turnId}/interrupt`，`POST .../turns/{turnId}/steer` | body `{input:[...], model?, limits?, busyPolicy: steer|reject}`；`Idempotency-Key` 建议必填，作用域是 tenant + user + session；服务端对解析后的请求语义取 hash（`stream` 仅影响传输，不参与 hash），同 key 异请求返回 `409 idempotency_conflict`；命中 completed receipt 时返回 `200 application/json {turn}` + `Idempotency-Replayed: true` |
| Item | `GET /v1/sessions/{id}/items?turnId&cursor`，`GET .../items/{itemId}/output`（大输出） | 完整消息历史（替代 opencode 的 `GET /session/:id/message`） |
| Event 流 | `GET /v1/sessions/{id}/events?after=<seq>&exclude=item/reasoning/*` | SSE；`id: <seq>`；`Last-Event-ID` 等价 `after` |
| 审批 | `GET /v1/sessions/{id}/approvals?pending=true`，`POST /v1/sessions/{id}/approvals/{approvalId}` `{decision}` | decision ∈ `accept | acceptForSession | decline | cancel`；资源含 `expiresAt`、`availableDecisions[]` |
| Provider / 模型 | `GET /v1/providers`，`GET /v1/models`，`POST/PUT/DELETE /v1/providers/{id}`（租户 BYOK） | BYOK 配置形状见 §7.4 |
| MCP | `POST/GET/DELETE /v1/mcp-servers`，`GET /v1/mcp-servers/{id}/tools`，`POST .../refresh` | 租户级或用户级；`transport: streamable-http | stdio(重池)` |
| Skills | `POST/GET/DELETE /v1/skills`（上传 SKILL.md 包），`GET /v1/skills/{name}` | 来源三级：platform / tenant / user |
| 工具 | `GET /v1/tools` | 当前 principal 可见的内置 + MCP + 动态工具目录 |
| 用量 | `GET /v1/usage?sessionId|userId&from&to` | 来自 `usage_ledger` |
| User data export | `POST /v1/data-export-requests`，`GET /v1/data-export-requests/{requestId}`，`GET .../{requestId}/download` | admin + user + Idempotency-Key；异步生成 owner-scoped `ndjson-v1` 临时制品，request gate默认关闭 |
| 全局 | `GET /healthz`，`GET /readyz`，`GET /metrics`，`GET /v1/capabilities`，`GET /openapi.json` | capabilities 声明而非版本猜测 |

### 5.3 输入与信封

```jsonc
POST /v1/sessions/{id}/turns
{
  "input": [
    {"type":"text","text":"..."},
    {"type":"image","blobId":"blob_...","mimeType":"image/png"},
    {"type":"skill","name":"..."},          // 显式 /skill 调用
    {"type":"mention","name":"..."}
  ],
  "model": {"provider": "deepseek", "model": "deepseek-v4"},   // 可选对象，受 agent 定义与租户策略约束
  "limits": {"maxSteps":20,"maxToolCalls":50,"maxWallClockMs":300000,"maxCostCNY":2},
  "busyPolicy": "steer",
  "dynamicTools": [ {"name":"...","description":"...","parameters":{...}} ],  // 客户端侧工具（codex item/tool/call）
  "metadata": {}
}
```

### 5.4 事件类型

| 事件 | 持久化 | 说明 |
|---|---|---|
| `session/created` `session/status/changed` `session/compacted` | 是 | status ∈ `idle | active{waitingOnApproval|waitingOnUserInput} | error` |
| `turn/started` `turn/completed{status: completed|interrupted|failed, stopReason}` | 是 | stopReason ∈ `end_turn | max_steps | max_tool_calls | max_cost | max_wall_clock | interrupted | error` |
| `turn/steered` | 是 | steer 在 step 边界注入后发出 |
| `item/started` `item/completed` | 是 | 携带完整 item 快照；type ∈ `userMessage | agentMessage | reasoning | toolCall | toolResult | mcpToolCall | dynamicToolCall | approvalRequest | contextCompaction | plan | subAgentActivity` |
| `item/agentMessage/delta` `item/reasoning/delta` `item/toolCall/argsDelta` `item/mcpToolCall/progress` | **否** | 只进 Stream |
| `approval/requested` `approval/resolved` | 是 | resume 时重发未决 `approval/requested`（id 不变） |
| `usage/updated` | 是 | 每 step 一次，含 cache hit/miss 归一化字段 |
| `hook/started` `hook/completed` | 可配 | 插件可观测 |
| `warning` `error` | 是 | |
| `heartbeat` | 否 | 10s，不占 seq |

事件信封：`event: <type>`，`id: <seq>`，`data: {sessionId, turnId?, itemId?, emittedAtMs, ...}`。时间戳全部毫秒。

### 5.5 错误码

`400 invalid_request` · `401 unauthorized` · `404 not_found`（跨租户与不存在不可区分）· `409 session_busy`（busyPolicy=reject）· `409 session_lease_conflict`（内部，router 处理）· `409 idempotency_conflict` · `422 limits_exceeded` · `429 quota_exceeded{scope: tenant|user|provider}` · `502 provider_error{provider, retryable}` · `503 draining`。

---

## 6. agent-runner 内部设计

### 6.1 AgentEngine 接口（harness adapter 边界）

```ts
interface AgentEngine {
  runTurn(ctx: TurnContext, input: TurnInput, sink: EventSink): Promise<TurnResult>;
  steer(turnId: string, input: TurnInput): Promise<void>;
  interrupt(turnId: string): Promise<void>;
}
// TurnContext: principal, agentDef@version, history(items after last compaction),
//              providerResolver(BYOK), toolRuntime, limits, abortSignal, hooks
```

两个实现跑同一套契约测试（前期方案 04 §6 的 `HarnessAdapter` 思路）：

- **`PiEngine`（一期主线）**：路线 A —— `pi-agent-core` 的 `Agent` 类，`initialState.messages` 从我们的 store 装载，`subscribe` 转事件，`agent_end` 后落库；`streamFn` 包装 `models.streamSimple(model, ctx, {apiKey, headers, fetch, signal})` 注入 BYOK。二期评估切到 `AgentHarness` + 自研 `SessionRepo`（跑 pi 的 conformance 套件）。
- **`NativeEngine`（二期）**：从 PoC `loop.ts` + openclaw agent-core 移植，作为 pi 断供/Breaking 时的退路。

pi 要替换的缝（research 04 §4.3）：模型/凭据解析、会话存储、单写者租约（pi 明确不做）、`ExecutionEnv`（一期不挂）、MCP → `AgentTool` 桥、skills 从对象存储装载、`finishTurn` 实现步数/成本上限、`Context.abortSignal` 接取消、telemetry 接 OTel。

### 6.2 上下文装配与前缀稳定

- 不可变前缀区：`instructions(agent@version)` + 工具定义（按名排序、`stableStringify`）+ skills 目录 + 长期记忆注入槽；**`contextEpoch = hash(agentVersion, toolSetHash, mcpToolCatalogHash, skillCatalogHash)`**，任何一项变化 bump epoch，并在对话尾追加一条"XX 列表已变更"的消息而不是改前缀（opencode `SystemContext` 增量）。
- 追加区：本 turn 消息 + 工具结果。
- 指标 `agentrt_prompt_cache_hit_ratio{provider,tenant}` 上线第一天就有；CI 里跑前缀 sha256 回归测试。

### 6.3 安全阀（内核不变量，策略只能收紧）

`maxSteps`、`maxToolCalls`、`maxWallClockMs`、`maxCostCNY`、重复工具调用检测、`finish_reason=length` 丢弃**全部** tool call。取 `min(config, agentDef, request)`。触发后优雅终止：带 `partialText` 的 `turn/completed{status:completed, stopReason}`，session 回到 `idle`。

### 6.4 压缩与崩溃恢复

- 两级压缩：便宜级只清工具输出（保留配对、迟滞 >20k、保护 skill 输出）；摘要级作为 `contextCompaction` item 进历史；换模型前先用旧模型压缩；`cache.read + cache.write` 计入占用。
- write-ahead：`toolCall` item 先落库再执行；恢复时 `TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN` 两码交给模型。
- 并发工具：dispatch 可乱序、commit 按模型顺序；`isConcurrencySafe(args)` 按参数判并发。

### 6.5 八条生产坑 → 回归测试

research 01 §3.1 的八条（合成 tool_result id 稳定、length 丢弃、换模型前压缩、崩溃三态、thinking 丢弃告警、并发 commit 顺序、取消先于清审批、两级压缩事务）全部做成 `packages/core` 的测试，作为 `AgentEngine` 契约的一部分，两种 engine 都要过。

---

## 7. 扩展性

### 7.1 工具

三类：**内置**（`web_fetch`、`http_request`（SSRF 白名单）、结构化数据工具；一期无 shell/fs）、**MCP 工具**（桥接）、**动态工具**（客户端在 turn 请求里声明，runner 发 `item/started{dynamicToolCall}` 后等待客户端 `POST .../items/{id}/result`，codex `item/tool/call` 反向委托）。工具可见性是 **session 的属性**（hermes 原则），由 agent 定义 + 租户策略 + 请求参数解析，不靠进程级缓存。

### 7.2 MCP

- 传输：`streamable-http`（主）、`stdio`（仅重池）。配置 schema 照 dsh：`{serverName, transport, url|command, headers|env, toolCallTimeoutMs, maxInstructionBytes, reconnect{...}, trust: full|untrusted}`。
- 作用域：platform / tenant / user 三级注册；连接按 `(principal, serverId)` 池化 + TTL；工具名 `mcp__<server>__<tool>`，超 64 字符截断 + hash。
- 自写清单：OAuth（回调落自己域名，`state` 编码 `(userId, serverId, nonce)`）、token KMS 信封加密 + 撤销级联、分布式刷新单飞、SSRF / 内网 CIDR / DNS rebinding 防护、per-user 配额熔断、工具目录 cache key 含 principal、第三方 tool description 的 prompt 注入标记、`untrusted` server 的写工具强制审批。

### 7.3 Skills

- 格式：`SKILL.md` frontmatter（`name`、`description`、`whenToUse`、`disable-model-invocation`、`user-invocable`、`metadata`、`dependencies.tools[]`(codex)）。
- 来源与优先级：请求级 > user > tenant > platform；存 MySQL（元数据）+ 对象存储（包）；provider 接口照 dsh `SkillProvider{list, get}`。
- 注入：目录消息（按摘要去重）+ `skill` 工具 + 输入项 `{type:"skill"}`；codex 的 token 预算截断。
- 安装前跑 `skills_guard` 规则扫描（翻译 hermes 正则表）。
- 资源物化（`scripts/`、`reference/`）只在重池有意义，一期不做。

### 7.4 BYOK 与 Provider Gateway

租户 provider 配置（openclaw 形状 + hermes quirk 字段化）：

```jsonc
{
  "id": "my-deepseek",
  "api": "openai-completions",
  "baseUrl": "https://api.deepseek.com",
  "apiKeyRef": "kms://tenant/xxx/keys/1",     // KMS 信封加密，永不回显
  "models": [{"id":"deepseek-v4","contextWindow":128000,"input":["text"],"price":{...},
              "compat":{"thinkingFormat":"reasoning_content","supportsJsonSchema":false}}],
  "quota": {"rpm":600,"concurrency":50},
  "fallback": ["platform-qwen"]
}
```

- per-request 注入：解析 principal → provider 配置 → pi `apiKey/headers/fetch`；自定义 `fetch` 加出站代理、超时、审计、遥测剥离。
- 平台 key 池：多 key 轮换（含 rate-limit reset 时间）、租户/用户/provider 三级配额、熔断，状态在 Redis；三层 failover（同模型有界重试 → 凭证轮换 → 模型链），failover 是 turn-local 并记录到 `usage/updated.runtime`。
- 方言：pi-ai 已覆盖；`tool-call-repair`（openclaw）作为流后处理；假厂商探针（PoC 脚本）进 CI。

### 7.5 Plugins / Hooks

- Hook 名沿用 Claude Code / codex：`SessionStart | UserPromptSubmit | PreToolUse | PostToolUse | PermissionRequest | PreCompact | PostCompact | SubagentStart | SubagentStop | Stop | Interrupt`。
- 两层：**observer hook**（只观察，有超时、fail-open）与 **middleware**（可改写 LLM 参数 / 工具参数 / 拦截，fail-closed），租户策略（配额、内容安全、审计、模型路由）用 middleware。
- 一期插件形态：① 平台部署的进程内包（随 runner 发布）；② 租户级 **webhook hook**（HTTP 回调，带超时与签名）。**不在共享进程加载租户上传的代码**；需要的话二期在重池以隔离进程/容器承载。

### 7.6 沙箱分层（一期只建轻池）

| | 轻池 | 重池 |
|---|---|---|
| 工具 | API 工具 + 远程 MCP + 动态工具 | + shell / fs / stdio MCP |
| 隔离 | 进程内租户上下文 | 每会话沙箱（exec-server 协议，`ExternalSandbox` 语义）或容器化 opencode |
| 密度 | ~1,000 turn/进程 | 每沙箱一个 |
| 审批策略 | `on-request` 默认 | `untrusted` 默认 + `read-only|workspace-write` 沙箱轴 |

接口预留：`AgentDef.sandbox`、`environments[]`、exec-server 的 `process/* fs/* http/request` JSON-RPC 方法表（codex）。

---

## 8. 存储

### 8.1 MySQL（一期单库，schema 预留分片）

下表同时保留目标态并标注当前边界；实际可迁移 schema 以 `packages/store/migrations/` 为准，当前完成度以 `docs/PROGRESS.md` 最后一节为准。M3 表与 events 外部归档仍只是目标设计，不能据此视为已实现。

| 表 | 关键列 | 说明 |
|---|---|---|
| `tenants` / `api_keys` | | 当前鉴权真相；user identity 来自受信调用方或端用户 token，目前没有独立 `users` 表 |
| `agent_versions` | `(tenant_id, agent_id, version)` | 当前定义快照，不可变；没有单独 `agents` row |
| `sessions` | `session_id PK, tenant_id, user_id(分片键), agent_id, agent_version, status, fence_token, last_seq, last_compaction_seq, parent_session_id, archived_at_ms, deleted_at_ms, deletion_generation` | 当前投影与 lifecycle marker |
| `turns` | `turn_id PK, session_id, seq_start, seq_end, status, stop_reason, body(JSON), started_at_ms, completed_at_ms` | turn 完整资源保存在 `body` JSON |
| `items` | `item_id PK, session_id, turn_id, seq, type, status, body(JSON)` | 完整消息历史；Blob 引用是 body 中的 opaque id，不保存物理 locator |
| `events` | `(session_id, seq) PK, type, body(JSON), emitted_at_ms` | 当前 durable 里程碑事件；分区/外部归档仍是目标态 |
| `approvals` | `approval_id PK, session_id, turn_id, status, body(JSON), expires_at_ms` | 一等资源 |
| `provider_configs` | `(tenant_id, provider_id), config(JSON), secret_cipher, secret_key_id` | 当前 BYOK 加密信封 |
| `mcp_servers` / `skills` / `skill_versions` | scope ∈ platform/tenant/user | M3 目标态，尚未建表 |
| `usage_ledger` | nullable opaque `usage_id` + tenant/user/session/turn/step + usage JSON；`UNIQUE(session_id, turn_id, step)` | operational 归因；legacy row 可暂时没有 `usage_id` |
| `billing_usage_facts` | `usage_id PK, tenant_id, accounting_period, provider/model, token columns, nullable cost, checksum` | 当前最小财务事实；不含 user/session/turn/step/raw JSON |
| `usage_reconciliations` | owner/session/generation + totals/checksum/status | 当前核对/匿名化 operational 证明，最终 subject purge 尚未实现 |
| `idempotency_keys` | `(tenant_id, user_id, session_id, idem_key) PK, request_hash, value, expires_at_ms` | 新版只写 completed receipt；升级期可暂存 legacy pending |
| `subject_lifecycle` / `erasure_requests` / `erasure_audit_events` | tenant + subject + generation/request/status/audit + claim lease/policy identity + quarantine overlay | user erasure gate 与 worker queue；当前最多推进到 `awaiting_purge_policy` |
| `tenant_erasure_admissions` / `tenant_credential_revocation_fences` | tenant/request/generation + policy identity + append-only evidence | `0018` tenant-erasure T1原子gate与全credential逻辑fence；T2经独立platform控制面公开admission/status/replay并由fleet barrier保护 |
| `tenant_credential_revocation_jobs` / `tenant_credential_revocation_receipts` / `tenant_credential_revocation_cutover` | T1 proof + DB-time claim lease + aggregate before/after proof + write-once cutover | `0019` T3a本地DB credential-store清除；只删除API-key/provider行并清空tenant auth三列，不删除registry/content，也不证明runtime/external撤销 |
| `tenant_runtime_revocation_jobs` / `tenant_runtime_revocation_target_receipts` / `tenant_runtime_revocation_receipts` | T1 fence + T3a receipt + DB-time claim lease + configured-fleet/per-target hashes | `0020` T3b本地runtime清空证明；只证明精确configured runners的引用丢弃与已跟踪I/O结算，不证明内存清零、external撤销或content purge |
| `tenant_content_inventory_jobs` / `session_content_receipts` / `tenant_content_inventory_receipts` | T1/T3a/T3b proof + immutable policy + source-high-water DB-time anchor/deadline + per-session identity/state/relationship roots + hold/orphan aggregate | `0021` T3c非破坏性内容清单；枚举session/turn/item/event/approval身份、状态与拓扑，不保存正文/user id/locator/claim token，明确`content_purge_executed=FALSE` |
| `tenant_purge_plan_jobs` / `tenant_purge_plan_entries` / `tenant_purge_plan_receipts` | T1/T3a/T3b/T3c + immutable policy/DB-time deadline + 固定33域count/root/disposition/source hash + blocker root | `0022` T3d非破坏性全域计划；`plan_complete=TRUE`只表示目录完整，`execution_ready=FALSE`、`content_purge_executed=FALSE`固定禁止执行/完成 |
| `retention_policy_versions` / `retention_policy_controls` / `retention_policy_activation_events` | tenant + immutable policy document/hash + generation-fenced active projection + rooted audit | `0015` canonical policy authority；activation提交即生效，但自身不调度或授权physical purge |
| `legal_holds` / `legal_hold_controls` / `legal_hold_events` | tenant/subject/hold + active projection + generation/hash audit | tenant/user多hold账本；单个hold只允许一次release，legacy shadow由canonical active set投影 |
| `erasure_policy_evaluation_jobs` | request/subject/build generation + cursor/root + attempt/token/lease | `0016`非破坏性evaluator队列；只调度`awaiting_purge_policy`，不具备erasure phase或删除权限 |
| `erasure_purge_targets` / `erasure_policy_evaluation_decisions` | per-session content-free摘要 + immutable build generation / rooted decision chain | request-bound deadline、ready Blob/usage/receipt摘要与hold快照；target不是turn/item/event/approval全量内容清单 |
| `erasure_purge_authority_controls` / `erasure_purge_authorities` | generation-CAS active projection + immutable eligible candidate | 无availability/claim/lease，`eligible_execution_disabled`也不可执行；完成证明固定不完整 |
| `user_export_requests` / `user_export_jobs` | tenant/user/subject generation + policy/build + idempotency + claim lease | `0017`异步user export admission与worker queue；request/job原子建立，erasure互锁 |
| `user_export_snapshot_records` / `user_export_snapshot_blobs` | build-scoped whitelist record/root + pinned source descriptor | RR时间点快照；不保存secret、claim或公开物理locator |
| `user_export_artifacts` / `user_export_artifact_parts` | owner/build/deletion generation + deterministic part descriptor + digest/TTL | 只有完整manifest与整体digest验证后才ready |
| `user_export_download_leases` / `user_export_artifact_delete_outbox` | bounded download lease + exact-identity delete claim/CAS | 普通TTL等待活动下载；subject撤销优先清理临时制品 |
| `erasure_job_control_events` | request + control generation + phase/reason/action + actor + evidence commitments | append-only quarantine/maintenance control audit；与普通状态 audit 分离，损坏 control chain 不允许通用自动修复 |
| `erasure_job_terminal_incidents` | request locator + exact raw control fence + fixed reason + evidence commitment + time | unsafe owner/generation/time envelope的append-only content-free事故证据；不复制owner/raw payload，不授予repair/resume权限 |
| `legacy_tombstone_cutover` | singleton + generation + actor/time/evidence | `0014`默认inactive的单向activation；与session写守卫线性化，激活后禁止pre-0009 generation-zero tombstone写入 |
| `legacy_tombstone_compensation_jobs` | owner/session + source proof + attempt/token/lease + terminal result | 每个legacy session一个durable补偿job；worker只可补齐generation 1证明，不能启用purge或删除内容 |
| `legacy_tombstone_compensation_events` | job/session + control generation + before/after evidence + fixed result | append-only成功/terminal incident证据；与session/event/outbox/job完成在同一事务发布 |
| `lifecycle_outbox` | topic + aggregate + generation + claim token/lease | 当前可靠投递 `session.tombstoned`；`session.purge` intent 默认不可领取 |
| `blob_objects` | `blob_id PK, tenant_id, user_id, session_id, item_id, purpose, storage locator, state, integrity descriptor` | ownership manifest；`staging → ready → delete_pending → deleted` |
| `blob_delete_outbox` | `(blob_id, generation) UNIQUE, available_at_ms, claim token/lease, attempts, completion/dead-letter` | 独立的 at-least-once 物理删除队列 |

创建路径：`SessionStore.createSession` 必须在一个原子操作中写入 session 与 `session/created(seq=1)`；MemoryStore 在发布状态前完成整个写集的 staging，MySQLStore 在同一 InnoDB 事务中插入两行。失败不得暴露孤立 session、事件空洞或部分游标。

后续写路径：`SessionStore.commit` 锁定 session 行，再检查 tenant/user subject gate 与 fence（长操作再校验 `expectedLastSeq`），把 `events`、`items`、turn/approval、operational usage ledger、对应 billing fact、幂等 receipt 与 session 投影放进同一个 MySQL 事务；提交后才向 Redis 扇出。session/turn usage 是该单写者事务内的绝对聚合投影，operational ledger 是可归因明细，最小 billing fact 是未来删除内容身份后保留的财务层。

滚动升级兼容：迁移保留旧版 runner 写入的 legacy pending receipt；新版命中 pending 时返回 `409 idempotency_conflict`，不得接管或替换，以免旧 runner 随后执行 delayed complete 覆写新版结果。运维上必须先排空并下线全部旧 runner，确认不存在旧进程后，才可清理已过期 pending。新版自身不再创建 pending，只原子写入 completed receipt。

user erasure 的 durable gate 属于不可撤销 admission。router 只有在 writer gate 开启、`RUNNERS` 中每个 configured target 都健康且同时声明 `dataErasureRequests` 与 policy-aware `dataGovernance`、selected target 仍满足能力时才接受 POST；status GET 继续 fail-closed。新request与policy activation通过同一tenant control锁线性化：观察到active control就把immutable version/hash写入request与首条audit，activation前backlog保持原身份且不能事后补绑。`0015`的MySQL BEFORE INSERT guard还会在activation提交后拒绝旧writer的NULL/partial/wrong binding。runner 内嵌 worker 与 admission 独立，通过 claim-bound `drain-v1` 控制面跨 owner有界请求 abort、child-first tombstone，并在同一事务重验 terminal proof后 reconcile usage，最多到 `awaiting_purge_policy`；它没有一般 SessionStore 写权限，也不执行 anonymize/purge/completed。超时后不主动释放 session lease，router 仅在 Redis 明确确认 owner 消失时绕过旧 runner；未知状态 fail-closed。`0013` 让 Memory/MySQL按候选原子隔离确定性claim-stage poison。安全quarantine envelope保留原phase、移除worker authority并追加无正文control event；管理员只能经独立maintenance capability按canonical evidence + control generation CAS执行固定repair/resume，损坏control audit没有通用自动修复。若request/tenant/subject identity、generation或有序安全时间戳这些隔离坐标本身损坏，store保留原字段与精确raw fence，只清queue authority并原子追加append-only terminal incident；incident不复制tenant/user/subject/raw payload、不猜测owner、不开放repair/resume，且隔离提交后继续邻居。

`0014`为pre-0009 `deletion_generation=0` tombstone增加独立、默认休眠的补偿控制面。Memory/MySQL都支持全局maintenance sweep与有效erasure claim定向enqueue；每个job用attempt/token/lease防ABA，并把异常active turn/pending approval结算、保留原删除时间的terminal event、generation 1、两条lifecycle intent、append-only结果证据和job完成放入同一原子边界。确定性owner/session/child/proof冲突终止为content-free incident并继续邻居；未知故障完整回滚且可重试。该worker不领取`session.purge`，不匿名化usage，也不删除任何正文或Blob。

`0015`建立canonical policy/hold authority但保持destructive path休眠。策略版本不可变，七个duration字段的`NULL`都表示没有到期授权；active control与activation event使用generation CAS、before/after hash和immutable version hash防lost-update、ABA与审计重写。tenant/user legal hold可并存多个active record，control投影承诺active集合，release只结算一个hold；usage anonymize与未来purge必须同时读取tenant和user canonical state。跨runner wall clock只作为审计输入，写入时间在持锁后单调clamp；当前没有scheduled activation模型。管理API另由双端默认关闭的gate与全configured fleet capability激活，管理面本身不能删除数据、推进erasure或领取purge intent。

`0016`建立独立的、默认关闭的purge-policy evaluator/authority substrate，仍不提供destructive executor。request从`reconciling_usage`原子进入`awaiting_purge_policy`时同时建立首个evaluation job；历史awaiting row由显式scheduler补排。job以build generation、attempt/token/lease防止stale/ABA worker，分页写入按generation不可变的per-session target root，并把`unbound/invalid/unconfigured/held/waiting/eligible_execution_disabled`全部追加到rooted decision chain。只有最后一种会写immutable authority与generation-CAS active projection；这些表故意没有execution availability、claim token或lease，公开capability也固定`dataPurgeExecution=false`。

evaluator seal会重新读取request-bound policy、session tombstone、ready Blob摘要、usage reconciliation/billing一致性、receipt摘要，以及tenant/user hold generation和active projection。build过程中live evidence变化会以`evidence_changed`释放claim并开启新build；sealed结果后出现live inventory或hold ABA变化会清除active projection并重新调度，而不覆写旧证据。这里的target是policy候选摘要，不是turns/items/events/approvals的完整owner清单；当前eligibility还使用runner记录的wall clock，跨VM forward/slow skew没有由共享数据库时间线性化。因此authority只能作为non-executable candidate，未来executor必须在破坏性事务中使用数据库/可信时钟、owner-scan与`session_content_receipts`重新证明，并补齐ready Blob ACK、usage匿名化、receipt/Redis清理、secret撤销和restore ledger ACK；当前completion恒为false。

`0017`实现user-scoped异步导出，但不授予任何源数据删除权限。request/job在同一事务建立并绑定active policy的正值artifact TTL；MySQL worker在RR一致性快照中复制owner白名单，再在事务外生成确定性multipart NDJSON。artifact仅在part、manifest与整体digest全部验证后原子ready；download持有有界durable lease，TTL/revocation通过独立delete outbox清理。所有状态都绑定tenant/user、subject/build/deletion generation，跨owner与不存在一致。build/cleanup是runner内部循环；当前filesystem实现只支持local单runner，production在共享对象存储adapter完成前完全不宣告export read capability。

`0018`实现tenant-erasure T1的内部存储边界。独立tenant admission、tenant lifecycle generation、首条无正文audit和append-only credential fence在同一Memory原子边界或InnoDB事务提交；现有API key、provider/auth secret、agent/session普通入口及tenant-key policy/hold管理写在gate后逻辑隐藏或拒写，已解析provider handle在解密或outbound fetch前重验generation。append-only admission或fence还是user-erasure worker与purge evaluator的独立parent-authority fence，mutable lifecycle被异常复位也不会复活claim/renew/transition/session action或policy authority。admission故意不进入`erasure_requests`，避免frozen pre-0018 user worker把无queue authority的tenant row当成poison。

T2在上述存储边界外增加独立platform控制面。公开`POST /v1/tenant-erasure-requests`与status GET只由router拥有；platform bearer在router终止，不进入runner环境或普通tenant代理，runner在环境中发现router-only platform authority会拒绝启动。router注入`INTERNAL_ROUTER_TOKEN`与固定operator identity并改写到版本化runner-only路由，要求固定ACK；新的admission/create path还要求runner在store事务前即时请求router私有barrier，后者刷新并要求每个configured稳定runner当前健康、code-aware且local gate已启用。关闭writer gate时，router把本次POST固定为独立的read-only replay模式：只有精确已提交的tenant/idempotency key/hash可返回原`202`，未命中返回`503`，即使gate在请求途中打开也不得升格为create。status/replay不依赖writer gate，但要求healthy code-aware target，并在Memory同步视图或MySQL一致性快照内校验admission、lifecycle、credential fence和首条audit。路径编码、合并Authorization、伪造内部header、错误ACK和直接runner访问均fail-closed。pre-`0018` runtime必须先排空，首次admission后只能forward-fix。

`0019`实现tenant-erasure T3a的本地数据库credential-store清除，不等同于完整T3。新admission在原T1事务内同时建立独立queued job；`0018`时期已经提交的admission只由显式materializer在验证admission、lifecycle、首条audit与fence的完整T1 proof后补job，migration本身不扫描、不回填、不删除。runner内嵌的最小权限worker使用数据库时间计算claim/renew/retry lease，并在materialize/claim及紧邻不可逆事务前取得router的fresh all-configured barrier；claim attempt/token/lease阻止ABA与stale worker。

完成事务按固定锁序重新核对raw tenant identity、request/generation/T1 evidence和有效claim，并在首次DELETE前锁定全局cutover、验证完整proof。inactive generation要求receipt与terminal job同时为空；active generation必须把首receipt重新绑定到对应terminal job、completion proof及append-only T1 admission/首audit/fence，任何孤儿、缺失或冲突证据均fail closed。terminal proof不依赖mutable lifecycle，因而后续T3b把projection推进为`erased`或清理后仍可验证；queued/blocked读取、claim/control和DELETE则始终要求live `deleting` lifecycle与精确request/generation。随后删除该tenant所有`api_keys`行（包括已revoked verifier）与所有`provider_configs`行，并把`tenants.auth_policy`、`auth_secret_cipher`、`auth_secret_key_id`清空；tenant registry和全部session/content/usage/receipt/Blob保留。相同事务再扫描确认post-state为零，写入不含key hash/provider id/config/header/cipher/key-id的immutable aggregate receipt，完成job并在首个receipt时激活write-once cutover。receipt的scope固定为`local-db-credential-material-v1`，并明确`runtimeDisposition=not_in_scope`、`externalDisposition=not_supported`、`contentPurgeRequired=true`；响应丢失只允许精确completed claim identity重放，不能从当前空表推断成功。任一步失败整体回滚。公开tenant status仍为`gated`，protocol的`dataPurgeExecution`继续为`false`。

`0020`实现T3b的configured-fleet runtime/cache/active-I/O drain，但仍不等同于完整T3。runner内的单一tenant coordinator覆盖TenantPolicyCache、end-user JWT/JWKS/introspection verifier、provider registration、SessionHost与动态工具引用，并把auth/provider/turn等操作以tenant lease跟踪。drain先同步fence新操作，再abort底层fetch/turn，等待已接纳operation settle，清空本地引用，最后要求cache、active operation和active turn计数全部为零；任何hook异常、超时或无法取消的response body都会保持tenant fenced并让本次证明fail closed。service API key当前没有进程级verifier cache，每次都从store解析，故receipt不虚构这一类缓存清理。

router只对`RUNNERS`中的每个稳定、逐实例直连origin执行私有fan-out，前后fresh探测并要求runnerId/bootId不变、全fleet唯一；LB别名不满足证明边界。Memory/MySQL的独立worker先把已完成T3a proof materialize为`0020` job，再以数据库时间claim；完成事务同时写入每个target的append-only receipt、aggregate receipt和terminal job。target URL、runnerId与bootId只以SHA-256保存，响应丢失只能用同attempt/token和逐target精确proof重放，不能从当前空缓存推断成功。receipt明确声明`memoryDisposition=references_dropped_not_zeroized`、`externalDisposition=not_supported`、`contentPurgeRequired=true`：JavaScript字符串无法保证清零，远端provider请求可能已经产生副作用，外部provider/KMS凭据未撤销，tenant registry和全部content/usage/receipt/Blob/Redis仍保留。

`0021`实现T3c的非破坏性content inventory。默认关闭的runner内嵌worker只从完整T1/T3a/T3b proof显式materialize；事务在所有可能等待的source/policy锁之后读取数据库时间，且anchor必须不小于T3a credential receipt与T3b runtime receipt两个DB时间的最大值，再按T1绑定的policy计算deadline。数据库时钟低于source high-water、既定anchor或已写page evidence时分别返回可重试的`trusted_clock_before_source`、`trusted_clock_before_anchor`、`trusted_clock_before_evidence`，不转成integrity block。分页事务锁读tenant session及其turn/item/event/approval，schema-parse持久化body并核对索引列，验证owner/parent DAG/seq和event引用；content-free roots绑定结构identity、生命周期状态及关系投影。只有`contextCompaction`允许synthetic `turnId`而无turn row；approval canonical关系是唯一同session/turn且toolCall/name一致的`approvalRequest.approvalId → Approval.id`，legacy `Approval.itemId`仍进入历史hash但不是外键。任何分页后拓扑漂移都会在seal复算时触发`evidence_changed`。

page在全部session receipt INSERT后重新读取DB time并复核attempt/token/live lease；过期时receipt、cursor与job update整事务回滚。seal使用显式`REPEATABLE READ`重新扫描并锁定五类全库结构关系，以next-key/gap lock关闭orphan插入窗口，再验证tenant及全部已知user的canonical legal-hold ledger。pre-insert `finalNow`同时成为aggregate `storeDbTimestampMs`与job `inventorySealedAtDbMs`；aggregate INSERT后的`publishNow`只重新验证lease并单调抬高`updatedAtMs`，过期则aggregate与terminal transition一起回滚。receipt不包含正文、user id、Blob/外部locator或claim token，且固定`contentInventoryComplete=true`、`contentPurgeExecuted=false`；它只是时间点proof，未来executor必须重验并补齐ready Blob/session/idempotency/Redis、usage、external/KMS、backup/restore ACK。

`0022`实现T3d的非破坏性full-domain purge plan，仍不等同于destructive T3。默认关闭的runner内嵌worker只从完整T1/T3a/T3b/T3c、request-bound immutable policy和可信DB-time deadline显式materialize。固定33域包含registry/profile、agent/session/idempotency、usage/billing、Blob/outbox、export、user/tenant lifecycle/governance evidence、Redis、external provider、KMS、backup/restore及logs/traces；catalog不能随部署环境或adapter集合漂移。每条entry只保存target count/root、固定disposition、source hash与DB capture time，不保存正文、user id、credential、locator或raw claim token。

无adapter不是空集合：Blob bytes、export bytes、Redis lease/fence/stream、backup、restore、logs/traces固定形成9个blocker。T3a receipt没有provider secret/BYOK-KMS细分，故只有provider与tenant auth历史计数都为零时external-provider/KMS两域才可标为`not_applicable`；仅tenant auth envelope非零时KMS域阻断，合计10个；任一provider config非零时必须保守地同时阻断external-provider与KMS，无论auth是否也非零，合计11个。旧locator/secret已经不可恢复的域只能标为`blocked_legacy_external_source_unavailable`。计划仍允许seal以证明缺口完整可见，但aggregate固定`planComplete=true`、`executionReady=false`、`contentPurgeExecuted=false`。

生产worker不通过分页逐步发布计划：对新空job直接调用seal，Memory在单一原子边界、MySQL在一个显式`REPEATABLE READ`事务中重验live T3c source、canonical tenant/全部user hold、全局owner closure、DB clock与claim lease，然后一次性写入全部33条entry、aggregate receipt和terminal job。owner closure要求idempotency、usage ledger/reconciliation对应同tenant/user/session，并在MySQL中对其全范围执行`FOR SHARE`直到commit，阻止scan后并发phantom写入。legacy pending idempotency的`NULL` value仍是可接受的升级期状态；历史completed值`{turnId}`只在该turn反向解析到同一session时兼容，新格式若显式带`sessionId`也必须相同。operational usage可合法引用无turn row的synthetic/legacy turn，因而只强制session owner；usage reconciliation则必须对应已tombstone的session及其精确正generation。subject lifecycle↔user erasure request/tenant admission必须双向闭合，erasure purge target必须精确匹配session tombstone的generation与deletion timestamp；任何孤儿、跨owner或时点漂移都fail closed。最后一个可能阻塞的写入之后仍需用数据库时间重验lease，过期则整批回滚。分页build仅保留为诊断/兼容路径，不由生产worker调用；任何partial entry都不是sealed authority。tenant T1后仍合法queued且build generation为`0`的export必须作为明确值进入root，不能误判为已撤销或因falsy判断漏掉；download lease只允许把claim token的domain-separated hash写入证据，不能保存raw token。Memory/MySQL store接口没有delete/anonymize/revoke/completion方法；响应丢失只允许exact claim identity重放。

T3a rollout独立于T2 admission：先应用expand-only `0019`，发布`TENANT_CREDENTIAL_REVOCATION_EXECUTION_ENABLED=0`的新router并排空旧router，再滚动`TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED=0`但声明`credential-store-v1`的新runner；逐runner开启worker、核对全部configured稳定地址健康且worker-active，最后开启router execution gate。首个receipt激活write-once cutover后不得回退pre-`0019` writer/worker，只能forward-fix；关闭execution只暂停新批次，不恢复已经删除的credential或撤销durable evidence。

T3b rollout另用三道默认关闭gate：先应用expand-only `0020`；发布`TENANT_RUNTIME_DRAIN_EXECUTION_ENABLED=0`的新router并排空旧router；滚动`TENANT_RUNTIME_DRAIN_ENABLED=0`、`TENANT_RUNTIME_REVOCATION_WORKER_ENABLED=0`且具有稳定`RUNNER_ID`的新runner；逐实例开启私有drain endpoint并核对configured direct origins与runner/boot identity，再开启worker，最后开启router execution。部分fan-out失败可能已经fence此前target，此状态不可回滚，只能修复配置并精确重试。关闭execution/worker只暂停新批次，不解除已经提交的fence或删除receipt；`0020` receipt也不授权content purge或公开completion。

T3c rollout不新增router端点或第三个服务：先应用expand-only `0021`，再把全部新runner以`TENANT_CONTENT_INVENTORY_WORKER_ENABLED=0`滚动上线；核对新表、append-only guards和新binary后才逐实例开启worker。migration会严格fingerprint engine/collation/no-partition、列顺序/类型/default/charset/extra/generation、ENFORCED CHECK、完整index shape和精确trigger set；同名但不兼容的人工/中断DDL必须fail fast。queued未claim要求`available_at_ms >= updated_at_ms`，claimed要求`lease_until_ms >= updated_at_ms`，retry也由永久guard维持单调时间。关闭worker只暂停新materialize/claim，不删除job/receipt；首个`0021`证据提交后不得回退到会忽略它的旧reader/worker。当前seal的全库五表RR共享锁扫描是本地/CI正确性基线，不是最终大规模生产方案；M4必须以FK/tenant owner索引、分区或等价一致性机制消除全库扫描和跨tenant写阻塞，并完成容量压测。

T3d rollout同样不新增router端点或第三个服务：先应用expand-only、execution-dormant的`0022`，再把全部新runner以`TENANT_PURGE_PLAN_WORKER_ENABLED=0`滚动上线；核对三张表的严格schema/index/CHECK/trigger fingerprint、append-only guards与新binary后才逐实例开启worker。migration不扫描T3c、不回填plan、不调用adapter或执行任何处置。关闭worker只暂停新materialize/claim，不改变公开status或已写receipt；首个`0022`证据提交后必须保留schema并forward-fix。未来destructive executor应是独立默认关闭、最小权限的协议，并在执行边界重新验证0016/T3c/T3d、canonical hold、owner关系和全部物理ACK，不能为省去blocker而动态删减catalog。

普通erasure worker与legacy补偿worker在每次数据库claim或cutover activation前都要求router私有v2 barrier，证明本进程已观察每个稳定`RUNNERS`地址同时支持`quarantine-v1`和`legacy-tombstone-compensation-v1`；公开capability不暴露这个rollout状态。policy evaluator使用另一条token-protected固定ACK barrier，runner/router两端`PURGE_POLICY_EVALUATOR_ENABLED`均默认关闭，且router只有在每个configured稳定地址当前健康并声明`policy-evaluator-v1`时才放行一次schedule/claim pass；该ACK不携带request、tenant或删除权限。v1 barrier路径故意返回404，阻止pre-0014 worker混跑。首次接受gate后不得恢复lifecycle-unaware writer；任一0013 control证据写入后不得恢复pre-0013 reader/worker；0014 cutover从generation 0激活为1后，session trigger会拒绝新的legacy tombstone写，且不得恢复pre-0014 writer/worker。回滚只能forward-fix，或在尚未越过相应不可逆边界前先排空并在edge阻断相关流量。

当前T3d全库RR/next-key owner扫描是local/CI正确性基线，在staging必须验证索引、容量、跨tenant写阻塞/死锁、lease预算和锁超时。损坏的queued purge-plan envelope可能在逐候选隔离前解析失败并饿死后续job，cursor重启还会重扫损坏前缀；该路径fail-closed、无receipt/执行authority，但M4仍应增加不信任字段的raw-key quarantine/skip。`0022` migration的trigger fingerprint目前只绑定trigger集合/元数据而不校验action body，历史迁移夹具也只显式模拟第一个DDL auto-commit边界；这些是特权schema tamper与测试深度的剩余风险，不改变当前无destructive authority的结论。

全局orphan/cross-owner损坏当前会使claim终结为`blocked`，从而保证没有receipt或执行authority被伪造；但修复底层数据不会自动resume/rebuild该plan，所以可形成永久的per-tenant fail-closed可用性阻塞。未来需要受审计的operator repair/resume协议，不能通过手工改job状态或删除evidence规避。

T3d owner closure还包括Memory中export request、user erasure request与tenant admission到idempotency索引的反向完整性。Memory/MySQL中的legacy compensation deterministic `jobId`必须绑定精确session owner/tombstone generation/time；MySQL还重算`candidateSha256`并校验`sourceLastSeq`。`erasure_claim`必须精确匹配request/generation，job status必须对应单个匹配audit/result，completed event seq必须等于`session.lastSeq`且success evidence完整。任一关系断裂都fail closed并回滚atomic seal；有效回归使用T3c可接受的completed fixture实际到达该闭包，不能被旧generation-zero guard提前挡住。

### 8.2 Redis 键

`lease:{sid}` `fence:{sid}` `owner:{sid}` `stream:{sid}` `quota:{scope}:{id}` `keypool:{provider}` `mcp:catalog:{principal}:{serverId}`。幂等 completed receipt 是 MySQL 业务真相，不在 Redis 预留。

### 8.3 迁移路径

本地 MySQL 单库 → 云 RDS（按 `user_id` 1,024 逻辑分片，先逻辑后物理）；单 Redis → Cluster；Streams → Kafka（按 sessionId 分区）；大字段从第一天走 OSS 引用。存储接口 `SessionStore` / `EventLog` / `BlobStore` 抽象，实现可替换。

---

## 9. 容量与成本（20M DAU，中档：3 turn/DAU/天，90s/turn）

| 指标 | 值 |
|---|---|
| turn / 天 | 6,000 万 |
| 峰值 QPS（×4） | ~2,800 |
| 峰值并发 turn = 并发 SSE 下限 | ~25 万 |
| 轻池 runner 进程 @1,000 turn/进程 | ~250 |
| 里程碑事件 / 天 @10/turn | 6 亿（~180 GB/天 @300B） |
| 若 delta 落库 | 900 GB/天 → **禁止** |
| Redis Stream 峰值 | 15–30 万 msg/s → 分片 |
| LLM 成本 / 月（单步、缓存 85%） | ~¥6.7M；agent 4× token 时 ~¥27M |

直接后果：delta 不落库；厂商 RPM 配额是硬上限（需多 key + 多厂商 + 企业配额）；`prompt_cache_hit_ratio` 是头号成本指标；沙箱不能 per-session 默认开。

---

## 10. 技术栈与 monorepo

> 以下是 v0.1 的**目标态目录树**，不是当前文件清单。当前实际目录见仓库根 `README.md`；例如租约实现现位于 `packages/store/src/redis/`，OpenAPI 生成链路和 `packages/sdk` 已实现并纳入 CI，而 MCP、skills、hooks 和 Kubernetes 清单仍属于后续里程碑。

```
agent-service/
├── apps/
│   ├── agent-router/        # Hono；所有权目录、capability gate、幂等 turn 安全重路由、SSE 反代
│   └── agent-runner/        # Hono；SessionHost、engines、tools、providers、SSE
├── packages/
│   ├── protocol/            # zod schema + OpenAPI 生成 + 事件类型（codex 类型移植，含 NOTICE）
│   ├── core/                # AgentEngine 接口、PiEngine、context assembly、safety、compaction、repair
│   ├── store/               # SessionStore/EventLog/BlobStore 接口 + mysql/redis/memory 实现 + 迁移
│   ├── lease/               # Redis 租约、fence、owner 目录（Lua 脚本）
│   ├── providers/           # BYOK 解析、key 池、配额、方言探针、tool-call-repair
│   ├── mcp/                 # MCP 客户端桥、注册表、SSRF 防护
│   ├── skills/              # SKILL.md 解析、provider、skills_guard
│   ├── hooks/               # hook/middleware 分派
│   ├── sdk/                 # 由 OpenAPI 生成的 TS 客户端
│   └── testkit/             # 假厂商（deepseek/dashscope 方言）、假 MCP server、契约测试
├── deploy/                  # docker-compose(mysql+redis)、k8s 清单
├── docs/                    # research/ design/ adr/
└── pnpm-workspace.yaml
```

选型：TypeScript + Node 24 LTS（pi 是 TS；PoC 是 TS；团队栈未确认，见 §13）；pnpm；Hono + `@hono/zod-openapi`；`mysql2` + drizzle；`ioredis`；`@modelcontextprotocol/sdk`；vitest；OpenTelemetry。pi 用精确版本 pin 并 vendoring 打包。

---

## 11. 里程碑与验收

| 里程碑 | 交付 | 验收（可自动化） |
|---|---|---|
| **M0 调研**（已完成） | `docs/research/01–07`、本文 | — |
| **M1 单节点 runner MVP**（2–3 周） | 协议包 + OpenAPI；runner：sessions/turns/items/events/approvals；PiEngine；BYOK provider 配置；内置工具；MySQL+Redis 存储；安全阀；压缩；崩溃恢复；假厂商 | 端到端 SSE 一轮 ≥3 step + 工具；`?after=` 无重复无空洞；前缀 sha256 三请求一致；跨租户 404 不可区分；五条安全阀触发；八条生产坑测试通过；真实 deepseek/qwen key 探针通过 |
| **M2 router + 多节点正确性**（1–2 周） | agent-router；租约 + fence + 续期 + drain；owner 目录；idempotency | **3 runner + 1 router 共享 MySQL/Redis，turn 中 kill 租约持有者：另一 runner 接管、事件无空洞、客户端补齐**；10 并发 writer 只 1 成功；旧 fence 写入被 DB 拒绝 |
| **M3 扩展性**（2–3 周） | 远程 MCP 注册与桥接；skills 上传/注入/guard；hooks/middleware + webhook hook；动态工具反向委托 | MCP 工具在 turn 中被调用并落 item；skill 目录注入去重；hook 超时 fail-open/closed 行为；SSRF 用例被拒 |
| **M4 生产化**（2–3 周） | 配额/key 池/熔断；OTel + 指标；压测（单进程并发 turn 上限实测）；Streams 分片；k8s 清单；重池/exec-server 设计评审 | 单 runner 1,000 并发 turn 压测报告；`prompt_cache_hit_ratio` 面板；混沌测试（Redis 抖动、厂商 5xx） |

---

## 12. 风险

| 风险 | 对策 |
|---|---|
| pi 每版 Breaking、新贡献者 PR 自动关闭 | pin + vendoring；`AgentEngine` 边界；NativeEngine 退路；契约测试驱动升级 |
| 国产厂商未文档化的流式行为 | 假厂商复刻方言进 CI；M1 就打真实 key 探针 |
| 20M DAU 的厂商配额 | 早做企业配额谈判；多 key 池 + 多厂商从 M4 起 |
| 前缀缓存在多租户下难保持 | `contextEpoch` 复合键 + 增量通知 + CI 回归 |
| 审批/长 turn 与发布缩容冲突 | step 边界 checkpoint + drain；审批落库 + `expiresAt` |
| 内容安全（国内上线硬要求） | 作为 middleware 插槽预留；输出侧分段送审会改流式主路径，需尽早定策略（见 §13） |
| 多租户 MCP 的安全面 | §7.2 自写清单一期全部做；`untrusted` 默认 |

---

## 13. 决策记录（最初默认值加粗）

| # | 决策 | 选项 | 默认 | 影响 |
|---|---|---|---|---|
| 1 | 技术栈 | **TypeScript/Node** · Go · Java | TS | 选 Go/Java 则 pi 复用路径不成立，loop/provider 全自研，M1 工期 ×2 |
| 2 | agent loop | **内嵌 pi（Agent 类）+ AgentEngine 边界** · 纯自研 · 内嵌 dsh | pi | 见 §6.1 |
| 3 | 一期是否提供代码执行（shell/fs 工具、沙箱） | **不提供，预留重池接口** · 提供（需要 exec-server + 容器编排） | 不提供 | 提供则 M1 后新增 2–4 周，容量模型改变 |
| 4 | 鉴权模型 | **service key + X-User-Id** · 端用户 JWT 直连 · 两者都支持 | service key + X-User-Id | 影响 router 鉴权实现与 SDK |
| 5 | 对外资源名 | **`sessions`** · `threads` | sessions | 只影响命名 |
| 6 | 内容安全策略 | 全量后审 · 分段送审可回滚 · **一期只留 middleware 插槽** | 插槽 | 分段送审会改流式主路径 |
| 7 | 本地基础设施 | **brew 装 Redis + 已有 MySQL 8.0** · 安装 Docker/OrbStack 用 compose | brew | 本机没有 Docker；两种都会写 compose 文件供他人使用 |
| 8 | 现有基础设施对齐 | K8s？MQ（Kafka/RocketMQ）？RDS 类型（MySQL/TiDB）？Redis 规模？ | 按 MySQL + Redis + Kafka 假设 | 影响 M4 与 deploy/ |

这些默认值已作为 M1/M2 的实现起点；身份鉴权后来扩展为 `trusted_caller` 与 `end_user_token` 两种租户级模式，定稿见 `docs/design/01-identity-and-auth.md`。其余决策的当前状态以代码和 `docs/PROGRESS.md` 为准。

---

## 14. 原始缺口清单（v0.1 设计时快照）

> 本节保留设计形成时的缺口，不能直接当作当前待办；其中多项已实现或调整。当前剩余事项以 `docs/PROGRESS.md` 最后一节为准。

| # | 缺口 | 补齐方式 | 时机 |
|---|---|---|---|
| 1 | **pi 嵌入假设未实跑**：`Agent` 类装载历史、`streamFn` 注入 per-call apiKey、事件映射、abort 传播都来自读源码，没有运行验证 | M1 第一件事做 spike：`packages/core` 里写 PiEngine 最小版打真实 deepseek/qwen | M1 首周 |
| 2 | 协议只有资源与事件清单，没有字段级 schema、错误信封、API 版本与兼容策略 | `packages/protocol` 用 zod 定义并生成 OpenAPI；`docs/design/01-protocol.md` | M1 |
| 3 | 子 agent（task 工具）模型：子 session 的租约归属、事件如何投影到父 session、并发上限 | `docs/design/02-subagents.md`；一期子 agent 与父 session 同 runner 同租约 | M1 后期 |
| 4 | 忙时输入（steer / queue / reject）的精确语义：steer 注入点、队列长度上限、与审批等待的交互 | 写进 01-protocol.md，参考 opencode `SessionInput` 与 openclaw 四档 | M1 |
| 5 | 安全威胁模型：SSRF、prompt 注入、BYOK 密钥处理、动态工具结果信任边界、MCP `untrusted` | `docs/design/03-threat-model.md` | M3 前 |
| 6 | 数据生命周期：会话/事件/附件保留期、用户删除（PIPL 个人信息删除权）、审计日志保留、导出 | `docs/design/04-data-lifecycle.md`；schema 预留 `deleted_at` 与归档任务 | M1 schema 定稿前 |
| 7 | 可观测性规范：指标清单、trace 传播（W3C traceparent 从 router 到厂商请求）、结构化日志字段与脱敏级别（按租户配置） | `docs/design/05-observability.md` | M2 |
| 8 | 限流与配额策略的具体层级与算法（租户 / 用户 / provider；令牌桶 vs 并发槽） | 写进 providers 包设计 | M4 |
| 9 | 长期记忆注入钩子的接口形状（前缀区 / 追加区两个注入点 + epoch bump） | 作为 hooks 的一种 middleware 定义 | M3 |
| 10 | 决策记录：本文的关键取舍尚未拆成 ADR | `docs/adr/0001-embed-pi.md` 等，随实现逐条补 | 持续 |
| 11 | 本地无法验证的项：真实 OSS / KMS / Kafka / K8s drain / 厂商配额 | 全部藏在接口后并提供本地实现（文件 blob store、本地密钥加密、Redis Streams、进程 SIGTERM drain）；云上部署时只换实现与配置 | 部署前 |
