# agent-service

分布式、多租户的 agent API 服务：无状态 `agent-router` + 有状态 `agent-runner`（类 `opencode serve`）。当前已实现会话/turn/SSE、BYOK、租约与 fencing、多节点路由和接管；MCP、skills、plugins/hooks 属于后续 M3。设计见 `docs/design/00-architecture.md`，调研见 `docs/research/`。

## 状态

- **M0 调研**：完成。
- **M1 单节点 runner MVP**：核心运行链路、OpenAPI/SDK、Archive/tombstone/outbox/Blob lifecycle、usage 财务分层、canonical retention policy / multi legal hold、非破坏性 purge-policy evaluator，以及异步 user export artifact/download/TTL 均已完成。tenant erasure 的 T1/T2、T3a、T3b、非破坏性 T3c 与 T3d 本地/CI切片已收口：`0018`建立独立admission和逻辑credential fence；`0019`原子清除本地数据库credential material；`0020`证明精确configured fleet完成runtime fence与已跟踪I/O结算；`0021`建立可信数据库时间的session/turn/item/event/approval owner结构清单；`0022`从完整T1/T3a/T3b/T3c proof和immutable policy显式materialize固定33域的content-free tenant purge plan。每域只保存count/root/disposition/source hash，adapter缺失不能被当成空域；历史provider与tenant auth材料均为零时有9个blocker，仅tenant auth envelope非零时为10个，任一provider config非零时因其也可能包含BYOK/KMS envelope而为11个。`0023`再增加runner内嵌、双默认关闭gate保护的T3e本地执行/ACK切片：原子去身份化operational usage、撤销user export并清除download lease、释放snapshot pin，再为Blob/export bytes写精确delete outbox，且只在原cleanup worker实际完成对应outbox后seal physical ACK。它不新增服务或镜像，local cutover/physical receipt固定`allDomainsComplete=false`、`contentPurgeExecuted=false`；session/idempotency receipt/Redis、其余本地域、external provider/KMS、backup/restore、logs/traces仍未闭环。公开status保持`gated`、`dataPurgeExecution=false`，因此M1仍未冻结。
- **M2 router + 多节点**：`agent-router`、租约/fence、owner 目录、drain、原子 session 创建与真实多进程接管测试均已实现并通过自动验收；本地/CI 代码范围已正式冻结，生产 Kubernetes/云资源部署在环境参数明确后单独交付。
- **M3 扩展性**（MCP、skills、hooks）：尚未正式开始，已有动态工具反向委托等前置地基。
- **M4 生产化**（配额、可观测性、限流）：核心范围尚未开始；Docker、CI 和本地运维脚本等交付地基已经具备。

测试分为纯单元/HTTP/假厂商、MySQL/Redis 集成、多进程集群和显式启用的真实模型 E2E；准确数量和覆盖率以当前 CI 输出为准，避免在 README 固化易过期数字。

## 本机运行

```bash
# 依赖：Node 24（fnm）、pnpm 12、MySQL 8（已有）、Redis（deploy/local/install 说明见 infra.sh 头部）
pnpm install
deploy/local/infra.sh start          # 启动 redis + mysql，建库 agent_service / agent_service_test
cp .env.example .env                 # 真实模型只强制 API_KEY；base URL / model 可覆盖默认值

# 完整本地栈（MySQL + Redis + runner + router）
scripts/local-service.sh start
scripts/local-service.sh status
scripts/local-service.sh smoke

# 仅调试纯内存 runner 时，先显式移除 router-only platform authority
set -a; source .env; set +a
unset TENANT_ERASURE_OPERATOR_TOKEN TENANT_ERASURE_OPERATOR_ID \
  TENANT_CREDENTIAL_REVOCATION_EXECUTION_ENABLED TENANT_RUNTIME_DRAIN_EXECUTION_ENABLED \
  TENANT_PURGE_EXECUTION_ENABLED
STORE=memory REDIS_URL= node --import tsx apps/agent-runner/src/main.ts
```

```bash
# 手动验收（十个环节：鉴权/流式/重放/幂等/上下文/安全阀/隔离/BYOK）
deploy/local/infra.sh start
scripts/local-service.sh start
scripts/local-service.sh acceptance              # 明确经公开入口 agent-router 验收

# 测试（四层，前三层不需要任何 API key）
pnpm test                                     # 单元 + 方言（假厂商）
AGENT_SERVICE_INTEGRATION=1 pnpm test         # + MySQL/Redis 一致性套件（两个后端跑同一套契约）
pnpm test:migrations                          # 固定 0007 → 0008 → ... → 0022 → 0023 的真实 MySQL 历史升级夹具
pnpm test:blob-mysql                          # 强制执行并验明 ownership/绑定/cleanup 的真实 MySQL 专项套件
pnpm test:usage-lifecycle-mysql               # 强制执行 usage 双写/核对/匿名化真实 MySQL 专项套件
pnpm test:subject-lifecycle-mysql             # 强制执行 subject gate/回滚/并发真实 MySQL 专项套件
pnpm test:tenant-credential-revocation-mysql  # 强制执行 tenant 原子 fence、status proof、回滚、隔离和写入 race 真实 MySQL 套件
pnpm test:tenant-credential-physical-revocation-mysql # 强制执行 T3a 物理凭据清除、全局proof、事务回滚、DB时钟/claim与隔离套件
pnpm test:tenant-runtime-revocation-mysql     # 强制执行 T3b configured-fleet runtime receipt、并发/租约、回滚与隔离套件
pnpm test:tenant-content-inventory-mysql      # 强制执行 T3c DB-clock owner inventory、hold、并发/回滚与隔离套件
pnpm test:tenant-purge-plan-mysql             # 强制执行 T3d 固定33域计划、blocker、并发/回滚与隔离套件
pnpm test:tenant-purge-execution-mysql        # 强制执行 T3e 本地cutover、exact outbox/physical ACK、回滚与隔离套件
pnpm test:retention-policy-mysql              # 强制执行 policy/hold CAS、审计、回滚与线性化真实 MySQL 套件
pnpm test:erasure-purge-policy-mysql          # 强制执行非破坏性 evaluator/authority、ABA、回滚与重评真实 MySQL 套件
pnpm test:erasure-job-mysql                   # 强制执行 erasure job claim/lease/audit 的真实 MySQL 套件
pnpm test:erasure-session-mysql               # 强制执行 claim-bound session action/回滚的真实 MySQL 套件
pnpm test:erasure-catalog-mysql               # 强制执行 content-free catalog/completeness proof 的真实 MySQL 套件
pnpm test:erasure-usage-mysql                 # 强制执行 claim-bound usage reconcile/ABA/回滚的真实 MySQL 套件
pnpm test:legacy-tombstone-mysql              # 强制执行 generation-zero 补偿/cutover/回滚的真实 MySQL 套件
pnpm test:user-data-export-mysql              # 强制执行一致性快照、制品、下载 lease、TTL/撤销清理的真实 MySQL 套件
pnpm test:cluster                             # + 多进程集群：2~3 runner + 1 router，SIGKILL 租约持有者
pnpm check:api                                # OpenAPI 与生成 SDK 漂移检查
pnpm check:sdk                                # 编译 SDK、原生 Node import，并校验 pnpm pack 内容
set -a; source .env; set +a; AGENT_SERVICE_REAL_E2E=1 pnpm vitest run packages/providers/test/e2e-qwen.test.ts
pnpm typecheck

# 生产构建验证（SDK 发布包 + 两个应用的单文件 bundle，原生 node 启动，不依赖 tsx）
pnpm build:check
docker build --build-arg APP=agent-runner -t agent-runner .
docker build --build-arg APP=agent-router -t agent-router .
```

也可以通过统一的本地运维入口完成生命周期与验证：

```bash
scripts/local-service.sh start
scripts/local-service.sh status
scripts/local-service.sh smoke
scripts/local-service.sh acceptance   # 使用真实模型，会产生少量费用
scripts/local-service.sh verify       # secret/API drift/typecheck + 集成/coverage + 历史迁移 + cluster + 构建产物启动
scripts/local-service.sh verify-real  # 仅在显式命令下读取 .env 的真实模型 key
scripts/local-service.sh cleanup-idempotency --dry-run  # 检查/分批清理过期 completed receipt
scripts/local-service.sh stop
```

详细配置与未来 staging/production 部署契约见 `docs/operations/local-and-deployment.md`；面向项目学习、手动体验和 CI 构建产物的完整说明见 `docs/operations/development-and-ci-guide.md`。

## 部署形态

```
客户端 → agent-router（无状态，N 副本）→ agent-runner（有状态，N 副本）
                  ↓ 读 Redis 所有权目录            ↓ 租约 + fence
              一致性哈希兜底                  MySQL / Redis / BlobStore
```

`agent-router` 的核心职责是按 sessionId 找到持有租约的 runner、把 SSE 原样透传、收到 runner 的 `409 + X-Owner` 后安全重路由，并在发布窗口执行 protocol/capability gate。它没有业务状态，可随时重启。

tombstone 是现有 `2026-10-08` protocol family 内的 additive capability。router 只有在显式设置 `SESSION_TOMBSTONE_ENABLED=1` 且全部健康 runner 都声明 `tombstone` 时才开放 session DELETE；本地脚本默认启用。外部 DELETE 会被改写为带 `INTERNAL_ROUTER_TOKEN` 的版本化 runner-only POST，并要求新 runner 回 ACK；内部路径不进入 OpenAPI，客户端伪造的内部 header 会被剥离。`RUNNERS` 必须是实例稳定地址，runner 端口必须保持内网不可直连。staging/production 需先在 edge 暂停精确 session DELETE（或整体切换 router 池），再按“新 router（gate=0）→ 排空旧 router → 滚动新 runner → 核对 fleet capability → 激活 gate”的顺序升级；旧 router 本身没有该 gate。

user erasure request 也是 additive、默认关闭的 capability。只有 runner 与 router 都显式设置 `DATA_ERASURE_REQUESTS_ENABLED=1`，且 `RUNNERS` 中每个 configured target 都已通过健康探测并声明 erasure 与 `dataGovernance` writer-awareness、选中 target 也仍支持时，router 才接受 `POST /v1/data-erasure-requests`；runner 配置还要求普通 erasure worker 与 legacy compensation worker 都已启用。当前公开范围仅限 admin service key 代表一个明确 user 发起带 `Idempotency-Key` 的请求：它原子写入 subject gate、request 和首条 audit，并在同一事务绑定线性化点已激活的 canonical policy。`0015` 的 MySQL INSERT guard还会在策略激活后拒绝旧 writer 写入 NULL、部分或错误 policy identity；激活前已有 backlog 保持原身份，不做事后补绑。两个 runner 内嵌 worker 都在接触 durable queue 前请求 router 的 token-protected v2 barrier；router 必须已在本进程逐一观察每个 configured stable runner 同时支持 `quarantine-v1` 与 `legacy-tombstone-compensation-v1`。普通 worker 调用 `drain-v1` 定位当前 owner并有界请求 abort，随后以固定、无正文的 store action child-first tombstone，并逐 session 原子核对 usage。成功只推进到 `awaiting_purge_policy`：operational usage、receipt、item/event、ready Blob 和不可领取的 purge intent 仍保留，绝不标记 `completed`。status GET 不依赖 router writer gate，继续按当前 healthy fleet 与选中 target capability fail-closed；POST/GET 的成功与错误响应都强制 `Cache-Control: no-store`。任一 request 首次接受后不能回退到 pre-`0011`；首个0013 control event/terminal incident后不能回退到 pre-`0013`；0014 cutover 一旦激活则不能回退到 pre-`0014` writer；首次 policy activation 或 canonical hold event 后不能回退到 pre-`0015` writer，只能 forward-fix。user 内容物理 purge、匿名化调度、tenant destructive content purge/completion 和备份恢复门禁完成前，仍只允许在本地对可丢弃 user 显式体验，方法见 `docs/operations/development-and-ci-guide.md`。

tenant erasure 与上述 user API 是两条不同边界。T1 的 Memory/MySQL 原子边界与 append-only fence 保持不变；T2 在 router 新增 `POST /v1/tenant-erasure-requests` 和 owner-hiding status GET，并以独立 `PlatformOperatorToken` 和窄化 SDK client 鉴权，绝不接受 tenant service key。platform token 只注入 router；runner 若在进程环境发现该 token/actor 配置会拒绝启动。router 会剥离所有客户端伪造的内部 header，再用 `INTERNAL_ROUTER_TOKEN` 和固定 operator id 改写到 runner-only 路径。只有新的 admission/create path 才要求 router gate、全部 configured stable runner 的 code-aware/local gate，以及 runner 提交前的 fresh barrier；关闭 admission 后，精确匹配已提交 tenant/key/body 的 POST 只走独立 read-only replay 路径并返回同一 `202`，未知或不同 key 返回 `503`且绝不创建，status仍可读。首次 gate 不可撤销，旧 runtime 必须先完全排空，只能 forward-fix。

T3a 的 credential-store worker 内嵌于 runner，不新增服务、进程或镜像。它由 `TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED`（runner）与 `TENANT_CREDENTIAL_REVOCATION_EXECUTION_ENABLED`（router）两道默认关闭的 gate 控制；每次 materialize/claim 和紧邻不可逆事务前都要求独立、token-protected 的 fresh all-configured fleet ACK。新 admission 与 `0019` job 同事务创建；升级前已提交的 `0018` admission 只由显式、proof-checked materializer 补 job，migration 本身不回填、不删除。成功事务只删除本地数据库 API-key/provider 行并清空 tenant auth 三列，同时写不可变聚合 receipt、完成 job 并激活 write-once cutover；它不接触 tenant registry 或 tenant content。

T3b 的 runtime-revocation worker同样内嵌于runner，不新增服务、进程或镜像。`TENANT_RUNTIME_DRAIN_ENABLED`控制每个runner的私有本地drain端点，`TENANT_RUNTIME_REVOCATION_WORKER_ENABLED`控制已有T3a完成记录的异步处理，`TENANT_RUNTIME_DRAIN_EXECUTION_ENABLED`控制router对精确configured fleet的fan-out，三者均默认关闭。`RUNNERS`必须是每个实例的稳定直连origin，不能是负载均衡别名；启用端点还要求显式、稳定的`RUNNER_ID`。安全升级顺序是先应用`0020`，再发布execution=`0`的新router并排空旧router，滚动所有endpoint/worker=`0`的新runner，逐实例启用endpoint并核对稳定runner/boot identity，再启worker，最后才启router execution。部分fan-out可能已经fence若干runner后整体返回`503`，此时不得回滚旧binary，只能修复配置并精确重试。

T3c 的 `TenantContentInventoryWorker`也内嵌于runner，由独立、默认关闭的`TENANT_CONTENT_INVENTORY_WORKER_ENABLED`控制，不新增router端点或执行gate。先应用带严格schema/index/CHECK/trigger fingerprint的expand-only `0021`，再滚动全部worker=`0`的新runner；确认schema、append-only guards与新binary均已就绪后才逐实例开启worker。它只读取terminal T3b proof、request绑定的immutable policy与当前owner关系；数据库时间落后source high-water、anchor或已写page evidence时可重试而不误报integrity。`contextCompaction`是唯一允许没有真实turn行的item；approval的canonical边是`approvalRequest.approvalId → Approval.id`，legacy `Approval.itemId`只作为历史hash字段保留。page与seal都在最后一个可能阻塞的receipt INSERT后重新读取数据库时间并复核attempt/token/lease，过期则连同已写receipt整体回滚；seal的proof时间仍保持与aggregate一致。关闭worker只暂停新claim，不撤销已写receipt；已经提交任何`0021` job/receipt后不得回退到忽略该证据的旧binary。`0023` T3e只在本地受限动作边界重新验证这份时间点proof；后续完整全域executor仍必须重验它及所有外部/物理ACK，不能把inventory receipt直接当成删除许可。

T3d 的 `TenantPurgePlanWorker`同样内嵌于runner，由独立、默认关闭的`TENANT_PURGE_PLAN_WORKER_ENABLED`控制，也不新增router端点、服务或镜像。`0022`只安装严格fingerprint和append-only guard保护的job、固定33域entry与aggregate receipt；migration不扫描或回填T3c、不调用adapter、不删除/匿名化/撤销数据。生产worker对新空plan直接调用seal；Memory在单一原子边界、MySQL在单个显式REPEATABLE READ事务中重验T1/T3a/T3b/T3c、immutable policy、DB-time deadline、canonical tenant/全部user hold、全局孤儿/owner闭包与live lease，再一次性写33条entry、aggregate receipt和terminal job。MySQL以full-range锁关闭idempotency/usage/reconciliation phantom窗口；legacy completed idempotency `{turnId}`仍兼容，但必须能经真实turn反查同一session；subject lifecycle↔user request/tenant admission必须双向闭合，purge target必须精确匹配session tombstone generation/time。分页build只保留为诊断/兼容路径，不由生产worker调用。T1后仍合法queued/build generation `0`的export会被计入plan，不会被误判为已撤销；download lease只以token的domain-separated hash入证据。缺少Blob/export bytes、Redis、backup/restore、logs/traces adapter时必须写显式blocker；T3a只保留历史计数而没有secret细分，所以tenant auth envelope非零至少阻断KMS域，任一provider config非零必须同时阻断external-provider与KMS两域，不能从“本地DB已清空”推断远端撤销。`planComplete`只表示33域规划证据完整，固定不授予执行或completion authority。

T3e 的 `TenantPurgeExecutionWorker`仍内嵌于runner，不新增公开API、服务、进程或镜像。runner的`TENANT_PURGE_EXECUTION_WORKER_ENABLED`与router的`TENANT_PURGE_EXECUTION_ENABLED`均默认`0`；worker每次materialize、claim、lease边界、local cutover和physical-ACK seal前，都必须取得router对全部configured稳定runner的fresh、non-sticky、token-protected ACK。`0023`只允许当前本地adapter执行五组固定动作：operational usage去身份化、Blob bytes精确delete outbox、user-export revoke与download lease清除、snapshot pin release、export bytes精确delete outbox；outbox只是调度证据，Blob/export cleanup实际完成同一identity后才可追加physical-delete ACK。任一dead-letter会fail closed为blocked，不能算物理成功。安全升级顺序是`0023` → 新router execution=`0`并排空旧router → worker=`0`的code-aware新runner → 确认local cleanup和single-runner filesystem契约并开启全部configured worker → 最后开router gate。首个local cutover激活write-once cutover后只能forward-fix。该切片始终固定`allDomainsComplete=false`、`contentPurgeExecuted=false`，不能被称为完整tenant purge。

`PURGE_POLICY_EVALUATOR_ENABLED` 是 runner/router 双端默认关闭的独立 gate。启用的 evaluator 每次 schedule/claim 前必须从 router 的 token-protected专用barrier取得固定ACK；router要求所有 configured稳定runner当前健康且声明`policy-evaluator-v1`。它只持有最小的evaluation store：按request绑定策略计算grace/内容/ready Blob/usage/receipt deadline，把per-session摘要写成build-generation不可变target，追加rooted decision，并且只对`eligible_execution_disabled`生成不可执行authority。seal时和后续调度都会复核live inventory与tenant/user hold generation/projection；evidence变化或hold ABA会撤销active投影并以新generation重评。该旧authority的deadline仍来自runner wall clock且target不是完整owner清单；`0021` T3c另行生成DB-clock `session_content_receipts`，`0023` T3e也只消费T3c/T3d执行上述本地有限动作，仍没有把0016候选、33域及全部物理/外部/恢复ACK汇总成completion proof，所以completion固定为`false`。

canonical policy / legal-hold 管理 API 也默认关闭：runner 与 router 都设置 `DATA_GOVERNANCE_MANAGEMENT_ENABLED=1`，且全部 configured runner 同时声明 code-aware `dataGovernance` 和 management-active `dataGovernanceManagement` 后才开放。策略版本不可变，`active` 是保留路由名；activation 使用 generation CAS，提交即生效，不是未来定时任务。七个 duration 字段中的 `null` 均表示 fail-closed、没有授权到期。tenant/user 可并存多个 hold，release 只释放指定 hold；任何 active hold都会阻止后续匿名化/物理 purge，但不会恢复已经隐藏的数据。该管理面只建立后续执行边界可审计的authority，不会自行匿名化、删除或把 request 标记 completed；T3e仍须在自己的事务内重新验证canonical hold。

user data export 同样采用默认关闭的 writer gate。runner/router 都设置 `DATA_EXPORT_REQUESTS_ENABLED=1`，全部 configured runner 当前健康并声明 `userDataExport=["artifact-ndjson-v1"]` 且选中 runner 仍启用 admission 后，才接受 admin service key 代表明确 user 发起的 `POST /v1/data-export-requests`；必须携带 `Idempotency-Key`，并要求 active retention policy 的 `exportArtifactTtlMs` 为正值。build/cleanup worker 与 admission 分离，已有 job 在关闭 POST 后仍可 forward-fix。下载逐分片校验并持有有上限的 durable lease，普通 TTL 会等待活动下载；subject erasure 会撤销请求并使制品进入独立 delete outbox。当前制品使用 runner 独占的 filesystem BlobStore，故只允许本地单 runner；`NODE_ENV=production` 下任一 export flag 都 fail-closed，直到共享对象存储适配器完成。

本地统一入口当前启动单个 router、单个 runner，并把 Blob 写入 runner 独占的 `.local-run/blobs`。Blob 上传另有 `BLOB_ATTACHMENTS_ENABLED` 显式 gate，router 还会检查全部健康 runner 的 `blobAttachments` capability；当前 filesystem adapter 同时要求显式 `BLOB_FILESYSTEM_SINGLE_RUNNER=1`。它不能作为多 VM/多 Pod 共享存储，production runner 对 filesystem 写入和 cleanup 都会 fail closed；接入共享 OSS/S3 adapter 前不得在生产开启这两个工作循环。

## API 速览（对外经 `apps/agent-router`）

普通 runtime API 使用两层鉴权：`Authorization: Bearer <service api key>`（→ tenant）+ `X-User-Id`（trusted caller）或 runner 验证的端用户 token。tenant-erasure 两个 platform API 则使用完全独立的 platform bearer，不能复用 service key。入站 token header 不能占用 service/user/framing/hop-by-hop 保留头；即使数据库中存在升级前的坏策略，admin service key 仍可通过 `/v1/tenant/auth` 修复。开发用 key 由 `BOOTSTRAP_API_KEY`（默认 `dev-key`）注入。

```bash
BASE=http://127.0.0.1:8080
H=(-H "Authorization: Bearer dev-key" -H "X-User-Id: u_42" -H "Content-Type: application/json")
# agent 定义（版本化）
curl -sS -X POST "$BASE/v1/agents" "${H[@]}" -d '{"name":"assistant","instructions":"你是一个简洁的助手。","model":{"provider":"dashscope","model":"qwen3.8-max"},"tools":["current_time","web_fetch"],"limits":{"maxSteps":6}}'
# session
curl -sS -X POST "$BASE/v1/sessions" "${H[@]}" -d '{"agentId":"agt_..."}'
# turn（SSE；id: 为 seq，Last-Event-ID / ?after= 可续订；?exclude= 过滤事件）
curl -sN -X POST "$BASE/v1/sessions/sess_.../turns?exclude=usage/updated" "${H[@]}" -H "Idempotency-Key: k1" -d '{"input":[{"type":"text","text":"现在几点？"}]}'
# 非流式：{"stream":false} → 202 + turn；之后 GET .../events?after=<seq> 消费
# 幂等键按 tenant + user + session 隔离；同 key 异请求 → 409。stream 不参与请求 hash；重放命中时固定返回
# 200 application/json {turn} + Idempotency-Replayed: true，需要事件流时用 GET .../events?after=<seq> 续订。
# 其他：GET .../items | .../turns | POST .../turns/{id}/interrupt | steer | tool-results（动态工具回填）
#       GET/POST .../approvals/{id} {decision: accept|acceptForSession|decline|cancel}
#       GET/PUT/DELETE /v1/providers/{id}（BYOK，apiKey 只写不读，AES-GCM 落库）  GET /v1/models  GET /v1/tools
#       POST .../blobs（图片原始字节） | GET .../blobs/{blobId} | GET .../items/{itemId}/output
#       POST .../archive | .../unarchive | .../resume  DELETE /v1/sessions/{id}（fenced tombstone，不物理 purge）
#       POST /v1/data-erasure-requests（admin + user + Idempotency-Key，默认关闭）
#       GET /v1/data-erasure-requests/{requestId}（仅同 tenant/user；worker 最多推进到 awaiting_purge_policy）
#       POST /v1/data-export-requests（admin + user + Idempotency-Key，默认关闭）
#       GET /v1/data-export-requests/{requestId} | GET .../{requestId}/download（同 owner；ready 后可下载 NDJSON）
#       POST /v1/tenant-erasure-requests（独立 platform bearer + Idempotency-Key，默认关闭）
#       GET /v1/tenant-erasure-requests/{requestId}?tenantId=...（gate 关闭后仍可读；当前只返回 gated）
#       PUT/GET /v1/retention-policies/{policyVersion} | POST .../{policyVersion}/activate | GET .../active
#       POST/GET /v1/legal-holds | GET /v1/legal-holds/{holdId} | POST .../{holdId}/release（均为 admin、默认关闭）
#       GET /v1/capabilities  GET /openapi.json  GET /healthz /readyz
```

事件类型与资源 schema 在 `packages/protocol/src/`（zod，单一真相）。`pnpm generate:api` 由同一组 schema 确定性生成并提交 `packages/protocol/openapi.json`、运行时文档常量和 SDK route types；CI 的 `pnpm check:api` 会阻止手改或漏生成。`packages/sdk` 提供可编译/打包的 ESM TypeScript SDK、`openapi-fetch` 类型化客户端、`startTurnStream`、`subscribeSessionEvents` 和增量 SSE 解析器；`pnpm check:sdk` 从实际发布包入口验证消费者路径。

## 目录

```
apps/agent-runner      Hono HTTP + SSE；鉴权；幂等；路由 → SessionHost
apps/agent-router      无状态路由；owner 目录、一致性哈希、SSE 透传与安全重路由
packages/protocol      资源 / 事件 / 错误 schema（zod）
packages/sdk           从 OpenAPI 生成的 TypeScript 路由类型、类型化客户端与 SSE 流式辅助函数
packages/store         SessionStore / LeaseStore / EventBus / BlobStore 接口；ownership manifest 与 Blob delete outbox；memory、MySQL（fenced commit）、Redis（Lua 租约、Streams 热重放）实现；migrations/
packages/core          AgentEngine 接口 + PiEngine（pi-agent-core 适配）；SessionHost（租约续期、write-ahead、审批门、安全阀、Blob/崩溃修复）；上下文装配；内置工具，以及 lifecycle/Blob/erasure/export 内嵌 workers
packages/providers     BYOK provider 配置 → pi Model；密钥加密；国内厂商 preset
packages/testkit       假厂商与跨包测试夹具
deploy/local           本机 redis / mysql 启停脚本
scripts/               本地服务生命周期、验收、验证与维护入口
spikes/pi-embed        pi 嵌入验证（保留作回归参考）
docs/                  调研、设计
```

## 关键不变量（测试覆盖）

- 同一 session 同时只有一个 writer：Redis 租约 + 单调 fence，MySQL 每次写入校验 `fence_token`，旧 owner 的写入被拒绝（`FenceError`）。
- 新 owner 在读取 takeover/orphan 快照前先用纯 `fenceClaim` 推进 MySQL fence；该批次不能夹带业务写，active/archived 行也不会留下 Redis 与数据库 fence 的 hand-off 窗口。
- session 行与首条 `session/created(seq=1)` 由 store 原子创建；序列化或数据库事件写入失败不会留下孤立 session、首事件空洞或部分游标。
- archive/unarchive 与生命周期事件、授权清理和异常审批结算原子提交；archived session 可读但拒绝 turn/steer/compact/approval/dynamic-result 写入。
- DELETE 经同一队列、lease 与 fence 原子提交 `session/deleted`、单调 deletion generation、tombstone marker 和两条 durable cleanup intent；普通资源随即 404。runner 内置 dispatcher 只领取 `session.tombstoned`，以 claim lease 和有上限的指数退避按 at-least-once 语义重投，短暂存储/总线故障默认不会因次数耗尽而永久停投；只有确定损坏的 envelope/event identity 才隔离到 dead-letter，消费者以 event `seq` 去重。`session.purge` 在策略确认前不可领取且不执行物理删除。
- 持久化事件 per-session `seq` 严格连续；delta 事件只走总线不落库不占 seq。
- 工具调用先落库（write-ahead）再执行；崩溃后按是否 `startedAtMs` 生成 `TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN` 交给模型。
- 安全阀 `maxSteps / maxToolCalls / maxWallClockMs / maxCostCNY` 取 min，只能收紧。
- 审批是持久化资源，有 `expiresAt`；`cancel` 记为 interrupted 而不是 declined。
- 跨租户访问返回 404，与不存在不可区分；带 `X-User-Id` 时同租户内也不能读别人的会话。
- user erasure gate 与 request/audit 在 Memory/MySQL 中原子提交；claim-bound worker 使用独立最小权限 catalog/session surface，跨 runner drain 当前 owner、按 child-first 顺序 tombstone、核对 usage，并在完整性证明通过后停在不可领取的 `awaiting_purge_policy`。catalog proof 只是无正文的早期筛查；实际写 billing fact/reconciliation 前会在同一 Memory 原子边界或 MySQL 事务内重新验证 tombstone marker、terminal `session/deleted` 和两条 outbox intent，proof 失效会原子进入 `blocked/integrity_conflict`，数据库/传输故障仍可重试。claim token + attempt + lease 防止 stale/ABA worker 写入；私有路由不泄露 owner、claim、token 或正文。该阶段仍保留 operational 内容和账务归属，不匿名化、不领取 purge、不标记 completed。
- tenant erasure T1 在 Memory/MySQL 中把独立 admission、tenant lifecycle generation、首条无正文 audit 和 append-only credential fence 原子提交；任一步序列化/SQL 失败都不留下部分 gate。T2 的 platform authority只在router终止，以版本化runner-only路由、固定ACK、双端gate和提交前fresh all-configured barrier开放admission/status/replay；路径编码、伪造内部header或直接runner访问都不能把platform token带入普通代理。T3a另以独立双gate、DB-time claim和fresh barrier原子删除本地DB API-key/provider行、清空tenant auth三列，并写不含credential material的receipt；旧`0018` admission只显式materialize。tenant registry/content、runtime cache/active I/O和external revoke仍不在T3a范围，公开status保持`gated`，完整清理及completion proof完成前不得宣称擦除完成。
- tenant erasure T3c 的可信anchor取T3a/T3b数据库证明时间的高水位；roots绑定identity、状态与关系拓扑，并兼容synthetic `contextCompaction` turn和legacy approval item字段。MySQL page/seal在receipt INSERT后再次校验数据库时间与live lease，跨lease等待会回滚receipt、cursor、aggregate和terminal transition；aggregate仍明确不是purge authority。
- tenant erasure T3d 从完整T3c及immutable source proof建立固定33域计划；domain不能因本地没有adapter而缺席，每条entry只保存count/root/disposition/source hash。生产worker在单一Memory原子边界或单个MySQL RR事务中seal全部33域、aggregate与terminal job，并重验source、canonical hold、全局owner closure和post-write lease；MySQL full-range锁阻止idempotency/usage/reconciliation在扫描后并发插入phantom。receipt固定`planComplete=true`、`executionReady=false`、`contentPurgeExecuted=false`，store/worker没有任何delete/anonymize/revoke/completion入口。
- tenant erasure T3e由`0023`建立独立execution/ACK ledger。local cutover只在一次Memory原子发布或MySQL事务中去身份化operational usage、撤销export/释放snapshot pin，并把Blob/export bytes绑定到精确outbox；原cleanup worker实际完成每个outbox后才能seal对应physical ACK。双默认关闭gate与每个有界边界前的fresh all-configured barrier防止mixed fleet执行；receipt固定`allDomainsComplete=false`、`contentPurgeExecuted=false`，不影响公开`dataPurgeExecution=false`。
- T3d owner closure还要求Memory的export/user-erasure/tenant-admission request与其idempotency索引双向一致，并在Memory/MySQL中把legacy compensation deterministic `jobId`精确绑定session owner/tombstone generation/time。MySQL还重算`candidateSha256`并校验`sourceLastSeq`；`erasure_claim`精确绑定request/generation，status精确对应单个audit/result，completed event seq等于`session.lastSeq`且success evidence完整。
- T3d的全库RR/next-key owner扫描目前是local/CI正确性基线，生产规模下的索引、容量、写阻塞/死锁与锁超时尚待staging验证；损坏的queued plan envelope当前fail-closed但可能饿死后续job，cursor重启还会重扫损坏前缀，M4需增加raw-key quarantine/skip。全局orphan/cross-owner损坏会把当前claim终结为`blocked`，即使之后修复数据也没有自动resume/rebuild；该路径无执行权且安全fail-closed，但可永久阻塞该tenant，后续需operator repair/resume协议。`0022` trigger fingerprint不校验action body，迁移夹具只显式模拟首个DDL auto-commit边界，两者是剩余的特权schema tamper/测试深度风险。
- erasure claim按候选独立提交：具备安全quarantine envelope的确定性poison会持久化为保留原phase、无worker authority的quarantine并继续扫描邻居；append-only control audit、canonical evidence、generation CAS和固定maintenance action共同约束repair/resume。隔离身份/generation/时间本身损坏时，不猜测归属，也不复制tenant/user/raw payload：保留原行与exact fence，原子写terminal overlay和append-only content-free incident，随后继续邻居；该incident无通用repair/resume。损坏control audit也没有通用自动修复路径，不能靠直接改表伪造完成。若control generation已达到/超过JS safe-integer上限，则原始MySQL BIGINT fence保持不变并进入无后继event、不可修复的terminal quarantine，避免降级fence或反复饿死邻居。公开API只把可安全owner读取的quarantine映射为`blocked`，不返回私有原因、证据或control generation。
- pre-0009 的 generation `0` tombstone 由独立 durable compensation job 修复。`0014` migration 只安装 inactive cutover、job/audit 表、索引与 guards，不扫描、排队或改写历史行；worker 只有通过 v2 fleet barrier 才会激活一次性 cutover并开始处理。成功事务保留原删除时间，固定结算残留 active 资源，递增到 generation `1`，追加 terminal `session/deleted`、`session.tombstoned`/不可领取的 `session.purge` intent、append-only audit并完成 job；任一步失败全部回滚，重试不会重复证据。cutover 激活后数据库拒绝新的 legacy tombstone 写入，不能回退 pre-`0014` writer。
- retention policy 版本和 activation audit不可变；control generation CAS与 rooted hash chain 防止 lost-update/ABA，跨 runner 时钟回拨通过锁内单调 clamp处理。tenant/user legal hold使用多记录账本、active projection与append-only event chain，release 只允许一次；Memory/MySQL 都会在 usage anonymize 前读取 canonical tenant+user hold状态并 fail-closed。`0015` migration不提供默认策略、不改变 purge intent、usage或内容；policy/hold 管理本身也不构成删除授权。
- `0016` evaluator job使用attempt/token/lease防ABA；每个build的target、decision与authority证据不可变且hash-chain可重算，seal与validated read都会复核owner、request-bound policy、live inventory及两级hold fence。build期间证据漂移会以`evidence_changed`开启新generation，sealed证据后漂移也会由scheduler重评。authority无availability/claim/lease字段，`dataPurgeExecution=false`且completion proof固定不完整，因此任何`eligible_execution_disabled`都不能触发匿名化或删除。
- `0017` export request/job/snapshot/artifact/download/delete 状态均绑定 tenant、user、subject generation 与 build/deletion generation。MySQL 在 `REPEATABLE READ WITH CONSISTENT SNAPSHOT` 事务内复制白名单记录，事务外按确定性 `ndjson-v1` 分片发布；只有全部分片和整体 digest 验证后才原子变为 ready。claim/download/delete 都使用 lease 与 CAS 防 stale/ABA；跨 owner 统一 404，失败或撤销不会留下可下载的部分制品。附件只以 base64 chunk 输出，内部 Blob key、idempotency、secret、claim 和 fence 从不进入制品。
- 通用erasure transition API不能表达`purging/completed`或由调用方注入completion proof；lifecycle outbox的claim/renew/complete/retry也全部绑定`session.tombstoned` topic。旧版或异常进程即使留下`session.purge` claim token，也不能借通用ACK接口把它续租、完成或重新排队。
- 新 usage write 以 opaque `usage_id` 在同一事务双写 operational ledger 与不含 user/session/turn/step/raw JSON/精确请求时间的 billing fact；金额以 9 位小数规范字符串写入 `DECIMAL(24,9)`。session/turn/event/compaction 投影由 ledger 权威重建，MySQL 使用一致性快照内的 SQL 聚合；legacy `usage_id IS NULL + costCNY=0` 保守视为 unknown，而新版有 identity 的零价仍为 known-zero。legacy row 只有在 tombstone generation、owner、逐行事实和汇总校验和全部核对后才可显式匿名化，任何 ledger/session owner 不一致都会 fail-closed。普通聚合只有在全部组成记录都有价格时才返回完整 `costCNY`；任一未知价格都会保持缺失，已知零价仍为 `0`。启用 `maxCostCNY` 时，未定价的正常 step 会在落账后 fail-closed，不能继续执行其工具或下一模型 step。
- 审批授权是服务端状态，客户端 metadata 改不动；BYOK 的 `baseUrl` 必须解析到公网地址。
- 被抢占（fence 失效）或会话被删除时，turn 立即停止，不再调模型、不再执行工具。
- 同一条流式消息的 item 只分配一次 seq，`?afterSeq=` 增量拉取不会漏掉最终回答。
- Blob 客户端只看到 owner-scoped opaque `blobId`，看不到物理 locator；输入图片会校验声明 MIME 与文件签名，且所选模型必须声明 image input。从 `staging` 到 item 的 `ready` 绑定与业务 commit 原子提交，tenant/user/session 或 item 不匹配统一返回 404。达到阈值的合法工具输出卸载到 Blob 并由 `outputRef` 精确取回；不可序列化、超过持久化硬上限或 storage adapter 写入失败的结果都会在当前 step 与重放中变成同一稳定失败，且不会回显物理路径/locator。单次模型请求优先装配当前输入，历史按新到旧使用剩余水合预算；compaction 只有在 summary range 的全部外置工具事实都能物化时才推进 watermark。当前历史图片像素不会跨 compaction 保留，长期视觉记忆仍需后续视觉摘要/OCR。过期未绑定 staging 通过专用 outbox/claim lease 按 at-least-once 语义删除，key-scoped cancellation fence 阻止迟到上传复活对象；ready Blob 的 session erasure/物理 purge 尚未开启。
