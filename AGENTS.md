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
- session 创建与首事件原子化、`0007 -> ... -> 0013` 历史升级夹具、OpenAPI/SDK、Archive/tombstone/outbox、Blob ownership/业务接线与 staging orphan 清理已收口。erasure admission 默认关闭；与 admission 独立的 worker 已能以 durable claim 跨 runner drain active execution、child-first tombstone，并在同一 usage 写事务重验完整 tombstone proof 后停在 `awaiting_purge_policy`。`0013` 已把确定性 claim-stage poison 按候选独立事务隔离：安全 envelope进入保留原 phase 的 repairable quarantine，控制事件append-only，repair/resume由generation + evidence CAS和固定action约束；若request/tenant/subject identity、generation或时间顺序本身损坏，则保留原字段和精确BIGINT fence、清除worker authority，并原子追加content-free `erasure_job_terminal_incidents`，不会猜测归属、阻塞邻居或开放通用repair。损坏control audit仍只能检查，不能由通用API伪装修复。异步 export artifact/TTL、tenant erasure/key revocation、legacy generation `0` 补偿、canonical policy/legal-hold 管理、默认关闭的 ready/session purge、完成证明与 restore replay仍未完成。M1 尚未闭环，完成后再正式进入 M3。
- `DATA_ERASURE_REQUESTS_ENABLED` 在 runner/router 默认 `0`，只控制新 request admission；`ERASURE_WORKER_ENABLED` 与它独立，本地默认 `1`，使已持久化 job 即使关闭 admission 也继续走到安全策略边界。POST 需要 router gate、全部 configured targets 健康且支持；status GET 不依赖 router writer gate，但仍按 healthy fleet/selected target capability fail-closed。任一 request 首次接受后，关闭 gate 不能撤销 durable subject gate，也不能回退到 pre-`0011`/lifecycle-unaware runner；必须 forward-fix。不得把 `awaiting_purge_policy` 描述为擦除完成，也不得擅自启用 tenant erasure、usage anonymize 或不可逆 purge。
- erasure POST/status 的所有成功与错误响应必须保持 `Cache-Control: no-store`；usage 的公开 `costCNY` 只表示完整总成本，mixed known/unknown 不得返回已知小计，硬成本上限不得把 unknown 当作 `0`。已完成的 anonymize 重试可在后来出现 legal hold 时幂等返回，但 hold 必须阻止尚未发生的 `verified -> anonymized` 转换。
- 长期 billing fact 不得保留 user/session/turn/step/raw JSON 或精确请求/reconcile 时间；精确验证时间只属于 owner-scoped reconciliation。usage row 与 session owner 不一致必须在查询中隐藏、在 reconcile/anonymize 中事务性 fail-closed，不能静默漏账或跨 tenant 聚合。
- `gated` 隐藏该 subject 的普通资源并阻止 durable 写入；worker 的 draining/tombstoning 使用 claim-bound 私有 `drain-v1` 路径和固定 store actions，不可携带正文、usage 或任意 patch。active provider/tool 会被有界 abort；超时后保留 session lease 到期而非立即与新 owner 重叠。成功后现有 SSE 通过 terminal event 收口，但内容、ready Blob、receipt 和 operational usage 仍保留到后续 policy-gated purge。当前只在本地对可丢弃 user 显式体验，staging/production 保持 admission 关闭。
- `0013` quarantine 不等于普通 `blocked`：安全envelope的公开status只映射为`blocked`，不能泄露reason/evidence/control generation；运维必须经独立maintenance store检查，并只执行返回的固定action。unsafe-envelope terminal incident没有owner推断、公开读取或repair权限。`control_audit_invalid` 没有自动 repair action，不能直接改表、补造主 audit 或把任意 hash 当成验证证明。control generation 达到或超过 JS safe-integer 上限时会保留原始 MySQL BIGINT fence、清除 worker authority并进入无 repair、无后继 control-event 槽位的 terminal quarantine；这是 fence 耗尽/库级损坏的显式例外，不能回退或归一化原值。任何 control event或terminal incident写入后都不得回退到 pre-`0013` reader/worker，只能 forward-fix。
- 新 erasure worker 每次 claim 前都要从 router 的私有、token-protected barrier获得固定 ACK；router 必须先在本进程成功观察 `RUNNERS` 中每个稳定地址支持 `erasureJobControl=quarantine-v1`。观察后纯网络不可达会保留进程内 attestation 以允许接管已死亡 owner；明确旧版/错误协议/畸形 capability会撤销。router重启会丢失该内存 attestation并安全暂停 claim，直至地址恢复或从配置移除。公开 router capabilities 故意不暴露此 rollout 状态；新 request admission 仍另外要求 configured fleet 当前全部健康。
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
pnpm test:erasure-job-mysql
pnpm test:erasure-session-mysql
pnpm test:erasure-catalog-mysql
pnpm test:erasure-usage-mysql
scripts/local-service.sh verify-real
scripts/local-service.sh acceptance
```
