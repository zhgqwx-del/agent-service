# 可观测性、安全遥测与生命周期边界

当前规范（2026-10-25）：安全structured logging、W3C内部trace、受保护L0 metrics、默认关闭的durable writer及0053 persisted-provider failure capture均已实现，纳入 `61c3a58 / CI40211433064 attempt1` 的具名本地/CI范围。完整OTel/collector/dashboard/SLO/告警、telemetry产品处置与真实环境仍未完成。精确事实见 [PROGRESS](../PROGRESS.md)。

旧0032～0036逐迁移说明与当时候选/未实现快照已归档至[历史全文](../history/2026-10-25/docs/design/05-observability.md)。本页保留字段、凭据、写入与恢复安全契约；不把历史中的“无activation CLI”覆盖后来0053的受控本地CLI，也不把capture恢复当作telemetry删除恢复已完成。

## 1. 目的与分层

日志/trace会将owner、正文或凭据复制到业务库外，必须分别约束采集、持久来源、处置与恢复。当前分为：

| 层次 | 已实现范围 | 限制 |
| --- | --- | --- |
| 入口安全 | 闭合event/字段、固定错误、进程内opaque ref、fresh内部trace、first-admin文件通道 | 不证明第三方SDK/Node绕过helper的输出已全部审计 |
| L0 metrics | 受独立bearer保护的HTTP/进程与有限provider治理/I/O聚合 | 进程内、重启清零，非账本/owner inventory/完整观测平台 |
| 0032/0033 inventory与0034 writer | 原子activation/coverage、payload-before-sink、reservation/ACK、FS/S3-compatible target | 默认休眠；managed云IAM/故障域未验，无产品delete/retention authority |
| 0035 v1与0053 v2 capture | v1 producer binding；v2真实provider失败business/source/spool原子提交 | v1不得实际激活充完整coverage；v2仅受控本地logs，traces inactive |
| 0036～0044处置前置证据 | 非生产外部协议、membership/owner/source/目录/pre-grant | 0037真实grant硬拒；产品外部删除/restore/retention未完成 |
| 0054～0058来源保留与capture恢复 | 有限retained-source、checkpoint/history/cutover及selected continuation | 0054仍原primary-only；不证明sink删除、backup erasure或完整P2 |

全域completion=false，外部删除/自动清理off、旧receipt不重签/unknown不提升保持。默认off不能掩盖普通路径、启动/迁移的正确性缺陷。

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
- OTel/collector、dashboard、SLO、alert、sampling、容量或成本治理已实现；下述有限L0进程指标不等于完整metrics平台。

### 受保护的 L0 runtime metrics

router与runner在各自现有端口提供默认关闭的`GET`/`HEAD /metrics`，由各自进程就地终止，router不把scrape代理到runner。`METRICS_ENABLED=0`时该路径返回`404`；开启前必须单独配置`METRICS_BEARER_TOKEN`。token限32～256位ASCII字母、数字及`._~-`，不得与业务、internal、admin等高权限token相同。只有精确的`Authorization: Bearer <token>`（scheme不区分大小写、其后单个ASCII空格、token大小写敏感）可读取；不能用query或`X-Internal`授权。开启后缺失/错误凭据返回`401`，已授权的非`GET`/`HEAD`返回`405`；scrape响应禁止缓存。预置token但不开指标时，非metrics路径仍会拒绝该受保护凭据被当作业务凭据使用或转发。这个宽deny-only检查不授予scrape权限，也不改变原有业务鉴权。

原HTTP/进程Prometheus文本仅含固定`component`、`method`、`route`、`status_class`标签：16个闭合route类、8个标准method加`other`、5个HTTP status class加`other`，每role最多864个completed组合和144个in-progress组合。没有tenant/user/session/provider/model、原URL/path/query、trace、error、header、secret或任意调用方标签。`agent_service_http_requests_total`记录header-ready时完成请求数，`agent_service_http_handlers_in_progress`只计响应头尚未就绪的handler；`agent_service_http_response_headers_duration_seconds`是固定桶直方图，测到响应头就绪，不是SSE流寿命、active turn或provider耗时。进程量只有uptime、RSS和heap gauge，以及`agent_service_process_cpu_user_seconds_total`、`agent_service_process_cpu_system_seconds_total`累计counter。全部只在进程内存中，重启清零；没有新SQL、outbox、durable inventory、daemon、入口或镜像。

这是M4的有限本地观测能力，不授权M1的0037 grant、外部对象删除、自动清理或任何默认关闭的生命周期gate。staging/production仍需另行设计受控网络/TLS、独立采集鉴权、规模和容量；Gateway另有固定scope/outcome/reason的有限配额与provider I/O指标，合同及验证边界见[Provider Gateway](09-provider-gateway.md#l0-运行观测已定向未全包验收)。已有基础Prometheus/告警部署样例和配置解析范围，实际采集/告警送达、OTel/exporter/collector、dashboard、SLO及完整turn级指标仍未验收或未实现。

## 3. 入口事件目录

入口catalog示例见下表；完整闭合code/field以[telemetry协议](../../packages/protocol/src/telemetry.ts)为准，新增事件不得绕过同一validator。

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
   trace context中不得夹带tenant/user身份或凭据；业务鉴权头仍按独立HTTP协议转发。
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

## 8. 受管遥测写入、来源与处置

### 8.1 Inventory与activation

0032安装默认generation0 control、固定logs/traces target、per-tenant coverage和T1-bound subject；0033补原子activation receipt与immutable artifact inventory。activation须exact protected raw32 ref key、固定双target、完整canonical tenant集合一次提交。既有tenant保持legacy_history_unknown，新tenant与complete_since_creation coverage同一原子边界创建；不能从migration成功推导历史coverage。

inventory只保存content-free target/artifact/owner ref、policy/hold/restore/source high-water、manifest/payload摘要，不保存正文/URL/header/secret/locator。exact replay、跨tenant/key/source/owner漂移及startup缺receipt/coverage均严格拒绝，getter不自动补来源。DDL/guard/marker由strict startup verify核对。

### 8.2 Durable writer不变量

live admission在任何clone/serialization之前，逐条验证原始record由真实createStructuredTelemetry生成并冻结，producer key匹配active lifecycle key。每条含exact tenant ref，user/session再含exact owner ref，不得夹其它owner；literal、clone、格式相同字符串不证明来源。单次capture后只用detached标量/payload，避免getter/Proxy替换。

每batch 1～100 records、canonical UTF-8 JSON≤262144 bytes。job/payload/membership在Memory单一发布/MySQL事务中原子入spool，sink之前必须durable。持久化后按closed schema/hash完整性验证，不伪称进程WeakMap provenance跨重启存续。

worker按adapterProtocol过滤claim；首次create前write-once reservation重验T1、owner、policy/hold/restore/source与claim。reservation后只可原exact operation/target/payload/adapter收口，不因T1后到再创造新操作。先inspect，absent才create；一次attempt调用create后的任何不确定都续租并exact inspect，不同identity冲突阻断，不能二次create补救。terminal ACK与inventory、written job和payload删除同原子边界；COMMIT丢响应仅读exact ACK/原reservation重放。

active subject gap、旧writer/marker-loss、缺membership或关系损坏startup fail closed。历史active0033缺subject只允许受保护ref key及三个精确停写ACK的DDL-free reconcile连接模式，持migration lock/全量原子校验；ACK是人工声明，无通用CLI或自动启动修复。

### 8.3 Target与真实环境

filesystem仅本地单runner/private root，无跨进程OS lock；人工ACK不证明真实独占，production拒绝。deterministic staging在ACK前cleanup/fsync，正常job replay可恢复；没有全目录startup sweeper，DB/job丢失仍可能有staging orphan。

S3-compatible使用telemetry-s3-object-v1和ASTELM01 closed envelope：content-free key、identity/长度/hash、If-None-Match create-only、有界read-after-write。冲突/versioned响应拒绝，不覆盖。startup核versioning从未开、无lifecycle/Object Lock、conditional PUT/陈旧冲突语义；生产custom endpoint须HTTPS和独立private-bucket ACK，秘密不入identity/日志。

startup probe仅在 `_agent_service_probe/` 随机前缀允许DeleteObject，不能扩artifact权限；响应丢失/deadline可能留下content-free probe orphan，当前无sweeper。HTTP adapter只有受限create/inspect client协议与双向target绑定，不是已交付managed sink server。Memory/FS/同机MinIO只证明对应协议，不证明云IAM/KMS/故障域/容量。

### 8.4 应用capture：v1与v2

0035把target lifecycle与per-domain producer cutover分开。旧tenant/pre-cutover job保持unknown/unbound，post-cutover job先写exact producer binding再job，失败全回滚。v1唯一producer为provider.upstream_request_failed logs；helper不使任意业务DB事务与spool自动crash-atomic，v1不实际激活并宣称完整coverage，traces必须inactive。

0053 v2接入真实Pi provider失败首个business commit：failed item/event、usage/billing、source/member/spool/job/failure receipt在同一Memory原子发布/MySQL显式RR事务；turn终结仍是另一次commit。runtime/tool/store失败只unknown，旧NULL/gen0与v1不能升级。trusted record与owner/producer key仍在clone前验证。

runner/router的PERSISTED_PROVIDER_FAILURE_CAPTURE_ENABLED与PERSISTED_PROVIDER_FAILURE_CAPTURE_FLEET_ENABLED均默认0、production拒绝。每capture/claim/reserve/create/ACK单独fresh全configured-fleet proof；v1队列在LIMIT前排除v2，gate失败不消耗v2 lease或阻断v1。普通tombstone source可核历史，但reserve/create另验live owner/T1/policy/hold；已有reservation只可exact ACK收口。sealed-source usage保留，释放只能经0054精确桥，见[生命周期](04-data-lifecycle.md)。

现有telemetry-capture one-shot只提供status/preflight/activate-lifecycle/activate-logs/verify-source五前台命令，非daemon。activation须真实0030 primary、exact ref key、canonical coverage与fleet/旧writer排空ACK；CLI存在不等于已对日常环境启用，traces/v1保持inactive。

### 8.5 处置前置证据与规划executor

0036～0037 disposition账本、CAS tombstone/journal与grant-v2/v3观察器仅显式非生产fixture/只读观察；0037真实DB grant仍无条件拒绝。0038新write membership、0039 T3f owner closure、0040 source-accounting、0041观察manifest、0042逐artifact plan目录、0043本地候选和0044 pre-grant intent/claim分别约束来源；历史缺证据unknown，新plan有非零目标也仍blocked_adapter_unconfigured、executionReady=false。

未来产品executor仍须真实source-valid grant、同key永久marker物理验真、fresh external head、0030/0031恢复run绑定、旧快照replay/startup gate、physical ACK与完整MySQL/S3端到端。S3 LIST不是head，DeleteObject成功或fixture hash不能作为可恢复删除证明。目标scope、claim/lease、policy/hold、DB time、owner/source、partial ACK与response-loss必须精确绑定，dead-letter不算完成。

### 8.6 Erasure与新域

T3d固定33域的logs/traces不得省略。0054只给原primary、creation-complete新tenant、T1前全written/ACK且Blob/export全域精确零的v2来源提供usage/canonical本地桥，sink对象不删；新epoch不获该删除资格。generic user/session purge仍未接线，tenant ACK不代替user proof。

跨owner batch不能扩大删除范围；backend无法局部处置就保持blocker，不能默认为整个batch删除。所有telemetry receipt只证明其版本/scope，全域completion=false；新registry/hook/task域若旧计划未覆盖继续阻断。

### 8.7 Capture恢复与sink恢复分开

0055～0058 checkpoint、只读history、显式新epoch cutover与旧pending recovery已实现具名本地/CI范围。五selected continuation持续持认证GCM、exact run/target/operator锁、独立ACK及完整catalog/journal/fresh head；old receipt/source/reservation不重签，operator不获ordinary capture权限。

该链只补capture来源保留/恢复，不证明外部sink已删除或sink backup不复活数据。logs/traces处置的永久marker与独立恢复authority仍未闭环；0030/0031 T1来源/epoch也不自动证明所有遥测副本。旧schema原生制品跨迁移续跑和production selected guard保持，详见[生命周期§14～16](04-data-lifecycle.md#14-00550056-active-capture-恢复的本地实现边界未发布)。

### 8.8 升级/启用

迁移不自动激活、回填或配置sink。先关相关gate、摘流并结清全部旧writer/事务，独立迁移/metadata/strict verify，仅新binary启动、forward-fix；不删marker或热混跑。v2启用必须另验精确ref key、target、producer、完整fleet与来源；现有default-off/production拒绝不放宽。active历史缺口按既有窄reconcile合同，不设通用skip-audit。

## 9. 实现与验收定位

| 领域 | 代码/具名验收入口 | 证明范围 |
| --- | --- | --- |
| 字段与trace | [telemetry](../../packages/protocol/src/telemetry.ts)、[W3C context](../../packages/protocol/src/telemetry.ts) | closed schema/provenance与内部context；不覆盖任意依赖输出 |
| L0 metrics | [runtime metrics](../../packages/protocol/src/runtime-metrics.ts)、[Gateway metrics](../../packages/protocol/src/provider-gateway.ts) | 本地有限聚合与鉴权，不是账本/SLO |
| writer/adapter | [worker](../../packages/core/src/lifecycle/tenant-telemetry-writer-worker.ts)、[store](../../packages/store/src/tenant-telemetry-writer.ts)、[S3](../../packages/store/src/tenant-telemetry-adapter/s3.ts) | Memory/SQL/真实MinIO及失败/replay范围，非云验收 |
| provider v2 | [producer](../../packages/core/src/telemetry/persisted-provider-failure-capture.ts)、[store](../../packages/store/src/tenant-telemetry-persisted-provider-capture.ts)、[CLI](../../apps/agent-runner/src/telemetry-capture-cli.ts) | 真实failed-step原子来源、startup与受控本地activation |
| lifecycle/restore | [生命周期](04-data-lifecycle.md)、[PROGRESS](../PROGRESS.md) | 具名原生报告与最终CI；不把测试登记当执行 |

61c的具名本地/CI范围已接受；原分段、旧失败、skip与non-production fixture仍按原身份保存。本次仅文档规范化，没有重跑产品测试或生成新binary证明。

## 10. Staging/Production边界

真实环境仍须验证sink/collector、IAM/KMS、private endpoint、retention/hold、全部索引/副本/backup、response-loss、容量/成本、采集与告警送达。namespace、credential、encryption key和owner inventory不得跨环境混用；所有endpoint/bucket/domain/TLS/Secret来自实际资源，不在文档猜造。

通用Linux包的Prometheus/告警样例和原生配置解析已有具名CI范围；systemd stub解析不等于真实托管，配置可读不等于实际采集/告警送达。目标生产C仍待资源，不能把本地MinIO、正常Redis cold或临时CI签名当云/断电/生产信任证明。

## 11. M1与M4

M1完整生命周期仍缺可执行处置、真实授权/ACK、独立restore proof与completion聚合；M4完整可观测性仍缺统一完整tracing/metrics、collector/dashboard/SLO/alert、sampling、容量/成本与目标环境演练。字段安全或局部durable proof不等于完整观测，dashboard/trace可见也不替代删除证据。
