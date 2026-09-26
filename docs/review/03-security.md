# 安全专项 review（03，2026-09-26）

范围：`apps/agent-runner`、`packages/{core,providers,store,protocol}` 的当前实现。设计文档 §14 #5 把"安全威胁模型"列为已知缺口，本文的 §1 是它的第一版；§2 起是逐条发现。

所有结论都在本仓代码上核对过行号；标注 **[实测]** 的条目附了在本机跑出来的证据。

---

## 1. 威胁模型（第一版）

### 1.1 信任边界

```
                     ┌─ 边界 A：公网 ─────────────────────────────┐
  租户后端 / App ──►  │  agent-router（未实现）──► agent-runner     │
                     └───────────────┬───────────────────────────┘
                                     │ 边界 B：runner 进程内
                     ┌───────────────┴───────────────────────────┐
                     │  SessionHost（单写者 + fence）             │
                     │  PiEngine ──► 工具执行（同进程，无沙箱）    │
                     └──┬──────────────┬─────────────┬───────────┘
                        │边界 C        │边界 D       │边界 E
                     MySQL/Redis   模型厂商 API    web_fetch / 未来 MCP
                     /对象存储      （含租户 BYOK   （任意第三方内容）
                                     自定义 baseUrl）
```

- **边界 A（公网 → 服务）**：唯一凭证是 `Authorization: Bearer <service api key>`。`X-User-Id` 在边界 A 内侧**没有任何校验**，它是租户的自述，不是身份证明。当前实现里边界 A 与"租户内用户之间的边界"是同一条线 —— 也就是说**租户内用户之间实际上没有边界**（见 C1/C2）。
- **边界 B（进程内）**：工具在 runner 进程内直接执行，无沙箱（设计 §0 明确一期不做）。因此"模型输出 → 工具参数"这条路径上，模型是**半可信**输入源，`beforeToolCall` 审批网关是唯一的执行前控制点。
- **边界 C（存储）**：runner 是唯一写者，靠 Redis 租约 + fence。DB 凭证在 `MYSQL_URL` 里（含口令），无 IAM/最小权限划分。
- **边界 D（出站到模型厂商）**：BYOK 让**租户可以指定出站 URL 和出站 header** —— 这把边界 D 的目标地址交给了不可信方（见 C4）。
- **边界 E（第三方内容入上下文）**：`web_fetch` 的正文、未来的 MCP tool description / tool result 都会原样进模型上下文，是 prompt 注入的主入口，当前无任何标记或隔离。

### 1.2 资产（按损失排序）

| 资产 | 存放位置 | 泄露/篡改后果 |
|---|---|---|
| 租户 BYOK 模型密钥 | `provider_configs.secret_cipher`（AES-GCM）、`config.headers`（**明文**） | 直接经济损失、租户追责 |
| 平台模型密钥 | runner 进程 env（`API_KEY`） | 全平台成本被盗刷 |
| 端用户会话内容 | `sessions/items/events/turns` | 隐私事故；本服务面向消费端，内容极可能含个人敏感信息（PIPL） |
| service api key | `api_keys.key_hash`（SHA-256） | 整租户被接管 |
| 计费账本 | `usage_ledger` | 伪造归属、拒付纠纷 |
| 内网可达性 | runner 的出站能力 | 云元数据/内网服务被 SSRF 打穿 |
| 可用性 | runner 进程内存/fd/并发槽 | 20M DAU 下单点雪崩 |

### 1.3 攻击者画像

| 代号 | 身份 | 已有能力 |
|---|---|---|
| **A1** | 恶意/被攻破的租户（持有一把合法 service api key） | 全部 `/v1` 端点 |
| **A2** | 恶意端用户，其请求经由**租户自己的**客户端（App/小程序，若 key 下发到端侧则等价于 A1） | 全部 `/v1` 端点 + 任意 `X-User-Id` |
| **A3** | 外部无凭证攻击者 | `/healthz` `/readyz` `/v1/capabilities`；若 `BOOTSTRAP_API_KEY` 未改则升级为 A1 |
| **A4** | 被 prompt 注入控制的模型（经由 web_fetch 正文 / MCP / 用户输入） | 选择工具与参数、撰写审批理由 |
| **A5** | 恶意第三方服务（模型厂商端点、被 fetch 的站点） | 控制响应体与大小 |

### 1.4 本期明确不防的（需要写进对外 SLA）

租户自身作恶到"用完自己的额度"这种程度；同租户内的完整 RBAC；模型输出内容安全（设计 §13 #6 只留 middleware 插槽）；运维人员的内部越权（无审计日志，见 M11）。

---

## 2. 发现汇总

严重度定义：**Critical** = 可直接造成跨用户/跨租户数据泄露、密钥泄露或未授权接管；**High** = 需要一个可满足的前置条件，或造成服务级不可用；**Medium** = 需要多步组合或影响面有限；**Low** = 加固项。

| # | 严重度 | 位置 | 攻击场景 | 修复 |
|---|---|---|---|---|
| **C1** | Critical | `packages/core/src/session/host.ts:161-165`、`packages/store/src/mysql/store.ts:121-127`、`apps/agent-runner/src/app.ts:115-118` | **租户内跨用户读写全部会话数据**。`getSession` 只按 `tenantId` 过滤，完全不看 `userId`，而它是几乎所有会话路由唯一的授权检查（路由逐条审计见 §3）。用户 A 拿到（或枚举到）用户 B 的 `sess_...` 后：`GET /v1/sessions/{B}/items` 读全部对话、`GET .../events?after=0` 重放全历史、`POST .../turns` 以 B 的名义发言且费用记到 B 名下、`POST .../approvals/{id}` 批准 B 的危险工具、`DELETE` 删掉 B 的会话。枚举更简单：`GET /v1/sessions` **不带 `X-User-Id`** 时 `userId` 为 `undefined`（app.ts:117 的 `?? (principal.userId \|\| undefined)`），直接分页拉出**全租户**所有会话（含 `title`、`metadata`、`usage`） | `store.getSession/listSessions/deleteSession` 增加必填 `userId` 参数；`host.getSession(principal, id)` 断言 `s.userId === principal.userId`（管理面另开需要显式标记的内部接口）；`GET /v1/sessions` 强制 `requireUser` 且忽略客户端传入的 `?userId` |
| **C2** | Critical | `apps/agent-runner/src/auth.ts:22-25`、`host.ts:141`、`host.ts:461`（`appendUsage`） | **身份完全由客户端自述**。`X-User-Id` 只做 `length <= 128` 检查（连 `Principal` 的 zod 都没 parse），且 `POST /v1/sessions` 的 body 里 `req.userId` 还能再覆盖一次（`userId: req.userId ?? principal.userId`）。A2 任选 `X-User-Id` 即成为任意用户；配合 `appendUsage` 用的是 `session.userId`，可把成本栽给任意用户 ID。设计 §5.1 写的是"`X-User-Id`（**或租户配置的端用户 JWT**）"，JWT 分支未实现 —— 于是"两层鉴权"实际只有一层。**关键后果**：本服务目标是 20M+ DAU 消费端，租户把 key 放进 App/小程序是极可能的部署形态；那种形态下一把泄露的 key = 全部用户互相可读写 | 一期：文档与 SLA 明确"service key 绝不可下发到端侧"，并在 `/v1/capabilities` 与 README 里写明 `X-User-Id` 是**租户自述**；上云前：实现租户配置的端用户 JWT（租户公钥验签，`sub` → `userId`），`X-User-Id` 降级为仅在"租户已声明服务端调用"的 key 上可用（key 上加 `kind: server \| client` 字段） |
| **C3** | Critical | `host.ts:285`（`autoApproved` 初始化）、`packages/protocol/src/session.ts:73`（`metadata: z.record(z.unknown())`） | **客户端 metadata 直接绕过审批网关**。`autoApproved` 从 `session.metadata.autoApprovedTools` 读取，而 `metadata` 是 `CreateSessionRequest` 里的任意 JSON。`POST /v1/sessions {"agentId":..., "metadata":{"autoApprovedTools":["dangerous_tool","web_fetch",...]}}` → 该 session 所有需审批工具永久自动放行（`host.ts:479` 的 `state.autoApproved.has(tool.name)` 短路）。`untrusted` 策略（设计 §11 声明的默认）被完全架空。**附带 DoS [实测]**：该字段没有类型校验，传 `{"autoApprovedTools": 5}` → `new Set(5)` 抛 `TypeError: number 5 is not iterable` → `startTurn` 500 | 把审批状态从 `metadata` 移到 `sessions` 表的独立列（或独立表），只由 `acceptForSession` 这条服务端路径写入；`metadata` 改为 `z.record(z.unknown())` + 保留键黑名单（`autoApprovedTools`、`lastCompactionSeq`）+ 大小上限 |
| **C4** | Critical | `packages/protocol/src/provider.ts:49,52`、`packages/providers/src/service.ts:119-134`、`apps/agent-runner/src/main.ts:28`、`app.ts:94-97` | **BYOK = 已认证的 SSRF 代理，且带响应回显**。`baseUrl` 只有 `z.string().url()`，`headers` 是任意 `z.record(z.string())`；`ensureRegistered` 把 `baseUrl` 原样交给 pi，`ProviderServiceOptions.fetch`（注释里写的"出站代理/审计/超时"）在 `main.ts:28` **没有传**，于是走全局 `fetch`，无白名单无代理。攻击：`PUT /v1/providers/x {"baseUrl":"http://169.254.169.254/latest/meta-data/","models":[{"id":"m"}]}` → `POST .../turns {"model":{"provider":"x","model":"m"}}` → runner 向内网发 POST，响应/错误文本经 `turn.error.message`（`host.ts:617`）和 SSE `error` 事件回传给攻击者。`web_fetch` 那套 `assertPublicHost` 在这条路上完全不生效。可打的目标：云元数据（阿里云 `100.100.100.200` 虽被 `web_fetch` 的正则覆盖，但这条路径没有任何正则）、`http://127.0.0.1:8787/v1/...`（runner 自己）、Redis/MySQL（HTTP 打不通协议但可探测端口与 banner）、K8s API。`headers` 任意可控还意味着可注入 `Host`/`Authorization`/`X-Forwarded-For`。**升级路径**：`PUT/DELETE /v1/providers/:id` 没有 `requireUser`、没有任何管理面区分，所以一个被攻破的端用户客户端可以改写**整租户**的 provider，把 `baseUrl` 指向攻击者服务器 —— 全租户的 prompt 与对话内容实时外泄 | 出站统一走注入的 `fetch`：DNS 解析后校验 IP 在公网（复用并加固 `assertPublicHost`，见 H4）、强制 `https:`、端口白名单 `443`、域名走租户可配的 allowlist + 平台 denylist、固定超时、剥离 hop-by-hop header；`headers` 键做白名单（禁 `host`/`authorization`/`x-forwarded-*`/`cookie`）；provider 写操作移到独立的租户管理面 key（与端用户调用面 key 分离） |
| **C5** | Critical | `apps/agent-runner/src/config.ts:14`、`main.ts:16` | **可猜测的引导密钥，且每次启动都无条件重建**。`BOOTSTRAP_API_KEY` 默认 `"dev-key"`，`BOOTSTRAP_TENANT_ID` 默认 `"t_dev"`，`main.ts:16` 无条件 `createApiKey(...)`（`INSERT IGNORE`）。生产漏配环境变量 → A3 用 `Authorization: Bearer dev-key` 即获得 `t_dev` 的全部权限（建 agent、读全租户会话、改 provider → 接上 C4）。而且**没有任何 key 签发/吊销 API**（`generateApiKey()` 在 `auth.ts:7` 导出但全仓无调用方），所以即便发现被入侵，也只能改 DB | 生产环境禁止默认值：`BOOTSTRAP_API_KEY`/`SECRETS_MASTER_KEY` 在 `NODE_ENV=production` 下改为**必填且无 default**（zod `superRefine`）；引导逻辑加 `if (cfg.BOOTSTRAP_ENABLED)` 开关，默认关；补 key 的签发/轮换/吊销接口（走管理面） |
| **C6** | Critical | `config.ts:13`、`.env.example:12` | **密钥主密钥默认全零**。`SECRETS_MASTER_KEY: z.string().regex(...).default("00".repeat(32))` —— 漏配时静默通过校验，所有租户 BYOK 密钥以一个公开已知的密钥加密，等价于明文入库。`.env.example` 里也是全零，复制粘贴即中 | 同 C5：生产无 default；`LocalAesGcmCipher` 构造时拒绝全零密钥；上云前换 KMS（设计 §7.4 的 `kms://` 信封加密） |
| **H1** | High | `packages/core/src/tools/dynamic.ts:9,42-49`、`host.ts:591-594`、`app.ts:196-202` | **动态工具结果桥接可跨会话、跨租户注入**。`DynamicToolBridge.pending` 是 **SessionHost 级（进程级）** 的 Map，**只用 `toolCallId` 做键**，与 session/tenant 无关。`submitDynamicToolResult(sessionId, toolCallId, ...)` 只检查 `this.active.has(sessionId)`，不校验该 `toolCallId` 属于该 session；路由层也不校验 `turnId` 属于该 session，`DynamicToolResultRequest.toolCallId` 是裸 `z.string()`。攻击：攻击者在同一 runner 上开一个自己的活跃 session，然后 `POST /v1/sessions/{自己的}/turns/{任意}/tool-results {"toolCallId":"<受害者的>","content":[{"type":"text","text":"<注入内容>"}]}` → 受害者 agent 收到攻击者构造的工具结果。`toolCallId` 由模型厂商生成，同租户内可直接从他人 session 的 `/items` 读到（C1），跨租户则需猜测（部分 OpenAI 兼容厂商会给出短的、序号化的 id） | `pending` 的键改为 `${sessionId}:${toolCallId}`，并在 `resolve` 时校验 `turnId` 一致；路由层校验 `turnId` 属于 `sessionId`（`getTurn` 已按 session 过滤，把它加进来即可）；`toolCallId` 加格式与长度约束 |
| **H2** | High | `packages/protocol/src/session.ts:86`、`packages/protocol/src/item.ts:6`、`main.ts:38`（无 `bodyLimit`） | **请求体无上限 → OOM**。`input: z.array(InputPart).min(1)` **没有 `.max()`**，单个 text part 上限 500,000 字符；Hono/`@hono/node-server` 默认不限制 body（全仓 grep 无 `bodyLimit`）。一个 `POST .../turns` 请求即可携带 GB 级 JSON，`c.req.json()` 先整体解析进内存再校验。同类无界字段：`metadata`（session/turn 都是任意 JSON）、`dynamicTools[].parameters`（`z.record(z.unknown())`，64 个无大小限制的 JSON Schema，还会进每次模型调用）、`AgentDefinition.instructions`（200KB × 无版本数量限制） | 接入层 `bodyLimit`（如 1MB，图片走对象存储）；`input` 加 `.max(32)`；`metadata`/`parameters` 加序列化后字节上限；agent 版本数加配额 |
| **H3** | High | `host.ts:190-195`、`apps/agent-runner/src/sse.ts:23,35-39`、`app.ts:155,162,214`、`packages/protocol/src/event.ts:74` | **SSE 是最便宜的放大器**。(a) `subscribe` 里是一个**无界分页循环**，每页 500 条，把 `afterSeq` 之后的**全部**历史读出来并推给客户端；`after` 完全客户端可控（`app.ts:214`，`Last-Event-ID` 同）。长会话下 `GET /events?after=0` 一条请求就是全量历史重放 + 全量 `JSON.parse`；并发 N 条即放大 N 倍。(b) `sse.ts` 的 `queue` 无背压，慢客户端 + 快会话 → 队列无界增长。(c) 无 per-tenant/per-session 连接数上限。(d) `parseExclude` 不校验白名单（`EXCLUDABLE_EVENT_TYPES` 定义了但从未使用），客户端 `?exclude=session/status/changed` 可让 `POST .../turns` 的 SSE **永不 close**（`app.ts:162` 的关闭条件正是这个事件），连接泄漏 | `after` 与当前 `lastSeq` 的差值设上限（超过就要求客户端走 `/items` 分页冷读）；重放总条数/总字节封顶；`queue` 设上限并在超限时断流；按 tenant/session 限连接数；`exclude` 用 `EXCLUDABLE_EVENT_TYPES` 做白名单校验 |
| **H4** | High | `packages/core/src/tools/builtin/index.ts:24-35,55,59` | **`assertPublicHost` 有确定性绕过**。(a) **IPv6 字面量完全跳过 IP 检查 [实测]**：`new URL("http://[::1]/").hostname === "[::1]"`（带方括号），`isIP("[::1]") === 0`，于是走 `lookup("[::1]")`；在有通配 DNS 的网络里这会**解析成功** —— 本机实测返回 `198.18.7.41`，而 `198.18.0.0/15` 不在 `PRIVATE_V4` 里 → 判定"公网通过" → `fetch("http://[::1]/")` 用字面量直连 **localhost**。同理 `http://[::ffff:127.0.0.1]/`（hostname 变成 `[::ffff:7f00:1]`）。(b) **DNS rebinding TOCTOU**：`assertPublicHost` 解析一次、`fetch` 再解析一次，TTL=0 的攻击者域名两次返回不同地址即可绕过 —— 第 34 行的注释 `// DNS-rebinding: every resolved address must be public` 是**错的**，遍历所有 A 记录只防"多记录混合"，不防"重新解析"。(c) 黑名单缺口：`192.0.0.0/24`、`198.18.0.0/15`、`224.0.0.0/4`、`255.255.255.255` 未覆盖 [实测]；IPv6 只挡 `::1`/`fc`/`fd`/`fe80`/`::ffff:` 前缀，漏 `::`、NAT64 `64:ff9b::/96`、非压缩写法 `0:0:0:0:0:ffff:127.0.0.1`（`isIP` 判为 6 但不匹配 `startsWith("::ffff:")`）。(d) 无端口限制。（做对的部分：十进制/八进制/十六进制 IPv4 与 IDN 都由 `new URL` + `getaddrinfo` 归一化成点分四段后被正则挡住 [实测 `0x7f.1`/`2130706433`/`①②⑦.0.0.1` → `127.0.0.1`]；`redirect:"manual"` 不跟随重定向，做对了） | 自己解析：`dns.lookup(all)` → 过滤出唯一一个校验通过的 IP → **用该 IP 建连**（`undici` 的 `lookup`/自定义 `dispatcher`，或 `agent` 固定 IP + `Host` header），彻底消除 TOCTOU；先 `isIP(hostname.replace(/^\[\|\]$/g,""))` 处理方括号字面量；把黑名单换成"公网白名单"（`ipaddr.js` 的 `range()` 只放行 `unicast`/`public`）；端口限 80/443 |
| **H5** | High | `builtin/index.ts:61` | `web_fetch` 先 `await res.text()` **把整个响应体读进内存**，然后才 `.slice(0, 256*1024)`。A5 返回一个 10GB 的 `Content-Length: -` 流 → runner OOM。也没有 `content-type` 限制（会把二进制当文本处理） | 流式读取并在累计字节超限时 `res.body.cancel()`；校验 `content-type` 为 `text/*`/`application/json`/`application/xhtml+xml`；`Content-Length` 超限直接拒 |
| **H6** | High | `packages/protocol/src/provider.ts:52`、`packages/store/src/mysql/store.ts:252-259`、`app.ts:93`、`packages/providers/src/service.ts:69-74` | **明文密钥旁路，把整套 BYOK 加密设计架空**。`headers` 存在 `provider_configs.config` 这个 **JSON 明文列**里，且 `GET /v1/providers` 原样回显（`listVisible` 返回完整 `ProviderConfig`）。很多 OpenAI 兼容网关就是用自定义 header 传 key（`X-Api-Key`、`Api-Key`…），租户照着填 → 密钥明文落库 + 可被任何持租户 key 者读回。对比：`apiKey` 字段走加密且 `ProviderConfig` 里根本没有该字段（`provider.ts:41-43` 的注释"write-only, never returned"只对 `apiKey` 成立）。另外 `upsertProviderConfig` 的 `secret_cipher=COALESCE(VALUES(secret_cipher), secret_cipher)` 意味着不带 `apiKey` 的 PUT 会**保留旧密钥但替换 baseUrl/headers** —— 正是 C4 的便利前提 | `headers` 的值也走 cipher（或直接禁止在 `headers` 里出现形如密钥的值 + 文档引导用 `apiKey`）；`GET /v1/providers` 对 `headers` 的值做掩码；不带 `apiKey` 的 PUT 若同时修改了 `baseUrl`，要求重新提交 `apiKey`（防止"沿用密钥 + 改目标"） |
| **H7** | High | 全仓（`quota` 仅出现在 `presets.ts` 与测试里）、`host.ts:102`（`active` map） | **无限流、无配额、无准入控制**。`ProviderConfig.quota{rpm,concurrency}` 解析了但从不使用；`quota_exceeded`/`limits_exceeded` 两个错误码从未被抛出；`active` Map 无上限，每个活跃 turn 常驻投影后的历史 + 3 个 timer + engine 实例；per-tenant 无并发会话上限、无 RPS 上限。20M DAU 下这是必然的雪崩点，也是最廉价的定向 DoS（A1 用一把 key 打满一个 runner） | 接入层 per-key/per-user 令牌桶；runner 侧 `active.size` 上限 → 超限返回 `503 draining` 让 router 换机；落实 `quota.concurrency`（Redis 计数）；`/metrics` 暴露 `active` 水位 |
| **H8** | High | `host.ts:241`、`app.ts:48,168-169`、`host.ts:617`、`packages/providers/src/service.ts:100` | **错误体泄露内部拓扑与内部错误原文**。(a) `session_lease_conflict` 的 `details` 带 `{ownerId, ownerAddr}` —— `ownerAddr` 就是 `RUNNER_HOST:RUNNER_PORT`（`config.ts:31`），即**内网 host:port 直接回给公网客户端**，等于送一张横向移动地图。(b) `app.ts:168` 的 `new ApiError("internal_error", String(err))` 把**任意内部异常的原文**经 SSE `error` 事件送出（mysql2 的错误会带 SQL 片段与列名；`fetch` 的错误会带目标 URL）。(c) `turn.error.message = result.error`（`host.ts:617`）是 provider 原始错误文本，落库且随 `turn/completed` 下发。(d) `app.ts:48` 的 `console.error(err)` 打印完整 error 对象，在 pi 抛错时可能带上请求体片段 | `details` 只保留客户端可操作的字段（`retryAfterMs`），`ownerId/ownerAddr` 降级为内部日志 + `X-Request-Id` 关联；对外统一 `internal error` + request id，原文只进日志；provider 错误做白名单映射（超时/限流/鉴权失败/其他）；日志走结构化 logger 并对 `sk-`、`Bearer`、`Authorization` 做脱敏 |
| **H9** | High（运维） | `.env`（未被 git 跟踪，但明文落盘） | 仓库根 `.env` 含**真实可用**的 DashScope 平台密钥（`API_KEY=sk-b535…`）。`.gitignore` 挡住了提交，但密钥明文存在于开发机磁盘，且随任何目录打包/备份/截图外泄。README/`.env.example` 也默认引导这种用法 | 立刻轮换该 key；本地改用 macOS keychain / `direnv` + 加密文件；CI/生产走 KMS 或密钥管理服务；加一条 pre-commit 的 secret 扫描 |
| **M1** | Medium | `app.ts:136-146`、`store.ts:298-316` | **幂等键的作用域与时序都有问题**。(a) `reserveIdempotencyKey` 在 `getSession`（app.ts:147）**之前**执行，即未验证会话归属就写库 → 任意 256 字符 key 无限写入、24h TTL、**无清理任务**，纯存储膨胀。(b) key 只按 `tenantId` 作用域，同租户不同用户撞 key（客户端用 `"1"`、递增数字、时间戳都很常见）→ 后者拿到 `idempotency_conflict`「key was used for a different session」，可被用来定向阻塞他人。(c) 若 `startTurn` 抛错，key 已 reserve 但 `value` 仍为 NULL（`completeIdempotencyKey` 不会被调用）→ **同一 key 在 24h 内永远返回 409「still in progress」**，一次失败毒化一个 key | key 作用域改为 `(tenantId, userId, sessionId)`；reserve 移到 `getSession` 之后；`startTurn` 失败时删除预留（或写入失败标记 + 短 TTL）；加过期清理任务 |
| **M2** | Medium | `packages/store/src/blob/fs.ts:9-11` | **前缀检查缺分隔符 → 兄弟目录逃逸 [实测]**。`p.startsWith(normalize(this.root))`：root=`/data/blobs`、key=`../blobs-evil/x` → `normalize` 得 `/data/blobs-evil/x`，`startsWith("/data/blobs")` 为 **true** → 越界读写。目前 `FsBlobStore` 未接线（`main.ts:14` 是 `void new FsBlobStore(...)`，实例被丢弃），所以当前不可达 —— 但 `outputRef`（大输出卸载）一接上就是可达的写路径 | 改为 `path.relative(root, p)` 且断言结果不以 `..` 开头、不是绝对路径；key 再加白名单正则（`^[A-Za-z0-9/_.-]+$` 且不含 `..`）；上云直接换 OSS 实现 |
| **M3** | Medium | `store.ts:142-149,156`、`app.ts:120-124` | **软删除不停机、不释放、不清理**。`deleteSession` 只置 `deleted_at_ms`：不打断正在跑的 turn、不释放租约；`commit` 的 `SELECT ... FOR UPDATE`（store.ts:156）**不看 `deleted_at_ms`** → 已删会话继续写 items/events 并继续调用模型**继续产生费用**，而客户端此时 `getSession` 返回 404，**无法再 interrupt**。另：`items/events/turns/approvals/usage_ledger` 都没有清除路径（设计 §14 #6 已记为缺口），面向消费端的 PIPL 删除请求无法履行 | `deleteSession` 先 `host.interrupt` + 释放租约；`commit` 的 SELECT 加 `deleted_at_ms IS NULL`；补数据生命周期任务（按 session 级联软删 → 硬删） |
| **M4** | Medium | `app.ts:207`、`app.ts:116` | **响应体无上限**。`/items` 的 `limit` 上限 1000，而单个 item 的 `body` 可含 500KB 文本（H2）→ 单响应数百 MB；`GET /sessions` 的 `limit` 上限 200 × 任意大 `metadata` 同理 | 按**字节**而非条数分页（累计到阈值就截断并给 `nextCursor`）；大输出走 `outputRef` |
| **M5** | Medium | `host.ts:261,734-737` | **客户端可控的上下文窗口起点**。`lastCompactionSeq(session)` 读 `session.metadata.lastCompactionSeq`，而 `metadata` 是客户端任意 JSON（同 C3 的根因）。创建 session 时塞一个巨大值 → 每个 turn 的 `listItems(afterSeq=巨大值)` 返回空 → 模型完全看不到历史（可用于绕过"之前已确立的约束/拒绝"，是一种上下文篡改）。自查文档 B4 已注意到"该字段无写入方"，但漏了"客户端能写" | 同 C3：移出 `metadata`，放独立列，只由压缩流程写 |
| **M6** | Medium | `builtin/index.ts:40,43-44`、`host.ts:478-479,485`、`dynamic.ts:11-13` | **prompt 注入面无任何标记或隔离**（设计 §7.2 自写清单里的"第三方 tool description 注入标记"未实现）。(a) `web_fetch` 正文（最多 64KB 任意攻击者文本）原样进上下文；(b) `web_fetch` 是 `readOnly:true`，于是连 `untrusted` 策略也自动放行（`policy === "untrusted" ? !tool.readOnly : ...`）—— 即"取任意公网内容"这个动作在最严策略下也无人工确认；(c) 动态工具的 `description`（客户端 4000 字符）进系统工具声明，是租户侧注入位；(d) 审批 `reason: msg.text` 由**模型**生成并展示给人类审批者 → A4 可以撰写高说服力的审批理由来骗过人 | 工具结果与第三方文本用固定分隔符包裹并标注 `<untrusted_content source="web_fetch" url="...">`；审批 UI 明确区分"模型自述理由"与"系统事实"（工具名 + 参数），并在协议上把 `reason` 标记为不可信；`web_fetch` 在 `untrusted` 下也要求审批（或至少域名白名单） |
| **M7** | Medium | `dynamic.ts:11-18` | **动态工具永远无法被要求审批**。`asTool` 硬编码 `needsApproval:false, readOnly:false`，`DynamicToolDeclaration` 也没有声明敏感性的字段。于是 `on-request` 策略下客户端工具（可能是"转账""发消息"）零审批直通；只有 `untrusted` 策略下才因 `!readOnly` 命中审批 | `DynamicToolDeclaration` 增加 `needsApproval?: boolean` / `readOnly?: boolean`，由客户端声明并透传 |
| **M8** | Medium | `app.ts:67-90` | **租户内无角色区分**：任何持 key 的调用方（含被冒充的任意端用户）都能 `POST /v1/agents` 创建 `approvalPolicy:"never"` + 全量工具 + 200KB `instructions` 的 agent，或 `PUT` 给现有 agent 出新版本（现存 session 因 pin 了 `agentId@version` 不受影响，但所有新建 session 会用上新版本）。与 C1/C2 同根，但独立放大 | 管理面（agents/providers/keys）与运行面（sessions/turns）用不同的 key 类型或 scope 字段区分 |
| **M9** | Medium | `packages/protocol/src/item.ts:7`、`packages/core/src/engine/pi.ts:161` | **图片 URL 未做 scheme/host 校验**：`z.string().url()` 接受 `file:///etc/passwd`、`http://127.0.0.1/`、`gopher://`，被原样放进 pi 的 `{type:"image", data: p.url}`。取决于 pi-ai 是自己代取该 URL 还是透传给厂商 —— 前者是 SSRF/本地文件读取，后者是把内网地址交给第三方。两种都需要处理，且当前无人校验 | 复用加固后的出站校验：只接受 `https:` 公网地址或自家对象存储的 `oss://` ref（设计 §5.3 的示例正是 `oss://`）；确认 pi-ai 的行为并加回归测试 |
| **M10** | Medium | `packages/providers/src/secrets.ts:21-26` | **AES-GCM 无 AAD，密文与身份不绑定**。密文 = `iv‖tag‖ct`，不含 `tenantId`/`providerId`/`keyId` 任何绑定。`provider_configs` 的主键是 `(tenant_id, provider_id)`，密文只是一个可搬动的 BLOB。**证明路径**：任何能写该表的路径（备份还原、运维脚本、将来的注入、误操作的数据迁移）把 A 租户的 `secret_cipher` 复制进 B 租户的行 → B 按 C4 把 `baseUrl` 指向自己的服务器 → runner 用 A 的明文密钥向 B 的端点发 `Authorization: Bearer <A 的 key>` → **A 的密钥被导出**。GCM 的完整性校验挡不住这种"整体搬运"，因为它只保证"这段密文没被改过"，不保证"它属于这一行" | `encrypt/decrypt` 增加 `aad`，绑定 `tenantId|providerId|keyId`（换 KMS 后用 `EncryptionContext`）；`decrypt` 失败即告警（密文搬运的检测信号） |
| **M11** | Medium | 全仓（唯一的行为人记录是 `host.ts:545` 的 `decidedBy`） | **无审计日志**：谁（哪把 key、哪个自述 userId、哪个 IP）在什么时候对哪个 session/provider 做了什么，全都没有落库。多租户对外服务的事故定责、入侵溯源、合规审计都缺基础数据；C1/C2 类越权事后完全无法证明 | 独立 append-only 审计表/日志流：`(ts, keyId, tenantId, userId, ip, method, path, resourceId, result)`；provider/agent/key 的写操作与审批决策必须落审计 |
| **M12** | Medium | `auth.ts:25`（`Principal` 未 parse） | `X-User-Id` 只判长度，未按 `externalId` 校验，可含 CRLF、控制字符、全角/同形字符。后果：日志伪造（注入换行构造假日志行）、用户 ID 同形混淆（`useг` vs `user`）、以及后续任何把 userId 拼进 key/路径的代码都要重新审计 | `authMiddleware` 里 `Principal.parse({...})`，`externalId` 加正则（如 `^[A-Za-z0-9_.:-]{1,128}$`） |
| **L1** | Low | `auth.ts:6` | `hashApiKey` = **未加盐 SHA-256**。对 `generateApiKey()` 产出的 192-bit 随机串**是可接受的**：攻击者拿到 hash 库也没有可枚举的原文空间，而加盐会破坏"一次主键等值查找"的 O(1) 性质。**时序攻击同理不成立**：比较发生在 MySQL 的索引等值查找里，不存在逐字节 early-exit 的侧信道，且即使存在，泄露的是 hash 而非原文。**但两个前提必须补上**：(a) 入库处强制 key 格式与熵（否则像 `dev-key` 这种低熵 key 一张彩虹表即破，见 C5）；(b) 建议改 `HMAC-SHA256(server_pepper, key)`，让 DB 单独泄露时无法离线校验 | 见 C5 的 key 签发接口；`resolveApiKey` 前先做格式校验（`^ask_[A-Za-z0-9_-]{32}$`），不匹配直接 401，顺带省掉一次 DB 查询 |
| **L2** | Low | `auth.ts:20`、`store.ts:280-283` | `resolveApiKey` **无缓存**：每个请求一次主键查询。20M DAU 下这是单行热点（同一把 key 的所有请求打同一行），MySQL 连接池（`connectionLimit: 20`）会先于业务成为瓶颈。反面是：无缓存 = 吊销即时生效。**这是性能与安全的真实 trade-off，需要显式决策** | 加 30–60s TTL 的 principal 级缓存 + Redis pub/sub 吊销广播；把"吊销延迟 ≤ TTL"写进威胁模型与 SLA；紧急吊销走广播而非等 TTL |
| **L3** | Low（已足够） | `store.ts` 全部查询 | **SQL 注入：逐条核对后未发现**。所有值都走 `?` 占位符；动态拼接部分拼的都是**固定字面量**：`listSessions` 的 `where.join(" AND ")`（元素均为常量串，store.ts:129-136）、`listItems` 同（226-232）、`listAgents` 的 `opts.cursor ? "AND a.agent_id < ?" : ""`（101）、`listTurns` 的 `desc ? "<" : ">"`（来自 zod enum，218-220）、`listApprovals` 的 `AND status='pending'`（241）、`commit` 的 `sets.join(", ")`（182-194）。`LIMIT ?` 由 mysql2 按数字转义，且 `limit` 都经 `z.coerce.number()`。迁移执行器按 `;\n` 切分（70）只作用于仓内文件 | 无需修改。建议加一条"SQL 拼接只能拼常量"的 lint/review 约定，并把 `where` 数组的类型收紧为字面量联合 |
| **L4** | Low（隐式不变量） | `packages/store/src/redis/lease.ts:42-44`、`redis/bus.ts:39-44` | **Redis key 注入当前不可达，但靠的是隐式不变量**。`k(sid)` / `ch(sid)` 直接把 `sessionId` 拼进 `{...}` hash tag；路由层的 `:id` **从未做格式校验**。当前安全的唯一原因是：所有调用点都在 `getSession` 之后，而能查到的 id 必然来自 `newId("sess")`。一旦将来有任何路径在查库前用 `sessionId` 拼 Redis key（比如"先看租约再查库"的路由优化），含 `}`/`{`/`:` 的 id 就能破坏 Cluster 槽位或串到别的 key | 在路由层用 `idSchema("sess")`/`idSchema("turn")`/`idSchema("apr")` 校验路径参数，把不变量显式化（顺带让不存在的 id 更早返回 400/404） |
| **L5** | Low（可接受） | `service.ts:60`、`provider.ts:51` | `apiKeyRef = "secret:<tenantId>:<providerId>"` 经 `GET /v1/providers` 回显 —— 只泄露调用方**自己的** tenantId（本来就知道），不构成风险。但与设计 §7.4 的 `kms://tenant/xxx/keys/1` 形状不一致，换 KMS 时是个迁移点 | 统一成不含语义的 opaque ref（如 `sec_<uuid>`），避免将来"ref 里带租户信息"被当成可信输入 |
| **L6** | Low（需分级） | `store.ts:290-295`（`usage_ledger`）、`events`/`items` 表 | `usage_ledger` **不含任何密钥材料**（仅 tenant/user/session/turn/step/provider/model/usage），这条是干净的。但 `events.body` / `items.body` 存的是**全量** item 快照，包含用户原文、模型推理文本（`reasoning`）、工具参数与工具结果（可能含第三方返回的敏感数据）。这些表当前无加密、无字段级脱敏、无保留期 | 做数据分级并写进设计文档：`events/items` 归为"高敏"，静态加密 + 保留期 + 访问审计；`reasoning` 考虑单独开关（部分厂商禁止持久化） |
| **L7** | Low（做对了） | `builtin/index.ts:59-60` | `redirect:"manual"` + 不跟随，只把 `Location` 回给模型 —— 关掉了"校验第一跳、跟随到内网"这条经典 SSRF 路径。**保持现状**，将来若要支持重定向，必须对每一跳重新跑 `assertPublicHost` | 无需修改；加注释说明这是有意为之，防止后人"顺手"改成 `follow` |
| **L8** | Low | `config.ts:5`、`main.ts:38` | `RUNNER_HOST` 默认 `127.0.0.1` 是**好的安全默认**。但 runner 对 router 没有 mTLS、没有 IP 白名单、不校验 `X-Forwarded-For` —— 一旦部署时写成 `0.0.0.0` 且安全组放开，上面所有发现全部直面公网，且 `X-User-Id` 这种"信任上游"的设计就彻底失效 | runner 只监听内网/Unix socket；router→runner 走 mTLS 或共享的内部凭证；部署清单里加一条"runner 端口不得出现在公网 LB 后面"的检查 |

---

## 3. 路由逐条授权审计

`requireUser` 只检查 `principal.userId` **非空**（`auth.ts:31-33`），从不比对资源归属。"租户内跨用户"列即 C1 的可达面。

| 路由 | 鉴权 | requireUser | 实际授权检查 | 租户内跨用户？ |
|---|---|---|---|---|
| `GET /healthz` `/readyz` | 无 | — | — | —（可接受） |
| `GET /v1/capabilities` | **无** | — | — | —（泄露特性开关，可接受） |
| `POST /v1/agents` | key | ✗ | tenant | **是**（任何用户可建 `approvalPolicy:"never"` agent，M8） |
| `GET /v1/agents` `GET/PUT /v1/agents/:id` | key | ✗ | tenant | **是**（读/改版全租户 agent） |
| `GET /v1/providers` | key | ✗ | tenant | **是**（读全租户 BYOK 配置含 `headers` 明文，H6） |
| `PUT /v1/providers/:id` | key | ✗ | tenant | **是 → 最危险**（改 `baseUrl` 劫持全租户出站流量，C4） |
| `DELETE /v1/providers/:id` | key | ✗ | tenant | **是**（删掉全租户 provider = 全租户不可用） |
| `GET /v1/models` `/v1/tools` | key | ✗ | tenant / 无 | 否 |
| `POST /v1/sessions` | key | ✓ | tenant | **是**（`req.userId` 可覆盖为任意用户，C2） |
| `GET /v1/sessions` | key | ✗ | tenant + **可选** userId | **是 → 枚举入口**（不带 `X-User-Id` 即全租户列表，C1） |
| `GET /v1/sessions/:id` | key | ✗ | `getSession`（tenant） | **是**（读他人会话元数据/usage/metadata） |
| `DELETE /v1/sessions/:id` | key | ✗ | tenant | **是**（删他人会话） |
| `POST /v1/sessions/:id/resume` | key | ✗ | `getSession` | **是**（他人快照 + 近 20 轮 + 未决审批 id） |
| `POST /v1/sessions/:id/turns` | key | ✓ | `getSession` | **是**（以他人身份发言并记账到他人名下） |
| `GET /v1/sessions/:id/turns` `/turns/:turnId` | key | ✗ | `getSession` | **是** |
| `POST .../turns/:turnId/interrupt` | key | ✗ | `getSession` | **是**（打断他人进行中的 turn） |
| `POST .../turns/:turnId/steer` | key | ✓ | `getSession` | **是**（向他人正在跑的 turn 注入消息） |
| `POST .../turns/:turnId/tool-results` | key | ✗ | `getSession`，**不校验 turnId/toolCallId 归属** | **是**，且可**跨租户**（H1） |
| `GET /v1/sessions/:id/items` | key | ✗ | `getSession` | **是 → 全量对话内容** |
| `GET /v1/sessions/:id/events` | key | ✗ | `getSession` | **是 → 全量历史重放**（且是 DoS 放大器，H3） |
| `GET /v1/sessions/:id/approvals` | key | ✗ | `getSession` | **是** |
| `POST .../approvals/:approvalId` | key | ✓ | `getSession` + session 内 pending 表 | **是 → 代他人批准危险工具** |

另一处时序问题：`POST .../turns` 的幂等分支（`app.ts:136-146`）在 `getSession`（147 行）**之前**就调用了 `reserveIdempotencyKey` 和 `getTurn(sessionId, ...)`。`getTurn` 按 `(turn_id, session_id)` 过滤，加上幂等键是 tenant 作用域，所以跨租户读不到东西；但"鉴权在副作用之后"这个模式本身要纠正（M1）。

`store` 层的 `readEvents` / `getTurn` / `listTurns` / `listItems` / `getItem` / `listApprovals` / `getApproval` **全部只按 `sessionId` 过滤，不带 `tenant_id`**（对应表里也没有 `tenant_id` 列）。当前跨租户是安全的，因为每条路由都先过 `getSession` 做租户校验 —— 但这是**约定而非机制**：任何新增路由忘了这一步，就是直接的跨租户读。建议给这些表加 `tenant_id` 列并进查询条件（`items`/`events` 已有 `user_id` 列，加 `tenant_id` 的成本很低），把租户隔离从"调用方纪律"变成"存储层不变量"。

---

## 4. 一期必修

按"不修就不能对外开放任何一个真实租户"来划。

1. **C1 + C2 —— 用户级授权**。这是根因，其他会话类问题都是它的推论。最小修法：`store.getSession/listSessions/deleteSession` 签名加 `userId`，`host.getSession` 断言归属，`GET /v1/sessions` 强制 `requireUser` 并忽略客户端 `?userId`。同时把"`X-User-Id` 是租户自述、service key 绝不可下发端侧"写进 README 与 SLA（JWT 方案排到上云前）。
2. **C3 —— 审批状态搬出 `metadata`**，并给 `metadata` 加保留键黑名单 + 大小上限。顺带修 `new Set(非数组)` 的 500。
3. **C4 —— BYOK 出站收口**。注入统一的 `fetch`（IP 校验 + `https` + 端口白名单 + 超时 + header 白名单），并把 provider 写操作从端用户可达面上摘掉。
4. **C5 + C6 —— 生产禁止默认值**。`BOOTSTRAP_API_KEY`/`SECRETS_MASTER_KEY` 在 `NODE_ENV=production` 下必填；引导逻辑加显式开关；`LocalAesGcmCipher` 拒绝全零密钥。
5. **H1 —— 动态工具桥接按 `(sessionId, toolCallId)` 索引**，路由校验 `turnId` 归属。改动极小，但这是当前唯一的**跨租户**注入面。
6. **H2 —— `bodyLimit` + `input.max()`**。一行中间件 + 一个 schema 约束换掉一个必然的 OOM。
7. **H4 + H5 —— `assertPublicHost` 重写 + `web_fetch` 流式限长**。方括号 IPv6 字面量这条是确定性绕过，已实测。
8. **H6 —— `headers` 不得明文回显/明文入库**。否则 BYOK 的加密设计名存实亡。
9. **H8(b)(c) —— 对外错误统一化**。`String(err)` 与 provider 原文不能直接出网；`ownerAddr` 不能出网。
10. **H9 —— 轮换 `.env` 里的真实平台密钥**（立刻，与代码改动无关）。
11. **M12 —— `Principal.parse`**，`externalId` 加正则。一行。

## 5. 上云前必修

面向"多副本 + 真实流量 + 20M DAU"。

1. **H3 —— SSE 重放与连接治理**：`after` 跨度上限、重放字节上限、`queue` 背压、per-tenant 连接配额、`exclude` 白名单校验。
2. **H7 —— 限流与准入**：接入层令牌桶；runner `active.size` 上限 → `503`；落实 `ProviderConfig.quota`（Redis 计数）；把 `quota_exceeded` 真正用起来。
3. **C6 的后续 —— 换 KMS 信封加密**（设计 §7.4），配合 **M10** 的 AAD/`EncryptionContext` 与密钥轮换。
4. **C2 的后续 —— 端用户 JWT**：租户配置公钥，`sub → userId`；key 上加 `kind: server | client` 区分可否使用 `X-User-Id`。
5. **M8 —— 管理面/运行面凭证分离**（agents、providers、keys 归管理面）。
6. **M11 —— 审计日志**（append-only，含 keyId/自述 userId/IP/资源/结果）。这是事故定责的前提，越晚补越难回填。
7. **M3 —— 删除语义与数据生命周期**：删除即打断 + 释放租约 + `commit` 过滤已删；items/events/turns 的保留期与硬删任务（PIPL）。
8. **M1 —— 幂等键作用域收窄 + 失败清理 + 过期任务**。
9. **M4 —— 按字节分页**；大输出走 `outputRef`（这也让 **M2** 的 `FsBlobStore` 变成可达路径，必须同时修好前缀检查）。
10. **M6 + M7 —— prompt 注入标记与动态工具审批位**。MCP 一上线（设计 §7.2）注入面会放大一个数量级，机制要先就位。
11. **M9 —— 图片 URL 校验**（同时确认 pi-ai 是否代取）。
12. **L2 —— `resolveApiKey` 缓存 + 吊销广播**，并把吊销延迟写进 SLA。
13. **L8 —— runner 不可公网可达 + router→runner mTLS**。
14. **L4 —— 路径参数 id 格式校验**，把 Redis key 的隐式不变量显式化。
15. **L6 —— 数据分级**写进设计文档（`events/items` 高敏、静态加密、`reasoning` 可关）。

## 6. 已足够 / 接受的风险

| 项 | 理由 |
|---|---|
| **`hashApiKey` 用未加盐 SHA-256** | 对 192-bit 随机 key 是恰当选择：无可枚举原文空间，彩虹表无意义；加盐会破坏单次主键等值查找。**前提**是入库处强制 key 格式与熵（C5/L1）。建议但不强制升级为 `HMAC(pepper, key)`，收益是"DB 单独泄露时无法离线校验"。 |
| **API key 比较的时序攻击** | 不成立。比较发生在 MySQL 索引等值查找内部，不是应用层逐字节 `==`；且被比较的是 SHA-256 输出，即使有完美时序 oracle 也只能恢复 hash，无法反推 key。不需要 `timingSafeEqual`。 |
| **SQL 注入** | 逐条核对 `mysql/store.ts` 全部 18 处查询：值全部走占位符，动态拼接只拼常量（含 `where.join`、`LIMIT ?`、`desc ? "<" : ">"`）。**未发现可注入点**，无需改动（L3）。 |
| **Redis key 注入 / Cluster 槽位破坏** | 当前不可达：所有 `k(sid)`/`ch(sid)` 调用点都在 `getSession` 之后，id 必然来自 `newId("sess")`。作为**隐式不变量**接受，但列入上云前的显式校验（L4）。 |
| **`web_fetch` 不跟随重定向** | 做对了，关掉了经典的"首跳合法、跟随入内网"路径。保持现状（L7）。 |
| **十进制/八进制/十六进制 IP、IDN 域名绕过** | 已被 `new URL` + `getaddrinfo` 的归一化挡住（实测 `0x7f.1`、`2130706433`、`127.1`、`①②⑦.0.0.1` 全部变成 `127.0.0.1` 并命中黑名单）。真正的缺口是方括号 IPv6 字面量与 rebinding（H4），不是这些编码。 |
| **阿里云元数据 `100.100.100.200`** | 已被 `/^100\.(6[4-9]\|[7-9]\d\|1[01]\d\|12[0-7])\./` 覆盖（`1[01]\d` 命中 `100`）[实测]。`169.254.169.254` 同样被覆盖。注意这只对 `web_fetch` 成立，BYOK 路径没有任何校验（C4）。 |
| **`usage_ledger` 泄露密钥** | 不存在：只写 tenant/user/session/turn/step/provider/model/usage。 |
| **`apiKeyRef` 泄露 tenantId** | 只泄露调用方自己的 tenantId，接受（L5）。 |
| **fence 机制（`commit` 用 `SELECT ... FOR UPDATE` + `fence < currentFence` 判断，而非设计文档写的 `WHERE fence_token=?`）** | 语义等价且更严（事务内取锁后比较），非安全问题。 |
| **`RUNNER_HOST` 默认 `127.0.0.1`** | 好的安全默认，保持。 |
| **租户把自己的额度用光 / 租户对自己的数据作恶** | 本期不防，写进 SLA（§1.4）。 |
| **模型输出的内容安全** | 设计 §13 #6 已决策"一期只留 middleware 插槽"，本 review 不重复。 |
| **无沙箱的工具执行** | 设计 §0 明确一期无 shell/fs 工具，现有两个内置工具（`current_time`、`web_fetch`）不触达本地资源。前提是**新增内置工具必须重新评审**，MCP/重池上线时这条假设失效。 |
