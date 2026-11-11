# 共享轻池的资源准入与占用隔离

**状态：设计提案，规划未实现。** 本文以源码 `2d55b9b` 的静态行为为基线，定义补齐 runner 总量准入、tenant/user 占用限制与工具资源边界的最小方案。新增配置、名额、错误 details、观测及验收要求均未交付，不能从本文推断当前环境已经启用。当前版本和验收仍以 [PROGRESS](../PROGRESS.md) 为准。

方案保留 router/runner、SessionHost、Pi、MySQL authority 和 Provider Gateway；不引入重池、持久任务队列、全 fleet 调度器或任意代码执行。轻池与重池的能力边界见[总体架构](00-architecture.md#76-沙箱分层一期只建轻池)，子任务与模型资源合同分别见[设计 02](02-subagents.md)和[设计 09](09-provider-gateway.md)。

<a id="scope"></a>

## 1 范围、保证与不变量

本包将 runner 内可保留的短操作、执行生命周期、工具 I/O、动态工具等待和主要内容缓冲限制为有限集合，使每个实际 tenant/user 不得超过其配置额度。所有身份来自 runner 鉴权和实际资源归属，不能采信请求正文中的 owner、工具名或自报配额 key。

这里的“执行”包含昂贵预检、自动摘要、已接受但尚未启动的 turn、Agent 循环、审批/工具等待及实际结算；不能只数 `new Agent()` 或模型 fetch。显式 compact 单独占一个执行名额；child 占自己的执行名额并继续受原 family 预算限制。

以下不变量保持：

- 容量许可只限制资源使用，不授予 session 写权、工具权限或付费授权。每次写入仍须既有 MySQL authority、fence、owner、lifecycle 与审批合同。
- Gateway 的 Redis 配额与本地容量分别核验，不相互替代，不从本地计数恢复所有权或跨进程配额。
- 拒绝新资源使用不抹去已经接受、派发、提交或结果未知的事实；客户端断流不取消已接受 turn，unknown 不自动重派。
- 取消先关闭后续准入并请求 abort；名额持有至其拥有的实际工作结清。超时、terminal event、HTTP EOF 和宽限期结束均不能单独证明资源已释放。
- 不在共享进程加载租户代码，不新增 shell/fs/stdio 工具，不把目录、审批或 `sandbox:"none"` 解释为 OS 沙箱。

本包提供本地占用上限与故障扩散范围的收紧，不承诺无饥饿、公平排队、全 fleet 份额、全进程 RSS/fd/CPU 硬上限、远端回滚或金融硬预授权。生产容量、OS 限额、真实持续负载和目标环境仍需单独验收。

<a id="current-gaps"></a>

## 2 当前源码事实与关键缺口

| 当前事实 | 缺少的保障 | 源码入口 |
| --- | --- | --- |
| 每个新 turn 建立独立 Pi Agent；Host 的 `active` 是按 session 记录的 Map | 没有 runner/tenant/user 总活跃执行准入；`active.size` 只用于 drain 等待 | [Pi](../../packages/core/src/engine/pi.ts)、[Host](../../packages/core/src/session/host.ts) |
| `serialiseSessionStart` 保存每 session 的 Promise 尾链；steer 有独立链和待投递数组 | 请求数量、保留字节及累计 steer 没有统一上限；串行不能避免队列增长 | Host `beginTurnOwned`、`serialiseSessionStart`、`steerActive` |
| model/tools/skills/hooks、历史、Blob 水合和可能的自动摘要发生在 `active` 登记前 | 只在 Agent 启动处设限会漏掉昂贵预检和摘要 | Host `beginTurnLocked`、`beginTurnInner` |
| 显式 compact 加载历史并可调用摘要模型，但不创建 Agent | 不能用 Agent 数覆盖全部执行负载 | Host `compactSessionLocked` |
| SSE 默认 128 个 runner 连接、32 个 tenant 连接，并有 queue/replay/stall 边界 | 它只治理观察，`stream:false` 和断流后继续执行的 turn 不由该连接数限制 | [observation](../../packages/core/src/session/observation.ts)、[SSE](../../apps/agent-runner/src/sse.ts) |
| Gateway 可限制实际模型请求 RPM/并发；默认关闭，未配置字段不设限 | 等审批、工具或下一步的 Agent 仍可占内存；配额拒绝不是任务公平调度 | [Gateway 配置](../../apps/agent-runner/src/provider-gateway-config.ts) |
| Pi 工具批允许受控并行；部分 MCP/hooks 有每用户并发和超时 | 没有统一 runner/tenant/user/origin 工具 I/O 占用限制；`concurrencySafe=false` 不是跨 session 资源锁 | [工具适配](../../packages/core/src/engine/pi.ts)、[MCP](../../packages/core/src/mcp/service.ts) |
| `mergeLimits` 缺字段时回退为 20 steps、50 tool calls、5 分钟、¥10、8192 输出 tokens | 缺省值不参与显式层的最小值计算；Host 当前没有统一 runner operator ceilings 层 | [Limits](../../packages/protocol/src/common.ts)、Host `beginTurnInner` |
| 已有请求体、Blob、MCP、SSE 等局部字节边界 | 普通 step 的最终模型输入、累计 text/reasoning/tool args、steer 和工具结果仍需统一有界；不能只在 `JSON.stringify` 后测长度 | Host `prepareModelStep`、`prepareToolOutput` |

`prepareModelStep` 当前只在特定 lifecycle/extension/delegation 路径装配。本方案要求最终输入与输出检查覆盖所有普通 step、允许的未派发 fallback、自动及显式摘要，不能仅给已有 middleware 分支加检查后声称全部覆盖。

<a id="configuration"></a>

## 3 拟议 runner-only 配置

### 3.1 配置策略

建议新增四个闭合 JSON 配置组。**当前代码不存在这些配置；拟议新版本要求四组全部显式提供有限值，没有可运行的缺省数值。** 实际容量值须用隔离环境的资源和持续负载测量选定，本文不提供可直接粘贴启动的伪默认值。不新增可绕过本包的 enable 开关；缺组、缺字段、零值或解析失败均在创建服务资源和监听端口前拒绝启动。

四组均要求 `schemaVersion:1`；下面点路径表示 JSON 内部字段，不是额外环境变量。拟议固定解析边界为每组 UTF-8 16 KiB、嵌套深度 8、结构节点 512，超限在完整对象构造前拒绝；这些是提案中的解析器边界，不是执行容量默认值。对象、枚举和字段全部闭合；拒绝重复 JSON key、未知字段、accessor/原型输入及不安全算术。数量与字节为正安全整数；毫秒值另不超过原生 timer 上限；`maxCostCNY` 为有限正数。`0`、负数、空值、`Infinity`、缺省及极大值溢出均不能表示无限。各计数器、字节累加及实际 timer/adapter 可承载的进一步数值上界须在 L0 冻结，不能用安全整数范围冒充已测资源容量。

配置由可信 operator 提供，普通 tenant/admin/agent/request 无权放宽；启动时冻结，运行期不热改。配置变更按全 fleet 排空、统一替换、独立检查后再开放入口处理，不清计数来制造余量。新配置 schema、容量口径与非秘密规范化摘要参与兼容检查；新旧 runner 或摘要不一致时不能把已探测子集当作整套保障已就绪。首包按同一冻结策略部署；按机器分档的异构容量策略另行设计。

### 3.2 `LIGHT_POOL_ADMISSION_JSON`

| 必填字段 | 单位与含义 |
| --- | --- |
| `submit.global / tenant / user` | 同时保留的提交类短操作数；包括 turn/compact/session 创建、steer 和 POST 幂等检查 |
| `control.global / tenant / user` | 同时保留的结束执行所需控制操作数；interrupt、审批决策和动态工具结果回传使用独立保留通道 |
| `observe.global / tenant / user` | 同时保留的读取、原 operation/turn 核对及 SSE 建立/追赶准备操作数 |
| `live.global / tenant / user` | 从重预检前到真实结算的执行数；root、child、显式 compact 各计一个 |
| `sessionPending.submit.maxOperations / maxBytes` | 同 session 提交类等待和处理中的短操作数、保留输入 UTF-8/二进制字节 |
| `sessionPending.control.maxOperations / maxBytes` | 同 session 控制操作的独立数量和字节预算，不能被 submit 消耗 |
| `sessionPending.observe.maxOperations / maxBytes` | 同 session 观察准备操作的独立数量和字节预算 |

每一 lane 与 `live` 均要求 `user <= tenant < global`；首包按多租户共享轻池校验这一关系，避免一个租户独占该池，但不为每个其他租户预留固定空位。每 session 数量不能超过所属 lane 的 user 上限；每 session 字节计量包含排队参数及其受控物化副本，不能只计原 HTTP header/body。精确重放仍占短操作额度，但不重复占一个 live 名额。steer 是 submit，不因目标已有 turn 而取得 control 保留额度。

SSE 的长连接、回放和帧缓冲继续使用既有独立有限配置；交接完成后释放 observe 短名额，不让一个长 SSE 永久占用短操作通道。新 live 限额不能替代 SSE 准入，反之亦然。

### 3.3 `LIGHT_POOL_IO_JSON`

| 必填字段 | 单位与含义 |
| --- | --- |
| `io.global / tenant / user` | 同时预留或执行的轻池工具/扩展 I/O 操作及受管 MCP 驻留连接条目数，条目生命周期见§5 |
| `origin.maxOperations` | 同一可信规范化 origin/内容 backend namespace class 的同时 I/O 数；与前三项同时核验 |
| `dynamicWait.global / tenant / user` | 等待客户端回传的动态工具调用数；从登记 pending 前到回传/取消/超时的实际收尾完成 |

要求 `io.user <= io.tenant < io.global`、`dynamicWait.user <= dynamicWait.tenant < dynamicWait.global`，且 `origin.maxOperations <= io.global`。origin 由实际受控目标得出，不能由模型自报：网络操作使用既有验证后的 canonical origin；内容物化使用固定 backend namespace class，不能把文件路径、blobId 或 user 输入作为新 origin。该维度仅限制占用，不授予新的目标地址、内网或文件访问权限。

本组覆盖 web_fetch、MCP discovery/call、外发 hooks、skills/Blob 内容物化等工具与扩展操作。模型/摘要继续由 live 名额、operator ceilings、字节边界和原 Gateway 治理；不为本包改写其已有复杂派发链。SQL authority/commit、取消和实际 close 不递归申请同一个工具 I/O 名额。本组不是全系统请求数、socket 或 fd 的硬上限。

### 3.4 `LIGHT_POOL_OPERATOR_CEILINGS_JSON`

必填字段与现有 Limits 一一对应：`maxSteps`（模型 steps）、`maxToolCalls`（调用数）、`maxWallClockMs`（毫秒）、`maxCostCNY`（CNY）、`maxOutputTokensPerStep`（tokens）。数量、期限与成本均有限。

有效值明确取 `min(operator ceiling, agent, request, 当前更严策略)`，缺少 agent/request 字段时仍保留 operator ceiling；原 `mergeLimits` fallback 不能反过来扩大它。子任务继续取根/父/目标策略与原 family 限制的交集，不能因得到新的本地名额重置 family 计数、根 deadline 或成本。

operator 的墙钟期限从 live 名额授予时开始，覆盖预检和自动摘要；内部使用单调时钟。既有公开 `turn.startedAtMs` 保留持久接受的含义。turn 开始、middleware 收紧及 child 继承时，只能采用原 deadline 的剩余值，不重新获得完整窗口。到期关闭新派发并请求取消，名额仍等真实结算，不承诺硬截止退出。成本仍是可信 usage/估价结算后的后续准入限制，不升级为硬金融预留。

### 3.5 `LIGHT_POOL_BOUNDS_JSON`

| 必填字段 | 单位与含义 |
| --- | --- |
| `context.maxInputBytes / maxItems` | 最终单次模型输入的 UTF-8/二进制保留字节与结构项数，包含系统材料、历史、tools schema、当前输入和已物化内容 |
| `context.maxJsonDepth / maxJsonNodes` | 工具参数、声明、结构化结果与受控序列化的深度/节点数 |
| `output.maxModelResponseBytes` | 单次模型/摘要响应经受控 transport 解码后的总字节预算，包含协议和结构化内容；不只计可见正文 |
| `output.maxStepBytes / maxExecutionBytes` | 单 step、整个执行累计保留或提交的 text/reasoning/tool-args 字节；step 结束不退回累计预算 |
| `tool.maxArgumentsBytes / maxResultBytes / maxExecutionResultBytes` | 单次有效参数、单次 canonical 结果、整个执行累计工具结果字节；包含 content/details 及 framing 预算 |
| `dynamic.maxDeclarations / maxDeclarationBytes / maxResultBytes` | 动态工具声明数量、声明总字节和单次回传结果字节 |
| `steer.maxPendingOperations / maxPendingBytes` | 一个活跃 turn 待处理或待投递 steer 的数量和字节 |
| `steer.maxTotalOperations / maxTotalBytes` | 一个 turn 生命周期累计接受的 steer 数量和字节；已投递或已消费不退回 |
| `deadlines.maxShortOperationMs / maxPreflightMs / maxToolIoMs / maxDynamicWaitMs` | 短操作、重预检、单次工具/扩展 I/O、动态工具等待的准入期限（毫秒） |

要求 step 上限不大于执行累计上限，单结果上限不大于累计结果上限，dynamic 结果不大于工具结果上限；pending steer 不大于 total steer，且每 session 提交预算能容纳配置允许的单次输入。`maxPreflightMs` 不大于 operator 墙钟期限；实际 I/O、动态等待期限取本组、原组件、agent/turn、根 deadline 的最小剩余值。以上关系与所有字节累加须启动时和运行时分别校验，不允许溢出后变成负数或更大预算。

字节是资源约束，不能替代模型真实 token/context 限制。超大输入或结果不得通过静默截断、删除未知字段、扩大公开最大值或降低旧组件检查来通过。

<a id="admission-flow"></a>

## 4 名额获取、移交与释放

### 4.1 原子本地计量

一个 runner 内使用同一个资源准入组件管理上述有限名额，global/tenant/user（I/O 另含 origin）在一个同步本地临界区里先全部检查、再统一占用。任何一层拒绝都不部分扣减，也不返回可由 JSON 伪造的许可。每次成功产生唯一进程内 permit；重复 release 幂等，不能释放其他请求的名额。

首包采用满额立即拒绝，不等待空位、不增加通用工作队列。既有 session 串行队列继续用于正确性，但进入前必须取得短名额并满足 sessionPending 数量/字节边界。没有名额时不先创建 Promise 链、计数 key 或保留正文再排队。

### 4.2 普通 root turn

| 顺序 | 所需许可与行为 |
| --- | --- |
| 鉴权和路由分类 | 按实际 principal 获取 submit 短名额；在 Host 早期查询、session 队列和受控输入物化前生效。HTTP body/auth 自身仍需既有及受控部署入口上限，不能声称 Host 计数覆盖全部未鉴权 socket |
| 资源归属、receipt 与本地 busy 检查 | 已完成或仍在本地执行的精确 replay 返回原事实；steer 走旧 turn。均不再取得 live 名额；短名额与保留字节在原工作完成后释放 |
| 确定新执行候选 | 在 acquire/repair、工具发现、历史、水合、摘要等昂贵预检之前原子 `tryAcquire` live；如随后的 authority 重读发现晚到 replay，则结清本次检查后释放临时 live |
| 重预检 | live 覆盖整个阶段；每个实际工具/扩展 I/O 另取自己的 I/O permit；自动摘要使用同一 live 和原 Gateway，不重复取得 live |
| SSE 与持久接受 | 保留既有 SSE 准入、session authority 与原子 `turn/started` 边界。所有待移交许可都有唯一持有者；SSE 拒绝、预检拒绝和晚到 receipt 不得遗留 permit |
| 交接至 ActiveTurn | live 从预检上下文移交给 exact ActiveTurn，覆盖 reserved/run/等待/settling。提交类短操作完成交接后释放，不再由 HTTP 连接寿命决定 live |
| 执行与结算 | 继续既有 engine、write-ahead、审批、usage 和终态链；live 在本执行拥有的 steer、提交、child、observer、实际 I/O 与 authority/runtime 清理全部结清后精确一次释放。独立 SSE 观察或已明确移交至有界 MCP entry 的生命周期不等待原 live，分别继续持有自己的额度 |

durable accept 后到 `run()` 之前存在真实 reserved 窗口，必须占 live；请求断开或 drain 在该窗口发生时走现有受控终结，不能只丢弃 HTTP 引用。COMMIT 结果未知时不重新创建 turn 或取得替代执行，只允许按原 key/turn 只读核对。物理名额与业务 unknown 分开：原生工作尚未 settle 必须持槽；本机拥有的工作已经全部 settle 时可以释放本地名额，即使远端 outcome 或持久 COMMIT 仍为 unknown。unknown 证据与禁止重派继续保留，不把释放解释成业务回滚，也不因业务未知永久占住已无物理工作的名额。

### 4.3 child、compact、replay 与 steer

child 在昂贵子预检及持久 `createSubagentTask` 前取得自己的 live 名额，父执行等待时仍占其原 live。local global/tenant/user 与原 family 准入都必须通过；本地容量不足立即返回闭合的 canonical 工具错误，不创建半个 child，不写伪成功活动，不换 runner 或自动重派。若父 task 调用已写 started，仍按原 call item 提交该确定错误，不能把它当成远端 outcome unknown。预算持久化若已进入未知状态，继续原 unknown 合同，不能退回“只是容量不足”。

任何父执行不得持自己的资源名额排队等 child 名额；立即拒绝避免整池父等子形成死锁。child 只复用根 authority，不复用根的 live 数量额度。显式 compact 使用 submit 短名额和独立 live，覆盖其历史、摘要、提交和清理，按 exact session 串行；不因没有 Agent 而豁免。

steer 不增加 live，但在加入 `steerChain`、水合、持久化和 `pendingSteers` 前原子检查并预留 pending 与累计数量/字节。确认未接受时释放临时预留；累计预算在持久接受后不因模型消费、回放或 step 切换退回；精确同请求 replay 不重复累计。COMMIT 未知时保留保守累计与原身份，不能当确定未接受退款后重派。确定的容量拒绝须发生在该 steer 持久接受前；接受后的失权或交付失败沿原失败/unknown合同处理，不把它改称未接收。POST replay 与独立只读核对仍须鉴权，不以容量旁路返回他人 receipt。

### 4.4 有限控制保留通道

interrupt、审批决策、动态工具结果回传走 control lane；状态/原 turn 核对走 observe lane。live、submit 或工具 I/O 满额不能消耗这两类的保留额度，也不能要求控制操作先拿一个新 live 才可使旧执行结算。保留通道自身仍有 global/tenant/user、sessionPending、字节和期限限制，不能成为无限入口。

控制接口不能隐式发起新的模型、工具或摘要：审批通过只解除原审批条件，实际派发仍独立申请 I/O/预算；原 tool result 的持久提交及实际取消/close 不递归等待同一工具 I/O 名额。SSE 内容发送和控制响应继续各自的身份与有限传输边界，不因“控制”标签扩大正文披露范围。

<a id="io-boundary"></a>

## 5 工具 I/O 与等待名额的边界

I/O 名额计实际受控操作，不包住整个 `task`、动态等待、审批等待或工具执行大外壳。纯 `current_time` 不拿 I/O；task 只在 child 的具体操作处拿；dynamic pending 使用 dynamicWait；等待人工审批不持工具 I/O 名额。预检中的 MCP discovery、外发 hooks 和内容物化同样计入，不能只包装最终 `tools/call`。

dynamicWait 名额必须在原执行通知/started 事实可能交给客户端前预留，再移交给 exact session/turn/call 的 pending；不能先通知客户端执行，随后才因 pending 已满拒绝登记。确定拒绝时不产生新的客户端执行邀请；结果回传走 control 通道，不要求再拿一个等待名额。回传、取消或到期实际收尾后释放，迟到结果按原身份和终态核对，不复活 pending 或自动重发。

对需要执行标记的 I/O 工具，顺序建议为：实际权限/参数与策略检查 → 必要审批 → 最终身份及取消重验 → 原子预留 I/O 容量 → 原 write-ahead `markStarted` COMMIT → 使用该唯一 permit 派发实际 I/O → body/socket/本地文件工作真实结清 → 释放 → 后续结果/observer 链。marker 之前的容量不足是确定未派发；marker COMMIT 未知后不能假称未 started、换调用身份重试或删除证据。permit 的 reservation 与实际 in-flight 分开观测，但两者均占容量。

pre-hook 的实际 I/O 必须先完成并释放，再预留工具 I/O；post-hook 在工具实际 I/O 结清后取得自己的名额。不能持一个全局 I/O permit，进入 hook、tool adapter 或 cleanup 后再等待同一池的第二个 permit。已预留的工具操作通过私有上下文向受控 adapter 移交，不从请求或工具参数接受 permit，也不在底层重复申请。

MCP 握手、分页、stateful GET/POST 和关闭各有既有有限边界；一个受控操作的子请求归属于原 permit，并受协议请求数/字节/期限约束，不由 SDK 随意派生未计工作。该口径不证明一 permit 恰好一 socket。内容物化按固定 backend namespace class 计量；SQL authority/业务 COMMIT、取消、实际 close 不递归申请工具 I/O，以免资源释放路径等不到自身名额。原组件的更严并发、网络、SSRF、mandatory approval、catalog、scope 和 deadline 全部保留。

受管 MCP 池首包采用保守的 entry 生命周期计量：在创建连接/握手前取得唯一 I/O reservation，所有权移交给精确 principal/config/origin 的 entry；其 stateful GET、在途调用及闲置保留期间均占用，直至 entry 的实际关闭、后台工作和终止请求结清后释放。`pool.use()` 返回或 busy 变为 false 不释放该 reservation。复用时借用同一 entry permit 并保持原独占 busy/refcount，不再取得或释放第二个 I/O 名额；entry 变化、到期或身份不符时须按关闭/新建链重新准入。既有 pool maxEntries/TTL 与更严组件限制继续生效；live 可在所有权已明确移交后独立结清，不能丢弃仍在途 GET 的计数。闲置条目也会消耗 I/O 容量，可能使同 user/origin 的 pre/post hook 等操作被确定拒绝，须在测量中验证可接受的拒绝和回收延迟；不能为提高通过率提前归还仍在途名额。更细的连接/单次操作分池计量不混入首包。

`concurrencySafe=false` 继续只控制同一工具批次顺序；跨 session 修改同一业务对象仍依赖目标服务的事务、版本/CAS、幂等和资源锁。本包不凭工具名称推断远端事务隔离，也不把 origin cap 变成远端 exactly-once。

<a id="fairness"></a>

## 6 占用隔离与计数资源自身的边界

tenant/user cap 的保证是某个身份不能超过其当前 runner 份额，且 submit 洪水不能吞掉 control/observe 的保留通道。`tenant < global` 阻止单租户独占，多个租户仍可能共同填满；首包不因其他租户空闲而放宽本租户上限，固定上限带来的利用率取舍须纳入测量。立即拒绝仍有先到先得、重试碰撞和饥饿可能；不宣称租户轮转、加权公平、最低服务率或等待时长保证。每个 runner 的名额独立，多个 runner 的总量不是一个共享全局额度；既有 owner 路由保持，不因容量满自动迁移已接受 turn 或绕开 exact owner。

同一进程内计数结构也必须有界：仅为已取得名额、仍在保留/结算的身份建立条目；归零且无引用时删除。高基数 tenant/user/session/origin 不能通过失败请求或持续切换 key 留下无界 Map、去重集合、TTL 任务或 metric label。计数 key 采用无歧义实际身份；对外日志/指标只给有限 lane/resource/scope/reason，不输出 raw owner、URL、路径、正文或 secret。拒绝请求不创建永久拒绝名单，也不改变原安全域需要保留的 tombstone/unknown 记录。

静态 caps 不能保证堆内存或 CPU 已有余量。最小包不引入根据 RSS/CPU 动态授予写权的控制器；进程/容器的内存、CPU、磁盘、PID/fd 上限及 OS 最终处置由部署独立配置验收，不把 OOM/强杀算作正常取消和结算。

<a id="limits"></a>

## 7 内容、输出与期限的执行位置

最终模型输入检查放在所有实际派发前的统一边界，覆盖普通 step、middleware 后的有效输入、允许的未派发 fallback 及自动/显式摘要。模型、工具声明或上下文发生变化后重新计量；新策略不能通过改写后字段绕过 operator ceiling。摘要也有自己的最终输入和响应字节检查，不能只约束主 Agent。

模型流的 text、reasoning、tool-args 全部计入 step 与执行累计输出预算；不能只限制展示文本或依赖 provider 的 `maxTokens`。新 chunk 在追加到保留字符串、数组或持久提交前核算；超限停止后续消费/准入并取消，保留已发生的派发、已接受输出与真实 usage。摘要响应、工具结果与进度同时继续原组件的更严边界，不用截断参数后执行不同操作。

字节检查须早于新增大缓冲和无界序列化：受控网络 reader 在 concat/完整解码/JSON parse 前限制累计字节；结构化声明、参数、content/details 先做闭合类型、深度、节点数及累计字节预检，再进行有界序列化与 Blob 卸载。仅在 `JSON.stringify`、`Buffer.from` 或整包 SDK 解码后测量，不能算预分配保护。SDK/adapter 若在本层拿到对象前已无界分配，必须补其真实读取边界或明确阻断该路径的本包验收，不能用较小输出展示掩盖峰值。

这些检查约束可信内置实现和受控外部输入；无法阻止恶意进程内 JavaScript 在返回结果前自行分配任意内存。脚本、任意租户插件与宿主文件执行继续属于未交付重池。

预检、I/O 和总执行期限分别取原始单调截止值；后续 await、steer、step、hook 或 fallback 不续命。到期前未派发的操作可以确定拒绝；已派发操作沿原 provider/tool 来源结算，发出 abort 不提前归还名额。不可取消 DB 读取、授权 promise 或底层 close 超过观察期限时继续占用，必要时新请求被有限拒绝，不能制造“已排空”。

<a id="errors-settlement"></a>

## 8 错误、费用与未知结果

本包容量、保留字节及新增短操作/预检/I/O/dynamic 准入期限拒绝，在尚可返回 HTTP 错误时使用现有 `quota_exceeded`（429）及闭合 details；`draining`（503）只用于真实关停、不可用或无法验证的既有条件，不把正常满额伪装成关停。既有 turn `max_steps/max_tool_calls/max_cost/max_wall_clock/max_output_tokens` 的 `completed + stopReason` 合同保持；operator 总墙钟耗尽在主 turn 接受前拒绝、接受后沿 `max_wall_clock` 结算，不改成新的 provider 失败。拟议 details 必含以下三个枚举字段，不能夹带底层异常或原始目标：

| 字段 | 拟议有限取值 |
| --- | --- |
| `scope` | `runner / tenant / user / session / execution / origin` |
| `resource` | `submit / control / observe / live_execution / io / dynamic_wait / session_pending / steer_pending / steer_total / input_context / model_output / tool_arguments / tool_result / dynamic_declaration` |
| `reason` | `concurrency_limit / pending_count_limit / pending_bytes_limit / operation_count_limit / byte_limit / deadline_exceeded` |

枚举组合按实际拒绝路径白名单校验，不返回 tenant/user ID、另一租户占用量、owner 地址、URL、路径、token、DSN、原始 SDK 错误或配置正文。请求身份无权时仍先执行原鉴权/归属语义，不用容量错误泄露资源存在。返回固定 retry 提示不代表该操作未发生，也不授权自动 POST。

必须区分三种时间点：

1. **入口容量拒绝**：在新 live、摘要及副作用前拒绝，可以明确本次没有创建新 turn 或新派发；短名额释放仍等待本次已发起的检查结清。
2. **预检中后段拒绝**：自动摘要、修复或其他合法工作可能已经真实派发/提交，之后的 I/O、字节、SSE 或其他容量不足不能把整个请求改称零调用、零费用或零写入。未接受主 turn 不等于没有摘要；保留既有摘要 usage/failed step0、收据和 unknown，不能通过新 key重做前置步骤。
3. **turn 已接受后拒绝**：不能修改已经返回的 202/SSE HTTP 状态；沿现有持久 turn/error/tool result/stopReason 合同报告。资源不足的确定工具错误须先持久为 canonical 结果再交后继模型，模型能否继续仍受原有效预算。已 started 且结果未知的动作保持 unknown，不伪装为确定未派发。

新增确定工具容量错误的拟议 canonical 形状为 `isError:true`，固定安全文本 `Local resource limit exceeded.`，以及 `details:{code:"quota_exceeded",scope,resource,reason}`；由 Host 绑定原 call item。child/dynamic 均沿此形状，不新增伪派发或成功活动。新增最终上下文/输出字节上限若使整个已接受 turn 无法继续，则记录 `failed / stopReason:error` 和本地资源 `quota_exceeded` 来源，工具参数/单结果的确定拒绝则记录相应工具错误。适配器须保留结构化本地来源，不能让当前通用 `ToolError` 丢掉 details、被转成 provider 文本，或把已派发结果未知改写成容量错误；原有 `TOOL_OUTPUT_TOO_LARGE` 等错误 oracle 不被泛化替换。错误 DTO、OpenAPI/SDK 和所有闭合消费者应同包核对，而非仅更换 message。

本包不自动重试 provider、工具、child、摘要或原 POST。客户端遇到断流、响应丢失、COMMIT 未知或已派发失败时保留原 key/turn/call 身份，仅使用已知 turn/call 和现有可用查询面只读核对；当前没有通用 GET-by-idempotency-key 或前置 operation 精确查询合同。只有 key 而缺少精确只读入口时保持 unknown，不以 POST 充当查询，不承诺一定查回；不自动换 key、session、runner 或模型。local permit 释放只是实际进程内工作结清，不是账单退款、远端撤销或业务删除证明。

<a id="rollout"></a>

## 9 最小实现与上线边界

建议按一个功能包实现：闭合配置与摘要 → 同一 runner 准入组件 → Host/child/compact/steer 的获取与移交 → 受控工具 I/O 与内容边界 → 错误/协议消费者与观测 → 定向和适用完整门禁。上述切分不允许把未覆盖的路径作为新保障对外启用；本包完成前保持“规划未实现”。

不新增业务持久调度或 owner 表，不把短名额写成另一套租约。进程重启后的新计数只描述新进程持有资源；仍需原 boot/owner、DB authority、orphan repair、未知副作用和生产停启合同，不能宣称跨重启恢复了旧执行或全 fleet 配额。旧进程未排空不因新进程计数为零而获准混跑。

启动必须校验四组完整配置、所有关系、既有 SSE/Blob/MCP/hooks/skills/Gateway 条件与支持能力；兼容不明时不监听业务入口，不自动删 key、改 quota namespace 或回落成无限。first-admin、maintenance、export/backup 及其他独立 operator 任务继续原权限与资源合同；不能借其名称给普通请求绕过本包。

拟议指标仅含有限分类：各 lane/live/io/dynamic 的 reserved/in-flight/settling 数、拒绝次数、当前保留字节、时延与取消后结算时间。指标采集本身要有界；内容、身份原文和高基数目标不进入 label。公开 capability/ready 只披露非秘密版本与策略身份，不能替代真实负载证据。

<a id="acceptance"></a>

## 10 验收矩阵

以下是待开发验收要求，当前未执行。不调用真实付费 provider；功能用 FakeVendor 和隔离真实服务验证，持续容量另按目标环境测量，不能用源文件存在或 required 登记冒充通过。

| 场景 | 必须证明 |
| --- | --- |
| G/T/U 与 origin 同步竞争 | 恰好允许配置数量；N+1 在实际派发前拒绝；任一层失败不部分扣减、不出现负数或跨主体释放 |
| 多个重预检与自动摘要 | 即使尚无 active Agent 仍受 live 限制；摘要另受 Gateway、输入/响应边界，拒绝不丢已发生 usage |
| 显式 compact、root 与 child | 三者都受 live；family 与本地限制分别生效，不能通过新 child/session 重置任一层预算 |
| 父子满池 | 父仍占 live；child 立即确定拒绝，无等待死锁、半个 child、伪成功活动或自动换 runner 派发 |
| 同 session 洪水 | 入 Promise 链前受数量/字节限制；高并发 steer 的 pending 与累计边界均准确，消费后累计不退款 |
| replay 与并发 receipt | 已完成、本地 in-progress、跨 owner 晚到 replay 不双计 live/steer；原请求异内容仍冲突，不泄露他人收据 |
| reserved/SSE 交接失败 | accepted 未 run 仍占 live；SSE 准入/订阅失败与断流按原接受事实结算，无槽泄漏或自动重 POST |
| COMMIT 响应丢失 | unknown 不重派；有已知 turn/call 时沿可用查询面核对，仅有 key 无查询入口时保留 unknown、不用 POST 充当查询；permit 释放不抹去 durable/usage/工具来源 |
| control/observe 保留通道 | submit/live/io 全满时仍可有限处理 interrupt、审批、结果回传及原状态核对；自身满额仍有界，不发生资源依赖环 |
| 审批、hook 与 I/O 顺序 | 等审批不持工具 I/O；审批后、markStarted 前预留；hook/adapter 不重复拿同一池；取消/close 不等待新名额 |
| dynamic 登记与回传 | 容量不足在客户端执行通知前拒绝；登记/通知/取消竞态无遗漏或双计；回传走控制保留通道，迟到结果不复活或自动重发 |
| MCP entry/stateful GET | use 返回及 idle 不提前还槽；entry 独立持有并复用唯一 reservation，实际关闭/后台 GET 结清才释放，原 live 已移交后可结清；TTL/身份变化/复用竞态无双计或脱管；idle 与同 user/origin hook 争额时确定拒绝、不死锁、不假释放 |
| 真实取消与迟到工作 | fetch/body/DNS、文件、不可取消授权/DB promise、child 与 observer 未结清前不释放；abort 和 drain 超时不能伪造归零 |
| 所有模型路径 | 普通无 middleware、middleware 改写、允许的未派发 fallback、自动/显式摘要全部通过最终输入、输出和 operator ceilings 检查 |
| 输出预分配边界 | 分片 text/reasoning/tool args、压缩响应、深层 JSON、超长字符串、content/details、Blob 卸载在新增大分配前拒绝；记录 SDK/driver 已先分配部分的真实边界 |
| 高基数与持续增长 | 切换 tenant/user/session/origin、长时间拒绝及反复取消不遗留无界 Map/Promise/timer/label；原安全 tombstone/unknown 不被错误清理 |
| 混合版本与配置 | 缺组、零值、坏关系、溢出、未知字段、热改和混合摘要均拒绝；不能只核健康子集或降级无限 |
| 邻租户与长等待 | 大量工具/审批等待仍受 live；一个身份达到上限时其他身份能使用剩余配置额度；不以该结果宣称无饥饿 |
| 完整回归 | authority/幂等/审批/子任务/账务/Blob/SSE/drain 原合同保持；相关真实 MySQL、Redis、HTTP/慢 socket、实际 bundle 与适用完整门禁按仓库规则执行 |

容量验收须同时记录实际并发峰值、保留字节/资源增长、延迟、拒绝分类、实际派发数、取消后结算及唯一账务；不把请求到达、排队、Agent 对象存在或配置 cap 当成已完成的吞吐证据。

<a id="open-decisions"></a>

## 11 开发前仍须确认的事项

四组配置的实际容量数值、目标机器资源、测量负载和保留通道大小待隔离测量；解析器固定边界、各数值实现上界及前述字段关系须在 L0 冻结。首包采用显式有限配置，不以本文推断生产容量。新增错误 details、dynamic/child canonical 形状和所有闭合消费者兼容按§8提案做实现前协议审查。现有自动摘要在主 turn 接受前已派发的核对能力有边界；本包必须如实保留 unknown，不能借容量改造宣称已实现独立的前置 operation/创建幂等合同。

跨 runner 份额、按租户轮转的有界等待队列、机器异构配额、RSS/CPU 自适应背压、真实 OS 沙箱和跨 turn 总预算不进入最小包。只有实际需求与测量证明需要时再设计，不用这些后续候选推迟本包的有限准入、真实结算和内容边界。
