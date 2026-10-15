# 单 runner 本地并发基线

这是 M4 的本地开发压测工具，不是生产容量承诺。它运行已有构建产物中的一个 `agent-runner`，使用真实 MySQL、独立非持久 Redis 和本机 FakeVendor；没有 router、付费模型请求或云服务，也不新增常驻进程、应用入口或镜像。

## 运行前提

- Node.js 24、仓库依赖和本机 MySQL 已就绪。
- 提供可信的 Redis 可执行文件绝对路径。脚本会启动自己的 Redis 子进程，不复用或清空日常 Redis。
- 显式提供 loopback MySQL 管理连接，schema 必须是 `mysql`。脚本只新建随机 `agent_service_test_bench_*` 库，确认本次 CREATE 成功、停止全部自有子进程后才删除该库；不采用已有库，不使用业务 `MYSQL_URL`。
- 不读取 `.env`。需要密码时通过受保护的调用环境注入，不把实际连接或密钥放入参数、报告、文档和日志。
- 临时目录至少有 1 GiB 可用空间。不要与其它重型本地验收同时运行，以免混淆资源和时延结果。

先按当前源代码构建一次 runner：

```bash
node scripts/build-app.mjs agent-runner
```

先做十个 turn 的冒烟，确认协议、统计与清理正常。以下无密码连接仅用于本机开发示例：

```bash
RUNNER_BENCH_LOCAL_ONLY_ACK=1 \
RUNNER_BENCH_MYSQL_ADMIN_URL=mysql://root@127.0.0.1:3306/mysql \
RUNNER_BENCH_REDIS_BINARY=/absolute/path/to/redis-server \
  pnpm benchmark:runner --turns 10 --concurrency 10 --ttft-ms 2000 --deadline-ms 120000
```

冒烟通过后，再做架构要求的单进程 1000 并发基线：

```bash
RUNNER_BENCH_LOCAL_ONLY_ACK=1 \
RUNNER_BENCH_MYSQL_ADMIN_URL=mysql://root@127.0.0.1:3306/mysql \
RUNNER_BENCH_REDIS_BINARY=/absolute/path/to/redis-server \
  pnpm benchmark:runner --turns 1000 --concurrency 1000 --ttft-ms 60000 --deadline-ms 300000
```

`--ttft-ms` 只是 FakeVendor 人工延迟，用来制造并发重叠，不是模型首字延迟或延迟 SLO。不能把 1000 个排队请求当成 1000 个执行中的 turn。

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

日常仅运行 `pnpm test:runner-load` 及受影响定向测试。两份工具测试和真实 MySQL 并发回归加入主套件逐文件必跑清单；工具纯测试不能替代真实压测。1000 并发基线在相关功能包冻结后执行，不因每个文档或诊断补丁重跑。

本地 FakeVendor、standalone Redis、同机 MySQL 和当前 OS/CPU 不代表 Linux、真实 Redis Cluster、真实模型、云 IAM/TLS、故障域、持续负载或生产验收。报告固定 `productionAccepted=false`；默认关闭的删除、恢复和 credential/telemetry grant 能力保持原门禁。具体成功、失败和未执行范围以 `docs/PROGRESS.md` 最新快照和末节为准。
