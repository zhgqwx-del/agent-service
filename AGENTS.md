# agent-service 协作约定

## 开始前先读

1. `README.md`：运行方式、API 和当前里程碑摘要。
2. `docs/PROGRESS.md`：顶部当前快照和最后一节是进度事实来源。
3. `docs/design/00-architecture.md`：架构基线与 M0–M4 定义。
4. `docs/operations/local-and-deployment.md`：本地生命周期和未来部署契约。
5. `docs/design/04-data-lifecycle.md`：删除、归档、usage 与 Blob 生命周期的当前设计门禁。

`docs/review/` 与 `docs/research/` 是时间点快照；其中的旧测试数量、缺陷和“下一步”不能覆盖 `docs/PROGRESS.md` 的最新结论。

## 当前阶段

- M0 完成。
- M1 核心运行范围、OpenAPI 3.1 与生成 TypeScript SDK 已完成；完整数据生命周期仍未闭环。
- M2 的本地/CI 代码范围已完成并正式冻结；尚未正式进入 M3，云上部署不属于本次冻结范围。
- M3 的 MCP/skills/hooks 主体和 M4 的生产化主体尚未开始。
- session 创建与首事件原子化、`0007 -> ... -> 0030` 历史升级夹具、OpenAPI/SDK、Archive/tombstone/outbox、Blob ownership/业务接线、staging orphan 清理、legacy generation `0` 补偿、canonical retention policy / multi legal hold、非破坏性 purge-policy evaluator，以及异步 user export artifact/download/TTL 已收口。tenant-erasure T1/T2、T3a、T3b、非破坏性T3c/T3d、T3e本地执行/physical ACK、T3f本地数据库内容/控制投影清理和T3g session-scoped Redis状态清理均已有本地/CI实现；所有terminal receipt仍固定全域completion为false。
- `0026`增加default-dormant、versioned credential lifecycle inventory：每tenant coverage/gap、永久provider slot与tenant-auth CAS投影、immutable version、`external_credential`/`kms_key` target disposition与T3a inventory sidecar都不保存secret/config/header/URL/明文locator。active cutover后所有credential-bearing写必须以CAS双写ledger；provider删除重建不能复用generation。hot read、snapshot与T3a terminal replay均绑定真实source、slot/version时间、四类material bit及完整target集合。受信任的服务端provider写路径可把content-free identity保护为`executable_ref`；legacy或缺失真实source的target仍只能诚实写blocker，无对应material写`not_applicable`，不得伪造locator。
- `0029`增加default-dormant的external-credential target execution ledger、Memory/MySQL原子store、runner内嵌worker与router fresh fleet gate。migration不materialize、不解密、不联网；worker精确绑定terminal T3a inventory、0026 slot/version/target、claim lease、operation/evidence、ACK与write-once cutover，response-loss只允许exact replay。当前唯一adapter是显式`STORE=memory`的非生产fake；标准MySQL local-service会拒绝/清除该fake并固定runner/router两道0029 gate为`0`。真实provider adapter尚未实现，KMS target固定不可执行，terminal receipt固定`kmsKeyExecutionComplete=false`、`allDomainsComplete=false`、`contentPurgeExecuted=false`；它不新增服务、进程、bundle或镜像。
- `0030`增加default-dormant独立tenant restore journal、runtime lineage、永久恢复fence、Memory/MySQL原子store、runner内嵌publisher、router fresh fleet gate、S3-compatible adapter和runner镜像内一次性`restore-ledger-reconcile`入口。T1与publication queue/target同一原子边界；generation 1下create与exact replay在terminal publication receipt可读前返回可重试`503`，调用方必须以完全相同的tenant/body/idempotency key重试，T3a也在全部target ACK/receipt前fail closed。恢复必须停服，封存外部head、逐条重放fence、seal receipt后另行激活新epoch；`activate-journal`同时要求primary-activation与fleet-stopped ACK及显式Blob backend分离声明。CLI使用verify-only store、绝不执行DDL，0030 marker存在时还核对精确schema/39-trigger fingerprint；复合`run`不激活runtime并可按exact durable projection重放。S3 target identity绑定受控region与normalized custom endpoint或standard-endpoint模式。当前单target、跨MySQL/S3 saga、人工ACK、head-read到DB activation的TOCTOU、epoch ABA、逐页从chain起点重验造成的`O(n²)`对象读取，以及缺少whole-operation deadline仍是明确边界；同机MinIO不同bucket不是独立故障域，0030不创建backup。下一切片是`0031`权威backup catalog、snapshot lineage、retention与source digest绑定。
- `0027`增加default-dormant、write-once Blob storage control，并接入共享S3-compatible/MinIO adapter。S3对象使用同一key上的`ASBLOB02` data/tombstone envelope、`If-None-Match:*` create-only、`PutObject If-Match` CAS tombstone、response-loss重读和有界streaming；包括credential/endpoint provider解析在内的完整请求受同一外层deadline约束。runner启动时检查bucket可达、versioning从未启用、lifecycle配置不存在、Object Lock关闭和条件PUT语义，再把`BLOB_NAMESPACE_ID + bucket + prefix`的非密钥digest与MySQL generation 1精确绑定。activation会在一个Memory原子边界或MySQL事务中核对全部live manifest、未释放snapshot pin和所有未完成delete intent；dead-letter不等于完成。generation 1后filesystem回退或namespace漂移均fail closed。production的private-bucket ACK只是独立验证后的人工确认，不是应用自动证明；生产IAM还必须禁止外部writer覆盖对象或运行后添加lifecycle规则并监控控制面漂移。
- `0028`增加default-dormant的离线filesystem→S3迁移账本；schema migration本身不冻结、不搬bytes、不切指针。runner镜像内的一次性CLI才执行`prepare/copy/verify/cutover/abort/cleanup-source`，不是新daemon、服务或镜像。mutating operator由MySQL named lock串行化；每次target/source外部mutation还会持有migration-control行共享锁并在动作前后复核named-lock owner，替代operator必须等待并重放精确owner-fenced状态。runtime在`inactive/aborted/source_cleaned`之外一律拒绝启动，而且Blob control/adapter对账后会再次读取迁移control，关闭首次gate与cutover之间的竞态。普通generation-1 activation与freeze采用相同的migration-control→blob-control锁序；aborted attempt的target namespace永久不可复用。cutover前可abort，S3目标以exact owner/descriptor校验后CAS成永久migration tombstone；cutover后只能forward-fix并在DB-time delay满足后显式清理source。legacy raw+sidecar可由migration-only exact read搬迁，普通runtime仍只读envelope；物理发布后DB ACK丢失的staging写可在迁移后ownerless exact replay，目标owner marker保持不变。调用方显式mover环境变量（含空值与`AWS_*`）优先于`.env`且不得回显。当前实现会在进程内加载候选/inventory/ACK并使用大事务和全范围锁，尚无分页、dry-run、容量预算或operator HA，必须在staging压测。`verify-s3`必须同时通过真实adapter、真实MySQL+MinIO mover及源码应用装配，CI还会验证dist/runner-image中的mover artifact。
- `0023`与runner内嵌的T3e worker建立**本地受限执行/物理ACK切片**：在一个Memory原子边界或MySQL事务内重验T3c/T3d、DB time、canonical hold、owner闭包与live lease，把operational usage去身份化为已核对billing事实，撤销user export并清除download lease、释放snapshot pin，再为Blob/export bytes写入精确delete outbox；只有对应cleanup worker实际完成同一outbox identity后才seal physical ACK。
- `0024`与runner内嵌的T3f worker再从terminal T3e receipt materialize独立queue；它在一个Memory原子发布或MySQL显式RR事务中固定11域pre-delete catalog，清除tenant profile敏感投影、agent/session/turn/item/event/approval、idempotency、usage reconciliation、Blob/lifecycle/export投影，保留并重算匿名billing facts，写永久全局session grave、exact ACK、terminal receipt/job和write-once cutover。失败/lease丢失全回滚，response-loss只允许精确authorization replay；grave的owner读取仍按tenant隔离。`ownerSha256`是与删除同事务捕获、由append-only/最小权限保护的opaque claim，不是可脱离owner tuple独立重算的T3c上游证明。
- `0025`与runner内嵌的T3g worker从terminal T3f receipt及固定T3d plan建立精确session target/ACK链，只清理`redis_leases`（含lease hash内owner目录）、`redis_fences`和`redis_streams`三域。真实Redis adapter以同一cluster hash slot的Lua预检并原子写入无TTL、无正文的永久purge marker，同时删除lease/fence/stream；runtime lease/owner/event路径都先检查marker，阻止被清理状态复活。Redis动作与MySQL证据不是一个分布式事务，而是用exact operation marker与response-loss replay收口的saga；同一MySQL中的durable restore projection只会在runner监听前和周期性重放**已有durable target ACK**的marker。未ACK target由worker开始轮询后先做existing-marker-only同slot原子replay：只有exact marker存在才按原bits再次删除三域并补写ACK/seal，marker缺失不创建或删除。0030已补独立T1 journal/fence replay，但仍不是完整backup authority。marker-only且MySQL ACK未提交时若Redis再丢marker，首次existence bits无法恢复；MySQL+Redis联合旧快照、large-tenant restore keyset容量、永久marker增长与普通live-session fence灾备也未闭环。当前真实Redis测试使用standalone ioredis，不等于真实Redis Cluster/ACL/persistence/failover验收。T3g terminal固定`redisPurgeComplete=true`、`allDomainsComplete=false`、`contentPurgeExecuted=false`。external provider/KMS、0031 backup catalog、logs/traces、managed对象存储/IAM真实环境验收、全域completion及generic user物理purge仍未闭环，所以M1仍未冻结，完成后再正式进入M3。
- T3e由runner的`TENANT_PURGE_EXECUTION_WORKER_ENABLED`与router的`TENANT_PURGE_EXECUTION_ENABLED`双重默认关闭gate保护；每次materialize、claim、lease边界及不可逆/physical-ACK边界都需要token-protected、fresh、non-sticky的all-configured fleet ACK。安全顺序是应用expand-only `0023` → 新router execution=`0`并排空旧router → 全量新runner worker=`0`且声明`local-execution-ack-v1` → 确认单runner filesystem契约或已激活且全fleet一致的S3 namespace，并开启cleanup/worker → 核对全部configured runner worker-active → 最后开启router gate。首个local cutover receipt激活write-once cutover后只能forward-fix；dead-letter不能伪装成physical success。
- T3f由runner的`TENANT_DATABASE_PURGE_WORKER_ENABLED`与router的`TENANT_DATABASE_PURGE_ENABLED`独立默认关闭gate保护，并要求全部configured runner同时声明旧`local-execution-ack-v1`、新`local-db-content-delete-v1`及T3f worker-active。旧router严格parser会拒绝新capability数组，安全顺序必须是`0024` → 新router gate=`0`并**完全排空旧router** → 全量新runner worker=`0` → 逐实例开启worker → 最后开启router gate；不能runner-first。每个materialize/claim/renew/destructive/replay边界重新取得fresh no-store ACK；首个cutover后只能forward-fix。
- T3g由runner的`TENANT_REDIS_PURGE_WORKER_ENABLED`与router的`TENANT_REDIS_PURGE_ENABLED`独立默认关闭gate保护，并要求所有configured runner声明`session-state-delete-v1`、worker-active且`REDIS_NAMESPACE_ID + REDIS_PREFIX`计算出的namespace digest完全一致。安全顺序是`0025` → 新marker-aware router gate=`0`并完全排空旧router → 全量新marker-aware runner worker=`0`并排空旧runner → 核对稳定直连地址/capability/namespace → 逐实例开启worker → 最后开启router gate。fresh no-store ACK只用于materialize和每一次新的Redis mutation；mutation前必须`gate → renew claim → gate`。worker lease至少是barrier timeout的两倍再加1秒，且第二次proof后续租耗时超过lease一半就fail closed。claim、existing-marker-only atomic replay、持久化或精确重放ACK、已有durable ACK的restore及全ACK seal均不再取destructive gate；existing-marker replay只有在exact marker存在时才按原bits再次删除三域，marker缺失不创建或删除。这样router gate关闭后也能收口marker-only窗口。首个marker/ACK/cutover后只能forward-fix；router gate可暂停新materialize/mutation，但worker必须保持开启以完成existing-marker replay/ACK/seal和durable restore，不得更换namespace identity或回退到marker-unaware runtime。
- evaluator 的 `eligible_execution_disabled` 仍只是候选证据，不是删除许可；其旧target/deadline与`0021` T3c inventory是两类不同证据。`0023` T3e、`0024` T3f与`0025` T3g只在各自本地受限动作边界重验完整上游proof；后续全域executor仍须重验外部、备份/独立恢复、日志/追踪与completion ACK，不能把`session_content_receipts`或任一aggregate receipt直接当成全域删除许可。completion固定为`false`。
- 通用 erasure transition 类型与实现都不能表达 `purging/completed` 或 caller-supplied completion proof；lifecycle outbox 的 claim/renew/complete/retry 只接受 `session.tombstoned`，即使旧版或异常进程曾给 `session.purge` 写入 claim token，也不能经通用 ACK 面续租、完成或重试。
- `DATA_ERASURE_REQUESTS_ENABLED` 在 runner/router 默认 `0`，只控制新 request admission；`ERASURE_WORKER_ENABLED` 与它独立，本地默认 `1`，使已持久化 job 即使关闭 admission 也继续走到安全策略边界。POST 需要 router gate、全部 configured targets 健康且支持；status GET 不依赖 router writer gate，但仍按 healthy fleet/selected target capability fail-closed。任一 request 首次接受后，关闭 gate 不能撤销 durable subject gate，也不能回退到 pre-`0011`/lifecycle-unaware runner；必须 forward-fix。不得把 `awaiting_purge_policy` 描述为擦除完成，也不得擅自启用 tenant erasure、usage anonymize 或不可逆 purge。
- tenant erasure与上述user erasure开关无关。`TENANT_ERASURE_REQUESTS_ENABLED`默认`0`并在runner/router双端独立门控；`TENANT_ERASURE_OPERATOR_TOKEN`只允许注入router，不能传给runner。T3a执行另由runner的`TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED`与router的`TENANT_CREDENTIAL_REVOCATION_EXECUTION_ENABLED`独立、默认关闭门控。`0026`安全顺序是先迁移并保持`CREDENTIAL_LIFECYCLE_TRACKING_ENABLED=0` → 部署全部ledger-aware router/runner并彻底排空旧writer → 核对configured fleet的`versioned-target-ledger-v1` → 显式启用runner tracking完成一次性cutover → 确认全fleet观察active → 开启router tracking gate → 沿用`0019`逐runner开启worker并核对barrier → 最后开放T3a execution。每次接触queue及紧邻不可逆事务前都需fresh barrier。tracking或首个T3a receipt任一cutover提交后都只能forward-fix。该gate不授权external/KMS、content purge或completion。
- T3b另由runner的`TENANT_RUNTIME_DRAIN_ENABLED`、`TENANT_RUNTIME_REVOCATION_WORKER_ENABLED`与router的`TENANT_RUNTIME_DRAIN_EXECUTION_ENABLED`三道默认关闭gate保护。先应用`0020`，再发布execution=0的新router并排空旧router，滚动endpoint/worker=0且具有稳定`RUNNER_ID`的新runner，逐实例开启endpoint并核对`RUNNERS`中的稳定直连origin与runner/boot identity，再开启worker，最后开启router execution。任何target失败均不得写聚合proof；但部分target可能已被fence，必须forward-fix并精确重试。不得把LB别名当作configured target，也不得把本地引用清理receipt描述为内存清零、外部撤销或content purge。
- T3c由runner的`TENANT_CONTENT_INVENTORY_WORKER_ENABLED`独立默认关闭gate保护，不需要router执行端点，因为其store接口没有删除/匿名化能力。安全顺序是`0021` expand-only migration → 全量新runner worker=0 → 核对严格schema/index/CHECK/trigger fingerprint、append-only guards与新binary → 逐实例开worker。roots绑定identity、状态和关系拓扑；只有`contextCompaction`允许synthetic turn，approval canonical边固定为`approvalRequest.approvalId → Approval.id`并兼容legacy `Approval.itemId`。DB clock低于source/anchor/evidence high-water时只能重试；page/seal在receipt INSERT后重验live lease，跨lease等待必须整事务回滚。queued未claim要求`availableAtMs >= updatedAtMs`，已claim要求`leaseUntilMs >= updatedAtMs`。关闭gate只暂停新claim，不删除job/receipt；一旦存在`0021` evidence只能forward-fix，不得回退到忽略它的旧binary。
- T3d由runner的`TENANT_PURGE_PLAN_WORKER_ENABLED`独立默认关闭gate保护，也没有router执行端点。先应用expand-only、execution-dormant的`0022`，全量新runner保持worker=`0`，核对精确schema/index/CHECK/trigger fingerprint与append-only guards后再逐实例开启。固定33域不能因adapter缺失而省略；Blob/export bytes、Redis、backup、restore、logs/traces以及无法恢复legacy locator的external provider/KMS必须形成显式blocker。新plan按0026精确target disposition把真实external `executable_ref`记为可撤销，legacy/source blocker继续阻断，KMS仍全部阻断；历史pre-0026 sealed plan继续按冻结的粗粒度T3a证据校验。生产worker对新空plan直接seal，Memory单一原子边界/MySQL单个RR事务一次写33条entry、aggregate和terminal job；buildPage只保留诊断/兼容路径。seal必须重验source、canonical tenant/user hold、全局孤儿与owner闭包、post-write lease；MySQL以full-range锁关闭idempotency/usage/reconciliation phantom窗口。legacy completed idempotency `{turnId}`仍可由turn反查session；subject lifecycle必须与user request或tenant admission双向闭合；purge target必须精确匹配session tombstone generation/time。tenant T1后仍可合法保留的queued、generation `0` export必须计入plan，不能误判为已撤销或因falsy值漏掉；download lease raw token只能以domain-separated hash进入证据。`planComplete`只表示目录、数量、root和disposition完整，不表示可执行；store/worker没有delete/anonymize/revoke/completion方法。
- T3d剩余P3/运维风险：当前全库RR/next-key owner扫描是local/CI正确性基线，可能带来跨tenant写阻塞、死锁、lease与容量压力，须在staging验证索引/容量/锁超时。结构损坏的queued purge-plan job可能在逐候选隔离前解析失败并饿死后续job，cursor重启还会重扫损坏前缀；该路径fail-closed且不产生receipt/执行权，M4应增加raw-key quarantine/skip。`0022` trigger fingerprint绑定集合与元数据但不校验action body，迁移夹具只显式模拟第一个DDL auto-commit边界；两者属特权schema tamper/测试深度残余，不是当前删除authority。
- T3f剩余非阻断风险：grave `ownerSha256`是事务内捕获的opaque claim，不能只靠不含`userId`的T3c receipt离线重算；`0023→0024`夹具未逐一故障注入45个trigger rotation的每个auto-commit点；真实N-1 router/runner mixed-rollout canary仍待staging。MySQL T3f为保护首次cutover会在整个destructive事务持有全局cutover行锁，当前会串行化跨tenant删除，须在M4/staging验证容量、锁等待、死锁与lease并优化。上述路径均fail closed，不改变全局session-ID grave fence或授予错误删除authority。
- T3c剩余P3运维风险：结构损坏的`tenant_content_inventory_jobs` envelope可能在claim-bound隔离前解析失败，反复终止poll并饿死后续健康job。该路径fail-closed，不会产生receipt或purge authority，但当前需要人工数据库维护；M4应增加不信任损坏字段的raw-key quarantine/skip。materializer cursor重启后会重扫损坏前缀；seal全库RR/next-key扫描也仍需owner索引/FK/分区与容量、写阻塞验证。
- `DATA_GOVERNANCE_MANAGEMENT_ENABLED` 在 runner/router 默认 `0`。`dataGovernance` 表示 writer代码理解 policy/hold，`dataGovernanceManagement` 才表示管理端点已开启；两者不能混用。管理 API只允许 admin service key，所有响应 no-store；activation 提交即生效，不支持把 runner wall clock当作未来调度器。首次 policy activation或canonical hold event后不得回退pre-`0015` writer，只能forward-fix。
- erasure POST/status 的所有成功与错误响应必须保持 `Cache-Control: no-store`；usage 的公开 `costCNY` 只表示完整总成本，mixed known/unknown 不得返回已知小计，硬成本上限不得把 unknown 当作 `0`。已完成的 anonymize 重试可在后来出现 legal hold 时幂等返回，但 hold 必须阻止尚未发生的 `verified -> anonymized` 转换。
- 长期 billing fact 不得保留 user/session/turn/step/raw JSON 或精确请求/reconcile 时间；精确验证时间只属于 owner-scoped reconciliation。usage row 与 session owner 不一致必须在查询中隐藏、在 reconcile/anonymize 中事务性 fail-closed，不能静默漏账或跨 tenant 聚合。
- `gated` 隐藏该 subject 的普通资源并阻止 durable 写入；worker 的 draining/tombstoning 使用 claim-bound 私有 `drain-v1` 路径和固定 store actions，不可携带正文、usage 或任意 patch。active provider/tool 会被有界 abort；超时后保留 session lease 到期而非立即与新 owner 重叠。成功后现有 SSE 通过 terminal event 收口，但内容、ready Blob、receipt 和 operational usage 仍保留到后续 policy-gated purge。当前只在本地对可丢弃 user 显式体验，staging/production 保持 admission 关闭。
- `0013` quarantine 不等于普通 `blocked`：安全envelope的公开status只映射为`blocked`，不能泄露reason/evidence/control generation；运维必须经独立maintenance store检查，并只执行返回的固定action。unsafe-envelope terminal incident没有owner推断、公开读取或repair权限。`control_audit_invalid` 没有自动 repair action，不能直接改表、补造主 audit 或把任意 hash 当成验证证明。control generation 达到或超过 JS safe-integer 上限时会保留原始 MySQL BIGINT fence、清除 worker authority并进入无 repair、无后继 control-event 槽位的 terminal quarantine；这是 fence 耗尽/库级损坏的显式例外，不能回退或归一化原值。任何 control event或terminal incident写入后都不得回退到 pre-`0013` reader/worker，只能 forward-fix。
- 两个 erasure worker 每次接触 durable queue 前都要从 router 的私有、token-protected v2 barrier获得固定 ACK；router 必须先在本进程成功观察 `RUNNERS` 中每个稳定地址同时支持 `quarantine-v1` 与 `legacy-tombstone-compensation-v1`。旧 v1 endpoint固定404。观察后纯网络不可达会保留进程内attestation；明确旧版/错误协议/畸形capability会撤销，router重启会安全暂停claim直至重新观察。`0014` cutover一旦激活就不得回退pre-0014 writer，只能forward-fix；barrier不能替代旧进程drain和网络/权限隔离。
- tombstone 已原子写入 marker、terminal `session/deleted`、单调 generation、即时 `session.tombstoned` intent 和不可领取的 `session.purge` intent；普通资源隐藏且 parent/child 竞态受保护。每个 runner 内置的 dispatcher 只处理 `session.tombstoned`，通过 claim lease/CAS 和有上限退避按 at-least-once 语义投递；短暂故障无限重试，确定损坏的 intent 才 dead-letter，event `seq` 是重复身份。它不会领取或执行物理 purge。
- tombstone 保持在 protocol family `2026-10-08` 内，以 additive capability 协商。router 还要求显式 `SESSION_TOMBSTONE_ENABLED=1` 和全部健康 runner 支持该 capability；外部 DELETE 只会改写为带内部 token、要求 ACK 的版本化 runner-only POST，不会回退到旧公开 DELETE。`RUNNERS` 必须使用实例稳定地址。发布前先由 edge 暂停精确 session DELETE（或整体切换 router 池），再按新 router（gate=0）→ 排空旧 router → 滚动新 runner → 核对 fleet → 激活 gate 的顺序执行，旧 router 自身没有该 gate。未来真正不兼容的 protocol 变更仍需维护窗口或整组 blue-green。
- BlobStore 的跨平台 key、防损坏单-envelope 原子发布、旧安全格式读取/删除、私有权限、静态 symlink 防护和 memory 复制语义已有测试。`0010`、Memory/MySQL ownership manifest、图片/大工具输出接线、staging→ready 原子绑定、独立 Blob outbox/worker、硬 TTL、并发 claim、key-scoped delete fence 和 stale staging 清理已实现；工具结果有独立持久化硬上限，序列化/超限/adapter 写失败在 current/replay 中使用同一无 locator 的稳定结果，单次请求共享完整 data URL 水合预算，compaction 不会跨过未物化的外置工具事实。历史图片像素目前不会跨 compaction 保留。`0027`的S3-compatible adapter已覆盖共享namespace、条件写、同key tombstone、跨client可见性和真实MinIO；`0028`已覆盖existing-filesystem bytes的本地/CI离线搬迁和旧raw+sidecar清理。filesystem root仍必须由单一runner独占并显式设置`BLOB_FILESYSTEM_SINGLE_RUNNER=1`，不承诺断电持久性且production继续fail-closed。managed bucket/IAM/KMS、容量/failover和真实维护窗口仍需实际环境验收，不能宣称全域最终删除已闭环。
- user export 仅允许 admin service key + 明确 user + `Idempotency-Key`，且 active policy 必须有正值 `exportArtifactTtlMs`。公开状态只在 ready 时返回 hash/size/TTL；snapshot/artifact/download/delete 全链路按 tenant/user 和 generation 隔离。worker 是 runner 内部循环，不是第三个服务；filesystem 制品只支持本地单 runner，S3 mode已支持共享runner，但production启用前仍须独立验证private bucket、IAM、网络、容量与故障恢复，且private-bucket ACK不能代替该验收。

- T3d全局orphan/cross-owner损坏会安全地把当前claim终结为`blocked`，但修复底层数据后也没有自动resume/rebuild；该路径不产生执行权，但可永久阻塞该tenant，后续需设计受审计的operator repair/resume协议。

- T3d owner closure还要求Memory中每个export request、user erasure request和tenant admission都有精确双向idempotency索引；Memory/MySQL的legacy compensation deterministic `jobId`必须绑定精确session owner/tombstone generation/time。MySQL还要重算`candidateSha256`并校验`sourceLastSeq`；`erasure_claim`精确绑定request/generation，status精确对应单个audit/result，completed event seq等于`session.lastSeq`且success evidence完整。任一不闭合都fail closed且atomic seal无部分发布。

## 工作边界

- 当前先保证本机和 CI 可重复运行。staging/production 的 Kubernetes、云资源和拓扑要等用户提供真实参数后再生成。
- 本机 `.env` 可用于用户明确允许的本地验证；不得提交、打印或写入文档/日志。
- 修改前检查工作树并保留用户已有改动。完成后按风险运行相应测试，并同步 `README.md` / `docs/PROGRESS.md`。

常用入口：

```bash
scripts/local-service.sh verify
pnpm check:api
pnpm check:sdk
pnpm test:migrations
pnpm test:blob-storage-control-memory
pnpm test:blob-storage-control-mysql
pnpm test:blob-storage-migration-mysql-s3
pnpm check:blob-storage-migrate-artifact
scripts/local-service.sh verify-s3
pnpm test:usage-lifecycle-mysql
pnpm test:subject-lifecycle-mysql
pnpm test:tenant-credential-revocation-mysql
pnpm test:tenant-credential-physical-revocation-mysql
pnpm test:tenant-credential-lifecycle-mysql
pnpm test:tenant-credential-target-execution-mysql
pnpm test:tenant-restore-journal-memory
pnpm test:tenant-restore-journal-mysql
pnpm test:restore-journal-s3
pnpm check:restore-ledger-reconcile-artifact
pnpm test:tenant-runtime-revocation-mysql
pnpm test:tenant-content-inventory-mysql
pnpm test:tenant-purge-plan-mysql
pnpm test:tenant-purge-execution-mysql
pnpm test:tenant-database-purge-memory
pnpm test:tenant-database-purge-mysql
pnpm test:tenant-redis-purge-memory
pnpm test:tenant-redis-purge-mysql
pnpm test:tenant-redis-purge-redis
pnpm test:tenant-redis-purge-cluster
pnpm test:retention-policy-mysql
pnpm test:erasure-purge-policy-mysql
pnpm test:erasure-job-mysql
pnpm test:erasure-session-mysql
pnpm test:erasure-catalog-mysql
pnpm test:erasure-usage-mysql
pnpm test:legacy-tombstone-mysql
pnpm test:user-data-export-mysql
scripts/local-service.sh verify-real
scripts/local-service.sh acceptance
```
