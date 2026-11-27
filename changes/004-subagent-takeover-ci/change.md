# 子 Agent 接管 CI 修复

- 变更 ID `004-subagent-takeover-ci`，对应 Mono `AGENT-CI-001`，为 DIANDI-001 的 Agent 主干收尾提供验证。
- 用户已确认从最新 `origin/main` 建独立工作树，先复现和定向验证，再执行完整 CI。
- 开发分支 `codex/agent-ci-001`，刷新后的基线与合入目标 SHA 为 `771c0b8f1ad329e6b98e504bf87f478ec33b6b9e`。

子 Agent 接管用例在 root 进程故障注入前提交首次审批，实际得到 409。验收要求在审批已持久化且当前 root 仍持有租约时，正常提交决定并且只执行一次已授权工具。现有过期、失去所有权、晚写和防重放判据继续执行。 [失败作业](https://github.com/zhgqwx-del/agent-service/actions/runs/45850360279/job/140243535454) · [工程约定](../../docs/engineering.md) · [讨论与决策](../../docs/stdd/decisions-and-discussions.md)
