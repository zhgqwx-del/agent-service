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
scripts/local-service.sh stop        # 只停应用，保留 MySQL/Redis
scripts/local-service.sh down        # 停应用和本地基础设施
```

验证入口：

```bash
scripts/local-service.sh verify       # secret/API drift/typecheck + 集成/coverage + 0007→0011 历史迁移 + lifecycle 专项 + cluster + SDK/应用构建产物
scripts/local-service.sh verify-real  # 使用本机 .env，仅跑真实模型 E2E
pnpm test:migrations                  # 独立真实 MySQL：固定 0007→0008→0009→0010→0011 历史升级
pnpm test:blob-mysql                  # 强制执行并验明 Blob ownership/绑定/cleanup 的独立真实 MySQL 套件
pnpm test:usage-lifecycle-mysql       # 强制执行 usage 双写/reconcile/anonymize 的独立真实 MySQL 套件
pnpm test:subject-lifecycle-mysql     # 强制执行 subject gate/erasure request 的独立真实 MySQL 套件
pnpm check:api                        # OpenAPI、运行时文档与生成 SDK 类型必须完全同步
pnpm check:sdk                        # 编译 SDK、原生 Node import，并检查发布 tarball
```

状态文件和日志写入 `.local-run/`，该目录不提交。`stop` 只发送 SIGTERM，让 runner drain；30 秒仍未退出时脚本会报错并保留现场，不会擅自 SIGKILL。

## 模块边界

- `agent-router`：无业务状态，可独立扩缩容。需要能访问全部 runner 的 `RUNNER_ADDR` 和共享 Redis。
- `agent-runner`：每个实例必须有全局唯一 `RUNNER_ID`，并发布其它 router/runner 可访问的 `RUNNER_ADDR`；terminal-event dispatcher 与 Blob cleanup worker 都内嵌于 runner，不新增第三个应用服务。
- MySQL：业务真相、事件、审批、配置、operational usage ledger、去身份化 billing facts/reconciliation、subject lifecycle/erasure request/audit、Blob ownership manifest 和两个独立 outbox。生产迁移应作为独立 Job 执行，不能依赖所有 runner 同时自动迁移。
- Redis：租约、fence counter、owner 目录和事件扇出。生产环境必须启用满足恢复目标的持久化/高可用方案，不能把它当可随意清空的缓存。
- BlobStore：本地 filesystem adapter 已接入输入图片 item 与大工具输出；key 采用跨平台无大小写歧义的小写 grammar，新写入使用版本化 storage format，数据与 metadata 以覆盖 header/长度/正文的 SHA-256 单 envelope 原子发布，目录/文件权限为 0700/0600，并可过渡读取/删除安全 key 范围内的旧 raw + sidecar 格式。业务行只保存 owner-scoped opaque `blobId`，`0010` 的 manifest 私有保存 backend/key/token/integrity；`staging → ready` 与 item commit 原子绑定，过期未绑定 staging 经专用 outbox/claim lease 物理删除。该 root 必须由服务独占，当前也没有验证或承诺多 runner/NFS 共享语义；Node 没有可移植的 `openat/O_NOFOLLOW`，不能抵御有权同时替换目录项的恶意本机进程，本地原子发布也不等同于断电持久性承诺。ready Blob 的 erasure/物理 purge 尚未开启，生产必须先替换为共享 OSS/S3 adapter。

## 环境配置原则

本地源码进程、CI 候选镜像和未来部署镜像遵循同一套环境变量契约，不把环境地址或密钥写进构建产物。当前 local 默认运行源码进程；CI 会临时构建并启动两个 OCI 候选镜像，但尚未上传 registry。staging/production 就绪后，各应用才按下述目标 promotion 契约使用同一 digest。

Runner 必需配置：

- `STORE=mysql`、`MYSQL_URL`、`REDIS_URL`
- `SECRETS_MASTER_KEY`（后续替换为 KMS/envelope encryption）
- `RUNNER_ID`：全局唯一，Kubernetes 可用 Pod UID/名称
- `RUNNER_ADDR`：集群内可路由地址，不能是 `0.0.0.0`
- `INTERNAL_ROUTER_TOKEN`：router→runner 内部破坏性路由的共享凭证；production 必填，必须从 Secret 注入并与 router 完全一致
- `MAX_BODY_BYTES`：必须与 router 使用相同值；默认 1 MB，由 router 先拒绝超限请求
- `LIFECYCLE_OUTBOX_*`：runner 内置 terminal-event dispatcher 的 poll、claim lease、批量和退避边界；该 dispatcher 只处理 `session.tombstoned`，不是 purge worker
- `DATA_ERASURE_REQUESTS_ENABLED`：user erasure request/status capability 开关，默认 `0`。runner 只有在该开关为 `1` 且 store 支持 subject lifecycle 时才声明 capability；当前 request 只进入 `gated`，没有后台 worker 推进状态
- `BLOB_DIR`：当前 filesystem adapter 的服务独占 root；本地脚本默认 `.local-run/blobs`，多 runner/NFS 语义未受支持，不能复制充当生产对象存储
- `BLOB_FILESYSTEM_SINGLE_RUNNER`：filesystem 模式的显式安全确认；write 或 cleanup 任一启用时都必须为 `1`。它只表示操作者承诺恰好一个 runner 独占该 root，不提供分布式互斥
- `BLOB_CLEANUP_ENABLED`：stale staging cleanup worker 开关；本地默认 `1`。当前 filesystem adapter 在 production 即使 cleanup-only 也会拒绝启动，防止任一 runner领取全局 outbox 后误删/漏删本机之外的数据
- `BLOB_ATTACHMENTS_ENABLED`：新 Blob 上传和大工具输出卸载的 writer gate；依赖 cleanup 已开启，本地默认 `1`；当前 filesystem adapter 在 production 会拒绝启动
- `BLOB_MAX_BYTES`、`BLOB_MAX_HYDRATED_BYTES`、`BLOB_TOOL_OUTPUT_THRESHOLD_BYTES`、`BLOB_STAGING_TTL_MS`：单对象、模型上下文水合、工具输出卸载和未绑定 staging 保留边界；`BLOB_MAX_BYTES` 不得超过 `MAX_BODY_BYTES`
- `BLOB_CLEANUP_*`：专用 Blob delete outbox worker 的 poll、claim lease、批量、退避和确定性 poison 上限；普通短暂故障不会因达到 poison 上限而丢弃
- 首次生产初始化使用受控的一次性管理流程；`BOOTSTRAP_API_KEY` 仅限 local/test

Router 必需配置：

- `RUNNERS`：每个 runner 实例稳定、可达的 base URL 列表；不能填会在同一 URL 后随机选择多个版本 Pod 的普通负载均衡 Service，服务发现必须展开为实例地址
- `REDIS_URL`：与 runner 相同的逻辑 Redis 集群
- `INTERNAL_ROUTER_TOKEN`：与全部 runner 完全一致的共享凭证；router 会剥离客户端伪造的同名 header，仅在版本化内部 tombstone 请求上重新注入
- `SESSION_TOMBSTONE_ENABLED`：显式 expand→activate 开关；local 脚本默认 `1`，staging/production 发布时默认保持 `0`，且 router 仍会要求全部健康 runner 声明 `tombstone`
- `DATA_ERASURE_REQUESTS_ENABLED`：user erasure writer gate，local/staging/production 默认都是 `0`。POST 还要求 `RUNNERS` 中全部 configured targets 均已健康探测并声明 capability，且选中 target 仍支持；暂时不可达的已配置实例也会阻断激活。状态 GET 不依赖这个 router writer gate，继续按当前 healthy fleet/selected target capability 规则 fail-closed；writer gate 开启时，所有 user-scoped runtime 每次转发都复核 selected target capability
- `BLOB_FILESYSTEM_SINGLE_RUNNER`：当前 local router 与 runner 一致设为 `1`；只用于单 runner filesystem 拓扑，router 会强制 `RUNNERS` 去重后恰好一个地址，不能带入多实例环境
- `BLOB_ATTACHMENTS_ENABLED`：新 Blob 上传的独立 gate；local 默认 `1`，router 还要求全部健康 runner 声明 `blobAttachments`。当前 production filesystem 配置禁止开启
- `BLOB_MAX_BYTES`：只约束 raw Blob upload，必须与 runner 一致并且不大于双方的 `MAX_BODY_BYTES`
- `MAX_BODY_BYTES`：必须与 runner 相同，避免上游断开被误报成 502
- 网关/LB 必须关闭 SSE buffering，并把空闲超时设置得高于 SSE heartbeat

## 预发/生产资源就绪后的交付顺序

1. 建立独立的 staging MySQL、Redis、共享对象存储、Secret/KMS 和网络访问策略。
2. 独立执行并验证数据库迁移、备份与回滚演练。
3. 部署两个 runner，确认唯一身份、readiness 和 graceful drain。
4. 部署 router，经 router 跑 session、SSE turn、断线重放和接管测试。
5. 接入真实 IdP、日志、指标和告警后再开放预发流量。
6. 生产环境重复同一流程，不复用 staging 的数据库、Redis、密钥或 service key。

目标日常交付采用同一条 promotion 链：本地开发与 `verify` → CI 全部门禁 → 构建一次不可变镜像 → 按同一 image digest 部署 staging → 预发验收 → 同一 digest 灰度到 production。staging 与 production 不重新构建镜像，也不共享数据库、Redis、对象存储、密钥或 service key；环境差异只来自受控配置和 Secret。当前 CI 只以 `load: true` 临时构建并启动候选镜像，没有 registry push、签名、持久 digest 或 promotion job；这些仍是 M4/云资源就绪后的交付缺口。

tombstone 是 protocol family `2026-10-08` 内的 additive capability；它没有为这次扩展提升 exact protocol version。router 不把 DELETE 发到旧公开路径，而是改写成带内部 token 的版本化 POST，并要求新 runner 回 ACK；即使错误地把共享 LB URL 配成 target 且探测/请求落到不同 Pod，旧 runner 也只会 404，不会执行旧删除语义。正确拓扑仍要求 `RUNNERS` 一项对应一个稳定实例。安全 rollout 顺序是：先在 API gateway 暂停精确 session DELETE（或把流量整体切到新 router 池）→ 发布新 router 且保持 `SESSION_TOMBSTONE_ENABLED=0` → 排空全部旧 router → 滚动新 runner → 核对配置中的每个健康 runner 都声明 `tombstone` → 将新 router 的 gate 设为 `1`。显式 gate、内部 token 与 router 的全健康 fleet capability 检查必须同时满足；升级窗口中其它 API 可继续提供，DELETE 返回可重试 `503 draining`。仅逐个替换 router 而不先阻断旧 router 的 DELETE 并不安全，因为旧进程没有这个 gate；runner 端口也必须通过网络策略保持内网不可直连。

Blob 写入未来采用 expand→activate：先应用 expand-only `0010`，接入共享对象存储 adapter 后，让新 runner 以共享 reader/cleanup 开、writer 关的状态上线，发布 writer gate 关闭的新 router，确认全部健康 runner 支持 `blobAttachments` 且共享数据面可读写，最后才激活 writer gate。当前仓库只有 filesystem adapter，production 对 write 和 cleanup 都 fail closed，因此这套 rollout 还不是可执行的云部署步骤；不能把各 VM 本地目录、各 Pod 独立 volume 或手工文件复制当成共享数据面。

user erasure 最终同样采用 expand→activate，但当前只允许本地对可丢弃 user 体验：`gated` 尚不会撤销既有 SSE 或跨 runner abort/drain active provider/tool，因此 staging/production 必须保持 `DATA_ERASURE_REQUESTS_ENABLED=0`，直到 erasure worker 与对应测试完成。未来激活顺序是先独立应用 expand-only `0011`，发布 gate `0` 的新 router/runner 并排空旧实例，再在 runner 侧开启开关，确认 `RUNNERS` 中每个 configured target 都已通过健康探测并声明 `dataErasureRequests`，最后才开启 router writer gate。POST 只有在 router gate、configured fleet 全员健康且具备 capability、选中 target capability 同时满足时可写；暂时不可达的已配置旧实例不会被误当成已排空。GET status 不依赖 router writer gate，仍要求当前 healthy fleet 与选中 target 支持 capability，所以 healthy fleet 混合旧 runner 的窗口会 fail-closed 返回 503，而不是随机落到旧实例得到 404；GET 不承担 POST 的全 configured-fleet 激活判定。需要紧急停止新请求但保留查询时，只关闭 router gate 并保持 runner gate 开启；本地脚本使用同一个环境变量同时配置 router/runner，若将它整体改为 `0` 并重启，两端 capability 都会关闭，状态查询也会按设计返回 503。

erasure 的回滚边界以“首次请求已接受”为分界：关闭 router writer gate 只停止新的 erasure POST，绝不会撤销已持久化的 subject gate。writer gate 保持 `1` 时，router 会对 `/v1/sessions*`、`/v1/usage` 与 erasure 路径逐次检查 selected target capability，能力回退即返回可重试 `503` 而不转发；gate=`0` 的 expand mixed window 仍可提供普通 runtime。首次接受后必须保持所有处理 user 请求的 runner 都 lifecycle-aware，并优先 forward-fix；不能把业务流量回退给 pre-`0011` 或其它不检查 `subject_lifecycle` 的 runner，否则已 gated subject 可能重新可见并产生新写入。若事故处置确实必须恢复这类旧版本，必须先在 edge 精确阻断受影响的 tenant/user；若 edge 无法可靠识别 subject，则先阻断全部 user-scoped runtime 流量，再恢复旧应用。`0011` schema、erasure request/audit 与 subject gate 必须保留，不能用 down migration、关闭 feature flag 或回滚镜像把它们当作已撤销。

轮换 `INTERNAL_ROUTER_TOKEN` 时先把 tombstone gate 设为 `0`，在 DELETE 被拒绝期间依次让全部 runner 和 router 收敛到新值，核对健康与 capability 后再恢复 gate；当前不支持双 token 重叠窗口。不得把该 token 写入镜像、Git、日志或公开 API 文档。

未来真正改变 protocol version 的不兼容 contract 仍由健康探测隔离：版本不匹配的 runner 不进入 hash ring，也不能通过 owner 重路由；这类升级需要全量 drain 的维护窗口或将旧/新 router+runner 整组 blue-green，除非另行实现 version range/按版本路由。`session/deleted` 本身不属于这类版本提升。

当前自动验证的候选发布物是两个独立的 Linux OCI 镜像：`agent-router` 与 `agent-runner` 分别构建和启动检查，未来可以位于不同虚拟机或容器节点；当前 workflow 不上传它们。“不可变镜像”指未来发布到 registry 后由 digest 唯一确定，进入 staging/production 时不再重新编译或修改；不是 Windows/Linux 的虚拟机磁盘镜像。

`pnpm build` 同时会为 router/runner 生成各自的单文件 ESM JavaScript bundle，可在装有 Node 24 和对应 production dependencies 的 Linux、macOS 或 Windows 主机运行，但它不是原生机器码二进制。目前 CI 对容器镜像和原生 Node bundle 都有启动门禁；生产默认推荐 OCI 镜像，因为依赖、Node 版本和文件布局也被一起冻结。若未来明确采用裸 VM，再增加带校验和的 bundle + production `node_modules` 发布包和 systemd 服务，不需要把两个服务合成一个二进制。

“本地完整”指当前已实现的 M1/M2 主链路可在真实 MySQL + Redis + 单 router + 单 runner 下运行，并可用假厂商做无费用日常回归、用显式 `.env` 门禁做真实模型验证。可逆 Archive v2、fenced tombstone、runner-wired terminal-event dispatcher、Blob ownership/上传绑定/大工具输出/stale staging cleanup、OpenAPI/SDK、默认关闭的 user erasure durable gate/request/status，以及 usage operational/billing 分层、reconcile/anonymize primitives 已纳入本地与 CI 门禁；未配置模型单价时 usage 会保留“成本未知”，不会伪造零成本。它不表示云依赖已经由本机替代，也不表示数据生命周期已经闭环：异步 export artifact/下载/TTL/删除、erasure worker 状态推进与完成证明、tenant erasure、key/provider/auth secret revocation、legacy generation `0` 补偿、默认关闭的 ready Blob/session 物理 purge、M3 扩展和 M4 生产化仍按各自里程碑推进。filesystem Blob 只证明单 runner 本地语义，不能外推成多 VM/Pod 的共享存储正确性。

当前 `MysqlSessionStore.connect()` 仍会自动执行迁移，适合 local/CI，但还不满足上文“生产迁移作为独立 Job”的目标。进入 staging 前必须拆出显式 migration 命令/Job，并让业务进程只做 schema 版本检查、禁止启动时自动 DDL；同时完成备份恢复与迁移失败后的人工审计/重试演练。

暂不生成绑定某一云厂商的 Kubernetes YAML/Helm values；待 namespace、域名、镜像仓库、Secret/KMS、MySQL/Redis 地址和资源配额明确后再生成，避免把临时假设固化进部署资产。

迁移 `0008_atomic_turn_writes.sql` 会为 completed receipt 增加请求 hash，并给 usage ledger 建业务唯一键。

迁移 `0009_session_tombstone_outbox.sql` 增加 nullable `purge_after_ms`、默认 `0` 的 `deletion_generation`、parent lifecycle index 和 durable lifecycle outbox。固定 0008 历史库的真实 MySQL 夹具验证旧 deleted row 保持 generation `0`，迁移可重入且不会伪造 cleanup intent。后续启用 purge 前必须通过可审计、幂等的补偿流程处理这些 legacy row。

迁移 `0010_blob_ownership.sql` 是 expand-only：新增大小写敏感的 `blob_objects` ownership manifest 和独立 `blob_delete_outbox`，不回填或改写既有 session/lifecycle 行，也不启用 ready Blob purge。固定 0009 历史库夹具通过真实 migration runner 证明历史 session/outbox 保留、迁移重入安全、identity collation 与唯一索引符合预期；CI 另有显式不得 skip 的真实 MySQL Blob lifecycle 套件，证明 item 绑定原子性、owner 隔离、rollback 和并发 claim，而不仅是 fresh-schema 建表成功。

迁移 `0011_erasure_and_usage_separation.sql` 也是 expand-only：为 `usage_ledger` 增加 nullable、大小写敏感的 opaque `usage_id` 及唯一索引，新增只含最小财务字段的 `billing_usage_facts`、`usage_reconciliations`，以及 `subject_lifecycle`、`erasure_requests`、`erasure_audit_events`。它不会给历史 usage 伪造 ID 或 billing fact，不执行 reconcile/anonymize/purge，也不会伪造 erasure request；新写入才事务双写 operational 与 billing 两层。restart-safe `AFTER INSERT sessions` trigger 会为迁移后仍存活的旧 writer 原子补 tenant/user lifecycle 行，重放只做 insert、不会覆盖 gate/legal hold；它不拦截旧 writer 对已有 session 的写入，所以不能替代升级 drain。固定 0010 历史库的真实 MySQL 夹具验证 DDL auto-commit 中断后可重跑收敛、错误形状 identity 索引可修复、大小写敏感约束、旧 writer post-migration insert 与 gate/hold 保留，且既有 usage/session/outbox/blob 原样保留。CI 的 usage/subject lifecycle 独立套件不得 skip，并由 suite report 明确证明实际执行，而不是只验证 fresh schema。

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

当前 DELETE 会原子提交 terminal `session/deleted`、单调 generation、`session.tombstoned` 与 `session.purge` 两条 durable intent；后者的 `available_at_ms` 保持 `NULL`。每个 runner 都启动 dispatcher，通过 claim lease/CAS、续租和有上限退避只投递前者；短暂存储/总线故障会持续重试，确定损坏的 envelope/event identity 才进入 dead-letter。语义是 at-least-once，重复发布用相同 event `seq`，订阅路径据此去重。dispatcher 不新增独立服务或镜像，也不会领取 purge。物理 purge、legacy generation `0` 补偿和 dead-letter 的管理端修复/重放/指标/告警尚未实现，terminal event 已投递不代表数据已清理。

Blob cleanup 使用另一张专用 outbox，只调度超过 TTL 仍未绑定的 `staging` 对象；worker claim 后会重新核对 manifest/backend/format/generation，物理 delete 成功后才把 manifest 标为 `deleted`。filesystem adapter 会先留下 key-scoped 的微小 cancellation fence，再删除临时和最终对象，确保迟到 writer 即使用不同 upload token 也不能在 outbox 完成后复活该 key。这个不含业务正文的 marker 当前不会 GC，长期高频 orphan 会累积小文件；Memory adapter 的等价集合也只随本地进程释放。未来共享对象存储 adapter 必须提供同等的条件发布/永久删除栅栏语义，并单独设计安全的 marker 回收。丢失 ACK 可安全重试同一 delete，短暂后端失败持续退避，只有确定性 identity/adapter 损坏达到 poison 上限才 dead-letter。worker 不会领取 `ready` Blob，因此不能替代 session erasure 或上述默认关闭的 purge 策略。
