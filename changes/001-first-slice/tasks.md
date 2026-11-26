# 首个记录助手夹具切片任务

## 实施方案

确认依据为 Mono `DIANDI-001` 的四条首批验收及用户开始实施的指令。

- 在[定向测试](../../examples/record-assistant/fixtures/record-fixtures.test.ts)先写验收场景。并发与崩溃使用不同子进程，子进程在给定提交边界发送本进程的 `SIGKILL`。读回重开原数据库文件。
- 在[夹具模块](../../examples/record-assistant/fixtures/record-fixtures.ts)使用 Node 内置 SQLite，产品端和 Memory 接收端各用独立文件。产品事务同时持久化条目、回执、序号和事件。接收端持久化 inbox 和连续应用结果。已知 Memory 操作按原 ID 轮询，未知响应重投原事件。
- 保持示例入口独立。正式产品使用其真实授权、持久层及发布流程。夹具复跑使用 [验收计划](test-plan.md) 的命令。

## 实施任务

- [x] 编写四个 Mono 场景的定向测试并记录缺失实现的结果。
- [x] 实现可重启的 RecordService 与 Memory 接收夹具。
- [x] 复跑定向测试和类型检查，记录受测内容与覆盖边界。 [验收记录](verification.md)

## 按需反馈实施

- 继续使用保存夹具的只读回执和条目接口。反馈示例使用独立 SQLite 保存触发决定、保留 turn 的绑定及最终回复。每个有反馈的操作使用其预备的空历史会话，保留绑定后才运行。 [反馈实现](../../examples/record-assistant/fixtures/feedback.ts)
- 复用 Provider 方言测试的进程内装配和 FakeVendor。先写断言，覆盖默认保存、明确请求、容量比例和各个 AC07 恢复分支。 [定向测试](../../packages/providers/test/record-feedback.test.ts)
- 回归四条保存验收。实际执行和受测版本见[验收记录](verification.md)。

## 待补输入和双用户夹具

- [x] 按用户在 DIANDI-001 的确认，先写 AC03 和 AC08 夹具负例并确认实现前失败。
- [x] 在可重启的假 RecordService 内持久化待补操作，由可信测试身份绑定 owner。待补写入与正式提交在同一写事务规则下检查操作键，避免两种状态共用同一个 owner 和操作键。
- [x] 重启后按原键查回原文和待补状态。双用户分别读取同租户的记录，核对冒带授权字段无写入。补量后的转正流程和首次 turn POST 响应丢失后的对账由后续切片处理。

## 首次 turn POST 丢响应后的对账

- [x] 按用户确认先加实际 router/runner 负例，让 runner 接单且 FakeVendor 已收到请求。丢弃首次 202 正文，确认既有实现保留回执但无法绑定原 turn。
- [x] 复用 SQLite 写在派发前的操作键。可信 HTTP 适配器同时在请求幂等键和 turn metadata 携带该值，重启后只读原专用会话。唯一候选必须属同一会话并匹配操作键。绑定通过条件更新，重复确认同一 turn 可复用。
- [x] 对账不可用、查无、候选错误、歧义及不完整时保留待核。使用新的 Node 调用进程查回原回执和原 turn，完成后从同一 turn 回读最终项。 [验收记录](verification.md)
