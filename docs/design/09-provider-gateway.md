# Provider Gateway：资源治理与故障处理

本页是 M4 的实现合同。当前是 **838f 已验收基线之后的未发布 WIP**，不是完整 Gateway 或生产验收证明。正式结果以 `docs/PROGRESS.md` 当前快照和最后一节为准。

## 目标与交付边界

Gateway 内嵌在 `agent-runner` 的 ProviderService/Pi 请求路径中，不增加长期服务、进程或镜像。`agent-router` 仍是对外 Runtime API 入口，并负责私有 configured-fleet 核验；它不接收模型密钥。VM 发布包和 Linux OCI 镜像都继续交付 router/runner 两个角色。

本功能包补齐三级配额、平台密钥池、熔断及 turn-local 有界未派发故障处理。不能只在 HTTP fetch 中换模型：实际 provider/model、usage、子树预算及可见流输出必须一致。平台池/BYOK breaker、L0观测、显式未派发 fallback 与原生故障已有分段定向；此前 request-local fleet/source 修正的受控构建（source `3613c130` / dist `e2559a89`）已通过真实双角色2/32/1000平台容量，本轮cache/compaction修复未重跑该容量矩阵。本地分段门禁已收口，原full失败保留；最终同SHA CI仍待，不能据此宣称整个 Gateway 或生产验收完成。

## 配额合同

- 缺省未配置某项上限表示该项不设限，不凭空引入付费额度。配置的 `rpm`、`concurrency` 为 1～1,000,000 的整数；两项分别收紧，不相互替代。
- tenant 总量按 tenant 计；user 按 tenant/user 计。平台 provider 的额度跨租户共享；BYOK provider 按 tenant/provider 隔离，绝不借用其它租户的密钥。
- `PROVIDER_TENANT_QUOTA_JSON`、`PROVIDER_USER_QUOTA_JSON`、`PLATFORM_PROVIDER_QUOTA_JSON` 是 runner 的可信 operator 配置。租户 provider.quota 不能提高 operator 上限；平台额度逐字段取较小值。
- RPM 按每次已获准的实际 HTTP 尝试计数，使用 Redis TIME 的滚动 60 秒窗口。所有层在同一 Lua 操作中先检查后写；任一层拒绝都不部分消耗其它层。获准后、发送前又失权可保守消耗一次 RPM，不伪造退款。
- 不排队；额度不足立即拒绝。Redis/策略/fleet 核验失败时 fail closed，不自动降级成进程内计数器。Memory 实现仅供显式 Memory 合同及纯测试，正式 runner 即使 STORE=memory，启用 Gateway 仍要求显式 Redis。
- 并发许可持有到真实 fetch、响应体 EOF 或取消结清；收到 headers、发出 abort 或进入 close 都不是完成证明。租约丢失应取消实际请求，但不能以通知代替 I/O 排空。
- 配置修改不改变计数 key，不重置已有窗口；旧 resolved handle 在 provider 更新、删除重建或 BYOK shadow 后拒绝，不能绕过新上限。

SDK 注册缓存绑定完整配置身份，不能仅以更新时间充当版本：同毫秒删除重建或其它 runner 更新后，新请求必须取得新 endpoint、模型规格和价格；已经解析的旧 handle 保留自己的不可混用配置。

所有 Redis key/member 只含独立域摘要及随机 member，不含原始 owner/provider、URL 或密钥。三个层级共用一个 namespace hash tag，以保证跨层原子性；这明确是单 Redis Cluster slot，不是吞吐分片方案。逻辑 namespace 声明不能证明两个 URL 指向同一物理实例，部署仍须验证实际连接/IAM。

确定性摘要仍是可关联的运行状态，不等于匿名化或完整租户删除证明。T1 阻断新派发、真实请求排空及有限 TTL 不替代全部持久域的生命周期对账；全域 completion 仍为 false。

响应丢失时，取消仅针对本次随机 member，不退 RPM。每次 enter 固定 Redis 服务端时间的 admit-before 截止，取消标记有有限 TTL；标记过期后，原迟到命令也必须因自身截止而拒绝，不能复活。短租约不能在进程长暂停、Redis 数据丢失或不合作的上游下证明金融级 hard cap；本地平台1000峰值已测，不替代真实厂商、持续压力、Redis Cluster/持久化及故障转移验收。

## 滚动与角色配置

`PROVIDER_GATEWAY_ENABLED` 默认 `0`。关闭时若提供 operator quota JSON 必须拒绝配置；provider 非空 quota 而没有 coordinator 也必须明确拒绝，不能继续忽略已接受的上限。

runner 从规范化 quota、独立 Redis namespace 和算法版本计算 policy digest。router 只接收相同 digest 的 `PROVIDER_GATEWAY_POLICY_SHA256`，不接收 runner 的三个 quota JSON。每次实际派发前，用新 nonce、私有 token、no-store ACK 核验全部 configured runner 的 namespace/policy 和本地 Redis 就绪状态；不能仅取健康子集、缓存能力文档或忽略旧 runner。私有就绪端点不回调 router，避免递归。

Gateway 的 full-fleet 证明采用独立 request-local 调用，不与其它功能共享串行刷新或共享结果；每个调用重新核验全部 configured peer。只有此私有证明允许最多32个 active、1024个 FIFO waiter，quota/vendor执行本身仍不排队，也不新增operator调参。原 health 2秒预算从入口起算并包含排队，不重置或延长 caller 的预算；溢出、排队取消/到期均固定拒绝，且不发送 fetch/nonce或发布peer否定。原始冻结 proof 只属于本 registry/caller signal/精确目标，不能clone复用；后来的真实peer否定会永久使旧 proof 失效，迟到观察不能覆盖新状态。caller/close/sibling abort后须等待实际响应体取消结清，不能提前归还active名额。现有M1/MCP/skills/hooks门禁与未知owner 409行为不变。

最终 fleet await 返回后，普通 governed 请求也必须重验实际 T1 与 source revision/config/shadow，不能只保护 fallback。无 budget 回调时将原晚期读取移动到此处；有回调则仍保留 budget 前授权、把重复的 post-budget 读取合并到最后边界，无 quota 旧路径保持。所有 fallback source guards、permit 与同步 lease/signal 检查保留；这不是数据库与 HTTP 之间的原子事务或消除所有 TOCTOU 的证明。

现有 writer 必须先排空，再统一配置/启动新版本；不能把 default-off 或公开 `byok=true` 当作旧 runner 已执行配额的证据。本轮不修改现业务库权限，不启用生命周期删除或自动清理，也不提供猜测的云参数。

升级前须显式盘点已有 provider quota：新写入只接受1～1,000,000；历史更大的正整数仍按原值、脱敏且按tenant隔离返回，以便管理员检查，但运行期拒绝该配置，开启Gateway也不会自动扩大上限。未配置Gateway而历史quota非空时同样拒绝执行，不能继续忽略此前保存的限制。管理员应明确重写为支持的策略并统一配置后再恢复服务；系统不自动clamp、清空旧值或把读取成功当成派发许可。

## 未派发与已派发的区分

每个真实 Pi stream/compaction 请求拥有独立的进程内请求生命周期，不能在复用的 model handle 上放共享状态。只有服务端确认尚未调用真实 vendor delegate 的治理拒绝，才能归类为 `quota_exceeded`、`draining` 或 `subject_deleting`：不产生 provider usage/0053 upstream-failure capture。

quota 拒绝发生在子树 provider 预算准入之前；真正派发仍必须先获得原有 root-lease 预算，不扩张审批或工具权限。已派发后的断网、失权、流中断和释放不确定不能被当成“免费未派发”，仍须保留实际/unknown usage 及失败事实。不能从错误文本或零 token 推断这些状态。

同一请求在最终 Host 选模后、SDK 取 key 前创建，key/signal/fetch 绑定同一私有生命周期；预先已取消的 caller 不能先创建工厂或取 key。真实 factory 已派发且 provider/model 精确匹配的原始成功 result，只有规范的 input/output/cache-read/cache-write 至少一项为正、total 对账一致、配置价格已知时，才允许保存“配置价 × SDK 最后报告用量”的有限非负费用估计；原 result 绑定冻结 usage 快照，不从后续可变对象或 wire 副本补授权。缺 usage、全零（含真实报告零）、reasoning-only 或 total-only 保持 unknown；有正计价用量且显式零单价仍可记录合法的零估价。error/aborted 一律保守 unknown，保留已报告 token 数，不把 SDK 初始化零或部分结果当完整费用。

这不是厂商最终账单或金融级 hard cap；上游最后报告可能不完整，费用仍须后续独立对账。unknown 会按现有成本/子树预算规则停止后续准入，不以伪造免费维持多步运行。旧 usage/billing/receipt 不重写；无 factory 的旧自定义引擎仍按其既有兼容合同运行，不冒称具有此新来源证明。

若预算已获准后、最后派发门禁又失败，现有未结 reservation 仍保守转为 outcome_unknown，不伪造退款或真实 provider usage。派发前数据库/本地构造失败使用固定 provider_error，但没有真实 vendor 派发事实就不能签为 0053 上游失败来源。

同步 compaction 的配额拒绝保留固定错误代码（`quota_exceeded` 对应 HTTP 429）；已经接受的异步 turn 在持久化 error event/turn 中报告闭合代码，不把此前的 202 响应改称 429。普通 provider 错误继续使用固定公开文本，不回显上游正文、URL 或 secret。

真实 Pi compaction 已派发后发生错误、取消或得到空摘要时，不再静默跳过并继续当前主 turn。原始请求的私有来源只可消费一次；Host 原子保存真实 failed Turn、独立 step0 usage/匿名 billing、session 聚合及固定事件，再返回 `provider_error`。失败费用保持 unknown 并保留已报告 token；合法成功但空摘要可保留原始估价。它不生成摘要、不推进压缩水位、不发行 0053 来源；账务 COMMIT 不明时不重派。预取消在 factory/key 前停止；没有请求来源的旧自定义 summariser 异常仍沿用原兼容行为。

## 验证与剩余工作

新增用例登记进入主 coverage 必跑清单；具名纯测试与真实 Redis/HTTP/startup 组分别运行。真实 Redis 使用显式隔离 `REDIS_TEST_URL`，无业务库/云模型调用；响应丢失测试必须透传真实 Lua，不能仅靠计数 mock。

本页不替代最终同 SHA 的完整 verify/CI、SDK/bundle/VM 门禁。平台 key slot、BYOK冷却/half-open、启动/关闭、L0观测及下述显式 fallback 已有分段定向证据；最终本地平台2/32/1000容量已过，全包验收仍待。已派发 unknown 不能用第二次尝试补救；外部删除、自动清理、0037 grant 和全域 completion 边界不变。

新增原生故障5案以真实 Redis Lua/RESP、HTTP 和 Host/Pi 验证准入响应丢失、发送后断线及厂商503原始来源；它不是 server ACL、真实 router fleet 或 MySQL 证明。独立平台容量 profile 使用真实双角色 dist、MySQL 和原生 vendor 四峰/账务对账，范围与步骤见[压测手册](../operations/runner-load-benchmark.md)。修前成功与中间两次1000失败均保留；最终 registry310714/app55dd、source3613/dist e255 的1000轮原生0，四峰/完成/known usage与账务精确1000、双槽500+500、完整清理与库存不变。单进程诊断不当作真实多进程容量先决条件，也不把此次通过当成旧失败完整根因证明；原deadline与freshness未放宽。准确原始报告与受控构建绑定见PROGRESS。

平台池使用 runner 独占的受保护文件，不在环境变量正文、Redis、公开 capability 或 policy digest 中保存 key。每槽显式非秘密 id/version，单请求的 key 与 fetch 固定同槽，不在共享 model handle 上保存“当前 key”。跨重启更换 key 必须使用新版本、排空旧 writer 并统一配置；非秘密 inventory digest 只能证明配置声明一致，不能自动证明两个 runner 的秘密字节相同，也不提供云 KMS/密钥吊销证明。

### 平台池运行合同（已分段定向，未全包验收）

- `PLATFORM_PROVIDER_KEY_POOL_FILE` 是 runner-only 受保护文件引用；与任何已提供的 `API_KEY` 互斥（模板中的空 `API_KEY=` 也须移除），关闭 Gateway 时仍提供池配置必须拒绝。启动在分配服务资源前捕获一次，核对 preset provider，运行期不热读或替换秘密。
- `PLATFORM_PROVIDER_BREAKER_JSON` 仅在配置平台池时有效，闭合字段为 `threshold/windowMs/cooldownMs/rateLimitCooldownMs`，默认分别为 `5/60000/30000/30000`；threshold 范围1～100、三个毫秒值100～3600000。新 fleet 摘要绑定算法、原 quota 摘要、无 secret 的完整有序 inventory 与规范化策略；文件路径或 secret 摘要不进入公开身份，无池时保留既有 v1 quota 摘要。
- 每个请求只 `select` 一次并缓存选择 Promise。它只推进有界轮转 cursor，可跳过当前 open/disabled 槽作为候选提示，不获得半开或金融许可；SDK 取出的 key 与真实 fetch 固定同一个槽。clone 或相同字面量不是可 acquire 的原始进程内选择对象，不允许 fetch 内重新选 key/重试。
- 实际 fetch 先取得三级 quota，再 acquire 所选槽许可，最后重验预算、T1、fleet 与许可；响应 body EOF/取消真正结清后才 release。半开仅一个有效 token；epoch、固定服务端截止和当前 token 防止旧请求或过期探针改写新状态。abort/close 只中止消费者，不冒充 I/O 已结束。
- 此 breaker 衡量 HTTP transport，不证明 SSE 业务成功或账单完整：完整2xx transport可报告成功，5xx/非取消的原生transport错误计失败，401/403禁用该版本，429按服务端时间冷却，其它4xx中立。合法 Retry-After 秒数/HTTP-date 最多冷却1小时、至少配置值；非法提示只用配置值，不把真实 HTTP outcome 抹成未知。调用方/租约取消不计厂商失败，半开取消也不证明健康。
- 401/403 的 disabled tombstone 只含 operator provider/slot/version，不能按 idle TTL 自动清掉并复活同版本。其余闲置状态、cursor、permit/完成去重有界 TTL；禁用记录随显式版本更换增长，需容量管理，当前不自动删除。它不是厂商 key 撤销：Redis 数据丢失或恢复旧快照可能丢状态，不能宣称永久撤销、P2删除闭环或金融 hard cap。
- 健康状态读取/写入失败 fail closed，不回退进程 Memory。已真实派发但本地主结清失败仍记真实/unknown usage，不退款，也不签发新的0053上游失败来源；若原厂商错误被保留、仅 cleanup 二次失败，不用后者覆盖原错误。private ready 同时检查 quota 与 pool transport，关闭要结清实际 native socket。

平台池初版的 Memory32、Service33、资源前配置12及真实 Redis12、HTTP/Pi4、runner startup6 已分段执行；后继 BYOK、fallback 与多平台启动证据见下节和 PROGRESS，不把不同源码/分段拼成一次 full verify。不能用默认关闭掩盖普通请求、启动或隔离正确性。

## 已确认的重试与付费边界

2026-10-20 用户确认：真实派发后费用未知就停止自动重试，保留 unknown 账务，由调用方决定后续动作。零 token、SDK 初始化的零 cost、HTTP 错误码或尚未看到输出，都不是已证明免费。重试不能覆盖失败尝试的 usage/0053 来源，不能继续消耗已经关闭的 root budget。

跨 provider fallback 必须逐项显式指定目标 provider/model；BYOK 切至平台付费模型需要租户管理员另行启用，绝不借用其它租户的 key。现有仅含 provider ID 的 legacy `fallback` 列表不能推导等价模型或付费许可，不能因读到该字段就自动跨厂商转发。已公开 text、reasoning、tool args 或已持久化工具副作用后不替换输出、不重执行；compaction 保持独立 step0 单次请求。当前实现限于下述未派发切换，不是实际 HTTP 失败后的自动重试。

可选 `fallbackRules: [{model, targets: [{provider, model}]}]` 与独立 `allowPlatformPaidFallback` 最多32条源规则、每条1～3个精确去重目标，内部对象闭合。两个字段不向旧DTO插入默认键，付费开关缺失按不授权解释。原25项结构/兼容输入与生成API证据保留；候选执行、源存在/自目标、真实租户/平台授权现另有纵向定向证明，不能仅凭成功保存配置推断可执行。

## BYOK 单凭据熔断（已定向，未全包验收）

`PROVIDER_BYOK_BREAKER_JSON` 是独立 runner-only operator 开关，只有 Gateway 开启时才能提供，闭合四参数及边界与平台策略相同；不因配置平台池而暗中启用。未配置时原路径不变，显式配置使用 v3 fleet 摘要绑定原 quota 身份、可选公开平台库存/策略及独立 BYOK 策略，无 BYOK 时 v1/v2 保持。

复用一个 Redis pool coordinator，但平台与 BYOK 两侧的运行库存身份都经过不同 domain 哈希，避免 raw 平台 ID 与 BYOK 摘要结构同值。BYOK 按实际 tenant/provider 隔离，同租户用户共享相同配置版本的健康状态；只使用 Store 的正安全整数 `credentialSourceRevision`，legacy零/缺失拒绝，不从时间或 key hash 猜版本。该 revision 是 Store-mediated 配置来源版本：同 key 的配置更新、keyless 更新和删除重建也递增，不是凭据材料指纹、永久厂商撤销或抵御 DBA/旧物理快照的证明。

同request先固定选择再解密，quota之后 acquire，T1/版本/配置与最终fresh fleet仍重验。keyless不借平台key；显式Authorization按本配置匹配，否则key存在才允许其Bearer，所有其它已配置headers精确匹配。W3C三字段仍由服务掌控：剥离tracestate/baggage、刷新traceparent，不能为“匹配”而恢复原私有值。已禁用状态随配置版本增长（BYOK版本由租户管理员可推进，不仅operator槽版本），当前不自动GC，容量与生命周期边界仍需单独处理。

BYOK纯21、真实Redis/HTTP5与共享runner启动8已分段执行，含跨租户/版本、keyless、真实Pi的custom header、旧handle/T1和未知usage来源。Pi stream及独立compaction另显式传 `maxRetries: 0`：已核当前固定依赖默认也是零，这是防隐藏SDK重试的明确合同，不谎称此前发现了实际重试。它不构成 fallback 执行或厂商账单证明。

## L0 运行观测（已定向，未全包验收）

沿用独立 bearer 保护的 `/metrics`，`METRICS_ENABLED=1` 时 runner 的 Service 与 HTTP App 复用同一个进程内 registry；不另启服务、端点或 durable telemetry，也不因此开启 Gateway 治理开关。固定 `scope=platform|byok`，只有闭合拒绝类别与I/O结果，不把 tenant/user/provider/slot、URL、key、Error或正文用作标签。

attempt 在真实 vendor delegate 入口计数；active与duration直到原 fetch/read/cancel 真正结清才结束，且不包含后续health/quota release耗时。`completed`仅完整2xx传输，绝不等于SSE解析、turn成功或known账单；已知HTTP错误、transport错误、调用方取消与本地失权分别记录。收到headers或abort通知不提前减active，观察器getter/方法抛错不能改变业务结果、usage或0053来源。

新增registry17项加原HTTP/进程/认证五套共170项通过；Service27项、真实Redis/HTTP held-body新增1项及受影响回归已过。指标是有限、可丢失/饱和的进程观测，不是计费/撤销证据或跨重启累计。精确源、原失败、报告与资源状态见PROGRESS，不相加重叠组。

## 显式未派发 fallback（已分段定向，未发布）

只有本 Service 实例私有 WeakMap 中的原始冻结 request，在 API-key 选择阶段真正遇到 pool `open` / `disabled`，且尚未 key 成功、fetch、派发、取消或进入预算，才可一次性兑换下一候选。公开错误码、异常类型、零 token、假对象/clone 或其它 Service 的 request 都不是授权。源请求加最多3个显式目标，按顺序、不递归读取目标规则；真实 Pi 每语义 step 线性消费，至多一个实际 vendor dispatch。可信进程内 ResolvedModel 可复用，不把此对象接口当作不可信插件沙箱。

候选仍按实际 tenant/user 解析，各自使用自己的 key；平台源不能被租户同名 shadow 引向 BYOK。BYOK→任何平台模型都保守要求原源 `allowPlatformPaidFallback=true`，即使配置价为零也不猜免费；该字段沿用 requireAdmin 的租户 provider PUT，不开放普通用户写权限。现代源 revision/config、T1、所有祖先 key-selection 状态及当前目标在 key、预算前后和最终 fleet/lease await 后重新检查；这些是紧邻边界的独立检查，不是 MySQL/Redis/厂商间分布式原子快照。

Host 重验目标 canonical model、image/context、输出上限、剩余 limits、lifecycle/fleet；middleware 不能把已授权 target 再改成任意模型。预算回调同步进入即关闭替换，任意当前步 text/reasoning/tool-args（含空 delta）、assistant 或工具入口同样关闭；新一步才重置。Pi 不重建 Agent、不改写历史、不重放工具，缓存该候选唯一 key Promise（合法 undefined 也不二次解析）。最终 usage/turn 记实际模型，session/agent 默认不改；未派发候选没有 usage/0053，真正派发失败仍记 unknown 并停止，SDK stream/compaction 保持零重试。

平台 operator 配置新增 runner-only `PLATFORM_PROVIDER_FALLBACK_JSON`，形状为 `[{provider, rules:[{model, targets:[{provider,model}]}]}]`。最多32个平台源项×32规则×3目标，4MiB/8层上限，decoded duplicate keys 拒绝；来源/目标必须在本进程实际已配置的 platform models 中存在，不自动创建 preset 或借用主密钥。没有健康池的单 key 模型没有选择期 open/disabled 证据，规则不能让已派发失败获得重试权。

同一 `PLATFORM_PROVIDER_KEY_POOL_FILE` 另接受 `{"version":"provider-key-pools-v2","providers":[<v1 descriptor>, ...]}`：总1MiB、1～16个独立 provider，每个沿用 v1 的1～32槽合同；旧 v1 parser/API及256KiB限制不变。新 loader 支持两版，仍要求绝对路径、regular/0600或更严、当前UID、单link、leaf no-follow、前后stat一致、严格UTF-8、真实fd关闭；不保证父目录不可被特权者替换。v2 必须含 `PLATFORM_PROVIDER` 主项，每项有自己的 key；仅主项继承旧 `API_BASE_URL` / `DEFAULT_MODEL` 覆盖。真实 key 只通过安全预置私有文件交付，不能出现在命令行、文档或仓库；池存在时连空 `API_KEY=` 也必须移除。

v2 或显式平台 mapping 使用 v4 fleet 摘要，覆盖完整非密钥库存/策略/BYOK策略和有序 target 映射；无新配置的旧单池 v1/v2/v3 摘要保持。摘要不证明 secret 字节相等或槽版本跨重启未复用，仍由 operator 安全轮换负责。router 拒绝新JSON/密钥文件环境家族，只接最终摘要；local/dist 清理同步。必须全 fleet 相同身份再开启，不能热混用旧 binary。

已修 SDK header-only 接缝：auth resolver 返回空 request-auth，不读取 SDK credential store/env，实际 key 仍仅逐请求 options 提供；无 key 但显式 Authorization 的真实 Pi 路径可工作。固定 OpenAI adapter 对完全无 auth 或仅 X-Api-Key 仍在派发前拒绝，不造 dummy key、不借平台 key、不把它算作可重试故障。该限制及BYOK/fallback/真实厂商持续容量、持久化/故障转移、完整 M4/生产验收仍诚实保留；本轮真实 Redis/HTTP/启动、平台容量与纯测试结果见 PROGRESS。
