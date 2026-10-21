# MCP：M3.1a 受限远程工具纵向

状态：M3.1a及§10受管注册/OAuth/连接池已随`187fbb2`完成本地/CI发布，CI39088136378五job全部success，core/history/下载VM字节已独立审计。下文§1～§9保留早期受限切片及当时后续范围；当前受管能力和残余以§10及PROGRESS最新记录为准，不表示完整MCP或整个M3完成。
总体目标仍是[架构 §7.2](00-architecture.md#72-mcp)的完整 MCP；当前进度以 [PROGRESS](../PROGRESS.md) 为准。

本包为[§11](#11-公共进度与-2025-stateful-候选)公共进度与2025 stateful，已完成本地分段验收，发布须最终同SHA CI；`fe598dc`此前基线不背书本包。

## 1. 切片与非目标

M3.1a 打通 operator 配置的 no-auth 远程 HTTPS MCP，经真实 turn 调用、持久 item、SSE 和审批收口。
它与平台注册/轻池方向相容，但不满足架构 §7.2 的完整清单，不能称“完整 MCP”或“M3 完成”。
这是明确的分批交付边界，不是取消三级注册、OAuth、隔离或安全验收。

| M3.1a 受限切片 | 后续 M3.1b 项目，当前实现与残余见§10 |
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

## 10. M3.1b 受管注册合同

本包继续内嵌既有 router/runner，不新增常驻服务、产品 JavaScript 入口或镜像。router 暴露普通管理 API、独立平台管理面和固定 GET OAuth 回调；runner 持有受保护文件读入的独立加密 key，执行 SQL 授权状态机和远端 MCP 请求。router 不读取 key bytes。默认关闭；产品启用要求 MySQL、Redis、显式 namespace、固定 callback URL 和私有 router origin，不从请求 Host 推导回调地址。

- 配置 owner 有 platform/tenant/user 三种 scope，但 OAuth token 永远属于实际 tenant/user；共享配置不等于共享用户凭据。新 `mcpRegistrations:[{scope,name}]` 与原 `mcpServers` operator id 分属两个命名空间，合计最多八个挂载。
- 配置/版本 CAS 与用户授权 epoch、token revision 分离。停用、断开、重新授权及配置版本变更使旧连接/审批失效；正常 refresh 不改变安全 epoch。共享配置的普通用户授权按实际 subject 串行，不建立全平台用户互锁或永久总历史容量门槛。
- 预注册 public 或 `client_secret_basic` OAuth client，S256 PKCE、一次性 state、精确 issuer/resource/redirect/config 绑定；AS client secret 与用户 token 采用不同 purpose/AAD。API 只接受 write-only client secret，不返回 token、密文、PKCE、派生 metadata 或内部 owner 标识。自动 AS 动态客户端注册（DCR）仍未实现，不能用独立 HTTP factory 的存在代替。
- metadata、token、客户端注册 JSON 与资源调用分离网络目的；凭据只在最终发往精确目的地时注入。继续公网 DNS 全答案检查、socket pin、原 hostname TLS、禁止 redirect/proxy、字节与期限上限。显式测试双门禁才放行 loopback，不放宽生产边界。
- code exchange/refresh 的 SQL claim 在网络派发前持久化，不把网络放入事务；可能已派发后的响应丢失保守记为未知，只能重新授权，不能自动重发或让迟到结果复活已断开授权。工具派发后 401/403、step-up 或未知结果同样不自动重试。
- Redis 提供跨 runner quota/熔断、租约和失效 hint，不是授权 authority；每次 checkout/dispatch/return 仍读 SQL。全配置 runner 必须报告相同 key identity、callback identity 和 coordination namespace，不能只核健康子集；namespace 是操作方声明，不证明两个 Redis 实例物理相同。
- 显式 pin `2026-07-28` 或 `2025-11-25`，不隐式降级。池化增加实际 TTL/refcount 和 runtime cache participant；关闭/取消须等待真实请求、body、DNS/凭据读取与连接结清，不用 Promise race 假称已排空。

本包已由`187fbb2`完整CI及三份独立证据审计验收；`0062`为8表/32新guard/795全库guard，55份历史矩阵含非空0061→0062四项，主套件中的MCP Memory/MySQL/Redis与公开OAuth真实纵向均执行，精确子集计数见PROGRESS，不能与主5559项重复相加。2025仅已验stateless精确pin；stateful session/GET/DELETE终止、正式公网SSE progress、自动AS DCR仍未交付，不能由GET/DELETE允许列表或pool progress单测推断完成；预注册client已覆盖当前设计的一期OAuth要求。已有T3a/T3d/T3f在相关MCP footprint未处置时须fail closed，不绕开原生命周期门禁或把completion提升为true；MCP凭据物理生命周期/恢复仍是后续P2边界。下一tenant webhook的WIP不由这次MCP发布CI背书。

## 11. 公共进度与 2025 stateful 候选

本包已完成实现及本地分段验收，最终同SHA CI仍是发布门禁；不增加迁移、依赖、常驻服务、产品入口或镜像。§1～§10的早期范围和验收数字保留，实际通过状态只认PROGRESS末节。

- 正式事件为 `item/mcpToolCall/progress`，绑定当前session/turn、实际持久化`itemId`和模型`toolCallId`，携带有限非负`progress`、可选`total`及最多512 UTF-8字节的远端message。生产者另验`total >= progress`及严格递增；message是不可信owner正文，不进入日志。私有progress token、上游session ID、端点与凭据不得进入事件。
- 仅审批通过且execution-start COMMIT成功的实际MCP call可获得reporter；reporter固定该item与step，不因跨step重复toolCallId转绑。取消、失权、T1、关闭和terminal后不再接收新callback；它不占seq、不落MySQL/Redis Stream，SSE不写新id，重连仅重放durable最终item，不补造丢失进度。
- 每call独立owned publisher：仅live publication采用2秒I/O预算，首次失败封闭该观察器；停止admission准备结果时，整个待发队列另有一次不可重置的2秒排空期限。到期只关闭本观察器并等待真实native关闭与pending/late-connect结清，不改变工具结果、审批或共享Redis/lease/工具期限；不支持该能力的旧自定义bus丢弃progress，不回退到无界publish。真实Redis黑洞/正常长工具、Host与SQL/接管定向已通过，不能用原快照测试背书新修复；最终发布仍看同SHA CI。
- 正常成功结清的观察先于公开canonical completed；超时后本地socket关闭不证明远端撤销已收到的Redis命令，既有观察可能缺失或晚到，消费者须按`itemId`忽略已terminal调用的late progress。该不确定性不提升成工具结果unknown，也不允许关闭后新callback再被接收；不新增Redis永久fence或改变M1 purge协议。
- 现代匿名source与受管source均接正式typed callback，不从文本partial result反解析。两种已支持协议分别验证；强制审批、scope暂停/恢复、unknown不重试保持。
- stateful只属于显式`2025-11-25`注册。远端session仅在runner本地entry私有保存，绑定真实owner/config/version/授权身份；不同用户/tenant不能复用。GET使用既有建连/idle预算与绝对entry TTL，POST/DELETE仍保留整操作硬期限；全部实际I/O结清才释放lease。
- 当前registry capability没有本包独立版本位；新旧runner可能通过同一已有gate，但旧runner不会产生此进度，也不保证接受stateful SID。体验本包完整功能前应排空并替换全部runner，不能把无新DDL误称为混合fleet完整兼容。SID/GET不随runner接管或重启迁移，新entry初始化不重放已started的副作用；旧远端session仍依赖上游过期。
- 旧router按字节转发SSE；旧SDK运行时仅JSON解析，旧TypeScript union并不认识新type，自定义严格schema消费者也可能拒绝。旧runner的订阅schema可丢弃未知live进度，而不改变durable seq；不承诺旧客户端自动展示新功能，客户端应升级对应SDK并显式处理该事件。
- 空闲TTL或仍有完整授权的正常source关闭尝试一次官方`terminateSession()`；405不伪造远端ACK。实际main先摘流再drain，届时fresh fleet可能已不可达；此时只保证本地排空，远端会话依赖上游过期，不能为DELETE绕过gate。撤销/T1/fence及busy关闭也只硬关闭本地I/O。404/断流不自动重发可能已生效的`tools/call`；新初始化也不提供恰好一次保证。候选保持`maxRetries:0`并拒绝Last-Event-ID，上游GET自动恢复尚未实现，不从method允许列表推断完整兼容。
- 验收须使用官方server的真实stateful transport及GET/POST/DELETE/session map；既有`createMcpHandler` stateless模式不替代此证明。还须真实main/router/Pi/public SDK的Memory现代进度、MySQL/Redis受管stateful纵向，核审批前零通知、结果前实时到达、owner隔离、冷回放与seq不变。定向纯测试不代替后续完整门禁和最终SHA CI。

官方语义依据：[2025 transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[progress](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress)。自动AS DCR、stdio重池、完整hooks/middleware/subagent、必要M4及P2生命周期仍保留未完，不因本包而取消。

## 12. 后续自动 AS 客户端注册：已确认的产品边界

2026-10-20 用户确认以下后续 DCR 契约；这是需求决策，不是已交付功能或真实 AS 注册授权执行记录。当前先推进 M4，既有预注册 OAuth 继续可用。

- 显式启用沿用现有三级配置管理权限：平台 operator 管平台注册、租户管理员管本租户注册、用户只能管自己的注册。启用配置 DCR 不授予管理其它 scope 或读取用户 token 的权限。
- 每个不可变配置版本分别创建 AS client，不跨配置版本或 owner 共享 client 身份；支持 public client + S256 PKCE，以及显式选择的 `client_secret_basic`。client secret 和用户 token 仍分 purpose/AAD，密钥只写不读。
- 平台或租户共享 MCP 配置也不共享用户授权：OAuth token、state、PKCE 与实际 tenant/user 独立绑定，不能从配置 owner 推导用户身份。
- 实现仍须补独立的持久注册状态、网络目的与 SSRF/期限/字节限制、已派发响应丢失的未知状态及恢复/撤销合同；不能仅因 HTTP factory 已能发送注册 JSON 就宣称闭环。现有 claim、旧 receipt 与 unknown 不自动升级或改写。

2026-10-21 用户进一步确认下一 DCR 包的边界（仍是需求确认，尚未开始产品实现）：

- 由显式管理操作触发 AS client 注册，首个用户 `oauth/begin` 不隐式注册或重试。
- 首包仅支持无需 initial-access-token 的 AS 注册端点；受保护 DCR、远端 client management read/delete 不纳入本包，不借用用户 token 或其它凭据代替。
- 注册结果未知时保留原操作与证据并交人工核实，禁止自动重试、隐式重建、改写旧 receipt 或把本地 disconnect/删除解释为远端 client 撤销。

静态接点与拟定功能包见 `.local-run/dcr-next-package-static-plan-20261021.json` 及 `.local-run/dcr-next-package-confirmed-scope-20261021.json`；这些本机规划索引不代替 migration、实现、测试或最终 SHA CI 验收。每配置独立 client、实际 tenant/user OAuth 隔离及未知停止等原确认保持。

2026-10-21 实施候选（未发布，实际结果见PROGRESS）：新增 `oauth_dynamic` immutable intent 与0065 per-config sidecar，配置创建只发现并固定metadata/registration endpoint，显式 `POST .../oauth/client/register` 才创建client，`GET .../oauth/client/status`读取exact版本的无秘密状态。状态prepared/sending/ready/failed_not_dispatched/outcome_unknown不借用actual-user exchange/refresh claim；unknown不重发，替代配置必须显式新版本。basic secret独立 `as_dynamic_client` purpose/AAD并保留有效期，过期拒绝OAuth/runtime，不自动续client；管理API不返回秘密或远端management credential。本地停用、删除与用户disconnect仅阻断本系统，不证明AS client撤销。独立DCR能力门禁、SQL ready guards及历史/真实网络/两main/CI仍须全部验收，不能仅凭本段判定交付。

候选解析与兼容边界补充（未发布，不预填验收结果）：DCR metadata 和注册响应在后续 schema/身份摘要处理前采用有界 strict JSON，逐层拒绝重复字段名及解码后重复的转义字段名、键和值中的孤立 UTF-16 surrogate 等畸形 Unicode，以及 `1e999` 等转为非有限数的 JSON 数字；UTF-8 解码失败同样拒绝，错误不回显 wire 正文。

注册响应仅支持当前严格子集：201 JSON 的闭合字段集合为 `client_id`、`client_id_issued_at`、`client_secret`、`client_secret_expires_at`、`redirect_uris`、`token_endpoint_auth_method`、`grant_types`、`response_types`、`client_name`、`scope`，并按所选 auth method 核对必选字段和请求回显。额外字段，包括 `registration_access_token` 或 `registration_client_uri`，目前也拒绝；已派发的注册因此不能确认时保留 `outcome_unknown` 并交人工核实，不保存或调用远端 client management 凭据。这不承诺兼容任意 AS 的 DCR 返回；远端 management read/delete 仍不在首包范围。

`status.registration.state=ready` 表示该 immutable config 已有成功注册 receipt，当前启用状态、basic secret 有效期及实际用户 OAuth 仍须独立核验。停用、换版、删除或 secret 到期不改写成功历史；历史 ready 不证明当前可用或远端 client 仍有效。basic 的 `client_secret_expires_at` 仅接受0或可安全转换为毫秒的未来整数秒：0在本地记为无到期时刻，非零值保留为毫秒期限；首次提交及后续 OAuth/runtime 边界均须拒绝已到期 secret。到期不自动续 client、重发注册或升级历史 receipt，实际重新注册须显式新配置版本。
