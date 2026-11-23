# Redis ACL/AOF 冷启 CI 门禁实施任务

## 实施方案

- 按会话已确认的[变更方案](change.md)，仅编辑工作流 AOF 双片 payload 和校验 pin，以及既有两枚 Linux native 合同摘要。
- 使用受测 Git 树替换跨提交失效的固定 1124。保持原路径、普通文件、源码根、前后验证和失败结清。拒绝不匹配的源码成员或证据。
- 验证上游具名命令与日志的精确集合，保留原文件后合并固定五份 AOF 制品。此后正常运行的 Redis 和 runner 镜像检查继续用既有门禁。

## 任务

- [x] 回放旧源码及导出器规则，记录正负例。
- [x] 修改 payload 和两枚工作流合同摘要。
- [x] 执行定向验证，按 AC 核对受测字节并完成只读复核。 [验收记录](verification.md)
- [x] 正常 Linux amd64 runner 实测通过，ACL、两次冷启及 AOF 合并制品完成验真。 [验收记录](verification.md)
- [ ] 完整 CI 验收。第 3 分片的 MySQL session authority 用例超时，原失败证据已保留，后续独立取证。 [最终 CI](https://github.com/zhgqwx-del/agent-service/actions/runs/44677586590/attempts/1) · [超时诊断](../../docs/stdd/ci-f4aa21d-session-authority-diagnosis.md)
