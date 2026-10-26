# 设计规范索引

本目录描述当前实现的架构、合同与限制。运行版本、具名验收、分源验证及原失败统一见 [PROGRESS](../PROGRESS.md)；本目录文档修改不形成新binary验收，也不授权升级、迁移、清理或真实模型调用。

文中状态统一按以下含义读取：

| 状态 | 含义 |
| --- | --- |
| 已实现并具名验收 | 有实际实现且对应本地/CI证据，仅封闭明示协议、环境与用例范围 |
| 受限实验/夹具 | 显式非生产fake、fixture或观察协议，不替代真实远端执行/云证明 |
| 待验 | 实现或交付包已存在，但目标环境、兼容、容量或其它指定证据未完成 |
| 规划 | 尚未交付实现，或业务/资源责任仍待确认 |
| 历史/已取代 | 时间点方案、旧状态或旧验收；不得覆盖当前事实，旧receipt与安全契约仍保留 |

建议先读架构，再按任务进入对应主题；不必按迁移编号阅读当前设计。

| 主题 | 当前规范 | 范围与边界 |
| --- | --- | --- |
| 总体架构与阶段 | [00 架构](00-architecture.md) | 两服务、[分层与轻/重池](00-architecture.md#current-layered-architecture)、authority、turn/loop/SSE/context行为图、职责与实现/规划边界 |
| 身份与权限 | [01 身份鉴权](01-identity-and-auth.md) | trusted caller/端用户token、service/admin/user/operator；IdP真实网络与撤权时效待验 |
| 真实子任务 | [02 Subagents](02-subagents.md) | 根authority、child映射/审批/预算/唯一计费；不恢复未知副作用 |
| 信任与攻击面 | [03 威胁模型](03-threat-model.md) | 入站、出站、凭据目的、mandatory approval、取消与源身份；非生产fake与真实网络分开 |
| 数据与恢复 | [04 生命周期](04-data-lifecycle.md) | tombstone、usage、T1/T3、Blob/outbox、checkpoint/selected/R1；全域completion=false |
| BYOK责任 | [05 凭据责任](05-credential-responsibility.md) | 本系统副本与客户厂商撤销分开；不伪造远端ACK |
| 观测与遥测 | [05 可观测性](05-observability.md) | 安全日志/trace/L0、writer与v2 capture；处置/完整平台/生产待验 |
| HTTP扩展与OAuth | [06 MCP](06-mcp.md) | 固定/受管scope、OAuth/pool/progress/stateful/显式DCR；完整兼容与stdio未完 |
| 普通DELETE保留 | [06 30天来源](06-session-delete-grace.md) | 0050/0051可信来源/post-COMMIT floor；内容purge不开启 |
| 文本技能 | [07 Skills](07-skills.md) | 静态/受管SKILL.md、version/pin/typed历史；脚本/resources/物理清理未完 |
| 策略与观察 | [08 Hooks](08-tool-hooks.md) | operator、tenant observer v2、固定lifecycle/middleware；不加载任意tenant代码 |
| 模型资源治理 | [09 Gateway](09-provider-gateway.md) | quota/pool/breaker、已证明未派发fallback、usage/unknown；非金融hard cap |

当前操作入口见[运维索引](../operations/README.md)、[HTTP体验](../operations/http-experience.md)、[schema bootstrap](../operations/schema-bootstrap.md)和[初版部署](../operations/initial-production.md)。架构/生命周期/观测中的旧流水全文见[历史索引](../history/2026-10-25/README.md)；review/research同样是时间点资料，不能作为当前待办或验收结论。

所有专题共享的门禁：0037 grant硬拒、0054 original-primary-only destructive、旧receipt不重签/unknown不提升、适用功能production拒绝、外部删除/自动清理off与completion=false；旧writer先实际排空，独立迁移/strict verify、forward-fix。安全门禁与长期未完范围不因文档精简缩减。
