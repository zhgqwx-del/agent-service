# agent-service

分布式、多租户的 agent API 服务：无状态 `agent-router` + 有状态 `agent-runner`（类 `opencode serve`）。当前已实现会话/turn/SSE、BYOK、租约与 fencing、多节点路由和接管；MCP、skills、plugins/hooks 属于后续 M3。设计见 `docs/design/00-architecture.md`，调研见 `docs/research/`。

## 状态

- **M0 调研**：完成。
- **M1 单节点 runner MVP**：核心运行链路、OpenAPI 3.1、生成 TypeScript SDK、可逆 Archive v2、fenced tombstone、可靠 terminal-event outbox dispatcher、Blob ownership/业务接线，以及默认关闭的 user erasure durable gate/request/status 和 usage operational/billing 分层、核对/匿名化 primitive 已实现；异步 export artifact/TTL、erasure worker 状态推进、tenant erasure/key revocation、legacy generation `0` 补偿及默认关闭的 ready/session 物理 purge 仍待按 `docs/design/04-data-lifecycle.md` 完成，因此还不能宣称完整数据生命周期闭环。
- **M2 router + 多节点**：`agent-router`、租约/fence、owner 目录、drain、原子 session 创建与真实多进程接管测试均已实现并通过自动验收；本地/CI 代码范围已正式冻结，生产 Kubernetes/云资源部署在环境参数明确后单独交付。
- **M3 扩展性**（MCP、skills、hooks）：尚未正式开始，已有动态工具反向委托等前置地基。
- **M4 生产化**（配额、可观测性、限流）：核心范围尚未开始；Docker、CI 和本地运维脚本等交付地基已经具备。

测试分为纯单元/HTTP/假厂商、MySQL/Redis 集成、多进程集群和显式启用的真实模型 E2E；准确数量和覆盖率以当前 CI 输出为准，避免在 README 固化易过期数字。

## 本机运行

```bash
# 依赖：Node 24（fnm）、pnpm 12、MySQL 8（已有）、Redis（deploy/local/install 说明见 infra.sh 头部）
pnpm install
deploy/local/infra.sh start          # 启动 redis + mysql，建库 agent_service / agent_service_test
cp .env.example .env                 # 真实模型只强制 API_KEY；base URL / model 可覆盖默认值

# 单节点（MySQL + Redis）
STORE=mysql REDIS_URL=redis://127.0.0.1:6379 pnpm dev:runner
# 纯内存（不需要任何中间件）
STORE=memory REDIS_URL= pnpm dev:runner
```

```bash
# 手动验收（十个环节：鉴权/流式/重放/幂等/上下文/安全阀/隔离/BYOK）
deploy/local/infra.sh start
STORE=mysql REDIS_URL=redis://127.0.0.1:6379 pnpm dev:runner   # 另一个终端
scripts/demo.sh

# 测试（四层，前三层不需要任何 API key）
pnpm test                                     # 单元 + 方言（假厂商）
AGENT_SERVICE_INTEGRATION=1 pnpm test         # + MySQL/Redis 一致性套件（两个后端跑同一套契约）
pnpm test:migrations                          # 固定 0007 → 0008 → 0009 → 0010 → 0011 的真实 MySQL 历史升级夹具
pnpm test:blob-mysql                          # 强制执行并验明 ownership/绑定/cleanup 的真实 MySQL 专项套件
pnpm test:usage-lifecycle-mysql               # 强制执行 usage 双写/核对/匿名化真实 MySQL 专项套件
pnpm test:subject-lifecycle-mysql             # 强制执行 subject gate/回滚/并发真实 MySQL 专项套件
pnpm test:cluster                             # + 多进程集群：2~3 runner + 1 router，SIGKILL 租约持有者
pnpm check:api                                # OpenAPI 与生成 SDK 漂移检查
pnpm check:sdk                                # 编译 SDK、原生 Node import，并校验 pnpm pack 内容
set -a; source .env; set +a; AGENT_SERVICE_REAL_E2E=1 pnpm vitest run packages/providers/test/e2e-qwen.test.ts
pnpm typecheck

# 生产构建验证（SDK 发布包 + 两个应用的单文件 bundle，原生 node 启动，不依赖 tsx）
pnpm build:check
docker build --build-arg APP=agent-runner -t agent-runner .
docker build --build-arg APP=agent-router -t agent-router .
```

也可以通过统一的本地运维入口完成生命周期与验证：

```bash
scripts/local-service.sh start
scripts/local-service.sh status
scripts/local-service.sh smoke
scripts/local-service.sh acceptance   # 使用真实模型，会产生少量费用
scripts/local-service.sh verify       # secret/API drift/typecheck + 集成/coverage + 历史迁移 + cluster + 构建产物启动
scripts/local-service.sh verify-real  # 仅在显式命令下读取 .env 的真实模型 key
scripts/local-service.sh cleanup-idempotency --dry-run  # 检查/分批清理过期 completed receipt
scripts/local-service.sh stop
```

详细配置与未来 staging/production 部署契约见 `docs/operations/local-and-deployment.md`；面向项目学习、手动体验和 CI 构建产物的完整说明见 `docs/operations/development-and-ci-guide.md`。

## 部署形态

```
客户端 → agent-router（无状态，N 副本）→ agent-runner（有状态，N 副本）
                  ↓ 读 Redis 所有权目录            ↓ 租约 + fence
              一致性哈希兜底                  MySQL / Redis / BlobStore
```

`agent-router` 的核心职责是按 sessionId 找到持有租约的 runner、把 SSE 原样透传、收到 runner 的 `409 + X-Owner` 后安全重路由，并在发布窗口执行 protocol/capability gate。它没有业务状态，可随时重启。

tombstone 是现有 `2026-10-08` protocol family 内的 additive capability。router 只有在显式设置 `SESSION_TOMBSTONE_ENABLED=1` 且全部健康 runner 都声明 `tombstone` 时才开放 session DELETE；本地脚本默认启用。外部 DELETE 会被改写为带 `INTERNAL_ROUTER_TOKEN` 的版本化 runner-only POST，并要求新 runner 回 ACK；内部路径不进入 OpenAPI，客户端伪造的内部 header 会被剥离。`RUNNERS` 必须是实例稳定地址，runner 端口必须保持内网不可直连。staging/production 需先在 edge 暂停精确 session DELETE（或整体切换 router 池），再按“新 router（gate=0）→ 排空旧 router → 滚动新 runner → 核对 fleet capability → 激活 gate”的顺序升级；旧 router 本身没有该 gate。

user erasure request 也是 additive、默认关闭的 capability。只有 runner 与 router 都显式设置 `DATA_ERASURE_REQUESTS_ENABLED=1`，且 `RUNNERS` 中每个 configured target 都已通过健康探测并声明支持、选中 target 也仍支持时，router 才接受 `POST /v1/data-erasure-requests`；暂时不可达的已配置实例不会被当成已排空。writer gate 保持 `1` 时，router 还会在每次转发前阻止 session/usage 等 user-scoped runtime 落到能力已回退的 target；gate=`0` 的 expand mixed window 不受此限制。当前公开范围仅限 admin service key 代表一个明确 user 发起带 `Idempotency-Key` 的请求：它原子写入 subject gate、request 和首条 audit，并立即隐藏该 subject 的 session/turn/item/approval/usage/receipt/Blob 普通读取、阻断对应 durable 写入；tenant-scoped agents/provider/auth/api-key 不在这个 user gate 内。状态只推进到 `gated`，不代表既有 SSE/active turn 已 drain，更不代表后台擦除或物理 purge 已执行。status GET 不依赖 router writer gate，继续按当前 healthy fleet 与选中 target capability fail-closed；healthy fleet 混入旧 runner 时返回 `503`，不会随机得到误导性的 `404`。POST/GET 的成功与错误响应都强制 `Cache-Control: no-store`，避免同一管理凭证代理多个 user 时被中间缓存串读。任一 erasure request 首次成功接受后，关闭 router writer gate 只能停止新请求，不能撤销 durable subject gate，也不能安全地把 user 流量回退给 pre-`0011` 或 lifecycle-unaware runner；必须保持 capable fleet 并 forward-fix，紧急旧版恢复前需先在 edge 阻断受影响 subject，无法精确阻断时阻断全部 user-scoped runtime 流量。完成 worker 前只允许本地对可丢弃 user 体验，方法见 `docs/operations/development-and-ci-guide.md`。

本地统一入口当前启动单个 router、单个 runner，并把 Blob 写入 runner 独占的 `.local-run/blobs`。Blob 上传另有 `BLOB_ATTACHMENTS_ENABLED` 显式 gate，router 还会检查全部健康 runner 的 `blobAttachments` capability；当前 filesystem adapter 同时要求显式 `BLOB_FILESYSTEM_SINGLE_RUNNER=1`。它不能作为多 VM/多 Pod 共享存储，production runner 对 filesystem 写入和 cleanup 都会 fail closed；接入共享 OSS/S3 adapter 前不得在生产开启这两个工作循环。

## API 速览（对外经 `apps/agent-router`）

鉴权两层：`Authorization: Bearer <service api key>`（→ tenant）+ `X-User-Id`（trusted caller）或 runner 验证的端用户 token。入站 token header 不能占用 service/user/framing/hop-by-hop 保留头；即使数据库中存在升级前的坏策略，admin service key 仍可通过 `/v1/tenant/auth` 修复。开发用 key 由 `BOOTSTRAP_API_KEY`（默认 `dev-key`）注入。

```bash
BASE=http://127.0.0.1:8080
H=(-H "Authorization: Bearer dev-key" -H "X-User-Id: u_42" -H "Content-Type: application/json")
# agent 定义（版本化）
curl -sS -X POST "$BASE/v1/agents" "${H[@]}" -d '{"name":"assistant","instructions":"你是一个简洁的助手。","model":{"provider":"dashscope","model":"qwen3.8-max"},"tools":["current_time","web_fetch"],"limits":{"maxSteps":6}}'
# session
curl -sS -X POST "$BASE/v1/sessions" "${H[@]}" -d '{"agentId":"agt_..."}'
# turn（SSE；id: 为 seq，Last-Event-ID / ?after= 可续订；?exclude= 过滤事件）
curl -sN -X POST "$BASE/v1/sessions/sess_.../turns?exclude=usage/updated" "${H[@]}" -H "Idempotency-Key: k1" -d '{"input":[{"type":"text","text":"现在几点？"}]}'
# 非流式：{"stream":false} → 202 + turn；之后 GET .../events?after=<seq> 消费
# 幂等键按 tenant + user + session 隔离；同 key 异请求 → 409。stream 不参与请求 hash；重放命中时固定返回
# 200 application/json {turn} + Idempotency-Replayed: true，需要事件流时用 GET .../events?after=<seq> 续订。
# 其他：GET .../items | .../turns | POST .../turns/{id}/interrupt | steer | tool-results（动态工具回填）
#       GET/POST .../approvals/{id} {decision: accept|acceptForSession|decline|cancel}
#       GET/PUT/DELETE /v1/providers/{id}（BYOK，apiKey 只写不读，AES-GCM 落库）  GET /v1/models  GET /v1/tools
#       POST .../blobs（图片原始字节） | GET .../blobs/{blobId} | GET .../items/{itemId}/output
#       POST .../archive | .../unarchive | .../resume  DELETE /v1/sessions/{id}（fenced tombstone，不物理 purge）
#       POST /v1/data-erasure-requests（admin + user + Idempotency-Key，默认关闭）
#       GET /v1/data-erasure-requests/{requestId}（仅同 tenant/user；当前状态停在 gated）
#       GET /v1/capabilities  GET /openapi.json  GET /healthz /readyz
```

事件类型与资源 schema 在 `packages/protocol/src/`（zod，单一真相）。`pnpm generate:api` 由同一组 schema 确定性生成并提交 `packages/protocol/openapi.json`、运行时文档常量和 SDK route types；CI 的 `pnpm check:api` 会阻止手改或漏生成。`packages/sdk` 提供可编译/打包的 ESM TypeScript SDK、`openapi-fetch` 类型化客户端、`startTurnStream`、`subscribeSessionEvents` 和增量 SSE 解析器；`pnpm check:sdk` 从实际发布包入口验证消费者路径。

## 目录

```
apps/agent-runner      Hono HTTP + SSE；鉴权；幂等；路由 → SessionHost
apps/agent-router      无状态路由；owner 目录、一致性哈希、SSE 透传与安全重路由
packages/protocol      资源 / 事件 / 错误 schema（zod）
packages/sdk           从 OpenAPI 生成的 TypeScript 路由类型、类型化客户端与 SSE 流式辅助函数
packages/store         SessionStore / LeaseStore / EventBus / BlobStore 接口；ownership manifest 与 Blob delete outbox；memory、MySQL（fenced commit）、Redis（Lua 租约、Streams 热重放）实现；migrations/
packages/core          AgentEngine 接口 + PiEngine（pi-agent-core 适配）；SessionHost（租约续期、write-ahead、审批门、安全阀、Blob 绑定/水合、崩溃修复、事件序列化）；上下文装配；内置工具与 Blob cleanup worker
packages/providers     BYOK provider 配置 → pi Model；密钥加密；国内厂商 preset
packages/testkit       假厂商与跨包测试夹具
deploy/local           本机 redis / mysql 启停脚本
scripts/               本地服务生命周期、验收、验证与维护入口
spikes/pi-embed        pi 嵌入验证（保留作回归参考）
docs/                  调研、设计
```

## 关键不变量（测试覆盖）

- 同一 session 同时只有一个 writer：Redis 租约 + 单调 fence，MySQL 每次写入校验 `fence_token`，旧 owner 的写入被拒绝（`FenceError`）。
- 新 owner 在读取 takeover/orphan 快照前先用纯 `fenceClaim` 推进 MySQL fence；该批次不能夹带业务写，active/archived 行也不会留下 Redis 与数据库 fence 的 hand-off 窗口。
- session 行与首条 `session/created(seq=1)` 由 store 原子创建；序列化或数据库事件写入失败不会留下孤立 session、首事件空洞或部分游标。
- archive/unarchive 与生命周期事件、授权清理和异常审批结算原子提交；archived session 可读但拒绝 turn/steer/compact/approval/dynamic-result 写入。
- DELETE 经同一队列、lease 与 fence 原子提交 `session/deleted`、单调 deletion generation、tombstone marker 和两条 durable cleanup intent；普通资源随即 404。runner 内置 dispatcher 只领取 `session.tombstoned`，以 claim lease 和有上限的指数退避按 at-least-once 语义重投，短暂存储/总线故障默认不会因次数耗尽而永久停投；只有确定损坏的 envelope/event identity 才隔离到 dead-letter，消费者以 event `seq` 去重。`session.purge` 在策略确认前不可领取且不执行物理删除。
- 持久化事件 per-session `seq` 严格连续；delta 事件只走总线不落库不占 seq。
- 工具调用先落库（write-ahead）再执行；崩溃后按是否 `startedAtMs` 生成 `TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN` 交给模型。
- 安全阀 `maxSteps / maxToolCalls / maxWallClockMs / maxCostCNY` 取 min，只能收紧。
- 审批是持久化资源，有 `expiresAt`；`cancel` 记为 interrupted 而不是 declined。
- 跨租户访问返回 404，与不存在不可区分；带 `X-User-Id` 时同租户内也不能读别人的会话。
- user erasure gate 与 request/audit 在 Memory/MySQL 中原子提交；一旦 gate 线性化，该 subject 的 session/turn/item/approval/usage/receipt/Blob 普通读取隐藏，对应 durable 写入被拒绝；tenant-scoped agents/provider/auth/api-key 不受此 user gate 影响。同一个 idempotency key 按 tenant + subject 隔离；POST 需要 deployment gate、全部 configured targets 均健康且声明 capability，以及 selected target capability，不能忽略暂时不可达的旧 writer；status GET 只跳过 router writer gate，仍按当前 healthy fleet/selected target capability 规则 fail-closed。`gated` 尚不会主动撤销已建立的 SSE 或跨 runner 中断 active turn，必须等 erasure worker 完成 drain 后才能用于 production。
- 新 usage write 以 opaque `usage_id` 在同一事务双写 operational ledger 与不含 user/session/turn/step/raw JSON/精确请求时间的 billing fact；金额以 9 位小数规范字符串写入 `DECIMAL(24,9)`。session/turn/event/compaction 投影由 ledger 权威重建，MySQL 使用一致性快照内的 SQL 聚合；legacy `usage_id IS NULL + costCNY=0` 保守视为 unknown，而新版有 identity 的零价仍为 known-zero。legacy row 只有在 tombstone generation、owner、逐行事实和汇总校验和全部核对后才可显式匿名化，任何 ledger/session owner 不一致都会 fail-closed。普通聚合只有在全部组成记录都有价格时才返回完整 `costCNY`；任一未知价格都会保持缺失，已知零价仍为 `0`。启用 `maxCostCNY` 时，未定价的正常 step 会在落账后 fail-closed，不能继续执行其工具或下一模型 step。
- 审批授权是服务端状态，客户端 metadata 改不动；BYOK 的 `baseUrl` 必须解析到公网地址。
- 被抢占（fence 失效）或会话被删除时，turn 立即停止，不再调模型、不再执行工具。
- 同一条流式消息的 item 只分配一次 seq，`?afterSeq=` 增量拉取不会漏掉最终回答。
- Blob 客户端只看到 owner-scoped opaque `blobId`，看不到物理 locator；输入图片会校验声明 MIME 与文件签名，且所选模型必须声明 image input。从 `staging` 到 item 的 `ready` 绑定与业务 commit 原子提交，tenant/user/session 或 item 不匹配统一返回 404。达到阈值的合法工具输出卸载到 Blob 并由 `outputRef` 精确取回；不可序列化、超过持久化硬上限或 storage adapter 写入失败的结果都会在当前 step 与重放中变成同一稳定失败，且不会回显物理路径/locator。单次模型请求优先装配当前输入，历史按新到旧使用剩余水合预算；compaction 只有在 summary range 的全部外置工具事实都能物化时才推进 watermark。当前历史图片像素不会跨 compaction 保留，长期视觉记忆仍需后续视觉摘要/OCR。过期未绑定 staging 通过专用 outbox/claim lease 按 at-least-once 语义删除，key-scoped cancellation fence 阻止迟到上传复活对象；ready Blob 的 session erasure/物理 purge 尚未开启。
