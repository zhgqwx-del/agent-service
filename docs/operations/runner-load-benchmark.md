# 单 runner 本地并发基线

这是 M4 的本地开发压测工具，不是生产容量承诺。默认 profile 运行已有构建产物中的一个 `agent-runner`，使用真实 MySQL、独立非持久 Redis 和本机 FakeVendor；不调用付费模型或云服务。新增 `--provider-gateway` profile 还运行真实 router 的私有 fleet 证明链，仍不新增产品常驻服务、应用入口或镜像；工具属于已发布Gateway范围，实际压测证据仍绑定其当时构建。

## 运行前提

- Node.js 24、仓库依赖和本机 MySQL 已就绪。
- 提供可信的 Redis 可执行文件绝对路径。脚本会启动自己的 Redis 子进程，不复用或清空日常 Redis。
- 显式提供全新独占、可丢弃的 loopback MySQL 管理连接，必须有非零端口，schema 必须是 `mysql`；不允许省略端口后回落日常 3306。脚本只新建随机 `agent_service_test_bench_*` 库及其 runtime metadata/账号，成功时停止全部自有消费者后精确清理；失败保留供诊断，不采用已有业务库，不使用业务 `MYSQL_URL`。
- 不读取 `.env`。需要密码时通过受保护的调用环境注入，不把实际连接或密钥放入参数、报告、文档和日志。
- 临时目录至少有 1 GiB 可用空间。不要与其它重型本地验收同时运行，以免混淆资源和时延结果。

先按当前源代码构建一次 runner：

```bash
node scripts/build-app.mjs agent-runner
```

先做十个 turn 的冒烟，确认协议、统计与清理正常。以下无密码连接仅用于本机开发示例：

```bash
RUNNER_BENCH_LOCAL_ONLY_ACK=1 \
RUNNER_BENCH_MYSQL_ADMIN_URL=mysql://root@127.0.0.1:13306/mysql \
RUNNER_BENCH_REDIS_BINARY=/absolute/path/to/redis-server \
  pnpm benchmark:runner --turns 10 --concurrency 10 --ttft-ms 2000 --deadline-ms 120000
```

冒烟通过后，再做架构要求的单进程 1000 并发基线：

```bash
RUNNER_BENCH_LOCAL_ONLY_ACK=1 \
RUNNER_BENCH_MYSQL_ADMIN_URL=mysql://root@127.0.0.1:13306/mysql \
RUNNER_BENCH_REDIS_BINARY=/absolute/path/to/redis-server \
  pnpm benchmark:runner --turns 1000 --concurrency 1000 --ttft-ms 30000 --deadline-ms 180000
```

`--ttft-ms` 只是 FakeVendor 人工延迟，用来制造并发重叠，不是模型首字延迟或延迟 SLO。不能把 1000 个排队请求当成 1000 个执行中的 turn。

示例端口 `13306` 不是自动创建的实例；必须先独立核验它确属本次新建测试服务，不要直接替换成日常或业务库地址。

## Gateway 平台池 profile

先运行 `pnpm build` 构建两个角色，再给上述命令追加 `--provider-gateway`，按 2→32→1000 并发逐级执行。该 profile 自行生成私有测试 key 文件、双 slot、内部 token、独立 metrics token 与一致 policy；不复用真实平台或租户密钥。请求直接访问 runner，router 参与真实 configured-fleet 私有 nonce 证明，**不测 router 公网代理吞吐**。

除原 SQL/SSE 门禁外，成功还要求厂商原生 request→response.close 峰值、Gateway active 指标采样峰值都达到目标；全部 HTTP 正常结束且无 aborted，两个槽均实际使用，traceparent 合法且无重复。最终 attempts/completions/durationCount、逐行实际 provider/model、known/unknown usage 与独立 billing 必须一致，所有治理拒绝必须为零。厂商 barrier 只控制响应时机，不把排队或到达 barrier 当完成证据。

报告使用 `agent-service-runner-provider-gateway-load-v1`；BYOK breaker 虽已配置，但产品 SSRF 不允许租户 loopback endpoint，因此 `byokIoCapacityAssessed=false`，`fallbackCapacityAssessed=false`。不要为压测绕过 SSRF、借主平台 key 或访问真实厂商。费用是配置价估算，不是厂商最终账单。

停机发生在全部 turn/body 已完成之后；仅本 profile 的 router 显式使用 `SHUTDOWN_GRACE_MS=0`，报告标为 `quiesced-not-in-flight-drain`。产品默认 10 秒排空、工具 3 秒优雅关闭窗口及总期限不变；实际 native child.close 与自有进程组消失均须证明，强杀不能算成功。这不是在途 drain 验收。

## 怎样判读报告

每次独立报告保存于 `.local-run/runner-load-*/report.json`，目录和文件分别使用私有权限；失败报告保留。成功还必须有本次进程真实退出码 `0`，不能只看某一个布尔字段。

- 所有计划 turn 都收到合法 started 和正常 completed，错误为零。
- 客户端 SSE 观察峰值和独立 MySQL 已提交 `inProgress` 采样峰值都达到目标。它只证明至少一次观测达到该值，不证明持续时长。
- session、turn、两类 item、usage、匿名 billing、owner、四类关键 event、连续 seq 和 `lastSeq` 全部对账；FakeVendor 请求数精确相等。
- 启动前后的实际 runner dist 与完整 migration 摘要不变。`sourceBuildMatch=not-attested` 不证明源码与 dist 同源；源码提交、dirty 状态和构建步骤要另行记录。
- 所有自有子进程退出、随机测试库删除、临时目录移除，且无 ambiguous CREATE。清理不完整不能报成功。
- RSS 只采样 runner，能测量时有 2 GiB 保护上限；缺样本必须写未测量，不能当成内存达标。

HTTP 诊断仅保留数值状态码及协议允许的固定错误码计数；未知或损坏响应统一为 `unknown`，不保留 message、details、URL、正文或原始子进程输出。start latency 指收到 `turn/started` 的延迟；吞吐只统计负载阶段，不包含建库和准备 session 的耗时。

## 验证节奏与边界

历史受控构建已完成2→32→1000的具名本机测量，原source/dist/报告摘要、失败与清理证据见 [PROGRESS](../PROGRESS.md) 和 [原基线快照](../history/2026-10-25/docs/operations/runner-load-benchmark.md)。该结果不是当前文档树的性能复验，也不证明clean/publishable、router公网吞吐、BYOK/fallback容量、真实invoice或生产验收。Gateway后继发布通过不扩大这次压测范围。

日常运行 `pnpm test:runner-load`、`pnpm test:runner-load-native` 及受影响定向测试；故障注入用 `pnpm test:provider-gateway-chaos`，必须显式指向隔离 `REDIS_TEST_URL`。这三份工具文件及故障文件均登记主 coverage，具名 native/chaos 包装器另提供实际执行证明；工具测试不能替代真实压测。1000 并发基线在相关功能包冻结后执行，不因每个文档或诊断补丁重跑。

本地 FakeVendor、standalone Redis、同机 MySQL 和当前 OS/CPU 不代表 Linux、真实 Redis Cluster、真实模型、云 IAM/TLS、故障域、持续负载或生产验收。报告固定 `productionAccepted=false`；默认关闭的删除、恢复和 credential/telemetry grant 能力保持原门禁。具体成功、失败和未执行范围以 `docs/PROGRESS.md` 最新快照和末节为准。
