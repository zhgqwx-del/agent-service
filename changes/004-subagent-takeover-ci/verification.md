# 子 Agent 接管 CI 验证

独立工作树基于已刷新 `origin/main` 的 `771c0b8f1ad329e6b98e504bf87f478ec33b6b9e`。测试仅使用隔离数据库、Redis 和合成模型/工具数据。

原始 CI 的首次子审批 POST 返回 409，位于 root 进程故障注入之前。新工作树上未改产品实现时，`pnpm run test:subagents-cluster` 使用本地 MySQL 8.0.46、Redis 8.10.3 和真实进程执行一项通过，耗时 15.3 秒。接下来用确定性发布屏障检验该竞态。

## 复现与修复

新增 Host 回归让事件发布停在真实提交之后。旧实现上 pending 审批已经可查，调用同一 Host 的子审批入口却抛出 `session_lease_conflict`（HTTP 409），Mono 回执 `run-3b62c97f2d3f`。该错误对应 CI 中首次子审批的失败阶段。

修复在提交可读前注册等待器，审批入口先查持久记录，且每个等待器只消费一次决定。取消、超时和提交异常均清理等待器。原审批截止时间仍是 `expiresAtMs`。发布解除后，测试确认决定被持久化，工具执行一次。

| 定向入口 | 实测 |
| --- | --- |
| `pnpm run test:subagents` | 153 项通过，包含新增发布屏障回归。开启回环 FakeMcp 监听权限后的回执为 `run-c05139b8b887`。 |
| `pnpm run test:subagents-cluster` | 隔离 MySQL 8.0.46、Redis 8.10.3 下真实进程接管 1 项通过。同一工具副作用只执行一次，回执 `run-e38c8db7a727`。 |
| `pnpm run test:subagents-mysql` | MySQL 存储和实际 HTTP App 共 13 项通过，回执 `run-d611bd35e656`。 |
| `pnpm exec vitest run packages/core/test/host.test.ts packages/core/test/host-erasure.test.ts` | 96 项通过。 |
| `pnpm typecheck` 与 `git diff --check` | 退出 0。 |

上述定向测试使用 `771c0b8` 上的修复工作树。完整远端门禁绑定提交后的候选。

## 用户擦除套件的 MySQL 元数据锁

PR #2 第三次 CI 的七项擦除断言全部通过，`afterAll` 在应用库元数据锁计数为 1 时保留了夹具。远端日志记录了计数。[失败作业](https://github.com/zhgqwx-del/agent-service/actions/runs/45928842657/job/140332273129)

在隔离的 MySQL 8.0.26（macOS arm64）上做受控复现。先关闭套件的应用连接，用一致性快照留住临时测试表的旧行版本，再于元数据锁检查前提交快照。应用连接和事务计数均为 0。旧检查采到一把 `TABLE / SHARED / EXPLICIT / GRANTED` 锁，持有者是没有 `PROCESSLIST_ID` 的后台线程 `thread/innodb/srv_worker_thread`。后续采样归零，旧检查仍按最初快照拒绝清理。

新增三项驱动级回归先失败，修复后通过。应用库锁查询在同一次采样中统计所有锁和已识别的 purge 锁。仅当所有锁均符合该线程和锁形态时，才在 500 ms 窗口内复查。只有原锁计数与 purge 计数均为 0 才能继续。未知锁、混合锁及持锁超过窗口均保留夹具。受控复播实测总锁数和 purge 锁数依次为 `1/1 → 1/1 → 2/2 → 0/0`，七个用例和清理全部通过。真实擦除及集群用例仍使用隔离数据库与 FakeVendor。

`pnpm run test:schema-fixtures`、`pnpm typecheck` 及 `git diff --check` 通过，运行时夹具单元套件 50 项。使用隔离 MySQL 8.0.26 和 Redis 定向实跑，用户擦除七项、真实进程接管一项，两个套件全部通过。

## 遥测单项预算和主测试分片

CI `45956642213` attempt 3 的遥测 `a03` 在 26.357 秒进入主体，30.421 秒完成清理。只将该用例的总时限调至 45 秒。[原始失败作业](https://github.com/zhgqwx-del/agent-service/actions/runs/45956642213/job/140439400533)

使用同一次 CI 的 460 个套件耗时，保留 78 个至少耗时五秒的套件作为分片权重，其余文件以一秒估算。根据 Vitest 实时发现的完整集合分配，三个分片分别有 154、151、155 个文件。以原始耗时回放，三片分别约为 44.14、44.22、44.32 分钟。收集与聚合分别核对精确分片归属，聚合仍验证原生制品、同一次运行、完整发现集合和既有覆盖率阈值。

实现前回归确认分片未按耗时分配，错放到其他分片的报告会被接受，收集配置也缺少排序器。改动完成后 `pnpm run test:ci-shards` 的五个规定套件共 472 项通过，类型检查通过。原生入口复核两个配置发现同一 460 个文件，三分片实际运行六个定向套件，原生 blob 合并覆盖全部 486 个断言。完整覆盖率门禁以最终候选的远端 CI 为准。

隔离 MySQL 8.0.26 上，遥测应用捕获 12 项和用户擦除 7 项实际运行并通过。遥测 `a03` 在 8.401 秒通过，收尾断言继续执行。
