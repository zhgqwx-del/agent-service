# agent-service 协作约定

## 开始前先读

1. `README.md`：运行方式、API 和当前里程碑摘要。
2. `docs/PROGRESS.md`：顶部当前快照和最后一节是进度事实来源。
3. `docs/design/00-architecture.md`：架构基线与 M0–M4 定义。
4. `docs/operations/local-and-deployment.md`：本地生命周期和未来部署契约。
5. `docs/design/04-data-lifecycle.md`：删除、归档、usage 与 Blob 生命周期的当前设计门禁。

`docs/review/` 与 `docs/research/` 是时间点快照；其中的旧测试数量、缺陷和“下一步”不能覆盖 `docs/PROGRESS.md` 的最新结论。

## 当前阶段

- M0 完成。
- M1 核心运行范围、OpenAPI 3.1 与生成 TypeScript SDK 已完成；完整数据生命周期仍未闭环。
- M2 的本地/CI 代码范围已完成并正式冻结；尚未正式进入 M3，云上部署不属于本次冻结范围。
- M3 的 MCP/skills/hooks 主体和 M4 的生产化主体尚未开始。
- session 创建与首条事件原子化、`0007 -> 0008 -> 0009 -> 0010 -> 0011` 历史升级夹具、OpenAPI/SDK、可逆 Archive v2、fenced tombstone、reliable terminal-event outbox dispatcher、Blob ownership/业务接线与 staging orphan 清理已收口。默认关闭的 user erasure durable gate/request/status，以及 usage operational/billing 双写、legacy reconcile 和显式 anonymize primitive 已实现；异步 export artifact/TTL、erasure worker 状态推进、tenant erasure/key revocation、legacy generation `0` 补偿和默认关闭的 ready/session purge 仍未完成。M1 尚未闭环，完成后再正式进入 M3。
- `DATA_ERASURE_REQUESTS_ENABLED` 在 runner/router 均默认 `0`；当前只允许 admin service key 为明确 user 发起带 `Idempotency-Key` 的请求，且状态只到 `gated`。POST 需要 router writer gate、全部 configured targets 均健康且声明 capability，以及 selected target capability；status GET 不依赖 router writer gate，但仍要求当前 healthy fleet 与 selected target capability，healthy mixed fleet 必须 fail-closed。writer gate 开启时，每次 user-scoped runtime 转发还会复核 selected target capability。任一 erasure request 首次成功接受后，关闭 router writer gate 只能阻止新请求，不能撤销 durable subject gate，也不能安全回退到 pre-`0011`/lifecycle-unaware runner；必须保持 capable fleet 并 forward-fix，紧急旧版恢复前先在 edge 阻断受影响 subject，无法精确阻断时阻断全部 user-scoped runtime 流量。不得把 durable gate 描述为擦除完成，也不得擅自开放 tenant erasure 或不可逆 purge。
- erasure POST/status 的所有成功与错误响应必须保持 `Cache-Control: no-store`；usage 的公开 `costCNY` 只表示完整总成本，mixed known/unknown 不得返回已知小计，硬成本上限不得把 unknown 当作 `0`。已完成的 anonymize 重试可在后来出现 legal hold 时幂等返回，但 hold 必须阻止尚未发生的 `verified -> anonymized` 转换。
- 长期 billing fact 不得保留 user/session/turn/step/raw JSON 或精确请求/reconcile 时间；精确验证时间只属于 owner-scoped reconciliation。usage row 与 session owner 不一致必须在查询中隐藏、在 reconcile/anonymize 中事务性 fail-closed，不能静默漏账或跨 tenant 聚合。
- `gated` 只隐藏该 subject 的 session/turn/item/approval/usage/receipt/Blob 普通读取并阻止对应 durable 写入；tenant-scoped agents/provider/auth/api-key 等资源不属于这个 user gate。它尚不主动关闭既有 SSE，也不跨 runner abort/drain active provider/tool 执行。该 gate 只能在本地对可丢弃 user 显式体验，完成可靠 drain/worker 前不得在 staging/production 激活。stage→object put→mark 与 gate 并发时允许产生不可读的 staging orphan，必须由 TTL cleanup 回收。
- tombstone 已原子写入 marker、terminal `session/deleted`、单调 generation、即时 `session.tombstoned` intent 和不可领取的 `session.purge` intent；普通资源隐藏且 parent/child 竞态受保护。每个 runner 内置的 dispatcher 只处理 `session.tombstoned`，通过 claim lease/CAS 和有上限退避按 at-least-once 语义投递；短暂故障无限重试，确定损坏的 intent 才 dead-letter，event `seq` 是重复身份。它不会领取或执行物理 purge。
- tombstone 保持在 protocol family `2026-10-08` 内，以 additive capability 协商。router 还要求显式 `SESSION_TOMBSTONE_ENABLED=1` 和全部健康 runner 支持该 capability；外部 DELETE 只会改写为带内部 token、要求 ACK 的版本化 runner-only POST，不会回退到旧公开 DELETE。`RUNNERS` 必须使用实例稳定地址。发布前先由 edge 暂停精确 session DELETE（或整体切换 router 池），再按新 router（gate=0）→ 排空旧 router → 滚动新 runner → 核对 fleet → 激活 gate 的顺序执行，旧 router 自身没有该 gate。未来真正不兼容的 protocol 变更仍需维护窗口或整组 blue-green。
- BlobStore 的跨平台 key、防损坏单-envelope 原子发布、旧安全格式读取/删除、私有权限、静态 symlink 防护和 memory 复制语义已有测试。`0010`、Memory/MySQL ownership manifest、图片/大工具输出接线、staging→ready 原子绑定、独立 Blob outbox/worker、硬 TTL、并发 claim、key-scoped delete fence 和 stale staging 清理已实现；工具结果有独立持久化硬上限，序列化/超限/adapter 写失败在 current/replay 中使用同一无 locator 的稳定结果，单次请求共享完整 data URL 水合预算，compaction 不会跨过未物化的外置工具事实。历史图片像素目前不会跨 compaction 保留。ready/session purge 仍关闭。filesystem root 必须由单一 runner 独占并显式设置 `BLOB_FILESYSTEM_SINGLE_RUNNER=1`、不承诺断电持久性；production filesystem writer/cleanup 在共享对象存储适配器完成前均 fail-closed，不能宣称大输出最终删除已闭环。

## 工作边界

- 当前先保证本机和 CI 可重复运行。staging/production 的 Kubernetes、云资源和拓扑要等用户提供真实参数后再生成。
- 本机 `.env` 可用于用户明确允许的本地验证；不得提交、打印或写入文档/日志。
- 修改前检查工作树并保留用户已有改动。完成后按风险运行相应测试，并同步 `README.md` / `docs/PROGRESS.md`。

常用入口：

```bash
scripts/local-service.sh verify
pnpm check:api
pnpm check:sdk
pnpm test:migrations
pnpm test:usage-lifecycle-mysql
pnpm test:subject-lifecycle-mysql
scripts/local-service.sh verify-real
scripts/local-service.sh acceptance
```
