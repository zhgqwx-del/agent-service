# 文档地图

首次接触项目先读[项目 README](../README.md)。当前完成度、A/B/C 版本与正式验收只看 [PROGRESS](PROGRESS.md)，不要从历史快照或测试文件数量推断功能完成。

<a id="quick-start-reading"></a>

## 新手快速阅读

建议预留20–30分钟，先沿一条实际业务链理解项目，再按职责深入专题；阅读本身不需要安装依赖、启动环境或调用模型。

| 顺序 | 阅读位置 | 读完应能回答 |
| --- | --- | --- |
| 1 项目是什么 | [项目 README](../README.md)的开头、当前支持范围、服务如何协作 | 这个服务面向谁，提供哪些能力，App后端还负责什么？ |
| 2 业务怎么接 | [记录助手示例](../examples/record-assistant/README.md)的责任、三轮调用和更正边界；先理解流程，代码可略读 | “分析→补充更正→同主题追问→结果保存”如何对应同一个session与多次turn？ |
| 3 内部怎么工作 | [总体架构](design/00-architecture.md)的§0、§1、§3；随后选读[turn接收时序](design/00-architecture.md#turn-request-sequence)和[Agent循环](design/00-architecture.md#agent-step-loop) | router、runner、Host、Pi和存储分别做什么？一次请求怎样变成持久结果？ |
| 4 做到哪里 | [PROGRESS](PROGRESS.md)开头的版本分源、能力与剩余范围、下一步与阻断 | 哪些已有具名验收，哪些受限或待实现，下一步是什么？第一次无需逐条读日期流水 |
| 5 按角色深入 | 下方“按任务阅读”和[设计索引](design/README.md) | 接入、开发、运维或专题评审应该接着读哪份文档？ |

先记住这些概念，阅读架构和API时会更容易：

| 概念 | 在本项目中表示什么 |
| --- | --- |
| tenant / user | 授权租户和实际用户；由可信后端/鉴权链确定 |
| 业务记录 / topic | App的业务数据和主题，App维护其权限、版本及到session的关联 |
| session | 历史归属、单写者控制和事件游标的单元；一个用户可以有多个session |
| turn | 一次Agent执行；反问结束后，用户补充可以开启下一次turn |
| item / event | item保存消息、工具或摘要等内容；持久event记录可按seq重放的变化事实 |
| SSE | 执行的流式观察连接；断开连接不等于取消turn，实时delta也不保证重放 |

希望亲自调用时，再读[HTTP使用](operations/http-experience.md)或[SDK](../packages/sdk/README.md)；需要界面体验时读[本地H5](operations/chat-h5.md)。首次准备环境按[运维索引](operations/README.md)进入初始化流程。已有本机环境的恢复遵循其实际交接，勿把“新环境初始化”用于已有数据。

设计10/11回答业务任务与来源失效的后续方案，适合了解总体架构后阅读；research/review/history用于追溯取舍和时间点证据。迁移编号、历史报告和完整生命周期细节可在进入对应工作时再读。

<a id="meeting-introduction"></a>

## 会议快速介绍

项目介绍建议用10–15分钟，以[总体架构](design/00-architecture.md)为主要讲述文档，另开README和PROGRESS作首尾。下面时间是议程建议，不是阅读或性能测量。

| 环节 | 建议时间 | 展示文档与讲述要点 |
| --- | --- | --- |
| 业务目标 | 2分钟 | [README开头](../README.md)：面向App后端的多租户Agent API；用记录分析、补充、追问、保存举例，说明业务权限和最终保存由App负责 |
| 架构分工 | 4分钟 | [§3.1业务全景](design/00-architecture.md#31-全景业务架构与范围)→[§3.2当前组件](design/00-architecture.md#32-当前实现架构)→[§3.3分层图](design/00-architecture.md#current-layered-architecture)；听众偏业务时选第一张，偏技术时选后两张，不必重复讲所有图 |
| 一次请求 | 3分钟 | 选择[§4.6接收时序](design/00-architecture.md#turn-request-sequence)或[§6.6Agent循环](design/00-architecture.md#agent-step-loop)讲一遍输入、模型/工具、持久化、返回；点明已接收、已派发、已完成和客户端收到是不同事实 |
| 当前进度与下一步 | 2分钟 | [PROGRESS开头](PROGRESS.md)和[当前来源方案TODO](PROGRESS.md#runtime-source-context-plan)：分别说明已验范围、现存阻断和规划；来源模式尚未实现 |
| 提问 | 余下时间 | 从责任边界、接入方式、风险和下一阶段需求中选择讨论；深入材料按下表打开 |

若会议只保留一份主文档，选择总体架构；若只讲5分钟，保留README的目标、一张组件图和PROGRESS的当前范围即可。讲述主线是“解决什么业务问题→谁负责→请求怎样执行→当前做到哪一步”。

技术评审按议题增加材料，不把全部专题塞进首次介绍：

| 议题 | 追加阅读 |
| --- | --- |
| App接入与真实调用 | [记录助手示例](../examples/record-assistant/README.md)、[HTTP使用](operations/http-experience.md)、[SDK](../packages/sdk/README.md) |
| 多runner和故障恢复 | [所有权接管](design/00-architecture.md#ownership-handoff-sequence)、[SSE恢复](design/00-architecture.md#sse-recovery-sequence) |
| 上下文与来源失效 | [当前上下文数据流](design/00-architecture.md#context-projection-flow)→[设计10的职责取舍](design/10-task-context-and-orchestration.md#source-context-first-slice)→[设计11](design/11-source-context-invalidation.md)的范围、状态、SSE和验收；具体待办回到PROGRESS |
| 为什么参考Super-agent | [研究08 §5–7](research/08-superagent-prototype-analysis.md#5-与-agent-service-的关系)，讲适用前提和本项目取舍；上游原型不作为本项目已实现能力 |
| 部署、身份或数据安全 | [运维索引](operations/README.md)、[身份鉴权](design/01-identity-and-auth.md)、[生命周期](design/04-data-lifecycle.md)，按具体决策选读 |

如需现场演示，可单独按H5手册准备已登记环境；H5是本地体验工具。无费用fixture演示只说明接线与流程，真实模型演示另行准备配置与预算。会议材料使用公开架构图和安全的合成数据，运行状态及验收结论以PROGRESS的对应范围为准。

## 按任务阅读

| 读者任务 | 阅读顺序 |
|---|---|
| 使用已有服务 | [HTTP 使用](operations/http-experience.md) → [SDK](../packages/sdk/README.md) → [记录助手示例](../examples/record-assistant/README.md) |
| 接入身份和模型 | [身份与鉴权](design/01-identity-and-auth.md) → [Gateway](design/09-provider-gateway.md) → [OpenAPI](../packages/protocol/openapi.json) |
| 理解系统与扩展 | [设计索引](design/README.md) → 架构/数据生命周期 → MCP、skills、hooks、subagents 专题 |
| 评审来源上下文专项（规划） | [00 概览](design/00-architecture.md) → [10 取舍](design/10-task-context-and-orchestration.md) → [11 详细合同（规划）](design/11-source-context-invalidation.md) → [PROGRESS 当前TODO](PROGRESS.md#runtime-source-context-plan)；[研究08](research/08-superagent-prototype-analysis.md)选读 |
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
