# STDD 研发工作流

产品、设计、研发和测试从[项目入口](project.md)和[角色导航](roles.md)查看同一份变更。在 Codex 中用 `$stdd-start` 起草变更，或直接打开下表中的技能。

## 使用顺序

[首个产品变更](../../changes/001-first-slice/change.md)的目标和范围待定。选定切片后，明确规格和验收场景，再在 `tasks.md` 写修改位置、关键取舍和验证方式。已有同范围确认可直接引用。复杂变更可单独写技术设计。

```mermaid
flowchart TD
    Init["从项目入口找到变更"]
    Start["stdd-start<br/>核对基线与分支，起草变更"]
    Diagnose["stdd-diagnose<br/>复现缺陷并形成回归场景"]
    Spec["起草规格、验收场景和简短实施方案"]
    Records["按项目约定记录讨论或 ADR<br/>从 change.md 链接"]
    Confirm{"规格和实施方案已确认？"}
    Delivery["stdd-delivery<br/>先写验收测试，再实现并复跑"]
    Report["stdd-test-report<br/>把实际结果写入 verification.md"]
    Review["stdd-review<br/>核对代码、规格和受测证据"]
    Wrap["stdd-wrap<br/>提交前检查、归档核对链接<br/>准备 PR 或交接"]
    Done["按项目流程合入或交接"]
    Release["stdd-release-notes<br/>按版本范围整理发布说明或迭代总结"]

    Init -->|首个切片已选定| Spec
    Init -->|后续开新需求| Start
    Init -->|收到缺陷反馈| Diagnose
    Start --> Spec
    Diagnose -->|决定修复后| Spec
    Spec --> Confirm
    Spec -.->|多轮讨论或长期取舍| Records
    Records --> Confirm
    Confirm -->|已确认| Delivery
    Confirm -->|待确认或需调整| Spec
    Delivery --> Report
    Report -->|关键场景通过| Review
    Report -->|发现实现问题| Delivery
    Review -->|需要修正实现| Delivery
    Review -->|评审通过| Wrap
    Wrap -->|按门禁和授权推进| Done
    Done -.->|准备发版或总结迭代时| Release
```

评审也可以先用 `stdd-wrap` 准备 PR 草稿，再用 `stdd-review` 核对候选。

## 技能速查

| 阶段 | 技能 | 工作产物 |
| --- | --- | --- |
| 开工 | [stdd-start](../../.agents/skills/stdd-start/SKILL.md) | 基线和分支、规格、简短实施方案、相关讨论和 ADR |
| 实现 | [stdd-delivery](../../.agents/skills/stdd-delivery/SKILL.md) | 按已确认方案和场景编写用例、实现并复跑 |
| 排查 | [stdd-diagnose](../../.agents/skills/stdd-diagnose/SKILL.md) | 用[诊断模板](templates/diagnosis.md)记录复现、影响范围及回归场景 |
| 验收 | [stdd-test-report](../../.agents/skills/stdd-test-report/SKILL.md) | 按场景记录自动、手工及待验结果 |
| 审查 | [stdd-review](../../.agents/skills/stdd-review/SKILL.md) | 对照规格、候选差异和受测证据的发现 |
| 收尾 | [stdd-wrap](../../.agents/skills/stdd-wrap/SKILL.md) | 提交前检查、归档链接、最终受测版本和按 [PR 模板](../../.github/pull_request_template.md)整理的草稿 |
| 版本 | [stdd-release-notes](../../.agents/skills/stdd-release-notes/SKILL.md) | 按[版本说明模板](templates/release.md)整理差异、影响、兼容及验收状态 |

## 脚本

在仓库根目录运行。

- 新变更选定后，用 `python3 -B scripts/new_change.py 002-next-slice '已选变更标题' --roles` 建档，将示例编号和标题替换为实际值。`--roles` 补齐规格、体验设计和验收计划，复杂变更可加 `--design`。脚本保留同名在途和已归档记录。
- 用 `python3 -B scripts/check_traceability.py` 检查 `specs/**/spec.md` 中的 REQ/AC 编号、关联与重复项。接入时尚无此格式的现行规格，输出零项属于正常结果。变更草稿、产品测试和发布门禁按各自入口核对。
- `git_range.py` 只比较已提交的 Git 引用。审查候选提交时，由 root 用 `python3 -B scripts/git_range.py --merge-base main HEAD` 查看目标分支和候选提交的分叉点到候选提交的文件变动，按实际范围替换两个引用。比较两个已存在的版本时，直接传入两个引用，取得两端快照差异。
- 审查工作区时，由 root 用 `git status --short --untracked-files=all` 枚举文件，结合 `git diff --cached`、`git diff` 和未跟踪文件的内容，审阅本次范围内已暂存、未暂存和未跟踪的改动。

## 验证与交付

root 按[协作约定](../../AGENTS.md)和[开发与 CI 指南](../operations/development-and-ci-guide.md#6-分层验证路径)统一执行检查。产品代码先做类型检查与受影响定向测试，真实服务专项和冻结后完整检查按仓库门禁执行。真实模型路径须有另行具名预算。

报告记录候选、命令、实际结果及证据。适用必跑门禁失败或缺证据时记录阻断与补验入口。基线、候选同步、提交和推送按[项目 Git 约定](git-workflow.md)及当轮授权执行。

需要单独讨论或记录长期决策时，按[讨论与架构决策](decisions-and-discussions.md)选择位置，在 `change.md` 关联讨论与 ADR，归档时核对双向链接。
