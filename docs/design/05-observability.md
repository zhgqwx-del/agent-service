# 可观测性、安全遥测与生命周期边界

> 状态：`0034` durable writer已接runner并提供默认关闭的filesystem或S3-compatible writer；`0035`把0033 lifecycle
> target activation与per-domain application producer capture分离。当前只支持
> `provider.upstream_request_failed` logs exact contract，traces必须inactive。filesystem仅限本地单runner，
> 无OS lock且人工ACK不是证明，production禁用；`telemetry-s3-object-v1`已经闭合共享对象写入协议，
> `0036`已安装默认休眠的disposition账本与非生产same-key CAS tombstone/CAS-head journal协议夹具；产品处置仍默认拒绝。
> 真实DB授权、旧快照replay/startup gate、managed环境验收、delete/restore/retention executor、activation/operator CLI与完整coverage仍未实现。
> 本文定义 M1 数据生命周期需要的最小安全契约，以及 M4 完整可观测性平台的边界。

## 1. 目的

agent-service 的日志和追踪同时承担故障定位、发布核对与安全审计职责，但它们也可能把
tenant、user、session、provider、URL、请求正文或密钥复制到应用数据库以外的系统。若没有
owner inventory、retention、legal hold 与删除 ACK，日志/追踪就会成为 tenant/user erasure 的
永久 blocker。

本文将问题拆成四层：

1. **入口安全基线**：router/runner 进程启动、关闭、bootstrap 和顶层失败只能向
   stdout/stderr 写固定 JSON event code 与低敏布尔/计数字段；admin bootstrap secret 必须走
   create-only 文件通道。
2. **`0032`/`0033` lifecycle inventory**：`0032`安装 generation-0 control、固定 logs/traces target、
   per-tenant coverage 与 T1-bound subject evidence；`0033`补齐原子 activation receipt、既有/新 tenant
   coverage 及 immutable artifact inventory store。两条 migration 都不激活、不回填、不联网、不删除。
3. **`0034` durable writer substrate**：live admission先确认record来自可信structured logger，闭合schema与
   hash再保护持久化后的读取；有界batch先进Memory/MySQL spool，
   再由按`adapterProtocol`过滤的worker处理logs/traces可合法分布在不同adapter的混合配置。首次
   external create前先write-once保留external-mutation-start，原子重验T1、user/session、policy/
   hold/restore/source；之后只允许exact operation replay，terminal ACK必须绑定该reservation。
4. **`0035` application capture**：以domain独立control/receipt/coverage/binding冻结producer cutover；
   pre-cutover保持unknown/unbound，post-cutover只接受exact producer。当前只接provider failure logs。
5. **S3-compatible writer target**：`telemetry-s3-object-v1`用create-only对象、闭合checksum envelope、
   有界read-after-write和startup bucket capability preflight提供managed-capable写入目标；它不授予删除、
   retention、restore或completion authority。
6. **`0036`与后续 execution lifecycle**：`0036`只安装default-dormant disposition control、future-only
   grant/job/event/ACK/receipt/replay-fence账本及非生产外部协议夹具，不发行source-valid grant、不执行删除或恢复。
   后续仍须闭合DB授权、物理marker验真、最新external head与0030/0031 restore绑定、旧快照replay/startup gate
   及跨MySQL/S3端到端测试。完成前T3d的`logs`和`traces`仍为显式blocker，全域completion固定`false`。

本文不把日志系统等同于监控系统，也不因本机输出了 JSON 就宣称 M4 可观测性已经完成。

## 2. 当前实现范围

当前 router/runner 的 main 入口使用 `agent-service.telemetry.v1` envelope：

```json
{
  "schema": "agent-service.telemetry.v1",
  "timestampMs": 1791590400000,
  "level": "info",
  "component": "runner",
  "code": "runner.lifecycle.started",
  "fields": {
    "gateEnabledCount": 4,
    "gateDisabledCount": 18
  }
}
```

当前 router/runner main 与应用层共同复用 `@agent-service/protocol` 的 structured telemetry。logger只接受
闭合 event-code 与字段 allowlist：受限计数、HTTP status、attempt/retryable、固定 `errorKind`，以及由
同一logger实例的`opaqueRef()`实际生成并登记的进程内 HMAC `oref_*`；仅伪造相同字符串格式会被emit拒绝。
它不接收任意字段名、原始 tenant/session/provider 字符串或 `Error`。
main wrapper 进一步只允许 `runnerCount`、`shutdownGraceMs` 与 gate开/关计数，不能把 tenant ID、runner
URL、provider ID、locator、异常 message/stack 或 secret 交给 process log。

当前已覆盖：

- runner 的 development bootstrap、first-admin bootstrap、started、draining 与顶层 start failure；
- router 的 started、draining 与顶层 start failure；
- runner 启动摘要只保留 gate开/关数量；
- router 启动摘要只保留 runner 数量及 gate开/关数量；
- 顶层异常只写固定失败 event，不写 error message、stack、cause 或环境变量。
- 公网router为每个request生成fresh internal W3C v00 root，不继承caller的trace/span ID；runner内部入口只
  继续严格的router context；任意 `tracestate`/`baggage` 被丢弃；
- router→runner 与 runner→provider只发送本服务生成的 `traceparent`；
- router/runner/provider应用错误使用固定 code、固定 `errorKind` 与 HMAC opaque ref。
- product runner给仍接受`Console`形状logger的SessionHost和内嵌worker统一注入content-free兼容层；
  该层丢弃全部动态参数，只发`runner.runtime.info/warning/error`，旧式session/error文本不能进入默认日志。
- SessionHost在lease、fence或lifecycle竞争中先完成fenced/closing、abort与pending approval失败等安全记账，
  再发送无字段`runner.runtime.ownership_lost`；同一active turn最多发送一次。product logger会吞掉telemetry
  sink异常，因此观测失败不会逃逸、延迟或撤销失权处理。

当前没有宣称：

- 所有第三方provider SDK、Node runtime或依赖库绕过应用logger的输出都已经迁移；
- stdout/stderr 已经是可删除的受管日志后端；
- trace context 已覆盖所有后台 worker、SSE resume/link、消息总线或持久任务恢复；
- stdout/trace exporter 已接入 durable inventory，或 retention/legal hold 已形成可执行处置策略；
- 任意应用event都已双写到durable spool；当前只有一个provider failure logs contract；
- log/trace 物理删除、ACK 或 restore replay 已实现；
- dashboard、metrics、SLO、alert、sampling、容量或成本治理已实现。

## 3. 入口事件目录

### 3.1 Runner

| event | level | 允许的动态字段 |
| --- | --- | --- |
| `runner.bootstrap.dev_key_skipped` | warn | 无 |
| `runner.bootstrap.dev_key_seeded` | warn | 无 |
| `runner.bootstrap.admin_key_inactive` | warn | 无 |
| `runner.bootstrap.admin_key_present` | info | 无 |
| `runner.bootstrap.admin_key_output_rejected` | error | 无 |
| `runner.bootstrap.admin_key_store_failed` | error | 无 |
| `runner.bootstrap.admin_key_written` | info | 无 |
| `runner.lifecycle.draining` | info | 无 |
| `runner.lifecycle.started` | info | `gateEnabledCount`、`gateDisabledCount` |
| `runner.process.start_failed` | error | 无 |
| `runner.runtime.info` | info | 无；旧core logger动态参数全部丢弃 |
| `runner.runtime.warning` | warn | 无；旧core logger动态参数全部丢弃 |
| `runner.runtime.error` | error | 无；旧core logger动态参数全部丢弃 |
| `runner.runtime.ownership_lost` | warn | 无；lease/fence/lifecycle竞争导致当前runner停止旧owner执行 |

### 3.2 Router

| event | level | 允许的动态字段 |
| --- | --- | --- |
| `router.lifecycle.draining` | info | `shutdownGraceMs` |
| `router.lifecycle.started` | info | `runnerCount`、`gateEnabledCount`、`gateDisabledCount` |
| `router.process.start_failed` | error | 无 |

应用层当前还包含 `router.unhandled_error`、`router.tenant_erasure_target_unreachable`、
`router.upstream_unreachable`、`router.owner_unconfigured`、`router.owner_reroute`、`runner.unhandled_error` 与
`provider.upstream_request_failed`。这些事件只能使用 allowlisted error/count字段和由该logger实例生成的
opaque ref；格式匹配本身不是ref来源证明。

event code 是机器稳定接口。改变含义应新增 code，不能复用旧 code 表示另一种状态。日志采集规则
必须以 `schema + component + code` 建索引，不能解析人类文本。

## 4. 字段分级

### L0：低敏运行状态

允许进入当前 process log：

- 固定 schema、component、level、code；
- Unix millisecond emission timestamp；
- gate开/关数量、runner 数量、重试次数和受限 HTTP status；
- 固定协议/能力版本（未来如需加入，必须来自闭合枚举）。

即使属于 L0，也不能把完整环境、配置对象或 capability document 直接 stringify。

### L1：owner/correlation 数据

包括 tenant/user/session/turn/request/operation ID、runner identity、对象 key、provider slot以及可与业务
主体关联的 hash。原值当前禁止进入 stdout/stderr；应用只能输出进程内随机 HMAC key产生的固定格式
opaque ref。公网router使用的随机 trace/span ID必须是信任边界内新生成的值；内部随机ID可作为短期
correlation token输出，但不能携带主体信息、充当 owner ref、
授权或 durable operation identity。未来进入受管 lifecycle adapter 时还必须满足：

- 有精确 owner envelope；
- raw 与 keyed pseudonym 的选择已固定且可轮换；
- retention、legal hold 与 erasure target 可由 durable inventory 找到；
- 查询权限和审计独立于业务 API；
- 删除后不能通过另一个未登记索引继续反查主体。

“已经 hash”不自动等于匿名数据。稳定、可关联或带低熵输入的 hash 仍按 L1 管理。

### L2：业务内容与外部 locator

包括 prompt、response、tool input/output、SSE data、HTTP body、用户文本、文件名、完整 URL、对象存储
locator、provider response、SQL、Redis key、User-Agent 与 IP。默认禁止日志/追踪采集。确需诊断时必须
另建显式授权、短 TTL、owner inventory 和删除协议；不能通过提高 log level 绕过。

### L3：秘密与认证材料

包括 API key、admin/service key、Authorization/Cookie、内部 router token、BYOK ciphertext/plaintext、
KMS/provider credential、数据库 DSN、Redis/S3 credential、Secret/KMS 配置与 download lease raw token。
L3 在所有日志、trace attribute、exception event、metric label、receipt 与 lifecycle ledger 中永久禁止。
仅记录“已配置/未配置”这一类 L0 boolean。

### L4：控制证据

包括 content-free evidence digest、catalog/restore roots、namespace digest、purge ACK 与 cutover generation。
这些值不含正文，但会暴露系统拓扑和控制状态。默认只进入 durable control store；若未来进入受管遥测，
必须按最小权限、固定字段和有限保留期管理，不能进入公开错误响应。

## 5. 错误与异常策略

入口层遵循“固定 code、无依赖错误正文”原则：

- 不输出 `error.message`、`error.stack`、`error.cause` 或整对象；
- 不输出 URL、host、runner list、tenant/provider 名称或配置值；
- 不用异常类型名作为无限基数字段；
- 失败以退出码、固定 event code、health/readiness 和 durable operation 状态联合诊断；
- 需要详细调试时，使用受限的本地 debugger/test artifact，不把临时 debug dump带入默认镜像行为。

未来 logger 可维护受审计的闭合 `reasonCode` 枚举，但不能把捕获的字符串错误映射成字段。第三方 SDK
或 Node warning 若可能写 L1/L2/L3，必须通过 SDK 配置关闭、包装或在 staging 前替换；应用 helper 无法
自动净化依赖库绕过它自行写入的内容。

## 6. First-admin secret 的一次性输出通道

`ADMIN_BOOTSTRAP_TENANT` 不再把生成的 key 写到 stdout/stderr。配置契约为：

- 同时设置 `ADMIN_BOOTSTRAP_OUTPUT_FILE`；缺失时 fail closed；
- 路径必须是绝对路径；
- output file 不能脱离 `ADMIN_BOOTSTRAP_TENANT` 单独出现；
- `BOOTSTRAP_API_KEY` 与 `ADMIN_BOOTSTRAP_TENANT` 互斥；
- router 拒绝接收 `ADMIN_BOOTSTRAP_OUTPUT_FILE`，它属于 runner-only secret authority。

首次确实需要 key 时，runner：

1. 先确认 tenant active 且不存在未撤销的 admin key；
2. 生成 key；
3. 以 `O_CREAT | O_EXCL` 等价的 `wx` 模式和 `0600` 权限创建文件；
4. 再次 `chmod(0600)`，写入单行 key、`fsync`并关闭文件，再`fsync`父目录使新目录项持久化；
5. 将 key hash 写入 store；
6. 只输出 `runner.bootstrap.admin_key_written`，不输出 tenant、path 或 key。

文件绝不覆盖，目录也不会由进程自动创建。路径应位于仅部署 operator 与该进程可访问的预创建目录
或一次性 Secret volume 中。创建/写入/同步/关闭任一步失败都只返回固定错误；已有文件会直接拒绝。

文件先于数据库写入是有意选择：数据库提交成功但 key 未能持久输出会制造不可恢复的有效 secret。
若文件写入后数据库操作失败或响应不明确，文件会保留，runner 会 fail closed；operator 必须核对数据库
是否已有对应 admin key，再决定恢复流程，不能由应用自动删除或覆盖这份唯一证据。

当前 create-only 文件只是**单个共享文件系统**上的并发互斥，不是跨 VM/容器的分布式 singleton。
生产 rollout 必须只让一个受控 one-shot 实例配置 first-admin bootstrap。长期应迁移到独立 CLI/Job 加
数据库 singleton claim；不能在所有常驻 runner 上同时配置不同本地 output path。

推荐操作顺序：

1. 停止其它 first-admin operator，准备 owner-only 目录；
2. 只在一个受控实例注入 tenant 与绝对 output path；
3. 启动并等待 `admin_key_written` 或固定失败 code；
4. 由 operator 读取文件，将 key导入真正的 Secret manager；
5. 验证新 admin key 后撤掉两个 bootstrap 环境变量并重启；
6. 按组织安全策略安全移除一次性文件。应用不会替 operator 自动擦除。

本地 `BOOTSTRAP_API_KEY` 语义保持不变，并继续在 production 被拒绝；其事件不再包含 tenant 原值或
key。它仍是开发便利入口，不是生产 secret distribution 机制。

## 7. Trace propagation 契约

当前已实现：

1. 公网router把caller `traceparent`视为不可信correlation输入：即使语法有效也不继承其trace/span ID，
   而是为每个request创建fresh internal root，初始`trace-flags=00`。这样外部可控的合法十六进制ID不会
   进入router structured record或router→runner header。
2. `tracestate` 与 `baggage` 当前全部删除，不记录原 header，也不向下游发送。
3. router 向 runner 转发该fresh root下由本服务生成的 child `traceparent`，不能透传任意外部 context、
   tenant/user header或凭据。
4. runner是内部服务；其入口只接受严格、非全零的W3C version `00` context，并为内部child保留两位小写
   十六进制`trace-flags`的全部bit。runner向provider发送本服务生成的child，并再次删除
   `tracestate`/`baggage`；不得把
   tenant/user ID 注入第三方 context。
5. context使用 `AsyncLocalStorage` 限定在当前异步 request链；structured telemetry可附带当前随机
   trace/span ID，但错误仍只能使用固定 code和 `errorKind`。

后续 lifecycle execution / M4 仍需完成：

6. SSE reconnect、turn resume 与队列 worker 使用 span link 连接旧 context；durable operation identity 仍由
   store 协议定义，不能用 trace ID 充当 idempotency key、claim token 或授权证明。
7. span name 使用固定低基数模板；tenant、session、URL path parameter、model/provider ID 不进入 span name。
8. attribute 继续使用闭合 schema；异常 event不记录 message/stack；HTTP header/body、prompt/tool data永久
   禁止。
9. sampling 决策不能因为某 tenant/user ID而形成未登记的旁路索引。生命周期、安全控制操作可强制采样，
   但仍只能采集安全字段。
10. exporter 失败不能阻塞普通 runtime，也不能让 destructive lifecycle action在缺 ACK 时伪装成功；安全
    审计/erasure proof使用独立 durable ledger，不以“trace 已发送”代替。

## 8. `0032`～`0035` inventory/writer/capture 与后续 lifecycle execution

### 8.1 `0032` 已实现的 default-dormant substrate

`0032_tenant_telemetry_lifecycle.sql` 已安装四类严格 schema：

- `tenant_telemetry_lifecycle_control`：write-once singleton，默认 generation `0`且所有activation字段
  为 NULL；schema允许的唯一前进是 `0 -> 1`；
- `tenant_telemetry_lifecycle_targets`：activation时必须恰好绑定 ordinal `0` logs与ordinal `1` traces
  两个content-free target identity；
- `tenant_telemetry_lifecycle_coverages`：按 tenant记录`legacy_history_unknown`或
  `complete_since_creation`、subject ref、target root与DB-time coverage起点；
- `tenant_telemetry_lifecycle_subjects`：把tenant erasure request/generation、T1 fence、coverage evidence、
  subject ref与固定target root绑定；insert guard还会精确join admission、T1 fence、coverage和已经激活的
  control，并核对owner/generation/evidence/root及DB-time high-water，拒绝跨tenant或拼接证据。

迁移包含engine/collation/column/index/CHECK/FK fingerprint和append-only/write-once triggers，并已通过
真实 MySQL smoke验证 control、targets、coverages、subjects的约束行为。它明确不会：配置 sink、生成
subject ref、扫描/回填历史、激活 writer、materialize purge job、调用网络、删除日志/追踪或推进任何
erasure/completion。`0034` worker已经接入长期runner，但默认关闭；0033 lifecycle control与0035
application capture也继续默认inactive，三者必须分别判断，不能把adapter可用解释为activation完成。

已有 tenant不会因migration自动获得 coverage；只有显式调用`0033` activation store时，才会把当时全部
canonical tenant记为`legacy_history_unknown`。不能把migration成功或legacy coverage解释成“历史日志完整
可枚举”。T3d 当前继续输出 logs/traces blocker是正确行为。

### 8.2 `0033` 已实现的原子 activation 与 durable inventory

`0033_tenant_telemetry_activation_inventory.sql`新增write-once activation receipt和immutable artifact
inventory。Memory/MySQL store在同一Memory publication或`SERIALIZABLE` InnoDB事务中写入固定
`logs`/`traces`双target、当时全部canonical tenant的`legacy_history_unknown` coverage、activation receipt，
再推进control `0 -> 1`；activation绑定调用方持有的精确32-byte protected ref key及其key-id digest。失败、
并发loser、序列化异常、SQL rollback或响应丢失不会留下部分target/coverage/receipt/control，只允许exact
replay。

激活后，首次创建tenant的writer必须把tenant lifecycle和`complete_since_creation` coverage放在同一
原子边界；已存在durable footprint却没有lifecycle、缺coverage、receipt丢失或key漂移均fail closed，公开
coverage getter不会“顺手修复”缺口。MySQL启动会在一致性快照中重建activation request、target root、
coverage root与source closure，并校验六张表的精确schema/trigger fingerprint。

store contract允许tracking激活后为每个可持久化log/trace artifact或不可分割batch登记：

- sink namespace/target 的 content-free identity；
- artifact/batch immutable identity 与 generation；
- owner kind及受保护 owner reference；
- created-at DB time、retention class、最迟处置时间；
- writer/source generation 与 schema version；
- payload/manifest digest，但不保存正文、URL、header、credential 或明文 locator；
- legal-hold/retention policy binding；
- restore lineage 与 source high-water。

artifact注册会重新核对active control、activation receipt、target、tenant coverage、owner/tenant隔离、
retention/hold/restore binding及source high-water；同一external identity只允许exact replay。owner已gated/
deleted后不得登记新artifact，但响应丢失后的exact replay仍可读取原receipt。inventory不保存正文、URL、
header、credential或明文locator。

当前只有`provider.upstream_request_failed` logs通过0035 exact producer contract调用writer；S3-compatible
adapter已可作为共享对象writer target，但尚未在真实managed环境中验证，也不能声称所有应用event已双写。
未登记的legacy数据、未知sink、source drift、跨owner batch或无法重建的locator仍必须形成
blocker，不能用空集合解释成“没有日志”。

### 8.3 `0034` 已实现的 durable writer substrate

`0034_tenant_telemetry_durable_writer.sql`安装default-empty的writer job、短期payload、
external-mutation-start reservation和immutable write ACK投影。migration本身不激活`0032` control、
不从stdout或历史表回填payload、不创建job/reservation、不联网、不配置或请求sink，也不授予
delete/restore/completion authority。MySQL启动对`0033` activation/inventory与`0034` writer的全部
schema、index、CHECK、FK和trigger guard做组合指纹核对；不完整queued payload、无reservation的外部已开始状态、
ACK/reservation/inventory关系损坏或marker-loss时的不一致投影都fail closed，不会被启动审计补造。

0034同时在`tenant_credential_revocation_jobs`增加`BEFORE INSERT` mixed-writer fence。current writer在active
telemetry generation中先写精确subject再写T1 job；stale 0033 writer会在job边界失败并回滚整个T1事务，
因此schema安装后不能继续扩大subject gap。若升级前active 0033已经存在gap，普通startup故意fail closed。
guard轮换使用scoped bootstrap twin；仓库迁移器只对固定bootstrap执行exact verify-or-create，随后才
drop/recreate primary并移除bootstrap。已有bootstrap若shape/body漂移会fail closed；即使进程在drop primary后
崩溃，重放期间也始终至少保留一道guard。未来独立migration Job必须复用这一执行语义。
operator必须先关闭tenant-erasure admission、排空pre-0034 writer并停止全部应用writer，然后以active control
所用的精确32-byte ref key和三个固定字面量ACK——`tenant-erasure-admission-closed-v1`、
`pre-0034-telemetry-writers-drained-v1`、`all-application-writers-stopped-v1`——调用DDL-free
`migrationMode: "reconcile-telemetry-subjects"`。该模式复用migration named lock，以SERIALIZABLE全量校验
source/coverage/subject/writer projection后一次性补齐，任一异常全回滚，exact replay安全。三个ACK只是人工
停写声明，不是自动证明；当前它只是store连接模式，没有产品CLI、bundle或`local-service`命令。

live enqueue先对caller input做单次capture：顶层字段、payload字段、records引用、数组长度及每个slot都只
读取一次，并在任何`structuredClone`或serialization前用protocol模块私有的producer标记逐条确认同一批
原始record是`createStructuredTelemetry`实际生成且冻结的对象；进程内`WeakMap`同时保存该record的producer
key-id，并要求它匹配active lifecycle ref key。每条record必须携带exact tenant ref，user/session owner还必须
同时携带exact owner ref；任一其它tenant/user/session ref都会在持久化前拒绝。该logger emit又要求所有ref都
由同一实例的`opaqueRef()`生成过。后续只使用复制的标量和该批record产生的detached canonical payload，不再
读取或clone caller对象，因此stateful getter/Proxy不能在check与use之间换入语法合法literal。跨进程持久化后，
进程内provenance标记本来就不会存在，read/claim/adapter改用闭合`agent-service.telemetry.v1` validator与payload/hash
绑定做完整性校验；validator只证明schema，不声称证明producer来源。event/component/level/field必须属于
allowlist，trace/span必须成对且符合严格W3C ID，额外JSON key仍被拒绝。artifact每批限制1～100条，
canonical UTF-8 JSON不超过262144 bytes。live admission还要求每条record携带精确artifact owner ref，且
其它ref字段不能出现不同的tenant/user/session lifecycle ref；跨owner batch必须在进入spool前拒绝，不能
依靠后续单一owner inventory掩盖。Memory/MySQL在同一原子边界重验active control、target、
coverage、owner/source/high-water，然后同时
写job与payload。这是“payload before sink”不变量：adapter只能从已claim的durable payload取得输入，
不能在spool提交前发生外部create。

worker/store的执行边界是：

1. claim按`adapterProtocol`过滤，因此`logs`/`traces`可合法绑定不同adapter，一个worker不会误领其它协议的job；
2. 每次首次external `create`前，store以write-once reservation绑定operation、target、artifact generation、
   payload/manifest、claim及adapter protocol，并在同一Memory原子发布或MySQL事务内重验tenant T1、
   user/session lifecycle、canonical policy/hold、restore lineage与source high-water；
3. reservation一旦提交，不论T1、hold或restore状态随后变化，都只能按同一exact operation继续inspect/
   create/complete，不得换payload、target、adapter或operation；这个特例用来收口“外部可能已commit”的不可判定窗口，
   不是T1后新增写入授权；
4. adapter先`inspect`；absent时只发一次`create`。`createWrite`一旦被调用，任何异常——包括畸形、超限或
   target-unbound的2xx响应——都先续租并做exact `inspect`，remote exact时收口，absent时才按原异常
   retry/block，同一attempt不二次create。remote slot不一致时将job固定为`integrity_conflict`，临时故障则有界退避重试；
5. terminal complete必须绑定write-once reservation和live/exact claim，并在同一原子边界发布0033 immutable
   inventory、0034 ACK、`written` job，再删除短期payload。DB commit响应丢失时先读immutable ACK，
   只允许原claim+reservation的exact completion replay。

Memory adapter需显式`nonProductionFixture: true`且production下拒绝构造，它只证明protocol与response-loss语义。
HTTP adapter只接受HTTPS（非production可显式放行loopback HTTP），拒绝redirect、embedded credential、query/
fragment、超界或非JSON响应，并以整个请求deadline和有界response body收口；响应`Content-Type`去除参数后
必须精确等于`application/json`，允许charset参数但拒绝`application/jsonp`。构造时必须显式提供
`expectedTargets` allowlist；wire request与response必须双向绑定`targetSha256 + targetReceiptSha256`，不能因为
共用endpoint就把一个target的ACK当成另一个target的证据。这只是endpoint/target配置绑定。它实现的是
`agent-service.telemetry-http-sink.v1` client协议，不是真实sink server、collector或managed backend验收。

S3-compatible adapter实现`telemetry-s3-object-v1`：object key只由已校验的content-free
tenant/target/artifact identity导出，payload使用`ASTELM01`闭合envelope绑定metadata与payload长度及各自SHA-256。
发布使用`If-None-Match: *`；超时或模糊响应后执行有界read-after-write，只有完整identity、payload与receipt
精确匹配才收口，冲突对象与versioned response均fail closed。读取在stream阶段也受字节上限与request deadline
约束，不能用`Content-Length`缺失或伪造绕过。

adapter startup会验证bucket可达、versioning从未启用、lifecycle配置不存在、Object Lock关闭，以及
create-only conditional PUT和陈旧冲突语义。target identity绑定bucket、prefix、受控region、规范化custom
endpoint或`standard-endpoint`模式、addressing mode、namespace与failure-domain；credential、header和明文secret
不进入identity、日志或错误。production custom endpoint必须为credential-free HTTPS origin，并要求operator在独立
验证private access/IAM后设置private-bucket ACK；ACK本身不是自动证明。产品writer路径仍只有create/inspect；
`0036`虽增加非生产same-key CAS tombstone协议夹具，但没有可启用的delete、retention或restore接口。

startup conditional-PUT探针会在`<prefix>/_agent_service_probe/`下创建随机无正文身份对象并随后删除，
所以writer principal的`DeleteObject`只能授权到这个probe子前缀，不能扩展到artifact key；未来真正执行处置的凭据
必须另行最小化。首次PUT响应丢失或整个共享deadline耗尽仍可能留下content-free probe orphan，当前没有自动sweeper，
需要监控并以该受限前缀的operator流程清理；这不等于telemetry artifact delete能力。

### 8.4 `0035` 已实现的 per-domain application capture

`0035_tenant_telemetry_application_capture.sql`新增logs/traces独立的application control、activation receipt、
tenant coverage与post-cutover write binding。它把“0033 target/owner lifecycle已激活”与“某domain的应用producer
已经无遗漏切换”拆成两个事实：既有tenant标记`capture_since_cutover/pre_cutover_history_unknown`，既有job
冻结在pre-cutover unbound root中；旧job只允许原无producer输入exact replay，不能事后重标。新tenant必须在
canonical subject、0033 lifecycle coverage和0035 application coverage同一事务创建；active domain的新job必须
先写exact binding再写job，binding/job/payload任一失败全回滚。startup重建coverage/pre-cutover/binding root，
缺行、跨tenant、producer/target漂移均fail closed。

当前唯一产品producer是`provider.upstream_request_failed`的logs事件。它在capture active时只进入durable
writer，不再复制到stdout；capture inactive时，owner-scoped helper会剥离全部owner/subject/target refs，
router/provider其它fallback也使用相同的无主体引用边界。traces没有实现producer contract，必须保持inactive。
runner可显式开启0034 worker，并选择本地filesystem或S3-compatible adapter。filesystem只允许单runner私有
目录，没有OS级跨进程锁；single-runner/private-root ACK是人工声明，不是环境证明，production配置会拒绝。
S3使用独立`TENANT_TELEMETRY_S3_*`配置，适用于共享writer target，但production仍须完成真实bucket/IAM/TLS/
容量验收。deterministic filesystem operation staging
会在exact ACK前清理并fsync，正常durable job replay可恢复；但当前没有全目录startup sweeper，DB/job投影
非原子丢失时仍可能留下staging，这继续属于restore/delete生命周期边界。仓库没有0035 activation/operator CLI、
telemetry delete/CAS tombstone、external deletion journal或restore/retention executor。`captureTenantTelemetryApplicationRecord`一类helper只保护它包围的
enqueue调用，不能让任意业务数据库事务与spool跨store crash-atomic；因此目前不得实际activation后宣称完整
application coverage或擦除闭环。

### 8.5 Adapter contract

adapter 至少需要固定语义：

- 读取/验证 target identity 与能力；
- 按 exact artifact/batch identity 执行 delete、crypto-shred 或经政策批准的 irreversible anonymize；
- operation ID、expected generation、evidence digest 与 adapter result精确绑定；
- response loss 后只允许 exact replay/read-after-write；
- partial target success保留 durable ACK，未 ACK target继续重试；
- provider返回模糊成功、分页漂移、额外 artifact或 identity不匹配时 fail closed；
- dead-letter不等于物理完成。

本地 fake/filesystem adapter与同机MinIO只能证明协议、rollback、并发和 replay，不能成为production
completion或独立故障域proof。`0036`已安装expand-only、default-dormant disposition账本，并在显式非生产fixture
验证same-key `If-Match` CAS tombstone、content-free create-only event chain与CAS authority head；产品处置和
store mirror/fence仍默认拒绝。下一步必须先将source-valid DB grant、外部terminal marker与最新head验真、
0030/0031恢复绑定及旧快照replay/startup gate做成端到端authority，不能用S3 LIST猜测head，也不能把
DeleteObject成功或非生产fixture结果当成可恢复删除证明。

### 8.6 Tenant 与 user erasure 集成

- T3d 固定 33 域中的 `logs`、`traces` 不得删除或省略；adapter未配置时继续
  `blocked_adapter_unconfigured`。
- tenant executor 从 terminal T3c/T3d source materialize精确 targets，并在每个 destructive boundary
  重验 DB time、canonical hold、owner/source、claim lease 与 fresh fleet capability。
- generic user/session purge使用同一 inventory/adapter，但 target scope必须精确缩小到该 subject；不能
  复用 tenant-wide ACK 冒充 user proof，也不能误删同 batch 中其它 owner。
- 跨 owner batch若 backend不支持安全局部处置，只能阻断、等待 batch 重写/retention expiry或使用已审计的
  crypto-shred设计；不能静默扩大删除范围。
- terminal receipt只证明 logs/traces域，仍固定 `allDomainsComplete=false`、
  `contentPurgeExecuted=false`，直到 backup、provider/KMS、其它外部域与最终聚合全部闭合。

### 8.7 Restore 与 backup

恢复后必须从独立故障域重放已 durable ACK 的永久 purge marker，防止旧日志索引、spool、export queue或
trace batch复活。尚未 ACK 的首次外部 mutation不能从旧快照猜造。0030/0031 的 journal/catalog只提供
数据库恢复来源与 epoch authority，不自动证明日志平台、追踪平台或它们的 backup 已删除某 tenant/user。

### 8.8 rollout gate

建议沿用现有安全切片模式：

1. 应用`0032`～`0036` expand-only migration，lifecycle/application capture/writer和0036 execution ledger
   全部保持默认关闭；
2. 若0033已active，先按0034既有停写/reconcile契约处理历史subject gap；inactive或无gap历史无需该特殊模式；
3. 部署全部0035-aware router/runner并排空旧writer，核对精确ref key、target、producer contract与全fleet startup audit；
4. 只对已证明无遗漏且与业务事务边界相容的domain，由受控one-shot operator激活application capture；
5. 再按adapter protocol开启runner writer worker、验证真实managed adapter namespace与故障域；0036的非生产
   same-key CAS tombstone/CAS-head journal协议不能授权destructive gate，必须先补source-valid grant、旧快照恢复
   replay及完整执行链，才考虑delete/restore/retention executor；
6. 首个activation/binding/ACK/cutover提交后只能forward-fix。

当前没有activation/operator CLI和完整业务事务crash-atomic capture；唯一producer只覆盖一个provider failure
logs事件，traces明确不支持。S3 writer可证明managed-capable对象写入协议；0036处置只有默认拒绝的非生产协议夹具，
没有产品execution lifecycle。
因此production不得执行步骤4，本地filesystem或MinIO都不能作为rollout/删除证明。

## 9. 本地与 CI 验收

入口安全基线至少验证：

- event 是可解析 JSON，schema/component/level/code固定；
- runner URL/list、bind address、tenant ID、provider ID、API key、output path与异常正文不出现在日志；
- local `BOOTSTRAP_API_KEY` 仍创建原有 bootstrap credential，但日志只出现固定 code；
- admin output path缺失、相对路径、孤立配置或与 dev bootstrap并用时 fail closed；
- output file 为 `0600`、create-only、不会覆盖已有文件，两个同路径并发writer只有一个成功；
- 生成 key仅存在于该文件和 store hash，不进入 stdout/stderr；
- router拒绝 runner-only output path；
- runner/router started与draining只输出安全计数/布尔值。

`0034`定向门禁分为：`pnpm test:tenant-telemetry-writer`验证payload、Memory/HTTP/filesystem/S3 unit adapter、
worker、配置与Memory store；其中S3 unit故障注入覆盖bounded stream、整次操作deadline、response-loss、
corruption及preflight负例。`pnpm test:tenant-telemetry-writer-mysql`验证真实InnoDB
spool/claim/reservation/ACK/T1收口；`pnpm test:tenant-telemetry-writer-s3`使用两个独立client和真实MinIO验证
create-only、闭合envelope、cross-client可见性、冲突不覆盖、positive startup preflight及anonymous GET拒绝；
`pnpm test:migrations`中的`0033 -> 0034`夹具验证历史升级、active gap拒绝、专用reconcile全回滚/exact
replay，以及current/stale/in-flight writer并发与metadata-lock语义。CI与本地verify已接线这些required
suite，要求目标文件实际pass且零skip/non-passed。`verify-s3`使用与Blob、restore journal、backup catalog都不同
的第四个telemetry bucket运行真实adapter；同一命令的源码应用smoke只证明Blob S3装配及0034/0035 dormant
schema，不会激活或构造telemetry S3 writer。这个布局只证明协议和配置隔离，不证明云IAM/KMS
或独立故障域。易变的完整数量以`docs/PROGRESS.md`最后一节和对应CI run为准。0036另有独立protocol/Memory/
真实MySQL与第五个MinIO bucket的required suite、固定`0035→0036`真实历史升级夹具，但这些只验证默认休眠账本和
非生产外部协议；后续仍需真实DB授权、delete/restore执行与旧快照replay、legal-hold destructive竞态、
全域completion与managed环境测试。

`0035`另由`pnpm test:tenant-telemetry-application-capture`和
`pnpm test:tenant-telemetry-application-capture-mysql`独立门禁。真实MySQL套件覆盖分域activation、并发
exact replay/conflict、activation与tenant/enqueue线性化、Unicode tenant ID二进制隔离、pre-cutover
unbound exact replay、post-cutover binding、事务回滚和startup drift。`pnpm test:migrations`中的
`0034 -> 0035`夹具证明历史ledger保持、default dormancy、legacy语义、partial-DDL/marker-loss收敛和严格
fingerprint；GitHub Actions单独执行Memory与MySQL capture suite，并验证dist/runner image包含0035 marker。
这些测试只证明默认关闭的协议与writer实现，不证明实际activation、managed环境或删除/恢复能力。

## 10. Staging / Production 边界

本地 JSON、filesystem fake、MySQL、Redis和同机 MinIO不能证明：

- managed log/trace backend 的删除、索引副本、cache、WORM、retention、backup与restore行为；
- collector/sidecar/node agent没有在应用 helper之外复制 L1/L2/L3；
- 云 IAM、KMS、encryption key、private endpoint和跨账号/region故障域正确；
- exporter重试、队列积压、容量、成本、sampling、SLO、告警和灾难恢复满足生产要求；
- vendor deletion receipt等价于所有副本已物理清除；
- 本地 adapter ACK 可以推进全域 completion。

有真实环境后必须分别验证 staging 与 production 的 sink、collector、IAM/KMS、retention、legal hold、
delete API、backup/restore、response-loss、限流和审计导出。两套环境不得共享 namespace、credential、
encryption key或 owner inventory。任何 endpoint、bucket、index、project、KMS key、domain/TLS 与 Secret值
都必须来自实际资源，不能在仓库中猜造。

## 11. M1 与 M4 的切分

M1 为数据生命周期闭环需要完成的是：安全字段契约、owner inventory、adapter target/ACK、retention/
legal-hold重验、restore replay、tenant/user erasure proof以及保持 fail-closed 的 completion聚合。

M4 才完成完整生产可观测性：统一 logger/tracer、OTel SDK/exporter、metrics、dashboard、SLO、alert、
sampling、quota/rate-limit信号、collector拓扑、容量/成本、registry promotion、Kubernetes配置和真实环境
演练。M1 的 lifecycle proof不能被描述为完整 observability；M4 的 dashboard/trace可见性也不能替代
M1 的 durable deletion authority。
