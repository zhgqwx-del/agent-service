# 可观测性、安全遥测与生命周期边界

> 状态：入口安全基线、default-dormant 的 `0032` schema，以及 `0033` Memory/MySQL 原子
> activation receipt、per-tenant coverage 与 immutable artifact inventory store 已实现；真实 sink
> adapter、应用 writer 双写、删除 worker/ACK、restore replay 与 completion 仍待后续切片。
> 本文定义 M1 数据生命周期需要的最小安全契约，以及 M4 完整可观测性平台的边界。

## 1. 目的

agent-service 的日志和追踪同时承担故障定位、发布核对与安全审计职责，但它们也可能把
tenant、user、session、provider、URL、请求正文或密钥复制到应用数据库以外的系统。若没有
owner inventory、retention、legal hold 与删除 ACK，日志/追踪就会成为 tenant/user erasure 的
永久 blocker。

本文将问题拆成三层：

1. **入口安全基线**：router/runner 进程启动、关闭、bootstrap 和顶层失败只能向
   stdout/stderr 写固定 JSON event code 与低敏布尔/计数字段；admin bootstrap secret 必须走
   create-only 文件通道。
2. **`0032`/`0033` lifecycle inventory**：`0032`安装 generation-0 control、固定 logs/traces target、
   per-tenant coverage 与 T1-bound subject evidence；`0033`补齐原子 activation receipt、既有/新 tenant
   coverage 及 immutable artifact inventory store。两条 migration 都不激活、不回填、不联网、不删除。
3. **后续 execution lifecycle**：把应用 writer 接到 inventory，提供真实 sink adapter、删除或匿名化
   operation、ACK、restore replay 与 terminal receipt。该层完成前，T3d 的 `logs` 和 `traces` 仍必须
   保持显式 blocker，全域 completion 仍为 `false`。

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
进程内 HMAC 生成的 `oref_*`。它不接收任意字段名、原始 tenant/session/provider 字符串或 `Error`。
main wrapper 进一步只允许 `runnerCount`、`shutdownGraceMs` 与 gate开/关计数，不能把 tenant ID、runner
URL、provider ID、locator、异常 message/stack 或 secret 交给 process log。

当前已覆盖：

- runner 的 development bootstrap、first-admin bootstrap、started、draining 与顶层 start failure；
- router 的 started、draining 与顶层 start failure；
- runner 启动摘要只保留 gate开/关数量；
- router 启动摘要只保留 runner 数量及 gate开/关数量；
- 顶层异常只写固定失败 event，不写 error message、stack、cause 或环境变量。
- router request 与 runner request建立严格 W3C v00 trace context；任意 `tracestate`/`baggage` 被丢弃；
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
`provider.upstream_request_failed`。这些事件只能使用 allowlisted opaque ref/error/count字段。

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
opaque ref。随机 trace/span ID可作为短期 correlation token输出，但不能携带主体信息、充当 owner ref、
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

1. 外部入口只继承语法有效、非全零的 W3C version `00` `traceparent`；两位小写十六进制
   `trace-flags` 的全部bit逐跳保留（不能只接受`00`/`01`或清除未知bit），无效或未来版本丢弃并生成新
   context。
2. `tracestate` 与 `baggage` 当前全部删除，不记录原 header，也不向下游发送。
3. router 向 runner 转发本服务生成的 child `traceparent`，不能透传任意外部 context、tenant/user header
   或凭据。
4. runner 向 provider发送本服务生成的 child `traceparent`，并再次删除 `tracestate`/`baggage`；不得把
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

## 8. `0032`/`0033` inventory 与后续 lifecycle execution

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
erasure/completion。`0033`虽提供显式store API，长期router/runner仍未把它接成启动gate或sink writer；
因此标准应用装配继续保持 generation `0`。

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

当前应用logger/exporter尚未调用这个store contract，也没有真实sink adapter；所以还不能声称所有durable
writer已双写。未登记的legacy数据、未知sink、source drift、跨owner batch或无法重建的locator仍必须形成
blocker，不能用空集合解释成“没有日志”。

### 8.3 Adapter contract

adapter 至少需要固定语义：

- 读取/验证 target identity 与能力；
- 按 exact artifact/batch identity 执行 delete、crypto-shred 或经政策批准的 irreversible anonymize；
- operation ID、expected generation、evidence digest 与 adapter result精确绑定；
- response loss 后只允许 exact replay/read-after-write；
- partial target success保留 durable ACK，未 ACK target继续重试；
- provider返回模糊成功、分页漂移、额外 artifact或 identity不匹配时 fail closed；
- dead-letter不等于物理完成。

本地 fake/filesystem adapter只能证明协议、rollback、并发和 replay，不能成为 production completion proof。

### 8.4 Tenant 与 user erasure 集成

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

### 8.5 Restore 与 backup

恢复后必须从独立故障域重放已 durable ACK 的永久 purge marker，防止旧日志索引、spool、export queue或
trace batch复活。尚未 ACK 的首次外部 mutation不能从旧快照猜造。0030/0031 的 journal/catalog只提供
数据库恢复来源与 epoch authority，不自动证明日志平台、追踪平台或它们的 backup 已删除某 tenant/user。

### 8.6 rollout gate

建议沿用现有安全切片模式：

1. 应用`0032`/`0033` expand-only migration，tracking/execution默认关闭；
2. 未来发布真正双写inventory且声明对应capability的router/runner，所有gate保持`0`；
3. 排空旧writer，核对全部configured fleet与精确32-byte protected ref key identity；
4. 由受控one-shot operator调用现有原子activation store，确认receipt/coverage及全fleet startup audit；
5. 开启writer tracking，再开启runner worker并验证真实adapter namespace identity；
6. 最后开启router destructive gate；
7. 首个activation/inventory/ACK/cutover提交后只能forward-fix。

现有长期应用没有步骤2、5、6所需的gate/adapter装配，因此生产环境不得仅凭store API存在就执行步骤4。

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

`0032/0033` content-free入口/证据helper为**6/6**；`0033` Memory原子activation/coverage/inventory为**9/9**，真实MySQL
事务回滚、并发、启动审计与隔离为**9/9**；`0032 -> 0033`历史迁移夹具为**6/6**。CI与本地verify均以
命名required suite和no-skip断言证明这些套件实际执行。后续仍需应用writer双写、真实本地adapter、
delete/ACK worker、lease loss、legal-hold destructive竞态、response-loss mutation replay与restore测试。

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
