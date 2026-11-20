# Redis ACL/AOF 冷启 CI 门禁验收记录

基线为 `166be40f63f6345087924ec3d03b1be486f249c3`。用户确认按最小方案修复，定向检查使用未提交候选。新主机未持有原本机证据，原验收未独立复核。 [规格](spec.md) · [原失败作业](https://github.com/zhgqwx-del/agent-service/actions/runs/44649511798/job/136000566877)

| 受测文件 | SHA-256 |
| --- | --- |
| `.github/workflows/ci.yml` | `efa1b6befed889c2c6c2bdeb0389ee26dfd3546f8922efb83c1542c8b05f2e87` |
| `test/ci-required-jobs.test.ts` | `345605da3b9fd0b5a97fc86af22dfc59c48da141ebface095d6086a6da1cc5da` |
| 解包 Python 入口 | `f5b9f310569bbf01357f3a6da6e2747b96f9924190561f181feaf271e8387fd4` |
| 解包 Node 驱动 | `58af256e802c7ae1c4f5285c0a9e16bb6d1288a845677ad3be3ab0df721a4bcd` |

## 定向结果

| 需求和场景 | 执行及结果 |
| --- | --- |
| `REQ-CIAOF-001`、`AC-CIAOF-001` | 运行工作流的两个 payload 写入段及解包校验段，核对提取源码和 pin。以基线的实际 Git 树、独立 Git 索引和归档文件回放，旧规则拒绝 1217 项，候选通过。入口 6 项负例和 Node 3 项负例全部拒绝，覆盖精确集合、类型、模式、字节、顺序及条目数。 |
| `REQ-CIAOF-002`、`AC-CIAOF-002` 制品 | 用 run `44649511798` attempt 1 的 Linux 原始配置 ZIP 回放。旧导出拒绝 53 条记录，候选验证 26 条命令和 5 个容器。15 项证据负例全部拒绝。单独回放发布与回读，用 5 份受控 AOF 样本生成 58 条清单、59 个文件，保留 53 份原始文件的字节。公开失败摘要拒绝输出未知错误文本。 |
| `REQ-CIAOF-002`、`AC-CIAOF-002` 本机原生冷启 | 在独立 Darwin arm64 目录校验并构建官方 Redis 8.4.7，复用现有锁文件安装的依赖。使用当前候选 Node 驱动和基线归档的 1217 个源码输入，实际执行 ACL 检查、seed、两次冷启及结清。退出 0，三个阶段的进程组均结清，源码根前后一致，真实 provider 调用为 0。 |
| CI 合同和类型 | `node scripts/run-required-suite.mjs test/ci-required-jobs.test.ts` 通过 233 项且零跳过。`pnpm typecheck` 与 `git diff --check` 均通过。 |

## 复核与待验

只读复核从工作流重新解包，确认本轮代码差异限于 AOF payload、对应校验 pin 和两枚合同摘要。CI-01 生产样例步骤、固定 Redis 源包和构建参数、Node 内部 ACL/冷启断言、后续 runner 镜像步骤以及 `0055` 源码和用例与基线一致。

最终 Linux amd64 入口与完整合并验收仍待执行。本机没有 Linux amd64 Docker runner。额外使用 Darwin 原生报告回放完整导出时，原有安全整数检查拒绝本机 `ps`、`lsof` 的 inode 值。保留该结果和原检查。分开的本机冷启、Linux 上游制品和发布回放分别记录各自的环境。 [现有验收入口](../../.github/workflows/ci.yml) · [原失败作业](https://github.com/zhgqwx-del/agent-service/actions/runs/44649511798/job/136000566877) · [原生配置制品](https://github.com/zhgqwx-del/agent-service/actions/runs/44649511798/artifacts/14590246095)
