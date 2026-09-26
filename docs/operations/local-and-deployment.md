# 本地运维与后续部署契约

当前阶段以本机可重复运行和自动验证为目标；预发、生产资源就绪后，再把相同的环境变量契约映射到独立云服务器或 Kubernetes Secret、ConfigMap 和 Service。

## 本地生命周期

前置条件：Node 24、pnpm 12、`.env` 已由 `.env.example` 创建并填写。

```bash
scripts/local-service.sh start       # MySQL/Redis + runner + router
scripts/local-service.sh status      # 基础设施、进程、health 状态
scripts/local-service.sh smoke       # 无模型费用的启动/路由/鉴权冒烟
scripts/local-service.sh acceptance  # 十环节真实模型验收，会产生少量费用
scripts/local-service.sh logs        # 跟踪 runner/router 日志
scripts/local-service.sh stop        # 只停应用，保留 MySQL/Redis
scripts/local-service.sh down        # 停应用和本地基础设施
```

验证入口：

```bash
scripts/local-service.sh verify       # secret/API drift/typecheck + 集成/coverage + 历史迁移 + cluster + SDK/应用构建产物
scripts/local-service.sh verify-real  # 使用本机 .env，仅跑真实模型 E2E
pnpm test:migrations                  # 独立真实 MySQL：固定 0007 历史库升级到 0008
pnpm check:api                        # OpenAPI、运行时文档与生成 SDK 类型必须完全同步
pnpm check:sdk                        # 编译 SDK、原生 Node import，并检查发布 tarball
```

状态文件和日志写入 `.local-run/`，该目录不提交。`stop` 只发送 SIGTERM，让 runner drain；30 秒仍未退出时脚本会报错并保留现场，不会擅自 SIGKILL。

## 模块边界

- `agent-router`：无业务状态，可独立扩缩容。需要能访问全部 runner 的 `RUNNER_ADDR` 和共享 Redis。
- `agent-runner`：每个实例必须有全局唯一 `RUNNER_ID`，并发布其它 router/runner 可访问的 `RUNNER_ADDR`。
- MySQL：业务真相、事件、审批、配置和 usage ledger。生产迁移应作为独立 Job 执行，不能依赖所有 runner 同时自动迁移。
- Redis：租约、fence counter、owner 目录和事件扇出。生产环境必须启用满足恢复目标的持久化/高可用方案，不能把它当可随意清空的缓存。
- 对象存储：已有经过路径逃逸、静态 symlink、权限、损坏和并发测试的本地文件实现；key 采用跨平台无大小写歧义的小写 grammar，新写入返回版本化 ref，数据与 metadata 以覆盖 header/长度/正文的 SHA-256 单 envelope 经一次 rename 发布，目录/文件权限为 0700/0600，并可过渡读取/删除安全 key 范围内的旧 raw + sidecar 格式。该 root 必须由服务独占，因为 Node 没有可移植的 `openat/O_NOFOLLOW`，不能抵御有权同时替换目录项的恶意本机进程；本地 rename 也不等同于断电持久性承诺。它尚未接入 item/附件；接线前必须先完成 ownership manifest、outbox 与生命周期策略，生产再替换为 OSS/S3 实现。

## 环境配置原则

同一镜像通过环境变量进入 local、staging、production，不把环境地址或密钥写进镜像。

Runner 必需配置：

- `STORE=mysql`、`MYSQL_URL`、`REDIS_URL`
- `SECRETS_MASTER_KEY`（后续替换为 KMS/envelope encryption）
- `RUNNER_ID`：全局唯一，Kubernetes 可用 Pod UID/名称
- `RUNNER_ADDR`：集群内可路由地址，不能是 `0.0.0.0`
- `MAX_BODY_BYTES`：必须与 router 使用相同值；默认 1 MB，由 router 先拒绝超限请求
- 首次生产初始化使用受控的一次性管理流程；`BOOTSTRAP_API_KEY` 仅限 local/test

Router 必需配置：

- `RUNNERS`：runner Service 或明确的可达地址列表
- `REDIS_URL`：与 runner 相同的逻辑 Redis 集群
- `MAX_BODY_BYTES`：必须与 runner 相同，避免上游断开被误报成 502
- 网关/LB 必须关闭 SSE buffering，并把空闲超时设置得高于 SSE heartbeat

## 预发/生产资源就绪后的交付顺序

1. 建立独立的 staging MySQL、Redis、Secret/KMS 和网络访问策略。
2. 独立执行并验证数据库迁移、备份与回滚演练。
3. 部署两个 runner，确认唯一身份、readiness 和 graceful drain。
4. 部署 router，经 router 跑 session、SSE turn、断线重放和接管测试。
5. 接入真实 IdP、日志、指标和告警后再开放预发流量。
6. 生产环境重复同一流程，不复用 staging 的数据库、Redis、密钥或 service key。

日常交付采用同一条 promotion 链：本地开发与 `verify` → CI 全部门禁 → 构建一次不可变镜像 → 按同一 image digest 部署 staging → 预发验收 → 同一 digest 灰度到 production。staging 与 production 不重新构建镜像，也不共享数据库、Redis、对象存储、密钥或 service key；环境差异只来自受控配置和 Secret。

改变公开 contract 的版本（包括 heartbeat 字段或 query 语义）采用 runner-first：先滚动 runner，排空并确认全部旧 runner 已退出，再验证所有新 runner 的 `/openapi.json` 版本一致，最后升级对外提供静态契约的 router。router 的健康探测同时校验 `/readyz` 与 `/v1/capabilities`：协议版本不匹配的 runner 不进入 hash ring，也不能通过 owner 重路由；没有兼容 runner 时 readiness/capabilities 返回 503。新旧 runner 混部窗口仍不能把新版 OpenAPI/SDK 宣告为 fleet 权威；若未来要求长期混部，必须另外设计按 capability/version 路由。

当前已自动验证的发布物是两个独立的 Linux OCI 镜像：`agent-router` 与 `agent-runner` 各自构建、版本和部署，可以位于不同虚拟机或容器节点。“不可变镜像”指镜像内容在 local/CI 构建后由 digest 唯一确定，进入 staging/production 时不再重新编译或修改；不是 Windows/Linux 的虚拟机磁盘镜像。

`pnpm build` 同时会为 router/runner 生成各自的单文件 ESM JavaScript bundle，可在装有 Node 24 和对应 production dependencies 的 Linux、macOS 或 Windows 主机运行，但它不是原生机器码二进制。目前 CI 对容器镜像和原生 Node bundle 都有启动门禁；生产默认推荐 OCI 镜像，因为依赖、Node 版本和文件布局也被一起冻结。若未来明确采用裸 VM，再增加带校验和的 bundle + production `node_modules` 发布包和 systemd 服务，不需要把两个服务合成一个二进制。

“本地完整”指当前已实现的 M1/M2 主链路可在真实 MySQL + Redis + router + runner 下运行，并可用假厂商做无费用日常回归、用显式 `.env` 门禁做真实模型验证。它不表示云依赖已经由本机替代：完整数据生命周期、Blob/附件接线、M3 扩展和 M4 生产化仍按各自里程碑推进；OpenAPI/SDK 已纳入本地与 CI 门禁。

当前 `MysqlSessionStore.connect()` 仍会自动执行迁移，适合 local/CI，但还不满足上文“生产迁移作为独立 Job”的目标。进入 staging 前必须拆出显式 migration 命令/Job，并让业务进程只做 schema 版本检查、禁止启动时自动 DDL；同时完成备份恢复与迁移失败后的人工审计/重试演练。

暂不生成绑定某一云厂商的 Kubernetes YAML/Helm values；待 namespace、域名、镜像仓库、Secret/KMS、MySQL/Redis 地址和资源配额明确后再生成，避免把临时假设固化进部署资产。

迁移 `0008_atomic_turn_writes.sql` 会为 completed receipt 增加请求 hash，并给 usage ledger 建业务唯一键。

新版 `createSession` 会原子写入 session 与 `session/created(seq=1)`；混合版本窗口内旧 runner 仍是旧的两步路径，因此只有在旧实例全部排空后，才能把该原子性作为全 fleet 不变量。这个约束与下述 legacy pending 清理边界相同：不能在旧进程仍可能写入时提前宣告升级完成。

为兼容滚动升级，迁移不会批量删除旧版 runner 可能仍在使用的 legacy pending 幂等占位。新版 runner 命中 pending 时返回 `409 idempotency_conflict`，不会接管或替换该记录；否则旧 runner 的 delayed complete 可能在稍后覆写新版结果。发布时必须先排空并下线全部旧 runner，确认不存在旧进程后，再清理已过期 pending。旧版已完成 receipt 无法反推原请求，其 `request_hash` 保持 `NULL`；在该 receipt TTL 内新版会为兼容性直接重放，无法对“同 key 异请求”做 409 校验。

幂等表需要周期清理（建议由 CronJob/定时任务执行）。脚本默认只分批删除安全的、已过期 completed receipt；可先 dry-run：

```bash
scripts/local-service.sh cleanup-idempotency --dry-run
scripts/local-service.sh cleanup-idempotency
```

只有在确认所有旧版 runner 都已排空并下线后，才可额外清理过期 legacy pending：

```bash
scripts/local-service.sh cleanup-idempotency --delete-legacy-pending-after-drain
```

默认每批 1,000 行、单次最多 100 批；可用 `--batch-size=N --max-batches=N` 调整。脚本固定一次运行的过期时间水位，避免长任务持续追赶新到期记录。

迁移只自动合并内容完全相同的历史重复账；若同一 `(session_id, turn_id, step)` 存在内容不同的账目，唯一索引创建会故意失败，部署前必须备份并人工审计，不能静默丢账。
