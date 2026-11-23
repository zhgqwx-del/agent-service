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

提交前的 Darwin 完整导出回放中，原有安全整数检查拒绝本机 `ps`、`lsof` 的 inode 值。保留该结果和原检查。 [现有验收入口](../../.github/workflows/ci.yml) · [原失败作业](https://github.com/zhgqwx-del/agent-service/actions/runs/44649511798/job/136000566877) · [原生配置制品](https://github.com/zhgqwx-del/agent-service/actions/runs/44649511798/artifacts/14590246095)

## 最终提交的 Linux amd64 作业

正常推送 `f4aa21d02d305d95fc2c52a2ef7a4ee8cbbbd404` 触发 run `44677586590` attempt 1。`image (agent-runner)` 全作业通过，包括原生配置、Redis ACL/AOF、制品保存及后续镜像检查。 [runner 作业](https://github.com/zhgqwx-del/agent-service/actions/runs/44677586590/job/136093000897)

- `AC-CIAOF-001` 以受测提交逐项核对冻结清单的 1223 个路径、执行模式及 blob 字节。源码根 `73a24caa2421019ed4f26145d356bc4aa6cc582adbaba57de8a0ea68672dd83a` 与运行前后见证一致。
- `AC-CIAOF-002` Redis 8.4.7 官网源包、构建和驱动调用收据已核对。seed、第一次冷启及第二次冷启分别有独立进程运行身份，各有 27 个 ACL 允许判定、14 个精确 dry-run 拒绝、2 个实际无害拒绝。三段原生退出均为 0、无信号，进程组结清，loader 无错误。两次冷启的原始及后续流条目和绝对过期时间已与基线核对。
- 合并 ZIP 核对 run、attempt、SHA 和日志摘要。原生配置的 26 个命令、5 个容器以及 53 个原始文件均有对应证据。新增 5 个 AOF 文件，清单 58 条，含清单共 59 个文件。合并清单 SHA-256 为 `3390068d000173ab41f3e81d843d032ba34695d379369e66c24ed2b95a02de21`，Redis 报告 SHA-256 为 `57ea5ee741dcf366a2f7a9fb4b09f02679ca09b7b1ec07d62d5958eca5df385f`。 [合并制品](https://github.com/zhgqwx-del/agent-service/actions/runs/44677586590/artifacts/14603370636)

## 完整 CI 结算

同次运行 13 个作业全部结算，9 个通过、4 个失败。唯一直接失败是 `test-main (3)` 的 `session-authority.mysql.test.ts:307` 用例 `destroys and never releases a real uncommitted transaction after rollback rejects without sending ROLLBACK`，约 30.115 秒，触发原 30 秒期限。`test-main-merge` 在覆盖率合并前停止，`test-core` 和最终 `test` 随依赖失败。第三分片日志、原始报告和聚合日志已保存。 [第 3 分片日志](https://github.com/zhgqwx-del/agent-service/actions/runs/44677586590/job/136093001107) · [最终必跑检查](https://github.com/zhgqwx-del/agent-service/actions/runs/44677586590/job/136123259688)

同分片原 `0055` 跨租户 NULL-identity 用例在原始 Vitest 报告中通过，耗时约 24.39 秒。保留既有失败记录。完整 CI 验收待定，session authority 超时已单独记录诊断和同环境复现入口。 [第 3 分片制品](https://github.com/zhgqwx-del/agent-service/actions/runs/44677586590/artifacts/14606488249) · [超时诊断](../../docs/stdd/ci-f4aa21d-session-authority-diagnosis.md)
