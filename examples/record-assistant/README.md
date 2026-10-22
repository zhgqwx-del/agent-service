# 记录助手：最小 SDK 参考集成

这是合成的 App 后端参考，不是实际 App 接入、业务持久仓储、生产服务或新 Agent Runtime。它复用现有 SDK，以一个固定 agent、一个明确 owner 和有限记录输入完成“分析/反问 → 补充更正 → 同主题追问 → 结果关联保存”。

## 责任与运行前提

- 调用方在可信后端验证终端用户及业务权限，再显式注入 SDK 连接配置。service key 不交给终端，样例不读取 `.env`、不加载凭据文件、不启动服务或执行迁移。
- agent 已由获授权的管理流程建立并固定版本。参考样例不创建 agent、配置模型或开启工具；模型调用可能收费。默认验收使用受控 FakeVendor，真实模型需另有明确授权和预算。
- 本地真实栈按[人工预置与 external-infra 手册](../../docs/operations/schema-bootstrap.md)准备；这里仅通过显式 router URL 调用公共 API，不使用历史 root/共享端口快捷启动。
- `ReferenceApp` 的记录读取、主题映射和结果保存属于 App 后端。真实实现须提供 owner 隔离、记录版本不可变、映射 CAS 和结果保存幂等。

`MemoryReferenceApp` 仅是单进程内存 fixture：并发创建共享一个 Promise；失败的创建也保留，避免响应不明时自动重建。它不持久化，不证明跨进程/崩溃后的映射、请求幂等或结果恢复。不同 agent/version 应使用独立主题映射；不将一个业务主题永久绑定为一用户一 session。

## 三轮调用

`reference.ts` 在仓库内直接引用 SDK 源码，便于复用现有测试；提取到业务项目时将该导入改为 `@agent-service/sdk`。此处不增加公共 SDK 导出或产品 bundle。

```ts
import { createRecordAssistant, MemoryReferenceApp } from "./reference.js";

// owner、connection 和 agent 来自可信调用方，不从终端请求直接采信。
const owner = { tenantId: "reference-tenant", userId: "alice" };
const app = new MemoryReferenceApp();
app.putRecord(owner, { id: "record-a", version: 1, text: "项目代号青禾，周五提交。" });
const assistant = createRecordAssistant({
  owner, app,
  connection, // 已授权的 SDK 配置：baseUrl、serviceApiKey、userId、可选 fetch/signal
  agent,      // 已存在的 { id, version }；在测试中使用明确的 FakeVendor agent
});
const base = { topicId: "project-a", recordId: "record-a" };

const first = await assistant.reply({ ...base, operationId: "op-1", recordVersion: 1,
  text: "请分析；缺少交付形式时先问我，不要猜测。" }, signal);

app.putRecord(owner, { id: "record-a", version: 2, text: "项目代号更正为青禾二期，周五提交。" });
const second = await assistant.reply({ ...base, operationId: "op-2", recordVersion: 2,
  text: "补充：按列表交付，并按更正后的代号继续。" }, signal);
const third = await assistant.reply({ ...base, operationId: "op-3", recordVersion: 2,
  text: "依据前文，最终项目代号、日期和交付形式是什么？" }, signal);

// 三轮返回同一 sessionId，各自有 turnId；业务结果保留 recordId/version 和 operationId。
const saved = app.saved(owner, "op-3");
```

`signal` 由调用方为当前请求提供合理期限。停止读取 SSE 不等于取消 turn；样例收到持久 turn 终态后关闭订阅，并按 turnId 读取已持久 assistant item。未自然完成的 turn 不发布为成功分析。

每次最多注入一条 16 KiB 记录和 8 KiB 请求文本。来源 ID/version 显式进入文本与结果关联；metadata 本身不装配上下文。业务记录是数据，不获得系统指令或额外工具权限。固定 agent 的指令与权限仍由授权管理流程决定。

## 重试与更正边界

- 同 `operationId` 必须保持相同 topic、record/version 和请求文本；精确重试复用原请求身份，异请求拒绝。不要为超时换 key 或换 session。
- turn 已完成但 App 保存失败时，同实例重试只保存原答案，不再请求模型。创建 session 的失败保持原失败，需调用方核实，不自动重建。
- 生成期间记录已升级，旧版本结果保存为 `superseded`，不能当作新版本当前结果。更正不会删除 Runtime 已持久历史；删除/撤权及摘要失效仍需正式业务合同。
- 同 topic 的首次并发只证明该 fixture 的单进程分配；后续同时启动 turn 仍受服务端 `session_busy`/lease 规则约束，样例不自动排队或换身份重试。
- 换进程、跨设备持久映射、长期任务、业务检索/写入工具和实际 App 数据源不在本参考实现范围内。需要时替换小接口，不据此新增一套通用 App 仓储平台。

正式定向命令为 `pnpm test:record-assistant-reference`，测试位于 `packages/sdk/test/record-assistant-reference.test.ts`，使用 SDK transport double，只证明参考编排。真实 router → runner → MySQL/Redis → Pi → HTTP FakeVendor 的三轮证据需由独立受控纵向验证，不能用脚本回复或 mock 单测证明模型理解、数据库语义或实际 App 接入。

真实服务纵向命令为 `pnpm test:record-assistant-reference-mysql`，对应 `apps/agent-runner/test/record-assistant-reference.mysql.test.ts`。它要求显式的独占本地 `MYSQL_TEST_URL` 和 `REDIS_TEST_URL`，仅在新建随机测试库/namespace中验证三轮、实际服务端幂等重放、usage和停服冷读；缺少目标时失败，不使用默认共享端口，也不连接真实模型。请沿用项目的测试实例所有权与失败保留约定。
