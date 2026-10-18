# 轻池 task / subagent：根租约、真实子会话与共享预算

状态：2026-10-18 已实现并完成本地分段收口，发布仍待最终同SHA完整CI。真实Pi/HTTP工具、MySQL事务/账单冷读和root-owner SIGKILL接管已有实际证据，不能用单项或上一包CI代替整包验收。本文补齐架构 §13 原有引用；精确源身份、原失败及最新事实见 [PROGRESS](../PROGRESS.md) 顶部与末节。

## 1. 用户确认与权限边界

- 子 agent 可选择**显式白名单中的同租户代理**，目标绑定不可变 `agentId@version`，由模型选择配置标签，不接收工具参数里的 tenant/user、凭据、endpoint 或动态模块。
- 默认仅传任务 prompt；需要的背景由父 agent 明确写入。不得隐式复制父历史、system prompt、provider/OAuth 配置或密钥。本包只接受 `context:"prompt"`，不在配置中假称已支持历史复制；以后若增加其它模式，须另有显式不可变配置与来源/预算证明。
- 同 agent 也须显式 `allowSelf:true`；空白名单且未允许 self 的策略无效。`task` 必须显式挂载，策略存在不等于进程/全 fleet gate 已开启。
- 子会话 owner 永远是父会话实际 owner，而不是代建请求的管理员身份。子工具授权取父当前有效能力与目标 agent 能力的交集，不能靠同名工具跨 scope/config/revision 取得更多权限。
- 不复制父 session 的 `autoApprovedTools`。子调用仍执行真实 middleware、tenant observer、mandatory approval、SSRF、schema 和结果持久化链；任务本身的批准不替代子工具批准。

## 2. 唯一根租约与根寻址控制

一期同 runner、同**根 session lease**。普通 `createSession(parentSessionId)` 只代表内容关系，不是受管委托能力；不能通过再调用普通 `startTurn(child)` 获得一把独立子租约，冒称符合该设计。

| 事实 | 权威位置 | 使用方式 |
| --- | --- | --- |
| 根执行所有权 | 现有 Redis root lease + MySQL root fence | 只有根拥有者可派发/提交整个执行树 |
| task 与子执行身份 | 独立受管任务账本 | 绑定真实 root/parent turn、实际 started call item、child session/turn 与目标版本 |
| 用户控制路径 | `/v1/sessions/:rootId/subagents/:taskId/...` | router 按现有 root owner 路由，runner 再认证 task→child 映射 |
| 子内容与事件 | 子 session 的真实 items/turns/events | 保留子自己的 seq，不拼进父 seq 空间 |
| 父活动投影 | 父 session 的 `subagentActivity` item | 关联子内容与根寻址控制，不代替真实执行 |

根寻址控制包括任务状态、子审批决策、动态工具结果及子任务中断。router 不因此访问 MySQL、不增加 child Redis alias 或新的 Redis 生命周期域。失去根 owner 时只能走已有接管/恢复协议，不能将控制请求随机发到另一 runner 后重新 spawn。

受管 child 的普通 start/steer/approval/result/interrupt/archive/delete 等写入口拒绝；只读内容仍按原 owner 校验。控制请求必须同时匹配 actual owner、root/task/child、当前 root turn 和根 fence，不能只验证一个可猜的 task ID。

## 3. 原子委托与存储锁序

根 turn 注册受管执行控制与原始 `turn/started` 在同一业务事务中。创建 task 时必须核对已经持久化、确实 started 的父 `task` 调用；以实际 call item ID 去重，跨 step 重用模型 toolCallId 不能合并成一次任务。

同一个 Memory 原子发布/MySQL 事务完成：

1. 预留 family 准入与 task 身份。
2. 创建真实 child session 和 `session/created(seq=1)`。
3. 预留真实 child 首 turn 与输入，不另走普通 child lease/普通 begin。
4. 封存父调用→child 的不可变映射，并写父 activity 投影。

事务失败不能留下半个 child、孤立首 turn、预算扣减或无来源 activity。响应丢失只可 exact identity 查询/重放已提交事实，不重新派发 child/provider/tool。

后续 child COMMIT 与根普通业务 COMMIT 都必须在数据库内核验受管 root 控制，复用正式 item/event/blob/usage/webhook 验证，不能绕开原 store 另写一套宽松持久化。锁序固定 root session → root turn control → 祖先 parent sessions（根到叶）→ child session → task/budget；不得先锁 child 再反向锁 root。普通旧写路径在受管 footprint 下必须拒绝，不因 gate 关闭而退回无根证明的写法。

新表/guard 与严格启动指纹属于前向迁移范围：全旧 writer/事务先排空，再独立迁移，仅运行新版本并 forward-fix；不操作现业务库、不热混跑或删除 marker。

启用前还须升级公开SDK/严格事件消费者：新增`subagentActivity`、lifecycle事件及参数变更事件不保证旧的闭合union解析器可读。旧JSON字段可读、旧SDK编译成功或public capability可见均不等于新功能兼容；不能混合旧runner提供部分执行后宣称全fleet通过。私有nonce只证明全部配置的稳定runner URL及内部token信任下的当前实例，不能把一个负载均衡URL当成其背后所有未逐项配置的pod证明。

## 4. 共享准入、成本与唯一计费

固定代理里的配置 `ModelRef` 与 ProviderService 解析后的运行时 provider 身份不是同一名称空间（例如 `deepseek` 与 `platform:deepseek`）。前者用于不可变目标版本授权，后者绑定真实初始 turn 和每次实际模型派发/usage；分别校验、分别保存，不拆字符串猜映射，也不能为通过测试把真实解析器换成同名 fake。可信平台 model middleware 仍须重新解析每一步，不能以任务正文提供 provider、凭据或路由授权。

family 共享 depth、同时在途数、task 总数、provider step、tool-call、根 deadline 和成本阈值。有效限制取 runtime hard ceiling、根 agent/request、各子策略的最小值，子任务不能重置总计数或延长根期限。

每次真实 provider/tool 派发先领取唯一持久准入；每个真实 provider step 的 usage 与原业务 COMMIT、子账单事实和 family 非计费投影原子结算。child 的真实 ledger/billing 只写一次；不能把 child usage 再作为父 provider step 插入第二份账单。父 session/turn 的自身 usage 语义保持，family 汇总单独命名，不伪装成父模型请求。

成本沿用现有“响应后核算并停止后续准入”的内核语义，而不是未经证明的硬金融预授权。达到阈值或成本未知后关闭新的模型/工具准入；有限并发中已经派发的请求仍须记录实际 usage，因此可能有有界在途超支。unknown reservation 不退款、不解释成零费用。若以后提供最坏成本硬预留，需要独立可信价格与输入计量合同，不能靠估算自称已经实现。

## 5. 生命周期、取消与恢复

`SubagentStart` 只关联真实 child 首 turn 已提交事实，`SubagentStop` 只关联其真实终态；普通 parentSessionId 或手工发一个事件不构成 producer。child `SessionStart` 观察使用根 authority，不获取独立 child lease。

根 Interrupt、T1/fence、硬期限和关服先关闭全树准入、取消待决审批并 abort 底层实际操作，再等待 child/provider/MCP/webhook 与不可取消授权读取真正 settle。不能用 Promise race 假称排空，不能在子 I/O 仍在运行时释放根 runtime/lease。

SIGKILL 后不自动重新 spawn 已 started 的任务。恢复逐条区分未派发、已完成和 `outcome_unknown`，保留真实 child 内容、已提交账单及未知 reservation；未知副作用不得自动重试。已由更高根 fence 接管后，旧 root/child 即使收到迟到 allow、结果或 ACK，也不能再提交业务结果或恢复授权。

活动、hook 与 middleware 报告都是事实/观察，不是任意执行或删除授权。新增任务/预算 footprint 必须进入现有 lifecycle inventory，或在尚未覆盖时明确阻断 T3c/T3d/T3f；不能遗漏新域后声称擦除完成。

## 6. 真实验收矩阵

正式验收至少包括：Memory 与真实 MySQL 的原子成功/序列化失败/回滚/并发；root fence 取代后的旧 child 拒写；跨 owner/tenant 拒绝；白名单与权限交集；实际 Pi 父→子→MCP→父后继 step；子审批/动态结果经 root 控制路由；共享预算和唯一计费；取消树真实排空；双 runner OS SIGKILL 后未知副作用不重放；冷读、SSE 回放与 compaction 保留真实关联。

纯协议、配置、callback 计数或 required manifest 登记均不能替代这些证明。完整功能包冻结后一次 coherent 门禁及最终 exact-SHA CI，不为每个小修改重复长矩阵。M1 未冻结、M2 冻结、完整 M3/M4/P2 与生产验收仍未完成。
