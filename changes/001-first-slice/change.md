# 首个记录助手夹具切片

- 变更 ID `001-first-slice`
- Mono 工单 `DIANDI-001`
- 范围 本人饮水保存、缺少用量时保留待补输入、离线投递与按需反馈
- 开发分支 `mono/DIANDI-001`
- 基线 `f98896a065ba22df077d62a7969444e7ec660b8e`

## 目标

用可重启的假 RecordService 证明一条已确认的本人饮水记录能保存一次并查回回执。正式条目、回执和 Outbox 同事务落盘。Memory 接收夹具独立模拟断线、受理、应用和响应丢失。

## 范围与决策

用户确认按先保存、再反馈、后接 Memory D1 的顺序实施。两轮均先写测试。保存夹具覆盖 Mono AC01、AC04、AC09、AC05，反馈切片覆盖 AC02、AC07 并回归默认仅保存。按需反馈在记录助手示例使用进程内 Harness 和 FakeVendor。真实产品和独立记忆服务的联调留待后续。 [规格](spec.md) · [实施方案](tasks.md)

开工基线与缓存的 `origin/main` 相同。本轮为本地切片交付，合入目标、远端刷新及同步随提交或 PR 范围确定。 [Git 工作方式](../../docs/stdd/git-workflow.md)

用户确认继续沿用假 RecordService 补 AC03，并记录 AC08 的双用户夹具结果。首次 turn POST 响应丢失后的对账另行推进。

## 角色交接

- 产品维护本页和[验收场景](spec.md)。
- 研发更新[方案与任务](tasks.md)。
- 测试维护[验收计划](test-plan.md)与[实际记录](verification.md)。
