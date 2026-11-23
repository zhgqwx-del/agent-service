# CI-01 Docker 镜像摘要校验验收记录

## 修改前证据

`c71f6b8847cb1dd86117aa8f719b648dfaf2071b` 在 GitHub run `44507127998` attempt 1 失败。原始 nginx `inspect` 输出回放到旧工作流的镜像判断，得到 `image-platform-or-config-mismatch`。新主机未持有原本机证据，原验收未独立复核。该回放使用本次 GitHub 运行的失败制品。 [原失败作业](https://github.com/zhgqwx-del/agent-service/actions/runs/44507127998/job/135501533641) · [报告制品](https://github.com/zhgqwx-del/agent-service/actions/runs/44507127998/artifacts/14519777556)

## 受测候选

用户在本轮会话确认按诊断中的最小方案修 CI-01。本机在 `main` 的 `c71f6b8` 工作树测试未提交候选，使用 Darwin arm64、Node 24.21.0、pnpm 12.5.1、Vitest 4.1.11。 [变更范围](change.md) · [验收计划](test-plan.md)

| 文件 | 受测字节 SHA-256 |
| --- | --- |
| [CI 工作流](../../.github/workflows/ci.yml) | `1b0340ace8e3dd536a46ea008a7fe1214a8b53a3c2126ba4f6e6e7c21eff6105` |
| [CI 合同测试](../../test/ci-required-jobs.test.ts) | `21df72b86795cbe248afd30297e3e72b36182a43b217c31d2345c1f7a1a94af0` |

## 提交前定向结果

| 场景 | 实际验证 | 结果 |
| --- | --- | --- |
| `AC-CIIMAGE-001` | Docker Hub 只读获取 nginx 和 promtool 的固定 manifest 原始字节。两份原始 SHA-256 及 JSON 的 `config.digest` 均与工作流 pin 一致。将原字节送入候选的镜像判断。 | 通过。nginx 为 OCI 单平台 manifest，promtool 为 Docker V2 单平台 manifest。 |
| `AC-CIIMAGE-002`、`003` | 解析并编译实际工作流 Python，提取并执行其镜像检查循环。用原 nginx `inspect` 证据及封闭对照输入验证两种 `.Id`。逐项检验错误字节、config pin、索引、缺少 config、非法 JSON、原生读取错误、平台、未知 `.Id` 及错误或畸形 `RepoDigests`。 | 两种 `.Id` 形态通过。10 项负例全部拒绝。检查循环按顺序调用两组 pull、原始 manifest 读取和 inspect。 |
| `AC-CIIMAGE-004` 本地合同 | `node scripts/run-required-suite.mjs test/ci-required-jobs.test.ts`。stdout 和 Vitest JSON 均为 233 通过、0 失败、0 跳过。独立复核确认仅更新被本次改动影响的两枚 Linux native 合同摘要，原 image、runtime 和 AOF 约束继续由既有测试核对。 | 通过。 |
| `AC-CIIMAGE-004` Linux 原生 | 实际 Linux amd64 runner、隔离 Docker/Buildx 配置、26 个原生命令、5 个容器及后续门禁。 | 待验。本机缺少 Docker 和 Linux runner，保留原失败。 |

`pnpm typecheck` 和 `git diff --check` 均通过。独立只读复核未发现候选的摘要绑定、平台校验或原门禁范围存在待改问题。定向回放、注册表原字节与测试报告作为本机私有证据保留。

## 最终提交的 Linux 原生门禁

实际受测提交为 `166be40f63f6345087924ec3d03b1be486f249c3`，由 `main` 推送触发 run `44649511798` attempt 1。提交前复跑两种 `.Id`、10 项负例、233 项合同测试及 `pnpm typecheck`，均通过。 [本次 CI](https://github.com/zhgqwx-del/agent-service/actions/runs/44649511798/attempts/1)

`AC-CIIMAGE-004` 的 Linux 原生配置步骤通过。Ubuntu 26.04.1 x86_64，Docker 客户端与服务端均为 29.4.2，作业日志报告 Buildx v0.39.0。两次 Buildx `--raw` 均退出 0。nginx 和 promtool 的原始 manifest SHA-256 及 `config.digest` 与提交中的 pin 一致，本地 `inspect` 均返回 manifest 型 `.Id`，平台和 `RepoDigests` 检查通过。核对了 systemd、nginx 和 Prometheus 语法步骤、全部 26 个具名命令的退出码与原生进程结清，以及 5 个容器的关闭证明。 [runner 作业](https://github.com/zhgqwx-del/agent-service/actions/runs/44649511798/job/136000566877) · [原生配置制品](https://github.com/zhgqwx-del/agent-service/actions/runs/44649511798/artifacts/14590246095)

制品内容、工作流源字节及日志中的摘要已交叉核对。`report.json` SHA-256 为 `bba6d92e5fde9737e4d8346112af8894d737619eab4209a3751e0822b0d8e569`，`artifact-manifest.json` SHA-256 为 `977a4b42446f48bc01fe7e91ba0b75940c5ea458859740fbd45a825574917e98`。

## 后续门禁

同一 runner 作业的第 11 步 Redis ACL/AOF 两次原生冷启失败，后续 one-shot CLI、schema 准备和镜像运行步骤跳过。公开日志只记录退出码 `1`，没有首次拒绝码，也没有已合并的 Redis AOF 证据。与 `c71f6b8` 对比，该 AOF 步骤字节相同。静态核对发现其 `source_path_count` 仍固定为 1124，而 `c71f6b8` 和本提交分别有 1211、1217 个受跟踪文件。后续导出还固定原来 24 个命令和 49 条清单记录，本次已核制品为 26 个命令、53 条记录。这些固定值冲突可独立确认，作业首次拒绝的私有诊断未取得。 [runner 作业](https://github.com/zhgqwx-del/agent-service/actions/runs/44649511798/job/136000566877) · [AOF 步骤](https://github.com/zhgqwx-del/agent-service/blob/166be40f63f6345087924ec3d03b1be486f249c3/.github/workflows/ci.yml#L1052-L1097)

本次 CI 已结束，13 个作业中 8 个通过、5 个失败。两个直接失败为 `image (agent-runner)` 的 Redis ACL/AOF 步骤和 `test-main (3)` 中另一个 `0055` 跨租户 NULL-identity 用例的 30 秒超时。`test-main-merge` 在覆盖率合并前停止，`test-core` 与最终 `test` 随依赖失败。CI-02～04 的原失败用例本次均通过。CI-01 的 Linux 原生配置门禁已验证，完整 CI 验收继续待定。 [第 3 分片报告](https://github.com/zhgqwx-del/agent-service/actions/runs/44649511798/artifacts/14593924048) · [最终必跑检查](https://github.com/zhgqwx-del/agent-service/actions/runs/44649511798/job/136032872562)

后续 `f4aa21d` 已验证 Redis ACL/AOF 冷启门禁，原 `0055` 用例也通过。两次 CI 各自保留原运行身份与结果。 [003 验收记录](../003-ci-redis-aof/verification.md)
