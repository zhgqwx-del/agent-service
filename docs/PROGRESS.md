# 进度记录

> **当前快照（2026-10-09）**：M0 已完成；M1 核心运行范围、OpenAPI 3.1、生成 TypeScript SDK、Archive/tombstone/outbox/Blob lifecycle、usage 财务分层、admission 默认关闭的 durable user-erasure gate/queue/worker、legacy generation `0` 补偿、canonical retention policy / multi legal hold管理面，以及默认关闭的非破坏性purge-policy evaluator/authority substrate已完成。`0016`只建立claim-bound evaluation job、按build generation不可变的per-session target、rooted decision chain与不可执行authority；双端gate默认关闭，`dataPurgeExecution=false`且completion固定为false。live evidence或hold ABA会撤销active projection并以新generation重评，但deadline仍使用runner wall clock，target也不是全部内容行清单。异步 export artifact/TTL、tenant erasure及 key/provider/auth-secret 撤销、可信时钟/owner-scan content receipt、ready/session物理purge、completed proof 与 restore replay仍未完成，M1 尚未闭环。M2 的本地/CI 代码范围已完成并正式冻结；M3/M4 尚未正式开始。本文按时间追加，前文的“下一步”和测试数量都是当时快照；当前事实、验证结果和剩余事项请看最后一节。

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
