# 工程约定

[AGENTS.md](../AGENTS.md) 维护本仓库的协作、授权和交付规则。STDD 文档记录单项变更的规格、方案和证据。

## 规格与验收

- `specs/<capability>/spec.md` 记录已交付的可观察行为并引用现有合同。HTTP schema 以 [OpenAPI](../packages/protocol/openapi.json) 为准，架构与运维约束分别见[设计专题](design/README.md)和[运维手册](operations/README.md)，版本与具名验收见 [PROGRESS](PROGRESS.md)。
- 将待确认的改动写在 `changes/<id>/`，随方案、实现、测试和证据一起评审。发现代码与公开合同有差异时，在变更中记录证据和待处理项。
- 需求与验收分别使用 `REQ-<领域>-<序号>`、`AC-<领域>-<序号>`。领域码使用大写英文字母或数字，可用短横线连接。用三级标题记录 ID，并在每个场景下用 `关联` 指向需求。沿用存续规则的 ID，新规则使用未分配的编号，退役编号留在 Git 历史。
- 规格、设计、任务和验收都引用相同的 ID。`test-plan.md` 记录要验证什么，`verification.md` 记录实际观察和受测版本。

## 团队交付

- 在 `change.md` 记录取舍，在 `tasks.md` 记录实施方案和确认依据。复杂变更可补 `design.md`，已有同范围确认可直接引用。按[角色导航](stdd/roles.md)交接，并从变更链接相关[讨论与架构决策](stdd/decisions-and-discussions.md)。
- 优先从公开入口验证可观察行为。在旧实现可运行时，先确认新增回归用例能捕获预期差异，交付后用实际候选复跑。手工证据记录执行人、环境、操作、预期和实际结果。
- 由 root 统一执行测试、构建、数据库、Git 和网络操作。验证分层、真实服务前提、费用边界与最终候选门禁沿用 [AGENTS.md](../AGENTS.md) 和[开发与 CI 指南](operations/development-and-ci-guide.md#6-分层验证路径)。
- 评审对照候选和实测证据，保留既有 coverage 阈值、用例、错误判定和期限。适用的必跑门禁缺证据或失败时，记录待验收状态、阻断原因和补验入口。
- 交付后同步相关现行规格、更新实际证据及双向链接，再按[收尾流程](stdd/workflows.md)移入 `changes/archive/`。Git 操作见[项目 Git 工作方式](stdd/git-workflow.md)。
