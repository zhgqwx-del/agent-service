# CI-01 Docker 镜像摘要校验

- 变更 ID `002-ci-native-image-digest`
- 工作基线 `main / c71f6b8847cb1dd86117aa8f719b648dfaf2071b`
- 合入目标 `origin/main`
- 状态 已推送。Linux 原生配置通过，完整 CI 因后续门禁失败仍待验收。
- 确认依据 用户在本轮会话授权按诊断的最小方案单独修复 CI-01，并要求定向验证和复核。

## 目标与范围

Docker 29.4.2 的 containerd 镜像存储会用目标 manifest 摘要作为 `.Id`。原 runner 配置检查直接把它与 config pin 比较，导致 nginx 取证提前失败。修复集中在原 CI 步骤的摘要取证。镜像 pin、本地平台与 `RepoDigests` 校验、语法检查、原生进程与容器结清和制品门禁共同决定结果。 [原失败作业](https://github.com/zhgqwx-del/agent-service/actions/runs/44507127998/job/135501533641) · [CI 工作流](../../.github/workflows/ci.yml)

现有 CI 合同测试的两份 Linux native 摘要同步绑定复核后的工作流字节。原镜像合同、runtime 合同及其他门禁断言沿用既有冻结值。 [CI 合同测试](../../test/ci-required-jobs.test.ts)

CI-02～04 的定向复现证据独立于本变更。首个产品变更 `001-first-slice` 待选定。用户授权将 CI-01 单独提交并推送，正常触发既有 CI。 [首个产品变更](../001-first-slice/change.md) · [协作约定](../../AGENTS.md)

## 规范变更

| 需求 | 当前行为与目标行为 | 验收场景 |
| --- | --- | --- |
| `REQ-CIIMAGE-001` | 固定镜像引用已有 manifest 和 config pin。将 config 取证移到原始单平台 manifest 的 `config.digest`，并核原始字节。 | `AC-CIIMAGE-001`、`AC-CIIMAGE-002` |
| `REQ-CIIMAGE-002` | `.Id` 当前只接受 config。镜像内容验真后允许两种精确摘要形态，继续校验平台和 `RepoDigests`。 | `AC-CIIMAGE-003` |
| `REQ-CIIMAGE-003` | 保留 24 个原生命令和 5 个容器的成功及结清要求，新增两个具名的原始 manifest 读取及证据。 | `AC-CIIMAGE-004` |

完整约定和验证入口见 [规格](spec.md)、[实施任务](tasks.md)及[验收计划](test-plan.md)。

## 关联讨论与 ADR

用户在会话中确认先以原始 manifest 取证，再校验本地镜像身份。调整沿用现有 CI 门禁，原失败保留在 GitHub Actions 及其报告制品中。 [讨论与架构决策约定](../../docs/stdd/decisions-and-discussions.md) · [原失败作业](https://github.com/zhgqwx-del/agent-service/actions/runs/44507127998/job/135501533641) · [原生配置报告](https://github.com/zhgqwx-del/agent-service/actions/runs/44507127998/artifacts/14519777556)

## 依赖与发布

候选在现有 Linux amd64 runner 作业中使用已部署的 Docker 与 Buildx。完整原生通过须核验该环境的隔离 `HOME` 和 `DOCKER_CONFIG` 以及对应 run、attempt 和源码 SHA，结果记入[验收记录](verification.md)。 [开发与 CI 指南](../../docs/operations/development-and-ci-guide.md#8-github-actions-构建与验证)

原生门禁再次失败时，保留报告、命令输出和首次失败位置。若需后续前向修复，范围限已证实有问题的取证步骤及其合同测试，继续沿用既有门禁。 [实施任务](tasks.md) · [验收计划](test-plan.md)
