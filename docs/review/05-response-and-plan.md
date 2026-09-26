# 评审结论汇总与后续计划（2026-09-26）

四个角度的评审（并发正确性 / API 完备性 / 安全 / 测试策略）+ 自查，共发现 4 个 blocker、23 个 high、约 30 个 medium/low。本文记录**已修**、**已决定延后**、**需要你拍板**三类，以及 M2 的任务拆分。

- 评审原始报告：`00-self-findings.md`（自查）、`01-concurrency-correctness.md`（383 行，含 8 个实测探针）、`02-api-completeness.md`（300 行差距矩阵）、`03-security.md`（194 行，含首版威胁模型）、`04-test-strategy.md`（1297 行，含 P0–P2 计划与 CI YAML）。
- 修复后状态：**87 个测试全绿**（含 MySQL/Redis 一致性与一条真实 Qwen 端到端），`pnpm typecheck` 干净，语句覆盖率 **69.0% → 82.6%**、分支 55.9% → 69.3%、行 74.2% → 87.0%。`scripts/demo.sh` 十个环节在 MySQL+Redis+真实模型下全部通过。

---

## 一、本轮已修（29 项）

### 数据损坏类（4 个 blocker）

| # | 缺陷 | 为什么危险 | 修复 | 回归测试 |
|---|---|---|---|---|
| 1 | **同 runner 并发 `startTurn` 创建两个 turn**。忙检查与 `active.set` 之间有 5 个 await；两次 `acquire` 是同一 owner，拿到**同一个 fence**，租约完全拦不住 | 事件交错、工具重复执行、turn 泄漏 —— 正是租约要防的损坏，发生在租约管不到的进程内 | 按 sessionId 串行化（`startQueue`），`finishTurn` 的 active 删除加身份校验 | `host.test.ts` 2 条（reject 只一个成功；steer 折叠进同一 turn） |
| 2 | **`FenceError` 不中止 turn**。`onCommitError` 只挂在 1 个调用点，另外 7 处裸奔 | 被抢占的旧 owner 继续调模型、继续执行工具，副作用与计费双份，日志里只有一行 | `commit()` 本身熔断：失败必过 `onCommitError`，置 `state.fenced` 后 chain 短路、`gateToolCall`/`onStepEnd` 直接拒绝、`finishTurn` 只做本地清理 | `host.test.ts`「租约被接管后不再推进」 |
| 3 | **`drain()` 被待审批拖住整个 approvalTtl**（默认 10 分钟）。实测 `drain(300ms)` 耗时 2803ms | K8s 30s grace → SIGKILL → `turn/completed` 永不落库，每次滚动发布按待审批数量批量产生孤儿 turn | 审批 Promise 监听 `state.abort`；`interrupt`/`drain`/fence 丢失统一走 `failPendingApprovals` | `host.test.ts`「drain 不等待审批」 |
| 4 | **动态工具结果跨会话/跨租户串号**。`DynamicToolBridge` 是单例且只用 `toolCallId` 做键，而 qwen/deepseek 都产 `call_1` | 跨租户模型输入注入 | 键改为 `${sessionId}:${toolCallId}` | `tools.test.ts` 3 条 |

### 协议与隔离类

| # | 缺陷 | 修复 | 验证 |
|---|---|---|---|
| 5 | **流式 turn 的 busy/lease/draining 错误全部返回 HTTP 200**，错误塞进 SSE 事件且带 `seq:0` 污染 `Last-Event-ID`；§4.2 的 router 409 重路由契约因此失效 | `startTurn` 拆成 `beginTurn`（前置判定，可抛真实状态码）+ `run()`（开流后再启动引擎）；`turn/started` 已落库，故用 `seqStart-1` 订阅不丢事件 | HTTP 实测 409 |
| 6 | **用户级隔离缺失**：`getSession` 只按 tenant 查，同租户内 A 可读写 B 的会话；不带 `X-User-Id` 时 `GET /sessions` 列出全租户 | 带用户身份时强制 `session.userId` 匹配（否则 404）；`listSessions` 禁止越权指定 `userId` | HTTP 实测 404 |
| 7 | **审批网关可被客户端绕过**：`metadata.autoApprovedTools` 是客户端可写字段，建会话时塞进去即永久放行 | 移到服务端字段 `Session.autoApprovedTools` + 新列（迁移 `0002`），客户端 metadata 不再参与 | 既有审批用例 |
| 8 | **BYOK = 已认证 SSRF 代理**：`baseUrl` 可指向云元数据/内网，错误文本经 `turn.error.message` 回显 | 写入与解析两处都校验 baseUrl 必须是公网 http(s)；校验函数可注入以便离线测试 | `providers` 新增 1 条 + HTTP 实测 400 |
| 9 | `exclude` 无白名单，`exclude=session/status/changed` 会让流永不结束 | 只允许 `EXCLUDABLE_EVENT_TYPES`，其余 400 并回传可选列表 | HTTP 实测 400 |
| 10 | Idempotency-Key 预留后不回滚：一次 409 就把 key 锁死 24h，一个 turn 都跑不起来 | 失败路径 `releaseIdempotencyKey` | 一致性套件新增断言 |
| 11 | `skill` / `mention` / `image` 输入被静默丢弃，客户端以为生效 | 显式 400 并说明落在 M3 | — |
| 12 | `item/toolCall/argsDelta` 用了 agentMessage 的 itemId，把 toolCallId 拼进 delta；纯工具步骤里整批丢弃 | 事件改为携带 `toolCallId`，不再依赖 agentMessage | — |
| 13 | `busyPolicy: "queue"` 声明但静默降级为 reject | 从枚举中移除，注明 M3 再加 | — |

### 状态一致性类

| # | 缺陷 | 修复 | 回归测试 |
|---|---|---|---|
| 14 | **MySQL `items.seq` 列与 `body.seq` 永久不一致**（`ON DUPLICATE` 不更新 seq，而同一条 agentMessage 被两个不同对象落库两次）。实测 5 vs 7 → `GET /items?afterSeq=6` **把最终回答文本过滤掉**；memory 实现行为相反，共享契约测试抓不到 | item 对象**全程复用同一引用**并原地修改，seq 只分配一次（拷贝会捕获尚未分配的 seq=0 —— 我第一版修复就踩了这个，被新测试抓住） | 一致性套件（两个后端都跑）+ `host.test.ts` |
| 15 | **陈旧快照导致 `closeOrphanedTurn` 打到已完成的 turn 并广播假 `idle`**，把刚开的流式客户端关掉，而 turn 在后台照跑照计费 | 抢到租约后**重读** session；turn 不是 `inProgress` 时只静默修行、不发事件；SSE 改为「本 turn 的 `turn/completed` 之后再等 idle」才关闭 | — |
| 16 | **SSE 订阅泄漏**：`close()` 先于 `attach()` 返回时 `unsub` 永不执行 | 已关闭则立即调用 unsub | — |
| 17 | **软删除的 session 仍可 commit**，turn 变不可中断、继续烧钱；memory 是硬删，语义与 MySQL 相反 | 新增 `SessionGoneError`；memory 改软删；commit 校验 `deleted_at_ms`；host 视同 fence 丢失停止 turn | 一致性套件 + `host.test.ts` |
| 18 | **write-ahead 三态被 pi 事件序破坏**：pi 在 `beforeToolCall` **之前**就 emit `tool_execution_start`，`startedAtMs` 在审批前落库 → 审批期间崩溃会告诉模型「可能已转账」而实际一次都没执行 | 写 `startedAtMs` 的时机移到审批通过之后 | `host.test.ts` 断言 `TOOL_NOT_STARTED` |
| 19 | **delta 早于自己的 `item/started` 到达客户端**（实测 9 个 delta 在前），惰性建节点的客户端丢首屏文本 | delta 发布串在 `item/started` 的 commit 之后并保序 | `host.test.ts` |
| 20 | 空 text 覆盖已流出的 agentMessage 并抹掉 `partialText` | 空则保留已流出的文本 | — |
| 21 | 被中断批次里未派发的 `toolCall` 永久停在 `inProgress` | `finishTurn` 标记为 failed | — |
| 22 | `interrupt()` / `drain()` 无超时等待 | 各加 10s 上限 | — |
| 23 | `clearHold` 之后抛错 → 租约悬挂、无续期、无释放 | try/catch 兜底释放 | — |

### 安全加固类

| # | 缺陷 | 修复 |
|---|---|---|
| 24 | `SECRETS_MASTER_KEY` 默认 32 字节全零，漏配静默通过 | 去掉默认值，必填；`.env.example` 给出生成命令 |
| 25 | `BOOTSTRAP_API_KEY="dev-key"` 每次启动无条件重建 | 改为可选；`NODE_ENV=production` 下设置即拒绝启动；同时拒绝 `STORE=memory` 与缺 `REDIS_URL` |
| 26 | 无请求体上限，单 part 500KB × 无数组上限 → 必然 OOM | `bodyLimit`（默认 1MB，可配）+ 文本 part 降到 100KB + 数组上限 32 |
| 27 | `assertPublicHost` 对方括号 IPv6 字面量（`[::1]`）完全跳过 IP 检查 → 直连 localhost | 先剥括号；补 `::`、`fc00::/7`、`fe80::/10`、v4-mapped 递归校验；`.local` 一并拉黑 |
| 28 | `web_fetch` 先 `res.text()` 再截断，恶意端点可把内存打满 | 改为按字节流式读取并在上限处放弃 |
| 29 | provider `headers`（常含凭据）明文回显；`ownerAddr` 内网地址出网 | headers 只回显键名；`ownerAddr` 只走 `X-Owner` 响应头（router 内部用），不进响应体 |

SSRF 的 20 个绕过用例（十进制/八进制/IDN/元数据地址/v4-mapped/CGNAT）现在都有测试。

---

## 二、评审确认「实现正确」的部分

不只看缺陷，评审也逐条确认了这些是对的（`01` 第四节完整列出）：`startQueue` 串行化、`state.chain` 的提交顺序保证、`finishTurn` 的身份校验与 `resolveDone`/`scheduleRelease` 顺序、定时器无泄漏路径、三个 Redis Lua 脚本、MySQL 的 fence 事务语义（存储层双写彻底挡住）、`closeOrphanedTurn` 用新 fence 的抢占安全性、`subscribe` 的「先挂总线后读库」无空洞、`projectItems` 的 toolResult 配对与 seq 解耦、无 assistant→assistant 相邻、steer 不拆 step、`maxSteps` 不超一步、`stopReason` 优先级、SSE 心跳与正常收尾。安全侧排除了 SQL 注入（18 处查询逐条核对）、未加盐 SHA-256 对 192-bit 随机 key 的适用性、Redis key 注入、`redirect:"manual"`。

---

## 三、已决定延后（不阻塞 M2，但要记账）

**M1 收尾（建议 M2 并行做，约 1.5 天）**
1. **生产构建路径缺失**：`node` 起不来，只能靠 tsx（workspace `exports` 指向 `src/*.ts` 且用 `.js` specifier）。上云前必须解决，并在 CI 里跑一次「构建产物能启动」。
2. `GET /v1/usage`（数据已入 `usage_ledger`）、`POST .../archive`、`GET /v1/agents/{id}/versions`、`GET .../items/{id}/output`。
3. `/openapi.json` + 生成的 TS SDK（设计 §10 承诺；你的 App 团队要并行开工就需要它）。
4. 声明但从不发出的事件（`session/compacted`、`warning`）与不可达错误码（`limits_exceeded`、`quota_exceeded`、`provider_error`、`forbidden`）：要么实现要么从协议里删，别留给客户端猜。
5. 数据生命周期文档 + 子表软删除 + 保留期任务（设计 §14 #6 要求在 schema 定稿前）。
6. 结构化日志（现在是裸 `console`）、`LOG_LEVEL` 定义了从不读取。

**M2 计划内**：多进程 E2E、假厂商、CI、压缩（摘要级）、`lastCompactionSeq` 死代码、5000 item 硬截断取的是最旧的、`metadata` 整体覆写丢更新、`leaseHoldMs`(60s) > `leaseTtlMs`(30s) 导致亲和窗口形同虚设且 `owner:{sid}` 目录键根本没写、`resolveApproval` 轮询语义、steer 竞态丢消息。

**M3/M4**：配额与限流（`quota` 字段解析了但从不使用）、OTel + `/metrics` + trace 透传、API key 轮换与吊销接口、MCP/skills/hooks、per-session 沙箱、内容安全 middleware。

---

## 四、需要你拍板

| # | 事项 | 背景 | 我的建议 |
|---|---|---|---|
| 1 | **`X-User-Id` 的信任模型** | 现在端用户身份完全由调用方自述。如果 service key 下发到 App 端，一把 key 即可互通全部用户数据。评审把这列为 Critical，但它是设计 §5.1 定的形态，不是实现 bug | 明确「service key 只允许存在于你们的服务端（BFF），绝不下发到端」并写进文档与部署检查；同时 M2 加一个可选的端用户 JWT 校验分支，两种模式共存 |
| 2 | **是否需要第二家模型厂商的 key** | 目前只用 DashScope(qwen) 验证过。DeepSeek 的 `reasoning_content`、Kimi 的 128K、智谱的 `thinking` 参数都是不同方言，pi 覆盖了但**我没实测过** | 给我一个 DeepSeek 或 Kimi 的 key（哪个都行），我把方言探针跑一遍；没有的话我用假厂商复刻方言，CI 里也能跑，但不能替代真实验证 |
| 3 | **审批流是否纳入一期** | 已实现且有 5 条测试，但没有真实产品形态（谁批、在哪批、超时怎么办） | 一期保留能力、默认 `approvalPolicy: on-request` 且内置工具都是只读，实际不触发；等有写工具再定产品形态 |
| 4 | **压缩策略** | 现在只有便宜级（裁工具输出），摘要级未实现，长会话会一直全量投影（上限 5000 条且取的是最旧的 —— 这是个 bug） | M2 实现摘要级压缩 + 修正截断方向（保最近） |

---

## 五、M2 任务拆分（建议顺序）

| 顺序 | 任务 | 产出 | 验收 |
|---|---|---|---|
| 1 | **测试地基**（`04` 的 P0-1/2/3）：抽 `core/test/fixture.ts`、`history.test.ts`、`recovery.test.ts`、前缀 sha256 回归 | 八条生产坑中的 #1/#4/#8 有测试 | 故意改坏实现，断言测试变红 |
| 2 | **假厂商 + 方言测试**（P0-4/5）：`packages/testkit` 复刻 DashScope/DeepSeek 方言（`reasoning_content`、cache 字段、tool_calls 分片、`finish_reason: length`） | PiEngine 从 0% 覆盖变为有测试，CI 无需 key | 9 条方言用例 |
| 3 | **`agent-router`** | 鉴权、幂等预留、`owner:{sid}` 目录、SSE 反代、409 重路由一次 | 单元 + 与 runner 的契约测试 |
| 4 | **多进程集群 E2E**（P0-6）：3 runner + 1 router 共享 MySQL/Redis，turn 中 `kill -9` 租约持有者 | `test/cluster/*.test.ts` | 接管、事件无空洞、`?after=` 补齐、fence 单调 |
| 5 | **CI**（P0-7/8）：GitHub Actions（mysql+redis service）、typecheck、单元 + 一致性、覆盖率门禁（按当前 82/69/77/87 设地板） | `.github/workflows/ci.yml` | PR 必须绿 |
| 6 | 压缩摘要级 + 截断方向修正 + `lastCompactionSeq` 落地 | | 长会话投影不再全量 |
| 7 | M1 收尾清单（上面第三节 1–6） | | 构建产物可启动；OpenAPI 可生成 SDK |
