# 普通 session DELETE 的 30 天内容宽限期：0050 默认休眠证据切片

状态：用户已确认普通 session DELETE 的内容宽限期按 **30 天**实现，自动物理清理默认关闭。`0050` 只建立来源和事后数据库时间证据；没有启用清理，也没有把 M1 数据生命周期宣称为完成。现有 `purge_after_ms = NULL`、不可领取的 `session.purge`、user/tenant erasure、canonical retention policy、legal hold 和 completion 语义均保持不变。

## 为什么不能从旧 tombstone 推断

普通 API DELETE、user-erasure session action、legacy compensation 和旧 writer 可留下同形的 `session/deleted`、`session.tombstoned`、`session.purge`。`deleted_at_ms` 又来自 runner 时钟，不可用作跨机器可信 30 天起点。所有升级前、旧 writer、erasure 或来源缺失的记录一律为 `unknown`，不得回填 ordinary origin。

即使在 MySQL 删除事务最后读 `CURRENT_TIMESTAMP(3)`，其时间仍早于真正 COMMIT。单用这个时刻加 30 天可能少保留提交后的时间。因此 `0050` 分为原子来源和 post-COMMIT seal 两步。

## 已实现的证据与隐私边界

1. 新普通 `SessionHost.deleteSessionLocked` 只调用专用可信 `commitOrdinarySessionDelete`，通用 `commit` 拒绝任何 caller-supplied ordinary 来源字段；内存/数据库实现使用实例私有的短时 capability 区分写入口，而不是相信生命周期数据。Memory 在单一发布边界、MySQL 在 event、两条 outbox 与 tombstone 的同一事务内，把 versioned origin digest 和首次 DB-time 高水位写在**同一 `sessions` 行的 nullable 列**。digest 绑定真实 owner tuple、generation、terminal event seq、两条 outbox 的逻辑 identity 和来源版本，但列本身不额外保存 tenant/user/session 原文。MySQL 约束禁止部分列、未 tombstone 或排期 purge 状态；普通 writer 还在 COMMIT 前回读 origin，阻断 silent trigger strip。写入失败时 event/outbox/tombstone/origin 全回滚。旧 writer 在新 schema 只会留下 NULL origin，即 `unknown`。
2. 第一事务成功 COMMIT 后，独立事务锁定精确 tenant/user/session 行和 terminal source，核验 event、两条 outbox 与不可领取的 purge，**完成所有可能等待的锁以后**再读 DB time，并以 `seal_observed_db_ms + 1 + 2_592_000_000` 封存最低保留 floor。`databaseNow()` 对 `CURRENT_TIMESTAMP(3)` 向下截毫秒，`+1ms` 保守地落在真实观测之后。时间回退、溢出、来源漂移都 fail closed；第二事务失败只留下未封存 origin。相同 owner 的 DELETE 重试、并发 seal 或显式调用同一恢复原语可 exact replay；无 origin 时绝不根据同形 event/outbox 补造。
3. `retryUnsealedOrdinarySessionDeleteGraceOrigins(limit)` 是每批至多 100 条的恢复原语：只扫描已提交且未封存的 origin，每条仍走相同锁定/复验/CAS seal。runner现有独立的`SESSION_DELETE_GRACE_RECOVERY_ENABLED`默认关闭入口；开启时内嵌轮询只调用这一原语，默认每30秒、每批最多25条，停机先等待已启动的扫描，且没有排期/领取/执行`session.purge`的方法。多runner扫描可能重复尝试同一行，但seal由行锁和write-once CAS串行化；缺证据或行已被T3f删除时安全跳过。损坏的候选会fail closed并阻断该批后续候选，当前没有逐行quarantine或带游标跳过协议；必须由operator先修复可信来源，不能靠忽略错误宣称恢复完成。MySQL扫描当前没有专用候选索引，单批也没有统一whole-operation deadline，规模/锁等待和停机耗时须在staging验收。默认关闭不代表已自动收敛。
4. T3f 的既有 destructive 事务删除 `sessions` 行；因此 origin/seal 随 canonical owner 同事务消失，不会留下独立永久 raw owner sidecar，也不改变 T3f 的 session-content count/root。T3f 后 owner-scoped 读返回 `null`。digest 只在 session 行存活时存在，不是 T3f 后的独立 closure proof。

只读 `getOrdinarySessionDeleteGrace` 最多返回 `state=sealed` 和 `graceFloorDbMs`；固定 `executionReady=false`、`physicalPurgeEnabled=false`，不暴露“到期/可删除”判断，也不改变 outbox 排期。它不是删除授权。未来 executor 必须在不可逆动作前，以可信 DB-time 重新核对删除时与当前 canonical policy（90 天不能被 30 天缩短，必要期限为 NULL/未知则不能推断可删）、legal hold、owner/source、Blob/usage/receipt、备份/恢复及外部 domain ACK，并经独立默认关闭的 fleet gate。

## 升级、测试和剩余门禁

`0050` 是 expand-only nullable 列与 CHECK；不回填、不联网、不改变公开 API 或 bundle。后续恢复caller只是runner内嵌、默认关闭的代码接线，没有独立服务、进程、schema或镜像。它不增加现有 trigger 的数量；启动检查精确列形状与真实 MySQL 归一化后的完整 CHECK 摘要，同名但被放宽的约束也会拒绝，marker 丢失且已有 origin 时拒绝重放。对旧 DELETE writer 的新 schema 写入没有数据库强制双写：它只能保持 `unknown`，不能将 mixed-writer 状态称为完整覆盖。`0050` 尚未建立可供物理清理使用的 SQL-level write-once origin guard；新旧 writer 切换、最小权限和 schema drift 监控仍是部署门禁。

恢复caller可在0050 schema和新writer全部就绪后单独逐实例开启；开启前应排空pre-0050普通DELETE writer及在途请求，以免把旧writer产生的`unknown`误报为已覆盖。恢复只补已提交的可信origin，不能为旧行制造来源；关闭它不会缩短任何已封存floor或开放物理清理，但未封存行仍需后续安全收敛。

Memory/真实 InnoDB 测试覆盖原子成功与回滚、origin 已提交但 seal 未提交、精确重试与并发 seal、owner 隔离、来源漂移、时钟回退与上溢、同名 CHECK drift 拒绝，以及默认不清理。独立真实 MySQL 历史夹具从 `0044` 预置状态升级到 `0050`（若并行 `0049` 已纳入则一并升级），证明旧 tombstone 不回填、部分 DDL 可收敛、冲突 shape 和 marker-loss fail closed；required migration wrapper 必须证明该套件实际执行。普通 DELETE→T3f 的真实 MySQL 成功及 destructive 回滚已验证：先按正常 outbox claim/ACK 清除 pending tombstone gate，T3f 成功时 evidence 随 session 删除，失败时一起回滚且 evidence 保留。旧二进制在新 schema 的实际写入行为、canonical policy/hold 与完整恢复/自动清理仍需要后续独立验收；未完成前不能宣称 30 天物理生命周期已经闭环。
