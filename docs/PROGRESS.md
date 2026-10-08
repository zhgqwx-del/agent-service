# 进度记录

> **当前快照（2026-10-08）**：M0 已完成；M1 核心运行范围、OpenAPI 3.1、生成 TypeScript SDK 与可逆 Archive v2 已完成，数据生命周期仍需 fenced tombstone、ownership manifest/outbox、erasure/export、Blob 接线和默认关闭的 purge；M2 的本地/CI 代码范围已完成并正式冻结；M3/M4 尚未正式开始。本文按时间追加，前文的“下一步”和测试数量都是当时快照；当前事实、验证结果和剩余事项请看最后一节。

## 2026-09-22

- M0 调研完成：`docs/research/01–07`，方案 `docs/design/00-architecture.md`（含 §14 缺口清单）。
- 决策按 §13 默认值执行；实验环境仅本机（Redis 源码编译到 `~/.local/bin`，MySQL 8.0.26 用户目录 datadir，脚本 `deploy/local/infra.sh`）。
- pi 嵌入 spike 七项全部通过（`spikes/pi-embed/README.md`）。
- M1 完成：protocol / store / core / providers / agent-runner 五个包，44 个测试全绿（35 单元 + 8 MySQL/Redis 一致性 + 1 真实 Qwen 端到端）。
- 已用 HTTP 实测：Qwen 工具调用流式回复、`?after=` 重放、Idempotency-Key 重放、第二轮带历史、两个 runner 的租约冲突（409 + ownerAddr）与 hold 到期后接管（fence 3→4，历史完整）。

### 下一步（M2）
1. `apps/agent-router`：鉴权、幂等预留、`owner:{sid}` 目录查询、SSE 反向代理、409 重路由一次。
2. 3 runner + 1 router 的 kill 测试脚本（turn 中 kill 租约持有者 → 接管、无空洞、`?after=` 补齐）。
3. 优雅下线：SIGTERM drain 已实现，需要 step 边界 checkpoint 的验证。
4. OpenAPI 文档生成（`packages/protocol` → `/openapi.json`）与 SDK 包。

### 已知待办（M1 收尾）
- `web_fetch` 不跟随重定向（安全默认），需要文档说明。
- 队列策略 `busyPolicy=queue` 目前按 reject 处理（返回 session_busy）。
- 上下文压缩只有便宜级（工具输出裁剪），摘要级压缩与 `POST /compact` 未实现。
- 用量查询接口 `GET /v1/usage` 未实现（数据已入 `usage_ledger`）。

## 2026-09-26

四个角度的系统评审（并发正确性 / API 完备性 / 安全 / 测试策略）+ 自查，共 4 blocker、23 high、约 30 medium/low。详见 `docs/review/05-response-and-plan.md`。

**本轮已修 29 项**，其中数据损坏级 4 个：同 runner 并发 startTurn 创建双 turn（租约拦不住，同 owner 同 fence）、FenceError 不中止 turn（旧 owner 继续执行工具与计费）、drain 被待审批拖住整个 approvalTtl（滚动发布批量产生孤儿 turn）、动态工具结果跨会话串号（跨租户注入）。另有流式错误返回 200、用户级隔离缺失、审批可被客户端 metadata 绕过、BYOK SSRF、item seq 不一致导致最终回答被 `afterSeq` 过滤掉等。

**状态**：87 测试全绿（含两个存储后端的一致性套件与真实 Qwen 端到端）；覆盖率 69.0% → 82.6% 语句 / 69.3% 分支 / 87.0% 行；`scripts/demo.sh` 在 MySQL+Redis+真实模型下十环节通过，并新增 5 条负向安全用例。

**新增**：`scripts/demo.sh`（一条命令手动验收）、`packages/core/test/tools.test.ts`（SSRF 20 个绕过用例 + 动态工具桥）、迁移 `0002_auto_approved.sql`、`SessionGoneError`。

**下一步**：按 `05-response-and-plan.md` 第五节 —— ①测试地基 ②假厂商+方言测试 ③agent-router ④多进程集群 E2E ⑤CI ⑥压缩 ⑦M1 收尾。

**待拍板**：`X-User-Id` 信任模型（是否加端用户 JWT 分支）、是否提供第二家厂商 key 做方言实测、审批流产品形态、压缩策略。

## 2026-09-26（下午，M2 主体）

按 `docs/review/05-response-and-plan.md` 第五节推进，**115 个测试全绿**（111 单元/集成 + 4 多进程集群）。

1. **`packages/testkit` 假厂商**：真 HTTP 服务器，复刻国内厂商方言（`reasoning_content`、三种缓存字段拼法、`tool_calls.arguments` 分片、`: keep-alive` 注释行、`finish_reason: length`、429/Retry-After、流中途断链）。
2. **12 条方言测试**（`packages/providers/test/dialect.test.ts`）：驱动真实 `PiEngine` + provider 层，CI 无需任何 key。`PiEngine` 从 0% 覆盖变为有测试。验证了分片参数重组、reasoning 与正文分离、三家缓存字段、成本计算、qwen thinking 开关只对 qwen 下发、`max_tokens` 字段名、429 与断链的优雅失败、BYOK key 不进 payload。
3. **八条生产坑的回归测试**（`packages/core/test/history.test.ts`，12 条）：前缀字节稳定（`stableStringify`/工具指纹/epoch 只在模型可见内容变化时变）、崩溃三态、压缩切点配对、投影不变量。期间发现并修复：连续纯文本 step 会产出相邻 assistant 消息（部分厂商拒绝该序列），投影层改为合并。
4. **`apps/agent-router`**：`RunnerRegistry`（Redis 所有权目录 + 一致性哈希 64 虚节点 + `/readyz` 健康轮询）、SSE 原样透传、`409 + X-Owner` 重路由一次、`/_router/targets` 运维视图。
5. **多进程集群测试**（`test/cluster/`，M2 验收标准）：2~3 个真实 runner 进程 + 1 router 共享 MySQL/Redis。4 条覆盖路由一致性与 409 重路由、**SIGKILL 租约持有者后的接管**（fence 推进、孤儿 turn 被标记 interrupted、事件 seq 无空洞、`?after=` 补齐）、陈旧 owner 被 fence 后无法写入、SIGTERM drain 让进行中的 turn 正常完成。期间发现 harness 自身的 bug：`kill` 杀的是 tsx 包装进程，真服务还活着 8 秒后把 turn 正常跑完 —— 会让接管测试变成空测，已改为 `node --import tsx` + 进程组信号。
6. **生产构建路径**（此前的上云阻塞项）：esbuild 打成 420 KB 单文件，只内联 `@agent-service/*`，第三方留外部；迁移脚本随产物拷贝且路径三处兜底。实测原生 `node` 启动 + 对空库自动迁移 + API 可用 + SIGTERM drain。新增 `Dockerfile`（两阶段）与 `deploy/local/compose.yaml`。
7. **CI**（`.github/workflows/ci.yml`）：mysql + redis service、typecheck、单元/集成（含覆盖率）、多进程集群、以及独立的 build job 跑「构建产物能启动」。

**下一步**：摘要级压缩 + 截断方向修正；M1 收尾（`/v1/usage`、`/openapi.json` + SDK、声明未实现的事件与错误码清理、数据生命周期、结构化日志）。

## 2026-09-26（身份鉴权定稿）

回答"`X-User-Id` 信任模型该怎么做"，实现并测试了两种模式，文档见 `docs/design/01-identity-and-auth.md`。

**核心判断**：用户提出的"runner 拿到登录态、router 转发身份信息给 runner 去鉴权"方向正确，但落地时必须区分**验证**与**接收**。router 转发的字段走内网，与 `X-User-Id` 同样可伪造（谁能直连 runner 谁就能伪造），所以 runner 必须是权威 —— 要么自己验证端用户 token，要么明确接受"调用方可信"的前提。router 保持不参与鉴权，与它无状态的定位一致。若将来需要集中验证，正确形态是 router 签发 runner 可验签的短时效内部断言，而非明文转发。

**实现**：每租户策略（`tenants.auth_policy` + 加密的 `auth_secret`，迁移 `0003`）。
- `trusted_caller`（默认）：service key + `X-User-Id`；允许代任意本租户用户操作；硬性前提是 key 只存在于租户自己的后端。
- `end_user_token`：runner 验证端用户 token 并从中取 `userId`；`X-User-Id` 若同时出现必须一致（否则 403），单独使用直接 401（拒绝静默降级）；不允许代他人建会话。三种验证器：JWT+JWKS（推荐，本服务零密钥）、JWT+HS256（密钥走 BYOK 同一套信封加密）、introspection（正向缓存 60s，上游不可达时 fail closed）。算法在配置里固定以杜绝 alg 混淆。
- `GET/PUT /v1/tenant/auth` 管理策略，写入后本 runner 立即生效、其他 runner 在缓存 TTL（10s）内收敛。

**顺带修掉**：策略缓存原本 30s 且无法失效，意味着收紧策略会有 30s 窗口 —— 改为可显式失效的 `TenantPolicyCache`。

**另一个发现**：`tsconfig` 只检查 `src`，测试文件从未被类型检查，`apps/agent-runner/test/http.test.ts` 已与 `createApp` 的签名脱节（缺三个必填依赖）却仍"通过"。新增 `tsconfig.typecheck.json` 覆盖 src + test + scripts，`pnpm typecheck` 现在两者都跑。

**状态**：127 测试全绿（123 单元/集成 + 4 集群），构建产物 459 KB。

## 2026-09-26（晚，阻断项收口与本地交付）

### 里程碑判定

- **M0 已完成**。
- **M1 核心运行范围已完成**：单节点 runner、存储、SSE、幂等、审批、压缩、usage、鉴权和 BYOK 均可用；若按最初架构文档的完整定义，OpenAPI/生成 SDK 与完整数据生命周期仍未完成，因此不把 M1 宣称为 100%。
- **M2 核心范围已完成并在本地/CI 验证**：router、owner 目录、租约续期与 fencing、接管、drain、构建产物和容器 CI 均已有自动门禁。预发/生产部署尚未开始，需等待实际基础设施参数。

### 本轮修复

1. 身份和数据隔离：逻辑 ID 改为大小写敏感；幂等作用域收紧到 tenant + user + session；查询 replay 前先校验会话归属；迁移增加数据库级 advisory lock 和可重入 DDL。
2. 并发正确性：租约从 acquire 后立即续期，覆盖 provider/history/summary preflight；turn 与显式 compact 按 session 串行；租约丢失会中止执行；SSE 检测持久事件 seq 缺口并从 store 补齐。
3. Router：只重试真正实现幂等的 turn POST；`MAX_ATTEMPTS` 明确为总发送次数；header timeout 会取消底层 fetch；router/runner 请求体上限统一为 1 MB。
4. 构建交付：修复损坏的 lockfile；Docker runtime 不再联网解析依赖；CI 构建并启动 runner/router 镜像；生产 runner identity/address 规则收紧。
5. 运维测试：新增 `scripts/local-service.sh` 的 start/stop/restart/status/logs/smoke/acceptance/verify/verify-real/cleanup-idempotency；危险集群测试只允许测试库名和非零 Redis DB；真实模型测试改为显式开关；CI/本地 verify 增加凭据扫描且不打印命中值。
6. Linux CI 回归：审批超时以 timer 触发作为权威信号，且到期后的迟到 `accept` 强制按拒绝处理，避免毫秒时钟竞态导致工具误执行；已补充回归测试。
7. 事务一致性：移除会在崩溃后悬挂 24 小时的幂等 pending reservation，completed receipt（含请求语义 hash）与 turn-start 同事务；step usage、聚合投影与 `usage/updated` 同事务且以 `(session_id, turn_id, step)` 唯一；compaction summary、两条事件、watermark 和 usage 合并为单次 fenced commit，并用 `expectedLastSeq` CAS 丢弃过期摘要；turn `seqEnd` 也改为随关闭事件在同一事务内赋值。
8. Turn 生命周期：用 `reserved/running/settling/finishing/finished` 门控 steer；begin/run 间的输入先落库后排队，step 收口等待已接纳 steer，完成窗口不再接受会被静默丢弃的输入；未调用 `run()` 的预留 turn 会在超时、interrupt、drain 时结算并释放租约。
9. 存储回滚与升级语义：Memory store 与 MySQL 一样先完整 staging 写集再修改持久状态，未知 JSON 值序列化失败不会留下半条事件、已推进 fence 或部分 usage/receipt；迁移保留滚动升级期间旧 runner 可能仍在使用的 legacy pending receipt，新版命中它时返回 `idempotency_conflict`，不会接管或替换。必须先排空并下线全部旧 runner，再清理已过期 pending；新增分批幂等 TTL 清理脚本，默认只删除安全的 completed receipt。
10. API/计费投影：turn metadata 现在随 turn 持久化；压缩模型用量与 ledger、session usage、水位线在同一事务更新；busy steer 复用新 turn 的输入能力校验，不再静默吞掉未支持的 input。

### 实测结果

- `scripts/local-service.sh verify`：类型检查通过；MySQL/Redis 集成套件 **214 passed / 1 skipped**；覆盖率 **79.14% statements / 69.90% branches / 75.55% functions / 83.48% lines**，全部高于门槛；集群套件 **8/8 passed**。
- `pnpm run build:check`：runner/router bundle 均在原生 Node 下启动，readiness 和 router forwarding 通过。
- 显式真实模型 E2E：**1/1 passed**。
- `scripts/local-service.sh acceptance`：MySQL + Redis + router + runner + 真实模型的十阶段验收全部通过，包括 SSE、重放、幂等、上下文、安全阀、隔离、请求体限制与 BYOK。

### 仍未达到“可直接生产上线”的部分

- session 创建与首条 `session/created` 事件仍是两次写入，后续应继续收紧这一较小的崩溃窗口。
- `0008` 已通过 fresh-schema 与真实 MySQL 行为测试，但还应补一套从预置 `0007` 历史数据升级的独立夹具，自动覆盖相同 usage 去重、冲突 usage 阻断升级及 legacy pending 保留。
- Redis fence counter 的灾难恢复、依赖探测型 readiness、结构化日志/指标/告警、限流/配额仍需完成。
- BYOK/工具 URL 的 DNS rebinding 与重定向链需要更强的运行时 SSRF 防护。
- OpenAPI/SDK、数据保留与删除任务、M3（MCP/skills/plugins/hooks）和 M4 的其余生产化工作仍待后续里程碑。
- Kubernetes/云部署资产将在 staging/production 的 namespace、镜像仓库、域名/TLS、Secret/KMS、MySQL/Redis 拓扑和资源配额明确后生成。

## 2026-09-26（夜，M2 正式冻结）

### 冻结结论

M2 的**本地/CI 代码范围正式冻结**，本轮没有提前进入 M3。该结论表示 router、多节点所有权、租约/fence、接管、drain、session 初始持久化和历史迁移门禁已经形成可重复基线；它不表示 M1 已 100% 完成，也不表示尚无真实资源的 staging/production 已可部署。

### 正确性收口

1. `SessionStore.createSession` 现在强制在一个原子操作中创建 session 与 `session/created(seq=1)`：MemoryStore 先完整 staging 再同时发布两个 Map 状态；MySQLStore 在同一 InnoDB 事务中写 session 与事件。序列化失败、事件 INSERT 失败或同 ID 并发冲突都不会留下孤立 session、事件空洞或部分 `lastSeq/fenceToken`。
2. 双后端契约新增成功、不可序列化 metadata、非 pristine 初值以及跨 tenant/user 的同 ID 并发测试；真实 MySQL 另用 trigger 注入第二条 SQL 失败，证明第一条 session INSERT 会回滚。
3. `parentSessionId` 创建校验按实际目标用户执行；缺失、跨租户、跨用户父会话统一返回 404，trusted caller 为同一目标用户代建仍可用。
4. 新增固定的 0007 历史 schema 夹具和独立 `pnpm test:migrations`。它使用真实 MySQL 覆盖：完全等价 usage 合并；usage 内容或 tenant/user 归属冲突时迁移阻断且账目全保留；过期 legacy pending receipt 原样保留；部分 DDL 已提交后的重复启动仍安全阻断；人工审计移除冲突后可继续完成 0008。
5. `0008` 只把 tenant、user、session、turn、step、provider、model、usage 和创建时间全部相同的账视为可合并重复项；归属不同不能再被静默删除。独立迁移套件已接入本地 `verify` 和 GitHub Actions，生产镜像启动检查也要求最新的 `0008_atomic_turn_writes.sql` 已应用。

### 本地验证

- `pnpm run check:secrets`：通过，扫描 152 个文件。
- `pnpm typecheck`：通过。
- 原子创建、真实数据库回滚、并发及相关 host/store 定向套件：**85/85 passed**。
- `scripts/local-service.sh verify`：主套件 **224 passed / 1 skipped**；覆盖率 **79.39% statements / 70.26% branches / 75.46% functions / 83.67% lines**；独立 0007→0008 迁移 **2/2 passed**；cluster **8/8 passed**；runner/router 构建产物启动、readiness 与转发检查通过。
- 本轮不涉及 provider/模型执行路径，因此没有重复产生费用运行 `verify-real` 或 acceptance；最近真实模型 **1/1** 与十阶段 acceptance 通过的基线仍有效，但不冒充本轮重跑结果。

### 冻结后的边界与顺序

- 混合版本发布时，旧 runner 仍带有旧的两步 session 创建路径；必须以旧实例全部排空为新原子不变量的生效边界。session 创建 POST 本身也尚无请求幂等键，响应丢失后的客户端重试可能创建两个各自完整的 session，但不会产生半 session。
- 持久事件仍采用“数据库先提交、EventBus 后发布”；总线失败依靠 durable replay 恢复，不与 MySQL 做分布式事务。
- M1 仍需 OpenAPI/生成 SDK、完整保留/删除/导出生命周期及 Blob/大输出接线；这些是冻结后的最高优先级。
- 上预发前还要把 runner 启动时自动迁移拆成独立 migration Job + 运行时 schema 检查，并补真实 KMS/Secret、对象存储、IdP、依赖型 readiness、备份恢复及日志/指标/告警。
- M3 的 MCP/skills/hooks 和 M4 的配额限流、熔断、可观测性、容量压测、Redis 分片/灾备与更强 SSRF 防护仍未开始或未闭环；云部署参数继续等待真实资源，不能编造。

## 2026-09-26（M1 OpenAPI / SDK 收口）

### 已完成

1. 由现有 Zod protocol/HTTP schemas 确定性生成 OpenAPI 3.1：只包含当前真实实现的 **28 paths / 36 operations**，每个 operationId 唯一；M3 的 MCP/skills/plugins/hooks 及 versions/fork/item output 等未实现接口没有提前进入契约。
2. runner 与 router 都在无需认证的 `/openapi.json` 提供同一份 committed 文档。router 直接提供本地不可变契约，不依赖某个 runner 的健康状态或版本，避免滚动升级期间 API discovery 漂移。
3. 新增可发布的 `packages/sdk`：`openapi-typescript` 生成 route/request/response types，`openapi-fetch` 提供类型化 REST client；另有 `startTurnStream`、`subscribeSessionEvents` 和增量 SSE parser，覆盖 UTF-8/chunk/CRLF、多行 data、heartbeat、id/retry、JSON 诊断、abort、截断 EOF 丢弃与消费者提前退出时的上游取消。构建产出 JavaScript 与声明文件，CI 会从真实 `pnpm pack` 压缩包解出隔离 consumer，以包名做原生 Node import 和 TypeScript 编译，避免 workspace 源码掩盖错误 exports 或漏依赖。
4. `pnpm check:api` 会在内存中重新生成并精确比较 OpenAPI JSON、运行时 TypeScript 常量和 SDK schema；本地 `verify` 与 GitHub Actions 都把漂移当作失败。独立路由测试还会双向比较 Hono 已注册的 36 条 route/method，阻止漏文档和幽灵接口。
5. HTTP handler 改为复用同一组 query/body/header/path schemas。顺带修复 `includeArchived=false` 曾被 `z.coerce.boolean()` 按 truthiness 解析为 `true` 的错误；无效 version/event cursor、provider/key path 和空白 idempotency key 现在稳定返回 400；`X-User-Id` 只有一份共享 grammar，`exclude` 的枚举约束进入 OpenAPI/SDK。当前 HTTP 请求只接受 text input，并要求 agent 的 MCP/skills 预留数组为空，不提前承诺 M3 能力；响应仍兼容旧版本曾持久化的非空预留字段。
6. SSE heartbeat 补齐协议要求的 `sessionId`；协议版本同步提升。公开契约变更采用 runner-first，旧 runner 全量 drain 后才升级提供静态契约的 router；router probe 同时校验 readiness 与 protocol capability，旧/畸形 runner 不进入 ring 或 owner 重路由，没有兼容 runner 时 readiness/capabilities 返回 503。runner/router 原生 bundle 启动门禁和容器 CI 都会访问 `/openapi.json`，并用一个必须穿过 wildcard proxy 的鉴权请求验证真实转发。
7. BlobStore 本地基础加固：Memory/Fs 共用严格、仅小写的 opaque key，避免 APFS/NTFS 大小写折叠造成跨 key 覆盖；新写入返回版本化 ref，文件数据与 content type 封入带长度和覆盖 header/正文 SHA-256 的同一 envelope，临时文件写完后以一次 rename 发布，失败保留旧完整版本，并发读不会混合两个版本，magic/header/正文截断或篡改会失败；目录/文件收紧到 0700/0600，安全 key 范围内的旧 raw + sidecar 可过渡读取/删除。路径逃逸、静态 symlink、错误 scheme、I/O 错误及 Buffer 防御性复制均有测试。filesystem root 必须由服务独占，不能把 Node 缺少可移植 `openat/O_NOFOLLOW` 的竞态边界描述为已消除；rename 也不承诺断电持久性。它仍未接入 item/附件，不能视为大输出生命周期已完成。
8. 新增 `docs/design/04-data-lifecycle.md`，明确 archive/delete 必须经过 lease/fence、tombstone/outbox、usage 内容与财务事实分层、父子 session、erasure、Blob ownership 和 expand→activate→contract 顺序。保留期限、legal hold、级联和财务字段未确认前，物理 purge 默认关闭。
9. 租户入站端用户 token header 现在使用共享 HTTP field-name schema，并大小写无关地拒绝 `Authorization`、`X-User-Id`、framing 与 hop-by-hop 保留头；introspection 的出站 `Authorization` 仍兼容。`/v1/tenant/auth` 在 service key 验证后跳过旧 policy 的端用户 token 解析、继续由 handler 强制 admin scope，因此升级前已经持久化的冲突/坏配置也能读取并修复，runtime-only key 仍不能扩权。

### 本轮验证

- OpenAPI/SDK/Blob/Memory/router/runner/protocol/auth 聚焦套件：**117/117 passed**；Blob 并发压力用例另经连续重复运行通过。
- `pnpm check:sdk`：真实 `pnpm pack` 的 **18 files** 在隔离 consumer 中通过包名 runtime import 与 TypeScript 编译。
- `scripts/local-service.sh verify`：secret scan **172 files**；生成漂移检查与 TypeScript 全量检查通过；主套件 **265 passed / 1 skipped**；覆盖率 **82.45% statements / 72.35% branches / 80.06% functions / 86.87% lines**；独立 0007→0008 迁移 **2/2 passed**；cluster **8/8 passed**；SDK 发布包以及 runner/router 原生 bundle 启动、readiness、转发与 OpenAPI 深比较通过。
- 本轮没有改变 provider/模型执行路径，因此未重复运行收费的 `verify-real` 或 acceptance；最近真实模型 **1/1** 和十阶段 acceptance 基线不冒充本轮结果。

### 当前边界与下一步

- M2 冻结结论不变，本轮没有开始 M3。
- M1 的 OpenAPI/生成 SDK 缺口已关闭；尚不能正式宣告 M1 全部完成，因为数据生命周期仍需要确认 session grace/retention、usage 财务保留、legal hold、parent-child 级联、erasure/export SLA 和备份期限。
- 确认上述策略后，按 `04-data-lifecycle.md` 先做可逆 archive/unarchive 与 fenced tombstone，再做 manifest/outbox、erasure gate 和默认关闭的 purge worker；不要先接 Blob 或启用物理删除。

## 2026-10-08（M1 数据生命周期：Archive v2）

### 已完成

1. `POST /v1/sessions/{id}/archive` 已从 HTTP 直接 store patch 收紧到 `SessionHost`；新增幂等 `POST /v1/sessions/{id}/unarchive`。两者与 turn start/compact 共用 per-session 队列、Redis lease、续租 guard 和 MySQL fence；active turn 返回 `409 session_busy`，读取与 resume 保持可用。
2. Memory/MySQL 的同一原子 commit 会提交 archive marker、`session/archived` / `session/unarchived` 事件、连续 seq、`autoApprovedTools` 清理、pending approval 过期和对应 approval item/event。普通 runtime commit 对 archived session 返回 `SessionArchivedError`；tenant/user 不匹配和 tombstoned session 仍与不存在一致。
3. 新 owner 获取 Redis lease 后先执行不能夹带业务写的纯 `fenceClaim`，只推进数据库 `fenceToken`，不改变 `updatedAtMs`、`lastSeq` 或业务投影；随后才重读 takeover/orphan 快照。turn start、compact 和 archive 三条路径都使用该顺序，关闭旧 owner 在 Redis→MySQL 交接窗口继续写 item/usage 的竞态。
4. 历史 `archived + active` 行会先完整 repair：真实 in-progress turn、pending approval、approvalRequest item、授权、turn/session 投影与 resolution/terminal events 原子结算，再执行 archive/unarchive。恢复历史 archived session 不会带回旧的 `acceptForSession` 授权或悬挂审批。
5. MemoryStore 在任何 mutation 前 staging lifecycle；不可克隆 approval/lifecycle 不会留下部分事件、marker、lastSeq 或 fence。真实 MySQL 另用 trigger 在事务最后的 session UPDATE 注入失败，证明此前写入的 events/approval/item 和 session 状态全部回滚。
6. 新增跨 runner 集群场景：强制旧 owner 丢失 lease，由另一 runner 以更高 fence 修复 orphan turn 并 archive；旧 owner 后续写入停止，archived 禁写且事件 seq 无空洞。stale lifecycle fence 映射为带 owner 的 `409 session_lease_conflict`，router 可安全重路由。
7. 协议版本、`sessionLifecycle` capability、错误码、事件 union、OpenAPI 3.1、生成 SDK 和 route parity 已同步。新增 `docs/operations/development-and-ci-guide.md`，长期说明本地启动/手动体验、源码进程与 bundle/OCI image 的区别、CI 构建物以及 local→staging→production promotion。

### 本轮验证

- `pnpm check:secrets`：通过，扫描 **174 files**。
- `pnpm check:api`、`pnpm typecheck`、`git diff --check`：通过。
- Archive/host/store/HTTP/OpenAPI 定向测试、真实 MySQL lifecycle rollback 与跨 runner takeover 均通过。
- `scripts/local-service.sh verify`：主套件 **281 passed / 1 skipped**；覆盖率 **83.21% statements / 73.68% branches / 81.60% functions / 87.36% lines**；独立 0007→0008 历史迁移 **2/2 passed**；cluster **10/10 passed**；SDK 发布包和 runner/router 原生 bundle 的 readiness、转发与 OpenAPI 深比较通过。
- 本轮没有修改 provider/真实模型执行路径，因此未重复运行收费的 `verify-real` 或 acceptance；最近真实模型 **1/1** 与十阶段 acceptance 仍只是历史基线，不冒充本轮结果。

### 当前边界与下一步

- M2 冻结结论不变，本轮没有开始 M3。Archive v2 已完成，但 M1 数据生命周期仍未闭环。
- 当前最高优先级是把 `DELETE` 从 HTTP 直写收紧为同队列/lease/fence 的 tombstone，增加默认 `purge_after_ms = NULL`、单调 generation、删除事件和 outbox；在保留期、legal hold、级联与财务策略未确认前，物理 purge 继续关闭。
- 随后完成 Blob ownership manifest/业务接线、outbox worker、erasure gate/export 和 usage 匿名化/核对路径；这些完成后再正式进入 M3 threat model、MCP、skills 与 hooks。
- 新 protocol/capability 和 archived 写保护要求 runner-first 发布并排空全部旧 runner，再升级提供静态 OpenAPI 的 router；不得在 mixed fleet 中提前激活新语义。
