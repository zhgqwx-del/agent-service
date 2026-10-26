# 文档地图

首次接触项目先读[项目 README](../README.md)。当前完成度、A/B/C 版本与正式验收只看 [PROGRESS](PROGRESS.md)，不要从历史快照或测试文件数量推断功能完成。

## 按任务阅读

| 读者任务 | 阅读顺序 |
|---|---|
| 使用已有服务 | [HTTP 使用](operations/http-experience.md) → [SDK](../packages/sdk/README.md) → [记录助手示例](../examples/record-assistant/README.md) |
| 接入身份和模型 | [身份与鉴权](design/01-identity-and-auth.md) → [Gateway](design/09-provider-gateway.md) → [OpenAPI](../packages/protocol/openapi.json) |
| 理解系统与扩展 | [设计索引](design/README.md) → 架构/数据生命周期 → MCP、skills、hooks、subagents 专题 |
| 初始化与部署 | [运维索引](operations/README.md) → schema bootstrap → 本地运行或单 Linux 部署 → 监控/恢复 |
| 贡献代码 | [AGENTS](../AGENTS.md) → [开发与 CI](operations/development-and-ci-guide.md) → 相关专题与源码 |
| 追溯结论 | [历史索引](history/README.md) → [research](research/README.md) / [review](review/README.md) |

## 各类事实放在哪里

| 事实 | 权威来源 | 其它文档如何引用 |
|---|---|---|
| 当前行为、字段、默认值 | `apps/`、`packages/`、`scripts/`、配置解析器 | 专题解释行为并链接依据；发现合同冲突先定位，不能用改文档消解缺陷 |
| HTTP schema 与生成类型 | [OpenAPI](../packages/protocol/openapi.json)、[SDK 源码](../packages/sdk/src) | 按现有生成流程更新，不手改生成产物 |
| 支持方式、权限和操作顺序 | [运维专题](operations/README.md) | 入门只保留最短路径和前置条件 |
| 架构、不变量、受限能力与计划 | [设计专题](design/README.md) | 明确区分当前行为与未来目标 |
| 特定版本的验收与待办 | [PROGRESS](PROGRESS.md) | CI 仅证明对应 run/attempt/SHA 的具名范围 |
| 协作规则与本机恢复入口 | [AGENTS](../AGENTS.md)、本机 ACTIVE 绑定交接 | 公开通用用法不得依赖私有配置 |
| 讨论、旧评审、失败和迁移过程 | [history](history/README.md)、research/review 专题索引 | 保留日期和历史身份，不作为当前待办 |

能力状态统一使用“已实现并在具名范围验收”“已实现待验”“受限/实验性”“规划未实现”“历史已替代”。代码存在、required 登记或 gate 默认关闭均不等于验收完成；一项能力可有已验本地范围和未验目标环境范围。

专题文件清单由各自索引维护。本次整理的主张核对、迁移映射和验证结果见[文档对齐记录](documentation-alignment.md)。
