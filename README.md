# agent-service

面向 App 后端的多租户 Agent API 服务。把用户输入交给有状态的 agent runner，持久保存 session、turn、item 和事件，通过 HTTP/SSE 读取结果，并在同一个 session 中继续对话。

适合需要把模型、工具和会话执行接入现有业务系统的团队。例如[记录助手参考集成](examples/record-assistant/README.md)展示“记录分析 → 补充信息 → 同主题追问 → 结果关联保存”；业务登录、记录权限和最终结果保存仍由 App 后端负责。

## 当前支持范围

| 能力 | 当前范围 |
|---|---|
| 会话与执行 | session/turn/items、SSE 重放、幂等、interrupt、审批、持久结果与停启后读取 |
| 身份与隔离 | 服务端 service key、tenant/user 隔离，`trusted_caller` 或租户配置的 `end_user_token`，BYOK |
| 模型与 Gateway | provider/model 配置、受控 key pool、配额、breaker 和有限 fallback；详见[Gateway 合同](docs/design/09-provider-gateway.md) |
| 扩展 | 固定及受管 HTTP MCP/OAuth/DCR、静态及受管 SKILL.md、受控 hooks 与 runner 内轻池子任务；开关和限制见[设计索引](docs/design/README.md) |
| 数据生命周期 | archive/tombstone、部分导出与 erasure 切片；受限执行和默认关闭门禁仍存在，完整生命周期未闭环 |
| 交付 | router/runner 两个长期服务、两个 OCI 镜像及独立 VM 包；初版目标为单台 Linux 双角色 |

通用部署包 **`61c3a58` 已完成，实际生产验收待资源**。正式本地 A 仍使用 `5ce317d`，没有自动加载 B 包。M0 完成，M2 本地/CI 范围冻结；完整 M1/M3/M4/P2 尚未完成。具名验收、版本和剩余事项只在 [PROGRESS](docs/PROGRESS.md) 维护。

## 最短使用路径

已有可用服务时，从 [HTTP 使用手册](docs/operations/http-experience.md)开始：准备受保护的客户端配置 → 创建 session → 提交 turn → 读 turn/items/events → 用原 session ID 继续对话。发起 turn 会调用配置的 provider，真实模型可能产生费用。

需要模拟 App 手动聊天时，使用[本地 H5 测试页](docs/operations/chat-h5.md)：在本机启动独立测试工具，复用同一份私有 runtime 客户端配置，体验自定义消息、SSE 流式分片、多轮对话、会话恢复和持久结果；连接本机 OWNER 后，可查看环境状态并安全启停服务与数据库。已登记的正式本地 A 在电脑重启后，进入项目目录执行 `pnpm experience:up`，即可恢复原数据库、服务与 H5；它是手动命令，不安装开机自启。service key 保留在本机代理进程中。

TypeScript 接入使用 [SDK](packages/sdk/README.md)。service key 由可信后端持有；`trusted_caller` 的用户身份必须来自后端已验证的登录态。客户端不能自行选择其它用户身份，service key 也不能下发给浏览器或 App。

从源码准备**全新独立环境**：

```sh
# Node.js >=24；仓库固定 pnpm@12.5.1
pnpm install --frozen-lockfile
```

安装完成后按[初始化与权限手册](docs/operations/schema-bootstrap.md)准备 MySQL、独立 metadata、runtime 逐表权限及当前 authority，再按[本地运行手册](docs/operations/local-and-deployment.md)启动。需要 MySQL 8、经验证的 Redis、稳定持久目录、独立密钥和模型配置。普通启动只校验 schema，不自动建库、授权或迁移；根 `.env.example` 不是可直接启动当前正式 MySQL 路径的完整配置。

源码默认监听 router `127.0.0.1:8080`、runner `127.0.0.1:8787`；这些不是现有实例的地址。router 是对外入口，runner 保留在可信网络内。配置、角色模板、端口和持久目录以运行手册为准，勿把通用初始化命令用于已有业务环境。

## 服务如何协作

```text
App → 可信业务后端 → agent-router → agent-runner → 模型 / 受控工具
                                      │
                              MySQL / Redis / Blob
```

router 做路由和连接准入；runner 执行身份验证、会话串行化、模型与工具调用。MySQL 保存业务结果和当前 session authority，Redis 负责协调与事件通知，Blob 保存外置内容。API 合同是 [OpenAPI](packages/protocol/openapi.json)，SDK 类型按既有生成流程产生。详细模块和控制流见[架构](docs/design/00-architecture.md)。

## 文档入口

| 要完成的任务 | 入口 |
|---|---|
| 调用、续聊、读结果、处理失败 | [HTTP 使用](docs/operations/http-experience.md)、[SDK](packages/sdk/README.md) |
| 理解架构、身份、MCP/skills/hooks | [设计索引](docs/design/README.md) |
| 初始化、启动停止、升级、监控与手工 R1 | [运维索引](docs/operations/README.md) |
| 修改代码、选择验证范围 | [开发与 CI](docs/operations/development-and-ci-guide.md)、[协作约定](AGENTS.md) |
| 查版本、验收、剩余事项与历史 | [PROGRESS](docs/PROGRESS.md)、[历史索引](docs/history/README.md) |

[完整文档地图](docs/README.md)按读者任务分流。恢复与删除必须遵守专题中的停写、验真、权限和人工确认条件；初版手工 R1 要求健康可读源，不提供 HA、自动恢复或源不可读灾备。
