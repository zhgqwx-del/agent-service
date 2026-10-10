# 本地开发、手动体验与 CI 构建指南

本文是理解和操作当前 `agent-service` 的长期维护入口，回答三类问题：本地需要启动什么、怎样手动体验、GitHub Actions 实际构建和验证什么。

里程碑完成度以 `docs/PROGRESS.md` 顶部快照和最后一节为准；本文只描述操作方式和交付产物，不替代进度记录。

先明确“本地完成”和“整个架构实现”的区别：本地能够完整启动、通过测试并不等于 M1～M4 已全部完成，更不等于生产环境已经验收。当前 M0 已完成，M2 的本地/CI 代码范围已冻结；M1 的核心运行范围、OpenAPI 和生成 SDK 已完成，数据生命周期已推进至T3g session-scoped Redis状态清理，但全域completion仍在继续闭环；M3 的 MCP/skills/hooks 主体以及 M4 的生产化主体尚未完成。仓库已经有 Docker、CI、本地运维、滚动升级门禁等 M4 地基，但这些地基不能替代真实 staging/production 验证。

没有云资源时仍可以继续实现并验证：业务与协议代码、Memory/MySQL/Redis 语义、迁移、故障注入、进程和 OCI 镜像、local/CI 自动化、部署契约，以及能够用本地替身证明的安全边界。以下工作不能被本地测试冒充为“已完成”：云数据库和云 Redis 的权限/故障行为、共享对象存储与 IAM/KMS、域名/TLS、Secret 注入、Kubernetes 或 VM 网络拓扑、真实滚动升级、告警链路、备份恢复与容量压测。它们需要后续真实资源，届时应把环境参数补进部署层，而不是现在编造参数。

手动体验应该分两次进行，而不是二选一：

1. 现在按本文做阶段体验，确认已经实现的 router/runner、公开 API、SSE、持久化和运维手感，尽早发现交互问题；
2. local/CI 范围的整体架构完成后，再做一次完整 walkthrough、真实模型验收和发布演练，作为进入 staging 前的系统验收。

## 1. 服务、基础设施与代码库

本项目当前只有两个应用服务：

| 组件 | 默认地址 | 是否独立进程 | 职责 |
| --- | --- | --- | --- |
| `agent-router` | `http://127.0.0.1:8080` | 是 | 对外入口、runner 发现、session owner 路由、SSE 透传和一次安全重路由 |
| `agent-runner` | `http://127.0.0.1:8787` | 是 | 鉴权、Agent Runtime API、模型执行、session/turn/item/event/approval 与 Blob 生命周期 |
| MySQL | `127.0.0.1:3306` | 是，外部基础设施 | 业务真相、持久事件、配置、operational/billing usage、subject/tenant lifecycle、T3d plan、T3e execution/ACK、T3f database-purge/grave及T3g Redis-purge evidence、Blob manifest/outbox |
| Redis | `127.0.0.1:6379` | 是，外部基础设施 | lease hash内owner目录、fence、hot replay stream、瞬时event Pub/Sub及T3g永久purge marker |
| `packages/sdk` | — | 否 | 供客户端使用的 TypeScript SDK |
| `protocol/core/store/providers/testkit` | — | 否 | 被 runner/router 或测试加载的内部代码库 |

正式客户端和公开OpenAPI authority都是 router 的 `8080`。runner 的 `8787` 用于开发诊断和对照，不应当成为生产环境的公网入口；runner上的`/openapi.json`只是同一已提交契约的构建/兼容性镜像，不能据此绕过router调用edge-owned platform API。

当前本地拓扑覆盖已实现的 M1/M2 主链路，包括 Archive/tombstone/outbox、Blob ownership/业务接线、usage 财务分层、user erasure、canonical policy/multi legal hold、非破坏性purge-policy evaluator，以及异步user-export artifact/download/TTL。terminal-event dispatcher、Blob cleanup、erasure/legacy compensation/policy evaluator、export build/cleanup、T3a credential-store revocation、T3b runtime revocation、T3c content inventory、T3d full-domain purge plan、T3e local execution/physical-ACK、T3f database-purge 和 T3g Redis-purge 都属于 runner 内部工作循环，不是第三个应用服务或镜像。T3d以`0022`固定33域并保留显式blocker；`0023` T3e处理本地usage/Blob/export子集，`0024` T3f原子清理11个本地数据库投影，`0025` T3g再精确清理session lease/owner、fence与stream并安装永久防复活marker。T3g的same-MySQL startup/periodic durable-ACK replay与worker轮询existing-marker收口都不是独立故障域restore ledger；这些切片也不代表external provider/KMS、backup/restore、logs/traces、共享对象存储和全域completion已经闭环。公开 completion 必须继续以实际代码和 `docs/PROGRESS.md` 为准；设计中的目标模块不会提前伪装成可启动服务。

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

`scripts/local-service.sh` 会读取 `.env`，但不会主动打印其中的值。当前端口/地址、`REDIS_PREFIX`、`REDIS_NAMESPACE_ID`、tombstone/Blob gate、`DATA_ERASURE_REQUESTS_ENABLED`、`TENANT_ERASURE_REQUESTS_ENABLED`、`TENANT_ERASURE_OPERATOR_TOKEN`、`TENANT_ERASURE_OPERATOR_ID`、`TENANT_ERASURE_BARRIER_TIMEOUT_MS`、`TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED`、`TENANT_CREDENTIAL_REVOCATION_EXECUTION_ENABLED`、`TENANT_RUNTIME_DRAIN_ENABLED`、`TENANT_RUNTIME_REVOCATION_WORKER_ENABLED`、`TENANT_RUNTIME_DRAIN_EXECUTION_ENABLED`、`TENANT_CONTENT_INVENTORY_WORKER_ENABLED`、`TENANT_PURGE_PLAN_WORKER_ENABLED`、`TENANT_PURGE_EXECUTION_WORKER_ENABLED`、`TENANT_PURGE_EXECUTION_ENABLED`、`TENANT_DATABASE_PURGE_WORKER_ENABLED`、`TENANT_DATABASE_PURGE_ENABLED`、`TENANT_REDIS_PURGE_WORKER_ENABLED`、`TENANT_REDIS_PURGE_ENABLED`、`DATA_GOVERNANCE_MANAGEMENT_ENABLED`、`PURGE_POLICY_EVALUATOR_ENABLED`、`DATA_EXPORT_REQUESTS_ENABLED`、`DATA_EXPORT_WORKER_ENABLED`、`DATA_EXPORT_CLEANUP_ENABLED`、`ERASURE_WORKER_ENABLED`、`LEGACY_TOMBSTONE_COMPENSATION_ENABLED` 和 `ERASURE_ROUTER_URL` 等显式命令行值优先；其它同名值可能被 `.env` 覆盖，使用前应检查配置来源，但不要打印密钥。platform operator token与router execution gate不会进入runner；统一脚本会在进程边界清除对方不应拥有的变量，同时让router/runner共享准确的Redis prefix/namespace身份。

## 3. 启动与停止完整本地栈

最短的本地体验路径如下；除 `acceptance` 外都不调用真实模型：

```bash
cd /Users/zhangguoqiang/ai-workspace/claude-workspace/meetyou/agent-service

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

# 体验结束。stop 保留 MySQL/Redis；down 连基础设施一起停止
scripts/local-service.sh stop
# scripts/local-service.sh down
```

若只想看当前实现，先执行到 `smoke`，再按第 4、5 节选择一个功能手工体验即可；不必为了学习普通 runtime API 而开启默认关闭的删除、tenant erasure 或管理 gate。`acceptance` 和 `verify-real` 会读取本机 `.env` 并调用真实 provider，运行前应确认模型与费用；不要把 `.env`、请求头、service key、provider key 或内部 token 复制进终端录屏、CI 日志和问题报告。

`start` 的顺序是：

1. 通过 `deploy/local/infra.sh` 启动 MySQL 和 Redis；
2. 从 TypeScript 源码启动一个 runner；
3. 从 TypeScript 源码启动一个 router，并等待其发现健康 runner。

runner 启动后会同时启动 lifecycle outbox dispatcher、Blob cleanup、durable erasure、generation-zero compensation，以及user-export build/cleanup worker；policy evaluator、T3a credential-store worker、T3b runtime-revocation worker、T3c content-inventory worker、T3d purge-plan worker、T3e local execution worker、T3f database-purge worker和T3g Redis-purge worker只有显式开启后才启动。停止时先停有claim/lease的worker并drain SessionHost，再等待其它循环。产品配置中这些worker均默认`0`；本地脚本为已有user job的forward-fix显式开启erasure、compensation和export build/cleanup，但evaluator及T3a～T3g gate仍保持`0`。因此普通`start`不会意外gate新user/tenant、清除credential、fence runtime、生成plan、匿名化tenant usage、撤销export、调度ready Blob删除、删除数据库投影或写Redis purge marker。T3e启用还强制要求Blob/export cleanup与单runner filesystem断言；该root不能当成跨VM/Pod共享数据面。若已有任一durable T3g job或cutover，runner会要求T3g worker保持开启；监听前只重放已有durable target ACK的marker，未ACK marker随后由worker轮询收口。这类不可逆演示环境不能再用普通worker=`0`配置回退启动。

要专门体验当前 user erasure gate，请只对可丢弃 user 显式开启两端 gate 后重启：

```bash
ERASURE_WORKER_ENABLED=1 LEGACY_TOMBSTONE_COMPENSATION_ENABLED=1 \
  DATA_ERASURE_REQUESTS_ENABLED=1 scripts/local-service.sh restart
curl -sS http://127.0.0.1:8080/v1/capabilities | python3 -m json.tool
```

预期 router capability 中 `dataErasureRequests` 为 `true`，并在管理 gate 仍关闭时同时显示 `dataGovernance=["canonical-retention-v1","multi-legal-hold-v1"]`、`dataGovernanceManagement=false`；这证明user-erasure admission writer理解durable authority，但不开放管理端点。直接查看 runner capability 时 `erasureJobControl` 还会同时包含 `quarantine-v1` 与 `legacy-tombstone-compensation-v1`。该开关只接受user-scoped durable request，不会启用物理 purge，也与tenant T1无关。rollout 状态故意不出现在 router 公开 capability；它只通过带 `INTERNAL_ROUTER_TOKEN` 的 v2 私有固定 ACK 供 worker 检查。旧 v1 路径故意不兼容并返回 404，避免旧 worker 在 compensation rollout 期间继续 claim。部署时可以只关闭 router writer gate 并保持 capable runner 的 gate 开启，此时已有 request 的 status GET 继续可读；mixed fleet 会返回 `503`。POST/status 的成功与错误响应均带 `Cache-Control: no-store`，不得在调试代理中改写为可缓存。本地统一脚本用同一个变量配置两端，因此体验结束后运行 `DATA_ERASURE_REQUESTS_ENABLED=0 scripts/local-service.sh restart` 会同时关闭 runner admission capability：新的 POST 和 status GET 都会返回 `503`，但已经落库的 subject gate 不会被撤销，两个后台 worker仍可继续 forward-fix。

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
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:outbox-mysql
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:usage-lifecycle-mysql
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:subject-lifecycle-mysql
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:tenant-credential-revocation-mysql
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:tenant-credential-physical-revocation-mysql
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:tenant-runtime-revocation-mysql
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" pnpm test:tenant-content-inventory-mysql
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

两端提供同一份 canonical OpenAPI 3.1 edge 契约，但 tenant erasure 的两个 platform 路径故意只在 router 公共入口注册；runner 只提供不进入 OpenAPI、受内部 token 保护的版本化私有路由，不得让 platform 客户端直连 8787。当前没有内置 Swagger/Scalar 页面，可把 `http://127.0.0.1:8080/openapi.json` 导入 Postman、Insomnia 或 Swagger Editor。

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

当前export制品复用runner独占filesystem BlobStore，只适合本地单runner。production会在request/build/cleanup任一export flag开启时拒绝启动；共享OSS/S3 adapter完成前不要在多VM/Pod、NFS或各Pod本地卷上开放该能力。

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

### Tenant erasure T2/T3a/T3b/T3c/T3d/T3e/T3f/T3g（只对可丢弃 tenant 体验）

T2 已提供 router-only `POST /v1/tenant-erasure-requests` 和 `GET /v1/tenant-erasure-requests/{requestId}`，使用与 tenant API key/admin key 完全独立的 platform bearer。POST 会原子写入admission、tenant lifecycle gate、首条audit、credential fence和T3a job；T3a清除本地DB credential material，T3b fence configured fleet，T3c建立DB-time owner清单，T3d把33域封存为不可执行plan。T3e同样没有公开API：runner内嵌worker在fresh all-configured barrier后，只原子去身份化operational usage、撤销export/释放snapshot pin、为Blob/export bytes写exact outbox，并在原cleanup worker真正完成这些outbox后seal physical ACK。T3f再从terminal T3e receipt建独立queue，在一个事务内清理固定11个本地数据库投影、保留匿名billing facts并写永久session grave。T3g最后从T3f grave及T3d Redis plan建立精确target，用真实Redis Lua删除lease/owner、fence与stream并写永久防复活marker。T3e/T3f/T3g都始终固定`allDomainsComplete=false`、`contentPurgeExecuted=false`；external/KMS、backup与独立restore ledger、logs/traces、共享对象存储生产适配及全域completion仍未处理。所有这些gate和已提交操作都不可当作可逆功能；`status=gated`不是`completed`。

**只能在可丢弃的本地数据库和tenant上执行以下步骤。** 最简单的做法是先停服务，在 `.env` 中把 `BOOTSTRAP_TENANT_ID` 改成专用演示 ID（例如 `t_tenant_erasure_demo`），确认现有本地数据可删除后再运行 `deploy/local/infra.sh reset-db`。该命令会重建本地业务/测试库并对本地 Redis 执行 `FLUSHALL`，不得对需保留的数据使用。若只体验T2逻辑fence，保持T3a～T3g execution/worker/endpoint开关为`0`；若要体验T3a～T3d，必须先确认tenant可丢弃，且 `.env` 中的`RUNNER_ID=runner-local-1`为显式稳定值、`RUNNERS`直连该单runner。先保持T3e/T3f/T3g六道gate为`0`完成并检查T3d plan；T3e会真实匿名化/撤销/调度删除，T3f会真实删除本地数据库投影，T3g会真实修改Redis并留下永久marker，只能按后文分阶段开启。多runner不能照抄这些本地命令。

```bash
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

预期 router capability 中 `tenantErasureRequests=true`、`tenantErasureControl=["platform-control-v1"]`、`tenantCredentialRevocation=["credential-store-v1"]`且`tenantCredentialRevocationWorker=true`。最后一个布尔值只表示T3a execution barrier当前可用，不代表content purge或completion。T3b的rollout/boot identity故意不从router公开capability泄露；直接看runner时应见`tenantRuntimeDrain=["runtime-drain-v1"]`和`tenantRuntimeDrainEndpoint=true`，但不会看到私有`bootId`。下面用临时权限为 `0600` 的 curl config 传递 platform token，避免密钥进入命令历史或打印到终端；在 zsh 中执行，并从本机 `.env` 查看后手工粘贴密钥：

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
    FROM tenant_runtime_revocation_receipts ORDER BY store_db_timestamp_ms DESC LIMIT 5;'
```

aggregate receipt应显示`memory_disposition=references_dropped_not_zeroized`、`external_disposition=not_supported`、`content_purge_required=1`。它与T3a的`runtimeDisposition=not_in_scope`不冲突：前者是`0020`独立切片的configured-fleet proof，后者仍是不可改写的`0019` credential-only receipt。target内的runner completion wall clock只是诊断字段；durable terminal时间由MySQL事务记录。

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

sealed aggregate必须显示`global_orphan_check=passed`、`content_inventory_complete=1`、`content_purge_executed=0`。anchor不早于T3a/T3b两个DB proof时间的最大值；roots绑定identity、状态和关系拓扑。`contextCompaction`是唯一允许synthetic turn的item，approval canonical边是`approvalRequest.approvalId → Approval.id`，legacy `Approval.itemId`只作为历史hash字段兼容。page/seal在receipt INSERT后仍会重验DB time和live lease，跨lease等待会连同receipt/cursor/aggregate/job transition整体回滚。它是某个可信数据库时间点的结构完整性证据，不是删除许可；T3e/T3f/T3g会在各自本地受限动作边界重新验证它。即使三个后续切片都完成，完整全域executor仍要补齐external/KMS、backup与独立故障域restore ledger、logs/traces、共享对象存储生产适配及其它completion ACK。

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

sealed aggregate必须显示`plan_entry_count=33`、`plan_complete=1`、`execution_ready=0`、`content_purge_executed=0`。在全新本地tenant且T3a证明provider/auth历史目标均为零时，通常`blocker_count=9`；仅tenant auth envelope非零时KMS域也必须使用`blocked_legacy_external_source_unavailable`，合计10个；任一provider config非零时，由于T3a receipt无法证明它不含BYOK/KMS envelope，external-provider与KMS两域都必须阻断，合计11个，无论auth是否同时非零。blocker不妨碍目录seal，恰好说明该plan不能执行；不要手工改成`not_applicable`或把33域缩成当前有adapter的子集。

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

cutover receipt必须是`local_destructive_progress=1`、`physical_acks_complete=0`、`all_domains_complete=0`、`content_purge_executed=0`；terminal local receipt必须是`local_physical_acks_complete=1`，但后两个全域标志仍为`0`。存在scheduled outbox时，physical ACK数量必须与实际completed identity匹配；dead-letter会把job置为`blocked/physical_ack_dead_lettered`，绝不能手工补ACK。在这一T3e阶段，session/idempotency与Redis仍未处理，随后必须分别由T3f/T3g完成；即使三个切片全部sealed，external/KMS、backup与独立故障域restore ledger、logs/traces、共享对象存储生产适配及全域completion仍未完成，公开`dataPurgeExecution`保持false。

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

terminal receipt必须显示`local_database_purge_complete=1`、`session_content_deleted=1`，但`all_domains_complete=0`、`content_purge_executed=0`。grave的owner hash只是同事务从live session捕获并由append-only/最小权限保护的opaque claim；T3c receipt不含user id，因此它不是可脱离owner tuple独立重算的上游证明。全局session ID fence和owner-scoped getter仍必须生效。T3f不处理Redis、external/KMS、backup/restore、logs/traces、生产共享对象存储或全域restore/completion，所以公开status仍为`gated`。

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

在 platform token 仍配置且有 healthy code-aware runner 时，上述 status GET 仍应可读。对同一tenant使用原`Idempotency-Key`和body的已提交POST应从独立read-only replay route返回同一request与`202`；改用未提交/不同key的新admission POST应返回可重试`503`且数据库不得新增request。若durable key与request hash证据冲突则返回`409`，绝不猜测或创建。router一旦为某次请求选定replay模式，即使gate在请求途中重新打开也不能升格为create。可在仍保留上述shell变量的同一终端验证：

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

T3a～T3g worker可能在POST后迅速推进内部job，但公开GET仍只返回`gated`。T3b proof只覆盖configured fleet本地references与tracked I/O；T3c只证明DB-clock owner结构；T3d只证明33域及blocker完整；T3e只证明local usage/Blob/export动作与actual outbox ACK；T3f只证明11个本地数据库投影删除、匿名billing保留与session grave；T3g只证明session-scoped Redis三域及same-MySQL marker replay。它们合起来仍不证明远程provider/KMS、backup/独立restore、logs/traces、共享对象存储生产语义或全域content已经完成。体验完成后同时重建可丢弃MySQL与Redis，不要手工删表行或marker来“解除”fence、cutover或receipt。自动门禁为：

```bash
pnpm test:tenant-credential-revocation-mysql
pnpm test:tenant-credential-physical-revocation-mysql
pnpm test:tenant-runtime-revocation-mysql
pnpm test:tenant-content-inventory-mysql
pnpm test:tenant-purge-plan-mysql
pnpm test:tenant-purge-execution-mysql
pnpm test:tenant-database-purge-memory
pnpm test:tenant-database-purge-mysql
pnpm test:tenant-redis-purge-memory
pnpm test:tenant-redis-purge-mysql
pnpm test:tenant-redis-purge-redis
pnpm test:tenant-redis-purge-cluster
```

这些named no-skip命令依次覆盖T1/T2、T3a、T3b、T3c、T3d、T3e、T3f与T3g边界。T3e套件证明原子local cutover、exact outbox与actual physical ACK；T3f的Memory/MySQL套件证明11域投影删除与证据同原子边界、billing/grave/response-loss/回滚/隔离；T3g四套件分别证明纯契约/Memory publication、真实InnoDB ledger、真实standalone Redis Lua/marker防复活，以及mixed-worker/mixed-namespace/active-fleet多进程gate。它们都没有公开执行API或第三个服务，也尚未在真实Redis Cluster/ACL/failover上验收，不能把store/worker套件夸大为完整HTTP tenant purge或云恢复证明。准确用例数以`docs/PROGRESS.md`最后一节与当次CI为准。

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

即使观察到0016 authority也不能据此尝试手工删除：它自己的deadline仍来自runner wall clock，target也不是完整owner清单。`0021` T3c补充DB-clock owner proof，`0022` T3d固定33域；`0023` T3e只在自己的默认关闭gate下执行local usage/Blob/export子集，`0024` T3f再清理session/idempotency/lifecycle/Blob/export等11个数据库投影，`0025` T3g最后清理session-scoped Redis三域。三者都不直接把0016 authority当全局许可。external/KMS、backup与独立restore ledger、logs/traces、共享对象存储生产适配及其它completion ACK仍未闭环；completion、T3d execution readiness及T3e/T3f/T3g all-domains-complete都固定为false。体验结束后可关闭三个外部gate；已经提交的subject gate和immutable evidence不会回滚：

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
# 包含 Blob/usage/subject/tenant-credential逻辑、T3a物理清除、T3b runtime proof、T3c content inventory、T3d plan、T3e local execution/physical ACK、T3f database purge、T3g Memory/MySQL/真实Redis、policy/evaluator/erasure/legacy-compensation/user-export专项、
# 0007→...→0025 历史迁移、真实多进程 cluster（含T3g mixed-worker/namespace/active-fleet精确no-skip套件）、
# SDK 打包和两个应用 bundle 启动门禁

scripts/local-service.sh verify-real
# 读取本机 .env，只跑真实 provider E2E，会产生费用

scripts/local-service.sh acceptance
# 从 router 完成端到端人工体验，会产生费用
```

日常开发至少运行与修改范围匹配的定向测试；合并或里程碑冻结前运行完整 `verify`。真实模型路径只有在明确需要时运行，不能把未重跑的历史结果描述为本轮结果。

手动体验不必等到 M1/M3/M4 全部完成：每个安全切片先做短smoke，能更早发现交互和运维问题；待整体架构的local/CI范围完成后，再按第3～6节做一次完整walkthrough作为阶段验收。policy/hold、non-destructive evaluator、异步user export、tenant T1/T2/T3a、T3b runtime drain、T3c owner inventory、T3d plan、T3e local usage/Blob/export execution/ACK、T3f本地数据库投影清理与T3g session-scoped Redis三域已接线；tenant流程只能用可丢弃tenant，因为其中多条边界不可逆。当前尚未接线的是external provider/KMS、backup与独立故障域restore ledger、logs/traces、共享对象存储生产适配、全域completion proof、generic user物理purge、M3扩展和M4生产化，不能提前模拟成已存在。

## 7. 本地源码进程与生产构建产物

本地首选 `scripts/local-service.sh start`：它会加载 `.env`、补齐单 runner Blob 安全覆盖，并在进程边界移除router-only platform authority/T3a/T3b/T3e/T3f/T3g execution变量和runner-only T3a～T3g worker/endpoint变量；`REDIS_PREFIX`与`REDIS_NAMESPACE_ID`则必须保留并在两端一致。

如果必须在两个终端手工运行源码，两个终端都从仓库根目录开始。runner 终端先加载配置，再删除 platform authority：

```bash
set -a
source .env
set +a
unset TENANT_ERASURE_OPERATOR_TOKEN TENANT_ERASURE_OPERATOR_ID \
  TENANT_CREDENTIAL_REVOCATION_EXECUTION_ENABLED TENANT_RUNTIME_DRAIN_EXECUTION_ENABLED \
  TENANT_PURGE_EXECUTION_ENABLED TENANT_DATABASE_PURGE_ENABLED TENANT_REDIS_PURGE_ENABLED
node --import tsx apps/agent-runner/src/main.ts
```

router 终端保留 platform 配置：

```bash
set -a
source .env
set +a
unset TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED \
  TENANT_RUNTIME_DRAIN_ENABLED TENANT_RUNTIME_REVOCATION_WORKER_ENABLED \
  TENANT_CONTENT_INVENTORY_WORKER_ENABLED TENANT_PURGE_PLAN_WORKER_ENABLED \
  TENANT_PURGE_EXECUTION_WORKER_ENABLED TENANT_DATABASE_PURGE_WORKER_ENABLED \
  TENANT_REDIS_PURGE_WORKER_ENABLED
node --import tsx apps/agent-router/src/main.ts
```

不要再给上述 runner 命令添加 `--env-file=.env`，否则会把已移除的 token 再次注入。当 `.env` 配置了 platform token 时，目前的 `pnpm --filter @agent-service/runner start/dev` 会整体加载该文件，不再是安全等价入口；优先使用统一脚本。

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
3. 验证 readiness、capabilities、router 转发、两端 OpenAPI 精确一致，以及 router 保持 platform tenant-erasure 认证边界。

如果未来明确采用裸 VM，应增加带校验和的 `bundle + migrations + production node_modules` 发布归档和 systemd 单元。当前最完整、最可重复的部署产物是 OCI 镜像。

这里有三种容易混淆的运行/交付形态：

| 形态 | 实际内容 | 适用场景 |
| --- | --- | --- |
| 本地源码进程 | `tsx` 直接加载 `apps/*/src/main.ts` | 日常开发、调试、热重载 |
| Node 应用 bundle | `apps/agent-runner/dist/main.js`、`apps/agent-router/dist/main.js`，外加 production dependencies 与 migrations | 裸 Linux VM 上作为两个独立 Node 进程运行；仓库当前尚未生成完整发布归档/systemd 单元 |
| Linux OCI 镜像 | Node 24 slim + 某一个应用 bundle + production dependencies + migrations | staging/production 推荐交付物，可分别部署到不同 VM、容器平台或 Kubernetes workload |

因此“router/runner 不可变镜像”表示镜像内容在构建后不再修改、环境间使用同一 digest；它不是 Windows 镜像，也不是把 TypeScript 编译成 Linux ELF 或 Windows `.exe`。router 和 runner 确实是两套可独立启动、独立扩缩容、可部署到不同机器的 Node 应用，但镜像通常比手工分发裸 bundle 更容易保证 Node 版本、依赖、迁移与健康检查完全一致。若目标机器不能运行容器，可以部署完整 Node 发布归档；不能只复制一个 `main.js` 就称为完整发布。

无论使用裸进程还是镜像，部署的产品应用仍然只有 router 和 runner。MySQL、Redis、未来共享对象存储/KMS 是外部基础设施；SDK 和内部 workspace package 不是常驻服务；各类 dispatcher/worker 在 runner 进程内运行，不需要额外部署第三个应用。

## 8. GitHub Actions 构建与验证

`.github/workflows/ci.yml` 对 push 到 `main` 和 pull request 运行。

### `test` job

GitHub 的主测试 job 固定启动最低支持版本 `mysql:8.0.26` 与 Redis 8；镜像 job
另外保留浮动 `mysql:8.0`，因此同一次 CI 同时覆盖最低 SQL 兼容下限和当前 MySQL 8
镜像。随后执行：

TypeScript 检查与发布构建不是同一件事。`pnpm typecheck` 先由根 `tsconfig.json` 引用并检查 `testkit`、`protocol`、`sdk`、`store`、`core`、`providers`、`agent-runner`、`agent-router` 八个 workspace，再由 `tsconfig.typecheck.json` 对各 workspace 的源码/测试及根 `test/`、`scripts/` 做 no-emit 检查。真正生成发布产物的根 `pnpm build` 则只执行 `scripts/build-sdk.mjs` 和两次 `scripts/build-app.mjs`：SDK 用 TypeScript 生成包内容，runner/router 用 esbuild 把内部 `@agent-service/*` workspace 内联进各自 Node ESM bundle，第三方依赖保持 external。入口分别是根 `package.json` 的 `typecheck`、`build`、`build:check`，以及 `scripts/build-sdk.mjs`、`scripts/build-app.mjs`、`scripts/check-dist-boot.mjs`。

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
11. 以独立、可见且不得 skip 的 `pnpm test:tenant-credential-revocation-mysql` 依次运行tenant credential主体与race两个真实InnoDB文件，验证T1/T2原子admission/fence、不存在tenant时零残留回滚、最后job INSERT故障的完整事务回滚、idempotency、一致status snapshot/proof、tenant/user-worker互斥、普通写竞态、逻辑隐藏/拒写及跨tenant隔离；主JSON report也强制证明两个文件确实执行；
12. 以独立、可见且不得 skip 的 `pnpm test:tenant-credential-physical-revocation-mysql` 验证T3a数据库时间claim/lease、live lifecycle拒权、API-key/provider/auth material清除与receipt同事务、SQL故障全回滚、global cutover与首receipt/terminal job/immutable T1 proof、lifecycle推进后的terminal重放、Unicode raw identity及跨tenant隔离；主JSON report也要求该文件实际执行；
13. 以独立、可见且不得 skip 的 `pnpm test:tenant-runtime-revocation-mysql` 验证T3b materialize、DB-time claim/lease/ABA、完整target set、原子receipt/job、回滚、response-loss与隔离；
14. 以独立、可见且不得 skip 的 `pnpm test:tenant-content-inventory-mysql` 验证T3c DB-clock、owner range/phantom、canonical关系、hold/orphan、跨lease回滚与隔离；
15. 以独立、可见且不得 skip 的 `pnpm test:tenant-purge-plan-mysql` 验证T3d固定33域、9/10/11 blocker、source/hold、owner closure、full-range lock、claim/ABA、atomic seal、exact replay与隔离；
16. 以独立、可见且不得 skip 的 `pnpm test:tenant-purge-execution-mysql` 验证T3e source/hold/owner/lease复验、原子usage/export/Blob cutover、exact outbox、actual completion/dead-letter、physical seal、response-loss、回滚与隔离；主JSON report也强制证明目标文件实际执行；
17. 分别运行 `pnpm test:tenant-database-purge-memory` 与 `pnpm test:tenant-database-purge-mysql`，使后续数据库清理边界既证明 Memory 原子语义，也证明真实 InnoDB 锁、回滚、lease、replay 与 tenant isolation，且 wrapper 会拒绝缺失或全 skip 的目标文件；
18. 以 `pnpm test:tenant-redis-purge-memory` 强制执行T3g纯契约/Memory atomic publication、source/target/ACK root与restore projection；它不是假的“真实Redis”测试；
19. 以 `pnpm test:tenant-redis-purge-mysql` 强制执行T3g真实InnoDB materialize、claim/lease/response-loss、部分ACK接管、事务回滚与tenant隔离；
20. 以 `pnpm test:tenant-redis-purge-redis` 强制执行真实standalone Redis上的Lua完整预检、same-slot原子删除、永久marker、operation replay、错误type/冲突与writer防复活。它没有替代真实Redis Cluster/ACL/persistence/failover验收；
21. 以独立、可见且不得 skip 的 `pnpm test:retention-policy-mysql` 验证 canonical policy 与 multi legal hold 的 real-InnoDB CAS、immutable/audit 回滚、跨 runner 时钟单调化，以及 erasure admission/usage anonymize 竞态；
22. 以独立、可见且不得 skip 的 `pnpm test:erasure-purge-policy-mysql` 验证0016 evaluator的原子job建立、request-bound deadline、claim/ABA、live evidence与hold ABA重评、并发锁顺序及seal回滚；
23. 分别强制运行 `test:erasure-job-mysql`、`test:erasure-session-mysql`、`test:erasure-catalog-mysql`、`test:erasure-usage-mysql`，证明 claim/lease/audit、固定动作/回滚、无正文 completeness scan 及 claim-bound usage/ABA 事务确实执行；
24. 以独立、可见且不得 skip 的 `pnpm test:legacy-tombstone-mysql` 验证 generation-zero compensation 的一次性 cutover、claim/ABA、原子发布、失败回滚、owner/child 隔离与幂等重试；
25. 以独立、可见且不得 skip 的 `pnpm test:user-data-export-mysql` 验证owner隔离、RR一致性snapshot、真实core worker跨层发布、claim/download/delete lease、TTL/撤销清理与失败回滚；
26. 运行冻结的真实历史schema夹具，逐段验证 `0007 → ... → 0025`。其中包括`0007 → 0008`重复usage安全合并/冲突阻断/legacy pending receipt继续保留；`0024 → 0025`既用全链hash固定的独立frozen schema证明业务行/dormancy/partial-DDL/marker replay/append-only guard/严格fingerprint，也在不依赖live旧迁移或当前writer的静态hash固定pre-0025 T3f evidence上，逐字段证明七张T3f证据表保持且升级后只能经显式materializer创建T3g job/target；wrapper拒绝任一必需夹具缺失或skip；
27. broad cluster覆盖真实runner/router多进程接管及已经纳入的安全边界；另以精确JSON report运行`pnpm test:tenant-redis-purge-cluster`，明确证明mixed-worker、mixed-namespace与active exact fleet矩阵执行且零skip。它不能被描述成真实managed Redis Cluster或完整多runner全生命周期验收；
28. `pnpm build:check`；
29. 上传 coverage artifact。

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

每个镜像都包含 Node 24 slim、该应用 bundle、迁移和 production dependencies。它们是 Linux OCI image，不是 VM磁盘或原生机器码。CI会实际启动镜像并检查 OpenAPI/healthcheck；runner还查询 `schema_migrations`，明确验证最新 `0025_tenant_redis_purge.sql` marker 已由镜像内迁移器写入，并验证 production bootstrap。migration marker只证明对应schema/guards已安装，不表示job已生成、worker/gate已开启或发生Redis删除。生命周期 worker 仍在现有 runner 进程中，因此CI不会为 T3a～T3g 构建额外 Node bundle、二进制或镜像；产品构建始终只有router与runner两份应用bundle和两个Linux OCI镜像。

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

`0016` authority不能直接用于purge：eligibility由runner wall clock记录，per-session target也不是turn/item/event/approval的完整owner inventory。`0021` T3c已独立使用数据库时间与canonical hold重验并写入结构完整的`session_content_receipts`，但不会把0016与0021 evidence自动合并为执行许可。`0023` T3e另用双默认关闭gate，在自己的执行边界重验T3c/T3d、policy/hold、owner和lease并完成local usage/Blob/export子集；`0024` T3f再原子清理11个数据库投影；`0025` T3g最后清理session-scoped Redis三域。后续完整全域executor仍要核对external/KMS、backup与独立restore ledger、logs/traces、共享对象存储生产适配和其它completion ACK。当前completion固定为false；live evidence或hold generation/projection变化会让旧active projection失效并以新build generation重评，而不是覆盖旧证据。

`0017` export采用expand→code-aware→worker→admission边界：先迁移，再部署admission=`0`的新router并排空旧router，随后滚动admission=`0`但声明`artifact-ndjson-v1`的新runner。local单runner可以先开启cleanup、再开启build worker，最后开启runner/router admission；关闭admission只停止新POST，已有job、status、download和cleanup继续forward-fix。production在共享对象存储adapter完成前完全不注入filesystem export read surface，也不宣告export capability，request/build/cleanup任一flag为`1`都会拒绝启动。未来接入共享对象存储后，必须以同一image digest在staging验证跨runner可见性、条件发布、下载lease与TTL/撤销删除竞态，不能用NFS或各Pod本地目录模拟。

`0018` 仍是 tenant erasure 的 expand-only 存储边界：新增独立、append-only 的 `tenant_erasure_admissions` 和 `tenant_credential_revocation_fences`，不向 `erasure_requests` 写 tenant row，也不修改其历史 trigger。固定 `0017` 真实 MySQL 夹具证明旧 worker 的 claim 扫描只能看到原 user queue、旧 user scheduling 保持不变，且 partial-DDL 或 marker 丢失后重放不会失去 append-only 保护。T2 的安全 rollout 是：`0018` expand → 新 router 以 tenant gate=`0` 上线并排空旧 router → 全部新 runner 以 gate=`0` 上线 → 逐 runner 开启 local admission capability → 核对全部 configured 稳定 target → 最后开启 router gate。不得在 pre-`0018`/T2 mixed fleet 提交 tenant admission；runner 端口也必须保持内网受控。

`0019` T3a使用另一条独立rollout：expand migration → 新router以`TENANT_CREDENTIAL_REVOCATION_EXECUTION_ENABLED=0`上线并排空旧router → 全部新runner以`TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED=0`上线但声明`credential-store-v1` → 逐runner开启worker → 核对全部configured稳定target健康且worker-active → 最后开启router execution gate。worker在materialize/claim与紧邻不可逆事务前都需要fresh barrier；旧`0018` admission只由显式proof-checked materializer补job。首个receipt激活cutover后不能回退pre-`0019`，只能forward-fix。

`0020` T3b再使用一条完全独立的rollout：expand-only migration → 新router以`TENANT_RUNTIME_DRAIN_EXECUTION_ENABLED=0`上线并排空旧router → 全部新runner以`TENANT_RUNTIME_DRAIN_ENABLED=0`、`TENANT_RUNTIME_REVOCATION_WORKER_ENABLED=0`上线 → 为每个configured slot配置唯一且重启不变的`RUNNER_ID`，并确认`RUNNERS`每项是对应实例的直连稳定URL → 逐runner开启私有endpoint → 核对所有endpoint的runner/boot identity → 开启内嵌worker → 最后开router execution gate。router每次都在fanout前后直接探测所有精确target，不使用healthy subset、owner hash ring、sticky attestation或负载均衡Service别名；任一target/runner/boot缺失、重复或变化均无aggregate proof。

T3b的回滚顺序是先关router execution gate，再让worker在当前job边界停领，最后才可关endpoint。关闭gate只暂停新广播，不会重开已fenced tenant、恢复cache/reference、撤销immutable receipt或改写T3a的`runtimeDisposition=not_in_scope`。已有`0020` terminal proof时必须保留schema并forward-fix，不得回退到会忽略T3b fence的版本。

`0021` T3c再采用独立、无router execution端点的expand→worker-active顺序：先应用migration，再滚动`TENANT_CONTENT_INVENTORY_WORKER_ENABLED=0`但理解新evidence的新runner，确认严格schema fingerprint、append-only guards和新binary均已就绪后逐实例开启worker。同名但不兼容的partial/manual DDL会fail fast，必须先受审计修复，不能由migration猜测覆盖。它从terminal T3b proof显式materialize job，以不早于T3a/T3b proof high-water的数据库时间固定anchor/deadline；build/seal显式使用REPEATABLE READ，检查tenant全部session及turn/item/event/approval关系、event引用、连续seq、全局orphan和canonical tenant/user hold，并在receipt INSERT后重验live lease，再同事务提交aggregate receipt与terminal job。任何receipt都不含正文、user id、Blob locator或claim token，也不是删除许可。关闭worker只暂停新claim；已有`0021` evidence时必须保留schema并forward-fix。当前seal的五表全局共享锁扫描只是local/CI正确性基线，生产启用前需完成owner索引/FK/分区或等价优化、容量测试与写阻塞验证。

`0022` T3d继续采用独立、无router execution端点的expand→worker-active顺序：先应用execution-dormant migration，再滚动`TENANT_PURGE_PLAN_WORKER_ENABLED=0`但理解固定catalog的新runner；核对三张表的严格schema/index/CHECK/trigger fingerprint、append-only guards和新binary后才逐实例开启。生产worker对新空plan不做分页发布，而是直接seal：Memory在一个原子边界、MySQL在单个显式REPEATABLE READ事务内重验T1/T3a/T3b/T3c、immutable policy、DB-time deadline、canonical tenant/全部user hold、全局owner closure与post-write lease，并一次性写33条entry、aggregate receipt和terminal job。idempotency、usage ledger/reconciliation全范围锁保持到commit，阻止扫描后phantom；legacy pending `NULL`保留，legacy completed `{turnId}`必须反向归属同一session，显式`sessionId`若存在也必须匹配。operational usage允许synthetic/legacy turn无turn row，但reconciliation必须绑定已tombstone session的精确正generation；lifecycle↔request/admission双向闭合，purge target必须精确匹配tombstone generation/time。`buildPage`只保留诊断/兼容用途，不由生产worker调用。关闭worker只暂停新plan；已有`0022` evidence时必须保留schema并forward-fix。9/10/11 blocker、`executionReady=false`与`contentPurgeExecuted=false`是安全结果，不得由promotion脚本覆写。

`0023` T3e采用expand→code-aware→local-cleanup/worker→execution-gate顺序：先应用migration；发布`TENANT_PURGE_EXECUTION_ENABLED=0`的新router并排空旧router；滚动`TENANT_PURGE_EXECUTION_WORKER_ENABLED=0`但声明`local-execution-ack-v1`的新runner；当前只在local单runner确认filesystem root独占且Blob/export cleanup已开后启worker；核对全部configured target健康且worker-active，最后开router gate。每次materialize、claim、lease、cutover和physical seal均取fresh non-sticky ACK。首个cutover与usage anonymize、export revoke/snapshot release、exact outbox和domain ACK同事务提交并激活write-once边界；outbox实际completed后才seal physical ACK，dead-letter只能block。关闭gate不能恢复已发生动作或撤销证据，首个cutover后只能forward-fix。共享对象存储adapter完成前，staging/production保持双gate为`0`。

`0024` T3f采用expand→router-first parser replacement→runner worker→execution-gate顺序：先应用migration，再发布`TENANT_DATABASE_PURGE_ENABLED=0`且理解双capability的新router，并完全排空所有旧router；之后才滚动`TENANT_DATABASE_PURGE_WORKER_ENABLED=0`的新runner，逐实例开worker，最后开router gate。旧router的严格parser会拒绝`["local-execution-ack-v1","local-db-content-delete-v1"]`，所以runner-first不安全。materialize、claim、renew、destructive execute与模糊response replay都取fresh `no-store` ACK；首个cutover后只能forward-fix，关闭gate不能恢复已删投影、grave或不可变证据。

当前T3f MySQL事务持有全局cutover行锁直至删除与证据一并commit，跨tenant执行因此安全串行。预发必须用真实数据量验证锁等待、lease预算、超时与吞吐，再决定是否引入等价的分片协调。CI中的冻结旧parser证明了发布顺序约束，但没有替代真实N-1镜像canary、旧router排空与forward-fix演练。

`0025` T3g采用expand→marker-aware router→marker-aware runner→worker→execution-gate顺序。先应用migration，并为每个router/runner设置完全相同、准确的`REDIS_NAMESPACE_ID + REDIS_PREFIX`；新router以`TENANT_REDIS_PURGE_ENABLED=0`发布并完全排空旧router，再以`TENANT_REDIS_PURGE_WORKER_ENABLED=0`滚动新runner，并在任何T3g Redis mutation前完全排空marker-unaware旧runner。核对每个configured stable URL健康、声明`session-state-delete-v1`且namespace digest一致后，保持router gate关闭并逐runner开启worker；这允许durable restore及existing-marker-only收口，但不materialize新job或创建首次marker。全部worker-active后最后开router gate。fresh no-store ACK只用于materialize和每次新的Redis mutation，mutation前执行`gate → renew claim → gate`；lease至少是barrier timeout的两倍再加1秒，且续租至第二次proof的耗时不得超过lease一半。claim、existing-marker replay、ACK持久化/精确重放、durable restore与全ACK seal不取destructive gate。首个marker/ACK/cutover后只能forward-fix；关闭router gate只能暂停新materialize/mutation，不能关闭负责marker-only收口及startup/periodic durable replay的worker、修改namespace identity或回退旧binary。barrier不能阻止仍存活且可直写Redis的旧进程，因此完整drain是必要条件。

T3g的恢复能力需保持精确表述：same-MySQL projection只枚举已经写入durable target ACK的marker。正常marker-only窗口可由worker轮询中的existing-marker-only replay在gate关闭时收口；但marker尚无MySQL ACK且在worker成功replay并持久化ACK前又从Redis丢失时，首次existence bits仍无法恢复。MySQL与Redis一起恢复到旧snapshot也不受保护。restore keyset在大tenant下的扫描/重放性能、永久marker容量、普通live-session fence灾备及独立故障域ledger仍待设计/压测。自动测试使用真实standalone ioredis并验证same-slot grammar，但不是managed Redis Cluster、ACL、persistence或failover验收。

当前ordinary user erasure/compensation/evaluator继续停在不可执行策略边界；export可生成、下载和清理临时制品。tenant T1/T2提供逻辑fence，T3a删除本地DB credential material，T3b证明configured fleet drain，T3c证明DB-time owner结构，T3d封存33域plan，T3e完成local operational usage与Blob/export子集及physical ACK，T3f清理11个本地数据库投影并留下永久session grave，T3g再清理session-scoped Redis lease/owner、fence与stream并写永久marker。公开status仍为`gated`、`dataPurgeExecution=false`。external/KMS、backup与独立故障域restore ledger、logs/traces、共享对象存储生产适配、completion及generic user物理purge尚未闭环；所以staging/production的相关admission/execution/worker gate（包括T3e/T3f/T3g六道gate）默认都保持`0`。T3g router gate关闭只暂停新materialize/mutation，不撤销证据也不阻断existing-marker replay、补ACK/seal或durable restore；任一durable T3g job存在时worker须保持开启。

没有云资源时，仍可完成业务代码、协议、迁移、memory/MySQL/Redis 实现、单机 filesystem Blob 行为、本地多进程与容器测试、故障注入、指标定义和部署契约设计；T3a～T3g都属于这一范围。以下结论必须等待真实环境：共享 OSS/S3 adapter 与 IAM/KMS 的真实集成、云网络和权限正确性、IdP 集成、Kubernetes 滚动发布、真实告警链路、备份恢复目标、真实Redis Cluster/ACL/persistence/failover、云 Redis 灾备以及生产容量；这些属于M4环境集成而非本地替代品。仓库不会为这些未知参数编造可直接部署的 Kubernetes、域名/TLS 或 Secret 配置。

当前T3d全库RR/next-key扫描可能在规模下造成写阻塞/死锁、lease和容量压力，必须在staging用真实索引与数据量做锁超时/容量验证。结构损坏的queued job在逐候选隔离前可能饿死后续job，cursor重启还会重扫损坏前缀，但fail-closed且不会产生plan receipt或执行权，M4应增raw-key quarantine/skip。`0022` trigger fingerprint不校验action body，迁移夹具只显式模拟首个DDL auto-commit边界；预发需用无DDL/TRIGGER的runtime principal并扩展schema tamper/中断演练。

T3d owner closure还覆盖Memory export/user-erasure/tenant-admission request↔idempotency反向索引，以及Memory/MySQL legacy compensation deterministic `jobId`↔精确session owner/tombstone generation/time；MySQL还重算`candidateSha256`并校验`sourceLastSeq`，`erasure_claim`精确绑定request/generation，status精确对应单个audit/result，completed event seq等于`session.lastSeq`且success evidence完整。对全局orphan/cross-owner损坏，当前claim会终结为`blocked`且不产生执行权，但底层数据修复后不会自动resume/rebuild，后续需受审计的operator repair/resume协议。

## 10. 文档维护规则

当服务、命令、端口、CI job、构建产物或里程碑能力发生变化时，同一提交更新本文。不要复制 `docs/review/` 或 `docs/research/` 的历史测试数量；准确完成度继续以 `docs/PROGRESS.md` 最新一节和当前 CI 为准。
