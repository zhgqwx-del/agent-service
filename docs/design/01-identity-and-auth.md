# 身份与鉴权（agent-service）

> 2026-09-26 定稿并实现。取代设计文档 §5.1 的简略描述。

## 两个必须分开回答的问题

| 问题 | 谁来回答 | 凭据 | 可否伪造 |
|---|---|---|---|
| **谁在调用**（哪个系统） | 一定是服务端密钥 | `Authorization: Bearer <service api key>` | 不可（持有即证明） |
| **用户是谁**（哪个人） | 取决于租户策略 | `X-User-Id` 头 **或** 端用户自己的 token | 前者可伪造，后者不可 |

把这两个混在一起谈会得出错误结论。service key 回答的是"调用方是哪个租户"，它**不回答**"这是哪个用户"。

## 关键结论：runner 必须自己验证，不能只接收

一个常见的直觉是「让 router 拿到用户登录态，再把身份信息传给 runner，runner 就能鉴权」。这个方向是对的，但落地时有个必须绕开的坑：

**router 转发过来的任何字段，和 `X-User-Id` 一样不可信。** 它走的是内网，谁能直连 runner（同集群的其他服务、被攻破的 pod、错误配置的 Service）就能伪造同样的头。如果 runner 只是"读取 router 转发的身份"，那安全边界就落在了网络可达性上，而不是密码学上。

所以：**runner 是权威**。它要么自己验证端用户 token，要么明确接受"调用方是可信的"这个前提。router 保持无状态、不参与鉴权 —— 这也和它「可随时重启、没有业务状态」的定位一致。

（如果将来验证成本高到需要集中做，正确形态是 router 验证后签发一个**短时效、runner 可验签**的内部断言，而不是明文转发一个字段。这条路留着，当前不需要。）

## 两种模式（已实现，按租户配置）

### 1. `trusted_caller`（默认）

```
你们的 App 端 ──登录态──> 你们的后端（BFF）──service key + X-User-Id──> agent-runner
```

- 你们后端用现有登录体系认证用户，然后用 service key 调用本服务，并用 `X-User-Id` 声明代表哪个用户。
- runner 信任这个头，**因为调用方持有只应存在于你们服务端的密钥**。
- 这个模式下允许 `POST /v1/sessions` 指定 `userId`（后端代任意用户操作是它的正常职责）。
- **硬性前提**：service key 绝不能下发到 App / 小程序 / 前端。一旦下发，一把 key 即可读写该租户全部用户数据。部署检查里要有这一条。

### 2. `end_user_token`

```
你们的 App 端 ──service key + 端用户 token──> agent-runner（自己验证 token）
```

- 调用方除了 service key，还要带上**端用户自己的 token**（默认头 `X-End-User-Token`，可配）。
- runner 验证它，`userId` 从验证结果里取。`X-User-Id` 若同时出现，必须与验证出的 subject 一致，否则 403；单独用 `X-User-Id` 直接 401（不允许静默降级）。
- 这个模式下不允许代别人建会话（`userId` 与验证身份不符 → 403）。
- 两种验证器：

| 验证器 | 适用 | 配置 | 说明 |
|---|---|---|---|
| `jwt` + `jwksUri` | 你们的登录体系签发 JWT（非对称） | `jwksUri` / `issuer` / `audience` / `algorithms` / `subjectClaim` | **推荐**：无需在本服务存任何密钥；JWKS 有缓存，不增加每请求网络开销 |
| `jwt` + `hs256` | JWT 但对称签名 | 同上 + 共享密钥 | 密钥用与 BYOK 相同的信封加密存储，不落明文 |
| `introspection` | 不透明 token（session id 之类） | `endpoint` / `activeField` / `subjectField` / `cacheTtlMs` | 调你们的校验接口；正向结果有缓存（默认 60s），**校验服务不可达时一律拒绝**（fail closed） |

算法在配置里固定，杜绝 alg 混淆攻击；`exp` / `nbf` / `iss` / `aud` 全部校验，容忍时钟偏移默认 30s。

### 配置方式

```bash
# 查看当前策略
curl -H "Authorization: Bearer $KEY" $BASE/v1/tenant/auth

# 切到端用户 token 模式（JWKS，推荐）
curl -X PUT -H "Authorization: Bearer $KEY" -H 'content-type: application/json' $BASE/v1/tenant/auth -d '{
  "policy": {
    "mode": "end_user_token",
    "tokenHeader": "x-end-user-token",
    "verifier": {
      "kind": "jwt",
      "jwksUri": "https://auth.yourcompany.com/.well-known/jwks.json",
      "issuer": "https://auth.yourcompany.com",
      "audience": "agent-api",
      "algorithms": ["RS256"],
      "subjectClaim": "sub"
    }
  }
}'
```

策略是**每租户**的，所以你们自己的后端可以走 `trusted_caller`，对外开放给第三方的 key 走 `end_user_token`。写入后在当前 runner 立即生效，其他 runner 在缓存 TTL（默认 10s）内收敛。

## 隔离行为（两种模式都成立）

- 跨租户：一律 404，与"不存在"不可区分。
- 同租户跨用户：带用户身份时，读写别人的会话是 404。
- 不带用户身份的请求（比如后台列表）只能做租户级只读操作，不能启动 turn。

## 需要你提供的信息

要启用模式 2，我需要知道你们登录体系的形态，三种之一：

1. **JWT**：给我 JWKS 地址 + `issuer` + `audience` + 用户 id 放在哪个 claim。这是最省事的，我这边零密钥。
2. **不透明 token**：给我校验接口的 URL、请求形式、响应里哪个字段是"有效"、哪个是用户 id，以及调用它需要什么凭据。
3. **其它形态**（自定义签名、网关注入等）：描述一下，`EndUserVerifier` 是个两方法接口，加一种实现很快。

在你给之前，默认仍是 `trusted_caller`，并且要守住「key 只在服务端」这一条。

## 测试覆盖

`apps/agent-runner/test/auth.test.ts` 共 12 条：伪造 / 过期 / 错 issuer / 错 audience / 外部密钥签名 / 无 subject 的 token 全部拒绝；`X-User-Id` 单独使用被拒；与 token subject 不一致被拒；代他人建会话被拒；HS256 密钥不回显；introspection 的缓存命中只调一次上游、失效 token 被拒、上游不可达时拒绝；策略切换即时生效。
