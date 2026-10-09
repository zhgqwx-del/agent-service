# 数据生命周期设计

> 状态：**Archive v2、fenced tombstone、reliable terminal-event outbox、Blob ownership/业务接线与 staging orphan 清理、usage 财务分层、durable user-erasure、`0013` quarantine/control、`0014` legacy compensation、`0015` policy/hold、`0016`非破坏性purge authority、`0017`异步user-export artifact/download/TTL、tenant-erasure T1/T2、`0019` T3a本地数据库credential-store物理清除，以及`0020` T3b configured-fleet runtime/cache/active-I/O drain均已实现；ready/session内容purge与完整tenant erasure仍未启用**（2026-10-09）。T3b只证明每个精确configured runner丢弃本地引用并结算已跟踪I/O，明确不证明内存清零、外部撤销或content purge；公开status仍为`gated`。本文给出M1完整数据生命周期的实现契约和安全默认值；可信数据库时钟/owner-scan完整内容proof、restore replay和默认关闭的purge执行路径仍需继续实现。

## 1. 当前实现与缺口

当前 `archive/unarchive` 已通过 `SessionHost` 的同一 per-session 队列、Redis lease 与 MySQL fence 完成可逆状态转换；生命周期事件、session marker、授权和异常 pending approval 在一个 store commit 中提交。archived session 保持可读但统一拒绝 mutable runtime 操作；active turn、同 runner 并发、跨 runner takeover、历史 archived-active 行、Memory/MySQL 回滚和事件 seq 均有测试。获取新 lease 后会先用纯 `fenceClaim` 推进数据库 fence、再读取 orphan repair 快照，关闭 Redis→MySQL hand-off 期间旧 owner 仍可写的窗口。

`DELETE` 已通过 `SessionHost` 使用同一队列、lease/fence 和 orphan repair。Memory/MySQL 在一个原子 commit 中写入 tombstone marker、terminal `session/deleted`、连续 seq、单调 `deletion_generation`、立即可用的 `session.tombstoned` intent 和不可领取的 `session.purge` intent；`purge_after_ms` 安全默认为 `NULL`。普通 session/turn/item/approval/usage/receipt 随即隐藏且普通 commit 拒写，同 owner 重试幂等；已建立的 SSE 可收到 terminal event 后关闭。parent create/delete 行锁还保证并发时不会留下指向 tombstoned parent 的 child。

`BlobStore` 已有 memory 与本地文件实现；本地格式使用无大小写歧义的 key、带长度/校验和的单 envelope create-only 原子发布，并覆盖路径、权限、静态 symlink、损坏及并发测试，也可读取/删除安全 key 范围内的旧 raw + sidecar 格式。`0010` 增加 case-sensitive `blob_objects` ownership manifest 和独立 `blob_delete_outbox`；Memory/MySQL 都实现 staging/upload/原子 item 绑定、owner-scoped ready 读取、claim lease/CAS 删除与 stale staging 调度。用户图片以 opaque `blobId` 持久化，绑定前会校验声明 MIME 与文件签名，执行前还会检查所选模型的 image input 能力；大工具输出通过 `outputRef` 外置，当前 step 与重放使用同一份 JSON-safe 结果。历史按新到旧在总水化预算内读取 manifest 和对象，超出预算的旧图片/输出变成明确占位符；提交失败不会留下 ready manifest 或 item/event 半状态。当前 compaction 只保证 summary range 内的外置工具事实全部物化后才推进 watermark；历史图片在 planning/summary 投影中是文字占位，像素不会跨过 compaction 保留，未来必须增加视觉摘要/OCR 或等价策略后才能宣称多模态长期上下文无损。

runner 内置 Blob cleanup worker 目前只把过期 staging orphan 标记为 `delete_pending`，再以 at-least-once 语义物理删除并转为 `deleted`；ready/session blob 不会被该 sweeper 选中。filesystem delete 会先持久化 key-scoped cancellation fence，阻止任何迟到 writer 在 outbox ACK 后复活对象；该微小 marker 当前不做 GC，长期 churn 会累积 metadata 文件。filesystem root 仍必须由一个服务实例独占，且本地 hard-link 原子发布不代表断电持久性；因此本地单 runner 只有显式设置 `BLOB_FILESYSTEM_SINGLE_RUNNER=1` 才能开放写入或 cleanup。该设置是运维断言而非分布式锁；TTL、outbox claim 和重试边界目前比较 runner 传入的 wall-clock 毫秒，未来多 VM 部署必须约束并监控时钟偏差或改用共享数据库时间。`NODE_ENV=production` 下 Blob 写入和 cleanup 都会 fail-closed，直到实现具有等价条件发布/删除栅栏的共享 OSS/S3 适配器。session purge 与 ready blob 的原子 `delete_pending` 接线仍未完成，不能宣称附件或大输出已满足最终删除。

runner 启动时会同时启动 lifecycle outbox dispatcher。它只领取 `session.tombstoned`，重新读取 durable `session/deleted` 并校验 session、seq 与 generation，再发布到 event bus；claim lease/CAS 与有上限的指数退避使进程崩溃和暂时总线/存储失败可以持续恢复，不会因次数耗尽而永久停投。确定损坏的 envelope/event identity 会隔离到 dead-letter，且该 outbox 的 poison row不会阻塞后续 intent。投递是 at-least-once，丢失完成确认时允许重复发布同一 event `seq`，`SessionHost` 的订阅路径会按 seq 去重并补洞；这不是 exactly-once 承诺。

`0011_erasure_and_usage_separation.sql` 已增加 subject gate/request/audit 与 usage 财务分层；`0012_erasure_job_queue.sql` 以 expand-only 方式增加 availability、attempt、claim lease、bounded error 和 immutable policy identity；`0013_erasure_job_control.sql` 再增加 quarantine overlay、append-only `erasure_job_control_events`和`erasure_job_terminal_incidents`。Memory/MySQL 都实现 claim/renew/transition/retry queue、固定动作 session mutation 和不返回正文的 catalog。claim现在按候选独立提交：在request id、tenant/subject identity、正generation、claimable phase与created/gated/updated安全顺序仍可构成可信quarantine envelope时，request/subject/main-audit/idempotency/queue/control的确定性损坏会保留原phase、清除availability/claim/lease、写入canonical evidence和quarantine event，再继续扫描邻居；未知SQL/网络错误仍回滚当前候选，不会被误判为poison。若隔离坐标本身损坏，store在同一原子边界保留原request/identity/generation/timestamp与精确raw control fence，只清queue authority、写terminal overlay，并追加只含request locator、raw fence、固定reason、evidence SHA-256和时间的private incident；表不复制tenant/user/subject/status/raw payload且禁止UPDATE/DELETE。该路径不能安全owner-read或repair/resume，但不会猜测归属，也不会继续占据claim队首。另一个显式例外是 control generation 已达到或超过 JS safe-integer 上限：此时没有可表示的后继 event 槽位，但其余envelope仍可信，store 会用精确原始 MySQL BIGINT 生成 terminal evidence、保持该 fence 不降级、清除 worker authority并持久化为不可 repair 的 `control_audit_invalid` quarantine，而不是补造冲突 event 或让它反复占据队首。公开status只把可安全owner读取的quarantine映射成`blocked`，reason/evidence/control generation留在私有maintenance边界；repair/resume要求owner identity、subject generation、control generation与evidence CAS，并只允许reason对应的固定action。`control_audit_invalid` 与terminal incident都没有通用自动修复，不能靠直接改表或伪造主audit恢复worker authority。

runner 内嵌 worker 从 `gated` 逐 phase 推进：每次接触数据库claim前，先调用router的token-protected私有v2 barrier；router进程必须曾成功观察`RUNNERS`中每个稳定地址同时声明`erasureJobControl=["quarantine-v1","legacy-tombstone-compensation-v1"]`。已观察实例后来纯不可达时会保留本进程attestation，让存活worker仍可接管已死亡owner；明确旧版、缺少任一能力、错误protocol/service、404或畸形capability会撤销。attestation不持久化，router重启且某地址仍宕机会安全暂停claim，直到地址恢复或从配置移除；新request admission仍另外要求configured fleet当前全部健康。v1路径与ACK故意不再兼容，防止pre-0014 worker在补偿cutover期间继续claim。通过barrier后，worker经router的私有 `drain-v1` 控制面定位当前 owner，在 claim 与 session fence 同时验证后有界请求 abort active execution；若本地执行未在默认 10s 内停止，则不刷新也不主动释放其 session lease。router 只有在 Redis 明确确认 owner 不存在时才绕过原 runner；owner 仍存在或 Redis 状态未知时 fail-closed，待 lease 到期后由更高 fence 接管。worker 再按 child-first 顺序 tombstone，逐 session reconcile usage，最终以完整性计数证明停在 `awaiting_purge_policy`。catalog 的 `tombstoneProofValid` 只是早期、无正文筛查；`reconcileErasureSessionUsage` 会在写 billing fact/reconciliation 的同一 Memory 原子边界或 MySQL 事务内重新验证 marker、terminal `session/deleted` 与两条 outbox intent，proof 失效会原子转为 `blocked/integrity_conflict`，数据库/传输故障仍可重试。claim token、attempt 与 lease 共同防 ABA，过期 worker不能伪装成空 catalog或继续写入。该 user worker 不会调用 anonymize、领取 purge、物理删除内容、标记 completed 或处理 tenant erasure；tenant T2 的公开面只建立逻辑 fence，同样不会物理撤销 API key/provider/auth-secret。

`0014_legacy_tombstone_compensation.sql` 以 expand-only 方式增加默认inactive的单例cutover、每session durable job、append-only result evidence和session写入守卫；migration本身不激活cutover、不扫描历史数据、不伪造event/outbox，也不使purge可领取。全部pre-0014 writer与旧worker排空后，runner内嵌的独立补偿worker才能通过同一v2 fleet barrier把cutover从generation 0单向激活为1。激活事务与sessions INSERT/UPDATE守卫使用锁定读线性化：先观察inactive的旧写会先完成，之后任何新的`deleted_at_ms != NULL + deletion_generation=0`写都会失败；一旦激活不得回退pre-0014 writer。

补偿worker既可由仍在`reconciling_usage`的有效erasure claim定向enqueue，也会由content-free maintenance sweep覆盖没有erasure request的历史tombstone。每个job用attempt+token+lease防ABA，child-first处理，并在一个Memory原子边界或InnoDB事务内固定结算异常active turn/pending approval，保留原`deleted_at_ms`，追加连续的terminal `session/deleted`，把generation推进到1，写入即时`session.tombstoned`与仍不可领取的`session.purge` intent、append-only成功证据并完成job。任何发布步骤失败都整体回滚；确定性session/owner/child/proof冲突进入content-free terminal incident并继续邻居，未知数据库/传输错误保持可重试。该流程只补齐可核验的tombstone proof，不匿名化usage、不删除正文/receipt/Blob，也不把erasure request标记completed。

`0015_retention_policy_and_legal_holds.sql`继续expand-only且destructive-dormant：新增immutable policy version、generation-fenced active control、append-only activation event，以及tenant/user multi-hold ledger/control/event。migration不会创建默认active policy，不会设置`purge_after_ms`、开放`session.purge`、推进erasure phase、匿名化usage或删除内容；历史`legal_hold_at_ms`被转换为deterministic migration-owned canonical hold，并以rooted generation-1 event证明来源，marker-loss replay不会把后来变化的shadow误当成第二条legacy hold。策略七个duration字段的`NULL`都是fail-closed。activation提交即生效，不支持以各runner墙钟模拟未来调度；activation、hold set/release均在锁内把审计时间clamp为control的单调时间。

新user erasure request与activation锁同一tenant policy control：事务在线性化点观察到active policy就把version/hash同时写入request与首条audit；更早的backlog保持无policy身份，任何phase transition都不能补绑。MySQL的replay-safe BEFORE INSERT guards还会锁读control：inactive/无control只允许NULL/NULL，active只允许exact active pair，从而让pre-0015 writer或capability探测后的binary回退安全失败且整事务回滚。策略/hold管理由双端默认关闭的`DATA_GOVERNANCE_MANAGEMENT_ENABLED`、code-aware `dataGovernance`与management-active `dataGovernanceManagement`共同门控；它只接受admin service key，所有响应`no-store`，不授予purge能力。

`0016_erasure_purge_policy_authority.sql`继续expand-only且destructive-dormant：新增evaluation job、按build generation不可变的per-session target、rooted append-only decision、generation-CAS authority control和append-only authority。migration不回填历史`awaiting_purge_policy`、不设置`purge_after_ms`、不让`session.purge`/ready Blob delete可领取、不匿名化或删除数据，也不把request推进到`purging/completed`；历史awaiting request由新reader上线后显式调度。Memory/MySQL在`reconciling_usage → awaiting_purge_policy`的同一原子边界创建首个job，失败时request phase、audit与job一起回滚；并发历史调度通过request/job锁和唯一键只产生一个generation。

evaluator是与普通erasure worker、legacy compensation worker分离的最小权限组件，只持有`ErasurePolicyEvaluationStore`。job使用build generation、attempt/token/lease防stale/ABA，分页构建content-free target root；每个target只摘要session tombstone、ready Blob manifest、usage reconciliation/billing一致性、idempotency receipt deadline，并明确把billing fact/lifecycle audit标成retained、export artifact标成not applicable。seal在同一原子边界追加`unbound/invalid/unconfigured/held/waiting/eligible_execution_disabled`之一及可选authority；只有最后一种生成authority，但authority/control故意没有execution availability、claim或lease。runner/router的`PURGE_POLICY_EVALUATOR_ENABLED`默认`0`，每次schedule/claim前还必须取得router token-protected固定ACK；router要求全部configured稳定地址当前健康并声明`policy-evaluator-v1`。公开`dataPurgeExecution`恒为`false`。

seal会重新推导owner-scoped live inventory并核对request-bound immutable policy与tenant/user hold generation/projection。build期间出现usage、receipt、Blob或session证据变化时，store抛出显式`evidence_changed`，claim-bound retry以新build generation从空cursor/root重建；sealed authority之后的同类变化或hold set/release ABA会先撤销active projection再调度新generation，旧target/decision/authority仍不可变。target不是turns/items/events/approvals全量内容清单，无法证明没有孤儿正文；eligibility deadline当前也使用runner记录的wall clock，尚未以共享数据库/可信时间处理跨VM forward/slow skew。因此validated authority仍只是non-executable candidate：未来destructive executor必须在执行事务中重验可信时间与canonical hold，并用owner-scan + `session_content_receipts`、ready Blob physical ACK、usage anonymization、receipt/Redis清理、secret revocation和独立restore-ledger ACK形成完成证明。当前`getErasureCompletionReadiness`固定返回`complete=false`并列出这些缺口。

`0017_user_export_jobs_and_artifacts.sql`继续expand-only：新增owner/subject-generation绑定的request/job、白名单snapshot record/source-Blob pin、artifact/part、download lease和artifact-delete outbox。POST要求admin service key、明确user、Idempotency-Key，以及线性化点active policy中的正值`exportArtifactTtlMs`；request与job原子建立，同key重放稳定，同key异义冲突，subject已经deleting则拒绝。export与erasure在同一subject control上串行：erasure先提交时不再接收export；export先提交时erasure会把request标为revoked、撤销下载并调度精确制品清理。

MySQL worker用`REPEATABLE READ WITH CONSISTENT SNAPSHOT`事务复制该owner的session/turn/item/event/approval/operational usage白名单和附件source descriptor，然后释放事务，在BlobStore中按确定性`ndjson-v1`分片发布。公开记录按固定kind、logical key和全局ordinal排序；附件按独立ordinal输出base64 chunks。header/footer、manifest/content digest和snapshot root都可重算，但制品不包含provider/API secret、idempotency material、claim/lease、subject/build fence或物理locator。只有全部part descriptor、manifest和整体bytes验证后，request/artifact才原子变为ready；序列化、source Blob或发布失败不会留下可下载的部分制品。claim、part ACK、download和delete都由attempt/token/lease/generation CAS约束，防止stale/ABA worker提交。

ready status只公开content type、size、SHA-256与时间；download逐part校验owner、canonical storage key、backend/format/content type、size/hash，并在创建响应前验证完整manifest，传输时持有总寿命有硬上限的durable lease和整体digest。artifact staging TTL是无活动build claim时的orphan回收阈值，不是活动build的硬deadline；claim与cleanup在锁内竞争，claim存活或已安全接管时可以继续stage/ACK/complete，cleanup先赢时则原子failed并发布精确delete intent。普通TTL等待活动下载结束再进入delete outbox；revocation可取消活动lease并优先清理。delete worker只接受`data_exports/...`下由owner/request/artifact/part精确推导的identity，物理删除成功后才CAS ACK。Memory与MySQL共享同一契约；filesystem只支持本地单runner，production在共享对象存储adapter完成前不注入export read surface且任一export flag均fail-closed。

`0018_tenant_credential_revocation_fence.sql`继续expand-only：新增与旧`erasure_requests`队列分离的`tenant_erasure_admissions`，以及每tenant一条的`tenant_credential_revocation_fences`；两类证据均由append-only trigger保护。内部`requestTenantErasure`在一个Memory原子边界或InnoDB事务内锁定tenant lifecycle，并同时提交独立admission、`state=deleting`与单调generation、首条无正文`erasure/gated` audit和credential fence；任一步序列化或SQL失败全部回滚。API key、provider config/secret、tenant auth secret、agent/session等普通入口及tenant-key retention-policy/legal-hold写同时检查lifecycle、admission与fence，读取隐藏或写入拒绝；已解析provider handle还会在解密和outbound fetch前重验generation。append-only admission或fence单独幸存时也会撤销user-erasure worker与purge evaluator的claim/renew/transition/session-action/repair authority，且不阻塞健康邻tenant。T1本身不删除物理credential，也不进入旧user worker扫描；T2的platform lifecycle authority使用独立router入口，没有绕过现有tenant-key store方法。

T2提供独立于tenant自身credential的platform operator authority、公开admission/status/replay和全fleet fail-closed barrier。公开路径只注册在router；共享OpenAPI由两端提供，但runner只实现带内部token/actor和固定ACK的版本化私有路径。platform bearer不得进入runner进程环境、普通代理、持久化或日志，runner配置边界发现router-only authority即拒绝启动。新的admission/create path先由router刷新并检查全部configured稳定runner；selected runner又在store事务前即时调用router私有barrier，只有router/runner gate和每个target的code-aware/local gate同时成立才提交。gate关闭时router固定选择独立read-only replay route与独立ACK；精确已提交tenant/key/hash返回原`202`，未命中返回`503`且绝不创建，即使gate在途中开启也不能升级模式。status/replay与writer gate解耦，并在单一一致性视图验证完整proof；跨tenant请求与不存在一致。`0018` migration仍可在admission不存在的mixed fleet先expand，但任何pre-`0018` runtime仍可认证或服务时都禁止激活T2，旧进程必须先排空。不得通过直接store调用或手工SQL绕过T2。

`0019_tenant_credential_physical_revocation.sql`实现T3a的expand-only substrate：独立job、immutable aggregate receipt和write-once cutover与旧user queue分离。migration不扫描`0018` admission、不回填job、不激活cutover，也不删除credential/content；新admission与job同事务创建，历史`0018` admission只由显式materializer在验证admission/lifecycle/audit/fence完整proof后补job。runner内嵌worker使用数据库时间计算claim/renew/retry，并在materialize/claim和紧邻不可逆事务前分别要求router的token-protected fresh all-configured barrier。

claim-bound原子事务删除目标tenant的全部`api_keys`行（包括revoked verifier）与全部`provider_configs`行，清空`tenants.auth_policy`、`auth_secret_cipher`、`auth_secret_key_id`，然后重扫确认零残留，并在同一事务完成job、写receipt和首次cutover。不可逆DELETE前先锁住全局cutover并验证完整全局proof：generation 0必须同时不存在receipt与`credential_store_revoked` terminal job；generation 1必须由cutover hash精确找到首receipt，再绑定对应terminal job、completion proof及原始的append-only T1 admission、首audit和fence。已经终态完成的job/receipt/cutover证明刻意不依赖mutable lifecycle，使后续T3b可合法把projection推进到`erased`或清理；但queued/blocked job读取、claim/renew/retry/block及首次DELETE都必须重新验证当前`deleting` lifecycle与同一request/generation。孤儿receipt、孤儿terminal job、首job缺失/不匹配或immutable T1 source损坏都会让本次事务在删除credential前fail closed；T3b不得清理首audit等历史proof。tenant registry与全部content/usage/receipt/Blob保留；receipt不包含key hash/id、provider id/config/header、auth policy/cipher/key-id或claim token，只保存计数、布尔post-state与hash proof。其scope固定`local-db-credential-material-v1`，`runtimeDisposition=not_in_scope`、`externalDisposition=not_supported`、`contentPurgeRequired=true`。失败整体回滚；响应丢失只能由精确completed attempt/token hash重放，不能看到空表就补造成功。公开status仍为`gated`，`dataPurgeExecution=false`。

`0020_tenant_runtime_revocation.sql`实现T3b的expand-only substrate：独立runtime job、per-target append-only receipt与aggregate receipt，继续与user queue和T3a job分离。migration不扫描T3a receipt、不回填job、不执行drain，也不删除任何数据；runner内嵌worker只在完整验证T1 fence、T3a terminal receipt与live tenant lifecycle后显式materialize。worker使用数据库时间claim/renew/retry，并向router请求一次精确configured-fleet fan-out proof。

每个runner的共享tenant coordinator在本地同步fence新auth/provider/turn操作，abort并等待已接纳的fetch/response body/turn结算，随后清空TenantPolicyCache、JWT/JWKS/introspection verifier、tenant BYOK provider registration和SessionHost引用。即使初始snapshot或某个participant hook抛错，所有participant和active lease仍会被best-effort fence/abort；未在deadline前结算会保持tenant fenced并使本次drain失败。router在fan-out前后fresh探测每个configured direct origin，要求稳定runnerId/bootId不变且全fleet唯一。Memory/MySQL完成事务原子写全部target receipt、aggregate receipt与terminal job；terminal replay除aggregate外还逐target重验原始proof和attempt/token，任何不匹配都fail closed。

T3b receipt scope固定`configured-fleet-runtime-v1`，target URL、runnerId与bootId只持久化hash。它只覆盖coordinator已跟踪的auth policy/verifier、tenant BYOK provider registration、auth/provider操作和SessionHost turn；不覆盖lifecycle/Blob/export/background store I/O、Redis/session lease、content/usage/backup purge或远端provider side effect。`memoryDisposition=references_dropped_not_zeroized`承认JS字符串不能可靠清零，`externalDisposition=not_supported`承认外部provider/KMS仍未撤销，`contentPurgeRequired=true`保持后续删除义务。

新 usage write 会在同一 store transaction 中以 opaque `usage_id` 双写 operational ledger 与严格白名单的 billing fact；后者不含 user/session/turn/step、原始 usage JSON、prompt 或 idempotency key，金额统一以 9 位小数规范字符串写入 MySQL `DECIMAL(24,9)`，避免高金额经 JavaScript 隐式字符串化产生 checksum 漂移。session/turn/event/compaction 投影以 ledger 为权威：Memory 直接聚合事实，MySQL 在同一 consistent read/业务事务快照内用 SQL summary 聚合，读取和下一次 commit 都能修复旧 writer 留下的 partial projection，而不依赖 migration 回写。对 legacy `usage_id IS NULL` 行，显式 reconciliation 会在 tombstone generation 大于 `0`、owner 匹配的前提下先固化历史 cost 归一化，再补 ID、逐行核对或插入 billing fact，最后核对 row count、各 token、known-cost row、规范化 cost 和 checksum；冲突会回滚 ID、JSON、fact 与 reconciliation，而非覆盖。显式 anonymize primitive 还会在锁内复核 checksum 和 durable tenant/user legal hold，只删除目标 session 的 operational usage，保留 billing fact，并支持幂等重试；legal hold 只阻止尚未发生的 `verified → anonymized` 转换，不能把已提交但响应丢失的同 checksum 重试伪装成失败。它尚未由 erasure worker 或公开 API 调度。未知模型价格保持 cost 缺失，已知零价保持 `0`；历史 `usage_id IS NULL + costCNY=0` 无法可靠区分“旧 writer 用零表示未知”与“真实免费价”，因此安全默认把它视为 unknown，新版有非空 identity 的零价仍是 known-zero。普通 rollup 只有在全部 constituent 已定价时才公开完整 cost，不能把已知小计伪装成总价。硬 `maxCostCNY` 遇到未定价的正常 step 会在该 step 落账后关闭 admission，不执行其工具或下一模型 step。

这意味着当前实现还可以对active user生成时间点一致、可校验且自动过期的导出制品，并经T2 platform入口在tenant线性化点逻辑撤销现有credential/data入口，再由T3a删除本地数据库credential material、由T3b清空configured-fleet本地runtime引用与已跟踪I/O；但`awaiting_purge_policy`、`eligible_execution_disabled`与tenant `gated`都不是erasure completed。ready源内容、operational usage、receipt/manifest和对象字节尚未永久删除；external provider/KMS、未纳入coordinator的background I/O、附件最终清理和restore防复活仍未闭环。export artifact cleanup只删除临时导出副本，不能替代源数据purge。

## 2. 生命周期模型与不变量

运行状态与生命周期状态正交：

- 运行状态：`idle | active | error`
- 生命周期状态：`visible | archived | tombstoned | purging | purged`

必须保持以下不变量：

1. session 生命周期变更与 turn 使用同一 lease/fence，并进入同一 per-session 串行队列；新 owner 获取 Redis lease 后必须先以纯 fence claim 推进数据库 fence、再读取 takeover 快照；HTTP 层不得旁路 `SessionHost` 直接修改 store。
2. tombstone 一旦提交，普通 API 统一表现为 `404`，普通 commit 必须失败，session ID 永不复用。
3. archive 可逆；DELETE 对普通用户不可逆。grace period 只服务后台恢复、legal hold 和最终清理，不是用户回收站。
4. 内容数据与财务事实分开处理；删除内容不能静默丢账，也不能让完整 prompt/工具输出伪装成“审计日志”长期保留。
5. events 包含 item、turn、approval 快照，必须与 session 内容执行相同的删除策略。
6. 跨 tenant/user 操作继续返回与不存在相同的 `404`，不能形成存在性 oracle。
7. MySQL 事务不能包含对象存储删除；必须用事务 outbox 保证最终完成与安全重试。
8. 任一 subject gate 首次提交后，所有可能处理该 tenant/user 请求的 writer 都必须继续理解并执行 `subject_lifecycle`；关闭 admission 开关不能把 lifecycle-aware fleet 安全回退成会忽略 durable gate 的旧 writer。

## 3. Archive 推荐语义

以下语义已实现；本节同时作为兼容性与回归契约：

推荐直接采用以下默认值：

- `POST /v1/sessions/{id}/archive` 幂等；只允许非 active session。
- 新增 `POST /v1/sessions/{id}/unarchive`，幂等恢复。
- archived session 可 GET、resume、列举 turns/items/events；默认列表隐藏，`includeArchived=true` 可见。user export 的ownership snapshot包含archived session及其白名单子资源。
- archived session 禁止新 turn、steer、compact、approval decision 和 dynamic tool result，返回 `409 session_archived`。
- archive/unarchive 产生持久事件 `session/archived` / `session/unarchived` 并递增 seq。
- archive 清空 `autoApprovedTools`，异常残留的 pending approval 置为 expired；恢复后重新审批。
- active session archive 返回 `409 session_busy`，不隐式中断模型或工具。调用方可先 interrupt，再重试 archive。

turn 与 archive 竞态只允许两种结果：archive 先提交时 turn 不产生 receipt/item/event；turn 先提交时 archive 返回 busy。数据库显示 active 但 lease 已失效时，先由新 owner 按既有 orphan repair 结算旧 turn，再 archive。

## 4. DELETE、tombstone 与 purge

当前 `204` HTTP 行为已收紧为：

1. DELETE 获取 lease/fence，在行锁事务中确认 session idle。
2. active session 默认返回 `409 session_busy`，不把“删除”与强制中断外部副作用混成一次同步操作。
3. tombstone 事务原子写入 `deleted_at_ms`、nullable `purge_after_ms`、单调 `deletion_generation`、terminal `session/deleted`，以及按 `(topic, session_id, generation)` 去重的 `session.tombstoned` / `session.purge` outbox。
4. tombstone 提交后，所有普通资源 API 立即 `404`；已建立 SSE 收到删除事件后关闭。
5. 同一 owner 在 grace 内重复 DELETE 返回 `204`；跨 user/tenant 仍为 `404`。
6. 普通 `commit` 永远拒绝 tombstoned session；未来 purge worker 必须使用独立、最小权限的生命周期接口并可重入。
7. 未来最终删除 session 行，或仅保留不含个人信息的最小 grave marker；任何情况下 ID 不复用。

在保留期未确认前，安全默认是 `purge_after_ms = NULL` 且 purge worker 关闭。当前 dispatcher 仅领取立即可用的 `session.tombstoned` intent；`session.purge` intent 的 `available_at_ms = NULL`，不可领取。terminal event 完成投递也不等于已经执行任何物理清理。

`0009` 对升级前已经 deleted 的行保留 `deletion_generation = 0` 且不伪造 outbox。`0014` 已增加默认休眠、可审计且幂等的补偿流程；它只有在v2 fleet barrier通过并单向激活cutover后，才把可证明安全的历史行推进到generation 1并原子补齐terminal event与两条intent。terminal incident或仍为generation `0` 的行都不是已完成清理，未来purge必须继续拒绝它们。

## 5. 各数据类型的处置

| 数据 | tombstone 后 | grace 到期后 |
| --- | --- | --- |
| session 投影 | 普通 API 不可见、不可写 | 删除或变成最小非个人 tombstone |
| turns/items/events/approvals | 不可见、不可写 | 分批物理删除 |
| completed idempotency receipt | 不再对普通请求重放 | 按 TTL 或 session purge 删除 |
| legacy pending receipt | 保留，新版本不得接管 | 仅在所有旧 runner 已 drain 后删除 |
| Redis stream/owner/lease | 停止新订阅并完成 owner 协调 | 由 outbox 清理 |
| Redis fence counter | 暂时保留 | 物理删除且超过最大 lease 窗口后清理 |
| session/turn usage 投影和 usage event | 随内容不可见 | 随 session 内容删除 |
| usage 财务事实 | 保留用于对账 | 汇总、核对并匿名化后按财务策略保存 |
| blobs | tombstone 后立即禁止 API 访问 | outbox 异步物理删除 |
| 最小生命周期审计 | 不含 prompt、args、正文 | 按审计策略保留 |

未来若把事件冷归档到对象存储，归档块必须有 tenant/user/session ownership manifest 并参与相同 erasure，不能成为删除盲区。

## 6. Usage 与财务保留

继续保持现有正确性基础：ledger 与 `usage/updated`、turn/session usage 投影在同一 commit 中，且 `(session_id, turn_id, step)` 唯一。

`0011` 已把 usage 落盘分成两层：

- operational usage ledger：短期保留 tenant/user/session/turn/step，用于重试、查询和对账。
- billing ledger：新写入只保留 opaque usage identity、tenant、UTC accounting period、provider/model、tokens、可选 cost/currency 和完整性 metadata；不保留 user/session/turn/step、精确请求/reconcile 时间、prompt、item、原始 usage JSON 或 idempotency key。

新 writer 在业务 commit 内原子双写两层，billing identity 或内容冲突会使整个 commit 回滚。所有持久化 cost 使用同一个 9 位小数 canonical formatter；投影从 ledger summary 重建，mixed priced/unpriced 保持 unknown，owner-corrupt facts 不参与“部分正确”的计数而是整体 fail-closed。legacy 行不会由 migration 静默改写；`reconcileSessionUsage` 只处理 owner 匹配且已 tombstone、`deletion_generation > 0` 的 session，在并发锁下锁定该 session 的全部 usage row，先把历史 null-ID zero 规范为 unknown，再分配稳定 `usage_id`、核对 tokens、known/unknown cost、row count 与 checksum。`anonymizeSessionUsage` 必须由调用方显式传入 enablement 和预期 checksum，并由 store 自己读取 durable legal hold；核对成功后只删除 operational row，billing fact 继续保留。

claim-bound reconciliation 已由当前 erasure worker 调用；`anonymizeSessionUsage` 仍只是未接入 worker/API 的最小权限 primitive。canonical tenant/user legal hold管理面与非破坏性policy evaluator已实现，primitive在锁内同时读取两级active集合；evaluator本身没有调用该primitive的能力。启用批量匿名化前仍需确认 operational/billing 保留期、成本/币种和 provider/model 白名单，增加可信数据库时间、owner-scan/content receipt、独立destructive queue、任务游标/恢复与完成审计。若未来仍需用户级账务，应使用独立 `billing_subject_id`，删除其与真实 user id 的映射。

原始 `Idempotency-Key` 后续应改为服务端 HMAC 后的确定性值；客户端可能误把邮箱等个人信息放进 key，当前明文存储会扩大个人信息面。

## 7. 父子 session

当前创建时已强制 parent 与 child 属于相同 tenant/user；`0009` 已增加 parent lifecycle index，并用 parent 行锁串行化 child create 与 parent tombstone。生命周期仍需补：

- 显式关系类型，至少区分 `subagent` 与 `fork`。
- 删除 child 不影响 parent。
- user/tenant erasure 覆盖该主体的全部 session，不受关系类型影响。
- 关系类型落地前，目标 session 存在任何未 tombstone child 时 DELETE 返回 `409 session_has_children`；不得静默级联或留下 dangling parent。child create 与 parent DELETE 并发只允许“child 先提交则 delete 被阻断”或“delete 先提交则 create 看见 parent 不存在”。
- 推荐未来语义：`subagent` 随 parent 删除；`fork` 默认独立，只清除 lineage。fork 是否包含独立内容副本仍需产品确认。
- archive 默认只作用于目标 session；是否级联归档 subagent 需产品确认。

## 8. User/Tenant erasure 与导出

user scope 已实现 durable gate 与安全的非破坏性 orchestration：`POST /v1/data-erasure-requests` 由 admin service key 代表明确 user 发起，要求 `Idempotency-Key`；Memory/MySQL 原子提交 subject=`deleting`、单调 generation、request=`gated`、首条无正文 audit，以及线性化点已active的policy identity。router admission 仍要求显式 gate 与 configured fleet 全员同时支持erasure和policy-aware writer；与 admission 独立的 runner worker 则会继续处理已有 request。它只持有 claim-bound、无正文的 catalog/session capability，经 router 定位 current owner并执行有界 drain，重复扫描 live leaves完成 child-first tombstone，在 usage 写入同一原子边界重验 tombstone proof并核对所有 tombstone usage，最后停在 `awaiting_purge_policy`并原子建立首个evaluation job。另一个默认关闭、独立fleet barrier保护的evaluator可以把该job封存为denied/deferred decision或`eligible_execution_disabled`候选，但不会改变公开request phase。真实 MySQL+Redis 双 runner 测试覆盖远程慢 turn、owner `SIGKILL`、lease expiry/fence takeover、重试和无 purge。status GET 继续按 healthy fleet/selected target fail-closed；关闭 admission 不撤销 gate、policy binding或已持久化 job。

tenant scope 已完成T1存储地基、T2 platform控制面、T3a本地数据库credential-store清除和T3b configured-fleet runtime清空：独立admission、tenant lifecycle gate、首条audit与全credential逻辑fence原子提交；所有现有tenant-scoped普通入口读取隐藏、写入拒绝，跨tenant不受影响。公开POST/status只能经router的独立platform bearer调用，admission双端gate与fresh all-configured barrier阻止mixed fleet提交，关闭新admission后status/replay仍可读。T3a/T3b各有独立默认关闭gate和runner内嵌worker；前者删除API-key/provider行并清空tenant auth三列，后者fence精确configured runners并清空已跟踪本地runtime引用/I/O，二者都保留registry/content。因此公开状态仍只能是`gated`，不是完整erasure产品闭环。

主体删除的完整目标仍应是异步、幂等的 erasure job，而不是循环调用 session DELETE：

1. 建立 generation-scoped durable request；user scope使用`erasure_requests`，tenant T1/T2使用独立`tenant_erasure_admissions`并公开只读`gated`投影，避免旧worker把无queue-authority的tenant row误当poison。T3a另用独立credential job，不复用user queue。
2. 先把 tenant/subject 标为 `deleting`；session create 和普通 runtime/Blob 写入的存储事务检查该 gate，避免枚举期间创建新数据。user scope已继续完成下述drain/tombstone/reconcile；tenant T1/T2覆盖普通credential/data入口，T3a清除本地DB credential material，T3b清除configured-fleet已跟踪runtime引用/I/O，尚未枚举tenant content。
3. tenant erasure立即逻辑吊销API keys并停止新使用provider/auth secrets；T1/T2完成逻辑fence，T3a物理删除本地DB API-key/provider行并清空auth三列，T3b对所有configured runner持久化runtime drain proof。外部provider/KMS撤销与远端副作用仍未覆盖。
4. 请求 owner 中断 active turn并有界 drain；超时后等待 lease 失效，再用新 fence tombstone。user scope 已实现到这里，并完成 usage reconciliation。
5. 分批删除内容、receipt 和 blob；usage 按财务政策匿名化。该不可逆阶段仍未实现/激活。
6. legal hold 只暂停物理 purge，不恢复普通 API 可见性。
7. 完成记录只保存数量与校验和，不保存正文。
8. 从备份恢复后必须先重放独立故障域中的 erasure ledger，再开放流量，防止已删除数据复活；仅把 audit 放在同一 MySQL 不足以抵御恢复旧备份。

user导出已按同一ownership视图实现：公开入口为`POST /v1/data-export-requests`、status GET和download GET，均要求admin service key与明确user，POST还要求`Idempotency-Key`。MySQL在RR一致性快照中复制session/turn/item/event/approval/operational usage与用户附件白名单，worker再生成可重算的multipart NDJSON manifest；平台agent/provider secret、其他用户数据、receipt、内部租约/fence和物理locator不进入制品。policy的`exportArtifactTtlMs`必须为正值，TTL/revocation通过独立delete outbox清理。tenant-scope export尚未公开。

## 9. Blob ownership 与 outbox

业务层只保存 opaque `blob_id`，不能向客户端暴露 `file://` 或云对象 key。建议 manifest：

```text
blob_objects(
  blob_id, tenant_id, user_id, session_id, item_id,
  storage_key, state, sha256, size_bytes, content_type,
  created_at_ms, delete_after_ms, deleted_at_ms
)
```

其中 `state = staging | ready | delete_pending | deleted`。初期禁止跨 item/session 共享 blob，避免危险引用计数；未来若做去重，再加显式 reference table。

上传先进入 staging；manifest 与 item 原子关联后才 ready。上传成功而数据库事务失败的对象由 staging orphan sweeper 删除。该部分已经实现，并覆盖 binding/sweeper 竞态、事务回滚、跨 owner 注入、claim lease/retry/CAS complete。目标态的 session purge 事务还需把该 session 的 ready manifest 标记为 `delete_pending` 并写 outbox；worker 幂等删除对象，对象已不存在视为成功。

当前 `lifecycle_outbox` 已包含 `UNIQUE(topic, aggregate_id, generation)`、`available_at_ms`、`attempts`、claim token/lease、`last_error`、`completed_at_ms` 和 dead-letter marker，并与 tombstone 同事务写入。Memory/MySQL 都实现独立的最小权限 claim/renew/complete/retry API；这四条入口均只接受 `session.tombstoned`，即使旧版或异常进程曾为 `session.purge` 留下 claim token，也不能经通用 ACK 面续租、完成或重试。MySQL 在 `READ COMMITTED` 事务中用 `FOR UPDATE SKIP LOCKED` 非阻塞领取，所有续租、完成与重试都由 topic + outbox id + claim token + 有效 lease 做 CAS，失败消息先脱敏再持久化。

runner 内置 lifecycle dispatcher 只声明 `session.tombstoned` topic，读取并校验 durable terminal event 后发布；暂时失败以有上限退避无限重试，确定损坏才进入 dead-letter，crash-after-publish 依靠同一 event seq 重复安全。它绝不领取 `session.purge`，因此不会扩张为内容清理能力。独立 Blob cleanup worker 只领取 `blob_delete_outbox`，目前 intent 只来自 stale staging sweeper；它不读取 lifecycle outbox，也不能删除 ready blob。

## 10. 滚动升级顺序

采用 expand → activate → contract：

1. 已增加 nullable tombstone 字段、各生命周期outbox/Blob manifest，以及 `0011` usage/subject、`0012` erasure queue、`0013` quarantine/control、`0014` legacy compensation、`0015` policy/hold、`0016` non-destructive authority、`0017` user-export substrate、`0018` tenant T1 admission/fence、`0019` T3a credential-store job/receipt/cutover和`0020` T3b runtime job/per-target/aggregate receipts。migration本身都不启用purge；冻结历史fixtures会从`0007`逐段真实升级到`0020`，并验证partial DDL、marker-loss、append-only guards和destructive dormancy。
2. tombstone 是 protocol family `2026-10-08` 内的 additive capability，不提升 exact protocol version。客户端必须忽略未知 event；新 router 能同时探测未声明和已声明 `tombstone` 的同 family runner。
3. 先在 API gateway 暂停精确 session DELETE（或将流量整体切到 gate 为 `0` 的新 router 池），再发布新 router 并保持 `SESSION_TOMBSTONE_ENABLED=0`；在开始发布新 runner 前，排空并退出全部不能理解新 capability 的旧 router。旧 router 自身没有该 gate，因此不能在它仍接收 DELETE 时只靠逐实例替换保证一致语义；runner 端口必须保持内网不可直连，否则会绕过 gate。切换后其它 API 保持可用，精确的 session DELETE 返回可重试 `503 draining`。
4. 再滚动新 runner。router 除显式开关外还要求全部健康 runner 都声明 `tombstone`，所以旧 owner/哈希目标仍存在时不会激活新 DELETE 语义；核对配置 fleet 和 `/v1/capabilities` 后，才把新 router 的 `SESSION_TOMBSTONE_ENABLED` 设为 `1`。外部 DELETE 会改写成带 `INTERNAL_ROUTER_TOKEN` 的版本化 runner-only POST，并要求 ACK；旧 runner 只会 404，router 不会回退到旧公开 DELETE。`RUNNERS` 每项必须是实例稳定地址，不能是随机选择不同版本 Pod 的共享 LB；token 轮换期间先把 gate 恢复为 `0`。
5. Blob 写入采用另一组 expand→activate gate：新 runner 可先带 reader、manifest、worker 部署但保持 `BLOB_ATTACHMENTS_ENABLED=0`；新 router 同样保持 gate `0`。确认全部健康 runner 声明 `blobAttachments`、共享对象存储可从每个 runner 访问且 cleanup 已启用后，才同时激活写入口。关闭写 gate 不能关闭历史 ready blob 的读取。当前只有 runner-exclusive filesystem adapter，`BLOB_FILESYSTEM_SINGLE_RUNNER=1` 只允许本地单实例体验；production 配置会同时拒绝 writer 与 cleanup，不能据此演练真正的多实例 rollout。
6. user erasure、legacy补偿和policy管理采用expand→code-aware→activate：先应用 `0011`/`0012`/`0013`/`0014`/`0015`，部署新 router并保持erasure admission与governance management均为`0`，排空旧router，再滚动new runner/worker，排空pre-0014 worker并等待最大job lease过期。新runner即使management gate关闭也必须声明code-aware `dataGovernance`；只有全部configured地址健康且具备该writer语义后，router才可能恢复erasure POST。新worker每次claim或激活cutover前仍要求v2固定ACK。先按既有顺序激活compensation/ordinary worker，最后才按需依次打开runner、router的erasure admission；policy/hold管理则先逐runner开启`DATA_GOVERNANCE_MANAGEMENT_ENABLED`并核对`dataGovernanceManagement`，最后开启router gate。activation提交或首条canonical hold event之后不得恢复pre-0015 writer；关闭管理gate只关闭新管理请求，不撤销policy、hold或request binding。所有边界均只能forward-fix并保留durable证据。
7. 上述 gate 只覆盖同一 protocol family 内的 additive rollout。未来真正改变 protocol version 的不兼容变更仍需全量 drain 的维护窗口或将 router+runner 整组 blue-green，除非另行实现 version range/按版本路由。
8. 全部 legacy writer drain 后，才能清理允许删除的 pending receipt或激活0014 cutover。generation `0` 补偿已实现，但cutover本身是不可逆contract边界；不能把本地默认开启误抄成production默认，也不能用关闭feature flag撤销已经提交的activation。当前erasure worker仍最多到 `awaiting_purge_policy`；claim-stage poison进入`0013` quarantine，legacy补偿的owner/session/child/proof冲突进入独立terminal incident。两类证据都不能catch-and-skip、直接改表或伪造成成功。
9. `session.purge` 与 ready 内容的物理 purge 独立保持关闭；canonical policy/hold authority和非破坏性evaluator虽已实现，仍须完成可信时钟/完整内容证明、destructive usage匿名化、备份恢复演练和destructive-worker校验后才允许启用。当前版本会对意外的 `purging` claim fail-closed 为 `policy_unavailable`；未来激活前必须升级并排空这些旧 worker，避免它们与新版 purge worker抢单。
   `0016` evaluator现在可以生成`eligible_execution_disabled`候选，但这不改变上述结论：它由runner wall clock判断deadline，只摘要per-session policy targets，且没有execution queue。未来executor rollout必须另建默认关闭的双端gate和最小权限接口，以数据库/可信时间重验deadline与两级hold，完成owner-scan + `session_content_receipts`及全部physical ACK后才能进入`purging/completed`。
10. user export采用migration→code-aware→worker→admission：先应用`0017`，部署admission=`0`的新router/runner并排空旧进程，再先启cleanup、后启build worker，最后启runner/router writer gate。关闭admission后已有job/status/download/cleanup继续forward-fix。当前filesystem只允许local单runner；production完全不宣告该read surface且任一export flag都fail-closed，直到共享对象存储adapter完成。
11. tenant schema先expand、T2再activate：可先应用`0018`，因为migration不创建admission、不修改旧user queue/trigger；冻结0017夹具证明新表不会进入旧claim扫描。随后先发布gate=`0`的新router并排空旧router，再把全部runner升级为code-aware但gate=`0`，逐runner开启local gate并核对每个configured稳定地址，最后开启router gate。每次新的admission提交前仍即时请求fresh barrier。pre-`0018`进程不知道credential fence，旧进程彻底排空前任何环境都不得admit；首次提交后关闭gate只能停止新admission，不能撤销durable fence。精确已提交POST仍可经独立read-only route恢复原响应，其它POST fail-closed，只能forward-fix。
12. T3a采用`0019` expand→code-aware→worker→execution gate：先应用migration；发布`TENANT_CREDENTIAL_REVOCATION_EXECUTION_ENABLED=0`的新router并排空旧router；滚动`TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED=0`但声明`credential-store-v1`的新runner；逐runner开启worker，核对全部configured稳定地址健康且worker-active，最后开启router execution gate。worker每次materialize/claim及紧邻不可逆事务前都重取fresh ACK。新admission gate与execution gate独立，使关闭新POST后已有job仍可forward-fix。首个receipt激活write-once cutover后不得回退pre-`0019` writer/worker；关闭execution只暂停新批次，不恢复credential或删除证据。
13. T3b采用`0020` expand→endpoint→worker→execution gate：先应用migration；发布`TENANT_RUNTIME_DRAIN_EXECUTION_ENABLED=0`的新router并排空旧router；滚动`TENANT_RUNTIME_DRAIN_ENABLED=0`、`TENANT_RUNTIME_REVOCATION_WORKER_ENABLED=0`且配置稳定`RUNNER_ID`的新runner；逐实例开启endpoint并核对`RUNNERS`全部稳定直连origin及runner/boot identity，再开启worker，最后开启router execution。router对每个target执行前后fresh probe；任一失败不返回proof，但先前target可能已fence，必须forward-fix。关闭gate不能解除本地fence或撤销durable receipt。
14. usage 采用先双写、再锁内回填/核对、最后显式匿名化；不能一次 migration 直接破坏现有 attribution/唯一键。
15. staging/production 使用独立 migration Job，runner 只检查 schema；本地/CI 可继续自动迁移。sticky barrier只能约束新worker；它不能阻止旧worker直接连接数据库，所以混跑结束、旧worker drain、最大lease等待和网络/进程层阻断是不可省略的发布条件。0014 session trigger会拒绝cutover后的legacy tombstone写，但这只是fail-closed保护，不是允许旧binary继续运行的兼容承诺。

## 11. 待确认策略

以下选择会决定 schema 和不可逆行为，必须在实现自动 purge/erasure 前确认：

| 决策 | 推荐默认值 |
| --- | --- |
| session DELETE grace/内容保留期 | 30 天；未确认前不自动 purge |
| operational usage 保留期 | 至少覆盖账单争议窗口；具体期限由财务/合规给出 |
| billing ledger 字段与期限 | 最小化字段，按财税义务确认 |
| legal hold 与管理员恢复 | 支持 legal hold；普通用户不可恢复 DELETE |
| active turn 强删 | 不支持；先 interrupt，再 DELETE |
| parent/child 级联 | subagent 级联，fork 独立；需确认 fork 副本语义 |
| user/tenant erasure 与 export SLA | 需产品/合规给出发起权限、二次验证和 SLA |
| 审计、导出包和备份期限 | 分别配置，不复用内容保留期 |

## 12. 验收矩阵

当前还覆盖`0012`到`0016`的queue/quarantine/compensation/policy/evaluator语义、`0017`export request/job原子性、RR snapshot、真实core worker跨层发布、确定性制品、下载lease、TTL/撤销delete outbox与owner隔离，tenant T1/T2的admission/platform控制，`0019` T3a的DB-time queue、物理credential-store事务、receipt/cutover、回滚、response-loss重放和隔离，以及`0020` T3b的configured-fleet runtime fence、per-target/aggregate receipt、exact proof replay、并发lease、回滚和隔离。固定历史fixtures从`0007`逐段升级到`0020`并证明DDL中断/marker-loss可恢复、旧证据字节保持且原worker scheduling不变。以下矩阵中的external revoke、content destructive purge与backup replay仍是后续验收目标：

- Memory/MySQL conformance：archive/unarchive 幂等、archived 禁写、事件 seq 连续、tombstone 隐藏且拒写、失败全回滚。
- MySQL + Redis 并发：turn/archive/delete 竞态、stale fence、lease loss、orphan active repair。
- active turn 各阶段：reserved/running/waiting approval/settling 默认均 busy；interrupt 后可归档/删除。
- 数据完整性：purge 后内容表与 receipt/blob 清空，usage tokens/cost 校验和不变，无 dangling parent。
- tenant/user 隔离：跨主体 archive/delete/unarchive 与不存在一致。
- usage/idempotency：worker-driven reconcile 与 crash/resume 已覆盖；仍需 policy-gated anonymize、receipt purge、长期保留期和完成审计。tombstone 后 receipt 不重放；legacy pending 在旧实例 drain 前保留。
- Blob/outbox：已覆盖 staging orphan、对象删除重试/重复领取、跨 tenant/user/session 注入；仍需覆盖 session purge 原子调度全部 ready blob、批次 crash/resume 和共享对象存储故障。
- erasure/export：user gate、queue/quarantine、legacy补偿、policy/multi-hold、跨runner drain与non-destructive evaluator均已覆盖；export artifact/download/TTL也已覆盖成功、序列化/source/blob失败、并发claim/ABA、真实MySQL回滚、跨owner404和erasure撤销；tenant T1/T2覆盖逻辑fence、platform auth/status/replay与admission barrier，T3a覆盖本地DB API-key/provider/auth material的原子清除和独立execution barrier，T3b覆盖configured-fleet runtime/cache/已跟踪active-I/O drain及durable exact proof。仍需trusted-clock与完整content receipt、external revoke、physical content purge和completed证明。
- rolling upgrade：additive capability、私有fleet barrier、部分回填重启和全旧实例 drain 后才激活新不变量已覆盖；固定N-1镜像的真实混版本canary仍留到M4发布编排。
- 备份恢复：先重放 erasure ledger，已删除主体的数据不会重新开放。
