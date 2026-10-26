# 普通 session DELETE 的 30 天内容宽限期：0050 默认休眠证据切片

当前规范（2026-10-25）：本页0050/0051来源与恢复原语已实现并纳入61c本地/CI范围；精确证据见 [PROGRESS](../PROGRESS.md)。用户已确认普通 session DELETE 的内容宽限期按 **30 天**实现，自动物理清理默认关闭。`0050` 只建立来源和事后数据库时间证据；没有启用清理，也没有把 M1 数据生命周期宣称为完成。现有 `purge_after_ms = NULL`、不可领取的 `session.purge`、user/tenant erasure、canonical retention policy、legal hold 和 completion 语义均保持不变。

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

`0050` 是 expand-only nullable 列与 CHECK；不回填、不联网、不改变公开 API 或 bundle。后续恢复caller只是runner内嵌、默认关闭的代码接线，没有独立服务、进程、schema或镜像。`0050` 本身不增加 trigger；启动检查精确列形状与真实 MySQL 归一化后的完整 CHECK 摘要，同名但被放宽的约束也会拒绝，marker 丢失且已有 origin 时拒绝重放。

`0051` 再以独立additive `BEFORE UPDATE` trigger保护**已存在的可信0050证据**：origin只能与首次live→tombstone更新一起写入，不能给已删除而无来源的旧行补造；一旦非NULL，origin digest、DB时间和其绑定的owner/deletion generation/event cursor不可改变。seal只能在旧行版本已经有origin时从NULL写入，写成后seal时间、floor和digest均不可修改。这个trigger本身不能证明origin来自已COMMIT的上一事务；post-COMMIT保证仍由受信任store的两事务流程、行锁和DB时间复核提供。trigger允许原有普通DELETE首事务、post-COMMIT seal、无来源的user/tenant/legacy tombstone以及T3f按canonical owner删除整行；它不为旧writer补来源，也不阻止旧普通DELETE writer继续写出`unknown`。启动会核对trigger完整动作与schema/marker，marker丢失但精确trigger已安装可安全重放，变更动作会fail closed。0051 migration前必须先关闭DELETE流量并排空pre-0051 writer；严格指纹使旧binary不能在新schema安全重启，只能forward-fix。

这**不是mixed-writer coverage cutover**。数据库仅凭同形的`session/deleted`/outbox无法区分旧普通DELETE、user erasure、tenant erasure或legacy compensation；若要在SQL层拒绝所有post-cutover无来源的普通DELETE，需要跨全部tombstone路径的可信来源分类、原子证据、旧writer停服和不可逆cutover，不能让caller自称“erasure”来绕过。直接拥有sessions DDL/UPDATE特权的主体仍可篡改trigger或伪造一条新来源，所以runtime与migration principal必须最小权限隔离并监控schema drift。保持所有无来源行`unknown`与`physicalPurgeEnabled=false`，不得借0051声称30天生命周期已完整覆盖或清理可执行。

恢复caller可在0050 schema和新writer全部就绪后单独逐实例开启；开启前应排空pre-0050普通DELETE writer及在途请求，以免把旧writer产生的`unknown`误报为已覆盖。恢复只补已提交的可信origin，不能为旧行制造来源；关闭它不会缩短任何已封存floor或开放物理清理，但未封存行仍需后续安全收敛。

Memory/真实 InnoDB 测试覆盖原子成功与回滚、origin 已提交但 seal 未提交、精确重试与并发 seal、owner 隔离、来源漂移、时钟回退与上溢、同名 CHECK drift 拒绝，以及默认不清理。独立真实 MySQL 历史夹具从 `0044` 预置状态升级到 `0050`（若并行 `0049` 已纳入则一并升级），证明旧 tombstone 不回填、部分 DDL 可收敛、冲突 shape 和 marker-loss fail closed；required migration wrapper 必须证明该套件实际执行。普通 DELETE→T3f 的真实 MySQL 成功及 destructive 回滚已验证：先按正常 outbox claim/ACK 清除 pending tombstone gate，T3f 成功时 evidence 随 session 删除，失败时一起回滚且 evidence 保留。旧二进制在新 schema 的实际写入行为、canonical policy/hold 与完整恢复/自动清理仍需要后续独立验收；未完成前不能宣称 30 天物理生命周期已经闭环。

实现定位：[来源codec](../../packages/store/src/session-delete-grace.ts)、[Host普通DELETE](../../packages/core/src/session/host.ts)、[默认关闭恢复caller](../../packages/core/src/lifecycle/ordinary-session-delete-grace-recovery.ts)；自动物理purge仍属待实现/待验范围。
