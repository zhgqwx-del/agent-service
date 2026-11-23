# CI-01 Docker 镜像摘要校验任务

## 实施方案

- 状态 用户已确认 CI-01 最小方案，定向验证和完整原生门禁结果分别记录。
- 修改位置 [CI 工作流的原生生产配置检查](../../.github/workflows/ci.yml)及[现有 CI 合同测试](../../test/ci-required-jobs.test.ts)中与 Linux native 相关的两份摘要。
- 取舍 用两个原始 manifest 提供独立 config 证据。镜像 pin、平台和本地 `RepoDigests` 校验、超时、语法检查和结清继续沿用。
- 确认记录 用户在会话中确认只修 CI-01，按原失败制品验证与复核。 [原生配置报告](https://github.com/zhgqwx-del/agent-service/actions/runs/44507127998/artifacts/14519777556)

## 实施任务

- [x] `T-01` 由 root 回放原 runner 报告中的 manifest 型 `.Id`，核对旧步骤拒绝的原因。准备 `AC-CIIMAGE-001` 至 `003` 的定向输入。
- [x] `T-02` 增加两个具名的 Buildx 读取，先校验原始 manifest 字节再校验 config。更新本地身份判定和报告字段。按 `REQ-CIIMAGE-003` 核对成功路径包含原 24 个命令和两个新增命令。
- [x] `T-03` 由 root 从复核后的工作流字节计算 `IMAGE_LINUX_NATIVE_ADDITION_SHA256` 和 `IMAGE_LINUX_NATIVE_CONTRACT_SHA256`。保留其他摘要和测试断言。运行定向正负例、语法与作用域校验及现有 CI 合同测试，将实际命令、候选字节和结果写入[验收记录](verification.md)。
- [ ] `T-04` `AC-CIIMAGE-004` 的 Linux amd64 原生配置已通过并核对制品。`166be40` 的完整 CI 因 Redis ACL/AOF 冷启和第 3 分片失败。后续 `003` 已验证冷启门禁，完整 CI 仍待验收。 [本次验收记录](verification.md) · [003 验收记录](../003-ci-redis-aof/verification.md)
