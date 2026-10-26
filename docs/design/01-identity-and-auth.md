# 身份与鉴权（agent-service）

> 当前规范（2026-10-25）：service key、两种 user 身份模式与 owner/scope 隔离已实现，纳入 `61c3a58` 的本地/CI验收范围。最终证据见 [PROGRESS](../PROGRESS.md)；目标生产身份系统、密钥交付与撤权时效仍待实际环境验收。

## 两个必须分开回答的问题

| 问题 | 谁来回答 | 凭据 | 可否伪造 |
|---|---|---|---|
| **谁在调用**（哪个系统） | 一定是服务端密钥 | `Authorization: Bearer <service api key>` | 持有者具备调用能力，必须保护密钥 |
| **用户是谁**（哪个人） | 取决于租户策略 | `X-User-Id` 头 **或** 端用户自己的 token | 前者由可信后端声明，后者由服务验证 |

把这两个混在一起谈会得出错误结论。service key 回答的是"调用方是哪个租户"，它**不回答**"这是哪个用户"。

## 关键结论：runner 必须自己验证，不能只接收

一个常见的直觉是「让 router 拿到用户登录态，再把身份信息传给 runner，runner 就能鉴权」。这个方向是对的，但落地时有个必须绕开的坑：

**router 转发过来的任何字段，和 `X-User-Id` 一样不可信。** 它走的是内网，谁能直连 runner（同集群的其他服务、被攻破的 pod、错误配置的 Service）就能伪造同样的头。如果 runner 只是"读取 router 转发的身份"，那安全边界就落在了网络可达性上，而不是密码学上。

所以：**runner 是权威**。它要么自己验证端用户 token，要么明确接受"调用方是可信的"这个前提。router负责公共入口、路由及独立管理/内部门禁；普通业务的service/user/scope与资源归属由runner权威验证。router的无业务持久状态不免除其管理面和内部接口鉴权。

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
你们的 App 端 ──端用户 token──> 你们的后端 ──service key + 端用户 token──> router → runner
```

- 调用方除了 service key，还要带上**端用户自己的 token**（默认头 `X-End-User-Token`，可配）。
- runner 验证它，`userId` 从验证结果里取。`X-User-Id` 若同时出现，必须与验证出的 subject 一致，否则 403；单独用 `X-User-Id` 直接 401（不允许静默降级）。
- 这个模式下不允许代别人建会话（`userId` 与验证身份不符 → 403）。
- 两种验证器：

| 验证器 | 适用 | 配置 | 说明 |
|---|---|---|---|
| `jwt` + `jwksUri` | 你们的登录体系签发 JWT（非对称） | `jwksUri` / `issuer` / `audience` / `algorithms` / `subjectClaim` | **推荐**：无需保存该签名私钥；JWKS缓存可减少网络读取，刷新与故障仍须独立处理 |
| `jwt` + `hs256` | JWT 但对称签名 | 同上 + 共享密钥 | 密钥用与 BYOK 相同的信封加密存储，不落明文 |
| `introspection` | 不透明 token（session id 之类） | `endpoint` / `activeField` / `subjectField` / `cacheTtlMs` | 调你们的校验接口；正向结果有缓存（默认 60s），**校验服务不可达时一律拒绝**（fail closed） |

算法在配置中固定以防alg混淆；按策略校验issuer/audience，对token中存在的exp/nbf执行时间校验，容忍时钟偏移默认30s。该说明不把可选claim当作已强制存在。

### 配置方式

管理接口为 `GET/PUT /v1/tenant/auth`，均要求tenant admin scope；普通user身份不授配置写权限。下列只展示非秘密PUT body，实际请求沿[HTTP手册](../operations/http-experience.md)的受保护auth配置与私有response文件流程，避免把key放curl argv、shell历史或终端输出。生成SDK使用相同API合同。

```json
{
  "policy": {
    "mode": "end_user_token",
    "tokenHeader": "x-end-user-token",
    "verifier": {
      "kind": "jwt",
      "jwksUri": "https://auth.example.invalid/.well-known/jwks.json",
      "issuer": "https://auth.example.invalid",
      "audience": "agent-api",
      "algorithms": ["RS256"],
      "subjectClaim": "sub"
    }
  }
}
```

example.invalid仅为形状占位，须由实际身份系统提供真实受控地址；不是可直接执行的配置。

策略是**每租户**的，不是同一tenant中按每把service key切换模式。需要两种信任关系时应先明确tenant与调用方划分。写入后在当前 runner 立即生效，其他 runner 在缓存 TTL（默认 10s）内收敛。

## 隔离行为（两种模式都成立）

- 跨租户：一律 404，与"不存在"不可区分。
- 同租户跨用户：带用户身份时，读写别人的会话是 404。
- 所有 session 级读写都必须带用户身份；没有用户身份时，只有带 `admin` scope 的 service key 才能查看租户级 session 列表或 usage 汇总，不能启动 turn。租户策略、API key、agent 定义和 BYOK 写操作同样要求 `admin` scope。

## 接入参数

启用 `end_user_token` 前，由实际身份系统提供 JWKS/issuer/audience/subject claim，或 introspection endpoint、响应映射与受保护凭据。秘密只进入受保护配置，不粘贴到文档、日志或公共响应。未配置时仍为 `trusted_caller`，service key只放服务端。

## 实现与验收边界

实现入口为 [auth](../../apps/agent-runner/src/auth.ts)、[policy](../../apps/agent-runner/src/auth-policy.ts)和[end-user verifier](../../apps/agent-runner/src/end-user-auth.ts)。[auth.test.ts](../../apps/agent-runner/test/auth.test.ts)及[auth-hardening.test.ts](../../apps/agent-runner/test/auth-hardening.test.ts)覆盖身份、算法、隔离、缓存与失败拒绝；当前通过范围以 `61c3a58 / CI40211433064 attempt1` 和 PROGRESS 为准，不固化旧测试数量。

现有实现/验证缺口，需单独安全审查：auth-policy的配置guard只做HTTPS、无内嵌凭据与公网预检；end-user-auth默认fetch连接没有本项目受控socket pin，introspection请求也未显式禁止redirect。JWKS转发固定JOSE提供的request options，不能据本文件推断其完整redirect策略。安全目标仍是每次实际连接目的地验证、凭据目的隔离和受控重定向，当前行为不作为被认可的安全合同。

既有auth/auth-hardening具名范围证明身份/算法/隔离及配置时URL拒绝；主要本地IdP fixture注入宽松guard，不能借用MCP或web_fetch原生socket验收证明此路径。该缺口未做攻击复现或根因定级，本轮源码不动；需另行安全审查与定向验证，真实IdP兼容/撤权传播/生产网络仍待目标环境验收。
