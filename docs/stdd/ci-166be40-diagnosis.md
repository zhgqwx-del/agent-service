# 166be40 的两项直接 CI 失败诊断

- 来源 GitHub Actions `44649511798` attempt 1，受测提交 `166be40f63f6345087924ec3d03b1be486f249c3`。13 个作业中 8 个通过、5 个失败。直接失败为 runner 镜像作业的 Redis ACL/AOF 门禁和主测试第 3 分片的 `0055` 用例。其余三个失败由必跑依赖传递。 [CI 运行](https://github.com/zhgqwx-del/agent-service/actions/runs/44649511798/attempts/1) · [最终检查](https://github.com/zhgqwx-del/agent-service/actions/runs/44649511798/job/136032872562)
- 范围 本次只诊断两个门禁。CI-01 的 Linux 原生配置已通过，CI-02～04 的原失败用例在此次 CI 均通过，原失败记录保留。首个产品变更继续待定。新主机未持有原本机证据，原验收未独立复核。 [CI-01 验收记录](../../changes/002-ci-native-image-digest/verification.md) · [前次 CI 诊断](ci-c71f6b8-diagnosis.md) · [首个产品变更](../../changes/001-first-slice/change.md)

## Redis ACL/AOF 冷启作业

### 复现和影响

`image (agent-runner)` 使用 Ubuntu 26.04.1 amd64，镜像版本 `20261116.202.1`。第 6 步完成 Linux 原生配置并产出可验制品，第 9、10 步写入两片固定 AOF payload 均成功，第 11 步退出 `1`。公开日志没有具体拒绝码，制品只含原生配置证据。该 runner 作业之后的 one-shot CLI、schema 准备和镜像运行检查跳过。预期是在同一 checkout 上编译固定 Redis 8.4.7、完成两次原生冷启及 ACL/AOF 断言，并合并五份脱敏证据。 [runner 作业](https://github.com/zhgqwx-del/agent-service/actions/runs/44649511798/job/136000566877) · [固定镜像工具清单](https://github.com/actions/runner-images/blob/ubuntu26/20261116.202/images/ubuntu/Ubuntu2604-Readme.md) · [本次原生配置制品](https://github.com/zhgqwx-del/agent-service/actions/runs/44649511798/artifacts/14590246095)

### 先后顺序与已确认阻断

1. 第 11 步核对两片拼接、压缩数据和解压 JSON 的长度及 SHA-256，再校验两份驱动的长度和摘要，随后 `execv` 执行 `ci-b-aof-entry.py`。从受测提交解包已逐层核对这些内容。驱动先检查平台、路径、磁盘和工具，包括 `/usr/bin/lsof`，之后运行 `head-before`、`clean-before` 和 `source-paths`。第 6 步制品已证明同一 runner 的 checkout SHA 正确、当时跟踪文件干净。第 11 步内的完整前置记录仍缺。 [固定工作流步骤](https://github.com/zhgqwx-del/agent-service/blob/166be40f63f6345087924ec3d03b1be486f249c3/.github/workflows/ci.yml#L1005-L1106) · [第 6 步制品](https://github.com/zhgqwx-del/agent-service/actions/runs/44649511798/artifacts/14590246095)
2. **最早已复现的确定性阻断是 `source_path_count`。** 该检查位于冻结源码、`pnpm install`、下载和编译 Redis、启动冷启驱动之前。用三个确切 Git 树的 NUL 分隔路径回放原检查，固定门槛为 1124。`61c3a58` 的 1124 个路径通过，`c71f6b8` 的 1211 个和 `166be40` 的 1217 个都被拒绝。工具可用和干净 checkout 的输入在回放中受控。用缺少 `lsof` 的对照会更早报 `linux_lsof_required`。云端 `outer-failure.json` 未上传，公开退出码无法独立证明这次 runner 最先命中的私有拒绝码。 [runner 作业](https://github.com/zhgqwx-del/agent-service/actions/runs/44649511798/job/136000566877) · [旧 B 包验收](../PROGRESS.md#当前验收证据)
3. **修完源码检查仍会遇到导出合同冲突。** 用本次原生制品单独回放，导出器先在 `old_manifest_identity` 拒绝 53 条清单记录，旧值为 49。单独执行后续检查时，旧文件名范围拒绝第 26 个命令的输出，`old_native_gate` 拒绝 26 个命令的报告。`sourceBefore`、`sourceAfter`、Node 驱动的 `source()`、冻结清单和导出器也各自固定 1124。以上是独立复现的后续阻断，冷启和导出在云端本次通过与否无证据。 [原生配置制品](https://github.com/zhgqwx-del/agent-service/actions/runs/44649511798/artifacts/14590246095)

回放只执行从固定驱动抽取的检查表达式。私有结果 `aof-guard-replay.json` 的 SHA-256 为 `5dd9e6cbd30a2e887f71b143bced3532555bfade2727c2bcd1c1ec703bfe3d94`。未构建或启动 Redis，也未改动 payload。

### 最小修复方案与验收

修复范围为 AOF payload 内的 Python 入口、Node 驱动、证据导出器，以及工作流对应的封装钉扎和现有 CI 合同摘要。入口用当前受测提交的 Git 树确定完整输入集合，逐项核对索引路径、文件类型、模式、工作树字节和排序后摘要。Node 驱动及导出器核对同一个冻结清单的路径集合、条目数和根摘要，并继续在运行前后复核。输入数量由受测 Git 树确定，开发提交追加文档后仍要求所有条目精确匹配。 [现有 Git 树验真实现](../../scripts/lib/main-coverage-runtime.mjs) · [CI 合同测试](../../test/ci-required-jobs.test.ts)

导出器绑定 CI-01 已验的 26 个具名命令、对应的 52 份日志及 `report.json`。严格核对 run、attempt、提交、文件集合、大小、摘要、原生退出和进程结清。保留已验的 53 份原始文件，追加固定的五份 AOF 证据，合并清单应为 58 条，含清单文件本身共 59 个文件。同步重算 payload 分片、压缩包、内嵌驱动和两枚 Linux native 合同摘要。保留 Redis 8.4.7 下载与构建 pin、ACL 负例、同配置及数据两次原生冷启、结清和后续镜像检查。 [工作流](../../.github/workflows/ci.yml) · [交付门禁](../operations/development-and-ci-guide.md#8-github-actions-构建与验证)

后续 Linux 诊断在同一 SHA 的新干净 checkout 中保留第 11 步的首个错误和当时已结清标签。公开证据只携带固定枚举的 `failureCode`、阶段和结清状态。原有 `outer-failure.json`、`export-failure.json` 和原生 stdout/stderr 留在受保护位置。若实际复验先命中工具或工作树前置检查，按其具名原因单独处理并保留该检查。

**`AC-CIAOF-001` 源码身份。** 用 `166be40` 的树做旧入口拒绝回放，修复候选须通过自己提交的全量源码核验。少一条、多一条、同数量替换路径、内容或执行模式漂移分别拒绝，运行前后证据绑定同一提交。

**`AC-CIAOF-002` 证据及原生冷启。** 在受保护的 Linux amd64 CI 资源上使用正常 runner 作业。26 个原生命令及 5 个容器的证据必须齐备，改变一个命令标签、删除一个日志、修改字节或混入其他 run/attempt/SHA 均拒绝。Redis 8.4.7 的两次冷启、ACL 正负断言、数据恢复和进程结清须实际通过，五份证据按原名发布，原生配置文件字节核对不变，后续 runner 镜像检查正常执行。

## `0055` 跨租户 NULL-identity 用例超时

### 复现和影响

`test-main (3)` 的唯一失败在 `tenant-telemetry-capture-checkpoint.mysql.test.ts:528`，用例 `rejects a real legacy NULL-identity usage row whose session has a different tenant`。本次约 30.004 秒，明确触发原 30 秒期限。原 `c71f6b8` 同一用例约 19.39 秒通过。本次相邻现代 usage owner 负例约 20.92 秒通过，49 类 checkpoint 正例约 23.73 秒通过。此前 CI-04 的无稳定 key 用例本次也通过。分片退出 1，覆盖率聚合在检查上游分片结果时停止。 [本次分片日志](https://github.com/zhgqwx-del/agent-service/actions/runs/44649511798/job/136000566900) · [本次分片原始报告](https://github.com/zhgqwx-del/agent-service/actions/runs/44649511798/artifacts/14593924048) · [原分片报告](https://github.com/zhgqwx-del/agent-service/actions/runs/44507127998/artifacts/14526625266)

现有负例在独占 MySQL fixture 建立活跃 capture、提交本地合成的 provider failure 记录并创建锚点，再插入一条 `usage_id IS NULL`、session 属于另一租户的 ledger 行。预期 checkpoint seal 拒绝，选定备份的 header 和 leaves 均为零，原 owner 按归属规则收口。两个 fixture 日志为 `retained_or_unknown`，外层记录 `runtimeRotationCreateAttempted=true`。该字段证明进入了轮换尝试，尚无证据定位轮换、用例主体、事务或清理的哪次等待先超时，也无法从超时判断 seal 的业务结果。 [用例和 fixture](../../packages/store/test/tenant-telemetry-capture-checkpoint.mysql.test.ts) · [事务收口](../../packages/store/src/mysql/store.ts) · [0055 合同](../design/04-data-lifecycle.md#14-00550056-active-capture-恢复的本地实现边界未发布)

### 定向复现入口

由 root 准备独立干净的 `166be40` checkout。匹配分片的 Ubuntu 26.04.1 amd64、Node 24.21.0、pnpm 12.5.1、Vitest 4.1.11、冻结锁文件和 MySQL 8.0.26。原作业记录的 MySQL 镜像摘要为 `sha256:5d52dc010398db422949f079c76e98f6b62230e5b59c0bf7582409d2c85abacb`。按原作业使用独占的测试实例，核对 MySQL `@@server_uuid`、数据目录、基库归属和地址，保护注入 `MYSQL_TEST_URL`。完整分片同时保留原独占 Redis DB 及 MySQL 权威测试资源证明。项目 `.env` 缺席，复用 `nativeEnvironment()` 及 CI 合成测试配置。保留 V8、文件串行、30 秒用例和 60 秒钩子期限。 [CI 服务与分片入口](../../.github/workflows/ci.yml) · [采集运行时](../../scripts/lib/main-coverage-runtime.mjs) · [Vitest 配置](../../vitest.coverage-shard.config.ts)

先跑目标单例，在另一个新实例上跑 `rejects a modern usage owner mutation despite unchanged independent billing$`。可用 `atomically seals all 49 families from a real queued v2 source` 开头的既有用例核对成功路径。单例均过时去掉过滤器按原配置跑全文件。仍未复现时由 root 按 `test-main (3)` 原入口、原分片和隔离资源复现，保持原顺序和完整集。每轮单独设置全新私有 `CI_DIAG_DIR`，保存 stdout、stderr、原生退出码或信号和 Vitest JSON。 [现有完整分片入口](../../scripts/run-main-coverage-shard.mjs)

```sh
node --input-type=module - <<'JS'
import path from 'node:path';
import { nativeEnvironment, runVitest } from './scripts/lib/main-coverage-runtime.mjs';

const dir = process.env.CI_DIAG_DIR;
if (!dir || !path.isAbsolute(dir)) throw new Error('CI_DIAG_DIR must be a private absolute directory');
const result = await runVitest([
  'run', '--config', 'vitest.coverage-shard.config.ts', '--coverage',
  'packages/store/test/tenant-telemetry-capture-checkpoint.mysql.test.ts',
  '-t', 'rejects a real legacy NULL-identity usage row whose session has a different tenant$',
  '--reporter=default', '--reporter=json', `--outputFile.json=${path.join(dir, 'tests.json')}`,
], nativeEnvironment());
console.log(JSON.stringify({ nativeExitCode: result.code, signal: result.signal }));
process.exitCode = result.code ?? 1;
JS
```

### 补证与验收

- 首轮使用原字节及原用例。若复现，记录同一原生进程的时间、Vitest 错误、fixture 结算与资源保留状态。仍缺阶段时，后续获授权可复用同文件 `diagnoseSelectedCheckpoint` 的观测方式。目标用例当前未启用该诊断。应在 owner 注册 abort 收口前挂上首次快照，使用单调时间记录每个阶段的进入、结算与超时时尚未结算的阶段。 [阶段观测及用例](../../packages/store/test/tenant-telemetry-capture-checkpoint.mysql.test.ts)
- 优先覆盖 fixture prepare、primary 激活及账号轮换、store 和 inspection 打开、合成失败记录提交、锚点建立、跨租户行插入、seal 的连接获取与事务、回滚与释放、零 header/leaf 查询、原 owner close 和 hook 等待。捕获原 `context.signal` 的到达时间。仅在同一独占实例仍在线且归属确证时，用单独只读连接保存锁等待种类、计数和连接角色作为旁证，不输出 SQL 参数、凭据或业务行。异常仍由原 promise 和 owner 结算，保留首次错误和原来的失败资源记录。 [fixture owner](../../packages/store/test/fixtures/capture-mysql-runtime.ts) · [验证约定](../../AGENTS.md)

**`AC-CI0055-001`。** 在匹配的隔离实例中，目标负例按现有断言拒绝跨租户的 legacy NULL-identity 行，并证明所选 checkpoint header 和 leaves 均为零。在原 30 秒用例和 60 秒钩子期限内按原规则完成收口，既有对照用例通过。若仍超时，须保留首次未结算阶段、原错误和最后可确认的事务或资源归属证据。

### 本机定向执行结果

使用与 `166be40` 相同的目标用例、fixture、产品代码、Vitest 配置和锁文件。环境为 Darwin arm64、MySQL 8.0.46、Node 24.21.0、pnpm 12.5.1、Vitest 4.1.11。目标、对照和全文件分别使用新建且核验过归属的 MySQL 实例，沿用 `nativeEnvironment()`、V8 和原用例及钩子期限。三次原生退出均为 0，无信号，已复核临时 MySQL 进程收口。

| 范围 | 结果 |
| --- | --- |
| 跨租户 NULL-identity 单例 | 通过，约 9.97 秒 |
| 相邻现代 usage owner 负例 | 通过，约 8.82 秒 |
| 原全文件 | 12/12 通过，目标用例约 8.66 秒 |

保留原生退出、Vitest JSON、日志和资源归属证据。私有索引 `0055-evidence.json` 的 SHA-256 为 `615db2e81bbf94e97e790c03ca8b8f07e58137fcd13706f23889eeec7eae0223`。本机未复现超时，原失败仍缺首个未结算阶段。匹配 Linux amd64、MySQL 8.0.26 的定向执行及原第 3 分片证据仍待补齐。未改 `0055` 代码。 [原分片制品](https://github.com/zhgqwx-del/agent-service/actions/runs/44649511798/artifacts/14593924048)
