# 首个记录助手夹具切片验收记录

## 接入前基线

- 源码工作树起点为 `main` 的 `8cc9900`，已有未跟踪的 `.agents/`，其中包含 `init-stdd`。
- 静态核对公开入口从 [OpenAPI](../../packages/protocol/openapi.json) 和 [SDK](../../packages/sdk/README.md) 开始。会话、执行、SSE、身份与数据边界从[现行规格索引](../../specs/README.md)进入现有设计和运维合同。
- 从 [package.json](../../package.json) 和[开发与 CI 指南](../../docs/operations/development-and-ci-guide.md)确认产品验证入口。协议同步用 `pnpm check:api`，定向回归按受影响场景选取，适用的完整门禁按指南执行。
- 既有受测版本、具名结论和已知失败见 [PROGRESS](../../docs/PROGRESS.md)。新主机未持有原本机证据，原验收未独立复核。

## 接入核查

本轮核查 STDD/SDD 工作区接入。产品定向测试、构建、完整验证、CI 和手工体验本轮均未执行。

- `git diff --check` 通过。核对 35 个新增脚手架文件、两处导航改动和其中 107 处本地链接及锚点。
- `python3 -B scripts/check_traceability.py` 成功，输出 0 份现行格式规格、0 条需求、0 个场景。当前已有行为通过规格索引引用既有合同。
- 在临时目录验证了新建变更、重复建档保护及 REQ/AC 关联的通过与失败样例。`git_range.py` 使用已有本地提交完成只读对比。
- 对当前工作树重复预演初始化，结果为 0 新增、0 受阻。

### 接入复核修正

- 初始定向验证中有 7 项结果与预期不符，复现了缩进标题和 HTML 注释造成的漏检。最终 CLI 在隔离目录通过 24 项定向检查，覆盖缩进标题、章节边界、隐藏场景和关联、注释闭合线、围栏与跨行代码、转义、重复编号与未知关联。
- 实际受测的 `scripts/check_traceability.py` SHA-256 为 `aeb63a8ee47377da237f48806bc5e76c5fe3c4ee688f8aecf55eb58f6361d3b8`。仓库内运行结果仍为 0 份现行格式规格、0 条需求、0 个场景。
- 隔离建档检查确认生成的任务将定向和完整检查交给 root，验收模板要求绑定受测字节。复核了 107 处本地链接及锚点。本节记录 STDD 接入验证。

## DIANDI-001 夹具切片的验收

| 需求 | 场景 | 定向测试 | 实际结果 |
| --- | --- | --- | --- |
| REQ-RECORD-001 | AC-RECORD-001 / Mono AC01 | AC01 saves one confirmed drink | 通过。重开原数据库读到原回执和字段，记录、回执、Outbox 各一条 |
| REQ-RECORD-001 | AC-RECORD-004 / Mono AC04 | AC04 concurrent submissions | 通过。两连接并发，首次提交响应丢失。查回和精确重试保留一个结果。异负载冲突，新键新增独立条目 |
| REQ-RECORD-002 | AC-RECORD-009 / Mono AC09 | AC09 process exit | 通过。两个提交边界均强制终止子进程。提交前回滚后仍使用序号 11，提交后回执和事件可重开查回 |
| REQ-RECORD-002 | AC-RECORD-005 / Mono AC05 | AC05 saves offline | 通过。离线先保存。接收后响应丢失，重开 inbox 后找回原 operation。待应用轮询，恢复后仅应用一次 |

### 运行记录

- 已确认规格和方案来自 Mono `DIANDI-001`。开发分支为 `mono/DIANDI-001`，基线 `f98896a065ba22df077d62a7969444e7ec660b8e`。本地改动未提交，未刷新或同步远端。
- 先写测试后运行。夹具模块尚未创建时，`node --test examples/record-assistant/fixtures/record-fixtures.test.ts` 因 `ERR_MODULE_NOT_FOUND` 退出 1，Mono 回执为 `run-22f40457b5ee.json`。
- 实现后用同一命令退出 0，8 项通过，含 4 个顶层场景和 4 个子用例。运行环境为 Node 24.21.0 和内置 SQLite 3.53.4，使用独立临时数据库、假 Memory 接收器及合成输入。
- 对两个 TypeScript 文件定向执行严格 `tsc --noEmit` 检查，退出 0。使用本机原 checkout 已安装的 TypeScript 与 Node 类型声明。
- 夹具实现 SHA-256 为 `8bebf571a7938c14b0ba0f8c36001e0081f5d50dbcd5aa4bbdffa5f98d468f42`，测试 SHA-256 为 `606e70975534f0fce46fc135f2832726124f9de86a749c730f4f36f78a593d6f`。Mono 运行回执记录受测工作树和规格摘要。
- 此次结果覆盖独立示例夹具。真实产品与 MemoryService、Agent 反馈以及产品整体验证和 CI 待各自切片执行。

## DIANDI-001 按需反馈验收

- 用户已确认反馈方案及按测试先行实施。本地分支 `mono/DIANDI-001`，基线 `f98896a065ba22df077d62a7969444e7ec660b8e`，继承保存夹具改动。受测内容含未提交工作树，Mono 验收记录绑定工作树和规格摘要。
- 测试先写。实现前的定向运行因反馈模块缺失退出 1，Mono 回执 `run-a0971cd8bdf7.json`。
- 反馈实现 SHA-256 `19b1cb4c7dbb97a039e801639924d3c48e101b3135a3fd5cb219391b46ee9f56`，反馈测试 SHA-256 `796d26e4a4adb95b126f48bf94f912400ad6a40baf9eafcfea58a7b981b74310`。
- 本轮使用 Node 24.21.0、Vitest 4.1.11、本地临时 SQLite 和进程内 Harness。依赖来自同锁文件的已安装本地检出。FakeVendor 监听 `127.0.0.1`。正式产品接口、Memory D1、部署进程和真实模型留待各自阶段。
- 复跑命令和场景映射见[验收计划](test-plan.md)。实际退出码、用例数与通过判据记录在 Mono `DIANDI-001` 的验收回执和验收状态。

## DIANDI-001 Router/runner 纵向联调

受测分支为 `mono/DIANDI-001`，基线 `f98896a065ba22df077d62a7969444e7ec660b8e`，候选含未提交改动。使用 Node 24.21.0、Vitest 4.1.11、独占 MySQL 8.0.46 和 Redis 8.10.3。同一测试进程启动实际 router 和 runner 的独立 HTTP 监听。客户端只访问 router，runner 使用实际 MySQL、Redis 和回环 FakeVendor。产品和反馈用 SQLite 夹具，输入为合成饮水记录。

| 场景 | 实际结果 |
| --- | --- |
| AC-RECORD-001 / Mono AC01 | 通过。重开 SQLite 查到原回执。router 查询无新会话，turn POST、模型请求和可见回复均为零。 |
| AC-RECORD-002 / Mono AC02 | 通过。两种触发均在 turn POST 前以第二个 SQLite 连接查到原 committed 回执；各有一个 turn、一次 FakeVendor 请求及一个 MySQL 持久最终 item。模型输入只有本次记录及适用的饮水比例，重放复用原结果。 |
| AC-RECORD-007 / Mono AC07 | 通过。FakeVendor 挂起时断开 SSE，重开 SQLite 后回执及原 turn 待核，再按 Last-Event-ID 续接到同一 turn 的自然终态及最终 item。FakeVendor HTTP 400 后回执仍可查，发布失败后只恢复原最终 item。两种故障未产生额外派发。 |

`pnpm run test:record-assistant-reference-mysql` 执行两项通过，包含原 SDK 参考集成回归和新增纵向用例。`tsc -p tsconfig.typecheck.json --noEmit` 和 `git diff --check` 退出 0。故意取消 SSE 时服务记录 `AbortError: Response observation closed`，终态和持久 item 断言通过。复跑入口见[验收计划](test-plan.md)，最终工作树摘要、运行输出及回归证据由 Mono 工单的验收回执记录。

本次覆盖本地真实传输和持久化。产品授权、真实模型质量及首次 turn POST 响应丢失后的远端对账待验。

## DIANDI-001 待补输入与双用户夹具

用户确认在 `mono/DIANDI-001` 任务工作树补 AC03 和 AC08 产品夹具子项。基线 `f98896a065ba22df077d62a7969444e7ec660b8e`。Node 24.21.0 使用内置 SQLite 与合成用户；实现前新增两条因可信身份绑定入口缺失失败，Mono 回执 `run-661b0f5b3ffd.json`。

| 场景 | 实际结果 |
| --- | --- |
| AC-RECORD-003 / Mono AC03 | 通过。写入进程退出后，从同一 SQLite 文件查回同一操作 ID、原文“喝了水”和 `pending_input`。同键原文重试复用，异负载和直接正式提交均冲突。正式条目、成功回执及 Outbox 计数均为零，随后正常提交的首条事件序号为 11。 |
| AC-RECORD-008 / Mono AC08 夹具子项 | 通过。另一用户的待补、回执和正式条目查询与不存在等价。冒带 owner、tenant、目标条目 ID、grant 或正式来源声明时拒绝且无写入。两人用同键的本人操作互相隔离。真实产品登录与业务授权待验。 |

定向夹具套件执行 10 项通过，含原保存回归 8 项。仓内 TypeScript 无输出检查、夹具定向严格类型检查和 `git diff --check` 通过。最终证据和回归入口见 Mono 工单验收记录。

## DIANDI-001 首次 turn POST 丢响应后的对账

用户确认继续使用假 RecordService 和 FakeVendor，基线 `f98896a065ba22df077d62a7969444e7ec660b8e`，工作树 `mono/DIANDI-001`。先写 AC-RECORD-007 的纵向场景。实现前，实际 router/runner 已接受首次 POST，SQLite 查回原回执，但 turn ID 仍为 null，预期断言失败，Mono 回执 `run-5d18b8713d8d.json`。

实现后定向通过。故障注入在真实 202 的响应正文到达应用解析之前发生。未知期间，查询不可用、查无、键错误、歧义及分页不完整均保持待核。新 Node 调用进程只凭原客户端键读到同一回执及原 turn，随后重开并查回同一自然终态和最终 item。MySQL 冷读独立确认原 turn 和最终 item。仅有原始一次 POST、一次 FakeVendor 请求、一个正式条目、一份回执和一个 Outbox 事件。

只读匹配要求原专用会话里有唯一且带相同操作键的 turn。缺少标记的旧未知 turn 仍保持待核。复跑入口及故障位置见[验收计划](test-plan.md)，最终候选证据见 Mono 工单。

## 远端 CI 纵向用例预算

`agent-service` PR #1 的 CI `45805036742` attempt 3 受测 PR merge SHA 为 `0b20ddfc8a01e95c5deef6f91d2ecef0b66d55e0`。`DIANDI-001 AC01 AC02 AC07 save, dispatch once and recover through real HTTP/SSE` 完成四次 turn、SSE 恢复、回执及最终 item 的 MySQL 冷读断言后，在资源收尾触及 30 秒用例期限。此用例还包括独占数据库初始化、原生权限部署和资源归属核验，按具名用例预算规则设为 45 秒。 [失败分片](https://github.com/zhgqwx-del/agent-service/actions/runs/45805036742/job/139924250103)

在 `1d9d4a390aed34c11251c59bd8ac087c7bdc3271` 工作树应用预算调整后，Node 24.21.0 配合独占 MySQL 8.0.46、Redis 8.10.3 复跑 `pnpm run test:record-assistant-reference-mysql`，三项通过，具名用例耗时 8.436 秒。`pnpm typecheck` 与 `git diff --check` 退出 0。此前的失败保留，远端全量 CI 以新提交为准。
