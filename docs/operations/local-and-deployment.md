# 本地运维与后续部署契约

当前阶段以本机可重复运行和自动验证为目标；预发、生产资源就绪后，再把相同的环境变量契约映射到独立云服务器或 Kubernetes Secret、ConfigMap 和 Service。

## 本地生命周期

前置条件：Node 24、pnpm 12、`.env` 已由 `.env.example` 创建并填写。

```bash
scripts/local-service.sh start       # MySQL/Redis + runner + router
scripts/local-service.sh status      # 基础设施、进程、health 状态
scripts/local-service.sh smoke       # 无模型费用的启动/路由/鉴权冒烟
scripts/local-service.sh acceptance  # 十环节真实模型验收，会产生少量费用
scripts/local-service.sh logs        # 跟踪 runner/router 日志
scripts/local-service.sh stop        # 只停应用，保留 MySQL/Redis/MinIO
scripts/local-service.sh down        # 停应用和脚本拥有的本地基础设施
```

验证入口：

```bash
scripts/local-service.sh verify       # secret/API drift/typecheck + 集成/coverage + 0007→0030 历史迁移 + credential/blob/restore/tenant lifecycle 专项 + cluster + SDK/应用构建产物
scripts/local-service.sh verify-s3    # 启动本地MinIO，运行真实Blob S3、0028 mover、0030 restore-journal及源码runner/router装配套件
scripts/local-service.sh verify-real  # 使用本机 .env，仅跑真实模型 E2E
pnpm test:migrations                  # 独立真实 MySQL：固定 0007→0008→...→0029→0030 历史升级
pnpm test:blob-mysql                  # 强制执行并验明 Blob ownership/绑定/cleanup 的独立真实 MySQL 套件
pnpm test:blob-storage-control-memory # 强制执行0027 Memory cutover/回滚/并发语义
pnpm test:blob-storage-control-mysql  # 强制执行0027真实InnoDB inventory/回滚/并发语义
pnpm test:blob-storage-migration-mysql-s3 # 强制执行0028真实MySQL+MinIO离线搬迁/回滚/恢复套件
pnpm check:blob-storage-migrate-artifact # 构建后以plain Node执行runner一次性mover入口的稳定--help门禁
pnpm test:tenant-restore-journal-memory # 强制执行0030 Memory原子publication/runtime/replay契约
pnpm test:tenant-restore-journal-mysql # 强制执行0030真实InnoDB journal/runtime/replay/回滚/并发套件
pnpm test:restore-journal-s3          # 需独立测试bucket；强制执行0030真实MinIO journal chain/seal/replay套件
pnpm check:restore-ledger-reconcile-artifact # 构建后以plain Node执行runner一次性restore CLI的稳定--help门禁
pnpm test:usage-lifecycle-mysql       # 强制执行 usage 双写/reconcile/anonymize 的独立真实 MySQL 套件
pnpm test:subject-lifecycle-mysql     # 强制执行 subject gate/erasure request 的独立真实 MySQL 套件
pnpm test:tenant-credential-revocation-mysql  # 强制执行 tenant T1/T2 admission、status proof、credential fence 与 race 的两个真实 MySQL 套件
pnpm test:tenant-credential-physical-revocation-mysql # 强制执行 tenant T3a DB credential清除、global proof、DB-time claim与回滚套件
pnpm test:tenant-credential-lifecycle-mysql # 强制执行 0026 tracking/version/target/T3a inventory、并发与回滚真实MySQL套件
pnpm test:tenant-credential-target-execution-mysql # 强制执行0029真实InnoDB materialize/lease/ACK/cutover/回滚套件
pnpm test:tenant-runtime-revocation-mysql # 强制执行 tenant T3b job/全fleet receipt、claim/ABA、回滚与隔离套件
pnpm test:tenant-content-inventory-mysql # 强制执行 tenant T3c DB-clock/owner inventory/hold/orphan/回滚与隔离套件
pnpm test:tenant-purge-plan-mysql     # 强制执行 tenant T3d 固定33域/blocker/source/hold/回滚与隔离套件
pnpm test:tenant-purge-execution-mysql # 强制执行 tenant T3e local cutover/exact outbox/physical ACK/回滚与隔离套件
pnpm test:tenant-database-purge-memory # 强制执行 tenant T3f Memory 原子发布/回滚/grave/对抗套件
pnpm test:tenant-database-purge-mysql # 强制执行 tenant T3f 真实 InnoDB 锁/删除/回滚/replay/隔离套件
pnpm test:tenant-redis-purge-memory   # 强制执行 tenant T3g 纯契约/Memory ledger与restore projection套件
pnpm test:tenant-redis-purge-mysql    # 强制执行 tenant T3g 真实 InnoDB ledger/claim/lease/rollback/隔离套件
pnpm test:tenant-redis-purge-redis    # 强制执行 tenant T3g 真实 Redis Lua/marker/replay/防复活套件
pnpm test:tenant-redis-purge-cluster  # 强制执行 tenant T3g mixed worker/namespace与active fleet多进程套件
pnpm test:retention-policy-mysql      # 强制执行 canonical policy/multi legal hold/CAS/rollback/跨 runner 时钟语义的独立真实 MySQL 套件
pnpm test:erasure-purge-policy-mysql  # 强制执行 evaluator/authority、claim ABA、回滚和live evidence/hold重评真实 MySQL 套件
pnpm test:erasure-job-mysql           # 强制执行 erasure claim/lease/audit 的独立真实 MySQL 套件
pnpm test:erasure-session-mysql       # 强制执行 claim-bound session action/rollback 套件
pnpm test:erasure-catalog-mysql       # 强制执行 content-free catalog/completeness proof 套件
pnpm test:erasure-usage-mysql         # 强制执行 claim-bound usage reconcile/ABA/rollback 套件
pnpm test:legacy-tombstone-mysql      # 强制执行 generation-zero compensation/cutover/rollback 套件
pnpm test:user-data-export-mysql      # 强制执行 export snapshot/artifact/download/TTL/撤销清理套件
pnpm check:api                        # OpenAPI、运行时文档与生成 SDK 类型必须完全同步
pnpm check:sdk                        # 编译 SDK、原生 Node import，并检查发布 tarball
```

状态文件和日志写入 `.local-run/`，该目录不提交。`stop` 只发送 SIGTERM，让 runner drain；30 秒仍未退出时脚本会报错并保留现场，不会擅自 SIGKILL。实时测试数量、覆盖率和构建大小以`docs/PROGRESS.md`最新一节和当次CI为准，本文不固化易过期数字。

默认`.env`选择`BLOB_STORE=filesystem`，只启动一个独占`.local-run/blobs`的runner。共享数据面可在没有云账号时用仓库固定版本的MinIO验证：

```bash
scripts/build-local-minio.sh          # 校验并安装固定Go工具链，编译固定MinIO源码commit到.local-run/tooling
# 启用.env.example中从MINIO_ENABLED=1开始的S3配置块；不要提交.env
scripts/local-service.sh start
scripts/local-service.sh smoke
scripts/local-service.sh verify-s3
```

`MINIO_ENABLED=1`只控制`deploy/local/infra.sh start`是否启动MinIO；`infra.sh status`始终观察MinIO，`infra.sh stop`与`local-service.sh down`会尝试停止该脚本拥有的MinIO进程。`local-service.sh stop`只停应用，`verify-s3`也会保留它启动的MinIO，便于继续检查；需要结束全部本地基础设施时显式运行`down`并用`status`确认。`verify-s3`会显式启用MinIO，依次运行真实Blob adapter协议、`0028`真实MySQL+MinIO mover及`0030`真实restore-journal adapter套件，再以独立可丢弃数据库启动源码runner/router，验证`0027`激活、`0028`/`0030` dormant ledger和exact namespace capability协商。restore套件使用与Blob bucket不同的独立bucket，但两者仍由同一台开发机上的同一MinIO进程提供，只能证明S3协议，不能证明生产所需的独立故障域。空库可以直接由首次S3应用启动把`blob_storage_control`从generation 0不可逆激活到1；已有filesystem manifest/bytes的非空库则必须停服并按下文执行`0028`离线搬迁，不能通过手改control/manifest或直接切换`.env`绕过。

## 模块边界

- `agent-router`：无业务状态，可独立扩缩容。需要能访问全部 runner 的 `RUNNER_ADDR` 和共享 Redis；tenant erasure 的独立 platform token只在这里终止，公开admission/status和fresh all-fleet激活决策也只属于router。`0030`中router只持有三个非密钥restore identity digest与execution gate，不得持有原始journal namespace、S3 endpoint或credential。
- `agent-runner`：每个实例必须有全局唯一 `RUNNER_ID`，并发布 router 可访问的 `RUNNER_ADDR`；terminal-event dispatcher、Blob cleanup、user-erasure、legacy compensation、非破坏性policy evaluator、user-export build/cleanup，以及 T3a credential-store、T3b runtime-revocation、T3c content-inventory、T3d full-domain purge-plan、T3e local execution/physical-ACK、T3f local database-purge、T3g Redis-purge、`0029`external-credential target execution与`0030`restore-journal publisher都内嵌于runner。`0026` credential tracking与`0027` Blob storage control都是store/writer启动能力，不是新worker；`0028` mover和`0030` restore reconciler是同一runner源码和镜像中的一次性前台维护入口`blob-storage-migrate`、`restore-ledger-reconcile`，也不是daemon或额外产品镜像。只有runner及维护入口持有对象存储credential，router只传播非密钥identity并做fleet gate。
- MySQL：业务真相、事件、审批、配置、usage、subject lifecycle/user-erasure、tenant T1/T2 独立 admission/fence/status proof、T3a credential job/receipt/cutover、`0026` credential coverage/slot/version/target/inventory、`0029` external target execution job/target/ACK/receipt/cutover、`0030` journal publication queue/target/ACK、journal/runtime control与event、runtime head、restore run/sealed target/permanent fence/receipt、`0027` Blob storage control/namespace cutover、`0028` offline mover control/inventory/object ACK/source-target cleanup ACK/event/receipt、T3b runtime job/per-target receipt/aggregate receipt、T3c DB-clock content job/session receipt/aggregate receipt、T3d fixed-domain plan job/entry/aggregate receipt、T3e execution/domain-ACK/local-cutover/physical-receipt/write-once-cutover、T3f database-purge job/pre-delete evidence/domain ACK/session grave/terminal receipt/cutover、T3g Redis-purge job/target/target ACK/domain ACK/terminal receipt/cutover、policy/hold/evaluation证据、user-export request/job/snapshot/artifact/download/delete状态、Blob ownership manifest和各自独立outbox。生产schema迁移应作为独立Job执行，不能依赖所有runner同时自动迁移；两个one-shot CLI也都不替代通用schema migration Job。
- Redis：session lease hash（包含owner目录）、fence counter、hot replay stream、瞬时event Pub/Sub和T3g永久purge marker。生产环境必须启用满足恢复目标的持久化/高可用方案，不能把它当可随意清空的缓存；T3g精确清理不使用`FLUSHDB/FLUSHALL`，也不触碰quota/keypool/MCP等其它命名空间。
- BlobStore：filesystem与共享S3-compatible adapter使用同一小写key grammar和`ASBLOB02`单envelope；业务行只保存owner-scoped opaque `blobId`，`0010` manifest私有保存backend/key/token/integrity，`staging → ready`与item commit原子绑定，过期未绑定staging经独立outbox/claim lease物理删除。filesystem以0700/0600、create-only hard link和key-scoped cancellation fence提供本机语义，但root必须由单一runner独占，不承诺NFS/多runner、恶意本机目录替换或断电持久性。S3 adapter以同一对象key的data/tombstone、`If-None-Match: *` create-only发布、`PutObject If-Match` CAS tombstone、强读回验和有界stream读取提供跨进程语义；安全契约不要求`DeleteObject If-Match`，无条件delete只清理随机probe对象。启动会拒绝versioned、配置了任何lifecycle规则、启用Object Lock的bucket及不支持条件PUT的endpoint。`0027`把完整namespace digest与数据库write-once control绑定，并让active control拒绝异backend的新manifest、artifact、part、snapshot pin和delete intent；`0028`再为停服搬迁封存exact inventory并在cutover事务重写这些pointer。生产IAM还必须禁止非服务writer覆盖对象或在运行后添加lifecycle配置，并对这类控制面漂移告警；startup probe不能证明未来配置永不变化。T3e仍只闭合其local Blob/export子集；generic session/user ready-Blob purge与全域completion尚未完成。

## 环境配置原则

本地源码进程、CI 候选镜像和未来部署镜像遵循同一套环境变量契约，不把环境地址或密钥写进构建产物。当前 local 默认运行源码进程；CI 会临时构建并启动两个 OCI 候选镜像，但尚未上传 registry。staging/production 就绪后，各应用才按下述目标 promotion 契约使用同一 digest。

Runner 必需配置：

- `STORE=mysql`、`MYSQL_URL`、`REDIS_URL`
- `REDIS_PREFIX`：Redis session key前缀，默认`as`；T3g把lease/fence/stream/evt/purge放入同一session hash slot。已有T3g evidence后不能随意更改
- `REDIS_NAMESPACE_ID`：operator指定的非密钥逻辑Redis身份；启用T3g worker时必填，与prefix共同计算公开namespace digest。它必须准确、唯一地标识实际cluster/database/prefix，不能在无关namespace复用；URL故意不进入digest
- `SECRETS_MASTER_KEY`（后续替换为 KMS/envelope encryption）
- `RUNNER_ID`：全局唯一；启用 T3b 私有 endpoint 时还必须是该 configured runner slot 跨进程重启保持不变的逻辑身份（例如 StatefulSet ordinal 身份），不能用每次启动随机 UUID 或会随替换变化的 Pod UID
- `RUNNER_ADDR`：集群内可路由地址，不能是 `0.0.0.0`
- `INTERNAL_ROUTER_TOKEN`：router→runner 内部破坏性路由的共享凭证；production 必填，必须从 Secret 注入并与 router 完全一致
- `MAX_BODY_BYTES`：必须与 router 使用相同值；默认 1 MB，由 router 先拒绝超限请求
- `LIFECYCLE_OUTBOX_*`：runner 内置 terminal-event dispatcher 的 poll、claim lease、批量和退避边界；该 dispatcher 只处理 `session.tombstoned`，不是 purge worker
- `DATA_ERASURE_REQUESTS_ENABLED`：user erasure request writer capability，默认 `0`；直接控制新 POST，不撤销 durable gate或停止历史 job。status GET不依赖router writer gate，但仍按runner capability与healthy selected target fail-closed
- `DATA_GOVERNANCE_MANAGEMENT_ENABLED`：canonical retention-policy 与 multi legal-hold 管理端点开关，默认 `0`。置 `0` 只关闭 `/v1/retention-policies*`、`/v1/legal-holds*`，不会撤销已提交的 active policy/hold，也绝不启用 purge；具备 `0015` store contract 的 runner 仍会发布 `canonical-retention-v1`、`multi-legal-hold-v1` 代码感知 capability，管理端点是否已开放则由独立的 `dataGovernanceManagement` boolean 表示
- `PURGE_POLICY_EVALUATOR_ENABLED`：非破坏性policy evaluator开关，默认`0`，必须和router同名gate一起开启。开启后runner才创建worker；但code-aware runner即使gate关闭也会声明`purgePolicyEvaluation=["policy-evaluator-v1"]`。worker只有evaluation store权限，最多写不可执行target/decision/authority，绝不启用`session.purge`、Blob delete、usage anonymize或request completion
- `PURGE_POLICY_EVALUATOR_*`：poll、claim lease、job batch、target page和bounded retry边界。`evidence_changed`会以新build generation清空cursor/count/root后重建，不覆写旧证据；普通临时故障保留当前generation/cursor并重试
- `DATA_EXPORT_REQUESTS_ENABLED`：新user-export POST admission，默认`0`；要求admin key、明确user、Idempotency-Key和active policy中的正值`exportArtifactTtlMs`。关闭只拒绝新请求，不停止已有job、status或ready artifact下载
- `DATA_EXPORT_WORKER_ENABLED`、`DATA_EXPORT_CLEANUP_ENABLED`：runner内嵌build与artifact cleanup循环，产品默认`0`、local默认`1`；admission要求二者均开启。build在一致性数据库快照后生成确定性NDJSON分片，cleanup只按exact artifact identity处理独立delete outbox
- `DATA_EXPORT_*`：还包括poll、claim/download lease、snapshot page、staging TTL、batch与bounded retry。download lease总寿命有硬上限；普通TTL等待活动下载，erasure/revocation可取消下载并优先清理
- `ERASURE_WORKER_ENABLED`、`ERASURE_ROUTER_URL`：内嵌 durable worker及私有 router origin；产品默认 worker=`0`，local 显式设为 `1`，与 admission 独立。worker在每次claim前调用token-protected v2 router barrier，未获得固定ACK就不接触数据库queue；最多推进到 `awaiting_purge_policy`，不执行 anonymize/purge/completed
- `LEGACY_TOMBSTONE_COMPENSATION_ENABLED`：内嵌 generation-zero compensation worker；产品默认 `0`，local 显式 `1`。首次通过 v2 barrier 后可能激活 write-once cutover，之后不能再运行 pre-`0014` writer。`DATA_ERASURE_REQUESTS_ENABLED=1` 要求它与 `ERASURE_WORKER_ENABLED` 都为 `1`
- `LEGACY_TOMBSTONE_COMPENSATION_*`：compensation poll、claim lease、batch 和 bounded retry；只补齐 terminal proof/outbox/audit，不使 purge 可领取、不删除内容
- `ERASURE_WORKER_*`：poll、claim lease、job batch、session page、retry 与单次私有 router 请求超时；`ERASURE_WORKER_REQUEST_TIMEOUT_MS` 默认 20s
- `ERASURE_DRAIN_TIMEOUT_MS`：runner 内部等待 active turn 到安全边界的上限，默认 10s。部署必须保持 `ERASURE_DRAIN_TIMEOUT_MS < router UPSTREAM_HEADER_TIMEOUT_MS < ERASURE_WORKER_REQUEST_TIMEOUT_MS`（当前默认 10s < 15s < 20s），否则外层先超时会破坏 drain 的可判定性
- `TENANT_ERASURE_REQUESTS_ENABLED`：tenant erasure 的 runner-local admission gate，默认 `0`。即使关闭，code-aware runner 仍声明 `platform-control-v1`；开启时必须配置 `ERASURE_ROUTER_URL`，每次建立不可逆 tenant gate 前都取得 fresh router ACK。status与精确已提交POST的read-only replay不依赖该 gate；0030 generation `0`沿用已提交replay返回`202`的旧语义，0030 active后create/exact replay在terminal publication receipt可读前都返回可重试`503`，即使T1可能已经提交；调用方必须以相同tenant/body/`Idempotency-Key`重试。未命中的replay不会创建
- `TENANT_ERASURE_BARRIER_TIMEOUT_MS`：runner 请求 tenant admission barrier 的单次超时，范围 100–10000 ms，默认 2000 ms
- `TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED`：T3a runner内嵌credential-store worker gate，默认`0`，与新admission解耦。code-aware runner即使关闭也声明`tenantCredentialRevocation=["credential-store-v1"]`，开启后才声明worker-active并接触独立queue；它只删除本地DB API-key/provider行和清空tenant auth三列，不处理runtime/external/content
- `CREDENTIAL_LIFECYCLE_TRACKING_ENABLED`：`0026` versioned inventory的forward-only activation/observation gate，router/runner默认`0`；本地统一脚本仅在调用方未显式设置时默认`1`，便于可丢弃本地库完整运行。production不得照抄本地默认：必须先迁移、以`0`滚动全部ledger-aware writer并排空旧writer、核对全fleet `versioned-target-ledger-v1`，再先显式激活runner tracking、确认全runner active，最后开启router tracking gate。tracking active后不得回退pre-0026 writer；该flag不代表external/KMS adapter可执行
- `TENANT_CREDENTIAL_TARGET_EXECUTION_WORKER_ENABLED`：`0029` runner内嵌worker gate，默认`0`。开启时还要求tracking active、`ERASURE_ROUTER_URL`和可用adapter；worker只处理terminal T3a/0026证明中的external target，不接触KMS或全域completion
- `CREDENTIAL_TARGET_EXECUTION_ADAPTER`：当前唯一值`fake`，只允许`STORE=memory`且禁止`NODE_ENV=production`；用于隔离测试/故障注入，不是MySQL持久adapter或真实provider证明。标准`scripts/local-service.sh start`使用MySQL，会拒绝该变量或任一0029 gate非零，并传给runner的worker gate固定为`0`
- `TENANT_CREDENTIAL_TARGET_EXECUTION_*`：poll、claim lease、worker/materialize batch与bounded retry边界。fake的reference crypto与adapter state只用于本地进程内测试，不得把其opaque reference、密钥或故障配置写入文档/日志
- `RESTORE_JOURNAL_ADAPTER=s3`、`RESTORE_JOURNAL_DATABASE_NAMESPACE_ID`、`RESTORE_JOURNAL_RUNTIME_EPOCH_ID`、`RESTORE_JOURNAL_NAMESPACE_ID`、`RESTORE_JOURNAL_FAILURE_DOMAIN_ID`和`RESTORE_JOURNAL_INDEPENDENT_FAILURE_DOMAIN_ACK`：`0030` runner-only journal/runtime identity。启用时要求`STORE=mysql`；四个原始ID不进入router。independent ACK只能在外部验证journal确实位于primary database之外的独立故障域后设置；local同机MinIO即使使用独立bucket也只是协议夹具
- `RESTORE_JOURNAL_S3_*`：独立journal target的endpoint、region、bucket、prefix、path-style、timeout、private-bucket ACK和credential。bucket必须与Blob bucket不同；production endpoint必须HTTPS且private-bucket ACK需要外部证据。当前runtime配置精确支持一个target，不能把同一个S3服务里的多个prefix描述成多个独立故障域
- `TENANT_RESTORE_JOURNAL_WORKER_ENABLED`：runner内嵌publisher gate，默认`0`；开启要求完整journal配置与`ERASURE_ROUTER_URL`。journal control一旦激活，所有runner必须保持该worker为`1`，否则startup preflight拒绝服务。worker只把已提交T1 fence发布到独立journal并持久化exact ACK，不创建backup或声称tenant erasure完成
- `TENANT_RESTORE_JOURNAL_*`：poll、DB-time claim lease、worker/materialize batch与bounded retry。lease必须覆盖tenant fleet barrier timeout、一次外部journal请求timeout及1000 ms余量；每个外部发布边界以fresh router ACK保护，MySQL与S3之间通过saga/response-loss exact replay收口，不是分布式事务
- `TENANT_RUNTIME_DRAIN_ENABLED`：T3b runner-local 私有endpoint gate，默认`0`。code-aware runner在关闭时仍声明`runtime-drain-v1`，但endpoint不可用；开启时必须显式配置稳定`RUNNER_ID`
- `TENANT_RUNTIME_REVOCATION_WORKER_ENABLED`：T3b durable queue worker gate，默认`0`，且要求`TENANT_RUNTIME_DRAIN_ENABLED=1`与`ERASURE_ROUTER_URL`。它只由terminal T3a proof显式materialize `0020` job，调用router对全部configured targets广播，不执行content purge或completion
- `TENANT_RUNTIME_DRAIN_TIMEOUT_MS`、`TENANT_RUNTIME_REVOCATION_*`：本地等待active auth/provider/turn结算的上限，以及worker→router请求、poll、lease、batch和有界退避参数。必须保持local drain timeout小于worker请求timeout，超时后tenant仍保持本地fenced并只允许同一durable identity重试
- `TENANT_CONTENT_INVENTORY_WORKER_ENABLED`：T3c runner内嵌worker gate，默认`0`且不需要router执行端点。它只从terminal T3b proof建立`0021` DB-clock结构清单，store接口没有删除/匿名化能力；关闭只暂停新claim，不撤销已提交receipt
- `TENANT_CONTENT_INVENTORY_*`：poll、DB-time claim lease、materialize/job batch、session page和bounded retry参数。seal当前会以RR共享锁扫描全库五类content关系；这是local/CI正确性基线，不能在未完成索引/FK/分区和容量验证前宣称可扩展生产执行
- `TENANT_PURGE_PLAN_WORKER_ENABLED`：T3d runner内嵌planning worker gate，默认`0`且不需要router执行端点。它只从terminal T3c及完整immutable source建立`0022`固定33域content-free plan；store接口没有delete/anonymize/revoke/completion能力，关闭只暂停新claim
- `TENANT_PURGE_PLAN_*`：poll、DB-time claim lease、worker/materialize batch和bounded retry参数。生产worker不调用分页build，而是直接在一个原子seal中发布33域；store的domain-page API只供诊断/兼容，没有对应生产worker分页参数。catalog顺序与集合是协议常量，不能按adapter可用性裁剪；缺失Blob/export bytes、Redis、backup/restore、logs/traces或legacy external source必须写显式blocker
- `TENANT_PURGE_EXECUTION_WORKER_ENABLED`：T3e runner内嵌local execution/physical-ACK worker gate，默认`0`。code-aware runner即使关闭也声明`tenantPurgeExecution=["local-execution-ack-v1"]`，开启后才声明worker-active并接触`0023`独立queue；它只执行operational usage去身份化、Blob/export exact outbox、export revoke/download lease清除、snapshot pin release及completed outbox的physical ACK，固定不能声明全域完成
- `TENANT_PURGE_EXECUTION_*`：poll、DB-time claim lease、materialize/job batch与bounded retry。每个materialize、claim、lease、local cutover和physical seal边界都先请求router的fresh non-sticky all-configured ACK；pending physical ACK使用独立可重试状态，exact outbox dead-letter会原子阻断job而不是记成功
- 开启`TENANT_PURGE_EXECUTION_WORKER_ENABLED=1`还强制要求`BLOB_CLEANUP_ENABLED=1`与`DATA_EXPORT_CLEANUP_ENABLED=1`；filesystem模式另外要求`BLOB_FILESYSTEM_SINGLE_RUNNER=1`，S3模式则要求下述write-once control和共享namespace已经精确激活。T3e仍只是局部physical ACK，不能因此开放全域completion
- `TENANT_DATABASE_PURGE_WORKER_ENABLED`：T3f runner内嵌本地数据库内容/控制投影清理worker gate，默认`0`，且与T3e gate独立。code-aware runner同时声明`local-execution-ack-v1`与`local-db-content-delete-v1`，开启worker后才接触`0024`队列；它清理固定11个MySQL/Memory域并保留匿名billing facts，不清Redis、外部provider/KMS、backup/restore、logs/traces或全域completion
- `TENANT_DATABASE_PURGE_*`：poll、DB-time claim lease、materialize/job batch和bounded retry。materialize、claim、renew、destructive execute与模糊响应replay每个边界都取fresh no-store fleet ACK；单个Memory staged publication或MySQL `REPEATABLE READ`事务同时发布pre-delete证据、永久session grave、删除动作、exact ACK、terminal job/receipt和cutover，失败或lease丢失整体回滚
- `TENANT_REDIS_PURGE_WORKER_ENABLED`：T3g runner内嵌session-state Redis清理worker gate，默认`0`且与T3e/T3f gate独立；启用要求`STORE=mysql`、`REDIS_URL`、`REDIS_NAMESPACE_ID`和`ERASURE_ROUTER_URL`。code-aware runner声明`tenantRedisPurge=["session-state-delete-v1"]`及namespace digest，worker开启后才接触`0025` queue。任一durable T3g job或cutover已存在时关闭worker会使runner拒绝启动，因为未ACK marker也必须靠轮询收口。worker lease必须至少为barrier timeout的两倍再加1000 ms；worker还会在第二次fresh proof后检查续租耗时未超过lease的一半，超限时不进入Redis mutation
- `TENANT_REDIS_PURGE_*`：poll、DB-time claim lease、materialize/job batch、target/restore page、bounded retry与`TENANT_REDIS_PURGE_RESTORE_INTERVAL_MS`。runner在监听/ready前只重放已有durable target ACK的marker并周期重放；未ACK target在worker轮询后先执行existing-marker-only同slot原子replay，只有exact marker存在才按原bits再次删除三域，marker缺失零修改。namespace mismatch、marker conflict或Redis证据损坏fail startup或阻止新destructive work。fresh no-store fleet ACK只用于materialize和新的Redis mutation，mutation前固定`gate → renew claim → gate`；claim、existing-marker replay、ACK持久化/精确重放、durable restore与全ACK seal不取destructive gate
- `BLOB_STORE`：`filesystem`（默认）或`s3`。S3要求`STORE=mysql`，因为共享namespace cutover必须持久化；filesystem不得开启`BLOB_STORAGE_CONTROL_ENABLED`
- `BLOB_NAMESPACE_ID`：operator分配的非密钥逻辑对象存储身份；与`BLOB_S3_BUCKET`、`BLOB_S3_PREFIX`共同生成完整namespace SHA-256。endpoint刻意不进入digest，以允许同一服务别名切换；bucket/prefix/namespace id变化则是数据迁移，不能直接改配置
- `BLOB_STORAGE_CONTROL_ENABLED`：共享S3模式必须为`1`。runner在HTTP listener和worker之前以`0027`执行generation `0 → 1`一次性激活或精确观察；激活后filesystem或其它backend/namespace启动失败，只能forward-fix
- `BLOB_S3_ENDPOINT`、`BLOB_S3_REGION`、`BLOB_S3_BUCKET`、`BLOB_S3_PREFIX`、`BLOB_S3_FORCE_PATH_STYLE`、`BLOB_S3_REQUEST_TIMEOUT_MS`：S3数据面连接与有界请求配置。每个SDK command从credential/endpoint provider解析到全部transport尝试共享一个外层deadline，并在到期时abort底层请求；响应body另以同一配置值限制完整读取阶段。production自定义endpoint必须使用HTTPS，bucket必须从未启用versioning、没有任何lifecycle配置且未启用Object Lock，并支持`If-None-Match: *` create-only与`PutObject If-Match` CAS；不要求`DeleteObject If-Match`
- `BLOB_S3_ACCESS_KEY_ID`、`BLOB_S3_SECRET_ACCESS_KEY`、可选`BLOB_S3_SESSION_TOKEN`：runner-only credential；也可不设置而使用受控的标准AWS provider chain。router不得接收这些变量，本地统一脚本还会清除常见AWS/MinIO provider-chain变量
- `BLOB_S3_PRIVATE_BUCKET_ACK`：production S3必须为`1`，但它只是operator确认“已独立验证匿名/public访问被拒且IAM/policy正确”，不是应用自动证明。local MinIO保持`0`；CI真实MinIO套件另行执行anonymous raw GET拒绝用例
- `BLOB_DIR`：filesystem adapter的服务独占root；本地脚本默认`.local-run/blobs`，多runner/NFS语义未受支持，不能复制充当生产对象存储
- `BLOB_FILESYSTEM_SINGLE_RUNNER`：filesystem 模式的显式安全确认；write 或 cleanup 任一启用时都必须为 `1`。它只表示操作者承诺恰好一个 runner 独占该 root，不提供分布式互斥
- `BLOB_CLEANUP_ENABLED`：stale staging cleanup worker 开关；本地默认 `1`。当前 filesystem adapter 在 production 即使 cleanup-only 也会拒绝启动，防止任一 runner领取全局 outbox 后误删/漏删本机之外的数据
- `BLOB_ATTACHMENTS_ENABLED`：新 Blob 上传和大工具输出卸载的 writer gate；依赖 cleanup 已开启，本地默认 `1`；当前 filesystem adapter 在 production 会拒绝启动
- `BLOB_MAX_BYTES`、`BLOB_MAX_HYDRATED_BYTES`、`BLOB_TOOL_OUTPUT_THRESHOLD_BYTES`、`BLOB_STAGING_TTL_MS`：单对象、模型上下文水合、工具输出卸载和未绑定 staging 保留边界；`BLOB_MAX_BYTES` 不得超过 `MAX_BODY_BYTES`
- `BLOB_CLEANUP_*`：专用 Blob delete outbox worker 的 poll、claim lease、批量、退避和确定性 poison 上限；普通短暂故障不会因达到 poison 上限而丢弃
- `MIGRATION_ID`、`FLEET_DRAINED_EVIDENCE_SHA256`、`ROLLBACK_WINDOW_MS`、`SOURCE_CLEANUP_DELAY_MS`：仅供`0028`一次性mover的`prepare`/`run`使用。migration id必须稳定且每次attempt唯一；fleet digest是外部停服/排空证据的64位小写SHA-256，不是应用自动attestation；两个delay按MySQL时间解释且不可为负
- `MAX_OBJECT_BYTES`：`0028`维护入口读取、复制和回验单对象的硬上限，默认64 MiB、最大1 GiB；它与普通runtime的`BLOB_MAX_BYTES`不是同一配置，超限会在发布inventory/target ACK前fail closed
- `BLOB_MIGRATION_COMMIT`：只影响`run`命令，默认`0`并停在`verified`；显式设为`1`才在copy/verify后尝试cutover。即使为`1`也绝不自动执行`cleanup-source`
- `RESTORE_RUN_ID`、`RESTORE_FLEET_STOPPED_ACK`、`SOURCE_BACKUP_SHA256`、`RESTORE_REPLAY_PAGE_SIZE`与`RESTORE_JOURNAL_PRIMARY_ACTIVATION_ACK`：只供`0030`一次性restore CLI。restore run必须是全新UUIDv4；fleet ACK是人工停服确认；source digest必须来自实际恢复的备份制品；page size范围1–1000。primary activation必须同时提供primary-activation与fleet-stopped ACK，并显式声明`BLOB_STORE=filesystem`，或声明`BLOB_STORE=s3`及`BLOB_S3_BUCKET`；S3 Blob bucket必须与journal bucket不同，无法证明时在连接MySQL/S3前fail closed。这些变量会从长期runner/router进程中剥离，也不能替代`0031` backup catalog
- 首次生产初始化使用受控的一次性管理流程；`BOOTSTRAP_API_KEY` 仅限 local/test

`TENANT_ERASURE_OPERATOR_TOKEN` 和 `TENANT_ERASURE_OPERATOR_ID` 是 router-only 配置；runner 不应接收 platform token，本地统一脚本会在启动 runner 时显式移除它。`DATA_ERASURE_REQUESTS_ENABLED` 仍只控制 user erasure，不能代替 tenant 开关。T3a worker只清除本地DB credential material，其receipt保持`runtimeDisposition=not_in_scope`、`externalDisposition=not_supported`、`contentPurgeRequired=true`。`0026`在同一T3a事务附加versioned inventory sidecar；受信任服务端provider写入可原子保存不含secret/header/URL/明文locator的受保护external target reference，legacy/source缺失目标仍保持blocker，KMS仍不可执行。`0029`从该精确source建立独立external target execution/ACK账本，但当前只有Memory-only非生产fake，标准MySQL本地栈不启用它，不能宣称远端撤销完成。T3b～T3g继续分别证明runtime、结构清单、33域plan、local usage/Blob/export、11个数据库投影与session-scoped Redis切片。所有terminal receipt仍固定`allDomainsComplete=false`、`contentPurgeExecuted=false`；0029还固定`kmsKeyExecutionComplete=false`。公开status保持`gated`、`dataPurgeExecution=false`，不能称为completed。

`0028`维护配置只允许通过环境变量提供；CLI不接受DSN、filesystem path、endpoint、credential或namespace作为命令行参数。`status`只需要`MYSQL_URL`并使用独立非排他连接；其它命令按需要创建`BLOB_DIR` source与`BLOB_NAMESPACE_ID + BLOB_S3_BUCKET + BLOB_S3_PREFIX` target，S3 region、endpoint、path-style、private-bucket ACK、request timeout和credential沿用上面的runner-only契约。统一脚本会在加载`.env`前快照调用方显式提供的`NODE_ENV`、MySQL/migration/delay/limit、source/target/S3/credential变量和全部已导出的`AWS_*`，加载后再原样恢复；显式空字符串同样具有优先级，只有调用方未设置的变量才取`.env`。这避免本地默认值把一次性维护操作静默指向另一数据库或namespace，也保证显式`BLOB_MIGRATION_COMMIT=0`不会被`.env`改成`1`。CLI只输出不含locator或异常原文的有界JSON摘要/固定错误码，不得在操作记录、文档或工单中回显环境变量值。

`0030` restore CLI使用同样的环境-only authority边界，命令行只接受`status`、`activate-journal`、`prepare`、`replay-fences`、`verify`、`activate-runtime`、`abort`或`run`。`status`不构造object-store client；`verify`和`abort`也是DB-only恢复边界；其余命令要求完整runner-only journal配置并执行外部startup检查。所有命令使用verify-only store连接，要求完整migration marker集合且不执行DDL；0030 marker存在时还校验精确schema/trigger fingerprint，并在成功或失败后恢复临时调整的MySQL session `group_concat_max_len`。restore S3 client忽略AWS环境变量/shared profile配置的endpoint；durable target identity绑定受控region及normalized custom endpoint或明确的standard-endpoint模式。统一脚本在读取`.env`前快照并恢复所有`RESTORE_JOURNAL_*`、`TENANT_RESTORE_JOURNAL_*`、restore-run/backup/ACK变量及`AWS_*`，显式空值同样优先，且输出只含content-free计数、phase和固定错误码。禁止在shell history、工单或日志中粘贴DSN、endpoint、credential或原始错误。

Router 必需配置：

- `RUNNERS`：每个 runner 实例稳定、可达的 base URL 列表；不能填会在同一 URL 后随机选择多个版本 Pod 的普通负载均衡 Service，服务发现必须展开为实例地址
- `REDIS_URL`：与 runner 相同的逻辑 Redis 集群
- `REDIS_PREFIX`、`REDIS_NAMESPACE_ID`：必须与全部runner一致并准确标识同一个logical Redis cluster/database/prefix；router使用二者计算T3g期望namespace digest。启用T3g gate时namespace id必填，不能用URL变化代替受审计的逻辑身份迁移
- `INTERNAL_ROUTER_TOKEN`：与全部 runner 完全一致的共享凭证；router 会剥离客户端伪造的同名及全部`x-agent-service-*` header，只对显式allowlist中的版本化私有控制路由重新注入（包括tombstone、user-erasure drain/barrier、purge-evaluator barrier及tenant admission/status/replay），普通tenant代理永不注入
- `SESSION_TOMBSTONE_ENABLED`：显式 expand→activate 开关；local 脚本默认 `1`，staging/production 发布时默认保持 `0`，且 router 仍会要求全部健康 runner 声明 `tombstone`
- `DATA_ERASURE_REQUESTS_ENABLED`：user erasure writer gate，local/staging/production 默认都是 `0`。POST 还要求 `RUNNERS` 中全部 configured targets 均已健康探测并声明 capability，且选中 target 仍支持；暂时不可达的已配置实例也会阻断激活。状态 GET 不依赖这个 router writer gate，继续按当前 healthy fleet/selected target capability 规则 fail-closed；writer gate 开启时，所有 user-scoped runtime 每次转发都复核 selected target capability。另有不公开的 v2 worker barrier 要求本 router 进程曾逐一观察每个稳定地址同时声明 `quarantine-v1` 与 `legacy-tombstone-compensation-v1`；旧 v1 私有路径故意 404，不提供降级 fallback
- `TENANT_ERASURE_REQUESTS_ENABLED`：tenant erasure 新admission与私有 admission ACK 的 router gate，默认 `0`。开启后仍要求每个 configured 稳定 runner 当前健康、声明 `platform-control-v1` 且本地 tenant gate 已开；status GET与精确已提交POST的read-only replay和该gate解耦，但必须选到健康且code-aware的target。0030 generation `0`时精确已提交replay沿用原`202`；0030 active后，create可能已提交T1，但create/exact replay在publication receipt可读前均返回可重试`503`，receipt读取失败也fail closed，调用方必须以完全相同tenant/body/`Idempotency-Key`重试，receipt后才返回同一`202`。gate关闭时未知/不同key返回`503`且绝不创建；router一旦为请求选择replay模式，即使gate途中开启也不能升级到create
- `TENANT_CREDENTIAL_REVOCATION_EXECUTION_ENABLED`：T3a独立execution barrier gate，默认`0`；router自身还必须开启`CREDENTIAL_LIFECYCLE_TRACKING_ENABLED`，且全部configured稳定runner当前健康、声明`versioned-target-ledger-v1`、观察tracking active、理解`credential-store-v1`并且本地worker-active时，才返回token-protected固定ACK。它不控制新admission，也不改变公开tenant status或`dataPurgeExecution=false`
- `TENANT_CREDENTIAL_TARGET_EXECUTION_ENABLED`：`0029` external-target fresh barrier gate，默认`0`；要求router自身tracking active，并逐次刷新全部configured稳定runner，确认其声明`external-credential-execution-v1`且worker-active后才返回no-store ACK。该gate不授权KMS、content purge或completion；标准MySQL local-service固定传`0`
- `RESTORE_JOURNAL_NAMESPACE_SHA256`、`RESTORE_JOURNAL_TARGET_ROOT_SHA256`、`RESTORE_JOURNAL_RUNTIME_EPOCH_SHA256`：router唯一允许接收的`0030` identity，三者必须一起配置并与全部runner capability精确一致。它们是公开非密钥digest，不是原始namespace、endpoint、account或credential；原始`RESTORE_JOURNAL_*`配置在router启动边界会被清除
- `TENANT_RESTORE_JOURNAL_EXECUTION_ENABLED`：`0030` fresh publication barrier gate，默认`0`；要求三个identity digest齐全，并逐次确认全部configured稳定runner健康、声明`independent-restore-journal-v1`、identity精确一致且publisher worker-active。它只授权紧邻的T1 journal materialize/claim/publication边界，不授权backup、restore activation、T3a或全域completion
- `TENANT_PURGE_EXECUTION_ENABLED`：T3e独立execution barrier gate，默认`0`；每次私有请求都会刷新全部configured稳定runner，只有其当前健康、理解`local-execution-ack-v1`且本地worker-active时才返回token-protected固定ACK。该ACK只授权紧邻的有界local execution边界，不改变公开`dataPurgeExecution=false`，也不能证明任一未ACK domain完成
- `TENANT_DATABASE_PURGE_ENABLED`：T3f独立database-content barrier gate，默认`0`；要求全部configured runner当前健康、同时声明`local-execution-ack-v1`与`local-db-content-delete-v1`，且T3f worker-active。固定ACK必须带`Cache-Control: no-store`，只授权紧邻的单一worker边界，不继承T3e的启用状态
- `TENANT_REDIS_PURGE_ENABLED`：T3g独立Redis session-state destructive barrier gate，默认`0`；要求全部configured runner当前健康、声明`session-state-delete-v1`、T3g worker-active且namespace digest与router预期完全一致。每次ACK都fresh、non-sticky并带`Cache-Control: no-store`，只授权紧邻的materialize或新Redis mutation边界；关闭它不会撤销既有marker，也不会阻断claim、existing-marker-only replay、补ACK/seal或durable restore，因此仍不允许关闭runner worker
- `TENANT_RUNTIME_DRAIN_EXECUTION_ENABLED`：T3b router broadcast gate，默认`0`。开启后仍必须对`RUNNERS`中每个精确、直连的稳定URL在fanout前后重新探测，要求唯一`RUNNER_ID`和每进程随机`bootId`在整个操作中不变。任一target不可达、endpoint关闭、身份重复/变化、ACK/proof不匹配均整体fail closed，不使用healthy subset、hash-ring owner、sticky attestation或负载均衡别名
- `TENANT_ERASURE_OPERATOR_TOKEN`：独立 platform bearer，只能注入 router；开启 tenant gate 时必填，长度 32–256 且只接受 token-safe 字符，必须与 `INTERNAL_ROUTER_TOKEN`/`ROUTER_ADMIN_TOKEN` 不同。为使 admission 关闭后仍可读取已建立 request 的 status，运维期间仍应配置它
- `TENANT_ERASURE_OPERATOR_ID`：写入首条 audit 的稳定、非秘密 actor ID，不是凭据
- `DATA_GOVERNANCE_MANAGEMENT_ENABLED`：router 的独立管理面 gate，默认 `0`。即使置 `1`，也只有在每个 configured `RUNNERS` 稳定地址当前健康、同时声明 `canonical-retention-v1`、`multi-legal-hold-v1` 且 runner 自身 `dataGovernanceManagement=true` 时才开放；每次发送前还会复核选中 target。router 对外 capability 中 `dataGovernance` 表示全 fleet 已理解并会遵守 durable policy/hold，`dataGovernanceManagement` 才表示管理 API 已激活，二者不能混为一谈
- `PURGE_POLICY_EVALUATOR_ENABLED`：router的独立evaluator barrier gate，默认`0`。token-protected私有ACK只在该gate开启、`INTERNAL_ROUTER_TOKEN`存在且每个configured稳定runner当前健康并声明`policy-evaluator-v1`时返回；runner也必须独立开启同名gate才会请求ACK并schedule/claim。公开`purgePolicyEvaluation`只表示fleet代码感知，不能用来推断worker已经激活；`dataPurgeExecution`固定为`false`
- `DATA_EXPORT_REQUESTS_ENABLED`：router的新export writer gate，默认`0`。POST要求每个configured runner当前健康、code-aware `artifact-ndjson-v1`且admission-active；status/download不依赖writer gate，但仍要求healthy fleet和selected target code-aware。带`Idempotency-Key`的POST才允许一次安全重路由
- `BLOB_STORE`、`BLOB_NAMESPACE_ID`、`BLOB_STORAGE_CONTROL_ENABLED`、`BLOB_S3_BUCKET`、`BLOB_S3_PREFIX`：S3模式下必须与全部runner形成同一namespace digest/control generation。router不接收endpoint、region或credential，只比较每个健康runner的`backend/shared/namespaceSha256/controlGeneration` capability；mixed namespace不会进入writer surface
- `BLOB_FILESYSTEM_SINGLE_RUNNER`：当前 local router 与 runner 一致设为 `1`；只用于单 runner filesystem 拓扑，router 会强制 `RUNNERS` 去重后恰好一个地址，不能带入多实例环境
- `BLOB_ATTACHMENTS_ENABLED`：新 Blob 上传的独立 gate；local 默认 `1`，router 还要求全部健康 runner 声明 `blobAttachments`。当前 production filesystem 配置禁止开启
- `BLOB_MAX_BYTES`：只约束 raw Blob upload，必须与 runner 一致并且不大于双方的 `MAX_BODY_BYTES`
- `MAX_BODY_BYTES`：必须与 runner 相同，避免上游断开被误报成 502
- 网关/LB 必须关闭 SSE buffering，并把空闲超时设置得高于 SSE heartbeat

## 0028 离线 filesystem→S3 搬迁

该入口只适用于`STORE=mysql`、source为`filesystem-v1`、target为S3-compatible namespace的全停机维护。它不是在线双写、rolling migration、S3→S3工具或常驻worker。`0028_blob_storage_migration.sql`只安装default-dormant ledger/guards；应用migration不会冻结runtime、扫描`BLOB_DIR`、复制对象、重写pointer或激活`0027`。真正动作只来自同一runner发布物内的一次性CLI：源码入口由`pnpm maintenance:blob-storage-migrate -- <command>`调用，构建后入口为`apps/agent-runner/dist/blob-storage-migrate.js`，runner OCI镜像也包含该文件，但不会把它作为默认长期进程启动。

inventory的authority来自MySQL ledger中live/open-intent的Blob/export记录：`blob_objects`、Blob delete intent、export artifact/part、snapshot pin和export delete intent。它只搬运这些记录精确指向的storage key，并额外允许这些已封存记录引用的legacy raw file + `.meta` sidecar；不会遍历、认领或证明`BLOB_DIR`下任意未知、无manifest文件。此类root orphan仍是独立运维风险，必须在维护前后另做只读盘点和人工审计，不能因为mover receipt成功就宣称“目录全部bytes已搬完”。

安全顺序如下。所有locator和credential先在当前shell或受控Secret注入中准备，命令行只放一个固定command；不要把环境值粘贴到日志或文档：

```bash
# 1. 先阻断入口并真实停止/排空全部router、runner及其它旧writer；本地单实例可用：
scripts/local-service.sh stop

# 2. 只读确认dormant control；status只需要MYSQL_URL。
pnpm maintenance:blob-storage-migrate -- status

# 3. 设置本节列出的MIGRATION_ID/FLEET_DRAINED_EVIDENCE_SHA256/delay，
#    以及现有MYSQL_URL/BLOB_DIR/BLOB_NAMESPACE_ID/BLOB_S3_*后，逐阶段执行。
pnpm maintenance:blob-storage-migrate -- prepare
pnpm maintenance:blob-storage-migrate -- copy
pnpm maintenance:blob-storage-migrate -- verify

# 4. 在verified阶段检查证据并等待数据库rollback window；仍需回退时只能在cutover前abort。
pnpm maintenance:blob-storage-migrate -- status
# pnpm maintenance:blob-storage-migrate -- abort

# 5. 明确提交不可逆pointer/control cutover；提交后只能forward-fix。
pnpm maintenance:blob-storage-migrate -- cutover
pnpm maintenance:blob-storage-migrate -- status

# 6. 等数据库source-cleanup delay后，显式清理source；任何run命令都不会代做此步。
pnpm maintenance:blob-storage-migrate -- cleanup-source
pnpm maintenance:blob-storage-migrate -- status
```

`run`等价于prepare→copy→verify；默认停在`verified`，只有`BLOB_MIGRATION_COMMIT=1`才继续cutover，且永远不自动source cleanup。推荐首次演练仍使用上面的显式分阶段命令。一个MySQL advisory lock只允许一个mutating operator，第二个operator会立即失败；独立`status`可并行观察。每个target put/delete/discard和source delete还会在事务中持有migration-control行共享锁，并在外部mutation前后确认dedicated连接仍是named-lock owner。若该连接在动作中丢失，外部对象可能已按create-only/CAS语义改变，但旧operator不会写ACK或推进phase；替代operator即使取得named lock也会等待行锁释放，再按exact owner/descriptor重放收敛。每次命令都可在response loss或进程重启后按相同durable identity精确重放，但不能更换migration id、source/target namespace或把另一次attempt的对象当作本次结果。

runner有两次startup gate：store连接后、S3 adapter打开前先读取`0028` control；adapter startup验证和`0027` exact Blob identity对账完成后，再用独立连接重读一次。第二次读取关闭“首次检查通过后，mover在adapter验证期间提交cutover”的窗口；普通generation-1 activation与freeze也按migration-control→blob-control锁序串行化，并拒绝任何历史attempt使用过的target namespace。不过两次gate都只是**启动前**检查，不会踢掉已经运行的进程，也不能约束第二次读取后被误启动的旧writer。因此`prepare`前必须实际停止并排空所有runner，等待active turn、worker claim和旧lease结算；仅依赖gate或数据库trigger不是停服证明。router可先停止/摘流，以免维护期间持续产生502/503，但router不参与mover，也不应持有`MYSQL_URL`或对象存储credential。runtime只在`inactive`、`aborted`、`source_cleaned`允许启动；`frozen`、`inventory_sealed`、`copying`、`verified`、`cutting_over`、`committed`和`abort_cleaning`都拒绝启动。abort只在cutover前可用，保留filesystem source并用CAS在target同key写永久migration-owned tombstone；aborted namespace永久不可复用。committed后没有回滚路径，即使source bytes尚在也只能完成`cleanup-source`再以exact target S3 identity恢复服务。

copy写入的对象带独立于upload token的`migrationOwnerSha256`。普通staging上传如果在停服前已经发布bytes、但MySQL upload ACK因崩溃未提交，cutover后可由ordinary exact retry继续完成；descriptor一致时不会剥掉migration provenance，内容或owner冲突仍fail closed。source cleanup会在再次核对committed control、target descriptor/owner与object ACK后删除filesystem envelope；legacy记录同时删除raw payload和`.meta`，并以per-key/rooted ACK收口崩溃重放。

当前实现优先保证正确性，不是生产规模承诺：prepare会把candidate/inventory集合装入进程内存；freeze用`SERIALIZABLE`全范围锁建立写冻结，inventory seal又是单个大型事务。没有分页、batch、dry-run、动态限速或operator HA；每对象虽有读取上限，Buffer复制仍会放大峰值内存。MySQL整库重启可能同时释放named lock与行锁，恢复正确性仍依赖create-only/CAS、永久owner tombstone和精确重放，不代表operator高可用。`MAX_OBJECT_BYTES`没有写入迁移账本，后续命令设得更小会安全阻断而不是继续。每次attempt必须使用新的逻辑namespace，并同时保证物理bucket/prefix从未被旧attempt使用；只更换`BLOB_NAMESPACE_ID`不能把重叠prefix变安全。filesystem identity绑定resolved path而非mount/inode，S3 identity也不含endpoint/region/account，这些映射必须由受控配置、挂载与IAM保证稳定。进入真实环境前必须以staging数据量验证维护窗口、容量、网络、IAM、超时、失败恢复和source备份，不能用本地MinIO结果替代。

## 0030 独立 restore journal 与恢复

`0030_tenant_restore_journal.sql`只安装default-dormant journal publication、runtime lineage与restore replay账本；migration本身不会选择target、访问对象存储、发布历史T1、建立backup、重放fence或切换runtime epoch。长期publisher内嵌于runner；router只返回fresh fleet ACK；真正恢复使用runner镜像内的一次性`restore-ledger-reconcile.js`，不会新增daemon、产品服务或镜像。

本地先用自动门禁验证，不需要激活普通开发库：

```bash
pnpm test:tenant-restore-journal-memory
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" \
  pnpm test:tenant-restore-journal-mysql
scripts/local-service.sh verify-s3
pnpm build:check
```

`verify-s3`会bootstrap一个与Blob bucket不同的restore-journal bucket并强制真实MinIO suite零skip。但MySQL、Blob bucket和restore bucket通常都在同一台本机，两个bucket不是两个故障域；`RESTORE_JOURNAL_INDEPENDENT_FAILURE_DOMAIN_ACK=1`在这种场景只为可丢弃协议夹具解锁代码，不能作为staging/production证据。restore S3 client会忽略AWS环境变量/shared profile提供的endpoint override；受控region及normalized显式custom endpoint或standard-endpoint模式进入durable target identity，环境变化不能静默把同一账本指向另一目标。

primary activation只能用于独立可丢弃数据库或已经完成正式变更评审的环境。先应用0030，以router gate=`0`、runner worker=`0`发布新代码，配置runner-only database namespace、primary runtime epoch、journal namespace、failure-domain identity与S3 target；三个公开digest从runner capability取得后精确配置给router。确认外部head完全为空、所有pre-0030 writer均已排空，而且数据库不存在任何已经绕过journal完成的terminal T3a receipt，再停掉全部writer：

```bash
scripts/local-service.sh stop
```

activation必须同时声明两个ACK及Blob backend。filesystem Blob环境只运行下面这一组：

```bash
BLOB_STORE=filesystem \
RESTORE_FLEET_STOPPED_ACK=1 \
RESTORE_JOURNAL_PRIMARY_ACTIVATION_ACK=1 \
  pnpm maintenance:restore-ledger-reconcile -- activate-journal
```

S3 Blob环境只运行下面这一组；bucket值必须来自受控配置，且不得等于`RESTORE_JOURNAL_S3_BUCKET`：

```bash
BLOB_STORE=s3 \
BLOB_S3_BUCKET="$BLOB_S3_BUCKET" \
RESTORE_FLEET_STOPPED_ACK=1 \
RESTORE_JOURNAL_PRIMARY_ACTIVATION_ACK=1 \
  pnpm maintenance:restore-ledger-reconcile -- activate-journal
```

无论选择哪组，成功后再只读检查：

```bash
pnpm maintenance:restore-ledger-reconcile -- status
```

缺少`BLOB_STORE`、S3模式缺少`BLOB_S3_BUCKET`，或两个bucket相同都会在建立MySQL/S3连接前fail closed。该检查只证明名称分离，不证明独立故障域。

activation在同一个MySQL事务中建立journal control与primary runtime epoch，且只在外部head仍精确为空时成功；commit后只能forward-fix。随后所有runner必须使用exact raw target/runtime配置并保持`TENANT_RESTORE_JOURNAL_WORKER_ENABLED=1`，否则startup preflight拒绝服务。先保持router `TENANT_RESTORE_JOURNAL_EXECUTION_ENABLED=0`启动全部runner，核对每个稳定地址都报告`independent-restore-journal-v1`、三个digest一致且worker-active，再最后开router gate。每个新T1 gate与journal publication job/targets在Memory一个原子边界或MySQL同一事务内建立；publisher用claim lease、S3 create-only链和exact ACK/response-loss replay收口。这个saga不提供MySQL与S3分布式原子提交，关闭router gate也只暂停新publication边界，不撤销已有T1、journal record、ACK或lineage。

恢复演练的安全顺序如下。所有ID、digest、DSN、endpoint和credential必须经受控环境/Secret注入，命令行只放固定command，任何步骤都不能回显原始配置：

1. 摘流并停止全部router、runner和其它旧writer，等待active turn、worker claim、I/O与lease排空；独立验证实际数据库备份制品及其SHA-256。`RESTORE_FLEET_STOPPED_ACK=1`只是人工确认，CLI不会替operator完成停服。
2. 实际恢复数据库后，先由环境的独立migration Job把schema升级并验证到运行该CLI所需的完整版本；restore CLI所有命令都使用verify-only连接，只读`schema_migrations`并在缺少任一随镜像发布的migration时fail closed，绝不获取migration lock、创建表或执行DDL。0030 marker存在时还必须通过精确schema/trigger fingerprint；检查临时提高MySQL session `group_concat_max_len`，并在成功或失败后恢复原session值。随后保留同一个logical database namespace与journal target；为本次attempt生成全新UUIDv4 `RESTORE_RUN_ID`和从未在任何幸存durable state中使用过的新`RESTORE_JOURNAL_RUNTIME_EPOCH_ID`，并注入实际制品的`SOURCE_BACKUP_SHA256`。
3. 执行`status`，再分阶段执行`prepare → replay-fences → verify`，或使用只组合这三步的`run`。`prepare`封存所有外部head；`replay-fences`把每条sealed record变成永久本地tenant fence；`verify`在全部entry精确入账后封存receipt。
4. 人工审阅content-free计数、phase与外部恢复证据；确认无缺口后显式执行`activate-runtime`。该命令会再次读取外部head并要求未发生漂移，随后提交新的runtime lineage；`run`绝不会自动完成这一步。
5. 更新router的三个非密钥digest，先保持execution gate=`0`启动全部新runner，让startup preflight核对DB control/runtime/external heads并确认全fleet worker-active；最后才开journal gate，之后再按各自rollout恢复T3a/T3e/T3f/T3g等破坏性gate。

对应命令骨架如下；`RESTORE_RUN_ID`、`RESTORE_FLEET_STOPPED_ACK=1`、真实`SOURCE_BACKUP_SHA256`和新runtime epoch必须先由operator注入：

```bash
pnpm maintenance:restore-ledger-reconcile -- status
pnpm maintenance:restore-ledger-reconcile -- prepare
pnpm maintenance:restore-ledger-reconcile -- replay-fences
pnpm maintenance:restore-ledger-reconcile -- verify
pnpm maintenance:restore-ledger-reconcile -- status
pnpm maintenance:restore-ledger-reconcile -- activate-runtime
pnpm maintenance:restore-ledger-reconcile -- status
```

`abort`只允许prepared但尚未active的run；它不会删除已经重放的永久fence，也不会允许复用该runtime epoch。`status`只读数据库；`verify`/`abort`为DB-only边界，可在object store暂时不可达时使用；`activate-journal`、`prepare`、`replay-fences`、`activate-runtime`和`run`会加载并验证真实adapter。所有命令都以verify-only方式检查完整migration marker集合而不执行migration；0030 marker存在时还执行精确schema/trigger fingerprint并恢复临时session设置。真实MySQL回归还会对空库执行`status`所用的verify-only连接，并证明失败后仍为零表。任何已激活或已abort的epoch都视为烧毁，不能因重试、回滚或改名而复用。

当前残余边界必须保留在上线清单中：只有单target配置；跨MySQL/S3为saga；独立故障域、primary activation、fleet stopped和source backup digest均含人工ACK；当数据库与所有journal/epoch唯一性证据一起回滚时仍有operator误复用epoch的ABA风险。当前S3 adapter只有逐请求deadline，没有覆盖完整chain scan/restore operation的统一deadline；分页scan每页从chain起点重验sealed prefix，整体为`O(n²)`对象读取。本地MinIO不能覆盖真实IAM、不可变策略、跨故障域网络、容量、请求费用或恢复窗口，必须在staging按实际journal规模压测。下一独立切片`0031` backup catalog尚未实现，因此没有权威backup集合、snapshot lineage、retention和source digest目录；在0031与真实staging演练完成前，0030只能称为restore-journal/fence恢复切片，不能称为完整backup/DR。

## 预发/生产资源就绪后的交付顺序

1. 建立独立的 staging MySQL、Redis、共享Blob对象存储、位于primary database故障域之外的restore-journal存储、Secret/KMS 和网络访问策略；实际云参数未提供前不生成或猜测endpoint、bucket、IAM、域名/TLS与Secret值。
2. 独立执行并验证数据库迁移、`0031` backup catalog（实现后）、备份/恢复与回滚演练。
3. 按实际容量与故障域部署 configured/N 个 runner，确认每实例唯一身份、稳定直连地址、readiness 和 graceful drain；需要验证接管时至少使用两个实例。
4. 部署 router，经 router 跑 session、SSE turn、断线重放和接管测试。
5. 接入真实 IdP、日志、指标和告警后再开放预发流量。
6. 生产环境重复同一流程，不复用 staging 的数据库、Redis、密钥或 service key。

目标日常交付采用同一条 promotion 链：本地开发与 `verify` → CI 全部门禁 → 构建一次不可变镜像 → 按同一 image digest 部署 staging → 预发验收 → 同一 digest 灰度到 production。staging 与 production 不重新构建镜像，也不共享数据库、Redis、对象存储、密钥或 service key；环境差异只来自受控配置和 Secret。当前 CI 只以 `load: true` 临时构建并启动候选镜像，没有 registry push、签名、持久 digest 或 promotion job；这些仍是 M4/云资源就绪后的交付缺口。

tombstone 是 protocol family `2026-10-08` 内的 additive capability；它没有为这次扩展提升 exact protocol version。router 不把 DELETE 发到旧公开路径，而是改写成带内部 token 的版本化 POST，并要求新 runner 回 ACK；即使错误地把共享 LB URL 配成 target 且探测/请求落到不同 Pod，旧 runner 也只会 404，不会执行旧删除语义。正确拓扑仍要求 `RUNNERS` 一项对应一个稳定实例。安全 rollout 顺序是：先在 API gateway 暂停精确 session DELETE（或把流量整体切到新 router 池）→ 发布新 router 且保持 `SESSION_TOMBSTONE_ENABLED=0` → 排空全部旧 router → 滚动新 runner → 核对配置中的每个健康 runner 都声明 `tombstone` → 将新 router 的 gate 设为 `1`。显式 gate、内部 token 与 router 的全健康 fleet capability 检查必须同时满足；升级窗口中其它 API 可继续提供，DELETE 返回可重试 `503 draining`。仅逐个替换 router 而不先阻断旧 router 的 DELETE 并不安全，因为旧进程没有这个 gate；runner 端口也必须通过网络策略保持内网不可直连。

Blob写入采用`0010` ownership manifest/outbox、`0027` shared namespace control与`0028` offline mover三层边界。先应用`0027`/`0028`并保持两个control dormant；部署理解S3 capability/control、mover runtime gate且Blob/export/T3e writer gate都关闭的新router/runner，随后彻底排空旧writer。独立验证目标bucket为private、从未启用versioning/Object Lock、没有lifecycle配置、仅服务writer可覆盖对象，并支持条件PUT/CAS和所需强一致性。空库可以直接设置`BLOB_STORE=s3`与`BLOB_STORAGE_CONTROL_ENABLED=1`让runner探测并执行generation 1 activation；非空filesystem库必须按上节停服并完成`0028` prepare/copy/verify/cutover/source-cleanup，不能手改manifest/control。恢复后核对全部configured runner报告相同`backend/shared/namespaceSha256/controlGeneration`，再依次开放cleanup/build/admission/writer gate。各VM本地目录、各Pod独立volume、NFS或手工复制仍不能冒充共享数据面；mover成功也只证明DB ledger授权的对象，不证明filesystem root不存在未知orphan。

`BLOB_S3_PRIVATE_BUCKET_ACK=1`仅是production启动所需的人工确认：应用无法跨所有S3-compatible供应商自动证明bucket policy/IAM完全私有。它必须在独立anonymous/public-access检查和权限审计后设置，并保留外部证据；startup probe只证明当时可达、unversioned、无lifecycle配置、Object-Lock关闭、条件create/CAS tombstone及随机probe对象cleanup可见性，不证明供应商支持或需要conditional DELETE。IAM/组织策略还要阻止运行后添加lifecycle或由外部writer覆盖同prefix，并把控制面漂移接入告警。真实云账号、bucket、IAM role、endpoint和Secret参数等待实际资源后填写，不能从本地MinIO值复制或编造。

user erasure 与 legacy tombstone compensation 共用 v2 expand→activate barrier，当前仍只允许本地对可丢弃 user体验：先应用 expand-only `0011`/`0012`/`0013` 和 dormant `0014`；发布 admission `0` 且只接受 v2 固定 ACK 的新 router，排空全部旧 router 与只认识 v1 的旧 worker并等待旧 lease 到期；再以两个 worker flag 都为 `0` 的状态滚动具备 `drain-v1`、`quarantine-v1` 与 legacy compensation 代码的新 runner。`0014` migration 只安装 inactive cutover、job/audit 表、索引和 guards，不扫描、排队、改写 session 或激活 purge。旧 v1 私有 endpoint 故意返回 404，不提供降级路径。

确认 fleet 都是新 binary 后，再逐实例开启`LEGACY_TOMBSTONE_COMPENSATION_ENABLED`；启用的 runner 才声明`legacy-tombstone-compensation-v1`。部分 rollout 期间 v2 barrier保持关闭，直到 router 在本进程观察每个稳定 `RUNNERS` 地址同时声明`quarantine-v1`与`legacy-tombstone-compensation-v1`，才返回固定 ACK。观察后的纯网络不可达会保留进程内 attestation；明确旧版/错误响应会撤销，router重启也会安全暂停claim，直到地址恢复或从配置移除。compensation worker首次获得 ACK 后激活 write-once cutover；从该线性化点起数据库拒绝新的 generation `0` tombstone 写入，不能回退 pre-`0014` writer。它会保留原 `deletedAt`，并在同一事务写 generation `1` terminal event、`session.tombstoned`/不可领取的 `session.purge` intent、append-only audit与job completion；任何失败均回滚且不会删除内容。随后才按需开启`ERASURE_WORKER_ENABLED`，最后依次开启runner、router admission。普通worker继续逐候选隔离确定性claim poison、跨 runner有界请求 abort、child-first tombstone、在 usage 写事务内重验 tombstone proof并停在 `awaiting_purge_policy`。两个 worker 在 staging/production 都默认 `0`，本地脚本显式设为 `1`；admission仍默认 `0`。紧急停止新请求时只关闭 router gate并保持 worker/capable runner运行；关闭 gate绝不撤销已提交 subject或已激活cutover。私有barrier只约束新worker，不能阻止仍直连数据库的旧worker，所以旧worker drain、网络/进程层阻断和forward-fix是硬发布条件。

`0015` 使用独立的 expand→code-aware→management-active 顺序。先在关闭新 erasure admission 的窗口独立应用 expand-only `0015`；再发布 `DATA_GOVERNANCE_MANAGEMENT_ENABLED=0` 的新 router并排空旧 router，随后滚动同样保持 management=`0` 的新 runner。此时新 runner即使管理端点关闭，也必须声明两项 `dataGovernance` 代码感知 capability；只有确认每个 configured稳定地址都健康且声明完整 contract 后，才逐实例将runner management gate设为`1`，最后开启router gate。任何 policy activate或legal-hold管理请求都只能在这个全 fleet门禁之后进入；runner端口仍须由网络策略保持内网不可直连。

policy activate 是提交即生效的 CAS，不提供“预设未来时间”调度。`effectiveAtMs` 是审计/控制时间：事务取得当前 control 锁后写入 `max(本次runner时间, 当前control时间)`，所以时钟落后的另一 runner 不会让审计时间倒退，也不会仅因墙钟回拨而返回 500；generation/行锁才是因果顺序。激活与新 erasure admission 共用 tenant control 锁作为线性化点：新请求若在该点观察到 active policy，就永久绑定其 version/hash，即使该 runner 提供的请求时间早于 `effectiveAtMs`；先提交的 backlog及其幂等 replay仍保留“未绑定”，不会被事后改写。`0015` 的 MySQL `BEFORE INSERT` guards在同一 control 上取共享锁，强制 dormant时必须是 `NULL/NULL`、active后必须是精确 version/hash，绕过新版应用的旧 writer只会失败，不能静默写入无绑定请求。

一旦首个 policy activation或canonical legal-hold control event提交，发布就进入另一条 forward-only 兼容边界：关闭management/admission gate只能停止新管理请求/新erasure请求，不能取消已激活策略、已设置hold或既有request绑定。不得回退到不会验证canonical ledger、不会在erasure admission绑定policy的pre-`0015` reader/writer，也不得删除control/event、手工清空policy identity或执行down migration；故障恢复必须保留证据并forward-fix。active legal hold会继续阻止尚未提交的usage anonymization；释放一个hold不会覆盖同subject的其它active hold。

`0016`采用独立的expand→code-aware→evaluator-active顺序。先在evaluator gate关闭时运行expand-only migration；它只建job/target/decision/authority表与append-only guards，不回填历史awaiting row、不开放任何purge intent。再部署`PURGE_POLICY_EVALUATOR_ENABLED=0`的新router并排空旧router，随后滚动同样gate=`0`、但会声明`policy-evaluator-v1`的新runner。确认每个configured稳定地址当前健康且code-aware后，逐runner开启该gate，最后开启router gate；每次schedule/claim仍需新的token-protected固定ACK。关闭gate只暂停新的evaluation pass，不撤销immutable evidence，也不恢复任何subject；它从不控制物理purge，因为本版本根本没有`dataPurgeExecution`开关。

evaluator rollout不能被描述为destructive activation。当前eligibility用runner记录的wall clock，target也不枚举turn/item/event/approval全量owner内容。`0021`另建DB-clock owner-scan receipt，`0022`把所有已知域与blocker固定为33域plan；`0023` T3e只以独立双gate和最小权限store执行local usage/Blob/export子集，`0024` T3f再原子清理session/idempotency/lifecycle/Blob/export等11个数据库投影，`0025` T3g最后精确清理session-scoped Redis lease/owner、fence与stream。三者都不把0016候选直接变成全局许可。`0030`只闭合T1 journal/fence恢复，不替代backup authority；完整execution仍要取得external secret/KMS、`0031` backup catalog、logs/traces、managed对象存储/IAM环境验收及其它completion ACK。`0016` completion、`0022` executionReady及T3e/T3f/T3g `allDomainsComplete`都固定为false。

`0017` user export采用expand→code-aware→worker→admission。先独立应用migration，再发布`DATA_EXPORT_REQUESTS_ENABLED=0`的新router并排空旧router；滚动同样admission=`0`的新runner，使每个地址都声明`userDataExport=["artifact-ndjson-v1"]`。filesystem只允许本地单runner先开cleanup、再开build worker，确认独占root后才开放admission。共享S3模式还必须先完成空库`0027`activation或非空库`0028`离线cutover，并让全fleet namespace capability一致，再在staging依次验证跨runner snapshot pin、分片发布/下载、下载中断与续租、TTL/撤销竞态及exact-identity cleanup，最后才开放admission并promotion同一image digest。关闭admission不撤销已有请求；worker仍须把queued/building job推进到ready/failed或安全清理，status/download只要求code-aware healthy fleet。

`0018` tenant erasure schema 仍是 expand-only，T2 则在不改 schema 的前提下增加独立 platform authority、router-only admission/status/replay、runner-local gate 与 fresh all-configured fleet barrier。安全激活顺序是：先应用 `0018` → 发布 tenant gate=`0` 的新 router并排空旧router → 以gate=`0`滚动全部新runner → 逐runner开启local admission capability → 核对每个configured稳定地址当前健康且code-aware → 最后开启router gate。任一目标不可达、版本不兼容或local gate关闭都会阻止新admission；status与exact replay在router gate关闭时仍可用。0030 generation `0`沿用精确已提交replay返回`202`的旧语义；0030 active后，create可能已提交T1，但create/exact replay在publication receipt可读前均返回可重试`503`，调用方必须用完全相同tenant/body/`Idempotency-Key`重试，receipt可读后才返回同一`202`；未命中也返回`503`且绝不创建。首次提交会立即建立不可撤销的lifecycle/credential fence，之后只能forward-fix。

`0019` T3a在`0026`上线后采用expand→ledger-aware→drain-old-writer→tracking-cutover→worker→execution-gate顺序。先应用default-dormant `0026`；以`CREDENTIAL_LIFECYCLE_TRACKING_ENABLED=0`部署全部新router/runner并完全排空pre-0026 writer，核对每个configured runner声明`versioned-target-ledger-v1`；随后显式启用runner tracking，让一个实例完成write-once cutover，并确认全fleet观察active；再开启router tracking gate。activation在runner监听、bootstrap mutation和worker启动前执行，但在T3g durable restore preflight之后；restore、tracking读取或activation阶段失败会关闭当时已创建的store/lease/bus/adapter，commit后响应丢失只允许重读active恢复；后续bootstrap、应用装配或listen失败不在该显式清理边界内。此后再以`TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED=0`滚动/开启worker，核对`credential-store-v1`和worker-active，最后开启router execution gate。worker每次materialize/claim及紧邻不可逆事务前仍要求fresh ACK；新admission与execution gate独立。tracking或首个T3a receipt任一cutover后均不得回退旧writer/worker。当前activation由startup flag触发且没有fleet-barrier migration Job，误开会让旧writer fail closed并造成可用性事故；production必须严格执行drain顺序，M4再提升为独立受审计发布步骤。

`0029` external-credential target execution再使用独立的expand→code-aware→worker→execution-gate顺序：先应用default-dormant migration；发布`TENANT_CREDENTIAL_TARGET_EXECUTION_ENABLED=0`的新router并完全排空旧router；滚动`TENANT_CREDENTIAL_TARGET_EXECUTION_WORKER_ENABLED=0`且声明`external-credential-execution-v1`的新runner；确认全部configured稳定地址健康后逐实例开worker，最后才开router gate。materialize、claim、续租、adapter mutation和seal都重新取得fresh ACK；首个receipt/cutover后只能forward-fix。当前唯一fake adapter只允许Memory与非production，因此标准MySQL local-service固定双gate关闭；真实provider adapter完成、经安全审计并在staging验证前不得照此激活。KMS不在该执行面内，始终保持未完成。

`0020` T3b使用与T3a分离的expand→endpoint-aware→worker→execution-gate顺序。migration只建runtime job、immutable per-target receipt和aggregate receipt，不扫描/回填`0019`、不触发网络drain、不改写T3a receipt。先以`TENANT_RUNTIME_DRAIN_EXECUTION_ENABLED=0`部署新router并排空旧router；再以runner两个T3b gate=`0`滚动新代码，为每个configured slot配置唯一且重启不变的`RUNNER_ID`，并确保`RUNNERS`逐项是该实例的直连稳定URL。逐runner开启`TENANT_RUNTIME_DRAIN_ENABLED`，核对所有地址的私有ready identity后再开启`TENANT_RUNTIME_REVOCATION_WORKER_ENABLED`，最后开router execution gate。每个claim将terminal T3a proof广播到所有精确target；runner先同步fence新auth/provider/turn admission，中止tracked本地I/O、等待有界结算并丢弃policy/verifier/provider references。router在fanout前后重新取完整fleet快照，任一boot/runner/target变化都拒绝aggregate proof；store再把全部target receipts、aggregate receipt和terminal job于同一事务提交。

T3b的紧急回滚首先关闭router execution gate，再让worker在当前job边界停领；不要先撤私有endpoint，否则已claim的fanout只会反复失败。关闭gate不会重开已fenced tenant、恢复cache/reference、撤销immutable receipt或改变T3a proof；一旦有`0020` terminal证据，故障恢复必须保留schema/proof并forward-fix，不得回退到会忽略T3b fence的版本。

`0021` T3c采用独立的expand→worker-active顺序，不增加router端点或execution gate。先应用migration，再以`TENANT_CONTENT_INVENTORY_WORKER_ENABLED=0`滚动全部新runner；确认严格schema fingerprint、append-only guards和新binary已就绪后，才逐实例启用worker。materializer只从完整T1/T3a/T3b terminal proof建立job；anchor不得早于T3a/T3b DB proof high-water，clock落后source/anchor/evidence时保持可重试。build/seal事务显式使用REPEATABLE READ，并重验immutable policy、tenant及全部user legal hold、session/turn/item/event/approval关系、连续event seq和全局orphan；`contextCompaction` synthetic turn与legacy approval item字段按canonical兼容规则处理。page/seal在最后一个可能阻塞的receipt INSERT后重读DB time并复核live lease，过期整事务回滚。关闭worker只暂停新claim，不能撤销receipt；首个`0021`证据提交后必须保留schema并forward-fix。seal当前锁定并扫描五类全局content表，属于local/CI正确性基线；生产启用前仍要用owner索引/FK/分区或等价设计消除全表扫描，并完成容量与写阻塞验证。

`0022` T3d采用另一条独立、无router execution端点的expand→worker-active顺序。先应用migration，再以`TENANT_PURGE_PLAN_WORKER_ENABLED=0`滚动全部新runner；确认三张表的strict fingerprint、append-only guards和新binary已就绪后才逐实例启用。worker只从terminal T3c及完整immutable source显式materialize，并对新空job直接seal；Memory单一原子边界/MySQL单个RR事务一次性写33条entry、aggregate和terminal job，同时重验source、canonical hold、全局owner closure、DB clock与post-write lease。MySQL对idempotency、usage ledger/reconciliation的全范围owner扫描持有`FOR SHARE`锁至commit，阻止扫描后phantom；legacy pending `NULL`保留，legacy completed `{turnId}`只允许反向解析到同一session，现代值若带`sessionId`则也必须匹配。operational usage允许无turn row的synthetic/legacy turn，但必须同session owner；reconciliation必须匹配已tombstone session的精确正generation。lifecycle↔request/admission需双向闭合，purge target需精确匹配tombstone generation/time。分页build只保留诊断/兼容用途，不由生产worker调用。新plan按0026精确target disposition把真实external `executable_ref`记为可撤销，legacy/source blocker继续阻断，KMS仍全部阻断；历史pre-0026 plan继续按冻结的粗粒度T3a证据校验。关闭只暂停新plan，不撤销receipt；首个`0022`证据提交后必须forward-fix。计划含blocker仍可seal，但`planComplete`永远不能被promotion流程解释为execution ready。

`0023` T3e再采用独立的expand→code-aware→cleanup/worker→execution-gate顺序。先应用migration；发布`TENANT_PURGE_EXECUTION_ENABLED=0`的新router并排空旧router；再以`TENANT_PURGE_EXECUTION_WORKER_ENABLED=0`滚动全部新runner，使其先声明`local-execution-ack-v1`但不接触queue。filesystem只能在local单runner确认root独占后使用；S3多runner则必须先完成空库`0027`activation或非空库`0028`离线cutover、全fleet namespace收敛及真实staging跨runner cleanup验证。两种模式都要先开启Blob/export cleanup，待全部configured runner当前健康且T3e worker-active后最后开router gate。worker在materialize、claim、lease、cutover和physical seal前都取得fresh non-sticky all-configured ACK；首次cutover同时提交usage anonymize、export revoke/snapshot release、exact outbox、domain ACK和write-once cutover，以后只能forward-fix。关闭gate只暂停新边界，不能恢复已修改数据或撤销durable evidence；S3 adapter存在不等于external/KMS、backup/restore、logs/traces或全域completion已完成。

`0024` T3f采用单独的expand→router-first drain→runner worker→execution-gate顺序。先应用migration；发布`TENANT_DATABASE_PURGE_ENABLED=0`且理解两个capability的新router，并完全排空所有旧router；然后才以`TENANT_DATABASE_PURGE_WORKER_ENABLED=0`滚动新runner，再逐实例开worker，最后开router gate。不能runner-first：旧router的严格capability parser会拒绝新runner的`["local-execution-ack-v1","local-db-content-delete-v1"]`。首个T3f cutover后只能forward-fix；关闭任一gate只暂停新边界，不能恢复已删投影、移除grave或撤销不可变证据。

`0025` T3g采用独立的expand→marker-aware router→marker-aware runner→worker→execution-gate顺序。先应用migration，并给所有router/runner设置相同且准确的非密钥`REDIS_NAMESPACE_ID`与`REDIS_PREFIX`；发布`TENANT_REDIS_PURGE_ENABLED=0`的新router并完全排空旧router；再以`TENANT_REDIS_PURGE_WORKER_ENABLED=0`滚动marker-aware新runner，并在任何T3g mutation前完全排空旧runner。核对`RUNNERS`中的稳定直连地址全部健康、声明`session-state-delete-v1`且namespace digest一致后，保持router gate关闭并逐实例开启worker；这允许重放已有durable ACK marker，并用existing-marker-only Lua收口未ACK marker，但不会materialize新job或创建首次marker。全部worker-active后最后开启router gate。首个marker、target ACK或cutover后只能forward-fix：可关闭router gate暂停新materialize/mutation，但worker必须保持开启以继续existing-marker replay、补ACK/seal和durable restore，不能改namespace identity或回退到marker-unaware binary。fleet barrier无法约束仍存活且能直接写Redis的旧进程，所以旧runner drain不可省略。

T3g restore不是完整Redis-loss保证：same-MySQL keyset只枚举已经写入durable target ACK的marker。正常marker-only窗口可由worker轮询中的existing-marker-only replay在gate关闭时收口；但若Lua已写marker而MySQL ACK尚未提交，且该marker在worker成功replay并持久化ACK前又从Redis丢失，首次lease/fence/stream existence bits无法恢复。MySQL和Redis同时恢复到旧snapshot也不受保护。大tenant restore keyset扫描/重放性能、独立故障域ledger、永久marker容量和普通live-session fence灾备仍待设计/压测。当前真实Redis自动测试使用standalone ioredis并验证same-slot key grammar，但真实Redis Cluster、ACL、persistence与failover只能在staging/production资源就绪后验收。

当前MySQL实现会在整个T3f destructive transaction内对全局cutover singleton持有`FOR UPDATE`锁，因此不同tenant的数据库清理会安全串行；这是local/CI正确性优先的实现，不是生产吞吐承诺。进入staging前必须以真实数据量验证锁等待、lease预算和超时，并决定是否需要可证明等价的分片/租户级协调。仓库已有冻结的pre-T3f capability parser测试来证明runner-first不兼容，但真实N-1 router镜像canary、排空和回滚演练仍必须在staging完成；不能只凭单进程单元测试宣称滚动升级已验证。

T3d上线staging前还必须验证全库RR/next-key owner扫描的索引、容量、跨tenant写阻塞/死锁、lease预算和锁超时；这些未被local/CI正确性证明覆盖。损坏queued plan envelope可能在逐候选隔离前饿死后续job，cursor重启还会重扫损坏前缀；当前fail-closed且无receipt/执行权，但需M4 raw-key quarantine/skip或人工维护。`0022` trigger fingerprint不校验action body，迁移夹具只显式模拟首个DDL auto-commit边界；这些剩余风险要求生产runtime principal无DDL/TRIGGER权限，并在预发扩展schema tamper与中断迁移演练。

erasure 现在有三条不可逆回滚边界。第一条是“首次请求已接受”：关闭 router writer gate 只停止新的 erasure POST，绝不会撤销已持久化的 subject gate。writer gate 保持 `1` 时，router 会对 `/v1/sessions*`、`/v1/usage` 与 erasure 路径逐次检查 selected target capability，能力回退即返回可重试 `503` 而不转发；gate=`0` 的 expand mixed window仍可提供普通 runtime。首次接受后必须保持所有处理 user 请求的 runner 都 lifecycle-aware，并优先 forward-fix；不能把业务流量回退给 pre-`0011` 或其它不检查 `subject_lifecycle` 的 runner，否则已 gated subject 可能重新可见并产生新写入。

第二条是“任一 quarantine/maintenance control event或terminal incident已写入”：此后不能回退到pre-`0013` reader/worker。router sticky observation在明确观察到旧runner时会关闭新claim，但它约束不了绕过router、直接连接数据库的旧worker；事故处置必须forward-fix，或先排空/阻断全部旧worker和受影响流量。若确实必须恢复pre-`0011`版本，先在edge精确阻断受影响tenant/user；edge无法可靠识别时先阻断全部user-scoped runtime。`0011` gate/audit、`0012` queue和`0013` control/incident history都必须保留，不能用down migration、feature flag或镜像回滚把它们当作已撤销。

第三条是“`0014` cutover 已激活”：该 singleton 只允许 inactive generation `0` 到 active generation `1` 的一次转换，不能 disable、删除或重写证据。激活事务与 session writer 通过行锁线性化；提交后继续运行 pre-`0014` writer只会产生被数据库拒绝的 legacy 写入，并可能让业务请求失败。关闭 compensation worker不撤销 cutover，回滚必须是 forward-fix 到兼容 reader/writer，不能执行 down migration 或手工修改 singleton/trigger。

轮换 `INTERNAL_ROUTER_TOKEN` 时先把 tombstone、user-erasure、tenant-erasure writer gate、T3a/T3e/T3f/T3g/0030 execution gate与T3b router execution gate都设为`0`，并让会取得新authority的erasure worker在当前原子job边界停领；durable subject/tenant gate与历史job保持不变。T3g worker只停止新materialize/mutation，仍必须保持启动，以继续不扩权的existing-marker replay、补ACK/seal与durable restore；0030 control激活后publisher也必须保持配置/启动，但router gate关闭会暂停新的journal mutation。随后在新的破坏性请求被拒绝、历史job暂停推进的窗口内，让全部runner和router收敛到新值，核对私有barrier、drain、健康与公开capability后再先恢复endpoint/worker/execution、最后恢复writer gate。当前不支持双token重叠窗口。轮换 `TENANT_ERASURE_OPERATOR_TOKEN` 时也应先关闭 tenant admission；status 读取需要新 token，因此要协调客户端和 router 的切换，且该 token 永远不得注入 runner。任一 token 都不得写入镜像、Git、日志或公开 API 文档。

未来真正改变 protocol version 的不兼容 contract 仍由健康探测隔离：版本不匹配的 runner 不进入 hash ring，也不能通过 owner 重路由；这类升级需要全量 drain 的维护窗口或将旧/新 router+runner 整组 blue-green，除非另行实现 version range/按版本路由。`session/deleted` 本身不属于这类版本提升。

当前自动验证的候选发布物仍是两个独立的 Linux OCI 镜像：`agent-router` 与 `agent-runner` 分别构建和启动检查，未来可以位于不同虚拟机或容器节点；runner镜像除默认`main.js`外还包含显式调用的一次性`blob-storage-migrate.js`和`restore-ledger-reconcile.js`，但不会因此新增第三、第四个常驻进程或镜像。当前 workflow 不上传它们。“不可变镜像”指未来发布到 registry 后由 digest 唯一确定，进入 staging/production 时不再重新编译或修改；不是 Windows/Linux 的虚拟机磁盘镜像。

`pnpm build`生成router长期入口`apps/agent-router/dist/main.js`、runner长期入口`apps/agent-runner/dist/main.js`和runner两个一次性维护入口`apps/agent-runner/dist/blob-storage-migrate.js`、`apps/agent-runner/dist/restore-ledger-reconcile.js`，均为Node 24 ESM JavaScript bundle，可在装有对应production dependencies的Linux、macOS或Windows主机运行，但不是原生机器码二进制。目前CI对两个main、两个one-shot CLI和两个容器镜像都有执行门禁；生产默认推荐OCI镜像，因为依赖、Node版本和文件布局也被一起冻结。若未来明确采用裸VM，再增加带校验和的bundle + production `node_modules`发布包和systemd服务，不需要把两个长期服务合成一个二进制，也不应把维护CLI注册成常驻服务。

"本地完整"指已实现链路可在真实 MySQL + Redis + router/runner 下重复运行；当前自动门禁还覆盖双runner user-erasure、policy/hold/evaluator、异步user-export snapshot/artifact/download/TTL/撤销清理，tenant T1/T2 platform控制、T3a本地DB credential-store物理清除、`0026` versioned credential lifecycle/tracking/T3a inventory、`0027` write-once Blob namespace control与真实MinIO跨client语义、`0028`离线filesystem→S3 mover及runtime gate、T3b per-tenant runtime/cache/active-I/O drain与configured-fleet proof、T3c可信DB时间和owner-scan完整content receipt、T3d固定33域plan和显式blocker、T3e本地usage/Blob/export cutover与physical ACK、T3f本地数据库11域删除/ACK/grave/cutover、T3g真实Redis三域Lua删除/永久marker/startup-periodic replay、`0029`external-target Memory fake/真实MySQL账本，以及`0030` independent journal/runtime/replay ledger、真实MinIO adapter与one-shot CLI。它不表示云依赖已被本机替代，也不表示数据生命周期闭环：0029 fake不是远端provider证明，标准MySQL栈不会启用它；0030只有单target、跨DB/S3 saga、人工ACK和epoch ABA残余，且没有`0031` backup catalog。真实provider adapter、全部KMS、logs/traces、managed对象存储/IAM/KMS验收、completed proof及generic session/user物理purge仍待完成。filesystem Blob/export/T3e只证明单runner本地语义；本地MinIO证明S3-compatible协议、跨进程可见性和小规模mover/journal正确性，但同机独立bucket不能外推成故障域、云IAM、SLA、容量或维护时长验收。same-MySQL T3g replay也不能冒充独立restore proof；T3c全表扫描和`0028`全量内存/大事务inventory同样不能外推成生产容量；任何局部ACK都不能被当成全域adapter已实现。无云资源不阻碍这些local/CI代码范围，但真实对象存储、KMS/IAM、managed Redis、backup catalog、恢复与rollout集成仍属于M4/环境交付缺口。

当前 `MysqlSessionStore.connect()` 仍会自动执行迁移，适合 local/CI，但还不满足上文“生产迁移作为独立 Job”的目标。进入 staging 前必须拆出显式 migration 命令/Job，并让业务进程只做 schema 版本检查、禁止启动时自动 DDL；同时完成备份恢复与迁移失败后的人工审计/重试演练。

暂不生成绑定某一云厂商的 Kubernetes YAML/Helm values；待 namespace、域名、镜像仓库、Secret/KMS、MySQL/Redis 地址和资源配额明确后再生成，避免把临时假设固化进部署资产。

迁移 `0008_atomic_turn_writes.sql` 会为 completed receipt 增加请求 hash，并给 usage ledger 建业务唯一键。

迁移 `0009_session_tombstone_outbox.sql` 增加 nullable `purge_after_ms`、默认 `0` 的 `deletion_generation`、parent lifecycle index 和 durable lifecycle outbox。固定 0008 历史库的真实 MySQL 夹具验证旧 deleted row 保持 generation `0`，迁移可重入且不会伪造 cleanup intent；这些历史 row 现在由 `0014` 的独立、可审计补偿流程处理，而不是由 migration DML 静默改写。

迁移 `0010_blob_ownership.sql` 是 expand-only：新增大小写敏感的 `blob_objects` ownership manifest 和独立 `blob_delete_outbox`，不回填或改写既有 session/lifecycle 行，也不启用 ready Blob purge。固定 0009 历史库夹具通过真实 migration runner 证明历史 session/outbox 保留、迁移重入安全、identity collation 与唯一索引符合预期；CI 另有显式不得 skip 的真实 MySQL Blob lifecycle 套件，证明 item 绑定原子性、owner 隔离、rollback 和并发 claim，而不仅是 fresh-schema 建表成功。

迁移 `0011_erasure_and_usage_separation.sql` 也是 expand-only：为 `usage_ledger` 增加 nullable、大小写敏感的 opaque `usage_id` 及唯一索引，新增只含最小财务字段的 `billing_usage_facts`、`usage_reconciliations`，以及 `subject_lifecycle`、`erasure_requests`、`erasure_audit_events`。它不会给历史 usage 伪造 ID 或 billing fact，不执行 reconcile/anonymize/purge，也不会伪造 erasure request；新写入才事务双写 operational 与 billing 两层。restart-safe `AFTER INSERT sessions` trigger 会为迁移后仍存活的旧 writer 原子补 tenant/user lifecycle 行，重放只做 insert、不会覆盖 gate/legal hold；它不拦截旧 writer 对已有 session 的写入，所以不能替代升级 drain。固定 0010 历史库的真实 MySQL 夹具验证 DDL auto-commit 中断后可重跑收敛、错误形状 identity 索引可修复、大小写敏感约束、旧 writer post-migration insert 与 gate/hold 保留，且既有 usage/session/outbox/blob 原样保留。CI 的 usage/subject lifecycle 独立套件不得 skip，并由 suite report 明确证明实际执行，而不是只验证 fresh schema。

迁移 `0012_erasure_job_queue.sql` 继续 expand-only：为 request 增加 availability、attempt、claim token/lease、bounded error 与 policy identity，并安装兼容 0011 writer 的 insert trigger。它不会激活 purge；waiting/terminal row 始终不可领取，重放不会覆盖 future retry 或 live claim，残缺 claim pair 会 fail-safe 清空。固定 0011 历史夹具覆盖全部状态、legal hold、不可领取 purge intent、partial DDL、错误索引和 marker-loss replay；CI 还独立强制运行 queue/session/catalog/claim-bound usage 四个真实 MySQL 套件，并从主 report证明真实 MySQL worker的事务内 proof重验确实执行。

迁移 `0013_erasure_job_control.sql` 也是 expand-only：为request增加control generation和三列quarantine overlay，新建append-only control event、append-only terminal incident表及quarantine-aware claim index；它不隔离既有row、不repair/resume、不激活purge。incident只保存request locator、exact raw control fence、fixed reason、SHA-256和时间，不复制tenant/user/subject/status/raw payload。MySQL 8.0.26兼容的多重UPDATE/DELETE trigger guard保证migration marker丢失或中断重放时仍收敛到两类append-only保护；早期错误unique-index形状会被修正，若同一request/generation已有冲突证据则迁移故意失败且不删除任一事件。固定0012历史夹具覆盖完整升级、control/incident建表断点、partial DDL/错误索引/marker-loss replay、两类append-only guards和冲突阻断；CI migration wrapper显式枚举该套件并拒绝missing/skipped。运行时按候选独立事务quarantine，maintenance control与普通worker capability分离。若监控发现 `control_audit_invalid`、terminal incident或safe-integer fence耗尽，则该row是永久terminal isolation：原始identity/time/BIGINT不得手工改写，不能补造event或调用普通repair；应保全证据、停止相关旧worker并通过后续受审计的专用迁移/事故流程处理。

迁移 `0014_legacy_tombstone_compensation.sql` 继续保持 expand-only 和 dormant：新增 inactive write-once cutover、每 session 一个 durable compensation job、append-only result audit、candidate/claim indexes 与 session row guards。应用 migration 本身不会激活 cutover、扫描或排队历史 row、生成 event/outbox、修改 generation、使 purge 可领取或删除内容。固定 `0013 → 0014` 历史夹具覆盖完整升级、DDL 中断/marker-loss replay、错误 index/trigger 收敛、旧数据原样保留、cutover 与并发 legacy writer 的锁线性化，以及激活后的 guard；CI migration manifest拒绝缺失或 skipped fixture。另有 `pnpm test:legacy-tombstone-mysql` named no-skip 套件使用真实 InnoDB 验证 claim/ABA、active资源结算、原子成功发布、audit/outbox失败回滚、child/owner隔离、terminal incident与幂等重试。migration marker本身不等于runtime cutover已激活。

迁移 `0015_retention_policy_and_legal_holds.sql` 仍是 expand-only：新增tenant immutable policy versions、generation-fenced active control与append-only activation audit，并把单个 `legal_hold_at_ms` 兼容shadow提升为tenant/user scoped multi-hold ledger、control和append-only audit。migration会为历史非空shadow生成确定性`legacy_unattributed`证据，但不会创建默认active policy、激活management、修改既有erasure backlog、调度purge、开放`session.purge` intent、anonymize usage、删除内容或推进job；retention duration为`NULL`时始终表示fail-closed不授权过期，当前非`NULL`值也没有自动开启物理purge。固定`0014 → 0015`真实MySQL夹具覆盖历史数据保留、legacy hold证据、DDL中断/marker-loss重放、冲突阻断、append-only/单向release guards以及purge继续dormant；migration wrapper显式枚举该夹具并拒绝missing/skipped。`pnpm test:retention-policy-mysql`是另一条named no-skip真实InnoDB门禁，覆盖immutable版本、并发CAS、事务回滚、跨runner时钟clamp、erasure admission绑定、multi hold及anonymization竞态；`scripts/local-service.sh verify`和GitHub CI都会执行两条门禁，而不是只验证fresh schema。

迁移 `0016_erasure_purge_policy_authority.sql` 继续expand-only和destructive-dormant：新增durable evaluation job、按build generation不可变的per-session target、rooted decision chain、generation-CAS active authority projection与append-only authority。migration不扫描或回填历史awaiting request、不设置`purge_after_ms`、不开放`session.purge`/ready Blob delete、不匿名化或删除任何数据，也不推进`purging/completed`。固定`0015 → 0016`真实MySQL夹具覆盖原policy/hold/request/content保留、partial DDL、marker-loss/replay、append-only trigger轮换、升级后同key异内容写入被拒并保留原证据，以及purge继续休眠；migration wrapper显式枚举该夹具并拒绝missing/skipped。`pnpm test:erasure-purge-policy-mysql`是另一条named no-skip真实InnoDB门禁，覆盖原子job建立、claim/ABA、deadline、live evidence/hold重评、并发锁顺序和seal回滚。

迁移 `0017_user_export_jobs_and_artifacts.sql` 继续expand-only：新增request/job、白名单snapshot、source-Blob pin、artifact/part、download lease与artifact-delete outbox表，不创建请求、不扫描或复制历史内容，也不打开任何HTTP gate。固定`0016 → 0017`真实MySQL夹具覆盖历史数据原样保留、完整升级、partial-DDL/marker-loss重放、append-only guard轮换和表/index/nullable staging descriptor契约；migration wrapper拒绝missing/skipped。`pnpm test:user-data-export-mysql`是named no-skip真实InnoDB门禁，并包含真实core worker跨越claim→consistent snapshot→stage→Blob put→upload ACK→ready publication的跨层证明。

迁移 `0018_tenant_credential_revocation_fence.sql` 仍是expand-only：新增每tenant至多一条、append-only的`tenant_erasure_admissions`和append-only credential fence，不创建tenant worker job、不撤销物理credential、不启动worker，也不修改旧`erasure_requests`或其scheduler trigger。固定`0017 → 0018`真实MySQL夹具精确检查新表列/索引/guard，证明历史credential/export/request/trigger保留、新admission脱离旧claim扫描、user scheduling保持，并覆盖partial-DDL、marker-loss逐语句重放与不兼容同名表在写marker前fail-fast；migration wrapper显式要求该夹具且不得skip。`pnpm test:tenant-credential-revocation-mysql`另以两个named真实InnoDB文件证明原子gate/fence/status proof、rollback、race与跨tenant隔离。

迁移 `0019_tenant_credential_physical_revocation.sql` 只安装独立credential job、immutable aggregate receipt、write-once cutover及其guards；不materialize历史`0018` admission、不claim、不删除credential/content、不激活cutover。固定`0018 → 0019`真实MySQL夹具覆盖旧admission/fence/audit/user queue保留、完整升级、partial-DDL/marker-loss replay、append-only guard、合法receipt重放与冲突形状fail-fast。`pnpm test:tenant-credential-physical-revocation-mysql`是独立named no-skip真实InnoDB门禁，还覆盖generation-0 orphan completion、active首job缺失/不匹配、immutable T1 source损坏、live lifecycle拒权及terminal proof跨`erased`/projection清理继续可用。

迁移 `0020_tenant_runtime_revocation.sql` 也是expand-only且execution-dormant：新增T3b runtime job、按configured target不可变receipt与aggregate receipt，只保存domain-separated target/runner/boot hash，不保存原始URL或身份标签。migration不扫描terminal T3a、不回填job、不清cache或中止I/O、不改lifecycle或content。固定`0019 → 0020`真实MySQL夹具覆盖历史T3a/T1证据保留、完整升级、首表auto-commit后无marker重放、append-only guards、合法terminal证据重放及冲突/超量target形状fail-fast。`pnpm test:tenant-runtime-revocation-mysql`是named no-skip真实InnoDB门禁，覆盖proof-checked materialize、DB-time claim/lease/ABA、完整target set与aggregate/job同事务、故障回滚、response-loss replay、tenant隔离与冲突阻断。该marker只证明`0020` schema/guards已安装，不表示T3a/T3b任一gate开启或任何tenant已处理。

迁移 `0021_tenant_content_inventory.sql` 同样expand-only且destructive-dormant：新增独立T3c job、append-only per-session结构receipt和tenant aggregate receipt；不扫描或回填terminal T3b、不读取/复制正文、不匿名化usage、不删除session/Blob/receipt/Redis数据，也不把公开status推进为completed。它严格fingerprint engine/collation/no-partition、列顺序/类型/default/charset/extra/generation、ENFORCED CHECK、完整index shape和精确trigger set，并保存/恢复session `group_concat_max_len`；queued未claim要求availability不早于updated，claimed要求lease不早于updated。固定`0020 → 0021`真实MySQL夹具覆盖T1/T3a/T3b历史证据与业务内容逐字节保留、完整升级、partial-DDL/marker-loss重放、append-only guards、错误prefix index/engine/CHECK/额外敏感列或trigger等冲突schema fail-fast。`pnpm test:tenant-content-inventory-mysql`是named no-skip真实InnoDB门禁，覆盖DB-time high-water/rollback、显式RR并发防phantom、canonical compaction/approval关系、topology drift、canonical hold/global orphan、阻塞INSERT跨lease全事务回滚、ABA和跨tenant隔离。

迁移 `0022_tenant_purge_plan.sql` 继续expand-only且execution-dormant：新增独立T3d job、严格固定33域的append-only entry和tenant aggregate receipt；不扫描或回填terminal T3c、不调用本地/云adapter、不删除/匿名化/撤销任何数据，也不把公开status推进为completed。它严格fingerprint engine/collation/no-partition、精确列/CHECK/index/trigger形状，并通过永久guards把receipt固定为`plan_complete=TRUE`、`execution_ready=FALSE`、`content_purge_executed=FALSE`。固定`0021 → 0022`真实MySQL夹具覆盖旧证据与业务数据保持、无隐式plan、首表DDL中断/marker-loss重放、append-only guards和不兼容schema fail-fast。`pnpm test:tenant-purge-plan-mysql`是named no-skip真实InnoDB门禁，覆盖固定catalog、blocker、source/hold、owner closure、full-range lock、claim/ABA、回滚、exact replay和隔离。

迁移 `0023_tenant_purge_execution_ack.sql` 继续expand-only并保持runtime gate默认关闭：新增execution job、33域执行投影、append-only domain ACK、local cutover/physical ACK receipt与write-once cutover；migration不materialize历史plan、不运行worker、不匿名化usage、不撤销export、不创建delete outbox或physical ACK。固定`0022 → 0023`真实MySQL夹具证明历史plan/业务证据保持、无隐式执行，并覆盖partial-DDL、marker-loss replay、append-only/固定false guards和严格schema fingerprint。`pnpm test:tenant-purge-execution-mysql`是独立named no-skip真实InnoDB门禁，覆盖原子cutover、exact outbox关联、cleanup completion/dead-letter、physical seal、claim/lease/response-loss、回滚和tenant隔离。`0023`的marker继续作为完整历史链的必经步骤；marker只证明schema/guards已安装，不表示worker/gate开启或任何tenant发生处理。

迁移 `0024_tenant_database_purge.sql` 安装T3f独立job、11域pre-delete entry/receipt、append-only domain ACK、terminal receipt、全局session grave与write-once cutover；不回填job、不执行删除、不启用worker/gate或推进公开completion。固定`0023 → 0024`真实MySQL夹具覆盖历史T3e/业务证据保持、无隐式处置、DDL auto-commit断点收敛、marker-loss replay、弱trigger修复/未知trigger拒绝、错误index/列/CHECK拒绝及grave禁止session ID复用。Memory/MySQL两个named no-skip套件分别证明staged atomicity与真实InnoDB事务、锁、回滚、response-loss replay和tenant隔离。

迁移 `0025_tenant_redis_purge.sql` 安装T3g独立job、per-session target、target ACK、三个domain ACK、terminal receipt与write-once cutover；不materialize历史T3f receipt、不连接或修改Redis、不写marker、不启用worker/gate或推进公开completion。固定`0024 → 0025`真实MySQL套件用全链hash固定的独立frozen schema证明历史业务行保持、无隐式job/mutation、DDL auto-commit断点收敛、marker-loss replay、append-only guards及不兼容schema拒绝；另用不依赖live旧迁移或当前writer的静态hash固定pre-0025 T3f evidence，逐字段证明全部七张T3f证据表升级后不变，并验证只有显式runtime materializer才会创建T3g job/target。Memory contract、真实MySQL、真实Redis Lua和cluster rollout均有独立named no-skip门禁。

迁移 `0026_credential_lifecycle_inventory.sql` 安装inactive tracking singleton、每tenant coverage/gap、永久provider slot与tenant-auth CAS投影、immutable credential version、固定双target disposition和T3a inventory sidecar；migration不扫描credential value、不生成locator、不激活tracking或T3a，也不改写历史T3a receipt。受信任服务端的新provider写路径可另行把content-free identity保护为`executable_ref`，secret/header/URL/明文locator仍不入账。固定`0025 → 0026`真实MySQL夹具从预置历史库验证旧业务/credential/T3a证据保持、无隐式subject/version/inventory、partial-DDL与marker-loss重放、三重永久guard、严格schema fingerprint和冲突schema阻断。Memory与真实MySQL named套件另覆盖cutover/writer锁序、source-generation CAS、delete/recreate ABA、时钟回退、source/material/target tamper fail-closed、T3a inventory同事务回滚及terminal replay。

迁移`0027_blob_storage_control.sql`安装default-dormant singleton、snapshot完整namespace pin和三代等价写guard；migration不选择backend、不搬bytes、不创建/删除对象，也不自动激活control。generation 1 activation在一个Memory原子边界或MySQL事务内锁定并核对全部live Blob/export manifest、未释放snapshot pin及所有未完成delete intent；dead-letter不等于physical completion，仍会阻断异backend cutover。固定`0026 → 0027`真实MySQL夹具证明0026业务/Blob/export状态保留、marker-loss/首DDL auto-commit收敛、冲突legacy manifest/pin/dead-letter阻断和弱同名schema fail-fast；Memory/MySQL named套件另覆盖并发activation、response-loss精确重读、后置失败回滚和active guard。该marker只证明dormant schema/guards安装，不表示generation 1已激活、bytes已迁移或bucket/IAM已通过生产验收。

迁移`0028_blob_storage_migration.sql`安装default-dormant offline mover control、sealed inventory、object/source-target cleanup ACK、append-only event/receipt及runtime写冻结guards；migration本身不冻结、枚举、复制、重写pointer、清理source或激活`0027`。固定`0027 → 0028`真实MySQL夹具验证旧业务/Blob/export/control逐字段保持、完整升级、首/中/末DDL auto-commit断点、marker-loss与owned trigger修复、不兼容schema/额外trigger拒绝、runtime freeze不可由connection variable绕过、activation/freeze只一方胜出、aborted namespace永久fence、cutover故障全回滚及exact ACK/cleanup。另有真实MySQL+MinIO named no-skip套件覆盖空库与data/tombstone/staging搬迁、legacy raw+sidecar、ordinary staging resume、带非空MIME的pending export delete、target丢失、abort只fence本attempt owner、exclusive operator/status reader、named-lock连接中断的in-flight mutation fence和对象上限。

迁移`0029_tenant_credential_target_execution.sql`安装default-dormant external target job/target/ACK/receipt/cutover；migration不materialize T3a、不解密reference、不调用provider、不启用worker/gate，也不把KMS变成可执行。固定`0028 → 0029`真实MySQL夹具从预置历史库验证业务、credential inventory、Blob control/mover状态保持、默认零job/ACK/receipt、partial-DDL与marker-loss重放、append-only guards和冲突schema fail-fast。`pnpm test:tenant-credential-target-execution-mysql`另以真实InnoDB证明source-bound materialize、claim/lease、exact ACK、terminal publication、response-loss replay、并发与SQL故障全回滚。

迁移`0030_tenant_restore_journal.sql`安装default-dormant journal control/target、T1 publication job/target/ACK、runtime control/head/event以及restore run/sealed target/permanent fence/receipt；migration不选择或访问S3、不激活journal/runtime、不materialize历史T1、不生成backup digest、不重放fence，也不推进任何T3a/completion。固定`0029 → 0030`真实MySQL夹具从预置历史库证明业务、credential target execution、Blob control/mover与全部lifecycle证据逐字段保持，默认零publication/replay动作，并覆盖partial-DDL、marker-loss收敛、append-only guards和冲突schema fail-fast。Memory/真实InnoDB named no-skip套件另证明原子T1 publication建立、claim/lease、ACK、runtime lineage、恢复fence/seal/activation、response-loss、并发与回滚；真实MinIO套件证明外部create-only chain/seal/replay。CI runner image的最新marker是`0030_tenant_restore_journal.sql`，并在镜像内分别执行mover与restore reconciler的`--help`。marker只证明dormant schema/guards已安装，不表示journal primary activation、外部publication、backup或restore已发生；verify-only runtime还会在marker存在时校验精确schema/trigger fingerprint，marker本身不能替代该检查。

grave中的`ownerSha256`是与删除同一事务从live session捕获、由`0024` append-only guard和运行时最小权限保护的opaque ownership claim；T3c session receipt不含`userId`，因此它不是可脱离外部owner tuple独立重算的上游证明。全局session ID防复用依赖grave的`session_id`/PRIMARY KEY和`BEFORE INSERT`阻断，不依赖对`ownerSha256`的独立反推；legacy/purge-target路径仍会使用保留的`userId`重算并比对。

T3d owner closure还会复验Memory的export/user-erasure/tenant-admission request↔idempotency双向索引，以及Memory/MySQL legacy compensation deterministic `jobId`↔精确session owner/tombstone generation/time。MySQL还重算`candidateSha256`并校验`sourceLastSeq`；`erasure_claim`精确绑定request/generation，status精确对应单个audit/result，completed event seq等于`session.lastSeq`且success evidence完整；损坏不会产生partial plan/aggregate。全局orphan/cross-owner损坏会使claim终结为`blocked`，底层数据修复后不会自动resume/rebuild，所以需后续operator repair/resume协议，不得手工改job/evidence。

新版 `createSession` 会原子写入 session 与 `session/created(seq=1)`；混合版本窗口内旧 runner 仍是旧的两步路径，因此只有在旧实例全部排空后，才能把该原子性作为全 fleet 不变量。这个约束与下述 legacy pending 清理边界相同：不能在旧进程仍可能写入时提前宣告升级完成。

为兼容滚动升级，迁移不会批量删除旧版 runner 可能仍在使用的 legacy pending 幂等占位。新版 runner 命中 pending 时返回 `409 idempotency_conflict`，不会接管或替换该记录；否则旧 runner 的 delayed complete 可能在稍后覆写新版结果。发布时必须先排空并下线全部旧 runner，确认不存在旧进程后，再清理已过期 pending。旧版已完成 receipt 无法反推原请求，其 `request_hash` 保持 `NULL`；在该 receipt TTL 内新版会为兼容性直接重放，无法对“同 key 异请求”做 409 校验。

幂等表需要周期清理（建议由 CronJob/定时任务执行）。脚本默认只分批删除安全的、已过期 completed receipt；可先 dry-run：

```bash
scripts/local-service.sh cleanup-idempotency --dry-run
scripts/local-service.sh cleanup-idempotency
```

只有在确认所有旧版 runner 都已排空并下线后，才可额外清理过期 legacy pending：

```bash
scripts/local-service.sh cleanup-idempotency --delete-legacy-pending-after-drain
```

默认每批 1,000 行、单次最多 100 批；可用 `--batch-size=N --max-batches=N` 调整。脚本固定一次运行的过期时间水位，避免长任务持续追赶新到期记录。

迁移只自动合并内容完全相同的历史重复账；若同一 `(session_id, turn_id, step)` 存在内容不同的账目，唯一索引创建会故意失败，部署前必须备份并人工审计，不能静默丢账。

当前 DELETE 会原子提交 terminal `session/deleted`、单调 generation、`session.tombstoned` 与 `session.purge` 两条 durable intent；后者的 `available_at_ms` 保持 `NULL`。每个 runner 都启动 dispatcher，通过 claim lease/CAS、续租和有上限退避只投递前者；短暂存储/总线故障会持续重试，确定损坏的 envelope/event identity 才进入 dead-letter。语义是 at-least-once，重复发布用相同 event `seq`，订阅路径据此去重。dispatcher 不新增独立服务或镜像，也不会领取 purge。generation `0` 补偿现在会生成相同形状的 generation `1` terminal proof和两条 intent，但仍不会激活或执行 purge；物理 purge和 dead-letter 的管理端修复/重放/指标/告警尚未实现，terminal event 已投递不代表数据已清理。

Blob cleanup 使用独立专用 outbox。普通staging sweeper只为超过TTL仍未绑定的`staging`对象调度删除；T3e则可在受限cutover事务中把sealed tenant plan精确命中的staging/ready manifest标为`delete_pending`并写同一类exact outbox。worker claim 后重新核对canonical `blobId → storageKey`、manifest/backend/format/generation，物理delete成功后才把manifest标为`deleted`；T3e还必须等同一outbox identity实际completed后才能追加physical ACK。filesystem adapter以key-scoped小型cancellation fence阻止迟到writer复活；S3 adapter把永久tombstone写在数据对象的同一key上，并在ACK前强读回验exact tombstone。短暂后端错误、当前进程backend/namespace不匹配都持续重试而不被误判为poison；只有确定性identity/format损坏才可dead-letter，且所有未完成意图（包括dead-letter）都会阻断不兼容`0027`activation。两类永久marker均尚无GC。该worker/T3e不能替代普通session/user purge或完整全域tenant completion。
