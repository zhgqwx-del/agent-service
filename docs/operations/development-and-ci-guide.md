# 本地开发与 CI 指南

本文说明源码准备、隔离验证和交付物；API 操作见 [HTTP 体验](http-experience.md)，初始化见 [schema 与身份预置](schema-bootstrap.md)，运行及维护见 [运维契约](local-and-deployment.md)。当前发布与剩余工作只以 [PROGRESS](../PROGRESS.md) 为准。

通用部署包 `61c3a58` 已完成具名本地/CI 验收；实际生产验收待资源。已有本地环境与该包分别管理，文档工作树更新不会改变正在运行的版本。完整 M1/M3/M4/P2 仍未完成。

## 1. 服务、基础设施与代码库

| 组件 | 通用本地默认值 | 职责 |
| --- | --- | --- |
| router | `127.0.0.1:8080` | 公开 API、鉴权边界、实例路由、SSE 转发与平台管理入口。 |
| runner | `127.0.0.1:8787` | Runtime、模型/工具、session/turn/item/event/approval；内嵌 worker。 |
| MySQL | 由操作者明确提供 | 业务真相、0066 session authority、schema/生命周期证据。 |
| Redis | 由操作者明确提供 | 事件流/PubSub、Gateway 配额/池及相关协调；不再是 ordinary session owner/fence 的权威。 |
| MinIO | 可选的本地/CI基础设施 | S3 协议测试；分 bucket 不等于独立故障域。 |
| SDK、protocol/core/store/providers | 库，无长期进程 | 接入及应用内部依赖。 |

公开客户端只访问 router；runner 端口保持受控。长期服务/产品 JavaScript 入口/产品镜像为 **2/6/2**。MCP、hooks、子任务和各 worker 不新增常驻服务。

## 2. 一次性准备

使用 [`.node-version`](../../.node-version) 固定的 Node 24 和 [`package.json`](../../package.json) 的 `pnpm@12.5.1`：

```sh
pnpm install --frozen-lockfile
```

新使用者先完成 [人工 schema/metadata/最小权限/0066/first-admin](schema-bootstrap.md)，再用显式角色配置启动。普通 runner 只 verify，不建库、迁移或 GRANT；根 `.env.example` 不能当成受限 runtime 的完整初始化方案。不得把业务库或共享 Redis 用作学习资源。

源码目录中的 `.env`、`.local-run`、测试数据库和私有制品不提交。角色 JSON 是闭合的字符串 map；systemd EnvironmentFile 与 shell env 是不同格式。具体模板及保密要求见 [运维配置](local-and-deployment.md#环境配置原则)。

## 3. 启动与停止

已完成初始化的独占本地实例，推荐使用不加载项目 `.env` 的前台模式：

```sh
scripts/local-service.sh --external-infra run \
  --runner-env /ABS/private/runner.env.json \
  --router-env /ABS/private/router.env.json \
  --state-dir /ABS/private/new-runtime-state
```

两个配置文件须 owned `0600`、父目录 `0700`、无 symlink；state 必须全新。后继 run 使用新 state，保持相同 DB、master、Redis namespace 和稳定 Blob 目录。此模式仅提供 `run`/`--help`；Ctrl-C/TERM 仅收回本次 child 并等待真实退出，保留外部数据。不要用默认 `down` 管理外部基础设施。

已有专门配置的传统本地开发栈另有以下入口；它们加载本地配置并可能管理脚本自有基础设施，只在已核归属的开发环境使用：

```sh
scripts/local-service.sh status
scripts/local-service.sh smoke
scripts/local-service.sh logs
scripts/local-service.sh stop
scripts/local-service.sh down
```

`stop` 只停应用，`down` 还停该脚本拥有的基础设施；停止请求不等于 drain 证明。超时保留现场，不按历史 PID 或临时目录名清理。现有交付环境使用其本机 OWNER/交接流程，不套用新建流程。

<a id="5-手动体验-agent-runtime"></a>

## 4. 手动查看与调用 API

先核两 role 的 `/readyz`，再验证业务鉴权与读写；ready 不证明所有依赖、逻辑 DB 或模型配置正确。按 [HTTP 手册](http-experience.md) 准备 runtime key、实际 user、固定 agent/version，创建 session，再在同一 session 依次创建 turn、读取持久结果和 SSE。`202` 只表示接受；断流后查询原 turn，以相同 body/key 精确核实，不换 key 自动重新派发。

无费用体验可用该手册的有限本地 fixture；真实 provider、MCP 工具和 webhook 可能产生费用或副作用，须有实际范围与预算。`verify-real`、`acceptance` 和三轮 HTTP CLI 都可能调用模型，不是纯状态读取。当前助手既有四次真实调用额度已用尽，默认测试 case 预算不包含模型费用。

## 5. 按功能学习与验证

以下命令用于今后的相关开发，不要求为文档修改重跑。带 `-mysql`/`-redis`/`-cluster`/`-s3` 的入口须先核相应测试资源；required 登记或命令存在不等于执行通过。实现与具名验收范围分别看设计和 PROGRESS。

<a id="已发布-mcp-如何验证"></a>
<a id="受管-mcp-的隔离学习"></a>
<a id="公共-mcp-进度与-stateful-的学习验证"></a>

| 专题 | 定向入口 | 当前支持与限制 |
| --- | --- | --- |
| MCP | `test:mcp`、`test:mcp-registry`、`test:mcp-dcr`、`test:mcp-progress`，及对应真实服务入口 | 固定匿名 HTTP、三级受管注册/OAuth/池、公共进度、2025 stateful、受限自动 AS DCR；[MCP 合同](../design/06-mcp.md)。stdio/脚本/资源重池和完整兼容矩阵未完成。 |
| skills | `test:skills`、`test:skills-mysql`、`test:skills-s3` | 静态 mount 与受管 `SKILL.md` 是独立 gate；不执行脚本/抓取引用；[skills 合同](../design/07-skills.md)。 |
| hooks/webhook | `test:hooks`、`test:tenant-hooks`、`test:tenant-hooks-store-mysql`、`test:tenant-hooks-mysql` | operator 策略与 tenant-admin v2 observer 分权；observer 仅 ACK，unknown 不自动重发；[hooks 合同](../design/08-tool-hooks.md)。 |
| 轻池 hooks/子任务 | `test:lifecycle-hooks`、`test:subagents`、`test:runtime-extensions`、`test:subagents-mysql`、`test:subagents-cluster` | 固定可信包、root lease、固定目标/预算；不允许任意租户代码；[子任务合同](../design/02-subagents.md)。 |
| Gateway | `test:provider-gateway`、`test:provider-gateway-chaos` | 三级 quota、多 key pool、平台/BYOK breaker、仅未派发 fallback；unknown 费用停止；[Gateway 合同](../design/09-provider-gateway.md)。 |
| 生命周期/备份 | `test:migrations` 及 `package.json` 中对应 Memory/MySQL/S3 专项 | 默认关闭/本地限制及操作顺序见 [运维契约](local-and-deployment.md)；外部删除、真实 grant 和全域 completion 未开放。 |

MCP 工具仍须审批；进度是非持久观察，不推进 durable cursor。2025 SID/GET 流不随接管迁移，已 started 的副作用不重放。完整新功能须排空替换全部 runner、升级 SDK，不能用 healthy subset 代替 configured fleet。

受管 skills 的 user scope 管理由实际 owner 授权，tenant scope 需同 tenant admin，platform scope 使用 router-only 独立 operator token。`registry:<name>` 与静态 mount id 不混用，override 只 pin 已挂载且授权版本；DELETE 只是逻辑撤销，不清除历史包。tenant webhook 的 master/signing key、受管 MCP AEAD key、telemetry ref key 和 backup artifact key 均独立，不能互借。

## 6. 分层验证路径

每轮先类型检查和受影响定向；SQL、事务、删除、鉴权或隔离改动当轮补真实服务、并发/回滚负例。连续相关修改形成 coherent 包后，再冻结源码完成全量及最终 SHA CI。纯文档只做 diff/链接/示例静态检查，不重跑 types/build/长矩阵。

| 入口 | 证明范围 |
| --- | --- |
| `pnpm typecheck` | workspace 源码与测试的类型；不产生最终 bundle。 |
| `pnpm test:<专项>` | 对应范围；真实服务/故障注入须单独满足前提。 |
| `pnpm test:coverage` | 一次完整 main 与逐文件/具名 group 证明；要求独占测试 MySQL/Redis。 |
| `pnpm test:migrations` | 独立完整历史前态及冻结旧 binary；不能由 fresh-schema 替代。 |
| `scripts/local-service.sh verify` | 扫描/API/types、main、历史、cluster/T3g、SDK/bundle、VM 等本地门禁。 |
| `scripts/local-service.sh verify-s3` | 五 bucket 的 S3 专项、真实备份/capture 与源码装配；保留其启动的 MinIO。 |
| `scripts/local-service.sh verify-real` / `acceptance` | 真实模型路径，需另定预算；不因其它测试授权自动运行。 |
| [runner 并发基线](runner-load-benchmark.md) | 独立受控容量测量，不能替代功能/生产验收。 |

先只读确认全新空测试基库不存在，再由获授权 operator 创建；不要用 `IF NOT EXISTS` 认领旧库。完整 verify 基库名称须有独立 `test` 段；`MYSQL_TEST_URL` 与 `MYSQL_MIGRATION_TEST_URL` 指向同一新基库，`CLUSTER_MYSQL_URL` 使用另一个专用基库。连接/凭据经受保护环境提供，示例不放 DSN。authority 测试另要求 `MYSQL_TEST_AUTHORITY_ACK=dedicated-disposable-server-v1` 与独立确认的 `MYSQL_TEST_OWNED_SERVER_UUID`；它会暂设 mandatory roles，禁止共享/业务实例。

本地重型任务串行，不同验证或手动服务不争用测试库/Redis。迁移一经发布不可改；partial DDL/marker-loss 或不明来源的库保留供核查，不能删 marker/guard 放行。只对确已授权可丢弃资源使用新隔离库；不通过重建需保留数据的业务库处理 drift。

失败保留原退出状态、JSON、日志及 owned 资源；修正后重验失败与受影响范围、补未执行门禁。分段不能拼成一次 full 绿，旧 SHA 结果不能证明新源码。保持原覆盖阈值、case/hook/lease/SQL 期限与 oracle；同类预算例外逐项记录，不扩大生产权限或真实模型额度。磁盘/MinIO 507、休眠、binlog 等问题也先保留证据，不能删未知目录、日志或降低保护阈值。

<a id="7-本地源码进程与生产构建产物"></a>

## 7. 构建与交付物

```sh
pnpm build
pnpm build:check
pnpm check:vm-release
```

`build` 生成 SDK 和两个应用 bundle；`build:check` 再验证 SDK 包、四个 one-shot artifact 与 dist 普通 Node 启动。runner 的入口是 `main.js`、`blob-storage-migrate.js`、`restore-ledger-reconcile.js`、`backup-catalog.js`、`telemetry-capture.js`；router 只有 `main.js`。schema/authority 是 runner main 的显式命令模式。

VM 包带完整目标平台 production 依赖、migrations、manifest 和 role unit 模板，目标须有 Node24；OCI 镜像还带 Node/Linux。两者都按 OS/CPU 与精确 source identity 验真。dirty 开发包固定不可发布，clean 包与 CI ephemeral 签名也不等于目标生产许可。完整运输/独立工具/签名步骤见 [VM 发布合同](local-and-deployment.md#vm-进程发布包地基)。

## 8. GitHub Actions 构建与验证

实际定义以 [ci.yml](../../.github/workflows/ci.yml) 为准：8 个 job 定义，matrix 展开为 13 个执行实例。重型 job 使用独立服务实例；不把其并行方式照搬到共享本地 MySQL。Node 版本来自 `.node-version`，pnpm/frozen-lockfile 与完整 Git 历史均绑定本次输入。

| job | 范围 |
| --- | --- |
| `test-main` ×3 | 原生 Vitest 分片；片级仅证明 collection，保留 raw/blob/discovery/receipt。 |
| `test-main-merge` | 同 run/attempt/SHA 三片精确并集与官方 coverage merge；执行全局及 implementation floors。 |
| `test-history-shard` ×3 | 三个独立历史集合，逐文件非零、零 skip。 |
| `test-history` | 历史并集证明，保留各 raw；不是一次单进程运行。 |
| `test-runtime` | API/types、cluster/T3g、S3/真实备份、SDK/bundle、VM、dist S3 及 Linux 生产样例。 |
| `test-core` | main-merge 与 runtime 必须实际 success。 |
| `image` ×2 | 同 Dockerfile 的 router/runner 镜像构建、schema 准备、受限普通启动/鉴权和 CLI。 |
| `test` | exact required dependencies 全部 success；failure/cancelled/skipped 不放行。 |

main 全局 statements/branches/functions/lines 阈值为 72/61/68/76；MySQL store/Redis lease/Redis purge/Pi engine 的 line floor 为 40/40/60/30。required 具名 group 是同一集合的重叠子集，不重复计数。main 的专用 profile skip 另按冻结清单说明，history 无 skip。最终统计查该 SHA 的原报告与 PROGRESS，不复制旧数。

证据必须同 run/attempt/SHA、完整 Node/Vitest/source bytes，按 attempt 保存精确 artifact 名及目录。缺片、重复、额外文件、未知 skip、原生非零或漂移均拒绝；`always()` 上传只留证。只重跑 failed jobs 可能混合 attempt，不能用旧绿片补齐新验收。CI VM artifact 和临时镜像不自行提供生产信任根；workflow 当前 `load:true`，不 push registry。

<a id="9-从本地到未来生产的交付语义"></a>

## 9. 从验收到部署

使用同一已验真 VM 归档身份或 OCI image digest 晋级，目标机不重新安装依赖/构建。生产配置、Secret、权限、TLS、持久化、监控值守、备份及手工 R1 均由目标环境独立验收。单 Linux 双角色初版见 [生产部署手册](initial-production.md)；多实例/HA、自动恢复、源不可读灾备及完整 P2 不由该初版提供。

本地/CI 证明与目标生产证明分开，手工体验不改变已有环境版本。生产信任根/密钥管理、OCI 签名/自动晋级、真实 IAM/KMS/故障域、持续容量/SLO 等剩余工作保留其未完成身份。

## 10. 文档维护规则

操作步骤以本专题各手册为准，能力/不变量以 design 为准，验收状态以 PROGRESS 为准。旧逐轮数字、候选过程及完整命令背景保留在 [2026-10-25 原指南快照](../history/2026-10-25/docs/operations/development-and-ci-guide.md)，不能按其中旧“当前”措辞恢复工作或运行危险示例。
