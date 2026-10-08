# agent-service

分布式、多租户的 agent API 服务：无状态 `agent-router` + 有状态 `agent-runner`（类 `opencode serve`）。当前已实现会话/turn/SSE、BYOK、租约与 fencing、多节点路由和接管；MCP、skills、plugins/hooks 属于后续 M3。设计见 `docs/design/00-architecture.md`，调研见 `docs/research/`。

## 状态

- **M0 调研**：完成。
- **M1 单节点 runner MVP**：核心运行链路、OpenAPI 3.1、生成 TypeScript SDK、可逆 Archive v2、fenced tombstone 和可靠 terminal-event outbox dispatcher 已实现；ownership manifest/Blob 接线、erasure/export、legacy generation `0` 补偿及默认关闭的物理 purge 仍待按 `docs/design/04-data-lifecycle.md` 完成。
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
pnpm dev:runner
```

```bash
# 手动验收（十个环节：鉴权/流式/重放/幂等/上下文/安全阀/隔离/BYOK）
deploy/local/infra.sh start
STORE=mysql REDIS_URL=redis://127.0.0.1:6379 pnpm dev:runner   # 另一个终端
scripts/demo.sh

# 测试（四层，前三层不需要任何 API key）
pnpm test                                     # 单元 + 方言（假厂商）
AGENT_SERVICE_INTEGRATION=1 pnpm test         # + MySQL/Redis 一致性套件（两个后端跑同一套契约）
pnpm test:migrations                          # 固定 0007 → 0008、0008 → 0009 的真实 MySQL 升级夹具
pnpm test:cluster                             # + 多进程集群：2~3 runner + 1 router，SIGKILL 租约持有者
pnpm check:api                                # OpenAPI 与生成 SDK 漂移检查
pnpm check:sdk                                # 编译 SDK、原生 Node import，并校验 pnpm pack 内容
set -a; source .env; set +a; AGENT_SERVICE_REAL_E2E=1 pnpm vitest run packages/providers/test/e2e-qwen.test.ts
pnpm typecheck

# 生产构建验证（SDK 发布包 + 两个应用的单文件 bundle，原生 node 启动，不依赖 tsx）
pnpm build:check
docker build --build-arg APP=agent-runner -t agent-runner .
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
              一致性哈希兜底                  MySQL / Redis / 对象存储
```

`agent-router` 的核心职责是按 sessionId 找到持有租约的 runner、把 SSE 原样透传、收到 runner 的 `409 + X-Owner` 后安全重路由，并在发布窗口执行 protocol/capability gate。它没有业务状态，可随时重启。

tombstone 是现有 `2026-10-08` protocol family 内的 additive capability。router 只有在显式设置 `SESSION_TOMBSTONE_ENABLED=1` 且全部健康 runner 都声明 `tombstone` 时才开放 session DELETE；本地脚本默认启用。外部 DELETE 会被改写为带 `INTERNAL_ROUTER_TOKEN` 的版本化 runner-only POST，并要求新 runner 回 ACK；内部路径不进入 OpenAPI，客户端伪造的内部 header 会被剥离。`RUNNERS` 必须是实例稳定地址，runner 端口必须保持内网不可直连。staging/production 需先在 edge 暂停精确 session DELETE（或整体切换 router 池），再按“新 router（gate=0）→ 排空旧 router → 滚动新 runner → 核对 fleet capability → 激活 gate”的顺序升级；旧 router 本身没有该 gate。

## API 速览（`apps/agent-runner`）

鉴权两层：`Authorization: Bearer <service api key>`（→ tenant）+ `X-User-Id`（trusted caller）或 runner 验证的端用户 token。入站 token header 不能占用 service/user/framing/hop-by-hop 保留头；即使数据库中存在升级前的坏策略，admin service key 仍可通过 `/v1/tenant/auth` 修复。开发用 key 由 `BOOTSTRAP_API_KEY`（默认 `dev-key`）注入。

```bash
H=(-H "Authorization: Bearer dev-key" -H "X-User-Id: u_42" -H "Content-Type: application/json")
# agent 定义（版本化）
curl -s -X POST localhost:8787/v1/agents "${H[@]}" -d '{"name":"assistant","instructions":"你是一个简洁的助手。","model":{"provider":"dashscope","model":"qwen3.8-max"},"tools":["current_time","web_fetch"],"limits":{"maxSteps":6}}'
# session
curl -s -X POST localhost:8787/v1/sessions "${H[@]}" -d '{"agentId":"agt_..."}'
# turn（SSE；id: 为 seq，Last-Event-ID / ?after= 可续订；?exclude= 过滤事件）
curl -sN -X POST "localhost:8787/v1/sessions/sess_.../turns?exclude=usage/updated" "${H[@]}" -H "Idempotency-Key: k1" -d '{"input":[{"type":"text","text":"现在几点？"}]}'
# 非流式：{"stream":false} → 202 + turn；之后 GET .../events?after=<seq> 消费
# 幂等键按 tenant + user + session 隔离；同 key 异请求 → 409。stream 不参与请求 hash；重放命中时固定返回
# 200 application/json {turn} + Idempotency-Replayed: true，需要事件流时用 GET .../events?after=<seq> 续订。
# 其他：GET .../items | .../turns | POST .../turns/{id}/interrupt | steer | tool-results（动态工具回填）
#       GET/POST .../approvals/{id} {decision: accept|acceptForSession|decline|cancel}
#       GET/PUT/DELETE /v1/providers/{id}（BYOK，apiKey 只写不读，AES-GCM 落库）  GET /v1/models  GET /v1/tools
#       POST .../archive | .../unarchive | .../resume  DELETE /v1/sessions/{id}（fenced tombstone，不物理 purge）
#       GET /v1/capabilities  GET /openapi.json  GET /healthz /readyz
```

事件类型与资源 schema 在 `packages/protocol/src/`（zod，单一真相）。`pnpm generate:api` 由同一组 schema 确定性生成并提交 `packages/protocol/openapi.json`、运行时文档常量和 SDK route types；CI 的 `pnpm check:api` 会阻止手改或漏生成。`packages/sdk` 提供可编译/打包的 ESM TypeScript SDK、`openapi-fetch` 类型化客户端、`startTurnStream`、`subscribeSessionEvents` 和增量 SSE 解析器；`pnpm check:sdk` 从实际发布包入口验证消费者路径。

## 目录

```
apps/agent-runner      Hono HTTP + SSE；鉴权；幂等；路由 → SessionHost
apps/agent-router      无状态路由；owner 目录、一致性哈希、SSE 透传与安全重路由
packages/protocol      资源 / 事件 / 错误 schema（zod）
packages/sdk           从 OpenAPI 生成的 TypeScript 路由类型、类型化客户端与 SSE 流式辅助函数
packages/store         SessionStore / LeaseStore / EventBus / BlobStore 接口；memory、MySQL（fenced commit）、Redis（Lua 租约、Streams 热重放）实现；migrations/
packages/core          AgentEngine 接口 + PiEngine（pi-agent-core 适配）；SessionHost（租约续期、write-ahead、审批门、安全阀、崩溃修复、事件序列化）；上下文装配；内置工具
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
- 审批授权是服务端状态，客户端 metadata 改不动；BYOK 的 `baseUrl` 必须解析到公网地址。
- 被抢占（fence 失效）或会话被删除时，turn 立即停止，不再调模型、不再执行工具。
- 同一条流式消息的 item 只分配一次 seq，`?afterSeq=` 增量拉取不会漏掉最终回答。
