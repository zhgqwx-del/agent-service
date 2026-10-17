# MCP：M3.1a 受限远程工具纵向

状态：实现候选，待源码、真实服务和最终提交 CI 验收；本文不是已实现能力清单。
总体目标仍是[架构 §7.2](00-architecture.md#72-mcp)的完整 MCP；当前进度以 [PROGRESS](../PROGRESS.md) 为准。

## 1. 切片与非目标

M3.1a 打通 operator 配置的 no-auth 远程 HTTPS MCP，经真实 turn 调用、持久 item、SSE 和审批收口。
它与平台注册/轻池方向相容，但不满足架构 §7.2 的完整清单，不能称“完整 MCP”或“M3 完成”。
这是明确的分批交付边界，不是取消三级注册、OAuth、隔离或安全验收。

| 本切片 | 后续 M3.1b，仍未完成 |
|---|---|
| operator 固定配置、精确 tenant/user ACL | tenant/user 动态注册 API、平台管理与发现 API |
| no-auth，不接受 credential/header | OAuth、token 加密/撤销、分布式 refresh 单飞 |
| 仅现代 `2026-07-28` Streamable HTTP | 明确的 2025 兼容、完整目录刷新与连接池 TTL |
| 请求/turn 自有 client、硬预算及本地并发上限 | 跨 runner 失效传播、分布式 quota/熔断与池化 |

stdio 只属于未来重池；不加载租户代码，不提供 shell/fs、MCP Apps 或 Tasks。
skills/hooks 是其它 M3 纵向，不由 MCP client 的存在证明完成。
本切片不新增数据库 schema、长期服务、JavaScript 产品入口或镜像，不扩展完整生命周期/灾备 P2。

## 2. 当前代码接线基线

- `ToolRegistry` 当前是静态同步 builtin 目录；其现有全局实例不能直接保存用户 MCP 工具。
- 本候选在`SessionHost.createSession`/`beginTurnInner`接入独立、异步、owner-scoped的`McpToolSource`，不污染静态目录。
- HTTP请求允许最多8个不重复operator server id；未启用时仍拒非空mount，完整目录在真实session owner下发现/重验。OpenAPI/SDK及capabilities随之更新。
- 现有 `RunnerTool`、Pi bridge、write-ahead、审批资源、fence、工具结果持久化和 Blob 可复用。
- 当前持久模型是 `toolCall{kind:"mcp"}` + `toolResult`，不是独立 `mcpToolCall` item。
- 当前 `onToolProgress` 尚未转发；新增 progress 必须有正式协议、SDK 和 SSE 测试，不能只发未登记字符串。
- MCP agent的catalog/config/owner身份变化在下一turn原子更新`contextEpoch`、`toolsChanged` notice与固定warning；失效scope同时移除。builtin-only原语义保留。

## 3. operator 配置与身份

配置只由可信部署方提供：稳定 `serverId`、固定 canonical endpoint、精确 ACL、正整数预算和硬上限。
endpoint 仅允许 HTTPS，拒绝 URL userinfo/query/fragment；不接受任意 API URL、header、Cookie、env、command 或 credential。
配置不含 token，不读取模型 key 作为 MCP 认证，不将 operator 身份赋给用户。
未配置 server 时默认为零 MCP 工具；未知或不可见的挂载必须拒绝，不能静默忽略。

ACL 是精确 `(tenantId,userId)` 集合，不支持通配符、前缀匹配或仅凭 server 名称继承权限。
tenant/user 取自已认证上下文与已核对的 session owner，不信任请求体自报身份。
trusted caller 代建时，先执行既有代建权限校验，再以 `req.userId ?? principal.userId` 装配新 session。
不能把代建者自己的用户工具、连接或 epoch 赋给被代建者；token 模式不可据此跨用户代建。
turn 必须核对 session 归属，并按 session 实际 owner 重验 agent 挂载与 ACL。
任意缓存/连接身份使用无歧义 tuple 编码，不用易碰撞的字符串拼接。

M3.1a 不提供热更新 API；变更 endpoint/ACL/config 必须安全 drain 并替换相应 runner 配置。
不能让新增 MCP session 落到忽略该字段的旧 runner；发布须保证目标 fleet 能力一致，未知能力 fail closed。
这不是新增独立的滚动升级证明，也不授权混跑不兼容 writer。

## 4. SDK 与协议

依赖候选精确锁定 `@modelcontextprotocol/client@2.3.1`；真实 MCP 测试服务使用 `@modelcontextprotocol/server@2.3.1`。
仅在直接导入协议 schemas 时显式依赖 `@modelcontextprotocol/core@2.3.1`。
三者官方 npm 发布元数据均要求 Node >=20；项目保持 Node24，不为此升级整个协议的 Zod3。
SDK 自身依赖 Zod >=4.2；测试服务可使用 `fromJsonSchema()`，不得混用已有 Zod3 对象。

```ts
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { McpServer, createMcpHandler, fromJsonSchema } from "@modelcontextprotocol/server";
```

client 必须显式设置 `versionNegotiation: { mode: { pin: "2026-07-28" } }`，并限制 supported versions。
安装 v2 并不会自动使用现代协议：未指定时仍走旧 `initialize`；本切片禁止 2025/SSE legacy fallback。
现代连接通过 `server/discover` 确认协议，随后有界 `tools/list`/`tools/call`；不手写旧握手。
协议 envelope、标准 header 和 `x-mcp-header` 编码交给固定版本 SDK；不得允许用户覆盖其保留字段。
不声明 sampling/roots/elicitation/Tasks 等 client capabilities，并关闭 `inputRequired.autoFulfill`。
`input_required`、远端资源或未知交互必须明确失败，不能变成隐式模型调用、文件访问或用户交互。
现代 MCP 没有 protocol session、GET stream 或其 Last-Event-ID 恢复；不要与本服务 SSE seq 混淆。

## 5. 出站边界

`StreamableHTTPClientTransport` 的 `fetch(url: string | URL, init?: RequestInit): Promise<Response>` 可注入。
它没有 SDK 专用 dispatcher 字段；由受控 `safeFetch` 封装连接器/dispatcher，不修改全进程 global dispatcher。
配置时的 DNS 检查只是早期拒绝；每次实际建连都必须验证并绑定公网地址，避免 check/connect rebinding。
覆盖 IPv4/IPv6、mapped 地址、loopback/private/link-local/metadata/reserved 地址和多 A/AAAA 混合返回。
保持原 HTTPS hostname/SNI/证书验证，不为 IP pin 关闭 TLS 验证；IP 或配置变更不能借用旧错误连接身份。
拒绝 redirect，不追随 Location，即使同源也不能绕过固定 endpoint。
生产路径不得注入“测试放行全部内网”的开关；隔离测试可注入精确 fixture connector，不能冒称公网实测。

不复制入站 Authorization、X-User-Id、用户 JWT、Cookie、内部 router/operator token 或 trace baggage。
401/403 直接作为受控认证不支持/拒绝错误处理，不触发 OAuth discovery、重定向或凭据探测。
`requestInit` 会用于 OAuth 请求的事实要求未来另做目的地凭据隔离，不能靠本切片 no-auth 推断安全。
远端 description/schema/result/progress 都是不可信数据；描述标注第三方来源，不能升级成 system instructions。
不自动读取 resource link、image URL、file URI、附件 URL，也不执行返回的代码、提示词或 command。

## 6. 目录、名称与审批

目录解析在已授权 principal 下完成，分页数、总工具数、schema/description 总字节和 JSON 深度均有上限。
畸形 schema、重复名字、循环 cursor、超限和未知协议不得产生半个可执行目录。
对完整配置、canonical endpoint、ACL、tool schema/description 做确定性身份摘要；turn 使用一个固定快照。
模型工具名使用 `mcp__<server>__<tool>` 可读前缀与稳定 hash，按允许字符规范化且总长 <=64。
hash 绑定稳定 serverId 与原始远端工具名；不能使用不唯一的远端 serverInfo.name 作为身份。
拒绝与 builtin/dynamic 或同批其它工具的名称碰撞，不能利用 Map 覆盖改变实际执行目标。

所有远端工具一律 untrusted、强制审批；不因 readOnlyHint、其它 annotations 或 description 自称只读而免审。
强制审批是执行下限，`approvalPolicy="never"`、普通 autoApprovedTools 或预存旧字符串不能绕过。
`acceptForSession` 只能复用精确 principal/session/server/config/catalog/tool 身份下的许可。
ACL、endpoint、schema、description 或配置摘要变化必须使旧许可失效；现有证据不能证明绑定时重新询问。
approve/decline/expiry/cancel 与最终 gate 均须重验当前 turn 所有权、取消状态、挂载和 ACL。
只有通过 gate 后才能标记实际 execution start；等待审批时崩溃不能被误判为工具已执行。

## 7. 预算、取消与持久化

发现与调用分别有连接、header、整操作硬期限；POST/SSE/JSON 分别限制字节、frame、深度和进度频率。
分页/重连/队列/并发都必须有界，progress 不能无限重置硬期限；取 turn/agent/operator 限制中更严格值。
不把 readOnlyHint 当并发安全证明；未明确证明时顺序执行。跨 runner 分布式 quota 仍是未完范围。
客户端 SSE 断开不等于 turn 取消；显式 interrupt、fence loss、drain 或 tenant fence 必须取消底层 MCP I/O。
MCP全部实际I/O以`TenantRuntimeCoordinator`的provider operation lease追踪，取消后等实际socket关闭才释放；没有共享缓存，所以不登记虚假的cache participant。不能在零引用证明后留下socket/工作。
每次发送和接收后还核对当前 tenant/user lifecycle。底层授权数据库读取当前没有可取消接口，若数据库失联可能延长 drain；会保持 operation lease 等待实际读取结束，不虚报零引用。HTTP 硬期限不能被称为整个数据库授权链的统一期限，后续需补这一运维边界。
M3.1a client/dispatcher 由有界请求或 turn 独占，在 finally 中关闭、等待 body/连接结清；不建立跨请求共享池。
这不提供未来池化 TTL、全 fleet 热撤销或新 MCP 凭据的生命周期证明。

已有 write-ahead 必须先 durable toolCall/item-started 再发远端请求；最终结果提交后才能交给下一模型步骤。
远端执行后连接丢失属于 outcome unknown，不能自动重放可能有副作用的调用或从“没有结果”推断没执行。
错误只保存固定分类与安全文本，不把 URL/header/raw error/响应正文写日志或公共错误。
结果正文是明确的工具数据，经有界转换和现有 owner-scoped Blob 规则处理，不冒充 operational 日志。
本切片不请求/支持remote progress通知，未接`onToolProgress`，不能宣称已交付完整MCP进度事件。后续progress只能进正式实时流、无seq；当前最终item/events按既有事务与fencing分配seq，可从MySQL回放。

远端派发前同一write-ahead COMMIT持久化暂停`acceptForSession` scope；仅成功结果与恢复scope同COMMIT后才能再次复用。结果错误/序列化失败/断流/进程崩溃或lease loss不能恢复许可；下一次必须重新审批。它不是跨存储恰好一次协议，也不修改旧历史receipt。

## 8. 本包验收，不用 client stub 代替

1. 真实 router -> runner/Pi -> HTTP MCP -> 工具结果 -> 第二次模型步骤 -> 最终回答；确定性模型可用 FakeVendor。
2. 核远端调用次数/参数、write-ahead 顺序、审批、durable item/result、seq 和本服务 SSE 断线重放。
3. 双 tenant/双 user、同名 server/tool、trusted caller 代建与 token 模式禁止代建；不可见与不存在不泄漏区别。
4. `never`、伪 readOnlyHint、旧 session 许可、config/catalog 变化、decline/expiry/cancel 均不能越过审批。
5. 真实受控 socket/TLS/redirect/流式 HTTP 负例；DNS 双返回/rebinding 注入证明不能替代真实网络边界测试。
6. 超大 JSON/SSE/schema、分页循环、慢 header/body、progress 洪泛、取消/drain/fence 后无新增调用或悬挂 I/O。
7. Memory/真实 MySQL 持久结果与回滚、真实 Redis/多 runner 接管；结果未知不重复执行写工具。
8. OpenAPI/SDK、正式 required 执行清单、build/VM/镜像和最终提交 CI 按实际影响验收，不以安装依赖记为通过。

## 9. 官方依据与后续安全缺口

- [2.3.1 client 发布元数据](https://registry.npmjs.org/@modelcontextprotocol/client/2.3.1)；[server](https://registry.npmjs.org/@modelcontextprotocol/server/2.3.1)。
- [精确 tag 的版本协商](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/docs/protocol-versions.md)与[transport](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/packages/client/src/client/streamableHttp.ts)。
- [2026-07-28 transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)、[tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)、[安全指南](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)。
- [OAuth 源码](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/packages/client/src/client/auth.ts)的高层 auth() 在部分失败路径 console.warn 原始上游 message/body，不能直接接入本仓库 content-free 日志边界。
- M3.1b 必须先解决该日志边界、state/issuer/discovery 持久化、token 加密/撤销与跨 runner 单飞；不能全局劫持 Console、关闭 issuer 校验或声称 SDK 已代为完成。
- 完整 MCP、skills/hooks、云 IAM/KMS、生产容量及完整生命周期仍按原目标交付；本切片不提升任何旧 unknown/receipt 或全域 completion。
