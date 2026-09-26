# Spike: pi 嵌入验证（2026-09-22）

验证 `docs/design/00-architecture.md` §6.1 / §14 #1 的假设。真实端点：DashScope 兼容模式，`qwen3.8-max`。

```bash
pnpm install
node --env-file=../../.env --experimental-strip-types src/main.ts
```

| # | 检查 | 结果 |
|---|---|---|
| 1 | 自定义 OpenAI-compatible provider，**不读任何环境变量**，apiKey 每次调用通过 `getApiKey` 注入；自定义 `fetch` 注入成功（可审计出站请求头） | 通过。出站头只有 `authorization`、`user-agent: pi (...)`、openai SDK 的 `x-stainless-*`；无遥测头。`user-agent` 与 `x-stainless-*` 生产上要覆盖/剥离 |
| 2 | 多步工具循环（并行两个工具）→ 第二次 LLM 调用 → 最终回答；事件序列 | 通过。2 次请求、约 5.8s；事件：`agent_start, turn_start, message_start/end, tool_execution_start/end, turn_end, agent_end` + `message_update` delta |
| 3 | 中途 `abort()` | 通过。5 个 delta 后中止，末消息 `stopReason=aborted`，`isStreaming=false` |
| 4 | 运行中 `steer()` | 通过。在工具结果之后、下一次 LLM 调用之前注入，模型按新指令又调了一次工具 |
| 5 | 用持久化的 `state.messages` 在**新 Agent 实例**里恢复并追问 | 通过。模型正确引用了上一轮上下文 |
| 6 | 前缀稳定：system 消息 + tools 的 JSON 在同一 run 的多次请求、以及恢复后的请求里 sha256 一致 | 通过（`2adb94c0…` 三次一致）。注意 pi 会把 system prompt 与 tools 声明放进 transcript 首条 system 消息，并在 tools 变化时**追加**一条 system 消息而不是改首条，与我们 §6.2 的增量设计一致 |
| 7 | `finishTurn` 返回 `{action:"end"}` 作为 maxSteps 安全阀 | 通过。工具执行后不再发起后续 LLM 调用，末消息是 `toolResult` |

## 踩到的坑（写进 PiEngine 实现）

- 自定义 provider 的 `auth.apiKey.resolve` 必须处理 `credential.key`：per-call 的 `apiKey` 是作为 credential 传给 provider 自己的 `resolve` 的，直接返回 `undefined` 会报 `Provider is not configured`。正确写法见 `src/main.ts` 的 `resolve: async ({ credential }) => ...`，这同时保证了"永不读环境变量"。
- `openAICompletionsApi` 从 `@earendil-works/pi-ai/api/openai-completions.lazy` 导入，不是 `.../openai-completions`。
- qwen3.8-max 即使 `reasoning:false` 也会返回 `usage.reasoning` token，计费要计入。
- usage 里 `cacheRead` 为 0：DashScope 兼容模式的缓存字段拼法需要在 `packages/testkit` 的假厂商与真实探针里分别核对。

## 结论

pi 路线 A（`Agent` 类 + 自研会话落库）成立，进入 `packages/core` 的 `PiEngine` 实现。
