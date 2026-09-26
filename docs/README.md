# agent-service 文档索引

## design/
- `01-identity-and-auth.md` — **身份与鉴权定稿**：service key 与端用户身份的区别、为什么 runner 必须自己验证、`trusted_caller` 与 `end_user_token` 两种模式的配置与取舍。
- `00-architecture.md` — **总体架构方案 v0.1（待评审）**：结论、服务拆分、分布式一致性、对外协议、runner 内部、扩展性、存储、容量、技术栈、里程碑、待决策项。

## research/（调研阶段产出，2026-09-22）
| 文件 | 内容 |
|---|---|
| `01-prior-harness-research-digest.md` | 前期四个 harness 对比调研的批判性摘要：哪些结论在新需求下成立/翻转，八条生产坑，复用边界三层 |
| `02-prior-architecture-and-poc-digest.md` | 前期架构方案与 PoC 的摘要：分布式设计、API 草案差距、PoC 可复用模块与代码级缺陷、存储映射、20M DAU 容量重算 |
| `03-opencode-analysis.md` | opencode v1/v2 源码分析、多租户阻碍清单、A/B/C 复用方案评估 |
| `04-pi-and-deepseek-harness-analysis.md` | pi 与 deepseek-harness 源码分析、作为内嵌 loop 的可行性与需替换的缝 |
| `05-openclaw-and-hermes-analysis.md` | openclaw 与 hermes-agent 的 gateway/session/skills 设计、可移植设计与可引入代码 |
| `06-codex-analysis.md` | codex app-server 协议（thread/turn/item、审批、resume）、WireApi 验证、可逐字借鉴的部分 |
| `07-agent-server-protocol-survey.md` | ACP / A2A / AG-UI / AI SDK / OpenAI Responses / Managed Agents / LangGraph / Claude SDK / opencode 协议横向对比 |
| `partials/dsh-mcp-skills-subsystem.md` | deepseek-harness MCP 与 skills 子系统源码笔记 |

## 参考仓库
shallow clone 在 `../oss-refs/`（opencode、deepseek-harness、pi、codex、openclaw、hermes-agent），commit 记录在各报告开头。
- `PROGRESS.md` — 里程碑进度与待办

## review/
- `README.md` — 说明本目录是历史评审快照；当前状态以 `PROGRESS.md` 为准。
- `02-api-completeness.md` — API 完备性评审：§5 协议逐项（端点 / 事件 / 错误码 / 请求信封）的已实现·部分实现·未实现矩阵，M1 收尾必补项、M2–M4 计划内项、文档需更正项。

## operations/

- `local-and-deployment.md`：本地服务生命周期、自动验证入口，以及未来 staging/production 的配置与模块部署契约。
