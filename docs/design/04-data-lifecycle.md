# 数据生命周期设计

> 状态：**Archive v2、fenced tombstone、reliable terminal-event outbox、Blob ownership/业务接线与 staging orphan 清理、usage 财务分层、durable user-erasure、`0013` quarantine/control、`0014` legacy compensation、`0015` policy/hold、`0016`非破坏性purge authority、`0017`异步user-export artifact/download/TTL、tenant-erasure T1/T2、`0019` T3a、`0020` T3b、`0021` T3c、`0022` T3d、`0023` T3e本地执行/physical ACK、`0024` T3f本地数据库内容/控制投影清理，以及`0025` T3g session-scoped Redis状态清理均已实现；完整tenant erasure仍未闭环且T3e/T3f/T3g gate默认关闭**（2026-10-09）。T3g消费terminal T3f receipt及T3d固定Redis plan entry，以真实Redis Lua原子删除lease/owner、fence与stream并写永久purge marker；runner启动前及周期任务只重放同一MySQL中已有durable target ACK的marker，未ACK marker由worker轮询中的existing-marker-only原子replay收口。terminal只固定`redisPurgeComplete=true`，仍保持`allDomainsComplete=false`、`contentPurgeExecuted=false`，公开status为`gated`、`dataPurgeExecution=false`。generic session/user purge、external/KMS、backup与独立故障域restore ledger、logs/traces、共享对象存储生产适配及全域completion仍需继续实现。

## 1. 当前实现与缺口

当前 `archive/unarchive` 已通过 `SessionHost` 的同一 per-session 队列、Redis lease 与 MySQL fence 完成可逆状态转换；生命周期事件、session marker、授权和异常 pending approval 在一个 store commit 中提交。archived session 保持可读但统一拒绝 mutable runtime 操作；active turn、同 runner 并发、跨 runner takeover、历史 archived-active 行、Memory/MySQL 回滚和事件 seq 均有测试。获取新 lease 后会先用纯 `fenceClaim` 推进数据库 fence、再读取 orphan repair 快照，关闭 Redis→MySQL hand-off 期间旧 owner 仍可写的窗口。

`DELETE` 已通过 `SessionHost` 使用同一队列、lease/fence 和 orphan repair。Memory/MySQL 在一个原子 commit 中写入 tombstone marker、terminal `session/deleted`、连续 seq、单调 `deletion_generation`、立即可用的 `session.tombstoned` intent 和不可领取的 `session.purge` intent；`purge_after_ms` 安全默认为 `NULL`。普通 session/turn/item/approval/usage/receipt 随即隐藏且普通 commit 拒写，同 owner 重试幂等；已建立的 SSE 可收到 terminal event 后关闭。parent create/delete 行锁还保证并发时不会留下指向 tombstoned parent 的 child。

`BlobStore` 已有 memory 与本地文件实现；本地格式使用无大小写歧义的 key、带长度/校验和的单 envelope create-only 原子发布，并覆盖路径、权限、静态 symlink、损坏及并发测试，也可读取/删除安全 key 范围内的旧 raw + sidecar 格式。`0010` 增加 case-sensitive `blob_objects` ownership manifest 和独立 `blob_delete_outbox`；Memory/MySQL 都实现 staging/upload/原子 item 绑定、owner-scoped ready 读取、claim lease/CAS 删除与 stale staging 调度。用户图片以 opaque `blobId` 持久化，绑定前会校验声明 MIME 与文件签名，执行前还会检查所选模型的 image input 能力；大工具输出通过 `outputRef` 外置，当前 step 与重放使用同一份 JSON-safe 结果。历史按新到旧在总水化预算内读取 manifest 和对象，超出预算的旧图片/输出变成明确占位符；提交失败不会留下 ready manifest 或 item/event 半状态。当前 compaction 只保证 summary range 内的外置工具事实全部物化后才推进 watermark；历史图片在 planning/summary 投影中是文字占位，像素不会跨过 compaction 保留，未来必须增加视觉摘要/OCR 或等价策略后才能宣称多模态长期上下文无损。

runner 内置 Blob cleanup worker通常只把过期 staging orphan 标记为 `delete_pending`，再以 at-least-once 语义物理删除并转为 `deleted`；它不会自行扫描ready/session blob。`0023` T3e可以在其tenant local cutover事务中把计划内staging/ready Blob转换为精确delete outbox，之后仍复用同一cleanup worker，并只在对应outbox实际completed后写physical ACK；generic session/user purge仍没有这条接线。filesystem delete 会先持久化 key-scoped cancellation fence，阻止任何迟到 writer 在 outbox ACK 后复活对象；该微小 marker 当前不做 GC，长期 churn 会累积 metadata 文件。filesystem root 仍必须由一个服务实例独占，且本地 hard-link 原子发布不代表断电持久性；因此本地单 runner 只有显式设置 `BLOB_FILESYSTEM_SINGLE_RUNNER=1` 才能开放写入或 cleanup。该设置是运维断言而非分布式锁；TTL、outbox claim 和重试边界目前比较 runner 传入的 wall-clock 毫秒，未来多 VM 部署必须约束并监控时钟偏差或改用共享数据库时间。`NODE_ENV=production` 下 Blob 写入和 cleanup 都会 fail-closed，直到实现具有等价条件发布/删除栅栏的共享 OSS/S3 适配器。T3e local receipt仍固定全域未完成，不能据此宣称附件、大输出或完整主体已满足最终删除。

runner 启动时会同时启动 lifecycle outbox dispatcher。它只领取 `session.tombstoned`，重新读取 durable `session/deleted` 并校验 session、seq 与 generation，再发布到 event bus；claim lease/CAS 与有上限的指数退避使进程崩溃和暂时总线/存储失败可以持续恢复，不会因次数耗尽而永久停投。确定损坏的 envelope/event identity 会隔离到 dead-letter，且该 outbox 的 poison row不会阻塞后续 intent。投递是 at-least-once，丢失完成确认时允许重复发布同一 event `seq`，`SessionHost` 的订阅路径会按 seq 去重并补洞；这不是 exactly-once 承诺。

`0011_erasure_and_usage_separation.sql` 已增加 subject gate/request/audit 与 usage 财务分层；`0012_erasure_job_queue.sql` 以 expand-only 方式增加 availability、attempt、claim lease、bounded error 和 immutable policy identity；`0013_erasure_job_control.sql` 再增加 quarantine overlay、append-only `erasure_job_control_events`和`erasure_job_terminal_incidents`。Memory/MySQL 都实现 claim/renew/transition/retry queue、固定动作 session mutation 和不返回正文的 catalog。claim现在按候选独立提交：在request id、tenant/subject identity、正generation、claimable phase与created/gated/updated安全顺序仍可构成可信quarantine envelope时，request/subject/main-audit/idempotency/queue/control的确定性损坏会保留原phase、清除availability/claim/lease、写入canonical evidence和quarantine event，再继续扫描邻居；未知SQL/网络错误仍回滚当前候选，不会被误判为poison。若隔离坐标本身损坏，store在同一原子边界保留原request/identity/generation/timestamp与精确raw control fence，只清queue authority、写terminal overlay，并追加只含request locator、raw fence、固定reason、evidence SHA-256和时间的private incident；表不复制tenant/user/subject/status/raw payload且禁止UPDATE/DELETE。该路径不能安全owner-read或repair/resume，但不会猜测归属，也不会继续占据claim队首。另一个显式例外是 control generation 已达到或超过 JS safe-integer 上限：此时没有可表示的后继 event 槽位，但其余envelope仍可信，store 会用精确原始 MySQL BIGINT 生成 terminal evidence、保持该 fence 不降级、清除 worker authority并持久化为不可 repair 的 `control_audit_invalid` quarantine，而不是补造冲突 event 或让它反复占据队首。公开status只把可安全owner读取的quarantine映射成`blocked`，reason/evidence/control generation留在私有maintenance边界；repair/resume要求owner identity、subject generation、control generation与evidence CAS，并只允许reason对应的固定action。`control_audit_invalid` 与terminal incident都没有通用自动修复，不能靠直接改表或伪造主audit恢复worker authority。

runner 内嵌 worker 从 `gated` 逐 phase 推进：每次接触数据库claim前，先调用router的token-protected私有v2 barrier；router进程必须曾成功观察`RUNNERS`中每个稳定地址同时声明`erasureJobControl=["quarantine-v1","legacy-tombstone-compensation-v1"]`。已观察实例后来纯不可达时会保留本进程attestation，让存活worker仍可接管已死亡owner；明确旧版、缺少任一能力、错误protocol/service、404或畸形capability会撤销。attestation不持久化，router重启且某地址仍宕机会安全暂停claim，直到地址恢复或从配置移除；新request admission仍另外要求configured fleet当前全部健康。v1路径与ACK故意不再兼容，防止pre-0014 worker在补偿cutover期间继续claim。通过barrier后，worker经router的私有 `drain-v1` 控制面定位当前 owner，在 claim 与 session fence 同时验证后有界请求 abort active execution；若本地执行未在默认 10s 内停止，则不刷新也不主动释放其 session lease。router 只有在 Redis 明确确认 owner 不存在时才绕过原 runner；owner 仍存在或 Redis 状态未知时 fail-closed，待 lease 到期后由更高 fence 接管。worker 再按 child-first 顺序 tombstone，逐 session reconcile usage，最终以完整性计数证明停在 `awaiting_purge_policy`。catalog 的 `tombstoneProofValid` 只是早期、无正文筛查；`reconcileErasureSessionUsage` 会在写 billing fact/reconciliation 的同一 Memory 原子边界或 MySQL 事务内重新验证 marker、terminal `session/deleted` 与两条 outbox intent，proof 失效会原子转为 `blocked/integrity_conflict`，数据库/传输故障仍可重试。claim token、attempt 与 lease 共同防 ABA，过期 worker不能伪装成空 catalog或继续写入。该 user worker 不会调用 anonymize、领取 purge、物理删除内容、标记 completed 或处理 tenant erasure；tenant T2 的公开面只建立逻辑 fence，同样不会物理撤销 API key/provider/auth-secret。

`0014_legacy_tombstone_compensation.sql` 以 expand-only 方式增加默认inactive的单例cutover、每session durable job、append-only result evidence和session写入守卫；migration本身不激活cutover、不扫描历史数据、不伪造event/outbox，也不使purge可领取。全部pre-0014 writer与旧worker排空后，runner内嵌的独立补偿worker才能通过同一v2 fleet barrier把cutover从generation 0单向激活为1。激活事务与sessions INSERT/UPDATE守卫使用锁定读线性化：先观察inactive的旧写会先完成，之后任何新的`deleted_at_ms != NULL + deletion_generation=0`写都会失败；一旦激活不得回退pre-0014 writer。

补偿worker既可由仍在`reconciling_usage`的有效erasure claim定向enqueue，也会由content-free maintenance sweep覆盖没有erasure request的历史tombstone。每个job用attempt+token+lease防ABA，child-first处理，并在一个Memory原子边界或InnoDB事务内固定结算异常active turn/pending approval，保留原`deleted_at_ms`，追加连续的terminal `session/deleted`，把generation推进到1，写入即时`session.tombstoned`与仍不可领取的`session.purge` intent、append-only成功证据并完成job。任何发布步骤失败都整体回滚；确定性session/owner/child/proof冲突进入content-free terminal incident并继续邻居，未知数据库/传输错误保持可重试。该流程只补齐可核验的tombstone proof，不匿名化usage、不删除正文/receipt/Blob，也不把erasure request标记completed。

`0015_retention_policy_and_legal_holds.sql`继续expand-only且destructive-dormant：新增immutable policy version、generation-fenced active control、append-only activation event，以及tenant/user multi-hold ledger/control/event。migration不会创建默认active policy，不会设置`purge_after_ms`、开放`session.purge`、推进erasure phase、匿名化usage或删除内容；历史`legal_hold_at_ms`被转换为deterministic migration-owned canonical hold，并以rooted generation-1 event证明来源，marker-loss replay不会把后来变化的shadow误当成第二条legacy hold。策略七个duration字段的`NULL`都是fail-closed。activation提交即生效，不支持以各runner墙钟模拟未来调度；activation、hold set/release均在锁内把审计时间clamp为control的单调时间。

新user erasure request与activation锁同一tenant policy control：事务在线性化点观察到active policy就把version/hash同时写入request与首条audit；更早的backlog保持无policy身份，任何phase transition都不能补绑。MySQL的replay-safe BEFORE INSERT guards还会锁读control：inactive/无control只允许NULL/NULL，active只允许exact active pair，从而让pre-0015 writer或capability探测后的binary回退安全失败且整事务回滚。策略/hold管理由双端默认关闭的`DATA_GOVERNANCE_MANAGEMENT_ENABLED`、code-aware `dataGovernance`与management-active `dataGovernanceManagement`共同门控；它只接受admin service key，所有响应`no-store`，不授予purge能力。

`0016_erasure_purge_policy_authority.sql`继续expand-only且destructive-dormant：新增evaluation job、按build generation不可变的per-session target、rooted append-only decision、generation-CAS authority control和append-only authority。migration不回填历史`awaiting_purge_policy`、不设置`purge_after_ms`、不让`session.purge`/ready Blob delete可领取、不匿名化或删除数据，也不把request推进到`purging/completed`；历史awaiting request由新reader上线后显式调度。Memory/MySQL在`reconciling_usage → awaiting_purge_policy`的同一原子边界创建首个job，失败时request phase、audit与job一起回滚；并发历史调度通过request/job锁和唯一键只产生一个generation。

evaluator是与普通erasure worker、legacy compensation worker分离的最小权限组件，只持有`ErasurePolicyEvaluationStore`。job使用build generation、attempt/token/lease防stale/ABA，分页构建content-free target root；每个target只摘要session tombstone、ready Blob manifest、usage reconciliation/billing一致性、idempotency receipt deadline，并明确把billing fact/lifecycle audit标成retained、export artifact标成not applicable。seal在同一原子边界追加`unbound/invalid/unconfigured/held/waiting/eligible_execution_disabled`之一及可选authority；只有最后一种生成authority，但authority/control故意没有execution availability、claim或lease。runner/router的`PURGE_POLICY_EVALUATOR_ENABLED`默认`0`，每次schedule/claim前还必须取得router token-protected固定ACK；router要求全部configured稳定地址当前健康并声明`policy-evaluator-v1`。公开`dataPurgeExecution`恒为`false`。

seal会重新推导owner-scoped live inventory并核对request-bound immutable policy与tenant/user hold generation/projection。build期间出现usage、receipt、Blob或session证据变化时，store抛出显式`evidence_changed`，claim-bound retry以新build generation从空cursor/root重建；sealed authority之后的同类变化或hold set/release ABA会先撤销active projection再调度新generation，旧target/decision/authority仍不可变。target不是turns/items/events/approvals全量内容清单，无法证明没有孤儿正文；eligibility deadline当前也使用runner记录的wall clock，尚未以共享数据库/可信时间处理跨VM forward/slow skew。因此validated authority仍只是non-executable candidate。`0023` T3e不直接消费它，而是在自己的DB-time执行边界重验T3c/T3d与canonical hold，补充本地usage和Blob/export exact ACK；`0024` T3f与`0025` T3g再分别闭合本地数据库投影和session-scoped Redis三域。完整完成证明仍缺external/KMS、backup与独立故障域restore ledger、logs/traces、共享对象存储生产适配及其它completion ACK。当前`getErasureCompletionReadiness`固定返回`complete=false`。

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

`0021` T3c继续保持non-destructive：它从完整T1/T3a/T3b proof和T1绑定的immutable policy显式materialize，所有可能等待的source/policy锁之后才读取数据库时间；retention anchor必须不小于T3a credential receipt与T3b runtime receipt两个DB时间的最大值，不能假设T3b一定更晚，也不能拿T1 runner wall clock代替。DB clock低于source high-water、既定anchor或已写page evidence时分别作为可重试的`trusted_clock_before_source`、`trusted_clock_before_anchor`、`trusted_clock_before_evidence`，不会错误进入integrity block。

分页事务验证session结构列，并schema-parse turn/item/event/approval持久化snapshot后核对索引列，验证owner、parent DAG、事件引用和连续seq；receipt root绑定content-free identity、状态和关系投影，正文/user id/locator/claim token都不进入proof。`contextCompaction`是唯一允许synthetic `turnId`且没有turn row的item；如果同ID turn存在则仍必须同owner。approval canonical边是唯一同session/turn且toolCall/name一致的`approvalRequest.approvalId → Approval.id`；legacy `Approval.itemId`可以不同，仍进入历史hash但不是canonical外键。page在全部receipt INSERT后重读DB time并重验attempt/token/live lease，过期则receipt、cursor与job update整体回滚。

seal以显式`REPEATABLE READ`重扫、复算全部session receipt，并对全库五类结构表取得共享next-key/gap locks，拒绝global orphan、分页后拓扑漂移和并发插入窗口，再核对tenant及所有已知user的canonical legal-hold ledger。pre-insert `finalNow`同时写入aggregate `storeDbTimestampMs`与job `inventorySealedAtDbMs`；aggregate INSERT后的`publishNow`只重验lease并单调推进`updatedAtMs`，过期时aggregate与terminal transition整体回滚。aggregate固定`contentInventoryComplete=true`、`contentPurgeExecuted=false`，不是删除许可。

`0022` T3d继续保持non-destructive：它从完整T1/T3a/T3b/T3c、request-bound immutable policy与可信DB-time deadline显式materialize固定33域的purge plan。catalog覆盖本地关系、Blob/export bytes、Redis、external provider/KMS、backup/restore及logs/traces，不能根据当前进程装了哪些adapter而增删。每条entry只保存target count/root、固定disposition、source hash和DB capture time；正文、user id、credential、locator及raw claim token都不得进入plan。

缺失adapter必须成为可审计blocker，不能被解释成零目标。Blob/export bytes、Redis lease/fence/stream、backup、restore、logs/traces在当前本地实现中固定形成9个blocker。T3a receipt没有provider secret/BYOK-KMS细分：provider/auth均为零时external-provider/KMS两域才是`not_applicable`；仅tenant auth envelope非零时KMS域阻断，合计10个；任一provider config非零时必须把external-provider与KMS都标为`blocked_legacy_external_source_unavailable`，无论auth是否同时非零，合计11个。

生产worker对新空plan直接seal，而不是逐页发布。Memory在单一原子边界、MySQL在单个显式RR事务内重验live T3c topology、canonical tenant/全部user hold、全局owner closure、DB clock与claim lease，再一次性写全部33条entry、aggregate receipt与terminal job。owner closure要求idempotency、usage ledger/reconciliation精确对应其tenant/user/session；MySQL对这些全范围持有`FOR SHARE`锁直到commit，阻止scan后phantom写入。legacy pending idempotency的`NULL` value仍允许；冻结历史completed值`{turnId}`可以不带`sessionId`，但turn必须反向解析到收据所属的同session，显式`sessionId`若存在也必须匹配。operational usage只强制session owner，允许synthetic/legacy turn无turn row；reconciliation必须对应已tombstone的session与精确正generation。subject lifecycle↔user erasure request/tenant admission必须双向闭合，purge target必须精确匹配tombstone generation与deletion timestamp。任何孤儿、跨owner或时点漂移都fail closed；最后一个可能阻塞的写入之后lease失效会使整批回滚。分页build只保留诊断/兼容能力，不由生产worker调用，partial entry也不是sealed authority。tenant T1后仍可合法保持queued/build generation `0`的export必须进入证据，不能误判为已撤销或因falsy判断漏掉；download lease的raw token不得进入plan，只保存domain-separated hash。response loss只允许exact claim identity重放。aggregate固定`planComplete=true`、`executionReady=false`、`contentPurgeExecuted=false`，store/worker没有delete/anonymize/revoke/completion能力。

`0023` T3e增加独立execution/ACK ledger，但只开放local adapter能够安全证明的固定子集。runner内嵌worker在每次materialize、claim、lease边界及不可逆边界前，都要求router对全部configured稳定runner做fresh、non-sticky健康/capability/worker-active检查；runner和router gate均默认关闭。首次local cutover在一个Memory原子发布或MySQL事务内重新验证T3c/T3d source、immutable policy、DB-time deadline、canonical tenant/全部user hold、全局owner closure与live lease，然后按固定顺序：

1. 核对并删除该tenant的operational usage attribution，保留既有最小billing事实，写`operational_usage/anonymized` final ACK；
2. 把计划内未删除Blob绑定到精确`blob_delete_outbox`，写blocker-resolution与逐target scheduled ACK；
3. 撤销user export、清除下载lease并释放snapshot source pin，分别写control/snapshot final ACK；
4. 把计划内export part绑定到精确artifact-delete outbox，写blocker-resolution与逐target scheduled ACK。

这四类动作与domain ACK、local cutover receipt及首次write-once cutover同事务提交；任何序列化、source、hold、owner、lease、outbox或ACK写入失败都整体回滚，不能留下“数据已改而无证据”或部分ACK。outbox scheduled不是物理删除成功：既有Blob/export cleanup worker完成同一outbox id、deletion generation和target hash后，T3e才追加`physical_delete` ACK并seal local physical receipt；pending只允许重试，dead-letter在同一store边界把job阻断，不能被计为成功。响应丢失只允许exact completed claim重放。

T3e不会处理session content、idempotency receipt、Blob manifest/outbox relation、lifecycle outbox、tenant registry/profile、agent definitions、user/tenant governance evidence、Redis、external provider/KMS、backup/restore、logs/traces等其余domain，也不会把0016 authority升级为全局许可。cutover receipt固定`localDestructiveProgress=true`、`physicalAcksComplete=false`、`allDomainsComplete=false`、`contentPurgeExecuted=false`；physical receipt固定`localPhysicalAcksComplete=true`、`allDomainsComplete=false`、`contentPurgeExecuted=false`。因此它证明“本地子集发生了不可逆且可核验的进度”，不是tenant erasure completion。

`0024` T3f继续闭合本地数据库切片。runner内嵌worker只消费terminal T3e physical receipt，并在每次materialize、claim、renew、destructive execute及模糊response replay前取得router fresh、non-sticky、`no-store` ACK。固定11域覆盖tenant profile、agent definitions、session content、idempotency receipts、billing reconciliation、Blob manifest/outbox、lifecycle outbox和三类user-export数据库投影。执行前先锁定并重算T3c/T3d/T3e source、canonical hold、claim lease、settled lifecycle outbox、retained billing facts，以及T3e scheduled/physical ACK与当前Blob/export投影的双向精确集合；extra、missing、duplicate或replacement都fail closed。

同一个Memory staged publication或MySQL显式`REPEATABLE READ`事务依次发布11域pre-delete entry/receipt、为每个session写owner-bound永久grave、清空/删除数据库投影、发布domain ACK、terminal receipt/job和首次write-once cutover。tenant row只保留最小生命周期锚点，billing facts按immutable T3e operational-usage ACK及T3f count/root双重绑定保留；usage reconciliation被删除。grave以全局session id阻止跨tenant复用，但owner读取仍按tenant隔离。`ownerSha256`是与删除同事务从live session捕获、由append-only guard和运行时最小权限保护的opaque ownership claim；由于T3c session receipt不保存`userId`，它不是可脱离外部owner tuple独立重算的上游证明，全局ID防复用不依赖这种反推。失败、证据漂移或最终lease丢失会整体回滚；completed replay同时验证authorization、完整bundle、active cutover与T3c/T3d/T3e immutable source。terminal固定`localDatabasePurgeComplete=true`、`sessionContentDeleted=true`、`allDomainsComplete=false`、`contentPurgeExecuted=false`。

`0025` T3g继续闭合session-scoped Redis切片。runner内嵌worker从terminal T3f receipt materialize独立job，把T3f永久grave与T3d的`redis_leases`、`redis_fences`、`redis_streams`三条固定plan entry精确闭合为per-session target。Memory/MySQL只负责不可变job/target/ACK/domain receipt/cutover ledger；真实Redis adapter以namespace-bound operation执行物理mutation。首次mutation Lua把`${prefix}:lease:{sessionId}`、fence、stream、瞬时`evt`与永久`purge` marker放入同一cluster slot，先完整预检类型、已有marker及operation identity，再原子写无TTL、无正文marker并删除lease/fence/stream。existing-marker-only Lua则仅在exact marker已存在时按原bits再次删除可能复活的三域；marker缺失时不创建marker、不删除状态。owner目录位于lease hash内；`evt`只是Pub/Sub，不是第四个持久domain。

Redis mutation与MySQL ACK不是一个分布式事务，而是exact marker + response-loss replay的saga。lease acquire/renew/getOwner、router owner lookup、持久event publish与live publish均先检查marker，防止清理后复活；已经有durable target ACK的partial及terminal marker会在runner监听/ready前和之后周期性重放。未ACK target不进入startup projection，worker轮询后先尝试existing-marker-only replay：exact marker存在时可在gate关闭状态重新删除三域并补ACK/seal，marker缺失时零修改，再转入需要fresh gate的新mutation。fresh gate只用于materialize和新的Redis mutation，mutation前固定`gate → renew claim → gate`；worker lease至少是barrier timeout的两倍再加1秒，第二次proof后续租耗时超过lease一半则不开始mutation。claim、existing-marker replay、ACK持久化/精确重放、durable restore及全ACK seal不需要gate。namespace digest由operator提供的非密钥`REDIS_NAMESPACE_ID + REDIS_PREFIX`计算，必须准确、唯一地指向实际logical Redis cluster/database/prefix。该same-MySQL projection只能恢复已ACK marker：若Redis中只有marker、MySQL ACK尚未提交，且在worker成功replay并持久化ACK前又丢失marker，则首次lease/fence/stream existence bits也会丢失；MySQL与Redis一起恢复到旧snapshot同样不受保护。大tenant restore keyset性能、独立故障域ledger、永久marker增长与普通live-session fence灾备仍待设计/压测；当前真实Redis测试使用standalone ioredis，尚未验证真实Redis Cluster、ACL、persistence或failover。terminal固定`redisPurgeComplete=true`、`allDomainsComplete=false`、`contentPurgeExecuted=false`。

新 usage write 会在同一 store transaction 中以 opaque `usage_id` 双写 operational ledger 与严格白名单的 billing fact；后者不含 user/session/turn/step、原始 usage JSON、prompt 或 idempotency key，金额统一以 9 位小数规范字符串写入 MySQL `DECIMAL(24,9)`，避免高金额经 JavaScript 隐式字符串化产生 checksum 漂移。session/turn/event/compaction 投影以 ledger 为权威：Memory 直接聚合事实，MySQL 在同一 consistent read/业务事务快照内用 SQL summary 聚合，读取和下一次 commit 都能修复旧 writer 留下的 partial projection，而不依赖 migration 回写。对 legacy `usage_id IS NULL` 行，显式 reconciliation 会在 tombstone generation 大于 `0`、owner 匹配的前提下先固化历史 cost 归一化，再补 ID、逐行核对或插入 billing fact，最后核对 row count、各 token、known-cost row、规范化 cost 和 checksum；冲突会回滚 ID、JSON、fact 与 reconciliation，而非覆盖。session级anonymize primitive会在锁内复核checksum和durable tenant/user legal hold，只删除目标session的operational usage并保留billing fact；user erasure worker与公开API仍不调度它。`0023` T3e另在tenant local cutover事务中对sealed plan覆盖的operational usage执行等价去身份化并写fixed ACK，同样受canonical hold、source、owner和lease复验约束。未知模型价格保持cost缺失，已知零价保持`0`；历史null-ID zero保守视为unknown。普通rollup只有全部组成记录定价时才公开完整cost；硬`maxCostCNY`遇到未定价step会fail closed。

这意味着当前实现可以对active user生成时间点一致、可校验且自动过期的导出制品，并经T2 platform入口在tenant线性化点逻辑撤销现有credential/data入口，再由T3a删除本地数据库credential material、T3b清空configured-fleet runtime引用与已跟踪I/O、T3c形成DB-clock结构清单、T3d封存固定33域计划、T3e处理local usage/Blob/export bytes、T3f清除11个本地数据库内容/控制投影，最后由T3g清理session-scoped Redis lease/owner、fence与stream并安装防复活marker。但`awaiting_purge_policy`、`eligible_execution_disabled`、T3c aggregate、T3d `planComplete`、T3e/T3f/T3g terminal receipt与tenant `gated`都不是erasure completed。external provider/KMS、未纳入coordinator的background I/O、backup与独立restore ledger、logs/traces、共享对象存储生产语义及全域completion仍未闭环；generic session/user物理purge也不能由tenant T3f/T3g替代。

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
6. 普通 `commit` 永远拒绝 tombstoned session；任何 purge worker（包括T3e本地受限切片）都必须使用独立、最小权限的生命周期接口并可重入。
7. 未来最终删除 session 行，或仅保留不含个人信息的最小 grave marker；任何情况下 ID 不复用。

在保留期未确认前，安全默认是 `purge_after_ms = NULL` 且 purge worker 关闭。当前 dispatcher 仅领取立即可用的 `session.tombstoned` intent；`session.purge` intent 的 `available_at_ms = NULL`，不可领取。terminal event 完成投递也不等于已经执行任何物理清理。

`0009` 对升级前已经 deleted 的行保留 `deletion_generation = 0` 且不伪造 outbox。`0014` 已增加默认休眠、可审计且幂等的补偿流程；它只有在v2 fleet barrier通过并单向激活cutover后，才把可证明安全的历史行推进到generation 1并原子补齐terminal event与两条intent。terminal incident或仍为generation `0` 的行都不是已完成清理，T3e及后续完整purge都必须继续拒绝它们。

## 5. 各数据类型的处置

| 数据 | tombstone 后 | grace 到期后 |
| --- | --- | --- |
| session 投影 | 普通 API 不可见、不可写 | 删除或变成最小非个人 tombstone |
| turns/items/events/approvals | 不可见、不可写 | 分批物理删除 |
| completed idempotency receipt | 不再对普通请求重放 | 按 TTL 或 session purge 删除 |
| legacy pending receipt | 保留，新版本不得接管 | 仅在所有旧 runner 已 drain 后删除 |
| Redis lease/owner | 停止新订阅并完成 owner 协调 | tenant T3g以Lua删除lease hash并写永久marker；generic session/user路径仍未接线 |
| Redis fence counter | 暂时保留 | tenant T3g与lease/stream同slot原子删除并由marker阻止重建；ordinary live-session灾备仍待设计 |
| Redis hot replay stream | 停止持久发布 | tenant T3g与lease/fence同slot原子删除；`evt` Pub/Sub不是持久domain |
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

claim-bound reconciliation 已由当前 user erasure worker 调用；generic `anonymizeSessionUsage` 仍只是未接入该worker/API的最小权限 primitive。tenant T3e不复用这个入口，而是以T3d固定plan、可信数据库时间、独立destructive queue和精确local ACK完成tenant范围的operational usage去身份化。canonical tenant/user legal hold管理面与非破坏性policy evaluator已实现，generic primitive在锁内同时读取两级active集合；evaluator本身没有调用该primitive的能力。启用generic user/session批量匿名化前仍需确认 operational/billing 保留期、成本/币种和 provider/model 白名单，并补齐owner-scan/content receipt、任务游标/恢复与完成审计。若未来仍需用户级账务，应使用独立 `billing_subject_id`，删除其与真实 user id 的映射。

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

tenant scope 已完成T1/T2、T3a～T3g的本地/CI代码范围：独立admission、tenant lifecycle gate、首条audit与credential逻辑fence原子提交；T3a删除本地DB credential，T3b清空configured-fleet runtime引用/I/O，T3c生成结构proof，T3d封存33域plan，T3e完成local usage/Blob/export physical ACK，T3f清除11个数据库内容/控制投影并留下永久session grave，T3g再清理session-scoped Redis lease/owner、fence与stream并安装永久防复活marker。各破坏性阶段有独立默认关闭gate和runner内嵌worker；跨tenant读取仍不可区分，任何partial failure都不能发布terminal proof。但external/KMS、backup与独立故障域restore ledger、logs/traces、共享对象存储生产语义和全域completion仍在边界外，因此公开状态仍只能是`gated`，不是完整erasure产品闭环。

主体删除的完整目标仍应是异步、幂等的 erasure job，而不是循环调用 session DELETE：

1. 建立 generation-scoped durable request；user scope使用`erasure_requests`，tenant T1/T2使用独立`tenant_erasure_admissions`并公开只读`gated`投影，避免旧worker把无queue-authority的tenant row误当poison。T3a另用独立credential job，不复用user queue。
2. 先把 tenant/subject 标为 `deleting`；session create 和普通 runtime/Blob 写入的存储事务检查该 gate，避免枚举期间创建新数据。user scope已继续完成drain/tombstone/reconcile；tenant T1/T2覆盖普通入口，T3a/T3b清除credential/runtime引用，T3c/T3d封存结构与33域计划，T3e/T3f/T3g再完成当前本地可证明的物理字节ACK、数据库projection与session-scoped Redis清理。
3. tenant erasure立即逻辑吊销API keys并停止新使用provider/auth secrets；T1/T2完成逻辑fence，T3a物理删除本地DB API-key/provider行并清空auth三列，T3b对所有configured runner持久化runtime drain proof。外部provider/KMS撤销与远端副作用仍未覆盖。
4. 请求 owner 中断 active turn并有界 drain；超时后等待 lease 失效，再用新 fence tombstone。user scope 已实现到这里，并完成 usage reconciliation。
5. 从T3d固定catalog启动独立、默认关闭的execution plane。`0023` T3e实现operational usage去身份化、Blob/export exact outbox、export revoke/snapshot pin release与local physical ACK；`0024` T3f随后清理session/idempotency/lifecycle及Blob/export等11个数据库projection、保留billing facts并写永久grave；`0025` T3g再清理精确session的Redis lease/owner、fence与stream并写永久marker。external/KMS、backup与独立restore ledger、logs/traces、共享对象存储生产适配和全域completion仍未实现，全部gate默认关闭。
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

上传先进入 staging；manifest 与 item 原子关联后才 ready。上传成功而数据库事务失败的对象由 staging orphan sweeper 删除。该部分已经实现，并覆盖 binding/sweeper 竞态、事务回滚、跨 owner 注入、claim lease/retry/CAS complete。`0023` T3e可以按sealed tenant plan把匹配的staging/ready manifest原子标为`delete_pending`并写exact outbox，再在worker完成后seal physical ACK；目标态的普通session/user purge仍需把对应ready manifest接入自己的原子事务。worker幂等删除对象，对象已不存在视为成功，但dead-letter不能算ACK。

当前 `lifecycle_outbox` 已包含 `UNIQUE(topic, aggregate_id, generation)`、`available_at_ms`、`attempts`、claim token/lease、`last_error`、`completed_at_ms` 和 dead-letter marker，并与 tombstone 同事务写入。Memory/MySQL 都实现独立的最小权限 claim/renew/complete/retry API；这四条入口均只接受 `session.tombstoned`，即使旧版或异常进程曾为 `session.purge` 留下 claim token，也不能经通用 ACK 面续租、完成或重试。MySQL 在 `READ COMMITTED` 事务中用 `FOR UPDATE SKIP LOCKED` 非阻塞领取，所有续租、完成与重试都由 topic + outbox id + claim token + 有效 lease 做 CAS，失败消息先脱敏再持久化。

runner 内置 lifecycle dispatcher 只声明 `session.tombstoned` topic，读取并校验 durable terminal event 后发布；暂时失败以有上限退避无限重试，确定损坏才进入 dead-letter，crash-after-publish 依靠同一 event seq 重复安全。它绝不领取 `session.purge`，因此不会扩张为内容清理能力。独立 Blob cleanup worker 只领取 `blob_delete_outbox`：generic路径目前只生成stale-staging intent，tenant T3e则会从sealed plan生成ready/staging Blob与export artifact的精确outbox并等待physical ACK。worker不读取`lifecycle_outbox`；generic session/user ready-Blob purge仍未接线。

## 10. 滚动升级顺序

采用 expand → activate → contract：

1. 已增加 nullable tombstone 字段、各生命周期outbox/Blob manifest，以及 `0011` usage/subject、`0012` erasure queue、`0013` quarantine/control、`0014` legacy compensation、`0015` policy/hold、`0016` non-destructive authority、`0017` user-export substrate、`0018` tenant T1 admission/fence、`0019` T3a credential-store、`0020` T3b runtime proof、`0021` T3c content inventory、`0022` T3d fixed-domain plan、`0023` T3e execution/physical ACK、`0024` T3f database-purge evidence/grave/cutover，以及`0025` T3g Redis-purge ledger/cutover。migration本身都不执行处置或连接Redis；冻结历史fixtures会从`0007`逐段真实升级到`0025`，并验证partial DDL、marker-loss、append-only guards和migration dormancy。`0021`～`0025`都严格fingerprint engine/collation/no-partition、精确列/CHECK/index/trigger形状，并要求queue/claim时间不变量。
2. tombstone 是 protocol family `2026-10-08` 内的 additive capability，不提升 exact protocol version。客户端必须忽略未知 event；新 router 能同时探测未声明和已声明 `tombstone` 的同 family runner。
3. 先在 API gateway 暂停精确 session DELETE（或将流量整体切到 gate 为 `0` 的新 router 池），再发布新 router 并保持 `SESSION_TOMBSTONE_ENABLED=0`；在开始发布新 runner 前，排空并退出全部不能理解新 capability 的旧 router。旧 router 自身没有该 gate，因此不能在它仍接收 DELETE 时只靠逐实例替换保证一致语义；runner 端口必须保持内网不可直连，否则会绕过 gate。切换后其它 API 保持可用，精确的 session DELETE 返回可重试 `503 draining`。
4. 再滚动新 runner。router 除显式开关外还要求全部健康 runner 都声明 `tombstone`，所以旧 owner/哈希目标仍存在时不会激活新 DELETE 语义；核对配置 fleet 和 `/v1/capabilities` 后，才把新 router 的 `SESSION_TOMBSTONE_ENABLED` 设为 `1`。外部 DELETE 会改写成带 `INTERNAL_ROUTER_TOKEN` 的版本化 runner-only POST，并要求 ACK；旧 runner 只会 404，router 不会回退到旧公开 DELETE。`RUNNERS` 每项必须是实例稳定地址，不能是随机选择不同版本 Pod 的共享 LB；token 轮换期间先把 gate 恢复为 `0`。
5. Blob 写入采用另一组 expand→activate gate：新 runner 可先带 reader、manifest、worker 部署但保持 `BLOB_ATTACHMENTS_ENABLED=0`；新 router 同样保持 gate `0`。确认全部健康 runner 声明 `blobAttachments`、共享对象存储可从每个 runner 访问且 cleanup 已启用后，才同时激活写入口。关闭写 gate 不能关闭历史 ready blob 的读取。当前只有 runner-exclusive filesystem adapter，`BLOB_FILESYSTEM_SINGLE_RUNNER=1` 只允许本地单实例体验；production 配置会同时拒绝 writer 与 cleanup，不能据此演练真正的多实例 rollout。
6. user erasure、legacy补偿和policy管理采用expand→code-aware→activate：先应用 `0011`/`0012`/`0013`/`0014`/`0015`，部署新 router并保持erasure admission与governance management均为`0`，排空旧router，再滚动new runner/worker，排空pre-0014 worker并等待最大job lease过期。新runner即使management gate关闭也必须声明code-aware `dataGovernance`；只有全部configured地址健康且具备该writer语义后，router才可能恢复erasure POST。新worker每次claim或激活cutover前仍要求v2固定ACK。先按既有顺序激活compensation/ordinary worker，最后才按需依次打开runner、router的erasure admission；policy/hold管理则先逐runner开启`DATA_GOVERNANCE_MANAGEMENT_ENABLED`并核对`dataGovernanceManagement`，最后开启router gate。activation提交或首条canonical hold event之后不得恢复pre-0015 writer；关闭管理gate只关闭新管理请求，不撤销policy、hold或request binding。所有边界均只能forward-fix并保留durable证据。
7. 上述 gate 只覆盖同一 protocol family 内的 additive rollout。未来真正改变 protocol version 的不兼容变更仍需全量 drain 的维护窗口或将 router+runner 整组 blue-green，除非另行实现 version range/按版本路由。
8. 全部 legacy writer drain 后，才能清理允许删除的 pending receipt或激活0014 cutover。generation `0` 补偿已实现，但cutover本身是不可逆contract边界；不能把本地默认开启误抄成production默认，也不能用关闭feature flag撤销已经提交的activation。当前erasure worker仍最多到 `awaiting_purge_policy`；claim-stage poison进入`0013` quarantine，legacy补偿的owner/session/child/proof冲突进入独立terminal incident。两类证据都不能catch-and-skip、直接改表或伪造成成功。
9. 通用`session.purge`仍保持不可领取；canonical policy/hold authority、非破坏性evaluator、T3c结构proof和T3d固定33域plan不能直接执行。`0023` T3e、`0024` T3f与`0025` T3g分别用独立双gate和最小权限接口闭合local bytes/usage、11个数据库projection及session-scoped Redis三域，但固定不能进入公开`purging/completed`。当前旧user worker仍会对意外的`purging` claim fail-closed为`policy_unavailable`。
   后续全域execution仍必须取得external/KMS、backup/独立restore ledger、logs/traces与其它completion ACK。`0016`的`eligible_execution_disabled`、T3d的`planComplete`、T3e的`localPhysicalAcksComplete`、T3f的`localDatabasePurgeComplete`和T3g的`redisPurgeComplete`都不等于completion。
10. user export采用migration→code-aware→worker→admission：先应用`0017`，部署admission=`0`的新router/runner并排空旧进程，再先启cleanup、后启build worker，最后启runner/router writer gate。关闭admission后已有job/status/download/cleanup继续forward-fix。当前filesystem只允许local单runner；production完全不宣告该read surface且任一export flag都fail-closed，直到共享对象存储adapter完成。
11. tenant schema先expand、T2再activate：可先应用`0018`，因为migration不创建admission、不修改旧user queue/trigger；冻结0017夹具证明新表不会进入旧claim扫描。随后先发布gate=`0`的新router并排空旧router，再把全部runner升级为code-aware但gate=`0`，逐runner开启local gate并核对每个configured稳定地址，最后开启router gate。每次新的admission提交前仍即时请求fresh barrier。pre-`0018`进程不知道credential fence，旧进程彻底排空前任何环境都不得admit；首次提交后关闭gate只能停止新admission，不能撤销durable fence。精确已提交POST仍可经独立read-only route恢复原响应，其它POST fail-closed，只能forward-fix。
12. T3a采用`0019` expand→code-aware→worker→execution gate：先应用migration；发布`TENANT_CREDENTIAL_REVOCATION_EXECUTION_ENABLED=0`的新router并排空旧router；滚动`TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED=0`但声明`credential-store-v1`的新runner；逐runner开启worker，核对全部configured稳定地址健康且worker-active，最后开启router execution gate。worker每次materialize/claim及紧邻不可逆事务前都重取fresh ACK。新admission gate与execution gate独立，使关闭新POST后已有job仍可forward-fix。首个receipt激活write-once cutover后不得回退pre-`0019` writer/worker；关闭execution只暂停新批次，不恢复credential或删除证据。
13. T3b采用`0020` expand→endpoint→worker→execution gate：先应用migration；发布`TENANT_RUNTIME_DRAIN_EXECUTION_ENABLED=0`的新router并排空旧router；滚动`TENANT_RUNTIME_DRAIN_ENABLED=0`、`TENANT_RUNTIME_REVOCATION_WORKER_ENABLED=0`且配置稳定`RUNNER_ID`的新runner；逐实例开启endpoint并核对`RUNNERS`全部稳定直连origin及runner/boot identity，再开启worker，最后开启router execution。router对每个target执行前后fresh probe；任一失败不返回proof，但先前target可能已fence，必须forward-fix。关闭gate不能解除本地fence或撤销durable receipt。
14. T3c采用`0021` expand→code-aware→worker：migration只建表/index/guards，不扫描或回填内容；全量新runner先以`TENANT_CONTENT_INVENTORY_WORKER_ENABLED=0`上线，核对严格schema fingerprint、guards和new binary后再逐实例开启。不兼容的partial/manual DDL必须先受审计修复，不能让migration猜测或覆盖。关闭只暂停新工作，不删除receipt；首个证据提交后只能forward-fix。当前全库五表RR共享锁扫描是local/CI基线，M4必须用FK/owner索引/分区或等价机制替代并完成容量测试。
15. T3d采用`0022` expand→code-aware→worker：migration只建严格fingerprint/append-only guard保护的job、固定33域entry与aggregate receipt，不扫描T3c、不回填plan、不调用adapter或执行任何处置。全量新runner先以`TENANT_PURGE_PLAN_WORKER_ENABLED=0`上线，核对schema/guards/new binary后再逐实例开启。关闭只暂停新工作；`planComplete`不允许翻转`executionReady/contentPurgeExecuted`，首个证据提交后只能forward-fix。
16. T3e采用`0023` expand→code-aware→local-cleanup/worker→execution gate：先应用migration；发布`TENANT_PURGE_EXECUTION_ENABLED=0`的新router并排空旧router；滚动`TENANT_PURGE_EXECUTION_WORKER_ENABLED=0`但声明`local-execution-ack-v1`的新runner；当前仅在local单runner确认Blob/export cleanup和filesystem独占后开启worker；全部configured target都健康且worker-active后最后开启router gate。每个materialize/claim/action/physical-seal边界都重新取得fresh non-sticky ACK。首个local cutover激活write-once cutover后只能forward-fix；关闭gate不能恢复已匿名化usage、已撤销export或撤销outbox/ACK。共享对象存储adapter完成前不得在多VM/Pod或production开启。
17. T3f采用`0024` expand→**router-first parser replacement**→worker→execution gate：先应用migration；发布`TENANT_DATABASE_PURGE_ENABLED=0`且理解双capability的新router，并完全排空pre-T3f旧router；之后才滚动`TENANT_DATABASE_PURGE_WORKER_ENABLED=0`且同时声明`local-execution-ack-v1`/`local-db-content-delete-v1`的新runner。逐实例开worker，核对全部configured target worker-active，最后开router gate。旧router严格parser会拒绝新runner双值数组，所以runner-first不安全。materialize/claim/renew/destructive/replay分别取fresh no-store ACK；首个receipt后只能forward-fix。
18. T3g采用`0025` expand→marker-aware router→marker-aware runner→worker→execution gate：先应用migration，并给所有进程配置相同且准确的`REDIS_NAMESPACE_ID + REDIS_PREFIX`；发布`TENANT_REDIS_PURGE_ENABLED=0`的新router并完全排空旧router，再滚动`TENANT_REDIS_PURGE_WORKER_ENABLED=0`但声明`session-state-delete-v1`与namespace digest的新runner，并在任何T3g Redis mutation前完全排空marker-unaware旧runner。核对configured stable URLs、capability与digest一致后，保持router gate关闭并逐实例开worker，使其可恢复已有ACK marker和收口existing marker，但不能materialize或首次写marker；最后才开router gate。fresh no-store ACK只用于materialize和每次新的Redis mutation，mutation前执行`gate → renew claim → gate`；lease至少是barrier timeout的两倍再加1秒，且续租至第二次proof的耗时不得超过lease一半。claim、existing-marker-only replay、ACK持久化/精确重放、durable restore与全ACK seal不取destructive gate。首个marker/ACK/cutover后只能forward-fix；关闭router gate只暂停新materialize/mutation，worker必须保持开启以收口marker-only窗口并重放durable marker，且不得更换namespace identity。
19. usage 采用先双写、再锁内回填/核对、最后显式匿名化；不能一次 migration 直接破坏现有 attribution/唯一键。
20. staging/production 使用独立 migration Job，runner 只检查 schema；本地/CI 可继续自动迁移。barrier只能约束新worker；它不能阻止旧worker直接连接数据库或Redis，所以混跑结束、旧worker drain、最大lease等待和网络/进程层阻断是不可省略的发布条件。0014 session trigger和T3e/T3f/T3g write-once cutover只提供fail-closed/forward-only保护，不是允许旧binary继续运行的兼容承诺。

T3d的全库RR/next-key owner扫描当前只是local/CI正确性基线：生产激活前必须在staging完成索引/容量/跨tenant写阻塞/死锁/锁超时验证。损坏queued job envelope在逐候选隔离前可能饿死后续job，cursor重启还会重扫损坏前缀，但fail-closed且无receipt/执行权，M4应增raw-key quarantine/skip。`0022` trigger fingerprint不校验action body，迁移夹具只显式模拟首个DDL auto-commit边界，需作为特权schema tamper/测试深度残余继续跟踪。

当全局orphan/cross-owner损坏被检出时，当前claim会终结为`blocked`，无receipt、无执行权、不会误删；但修复底层数据后也不会自动resume/rebuild，可永久阻塞该tenant。后续需设计绑定完整性复验与审计证据的operator repair/resume协议，不能以直接SQL修改job/evidence代替。

T3d seal的owner closure还要求Memory export/user-erasure/tenant-admission request↔idempotency双向完整，并要求Memory/MySQL legacy compensation deterministic `jobId`绑定精确session owner/tombstone generation/time。MySQL还重算`candidateSha256`并校验`sourceLastSeq`；`erasure_claim`精确绑定request/generation，status精确对应单个audit/result，completed event seq等于`session.lastSeq`且success evidence完整。任一索引缺失、跨owner或proof矛盾都不得产生partial plan或aggregate；有效回归以T3c可接受的completed fixture进入该校验，不依赖旧generation-zero guard代为失败。

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

当前还覆盖`0012`到`0016`的queue/quarantine/compensation/policy/evaluator语义、`0017`export request/job原子性、RR snapshot、真实core worker跨层发布、确定性制品、下载lease、TTL/撤销delete outbox与owner隔离，tenant T1/T2的admission/platform控制，`0019` T3a的DB-time queue、物理credential-store事务、receipt/cutover、回滚、response-loss重放和隔离，`0020` T3b的configured-fleet runtime fence、per-target/aggregate receipt、exact proof replay、并发lease、回滚和隔离，`0021` T3c的source/evidence clock rollback、分页结构receipt、contextCompaction/legacy approval兼容、关系topology swap、RR orphan/hold seal、阻塞INSERT跨lease全回滚、并发与隔离，以及`0022` T3d的固定33域、9/10/11 blocker、source/hold、全局owner closure与MySQL full-range phantom阻塞。`0023` T3e覆盖Memory/MySQL原子local cutover、usage去身份化、Blob/export exact outbox和physical ACK；`0024` T3f覆盖11域数据库projection原子清理、grave/create交错、rollback与exact replay；`0025` T3g覆盖Memory/MySQL ledger、真实Redis Lua同slot首次删除/existing-marker-only replay/writer防复活、gate-off marker ACK/seal、startup/periodic durable restore，以及cluster mixed-worker/mixed-namespace/active-fleet barrier。固定历史fixtures从`0007`逐段升级到`0025`并证明DDL中断/marker-loss可恢复、旧证据保持、migration不隐式执行且原worker scheduling不变。以下矩阵中的external revoke、完整completion与独立故障域backup/restore replay仍是后续验收目标：

- Memory/MySQL conformance：archive/unarchive 幂等、archived 禁写、事件 seq 连续、tombstone 隐藏且拒写、失败全回滚。
- MySQL + Redis 并发：turn/archive/delete 竞态、stale fence、lease loss、orphan active repair。
- active turn 各阶段：reserved/running/waiting approval/settling 默认均 busy；interrupt 后可归档/删除。
- 数据完整性：purge 后内容表与 receipt/blob 清空，usage tokens/cost 校验和不变，无 dangling parent。
- tenant/user 隔离：跨主体 archive/delete/unarchive 与不存在一致。
- usage/idempotency：worker-driven reconcile 与 crash/resume 已覆盖；T3e已覆盖tenant local cutover中的policy/hold-gated operational usage匿名化，但普通user/session路径、receipt purge、长期保留期和完成审计仍未闭环。tombstone 后 receipt 不重放；legacy pending 在旧实例 drain 前保留。
- Blob/outbox：已覆盖 staging orphan、对象删除重试/重复领取、跨 tenant/user/session 注入，以及T3e exact outbox→actual completion→physical ACK；仍需普通session/user purge、批次 crash/resume 和共享对象存储故障。
- erasure/export：user gate、queue/quarantine、legacy补偿、policy/multi-hold、跨runner drain与non-destructive evaluator均已覆盖；export artifact/download/TTL也已覆盖成功、失败、并发和撤销；tenant T1/T2覆盖逻辑fence与platform控制，T3a覆盖本地DB credential清除，T3b覆盖configured-fleet runtime drain，T3c覆盖trusted DB-clock owner receipt，T3d覆盖固定33域blocker，T3e覆盖本地usage/Blob/export执行与physical ACK，T3f覆盖11个数据库projection，T3g覆盖session-scoped Redis三域。仍需generic user/session物理purge、external/KMS、backup/独立restore、logs/traces、共享对象存储生产语义及completed证明。
- rolling upgrade：additive capability、私有fleet barrier、部分回填重启和全旧实例 drain 后才激活新不变量已覆盖；固定N-1镜像的真实混版本canary仍留到M4发布编排。
- 备份恢复：T3g已在runner开放监听前及周期性从同一MySQL projection重放已有durable ACK的Redis marker；未ACK exact marker只能由worker轮询中的existing-marker-only replay收口。独立故障域erasure ledger及MySQL+Redis联合旧快照恢复仍未实现，生产恢复不能据此前提宣称不会复活。
