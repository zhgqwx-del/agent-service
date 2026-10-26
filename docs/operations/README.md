# 使用与运维文档

按要完成的任务选择入口。能力与不变量由 [设计文档](../design/README.md) 解释；当前A/B/C版本、具名验收与剩余事项统一看 [PROGRESS](../PROGRESS.md)。通用部署包已完成，实际生产验收待资源。

| 要完成的任务 | 入口 | 范围 |
| --- | --- | --- |
| 通过HTTP调用、同session续聊、读结果与处理失败 | [HTTP体验](http-experience.md) | 通用可信客户端、无费用fixture、curl；真实模型须明确预算。 |
| 新建隔离本地实例、schema/metadata/authority与首次管理员 | [初始化与身份](schema-bootstrap.md) | 人工预置、最小权限、固定0066绑定、受限冷启及external-infra前台运行。 |
| 在单台Linux部署双角色 | [production部署](initial-production.md) | 可信制品、systemd、TLS/SSE、Gateway、Redis持久化、升级与故障处理；目标环境须实证。 |
| 配置角色、验真VM包、受控启用与维护 | [运行与维护契约](local-and-deployment.md) | 默认值/权限边界、SSE限制、Blob mover、journal/catalog及local-only加密制品。 |
| 采集指标、加载告警和落实值守 | [基础监控](../../deploy/production/monitoring.md) | 使用已有Prometheus；不安装采集服务，不等于告警实际送达。 |
| 源码开发、定向验证、构建与CI | [开发与CI](development-and-ci-guide.md) | 隔离资源、验证分层、13个CI执行实例、证据与产物身份。 |
| 进行单runner受控容量测量 | [并发基线](runner-load-benchmark.md) | 独立MySQL/Redis/FakeVendor；峰值与对账，不能外推生产SLO。 |

首次使用按“初始化与身份 → HTTP体验”；生产操作者按“production部署 → 基础监控 → 目标验收”。已有实例按其真实版本和私有OWNER交接继续运行，不重走新库流程或自动升级。

手工单次R1的完整步骤在 [production §8](initial-production.md#8-受控手工单次-r1-恢复)：源健康可读、全writer持续停服、先外部reserve/prepare再物理导入、受限replay/verify、真实successor与同command确认、冷读和resolve。它不提供HA、自动恢复或源不可读灾备；本地artifact/selected流程的production硬拒绝仍有效。

历史逐轮过程和原手册保留在 [2026-10-25文档快照](../history/2026-10-25/README.md)。历史命令/旧“当前”状态不能直接用于新部署；私有原件、失败报告与密钥制品仍留原位，不移入公开文档。
