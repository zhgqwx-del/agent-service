# 本地开发、手动体验与 CI 构建指南

本文是理解和操作当前 `agent-service` 的长期维护入口，回答三类问题：本地需要启动什么、怎样手动体验、GitHub Actions 实际构建和验证什么。

里程碑完成度以 `docs/PROGRESS.md` 顶部快照和最后一节为准；本文只描述操作方式和交付产物，不替代进度记录。

## 1. 服务、基础设施与代码库

本项目当前只有两个应用服务：

| 组件 | 默认地址 | 是否独立进程 | 职责 |
| --- | --- | --- | --- |
| `agent-router` | `http://127.0.0.1:8080` | 是 | 对外入口、runner 发现、session owner 路由、SSE 透传和一次安全重路由 |
| `agent-runner` | `http://127.0.0.1:8787` | 是 | 鉴权、Agent Runtime API、模型执行、session/turn/item/event/approval 与 Blob 生命周期 |
| MySQL | `127.0.0.1:3306` | 是，外部基础设施 | 业务真相、持久事件、配置、operational/billing usage、subject lifecycle、Blob manifest/outbox |
| Redis | `127.0.0.1:6379` | 是，外部基础设施 | 租约、fence、owner 目录和事件热扇出 |
| `packages/sdk` | — | 否 | 供客户端使用的 TypeScript SDK |
| `protocol/core/store/providers/testkit` | — | 否 | 被 runner/router 或测试加载的内部代码库 |

正式客户端应访问 router 的 `8080`。runner 的 `8787` 用于开发诊断和对照，不应当成为生产环境的公网入口。

当前本地拓扑覆盖已实现的 M1/M2 主链路，包括 Archive/tombstone/outbox、Blob ownership/业务接线、usage 财务分层、默认关闭的 user erasure、`0015` canonical retention policy/multi legal hold，以及`0016`非破坏性purge-policy evaluator/authority substrate。terminal-event dispatcher、Blob cleanup、durable erasure worker、generation-zero tombstone compensation worker与policy evaluator都是runner内部工作循环，不是第三个应用服务或镜像。普通 erasure worker 会在 router 私有 fleet barrier 放行后逐候选隔离确定性 poison，再跨 runner drain active turn、child-first tombstone、reconcile usage，并停在 `awaiting_purge_policy`；compensation worker 把 pre-0009 generation `0` tombstone 补成可审计的 generation `1` terminal proof；默认关闭的evaluator只建立不可执行target/decision/authority证据。三者都不执行物理删除或把request标记completed。异步 export artifact/TTL 执行、tenant/key/provider/auth-secret 撤销、可信时钟/完整内容proof、ready/session purge、completed proof 与 restore replay 仍未完成，因此 M1 尚未闭环。M3/M4 实现后继续加入本文；设计中的目标模块不会提前伪装成可启动服务。

## 2. 一次性准备

前置条件：

- Node.js 24；
- pnpm 12.5.1（仓库由 `packageManager` 固定版本）；
- `curl`；
- 当前开发机约定位置上的 MySQL 8 和 Redis；如自行提供兼容实例，需要绕过下文会无条件调用 `infra.sh` 的统一入口，分别启动应用和测试；
- Python 3，`scripts/demo.sh` 用它解析响应、构造后续请求并执行断言。

```bash
cd /Users/zhangguoqiang/ai-workspace/claude-workspace/meetyou/agent-service

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

`scripts/local-service.sh` 会读取 `.env`，但不会主动打印其中的值。当前端口/地址、Redis、tombstone/Blob gate、`DATA_ERASURE_REQUESTS_ENABLED`、`DATA_GOVERNANCE_MANAGEMENT_ENABLED`、`PURGE_POLICY_EVALUATOR_ENABLED`、`ERASURE_WORKER_ENABLED`、`LEGACY_TOMBSTONE_COMPENSATION_ENABLED` 和 `ERASURE_ROUTER_URL` 等显式命令行值优先；其它同名值可能被 `.env` 覆盖，使用前应检查配置来源，但不要打印密钥。

## 3. 启动与停止完整本地栈

```bash
scripts/local-service.sh start
scripts/local-service.sh status
scripts/local-service.sh smoke
```

`start` 的顺序是：

1. 通过 `deploy/local/infra.sh` 启动 MySQL 和 Redis；
2. 从 TypeScript 源码启动一个 runner；
3. 从 TypeScript 源码启动一个 router，并等待其发现健康 runner。

runner 启动后会同时启动 lifecycle outbox dispatcher、Blob cleanup、durable erasure worker 和 generation-zero compensation worker；policy evaluator只有显式开启后才启动。停止时先并发停两个 erasure workers与evaluator、drain SessionHost，再等待其它 workers。产品配置中 `ERASURE_WORKER_ENABLED`、`LEGACY_TOMBSTONE_COMPENSATION_ENABLED` 与`PURGE_POLICY_EVALUATOR_ENABLED`都默认 `0`；本地脚本为已有job的完整生命周期验证显式开启前两个，但evaluator仍保持`0`。`DATA_ERASURE_REQUESTS_ENABLED` 与 `DATA_GOVERNANCE_MANAGEMENT_ENABLED` 也默认 `0`，所以普通启动不会意外 gate 新 user、开放 policy/hold 管理写面或生成新authority。compensation worker 首次通过 v2 barrier 后可能激活数据库的一次性 cutover，之后该本地库不能再安全配合 pre-`0014` writer。drain/转发的默认超时层级是 runner 10s < router 15s < worker 20s；部署时必须保持这一严格大小关系。Blob gate仍按单 runner filesystem约束开启；该 root不能当成跨 VM/Pod共享数据面。

要专门体验当前 user erasure gate，请只对可丢弃 user 显式开启两端 gate 后重启：

```bash
ERASURE_WORKER_ENABLED=1 LEGACY_TOMBSTONE_COMPENSATION_ENABLED=1 \
  DATA_ERASURE_REQUESTS_ENABLED=1 scripts/local-service.sh restart
curl -sS http://127.0.0.1:8080/v1/capabilities | python3 -m json.tool
```

预期 router capability 中 `dataErasureRequests` 为 `true`，并在管理 gate 仍关闭时同时显示 `dataGovernance=["canonical-retention-v1","multi-legal-hold-v1"]`、`dataGovernanceManagement=false`；这证明 admission writer 理解 durable authority，但不开放管理端点。直接查看 runner capability 时 `erasureJobControl` 还会同时包含 `quarantine-v1` 与 `legacy-tombstone-compensation-v1`。该 admission 开关只接受 durable request，不会启用物理 purge。rollout 状态故意不出现在 router 公开 capability；它只通过带 `INTERNAL_ROUTER_TOKEN` 的 v2 私有固定 ACK 供 worker 检查。旧 v1 路径故意不兼容并返回 404，避免旧 worker 在 compensation rollout 期间继续 claim。部署时可以只关闭 router writer gate 并保持 capable runner 的 gate 开启，此时已有 request 的 status GET 继续可读；mixed fleet 会返回 `503`。POST/status 的成功与错误响应均带 `Cache-Control: no-store`，不得在调试代理中改写为可缓存。本地统一脚本用同一个变量配置两端，因此体验结束后运行 `DATA_ERASURE_REQUESTS_ENABLED=0 scripts/local-service.sh restart` 会同时关闭 runner admission capability：新的 POST 和 status GET 都会返回 `503`，但已经落库的 subject gate 不会被撤销，两个后台 worker仍可继续 forward-fix。

staging/production 的 tombstone gate 必须按第 9 节滚动发布流程激活。当前 production runner 会拒绝启用 filesystem Blob 写入或 cleanup：共享 OSS/S3 adapter 尚未实现，任何 replica 都不能领取全局 MySQL outbox 后只操作自己的本地磁盘。没有共享对象存储时，不能因 reader 代码存在就声称 production Blob 可用。

`smoke` 不调用真实模型，验证两端 readiness、两份 OpenAPI、router 转发和未鉴权请求返回 `401`。

日志和停止命令：

```bash
scripts/local-service.sh logs
scripts/local-service.sh status

scripts/local-service.sh stop  # 只停 router/runner，保留 MySQL/Redis
scripts/local-service.sh down  # 停 router/runner/MySQL/Redis
```

应用 PID 和日志保存在未提交的 `.local-run/`。`stop` 发送 `SIGTERM`，让 runner 有界 drain；超时会保留现场并报错，不会擅自强杀。

### 基础设施脚本的机器边界

`deploy/local/infra.sh` 是当前 macOS 开发机的适配脚本，默认查找：

- `~/.local/bin/redis-server` 和 `redis-cli`；
- `/usr/local/bin/mysqld` 和 `mysql`；
- `~/.local/var` 下的数据目录。

其它机器可用 `REDIS_BIN`、`REDIS_CLI`、`MYSQLD`、`MYSQL` 覆盖路径。`deploy/local/compose.yaml` 只启动 MySQL/Redis，应用仍从宿主机启动；使用 Compose 或其它兼容实例时不要执行会再次调用 `infra.sh` 的 `local-service.sh start/verify`，而应按第 7 节的两条源码命令启动应用，并直接运行下面的等价门禁。先显式创建 `agent_service_test` 与 `agent_service_cluster` 两个可丢弃数据库；测试安全门会拒绝把业务库 `agent_service` 当删除/重建目标。后续会为统一入口增加显式的外部基础设施模式。

```bash
pnpm check:secrets
pnpm check:api
pnpm typecheck
mkdir -p .local-run
AGENT_SERVICE_INTEGRATION=1 MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" REDIS_TEST_URL="redis://127.0.0.1:6379/1" \
  pnpm vitest run --coverage --exclude 'test/cluster/**' \
    --reporter=default --reporter=json --outputFile.json=.local-run/verify-tests.json
AGENT_SERVICE_TEST_REPORT=.local-run/verify-tests.json node scripts/assert-suites-ran.mjs
MYSQL_MIGRATION_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:migrations
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:blob-mysql
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:usage-lifecycle-mysql
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:subject-lifecycle-mysql
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:retention-policy-mysql
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:erasure-purge-policy-mysql
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:erasure-job-mysql
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:erasure-session-mysql
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:erasure-catalog-mysql
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:erasure-usage-mysql
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:legacy-tombstone-mysql
AGENT_SERVICE_CLUSTER=1 CLUSTER_MYSQL_URL="mysql://root@127.0.0.1:3306/agent_service_cluster" CLUSTER_REDIS_URL="redis://127.0.0.1:6379/3" \
  pnpm vitest run test/cluster
pnpm build:check
```

`deploy/local/infra.sh reset-db` 会删除并重建 `agent_service`、`agent_service_test`，不会重建 `agent_service_cluster`；同时会对该 Redis 实例执行全局 `FLUSHALL`。它不是普通重启步骤。

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

两端提供同一份 OpenAPI 3.1 契约。当前没有内置 Swagger/Scalar 页面，可把 `http://127.0.0.1:8080/openapi.json` 导入 Postman、Insomnia 或 Swagger Editor。

router 的 `/_router/targets` 会暴露内部 runner 地址和可选 session owner，因此默认返回 `404`。只有显式配置 `ROUTER_ADMIN_TOKEN`、重启服务并携带对应 bearer token 后才开放。

## 5. 手动体验 Agent Runtime

推荐通过统一入口运行十阶段流程：

```bash
scripts/local-service.sh acceptance
```

它固定经 router 调用，覆盖：鉴权、agent/session、SSE turn、消息历史、断线重放、幂等、跨轮上下文、安全阀、同 tenant 的 user 隔离、请求体限制与 BYOK。跨 tenant 隔离由自动测试覆盖。该命令使用真实模型，会产生少量费用。

`scripts/demo.sh` 单独运行时默认直连 runner；若要显式经 router 运行：

```bash
BASE=http://127.0.0.1:8080 scripts/demo.sh
```

README 的 API 速览提供创建 agent、session 和 turn 的逐步 `curl` 示例，并默认把 `BASE` 指向 router 的 `8080`。

拿到 `SESSION_ID` 后，可单独体验可逆生命周期；下列请求都应经 router：

```bash
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
BASE=http://127.0.0.1:8080
printf 'Disposable local tenant admin key: '
IFS= read -r -s ADMIN_KEY
printf '\n'
GH=(-H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json")

# 1/8 注册 immutable policy version；所有 null 都表示 fail closed、不授权到期
curl -sS -X PUT "$BASE/v1/retention-policies/local-safe-v1" "${GH[@]}" \
  -d '{"policy":{"sessionContentRetentionMs":null,"userErasureGraceMs":null,"operationalUsageRetentionMs":null,"idempotencyReceiptRetentionMs":null,"billingFactRetentionMs":null,"lifecycleAuditRetentionMs":null,"exportArtifactTtlMs":null}}' \
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

unset ADMIN_KEY GH
```

policy 激活在 activate 事务的线性化点立即生效：之后新建的 erasure request 必须绑定当时 active policy 的精确 version/hash；激活前已有的 backlog 不会被静默改绑。当前 API 没有未来 `effectiveAt` 参数，不支持定时激活；要切换策略，应先注册新 version，再用当前 generation 执行一次即时 CAS 激活。policy 中的 duration 只是后续 destructive worker 的 canonical authority，当前没有 export worker、tenant revoke、ready/session purge、completed proof 或 restore replay，因而激活 policy 仍不会删除、匿名化或导出任何数据。

体验结束后可关闭管理 API，但这不会回滚任何 durable policy/hold 状态：

```bash
DATA_GOVERNANCE_MANAGEMENT_ENABLED=0 scripts/local-service.sh restart
```

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

即使观察到authority也不能据此尝试手工删除：deadline当前使用runner wall clock，尚未由共享数据库/可信时间处理跨VM skew；也缺少owner-scan + `session_content_receipts`、Blob physical ACK、usage匿名化、receipt/Redis清理、secret撤销和restore-ledger ACK。store的completion readiness固定为`false`。体验结束后可关闭三个外部gate；已经提交的subject gate和immutable evidence不会回滚：

```bash
PURGE_POLICY_EVALUATOR_ENABLED=0 \
  DATA_GOVERNANCE_MANAGEMENT_ENABLED=0 \
  DATA_ERASURE_REQUESTS_ENABLED=0 \
  scripts/local-service.sh restart
```

quarantine是数据库完整性故障路径，不应通过普通手工体验故意破坏业务库。安全owner envelope的公开status只会显示`blocked`，不会返回私有reason/evidence/control generation；当前maintenance能力是store级最小权限接口，尚无公开或admin HTTP端点。逐候选隔离、重启保留、双管理员CAS、repair回滚和恢复领取由Memory、真实MySQL与cluster自动测试验证。request/tenant/subject identity、generation或有序安全时间戳自身损坏时，store不尝试owner读取或自动修复，而是在同一原子边界保留原字段、撤销worker authority并写content-free append-only terminal incident；真实MySQL测试覆盖exact BIGINT、双store竞争、incident INSERT回滚与邻居继续领取。若真实环境出现`control_audit_invalid`或terminal incident，当前只能保持隔离、备份证据并forward-fix，没有通用“自动修好审计链”按钮。

## 6. 四级验证路径

```bash
scripts/local-service.sh smoke
# 无真实模型费用；检查正在运行的服务和路由

scripts/local-service.sh verify
# 无真实模型费用；运行 secret/API drift/typecheck、MySQL/Redis 集成、
# 包含 Blob/usage/subject/retention-policy/legal-hold/policy-evaluator/erasure/legacy-compensation real-MySQL 专项、
# 0007→...→0016 历史迁移、真实多进程 cluster、
# SDK 打包和两个应用 bundle 启动门禁

scripts/local-service.sh verify-real
# 读取本机 .env，只跑真实 provider E2E，会产生费用

scripts/local-service.sh acceptance
# 从 router 完成端到端人工体验，会产生费用
```

日常开发至少运行与修改范围匹配的定向测试；合并或里程碑冻结前运行完整 `verify`。真实模型路径只有在明确需要时运行，不能把未重跑的历史结果描述为本轮结果。

手动体验不必等到 M1/M3/M4 全部完成：每个安全切片先做短反馈，能更早发现交互和运维问题；待本地/CI整体范围完成后，再按第 3～6 节做一次完整 walkthrough作为阶段验收。canonical policy/multi legal hold管理和non-destructive evaluator已接线；当前尚未接线的是异步 export artifact/TTL、可信时钟/完整content proof、destructive purge/completion、tenant/key/provider/auth-secret revocation、restore replay、M3扩展和M4生产化，不能提前模拟成已存在。

## 7. 本地源码进程与生产构建产物

本地 `start` 使用：

```text
node --env-file=.env --import tsx apps/agent-runner/src/main.ts
node --env-file=.env --import tsx apps/agent-router/src/main.ts
```

这两条命令要从仓库根目录分别在两个终端执行；`--env-file=.env` 不能省略，否则 runner
拿不到 `SECRETS_MASTER_KEY`/存储配置，router 也拿不到 `RUNNERS`。等价的 workspace 命令是
`pnpm --filter @agent-service/runner start` 与 `pnpm --filter @agent-service/router start`，两个
package script 同样会加载仓库根目录的 `.env`。`scripts/local-service.sh start` 则在启动前自行
加载 `.env`，并为本地单 runner Blob 拓扑补齐显式覆盖。

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

SDK 和两个应用分别生成：

- `packages/sdk/dist/` 中的 JavaScript、类型声明及 source maps；
- `apps/agent-runner/dist/main.js`；
- `apps/agent-router/dist/main.js`；
- 对应 source map、`dist/package.json` 和 SQL migrations。

这些是 Node 24 的单文件 ESM bundle，不是 Windows `.exe` 或 Linux ELF 原生机器码。构建会内联 `@agent-service/*` workspace 代码，但第三方包仍由 production `node_modules` 提供。因此单独复制 `dist/main.js` 不是完整的裸 VM 发布包。

`pnpm build:check` 在 `pnpm build` 之后还会：

1. 对 SDK 执行真实 `pnpm pack`，在隔离 consumer 中验证包名 import 和 TypeScript 声明；
2. 用原生 Node（不使用 `tsx`）启动 runner/router bundle；
3. 验证 readiness、capabilities、router 转发和两端 OpenAPI 精确一致。

如果未来明确采用裸 VM，应增加带校验和的 `bundle + migrations + production node_modules` 发布归档和 systemd 单元。当前最完整、最可重复的部署产物是 OCI 镜像。

## 8. GitHub Actions 构建与验证

`.github/workflows/ci.yml` 对 push 到 `main` 和 pull request 运行。

### `test` job

GitHub 的主测试 job 固定启动最低支持版本 `mysql:8.0.26` 与 Redis 8；镜像 job
另外保留浮动 `mysql:8.0`，因此同一次 CI 同时覆盖最低 SQL 兼容下限和当前 MySQL 8
镜像。随后执行：

1. 凭据扫描；
2. frozen-lockfile 安装；
3. OpenAPI/生成 SDK 漂移检查；
4. 源码与测试的 TypeScript 全量检查；
5. 单元及 MySQL/Redis 集成测试和覆盖率门槛；
6. 断言集成套件没有被环境错误静默 skip；
7. 以单独、可见且不得 skip 的 `pnpm test:blob-mysql` 再跑 Blob ownership/绑定/cleanup 真实 MySQL 专项套件；
8. 以同样的独立门禁运行 lifecycle outbox 真实 MySQL 专项套件；
9. 以 `pnpm test:usage-lifecycle-mysql` 强制执行 usage 双写、冲突回滚、reconcile、legal hold 和 anonymize 真实 MySQL 套件；
10. 以 `pnpm test:subject-lifecycle-mysql` 强制执行 durable gate、request/audit 回滚、create 竞态和 Blob 写阻断；
11. 以独立、可见且不得 skip 的 `pnpm test:retention-policy-mysql` 验证 canonical policy 与 multi legal hold 的 real-InnoDB CAS、immutable/audit 回滚、跨 runner 时钟单调化，以及 erasure admission/usage anonymize 竞态；主 JSON report 也强制证明该文件实际执行；
12. 以独立、可见且不得 skip 的 `pnpm test:erasure-purge-policy-mysql` 验证0016 evaluator的原子job建立、request-bound deadline、claim/ABA、live evidence与hold ABA重评、并发锁顺序及seal回滚；主JSON report也强制证明该文件实际执行；
13. 分别强制运行 `test:erasure-job-mysql`、`test:erasure-session-mysql`、`test:erasure-catalog-mysql`、`test:erasure-usage-mysql`，证明 claim/lease/audit、固定动作/回滚、无正文 completeness scan 及 claim-bound usage/ABA 事务确实执行；主 JSON report 还强制证明真实 MySQL 的 `erasure-worker.mysql.test.ts` 已执行，覆盖 catalog→usage 间 proof 损坏与零部分写；
14. 以独立、可见且不得 skip 的 `pnpm test:legacy-tombstone-mysql` 验证 generation-zero compensation 的一次性 cutover、claim/ABA、原子发布、失败回滚、owner/child 隔离与幂等重试；
15. 从冻结历史 schema 验证 `0007 → ... → 0016`；其中独立 `0013 → 0014` 夹具证明 dormant compensation cutover 的 replay/linearization，`0014 → 0015` 夹具证明 legacy hold导入与policy-binding guard，`0015 → 0016`夹具证明原policy/hold/request/content保留、partial-DDL/marker-loss replay、append-only evidence guards、升级后同key异内容写入被拒且原证据保留，以及purge继续dormant；migration wrapper 会核对清单并拒绝任一缺失或 skip 的夹具；
16. 真实 runner/router 多进程 cluster，包含 remote erasure drain、owner `SIGKILL` takeover以及 quarantine/restart/repair，并通过 v2 fleet barrier；
17. `pnpm build:check`；
18. 上传 coverage artifact。

MySQL 和 Redis 是拉取的第三方 service images，不是本仓库构建的产品服务。

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

每个镜像都包含 Node 24 slim、该应用 bundle、迁移和 production dependencies。它们是 Linux OCI image，不是 VM磁盘或原生机器码。CI会实际启动镜像并检查 OpenAPI/healthcheck；runner还查询 `schema_migrations`，明确验证最新 `0016_erasure_purge_policy_authority.sql` marker 已由镜像内迁移器写入，并验证 production bootstrap。该 marker 只证明0016 expand schema/guards已安装，不表示evaluator已激活、存在eligible authority，更不表示purge已启用。生产默认仍关闭 Blob filesystem writer/cleanup、erasure admission、普通 erasure worker、compensation worker、data-governance 管理面与policy evaluator，不会绕过未激活边界。

当前 workflow 使用 `load: true` 供本 job 启动验证，没有把镜像 push 到 registry。SDK `.tgz` 也是临时验证后删除；当前明确上传的 GitHub Actions artifact 只有 coverage。

## 9. 从本地到未来生产的交付语义

目标 promotion 链是：

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

tombstone 保持在 exact protocol family `2026-10-08`，作为 additive capability 激活。发布时先由 API gateway 暂停精确 session DELETE（或整体切换 router 池），部署新 router 且保持 `SESSION_TOMBSTONE_ENABLED=0`，排空全部旧 router，再滚动新 runner；确认每个健康 runner 都声明 `tombstone` 后才把新 router gate 设为 `1`。router 会在显式 gate 之外持续检查全健康 fleet，任一健康旧 runner 存在时 DELETE 都返回可重试 `503`。仅逐个替换旧 router 而不先阻断 DELETE 不安全，因为旧 router 没有这个 gate；runner 端口也必须保持内网不可直连，否则会绕过 router gate。

这套 activation gate 只覆盖同一 protocol family 内的 additive tombstone rollout。未来真正改变 protocol version 时仍需全量 drain 的维护窗口协调切换或整组 blue-green，除非再实现 version range/按版本路由。

Blob 写入也采用 expand→activate：`0010` 先增加 ownership manifest 和专用 delete outbox，reader 在 writer gate 关闭时仍可服务已绑定对象；router 只有在 `BLOB_ATTACHMENTS_ENABLED=1` 且全部健康 runner 声明 `blobAttachments` 时才转发新上传。当前这只用于单 runner 本地体验，因为 runner 在 `NODE_ENV=production` 下会对 filesystem Blob writer 与 cleanup 都 fail closed。未来接入共享对象存储 adapter 后，才可以按“迁移 → 新 runner（cleanup/read 开、writer 关）→ 新 router（gate 关）→ 核对 fleet/storage → 激活 writer gate”的顺序开放 staging，再以同一 image digest 推进 production。filesystem `BLOB_DIR` 不能通过复制到多台 VM、hostPath 或各 Pod 独立卷伪装成共享对象存储。

user erasure 与 legacy compensation 共用新的 v2 expand→activate barrier：先应用 `0011`/`0012`/`0013`、dormant expand-only 的 `0014`，以及同样 expand-only 的 `0015`，部署只接受 v2 私有 control ACK 的新 router并保持 `DATA_ERASURE_REQUESTS_ENABLED=0`，排空全部旧 router 与只认识 v1 的旧 worker并等待旧 lease 到期；再以两个 worker flag 都为 `0` 的状态滚动具备 `drain-v1`、`quarantine-v1` 与 legacy compensation 代码的新 runner。`0014` migration 只安装 inactive cutover、durable job/audit 和 guards，不排队、不改 session、不激活 purge；`0015` 也不创建默认 active policy、不改绑历史 request、不开放 purge。旧 v1 endpoint 故意 404，不能当作兼容 fallback。

确认 fleet 都是新 binary 后，再逐实例设置 `LEGACY_TOMBSTONE_COMPENSATION_ENABLED=1`；启用的 runner 才声明 `legacy-tombstone-compensation-v1`。部分 rollout 期间 v2 barrier保持关闭，直到 router 在本进程观察每个稳定 `RUNNERS` 地址同时声明 `quarantine-v1` 与 `legacy-tombstone-compensation-v1`，才返回 token-protected `job-control-v2` ACK。观察后纯不可达保留进程内 attestation，明确旧版/错误响应则撤销；router 重启会丢失 attestation并安全暂停 claim，直到地址恢复或从配置移除。compensation worker 首次获得 ACK 后会激活 write-once cutover；从该线性化点开始数据库拒绝新的 generation `0` tombstone 写入，故不能回滚 pre-`0014` writer。随后才按需启用 `ERASURE_WORKER_ENABLED`，确认 configured fleet当前全部健康并声明`dataErasureRequests`后，最后依次启用runner、router writer gate。产品环境的两个 worker与 admission都默认 `0`；本地统一脚本显式启用两个 worker但保持 admission `0`。

`0015` 的管理面采用独立的 expand→code-aware→management-active 顺序。先发布新 router 并保持 `DATA_GOVERNANCE_MANAGEMENT_ENABLED=0`、排空旧 router，再滚动同样保持 management=`0` 的新 runner；此时新 runner 已理解 policy/hold durable contract，必须在管理端点关闭时仍声明 `dataGovernance=["canonical-retention-v1","multi-legal-hold-v1"]`。确认每个 configured 稳定地址都健康并声明这两项后，才逐实例开启 runner management gate，最后开启 router gate；只有全部目标的 `dataGovernanceManagement=true` 时，router 才开放 8 个 admin API。runner 端口必须继续限制为内网可达，不能绕过 router 的 fleet gate。

policy activate 是提交即生效的 generation CAS，不提供未来时间调度。`effectiveAtMs` 是锁内单调化的审计/控制时间，不是一个等待执行的计划时间；activation 与新 erasure admission 通过 tenant control lock 线性化，后提交的新 request 永久绑定 active version/hash，先提交的 backlog及其幂等 replay保持原身份。`0015` 在 `erasure_requests` 上安装冗余 `BEFORE INSERT` guards，并在同一 policy control 上取共享锁：dormant 时只接受 `NULL/NULL`，active 后只接受精确 version/hash。因此即使 health probe 后稳定地址被换成旧 binary，绕过新版应用的 pre-`0015` writer也只能让事务失败，不能静默留下未绑定或错绑 request。

首次 policy activation 或 canonical legal-hold control event 提交后，0015 成为 forward-only 兼容边界：关闭 management/admission gate只能停止新管理请求或新 erasure request，不能取消 active policy、active hold 或现有 request binding；不得回退到不会验证 canonical ledger、不会绑定 policy 的 pre-`0015` reader/writer，也不得删除 control/event、清空 policy identity 或做 down migration。一个 hold 的 release 不影响同 subject 的其它 active hold，故障恢复必须保留 durable evidence 并 forward-fix。

`0016` evaluator使用另一条expand→code-aware→active边界：先应用destructive-dormant migration，再发布`PURGE_POLICY_EVALUATOR_ENABLED=0`的新router并排空旧router，滚动同样gate=`0`但声明`policy-evaluator-v1`的新runner。确认每个configured稳定地址当前健康且code-aware后，逐runner开启evaluator，最后开启router gate；每次schedule/claim仍必须取得token-protected固定ACK。公开`purgePolicyEvaluation`只表示fleet awareness，`dataPurgeExecution=false`才是当前执行边界。关掉gate只停止新的evaluation pass，不删除job/decision/authority，也不撤销subject gate。

`0016` authority不能直接用于未来purge：eligibility由runner wall clock记录，尚未使用共享数据库/可信时间抵御跨VM forward/slow skew；per-session target也不是turn/item/event/approval的完整owner inventory。destructive executor必须另行提供默认关闭的双端gate，在执行事务中用可信时间和canonical hold重验，owner-scan并写`session_content_receipts`，再核对ready Blob ACK、usage匿名化、receipt/Redis清理、secret撤销和restore-ledger ACK。当前completion固定为false；live evidence或hold generation/projection变化会让旧active projection失效并以新build generation重评，而不是覆盖旧证据。

当前普通 worker 已能逐候选隔离确定性 claim poison、有界请求 abort、child-first tombstone、在 usage 写事务内重验 terminal proof，并停在 `awaiting_purge_policy`；compensation worker 已能保留历史 `deletedAt` 并在一个事务中生成 generation `1` terminal event、两条 outbox intent、append-only audit 和 job completion；evaluator已能形成不可执行的immutable candidate并在live evidence/hold变化后重评。三者都不会让 `session.purge` 可领取、删除内容或完成 user erasure request。物理 purge/completion、export、tenant revoke 与 restore replay 尚未闭环，所以 staging/production admission 仍保持 `0`。任一已配置 target 暂时不可达或仍是旧版本时，POST 都返回 `503`，不能把健康子集误当成已完成 drain；gate=`1` 后 selected target 若能力回退，session/usage 等 user-scoped runtime 也会在转发前返回可重试 `503`。回滚先关闭 router writer gate；一旦已经接受过 gate，仍必须保持 lifecycle-aware fleet；一旦写入任一0013 control event或terminal incident，还必须保持0013-aware reader/worker并forward-fix；一旦0014 cutover激活，则所有 session writer都必须保持0014-aware。私有barrier不能阻止旧worker直连数据库，不能用gate-off或sticky observation作为旧版本回滚许可。status GET 不依赖 router writer gate，继续要求当前 healthy fleet 和 selected target capability，healthy mixed fleet 时 fail-closed；它不承担 POST 的全 configured-fleet 激活判定。该流程也不能替代 tenant key revocation 或 purge。

没有云资源时，仍可完成业务代码、协议、迁移、memory/MySQL/Redis 实现、单机 filesystem Blob 行为、本地多进程与容器测试、故障注入、指标定义和部署契约设计；当前 user erasure gate 和 usage 分层也属于这一范围。以下结论必须等待真实环境：共享 OSS/S3 adapter 与 IAM/KMS 的真实集成、云网络和权限正确性、IdP 集成、Kubernetes 滚动发布、真实告警链路、备份恢复目标、云 Redis 灾备以及生产容量。仓库不会为这些未知参数编造可直接部署的 Kubernetes、域名/TLS 或 Secret 配置。

## 10. 文档维护规则

当服务、命令、端口、CI job、构建产物或里程碑能力发生变化时，同一提交更新本文。不要复制 `docs/review/` 或 `docs/research/` 的历史测试数量；准确完成度继续以 `docs/PROGRESS.md` 最新一节和当前 CI 为准。
