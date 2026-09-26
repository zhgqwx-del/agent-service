# 鉴权子系统安全专项 review（07，2026-09-26）

范围：`docs/design/01-identity-and-auth.md` 刚落地的身份与鉴权子系统 ——
`apps/agent-runner/src/{auth.ts,end-user-auth.ts,auth-policy.ts,app.ts}`、`packages/protocol/src/auth.ts`、
`packages/store/src/{types.ts,memory.ts,mysql/store.ts}` 的租户/密钥部分、`packages/providers/src/secrets.ts`。
前置：`docs/review/03-security.md`（C1/C2 正是本子系统要解决的问题）。

方法：逐行读 + 在本机跑可执行 PoC（临时 vitest 用例，已删除）。标 **[实测]** 的都附真实响应码。

> **关于时序**：本次 review 进行期间，代码正在被并行修复。下面 §1 是**针对当前磁盘上代码**复现出来的、仍然成立的问题；
> §2 记录本轮已经闭合的问题（附对应回归用例），因为「哪些洞是被哪条测试钉住的」本身是要留档的信息。
> 所有 §1 的条目我都在**修复后的代码**上重跑过 PoC，不是旧结论的残留。

---

## 0. 结论

修复后的形态基本正确：`requireUser` 覆盖到了绝大多数会话路由、`admin`/`runtime` scope 把「改身份根」和「跑会话」分开了、
`validateAuthPolicy` 把 SSRF / 算法混淆 / 缺 issuer+audience / hs256 无密钥挡在了写入侧。**但还有三处让「持 service key」重新等价于「看全租户用户数据」或「伪造任意用户」的路径**：

1. **三条路由漏掉了 `requireUser`** —— `GET /v1/sessions`、`GET /v1/usage`、`GET /v1/sessions/:id/events`。**[实测]** 在 `end_user_token` 模式下只带 service key（不带任何 token）：列出其他用户的会话 200、打开别人会话的 SSE 全量历史流 200。新写的 `auth-hardening.test.ts` 逐条检查了 `/sessions/:id`、`items`、`turns`、`approvals`、`DELETE`、`resume`、`compact`，**恰好漏掉这三条**。
2. **旧 secret 仍能跨 verifier 复活成签名密钥** —— 当上一个 verifier **用过**这个 secret（`useStoredSecret:true`）时，`validateAuthPolicy` 的 `!secret && !hasStoredSecret` 判断放行，`app.ts` 保留旧密文。**[实测]** 用那个「本来要发给外部校验服务、外部运维可见」的凭据签的 `{"sub":"u_victim"}` → **201**。
3. **`useStoredSecret` 在请求时仍然不被读取** —— `end-user-auth.ts:96` 只看 `this.secret` 是否存在。**[实测]** `useStoredSecret:false` 且本次 PUT 带了 secret → 该凭据照样以 `Authorization: Bearer` 发给 introspection 端点。

另外有一条**部署期**问题：`0005_api_key_scopes.sql` 把 `scopes` 加成 `JSON NULL`，`resolveApiKey` 把 NULL 读成 `["runtime"]`，
而生产环境已禁止 `BOOTSTRAP_API_KEY`（`config.ts:36-38`），且全仓**没有任何签发 admin key 的路径**
→ 迁移一跑，存量租户全部失去配置鉴权策略的能力，新环境则根本拿不到第一把 admin key。

---

## 1. 当前仍然成立的发现

严重度：**Critical** = 可直接跨用户读写或伪造身份；**High** = 需一个可满足前置条件，或服务级不可用；**Medium** = 需组合或影响有限；**Low** = 加固项。

| # | 严重度 | 位置 | 攻击场景 | 修复 |
|---|---|---|---|---|
| **B1** | **Critical** | `app.ts:166-171`（`GET /v1/sessions`）、`app.ts:287-292`（`GET /v1/usage`）、`app.ts:300-307`（`GET /v1/sessions/:id/events`，第 301 行用的是裸 `c.get("principal")` 而非 `requireUser(c)`） | **三条路由仍把「无用户身份」当成租户级**。`host.getSession` 的归属判断是 `if (principal.userId && ...)`（`host.ts:191`），空 userId 整体短路；这三条路由不调 `requireUser`，于是 `end_user_token` 模式下**只带 service key**（该模式的前提正是 key 可以更靠边缘）即可：**[实测]** `GET /v1/sessions` → **200**，返回 `userId: u_victim` 的会话（列表本身含 `title`/`metadata`/`usage`，是精准枚举入口）；`GET /v1/sessions/{别人的}/events?after=0` → **200 `text/event-stream`**，把该会话**全量历史事件**（用户原文、模型输出、工具参数与结果）推给攻击者 —— 这是比读 `/items` 更彻底的一条泄露路径；`GET /v1/usage?groupBy=user` → **200**，一次拿到该租户全部 userId 与用量。`trusted_caller` 模式下同理：不带（或带空白）`X-User-Id` 即全租户 | 三条路由都改成 `requireUser(c)` 并忽略客户端 `?userId`（`GET /v1/sessions` 的 `caller && q.userId` 判断在 caller 为空时形同不存在）；确有租户级只读需求的（后台列表、用量报表）收敛到 `/v1/admin/*` 并要求 `admin` scope。**顺带把 `auth-hardening.test.ts:108` 的循环补上这三条**，它现在恰好绕过了它们 |
| **B2** | **Critical** | `auth-policy.ts:51`；`app.ts:153`；`mysql/store.ts:341-350`、`memory.ts:182-190` | **旧 secret 仍会跨 verifier 复活成 HS256 签名密钥**。`app.ts:153` 的 `needsSecret(input.policy) ? undefined : null` 只在「新策略不需要 secret」时清除；而 `auth-policy.ts:51` 的 `v.hs256 && !secret && !hasStoredSecret` 在**库里已有 secret** 时放行。于是只要上一个 verifier 用过 secret，切换就不会要求重新提交。**[实测]** ①`PUT` introspection + `useStoredSecret:true` + 凭据 `introspection-credential-abc-123456` → 200；②`PUT {kind:"jwt",hs256:true,algorithms:["HS256"]}` **不带 secret** → **200**；③用那个 introspection 凭据当 HMAC 密钥签 `{"sub":"u_victim"}` → **201，userId=u_victim**。危害的实质是**密钥用途升格**：一个「按设计要发给外部校验服务、对方运维可见、可能出现在对方日志里」的 bearer 凭据，摇身变成能为该租户任意用户签发身份的密钥。`auth-hardening.test.ts:223` 覆盖的是「中间经过一个不需要 secret 的 verifier」那条路径（那条已修好），本条是它的补集 | secret 与用途**绑定存储**（加 `auth_secret_purpose` 列，或 hs256 与 introspection 分列）；切换 verifier 种类时旧 secret 一律作废；`hs256:true` 若本次未提交 secret，只有当**库里那条 secret 也是 hs256 用途**时才允许沿用。回归用例：把 §1 的三步序列加进 `auth-hardening.test.ts`，断言第②步 400 |
| **B3** | Medium | `end-user-auth.ts:96`；`protocol/auth.ts:40`；`auth.ts:98-102` | **`useStoredSecret` 在请求时依然是死配置**。`verify()` 只判 `if (this.secret)`；`auth.ts:100` 只要 `record.authSecret` 存在就解密并注入。**[实测]** `useStoredSecret:false` 且同一个 PUT 里带了 `secret` → introspection 端点收到 `Authorization: Bearer a-credential-not-meant-to-be-sent`。（`auth-policy.ts` 现在会在「新策略不需要 secret 且本次没带」时清库，所以只剩这一条进入路径 —— 但它正是「我明确说了别发」的那一格，语义反了。）配合 B4/外部端点变更，这就是把租户凭据发给不该收到它的一方 | `IntrospectionEndUserVerifier` 只在 `cfg.useStoredSecret` 为真时设置 `authorization`；或在 `buildVerifier` 里按 `useStoredSecret` 决定是否把 secret 传进去（后者更好：verifier 拿不到它就不可能发出去） |
| **B4** | High | `auth-policy.ts:18`；`end-user-auth.ts:33` | **JWKS 允许明文 `http://`**。`assertPublicUrlDefault` 只校验「是 http(s) 且解析到公网」，**不强制 TLS**。**[实测]** `jwksUri: "http://1.1.1.1/jwks.json"` 通过真实 guard → **200** 写入。JWKS 是这条链路的**信任根**：任何在 runner→IdP 路径上的攻击者（出口网关、被投毒的 DNS/ARP、云厂商网络内的中间人）返回自己的 key set，即可为该租户**任意用户**签发被接受的 token，而且 token 会被标记为 `userVerified=true`。introspection `endpoint` 同理（明文发送用户 token + 租户凭据） | `assertPublicUrlDefault` 对 verifier 端点强制 `u.protocol === "https:"`（BYOK baseUrl 可以更宽松，因为它不承载身份判定，这里不行）；JWKS 响应加大小上限；可选支持 key set 指纹 pin |
| **B5** | High（部署） | `packages/store/migrations/0005_api_key_scopes.sql`；`mysql/store.ts:317-321`；`config.ts:36-38`；`main.ts:16-18`；`auth.ts:8`（`generateApiKey` 仍无调用者） | **迁移之后没有任何 admin key，也没有办法造一把**。`scopes JSON NULL` + `r.scopes == null ? DEFAULT_SCOPES(["runtime"])` → 所有存量 key 变成 runtime-only，`PUT /v1/tenant/auth`、`PUT/DELETE /v1/providers/:id`、`POST/PUT /v1/agents` 全部 403；而生产禁止 `BOOTSTRAP_API_KEY`，`createApiKey` 只在 `main.ts:16` 被调用一次，也没有签发/轮换/**吊销** API。结果：(a) 存量租户被静默降级成「无法再配置鉴权策略」（包括无法从 `trusted_caller` 切到 `end_user_token`，即无法采用这次做的整套能力）；(b) 新生产环境拿不到第一把 admin key；(c) 一把泄露的 key 依然**无法吊销**，只能改库 | 迁移里显式回填（例如把现有 key 标成 `["runtime","admin"]` 并在发布说明里要求租户换发一对 key，或至少给指定的 bootstrap key 回填 admin）；补 key 的签发/轮换/吊销接口（走 admin scope，`generateApiKey` 终于有调用者）；`resolveApiKey` 的 NULL→runtime 降级要在发布说明里写明 |
| **B6** | Medium | `app.ts:101-110`（`GET /v1/agents`、`GET /v1/agents/:id` 无 `requireAdmin`）、`app.ts:122`（`GET /v1/providers`） | **`end_user_token` 模式把「读租户配置」暴露到了端侧**。写操作已收到 admin scope 之下，但**读**没有：一把 runtime key（按设计可以放进 App）即可 `GET /v1/agents/:id` 拿到 `instructions` 全文。**[实测]** 200 且响应包含 agent 的完整 system prompt。对消费类产品，system prompt 是核心资产（也常含内部规则、白名单、话术边界，是 prompt 注入的最佳侦察材料）；`GET /v1/providers` 泄露 `baseUrl` 与 header 名（值已被 `redactProviderConfig` 掩码，这部分是对的） | `GET /v1/agents/:id` 对 runtime key 只返回运行所需的最小字段（id/name/version/model/tools），`instructions` 只给 admin；或整体归入 admin scope，端侧只按 `agentId` 引用 |
| **B7** | Medium | `auth.ts:48,64`（`entries` 只增不减）、`auth.ts:54`（`verifiers`）、`end-user-auth.ts:78,90,139-140`、`:147-148` | **缓存仍无界，且 introspection 仍以明文 token 为键**。(a) `TenantPolicyCache.entries` 从不清理过期项、无容量上限 → 随租户数单调增长，每个 entry 还连着一个 verifier；(b) 正向缓存上限 10 000 条、键是**原始 token 字符串**，淘汰是 `[...keys()].slice(0, 5_000)` 即**按插入顺序删一半（FIFO 而非 LRU）**，热 token 被误删会立刻打回上游；负向缓存同构；(c) 明文 token 常驻堆最长 `cacheTtlMs`（上限 600s），任何 heap dump / core dump / OOM dump 都会连带一批**可直接使用的用户凭据**一起泄露 | 两层都换有界 LRU + 惰性过期；缓存键改 `sha256(token)`（值里不留 token）；`cacheTtlMs` 默认从 60s 降到 30s 量级并写进 SLA（吊销延迟 = 该值） |
| **B8** | Medium | `app.ts:148-158`；`mysql/store.ts:341-350` | **策略变更零审计**。`setTenantAuth` 只覆盖 `auth_policy`：不记录哪把 key、哪个 IP、何时改的、旧值是什么，也不发事件/告警。而这条路由现在是整个身份体系的开关（模式降级、verifier 端点、secret 轮换都走它）。B2 那条升级链路执行完，**在数据层面无法证明发生过**。03 的 M11 记了「无审计」，策略变更是其中必须先落的一格 | `tenant_auth_audit` append-only：`(ts, tenantId, keyId, ip, oldPolicy, newPolicy, secretChanged)`；`end_user_token → trusted_caller` 的降级与 `jwksUri`/`endpoint` 变更额外打告警；`GET /v1/tenant/auth` 回 `updatedAtMs` + `updatedByKeyId` 供租户自查 |
| **B9** | Medium | `auth.ts:55,64,79-81`；`app.ts:156` | **策略失效仍然只在本 runner**，跨 runner 靠 10s TTL 收敛，且没有租户停用开关。最坏情况分三种：**收紧**（`trusted_caller → end_user_token`）→ 窗口内其他 runner 仍接受 `X-User-Id` 冒充；**端点纠正**（发现 `jwksUri` 被指错/被攻击后改回）→ 窗口内其他 runner 仍用旧 key set 验签，即**继续接受攻击者签发的 token**；**租户停用** → 没有 `disabled_at_ms` 字段可言，只能吊销 key（而 B5 说了没有吊销接口）。另外 `cache.get` 没有 in-flight 去重，冷启动/过期瞬间的并发请求会各建一个 verifier（并发 JWKS 抓取 + 并发 secret 解密） | 策略变更走 Redis pub/sub 广播失效，TTL 只作兜底；`tenants` 加 `disabled_at_ms` 并在 middleware 检查；`get()` 加 in-flight promise 去重；把「策略收敛延迟 ≤ TTL」写进 SLA |
| **B10** | Low | `protocol/auth.ts:21`（`algorithms` 无 `.min(1)`）；`auth-policy.ts:43-57` | **`algorithms: []` 配 `jwksUri` 会被接受**（**[实测]** 200），随后 jose 对任何 alg 都不匹配 → 该租户所有 token 被拒。fail closed 方向是对的，但这是一次「写入合法、运行全挂」的自伤，而且报错信息落在每个请求上而不是写入时 | `algorithms` 加 `.min(1)`；`jwksUri` 分支再断言至少有一个非对称算法 |
| **B11** | Low | `protocol/auth.ts:26` | `clockToleranceSec` 上限 300s → 租户可让已过期 token 再多活 5 分钟。有界，但对「吊销/登出后多久真的失效」这个问题是纯负担，没有正当用例需要 5 分钟 | 上限收到 60 |
| **B12** | Low | `auth.ts:11` | `sameDigest`（恒定时间比较）**全仓无调用者**。03 的结论是这里不需要它（比较发生在 store 的等值查找里，且比较对象是 SHA-256 输出），我同意；问题是留着这个导出 + 那句注释会让后来者误以为链路上有恒定时间保护 | 删掉，或把 03 的论证写成注释挂在 `hashApiKey` 上 |

---

## 2. 本轮已闭合（留档：哪条测试钉住哪个洞）

这些在 review 开始时都是可复现的漏洞，现在已修好并有回归用例（`apps/agent-runner/test/auth-hardening.test.ts`）。列出来是为了防止后续重构把它们改回去。

| 原问题 | 曾经的表现（review 初期实测） | 现在 | 钉住它的用例 |
|---|---|---|---|
| 会话路由在「无用户身份」时放大到全租户 | `end_user_token` 模式不带 token：`GET /sessions/:id`、`/items`、`/turns`、`/approvals`、`/resume` 全 200 | `requireUser` 覆盖（`app.ts:172-316`），401/403 | `:108`（但**漏了 B1 的三条**） |
| `DELETE /v1/sessions/:id` 不校验归属 | 持用户 B 的**合法**token 删掉用户 A 的会话 → **204** | 先 `getSession(requireUser(c), …)`（`app.ts:173-179`） | `:108` |
| `PUT /v1/tenant/auth` 只需 service key | 只持 key（无用户身份）降级为 `trusted_caller` → 再用 `X-User-Id` 读受害者会话 200 → 以其身份发言 200 | `requireAdmin`（`app.ts:149`）+ `ApiKeyScope`（`protocol/auth.ts:73-75`），runtime key **[实测] 403** | `:169`、`:177` |
| verifier 端点无出站校验（SSRF + 身份铸造） | `endpoint` 指内网 + `subjectField:"AccessKeyId"` → 内网响应字段经 `session.userId` **原样回显**（实测拿到 `STS.SECRETVALUE123`）；`jwksUri: 169.254.169.254` 被接受 | `validateAuthPolicy` → `assertPublicHost`（`auth-policy.ts:52-59`） | `:235` |
| introspection「非 false 即有效」 | `{"sub":"u"}`（无 active）、`{"active":"false"}`、`{"active":0}`、`{"active":null}` 全部 **201** | `body[activeField] !== true` 即拒（`end-user-auth.ts:123`） | `:256` |
| 缺 issuer/audience → 别家 RP 的 token 可用 | 只配 `jwksUri`：`iss/aud` 完全无关的 token → **201** | 写入侧强制二者必填（`auth-policy.ts:54-56`） | `:212` |
| HS256 与 jwksUri 并列 | schema 允许（运行时被 jose 挡住，但配置是错的） | 写入侧拒绝（`auth-policy.ts:44,47-49`） | `:200` |
| hs256 无 secret → 整租户永久 500 | `PUT` 200 后每个 `/v1` 请求 500，**连改回策略的 PUT 也 500**（只能改库） | 写入侧拒（`auth-policy.ts:51`）+ 策略损坏时 `/v1/tenant/auth` 仍可达（`auth.ts:31-32,112-123`） | `:192` |
| 空白 `X-User-Id` 静默放大 | `X-User-Id: "   "` → 列出其他用户会话 200 | 空值不再是身份 + `USER_ID_RE`（`auth.ts:24,126`） | `:131`、`:152` |
| userId 无字符集校验（03 的 M12） | 控制字符 / CRLF / 同形字符可进 userId | `USER_ID_RE` 同时校验 header 与 token subject（`auth.ts:126,135`） | `:152` |
| 策略缓存 TTL 摧毁 verifier 级缓存 | TTL=20ms、4 次请求 → JWKS 被抓 **4 次**；introspection 正向缓存每 TTL 清零 | verifier 按「tenantId + 策略内容哈希」缓存并跨 TTL 存活（`auth.ts:47-76`） | `:285`（TTL=1ms 下 `jwksHits === 1`） |
| token 无长度上限 + 负向不缓存 = 放大器 | 200KB token 原样转发上游；同一个坏 token 连发 5 次 → 上游被调 5 次 | `MAX_TOKEN_BYTES = 8KB`（`auth.ts:27,133`）+ 5s 负向缓存（`end-user-auth.ts:79-81,92-93`） | `:269`、`:307` |
| 旧 secret 复活（经「不需要 secret 的中间态」） | 切 verifier 后旧密钥仍可签 token | 新策略不需要 secret 时清库（`app.ts:153` 的 `null`） | `:223`（**B2 是它的补集，仍未修**） |

---

## 3. 路由逐条授权审计（当前代码）

「无身份时的实际范围」= `end_user_token` 模式不发 token、或 `trusted_caller` 模式不发（或发空白）`X-User-Id` 时，这条路由实际能碰到的数据。

| 路由 | service key | scope | `requireUser` | 归属校验 | 作用于用户数据 | 无身份时的实际范围 | 结论 |
|---|---|---|---|---|---|---|---|
| `GET /healthz` `/readyz` `GET /v1/capabilities` | ✗ | — | — | — | ✗ | 公开 | 可接受 |
| `POST /v1/agents`、`PUT /v1/agents/:id` | ✓ | **admin** | ✗ | tenant | ✗ | 需 admin | 正确 |
| `GET /v1/agents`、`GET /v1/agents/:id` | ✓ | runtime | ✗ | tenant | ✗ | 全租户 agent **含 `instructions` 全文** | **B6** |
| `PUT/DELETE /v1/providers/:id` | ✓ | **admin** | ✗ | tenant | ✗ | 需 admin | 正确（03 C4 的入口已收窄） |
| `GET /v1/providers` | ✓ | runtime | ✗ | tenant | ✗ | 全租户 provider（header 值已掩码） | **B6**（较轻） |
| `GET /v1/models` `GET /v1/tools` | ✓ | runtime | ✗ | tenant / 无 | ✗ | 全租户（无敏感） | 可接受 |
| `GET /v1/tenant/auth` | ✓ | **admin** | ✗ | tenant | ✗ | 需 admin（secret 只回 `hasSecret`） | 正确 |
| `PUT /v1/tenant/auth` | ✓ | **admin** | ✗ | tenant（改身份根） | ✗ | 需 admin | 正确，但**无审计**（B8）、可降级（§5 残余风险） |
| `POST /v1/sessions` | ✓ | runtime | **✓** | `assertMayActAs` | ✓ | 拒绝 | 正确 |
| **`GET /v1/sessions`** | ✓ | runtime | **✗** | `caller && q.userId`（caller 空则失效） | ✓ | **全租户会话列表 + `?userId` 任意过滤** | **B1** |
| `GET /v1/sessions/:id` | ✓ | runtime | ✓ | `getSession` | ✓ | 拒绝 | 正确 |
| `DELETE /v1/sessions/:id` | ✓ | runtime | ✓ | `getSession` | ✓ | 拒绝 | 正确（已修） |
| `POST /v1/sessions/:id/compact` `/archive` `/resume` | ✓ | runtime | ✓ | `getSession` | ✓ | 拒绝 | 正确 |
| `POST /v1/sessions/:id/turns` | ✓ | runtime | ✓ | `getSession` | ✓ | 拒绝 | 正确 |
| `GET .../turns`、`.../turns/:turnId` | ✓ | runtime | ✓ | `getSession` | ✓ | 拒绝 | 正确 |
| `POST .../turns/:turnId/interrupt` `/steer` | ✓ | runtime | ✓ | `getSession` | ✓ | 拒绝 | 正确 |
| `POST .../turns/:turnId/tool-results` | ✓ | runtime | ✓ | `getSession`，**仍不校验 turnId/toolCallId 归属** | ✓ | 拒绝 | 身份维度已修；**03 的 H1（跨会话/跨租户 toolCallId 注入）仍未修** |
| **`GET /v1/usage`** | ✓ | runtime | **✗** | `caller && q.userId`（同上失效） | ✓ | **全租户用量；`groupBy=user` 枚举全部 userId** | **B1** |
| `GET /v1/sessions/:id/items` | ✓ | runtime | ✓ | `getSession` | ✓ | 拒绝 | 正确 |
| **`GET /v1/sessions/:id/events`** | ✓ | runtime | **✗**（`app.ts:301` 用裸 principal） | `getSession` | ✓ | **任意用户会话的全量事件流（SSE）** | **B1，本子系统里泄露面最大的一条** |
| `GET /v1/sessions/:id/approvals` | ✓ | runtime | ✓ | `getSession` | ✓ | 拒绝 | 正确 |
| `POST .../approvals/:approvalId` | ✓ | runtime | ✓ | `getSession` | ✓ | 拒绝 | 正确 |

**读法**：23 条里只剩 3 条没过 `requireUser`，而它们恰好是「列表 / 用量 / 事件流」—— 枚举 + 全量内容的组合，覆盖面不比修好的那批小。根因仍是 `host.ts:191` 的 `principal.userId &&` 短路：只要还有一条路由能带着空 userId 走到它，这个洞就还在。**建议把短路彻底去掉**（`getSession` 要求非空 userId），让「忘记 `requireUser`」从「静默越权」变成「500/400」。

---

## 4. 一期必修

1. **B1 —— 补 `requireUser`**：`GET /v1/sessions`、`GET /v1/usage`、`GET /v1/sessions/:id/events`；并把 `host.getSession` 的 `principal.userId &&` 短路去掉（改为断言非空），杜绝下一次遗漏。回归用例直接加进 `auth-hardening.test.ts:108` 的循环。
2. **B2 —— secret 绑定用途**：切换 verifier 种类时旧 secret 作废；`hs256:true` 未带 secret 时只允许沿用「同用途」的库内 secret。
3. **B3 —— `useStoredSecret` 要么实现要么删**（推荐：为假时 `buildVerifier` 不把 secret 传给 verifier）。
4. **B4 —— verifier 端点强制 https**。JWKS 是信任根，明文传输等于没有信任根。
5. **B5 —— admin key 有路可走**：迁移回填 + 签发/轮换/吊销接口。否则这套 scope 机制在生产上表现为「谁都不能配策略」，而运维的第一反应会是手工 `UPDATE api_keys SET scopes=...`，那比没有 scope 更糟。
6. **B6 —— `instructions` 不给 runtime key**（模式 2 的前提是 key 会出现在端侧）。

## 5. 上云前必修

1. **B8 —— 策略变更审计 + 降级/端点变更告警**（`tenant_auth_audit`）。身份信任根的每一次改动都必须可追溯，越晚补越无法回填。
2. **B9 —— 失效广播 + 租户停用开关 + `cache.get` in-flight 去重**；把「策略收敛 ≤ TTL」「token 吊销 ≤ cacheTtlMs」写进 SLA。
3. **B7 —— 两层缓存换有界 LRU，键改 `sha256(token)`**，`cacheTtlMs` 默认降到 30s。
4. **B5 的后续 —— per-key 限流**（03 的 H7）：目前一把 key 既没有速率限制，也没有吊销手段。
5. **B10 + B11 —— schema 收紧**：`algorithms.min(1)`、`clockToleranceSec ≤ 60`。
6. **03 的 H1（tool-results 的 `toolCallId` 归属）**：身份维度已被 `requireUser` 覆盖，但「用自己的 session 注入别人 turn 的 toolCallId」这条仍在，属于本次顺带确认仍然存在的旧账。
7. **B12 —— 删掉 `sameDigest` 死代码**（顺手）。

## 6. 可接受（附理由）

| 项 | 理由 |
|---|---|
| **`trusted_caller` 下持 key 即可代表全租户任意用户** | 这是该模式的**定义**。**[实测]** runtime key 仍可 `POST /v1/sessions {"userId":"u_anyone"}` → 201，这是正确行为（BFF 代任意用户是它的职责）。可接受的前提是文档里那条硬性前提（key 只在租户后端）+ 部署检查。 |
| **admin key 可以把租户降级回 `trusted_caller`，从而冒充所有人** | 这是**不可消除的残余风险**：能配置身份体系的凭据，必然能把身份体系关掉。scope 分离已经把它从「任何 runtime key」收窄到「admin key」，剩下的控制只能是检测性的 —— 所以 B8 的审计 + 降级告警是这条「可接受」的**前置条件**，不是可选项。另可考虑单向棘轮（切到 `end_user_token` 后，改回需要额外的带外确认）。 |
| **已验签 JWT 在 `exp` 前可重放** | 无状态 token 的固有语义；引入 `jti` 去重需要共享存储并让多 runner 强耦合，会话类 API 也没有需要防重放的一次性语义（幂等另有机制）。接受，条件是 `exp` 必填 + 时钟容忍收窄（B11）。 |
| **introspection 正向缓存让已吊销 token 最长再活 `cacheTtlMs`** | 一次上游往返换 N 个请求是必要取舍。接受，条件是默认值降到 30s 并写进 SLA（B7/B9），且**不要**为省流量调到上限 600s。 |
| **verifier 缓存键 = `tenantId + 策略哈希 + secret 密文`** | 这个键的构造是对的：含 tenantId 所以不会跨租户串（我特意查了，因为「按配置复用 verifier」最容易在这里出跨租户身份混淆）；含 secret 密文所以轮换密钥会换实例；配置一变旧实例被删（`auth.ts:71-72`）。保持现状。 |
| **策略损坏时 `/v1/tenant/auth` 走 `trusted_caller` 兜底** | `auth.ts:112-123` 的做法是对的：可自救 > 干净。且兜底只对这一条路由生效、仍需 admin scope、其余路由一律 401。 |
| **`hashApiKey` 用未加盐 SHA-256 / 无 `timingSafeEqual`** | 沿用 03 的论证（192-bit 随机 key 无可枚举原文空间；比较在索引等值查找内部）。前提是入库处强制 key 格式与熵 —— 这条现在压在 B5 的签发接口上。 |
| **`resolveApiKey` 不走缓存（每请求一次主键查询）** | 这是为吊销即时性付的性能代价，在本子系统里更值得付。正确顺序是「先有吊销接口与广播，再考虑加缓存」（03 的 L2）。 |
| **端点不可达时全租户 fail closed** | 正确默认（`end-user-auth.ts:112-115`）。不改。但需要熔断与告警，避免「上游抖动 → 无限重试 → 恢复更慢」。 |

---

## 7. 已核对为可靠（SOUND）

专门验过、结论是**当前实现正确**的部分，列出来避免后续重构改坏：

| 项 | 证据 |
|---|---|
| **alg 混淆 / `alg: none` 双重挡住** | 运行时：`end-user-auth.ts:68` 把 `algorithms` 白名单固定传给 jose；**[实测]** 即使策略里 `HS256` 与 `jwksUri` 并列，用 JWKS 里 RSA 公钥的 `n` 当 HMAC 密钥签的 token 仍被拒（401 `Unsupported "alg" value for a JSON Web Key Set` —— jose 在 key set 侧就拒绝对称算法）。写入时：`auth-policy.ts:47-49` 直接不让这种配置存在。`alg: none` 不在白名单内。经典 RS256→HS256 混淆在这套代码上**不可达**。 |
| **`X-User-Id` 不是真相来源** | 与已验签 subject 不一致 → 403（`auth.ts:136`）；`end_user_token` 模式下单独使用 → 401（`auth.ts:143` + `requireUser` 的 `tokenMissing` 分支）；空白值不再是身份（`auth.ts:125-126`）。 |
| **`userVerified` 下不得代他人建会话** | `assertMayActAs`（`auth.ts:186-191`）+ `host.ts:162`，实测 403。 |
| **上游不可达 → 拒绝（fail closed）** | `end-user-auth.ts:112-115`，标了 retryable。 |
| **正向缓存不给过期 token 续命** | `Math.min(Date.now() + cacheTtlMs, expiresAtMs)` 且 `until > Date.now()` 才写入（`:136-141`）。 |
| **verifier 缓存跨 TTL 存活且不跨租户** | `auth.ts:67-75` 的键含 tenantId 与策略哈希；**[实测]** TTL=1ms 下 4 次请求只抓 1 次 JWKS。 |
| **token 进入解析前限长** | `auth.ts:133` 的 8KB 上限，先于 `verifier.verify()`。 |
| **错误信息不回显 token / 库内细节** | `reason()` 截断 200 字符（`end-user-auth.ts:158-162`），测试断言响应不含 token 前 24 字符；secret 只以 `hasSecret` 布尔回显。 |
| **secret 静态加密** | AES-256-GCM、每次随机 12B IV、16B tag、`keyId` 不匹配即拒解密、主密钥格式强校验（`providers/src/secrets.ts`）。缺 AAD 是 03 的 M10，本文不重复。 |
| **key 吊销路径上无缓存** | `resolveApiKey` 每请求查库且 `revoked_at_ms IS NULL`（`mysql/store.ts:317`）→ 一旦有吊销接口，生效即时。 |
| **跨租户隔离** | tenantId 一律来自 `resolveApiKey`（`auth.ts:107,149`），从不取自请求体/头；会话/agent/provider 查询都带 tenantId。本次未发现跨租户读写路径（03 关于 `items/events/turns` 表缺 `tenant_id` 列是「约定而非机制」的结论仍然成立）。 |
| **`bodyLimit` 在 auth 之前** | `app.ts:86` 先于 `:88`，超大 body 不会先缓冲再鉴权。 |
| **scope 判定** | `requireAdmin` 读的是 middleware 从 store 取来的 `scopes`（`auth.ts:151,176-181`），不接受任何请求侧输入；**[实测]** runtime key 调 `PUT /v1/tenant/auth` → 403。 |
