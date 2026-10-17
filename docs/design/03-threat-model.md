# 安全威胁模型：现有运行基线与 M3.1a

状态：M3 设计候选；新增控制和验收要求尚待产品实现/实测，不能作为安全审计完成证明。
本文只约束本项目边界，不宣称上游 MCP 服务、模型厂商、云资源或全部历史生命周期已被证明安全。
当前交付与验证事实只看 [PROGRESS](../PROGRESS.md)；MCP 切片合同见 [06-mcp](06-mcp.md)。

## 1. 资产与信任边界

- 身份：service API key、tenantId、已验证 user、session owner、admin scope、独立 operator authority。
- 内容：会话正文、工具参数/结果、图片/Blob、导出；不因使用 no-auth MCP 就成为公开数据。
- 权限：agent@version 工具集合、审批、session fence、租约、租户逻辑删除/fence 与 runtime drain。
- 凭据：模型/BYOK、tenant auth、内部 router/operator token；M3.1a 不新增 MCP credential。
- 证明：item/event seq、idempotency、业务/账务事实和冻结的历史 receipt，不允许通过新能力重释。

外部客户端 -> router -> runner 是入站边界；runner -> 模型/MCP/对象存储是出站边界。
operator 配置可信不等于远端 server、DNS、tool description、annotations 或结果可信。
MCP server 可以主动恶意、被接管、拖延或在执行副作用后断流；不得假设它会诚实返回结果。
同一 runner 中的不同 tenant/user 是隔离域；内存 cache、连接池或 SDK 全局对象不能取消该边界。

## 2. 当前可复用基线，不是 MCP 实现证明

- runner 权威解析 service key 与 tenant auth policy；session 路由要求 user，配置写入要求 admin。
- trusted_caller 的 X-User-Id 只适用于可信租户后端；持有该 key 的调用者本就能代该租户用户。
- end_user_token 模式由已验证 subject 决定 user，不能用任意 header 或 body 改为另一用户。
- session 归属、跨域 404、Redis lease/fence、事务 seq、工具 write-ahead 和 durable approval 已有实现。
- `TenantRuntimeCoordinator` 已覆盖登记的 auth/provider/turn；新增 MCP 不会自动进入该证明范围。
- 应用默认结构化日志有闭合字段边界；第三方 SDK/Node 自行输出不因此被视为已完成审计。
- 现有 `assertPublicHost` 的预检查不能阻止 DNS 检查与 socket 建连之间的 rebinding，不能直接作为完整 MCP 防线。

M1 完整生命周期仍未闭环；M2 冻结不等于新 M3 出站路径已接受安全验收。
既有 production 拒绝/默认关闭、0037 hard-deny、0054 original-primary-only、外删/自动清理 off 和 completion=false 不变。

## 3. M3.1a 威胁与必须交付的控制

以下是发布要求，不是本文件生成时的通过结果。

| 威胁 | 本切片要求 |
|---|---|
| 租户/用户越权发现或调用 | 固定 serverId + 精确 tenant/user ACL；从已认证上下文和 session owner 派生；不接受 API URL/header |
| trusted caller 代建工具串用 | 权限校验后按被代建 owner 解析 catalog/epoch；禁止复用 caller 的用户连接/许可 |
| DNS rebinding、metadata/内网探测 | HTTPS、公网地址分类、实际 socket DNS pin、原 hostname/SNI 校验、拒绝全部 redirect |
| token/内部身份外泄 | no-auth；不复制入站 Authorization/Cookie/JWT/X-User-Id/内部 token；不自动进入 OAuth |
| tool description/schema prompt injection | 作为有来源标记的不可信数据；不得提升为 system 指令或额外权限 |
| 伪只读、approval never 绕过 | 所有 remote 工具强制审批；不信任 readOnlyHint；never/旧 autoApprovedTools 不得越权 |
| 名称碰撞、目录替换、许可复用 | <=64 的稳定带 hash 名称；冲突拒绝；许可绑定 principal/session/server/config/catalog/tool |
| 任意资源抓取、采样或执行 | 不声明 roots/sampling/elicitation/Tasks；关闭自动多轮履行；不抓 resource/image URL 或执行返回代码 |
| 大响应/深 schema/慢流资源耗尽 | POST/SSE/JSON 字节/深度/frame、分页、并发/队列和整操作硬期限，progress 不续命 |
| 取消后仍调用、drain 假零引用 | 合并 turn/fence/tenant abort；实际I/O以coordinator operation lease追踪，底层body/socket结清后才释放；没有共享缓存，不虚报cache participant |
| 副作用重复、失败伪装成功 | write-ahead 先于调用；断流 outcome unknown 不重放写操作；结果先持久化再用于下一模型步骤 |
| 结果/错误/进度跨用户泄漏 | request/turn 自有 client；有界 owner-scoped item/Blob/SSE；固定公共错误，不落 raw SDK error |
| 协议自动降级或隐式能力扩大 | 显式 pin 2026-07-28；2025/stdio/未知交互拒绝；不因安装 SDK 默认行为放开能力 |

新组件不可使用共享全局 dispatcher、全局 Console monkey patch 或 ambient credential 规避隔离。
固定 endpoint 不意味着参数没有敏感内容；审批须展示来源、工具与调用数据并保留可核对的审批资源。
远端工具结果可以包含攻击性提示词；模型后续动作仍必须经过同一工具集合、审批和预算门禁。
不承诺远端恰好一次执行：本地 idempotency receipt 与上游副作用不是一个分布式事务。

## 4. 身份、目录与撤销边界

ACL 无通配符；不存在/不可见的 server 不应成为跨域存在性 oracle。
session 创建、turn preflight、等待审批后执行都重验 owner 与当前配置；未知挂载不静默退回 builtin。
一个 turn 固定已验目录快照；新目录在安全边界更新 epoch/尾部通知，不改写旧历史或沿用错误审批。
M3.1a 无跨请求共享池/热更新 API；operator 变更须 drain 并替换配置，不能冒称即时 fleet-wide revoke。
若 drain 超时或 I/O 不结清，保持 fenced，不能伪造零引用成功。
配置默认无 server；即使切片默认关闭，也不能忽略其代码对普通启动/API/工具路径的回归。

## 5. 后续 OAuth / 动态注册的独立义务

M3.1b 尚需三级注册权限、token 密文存储与撤销、分布式 refresh 单飞、pool TTL/失效传播、quota/熔断和 2025 兼容。
OAuth 所有 discovery/authorization metadata/token URL 都是新 SSRF 输入，不能只验证最初 MCP URL。
state 必须单次、有期限并绑定 principal/server/nonce；callback 必须验证 issuer，不跨授权服务器复用凭据。
codeVerifier/discoveryState/issuer stamp 须同等持久化；刷新成功后新 token 保存失败不能静默丢失。
SDK 不提供本项目的 KMS、tenant 删除闭环或分布式刷新保证，不得据库接口存在宣称已交付。
`@modelcontextprotocol/client@2.3.1` 高层 auth() 在部分失败路径 console.warn 上游 error/message/body；该路径进入产品前必须解决。
禁止用全局禁日志、跳过 issuer 校验、内网全放行或 fake receipt 隐藏该缺口。
新增 credential/cache 域须明确接租户 fence/本地清除与 proof 范围，旧 receipt 不扩义，未闭合仍诚实阻断。
完整灾备/P2 不由本切片开启；不创建或操作真实云资源，不编造域名/TLS/Secret/KMS 参数。

## 6. 验收证据

必须是 router -> runner/Pi -> 真实 HTTP MCP -> 第二模型步骤 -> durable item/结果与本服务 SSE 的完整链。
FakeVendor 可提供确定性模型选择，但 MCP client stub/SQL mock 不等于真实 HTTP/MySQL/Redis 证明。
分别验证双 tenant/双 user/代建、恶意 hint 与 never、目录/config 改变、超时/取消/owner 接管和结果未知。
网络负例覆盖真实 TLS/socket/redirect/慢流；可控 DNS doubles 只证明自身分支，不能替代 socket 连接验真。
日志/公共错误加入 canary 负例，确认 URL、header、token、raw error 不进入输出；不打印真实 key 作为证明。
CI required 必须有本轮 JSON/实际非零断言与最终 SHA 对应，不能以登记文件或包安装替代执行。
每个失败报告保留，修复后只补受影响范围与剩余门禁，不降低阈值、放宽 oracle 或拼成本轮全绿。
当前文档不提供上述通过结论，实际进度与剩余风险继续记录于 PROGRESS。

## 7. 依据

- [总体架构](00-architecture.md)、[身份与鉴权](01-identity-and-auth.md)、[数据生命周期](04-data-lifecycle.md)。
- [MCP 2026-07-28 transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)与[tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)。
- [官方安全指南](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)。
- [固定 SDK tag 的协议协商](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/docs/protocol-versions.md)与[OAuth 源码](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/packages/client/src/client/auth.ts)。
