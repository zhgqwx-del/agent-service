# 前期架构方案与 PoC 批判性摘要（面向 agent-router / agent-runner 新项目）

> 输入材料：`~/Desktop/meetyou/agent-runtime-方案/` 下的 `02-Agent-Runtime架构方案.md`、`03-Harness-API接口规范.md`、`05-记忆层设计.md`、`06-固定工作流vs自主循环与框架选型.md`，以及 `poc/agent-runtime/`（约 6,000 行 TS 源码 + 2,700 行测试，151 测试 / 474 断言）。
> 评估基准：新项目简报 —— 通用 agent harness API（类 `opencode serve`，HTTP + SSE，支持 MCP / skills / plugins / BYOK），独立无状态 `agent-router` + 有状态 `agent-runner`，20M+ DAU，会话历史云存储（本地 MySQL 起步），国产模型走 OpenAI 兼容接口。
> 日期：2026-09-22。

## 0. 一句话结论

前期方案是为**一个窄产品（语音记录分析 App）**设计的 conversation-agent runtime，它在「事件日志 + seq 水位线 + 单写者租约 + 前缀稳定化 + 安全阀 + 国产厂商方言归一」这六件事上做了扎实且有测试的工作，**这些是可以直接搬进新 runner 的基础设施层**。但它的三个顶层判断（不需要 code-agent harness、不需要独立 Gateway、按意图固定编排）在新简报下**全部要翻转**：新项目是通用 harness，需要工具/MCP/沙箱面，需要独立 router，需要开放的自主循环。此外 PoC 的分布式部分**只有单机 CAS，没有跨进程验证、没有 fencing token、没有租约续期、没有 runtime 回收**，不能按「已验证」看待。

---

## 1. 分布式设计：文档里写了什么，以及在新简报下要改什么

### 1.1 文档里的设计（02 §2、§3.1、§3.3、§3.4、§3.5、§3.6）

**Ownership 模型（02 §3.1「有状态性分三层」+ §3.3「单写者租约」）**

| 层次 | 要求 | 文档理由 |
|---|---|---|
| turn 之内 | 强制单所有者 | 进程内有模型流、未结算的工具调用、seq 分配；双写 = 数据损坏 |
| 同 session 跨 turn | 优选亲和，不强制 | 热上下文免重投影；自建推理阶段 = KV cache 命中 |
| 同用户不同 session | 完全不需要 | 无共享进程态；长期记忆走 DB |

目标表述：**「turn 之间无状态，turn 之内单所有者」**。

租约实现（02 §3.3）：
```
lease:{sessionId} = {ownerId, fencingToken, expiresAt}
抢占：SET lease:{sid} {owner, token=INCR fence:{sid}, exp} NX PX 30000
续约：每 10s Lua CAS 续期（校验 ownerId 未变）
写入：appendEvents 带 fencingToken，DB 端校验 token < 当前值 → 拒绝
```

**路由键为什么是 sessionId 不是 userId（02 §3.1）**：按 userId 哈希会把一个重度用户的所有并发会话钉在一个节点上，而这些 session 之间本来没有共享的进程内状态。**正确性不依赖路由正确性**：租约 + fencing token 是唯一的正确性保证，路由失效只退化成多一跳 + 上下文冷启动。

**「对等转发 vs 独立 Gateway」（02 §3.1，这是对初版的自我修正）**：文档推荐每个节点同时是 Gateway 和 Runtime（Cassandra coordinator 模式）：请求落到任意节点 X，X 抢租约，抢到自己跑，抢不到转发给持有者 Y 并透传 Y 的 SSE。理由表：拆分两个服务恒定多 1 跳、Gateway 并非真无状态（要维持上游 SSE 流）、**两侧负载曲线都由「并发 turn 数」这一个变量决定所以独立扩缩容无价值**。文档同时给了拆分条件：「入口要做很重很独立的事（WAF、多协议、面向外部开放平台的配额与计费）时，那一层是 API 网关，本来就该独立」。

**事件日志是真相 + 投影（02 §3.2「Model-visible means logged」）**：append-only，PK `(session_id, seq)`，seq 在 session 内单调；模型可见历史从日志投影；压缩不删日志只追加 summary；system prompt 也走日志。文档承认与隐私脱敏冲突，解法是**两套日志**：脱敏事件日志（SSE 重放/审计，留 1 年）+ 加密上下文日志（prompt 重建，per-tenant KMS，留 90 天），共用 seq 空间。

**断线重连（02 §3.5、03 §4）**：`GET /v1/sessions/{id}/events?after=<seq>` 或 `Last-Event-ID` 头；服务端先从事件日志补发再接实时流；客户端三件事：持久化 lastSeenSeq、按 seq 去重、断言 seq 连续（防静默空洞）。heartbeat 不占 seq 不落库。存储上「不要逐 token 存」，按 delta 批量落库。

**跨副本事件扇出（02 §3.4）**：三种用途分开 —— SSE 扇出（Redis Pub/Sub 或 Kafka 按 sessionId 分区，可丢有 DB 兜底）、审计投递（Kafka 7 天）、异步任务（Kafka/RocketMQ + 调度器）。

**LLM Gateway（02 §3.6）**：自研薄网关约 2,000 行，职责：provider 路由、降级链、方言层、token 计量、熔断配额、内容安全钩子、前缀感知路由。列出的方言差异（reasoning 字段、max_tokens 字段、缓存用量字段、tool_calls 分片、keep-alive 行、tool 消息格式）在 PoC 里都实现了。

**明确未跨进程验证的部分（02 §3.1 末尾、00-README 待办 #2）**：对等转发、fencing token、跨副本扇出「都还是设计，不是实现」。验证方案：3 个进程共享一个 Postgres，nginx 按 sessionId 哈希，turn 中 kill 掉持有租约的进程，断言另一个能接手、日志无空洞、`?after=` 能补齐。**这个实验没有做。**

### 1.2 批判性评估：新简报下什么要变

**(a) 独立 router 的问题，文档自己的判据已经翻转。** 文档反对拆分的核心理由是「两侧负载曲线相同」。新简报的 runner 是通用 harness：要挂 MCP 子进程/远程连接、skills、plugins、可能的代码执行沙箱、每 session 的工作区 —— runner 的单位成本是「内存 + fd + 子进程」，router 的单位成本是「连接 + 鉴权 + 限流」，**负载曲线显然不同**。加上简报要求「可被任意外部客户端调用」，这正是文档 §3.1 列的拆分条件（面向外部的配额/计费/多协议）。结论：**采用独立 agent-router，但保留文档的核心不变量 —— router 只是效率优化，正确性由 runner 侧租约 + fencing 保证。**

router 的形态建议（把文档的 peer-forwarding 逻辑挪到 router 里）：
1. 查 Redis 所有权目录 `owner:{sessionId} → runnerAddr`（而不是纯一致性哈希；哈希只做无 owner 时的首选分配）。
2. 有 owner 且存活 → 直接反向代理（SSE 不缓冲）；无 owner → 按哈希/负载选 runner，由 runner 抢租约。
3. runner 返回 `409 session_lease_conflict`（03 §1.4 已定义此错误码）→ router 重查目录重路由一次。
4. router 持有的只是连接态，可随时重启；客户端用 `?after=` 续订。
5. 文档中「Gateway 不是真无状态」的批评仍然成立：SSE 代理期间 router 有连接态；这是可接受的，因为它没有**业务状态**。

**(b) 路由键仍是 sessionId，但要加一条前提。** 文档的推理在通用 harness 下依然成立。但若通用 harness 引入**每用户/每项目的本地工作区（文件）**，userId/projectId 亲和会突然变得有吸引力 —— 这会把文档否定过的「重度用户打爆单点」问题带回来。建议：工作区放对象存储/网络卷，runner 本地只做缓存，保住 sessionId 作为唯一路由键。

**(c) 「turn 之内单所有者」在通用 harness 下代价更高。** PoC 的 turn 是 50s 量级；通用 agent turn（多步工具、MCP、代码执行）可能是分钟级。租约 TTL 30s + 续期 10s 的参数要重新定，且必须真的续期（见 §3.3 的 PoC 缺陷）。更重要的是 pod 缩容/发布时的**优雅迁移**（00-README 缺口清单：「pod 缩容时进行中的 turn 会被 abort，没有 checkpoint/resume」）在分钟级 turn 下从「可接受」变成「不可接受」，需要 turn 级 checkpoint（step 边界）或 drain 等待。

**(d) 两套日志的设计与通用 API 直接冲突。** `opencode serve` 类 API 的客户端期望 `GET /session/:id/message` 拿到**完整**消息内容（parts）。文档 03 §0「脱敏默认开」把用户原文、工具参数排除在事件流之外，只给长度 + hash —— 这是语音记录产品的隐私要求，对通用 harness 是错误默认。新项目需要：事件流携带完整内容（或按 tenant 配置脱敏级别），并提供消息历史读取接口。02 §3.2 的「上下文日志加密落库」思路可以保留为**存储层加密**，但不能是「API 层不可见」。

**(e) 事件扇出规模。** 文档 §3.4 说 PoC 跨副本退化为 250ms 轮询事件表。20M DAU 下这不可行（见 §5）。Redis Cluster 的普通 Pub/Sub 是全集群广播，需要 Redis 7 的 sharded pub/sub（SSUBSCRIBE）或 Kafka 按 sessionId 分区；而且要决定 delta 是否进持久层（见 §4.3）。

**(f) LLM Gateway 应从 runner 里拆出来还是内嵌？** 文档建议自研薄网关但没说部署形态。在 20M DAU 下，厂商侧的 RPM/并发配额是硬约束（§5.4），需要**全局**的 key 池、配额和熔断状态，这不能只在 runner 进程内做。建议：provider 适配（方言）留在 runner（PoC 代码可复用），配额/熔断/key 池状态放 Redis 由 runner 侧库统一读写，或独立 llm-gateway 服务。

---

## 2. API 协议草案（文档 03）与通用 harness API 的差距

### 2.1 端点清单

| 端点 | 03 规范 | PoC 实现（`src/http/server.ts`，531 行） |
|---|---|---|
| `POST /v1/sessions` | ✅ `profile` 必填 | ✅ |
| `GET /v1/sessions/{id}` | ✅ | ✅（多返回 `latestSeq`） |
| `GET /v1/sessions?limit&cursor&profile&updatedAfter` | ✅ 必须按 tenant 过滤 | ⚠️ 只有 `limit=50`，无 cursor |
| `DELETE /v1/sessions/{id}` | ✅ 级联删除 + 说明厂商缓存不可清 | ❌ 未实现 |
| `POST /v1/sessions/{id}/turns` | ✅ SSE 或 `stream:false` JSON | ⚠️ 只有 SSE；`stream:false` 未实现 |
| `GET /v1/sessions/{id}/events?after=` / `Last-Event-ID` | ✅ | ✅ 另有 `follow=false`、`until=idle` |
| `POST .../turns/{turnId}/cancel` | ✅ 202 | ✅ |
| `POST /v1/sessions/{id}/steer` | ✅ `{text}` | ✅ 但字段名是 `message`（与规范不一致） |
| `POST /v1/sessions/{id}/followup` | ✅ | ❌ 未实现 |
| `GET /healthz` `/readyz` `/metrics` | ✅ | ⚠️ 无 `/readyz` |

其他规范细节：Base URL `/v1` 路径版本化；JWT claims `{sub, tid, dev, scp}`；`Idempotency-Key` 写操作必需（PoC 未实现）；错误信封 `{error:{code,message,requestId,retryable,retryAfterMs,details}}`（PoC 只有 `{code,message}`，且码名不一致：PoC `unauthorized`/`bad_request`/`turn_in_progress` vs 规范 `unauthenticated`/`invalid_request`/`session_busy`）；跨租户一律 404。

### 2.2 请求信封与事件信封

turn 请求体（03 §3.1）：`{ "input": { text?, transcript?{recordId,text,durationSec,asrProvider,asrConfidence,speakerCount}, imageUrl? }, "stream": true, "limits"?: {maxSteps,maxToolCalls,maxWallClockMs,maxCostCNY} }`。输入字段收在 `input` 下，顶层留给信封字段 —— 这个分层原则值得保留。

事件信封（03 §3.3 / `src/protocol.ts` 35–42 行）：`{ seq, ts, type, sessionId, turnId?, data }`；SSE `id:` == seq；`event:` 恒为 `message`（PoC 实际写的是 `event: ${ev.type}`，`src/http/sse.ts` 39 行，与规范不一致）。

### 2.3 事件类型全集

| 类型 | 含义 | 规范 03 | PoC `protocol.ts` |
|---|---|---|---|
| `turn.started` | 带脱敏 input 摘要、contextEpoch、生效 limits、(PoC) intent | ✅ | ✅ |
| `turn.completed` | steps/toolCalls/wallClockMs/finishReason/text | ✅ | ✅ |
| `turn.failed` | reason 枚举 + partialText；之后仍发 session.idle | ✅ | ✅ |
| `text.delta` | 主文本增量 `{step,text}` | ✅ | ✅ |
| `text.retract` | 内容安全分段送审不通过时撤回 `seq>=fromSeq` | ✅ | ❌ 未实现 |
| `reasoning.delta` | 思维链增量 | ✅ | ✅ |
| `tool.call.started/progress/completed/failed` | 工具生命周期；args/result 脱敏；started 是 write-ahead | ✅ | ✅ |
| `tool.calls.discarded` | `finish_reason=length` 时丢弃本 step 全部 tool call | ❌ | ✅ |
| `turn.repaired` | 会话 open 时发现孤儿 tool call 并注入恢复指导 | ❌ | ✅ |
| `context.compacted` | before/afterTokens、summaryId、新 contextEpoch、strategy | ✅ | ✅ |
| `usage.updated` | prompt/completion/cached tokens、cacheHitRatio、costCNY、cumulative、provider/model/pricingTier | ✅ | ✅（无 pricingTier） |
| `steer.accepted` | `{queued}` | ✅ | ✅ |
| `session.idle` | 一次 SSE 流的终止信号 | ✅ | ✅ |
| `heartbeat` | 不占 seq 不落库 | ✅ | ✅ |

`turn.failed.reason` 枚举：`max_steps_exceeded / max_tool_calls_exceeded / max_wall_clock_exceeded / max_cost_exceeded / repeated_tool_call / provider_error / cancelled / content_rejected / internal_error`（PoC 缺 `content_rejected`）。

### 2.4 session / turn / step 模型与 cancel / steer

- **session**：租户隔离边界，`profile` 创建时必填且不可变，`adapter` 不可变，`contextEpoch` 前缀版本，`lastSeq` 水位线，`status: idle|running`，`activeTurnId`，`cumulativeUsage`。
- **turn**：用户一次提交到「没事可做」；同一 session 同一时刻只允许一个活跃 turn（否则 409）。
- **step**：一次模型请求 + 其触发的工具调用（并发执行，per-tool `sequential` 串行）。
- **cancel**（03 §5.1）：协作式，AbortSignal 贯穿到 provider fetch；已发出的工具可能跑完；不保证回滚副作用；事件流收到 `turn.failed{cancelled}` + `session.idle`。PoC：客户端断开 SSE **刻意不** cancel（`server.ts` 250–257 行），turn 继续跑并落库 —— 这是移动端弱网的正确语义，对通用 API 也是正确默认。
- **steer**（03 §5.2）：入队，在**下一个 step 边界**以 `[用户插话]` user 消息注入（`loop.ts` 228–232 行）；不打断当前模型请求。
- **followup**（03 §5.3）：当前 turn 结束后开新一轮；PoC 未实现。

### 2.5 内部可插拔契约（03 §6）

`HarnessAdapter.open()` → `HarnessSession.runTurn({emit})`；**emit 由 Runtime 提供**（seq 分配、脱敏、落库、总线投递统一在 Runtime 侧）；`ModelProvider.stream()` 是唯一必需方法；`Tool` 有 `sideEffect / replay / executionMode / modelProjection / clientProjection`；`SessionStore` 含 `open/renew/release/appendEvents(带 lease)/readEvents/appendContext/readContext`；`ContextAssembler` 返回 `prefix + prefixHash`。**这套内部接口比对外协议更接近通用 harness 需要的形状**，值得作为 runner 内核接口的起点。

### 2.6 与 `opencode serve` 风格通用 API 的差距（必须补的面）

| 能力面 | 03 规范现状 | 通用 harness 需要 |
|---|---|---|
| 消息历史读取 | 无；事件流内容脱敏 | `GET /sessions/{id}/messages` 返回完整 parts（文本/工具调用/工具结果/附件） |
| 模型/Provider 目录与选择 | 明确**禁止**客户端指定模型（§2.1、§9 #5），只给 `auto/fast/quality` | `GET /providers`、`GET /models`、请求级 `model` 参数、BYOK：租户级 provider 配置（baseUrl/apiKey/模型别名/价格表）的 CRUD |
| 工具面 | 固定业务工具集（§6.3 表），且「绝不注册代码执行类工具」 | 工具目录 API、内置工具集（文件/shell/web 可选）、per-session 工具启用/禁用、工具权限策略 |
| MCP | 文档 02 §0 判定「不需要 MCP 子进程」 | MCP server 注册（stdio/HTTP/SSE 三种传输）、按 tenant/session 挂载、状态查询、MCP tools/resources/prompts 暴露 |
| Skills / Plugins | 无 | skill 目录（发现/加载/版本）、plugin hook 点（before/after model call、tool call、compaction）、插件隔离 |
| 权限/审批流 | 只有 `ask_user` 工具（§9 #7 待定） | `permission.requested` 事件 + `POST .../permissions/{id}/respond`、按 tool/pattern 的持久化允许规则 |
| 工作区/文件 | 无（`imageUrl` 只允许 `oss://`） | project/workspace 概念、文件上传/读取、附件 part、（若开代码执行）沙箱工作区生命周期 |
| Agent/模式 | `profile` 是产品枚举（record_analysis/chat/…） | 通用 `agent` 定义（system prompt、工具集、模型、limits），可由租户定义；`profile` 应改成可配置的 agent id |
| System prompt / 指令 | 硬编码在 `assemble.ts` 131–143 行，写死了产品名 | per-agent/per-session 可配置 instructions，仍走 epoch 冻结 |
| 全局事件流 | 只有 per-session SSE | 可选 `GET /events`（tenant 级）用于控制台/多会话 UI |
| session 操作 | create/get/list/delete | fork、revert（到某 seq）、share、summarize、title 生成 |
| 鉴权模型 | 端用户 JWT（`tid == userId`） | 外部客户端 API key（服务级）+ 端用户身份（`X-User-Id` 或 JWT）双层；tenant ≠ user |
| 非流式/异步 | `stream:false` 规范有、PoC 无 | `stream:false` + 异步提交（202 + 轮询/回调），供服务端调用 |
| 结构化输出 | 无 | `response_format` / JSON schema 透传 |
| 多模态 | 只有 imageUrl | 通用 attachments |

**可直接沿用的协议资产**：`seq` 单一水位线、`id:==seq`、`?after=`/`Last-Event-ID` 续订、`session.idle` 终止信号、`turn.failed` 带 partialText 的优雅终止、`limits` 作为一等字段、`contextEpoch` 显式化、`usage.updated` 的缓存命中归一、404-不-403、`input` 与信封分层、事件兼容性变更策略（03 §10）。

---

## 3. PoC 代码评估：什么能带走，什么必须扔

### 3.1 可直接复用（as-is 或极小改动）

| 模块 | 文件 / 行数 | 复用价值 | 备注 |
|---|---|---|---|
| 事件信封与 DraftEvent | `src/protocol.ts`（255 行） | 直接复用信封 + 事件类型骨架 | 去掉 `TurnInput.transcript`、`SessionProfile` 枚举、`InputSummary.recordId` 等产品字段 |
| SSE 写出 | `src/http/sse.ts`（53 行） | as-is | `retry:`、`: ok` 强制 flush、`setNoDelay`、`X-Accel-Buffering: no` 都对；把 `event:` 改成规范要求的恒定 `message` 或保留 type 并写进规范 |
| 无损重放次序 | `src/http/server.ts` 296–336 行 `streamEvents` | 直接复用算法 | 先挂订阅缓冲 → 读历史写出 → 放开缓冲按 `seq<=sent` 去重。这是唯一正确的次序 |
| 先落库再扇出 + emit 串行化 | `src/agent/session.ts` 86–103 行 | 直接复用设计 | promise 链保证 append 顺序 == 产生顺序 |
| heartbeat 不占 seq | `session.ts` 125–148 行 | as-is | |
| OpenAI 兼容 provider | `src/providers/openai-compatible.ts`（339 行） | **高价值，as-is** | 覆盖 qwen/kimi/deepseek 方言：`reasoning_content`/`reasoning`/`<think>`、`max_tokens` 400 自动换字段、5 种缓存用量拼法 `parseUsage`、按 `index` 累积 tool_calls 分片、`\r\n`/注释行/非 JSON 行容错、assistant 带 tool_calls 补空 content。有 11 条方言单测 |
| Provider 抽象 | `src/providers/provider.ts`（92 行） | as-is | 单一 `stream()`，usage 作为 chunk，tool call 只在拼装完成后发出 |
| 降级链 | `src/providers/resilient.ts`（100 行） | as-is | 关键决策：首 chunk 前可重试/降级，首 chunk 后绝不重试；退避带抖动 |
| 前缀稳定化机制 | `src/context/assemble.ts` 77–89 行 `stableStringify`、214–244 行 `buildPrefix`、281–290 行 `assemblePrompt` | 复用**机制**不复用内容 | `SYSTEM_TEMPLATE`（131–143 行）和 `PADDING_UNITS`（181–192 行）是产品文案，必须换成可配置；`estimateTokens`（96–104 行）是 `chars/2.5` 粗估，要换 tokenizer |
| 安全阀 | `src/agent/loop.ts` 211–223、424–457 行 | 直接复用 | maxSteps / wallClock / cost / maxToolCalls / 同名同参连续 3 次先提醒再终止 |
| `finish_reason=length` 丢弃全部 tool call | `loop.ts` 354–405 行 | 直接复用 | 通用 harness 下更重要（bash 参数被截断是安全问题） |
| write-ahead `tool.call.started` + 崩溃恢复两个恢复码 | `loop.ts` 512–535 行；`src/agent/repair.ts`（154 行） | 直接复用 | `TOOL_OUTCOME_UNKNOWN` vs `TOOL_NOT_STARTED` 区分对有副作用的通用工具是刚需 |
| 压缩切点工具配对平衡 | `src/context/tool-pairing.ts`（86 行）、`src/context/compact.ts`（111 行） | 直接复用算法 | `SUMMARIZER_SYSTEM` 文案要通用化 |
| 工具注册表 | `src/tools/registry.ts`（102 行） | 复用骨架 | 按名排序 + 稳定序列化 + 执行前 schema 校验 + `ToolContext` 注入身份；需要扩展成支持 MCP 工具、动态注册、per-session 启用集 |
| 租约 CAS 的 SQL 形态 | `src/store/sqlite.ts` 156–168 行 | 复用思路 | 「带 WHERE 的 UPDATE，靠 affected rows 判断」可直接翻译成 MySQL，但要加 fencing token 列（见 §4） |
| 脱敏工具 | `src/obs/redact.ts`（75 行） | 保留为**可选**能力 | 改成按 tenant 配置的脱敏级别，默认关（通用 API 要回原文） |
| 指标名与维度 | `src/obs/metrics.ts`（201 行） | 复用指标清单 | `agentrt_prompt_cache_hit_ratio`、`agentrt_ttft_ms`、`agentrt_provider_fallbacks_total`、`agentrt_tool_calls_discarded_total`、`agentrt_repaired_orphan_calls_total` 等 |
| 测试脚手架与假厂商 | `test/helpers.ts`、`src/scripts/fake-vendor.ts`（90 行）、`probe-vendor.ts`（343 行） | 复用 | 假厂商复刻 DeepSeek/DashScope 两种方言，探针脚本接新厂商时先跑 |

### 3.2 产品特定、**不应**带入新 runner

| 模块 | 文件 / 行数 | 原因 |
|---|---|---|
| 意图路由 | `src/agent/intent.ts`（212 行）+ `loop.ts` 128–167 行 | 8 个中文关键词意图 + per-intent maxSteps/工具白名单，是语音记录产品的固定编排；通用 harness 的「步数不可预测」正是文档 06 自己承认该用 agent loop 的情形。可保留**机制**（per-agent 的 maxSteps 与工具集），扔掉分类器与策略表 |
| 会话画像 | `src/agent/profile.ts`（125 行）、`protocol.ts` 232 行 `SessionProfile` | 产品枚举；替换为通用 `agent` 定义 |
| 业务工具 | `src/tools/business.ts`（252 行） | 假数据的 `search_records/analyze_sentiment/tag_record/create_reminder`；只保留其中「工具内租户断言」「幂等 receipt」两个**模式** |
| 「无代码执行」的硬约束 | `registry.ts` 5–6 行注释、`assemble.ts` 139 行 system 文案、文档 02 §0 判断一 | 新简报是通用 harness，代码执行/文件/shell 是可选工具面，需要的是**沙箱与权限策略**，不是禁止 |
| 转写输入形态 | `protocol.ts` 200–208 行 `TurnInput.transcript`、`server.ts` 434–481 行 `parseTurnInput` | 换成通用 parts/attachments |
| system prompt 与 padding 文案 | `assemble.ts` 131–143、181–192 行 | 写死「随录 App」 |
| 默认脱敏进事件流 | `loop.ts` 186 行 `summarizeInput`、534/578 行 `redact()` | 见 §1.2(d) |
| HS256 自签 JWT | `src/auth/jwt.ts`（77 行） | 生产要换 IdP/网关下发身份 + API key |
| `MemorySessionStore` | `src/store/memory.ts`（163 行） | 仅测试用 |

### 3.3 代码级缺陷（比 README 缺口清单更具体，影响分布式正确性）

1. **租约从不续期。** `WriteLease.renew()` 在 `src/` 中没有任何调用者（只有 `test/lease.test.ts:134` 调用）。`leaseTtlMs=30s`（`config.ts` 85 行）。这意味着任何超过 30s 的 turn 之后，租约在 DB 里已过期；此时另一节点的 `open('write')` 会成功抢占，原节点后续 `appendEvents` 被 `assertLease` 拒绝 → turn 以 `internal_error` 失败。单机测试看不到这个问题，多副本一定会撞上。
2. **没有 fencing token。** 文档 02 §3.3 与 03 §6.4 都要求单调 fencing token 且 DB 端校验，但 `src/` 中 `fencing` 只出现在注释（`store.ts` 12 行）。实际防护是 `assertLease`（`sqlite.ts` 195–205 行）比对 `owner_id` + `owner_expires_at`，而且这次校验在 `BEGIN IMMEDIATE` **之外**（207–215 行），存在 check-then-write 窗口。生产 MySQL 实现必须把 token 放进 `UPDATE ... WHERE fence_token=?` 里。
3. **runtime 永不回收。** `SessionManager.runtimes`（`session.ts` 315 行）只在 `closeAll()` 时清空；没有 idle 淘汰。每个 runtime 持有 `history`、`frozenSummaries`、`seenPrefixes`。长期运行的进程内存单调增长，且租约（若续期）永不释放 → 同一 session 永远钉在首个节点。
4. **对话历史只在进程内存。** `TurnHost.history`（`loop.ts` 75 行）；README 缺口清单也承认「这是当前最大的一个洞」。节点切换 = 上下文丢失。`SessionStore` 接口没有 03 §6.4 定义的 `appendContext/readContext`。
5. **跨副本订阅是 250ms 轮询。** `server.ts` 339–350 行。
6. **`readEvents` 默认 `limit=10_000` 且无分页游标**（`sqlite.ts` 235 行）；长会话重放会一次拉全量。
7. **`updateState` 是读-改-写整行**（`sqlite.ts` 256–276 行），`addCumulativeUsage` 也是先 `getState` 再 `updateState`（`session.ts` 163–179 行）；单写者下无害，但 fencing 之后应改成原子 `SET usage = usage + ?`。
8. **`text.delta` 每 4 条落一次库**（`loop.ts` 296 行）；20M DAU 下写放大不可接受（§5.3）。
9. 请求体 `steer` 字段名 `message` 与规范 `text` 不一致；SSE `event:` 字段与规范不一致；错误码命名不一致（§2.1）。

---

## 4. 存储 schema 与云迁移映射

### 4.1 PoC 的 DDL（`src/store/sqlite.ts` 31–90 行）

```sql
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
  profile TEXT NOT NULL DEFAULT 'chat',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'idle',
  context_epoch INTEGER NOT NULL DEFAULT 1, turn_count INTEGER NOT NULL DEFAULT 0,
  active_turn_id TEXT, title TEXT, usage_json TEXT NOT NULL DEFAULT '{}',
  owner_id TEXT, owner_expires_at INTEGER);            -- 租约字段与投影混在一张表
CREATE INDEX idx_sessions_tenant ON sessions(tenant_id, updated_at DESC);

CREATE TABLE events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL,
  type TEXT NOT NULL, turn_id TEXT, data_json TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)) WITHOUT ROWID;

CREATE TABLE compactions (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  context_epoch INTEGER NOT NULL, before_tokens INTEGER NOT NULL, after_tokens INTEGER NOT NULL,
  dropped INTEGER NOT NULL, summary TEXT NOT NULL);

CREATE TABLE receipts (tenant_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, tool TEXT NOT NULL,
  receipt_id TEXT NOT NULL, created_at INTEGER NOT NULL, result_json TEXT NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key));
```

文档 02 §3.3 / §6.3 补充的生产要求：关系库**按 userId 分片**（查询模式是「某用户的所有会话」），逻辑分片一开始就预留 256/1024；事件日志按天分区、7 天后转冷（OSS + Parquet）；delta 合并落库；上下文日志（加密）单独建表、90 天保留；usage 台账单独表。

### 4.2 映射到 MySQL + Redis + 对象存储

**MySQL（真相 + 投影，按 user_id 分片）**

| 表 | 关键改动 |
|---|---|
| `sessions` | 去掉 `owner_id/owner_expires_at`（移到 Redis）；**新增 `fence_token BIGINT NOT NULL DEFAULT 0`**；`usage_json → JSON`；`profile → agent_id VARCHAR`；加 `shard_key = user_id`；`INDEX (tenant_id, user_id, updated_at)`；`status/active_turn_id` 保留 |
| `events` | `PRIMARY KEY (session_id, seq)`（InnoDB 聚簇索引天然适合 `seq > ?` 范围扫）；`data_json → JSON/MEDIUMTEXT`；**只存里程碑事件**（turn.*/tool.call.*/usage/context.compacted/session.idle），`text.delta` 不入库或按 step 聚合成一条 `text.block`；按 `ts` 日分区需把分区列纳入 PK（`(session_id, seq, day)`）或用归档作业替代分区 |
| `messages`（新，对应 03 §6.4 `appendContext`） | `(session_id, seq, turn_id, step, role, parts JSON/加密 BLOB, token_count)`；这是「消息历史读取 API」和「prompt 重建」的来源；与事件共用 seq 空间 |
| `compactions` | 保留；加 `covers_from_seq / covers_to_seq` 让投影能跳过被 shadow 的区间 |
| `receipts` | 保留 PK `(tenant_id, idempotency_key)`；加 `expires_at` + 定期清理，或改放 Redis `SET ... EX 90d` |
| `usage_ledger`（新） | `(tenant_id, user_id, session_id, turn_id, step, provider, model, prompt/completion/cached tokens, cost, ts)`；按天分区 |
| `tenant_provider_config`（新，BYOK） | `(tenant_id, provider_id, base_url, api_key_enc, model_aliases JSON, pricing JSON, quota JSON)` |

seq 分配与 fencing 在 MySQL 里的一条 SQL：
```sql
UPDATE sessions SET last_seq = last_seq + :n, updated_at = :now
 WHERE session_id = :sid AND fence_token = :token;   -- affected rows = 0 → 僵尸 writer，拒绝
-- 同一事务内 INSERT INTO events ... seq = old_last_seq + 1..n
```
不要用 Redis INCR 分配 seq：协议要求客户端断言 seq **连续**（03 §4.2），Redis 分配在崩溃时会留洞。

**Redis（热状态，按 sessionId 分片）**

| key | 用途 | 来源 |
|---|---|---|
| `lease:{sid}` = `{owner, token, exp}`，`SET NX PX` + Lua 续期 | 单写者租约 | 02 §3.3 |
| `fence:{sid}` INCR | fencing token 发号；抢到租约时把新 token 写回 MySQL `sessions.fence_token`（同一次 UPDATE 校验旧 token） | 02 §3.3 |
| `owner:{sid}` = runnerAddr（与 lease 同 TTL） | agent-router 的所有权目录 | §1.2(a) |
| `ev:{sid}` Redis Stream（`XADD MAXLEN ~ 2000`，TTL 1h） | 热重放缓冲：delta 级事件的短期真相；`?after=` 先查 Stream，miss 再查 MySQL 里程碑 | 02 §3.4「可丢有 DB 兜底」的具体化 |
| sharded pub/sub `SSUBSCRIBE ev:{sid}` | 跨副本 SSE 扇出 | 02 §3.4 |
| `rl:{tenant}:{window}`、`rl:{user}:{window}`、`budget:{user}:{day}` | 限流与日预算 | 02 §2 ②、§3.2 |
| `idem:{tenant}:{key}` | HTTP `Idempotency-Key` receipt | 03 §1.3 |
| `provider:quota:{provider}:{key}` | 厂商 key 池配额/熔断状态 | §1.2(f) |

**对象存储（OSS）**

| 内容 | 说明 |
|---|---|
| 大工具输出（> N KB） | 事件/消息里只存指针 + hash；`modelProjection` 裁剪后回灌 |
| 附件 / 上传文件 / 图片 | 通用 harness 的 attachments；内部 scheme 防 SSRF（03 §3.1） |
| 事件冷分区 | 7 天后 Parquet 归档，审计/数仓用 |
| 工作区快照 | 若启用代码执行/文件工具，session 工作区落 OSS，runner 本地只做缓存（保住 sessionId 路由） |
| 导出 / 删除权证据 | 用户数据可携带与级联删除（02 §7.2） |

---

## 5. 容量数字：文档 §6 的假设，以及 20M DAU 的重参数化

### 5.1 文档 §6 / §1.2 的原始参数（保守 / 激进）

| 参数 | 保守 | 激进 |
|---|---|---|
| DAU | 250 万 | 500 万 |
| 记录/天 | 500 万 | 1,500 万 |
| turn / 记录 | 1.5 | 2.0 |
| turn / 天 | 750 万 | 3,000 万 |
| 平均 QPS | 87 | 347 |
| 峰值 QPS（晚间 ×4） | 350 | 1,390 |
| 单 turn 时长 | 50 s | 50 s |
| 峰值并发 turn | 17,500 | 69,500 |
| 单进程并发 turn（Node，无沙箱） | 500–2,000（需压测） | 同 |
| 进程数 | 10–35 | 35–140 |
| SSE 连接/接入节点 | 1 万 | 同 → 2–7 节点（含冗余翻倍） |
| 事件 / turn | 50（实测 54） | 同 |
| 事件量 | 3.75 亿/天 × 300 B = 112 GB/天 = 41 TB/年 | |
| 上下文日志 | 20 KB / session，90 天 | |
| 单 turn token | 8,000 前缀 + 500 输入 + 800 输出 | |
| 单 turn 成本（DeepSeek-flash，缓存 85%） | ¥0.0037（0% 缓存 ¥0.0117） | |

文档 §6.1 的关键警告：opencode 子进程模式（150–250 MB/进程，1 turn/进程）在此量级需要 17,500–69,500 个进程，「不可行」；deepseek-harness SDK 模式 agent 永不释放会 OOM。

### 5.2 20M DAU 重参数化（三档，均为峰值 ×4）

| 参数 | 轻（T=1.5, D=50s） | 中（T=3, D=90s） | 重（T=6, D=180s） |
|---|---|---|---|
| turn / 天 | 3,000 万 | 6,000 万 | 1.2 亿 |
| 平均 QPS | 347 | 694 | 1,389 |
| 峰值 QPS | 1,390 | 2,780 | 5,560 |
| 峰值并发 turn（= 并发 SSE 下限） | 6.9 万 | 25 万 | 100 万 |
| runner 进程数 @1,000 turn/进程 | 70 | 250 | 1,000 |
| runner 进程数 @ 每 session 一个沙箱/子进程 | 6.9 万 | 25 万 | 100 万 → 不可行 |
| 事件 / 天 @50 事件/turn | 15 亿 | 30 亿 | 60 亿 |
| 事件落库 @300 B | 450 GB/天 | 900 GB/天 | 1.8 TB/天 |
| 里程碑事件 / 天 @10/turn | 3 亿 | 6 亿 | 12 亿 |
| 消息历史 @20 KB/session、90 天 | 与 session 数相关：2,000 万 session/天 × 20 KB × 90 = 36 TB | | |
| LLM 成本/月 @¥0.0037/turn（缓存 85%，单步） | ¥3.3 M | ¥6.7 M | ¥13 M |
| LLM 成本/月 @ agent 4× token（文档 06 §1.3 引 Anthropic 倍数） | ¥13 M | ¥27 M | ¥53 M |

T = turn/DAU/天，D = 平均 turn 时长。通用 agent 的 T 和 D 都比语音记录产品高，「中」档是合理起点。

### 5.3 重参数化后必须改变的设计决策

1. **delta 不进 MySQL。** 中档 900 GB/天 的事件写入不可接受；改为 Redis Stream 热缓冲（1h）+ 里程碑事件入库 + step 级 `text.block` 聚合；`?after=` 先热后冷。这改变了 02 §3.5「持久化重放」的承诺：**超过 1h 的断线只能重放里程碑 + 最终文本**，需写进协议。
2. **runner 的容量模型取决于工具面。** 若通用 harness 默认开代码执行/文件工具且每 session 一个沙箱，进程数上升 2–3 个数量级。必须分层：默认「无沙箱、纯 API 工具 + 远程 MCP」的轻 runner（1,000 turn/进程），按 agent 配置才起沙箱的重 runner（独立池、独立容量）。这是 02 §6.1 那张表在通用 harness 下的直接后果。
3. **MCP 连接不能 per-session 起子进程。** stdio MCP 在 20M DAU 下等价于沙箱问题；生产应以远程 MCP（HTTP/SSE）为主，stdio MCP 限定在重 runner 池，并做连接池/租户级复用。
4. **厂商配额是硬上限。** 峰值 2,780 QPS 打到单一国产厂商远超常规账号 RPM/并发配额；需要多 key 池 + 多厂商分流 + 企业配额谈判，配额状态全局在 Redis（§1.2(f)）。文档 02 §3.6 只定性提到「熔断 + 配额」，没有按这个量级算过。
5. **Redis 扇出量级。** 中档：3,000 万 turn/天 × ~100 条批量 delta ≈ 30–60 亿消息/天，峰值 15–30 万 msg/s；单 Redis 节点承受不了，必须 sharded pub/sub 多分片或 Kafka；PoC 的 250ms 轮询彻底不可行。
6. **租约与优雅迁移。** D=90–180s 的 turn 下，30s TTL + 10s 续期必须真实实现（PoC 没有），并在 step 边界做 checkpoint 以支持发布/缩容时的接管。
7. **MySQL 分片从第一天起按 user_id 做 1,024 逻辑分片**（02 §6.3 建议），本地单库 MySQL 只作为开发形态，schema 里预留 shard key。
8. **文档给的成本第一杠杆（前缀稳定化、缓存命中率）在通用 harness 下更难达成**：per-tenant system prompt、动态工具集、MCP 工具列表变化都会改前缀。需要 `contextEpoch` 从 session 级扩展到「agent 定义版本 + 工具集哈希」的复合键，并把 `agentrt_prompt_cache_hit_ratio` 作为上线第一天的头号指标（02 §8 #7）。

---

## 6. 文档 05 / 06 的头条结论（各一段）

**05 记忆层设计**：用户的真实问题是**聚合型**（计数、趋势、跨期对比）而非检索型，ConvoMem 数据显示 fact-extraction 类方案在多证据聚合上只有 25% 对 long-context 的 83%；成本瓶颈是 LLM 抽取（比 embedding 贵 27–200 倍）而非向量存储；现成记忆框架（mem0/Zep/MemPalace）的 benchmark 大面积不可信；per-user 托管知识库在 5,000 万用户下不可行。因此设计成三层（L1 结构化事实 / L2 within-user 暴力扫 + RRF 检索 / L3 分层摘要 + 长期画像），写入路径零 LLM + 日终一次批量抽取，读取路径按意图**预检索**而不是让 agent 用工具去取，长期画像进不可变前缀区并 bump `contextEpoch`。对新项目的含义：这是产品记忆层，不属于通用 runner；runner 只需提供「前缀区可注入 + epoch」和「追加区可注入预检索结果」两个钩子（05 §10 指向 `assemble.ts`）。

**06 固定工作流 vs 自主循环、自研 vs LangChain**：两轴分开。轴一：语音记录主链路步数可预测，按 Anthropic/OpenAI 判据不该用 agent loop，固定编排首字 ~550ms 对 ~1750ms、token 约 1/4；只有 `open_ended` 和异步深度任务保留受限 agent loop。轴二：自研胜出，决定性理由是断线重放（`join_stream(last_event_id)`）不在 LangGraph 开源库里、国内模型集成崩塌、流式 tool call 未修 bug 与首字 SLO 冲突；但作者明确「这是场景特异结论」，且列出了改口条件。对新项目的含义：**轴一的结论不适用**（通用 harness 正是「步数不可预测」的场景），**轴二的理由仍然成立**（自研 runner，且 PoC 的基础设施层「一行不动」正是要带走的部分）。

---

## 7. 对新项目的行动清单

**直接带走（设计 + 代码）**：事件信封与 seq 水位线；SSE 写出与无损重放次序；先落库再扇出；heartbeat 不占 seq；`openai-compatible.ts` 与 `resilient.ts`；安全阀五条；`length` 丢弃 tool call；write-ahead started + 两个恢复码；压缩切点配对平衡；前缀稳定化**机制**（stableStringify、按名排序、epoch）；工具内租户断言与幂等 receipt 模式；指标清单；假厂商 + 探针脚本。

**带走设计、重写实现**：租约（加 fencing token、真实续期、Redis 实现、runtime 回收）；SessionStore（MySQL 分片 + `messages` 表 + Redis 热层）；跨副本扇出（sharded pub/sub / Kafka）；LLM 配额与 key 池（全局状态）。

**不带走**：意图路由与策略表、会话画像枚举、业务工具、转写输入形态、写死的 system prompt/padding 文案、默认脱敏进事件流、HS256 自签 JWT、「无代码执行」的硬约束、对等转发形态（改为独立 router）。

**协议层必须新增**：消息历史读取、provider/model 目录与 BYOK 配置、工具/MCP/skills/plugins 管理面、权限审批事件与响应接口、attachments/工作区、通用 `agent` 定义替代 `profile`、`stream:false` 与异步提交、API key + 端用户双层鉴权。

**上线前必须做的验证（文档自己列了但没做）**：3 进程共享 MySQL + Redis，turn 中 kill 租约持有者，断言接管、无空洞、`?after=` 补齐；单进程并发 turn 压测（文档给的 500–2,000 只是估算）；真实厂商 API 的方言探针。
