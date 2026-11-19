---
name: stdd-wrap
description: 为一轮 STDD 开发收尾或交接，整理任务进展、规范变更、验收证据与可评审的 PR 草稿。
---

# 开发收尾与交接

1. 读 `AGENTS.md` 和 `docs/stdd/git-workflow.md`，核对当前候选和合入目标。保留现有工作树与历史，Git 和网络操作由 root 按本轮授权执行。
2. 同步实际交付的规范、契约和任务，按 `docs/stdd/decisions-and-discussions.md` 关联讨论与 ADR。适用验收完成后归档，校验变更指向外部的相对链接和指回变更的索引、讨论及 ADR 链接。
3. 提交前由 root 通过开发与 CI 指南的入口运行适用本地检查。经授权提交并触发现有 CI 后，按 `docs/stdd/git-workflow.md` 核对适用的最终 SHA 验收证据。候选内容变化后核对受测字节并复跑受影响项。按 `docs/stdd/templates/verification.md` 记录结果，必跑门禁失败或缺证时保留待验收状态。
4. 使用 PR 模板准备范围、方案确认、受测证据、影响、待办和适用的恢复或前向修复条件。交接时保留绑定受测字节的候选标识、下一步和复跑入口。提交、推送和发布依据本轮授权执行。
