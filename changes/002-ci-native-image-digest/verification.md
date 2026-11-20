# CI-01 Docker 镜像摘要校验验收记录

## 修改前证据

`c71f6b8847cb1dd86117aa8f719b648dfaf2071b` 在 GitHub run `44507127998` attempt 1 失败。原始 nginx `inspect` 输出回放到旧工作流的镜像判断，得到 `image-platform-or-config-mismatch`。新主机未持有原本机证据，原验收未独立复核。该回放使用本次 GitHub 运行的失败制品。 [原失败作业](https://github.com/zhgqwx-del/agent-service/actions/runs/44507127998/job/135501533641) · [报告制品](https://github.com/zhgqwx-del/agent-service/actions/runs/44507127998/artifacts/14519777556)

## 受测候选

用户在本轮会话确认按诊断中的最小方案修 CI-01。本机在 `main` 的 `c71f6b8` 工作树测试未提交候选，使用 Darwin arm64、Node 24.21.0、pnpm 12.5.1、Vitest 4.1.11。 [变更范围](change.md) · [验收计划](test-plan.md)

| 文件 | 受测字节 SHA-256 |
| --- | --- |
| [CI 工作流](../../.github/workflows/ci.yml) | `1b0340ace8e3dd536a46ea008a7fe1214a8b53a3c2126ba4f6e6e7c21eff6105` |
| [CI 合同测试](../../test/ci-required-jobs.test.ts) | `21df72b86795cbe248afd30297e3e72b36182a43b217c31d2345c1f7a1a94af0` |

## 定向结果

| 场景 | 实际验证 | 结果 |
| --- | --- | --- |
| `AC-CIIMAGE-001` | Docker Hub 只读获取 nginx 和 promtool 的固定 manifest 原始字节。两份原始 SHA-256 及 JSON 的 `config.digest` 均与工作流 pin 一致。将原字节送入候选的镜像判断。 | 通过。nginx 为 OCI 单平台 manifest，promtool 为 Docker V2 单平台 manifest。 |
| `AC-CIIMAGE-002`、`003` | 解析并编译实际工作流 Python，提取并执行其镜像检查循环。用原 nginx `inspect` 证据及封闭对照输入验证两种 `.Id`。逐项检验错误字节、config pin、索引、缺少 config、非法 JSON、原生读取错误、平台、未知 `.Id` 及错误或畸形 `RepoDigests`。 | 两种 `.Id` 形态通过。10 项负例全部拒绝。检查循环按顺序调用两组 pull、原始 manifest 读取和 inspect。 |
| `AC-CIIMAGE-004` 本地合同 | `node scripts/run-required-suite.mjs test/ci-required-jobs.test.ts`。stdout 和 Vitest JSON 均为 233 通过、0 失败、0 跳过。独立复核确认仅更新被本次改动影响的两枚 Linux native 合同摘要，原 image、runtime 和 AOF 约束继续由既有测试核对。 | 通过。 |
| `AC-CIIMAGE-004` Linux 原生 | 实际 Linux amd64 runner、隔离 Docker/Buildx 配置、26 个原生命令、5 个容器及后续门禁。 | 待验。本机缺少 Docker 和 Linux runner，保留原失败。 |

`pnpm typecheck` 和 `git diff --check` 均通过。独立只读复核未发现候选的摘要绑定、平台校验或原门禁范围存在待改问题。定向回放、注册表原字节与测试报告作为本机私有证据保留。
