# 调研索引

本目录保存源码阅读、前期方案摘要和协议调查，解释设计取舍的来源。各文档均为**时间点研究输入**：上游版本、路径、行号、规模、命令和风险判断只属于所记快照；旧建议及“下一步”不自动成为当前待办。01–07及partial保持历史身份，未在本轮重新核验；08为2026-10-31研究及11-01后继源码深查；09为2026-11-13 chat-demo源码研究。实际来源和读取范围见各自头注。原始正文、失败、未核实项和来源身份保留在原路径。

## 当前事实到哪里查

| 读者任务 | 当前说明 |
|---|---|
| 理解服务边界、引擎、会话与里程碑 | [架构](../design/00-architecture.md)；精确完成度与具名验收看 [PROGRESS](../PROGRESS.md) 顶部。 |
| 写 HTTP / SDK 集成 | [HTTP 手册](../operations/http-experience.md)、[SDK](../../packages/sdk/README.md)；接口形状以 [OpenAPI](../../packages/protocol/openapi.json) 为准。 |
| 核对身份、工具与扩展权限 | [身份](../design/01-identity-and-auth.md)、[威胁模型](../design/03-threat-model.md)、[MCP](../design/06-mcp.md)、[Skills](../design/07-skills.md)、[hooks](../design/08-tool-hooks.md)、[子任务](../design/02-subagents.md)。 |
| 配置 provider 或运维已有服务 | [Gateway](../design/09-provider-gateway.md)、[运维契约](../operations/local-and-deployment.md)、[初始化](../operations/schema-bootstrap.md)、[初版目标部署](../operations/initial-production.md)。 |
| 判断数据删除、恢复和备份边界 | [数据生命周期](../design/04-data-lifecycle.md)；研究中的设想不授予执行或清理权限。 |

这些文档承接当前合同，并不表示历史建议全部采纳、缺陷全部关闭或长期目标全部完成。代码描述实际行为，正式验收只证明特定版本与范围；研究和外部项目都不能替代本项目验收。

## 快照目录

| 文档 | 时间 / 源身份 | 原始范围与阅读限制 |
|---|---|---|
| [01 前期 Harness 摘要](01-prior-harness-research-digest.md) | 摘要 2026-09-22；输入为 2026-09-14～15 的旧产品调研与 PoC。 | 四种 harness 与旧语音记录产品前提；来源为原文列出的本机历史资料，通用使用不依赖取得这些私有原件。 |
| [02 前期架构与 PoC 摘要](02-prior-architecture-and-poc-digest.md) | 2026-09-22；原 PoC 和方案身份见头注，未记录单一 commit。 | 租约、API、存储、容量假设及旧方案取舍；规模目标和行动清单是当时设想，不是当前容量或实现承诺。 |
| [03 OpenCode](03-opencode-analysis.md) | 本地 `oss-refs/opencode`，`fe3f3a4`，v1.18.32，源快照 2026-09-21。 | 内嵌性、v1/v2、工具与多租户阻碍；路径相对该上游仓库，不是本项目路径。 |
| [04 Pi 与 DeepSeek harness](04-pi-and-deepseek-harness-analysis.md) | Pi `1a584a7` / 2026-09-22；dsh `ddefc45` / 2026-09-17。 | 可内嵌 loop、provider、存储与替换接口；旧建议的存储、取消或遥测语义须重新对照当前合同。 |
| [05 OpenClaw 与 Hermes](05-openclaw-and-hermes-analysis.md) | 本地 clone：`91f0839d`、`dcf7256`，均 2026-09-22。 | local-first 个人 agent 的可复用性；未通读全部源码，也未重新拉取。 |
| [06 Codex](06-codex-analysis.md) | 本地 `oss-refs/codex`，`f4389de`，2026-09-22，浅克隆。 | 当时 app-server、协议、provider、存储和隔离的研究，不用于说明当前 Codex 产品。 |
| [07 服务端协议横向调查](07-agent-server-protocol-survey.md) | 2026-09-22；多来源，无统一 commit。 | 资源命名、事件信封、断线恢复、审批与许可证；原文 `[未核实]` 保持未核实身份。 |
| [08 Super-agent文章与原型](08-superagent-prototype-analysis.md) | 2026-10-31～11-01；用户本地HTML字节；官方原型 `6337fc8`。 | 文章理念、实验限定、源码链路/测试夹具分析及本项目适配；纠正领域视图与全部数据隔离的区别。只读静态研究，未运行上游；设计承接到[10 任务与上下文](../design/10-task-context-and-orchestration.md)，待办只看PROGRESS。 |
| [09 DeepSeek chat-demo](09-deepseek-chat-demo-analysis.md) | 2026-11-13；官方仓库 `5d5dd75`，0.1.1。 | 静态客户端、消息树/请求投影、SSE、本地存储/归档与流式展示；区分客户端done与持久完成、续写与恢复。保留router/runner，设计承接到[10 客户端投影](../design/10-task-context-and-orchestration.md#chat-client-projection)，可选待办见PROGRESS。 |
| [dsh MCP / Skills 部分笔记](partials/dsh-mcp-skills-subsystem.md) | `ddefc45` / 2026-09-17。 | 中断任务的部分产出，仅补充 04；不是独立完成的兼容性调查。 |

需要更新某个外部结论时，应另记实际官方仓库 URL、commit 或读取日期及验证范围，先确认同名项目身份。原文出现的仓库名和本地 clone 路径只是历史来源记录，不能当作本轮已确认的官方链接。评审发现的历史追溯另见 [review 索引](../review/README.md)。
