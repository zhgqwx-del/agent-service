# f4aa21d 的 MySQL session authority 超时诊断

- 来源 GitHub run `44677586590` attempt 1，SHA `f4aa21d02d305d95fc2c52a2ef7a4ee8cbbbd404`，`test-main (3)` 的唯一失败。运行 9 个作业通过、4 个失败。Redis ACL/AOF 和原 `0055` 用例已通过。首个产品变更仍待选定。 [分片作业](https://github.com/zhgqwx-del/agent-service/actions/runs/44677586590/job/136093001107) · [原始分片制品](https://github.com/zhgqwx-del/agent-service/actions/runs/44677586590/artifacts/14606488249) · [003 验收](../../changes/003-ci-redis-aof/verification.md) · [首个产品变更](../../changes/001-first-slice/change.md)
- 环境 GitHub Ubuntu 26.04 amd64，Node 24.21.0、pnpm 12.5.1、Vitest 4.1.11、MySQL 8.0.26。分片沿用 V8、文件串行、30 秒用例和 60 秒钩子期限。新主机未持有原本机证据，原验收未独立复核。 [GitHub 工作流](../../.github/workflows/ci.yml) · [分层验证约定](../operations/development-and-ci-guide.md#6-分层验证路径)

## 复现和影响

`session-authority.mysql.test.ts:307` 的用例 `destroys and never releases a real uncommitted transaction after rollback rejects without sending ROLLBACK` 耗时约 30.115 秒，触发原 30 秒期限。同文件其余 11 个用例通过，耗时约 23.21–25.65 秒。目标用例在 `c71f6b8` 和 `166be40` 的 CI 曾分别用时约 23.35 秒、20.44 秒并通过。对比这三个提交，用例、事务实现、MySQL fixture、锁文件及 Vitest 配置文件字节相同。第 3 分片原生退出 1，覆盖率合并前停止。 [目标用例](../../packages/store/test/session-authority.mysql.test.ts) · [c71f6b8 分片制品](https://github.com/zhgqwx-del/agent-service/actions/runs/44507127998/artifacts/14526625266) · [166be40 分片制品](https://github.com/zhgqwx-del/agent-service/actions/runs/44649511798/artifacts/14593924048) · [最终必跑检查](https://github.com/zhgqwx-del/agent-service/actions/runs/44677586590/job/136123259688)

目标用例在新 schema 中通过真实 MySQL 操作写入未提交的 fence，确认写连接上读到 fence 1，并用独立管理连接看到该连接 ID 的一条活跃事务。测试拦截 `commit` 并抛出 `undefined`，随后令 `rollback` 拒绝而未发送 SQL。断言要求保留这个原始拒绝值，调用一次 `destroy()` 且零次 `release()`。Store 收口须等原生 socket close。最后管理员及新连接读取到相同的持久快照，且新连接 ID 不等于被销毁的连接。 [未提交事务用例](../../packages/store/test/session-authority.mysql.test.ts) · [rollback 及连接归还](../../packages/store/src/mysql/session-authority.ts) · [原生连接收口](../../packages/store/src/mysql/operation-abort.ts) · [0066 架构合同](../design/00-architecture.md)

## 定位和证据

### GitHub 原始记录

用 `receipt.json` 绑定 run、attempt、SHA，再以 Vitest blob 中的时钟核对控制台日志。目标用例超时结算后，下一条 timestamp reset 用例立即开始。fixture 的两条保留消息在下一条用例开始后约 3–4 毫秒到达，控制台与 blob 都将消息归在下一条用例名下。两条消息对应同一 fixture，其中 `createConfirmed=true`。下一条用例本身通过，`withFixture` 只在建库已尝试且用例没有正常通过或遇到失败时记录外层保留。时间和源码共同指向前一条超时用例的延迟清理输出，消息没有独立 case ID。可确认建库已完成，现有原件尚不能确认超时前是否进入 `commit` 拦截、观察到事务、调用 `destroy` 或开始 socket 等待。 [作业日志](https://github.com/zhgqwx-del/agent-service/actions/runs/44677586590/job/136093001107) · [原始 Vitest blob](https://github.com/zhgqwx-del/agent-service/actions/runs/44677586590/artifacts/14606488249) · [fixture 保留路径](../../packages/store/test/session-authority.mysql.test.ts)

### 本机定向验证

在 Darwin arm64、MySQL 8.0.46、Redis 8.10.3 运行。分别为目标、对照、全文件和阶段观测新建四组独占 loopback 实例，核对 MySQL `@@server_uuid`、数据目录、端口及 PID，核对 Redis 端口和 PID。保持原期限、串行与 V8，使用 `nativeEnvironment()`。目标、对照和全文件使用仓库原字节。第四次通过临时 Vitest 配置在内存中给目标用例加脱敏单调时间记录，仓库源码未改。四次原生退出均为 0、无信号，已核对所有专用服务的进程结清。

| 定向范围 | 结果 |
| --- | --- |
| 回滚拒绝目标单例 | 通过，约 10.17 秒 |
| 相邻 COMMIT 响应丢失用例 | 通过，约 10.57 秒 |
| 原全文件 | 12/12 通过，目标用例约 9.22 秒 |
| 单独阶段观测 | 通过，约 8.42 秒。fixture 准备约 7.69 秒，其中 schema/authority 准备约 6.97 秒。第一次 `INNODB_TRX` 查询即命中，等待 Store 和 socket close 约 0.33 毫秒，最后 fixture 清理约 0.37 秒。 |

原始退出、JSON、日志、阶段配置及归属证据均已保存。私有证据索引 SHA-256 为 `6159091f3f75db6f9b4668a16bfb33aea14f59b9669fee980511c6c62d1bb437`。本机未复现超时。与 CI 的 Linux amd64、MySQL 8.0.26 环境仍有差异，本机耗时仅用于确定后续观测顺序。

## 下一步和回归场景

本轮仅收尾验收和诊断记录。待 `001-first-slice` 选定需求时，在同一轮独立安排此项取证，依据匹配环境结果确定修复范围。完整 CI 验收继续待定。 [首个产品变更](../../changes/001-first-slice/change.md)

同环境优先跑目标单例及 `returns no proof after a real successful COMMIT response is lost and confirms only the original command` 对照。未复现时按原顺序跑全文件，再扩大至原第 3 分片。用全新独占 MySQL 8.0.26 和 Redis DB 1，绑定镜像摘要、资源归属、原源码和锁文件。原作业 MySQL 镜像摘要为 `sha256:5d52dc010398db422949f079c76e98f6b62230e5b59c0bf7582409d2c85abacb`，Redis 镜像摘要为 `sha256:1f88291b4c57bdf249f02eb085a8669889b2d2954e91d4de5118a5da6b78dd53`。按现有 authority 守卫独立确定 `MYSQL_TEST_OWNED_SERVER_UUID` 和 `MYSQL_TEST_AUTHORITY_ACK`，保护注入连接参数。每次设新建的私有 `CI_DIAG_DIR`，保留 `nativeEnvironment()` 和原有期限。 [分片作业](https://github.com/zhgqwx-del/agent-service/actions/runs/44677586590/job/136093001107) · [定向采集运行时](../../scripts/lib/main-coverage-runtime.mjs) · [原分片入口](../../scripts/run-main-coverage-shard.mjs) · [资源约束](../operations/development-and-ci-guide.md#6-分层验证路径)

```sh
node --input-type=module - <<'JS'
import path from 'node:path';
import { nativeEnvironment, runVitest } from './scripts/lib/main-coverage-runtime.mjs';

const out = process.env.CI_DIAG_DIR;
if (!out || !path.isAbsolute(out)) throw new Error('CI_DIAG_DIR must be a private absolute directory');
const { code, signal } = await runVitest([
  'run', '--config', 'vitest.coverage-shard.config.ts', '--coverage',
  'packages/store/test/session-authority.mysql.test.ts',
  '-t', 'destroys and never releases a real uncommitted transaction after rollback rejects without sending ROLLBACK$',
  '--reporter=default', '--reporter=json', `--outputFile.json=${path.join(out, 'tests.json')}`,
], nativeEnvironment());
console.log(JSON.stringify({ nativeExitCode: code, signal }));
process.exitCode = code ?? 1;
JS
```

阶段观测记录带独立 case 标识和单调时间的进入、完成及首个未结算阶段。优先区分 schema/authority CLI 准备和 runtime checkout、`INNODB_TRX` 首次命中及轮询次数、rollback 拒绝与 `destroy`、Store 和原生 socket close、独立连接回读和 fixture 收口。在现有 abort 收口前记录最后阶段，保留原异常及结清规则。需要锁旁证时仅在已确认归属的独占实例上用只读连接读取事务或等待状态，保存脱敏计数。只有确认耗时阶段后才选定优化方向。 [事务与锁观测定义](https://dev.mysql.com/doc/refman/8.0/en/innodb-information-schema-internal-data.html) · [用例及收口](../../packages/store/test/session-authority.mysql.test.ts)

**`AC-CIAUTH-001`。** 在原 30 秒用例期限内，证明真实事务在注入失败前存在，原异常保留，rollback 拒绝后只销毁一次且从不归还，原连接完成 native close。独立连接回读的持久行和原快照一致，现有 fixture 清理守卫通过。若超时，保存 case 标识、首个未结算阶段和原生资源结清状态。继续保留原失败和完整 CI 门禁。 [协作与验收规则](../../AGENTS.md)
