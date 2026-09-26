# 评审 06：agent-router 反向代理与集群测试的证明力

- 评审对象（全部新写、未评审代码）：`apps/agent-router/src/{app,registry,config,main}.ts`、契约另一侧 `apps/agent-runner/src/{app,sse}.ts`、`test/cluster/{harness,takeover}.ts`、`packages/store/src/redis/lease.ts`
- 对照契约：`docs/design/00-architecture.md` §3（服务边界）、§4.2（所有权：路由只是优化，正确性靠租约 + fencing；runner 回 409 + `X-Owner`，router 重路由一次）、§4.3（故障场景表）、§4.4（事件扇出与重放）、§5（SSE `id: <seq>` / `Last-Event-ID`）
- 方法：逐行追踪 + 4 组可执行探针（Hono 路由/路径归一化、`Headers` 复制语义、MySQL 排序规则、@hono/node-server 2.1.1 响应流实现），探针脚本跑完已删除。

## 探针实测结论（全部复现）

| 探针 | 断言 | 实测 |
|---|---|---|
| R1 | `/v1/sessions/SESS_<大写UUID>/turns` 能否被 `SESSION_PATH` 匹配 | **否**（router 认不出 sessionId）；而 runner 的 Hono `:id` 拿到 `SESS_...`，返回 200 |
| R2 | MySQL `session_id` 比较是否大小写不敏感 | **是**。本机 8.0.26，`@@collation_server=utf8mb4_0900_ai_ci`，`'sess_abc' = 'SESS_ABC'` → `1`；DDL 未写 `COLLATE` |
| R3 | `/v1/sessions/sess%5F…/turns`、`/v1/sessions/%73ess_…/turns` | router 正则**不匹配**；Hono `c.req.param("id")` **会解码**成规范 id → runner 能查到会话 |
| R4 | `Headers.forEach` + `set()` 复制是否保留多个 `set-cookie` | **否**。源 `getSetCookie()=["a=1","b=2"]`，复制后只剩 `["b=2"]` |
| R5 | router 回给客户端的 SSE 是否流式、是否有背压 | **是**。node-server 2.1.1 `writeFromReadableStreamDefaultReader` 用 `writable.write()` 返回值 + `drain` 事件做背压；不缓冲整个 body |
| R6 | `//v1/sessions/…`、`/v1//sessions/…`、`…/turns/`、`…%2Fturns` | router 不匹配 → 打任意 runner → runner 一律 404，无绕过 |

---

## 一、已验证的缺陷

### R-B1 [blocker] session id 未做规范化校验 → 「影子租约」→ 同一会话双写者

**位置**：`apps/agent-router/src/app.ts:14`（`SESSION_PATH` 大小写敏感）、`app.ts:53`、`apps/agent-runner/src/app.ts:173-175`（`c.req.param("id")` 原样进业务）、`packages/core/src/session/host.ts:293`（`lease.acquire(sessionId, …)`）、`packages/store/src/redis/lease.ts:43`（`lease:{sid}` / `fence:{sid}` 直接拼 sid）、`packages/store/migrations/0001_init.sql:29`（`session_id VARCHAR(64)`，无 `COLLATE`）

**契约**：§4.1「一个 turn 之内：强制单所有者；不满足 → 两个 writer → seq 冲突、工具重复执行，数据损坏」；§4.2「所有写入 `WHERE fence_token<=?`，旧 fence 的写被拒绝」。

**三个事实叠加**（均已实测）：
1. router 的 `SESSION_PATH` 是大小写敏感的 `sess_[0-9a-f-]{36}`（R1）；
2. MySQL 的 `session_id` 用服务器默认 `utf8mb4_0900_ai_ci`，`WHERE session_id='SESS_ABC'` **命中** `sess_abc` 行（R2）；
3. Redis key **大小写敏感**，`as:lease:{SESS_ABC}` 与 `as:lease:{sess_abc}` 是两把互不相干的锁，`as:fence:{SESS_ABC}` 是一个**独立的计数器**。

**失效场景**（时序具体、每步有代码依据）：

设真实会话 `sess_0199…4a5b`，当前 `sessions.fence_token=1`，runner A 正在跑 turn（持有 `as:lease:{sess_0199…}`，fence=1，`as:fence:{sess_0199…}=1`）。

1. 任意客户端（同租户即可，不需要越权）发 `POST /v1/sessions/SESS_0199…4A5B/turns`。
2. router：`SESSION_PATH.exec` 返回 `undefined`（R1）→ `sessionId=undefined` → 走 `app.ts:59` 的 `anyHealthy(url.pathname)` → 打到 **runner B**（与所有权目录无关）。
3. runner B：`c.req.param("id") = "SESS_0199…4A5B"` → `host.getSession` → `SELECT * FROM sessions WHERE session_id=? AND tenant_id=?` → **ci 命中真实行**（R2），租户校验通过。
4. runner B：`lease.acquire("SESS_0199…4A5B", …)` → Redis key `as:lease:{SESS_0199…4A5B}` 不存在 → `INCR as:fence:{SESS_0199…4A5B}` → **fence=1** → 获锁成功。此时 A 与 B 都认为自己是唯一 writer。
5. runner B 发现 `session.status.type==="active" && !this.active.has(sid)`（`host.ts:296-299`）→ 调用 `closeOrphanedTurn`，把 A **正在跑的** turn 改写成 `interrupted / owner_lost`，并把 session 置 `idle`。
6. 这次 commit 的 fence=1，而 `store.commit` 的判据是 `if (batch.fence < currentFence) throw FenceError`（`packages/store/src/mysql/store.ts:191`）。`1 < 1` 为假 → **commit 通过**。
7. 之后 A、B 两个 runner 同时对同一会话写 items/events/turn 行。`SELECT … FOR UPDATE` 只保证 seq 不重号，不保证不交错：两个 turn 的 item 互相插队、工具被执行两遍、`sessions.status` 互相覆盖。

关键点：两个 fence 计数器**各自独立且步调一致**（每次抢占各 +1），DB 的 `<` 判据永远不成立，**fencing 机制被完全绕过**——这正是 §4.1 点名的「数据损坏」。不需要并发也能造成持久损害：只要客户端持续用大写 id，这个会话就永久存在两个所有权命名空间。

补充变体：在 `utf8mb4_general_ci` 的部署（MySQL 5.7 / MariaDB，PAD SPACE）上，实测 `'sess_abc ' = 'sess_abc'` → `1`，即**尾随空格**（`…4a5b%20`）也是同一个绕过；`0900_ai_ci` 是 NO PAD，故本机不复现该变体。

**建议修复**（三层，缺一不可）：
1. runner 侧在 `:id` 上做严格校验：`z.string().regex(/^sess_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)`，不合规直接 404（与 §5.5「跨租户与不存在不可区分」一致）。这是唯一必须的修复点。
2. DDL 给所有 id 列显式 `COLLATE utf8mb4_0900_as_cs`（或 `utf8mb4_bin`），并加迁移。
3. router 侧把 `SESSION_PATH` 放宽成 `/^\/v1\/sessions\/([^/]+)(\/|$)/` 后再按严格 id 形状判定：形状不对就 400，而不是静默降级成「任意 runner」。

### R-B2 [blocker] router 无请求体大小限制，且先整体缓冲再转发

**位置**：`apps/agent-router/src/app.ts:56`（`new Uint8Array(await c.req.arrayBuffer())`）；对比 runner 侧 `apps/agent-runner/src/app.ts:85` 有 `bodyLimit({ maxSize: deps.maxBodyBytes })`（默认 1 MB，`config.ts:19`）。router 的 `config.ts` 没有任何 `MAX_BODY_BYTES`。

**契约**：§3 服务边界表——router 是唯一对外开放的服务，扩缩容依据是「连接数 / QPS」；runner 的 body limit 设计前提是「到达 runner 的请求已经过 router」。

**失效场景**：单个客户端 `POST /v1/sessions/sess_…/turns`，`Transfer-Encoding: chunked`，持续发送 4 GB 随机字节。router 在 `app.ts:56` 把全部字节收进一个 `Uint8Array`（Node 的单 Buffer 上限约 4 GB，但常驻内存在此之前就爆），runner 的 1 MB 限制**一次都没被触发**，因为 router 在转发之前就 OOM 了。N 个并发连接把每个 router 副本逐个打死；`/readyz` 在进程死之前一直返回 ready，所以 LB 不会提前摘流。

同一行还带来第二个后果：即使体积正常，也是**先收全再转发**，一个 10 MB 的 turn 输入要等 router 收完才开始打 runner，端到端 TTFT 无谓翻倍。

**建议修复**：router 加 `bodyLimit`（上限取 runner 的 `MAX_BODY_BYTES`，由同一个环境变量驱动，超限直接 413）；只有「需要可能重放」的 POST/PUT 才缓冲，其余方法用 `c.req.raw.body` 直通（配 `duplex: "half"`）。

### R-H1 [high] `toUrl()` 依赖 `RUNNER_ADDR` 与 `RUNNERS` 字面量相等，不等时所有权目录与 409 重路由**静默**失效

**位置**：`apps/agent-router/src/registry.ts:104-108`（`toUrl`）、`registry.ts:76`（`owner()` 把 Redis 里的 `addr` 交给 `toUrl`）、`apps/agent-router/src/app.ts:79-84`（`toUrl` 返回 `undefined` 时**没有任何日志**，直接把 409 回给客户端）、`apps/agent-runner/src/config.ts:41`（`runnerAddr = RUNNER_ADDR ?? \`${RUNNER_HOST}:${RUNNER_PORT}\``）

**契约**：§4.2「抢租约失败 → 409 + `X-Owner: <runnerAddr>`，router 重路由一次」；§4.3「路由完全失效（随机落点）→ 每次多一跳」。

**失效场景**：容器化部署里 `RUNNER_HOST` 必须是 `0.0.0.0` 才能被外部访问，而 `RUNNER_ADDR` 是可选的（`config.ts:8`）。运维只设了 `RUNNER_HOST=0.0.0.0`：
1. runner 写进 Redis 的 `addr` 是 `0.0.0.0:8787`（`lease.ts:14` 的 `HSET … 'addr', ARGV[2]`）。
2. router 的 `owner(sessionId)` 拿到 `0.0.0.0:8787`，`toUrl` 在 `RUNNERS=http://10.0.0.7:8787,http://10.0.0.8:8787` 里找不到匹配 → 返回 `undefined` → `app.ts:59` 退化为一致性哈希。**所有权目录对每一个会话都永久失效**，但没有任何日志或指标。
3. 猜错时 runner 回 409 + `X-Owner: 0.0.0.0:8787` → `app.ts:79` 再次 `toUrl` → `undefined` → 不满足 `if (ownerUrl && …)` → `streamBack(res)` 把 409 原样回给客户端。**§4.2 承诺的「重路由一次」一次也没发生**，客户端拿到的是 §5.5 标注为「内部」的 `session_lease_conflict`。
4. 同样的问题在 DNS 名 vs Pod IP（`RUNNERS=http://runner-0.runners.svc:8787`，`RUNNER_ADDR=10.0.0.7:8787`）、带默认端口 vs 省略端口（`http://host` vs `host:80`）下都成立——`toUrl` 是纯字符串比较，不做端口归一化。

集群测试不会发现这一点：harness 显式把 `RUNNER_ADDR` 设成 `127.0.0.1:${port}`（`test/cluster/harness.ts:139`），与 `RUNNERS` 的字面量恰好一致。

**建议修复**：(a) `toUrl` 失败时 `log.warn` 并计数（这是一个必须报警的配置错误）；(b) router 启动时用 `/readyz` 探测每个 runner 返回的自报地址，校验能被 `toUrl` 解析，不能解析就拒绝启动；(c) `X-Owner` 改为携带 runner **自报的完整 base url**，而不是 `host:port`；(d) runner 侧在 `RUNNER_HOST` 为 `0.0.0.0`/`::` 而 `RUNNER_ADDR` 未设时直接启动失败。

### R-H2 [high] interrupt / steer / approvals / tool-results 的 409 不带 `X-Owner`，router 无法重路由

**位置**：`packages/core/src/session/host.ts:681`（`resolveApproval` → `session_lease_conflict`，**无 ownerAddr**）、`host.ts:698`（`steer` → `not_found`）、`host.ts:714`（`interrupt` → `session_lease_conflict`，无 ownerAddr）、`apps/agent-runner/src/app.ts:59-64`（只有 `details.ownerAddr` 存在时才写 `X-Owner`）、`apps/agent-router/src/app.ts:77-85`

**契约**：§4.2 把「409 + `X-Owner` → router 重路由一次」定义为**唯一**的正确性兜底；§4.3「客户端断开 SSE ≠ 取消；显式取消走 `POST .../interrupt`」——也就是说 interrupt 必须可达。

**失效场景**：router 在 `REDIS_URL` 未配置时（`apps/agent-router/src/config.ts:9` 允许 optional，`main.ts:23` 会打印 `directory=hash-only`）只按一致性哈希路由。
1. 会话 `sess_X` 的哈希落点是 runner B，但真正的 owner 是 A（上一个 turn 在 A 上起的，`leaseHoldMs` 亲和窗口内）。
2. 客户端要取消：`POST /v1/sessions/sess_X/turns/turn_Y/interrupt` → router → B。
3. B 的 `this.active` 里没有这个 turn → `host.ts:714` 抛 `session_lease_conflict`，**details 里没有 ownerAddr**。
4. runner `app.ts:60` 的条件 `err.code === "session_lease_conflict" && owner` 不成立 → 不写 `X-Owner`。
5. router `app.ts:78` `res.headers.get("x-owner")` 为 null → 不重路由 → 客户端收到 409。**用户点了「停止」，turn 却继续跑到底**，还继续计费（§4.3 的 `max_cost` 阀门救不了已发出的请求）。
6. `steer` 更糟：`host.ts:698` 抛的是 `not_found`，router 完全没有机会识别，客户端拿到的 404 与「turn 真的不存在」无法区分。

即使配了 Redis，`owner()` 也会在 R-H1 的地址不匹配、或 Redis 读失败（`registry.ts:78`）时退化到同一条路径。

**建议修复**：`resolveApproval`/`interrupt`/`steer`/`tool-results` 在本 runner 无该会话时，统一 `lease.getOwner(sessionId)` 查一次目录，命中则抛 `session_lease_conflict` 并带 `ownerAddr`；未命中再按 404/409 处理。router 侧对这些路由同样走 `X-Owner` 重路由（它们都是幂等或近幂等的控制面请求，重放安全）。

### R-H3 [high] `/_router/targets` 未鉴权：拓扑泄露 + 跨租户会话存在性预言机

**位置**：`apps/agent-router/src/app.ts:43-49`

**契约**：§5.5「404 not_found（跨租户与不存在不可区分）」；runner 侧 `apps/agent-runner/src/app.ts:62` 的注释明确写「外部客户端不得知道内部拓扑」。

**失效场景**：
1. `GET /_router/targets` —— 无任何 `Authorization`，返回 `deps.registry.list()`，即**全部 runner 的内网 base url、健康状态、连续失败计数**。这是内网横向移动的现成侦察接口。
2. `GET /_router/targets?sessionId=sess_<猜测或泄露的 id>` —— `registry.owner()` 直接查 Redis，**完全不做租户校验**。返回 `owner != null` 就证明「这个会话存在且当前有 runner 持租约」；返回 `null` 则不存在或空闲。租户 B 用泄露的 id 就能探测租户 A 的会话是否活跃，绕开了 §5.5 精心设计的 404 不可区分性。
3. 同一个接口是未鉴权的 Redis 读放大：每个请求一次 `HGET`，可用来打满 Redis 连接。

**建议修复**：`/_router/targets` 要求运维凭据（独立的 admin token 或仅绑定在 loopback/管理端口上）；`sessionId` 查询整段移除，或至少先把请求转给 runner 做租户校验再回填。

### R-H4 [high] 响应未剥离 `X-Owner`，内部 runner 地址直接回给外部客户端

**位置**：`apps/agent-router/src/app.ts:18`（`STRIP_RESPONSE` 不含 `x-owner`）、`app.ts:86`/`124-130`（`streamBack` 原样复制）

**契约**：§4.2 说 `X-Owner` 是 router 读的内部头；`apps/agent-runner/src/app.ts:61-64` 特意把 `details` 从 body 里删掉，注释是「外部客户端不得知道内部拓扑」——但那个头本身没人删。

**失效场景**：客户端 `POST /v1/sessions/sess_X/turns`，router 第一跳猜错，第二跳（`attempt === maxAttempts`，默认 2）又拿到 409 + `X-Owner: 10.0.0.7:8787` → `app.ts:86` `streamBack` → 客户端响应头里就有 `X-Owner: 10.0.0.7:8787`。runner 费力从 body 里删掉的信息，从 header 原路泄出。同理 R-H1 场景下每一次 409 都泄露。

**建议修复**：把 `x-owner` 加入 `STRIP_RESPONSE`（并把内部头统一约定为 `x-internal-*` 前缀，整段前缀剥离）。

### R-H5 [high] 网络失败后重放非幂等 `POST /turns`：可能产生两个 turn；有 Idempotency-Key 时会把 key 毒化 24h

**位置**：`apps/agent-router/src/app.ts:56`（缓冲 body 以便重放）、`app.ts:67-73`（`catch` → `pickOther` → 换 runner 重发**同一个 POST body**）、`apps/agent-runner/src/app.ts:178-199`（幂等预留/完成/释放）

**契约**：§3 第 2 条把「幂等：Idempotency-Key 预留（Redis）」划给 **router**；§5.2「`Idempotency-Key` 建议必填」。实现里 router 完全不参与幂等，却是唯一会自动重放请求的一方。

**失效场景 A（无 Idempotency-Key，客户端未带）**：
1. router → runner A `POST /v1/sessions/sess_X/turns`（`stream:false`）。
2. A 完成 `beginTurn`：抢到租约、`turn/started` 已落库、`begun.run()` 已启动引擎（`agent-runner/src/app.ts:202-203`）。
3. 就在 202 响应写回之前，A 被 SIGKILL（或 pod 被驱逐）→ router 的 `fetch` reject → `app.ts:68` `markFailure` → `pickOther` 返回 runner B → 重发同一 body。
4. A 的租约 TTL 到期后 B 抢占成功 → `closeOrphanedTurn` 把 A 的 turn 记为 `interrupted` → 起**第二个 turn**。
5. 客户端的一次 HTTP 请求产生了两个 turn（一个 interrupted、一个在跑），而且两次都可能已经调过模型/工具——工具副作用执行两遍。§4.3 只承诺「runner 崩溃 → 下一请求由新 runner 抢占」，没有授权 router 自动重放一个非幂等的 POST。

**失效场景 B（带 Idempotency-Key，更严重）**：
1. 同上，A 在 `reserveIdempotencyKey`（`agent-runner/src/app.ts:180`）**成功之后**、`completeIdempotencyKey`（`app.ts:199`）之前被 SIGKILL。注意 `app.ts:196` 的 `releaseIdempotencyKey` 只在 `beginTurn` 抛异常时执行，进程被杀不会执行。
2. router 重发到 B → B 的 `reserveIdempotencyKey` 看到 `r.existing` 且 `existing.turnId` 为空 → `app.ts:182` 抛 `idempotency_conflict`「a request with this key is still in progress」。
3. 该预留的 TTL 是 `24 * 3_600_000`（`app.ts:180`）。客户端用同一个 key 重试，**24 小时内永远得到 409**，而它想发的那个 turn 一个都没跑成。这正是「第一次尝试实际成功（或部分成功）但响应丢了」的最坏分支。

**建议修复**：(a) router 对 `POST /v1/sessions/*/turns` 这类非幂等请求，在**连接失败**（区别于 409 重路由）时不得自动重发，除非请求带 `Idempotency-Key`；(b) 若要保留自动重发，就按 §3 把幂等键预留提到 router，并且 router 在没有客户端 key 时自己生成一个稳定 key 注入下游；(c) runner 侧给 reservation 一个短的「in-progress」TTL（比如 5 分钟）而不是 24 小时，让崩溃留下的预留能自愈。

### R-H6 [high] 上游完全没有超时；而一旦按现有写法开启超时，会切断长 SSE turn

**位置**：`apps/agent-router/src/app.ts:9`（`upstreamTimeoutMs?`）、`app.ts:110-120`（`...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {})`）、`apps/agent-router/src/main.ts:14`（`createRouterApp({ registry, maxAttempts })` —— **从不传 `upstreamTimeoutMs`**）、`config.ts` 里也没有对应环境变量。

**失效场景 A（当前行为：无超时）**：runner 进程还在、TCP 连接能建立，但事件循环被一个同步大 JSON 序列化/交换分区拖住（或磁盘 IO 挂死），不再写响应头。router 的 `fetch` 没有任何 `signal`，undici 的 `headersTimeout` 默认 300 s；300 s 内每个打到这个 runner 的请求都占着一条 router 连接和一份已缓冲的 body。`checkAll` 的 `/readyz` 探测有 2 s 超时（`registry.ts:121`）会把它标 unhealthy，但**已经在飞的请求没人取消**，`markFailure` 也只在 `fetch` reject 后才触发。router 的连接数在 5 min 窗口里被慢上游吃满。

**失效场景 B（一旦有人设置该字段）**：`AbortSignal.timeout` 绑的是整个 `fetch`，包括**响应体的读取**。`forward` 的注释（`app.ts:117-118`）说「SSE 不设超时」，但代码对 SSE 和普通请求用的是同一条路径、同一个 signal。谁给 `upstreamTimeoutMs` 设了 30 s，所有超过 30 s 的 turn（`maxWallClockMs` 默认允许 300 s，§5.3）都会在中途被 router 掐断——而客户端会看到一个"看起来正常"的截断 SSE 流。

**建议修复**：分成两个预算——(a) `headersTimeout`（连接 + 首字节，通过自建 undici `Agent` 设置，几秒级）对所有请求生效；(b) body 阶段不设总超时，只设「两次 chunk 之间的空闲超时」，取值必须大于 runner 的 `SSE_HEARTBEAT_MS`（§3 接入层要求 idle ≥ 90 s）。并且 `upstreamTimeoutMs` 既然没有任何注入路径，要么接上环境变量要么删掉，别留一个会误伤 SSE 的开关。

### R-H7 [high] registry 的 Redis 客户端没有命令超时/离线队列策略，Redis 抖动会拖住每一个带 session 的请求

**位置**：`apps/agent-router/src/registry.ts:52`（`new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false })`）、`registry.ts:73-81`（`owner()` 的 `try/catch` 注释「目录只是缓存；丢了只多一跳」）

**失效场景**：Redis 主节点 failover，客户端进入 reconnect 循环。ioredis 默认 `enableOfflineQueue: true`，`owner()` 里的 `hget` 被放进离线队列；`maxRetriesPerRequest: 2` 只在**连上之后**才开始计数重试，重连本身受 `retryStrategy` 的指数退避控制，没有 `commandTimeout`。于是 `app.ts:59` 的 `await deps.registry.owner(sessionId)` 会挂住数秒到数十秒——**每一个带 sessionId 的请求都挂在这里**，包括本来完全不依赖目录的 `GET /v1/sessions/{id}/events` 重连风暴。注释声称的「只多一跳」在这个路径上不成立：它变成了「多几十秒」。

**建议修复**：`new Redis(url, { maxRetriesPerRequest: 1, commandTimeout: 100, enableOfflineQueue: false, retryStrategy })`，并给 `owner()` 再包一层 `Promise.race` 硬超时。目录既然是缓存，就必须有硬性延迟上界。

---

### R-M1 [medium] 百分号编码可绕过 `SESSION_PATH`：丢亲和 + 把内部错误码直接抛给客户端

**位置**：`apps/agent-router/src/app.ts:14`、`app.ts:52-53`、`app.ts:77`（`res.status === 409 && sessionId`）

**失效场景**（R3 已实测）：客户端（或某个把 `_` 编码成 `%5F` 的 HTTP 库/网关）发 `POST /v1/sessions/sess%5F0199…/turns`。
1. `new URL().pathname` **不**解码 `%5F`，router 正则不匹配 → `sessionId === undefined` → `anyHealthy(pathname)` 随机落点。
2. runner 的 Hono **会**解码 `:id` → 拿到规范 id → 租约 key 与真实 owner 一致 → 正确地回 409 + `X-Owner`。
3. router 的 `if (res.status === 409 && sessionId)` 因为 `sessionId` 是 undefined 而不成立 → 直接把 409 `session_lease_conflict` 回给客户端。§5.5 明确把这个码标为「内部，router 处理」，现在它泄到了外部；客户端也没有任何可行的恢复动作。

与 R-B1 的区别：这一条**不**造成双写（解码后 id 规范，租约 key 相同），只是可用性缺陷。修法同 R-B1 第 3 点：router 用 `[^/]+` 抓路径段，再判形状。

### R-M2 [medium] `maxAttempts` 把「连接失败重试」和「409 重路由」混在一个预算里

**位置**：`apps/agent-router/src/app.ts:62`（循环）、`app.ts:70-73`、`app.ts:80`（`attempt < maxAttempts`）

**失效场景**：`MAX_ATTEMPTS` 默认 2。
1. attempt 1：目标 runner A 正好在滚动发布中被关闭，`fetch` reject → `markFailure` → `pickOther` 返回 `candidate(sessionId)` 或 `healthy[0]`，**这个函数从不重新查询所有权目录**（`app.ts:94-100`）。
2. attempt 2：落到 runner C，C 不是 owner（真正的 owner 是 B）→ 409 + `X-Owner: B`。
3. `attempt < maxAttempts` → `2 < 2` 为假 → 不重路由 → 客户端拿到 409。

一次无关的连接抖动就把 §4.2 承诺的「重路由一次」预算吃光了。`tried` 集合本身是正确的（`app.ts:63` 先 add，`app.ts:80` 和 `pickOther` 都查，能防止回环和重打同一个 runner），问题在预算而不在集合。

**建议修复**：分开两个计数器——`connectAttempts`（默认 2）与 `rerouteAttempts`（默认 1，`X-Owner` 明确时才消耗）；`pickOther` 在 `sessionId` 存在时先重查 `registry.owner()` 再退化到 `candidate()`（这也更贴合 §4.2 「重查目录」的原文）。

### R-M3 [medium] `anyHealthy(url.pathname)` 把所有非 session 请求钉死在同一个 runner

**位置**：`apps/agent-router/src/registry.ts:97-101`、调用点 `apps/agent-router/src/app.ts:59`

**失效场景**：`hash(seed || String(Date.now()))`，而 `seed` 是 `url.pathname`，**永远非空**——所以 `Date.now()` 分支是死代码，函数是**确定性**的。结果：全部 `POST /v1/agents`、`GET /v1/models`、`PUT /v1/tenant/auth`、`POST /v1/sessions`（建会话！）各自恒定落在同一个 runner 上。`POST /v1/sessions` 是高频入口，20M DAU 下它会把一个 runner 的连接和 DB 连接池打满，而其他 runner 空闲；`/readyz` 不会反映这种倾斜。

另外 `healthy[hash % healthy.length]` 的索引基于「过滤后的数组」，一个 runner 变不健康就会让所有路径重新映射——对无状态路由无害，但说明这里既不是一致性哈希也不是负载均衡。

**建议修复**：非 session 路由改成真正的轮询（一个模块级计数器）或 `least-outstanding`；`anyHealthy` 的 `seed` 参数如果不再需要就删掉，别留一个看似随机实则固定的接口。

### R-M4 [medium] router 不做鉴权、不限流、不预留幂等键——§3 分配给它的 1、2 两项职责为空

**位置**：`apps/agent-router/src/app.ts:20-24`（注释「It authenticates nothing itself」）、`app.ts:51`（`app.all("*")` 无条件转发）

**契约**：§3 的 router 方框写得很明确：「1. 鉴权：service key → tenantId；端用户身份 → userId；2. 幂等：Idempotency-Key 预留（Redis）」。

**失效场景**：这不是一个可利用的鉴权绕过（runner 侧 `authMiddleware` 是权威，`apps/agent-runner/src/auth.ts:105-106` 无凭据即 401），但它把**未鉴权流量的成本全部转移到有状态层**：
1. 攻击者对 `POST /v1/tenant/auth` 用随机 Bearer 打 10k QPS。router 全部转发（还会先缓冲 body）。
2. 每个请求在 runner 上触发一次 `api_keys` 表查询（`auth.ts` 的 key 查找）——也就是用未鉴权流量直接打 MySQL，而 runner 的扩缩容依据是「并发 turn 数」，不是 QPS。
3. 没有任何一层能靠 IP/租户维度限流：router 不认识租户，接入层（nginx/envoy）只能做全局限流。

同时 R-H5 说明「幂等在 router」这一条不只是分层洁癖：唯一会自动重放请求的组件恰好是不管幂等的那个。

**建议修复**：要么按 §3 在 router 做 service key → tenantId 解析（缓存在 Redis）+ 租户级限流 + 幂等预留，要么修改 §3 明确记录这个偏离并说明替代方案（例如在接入层按 API key 限流）。现状是文档和代码不一致，而这个不一致有实际后果。

### R-M5 [medium] registry 启动时乐观置 `healthy: true`，`/readyz` 会在第一次探测完成前就说 ready

**位置**：`apps/agent-router/src/registry.ts:48`（`healthy: true`）、`registry.ts:55-61`（`start()` 里 `tick()` 不 await）、`apps/agent-router/src/main.ts:13-15`、`app.ts:31-34`

**失效场景**：所有 runner 都挂了的情况下滚动重启 router：进程起来的瞬间 `targets` 全部 `healthy:true` → `/readyz` 返回 `ready (N runners)` → k8s 立刻把它加进 Service endpoints → 前 5 s（`HEALTH_INTERVAL_MS` 默认 5000）的流量全部打到死 runner，每个请求要等 `fetch` 失败 + 一次 `pickOther` 重试才回 502。`/readyz` 本来就是为了避免这种情况存在的。

连带影响到测试：`test/cluster/harness.ts:172` 的 `waitHttp(router/readyz)` 因此**不证明 router 认得任何 runner**，它只证明进程绑上了端口（见下文测试评估）。

**建议修复**：初始 `healthy: false`，`start()` 返回 `await this.checkAll()` 的 promise 并在 `main.ts` 里 await；`/readyz` 额外要求 `lastCheckMs > 0`。

### R-M6 [medium] 关机不 drain：`server.close()` 后立刻 `process.exit(0)`

**位置**：`apps/agent-router/src/main.ts:16-20`

**失效场景**：`server.close()` 只停止接受新连接，不等在飞请求；紧接着的 `await registry.close()`（几毫秒）和 `process.exit(0)` 会把所有在途的 SSE 流和普通请求硬切。滚动发布时每个 router 副本都会让它承载的全部长连接同时报错。§4.3「router 重启 → 客户端 SSE 断；带 `Last-Event-ID` 重连」说明这在协议上可恢复，但代价是发布期一次全量重连风暴（每个客户端都要重新 `owner()` 查询 + 从 MySQL 回放），而这本可以用 preStop + 等待现有流自然结束来避免。

**建议修复**：SIGTERM 后先让 `/readyz` 返回 503（让 LB 摘流），等一个可配置的 drain 窗口（比如 30 s，或直到在飞请求归零）再 close + exit。

### R-M7 [medium] router 的 `/v1/capabilities` 是硬编码，不反映后端 runner

**位置**：`apps/agent-router/src/app.ts:35-41`

§5.2 说「capabilities 声明而非版本猜测」，其价值在于客户端能据此决定行为。router 的实现把 `replay.hotWindowMs`、`sandbox`、`skills: false` 等值写死在自己代码里，和 `apps/agent-runner/src/app.ts:75-81` 各持一份。灰度期间 runner 支持了 skills 而 router 还说 `skills: false`（或反之），客户端会做出错误决策。建议：router 的 `/v1/capabilities` 也代理到任一健康 runner（或取所有 runner 的交集），不要自己编。

---

### R-L1 [low] 响应头复制丢弃除最后一个之外的所有 `Set-Cookie`

**位置**：`apps/agent-router/src/app.ts:126-128`（`res.headers.forEach(… headers.set(k, v))`）

实测（R4）：源响应有 `Set-Cookie: a=1` 和 `Set-Cookie: b=2` 时，`forEach` 会分别回调两次，但 `headers.set()` 是**替换**语义，最终只剩 `b=2`。当前 runner 不下发任何 cookie，所以这是潜在缺陷；一旦将来加了会话 cookie / CSRF cookie 就会静默丢失。同理 `requestHeaders`（`app.ts:102-108`）对任何多值请求头都用 `set`，不过请求侧 Node 已把 `cookie` 合并成单值，暂无实际影响。**修法**：改用 `append`，或对 `set-cookie` 走 `res.headers.getSetCookie()`。

### R-L2 [low] 空 body 的 POST/PUT 被转成「无 body」请求

**位置**：`apps/agent-router/src/app.ts:115`（`body: body && body.byteLength ? body : undefined`）

`POST /v1/sessions/{id}/turns` 带 `Content-Length: 0` 时，router 转发一个没有 body 也没有 `Content-Length: 0` 的 POST。runner 的 `json(c)` 有 `.catch(() => ({}))` 兜底（`apps/agent-runner/src/app.ts:51`），所以结果仍是 400 校验失败，行为上可接受；但它掩盖了「客户端确实发了空 body」和「客户端没发 body」的区别。建议对非 GET/HEAD 一律传 `body`（零长 `Uint8Array` 也传）。

### R-L3 [low] 逐跳头处理不完整，且没有 `X-Forwarded-*`

**位置**：`apps/agent-router/src/app.ts:17-18`

- 没有按 RFC 7230 §6.1 剥离 `Connection` 头中**列出**的头名；`proxy-connection`、`trailer` 也不在 `STRIP_REQUEST` 里。
- 不设 `X-Forwarded-For` / `X-Forwarded-Proto` / `Forwarded`，同时**原样转发客户端自带的 `x-forwarded-for`**。runner 目前不读这些头（已 grep 确认），所以还不是可利用的伪造；但任何将来基于客户端 IP 的限流/审计都会从第一天就信任一个可伪造的值。建议：剥离入站 `x-forwarded-*`/`forwarded` 后由 router 自己追加。
- `redirect: "manual"`（`app.ts:118`）是对的，但 3xx 的 `Location` 被原样透传；runner 目前不下发重定向。

### R-L4 [low] `app.ts:88` 是不可达代码

`for` 循环的两条 `continue` 分支都要求 `attempt < maxAttempts`（409 路径）或 `attempt !== maxAttempts`（连接失败路径），所以循环体必然在最后一次迭代里 `return`。`app.ts:88` 的 `session_lease_conflict` 兜底永远不会执行。无害，但它会让读者误以为「重路由用尽后有专门的错误响应」，实际上客户端拿到的是上游原样的 409（见 R-H4）。

---

## 二、需进一步验证

1. **registry 的 Redis 实例没有 `error` 监听器**（`registry.ts:52`）。ioredis 对连接类错误走 `silentEmit`（无监听器时不 emit），但并非所有错误路径都经过它。若存在一条会真正 `emit("error")` 的路径，未捕获的 `error` 事件会**直接终止 router 进程**。需要用 Redis 主动 `CLIENT KILL` + 发送非法协议帧的方式实测。无论结论如何，加一个 `redis.on("error", …)` 都是零成本的。
2. **undici 的 `bodyTimeout` 默认 300 s 是否适用于 SSE 响应体**。若适用，则任何 heartbeat 间隔 > 300 s 的配置会让 router 单方面掐断流；当前 `SSE_HEARTBEAT_MS` 默认 10 s（集群测试用 30 s），暂时安全。需要在 Node 24（目标运行时，本机实测环境是 Node 20）上确认默认值和作用范围。
3. **@hono/node-server 2.1.1 的响应预读路径对 SSE 的影响**。`responseViaResponseObject` 在 `transfer-encoding !== "chunked"` 时会预读最多 3 个 chunk，并在流恰好在预读窗口内结束时**补上 `Content-Length`**（`dist/index.mjs:948-981`）。router 的 `STRIP_RESPONSE` 会剥掉上游的 `transfer-encoding`（RFC 上正确），所以 router 出站响应**总是**走这条预读分支。正常 SSE 不会在预读窗口内结束，因此实测 R5 显示流式和背压都正常；但一个「只发一个 `error` 事件就关闭」的极短 SSE 流可能被加上 `Content-Length` 并当成非流式响应。需要针对「runner 立刻 close 的 SSE」写一个用例确认客户端行为。
4. **Node 24 的 `fetch` 是否仍然对所有带 `content-encoding` 的响应做解压**。`STRIP_RESPONSE` 剥掉 `content-encoding` + `content-length` 的前提是 undici 已经解压过 body。若某个版本改成「只在自己协商了 `accept-encoding` 时解压」，而 router 透传的是客户端的 `accept-encoding`，就会出现「body 是 gzip，头却没有 `content-encoding`」的损坏响应。当前 runner 不压缩，所以无法在本仓库内触发；接入层若加了压缩则必须复核。

---

## 三、检查过并认为**正确**的部分

这些是我按任务清单逐项追踪后确认**没有**问题的地方，写出来以免下次重复审。

**代理层**

- **SSE 是真流式，有背压**：`app.ts:130` 把上游 `res.body` 直接交给 `new Response`，node-server 用 `writable.write()` 的返回值 + `drain` 事件驱动读取（`dist/index.mjs:773-781`），不缓冲整个 body（探针 R5）。慢客户端会自然反压到上游 socket。
- **`content-type` / `Cache-Control` / `id: <seq>` / `Last-Event-ID` 全部原样穿透**：`STRIP_RESPONSE` 不含 `content-type`，`STRIP_REQUEST` 不含 `last-event-id`；SSE body 对 router 是不透明字节流，所以 §5 的 `id: <seq>` 语义不会被代理破坏。
- **`X-Accel-Buffering: no` 会被补上**（`app.ts:129`），且用 `set` 而非 `append`，不会和 runner 自己设的那份（`sse.ts:17`）产生重复头。
- **`host` 头被剥离**，`fetch` 会按目标地址重算——不会把客户端的 `Host` 带到内网。
- **请求侧剥 `content-length`** 是对的：body 已被缓冲成 `Uint8Array`，`fetch` 会按实际长度重算，不会出现「重放 body 与旧 Content-Length 不一致」的走私风险。
- **响应侧剥 `content-encoding` + `content-length`** 与 undici 自动解压的行为配套（见需验证 #4）。
- **GET/HEAD 不读 body**（`app.ts:56`），HEAD 响应也不会被塞 body。
- **查询串完整保留**：`app.ts:111` 用 `url.search` 原样拼接，不经过 `URLSearchParams` 往返，所以重复参数（`?a=1&a=2`）和编码（`%20`）都不变形（探针 R1 第 6 例）。这对 `?after=<seq>`、`?exclude=`、`?cursor=` 都很关键。
- **路径遍历不构成问题**：`new URL()` 已规范化 `..` / `.`（探针 R1 第 5 例把 `/v1/sessions/x/../sess_…/turns` 折叠成正确路径）；`//v1/...`、`/v1//sessions/...`、`...%2Fturns` 都被 router 判为非 session 路径后转给 runner，runner 一律 404（探针 R6）。`dest` 的拼接方式（`${target}${pathname}${search}`）也无法把请求打到别的 host——`pathname` 必然以 `/` 开头，`new URL` 里 host 已定。
- **跨租户 session id**：router 按 sessionId 路由但不看租户，把请求送到真正的 owner；runner 的每条查询都带 `AND tenant_id=?`（`packages/store/src/mysql/store.ts:151`）→ 404，符合 §5.5 的不可区分要求。唯一的租户泄露点是 R-H3 的 `/_router/targets`，不是代理路径本身。
- **客户端中途断开 ≠ 取消**（§4.3）：客户端断开 → node-server 销毁 writable → cancel 上游 reader → runner 的 `stream.onAbort`（`sse.ts:48-51`）只置 `aborted` 并 `close()`（停止发送、退订），**不动 turn**；`begun.run()` 早在 `subscribe` 返回后就已经在 `finally` 里启动（`agent-runner/src/app.ts:229-231`），与 SSE 生命周期解耦。turn 继续跑、事件继续落库/进 Stream，客户端用 `?after=` 补齐。契约满足。
- **上游中途死亡**：`res.body` 报错 → 客户端看到截断的 SSE 流，没有伪造的结束事件；按 §4.4 客户端用 `Last-Event-ID` 重连即可，语义正确。

**重路由**

- **「已发字节后不得重路由」这条硬约束成立**，而且是结构性成立的：`fetch` 在**响应头**到达时 resolve，409 是 runner 在 `beginTurn` 抛出的（preflight 在开流之前，`agent-runner/src/app.ts:190-198` 的注释和 `sseResponse` 的调用位置都印证），所以 router 看到 409 时上游一个 body 字节都没发过；`streamBack` 一旦执行就没有任何回到循环的路径。
- **`X-Owner` 不可被用来做 SSRF**：`registry.toUrl()`（`registry.ts:104-108`）只在**配置好的** `targets` 里查表，返回的一定是 `RUNNERS` 里的某个 base url。恶意/串改的 `X-Owner` 最坏结果是 `undefined`（不重路由），不可能让 router 去打任意地址。
- **不会无限循环**：`tried` 在每次 attempt 开头 `add(target)`（`app.ts:63`），409 路径查 `!tried.has(ownerUrl)`，连接失败路径的 `pickOther` 也按 `!tried.has(t.url)` 过滤；再加上 `maxAttempts` 上界（`config.ts:11` 限制 1..5）。`X-Owner` 指向自己或指向已试过的 runner 都会安全地停下来（代价见 R-M2）。
- **`X-Owner` 指向被标记不健康的 runner 时仍然会转发过去**（`app.ts:80` 不查健康状态）——这是**对的**：所有权优先于健康探测的滞后视图，§4.2 的正确性来自租约而不是健康。
- **非 lease 类 409 不会触发重路由**：`session_busy`、`idempotency_conflict` 都不带 `X-Owner`（只有 `agent-runner/src/app.ts:60` 的 `session_lease_conflict && ownerAddr` 分支会写头），所以 `app.ts:78` 拿不到值，直接透传。不存在「把 busy 当成 owner 变更去重发一个 turn」的风险。
- **`GET /v1/sessions/{id}/events` 不需要所有权**，任何 runner 都能从 MySQL + Redis Stream 提供重放（§4.4），所以它永远不会 409，也不需要重路由——这个设计是对的，重连风暴不会集中到 owner 上。

**registry**

- **ring 不随健康状态重建，而是在查找时跳过不健康节点**（`registry.ts:89-92`）——这是正确选择。重建 ring 会让所有 key 的落点发生不必要的迁移；按需跳过则保证一个 runner 恢复后落点自动回到原位，而且 `candidate()` 是 O(ring) 最坏、O(1) 常见。
- **`candidate()` 在全部 runner 不健康时返回 `undefined`**（`registry.ts:93`），调用方 `app.ts:60` 转成 `503 draining`——与 §5.5 的 `503 draining` 一致。
- **`owner()` 的 Redis 读失败被吞掉并退化到一致性哈希**（`registry.ts:78-80`）在**语义**上是对的：目录只是优化，正确性由 409 兜底。（延迟上界的问题见 R-H7，那是客户端配置问题而不是这段逻辑的问题。）
- **`owner()` 读的 key 与 runner 写的 key 一致**：`registry.ts:76` 的 `as:lease:{sid}` / 字段 `addr` 精确对应 `packages/store/src/redis/lease.ts:43` 的 `${prefix}:lease:{${sid}}` 与 `lease.ts:14` 的 `HSET … 'addr'`，默认 prefix 双方都是 `as`。租约 key 带 TTL，所以不存在「读到已过期 owner」的问题。
- **`markFailure` 需要连续 2 次失败才置不健康**（`registry.ts:110-115`），且成功的健康探测会把计数归零（`registry.ts:123`）——不会因为一次偶发的连接重置就把整个 runner 摘掉。「只能靠轮询恢复」在这里是**安全方向**的选择：请求路径只会把状态往坏改，往好改只认主动探测。
- **健康探测有超时**（`registry.ts:121`，2 s），不会因为一个挂死的 runner 让整轮 `checkAll` 永久悬挂。
- **timer `unref()`**（`registry.ts:60`）不会阻止进程退出，而 HTTP server 会保持进程存活——组合正确。

**其他**

- **一个慢上游不会阻塞事件循环**：全链路 async，`checkAll` 用 `Promise.all` 并行。R-B2 的大 body 缓冲消耗内存但不阻塞。
- **keep-alive 存在**：Node 全局 undici dispatcher 默认对每个 origin 复用连接，不是每请求一条新 TCP。没有显式连接池配置是可改进项，但不是缺陷。

---

## 四、集群测试的证明力

先说三个**共性**问题（影响全部 4 个用例）：

- **C1 `r.url.includes(ownerAddr)` 是脆弱的匹配**（`takeover.test.ts:56, 94, 155, 190`）。`ownerAddr` 是 `127.0.0.1:PORT`，`url` 是 `http://127.0.0.1:PORT`。若两个临时端口出现前缀关系（如 5 位 vs 6 位），`includes` 会选错 runner，测试会以「找不到/选错 survivor」的形式随机失败。macOS/Linux 的临时端口范围都是 5 位，所以目前不触发。建议改成 `r.port === Number(ownerAddr.split(":")[1])`。
- **C2 `waitHttp(router/readyz)`（`harness.ts:172`）什么都不证明**：由 R-M5，router 的 `targets` 初始全是 `healthy:true`，`/readyz` 在第一次健康探测完成之前就返回 200。所以 harness 只确认了 router 绑上了端口，没有确认它认得任何 runner。
- **C3 「router 参与度」普遍很低**。4 个用例里，只有第一个真正让 router 承担路由决策；另外 3 个在关键断言处都**直接打 runner**（`survivor.url`），router 只用来起第一个 turn。也就是说：**M2 的接管能力是在 runner/租约层被证明的，router 在故障接管中的行为基本没有被覆盖。** 这一点在 `takeover.test.ts:4-8` 的文件注释里没有说明，容易被误读成「router 的故障转移已验证」。

反过来，有一类问题**已经被结构性地修好了**：`launch()`（`harness.ts:59`）用 `node --import tsx <script>`，被 spawn 的进程**就是**服务器本体；`signal()`（`harness.ts:72-77`）还用 `process.kill(-pid)` 杀整个进程组（`detached: true`）。两重保险，所以「kill 打到 wrapper、真服务器还活着」的那类 bug 不可能再悄悄回归——而且用例 2/3/4 都依赖「被杀的 runner 真的停止续租」，一旦回退成 wrapper 模式，`waitFor(survivor 接受 turn)` 会超时**失败**而不是通过。这一点是可信的。

`stop()`（`harness.ts:183-188`）的回收也是可靠的：对已经被杀过的进程重复 `kill` 时 `process.kill(-pid)` 抛 ESRCH 被 catch 住，`exited` 已 resolve 所以 `await` 立即返回。唯一的残留风险是 spawn 本身失败（只 emit `error` 不 emit `exit`）时 `await p.exited` 永久挂起——`hookTimeout: 60_000` 会把它变成一次超时失败，不会静默。

端口与 DB 的隔离：`vitest.config.ts` 设了 `fileParallelism: false`，注释也点明了原因，所以同一次 run 内不会有两个 cluster 并行抢端口。`freePort()`（`harness.ts:15-24`）是经典的 TOCTOU（先 listen 再 close 再交给子进程用），窗口极小，且失败方式是 `waitHttp` 30 s 超时后带日志抛错——响的，不是静默的。`DROP DATABASE`（`harness.ts:121`）在每个用例开头执行，而 `afterEach` 已 await `stop()` 把上一批进程 SIGKILL 掉，所以不存在「旧 runner 往新库里写」的竞态。Redis 用 db 3（`harness.ts:12`），与 `packages/store/test/mysql-redis.test.ts` 的 db 1 不冲突。**这几项我认为是干净的。**

### 用例 1：`routes a session consistently and re-routes on 409 without the client noticing`

**真正证明了**：一个 turn 能端到端穿过 router 跑完（`takeover.test.ts:44-49`，SSE POST 经 router 流式返回并出现 `turn/completed`）；租约目录里确实写进了 `addr`，而且是我们的某个 runner（`:52-53`）；直接打非 owner 时，如果返回 409，那么 `X-Owner` 的值与目录一致（`:62`）。

**只是看起来证明了**：**标题里的 "re-routes on 409" 没有被证明。** 两个独立原因：

1. `:61-72` 是一个 `if/else`，**两个分支都 pass**：409 分支断言「经 router 再发一次会 202」，else 分支断言「直接打非 owner 也 202」。无论被测系统怎么表现都通过——把 `app.ts:77-85` 的整个重路由块删掉，这个用例**照样绿**。
2. 即使走进 409 分支，`:64-68` 的 `viaRouter` 也不是一次重路由：router 在 `app.ts:59` 先读 `registry.owner()`，Redis 里有 owner，**第一跳就直接打中 owner**，409 路径根本没被执行。`expect(viaRouter.status).toBe(202)` 只证明了「目录查询有效」，而那是优化路径，不是 §4.2 的正确性路径。

**要真正证明重路由，需要**：(a) 让 router 在 `hash-only` 模式下跑（不给它 `REDIS_URL`），构造一个哈希落点 ≠ owner 的会话；或 (b) 断言 router 日志里出现 `app.ts:81` 的 `re-routing to owner`；或 (c) 用一个可注入的 registry 做单元级测试，断言 `fetch` 被调用了两次、第二次的目标是 `X-Owner`、且 body 与第一次逐字节相同。(c) 其实是最该有的——现在**整个 router 没有一行单元测试**（`apps/agent-router/test/` 目录存在但是空的，而 `apps/agent-runner/test/` 有两个文件），R-B1/R-M1/R-M2/R-H4 这些纯逻辑缺陷用 `app.fetch()` + fake registry 都能在毫秒级覆盖。

### 用例 2：`SIGKILL of the lease holder mid-turn: another runner takes over, fence advances, no seq gaps`

**真正证明了**（这是 4 个里最有价值的一个）：owner 被 SIGKILL 后租约会过期，另一个 runner 能抢占并把 fence 推进（`:114-115`，`fenceAfter > fenceBefore`）；孤儿 turn 会被修复成 `interrupted`（`:123`，对应 §4.3「turn 记为 interrupted」）；任一时刻最多一个 `inProgress` turn（`:124`）；events 表的 seq 是连续的 1..N（`:135`）——考虑到 `(session_id, seq)` 的唯一性约束，「无空洞」确实是「没有出现第二个 writer 抢分配 seq」的有效信号。

**只是看起来证明了**：

- **接管发生在 runner 层，不是 router 层。** `:104` 直接打 `survivor.url`，绕开 router。「owner 挂了以后 router 会把流量导到 survivor」这件事一次都没测（而由 R-M2，那条路径上还真有缺陷）。
- **最后的重放断言（`:138-142`）几乎是空的**：`expect(replayed).toEqual(seqs.slice(0, replayed.length))`。如果 `replayed` 是空数组，就是 `[] toEqual []` —— **恒真**。前面的 `waitFor(replay.events.length >= seqs.length)`（`:139`）数的是**所有**事件（含无 id 的 heartbeat 和 delta），所以理论上可以被无 id 事件填满后进入一个空的 `replayed`。而且 `slice(0, replayed.length)` 主动放弃了对尾部的检查——少收一半事件也照样通过。§4.4「`?after=<seq>` 先读 MySQL 里程碑再切 Stream tail，不丢不重」这条契约，**实际上没有被强断言**。应改成 `expect(replayed).toEqual(seqs)`（在 waitFor 里等 `id` 事件数达标，而不是等总事件数）。
- **`turns.length >= 2`（`:122`）和 `<= 1`（`:124`）都是很宽的断言**，不区分「第二个 turn 是因为接管而起」还是别的原因。
- **时序脆弱点**：脚本给第一个回复设了 `ttftMs: 8_000`（`:81`），kill 必须落在 `turn/started` 之后、8 s 之内。正常几百毫秒就 kill 了，但 CI 上如果 `waitFor` 的第一轮（含一次 `redis.hget` 和一次 `redis.get`）被拖过 8 s，turn 就会自己完成，`turns.some(interrupted)`（`:123`）随之失败。这是真实的 flake 源，建议把 `ttftMs` 提到 30 s 以上或改用一个可显式控制的「挂住」脚本。

### 用例 3：`a stale owner cannot write after being fenced out`

**真正证明了**：`redis.del(lease)` 之后另一个 runner 能抢到租约（`:159-170`，fence 会 INCR），并且整段过程结束后 events 的 seq 仍然连续（`:175-177`）——即被 fence 掉的旧 owner 没有成功插入事件。

**只是看起来证明了**：

- **`:174` 的日志断言可以因为错误的原因通过。** `cluster.logs()`（`harness.ts:182`）是**所有**进程日志的并集，而正则 `/fenced out|no longer owns|owner_lost/i` 的三个分支里：`owner_lost` 是 **survivor** 在 `closeOrphanedTurn` 里写进 turn 行的 error code（`host.ts` 的 `owner_lost`），`no longer owns` 是 `gateToolCall` 的返回文案。也就是说，只要 survivor（而不是被 fence 掉的旧 owner）打印了任何包含这些词的日志，断言就通过。**它没有把范围限定到 `ownerProc.log`。** 应改成 `ownerProc.log.some(l => /fenced out/i.test(l))`。
- **「不能写」这件事只靠 seq 连续性间接证明**，而 seq 连续也可能是因为旧 owner 压根没再尝试写（比如引擎恰好在 `ttftMs: 6_000` 的等待中、还没到下一次 commit）。要直接证明，应该断言：fence 推进之后，events 表里**不再出现属于旧 turn（`turn_id = 第一个 turn`）的新事件**，或者断言旧 owner 的 commit 确实抛出了 `FenceError`。
- **场景本身是人造的**：`redis.del(lease:{sid})`（`:158`）不在 §4.3 的故障表里（真实场景是租约到期或续期失败）。作为 fence 机制的定向测试没问题，但它不覆盖「续期失败 → 立即 abort 当前 turn」（§4.2 第 4 条）这条真实路径。
- **脚本只有 2 条回复**（`:146`），`waitFor` 里的 POST 可能重试很多次。虽然被 409 拒绝的请求不消耗 vendor 回复（租约检查在模型调用之前），但一旦时序偏移，第 3 次及以后会拿到 `FakeVendor` 的兜底回复 `"(fake vendor: no script left)"`（`packages/testkit/src/fake-vendor.ts:106`）——测试不会报错，只是断言的语义悄悄变了。

### 用例 4：`SIGTERM drains: the in-flight turn completes normally and the lease is released`

**真正证明了**：SIGTERM 后 runner 会等在飞 turn 跑完（`main.ts:52-58` 的 `ready=false` + `host.drain(30_000)`），turn 的最终状态是 `completed / end_turn` 而不是 `interrupted`（`:198-199`）；并且客户端**经 router** 收到了 `turn/completed`（`:201`）——这一条顺带证明了 router 的 SSE 直通在上游进程退出时不会伪造或吞掉尾部事件。这是 §4.3「runner 发布/缩容 → drain」的有效证据。

**只是看起来证明了**：

- **`expect(await redis.exists(lease)).toBe(0)`（`:200`）分不清「被 drain 主动释放」和「TTL 到期自然消失」。** harness 的默认 `LEASE_TTL_MS=3_000`、`LEASE_HOLD_MS=500`（`harness.ts:147-148`）：turn 结束后 `scheduleRelease` 会在 **500 ms** 后释放，`drain()` 末尾的 `holdTimers` 循环（`host.ts:1003-1007`）也会释放，租约本身还会在 3 s 后过期。断言执行时刻距 turn 结束通常只有几百毫秒，所以**今天它大概是因为正确的原因通过的**；但如果 drain 的释放逻辑被改坏，只要 `await ownerProc.exited` + `await stream.done` + 一次新建 MySQL 连接的查询（`harness.ts:257`）合计超过 3 s（慢 CI 很常见），断言就会**因为 TTL 过期而通过**。要把它变成真断言：把 `LEASE_TTL_MS` 设成 60 s 以上，让 TTL 在测试窗口内绝不可能过期。
- **`await stream.done`（`:194`）resolve 的原因是进程退出**，不是 SSE 优雅收尾。`main.ts:58` 在 drain 之后 `process.exit(0)`，socket 被直接掐断，客户端侧 `openSse` 的 reader 抛错并被 `harness.ts:238` 的空 catch 吞掉。所以这个用例**没有**证明「drain 会等 SSE 把队列写完」；`sse.ts:63-66` 的 `finally { await drain() }` 语义仍然未被覆盖。
- **`const [turn] = await queryDb("SELECT … WHERE session_id=?")`（`:197`）没有 `ORDER BY`**。当前只有一个 turn 所以没问题，一旦将来这个用例多起一个 turn，断言会变成「随便一行」。
- **只有 1 条脚本回复**（`:181`），`maxSteps` 默认 4：turn 靠「没有 tool call」自然结束。如果 FakeVendor 的兜底回复被改成带 tool call，这个用例的语义会静默变化。

### 结论

4 个用例里：**用例 2 和用例 4 有实质证明力**（分别覆盖 §4.3 的「runner 崩溃」和「runner 发布/缩容」两行），**用例 3 证明力中等**（fence 有效，但「旧 owner 真的被拦住」是间接推断，且日志断言的范围错了），**用例 1 对它自己的标题是空的**（重路由一次都没执行过，且 `if/else` 让两种结果都通过）。

三个最该补的缺口，按性价比排序：
1. **router 的单元测试**（fake registry + `app.fetch()`）：`X-Owner` 重路由发生且只发生一次、重放的 body 逐字节相同、`tried` 不回环、`X-Owner` 指向未配置地址时的行为、响应不含 `x-owner`、大写/百分号编码的 session 路径不得降级为「任意 runner」。这些全是毫秒级用例，能覆盖本文档一半的缺陷。
2. **把用例 1 改成真的重路由测试**：router 不给 `REDIS_URL`（`hash-only`），或断言 router 日志里的 `re-routing to owner`。
3. **把用例 2 的重放断言改成 `toEqual(seqs)`**，并让 `waitFor` 等「带 id 的事件数」而不是「总事件数」。
