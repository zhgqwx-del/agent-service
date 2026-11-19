# agent-service STDD/SDD 协作

## 项目目标

agent-service 为可信 App 后端提供多租户 Agent API，支持通过 HTTP/SSE 提交执行、读取持久结果并在同一会话中继续对话。业务身份、业务数据权限和最终结果保存由 App 后端负责。项目范围见[项目 README](../../README.md)。

## 首个产品变更

[首个产品变更](../../changes/001-first-slice/change.md)的目标待定。选定需求后，用 `$stdd-start` 补齐现状、规格和验收场景，引用已有的同范围确认记录或完成评审后再进入实施。

## 角色入口

| 角色 | 首个变更的协作文件 |
| --- | --- |
| 产品 | [目标、范围和决策](../../changes/001-first-slice/change.md) · [需求与场景](../../changes/001-first-slice/spec.md) |
| 设计 | [体验设计](../../changes/001-first-slice/ux-design.md) |
| 研发 | [实施方案与任务](../../changes/001-first-slice/tasks.md) |
| 测试 | [验收计划](../../changes/001-first-slice/test-plan.md) · [验收记录](../../changes/001-first-slice/verification.md) |

其他变更按[角色导航](roles.md)和[研发工作流](workflows.md)推进。开始工作前读[协作约定](../../AGENTS.md)，交付时按[工程约定](../engineering.md)引用适用的[现行规格](../../specs/README.md)和[开发与 CI 门禁](../operations/development-and-ci-guide.md#6-分层验证路径)。当前版本、正式验收和剩余事项查阅 [PROGRESS](../PROGRESS.md)。
