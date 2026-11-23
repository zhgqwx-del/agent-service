# Redis ACL/AOF 冷启 CI 门禁修复

- 变更 ID `003-ci-redis-aof`
- 开发基线 `main / 166be40f63f6345087924ec3d03b1be486f249c3`，现有 CI-01 验收记录及本地诊断随工作树保留。
- 合入目标 `origin/main`，已授权单独提交和正常推送。最终 Linux 验收以受测提交的 CI 为准。
- 状态 已推送 `f4aa21d`。Linux Redis ACL/AOF 与 runner 镜像门禁已通过，完整 CI 因第 3 分片失败仍待验收。 [验收记录](verification.md)
- 确认记录 用户在会话中批准按诊断的最小方案独立修复并定向验证。首个产品变更继续待定。 [原失败作业](https://github.com/zhgqwx-del/agent-service/actions/runs/44649511798/job/136000566877) · [首个产品变更](../001-first-slice/change.md)

## 目标与影响

runner 镜像作业的 Redis ACL/AOF 入口继续验证干净源码、原生编译及两次冷启。本变更以受测提交的精确 Git 树替换历史输入数量，并让证据导出器校验 CI-01 的 26 条原生命令和相应日志。 [规格](spec.md) · [实施任务](tasks.md)

## 关联讨论与 ADR

采用会话确认的两项局部修复。真实 Redis 8.4.7、ACL 校验、冷启断言、失败状态和后续 runner 门禁保持。0055 的测试和原失败证据已有独立记录。 [讨论与架构决策约定](../../docs/stdd/decisions-and-discussions.md) · [CI 现有约定](../../docs/operations/development-and-ci-guide.md#8-github-actions-构建与验证)

如后续门禁失败，保留该运行的日志、原始配置证据和已通过步骤。按实际首个失败边界评审前向修复，继续执行既有门禁。 [验收计划](test-plan.md)
