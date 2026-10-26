# @agent-service/sdk

面向公共 HTTP API 的 TypeScript 客户端，包含 OpenAPI 路径类型和增量 SSE helper。服务初始化与配置见 [HTTP 接入手册](../../docs/operations/http-experience.md)，业务后端的三轮集成见[记录助手示例](../../examples/record-assistant/README.md)。SDK 不启动服务、执行迁移或配置 provider。

## 准备连接

在可信后端使用 SDK；service key 不下发到浏览器或终端用户。服务须已有可用的 router、租户 runtime key、授权用户和固定版本 agent，以及该 agent 所需的 provider 配置。真实 turn 可能调用付费模型或工具；下面的 POST 是实际请求，不是离线演示。

本仓使用 Node.js 24+；安装依赖遵循[开发指南](../../docs/operations/development-and-ci-guide.md)。仓库内可用 `pnpm --filter @agent-service/sdk build` 构建 `dist/`；在其他项目中引用已交付的受信包版本。`package.json` 的版本号不构成 npm 已发布证明。

```ts
import {
  createAgentServiceClient,
  startTurnStream,
  subscribeSessionEvents,
  type components,
} from "@agent-service/sdk";

const serviceApiKey = process.env.AGENT_SERVICE_API_KEY;
if (!serviceApiKey) throw new Error("Missing backend service credential");
const connection = {
  baseUrl: "https://agent.example.test", // 替换为已部署的 router URL
  serviceApiKey,
  userId: "u_42", // 来自后端已验证的用户身份
};
const client = createAgentServiceClient(connection);
```

`serviceApiKey` 发送为 `Authorization: Bearer …`，决定租户及 scope；`userId` 发送为 `X-User-Id`，只适用于租户允许的 `trusted_caller` 模式。`end_user_token` 模式须提供 `endUserToken`，默认发送到 `X-End-User-Token`，可用 `endUserTokenHeader` 匹配租户配置；此时用户由 token 校验结果决定，若同时给 `userId` 则必须一致。客户端字段不会授予额外权限。详见[身份与鉴权](../../docs/design/01-identity-and-auth.md)。

生成客户端的 HTTP 失败通过 `{ data, error, response }` 返回；网络异常仍会抛出。下方直接抛出 `error` 供调用方处理，不应把响应对象、请求 header 或业务正文原样写进公共日志。

## 创建 session、运行一轮并读取结果

```ts
const created = await client.POST("/v1/sessions", {
  body: {
    agentId: "REPLACE_WITH_EXISTING_AGENT_ID",
    agentVersion: 1, // 替换为实际已授权版本
  },
  signal: AbortSignal.timeout(35_000),
});
if (created.error || !created.data) throw created.error ?? new Error("Session not confirmed");
const sessionId = created.data.id; // 在业务后端持久保存，下一轮复用

const started = await startTurnStream({ ...connection, signal: AbortSignal.timeout(35_000) }, sessionId, {
  input: [{ type: "text", text: "请分析这份记录：项目青禾，周五提交。" }],
  busyPolicy: "reject",
  limits: { maxSteps: 4, maxToolCalls: 1, maxWallClockMs: 30_000, maxOutputTokensPerStep: 512 },
}, { idempotencyKey: "REPLACE_WITH_STABLE_UNIQUE_OPERATION_KEY" });

type Outcome = Pick<components["schemas"]["Turn"], "id" | "sessionId" | "status" | "stopReason">;
let outcome: Outcome | undefined;
let turnId: string | undefined;
if (started.kind === "replay") {
  outcome = started.data.turn; // 精确重放返回 JSON，也可能仍是 inProgress
  turnId = outcome.id;
} else {
  for await (const event of started.events) {
    if (event.data.type === "turn/started") turnId = event.data.turn.id;
    if (event.data.type === "turn/completed") {
      outcome = event.data.turn;
      turnId = outcome.id;
      break; // helper 关闭订阅，不等于取消服务器 turn
    }
  }
}
if (!outcome || outcome.sessionId !== sessionId) {
  // 保留 sessionId、已知 turnId、原始 body 和幂等 key，先只读核实。
  throw new Error("Turn outcome unknown; inspect the original request");
}
if (outcome.status === "inProgress") {
  // 本例停止派发，由调用方用下表的 GET/订阅继续观察原 turn。
  throw new Error("Turn is still running; read the original turn");
}
if (outcome.status !== "completed" || outcome.stopReason !== "end_turn") {
  throw new Error("Turn did not complete naturally");
}

// items 按 seq 分页；最终正文从持久 item 读取，不能拼接 delta 代替。
const items: components["schemas"]["ItemListResponse"]["data"][number][] = [];
let afterSeq: number | undefined;
for (;;) {
  const page = await client.GET("/v1/sessions/{id}/items", {
    params: { path: { id: sessionId }, query: { turnId: outcome.id, afterSeq, limit: 200 } },
    signal: AbortSignal.timeout(35_000), // 每页建立新的请求期限
  });
  if (page.error || !page.data) throw page.error ?? new Error("Items unavailable");
  items.push(...page.data.data);
  if (page.data.data.length < 200) break;
  afterSeq = page.data.data.at(-1)!.seq;
}
const answer = items.filter(item => item.type === "agentMessage" && item.status === "completed").at(-1);
if (!answer || answer.type !== "agentMessage") throw new Error("No durable assistant answer");
// 将 answer.text 与 sessionId、outcome.id、业务 operationId 关联保存。
```

本例应选择无工具 agent；`maxToolCalls` 是上限，不会移除 agent 已有工具权限。请求 `limits` 只可收紧服务和 agent 限制；创建、流读取和每页 items 各自使用新的35秒 `signal`，只控制对应客户端请求的等待，不是全流程或服务端硬期限。派发前应在业务后端保存 session、operation key 和原始请求，网络异常由外围捕获后进入下表的核实流程。

下一轮继续调用 `startTurnStream(connection, sessionId, newInput, { idempotencyKey: newOperationKey })`，使用**同一 session、同一实际用户、新输入和新的稳定 key**，先等待前轮终态。`resume` 返回 session、近期 turn 和未决审批的快照，不恢复原执行；普通续聊不需要先调用它。已归档 session 使用独立的 `unarchive` 接口恢复可写状态。`metadata` 只作业务关联，不自动成为模型上下文，记录内容和更正须显式放入 `input`。本例以 `completed/end_turn` 为自然完成；`completed/max_steps` 等表示到达上限，不能据此发布完整分析。

## 中断、重放和失败

| 情况 | 调用方处理 |
|---|---|
| `startTurnStream` 等 helper 遇 HTTP 错误 | 抛出 `AgentServiceHttpError`，可读取 `response.status` 与 `body`；生成客户端仍使用上面的返回值模型。 |
| 已知 `turnId`，需要核实状态 | `client.GET("/v1/sessions/{id}/turns/{turnId}", { params: { path: { id: sessionId, turnId } } })`；`inProgress` 仍需等待。 |
| JSON 重放的 turn 仍为 `inProgress` | 读取上述原 turn 或订阅其持久事件直到终态，不把 HTTP 200 / JSON 当作完成，也不另发 POST。 |
| SSE 断开、网络超时或 `AbortSignal` 到期 | 结果可能已提交或仍在运行。保留原身份并读取原 turn；停止读取不取消 turn，也不证明未收费。 |
| 尚未取得 `turnId` | 用同一 owner 读取 `GET /v1/sessions/{id}/turns`（按响应 cursor 分页）及持久 events，按原幂等 key 核对；无法确认时保持 unknown，不新建 session 或再发 POST。 |
| 创建 session 的响应不明 | 创建接口不提供 turn 式幂等 key；先核实业务映射和原请求，不能靠盲重试创建第二个 session。 |
| 需重连事件 | `subscribeSessionEvents(connection, sessionId, { after: lastDurableSeq })`；只保存已消费的持久 `seq`，delta/progress/heartbeat 不能充当持久游标。`lastEventId` 也可使用，二者同时存在时 `after` 优先。 |
| 人工确认后重发原 turn | 保持同用户、session、请求内容和幂等 key；精确重放可能返回 JSON。不同请求复用 key 会触发 `idempotency_conflict`。SDK 不自动重试或重连。 |
| `session_busy`、配额、draining 或鉴权拒绝 | 按错误码处理原请求，不自动换 session/key、排队、切模型或扩大权限。 |
| 需要取消服务器 turn | 由实际 owner 显式调用 `POST /v1/sessions/{id}/turns/{turnId}/interrupt`，再读取持久终态；关闭 SSE 不是此操作。 |

turn 幂等收据由 SessionHost 默认保留 24 小时，实际以服务端配置为准；过期后相同 key 可能成为新请求。业务后端须持久保存 operation 与原结果的映射，不能依赖永久去重，也不能在结果 unknown 时越过有效期盲重试。

helper 接受可选 `fetch`、`headers`、`signal`；生成客户端也可注入 `fetch`，并在单次请求传 `signal`。业务后端应设置合理请求期限，避免无界等待；期限不构成服务器执行或费用的硬取消保证。图片与外置工具输出分别使用 `uploadSessionBlob` / `readSessionBlob`、`readItemOutput`，仍按 session/owner 授权。

## 管理身份与扩展能力

| 用途 | 独立客户端 / 当前合同 |
|---|---|
| tenant erasure | `createAgentServicePlatformClient({ baseUrl, platformOperatorToken })`，仅包含两个 tenant-erasure 路径；见[生命周期](../../docs/design/04-data-lifecycle.md)。 |
| 平台 skills registry | `createAgentServiceSkillRegistryOperatorClient({ baseUrl, skillRegistryOperatorToken })`；见[Skills](../../docs/design/07-skills.md)。 |
| 平台 MCP registry | `createAgentServiceMcpRegistryOperatorClient({ baseUrl, mcpRegistryOperatorToken })`；见[MCP](../../docs/design/06-mcp.md)。 |
| 租户 MCP / skills / hooks | 普通客户端或对应 helper，遵守 tenant-admin、owner、scope、版本和服务端 gate；见[tool hooks](../../docs/design/08-tool-hooks.md)。 |

三种 operator token 各自独立，接受 32～256 个 token-safe 字符；不填入 `serviceApiKey`，也不用于普通 session/SSE。SDK 类型或 helper 存在不代表服务端 gate 已启用、生产环境已验收或整个扩展架构已完成。

## 合同与验证

公共合同来自 `packages/protocol` 和运行时 HTTP schema；`src/generated/schema.ts` 为生成文件，不手改。协议变更后在仓库根运行 `pnpm generate:api`；`pnpm check:api` 只读检查 OpenAPI 文档、运行时文档及 SDK 类型是否同步。

SDK transport 测试与[参考示例测试](../../examples/record-assistant/README.md#验证范围)证明各自具名范围，不证明真实模型回答质量。正式版本和 CI 验收以 [PROGRESS](../../docs/PROGRESS.md) 顶部为准；文档修改不构成新 binary 验收。
