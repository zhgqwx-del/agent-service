# 安全威胁模型

本文约束已实现的共享轻池与HTTP扩展。具名本地/CI验收及运行版本见 [PROGRESS](../PROGRESS.md)。安全控制的实现与目标生产验收分别判断；真实云信任根和全域生命周期尚未完成。

## 1. 资产与信任边界

- 身份：service API key、实际tenant/user、session owner、admin scope和独立operator authority。
- 内容：会话正文、工具参数/结果、图片/Blob、skills、导出与备份；匿名工具连接不使内容成为公开数据。
- 权限：不可变agent版本、工具集合、审批、0066 session authority、租户T1与runtime drain。
- 凭据：模型/BYOK、tenant auth、MCP用户token、AS client secret、hooks密钥和内部token；各自用途与AAD独立。
- 证据：item/event seq、幂等receipt、账务事实、冻结的历史receipt与恢复来源；新功能不能重释旧证据。

入站为调用方→router→runner；出站为runner→模型/MCP/AS/webhook/对象存储。部署配置可信不表示远端服务、DNS、description、schema或正文可信。同一runner中的不同tenant/user是隔离域，共享SDK/cache/连接池不能取消该边界。

## 2. 身份与写入权威

runner权威验证service/user/scope与资源归属；router管理面、内部入口和fleet观察仍须独立认证。`trusted_caller`的service key只放可信后端；`end_user_token`按已验证subject确定user，不能从header/body换成他人。

MySQL模式下，0066以实际binding、DB clock、完整owner tuple与opaque proof授权session写入。Redis计数、数值fence、runner名称、缓存和JSON均不能补造写权限；响应丢失只确认同一acquire command。owner观察不完整或冲突为unknown。详见[架构§4](00-architecture.md#4-有状态性与分布式一致性)与[authority实现](../../packages/store/src/mysql/session-authority.ts)。

0037 grant硬拒、0054 original-primary-only destructive、适用功能的production拒绝、外部删除/自动清理关闭和全域completion=false保持。

## 3. 扩展路径的控制矩阵

| 威胁 | 当前控制与限制 |
| --- | --- |
| 跨tenant/user发现或调用 | actual owner解析；固定ACL或三级scope授权；不接受工具参数自报owner/凭据 |
| 代建身份串用 | 校验代建权限后按被代建owner解析目录、连接、epoch与审批 |
| DNS rebinding/内网探测 | MCP/AS/hooks/web_fetch各自受控连接：全DNS答案分类、实际socket pin、原hostname/SNI/TLS、redirect拒绝；不将一个路径的证明借给其它路径 |
| 凭据跨目的地泄漏 | metadata/registration/token/resource分目的；凭据仅在精确目的注入；不复制入站Authorization/Cookie/JWT/内部token/baggage |
| description/skill/result提示注入 | 作为有来源的不可信材料；不得增加工具、审批、系统权限或预算 |
| 伪只读或never绕过审批 | MCP全远端工具强审批；readOnlyHint、旧字符串与普通autoApprovedTools不授予许可 |
| 目录替换/许可复用 | 工具名稳定hash且冲突拒绝；许可绑定principal/session/server/config/catalog/tool，变化失效 |
| 任意资源/代码执行 | 不自动抓resource/image/file URL，不加载租户代码，不声明未支持的roots/sampling/elicitation/Tasks；stdio重池另行设计 |
| 响应/队列/慢消费者耗尽 | 目录/JSON/frame/字节/分页/并发有界；SSE有runner本地准入、queue/replay/stall预算；不据此证明全fleet公平性或RSS硬上限 |
| 取消后继续运行/假排空 | 先关准入并abort；等待真实DB授权读取、DNS、body/socket和owner work settle，不以Promise race释放引用 |
| 副作用重复/未知伪成功 | write-ahead先于派发；结果持久化后才给后续模型；unknown不自动重发，不承诺远端exactly-once |
| 错误/进度泄露 | 固定公共分类与content-free日志；progress为owner正文、无durable seq；不记录原始URL/header/异常/secret |
| 协议隐式降级 | 显式pin支持版本；现代和2025 stateful分别约束，未知协议拒绝 |
| 共享进程或子任务扩权 | 每turn独立Agent；child工具取父/目标交集，不继承父grant；固定middleware只收紧并重验schema |

IdP JWKS/introspection另有现有实现/验证缺口，需单独安全审查：配置公网预检不等于连接时socket pin，introspection普通fetch未显式禁止redirect，JWKS的具体redirect行为还须按固定JOSE审查。不能将该行为认可为安全合同，或借MCP/web_fetch的原生网络验收覆盖它；目的地与凭据安全目标保持。既有身份测试不证明此网络边界，本轮未复现攻击、未定核心P0，也未改源码。

实现接点：[MCP network](../../packages/core/src/mcp/network.ts)、[registered](../../packages/core/src/mcp/registered.ts)、[public-web](../../packages/core/src/tools/builtin/public-web.ts)、[hooks](../../packages/core/src/hooks/service.ts)、[Host](../../packages/core/src/session/host.ts)与[SSE](../../apps/agent-runner/src/sse.ts)。真实DNS/socket路径与注入式fixture的验收范围分开记录。

## 4. 目录、撤销与配置

session创建、turn preflight、等待审批后执行及实际派发边界按各自合同重验owner、配置、T1与取消。未知挂载不降级builtin。新目录在安全边界更新epoch/尾部通知，不改旧历史，不沿用失效许可。

operator静态配置变更须whole-fleet停服排空、统一替换；受管配置/token有自己的SQL revision/epoch和fresh fleet核验。Redis hint不是授权authority，不能只取健康子集。drain超时或I/O未结清保持fenced，不宣称零引用。

逻辑disable/delete/disconnect只阻断本系统后续使用，不证明AS client、厂商key或远端对象已撤销。新registry/hook/task域未纳入完整物理生命周期时必须明确blocker，不能扩义旧receipt。

## 5. OAuth与DCR

已实现三级注册、实际用户token加密、SQL claim/refresh单飞、pool、失效与有限quota/breaker。public/basic OAuth均绑定S256 PKCE、一次性state、issuer/resource/redirect/config及实际用户；共享配置不共享用户凭据。

0065 DCR必须由显式管理操作触发，每immutable config version独立client和唯一claim。`oauth/begin`不隐式注册，已派发或sending不确定结果保留unknown且不自动重试。仅支持无需initial-access-token的注册端点和严格响应子集；远端management read/delete与完整AS兼容矩阵未交付。详见[MCP](06-mcp.md)。

项目使用自己的受控OAuth/HTTP与content-free错误边界，不能因为SDK提供高层auth()而直接接入其潜在原始console输出。不得以全局禁日志、跳过issuer、放行内网或fake receipt绕过义务。实际AES-GCM与protected-file实现不等于云KMS或密钥轮换已验收。

## 6. 验收与剩余风险

已接受CI只证明实际执行的具名范围：真实router/runner/Pi、HTTP MCP/AS/webhook、Memory/SQL/Redis、持久结果、审批/隔离/取消与恢复负例。FakeVendor提供确定性选择，不证明真实模型质量；client stub和SQL mock不替代真实协议/事务证明。

仍须目标环境验证IdP/AS/MCP兼容、TLS/IAM/密钥管理、持续容量、HA、联合恢复和完整生命周期。第三方SDK/Node独立输出、不可取消DB读取的停机耗时、全fleet稳定地址与单Redis slot容量均保留为边界。原失败与分源复验见PROGRESS，不能以登记、默认off或后继成功抹除。
