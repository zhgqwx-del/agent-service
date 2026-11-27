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
