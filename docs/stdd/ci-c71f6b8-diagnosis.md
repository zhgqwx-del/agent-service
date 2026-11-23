# c71f6b8 的四项 CI 失败诊断

GitHub Actions `44507127998` 第 1 次运行对应 `c71f6b8847cb1dd86117aa8f719b648dfaf2071b`。四项直接失败各有独立修复范围和回归草案。首个产品变更 `001-first-slice` 仍待选定。新主机未持有原本机证据，原验收未独立复核。本记录依据本次 GitHub 运行的日志和制品。 [CI 运行](https://github.com/zhgqwx-del/agent-service/actions/runs/44507127998/attempts/1) · [首个产品变更](../../changes/001-first-slice/change.md)

| 修复项 | 失败门禁 | 当前定位 |
| --- | --- | --- |
| CI-01 | `image (agent-runner)` 的原生生产配置检查 | 已确认把 Docker manifest 摘要当作 config 摘要比较。 |
| CI-02 | `test-runtime` 的真实进程集群测试 | 已定位到首个 runner 就绪后的一次子进程提前关闭。退出角色与原因待补证。 |
| CI-03 | `test-main (1)` 的 MySQL 备份目录测试 | 已定位到 `0031` 用例清理前的 ownership 检查。具体查询与计数待补证。 |
| CI-04 | `test-main (3)` 的 MySQL telemetry 生命周期测试 | 已确认无稳定 key 的用例超出原 30 秒。超时阶段待补证。 |

## CI-01 Docker 镜像摘要校验

**复现与影响。** Runner 作业第 6 步在 Ubuntu 26.04、Docker 29.4.2 和 containerd 镜像存储上成功拉取固定的 nginx 镜像。拉取的摘要与 pin 一致，`inspect` 返回 `linux/amd64` 和匹配的 `RepoDigests`。`.Id` 返回 manifest 摘要 `206f4119…`，现有代码要求它等于 config 摘要 `2cbc7a37…`，因此抛出 `image-platform-or-config-mismatch`。containerd 实现用目标描述符的摘要填充 `.Id`。本次在 nginx 检查处停止，后续解析和 Redis 两次冷启步骤尚未执行。 [Runner 作业](https://github.com/zhgqwx-del/agent-service/actions/runs/44507127998/job/135501533641) · [哈希已核的报告制品](https://github.com/zhgqwx-del/agent-service/actions/runs/44507127998/artifacts/14519777556) · [Docker 29.4.2 对应实现](https://github.com/moby/moby/blob/docker-v29.4.2/daemon/containerd/image_inspect.go)

**最小修复方案。** 修改原生配置检查中的镜像身份取证。保留 nginx 和 promtool 的现有 manifest、config pin、按摘要拉取、平台检查及 `RepoDigests` 校验。对每个 pin 增加一次现有 Buildx 的 `docker buildx imagetools inspect --raw <固定镜像引用>`，先按原始字节核 SHA-256 等于 manifest pin，再按单平台 image manifest 核 `config.digest` 等于 config pin。继续用本地 `docker image inspect` 核实际平台及 manifest 绑定。`.Id` 只允许与已独立验真的两种摘要之一精确匹配，并记录实际返回与摘要种类。Buildx 调用先在该步骤隔离的 `HOME`、`DOCKER_CONFIG` 中确认可用。原始 manifest 的读取、解析或任一 pin 核对失败均终止该步骤。 [工作流](../../.github/workflows/ci.yml) · [Buildx 原始 manifest 输出](https://docs.docker.com/reference/cli/docker/buildx/imagetools/inspect/#show-original-json-manifest---raw)

两次新增读取均经现有 `native()` 记录。成功路径要求原 24 个命令和两个新增证明命令全部出现、成功并结清，5 个隔离容器及关闭证明持续执行，systemd、nginx、Prometheus 语法检查和失败制品上传沿用现有门禁。方案只涉及该工作流步骤与它的证据记录。 [工作流](../../.github/workflows/ci.yml)

**AC-CI-01。** 在 Linux amd64、匹配的 Docker/containerd 环境，用两个原始固定引用验证完整原生配置步骤成功。用原报告中的 manifest 型 `.Id` 和对照的 config 型 `.Id` 检验字段解释，并分别用错误 manifest 字节、错误 config pin、错误平台及错误 `RepoDigests` 验证拒绝。最终仍由正常镜像作业跑完原步骤及其后续门禁。 [原生配置报告制品](https://github.com/zhgqwx-del/agent-service/actions/runs/44507127998/artifacts/14519777556)

## 三项测试的共同复现条件

后续由 root 在独立干净的 `c71f6b8` checkout 中执行，使用 Linux amd64、Node 24.21.0、pnpm 12.5.1、Vitest 4.1.11 和原锁文件。MySQL 使用作业的 8.0.26 镜像，需 Redis 的用例使用该作业实际运行的 8.10.3，并核对镜像摘要。目标与对照分别使用全新独占测试资源。由 root 预先设置私有 `CI_DIAG_DIR`，保存原生退出状态、Vitest JSON、脱敏日志及对应的源码 SHA、场景、依赖和服务身份。连接信息经受保护环境注入。测试环境不加载项目 `.env`。主分片定向沿用 V8 采集、30 秒用例期限、60 秒钩子期限和文件串行设置，按 `nativeEnvironment` 排除真实模型、其它专项和外部覆盖配置。 [开发与 CI 指南](../operations/development-and-ci-guide.md#6-分层验证路径) · [采集环境](../../scripts/lib/main-coverage-runtime.mjs) · [Vitest 采集配置](../../vitest.coverage-shard.config.ts)

先运行目标单例，再用独立资源运行列出的对照。每次使用独立报告目录，保留前一次结果。单例未复现时，按原顺序运行全文件，最后回到原门禁或完整分片以检验顺序和负载影响。原主分片入口继续使用它的固定收集及身份校验，完整分片需原对应隔离 MySQL、Redis 和真实服务归属证明。定向输出属于本次诊断，正式覆盖率聚合依据同一 run、attempt、SHA 的原始分片及官方 V8 merge。失败时按原 ownership 守卫保留资源，记录原失败和已结清的范围。 [CI 分层及证据约定](../operations/development-and-ci-guide.md#8-github-actions-构建与验证)

## CI-02 集群 erasure 子进程提前关闭

**已确认。** `Cluster tests (real processes)` 中远端 owner 排空用例在 `startCluster` 阶段失败。首个 runner 已就绪。随后并行等待 runner-2 和 router 时，至少一个子进程在 `/readyz` 前关闭，引发 `cluster child closed before readiness`。累计启动 12.634 秒，尚未触发 30 秒 readiness deadline 或进入业务断言。harness 保留子进程输出在内存，失败摘要只有阶段，因此无法区分两者。 [作业日志](https://github.com/zhgqwx-del/agent-service/actions/runs/44507127998/job/135501534013) · [集群 harness](../../test/cluster/harness.ts) · [erasure 用例](../../test/cluster/erasure.test.ts)

**定向复现。** 保护注入 `CLUSTER_MYSQL_URL` 和 `CLUSTER_REDIS_URL`。harness 会重建目标测试基库并清空选定 Redis DB，因此两者均使用核验归属的独占临时资源，Redis 使用非零 DB，MySQL 用独立 `test` 或 `cluster` 命名段。保留原 readiness 和 FakeVendor。对照选同文件 `recovers after the active owner is SIGKILLed with a live drain claim$`，扩大至集群门禁时用现有 `pnpm test:cluster`。 [集群隔离规则](../../test/cluster/safety.ts) · [CI 门禁](../../.github/workflows/ci.yml)

```sh
AGENT_SERVICE_CLUSTER=1 pnpm exec vitest run test/cluster/erasure.test.ts \
  -t 'drains a remote active owner, tombstones child-first, reconciles usage and stops before purge$' \
  --reporter=default --reporter=json --outputFile.json="$CI_DIAG_DIR/cluster-erasure.json"
```

**补证与 AC-CI-02。** 后续诊断在 `launch` 和 `ready` 记录角色与 slot、spawn 错误码、原生退出码或信号、`exit` 到 `close` 的单调时间、最后 `/readyz` 状态和 runner 数是否匹配。在 `closeAdmission` 前冻结首次失败，区分随后被收口的同伴进程。只留有界脱敏字段。原期限内全部角色就绪且远端 drain、子会话优先 tombstone、usage 对账和停止于物理删除前的原有断言通过。受控提前退出的证据须能定位第一个进程，并证明所有已启动进程完成关闭。 [启动和结清逻辑](../../test/cluster/harness.ts)

## CI-03 0031 备份目录 MySQL fixture 清理拒绝

**已确认。** 分片 1 的指纹负例主体、触发器恢复和清理中的再次受限启动已走过。报错位于 `afterEach → finish → CaptureMysqlRuntimeOwner.close` 的清理前 guard。它对应用库和 metadata 库分别要求连接、活动事务和元数据锁查询返回单行零计数。至少一项未满足守卫，fixture 保留为 `retained_or_unknown`。现有报告不给出具体库角色、查询或计数。 [作业日志](https://github.com/zhgqwx-del/agent-service/actions/runs/44507127998/job/135501534069) · [原始分片报告](https://github.com/zhgqwx-del/agent-service/actions/runs/44507127998/artifacts/14525845412) · [清理守卫](../../packages/store/test/fixtures/capture-mysql-runtime.ts)

**定向复现。** 保护注入 `MYSQL_TEST_URL`，指向全新专用 MySQL 测试基库。沿用 fixture 的数据库和账号预置、权限与归属证明。对照选同文件原运行已通过的 `rolls activation back when Blob control is still dormant$`。全文件诊断可沿用下面的采集配置去掉 `-t`，既有专项验收入口是 `pnpm test:tenant-backup-catalog-mysql`。 [备份目录用例](../../packages/store/test/backup-catalog.mysql.test.ts) · [专项入口](../../package.json)

```sh
AGENT_SERVICE_INTEGRATION=1 pnpm exec vitest run --config vitest.coverage-shard.config.ts --coverage \
  packages/store/test/backup-catalog.mysql.test.ts \
  -t 'verifies the exact 0031 schema and owned-trigger fingerprint on startup$' \
  --reporter=default --reporter=json --outputFile.json="$CI_DIAG_DIR/main-1-backup-catalog.json"
```

**补证与 AC-CI-03。** 在外层 guard 的原查询返回时记录 schema 角色、检查种类、行数、计数、耗时和原生连接结清阶段，沿用内层 fixture 已有的闭集诊断字段。发生非零或缺证时保留现场，核对同一实例和 fixture 归属后，才用只读连接采集后置快照作为佐证。原删触发器拒启与恢复后受限启动断言保持，六项检查分别返回单行零计数后才执行原清理。非零或缺证仍拒绝清理，并能从证据定位触发项。 [外层守卫](../../packages/store/test/fixtures/capture-mysql-runtime.ts) · [内层诊断](../../test/fixtures/mysql-runtime.mjs)

## CI-04 telemetry 无稳定 key 用例超时

**已确认。** 分片 3 的 `is dormant without the stable key` 用例触发原 30 秒期限，实际约 30,004 ms。相邻 `activates with exact replay` 同次通过。该用例的 fixture 保留记录反映超时后的收口，未定位哪次 `await` 未完成。 [作业日志](https://github.com/zhgqwx-del/agent-service/actions/runs/44507127998/job/135501533919) · [原始分片报告](https://github.com/zhgqwx-del/agent-service/actions/runs/44507127998/artifacts/14526625266) · [telemetry 生命周期用例](../../packages/store/test/tenant-telemetry-lifecycle.mysql.test.ts)

**定向复现。** 保护注入 `MYSQL_TEST_URL`，指向另一份全新独占测试基库。单例保留无 key fixture、原有信号和期限。对照用 `activates with exact replay$`。单例与全文件无法复现时，再按原 `test-main (3)` 收集入口和资源配置复现。 [用例及同文件对照](../../packages/store/test/tenant-telemetry-lifecycle.mysql.test.ts) · [主分片入口](../../scripts/run-main-coverage-shard.mjs)

```sh
AGENT_SERVICE_INTEGRATION=1 pnpm exec vitest run --config vitest.coverage-shard.config.ts --coverage \
  packages/store/test/tenant-telemetry-lifecycle.mysql.test.ts \
  -t 'is dormant without the stable key$' \
  --reporter=default --reporter=json --outputFile.json="$CI_DIAG_DIR/main-3-telemetry-lifecycle.json"
```

**补证与 AC-CI-04。** 复用同文件的阶段观测，在 owner 注册取消监听前设置首次失败快照。记录 fixture 准备、store/inspection 打开、读取 inactive、拒绝激活及清理各阶段进入与结算、首次未结算阶段、原 `context.signal` 中止和实际 native close。观测与原清理使用既有 promise 和 owner，保留原错误。无稳定 key 时仍应读取 `inactive` 和 generation 0，激活按原断言拒绝 `TenantTelemetryLifecycleConflictError`，整个用例及结清在原 30 秒内完成。失败或取消仍按原守卫保留资源。 [既有阶段观测与用例](../../packages/store/test/tenant-telemetry-lifecycle.mysql.test.ts) · [现行默认关闭合同](../design/05-observability.md)

## 本机定向复现与证据

CI-02～04 使用与 `c71f6b8` 相同的产品代码、测试、fixture 和采集脚本。环境为 Darwin arm64、Node 24.21.0、pnpm 12.5.1、Vitest 4.1.11、MySQL 8.0.46，CI-02 另用 Redis 8.10.3。目标单例、对照单例和全文件分别在全新、已核归属的独占测试资源上执行。主分片定向保留 V8 采集、30 秒用例期限及 60 秒钩子期限，未加载项目 `.env`。

| 修复项 | 目标单例 | 对照单例 | 同文件执行 | 原 CI 仍待取证 |
| --- | --- | --- | --- | --- |
| CI-02 | 通过，12.64 秒 | 通过，21.80 秒 | 3/3 通过 | 本机目标运行观测到 runner 和 router 子进程，未复现提前关闭。原 CI 首个退出的角色、退出码或信号仍未知。 |
| CI-03 | 通过，7.93 秒 | 通过，10.34 秒 | 13/13 通过 | 本机未触发清理守卫拒绝。原 CI 触发的库角色、检查种类及计数仍未知。 |
| CI-04 | 通过，8.36 秒 | 通过，8.89 秒 | 13/13 通过 | 本机未复现 30 秒超时。原 CI 首个未结算的阶段仍未知。 |

九次运行的原生退出码均为 0。独立保存 Vitest JSON、运行日志、归属记录及 CI-02 的子进程观测。已复核这九次运行的 MySQL、Redis 及观测到的集群子进程均已退出。私有证据索引 SHA-256 为 `7d64c873a5eddfc66c904f6cde586485ed72b2e811d2940e37502e3b43312735`。本机结果覆盖上述定向范围。与原作业一致的 Linux amd64、MySQL 8.0.26 及原集群门禁和完整分片仍待验证。

## 后续验收

原运行的 `test-main-merge` 因第 1、3 片非零而在覆盖率聚合前停止，`test-core` 和最终 `test` 随必跑依赖失败。三项聚合结果保留原运行身份。后续修复沿用现有真实服务、完整分片与最终 SHA CI 门禁。 [原最终必跑检查](https://github.com/zhgqwx-del/agent-service/actions/runs/44507127998/job/135538183558) · [协作与验收规则](../../AGENTS.md)

## CI-01 推送后的同环境复核

`166be40f63f6345087924ec3d03b1be486f249c3` 的 GitHub run `44649511798` attempt 1 已结束。CI-01 原生配置通过。CI-02～04 源码与测试在本次提交中沿用原字节。以下观察绑定此次运行，保留原失败记录。 [本次 CI](https://github.com/zhgqwx-del/agent-service/actions/runs/44649511798/attempts/1) · [CI-01 验收记录](../../changes/002-ci-native-image-digest/verification.md)

| 原失败项 | 本次结果 | 原故障仍缺的证据 |
| --- | --- | --- |
| CI-02 | 集群 12 个文件、41 个用例通过，`erasure.test.ts` 3/3 通过，`test-runtime` 成功。 [runtime 作业](https://github.com/zhgqwx-del/agent-service/actions/runs/44649511798/job/136000566685) | 原报错进程的角色、退出码或信号。 |
| CI-03 | 原 `0031` 用例约 13.49 秒通过，第 1 分片原生退出 0。 [第 1 分片制品](https://github.com/zhgqwx-del/agent-service/actions/runs/44649511798/artifacts/14592495616) | 原清理守卫拒绝的检查和计数。 |
| CI-04 | 原无稳定 key 用例约 25.23 秒通过。 [第 3 分片制品](https://github.com/zhgqwx-del/agent-service/actions/runs/44649511798/artifacts/14593924048) | 原 30 秒超时的首个未结算阶段。 |

第 3 分片的唯一失败是 `tenant-telemetry-capture-checkpoint.mysql.test.ts:528` 的 `rejects a real legacy NULL-identity usage row whose session has a different tenant`。该 `0055` 用例从原运行约 19.39 秒通过变为本次约 30.004 秒，日志明确记录触发原 30 秒期限。两个 fixture 记录为 `retained_or_unknown`，外层记录 `runtimeRotationCreateAttempted=true`，日志未给出首次未结算的 `await`。第 3 分片原生退出 1、收集无效。这个失败按本次独立证据保留。 [第 3 分片日志](https://github.com/zhgqwx-del/agent-service/actions/runs/44649511798/job/136000566900) · [受测用例](../../packages/store/test/tenant-telemetry-capture-checkpoint.mysql.test.ts)
