# 本地开发、手动体验与 CI 构建指南

> 离线VM签名候选（2026-10-15，未发布验收）：私钥格式正则触发的secret-scanner边界误报已等价改写、未加白名单，scan696通过；其后最终相关9文件于07:28:39Z实际889 passed、零fail/skip（7个VM文件770、proof工具119），API/typecheck通过。代码提交d671632的darwin/arm64/Node24 clean双包于07:35:46.954Z实际通过，仅ephemeral-test-only签名、productionAccepted=false；最终文档提交的整树和新Linux CI仍待。required新增3文件至123、62个旧group不变，VM group现为7文件。原817 CI test失败/两个image成功；b575集中全量实际3164 passed/5 failed、后置未跑，不能称新全量或CI全绿。详细事实只看PROGRESS末节。

> 历史本地集成验收（2026-10-15，非上述签名候选验收）：M4目录/受限tar与0054在干净代码提交e278ead通过完整verify；主2897、真实历史47文件282零skip、cluster28与独立T3g3、SDK/六JS入口及VM335/实际clean双tar均通过。该本地证明限macOS arm64/Node24，不替代main对应Linux CI或生产验收；发布/CI实际状态以main及对应Actions run为准。0054只给同primary、新完整tenant、T1前全written/ACK、全部Blob/export计划域零的v2来源建立保留式本地删除桥；legacy/mixed/未知来源和新epoch恢复仍拒绝。0037 hard-deny、外部对象删除/自动清理关闭、四false与M1未冻结/M2冻结/M3未开始不变。较早版本表保留历史边界，完整结果看PROGRESS顶部及末节。

本文是理解和操作当前 `agent-service` 的长期维护入口，回答三类问题：本地需要启动什么、怎样手动体验、GitHub Actions 实际构建和验证什么。

快速入口：想马上看到系统运行，依次看[一次性准备](#2-一次性准备)、[启动与停止](#3-启动与停止完整本地栈)、[手动体验 API](#5-手动体验-agent-runtime)；想理解交付物，看[本地进程与构建产物](#7-本地源码进程与生产构建产物)、[GitHub Actions](#8-github-actions-构建与验证)和[环境晋级语义](#9-从本地到未来生产的交付语义)。既有CI构建并测试两个Linux OCI镜像；本地新增VM目录/受限tar/独立工具及离线签名候选，未取得本批新Linux CI验收。仍不推送registry，也没有生产签名信任根/密钥管理、OCI签名、SBOM、digest晋级或完整部署清单；离线签名不是生产许可。

里程碑完成度以 `docs/PROGRESS.md` 顶部快照和最后一节为准；本文只描述操作方式和交付产物，不替代进度记录。

`0053`阶段的原始合同是默认关闭、local-only的 persisted provider-step failure capture v2，不是完整telemetry生命周期或M3。原始provider stream失败的source、failed item/event/usage/billing、capture binding/receipt及0034 spool/membership在同一失败step业务COMMIT内提交；后续turn-terminal仍是原第二次COMMIT。runner `PERSISTED_PROVIDER_FAILURE_CAPTURE_ENABLED` 和router `PERSISTED_PROVIDER_FAILURE_CAPTURE_FLEET_ENABLED`均默认`0`，production拒绝开启；只有受控CLI核对真实0030 active primary epoch/lineage、exact0033 key/target和configured-fleet root后才能激活v2 logs，0035 v1/traces保持inactive。T3d/T3f第六来源仍全局硬拒、tenant erasure被阻断，grant、外部处置/恢复和所有completion没有开放；sealed source usage不能由0052自动删除，旧NULL/0来源保持unknown。 0054仅对顶部所述完整新来源提供本地保留桥，不放开其它来源或新epoch。

本地完整验证由`verify`加`verify-s3`组成：前者执行独立真实MySQL与真正旧0052 binary升级门禁，后者执行实际HTTP/SSE/socket故障→PiEngine/SessionHost→MySQL→0034worker→MinIO bytes/ACK，以及active0033 exact-key备份兼容。是否全部通过、实际用例数与CI链接仍只看PROGRESS及当次JSON，不把接线或历史结果当作本轮通过。构建现为六个JavaScript入口（runner五、router一），但长期服务和OCI镜像仍各两个。

先明确“本地完成”和“整个架构实现”的区别：本地能够完整启动、通过测试并不等于 M1～M4 已全部完成，更不等于生产环境已经验收。当前 M0 完成、M2 本地/CI 范围冻结；M1未冻结，M3/M4主体未开始。`0034`默认关闭的writer已接runner，可选本地单runner filesystem或S3-compatible target；`0035`只有`provider.upstream_request_failed` logs exact producer contract，traces必须inactive。`0036`新增默认休眠的disposition迁移/原子control与S3 CAS-head journal、同keyCAS marker非生产协议夹具；`0037`轮换grant claim-hash hard-deny trigger并增加非生产grant-bound v2 Memory事件夹具；`0038`只为新受管write原子保存不可变逐项membership/source sidecar，旧write缺失为unknown；`0039`给新T3f补同事务、content-free的逐write owner-closure entry与零write也存在的aggregate receipt，旧terminal缺receipt保持unknown；`0040`～`0042`在新T3d plan同事务封存五类telemetry来源、逐source观察目标及精确逐artifact目录，legacy、未完成、孤立来源保持unknown；`0043`只补T3e复核和T3f后只读本地候选，`0044`新增默认休眠的逐artifact、版本化pre-grant intent/claim，固定`grantReady=false`；第五个同机MinIO bucket仍只证明0036协议。新T3d logs/traces可有非零目录target，但仍是不可执行blocker；没有telemetry disposition activation/worker/CLI、真实DB grant签发、产品v2 S3 mutation/ACK、marker验真、旧快照replay/startup gate或跨MySQL/S3端到端验证，外部处置默认拒绝。没有云资源仍可继续代码/协议/本地CI工作，但不能把本地MinIO当作云IAM/KMS、私有访问、独立故障域或生产容量证明。

`0041`在上述`0040`来源账本之上，给新T3d同事务封存逐artifact观察目标集合和只读source-readiness。它精确覆盖每条0040 source；旧terminal、legacy/未完成/孤立source不补造，观察目标不是可执行target，readiness始终`executionReady=false`。完整T3d logs/traces仍是零执行target blocker，0037 grant与产品外部mutation继续硬拒。冻结0040旧二进制已在真实MySQL生成terminal后升级到0041，证明旧receipt保留且缺0041证据仍为unknown；该夹具没有非空telemetry artifact，不授予执行权。

`0042`只给新T3d plan增加逐artifact content-free target catalog和logs/traces精确count/root，与0040/0041及terminal同一原子边界封存；零target也有独立receipt。旧0041 terminal保留原零target plan，缺catalog为unknown，不从观察目标反推执行target。新plan即使非零也仍`blocked_adapter_unconfigured`，`executionReady=false`；grant和产品mutation/restore未开放。冻结0041旧二进制已有非空managed logs ACK terminal→0042真实升级夹具；若精确零target新plan遭特权删除0042 receipt，本地剩余证据仍无法与真正旧terminal区分，故须保持最小权限、schema drift/marker监测及完整旧writer排空。0042不新增服务、入口或镜像；本指南以下本地启动/手动体验仍适用。

`0043`是无schema migration的代码级只读来源诊断与T3e正确性修复。T3e对0042新plan的非零logs/traces target按锁定五源、真实canonical owner、0040～0042证据和原plan count/root实时重算；MySQL暂态1205/1213保持可重试，不再永久误记为integrity conflict。T3f后诊断只有在0039 closure/grave、0040～0042目录及当前T1/hold/control/DB时钟/restore状态闭合时返回`local_source_candidate`和content-free managed artifact count；其它情况为`unknown`，且始终`executionReady=false`、`externalAuthorityVerified=false`。它不能作为grant、外部marker/head、物理ACK或全域完成证明；旧0042代码已写成blocked的非空T3e job不会自动解封。冻结0042旧二进制的真实MySQL代码兼容夹具已证明这个旧阻断与零target T3f只读结果；0043不增加服务、入口或镜像，普通本地体验仍按下文进行。

`0044`安装两张默认休眠的append-only pre-grant intent/claim表：只对新0042目录中的精确artifact group，在Memory单一原子发布/MySQL事务内绑定0040～0042、0039 closure、T3f terminal/grave及当前T1/hold/control/DB时间/restore gate。intent版本不可变；claim仅保存token的domain-separated hash、单调attempt和有界DB-time租约，INSERT后过期或时钟回退会整事务回滚。prepare/get/claim重新验证本地source，跨tenant和legacy/缺catalog不得借此取得候选。两个记录均固定`grantReady=false`，不接触外部journal/marker，不签发0037 grant，也不改变T3d `blocked_adapter_unconfigured`。迁移只建账本/guard、严格126-trigger指纹，未回填历史或隐式执行；它不新增产品服务、worker、JavaScript入口或OCI镜像，普通本地体验步骤不变。

`0045`/`0046`/`0048`分别提供默认未接入产品路径的GET-only v2 grant-journal、artifact data/tombstone、v3 journal观察器；观察结果都不能证明可信DB grant、physical ACK或restore fence。`0047`是独立v3 source/claim/restore-bound事件链及S3 CAS-head**显式非生产夹具**，不是产品删除/恢复入口。`0049`为persisted provider-step failure capture v2安装三张默认休眠表、13个SQL hard-deny guards与严格139-trigger指纹；logs预置唯一producer，traces无producer，control仍inactive/generation 0，coverage/binding及v2写入仍拒绝。未来source session/turn/item只能写tenant-bound、kind-separated keyed HMAC ref，不存原始ID；旧五源T3d/T3f遇异常v2 footprint会fail closed。`0050`仅为新普通session DELETE建立来源与post-COMMIT DB-time 30天保留floor；旧/erasure/legacy来源为unknown。后续runner内嵌的未seal来源恢复caller默认关闭，显式开启才只扫描、重验并补seal，不排期或执行物理purge；`purge_after_ms=NULL`、`session.purge`不可领取。新provider失败对外只返回固定`provider_error`/`Provider request failed.`，历史错误未清除。上述切片不新增长期服务、JS入口或OCI镜像，普通手动体验仍按本指南进行；完整验证以[进度记录](../PROGRESS.md)最后一节为准。

`0051`再单独安装MySQL `BEFORE UPDATE` write-once trigger：已有0050 origin只能随首次live→tombstone写入，非NULL后digest/DB时间、BINARY owner身份、删除generation/time和lastSeq不可改；seal须在旧行版本已有origin时写入，写成后时间/floor/digest不可改。0051后相关启动指纹集合为140（不是全库trigger总数），0049自身仍是139-trigger历史指纹；精确trigger已安装而marker丢失可create-only恢复，动作漂移fail closed。它不证明0050两次COMMIT或来源真实、不强制旧普通DELETE writer双写，T3f仍可删除session行；无origin继续unknown，物理purge仍关闭。

0034对active 0033历史有一个特殊、默认拒绝的升级分支：credential-job数据库guard会让仍在运行的0033 writer整笔T1事务回滚，阻止继续产生“有admission、无telemetry subject”；升级前已经存在的gap则让普通startup fail closed。guard轮换使用scoped bootstrap twin，仓库迁移器只对固定bootstrap执行exact verify-or-create，再drop/recreate primary并移除bootstrap；因此独立migration Job必须复用仓库迁移器语义，不能用朴素SQL splitter制造无guard窗口。当前只有`MysqlSessionStore.connect()`的DDL-free `migrationMode: "reconcile-telemetry-subjects"`可处理历史gap，没有产品CLI或`local-service`命令。使用前必须真实关闭tenant-erasure admission、排空pre-0034 writer并停止全部应用writer，持有active control的精确32-byte ref key，并提供三个固定ACK：`tenant-erasure-admission-closed-v1`、`pre-0034-telemetry-writers-drained-v1`、`all-application-writers-stopped-v1`。这些ACK只是人工声明；修复使用migration named lock和SERIALIZABLE全量原子事务，任一异常全回滚。不要把这段说明改写成可在在线业务库直接执行的普通启动步骤。

没有云资源时仍可以继续实现并验证：业务与协议代码、Memory/MySQL/Redis 语义、迁移、故障注入、进程和 OCI 镜像、local/CI 自动化、部署契约，以及能够用本地替身证明的安全边界。以下工作不能被本地MinIO等测试替身冒充为“已完成”：云数据库和云 Redis 的权限/故障行为、managed对象存储与IAM/KMS、域名/TLS、Secret 注入、Kubernetes 或 VM 网络拓扑、真实滚动升级、告警链路、备份恢复与容量压测。它们需要后续真实资源，届时应把环境参数补进部署层，而不是现在编造参数。

手动体验应该分两次进行，而不是二选一：

1. 现在按本文做阶段体验，确认已经实现的 router/runner、公开 API、SSE、持久化和运维手感，尽早发现交互问题；
2. local/CI 范围的整体架构完成后，再做一次完整 walkthrough、真实模型验收和发布演练，作为进入 staging 前的系统验收。

建议先读架构与可观测性文档，再启动普通router/runner主链路。telemetry writer/capture默认关闭，普通`start`不会激活sink。日常学习优先运行第6节named测试；0053现有受控`telemetry-capture` CLI，但只可用于可丢弃库、实际停服排空、真实0030 primary与受保护key前提下的v2 logs，不要手改0033/0035/0049 control。

## 1. 服务、基础设施与代码库

`0052`是仅限本地、默认关闭的ordinary session operational usage retention。只移除已核对的operational ledger并保留匿名billing facts、reconciliation和session内容，不等于完整删除；0053绑定failed-step的source usage仍不可清理。普通`start`无需开启；手动学习应运行四个named套件：`pnpm test:session-usage-retention-memory`、`pnpm test:session-usage-retention-mysql`、`pnpm test:session-usage-retention-worker`、`pnpm test:session-usage-retention-worker-mysql`，真实MySQLURL必须指向可丢弃测试库。worker已内嵌runner，不新增服务、JavaScript入口或镜像；production拒绝启用。BYOK删除也已确认只处理本系统副本，厂商侧撤销由客户负责；现有external blocker不能据此伪造远端撤销成功。

本项目当前只有两个应用服务：

| 组件 | 默认地址 | 是否独立进程 | 职责 |
| --- | --- | --- | --- |
| `agent-router` | `http://127.0.0.1:8080` | 是 | 对外入口、runner 发现、session owner 路由、SSE 透传和一次安全重路由 |
| `agent-runner` | `http://127.0.0.1:8787` | 是 | 鉴权、Agent Runtime API、模型执行、session/turn/item/event/approval 与 Blob 生命周期 |
| MySQL | `127.0.0.1:3306` | 是，外部基础设施 | 业务真相及生命周期证据；包含0032/0033 telemetry lifecycle、0034 writer、0035 application capture、0036默认休眠的disposition ledger、0037 grant hard-deny trigger、0038新write不可变membership/source sidecar，0039 T3f owner-closure、0040～0042 T3d source/观察目标/逐artifact plan目录、0044默认休眠的pre-grant intent/claim、0049休眠capture v2结构与0053 default-off受控日志来源，以及0050/0051普通DELETE保留floor和0052 usage证据 |
| Redis | `127.0.0.1:6379` | 是，外部基础设施 | lease hash内owner目录、fence、hot replay stream、瞬时event Pub/Sub及T3g永久purge marker |
| MinIO | `http://127.0.0.1:9000` | 可选，外部基础设施 | 本地/CI的真实S3-compatible Blob、restore-journal、backup-catalog、telemetry writer及0036非生产journal协议测试面；五个独立bucket仍共享同机单实例，不是生产独立故障域，也不是第三个产品应用服务 |
| `packages/sdk` | — | 否 | 供客户端使用的 TypeScript SDK |
| `protocol/core/store/providers/testkit` | — | 否 | 被 runner/router 或测试加载的内部代码库 |

正式客户端和公开OpenAPI authority都是 router 的 `8080`。runner 的 `8787` 用于开发诊断和对照，不应当成为生产环境的公网入口；runner上的`/openapi.json`只是同一已提交契约的构建/兼容性镜像，不能据此绕过router调用edge-owned platform API。

当前本地拓扑覆盖已实现的 M1/M2 主链路；所有长期worker仍内嵌runner，不是第三个服务或镜像。0034 telemetry writer现已装配但默认关闭；0035只接provider failure logs producer。0036新增迁移/共享store/非生产S3协议夹具，0037只增加grant hard-deny guard与非生产v2 Memory协议，0038只增加新write逐项membership/source sidecar，0039只增加T3f同事务owner-closure证据与guards，0040～0042增加T3d同事务source、观察目标、逐artifact plan目录与guards，0044新增只绑定本地source的pre-grant intent/claim；0045～0048只增GET-only观察/非生产v3夹具，0049只装休眠capture v2结构，0050只为普通DELETE保存30天保留floor，后续默认关闭的内嵌caller仅恢复未seal来源。它们均不新增daemon、产品entrypoint或镜像，也不会在普通本地启动中签发grant、执行外部删除或物理purge。产品服务和OCI镜像仍各只有router、runner两个。

## 2. 一次性准备

前置条件：

- Node.js 24；
- pnpm 12.5.1（仓库由 `packageManager` 固定版本）；
- `curl`；
- 当前开发机约定位置上的 MySQL 8 和 Redis；如自行提供兼容实例，需要绕过下文会无条件调用 `infra.sh` 的统一入口，分别启动应用和测试；
- Python 3，`scripts/demo.sh` 用它解析响应、构造后续请求并执行断言。

```bash
cd /path/to/agent-service # 换成实际克隆目录

fnm install 24
fnm use 24
corepack enable
corepack prepare pnpm@12.5.1 --activate

node -v
pnpm -v
pnpm install --frozen-lockfile

test -f .env || cp .env.example .env
```

编辑本机 `.env`：

- 无模型费用的启动、smoke 和主测试不要求填写 `API_KEY`；
- 真实模型 turn、`verify-real` 和 acceptance 必须填写 `API_KEY`；`API_BASE_URL` 和 `DEFAULT_MODEL` 有 DashScope/qwen 默认值，可按所用 provider 覆盖；
- 使用 `openssl rand -hex 32` 生成独立的 `SECRETS_MASTER_KEY`；
- `.env` 不得提交，也不得把密钥复制到命令日志、文档或问题报告中。

默认filesystem路径不需要MinIO。若要体验共享S3数据面，执行一次：

```bash
scripts/build-local-minio.sh
```

脚本只支持当前macOS arm64/x86_64开发边界，会下载并校验固定版本Go归档，再从固定官方MinIO源码commit构建`.local-run/tooling/minio`；产物和缓存都不提交。Linux/容器环境可用`deploy/local/compose.yaml`及其`deploy/local/Dockerfile.minio`从同一固定源码构建本地基础设施镜像。这个MinIO镜像不是agent-service产品发布物，CI的产品image matrix仍只有router和runner。

`scripts/local-service.sh` 会读取 `.env`，但不会主动打印其中的值。当前端口/地址、`REDIS_PREFIX`、`REDIS_NAMESPACE_ID`、`BLOB_STORE`、`BLOB_NAMESPACE_ID`、`BLOB_STORAGE_CONTROL_ENABLED`、`BLOB_S3_*`、tombstone/Blob gate、`SESSION_DELETE_GRACE_RECOVERY_ENABLED`、`DATA_ERASURE_REQUESTS_ENABLED`、`TENANT_ERASURE_REQUESTS_ENABLED`、`TENANT_ERASURE_OPERATOR_TOKEN`、`TENANT_ERASURE_OPERATOR_ID`、`TENANT_ERASURE_BARRIER_TIMEOUT_MS`、`CREDENTIAL_LIFECYCLE_TRACKING_ENABLED`、T3a～T3g worker/execution gate、`DATA_GOVERNANCE_MANAGEMENT_ENABLED`、`PURGE_POLICY_EVALUATOR_ENABLED`、export/erasure worker 和 `ERASURE_ROUTER_URL` 等显式命令行值优先；其它普通同名值可能被 `.env` 覆盖，使用前应检查配置来源，但不要打印密钥。恢复caller的runner gate产品/普通本地默认`0`，`verify`会清除三个恢复变量，不会继承操作者临时开启状态；router配置直接拒绝它们。`0028` mover是更严格的operator-authority边界：统一脚本会在加载`.env`前快照调用方显式提供的`NODE_ENV`、`MYSQL_URL`、全部migration/delay/limit、source/target/S3/credential变量以及所有已导出的`AWS_*`，加载后原样恢复，显式空字符串也优先；只有调用方未设置时才采用`.env`。platform operator token与router execution gate不会进入runner；S3 endpoint、credential和常见AWS/MinIO provider-chain变量也不会进入router。统一脚本只让router收到非密钥namespace/bucket/prefix身份，同时让两端共享准确的Redis与Blob namespace capability。产品默认的credential tracking flag是`0`；统一脚本只为本地可丢弃数据库在调用方未指定时默认设为`1`，生产发布不得照抄这个便捷默认。标准启动固定`STORE=mysql`，所以会拒绝`CREDENTIAL_TARGET_EXECUTION_ADAPTER`、`TENANT_CREDENTIAL_TARGET_EXECUTION_WORKER_ENABLED!=0`或`TENANT_CREDENTIAL_TARGET_EXECUTION_ENABLED!=0`，并在进程边界清除fake与对端变量；`.env.example`只保留两道0029 gate的`0`值。Memory fake必须按下文作为隔离测试演练，不能混入普通MySQL全栈。

`0030`沿用同一进程隔离：runner可接收`RESTORE_JOURNAL_ADAPTER`、原始namespace/epoch/failure-domain ID、S3 endpoint与credential，以及`TENANT_RESTORE_JOURNAL_WORKER_*`；router只允许三个非密钥digest：`RESTORE_JOURNAL_NAMESPACE_SHA256`、`RESTORE_JOURNAL_TARGET_ROOT_SHA256`、`RESTORE_JOURNAL_RUNTIME_EPOCH_SHA256`，并持有独立的`TENANT_RESTORE_JOURNAL_EXECUTION_ENABLED` gate。`RESTORE_RUN_ID`、`SOURCE_BACKUP_SHA256`、`RESTORE_FLEET_STOPPED_ACK`与`RESTORE_JOURNAL_PRIMARY_ACTIVATION_ACK`只属于一次性CLI，两个长期服务都会剥离。统一脚本会像mover一样保留调用方显式传给restore CLI的值（包括空值）且不回显。restore S3 client会忽略AWS环境变量或shared profile配置的endpoint；durable target identity精确绑定受控region以及normalized显式custom endpoint或`standard-endpoint`模式，不能靠provider chain静默切换目标。不要把原始endpoint、credential或CLI authority复制给router，也不要把三个digest误当成credential。

`0031`采用更窄的operator边界：全部`BACKUP_CATALOG_*`、`TENANT_BACKUP_CATALOG_*`及backup/restore/eviction operation变量都会从长期runner和router剥离，只在`pnpm maintenance:backup-catalog -- <command>`中恢复调用方显式值；router配置会拒绝这些变量泄漏。router仅从runner capability观察公开catalog namespace/target/runtime-binding digest，不持有S3 endpoint、credential、failure-domain原始ID或retention operator authority。catalog bucket必须与Blob和restore-journal bucket都不同；这些bucket以及后续独立telemetry测试bucket仍共享一个MinIO进程，不得解释为生产独立故障域。

`0034` writer现已接runner，但`TENANT_TELEMETRY_WRITER_ENABLED`默认`0`。filesystem只适合独占本地root，single-runner ACK不是OS lock，production拒绝；0053 v2 capture只支持MySQL+S3 writer，不用filesystem作为替代。S3模式使用独立`TENANT_TELEMETRY_S3_*` identity、bucket/prefix、region/endpoint、private ACK和runner-only credential，target identity不含credential；private ACK不是自动证明。0035 v1与traces capture必须inactive；0053另有受控activation入口，普通`start`不会自动启用。唯一v2 producer为`provider.upstream_request_failed`，任何writer ACK都不是删除、恢复或全域完成。

生产first-admin bootstrap不再把key写到stdout/stderr。只有runner可以同时接收`ADMIN_BOOTSTRAP_TENANT`与绝对路径`ADMIN_BOOTSTRAP_OUTPUT_FILE`；缺任一、路径非绝对、与`BOOTSTRAP_API_KEY`并用，或把output变量注入router都会fail closed。runner用create-only `wx`、`0600`写一行key，随后`fsync`文件和父目录，绝不覆盖既有文件，也不会创建父目录或记录tenant/path/key；同一路径并发writer只有一个成功。文件写入先于数据库提交：若随后store失败，文件会保留而进程失败，operator必须核对数据库状态，不能自动删除或覆盖唯一证据。这个文件只提供同一共享文件系统内的互斥，不是跨VM/容器singleton；只允许一个受控one-shot实例执行，验证key后导入真实Secret manager，撤掉两个变量并按安全策略处理文件。日常`start`不应在`.env`里长期保留这对变量；统一脚本的普通`start`和`verify`都会从runner/router子进程显式清除它们，router配置层也会拒绝残留。

## 3. 启动与停止完整本地栈

最短的本地体验路径如下；除 `acceptance` 外都不调用真实模型：

```bash
cd /path/to/agent-service # 换成实际克隆目录

scripts/local-service.sh start
scripts/local-service.sh status
scripts/local-service.sh smoke

# 所有正式客户端请求都从 router 的 8080 进入
curl -i http://127.0.0.1:8080/healthz
curl -i http://127.0.0.1:8080/readyz
curl -sS http://127.0.0.1:8080/v1/capabilities | python3 -m json.tool
curl -i http://127.0.0.1:8080/v1/agents  # 未带认证，预期 401

# 可选：使用 .env 中的真实模型配置完成交互式端到端体验，会产生费用
scripts/local-service.sh acceptance

# 体验结束。stop 保留 MySQL/Redis/MinIO；down 停止脚本拥有的全部本地基础设施
scripts/local-service.sh stop
# scripts/local-service.sh down
```

若只想看当前实现，先执行到 `smoke`，再按第 4、5 节选择一个功能手工体验即可；不必为了学习普通 runtime API 而开启默认关闭的删除、tenant erasure 或管理 gate。`acceptance` 和 `verify-real` 会读取本机 `.env` 并调用真实 provider，运行前应确认模型与费用；不要把 `.env`、请求头、service key、provider key 或内部 token 复制进终端录屏、CI 日志和问题报告。

`start` 的顺序是：

1. 通过 `deploy/local/infra.sh` 启动 MySQL 和 Redis；S3模式另外启动并bootstrap本地MinIO；
2. 从 TypeScript 源码启动一个 runner；
3. 从 TypeScript 源码启动一个 router，并等待其发现健康 runner。

runner 启动后会同时启动 lifecycle outbox dispatcher、Blob cleanup、durable erasure、generation-zero compensation，以及user-export build/cleanup worker；policy evaluator、T3a credential-store worker、T3b runtime-revocation worker、T3c content-inventory worker、T3d purge-plan worker、T3e local execution worker、T3f database-purge worker、T3g Redis-purge worker和`0029`external-target worker只有显式开启后才启动。`0026` credential tracking和`0027` Blob storage control都不是另一个worker：runner在store连接后、S3 adapter打开前先读取一次`0028` mover control，只有`inactive`、`aborted`或`source_cleaned`才继续；再完成T3g durable restore preflight和credential tracking读取/激活；若选择S3，则创建adapter、验证bucket条件、执行或观察exact namespace cutover，并在任何bootstrap mutation、worker或HTTP listener之前用独立连接再次读取`0028` control。第二次读取关闭adapter验证期间mover commit的窗口；两次startup gate都不会驱逐已运行进程，不能代替mover前真实停止/排空全部runner。停止时先停有claim/lease的worker并drain SessionHost，再等待其它循环。产品配置中破坏性worker和credential tracking均默认`0`；本地脚本为可丢弃本地库在调用方未指定时默认激活credential tracking，并为已有user job的forward-fix显式开启erasure、compensation和export build/cleanup，但evaluator及T3a～T3g execution/worker gate仍保持`0`。标准MySQL栈还固定0029 worker/router gate为`0`且不加载fake，因此不会冒充已执行远端provider操作；如果数据库已经存在0029 durable job或cutover，runner会直接fail closed，而不是忽略它继续服务。普通filesystem `start`不会激活0027；S3 `start`只适用于空库或已经由`0028`安全完成搬迁的库，会不可逆激活或精确观察generation 1。T3e在filesystem下还强制要求单runner断言；S3下要求共享namespace control。若已有任一durable T3g job或cutover，runner会要求T3g worker保持开启；监听前只重放已有durable target ACK的marker，未ACK marker随后由worker轮询收口。这类不可逆演示环境不能再用旧配置回退启动。

如配置`0030`，runner会在store连接后首先创建journal adapter并把MySQL journal/runtime control与外部head做startup preflight，早于`0028` mover gate、T3g restore、其它worker和HTTP listener；dormant时即使worker=`0`也会验证配置后关闭adapter，control已激活时则强制worker=`1`。publisher仍要显式开启且通过router fresh gate才接触publication queue；它不新增监听端口或进程。停止流程会先停止publisher并关闭adapter。普通默认`.env`不配置journal，因此日常Agent Runtime启动不需要MinIO restore bucket。

要把本地栈切到MinIO，先确保使用可丢弃MySQL库，然后取消`.env.example`中S3块的注释（包括`MINIO_ENABLED=1`、`BLOB_STORE=s3`、`BLOB_STORAGE_CONTROL_ENABLED=1`和全部本地`BLOB_S3_*`值），同时保持`BLOB_FILESYSTEM_SINGLE_RUNNER=0`：

```bash
scripts/build-local-minio.sh
scripts/local-service.sh restart
scripts/local-service.sh status
scripts/local-service.sh smoke
scripts/local-service.sh verify-s3
curl -sS http://127.0.0.1:8080/v1/capabilities | python3 -m json.tool
```

capability中的`blobStorage`应显示`shared=true`、generation 1以及不含endpoint/credential的backend与namespace digest。两个独立S3 client的跨实例可见性、并发相同/冲突create、put/delete竞态、重启后tombstone、prefix隔离和anonymous raw GET拒绝由`verify-s3`自动验证；同一命令还会执行`0028`真实MySQL+MinIO mover套件，并以独立临时MySQL库启动源码runner/router，核对`0027` write-once control、`0028` dormant ledger和exact namespace协商，证明对象存储凭据只进入runner。普通`smoke`只检查已经启动的应用入口，不替代这些协议与装配套件。体验后可以停服务，但不能在同一已激活数据库上改回filesystem；若需切回默认路径，使用新的可丢弃数据库而不是修改`blob_storage_control`。

要手动观察telemetry S3 writer，首选`verify-s3`：它给测试子进程配置第四个独立bucket与`S3_TEST_*`，单独新shell不会继承。实际adapter与两个client核对create-only、checksum envelope、exact replay、冲突不覆盖、bucket preflight与anonymous GET拒绝；0053 named E2E另走真实provider故障、公开Runtime API及私有fresh fleet HTTP gate到真实MySQL/MinIO。不要手改control或在普通业务库打开writer；受控`telemetry-capture`用法见下节，`.env.example`本身不是授权。private ACK默认`0`，独立验证后才可显式`1`，同机不同bucket仍不构成云IAM/KMS或独立故障域证明。

### 0053 本地 provider failure capture（默认关闭）

完整门禁及启用流程见[本地受控capture](local-and-deployment.md#0053-本地受控-provider-failure-capture)。先运行`pnpm test:telemetry-capture-operator`、`pnpm test:telemetry-operator-key-compatibility`、`pnpm test:persisted-provider-failure-capture`；有可丢弃MySQL时再运行`pnpm test:persisted-provider-capture-mysql`，HTTP/MySQL/MinIO端到端由`verify-s3`中的`test:telemetry-capture-mysql-s3`执行。required JSON要求目标文件非零通过且零skip，test-only SIGKILL driver不发布。

一次性`pnpm maintenance:telemetry-capture -- <command>`只有五command：`status`真只读DB；`preflight`会mutation content-free S3 probe并明确输出`capabilityProbe=true/mutatedProbeObjects=true`；`activate-lifecycle`提交0033双target/coverage/receipt；`activate-logs`只提交v2 logs activation；`verify-source`独立RR核对真实item/event/usage/billing/source/spool/member/reservation/ACK/inventory，只输出计数与摘要。所有连接verify-only、无DDL、local-only，shared timeout/AbortSignal覆盖原生MySQL和S3；取消不是DB/S3回滚保证。

operator使用`TELEMETRY_CAPTURE_REF_KEY_FILE`：绝对路径、owner-only/current UID/single-link regular file、恰好32 raw bytes，不是hex；symlink/FIFO/读取期间身份变化均拒绝。旧backup/restore使用同reader的可选`TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE`，0033 active必须exact。direct CLI存在应用hex `TENANT_TELEMETRY_REF_KEY`（包括空值）即拒绝；三个wrapper清除此应用变量且保持caller-first file输入，长期服务剥离operator file/全部`TELEMETRY_CAPTURE_*`。不得输出key、路径、原始source ID、URL、model正文或异常文本。

activation之前必须真实停止/排空全部writer、独立迁移0053、完成0030 primary activation，并从DB核对exact epoch/lineage/journal target/head；环境自报epoch或inactive control无效。四个`TELEMETRY_CAPTURE_*_ACK=1`只分别声明local-only、fleet-stopped、legacy-writers-drained、producer-ready，配合exact configured-fleet root；不是自动停服/boot证明。启动后两role gate与真实私有HTTP请求每次重验全部configured直连origin、各自nonce、唯一runner/boot和key/target/control/epoch binding，不用healthy子集或cached proof。

原provider failure的capture边界及0034worker `claim/reserve/create/ack`四边界均fail closed。首次create必须仍满足live owner；历史exact object/ACK仅可恢复原operation，不授予新create权限。v2 gate不可用时，worker仍能在LIMIT前筛选并领取legacy v1/traces队列，不把v2降级或让legacy被挡。绑定来源的usage/lastSeq不可静默部分提交、改写或自动清理；历史NULL/0不补造。

0053相关组合启动指纹为160、当前全库trigger数为662，不能混为一个数字。必须全pre-0053 writer/在途事务排空后独立迁移，只运行新版本、禁止热混跑并forward-fix。真正`0052→0053`升级夹具钉住旧代码，编译并在真实MySQL提交旧failed-step后升级，证明旧来源unknown、新control默认休眠、DDL/marker/drift及旧binary拒绝新指纹，不能用fresh schema替代。capture active仍阻断T3d/T3f及tenant erasure；v1/traces、真实grant、外部处置/恢复与所有completion未开放，active capture新epoch恢复仍无自动rebind。

### 0030 独立 restore journal 本地演练（只用可丢弃数据库）

`0030`不是第三个服务：长期运行时由runner内嵌publisher把已建立的tenant T1 fence发布到外部不可变journal，router只做fresh all-configured fleet barrier；恢复时使用runner发布物中的一次性`restore-ledger-reconcile` CLI。最先应运行自动门禁，而不是直接激活本地业务库：

```bash
pnpm test:tenant-restore-journal-memory
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" \
  pnpm test:tenant-restore-journal-mysql

# 构建/启动固定MinIO，bootstrap与Blob不同名的restore bucket并运行真实S3协议套件；
# 同一命令还会继续运行Blob/mover和源码装配门禁。
scripts/build-local-minio.sh
scripts/local-service.sh verify-s3
```

本地MinIO的restore bucket必须与Blob bucket不同；统一脚本默认使用`agent-service-local-restore-journal`。这只证明S3 create-only/chain/seal/replay协议在真实adapter上执行：MinIO仍与MySQL位于同一开发机和同一基础设施故障域，不能据此签署生产“独立故障域”验收。为可丢弃夹具设置`RESTORE_JOURNAL_INDEPENDENT_FAILURE_DOMAIN_ACK=1`只是允许代码路径运行，不会把同机MinIO变成独立备份系统。

如需手工观察primary activation，应新建一份可丢弃MySQL数据库，并在受保护的本机`.env`或调用环境配置以下身份与目标。`scripts/local-service.sh start`会为长期runner补本地MinIO默认值，但一次性`restore-ledger-reconcile` CLI不会复用这组进程内补值；它必须显式收到endpoint、region、path-style和credential。restore client忽略AWS环境变量/shared profile中的endpoint override；显式region与规范化custom endpoint（或未设置endpoint时的standard-endpoint模式）都会进入durable target identity。下面两个credential值只是占位符，必须在未提交的本地配置中替换，命令、日志和文档都不得回显真实值：

```dotenv
RESTORE_JOURNAL_ADAPTER=s3
RESTORE_JOURNAL_DATABASE_NAMESPACE_ID=agent-service-local-db-v1
RESTORE_JOURNAL_RUNTIME_EPOCH_ID=local-primary-epoch-v1
RESTORE_JOURNAL_NAMESPACE_ID=agent-service-local-restore-v1
RESTORE_JOURNAL_FAILURE_DOMAIN_ID=local-minio-fixture-only
RESTORE_JOURNAL_INDEPENDENT_FAILURE_DOMAIN_ACK=1
RESTORE_JOURNAL_S3_ENDPOINT=http://127.0.0.1:9000
RESTORE_JOURNAL_S3_REGION=us-east-1
RESTORE_JOURNAL_S3_BUCKET=agent-service-local-restore-journal
RESTORE_JOURNAL_S3_PREFIX=tenant-restore-journal
RESTORE_JOURNAL_S3_FORCE_PATH_STYLE=1
RESTORE_JOURNAL_S3_ACCESS_KEY_ID=replace-in-protected-local-env
RESTORE_JOURNAL_S3_SECRET_ACCESS_KEY=replace-in-protected-local-env
TENANT_RESTORE_JOURNAL_WORKER_ENABLED=0
TENANT_RESTORE_JOURNAL_EXECUTION_ENABLED=0
```

先以双gate关闭启动，查看runner的`/v1/capabilities`并记录三个公开、非密钥字段`tenantRestoreJournalNamespaceSha256`、`tenantRestoreJournalTargetRootSha256`与`tenantRestoreRuntimeEpochSha256`。把它们分别作为router的`RESTORE_JOURNAL_NAMESPACE_SHA256`、`RESTORE_JOURNAL_TARGET_ROOT_SHA256`和`RESTORE_JOURNAL_RUNTIME_EPOCH_SHA256`；不要把原始namespace、endpoint或credential传给router。随后停止并排空所有writer：

```bash
scripts/local-service.sh start
curl -sS http://127.0.0.1:8787/v1/capabilities | python3 -m json.tool
scripts/local-service.sh stop
```

`activate-journal`同时要求primary-activation与fleet-stopped两个ACK，并要求显式声明当前Blob backend，以便在建立任何MySQL/S3连接前检查journal bucket不能与S3 Blob bucket相同。默认filesystem Blob只运行下面这一组：

```bash
BLOB_STORE=filesystem \
RESTORE_FLEET_STOPPED_ACK=1 \
RESTORE_JOURNAL_PRIMARY_ACTIVATION_ACK=1 \
  pnpm maintenance:restore-ledger-reconcile -- activate-journal
```

若当前Blob也是S3，则只运行下面这一组；本地`agent-service-local`必须不同于上面的restore bucket：

```bash
BLOB_STORE=s3 \
BLOB_S3_BUCKET=agent-service-local \
RESTORE_FLEET_STOPPED_ACK=1 \
RESTORE_JOURNAL_PRIMARY_ACTIVATION_ACK=1 \
  pnpm maintenance:restore-ledger-reconcile -- activate-journal
```

无论选择哪组，成功后再只读检查：

```bash
pnpm maintenance:restore-ledger-reconcile -- status
```

两组activation命令二选一，不能连续执行。缺少`BLOB_STORE`、S3模式缺少`BLOB_S3_BUCKET`，或两个bucket相同都会no-connect fail closed；这不是自动证明两个bucket位于独立故障域。

activation是forward-only边界。成功后所有runner必须携带完全相同的原始journal配置并保持`TENANT_RESTORE_JOURNAL_WORKER_ENABLED=1`，否则startup preflight拒绝服务。先保持router execution gate=`0`启动全部runner并核对上述三个digest、`tenantRestoreJournal` capability及worker-active完全一致，再最后开启router的`TENANT_RESTORE_JOURNAL_EXECUTION_ENABLED=1`：

```bash
TENANT_RESTORE_JOURNAL_WORKER_ENABLED=1 \
TENANT_RESTORE_JOURNAL_EXECUTION_ENABLED=0 \
  scripts/local-service.sh start
curl -sS http://127.0.0.1:8080/v1/capabilities | python3 -m json.tool

TENANT_RESTORE_JOURNAL_WORKER_ENABLED=1 \
TENANT_RESTORE_JOURNAL_EXECUTION_ENABLED=1 \
  scripts/local-service.sh restart
```

之后tenant T1 materialize与journal publication之间使用durable queue、exact response-loss replay和fresh barrier收口；它不是跨MySQL/S3分布式事务。没有公开raw-journal API，手工只看content-free capability/status，记录链与故障语义由上述named suites验证。若只想重新体验，应新建可丢弃数据库与全新bucket/prefix/identity，不能手改已激活control或把原journal复用为空journal。

数据库恢复演练必须在所有router、runner及旧writer都已摘流、停止并排空后进行；`RESTORE_FLEET_STOPPED_ACK=1`只是operator声明，不会自动杀掉进程。0031 active后先从权威catalog选择仍可恢复、未淘汰且当前数据库中保留exact local anchor的entry，以全新`restore_<UUIDv4>`格式的`RESTORE_RUN_ID`执行`prepare-restore`并永久预留runtime epoch；必须把精确`BACKUP_ID`、run/epoch ID、source evidence及catalog/journal target identity安全保存在数据库故障域之外。物理恢复并升级/验证所选数据库快照后，先以完全相同的这些输入再次执行0031 `prepare-restore`，让external reservation exact replay并原子重建本地entry/binding/reservation/0030 run，才能进入0030 replay；active catalog会拒绝缺少该绑定的普通0030 `prepare`。如果恢复的旧快照不包含这个selected backup的exact anchor，prepare会fail closed；即使external reservation已经存在，也必须换回包含该anchor的快照，不能改用另一个backup或新operation绕过。该门禁只能排除早于/不含anchor的快照，无法区分正确的selected物理快照与仍包含该anchor的更晚合法快照；operator/backup producer必须用物理snapshot/provider evidence独立核验，这是当前P1级流程/attestation风险。0030使用的`SOURCE_BACKUP_SHA256`与`RESTORE_JOURNAL_RUNTIME_EPOCH_ID`必须和该binding/reservation完全一致：

```bash
pnpm maintenance:restore-ledger-reconcile -- status

# 通过受控环境注入0031已经绑定的RESTORE_RUN_ID、SOURCE_BACKUP_SHA256、
# RESTORE_JOURNAL_RUNTIME_EPOCH_ID，并设置RESTORE_FLEET_STOPPED_ACK=1后执行：
pnpm maintenance:backup-catalog -- prepare-restore
pnpm maintenance:restore-ledger-reconcile -- run
pnpm maintenance:restore-ledger-reconcile -- status

# run只做prepare → replay-fences → verify；审阅证据后另行显式激活。
pnpm maintenance:restore-ledger-reconcile -- activate-runtime
pnpm maintenance:restore-ledger-reconcile -- status
```

恢复安全顺序固定为：冻结全部writer → 恢复前0031选择backup/预留epoch并安全保存精确输入 → 实际恢复/升级验证数据库 → 原ID/evidence再次0031 `prepare-restore`重建本地权威投影 → 0030 `replay-fences`把journal记录变成永久本地tenant fence → `verify`封存完整性证据 → 人工审阅 → `activate-runtime`提交新epoch → 0031 `resolve-restore`投影`activated`。`run`中的0030 prepare只能在第二次0031 prepare之后作为exact replay使用；不能从恢复出的旧快照直接跳到普通0030 prepare。需要逐步排障时可分别执行这些command；`verify`与`abort`是DB-only边界，`activate-runtime`仍会重读外部head。上述restore-ledger命令都使用verify-only store连接，不执行DDL：先要求随镜像发布的完整migration marker集合；0030 marker存在时还校验精确schema/trigger fingerprint，并在成功或失败后恢复临时修改的MySQL session `group_concat_max_len`。`abort`只允许在runtime activation前使用，且不能删除已重放的永久fence或使该epoch可复用；中止后还要把同一0031 reservation精确resolve为`aborted`。`resolve-restore`要求本地精确reservation和已terminal的0030 run；当前没有只凭external event处理孤立reservation的abort/resolution入口，因此缺少selected anchor的过早快照不能靠“外部abort”补救。激活后先让router gate保持`0`，以新epoch和精确三digest部署全量runner并通过startup preflight/fleet核对，再开放publisher gate，最后才考虑恢复其它破坏性gate。

这仍不是完整灾备闭环：journal和catalog当前都只支持单target；MySQL提交与S3写入靠saga/exact replay而非原子事务；独立故障域、fleet stopped、primary activation及物理backup创建/删除都含外部流程与人工ACK。当前journal adapter只有逐请求deadline，完整chain scan/restore operation没有统一deadline；分页scan每页从chain起点重验sealed prefix，整体对象读取复杂度为`O(n²)`，必须在staging按真实记录量验证请求数、费用、容量与维护窗口。0031消除了游离backup digest/epoch的来源协议缺口，但不创建备份、不证明backup内tenant erasure或云故障域；只有把这些残余风险及真实staging恢复演练收口后，才能称为生产恢复能力。

### 0031 权威 backup catalog 本地演练（只用可丢弃数据库）

0031不是第三个服务或worker；它由runner发布物中的一次性`backup-catalog` CLI操作。普通runtime启动会剥离全部catalog S3配置与operator变量，router只观察非密钥capability digest。先运行自动门禁：

```bash
pnpm test:tenant-backup-catalog-mysql
scripts/local-service.sh verify-s3
pnpm build:check
```

`verify-s3`已在自己的子进程环境中执行catalog reconcile与restore-roundtrip真实MySQL+S3套件；这些环境变量不会留在调用它的shell中，不要紧接着无配置地单独运行两套件。`build:check`先构建，再核对runner内的one-shot `backup-catalog`产物。`verify-s3`会使用第三个、与Blob和restore journal不同的MinIO bucket强制真实catalog chain套件执行；三个bucket仍属于同一MinIO进程，只能证明协议，不能证明生产独立故障域。手工演练必须在受控环境注入`BACKUP_CATALOG_ADAPTER=s3`、database/namespace/failure-domain identity、独立故障域ACK、`BACKUP_CATALOG_S3_*`和两项retention参数，不得在命令行或录屏中回显值。操作骨架是：

```bash
pnpm maintenance:backup-catalog -- status
pnpm maintenance:backup-catalog -- activate

# 外部系统真正创建并验证full backup的步骤位于两条命令之间。
pnpm maintenance:backup-catalog -- begin-backup
pnpm maintenance:backup-catalog -- publish-backup
pnpm maintenance:backup-catalog -- list

# 恢复前选择/预留；物理恢复后以同一ID/evidence重跑本命令，再进入0030 replay。
pnpm maintenance:backup-catalog -- prepare-restore
# 0030 activation或abort之后再投影同一reservation的terminal resolution。
pnpm maintenance:backup-catalog -- resolve-restore

# eviction必须先停服并保持停服，拿计划、外部删除制品，再记录永久tombstone。
RESTORE_FLEET_STOPPED_ACK=1 pnpm maintenance:backup-catalog -- prepare-eviction
# 不得在两条命令之间恢复writer或启动另一catalog operator。
RESTORE_FLEET_STOPPED_ACK=1 pnpm maintenance:backup-catalog -- record-eviction
pnpm maintenance:backup-catalog -- reconcile
```

`begin-backup`只固定当前schema/runtime/journal/Blob control lineage，不复制数据库。物理full backup、manifest和provider结果由外部producer/operator创建并独立验证；`publish-backup`只接收其声明的SHA-256摘要，adapter只验证摘要格式、catalog身份、外部事件链与exact replay并绑定attested digest，不读取backup bytes、manifest文件或provider响应内容。首次`prepare-restore`要求selected entry仍有exact local anchor，并把source binding、永久epoch reservation与0030 prepare原子提交；旧快照恢复后必须以相同ID/evidence再运行一次以重建这些本地投影。恢复了不含selected anchor的过早快照时必须换回包含该anchor的snapshot，不能因外部reservation已存在而改选backup或epoch；当前也没有external-only orphan reservation abort入口。应用无法区分正确的selected物理快照与仍包含该anchor的更晚合法快照，operator/backup producer仍须以物理snapshot/provider evidence独立核验，这是当前P1级流程/attestation风险。`prepare-eviction`会按MySQL时间重验retention、最少可恢复backup数、catalog head及活动reservation。eviction必须在prepare前摘流、停止并排空全部writer及其它catalog operator，持续经过外部物理删除，直到`record-eviction`成功提交；两次提供的`RESTORE_FLEET_STOPPED_ACK=1`都只是人工声明，不是进程探测。当前prepare不会持久化two-phase eviction intent，故该外部窗口仍是需后续账本闭合的风险。响应丢失只能用完全相同的ID/evidence重放，不能更换epoch、手填digest或把“准备删除”冒充“已物理不存在”。

`reconcile`不是把external catalog当作数据库backup来“恢复一切”。它要求恢复库中仍有active且identity匹配的0031 control，验证并镜像完整content-free sealed chain；数据库中的external-event mirror是catalog sequence/hash head的唯一authority，任一local anchor缺失都不会截断后继event。availability event可直接重建recoverable entry，eviction可由已镜像availability、外部ACK和event前一head重建；resolution只有同时存在匹配本地reservation与terminal 0030 run时才推进本地reservation，否则只留下external authority并继续镜像。通用reconcile不会补造anchor、source binding/reservation或0030 run，selected restore仍必须通过`prepare-restore`验证exact local anchor。不含该anchor的过早快照应换回包含原selected backup anchor的快照并重放相同operation；仍含该anchor的更晚合法快照则只能由operator/backup producer通过物理证据排除，应用自身不能识别。两类场景都不能通过手改表或把external chain当成数据库bytes、业务行、0030 fence/journal或tenant erasure completion证据处理。

### 本地MySQL加密逻辑备份制品（只用可丢弃数据库）

backup/restore CLI已补受保护exact ref-key文件接线：0033 inactive可无key，active必须以同一key审计source与实际import后的target，missing/wrong key仍拒绝。真实active0033制品create→restore-selected→restore-ledger replay/verify/getter用例已接必执行套件，验收结果只看PROGRESS及当次JSON，不沿用旧inactive测试结果。它不覆盖active capture跨epoch恢复，既有capture receipt与旧epoch绑定，恢复到新epoch仍fail closed、无自动rebind。具体权限、raw32byte格式和内存填零时机见[备份运维契约](local-and-deployment.md#本地mysql加密逻辑备份制品)。

旧0031流程只保存operator-attested摘要；新增的`create-artifact`才真实调用MySQL 8 mysqldump生成InnoDB应用逻辑SQL，以独立key加密，并把已认证实际bytes的证据发布到同一catalog。`verify-artifact`认证完整制品及catalog/anchor，也可对账content-free投影，不能叫严格只读；`restore-selected`真实导入隔离空target，只到prepared。仍只有router/runner两个长期服务，仍使用既有`backup-catalog.js`入口，不新增migration或镜像。

先执行自动门禁：

```bash
scripts/local-service.sh verify-s3
# 单独跑下面的真实套件需要自行注入其MySQL/MinIO/宿主工具测试配置。
# pnpm test:mysql-backup-artifact-mysql-s3
pnpm build:check
```

手工演练前请读`local-and-deployment.md`的“本地MySQL加密逻辑备份制品”，完成既有0030/0031本地activation，并真正停止/排空全部writer；ACK不是自动证明。通过受控环境设置canonical 0700 artifact目录、0600独立raw 32-byte key（不复用master key）、绝对宿主MySQL 8工具路径、local-only ACK及catalog/journal配置；恢复另需在线source、明确空且不同actual数据库tuple的target、`BACKUP_ID=backup_<UUIDv4>`、全新`RESTORE_RUN_ID=restore_<UUIDv4>`（小写，不是裸UUID）和never-used epoch。恢复前把`RESTORE_JOURNAL_RUNTIME_EPOCH_ID`设为与`BACKUP_RUNTIME_EPOCH_ID`完全相同，或不显式提供由CLI注入；不能残留primary epoch。预算默认256 MiB/120秒、最大1 GiB/600秒，spool要预留约4倍上限。`NODE_ENV=production`拒绝运行；runner镜像没有mysql/mysqldump，镜像/Node的help通过不代表能实际backup。不得把DSN/key/SQL贴进终端输出、日志或录屏。

```bash
scripts/local-service.sh stop
pnpm maintenance:backup-catalog -- create-artifact
pnpm maintenance:backup-catalog -- verify-artifact
# 新first attempt自行reserve；不要提前执行旧prepare-restore。
pnpm maintenance:backup-catalog -- restore-selected
```

成功仅`prepared/runtimeActivated=false/fenceReplayComplete=false`。之后将operator source明确切到已导入target，明确提供新epoch的`RESTORE_JOURNAL_RUNTIME_EPOCH_ID`，以同一run/epoch/evidence执行0030 `replay-fences → verify → status`，人工审阅，再单独activation和0031 resolution；不会自动切换应用或启动服务。任意已reserve run或epoch（含resolved）永久禁止重导，跨目录/new target/old source也不能绕过。导入DDL auto-COMMIT，故障可能留下部分目标；保留原ID/证据/现场，只有独立确认完整import且exact schema/anchor有效的target才可人工forward-fix；`SOURCE_BACKUP_SHA256`取已认证catalog/restore输出的`sourceBackupSha256`，不猜测，部分import不能直接prepare续接，禁止自动DROP、清空、重复导入或换epoch掩盖失败。

schema-root v2只消除明确表/列charset-collation下已证冗余显示，独立真实套件还核对七类I_S与十类trigger字段；unknown/backslash DDL保持raw，可能安全拒绝其它合法schema。统一操作预算/native cancellation不撤销已发COMMIT/CAS；pending未settle不提前释放operator。真实套件required report必须非零、全部passed、零skip，CI新增具名MySQL+MinIO步骤及宿主MySQL 8版本检查；这不等于当前镜像含native工具，也不是生产DR。它不覆盖PITR、Blob/Redis联合旧快照、backup-copy erasure、任意schema或云故障域/IAM/KMS/RPO/RTO，M1仍未冻结。

### 离线 filesystem→S3 mover 手工演练（只用可丢弃数据）

这不是普通启动步骤，而是一次停机维护演练。先在独立可丢弃数据库和filesystem root中创建少量Blob/export测试数据，确认目标MinIO namespace也是一次性的；然后摘流并真实停止所有router、runner和其它旧writer，等待active turn、worker claim、I/O与lease排空。runner startup gate只能阻止后续启动，不能杀掉已经运行的进程；router可停止以避免维护期间持续产生`502/503`，但不参与mover，也不应获得`MYSQL_URL`或对象存储credential。

CLI只接受一个command；DSN、路径、endpoint、namespace、credential和维护参数都通过受控环境变量注入，禁止把值复制到命令、日志或文档。`status`只需要`MYSQL_URL`；其它阶段按需使用现有`BLOB_DIR`、`BLOB_NAMESPACE_ID`、`BLOB_S3_*`，以及`MIGRATION_ID`、`FLEET_DRAINED_EVIDENCE_SHA256`、`ROLLBACK_WINDOW_MS`、`SOURCE_CLEANUP_DELAY_MS`。`MAX_OBJECT_BYTES`默认64 MiB、最大1 GiB。调用命令时显式导出的这些变量、credential和`AWS_*`（包括显式空值）会覆盖`.env`，统一脚本不会回显它们。

```bash
scripts/local-service.sh stop

pnpm maintenance:blob-storage-migrate -- status
pnpm maintenance:blob-storage-migrate -- prepare
pnpm maintenance:blob-storage-migrate -- copy
pnpm maintenance:blob-storage-migrate -- verify
pnpm maintenance:blob-storage-migrate -- status

# verified且尚未cutover时，若决定回退：
# pnpm maintenance:blob-storage-migrate -- abort

# rollback window按MySQL时间到期且证据复核通过后，显式提交不可逆cutover：
pnpm maintenance:blob-storage-migrate -- cutover
pnpm maintenance:blob-storage-migrate -- status

# source-cleanup delay到期后仍需显式执行；committed阶段不能启动runtime：
pnpm maintenance:blob-storage-migrate -- cleanup-source
pnpm maintenance:blob-storage-migrate -- status
```

`run`只自动串联prepare→copy→verify，默认停在`verified`；只有显式设置`BLOB_MIGRATION_COMMIT=1`才会继续cutover，且永远不会自动执行source cleanup。一个MySQL advisory lock只允许一个mutating operator，`status`可独立并行读取。每次target/source外部mutation还持有migration-control行共享锁并在动作前后复核named-lock owner；锁连接丢失时旧operator不写ACK或推进phase，replacement会等待行锁后按exact owner/descriptor重放收敛。运行期只允许`inactive`、`aborted`、`source_cleaned`启动；`committed`仍会阻止runner，防止source尚未清理时误恢复。

inventory仅以MySQL ledger里的live/open-intent记录为authority：`blob_objects`、Blob delete intent、export artifact/part、snapshot pin和export delete intent。它不会遍历或证明`BLOB_DIR`中任意无manifest文件；已被ledger精确引用的legacy raw + `.meta`可由mover专用读取和清理，未知root orphan仍需另做只读盘点和人工审计。abort不会硬删或复用target key，而是以conditional PUT/CAS把本次owner的同key对象替换成永久tombstone；aborted target namespace永久不可复用。cutover提交后不能回滚，只能forward-fix至source cleanup并以exact S3 identity恢复。

当前实现把candidate/inventory/ACK集合放在进程内存，并用大型事务与全范围锁换取正确性；没有分页、batch、dry-run、在线迁移、S3→S3或operator HA。MySQL整库重启可能同时释放named lock与行锁，恢复仍依赖create-only/CAS、owner tombstone与精确重放。MinIO演练只证明小规模协议和失败恢复，不能替代staging中的停机窗口、内存、锁等待/死锁、网络、IAM、容量和source备份验证。

要专门体验当前 user erasure gate，请只对可丢弃 user 显式开启两端 gate 后重启：

```bash
ERASURE_WORKER_ENABLED=1 LEGACY_TOMBSTONE_COMPENSATION_ENABLED=1 \
  DATA_ERASURE_REQUESTS_ENABLED=1 scripts/local-service.sh restart
curl -sS http://127.0.0.1:8080/v1/capabilities | python3 -m json.tool
```

预期 router capability 中 `dataErasureRequests` 为 `true`，并在管理 gate 仍关闭时同时显示 `dataGovernance=["canonical-retention-v1","multi-legal-hold-v1"]`、`dataGovernanceManagement=false`；这证明user-erasure admission writer理解durable authority，但不开放管理端点。直接查看 runner capability 时 `erasureJobControl` 还会同时包含 `quarantine-v1` 与 `legacy-tombstone-compensation-v1`。该开关只接受user-scoped durable request，不会启用物理 purge，也与tenant T1无关。rollout 状态故意不出现在 router 公开 capability；它只通过带 `INTERNAL_ROUTER_TOKEN` 的 v2 私有固定 ACK 供 worker 检查。旧 v1 路径故意不兼容并返回 404，避免旧 worker 在 compensation rollout 期间继续 claim。部署时可以只关闭 router writer gate 并保持 capable runner 的 gate 开启，此时已有 request 的 status GET 继续可读；mixed fleet 会返回 `503`。POST/status 的成功与错误响应均带 `Cache-Control: no-store`，不得在调试代理中改写为可缓存。本地统一脚本用同一个变量配置两端，因此体验结束后运行 `DATA_ERASURE_REQUESTS_ENABLED=0 scripts/local-service.sh restart` 会同时关闭 runner admission capability：新的 POST 和 status GET 都会返回 `503`，但已经落库的 subject gate 不会被撤销，两个后台 worker仍可继续 forward-fix。

staging/production 的 tombstone gate 必须按第 9 节滚动发布流程激活。production runner继续拒绝filesystem Blob写入或cleanup，防止任一replica领取全局MySQL outbox后只操作自己的本地磁盘。S3 adapter与`0028` mover已实现本地/CI代码契约，但只有在实际bucket/IAM、anonymous access、条件写、一致性、故障和容量均在staging验收，且空库完成`0027`activation或非空库完成`0028`停服搬迁后，才能开放production Blob/export/T3e相关gate。

`smoke` 不调用真实模型，验证两端 readiness、两份 OpenAPI、router 转发和未鉴权请求返回 `401`。

日志和停止命令：

```bash
scripts/local-service.sh logs
scripts/local-service.sh status

scripts/local-service.sh stop  # 只停 router/runner，保留 MySQL/Redis/MinIO
scripts/local-service.sh down  # 停 router/runner及脚本拥有的MySQL/Redis/MinIO
```

应用 PID 和日志保存在未提交的 `.local-run/`。`stop` 发送 `SIGTERM`，让 runner 有界 drain；超时会保留现场并报错，不会擅自强杀。

### 基础设施脚本的机器边界

`deploy/local/infra.sh` 是当前 macOS 开发机的适配脚本，默认查找：

- `~/.local/bin/redis-server` 和 `redis-cli`；
- `/usr/local/bin/mysqld` 和 `mysql`；
- S3模式下的`.local-run/tooling/minio`；
- `~/.local/var` 下的数据目录。

其它机器可用 `REDIS_BIN`、`REDIS_CLI`、`MYSQLD`、`MYSQL`、`MINIO_BIN`覆盖路径。`deploy/local/compose.yaml`启动MySQL、Redis和由固定官方源码构建的MinIO/bootstrap辅助容器，应用仍从宿主机启动；使用Compose或其它兼容实例时不要执行会再次调用`infra.sh`的`local-service.sh start`、`verify`或`verify-s3`，而应按第7节的两条源码命令启动应用，并直接运行下面的等价门禁。先显式创建`agent_service_test`与`agent_service_cluster`两个可丢弃数据库，并bootstrap普通`S3_TEST_BUCKET`、`S3_RESTORE_JOURNAL_TEST_BUCKET`、`S3_BACKUP_CATALOG_TEST_BUCKET`、`S3_TENANT_TELEMETRY_TEST_BUCKET`和`S3_TELEMETRY_DISPOSITION_TEST_BUCKET`五个彼此不同的bucket；测试安全门会拒绝把业务库`agent_service`当删除/重建目标，缺失对应测试bucket配置也会fail closed。外部模式下逐条运行S3命令前，操作者须核对这五个bucket确实各不相同；单条套件并不知道其它套件的全部bucket。即使彼此不同，同机bucket也只证明协议隔离，不是独立故障域。后续会为统一入口增加显式的外部基础设施模式。

```bash
pnpm check:secrets
pnpm check:api
pnpm typecheck
pnpm test:tenant-telemetry-lifecycle
pnpm test:tenant-telemetry-lifecycle-memory
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:tenant-telemetry-lifecycle-mysql
pnpm test:tenant-telemetry-application-capture
pnpm test:telemetry-capture-operator
pnpm test:telemetry-operator-key-compatibility
pnpm test:persisted-provider-failure-capture
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:persisted-provider-capture-mysql
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:tenant-telemetry-application-capture-mysql
pnpm test:tenant-telemetry-writer
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:tenant-telemetry-writer-mysql
pnpm test:tenant-telemetry-disposition
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:tenant-telemetry-disposition-mysql
pnpm test:tenant-telemetry-disposition-grant
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:tenant-telemetry-disposition-grant-mysql
pnpm test:tenant-telemetry-disposition-journal-v3
pnpm test:tenant-telemetry-disposition-journal-v3-observer
pnpm test:tenant-telemetry-artifact-observer
pnpm test:session-delete-grace-memory
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:session-delete-grace-mysql
pnpm test:session-delete-grace-recovery-memory
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:session-delete-grace-recovery-mysql
mkdir -p .local-run
AGENT_SERVICE_INTEGRATION=1 MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" REDIS_TEST_URL="redis://127.0.0.1:6379/1" \
  pnpm vitest run --coverage --exclude 'test/cluster/**' \
    --reporter=default --reporter=json --outputFile.json=.local-run/verify-tests.json
AGENT_SERVICE_TEST_REPORT=.local-run/verify-tests.json node scripts/assert-suites-ran.mjs
MYSQL_MIGRATION_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:migrations
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:blob-mysql
pnpm test:blob-storage-control-memory
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:blob-storage-control-mysql
pnpm test:tenant-restore-journal-memory
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:tenant-restore-journal-mysql
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:tenant-backup-catalog-mysql
# 若已按上文启动S3-compatible服务并bootstrap测试bucket，先从安全环境注入以下六个
# S3_TEST_*；命令会在缺值时fail closed，不能只设置AGENT_SERVICE_S3_INTEGRATION：
env S3_TEST_ENDPOINT="$S3_TEST_ENDPOINT" S3_TEST_REGION="$S3_TEST_REGION" \
  S3_TEST_BUCKET="$S3_TEST_BUCKET" S3_TEST_ACCESS_KEY_ID="$S3_TEST_ACCESS_KEY_ID" \
  S3_TEST_SECRET_ACCESS_KEY="$S3_TEST_SECRET_ACCESS_KEY" S3_TEST_FORCE_PATH_STYLE="$S3_TEST_FORCE_PATH_STYLE" \
  pnpm test:blob-s3
# restore journal必须使用另一个已bootstrap的bucket；外部infra模式不能调用verify-s3 wrapper。
env S3_TEST_ENDPOINT="$S3_TEST_ENDPOINT" S3_TEST_REGION="$S3_TEST_REGION" \
  S3_TEST_BUCKET="$S3_TEST_BUCKET" S3_RESTORE_JOURNAL_TEST_BUCKET="$S3_RESTORE_JOURNAL_TEST_BUCKET" \
  S3_TEST_ACCESS_KEY_ID="$S3_TEST_ACCESS_KEY_ID" S3_TEST_SECRET_ACCESS_KEY="$S3_TEST_SECRET_ACCESS_KEY" \
  S3_TEST_FORCE_PATH_STYLE="$S3_TEST_FORCE_PATH_STYLE" pnpm test:restore-journal-s3
# backup catalog必须使用第三个已bootstrap的bucket，并与Blob及restore journal隔离。
env S3_TEST_ENDPOINT="$S3_TEST_ENDPOINT" S3_TEST_REGION="$S3_TEST_REGION" \
  S3_TEST_BUCKET="$S3_TEST_BUCKET" S3_BACKUP_CATALOG_TEST_BUCKET="$S3_BACKUP_CATALOG_TEST_BUCKET" \
  S3_TEST_ACCESS_KEY_ID="$S3_TEST_ACCESS_KEY_ID" S3_TEST_SECRET_ACCESS_KEY="$S3_TEST_SECRET_ACCESS_KEY" \
  S3_TEST_FORCE_PATH_STYLE="$S3_TEST_FORCE_PATH_STYLE" pnpm test:backup-catalog-s3
# telemetry writer使用独立的第四个artifact bucket，不复用Blob、restore或catalog。
env S3_TEST_ENDPOINT="$S3_TEST_ENDPOINT" S3_TEST_REGION="$S3_TEST_REGION" \
  S3_TENANT_TELEMETRY_TEST_BUCKET="$S3_TENANT_TELEMETRY_TEST_BUCKET" \
  S3_TEST_ACCESS_KEY_ID="$S3_TEST_ACCESS_KEY_ID" S3_TEST_SECRET_ACCESS_KEY="$S3_TEST_SECRET_ACCESS_KEY" \
  S3_TEST_FORCE_PATH_STYLE="$S3_TEST_FORCE_PATH_STYLE" pnpm test:tenant-telemetry-writer-s3
# 0053实际公开Runtime/private fresh fleet HTTP→MySQL→MinIO，复用第四个telemetry与restore bucket。
env S3_TEST_ENDPOINT="$S3_TEST_ENDPOINT" S3_TEST_REGION="$S3_TEST_REGION" \
  S3_TENANT_TELEMETRY_TEST_BUCKET="$S3_TENANT_TELEMETRY_TEST_BUCKET" \
  S3_RESTORE_JOURNAL_TEST_BUCKET="$S3_RESTORE_JOURNAL_TEST_BUCKET" \
  S3_TEST_ACCESS_KEY_ID="$S3_TEST_ACCESS_KEY_ID" S3_TEST_SECRET_ACCESS_KEY="$S3_TEST_SECRET_ACCESS_KEY" \
  S3_TEST_FORCE_PATH_STYLE="$S3_TEST_FORCE_PATH_STYLE" \
  MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:telemetry-capture-mysql-s3
# 0036独立disposition journal使用第五个bucket；这仅是非生产协议夹具。
env S3_TEST_ENDPOINT="$S3_TEST_ENDPOINT" S3_TEST_REGION="$S3_TEST_REGION" \
  S3_TELEMETRY_DISPOSITION_TEST_BUCKET="$S3_TELEMETRY_DISPOSITION_TEST_BUCKET" \
  S3_TEST_ACCESS_KEY_ID="$S3_TEST_ACCESS_KEY_ID" S3_TEST_SECRET_ACCESS_KEY="$S3_TEST_SECRET_ACCESS_KEY" \
  S3_TEST_FORCE_PATH_STYLE="$S3_TEST_FORCE_PATH_STYLE" pnpm test:tenant-telemetry-disposition-s3
# 0047/0048 v3非生产journal夹具与GET-only观察器仍复用第五个测试bucket。
env S3_TEST_ENDPOINT="$S3_TEST_ENDPOINT" S3_TEST_REGION="$S3_TEST_REGION" \
  S3_TELEMETRY_DISPOSITION_TEST_BUCKET="$S3_TELEMETRY_DISPOSITION_TEST_BUCKET" \
  S3_TEST_ACCESS_KEY_ID="$S3_TEST_ACCESS_KEY_ID" S3_TEST_SECRET_ACCESS_KEY="$S3_TEST_SECRET_ACCESS_KEY" \
  S3_TEST_FORCE_PATH_STYLE="$S3_TEST_FORCE_PATH_STYLE" pnpm test:tenant-telemetry-disposition-journal-v3-s3
env S3_TEST_ENDPOINT="$S3_TEST_ENDPOINT" S3_TEST_REGION="$S3_TEST_REGION" \
  S3_TELEMETRY_DISPOSITION_TEST_BUCKET="$S3_TELEMETRY_DISPOSITION_TEST_BUCKET" \
  S3_TEST_ACCESS_KEY_ID="$S3_TEST_ACCESS_KEY_ID" S3_TEST_SECRET_ACCESS_KEY="$S3_TEST_SECRET_ACCESS_KEY" \
  S3_TEST_FORCE_PATH_STYLE="$S3_TEST_FORCE_PATH_STYLE" pnpm test:tenant-telemetry-disposition-journal-v3-observer-s3
# 0046 artifact GET-only观察器复用第四个测试bucket，不发布删除ACK。
env S3_TEST_ENDPOINT="$S3_TEST_ENDPOINT" S3_TEST_REGION="$S3_TEST_REGION" \
  S3_TENANT_TELEMETRY_TEST_BUCKET="$S3_TENANT_TELEMETRY_TEST_BUCKET" \
  S3_TEST_ACCESS_KEY_ID="$S3_TEST_ACCESS_KEY_ID" S3_TEST_SECRET_ACCESS_KEY="$S3_TEST_SECRET_ACCESS_KEY" \
  S3_TEST_FORCE_PATH_STYLE="$S3_TEST_FORCE_PATH_STYLE" pnpm test:tenant-telemetry-artifact-observer-s3
env S3_TEST_ENDPOINT="$S3_TEST_ENDPOINT" S3_TEST_REGION="$S3_TEST_REGION" \
  S3_TEST_BUCKET="$S3_TEST_BUCKET" S3_BACKUP_CATALOG_TEST_BUCKET="$S3_BACKUP_CATALOG_TEST_BUCKET" \
  S3_TEST_ACCESS_KEY_ID="$S3_TEST_ACCESS_KEY_ID" S3_TEST_SECRET_ACCESS_KEY="$S3_TEST_SECRET_ACCESS_KEY" \
  S3_TEST_FORCE_PATH_STYLE="$S3_TEST_FORCE_PATH_STYLE" \
  MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" \
  pnpm test:backup-catalog-reconcile-mysql-s3
env S3_TEST_ENDPOINT="$S3_TEST_ENDPOINT" S3_TEST_REGION="$S3_TEST_REGION" \
  S3_TEST_BUCKET="$S3_TEST_BUCKET" S3_RESTORE_JOURNAL_TEST_BUCKET="$S3_RESTORE_JOURNAL_TEST_BUCKET" \
  S3_BACKUP_CATALOG_TEST_BUCKET="$S3_BACKUP_CATALOG_TEST_BUCKET" \
  S3_TEST_ACCESS_KEY_ID="$S3_TEST_ACCESS_KEY_ID" S3_TEST_SECRET_ACCESS_KEY="$S3_TEST_SECRET_ACCESS_KEY" \
  S3_TEST_FORCE_PATH_STYLE="$S3_TEST_FORCE_PATH_STYLE" \
  MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" \
  pnpm test:backup-catalog-restore-roundtrip-mysql-s3
# 真实加密制品/active0033恢复审计还需已核验的绝对MySQL8工具路径。
env S3_TEST_ENDPOINT="$S3_TEST_ENDPOINT" S3_TEST_REGION="$S3_TEST_REGION" \
  S3_RESTORE_JOURNAL_TEST_BUCKET="$S3_RESTORE_JOURNAL_TEST_BUCKET" \
  S3_BACKUP_CATALOG_TEST_BUCKET="$S3_BACKUP_CATALOG_TEST_BUCKET" \
  S3_TEST_ACCESS_KEY_ID="$S3_TEST_ACCESS_KEY_ID" S3_TEST_SECRET_ACCESS_KEY="$S3_TEST_SECRET_ACCESS_KEY" \
  S3_TEST_FORCE_PATH_STYLE="$S3_TEST_FORCE_PATH_STYLE" \
  BACKUP_MYSQL_BINARY="$BACKUP_MYSQL_BINARY" BACKUP_MYSQLDUMP_BINARY="$BACKUP_MYSQLDUMP_BINARY" \
  MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:mysql-backup-artifact-mysql-s3
# 0028真实mover使用普通S3_TEST_BUCKET，并同时连接可丢弃MySQL测试库。
env S3_TEST_ENDPOINT="$S3_TEST_ENDPOINT" S3_TEST_REGION="$S3_TEST_REGION" \
  S3_TEST_BUCKET="$S3_TEST_BUCKET" S3_TEST_ACCESS_KEY_ID="$S3_TEST_ACCESS_KEY_ID" \
  S3_TEST_SECRET_ACCESS_KEY="$S3_TEST_SECRET_ACCESS_KEY" S3_TEST_FORCE_PATH_STYLE="$S3_TEST_FORCE_PATH_STYLE" \
  MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" \
  pnpm test:blob-storage-migration-mysql-s3
env S3_TEST_ENDPOINT="$S3_TEST_ENDPOINT" S3_TEST_REGION="$S3_TEST_REGION" \
  S3_TEST_BUCKET="$S3_TEST_BUCKET" S3_TEST_ACCESS_KEY_ID="$S3_TEST_ACCESS_KEY_ID" \
  S3_TEST_SECRET_ACCESS_KEY="$S3_TEST_SECRET_ACCESS_KEY" S3_TEST_FORCE_PATH_STYLE="$S3_TEST_FORCE_PATH_STYLE" \
  MYSQL_APP_SMOKE_URL="mysql://root@127.0.0.1:3306/agent_service_test" \
  AGENT_SERVICE_APP_SMOKE_MODE=source pnpm test:app-s3-smoke
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:outbox-mysql
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:usage-lifecycle-mysql
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:subject-lifecycle-mysql
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:tenant-credential-revocation-mysql
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:tenant-credential-physical-revocation-mysql
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:tenant-credential-lifecycle-mysql
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:tenant-credential-target-execution-mysql
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:tenant-runtime-revocation-mysql
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:tenant-content-inventory-mysql
pnpm test:tenant-purge-plan-memory
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:tenant-purge-plan-mysql
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:tenant-purge-execution-mysql
pnpm test:tenant-database-purge-memory
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:tenant-database-purge-mysql
pnpm test:tenant-redis-purge-memory
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" REDIS_TEST_URL="redis://127.0.0.1:6379/1" \
  pnpm test:tenant-redis-purge-mysql
REDIS_TEST_URL="redis://127.0.0.1:6379/1" pnpm test:tenant-redis-purge-redis
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:retention-policy-mysql
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:erasure-purge-policy-mysql
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:erasure-job-mysql
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:erasure-session-mysql
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:erasure-catalog-mysql
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:erasure-usage-mysql
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:legacy-tombstone-mysql
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:user-data-export-mysql
AGENT_SERVICE_CLUSTER=1 CLUSTER_MYSQL_URL="mysql://root@127.0.0.1:3306/agent_service_cluster" CLUSTER_REDIS_URL="redis://127.0.0.1:6379/3" \
  pnpm vitest run test/cluster
CLUSTER_MYSQL_URL="mysql://root@127.0.0.1:3306/agent_service_cluster" CLUSTER_REDIS_URL="redis://127.0.0.1:6379/3" \
  pnpm test:tenant-redis-purge-cluster
pnpm build:check
pnpm check:restore-ledger-reconcile-artifact
```

`deploy/local/infra.sh reset-db` 会删除并重建 `agent_service`、`agent_service_test`，不会重建 `agent_service_cluster`；同时会对该 Redis 实例执行全局 `FLUSHALL`。它故意不删除MinIO bucket或objects，因此不是完整的S3环境重置：手工S3体验后若要从空状态重来，应使用新的可丢弃数据库和新的隔离`BLOB_S3_PREFIX`，不能把残留对象当作已由数据库证明可安全清理。它不是普通重启步骤。

## 4. 手动查看服务

从对外入口检查：

```bash
BASE=http://127.0.0.1:8080

curl -i "$BASE/healthz"
curl -i "$BASE/readyz"
curl -sS "$BASE/v1/capabilities" | python3 -m json.tool
curl -sS "$BASE/openapi.json" | python3 -m json.tool

# 预期 401；证明 wildcard API 请求确实经 router 到达 runner
curl -i "$BASE/v1/agents"
```

直接检查 runner：

```bash
curl -i http://127.0.0.1:8787/readyz
curl -sS http://127.0.0.1:8787/v1/capabilities | python3 -m json.tool
curl -sS http://127.0.0.1:8787/openapi.json | python3 -m json.tool
```

两端提供同一份 canonical OpenAPI 3.1 edge 契约，但 tenant erasure 的两个 platform 路径故意只在 router 公共入口注册；runner 只提供不进入 OpenAPI、受内部 token 保护的版本化私有路由，不得让 platform 客户端直连 8787。当前没有内置 Swagger/Scalar 页面，可把 `http://127.0.0.1:8080/openapi.json` 导入 Postman、Insomnia 或 Swagger Editor。

router 的 `/_router/targets` 会暴露内部 runner 地址和可选 session owner，因此默认返回 `404`。只有显式配置 `ROUTER_ADMIN_TOKEN`、重启服务并携带对应 bearer token 后才开放。

可选的L0指标也在各自现有端口：router `http://127.0.0.1:8080/metrics`、runner `http://127.0.0.1:8787/metrics`。默认`METRICS_ENABLED=0`返回`404`；在受保护的本地`.env`中单独设置`METRICS_BEARER_TOKEN`并显式开启后，`GET`返回Prometheus文本，`HEAD`可检查状态/头但无正文。只接受严格单空格的Bearer header；`401`代表凭据缺失/错误，已授权而方法不允许返回`405`。不要把该token当作service/admin/internal key，或把真实值放在命令行、终端历史、录屏、日志中。手动查看可先由操作者私下建立权限`0600`的curl config，内容格式为`header = "Authorization: Bearer <replace-privately>"`，随后运行：

```bash
curl --config /absolute/protected-metrics-curl.conf -i http://127.0.0.1:8080/metrics
curl --config /absolute/protected-metrics-curl.conf -I http://127.0.0.1:8787/metrics
```

本地共用`.env`时两role可用同一运维token；独立部署可分配不同token。预置但未开启时指标仍`404`，且非metrics请求不能把该受保护token用作业务凭据或转发。固定标签只标记component/method/route/status class，header-ready延迟不代表SSE全流或active turn；内存计数重启清零。生产采集网络/TLS、独立权限与容量未验收。

## 5. 手动体验 Agent Runtime

先做一条不调用模型的手动链路：在 `scripts/local-service.sh start` 后，经 router 创建 agent 和 session，再读取它们。这里的 `dev-key` 是默认本地bootstrap key；若已改动本机配置，使用对应的本地service key，勿在录屏或日志中展示。创建资源不会请求模型，只有提交 turn 才会调用 provider。

```bash
BASE=http://127.0.0.1:8080
H=(-H "Authorization: Bearer dev-key" -H "X-User-Id: u_42" -H "Content-Type: application/json")
AGENT_ID=$(curl -fsS -X POST "$BASE/v1/agents" "${H[@]}" \
  -d '{"name":"local-inspect","instructions":"本地手动检查","model":{"provider":"dashscope","model":"qwen3.8-max"},"tools":["current_time"],"limits":{"maxSteps":2}}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
SESSION_ID=$(curl -fsS -X POST "$BASE/v1/sessions" "${H[@]}" \
  -d "{\"agentId\":\"$AGENT_ID\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
curl -fsS "$BASE/v1/sessions/$SESSION_ID" "${H[@]}" | python3 -m json.tool
curl -fsS "$BASE/v1/sessions/$SESSION_ID/items" "${H[@]}" | python3 -m json.tool
```

接着可用下方 archive/unarchive 命令观察可逆生命周期；请沿用这组 `BASE`、`H` 和 `SESSION_ID`。不配置 `API_KEY` 也能完成上述资源读写；不要在无意支付模型费用时调用 turn、`demo.sh` 或 `acceptance`。

推荐通过统一入口运行十阶段流程：

```bash
scripts/local-service.sh acceptance
```

它固定经 router 调用，覆盖：鉴权、agent/session、SSE turn、消息历史、断线重放、幂等、跨轮上下文、安全阀、同 tenant 的 user 隔离、请求体限制与 BYOK。跨 tenant 隔离由自动测试覆盖。该命令使用真实模型，会产生少量费用。

若手动制造provider失败，新turn与`error` SSE/event现在返回固定`code=provider_error`和`message="Provider request failed."`；不会把厂商的429/rate文本、URL、响应正文或异常消息当作诊断信息回显。依赖旧message文字的客户端需改看错误码、turn状态及stopReason；历史已保存的旧错误消息不会因本次代码更改自动清除。

`scripts/demo.sh` 单独运行时默认直连 runner；若要显式经 router 运行：

```bash
BASE=http://127.0.0.1:8080 scripts/demo.sh
```

README 的 API 速览提供创建 agent、session 和 turn 的逐步 `curl` 示例，并默认把 `BASE` 指向 router 的 `8080`。

若没有沿用上面的同一终端，请按 README 的 API 速览用同一个开发 key 和 `X-User-Id: u_42` 创建 session，再把响应中的真实 `sess_...` 值填入 `SESSION_ID`；`acceptance` 创建的其它 owner session 不一定能用这组身份访问。下列请求都应经 router：

```bash
BASE=http://127.0.0.1:8080
SESSION_ID=sess_replace_with_created_id
H=(-H "Authorization: Bearer dev-key" -H "X-User-Id: u_42" -H "Content-Type: application/json")
curl -sS -X POST "$BASE/v1/sessions/$SESSION_ID/archive" "${H[@]}"
curl -sS "$BASE/v1/sessions?includeArchived=true" "${H[@]}"
# archived 期间创建 turn 应返回 409 session_archived，读取 session/items/events 仍可用
curl -sS -X POST "$BASE/v1/sessions/$SESSION_ID/unarchive" "${H[@]}"
```

archive active turn 会返回 `409 session_busy`；先 interrupt 并等待 turn 结算后再重试。archive 会清空 session 级工具授权并结算异常遗留审批，unarchive 不恢复旧授权。

### 输入图片 Blob

下面假设已经按 README 创建 agent/session，并把 session id 放入 `SESSION_ID`。上传本身不调用模型；支持的媒体类型是 `image/png`、`image/jpeg`、`image/webp` 和 `image/gif`，服务还会核对对应文件签名，因此示例文件类型、`Content-Type` 与 turn 中可选的 `mimeType` 必须一致。

把图片绑定进 turn 会调用模型，且所选 provider model 的 `input` 必须包含 `"image"`。仓库当前内置的文本模型 preset 都只声明 `"text"`；手动体验前需按实际厂商文档配置一个真实支持视觉输入的模型（不要仅把文本模型的声明改成 image）。没有视觉模型/key 时，上传与 staging 404 可手工体验，完整绑定链路则用不收费的 `blob-http.test.ts`/`host.test.ts` 验证。

```bash
IMAGE=/absolute/path/to/example.png
UPLOAD_JSON="$(curl -sS -X POST "$BASE/v1/sessions/$SESSION_ID/blobs" \
  -H "Authorization: Bearer dev-key" \
  -H "X-User-Id: u_42" \
  -H "Content-Type: image/png" \
  --data-binary "@$IMAGE")"
BLOB_ID="$(printf '%s' "$UPLOAD_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["blobId"])')"
printf 'staged blob: %s\n' "$BLOB_ID"

# staging 对象尚未绑定，故意不可读，预期 404
curl -i "$BASE/v1/sessions/$SESSION_ID/blobs/$BLOB_ID" \
  -H "Authorization: Bearer dev-key" -H "X-User-Id: u_42"

# 把 opaque blobId 放入 turn；非流式请求返回 202，随后仍会调用真实模型
curl -sS -X POST "$BASE/v1/sessions/$SESSION_ID/turns" "${H[@]}" \
  -d "{\"stream\":false,\"input\":[{\"type\":\"text\",\"text\":\"请描述图片\"},{\"type\":\"image\",\"blobId\":\"$BLOB_ID\",\"mimeType\":\"image/png\"}]}"

# turn 的 userMessage item 与 Blob 在同一存储 commit 中绑定后变为 ready
curl -sS -D /tmp/agent-service-blob.headers \
  "$BASE/v1/sessions/$SESSION_ID/blobs/$BLOB_ID" \
  -H "Authorization: Bearer dev-key" -H "X-User-Id: u_42" \
  -o /tmp/agent-service-downloaded.png
```

持久化 item 只保存 `blobId`，不会保存 filesystem path、bucket/key 或 data URL；runner 读取时核对 owner、purpose、item 绑定、大小、SHA-256 和媒体类型，再只在内存中为模型生成 data URL。同一 id 被另一个 tenant/user/session 请求时与不存在一样返回 404。上传后一直未绑定的 staging 对象在 `BLOB_STAGING_TTL_MS` 到期后会被专用 worker 改为 `delete_pending`，经 claim lease/outbox 执行幂等物理删除；它在整个过程中都不能由读 API 取回。

### 大工具输出

当可序列化工具输出达到或超过 `BLOB_TOOL_OUTPUT_THRESHOLD_BYTES` 且不超过 `BLOB_MAX_BYTES` 时，runner 自动把完整 `{content, details}` 卸载到 Blob，在 `toolResult` item 中留下有界提示和 opaque `outputRef`。先列出 items 找到对应 `itemId`，再经精确 owner/item 路径取回原始 JSON：

```bash
curl -sS "$BASE/v1/sessions/$SESSION_ID/items" "${H[@]}" | python3 -m json.tool
ITEM_ID=item_...
curl -sS "$BASE/v1/sessions/$SESSION_ID/items/$ITEM_ID/output" "${H[@]}" | python3 -m json.tool
```

输出不可序列化、超过 Blob 上限或 Blob 持久化失败时，item 与当前模型 step 都会看到同一个稳定且不含内部 locator 的明确失败结果，不会出现“本轮成功、重放失败”的分叉。合法外置结果的当前 step 仍看到完整 JSON-safe payload；后续历史按新到旧分配 `BLOB_MAX_HYDRATED_BYTES`，超预算旧工具输出保留 durable marker，旧图片变为明确文字占位，从而避免长 session 因累计 Blob 永久不可运行。当前 compaction 只保证外置工具事实不会被跳过；历史图片以占位文字参与摘要，像素不会跨 compaction 保留，长会话若依赖视觉事实应先把事实转成文本，直到后续实现视觉摘要/OCR。其 session erasure/物理 purge 仍未开启。

要体验 DELETE，请另建一个可丢弃的 idle session；该操作对普通 API 不可逆：

```bash
DELETE_SESSION_ID=sess_...
curl -i -X DELETE "$BASE/v1/sessions/$DELETE_SESSION_ID" "${H[@]}"
curl -i "$BASE/v1/sessions/$DELETE_SESSION_ID" "${H[@]}"  # 预期 404
curl -i -X DELETE "$BASE/v1/sessions/$DELETE_SESSION_ID" "${H[@]}"  # 同 owner 重试仍为 204
```

DELETE 经同一队列、lease/fence 原子写入 terminal `session/deleted`、单调 generation 和 durable cleanup intents；active session 返回 `409 session_busy`，存在任何未删除 child 的 parent 返回 `409 session_has_children`。runner 内置 dispatcher 会用 claim lease 和有上限退避可靠重投 `session.tombstoned` 对应的 durable event；短暂故障持续重试，确定损坏的 intent 才 dead-letter。投递是 at-least-once，相同 event `seq` 可能出现多次并由订阅路径去重。当前 `purge_after_ms = NULL`、purge intent 不可领取，dispatcher 也不会处理它，因此 `404` 表示普通 API 已隐藏，并不表示磁盘或数据库内容已物理清除。

外部客户端只能调用公开 DELETE；router 会在 gate/fleet 校验后将其改写为 runner 的版本化内部 POST，剥离任何客户端伪造的内部 header，并注入与 runner 一致的 `INTERNAL_ROUTER_TOKEN`。该内部路径不进入 OpenAPI/SDK，直接经 router 调用返回 404；production runner 端口还必须由网络策略限制为 router/运维平面可达。

当前 `scripts/demo.sh approval` 不会完成一条人工审批交互；审批状态机由自动测试覆盖。后续若增加交互式审批 demo，应在此处补充。

### Canonical retention policy 与多 legal hold（显式开启后）

`0015` 已实现 tenant 级 immutable policy version、generation-CAS 激活、tenant/user 两级多 legal hold、逐 hold release、append-only audit 和 legacy hold 导入；它没有实现或授权 purge。管理面由 router 与 runner 两端的 `DATA_GOVERNANCE_MANAGEMENT_ENABLED` 独立控制，默认都是 `0`。本地统一脚本可为两端同时显式开启：

```bash
DATA_GOVERNANCE_MANAGEMENT_ENABLED=1 scripts/local-service.sh restart
curl -sS http://127.0.0.1:8080/v1/capabilities | python3 -m json.tool
```

capability 故意拆成两层：`features.dataGovernance` 表示所有 configured runner 的 writer/store 都理解 `canonical-retention-v1` 与 `multi-legal-hold-v1`；`features.dataGovernanceManagement` 才表示 router gate 和全部目标的管理端点都已开启。前者是 erasure admission 的代码安全条件，后者是管理 API 的运维开关；关闭管理面不能让 writer 假装不认识已经激活的 policy 或 hold。任一 configured runner 未探测成功、缺少两项 code-aware capability 或未开启管理端点时，router 对下列 API fail closed 为 `503`。

只在全新、可丢弃的本地 tenant 和测试数据库上运行下面示例。policy version 与审计记录不可变，激活也没有“撤销为未配置”接口；即使 legal hold 可以 release，其历史证据仍会保留。不要对含重要数据的 tenant 试验，也不要把 admin key 写入命令历史、文档或日志。以下 8 个操作覆盖当前全部 policy/hold admin API；示例中的 generation 只适用于尚未操作过的 subject，实际操作必须使用上一步响应中的最新 `controlGeneration`：

```bash
(
BASE=http://127.0.0.1:8080
umask 077
set +x
printf 'Disposable local tenant admin key: '
IFS= read -r -s ADMIN_KEY
printf '\n'
CURL_CONFIG="$(mktemp "${TMPDIR:-/tmp}/agent-service-curl.XXXXXX")"
printf 'header = "Authorization: Bearer %s"\n' "$ADMIN_KEY" > "$CURL_CONFIG"
unset ADMIN_KEY
trap 'rm -f "${CURL_CONFIG:-}"' EXIT
GH=(--config "$CURL_CONFIG" -H "Content-Type: application/json")

# 1/8 注册 immutable policy version；仅给本地导出制品一小时 TTL，其余 null 仍 fail closed
curl -sS -X PUT "$BASE/v1/retention-policies/local-safe-v1" "${GH[@]}" \
  -d '{"policy":{"sessionContentRetentionMs":null,"userErasureGraceMs":null,"operationalUsageRetentionMs":null,"idempotencyReceiptRetentionMs":null,"billingFactRetentionMs":null,"lifecycleAuditRetentionMs":null,"exportArtifactTtlMs":3600000}}' \
  | python3 -m json.tool

# 2/8 立即激活；全新 tenant 的 policy control generation 是 0
curl -sS -X POST "$BASE/v1/retention-policies/local-safe-v1/activate" "${GH[@]}" \
  -d '{"expectedControlGeneration":0}' | python3 -m json.tool

# 3/8 读取当前 active policy 和 control
curl -sS "$BASE/v1/retention-policies/active" "${GH[@]}" | python3 -m json.tool

# 4/8 按 version 读取 immutable policy
curl -sS "$BASE/v1/retention-policies/local-safe-v1" "${GH[@]}" | python3 -m json.tool

# 5/8 为一个可丢弃 user 设置 hold；该 subject 的初始 hold generation 是 0
curl -sS -X POST "$BASE/v1/legal-holds" "${GH[@]}" \
  -d '{"holdId":"hold_local-demo","subjectKind":"user","subjectId":"u_governance_demo","reasonCode":"litigation","expectedControlGeneration":0}' \
  | python3 -m json.tool

# 6/8 列出该 subject 的全部 active holds 和最新 control
curl -sS "$BASE/v1/legal-holds?subjectKind=user&subjectId=u_governance_demo" "${GH[@]}" \
  | python3 -m json.tool

# 7/8 按 hold id 读取 active/released record
curl -sS "$BASE/v1/legal-holds/hold_local-demo" "${GH[@]}" | python3 -m json.tool

# 8/8 只释放这一条 hold；其它 active hold 仍继续生效
curl -sS -X POST "$BASE/v1/legal-holds/hold_local-demo/release" "${GH[@]}" \
  -d '{"expectedControlGeneration":1,"reasonCode":"matter_closed"}' \
  | python3 -m json.tool

rm -f "$CURL_CONFIG"
trap - EXIT
unset CURL_CONFIG GH
)
```

policy 激活在 activate 事务的线性化点立即生效：之后新建的 erasure/export request 必须绑定当时 active policy 的精确 version/hash；激活前已有的 backlog 不会被静默改绑。当前 API 没有未来 `effectiveAt` 参数，不支持定时激活；要切换策略，应先注册新 version，再用当前 generation 执行一次即时 CAS 激活。policy 中只有正值 `exportArtifactTtlMs` 会授权显式请求产生临时导出制品；其它duration只是后续执行边界的authority，激活本身不会删除、匿名化或自动导出数据，T3e也会在自己的事务内重新验证policy/hold。

体验结束后可关闭管理 API，但这不会回滚任何 durable policy/hold 状态：

```bash
DATA_GOVERNANCE_MANAGEMENT_ENABLED=0 scripts/local-service.sh restart
```

### User data export 制品（显式开启后）

`0017` 已实现 user-scoped 异步导出。POST 只负责原子建立request/job；runner内嵌worker从同一个MySQL `REPEATABLE READ WITH CONSISTENT SNAPSHOT`复制白名单数据，再在事务外生成确定性的`ndjson-v1`分片。只有所有分片、manifest和整体SHA-256都验证成功后，状态才变成`ready`；部分制品永远不能下载。内容包含该user的session、turn、item、event、approval、operational usage和附件字节（附件按base64 chunk表示），不含provider/API secret、idempotency material、内部claim/fence或物理Blob locator。

先按上一节为可丢弃tenant激活一个`exportArtifactTtlMs > 0`的policy，再开启两端admission；build/cleanup worker本地默认已开，此处仍显式写出，便于看清依赖关系：

```bash
DATA_EXPORT_WORKER_ENABLED=1 \
  DATA_EXPORT_CLEANUP_ENABLED=1 \
  DATA_EXPORT_REQUESTS_ENABLED=1 \
  scripts/local-service.sh restart
BASE=http://127.0.0.1:8080
curl -sS "$BASE/v1/capabilities" | python3 -m json.tool
```

预期`features.userDataExport=["artifact-ndjson-v1"]`且`features.dataExportRequests=true`。以下命令不调用模型；`EXPORT_USER`可以是已有少量测试session的可丢弃user。admin key以隐藏输入写入权限为0600的临时curl配置，避免出现在curl进程参数中，并在示例结束或shell退出时删除；不要开启shell trace，也不要把key写入日志或文档：

```bash
(
BASE=http://127.0.0.1:8080
umask 077
set +x
printf 'Disposable local tenant admin key: '
IFS= read -r -s ADMIN_KEY
printf '\n'
CURL_CONFIG="$(mktemp "${TMPDIR:-/tmp}/agent-service-export-curl.XXXXXX")"
printf 'header = "Authorization: Bearer %s"\n' "$ADMIN_KEY" > "$CURL_CONFIG"
unset ADMIN_KEY
EXPORT_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-service-export.XXXXXX")"
trap 'rm -f "${CURL_CONFIG:-}"; rm -rf "${EXPORT_TMP_DIR:-}"' EXIT
EXPORT_USER=u_export_demo

EXPORT_JSON="$(curl -sS -X POST "$BASE/v1/data-export-requests" \
  --config "$CURL_CONFIG" \
  -H "X-User-Id: $EXPORT_USER" \
  -H "Idempotency-Key: export-local-demo-1")"
printf '%s' "$EXPORT_JSON" | python3 -m json.tool
EXPORT_ID="$(printf '%s' "$EXPORT_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"

# 最多轮询30秒；通常依次看到queued/building/ready，terminal失败立即停止
attempt=1
EXPORT_STATUS=
while [ "$attempt" -le 30 ]; do
  STATUS_JSON="$(curl -sS "$BASE/v1/data-export-requests/$EXPORT_ID" \
    --config "$CURL_CONFIG" \
    -H "X-User-Id: $EXPORT_USER")"
  printf '%s' "$STATUS_JSON" | python3 -m json.tool
  EXPORT_STATUS="$(printf '%s' "$STATUS_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')"
  case "$EXPORT_STATUS" in
    ready) break ;;
    failed|expired|revoked) printf 'export stopped: %s\n' "$EXPORT_STATUS" >&2; exit 1 ;;
  esac
  attempt=$((attempt + 1))
  sleep 1
done
[ "$EXPORT_STATUS" = ready ] || { printf 'export did not become ready in 30s\n' >&2; exit 1; }

# 仅ready可下载；服务会逐分片及整体复核digest，并在传输期间续租
EXPORT_FILE="$EXPORT_TMP_DIR/$EXPORT_ID.ndjson"
curl --fail --show-error "$BASE/v1/data-export-requests/$EXPORT_ID/download" \
  --config "$CURL_CONFIG" \
  -H "X-User-Id: $EXPORT_USER" \
  -o "$EXPORT_FILE"
wc -c "$EXPORT_FILE"
python3 -c 'import json,sys; [json.loads(line) for line in open(sys.argv[1], encoding="utf-8")]; print("valid ndjson")' "$EXPORT_FILE"

rm -f "$CURL_CONFIG"
rm -rf "$EXPORT_TMP_DIR"
trap - EXIT
unset CURL_CONFIG EXPORT_TMP_DIR EXPORT_FILE EXPORT_JSON STATUS_JSON EXPORT_STATUS attempt
)
```

同一个tenant/user/key重放返回同一request；同key异义冲突，跨user/tenant status或download与不存在一样返回404。普通TTL会等待活动download lease；subject进入erasure时则撤销导出、阻止新下载并把精确artifact identity交给独立delete outbox。体验结束可只关闭新admission，已有job与cleanup仍继续forward-fix：

```bash
DATA_EXPORT_REQUESTS_ENABLED=0 scripts/local-service.sh restart
```

filesystem export制品只适合本地单runner，production会在request/build/cleanup任一export flag开启时拒绝启动。S3模式可复用`0027`共享namespace、create-only发布与同key CAS tombstone；安全契约不依赖S3-compatible实现普遍不支持的`DeleteObject If-Match`。在多VM/Pod开放前必须先完成空库activation或`0028`离线cutover，并在真实staging对象存储上验证跨runner snapshot、下载lease、TTL/撤销及cleanup；NFS或各Pod本地卷仍不受支持。

### User erasure 到安全策略边界（显式开启后）

公开能力只接受 admin service key 为一个明确 user 发起请求。务必使用全新的可丢弃 user：request 线性化后立即隐藏普通资源并永久阻止该 subject 的 durable write，没有公开撤销接口。内嵌 worker随后会有界中断 active turn、处理 parent/child、核对 usage，并停在 `awaiting_purge_policy`。该状态仍保留数据库内容、operational usage、receipt、ready Blob 和不可领取 purge intent，不是 completed。关闭 feature gate或 worker都不会恢复 subject；本地恢复只能重建测试数据。物理 purge/completion闭环前不得在 staging/production 开启 admission。

```bash
ERASURE_USER=u_erasure_demo
ERASURE_JSON="$(curl -sS -X POST "$BASE/v1/data-erasure-requests" \
  -H "Authorization: Bearer dev-key" \
  -H "X-User-Id: $ERASURE_USER" \
  -H "Idempotency-Key: erasure-demo-1")"
printf '%s' "$ERASURE_JSON" | python3 -m json.tool
ERASURE_ID="$(printf '%s' "$ERASURE_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"

# 相同 tenant/user 才能读取；轮询直到 awaiting_purge_policy，绝不能是 completed
curl -sS "$BASE/v1/data-erasure-requests/$ERASURE_ID" \
  -H "Authorization: Bearer dev-key" \
  -H "X-User-Id: $ERASURE_USER" | python3 -m json.tool
```

同一个 subject/key 重放返回同一 request；同 key 可被另一个 user 独立使用。runtime-only key 得到 `403`，缺 user/key 得到 `400`，跨 owner查询与不存在一样 `404`。worker状态通常依次为 `gated → draining → tombstoning → reconciling_usage → awaiting_purge_policy`，快速本地运行可能看不到每个瞬时中间态。active turn会在 claim+fence 验证后才被 abort；如果 provider/tool不响应，worker等待 lease自然到期再重试，避免重叠 owner。若 gate 与 Blob put竞态，ready发布被拒绝，staging orphan由 TTL cleanup回收。

generation `0` compensation 没有公开 API，也不应通过手工 SQL 在业务库伪造 legacy row 来体验。本地统一脚本会显式启动 compensation worker；如果数据库确有升级前留下的合法 generation `0` tombstone，它会在 v2 barrier 放行并激活 cutover后建立 durable job。成功事务保留原 `deletedAt`，把残留 active turn/approval固定结算到该历史时刻，写入 generation `1` terminal `session/deleted`、`session.tombstoned` 和不可领取的 `session.purge` intent、append-only compensation audit并完成 job。`purge_after_ms` 仍是 `NULL`，内容不会被删除。日常验证请使用 `pnpm test:legacy-tombstone-mysql`；该 named no-skip 套件使用真实 InnoDB 覆盖并发 claim/ABA、失败整事务回滚和幂等重试。

### Tenant erasure T2/T3a/T3b/T3c/T3d/T3e/T3f/T3g、0026/0029/0030/0031/0032/0033/0034/0035 边界（只对可丢弃 tenant 体验）

T2 已提供 router-only `POST /v1/tenant-erasure-requests` 和 `GET /v1/tenant-erasure-requests/{requestId}`，使用与 tenant API key/admin key 完全独立的 platform bearer。POST 会原子写入admission、tenant lifecycle gate、首条audit、credential fence和T3a job；T3a清除本地DB credential material，`0026`把删除前的coverage/slot/version/external-KMS target inventory以无敏感值sidecar绑定同一事务，T3b fence configured fleet，T3c建立DB-time owner清单，T3d把33域封存为不可执行plan。T3e同样没有公开API：runner内嵌worker在fresh all-configured barrier后，只原子去身份化operational usage、撤销export/释放snapshot pin、为Blob/export bytes写exact outbox，并在原cleanup worker真正完成这些outbox后seal physical ACK。T3f再从terminal T3e receipt建独立queue，在一个事务内清理固定11个本地数据库投影、保留匿名billing facts并写永久session grave。T3g最后从T3f grave及T3d Redis plan建立精确target，用真实Redis Lua删除lease/owner、fence与stream并写永久防复活marker。受信任的新provider写入可以为0026 external target建立受保护reference，`0029`据此提供default-dormant执行/ACK协议；但当前只有Memory fake，标准MySQL栈不启用，真实provider/KMS仍未执行。`0027`只证明Blob/export共享namespace和物理对象协议，`0028`只证明停服搬迁及pointer/control cutover，两者都不授予全域删除authority；`0030`为T1 fence提供独立journal、runtime lineage与恢复replay，`0031`再为恢复建立权威backup catalog、source binding和永久epoch reservation；`0032`安装安全telemetry入口与dormant logs/traces inventory，`0033`补原子activation receipt、canonical tenant coverage和immutable artifact inventory，`0034`补payload-before-sink spool、reservation、writer ACK/inventory基座并接入默认关闭的runner filesystem/S3 writer，`0035`增加分域producer capture；当前仅单一provider failure logs contract，没有0035 v1 activation入口、traces producer、delete/CAS tombstone、external deletion journal或restore/retention。T3e/T3f/T3g及0029也始终固定`allDomainsComplete=false`、`contentPurgeExecuted=false`，0029还固定`kmsKeyExecutionComplete=false`。0031不创建物理backup，0032～0035也不证明backup内tenant erasure、logs/traces delete/restore、managed对象存储/IAM验收或全域completion。所有这些gate和已提交操作都不可当作可逆功能；`status=gated`不是`completed`。普通本地`start`保持writer/capture gate关闭，不会产生sink写入。

**只能在可丢弃的本地数据库和tenant上执行以下步骤。** 最简单的做法是先停服务，在 `.env` 中把 `BOOTSTRAP_TENANT_ID` 改成专用演示 ID（例如 `t_tenant_erasure_demo`），确认现有本地数据可删除后再运行 `deploy/local/infra.sh reset-db`。该命令会重建本地业务/测试库并对本地 Redis 执行 `FLUSHALL`，不得对需保留的数据使用。若只体验T2逻辑fence，保持T3a～T3g execution/worker/endpoint开关为`0`；若要体验T3a～T3d，必须先确认tenant可丢弃，且 `.env` 中的`RUNNER_ID=runner-local-1`为显式稳定值、`RUNNERS`直连该单runner。先保持T3e/T3f/T3g六道gate为`0`完成并检查T3d plan；T3e会真实匿名化/撤销/调度删除，T3f会真实删除本地数据库投影，T3g会真实修改Redis并留下永久marker，只能按后文分阶段开启。多runner不能照抄这些本地命令。

```bash
CREDENTIAL_LIFECYCLE_TRACKING_ENABLED=1 \
TENANT_ERASURE_REQUESTS_ENABLED=0 \
  TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED=0 \
  TENANT_CREDENTIAL_REVOCATION_EXECUTION_ENABLED=0 \
  TENANT_RUNTIME_DRAIN_ENABLED=0 \
  TENANT_RUNTIME_REVOCATION_WORKER_ENABLED=0 \
  TENANT_RUNTIME_DRAIN_EXECUTION_ENABLED=0 \
  TENANT_CONTENT_INVENTORY_WORKER_ENABLED=0 \
  TENANT_PURGE_PLAN_WORKER_ENABLED=0 \
  TENANT_PURGE_EXECUTION_WORKER_ENABLED=0 \
  TENANT_PURGE_EXECUTION_ENABLED=0 \
  TENANT_DATABASE_PURGE_WORKER_ENABLED=0 \
  TENANT_DATABASE_PURGE_ENABLED=0 \
  TENANT_REDIS_PURGE_WORKER_ENABLED=0 \
  TENANT_REDIS_PURGE_ENABLED=0 \
  scripts/local-service.sh start
CREDENTIAL_LIFECYCLE_TRACKING_ENABLED=1 \
TENANT_ERASURE_REQUESTS_ENABLED=1 \
  TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED=1 \
  TENANT_CREDENTIAL_REVOCATION_EXECUTION_ENABLED=1 \
  TENANT_RUNTIME_DRAIN_ENABLED=1 \
  TENANT_RUNTIME_REVOCATION_WORKER_ENABLED=1 \
  TENANT_RUNTIME_DRAIN_EXECUTION_ENABLED=1 \
  TENANT_CONTENT_INVENTORY_WORKER_ENABLED=1 \
  TENANT_PURGE_PLAN_WORKER_ENABLED=1 \
  TENANT_PURGE_EXECUTION_WORKER_ENABLED=0 \
  TENANT_PURGE_EXECUTION_ENABLED=0 \
  TENANT_DATABASE_PURGE_WORKER_ENABLED=0 \
  TENANT_DATABASE_PURGE_ENABLED=0 \
  TENANT_REDIS_PURGE_WORKER_ENABLED=0 \
  TENANT_REDIS_PURGE_ENABLED=0 \
  scripts/local-service.sh restart
curl -sS http://127.0.0.1:8080/v1/capabilities | python3 -m json.tool
curl -sS http://127.0.0.1:8787/v1/capabilities | python3 -m json.tool
```

预期 router capability 中 `tenantErasureRequests=true`、`tenantErasureControl=["platform-control-v1"]`、`tenantCredentialRevocation=["credential-store-v1"]`、`tenantCredentialLifecycle=["versioned-target-ledger-v1"]`、`tenantCredentialLifecycleTrackingActive=true`且`tenantCredentialRevocationWorker=true`。最后一个布尔值只表示T3a execution barrier当前可用；versioned ledger也只说明inventory可追踪，不代表external/KMS、content purge或completion。T3b的rollout/boot identity故意不从router公开capability泄露；直接看runner时应见`tenantRuntimeDrain=["runtime-drain-v1"]`和`tenantRuntimeDrainEndpoint=true`，但不会看到私有`bootId`。下面用临时权限为 `0600` 的 curl config 传递 platform token，避免密钥进入命令历史或打印到终端；在 zsh 中执行，并从本机 `.env` 查看后手工粘贴密钥：

```zsh
BASE=http://127.0.0.1:8080
TENANT_ID=t_tenant_erasure_demo
CURL_CONFIG="$(mktemp)"
chmod 600 "$CURL_CONFIG"
trap 'rm -f "$CURL_CONFIG"' EXIT

read -r -s "PLATFORM_TOKEN?Platform operator token: "
printf '\n'
printf 'header = "Authorization: Bearer %s"\n' "$PLATFORM_TOKEN" > "$CURL_CONFIG"
unset PLATFORM_TOKEN

RESPONSE="$(curl -fsS --config "$CURL_CONFIG" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: tenant-erasure-demo-1' \
  --data "{\"tenantId\":\"$TENANT_ID\"}" \
  "$BASE/v1/tenant-erasure-requests")"
printf '%s\n' "$RESPONSE" | python3 -m json.tool
REQUEST_ID="$(printf '%s' "$RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"

curl -fsS --config "$CURL_CONFIG" \
  "$BASE/v1/tenant-erasure-requests/$REQUEST_ID?tenantId=$TENANT_ID" \
  | python3 -m json.tool
```

对同一 tenant 使用相同 idempotency key/body 重放 POST 应返回同一 request。idempotency key 按 tenant 隔离；另一个已注册、同样可丢弃的 tenant 可独立使用同 key，但手工体验不要借此封禁额外 tenant。对上述专用 bootstrap tenant，原 service key 再访问 `/v1/agents` 应得到 `401`。不要调用 runner 的私有路由或向 runner 传 platform token；直接访问 8787 的公开 tenant-erasure 路径不会被注册。

`0026`没有新的公开API。可用下面只读取状态、计数、material-presence布尔值和disposition的查询观察tracking；它不会输出provider id、config、header、URL、cipher或key id。由迁移前已有tenant激活时，`history_status`应为`legacy_history_unknown`；cutover后通过正常API创建的新tenant才是`complete_since_creation`。每个version必须恰有`external_credential`和`kms_key`两条target，当前本地adapter通常显示blocker而不是`executable_ref`：

```bash
mysql -h 127.0.0.1 -uroot agent_service -e '
  SELECT control_generation,activated_at_db_ms,subject_count,provider_slot_count,
         auth_slot_count,version_count,target_disposition_count
    FROM tenant_credential_tracking_cutover WHERE singleton_id=1;
  SELECT history_status,origin,tracking_started_at_db_ms
    FROM tenant_credential_tracking_subjects
   WHERE tenant_id="t_tenant_erasure_demo";
  SELECT slot_kind,origin,encrypted_secret_present,secret_key_id_present,
         custom_headers_present,endpoint_parameters_present,
         created_at_db_ms,retired_at_db_ms,retire_reason
    FROM tenant_credential_versions
   WHERE tenant_id="t_tenant_erasure_demo" ORDER BY created_at_db_ms;
  SELECT domain,disposition,captured_at_db_ms
    FROM tenant_credential_target_dispositions
   WHERE tenant_id="t_tenant_erasure_demo" ORDER BY credential_version_id,domain;'
```

T3a与T3b worker是异步的；反复执行下面的只读查询，直到T3b job为`configured_fleet_quiesced`、target和aggregate receipt各有一行。这些表只是内部proof，不是公开API；不要手工改表来“完成”任务：

```bash
mysql -h 127.0.0.1 -uroot agent_service -e '
  SELECT request_id,phase,attempts,configured_fleet_quiesced_at_ms
    FROM tenant_runtime_revocation_jobs ORDER BY updated_at_ms DESC LIMIT 5;
  SELECT request_id,target_sha256,cache_entry_count_before,cache_entry_count_after,
         active_operation_count_before,active_operation_count_after,
         active_turn_count_before,active_turn_count_after
    FROM tenant_runtime_revocation_target_receipts ORDER BY request_id,target_sha256;
  SELECT request_id,target_count,memory_disposition,external_disposition,content_purge_required
    FROM tenant_runtime_revocation_receipts ORDER BY store_db_timestamp_ms DESC LIMIT 5;
  SELECT request_id,scope,provider_slot_count,auth_slot_count,version_count,
         target_disposition_count,external_credential_blocker_count,kms_key_blocker_count,
         legacy_history_unknown_subject_count,provider_source_count_before,
         auth_secret_present_before,store_db_timestamp_ms
    FROM tenant_credential_inventory_receipts
   WHERE tenant_id="t_tenant_erasure_demo";'
```

aggregate receipt应显示`memory_disposition=references_dropped_not_zeroized`、`external_disposition=not_supported`、`content_purge_required=1`。它与T3a的`runtimeDisposition=not_in_scope`不冲突：前者是`0020`独立切片的configured-fleet proof，后者仍是不可改写的`0019` credential-only receipt。`tenant_credential_inventory_receipts`应与同一T3a terminal时间原子出现，`target_disposition_count=version_count*2`；blocker count大于零是当前adapter的正确结果，不应手工改成已执行。target内的runner completion wall clock只是诊断字段；durable terminal时间由MySQL事务记录。

若T1 admission绑定的immutable policy给出了非`null`的`sessionContentRetentionMs`，T3c随后会建立job；deadline未到或任一tenant/user canonical hold仍active时保持可重试，不会伪造完成。要实际体验T3c，必须在发起tenant admission之前激活这样的immutable policy；前文的`local-safe-v1`示例把该字段设为`null`，照抄只会安全停在无T3c job状态。轮询以下只读字段，直到`phase=inventory_sealed`。查询刻意不输出正文、user id、claim token或storage locator：

```bash
mysql -h 127.0.0.1 -uroot agent_service -e '
  SELECT request_id,phase,build_generation,retention_anchor_db_ms,
         content_not_before_db_ms,session_receipt_count,sealed_at_ms,
         last_error_code,blocked_reason_code
    FROM tenant_content_inventory_jobs ORDER BY updated_at_ms DESC LIMIT 5;
  SELECT request_id,build_generation,session_id,turn_count,item_count,event_count,
         approval_count,content_record_count,captured_at_db_ms
    FROM session_content_receipts ORDER BY request_id,build_generation,session_id;
  SELECT request_id,session_receipt_count,content_record_count,hold_control_count,
         global_orphan_check,content_inventory_complete,content_purge_executed
    FROM tenant_content_inventory_receipts ORDER BY store_db_timestamp_ms DESC LIMIT 5;'
```

sealed aggregate必须显示`global_orphan_check=passed`、`content_inventory_complete=1`、`content_purge_executed=0`。anchor不早于T3a/T3b两个DB proof时间的最大值；roots绑定identity、状态和关系拓扑。`contextCompaction`是唯一允许synthetic turn的item，approval canonical边是`approvalRequest.approvalId → Approval.id`，legacy `Approval.itemId`只作为历史hash字段兼容。page/seal在receipt INSERT后仍会重验DB time和live lease，跨lease等待会连同receipt/cursor/aggregate/job transition整体回滚。它是某个可信数据库时间点的结构完整性证据，不是删除许可；T3e/T3f/T3g会在各自本地受限动作边界重新验证它。即使三个后续切片、`0027`共享对象协议、`0028`搬迁证据、`0030` T1 restore journal、`0031` backup catalog与`0032`～`0035` dormant telemetry lifecycle/inventory/writer/application-capture及S3 writer target都完成，完整全域executor仍要补齐external/KMS、backup内tenant erasure及其它domain恢复证据、除当前单一`provider.upstream_request_failed` logs contract外的完整application capture、traces producer、telemetry delete/restore/retention与真实managed环境验收，以及其它completion ACK。

T3c terminal后，T3d会自动建立`0022` plan。轮询下面不含正文、user id、credential、locator或claim token的字段，直到`phase=plan_sealed`：

```bash
mysql -h 127.0.0.1 -uroot agent_service -e '
  SELECT request_id,phase,build_generation,purge_not_before_db_ms,
         plan_entry_count,blocker_count,sealed_at_ms,last_error_code,blocked_reason_code
    FROM tenant_purge_plan_jobs ORDER BY updated_at_ms DESC LIMIT 5;
  SELECT domain,target_count,disposition,captured_at_db_ms
    FROM tenant_purge_plan_entries ORDER BY request_id,build_generation,domain;
  SELECT request_id,plan_entry_count,blocker_count,plan_complete,
         execution_ready,content_purge_executed
    FROM tenant_purge_plan_receipts ORDER BY store_db_timestamp_ms DESC LIMIT 5;'
```

sealed aggregate必须显示`plan_entry_count=33`、`plan_complete=1`、`execution_ready=0`、`content_purge_executed=0`。历史pre-0026 fixture仍可观察到原9/10/11粗粒度blocker分支；新tenant则按0026精确target disposition区分真实external `executable_ref`与legacy/source blocker，KMS仍全部阻断。blocker不妨碍目录seal，恰好说明该plan不能执行；不要手工改成`not_applicable`或把33域缩成当前有adapter的子集。

#### T3e 本地受限执行/physical ACK（默认不启用）

只有在上述T3d plan已经sealed、tenant与整个本地数据库均可丢弃，而且确认`BLOB_DIR`只由这一个runner使用时，才继续。T3e会发生真实不可逆写入：删除operational attribution、撤销export并清除download lease、释放snapshot pin，并调度Blob/export bytes删除；不是只读演示。先只开runner worker、保持router gate关闭，以验证code-aware/worker状态而不授权queue或action：

```bash
BLOB_FILESYSTEM_SINGLE_RUNNER=1 \
  BLOB_CLEANUP_ENABLED=1 \
  DATA_EXPORT_CLEANUP_ENABLED=1 \
  TENANT_PURGE_EXECUTION_WORKER_ENABLED=1 \
  TENANT_PURGE_EXECUTION_ENABLED=0 \
  scripts/local-service.sh restart

curl -sS http://127.0.0.1:8787/v1/capabilities | python3 -m json.tool
curl -sS http://127.0.0.1:8080/v1/capabilities | python3 -m json.tool
```

runner应显示`tenantPurgeExecution=["local-execution-ack-v1"]`与`tenantPurgeExecutionWorker=true`；router的worker布尔值仍应为false，因为execution gate关闭。确认只有这个configured runner后，再显式开启router gate：

```bash
BLOB_FILESYSTEM_SINGLE_RUNNER=1 \
  BLOB_CLEANUP_ENABLED=1 \
  DATA_EXPORT_CLEANUP_ENABLED=1 \
  TENANT_PURGE_EXECUTION_WORKER_ENABLED=1 \
  TENANT_PURGE_EXECUTION_ENABLED=1 \
  scripts/local-service.sh restart
```

worker会在materialize、claim、lease续期、local cutover和physical seal前分别取得fresh non-sticky all-configured ACK。下面的只读查询不输出正文、user id、locator或claim token；轮询直到job为`local_physical_acks_sealed`，若exact outbox尚未完成则会暂时保持`queued/physical_ack_pending`：

```bash
mysql -h 127.0.0.1 -uroot agent_service -e '
  SELECT request_id,phase,execution_generation,domain_count,domain_ack_count,
         unresolved_blocker_count,last_error_code,blocked_reason_code
    FROM tenant_purge_execution_jobs ORDER BY updated_at_ms DESC LIMIT 5;
  SELECT domain,phase,ack_count,plan_target_count,plan_disposition
    FROM tenant_purge_execution_domains
   ORDER BY request_id,execution_generation,execution_ordinal;
  SELECT request_id,operational_usage_target_count,blob_delete_outbox_count,
         export_delete_outbox_count,local_destructive_progress,
         physical_acks_complete,all_domains_complete,content_purge_executed
    FROM tenant_purge_local_cutover_receipts
   ORDER BY store_db_timestamp_ms DESC LIMIT 5;
  SELECT request_id,blob_physical_ack_count,export_physical_ack_count,
         unresolved_blocker_count,local_physical_acks_complete,
         all_domains_complete,content_purge_executed
    FROM tenant_purge_local_physical_ack_receipts
   ORDER BY store_db_timestamp_ms DESC LIMIT 5;'
```

cutover receipt必须是`local_destructive_progress=1`、`physical_acks_complete=0`、`all_domains_complete=0`、`content_purge_executed=0`；terminal local receipt必须是`local_physical_acks_complete=1`，但后两个全域标志仍为`0`。存在scheduled outbox时，physical ACK数量必须与实际completed identity匹配；dead-letter会把job置为`blocked/physical_ack_dead_lettered`，绝不能手工补ACK。在这一T3e阶段，session/idempotency与Redis仍未处理，随后必须分别由T3f/T3g完成；即使三个切片、`0027` S3 adapter、`0028` mover evidence、`0030` restore journal、`0031` backup catalog与`0032`～`0035` dormant telemetry lifecycle/inventory/writer/application-capture及S3 writer target全部安装，external/KMS、backup内tenant erasure与其它domain恢复证据、除当前单一provider failure logs contract外的完整application capture、traces producer、telemetry delete/restore/retention、真实managed环境证明及全域completion仍未完成，公开`dataPurgeExecution`保持false。

#### T3f 本地数据库投影清理（默认不启用）

只有T3e job已到`local_physical_acks_sealed`，且确认整个tenant与数据库都可丢弃，才可继续。T3f会真实清除tenant profile敏感字段、agent、session/turn/item/event/approval、idempotency、usage reconciliation、Blob/lifecycle/export投影，只保留匿名billing facts和最小不可变证据。先只开runner worker，保持router gate关闭：

```bash
TENANT_PURGE_EXECUTION_ENABLED=0 \
  TENANT_DATABASE_PURGE_WORKER_ENABLED=1 \
  TENANT_DATABASE_PURGE_ENABLED=0 \
  scripts/local-service.sh restart

curl -sS http://127.0.0.1:8787/v1/capabilities | python3 -m json.tool
curl -sS http://127.0.0.1:8080/v1/capabilities | python3 -m json.tool
```

runner应同时声明`tenantPurgeExecution=["local-execution-ack-v1","local-db-content-delete-v1"]`且`tenantDatabasePurgeWorker=true`；router gate关闭时不应授权T3f。确认只有该configured runner、旧router已完全排空后，再开启router gate：

```bash
TENANT_PURGE_EXECUTION_ENABLED=0 \
  TENANT_DATABASE_PURGE_WORKER_ENABLED=1 \
  TENANT_DATABASE_PURGE_ENABLED=1 \
  scripts/local-service.sh restart
```

轮询以下content-free字段，直到job为`database_purged`。不要手工删行、改receipt或清grave：

```bash
mysql -h 127.0.0.1 -uroot agent_service -e '
  SELECT request_id,phase,database_purge_generation,domain_count,
         predelete_entry_count,domain_ack_count,unresolved_blocker_count,
         last_error_code,blocked_reason_code
    FROM tenant_database_purge_jobs ORDER BY updated_at_ms DESC LIMIT 5;
  SELECT domain,action,bridge_kind,predelete_target_count
    FROM tenant_database_purge_predelete_entries
   ORDER BY request_id,database_purge_generation,domain_ordinal;
  SELECT request_id,grave_marker_count,retained_billing_fact_count,
         local_database_purge_complete,session_content_deleted,
         all_domains_complete,content_purge_executed
    FROM tenant_database_purge_receipts
   ORDER BY store_db_timestamp_ms DESC LIMIT 5;
  SELECT request_id,COUNT(*) AS grave_marker_count
    FROM tenant_purge_session_grave_markers GROUP BY request_id;
  SELECT control_generation,activated_at_db_ms,first_request_id
    FROM tenant_database_purge_cutover;'
```

terminal receipt必须显示`local_database_purge_complete=1`、`session_content_deleted=1`，但`all_domains_complete=0`、`content_purge_executed=0`。grave的owner hash只是同事务从live session捕获并由append-only/最小权限保护的opaque claim；T3c receipt不含user id，因此它不是可脱离owner tuple独立重算的上游证明。全局session ID fence和owner-scoped getter仍必须生效。T3f不处理Redis、external/KMS、backup/restore、logs/traces writer/sink/delete/restore/ACK、managed对象存储/IAM环境证明或全域restore/completion，所以公开status仍为`gated`；0032～0035的dormant lifecycle/inventory/writer/application-capture substrate不会改变这个结论。

MySQL在整个destructive transaction内锁住全局cutover singleton，因而两个tenant即使可同时排队，真正的T3f数据库删除当前仍会串行。手动体验时这是预期安全语义；它不能代表生产容量，预发必须补真实数据量下的锁等待、lease/timeout和失败重试观测。迁移夹具抽样覆盖DDL auto-commit断点、marker丢失和trigger修复，并不逐一中断全部45个trigger轮换；冻结pre-T3f parser测试也不等于真实N-1镜像canary。两项都应在有预发资源后加入升级演练。

#### T3g Redis session-state 清理（默认不启用）

只有T3f job已到`database_purged`，且本机MySQL和Redis都可丢弃，才可继续。T3g会真实删除每个grave session的Redis lease hash（owner目录也在其中）、fence counter和hot replay stream，并写无TTL永久marker；它不会执行`FLUSHDB/FLUSHALL`，也不处理quota/keypool/MCP等其它key。先给两端同一个准确、非密钥的logical namespace身份，只开启runner worker并保持router gate关闭：

```bash
REDIS_PREFIX=as \
REDIS_NAMESPACE_ID=agent-service-local-db0 \
TENANT_REDIS_PURGE_WORKER_ENABLED=1 \
TENANT_REDIS_PURGE_ENABLED=0 \
scripts/local-service.sh restart

curl -sS http://127.0.0.1:8787/v1/capabilities | python3 -m json.tool
curl -sS http://127.0.0.1:8080/v1/capabilities | python3 -m json.tool
```

runner应显示`tenantRedisPurge=["session-state-delete-v1"]`、`tenantRedisPurgeWorker=true`及64位hex `tenantRedisPurgeNamespaceSha256`；router在gate关闭时不能授权新materialize或首次Redis mutation，但worker仍会claim已有job、执行existing-marker-only replay、补ACK/seal及重放已有durable ACK marker。`REDIS_NAMESPACE_ID`不是secret，也不能随意取一个“看起来相同”的名称：它与`REDIS_PREFIX`共同代表准确的cluster/database/key namespace，而Redis URL故意不进入digest。确认只有该configured runner、所有旧router/runner均已排空后，再开启router gate：

```bash
REDIS_PREFIX=as \
REDIS_NAMESPACE_ID=agent-service-local-db0 \
TENANT_REDIS_PURGE_WORKER_ENABLED=1 \
TENANT_REDIS_PURGE_ENABLED=1 \
scripts/local-service.sh restart
```

轮询以下content-free字段，直到job为`redis_purge_sealed`。查询刻意不输出session id、raw claim token、Redis URL或任何密钥：

```bash
mysql -h 127.0.0.1 -uroot agent_service -e '
  SELECT request_id,phase,redis_purge_generation,target_count,
         target_ack_count,domain_ack_count,marker_count,
         unresolved_blocker_count,last_error_code,blocked_reason_code
    FROM tenant_redis_purge_jobs ORDER BY updated_at_ms DESC LIMIT 5;
  SELECT target_ordinal,lease_existed,fence_existed,stream_existed
    FROM tenant_redis_purge_target_acks
   ORDER BY request_id,redis_purge_generation,target_ordinal;
  SELECT domain,plan_target_count,affected_count,target_ack_count,marker_count
    FROM tenant_redis_purge_domain_acks
   ORDER BY request_id,redis_purge_generation,global_ack_seq;
  SELECT request_id,redis_purge_complete,all_domains_complete,
         content_purge_executed
    FROM tenant_redis_purge_receipts
   ORDER BY store_db_timestamp_ms DESC LIMIT 5;
  SELECT control_generation,activated_at_db_ms,redis_namespace_sha256
    FROM tenant_redis_purge_cutover;'
```

terminal job应有三个domain ACK，receipt必须是`redis_purge_complete=1`、`all_domains_complete=0`、`content_purge_executed=0`。首次mutation Lua先完整预检同slot key类型、既有marker和operation identity，再原子写marker并删除lease/fence/stream；existing-marker-only Lua只在exact marker存在时按原bits返回并再次删除可能复活的三域，marker缺失时不会创建marker或删除任何状态。`evt`只是瞬时Pub/Sub，不是第四个持久domain。runtime lease/owner lookup及持久/实时event publish都会检查marker，因而sealed session不能重新建立这些状态。

这里是跨存储saga，不是MySQL+Redis单事务。MySQL中已经写入target ACK的marker会在runner监听前及周期任务中重放；未ACK target要等worker开始轮询后claim，并先调用existing-marker-only Lua。exact marker存在时，即使router gate已经关闭，也会重新删除三域并继续补ACK/seal；marker缺失时该调用零修改，随后只有通过`fresh gate → renew claim → fresh gate`才能执行新的首次mutation。worker lease至少是barrier timeout的两倍再加1秒，且第二次proof返回时续租耗时不得超过lease一半；超限会fail closed。materialize同样需要fresh gate；claim、existing-marker replay、ACK持久化/精确重放、durable restore与全ACK seal不需要。必须准确理解恢复边界：same-MySQL restore keyset只能恢复**已经有durable ACK**的marker；若Redis中只有marker而MySQL ACK尚未提交，且该marker在worker成功replay并持久化ACK前又丢失，则首次lease/fence/stream existence bits也会丢失，当前没有独立ledger可重建它们。即使terminal job已存在，MySQL与Redis一起恢复到旧snapshot也不受此机制保护。大tenant的restore keyset扫描/重放性能、marker永久增长和普通live-session fence灾备仍需staging容量验证；当前真实Redis套件使用standalone ioredis，same-slot grammar已验证，但尚未在真实Redis Cluster、ACL、persistence/failover环境验收。

首个marker、target ACK或cutover之后只能forward-fix。可以把router gate设回`0`停止新materialize与新marker mutation，但不能关闭runner worker或更换namespace identity，因为worker仍负责existing-marker replay、补ACK/seal及startup/periodic durable restore：

```bash
REDIS_PREFIX=as \
REDIS_NAMESPACE_ID=agent-service-local-db0 \
TENANT_REDIS_PURGE_WORKER_ENABLED=1 \
TENANT_REDIS_PURGE_ENABLED=0 \
scripts/local-service.sh restart
```

不要手工删除marker、ACK、cutover或修改namespace。一次性演示完成后，唯一简单且一致的reset是停止应用，再同时重建这个可丢弃的本地MySQL与Redis；不能只清一侧并继续使用另一侧证据。

若尚未产生任何T3g marker/ACK/cutover，体验结束可关闭T3f router gate并停T3f worker，再关闭T3e router gate和worker；这不会恢复已发生的不可逆进度。T3g已有证据时不要执行下面的“关全部worker”序列，应保持T3g worker开启，或直接同时重建可丢弃MySQL与Redis。T3e/T3f首次cutover同样是write-once边界，数据库与证据只能保留并forward-fix：

```bash
TENANT_DATABASE_PURGE_WORKER_ENABLED=1 \
  TENANT_DATABASE_PURGE_ENABLED=0 \
  TENANT_REDIS_PURGE_WORKER_ENABLED=0 \
  TENANT_REDIS_PURGE_ENABLED=0 \
  scripts/local-service.sh restart
TENANT_DATABASE_PURGE_WORKER_ENABLED=0 \
  TENANT_DATABASE_PURGE_ENABLED=0 \
  TENANT_PURGE_EXECUTION_WORKER_ENABLED=1 \
  TENANT_PURGE_EXECUTION_ENABLED=0 \
  TENANT_REDIS_PURGE_WORKER_ENABLED=0 \
  TENANT_REDIS_PURGE_ENABLED=0 \
  scripts/local-service.sh restart
TENANT_PURGE_EXECUTION_WORKER_ENABLED=0 \
  TENANT_PURGE_EXECUTION_ENABLED=0 \
  scripts/local-service.sh restart
```

最后应先关闭T3b router execution，再停T3b worker/endpoint、T3a execution和新admission；这不会重开已fenced tenant、恢复cache/reference或已经删除的credential：

```bash
  TENANT_RUNTIME_DRAIN_EXECUTION_ENABLED=0 \
  TENANT_RUNTIME_REVOCATION_WORKER_ENABLED=0 \
  TENANT_RUNTIME_DRAIN_ENABLED=0 \
  TENANT_CONTENT_INVENTORY_WORKER_ENABLED=0 \
  TENANT_PURGE_PLAN_WORKER_ENABLED=0 \
  TENANT_PURGE_EXECUTION_WORKER_ENABLED=0 \
  TENANT_PURGE_EXECUTION_ENABLED=0 \
  TENANT_CREDENTIAL_REVOCATION_EXECUTION_ENABLED=0 \
  TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED=0 \
  TENANT_ERASURE_REQUESTS_ENABLED=0 \
  scripts/local-service.sh restart
```

在 platform token 仍配置且有 healthy code-aware runner 时，上述 status GET 仍应可读。0030 journal control为generation `0`时，对同一tenant使用原`Idempotency-Key`和body的已提交POST沿用旧语义，从独立read-only replay route返回同一request与`202`。0030 active后，首次create可能已经原子提交T1，但create与exact replay在terminal publication receipt可读前都返回可重试`503`；receipt读取失败也按`503` fail closed。此时必须以完全相同tenant、body与`Idempotency-Key`重试，不能换key或把`503`解释为“没有提交”，receipt可读后才返回同一request与`202`。改用未提交/不同key的新admission POST仍返回可重试`503`且数据库不得新增request。若durable key与request hash证据冲突则返回`409`，绝不猜测或创建。router一旦为某次请求选定replay模式，即使gate在请求途中重新打开也不能升格为create。确认publication receipt已完成后，可在仍保留上述shell变量的同一终端验证：

```zsh
REPLAY="$(curl -fsS --config "$CURL_CONFIG" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: tenant-erasure-demo-1' \
  --data "{\"tenantId\":\"$TENANT_ID\"}" \
  "$BASE/v1/tenant-erasure-requests")"
test "$(printf '%s' "$REPLAY" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')" = "$REQUEST_ID"

NEW_CODE="$(curl -sS --config "$CURL_CONFIG" -o /dev/null -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: tenant-erasure-demo-new' \
  --data "{\"tenantId\":\"$TENANT_ID\"}" \
  "$BASE/v1/tenant-erasure-requests")"
test "$NEW_CODE" = 503
```

T3a～T3g worker可能在POST后迅速推进内部job，但公开GET仍只返回`gated`。T3b proof只覆盖configured fleet本地references与tracked I/O；T3c只证明DB-clock owner结构；T3d只证明33域及blocker完整；T3e只证明local usage/Blob/export动作与actual outbox ACK；T3f只证明11个本地数据库投影删除、匿名billing保留与session grave；T3g只证明session-scoped Redis三域及same-MySQL marker replay；`0027`只证明exact Blob namespace和S3对象协议，`0028`只证明sealed-ledger对象的离线搬迁。`0029`另从terminal T3a/0026 source建立external-target执行证据，但标准MySQL栈固定其双gate关闭，当前Memory fake也不证明真实provider或KMS；`0032`～`0035`只证明安全telemetry入口、default-dormant原子lifecycle/inventory/writer/application-capture substrate与S3 writer protocol，产品接线仅覆盖`provider.upstream_request_failed` logs。它们合起来仍不证明backup/独立restore、完整application capture、traces producer、telemetry delete/restore/retention、真实managed环境或全域content已经完成。体验完成后同时重建可丢弃MySQL与Redis，不要手工删表行或marker来“解除”fence、cutover或receipt。自动门禁为：

```bash
pnpm test:tenant-credential-revocation-mysql
pnpm test:tenant-credential-physical-revocation-mysql
pnpm test:tenant-credential-lifecycle-mysql
pnpm test:tenant-credential-target-execution-mysql
pnpm test:tenant-runtime-revocation-mysql
pnpm test:tenant-content-inventory-mysql
pnpm test:tenant-purge-plan-memory
pnpm test:tenant-purge-plan-mysql
pnpm test:tenant-purge-execution-mysql
pnpm test:tenant-database-purge-memory
pnpm test:tenant-database-purge-mysql
pnpm test:tenant-redis-purge-memory
pnpm test:tenant-redis-purge-mysql
pnpm test:tenant-redis-purge-redis
pnpm test:tenant-redis-purge-cluster
```

这些named no-skip命令依次覆盖T1/T2、T3a、T3b、T3c、T3d、T3e、T3f与T3g边界。T3e套件证明原子local cutover、exact outbox与actual physical ACK；T3f的Memory/MySQL套件证明11域投影删除与证据同原子边界、billing/grave/response-loss/回滚/隔离；T3g四套件分别证明纯契约/Memory publication、真实InnoDB ledger、真实standalone Redis Lua/marker防复活，以及mixed-worker/mixed-namespace/active-fleet多进程gate。0029 named套件另证明InnoDB materialize/lease/ACK/cutover/回滚，但不会调用真实provider。所有worker都内嵌runner，没有公开执行API或第三个服务，也尚未在真实Redis Cluster/ACL/failover或provider环境验收；不能把store/worker套件夸大为完整HTTP tenant purge或云恢复证明。准确用例数以`docs/PROGRESS.md`最后一节与当次CI为准。

#### 0029 Memory fake 行为演练（不是标准MySQL全栈）

当前没有可安全手工调用的真实provider撤销adapter。若要观察reference保护、fake adapter幂等/response-loss以及worker/gate语义，运行隔离测试即可；不要把`CREDENTIAL_TARGET_EXECUTION_ADAPTER=fake`写入`.env`，也不要据此声称MySQL或远端provider已经执行：

```bash
pnpm vitest run \
  packages/providers/test/credential-target-reference.test.ts \
  packages/providers/test/credential-target-reference-service.test.ts \
  apps/agent-runner/test/credential-target-reference-local.test.ts \
  packages/store/test/tenant-credential-target-execution.memory.test.ts \
  packages/core/test/fake-credential-target-execution-adapter.test.ts \
  packages/core/test/tenant-credential-target-execution-worker.test.ts \
  apps/agent-runner/test/tenant-credential-target-execution-gate.test.ts
```

这组演练完全进程内、只用可丢弃fixture；fake state不提供跨进程持久性。标准`scripts/local-service.sh start`固定使用MySQL，会对fake或非零0029 gate直接报错并保持服务未启动。

### 0016 purge-policy evaluator（只观察证据，不执行删除）

evaluator没有公开管理API；这是刻意的最小权限边界。它只处理已经停在`awaiting_purge_policy`的durable request，并将内部证据写入MySQL。runner和router都使用`PURGE_POLICY_EVALUATOR_ENABLED`，产品及本地默认值都是`0`；本地统一脚本会把同一显式值传给两端。仅在全新、可丢弃的tenant/user和测试库中启用：

```bash
PURGE_POLICY_EVALUATOR_ENABLED=1 \
  DATA_GOVERNANCE_MANAGEMENT_ENABLED=1 \
  DATA_ERASURE_REQUESTS_ENABLED=1 \
  ERASURE_WORKER_ENABLED=1 \
  LEGACY_TOMBSTONE_COMPENSATION_ENABLED=1 \
  scripts/local-service.sh restart

curl -sS http://127.0.0.1:8080/v1/capabilities | python3 -m json.tool
scripts/local-service.sh status
```

预期capability包含`purgePolicyEvaluation=["policy-evaluator-v1"]`且`dataPurgeExecution=false`。前者表示configured fleet理解0016 evidence contract，不是“worker正在运行”的公开状态；是否启用应看本次启动参数和runner/router启动日志。私有barrier需要`INTERNAL_ROUTER_TOKEN`并故意不暴露rollout详情，不要为了手工体验打印、复制或探测该token。

先按上一节在全新tenant注册并激活policy，再按“User erasure到安全策略边界”创建全新、没有session的可丢弃user。若四个destructive计算字段`userErasureGraceMs`、`sessionContentRetentionMs`、`operationalUsageRetentionMs`和`idempotencyReceiptRetentionMs`任一为`null`，预期decision是`unconfigured`且没有authority；这证明fail-closed。若要只观察候选证据，可另建一个全新policy version，把这四项设为`0`（其余duration也可保持`0`），激活后再为另一个零session user提交request。数秒后公开status仍应停在`awaiting_purge_policy`，内部decision可成为`eligible_execution_disabled`，但绝不会成为`completed`。

本地可用只读查询观察不含正文的job/decision/authority；不要在共享或生产数据库直接查询：

```bash
mysql -h 127.0.0.1 -uroot agent_service -e '
  SELECT request_id,build_generation,target_count,sealed_at_ms,last_error_code
    FROM erasure_policy_evaluation_jobs ORDER BY updated_at_ms DESC LIMIT 5;
  SELECT request_id,decision_seq,build_generation,decision,target_count,eligibility_deadline_ms
    FROM erasure_policy_evaluation_decisions ORDER BY decided_at_ms DESC LIMIT 5;
  SELECT request_id,authority_generation,build_generation,target_count,created_at_ms
    FROM erasure_purge_authorities ORDER BY created_at_ms DESC LIMIT 5;'
```

非零session request会为每个session写content-free target摘要；它只承诺tombstone、ready Blob、usage reconciliation和receipt evidence，不是turn/item/event/approval全量内容清单。若这些live facts在build中变化，`last_error_code=evidence_changed`会触发新build generation；sealed后变化或legal-hold set/release ABA也会撤销active projection并重评，旧证据不覆写。自动化的权威验证入口是`pnpm test:erasure-purge-policy-mysql`，它还覆盖真实InnoDB claim/ABA、回滚和锁顺序。

即使观察到0016 authority也不能据此尝试手工删除：它自己的deadline仍来自runner wall clock，target也不是完整owner清单。`0021` T3c补充DB-clock owner proof，`0022` T3d固定33域；`0023` T3e只在自己的默认关闭gate下执行local usage/Blob/export子集，`0024` T3f再清理session/idempotency/lifecycle/Blob/export等11个数据库投影，`0025` T3g最后清理session-scoped Redis三域。三者都不直接把0016 authority当全局许可，`0027` storage control只约束对象namespace，`0028` mover只负责停服搬迁和pointer/control cutover；`0029`只提供default-dormant external-target协议、Memory fake与账本正确性，`0030`提供T1 journal/fence恢复，`0031`提供backup来源authority与epoch reservation，`0032`～`0035`提供safe ingress、default-dormant lifecycle activation/inventory/writer substrate和分域producer capture；当前只有单一provider failure logs contract，traces必须inactive。真实provider/KMS、backup内tenant erasure与其它domain恢复证据、logs/traces writer/sink/delete/restore/ACK、managed对象存储/IAM环境证明及其它completion ACK仍未闭环；completion、T3d execution readiness及T3e/T3f/T3g/0029 all-domains-complete都固定为false。体验结束后可关闭三个外部gate；已经提交的subject gate和immutable evidence不会回滚：

```bash
PURGE_POLICY_EVALUATOR_ENABLED=0 \
  DATA_GOVERNANCE_MANAGEMENT_ENABLED=0 \
  DATA_ERASURE_REQUESTS_ENABLED=0 \
  scripts/local-service.sh restart
```

quarantine是数据库完整性故障路径，不应通过普通手工体验故意破坏业务库。安全owner envelope的公开status只会显示`blocked`，不会返回私有reason/evidence/control generation；当前maintenance能力是store级最小权限接口，尚无公开或admin HTTP端点。逐候选隔离、重启保留、双管理员CAS、repair回滚和恢复领取由Memory、真实MySQL与cluster自动测试验证。request/tenant/subject identity、generation或有序安全时间戳自身损坏时，store不尝试owner读取或自动修复，而是在同一原子边界保留原字段、撤销worker authority并写content-free append-only terminal incident；真实MySQL测试覆盖exact BIGINT、双store竞争、incident INSERT回滚与邻居继续领取。若真实环境出现`control_audit_invalid`或terminal incident，当前只能保持隔离、备份证据并forward-fix，没有通用“自动修好审计链”按钮。

## 6. 分层验证路径

### 日常迭代与阶段验收（验证去重候选，2026-10-15）

不必每次小改动都运行数小时全量。每轮先做`pnpm typecheck`及相关`pnpm test:<专项>`；涉及SQL、事务、删除、鉴权或租户边界时，当轮仍须执行相关真实MySQL/Redis/MinIO及并发、回滚、隔离负例。连续多轮定向通过后，在一个可验收功能包的代码/接口冻结点运行完整`verify`，触及S3/备份/恢复时还须`verify-s3`。全量失败先定位并定向修复，再对最终候选补齐完整验收，不用失败前的旧报告证明新代码通过。

全量中断时，原exit1和失败报告必须保留；按变更风险重验失败/依赖项，并补齐未执行的后置。只改测试诊断/CI/文档且产品源码未变时，不机械重跑数小时前已通过的全部产品套件，但必须明确各段source commit、实际case和未执行范围，不能把这些拼成一次成功的`verify`。较大阶段最终推送的exact SHA仍须完整CI，全套SQL/安全门禁不因本地分段省略；原原因未知的构建故障也不能仅因重跑通过就称已修复。

实际例子：67eaa2d集中verify约68分钟后因冻结旧binary构建准备失败退出1；随后只复验该整文件，再补后置。后置暴露的SIGKILL集群场景只调整真实lease前置，保留120秒watchdog、固定4秒retry观察和原deadline/owner/fence/最终闭合断言；新SHA整文件3项约51秒通过，1d3be15其余T3g/SDK/构建/实际VM后置约151秒退出0。数据库查询异常与观察超时分开、只输出固定分类和数值。以上是分段证据，不是一次全量通过，也不能据此推导CI节省比例；完整失败与证明范围见PROGRESS末节。

本候选新增`pnpm test:verification-tools`用于纯校验器/清单回归；`pnpm test:coverage`是主套件单次执行入口，必须先准备独立可丢弃MySQL/Redis测试环境，它不是无基础设施的快速测试。入口不接受过滤参数，强制真实integration profile，以独占`.local-run/coverage-attempt-*/tests.json`绑定本轮子进程退出结果和时间，再校验124个required文件（原115、5个L0 metrics、3个离线签名和1个CI汇总回归文件）各唯一、非零test case且全部passed，以及原coverage阈值。旧便利路径`.local-run/verify-tests.json`仅在成功后更新，不可单独当新执行证明。62个旧具名命令映射仍供审计，group数字是主执行的子集，不另加到总数；VM group现含7文件，所有原定向命令保留供开发使用。

只移除环境与覆盖目标等价的重复执行：S3专用flag/MinIO、历史独立config/冻结binary、真实多进程cluster/T3g、SDK、实际bundle与clean VM双包/归档启动仍分别验收。并行重型CI须先隔离每个job的MySQL/Redis/目录，当前本机共享测试资源不能盲开并发。CI在较大阶段集中推送后验收，避免连续push取消长任务；不能拿本地macOS或旧SHA的绿灯代替最终Linux/发布提交证明。

L0指标候选曾有10个定向文件388 passed、零fail/skip（其中5个新增文件153项），API检查与实际bundle装配smoke通过；这不是新driver的完整`verify`或GitHub CI终态。本轮签名相关9文件889 passed（VM七文件770、proof工具119）在私钥格式正则等价修订后已最终复验、零fail/skip；代码d671632另有实际clean双包装配通过，仍不能替代最终HEAD完整verify/新Linux CI。当前完整尝试的失败见顶部/PROGRESS，不能用定向通过补称后置已执行。尚未测得端到端节省比例，不承诺倍数。本节优先解释下方旧“具名wrapper”描述：日常独立命令仍使用wrapper，main阶段改由同次coverage生成逐文件/具名group证明，不降低必跑范围。

```bash
scripts/local-service.sh smoke
# 无真实模型费用；检查正在运行的服务和路由

scripts/local-service.sh verify
# 无真实模型费用；运行 secret/API drift/typecheck、MySQL/Redis 集成、
# 包含telemetry/default-off 0053 capture provenance/operator/真实MySQL、0050/0051普通DELETE来源、0052本地usage、T3a～T3g及其它生命周期专项；真实MinIO协议只在verify-s3、
# 0007→...→0044→0049→0050→0051→0052→0053 历史schema迁移及冻结0042→0043代码兼容夹具、真实多进程 cluster（含T3g mixed-worker/namespace/active-fleet精确no-skip套件）、
# SDK、router/runner长期入口与runner四个one-shot维护入口的构建/启动门禁

scripts/local-service.sh verify-s3
# 无模型费用；显式启动本地MinIO，证明Blob、0028 mover、0030 restore-journal、0031 backup-catalog
# 与telemetry writer、GET-only observer及非生产v3 journal真实S3套件零skip，
# 实际provider HTTP/stream故障→公开Runtime/private fresh fleet gate→MySQL→MinIO bytes/ACK，
# 加密backup create/import及active0033 exact key显式restore-ledger verify，
# 并以临时MySQL运行源码runner/router装配smoke

scripts/local-service.sh verify-real
# 读取本机 .env，只跑真实 provider E2E，会产生费用

scripts/local-service.sh acceptance
# 从 router 完成端到端人工体验，会产生费用
```

验证0032/0033 lifecycle evidence、activation、coverage和inventory可运行`pnpm test:tenant-telemetry-lifecycle`、`pnpm test:tenant-telemetry-lifecycle-memory`与`pnpm test:tenant-telemetry-lifecycle-mysql`；0034 writer运行`pnpm test:tenant-telemetry-writer`与`pnpm test:tenant-telemetry-writer-mysql`；S3 writer另运行`pnpm test:tenant-telemetry-writer-s3`，它必须连接真实MinIO并由required wrapper证明没有静默skip；0035 application capture运行`pnpm test:tenant-telemetry-application-capture`与`pnpm test:tenant-telemetry-application-capture-mysql`。后者真实InnoDB套件覆盖logs/traces分域activation、并发exact winner/replay、activation与tenant/enqueue线性化、Unicode tenant ID隔离、legacy unbound exact replay、post-cutover binding、事务回滚和startup drift。0036 disposition运行`pnpm test:tenant-telemetry-disposition`与`pnpm test:tenant-telemetry-disposition-mysql`；独立真实MinIO journal协议运行`pnpm test:tenant-telemetry-disposition-s3`。0037另运行`pnpm test:tenant-telemetry-disposition-grant`和`pnpm test:tenant-telemetry-disposition-grant-mysql`，分别强制执行非生产v2 grant-bound Memory event/CAS夹具与真实InnoDB hard-deny/指纹套件；0038逐项membership/source证据由`pnpm test:tenant-telemetry-writer`、`pnpm test:tenant-telemetry-writer-mysql`及`pnpm test:migrations`验证；0039 T3f owner-closure由`pnpm test:tenant-database-purge-memory`、`pnpm test:tenant-database-purge-mysql`与冻结`0038→0039`真实MySQL迁移夹具覆盖，后者证明历史write保持、DDL/marker-loss重放、孤立entry阻断及terminal guard，且独立冻结0038旧二进制terminal升级夹具已通过；0040 T3d source-accounting由`pnpm test:tenant-purge-plan-memory`、`pnpm test:tenant-purge-plan-mysql`与冻结`0039→0040`真实MySQL迁移夹具覆盖；普通0040夹具历史terminal仅为SQL-shaped投影；另有冻结0039与0040旧二进制真实terminal升级夹具，三份pre-0041旧terminal均无非空telemetry artifact；0042另有冻结0041旧二进制非空terminal升级及新目录Memory/真实MySQL定向回归。CI和本地verify均须由required wrapper证明文件确实执行、非skip且断言数非零。0041观察目标与0042新plan非零目录target仍默认拒绝，测试不是产品删除/旧快照恢复证明。历史升级仍必须运行`pnpm test:migrations`，不能用fresh-schema或helper单测替代。易变的完整测试数量、coverage、bundle大小和环境说明只以`docs/PROGRESS.md`最后一节及对应CI run为准。

0043无新migration，仍由`pnpm test:tenant-purge-plan-memory`、`pnpm test:tenant-purge-plan-mysql`、`pnpm test:tenant-purge-execution-mysql`和T3f定向套件覆盖只读候选与非零目标T3e live recheck。`pnpm test:migrations`还通过required manifest独立运行`packages/store/test/migrations/0042-binary-to-0043.migration.ts`：它在真实MySQL运行冻结的0042旧产品二进制，保留旧非空T3e阻断及零target T3f terminal，再用当前代码只读核对。夹具源钉在已发布的0042提交，不是根据当前工作树临时构造；required wrapper要求该文件实际执行、非skip且有断言。该测试证明代码级历史兼容，不代表0043增加schema，也不授权修复旧blocked job。单独定向运行时需使用迁移专用Vitest config和可丢弃的`MYSQL_MIGRATION_TEST_URL`，不要用默认Vitest扫描来推断它未运行。

开发尚未提交的migration时，若同一个持久化`agent_service_test`已经记录该migration marker、SQL/trigger body随后又被修改，或DDL已部分自动提交但marker尚未写入，启动指纹应当fail closed；不要因此弱化指纹，也不要让runtime静默改写已应用migration。先确认目标确实是可丢弃且名称含`test`的测试库，再重建该库，或新建一个空测试库并通过`MYSQL_TEST_URL`运行验证；不得把这条开发期处置用于需保留的`agent_service`业务库。migration一旦发布即视为immutable，后续结构或trigger变化必须新增forward migration。

如果旧测试库的来源或可丢弃性不明确，保留原库与失败报告，选择新的空隔离库；完整`verify`的基库名称须包含独立的`test`段（例如`agent_service_test_manual_20261013`，而不是`agent_service_capture_verify_20261013`；仅迁移定向夹具可接受独立`migration`段）。创建前先只读确认该名称不存在，不能用`CREATE DATABASE IF NOT EXISTS`把已有库当成空库。完整`verify`应显式设置`MYSQL_TEST_URL`与`MYSQL_MIGRATION_TEST_URL`指向同一新隔离基库；`CLUSTER_MYSQL_URL`仍使用另一专用、可丢弃的cluster库。后续`verify-s3`继续使用相同的`MYSQL_TEST_URL`。这些本地测试串行运行，不要让两个验证进程或手动体验服务同时写共享测试库；不能通过删marker、删guard、扩大超时或忽略skip来制造成功。

使用自定义`MYSQL_TEST_URL`时，先显式创建其指向的空基库；历史迁移夹具会另建临时库，但`mysql-redis.test.ts`等conformance文件直接连接这个基库。cluster套件也有独立基库，若默认库曾被开发中的migration部分更新，应一起换成新的空库。选尚不存在、名称含`test`的可丢弃库，例如：

```bash
mysql -h 127.0.0.1 -uroot -e 'CREATE DATABASE agent_service_manual_verify_test CHARACTER SET utf8mb4'
mysql -h 127.0.0.1 -uroot -e 'CREATE DATABASE agent_service_manual_cluster_test CHARACTER SET utf8mb4'
MYSQL_TEST_URL='mysql://root@127.0.0.1:3306/agent_service_manual_verify_test' \
CLUSTER_MYSQL_URL='mysql://root@127.0.0.1:3306/agent_service_manual_cluster_test' \
scripts/local-service.sh verify
```

若已存在同名库，`CREATE DATABASE`会报错；不要覆盖或清空它，改用新的唯一测试库名。此处创建数据库不是迁移器自动修复，也不适用于业务库。

完整验证期间保持电脑开盖并接通电源；macOS的`caffeinate`只能防止部分闲置休眠，不能阻止合盖休眠。合盖会让数据库hook、lease与wall-clock断言失效，不能通过增加超时或删除断言处理。先保留失败报告，再在正常运行环境复测相关文件和完整验证；自定义test base须在运行前确实存在，临时迁移夹具通过不代表这个共享基库已创建。

运行`verify-s3`前还须检查本机卷的可用空间（`df -h`）：MinIO health/readiness成功不代表允许写入。容量保护触发时可能返回HTTP `507`，必须保留失败报告，不能把未到达的新套件算作执行，也不要降低保护阈值、直接删除datadir文件或重建业务库。密集MySQL测试也会产生binlog；它们是历史恢复/复制依据，不是可默认删除的测试缓存。只有明确确认保留需求和得到授权后，才能通过MySQL的日志清理接口处理精确旧日志范围；这不是应用DELETE或backup retention worker的权限。

日常开发至少运行与修改范围匹配的定向测试；合并或里程碑冻结前运行完整 `verify`。真实模型路径只有在明确需要时运行，不能把未重跑的历史结果描述为本轮结果。

手动体验不必等到 M1/M3/M4 全部完成：每个安全切片先做短smoke，能更早发现交互和运维问题；待整体架构的local/CI范围完成后，再按第3～6节做一次完整walkthrough作为阶段验收。policy/hold、non-destructive evaluator、异步user export、tenant T1/T2/T3a、`0026` versioned credential inventory、`0027` shared S3 namespace control、`0028` offline filesystem→S3 mover、T3b runtime drain、T3c owner inventory、T3d plan、T3e local usage/Blob/export execution/ACK、T3f本地数据库投影清理、T3g session-scoped Redis三域、0029 default-dormant协议/Memory fake/真实MySQL账本、`0030`独立journal/runtime lineage/永久恢复fence、`0031`权威backup catalog/source binding/runtime reservation/retention CLI，以及`0032`～`0035`安全telemetry入口、原子activation/inventory、default-dormant writer/reservation/ACK和S3-compatible write target均已有本地/CI代码；tenant流程、S3 cutover、backup catalog与restore演练都只能使用可丢弃数据，因为其中多条边界不可逆。0029 fake不是真实provider/KMS；0031不创建物理backup，本机MinIO也不是独立故障域；0035只接单一provider failure logs。traces producer、0036～0044可执行的外部disposition/delete/restore、真实DB grant签发、旧快照replay/startup gate及retention executor仍缺失；0037的v2 Memory夹具、0038新write sidecar和0039 T3f本地closure、0040/0041 T3d来源/观察目标、0042新plan目录、0043本地候选与0044 pre-grant intent/claim也不能替代可信DB授权、产品S3 mutation或旧快照恢复；非生产CAS tombstone/journal夹具不能替代这些能力，普通start保持inactive。当前尚未接线或未验收的还包括provider/KMS真实adapter、backup内tenant erasure/其它domain恢复证据、logs/traces完整执行生命周期、managed对象存储/IAM真实环境、大规模mover/restore维护窗口、全域completion proof、generic user物理purge、M3扩展和M4生产化，不能提前模拟成已存在。

## 7. 本地源码进程与生产构建产物

本地首选 `scripts/local-service.sh start`：它会加载 `.env`、补齐单 runner Blob 安全覆盖，并按进程边界互斥剥离authority：runner移除router-only platform authority及T3a/T3b/T3e/T3f/T3g/0030 execution变量；router移除runner-only worker/endpoint/raw restore-journal配置及全部`TENANT_TELEMETRY_*` writer authority；两个长期进程都移除one-shot CLI authority、全部`BACKUP_CATALOG_*`/`TENANT_BACKUP_CATALOG_*`和0031操作变量。`REDIS_PREFIX`与`REDIS_NAMESPACE_ID`则必须保留并在两端一致。router进程还会显式剥离runner的MySQL DSN、模型provider key/endpoint、envelope master key、`BOOTSTRAP_API_KEY`、`ADMIN_BOOTSTRAP_TENANT`、`ADMIN_BOOTSTRAP_OUTPUT_FILE`及测试S3 authority，router配置层对这些变量再次fail closed；Redis连接与router自己的窄化token是它确实需要的authority。first-admin两变量只属于明确的一次性runner操作，日常verify会清除它们，不能让`.env`中的ambient值意外创建key。0030启用时只有runner获得原始journal identity、endpoint和credential，router只获得三个公开digest与execution gate；0031原始authority只进入one-shot CLI，router仅观察runner公开capability digest。标准栈使用MySQL，因此还会拒绝0029 fake或非零gate，并把runner/router对应0029 gate固定为`0`。

如果必须在两个终端手工运行源码，两个终端都从仓库根目录开始。runner 终端先加载配置，再删除 platform authority：

```zsh
set -a
source .env
set +a
for name in ${(k)parameters}; do
  case "$name" in
    BACKUP_CATALOG_*|TENANT_BACKUP_CATALOG_*|BACKUP_ARTIFACT_*|BACKUP_MYSQL*|BACKUP_RESTORE_*|TELEMETRY_CAPTURE_*) unset "$name" ;;
  esac
done
unset TENANT_ERASURE_OPERATOR_TOKEN TENANT_ERASURE_OPERATOR_ID \
  TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE PERSISTED_PROVIDER_FAILURE_CAPTURE_FLEET_ENABLED \
  ADMIN_BOOTSTRAP_TENANT ADMIN_BOOTSTRAP_OUTPUT_FILE \
  TENANT_CREDENTIAL_REVOCATION_EXECUTION_ENABLED TENANT_RUNTIME_DRAIN_EXECUTION_ENABLED \
  TENANT_PURGE_EXECUTION_ENABLED TENANT_DATABASE_PURGE_ENABLED TENANT_REDIS_PURGE_ENABLED \
  TENANT_RESTORE_JOURNAL_EXECUTION_ENABLED \
  RESTORE_JOURNAL_NAMESPACE_SHA256 RESTORE_JOURNAL_TARGET_ROOT_SHA256 \
  RESTORE_JOURNAL_RUNTIME_EPOCH_SHA256 RESTORE_JOURNAL_PRIMARY_ACTIVATION_ACK \
  RESTORE_RUN_ID RESTORE_FLEET_STOPPED_ACK SOURCE_BACKUP_SHA256 RESTORE_REPLAY_PAGE_SIZE \
  BACKUP_ID BACKUP_RUNTIME_EPOCH_ID SOURCE_SNAPSHOT_SHA256 \
  BACKUP_ARTIFACT_MANIFEST_SHA256 BACKUP_PROVIDER_EVIDENCE_SHA256 BACKUP_EVICTION_ID \
  EXTERNAL_TOMBSTONE_SHA256 BACKUP_PHYSICAL_ABSENCE_ACK \
  CREDENTIAL_TARGET_EXECUTION_ADAPTER TENANT_CREDENTIAL_TARGET_EXECUTION_WORKER_ENABLED \
  TENANT_CREDENTIAL_TARGET_EXECUTION_ENABLED \
  MINIO_ROOT_USER MINIO_ROOT_PASSWORD \
  AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_SECURITY_TOKEN \
  AWS_PROFILE AWS_DEFAULT_PROFILE AWS_SHARED_CREDENTIALS_FILE AWS_CONFIG_FILE AWS_CREDENTIAL_FILE \
  AWS_WEB_IDENTITY_TOKEN_FILE AWS_ROLE_ARN AWS_ROLE_SESSION_NAME \
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI AWS_CONTAINER_CREDENTIALS_FULL_URI \
  AWS_CONTAINER_AUTHORIZATION_TOKEN AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE
node --import tsx apps/agent-runner/src/main.ts
```

router 终端保留 platform 配置，但必须移除全部runner provider/MySQL/bootstrap/envelope/object-store/telemetry-writer authority。下面使用zsh按前缀清除任意`MYSQL_*`、`S3_TEST_*`、`AWS_*`、`BACKUP_CATALOG_*`、`TENANT_BACKUP_CATALOG_*`、`BACKUP_ARTIFACT_*`、`BACKUP_MYSQL*`、`BACKUP_RESTORE_*`、`TENANT_TELEMETRY_*`和`TELEMETRY_LIFECYCLE_*`，只处理变量名且不会回显值；其余当前已知runner-only变量逐一清除：

```zsh
set -a
source .env
set +a
for name in ${(k)parameters}; do
  case "$name" in
    MYSQL_*|S3_TEST_*|AWS_*|BACKUP_CATALOG_*|TENANT_BACKUP_CATALOG_*|BACKUP_ARTIFACT_*|BACKUP_MYSQL*|BACKUP_RESTORE_*|TENANT_TELEMETRY_*|TELEMETRY_LIFECYCLE_*|TELEMETRY_CAPTURE_*|SESSION_DELETE_GRACE_RECOVERY_*|SESSION_USAGE_RETENTION_*) unset "$name" ;;
  esac
done
unset API_KEY API_BASE_URL DEFAULT_MODEL PLATFORM_PROVIDER \
  PERSISTED_PROVIDER_FAILURE_CAPTURE_ENABLED \
  SECRETS_MASTER_KEY BOOTSTRAP_API_KEY BOOTSTRAP_TENANT_ID \
  ADMIN_BOOTSTRAP_TENANT ADMIN_BOOTSTRAP_OUTPUT_FILE \
  TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED \
  CREDENTIAL_TARGET_EXECUTION_ADAPTER TENANT_CREDENTIAL_TARGET_EXECUTION_WORKER_ENABLED \
  TENANT_CREDENTIAL_TARGET_EXECUTION_ENABLED \
  TENANT_RUNTIME_DRAIN_ENABLED TENANT_RUNTIME_REVOCATION_WORKER_ENABLED \
  TENANT_CONTENT_INVENTORY_WORKER_ENABLED TENANT_PURGE_PLAN_WORKER_ENABLED \
  TENANT_PURGE_EXECUTION_WORKER_ENABLED TENANT_DATABASE_PURGE_WORKER_ENABLED \
  TENANT_REDIS_PURGE_WORKER_ENABLED TENANT_RESTORE_JOURNAL_WORKER_ENABLED \
  TENANT_RESTORE_JOURNAL_WORKER_POLL_MS TENANT_RESTORE_JOURNAL_WORKER_LEASE_MS \
  TENANT_RESTORE_JOURNAL_WORKER_BATCH_SIZE TENANT_RESTORE_JOURNAL_MATERIALIZE_BATCH_SIZE \
  TENANT_RESTORE_JOURNAL_RETRY_BASE_MS TENANT_RESTORE_JOURNAL_RETRY_MAX_MS \
  RESTORE_JOURNAL_ADAPTER RESTORE_JOURNAL_DATABASE_NAMESPACE_ID \
  RESTORE_JOURNAL_RUNTIME_EPOCH_ID RESTORE_JOURNAL_NAMESPACE_ID \
  RESTORE_JOURNAL_FAILURE_DOMAIN_ID RESTORE_JOURNAL_INDEPENDENT_FAILURE_DOMAIN_ACK \
  RESTORE_JOURNAL_S3_ENDPOINT RESTORE_JOURNAL_S3_REGION RESTORE_JOURNAL_S3_BUCKET \
  RESTORE_JOURNAL_S3_PREFIX RESTORE_JOURNAL_S3_FORCE_PATH_STYLE \
  RESTORE_JOURNAL_S3_PRIVATE_BUCKET_ACK RESTORE_JOURNAL_S3_REQUEST_TIMEOUT_MS \
  RESTORE_JOURNAL_S3_ACCESS_KEY_ID RESTORE_JOURNAL_S3_SECRET_ACCESS_KEY \
  RESTORE_JOURNAL_S3_SESSION_TOKEN RESTORE_JOURNAL_PRIMARY_ACTIVATION_ACK \
  RESTORE_RUN_ID RESTORE_FLEET_STOPPED_ACK SOURCE_BACKUP_SHA256 RESTORE_REPLAY_PAGE_SIZE \
  BACKUP_ID BACKUP_RUNTIME_EPOCH_ID SOURCE_SNAPSHOT_SHA256 \
  BACKUP_ARTIFACT_MANIFEST_SHA256 BACKUP_PROVIDER_EVIDENCE_SHA256 BACKUP_EVICTION_ID \
  EXTERNAL_TOMBSTONE_SHA256 BACKUP_PHYSICAL_ABSENCE_ACK \
  BLOB_S3_ENDPOINT BLOB_S3_REGION BLOB_S3_FORCE_PATH_STYLE BLOB_S3_PRIVATE_BUCKET_ACK \
  BLOB_S3_REQUEST_TIMEOUT_MS BLOB_S3_ACCESS_KEY_ID BLOB_S3_SECRET_ACCESS_KEY \
  BLOB_S3_SESSION_TOKEN MINIO_ROOT_USER MINIO_ROOT_PASSWORD \
  AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_SECURITY_TOKEN \
  AWS_PROFILE AWS_DEFAULT_PROFILE AWS_SHARED_CREDENTIALS_FILE AWS_CONFIG_FILE AWS_CREDENTIAL_FILE \
  AWS_WEB_IDENTITY_TOKEN_FILE AWS_ROLE_ARN AWS_ROLE_SESSION_NAME \
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI AWS_CONTAINER_CREDENTIALS_FULL_URI \
  AWS_CONTAINER_AUTHORIZATION_TOKEN AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE
node --import tsx apps/agent-router/src/main.ts
```

不要再给上述进程添加 `--env-file=.env`，否则会把已经移除的authority再次注入。router会对任何残留的runner-only变量（即使值为空）fail closed；若项目以后新增此类配置，手工列表也必须同步，不能靠应用忽略。当前`pnpm --filter @agent-service/runner start/dev`会整体加载`.env`，在其中配置了platform token时不再是安全等价入口；首选仍是统一脚本。

上面的普通runner启动有意清除first-admin变量。若要执行一次受控bootstrap，只在该单次命令中同时注入`ADMIN_BOOTSTRAP_TENANT`和预创建owner-only目录下的绝对`ADMIN_BOOTSTRAP_OUTPUT_FILE`，不要把它们长期写入`.env`；文件存在时不会覆盖。读取并验证key后立即撤销两个变量，且不要用shell trace、`echo`或日志采集暴露文件内容。

生产构建使用：

```bash
pnpm build
```

等价顺序：

```text
构建 @agent-service/sdk
node scripts/build-app.mjs agent-runner
node scripts/build-app.mjs agent-router
```

SDK与两个应用的六个JavaScript入口分别生成：

- `packages/sdk/dist/` 中的 JavaScript、类型声明及 source maps；
- `apps/agent-runner/dist/main.js`；
- `apps/agent-runner/dist/blob-storage-migrate.js`；
- `apps/agent-runner/dist/restore-ledger-reconcile.js`；
- `apps/agent-runner/dist/backup-catalog.js`；
- `apps/agent-runner/dist/telemetry-capture.js`；
- `apps/agent-router/dist/main.js`；
- 对应 source map、`dist/package.json` 和 SQL migrations。

这些是 Node 24 的单文件 ESM bundle，不是 Windows `.exe` 或 Linux ELF 原生机器码。runner的五个入口由同一次`build-app.mjs agent-runner`构建；`main.js`是长期服务，`blob-storage-migrate.js`、`restore-ledger-reconcile.js`、`backup-catalog.js`和`telemetry-capture.js`都是显式调用的一次性维护CLI。构建会内联`@agent-service/*` workspace代码和runner所需的纯JavaScript AWS SDK完整闭包；MySQL、Redis等其余第三方依赖仍由production `node_modules`提供。因此单独复制任一`dist/*.js`仍不是完整的裸VM发布包。

`pnpm build:check` 在 `pnpm build` 之后还会：

1. 对 SDK 执行真实 `pnpm pack`，在隔离 consumer 中验证包名 import 和 TypeScript 声明；
2. 分别以`pnpm check:blob-storage-migrate-artifact`、`pnpm check:restore-ledger-reconcile-artifact`、`pnpm check:backup-catalog-artifact`与`pnpm check:telemetry-capture-artifact`确认四个one-shot产物存在，并用原生Node执行各自稳定`--help`入口；
3. 用原生 Node（不使用 `tsx`）启动 runner/router bundle；
4. 验证 readiness、capabilities、router 转发、两端 OpenAPI 精确一致，以及 router 保持 platform tenant-erasure 鉴权边界。

router拒绝raw restore-journal identity、endpoint与credential的配置边界由
`apps/agent-router/test/config.test.ts`在常规测试套件中验证；当前dist boot只以清理过的
环境启动bundle，不把这项源码配置测试冒充为发布产物运行时探针。

M4的Node24目标平台目录包已实现`bundle + migrations + 完整production node_modules + manifest`及非root systemd样例，并具有macOS arm64双包历史证明；受限tar、独立Node工具与离线VM签名现为本地候选，具体通过状态看PROGRESS。生产信任根/密钥管理、OCI签名、环境晋级、真实systemd/生产无DDL启动和本批Linux CI仍不能借既有OCI镜像的成功冒充完成。

这里有三种容易混淆的运行/交付形态：

| 形态 | 实际内容 | 适用场景 |
| --- | --- | --- |
| 本地源码进程 | `node --import tsx` 直接加载 `apps/*/src/main.ts` | 日常开发、调试；本节的直接启动和`local-service.sh start`不会自动热重载。包级`pnpm dev`使用`tsx watch`，但会整体加载`.env`，须先满足前述authority隔离要求 |
| Node 应用发布包 | runner `main.js` + `blob-storage-migrate.js` + `restore-ledger-reconcile.js` + `backup-catalog.js` + `telemetry-capture.js`、router `main.js`，外加目标OS/CPU完整production dependencies、migrations与manifest | 两个长期进程；四个维护CLI仅前台按需调用。目录包/systemd样例已有本地证明；受限tar/独立工具及离线VM签名为候选，生产信任根/环境晋级或生产托管未完成 |
| Linux OCI 镜像 | Node 24 slim + 对应应用入口 + production dependencies + migrations；runner镜像额外包含四个one-shot CLI | staging/production 推荐交付物，可分别部署到不同 VM、容器平台或 Kubernetes workload |

因此“router/runner 不可变镜像”表示镜像内容在构建后不再修改、环境间使用同一 digest；它不是 Windows 镜像，也不是把 TypeScript 编译成 Linux ELF 或 Windows `.exe`。router 和 runner 确实是两套可独立启动、独立扩缩容、可部署到不同机器的 Node 应用，但镜像通常比手工分发裸 bundle 更容易保证 Node 版本、依赖、迁移与健康检查完全一致。若目标机器不能运行容器，可以部署完整 Node 发布归档；不能只复制一个 `main.js` 就称为完整发布。

无论使用裸进程还是镜像，部署的产品应用仍然只有 router 和 runner。MySQL、Redis、S3-compatible对象存储和KMS是外部基础设施；SDK和内部workspace package不是常驻服务；各类dispatcher/worker在runner进程内运行，不需要额外部署第三个应用。mover、restore reconciler、backup-catalog与telemetry-capture CLI随runner发布，但只在受控维护窗口按需执行，不注册为额外常驻服务。local Compose/CI为验证S3协议构建MinIO基础设施，不会把它当成agent-service产品镜像发布。

## 8. GitHub Actions 构建与验证

`.github/workflows/ci.yml` 对 push 到 `main` 和 pull request 运行。

### 并行 job 与最终汇总门禁（候选，真实 CI 结果见 PROGRESS）

工作流有四个job定义；`image`展开为两个实例，实际共五个检查。每个重型job使用独立GitHub runner和自己的服务容器，不共享MySQL、Redis、MinIO或测试目录；旨在缩短串行等待，实际收益待新CI测量，不减少测试或改动每例deadline。core与history均保留原180分钟job上限，不以缩短上限代替提速。

| job | 验证范围 | 资源 |
| --- | --- | --- |
| `test-core` | 扫描、API/typecheck、单次main coverage及逐文件证明、全部专用S3、cluster、SDK/bundle、VM双包 | MySQL 8.0.26、Redis 8、固定官方commit构建的MinIO |
| `test-history` | 原完整历史迁移/冻结binary required wrapper | 自有MySQL 8.0.26、Redis 8及不同名test库；不依赖core完成 |
| `image`（两实例） | router/runner Linux OCI真实构建、plain Node维护入口及容器health/API/bootstrap验证 | 每实例自有MySQL 8.0与Redis 8 |
| `test` | 等待core、history、image全部成功的聚合门禁 | Node24，无服务容器 |

保留原`test`检查名称供现有保护规则使用，但它现在是汇总而不是长串行执行器。它用job级`always()`保证依赖失败/跳过时仍检查；`scripts/assert-ci-required-jobs.mjs`只接受exact三项`needs`且全部`result=success`，failure/cancelled/skipped、缺/多job或损坏JSON均拒绝，不打印outputs。GitHub的[needs context](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#needs-context)描述各依赖result；[依赖执行规则](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-jobs#defining-prerequisite-jobs)说明依赖失败或跳过时需要显式条件继续。任何分支保护、运行耗时和Linux成功状态仍须核对实际新run，不因本地静态检查就声称已生效或提速。

### `test-core`：主测试与实际构建

1. 凭据扫描、frozen-lockfile安装、OpenAPI/生成SDK漂移与源码/测试typecheck。
2. `pnpm test:coverage`只跑一次main profile。独占本轮JSON与真实子进程退出状态证明每个required文件唯一、非零、全passed；具名group仅是同一执行的子集，不再另外重复跑同profile的几十个named命令，coverage门槛不变。当前manifest包含124文件（含本次CI汇总回归），62个旧group不变；数量和实际通过只看PROGRESS/当次报告。
3. 保留全部需要专用flag的真实S3/MinIO套件：Blob、mover、restore journal、backup catalog/reconcile/旧快照roundtrip/加密制品、managed telemetry writer、真实HTTP→PiEngine→MySQL→MinIO capture、GET-only observer及非生产journal。五bucket共享同机MinIO，只证明协议，不证明云IAM/KMS或独立故障域。
4. broad cluster运行真实多进程接管与隔离；另保留T3g cluster exact报告，证明mixed-worker/namespace/fleet矩阵零skip。它不是managed Redis Cluster灾备证明。
5. `pnpm build:check`构建SDK、runner/router bundle并启动plain Node；四个维护CLI另有具名artifact检查；dist runner/router还在临时MySQL/MinIO上做应用装配smoke，凭据只给runner。
6. `pnpm check:vm-release --artifacts ...`在clean commit构建目标平台完整依赖闭包与受限tar/独立工具。当前签名checker只用ephemeral-test-only key；从签名解包目录运行四one-shot/current alias及双main，然后重新验完整清单，不安装或晋级生产。
7. 保存coverage与验真后的双role VM归档/tool/proof。artifact留存不是可信生产签名或环境晋级；失败/未执行不能由旧artifact代替。

类型检查不生成最终应用bundle：`pnpm typecheck`检查八个workspace的源码和测试；`pnpm build`实际执行`scripts/build-sdk.mjs`与两次`scripts/build-app.mjs`。runner五入口为main、blob-storage-migrate、restore-ledger-reconcile、backup-catalog、telemetry-capture；router只有main。内部workspace内联、production依赖闭包按目标平台提供，AWS SDK装配与plain Node验证仍有门禁。服务/入口/镜像仍为2/6/2。

### `test-history`：完整历史前态，而非fresh-schema替代品

独立runner以`fetch-depth: 0`取旧commit、同一Node24/pnpm12.5.1与frozen-lockfile安装，创建`agent_service_test_history`，执行原样`pnpm test:migrations`。它不带文件过滤、skip或宽松flag，wrapper清单与磁盘双向一致，逐文件必须非零passed/零其它状态；执行报告独立保存为artifact。测试内部仍串行，各case照旧创建/清理自身UUID隔离库，不把同一个MySQL实例上的DDL改为并发。

历史链覆盖0007→0008的usage相同重复合并/冲突阻断/legacy pending保留，以及后续各schema迁移至0054、0043代码兼容、冻结0039/0040/0041 terminal和冻结0052 binary来源。SQL-shaped旧状态与真正旧executable夹具必须分别陈述；不能把fresh schema或旧零telemetry terminal外推到其它历史状态。0054新增nullable列后，冻结夹具仍按原旧schema完整列集合逐行比较原字节，不改旧hash，且新证据缺失保持unknown。

把历史工作移至另一个runner不改变grant/自动清理/外部对象处置gate、旧writer排空、forward-fix或全域completion=false。所有最终CI状态都由`test`汇总；image两实例同样必须成功。

### `image` matrix job 的两个运行实例

CI 用同一个 Dockerfile 分别传入：

```text
APP=agent-runner
APP=agent-router
```

得到两个独立 Linux OCI image：

```text
agent-service/agent-runner:ci
agent-service/agent-router:ci
```

每个产品镜像都包含 Node 24 slim、对应应用入口、迁移和 production dependencies，是 Linux OCI image，不是VM磁盘或原生机器码。GitHub Actions分别启动两个镜像并检查OpenAPI/healthcheck；镜像job不运行router与runner双容器转发，该端到端路径由`build:check`的dist双服务启动测试覆盖。runner镜像内迁移器必须写入包含最新`0049_tenant_telemetry_application_capture_v2.sql`、`0050_ordinary_session_delete_grace.sql`、`0051_ordinary_session_delete_origin_guard.sql`、`0052_ordinary_session_usage_retention.sql`、`0053_persisted_provider_failure_capture.sql`及`0054_tenant_telemetry_retained_source.sql`的完整marker链（0054另用精确COUNT=1断言），并用plain Node验证四个one-shot CLI的`--help`。生产first-admin bootstrap只通过create-only、`0600`输出文件交付，CI验证key格式与鉴权且日志不含key或tenant原值。marker只证明0044 pre-grant、0049 inactive capture v2 guards、0050普通DELETE保留证据列、0051 write-once guard及此前默认休眠schema已安装，不代表capture已激活、DB grant可信、CAS tombstone已执行、旧快照已安全恢复或任何物理purge已完成。产品构建仍只有router和runner两个长期服务、两个Linux OCI镜像、六个JavaScript入口：router `main.js`，runner `main.js`、`blob-storage-migrate.js`、`restore-ledger-reconcile.js`、`backup-catalog.js`和`telemetry-capture.js`；本地MinIO基础设施镜像不进入产品matrix。

当前 workflow 使用 `load: true` 供本 job 启动验证，没有把镜像 push 到 registry。SDK `.tgz` 也是临时验证后删除；当前配置上传coverage及验收通过的VM双role归档、独立工具和proof（VM artifact保留14天）；是否实际生成必须核对main对应run。签名候选的CI/checker仅使用ephemeral-test-only密钥，dirty-development profile明确未执行签名；artifact或测试签名都不是生产trust root/密钥管理或环境晋级。

## 9. 从本地到未来生产的交付语义

### VM进程包与镜像的区别

M4候选提供`package:vm`、`package:vm-transport`、`sign:vm-release`、`test:vm-release`和`check:vm-release`，详细命令及安全边界见[VM进程发布包地基](local-and-deployment.md#vm-进程发布包地基)。VM目录包含同一router/runner JavaScript bundle、完整production依赖、迁移和对应systemd样例；容器镜像还封装Node与Linux文件系统。VM目标主机必须另有Node24，不能只复制一个`.js`文件或在目标上重新装依赖。

应用本身不是独立ELF二进制，但真实production闭包中存在esbuild原生程序。因此VM包按Linux/macOS与x64/arm64构建和验真，不能把本机macOS包直接部署到Linux；Linux构建由Linux环境完成。常驻服务仍只有router与runner，runner四个维护CLI不变成新服务。`publishable=true`只表示清洁commit构建的可追溯候选，不是生产许可；`productionAccepted=false`固定，Windows不在当前受支持target集合。受限tar及离线VM签名已有本地候选；systemd实机验收、生产签名信任根/密钥管理、OCI签名与环境晋级仍缺。

离线签名的学习顺序是：先在可信构建主机形成clean/目标平台匹配的release与tar，再以`sign:vm-release`的八个显式flag和owner-only Ed25519私钥文件签名；目标主机先通过独立受信任的`RELEASE_TOOL_SHA256` bootstrap工具，再用预先提供的SPKI DER公钥pin、选定role与精确`RELEASE_SOURCE_COMMIT`运行`inspect-signed`/`unpack-signed`。完整占位绝对路径命令见[离线VM发布签名](local-and-deployment.md#离线-vm-发布签名)。不要运行未知tool让它认证自身，不从待验证sidecar自算值替代authority；signed命令没有`--tool`覆盖或unsigned fallback。签名绑定copied inputs/lock、manifest/archive/tool、target runtime与归档规模，output创建前完整核对，解包再次以签名archive hash认证同次私有copy；失败不变成安装、DDL、应用启动或晋级许可。

独立bundle冻结原四个工具源码加`vm-release-signature.mjs`、`vm-release-signed.mjs`共六源，并逐字节绑定release input清单与未变的root依赖字段/lock；不新增依赖、应用dist入口、常驻服务或镜像。sign/inspect/unpack各有协作式120秒预算，工具自hash预算独立；native FS不能硬取消，仍要求可信本机/受控parent，不抗恶意same-UID替换。此能力不管理生产key、不证明freshness/revocation/通用防重放或生产trust root；OCI签名、自动promotion、托管与真实环境验收仍另行交付。CI/checker只生成临时测试key，dirty profile明确不签名。

候选CI与本地verify分别包含必执行安全/快照测试和真实双发布目录plain Node smoke；CI要求clean commit，本地verify允许copied-byte dirty开发快照，后者不会获得签名许可。该smoke使用独立临时目录及memory后端，不加载`.env`、触达MySQL/模型或安装服务。两包commit、实际输入/lock摘要必须一致；运行后重验完整清单未改变。本轮私钥格式正则修订后的9文件相关重验已通过；代码`d671632a26f42cee146e3e27384cb46834aecde3`的严格clean双包也于07:35:46.954Z实际通过，target为darwin/arm64/Node24，两个role均sourceDirty=false/publishable=true、signatureProfile=ephemeral-test-only、productionAccepted=false。双sign、独立bundle inspect/unpack、wrong pin/commit无output、四个one-shot/current alias与双main readiness/auth/forward/OpenAPI及stop后目录不变均通过；报告为`.local-run/vm-release-proof.signature-d671632-20261015.json`。后续文档commit会改变HEAD，不能把本代码commit的装配证明当成最终新SHA完整verify或新Linux CI；详细归档位置与限制见[部署契约](local-and-deployment.md#离线-vm-发布签名)。

0053仍只允许本地非生产启用，不能把本节的未来生产交付顺序当作其生产许可。升级前保持capture、ordinary usage及相关T3d/T3f gate关闭，真实摘流、停止并排空全部pre-0053 router/runner/writer和在途事务；独立migration安装160相关组合指纹（不是662全库trigger数），只启动0053-aware版本，禁止旧新writer热混跑。既有0049文件不可重写，后续只能forward-fix。默认control休眠与历史NULL/0 source不回填；active0030 primary是后续local activation前提，新的runtime epoch不能自动继承capture binding。原始failed-step提交、fresh fleet四worker边界、first create live检查与历史exact ACK权限仍需分别验证；局部writer ACK不解除T3d/T3f第六来源硬拒、usage来源删除禁令或全域completion。

0031的外部catalog authority不是“所有对象都不可变”：event objects是create-only不可变链，另有一个固定key的可变`If-Match` CAS head作为唯一尾部；LIST不参与authority。启动会实际验证`If-None-Match: *`、正常CAS和陈旧ETag拒绝，event/head间响应丢失用精确下一sequence恢复。生产IAM需要允许受控operator对head做条件覆盖，同时禁止其它writer覆盖event/head；versioning、lifecycle和Object Lock保持关闭。CI/本地MinIO会执行这些协议测试，但不能替代managed存储/IAM验收。

容器形态的目标 promotion 链是：

```text
本地开发与定向测试
→ 本地完整 verify
→ GitHub Actions 全部门禁
→ 构建一次 router/runner 不可变镜像
→ 同一 image digest 部署 staging
→ 预发验收
→ 同一 digest 灰度到 production
```

staging/production 不重新编译镜像。环境差异只通过受控配置和 Secret 注入；两个环境不共享 MySQL、Redis、对象存储、密钥或 service key。

VM形态须在同一次CI构建中分别形成router/runner完整发布归档，固定Node24 target runtime、production dependencies、迁移文件及每个文件校验和/发布包身份；staging验证后，将**同一发布包身份和校验和**晋级production，不在环境中重新安装依赖或重新打包。目录/受限tar/独立工具已有历史本地证明，离线签名候选不能借旧完整验收或其它SHA的Linux CI成绩发布。工具必须先经独立可信tool摘要验证；无签名模式仍需外部可信archive/manifest摘要，signed模式则需独立公钥pin/选定role/commit并完整验证签名中的同一provenance，包内sidecar不能自认证。候选artifact及ephemeral测试签名不是生产trust root、生产许可或已实施晋级。systemd托管、进程排空与一次性迁移入口仍须独立发布/验收；见[VM发布包契约](local-and-deployment.md#vm-进程发布包地基)。

用户选择M4同时提供两种交付形态：容器按router/runner Linux OCI同一digest晋级；虚拟机用相同六个应用入口（runner main与四one-shot、router main）和受控Node24 runtime，两个服务独立运行。两者复用协议、迁移门禁、配置/Secret与验收。VM目录验真、受限归档运输与离线签名已有本地候选，本轮d671632严格clean装配已通过；最终HEAD完整验收/新CI、进程托管/滚动、生产trust root与容器签名、部署清单、环境晋级仍待，不能把源码开发脚本、单平台本地目录包或CI测试镜像当成生产验收完成。归档/签名是离线发布工具，不是新增产品daemon或镜像。

这仍是目标流程，不是当前可直接执行的生产部署手册。现有runner连接默认会应用schema migration，而严格启动检查又依赖读取MySQL trigger元数据；本机MySQL 8.0.26实测`SELECT`-only账号无法通过`INFORMATION_SCHEMA.TRIGGERS`或definer view看到已有trigger，授予`TRIGGER`则也能删除它。M4还须先以受限definer procedure等可信只读桥接完成无DDL账号的严格指纹校验和真实MySQL回归，再交付独立一次性schema-migrate Job、生产verify-only启动及镜像入口。没有这些门禁和真实环境资源时，不应把当前CI镜像直接称为已完成的staging/production部署方案；详见[部署契约](local-and-deployment.md)。

tombstone 保持在 exact protocol family `2026-10-08`，作为 additive capability 激活。发布时先由 API gateway 暂停精确 session DELETE（或整体切换 router 池），部署新 router 且保持 `SESSION_TOMBSTONE_ENABLED=0`，排空全部旧 router，再滚动新 runner；确认每个健康 runner 都声明 `tombstone` 后才把新 router gate 设为 `1`。router 会在显式 gate 之外持续检查全健康 fleet，任一健康旧 runner 存在时 DELETE 都返回可重试 `503`。仅逐个替换旧 router 而不先阻断 DELETE 不安全，因为旧 router 没有这个 gate；runner 端口也必须保持内网不可直连，否则会绕过 router gate。

这套 activation gate 只覆盖同一 protocol family 内的 additive tombstone rollout。未来真正改变 protocol version 时仍需全量 drain 的维护窗口协调切换或整组 blue-green，除非再实现 version range/按版本路由。

Blob写入采用`0010` ownership manifest/outbox、`0027` default-dormant write-once storage control和`0028` offline mover三层边界。先应用`0027`/`0028`，发布理解S3 capability、双runtime migration gate与mover ledger的新router/runner，但保持Blob/export/T3e gate关闭并彻底排空pre-0028 writer；独立验证private、unversioned、无Object Lock、无lifecycle规则的bucket，以及条件PUT/CAS、强读和服务独占写权限。空库可用完全一致的`BLOB_NAMESPACE_ID + bucket + prefix`直接启动S3 runner并激活generation 1。非空filesystem deployment必须进入全停机维护：摘流并停止全部router/runner，等active turn、worker claim、I/O和lease排空，使用唯一migration id与外部fleet-drain evidence执行`prepare → copy → verify`，等待数据库rollback window；每次外部对象mutation由migration-control行共享锁和named-lock前后核验保护，cutover前可abort，cutover后只能forward-fix；显式`cleanup-source`完成前`committed`状态仍拒绝runner启动。恢复后核对全fleet `blobStorage` capability精确一致，再先开cleanup/build worker，最后开admission/writer gate。两次startup gate都不会驱逐存活进程，故真实stop/drain不可省略；router可负责摘流但不参与mover，也不应持有`MYSQL_URL`或storage credential。filesystem `BLOB_DIR`不能通过复制到多台VM、hostPath、NFS或各Pod独立卷伪装成共享对象存储。

`0028`只搬MySQL ledger中live/open-intent记录精确授权的对象；它不会遍历或证明任意未知root文件。每个attempt必须使用全新target namespace，abort通过同key conditional PUT/CAS永久tombstone封住本attempt对象而非硬删，不能假设`DeleteObject If-Match`存在。当前全量内存集合、大事务与全范围锁只构成本地/CI正确性基线；真实数据量下的停机窗口、内存、锁等待/死锁、网络、容量、IAM、source备份及失败恢复必须在staging演练后才能promotion。

S3 startup会自动验证reachability、versioning/Object Lock关闭、bucket无lifecycle规则、`If-None-Match`/`If-Match`和探测对象删除可见性，但不会跨所有供应商自动证明bucket policy/IAM私有，也不能阻止启动后有人新增lifecycle规则或绕过服务改写对象。production的`BLOB_S3_PRIVATE_BUCKET_ACK=1`必须由operator在独立anonymous/public-access检查与权限审计后设置；IAM还必须拒绝未经发布流程的lifecycle配置变更和外部对象写入。该ACK是人工确认，不是自动attestation。本地/CI真实MinIO套件会执行匿名raw GET拒绝用例，但该结果不能替代目标云bucket的证据。

user erasure 与 legacy compensation 共用新的 v2 expand→activate barrier：先应用 `0011`/`0012`/`0013`、dormant expand-only 的 `0014`，以及同样 expand-only 的 `0015`，部署只接受 v2 私有 control ACK 的新 router并保持 `DATA_ERASURE_REQUESTS_ENABLED=0`，排空全部旧 router 与只认识 v1 的旧 worker并等待旧 lease 到期；再以两个 worker flag 都为 `0` 的状态滚动具备 `drain-v1`、`quarantine-v1` 与 legacy compensation 代码的新 runner。`0014` migration 只安装 inactive cutover、durable job/audit 和 guards，不排队、不改 session、不激活 purge；`0015` 也不创建默认 active policy、不改绑历史 request、不开放 purge。旧 v1 endpoint 故意 404，不能当作兼容 fallback。

确认 fleet 都是新 binary 后，再逐实例设置 `LEGACY_TOMBSTONE_COMPENSATION_ENABLED=1`；启用的 runner 才声明 `legacy-tombstone-compensation-v1`。部分 rollout 期间 v2 barrier保持关闭，直到 router 在本进程观察每个稳定 `RUNNERS` 地址同时声明 `quarantine-v1` 与 `legacy-tombstone-compensation-v1`，才返回 token-protected `job-control-v2` ACK。观察后纯不可达保留进程内 attestation，明确旧版/错误响应则撤销；router 重启会丢失 attestation并安全暂停 claim，直到地址恢复或从配置移除。compensation worker 首次获得 ACK 后会激活 write-once cutover；从该线性化点开始数据库拒绝新的 generation `0` tombstone 写入，故不能回滚 pre-`0014` writer。随后才按需启用 `ERASURE_WORKER_ENABLED`，确认 configured fleet当前全部健康并声明`dataErasureRequests`后，最后依次启用runner、router writer gate。产品环境的两个 worker与 admission都默认 `0`；本地统一脚本显式启用两个 worker但保持 admission `0`。

`0015` 的管理面采用独立的 expand→code-aware→management-active 顺序。先发布新 router 并保持 `DATA_GOVERNANCE_MANAGEMENT_ENABLED=0`、排空旧 router，再滚动同样保持 management=`0` 的新 runner；此时新 runner 已理解 policy/hold durable contract，必须在管理端点关闭时仍声明 `dataGovernance=["canonical-retention-v1","multi-legal-hold-v1"]`。确认每个 configured 稳定地址都健康并声明这两项后，才逐实例开启 runner management gate，最后开启 router gate；只有全部目标的 `dataGovernanceManagement=true` 时，router 才开放 8 个 admin API。runner 端口必须继续限制为内网可达，不能绕过 router 的 fleet gate。

policy activate 是提交即生效的 generation CAS，不提供未来时间调度。`effectiveAtMs` 是锁内单调化的审计/控制时间，不是一个等待执行的计划时间；activation 与新 erasure admission 通过 tenant control lock 线性化，后提交的新 request 永久绑定 active version/hash，先提交的 backlog及其幂等 replay保持原身份。`0015` 在 `erasure_requests` 上安装冗余 `BEFORE INSERT` guards，并在同一 policy control 上取共享锁：dormant 时只接受 `NULL/NULL`，active 后只接受精确 version/hash。因此即使 health probe 后稳定地址被换成旧 binary，绕过新版应用的 pre-`0015` writer也只能让事务失败，不能静默留下未绑定或错绑 request。

首次 policy activation 或 canonical legal-hold control event 提交后，0015 成为 forward-only 兼容边界：关闭 management/admission gate只能停止新管理请求或新 erasure request，不能取消 active policy、active hold 或现有 request binding；不得回退到不会验证 canonical ledger、不会绑定 policy 的 pre-`0015` reader/writer，也不得删除 control/event、清空 policy identity 或做 down migration。一个 hold 的 release 不影响同 subject 的其它 active hold，故障恢复必须保留 durable evidence 并 forward-fix。

`0016` evaluator使用另一条expand→code-aware→active边界：先应用destructive-dormant migration，再发布`PURGE_POLICY_EVALUATOR_ENABLED=0`的新router并排空旧router，滚动同样gate=`0`但声明`policy-evaluator-v1`的新runner。确认每个configured稳定地址当前健康且code-aware后，逐runner开启evaluator，最后开启router gate；每次schedule/claim仍必须取得token-protected固定ACK。公开`purgePolicyEvaluation`只表示fleet awareness，`dataPurgeExecution=false`才是当前执行边界。关掉gate只停止新的evaluation pass，不删除job/decision/authority，也不撤销subject gate。

`0016` authority不能直接用于purge：eligibility由runner wall clock记录，per-session target也不是turn/item/event/approval的完整owner inventory。`0021` T3c已独立使用数据库时间与canonical hold重验并写入结构完整的`session_content_receipts`，但不会把0016与0021 evidence自动合并为执行许可。`0023` T3e另用双默认关闭gate，在自己的执行边界重验T3c/T3d、policy/hold、owner和lease并完成local usage/Blob/export子集；`0024` T3f再原子清理11个数据库投影；`0025` T3g最后清理session-scoped Redis三域；`0027`只约束shared Blob namespace，`0028`只提供离线搬迁证据，`0030`保护进入独立journal的tenant T1 fence并建立恢复lineage，`0031`则约束可恢复backup选择、source binding、retention和epoch reservation，`0032`～`0035`安装safe ingress、default-dormant lifecycle activation/inventory/writer substrate与分域producer capture。后续完整全域executor仍要核对external/KMS、backup内tenant erasure与其它domain恢复证据、logs/traces writer/sink/delete/restore/ACK、managed对象存储/IAM环境proof和其它completion ACK。当前completion固定为false；live evidence或hold generation/projection变化会让旧active projection失效并以新build generation重评，而不是覆盖旧证据。

`0017` export采用expand→code-aware→worker→admission边界：先迁移，再部署admission=`0`的新router并排空旧router，随后滚动admission=`0`但声明`artifact-ndjson-v1`的新runner。local filesystem单runner可以先开启cleanup、再开启build worker，最后开启runner/router admission；production filesystem仍会fail closed。S3模式必须先完成空库`0027`activation或非空库`0028`离线cutover，再以同一image digest在staging验证跨runner可见性、条件发布、snapshot namespace pin、下载lease与TTL/撤销删除竞态，之后才开admission。关闭admission只停止新POST，已有job、status、download和cleanup继续forward-fix；不能用NFS或各Pod本地目录模拟共享数据面。

`0018` 仍是 tenant erasure 的 expand-only 存储边界：新增独立、append-only 的 `tenant_erasure_admissions` 和 `tenant_credential_revocation_fences`，不向 `erasure_requests` 写 tenant row，也不修改其历史 trigger。固定 `0017` 真实 MySQL 夹具证明旧 worker 的 claim 扫描只能看到原 user queue、旧 user scheduling 保持不变，且 partial-DDL 或 marker 丢失后重放不会失去 append-only 保护。T2 的安全 rollout 是：`0018` expand → 新 router 以 tenant gate=`0` 上线并排空旧 router → 全部新 runner 以 gate=`0` 上线 → 逐 runner 开启 local admission capability → 核对全部 configured 稳定 target → 最后开启 router gate。不得在 pre-`0018`/T2 mixed fleet 提交 tenant admission；runner 端口也必须保持内网受控。

`0019` T3a使用另一条独立rollout：expand migration → 新router以`TENANT_CREDENTIAL_REVOCATION_EXECUTION_ENABLED=0`上线并排空旧router → 全部新runner以`TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED=0`上线但声明`credential-store-v1` → 逐runner开启worker → 核对全部configured稳定target健康且worker-active → 最后开启router execution gate。worker在materialize/claim与紧邻不可逆事务前都需要fresh barrier；旧`0018` admission只由显式proof-checked materializer补job。首个receipt激活cutover后不能回退pre-`0019`，只能forward-fix。

在开启上述T3a worker/execution前，`0026`还要求独立的expand→ledger-aware→old-writer-drain→tracking-activate阶段：先应用default-dormant migration；以`CREDENTIAL_LIFECYCLE_TRACKING_ENABLED=0`部署全部新router/runner，完全排空pre-0026 writer并核对每个configured runner声明`versioned-target-ledger-v1`；再显式启用runner tracking，让一个实例完成write-once cutover，并确认所有实例观察`tenantCredentialLifecycleTrackingActive=true`；随后开启router tracking gate，最后才开放T3a execution。activation固定在T3g durable restore preflight之后、bootstrap mutation/worker/listener之前；restore、tracking读取或activation阶段失败会关闭当时已创建的store/lease/bus/adapter，commit后响应丢失只能独立重读active恢复；后续bootstrap、应用装配或listen失败不在该显式清理边界内。cutover后的provider/auth写必须CAS双写version/target ledger，旧writer只能fail closed。当前没有独立fleet-barrier activation Job，因此production误开flag会形成forward-only可用性事故；严格排空旧writer是必要条件，M4应把activation提升为显式、受审计的发布步骤。

`0029` external target execution采用独立的expand→code-aware→worker→execution-gate顺序：应用migration后先以router gate=`0`替换并排空旧router，再滚动worker=`0`但声明`external-credential-execution-v1`的新runner；全部configured稳定地址健康后逐实例开worker，最后开router gate。每个materialize/claim/renew/adapter mutation/seal边界都取fresh ACK，首个receipt/cutover后只能forward-fix。当前唯一fake只允许Memory与非production，因此标准MySQL local-service固定双gate关闭；真实provider adapter完成安全审计和staging故障验证前不能启用，KMS始终不在该执行切片内。

`0030` restore journal采用default-dormant expand→code-aware→停服primary activation→publisher→execution-gate顺序。先应用migration；发布`TENANT_RESTORE_JOURNAL_EXECUTION_ENABLED=0`且只持有三个非密钥identity digest的新router并排空旧router；再以完整runner-only journal target配置、`TENANT_RESTORE_JOURNAL_WORKER_ENABLED=0`滚动新runner，并彻底排空所有pre-0030 writer。独立验证目标是真实、private、支持immutable create-only record与条件head CAS且位于primary database之外的故障域，确认每个configured runner声明同一`independent-restore-journal-v1` target/runtime identity；随后摘流并停止全部writer，核对外部head精确为空且库内没有任何pre-journal terminal T3a receipt，才同时提供`RESTORE_JOURNAL_PRIMARY_ACTIVATION_ACK=1`、`RESTORE_FLEET_STOPPED_ACK=1`及显式Blob backend执行一次`activate-journal`。filesystem声明`BLOB_STORE=filesystem`；S3声明`BLOB_STORE=s3`和与journal bucket不同的`BLOB_S3_BUCKET`，缺失或无法证明分离时会在连接MySQL/S3前fail closed。activation将journal control与primary runtime epoch在一个MySQL事务中写成forward-only边界；此后所有runner都必须配置exact target并保持publisher worker开启。最后逐实例以worker=`1`恢复runner，保持router gate=`0`核对全fleet identity/worker-active，再开启router gate。gate关闭只能暂停新的materialize/claim/外部publication，不能撤销已写journal、永久fence、ACK或runtime lineage；恢复时必须继续forward-fix。

真正的restore必须停掉并排空所有router/runner/旧writer，先用`0031 prepare-restore`从外部catalog已绑定operator/producer-attested digest、仍可恢复且未淘汰、并在当前数据库中保留exact local anchor的entry选择来源，再在外部catalog永久预留never-used runtime epoch，把精确backup/run/epoch ID、source evidence和target identity保存在数据库故障域之外。adapter只验证摘要与chain identity，不读取或证明物理backup内容；operator仍须独立验证实际制品。按该绑定恢复并验证数据库备份、由独立migration Job升级/验证schema后，必须以完全相同的输入再次运行0031 `prepare-restore`，让external chain/reservation exact replay并原子重建旧快照缺失的本地entry/binding/reservation/run；active catalog会拒绝在此前直接执行普通0030 prepare。若恢复快照缺少selected anchor，就必须换回包含该anchor的快照，不能改选backup/epoch；也没有external-only orphan reservation abort。应用仍无法区分正确的selected物理快照与包含该anchor的更晚合法快照，operator/backup producer必须以物理snapshot/provider evidence独立核验，这是P1级流程/attestation风险。one-shot restore CLI只用verify-only store连接，缺任一migration即fail closed且绝不执行DDL，0030 marker存在时还校验精确schema/trigger fingerprint并在结束时恢复临时MySQL session设置。随后CLI按`replay-fences → verify`逐条安装永久tenant fence并seal evidence；`run`可把已由0031重建的prepare作为exact replay后组合这两步，但不激活runtime。operator审阅后另行执行`activate-runtime`，再用`0031 resolve-restore`按同一run精确投影`activated`；中止时投影`aborted`。之后以新的epoch digest、相同journal target和router gate=`0`部署全量writer，通过startup preflight及exact fleet核对后才开放publisher gate与其它破坏性gate。`abort`只适用于activation前，不能移除已重放fence或复用已烧毁epoch。restore S3 client忽略AWS环境变量/shared profile endpoint；target identity绑定受控region及normalized custom endpoint或standard-endpoint模式。当前跨MySQL/S3边界仍是exact-idempotent saga而非分布式事务，runtime/catalog各只支持一个target，多个关键条件仍靠人工ACK；0030 activation前external-head读取到DB commit仍有TOCTOU窗口，chain分页扫描为`O(n²)`对象读取且只有逐请求deadline、没有whole-operation统一deadline。0031在独立catalog证据存续时关闭了手填游离backup digest与epoch ABA的协议缺口，但不创建物理backup，也不证明真实独立故障域、容量、RPO/RTO或backup内tenant erasure；local MinIO即使使用第三个不同名bucket也只是协议模拟，不能把0030/0031宣称为完整生产backup/DR。

`0031` backup catalog采用default-dormant expand→离线目标验证→one-shot activation边界，不新增rolling worker。先应用migration并部署包含`backup-catalog`入口的新runner发布物，长期router/runner保持全部`BACKUP_CATALOG_*`、`TENANT_BACKUP_CATALOG_*`及catalog操作变量被剥离；再独立验证catalog bucket、namespace、failure-domain identity、private access及其与primary database/0030 journal/0027 Blob target的隔离。随后停服并以显式ACK运行一次`activate`。每个backup按`begin-backup → 外部创建并独立验证full backup → 只提交attested digest的publish-backup`；restore按`恢复前prepare-restore → 物理恢复/升级验证 → 原ID/evidence再次prepare-restore → 0030 replay/verify/activate-runtime → resolve-restore`。generic reconcile会完整镜像外部链并可重建availability/eviction，但不会生成selected restore所需的local anchor、binding、reservation或run。eviction从`prepare-eviction`前开始停服，经过外部物理删除到`record-eviction`提交后都不得恢复writer或并行operator，两条命令均要求人工`RESTORE_FLEET_STOPPED_ACK=1`；当前没有durable two-phase intent。response-loss重试必须保持exact ID和evidence。不含selected anchor的过早快照必须换回包含该anchor的snapshot；仍含anchor的更晚合法快照是否为正确selected物理快照，必须由operator/backup producer独立attest，应用无法判别，这是P1级流程风险。当前也没有external-only orphan abort；control、catalog event、runtime reservation或eviction一旦提交只能forward-fix。MinIO第三个bucket只证明协议门禁，不满足生产独立故障域ACK。

`0032`～`0042`仍是default-dormant的expand/code-aware基座，不是可执行的production telemetry lifecycle。0034 worker已接runner但默认关闭；filesystem只限本地单runner，S3 writer只提供managed-capable对象写入协议。0035仅接单一provider failure logs，traces没有producer contract。0036安装独立disposition账本与非生产same-key CAS tombstone/CAS-head journal协议，但新T3d logs/traces即使有精确非零目录target也仍是blocked不可执行，产品store执行/mirror/fence与外部处置均默认拒绝。0037只修正grant hard-deny hash/指纹并增加非生产v2 Memory事件夹具；0038给新受管write追加不可变逐项membership/source sidecar，旧write缺失为unknown，写时owner claim不是T3f后的closure。0039仅为新T3f增加逐write owner-closure和零write empty-set aggregate，旧terminal仍为unknown；0040～0042给新T3d同事务保存source-accounting、观察目标及逐artifact plan目录，legacy/incomplete/orphan保持unknown，旧terminal不补造；不回填、不联网、不给外部删除权。Memory/MySQL不签发真实grant，尚无产品v2 S3 mutation或DB-time verifier。缺受控activation、真实grant、external marker/fresh head验证、0030/0031恢复绑定、旧快照replay/startup gate和跨存储端到端测试时，不得启用capture/处置或宣称coverage与completion完整。第五个同机MinIO bucket只能证明协议，云IAM/KMS和独立故障域仍待staging。

0043在这一基座上只增加只读本地来源诊断和非零target的T3e复核修复；它不改变0042 schema、119-trigger指纹、产品默认关闭状态或部署产物。即使得到`local_source_candidate`，`externalAuthorityVerified=false`和`executionReady=false`也必须保持；0044已把这一候选封存为默认休眠的版本化source-bound pre-grant intent/claim，但仍须独立验证外部journal authority、同keymarker、0030/0031旧快照恢复和物理ACK。不能把0043当成可开启0036/0037处置的最后一步。

`0036→0037`涉及strict trigger fingerprint，不能把旧binary和新schema当作可互换滚动：保持disposition、grant与全部外部mutation关闭，先完全排空pre-0037 router/runner，再以独立migration Job安装0037 hard-deny trigger并确认零执行footprint，最后只启动0037-aware binary。pre-0037 binary在新schema上会fail closed，不能回改已发布0036、删除migration marker或移除新guard来恢复服务；必须forward-fix。该顺序只解决兼容性与安全拒绝，不签发真实grant、不启用v2 S3 journal、physical ACK或旧快照restore gate。

`0037→0038`也属于严格指纹不兼容发布。先保持telemetry writer、application capture、disposition及grant相关gate关闭，摘流并完全排空pre-0038 router/runner与在途writer事务；独立迁移新增不可变membership表和加法式job guard，核对严格schema/87-trigger指纹、零执行footprint和历史job未回填；最后只启动0038-aware进程。pre-0038 binary在post-0038 schema会fail closed；不能让旧writer与新job guard混跑，不能删除marker、移除已发布0035 guard或从历史job JSON补造membership。此顺序不开放产品删除、恢复或全域completion。

`0038→0039`同样不能与旧T3f writer混跑。先保持telemetry writer/application capture、T3f和disposition相关gate关闭，摘流并实际排空全部pre-0039 router/runner、T3f claim与在途destructive事务；由独立migration Job安装两张append-only owner-closure表、既有telemetry write-job上的加法式身份guard和T3f terminal guard，核对严格schema/95-trigger指纹、零外部执行footprint及历史数据未回填，最后只启动0039-aware进程，再按原T3f gate次序开放。pre-0039 binary会因新指纹拒绝启动；不可删marker/guard、补造旧receipt或将旧terminal默认为已证明closure。新T3f在同一Memory原子发布或MySQL事务中，基于0038 sidecar和live canonical owner先写逐write entry，再写绑定T3f terminal receipt的aggregate，零write也有确定性empty-set receipt；任一失败连同数据库删除全回滚。pre-0039 terminal无0039 aggregate只能保留`unknown`。冻结`0038→0039`真实MySQL夹具及独立冻结0038旧二进制terminal升级夹具均已通过；该旧terminal没有非空telemetry artifact，真实N-1滚动、锁等待与旧writer排空仍须预发验证。它没有签发source-valid grant或开启外部删除/恢复。

`0039→0040`同样是严格指纹切换：先保持T3d、telemetry capture/disposition与grant gate关闭，摘流并排空旧router/runner及在途plan，再以独立migration Job安装两张append-only source-accounting表和T3d terminal guard，核对103-trigger指纹、历史terminal未回填及零外部执行footprint，最后只启动0040-aware进程。新T3d在plan事务里封存inventory、write job、ACK、membership和application binding五类来源；legacy、未完成、孤立来源为unknown，pre-0040 terminal无receipt也为unknown。该证据不是外部删除许可；T3d logs/traces零target blocker、grant硬拒和全域completion=false均保持。

`0040→0041`仍需先保持T3d、telemetry capture/disposition/grant关闭，摘流排空pre-0041 router/runner和在途plan；独立migration Job安装逐source observed-target manifest及同事务terminal guard，核对111-trigger指纹、旧terminal无回填及零执行footprint，再仅启动0041-aware进程。新T3d在0040同一事务把每个source精确归入一个artifact group；只有inventory、written job、ACK、membership、binding和当时真实owner/target tuple闭合才记录一个**观察**目标。legacy、未完成、孤立组仍为unknown/零观察目标，不能据此推断locator、grant或33域执行target。T3f后只读source-readiness需与0039 closure/grave关系核对，始终`executionReady=false`。本地验收使用`pnpm test:tenant-purge-plan-memory`、`pnpm test:tenant-purge-plan-mysql`和`pnpm test:migrations`；required wrapper会确认`0040→0041`夹具实际执行且非skip，且独立冻结0040旧二进制已在真实MySQL完成terminal后升级，证明旧receipt保留、缺0041证据保持unknown；该旧terminal没有非空telemetry artifact。

`0041→0042`同样不能热混跑pre-0042 T3d writer：先保持T3d、telemetry capture/disposition/grant gate关闭，摘流排空旧router/runner及在途plan；独立migration Job安装逐artifact catalog/receipt、append-only和terminal guard，核对严格119-trigger指纹、历史零target plan不回填及零执行footprint；然后只启动0042-aware进程并forward-fix。新T3d从同一次锁定source/owner快照构造logs/traces精确count/root，再连同0040/0041和terminal原子提交，零目标也显式receipt。旧0041 terminal缺catalog为unknown，不从观察目标反推；新plan仍`blocked_adapter_unconfigured`、`executionReady=false`。本地验收使用T3d Memory/真实MySQL、`pnpm test:migrations`及冻结0041旧二进制非空terminal升级夹具；真实N-1排空和全表锁/lease压力仍须staging验收。

`0042→0043`不需要新DDL，不能把它当成授权gate切换：部署前仍须确认0042 schema/119-trigger指纹及pre-0042 writer排空已完成；随后可用新代码修复非零目标T3e live recheck，并只读查询T3f后的本地来源候选。MySQL暂态锁争用应维持可重试而非永久block；已经由0042旧代码写成blocked的job没有自动resume。真实MySQL冻结二进制夹具覆盖旧阻断与零目标终态，但不能代替真实N-1进程切换或云环境验收。0044新增的versioned source-bound pre-grant intent/claim保持默认休眠，不能把`local_source_candidate`直接转成0037 grant。

`0043→0044`恢复独立schema窗口：先关闭telemetry capture/disposition/grant及相关T3d/T3f gate，摘流并排空pre-0044 router/runner和在途事务，再由独立migration Job安装两张append-only账本、七个guard并核对126-trigger严格指纹、旧证据不变和默认零intent/claim，最后仅启动0044-aware进程。旧119-trigger binary不能在新schema热混跑；0044不回填旧plan、不激活control，也不放开0037 grant、T3d blocker或产品外部mutation。固定`0042→0044`真实MySQL夹具证明SQL历史升级/marker-loss，不是冻结旧应用二进制terminal验收。

`0045`～`0048`没有schema migration，GET-only观察器与v3非生产S3 fixture也没有产品startup/mutation gate；只可通过独立unit/真实MinIO套件学习其sealed-chain、同keydata/tombstone和CAS-head协议，不得手动把观察结果写成DB grant或physical ACK。`0044→0049`则是新严格指纹窗口：关闭相关gate、摘流并排空pre-0049 writer和在途T3d/T3f事务，再独立安装三张默认休眠capture v2表/13 guards并核对139-trigger指纹、默认空coverage/binding及旧证据保持，只启动0049-aware进程。异常v2 footprint会阻断旧T3d/T3f/v1 writer；不能删除guard或把表存在解释为producer cutover。future source ref必须使用tenant-bound、kind-separated keyed HMAC，不能把raw session/turn/item写入账本。

`0049→0050`只增加session行的五个nullable ordinary DELETE来源/seal/floor列及严格CHECK，不增加trigger或自动清理。要让后续新普通DELETE完整保存来源，仍需摘流、排空旧writer并只启动0050-aware路径；旧writer在新schema上不会被强制双写，只会留下unknown。普通DELETE首事务与event/outbox原子写origin，COMMIT后第二事务最后观测DB时间才seal`+1ms+30天`保守floor，故不能用删除时runner wall clock代替。后续code-only恢复caller已接runner，但`SESSION_DELETE_GRACE_RECOVERY_ENABLED=0`默认关闭；确认旧writer/在途DELETE完全排空后可逐实例显式开启，默认每30秒/批25项，只重验并补seal已提交来源。它没有独立服务、进程、CLI、bundle入口或镜像，也不能领取/排期`session.purge`。0050阶段没有SQL级write-once origin guard，当前也没有物理purge gate；损坏候选可阻断一批，尚无逐行quarantine、专用扫描索引或统一deadline，所以仍不能称为自动生命周期闭环。旧/erasure/legacy tombstone不回填，T3f删除session时删除其证据；`purge_after_ms`和不可领取的`session.purge`保持原状。具体证明与未完成项见[普通DELETE宽限期设计](../design/06-session-delete-grace.md)。

`0050→0051`另须停流并彻底排空pre-0051 writer及在途事务，再独立应用create-only `sessions BEFORE UPDATE` trigger；启动将其完整动作与140-trigger指纹、0051 marker及0050列/CHECK精确核对。origin只能伴随首次live→tombstone写入，随后digest/DB时间、BINARY tenant/user/session身份、删除generation/time与lastSeq不可更改；seal须在旧行版本已有origin时写入，写成后seal时间/floor/digest不可更改。marker丢失但精确trigger已提交可安全重放，动作漂移fail closed。该SQL guard不证明origin来自可信业务路径或0050双COMMIT，旧writer仍可留下unknown，T3f仍可删除session整行。故mixed-writer来源覆盖、最小权限/schema drift和最终策略执行仍是发布门禁；`purge_after_ms=NULL`与不可领取的`session.purge`不变。

`0051→0052`同样先关闭ordinary usage及相关T3d/T3f gate、停止DELETE流量，实际排空全部旧writer/在途事务，再独立安装八个nullable列/五guard及相关145组合指纹，只运行0052-aware进程并forward-fix。旧router capability解析器可能忽略新增features，不能声称它必然拒绝新runner；所以仍需排空旧router并核对新私有fresh gate。新DELETE同事务绑定immutable policy，旧/未配置来源不回填；之后首次usage执行须重验source/seal、DB time、30天与更长政策、hold、erasure/restore fence和完整billing。T3f/grave的versioned摘要桥接须在删除canonical行前核对，旧v1 hash保持原值。新runner和router均默认gate=0且production拒绝开启；学习应使用named测试，不手工激活普通内容purge。每session的10000 facts cap不是tenant总上限；大JSON、全范围锁/packet容量和统一deadline仍需后续验收。

`0020` T3b再使用一条完全独立的rollout：expand-only migration → 新router以`TENANT_RUNTIME_DRAIN_EXECUTION_ENABLED=0`上线并排空旧router → 全部新runner以`TENANT_RUNTIME_DRAIN_ENABLED=0`、`TENANT_RUNTIME_REVOCATION_WORKER_ENABLED=0`上线 → 为每个configured slot配置唯一且重启不变的`RUNNER_ID`，并确认`RUNNERS`每项是对应实例的直连稳定URL → 逐runner开启私有endpoint → 核对所有endpoint的runner/boot identity → 开启内嵌worker → 最后开router execution gate。router每次都在fanout前后直接探测所有精确target，不使用healthy subset、owner hash ring、sticky attestation或负载均衡Service别名；任一target/runner/boot缺失、重复或变化均无aggregate proof。

T3b的回滚顺序是先关router execution gate，再让worker在当前job边界停领，最后才可关endpoint。关闭gate只暂停新广播，不会重开已fenced tenant、恢复cache/reference、撤销immutable receipt或改写T3a的`runtimeDisposition=not_in_scope`。已有`0020` terminal proof时必须保留schema并forward-fix，不得回退到会忽略T3b fence的版本。

`0021` T3c再采用独立、无router execution端点的expand→worker-active顺序：先应用migration，再滚动`TENANT_CONTENT_INVENTORY_WORKER_ENABLED=0`但理解新evidence的新runner，确认严格schema fingerprint、append-only guards和新binary均已就绪后逐实例开启worker。同名但不兼容的partial/manual DDL会fail fast，必须先受审计修复，不能由migration猜测覆盖。它从terminal T3b proof显式materialize job，以不早于T3a/T3b proof high-water的数据库时间固定anchor/deadline；build/seal显式使用REPEATABLE READ，检查tenant全部session及turn/item/event/approval关系、event引用、连续seq、全局orphan和canonical tenant/user hold，并在receipt INSERT后重验live lease，再同事务提交aggregate receipt与terminal job。任何receipt都不含正文、user id、Blob locator或claim token，也不是删除许可。关闭worker只暂停新claim；已有`0021` evidence时必须保留schema并forward-fix。当前seal的五表全局共享锁扫描只是local/CI正确性基线，生产启用前需完成owner索引/FK/分区或等价优化、容量测试与写阻塞验证。

`0022` T3d继续采用独立、无router execution端点的expand→worker-active顺序：先应用execution-dormant migration，再滚动`TENANT_PURGE_PLAN_WORKER_ENABLED=0`但理解固定catalog的新runner；核对三张表的严格schema/index/CHECK/trigger fingerprint、append-only guards和新binary后才逐实例开启。生产worker对新空plan不做分页发布，而是直接seal：Memory在一个原子边界、MySQL在单个显式REPEATABLE READ事务内重验T1/T3a/T3b/T3c、immutable policy、DB-time deadline、canonical tenant/全部user hold、全局owner closure与post-write lease，并一次性写33条entry、aggregate receipt和terminal job。idempotency、usage ledger/reconciliation全范围锁保持到commit，阻止扫描后phantom；legacy pending `NULL`保留，legacy completed `{turnId}`必须反向归属同一session，显式`sessionId`若存在也必须匹配。operational usage允许synthetic/legacy turn无turn row，但reconciliation必须绑定已tombstone session的精确正generation；lifecycle↔request/admission双向闭合，purge target必须精确匹配tombstone generation/time。`buildPage`只保留诊断/兼容用途，不由生产worker调用。关闭worker只暂停新plan；已有`0022` evidence时必须保留schema并forward-fix。新plan按0026精确target disposition把真实external `executable_ref`记为可撤销，legacy/source blocker继续阻断，KMS仍全部阻断；历史pre-0026 sealed plan继续按冻结的粗粒度T3a证据校验。`executionReady=false`、`contentPurgeExecuted=false`与所有blocker都是安全结果，`planComplete`始终不等于execution/completion，promotion脚本不得覆写。

`0023` T3e采用expand→code-aware→cleanup/worker→execution-gate顺序：先应用migration；发布`TENANT_PURGE_EXECUTION_ENABLED=0`的新router并排空旧router；滚动`TENANT_PURGE_EXECUTION_WORKER_ENABLED=0`但声明`local-execution-ack-v1`的新runner。filesystem只允许local单runner确认root独占后启用；S3多runner必须先完成`0027`空库activation或`0028`非空库cutover、全fleet namespace收敛和staging跨runner cleanup验证。两种模式都先开Blob/export cleanup，再核对全部configured target健康且T3e worker-active，最后开router gate。每次materialize、claim、lease、cutover和physical seal均取fresh non-sticky ACK；首个cutover与usage anonymize、export revoke/snapshot release、exact outbox和domain ACK同事务提交并激活write-once边界，outbox实际completed后才seal physical ACK，dead-letter只能block。关闭gate不能恢复已发生动作或撤销证据，首个cutover后只能forward-fix；S3 active不授权其它未ACK domain。

`0024` T3f采用expand→router-first parser replacement→runner worker→execution-gate顺序：先应用migration，再发布`TENANT_DATABASE_PURGE_ENABLED=0`且理解双capability的新router，并完全排空所有旧router；之后才滚动`TENANT_DATABASE_PURGE_WORKER_ENABLED=0`的新runner，逐实例开worker，最后开router gate。旧router的严格parser会拒绝`["local-execution-ack-v1","local-db-content-delete-v1"]`，所以runner-first不安全。materialize、claim、renew、destructive execute与模糊response replay都取fresh `no-store` ACK；首个cutover后只能forward-fix，关闭gate不能恢复已删投影、grave或不可变证据。

当前T3f MySQL事务持有全局cutover行锁直至删除与证据一并commit，跨tenant执行因此安全串行。预发必须用真实数据量验证锁等待、lease预算、超时与吞吐，再决定是否引入等价的分片协调。CI中的冻结旧parser证明了发布顺序约束，但没有替代真实N-1镜像canary、旧router排空与forward-fix演练。

`0025` T3g采用expand→marker-aware router→marker-aware runner→worker→execution-gate顺序。先应用migration，并为每个router/runner设置完全相同、准确的`REDIS_NAMESPACE_ID + REDIS_PREFIX`；新router以`TENANT_REDIS_PURGE_ENABLED=0`发布并完全排空旧router，再以`TENANT_REDIS_PURGE_WORKER_ENABLED=0`滚动新runner，并在任何T3g Redis mutation前完全排空marker-unaware旧runner。核对每个configured stable URL健康、声明`session-state-delete-v1`且namespace digest一致后，保持router gate关闭并逐runner开启worker；这允许durable restore及existing-marker-only收口，但不materialize新job或创建首次marker。全部worker-active后最后开router gate。fresh no-store ACK只用于materialize和每次新的Redis mutation，mutation前执行`gate → renew claim → gate`；lease至少是barrier timeout的两倍再加1秒，且续租至第二次proof的耗时不得超过lease一半。claim、existing-marker replay、ACK持久化/精确重放、durable restore与全ACK seal不取destructive gate。首个marker/ACK/cutover后只能forward-fix；关闭router gate只能暂停新materialize/mutation，不能关闭负责marker-only收口及startup/periodic durable replay的worker、修改namespace identity或回退旧binary。barrier不能阻止仍存活且可直写Redis的旧进程，因此完整drain是必要条件。

T3g的恢复能力需保持精确表述：same-MySQL projection只枚举已经写入durable target ACK的marker。正常marker-only窗口可由worker轮询中的existing-marker-only replay在gate关闭时收口；但marker尚无MySQL ACK且在worker成功replay并持久化ACK前又从Redis丢失时，首次existence bits仍无法恢复。MySQL与Redis一起恢复到旧snapshot也不受保护。restore keyset在大tenant下的扫描/重放性能、永久marker容量、普通live-session fence灾备及独立故障域ledger仍待设计/压测。自动测试使用真实standalone ioredis并验证same-slot grammar，但不是managed Redis Cluster、ACL、persistence或failover验收。

当前ordinary user erasure/compensation/evaluator继续停在不可执行策略边界；export可生成、下载和清理临时制品。tenant T1/T2提供逻辑fence，T3a删除本地DB credential material，T3b证明configured fleet drain，T3c证明DB-time owner结构，T3d封存33域plan，T3e完成local operational usage与Blob/export子集及physical ACK，T3f清理11个本地数据库投影并留下永久session grave，T3g再清理session-scoped Redis lease/owner、fence与stream并写永久marker；`0027`提供共享Blob对象协议与namespace cutover，`0028`提供离线filesystem→S3搬迁账本、runtime gate与一次性CLI，`0029`提供default-dormant external-target协议、Memory fake和真实MySQL账本，`0030`提供独立T1 journal、runtime lineage、永久恢复fence与one-shot replay，`0031`提供权威backup catalog、snapshot lineage、retention、restore source binding和永久epoch reservation，`0032`提供safe structured telemetry/trace入口，`0033`提供default-dormant原子activation/coverage/artifact inventory store，`0034`提供payload-before-sink writer spool、reservation、Memory/MySQL/HTTP/filesystem/S3协议和ACK基座，`0035`提供分域application capture authority，`0036`新增default-dormant disposition迁移/原子control与非生产S3协议夹具，`0037`只新增grant hard-deny trigger/指纹与非生产v2 Memory协议，`0038`仅给新受管write新增不可变逐项membership/source sidecar，`0039`仅让新T3f同事务封存本地owner-closure entry/aggregate，`0040`～`0042`让新T3d同事务封存telemetry来源、观察目标与逐artifact精确plan目录，`0043`只读诊断本地来源候选，`0044`只封存默认休眠的source-bound pre-grant intent/claim。0029没有真实provider adapter，KMS固定未完成；0030/0031仍有单target、人工ACK和跨MySQL/S3 saga等已知边界；本地加密MySQL逻辑producer已实现，backup-copy erasure、联合旧快照恢复与真实故障域验收仍缺；0035当前只接单一provider failure logs contract；0053只新增本地受控v2 logs capture operator，仍没有traces producer或0036～0044外部delete/restore/retention executor。公开status仍为`gated`、`dataPurgeExecution=false`。backup内tenant erasure与其它domain恢复证据、logs/traces完整执行生命周期、managed对象存储/IAM环境验收、完整生产backup/restore、completion及generic user物理purge也尚未闭环；所以staging/production的相关admission/execution/worker gate默认都保持`0`，0031 control保持inactive且telemetry control保持generation 0，只有完成对应环境验收和后续实现才逐项激活。

没有云资源时，仍可完成业务代码、协议、迁移、Memory/MySQL/Redis实现、filesystem与S3-compatible Blob/telemetry行为、本地MinIO/多进程/容器测试、故障注入、指标定义和部署契约；本地加密MySQL逻辑backup producer和显式导入已经实现。没有云账号不解释当前grant返回零授权、已发布0053下缺受控桥时阻断T3d/T3f、user停在`awaiting_purge_policy`或`session.purge`不可领取：这些仍需产品实现，不能归为仅待环境验收。

本表保留0053阶段的缺口分类原文。表中v2来源保留链已有上方所述0054本地有限候选，不再是“尚无实现”；它不覆盖mixed application-v1、未知/旧tenant、非零Blob/export、显式新epoch恢复、可信grant或实际telemetry处置，后续各项仍须独立实现和验收。

| 本地/CI仍须实现的闭环 | 不应冒充的完成证明 |
| --- | --- |
| BYOK/平台credential的versioned责任与ownership；共享key只清租户引用/ciphertext，KMS目标态的adapter/轮换/故障处理 | BYOK厂商撤销由客户负责；不能伪造revoked或销毁共享主密钥来宣称单租户erasure |
| v2 source保留式T3d→T3e usage释放→T3f内容清理，以及telemetry可信授权、journal、实际sink处置/ACK、恢复防复活 | source、write ACK或非零target目录不是delete ACK；旧gap继续unknown |
| active0053旧backup的显式新epoch许可及MySQL/Redis/Blob/telemetry联合恢复窗口 | active0033 key兼容测试不证明active0053 restore；同库ACK replay不证明联合旧快照安全 |
| generic session/user内容purge及child-first执行/恢复/完成审计 | 30天floor与ordinary operational usage retention不是内容purge |
| backup-copy责任/保留、受policy/hold约束的实际到期删除、durable intent和物理不存在ACK | 共享backup仍保留时不能称其字节已物理删除；内容30天不自动套用到backup/billing/audit |

仍须等待真实环境验收的是managed IAM/private access、真实KMS权限/TLS/轮换、独立journal/catalog/sink故障域、云端备份复制/PITR、真实容量与锁等待、staging/production RPO/RTO和发布演练、IdP及真实Redis Cluster/ACL/persistence/failover等。对应adapter、配置契约和本地故障代码应先实现；不能把缺代码统称为M4云验收。仓库不编造Kubernetes、域名/TLS、bucket、telemetry backend或Secret参数；本地MinIO协议与加密逻辑backup也不证明独立故障域、完整生产DR或日志/追踪删除。此前列为“下一批”的同primary epoch、新tenant且全部v2 write在T1前ACK的来源保留式本地链现已形成0054候选，并在全部Blob/export计划域为零的范围内通过完整本地集成verify；前两次失败及仅测试修复记录保留，第三次主2897和真实历史47文件282零skip已通过。发布commit及其Linux CI仍须以main对应run的实际终态核对，不能从本地成功推断生产许可。restore/new epoch、其它历史gap、可信grant和外部处置继续拒绝，不能把剩余实现写成只等云验收。

当前T3d全库RR/next-key扫描可能在规模下造成写阻塞/死锁、lease和容量压力，必须在staging用真实索引与数据量做锁超时/容量验证。结构损坏的queued job在逐候选隔离前可能饿死后续job，cursor重启还会重扫损坏前缀，但fail-closed且不会产生plan receipt或执行权，M4应增raw-key quarantine/skip。`0022` trigger fingerprint不校验action body，迁移夹具只显式模拟首个DDL auto-commit边界；预发需用无DDL/TRIGGER的runtime principal并扩展schema tamper/中断演练。

T3d owner closure还覆盖Memory export/user-erasure/tenant-admission request↔idempotency反向索引，以及Memory/MySQL legacy compensation deterministic `jobId`↔精确session owner/tombstone generation/time；MySQL还重算`candidateSha256`并校验`sourceLastSeq`，`erasure_claim`精确绑定request/generation，status精确对应单个audit/result，completed event seq等于`session.lastSeq`且success evidence完整。对全局orphan/cross-owner损坏，当前claim会终结为`blocked`且不产生执行权，但底层数据修复后不会自动resume/rebuild，后续需受审计的operator repair/resume协议。

## 10. 文档维护规则

当服务、命令、端口、CI job、构建产物或里程碑能力发生变化时，同一提交更新本文。不要复制 `docs/review/` 或 `docs/research/` 的历史测试数量；准确完成度继续以 `docs/PROGRESS.md` 最新一节和当前 CI 为准。
