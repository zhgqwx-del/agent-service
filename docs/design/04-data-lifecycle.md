# 数据生命周期设计

> 状态：**Archive v2、fenced tombstone、reliable terminal-event outbox、Blob ownership/业务接线与 staging orphan 清理、usage 财务分层，以及默认关闭、最多推进到 `awaiting_purge_policy` 的 durable user-erasure worker 已实现；尚未启用 ready/session 内容的物理清理**（2026-10-08）。本文给出 M1 完整数据生命周期的实现契约和安全默认值；在策略与云数据面确定前，只允许继续实现 export、policy/repair、legacy 补偿、tenant/key revocation、restore replay 和默认关闭的 purge 路径及测试，不得自动永久删除用户内容。

## 1. 当前实现与缺口

当前 `archive/unarchive` 已通过 `SessionHost` 的同一 per-session 队列、Redis lease 与 MySQL fence 完成可逆状态转换；生命周期事件、session marker、授权和异常 pending approval 在一个 store commit 中提交。archived session 保持可读但统一拒绝 mutable runtime 操作；active turn、同 runner 并发、跨 runner takeover、历史 archived-active 行、Memory/MySQL 回滚和事件 seq 均有测试。获取新 lease 后会先用纯 `fenceClaim` 推进数据库 fence、再读取 orphan repair 快照，关闭 Redis→MySQL hand-off 期间旧 owner 仍可写的窗口。

`DELETE` 已通过 `SessionHost` 使用同一队列、lease/fence 和 orphan repair。Memory/MySQL 在一个原子 commit 中写入 tombstone marker、terminal `session/deleted`、连续 seq、单调 `deletion_generation`、立即可用的 `session.tombstoned` intent 和不可领取的 `session.purge` intent；`purge_after_ms` 安全默认为 `NULL`。普通 session/turn/item/approval/usage/receipt 随即隐藏且普通 commit 拒写，同 owner 重试幂等；已建立的 SSE 可收到 terminal event 后关闭。parent create/delete 行锁还保证并发时不会留下指向 tombstoned parent 的 child。

`BlobStore` 已有 memory 与本地文件实现；本地格式使用无大小写歧义的 key、带长度/校验和的单 envelope create-only 原子发布，并覆盖路径、权限、静态 symlink、损坏及并发测试，也可读取/删除安全 key 范围内的旧 raw + sidecar 格式。`0010` 增加 case-sensitive `blob_objects` ownership manifest 和独立 `blob_delete_outbox`；Memory/MySQL 都实现 staging/upload/原子 item 绑定、owner-scoped ready 读取、claim lease/CAS 删除与 stale staging 调度。用户图片以 opaque `blobId` 持久化，绑定前会校验声明 MIME 与文件签名，执行前还会检查所选模型的 image input 能力；大工具输出通过 `outputRef` 外置，当前 step 与重放使用同一份 JSON-safe 结果。历史按新到旧在总水化预算内读取 manifest 和对象，超出预算的旧图片/输出变成明确占位符；提交失败不会留下 ready manifest 或 item/event 半状态。当前 compaction 只保证 summary range 内的外置工具事实全部物化后才推进 watermark；历史图片在 planning/summary 投影中是文字占位，像素不会跨过 compaction 保留，未来必须增加视觉摘要/OCR 或等价策略后才能宣称多模态长期上下文无损。

runner 内置 Blob cleanup worker 目前只把过期 staging orphan 标记为 `delete_pending`，再以 at-least-once 语义物理删除并转为 `deleted`；ready/session blob 不会被该 sweeper 选中。filesystem delete 会先持久化 key-scoped cancellation fence，阻止任何迟到 writer 在 outbox ACK 后复活对象；该微小 marker 当前不做 GC，长期 churn 会累积 metadata 文件。filesystem root 仍必须由一个服务实例独占，且本地 hard-link 原子发布不代表断电持久性；因此本地单 runner 只有显式设置 `BLOB_FILESYSTEM_SINGLE_RUNNER=1` 才能开放写入或 cleanup。该设置是运维断言而非分布式锁；TTL、outbox claim 和重试边界目前比较 runner 传入的 wall-clock 毫秒，未来多 VM 部署必须约束并监控时钟偏差或改用共享数据库时间。`NODE_ENV=production` 下 Blob 写入和 cleanup 都会 fail-closed，直到实现具有等价条件发布/删除栅栏的共享 OSS/S3 适配器。session purge 与 ready blob 的原子 `delete_pending` 接线仍未完成，不能宣称附件或大输出已满足最终删除。

runner 启动时会同时启动 lifecycle outbox dispatcher。它只领取 `session.tombstoned`，重新读取 durable `session/deleted` 并校验 session、seq 与 generation，再发布到 event bus；claim lease/CAS 与有上限的指数退避使进程崩溃和暂时总线/存储失败可以持续恢复，不会因次数耗尽而永久停投。确定损坏的 envelope/event identity 会隔离到 dead-letter，且该 outbox 的 poison row 不会阻塞后续 intent；这项保证不适用于下述 `0012` erasure job queue。投递是 at-least-once，丢失完成确认时允许重复发布同一 event `seq`，`SessionHost` 的订阅路径会按 seq 去重并补洞；这不是 exactly-once 承诺。

`0011_erasure_and_usage_separation.sql` 已增加 subject gate/request/audit 与 usage 财务分层；`0012_erasure_job_queue.sql` 以 expand-only 方式增加 availability、attempt、claim lease、bounded error 和 immutable policy identity。Memory/MySQL 都实现 claim/renew/transition/retry queue、固定动作 session mutation 和不返回正文的 catalog。runner 内嵌 worker 从 `gated` 逐 phase 推进：经 router 的私有 `drain-v1` 控制面定位当前 owner，在 claim 与 session fence 同时验证后有界请求 abort active execution；若本地执行未在默认 10s 内停止，则不刷新也不主动释放其 session lease。router 只有在 Redis 明确确认 owner 不存在时才绕过原 runner；owner 仍存在或 Redis 状态未知时 fail-closed，待 lease 到期后由更高 fence 接管。worker 再按 child-first 顺序 tombstone，逐 session reconcile usage，最终以完整性计数证明停在 `awaiting_purge_policy`。catalog 的 `tombstoneProofValid` 只是早期、无正文筛查；`reconcileErasureSessionUsage` 会在写 billing fact/reconciliation 的同一 Memory 原子边界或 MySQL 事务内重新验证 marker、terminal `session/deleted` 与两条 outbox intent，proof 失效会原子转为 `blocked/integrity_conflict`，数据库/传输故障仍可重试。claim token、attempt 与 lease 共同防 ABA，过期 worker不能伪装成空 catalog或继续写入。它不会调用 anonymize、领取 purge、物理删除内容或标记 completed，也没有公开 tenant erasure 或 API key/provider/auth secret 撤销。

新 usage write 会在同一 store transaction 中以 opaque `usage_id` 双写 operational ledger 与严格白名单的 billing fact；后者不含 user/session/turn/step、原始 usage JSON、prompt 或 idempotency key，金额统一以 9 位小数规范字符串写入 MySQL `DECIMAL(24,9)`，避免高金额经 JavaScript 隐式字符串化产生 checksum 漂移。session/turn/event/compaction 投影以 ledger 为权威：Memory 直接聚合事实，MySQL 在同一 consistent read/业务事务快照内用 SQL summary 聚合，读取和下一次 commit 都能修复旧 writer 留下的 partial projection，而不依赖 migration 回写。对 legacy `usage_id IS NULL` 行，显式 reconciliation 会在 tombstone generation 大于 `0`、owner 匹配的前提下先固化历史 cost 归一化，再补 ID、逐行核对或插入 billing fact，最后核对 row count、各 token、known-cost row、规范化 cost 和 checksum；冲突会回滚 ID、JSON、fact 与 reconciliation，而非覆盖。显式 anonymize primitive 还会在锁内复核 checksum 和 durable tenant/user legal hold，只删除目标 session 的 operational usage，保留 billing fact，并支持幂等重试；legal hold 只阻止尚未发生的 `verified → anonymized` 转换，不能把已提交但响应丢失的同 checksum 重试伪装成失败。它尚未由 erasure worker 或公开 API 调度。未知模型价格保持 cost 缺失，已知零价保持 `0`；历史 `usage_id IS NULL + costCNY=0` 无法可靠区分“旧 writer 用零表示未知”与“真实免费价”，因此安全默认把它视为 unknown，新版有非空 identity 的零价仍是 known-zero。普通 rollup 只有在全部 constituent 已定价时才公开完整 cost，不能把已知小计伪装成总价。硬 `maxCostCNY` 遇到未定价的正常 step 会在该 step 落账后关闭 admission，不执行其工具或下一模型 step。

这意味着当前实现可以原子、安全地隐藏 gated user 数据、跨 runner 收口 active execution、tombstone其全部 session、核对 usage 并持续重投 terminal event；但 `awaiting_purge_policy` 仍不是 erasure completed。ready 内容、operational usage、receipt/manifest 与对象字节尚未永久删除，export、tenant erasure、附件最终清理和 restore 防复活也未闭环。`0012` 还没有 claim-stage poison quarantine：request/subject/audit/idempotency/queue 结构损坏会让 claim 事务整体回滚，同一最早候选可能持续饿死有效邻居；`0013` 必须增加 durable quarantine、append-only control audit 和带 generation/evidence CAS 的固定配方 repair/resume。成功 claim 后发现的 tombstone proof/legacy/policy 冲突才会使用现有普通 `blocked` 路径，不能把损坏的主 audit 伪装成合法状态迁移。

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
- archived session 可 GET、resume、列举 turns/items/events；默认列表隐藏，`includeArchived=true` 可见。未来 export 也必须包含 archived session，但 export API 尚未实现。
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

`0009` 对升级前已经 deleted 的行保留 `deletion_generation = 0` 且不伪造 outbox。启用 purge 前必须增加可审计、幂等的 legacy 补偿流程；不能把 generation `0` 当作已完成清理。

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

claim-bound reconciliation 已由当前 erasure worker 调用；`anonymizeSessionUsage` 仍只是未接入 worker/API 的最小权限 primitive。启用批量匿名化前仍需确认 operational/billing 保留期、成本/币种和 provider/model 白名单、legal hold 管理面、任务游标/恢复与审计策略。若未来仍需用户级账务，应使用独立 `billing_subject_id`，删除其与真实 user id 的映射。

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

user scope 已实现 durable gate 与安全的非破坏性 orchestration：`POST /v1/data-erasure-requests` 由 admin service key 代表明确 user 发起，要求 `Idempotency-Key`；Memory/MySQL 原子提交 subject=`deleting`、单调 generation、request=`gated` 和首条无正文 audit。router admission 仍要求显式 gate 与 configured fleet 全员支持；与 admission 独立的 runner worker 则会继续处理已有 request。它只持有 claim-bound、无正文的 catalog/session capability，经 router 定位 current owner并执行有界 drain，重复扫描 live leaves完成 child-first tombstone，在 usage 写入同一原子边界重验 tombstone proof并核对所有 tombstone usage，最后停在 `awaiting_purge_policy`。真实 MySQL+Redis 双 runner 测试覆盖远程慢 turn、owner `SIGKILL`、lease expiry/fence takeover、重试和无 purge。status GET 继续按 healthy fleet/selected target fail-closed；关闭 admission 不撤销 gate或停止已持久化 job。

主体删除的完整目标仍应是异步、幂等的 erasure job，而不是循环调用 session DELETE：

1. 建立 `erasure_requests`，以 `(tenant_id, subject_kind, subject_id, generation)` 唯一；user scope 已实现，tenant scope 尚未公开。
2. 先把 tenant/subject 标为 `deleting`；session create 和普通 runtime/Blob 写入的存储事务检查该 gate，避免枚举期间创建新数据。user scope 已实现该 gate，并继续完成下述 drain/tombstone/reconcile。
3. tenant erasure 立即吊销 API keys，停止使用 provider/auth secrets。
4. 请求 owner 中断 active turn并有界 drain；超时后等待 lease 失效，再用新 fence tombstone。user scope 已实现到这里，并完成 usage reconciliation。
5. 分批删除内容、receipt 和 blob；usage 按财务政策匿名化。该不可逆阶段仍未实现/激活。
6. legal hold 只暂停物理 purge，不恢复普通 API 可见性。
7. 完成记录只保存数量与校验和，不保存正文。
8. 从备份恢复后必须先重放独立故障域中的 erasure ledger，再开放流量，防止已删除数据复活；仅把 audit 放在同一 MySQL 不足以抵御恢复旧备份。

导出应使用同一 ownership 视图，生成时间点一致的 manifest，至少包含 session/turn/item/approval/usage operational data 和用户上传附件；平台 agent/provider secret、其他用户数据和内部租约信息不得导出。导出包本身也必须有 TTL 和删除任务。

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

当前 `lifecycle_outbox` 已包含 `UNIQUE(topic, aggregate_id, generation)`、`available_at_ms`、`attempts`、claim token/lease、`last_error`、`completed_at_ms` 和 dead-letter marker，并与 tombstone 同事务写入。Memory/MySQL 都实现独立的最小权限 claim/renew/complete/retry API；MySQL 在 `READ COMMITTED` 事务中用 `FOR UPDATE SKIP LOCKED` 非阻塞领取，所有续租、完成与重试都由 outbox id + claim token + 有效 lease 做 CAS，失败消息先脱敏再持久化。

runner 内置 lifecycle dispatcher 只声明 `session.tombstoned` topic，读取并校验 durable terminal event 后发布；暂时失败以有上限退避无限重试，确定损坏才进入 dead-letter，crash-after-publish 依靠同一 event seq 重复安全。它绝不领取 `session.purge`，因此不会扩张为内容清理能力。独立 Blob cleanup worker 只领取 `blob_delete_outbox`，目前 intent 只来自 stale staging sweeper；它不读取 lifecycle outbox，也不能删除 ready blob。

## 10. 滚动升级顺序

采用 expand → activate → contract：

1. 已增加 nullable tombstone 字段、parent index、两个 outbox、Blob manifest，以及 `0011` 的 usage/billing/subject 基础和 `0012` 的 erasure claim queue。`0012` 的 trigger/backfill 只让旧 0011 writer 的新 gated row 可领取，不启用 purge、不覆盖 future retry/live claim；真实冻结 0011 fixture 验证 partial DDL 与 marker-loss replay。
2. tombstone 是 protocol family `2026-10-08` 内的 additive capability，不提升 exact protocol version。客户端必须忽略未知 event；新 router 能同时探测未声明和已声明 `tombstone` 的同 family runner。
3. 先在 API gateway 暂停精确 session DELETE（或将流量整体切到 gate 为 `0` 的新 router 池），再发布新 router 并保持 `SESSION_TOMBSTONE_ENABLED=0`；在开始发布新 runner 前，排空并退出全部不能理解新 capability 的旧 router。旧 router 自身没有该 gate，因此不能在它仍接收 DELETE 时只靠逐实例替换保证一致语义；runner 端口必须保持内网不可直连，否则会绕过 gate。切换后其它 API 保持可用，精确的 session DELETE 返回可重试 `503 draining`。
4. 再滚动新 runner。router 除显式开关外还要求全部健康 runner 都声明 `tombstone`，所以旧 owner/哈希目标仍存在时不会激活新 DELETE 语义；核对配置 fleet 和 `/v1/capabilities` 后，才把新 router 的 `SESSION_TOMBSTONE_ENABLED` 设为 `1`。外部 DELETE 会改写成带 `INTERNAL_ROUTER_TOKEN` 的版本化 runner-only POST，并要求 ACK；旧 runner 只会 404，router 不会回退到旧公开 DELETE。`RUNNERS` 每项必须是实例稳定地址，不能是随机选择不同版本 Pod 的共享 LB；token 轮换期间先把 gate 恢复为 `0`。
5. Blob 写入采用另一组 expand→activate gate：新 runner 可先带 reader、manifest、worker 部署但保持 `BLOB_ATTACHMENTS_ENABLED=0`；新 router 同样保持 gate `0`。确认全部健康 runner 声明 `blobAttachments`、共享对象存储可从每个 runner 访问且 cleanup 已启用后，才同时激活写入口。关闭写 gate 不能关闭历史 ready blob 的读取。当前只有 runner-exclusive filesystem adapter，`BLOB_FILESYSTEM_SINGLE_RUNNER=1` 只允许本地单实例体验；production 配置会同时拒绝 writer 与 cleanup，不能据此演练真正的多实例 rollout。
6. user erasure 采用独立 expand→activate：先应用 `0011`/`0012`，部署新 router/runner并保持 admission `0`，排空 lifecycle-unaware writer；让全部 runner 具备 `drain-v1` 私有控制面并按需开启 `ERASURE_WORKER_ENABLED`，最后才在 runner、router依次开启 `DATA_ERASURE_REQUESTS_ENABLED`。worker capability 与 admission 独立，关闭新 POST 不能停止历史 job。任一 configured target 暂时不可达或缺能力时 POST fail-closed；状态 GET 仍按 healthy fleet/selected target检查。一旦接受 request，不能回退到 pre-`0011` writer，必须 forward-fix并保留 durable gate/audit。
7. 上述 gate 只覆盖同一 protocol family 内的 additive rollout。未来真正改变 protocol version 的不兼容变更仍需全量 drain 的维护窗口或将 router+runner 整组 blue-green，除非另行实现 version range/按版本路由。
8. 全部 legacy writer drain 后，才能清理允许删除的 pending receipt、执行 generation `0` 补偿，或把 worker推进到不可逆阶段。当前 worker最多到 `awaiting_purge_policy`；成功 claim 后发现的确定性 proof/legacy/policy 冲突可进入 `blocked`，但 claim-stage poison 当前会整批回滚。`0013` 必须先提供 quarantine/control audit 与带 CAS 的固定 repair/resume，不能 catch-and-skip 或直接改表。
9. `session.purge` 与 ready 内容的物理 purge 独立保持关闭；只有 canonical policy/hold、usage核对、备份恢复演练和校验完成后才允许启用。当前版本会对意外的 `purging` claim fail-closed 为 `policy_unavailable`；未来激活前必须升级并排空这些旧 worker，避免它们与新版 purge worker抢单。
10. usage 采用先双写、再锁内回填/核对、最后显式匿名化；不能一次 migration 直接破坏现有 attribution/唯一键。
11. staging/production 使用独立 migration Job，runner 只检查 schema；本地/CI 可继续自动迁移。

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

当前还覆盖 `0012` queue 的 exact lease/ABA/audit rollback、claim-bound固定 session action、content-free catalog/completeness proof、catalog→usage 间 proof 损坏的事务内重验、core phase/crash retry，以及真实 MySQL+Redis 双 runner 的 remote active-turn drain、child-first tombstone、usage reconcile、owner SIGKILL/fence takeover。固定 0011 历史 fixture证明 DDL 中断/marker-loss可恢复且不偷取 future retry/live claim。worker 只到 `awaiting_purge_policy`，claim-stage poison quarantine/repair仍待 `0013`；因此以下矩阵中的 destructive purge、export、tenant/key revocation与 backup replay 仍是后续验收目标：

- Memory/MySQL conformance：archive/unarchive 幂等、archived 禁写、事件 seq 连续、tombstone 隐藏且拒写、失败全回滚。
- MySQL + Redis 并发：turn/archive/delete 竞态、stale fence、lease loss、orphan active repair。
- active turn 各阶段：reserved/running/waiting approval/settling 默认均 busy；interrupt 后可归档/删除。
- 数据完整性：purge 后内容表与 receipt/blob 清空，usage tokens/cost 校验和不变，无 dangling parent。
- tenant/user 隔离：跨主体 archive/delete/unarchive 与不存在一致。
- usage/idempotency：worker-driven reconcile 与 crash/resume 已覆盖；仍需 policy-gated anonymize、receipt purge、长期保留期和完成审计。tombstone 后 receipt 不重放；legacy pending 在旧实例 drain 前保留。
- Blob/outbox：已覆盖 staging orphan、对象删除重试/重复领取、跨 tenant/user/session 注入；仍需覆盖 session purge 原子调度全部 ready blob、批次 crash/resume 和共享对象存储故障。
- erasure：user gate、正常 queue、跨 runner drain、状态推进到 policy boundary、批次游标与 crash/resume 已覆盖；仍需 claim-stage poison quarantine/control audit/CAS repair、canonical policy、generation `0` 补偿、tenant key/secret 先失效、export artifact/TTL、physical purge 和 completed 证明。
- rolling upgrade：旧/新 runner 混跑、feature gate、部分回填重启、全旧实例 drain 后才激活新不变量。
- 备份恢复：先重放 erasure ledger，已删除主体的数据不会重新开放。
