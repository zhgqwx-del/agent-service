# 评审 01：并发与状态正确性

- 评审对象：`packages/core/src/session/host.ts`、`engine/pi.ts`、`context/history.ts`、`packages/store/*`、`apps/agent-runner/src/{app,sse}.ts`
- 对照契约：`docs/design/00-architecture.md` §4（所有权/租约/fencing/故障场景）、§6（引擎/安全阀/压缩/崩溃恢复）
- 方法：逐行追踪 + 反向阅读 `@earendil-works/pi-agent-core@0.87.0` 的 `agent.js` / `agent-loop.js` 真实事件顺序 + 8 个可执行探针（P1–P8，用 `MemorySessionStore` + `ScriptedEngine` 或 hono 直接跑通，跑完已删除）。
- 探针结论一览（**全部复现**）：

| 探针 | 断言 | 实测 |
|---|---|---|
| P1 | delta 是否晚于 `item/started` | **否**：9 个 delta 在 `item/started` 之前（idx 4 vs 13） |
| P2 | 同一 agentMessage item 的两次落库 seq 是否一致 | **否**：`item/started`.seq=5，`item/completed`.seq=7 |
| P3 | `drain(300ms)` 在有待审批时是否按预算返回 | **否**：实测 **2803ms**（= approvalTtl 3000） |
| P4 | 租约被 r2 抢走（fence 2）后 r1 是否释放 turn | **否**：`activeTurn` 仍在，新 turn 被 `session_busy` 拒绝 |
| P5 | 跨 session 提交同名 `toolCallId` 是否被拒 | **否**：`resolve("call_1")` 返回 true，A 会话收到 B 会话的结果 |
| P6 | 陈旧 session 快照是否会产生假 `idle` | **是**：假 `session/status/changed{idle}` 出现在本 turn 的 `turn/started` **之前** |
| P7 | `close()` 早于 `attach()` 返回时 `unsub` 是否被调用 | **否**：`unsubCalled=false`，订阅永久泄漏 |
| P8 | 预留后失败的 Idempotency-Key 能否重试 | **否**：第二次 reserve 返回 `{turnId:""}` → `idempotency_conflict` |

---

## 一、已验证的缺陷

### B1 [blocker] FenceError 不会中止 turn：`onCommitError` 只挂在一个调用点上

**位置**：`packages/core/src/session/host.ts:698-706`（`onCommitError`）、唯一调用点 `host.ts:375`；其余全部 commit 调用点无处理：`host.ts:425`（onAssistantMessage）、`435`（onToolExecutionStart）、`452`（onToolResult）、`491`/`517`（gateToolCall）、`566`（steer）、`625`（finishTurn）。

**契约**：§4.2 第 4 条「续期失败 → 立即 abort 当前 turn（fence 已失效，任何写入都会被 DB 拒绝）」；§4.1「两个 writer → seq 冲突、工具重复执行，数据损坏」。

**失效场景**（可推演、每一步都有代码依据）：
1. runner A 持 fence=5 跑 turn，正在执行一个 40s 的 HTTP 工具；进程发生 15s GC/网络抖动。
2. Redis 上 `lease:{sid}`（TTL 30s）过期。runner B `POST /turns` → `acquire` 拿到 fence=6 → `closeOrphanedTurn` 把 A 的 turn 标记 interrupted → 开新 turn。
3. A 的 `renewTimer`（周期 `leaseTtlMs/3`=10s）最多 10s 后才发现失联。这 10s 内 A 的工具已经执行完，`onToolResult` → `commit(fence=5)` → MySQL `store.ts:163` 抛 `FenceError`。
4. 该 rejection **不经过 `onCommitError`**，而是从 `sink.onToolResult` 抛回 pi：`agent.js:430` 的 `await listener(...)` 抛 → `agent-loop.js` 的 `emit` 抛 → `runWithLifecycle` catch → `handleRunFailure` 造一条 `stopReason:"error"` 的假 assistant message → 再次回调 `onAssistantMessage` → 又一次 fence 失败。
5. 结果：`state.stopReason` / `state.limitHit` 从未被置位；turn 最终以 `stopReason:"error"`（`result.error`）结束，日志里只有一行 `commit failed`；期间 A 仍然在跑 tool（若 fence 丢失发生在 step 边界之前，A 会**继续发起下一次模型调用并执行更多工具**，直到某次 commit 的 rejection 冒泡把 run 打断）。副作用重复执行 + 计费重复，且运维侧看不到「被 fence 掉」这一事实。

**修复**：把 `commit()` 本身变成失败即熔断：
```ts
private commit(state, batch) {
  const run = async () => {
    try { const r = await this.deps.store.commit({...}); state.session.lastSeq = r.lastSeq; await this.publishAll(...); return r; }
    catch (e) { this.onCommitError(state, e); throw e; }
  };
  ...
}
```
并在 `onCommitError` 里对 `FenceError` 额外做：`state.fenced = true`（新字段）→ `gateToolCall` 与 `onStepEnd` 开头直接拒绝、`finishTurn` 跳过写库只做本地清理。另外 `state.chain.then(run, run)` 的「前一次失败后一次照跑」在 fence 丢失后毫无意义，建议 fence 丢失后让 chain 短路。

---

### B2 [blocker] `drain()` 会被待审批的 turn 拖住整整一个 approvalTtl（默认 10 分钟）

**位置**：`host.ts:501-507`（审批 Promise 只有 timer，没有 abort 监听）、`host.ts:586`（`interrupt` 里 abort）、`host.ts:715-728`（`drain`）、`apps/agent-runner/src/main.ts:40-47`（shutdown）。

**契约**：§4.3「runner 发布/缩容 → drain：拒绝新 turn，等进行中 turn 到 step 边界做 checkpoint 后释放租约；**超时则 abort**」。

**失效场景（P3 已实测）**：agent `approvalPolicy: "on-request"`，模型调用一个 `needsApproval` 工具 → `gateToolCall` 阻塞在 `await new Promise(...)`。此时 SIGTERM：
- `drain(30_000)` 轮询 `active.size` 30s → 超时 → `s.abort.abort()`。
- 但 `state.abort` 与审批 Promise **毫无关联**（`gateToolCall` 从不读 `state.abort.signal`），pi 此刻正阻塞在 `await config.beforeToolCall(...)`（`agent-loop.js:492`），`agent.abort()` 也解不开。
- `await Promise.all([...active.values()].map(s => s.done))` 继续等 → 直到审批 timer（10 分钟）触发 `resolve("decline")`。
- 实测：`drain(300)` 在 `approvalTtlMs=3000` 下耗时 **2803ms**，即完全由 approvalTtl 决定。
- 生产后果：K8s `terminationGracePeriodSeconds`（典型 30–60s）到点 SIGKILL → `main.ts:44-46` 的 `server.close()` / `store.close()` / `process.exit(0)` 永不执行 → 该 turn 的 `turn/completed` 永不落库，session 永久停在 `status:active`，直到下一次有人对这个 session 发起 turn 才被 `closeOrphanedTurn` 修复。**每次滚动发布都会按待审批数量批量产生孤儿 turn。**

**修复**：审批等待必须可取消。
```ts
const decision = await new Promise<ApprovalDecision>((resolve) => {
  const timer = setTimeout(...);
  const onAbort = () => { clearTimeout(timer); state.pendingApprovals.delete(approval.id); resolve("cancel"); };
  state.abort.signal.addEventListener("abort", onAbort, { once: true });
  state.pendingApprovals.set(approval.id, { resolve: (d) => { state.abort.signal.removeEventListener("abort", onAbort); resolve(d); }, timer });
});
```
并给 `drain` 的 `Promise.all` 加硬超时（`Promise.race([done, sleep(5000)])`），超时后仍然释放租约，把修复留给下一个 owner（与 §4.3 一致）。同时 `main.ts` 应先 `server.close()` 再 `drain()`。

---

### B3 [blocker] 动态工具结果跨 session/跨租户串号

**位置**：`packages/core/src/tools/dynamic.ts:9`（`pending` 只以 `toolCallId` 为键）、`:31`、`:43`；`host.ts:591-594`（`submitDynamicToolResult` 只校验 `active.has(sessionId)`）；`apps/agent-runner/src/app.ts:196-202`。

**失效场景（P5 已实测）**：`DynamicToolBridge` 是 `SessionHost` 的**单例字段**（`host.ts:110`），`pending` 的键完全由模型生成的 `toolCallId` 决定。租户 A 的 session 与租户 B 的 session 同时各有一个动态工具调用，两边的 `toolCallId` 都是 `call_1`（OpenAI-compatible 端点、qwen/deepseek 兼容层、以及本仓库自己的 `ScriptedEngine`（`test/fake-engine.ts:40`）都会产生 `call_1`/`call_2` 这类按序号的 id）。租户 A 调 `POST /sessions/{A}/turns/{t}/tool-results {toolCallId:"call_1"}`：
- `getSession` 通过（A 的 session 确实属于 A），`active.has(A)` 通过；
- `dynamicTools.resolve("call_1")` 命中的是 **B 的** pending → B 的模型收到 A 注入的工具输出，A 自己的调用继续挂到 5 分钟超时。
- 这是一条**跨租户的模型输入注入通道**，也是一条 B 会话内容的间接泄漏通道（A 可以观察自己的调用是否被"抢答"）。

**修复**：键改为 `${sessionId}#${turnId}#${toolCallId}`，`asTool` 从 `ctx`（已含 `sessionId`/`turnId`）取值，`submitDynamicToolResult` 接受 `turnId` 并校验 `this.active.get(sessionId)?.turn.id === turnId`。

---

### H1 [high] MySQL `items.seq` 列与 `body.seq` 永久不一致 → 增量拉 item 会丢消息，且 memory/mysql 两个实现语义分叉

**位置**：`packages/store/src/mysql/store.ts:323-330`（`upsertItem` 的 `ON DUPLICATE KEY UPDATE` 只更新 `status, body, completed_at_ms`，**不更新 `seq`**）、`packages/store/src/types.ts:56-68`（`assignItemSeqs`）、`host.ts:374`（第一次落库的 item 对象）对 `host.ts:401`（第二次是**新对象**、`seq:0`）、`migrations/0001_init.sql:70,76`（`seq` 是真列，且有 `uk_items_session_seq`）。

**失效场景（P2 已实测）**：一个有文本的 step：
1. 首个 delta → `onTextDelta` 提交 `item/started`，item 得到 seq=**5**；MySQL 行：`seq=5`，`body.seq=5`。
2. step 结束 → `onAssistantMessage` 用**另一个对象**（`seq:0`）重建同 id 的 item，`assignItemSeqs` 赋 seq=**7**（因为前面插了 reasoning 的 `item/completed`）。
3. `upsertItem` 命中 duplicate → `body` 变成 `{...seq:7}`，但 `seq` 列仍是 5。
4. `listItems` 用 `WHERE seq>? ORDER BY seq ASC`（`store.ts:226-233`）过滤/排序，却返回 `parse(body)`。

后果：
- 客户端按 `GET /v1/sessions/{id}/items?afterSeq=6` 增量拉取（`app.ts:205-209`）时，这条最终的 agentMessage（`body.seq=7` > 6，但列 `seq=5` ≤ 6）**被 SQL 过滤掉**——用户永久看不到本 step 的最终回答文本。
- 返回顺序按列排序，agentMessage(5) 会排在同 step 的 reasoning(6) **之前**，item 时间线错乱。
- `MemorySessionStore.listItems`（`memory.ts:128-134`）过滤/排序用的是 `i.seq`（= body 里的 7），**行为与 MySQL 相反**，所以 `packages/store/test/conformance.ts` 这套共享契约测试永远抓不到它。`finishTurn:620-623` 也会再造一个 `seq:0` 的同 id 对象，同类问题。

**修复**：二选一。(a) `upsertItem` 的 `ON DUPLICATE` 里加 `seq=VALUES(seq)`（但 `uk_items_session_seq` 会留下旧 seq 的历史，需一并处理）；(b) 更干净：item 的 seq 一旦分配就不变——`assignItemSeqs` 只在 item **首次**出现时赋值，host 侧把 `state.agentItemId` 对应的 item 对象缓存复用（像 `toolCallItems` 那样），后续 commit 传同一个对象（`seq!==0` 会被 `assignItemSeqs` 跳过）。同时在 conformance 里加一条「同 id item 二次 upsert 后 `listItems(afterSeq)` 仍能取到」的用例，强制两个实现对齐。

---

### H2 [high] 陈旧 session 快照让 `closeOrphanedTurn` 打到一个已完成的 turn，并广播假 `idle`，把流式客户端的 SSE 提前关掉

**位置**：`host.ts:221`（`getSession`）→ `:222`（`getAgent`，第二个 await）→ `:227`（`active.get`）→ `:245-248`（用 **第 221 行读到的快照** 判断 `session.status.type === "active"`）；`host.ts:647-664`（`closeOrphanedTurn` 无条件提交 `{status:idle}` + 事件）；消费方 `apps/agent-runner/src/app.ts:160-163`（收到 `idle` 就 `close()`）。

**失效场景（P6 已实测，事件序列原样输出）**：
1. turn 1 正在跑，store 里 `status=active{turnId:T1}`。
2. 客户端发起 turn 2（流式）。`startTurnLocked` 在 `:221` 读到快照 `status=active{T1}`；随后两个 await（`getAgent` 是一次 DB 往返）期间 turn 1 的 `finishTurn` 完成：store 变 `idle`、`active.delete(sessionId)`（`:640`）。
3. `startTurnLocked` 恢复：`local === undefined`（已删）且**快照**仍是 `active` → 进入 `closeOrphanedTurn`。
4. `getTurn(T1)` 拿到的是 `status:"completed"`，所以不改 turn（这点是对的），**但仍然 commit 了一条 `sessionPatch:{status:idle}` 和一条 `session/status/changed{idle}` 事件并 publish**。
5. 实测事件序列：`["session/status/changed"(假 idle), "turn/started", "item/completed", ...]`——假 idle 排在 turn 2 自己的 `turn/started` **之前**。
6. 流式 `POST /turns` 的 listener 是先 `subscribe` 再 `startTurn`（`app.ts:156-177`），`afterSeq = session.lastSeq`，所以这条假 idle 必然被投递 → `close()` → `accepting=false` → **turn 2 的所有事件（turn/started、全部 delta、turn/completed）被静默丢弃**，客户端拿到一个空流并认为 turn 结束；而 turn 2 在后台正常跑完并计费。
7. 附带：这条假 idle 还会消耗一个 seq，让「事件流里 idle → active → idle」出现毛刺，破坏客户端状态机。

**修复**：
- `closeOrphanedTurn` 前**重读** session（或在 `active.get` 之后再读一次），并且只有 `getTurn(...).status === "inProgress"` 时才写任何东西：把 `batch` 的构造整体移入 `if (t && t.status === "inProgress")`，否则直接返回。
- `app.ts` 里流式 turn 的关闭条件应改成「`turn/completed` 且 `turn.id === 我的 turnId`」，而不是任意 `idle`（这样也顺带修掉 L2）。

---

### H3 [high] SSE 订阅泄漏：`close()` 先于 `attach()` 返回时 `unsub` 永不执行

**位置**：`apps/agent-runner/src/sse.ts:22`（`let unsub`）、`:42-47`（`close()` 调 `unsub?.()` 并置 `accepting=false`）、`:48-51`（`onAbort` → `close()`）、`:56`（`unsub = await attach(...)`）、`:59-62`（finally 再 `close()`，但 `accepting` 已是 false，**第 43 行直接 return**）。

**失效场景（P7 已实测，`unsubCalled=false`）**：两条真实路径都能触发 `close()` 早于 `attach()` 返回：
- (a) `attach` 内部先 `subscribe` 再 `startTurn`（`app.ts:158-174`）。只要 replay/live 阶段投递到任何 `idle`（见 H2，或上一个 turn 恰好在此刻收尾），listener 就在 `attach` 还在 `await startTurn` 时调用 `close()`；
- (b) 客户端在 `attach` 期间断开（`subscribe` 要分页读 500 条一批的历史事件，`host.ts:190-195`，大 session 上是几十毫秒到数百毫秒）→ `onAbort` → `close()`。

两种情况下 `unsub` 都还是 `undefined`，`unsub?.()` 空转；finally 的 `close()` 被 `if (!accepting) return` 挡住 → **bus listener 永久驻留**。`MemoryEventBus` 是进程内 Set（`memory.ts:234`），`RedisEventBus` 是 `listeners` Map + 常驻 channel 订阅（`bus.ts:16,96-102`）：每一次这样的请求都增加一个永不回收的 listener，并且 `set.size` 永远不归零 → 该 session 的 Redis channel 永远不 `unsubscribe`。长期是内存泄漏 + 无谓扇出 + 进程无法优雅退出。

**修复**：
```ts
let closed = false;
const close = () => { if (closed) return; closed = true; accepting = false; unsub?.(); resolveDone(); };
try { unsub = await attach(send, close); if (closed) unsub(); await done; await drain(); }
finally { clearInterval(hb); closed = false; close(); /* 或直接 unsub?.() */ }
```
关键是把「已关闭」和「已退订」两个状态分开，并在 `attach` 返回后补一次退订检查。

---

### H4 [high] Idempotency-Key 预留后不回滚：一次 409 重路由就把这个 key 永久锁死 24 小时

**位置**：`apps/agent-runner/src/app.ts:136-146`（先 `reserveIdempotencyKey`，`value=NULL`）、`:149-151` / `:165-166`（只在**成功**后 `completeIdempotencyKey`）；`store.ts:298-313` / `memory.ts:177-183`。

**契约**：§4.2 第 2 条「抢租约失败 → `409 session_lease_conflict`，响应头 `X-Owner`，**router 重路由一次**」。

**失效场景（P8 已实测）**：客户端按最佳实践带 `Idempotency-Key: k1` 发 `POST /sessions/{id}/turns`，被 router 路由到了错的 runner：
1. runner X：`reserve(k1)` → `{existing:null}` → 继续 → `host.startTurn` 在 `lease.acquire` 处失败 → 抛 `session_lease_conflict`（409）。`k1` 的行留在库里，`value=NULL`，`expires_at = now+24h`。
2. router 按契约重路由到真正的 owner runner Y：`reserve(k1)` → 命中 duplicate → `value` 为 NULL → 返回 `{existing:{turnId:"", sessionId:""}}` → `app.ts:140` `!r.existing.turnId` → 抛 **`idempotency_conflict "request with this key is still in progress"`**。
3. 客户端此后 24 小时内用同一个 key 重试永远得到 `idempotency_conflict`，而实际上**一个 turn 都没有跑起来**。同样的路径也适用于任何 `startTurn` 失败（`session_busy`、`draining`、provider 解析失败、第一次 commit 失败）。

**修复**：`reserve` 失败语义要可回滚。最小改动：把 `reserveIdempotencyKey` 挪到 `startTurn` 成功之后（牺牲一点并发去重），或者在 catch 里补一个 `releaseIdempotencyKey(tenantId, key)`（删除 `value IS NULL` 的行）并在 `SessionStore` 接口上补这个方法；另外 `{turnId:"", sessionId:""}` 这个"空哨兵"应该换成显式的 `inProgress: true`，避免用空串判状态。

---

### H5 [high] 租约丢失 + 待审批 = 该 session 在本 runner 上停摆 10 分钟，且最终以 stale fence 写库

**位置**：`host.ts:309-316`（续期失败只 `abort`）、`host.ts:501-507`（审批不听 abort）、`host.ts:227-233`（`active` 有条目就 `session_busy`）。

**失效场景（P4 已实测）**：turn 停在审批上；Redis 上租约过期（TTL 30s）被 runner r2 抢走（实测 `{ok:true, fence:2}`）。
- r1 的 `renewTimer` 返回 false → `stopReason="error"` + `abort()`，但审批 Promise 不受影响（同 B2）。
- 实测 700ms 后 `host.activeTurn(sessionId)` **仍然存在**，且对同一 session 再发 turn 被 `session_busy "a turn is in progress"` 拒绝。也就是说：**r1 已经不是 owner 了，却仍然以 owner 的身份拒绝请求**，一直到 approvalTtl（默认 10 分钟）到期。
- 10 分钟后审批超时 `decline` → `gateToolCall:517` 用 fence=1 commit → `FenceError` → 见 B1，被吞进 pi 的 tool-result 里。
- 若 router 的 owner 目录已指向 r2，请求会落到 r2，用户侧表现为"审批弹窗点了没反应"（r2 上 `resolveApproval` 走 `host.ts:539-544`，store 里是 pending 但本机没有 → 抛 `session_lease_conflict`，形成死循环）。

**修复**：同 B2（审批监听 abort）+ 追加：`renewTimer` 检测到失联后应立即把 `active` 条目摘掉（或标记 `fenced`，让 `startTurnLocked` 的 busy 判断跳过 fenced 状态），不要继续冒充 owner。

---

### H6 [high] 软删除的 session 仍然可以 commit：turn 无法中断、继续烧钱；memory/mysql 语义相反

**位置**：`mysql/store.ts:142-149`（`deleteSession` 只写 `deleted_at_ms`）、`:121-127`（`getSession` 过滤 `deleted_at_ms IS NULL`）、`:156-159`（`commit` 的 `SELECT ... FOR UPDATE` **不过滤 `deleted_at_ms`，也不带 tenant_id**）、`app.ts:120-124`（`DELETE /sessions/:id` 不通知 host）。

**失效场景**：turn 正在跑（10 步、带工具），用户 `DELETE /v1/sessions/{id}` → 204。
- host 完全不知情：`active` 条目、`renewTimer`、engine run 全部继续。
- 每一次 `commit` 依然成功（`commit` 看不到删除标记），items/events/usage 继续往一个"已删除"的 session 上堆。
- 用户想止损：`POST .../interrupt` → `host.interrupt` 第一行 `await this.getSession(...)`（`host.ts:571`）→ 404。**turn 变成不可中断**，只能等 `maxWallClockMs`（默认 5 分钟）或 maxSteps 跑完，期间持续调用模型和工具、持续写 `usage_ledger`。
- `MemorySessionStore.deleteSession`（`memory.ts:83-92`）是**硬删**，之后 `commit` 抛 `session ... not found`（`memory.ts:96`）→ 与 MySQL 行为完全相反。两个实现在"删除中 commit"这一语义上分叉，conformance 未覆盖。

**修复**：`deleteSession` 走 host：`await host.abortSession(tenantId, sessionId)`（abort + 解审批 + 释放租约 + 等 `state.done`）再软删；`commit` 的 `FOR UPDATE` 查询加 `AND deleted_at_ms IS NULL`，并为此定义一个 `SessionDeletedError`，让 host 当成终止信号（而不是 fence 错误）；在 conformance 里补「删除后 commit」的用例。

---

### H7 [high] write-ahead 三态判定被 pi 的事件顺序破坏：审批期间崩溃会被误判成 `TOOL_OUTCOME_UNKNOWN`

**位置**：pi 的 `agent-loop.js:376`（sequential）与 `:412`（parallel）——`emit({type:"tool_execution_start"})` 在 `prepareToolCall` → `config.beforeToolCall`（`:491-497`）**之前**；host 侧 `host.ts:431-436`（`onToolExecutionStart` 立即写 `startedAtMs` 并落库）；判定方 `packages/core/src/context/history.ts:46`（`call.startedAtMs ? "TOOL_OUTCOME_UNKNOWN" : "TOOL_NOT_STARTED"`）。

**契约**：§6.4「write-ahead：`toolCall` item 先落库再执行；恢复时 `TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN` 两码交给模型」；§6.5 第 4 条「崩溃三态」是必过回归项。

**失效场景**：agent 配 `approvalPolicy:"untrusted"`，模型调用 `transfer_money`。
1. pi emit `tool_execution_start` → host 写 `startedAtMs=now` 并 commit。
2. pi 才调 `beforeToolCall` → `gateToolCall` 创建审批，阻塞（最长 10 分钟）。
3. 这期间 runner 崩溃 / 被 SIGKILL（B2 的场景里这几乎是必然）。
4. 新 owner `projectItems` 看到 `toolCall` 有 `startedAtMs`、无 `toolResult` → 注入 `TOOL_OUTCOME_UNKNOWN:"...Its side effects may or may not have happened. Verify before repeating any non-idempotent action."`
5. 事实是这个工具**一次都没被调用**（还卡在人工审批上）。模型被告知"可能已经转账了"，正确行为下它会去查账或放弃——对不可查询的副作用则可能**跳过本该执行的动作**，反之如果模型选择"确认一下再转"，用户又会收到二次审批。信息与事实相反，比没有信息更糟。
6. 同样的错标也发生在被 `limitHit`/`unknown tool`/审批 decline 挡掉的调用上（它们都先 emit 了 `tool_execution_start`）。

**修复**：不要把 `onToolExecutionStart` 当作"真正开始执行"的证据。可选：
- (a) 在 `gateToolCall` 通过（`return {allow:true}`）的那一刻才写 `startedAtMs`；`onToolExecutionStart` 只做内存标记。
- (b) 更稳：给 toolCall item 加两个字段 `gatedAtMs` / `dispatchedAtMs`，`history.ts` 只在 `dispatchedAtMs` 存在时判 `TOOL_OUTCOME_UNKNOWN`，并对「有审批 item 且审批仍 pending」的情况给第三码 `TOOL_AWAITING_APPROVAL`（§6.4 的"三态"本意）。
- 并在 `packages/core/test` 里补一条契约测试：审批 pending 时崩溃 → 投影必须是 `TOOL_NOT_STARTED`（两种 engine 都要过，§6.5）。

---

### H8 [high] delta 早于自己的 `item/started` 到达客户端

**位置**：`host.ts:371-379`（`onTextDelta`：`void this.commit(...)` 不等待，紧接着 `live(delta)`）、`host.ts:360`（`live` 直接 `bus.publish`，绕过 chain）、`host.ts:686-696`（`commit` 的 publish 在 store 写成功之后）。

**契约**：§4.4「delta 类事件只进 Stream，不落库，不占 seq（SSE `id:` 沿用上一条持久化事件的 seq，客户端按 itemId 拼接）」——协议允许 delta 无 seq，但没有授权 delta 先于其 item 的生命周期事件。`host.ts:93` 的注释还自称 "seq order == delivery order"。

**失效场景（P1 已实测）**：实际投递序列
```
turn/started, item/completed(user), session/status/changed,
delta×9,                 <-- itemId=X 的 9 个 delta
item/started(item X),    <-- X 的诞生公告
item/completed(item X), usage/updated, turn/completed, session/status/changed
```
原因：`commit` 要等一次 DB 往返（MySQL 事务 + `FOR UPDATE`，几毫秒起），而 `live()` 是同一 tick 直接 publish。任何"收到 `item/started` 才建 UI 节点、否则丢弃未知 itemId 的 delta"的客户端（这是最自然的实现，也是 codex/AI-SDK 的常规写法）**会丢掉整段首屏文本**；宽容的客户端则要为每个 itemId 维护孤儿缓冲。

**修复**：择一并写进协议文档：
- (a) 让 `item/started` 先行：`onTextDelta` 里对首个 delta `await` 那次 commit（会引入一次 DB 延迟，但只在每 step 的第一个 delta 上），或者
- (b) 把 `item/started` 也当作 live-only 事件先 publish、再异步落库（保持 delta 之前），或者
- (c) 明确协议：delta 可以先到，客户端必须按 itemId 惰性建节点——并在 `docs/design` §4.4 和 capabilities 里写清楚，同时删掉 `host.ts:93` 那句会误导人的注释。

---

## 二、中等与低等缺陷

### M1 [medium] `busyPolicy:"steer"` 的竞态会把用户消息直接丢掉（404）

`host.ts:229-233` 拿到 `local` 后调 `this.steer(...)`，而 `steer` 自己第一行是 `await this.getSession(...)`（`host.ts:559`，一次 DB 往返），之后才 `this.active.get(sessionId)`（`:560`）。若这次往返期间 turn 自然结束（`finishTurn` 删掉 `active`），`steer` 抛 `not_found "no active turn with that id on this runner"` → 客户端收到 404，**输入被吞**。对"边跑边打字"的交互这是高频窗口。
**修复**：`startTurnLocked` 里不要走公开的 `steer`，直接用手上的 `local`（它已经通过鉴权）调一个私有 `steerLocked(state, input)`；并且 `steer` 失败时回退为"开一个新 turn"而不是 404。

### M2 [medium] `resolveApproval` 可能返回一个 `pending` 的 approval，或对并发调用报错误的 `session_lease_conflict`

`host.ts:546-555`：`pending.resolve(decision)` 之后靠"轮询 50×20ms"等落库。`gateToolCall:517` 的那次 commit 排在 `state.chain` 上，若前面有慢 commit（大 toolResult、DB 抖动、`FOR UPDATE` 锁等待）超过 1s，循环结束 → `return (await getApproval(...))!` 返回**仍是 `pending`** 的行（HTTP 200 + `status:"pending"`）。客户端据此重试 → 第二次 `pendingApprovals.get` 为空（`:547` 已删）→ store 里还是 pending → 抛 `session_lease_conflict "approval is owned by another runner"`，一条彻底误导的错误。两个并发 `resolveApproval` 同样：`await getSession()` 之后才查 map，后到的那个必然走进这个分支。此外 `!` 断言在 session 被软删时会返回 `undefined`。
**修复**：不要轮询 store。让 `gateToolCall` 把"决议后的 commit Promise"挂到 `pendingApprovals` 的条目上，`resolveApproval` 直接 `await` 它；并给 map 的条目加 `resolving` 标记，第二个调用者返回 409 `approval_already_resolving` 而不是 `session_lease_conflict`。

### M3 [medium] `maxCostCNY` 对没有价目表的 BYOK provider 永久失效

`host.ts:423`：`(state.turn.usage.costCNY ?? 0) > state.limits.maxCostCNY`。`packages/providers/src/service.ts:150-152`：`m.price` 缺失时 `cost` 全部填 0 → pi 算出 `cost.total = 0` → `pi.ts:211` `costCNY: 0`（**不是 undefined**）→ `0 > 10` 恒假。
**场景**：租户通过 `PUT /v1/providers/{id}` 注册一个自建端点（`ModelSpec.price` 是 optional，`provider.ts:35`）且不填 price → 这个 agent 的成本安全阀**完全不存在**，只剩 maxSteps/maxToolCalls/wallClock 兜底。§6.3 把 `maxCostCNY` 列为内核不变量。
**修复**：`ResolvedModel` 上带一个 `hasPriceTable` 标志；无价表时要么拒绝启动 turn（严格），要么退化为 token 预算（`maxTotalTokens`）并在 `turn/completed` 里标注成本未知。另外单位要写死（预设里是 CNY/百万 token，`presets.ts:17`），BYOK 配置校验时明确要求 CNY。

### M4 [medium] `onAssistantMessage` 会用空 text 覆盖已流出的 agentMessage，并抹掉 `partialText`

`host.ts:400-405`：条件是 `msg.text || state.agentItemId`，所以只要这一 step 流过字，即使 `msg.text === ""` 也会写 `text: ""` 覆盖该 item，并 `state.lastText = ""`。触发路径：任意 sink 抛错（如 B1 的 FenceError）→ pi `agent.js:361-377` `handleRunFailure` 造一条 `content:[{type:"text",text:""}]`、`stopReason:"error"` 的假 assistant message → `message_end` → 再次进 `onAssistantMessage` → item 文本被清空、`lastText=""` → `finishTurn:616` 的 `turn.partialText` 变 `undefined`（违反 §6.3「触发后优雅终止：带 `partialText` 的 `turn/completed`」）。`finishTurn:620-623` 只在 `stopReason !== "end_turn"` 时用 `state.agentText` 补回 item 文本，turn 上的 `partialText` 却补不回来。
**修复**：`if (msg.text)` 才覆盖文本，空文本只更新 status；`state.lastText` 只在非空时赋值；`finishTurn` 用 `state.agentText || state.lastText`。

### M5 [medium] `assignItemSeqs` 的兜底会给新 item 赋上一条**旧事件**的 seq

`packages/store/src/types.ts:56-61`：`it.seq = ev ? ev.seq : lastSeq`。当一个批次**只有 items 没有 events**（`store.ts:172` 跳过 events insert，`seq` 保持 `sessions.last_seq`）时，所有新 item 都拿到上一条无关事件的 seq。今天恰好没有这种调用（`onToolExecutionStart:435` 传的 item 已有 seq，会被 `if (it.seq !== 0) continue` 跳过），但这是一个随时会被踩的雷：同批多个新 item 会**共享同一个 seq**，且 `seq > afterSeq` 游标会把它们整批漏掉。
**修复**：无 events 的批次里出现 `seq === 0` 的 item 直接抛错（fail fast），或者为 items 单独推进一个 seq（占 seq），二者都比静默复用上一条事件的 seq 好。

### M6 [medium] `leaseHoldMs`(60s) > `leaseTtlMs`(30s) 且 hold 期间无续期 → 亲和窗口形同虚设

`host.ts:115-116`（默认 30s/60s）、`:666-675`（`scheduleRelease` 只是 60s 后 `release`，期间**没有 renew**，`renewTimer` 已在 `finishTurn:600` 清掉）。
**后果**：租约在 turn 结束后 ≤30s 就自然过期，`getOwner`（`lease.ts:57-61`，读的就是 `lease:{sid}` 这个 hash）返回 null → router 失去 §4.2 要求的 `owner:{sessionId}`（TTL 略长于 lease）定向能力 → 每次跨 turn 都可能随机落点、冷启动上下文。同时 30–60s 之间别的 runner 可以正常抢占，而本机的 `holdTimers` 仍以为自己持有（`release` 里的 owner 校验会让它空转，不会误删，所以不造成损坏）。另外 §4.2 提到的 `owner:{sessionId}` 键**在实现里根本不存在**。
**修复**：hold 期间继续以低频续期（如 `leaseTtlMs/3`）直到 hold 到期；或令 `leaseHoldMs = min(leaseHoldMs, leaseTtlMs * 0.8)` 并在配置加载时校验；补上 `owner:{sid}` 目录键（TTL = lease TTL + hold）。

### M7 [medium] 5000 条 item 硬截断 + 压缩未实现 + `lastCompactionSeq` 死代码

`host.ts:261`：`listItems(sessionId, { afterSeq: lastCompactionSeq(session), limit: 5000 })`；`host.ts:734-737`：`session.metadata.lastCompactionSeq` **全仓无任何写入方**（已 grep 确认），`contextCompaction` item 也从未被创建 → 这段是为 §6.4 预留的死代码，函数本身逻辑（`v-1`，让 compaction item 自己进投影）是自洽的，问题在于它永远返回 `-1`。
**后果**：长 session 上 `listItems` 取的是 **seq 最小的 5000 条**（`ORDER BY seq ASC LIMIT 5000`），也就是**最旧的**那批；超过 5000 条之后，模型看到的是远古历史，最近几十轮对话被静默丢弃。`pruneToolResults`（`history.ts:107-129`）只截断 toolResult 内容，从不删 user/assistant 文本，所以当历史本身以文本为主时它无法收敛到预算，请求照发 → provider 侧 400/截断，§6.3 的"优雅终止"覆盖不到这条。
**修复**：短期把 `limit: 5000` 改为"取最后 N 条"（`ORDER BY seq DESC LIMIT N` 再反转）并在投影后校验首条不是 `toolResult`（否则丢弃首个不完整 step）；中期落实 §6.4 的摘要级压缩并真正写 `lastCompactionSeq`；`pruneToolResults` 无法收敛时应主动触发 `max_context` 型优雅终止而不是硬发请求。

### M8 [medium] 被中断的工具批次里，未派发的 `toolCall` item 永久停在 `inProgress`

`agent-loop.js:427-429 / 447-449`：parallel 路径里一旦 `signal.aborted` 就 `break`，剩余 toolCall **不会** emit `tool_execution_start`/`tool_execution_end` → host 的 `onToolResult` 不被调用 → 这些 item 没有 `item/completed`、状态永远 `inProgress`；`finishTurn:620-623` 只修 agentMessage。
**后果**：`GET /items` 里永久出现 inProgress 的工具调用；等 `item/completed` 才收起 spinner 的客户端永久挂着。好消息是**下一 turn 的投影会自愈**（`history.ts:41-55` 合成 `TOOL_NOT_STARTED`，因为 `startedAtMs` 未设），模型侧不受影响。
**修复**：`finishTurn` 里把 `state.toolCallItems` 中所有仍 `inProgress` 的 item 落成 `declined`/`failed` 并补 `item/completed` 事件（同一批 commit 里）。

### M9 [medium] `onToolArgsDelta` 在"纯工具调用"的 step 里被整体丢弃

`host.ts:386-389`：`if (!state.agentItemId) return;`。模型不输出任何文本、只发 tool_call 时 `agentItemId` 为 undefined → **全部 `item/toolCall/argsDelta` 被丢掉**（这恰好是 agentic 工作流里最常见的 step）。而且它挂的 `itemId` 是 agentMessage 的 id 而不是 toolCall 的 id，语义上也不对（delta 时 toolCall item 还不存在）。
**修复**：给每个 toolCallId 预分配一个 item id（在首个 `toolcall_delta` 时生成并记在 `state` 里），`argsDelta` 用它，`onAssistantMessage` 复用同一个 id；去掉对 `agentItemId` 的依赖。

### M10 [medium] `sessionPatch.metadata` 整体覆写，任何第二个 metadata 写者都会丢更新

`host.ts:515`/`:524`：`metadata: state.session.metadata`，其中 `state.session` 是 turn 开始时的**快照**（`host.ts:285` 起）。MySQL 侧 `store.ts:190` 是整列替换。今天只有 `autoApprovedTools` 一个写者所以看不出问题，但 §6.4 的 `lastCompactionSeq`、标题自动生成、任何后台任务写 metadata，都会被一次 `acceptForSession` 整块覆盖回旧值。
**修复**：把 `autoApprovedTools` 从 `metadata` 挪到一个独立的 session 列/表，或者 `sessionPatch` 支持 `metadataMerge`（在事务里 `JSON_MERGE_PATCH`）。

### M11 [medium] `startTurnLocked` 在 `clearHold` 之后抛错 → 租约悬挂、无续期、无释放

`host.ts:240-243` 拿到租约并 `clearHold`（取消了原本的释放定时器），之后 `providers.resolve`（`:252`）、`skills.list`（`:257`）、`listItems`（`:261`）任何一处抛错都会直接 `throw`，此时：租约在 Redis 上还有 TTL（30s），`renewTimer` 尚未创建，`holdTimers` 已被清空 → **没有任何路径会主动 release**。这 30s 内该 session 对其他 runner 返回 409，router 反复重路由。（`:302-306` 的 catch 只覆盖第一次 commit。）
**修复**：把 `clearHold` 之后的整段包进 try/catch，失败时 `lease.release` 或重新 `scheduleRelease`。

### M12 [medium] `interrupt()` 无超时地 `await state.done`

`host.ts:587`。如果某个工具的 `execute` 不理 `ctx.signal`（内置工具/远程 MCP 很容易这样），`state.done` 要等它跑完；若 `finishTurn` 的 commit 卡在 DB 上也一样。HTTP `POST .../interrupt` 因此可能挂很久（连接超时后客户端无法判断是否已中断）。
**修复**：`Promise.race([state.done, sleep(2000)])`，超时后返回当前 turn 快照 + `status:"interrupting"`。

### L1 [low] 错误事件带 `seq: 0`，会诱导客户端用 `Last-Event-ID: 0` 全量重放

`app.ts:169` 构造 `{type:"error", ..., seq: 0}`，`sse.ts:27` 于是写 `id: "0"`。客户端断线重连时带上它 → `after=0` → `readEvents(sessionId, 0, 500)` 把整个 session 重放一遍。
**修复**：这类本地错误事件不要带 seq（`id` 留空）。

### L2 [low] `exclude=session/status/changed` 会让流式 turn 永不结束

`app.ts:160-163` 的关闭条件依赖该事件，而 `exclude`（`host.ts:177`）在计数之前就 return 掉了。客户端一旦过滤这个类型，SSE 就只能靠心跳挂到超时。（H2 的修复建议——改用 `turn/completed` 且校验 turnId——同时解决这条。）

### L3 [low] shutdown 顺序与 `draining` 检查后的窗口

`main.ts:40-47` 先 `drain()` 再 `server.close()`，整个 drain 期间仍在收请求；且 `startTurnLocked:220` 的 `draining` 检查之后有多个 await，一个刚好挤进来的请求能在 `drain()` 判定 `active.size===0` 之后才注册进 `active`，随后 `process.exit(0)` 把它腰斩成孤儿 inProgress turn。
**修复**：`ready=false` → `server.close()`（停止新连接）→ `drain()`；`drain` 结束后再检查一次 `active.size`。

### L4 [low] `pruneToolResults` 的 `keepRecent` 边界

`history.ts:120`：`assistantIdx.at(-keepRecent) ?? out.length`。只有 1 条 assistant 时 `at(-2)` 为 undefined → `protectedFrom = out.length` → 连"最近"的 toolResult 也会被截断（与注释 "Never touches the last keepRecent steps' results" 相反）。

### L5 [low] bus 的热重放能力在 host 里从未启用

`host.ts:188` 调 `bus.subscribe(sessionId, cb)` 不传 `afterSeq` → `RedisEventBus` 的 `XRANGE` 分支（`bus.ts:72-95`）永远不走，`SessionHostConfig.hotReplayWindowMs`（`host.ts:51`）是死配置。历史事件全部来自 MySQL，功能上正确（§4.4 的兜底路径），但 Redis Streams 的成本白付了。

### L6 [low] `maxOutputTokensPerStep` 默认 8192 无条件生效

`mergeLimits`（`common.ts:84`）在三层都没给值时返回 8192，`pi.ts:37` 以 `maxTokens` 覆盖掉 pi/模型自己的上限。对 `deepseek-reasoner`（`maxOutputTokens: 32_768`）这类模型，thinking + 输出共享 8192 会频繁 `stopReason:"length"` → `host.ts:424` 置 `max_output_tokens` → turn 提前结束。建议默认值取 `min(8192, model.maxTokens)` 或干脓不设默认、由模型上限兜底。

### L7 [low] `gateToolCall` 的两处细节
- `host.ts:470` 的 `if (!tool)` 分支对 PiEngine 是死代码：pi 在 `prepareToolCall`（`agent-loop.js:481-487`）就先返回 "Tool not found"，根本不会调 `beforeToolCall`。
- `maxToolCalls` 会**少计**：被 `failToolCallsFromTruncatedMessage`（length 截断）处理的调用、以及 abort 后 `break` 跳过的调用都不进 `gateToolCall`。安全阀只会偏松不会偏严，可接受，但要写进文档。反过来被 decline 的调用**会**计入 `state.toolCalls`（`:471` 在审批之前自增），语义可议。

### L8 [low] `pi.ts:45` 的 `queueMicrotask(() => agent.abort())` 会吃掉 block 原因

`beforeToolCall` 返回 `{block:true, reason:"tool call limit reached", terminate:true}`，但 abort 的 microtask 排在 `await config.beforeToolCall` 的恢复之前，于是 `agent-loop.js:498-504` 的 `if (signal?.aborted)` 先命中，返回的是通用的 `"Operation aborted"`，`reason` 和 `terminate` 双双丢失。模型的 transcript 里看不到"因为达到工具调用上限"这个事实（host 的 `stopReason` 仍然正确，因为走 `limitHit`）。
**修复**：先 `return {block:true,...}`，把 abort 放到 host 侧（`gateToolCall` 里直接 `state.abort.abort()`），或用 `setTimeout(...,0)` 让它排在恢复之后。

---

## 三、需要进一步验证的疑点

1. **`handleRunFailure` 重入 `onAssistantMessage` 的确切触发面**（关联 M4）。已确认：sink 抛错必然触发。未确认：pi-ai 的 `streamSimple` 在"流中途网络断开"时是走 `error` 事件 + `response.result()` 返回部分消息（不抛，走正常 `message_end`），还是直接抛（走 `handleRunFailure`）。需要一个注入故障的 `fetch` 做端到端验证，这决定了 M4 在生产里的实际频率。
2. **Redis pub/sub 乱序把低 seq 事件吃掉**。`host.ts:175-182` 的 `delivered` 是单调游标：一旦先收到高 seq，后到的低 seq 会被静默丢弃形成**永久空洞**（客户端不会察觉）。同一 `pub` 连接 + `publishAll` 串行 await 理论上保序，但跨 Redis Cluster 节点/failover/`multi().exec()` 部分失败时未必。建议加一条 metric（`delivered_gap_total`）观测，而不是假设。
3. **`approval/requested` 已 publish 但 `pendingApprovals` 尚未登记的微秒窗口**。`host.ts:491-506`：事件在 `commit` 内部 publish，`pendingApprovals.set` 在 commit resolve 后的同一微任务链上。理论上一个极快的客户端可以在这之间发 `resolveApproval`，得到 `session_lease_conflict`。实践上 `resolveApproval` 自己要先做一次 `getSession`（DB 往返），窗口应该被吃掉。需要一个"事件发出即回调"的压测确认。
4. **MySQL `commit` 事务的锁粒度与吞吐**。`store.ts:156-159` 的 `SELECT ... FOR UPDATE` 把整个 session 行锁到事务结束，事务里还串行做 N 次 `upsertItem`（`:178` 是 for 循环里逐条 query）。单 session 串行是正确性所需，但 `onToolResult` 带大 content 时事务会拉长，叠加 `innodb_lock_wait_timeout` 有超时风险；`items` 的批量 upsert 应该合并成一条多值 INSERT。需要压测确认。
5. **`state.chain` 在 fence 丢失后继续执行后续 commit** 是否还有别的副作用。当前看来每次 commit 的 batch 都是自包含的（seq 由 store 分配，`lastSeq` 只在成功时更新），所以"前一次失败、后一次照跑"不会写出错位的 seq；但 `turn.seqEnd`（`host.ts:635-636`）依赖上一次 commit 的返回值，若第一次 commit 失败则 `seqEnd` 保持 undefined 而第二次 commit 仍会把 turn 写进去——需要确认 `seqEnd` 为空的 turn 在 §5 协议里是否可接受。

---

## 四、已核查且判定为正确的部分（覆盖声明）

**并发控制**
- `startTurn` 的 `startQueue` 串行化（`host.ts:208-217`）是正确的：队列注册发生在第一个 await 之前，同 runner 的并发 `startTurn` 不可能同时通过 `active` 检查。已有测试 `host.test.ts:231` 覆盖。（这正是"同 runner 同 owner 拿到同一个 fence、租约保护不了它"这一空洞的正解。）
- `commit()` 的 `state.chain` 确实保证了同一 turn 内 commit 与 publish 的严格顺序，因此 seq 分配顺序 == 投递顺序（对持久化事件成立）。
- `state.session.lastSeq` 在 `closeOrphanedTurn`（`:663`）里同步回写到同一个对象上，所以 `turn.seqStart = session.lastSeq + 1`（`:272`）取到的是修复后的值，不会重叠。
- `finishTurn` 的 `finally`：`active.delete` 用了 `=== state` 的身份校验（`:640`），不会误删后继 turn 的条目；`resolveDone()` 在 `scheduleRelease()` **之前**同步调用，而 `await Promise.all(...done)` 的恢复是微任务，因此 `drain` 恢复时 `holdTimers` 已经登记完毕，租约一定会被释放。这个顺序是对的。
- `renewTimer`/`wallClockTimer` 的创建（`:309-320`）在 `void this.runEngine(...)`（`:323`）**之前**，所以不存在"finishTurn 先清理、startTurn 后创建"导致定时器永久泄漏（那会让一个已结束的 turn 无限续租、永久钉住 session）。所有正常/异常退出路径都经过 `finishTurn` 的 `clearInterval`/`clearTimeout`。
- 双重 finish 不可能：`finishTurn` 只由 `runEngine` 在 `await run.done` 之后调用一次。`interrupt` 与自然结束竞争时，`interrupt` 只置标志 + abort + `await state.done`，不自己收尾。
- `DynamicToolBridge` 的 abort 监听（`dynamic.ts:25-30`）是正确的：租约丢失/中断时动态工具会立即以 `aborted` 收尾，不像审批那样卡住。

**事件与投影**
- `SessionHost.subscribe`（`host.ts:185-199`）"先挂 bus、后读 store、最后回放 buffer"的顺序没有空洞：事务已提交但未 publish 的事件由 store 读到；事务未提交的由 live 补上；交叉部分由 `delivered` 按 seq 去重。已有测试 `host.test.ts:304` 覆盖。
- `RedisEventBus.subscribe` 的 `unsubscribe`/`subscribe` 竞争是安全的：`set.size===0` 的判断与 `set.add` 都在同一事件循环 tick 内，且 ioredis 在同一连接上保序，不会出现"新订阅者被旧订阅者的 unsubscribe 顶掉"。
- `projectItems` 的 `toolResult` 配对（`history.ts:32-33, 41-56`）**与 seq 顺序解耦**：`results` 映射预先建好，`flushGroup` 按模型给出的 `g.calls` 顺序紧跟 assistant 消息输出。因此并发工具的乱序 dispatch / 乱序落库都不会破坏 chat-completions 的 "tool result 必须紧跟其 call" 约束（§6.4 的"并发 commit 顺序"要求满足）。
- 不会出现 assistant→assistant：文本-only 的 step 会让 pi 的内层循环结束（`hasMoreToolCalls=false` 且无 steer/follow-up），所以同 turn 内连续的两个 assistant 组之间必然夹着 toolResult；跨 turn 之间必然夹着 userMessage。
- steer 插入的 `userMessage`（`host.ts:565`）虽然带了 `step`，但 `projectItems` 对 `userMessage` 一律 `flushGroup()`（`history.ts:67-72`），不会被并进某个 step 的 assistant 组，也不会把一个 step 拆成两个组。
- 崩溃时停在 `inProgress`、`text:""` 的 agentMessage 会被 `flushGroup` 的空消息检查（`history.ts:39`）丢掉，不会产生一条空 assistant 消息毒化上下文。
- `lastCompactionSeq` 的 `v-1` 语义与 `ContextCompactionItem.replacesUpToSeq` 自洽（compaction item 自己要进投影变成 system 摘要）——是死代码，不是逻辑错误。

**租约与 fencing**
- `RedisLeaseStore` 的三个 Lua 脚本（`lease.ts:4-27`）都是正确的：`ACQUIRE` 用 `HGET owner` 做互斥、同 owner 走 `PEXPIRE` 续期并复用 fence、新 owner 走 `INCR` 单调递增；`RENEW`/`RELEASE` 都带 owner 校验，过期后被别人拿走时既不会误续也不会误删。`{sid}` hash tag 保证两个键同槽。已有测试 `conformance.ts:128, 153`（10 并发只有 1 个成功）覆盖。
- MySQL `commit` 的 fence 语义正确：事务内 `FOR UPDATE` 锁 session 行 → 比较 `batch.fence < currentFence` 则抛 `FenceError` → 允许相等（同 owner 重入）→ events 的 seq 在同一事务内分配、`(session_id, seq)` 是主键。跨 runner 双写在存储层被彻底挡住（§4.2 的核心不变量成立）。缺陷只在 host 对 `FenceError` 的**反应**上（B1）。
- `closeOrphanedTurn` 用的是**刚刚抢到的新 fence**（`host.ts:247` 传入），所以它对旧 owner 的抢占是安全的：commit 会把 `fence_token` 推高，旧 owner 后续所有写入全被拒。§4.3「runner 崩溃（turn 中）」的处理路径（标记 interrupted + 过期未决审批 + 发 `turn/completed{interrupted}`）与设计一致。
- 跨 runner 的 `closeOrphanedTurn` 不会打到"活着的 owner"：活 owner 的租约未过期时 `lease.acquire` 先失败并抛 409，根本到不了 `closeOrphanedTurn`。（同 runner 的那条竞态见 H2。）

**安全阀**
- `maxSteps` **不会**超一步：pi 在 `agent-loop.js:179` 于每个 step 边界、**下一次模型调用之前**调 `finishTurn` → host 的 `onStepEnd`（`host.ts:455-462`）；`step >= maxSteps` 即 `end`。`maxSteps=1` 时只跑 1 步。
- `limitHit` 在下一次工具执行前也会被拦：`gateToolCall:469` 开头就检查，并带 `interrupt:true`。
- `finish_reason=length` 丢弃**全部** tool call（§6.3）由 pi 的 `failToolCallsFromTruncatedMessage`（`agent-loop.js:163-164, 340-360`）保证，host 不需要重复实现；host 只在 "length 且无 tool call" 时置 `max_output_tokens`，是合理分工。
- `stopReason` 的优先级（`host.ts:607-612`：interrupted > limitHit > error > aborted）是对的：限额触发时会 abort，但 `limitHit` 优先，所以不会把 `max_tool_calls` 错报成 `interrupted`。
- 审批超时→`decline`、`cancel`→`interrupted`、`acceptForSession` 落 metadata 并在下一 turn 生效（`host.ts:285` 读 / `:515` 写，读写路径一致），均与 §6.3 / codex 语义相符，已有测试 `host.test.ts:121,156,169` 覆盖。

**SSE**
- 心跳在 `close()` 之后不再写（`sse.ts:52-54` 检查 `accepting && !aborted`），并在 finally 里 `clearInterval`——不存在"关闭后仍然心跳"。
- `drain()` 的 `writing` 链把 `.catch(()=>{})` 挂在返回值上，所以 `await drain()` 不会抛；客户端中途断开时 `aborted=true` 让 while 循环立刻退出，不会对已关闭的 stream 死写。
- 正常结束路径不丢事件：`finishTurn` 的 `turn/completed` 与 `session/status/changed{idle}` 在 `publishAll` 里按序投递，两条都在 `accepting=false` 之前入队；`finishTurn` 的第二次 commit（`:636`）不带 events，不会有"关闭后还有事件要发"的情况。
