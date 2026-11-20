# CI-01 Docker 镜像摘要校验验收计划

## 验证范围

目标是核对两个固定镜像的原始 manifest 和 config、两种本地 `.Id` 形态，以及原生配置门禁的完整执行。复用[已确认规格](spec.md)和[原 CI 作业报告](https://github.com/zhgqwx-del/agent-service/actions/runs/44507127998/artifacts/14519777556)。

## 用例和入口

| 场景 ID | 测试层或方式 | 初始数据与操作 | 预期与证据出口 |
| --- | --- | --- | --- |
| `AC-CIIMAGE-001` | 注册表证据与工作流 Python 定向 | 只读访问两个固定引用，核对原始 manifest 字节和 config，通过原生门禁的相同摘要判定。 | 两组固定摘要均与现有 pin 相同。保存实际输入摘要与定向结果。 |
| `AC-CIIMAGE-002` | 工作流 Python 定向负例 | 改动样本原始字节或 config，提供无法解析的内容、索引或无效 config，并模拟 Buildx 读取失败。 | 每个入口均给出失败，记录实际命中的判定。 |
| `AC-CIIMAGE-003` | 旧报告回放与工作流 Python 定向 | 用原 nginx 的 manifest 型 `.Id` 和 config 型对照。单独改变本地 `.Id`、平台与 `RepoDigests` 做负例。 | 旧实现拒绝 manifest 型。候选接受两种已验真的精确形态，拒绝每项不匹配。 |
| `AC-CIIMAGE-004` | CI 合同测试与 Linux amd64 原生作业 | 由 root 运行 `node scripts/run-required-suite.mjs test/ci-required-jobs.test.ts`，并在后续获授权的 `image (agent-runner)` 作业中检查两个固定引用、Buildx 隔离配置和后续语法检查。 | 合同测试核验复核后的两份 Linux native 摘要及原有约束。原生报告含原有 24 个命令、`nginx-manifest`、`promtool-manifest` 和 5 个已结清容器。 |

## 环境和风险

本机定向检查可从实际 CI 步骤提取 Python 源码，核对语法、镜像判定和命令边界。完整原生用例需要 Linux amd64 的 Docker、Buildx 与两个固定镜像，并在步骤自己的私有 `HOME` 和 `DOCKER_CONFIG` 下运行。失败记录绑定观察版本，完整验收仍以正常作业及最终 SHA 的 CI 为准。 [CI 工作流](../../.github/workflows/ci.yml) · [验收记录](verification.md)
