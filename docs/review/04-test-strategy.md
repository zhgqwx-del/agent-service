# 测试体系审计与建设计划（v1，2026-09-26）

> 回答的问题：**我们现在有 UT + E2E 能力吗？还要不要继续建？**
>
> 一句话：**UT 有且质量不错（真正在测分布式不变量，不是测 getter），E2E 只有"单进程内 HTTP"和"单进程打真实 Qwen"两种，缺的恰好是 M2 验收必须的那一类——多进程 + 杀进程 + 事件补洞。必须继续建，而且 P0 的一部分要在写 M2 代码之前落地，否则 M2 的验收标准无法自动化。**
>
> 本文所有覆盖率数字都是 2026-09-26 实测（`@vitest/coverage-v8@4.1.11`，本次审计中加入根 `devDependencies`），不是估算。所有文件路径、API 名、行号都对应当前工作树。
>
> **测量快照**：审计期间工作树在变动。开始时是 45 个测试（37 单元 + 8 集成），结束时是 **77 个**——期间落地了 `packages/core/test/tools.test.ts`（SSRF / web_fetch / current_time / DynamicToolBridge，约 32 条），`app.ts` 也加了 `X-Owner` 响应头、`bodyLimit`、`redactProviderConfig`、跨用户 `listSessions` 的 `forbidden`。本文的表格与 CI 门槛用的是 **13:00 那次测量**（77 tests / 69.00% stmt / 55.89% br / 63.58% fn / 74.22% line，`pnpm typecheck` 绿）。行号引用可能已漂移一两行，按符号名找即可；结论与优先级不受影响，只有 P1-4 已被提前做掉大半（见该行注记）。

---

## 0. 一页结论

| 维度 | 现状 | 判断 |
|---|---|---|
| 单元测试 | 69 条，3.2s；覆盖协议 schema、store 一致性、SessionHost 全生命周期、内置工具与 SSRF、动态工具桥 | **好**。SessionHost 的 16 条是真正的行为测试（租约冲突、接管、安全阀、审批四态、steer、重放） |
| store 一致性套件 | 同一套 8 条契约跑 memory + MySQL/Redis 两种实现 | **很好**。这是本仓库最有价值的设计，必须继续扩 |
| HTTP 进程内 E2E | 5 条，`app.request()` 直调 Hono，不过真实 socket | **够用但有盲区**：SSE 分帧、`X-Accel-Buffering`、客户端断开、反压都没被真 socket 验证过 |
| 真实模型 E2E | 1 条（`e2e-qwen.test.ts`），需 `API_KEY`，默认 skip | **能用但不可 CI**。没有 key 时整条厂商方言链路零验证 |
| **多进程 E2E** | **不存在** | **M2 的验收标准（3 runner + kill 租约持有者）目前无法自动化**，只有 `scripts/demo.sh` 的人工验收 |
| **假厂商** | **不存在**（M1 验收表里写了"假厂商"，实际没交付；前期 PoC 有，在 `poc/agent-runtime/src/scripts/fake-vendor.ts`） | **P0 缺口**。没有它，provider 方言 + `finish_reason=length` + 缓存命中率三条都无法在 CI 里测 |
| 八条生产坑回归测试 | **0/8 有专门测试**。实现上 2 条已具备（#2 由 pi 实现、#4 由 `projectItems` 实现但零覆盖），3 条未实现（#3 #5 #8-摘要级） | **P0 缺口**，design §6.5 明确要求"全部做成 `packages/core` 的测试，作为 `AgentEngine` 契约的一部分" |
| property / fuzz | 不存在 | P1 |
| 压测 | 不存在，design §9 的 `1,000 turn/进程` 是纸面假设 | P2（M4 才验收，但数字要早点有） |
| CI | **不存在**（`.github/` 目录不存在，仓库尚无 commit） | **P0**。现在全靠本机手跑 |
| 覆盖率门槛 | 无。实测总行覆盖 **74.2%**，语句 **69.0%**，**分支 55.9%** | P0 接门槛，先设保底再逐步抬 |

---

## 1. 现状能力盘点

### 1.1 四个层次、跑法、耗时、真正证明了什么

| 层 | 文件 | 条数 | 跑法 | 实测耗时 | **真正证明了什么** | **没证明什么** |
|---|---|---|---|---|---|---|
| **L0 纯函数 / 工具** | `packages/core/test/tools.test.ts`（审计期间新增） | ~32 | `pnpm test` | ~0.4s | `assertPublicHost` 的 SSRF 黑名单（多 host 参数化）、公网字面地址放行、不解析的 host 被拒；`web_fetch` 拒非 http(s) / 私网 / 非法 URL；`current_time` 时区与未知时区；`DynamicToolBridge` 的**按 sessionId 隔离**（同名 toolCallId 不跨 session）、超时、abort | `webFetchTool` 的网络分支仍全未测（`builtin/index.ts:81-107`：3xx 不跟随、`readCapped` 的 256KB 截断与 `reader.cancel()`、HTML 剥离、`!res.ok → isError`）；`:47` 的 v4-mapped v6 分支；动态工具的 **HTTP 反向委托端到端**（`POST /tool-results` → `host.submitDynamicToolResult`）仍未测 |
| **L1 协议 schema** | `packages/protocol/test/schemas.test.ts` | 5 | `pnpm test` | <50ms | id 前缀+UUIDv7 正则、`mergeLimits` 只收紧、`StartTurnRequest` 默认值、持久化事件必须带 `seq` / delta 事件必须不带、未知 item 类型被拒 | 没有 OpenAPI 生成、没有版本兼容性（v1 加字段是否破客户端）、`EXCLUDABLE_EVENT_TYPES` 与实际 `?exclude=` 行为的一致性 |
| **L2 store 契约（双实现）** | `packages/store/test/conformance.ts` + `memory.test.ts` + `mysql-redis.test.ts` | 8（memory）+ 8（mysql/redis） | 默认只跑 memory；`AGENT_SERVICE_INTEGRATION=1` 加 MySQL/Redis | memory <20ms；+MySQL/Redis 约 +350ms | ① 同 session 内 `seq` 连续、旧 fence 写入被拒（`FenceError`）、同 fence 可继续写；② 跨租户读=not-found；③ turn/item/approval/event/sessionPatch 单事务原子落库；④ 幂等键 reserve-once + 完成后重放；⑤ provider secret 只写不读；⑥ 租约单写者 + 接管时 fence 单调 +1 + 过期 owner 不能续期 + 10 并发只 1 成功；⑦ EventBus 先订阅后重放、按 seq 去重、delta 不重放 | **MySQL 的并发 commit**（两条连接同时 `commit` 同一 session，`SELECT ... FOR UPDATE` 是否真的串行化）；分页游标（`listAgents/listSessions/listTurns` 带 cursor 的分支全是 0 覆盖）；`listItems` 的 `turnId`/`afterSeq` 过滤；`appendUsage`；`deleteSession` 软删；`readEvents` 超过单页 500 的翻页；Redis 断连/重连；Stream 超出 `MAXLEN`/TTL 后的降级路径 |
| **L3 SessionHost 行为（in-process，ScriptedEngine）** | `packages/core/test/host.test.ts` + `fake-engine.ts` | 16 | `pnpm test` | ~1.2s | 多 step turn 的 item 序列与事件序列（`seq` 从 1 连续、末尾必为 `turn/completed` → `session/status/changed`）、第二轮带历史、审批 accept/decline/cancel/acceptForSession/超时 5 态、五条安全阀（maxSteps / maxToolCalls / maxCost / wallClock 全部有断言）、interrupt 保留 partialText、steer 折叠、busyPolicy=reject、**同进程并发 startTurn 只成功 1 个**、**别的 runner 持租约 → 409；租约过期 → 接管孤儿 turn 并把旧 fence 写拒掉**、跨租户 404、provider 错误 → `turn.failed` + `error` 事件、`?after=` 重放无重复无空洞且 `exclude` 生效 | 见 §2.2，重点是：`drain()` **零覆盖**、租约续期失败 → abort **零覆盖**、`FenceError` → abort **零覆盖**、reasoning 链路（delta + item）**零覆盖**、`interrupt` 时有 pending 审批 **零覆盖**、动态工具 **零覆盖**、`contextCompaction` 投影 **零覆盖**、`pruneToolResults` 的截断主体 **零覆盖** |
| **L4a HTTP E2E（进程内）** | `apps/agent-runner/test/http.test.ts` | 5 | `pnpm test` | ~0.3s | 鉴权两层（401/400）、`agent → session → 流式 turn → items → ?after= 重放 → resume` 全链、非流式 202 + `Idempotency-Key` 重放、跨租户 key 看不见 session、BYOK 配置只写不读且与 platform preset 合并列出 | 走的是 `app.request()`（Hono 的 fetch handler），**不经过真 socket**：SSE 分帧、`retry:`、心跳、`X-Accel-Buffering: no`、客户端中途断开不等于取消、反压、`Last-Event-ID` 头（只测了 `?after=`）都没验 |
| **L4b 真实模型 E2E** | `packages/providers/test/e2e-qwen.test.ts` | 1 | `set -a; source .env; set +a; pnpm test`（缺 `API_KEY` 则 `describe.skipIf` 跳过） | 实测未跑（无 key）；`timeout 120_000` | 设计上：PiEngine + 真 DashScope 的工具调用 turn、第二轮从 items 投影出的历史里回答、delta 流、跨两轮 seq 连续、`usageLedger` 条数 == 总 step 数 | CI 里完全不跑；只打 qwen 一家（deepseek / kimi / zhipu 的 preset 从未被任何请求验证过）；不测方言异常（截断、缓存字段、分片 arguments） |
| **L5 人工验收** | `scripts/demo.sh`（125 行）+ `scripts/lib/*.py` | — | `deploy/local/infra.sh start` + `pnpm dev:runner` + `scripts/demo.sh` | 人工 | 覆盖面最广（含两 runner 租约冲突的手动复现，见 `docs/PROGRESS.md`），但**不是回归测试**，改代码不会有人跑 |

### 1.2 实测命令与耗时（2026-09-26，本机 Node 24.21 / pnpm 12.5.1）

```bash
# 单元（memory store + ScriptedEngine + 进程内 HTTP + 工具/SSRF）
pnpm test
#   → 13:00 实测：Tests 69 passed | 2 skipped;  Duration 约 3.2s
#   （审计开始时是 37 passed | 2 skipped / 3.29s）

# + MySQL/Redis 一致性套件（需 deploy/local/infra.sh start）
AGENT_SERVICE_INTEGRATION=1 pnpm test
#   → 13:00 实测：Test Files 7 passed | 1 skipped (8);  Tests 77 passed | 1 skipped (78);  Duration 3.23s
#   （审计开始时是 45 passed | 1 skipped / 3.64s）

# + 真实模型端到端
set -a; source .env; set +a; AGENT_SERVICE_INTEGRATION=1 pnpm test
#   → +1 条，约 +30~90s（取决于厂商 TTFT）

# 覆盖率（@vitest/coverage-v8 已加入根 devDependencies）
AGENT_SERVICE_INTEGRATION=1 pnpm vitest run --coverage \
  --coverage.reporter=text \
  --coverage.include='packages/*/src/**' --coverage.include='apps/*/src/**'
#   → Duration 3.23s（覆盖率几乎不增加耗时）

pnpm typecheck    # tsc -b，约 5s
```

`docs/PROGRESS.md` 写"44 个测试（35 单元 + 8 MySQL/Redis + 1 真实 Qwen）"，实测是 **37 单元 + 8 集成 + 1 真实 = 46**（期间 host.test.ts 新增了 2 条并发 startTurn 测试）。建议顺手把 PROGRESS 的数字改掉。

### 1.3 一个必须先记下来的工程事实：runner 进程只能用 `tsx` 启

实测（这直接决定 §4.1 多进程 harness 怎么写）：

```
node --env-file=.env apps/agent-runner/src/main.ts   → ERR_MODULE_NOT_FOUND: packages/core/src/ids.js
node --env-file=.env apps/agent-runner/dist/main.js  → 同样的错（！）
node_modules/.bin/tsx --env-file=.env apps/agent-runner/src/main.ts → OK，/healthz 返回 ok
```

原因：所有 workspace 包的 `package.json` 都是 `"exports": {".": "./src/index.ts"}`，源码内部又用 `./ids.js` 这种 TS 风格的 `.js` 扩展名。Node 原生 ESM 既不会把 `.js` 映射到 `.ts`，也不会因为你跑的是 `dist/main.js` 就改走 `dist`。所以：

- **多进程 harness 必须 `spawn` `tsx`**，不是 `node`（任务描述里假设的 `node --env-file` 不可行）。
- 这同时是一个**打包缺陷**：生产镜像里 `node dist/main.js` 现在跑不起来。修法是给每个包加条件 exports（`"exports": {".": {"types":"./dist/index.d.ts","import":"./dist/index.js","development":"./src/index.ts"}}`）或改用 bundler 出单文件。列为 P1，并配一条冒烟测试（`pnpm build && node apps/agent-runner/dist/main.js` 能起来）。

---

## 2. 覆盖率与缺口矩阵

### 2.1 实测覆盖率（含 MySQL/Redis 集成，不含真实模型）

**总计（13:00 实测）：语句 69.00% (1171/1697)、分支 55.89% (574/1027)、函数 63.58% (248/390)、行 74.22% (1028/1385)**

按包聚合：

| 包 | 语句 | 分支 | 函数 | 行 | 点评 |
|---|---|---|---|---|---|
| `protocol` | 97.5% (77/79) | 90.0% | 83.3% | 98.6% | 到顶了，schema 包合理 |
| `providers` | 92.2% (83/90) | 83.1% | 91.3% | 98.6% | 好；缺的是 `fetch` 注入路径与 headers 分支 |
| `store` | 72.7% (348/479) | 62.1% | 70.7% | 78.2% | 主路径好，分页/过滤/软删/迁移是洞 |
| `core` | **65.7% (498/758)** | **53.0%** | **57.9%** | 70.9% | **最大的洞**：`pi.ts` 0%、`history.ts` 67%、`host.ts` 的生命周期分支。`tools/` 已被新测试拉到 94% |
| `agent-runner` | **56.7% (165/291)** | **34.9%** | 50.0% | 61.8% | 反而降了（`app.ts` 新增了 `X-Owner`/`bodyLimit`/`forbidden` 分支但没配测试）；`main.ts`/`config.ts` 仍 0% |

> 趋势提示：`agent-runner` 的分支覆盖从 40.4% 掉到 34.9%，因为新代码（`X-Owner` 重路由头、`bodyLimit`、跨用户 `forbidden`）没有同步的测试。**这正是 CI 门槛要先接上的理由**——否则"加功能顺手掉覆盖"不会被任何人看到。

### 2.2 按文件的缺口矩阵（"未测行为"是把未覆盖行翻译成行为）

#### `packages/core/src/engine/pi.ts` — **0%（0/214 行）**

整个 PiEngine 只被 `e2e-qwen.test.ts` 跑到，而它默认 skip → **CI 里 PiEngine 一行都不执行**。`ScriptedEngine` 复刻的是 PiEngine 的"意图"，不是它的实现。

未测行为：`toPiMessage` 的历史回灌（尤其 `reasoning → {type:"thinking"}` 无条件转换，DeepSeek 的 `requiresReasoningContentOnAssistantMessages` 下会不会 400）、`toStepResult` 的 usage/stopReason 映射、`beforeToolCall` 的 `{block, reason, terminate}` 返回与 `queueMicrotask(() => agent.abort())` 的竞态、`finishTurn` → `sink.onStepEnd` 的 `end` 传播、`agent.steer` / `agent.abort` 与 `params.signal` 的双向传播、`getApiKey` 只在 provider id 匹配时返回 key（BYOK 不串租户）、`toolcall_delta` 的 `contentIndex` 取 id。

→ **只有假厂商（§4.2）能把这块在 CI 里点亮。这是 P0 里优先级最高的一项。**

#### `packages/core/src/session/host.ts` — 79.7% 语句 / 70.6% 分支

| 未覆盖位置 | 未测行为 | 严重度 |
|---|---|---|
| 716-728 (`drain()` 全部) | SIGTERM 优雅下线：拒新 turn、等 in-flight、超时 abort、释放所有 hold 中的租约 | **高（M2 验收项）** |
| 310-314 | 租约续期失败 → 立刻 `abort()` 当前 turn（design §4.2 第 4 条） | **高** |
| 699-704 (`onCommitError`) | `FenceError` → 被 fence 掉 → abort；非 fence 错误只记日志 | **高** |
| 582-584 | `interrupt()` 时把 pending 审批 resolve 成 `"cancel"`（坑 #7 的真实路径） | **高** |
| 657-658 | `closeOrphanedTurn` 把死 turn 的 pending 审批标 `expired` + `decidedBy: "system:owner_lost"`（design §4.3 最后一行） | **高** |
| 382-398 | reasoning delta → `item/reasoning/delta` 事件 + `reasoning` item 落库 | 中 |
| `onToolArgsDelta`（原 386-388，现 471-475） | `item/toolCall/argsDelta` 事件。**审计期间被改过**：事件 schema 从 `{itemId, delta}`（delta 里塞 `"<toolCallId>:<delta>"` 字符串）改成了一等的 `{turnId, toolCallId, itemId?, delta}`，host 侧也不再依赖 `agentItemId`（纯工具 step 没有 agentMessage item）。**新形状仍零覆盖**，而它是客户端渐进渲染工具参数的唯一依据 | 中 |
| 424 | `stopReason === "length" && toolCalls.length === 0` → `max_output_tokens` | **高（坑 #2）** |
| 470 | 模型调了不存在的工具 → `allow:false, "unknown tool X"` | 中 |
| 540-545 | `resolveApproval`：审批在库里 pending 但不在本 runner → `session_lease_conflict`；已结算 → `approval_expired` | 中 |
| 574-577 | `interrupt` 一个不在本 runner 的 turn → 库里已结算则直接返回，否则 409 | 中 |
| 592-593 | `submitDynamicToolResult` | 中 |
| 638 | `finishTurn` 的 commit 失败 → "下一个 owner 会修复"（不抛，靠 repair） | 中 |
| 303-305 | `startTurn` 首个 commit 失败 → 回滚 active + 释放租约 | 低 |
| 611 | `result.aborted` → `interrupted` | 低 |
| 734-736 (`lastCompactionSeq`) | `metadata.lastCompactionSeq` 存在时只装载压缩点之后的 items | 中（压缩没实现，路径悬空） |

#### `packages/core/src/context/history.ts` — 67.1% 语句 / 57.6% 分支

| 未覆盖 | 未测行为 | 严重度 |
|---|---|---|
| **46-48** | **孤儿 toolCall 合成恢复结果：`startedAtMs ? TOOL_OUTCOME_UNKNOWN : TOOL_NOT_STARTED`** | **极高（坑 #4，design §6.4，M1 验收项）** |
| 118-129 | `pruneToolResults` 的整个截断主体（超预算 → 从老到新截 toolResult 内容、保护最近 2 个 assistant、<64 token 不动） | **高（坑 #8 便宜级）** |
| 63-66 | `contextCompaction` item → 作为 system 摘要打头 | 高（坑 #8 摘要级） |
| 81 | `reasoning` item 合并进同 step 的 assistant 消息 | 中 |
| 89-91 | `systemNotice` item → 以 user 消息注入（`toolsChanged` 增量通知的落点） | 中（design §6.2 的增量机制靠它） |
| 39 | 空 group 不产出空 assistant 消息 | 低 |

#### `packages/core/src/tools/` — 94.1%（审计期间从 29% 补上来的）

`dynamic.ts` 已基本覆盖（超时 / abort / **按 sessionId 隔离 pending**——注意 `resolve(sessionId, toolCallId, result)` 的签名在审计期间加了 `sessionId` 参数，key 是 `${sessionId}:${toolCallId}`，防止模型给出的重复 toolCallId 跨 session 串线）。`builtin/index.ts` 从 22.5% → **60.6% 语句 / 67.3% 分支**。

**仍未覆盖**：`builtin/index.ts:47`（v4-mapped v6 地址 `::ffff:` 分支）、`:81-107`（`webFetchTool` 真正发请求之后的一切 + 新增的 `readCapped()` 流式截断）：`redirect:"manual"` 不跟随 3xx、256KB 硬截断与 `reader.cancel()`（防止恶意端点用无限流把我们撑死）、HTML/script/style 剥离、64KB 输出上限、`!res.ok → isError`。这段需要一个本地 HTTP 服务器（可以直接复用 §4.2 的假厂商进程，加两个非 LLM 路由：`/slow-infinite`、`/redirect`、`/html`）。

**动态工具的 HTTP 反向委托端到端仍零覆盖**：`POST /v1/sessions/:id/turns/:turnId/tool-results` → `host.submitDynamicToolResult`（`host.ts:630-633`）→ `DynamicToolBridge.resolve` 这条链，以及 `startTurn` 里 `req.dynamicTools` → `dynamicTools.asTool(...)` 的装配（`host.ts` 的 `dynamicTools` 分支）。协议里 `dynamicTools` 是一等能力（`/v1/capabilities` 声明 `dynamicTools: true`），端到端路径还没跑通过一次。

design §12 把 SSRF 列进"多租户 MCP 的安全面"，M3 验收有"SSRF 用例被拒"——**这一块现在有了地基，把剩下的网络分支补完即可（P1-4 已缩小）。**

#### `packages/core/src/context/assemble.ts` — 84%

未覆盖：`buildSystemPrompt` 的 skills 目录分支（28-31，`skills` 永远是空数组因为 `SkillSource` 没接）、`estimateTokens` 的 CJK 分支（68）。**更重要的是：没有任何"前缀 sha256 三请求一致"的回归测试**，而 design §6.2 明确写了"CI 里跑前缀 sha256 回归测试"、§11 M1 验收写了"前缀 sha256 三请求一致"。`toolSetFingerprint` 的排序无关性、`computeContextEpoch` 的 bump 语义都没断言。

#### `packages/store/src/mysql/store.ts` — 65.1% 语句 / 53.2% 分支

未测：`migrate()` 的增量应用（66-75，第二次 connect 跳过已应用的文件）、`listAgents/listSessions/listTurns` 的 cursor 分支、`listSessions` 的 `userId`/`includeArchived` 组合、`listItems` 的 `turnId`/`afterSeq`、`getItem`、`listApprovals(pendingOnly)`、`deleteProviderConfig`、`appendUsage`、`deleteSession` 软删、`listTurns` 的 `sortDirection: asc`。
**最关键的未测行为：两条连接并发 `commit` 同一 session**——`SELECT ... FOR UPDATE` 是整个 seq 连续性的唯一保障，conformance 里是串行调用的。

#### `packages/store/src/memory.ts` — 80.8%
同类分页/过滤分支未测。`memory.ts` 只是测试替身，但它和 MySQL 的行为分歧会让 L3 测试骗人 → conformance 扩条目时两边同时受益。

#### `packages/store/src/blob/fs.ts` — **0%**
`FsBlobStore` 完全未测（`main.ts` 里 `void new FsBlobStore(...)` 建了就扔）。含一条安全检查：`blob key escapes root`。等大输出 offload（`ToolResultItem.outputRef`）实现时一起测；现在写一条 3 分钟的单测也不亏。

#### `packages/store/src/redis/{lease,bus}.ts` — 92.6% / 100%
好。未覆盖的是 `acquire` 冲突时 `addr` 为空的分支、`bus.subscribe` 里"replay 期间 buffer 的事件 seq <= maxSeq 被丢弃"这一行（90-92）——正是去重逻辑，值得补一条。

#### `apps/agent-runner/src/{main,config}.ts` — **0%**
`loadConfig` 的 zod 解析（默认值、`RUNNER_ADDR` 兜底、`SECRETS_MASTER_KEY` 正则）和 `startRunner` 的组装（`STORE=mysql` 分支、platform preset 注入、`DEFAULT_MODEL` 追加、SIGTERM 钩子）从未执行。多进程 harness（§4.1）会顺带把 `main.ts` 点亮；`config.ts` 值得一条 10 行的纯单测。

#### `apps/agent-runner/src/app.ts` — 61.6% 语句 / **41.7% 分支**（且在下降）
未测端点：`/healthz`、`/readyz`（含 503）、`/v1/capabilities`、`GET /agents`（分页）、`GET /agents/:id`（含 `?version=`）、`PUT /agents/:id`（版本 +1）、`GET /models`、`GET /tools`、`GET /sessions`（分页/过滤）、`DELETE /sessions/:id`、`GET /turns`、`GET /turns/:turnId`、`interrupt`、`steer`、`tool-results`、`GET /approvals`、`POST /approvals/:id`、`?exclude=` 解析、幂等冲突两条错误分支、流式 turn 启动失败时往 SSE 里塞 `error` 再关流、`onError` 的 500 兜底。

**审计期间新增且同样未测的分支**（这些正是 M2 的契约面，必须补）：
- `onError` 里的 `session_lease_conflict` → 设 `X-Owner: <ownerAddr>` 响应头并**从 body 里抹掉 `details`**（"router 需要 owner 地址，外部客户端不该学到内部拓扑"）。§4.1 的 cluster 测试现在可以直接断言 `res.headers.get("x-owner")`，同时要断言 body 里 **没有** `details.ownerAddr`。
- `bodyLimit({ maxSize: deps.maxBodyBytes })`（默认 `MAX_BODY_BYTES=1_000_000`）→ 超限应返回 `invalid_request`，不是 413/500。
- `GET /sessions` 带 `?userId=` 且与 `X-User-Id` 不一致 → `forbidden`（新的越权防护，零测试）。
- `redactProviderConfig` 应用在 `GET /providers` 与 `PUT /providers/:id` 上（`providers/src/service.ts:61`）——现有的 "BYOK is write-only" 测试只断言了 `sk-xyz` 不出现，没断言 `apiKeyRef` 等字段的脱敏形状。

`InputPart.text` 的上限在审计期间从 500,000 收紧到 **100,000** 字符（`protocol/src/item.ts:6`）——边界值 100_000 / 100_001 值得一条 schema 测试。

---

## 3. 八条生产坑 → 回归测试状态与补法

来源：`docs/research/01-prior-harness-research-digest.md` §3.1；design §6.5 要求"全部做成 `packages/core` 的测试，作为 `AgentEngine` 契约的一部分，两种 engine 都要过"。

**总结：8 条里 0 条有专门回归测试。**实现状态：2 条已具备但零覆盖（#1 #4），1 条由依赖实现且零覆盖（#2），1 条部分实现且关键路径零覆盖（#7），1 条只有便宜级且主体零覆盖（#8），3 条完全未实现（#3 #5 #6-commit 顺序）。

### 前置：把测试夹具抽出来 + 增强 ScriptedEngine

下面所有测试都依赖两件事，先做：

**(a) `packages/core/test/fixture.ts`**（从 `host.test.ts` 里把 `setup()` / `waitIdle()` / `waitFor()` 提出来导出，签名不变）：

```ts
export async function setup(
  script: ScriptStep[],
  agentPatch?: Partial<AgentDefinition>,
  cfg?: Partial<SessionHostDeps["config"]>,
  extraTools?: RunnerTool[],
): Promise<{ store: MemorySessionStore; lease: MemoryLeaseStore; bus: MemoryEventBus;
            engine: ScriptedEngine; agent: AgentDefinition; host: SessionHost;
            session: Session; events: Event[]; unsub: () => void }>;
export const waitIdle: (h, timeoutMs?) => Promise<Session>;
export const waitFor: <T>(fn: () => T | undefined, timeoutMs?) => Promise<T>;
export const principal: Principal;      // { tenantId: "t_a", userId: "u_1" }
export const seqsOf = (events: Event[]) => number[];   // 只取持久化事件的 seq
```

**(b) `packages/core/test/fake-engine.ts` 增强**（当前 90 行，加 4 个字段，保持向后兼容）：

```ts
export interface ScriptStep {
  text?: string; reasoning?: string; toolCalls?: {name: string; args: unknown}[];
  stopReason?: AssistantStepResult["stopReason"]; errorMessage?: string;
  usage?: Partial<Usage>; delayMs?: number;
  // ---- 新增 ----
  /** 复刻 pi 的截断语义：stopReason==="length" 时不执行任何 toolCall，
   *  对每个 call 依次 emit onToolExecutionStart + onToolResult(isError:true)，然后继续下一 step */
  truncated?: boolean;
  /** 工具完成顺序（下标数组）。给 [2,0,1] 就让第 3 个先完成 */
  completionOrder?: number[];
  /** 每个 toolCall 的人工延时，配合 completionOrder 制造乱序 */
  toolDelaysMs?: number[];
  /** 切换本 step 上报的 provider/model，用于"同会话换模型" */
  provider?: string; model?: string;
}
```

> 注意 `truncated` 要**照抄 pi 的实际行为**（`@earendil-works/pi-agent-core/dist/agent-loop.js:159-166` → `failToolCallsFromTruncatedMessage`，它**先 emit `tool_execution_start`** 再 emit 失败结果，且 `terminate: false` 所以循环继续）。ScriptedEngine 若和 pi 行为不一致，契约测试就是假的。

### 逐条

---

#### 坑 #1 — 合成 tool_result 的 id 必须稳定（prompt cache 归零 = 用户成本投诉）

**现状**：结构上已满足——`projectItems`（`history.ts:45-48`）合成时复用**原始 `call.toolCallId`**，文本是模块常量 `RECOVERY_NOT_STARTED` / `RECOVERY_OUTCOME_UNKNOWN`，不含时间戳/随机数。**但零测试，且 `history.ts:46-48` 零覆盖**，任何重构（比如改成 `newId("item")`）都不会有测试拦住。
另有一个未被讨论的前缀不稳定源：`pi.ts:282` 无条件把 `reasoning` 转成 `{type:"thinking"}` 回灌历史，不同 provider 的请求体因此不同。

**要写的测试**（新建 `packages/core/test/history.test.ts` + `packages/core/test/prefix.test.ts`）：

```
it("synthesised tool results are byte-identical across two projections (prompt cache stays warm)")
  arrange: 手搓 items 数组（不经过 host，纯函数测）：
    userMessage(seq 1) → agentMessage(seq 2, step 1) → toolCall(seq 3, step 1, toolCallId "call_1", 无 startedAtMs)
    （故意没有 toolResult）
  act:   const a = projectItems(items); const b = projectItems([...items].reverse());  // 顺序无关
  assert:
    sha256(stableStringify(a.messages)) === sha256(stableStringify(b.messages))
    a.messages.at(-1) === { role:"toolResult", toolCallId:"call_1", name:"echo",
                            content:[{type:"text", text: RECOVERY_NOT_STARTED}], isError:true }
    a.repaired === [{ toolCallId:"call_1", code:"TOOL_NOT_STARTED" }]
```

```
it("prefix sha256 is identical across three turns and independent of tool order")   // prefix.test.ts
  arrange: agent = {instructions:"X", tools:["b","a","c"]}; tools = StaticToolRegistry([a,b,c])
  act:   p1 = buildSystemPrompt(agent, []); f1 = toolSetFingerprint(reg.resolve(["b","a","c"]))
         f2 = toolSetFingerprint(reg.resolve(["c","b","a"]))
         e  = computeContextEpoch({agentId, agentVersion:1, systemPrompt:p1, tools, skills:[]})
  assert: sha256(p1) 三次调用相同；f1 === f2（排序无关）；
          换 agentVersion / 增删工具 / 改 description → epoch 变；
          只改 execute 实现（不改 name/description/parameters/kind）→ epoch **不**变
```

```
it("the engine receives a byte-identical system prompt + tool schema on every step")  // 需要假厂商，见 §4.2
  用 fakeVendor.requests[] 断言：三次请求的 messages[0].content 和 JSON.stringify(tools) 完全相同，
  且第二次起 usage 报告 cached_tokens > 0
```

---

#### 坑 #2 — `finish_reason == length` 时丢弃**全部** tool call

**现状**：**pi 已实现**（`agent-loop.js:159-166`，注释都写了 "Fail them all instead of executing potentially borked calls"）。但：
1. 本仓库**零测试**，pi 升级后行为变了不会被发现；
2. `host.ts:424` 只在 `stopReason==="length" && toolCalls.length===0` 时设 `max_output_tokens` ——带 tool call 的截断完全依赖 pi，host 侧没有兜底也没有 `warning` 事件；
3. **一个真实缺陷**：pi 的截断路径会 emit `tool_execution_start` → host 的 `onToolExecutionStart`（`host.ts:414-419`）给 toolCall item 打上 `startedAtMs` → **一个从未执行过的工具调用，在崩溃恢复时会被 `projectItems` 误判为 `TOOL_OUTCOME_UNKNOWN`（"副作用可能已发生，验证后再重试"）而不是 `TOOL_NOT_STARTED`（"从未执行，可以重试"）**。这两条恢复码的语义是相反的（research 01 §3.1 #4 明确要求"两个恢复码的指导语语义相反"），误判会让模型对一个安全可重试的调用变得保守，或反过来。
4. `ScriptedEngine` 完全没有这个语义（它照常执行 toolCalls），所以"两种 engine 都要过"目前是假的。

**要写的测试**（`packages/core/test/truncation.test.ts`，对照 PoC `test/truncation.test.ts` 的 7 条）：

```
it("finish_reason=length with N tool calls executes ZERO tools (not just drops the last)")
  arrange: const exec = vi.fn(); tool = {...echoTool, name:"probe", execute: exec}
           setup([{ text:"partial", stopReason:"length", truncated:true,
                    toolCalls:[{name:"probe",args:{}},{name:"probe",args:{}},{name:"probe",args:{}}] },
                  { text:"recovered" }], {}, {}, [tool])
  act:   startTurn(...); await waitIdle(h)
  assert: exec 未被调用（0 次）
          items.filter(type==="toolCall").length === 3          // write-ahead 证据还在
          items.filter(type==="toolResult").every(i => i.isError) === true
          每条 toolResult 的文本含 /output token limit|truncat/i
          turn.status === "completed"（不是 failed，不是挂起）

it("a truncated tool call is NOT marked startedAtMs (so crash recovery says TOOL_NOT_STARTED)")
  ↑ 这条现在会 FAIL。修法：host 在 onAssistantMessage 里记下 `msg.stopReason === "length"`，
    onToolExecutionStart 遇到该 step 时跳过写 startedAtMs；或让 pi 的截断路径不 emit start。
  assert: items.find(type==="toolCall").startedAtMs === undefined
          projectItems(items.filter(i => i.type !== "toolResult")).repaired[0].code === "TOOL_NOT_STARTED"

it("history after a truncated step carries no dangling tool_use (next turn is well-formed)")
  assert: projectItems(items) 里每个 assistant.toolCalls[i] 后面紧跟一条同 id 的 toolResult

it("length with zero tool calls stops the turn with max_output_tokens")   // 覆盖 host.ts:424
  arrange: setup([{ text:"cut off here", stopReason:"length" }])
  assert: turn.stopReason === "max_output_tokens"; turn.partialText === "cut off here"

it("repeated truncation cannot loop forever: maxSteps catches it")
  arrange: 8 个连续 truncated step，limits.maxSteps = 3
  assert: turn.steps === 3; turn.stopReason === "max_steps"

it("emits a warning event when tool calls were discarded")   // 需要先实现 warning 发射点
  assert: events.some(e => e.type === "warning" && e.code === "tool_calls_discarded")
```

---

#### 坑 #3 — 换模型前先用旧模型压缩；剥 `providerMetadata`、reasoning 降级为 text

**现状**：**完全未实现**。没有摘要级压缩、没有 `differentModel` 检测、没有 reasoning 降级。`host.ts:234` 的 `const modelRef = {...agent.model, ...(req.model ?? {})}` 允许每个 turn 换模型；`pi.ts:282` 把历史里的 reasoning 无条件回灌成 `{type:"thinking"}`。`presets.ts` 里 deepseek 标了 `requiresReasoningContentOnAssistantMessages: true` —— 从 qwen 换到 deepseek-reasoner 再换回来，历史里的 thinking 块跨 provider 回灌是明确的 400/行为异常风险，**目前无任何防护也无任何测试**。

**要写的测试**（先写成 `it.fails(...)` 或 `it.todo`，钉住契约；压缩实现落地后转绿）：

```
it("switching model mid-session strips foreign reasoning and downgrades it to text")
  arrange: setup([{ text:"answer A", reasoning:"chain A", provider:"p1", model:"m1" }])  // turn 1
           turn 2 用 req.model = { provider:"p2", model:"m2" }
  act:   两轮，看 engine.received[1].history
  assert: history 里 turn-1 的 assistant 消息 reasoning === undefined
          且其 text 以 "[previous model reasoning] chain A" 之类的降级形式保留（或干脆丢弃，选一个写进协议）
          engine.received[1].history 中不存在任何 provider !== "p2" 的 reasoning

it("model switch triggers a compaction with the OLD model before the first new-model call")
  assert: 存在 contextCompaction item，其 metadata.compactedBy === "p1:m1"
          该 item 的 seq < turn2.seqStart
          session.metadata.lastCompactionSeq 被设置

it("missing comp_hash does not trigger compaction")   // codex 的 compact_model_fallback 语义
```

---

#### 坑 #4 — 崩溃恢复三态 + write-ahead `tool/call`

**现状**：**实现完整、零测试**。write-ahead 在 `host.ts:389-396`（toolCall item 在 `beforeToolCall` 之前就落库），`startedAtMs` 在 `host.ts:414-419`，三态判定在 `history.ts:366-374`。`host.test.ts` 那条 "takes over an orphaned turn" 测的是 **turn 级别**接管（turn 被标 `interrupted`、旧 fence 被拒），**没有断言任何一条恢复码**——它构造的孤儿 turn 里没有 toolCall item。`history.ts:46-48` 零覆盖。M1 验收表写了"八条生产坑测试通过"，这条没兑现。

**要写的测试**（`packages/core/test/recovery.test.ts`，对照 PoC `test/repair.test.ts` 的 10 条）：

```
it("a toolCall with startedAtMs and no result recovers as TOOL_OUTCOME_UNKNOWN")
  arrange: 纯 projectItems 单测。items = [userMessage, agentMessage(step1),
           toolCall(step1, toolCallId:"c1", startedAtMs: 123)]   // 有 startedAtMs = 执行过
  assert: repaired === [{toolCallId:"c1", code:"TOOL_OUTCOME_UNKNOWN"}]
          合成的 toolResult.content[0].text === RECOVERY_OUTCOME_UNKNOWN
          该文本含 /may or may not/ 且不含 /never was executed/

it("a toolCall without startedAtMs recovers as TOOL_NOT_STARTED")
  assert: code === "TOOL_NOT_STARTED"；文本 === RECOVERY_NOT_STARTED；含 /never executed/

it("the two recovery codes give opposite guidance")     // research 01 §3.1 #4 的原话
  assert: /Verify before repeating/.test(RECOVERY_OUTCOME_UNKNOWN)
          /Decide whether to call it again/.test(RECOVERY_NOT_STARTED)
          两条文本不相等

it("a completed or failed toolResult produces zero orphans")
  arrange: toolCall + toolResult(isError:true)
  assert: repaired === []; 该 toolResult 原样出现在 transcript

it("N orphans get N guidance messages, and only the one with a result is settled")

it("write-ahead survives a crash mid-turn: the next owner sees the toolCall item and repairs it")
  arrange: setup([{ text:"calling", toolCalls:[{name:"slow", args:{}}] }, { text:"never" }])
           startTurn → waitFor(events.some(e => e.type==="item/started" && e.item.type==="toolCall"))
           // 模拟进程死亡：不 interrupt（那是优雅路径），而是
           h.lease.expire(h.session.id)                  // 租约过期
           // 用同一个 store 造第二个 host（runnerId "r2"）复用 store/bus
  act:   host2.startTurn(principal, sessionId, {input:[{type:"text",text:"继续"}], ...})
  assert: 旧 turn.status === "interrupted" && error.code === "owner_lost"
          host2 的 engine.received[0].history 末尾是一条 toolResult，文本 === RECOVERY_OUTCOME_UNKNOWN
          （这条同时覆盖 host.ts:648-658 的 closeOrphanedTurn）

it("a pending approval on the dead turn is expired with decidedBy system:owner_lost")  // host.ts:657-658
  assert: (await store.listApprovals(sid,{})).every(a => a.status === "expired")
          && a.decidedBy === "system:owner_lost"
```

---

#### 坑 #5 — provider 报告"丢弃了 thinking block" → 告警

**现状**：**未实现**。`protocol/src/event.ts` 里有 `warning` 事件类型（`{code, message}`），但**全仓库没有任何一处发射它**（只在 `dist/*.d.ts` 里出现）。国内厂商对应字段仍是开放问题（research 01 把重要度标"中"）。

**要写的测试**（先建立机制，再补断言）：

```
it("a provider-reported dropped thinking block raises a warning event and a metric")
  arrange: 假厂商在响应里带一个可识别的丢弃信号。国内厂商没有 Anthropic 的
           `inputTransformations`，所以用我们自己能控制的两个代理信号：
           (a) 请求里带了 reasoning 历史、响应 usage.reasoning_tokens === 0 且模型 reasoning === true；
           (b) 厂商回了一个非标字段（fake vendor 用 `x_dropped_thinking: true` 模拟）。
  act:   跑一个 turn
  assert: events.some(e => e.type==="warning" && e.code==="reasoning_dropped")
          且该 warning 是**持久化**事件（带 seq），能在 ?after= 里被重放
  note:  实现落点建议在 PiEngine 的 message_end → toStepResult 之后，由 host 统一发。
         同时加计数器 agentrt_reasoning_dropped_total{provider}（design §6.2 的指标清单）。
```

---

#### 坑 #6 — 并发工具：dispatch 可乱序，**commit 严格按模型顺序**

**现状**：dispatch 侧有（pi `toolExecution: "parallel"`，`concurrencySafe === false → "sequential"`，`pi.ts:244`）。**commit 顺序侧没有显式机制**：host 的 `onToolResult`（`host.ts:421-436`）按到达顺序落库，所以 items 表里 toolResult 的 seq 顺序 = 完成顺序。
好消息是 **`projectItems` 把它救回来了**：它按 `group.calls`（模型给的顺序）遍历，从 `results` map 里取，所以**送给模型的 transcript 是模型顺序**。坏消息是这个性质从来没被断言过，任何人重构 `projectItems`（比如改成按 seq 线性输出）都会静默破坏它。另外 `concurrencySafe` 字段没有任何工具设置过，也没有测试。

**要写的测试**（`packages/core/test/concurrency.test.ts`）：

```
it("3 concurrent tools finishing 3,1,2 still commit to the model transcript as 1,2,3")
  arrange: setup([{ toolCalls:[{name:"t1",args:{}},{name:"t2",args:{}},{name:"t3",args:{}}],
                    toolDelaysMs:[60, 30, 5] },                // t3 最快
                  { text:"done" }])
  act:   startTurn; waitIdle
  assert: // 落库顺序可以是完成顺序（这是允许的）
          const results = items.filter(i => i.type==="toolResult");
          // 但投影给模型的顺序必须是模型顺序
          const msgs = projectItems(items).messages;
          const after = msgs.slice(msgs.findIndex(m => m.role==="assistant") + 1, ... );
          expect(after.map(m => m.toolCallId)).toEqual(["call_1","call_2","call_3"])
          expect(after.map(m => m.name)).toEqual(["t1","t2","t3"])

it("a tool marked concurrencySafe:false runs sequentially (no overlap)")
  arrange: 工具 execute 里维护 inFlight 计数，进入 +1 退出 -1，记录 max
  assert: maxInFlight === 1（对 concurrencySafe:false）；=== 3（对默认 readOnly 工具）

it("a barrier tool that mutates the registry is not overlapped with others")
  // research 01 §3.1 #6 的"工具执行可能改注册表 → barrier"。当前没有动态注册表，
  // 先写 it.todo，MCP 热插拔（M3）落地时转绿。

it("Promise.allSettled semantics: one tool throwing does not lose the others' results")
  arrange: 3 个工具，中间那个 execute 抛异常
  assert: 3 条 toolResult 都落库；中间那条 isError:true；turn 仍 completed
```

---

#### 坑 #7 — 取消顺序：先让任务观察 cancellation，再清 pending approvals（否则历史里写成"用户拒绝"而不是"用户中断"）

**现状**：`interrupt()`（`host.ts:579-590`）的顺序是**对的**——先 `state.stopReason = "interrupted"`，再把所有 pending 审批 `resolve("cancel")`，最后 `abort()`。但 **`host.ts:582-584` 零覆盖**：现有的 "gates tools behind approvals: cancel" 那一段测的是**用户主动 `resolveApproval(..., "cancel")`**，走的是 `gateToolCall` 里的 `decision === "cancel"` 分支（`host.ts:511-514`），**不是** `interrupt()` 路径。两条路径的产物不同（一条有 `approval/resolved{decision:"cancel"}` 事件，另一条审批在 `finishTurn` 里被 `clearTimeout` 后就没人写库了——**pending 审批可能永远停在 `pending` 状态**，这是个真实缺陷）。

**要写的测试**（加到 `host.test.ts` 或新的 `cancellation.test.ts`）：

```
it("interrupting a turn that is waiting on approval records INTERRUPTED, not DECLINED")
  arrange: setup([{ text:"", toolCalls:[{name:"danger",args:{}}] }, { text:"never" }])
  act:   const r = await startTurn(...)
         const ap = await waitFor(() => events.find(e => e.type==="approval/requested"))
         await host.interrupt(principal, sid, r.turn.id)          // ← 不是 resolveApproval
  assert: turn.status === "interrupted" && turn.stopReason === "interrupted"
          items.find(i => i.type==="toolCall").status === "declined"
          items.find(i => i.type==="toolResult")?.content[0].text 含 /interrupt/ 且不含 /declined by user/
          // 关键：审批不能烂在 pending
          (await store.getApproval(sid, ap.approval.id)).status !== "pending"
          // 且决策归因要能区分"用户拒绝"和"中断"
          expect(stored.decidedBy).toMatch(/system:interrupt/)
  ↑ 最后两条现在会 FAIL。修法：interrupt 时把 pending 审批以
    {status:"resolved"|"expired", decision:"cancel", decidedBy:"system:interrupt"} 落库。

it("discards late proofs: a tool result arriving after interrupt is not persisted")
  arrange: slowTool 在 400ms 后返回；interrupt 在 100ms 时发生
  assert: 不出现 text === "slow-done" 的 toolResult；turn 已 interrupted 后不再有新的 seq

it("interrupt is idempotent and a second interrupt returns the settled turn")   // host.ts:574-577
  assert: 第二次 interrupt 不抛，直接返回 status==="interrupted" 的 turn
```

---

#### 坑 #8 — 两级压缩（便宜级保配对/迟滞/幂等/保护 skill 输出；摘要级是事务）

**现状**：**只有便宜级，且主体零覆盖**。`pruneToolResults`（`history.ts:427-450`）实现了"从老到新截 toolResult 内容、保护最近 2 个 assistant、<64 token 不动"，但 118-129（整个截断循环）未覆盖 → 迟滞阈值、保护窗口、幂等性、总量是否真的降到预算内，全部无断言。
**缺失的**：摘要级压缩（`contextCompaction` item 从未被写入，`session/compacted` 事件从未发射，`POST /compact` 端点不存在，`session.metadata.lastCompactionSeq` 只被读不被写）；tool-pairing 平衡切点算法（PoC 有 86 行 + 19 条测试，未移植）；压缩的事务性（surface 变了丢弃摘要、shrink 比较）；**`cache.read + cache.write` 计入 context 占用**（`host.ts:247` 只用 `model.contextWindow * 0.7`，`estimateTokens` 是 `chars/4` 粗估，完全没看 usage 里的 cacheRead/cacheWrite）。

**要写的测试**：

便宜级（现在就能写，`packages/core/test/history.test.ts`）：

```
it("cheap pruning keeps every call/result pair intact and gets under budget")
  arrange: 手搓 messages：user → assistant(2 calls) → toolResult(8000 字) ×2
                          → assistant(1 call) → toolResult(8000 字) → assistant("final")
  act:   const out = pruneToolResults(msgs, 500)
  assert: out.length === msgs.length                                  // 一条都没删，只截内容
          out.filter(m => m.role==="toolResult").length === 3          // 配对完整
          totalTokens(out) <= 500 或 <= totalTokens(msgs)              // 确实变小了
          out.at(-2)/out.at(-1) 属于最近 2 个 assistant 的保护窗口 → 内容未变
          被截的那条 content[0].text 匹配 /truncated by context pruning: \d+ tokens/

it("pruning is idempotent and monotonic")
  assert: pruneToolResults(pruneToolResults(m, 500), 500) 与一次的结果深相等

it("hysteresis: a transcript already under budget is returned by reference, untouched")
  assert: pruneToolResults(m, 1_000_000) === m                        // 同一个对象引用

it("tool results smaller than 64 tokens are never truncated")

it("skill outputs are protected from cheap pruning")                  // it.todo，skills 未实现
```

摘要级（`it.todo` / `it.fails`，钉契约）：

```
it("summary compaction writes a contextCompaction item and leads the next transcript")
  assert: 存在 contextCompaction item（replacesUpToSeq = 压缩点）
          session.metadata.lastCompactionSeq === 该 item 的 seq
          发射了 session/compacted{itemId}
          下一 turn 的 engine.received[n].history[0] === {role:"system", text:/Summary of the earlier/}
          且 history 里不含 seq <= replacesUpToSeq 的任何原始消息
          （这条同时覆盖 history.ts:63-66 与 host.ts:734-736）

it("the compaction cut point is tool-pairing balanced")
  // 移植 PoC src/context/tool-pairing.ts（86 行）+ test/tool-pairing.test.ts（19 条）
  assert: 切点处 Σ(assistant 的 toolCall 数) - Σ(toolResult 数) === 0；累积和为负要 throw 不要静默

it("compaction counts cache.read + cache.write toward context occupancy")
  arrange: 一个 step 的 usage = {inputTokens: 100, cacheReadTokens: 30_000, cacheWriteTokens: 2_000}
  assert: 触发压缩（当前实现不会，因为只看 estimateTokens 的字符数）

it("compaction is transactional: if the surface changed, the summary is discarded")
  arrange: 压缩进行中 contextEpoch 变了（工具目录变更）
  assert: 摘要不落库；改为在对话尾追加 systemNotice{kind:"toolsChanged"}（覆盖 history.ts:89-91）

it("compaction never makes the transcript longer (shrink comparison)")
```

---

## 4. 缺失的测试类型与建设方案

先给目录布局，后面逐项展开。新增一个 workspace 包 `packages/testkit`（design §10 的 monorepo 图里已经预留了这个包，说明"假厂商（deepseek/dashscope 方言）、假 MCP server、契约测试"）。

```
agent-service/
├── .github/workflows/ci.yml                        ← 新增（§4.5）
├── packages/testkit/                               ← 新增包
│   ├── package.json                                  name: @agent-service/testkit
│   └── src/
│       ├── index.ts
│       ├── fake-vendor.ts                          ← 从 PoC 移植（§4.2）
│       ├── probe-vendor.ts                         ← 从 PoC 移植，nightly 用
│       ├── runner-process.ts                       ← 多进程 spawn/health/kill（§4.1）
│       ├── sse-client.ts                           ← 真 socket 的 SSE 读取器
│       ├── cluster.ts                              ← 起 N 个 runner + 清库
│       └── gen.ts                                  ← property 测试的 item 流生成器（§4.3）
├── packages/core/test/
│   ├── fixture.ts                                  ← 新增（从 host.test.ts 抽出）
│   ├── fake-engine.ts                              ← 增强（+4 字段）
│   ├── host.test.ts                                ← 现有 16 条
│   ├── history.test.ts                             ← 新增：坑 #1 #4 #8(便宜级)
│   ├── recovery.test.ts                            ← 新增：坑 #4
│   ├── truncation.test.ts                          ← 新增：坑 #2
│   ├── concurrency.test.ts                         ← 新增：坑 #6
│   ├── cancellation.test.ts                        ← 新增：坑 #7
│   ├── prefix.test.ts                              ← 新增：前缀 sha256 回归（design §6.2/§11）
│   ├── lifecycle.test.ts                           ← 新增：drain / 续期失败 / FenceError
│   ├── tools.test.ts                               ← 新增：SSRF + web_fetch + dynamic tool
│   └── invariants.prop.test.ts                     ← 新增：property/fuzz（§4.3）
├── packages/providers/test/
│   ├── dialect.test.ts                             ← 新增：假厂商方言 8 条（§4.2）
│   └── e2e-qwen.test.ts                            ← 现有
├── apps/agent-runner/test/
│   ├── http.test.ts                                ← 现有 5 条，补端点
│   └── sse-socket.test.ts                          ← 新增：真 socket SSE（断开/心跳/Last-Event-ID）
├── test/cluster/                                   ← 新增：多进程 E2E（§4.1）
│   ├── takeover.test.ts                              M2 验收主项
│   ├── drain.test.ts                                 SIGTERM step 边界 checkpoint
│   └── fence.test.ts                                 10 并发 writer / 旧 fence 被拒
└── test/load/                                      ← 新增：压测 smoke（§4.4）
    └── concurrent-turns.ts                           不是 vitest，独立脚本
```

`vitest.config.ts` 改成 projects（vitest 4），让三类测试可以分开跑、超时不同、cluster 不并行：

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
          testTimeout: 30_000, hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: "cluster",
          include: ["test/cluster/**/*.test.ts"],
          // 多进程 + 共享 MySQL/Redis：串行跑，超时放宽
          fileParallelism: false,
          testTimeout: 120_000, hookTimeout: 120_000,
          // 没有 AGENT_SERVICE_CLUSTER 时整个 project 跳过（由 globalSetup 里 process.exit 或
          // 每个文件顶部 describe.skipIf(!process.env.AGENT_SERVICE_CLUSTER) 控制）
        },
      },
    ],
  },
});
```

`package.json` scripts：

```json
"test": "vitest run --project unit",
"test:int": "AGENT_SERVICE_INTEGRATION=1 vitest run --project unit",
"test:cluster": "AGENT_SERVICE_CLUSTER=1 AGENT_SERVICE_INTEGRATION=1 vitest run --project cluster",
"test:cov": "AGENT_SERVICE_INTEGRATION=1 vitest run --project unit --coverage",
"fake-vendor": "tsx packages/testkit/src/fake-vendor.ts",
"probe": "tsx packages/testkit/src/probe-vendor.ts",
"load": "tsx test/load/concurrent-turns.ts"
```

---

### 4.1 多进程 E2E（M2 的验收标准）

**要证明的**（design §11 M2 行，逐字）：
> 3 runner + 1 router 共享 MySQL/Redis，turn 中 kill 租约持有者：**另一 runner 接管、事件无空洞、客户端补齐**；10 并发 writer 只 1 成功；旧 fence 写入被 DB 拒绝

router 还没写，所以第一版 harness 起 **3 个 runner，不起 router**，客户端自己做"409 → 换一个 runner 重试一次"的重路由（这正是 router 将来要做的事，等 router 落地后把客户端换成 router 即可，测试断言不变）。

#### harness 放在哪、长什么样

**`packages/testkit/src/runner-process.ts`**

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

export interface RunnerHandle {
  id: string;
  port: number;
  base: string;                 // http://127.0.0.1:<port>
  pid: number;
  proc: ChildProcess;
  logs: string[];               // stdout+stderr 累积，失败时打出来
  kill9(): void;                // 模拟崩溃：SIGKILL，不给任何清理机会
  sigterm(): Promise<void>;     // 模拟优雅下线：SIGTERM，等进程退出
  waitExit(ms?: number): Promise<number | null>;
}

const TSX = new URL("../../../node_modules/.bin/tsx", import.meta.url).pathname;
const MAIN = new URL("../../../apps/agent-runner/src/main.ts", import.meta.url).pathname;

/**
 * 起一个真正的 runner 进程。
 * 必须用 tsx：workspace 包的 exports 指向 src/*.ts，`node` 解析不了（见 docs/review §1.3）。
 * 环境变量走 env 而不是 --env-file，因为每个 runner 的 RUNNER_ID/PORT 都不同；
 * 需要 --env-file 语义时写一个临时 .env 到 os.tmpdir() 再传 `--env-file=<path>`。
 */
export async function startRunnerProcess(env: Record<string, string>, opts: { readyTimeoutMs?: number } = {}): Promise<RunnerHandle> {
  const proc = spawn(TSX, [MAIN], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  const logs: string[] = [];
  proc.stdout!.on("data", (b) => logs.push(String(b)));
  proc.stderr!.on("data", (b) => logs.push(String(b)));

  const port = Number(env.RUNNER_PORT);
  const base = `http://127.0.0.1:${port}`;
  // health-poll：/healthz 返回 "ok" 且 /readyz 返回 "ready"
  const deadline = Date.now() + (opts.readyTimeoutMs ?? 30_000);
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`runner ${env.RUNNER_ID} exited early:\n${logs.join("")}`);
    try {
      if ((await fetch(`${base}/healthz`)).ok && (await fetch(`${base}/readyz`)).ok) break;
    } catch { /* 还没监听 */ }
    if (Date.now() > deadline) throw new Error(`runner ${env.RUNNER_ID} not ready:\n${logs.join("")}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    id: env.RUNNER_ID!, port, base, pid: proc.pid!, proc, logs,
    kill9: () => proc.kill("SIGKILL"),
    sigterm: async () => { proc.kill("SIGTERM"); await once(proc, "exit"); },
    waitExit: async (ms = 40_000) => {
      if (proc.exitCode !== null) return proc.exitCode;
      const t = setTimeout(() => proc.kill("SIGKILL"), ms);
      const [code] = await once(proc, "exit"); clearTimeout(t); return code;
    },
  };
}
```

**`packages/testkit/src/cluster.ts`**

```ts
export interface Cluster {
  runners: RunnerHandle[];
  mysqlUrl: string; redisUrl: string;
  apiKey: string; tenantId: string;
  vendor: FakeVendor;                     // §4.2
  /** 按顺序试每个 runner，409 时换下一个（这就是 router 的重路由，只是放在客户端） */
  call(path: string, init?: RequestInit, opts?: { prefer?: number }): Promise<Response>;
  stop(): Promise<void>;
}

export async function startCluster(n = 3): Promise<Cluster> {
  const mysqlUrl = process.env.MYSQL_CLUSTER_URL ?? "mysql://root@127.0.0.1:3306/agent_service_cluster";
  const redisUrl = process.env.REDIS_CLUSTER_URL ?? "redis://127.0.0.1:6379/3";
  // 1. 清库：DROP/CREATE DATABASE agent_service_cluster；redis -n 3 FLUSHDB
  //    （MysqlSessionStore.connect 会自动跑 packages/store/migrations）
  // 2. 起假厂商，拿到 baseUrl
  // 3. 起 n 个 runner：
  //    STORE=mysql MYSQL_URL=... REDIS_URL=...
  //    RUNNER_ID=r{i} RUNNER_PORT=1880{i} RUNNER_ADDR=127.0.0.1:1880{i}
  //    LEASE_TTL_MS=3000 LEASE_HOLD_MS=500 SSE_HEARTBEAT_MS=1000
  //    PLATFORM_PROVIDER=dashscope API_BASE_URL=<fakeVendor.url> API_KEY=sk-fake
  //    DEFAULT_MODEL=fake-1 BOOTSTRAP_API_KEY=<redacted> BOOTSTRAP_TENANT_ID=t_cluster
  //    SECRETS_MASTER_KEY=<64 hex>
  //    ↑ LEASE_TTL_MS 调小到 3s 是关键：否则测试要等 30s 才能看到接管
}
```

**`packages/testkit/src/sse-client.ts`** —— 真 socket SSE 读取（现有 `http.test.ts` 的 `parseSse` 是一次性读全文，不能中途断开）：

```ts
export interface SseReader {
  events: { id?: number; type: string; data: any }[];
  lastId(): number | undefined;
  waitFor(pred: (e: {type:string; data:any}) => boolean, ms?: number): Promise<any>;
  abort(): void;               // 模拟客户端断开（不等于取消 turn）
  closed: Promise<void>;
}
export function readSse(url: string, init: RequestInit): SseReader;   // 用 fetch + ReadableStream，按 \n\n 分帧
```

#### `test/cluster/takeover.test.ts` — M2 验收主项

```
describe.skipIf(!process.env.AGENT_SERVICE_CLUSTER)("cluster: kill the lease holder mid-turn")

beforeAll: cluster = await startCluster(3)
afterAll:  await cluster.stop()

it("another runner takes over, events have no gaps, and ?after= fills the hole", async () => {
  // ---- arrange ----
  // 1. 在 r1 上建 agent（工具 slow_probe 由假厂商驱动：假厂商第 1 步返回一个 tool_call，
  //    工具 execute 里 sleep 3000ms，保证 kill 时 turn 正在 tool 执行中）
  const agent   = await post(r1, "/v1/agents", { name:"cluster", instructions:"X",
                    model:{provider:"dashscope", model:"fake-1"}, tools:["slow_probe"], limits:{maxSteps:4} });
  const session = await post(r1, "/v1/sessions", { agentId: agent.id });

  // 2. 客户端 A 用真 socket 订阅流式 turn
  const A = readSse(`${r1.base}/v1/sessions/${session.id}/turns`,
                    { method:"POST", headers:H, body: JSON.stringify({input:[{type:"text",text:"go"}]}) });
  await A.waitFor(e => e.type === "item/started" && e.data.item.type === "toolCall");
  const seqBeforeKill = A.lastId()!;                 // ← 空洞的左边界
  expect(seqBeforeKill).toBeGreaterThan(0);

  // 3. 确认租约在 r1（Redis owner 目录）
  expect(await redisHget(`as:lease:{${session.id}}`, "owner")).toBe("r1");
  const fenceBefore = Number(await redisHget(`as:lease:{${session.id}}`, "fence"));

  // ---- act：硬杀 ----
  r1.kill9();
  await r1.waitExit();
  // 客户端 A 的连接断了（这就是"空洞"产生的地方）
  await A.closed;

  // ---- assert 1：租约过期前，别的 runner 抢不到 ----
  const early = await post(r2, `/v1/sessions/${session.id}/turns`, {input:[{type:"text",text:"继续"}]}, { raw:true });
  expect(early.status).toBe(409);
  const earlyBody = await early.json();
  expect(earlyBody.error.code).toBe("session_lease_conflict");
  // app.ts 的 onError 专门为此设了 X-Owner 并抹掉了 body 里的 details（供 router 重路由，
  // 同时不向外部客户端泄漏内部拓扑）—— 两边都要断言：
  expect(early.headers.get("x-owner")).toContain(String(r1.port));
  expect(earlyBody.error.details).toBeUndefined();

  // ---- assert 2：LEASE_TTL_MS(3s) 后 r2 接管 ----
  await sleep(3500);
  const B = readSse(`${r2.base}/v1/sessions/${session.id}/turns`,
                    { method:"POST", headers:H, body: JSON.stringify({input:[{type:"text",text:"继续"}]}) });
  const doneB = await B.waitFor(e => e.type === "turn/completed", 60_000);
  expect(doneB.turn.status).toBe("completed");

  // fence 单调 +1
  expect(Number(await redisHget(`as:lease:{${session.id}}`, "fence"))).toBeGreaterThan(fenceBefore);
  expect(Number(await mysqlScalar(`SELECT fence_token FROM sessions WHERE session_id=?`, session.id)))
    .toBeGreaterThan(fenceBefore);

  // 孤儿 turn 被结算，不是永远 inProgress
  const turns = (await get(r2, `/v1/sessions/${session.id}/turns`)).data;
  expect(turns.filter(t => t.status === "inProgress")).toHaveLength(0);
  const orphan = turns.find(t => t.stopReason === "interrupted");
  expect(orphan.error.code).toBe("owner_lost");

  // ---- assert 3：事件无空洞，?after= 把洞补齐（从第三个 runner 读，证明与所有权无关）----
  const C = readSse(`${r3.base}/v1/sessions/${session.id}/events?after=${seqBeforeKill}`, { headers:H });
  await C.waitFor(e => e.type === "turn/completed");
  const seqs = C.events.filter(e => e.id !== undefined).map(e => e.id!);
  expect(seqs[0]).toBe(seqBeforeKill + 1);                       // 洞的左端严格接上
  expect(seqs).toEqual([...new Set(seqs)]);                       // 无重复
  expect(seqs).toEqual(seqs.slice().sort((a,b)=>a-b));            // 单调
  expect(seqs).toEqual(range(seqBeforeKill+1, seqs.at(-1)!));     // 无空洞（逐个 +1）
  expect(seqs.at(-1)).toBe(Number(await mysqlScalar(
    `SELECT last_seq FROM sessions WHERE session_id=?`, session.id)));   // 一直补到库里的最后一条
  expect(C.events.map(e => e.type)).not.toContain("item/agentMessage/delta");  // delta 不重放

  // ---- assert 4：write-ahead 证据 + 恢复码 ----
  const items = (await get(r3, `/v1/sessions/${session.id}/items`)).data;
  const orphanCall = items.find(i => i.type === "toolCall" && i.turnId === orphan.id);
  expect(orphanCall).toBeTruthy();                 // 被杀之前就落库了
  expect(orphanCall.startedAtMs).toBeTruthy();     // 且标记了"已开始执行"
  const proj = projectItems(items);
  expect(proj.repaired).toEqual([{ toolCallId: orphanCall.toolCallId, code: "TOOL_OUTCOME_UNKNOWN" }]);
  // 每个 toolCall 恰好一条 toolResult（合成的也算）
  assertOneResultPerCall(proj.messages);

  // ---- assert 5：旧 fence 写入被 DB 拒绝 ----
  const store = await MysqlSessionStore.connect({ url: cluster.mysqlUrl });
  await expect(store.commit({ sessionId: session.id, fence: fenceBefore,
    events: [{ type:"session/created", sessionId: session.id, emittedAtMs: Date.now() }] }))
    .rejects.toBeInstanceOf(FenceError);
});
```

#### `test/cluster/fence.test.ts`

```
it("10 concurrent turn requests across 3 runners: exactly one succeeds")
  act:   await Promise.allSettled(range(10).map(i =>
           post(runners[i % 3], `/v1/sessions/${sid}/turns`, {input:[...]}, {raw:true})))
  assert: 2xx 恰好 1 个；其余全是 409 session_lease_conflict（**不能有 500，不能有第二个 turn**）
          (await listTurns(sid)).data.length === 1
          (await listItems(sid)).filter(i => i.type==="userMessage").length === 1
          MySQL 里 events 的 seq 连续（SELECT seq ... ORDER BY seq → 1..n 无空洞）

it("SSE client disconnect is NOT cancellation: the turn keeps running and ?after= catches up")
  act:   A.abort() 在第一个 item/started 之后
  assert: 稍后 GET /events?after=<A.lastId()> 能读到 turn/completed{status:"completed"}
          turn.stopReason === "end_turn"（不是 interrupted）
```

#### `test/cluster/drain.test.ts`

```
it("SIGTERM drains at a step boundary: items are checkpointed, the lease is released, readyz flips first")
  arrange: 假厂商脚本 = 3 步，每步一个工具；turn 跑到第 2 步时发 SIGTERM
  act:   r2.sigterm()
  assert: 期间 GET /readyz → 503（先摘流量再收工，design §4.3 drain 行）
          进程在 30s 内退出，退出码 0
          最后一个完成的 step 的所有 items 都在 MySQL 里（checkpoint）
          turn 最终 status ∈ {completed, interrupted}，绝不是 inProgress
          Redis 里 as:lease:{sid} 已被删（release 成功）
          换到 r3 立刻能 startTurn（不用等 TTL）→ 证明租约真的释放了
```

**为什么这些必须在写 M2 代码之前先有 harness 骨架**：M2 的正确性（重路由、drain、owner 目录）是"只能靠杀进程验证"的一类性质，事后补测试的成本远高于事前。骨架（`runner-process.ts` + `cluster.ts` + `sse-client.ts`）大约 250 行，一次投入，router 落地后只改 `cluster.call` 的实现。

---

### 4.2 假厂商（本地 OpenAI 兼容 SSE 服务，复刻国内方言）

**为什么是 P0**：
1. M1 验收表把"假厂商"列为交付物，实际没交付；
2. `packages/core/src/engine/pi.ts` 现在 **0% 覆盖** ——CI 里 PiEngine 一行都不跑；
3. SSE 解析已经**外包给了 pi → `openai` SDK 6.40.0**，我们唯一能做的就是用假厂商做**契约测试**，把 pi 升级导致的方言回归挡住（design §12 的头号风险"pi 每版 Breaking"对策就是"契约测试驱动升级"）；
4. 多进程 cluster 测试也需要一个不花钱、可编排、可延时的模型端点。

#### 从 PoC 移植什么（已读源码）

源文件：`/Users/zhangguoqiang/Desktop/meetyou/agent-runtime-方案/poc/agent-runtime/src/scripts/`

| PoC 文件 | 行数 | 移植目标 | 怎么改 |
|---|---|---|---|
| `fake-vendor.ts` | 90 | `packages/testkit/src/fake-vendor.ts` | **保留整个骨架**：`startFakeVendor(port=0)` 返回 `{url, requests[], close()}`；`requests.push({auth, body})` 是断言 BYOK key 注入 / `max_tokens` 字段名 / tools 排序 / **前缀 byte 稳定性**的唯一手段，必须保留。**保留 DeepSeek 方言**：`reasoning_content` delta、`tool_calls.arguments` 切 4 片（`{"qu` / `ery":"…` / …）、`usage.prompt_cache_hit_tokens` + `prompt_cache_miss_tokens`、开头的 `: keep-alive\n\n` 注释行、结尾 `data: [DONE]`。**要改的**：① 把"按 assistant 消息数推 step"的硬编码脚本换成可注入的 `script: FakeStep[]`（见下）；② 去掉产品化的工具名 `search_records` 和中文业务文案；③ `res.writeHead` 里补 `'x-accel-buffering': 'no'`；④ 支持 `?delayMs=` / 每片之间的延时，cluster 测试要靠它把 turn 拖长到能被 kill。 |
| `fake-dashscope.mjs` | 70 | 合并进同一个文件，作为 `dialect: "dashscope"` | **保留**：`usage.prompt_tokens_details.cached_tokens`（和 DeepSeek 不同的拼法）、`tool_calls` 切 **5** 片且 **id 只在首片出现**、`: keep-alive` 注释行、**隐式缓存模拟**（按 system 前缀内容哈希计数，第 2 次起且前缀 ≥1024 token 才报 cached）。最后这条是**唯一能在 CI 里验证 `prompt_cache_hit_ratio` 的办法**，而 design §9 说它是"头号成本指标"。 |
| `probe-vendor.ts` | 343 | `packages/testkit/src/probe-vendor.ts`（`pnpm probe`，**不进 CI**，nightly + 接新厂商时手动跑） | 保留 check 清单与 `buildPad(tokens)`（探真实厂商的隐式缓存门槛）。改：输出改成 JSON + 人类可读两份，便于 nightly 归档。 |
| `verify-real-http.ts` | 7.3KB | **不整体移植** | 它的价值是"走真 socket 而不是注入 fetch"。在新仓库里用更自然的方式达成：`packages/providers/test/dialect.test.ts` 里把 tenant BYOK 的 `baseUrl` 指向假厂商 → 请求真的过 socket，但不出机器。 |
| `test/helpers.ts` | 9.3KB | 部分移植 | `sseStream()` 异步生成器 → `packages/testkit/src/sse-client.ts`；`ScriptedProvider` 不要（我们用 `ScriptedEngine` + 假厂商两层）；`makeHost()` 的思路已由 `packages/core/test/fixture.ts` 承担。 |

#### 新的可编排接口

```ts
// packages/testkit/src/fake-vendor.ts
export type FakeStep =
  | { kind: "text"; chunks: string[]; reasoning?: string[]; finish?: "stop" | "length" }
  | { kind: "toolCall"; name: string; argsJson: string; splitInto?: number;   // 默认 4~5 片
      idOnFirstChunkOnly?: boolean; reasoning?: string[]; finish?: "tool_calls" | "length" }
  | { kind: "httpError"; status: 429 | 500 | 502 | 400; body?: unknown; retryAfter?: number }
  | { kind: "malformed"; lines: string[] }          // 非 JSON 行 / 空 data / \r\n / 缺 finish_reason
  | { kind: "hang"; ms: number };                   // 首 chunk 前挂住，测超时/取消

export interface FakeVendorOptions {
  dialect?: "deepseek" | "dashscope";               // 决定 usage 字段拼法与分片数
  script: FakeStep[] | ((req: { step: number; body: any }) => FakeStep);
  keepAliveComment?: boolean;                        // 默认 true
  emitDone?: boolean;                                // 默认 true（false 用来测"流没收尾"）
  implicitCache?: boolean;                           // 默认 true，复刻 dashscope 的前缀缓存计数
  perChunkDelayMs?: number;
}

export interface FakeVendor {
  url: string;                                       // http://127.0.0.1:<port>/v1
  requests: { auth?: string; body: any; at: number }[];
  /** 同一 system 前缀被请求过几次（断言前缀稳定性用） */
  prefixHits: Map<string, number>;
  close(): Promise<void>;
}
export function startFakeVendor(opts: FakeVendorOptions): Promise<FakeVendor>;
```

#### 它解锁的测试 — `packages/providers/test/dialect.test.ts`

全部通过 `ProviderService.upsertTenantProvider` 把 `baseUrl` 指向假厂商，再用 `PiEngine` + `SessionHost` 跑真 turn（这条链路目前在 CI 里完全是黑的）：

```
it("deepseek dialect: reasoning_content becomes a reasoning item and prompt_cache_hit_tokens becomes cacheReadTokens")
  assert: items.some(i => i.type === "reasoning" && i.text === "…")
          events.some(e => e.type === "item/reasoning/delta")        // 覆盖 host.ts:382-384
          turn.usage.cacheReadTokens === 1792
          turn.usage.inputTokens === 2100 - 1792                     // pi 的口径：input = prompt - cacheRead - cacheWrite
          turn.usage.costCNY > 0 且按 price.cacheRead 折算

it("dashscope dialect: prompt_tokens_details.cached_tokens becomes cacheReadTokens")

it("tool_calls arguments split across 5 chunks with the id only on the first chunk are reassembled")
  assert: items.find(i => i.type==="toolCall").args deep-equals {query:"…", timeRange:"last_7d"}
          const ad = events.filter(e => e.type === "item/toolCall/argsDelta");
          ad.length >= 5                                        // 覆盖 host.ts 的 onToolArgsDelta
          new Set(ad.map(e => e.toolCallId)) === {"call_abc123"} // id 只在首片给出，后续片也要正确归属
          ad.map(e => e.delta).join("") === '{"query":"…","timeRange":"last_7d"}'  // 拼接无损

it("`: keep-alive` comment lines, empty data lines, CRLF separators and non-JSON lines are tolerated")
  arrange: { kind:"malformed", lines:[": keep-alive", "data: ", "data: not-json", "\r\n"] } 后接正常 text
  assert: turn 正常 completed，文本完整

it("finish_reason=length mid tool_call: zero tools execute, all calls fail, the turn still completes")
  ↑ 这是坑 #2 在真实 SSE 路径上的版本（ScriptedEngine 版见 §3 #2）

it("a stream that ends without finish_reason fails the turn cleanly (no hang)")
  note: pi 在这种情况会 throw "Stream ended without finish_reason"
  assert: turn.status === "failed"; turn.error.code === "provider_error"
          events.some(e => e.type === "error")；session 回到 idle（不能卡在 active）

it("HTTP 429/5xx before the first chunk is retried/failed with a typed error; after the first chunk it is NEVER retried")
  arrange: script 先吐 2 个 chunk 再断开
  assert: 客户端看到的文本没有重复段（这是 PoC resilient.ts 的关键决策）
          turn.status === "failed"

it("the BYOK key reaches the vendor and never leaks across tenants")
  assert: vendor.requests.every(r => r.auth === "Bearer sk-tenant-a")
          t_b 的 turn 的请求 auth === "Bearer sk-tenant-b"
          没有任何请求带 platform key

it("prefix stability: three turns send a byte-identical system message and the vendor reports a cache hit from #2")
  assert: new Set(vendor.requests.map(r => JSON.stringify(r.body.messages[0]))).size === 1
          new Set(vendor.requests.map(r => JSON.stringify(r.body.tools))).size === 1
          vendor.requests[1].body 对应的响应 usage cached_tokens > 0
          // 这条同时兑现 design §6.2 "CI 里跑前缀 sha256 回归测试" 和 §11 M1 "前缀 sha256 三请求一致"

it("provider fallback chain")   // it.todo：ProviderConfig.fallback 是 schema-only，未实现（M4）
it("per-tenant quota / circuit breaker")  // it.todo：ProviderConfig.quota 同上（M4）
```

已核对的 pi 0.87 能力边界（决定哪些断言现在就会绿、哪些要先改代码）：
- pi **已支持** `reasoning_content` / `reasoning` / `reasoning_text`（`openai-completions.js:399`）、`prompt_tokens_details.cached_tokens` / `prompt_cache_hit_tokens` / 顶层 `cached_tokens`（:1160）、`finish_reason=length → 丢弃全部 tool call`（`agent-loop.js:159-166`）；SSE 分帧由官方 `openai` SDK 处理，注释行/`[DONE]`/CRLF 都能容。
- pi **不支持** `input_tokens_details.cached_tokens`（部分自建网关）、`cache_write_tokens` 之外的写缓存拼法；`<think>…</think>` 形态的思维链在 openai-completions 通道里**没有**拆分逻辑（PoC 的 `splitThink` 没有对应物）；**流没有 `finish_reason` 会直接 throw**。这三条要么写进"不支持"文档，要么在 `packages/providers` 里加一层 `fetch` 包装做规范化——两种选择都需要先有假厂商才能验证。

---

### 4.3 property / fuzz 测试

用 `fast-check`（加为根 devDependency）。放 `packages/core/test/invariants.prop.test.ts`，每条 200~500 次 run，种子固定（`fc.configureGlobal({ seed: 42, numRuns: 300 })`）加 `--fc-seed` 覆盖，失败时打印最小反例。

**生成器**（`packages/testkit/src/gen.ts`）：随机合法 item 流。

```ts
/** 随机生成一个 session 的 items：多 turn、多 step、随机 toolCall 数、随机缺失 toolResult、
 *  随机插入 steer 的 userMessage / systemNotice / contextCompaction，seq 单调递增。 */
export const arbItemStream: fc.Arbitrary<Item[]>;
/** 随机的 TranscriptMessage[]（合法：user/assistant/toolResult 交替，配对完整） */
export const arbTranscript: fc.Arbitrary<TranscriptMessage[]>;
```

**不变量清单**（这些正是最容易被重构悄悄破坏的）：

```
prop("projectItems: every toolCall is followed by exactly one toolResult with the same id")
  ∀ items: const {messages} = projectItems(items)
    对每条 assistant 消息 m，紧随其后的 k = m.toolCalls.length 条消息必须全是 role==="toolResult"，
    且它们的 toolCallId 序列 === m.toolCalls.map(c => c.id)（**顺序也要一致** → 同时守住坑 #6）

prop("projectItems: no assistant → assistant adjacency")
  ∀ items: messages 里不存在相邻的两条 role==="assistant"
  （现在靠 stepKey=`${turnId}#${step}` 分组 + steer 会插入 userMessage 来保证，很脆）

prop("projectItems: no toolResult without a preceding toolCall of the same id")

prop("projectItems is deterministic and input-order independent")
  ∀ items: projectItems(items) deep-equals projectItems(shuffle(items))
  （实现里第一行就 sort by seq then id —— 这条是为它兜底）

prop("projectItems is idempotent under re-projection of its own output")   // 需要 messages→items 的逆，可跳过

prop("pruneToolResults never breaks pairing and never grows the transcript")
  ∀ (msgs, budget): const out = pruneToolResults(msgs, budget)
    out.length === msgs.length
    out 的 role 序列 === msgs 的 role 序列（一条都不删）
    out 的 toolCallId 序列 === msgs 的
    totalTokens(out) <= totalTokens(msgs)
    budget >= totalTokens(msgs) ⇒ out === msgs（同引用）

prop("seq monotonicity: a random sequence of commits yields 1..n with no gaps and no duplicates")
  ∀ batches (随机切分 events/items/turn/approvals 到若干 commit):
    store.commit 逐个执行后 readEvents(sid,0,∞).map(e=>e.seq) === [1..n]
    且 session.lastSeq === n；且 items 的 seq 全部 > 0（assignItemSeqs 的后置条件）
  → 同时对 MemorySessionStore 和 MysqlSessionStore 跑（塞进 conformance）

prop("assignItemSeqs: an item carried by an item/started or item/completed event gets that event's seq")

prop("uuidv7 is strictly increasing within a process, even across millisecond boundaries")
  ∀ n in [1, 10_000]: range(n).map(() => newId("item")) 严格升序（字典序）
  （ids.ts:12 的 counter 溢出借位分支现在未覆盖，这条能点亮它）

prop("mergeLimits is the pointwise min and is order-insensitive")
  ∀ layers: mergeLimits(...layers) === mergeLimits(...shuffle(layers))
    且每个字段 === min(所有提供了该字段的层, 默认值)

prop("estimateTokens is monotonic under concatenation")
  ∀ a,b: estimateTokens(a+b) >= max(estimateTokens(a), estimateTokens(b))

prop("stableStringify is order-insensitive over object keys and injective enough for hashing")
  ∀ obj: stableStringify(obj) === stableStringify(reorderKeys(obj))
  ∀ a≠b (结构不同): sha256(stableStringify(a)) !== sha256(stableStringify(b))
```

**再加一条压力型 fuzz（不是 property，但同一批做）**：`host.test.ts` 那条 "concurrent startTurn on the SAME runner must not create two turns" 目前是**时序脆弱**的——`startTurn` 在 `this.active.set()` 之前有多个 `await`（`getSession` / `getAgent` / `lease.acquire` / `providers.resolve` / `listItems`），两个并发调用完全可能都通过 `this.active.get(sessionId)` 的检查。测试现在通过只是因为 memory store 的 await 太快。

```
it("10 concurrent startTurn with randomised await jitter still creates exactly one turn", async () => {
  // 用一个 store 包装器，在每个方法前插入 0~5ms 随机延时
  const jittery = withJitter(new MemorySessionStore(), 5);
  for (let seed = 0; seed < 50; seed++) {          // 50 轮，固定种子
    const results = await Promise.allSettled(range(10).map(i => host.startTurn(...)));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((await store.listTurns(sid,{limit:20})).data).toHaveLength(1);
    expect(items.filter(i => i.type === "userMessage")).toHaveLength(1);
  }
})
```
我的判断：**这条会 fail**。修法是在 `startTurn` 入口用一个同步的 `Set<sessionId>` 占位（在任何 await 之前 `if (!this.starting.add(sid)) throw session_busy`），`finally` 里删掉。这是 M2 之前必须修的，因为 router 的重路由会让同一 session 的两个请求更容易落到同一个 runner。

---

### 4.4 压测 smoke

**不用 vitest**（断言不稳定、CI 会 flaky），做成独立脚本 `test/load/concurrent-turns.ts`，`pnpm load` 手动跑 + nightly 归档，**数字回填 design §9**。

**要测什么**：单个 runner 进程在 N 并发 turn 下的上限。design §9 的关键假设是 **1,000 turn/进程 → 250 个轻池进程**，这个数字现在纯纸面；M4 验收要"单 runner 1,000 并发 turn 压测报告"。

**怎么测**：
- 模型端用**假厂商**（`perChunkDelayMs` 调成让每个 turn 约 90s，复刻 design §9 的 `90s/turn` 假设），不打真实厂商——我们测的是 runner 的进程资源曲线，不是厂商延迟。
- store 用 MySQL + Redis（内存 store 会掩盖真正的瓶颈）。
- 阶梯加压：`N ∈ {50, 100, 250, 500, 1000, 2000}`，每档跑 3 分钟，档间静置 30s。

**要测的指标**（每档一行 CSV，落 `test/load/results/<date>.csv`）：

| 指标 | 怎么采 | 为什么 |
|---|---|---|
| `turns_per_proc` | 成功 completed 的并发 turn 峰值 | **直接喂 design §9 的"1,000 turn/进程"**，决定 250 个进程这个数是不是要改 |
| `rss_mb` / `heapUsed_mb` | runner 进程内 `process.memoryUsage()`，每 5s 采一次，取 p99 | 每 turn 的常驻内存 × 1000 是进程规格的下限；`ActiveTurn` 里有 `toolCallItems` Map、`chain` Promise 链、`agentText` 字符串累积，都会随 turn 长度增长 |
| `ttft_ms` p50 / p99 | 客户端从 POST /turns 到收到第一条 `item/agentMessage/delta` | design §6.2 的 `agentrt_ttft_ms`；p99 劣化点就是进程上限 |
| `turn_duration_ms` p50/p99 | turn/started → turn/completed | |
| `fd_count` | `lsof -p <pid> \| wc -l` 或 `/proc` | 每个 turn = 1 个上游 HTTP 连接 + 1 个 SSE 下游 + MySQL/Redis 连接池；fd 是轻池的第二个天花板（research 02 §1.2(a) 明确提到 runner 的 fd 曲线和 router 不同） |
| `event_loop_lag_ms` p99 | `perf_hooks.monitorEventLoopDelay()` | SSE 扇出 + JSON.stringify 是单线程的，lag > 100ms 就说明该分进程了 |
| `mysql_commit_ms` p99 | store 里打点（或 `performance.now()` 包 `commit`） | design §9 说里程碑事件 6 亿/天；单 session 的 `SELECT … FOR UPDATE` 是串行点 |
| `redis_xadd_ms` p99 + `stream_msg_per_s` | bus 里打点 | design §9 的"Stream 峰值 15–30 万 msg/s → 分片"阈值 |
| `prompt_cache_hit_ratio` | 从假厂商的 `cached_tokens` 累加 | design §9 的"头号成本指标"；压测顺便验证高并发下前缀没被打乱 |
| `errors_by_code` | 客户端统计 | 到达上限时应该是优雅的 `session_busy`/`draining`，**不是 500 或挂死** |

**回填到哪**：
- `turns_per_proc` + `rss_mb` → design §9 的"轻池 runner 进程 @1,000 turn/进程 → ~250"这一行，附实测脚注；
- `stream_msg_per_s` → §9 的"Redis Stream 峰值 15–30 万 msg/s → 分片"的阈值校准；
- `ttft_ms` p99 → §6.2 指标清单的 SLO 基线；
- 若 `turns_per_proc` 显著低于 1,000，§9 的容量表、成本表和 M4 的 k8s 规格都要一起改，所以这个数字**越早有越好**（虽然验收在 M4，建议 M2 结束时就跑一次 baseline）。

---

### 4.5 CI 接线（GitHub Actions）

`.github/workflows/ci.yml`：

```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

env:
  # 显式不给真实厂商 key：e2e-qwen.test.ts 的 describe.skipIf(!API_KEY) 会跳过
  API_KEY: ""
  MYSQL_TEST_URL: mysql://root@127.0.0.1:3306/agent_service_test
  REDIS_TEST_URL: redis://127.0.0.1:6379/1
  MYSQL_CLUSTER_URL: mysql://root@127.0.0.1:3306/agent_service_cluster
  REDIS_CLUSTER_URL: redis://127.0.0.1:6379/3

jobs:
  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with: { node-version: '24', cache: 'pnpm' }
      - run: corepack enable
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      # 打包冒烟：workspace exports 现在指向 src/*.ts，node dist/main.js 跑不起来（docs/review §1.3）
      # 修好之后把下面两行的 continue-on-error 去掉
      - run: pnpm build
      - name: dist smoke (node, not tsx)
        continue-on-error: true
        run: |
          RUNNER_PORT=18999 node apps/agent-runner/dist/main.js &
          for i in $(seq 1 30); do curl -fsS localhost:18999/healthz && break; sleep 1; done
          curl -fsS localhost:18999/healthz

  test:
    runs-on: ubuntu-latest
    services:
      mysql:
        image: mysql:8.0
        env:
          MYSQL_ALLOW_EMPTY_PASSWORD: "yes"
          MYSQL_DATABASE: agent_service_test
        ports: ['3306:3306']
        options: >-
          --health-cmd="mysqladmin ping -h 127.0.0.1"
          --health-interval=5s --health-timeout=5s --health-retries=20
      redis:
        image: redis:7
        ports: ['6379:6379']
        options: >-
          --health-cmd="redis-cli ping"
          --health-interval=5s --health-timeout=5s --health-retries=20
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with: { node-version: '24', cache: 'pnpm' }
      - run: corepack enable
      - run: pnpm install --frozen-lockfile

      - name: create the cluster database
        run: |
          mysql -h 127.0.0.1 -P 3306 -uroot -e \
            "CREATE DATABASE IF NOT EXISTS agent_service_cluster CHARACTER SET utf8mb4;"

      # 单元 + MySQL/Redis 一致性 + 覆盖率门槛。真实模型不跑（API_KEY 为空）。
      # 迁移由 MysqlSessionStore.connect() 自动应用 packages/store/migrations。
      - name: unit + integration (with coverage gate)
        env:
          AGENT_SERVICE_INTEGRATION: '1'
        run: |
          pnpm vitest run --project unit --coverage \
            --coverage.reporter=text --coverage.reporter=json-summary --coverage.reporter=lcov \
            --coverage.include='packages/*/src/**' --coverage.include='apps/*/src/**' \
            --coverage.thresholds.lines=74 \
            --coverage.thresholds.statements=68 \
            --coverage.thresholds.functions=63 \
            --coverage.thresholds.branches=55 \
            --coverage.thresholds.perFile=false
          # ↑ 门槛 = 2026-09-26 13:00 实测值（74.22 / 69.00 / 63.58 / 55.89）向下取整，
          #   只许涨不许跌。P0 的测试落地后一次性抬到 85/80/78/70。
          # perFile=false：pi.ts / main.ts / config.ts / blob/fs.ts 目前 0%，逐文件门槛会直接红。

      # 多进程集群（M2 验收）。骨架未落地前整个 project 会因缺 AGENT_SERVICE_CLUSTER 而空跑。
      - name: cluster e2e (3 runners, kill the lease holder)
        env:
          AGENT_SERVICE_CLUSTER: '1'
          AGENT_SERVICE_INTEGRATION: '1'
        run: pnpm vitest run --project cluster

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: coverage
          path: coverage/
          retention-days: 14

  # 真实厂商探针：只在 nightly 与手动触发时跑，需要仓库 Secrets。
  probe:
    if: github.event_name == 'workflow_dispatch' || github.event_name == 'schedule'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with: { node-version: '24', cache: 'pnpm' }
      - run: corepack enable
      - run: pnpm install --frozen-lockfile
      - name: vendor probes (dashscope / deepseek)
        env:
          DASHSCOPE_API_KEY: ${{ secrets.DASHSCOPE_API_KEY }}
          DEEPSEEK_API_KEY:  ${{ secrets.DEEPSEEK_API_KEY }}
        run: pnpm probe
      - name: real-model e2e
        env:
          API_KEY: ${{ secrets.DASHSCOPE_API_KEY }}
          API_BASE_URL: https://dashscope.aliyuncs.com/compatible-mode/v1
          DEFAULT_MODEL: qwen-plus
        run: pnpm vitest run --project unit packages/providers/test/e2e-qwen.test.ts
```

要点：
- **不在 CI 里跑真实模型**（`API_KEY: ""` 显式置空，靠 `describe.skipIf` 跳过），真实厂商只在 nightly/手动的 `probe` job 里跑；这既省钱也避免 PR 被厂商 5xx 卡住。
- `MYSQL_ALLOW_EMPTY_PASSWORD` + `MYSQL_DATABASE: agent_service_test` 正好对上 `mysql-redis.test.ts` 的默认 `MYSQL_TEST_URL`（`mysql://root@127.0.0.1:3306/agent_service_test`），零改动。
- 覆盖率门槛用**当天实测值取整**做保底，先阻止倒退，等 P0 测试落地后一次性抬高。`perFile=false`，因为 `pi.ts` 现在 0%，逐文件门槛会直接红。
- `dist smoke` 先 `continue-on-error: true`，等 §1.3 的 exports 修好后去掉——这样修复有了红绿信号。
- 没加 `actions/cache` for pnpm store 之外的东西；`setup-node` 的 `cache: 'pnpm'` 需要 `corepack enable` 在它之后或 lockfile 存在，实际顺序按上面写即可（`pnpm-lock.yaml` 已在仓库里）。

---

## 5. 优先级计划

### P0 — 写 M2 代码之前（合计 ≈ 34h，约 1 周）

| # | 事项 | 产物 | 工时 | 退掉什么风险 |
|---|---|---|---|---|
| P0-1 | 抽 `packages/core/test/fixture.ts`；增强 `fake-engine.ts`（`truncated` / `completionOrder` / `toolDelaysMs` / `provider,model` 四个字段，`truncated` 必须照抄 pi `agent-loop.js:159-166` 的行为） | 2 个文件 | 4h | 后面 6 个测试文件的共同前置；不做则每个文件重复 60 行 setup |
| P0-2 | `packages/core/test/history.test.ts` + `recovery.test.ts`：坑 #1（合成 id 稳定）、坑 #4（三态恢复 7 条）、坑 #8 便宜级（5 条） | ~14 条 | 5h | **M1 验收表"八条生产坑测试通过"目前是空头承诺**；`history.ts:46-48` 与 118-129 零覆盖 → 崩溃恢复语义和上下文裁剪可以被任意重构悄悄破坏 |
| P0-3 | `packages/core/test/prefix.test.ts`：前缀 sha256 三次一致、工具顺序无关、epoch bump 语义 | 5 条 | 2h | design §6.2 明写"CI 里跑前缀 sha256 回归测试"、§11 M1 明写"前缀 sha256 三请求一致"，都没做。BYOK 下缓存归零 = 用户成本投诉（坑 #1 的钱） |
| P0-4 | `packages/testkit` 包骨架 + 从 PoC 移植假厂商（`fake-vendor.ts` 90 行 + `fake-dashscope.mjs` 70 行 → 可编排的 `FakeStep` 接口）+ `sse-client.ts` | ~350 行 | 6h | M1 验收物"假厂商"补齐；解锁 P0-5 与 P0-6 |
| P0-5 | `packages/providers/test/dialect.test.ts`：8 条方言 + 坑 #2 的真实 SSE 版 + 前缀缓存命中 | 9 条 | 5h | **`pi.ts` 从 0% 覆盖变成有契约测试**。design §12 头号风险"pi 每版 Breaking"的对策就是这个；同时把 deepseek/dashscope 两套 usage 拼法、分片 arguments、`: keep-alive`、缺 `finish_reason` 全部钉死 |
| P0-6 | `packages/testkit/src/{runner-process,cluster}.ts` + `test/cluster/takeover.test.ts` + `fence.test.ts`；`vitest.config.ts` 改 projects | ~400 行 | 8h | **M2 的验收标准从"人工 demo.sh"变成"CI 一条命令"**。不先有 harness，M2 的重路由/接管/补洞只能事后补测，成本翻倍 |
| P0-7 | `.github/workflows/ci.yml`（mysql+redis services、unit+integration、skip real-model、typecheck、coverage 门槛、dist smoke） | 1 文件 | 3h | 现在全靠本机手跑；仓库还没有第一个 commit，CI 是起点不是终点 |
| P0-8 | 覆盖率接门槛（`@vitest/coverage-v8@4.1.11` **已装好**）+ 改 `package.json` scripts + 更新 `docs/PROGRESS.md` 的测试数字 | — | 1h | 防倒退。**这一项现在有了实证依据**：审计的两小时里 `agent-runner` 的分支覆盖从 40.4% 掉到 34.9%（新增了 `X-Owner`/`bodyLimit`/`forbidden` 三条分支、没配测试）。没有门槛，这种下滑永远不会被看到 |

**P0 顺带会修的真实缺陷**（测试会先红）：
1. 截断的 tool call 被打上 `startedAtMs` → 崩溃恢复误报 `TOOL_OUTCOME_UNKNOWN`（P0-2 发现，改 `host.ts:414-419`）；
2. `interrupt()` 时 pending 审批不落库，永远停在 `pending`（P0-1/P0-2 的 cancellation 用例发现，改 `host.ts:579-590`）；
3. `startTurn` 的并发占位在 await 之后（P1-5 的 fuzz 会稳定复现，但 M2 之前就该修）。

### P1 — M2 进行中（合计 ≈ 27h）

| # | 事项 | 工时 | 退掉什么风险 |
|---|---|---|---|
| P1-1 | `packages/core/test/lifecycle.test.ts`：`drain()`（4 条）、租约续期失败 → abort、`FenceError` → abort、`finishTurn` commit 失败 | 5h | `drain` 是 M2 的"发布/缩容"验收项，现在 100% 未测；租约丢失不 abort 就是双写者 |
| P1-2 | `test/cluster/drain.test.ts`：SIGTERM → readyz 503 → step 边界 checkpoint → 租约释放 → 下一个 runner 立刻可接 | 3h | design §4.3 drain 行；K8s 滚动发布时长 turn 的正确性 |
| P1-3 | `packages/core/test/cancellation.test.ts` 完整化（坑 #7 三条）+ `concurrency.test.ts`（坑 #6 四条） | 4h | 坑 #6/#7 补齐；`projectItems` 的模型顺序性质被显式钉住 |
| P1-4 | **（大半已在审计期间完成）** 剩余：`web_fetch` 的网络分支（3xx 不跟随、`readCapped` 的 256KB 截断与 `reader.cancel()`、HTML 剥离、`!res.ok`）+ `::ffff:` v4-mapped 分支 + **动态工具的 HTTP 反向委托端到端**（`POST /tool-results` → `submitDynamicToolResult`）。复用 §4.2 假厂商进程加 `/redirect` `/html` `/slow-infinite` 三个路由 | 3h → **1.5h** | `builtin` 分支已从 6.7% → 67.3%；剩下的是"恶意端点把我们撑死"和"动态工具从没端到端跑通过"两条 |
| P1-5 | property/fuzz：`invariants.prop.test.ts`（11 条 prop）+ jitter 并发 startTurn 50 轮 | 6h | `projectItems` 的四条不变量、seq 单调性、uuidv7 单调性；**并发 startTurn 的时序脆弱性**（会 fail → 修 host） |
| P1-6 | store conformance 扩条目（分页游标 ×3、`listItems` 过滤、`appendUsage`、软删、`readEvents` 翻页、`getItem`、`listApprovals(pendingOnly)`、**MySQL 两连接并发 commit**）——一次写好两种实现都涨 | 5h | MySQL 分支覆盖 53% → 75%+；`SELECT FOR UPDATE` 的串行化第一次被验证 |
| P1-7 | 修 workspace `exports`（让 `node dist/main.js` 能跑）+ 去掉 CI 的 `continue-on-error`；`config.ts` 单测 | 3h | 生产镜像现在起不来；harness 可以从 `tsx` 切到 `node`，cluster 测试快 3~5 倍 |
| P1-8 | `apps/agent-runner/test/sse-socket.test.ts`（真 socket）+ 补齐未测端点（`/healthz` `/readyz` `/capabilities` `/models` `/tools` `interrupt` `steer` `tool-results` `approvals` `?exclude=` 幂等冲突两分支）+ **审计期间新增的 4 条分支**（`X-Owner` 且 body 无 `details`、`bodyLimit` 超限 → `invalid_request`、跨用户 `?userId=` → `forbidden`、`redactProviderConfig` 的脱敏形状）+ `InputPart.text` 100_000 边界 | 5h | `app.ts` 分支 **41.7% → 75%**。这一项应该提到 P1 最前面：`agent-runner` 的分支覆盖正在**下降**（40.4% → 34.9%），新功能在没有测试的情况下进入 M2 的契约面（`X-Owner` 就是 router 重路由的协议） |

### P2 — 之后（合计 ≈ 39h）

| # | 事项 | 工时 | 退掉什么风险 |
|---|---|---|---|
| P2-1 | 摘要级压缩实现 + 移植 PoC `tool-pairing.ts`（86 行）与它的 19 条测试 + `cache.read+cache.write` 计入占用 + 压缩事务性 | 10h | **坑 #8 完整闭环**；长会话 + 大工具输出是通用 runtime 的常态，现在只有便宜级 |
| P2-2 | 压测 smoke `test/load/concurrent-turns.ts`（阶梯 50→2000，采 10 个指标）+ 数字回填 design §9 | 8h | design §9 的"1,000 turn/进程 → 250 进程"是纸面假设；错了会连带改容量表、成本表、k8s 规格。**建议 M2 结束时先跑一次 baseline，不等 M4** |
| P2-3 | 混沌测试：Redis 抖动（kill redis 3s 再起）、MySQL 断连、厂商 5xx/超时/半截流（用假厂商的 `httpError`/`hang`） | 8h | M4 验收项；也是 `RedisEventBus` 重连、连接池耗尽这些路径的唯一验证手段 |
| P2-4 | 坑 #3：换模型前用旧模型压缩 + reasoning 跨 provider 降级 + `providerMetadata` 剥离 | 6h | BYOK + 多厂商下同会话换模型是常态；deepseek 的 `requiresReasoningContentOnAssistantMessages` 是明确的 400 风险 |
| P2-5 | 坑 #5：`warning` 事件发射机制 + reasoning 丢弃检测 + `agentrt_reasoning_dropped_total` | 3h | 推理连续性静默消失；顺带把 `warning` 这个已定义未使用的事件类型激活 |
| P2-6 | 移植 PoC `probe-vendor.ts`（343 行）→ nightly job；接新厂商（kimi / zhipu preset 从未被任何请求验证过） | 4h | design §12 "国产厂商未文档化的流式行为"；preset 里的价格表也需要探针核对（`presets.ts` 注释自己说"MUST be re-verified"） |

---

## 6. 结论

有 UT，质量在同阶段项目里算好的（store 双实现契约 + SessionHost 的 16 条行为测试是真资产）。E2E 只有两种，都不覆盖"多进程 + 崩溃 + 补洞"这一类——而这恰好是 M2 的全部验收内容，也是这个系统区别于单机 harness 的唯一理由。

**必须继续建，且顺序不能反**：先有 `packages/testkit`（假厂商 + 多进程 harness）和八条坑的回归测试，再写 M2 的 router 和 drain 代码。理由很实际——`pi.ts` 现在 0% 覆盖、八条坑 0/8 有测试、CI 不存在；在这个基础上继续加分布式代码，等于在没有刹车的车上踩油门。P0 的 34 小时买回来的是：CI 里第一次有人替我们跑那些"只有杀进程才能发现"的 bug。
