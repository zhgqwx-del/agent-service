# 历史评审索引

本目录保存 2026-09-26 各轮评审的**时间点快照**，用于追溯发现、风险依据、实测失败及修复动机。报告中的“当前”“尚未实现”“不能上线”“已修”、测试数量、覆盖率和行号都属于当时范围，不能作为当前工作树或发布判断；旧优先级与任务拆分不自动成为当前待办。

原始正文和失败留在原路径，本轮未移动或重跑历史探针。部分报告针对持续变动的工作树，未绑定单一 commit；以各篇记录的测量时间、环境及修复前后说明理解证据，不能事后赋予新 SHA 的验收身份。

## 当前替代说明

当前里程碑、A/B/C 来源、正式验收与剩余阻断以 [PROGRESS](../PROGRESS.md) 顶部为准；它保留各轮记录，引用历史数字时须同时保留版本和范围。当前行为查[架构](../design/00-architecture.md)、[身份](../design/01-identity-and-auth.md)、[威胁模型](../design/03-threat-model.md)和[数据生命周期](../design/04-data-lifecycle.md)；使用与运行查 [HTTP 手册](../operations/http-experience.md)、[SDK](../../packages/sdk/README.md)、[运维契约](../operations/local-and-deployment.md)及[开发与 CI 指南](../operations/development-and-ci-guide.md)。

这些当前说明承接已变更的合同，不代表每条历史风险都已关闭。判断某项修复，须沿 PROGRESS 找到对应代码与具名验收，不能仅凭报告过时或新测试文件存在推断完成。

## 快照目录

下表日期均为 2026-09-26；每篇的具体对象、测量节点和证据边界保留在原文。

| 文档 | 原始评审范围 |
|---|---|
| [00 自查](00-self-findings.md) | 并发、fencing、drain 与工具隔离的作者自查。 |
| [01 并发与正确性](01-concurrency-correctness.md) | SessionHost、Pi 事件、context/store、HTTP/SSE；八组临时探针。 |
| [02 API 完备性](02-api-completeness.md) | 当时公共 HTTP 能否支撑客户端；协议差距与隔离、OpenAPI/SDK 缺口。 |
| [03 安全](03-security.md) | 第一版威胁模型、权限、出站请求及秘密处理。 |
| [04 测试策略](04-test-strategy.md) | 当时覆盖率与测试证明力；保留变动工作树的测量节点和原 CI 方案。 |
| [05 回应与计划](05-response-and-plan.md) | 当时已修/延后/待决定项与 M2 拆分，非当前执行队列。 |
| [06 Router 与集群](06-router-and-cluster.md) | 代理、规范 ID、租约、Headers/SSE 与多进程证明力。 |
| [07 身份安全](07-auth-security.md) | 刚落地的鉴权子系统；原文区分并行修复前后，并记录复跑 PoC。 |
| [08 构建、CI 与测试](08-build-ci-tests.md) | 当时构建产物、Docker、CI、覆盖率与秘密进入上下文的风险。 |

选型研究与外部源码快照见 [research 索引](../research/README.md)。
