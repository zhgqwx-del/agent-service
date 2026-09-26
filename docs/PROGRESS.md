# 进度记录

## 2026-09-22

- M0 调研完成：`docs/research/01–07`，方案 `docs/design/00-architecture.md`（含 §14 缺口清单）。
- 决策按 §13 默认值执行；实验环境仅本机（Redis 源码编译到 `~/.local/bin`，MySQL 8.0.26 用户目录 datadir，脚本 `deploy/local/infra.sh`）。
- pi 嵌入 spike 七项全部通过（`spikes/pi-embed/README.md`）。
- M1 完成：protocol / store / core / providers / agent-runner 五个包，44 个测试全绿（35 单元 + 8 MySQL/Redis 一致性 + 1 真实 Qwen 端到端）。
- 已用 HTTP 实测：Qwen 工具调用流式回复、`?after=` 重放、Idempotency-Key 重放、第二轮带历史、两个 runner 的租约冲突（409 + ownerAddr）与 hold 到期后接管（fence 3→4，历史完整）。

### 下一步（M2）
1. `apps/agent-router`：鉴权、幂等预留、`owner:{sid}` 目录查询、SSE 反向代理、409 重路由一次。
2. 3 runner + 1 router 的 kill 测试脚本（turn 中 kill 租约持有者 → 接管、无空洞、`?after=` 补齐）。
3. 优雅下线：SIGTERM drain 已实现，需要 step 边界 checkpoint 的验证。
4. OpenAPI 文档生成（`packages/protocol` → `/openapi.json`）与 SDK 包。

### 已知待办（M1 收尾）
- `web_fetch` 不跟随重定向（安全默认），需要文档说明。
- 队列策略 `busyPolicy=queue` 目前按 reject 处理（返回 session_busy）。
- 上下文压缩只有便宜级（工具输出裁剪），摘要级压缩与 `POST /compact` 未实现。
- 用量查询接口 `GET /v1/usage` 未实现（数据已入 `usage_ledger`）。

## 2026-09-26

四个角度的系统评审（并发正确性 / API 完备性 / 安全 / 测试策略）+ 自查，共 4 blocker、23 high、约 30 medium/low。详见 `docs/review/05-response-and-plan.md`。

**本轮已修 29 项**，其中数据损坏级 4 个：同 runner 并发 startTurn 创建双 turn（租约拦不住，同 owner 同 fence）、FenceError 不中止 turn（旧 owner 继续执行工具与计费）、drain 被待审批拖住整个 approvalTtl（滚动发布批量产生孤儿 turn）、动态工具结果跨会话串号（跨租户注入）。另有流式错误返回 200、用户级隔离缺失、审批可被客户端 metadata 绕过、BYOK SSRF、item seq 不一致导致最终回答被 `afterSeq` 过滤掉等。

**状态**：87 测试全绿（含两个存储后端的一致性套件与真实 Qwen 端到端）；覆盖率 69.0% → 82.6% 语句 / 69.3% 分支 / 87.0% 行；`scripts/demo.sh` 在 MySQL+Redis+真实模型下十环节通过，并新增 5 条负向安全用例。

**新增**：`scripts/demo.sh`（一条命令手动验收）、`packages/core/test/tools.test.ts`（SSRF 20 个绕过用例 + 动态工具桥）、迁移 `0002_auto_approved.sql`、`SessionGoneError`。

**下一步**：按 `05-response-and-plan.md` 第五节 —— ①测试地基 ②假厂商+方言测试 ③agent-router ④多进程集群 E2E ⑤CI ⑥压缩 ⑦M1 收尾。

**待拍板**：`X-User-Id` 信任模型（是否加端用户 JWT 分支）、是否提供第二家厂商 key 做方言实测、审批流产品形态、压缩策略。

## 2026-09-26（下午，M2 主体）

按 `docs/review/05-response-and-plan.md` 第五节推进，**115 个测试全绿**（111 单元/集成 + 4 多进程集群）。

1. **`packages/testkit` 假厂商**：真 HTTP 服务器，复刻国内厂商方言（`reasoning_content`、三种缓存字段拼法、`tool_calls.arguments` 分片、`: keep-alive` 注释行、`finish_reason: length`、429/Retry-After、流中途断链）。
2. **12 条方言测试**（`packages/providers/test/dialect.test.ts`）：驱动真实 `PiEngine` + provider 层，CI 无需任何 key。`PiEngine` 从 0% 覆盖变为有测试。验证了分片参数重组、reasoning 与正文分离、三家缓存字段、成本计算、qwen thinking 开关只对 qwen 下发、`max_tokens` 字段名、429 与断链的优雅失败、BYOK key 不进 payload。
3. **八条生产坑的回归测试**（`packages/core/test/history.test.ts`，12 条）：前缀字节稳定（`stableStringify`/工具指纹/epoch 只在模型可见内容变化时变）、崩溃三态、压缩切点配对、投影不变量。期间发现并修复：连续纯文本 step 会产出相邻 assistant 消息（部分厂商拒绝该序列），投影层改为合并。
4. **`apps/agent-router`**：`RunnerRegistry`（Redis 所有权目录 + 一致性哈希 64 虚节点 + `/readyz` 健康轮询）、SSE 原样透传、`409 + X-Owner` 重路由一次、`/_router/targets` 运维视图。
5. **多进程集群测试**（`test/cluster/`，M2 验收标准）：2~3 个真实 runner 进程 + 1 router 共享 MySQL/Redis。4 条覆盖路由一致性与 409 重路由、**SIGKILL 租约持有者后的接管**（fence 推进、孤儿 turn 被标记 interrupted、事件 seq 无空洞、`?after=` 补齐）、陈旧 owner 被 fence 后无法写入、SIGTERM drain 让进行中的 turn 正常完成。期间发现 harness 自身的 bug：`kill` 杀的是 tsx 包装进程，真服务还活着 8 秒后把 turn 正常跑完 —— 会让接管测试变成空测，已改为 `node --import tsx` + 进程组信号。
6. **生产构建路径**（此前的上云阻塞项）：esbuild 打成 420 KB 单文件，只内联 `@agent-service/*`，第三方留外部；迁移脚本随产物拷贝且路径三处兜底。实测原生 `node` 启动 + 对空库自动迁移 + API 可用 + SIGTERM drain。新增 `Dockerfile`（两阶段）与 `deploy/local/compose.yaml`。
7. **CI**（`.github/workflows/ci.yml`）：mysql + redis service、typecheck、单元/集成（含覆盖率）、多进程集群、以及独立的 build job 跑「构建产物能启动」。

**下一步**：摘要级压缩 + 截断方向修正；M1 收尾（`/v1/usage`、`/openapi.json` + SDK、声明未实现的事件与错误码清理、数据生命周期、结构化日志）。

## 2026-09-26（身份鉴权定稿）

回答"`X-User-Id` 信任模型该怎么做"，实现并测试了两种模式，文档见 `docs/design/01-identity-and-auth.md`。

**核心判断**：用户提出的"runner 拿到登录态、router 转发身份信息给 runner 去鉴权"方向正确，但落地时必须区分**验证**与**接收**。router 转发的字段走内网，与 `X-User-Id` 同样可伪造（谁能直连 runner 谁就能伪造），所以 runner 必须是权威 —— 要么自己验证端用户 token，要么明确接受"调用方可信"的前提。router 保持不参与鉴权，与它无状态的定位一致。若将来需要集中验证，正确形态是 router 签发 runner 可验签的短时效内部断言，而非明文转发。

**实现**：每租户策略（`tenants.auth_policy` + 加密的 `auth_secret`，迁移 `0003`）。
- `trusted_caller`（默认）：service key + `X-User-Id`；允许代任意本租户用户操作；硬性前提是 key 只存在于租户自己的后端。
- `end_user_token`：runner 验证端用户 token 并从中取 `userId`；`X-User-Id` 若同时出现必须一致（否则 403），单独使用直接 401（拒绝静默降级）；不允许代他人建会话。三种验证器：JWT+JWKS（推荐，本服务零密钥）、JWT+HS256（密钥走 BYOK 同一套信封加密）、introspection（正向缓存 60s，上游不可达时 fail closed）。算法在配置里固定以杜绝 alg 混淆。
- `GET/PUT /v1/tenant/auth` 管理策略，写入后本 runner 立即生效、其他 runner 在缓存 TTL（10s）内收敛。

**顺带修掉**：策略缓存原本 30s 且无法失效，意味着收紧策略会有 30s 窗口 —— 改为可显式失效的 `TenantPolicyCache`。

**另一个发现**：`tsconfig` 只检查 `src`，测试文件从未被类型检查，`apps/agent-runner/test/http.test.ts` 已与 `createApp` 的签名脱节（缺三个必填依赖）却仍"通过"。新增 `tsconfig.typecheck.json` 覆盖 src + test + scripts，`pnpm typecheck` 现在两者都跑。

**状态**：127 测试全绿（123 单元/集成 + 4 集群），构建产物 459 KB。

## 2026-09-26（晚，阻断项收口与本地交付）

### 里程碑判定

- **M0 已完成**。
- **M1 核心运行范围已完成**：单节点 runner、存储、SSE、幂等、审批、压缩、usage、鉴权和 BYOK 均可用；若按最初架构文档的完整定义，OpenAPI/生成 SDK 与完整数据生命周期仍未完成，因此不把 M1 宣称为 100%。
- **M2 核心范围已完成并在本地/CI 验证**：router、owner 目录、租约续期与 fencing、接管、drain、构建产物和容器 CI 均已有自动门禁。预发/生产部署尚未开始，需等待实际基础设施参数。

### 本轮修复

1. 身份和数据隔离：逻辑 ID 改为大小写敏感；幂等作用域收紧到 tenant + user + session；查询 replay 前先校验会话归属；迁移增加数据库级 advisory lock 和可重入 DDL。
2. 并发正确性：租约从 acquire 后立即续期，覆盖 provider/history/summary preflight；turn 与显式 compact 按 session 串行；租约丢失会中止执行；SSE 检测持久事件 seq 缺口并从 store 补齐。
3. Router：只重试真正实现幂等的 turn POST；`MAX_ATTEMPTS` 明确为总发送次数；header timeout 会取消底层 fetch；router/runner 请求体上限统一为 1 MB。
4. 构建交付：修复损坏的 lockfile；Docker runtime 不再联网解析依赖；CI 构建并启动 runner/router 镜像；生产 runner identity/address 规则收紧。
5. 运维测试：新增 `scripts/local-service.sh` 的 start/stop/restart/status/logs/smoke/acceptance/verify/verify-real；危险集群测试只允许测试库名和非零 Redis DB；真实模型测试改为显式开关；CI/本地 verify 增加凭据扫描且不打印命中值。

### 实测结果

- `scripts/local-service.sh verify`：类型检查通过；MySQL/Redis 集成套件 **189 passed / 1 skipped**；覆盖率 **78.55% statements / 67.32% branches / 75.44% functions / 83.28% lines**，全部高于门槛；集群套件 **8/8 passed**。
- `pnpm run build:check`：runner/router bundle 均在原生 Node 下启动，readiness 和 router forwarding 通过。
- 显式真实模型 E2E：**1/1 passed**。
- `scripts/local-service.sh acceptance`：MySQL + Redis + router + runner + 真实模型的十阶段验收全部通过，包括 SSE、重放、幂等、上下文、安全阀、隔离、请求体限制与 BYOK。

### 仍未达到“可直接生产上线”的部分

- 幂等 reservation 与 turn 创建仍有崩溃窗口；usage ledger 仍是非事务、失败即丢；压缩的两次 commit 尚未合并为原子提交。
- Redis fence counter 的灾难恢复、依赖探测型 readiness、结构化日志/指标/告警、限流/配额仍需完成。
- BYOK/工具 URL 的 DNS rebinding 与重定向链需要更强的运行时 SSRF 防护。
- OpenAPI/SDK、数据保留与删除任务、M3（MCP/skills/plugins/hooks）和 M4 的其余生产化工作仍待后续里程碑。
- Kubernetes/云部署资产将在 staging/production 的 namespace、镜像仓库、域名/TLS、Secret/KMS、MySQL/Redis 拓扑和资源配额明确后生成。
