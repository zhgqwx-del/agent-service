# 进度记录

> **当前快照（2026-10-10）**：M0 已完成；M1 核心运行范围、OpenAPI/SDK、Archive/tombstone/outbox/Blob lifecycle、usage 财务分层、durable user-erasure、legacy补偿、canonical policy/multi legal hold、非破坏性purge authority、异步user-export artifact/download/TTL，以及tenant-erasure T1/T2/T3a/T3b、非破坏性T3c/T3d、T3e本地受限执行/physical ACK、T3f本地数据库投影清理与T3g session-scoped Redis状态清理切片均已完成。`0021` T3c封存可信DB-time owner清单，`0022` T3d固定33域plan与显式blocker；`0023` T3e完成local usage/Blob/export动作与physical ACK；`0024` T3f清理固定11个本地数据库投影并写永久session grave；`0025` T3g以真实Redis Lua清理session lease/owner、fence与stream并安装防复活marker；`0026`增加default-dormant versioned credential lifecycle inventory；`0027`再增加default-dormant、write-once Blob storage control，并接入共享S3-compatible/MinIO adapter、同key `ASBLOB02` data/tombstone envelope、条件create/CAS、启动探测、跨runner namespace capability和真实MinIO测试。generation 1 activation会原子核对全部live manifest、未释放snapshot pin及所有未完成delete intent；激活后filesystem回退或namespace漂移均fail closed。以上能力不新增产品服务、进程或镜像，本地/CI MinIO只是基础设施。所有terminal receipt仍保持`allDomainsComplete=false`、`contentPurgeExecuted=false`；external provider/KMS实际adapter、backup与独立故障域restore ledger、logs/traces、existing-filesystem bytes受审计搬迁、managed对象存储/IAM真实环境验收、全域completion及generic user物理purge仍未闭环，公开status继续为`gated`、`dataPurgeExecution=false`，因此M1尚未冻结。M2本地/CI代码范围已完成并正式冻结；M3/M4尚未正式开始。本文按时间追加，前文的“下一步”和测试数量都是当时快照；当前事实、验证结果和剩余事项请看最后一节。

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

## 2026-10-08（M1 数据生命周期：fenced tombstone）

### 已完成

1. `DELETE /v1/sessions/{id}` 已从 HTTP 直写收紧到 `SessionHost`，与 turn/archive 共用 per-session 队列、Redis lease、续租 guard、纯 `fenceClaim` 和 MySQL fence。active local session 返回 `409 session_busy`；失去 lease 的 orphan active session 会先由新 owner 完整 repair，再进入删除事务；stale owner 返回可供 router 重路由的 owner-aware `409`。
2. Memory/MySQL 的同一原子 commit 会写入 tombstone marker、terminal `session/deleted`、连续事件 seq、单调 `deletion_generation`，以及 `session.tombstoned`、`session.purge` 两条 durable intent。前者立即可用并携带删除事件 seq；后者在策略未确认时保持 `available_at_ms = NULL`，`purge_after_ms = NULL`，不会触发物理清理。
3. tombstone 提交后，session、turn、item、approval、普通 usage 和 idempotency receipt 对普通 API 隐藏；普通 commit 拒绝继续写入。已建立的 SSE 可收到 terminal `session/deleted` 后关闭；同 owner 重试 DELETE 保持 `204` 且不增加 seq/generation/outbox，跨 tenant/user 与不存在一致返回 `404`。
4. parent 创建与 parent tombstone 都在数据库事务中锁定 parent 行；任何未 tombstone 的 child 都使 parent DELETE 返回 `409 session_has_children`。create/delete 并发不能形成指向已删除 parent 的 dangling child，child 删除不影响 parent。
5. 新增 `0009_session_tombstone_outbox.sql`：扩展 `purge_after_ms`、`deletion_generation`、parent lifecycle index 和 durable lifecycle outbox。独立 0008→0009 真实 MySQL 夹具证明 legacy deleted row 保持 generation `0`、新增列/表/索引正确且迁移可重入；`pnpm test:migrations` 现在同时覆盖 0007→0008 与 0008→0009。
6. 协议、capability、`session/deleted` schema、OpenAPI 3.1、生成 SDK 和 router DELETE 重试边界同步更新；只有精确的 session DELETE 可以在 transport failure 后重试，嵌套或无关 DELETE 不会被扩张为隐式重试。

### 本轮定向验证

- Memory store/host 相关套件：**30/30 passed**。
- 真实 MySQL/Redis lifecycle、事务回滚和隔离相关套件：**34/34 passed**。
- 独立真实 MySQL migration suites：**3/3 passed**（两段历史升级均实际执行）。
- 多进程 tombstone takeover 场景：**1/1 passed**。
- 本节只记录已经完成的定向结果；本轮完整 `scripts/local-service.sh verify` 尚未在此快照中宣称完成，也不沿用旧节的总测试数字冒充当前结果。

### 当前边界与下一步

- tombstone 的数据库事实和 durable intent 已原子落地，但 `session.tombstoned` dispatcher、claim lease/retry/dead-letter、Blob ownership manifest/业务接线、erasure gate/export 和物理 purge worker 仍未实现；不能把“已写 outbox”描述为 cleanup 已执行。
- `session.purge` 明确不可领取，物理 purge 继续默认关闭；保留期、legal hold、级联、usage 财务匿名化与备份恢复策略确认前不得开启。
- `0009` 会把历史 deleted row 保留为 `deletion_generation = 0`，不会伪造 outbox。后续必须设计可审计、幂等的 legacy 补偿路径，再允许这些记录参与 purge。
- 当前 capability 使用精确 protocol version。新旧 router/runner 不具备一般 mixed-fleet 兼容性；在实现兼容范围或 activation gate 前，protocol 变更只能在全量 drain 后做维护窗口协调切换，或整组 blue-green，不能宣称普通无停机滚动混部已解决。
- 下一切片先完成 durable outbox dispatcher 与领取/续租/重试/dead-letter，再建设 Blob ownership manifest 和 staging/ready/delete_pending 生命周期；随后实现 erasure gate/export、usage 对账匿名化和默认关闭的 purge，完成 M1 数据生命周期后才正式进入 M3。

## 2026-10-08（M1 数据生命周期：reliable tombstone outbox 与 activation gate）

### 已完成

1. 新增独立、最小权限的 `LifecycleOutboxStore`：Memory/MySQL 均实现 topic-scoped claim、claim lease 续租、完成和失败重排。MySQL 使用 `READ COMMITTED` + `FOR UPDATE SKIP LOCKED` 非阻塞领取，ack/retry 由 outbox id、claim token 和有效 lease 做 CAS；失败文本会脱敏、去控制字符并限长。短暂存储/总线故障以有上限退避无限重试，确定损坏的 envelope/event identity 会隔离到 dead-letter，且 poison row 不会持续饿死后续 intent。
2. 每个 runner 启动时会启动 `LifecycleOutboxDispatcher`，停止时等待当前 pass 收束。dispatcher 只领取 `session.tombstoned`，按 intent 中的 seq 重新读取 durable `session/deleted`，校验 session/generation 后发布到 event bus，再确认完成；它没有 session/content mutation 权限，也绝不领取 `session.purge`。
3. terminal event 投递语义明确为 at-least-once：publish 成功但完成确认丢失时，lease 到期后会再次发布相同 event `seq`。`SessionHost` 的 replay/live 边界用 seq 去重并在发现间隙时回读 durable event，因此不把总线重复解释为新业务事件。
4. tombstone 继续使用 protocol family `2026-10-08`，不为 additive event/capability 人为提升 exact version。router 缓存同一次健康探测取得的 capability；只有显式 `SESSION_TOMBSTONE_ENABLED=1` 且全部健康 runner 都声明 `tombstone` 时，才在 `/v1/capabilities` 暴露并接受精确 session DELETE，否则返回可重试 `503 draining`。本地脚本明确启用该 gate，router 独立运行默认关闭。
5. 外部精确 DELETE 在 gate/fleet 校验后改写为带内部 token 的版本化 runner-only POST，并要求新 runner 返回 ACK；router 拒绝外部访问内部路径并剥离客户端伪造 token。`RUNNERS` 必须展开为实例稳定地址，不能把会在不同版本 Pod 间随机选路的共享 LB 当成一个 target；即使误配，共享路径上的旧 runner 也只会 404，不能执行旧公开 DELETE 语义。
6. 安全发布顺序明确为：先在 edge 暂停精确 session DELETE 或整体切到新 router 池 → 新 router 以 gate `0` 运行 → 排空旧 router → 滚动新 runner → 核对 healthy fleet capability → 激活新 router gate。旧 router 本身没有 activation gate，不能在仍接收 DELETE 时仅靠逐实例滚动获得该安全性；runner 端口也必须保持内网不可直连，否则会绕过 router gate。未来真正不兼容的 protocol version 变更仍需维护窗口或整组 blue-green。
7. Redis event bus 会检查 MULTI 的每个子命令结果，重连后触发 durable catch-up；同频道 SUBSCRIBE/登记/UNSUBSCRIBE 串行化，回放失败、重复/重叠退订和 malformed live payload 不会留下 phantom listener 或使进程崩溃。新增 store/dispatcher/router/runner 定向用例覆盖并发领取、lease 回收与 stale ack、重试/dead-letter、总线暂时失败、lost acknowledgement 重复、poison intent、purge 隔离、显式 gate 和 mixed-capability fleet。

### 本轮验证

- `pnpm check:secrets`：通过，扫描 **181 files**；`pnpm check:api`、`pnpm check:sdk`、`pnpm typecheck` 与 `git diff --check` 通过。
- 真实 MySQL lifecycle outbox 独立套件 **10/10 passed**；最新 MySQL/Redis 集成文件 **39/39 passed**；独立历史迁移 **3/3 passed**，实际执行 0007→0008 的相同 usage 合并/冲突阻断/legacy pending 保留和 0008→0009 restart-safe 扩展。
- `scripts/local-service.sh verify`：主套件 **342 passed / 1 skipped**；覆盖率 **83.67% statements / 75.20% branches / 82.00% functions / 87.83% lines**；cluster **11/11 passed**；SDK 的 18-file 发布包和 runner/router 原生 bundle 的 readiness、转发与 OpenAPI 门禁通过。
- 本轮没有修改 provider/真实模型执行路径，因此未重复运行收费的 `verify-real` 或 acceptance；最近真实模型 **1/1** 与十阶段 acceptance 仅保留为历史基线，不冒充本轮结果。

### 当前边界与下一步

- dispatcher 解决的是 tombstone terminal event 的持久、可恢复投递，不是数据清理。`session.purge.available_at_ms` 仍为 `NULL`，物理 purge 没有 worker/capability，且未确认保留期、legal hold、财务匿名化和备份恢复策略前不得实现自动启用。
- dead-letter 目前只用于确定损坏的 intent，所有路径都有 durable marker；dispatcher 识别出的 event identity 损坏另有受控日志，但 claim 阶段识别出的 malformed envelope 不会主动产生日志。管理端查看/修复/重放、指标和告警仍需在后续 M4 可观测性工作中闭环。短暂 Redis/MySQL 故障会持续重试，但在这些运维能力完成前仍不能宣称无条件最终送达。
- `0009` 前的 deleted row 仍保留 `deletion_generation = 0` 且没有伪造 intent；启用任何 purge 前仍需可审计、幂等的 legacy 补偿。
- dispatcher 停机仍依赖底层 MySQL/Redis I/O 最终返回，尚无独立 deadline/abort；完整“断线期间提交 terminal event → 重连 durable catch-up → SSE 关闭”组合测试也可继续加深。这两项是后续 hardening，不改变本轮已验证的 durable outbox 语义。
- 下一切片建设 Blob ownership manifest、staging/ready/delete_pending 状态、item/附件接线和 Blob 专用 outbox/worker，再完成 erasure gate/export 与 usage 对账匿名化。M1 数据生命周期仍未闭环，本轮没有提前进入 M3。

## 2026-10-08（M1 数据生命周期：Blob ownership、业务接线与 orphan cleanup）

### 已完成

1. 新增 expand-only `0010_blob_ownership.sql`：case-sensitive `blob_objects` ownership manifest 与独立 `blob_delete_outbox`。Memory/MySQL 都实现 owner-scoped staging/upload、硬 TTL、与 item/event/session patch 同事务的 `staging → ready` 绑定、stale staging 调度、claim lease/续租/完成/重试 CAS；tenant/user/session/item/purpose 不匹配与不存在保持同一 404 语义，ready 对象不会被 orphan sweeper 选中。
2. filesystem adapter 使用跨平台小写 key、版本化单 envelope、校验和、create-only hard-link 原子发布、私有权限和 key-scoped cancellation fence；delete 先持久化 fence，再幂等删除临时/最终对象，迟到 writer 即使换 upload token 也不能在 outbox ACK 后复活同一 key。Memory adapter 具备等价进程内语义；损坏、旧安全格式、静态 symlink、并发 create/delete 和 caller Buffer 复制均有测试。
3. 新增 owner-scoped `POST /v1/sessions/{id}/blobs`、`GET /v1/sessions/{id}/blobs/{blobId}`、`GET /v1/sessions/{id}/items/{itemId}/output`，OpenAPI/SDK 共 **40 operations**，SDK 提供上传、二进制读取和外置工具输出读取 helper。输入图片只持久化 opaque id，绑定前核对 MIME/file signature，运行前核对 model image capability，模型只接收内存 data URL；公开响应和日志不暴露 backend/key/token。
4. 大工具输出达到阈值后以 `outputRef` 外置；current step 与 replay 使用同一 JSON-safe canonical payload。不可序列化、超过独立持久化硬上限或 Blob adapter 写入失败时，两条路径都会得到同一稳定错误；adapter 的路径、locator 或 credential-bearing message 不会进入模型或 durable item。writer gate 关闭、threshold 为 `0` 或未安装 Blob service 时，硬上限仍然生效。
5. 每次主模型请求先完整物化当前输入，再由历史和同一 active turn 的后续 image steer 共用剩余 `BLOB_MAX_HYDRATED_BYTES`；图片按完整 data URL（含 MIME/base64 前缀）的 UTF-8 字节精确计费。历史按新到旧有界水合；compaction 只有在 summary range 的全部外置工具事实都能物化时才推进 watermark，避免把 durable marker 当真实工具事实摘要。
6. runner 内置独立 Blob cleanup worker，与 terminal-event dispatcher 分权；短暂 backend/ack 故障无限重试，确定性 identity/adapter poison 才在上限后 dead-letter。关停顺序会先停止接入、完成 host drain 和两个 worker，再给 SSE/keep-alive 短暂 flush 窗口并关闭残留 transport；真实 SIGTERM cluster 用例证明 in-flight turn 正常完成且 lease 释放，不再因 `server.close()` 等待长连接而卡住。
7. router/runner 都使用 writer activation gate 和 fleet capability；本地 filesystem 只有显式 `BLOB_FILESYSTEM_SINGLE_RUNNER=1` 且恰好一个去重 runner 才开放。`NODE_ENV=production` 下 filesystem writer/cleanup 均 fail-closed；当前没有用各 VM/Pod 私有目录伪装共享对象存储。
8. 新增独立冻结的 0009 历史 MySQL 夹具，真实执行 `0009 → 0010`，覆盖第一张表 DDL auto-commit 后崩溃续迁，以及两表已存在但 migration marker 未写入的重启。CI 的 Blob MySQL 专项命令会自行强制 integration、解析 JSON report，并拒绝目标文件 missing/skipped/零用例假绿；广义套件也对同一文件做 execution proof。
9. `docs/operations/development-and-ci-guide.md` 持续作为学习与操作材料，现已覆盖本地启动/手动体验、router/runner 职责、源码 bundle 与 Linux OCI image 的区别、GitHub CI 构建/验证内容，以及 local → staging → production 使用同一 image digest 的 promotion 契约。

### 本轮验证

- `pnpm check:secrets`：通过，扫描 **196 files**；`pnpm check:api`、`pnpm typecheck`、`pnpm check:sdk` 与 `git diff --check` 通过，SDK 的真实 **18-file** package 在隔离 consumer 中完成 runtime import 和 TypeScript 编译。
- Memory/filesystem Blob adapter 与 lifecycle 定向套件 **37/37 passed**；真实 MySQL Blob lifecycle **8/8 passed**，execution proof 明确确认目标文件全部执行；相邻 lifecycle outbox **10/10 passed**。
- 固定历史 MySQL migration suites **5/5 passed**：实际执行 0007→0008 的相同 usage 合并、内容冲突阻断、legacy pending receipt 保留，0008→0009 安全扩展，以及 0009→0010 的两类中断续迁。
- `scripts/local-service.sh verify`：主套件 **429 passed / 1 skipped**；覆盖率 **84.29% statements / 76.74% branches / 84.79% functions / 89.01% lines**；cluster **11/11 passed**；SDK package 和 runner/router 原生 Node bundle 的启动、readiness、转发及 OpenAPI 深比较通过。
- 本轮没有修改 provider dialect 或真实厂商网络契约；工具结果与图片路径已由 fake engine/vendor 和确定性 Blob 故障注入覆盖，因此没有重复运行收费的 `verify-real` 或 acceptance。最近真实模型 **1/1** 与十阶段 acceptance 仍只是历史基线，不冒充本轮结果。

### 当前边界与下一步

- M2 本地/CI 冻结结论不变，本轮没有提前进入 M3。Blob ownership、业务接线和 staging orphan cleanup 已完成，但 M1 数据生命周期仍需 erasure/export、usage 对账匿名化、legacy `deletion_generation = 0` 补偿，以及默认关闭的 ready/session purge。
- filesystem 仍只承诺单 runner 本地行为：没有断电持久性、真实 Windows/多进程目录竞争或 NFS 语义保证；永久 cancellation marker 会累积少量 inode/metadata。Blob TTL/outbox lease 使用 runner wall clock，未来多 VM 需约束并监控时钟偏差或改用共享数据库时间。
- 当前 compaction 保护外置工具事实，但历史图片以文字占位参与 summary，像素不会跨 watermark 保留；要宣称多模态长期上下文无损，仍需视觉摘要/OCR 或等价策略。
- ready Blob/session 的物理删除仍未接线，共享 OSS/S3 adapter、IAM/KMS 和 production cleanup 仍等待真实云资源。下一切片先实现可审计的 erasure/export 与 usage 内容/财务事实分层，再建设 generation `0` 补偿及默认关闭的 purge；完成 M1 后才正式进入 M3。

## 2026-10-08（M1 数据生命周期：user erasure gate 与 usage 财务分层）

### 已完成

1. 新增 expand-only `0011_erasure_and_usage_separation.sql`：nullable、case-sensitive `usage_id`，最小化 `billing_usage_facts`、`usage_reconciliations`，以及 `subject_lifecycle`、`erasure_requests`、`erasure_audit_events`。migration 不回填 billing fact、不匿名化历史 operational usage、不推进 erasure 状态，也不激活任何物理 purge；legacy writer 在 mixed-version 窗口仍可写 `usage_id = NULL`。restart-safe session trigger 会为迁移后旧 writer 新建的 session 原子补 tenant/user lifecycle 行，migration marker 丢失后重放也不覆盖现有 gate/legal hold；trigger 不会让旧 writer 检查 gate，不能替代发布 drain。
2. Memory/MySQL 均实现 user subject durable gate。`requestUserErasure` 在一个原子操作中提交 `subject=deleting`、单调 generation、request=`gated` 和首条 `erasure/gated` audit；验证或 audit INSERT 失败会完整回滚。相同 key/主体重放幂等，同 key 跨 user/tenant 隔离。subject lifecycle 的 `updatedAtMs` 取现值与请求时间的最大值，跨 runner 轻微时钟倒退不会写出不可解码状态。gate 与 session create 并发只有“完整创建先提交后立即隐藏”或“创建被 gate 拒绝”两种结果，不会留下 gate 后仍可见的半 session。
3. 新增 admin-only、user-scoped `POST /v1/data-erasure-requests` 和 owner-scoped status GET，POST 强制 `Idempotency-Key`。writer gate `DATA_ERASURE_REQUESTS_ENABLED` 在 runner/router 默认都是 `0`；router 只有在显式 writer gate、`RUNNERS` 中全部 configured targets 都健康且声明 capability、selected target 仍支持时才接受 POST，暂时不可达的已配置旧 writer 不会被健康子集掩盖。status GET 不依赖 router writer gate，按当前 healthy fleet 与 selected target capability fail-closed；healthy mixed fleet 返回 `503`，不会随机落到旧 runner 返回误导性的 `404`。writer gate 开启期间，session/usage 等 user-scoped runtime 每次转发也会复核 selected target capability。两条 erasure 路由的成功、鉴权/owner 404 与 router 自产错误均强制 `Cache-Control: no-store` 和 `nosniff`，OpenAPI/SDK 同步声明。
4. subject gate 一旦线性化，新发起的普通 owner session/turn/item/usage/receipt/Blob 读取隐藏，session create、普通 runtime commit 与 Blob stage/mark 被拒绝；同 tenant 的其它 user 保持可用。公开 response 不含 actor key、idempotency material 或内部 audit payload。当前状态只到 `gated`，没有后台 worker推进后续状态；已建立 SSE 不会主动关闭，active provider/tool 尚不跨 runner abort/drain。
5. 新 usage write 在同一业务事务中生成 opaque `usage_id`，原子双写 operational ledger 与严格白名单 billing fact；billing 层不含 user/session/turn/step、精确请求/reconcile 时间、原始 usage JSON、prompt、item 或 idempotency key。billing identity/content 冲突会回滚完整业务 commit；精确验证时间只保留在 owner-scoped reconciliation。
6. legacy usage reconciliation primitive 会在 owner 与 tombstone `deletion_generation > 0` 匹配时锁定并串行检查该 session 的全部 operational row；任何 ledger/session owner 不一致都整体 fail-closed，不会跨 tenant 聚合或在 anonymize 时静默漏账。通过 owner 检查后先把历史 `usage_id IS NULL + costCNY=0` 的歧义值固化为 unknown，再逐一分配 ID、原子更新 usage JSON、建立或核对 billing fact，最后核对 row count、六类 token、known-cost row、规范化 cost 与 checksum。冲突会回滚 ID、JSON、fact 和 reconciliation，generation `0` 明确拒绝，不会被误当成已清理。
7. anonymize primitive 必须显式 enabled、携带已验证 checksum，并由 store 自己复核 durable tenant/user legal hold；通过后只删除目标 session 的 operational usage，保留 billing fact，重试幂等。legal hold 会阻止尚未发生的 `verified → anonymized`，但匿名化已提交、响应丢失后再新增 hold，不会把同 owner/generation/checksum 且 operational row 为零的重试伪装成失败。它尚未接入 erasure worker 或公开 API，因此不把 primitive 描述成自动保留策略已经运行。
8. 修复未知价格与历史投影语义：provider model 未配置 price 时，Pi turn 与 summarizer 不再把内部零值记录成已知 `costCNY=0`。Memory/MySQL 的 session、turn、event、compaction usage 投影都以 ledger 为权威；MySQL 在同一 consistent read/业务事务快照内以 SQL summary 聚合，读取和下一次 commit 都能纠正旧 writer 的 partial projection。历史 null-ID zero 因无法区分“未知价”与“真实免费价”而保守视为 unknown，新版有 identity 的 zero 保持 known-zero；普通 rollup 仅在全部组成记录已定价时返回完整 cost。硬 `maxCostCNY` 遇到正常 unpriced step 会先持久化该 step，再禁止其工具和后续模型 step，provider error/abort 不会被改写为 `max_cost`。
9. 新增冻结的 `0010` 历史数据库夹具，真实执行 `0010 → 0011`，覆盖空 ledger、全 priced、两种 mixed 顺序、legacy zero、新版 known-zero、turn/event/compaction 投影、marker 丢失重放不重复、migration 后旧 writer session/usage 插入与 partial projection 修复、owner 隔离，以及首张新表 DDL auto-commit 后续迁、错误形状 identity index 修复、case-sensitive schema、subject backfill、gate/legal hold 保留。runtime 正确性不依赖再次执行 migration DML；既有 usage/session/outbox/Blob 不被静默改写。历史升级链现在覆盖 `0007 → 0008 → 0009 → 0010 → 0011`。
10. CI/local verify 新增两个命名且不得 skip 的真实 MySQL 门禁：`test:usage-lifecycle-mysql` 与 `test:subject-lifecycle-mysql`；主 JSON report 也要求两个目标文件确实执行。runner image 启动检查要求最新 `0011` migration 已应用。OpenAPI/生成 SDK 已同步新增两条 data-lifecycle operations。

### 验证说明

- Memory 与真实 MySQL 专项套件覆盖 gate/request/audit 原子性、数据库回滚、create/Blob 并发边界、owner 隔离、usage 双写回滚、mixed unknown/known-zero、硬预算 fail-closed、legacy reconciliation 冲突、legal hold 与 crash-retry-safe 幂等 anonymize。
- `0010 → 0011` 使用独立历史 schema，而不是 fresh-schema 替代测试；CI 和 `scripts/local-service.sh verify` 都有显式执行入口和 no-skip proof。
- `pnpm check:secrets`：通过，扫描 **206 files**；`pnpm check:api`、`pnpm typecheck` 与 `git diff --check` 通过。
- MemoryStore/session lifecycle 定向套件 **57/57 passed**；router gate/滚动升级定向套件 **41/41 passed**；真实 MySQL usage lifecycle **8/8**、subject lifecycle **5/5**，两者的 no-skip execution proof 均通过。usage MySQL 还覆盖高金额 canonical `DECIMAL(24,9)` 原值、checksum 与 reconciliation retry。
- 固定历史 MySQL migration suites **7/7 passed**，真实执行 `0007 → 0008 → 0009 → 0010 → 0011`，包括相同 usage 合并、冲突阻断与 legacy pending receipt 保留。
- `scripts/local-service.sh verify`：主套件 **482 passed / 1 skipped**；覆盖率 **85.14% statements / 77.56% branches / 86.36% functions / 89.73% lines**；cluster **11/11 passed**；SDK 真实 18-file package 与 runner/router 原生 Node bundle 的启动、readiness、转发及 OpenAPI 门禁通过。
- 本轮修改了价格投影和预算判断，但未改变真实 provider dialect 或网络契约；unknown/known-zero 与 fail-closed 行为已有确定性 fake-engine/provider 测试，因此没有重复运行收费的 `verify-real` 或 acceptance。最近真实模型 **1/1** 与十阶段 acceptance 只作为历史基线，不冒充本轮结果。

### 当前边界与下一步

- M2 冻结结论不变，本轮没有开始 M3。M1 仍未闭环。
- 当前 user erasure 只完成 durable gate/request/status。尚无状态推进 worker、既有 SSE 撤销、active turn 跨 runner abort/drain、request/generation 绑定的 tombstone 批处理、ready Blob/session purge、completed proof 或备份恢复重放；`gated` 绝不等同于 erasure completed，完成这些能力前 staging/production 必须保持 writer gate 关闭。
- Blob 上传按 manifest stage→object put→mark 顺序执行；gate 若在 put 期间胜出，mark 会失败，对象只保留为 owner 不可读的 staging orphan，随后由已有 TTL cleanup 删除。该竞态已有真实 `SessionBlobService`→cleanup 回归测试，但它不是“gate 后物理字节已清零”的承诺。
- tenant erasure 尚未公开，API key 撤销、provider/auth secret 停用与 key revocation 尚未实现。公开范围继续限制为 admin service key 代表明确 user 发起请求。
- export 尚无异步 job、一致性 ownership snapshot、artifact ownership、下载 API、TTL 或删除任务；不能以同步大 JSON 替代完整 export。
- usage 已有安全 primitive，但自动任务、政策化 operational/billing 保留期、长期字段白名单治理和审计管理面仍待完成。legacy `deletion_generation = 0` 补偿以及默认关闭的 ready/session physical purge 仍是后续工作。
- MySQL 投影已避免把整份 ledger 拉入 Node，并保证同一快照正确性；当前聚合仍会按 `(session_id, ...)` 索引扫描长 session 的 ledger。M4 前应基于真实长会话做基准并决定是否增加事务维护的物化汇总，但不得以牺牲 unknown/owner fail-closed 语义换取性能。

## 2026-10-08（M1 数据生命周期：durable erasure worker 到安全策略边界）

### 已完成

1. 新增 expand-only `0012_erasure_job_queue.sql`：为 `erasure_requests` 增加 availability、attempt、claim token/lease、bounded error 与 immutable policy identity，并用 restart-safe trigger/backfill 让迁移后残留的 0011 writer 新建 gate 可领取。迁移不激活 purge，不覆盖 future retry/live claim；固定 0011 历史夹具覆盖完整状态、partial DDL、错误索引、marker-loss replay、legal hold 与不可领取 purge intent。
2. Memory/MySQL 实现最小权限 durable queue：claim、lease renew、phase transition、retry、attempt+token+lease 防 ABA，以及 request row 与无正文 audit 的原子更新。exact lease boundary、并发 claim、stale transition、audit INSERT 失败回滚、subject completion 与 owner/generation/audit corruption 均有真实 MySQL 回归。
3. 新增 claim-bound fixed session actions 和 content-free catalog。worker 只能 fence、固定 settle 与 tombstone，不能提交任意 patch/正文/usage；catalog 按 owner/generation/phase 分页，draining 枚举全部 live session，tombstoning 只给 child-first live leaves，reconciliation 返回最小 tombstone proof 与 completeness counts。MySQL 使用 owner-scoped composite index锁定，跨 tenant/user 查询不锁住真实 owner 行。
4. runner 内嵌、与 request admission 独立的 worker 已实现 `gated → draining → tombstoning → reconciling_usage → awaiting_purge_policy`。批量 claim 后每个 job立即独立 heartbeat，停机只在安全边界停止；失败只持久化 bounded code。成功不会调用 anonymize、领取 `session.purge`、删除 ready Blob/content/receipt，或标记 request `completed`。
5. 跨 runner drain 使用版本化私有 `drain-v1` 路径和同一内部 token；router 只选 configured、healthy、capable target，owner 409 至多重路由一次，内部 claim/拓扑/header不会回显。active turn 在 claim+session fence 线性化后收到 abort；若默认 10s 内仍未停止，旧 runner 不再 acquire/renew但也不主动释放 session lease。router只有在 Redis 明确确认 owner不存在时才绕过；owner仍存在或 Redis状态未知时 fail-closed，lease到期后由更高 fence接管。默认超时严格保持 Host 10s < Router 15s < Worker 20s。
6. usage reconciliation 现在与 erasure claim属于同一原子边界。catalog proof只做早期无正文筛查；Memory在单进程同步临界区、MySQL在同一事务中重新锁定 session→subject→request并验证 marker、terminal `session/deleted`、`session.tombstoned` 与从未激活的 `session.purge`，然后才分配 legacy usage id、写 billing fact/reconciliation。proof、usage identity或reconciliation确定性冲突进入 `blocked/integrity_conflict`；未知数据库/网络错误保持 retryable，任何冲突都不会留下部分 ID、fact 或 reconciliation。
7. 最终 review 另收口两个 fail-closed 缺口：MySQL live session若意外带正 `deletion_generation` 或非空 `purge_after_ms`，固定 action在任何写入前回滚，不能静默覆盖 marker；`applyErasureSessionAction` 在首次 await前克隆完整输入，避免锁等待期间的 mutable-input TOCTOU。真实 MySQL测试证明 fence、seq、事件、outbox与 marker均无部分写入。
8. 本地/CI execution proof已扩展：四个 erasure store专项命令不得 skip，主 JSON report还必须证明真实 MySQL worker文件执行；历史 migration wrapper使用固定五文件 manifest，缺失或未登记夹具都会失败。cluster新增双 runner remote drain、owner `SIGKILL`、Redis lease绝对过期时间不被重试刷新、过期后更高 fence takeover，以及完整 no-purge断言。OpenAPI、运行时常量和生成 SDK已同步 `userErasureWorker: ["drain-v1"]` capability。

### 本轮验证

- `pnpm check:secrets`：通过，扫描 **228 files**；`pnpm check:api`、`pnpm typecheck` 与 `git diff --check` 通过，生成 OpenAPI/SDK无漂移。
- Memory/core/protocol定向套件 **108/108 passed**；最终审查修复后的 core worker **38/38**、真实 MySQL erasure session **18/18**、真实 MySQL worker **7/7**。
- 固定历史 MySQL migration suites **9/9 passed**，真实执行 `0007 → 0008 → 0009 → 0010 → 0011 → 0012`；每个冻结夹具均由 report证明实际执行。
- `scripts/local-service.sh verify`：主套件 **652 passed / 1 skipped**；覆盖率 **85.33% statements / 79.03% branches / 86.65% functions / 89.83% lines**；cluster **13/13 passed**；SDK真实18-file package和 runner/router原生 Node bundle的启动、readiness、转发及 OpenAPI深比较通过。
- 本轮不改变真实 provider dialect或厂商网络契约，因此没有重复运行收费的 `verify-real` 或 acceptance；最近真实模型 **1/1** 与十阶段 acceptance仍只作为历史基线，不冒充本轮结果。

### 当前边界与下一步

- M2冻结结论不变，本轮没有开始M3；M1仍不能冻结。`awaiting_purge_policy`只是安全的非破坏边界，不是用户数据已擦除。
- 当前最重要的正确性缺口是 claim-stage poison：`0012` 在锁内发现 request/subject/audit/idempotency/queue结构损坏时会回滚整批，同一最早候选可能持续饿死有效邻居。下一独立切片是 `0013_erasure_job_control.sql`：保留原 phase的 durable quarantine overlay、append-only control audit、control generation/evidence hash CAS，以及固定配方、最小权限的 repair/resume；不能 catch-and-skip、直接改表或伪造普通主 audit链。
- 当前 non-destructive worker仍会领取意外 `purging` 并将其 fail-closed为 `policy_unavailable`。未来激活真正 purge worker前必须先升级并排空所有0012 worker、等待最大 job lease过期，再使用独立 policy activation与purge authority。
- `0013`之后仍需依次完成 legacy generation `0`补偿、canonical policy/legal-hold管理与默认关闭的purge substrate、export artifact/download/TTL、tenant key/provider/auth secret revocation、completed proof和独立故障域 restore replay；不可逆 purge只能在策略与真实共享对象存储确定后单独激活。

## 2026-10-08（M1 数据生命周期：0013 erasure quarantine/control plane）

### 已完成

1. 新增 expand-only `0013_erasure_job_control.sql`：request 增加 control generation 与三列 quarantine overlay，新建 append-only `erasure_job_control_events`、append-only `erasure_job_terminal_incidents` 和 quarantine-aware claim index。terminal incident只存opaque request locator、精确raw control fence、固定reason、SHA-256与时间，不复制tenant/user/subject/status/raw payload，也不建立可能误绑owner的外键。MySQL 8.0.26 可用的多重 UPDATE/DELETE trigger 在 migration 中断或 marker 丢失重放时持续保护两类证据；早期 triple unique 会先建立更强的临时 pair unique 后再切换，冲突时旧约束、两条证据和未写 marker 都保持原样，不由 migration 选择丢账。
2. Memory/MySQL claim 改为逐候选原子提交。安全envelope内的request、subject、main audit、idempotency、queue或control确定性损坏会保留原phase、清空availability/claim/lease、写canonical quarantine evidence，并继续扫描邻居。request/tenant/subject identity、generation或created/gated/updated顺序本身损坏时，不猜测owner：保留所有原字段与精确BIGINT fence，只撤销queue authority、写terminal overlay并在同一原子边界追加incident，随后继续邻居；重复poll不重复incident。未知程序、SQL 或网络错误仍回滚当前候选，不会被误判为 poison。Memory 的 gate、session 创建/首事件、普通 phase transition、control 与incident发布均有 intrinsic Map rollback；MySQL row、audit/control/incident与修复操作保持同一事务。
3. control audit 现在与主 audit 联合验证：重算 quarantine/blocked evidence，固定 reason→action，逐对核验 blocked/resume 的 phase、reason、时间和 generation，事件时间不得早于 durable gate或晚于 row update；repair outcome 使用可重放的 event commitment。`control_audit_invalid` 只可检查、没有通用 repair，full quarantine 即使残留损坏的私有 queue 字段也可安全读取和 CAS 处置，但 worker authority始终 fail-closed。
4. safe control-event 冲突使用未占用的后继 generation。若 request row 的原始 MySQL BIGINT fence 已达到或超过 `Number.MAX_SAFE_INTEGER`，则进入显式 terminal quarantine：保留/单调推进精确原 fence、把原始十进制值绑定进 evidence、清除全部 worker authority，不降级 fence、不补造冲突 control event，公开仍只显示 `blocked`，maintenance 返回空 action 且永久拒绝普通 repair。并发只终止写一次，UPDATE 失败完整回滚，正常邻居仍可领取。
5. runner 新增 additive `erasureJobControl=["quarantine-v1"]`；worker 每次数据库 claim 前都从 router 的 token-protected 私有 endpoint取得固定 ACK。router 必须在本进程观察 `RUNNERS` 每个稳定地址支持该能力；已观察地址的纯网络不可达保留 sticky attestation以支持死亡 owner 接管，明确旧版/错误/畸形响应会撤销，router重启则安全停领直至重新观察。公开 router capability 故意投影为空，不泄 fleet rollout 状态；新 request admission 仍另行要求 configured fleet 当前全健康。
6. 发布契约明确为：先迁移，部署 admission `0` 的新 router并排空旧router，再滚动新runner/worker、排空0012 worker并等待最大lease，最后才激活 writer gate。首个0013 control event或terminal incident后不得回退到旧reader/worker；barrier不能约束直连数据库的旧worker，因此旧进程 drain、网络/进程阻断和forward-fix仍是硬条件。
7. 固定 `mysql-0012.sql` 历史夹具和 `0012→0013` 独立套件已进入 no-skip manifest，覆盖完整升级、control表已提交但incident表尚未创建的DDL断点、partial DDL、两个 unique-index 隐式提交断点、marker-loss evidence保留、两张表append-only trigger逐步轮换，以及同 generation冲突证据阻断。CI 主测试固定最低支持 `mysql:8.0.26`，image job保留浮动 `mysql:8.0`，同时证明兼容下限与当前8.0镜像。
8. `docs/operations/development-and-ci-guide.md` 继续作为学习入口，已同步本地启动/手动体验、router/runner职责、Node bundle与Linux OCI image、CI构建门禁，以及local→staging→production使用同一digest的promotion与0013滚动激活边界。

### 本轮验证

- `pnpm check:secrets`：通过，扫描 **233 files**；`pnpm check:api`、`pnpm typecheck`、`pnpm check:sdk` 与 `git diff --check` 通过，SDK真实 **18-file** package在隔离consumer中完成runtime import与TypeScript编译。
- Memory session/gate/erasure定向套件 **90/90 passed**（其中unsafe-envelope/control专项 **36/36**）；真实MySQL erasure-job **29/29 passed**，覆盖三类unsafe envelope、nullable gate、双store竞争、exact BIGINT保留、完整evidence重算与incident INSERT整事务回滚。required execution proof明确确认目标文件执行；独立安全review未发现P0–P2、authority bypass、跨tenant/user越权或secret泄漏。
- 固定六文件历史迁移套件 **15/15 passed**；其中 `0012→0013` **6/6**，真实执行完整升级、中断重放、两类append-only证据保护、约束切换和冲突阻断。`0007→0008`的相同usage合并、内容冲突阻断与legacy pending receipt保留仍在同一必跑链中。
- `scripts/local-service.sh verify`：主套件 **728 passed / 1 skipped**；覆盖率 **85.66% statements / 79.38% branches / 87.12% functions / 90.00% lines**；cluster **14/14 passed**；runner/router原生Node bundle的readiness、转发与OpenAPI深比较通过。
- 本轮未修改provider dialect或真实厂商网络契约，因此没有重复运行收费的`verify-real`或acceptance；最近真实模型 **1/1** 与十阶段acceptance仍只作为历史基线，不冒充本轮结果。

### 当前边界与下一步

- M2本地/CI代码范围仍正式冻结；本轮没有提前开始M3。M1仍不能冻结：legacy `deletion_generation=0`补偿、canonical policy/legal-hold、异步export artifact/download/TTL、tenant与key/provider/auth secret撤销、默认关闭的ready/session purge、completed proof和restore replay尚未闭环。
- terminal quarantine/incident是fence耗尽或unsafe identity/generation/time envelope的永久安全停机点，不是普通可修复状态。incident只解决worker authority撤销、审计留痕和邻居进度，不会猜测owner或修复原行；当前需保全证据并forward-fix。专用事故迁移、指标/告警和受审计的operator workflow留在后续运维/M4收口，绝不能手工调小BIGINT、改写incident或补造event。
- barrier ACK到数据库claim之间仍有极短TOCTOU，安全性依赖禁止版本回退；共享internal bearer token在云上还需私网ACL、TLS/mTLS、Secret轮换。真实固定N-1镜像mixed-version canary、production独立migration Job和运行时最小数据库权限也留待M4部署编排。
- 下一独立切片先处理legacy generation `0`可审计补偿，再实现canonical policy/legal-hold和默认关闭的purge substrate；在真实共享对象存储、保留政策与恢复门禁确定前，不激活不可逆删除。

## 2026-10-08（M1 数据生命周期：0014 legacy generation-zero tombstone 补偿）

### 已完成

1. 新增 dormant、expand-only 的 `0014_legacy_tombstone_compensation.sql`：write-once cutover singleton、每 session 一个 durable job、append-only result audit、candidate/claim indexes 与 session writer guards。应用 migration 本身不会激活 cutover、扫描/排队历史行、生成 event/outbox、改变 generation、开放 purge 或删除内容；migration marker 与 runtime activation 明确分离。
2. cutover 激活与 session writer 通过 singleton 行锁线性化；提交后数据库拒绝新的 generation-zero tombstone 及不一致 marker。该边界不可 disable/down-migrate，激活后不能恢复 pre-`0014` writer，只能 forward-fix。router/runner job-control 提升为故意不兼容的 v2：全部 configured stable runner 必须同时声明 `quarantine-v1` 与 `legacy-tombstone-compensation-v1`，旧 v1 私有 endpoint 固定 404，旧 worker 不能在 rollout 期间继续 claim。
3. Memory/MySQL 都实现 global maintenance 与 erasure-claim targeted scheduling、确定性 per-session job identity、attempt+token+lease 防 ABA、续租不缩短、retry、exact completed replay 和 content-free terminal incident。owner 路径始终 tenant/user scoped；全局扫描只属于内部 maintenance。unsafe envelope、缺失/冲突 result、损坏 session candidate 均逐候选隔离并继续健康邻居，未知数据库/传输故障仍整事务回滚后重试。
4. 成功 completion 在同一 Memory 原子发布/MySQL 事务中固定结算残留 active turn 与 pending approval，保留原 `deletedAt`，追加连续 `session/deleted`，把 marker 推进到 generation `1`，写即时 `session.tombstoned` 与不可领取的 `session.purge` intent，追加成功 audit并完成 job。序列化、event/outbox/audit/session/job 任一步失败都不留下部分 seq、marker、intent 或 settlement。
5. child-first 语义同时覆盖活性与永久故障：无 job 或合法 pending/no-result 的 generation-zero child保持可重试；已经 terminal/proof-conflict/unsafe 的 child、completed-marker矛盾、live direct child、跨 owner child和 ancestry cycle都会让 parent 原子进入 `child_dependency_invalid`，不会永久 `child_pending`。deterministic targeted scheduling fault由普通 erasure worker映射为 `blocked/integrity_conflict`，不会伪装成 transient retry。
6. runner 内嵌 compensation worker 与普通 erasure worker分权但共用 v2 fleet barrier；产品配置默认关闭两个 worker与 admission，本地统一脚本显式开启两个 worker但仍默认关闭新 erasure admission。普通 worker遇到 generation-zero session会建立 targeted job并等待补偿，然后继续现有 usage proof/reconciliation；任一 terminal compensation会安全阻断 request，而不是猜测或删除内容。
7. 固定 `mysql-0013.sql` 与真实 `mysql-0008-legacy-tombstones.sql` 历史夹具进入 no-skip manifest。独立 `0013→0014` 套件覆盖完整升级、0008历史 tombstone 经生产迁移链保留、partial DDL/marker-loss replay、错误 index/trigger 收敛、cutover/legacy writer 并发线性化和激活后 guards。命名的真实 MySQL runtime套件覆盖 global/targeted、claim/ABA、并发完成/响应丢失、active资源结算、audit失败整事务回滚、terminal replay、缺result poison、parent/child/owner/cycle与健康邻居进度。
8. README、架构/生命周期设计、部署 runbook 和长期学习文档已同步本地启动、手动体验、router/runner职责、Node bundle与 Linux OCI image、CI实际构建门禁，以及 local→staging→production 同一 digest promotion 和 `0014` forward-only激活边界。SDK打包检查改用 pnpm 10/11/12 都接受的 config形式，本地与CI工具链不再因 `pack` flag差异分叉。

### 本轮验证

- `pnpm check:secrets`：通过，扫描 **243 files**；`pnpm check:api`、`pnpm typecheck`、`pnpm check:sdk` 与 `git diff --check` 通过，SDK真实 **18-file** package在隔离 consumer中完成 runtime import与TypeScript编译。
- Memory/contract generation-zero专项 **30/30 passed**；core/router/runner/protocol相关定向回归通过。命名的真实 MySQL compensation套件 **13/13 passed**，required wrapper明确证明目标文件执行且没有 skip。
- 固定七文件历史 MySQL migration suites **20/20 passed**；其中 `0013→0014` **5/5**，`0007→0008` 的相同 usage 合并、冲突阻断与 legacy pending receipt保留仍在同一必跑链中。
- `scripts/local-service.sh verify`：主套件 **784 passed / 1 skipped**；覆盖率 **85.20% statements / 79.29% branches / 87.79% functions / 89.33% lines**；cluster **14/14 passed**；SDK package及 runner/router原生 Node bundle的启动、readiness、转发和 OpenAPI深比较通过。
- 独立交叉 review从并发/ABA、事务回滚、滚动升级、安全隔离和测试有效性五个角度复核，当前 `0014` 范围无剩余 P0–P2。本轮不改变 provider dialect或真实厂商网络契约，因此没有重复运行收费的 `verify-real` 或 acceptance；最近真实模型 **1/1** 与十阶段 acceptance仍只作为历史基线，不冒充本轮结果。

### 当前边界与下一步

- M2本地/CI冻结结论不变，本轮仍属于 M1 数据生命周期，没有提前开始 M3。generation-zero补偿已收口，但 `awaiting_purge_policy` 仍不是擦除完成；M1还需 canonical policy/legal-hold与默认关闭的 purge substrate、异步 export artifact/download/TTL、tenant与 key/provider/auth secret撤销、completed proof和独立故障域 restore replay。
- 下一独立切片先实现 canonical policy/legal-hold与不可领取的 purge policy substrate；在保留期、共享对象存储、备份恢复门禁和 operator事故流程明确前，不激活不可逆 ready Blob/session purge。随后完成 export、tenant/key撤销、completed proof与restore replay，再正式进入 M3。
- `0014` cutover 激活后必须 forward-only。sticky barrier仍依赖实例稳定地址、排空旧 worker和禁止版本回退；尚无真实 N-1旧binary canary。正常 runtime不可生成但特权数据库损坏可制造同 session/不同jobId的 orphan result，当前作为 P3事故风险保全并留给受审计运维流程；Memory非canonical audit-only候选也只有 O(n)重扫的测试后端效率残余。append-only trigger不能防御持有DDL/TRUNCATE权限的主体，生产需独立 migration identity与最小 runtime权限。
- 当前无云资源不阻止继续完成 local/CI代码范围，但不能据此宣称 staging/production已部署。Kubernetes、共享对象存储、KMS/Secret、域名/TLS、真实 IdP、MySQL/Redis拓扑、备份和容量参数仍等待真实环境后落地；CI当前只 build/load/start候选镜像，不推 registry、不签名也不执行 promotion。

## 2026-10-09（M1 数据生命周期：0015 canonical retention policy / multi legal hold）

### 已完成

1. 新增 canonical retention-policy authority：tenant 内的 policy version 不可变，七类 duration 必须完整声明且 `null` 明确表示 fail closed；active control 通过 generation CAS 和 rooted append-only activation audit 切换。activation 提交即生效，不提供依赖 runner 墙钟的未来调度，跨 runner 时钟倒退会在 control 锁内单调化。
2. 新增 tenant/user scoped multi legal-hold ledger：同一 subject 可并存多条 hold，set/release 各自使用 generation CAS；release 只结算指定 hold，其它 active hold 继续生效。control、active projection、legacy compatibility shadow 与 append-only event chain相互校验，外部案件引用只接收 SHA-256，不保存原文。canonical hold 已接入 usage anonymize 的破坏性写入门禁，但本轮没有新增 anonymize/purge worker。
3. MemoryStore 以同步临界区和 staged multi-map publish 保证 policy/hold control、ledger、audit及 lifecycle shadow 同时提交或回滚；MySQLStore 使用 InnoDB transaction、tenant→user→ledger 锁顺序、generation CAS和失败回滚。两端都覆盖immutable replay、response-loss replay、并发 activation/set/release、时钟落后、audit注入失败、跨tenant隔离及hold/anonymize线性化。
4. 新 erasure request 在 admission 事务中观察并永久绑定当时 active policy 的 version/hash；activation 前已提交的 backlog及其幂等 replay保持未绑定，不能事后借新策略获得删除权限。`0015` 的 replay-safe `BEFORE INSERT` guards与activation共用tenant control锁：control缺失/休眠时只允许`NULL/NULL`，active后只允许binary-exact version/hash；旧 writer若晚于activation只会整事务失败。guard故意不拦 UPDATE，避免把历史 backlog困死。
5. 新增 admin-only且`Cache-Control: no-store`的8个公开管理操作：policy put/activate/active get/version get，以及 hold set/release/get/active-list。`policyVersion=active`保留给固定路由。runner/router的`DATA_GOVERNANCE_MANAGEMENT_ENABLED`默认`0`；`dataGovernance`只表示writer/store理解durable contract，`dataGovernanceManagement`才表示管理API已开启。router要求全部configured target健康、code-aware且management-active，并在转发前复核目标；erasure POST也要求全fleet code-aware，避免mixed-version漏绑。
6. 新增expand-only `0015_retention_policy_and_legal_holds.sql`及冻结的`mysql-0014.sql`历史夹具。migration不会创建active policy、改绑backlog、修改usage/content、调度purge或推进request；已有`legal_hold_at_ms`被保全为确定性的migration-owned canonical hold。marker-loss replay验证rooted generation-1 provenance；同key/内容冲突、损坏control或audit会阻断而非静默覆盖。
7. 固定`0014 → 0015`真实MySQL套件覆盖无control/休眠control、legacy hold导入、partial DDL、marker-loss、冲突阻断、append-only/单向release、旧writer INSERT guard、旧backlog UPDATE，以及activation-first/insert-first两种并发顺序；同时恢复冻结夹具中的真实0012 job trigger，证明多个`BEFORE INSERT` trigger共存。历史wrapper现在固定枚举`0007 → ... → 0015`八个夹具并拒绝missing/skip。
8. OpenAPI 3.1、runtime schema、生成TypeScript SDK、CI命名real-MySQL门禁、runner image migration marker、本地统一验证脚本、README、架构/生命周期设计、部署runbook和长期学习指南均已同步。学习指南已集中回答本地启动与手动体验、router/runner职责、Node bundle与Linux OCI image差异，以及GitHub Actions实际构建/启动哪些进程和镜像。

### 本轮验证与审查

- `pnpm check:secrets`通过，扫描 **249 files**；`pnpm check:api`、`pnpm check:sdk`、`pnpm typecheck`与`git diff --check`通过，生成API/SDK无漂移，SDK真实 **18-file** package在隔离consumer中验证。
- `scripts/local-service.sh verify`主套件 **810 passed / 1 skipped**；唯一skip是真实厂商E2E的显式开关。覆盖率 **85.09% statements / 79.15% branches / 88.20% functions / 89.05% lines**，全部超过门槛。
- canonical policy/hold命名真实MySQL套件 **7/7**、Memory专项 **11/11**；历史迁移 **29/29**，其中`0014 → 0015` **9/9**，wrapper逐文件证明八个冻结夹具实际执行且未skip。真实MySQL usage **8/8**、subject **6/6**、erasure job **30/30**、legacy compensation **13/13**命名套件也全部通过。
- 多进程cluster **14/14**；`pnpm build:check`构建SDK与两个独立Node 24 ESM bundle，并以原生Node启动runner/router验证readiness、capabilities、转发和OpenAPI一致性。
- 从并发正确性、事务回滚、滚动升级、安全隔离和测试有效性复核：activation/request与hold/anonymize均有数据库锁线性化；Memory故障注入和MySQL audit/trigger失败均证明无部分状态；tenant/user查询和hash/audit均owner-scoped；管理面默认关闭且不持有purge authority；CI和local都有named no-skip execution proof。两轮独立复核发现并修复了OpenAPI非负安全整数下界漂移，以及MySQL repeatable-read并发请求在等待winner后必须使用locking current read的问题，并增加边界契约与双连接确定性回归。本轮未改变provider dialect或真实厂商网络契约，因此没有重复运行收费的`verify-real`或acceptance；最近真实模型 **1/1** 与十阶段acceptance只保留为历史基线。

### 当前边界与下一步

- M2本地/CI冻结结论不变，本轮仍属于M1，没有提前开始M3。M1仍不能正式冻结：canonical policy现在只是可信authority，尚缺policy evaluator、默认关闭且分权的ready Blob/session purge substrate、completed proof；异步export artifact/download/TTL、tenant erasure及key/provider/auth-secret撤销、独立故障域restore replay也未完成。
- `0015`应在management/admission关闭时先迁移，再滚动code-aware runner/router，最后才开启各runner及router管理gate。首个policy activation或canonical hold event提交后不可回退pre-`0015` writer，只能保留证据并forward-fix。固定N-1旧镜像canary、独立production migration Job、runtime最小数据库权限与真实Kubernetes rollout仍属于M4/真实环境工作。
- app-level append-only校验和数据库trigger不能抵御拥有DDL/TRUNCATE权限的主体；生产必须把migration identity与runtime identity分离。当前filesystem Blob仍只承诺单runner本地语义，不能在无共享对象存储时开启多VM/Pod物理purge。
- 下一独立切片实现policy evaluator与默认关闭、不可领取的purge authority substrate：先证明到期计算、hold复核、request-bound policy及完成证明，不在缺少共享对象存储、恢复门禁和显式激活的情况下执行不可逆删除。随后收口export、tenant/key撤销与restore replay，M1闭环后再正式进入M3。

## 2026-10-09（M1 数据生命周期：0016 非破坏性 purge-policy evaluator / authority）

### 已完成

1. 新增expand-only、destructive-dormant的`0016_erasure_purge_policy_authority.sql`：durable evaluation job、按build generation不可变的per-session target、rooted append-only decision chain、generation-CAS authority control和append-only authority。migration不回填历史`awaiting_purge_policy`、不设置`purge_after_ms`、不开放`session.purge`或ready Blob delete、不匿名化/删除数据，也不推进request到`purging/completed`。
2. Memory/MySQL在普通erasure worker把request从`reconciling_usage`推进到`awaiting_purge_policy`的同一原子边界创建generation 1 evaluation job；phase、main audit与job任一步失败都整体回滚。历史awaiting row由新scheduler显式补排，并发scheduler通过request/job锁与唯一身份只建立一个build。
3. evaluation job使用build generation、attempt、claim token和lease防stale/ABA worker；分页target以session id keyset推进并形成root hash。证据只包含request-bound policy下的tombstone generation/time、session content deadline、ready Blob count/root/deadline、usage reconciliation状态/checksum/deadline、receipt count/deadline，以及固定的billing fact/lifecycle audit retained与export not-applicable分类，不复制正文或物理locator。
4. 每次seal把`unbound/invalid/unconfigured/held/waiting/eligible_execution_disabled`之一追加到不可变hash chain；只有最后一种会追加authority并推进active projection。authority/control故意没有availability、claim或lease，evaluator也没有SessionStore、lifecycle outbox、Blob delete、usage anonymize或erasure phase-transition接口；protocol明确发布`dataPurgeExecution=false`，completion readiness固定`complete=false`。
5. seal重新读取owner-scoped inventory、request-bound immutable policy以及tenant/user hold generation/projection。build中session/usage/receipt/Blob evidence漂移会以`evidence_changed`释放claim、递增build generation并从空cursor/root重建；sealed结果后的live evidence变化或hold set/release ABA会清除旧active projection并调度新generation，旧target/decision/authority不被覆写。validated read还会重算hash chain、owner与live root，损坏或过期证据fail closed。
6. runner内嵌独立`PurgePolicyEvaluator`，只依赖最小`ErasurePolicyEvaluationStore`；按原子target page响应shutdown，不会在partial build后seal。runner/router的`PURGE_POLICY_EVALUATOR_ENABLED`均默认`0`；worker每次schedule/claim前请求token-protected专用固定ACK，router只有在自身gate开启且全部configured稳定runner当前健康、声明`policy-evaluator-v1`时放行。公开`purgePolicyEvaluation`表示代码感知，不代表worker或执行面已激活。
7. 冻结`mysql-0015.sql`历史库并新增独立`0015 → 0016`真实MySQL夹具，覆盖升级前数据、完整升级、partial DDL/marker-loss replay、append-only trigger轮换、升级后同key异内容写入被拒且原证据保留，以及purge继续休眠。`pnpm test:migrations`清单、CI、runner image marker和本地`verify`已接到0016；`pnpm test:erasure-purge-policy-mysql`作为named no-skip真实InnoDB门禁，主JSON report也要求目标文件确实执行。
8. README、架构/生命周期设计、部署runbook和长期学习指南已同步：evaluator仍是runner内部循环，不新增第三个服务或镜像；本地可显式开启双端gate观察job/decision/authority，GitHub Actions仍只构建runner/router两个Node bundle和两个Linux OCI候选镜像。

### 本轮验证

- `pnpm check:secrets`通过，扫描 **259 files**；`pnpm check:api`、`pnpm check:sdk`、`pnpm typecheck`与`git diff --check`通过，生成OpenAPI/SDK无漂移，SDK真实 **18-file** package在隔离consumer中验证。
- evaluator Memory **17/17**、core **9/9**；generic transition/outbox hardening相关Memory三文件 **31/31**，真实MySQL lifecycle outbox **11/11**。router/runner/protocol的barrier、capability、HTTP与启停定向套件均通过。
- 命名的真实MySQL purge-policy套件 **14/14**，required wrapper明确证明目标文件实际执行且无skip；固定九文件历史迁移 **34/34**，其中`0015 → 0016` **5/5**，覆盖冻结0015库、完整升级、DDL双中断/marker-loss重放、升级后真实evaluator，以及升级后同key异内容写入被拒且原证据保留。`0007 → 0008`的相同usage合并、冲突阻断与legacy pending receipt保留仍在同一必跑链中。
- `scripts/local-service.sh verify`主套件 **861 passed / 1 skipped**；唯一skip是真实厂商E2E的显式开关。覆盖率 **84.86% statements / 79.52% branches / 88.33% functions / 88.84% lines**，全部超过门槛；cluster **14/14**；runner/router两个独立Node 24 bundle、SDK package、readiness、转发与OpenAPI门禁通过。
- 从并发正确性、事务回滚、滚动升级、安全隔离和测试有效性复核，无剩余P0–P2。独立复核促成并验证了scheduler/claim poison不饿死邻居、Memory seal ABA二次授权、policy时钟clamp、target字段/hash/owner校验、foreign reconciliation字段隔离、通用transition证明面关闭及两端outbox topic ACK门禁。本轮不改变provider dialect或真实厂商网络契约，因此没有重复运行收费的`verify-real`或acceptance；最近真实模型 **1/1** 与十阶段acceptance只保留为历史基线，不冒充本轮结果。

### 当前边界与下一步

- M2本地/CI冻结结论不变，本轮仍属于M1，没有提前开始M3。`eligible_execution_disabled`这个名字故意表达“policy候选条件已满足，但执行关闭”；它不是purge license，也不会改变公开request仍为`awaiting_purge_policy`。
- 当前eligibility使用runner记录的wall clock；虽然单条control/audit时间会单调clamp，但跨VM forward/slow skew尚未由共享数据库/可信时间在线性化点重验。future destructive executor必须使用数据库时间或等价可信clock重新证明deadline，不能直接相信0016 authority的时间判断。
- target是per-session policy摘要而非turns/items/events/approvals全量内容清单，无法排除孤儿正文。未来执行事务必须owner-scan并提交`session_content_receipts`，同时补齐ready Blob physical ACK、operational usage anonymization、idempotency receipt与Redis清理、provider/auth secret撤销、独立restore-ledger ACK；上述proof全部缺失时completion保持false。
- 两项非阻断P3留到后续运维/性能切片：MySQL scheduler的初选会把缺失或损坏latest decision的sealed job安全地排除但不会主动quarantine/告警；同一查询当前也没有due水位或分页，长期稳定backlog会被每轮全量复核。它们不会生成authority或启用purge，但M4需补poison可观测性、due index/水位与有界扫描。
- M1仍需异步export artifact/download/TTL、tenant erasure及key/provider/auth-secret撤销、默认关闭且分权的ready/session destructive executor、completed proof与独立故障域restore replay。完成这些local/CI可验证范围后再正式进入M3；真实共享对象存储、KMS/Secret、Kubernetes rollout、域名/TLS和云MySQL/Redis拓扑继续等待实际资源，不能编造。

## 2026-10-09（M1 数据生命周期：0017 异步 user export artifact / download / TTL）

### 已完成

1. 新增expand-only的`0017_user_export_jobs_and_artifacts.sql`：owner/subject-generation绑定的request/job、不可变snapshot record、source-Blob pin、artifact/part、download lease和artifact-delete outbox。migration不创建request、不扫描/导出历史内容、不启用HTTP gate或worker，也不改变`0016` purge authority的非执行语义。
2. POST admission在Memory/MySQL中原子建立request与job，并与active retention policy的正值`exportArtifactTtlMs`绑定；tenant/user/idempotency作用域、同key重放/异义冲突及export/erasure的subject锁线性化均有回归。subject进入deleting后不再接收新export；已先提交的export会被erasure撤销、取消download lease并调度精确制品清理。
3. MySQL worker用`REPEATABLE READ WITH CONSISTENT SNAPSHOT`复制owner白名单数据和附件descriptor，事务外按固定kind/logical-key/ordinal生成确定性的multipart `ndjson-v1`。附件按base64 chunk输出；secret、idempotency、claim/lease、subject/build fence、storage backend/format/key等私有信息均不进入制品。只有part、manifest、整体size/hash全部核对后，request/artifact/job才原子变为ready。
4. build、part ACK、download与delete均使用attempt/token/lease/generation CAS防stale/ABA。download在任何Blob读取前重复核对owner、subject/build/deletion generation、policy、format/schema/content type、canonical key、part连续性、总大小与manifest；durable lease重放单调且单次存活期硬限制10分钟。普通artifact TTL等待活动download结束，erasure revocation可立即撤销；物理删除通过独立outbox完成后才CAS ACK。
5. artifact staging TTL明确为“无活动build claim时的orphan回收阈值”，不是活动build的硬deadline。claim与cleanup在request→job→artifact→parts锁序下竞争：活动或已接管的exact claim可继续stage/ACK/complete；cleanup先赢则原子failed、释放snapshot并生成精确delete intent。Memory/MySQL语义及真实InnoDB竞态测试一致。
6. poison request/job/artifact处理采用fail-closed隔离。可证明owner/generation/active指针一致时，quarantine在一个事务中先把exact artifact/parts转`delete_pending`并写outbox，再失败request/job和释放snapshot；故障注入证明中途失败全部回滚。坐标本身冲突时不猜测owner、不自动删除；单个poison候选也不会饿死同轮健康邻居。
7. runner新增三个公开操作：`POST /v1/data-export-requests`、status GET和download GET；router/runner双端admission gate默认关闭，build/cleanup worker与admission分离。filesystem read surface只在非production、显式single-runner断言下注入/宣告；production即使误配flag或runner误报capability也fail-closed，待共享对象存储adapter完成后再设计多VM/Pod rollout。OpenAPI 3.1与生成TypeScript SDK同步到53个操作。
8. 冻结`mysql-0016.sql`并增加独立`0016 → 0017`真实MySQL夹具；完整历史wrapper固定执行`0007 → ... → 0017`。CI/local verify增加named export no-skip proof、migration manifest和runner image `0017` marker；学习指南同步本地启停、手工export体验、router/runner职责、Node bundle与Linux OCI image、GitHub Actions构建内容及local→staging→production同digest promotion边界。

### 本轮验证与审查

- `pnpm check:secrets`通过，扫描 **269 files**；`pnpm check:api`、`pnpm check:sdk`、`pnpm typecheck`与`git diff --check`通过，生成OpenAPI/SDK无漂移，SDK真实 **18-file** package在隔离consumer中验证。
- export相关10个定向文件 **151/151**；Memory export **11/11**；named真实MySQL export **11/11**，required wrapper明确证明目标文件实际执行且无skip。真实套件覆盖request/job原子回滚、并发idempotency、RR snapshot回滚/重试、source Blob pin、core worker跨层发布、claim ABA、export/erasure串行、download TTL lease、staging orphan cutoff、poison quarantine与delete dead-letter邻居进度。
- 固定10文件历史MySQL迁移 **39/39**，其中`0016 → 0017` **5/5**；wrapper逐文件证明`0007 → 0008`的相同usage重复安全合并、内容冲突阻断及legacy pending receipt保留仍真实执行，`0010 → 0011`的through-latest路径也已覆盖到`0017`。
- `scripts/local-service.sh verify`主套件 **922 passed / 1 skipped**；唯一skip是真实厂商E2E的显式开关。覆盖率 **83.17% statements / 78.63% branches / 86.82% functions / 86.83% lines**，MySQL store **85% lines**；cluster **14/14**；SDK package与runner/router两个独立Node 24 bundle均完成构建，并以原生Node验证启动、readiness、转发和OpenAPI。
- 从并发正确性、事务回滚、滚动升级、安全隔离和测试有效性进行三轮独立复核，最终无P0/P1。复核促成下载前完整identity/manifest校验、production read-surface关闭、NDJSON私有字段扫描、poison artifact原子清理、staging TTL一致语义及download lease硬上限。本轮没有改变provider dialect或真实厂商网络契约，因此未重复运行收费的`verify-real`或十阶段acceptance；最近真实模型 **1/1** 与acceptance通过只保留为历史基线，不冒充本轮结果。

### 当前边界与下一步

- M2本地/CI冻结结论不变，本轮仍属于M1，没有开始M3。异步user export的local/CI代码范围已完成，但它只生成临时副本，不能替代源数据purge或证明erasure completed。
- 当前MySQL snapshot capture仍在一个RR事务内全量读取并序列化单个user数据，同时持有subject SHARE及request/job锁；超大user可能放大runner内存、MVCC事务时长和erasure等待。正式production开放export前必须用同一快照内的keyset分页/流式hash-insert或明确的record/byte资源上限收口，并做长用户压测。
- 身份坐标本身发生特权数据库损坏时，cleanup会安全拒绝猜测删除，可能保留孤儿制品，未来需受审计maintenance remediation。后续ready/session物理purge executor必须尊重未释放的export source-Blob pin；当前destructive purge仍关闭，因此不是现时删除竞态。
- M1下一步仍是tenant erasure、key/provider/auth-secret撤销、使用可信数据库时间和owner-scan/content receipt的默认关闭destructive executor、ready Blob/session及receipt/Redis物理清理、completed proof与独立故障域restore replay。完成这些local/CI可验证范围后才能正式冻结M1并进入M3；没有云资源不阻止继续实现代码与本地门禁，但共享对象存储、KMS/Secret、Kubernetes、云MySQL/Redis、域名/TLS、备份和真实IdP仍必须等待实际环境，不能伪造参数或宣称已部署。

## 2026-10-09（M1 数据生命周期：0018 tenant erasure T1 / credential revocation fence）

### 已完成

1. 新增 expand-only 的 `0018_tenant_credential_revocation_fence.sql`，安装独立 tenant erasure admission/fence 表与 append-only guards；MemoryStore 以 staged publish、MySQLStore 以单个 InnoDB transaction 原子建立 admission、tenant lifecycle deleting gate、首条 content-free audit 和 credential fence。序列化、audit 或 SQL 任一步失败都不会留下半个 admission、部分 generation 或“已 gate 但无 fence”的状态。
2. T1 的 admission 故意不复用冻结的 `erasure_requests` user queue，pre-`0018` worker 因此不会 claim、quarantine 或篡改 tenant 请求。`0018` 只建立逻辑 credential fence：不提供公开 tenant HTTP/OpenAPI/SDK、status/replay、环境开关、worker 或 fleet barrier，也不物理删除 API key、provider key/config 或 auth secret；mixed fleet 在 T2 barrier 完成前禁止调用该内部原语。
3. 现有 tenant-scoped API key、provider config/secret、auth policy、agent/session/data 读写与 tenant-key retention-policy/legal-hold 管理写在 gate 后 fail closed。provider secret resolve 会在解密前后重验 tenant generation，新的 outbound fetch 在发出前重验，runner bootstrap 也在线性化边界复核 tenant 状态；已经发出的外部网络 I/O 不会被强制取消，其响应可能短暂留在进程内存，但 gate 后的持久化写入仍会被拒绝。
4. MySQL 普通 session-owned reads 同时检查 lifecycle、独立 admission 与 credential fence，覆盖 session、turn/item/approval、ready/bindable Blob、usage 与 idempotency receipt；admission-only 或 fence-only 的特权损坏态也不会让数据复活。相同 append-only 证据还是 user-erasure worker 与 purge evaluator 的 parent-authority fence，阻止 lifecycle 异常复位后重新 claim、续租、transition、执行 session action、repair 或生成 purge authority，并保持健康邻 tenant 可推进。`readEvents`、`getSessionLifecycle`、`getBlobManifest` 与 lifecycle outbox 仍是受控 maintenance raw path，用于终止已建立 SSE 和后续清理证明，不是普通数据面绕过。
5. runner 将 `SubjectDeletingError` 稳定映射为 `409 subject_deleting`。user erasure worker 的 claim 查询明确只选择 `subject_kind='user'`，tenant admission 不会进入旧队列；provider registration identity 也消除了 tuple/`platform` 碰撞，同时保留无歧义历史 identity 的兼容读取。
6. 冻结 `mysql-0017.sql` 历史数据库并新增独立 `0017 → 0018` 真实 MySQL 迁移夹具，覆盖冻结旧 scheduler、完整升级、partial DDL/marker-loss replay、tenant admission 不进入 legacy user scan、唯一性与 append-only 约束。named tenant Memory/MySQL/race 套件另外覆盖 admission/fence 幂等与冲突，并通过代码面审查确认没有公开入口或后台执行。历史 wrapper 固定执行 `0007 → ... → 0018`，CI 与本地 verify 都要求 migration、tenant MySQL 和 tenant race 报告存在、目标文件实际执行且零 skip。
7. 学习与运维文档已继续集中说明本地启动/手动体验、router/runner 职责、Node ESM bundle 与 Linux OCI image 的区别、GitHub Actions 实际构建/启动门禁，以及 local → staging → production 应 promotion 同一不可变 image digest 的契约。无云资源不阻止 local/CI 代码推进，但不能据此伪造 Kubernetes、registry、KMS/Secret、对象存储、域名/TLS 或云数据库参数。

### 本轮验证与审查

- `scripts/local-service.sh verify` 全链通过，其中包含 `pnpm check:secrets`（扫描 **275 files**）、`pnpm typecheck`、主套件 **958 passed / 1 skipped**、固定 **11** 个真实 MySQL 历史迁移文件 **47/47**、cluster **14/14**、SDK **18-file** package，以及 runner/router 两个独立 Node bundle 的原生启动、readiness、转发和 OpenAPI 深比较。唯一 skip 仍是真实厂商 E2E 的显式付费开关；覆盖率为 **83.52% statements / 79.03% branches / 87.34% functions / 87.17% lines**。
- `0017 → 0018` 历史升级 **8/8**；tenant Memory **10/10**、named 真实 MySQL **10/10**、双 store/双连接并发 race **9/9**、user export MySQL **12/12**。具名 wrapper 与 JSON report 断言证明目标套件实际执行且没有被过滤或 skip。
- 从并发正确性、事务回滚、滚动升级、安全隔离和测试有效性复核，最终无剩余 P0–P2。复核补齐了 orphan admission 独立 fail-closed、export/status/download revocation、普通 MySQL read backstop、user-erasure/evaluator authority 防复活、tenant-key governance 写线性化、runner bootstrap race 与 provider generation recheck；同时保留 runtime 对缺失 `0018` 安全表的硬失败，仅让旧迁移夹具在调用当前 Store 前显式安装空的 dormant `0018` overlay，避免把 `ER_NO_SUCH_TABLE` 误判为“无 fence”。
- 本地测试库曾残留开发中间态的 `0018` marker，导致首次完整 verify 正确暴露“marker 已存在但 admission table 缺失”；仅重建可丢弃的 `agent_service_test` 后，使用最终冻结 migration 从空测试库和历史 `0017` 夹具均重复通过。业务库 `agent_service` 未被修改。另一次构建失败来自本机缓存 pnpm launcher 缺少 shebang；使用不入库的临时 launcher 后，`build:check` 与随后整套 verify 均通过，产品代码和仓库脚本无需环境特判。
- 本轮未改变 provider dialect 或真实厂商网络契约，因此没有重复运行收费的 `verify-real` 或十阶段 acceptance；最近真实模型 **1/1** 与 acceptance 通过仍只作为历史基线，不冒充本轮结果。

### 当前边界与下一步

- M2 本地/CI冻结结论不变；本轮仍属于 M1，没有提前开始 M3。T1 只证明 admission 与逻辑 credential/data fence，不能宣称 tenant erasure completed，也不能据此正式冻结 M1。
- 下一独立切片是 tenant erasure T2：增加独立 platform authority、内部/管理 API、status/replay、全 fleet code-aware barrier 和安全 rollout 契约；该 authority 必须使用新入口，不能绕过本轮已封住的 tenant-key governance 方法。随后 T3 增加 durable worker、物理 credential/auth-secret 清理、tenant 内容清理与 completion proof。旧 runtime 不理解 `0018` fence，因此 T2 barrier 完成前不得在 mixed-version fleet 调用 T1。
- T1 不强制中断 admission 前已经发出的 provider/JWKS/introspection 网络 I/O；解密后的 secret 或 verifier 也可能暂留在进程内存，需通过 drain/restart、短缓存和后续 secret/KMS adapter 收口。migration 的 FORCE INDEX 会验证关键列和命名索引，但不会证明特权主体预建同名表的全部 engine/unique shape，生产仍需 migration identity、runtime 最小权限和 schema attestation。
- 多 runner 同时首次启动时，现有 `ADMIN_BOOTSTRAP_TENANT` 的 list-then-create 仍可能生成多个 admin key；这是基线已有的 M4 运维风险，后续应改成一次性 Job/CLI 或数据库 singleton claim。完成 tenant T2/T3 后，M1 仍需可信数据库时间、完整 owner-scan content receipt、ready Blob/session/receipt/Redis destructive executor、completed proof 与独立故障域 restore replay，全部闭环后才进入 M3。

## 2026-10-09（M1 数据生命周期：tenant erasure T2 platform control）

### 已完成

1. router 新增 platform-only `POST /v1/tenant-erasure-requests` 与 owner-hiding status GET；OpenAPI 3.1 和生成 TypeScript SDK 提供独立的窄化 platform client。该入口只接受与 tenant service/admin key 完全独立的 bearer，router-only operator token/id 不会进入 runner；runner 配置发现这两个变量会拒绝启动，本地脚本、verify 与 cluster harness 也在子进程边界显式清除。
2. router 会先移除全部客户端 `x-agent-service-*`、hop-by-hop/framing header，并拒绝通过大小写、空白、重复/合并 Authorization 或 percent/double-percent 编码路径把 platform token 带入普通代理。只有显式 allowlist 的版本化私有控制路由才重新注入 `INTERNAL_ROUTER_TOKEN` 与固定 operator id；上游状态、固定 ACK、响应 schema 和 tenant/request identity 全部核对后才向公网返回。
3. 新 admission 采用两层 gate 和 fresh all-configured fleet barrier：router 必须开启 writer gate，且全部 configured stable runner 当前健康、声明 `platform-control-v1` 并开启 local gate；选中的 runner 在提交不可逆 T1 事务前再次向 router 查询 barrier。target 缺失、陈旧、不可达、版本不兼容、ACK 错误或任一 local gate 关闭都会返回可重试 `503`，不会提交部分状态。
4. router 在 fresh registry snapshot 后将请求冻结成 `admit | replay | status` 判别模式，并由模式内部派生 method、私有 path、ACK、capability 和允许状态，避免 gate 在请求中途变化时把 replay 升格为 create。关闭 writer gate 后，精确匹配已提交 raw tenant、`Idempotency-Key` 与 body hash 的 POST 只走独立 read-only replay 路径并返回同一 `202`；未知 tenant/key 返回 `503`，hash 冲突返回 `409`，绝不建立 admission。
5. Store 增加 tenant erasure replay/status proof：Memory 复制读取，MySQL 使用一致性 snapshot，并同时验证 admission、tenant lifecycle、credential fence 与首条 content-free audit。proof 缺失、损坏或身份不一致统一 fail closed；公开状态当前固定为 `gated`，没有暗示 worker 或物理删除已经完成。
6. tenant 和 idempotency key 的语义是原始字符串精确相等。MySQL 即使底层 `utf8mb4_0900_as_cs` 把 NFC/NFD 等 Unicode 变体视为等价，查询后仍会比较原始值；registry alias 会以 target-not-found 回滚，replay alias 不会命中，也不会留下 lifecycle/admission/audit/fence 残留。相同 key 仍按 tenant 隔离。
7. 真实多进程 cluster 新增同一可丢弃 MySQL 的滚动重启证明：gate-on 两 runner 提交后，以 gate-off 两 runner 重启，精确重放仍得到同一 `202`，不同 key/tenant 均为 `503`，数据库始终只有一套 admission/audit/fence。公开 OpenAPI 明确以 router 为 authority；runner 的 `/openapi.json` 只是构建兼容镜像，不授权绕过 router 访问私有路由。
8. README、架构/生命周期设计、local/deployment runbook、AGENTS/CLAUDE 与长期学习指南已同步。学习指南集中回答本地完整启动/手动体验、router/runner 职责、Node 24 ESM bundle 与 Linux OCI image 的区别、GitHub Actions 的 build/image 门禁，以及 local → staging → production promotion 同一不可变 image digest 的流程。

### 本轮验证与审查

- `scripts/local-service.sh verify` 全链通过：`pnpm check:secrets` 扫描 **279 files**，OpenAPI 生成检查与 `pnpm typecheck` 通过；主套件 **997 passed / 1 skipped**，唯一 skip 仍是真实厂商 E2E 的显式付费开关。覆盖率 **83.65% statements / 79.16% branches / 87.22% functions / 87.27% lines**，MySQL store lines **86.20%**。
- 固定 **11** 个真实 MySQL 历史迁移文件 **47/47**；`0007 → 0008` 必跑夹具 **2/2** 继续证明相同 usage 重复安全合并、内容冲突阻断且不丢账、legacy pending receipt 保留。tenant credential named MySQL **16/16**、并发矩阵 **9/9**，required wrapper 明确证明目标文件执行且零 skip。
- 真实 MySQL/Redis 的多进程 cluster **17/17**，其中包含 gate-on commit 后共享数据库 gate-off 重启 replay；SDK 隔离 consumer 的 **18-file** package 通过。runner **2795 KB**、router **760 KB** 两个独立 Node bundle 均完成构建，并以原生 Node 验证启动、readiness、tenant/platform auth 边界、转发和 OpenAPI。
- 从并发正确性、事务回滚、滚动升级兼容、安全隔离和测试有效性复核，补齐了 replay-only mode 冻结、私有 ACK/响应校验、platform credential 子进程隔离、Unicode raw identity、防止 encoded-path/header smuggling、损坏 proof generic fail-closed 与真实 cluster 恢复路径。本轮未改变 provider dialect 或真实厂商网络契约，因此没有重复运行收费的 `verify-real` 或十阶段 acceptance；最近真实模型 **1/1** 与 acceptance 通过仅保留为历史基线，不冒充本轮结果。

### 当前边界与下一步

- M2 的本地/CI 代码范围仍保持正式冻结；本轮属于 M1，没有开始 M3。T2 platform control 的 local/CI 范围已完成，但 durable request 仍停在不可逆 `gated` 状态，不是 tenant 已物理删除或 erasure `completed`，因此 M1 尚不能冻结。
- 下一独立切片是 tenant erasure T3：设计并实现 durable worker、物理 API key/provider credential/auth-secret 清理、tenant-owned content 清理与可验证 completion proof。它必须复用当前 admission/fence authority，保持 user-erasure、export pin、legal hold、usage/receipt 与 Blob 生命周期的事务和并发边界，不能直接把 T1/T2 的 `gated` 改写成 completed。
- T3 之后仍需可信数据库时间、完整 owner-scan `session_content_receipts`、ready Blob/session/idempotency receipt/Redis 的物理清理、provider/JWKS/introspection 已发出 I/O 与进程内 secret 的 drain/restart 收口，以及独立故障域 restore-ledger replay。上述 M1 生命周期 proof 闭环后才正式进入 M3；M3 完成后再推进 M4 尚缺的生产可观测性、限流/配额、灾备和部署自动化。
- 没有云资源不阻止继续实现并验证上述 local/CI 代码范围；但真实共享对象存储、KMS/Secret、registry、Kubernetes/VM 拓扑、云 MySQL/Redis、域名/TLS、备份恢复和 staging/production rollout 必须等待真实环境参数，不能编造，也不能把本地门禁表述为已完成云部署。

## 2026-10-09（M1 数据生命周期：0019 tenant erasure T3a local credential-store revocation）

### 已完成

1. 新增expand-only的`0019_tenant_credential_physical_revocation.sql`：独立`tenant_credential_revocation_jobs`、immutable aggregate receipts与write-once cutover不复用user-erasure queue。migration只安装schema/index/guards和inactive singleton，不扫描`0018` admission、不回填job、不claim、不删除credential/content，也不激活cutover。
2. 新tenant admission与T3a job在原T1 Memory staged publish/InnoDB事务内原子创建；升级前已提交的`0018` admission只由显式materializer补job，并先验证admission、tenant lifecycle、首条content-free audit与credential fence完整proof。损坏或Unicode raw identity alias均fail closed，不会猜测owner或制造queue authority。Memory publication fault和真实MySQL最后一步job INSERT故障均证明lifecycle、admission/idempotency、audit、fence与job整体回滚。
3. Memory/MySQL最小权限store增加DB-time claim/renew/retry、attempt+token+lease ABA防护和claim-bound完成。renew/retry/block在取得job锁后读取数据库时间；物理事务在取得tenant、cutover及credential范围全部可能等待的锁后再次读取DB clock并复核lease，过期worker不能以等待前时间跨过首个DELETE。完成事务按固定锁序删除目标tenant的全部`api_keys`行（包括已revoked verifier）和全部`provider_configs`行，清空`tenants.auth_policy/auth_secret_cipher/auth_secret_key_id`，重扫确认post-state为零，再同事务写receipt、完成job并在首个receipt激活cutover；任一序列化/SQL/receipt/job/cutover失败全部回滚。
4. receipt的scope固定`local-db-credential-material-v1`，只保存计数、布尔post-state、DB commit time与单向proof hash，不复制key hash/id、provider id/config/header、auth policy/cipher/key-id或claim token。它固定声明`runtimeDisposition=not_in_scope`、`externalDisposition=not_supported`、`contentPurgeRequired=true`；响应丢失只允许精确completed claim attempt/token hash重放，不能从当前已为空推断成功。
5. runner内嵌`TenantCredentialRevocationWorker`，不新增第三个服务、进程或镜像。`TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED`与router的`TENANT_CREDENTIAL_REVOCATION_EXECUTION_ENABLED`独立默认关闭；worker在materialize/claim以及紧邻不可逆事务前都取得token-protected fresh all-configured ACK。capability区分`tenantCredentialRevocation=["credential-store-v1"]`代码感知与`tenantCredentialRevocationWorker`实际激活，`dataPurgeExecution`仍固定`false`。
6. T3a安全rollout已写入契约：`0019` expand → 新router execution=0并排空旧router → 全量新runner worker=0 → 逐runner开启worker → 核对全部configured稳定地址健康、code-aware且worker-active → 最后开启router execution。首个receipt激活cutover后不得回退pre-`0019` writer/worker，只能forward-fix；admission gate与execution gate分离，使关闭新POST后已有job仍可推进。
7. provider/auth配置进一步拒绝URL userinfo，避免credential落入base URL、JWKS或introspection URL；语法错误的URL只返回固定错误，不再把可能含credential的原输入反射到API响应或log-adjacent消息。公开tenant status刻意保持`gated`；T3a不删除tenant registry/content，不清理runtime cache/verifier，不中断已发出的provider/JWKS/introspection I/O，不撤销external provider/KMS，也不形成tenant completion proof。
8. 冻结`mysql-0018.sql`并新增独立`0018 → 0019`真实MySQL夹具；历史wrapper、CI named suite、主JSON no-skip断言、local verify和runner image最新migration marker均已接线。候选发布物仍只有两个Node 24 ESM bundle和两个Linux OCI image（router/runner），没有新增tenant worker镜像。
9. global cutover proof在首次DELETE前完成：generation 0同时要求receipt与`credential_store_revoked` terminal job为空；generation 1从cutover hash精确找到首receipt，再绑定对应terminal job、completion proof及immutable T1 admission/首audit/fence。terminal proof不再依赖未来会合法推进/清理的mutable lifecycle；queued/blocked读取与所有queue/destructive authority仍要求live `deleting` lifecycle。Memory与真实MySQL故障态覆盖orphan receipt/terminal job、首receipt或job缺失、job不匹配、immutable T1 source损坏、lifecycle重置拒权，以及首tenant推进`erased`/projection清理后下一tenant继续；失败不会部分改写credential、receipt或cutover。

### 本轮验证与审查

- `pnpm check:secrets`通过并扫描 **290 files**；`pnpm check:api`、`pnpm check:sdk`、`pnpm typecheck`与`git diff --check`通过，生成OpenAPI/SDK无漂移，SDK真实 **18-file** package完成隔离安装、runtime import和TypeScript验证。
- tenant credential相关Memory套件 **24/24**（其中physical **11/11**；连同core worker共 **32/32**）；named真实MySQL admission **17/17**、race **9/9**、physical **18/18**，required wrappers和主JSON report明确证明目标文件实际执行且零skip。core credential worker **9/9**；完整auth-hardening **26/26**，包含malformed credential URL不回显原值。
- 固定 **12** 个历史MySQL迁移文件 **55/55**，其中`0018 → 0019` **8/8**；`0007 → 0008`的相同usage重复安全合并、内容冲突阻断且不静默丢账、legacy pending receipt保留仍在同一必跑链中。
- `scripts/local-service.sh verify`主套件 **1046 passed / 1 skipped**；唯一skip是真实厂商E2E显式付费开关。覆盖率 **83.51% statements / 79.20% branches / 87.11% functions / 87.06% lines**，MySQL store **86.17% lines**；cluster **21/21**。runner **2928 KB**、router **766 KB** 两个独立Node 24 bundle、SDK package、readiness、tenant/platform auth边界、转发与OpenAPI门禁全部通过。
- 从并发正确性、事务回滚、滚动升级兼容、安全隔离和测试有效性独立复核；global proof位于cutover锁后、首个DELETE前，锁序无反向依赖，双tenant真实并发、锁等待越过lease、队头job行锁跳过、late SQL fault和job INSERT故障均命中目标路径。无P0/P1/P2合并阻塞。保留三项已记录P3/运维风险：`erasure_audit_events`当前没有数据库UPDATE/DELETE guard，runtime也没有相应mutation API，缺失/篡改会fail closed但可能造成proof DoS，T3b不得清理首audit，后续migration或独立commitment应收紧该特权DB边界；确定性损坏的最早T3a candidate当前会回滚整批并在重试时继续阻断健康邻居，不能无审计地catch-and-skip，后续应以逐候选事务和durable incident/quarantine隔离后再推进邻居；exact job使用`SKIP LOCKED`，但候选lifecycle/T1 proof行被外部X锁长期占用时仍可能等待到数据库lock timeout。以上都不生成错误删除authority，但会形成fail-closed可用性/特权损坏DoS。claim使用每轮32–400候选的有界keyset overscan；真实MySQL回归精确覆盖旧`limit=1`窗口全锁、邻居推进和无重复authority，但尚未单独执行第二页cursor或超过扫描上限的长期锁队列，后者是明确的吞吐/下一poll延迟取舍而非删除权限缺口。本轮未改变provider dialect或真实厂商网络契约，因此未重复运行收费的`verify-real`或十阶段acceptance；最近真实模型 **1/1** 与acceptance通过只保留为历史基线，不冒充本轮结果。

### 当前边界与下一步

- M2冻结结论不变；本轮仍属于M1，没有开始M3。T3a只是本地数据库credential material清除，不能把tenant公开状态改成completed，也不能把receipt当作runtime、external、content或backup proof。
- 下一独立切片是T3b runtime/cache/active-I/O drain：按tenant撤销进程内end-user auth policy/JWT/JWKS/introspection verifier cache和provider注册/secret引用，有界处理中或已发出的provider/JWKS/introspection I/O，并形成可由fleet验证的完成证明；service API key当前每次从store解析，没有进程级verifier cache。之后才继续可信数据库时间、owner-scan `session_content_receipts`、ready Blob/session/idempotency receipt/Redis清理、usage匿名化、completion与独立故障域restore-ledger replay。
- 没有云资源不阻止继续完成上述local/CI代码范围；但M4的共享对象存储、KMS/IAM、registry/promotion、Kubernetes/VM拓扑、云MySQL/Redis、域名/TLS、备份恢复与真实告警集成必须等待实际资源。日常应每个安全切片先跑smoke/定向验证，整体架构local/CI范围完成后再做完整手动walkthrough，不必为获得反馈一直等到M3/M4全部结束。

## 2026-10-09（M1 数据生命周期：0020 tenant erasure T3b configured-fleet runtime drain）

### 已完成

1. 新增expand-only的`0020_tenant_runtime_revocation.sql`：独立runtime job、每个configured target的append-only receipt及aggregate receipt均与user queue和T3a job分离。migration不扫描/回填`0019` proof、不发网络请求、不执行drain、不改写T3a evidence，也不删除content；runner内嵌worker只在完整验证T1 fence、T3a terminal receipt和live tenant lifecycle后显式materialize。
2. runner新增单一per-tenant runtime coordinator。它在本地同步fence新auth/provider/turn操作，abort并等待已接纳fetch、response body和turn settle，再清空TenantPolicyCache、JWT/JWKS/introspection verifier、tenant BYOK provider registration及SessionHost引用；初始snapshot或任一participant hook异常时仍best-effort fence全部participant并abort全部lease。超时、non-cooperative I/O或response-body cancel未完成都会保持tenant fenced并拒绝成功proof。
3. 内部私有`runtime-drain-v1`协议由固定ACK、严格schema和request/target/local/fleet proof hash绑定。router只对`RUNNERS`中每个稳定直连实例origin执行fan-out，前后fresh探测并要求runnerId/bootId不变且全fleet唯一；不使用healthy subset、hash owner、sticky旧观察或LB别名。任一target失败时整体返回`503`且不生成fleet proof，但先前target可能已被fence，故只能forward-fix并精确重试。
4. Memory/MySQL store使用attempt+token+lease防ABA，以数据库时间claim/renew/retry/block/complete；完成边界原子写全部target receipt、aggregate receipt和terminal job，任一SQL/terminal transition失败整体回滚。响应丢失只允许相同completed attempt/token且逐target原proof完全一致时重放，不能凭aggregate hash、当前空缓存或已移除lifecycle推断成功。
5. receipt scope固定`configured-fleet-runtime-v1`，target URL、runnerId和bootId只保存SHA-256。它明确声明`memoryDisposition=references_dropped_not_zeroized`、`externalDisposition=not_supported`、`contentPurgeRequired=true`；不覆盖lifecycle/Blob/export/background store I/O、Redis/session lease、远端provider副作用、外部provider/KMS、content/usage/receipt/backup purge，也不把JavaScript字符串引用释放描述为物理清零。公开tenant status继续为`gated`，`dataPurgeExecution=false`。
6. 三道独立gate均默认关闭：runner私有endpoint `TENANT_RUNTIME_DRAIN_ENABLED`、runner worker `TENANT_RUNTIME_REVOCATION_WORKER_ENABLED`、router fan-out `TENANT_RUNTIME_DRAIN_EXECUTION_ENABLED`。安全rollout为`0020` → execution=0的新router并排空旧router → endpoint/worker=0且稳定`RUNNER_ID`的新runner → 逐实例开endpoint并核对direct origins/identity → 开worker → 最后开router execution；紧急回滚先关router execution，不能撤销已提交fence/receipt或回退不理解T3b的binary。
7. 冻结真实`0019` delta并新增独立`0019→0020`历史MySQL夹具，覆盖T3a证据逐字节保持、无隐式runtime job、explicit materializer、first-table partial DDL收敛、marker-loss replay及append-only guards。CI、本地verify、suite-executed断言和runner image最新migration marker均已接线。T3b worker仍内嵌runner，候选发布物仍只有router/runner两个Node bundle和两个Linux OCI image。
8. 学习指南和运维runbook继续作为本地启动/手动体验、模块职责、Node bundle与Linux OCI image、GitHub Actions构建门禁，以及local→staging→production promotion流程的集中材料；没有伪造尚不存在的Kubernetes、registry、KMS/Secret、对象存储、域名/TLS或云数据库参数。

### 本轮验证与审查

- `scripts/local-service.sh verify`全链通过：`pnpm check:secrets`扫描 **309 files**，OpenAPI/SDK漂移检查与`pnpm typecheck`通过；主套件 **1101 passed / 1 skipped**，唯一skip仍为显式付费的真实厂商E2E。覆盖率 **82.98% statements / 79.01% branches / 86.04% functions / 86.44% lines**，MySQL store **85.54% lines**。
- T3b named真实MySQL套件 **6/6**，明确覆盖exact terminal replay、并发claim/ABA、`SKIP LOCKED`邻居推进、跨job-lock wait后的数据库时钟/lease复核、terminal transition故障时target+aggregate整体回滚和live lifecycle fail-closed。required wrapper与JSON report证明目标文件实际执行且零skip。
- 固定 **13** 个真实MySQL历史迁移文件 **59/59**，其中`0019→0020` **4/4**；`0007→0008`的相同usage重复安全合并、冲突重复阻断且不丢账、legacy pending receipt保留继续在同一必跑链中。
- cluster **23/23**；其中T3b覆盖真实router进程加两个独立HTTP runner私有协议fixture的exact-target/boot proof和disabled-endpoint fail-closed，不把它夸大为两个完整runner进程的T2→T3a→T3b端到端链。SDK **18-file**隔离包通过；runner **3123 KB**、router **797 KB**两个Node 24 bundle完成原生启动、readiness、tenant/platform auth边界、转发和OpenAPI检查。
- 从并发正确性、事务回滚、滚动升级兼容、安全隔离和测试有效性进行两轮独立审查，最终无开放P0–P2。审查补齐了aborted/非2xx/redirect响应体必须settle后再释放operation lease、coordinator异常路径仍完整fence/abort，以及terminal response-loss replay逐target精确匹配。
- 本轮没有改变provider dialect或公开真实模型契约，因此未重复运行会产生费用的`verify-real`或十阶段acceptance；最近真实模型 **1/1** 与acceptance通过仍只作为历史基线，不冒充本轮结果。

### 当前边界与下一步

- M2冻结结论不变；本轮仍属于M1，没有开始M3。T3b完成configured-fleet本地runtime/cache/已跟踪active-I/O证明，但tenant公开状态仍不是completed，M1尚不能冻结。
- 下一独立切片是T3c：以可信数据库时间建立deadline线性化，并通过owner-scan生成完整`session_content_receipts`及destructive purge所需的content-free durable substrate。之后仍需ready Blob/session/idempotency receipt/Redis物理清理、usage匿名化、external provider/KMS撤销、tenant completion和独立故障域restore-ledger replay；这些闭环后才正式进入M3。
- `RUNNERS`必须完整列出全部可接流量runner的稳定直连实例origin；隐藏副本的LB会破坏proof边界。当前fence在该进程生命周期内不可逆，restore replay尚未实现；内部token在云环境还需要TLS、网络策略和Secret轮换。自定义timeout必须保持local drain小于router上游/worker请求预算。
- 没有云资源不阻止继续实现上述local/CI代码范围，也不要求等M3/M4全部完成才做阶段性手动体验；但整体架构本地/CI范围全部完成后再做一次系统性完整walkthrough会更稳定。真实共享对象存储、KMS/IAM、registry/promotion、Kubernetes/VM拓扑、云MySQL/Redis、域名/TLS、备份恢复和告警集成必须等待实际资源，不能把本地proof表述为云部署完成。

## 2026-10-09（M1 数据生命周期：0021 tenant erasure T3c non-destructive content inventory）

### 已完成

1. 新增expand-only、destructive-dormant的`0021_tenant_content_inventory.sql`：独立`tenant_content_inventory_jobs`、append-only `session_content_receipts`与tenant aggregate receipt不复用user queue、0016 evaluator或T3a/T3b job。migration不扫描terminal T3b、不回填job、不读取/复制正文、不匿名化usage、不删除session/Blob/receipt/Redis数据，也不推进公开status或授予purge authority。
2. migration对engine/collation/no-partition、精确列顺序/类型/default/charset/extra/generation、ENFORCED CHECK、完整index type/visibility/column-or-expression/prefix/direction和精确trigger set做fail-fast fingerprint，并保存/恢复session `group_concat_max_len`。queued未claim要求`available_at_ms >= updated_at_ms`，claimed要求`lease_until_ms >= updated_at_ms`；retry永久guard保持availability单调。partial/manual同名schema不兼容时阻断升级，不猜测修复或静默覆盖。
3. Memory/MySQL最小权限store增加显式materialize、DB-time claim/renew/retry/block、分页build、seal与exact replay。materializer只消费完整T1/T3a/T3b terminal proof和T1绑定的immutable policy；retention anchor必须不小于T3a credential receipt与T3b runtime receipt两个数据库时间的最大值，不能假设T3b时间一定更晚，也不使用T1 runner wall clock。DB time低于source high-water、既定anchor或已写page evidence时分别返回可重试的`trusted_clock_before_source`、`trusted_clock_before_anchor`、`trusted_clock_before_evidence`，不会错误进入terminal integrity block。
4. per-session roots绑定content-free identity、生命周期状态与关系拓扑。实现schema-parse持久化turn/item/event/approval body并核对索引列，验证tenant/user owner、parent DAG、连续event seq、事件引用、terminal tombstone双向关系及最后seq。`contextCompaction`是唯一允许synthetic `turnId`且无turn row的item；如果同ID turn存在仍须同owner。approval canonical边固定为唯一、同session/turn且toolCall/name一致的`approvalRequest.approvalId → Approval.id`；legacy `Approval.itemId`允许不同，作为历史字段进入hash但不是canonical外键。正文、user id、Blob/storage locator和raw claim token均不进入receipt。
5. page事务在全部session receipt INSERT后重新读取DB time并复核attempt/token/live lease；等待跨越lease时，已插receipt、cursor、count/root和job update整事务回滚。seal显式设置`REPEATABLE READ`，重扫并复算tenant所有session receipt，对五类全局content关系取得共享next-key/gap locks以关闭orphan插入窗口，再核对tenant及全部已知user的canonical legal-hold ledger。pre-insert `finalNow`同时写入aggregate `storeDbTimestampMs`和job `inventorySealedAtDbMs`；aggregate INSERT后的`publishNow`只重验lease并单调抬高`updatedAtMs`，过期时aggregate与terminal transition一起回滚，completion proof时间保持一致且可重放。
6. runner内嵌`TenantContentInventoryWorker`，不新增第三个服务、进程、router端点或镜像。`TENANT_CONTENT_INVENTORY_WORKER_ENABLED`及poll/lease/batch/page/retry配置默认关闭并已接入配置校验、启动/停机、本地脚本和日志。安全rollout是`0021` → 全量新runner worker=0 → 核对strict schema/guards/new binary → 逐实例开启worker；关闭只暂停新claim，首个evidence提交后必须保留schema并forward-fix。
7. 冻结真实`0020` delta并新增独立`0020→0021`历史MySQL夹具；它证明T1/T3a/T3b evidence与业务内容逐字节保留、migration不隐式materialize或执行扫描/删除，并覆盖first-table partial DDL、marker-loss replay、append-only guards、queued clock invariant、错误approval/job/prefix index、非InnoDB engine、弱化CHECK、额外敏感列与额外trigger的fail-fast。CI、本地verify、required-suite manifest/no-skip断言和runner image最新migration marker均已接线。

### 本轮验证与审查

- `scripts/local-service.sh verify`全链通过：`pnpm check:secrets`扫描 **317 files**，OpenAPI/生成SDK漂移检查与`pnpm typecheck`通过；主套件 **1148 passed / 1 skipped**，唯一skip仍是真实厂商E2E显式付费开关。覆盖率 **82.77% statements / 78.80% branches / 86.29% functions / 86.17% lines**，MySQL store **85.17% lines**。
- T3c Memory **16/16**；Memory/core worker/runner config+main定向合集 **52/52**；named真实MySQL T3c **23/23**。真实InnoDB明确覆盖source/evidence clock rollback、MAX_SAFE deadline/lease、contextCompaction、legacy approval compatibility、valid-to-valid topology swap、并发claim/ABA、RR phantom/range lock、阻塞receipt/aggregate INSERT跨lease后的全事务回滚、SQL故障、exact replay和跨tenant隔离；required wrapper证明目标文件实际执行且零skip。
- 固定 **14** 个真实MySQL历史迁移文件 **70/70**，其中`0020→0021` **11/11**；`0007→0008`的相同usage重复安全合并、内容冲突重复阻断且不丢账、legacy pending receipt保留继续位于同一必跑链。
- cluster **23/23**；SDK **18-file**隔离包通过；runner **3390 KB**、router **797 KB**两个Node 24 bundle完成原生启动、readiness、tenant/platform auth边界、转发与OpenAPI检查。候选发布物仍只有router/runner两个Node bundle和两个Linux OCI image。
- 从并发正确性、事务回滚、滚动升级兼容、安全隔离和测试有效性完成独立实现/迁移/安全复核，最终 **P0=0、P1=0、P2=0**。审查重点确认post-write lease authority、seal/aggregate时间戳等式、Memory/MySQL MAX_SAFE与clock rollback一致性、strict migration fingerprint和queue时间不变量。
- 本轮没有改变provider dialect或公开真实模型网络契约，因此未重复运行会产生费用的`verify-real`或十阶段acceptance；最近真实模型 **1/1** 与acceptance通过仍只作为历史基线，不冒充本轮结果。

### 当前边界与下一步

- M2冻结结论不变；本轮仍属于M1，没有开始M3。T3c aggregate固定`contentInventoryComplete=true`、`contentPurgeExecuted=false`，公开tenant status仍为`gated`、`dataPurgeExecution=false`；它不是删除许可，也不证明ready Blob、usage、idempotency/Redis/export/backup、external provider/KMS或restore已清理。
- 保留三个非阻断P3/运维风险：结构损坏的`tenant_content_inventory_jobs` envelope可能在claim-bound隔离前解析失败，反复终止poll并饿死健康job；该路径fail-closed且不会产生receipt/purge authority，但当前需人工数据库维护，M4应增加不信任损坏字段的raw-key quarantine/skip。materializer keyset cursor是进程内状态，重启会重扫损坏前缀。seal的全库五表RR/next-key扫描会带来容量、跨tenant写阻塞和lease压力，M4必须以owner索引/FK/分区或等价机制替代并压测；runtime DB principal也必须禁止DDL/TRUNCATE。
- 下一独立切片应先设计并实现默认关闭、最小权限的destructive lifecycle执行/完成协议：在执行边界重验0016与0021、canonical hold和owner关系，原子协调operational usage匿名化、ready Blob/session/idempotency receipt/Redis清理及可验证ACK；external provider/KMS与独立故障域backup/restore replay要保留明确适配器和fail-closed占位，不能用本地假参数伪造完成。只有这些proof闭环后才可把tenant推进到completed、正式冻结M1并进入M3。
- 没有云资源不阻止继续完成上述local/CI代码、Memory/MySQL/Redis/fake adapter、故障注入和部署契约；但共享对象存储、KMS/IAM、registry/promotion、Kubernetes/VM拓扑、云MySQL/Redis、域名/TLS、真实备份恢复和告警集成必须等待实际资源。整体本地/CI架构完成后再做一次系统性完整手动walkthrough会更稳定，阶段性smoke/定向体验仍应持续进行。

## 2026-10-09（M1 数据生命周期：0022 tenant erasure T3d non-destructive full-domain purge plan）

### 已完成

1. 新增expand-only、execution-dormant的`0022_tenant_purge_plan.sql`：独立`tenant_purge_plan_jobs`、固定catalog的append-only `tenant_purge_plan_entries`与tenant aggregate receipt。migration不扫描或回填terminal T3c、不调用外部adapter、不匿名化usage、不删除session/Blob/receipt/Redis数据，也不推进公开status、开放`session.purge`或授予destructive authority。
2. 固定33域覆盖tenant registry/profile、agent/session/idempotency、operational与billing usage、Blob manifest/bytes/outbox、lifecycle outbox、user export control/snapshot/artifact/bytes、user erasure/policy/governance/hold证据、T1/T3a/T3b/T3c证据、Redis lease/fence/stream、external provider、KMS、backup/restore ledger以及logs/traces。每域只能保存target count/root、固定disposition、source hash和DB capture time；正文、user id、credential、locator和raw claim token都不能进入entry。
3. 缺失能力必须显式阻断，不能伪装为空目录。Blob/export bytes、Redis三域、backup、restore、logs/traces固定形成9个blocker。T3a receipt不保留provider secret/BYOK-KMS细分：provider/auth均为零时external-provider与KMS才可`not_applicable`；仅tenant auth envelope非零时KMS域改为`blocked_legacy_external_source_unavailable`，合计10个；任一provider config非零时external-provider与KMS两域都必须阻断，无论是否同时有auth，合计11个。计划仍可完整seal，使运维看见准确缺口，但永远不因此获得执行许可。
4. Memory/MySQL最小权限store实现proof-checked materialize、DB-time claim/renew/retry/block、atomic seal、validated read和exact response-loss replay。生产worker对新空plan直接seal：Memory在单一原子边界、MySQL在单个显式REPEATABLE READ事务内重验T1/T3a/T3b/T3c source、immutable policy、canonical tenant/全部user hold、全局孤儿与owner闭包、DB clock与claim lease，再一次性写全部33条entry、aggregate receipt和terminal job。MySQL对idempotency/usage/reconciliation取full-range锁直到提交，关闭scan后的phantom插入窗口；legacy completed idempotency `{turnId}`必须能经真实turn反查同一session，subject lifecycle与user request/tenant admission必须双向闭合，purge target必须精确匹配session tombstone generation/time。最后一个可能阻塞的写入后lease失效会使整批回滚。分页build仅保留为诊断/兼容路径，不由生产worker调用；partial entry不是sealed authority。
5. aggregate固定`planComplete=true`、`executionReady=false`、`contentPurgeExecuted=false`。`planComplete`只表示33域、blocker、root与source binding完整；store和worker类型均没有delete/anonymize/revoke/completion方法，公开tenant status与protocol capability保持`gated`/`dataPurgeExecution=false`。
6. runner内嵌`TenantPurgePlanWorker`，不新增第三个服务、进程、router端点或镜像。`TENANT_PURGE_PLAN_WORKER_ENABLED`及poll/lease/batch/retry配置默认关闭；安全rollout是`0022` → 全量新runner worker=0 → 核对strict schema/index/CHECK/trigger fingerprint、append-only guards和new binary → 逐实例开启worker。关闭只暂停新materialize/claim，已提交证据只能forward-fix。
7. 冻结真实`0021` delta并新增独立`0021→0022`历史MySQL夹具，覆盖T1/T3a/T3b/T3c evidence与业务数据保持、无隐式plan或destructive side effect、first-table partial DDL收敛、marker-loss replay、receipt completion固定false、错误index/额外敏感列、弱化CHECK和额外trigger的fail-fast。CI、本地verify、required-suite/no-skip断言与runner image最新migration marker均已接线；候选发布物仍只有router/runner两个Node bundle和两个Linux OCI image。

### 当前验证与审查状态

- T3d atomic-seal最终实现的Memory/core/runner定向为**54/54 passed**，named真实MySQL为**14/14 passed**，后者还通过writer `CONNECTION_ID()`与`performance_schema.data_lock_waits`证明full-range锁等待确实持续到seal commit。测试矩阵覆盖固定33域、9/10/11 blocker分支（包括provider-only在Memory与真实MySQL中仍必须同时阻断external-provider/KMS）、tenant/user hold、全局孤儿/owner闭包fail-closed、legacy completed idempotency `{turnId}`兼容、双向lifecycle↔request/admission、精确purge-target tombstone generation/time、真实MySQL full-range phantom阻断、T1后仍合法queued且build generation为`0`的export被计入而非误判为已撤销、download lease token仅以domain-separated hash进入证据、并发唯一claim、ABA、source/topology漂移、atomic seal中阻塞写跨lease的整事务回滚、exact terminal replay、错误tenant隔离，以及不修改源数据/公开状态。
- `scripts/local-service.sh verify`完整通过（exit 0）：`pnpm check:secrets`扫描 **325 files**，OpenAPI/生成SDK漂移检查与`pnpm typecheck`通过；主套件 **88 files passed / 1 skipped、1186 passed / 1 skipped**，唯一skip仍是真实厂商E2E显式付费开关。覆盖率为 **82.05% statements / 77.92% branches / 86.19% functions / 85.39% lines**，MySQL store **84.74% lines**。
- 固定历史升级链从`0007`运行到`0022`，共 **15 files / 77 passed**；`0007→0008` **2/2**继续证明相同usage重复安全合并、冲突重复阻断且不丢账、legacy pending receipt保留，新增`0021→0022` **7/7**。required MySQL suites均由JSON proof确认目标文件实际执行且无skip；cluster为 **6 files / 23 passed**。
- SDK archive含 **18 files**；runner/router原生Node bundle约 **3725 KB / 797 KB**，dist启动、readiness、auth、转发与OpenAPI深比较全部通过。
- 已从并发authority、事务回滚、滚动升级、安全隔离和测试有效性复核T3d边界；独立最终树复核确认原legacy compensation job/source owner-closure P2已关闭，当前无开放P0–P2。保留五类P3/运维风险：全库RR/next-key owner扫描在规模下的跨tenant写阻塞/死锁/lease/容量压力需staging验证；结构损坏的queued purge-plan envelope可能在逐候选隔离前饿死后续job，cursor重启还会重扫损坏前缀，但fail-closed且不产生receipt/执行权；可修复的全局orphan/cross-owner损坏会使claim永久`blocked`，修复后没有自动resume/operator workflow；`0022` trigger fingerprint绑定集合/元数据但不校验action body；迁移夹具只显式模拟首个DDL auto-commit边界。后两者属特权schema tamper/测试深度残余。GitHub Actions结果仍待提交推送后的远端run确认，不能提前沿用或编造。

### 当前边界与下一步

- 本轮最终owner-closure加固还覆盖Memory的export/user-erasure/tenant-admission request↔idempotency双向索引，以及Memory/MySQL legacy compensation deterministic `jobId`↔精确session owner/tombstone generation/time。MySQL还重算`candidateSha256`并校验`sourceLastSeq`，`erasure_claim`必须精确绑定request/generation，job status必须对应唯一匹配的audit/result，completed event seq必须等于`session.lastSeq`且success evidence完整；反向索引缺失、跨owner、错误source generation或完成proof矛盾都必须fail closed并保持atomic seal零部分发布。有效回归使用T3c可接受的completed fixture进入该闭包，而不是被旧generation-zero前置guard提前拦截。
- 全局orphan/cross-owner损坏当前会使claim终结为`blocked`，不产生receipt或执行authority；但修复底层数据后没有自动resume/rebuild，可永久阻塞该tenant。后续需设计绑定完整性复验和审计证据的operator repair/resume协议，不能直接SQL改job/evidence。
- M2冻结结论不变；本轮仍属于M1，没有开始M3。T3d解决的是“所有已知域都必须被列出并说明处置/阻断原因”，不是“已经可以删除”。9、10或11个blocker恰好证明本地环境不能冒充云adapter、外部撤销或restore replay已经就绪。
- 下一独立切片仍需设计默认关闭、最小权限的destructive execution/ACK saga：在执行边界重新验证0016、T3c、T3d、canonical hold、owner关系和DB-time deadline，再分别取得usage匿名化、ready Blob与export bytes物理删除、session/idempotency/lifecycle/Redis清理等本地可验证ACK。external provider/KMS、共享对象存储、backup/restore、logs/traces必须由真实adapter提供proof；缺失时保持blocker，不得把计划receipt改写成成功。
- 只有全部域执行、物理ACK、completion proof及独立故障域restore replay闭环后，才可推进tenant completed、正式冻结M1并进入M3。没有云资源不阻止继续实现本地/CI executor协议、Memory/MySQL/Redis与fake-adapter故障注入；真实云资源、IAM/KMS、共享对象存储、备份恢复、Kubernetes/VM拓扑、域名/TLS与告警集成仍等待实际参数。

## 2026-10-09（M1 数据生命周期：0023 tenant erasure T3e local execution / physical ACK）

### 已完成

1. 新增expand-only、runtime默认休眠的`0023_tenant_purge_execution_ack.sql`：独立execution job、固定33域执行投影、append-only domain ACK、local cutover/physical ACK receipt和write-once cutover singleton。migration不materialize历史plan、不运行worker、不修改业务数据、不创建delete outbox或伪造physical ACK；六张表的精确列/index/CHECK/FK/trigger fingerprint和永久guard会拒绝不兼容同名schema。
2. Memory/MySQL实现同一最小权限`TenantPurgeExecutionStore`：materialize只消费完整T3d aggregate，并把`sourceEvidenceDbMs`绑定到plan receipt的可信DB时间；claim/renew/retry/block、cutover、physical seal和read-proof全部绑定tenant/request/subject/plan/execution generation、claim attempt/token及完整ACK链。响应丢失只能按精确completed claim identity重放，不能由“源已为空”推断成功。
3. local cutover只推进五个已实现域：`operational_usage`原子生成/核对匿名billing fact后删除operational ledger；`user_export_control`撤销request/job并清除download lease；`user_export_snapshots`释放Blob pin并删除snapshot record；`blob_bytes`与`user_export_bytes`只把精确目标切为delete-pending并写现有cleanup outbox。blocker resolution、每个outbox identity、target/deletion generation及其顺序都进入content-free ACK chain。
4. physical seal只接受同一outbox identity已经由原Blob/export cleanup worker实际完成的结果；pending只重试，dead-letter在同一事务中把execution job终结为blocked，不能伪装成功。cleanup completion晚于当前可信DB seal time会使整个physical publication回滚，避免先提交一个随后被read-proof判坏的不可变receipt。
5. irreversible cutover在一个Memory原子发布或单个MySQL `REPEATABLE READ`事务内重验T3c/T3d、canonical tenant/全部user hold、全局owner closure、purge deadline、DB time和live lease；usage、billing fact、export control/snapshot、Blob/export outbox、domain ACK、receipt、job和首次cutover任一失败都整体回滚。cutover后读路径只依赖不可变source/receipt/ACK链，不再要求已被合法修改的live source仍保持原状。
6. runner内嵌`TenantPurgeExecutionWorker`，没有新增第三个服务、进程、bundle或镜像。runner的`TENANT_PURGE_EXECUTION_WORKER_ENABLED`和router的`TENANT_PURGE_EXECUTION_ENABLED`双重默认`0`；每次materialize、claim、lease续期、不可逆cutover、physical seal及模糊响应重试前都重新取得token-protected、fresh、non-sticky的all-configured fleet ACK。runner启用还强制要求Blob cleanup、export cleanup和本地单runner filesystem契约。
7. capability把代码理解能力`tenantPurgeExecution=["local-execution-ack-v1"]`与worker实际激活布尔值分开；公开`dataPurgeExecution`继续固定`false`。local cutover/physical receipt分别固定`physicalAcksComplete=false`或`localPhysicalAcksComplete=true`，但两者始终`allDomainsComplete=false`、`contentPurgeExecuted=false`，tenant公开status仍为`gated`。
8. 冻结真实`0022` delta并新增独立`0022→0023`历史MySQL夹具；覆盖历史T3d与业务证据保持、零隐式执行、两个DDL auto-commit中断点、marker-loss replay、弱trigger修复/额外trigger拒绝、错误index/额外列/弱化CHECK拒绝，以及33域/ACK/owner-generation约束。CI、本地verify、required-suite/no-skip证明和runner image最新migration marker均已接线。
9. 学习与运维文档已同步T3e手工体验、安全rollout、默认关闭边界和CI产物事实：本仓库仍只构建router/runner两个Node ESM bundle及两个Linux OCI image；T3e随runner部署，不产生第三个可执行单元。staging/production和多VM/Pod在共享对象存储adapter完成前必须保持T3e双gate关闭。

### 本轮验证与审查

- `scripts/local-service.sh verify`完整通过（exit 0）：`pnpm check:secrets`扫描 **336 files**，OpenAPI/生成SDK漂移检查与`pnpm typecheck`通过；主套件 **93 files passed / 1 skipped、1226 passed / 1 skipped**，唯一skip仍是真实厂商E2E显式付费开关。覆盖率 **81.56% statements / 77.92% branches / 85.66% functions / 84.85% lines**，MySQL store **83.86% lines**。
- T3e Memory **6/6**、core worker **10/10**、runner gate **8/8**、named真实MySQL **5/5**；另行组合的protocol/runner/registry相关定向套件 **10 files / 139 passed**，需要真实loopback的router app **57/57**。真实MySQL覆盖nonzero ready export/download lease/artifact outbox、live sealed snapshot pin、usage→billing、existing/new Blob outbox、canonical hold零部分写、并发/response-loss replay、SQL故障回滚、过期lease、pending/dead-letter优先、future completion回滚、tenant隔离和exact ACK/read-proof。
- 固定历史升级链从`0007`运行到`0023`，共 **16 files / 83 passed**；新增`0022→0023` **6/6**，原`0007→0008` **2/2**仍证明相同usage重复安全合并、内容冲突阻断且不丢账、legacy pending receipt保留。每个required migration与MySQL suite均由JSON proof确认目标文件实际执行且零skip。
- cluster **6 files / 23 passed**；SDK **18-file**隔离包通过；runner/router Node 24 bundle约 **4086 KB / 802 KB**，原生启动、readiness、tenant/platform auth边界、转发与OpenAPI检查通过。候选发布物仍只有两个bundle和两个Linux OCI image。
- 并发正确性、事务回滚、滚动升级兼容、安全隔离、测试有效性与文档/CI接线均经独立复核；修复了模糊destructive replay复用旧fleet proof、MySQL source DB-time错绑和future cleanup completion先提交后自证损坏的问题。最终 **P0=0、P1=0、P2=0**。
- 本轮没有改变provider dialect或公开真实模型网络契约，因此未重复运行会产生费用的`verify-real`或十阶段acceptance；最近真实模型 **1/1** 与acceptance通过只保留为历史基线，不冒充本轮重跑结果。

### 当前边界、风险与下一步

- M2冻结结论不变；本轮仍属于M1，没有开始M3。T3e只是本地受限执行/ACK地基：它实际修改五个域并证明本地Blob/export物理清理，但session content、idempotency receipt、lifecycle outbox、Redis lease/fence/stream、tenant registry/profile/agent、其余export/Blob投影、external provider/KMS、backup/restore、logs/traces及全域completion仍未闭环。M1不能冻结，公开`dataPurgeExecution`不能开启。
- 保留三个非阻断、fail-closed的P3：大量排序靠前的active-hold execution job可能填满固定候选窗口并饿死后续eligible job，后续需游标分页或原子hold backoff；T3e真实MySQL成功路径会重验owner closure、T3d套件也有cross-owner/orphan负向覆盖，但T3e专属套件尚缺直接损坏注入；`0023` partial-DDL restart显式抽样两个建表边界而非六表/全部trigger auto-commit点。它们不授予错误删除权限，但应在后续切片/预发演练补强。
- 下一独立切片应继续T3f本地DB内容/控制域：设计不可变pre-delete receipt与exact ACK，原子清理`session_content`、`idempotency_receipts`、`lifecycle_outbox`并闭合Blob manifest/outbox和export artifact投影；必须保持tenant/user owner、事件seq、billing retained evidence和响应丢失重放正确。之后再以独立adapter/ACK处理Redis三域，并逐步实现local fake external/KMS/backup/restore/log/trace契约；缺少真实云资源时只能验证接口、故障注入和fail-closed blocker，不能伪造真实云完成。
- 整体local/CI实现全部闭环后再进行一次完整手工walkthrough最稳定，但无需等到那时才体验；当前可按`docs/operations/development-and-ci-guide.md`分阶段启动、smoke和观察各模块。真实shared object storage、KMS/IAM、云MySQL/Redis、registry/promotion、Kubernetes/VM拓扑、域名/TLS、备份恢复与告警仍等待实际资源参数。

## 2026-10-09（M1 数据生命周期：0024 tenant erasure T3f local database projection purge）

### 已完成

1. 新增expand-only、runtime默认休眠的`0024_tenant_database_purge.sql`：独立database-purge job、固定11域pre-delete entry/receipt、append-only domain ACK、terminal receipt、永久全局session grave与write-once cutover。migration不materialize历史T3e receipt、不启动worker、不删除业务行，也不把任何tenant推进为completed；七张表、索引/CHECK/FK和45个migration-owned trigger均有严格schema/body fingerprint，marker-loss可重放，不兼容同名对象会fail closed。
2. 固定11域为tenant profile、agent definitions、session content、idempotency receipts、billing reconciliation、Blob manifest/outbox、lifecycle outbox及user-export control/snapshot/artifact。Memory在完整snapshot后一次发布，MySQL在单个显式`REPEATABLE READ`事务中重验T3c/T3d/T3e source、canonical hold、DB time、claim/lease、settled lifecycle outbox与live owner关系，再原子写pre-delete proof和grave、执行清空/删除、写11个ACK、terminal receipt/job与首次cutover。SQL故障、最终lease失效或任一证据漂移都会整体回滚。
3. T3e successor域不是只看“当前已删除”。实现scheduled↔physical ACK双射与唯一性，按T3d原始root反向重建Blob bytes/manifest/outbox及export bytes/artifact/part/outbox的精确集合；额外、缺失、同数量换identity或cutover后插入均拒绝。terminal replay除重验完整T3f链外，还把live billing fact count/root再次绑定到不可变T3e final `operational_usage/anonymized` ACK，完整重算T3f pre-delete、grave、ACK、receipt、job和cutover也不能掩盖换账。
4. session删除前在同一事务写全局主键grave，`sessions`的三重永久BEFORE INSERT guard禁止任何tenant复用该session id；真实InnoDB强制交错证明grave+delete未提交期间的跨tenant create先阻塞，提交后精确映射为`SessionGoneError`。grave getter仍按tenant隔离。`ownerSha256`是从live session与删除同事务捕获、受append-only guard和runtime最小权限保护的opaque ownership claim；T3c session receipt不含`userId`，因此它不能只凭保留上游证据离线重算，但全局ID防复用不依赖这种反推。
5. runner内嵌`TenantDatabasePurgeWorker`，不新增公开API、第三个服务、进程、bundle或镜像。runner的`TENANT_DATABASE_PURGE_WORKER_ENABLED`与router的`TENANT_DATABASE_PURGE_ENABLED`相互独立且默认`0`；materialize、claim、renew、destructive execute和模糊响应replay分别要求fresh、token-protected、`no-store`的all-configured fleet ACK。receipt固定`localDatabasePurgeComplete=true`、`sessionContentDeleted=true`、`allDomainsComplete=false`、`contentPurgeExecuted=false`，公开status继续为`gated`且`dataPurgeExecution=false`。
6. capability把T3e `local-execution-ack-v1`与T3f `local-db-content-delete-v1`、以及两个worker activation分开。冻结的pre-T3f严格parser测试证明旧router会拒绝新runner的双值capability，因此唯一安全rollout是`0024` → 新router保持T3f gate=`0`并完全排空全部旧router → 新runner worker=`0` → 开启全部worker并核对fleet → 最后开启router gate；禁止runner-first，首个cutover后只能forward-fix。
7. 冻结真实`0023` delta并新增独立`0023→0024`历史MySQL夹具；它证明历史业务/T3e evidence逐字保留、无隐式job或删除，并覆盖两个CREATE TABLE auto-commit中断点、marker-loss replay、弱trigger修复/未知trigger拒绝、错误index/额外列/弱化CHECK拒绝，以及11域/FK/grave复用约束。CI、本地verify、required-suite JSON no-skip证明和runner image最新migration marker均已接线；冻结fixture SHA-256仍为`b5561406bad4498ad1881d3944778c3c13583a8ce446f419b1201f96f719a801`。
8. `docs/operations/development-and-ci-guide.md`继续作为学习材料入口，已同步本地服务拓扑、阶段体验、T3f观察方式、安全rollout和GitHub Actions产物事实。仓库仍只构建router/runner两个Node ESM bundle及两个Linux OCI image；T3f随runner部署，不是第三个可执行单元。

### 本轮验证与审查

- `scripts/local-service.sh verify`完整通过（exit 0）：`pnpm check:secrets`扫描 **348 files**，OpenAPI/生成SDK漂移检查、`pnpm check:sdk`与`pnpm typecheck`通过；主套件 **98 files passed / 1 skipped、1273 passed / 1 skipped**，唯一skip仍是真实厂商E2E显式付费开关。覆盖率 **80.81% statements / 77.13% branches / 85.43% functions / 84.03% lines**，MySQL store **82.48% lines**。
- T3f contract/core worker/runner gate/protocol定向合集 **4 files / 54 passed**；router app **58/58**；其余修改过的router/runner config、HTTP与main **4 files / 70 passed**。T3f Memory命名套件 **12/12**，真实MySQL命名套件 **7/7**；wrapper均输出目标文件执行数量并拒绝skip/partial run。
- 固定历史升级链从`0007`运行到`0024`，共 **17 files / 89 passed**；新增`0023→0024` **6/6**。`0007→0008` **2/2**继续证明相同usage重复安全合并、内容冲突重复阻断且不丢账、legacy pending receipt保留。
- cluster **6 files / 23 passed**；SDK **18-file**隔离包通过；runner/router Node 24 bundle约 **4483 KB / 807 KB**，原生启动、readiness、tenant/platform auth边界、转发与OpenAPI深比较通过。候选发布物仍只有两个bundle和两个Linux OCI image。
- 从并发正确性、事务回滚、滚动升级兼容、安全隔离和测试有效性完成独立复审，最终 **P0=0、P1=0、新P2=0**。真实MySQL对抗覆盖成功/response-loss并发、注入式destructive rollback、grave/create强制交错、post-T3e额外投影、same-count Blob/export identity replacement，以及完全重哈希T3f链后的billing replacement。
- 本轮没有改变provider dialect或公开真实模型网络契约，因此未重复运行会产生费用的`verify-real`或十阶段acceptance；最近真实模型 **1/1** 与acceptance通过只保留为历史基线，不冒充本轮结果。

### 当前边界、风险与下一步

- M2本地/CI代码范围继续正式冻结；本轮仍属于M1，没有开始M3。T3f关闭了本地数据库内容/控制投影切片，但Redis lease/fence/stream、external provider/KMS、backup/restore、logs/traces、共享对象存储生产adapter、全域completion/restore防复活及generic user物理purge仍未闭环，所以M1仍不能冻结。
- 已接受P2是grave `ownerSha256`的opaque-claim审计边界：普通session的T3c receipt没有`userId`，无法仅靠保留证据离线重算。它不削弱全局session-ID grave fence；若未来要求完全离线owner审计，需要扩展上游owner proof，而不是猜测或回填已删除身份。
- 保留三个非阻断P3：`0023→0024` partial-DDL夹具抽样第二张和最后一张表，没有逐一故障注入45个trigger rotation的每个auto-commit点；旧router/new runner已有冻结parser单测与安全顺序，但真实N-1镜像mixed-rollout canary仍待staging；当前MySQL execute为保护首次write-once cutover而在整个destructive事务持有全局cutover行`FOR UPDATE`，会串行化跨tenant T3f删除，连同上游全库关系扫描的容量、锁等待/死锁和lease压力都必须在M4/staging压测与优化。以上路径均fail closed，不会授予错误删除authority。
- 下一独立切片应实现T3g Redis三域adapter/ACK：精确绑定tenant的session lease、fence/owner目录与event stream，提供Memory/真实Redis故障注入、幂等physical proof、restore/replay fence和独立默认关闭gate；它仍不能伪造external/KMS、backup/restore、logs/traces或云共享对象存储完成。之后再逐域闭合local fake external/KMS/restore契约与completion proof，M1全部local/CI proof完成后才正式进入M3。
- 阶段性本地smoke/手动体验现在就有价值；等M1、M3、M4的local/CI范围全部完成后再按学习指南做一次系统性完整walkthrough最稳定。真实staging/production的云MySQL/Redis、共享对象存储、IAM/KMS、registry/promotion、Kubernetes/VM拓扑、域名/TLS、备份恢复、容量与告警验收仍需用户后续提供资源和参数，不能由本地结果冒充。

## 2026-10-09（M1 数据生命周期：0025 tenant erasure T3g Redis session-state purge）

### 已完成

1. 新增expand-only、runtime默认休眠的`0025_tenant_redis_purge.sql`：独立job、per-session target、commit-ordered restore序号、target ACK、三个domain ACK、terminal receipt与write-once cutover共七张表。migration不materialize历史T3f receipt、不连接或修改Redis、不写marker，也不推进tenant公开状态；严格schema/index/CHECK/trigger fingerprint、append-only guards和marker-loss replay继续fail closed。
2. Memory/MySQL实现同一最小权限`TenantRedisPurgeStore`。materialize只消费terminal T3f database-purge receipt及固定T3d `redis_leases`、`redis_fences`、`redis_streams` plan entry，并要求target与全局session grave精确闭合；claim/renew/retry/block、逐target ACK、三个domain ACK、terminal receipt与cutover均绑定request/generation、namespace、operation、attempt/token/lease和完整source/root。Memory以staged publication保证失败零部分发布，MySQL用显式事务、DB time及行锁保证回滚、并发与tenant隔离。
3. 新增真实Redis purge adapter与集中key grammar：`${prefix}:lease:{sessionId}`内含owner目录，另有同slot的fence、stream、瞬时`evt`和永久`purge` marker。Lua在任何修改前校验key type、既有marker及operation identity，再原子写入无TTL、无正文、固定六字段marker并删除lease/fence/stream；response loss以同一operation精确replay并返回首次existence bits。`evt`只是Pub/Sub，不是第四个持久domain，也不被计入domain ACK。
4. runtime lease acquire/renew/getOwner、router owner lookup、持久event publish与live event publish都增加marker fence，清理后的session不能重新建立owner、lease、fence或stream，也不能继续向该session的瞬时channel发布。该写者防复活与Lua原子删除共同关闭本地/CI的三个session-scoped Redis domain；它不会执行`FLUSHDB/FLUSHALL`或清除quota/keypool/MCP等无关Redis状态。
5. Redis mutation与MySQL ACK明确是replay-safe saga，不是跨存储分布式事务。per-target marker先成功而ACK响应丢失时，worker下一次claim会先执行existing-marker-only同slot原子replay：只有相同namespace/operation的exact marker存在时才按marker保存的首次existence bits返回并再次`DEL`可能复活的lease/fence/stream；marker缺失时绝不创建marker或删除状态。随后exact marker可以在destructive gate关闭时持久化ACK并seal。partial和terminal job的target+ACK row形成durable restore projection；MySQL以事务内singleton allocator为ACK分配commit-ordered `restore_seq`，回滚不消耗序号，keyset scan冻结本轮已提交上界；Memory以当前Map插入顺序的opaque上界提供相同分页语义。runner在开始监听/ready之前只重放已有durable ACK的projection，之后周期性重放，未ACK marker则在worker开始轮询后由上述existing-marker路径恢复。namespace漂移、marker冲突或Redis证据损坏会fail startup或阻止新的destructive work。
6. runner内嵌`TenantRedisPurgeWorker`，没有新增公开API、第三个服务、进程、bundle或镜像。runner的`TENANT_REDIS_PURGE_WORKER_ENABLED`与router的`TENANT_REDIS_PURGE_ENABLED`相互独立且默认`0`。fresh、non-sticky、`no-store`的all-configured fleet ACK只用于materialize和每一次新的Redis mutation；mutation前必须完成`fresh gate → renew claim → fresh gate`。claim、existing-marker-only replay、持久化/精确重放ACK、已有durable ACK的restore和全ACK seal不再取得destructive gate，使关闭router gate后也能收口marker-only窗口。capability把`tenantRedisPurge=["session-state-delete-v1"]`、worker activation及namespace digest分开；所有configured runner必须健康、worker-active且digest完全一致。
7. `REDIS_NAMESPACE_ID`与`REDIS_PREFIX`共同生成namespace digest。前者是operator赋予的非密钥逻辑身份，必须准确、唯一地绑定目标Redis cluster/database/prefix，不能因URL未进入hash而在无关namespace复用；已有marker/ACK/cutover后更换identity会使restore fail closed。安全rollout固定为`0025` → marker-aware新router gate=`0`并完全排空旧router → marker-aware新runner worker=`0`并完全排空旧runner → 核对stable URLs/capability/namespace → 全量开worker → 最后开router gate。首次marker/ACK/cutover后只能forward-fix；router gate可暂停新materialize/mutation，但worker必须保持开启以收口existing marker、补ACK/seal并重放已有durable ACK的marker。
8. 冻结真实`0024` delta并新增`0024→0025`历史MySQL夹具；全链hash固定的frozen-schema路径证明旧业务行、dormancy、partial DDL与marker-loss收敛，另一条静态、hash固定且不依赖live 0001～0024迁移或当前writer的合成T3f evidence路径，升级前后逐字段比对全部七张T3f证据表并证明升级后可由T3g materialize。本地/CI另接入T3g Memory contract、真实MySQL、真实Redis和精确cluster rollout命名套件，required wrapper拒绝目标文件未执行、skip或partial run。runner image启动检查的最新migration marker已更新为`0025_tenant_redis_purge.sql`。候选产品产物仍只有router/runner两个Node ESM bundle及两个Linux OCI image；T3g随runner部署。

### 本轮验证与审查

- `scripts/local-service.sh verify`完整通过（exit 0）：`pnpm check:secrets`扫描 **364 files**，OpenAPI/生成SDK漂移检查、`pnpm check:sdk`与`pnpm typecheck`通过；主套件 **103 files passed / 1 skipped、1318 passed / 1 skipped**，唯一skip仍是真实厂商E2E显式付费开关。覆盖率 **80.76% statements / 77.02% branches / 85.64% functions / 83.96% lines**，MySQL store **82.59% lines**，Redis purge adapter **90.14% lines**。
- T3g纯contract/Memory **5/5**、真实MySQL+Redis **8/8**、真实Redis Lua **4/4**、core worker **12/12**、runner gate **8/8**均由JSON required wrapper或主报告证明执行且无skip。真实跨存储用例覆盖Lua已提交但MySQL ACK未提交的崩溃窗、gate关闭后的exact-marker replay/接管/补ACK/seal，以及随后模拟Redis marker/data loss后从durable ACK精确恢复；Memory与MySQL都证明分页扫描冻结上界。真实InnoDB关键交错还把事务A暂停在ACK已INSERT且已分配`restore_seq`、但尚未提交的位置，证明事务B必须等待allocator行锁且不能越过；`AFTER INSERT`故障证明ACK和counter同事务回滚、重试不留gap。未领取与过期claim的source-integrity poison会分别以`attempts+1`原子进入blocked，同批健康邻居仍可claim。
- 固定真实MySQL历史升级链运行至`0025`并确认 **18 files / 95 passed**；其中`0024→0025` **6/6**分别证明全链hash固定的frozen schema/业务行保持，以及静态hash固定pre-0025 T3f evidence的七张表逐字段保持且可显式materialize T3g，并继续覆盖migration dormancy、partial-DDL/marker-loss收敛及永久guards。原`0007→0008` **2/2**的相同usage重复安全合并、内容冲突阻断且不丢账、legacy pending receipt保留继续在同一required链中执行。
- broad cluster **7 files / 26 passed**；T3g mixed-worker/mixed-namespace/active-fleet精确cluster wrapper另行确认 **3/3**。SDK **18-file**隔离包、runner约 **4806 KB** / router约 **815 KB** Node 24 bundle，以及原生启动、readiness、tenant/platform auth边界、转发与OpenAPI检查通过。候选产品产物仍只有两个bundle和两个Linux OCI image。
- 正确性复核同时检查：首次Lua修改前完整预检与same-slot原子性；新mutation前`gate → renew → gate`及至少半个lease的剩余预算；gate-off existing-marker-only replay只在exact marker存在时按原bits再次删除三域、marker缺失时零修改；marker-before-DB-ACK窗口的补ACK/seal；partial ACK在过期claim接管后的继续处理；poison逐候选隔离且不饿死邻居；writer resurrection fence；commit-ordered/frozen restore scan及allocator回滚；仅durable ACK进入启动/周期restore；pre-0025 T3f证据逐字段不变；namespace与tenant隔离；旧进程完全排空；terminal flags不越权。任何一项失败都不得把三域或全局completion记为成功。
- 本轮没有改变provider dialect或公开真实模型网络契约，因此未重复运行会产生费用的`verify-real`或十阶段acceptance；最近真实模型 **1/1** 与acceptance通过只保留为历史基线，不冒充本轮结果。

### 当前边界、风险与下一步

- M2冻结结论不变；本轮仍属于M1，没有开始M3。T3g关闭的是本地/CI的session lease（含owner目录）、fence counter与hot replay stream三域。`evt`是瞬时Pub/Sub，不是第四个持久域；quota、keypool、MCP及未来其它Redis key均不在本切片，也不允许用`FLUSHDB/FLUSHALL`代替精确target。
- same-MySQL durable restore projection只重放已经有durable target ACK的marker，不是独立故障域restore ledger。正常的marker-only窗口会由worker轮询中的existing-marker-only replay在gate关闭时收口；但若Redis中只有marker而MySQL ACK尚未提交，且该marker在worker成功恢复并持久化ACK前又从Redis丢失，则首次lease/fence/stream existence bits仍无法恢复。MySQL与Redis一起恢复到旧snapshot也不受保护。external provider/KMS、backup/independent restore、logs/traces、共享对象存储生产adapter、generic user/session物理purge与全域completion仍未闭环；terminal继续固定`allDomainsComplete=false`、`contentPurgeExecuted=false`，公开status为`gated`且`dataPurgeExecution=false`，所以M1仍不能冻结。
- 永久purge marker按设计暂无GC，普通live-session fence counter的灾难恢复和大tenant restore keyset扫描/重放性能也仍未闭环；commit-ordered allocator会串行化全局target-ACK发布，正确但需要在staging压测锁竞争和吞吐。当前真实Redis套件使用standalone ioredis，managed Redis Cluster/ACL/persistence/failover、marker容量、真实N-1 router/runner rollout和namespace迁移必须在staging用实际云资源验证。fleet barrier不能约束仍存活且能直接写Redis的旧进程，因此任何T3g mutation前完全排空旧runner是强制条件。
- 后续M1切片应继续闭合external provider/KMS、backup/独立restore ledger、logs/traces及共享对象存储生产适配，并设计不夸大局部ACK的全域completion proof。云MySQL/Redis、IAM/KMS、对象存储、Kubernetes/VM、域名/TLS、registry/promotion、备份恢复、容量和告警仍等待用户提供真实资源与参数；本地/CI结果不能冒充staging/production验收。

## 2026-10-10（M1 数据生命周期：0026 versioned credential lifecycle inventory）

### 已完成

1. 新增default-dormant、expand-only的`0026_credential_lifecycle_inventory.sql`。六张新表/投影覆盖tracking singleton、每tenant coverage/gap、永久provider slot、immutable credential version、`external_credential`/`kms_key` target disposition及T3a inventory sidecar；tenant-auth CAS generation位于既有`tenants`行。migration不扫描或改写credential material、不激活tracking、不删除credential、不联网，也不保存secret、config/header、base URL或明文locator。
2. legacy tenant在cutover时固定为`legacy_history_unknown`，cutover后新tenant固定为`complete_since_creation`。tracking active后provider与tenant-auth写入必须在同一Memory原子发布或MySQL事务中以source generation CAS双写版本账本；永久provider slot跨delete/recreate保留并单调递增generation，关闭同ID重建的ABA窗口。hot read、snapshot与T3a replay都会重验source、slot/version、material bit、时间和完整target集合，缺失或漂移一律fail closed。
3. 当前adapter故意不伪造远端能力：有material且需要处置的target只会写`blocked_no_locator`、`blocked_shared_local_key`或`blocked_legacy_history`；没有对应material写`not_applicable`；`executable_ref`保留给未来真实external/KMS adapter。T3a成功事务会同时retire当前version、删除本地source、推进slot/auth projection，并原子写原T3a receipt、inventory sidecar和terminal job；序列化、SQL或终态发布任一步失败都不留下部分撤销/sidecar。
4. capability新增`versioned-target-ledger-v1`并接入router/runner gate。MySQL tracking activation以`SERIALIZABLE`锁定完整subject-lifecycle范围，使全局cutover与并发新tenant/credential writer线性化；runner只在T3g restore preflight完成后、bootstrap/workers/listener之前读取/激活tracking。restore/tracking-read/activation阶段失败会显式释放已建资源，后续bootstrap或bind失败仍按forward-fix处理。
5. 安全rollout固定为：应用`0026`且tracking=`0` → 部署全部ledger-aware router/runner并彻底排空旧writer → 核对configured fleet的versioned capability → 显式启用runner tracking并确认全fleet均观察active → 开启router tracking gate → 逐runner开启T3a worker并核对barrier → 最后开启T3a execution。tracking或任何T3a receipt cutover提交后都不能回退旧writer，只能forward-fix。
6. 冻结真实`0025` delta并新增`0025→0026`历史MySQL夹具，覆盖dormant升级、六张表严格fingerprint、legacy/new coverage、partial DDL与marker-loss收敛、append-only guards、active-cutover provider/auth CAS、并发activation/write线性化、slot ABA及T3a sidecar回滚/重放。CI、本地verify、required-suite/no-skip断言与runner image最新migration marker均已接线；候选产品产物仍只有router/runner两个Node ESM bundle和两个Linux OCI image。

### 本轮验证与审查

- `scripts/local-service.sh verify`完整通过（exit 0）：`pnpm check:secrets`扫描 **370 files**，OpenAPI/生成SDK漂移检查、`pnpm typecheck`与`pnpm check:sdk`通过；主套件 **106 files passed / 1 skipped、1352 passed / 1 skipped**，唯一skip仍是真实厂商E2E显式付费开关。覆盖率 **80.92% statements / 77.19% branches / 86.15% functions / 84.07% lines**，MySQL store **82.54% lines**，Redis purge adapter **90.14% lines**。
- 0026 named真实MySQL套件 **8/8**；固定真实MySQL历史升级链 **19 files / 105 passed**，其中`0025→0026` **10/10**，且`0007→0008` **2/2**的相同usage重复安全合并、内容冲突阻断且不丢账、legacy pending receipt保留继续实际执行。required wrapper与JSON report证明目标文件被执行且零skip。
- broad cluster **7 files / 26 passed**，T3g mixed-worker/mixed-namespace/active-fleet精确cluster wrapper **3/3**。SDK **18-file**隔离包、runner约 **5079 KB** / router约 **819 KB** Node 24 bundle，以及原生启动、readiness、tenant/platform auth边界、转发与OpenAPI检查均通过。
- 完整验证首次暴露长寿命MySQL测试库中的固定`t_a/p1`旧fixture行不满足0026 source-material绑定。修复选择让conformance使用每次唯一tenant/provider及真实`apiKeyRef`，没有削弱生产fail-closed校验；Memory定向和真实MySQL重复运行均通过。它避免语义污染，但长寿命测试库仍会累积动态fixture行，属于测试库容量卫生P3。
- 从并发正确性、事务回滚、滚动升级兼容、安全隔离和测试有效性完成独立复核，最终 **P0=0、P1=0、P2=0**。复核修正了source/material绑定、router tracking gate顺序、item 12/19依赖、启动cleanup承诺边界及`not_applicable`文案。未改变provider dialect或公开真实模型网络契约，因此未重复运行会产生费用的`verify-real`或十阶段acceptance；最近真实模型 **1/1** 与acceptance通过只作为历史基线，不冒充本轮结果。

### 当前边界、风险与下一步

- M2冻结结论不变；本轮仍属于M1，没有开始M3。0026只建立可审计、版本化、可线性化的credential来源与处置inventory；当前external provider/KMS仍只有诚实blocker，没有可执行locator或远端撤销adapter，tenant公开status继续为`gated`、`dataPurgeExecution=false`，M1尚不能冻结。
- tracking activation的`SERIALIZABLE`全范围锁是一次性全局writer边界，需要在staging测量锁等待、死锁与容量；cutover提交后若后续bootstrap/listen失败只能forward-fix恢复可用性。57个migration trigger没有逐一故障注入每个auto-commit点，真实N-1 mixed rollout也仍待staging。hot read当前逐target读取存在N+1容量风险；长期共享测试库动态fixture需要周期清理；同providerId跨两个active tenant的并发写/单边更新隔离还可补充更深测试。
- startup flag不是可审计的fleet-barrier migration Job，必须严格排空旧writer；M4应拆出显式migration/activation Job并让业务进程只做schema/version检查。下一M1切片优先实现共享S3/MinIO对象存储adapter及本地MinIO/CI真实行为，在不依赖云账号的前提下闭合多runner Blob/export对象语义；之后继续external provider/KMS、backup/独立restore ledger、logs/traces、generic user/session物理purge与全域completion proof。云IAM/KMS、managed对象存储/MySQL/Redis、registry/promotion、Kubernetes/VM、域名/TLS、备份恢复、容量与告警仍必须等待真实资源，不能由本地结果替代。

## 2026-10-10（M1 数据生命周期：0027 shared S3/MinIO Blob storage cutover）

### 已完成

1. 新增共享S3-compatible `S3BlobStore`。对象采用同一key上的`ASBLOB02` data/tombstone envelope；create使用`If-None-Match`，删除以读到的ETag执行`If-Match` CAS并强校验tombstone回读，response loss只允许精确重读收敛。读取有明确字节上限，不把对象完整无界载入内存；namespace/prefix、同key并发create/delete、跨client可见性与重启后的tombstone语义均进入测试。
2. runner在listener和worker启动前执行S3 preflight：`HeadBucket`、versioning未启用且从未启用、bucket lifecycle配置不存在、Object Lock不存在或关闭、条件create/CAS及cleanup可见性。`BLOB_S3_PRIVATE_BUCKET_ACK=1`只表示production操作者已经通过独立工具确认匿名访问拒绝和IAM/policy，不是程序自动证明；本地MinIO保持该ACK关闭，并由真实协议测试直接验证匿名raw GET被拒。production还必须用IAM禁止外部对象覆盖/删除或运行后新增lifecycle规则，并监控控制面漂移；一次startup probe不能证明未来配置不变。
3. 新增`0027_blob_storage_control.sql`及Memory/MySQL store：default-dormant singleton从generation 0至1只允许一次。activation在一个Memory原子发布或MySQL事务中锁定并核对全部live Blob/export manifest、未释放snapshot pin和所有未完成delete outbox；dead-letter不算physical completion，仍会阻断异backend cutover。active后所有相关写guard都要求同一backend/namespace，filesystem回退或bucket/prefix/namespace漂移fail closed。migration只安装schema/guard，不选择backend、不搬bytes、不接触对象。
4. namespace digest固定绑定非密钥的`BLOB_NAMESPACE_ID + bucket + prefix`；runner持有endpoint和credential，router只接收`BLOB_STORE`、公开namespace参数及control状态并用capability比较全fleet，避免把对象存储凭据传入router或公开协议。S3 mode现已支持Blob、user export与T3e cleanup；filesystem mode仍限本地单runner并要求`BLOB_FILESYSTEM_SINGLE_RUNNER=1`。
5. 本地基础设施新增可选MinIO。`scripts/build-local-minio.sh`以固定Go版本、校验和及固定官方MinIO commit构建本机二进制，`deploy/local/infra.sh`负责启动和private/unversioned bucket bootstrap；`scripts/local-service.sh verify-s3`提供显式真实S3协议验证。CI同样从固定官方源码构建MinIO、启动private bucket并强制执行真实套件。MinIO是测试/开发基础设施，不是第三个产品服务或发布镜像；候选产品仍只有router/runner两个Node ESM bundle和两个Linux OCI image。
6. 新增固定`0026→0027`真实MySQL历史夹具，证明0026业务、Blob/export状态逐字段保留，migration保持dormant，首DDL auto-commit/marker-loss可收敛，冲突legacy manifest、未释放pin和dead-letter outbox会阻断cutover，弱同名schema会fail-fast。required migration wrapper继续从`0007`运行至`0027`并拒绝必需文件未执行、skip或partial run；runner image启动检查的最新migration marker同步为`0027_blob_storage_control.sql`。
7. `README.md`、`docs/operations/local-and-deployment.md`和`docs/operations/development-and-ci-guide.md`已同步默认filesystem日常开发、可丢弃数据库上的MinIO/S3手动体验、write-once风险、staging/production发布边界，以及GitHub Actions实际构建的产品产物和基础设施依赖。没有编造任何云bucket、IAM、KMS、域名、registry或集群参数。

### 本轮定向验证与审查

- `scripts/local-service.sh verify`完整通过（exit 0）：`check:secrets`扫描 **385 files**，OpenAPI/生成SDK漂移检查和`typecheck`通过；主套件 **112 files passed / 2 skipped、1401 passed / 10 skipped**。两个显式skip文件分别是需真实付费模型的E2E（1项）和在主套件中未配置S3时的真实MinIO文件（9项）；后者另由required wrapper实际运行并通过 **9/9**，不是未验证。覆盖率为 **80.99% statements / 77.24% branches / 86.36% functions / 84.16% lines**。
- S3 unit **21/21**；`verify-s3`同时通过真实MinIO adapter **9/9**与源码runner/router应用装配smoke。独立dist应用装配smoke也通过，证明runner bundle包含完整AWS SDK运行闭包、临时真实MySQL完成`0027`激活、router观察exact namespace capability，且S3 endpoint/credential只进入runner、不进入router或输出。真实协议覆盖无lifecycle配置的启动前提、跨client可见性、并发条件create/CAS、同key tombstone重启读取、prefix隔离、匿名raw GET拒绝、精确prefix cleanup，以及预存bucket policy时fail closed且不替操作者删除policy。
- Blob storage control的Memory/真实MySQL named套件分别 **5/5、5/5**；固定历史升级链 **20 files / 109 passed**，其中`0026→0027` **4/4**，并继续包含`0007→0008`重复usage安全合并、冲突阻断不丢账和legacy pending receipt保留。required wrappers逐文件验证实际执行且零skip。cluster主套件 **7 files / 26 passed**，T3g精确no-skip cluster另为 **3/3**；SDK隔离包 **18 files**，runner/router Node 24 bundle约 **6961 KB / 829 KB**，原生启动、readiness、tenant/platform auth边界、转发与OpenAPI均通过。
- 正确性复核聚焦条件写线性化和同key tombstone防复活、credential/endpoint provider阶段也受同一外层请求deadline约束、control activation事务回滚与write-once语义、旧binary完全排空后的forward-only滚动升级、router/runner凭据隔离、bucket/prefix namespace隔离、真实套件不可静默skip及dead-letter不伪装完成。独立审计提出的P2（完整请求deadline、control套件no-skip证明、MinIO进程生命周期、router credential denylist、完整应用装配、bucket lifecycle导致tombstone过期）均已修复并回归，最终 **P0=0、P1=0、P2=0**。
- 本轮没有改变provider方言或公开真实模型网络契约，因此未重复运行会产生费用的`verify-real`或十阶段acceptance；最近真实模型 **1/1** 与acceptance通过只作为历史基线，不冒充本轮重跑结果。commit后GitHub Actions结果以对应run为最终远端门禁。

### 当前边界、风险与下一步

- M2冻结结论不变；本轮仍属于M1，没有开始M3。0027关闭的是本地/CI共享Blob/export对象语义和storage identity门禁，不是整个数据生命周期或生产验收。external provider/KMS实际撤销、backup/独立restore、logs/traces、generic user/session物理purge及全域completion仍未闭环，所以M1仍不能冻结；M3的MCP/skills/hooks主体和M4的生产化主体也仍未开始。
- generation 1是不可逆身份承诺，不是在线搬迁器。已有filesystem bytes的非空部署不能直接切到S3，必须先实现并审计copy/verify/cutover/rollback-window mover；否则应使用可丢弃空数据库体验S3。private-bucket ACK是人工确认，managed bucket的IAM/KMS、网络、无lifecycle规则且防外部覆盖的持续控制、版本控制/Object Lock策略、容量、延迟、故障恢复和真实N-1 rollout必须在未来staging用实际资源验证。
- 当前日常研发可以继续采用“本地实现和完整自动化验证 → staging真实基础设施/配置/容量验收 → immutable router/runner镜像promotion到production”的目标流程。现在就应做阶段性smoke和针对性手动体验；等M1、M3、M4的local/CI范围全部完成后，再按学习指南执行一次系统性完整walkthrough。云MySQL/Redis、对象存储、IAM/KMS、registry、Kubernetes/VM拓扑、域名/TLS、备份恢复和监控告警都必须等待用户提供真实参数，不能由本地MinIO结果替代或凭空生成。
