# 现行规格索引

既有能力沿用下列合同。具体发布版本、已验范围与剩余事项见 [PROGRESS](../docs/PROGRESS.md)。

| 能力 | 现行入口 |
| --- | --- |
| HTTP 接口和 TypeScript SDK | [OpenAPI](../packages/protocol/openapi.json)、[SDK 合同与用法](../packages/sdk/README.md) |
| 会话、执行与 SSE | [总体架构](../docs/design/00-architecture.md)、[HTTP 使用与恢复](../docs/operations/http-experience.md) |
| 身份、权限与租户隔离 | [身份与鉴权](../docs/design/01-identity-and-auth.md) |
| 模型和工具扩展 | [设计索引](../docs/design/README.md)中的 Gateway、MCP、Skills、Hooks 与子任务专题 |
| 数据生命周期、部署和恢复 | [数据生命周期](../docs/design/04-data-lifecycle.md)、[运维索引](../docs/operations/README.md) |
| 测试和交付 | [仓库协作约定](../AGENTS.md)、[开发与 CI 指南](../docs/operations/development-and-ci-guide.md) |

新增或修改行为先在 `changes/<id>/spec.md` 评审。交付时按[规格模板](../docs/stdd/templates/spec.md)将相关行为记录到 `specs/<capability>/spec.md`，用 `REQ` 和 `AC` 关联权威合同、测试和验收证据。现有能力按实际变更逐步补齐追踪。协议和设计变更同步回各自的权威位置。
