# 数据生命周期设计

> 状态：**待产品/合规确认，尚未启用物理清理**（2026-09-26）。本文给出 M1 完整数据生命周期的实现契约和安全默认值；在“待确认策略”确定前，只允许继续实现可逆状态机、租约协调、ownership manifest、outbox 和测试，不得自动永久删除数据。

## 1. 当前实现与缺口

当前已有的 `archive` 只是设置 `archivedAtMs` 并从默认列表隐藏；`DELETE` 只是设置 `deleted_at_ms`，普通读取看不到 session，但 turns、items、events、approvals、idempotency receipts 和 usage 仍无限期保留。两条路径都没有完整的 active-turn/lease 协调。

`BlobStore` 已有 memory 与本地文件实现；本地格式使用无大小写歧义的 key 和版本化 ref、带长度/校验和的单 envelope 原子发布，并覆盖路径、权限、静态 symlink、损坏及并发测试，也可读取/删除安全 key 范围内的旧 raw + sidecar 格式。但它尚未接入 item，也没有数据库 ownership manifest、事务 outbox 或孤儿回收；filesystem root 仍必须由服务独占，且本地 rename 不代表断电持久性。`outputRef` 因此仍只是协议预留字段，不能当成已完成的大输出生命周期。

这意味着当前实现可以安全隐藏数据，但不能宣称已满足永久删除、用户主体删除、财务保留或附件清理要求。

## 2. 生命周期模型与不变量

运行状态与生命周期状态正交：

- 运行状态：`idle | active | error`
- 生命周期状态：`visible | archived | tombstoned | purging | purged`

必须保持以下不变量：

1. session 生命周期变更与 turn 使用同一 lease/fence，并进入同一 per-session 串行队列；HTTP 层不得旁路 `SessionHost` 直接修改 store。
2. tombstone 一旦提交，普通 API 统一表现为 `404`，普通 commit 必须失败，session ID 永不复用。
3. archive 可逆；DELETE 对普通用户不可逆。grace period 只服务后台恢复、legal hold 和最终清理，不是用户回收站。
4. 内容数据与财务事实分开处理；删除内容不能静默丢账，也不能让完整 prompt/工具输出伪装成“审计日志”长期保留。
5. events 包含 item、turn、approval 快照，必须与 session 内容执行相同的删除策略。
6. 跨 tenant/user 操作继续返回与不存在相同的 `404`，不能形成存在性 oracle。
7. MySQL 事务不能包含对象存储删除；必须用事务 outbox 保证最终完成与安全重试。

## 3. Archive 推荐语义

推荐直接采用以下默认值：

- `POST /v1/sessions/{id}/archive` 幂等；只允许非 active session。
- 新增 `POST /v1/sessions/{id}/unarchive`，幂等恢复。
- archived session 可 GET、resume、列举 turns/items/events 和导出；默认列表隐藏，`includeArchived=true` 可见。
- archived session 禁止新 turn、steer、compact、approval decision 和 dynamic tool result，返回 `409 session_archived`。
- archive/unarchive 产生持久事件 `session/archived` / `session/unarchived` 并递增 seq。
- archive 清空 `autoApprovedTools`，异常残留的 pending approval 置为 expired；恢复后重新审批。
- active session archive 返回 `409 session_busy`，不隐式中断模型或工具。调用方可先 interrupt，再重试 archive。

turn 与 archive 竞态只允许两种结果：archive 先提交时 turn 不产生 receipt/item/event；turn 先提交时 archive 返回 busy。数据库显示 active 但 lease 已失效时，先由新 owner 按既有 orphan repair 结算旧 turn，再 archive。

## 4. DELETE、tombstone 与 purge

保留当前 `204` HTTP 行为，但把实现收紧为：

1. DELETE 获取 lease/fence，在行锁事务中确认 session idle。
2. active session 默认返回 `409 session_busy`，不把“删除”与强制中断外部副作用混成一次同步操作。
3. tombstone 事务原子写入 `deleted_at_ms`、nullable `purge_after_ms`、单调 `deletion_generation`、删除请求事件和 purge outbox。
4. tombstone 提交后，所有普通资源 API 立即 `404`；已建立 SSE 收到删除事件后关闭。
5. 同一 owner 在 grace 内重复 DELETE 返回 `204`；跨 user/tenant 仍为 `404`。
6. purge worker 使用独立、最小权限的生命周期接口并可重入；普通 `commit` 永远拒绝 tombstoned session。
7. 最终删除 session 行，或仅保留不含个人信息的最小 grave marker；任何情况下 ID 不复用。

在保留期未确认前，安全默认是 `purge_after_ms = NULL` 且 purge worker 关闭。这样可以先完成正确的 tombstone/outbox 机制，而不会擅自执行不可逆删除。

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

目标态分两层：

- operational usage ledger：短期保留 tenant/user/session/turn/step，用于重试、查询和对账。
- billing ledger：长期仅保留 tenant、accounting period、provider/model、tokens/cost/invoice，以及政策允许的 pseudonymous subject；不保留 prompt、item 或原始 idempotency key。

purge 必须先用稳定 `usage_id` 幂等汇总到 billing ledger，核对 tokens、cost、row count 校验和，再清除 user/session/turn 直接归因并删除 operational row。若仍需用户级账务，应使用独立 `billing_subject_id`，删除其与真实 user id 的映射。

原始 `Idempotency-Key` 后续应改为服务端 HMAC 后的确定性值；客户端可能误把邮箱等个人信息放进 key，当前明文存储会扩大个人信息面。

## 7. 父子 session

当前创建时已强制 parent 与 child 属于相同 tenant/user。生命周期还需补：

- `parent_session_id` 索引和显式关系类型，至少区分 `subagent` 与 `fork`。
- 删除 child 不影响 parent。
- user/tenant erasure 覆盖该主体的全部 session，不受关系类型影响。
- 关系类型落地前，目标 session 存在活跃 child 时 DELETE 默认 `409 session_has_children`；不得静默级联或留下 dangling parent。
- 推荐未来语义：`subagent` 随 parent 删除；`fork` 默认独立，只清除 lineage。fork 是否包含独立内容副本仍需产品确认。
- archive 默认只作用于目标 session；是否级联归档 subagent 需产品确认。

## 8. User/Tenant erasure 与导出

主体删除应是异步、幂等的 erasure job，而不是循环调用 session DELETE：

1. 建立 `erasure_requests`，以 `(tenant_id, user_id?, generation)` 唯一。
2. 先把 tenant/subject 标为 `deleting`；session create 和 turn start 的存储事务检查该 gate，避免枚举期间创建新数据。
3. tenant erasure 立即吊销 API keys，停止使用 provider/auth secrets。
4. 请求 owner 中断 active turn并有界 drain；超时后等待 lease 失效，再用新 fence tombstone。
5. 分批删除内容、receipt 和 blob；usage 按财务政策匿名化。
6. legal hold 只暂停物理 purge，不恢复普通 API 可见性。
7. 完成记录只保存数量与校验和，不保存正文。
8. 从备份恢复后必须先重放 erasure ledger，再开放流量，防止已删除数据复活。

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

上传先进入 staging；manifest 与 item 原子关联后才 ready。上传成功而数据库事务失败的对象由 staging orphan sweeper 删除。session purge 事务只标记 `delete_pending` 并写 outbox；worker 幂等删除对象，对象已不存在视为成功。

outbox 至少包含 `UNIQUE(topic, aggregate_id, generation)`、`available_at`、`attempts`、`last_error`、`completed_at`，用 `FOR UPDATE SKIP LOCKED` 领取，指数退避并支持 dead-letter。本地运行相同 worker/脚本；未来云上只改变执行载体，不改变语义。

## 10. 滚动升级顺序

采用 expand → activate → contract：

1. 先增加 nullable lifecycle 字段、关系类型、manifest/outbox/erasure 表与索引；旧代码可忽略。
2. 新代码把空 lifecycle 当作 visible，并继续双写兼容的 `archived_at_ms` / `deleted_at_ms`。
3. mixed fleet 期间新生命周期语义和物理 purge feature flag 保持关闭。
4. 全部旧 runner drain 后，确认无 legacy writer，再清理允许删除的 pending receipt，启用 archived 写保护和 erasure gate。
5. 只有完成备份恢复演练和校验后才启用 purge worker。
6. 新生命周期 event 只做 additive protocol 变更；客户端必须忽略未知 event，并同步提升 protocol version/capability。
7. usage 匿名化字段先双写、回填、核对，不能一次迁移直接破坏现有 attribution/唯一键。
8. staging/production 使用独立 migration Job，runner 只检查 schema；本地/CI 可继续自动迁移。

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

- Memory/MySQL conformance：archive/unarchive 幂等、archived 禁写、事件 seq 连续、tombstone 隐藏且拒写、失败全回滚。
- MySQL + Redis 并发：turn/archive/delete 竞态、stale fence、lease loss、orphan active repair。
- active turn 各阶段：reserved/running/waiting approval/settling 默认均 busy；interrupt 后可归档/删除。
- 数据完整性：purge 后内容表与 receipt/blob 清空，usage tokens/cost 校验和不变，无 dangling parent。
- tenant/user 隔离：跨主体 archive/delete/unarchive 与不存在一致。
- usage/idempotency：汇总重试不重复计费；tombstone 后 receipt 不重放；legacy pending 在旧实例 drain 前保留。
- Blob/outbox：DB 回滚产生的 staging orphan、对象删除重试、重复投递、跨 tenant blob 注入。
- erasure：gate 与 createSession 竞态、任务 crash/resume、legal hold、批次游标、tenant key/secret 先失效。
- rolling upgrade：旧/新 runner 混跑、feature gate、部分回填重启、全旧实例 drain 后才激活新不变量。
- 备份恢复：先重放 erasure ledger，已删除主体的数据不会重新开放。
