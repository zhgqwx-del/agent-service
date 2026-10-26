# MCP：受限HTTP工具、受管注册与用户授权

当前规范（2026-10-25）：固定HTTP source、三级scope受管注册/OAuth/池、公共progress、显式2025 stateful和0065自动AS client注册均已实现，纳入 `61c3a58 / CI40211433064 attempt1` 的本地/CI范围。完整MCP兼容矩阵、stdio重池、远端client management、物理生命周期和生产验收仍未完成。精确证据与旧失败见 [PROGRESS](../PROGRESS.md)。

本文约束当前HTTP实现；[总体架构§7.2](00-architecture.md#72-mcp)说明它在runner中的位置。旧M3.1a/M3.1b名称表示交付切片，不将旧“尚未实现”当成当前状态。

## 1. 范围与信任边界

MCP内嵌router/runner，不新增常驻服务、产品JavaScript入口或镜像。模型只能选择服务端已授权目录中的工具；不能提供URL、header、token、command、env或owner来创建新权限。现代协议显式pin `2026-07-28`，受管source另支持显式pin `2025-11-25`，不自动降级。

| 已实现、限定本地/CI验收 | 未完成或受限 |
| --- | --- |
| operator固定配置、精确tenant/user ACL | 静态配置热撤销须停服排空，不是跨fleet即时撤权 |
| platform/tenant/user注册、预注册public/basic OAuth、显式DCR | 不支持initial-access-token或远端client read/delete |
| SQL授权/refresh claim、加密token、Redis quota/失效hint、真实pool TTL/refcount | Redis不是授权authority；真实AS兼容、云KMS/容量待验 |
| 有界tools/list/call、mandatory approval、结果持久化 | 不自动抓resources/附件URL，不开放sampling/roots/elicitation/Tasks |
| live progress、2025 stateful GET/POST/DELETE子集 | progress不持久；SID/GET不迁移，自动GET恢复未实现 |

stdio、shell/fs、脚本/资源执行和任意租户代码属于后续隔离重池范围。

## 2. 接线与持久模型

[SessionHost](../../packages/core/src/session/host.ts)在create/turn preflight下解析owner-scoped source，经[service](../../packages/core/src/mcp/service.ts)或[registered](../../packages/core/src/mcp/registered.ts)装配目录。[ToolRegistry](../../packages/core/src/tools/types.ts)的builtin目录不保存用户远端工具。

持久调用仍为 `toolCall{kind:"mcp"}` 与canonical `toolResult`；`item/mcpToolCall/progress`是独立实时事件，不是新增持久item种类。catalog/config/owner身份变化在安全边界更新contextEpoch和toolsChanged notice，移除失效scope，不改写旧历史。

## 3. 静态operator配置与身份

固定serverId、canonical HTTPS endpoint、精确 `(tenantId,userId)` ACL及有界预算由可信operator提供。endpoint拒绝userinfo/query/fragment；no-auth source不接受凭据。不配置server即零MCP工具，未知/无权挂载拒绝。

HTTP agent的固定server id与受管 `mcpRegistrations:[{scope,name}]` 属于不同命名空间，合计最多八个挂载。session代建先验权限，再按实际session owner解析目录、连接和epoch；token模式不能借代建跨用户。tuple以无歧义编码生成身份。

静态endpoint/ACL/config修改须whole-fleet drain并替换。新功能体验须全部runner替换并升级严格SDK/事件消费者，不能由旧capability或无新DDL推导混合fleet完整兼容。

## 4. SDK与协议

仓库固定 `@modelcontextprotocol/client@2.3.1`，真实server fixture同为2.3.1；项目使用Node24。具体锁定以[lockfile](../../pnpm-lock.yaml)和[core manifest](../../packages/core/package.json)为准。

版本协商、标准header和envelope交给固定SDK；项目显式pin协议并限制capability，不允许用户覆盖保留字段。现代source采用discover/list/call，无protocol SID/GET stream，不与本服务SSE seq混淆。未知交互或 `input_required` 拒绝，不转成隐式模型、文件或用户操作。

## 5. 出站与凭据目的

[network](../../packages/core/src/mcp/network.ts)与[HTTP substrate](../../packages/core/src/mcp/http.ts)对每次实际连接检查全部DNS答案、拒绝非公网/混合地址、绑定实际socket IP，保留原hostname/SNI/TLS证书验证，拒绝redirect/proxy。配置时DNS预检不能替代socket pin；不修改global dispatcher。

不复制入站Authorization、Cookie、端用户JWT、X-User-Id、内部token、tracestate或baggage。metadata、registration、token、resource是不同目的；只有精确目的允许的凭据在最终发送处注入。静态no-auth的401/403不隐式进入OAuth；受管OAuth按独立状态机处理，不重发已started工具。

远端description/schema/result/progress均为不可信数据。资源link、image/file/附件URL不自动抓取，返回代码/command不执行。生产不能使用loopback测试豁免，测试双门禁仅证明对应fixture路径。

## 6. 目录、名称与审批

分页、总工具数、schema/description字节、JSON深度有界；畸形schema、重复名字、循环cursor、超限或未知协议不产生半个目录。目录摘要绑定完整配置、canonical endpoint、ACL和工具schema/description，turn固定快照。

模型名使用 `mcp__<server>__<tool>` 可读前缀与稳定hash，总长不超过64；身份绑定稳定serverId和原工具名，不信任serverInfo.name。与builtin/dynamic或同批工具碰撞拒绝，不能Map覆盖。

全部远端工具强审批，readOnlyHint/annotations、`approvalPolicy="never"`、普通autoApprovedTools和旧字符串都不能绕过。`acceptForSession`只绑定精确principal/session/server/config/catalog/tool；配置或目录改变失效。等待审批后及实际派发前重验owner、挂载、ACL与取消，started COMMIT之前不执行副作用。

派发前同一write-ahead COMMIT暂停可复用scope；只有成功结果与恢复scope同COMMIT后才可再用。错误、序列化失败、断流、崩溃或失权不恢复许可，下次须重新审批；这不是远端exactly-once。

## 7. 预算、取消与持久化

发现/调用、连接/header、整操作、POST/SSE/JSON字节/frame/深度、进度频率、分页/并发/队列均有界，progress不续命。取turn/agent/operator更严格值；readOnlyHint不证明并发安全。

所有实际I/O由TenantRuntimeCoordinator operation lease追踪；池另有真实cache participant/refcount。interrupt、T1/fence、drain和close先关准入并abort，再等授权读取、DNS、body/socket和late-connect真正结清才释放。底层DB读取不可取消时可能延长drain；HTTP期限不是整个授权链的统一硬期限。

write-ahead必须先durable item-started再派发；结果提交后才供下一模型步骤。远端执行后断流为outcome unknown，不自动重放；公共错误只给固定分类/文本。结果正文按owner-scoped item/Blob有界保存，不能进入operational日志。

## 8. 验收矩阵

当前CI具名范围包括真实router→runner/Pi→HTTP MCP/AS→第二模型步骤→durable结果/SSE；审批、scope暂停、双tenant/user/代建、目录变化、unknown不重派、取消/drain、Memory/真实MySQL/Redis与OS接管。真实socket/TLS负例与可控DNS doubles的证明分开。

定位：[MCP纵向](../../apps/agent-runner/test/mcp-registry-vertical.mysql.test.ts)、[OAuth](../../apps/agent-runner/test/mcp-registry-oauth.mysql.test.ts)、[progress纵向](../../apps/agent-runner/test/mcp-progress-vertical.mysql.test.ts)、[DCR纵向](../../apps/agent-runner/test/mcp-dcr.mysql.test.ts)。测试存在不等于执行通过，具体执行和源身份只看PROGRESS及最终CI；FakeVendor不证明真实模型质量。

## 9. 剩余安全与兼容义务

完整AS/MCP兼容、远端client撤销、凭据物理生命周期、云IAM/KMS、持续容量、跨故障域恢复和完整M3/P2仍未完成。SDK高层auth()不能直接越过本项目日志、issuer、凭据目的与持久claim边界。新secret/cache域未覆盖时必须阻断相关T3，不重签旧receipt，不把unknown升级成功，全域completion=false。

## 10. M3.1b 受管注册合同

配置owner为platform/tenant/user，OAuth凭据始终属于实际tenant/user；共享配置不共享token。router处理普通/独立平台管理面、固定OAuth callback和fleet核验，runner持独立protected key并执行SQL状态机与远端I/O，router不读取key bytes。

默认关闭，启用要求MySQL、Redis、显式namespace、固定callback URL和私有router origin，不从请求Host推导回调。配置revision/generation与用户授权epoch/token revision分开；停用、断开、换版使旧连接和审批失效，正常refresh不改变安全epoch。

public/basic client均使用S256 PKCE，一次性state精确绑定issuer/resource/redirect/config/actual user。AS client secret与用户token分purpose/AAD；秘密只写不读。exchange/refresh SQL claim先于网络，网络不在事务内；可能已派发后失联只能unknown并重新授权，迟到结果不能复活断开授权。

每次checkout/dispatch/return仍读SQL；Redis只是quota/熔断、lease和失效hint。全部configured runner须fresh、健康且key/callback/namespace identity一致，不选健康子集。namespace是operator声明，不证明两URL物理同Redis。0062及后继迁移的strict fingerprint要求旧writer/事务先排空、独立迁移、仅新版本并forward-fix。

<a id="11-公共进度与-2025-stateful-候选"></a>

## 11. 公共进度与2025 stateful（已实现，限定本地/CI验收）

`item/mcpToolCall/progress`绑定session/turn、实际durable itemId与toolCallId，有限非负progress、可选total和最多512 UTF-8字节message；生产者另验total≥progress及严格递增。message是owner不可信正文，不进日志；私有token、远端SID/URL/凭据不公开。

只有审批及execution-start COMMIT成功后的真实call能取得固定item/step reporter。取消、失权、T1、close/terminal后不收新callback。进度不占seq、不落MySQL/Redis Stream、SSE不写新id；冷回放只补durable最终item。

每call owned publisher的live I/O为2秒，准备结果后整个待发队列另有一次不可重置的2秒drain期限。到期关闭观察器并等native settlement，不改变工具结果/共享期限；旧自定义bus不支持则丢progress，不用无界publish。已发Redis观察可能晚到，消费者按itemId忽略terminal后的late progress；不能把观察超时升级为工具unknown。

stateful仅属于显式2025注册，SID只保存在runner本地entry，绑定owner/config/version/授权。GET有建连/idle与绝对entry TTL，POST/DELETE保留整操作期限。SID/GET不随runner接管迁移；新初始化不重放已started动作。正常有完整授权且idle的close尝试一次terminateSession；405不伪造ACK，撤销/T1/fence/busy或fleet不可达时仅本地排空，远端依赖上游过期。

`maxRetries:0`、拒绝Last-Event-ID；上游GET自动恢复尚未实现。旧router字节转发不保证旧SDK strict union展示新事件，完整体验前替换全部runner并升级消费者。

## 12. 显式自动AS client注册（0065）

三级管理权限沿用原scope：platform operator、tenant admin、user self各管自己的注册。每immutable config version独立AS client，不跨版本/owner共享。仅显式 `POST .../oauth/client/register` 触发，`GET .../oauth/client/status`读无秘密状态；首个oauth/begin不隐式注册。

独立sidecar状态为prepared/sending/ready/failed_not_dispatched/outcome_unknown，不借用户exchange/refresh claim。同version只发一次claim，同exact idempotency key读原状态、异key冲突；过期prepared不重领。sending是派发前持久标记，不证明AS已收到；不确定结果保留unknown并人工核实，不自动重试/换版。确证未派发且仍需注册时才由管理者显式新版本。

支持无需initial-access-token的public+S256或显式basic；basic secret独立 `as_dynamic_client` purpose/AAD。closed注册响应仅支持client_id、issued_at、secret/expiry、redirect_uris、auth_method、grant_types、response_types、client_name和scope对应字段，并按method核验必需项/请求回显；registration_access_token/client_uri等额外字段也拒绝，派发后可能因此unknown，不保存或调用management credential。

metadata/响应先经过有界strict JSON：拒绝重复及转义后重复key、孤立UTF-16 surrogate、非有限数和非法UTF-8，不回显wire正文。ready只表示成功注册历史，当前enabled、basic expiry和用户授权另验；停用/换版/删除/secret到期不改历史，不证明远端client撤销。expiry只接受0或可安全转毫秒的未来整数秒，后续边界拒绝过期，不自动续client。

实现定位：[routes](../../apps/agent-runner/src/mcp-registry-routes.ts)、[registered](../../packages/core/src/mcp/registered.ts)、[strict JSON](../../packages/core/src/mcp/dcr-json.ts)、[MySQL DCR](../../packages/store/src/mysql/mcp-dcr.ts)。该具名范围已纳入61c CI；真实AS产品兼容、初始token及management read/delete仍未交付。
