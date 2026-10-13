# 进度记录

> **当前快照（2026-10-13T20:41Z）**：M0完成，M2本地/CI代码范围已冻结；M1完整数据生命周期未闭环，M3/M4主体未开始。main仍为`5d669cf`，[Actions 38417167848](https://github.com/zhgqwx-del/agent-service/actions/runs/38417167848)两个image通过、test失败；0053候选尚未提交/合入/推送或常规激活。候选第五轮完整`scripts/local-service.sh verify`于20:32Z确认退出 **0**：secret scan **646 files**、API/typecheck、全部前后置named通过；主coverage **213 files（198 executed / 15 expected skipped）/ 2331 passed / 81 expected skipped / 0 failed**，coverage **79.71% / 75.70% / 86.71% / 82.59%**，76个required文件执行证明通过；真实历史迁移 **46 files / 268 passed / 0 failed / 0 skipped**；cluster **8 files / 28 passed**、独立T3g **1 file / 3 passed**、SDK/runtime/types、六入口build与bundled双服务readiness/auth/forward/OpenAPI均通过。独立定向真实MySQL capture **27/27**、冻结0052升级 **8/8**、active0033 exact-key backup/import/replay/verify **18/18**及真实HTTP/MinIO capture **7/7**保留；串行完整`verify-s3`于20:39Z确认退出 **0**：**14 actual Vitest files / 80 passed / 0 failed / 0 skipped**，源码真实S3双服务装配通过；root逐文件JSON核对非零执行与本轮时间，smoke不算第15个测试文件。新CI尚未发生。前四轮失败、旧共享测试库和精确oracle修正证据保留在最后一节，不借旧成功掩盖失败。六个JavaScript入口为runner五/router一，常驻服务和Linux OCI镜像仍各两个。30天来源/floor及operational usage retention保持默认关闭，内容purge未开放；BYOK厂商侧撤销由客户负责。可信telemetry grant/产品处置/物理ACK/恢复、active0053 retained-source删除与新epoch恢复、generic session/user purge、backup-copy erasure、Redis联合旧快照及managed验收仍缺，所有全域completion=false，M1不能冻结。最新事实以本快照和最后一节为准，旧章节保留时间点事实。

> **0043 增量（已完成）**：0043为code-only只读本地来源诊断和0042非零target T3e live recheck修正，`executionReady=false`、`externalAuthorityVerified=false`固定；其完整验证保留在下方0043历史章节。0043候选不是0044 intent/claim的授权输入，也不能直接驱动外部mutation。

> **0044 增量（历史切片）**：独立`0044` migration只安装两张content-free append-only intent/claim表、guards和严格126-trigger启动指纹，不回填旧terminal、不联网、不激活任何控制。prepare/get/claim在Memory同步原子边界或MySQL RR事务内独立重验当前0039～0042、T3f grave、T1/hold/control/restore与真实owner/source，intent精确绑定artifact group和各来源receipt；claim按同一key/version CAS、DB-time lease及一次性token hash串行化，晚期INSERT后lease过期整事务回滚。`grantReady=false`固定，0037 grant硬拒、0042 T3d blocker、产品外部处置与全域completion保持不变。发布须关闭相关gate并完全排空pre-0044 writer，独立迁移后只运行0044-aware进程，不能热混跑。0044定向与当时主工作树完整`verify`已通过；0045～0050的完整结果只看本页末节与对应GitHub Actions run。

> **已确认的后续参数（2026-10-12）**：普通session DELETE内容宽限期为30天；0050只实现默认休眠的保留证据，自动清理仍关闭，`purge_after_ms=NULL`和不可领取的`session.purge`没有变化。M4同时交付独立VM进程发布包与Linux OCI镜像，当前两种形态的生产交付/环境验收均未完成。

> **0052 完整验证（2026-10-13T12:48Z）**：代码`7ade280`的第二次完整verify已退出 **0**。secret scan **610 files**、API/typecheck、全部前后置named专项通过；主coverage **197 files（184 executed / 13 expected skipped）/ 2147 passed / 56 expected skipped / 0 failed**，statements/branches/functions/lines为 **79.34% / 75.21% / 86.70% / 82.13%**，required逐文件证明通过；真实历史migration **45 files / 258 passed / 0 skipped / 0 failed**。cluster **8 files / 28 passed**、独立T3g cluster **1 file / 3 passed**、SDK pack/runtime/types、runner四入口/router一入口构建、三个one-shot plain Node及bundled双服务readiness/auth/forward/OpenAPI均通过。本批尚未推送CI。隔离backup候选仍未合入：真实17例重跑暴露夹具前置错误和native SQL取消/实际导入阻点；部分负例此前可能在配置层提前拒绝，不能据其14/17结果证明认证/恢复覆盖，已加强实际阶段断言并继续重验。

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

## 2026-10-10（M1 数据生命周期：0028 audited offline filesystem→S3 mover）

### 已完成

1. 新增default-dormant、expand-only的`0028_blob_storage_migration.sql`：offline mover control、sealed inventory、per-object/source-cleanup/target-cleanup ACK、append-only event/receipt与runtime写冻结guard。schema migration本身不冻结、不枚举目录、不搬bytes、不改pointer或激活`0027`；真正动作只来自runner发布物中的一次性`blob-storage-migrate`入口。候选产品仍只有router/runner两个长期应用和两个Linux OCI镜像，mover不是第三个daemon或镜像。
2. 一次性CLI实现`status/prepare/copy/verify/cutover/abort/cleanup-source/run`。`run`默认只到`verified`，显式`BLOB_MIGRATION_COMMIT=1`才尝试不可逆cutover，且永远不自动清理source。inventory只接受MySQL ledger中live/open-intent的Blob/export对象；legacy raw+`.meta`可由migration-only读取，未知filesystem root orphan不进入receipt。copy/verify/abort/cleanup以exact backend、namespace、storage key、descriptor和`migrationOwnerSha256`收口；abort把本attempt目标CAS为永久owner tombstone并永久废弃namespace，cutover后只能forward-fix。
3. 并发authority已收紧：一个dedicated MySQL named lock串行化mutating operator；每次target put/delete/discard和source delete还会在事务中持有migration-control行共享锁，并在外部mutation前后验证named-lock owner。真实`KILL CONNECTION`故障注入证明对象动作可能已发生但旧operator不会写ACK或推进phase，replacement必须等待行锁后按owner-fenced状态精确abort。ACK、阶段迁移和terminal seal也在提交前后复核operator authority。
4. 普通generation-1 Blob activation与mover freeze使用相同的migration-control→blob-control锁序，二者并发只允许一方发布；frozen/committed阶段拒绝旁路activation，aborted attempt的target namespace永久不可复用。runner在store连接后、S3 adapter打开前检查一次迁移control，并在adapter验证和exact Blob identity对账后独立再读一次，关闭验证期间mover commit导致runtime误启动的窗口。两次gate都不能驱逐已运行旧进程，所以外部真实stop/drain和fleet evidence仍是强制条件。
5. `scripts/local-service.sh`会在加载`.env`前保存调用方显式提供的全部mover authority变量与已导出的`AWS_*`，加载后原样恢复；显式空值也优先，避免`.env`静默改写`MYSQL_URL`、target或`BLOB_MIGRATION_COMMIT=0`，且测试证明不回显secret。runner构建新增`dist/blob-storage-migrate.js`，Docker runner镜像包含但不默认启动该入口；CI分别证明源码、dist和runner image入口可执行。
6. 新增固定`0027→0028`真实MySQL历史夹具，覆盖default dormancy、业务/Blob/export/control逐字段保持、首/中/末DDL auto-commit断点、marker-loss replay、owned trigger修复/额外trigger拒绝、freeze guard、activation竞态、namespace永久fence、cutover SQL故障回滚和exact source/target evidence。原`0026→0027`夹具改用独立through-0027 migration目录，避免当前`0028` trigger覆盖历史期望。required wrapper继续逐段证明`0007→...→0028`全部实际执行且零skip。

### 本轮验证与审查

- `scripts/local-service.sh verify`完整通过（exit 0）：`check:secrets`扫描 **398 files**，OpenAPI/生成SDK漂移检查与`typecheck`通过；主套件 **113 files passed / 3 skipped、1471 passed / 22 skipped**。三个条件skip文件分别是真实付费模型E2E（1项）、主套件未显式启用MinIO时的S3 adapter（10项）和mover（11项）；后两者已由下述`verify-s3` required wrapper全部真实执行，不是缺测。覆盖率为 **78.42% statements / 74.25% branches / 84.35% functions / 81.40% lines**，MySQL store **82.61% lines**，Redis purge adapter **90.14% lines**。
- 固定真实MySQL历史升级链 **21 files / 122 passed**，其中`0027→0028` **13/13**，并继续实际执行`0007→0008` **2/2**：相同usage重复安全合并、内容冲突阻断且两行账目保留、legacy pending receipt保留。wrapper逐文件输出执行证明且零skip。
- `scripts/local-service.sh verify-s3`通过真实MinIO adapter **10/10**、真实MySQL+MinIO mover **11/11**及源码应用装配smoke。mover覆盖空库、data/tombstone/staging、legacy raw+sidecar、ordinary staging响应丢失恢复、带非空MIME的pending export delete、target丢失、attempt-owner隔离、并发operator/status、named-lock连接中断和对象上限。
- 无容器定向矩阵 **6 files / 123 passed**；runner Blob control/migration gate独立复核 **23/23**。broad cluster **7 files / 26 passed**，T3g精确cluster **3/3**。`build:check`验证SDK隔离包 **18 files**、runner约 **9723 KB**（`main.js + blob-storage-migrate.js`）、router约 **829 KB**、mover artifact **1,598,371 bytes**，并通过原生Node readiness、tenant/platform auth边界、转发和OpenAPI smoke。
- 从并发正确性、事务回滚、滚动升级、安全隔离和测试有效性完成独立复核，最终 **P0=0、P1=0、P2=0**。本轮未改变provider方言或公开真实模型网络契约，因此没有重复运行会产生费用的`verify-real`或十阶段acceptance；最近真实模型 **1/1** 与acceptance通过只保留为历史基线，不冒充本轮结果。commit后的GitHub Actions仍以对应远端run为最终门禁。

### 当前边界、风险与下一步

- M2冻结结论不变；本轮仍属于M1，没有开始M3。`0028`关闭的是已有filesystem部署迁往共享S3-compatible namespace的本地/CI正确性缺口，不等于M1完整数据生命周期或M4生产验收。external provider/KMS实际处置、backup与独立故障域restore ledger、logs/traces、generic user物理purge、managed环境证明和全域completion仍未闭环；公开status继续为`gated`、`dataPurgeExecution=false`，所以M1仍不能冻结。
- mover只证明ledger可达对象，未知root orphan必须另做只读盘点。candidate/inventory/ACK全量驻内存，freeze/inventory使用`SERIALIZABLE`全范围锁和大型事务；没有分页、batch、dry-run、限速、容量预算或operator HA。MySQL整库重启可能同时释放named lock与行锁，恢复正确性依赖create-only/CAS、永久owner tombstone与精确重放。filesystem identity只绑定resolved path而非mount/inode，S3 digest不含endpoint/region/account；逻辑namespace和物理bucket/prefix都必须保持唯一、稳定并由受控配置/IAM保证。
- `FLEET_DRAINED_EVIDENCE_SHA256`仍是operator提供的摘要，不是自动fleet attestation；startup gate也不会驱逐存活旧writer。真实维护窗口、内存与锁压力、source backup、managed bucket/IAM/KMS/control-plane drift、网络、容量、故障恢复和N-1 rollout必须在未来staging以实际资源验证。cutover提交后以及任何attempt目标被使用后只能forward-fix，不能用本地MinIO成功替代这些结论。
- 下一独立M1切片应继续处理尚未闭环的全域adapter/proof，而不是提前进入M3：优先把external provider/KMS处置契约与backup/独立故障域restore ledger拆成默认关闭、可在本地以fake adapter和故障注入验证的最小权限协议，再接logs/traces、generic user物理purge和terminal completion聚合。真实云IAM/KMS、备份系统、managed MySQL/Redis/对象存储与部署参数仍等待用户提供，仓库不得编造。

## 2026-10-10（M1 数据生命周期：0029 external-credential target execution）

### 已完成

1. 新增default-dormant、expand-only的`0029_tenant_credential_target_execution.sql`：独立job、不可变target、append-only ACK、terminal receipt与write-once cutover。migration不materialize历史T3a、不解密reference、不调用provider、不启用worker/gate，也不把KMS target改为可执行。
2. 受信任服务端provider写路径可把content-free的tenant/provider/API target identity交给独立crypto边界，在同一credential version提交中保存ciphertext、digest与key id；secret、config、header、URL和明文locator不进入0026/0029 ledger。legacy或没有真实source的目标继续保留blocker，KMS仍全部不可执行。
3. Memory/MySQL实现同一最小权限store：从terminal T3a inventory与0026 slot/version/target精确materialize，claim/renew/retry/block、reference读取、exact ACK、terminal seal和response-loss replay全部绑定attempt/token/lease、operation/evidence及source root。序列化、SQL、lease或proof失败不得留下部分target、ACK、receipt或cutover。
4. runner内嵌`TenantCredentialTargetExecutionWorker`，router提供`external-credential-execution-v1` fresh fleet barrier。materialize、claim、续租、adapter mutation与seal边界均重新取no-store ACK；该切片不新增公开API、daemon、bundle或镜像。
5. 当前adapter只有显式`STORE=memory`、禁止production的fake，用于inspect/apply幂等、response-loss与故障注入。标准`scripts/local-service.sh`固定`STORE=mysql`，会拒绝fake或任一0029 gate非零，并向runner/router分别传递固定关闭值；学习指南提供独立Memory测试演练，不把它描述为MySQL或真实provider行为。
6. 新增`0028→0029`真实MySQL历史夹具及`pnpm test:tenant-credential-target-execution-mysql` named no-skip套件；本地`verify`与GitHub Actions均显式执行。CI仍只构建router/runner两个Node应用和两个Linux OCI image，runner镜像的最新migration marker更新到0029，现有mover入口继续包含在runner镜像而不成为常驻服务。

### 验证与审查状态

- `scripts/local-service.sh verify`完整通过（exit 0）：`check:secrets`扫描 **414 files**，OpenAPI/生成SDK漂移检查、`typecheck`与SDK隔离包检查通过；主套件 **121 files passed / 3 skipped、1528 passed / 22 skipped**。三个条件skip文件分别是真实付费模型E2E（1项）、主套件未显式启用MinIO时的S3 adapter（10项）和mover（11项）；本轮没有改动其协议，最近的真实模型 **1/1**、acceptance及`verify-s3`结果只保留为历史基线，不冒充本轮重跑。覆盖率为 **78.24% statements / 74.30% branches / 84.32% functions / 81.18% lines**，MySQL store **81.92% lines**，Redis purge adapter **90.14% lines**。
- 固定真实MySQL历史升级链 **22 files / 133 passed**，其中`0028→0029` **11/11**，并继续实际执行`0007→0008` **2/2**：相同usage重复安全合并、内容冲突阻断且两行账目保留、legacy pending receipt保留。required wrapper逐文件输出执行证明且零skip。0029 named真实MySQL套件 **9/9**并由独立required wrapper证明执行，覆盖trusted reference原子捕获/失败回滚、并发claim、租约/身份fence、exact ACK replay、terminal seal/cutover及跨tenant隔离。
- broad cluster **7 files / 26 passed**，T3g精确no-skip cluster另为 **3/3**。SDK隔离包验证 **18 files**；runner约 **10003 KB**（`main.js + blob-storage-migrate.js`）与router约 **835 KB**的Node 24 bundle构建通过，mover plain-Node artifact为 **1,600,958 bytes**，bundled runner/router的readiness、tenant/platform auth边界、转发和OpenAPI smoke均通过。
- 完整验证首次暴露七个T3d及下游测试夹具仍按pre-0026顺序直接推进T3a：MySQL因缺少精确inventory sidecar而fail closed，Memory固定假时钟则落后credential high-water。修复只调整测试rollout与可信时钟，不放宽生产校验；七文件合并回归 **71/71**，随后主套件、named Memory/MySQL与完整`verify`全部通过。
- 从并发正确性、事务回滚、滚动升级兼容、安全隔离和测试有效性完成独立复核，最终 **P0=0、P1=0、P2=0**。同一source只能发布一个精确target/operation；claim lease与adapter mutation之间重新取得fresh fleet proof；响应丢失只允许完整身份的exact replay；SQL/序列化失败整体回滚；跨tenant读取保持隐藏；provider factory/source/plaintext buffer在成功和失败路径清零，异常统一清洗；未知`trg_target_exec_%` trigger会阻断marker-loss replay。pre-0029进程必须排空后才允许forward-only cutover。

### 当前边界、风险与下一步

- M2冻结结论不变；本轮仍属于M1，没有开始M3。0029闭合的是external target的协议、账本、Memory fake与执行编排正确性，不是实际远端provider验收。真实provider adapter、remote IAM/权限/速率限制/厂商revoke语义尚未实现；KMS target固定不可执行，所以receipt固定`kmsKeyExecutionComplete=false`、`allDomainsComplete=false`、`contentPurgeExecuted=false`，M1仍不能冻结。
- fake state只在显式共享的进程内Memory测试中持久，不可用于MySQL、多进程、staging或production。未来真实adapter必须提供稳定inspect-before-apply、exact operation id、response-loss重读、bounded deadline、敏感错误清洗与最小权限，并在staging对目标provider逐一验收；不能把本地fake evidence迁移或伪装成真实ACK。
- 后续M1仍需backup/独立故障域restore ledger、logs/traces、generic user物理purge与terminal completion聚合；真实KMS/Secret、managed MySQL/Redis/对象存储、registry/promotion、Kubernetes/VM、域名/TLS、备份恢复、容量与告警继续等待实际资源。完成这些可本地实现的协议/账本切片及真实环境验收后，才可正式冻结M1并进入M3。

## 2026-10-10（M1 数据生命周期：0030 independent tenant restore journal/runtime lineage）

### 已完成

1. 新增default-dormant、expand-only的`0030_tenant_restore_journal.sql`，以及Memory/MySQL一致的tenant restore journal、runtime lineage和永久restore fence。journal启用后，新T1 admission与首条publication在同一Memory原子发布或MySQL事务中提交；历史generation-0 T1仍保持公开replay/status兼容，并由独立materializer精确补齐。generation-0首次请求继续返回`202`；generation-1的新建、exact replay与专用replay在terminal publication receipt可读前均返回可重试`503`，调用方必须保留完全相同的tenant、body和idempotency key。
2. runner内嵌journal publisher，通过独立S3-compatible namespace发布hash-linked、create-only且带checksum的完整性envelope；ACK必须绑定exact target、epoch、sequence、previous/root digest和对象identity。逆序ACK只进入dependency-pending，前向gap保持retry-only；每次ACK前动态重读journal control。全部已配置target ACK、runtime projection和terminal receipt必须同时成立后才允许T3a，不得用局部ACK伪造完成。
3. 新增runner镜像内的一次性`restore-ledger-reconcile` CLI，支持`status/activate-journal/prepare/replay-fences/verify/activate-runtime/abort/run`。`run`只执行prepare/replay-fences/verify，不自动激活runtime；激活必须在停写、排空旧进程、确认`RESTORE_JOURNAL_PRIMARY_ACTIVATION_ACK`与`RESTORE_FLEET_STOPPED_ACK`两项operator确认和显式Blob backend分离后单独执行。恢复后startup preflight会对journal head、runtime known/head/control与永久tenant fence进行收敛或fail closed，避免回滚后的写入复活。
4. verify-only连接不会执行DDL；当前marker会精确验证12张表、226列、50个索引、17个CHECK、65个constraint、14个外键及39个trigger body。runner、restore CLI和历史marker-loss replay都拒绝弱同名schema、未知owned trigger或任一trigger body漂移。真实`0029→0030`夹具覆盖default dormancy、业务数据保持、DDL断点/marker-loss收敛、exact schema fingerprint、rollback与永久guard。
5. journal durable target identity绑定受控region，以及规范化custom endpoint或standard-endpoint sentinel。内部S3 client忽略进程级provider endpoint覆盖，并关闭FIPS、dualstack、accelerate、global endpoint、ARN/MRAP与跨region redirect；`activate-journal`要求primary-activation与fleet-stopped两项operator确认和显式Blob backend，S3 Blob bucket还必须与journal bucket不同。当前MinIO验证使用独立bucket/prefix，但仍不宣称同一台本机是独立故障域。
6. 产品常驻服务和镜像仍只有`agent-router`、`agent-runner`两个。runner bundle/image新增`restore-ledger-reconcile`，连同既有`blob-storage-migrate`均是operator显式调用的一次性入口，不是第三、第四个daemon或镜像。GitHub CI和本地构建继续输出Node ESM bundle与两个Linux OCI image，不是Windows/Linux原生二进制。
7. 最终审查修复了一个MemoryStore兼容性问题：journal激活后、历史generation-0 T1尚未materialize时，公开request replay/status现在只校验原始admission proof而不会误报500；内部materializer/runtime/content路径仍要求严格publication proof，T3a仍在terminal receipt前fail closed。新增Memory、真实MySQL和真实runner HTTP回归覆盖该窗口、tenant隔离、exact materialize及回滚。

### 本轮验证与审查

- `scripts/local-service.sh verify`在最终代码上完整通过（exit 0）：`pnpm check:secrets`扫描 **444 files**，OpenAPI/生成SDK漂移检查、`pnpm typecheck`与SDK隔离包检查通过；主套件 **134 files passed / 4 skipped、1650 passed / 26 skipped**。四个条件skip文件分别是真实付费模型E2E（1项）、主套件未显式启用MinIO时的Blob S3（10项）、mover（11项）和restore journal S3（4项）；后三者均由`verify-s3` required wrapper真实执行。覆盖率 **78.23% statements / 74.33% branches / 84.25% functions / 81.21% lines**，MySQL store **81.21% lines**，Redis lease adapter **100% lines**，Redis purge adapter **90.14% lines**。
- 固定真实MySQL历史升级链 **23 files / 149 passed**，其中`0029→0030` **16/16**；原`0007→0008` **2/2**仍实际证明相同usage重复可安全合并、内容冲突会阻断且两行账目保留、legacy pending receipt保留。required wrapper逐文件证明目标实际执行且零skip。
- tenant restore journal的Memory与真实MySQL named套件分别 **12/12、19/19**。MySQL覆盖verify-only零DDL、marker/schema/trigger漂移拒绝、历史T1兼容/materialize、T1+publication原子提交、ACK/runtime projection回滚、T3a回滚、统一锁序、逆序ACK收敛、concurrent admission序列化、永久fence与tenant隔离；runner HTTP回归另证明generation-0 `202`与激活后publication-pending `503`语义。
- `scripts/local-service.sh verify-s3`通过真实MinIO Blob adapter **10/10**、restore journal S3 **4/4**、真实MySQL+MinIO mover **11/11**及源码应用装配smoke。broad cluster **8 files / 28 passed**，T3g精确no-skip cluster另为 **3/3**。构建验证SDK隔离包 **18 files**、runner约 **16004 KB**（`main.js + blob-storage-migrate.js + restore-ledger-reconcile.js`）、router约 **849 KB**，mover artifact **1,615,110 bytes**、restore artifact **3,583,325 bytes**，并通过bundled readiness、tenant/platform auth边界、转发与OpenAPI smoke。
- 从并发正确性、事务回滚、滚动升级兼容、安全隔离和测试有效性完成独立复核，最终 **P0=0、P1=0、P2=0**。本轮没有改变provider方言或公开真实模型网络契约，因此没有重复运行会产生费用的`verify-real`或十阶段acceptance；最近真实模型 **1/1** 与acceptance通过只保留为历史基线，不冒充本轮结果。

### 当前边界、风险与下一步

- M2冻结结论不变；本轮仍属于M1，没有开始M3。0030建立的是独立journal协议、恢复编排、runtime lineage和永久fence，不是完整backup/DR产品：当前只有一个journal target，MySQL与对象写仍是可重放saga，双ACK是人工提供，激活前的head-read到DB commit仍有TOCTOU窗口；如果所有独立证据同时回滚，epoch仍存在ABA边界。公开tenant terminal状态不因此变为全域完成，所以M1仍不能冻结。
- 当前扫描/重放对大历史量存在近似O(n²)风险；deadline主要是逐请求而非整个operator动作；39个trigger虽做exact fingerprint，但没有对每个auto-commit位置逐一故障注入。相同本地MinIO中的不同bucket/prefix用于真实协议验证，却不是生产独立故障域。真正staging仍需独立账号/region或等价隔离、IAM/KMS、容量/延迟、备份恢复演练、真实N-1 rollout和operator审批链。
- 下一独立M1切片是`0031` backup catalog：把可恢复backup集合、source snapshot identity、journal/runtime epoch绑定、保留/淘汰与restore选择做成默认关闭、可审计且本地/CI可故障注入的协议。随后仍需logs/traces、generic user物理purge、KMS/真实provider适配及全域completion聚合；云MySQL/Redis/对象存储、registry/promotion、Kubernetes/VM、域名/TLS和监控告警继续等待真实资源，仓库不得编造参数。

## 2026-10-10（M1 数据生命周期：0031 authoritative backup catalog）

### 已完成

1. 新增default-dormant、expand-only的`0031_authoritative_backup_catalog.sql`。它只安装write-once control、完整`backup_catalog_external_events` mirror、不可变snapshot anchor/catalog entry、restore source binding、永久runtime reservation和eviction tombstone账本及guards；migration不访问对象存储、不创建/删除backup、不激活control、不选择restore source或epoch，也不推进tenant erasure completion。external mirror是完整content-free chain的sequence/hash唯一authority。
2. Memory/MySQL实现同一原子store契约：`begin-backup`要求fleet-stopped，先完整验证/镜像external chain，再在数据库时间点把active runtime、journal control/head、schema migration root、Blob control/namespace、retention policy及source catalog sequence/root绑定进anchor。`publish-backup`只校验digest格式、target/chain identity，并把backup producer/operator独立核验后提供的artifact manifest/provider evidence digest绑定到availability event；adapter不读取或验证backup bytes、manifest或provider内容。序列化、SQL、source drift、catalog conflict或响应丢失不得留下部分mirror、anchor、entry、binding、reservation或eviction。
3. restore不再接受游离的operator backup digest作为来源authority。首次`prepare-restore`必须在物理恢复前选择仍可恢复、未淘汰且具有exact local anchor的catalog entry，在外部create-only immutable event chain + `If-Match` CAS authority head上永久预留never-used runtime epoch，并把source binding、reservation和0030 restore run/target准备放入同一Memory原子边界或InnoDB事务。旧数据库快照恢复并升级验证后，operator必须从数据库故障域之外取回同一backup/run/epoch ID、source evidence和target identity，再次执行0031 `prepare-restore`：完整external mirror可重建availability，reservation exact replay再原子建立binding/reservation/run；active catalog会拒绝此前直接执行的普通0030 `prepare`。缺selected anchor的更早/错误snapshot会fail closed，但另一个更晚且合法的数据库snapshot也可能仍包含该anchor，应用不能据此证明恢复bytes就是selected制品，必须由producer/operator独立核验物理snapshot/provider evidence与source digest。成功激活或中止后追加exact external resolution；只有匹配的本地reservation与terminal 0030 run存在时才投影本地`activated/aborted` phase，否则该event只保留在external authority，任何epoch均不能复用。
4. retention/eviction同时校验数据库时间、active policy digest、最短保留期、最少可恢复backup数、当前catalog head和活动restore reservation。物理制品删除仍由外部受控流程完成；operator必须独立确认制品不存在并提供content-free absence acknowledgement，adapter只校验/绑定该摘要，随后才追加不可变eviction event并建立本地投影。dead-letter或“准备删除”不能冒充完成；`prepare-eviction`到`record-eviction`之间仍没有durable two-phase intent。
5. S3-compatible catalog adapter使用content-free、create-only、连续sequence/hash-root事件对象，并以单一`If-Match` CAS head作为权威尾部；它不依赖LIST推断head，event已写但head响应失败时会由精确`GET(head+1)`收敛。启动同时探测`If-None-Match: *`和陈旧ETag `If-Match`拒绝，旧布局或不满足条件覆盖语义的target会fail closed。adapter支持exact replay、并发loser重读、fork/corruption拒绝。`reconcile`完整验证并镜像所有external events，缺少某个local anchor不会阻断后继sequence/hash校验与mirror；availability/eviction acknowledgement可由mirror重建本地投影，resolution则受匹配的本地reservation与terminal 0030 run约束。mirror不会猜造control、anchor、binding/reservation、0030 journal/fence/run、业务数据或backup bytes；selected backup仍必须有exact local anchor。缺anchor快照已有external reservation时，当前没有external-only orphan abort入口，只能由operator恢复并独立核验selected物理snapshot后按同一operation继续。
6. `backup-catalog`是runner镜像内一次性前台CLI，命令为`status/activate/begin-backup/publish-backup/list/prepare-restore/resolve-restore/prepare-eviction/record-eviction/reconcile`；不新增daemon、产品服务或镜像。active 0031 trigger会阻断pre-0031 writer创建unbound 0030 run，但这只是fail-closed护栏，仍须排空旧writer、保持fleet-stopped并以单一catalog operator串行。长期router/runner剥离全部catalog原始authority和操作变量；router只通过runner capability观察公开namespace/target/runtime-binding digest。
7. 本地/CI门禁加入`0030→0031`真实MySQL历史升级、Memory/MySQL catalog store、真实MinIO adapter、构建后CLI和runner-image `--help`、最新migration marker以及S3源码应用装配。独立required-suite用真实`mysqldump`/`mysql`、真实MySQL和两个MinIO bucket/prefix覆盖B1 anchor快照、B2后继availability、B1外部reservation、物理回滚、0030直接prepare拒绝、0031相同operation authority重建及后续seal/activate/resolve。固定历史链现为`0007→...→0031`；同一MinIO中的第三个catalog bucket只证明协议和隔离配置，不是生产独立故障域。

### 定向验证与最终核准

- 已确认的无网络0031定向矩阵 **6 files / 49 passed**，其中Memory catalog store **9/9**；真实MySQL catalog **13/13**，`0030→0031`真实MySQL迁移夹具 **16/16**。随机测试库/prefix的真实MySQL+MinIO one-shot CLI reconcile **1/1**，证明page size `1`完整分页、全event mirror、exact replay及缺local anchor不阻断后继authority；真实`mysqldump`旧快照restore roundtrip **1/1**，证明selected anchor、external reservation replay、本地authority重建、0030 seal/activate及0031 resolution链路。
- `scripts/local-service.sh verify-s3`已完整通过：Blob S3 adapter **10/10**、restore journal S3 **4/4**、backup catalog S3 **6/6**、CLI reconcile **1/1**、old-snapshot roundtrip **1/1**、真实MySQL+MinIO mover **11/11**及源码应用装配smoke。该结果证明本机真实S3-compatible协议和编排，不证明同机MinIO是生产独立故障域。
- 最终代码上的`pnpm check:secrets`扫描 **466 files**，OpenAPI/生成SDK漂移检查、根`typecheck`和SDK隔离包检查均通过。`scripts/local-service.sh verify`以Node 24完整通过：主套件 **141 files passed / 7 skipped、1717 passed / 34 skipped**；七个条件skip文件分别是真实付费模型E2E（1项）、Blob S3（10项）、mover（11项）、restore journal S3（4项）、backup catalog S3（6项）、catalog reconcile（1项）和旧快照roundtrip（1项），后六类均由最终`verify-s3` required入口真实执行，不能解读为未验证。覆盖率 **78.66% statements / 74.74% branches / 84.73% functions / 81.55% lines**，MySQL store **81.55% lines**，Redis lease **100% lines**，Redis purge **90.14% lines**。
- 固定历史升级矩阵 **24 files / 165 passed**，逐段覆盖`0007→...→0031`；其中`0007→0008` **2/2**实际证明相同usage重复安全合并、内容冲突重复阻断且不丢账、legacy pending receipt保留，`0030→0031` **16/16**覆盖default dormancy、DDL中断/marker-loss、NULL protocol拒绝、旧writer guard和严格schema/trigger fingerprint。broad cluster **8 files / 28 passed**，T3g精确no-skip cluster **3/3**。
- 构建验证SDK隔离包 **18 files**；runner bundle约 **22242 KB**，含`main.js`、`blob-storage-migrate.js`、`restore-ledger-reconcile.js`、`backup-catalog.js`四个入口，router bundle约 **856 KB**、只有`main.js`。三个plain-Node维护artifact分别为 **1,618,985 / 3,742,299 / 3,806,465 bytes**，dist readiness、tenant/platform auth边界、转发与OpenAPI smoke全部通过。GitHub Actions两个Linux OCI image job的最终结果在本次提交推送后核准。
- 已从并发正确性、事务回滚、滚动升级兼容、安全隔离和测试有效性完成最终独立复核，当前树 **P0=0、P1=0、P2=0**。本轮未改变provider dialect或公开真实模型网络契约，因此没有重复运行会产生费用的`verify-real`或十阶段acceptance；最近真实模型 **1/1** 与acceptance通过仅保留为历史基线，不冒充本轮重跑结果。

### 当前边界、风险与下一步

- 0031闭合的是本地/CI中的权威backup选择、snapshot lineage、retention、source binding和外部epoch reservation协议，不是物理数据库backup producer、跨区域复制服务或全自动DR。当前仍是单catalog target；MySQL与S3是exact-idempotent saga而非分布式事务，0030 activation前external-head读取到DB commit仍有TOCTOU窗口，外部制品创建/删除与最终resolution也需要受控operator流程。永久epoch reservation只在独立catalog证据存续时关闭复用；catalog故障域本身尚未在真实环境证明。真实独立账号/region、IAM/KMS、RPO/RTO、容量/费用、whole-operation deadline、真实维护窗口和灾难恢复演练必须在staging用实际资源验证。
- 通用`reconcile`只要求恢复库仍有active且identity匹配的0031 control：它验证完整external chain并把所有content-free event写入authoritative mirror，某个local anchor、binding/reservation或0030 run缺失不会截断后继sequence/hash authority。availability与eviction acknowledgement可从mirror的完整event摘要重建本地投影；resolution只有在本地reservation和terminal 0030 run精确匹配时才投影，否则只保留external authority。它不会重建control/anchor、source binding/reservation、0030 journal/fence/run、业务数据或物理backup bytes；受控restore仍要求selected backup的exact local anchor，缺anchor快照必须恢复正确物理snapshot，而仍含anchor的更晚snapshot只能由operator外部证据区分。已有external orphan reservation当前也没有external-only abort路径。
- eviction从`prepare-eviction`前到外部物理删除及`record-eviction`成功提交后必须持续停服全部writer与其它catalog operator，两条命令均要求`RESTORE_FLEET_STOPPED_ACK=1`。ACK只是人工声明，当前prepare不写durable two-phase eviction intent；如果运维错误恢复并发writer，record虽会按head/reservation重验并fail closed，但外部对象可能已经删除，仍需后续可恢复的两阶段账本闭合。
- backup catalog记录的是整库可恢复集合，不会自动证明某个已擦除tenant在所有保留backup、日志、追踪和其它外部domain中都已完成处置，也不改变任何terminal completion flag。真实provider adapter与KMS、其它domain恢复/erasure证据、logs/traces、generic user/session物理purge和最终completion聚合仍缺失，所以M1仍不能冻结；M3/M4也尚未开始。
- 本地手动体验不必等到M1/M3/M4全部结束：普通runtime、SSE、router/runner、多节点和每个安全切片应持续做阶段性smoke；待“整个架构”的local/CI实现范围收口后，再做一次完整walkthrough。没有云资源不会阻止继续实现协议、store、迁移、CLI、故障注入和OCI候选镜像，但不能把本地MinIO/MySQL/Redis结果外推为staging/production环境验收，也不能编造云部署参数。

## 2026-10-11（M1 数据生命周期：0032 telemetry safety / dormant inventory substrate）

### 已完成

1. 新增`0032_tenant_telemetry_lifecycle.sql`。migration只安装generation `0` control、固定`logs`/`traces` target、per-tenant coverage及T1-bound subject evidence四类严格schema和10个write-once/append-only/source-binding trigger；subject insert会精确绑定admission、T1 fence、coverage、active control及DB-time high-water，拒绝跨tenant或拼接证据。它不激活tracking、不生成HMAC key、不扫描或回填legacy tenant、不联网、不连接sink、不删除遥测，也不推进任何erasure completion。
2. 新增content-free类型/证据契约：target固定`logs=0`、`traces=1`，target root必须精确包含两个域；control activation、coverage和subject receipt均绑定generation、owner tuple、DB time、target root与上游T1/coverage evidence。`subject_ref_sha256`直接复用runtime keyed tenant opaque-ref的HMAC-SHA256摘要算法，ledger不保存key、原始log field、URL、header、locator或正文。
3. 新增独立`0031→0032`真实MySQL历史夹具，并纳入required migration manifest。夹具冻结校验`0001..0031` SQL摘要，从预置0031数据库验证旧tenant/admission/fence/catalog行逐字段保留，0032保持dormant且三类明细表为空；覆盖严格schema/index/CHECK/FK/10-trigger inventory、首/中/末CREATE TABLE auto-commit断点收敛、同名弱表fail-closed、marker-loss source-binding trigger修复、跨owner/generation/fence/coverage/time拼接拒绝及append-only证据。该夹具不是fresh-schema替代品，CI wrapper会拒绝缺失、skip、零断言或非pass。
4. 新增`agent-service.telemetry.v1`安全入口：闭合event code/field allowlist、固定`errorKind`、HMAC domain-separated `oref_*`与共享64位digest helper。product runner向SessionHost/内嵌worker注入content-free兼容logger并丢弃旧Console动态参数；router/runner/provider默认路径不再写原始tenant/user/session/owner、runner URL/list、provider ID、request/header/body或`Error` message/stack，Hono未知异常也只记录固定事件并返回固定500。失权路径会先完成fence/closing/abort/approval失败等安全状态更新，再以无字段`runner.runtime.ownership_lost`最多报告一次；logger或sink抛错也不会逃逸并改变失权语义。第三方SDK/Node绕过应用logger的自行输出仍不在本切片保证内。
5. 外部`traceparent`只接受严格W3C version `00`、小写且非全零的trace/span ID；其它输入生成fresh root。router→runner→provider每跳生成child span，剥离`tracestate`与`baggage`，AsyncLocalStorage只在当前异步request链传播。trace ID不是owner ref、idempotency key、claim token或删除证明。
6. first-admin bootstrap不再把key打印到stdout/stderr。`ADMIN_BOOTSTRAP_TENANT`必须与绝对路径`ADMIN_BOOTSTRAP_OUTPUT_FILE`成对出现，并与开发用`BOOTSTRAP_API_KEY`互斥；runner用`wx`、`0600`、文件与父目录`fsync`创建一次性文件，已有文件拒绝覆盖，同一路径并发writer只有一个成功。文件写入后数据库失败时保留文件并fail closed，交由operator核对，不能自动删除或重新生成。router与本地/cluster验证边界会清除/拒绝该runner-only authority。
7. 新增`docs/design/05-observability.md`，并把本地手动体验、CI镜像bootstrap与历史迁移说明同步到长期学习材料。CI继续只构建runner/router两个Linux OCI产品镜像；0032没有新增daemon、服务、bundle、端口或镜像。

### 本轮验证与审查

- `scripts/local-service.sh verify`完整退出`0`：secret scan覆盖474个文件，OpenAPI/SDK drift与TypeScript类型检查通过；主套件为144个文件通过、7个文件按环境显式跳过，合计1742 passed / 34 skipped，coverage为statements 78.82%、branches 74.87%、functions 84.92%、lines 81.69%。本轮没有把显式依赖真实provider或MinIO的跳过项冒充为执行成功。
- 独立历史迁移门禁为25个文件、171个测试全部通过，其中`0031→0032`真实MySQL夹具6/6、既有`0007→0008`夹具2/2；命名的0032生命周期契约套件4/4。required wrapper同时证明这些套件存在、非skip、断言数非零且确实pass。
- broad cluster为8个文件、28个测试通过，T3g exact cluster为3/3。takeover回归以精确结构化`runner.runtime.ownership_lost`替换旧明文日志断言；SessionHost使用两个真实失权入口证明单active turn只报告一次，并以会抛错的callback验证观测失败不会越过安全边界。
- build验证生成18-file SDK隔离包；runner bundle约22266 KB，含`main.js`、`blob-storage-migrate.js`、`restore-ledger-reconcile.js`、`backup-catalog.js`四个入口，router bundle约871 KB且只有`main.js`。三个plain-Node维护artifact分别为1,619,742 / 3,743,056 / 3,807,225 bytes，dist readiness、认证边界、转发与OpenAPI smoke通过。
- 已完成独立最终复核，结论为P0=0、P1=0、P2=0，可提交。因本轮没有改变provider公开dialect或真实模型网络契约，没有重复运行会产生费用的`verify-real`或十阶段acceptance；最近真实模型1/1与acceptance通过只保留为历史基线，不冒充本轮结果。

### 当前边界与下一步

- 0032只闭合安全写入/trace入口和dormant inventory schema，不实现activation/store原子写、writer dual-write、sink adapter、delete/crypto-shred/anonymize operation、claim/lease/ACK、response-loss replay、legal-hold重验或restore marker。stdout JSON不是“可删除的日志后端”；T3d的`logs`/`traces`仍必须保持blocker，所有terminal receipt继续固定`allDomainsComplete=false`、`contentPurgeExecuted=false`。
- 下一切片应在新的expand-only migration中实现Memory/MySQL原子activation与inventory写入，再实现本地HTTP/fake sink的删除ledger/worker和restore replay；只有协议、rollback、并发与mixed-rollout通过后，才能在有真实资源时接managed log/trace backend。generic user/session purge仍应排在telemetry删除proof之后，不能先扩大删除authority。
- 当前opaque-ref key为进程内随机安全默认值，适合防止stdout泄露，但不会跨重启形成durable owner identity；未来activation必须显式绑定受保护、可轮换的key material及`ref_key_id_sha256`，并排空旧writer后才能声称`complete_since_creation`。不得把ephemeral日志ref直接补造为0032 coverage。
- first-admin文件在单个共享filesystem上只有create-only互斥，不是跨VM/容器singleton。production rollout必须只让一个受控one-shot实例配置它；长期应提升为带数据库singleton claim的独立CLI/Job。真实Secret manager、Kubernetes/VM mount、IAM/KMS与审计仍等待实际环境参数。
- M1仍未冻结，M3没有正式开始，M4主体也没有开始。本轮只是按依赖顺序关闭logs/traces的安全入口与inventory前置条件，不代表完整可观测性平台或生产部署完成。

## 2026-10-11（M1 数据生命周期：0033 telemetry activation / artifact inventory）

### 已完成

1. 新增default-dormant、expand-only的`0033_tenant_telemetry_activation_inventory.sql`。它只安装write-once activation receipt与immutable artifact inventory及精确schema/trigger fingerprint；migration不激活control、不生成或读取protected ref key、不扫描或回填tenant/artifact、不联网、不配置sink，也不执行delete/ACK/restore/completion。固定历史升级链延伸为`0007 → ... → 0032 → 0033`。
2. Memory/MySQL实现同一原子store contract：activation把精确32-byte protected ref key identity、固定`logs`/`traces`双target、当时全部canonical tenant的`legacy_history_unknown` coverage、activation receipt和control `0 → 1`放在同一Memory publication或`SERIALIZABLE` InnoDB事务。序列化失败、SQL故障、并发loser或response loss不留下部分target/coverage/receipt/control，只允许exact replay。
3. activation与首次tenant writer按`lifecycle → control → coverage`锁序线性化。writer先赢时activation把tenant冻结为legacy；activation先赢时首次tenant lifecycle与`complete_since_creation` coverage及业务source同事务创建，并把落后的调用方时间抬到activation DB-time high-water。已存在durable footprint却没有lifecycle、active control下缺coverage或mixed-writer缺口都会fail closed，公开coverage getter和注册路径不会“顺手修复”坏状态。
4. MySQL启动在`REPEATABLE READ WITH CONSISTENT SNAPSHOT`中重建activation request、固定target root、全部coverage root和source closure，并校验receipt/key/time分类及六张表的精确fingerprint。receipt/coverage丢失、target/root/key漂移、legacy/complete时间关系错误或孤立source都会阻止启动；inactive状态也要求所有0032/0033 projection为空。
5. immutable artifact inventory绑定全局external identity、tenant partition、opaque tenant/owner/hold ref、target/coverage、policy/legal-hold/restore projection、source high-water及payload/manifest digest，不保存protected key、正文、URL、header、credential或明文locator。新写会重验tenant/user/session owner与gate；owner后来gated/deleted时仍允许同一identity的response-loss exact replay，但任一owner/source/payload/manifest漂移或跨tenant双领都会冲突。
6. `scripts/local-service.sh verify`、GitHub Actions、required migration manifest、dist/runner-image marker和源码应用装配均已接线三个命名telemetry suite与最新0033 migration。它没有新增daemon、服务、端口、JavaScript bundle入口或OCI镜像；产品发布物仍只有router/runner两个长期服务、五个JavaScript入口和两个Linux OCI image。

### 完整验证与独立审查

- content-free evidence helper **6/6**；Memory activation/coverage/inventory **9/9**；真实MySQL rollback/concurrency/startup/isolation **9/9**（含active telemetry下并发tenant admission与Unicode collation alias owner-hiding回归）。
- 固定真实MySQL历史升级矩阵 **26 files / 177 passed / 0 skipped**，其中`0032 → 0033` **6/6**；既有`0007 → 0008`夹具继续实际覆盖相同usage重复安全合并、内容冲突阻断且不丢账、legacy pending receipt保留。
- `scripts/local-service.sh verify`完整退出`0`：secret scan覆盖**478 files**，OpenAPI/SDK drift与TypeScript类型检查通过；主套件为**146 files passed / 7 skipped、1762 passed / 34 skipped**，coverage为statements **78.85%**、branches **74.81%**、functions **85.09%**、lines **81.69%**。34个skip仍是显式依赖真实provider或MinIO模式的条件项，没有冒充本轮执行成功。
- broad cluster为**8 files / 28 tests**，T3g exact cluster为**3/3**；SDK隔离包为**18 files**。runner bundle约**22706 KB**，含`main.js`、`blob-storage-migrate.js`、`restore-ledger-reconcile.js`、`backup-catalog.js`四个入口；router约**871 KB**且只有`main.js`。三个plain-Node维护artifact分别为**1,619,820 / 3,833,443 / 3,897,612 bytes**，dist readiness、认证边界、转发与OpenAPI smoke全部通过。
- 后续deadlock与Unicode alias修复完成后，独立只读review再次从并发正确性、事务回滚、滚动升级兼容、安全隔离和测试有效性复核，结论为**can-submit，P0=0、P1=0、P2=0**。本轮未改变provider dialect或公开真实模型网络契约，因此不重复运行会产生费用的`verify-real`或十阶段acceptance；最近真实模型1/1与acceptance通过仍只作为历史基线。

### 当前边界、风险与下一步

- 0033只闭合default-dormant activation/coverage/artifact inventory authority，不代表stdout/trace已进入受管sink。长期router/runner没有activation环境gate、writer双写、真实sink adapter、delete/ACK worker或restore replay；T3d的`logs`/`traces`仍是blocker，所有terminal completion固定false，所以M1仍未冻结，M3/M4仍未正式开始。
- production activation必须先排空全部pre-0033 writer，让所有新进程共享同一受保护ref key与固定target identity，再由受控one-shot operator激活并核对全fleet startup audit；首个activation/inventory后只能forward-fix。本切片没有fleet attestation，标准local-service/production均保持inactive。
- 后续测试深度可补合法active marker-loss migration replay、telemetry-active → 完整T3f → reopen跨切片回归，以及两个并发相同首次artifact INSERT的deadlock/retry语义。Memory审计也可增加显式tamper路径验证legacy lifecycle时间不晚于activation；合法API路径当前由activation high-water保证。
- activation的全tenant范围锁、startup一致性快照扫描与artifact索引需要在staging用真实规模验证容量、锁等待、死锁和超时。下一M1切片仍应优先实现本地可验证的telemetry fake/HTTP sink writer、delete ledger/worker、ACK与restore replay，再继续generic user/session purge、真实provider/KMS及全域completion；不能提前转入M3。

## 2026-10-11（M1 数据生命周期：0034 managed telemetry durable writer substrate）

### 已完成

1. 新增default-dormant、expand-only的`0034_tenant_telemetry_durable_writer.sql`。它安装writer job、短期payload、write-once external-mutation-start reservation、immutable ACK及精确source-bound guards；migration不激活0032 control、不扫描或回填历史遥测、不创建job/reservation、不联网、不配置或调用sink，也不执行delete、restore或completion。固定历史升级链延伸为`0007 → ... → 0033 → 0034`。
2. 闭合payload-before-sink与producer provenance不变量：Memory/MySQL对live enqueue的顶层字段、payload字段、records引用、数组长度和每个slot执行单次capture，在任何clone/serialization前要求同一批原始record由`createStructuredTelemetry`实际生成并冻结；进程内`WeakMap`记录producer key-id并要求它与active lifecycle ref key一致。每条record必须携带exact tenant ref，user/session owner还必须同时携带exact owner ref；任一其它tenant/user/session ref、wrong-key、无owner、语法合法literal或伪opaque ref都不能进入spool且零持久化写入。随后只使用复制的标量与detached canonical payload，不再重读caller getter/Proxy；logger emit也只接受同一实例`opaqueRef()`产生过的ref。持久化后的read/claim/adapter继续按闭合`agent-service.telemetry.v1` schema、payload/hash验证完整性而不依赖跨进程标记。batch受数量与字节上限约束；store在同一原子边界重验active control、target、coverage、owner/source/high-water并写入job+payload。adapter不能在durable spool提交前得到create输入。公网router同时改为每个外部request生成fresh internal trace root，不再把caller提供的合法trace ID写入structured record或向runner传播。
3. Memory/MySQL store实现enqueue、按`adapterProtocol`过滤的claim、lease/renew、retry/block、reservation和terminal complete，使logs/traces可合法使用mixed adapters而不被错误worker领走。首次external create前，store在同一Memory原子发布或MySQL事务中重验tenant T1、user/session lifecycle、canonical policy/hold、restore lineage与source high-water，并持久化绑定operation/target/payload/claim/adapter的write-once reservation。
4. reservation提交后只允许相同operation/target/payload的exact inspect/create/completion replay；T1之后拒绝新enqueue和未reservation的首次external mutation，但已reservation、可能已外部commit的operation仍可按原identity收口。terminal complete要求live/exact claim及reservation，并在同一原子边界发布0033 immutable inventory、0034 ACK、`written` job并删除短期payload；ACK必须绑定reservation，数据库响应丢失只能重读ACK后精确重放。
5. worker使用create-only `inspect → create → inspect`协议收口外部commit与响应丢失窗口；create一旦调用，任何异常（包括2xx畸形、超限或target-unbound响应）都先续租并做一次exact inspect，remote exact则完成ACK，absent才按原错误retry/block，单个attempt绝不盲目二次create。全部告警经过no-throw边界，logger失败不能改变claim/retry/block/poll/close语义。Memory adapter要求显式非生产fixture标志；HTTP adapter拒绝redirect、embedded credential、越界/非JSON响应并受整体deadline约束，只接受分号参数前精确为`application/json`的media type。HTTP构造要求显式`expectedTargets` allowlist，wire request/response双向绑定`targetSha256 + targetReceiptSha256`；这只是client endpoint/target配置绑定，不是sink server、collector或managed backend验收。
6. MySQL启动将0033 activation/inventory与0034 writer的全部schema、index、CHECK、FK和trigger guard作为组合指纹核对；marker-loss、不完整queued payload、reservation/ACK/inventory关系损坏或其它不一致投影均fail closed，不由启动审计补造。
7. required migration manifest、本地verify/CI接线、dist和runner-image migration marker均延伸到0034。它没有新增daemon、服务、端口、JavaScript bundle入口、维护命令或OCI镜像；产品交付和本地手动体验仍只有`agent-router`与`agent-runner`两个长期服务、五个JavaScript入口和两个Linux OCI镜像。
8. active 0033滚动升级缺口已按fail-closed方式收口：0034为`tenant_credential_revocation_jobs`安装`BEFORE INSERT` guard，当前writer先写精确telemetry subject再写T1 job；仍在运行的0033 writer会在job边界失败并回滚整笔T1。guard轮换使用scoped bootstrap twin；仓库迁移器只对固定bootstrap执行exact verify-or-create，存在但shape/body漂移即fail closed，随后才drop/recreate primary并移除bootstrap，因此drop-primary后崩溃重放也始终至少保留一道guard。若升级前已经提交缺subject的T1，普通startup拒绝继续；专用DDL-free `migrationMode: "reconcile-telemetry-subjects"`要求active control的精确32-byte ref key，以及`tenant-erasure-admission-closed-v1`、`pre-0034-telemetry-writers-drained-v1`、`all-application-writers-stopped-v1`三个字面量ACK。operator必须真实关闭admission、排空旧writer并停止全部应用writer；ACK只是人工声明。reconcile持有与migration相同的named lock，以SERIALIZABLE事务先全量验证T1 proof、coverage、subjects和writer projection，再一次性补齐全部missing subject并重验全局closure；任一错误零写入回滚，exact replay安全。未来migration Job必须复用仓库迁移器的bootstrap verify-or-create语义，不能使用朴素SQL splitter。当前只有store连接模式，没有CLI、bundle或`local-service`入口。

### 验证状态

- `pnpm test:tenant-telemetry-writer`的payload、Memory/HTTP adapter、worker和Memory store门禁 **39/39 passed**；`pnpm test:tenant-telemetry-writer-mysql`真实InnoDB spool/claim/reservation/ACK/T1收口 **13/13 passed**；content-free helper、Memory lifecycle和MySQL lifecycle分别 **6/6、12/12、12/12 passed**。
- `pnpm test:migrations`固定历史链 **27 files / 192 passed / 0 skipped / 0 failed**，其中`0033 → 0034`独立真实MySQL夹具 **15/15**：覆盖active历史gap拒绝、精确reconcile/exact replay、错误key/ACK、损坏proof零写入、current/stale writer、真实post-insert closure回滚、in-flight 0033事务/MySQL metadata lock、DDL断点、marker loss、trigger drift/额外trigger及spool corruption；`0007 → 0008`继续 **2/2**。
- 最终`scripts/local-service.sh verify`通过：主报告 **152 files passed / 7 skipped、1824 passed / 34 skipped / 0 failed**，覆盖率 **78.84% statements / 74.75% branches / 85.17% functions / 81.65% lines**；required suites、cluster主套件 **8/8**、tenant Redis purge cluster **3/3**、SDK隔离包 **18 files**、bundled readiness/auth/forwarding/OpenAPI均通过。runner约 **23355 KB**、包含四个入口，router约 **873 KB**、只有`main.js`；三个维护artifact分别为 **1,621,404 / 3,971,514 / 4,035,683 bytes**。
- 最终`scripts/local-service.sh verify-s3`通过：Blob MinIO **10/10**、restore journal **4/4**、backup catalog **6/6**、catalog reconcile **1/1**、旧snapshot restore roundtrip **1/1**、mover MySQL+S3 **11/11**，源码应用装配也通过。provider路径未变，本轮没有重跑会产生费用的`verify-real`或`acceptance`；其历史基线不能冒充本轮结果。
- 提交前独立复核从并发正确性、事务回滚、滚动升级兼容、安全隔离和测试有效性检查当前diff；发现protocol provenance、SessionHost no-throw cleanup和router公网trace隔离三组关键回归只被broad glob间接覆盖后，已把三个测试文件加入`assert-suites-ran.mjs`的逐文件必跑证明。本轮JSON报告复验为 **11/11、75/75、64/64**，最终结论 **P0=0、P1=0、P2=0**。

### 当前边界、风险与下一步

- 0034只是default-dormant、writer-first substrate。长期router/runner没有0034配置或启动接线，应用event没有dual-write到spool；Memory adapter只是非生产fixture，HTTP adapter只是client协议。真实managed sink、collector/server、fleet activation/gate及生产target验收仍未实现。
- 0034没有telemetry delete/crypto-shred/anonymize worker、restore executor或全域completion authority；T3d的`logs`/`traces`继续保持blocker，所有terminal completion固定false。T1 already-reserved completion只是诚实记录可能已发生的外部create，不是T1后新增写入授权。
- writer job/claim、组合startup audit与索引需要在staging用真实规模验证容量、锁等待、并发、超时和response-loss；真实sink retention/legal hold、delete/restore及跨故障域恢复证据也必须在实际环境验收。
- HTTP adapter有统一request deadline，但未来custom非HTTP adapter尚无统一whole-operation deadline；若同一`adapterProtocol`配置多个endpoint，也还没有完整target routing contract。当前trigger fingerprint不覆盖`DEFINER`、session `sql_mode`或特权DDL主体等数据库管理元数据，production仍必须以最小权限隔离runtime与migration principal并独立监控schema drift。
- M1仍未冻结；M3的MCP/skills/hooks主体和M4生产化主体尚未开始。下一步仍应先完成application dual-write、runner装配、真实sink及telemetry delete/restore evidence，再继续generic user/session purge、真实provider/KMS与全域completion，不能因0034 ACK提前宣布完整遥测生命周期或生产就绪。

## 2026-10-11（M1 数据生命周期：0035 telemetry application capture / runner local sink）

### 已完成

1. `0034` durable writer已接入现有`agent-runner`启动链，并由默认关闭的`TENANT_TELEMETRY_WRITER_ENABLED`保护。当前adapter是本地filesystem：要求显式单runner、私有目录和人工ACK，没有OS级跨进程锁，production配置直接拒绝。deterministic operation staging在exact ACK前清理并fsync，正常durable job replay可恢复；但没有全目录startup sweeper，DB/job非原子丢失仍可能留下staging，属于restore/delete生命周期边界。它不新增daemon、端口、bundle入口或OCI镜像。
2. `0035_tenant_telemetry_application_capture.sql`新增logs/traces分域的application control、activation receipt、tenant coverage与post-cutover write binding，把0033 lifecycle target activation与应用producer cutover拆成两个独立事实。既有tenant记录`pre_cutover_history_unknown`，既有job冻结为unbound；两者均不能事后重标。active domain的新job必须以exact producer contract在同一事务先写binding，binding/job/payload任一失败整体回滚。
3. Memory/MySQL activation支持成功、exact replay和冲突阻断，并与tenant创建及同domain enqueue线性化。activation先赢时新tenant与application coverage同事务创建；enqueue先赢时该job被纳入pre-cutover root并继续只允许无producer的legacy exact replay。MySQL新tenant以blind candidate insert和trigger作为线性化点，随后在同一事务锁定精确subject并发布lifecycle/application coverage；缺行读取不获取跨tenant next-key gap lock，0035轮换的owner trigger用可索引等值缩小范围后再以二进制identity精确复核，因此不同tenant并发首写不会互锁，组合/分解Unicode alias也不能串读。startup会重建control/receipt/coverage/pre-cutover/binding投影并对缺行、漂移或跨tenant关系fail closed。
4. 当前唯一产品producer是`provider.upstream_request_failed` logs exact contract。capture active时owner log只进入durable writer，不再重复stdout；capture inactive时，owner-scoped helper及普通provider/router fallback均剥离全部owner/subject/target refs。traces没有producer contract，runner startup要求其application control保持inactive。
5. required migration manifest把固定真实MySQL链延伸为`0007 → ... → 0034 → 0035`。`0034 → 0035`独立夹具验证旧业务/ledger保持、default dormancy、logs/traces独立、legacy历史与冲突处理、旧writer阻断、partial-DDL/marker-loss收敛和严格schema/trigger fingerprint。GitHub Actions单独运行application-capture Memory与真实MySQL suite，required wrapper要求目标文件实际pass、非skip且断言数非零；dist/runner image检查最新0035 marker。CI仍只构建router/runner两个Linux OCI镜像和既有五个JavaScript入口。
6. 本轮没有activation/operator CLI、managed sink、telemetry delete/restore/retention executor。application capture helper只保护它包围的enqueue，不能把任意业务数据库事务与spool变成跨store crash-atomic提交。因此当前实现不能实际激活后宣称完整coverage，也不改变T3d blocker或任何全域completion。

### 完整验证与独立审查

- `pnpm test:tenant-telemetry-application-capture`：协议与Memory **12/12 passed**。
- `pnpm test:tenant-telemetry-application-capture-mysql`：真实MySQL **12/12 passed**；除原有分域activation、exact replay/conflict、tenant原子coverage、rollback、legacy binding和startup drift外，新增12个不同tenant并发首写、named-lock/trigger稳定制造的activation↔same-domain enqueue竞态，以及composed/decomposed Unicode tenant coverage隔离回归。
- `scripts/local-service.sh verify`在全新的隔离MySQL测试库完整退出`0`：secret scan覆盖 **505 files**，OpenAPI/生成SDK漂移检查与`typecheck`通过；主套件为 **159 files passed / 7 skipped、1878 passed / 34 skipped / 0 failed**，coverage为statements **78.99%**、branches **74.86%**、functions **85.50%**、lines **81.76%**。此前开发中较早版本的未发布0035已写入默认持久测试库，最终migration fingerprint按设计拒绝该漂移；没有删除marker或放宽审计，而是使用一次性空库重跑完整门禁。0035发布后迁移文件必须保持不可变，后续改动只能新增0036。
- `pnpm test:migrations`固定真实MySQL历史升级链 **28 files / 199 passed / 0 skipped / 0 failed**，其中`0034 → 0035` **7/7**，`0007 → 0008`继续 **2/2** 覆盖相同usage重复安全合并、内容冲突阻断且不丢账，以及legacy pending receipt保留。required wrapper逐文件证明目标套件确实执行。
- broad cluster为 **8 files / 28 tests**，T3g exact cluster为 **3/3**；SDK隔离包为 **18 files**。runner bundle约 **23853 KB**，包含`main.js`、`blob-storage-migrate.js`、`restore-ledger-reconcile.js`与`backup-catalog.js`；router约 **873 KB**且只有`main.js`。三个plain-Node维护artifact分别为 **1,622,683 / 4,063,382 / 4,127,551 bytes**，dist readiness、认证边界、转发与OpenAPI smoke全部通过。
- `scripts/local-service.sh verify-s3`完整退出`0`：真实MinIO Blob adapter **10/10**、restore journal **4/4**、backup catalog **6/6**、catalog reconcile MySQL+S3 **1/1**、旧snapshot restore roundtrip **1/1**、filesystem→S3 mover **11/11**，源码runner/router应用装配也通过，并确认0034/0035保持dormant及credential只进入runner。
- 独立只读review再次从并发正确性、事务回滚、滚动升级兼容、安全隔离和测试有效性审查最终diff，结论为 **can-submit，P0=0、P1=0、P2=0**。剩余P3包括首次未发布0035 trigger轮换的DDL auto-commit窗口、fingerprint不覆盖`DEFINER`/session `sql_mode`、全tenant activation的规模锁压力与人工rollout ACK，以及filesystem只具进程内互斥且没有全目录sweeper；这些均fail closed或受默认inactive/local-only边界限制，仍需staging验证或后续迁移收口。
- 本轮没有改变provider dialect或公开真实模型网络契约，因此没有重复运行会产生费用的`verify-real`或十阶段`acceptance`；最近真实模型 **1/1** 与acceptance通过只保留为历史基线，不冒充本轮结果。commit后的GitHub Actions以对应远端run为最终门禁。

### 当前边界与下一步

- filesystem sink只用于本地可丢弃数据和单runner协议体验。人工ACK不是自动attestation、目录无OS lock，不能外推为多VM/多容器或production正确性；deterministic operation staging在exact ACK前清理并fsync，正常durable job replay可恢复；但没有全目录startup sweeper，DB/job非原子丢失仍可能留下staging，属于restore/delete生命周期边界。真实managed backend仍需独立验证网络、IAM/TLS、namespace、retention、legal hold、delete/restore与故障域。
- logs application capture目前只有一个provider failure事件，不能代表所有owner日志已双写；traces必须inactive。缺少任意业务事务crash-atomic capture、受控activation CLI和全fleet producer证明时，不得激活或把coverage描述为完整。
- M1仍未冻结，M2保持正式冻结，M3/M4主体未开始。下一步仍是闭合managed telemetry sink与delete/restore/retention evidence、其它provider/KMS/backup域及全域completion，再推进generic user物理purge；不能提前进入M3。

## 2026-10-11（M1 数据生命周期：managed S3-compatible telemetry writer）

### 已完成

1. 在既有0034 writer adapter边界增加`telemetry-s3-object-v1`，不新增migration、daemon、服务、端口、bundle入口或OCI镜像。对象key只由已验证的content-free tenant/target/artifact identity导出；target identity绑定namespace、failure-domain、bucket/prefix、region、规范化custom endpoint或standard-endpoint模式及addressing mode，不保存credential、header、URL credential或正文。
2. writer artifact使用`ASTELM01`闭合envelope，显式绑定metadata/payload长度和各自SHA-256；读取从stream开始受字节上限与request deadline保护，不能靠缺失或伪造`Content-Length`绕过。发布使用`If-None-Match: *`；超时或模糊错误后只做有界read-after-write，remote exact则收口，absent才按原错误重试，identity/payload/receipt冲突与versioned response均fail closed。
3. startup preflight验证bucket可达、versioning从未启用、lifecycle配置不存在、Object Lock关闭，以及create-only conditional PUT与陈旧冲突语义。production custom endpoint必须是无credential的HTTPS origin；`TENANT_TELEMETRY_S3_PRIVATE_BUCKET_ACK=1`只代表operator已经独立核验private access与IAM/policy，应用不会自动证明该事实。credential可显式runner-only注入或使用受控provider chain，但不进入target identity、安全错误或router环境。
4. runner现在支持`TENANT_TELEMETRY_WRITER_ADAPTER=filesystem|s3`。S3使用独立`TENANT_TELEMETRY_S3_*`配置；本地/CI为其bootstrap第四个独立bucket，与Blob、restore journal、backup catalog均不同。`scripts/local-service.sh verify-s3`和GitHub Actions运行真实MinIO cross-client/private-read suite，并通过required wrapper证明目标文件确实执行、非skip且断言数非零；runner config测试证明精确target装配和startup调用。源码S3应用smoke只激活Blob并核对0034/0035 dormant schema与credential隔离，不会激活或构造telemetry S3 writer。
5. 本轮只扩展writer target。0033 lifecycle与0035 application capture继续default-inactive；唯一产品producer仍是`provider.upstream_request_failed` logs，traces保持inactive。固定历史migration链和runner image marker仍止于0035；CI继续只构建router/runner两个Linux OCI镜像及既有五个JavaScript入口，MinIO只是测试基础设施。
6. README、架构/运维/学习材料、`.env.example`、AGENTS/CLAUDE均已同步本地验证方法、CI产物边界、S3配置隔离和真实环境限制；没有编造云bucket、IAM、KMS、域名/TLS或Secret参数。

### 验证状态

- `pnpm check:secrets`通过（**509 files**），`pnpm typecheck`通过；`pnpm test:tenant-telemetry-writer`全通过，其中S3 unit为 **12/12**。`scripts/local-service.sh verify-s3`退出`0`：Blob S3 **10/10**、restore journal S3 **4/4**、backup catalog S3 **6/6**、catalog reconcile **1/1**、旧快照restore roundtrip **1/1**、telemetry S3真实MinIO **4/4**、filesystem→S3 mover **11/11**及源码应用装配全部通过。
- `scripts/local-service.sh verify`使用全新的四个隔离MySQL库完整退出`0`：主套件 **160 files passed / 8 skipped、1894 passed / 38 skipped / 0 failed**，coverage为statements **79.08%**、branches **74.92%**、functions **85.61%**、lines **81.84%**；历史迁移 **28 files / 199 tests**，cluster **8 files / 28 tests**，额外T3g cluster required suite **3/3**。默认持久测试库先前由开发中的未发布0035留下旧fingerprint，首次verify按设计fail closed；本轮未删除marker或放宽校验，而是以空库证明完整门禁。build/check同时验证runner **23921 KB**、router **873 KB** bundle、SDK package、三个runner one-shot artifact与dist启动/鉴权/OpenAPI smoke。
- 独立终审复跑 **4 files / 67 tests**及S3 required unit **12/12**，确认P0/P1/P2为0；mutable streamed chunk复制、共享absolute deadline、anonymous GET拒绝、required wrapper/no-skip和文档证明范围均有效。保留的probe orphan/IAM前缀、云IAM/KMS/故障域/容量及0036缺口已列入下节，均不是本轮writer提交阻断项。
- 实现提交已推送为`9f8a28052ced57583584adabead2ee3bd12b059e`（`feat: add managed telemetry s3 writer`）；GitHub Actions [run 38188336786](https://github.com/zhgqwx-del/agent-service/actions/runs/38188336786)的`test`、`image (agent-runner)`、`image (agent-router)`全部成功。后续文档提交`b808c392411cc8163eaed839a3608d927001cff7`的GitHub Actions [run 38194732590](https://github.com/zhgqwx-del/agent-service/actions/runs/38194732590)在较慢hosted runner上把完整串行矩阵推进到历史迁移末段时耗尽原90分钟job预算；CI因此把`test` timeout调整为120分钟，只增加运行余量，不跳过、不并行共享数据库套件或放宽任何required proof。调整后的 [run 38201056053](https://github.com/zhgqwx-del/agent-service/actions/runs/38201056053) 已证明job级预算足够，并使历史链完整跑到 **198/199 passed**；唯一失败是覆盖四个`0034→0035` CREATE断点的用例整体在慢runner上以30.002秒超过Vitest默认30秒，而此前成功CI为27.495秒且没有断言失败，因此该既有重型用例按同目录惯例使用显式60秒上限，仍逐一执行四个断点和全部断言。本地真实MySQL定向及完整文件复验分别为 **1/1** 与 **7/7**。
- 本轮provider路径未改变；除非最终review发现确有必要，不重跑会产生费用的`verify-real`或十阶段`acceptance`，历史结果不能冒充本轮验证。

### 当前边界、风险与下一步

- S3 adapter目前只有create/inspect writer语义，没有same-key CAS tombstone、delete/crypto-shred/anonymize、retention、restore replay或terminal domain receipt。writer ACK只证明exact artifact已写入，不能推进T3d logs/traces blocker或任何全域completion。
- 第四个独立bucket仍位于同一开发机、同一MinIO进程；真实套件证明create-only条件写、cross-client可见性、冲突不覆盖和anonymous GET拒绝；bounded stream、response-loss、corruption及preflight负例由unit故障注入证明。它不证明云IAM/KMS、private endpoint、独立故障域、容量、SLA、控制面漂移或生产failure recovery。private-bucket ACK也是人工声明，不是自动attestation。startup probe需要仅限`_agent_service_probe/*`的DeleteObject权限；响应丢失或deadline耗尽仍可能遗留content-free probe orphan，当前没有自动sweeper。
- 0035当前只有单一provider failure logs producer，traces无producer contract；没有受控activation/operator CLI，也没有任意业务事务与spool之间的通用crash-atomic封装。因此标准local-service和production仍不得激活并宣称完整coverage。
- 下一M1切片必须新增不可变的`0036` expand-only、default-dormant disposition/delete/restore ledger：Memory/MySQL原子store绑定0033 inventory、0034 ACK、0035 coverage/binding与T3c/T3d source；外部对象以same-key `If-Match` CAS tombstone处置，并在mutation前写入独立content-free create-only event chain + CAS authority head journal。LIST不能判定head；旧数据库快照恢复后必须从journal exact replay永久marker，防止已删除telemetry复活。migration不得联网、materialize、删除、恢复或激活。
- M1仍未冻结，M2保持冻结，M3/M4主体未开始。0036执行生命周期、真实provider/KMS、backup/其它domain恢复proof、generic user物理purge及全域completion闭合前，不能转入M3或宣称完整生产化。

## 2026-10-12（M1 数据生命周期：0036 default-dormant telemetry disposition substrate）

### 已完成

1. 新增expand-only、default-dormant的`0036_tenant_telemetry_disposition.sql`：9张control/activation/grant/job/external event/ACK/receipt/replay-fence表及严格MySQL schema/index/CHECK/FK/83个trigger body指纹。迁移不回填、不联网、不激活、不删除、不恢复；固定历史链为`0007→…→0036`。Memory/MySQL仅原子发布disposition control与activation receipt；未来grant/job/外部mirror/fence所需的类型与表已安装，但产品store的materialize、claim、grant、complete、mirror及fence均保持拒绝或零结果。MySQL active startup还会拒绝任何execution footprint，防止尚未闭合的authority被使用。
2. 0036激活与0034旧writer/job及0033 inventory入口按control行锁串行：旧writer和inventory INSERT触发器先`FOR SHARE`，激活receipt触发器与store事务先`FOR UPDATE`再检查完整spool/目录，避免“扫描后旧writer提交”的窗口。真实MySQL夹具实际观察`performance_schema.data_lock_waits`中的control PRIMARY锁等待，而非只靠延时判断竞态。SQL三值逻辑按`IS TRUE`/`IS NOT TRUE`封闭缺失JSON字段、nullable授权hash、active control和半绑定restore tuple；tenant ID约束精确按UTF-16 code units匹配core的128长度上限，tenant-scoped读取使用`BINARY`身份，拒绝组合/分解Unicode collation别名。
3. 增加独立S3-compatible非生产disposition journal协议夹具：content-free create-only事件对象、`If-Match` CAS authority head、exact event/head response-loss replay、sealed chain扫描、整个操作的有界deadline；不以LIST判head。telemetry artifact夹具在原key上用`If-Match` CAS写`ASTOMB01` checksum tombstone并精确回读/重放，missing/foreign不能冒充physical ACK。S3 streaming读取复制可复用底层缓冲区的chunk。journal的startup/read/scan/mutation和artifact tombstone都要求显式非生产fixture标志，production始终拒绝；fixture的readHead/scanEvents可能创建genesis或推进pending head，不能当严格只读操作。第五个MinIO bucket与Blob、restore、catalog、telemetry artifact bucket分离，但仍同机同实例。
4. 本地`verify`/`verify-s3`、required-suite与固定历史迁移manifest、GitHub Actions的真实MySQL/MinIO命名步骤、源码S3应用装配、runner image最新migration marker均接入0036。学习材料`docs/operations/development-and-ci-guide.md`说明现在先做阶段手动体验、local/CI范围完成后再做完整walkthrough，并区分Node ESM bundle与两个Linux OCI镜像。0036不新增常驻服务、CLI、bundle入口或镜像；产品仍是router/runner两个长期服务、五个JavaScript入口及两个OCI镜像。

### 完整验证与独立复核

- `pnpm check:secrets`覆盖**525 files**，OpenAPI/生成SDK drift与`pnpm typecheck`通过。`pnpm test:tenant-telemetry-disposition`的协议、Memory journal、S3故障注入与Memory store共**34/34**；真实MySQL store **3/3**，覆盖原子control/receipt、late SQL故障全回滚、并发、重启fail-closed、Unicode长度和byte-exact tenant隔离。独立`0035→0036`真实MySQL历史夹具**6/6**，含冻结数据保持、partial-DDL/marker-loss、真实锁等待、冲突schema及SQL UNKNOWN/astral Unicode负例。
- `scripts/local-service.sh verify`使用隔离测试库完整退出`0`：主套件**174 files passed、1937 passed / 42 skipped / 0 failed**，coverage为statements **78.65%**、branches **74.41%**、functions **85.54%**、lines **81.36%**；required wrapper逐文件验证0036与其它关键文件确实执行。固定`0007→…→0036`真实MySQL历史链**29 files / 205 passed / 0 skipped**，其中原有`0007→0008`夹具仍覆盖相同usage重复安全合并、内容冲突阻断及legacy pending receipt保留。broad cluster **8 files / 28 tests**，T3g exact cluster **3/3**。SDK隔离包**18 files**；runner bundle约**24297 KB**（main加三个one-shot CLI），router约**873 KB**，三个维护artifact分别为**1,628,739 / 4,133,739 / 4,197,911 bytes**；plain Node的readiness、鉴权、转发和OpenAPI smoke全部通过。
- `scripts/local-service.sh verify-s3`完整退出`0`：Blob **10/10**、restore journal **4/4**、backup catalog **6/6**、catalog reconcile **1/1**、旧snapshot roundtrip **1/1**、telemetry artifact writer/同keytombstone **5/5**、独立disposition journal **3/3**、filesystem→S3 mover **11/11**及源码runner/router+MySQL dormant-schema装配均通过。两个0036相关真实MinIO文件各自通过required wrapper的实际执行、非skip且非零断言检查；它们不构成source-valid DB授权至旧快照恢复的端到端证明。
- 独立只读复核从并发正确性、事务回滚、滚动升级兼容、安全隔离与测试有效性检查最终0036默认休眠范围，发现并修复旧writer锁序、SQL NULL三值逻辑、S3复用buffer及Unicode alias边界；复核结论**P0=0、P1=0、P2=0**。本轮未改公开模型调用/方言，不重跑会产生费用的`verify-real`或十阶段`acceptance`；历史真实模型1/1和acceptance只能作为旧基线。提交后的GitHub Actions仍是远端最终门禁。

### 当前边界与下一步

- 现有T3d `logs`/`traces`仍为`blocked_adapter_unconfigured`、零target；0036不会凭空产生grant或执行权。没有真实source-valid DB grant、外部物理marker验真、fresh journal head与0030/0031 restore run/epoch绑定、旧快照replay/startup gate、跨MySQL/S3端到端证明或受控activation/operator/worker。0036所有产品外部处置入口默认拒绝，不能说telemetry删除、恢复、retention或旧快照防复活已完成。下一切片0037必须先闭合这些authority，再考虑任何destructive gate。
- 新发现的0037必修约束：已发布0036 grant trigger使用裸`SHA2(claim_token)`，TypeScript使用domain-separated claim hash；当前默认休眠路径不会发grant，但真实授权前必须用新migration轮换trigger/指纹，不能修改0036。非生产journal `authorizeDeletion`目前只接受caller evidence，外部事件没有可信DB grant绑定；必须升级为grant-bound v2协议，不能直接把夹具开放给产品。0037宜先闭合可信源与不可扩权grant，物理CAS/ACK saga及0030/0031旧快照恢复门禁应分切片，全部完成前保持产品mutation关闭。
- 同机MinIO不能证明私有IAM/KMS、独立故障域、真实managed sink或容量/故障恢复；schema fingerprint仍不覆盖`DEFINER`、session`sql_mode`等特权元数据。滚动升级需彻底排空pre-0036 writer，并在真实staging测量control全范围锁、迁移和启动扫描的容量/延迟。真实provider/KMS、backup内tenant erasure/其它domain恢复、generic user物理purge及全域completion仍缺失，M1未冻结；M2保持冻结，M3/M4主体尚未开始。没有云资源可以继续本地/CI代码与协议开发，但不能把本地替身当作预发/生产验收。

## 2026-10-12（M1 数据生命周期：0037 grant guard 前置正确性，仍不授权删除）

### 实现范围

1. 新增default-dormant的`0037_tenant_telemetry_disposition_grant_guard.sql`，保持已发布0036不可变：把grant trigger中裸`SHA2(claim_token)`比较轮换为与TypeScript一致的domain-separated claim hash，严格校验83个trigger body指纹。轮换采用先安装v2 hard-deny guard再移除旧guard的顺序；即使匹配live claim也最终无条件拒绝grant INSERT。migration不联网、不回填、不激活、不删除、不恢复，marker-loss与DDL断点必须保持至少一道拒绝边界，不能把hash修复误解为授权开放。
2. Memory/MySQL新增精确grant receipt的契约与issue/get入口，但现有T3d `logs`/`traces`为`blocked_adapter_unconfigured`、零target，且完整owner/T1/policy/hold/0033～0035/T3c/T3d source closure尚未证明；issue始终返回`null`，get在正常dormant库返回`null`、发现异常grant footprint则fail closed。MySQL启动/迁移也拒绝非零执行投影，不接受旧binary或特权写入留下的伪grant作为authority。
3. 独立v2 `delete_authorized`事件codec把完整DB grant receipt及claim attempt/hash、operation、artifact tuple绑定到content-free event和sealed sequence/root；Memory夹具显式非生产、要求精确CAS head，支持exact replay、响应丢失与冲突/篡改拒绝，不实现产品`authorizeDeletion`。原始tenant/request不进入事件；receipt哈希虽承诺它们的精确值，但单个事件不能证明grant来自可信DB，也不能自行重建旧快照。0036 caller-evidence S3 journal继续fixture-only；没有产品v2 S3 adapter、可信DB-time grant verifier、物理CAS/ACK或restore replay。
4. 固定真实MySQL历史链延伸为`0007→…→0036→0037`，新增独立`0036→0037`夹具、grant Memory/真实MySQL命名套件、本地`verify`、CI独立步骤、required-suite实际执行检查，以及runner image/source assembly的最新migration marker检查。0037只增加migration、store契约、协议夹具和测试，不新增常驻服务、CLI、JavaScript bundle入口或Linux OCI镜像；产品仍为router/runner两个长期服务、五个JavaScript入口、两个OCI镜像。

### 验证状态与剩余门禁

- `pnpm check:secrets`通过（**531 files**），OpenAPI/SDK drift与`pnpm typecheck`通过；grant-bound v2 Memory夹具 **5/5**、真实MySQL grant hard-deny **5/5**，后者实际执行精确domain-separated live claim、裸hash、错误claim和跨tenant分支。`scripts/local-service.sh verify`在全新隔离测试库完整退出`0`：主报告**176 files / 1950 passed / 42 skipped / 0 failed**，coverage为statements **78.72%**、branches **74.45%**、functions **85.60%**、lines **81.42%**；required wrapper逐文件证明新增测试非skip。固定`0007→…→0037`真实MySQL历史链**30 files / 210 passed / 0 skipped**，其中`0036→0037` **5/5**、`0007→0008`继续覆盖usage重复合并/冲突阻断和pending receipt。cluster **8 files / 28 tests**，T3g exact cluster **3/3**；SDK隔离包**18 files**，runner bundle约**24334 KB**（main加三个one-shot CLI）、router约**873 KB**，plain Node启动/readiness/鉴权/转发/OpenAPI smoke通过。
- `scripts/local-service.sh verify-s3`完整退出`0`：Blob MinIO **10/10**、restore journal **4/4**、backup catalog **6/6**、catalog reconcile **1/1**、旧snapshot roundtrip **1/1**、telemetry artifact writer/同keytombstone **5/5**、0036 disposition journal **3/3**、filesystem→S3 mover **11/11**，源码runner/router装配证明0037 marker已应用且仍default-dormant。真实MinIO仍只运行0036非生产disposition协议，不存在0037产品v2 S3写入测试。本轮未改公开模型路径，不重跑会产生费用的`verify-real`或十阶段`acceptance`；历史真实模型与acceptance不能冒充本轮结果。独立只读复核覆盖并发、事务回滚、滚动升级、隔离和测试有效性，修复了MySQL trigger matching-claim分支及学习指南两个手工步骤盲区，最终P0/P1/P2均为0；GitHub Actions须以本轮提交后的run单独判断。
- 首次使用持久默认`agent_service_test`运行`verify`时，库内遗留了已自动提交但未写0036 marker的部分DDL，按设计在0036严格指纹处拒绝；没有删除旧库、手改marker或放宽迁移器。新建隔离可丢弃库后，原失败三文件**43/43**复测通过，随后以上完整`verify`与`verify-s3`均通过。该经历已写入学习指南的测试库排障说明，不是产品迁移的自动修复许可。
- 0037修复的是错误hash与不可扩权的拒绝边界，不是可执行grant。T3d logs/traces零target blocker、0035 traces无producer contract、外部marker物理验真、0030/0031 restore run/epoch与fresh head绑定、旧快照exact replay/startup gate、跨MySQL/S3物理ACK saga、真实provider/KMS、其它domain恢复proof、generic user物理purge及全域completion都未闭环。M1不能冻结；M2继续冻结，M3/M4主体不启动。无云资源仍可推进本地/CI代码，但预发/生产的IAM/KMS、独立故障域、容量和滚动发布须待真实环境验证。
- 下一切片应先为已知受管telemetry artifact建立不可变的逐项membership/source证据，继续保留T3d的whole-domain blocker与grant硬拒绝；不得重新解释历史sealed零target plan。T3f可能先清除canonical owner行，故必须在其前完成所需操作，或另以可信owner-closure sidecar证明后续签发来源。待锁序、T1/hold/restore/0033～0035/T3c/T3d与writer ACK闭包可并发验证后，再以独立切片讨论真实grant发行；外部CAS/ACK、旧快照恢复gate仍需另外收口。

## 2026-10-12（M1 数据生命周期：0038 新受管telemetry write逐项membership/source证据）

### 实现范围

1. 新增default-dormant、expand-only的`0038_tenant_telemetry_artifact_membership.sql`：只为迁移后新受管write建立不可变逐项sidecar，不扫描、补造或重标历史job。Memory以单一原子发布membership、0034 job/payload及可选0035 application binding；MySQL在同一事务按可选binding → membership → job → payload的顺序发布，整体精确关联。新增MySQL additive job guard要求每个新job具有同operation、tenant、target、inventory、artifact、payload、coverage、owner/source的sidecar，保留已发布0035 guard；新旧binary不能在该schema上混写。
2. sidecar绑定0033 inventory、0034 write operation/payload、0035可选binding、target、coverage/history、source schema/generation/DB高水位及写入时keyed opaque owner tuple claim。只保存opaque ref/digest和闭合元数据，不保存原始user/session、正文、URL、header、secret或外部明文locator。`inventoryCreatedAtDbMs`继承DB当前时间及control/coverage/hold/restore/source高水位的最大值，是inventory逻辑创建高水位，不是外部create、tombstone或删除ACK时间。旧job缺sidecar只能是unknown；不得从job JSON事后补造或把写时owner claim当作T3f删除canonical owner后的独立closure证明。
3. MySQL严格schema/trigger fingerprint覆盖新增membership表和加法式guard；固定真实历史链延伸到`0007→…→0037→0038`。0038迁移不联网、不materialize外部对象、不启用capture/disposition、不发行grant、不删除/恢复、不推进terminal completion。pre-0038 job没有不可变cutover root，若特权DDL或证据篡改，当前本地投影不能离线区分真实legacy；此限制不能被普通测试环境中的正常迁移结果掩盖。

### 当前验证与发布边界

- `scripts/local-service.sh verify`在预先创建的可丢弃MySQL测试库完整退出`0`：`pnpm check:secrets`扫描 **534 files**，OpenAPI/生成SDK漂移检查与`pnpm typecheck`通过；主报告 **176 files / 1956 passed / 42 skipped / 0 failed**，coverage为statements **78.73%**、branches **74.49%**、functions **85.65%**、lines **81.43%**。固定`0007→…→0038`真实MySQL历史链 **31 files / 214 passed / 0 skipped**，其中新增`0037→0038` **4/4**；cluster **8 files / 28 tests**，T3g exact cluster **3/3**。`build:check`产出SDK隔离archive **18 files**、runner bundle约 **24452 KB**（main加三个one-shot CLI）、router约 **873 KB**；三个one-shot入口的plain Node检查以及dist应用启动/readiness等构建产物门禁通过。上述是0038本地结果，不能与上一节0037计数混用；`verify-s3`结果见下条；提交后GitHub Actions尚未取得结果，仍是独立远端门禁。
- `scripts/local-service.sh verify-s3`完整退出`0`：真实MinIO Blob **10/10**、restore journal **4/4**、backup catalog **6/6**、catalog reconcile **1/1**、旧数据库快照roundtrip **1/1**、telemetry writer **5/5**、非生产disposition S3 journal **3/3**、filesystem→S3 mover **11/11**；源码runner/router装配确认0038 marker、默认休眠schema与credential隔离。第五个同机MinIO bucket与这些通过项只证明本地S3-compatible协议、配置隔离和装配，不证明真实云IAM/KMS、独立故障域、产品grant→物理删除/ACK或旧快照防复活。公开模型路径未改，本轮未运行会产生费用的`verify-real`或十阶段`acceptance`；此前结果不能冒充本轮验证。
- 严格87-trigger指纹与新增job guard要求先保持telemetry writer/capture/disposition及grant相关gate关闭、停止入口并排空所有pre-0038 writer和在途事务，再由独立migration Job应用0038并核对零执行footprint，最后只启动0038-aware router/runner；不能把旧进程与新schema当作普通滚动共存，不能删marker或放宽指纹来恢复服务。后续只能forward-fix。pre-0038历史job仍保持unknown，不自动补写membership。
- 本切片仅缩小未来可信source的逐项证据缺口。T3d logs/traces仍是零target blocker，0037 grant hard-deny、产品外部mutation/restore默认拒绝、所有`allDomainsComplete=false`与`contentPurgeExecuted=false`不变。下一步需独立闭合T3f后可信owner closure、source-valid不可扩权grant及T1/hold/restore/0033～0035/T3c/T3d/writer ACK的并发重验，再分别实现物理CAS/ACK saga、旧快照fresh-head replay/startup gate；M1未冻结，M3/M4主体不提前开始。

## 2026-10-12（M1 数据生命周期：0039 T3f 后可信telemetry owner closure）

### 实现范围

1. 新增expand-only、default-dormant的`0039_tenant_telemetry_owner_closure.sql`：两张append-only逐write entry/aggregate receipt表、8个新增trigger（严格组合指纹95个）、旧T3f writer tripwire与queued→terminal的同事务closure receipt guard。migration不扫描回填历史owner、不联网、不激活telemetry、不发行grant、不删除/恢复外部对象或推进全域completion。
2. Memory在单一原子发布、MySQL在同一个RR T3f destructive事务中，在删除canonical owner行前读取该tenant所有queued/reserved/blocked/written遥测job和0038 membership。逐项重验tenant/user/session真实owner、受保护keyed ref、source/DB高水位及同事务session grave；与11域T3f pre-delete、ACK、terminal receipt/job一起封存逐项closure和独立aggregate receipt。即使没有遥测job，也必须显式封存空集合。缺membership的legacy job或不闭合source使新T3f全回滚，不能事后借可变job JSON补造owner；exact replay不重复写证据。
3. terminal读取和MySQL verify-only startup会重验closure、T3f receipt/source、entry root及每个membership和session grave。pre-0039 binary已完成的terminal若无sidecar只能返回`unknown`，不能解释为零target或授予未来删除权。MySQL整tenant写集范围锁和同一事务guard阻止0039-aware新终态遗漏closure，也防止并发writer/ACK改变捕获集合。严格指纹要求先关闭相关gate、摘流排空pre-0039 T3f writer，再由独立migration应用0039并只启动0039-aware binary；不能在线混跑或手删marker。

### 当前验证与未闭合边界

- 定向Memory T3f **21/21**，含重算entry/root/receipt后指向同tenant另一条有效session grave的对抗读证明，以及membership非比较字段篡改后的完整source读复核；T3f worker **6/6**，区分确定性telemetry integrity与可重试SQL timeout。真实MySQL T3f **13/13**，含空/非空closure、四种writer状态、tenant/user/session隔离、真实双连接`performance_schema.data_lock_waits`锁等待、receipt后故障全回滚、带mysql2 1205元数据的query错误保留/回滚/重试、verify-only重启与orphan拒绝。独立冻结`0038→0039`真实MySQL迁移夹具 **6/6**，覆盖旧write保持、新sidecar默认空、DDL中断/marker-loss、entry orphan投影阻断、冲突schema/trigger和缺closure的terminal guard。
- `scripts/local-service.sh verify`在全新隔离MySQL测试库通过：密钥扫描**538个文件**、OpenAPI/SDK漂移与TypeScript检查通过；主覆盖率/集成套件 **1969 passed / 0 failed / 42 S3分层skip**，其中新增无模型`demo.sh`显式router BASE回归 **1/1**；固定历史迁移链 **32文件/220 passed/0 skip**；真实多进程cluster **8文件/28 passed**，独立T3g cluster **3/3**；SDK打包、runner/router五个JavaScript入口、三个one-shot CLI plain Node和bundle启动/转发/OpenAPI检查通过。`scripts/local-service.sh verify-s3`另以真实MySQL+本地MinIO执行 **8个S3文件/41 passed/0 skip**（Blob 10、restore 4、catalog 6、catalog reconcile 1、old-snapshot restore roundtrip 1、telemetry writer 5、非生产disposition 3、mover 11），并通过源码router/runner装配与0039空账本/凭据隔离检查。未运行收费的`verify-real`/`acceptance`，因为0039不改变模型主链路。最终`git diff --check`已通过；本轮提交后GitHub Actions结果另待确认。
- 旧terminal历史升级测试尚缺**真正pre-0039 binary已完成T3f**的冻结夹具；当前0039 binary在0038 schema执行新T3f会按设计fail closed，不能把当前binary制造的伪历史终态算作通过。没有冻结pre-0039 terminal集合的独立cutover root，特权DDL若抹除整套新closure再恢复guard，本地无法离线区分“历史无sidecar”与篡改；必须保持runtime/migration最小权限、schema drift监控，并在后续独立外部恢复证据中收口。整tenant范围锁及active-0035 unbound全域扫描的容量/死锁/lease压力须在真实staging验证。
- 0039只缩小未来source-valid grant的owner-closure缺口，不改变T3d logs/traces零target blocker、0037 grant hard-deny、产品外部mutation/restore默认拒绝、`allDomainsComplete=false`或`contentPurgeExecuted=false`。下一安全切片应先让T3d在同事务中记录logs/traces完整source-accounting（含legacy/未完成/孤立unknown），仍保留零target blocker；之后才可并发重验T1/hold/restore/0033～0035/T3c/T3d/writer ACK并建立不可扩权的可信DB grant，再分别完成物理CAS/ACK saga和旧快照fresh-head replay/startup gate。M1未冻结，M3/M4主体尚未开始。


## 2026-10-12（M1 数据生命周期：0040 T3d telemetry source-accounting）

### 实现范围

1. 新增default-dormant、expand-only的`0040_tenant_telemetry_source_accounting.sql`：两张append-only逐源entry/aggregate receipt表、T3d queued→terminal同事务guard与严格103-trigger指纹。独立迁移不回填历史sealed plan、不激活telemetry、发行grant、联网或执行外部删除/恢复；位于0039已发布指纹范围内的冗余immutable guard让pre-0040 binary在新schema上启动时fail closed，必须先排空旧T3d writer再独立迁移、之后forward-fix。
2. 新T3d seal在同一Memory原子发布或MySQL RR事务中，以全范围锁读取telemetry inventory、write job、ACK、0038 membership和0035 application binding，逐行封存content-free状态、来源hash和unknown root，aggregate精确绑定T1/T3c/T3d receipt及本次claim。零源也有显式空集合receipt；legacy缺membership、未完成、缺失/不一致关联与孤立来源不会被当作可执行证据。完整且精确绑定的write可记`accounted`，但T3d logs/traces仍为零target blocker，绝不因此签发grant或删除对象。pre-0040 terminal缺receipt只能为unknown，后来的ACK也不能改写已封存快照。
3. Memory失败恢复既有plan、33域entry/receipt和新sidecar的同一原子状态；MySQL所有写入在一笔事务提交或回滚，最终重验DB时间、claim/lease与source高水位。读取端与verify-only启动重验entry/count/root、plan source及租户归属；数据库clock短暂倒退保留可重试NotReady，不把任务误判为永久损坏。0037 grant hard-deny、产品外部mutation/restore默认拒绝与全部completion=false保持不变；无新长期服务、进程、JavaScript入口或镜像。

### 当前验证与未闭合边界

- 定向Memory T3d **18/18**；真实MySQL T3d **15/15**，覆盖双连接ACK-first真实行锁等待与五类完整source、legacy/孤立unknown、SQL receipt注入后整事务回滚、跨tenant隔离、时间回退与篡改读拒绝。冻结`0039→0040`独立真实MySQL迁移夹具 **8/8、0 skip**，包含旧数据保留、第一张表DDL中断/marker-loss、严格fingerprint、terminal guard与受控错tenant投影在startup/marker-loss双路径拒绝；旧terminal样本是SQL-shaped，并非冻结旧二进制实际执行。
- `pnpm check:secrets`扫描**541 files**，OpenAPI/SDK drift与`pnpm typecheck`通过。`scripts/local-service.sh verify`在隔离可丢弃测试库完整退出`0`：主集成**177 files（168有通过断言、9个分层skip）/1972 passed/42 skipped/0 failed**，coverage为statements **78.89%**、branches **74.73%**、functions **85.95%**、lines **81.60%**。固定`0007→…→0040`真实MySQL历史链**33 files/228 passed/0 skipped**，required wrapper逐文件确认全部执行，其中`0007→0008`仍证明同内容usage重复安全合并、冲突重复阻断且不丢账、legacy pending receipt保留。真实多进程cluster **8 files/28 passed**，独立T3g cluster **3/3**；`build:check`验证SDK隔离包**18 files**、runner四个入口约**24857 KB**、router一个入口约**873 KB**、三个one-shot CLI在plain Node下运行，以及bundled readiness、鉴权、转发和OpenAPI。
- `scripts/local-service.sh verify-s3`使用独立可丢弃测试库、真实MySQL与本机MinIO完整退出`0`：Blob **10/10**、restore journal **4/4**、backup catalog **6/6**、catalog reconcile **1/1**、旧快照restore roundtrip **1/1**、telemetry artifact writer/同key tombstone **5/5**、非生产disposition journal **3/3**、filesystem→S3 mover **11/11**，合计**8 files/41 passed/0 skipped**；源码runner/router装配确认0040 marker、default-dormant空账本、精确Blob namespace与凭据隔离。本轮不改公开模型调用路径，未运行会产生费用的`verify-real`或十阶段`acceptance`；旧真实模型/acceptance结果不能冒充0040验证。提交后GitHub Actions仍须独立检查。
- 尚缺真正pre-0039 T3f与pre-0040 T3d二进制产生terminal的历史升级夹具。下一安全切片须先让新T3d同事务封存逐artifact目标集合及只读source-readiness证明，仍保持logs/traces blocker、0037 grant硬拒和外部mutation关闭；现有0036/0037 grant证据未绑定0038～0040，不能直接开启签发。完整sidecar若被特权DDL抹除，本地仍无独立cutover root区分篡改与真legacy；migration fixture未逐一注入每个trigger auto-commit点。全表`FOR SHARE`、per-tenant count与跨tenant写阻塞/死锁/lease压力，以及N-1旧进程排空，需要staging容量与滚动发布验收。0040不是source-valid授权、物理删除或恢复权限，M1未冻结，M3/M4主体未开始。

## 2026-10-12（M1 数据生命周期：0041 T3d telemetry observed-target manifest）

### 实现范围

1. 新增default-dormant、expand-only的`0041_tenant_telemetry_target_manifest.sql`，为新T3d同事务封存逐source entry及独立aggregate receipt。0041不改既有33域plan receipt/hash和0040 source账本；每条0040 source必须在0041精确覆盖一次，零source也要显式封存空receipt。Memory单一原子发布、MySQL RR事务在0040 source snapshot与最终T3d terminal之间发布0041；写入晚期失败全部回滚。MySQL新表append-only、terminal guard要求0040+0041 receipt同事务存在，严格111-trigger指纹使pre-0041 T3d binary在新schema上fail closed。
2. 观察目标仅是已发生受管write的content-free身份，不是T3d的可执行target、外部locator或删除许可。只有inventory、written job、ACK、0038 membership、0035 binding、target tuple和T3d时真实canonical tenant/user/session owner/keyed ref闭合，才为artifact group记一个观察目标；legacy、未完成、缺job inventory和其它孤立来源均为`unknown`/零观察目标，不能从孤儿派生owner或locator。read proof逐条复核0040关系、entry/group/root、retained source；T3f后只读source-readiness还须核对已验证的0039 closure/T3f receipt与session grave，但始终`executionReady=false`且不返回mutation authority。pre-0041 terminal缺receipt保持unknown，不回填。
3. 迁移不激活telemetry、不回填历史source/target、不联网、签发grant或执行外部删除/恢复。0037 Memory/MySQL及trigger的grant hard-deny、T3d logs/traces `blocked_adapter_unconfigured`/零执行target、全部terminal completion=false不变；没有新增常驻服务、进程、JavaScript入口或产品镜像。发布须先关相关gate、摘流并排空pre-0041 T3d writer及在途事务，再独立迁移、核对指纹/零执行footprint，只启动0041-aware进程，之后forward-fix；不可热混跑或删marker。

### 当前验证与未闭合边界

- 定向`pnpm typecheck`与`pnpm check:secrets`通过（密钥扫描**551 files**）；T3d Memory **18/18**、真实MySQL T3d **16/16**、T3f Memory **21/21**、0037 grant hard-deny真实MySQL **5/5**。新增真实MySQL用user/session canonical owner完成五源观察目标、tenant隔离、并发ACK锁序、late receipt故障全回滚及直接SQL entry/append-only guard拒绝；Memory在T3f后验证owner-closure/grave关系完成但`executionReady=false`。独立`0040→0041`真实MySQL历史夹具**7/7、0 skip**，保留冻结0040受管write，证明默认空0041账本、旧指纹失配、partial-DDL/marker-loss重放、冲突schema/trigger及已标记schema漂移拒绝，并拒绝非loopback目标/保护预存在库不被误清理。独立review补上telemetry inactive启动时遗漏的0041 manifest投影审计；真实MySQL先保留精确111-trigger指纹、再注入孤立receipt，verify-only启动必须拒绝。required migration manifest与CI已将该文件及runner image最新0041 marker列为必检；本节的定向通过不冒充尚待主工作树合并后执行的完整`verify`/`verify-s3`或远端GitHub Actions。
- **升级夹具补强与未验证边界**：三个冻结旧二进制夹具分别让0038 T3f、0039 T3d、0040 T3d在各自真实旧schema产出terminal后升级；0040→0041定向真实MySQL **1/1** 已通过，证明旧33域plan与0040 source receipt不变、0041缺receipt仍为unknown、旧verify-only启动拒绝新指纹。三个旧terminal均没有非空telemetry artifact，因此不证明该组合升级；0041 terminal guard虽有正常seal路径，单独直接SQL负例仍待补。全库RR/`FOR SHARE`范围锁、长租约、Unicode alias与N-1排空的容量/兼容性仍需staging；最小权限、schema drift监控和独立外部恢复证据不可省略。下一安全切片应为**新plan**另建精确telemetry artifact target catalog及独立receipt/terminal guard，先封存source projection避免0041 manifest与T3d receipt hash循环；旧sealed plan不能因有0041观察目标就推断执行target。之后才讨论不可扩权可信grant、物理CAS/ACK和旧快照恢复gate。0041不构成这些权限或全域completion；真实provider/KMS、managed环境和generic user物理purge仍缺，M1不能冻结，M3/M4主体没有开始。

## 2026-10-12（M1 数据生命周期：0042 新T3d逐artifact telemetry target catalog）

1. 新增default-dormant、expand-only的`0042_tenant_telemetry_plan_artifact_target.sql`，只对新seal的T3d plan发布逐artifact content-free target目录及独立aggregate receipt。seal先在同一锁定范围内捕获五类raw source和当时真实canonical owner，再由这一快照推导logs/traces的精确target count/root，避免用0040/0041/T3d receipt互相推导形成hash循环；随后在同一个Memory原子发布或MySQL RR事务中封存33域plan、0040 source、0041 observed-target、0042 catalog、全部receipt与terminal job。零目标也要显式receipt；晚期失败全部回滚。MySQL新增append-only条目/receipt、queued→terminal guard及严格119-trigger指纹，旧T3d writer不能与新schema热混跑。
2. 目录只收完整inventory、written job、ACK、0038 membership、0035 binding、target tuple和真实owner/ref闭合的artifact；legacy、未完成、孤立source仍保留unknown，绝不猜测外部locator。新plan的logs/traces entry有精确count/root，但disposition仍固定`blocked_adapter_unconfigured`；目录、0041观察目标和receipt均非grant或物理删除证明。读取重验0040/0041、保留的五类source和逐artifact身份/owner/ACK关系；合法范围内`recordCount`漂移也会fail closed。pre-0042已sealed的0041 plan保持原零target entry，缺catalog只读为unknown，不补造或改写历史hash。
3. 独立迁移不激活capture/disposition、不回填历史plan、不联网、不签发grant、不执行外部mutation/restore或推进completion。发布前须保持相关gate关闭并排空pre-0042 T3d writer和在途事务，独立运行迁移并核对严格指纹、旧terminal未回填及零执行footprint，只启动0042-aware进程，之后forward-fix。0037 grant硬拒、产品外部处置拒绝、所有terminal `allDomainsComplete=false`/`contentPurgeExecuted=false`仍不变；服务、JavaScript入口、Linux OCI镜像及local→staging→production部署契约没有变化。

定向验证：Memory T3d **22/22**（含0/1/多目标、漂移与晚期回滚）；真实MySQL T3d **17/17**；独立`0041→0042`真实MySQL迁移夹具 **5/5**，另由冻结0041旧二进制实际生成非空ACK managed logs artifact的terminal再升级 **1/1**，证明旧零target/缺catalog保持unknown。完整`pnpm test:migrations` wrapper在独立可丢弃MySQL库退出`0`：**39 files / 244 passed / 0 failed / 0 skipped**，required wrapper逐文件证明全部实际执行、非skip且断言数非零；三个更早冻结旧二进制终态夹具及升级至当前0042的兼容路径也通过。`scripts/local-service.sh verify`/`verify-s3`与GitHub Actions仍以主工作树合并后实际运行结果为准，不能把定向与迁移结果冒充完整验收。

下一安全切片是不可扩权的source-valid DB grant、外部CAS/physical ACK saga及0030/0031旧快照fresh-head replay/startup gate，需逐项证明T1/hold/restore、owner-closure、0040～0042目录与真实写入ACK在并发下闭合；不能直接打开0036/0037现有hard-deny。MySQL读端已拒绝“新plan非零target但特权删除0042目录与receipt”的矛盾；若新plan本来精确零target且特权删除0042 receipt，仅凭本地剩余证据仍不能与真实旧0041 terminal区分。生产必须保持runtime/migration最小权限、schema drift/marker监测和旧writer完整排空。全库锁/lease预算、N-1 drain及真实managed sink/IAM/KMS/独立故障域仍须staging/生产验证；M1未冻结，M3/M4主体尚未开始。

## 2026-10-12（M1 数据生命周期：0043 只读本地来源候选与0042 T3e复核修正）

### 实现与兼容性

1. `0043`是code-only切片，不新增schema migration、服务、runner worker、JavaScript入口或Linux OCI镜像；固定历史schema仍止于`0042`。新增`getTenantTelemetrySourceEligibility(tenantId, requestId)`只读接口。Memory在无`await`的同步读取边界、MySQL在一致性事务中，先验证精确tenant/request与terminal T3f，再对账0039 owner closure/session grave、0040 source、0041 observed-target、0042逐artifact catalog以及当前T1、legal hold、telemetry lifecycle control、DB时间和restore runtime状态。只有本地来源完整闭合时才返回`local_source_candidate`和content-free managed artifact数量；未封存、legacy或当前gate不满足返回`unknown`，跨tenant/不存在返回`null`。损坏证据仍fail closed。该值固定`executionReady=false`、`externalAuthorityVerified=false`，不具备后续mutation所需的锁内独立复核或外部authority证明。
2. 修复0042新plan非零logs/traces target在T3e live recheck中仍按旧零target规则重算的错误。Memory/MySQL现在从锁定的五类source和真实canonical owner重建0040～0042证据，并核对原plan两域的精确count/root；不修改已经sealed的旧0041计划。MySQL嵌套source校验中的真实`1205`/`1213`锁争用透传给可重试路径，不能被包裹成永久`integrity_conflict`。事务回滚保持无部分usage、outbox、ACK或T3e cutover发布。
3. 独立冻结0042旧二进制→当前0043的真实MySQL夹具绑定已发布0042 mainline commit `cefb498929854f9132611ba03ade0c495cb475b1`，而非工作树快照：旧非空目标T3e按旧逻辑被阻断，不会虚构旧非空T3f terminal；旧零目标路径可以完成T3f且升级后仍为本地候选。旧binary写成blocked的非空T3e job不会自动恢复，需要未来受审计的repair/resume协议，不能靠0043读诊断解封。

### 当前验证与下一门禁

- 0043定向Memory **2 files / 50 passed**、真实MySQL T3f **1 file / 15 passed**；冻结0042旧二进制升级夹具在独立真实MySQL migration配置下 **1 file / 2 passed / 0 skipped**。完整`scripts/local-service.sh verify`退出`0`：`pnpm check:secrets`扫描**563 files**、`pnpm check:api`与`pnpm typecheck`通过；主集成/coverage **177 files（168 passed / 9 expected skipped）、1987 passed / 42 expected skipped / 0 failed**，statement/branch/function/line覆盖率分别为**79.07% / 74.96% / 86.30% / 81.80%**；真实MySQL历史与冻结旧二进制migration wrapper **40 files / 246 passed / 0 skipped / 0 failed**，逐文件required proof实际执行；全部后续命名专项通过；多进程cluster **8 files / 28 passed**，T3g独立cluster **1 file / 3 passed**；`build:check`通过SDK包校验、runner四入口/router一入口构建、三个runner one-shot入口的plain Node启动，以及bundled router/runner readiness、鉴权、转发与OpenAPI检查。独立`scripts/local-service.sh verify-s3`也退出`0`，覆盖真实MinIO五逻辑bucket、telemetry writer/disposition、Blob/restore/catalog协议、真实MySQL+MinIO mover及源码应用装配；同机MinIO仍不证明独立故障域。`git diff --check`通过。本轮GitHub Actions仍须以推送后的实际结果为准；此前0042章节保留其当时测试快照。
- 下一安全切片先建立default-dormant、versioned、source-bound的pre-grant intent/claim，并在未来grant/mutation边界重新锁定和验证当前来源；不能直接放开0037 hard-deny或把0042 blocker重释为`delete`。真实外部journal最新head、同keyCAS marker物理验真、0030/0031 restore run/epoch绑定、旧快照startup/replay fence、跨MySQL/S3 ACK saga及受控operator/worker均未完成。真实provider/KMS、其它domain恢复/erasure proof、generic user物理purge和全域completion也未闭环。M1继续未冻结，M2维持冻结，M3/M4主体尚未开始；本地/CI证据不代替staging/production的IAM/KMS、独立故障域、容量和N-1滚动发布验收。

## 2026-10-12（M1 数据生命周期：0044 默认休眠的逐artifact pre-grant intent/claim）

### 实现与发布边界

1. `0044_tenant_telemetry_pregrant_intent.sql`新增两张append-only、content-free表和防跨tenant/owner/source漂移的guards；intent逐artifact绑定T3d目录条目、0040 source aggregate、0041 observed-target aggregate、0042 catalog receipt、0039 owner closure与T3f database-purge receipt。Memory在无`await`的同步原子边界、MySQL在单个显式RR事务中，不把0043的`local_source_candidate`直接当作授权，而是独立重验当前0039～0042、terminal T3f grave、canonical owner/source、T1、legal hold、telemetry control、DB时间与restore runtime。缺证据或legacy/零目标不补造intent。prepare/get/claim均按tenant/request/精确artifact group隔离；持久化intent版本由精确来源摘要决定。
2. claim须匹配同一intent hash，使用attempt、一次性domain-separated token hash和DB-time lease串行化；相同token仅允许active exact replay，已过期token不能作为新attempt复活。MySQL在来源证明和锁等待后刷新可信DB时间，并在claim INSERT后再次取DB时间；若延迟已耗尽lease或时钟回退，抛可重试错误并回滚已插入行，下次同key/version/token可从未提交的attempt重新开始。该账本始终`grantReady=false`，不签发0036/0037 grant，也无runner worker、operator CLI、external mutation或物理ACK。
3. migration不回填旧plan/terminal、不联网、不激活capture/disposition。MySQL严格schema/126-trigger启动指纹与marker-loss检查令旧0042-aware writer不能在新schema重启；发布须先保持相关gate关闭、完全排空全部pre-0044 writer和在途事务，再独立迁移并只启动0044-aware进程，后续forward-fix。历史`0042→0044`夹具在真实MySQL上构造SQL-shaped 0042旧状态，证明旧行保留、新表默认空、marker-loss/部分DDL/指纹漂移拒绝；它不是冻结0042二进制执行的非空旧terminal，也未单独运行冻结旧binary startup拒绝测试。`pnpm test:migrations` required wrapper已实际执行全部41个文件、250项断言，零skip/failed；三个冻结旧二进制夹具在最新0044 marker链下通过，保留旧态语义。

### 当前验证与下一门禁

- 隔离0044 worktree上通过`pnpm check:secrets`（566 files）、`pnpm typecheck`、Memory T3d文件 **31/31**、0044定向真实MySQL T3f文件 **3/3**（其余15条按名称过滤）、独立`0042→0044`真实MySQL迁移夹具 **4/4**。过期lease修正后另重跑0044 Memory **2/2**与真实MySQL **3/3**：故障注入在claim INSERT后等待1.25秒超过1秒lease，确认事务无持久claim，再删除故障trigger并以相同intent版本/token成功取得attempt 1。主工作树完整`scripts/local-service.sh verify`在独立可丢弃库退出 **0**：`pnpm check:secrets`、`pnpm check:api`、`pnpm typecheck`通过；主集成/coverage **177 files / 1992 passed / 42 expected skipped / 0 failed**，statement/branch/function/line覆盖率 **79.08% / 75.01% / 86.36% / 81.83%**；真实MySQL migration wrapper **41 files / 250 passed / 0 skipped / 0 failed**，required逐文件执行证明通过；后续命名专项全部通过；多进程cluster主套件与T3g独立cluster **1 file / 3 passed**均通过；`build:check`通过SDK pack、runner四入口/router一入口、三个runner one-shot CLI plain Node及bundled双服务readiness/鉴权/转发/OpenAPI。独立`scripts/local-service.sh verify-s3`此前在同一0044代码上退出 **0**（**8 files / 41 passed**），覆盖真实MySQL+同机MinIO协议与应用装配，不证明独立故障域。本轮一次中途重跑遇macOS合盖休眠导致4个建库`beforeEach`超时；唤醒后隔离定向T3f **18/18**、restore **19/19**及本次保持唤醒的完整`verify`均通过，未改业务断言或放宽超时。`git diff --check`通过；推送后GitHub Actions仍须实际确认，不能把本地验收冒充CI或云环境验收。
- 0044只完成本地来源绑定的第一步。未来真正的DB grant必须重新锁定并验证当前来源、外部journal最新head与同keyCAS marker、0030/0031 restore run/epoch和旧快照replay/startup fence，并以不可扩权物理ACK saga收口；不能直接消费intent/claim、打开0037 hard-deny或重释0042 `blocked_adapter_unconfigured`。0042精确零target旧terminal与特权删receipt的新terminal仍存在本地不可区分边界；0044 SQL-shaped历史夹具不补此证明。外部provider/KMS、其它domain恢复/erasure proof、generic user物理purge、managed sink/IAM/KMS、容量/锁等待与N-1发布验收及全域completion仍未闭环。M1未冻结、M2维持冻结，M3/M4主体未开始；本地/CI目标不等同于未来staging/production验收。

## 2026-10-13（M1 数据生命周期：0045～0050 观察、休眠capture与普通DELETE宽限期）

### 已合入的边界

1. `0045`增加与0036 caller-evidence v1分离的v2 grant-journal S3 **GET-only** sealed-chain观察器，`0046`增加只读telemetry artifact观察器（`exact_data`、`matching_tombstone`或`unknown`），`0048`增加v3 journal GET-only sealed-chain观察器。它们不会创建genesis、推进head、写marker或修复链，也不验证可信DB grant/restore fence；观察结果固定`grantReady=false`、`executionReady=false`、`externalAuthorityVerified=false`，artifact观察也固定`physicalAck=false`。`0047`在独立wire family中定义source/claim/restore/terminal绑定的v3事件链及S3 create-only event + CAS authority-head **显式非生产夹具**，不接入产品mutation、startup gate或恢复流程。四个切片均无schema migration、常驻进程、CLI、bundle入口或产品镜像；unit/真实MinIO套件已列入本地脚本与CI必执行门禁，但不能把协议夹具当作外部authority已闭环。
2. `0049_tenant_telemetry_application_capture_v2.sql`增加default-dormant的persisted provider-step failure capture v2：固定logs `provider.upstream_request_failed` producer contract与inactive/generation-0双域control，另外两表为未来per-tenant coverage及逐write source binding。未来source session/turn/item只以tenant-bound、kind-separated keyed HMAC ref表示，不保留原始ID；当前coverage/binding、control activation与capture v2 job path在SQL层均硬拒。新增13个guard，并以严格139-trigger启动指纹校验；即使特权操作制造active/coverage/binding footprint，旧五源T3d、T3f与v1 writer也fail closed，不得静默遗漏第六类来源。migration不回填旧v1、接线producer、联网、签发grant或删除/恢复对象。发布须先关闭相关gate、摘流并排空pre-0049 writer/事务，独立迁移后只运行0049-aware进程；不能热混跑或移除guard/marker。独立`0044→0049`真实MySQL夹具检查历史保持、默认休眠、marker-loss/部分DDL、trigger drift及跨tenant guard；其旧状态为SQL-shaped，不是冻结0044二进制的非空terminal。
3. `0050_ordinary_session_delete_grace.sql`只给`sessions`增加五个nullable证据列和一条完整形状CHECK，不新增trigger、服务或公开API。新普通`SessionHost` DELETE经专用trusted store入口，在原tombstone/event/两条outbox同一Memory原子发布或MySQL事务中保存versioned origin digest与DB-time高水位；通用commit不能由caller伪造ordinary origin。COMMIT后独立事务重验精确owner、terminal source、两条outbox与不可领取的purge，完成可能等待的锁后再取DB时间，按`seal_observed_db_ms + 1ms + 30天`封存最低保留floor。首事务失败全回滚，第二事务失败只留下未seal origin；同owner重试或有界恢复原语可exact seal。旧writer、user/tenant erasure、generation-0补偿及来源缺失保持`unknown`，不回填、不从同形event推断ordinary。证据与owner同在session行，T3f删除该行时也删除证据；只读结果固定`executionReady=false`、`physicalPurgeEnabled=false`。`purge_after_ms=NULL`、`session.purge`不可领取，当前没有自动调度/物理purge，也不能把30天floor当删除许可。0050虽严格核对列/CHECK形状和marker，但没有SQL级write-once origin guard，也不强制旧DELETE writer双写；mixed-writer coverage、schema drift与最小权限须继续作为升级门禁。真正清理还必须重新验证canonical policy/hold及其它域、备份/恢复与外部ACK，90天等更长期限不能被30天缩短。
4. `410c604`把上述未seal来源恢复原语接到runner内嵌轮询，单独由`SESSION_DELETE_GRACE_RECOVERY_ENABLED=0`默认关闭gate保护；开启后默认每30秒扫描至多25个候选，每条仍以原锁定/来源重验/CAS seal收口，多runner重复扫描也不产生第二个floor。router拒绝恢复变量，普通`verify`清掉ambient激活；没有新服务、进程、CLI、bundle入口、镜像或purge排期/领取/执行权。损坏候选fail closed，可阻断同批后续项；没有逐候选quarantine/游标跳过、专用候选索引或统一whole-operation deadline，规模/停机耗时和mixed-writer排空仍待staging验收。默认关闭不等于自动收敛。
5. `e182eab`收紧新provider失败的元数据边界：PiEngine不把上游`errorMessage`传到step/sink，catch只给闭合`provider_error`；SessionHost即使遇到旧或故障engine返回任意error文本，也只把`{code:"provider_error", message:"Provider request failed."}`写入turn、持久化`error` event和SSE。summariser失败与相关日志只记录固定文本，不打印异常对象。公开message不再包含429/rate/URL等上游细节，是兼容性变化；客户端应依赖固定错误码与stopReason。历史已持久化原始错误没有迁移或擦除，第三方SDK/Node其它输出仍需审计；这也不表示0049 capture v2已激活。
6. `17550d9`修正三个冻结旧二进制真实MySQL迁移夹具的**当前tail**断言：0039、0040、0041各自的冻结旧schema/旧terminal前态仍精确保持，升级后marker与当前migration文件全集比较，不再把43 marker/0044终点硬编码；根package只容许测试脚本增加，依赖字段、lockfile和各workspace manifest仍须精确一致。它修复新增0049/0050后夹具过时造成的测试失败，不增加旧binary所覆盖的业务状态，也不改变产品migration。

### 验证状态和下一步

- `0049`已登记`0044→0049`独立真实MySQL历史夹具，`0050`已登记从预置0044并经过0049升级到0050的独立真实MySQL历史夹具；两者均由required migration wrapper与CI显式要求执行，runner image marker也检查0049和0050。0050另有Memory、真实MySQL named suite及普通DELETE→T3f成功/回滚定向测试，恢复caller有独立Memory/真实MySQL named suite及required-suite证明。此前一次整批`verify`的主coverage阶段通过 **2045 passed / 56 expected skipped**，但冻结旧夹具仍断言固定0044 tail而中止，故该次**整体不通过**；`17550d9`后三个夹具的定向真实MySQL回归 **3/3** 已通过。重新运行的当前批次已通过主coverage **190 files（177 passed / 13 expected skipped）/ 2057 passed / 56 expected skipped / 0 failed**，statement/branch/function/line分别为 **79.17% / 75.03% / 86.64% / 81.96%**；真实MySQL历史migration wrapper **43 files / 254 passed / 0 skipped / 0 failed**，required逐文件执行证明通过。命名专项、cluster、`build:check`仍在进行，因此完整`verify`尚不能宣称通过。独立`verify-s3` **12 files / 55 passed / 0 skipped**；本批推送后CI也仍待实际结果。0044基线`6d95a76`的[GitHub Actions run 38344734960](https://github.com/zhgqwx-del/agent-service/actions/runs/38344734960)中test、runner image、router image均已成功，但它不验证后续新提交。完成本批后应记录完整`verify`退出码与CI job结果。
- 下一安全工作仍是可信source-valid DB grant、外部authority与同keymarker物理验真、0030/0031旧快照fresh-head replay/startup gate、跨MySQL/S3 ACK saga，以及0050 ordinary DELETE 的SQL级防绕过和最终默认关闭的策略执行门禁。已接入但默认关闭的未seal恢复caller只修复可信来源的post-COMMIT第二步，不补历史unknown或授予清理权。0045～0048的GET或非生产fixture、0049的休眠schema、0050的时间下限均不解除0037 hard-deny、T3d logs/traces blocker或全域completion=false。M1尚不能正式冻结，不能提前开始M3；VM与OCI双形态生产交付和真实staging/production验收仍属M4后续工作。

## 2026-10-13（M1 普通 DELETE 来源封存：0051 SQL write-once guard）

- `f6cb2df`新增独立`0051_ordinary_session_delete_origin_guard.sql`：create-only可重放的`sessions BEFORE UPDATE` trigger只保护已存在的0050证据。origin必须随首次live→tombstone更新写入；写入后origin digest/DB时间、以BINARY比较的tenant/user/session身份、删除generation/time及lastSeq不可变。seal只能在旧行版本已有origin时写入，非NULL后seal时间、30天floor与digest不可变。该trigger不会把旧无来源tombstone伪造为ordinary，T3f仍可删除整行。0051后相关启动指纹集合为140（不是全库trigger总数）；0049自身的139-trigger指纹仍是历史边界。
- 迁移不回填、不联网、不启用worker或purge；marker丢失且精确trigger已在位可create-only重放，动作/形状漂移与新旧marker顺序错配均fail closed，启动核对完整trigger action与既有0050列/CHECK。必须在独立迁移前停止DELETE流量、排空pre-0051 writer与在途事务，随后只运行0051-aware进程并forward-fix。trigger本身不证明来源来自trusted业务入口、也不证明0050两次COMMIT；无origin的旧普通DELETE及erasure/legacy继续为unknown，旧writer仍可写出unknown。最小权限、schema drift监控与不可绕过的mixed-writer来源覆盖仍待后续切片。
- 新`0050→0051`真实MySQL历史升级夹具已列入required migration wrapper与GitHub Actions，覆盖旧sealed 0050证据与unknown tombstone保持、create-only marker-loss重放及动作漂移拒绝。`session-delete-grace.mysql`另覆盖late backfill/来源或seal改写拒绝、BINARY owner/source冻结、合法post-COMMIT seal；既有T3f Memory/MySQL专项另验证sealed origin随canonical session行删除；runner image marker检查0051。它没有提升`physicalPurgeEnabled=false`、`purge_after_ms=NULL`、不可领取的`session.purge`、0037 grant hard-deny、T3d logs/traces blocker或全域completion=false，也不新增服务、进程、JavaScript入口或镜像。
- 验证状态：此前未含0051的整批`verify`在完成主coverage与历史迁移阶段后被明确中断，退出码 **130**，不能称为完整通过；0051隔离worktree的Memory **7/7**、真实MySQL **7/7** 与`0050→0051`历史夹具 **2/2** 已分别通过。当前主工作树（代码`f6cb2df`）完整`scripts/local-service.sh verify`已于2026-10-13T09:27Z确认退出 **0**：`pnpm check:secrets`扫描 **598 files**、API生成物检查、typecheck与全部前后置命名专项通过；主coverage报告（2026-10-13T08:35:51Z）为 **190 files（177 executed / 13 expected skipped）/ 2058 passed / 56 expected skipped / 0 failed**，statement/branch/function/line分别 **79.17% / 75.05% / 86.67% / 81.97%**，required-suite执行证明通过；真实历史迁移报告（2026-10-13T08:58:25Z）为 **44 files / 256 passed / 0 skipped / 0 failed**，逐文件required proof通过。多进程cluster **8 files / 28 passed**、T3g独立cluster **1 file / 3 passed**均通过；`build:check`通过SDK pack/runtime/type安装校验、runner四入口/router一入口构建、三个one-shot入口plain Node执行，以及bundled双服务readiness、鉴权、转发与OpenAPI检查。独立`verify-s3`的既有 **12 files / 55 passed / 0 skipped**只证明其执行时的S3协议/装配，不代替当前完整验证。0051本批推送后的GitHub Actions仍未发生；旧0044基线[run 38344734960](https://github.com/zhgqwx-del/agent-service/actions/runs/38344734960)全绿不验证0051。本批推送后仍须按实际CI job结果更新本节；0052隔离候选不属于本次主树完整验证。
- 下一安全切片是独立默认关闭的ordinary session operational usage retention：删除时绑定immutable policy，首次执行在原子边界独立重验来源、post-COMMIT floor、更长政策、hold、erasure/restore fence与账单事实，只删除operational ledger、保留billing proof；目前仍在隔离工作树开发，不属于上述0051验证。可信source-valid DB grant、外部head/同keymarker验真、0030/0031旧快照恢复门禁、跨MySQL/S3物理ACK及完整session/user内容清理仍未闭环。M1不能冻结，M2维持本地/CI冻结，M3尚未开始；VM与OCI双形态生产交付及真实staging/production验收仍属M4。

## 2026-10-13（M1 普通 session operational usage retention：0052）

- `7ade280`已从独立候选分支合入main。新trusted ordinary DELETE与0050 origin同一事务绑定不可变policy v2来源；未配置/NULL期限如实保存并保持不可执行，不采用日后政策补造旧来源。执行在Memory同步原子边界/MySQL RR事务内独立重验tenant/user/session owner与generation、0051 origin/seal、可信DB时间、30天与删除时/当前更长政策、canonical hold、erasure/永久restore fence、reconciliation及全部独立billing facts，只删除operational usage ledger，并原子发布write-once receipt。session/content/event、reconciliation、匿名billing facts仍保留，因此不是全部内容purge或完整去身份化。响应丢失只能精确重放，原政策/账单来源漂移或残留ledger会拒绝；Memory晚期publication失败及MySQL SQL失败都恢复原状态。
- 新T3f receipt加入绑定完整身份、pre-delete/physical-ACK receipt的prior-retained-billing bridge：先独立验证此前0052匿名账单，再从T3e本次集合扣除，剩余必须与原ACK精确一致，所有billing仍保留并重算。grave同事务保存ordinary source/receipt两个摘要，canonical session删除后仍可重建扩展session_content root；legacy NULL/v1 receipt与grave hash保持原值，旧terminal不回填。每session超过10000 facts会拒绝执行而不截断；tenant bridge不套此人为上限，但仍受大JSON、全范围锁、内存与数据库packet容量约束。
- 独立`0052_ordinary_session_usage_retention.sql`增加八个nullable列、五个guard与相关145组合指纹（不是全库trigger总数）。新origin必须同时绑定来源；source/receipt封存write-once，SQL闭合JSON shape、owner、policy和terminal guard。历史`0051→0052`真实MySQL夹具保留旧sealed/unknown与legacy v1 hash、不回填policy，覆盖partial-DDL、marker-loss、drift拒绝及pre-0052指纹模式拒绝新schema；这是SQL-shaped历史，不是冻结0051 executable。发布须先关闭相关gate、完全排空pre-0052 writer与在途事务，再独立迁移，仅启动0052-aware进程，之后forward-fix。
- worker已内嵌runner：`SESSION_USAGE_RETENTION_WORKER_ENABLED=0`及router `SESSION_USAGE_RETENTION_ENABLED=0`默认关闭，production拒绝开启；默认30秒、每批25项，分别由`SESSION_USAGE_RETENTION_WORKER_POLL_MS`与`SESSION_USAGE_RETENTION_WORKER_BATCH_SIZE`配置。候选只作扫描，逐scan/reconcile/execute都取fresh configured-fleet ACK；queued probe不伪装actual in-flight，过期请求不能复用旧探测。毒化候选fail closed而cursor可继续，停止不新增执行边界并等待in-flight。fresh gate不自动证明旧writer排空或独立boot identity，稳定直连URL、人工drain与最小权限仍是发布门禁；统一whole-operation deadline及规模/锁等待/优雅停止验收仍缺。没有新服务、进程、JavaScript入口、镜像或public Runtime API；`session.purge`不可领取、`purge_after_ms=NULL`、telemetry硬拒及所有全域completion=false不变。
- 定向验证已通过：Memory **20/20**、独立codec/bridge **14/14**、真实MySQL store **13/13**、真实`0051→0052`历史夹具 **2/2**、core/runner-client/router gate **31/31**、真实MySQL runner worker **3/3**；T3f/T3g Memory全文件 **24/24**，MySQL T3f定向选中四个case **4/4**（不是整文件全跑）。typecheck、API drift与secret scan **610 files**通过；独立复审无P0/P1/P2。CI新增四个可见named step并要求零skip执行证明，同名store/runner MySQL report使用不同路径防覆盖，历史wrapper与runner image均检查0052。合入后首次完整verify于2026-10-13T09:39Z启动并退出1，失败详情与环境原因见下一条；七个失败文件已在补建隔离基库、正常开盖运行的环境完整复测 **7 files / 148 passed / 0 failed / 0 skipped**，未改业务代码、断言或超时。新的完整`scripts/local-service.sh verify`已于2026-10-13T11:17Z重新启动，目前仍在执行，不能把0051的2058/256等数字或定向复测当作0052完整成功。完整结果与推送后的新CI仍待实际退出码/job记录。
- 首次完整verify最终退出 **1**，主报告为 **197 files（7 failed / 177 passed / 13 skipped）/ 2099 passed / 35 failed / 69 skipped**，历史迁移、后置专项、cluster和build阶段尚未到达。其中共享base的三个MySQL文件共32个失败均为`Unknown database`：本轮指定新测试库但遗漏预先建库；其它失败/未执行来自hook超时及host drain wall-clock断言，系统电源日志确认06:01和06:36（EDT）两次合盖休眠及987/324/1061/379秒暂停，与相应等待相符。独立backup-catalog named复测 **13/13**、零skip已通过，不覆盖这次失败。已保留原失败JSON，只创建此前不存在的隔离test base，未删除或修改既有业务库；七个失败文件已完整复测 **148/148、零skip**，随后重新启动完整verify，未放宽断言/超时。防闲置休眠不能阻止合盖休眠。该失败和重验均不属于0051历史成功结果。
- 用户已确认BYOK只清本系统保存的key、厂商侧撤销由客户负责。T3a本地live数据库credential行删除、T3b受跟踪runtime引用撤销已存在，但不证明MySQL页/binlog、备份、日志、第三方SDK或内存所有副本安全擦除；0026/0029尚无versioned客户责任来源，历史external blocker不重释，不使用fake制造remote ACK，也不执行真实厂商撤销。全局共享平台key不属于tenant BYOK，不得因单tenant删除而销毁。
- 下一块优先建设真实“MySQL完整逻辑备份制品→实际bytes验真→所选制品隔离恢复”，复用0030/0031现有entry/reservation/fence，不再把operator提供摘要或roundtrip测试当成产品backup producer。它不是InnoDB页级物理backup，也不顺带备份Blob/Redis或证明独立故障域；随后完成第一条managed telemetry可信grant/CAS/物理ACK/旧快照恢复链，以及独立默认关闭的session/user内容purge。BYOKversioned责任和平台保存副本生命周期、KMS与其它域proof仍需闭合；M1不能冻结，M2维持冻结，M3尚未开始，M4 VM/OCI双形态及真实资源验收仍待后续。
- 上述backup artifact目前只在隔离worktree开发，未合入main。2026-10-13T11:46Z候选`verify-s3`在首个既有Blob套件startup写入返回HTTP 507而退出1，新的17例实际MySQL/MinIO套件尚未到达，不能称为通过；失败JSON保留。只读检查发现数据卷99%、约4.3GiB可用；用户明确授权后，经MySQL精确范围/复制状态复核，仅以`PURGE BINARY LOGS TO 'binlog.000043'`清除旧000001～000042，释放约29.7GB、可用空间恢复至约32GiB，保留000043与当前日志、未修改数据库表或降低MinIO保护阈值。旧日志不可恢复，对应历史时间点恢复/复制依据不再保留；这项显式授权运维动作不属于应用删除权限或tenant生命周期完成证明。候选还在修复超时后的late文件句柄/FIFO资源清理，随后必须完整重跑真实S3验证。主树0052完整verify仍独立执行；候选单元/构建结果不能代替主树或真实S3执行结果。
- 阶段重验更新：主树0052主coverage报告（2026-10-13T11:23:16Z开始）现为 **197 files（184 executed / 13 expected skipped）/ 2147 passed / 56 expected skipped / 0 failed**；coverage **79.34% / 75.21% / 86.70% / 82.13%**，required proof通过，真实migration仍在运行，不能称完整verify已通过。隔离backup候选FS cleanup已修并通过18条核心unit/typecheck和独立review；2026-10-13T11:56Z重新verify-s3，首五个既有专项合计 **22 passed / 0 skipped**，随后新suite baseline producer失败，beforeAll失败且 **17 skipped**，整体退出1，保留JSON。这是新的实际失败，不是此前507或成功的单元测试结果，仍须定位并完整重验。
- 0052完整重验最终结果（2026-10-13T12:48Z）：代码`7ade280`的`scripts/local-service.sh verify`确认退出 **0**。secret scan **610 files**、API/typecheck、全部前后置named专项通过；主coverage **197 files（184 executed / 13 expected skipped）/ 2147 passed / 56 expected skipped / 0 failed**、四项coverage **79.34% / 75.21% / 86.70% / 82.13%**；真实历史migration **45 files / 258 passed / 0 skipped / 0 failed**，required逐文件执行证明通过；cluster **8 files / 28 passed**、独立T3g cluster **1 file / 3 passed**及SDK/runtime/type安装、runner四入口/router一入口、三个one-shot plain Node和bundled双服务readiness/auth/forward/OpenAPI均通过。主coverage与migration的成功JSON另保存带0052/时间标签的副本，原失败报告仍保留。本批尚未推送，新GitHub Actions仍待实际结果；隔离backup候选未合入，partial17结果及带过滤skip的schema诊断不能当作完整成功。真实锁等待取消修补已通过，实际import后的两张表schema差异及强原因负例仍在闭合，不能放宽schema校验或借0052主树结果证明该候选。


## 2026-10-13（M1 本地MySQL加密逻辑备份制品，code-only候选）

- 在既有`backup-catalog`增加`create-artifact/verify-artifact/restore-selected`，不新增schema、daemon、JavaScript入口或镜像。旧catalog adapter/`publish-backup`仍只绑定operator-attested摘要；新producer才实际dump MySQL 8 InnoDB应用逻辑SQL、核对同源anchor/完整marker/schema、AES-GCM加密并认证实际bytes。只允许可信本机、非production、在线source、canonical 0700目录、独立0600 raw 32-byte key和绝对宿主工具；runner镜像没有mysql/mysqldump。
- 恢复以actual source/target数据库tuple与filesystem/named lock串行化、在fresh catalog下永久reserve后向显式空且不同target执行真实DDL/DML，严格校验后同ID重建binding/run，仅到prepared。first-attempt-only：禁止提前旧prepare-restore、禁止任意已用run或epoch（含resolved）再次导入，跨目录/target/旧source也不能绕过。失败保留reservation/可能部分target，禁止自动DROP、清空或重导，需原ID/evidence和独立核验实际目标后人工forward-fix。旧metadata/restore-ledger路径仍不执行DDL；新import不是migration Job或DDL回滚事务，成功仍须显式replay/verify/审阅/activation。
- 单调whole-operation预算、native MySQL socket/S3 body/child cancellation和late FS cleanup贯穿实际操作；已发送COMMIT/CAS可能成功，不能以abort声称回滚，本地orchestration中受跟踪的task/child settle前不提前释放operator；这不证明已发送的远端请求物理静止或CAS回滚。可信本机FS/同UID/稳定endpoint、spool约4倍空间、可能超时orphan仍是边界；unknown/backslash DDL可能安全拒绝等价恢复。schema-root v2只规范真实string列、明确表默认utf8mb4与显式utf8mb4 collation的一段冗余CHARACTER SET显示，literal/default/order/index/constraint/table option/trigger保持严格，不用删DEFAULT NULL/排序索引等宽规则。
- 故障验证记录保留：首次完整S3在旧Blob startup因HTTP507退出1，经用户精确授权只清42个旧binlog后重跑；下一次新suite beforeAll因macOS临时路径alias不canonical而17skip，整体退出1；修复fixture后真实取消测试暴露mysql2 destroy仅FIN、native lock-wait未及时settle；真实导入则暴露两列SHOW CREATE冗余charset显示。只修明确运输/fixture/codec问题，不放宽cause oracle/DB schema/timeout，所有失败报告均保留。过滤诊断、旧14pass或beforeAll skip从未作为完整证明。
- 实际定向验证：八文件unit **148 passed / 0 failed / 0 skipped**（核心23、CLI43、wrapper2、native abort8、catalog/journal S3 unit各11、runner config37/router13）；targeted3 **3 passed / 14仅过滤skip**后，独立required完整套件 **17 passed / 0 skipped**并确认非零执行。完整`verify-s3`再次执行新17及旧55，共 **13 actual Vitest files / 72 passed / 0 failed / 0 skipped**，源码真实S3 router/runner装配通过；独立七类I_S及十类trigger happy-path全部零差异，negative精确验证阶段/固定code，非晚期无关异常假通过。fixture DB/临时key目录/专用MinIO prefix均归零，仅清理自有资源。
- 最终typecheck、API drift及secret scan **618 files**通过；最终`build:check`退出0：SDK archive18files及runtime/types安装、runner四JS **26045KB**/router一JS **881KB**、plain Node mover **1643566B**/restore **4480669B**/backup **4624217B**及bundled双服务readiness/auth/forward/OpenAPI通过。独立冻结读审未发现P0/P1/P2。原本`verify-artifact`可对账content-free投影，文档不称严格只读；新真实import与旧DDL-free命令明确区分。
- 候选完整`scripts/local-service.sh verify`已于2026-10-13T14:44Z确认退出 **0**，未借用0052结果：secret scan **618 files**、API/typecheck及全部前后置named通过；主coverage **200 files（186 executed / 14 expected skipped）/ 2206 passed / 73 expected skipped / 0 failed**，四项coverage **79.59% / 75.39% / 86.74% / 82.39%**，required逐文件证明通过；真实历史 **45 files / 258 passed / 0 skipped / 0 failed**。cluster **8 files / 28 passed**、独立T3g **1 file / 3 passed**、SDK archive/runtime/types、runner四入口/router一入口、三个one-shot plain Node及双服务readiness/auth/forward/OpenAPI全部通过。成功coverage/history JSON已另存时间标签副本。生产代码在本轮完整verify期间冻结；之后仅同一deadline测试有效性修补额外15/15重验，最终typecheck/secret scan618/diff check通过。候选待提交/main集成/推送，新具名CI步骤尚未运行，不声称新CI全绿。
- 本切片不证明任意schema、InnoDB页级物理backup/PITR、Blob/Redis联合旧快照、tenant backup-copy erasure、pre-activation未发布T1、真实云IAM/KMS/独立故障域或RPO/RTO。M1仍未冻结、M2保持冻结、M3/M4主体未开始。下一功能优先贯通真实provider-step持久化capture→durable spool/MinIO ACK，再闭合可信telemetry grant/处置/恢复和独立Redis disposition evidence，随后做默认关闭普通session/user内容purge；BYOKversioned责任来源不伪造客户厂商侧撤销。
- 额外配置兼容边界：现backup/restore-ledger CLI的verify-only store连接不传0033 exact ref key，active telemetry lifecycle会安全拒绝。因此当前真实17例只证明inactive telemetry数据库的制品/恢复，不证明所有lifecycle组合；不得绕过startup audit、降级control或宣称active telemetry可备份。provider capture激活前需补受保护ref-key接线及active真实备份恢复验收。

## 2026-10-13（CI deadline 测试有效性收口）

- 已推送的`df45fee`对应[run 38400793443](https://github.com/zhgqwx-del/agent-service/actions/runs/38400793443)两个image通过，但test主coverage为197文件/2146通过/1失败/56预期skip，后置专项、历史与cluster/build被跳过。唯一失败是telemetry disposition S3共享deadline测试仅接受`deadline/timed out`文本，而请求预算取消会合法地经脱敏层返回`TimeoutError`；不表示新CI全部通过。
- 只修改测试夹具：用同一可控时钟验证100ms共享预算、第三个请求实际AbortSignal取消、零对象发布，以及再推进1000ms后无新增请求或迟到mutation；接受既有合法的脱敏TimeoutError，没有扩大预算、改生产逻辑或取消安全断言。完整15例定向通过，随后连续十次完整执行共150通过/零失败；typecheck、secret scan610及diff check通过。新的CI尚待推送/执行。
- 本地backup候选仍独立未合入；真实17/17和完整verify-s3 72/72、最终unit148及build已通过，完整verify主200文件/2206通过/73预期skip/零失败，真实历史45文件/258通过/零skip、全部后置专项、cluster28及独立T3g3、build均通过，完整verify于14:44Z退出0。发现旧backup/restore CLI未注入0033 active所需exact ref key，当前只可在telemetry lifecycle inactive状态演练；active状态安全拒绝，不可称所有配置都支持。后续在provider capture激活前须补受保护key接线与active状态真实备份恢复测试。M1未冻结，M2保持冻结，M3/M4主体未开始。

- 集成事实（2026-10-13T14:51Z）：deadline测试修补为`387593d`，已完整验证的backup切片已以`f74c971`合入main（候选`940f50f`，deadline文件与main完全一致，故cherry-pick无该文件增量）；两个新code commit均尚未推送。完整verify退出0、真实S3 72项、独立最终复审与失败报告的证据保持，不借用旧CI。主树集成后继续typecheck、secret scan和diff/status复核，随后批量推送等待新的三个Actions job。下一capture分支仍隔离开发，尚未激活/合入/推送；active0033 protected-key兼容门禁仍未闭合。

- 推送事实（2026-10-13T14:54Z）：`387593d`、`f74c971`及文档`5d669cf4e7aa71543b01a3eeebb90add77d0c934`已批量推送main，集成后typecheck、secret scan618及diff check通过；15:28Z两个image通过、test仍执行的观察记录保留，之后终态以本页最新节为准。

## 2026-10-13（0053 provider失败持久化capture候选，验证进行中）

- main已推送`5d669cf4e7aa71543b01a3eeebb90add77d0c934`。截至16:40Z，新[Actions 38417167848](https://github.com/zhgqwx-del/agent-service/actions/runs/38417167848)的runner/router image均通过，test执行真实历史升级，尚未终态；旧run的deadline失败记录保持，不能借image通过或本地结果声称新CI全绿。
- 独立0053候选把真实Pi原provider失败的首failed-step item/events、usage/billing、versioned source binding、membership、spool/job及failure receipt放在同一Memory原子发布/MySQL显式RR事务中，之后另结束turn。精确store重放保留原seq/usageId；Host遇ambiguous commit只fence，不自动重跑模型。原日志对象/producer key/owner ref在任何clone或serialization前核验；runtime/tool/store/listener等synthetic失败保持unknown。既有NULL/gen0不会回填或凭时间冒充新source。所有产品gate默认0且production拒绝，actual0030 primary epoch、exact protected ref key、全部tenant coverage与人工fleet/旧writer排空ACK都是独立前置条件；v1/traces capture保持inactive。
- 0053新增两表、17列与15个trigger；相关组合指纹160和全库实际647→662不是同一数量。published0035/0049不回改，迁移前须停写并排空pre-0053进程/事务，独立迁移，只运行新binary，之后forward-fix。冻结0052旧binary确实在旧schema运行并写入旧失败状态，升级后由精确0035启动指纹拒绝；不是SQL-shaped旧业务，也不支持新旧writer热混跑。sidecar新增第六来源仍全局阻断T3d/T3f，grant、外部处置/恢复及全域completion=false不变。
- 单独required MySQL套件实际 **26 passed / 0 failed / 0 skipped**，含四个晚期SQL失败全事务回滚、真实RC默认连接下显式RR及并发phantom、原range精确重放、ordinary tombstone历史来源、legal-blocked最终session closure拒绝，以及真实子进程在COMMIT前/后两个窗口的SIGKILL。前窗口等待死连接回滚锁释放再验证零发布，后窗口保留真实提交后按原input精确重放，不把纯SQL rollback当crash proof。独立保存`.local-run/persisted-provider-capture.mysql.passed.json`。
- 冻结0052→0053 required历史升级实际 **8 passed / 0 failed / 0 skipped**，覆盖旧数据保持、精确新guard集合、旧binary启动拒绝、marker-loss/partial-DDL与列/索引/trigger漂移；`.local-run/0052-to-0053.capture-passed.json`保留。开发轮两处oracle错误（I_S字段大小写与旧binary先命中0035而不是0049）已收紧为实际精确断言，失败报告保留，没有放宽产品guard。MySQL8.0.26默认optimizer下原nested anti-join闭包曾拒绝所有真实匹配关系；将其改为同样16个约束的PK-unique LEFT JOIN计数后整套26通过。仅诊断session关闭semijoin/materialization的结果不作release证明，不修改全局optimizer，也不认定某个未独立证明的上游bug。
- backup/restore-ledger新增可选受保护`TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE`，source/target同exact raw32-byte key；direct CLI拒绝ambient应用hex ref-key（含空值），wrapper在dotenv之后清除它且显式caller路径优先，长期进程不接operator文件。实际required backup整套 **18 passed / 0 failed / 0 skipped**，包括active0033数据库真实制品→空目标导入→replay-fences→verify/getter，缺/错key仍拒绝；`.local-run/mysql-backup-artifact.capture-active0033.passed.json`保留。该case的应用capture inactive，不证明active0053在新epoch可恢复或外部telemetry bytes被备份；activecapture epoch不自动rebind，仍需后续versioned恢复协议。
- 真实native HTTP router/runner/Pi/Host/MySQL/MinIO required capture首轮 **5 passed / 2 failed / 0 skipped**：401、429、SSE失败、socket-drop和空失败走实际fresh fleet、persisted source及MinIO ACK；流式已有item失败在独立source一致性校验拒绝，正常流式回复由未知cost触发既有max_cost安全阀而非end_turn，正在分别定位。`.local-run/telemetry-capture.mysql-s3.first.failed.json`保留；不得放宽source断言、改变item.seq或忽略成本安全阀来制造绿灯。完整候选verify/verify-s3、最终build/差异审查、提交与新CI均待完成。
- 每v2 capture/claim/reserve/create/ACK要求fresh全configured-fleet proof，legacy-only在LIMIT前过滤v2，不让关闭/失效v2 gate阻断既有v1/traces。reserve/create保持live owner/T1/policy/hold/runtime校验，已有reservation ACK和同owner历史source可在ordinary tombstone后精确收口；最后DB检查到external create仍有TOCTOU，不是分布式事务。sealed source的operational usage暂不可删除，usageBD以current-read FOR SHARE避免旧RR视图遗漏新receipt；没有独立释放协议。全范围锁/大租户容量、特权数据库元数据、自动fleet排空证明、activecapture旧快照恢复、真实cloud验收仍为风险。新增五命令one-shot CLI只是第六JS入口，不新增daemon、service或image，M1未冻结、M2维持冻结。

- 后续修复与验收（2026-10-13T16:49Z）：真实streamed item必须保留首次started的稳定seq，MySQL独立verifier原误要求其与completed sourceEventSeq相等。最窄修复仅改为safe integer、正数及不晚于completion，并在Memory使用相同bounds；row/body seq、owner/ref/class、completed exact snapshot/root/count/range与codec/hash/SQL不改。新增真实started3→completed4/usage5、get/replay/原range/fresh startup及SQL防篡改回归后，required MySQL整套 **27/27、零skip**，Memory **16/16**，独立保存`.local-run/persisted-provider-capture.mysql.streamed-seq.passed.json`；Host **8/8**明确保持客户端稳定seq。正常fake模型只补明确正toyprice并断言实际已知costCNY=0.00012且低于默认10，成本安全阀和end_turn预期不变。真实HTTP/MinIO required整套重跑 **7/7、零skip**，`.local-run/telemetry-capture.mysql-s3.passed.json`保留，第一轮失败JSON不删除。
- 最终全仓typecheck、secret scan **646 files**、`build:check`均退出0：SDK安装/archive18 files，runner五JS **33337KB**/router一JS **898KB**，plain Node mover **1646904B**/restore **4582155B**/backup **4726397B**/capture **4560805B**，双服务readiness/tenant-platform auth/forward/OpenAPI全部通过。build smoke额外清除两个capture authority前缀，显式无效capture测试变量下仍通过；Dockerfile增加第四one-shot presence，真实image结果仍待新提交CI，不借main旧image结果。独立只读复审无新增P0/P1/P2，以上P3环境不确定性已修。
- 代码和测试现冻结；完整`scripts/local-service.sh verify`已于 **2026-10-13T16:47Z** 在独立工作树启动，尚待终态，之后串行`verify-s3`。当前类型/定向/build成功不是完整verify/新CI通过；本批仍未提交/合入main/推送，先保留实际成功/失败报告和main现run，再按大阶段集成。

- 后续实际失败与修正（2026-10-13T17:08Z）：main [CI 38417167848](https://github.com/zhgqwx-del/agent-service/actions/runs/38417167848)已终态 **failure**；两个image通过，历史 **44文件通过/1失败、257测试通过/1失败**，唯一失败是0029→0030首/中/末三个完整升级共用一个30秒测试窗口。将其改为三个独立测试，每项仍30秒、相同freeze/partial-DDL/marker/两control断言不变；真实完整文件 **18/18、零skip**，`.local-run/0029-to-0030.independent-boundaries.json`保留。候选首轮完整verify另在fresh-schema grant guard漂移检查退出1（4通过/1失败）：SQL守卫正确拒绝，但oracle仍要求旧0049错误名；经只读全库审计仅此当前schema断言应改精确0053，封顶0049/0052与frozen旧binary等历史oracle全部不改。整套真实grant **5/5、零skip**，首次失败保存`.local-run/0053-full-verify-first-grant-fingerprint.failed.json`，不宽regex、不修改产品守卫。第二次完整verify已 **2026-10-13T17:07Z** 从头启动，仍执行；没有选择性skip来制造完整证明，verify-s3与新CI尚待。

- 最新完整验证事实（2026-10-13T17:51Z）：第二轮已确认退出 **1**，主coverage **213 files（194 passed / 4 failed / 15 expected skipped）/ 2299 passed / 32 failed / 81 expected skipped**，因此历史链、后置专项、cluster/build未进入，不能称整套通过。31个失败来自`mysql-redis`、session-create/lifecycle atomic三文件在共享`agent_service_test`启动时精确拒绝`0036` statement96/104的trigger指纹；只读核查该库marker止0035、0036九表和29个disposition trigger已有footprint，但未确定更早来源。保留该库，不删marker/trigger或借重建掩盖历史状态。另1个OpenAPI契约测试把新增`/_internal/telemetry/persisted-provider-capture/ready`算作公开路由；仅明确排除这个token-authenticated私有路径，仍核对52业务/53含OpenAPI/55 spec，并额外断言私有路径不进入OpenAPI或生成SDK。新隔离库`agent_service_capture_verify_20261013`先确认不存在再创建，四个失败文件完整重验 **53/53、零skip**；`.local-run/0053-full-verify-r2-shared-base-and-openapi.failed.json`和`.local-run/0053-shared-base-and-openapi.retested.json`均保留。第三轮完整verify于 **17:49Z** 从头启动、源码测试冻结，尚待终态及串行verify-s3。文档同步四个runner one-shot/六JS和0035 v1 vs0053 v2 CLI边界，不改历史review/research。

- 下一M1垂直行为规划（未实现）：先支持0033/0053激活后新tenant、全部v2写在T1前written/真实ACK、原active-primary epoch的来源保留式本地删除链。须同一批闭合新版T3d v1/v2判别目录、T3e usage→billing保留证明及实际ledger删除、T3f canonical source/owner→grave独立closure及实际内容删除，再让历史getter/startup消费完整桥。新tenant还须锁定证明T3f不删除NULL/gen0旧failed item，避免不可加性pre-cut root漂移；runtime_unknown/gen1不可冒充managed source。旧tenant、pending/reserved、T1后ACK、新epoch/restore仍阻断，T1后不补新external create。telemetry对象仍保留、logs blocker不解除，physical ACK只证明Blob/export，0037 grant及全域completion=false不变；该规划不是已交付删除或M1闭环。

- 验证环境更正（2026-10-13T17:55Z）：第三轮在首个required lifecycle MySQL `beforeAll`即因新base名缺独立`test`标识退出 **1**，12条未执行，`.local-run/0053-full-verify-r3-base-name-guard.failed.json`保留；不能把命名门禁的skip算通过。未修改fixture guard或生产代码。先只读确认`agent_service_test_capture_verify_20261013`不存在，再创建新空隔离库；第四轮完整verify于 **17:53Z** 从头启动（state目录的`T1754-r4`只是label），尚待终态。旧共享库及第三轮非合规名称的本任务临时库均保留，不覆盖既有数据；之后verify-s3也必须使用当前合规base，不能回到旧`agent_service_test`。

- 只读收敛与验证观察（2026-10-13T18:14Z）：第四轮已通过全部前置named专项，主coverage仍在真实MySQL串行执行，没有完整通过/历史链/后置cluster/build结论。当前文档已区分本地缺代码与真实云环境验收，并明确本地加密MySQL逻辑producer已经存在；独立教学文档复审无P0～P2。下一批规划只接activation后新tenant、同primary epoch的retained-source垂直链；必须在T1 admission线性化事务中封存完整written/ACK cohort与pending/reserved/blocked集合，不能凭时间或T1后的迟到ACK升级资格。删除前原子封存T3e usage→billing桥和T3f canonical/event/owner→0039/grave桥；历史读取严格区分完整live、usage已释放但canonical仍在、canonical已闭合三态，缺任何精确证据就拒绝，commit/reserve/create不接受历史分支。此规划未实施，restore/new epoch、旧tenant/gap、真实grant/日志外部删除及全域completion仍保持阻断，不因无云资源省略产品实现。

- 第四轮完整验证终态（2026-10-13T19:05Z）：18:52:22Z确认退出 **1**；前置named专项全通过，主coverage **213 files（198 executed / 15 expected skipped）/ 2331 passed / 81 expected skipped / 0 failed**，statement/branch/function/line **79.71% / 75.71% / 86.71% / 82.59%**，required逐文件证明通过。真实历史迁移 **46 files / 265 passed / 3 failed / 0 skipped**，后置专项、cluster、最终build与verify-s3未进入，不能称完整成功。成功主报告与失败历史报告分别保留为`.local-run/0053-full-verify-r4-main.passed.json`、`.local-run/0053-full-verify-r4-historical-oracles.failed.json`。三个失败均为0039/0040/0041冻结二进制在完整升级后的拒绝probe，实际旧terminal/旧初态、升级与数据保持此前已通过；0053新增subject列/CHECK使旧0035严格schema指纹先拒绝。仅调整六个测试文件：先用当前SQL封顶0040/0041/0042并验证精确原目标指纹拒绝，再完整升级到0053、验证精确0035首拒绝；闭合stage、verify-only、marker全序列、旧数据hash与tenant/unknown断言保持，不扩大正则或超时、不修改产品/历史SQL。独立只读复审无新P0～P2，三个完整真实MySQL文件正在复验，尚不能记作通过或新CI验收。

- 历史拒绝证明复验（2026-10-13T19:05Z）：三份完整真实MySQL冻结旧二进制夹具 **3 files / 3 passed / 0 skipped / 0 failed**，每份同时验证原目标版本指纹与0053完整tail首个0035指纹的精确拒绝，原真实terminal与历史数据保持不变；报告`.local-run/0053-historical-two-stage.retested.json`已独立读取逐assertion。typecheck和diff检查通过。第五轮完整`scripts/local-service.sh verify`已19:05Z使用本任务合规隔离base从头启动，源码/测试再次冻结；这三项复验不能替代完整verify、verify-s3或新CI，仍须按实际终态记录。

- 第五轮阶段结果（2026-10-13T19:45Z）：前置named和主coverage均通过，真实主报告为 **213 files（198 executed / 15 expected skipped）/ 2331 passed / 81 expected skipped / 0 failed**，coverage **79.71% / 75.70% / 86.71% / 82.59%**；76个required文件逐assertion均非零passed且零其它状态。独立读取JSON并另存`.local-run/0053-full-verify-r5-main.passed.json`，主阶段实际19:11:48Z至19:42:18Z。完整历史链现串行执行；这不是整体exit0，后置named/cluster/build、verify-s3与新CI仍待。教学文档补充来源不明旧测试库保持、独立test命名、新隔离基库和显式双URL、串行运行说明，不删除旧库或弱化guard。

- 第五轮完整历史链（2026-10-13T20:05Z）：**46 files / 268 passed / 0 failed / 0 skipped**，逐required文件证明通过；独立读取逐assertion并另存`.local-run/0053-full-verify-r5-historical.passed.json`。实际19:42:28Z至20:03:39Z，三份修正的冻结旧binary夹具均在本轮完整run通过，原0029→0030三独立边界约5.8秒且每项预算仍30秒。当前后置named正在执行，仍无整个verify的exit0、最终cluster/build、verify-s3或新CI通过结论。源码/测试83文件摘要与第五轮启动时一致；文档只澄清0049原始硬拒与后续0053受控本地logs的版本边界，不改历史review/research。

- 第五轮完整验收终态（2026-10-13T20:35Z）：root确认session98477于20:32:01Z退出 **0**，前后置named、secret scan **646 files**、API/typecheck和required proof全部通过。主coverage **213 files（198 executed / 15 expected skipped）/ 2331 passed / 81 expected skipped / 0 failed**，四项coverage **79.71% / 75.70% / 86.71% / 82.59%**；真实历史 **46 files / 268 passed / 0 failed / 0 skipped**。cluster **8 files / 28 passed**、独立T3g **1 file / 3 passed**，SDK archive18 files/runtime/types、runner五JS **33337KB**/router一JS **898KB**、四个one-shot plain Node及双服务readiness/auth/forward/OpenAPI全部通过。此前失败报告、旧测试库、cap/full-tail两阶段拒绝证明不删除或改写；83个源码/测试文件冻结摘要保持。完整`verify-s3`已20:32Z在同一合规隔离base串行启动，仅内存加载main `.env`的四个MinIO设置，不回显key；其终态和新CI仍待，本批未提交/合入main/推送/常规激活。未跑paid-model verify-real或acceptance，因为本批来源与事务验证由实际HTTP故障/真实DB/MinIO覆盖。

- 完整真实S3终态（2026-10-13T20:41Z）：session40438于20:39:20Z确认`scripts/local-service.sh verify-s3`退出 **0**。root独立读取全部JSON：**14 actual Vitest files / 80 passed / 0 failed / 0 skipped**，各文件非零执行、全部assertion passed且时间落在本轮20:32Z之后；包含active0033 backup **18/18**、真实Pi/HTTP/fleet/MySQL/MinIO capture **7/7**及Blob mover **11/11**。源码真实S3 router/runner装配另外通过，不把smoke算为第15个Vitest文件；组合metadata/digest证据保存在`.local-run/0053-local-release-proof-20261013T2040.json`。普通业务环境未激活0053，未执行付费模型验证；这个受限写入切片仍不证明active0053新epoch恢复、可信grant/telemetry外部删除或全域completion。此前源码/测试83文件摘要仍相同，diff检查通过，最终提交前secret/typecheck复核正在完成；本批新CI尚未发生。
