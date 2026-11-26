# 首个记录助手夹具切片验收计划

用本地合成 owner、一条已确认的 300 mL 饮水记录和从序号 10 开始的隔离数据。Node 24 定向试运行从 agent-service 根执行。

```sh
node --test examples/record-assistant/fixtures/record-fixtures.test.ts
```

| 仓内场景 | Mono | 注入方式和断言 |
| --- | --- | --- |
| AC-RECORD-001 | AC01 | SQLite 文件重开，读相同回执和条目，核对三项计数 |
| AC-RECORD-004 | AC04 | 两个进程同时释放提交，丢失首个提交响应，查回、冲突及新键计数 |
| AC-RECORD-009 | AC09 | 独立的提交前和提交后 `SIGKILL`，核对空回滚、连续序号及已提交原事件 |
| AC-RECORD-005 | AC05 | Memory 拒连、延迟应用、接收响应丢失与重开 inbox，核对原操作 ID、待应用和只应用一次 |

数据库文件由各测试使用临时目录。实际结果、范围与受测字节见[验收记录](verification.md)。

## 待补输入和双用户夹具

同一 Node 定向套件新增两条场景。

| 仓内场景 | Mono | 断言 |
| --- | --- | --- |
| AC-RECORD-003 | AC03 | 子进程写入“喝了水”后退出。重新打开库，原操作 ID、原文和缺用量状态可查。同键更改输入或直接提交冲突，正式条目、成功回执及 Outbox 都是零。 |
| AC-RECORD-008 | AC08 产品夹具子项 | 同租户两名合成用户。跨用户查询等同不存在，冒带授权字段的待补和正式提交均无写入。相同客户端键的本人操作互相独立。 |

## 按需反馈定向验收

从 agent-service 根用已安装的 Vitest 启动用例。FakeVendor 只监听本机回环随机端口。产品和反馈各有临时 SQLite 文件，Harness 使用进程内会话和事件存储。

```sh
node node_modules/vitest/vitest.mjs run packages/providers/test/record-feedback.test.ts
```

| 验收 | 检查 |
| --- | --- |
| AC-RECORD-002 / AC01 回归 | 记录已保存，默认无新会话、turn、模型请求或回复。重载读到原决定。 |
| AC-RECORD-002 / Mono AC02 | 明确要求、两种条件重叠和 Agent 根据 300/500 算出 60%。检查实际送入的本次事实、单次派发和自然终态。 |
| AC-RECORD-007 / Mono AC07 | 模型 HTTP 失败、观察端断开、最终项发布失败、达到步数上限、保留响应丢失和绑定写入失败。检查原回执和原 turn，观察待核、失败或恢复完成。 |

## Router/runner HTTP 与 SSE 联调

在 agent-service 工作树设置 `MYSQL_TEST_URL` 和 `REDIS_TEST_URL`，均指向本轮独占的回环测试实例。从仓根执行 `pnpm run test:record-assistant-reference-mysql`。现有集成夹具创建独立 MySQL 数据库、运行账号及 Redis 命名空间，启动实际 router 和 runner 的 HTTP 监听。每条用例使用合成用户和回环 FakeVendor。假 RecordService 和反馈状态使用独立 SQLite 文件。

| Mono | HTTP/SSE 检查 |
| --- | --- |
| AC01 | 保存并重开 SQLite，核对同一回执。经 router 查询没有新会话，实际 turn POST 与 FakeVendor 请求计数均为零。 |
| AC02 | 分别发送明确请求与饮水比例线索。每次在真实 turn POST 前用独立 SQLite 连接确认已提交的原回执。重放原操作，检查每次只出现一个 turn 和一次 FakeVendor 请求。关闭服务后从 MySQL 回查同一 turn 与最终 item。 |
| AC07 | FakeVendor 响应前断开已收到 turn 起始事件的 SSE，从原游标续接并核对原回执、原 turn 和最终 item。另验证 FakeVendor HTTP 400 和 SQLite 反馈发布失败的恢复。进程内夹具继续单独覆盖步数上限、保留响应丢失和绑定写入失败。 |

公开非流式 turn POST 在返回 202 前启动执行。SSE 续接场景从已收到 202、已有 turn ID 开始。独立的 AC07 丢响应场景在实际 202 到达测试传输层时丢弃正文，让业务调用方得不到 turn ID。

第一次只读重开遇到查询不可用、查无、键不符、多个候选或缺少完整分页证据时必须留在待核。随后用新 Node 调用进程，仅凭原客户端操作键读取同一回执和原 turn。FakeVendor 放行后再从另一进程取得同一 turn 的最终 item。审计 HTTP 方法、FakeVendor 请求数、正式持久计数和 MySQL 冷读结果。
