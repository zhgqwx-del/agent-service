# 本地运维与后续部署契约

> M3 候选配置（2026-10-17）：MCP、静态 skills、tool hooks 分别使用默认关闭的 operator 配置，随 runner 发布并须 whole-fleet 停服排空后统一变更。参见 [MCP](../design/06-mcp.md)、[skills](../design/07-skills.md)、[hooks](../design/08-tool-hooks.md)。它们不增加部署服务或镜像；hook key 只由独立受保护文件提供，不把 key 写入环境 JSON。本地/CI 分段结果不代表已发布、云验收或生产启用；精确状态以 PROGRESS 为准。

> 当前状态（2026-10-16，优先于下方历史候选说明）：已发布 main `6fdb63c` 的五项 CI 全绿，隔离本地体验完成；当前工作树的 M3.1a MCP 尚为未发布候选，不能借旧 CI 背书。部署仍是 router/runner 两个独立服务，提供 OS/架构匹配、含 Node 生产依赖的 VM 目录包及两个容器镜像；不是 Windows/Linux 系统镜像或单文件原生二进制。云资源、生产信任根及真实环境验收仍待用户提供；MCP 不新增长期服务或产品入口，默认关闭，配置/完整未完范围见 [MCP 设计](../design/06-mcp.md)。

> M4本地并发基线候选（2026-10-15，未发布）：`benchmark:runner`复用实际runner dist、真实新隔离MySQL和自有Redis/FakeVendor，1000/1000正常turn、双峰值1000、持久化对账和清理通过；修复了压测复现的RR缺键INSERT死锁，保留原owner/回滚/来源门禁。不新增服务、产品入口或镜像，不使用.env/真实模型，不是持续负载、Linux CI或生产容量验收。运行命令、报告及限制见[压测学习材料](runner-load-benchmark.md)，精确源版本和证据见PROGRESS末节。

> CI并行候选（2026-10-15）：完整历史迁移移至独立runner/自有MySQL与Redis，主套件和两个image不删减，原名`test`只在全部成功时通过，预算不变。67eaa2d全量exit1及原构建失败原因未知的记录保留；只定向修复、复验失败部分并补后置，未重启整轮。最新1d3be15的T3g、SDK/六入口、实际双VM包均通过，开发profile未执行签名；分段不是新全量或Linux CI通过证明。部署拓扑、六入口/两服务/两镜像及默认关闭门禁不变；最终exact SHA的五个CI检查和实测收益以[PROGRESS](../PROGRESS.md)为准，流程见[CI学习材料](development-and-ci-guide.md#8-github-actions-构建与验证)。

> 离线VM签名候选（2026-10-15，未发布验收）：新增显式签名及signed inspect/unpack，独立SPKI公钥pin、选定role/commit与实际工具字节共同约束release。私钥格式正则的secret-scanner边界误报已等价改写、无白名单，scan696通过；其后最终相关9文件于07:28:39Z实际889 passed、零fail/skip（7个VM文件770与proof工具119），API/typecheck通过。代码提交d671632的darwin/arm64/Node24 clean双包于07:35:46.954Z实际通过，仅ephemeral-test-only签名、productionAccepted=false；最终文档提交的整树和新Linux CI仍待。原817 CI的test失败、两image成功；b575集中全量实际3164 passed/5 failed且后置未执行，不能写成全绿。完整事实只看PROGRESS末节。

> 历史本地集成验收（2026-10-15，非上述签名候选验收）：M4目录/受限tar与0054在干净代码提交e278ead通过完整verify；主2897、真实历史47文件282零skip、cluster28与独立T3g3、SDK/六JS入口及VM335/实际clean双tar均通过。该本地证明限macOS arm64/Node24，不替代main对应Linux CI或生产验收；发布/CI实际状态以main及对应Actions run为准。0054只给同primary、新完整tenant、T1前全written/ACK、全部Blob/export计划域零的v2来源建立保留式本地删除桥；legacy/mixed/未知来源和新epoch恢复仍拒绝。0037 hard-deny、外部对象删除/自动清理关闭、四false与M1未冻结/M2冻结/M3未开始不变。较早版本表保留历史边界，完整结果看PROGRESS顶部及末节。

当前阶段以本机可重复运行和自动验证为目标；预发、生产资源就绪后，再把相同的环境变量契约映射到独立云服务器或 Kubernetes Secret、ConfigMap 和 Service。M4同时支持虚拟机独立进程与容器镜像两种部署形态，复用router/runner协议和构建入口；Node24目录/归档已有macOS arm64本地集成验收，实际结果以PROGRESS为准。离线VM签名新增本地候选；生产信任根/密钥管理、OCI签名、环境晋级、受控schema发布、进程/容器托管及真实环境验收仍未完成。

## VM 进程发布包地基

这里的“VM进程发布包”是部署到已有主机的Node24 ESM应用目录，不是ELF/Windows原生机器码，也不是操作系统或虚拟机磁盘镜像。router与runner可在不同VM或容器内独立部署；仍只有两个长期服务。容器形态已有两个Linux OCI构建入口，VM形态复用完全相同的bundle和运行协议。

```bash
# Node24和package.json固定的pnpm版本；离线cache缺包则失败，不隐式下载。
pnpm test:vm-release
pnpm check:vm-release             # clean commit构建并运行临时双包smoke
pnpm check:vm-release --allow-dirty-development # 日常开发验证，不可用于晋级

# OUTPUT必须是仓库外、父目录已存在的新绝对目录；不覆盖既有目录。
pnpm package:vm --role agent-runner --output /absolute/new/runner-release
pnpm package:vm --role agent-router --output /absolute/new/router-release
```

clean构建从精确Git commit的blob复制输入到独立快照；工作树实际dirty且显式允许时，只复制一次工作文件并对相同copied bytes计算摘要，manifest固定`publishable=false`。构建全部在私有快照内执行`offline / frozen-lockfile / ignore-scripts`依赖安装、既有esbuild入口及production deploy。发布目录仅包含`dist/`、完整目标平台production `node_modules/`、本角色`service/*.service.template`和`release-manifest.json`。runner仍是一个main加四个one-shot入口，router一个main；one-shot不能注册成daemon。

manifest记录源码commit、lock/实际输入摘要、构建Node/pnpm/platform、严格target runtime与完整文件/软链接/目录权限清单；强制拒绝路径逃逸、敏感配置/私钥/数据库文件、特殊文件及特殊权限位。真实production闭包包括esbuild原生程序，不能声称跨OS/CPU通用；必须在目标Linux/macOS及x64/arm64环境构建，验真与运行主机也须匹配。native检查只核对有界ELF64/MachO64 header、program/load-command/segment结构、目标OS/CPU与完整文件摘要，截断、越界、未知/Windows格式或错误架构仍拒绝；这不是任意unsafe-native开关，也不是完整loader、NAPI/libc兼容或厂商真实性证明。实际功能须另经plain Node装配验证。第三方SDK合法`credentials`代码目录不能被误当密钥文件，但其每个后代仍完整检查，真实同名credentials文件/软链接及`.env`等继续拒绝。未来新增依赖须重新审查。发布输出不含`.env`，构建子进程不继承应用key/数据库/模型配置且不回显任意诊断。

验真复用`scripts/lib/vm-release.mjs`的`verifyVmReleaseDirectory(directory, role, trustedManifestSha256)`，摘要从独立可信构建/晋级渠道取得，不能把包内自算摘要当认证。同一目录、manifest和完整依赖闭包应保持不变后再晋级，目标环境不运行pnpm或重新构建。目录清单本身不是归档签名、跨平台确定性构建或生产许可；`productionAccepted=false`固定。受限tar运输与Node24独立工具具有先前335定向和clean双tar装配证明；本轮离线VM签名候选见下节，不借先前完整集成验证证明其已验收。registry/promotion job及自动安装器仍未实现，新Linux CI以main对应run验收。

### 受限 tar 与独立工具（候选，验证状态见 PROGRESS）

归档是无压缩USTAR、仅有限PAX `path/linkpath`扩展；不是VM磁盘镜像。只接纳普通文件、目录和安全相对软链接，不接纳hardlink、设备/FIFO、GNU/global PAX、特殊权限或未知元数据。默认数量、归档/单文件/manifest/路径大小预算不可由调用方放大；解包首先把归档复制到本次私有临时文件，在同次复制中核对外部归档摘要，再完整扫描结构、路径拓扑与预算，最后才创建新输出目录。文件与目录先于软链接创建；完整目录验真成功才返回receipt。失败不安装、不晋级，已创建的输出留在0700隔离状态供人工核对，不覆盖或自动删除operator目录。

```bash
# 在与目标OS/CPU匹配的构建主机；RELEASE目录须已通过可信manifest摘要验真。
pnpm package:vm-transport --release /absolute/runner-release --role agent-runner \
  --manifest-sha256 <独立可信manifest摘要> --output /absolute/new/runner-transport

# 目标主机仅需Node24。先从独立可信构建渠道取得tool/archive/manifest三个摘要，
# 用本机可信sha256sum（macOS可用shasum -a 256）核对工具原始字节，再执行它。
sha256sum /absolute/runner-transport/vm-release-tool.mjs
node /absolute/runner-transport/vm-release-tool.mjs unpack \
  --archive /absolute/runner-transport/release.tar --role agent-runner \
  --archive-sha256 <独立可信归档摘要> --manifest-sha256 <独立可信manifest摘要> \
  --output /absolute/new/runner-release
node /absolute/runner-transport/vm-release-tool.mjs verify \
  --release /absolute/new/runner-release --role agent-runner \
  --manifest-sha256 <独立可信manifest摘要>
```

同目录的`transport-proof.json`只是证据副本，**不能自行认证**工具或归档；攻击者同时替换sidecar、manifest和payload时，自算摘要仍没有可信来源。必须先信任构建渠道并人工/后续发布系统比较预期tool摘要，不能先执行未知工具让它验证自己。工具只用Node内置模块，无源码checkout、pnpm、网络、`.env`或数据库依赖；没有服务安装、DDL、current指针切换或应用启动权限。bundle现冻结六个源码：原`vm-release.mjs`、`vm-release-archive.mjs`、`package-vm-transport.mjs`、`vm-release-tool.mjs`，加`vm-release-signature.mjs`与`vm-release-signed.mjs`；六者与root package/lock都必须逐字节匹配该release冻结input清单。root依赖字段/lock不因签名增加依赖；闭合解析当前pnpm9 root importer，编译器实际版本须精确等于已绑定的esbuild0.28.2，错/旧安装会拒绝。编译子进程不继承应用密钥，proof记录受信任本机compiler入口的观察摘要；这不是完整冻结toolchain、vendor认证、抵抗恶意同UID替换或可复现构建证明。归档120秒deadline是共用计时的协作式检查，native文件系统I/O不能被它硬取消；成功副本也不是断电持久性或原子生产晋级证明。

候选CI增加按role保存`release.tar`、`vm-release-tool.mjs`及proof的artifact步骤，并在受信任job日志记录三个原始摘要；本地macOS证明不能代替main对应的Linux CI结果。artifact留存本身不是签名或production promotion。checker在临时无源码目录中调用已核对tool摘要的独立工具，把归档解包后再执行四CLI和router/runner双服务检查，不能仅测试原始构建目录；本轮clean profile增加的签名只使用ephemeral-test-only密钥，dirty-development profile明确不执行签名，不能由CI测试签名形成生产trust root。

### 离线 VM 发布签名

`pnpm sign:vm-release`是可信构建主机上显式调用的离线脚本，恰好要求八个flag：`--release`、`--role`、`--manifest-sha256`、`--archive`、`--tool`、`--private-key`、`--public-key-sha256`、`--output`。只接纳clean/publishable且目标OS/CPU匹配的Node24 release；私钥须为当前operator拥有、无软/硬链接的单链接普通Ed25519 PKCS8 PEM文件，权限精确`0400`或`0600`。新输出create-only，父目录须真实存在、由operator拥有且group/other不可写，并位于release之外；脚本不生成生产key、不发现`.env`，不把key复制入release或日志。

以下绝对路径均为占位。`RELEASE_MANIFEST_SHA256`、`RELEASE_TOOL_SHA256`、`RELEASE_PUBLIC_KEY_SHA256`与`RELEASE_SOURCE_COMMIT`须事先经独立受信任渠道提供并核对；公钥pin是canonical SPKI DER的SHA-256，不是PEM文本摘要。不能从待验证目录的sidecar自算值替代这些authority。签名必须由可信签名环境及其代码执行；目标消费前仍须先bootstrap可信tool，**不能先运行未知tool让它认证自己**。

```bash
# 可信构建/签名主机：八个显式flag，不把private key正文放入命令行。
pnpm sign:vm-release \
  --release /absolute/verified/runner-release --role agent-runner \
  --manifest-sha256 "${RELEASE_MANIFEST_SHA256:?}" \
  --archive /absolute/runner-transport/release.tar \
  --tool /absolute/runner-transport/vm-release-tool.mjs \
  --private-key /absolute/protected/release-signing-key.pem \
  --public-key-sha256 "${RELEASE_PUBLIC_KEY_SHA256:?}" \
  --output /absolute/new/release-signature.json

# Node24目标主机：先用本机可信校验程序比较预期tool原始字节，再运行它。
# macOS可用shasum -a 256 --check替代sha256sum --check。
printf '%s  %s\n' "${RELEASE_TOOL_SHA256:?}" /absolute/runner-transport/vm-release-tool.mjs | sha256sum --check && \
node /absolute/runner-transport/vm-release-tool.mjs inspect-signed \
  --archive /absolute/runner-transport/release.tar --role agent-runner \
  --signature /absolute/release-signature.json --public-key /absolute/protected/release-public-key.pem \
  --public-key-sha256 "${RELEASE_PUBLIC_KEY_SHA256:?}" --source-commit "${RELEASE_SOURCE_COMMIT:?}" && \
node /absolute/runner-transport/vm-release-tool.mjs unpack-signed \
  --archive /absolute/runner-transport/release.tar --role agent-runner \
  --signature /absolute/release-signature.json --public-key /absolute/protected/release-public-key.pem \
  --public-key-sha256 "${RELEASE_PUBLIC_KEY_SHA256:?}" --source-commit "${RELEASE_SOURCE_COMMIT:?}" \
  --output /absolute/new/runner-release
```

两条signed命令都不接受caller-selected `--tool`或unsigned fallback；它们读取正在执行的`import.meta.url`实际工具字节，核对签名中的tool摘要。闭合Ed25519签名还绑定role/精确commit、copied inputs/lock、manifest/archive/tool摘要、target runtime、归档字节数/entry count及clean/publishable/`productionAccepted=false`。完整signed provenance在创建输出前核对；解包再以签名中的归档摘要认证第二次私有copy，不能继承第一次读取的TOCTOU权威。签名失败不创建解包目录；后续归档/目录验真失败仍按既有0700隔离留存合同处理，绝不安装、执行DDL、启动应用或晋级。

这是offline脚本能力，不增加六个应用dist入口、两个常驻服务或两个OCI镜像。签名不证明freshness、撤销、密钥管理/生产信任根、OCI签名、自动promotion、生产验收或任意重放防护；caller选择的精确commit只是选定release约束。sign/inspect/unpack各有协作式120秒operation预算，消费工具自hash另有独立预算；native文件系统I/O不能被硬取消，受控parent/可信本机及非恶意same-UID仍是前提。最终相关重验、实际clean双包与新CI状态以PROGRESS末节为准，不借旧335或本轮定向889当完整发布通过。

本轮严格clean双包装配已实际通过：代码提交`d671632a26f42cee146e3e27384cb46834aecde3`，完成时间`2026-10-15T07:35:46.954Z`，target为darwin/arm64/Node24。两role均`sourceDirty=false`、`publishable=true`、`signatureProfile=ephemeral-test-only`、`productionAccepted=false`；双sign→独立bundle的inspect/unpack、wrong pin/commit拒绝且无output、四个one-shot的current alias及双main readiness/auth/forward/OpenAPI、停止后目录不变均通过。报告另存`.local-run/vm-release-proof.signature-d671632-20261015.json`，本次临时归档位于`/private/tmp/agent-service-vm-signature-20261015-Oo2auK/verified`，不是长期发布地址或生产信任根。后续文档commit会改变HEAD；此证明仅绑定上述代码commit，不是最终新SHA完整verify或Linux CI通过，整树/新CI仍待。

systemd模板仅提供Linux非root样例：手工核对专用账号、Node24绝对路径、只读release/current布局和独立`/var/lib/agent-service/<role>`状态目录；配置从独立`/etc/agent-service/<role>.env`提供，建议0600，仅配置权限与职责匹配的变量。模板设置`StateDirectoryMode=0700`、`UMask=0077`和runner外置Blob目录；不会创建账号、安装unit、改当前release指针、执行DDL或启动真实服务。启动MySQL runner的现有自动migration行为并未因打包消失，生产无DDL账号/可信trigger只读桥仍需后续实现；schema cutover后的回滚须服从forward-fix，不能仅替换旧目录。

`check:vm-release`只使用新临时目录、synthetic测试key和memory后端，先独立构建两套依赖闭包，再以plain Node运行四个CLI帮助入口与两个真实进程，验证readiness、协议、租户/平台认证边界、转发和canonical OpenAPI，停止后重新验真目录未被runtime修改；成功metadata保存于`.local-run/vm-release-proof.json`。`test:vm-release`要求逐JSON证明非零实际passed、零其它状态。CI默认拒绝dirty构建，本地`verify`显式允许dirty开发快照而不产生发布许可。Windows运行潜力不等于测试证明，systemd、跨VM、MySQL/TLS/IAM、容量、整体deadline及真实staging/production仍需独立验收；不会因此进入M3或冻结M1。

## 本地生命周期

`0053`补充默认关闭、仅限非生产本地的 persisted provider-step failure capture v2。只有真实模型 stream 的失败来源可在原 failed-step 业务 COMMIT 内，与 item/completed、usage/billing、连续 event seq、source/binding/receipt 和0034 spool/membership 一起原子提交；不是独立 logger，也不改变 SessionHost 后续 turn-terminal 第二次 COMMIT/interrupt 语义。runner `PERSISTED_PROVIDER_FAILURE_CAPTURE_ENABLED` 与 router `PERSISTED_PROVIDER_FAILURE_CAPTURE_FLEET_ENABLED` 均默认 `0`，production 拒绝开启。需先以受控 operator 激活0033 lifecycle与v2 logs，精确绑定已真实激活的0030 primary runtime epoch/lineage、protected key、logs target及configured-fleet root；只设置环境变量或generation-0 control不能满足前提。0035 v1及traces必须inactive。

capture 激活后，现有T3d/T3f仍对第六来源全局硬拒，tenant erasure保持阻断；grant、产品外部处置、restore/completion不开放，`erasuresBlocked=true`、`executionReady=false`、`allDomainsComplete=false`。已绑定failed-step的operational usage也不能由0052自动清理或手工删行；NULL/0历史来源不回填，保持unknown。这里提供的是失败日志写入闭环，不是数据生命周期或生产验收完成。

0052新增ordinary session operational usage retention的本地执行能力，普通启动和验证仍默认关闭；它只去除operational ledger身份关联，不删除session内容、reconciliation或匿名账单。runner配置为`SESSION_USAGE_RETENTION_WORKER_ENABLED=0`、`SESSION_USAGE_RETENTION_WORKER_POLL_MS=30000`、`SESSION_USAGE_RETENTION_WORKER_BATCH_SIZE=25`，router配置为`SESSION_USAGE_RETENTION_ENABLED=0`；production拒绝开启，runner/router互相拒绝或清除对方专属变量。学习验证优先使用四个named脚本`test:session-usage-retention-memory`、`test:session-usage-retention-mysql`、`test:session-usage-retention-worker`、`test:session-usage-retention-worker-mysql`与真实`0051→0052`历史夹具，不应手工SQL伪造policy/source/receipt或提前打开内容purge。T3f/grave的versioned摘要桥接使已保留billing事实在后续租户清理中继续可核对，旧v1 hash保持原值。完整结果以PROGRESS最后一节为准。

BYOK删除边界：系统只清除自己保存的key，厂商侧撤销由客户负责；现有T3a只证明live数据库credential行清理，T3b只处理受跟踪runtime引用，备份/恢复仍是独立缺口。不能把现有0026 external blocker直接改成远端撤销成功，或启用0029 fake冒充真实provider adapter。

前置条件：Node 24、pnpm 12、`.env` 已由 `.env.example` 创建并填写。

```bash
scripts/local-service.sh start       # MySQL/Redis + runner + router
scripts/local-service.sh status      # 基础设施、进程、health 状态
scripts/local-service.sh smoke       # 无模型费用的启动/路由/鉴权冒烟
scripts/local-service.sh acceptance  # 十环节真实模型验收，会产生少量费用
scripts/local-service.sh logs        # 跟踪 runner/router 日志
scripts/local-service.sh stop        # 只停应用，保留 MySQL/Redis/MinIO
scripts/local-service.sh down        # 停应用和脚本拥有的本地基础设施
```

### 受保护的 L0 runtime metrics

router与runner在各自现有端口分别提供`GET`/`HEAD /metrics`，不新增进程或端口，默认`METRICS_ENABLED=0`并返回`404`。要手动体验，先在本机受保护的`.env`中为`METRICS_BEARER_TOKEN`配置独立于业务/internal/admin凭据的32～256位ASCII token，再设置`METRICS_ENABLED=1`并重启本地服务；不要在终端命令、日志、工单或文档中打印真实token。`local-service`共用一份`.env`，两role可用同一运维token；独立部署时可按role分别配置，不要求两role必然不同。token预置但开关仍为`0`时，指标不可读，但该凭据在其它路径仍受防转发拒绝保护。

scrape只接受`Authorization: Bearer <token>`（scheme大小写不敏感、单个ASCII空格、token大小写敏感），不能用query或`X-Internal`代替。开启后缺失/错误凭据为`401`，已授权的非`GET`/`HEAD`为`405`；响应`Cache-Control: no-store`，`HEAD`不返回指标正文。可由操作者在受控渠道准备权限`0600`的curl配置文件，其中`header = "Authorization: Bearer <replace-privately>"`只作格式占位，真实值仅写入该文件、不得回显；然后分别检查：

```bash
curl --config /absolute/protected-metrics-curl.conf -i http://127.0.0.1:8080/metrics
curl --config /absolute/protected-metrics-curl.conf -I http://127.0.0.1:8787/metrics
```

指标只有进程内的闭合低基数HTTP/进程量，重启后计数清零；header-ready时延和in-progress handler不是SSE流寿命或active turn。此开关不启用0054/0037、外部对象删除或任何自动清理gate，也不证明生产网络/TLS、独立采集授权、容量、collector/dashboard/SLO/告警已经验收。

验证入口：

```bash
scripts/local-service.sh verify       # secret/API drift/typecheck + 集成/coverage + 0007→0053 历史迁移 + capture真实MySQL专项 + cluster + SDK/应用构建产物
scripts/local-service.sh verify-s3    # 真实Blob/restore/catalog/telemetry S3、backup制品、capture HTTP→MySQL→MinIO及源码装配；普通verify不能替代
scripts/local-service.sh verify-real  # 使用本机 .env，仅跑真实模型 E2E
pnpm test:migrations                  # 独立真实MySQL：0007→...→0053；含真正旧0052 binary失败来源升级，逐夹具必执行且零skip
pnpm test:blob-mysql                  # 强制执行并验明 Blob ownership/绑定/cleanup 的独立真实 MySQL 套件
pnpm test:blob-storage-control-memory # 强制执行0027 Memory cutover/回滚/并发语义
pnpm test:blob-storage-control-mysql  # 强制执行0027真实InnoDB inventory/回滚/并发语义
pnpm test:blob-storage-migration-mysql-s3 # 强制执行0028真实MySQL+MinIO离线搬迁/回滚/恢复套件
pnpm check:blob-storage-migrate-artifact # 构建后以plain Node执行runner一次性mover入口的稳定--help门禁
pnpm test:tenant-restore-journal-memory # 强制执行0030 Memory原子publication/runtime/replay契约
pnpm test:tenant-restore-journal-mysql # 强制执行0030真实InnoDB journal/runtime/replay/回滚/并发套件
pnpm test:restore-journal-s3          # 需与Blob不同名的单独测试bucket；强制执行0030真实MinIO journal chain/seal/replay套件
pnpm check:restore-ledger-reconcile-artifact # 构建后以plain Node执行runner一次性restore CLI的稳定--help门禁
pnpm test:tenant-backup-catalog-mysql # 强制执行0031真实InnoDB catalog/restore/retention/rollback套件
pnpm test:backup-catalog-s3           # 需与Blob/journal不同名的第三个测试bucket；强制执行0031真实MinIO immutable event chain + CAS head套件
pnpm test:backup-catalog-reconcile-mysql-s3 # 强制执行真实MySQL+MinIO one-shot reconcile分页/重放/fail-closed套件
pnpm test:backup-catalog-restore-roundtrip-mysql-s3 # 强制执行真实mysqldump旧快照恢复与0031重建套件
pnpm check:backup-catalog-artifact    # 构建后以plain Node执行runner一次性backup-catalog CLI的稳定--help门禁
pnpm test:tenant-telemetry-lifecycle  # 强制执行0032/0033 content-free target/coverage/subject evidence、activation identity与artifact inventory契约
pnpm test:tenant-telemetry-lifecycle-memory # 强制执行0033 Memory activation/coverage/inventory原子语义
pnpm test:tenant-telemetry-lifecycle-mysql # 强制执行0033真实InnoDB回滚、并发、启动审计与隔离语义
pnpm test:tenant-telemetry-writer     # 强制执行0034 writer及0038 Memory原子membership/source套件
pnpm test:tenant-telemetry-writer-mysql # 强制执行0034真实InnoDB spool/ACK及0038 membership/guard套件
pnpm test:tenant-telemetry-writer-s3  # 需第四个独立测试bucket；强制执行真实MinIO telemetry object writer套件
pnpm test:telemetry-capture-operator # protected key、五command与wrapper默认拒绝/隔离的必执行unit
pnpm test:telemetry-operator-key-compatibility # backup/restore protected exact key接线与填零/输出unit
pnpm test:persisted-provider-failure-capture # 原始provider provenance、SessionHost和fresh fleet/worker必执行unit
pnpm test:persisted-provider-capture-mysql # 独立真实MySQL事务/并发/回滚/进程SIGKILL/隔离，零skip
pnpm test:telemetry-capture-mysql-s3 # 真实FakeVendor HTTP/stream→Pi/Host→MySQL→0034worker→MinIO bytes/ACK；需测试环境
pnpm test:mysql-backup-artifact-mysql-s3 # 真实制品create/import及active0033 exact key恢复审计；需宿主MySQL8工具
pnpm check:telemetry-capture-artifact # 构建后plain Node验证新增one-shot入口、production拒绝和安全输出
pnpm test:tenant-telemetry-application-capture # 强制执行0035 per-domain producer capture/Memory契约
pnpm test:tenant-telemetry-application-capture-mysql # 强制执行0035真实InnoDB activation/coverage/binding/并发/回滚
pnpm test:tenant-telemetry-disposition # 强制执行0036协议、默认拒绝、Memory store和外部adapter unit套件
pnpm test:tenant-telemetry-disposition-mysql # 强制执行0036真实InnoDB control/receipt回滚、并发及启动指纹
pnpm test:tenant-telemetry-disposition-s3 # 需第五个独立测试bucket；强制执行真实MinIO journal CAS协议夹具
pnpm test:tenant-telemetry-disposition-grant # 强制执行0037非生产v2 grant-bound Memory事件/CAS夹具
pnpm test:tenant-telemetry-disposition-grant-mysql # 强制执行0037真实InnoDB grant hard-deny/启动指纹
pnpm test:tenant-telemetry-disposition-journal-v3 # 0047显式非生产v3事件链/S3 adapter unit夹具
pnpm test:tenant-telemetry-disposition-journal-v3-observer # 0048 GET-only v3 sealed-chain观察器unit套件
pnpm test:tenant-telemetry-artifact-observer # 0046 GET-only artifact观察器unit套件
pnpm test:session-delete-grace-memory # 0050 Memory普通DELETE原子来源、post-commit seal/回滚套件
pnpm test:session-delete-grace-mysql # 0050真实InnoDB post-COMMIT 30天floor、并发/回滚/隔离套件
pnpm test:session-delete-grace-recovery-memory # 默认关闭的runner恢复caller、轮询/停机/脱敏日志
pnpm test:session-delete-grace-recovery-mysql # 真实InnoDB未seal来源扫描/原子补seal
pnpm test:usage-lifecycle-mysql       # 强制执行 usage 双写/reconcile/anonymize 的独立真实 MySQL 套件
pnpm test:subject-lifecycle-mysql     # 强制执行 subject gate/erasure request 的独立真实 MySQL 套件
pnpm test:tenant-credential-revocation-mysql  # 强制执行 tenant T1/T2 admission、status proof、credential fence 与 race 的两个真实 MySQL 套件
pnpm test:tenant-credential-physical-revocation-mysql # 强制执行 tenant T3a DB credential清除、global proof、DB-time claim与回滚套件
pnpm test:tenant-credential-lifecycle-mysql # 强制执行 0026 tracking/version/target/T3a inventory、并发与回滚真实MySQL套件
pnpm test:tenant-credential-target-execution-mysql # 强制执行0029真实InnoDB materialize/lease/ACK/cutover/回滚套件
pnpm test:tenant-runtime-revocation-mysql # 强制执行 tenant T3b job/全fleet receipt、claim/ABA、回滚与隔离套件
pnpm test:tenant-content-inventory-mysql # 强制执行 tenant T3c DB-clock/owner inventory/hold/orphan/回滚与隔离套件
pnpm test:tenant-purge-plan-memory    # 强制执行 tenant T3d/0040～0042目录及0044 Memory pre-grant intent/claim原子回滚套件
pnpm test:tenant-purge-plan-mysql     # 强制执行 tenant T3d/0042精确count/root及0044真实InnoDB pre-grant intent/claim套件
pnpm test:tenant-purge-execution-mysql # 强制执行 tenant T3e local cutover/exact outbox/physical ACK/回滚与隔离套件
pnpm test:tenant-database-purge-memory # 强制执行 tenant T3f Memory 原子发布/回滚/grave/0039 owner-closure套件
pnpm test:tenant-database-purge-mysql # 强制执行 tenant T3f 真实 InnoDB 锁/删除/回滚/replay/隔离及0039 owner-closure套件
pnpm test:tenant-redis-purge-memory   # 强制执行 tenant T3g 纯契约/Memory ledger与restore projection套件
pnpm test:tenant-redis-purge-mysql    # 强制执行 tenant T3g 真实 InnoDB ledger/claim/lease/rollback/隔离套件
pnpm test:tenant-redis-purge-redis    # 强制执行 tenant T3g 真实 Redis Lua/marker/replay/防复活套件
pnpm test:tenant-redis-purge-cluster  # 强制执行 tenant T3g mixed worker/namespace与active fleet多进程套件
pnpm test:retention-policy-mysql      # 强制执行 canonical policy/multi legal hold/CAS/rollback/跨 runner 时钟语义的独立真实 MySQL 套件
pnpm test:erasure-purge-policy-mysql  # 强制执行 evaluator/authority、claim ABA、回滚和live evidence/hold重评真实 MySQL 套件
pnpm test:erasure-job-mysql           # 强制执行 erasure claim/lease/audit 的独立真实 MySQL 套件
pnpm test:erasure-session-mysql       # 强制执行 claim-bound session action/rollback 套件
pnpm test:erasure-catalog-mysql       # 强制执行 content-free catalog/completeness proof 套件
pnpm test:erasure-usage-mysql         # 强制执行 claim-bound usage reconcile/ABA/rollback 套件
pnpm test:legacy-tombstone-mysql      # 强制执行 generation-zero compensation/cutover/rollback 套件
pnpm test:user-data-export-mysql      # 强制执行 export snapshot/artifact/download/TTL/撤销清理套件
pnpm check:api                        # OpenAPI、运行时文档与生成 SDK 类型必须完全同步
pnpm check:sdk                        # 编译 SDK、原生 Node import，并检查发布 tarball
```

状态文件和日志写入 `.local-run/`，该目录不提交。`stop` 只发送 SIGTERM，让 runner drain；30 秒仍未退出时脚本会报错并保留现场，不会擅自 SIGKILL。实时测试数量、覆盖率和构建大小以`docs/PROGRESS.md`最新一节和当次CI为准，本文不固化易过期数字。

默认`.env`选择`BLOB_STORE=filesystem`，只启动一个独占`.local-run/blobs`的runner。共享数据面可在没有云账号时用仓库固定版本的MinIO验证：

```bash
scripts/build-local-minio.sh          # 校验并安装固定Go工具链，编译固定MinIO源码commit到.local-run/tooling
# 启用.env.example中从MINIO_ENABLED=1开始的S3配置块；不要提交.env
scripts/local-service.sh start
scripts/local-service.sh smoke
scripts/local-service.sh verify-s3
```

`MINIO_ENABLED=1`只控制`deploy/local/infra.sh start`是否启动MinIO；`infra.sh status`始终观察MinIO，`infra.sh stop`与`local-service.sh down`会尝试停止该脚本拥有的MinIO进程。`local-service.sh stop`只停应用，`verify-s3`也会保留它启动的MinIO，便于继续检查；需要结束全部本地基础设施时显式运行`down`并用`status`确认。`verify-s3`会显式启用MinIO，依次运行真实Blob adapter协议、`0028`真实MySQL+MinIO mover、`0030`真实restore-journal、`0031`真实backup-catalog及`telemetry-s3-object-v1` writer套件，再以独立可丢弃数据库启动源码runner/router。该应用smoke只激活Blob S3并核对dormant schema与credential隔离，不激活telemetry；0053另有独立真实HTTP/MySQL/MinIO capture装配套件，不能把两者混为同一测试。restore、catalog、telemetry分别使用不同于Blob且彼此不同的四个测试bucket，但都由同一台开发机上的同一MinIO进程提供，只能证明S3协议和配置隔离，不能证明生产所需的云IAM/KMS、private access或独立故障域。空库可以直接由首次Blob S3应用启动把`blob_storage_control`从generation 0不可逆激活到1；已有filesystem manifest/bytes的非空库则必须停服并按下文执行`0028`离线搬迁，不能通过手改control/manifest或直接切换`.env`绕过。telemetry S3 target仍受0033生命周期与0053 v2独立activation控制，配置adapter不会自动激活capture或删除authority。

## 模块边界

- `agent-router`：无业务状态，可独立扩缩容。需要能访问全部 runner 的 `RUNNER_ADDR` 和共享 Redis；tenant erasure 的独立 platform token只在这里终止，公开admission/status和fresh all-fleet激活决策也只属于router。`0030`中router只持有三个非密钥restore identity digest与execution gate；`0031`只通过runner capability观察公开catalog namespace/target/runtime-binding digest。它不得持有原始journal/catalog namespace、S3 endpoint、credential或one-shot operator变量。
- `agent-runner`：每个实例必须有全局唯一 `RUNNER_ID`，并发布 router 可访问的 `RUNNER_ADDR`；既有生命周期worker、`0034` telemetry writer及默认关闭的ordinary DELETE grace恢复caller都内嵌于runner。恢复caller只补已提交但未seal的0050来源，不排期或执行purge。telemetry writer默认关闭，可选择本地filesystem或共享S3-compatible adapter。filesystem要求单runner、私有root和显式人工ACK，没有OS lock且production拒绝；S3的`telemetry-s3-object-v1`用create-only对象、闭合checksum envelope、有界read-after-write/exact response-loss与bucket preflight提供managed-capable写入，但不提供删除/恢复。`0035`只给`provider.upstream_request_failed` logs exact producer authority；traces保持inactive。`0028` mover、`0030` restore reconciler和`0031` backup catalog仍是runner镜像内的一次性入口；0053另新增一次性telemetry-capture入口，但不增加长期daemon、服务或镜像。
- MySQL：业务权威及0032/0033 telemetry lifecycle、0034 writer、0035 per-domain application capture、0036默认休眠的disposition账本，以及0038新write的不可变逐项artifact membership/source sidecar。0037只轮换grant claim-hash hard-deny trigger；0038增加表和additive新job guard，不回填历史job、不联网或激活。新sidecar在同一事务先于job绑定0033 inventory、0034 operation/payload、可选0035 binding、coverage/source及写时keyed owner tuple claim；旧job缺失sidecar只能诚实记为unknown。Memory/MySQL仍不签发真实grant；当前没有telemetry disposition activation/worker/CLI，store执行/mirror/fence拒绝，新T3d logs/traces即使有0042精确非零目录target也仍为blocked不可执行。生产schema迁移仍应由独立Job执行，0038前必须关闭相关gate并排空所有pre-0038 writer，之后forward-fix。
- `0044` MySQL/Memory pre-grant账本：两张append-only表只记录新0042 catalog中逐artifact的本地source-bound intent，以及版本、hash token、单调attempt和DB-time租约绑定的claim；两个记录都固定`grantReady=false`。prepare/get/claim每次重新核对T3f terminal/grave、0039～0042证据及当前T1/hold/control/restore，不联网、不读取外部head、marker或Secret，也不放开0037 grant hard-deny。MySQL额外七个guard和严格126-trigger fingerprint要求独立migration前排空pre-0044进程；它不新增第三个服务、产品镜像或runner维护入口。
- `0045`/`0046`/`0048`只提供默认未接入产品的GET-only v2 grant-journal、artifact data/tombstone与v3 journal观察器；`0047` v3 source/claim/restore-bound CAS-head事件链是显式非生产S3夹具。观察结果及fixture记录都不是可信DB grant、物理ACK、恢复围栏或启动许可；不增加服务、CLI、bundle或镜像。真实MinIO测试复用既有telemetry artifact/disposition测试bucket，仍不证明独立故障域或云IAM/KMS。
- `0049`新增default-dormant persisted provider-step failure capture v2三表、13 guards与严格139-trigger启动指纹。logs只预置`provider.upstream_request_failed`契约，traces没有producer，双域control保持inactive/generation 0；coverage/source binding、activation及v2 job path由SQL硬拒，异常footprint会让旧T3d/T3f/v1 writer fail closed。未来source session/turn/item必须写tenant-bound、kind-separated keyed HMAC ref而非raw ID。迁移不回填旧v1、不接线producer、不签发grant或删除；须在全旧writer/事务实际排空后独立迁移，只运行0049-aware进程。
- `0050`新增普通session DELETE 30天保留证据而非执行器：新DELETE的trusted store入口在原tombstone/event/两条outbox事务内写versioned origin，COMMIT后另一事务锁定精确source并在最后读DB时钟，seal保守`observed + 1ms + 30天`下限；失败可同owner exact retry。后续runner-only `SESSION_DELETE_GRACE_RECOVERY_ENABLED`默认`0`；只有显式开启时，内嵌caller才以默认30秒/25条扫描已提交但未seal的来源，并仍由store逐条锁定/复验/CAS封存。router会拒绝这组恢复配置，普通`verify`清除ambient激活；默认关闭不代表自动收敛。损坏候选可阻断同批后续项，尚无逐候选quarantine、专用候选索引或统一whole-operation deadline，staging需压测扫描/锁等待及优雅停止耗时。旧/erasure/legacy origin均unknown，T3f删除session行时证据也消失。五个nullable列与CHECK不增加trigger，0050自身未安装SQL级write-once origin guard，旧writer也未被强制双写；最小权限、schema drift、mixed-writer完整覆盖及更长policy/hold必须在未来执行前核对。`purge_after_ms=NULL`、`session.purge`不可领取，没有自动物理清理或completion。
- `0051`是单独additive SQL write-once guard：`sessions BEFORE UPDATE`要求origin随首次tombstone写入，已有origin及其BINARY tenant/user/session身份、删除generation/time、lastSeq不可改；seal必须在旧行版本已有origin后写入且写成不可改。相关启动指纹集合为140（不是全库trigger总数），0049自身的139-trigger指纹不重释；精确trigger在位时可create-only恢复marker，动作漂移/marker错配在启动时fail closed。它不证明0050两次COMMIT或可信来源，不强制旧DELETE双写，也不禁止T3f删除session整行；无origin仍unknown。`purge_after_ms=NULL`、不可领取的`session.purge`与自动物理清理关闭不变。
- provider失败的公开turn/error event/SSE现在只使用固定`provider_error`与`Provider request failed.`，相关summariser/运行日志也不打印上游异常正文；不再向客户端传递429/rate/URL等原始message，按这些文字分支的客户端需要改为依赖错误码及stopReason。历史已保存原始错误不回填或删除，第三方SDK/Node自行输出仍须独立审计；0053 capture v2仍默认关闭，不因错误脱敏而激活。
- `0039` MySQL/Memory T3f owner-closure：新T3f在同一原子边界先为每条受管telemetry write保存content-free、不可变的owner-closure entry，再与原T3f terminal receipt共同封存aggregate；零write也封存确定性empty-set receipt。MySQL在terminal job更新前要求精确aggregate，失败整事务回滚，缺0038 membership/source或无法重算live canonical owner proof时禁止新T3f删除。旧terminal没有0039 receipt只能记为`unknown`，不回填、不伪造closure或全域完成。迁移不激活disposition、不签发真实grant、不连接外部sink，也不授予delete/restore权；`0037` hard-deny和T3d logs/traces零target blocker仍在。
- Redis：session lease hash（包含owner目录）、fence counter、hot replay stream、瞬时event Pub/Sub和T3g永久purge marker。生产环境必须启用满足恢复目标的持久化/高可用方案，不能把它当可随意清空的缓存；T3g精确清理不使用`FLUSHDB/FLUSHALL`，也不触碰quota/keypool/MCP等其它命名空间。
- BlobStore：filesystem与共享S3-compatible adapter使用同一小写key grammar和`ASBLOB02`单envelope；业务行只保存owner-scoped opaque `blobId`，`0010` manifest私有保存backend/key/token/integrity，`staging → ready`与item commit原子绑定，过期未绑定staging经独立outbox/claim lease物理删除。filesystem以0700/0600、create-only hard link和key-scoped cancellation fence提供本机语义，但root必须由单一runner独占，不承诺NFS/多runner、恶意本机目录替换或断电持久性。S3 adapter以同一对象key的data/tombstone、`If-None-Match: *` create-only发布、`PutObject If-Match` CAS tombstone、强读回验和有界stream读取提供跨进程语义；安全契约不要求`DeleteObject If-Match`，无条件delete只清理随机probe对象。启动会拒绝versioned、配置了任何lifecycle规则、启用Object Lock的bucket及不支持条件PUT的endpoint。`0027`把完整namespace digest与数据库write-once control绑定，并让active control拒绝异backend的新manifest、artifact、part、snapshot pin和delete intent；`0028`再为停服搬迁封存exact inventory并在cutover事务重写这些pointer。生产IAM还必须禁止非服务writer覆盖对象或在运行后添加lifecycle配置，并对这类控制面漂移告警；startup probe不能证明未来配置永不变化。T3e仍只闭合其local Blob/export子集；generic session/user ready-Blob purge与全域completion尚未完成。

## 环境配置原则

本地源码进程、CI 候选镜像和未来部署镜像遵循同一套环境变量契约，不把环境地址或密钥写进构建产物。当前 local 默认运行源码进程；CI 会临时构建并启动两个 OCI 候选镜像，但尚未上传 registry。staging/production 就绪后，各应用才按下述目标 promotion 契约使用同一 digest。

Runner 必需配置：

- `STORE=mysql`、`MYSQL_URL`、`REDIS_URL`
- `REDIS_PREFIX`：Redis session key前缀，默认`as`；T3g把lease/fence/stream/evt/purge放入同一session hash slot。已有T3g evidence后不能随意更改
- `REDIS_NAMESPACE_ID`：operator指定的非密钥逻辑Redis身份；启用T3g worker时必填，与prefix共同计算公开namespace digest。它必须准确、唯一地标识实际cluster/database/prefix，不能在无关namespace复用；URL故意不进入digest
- `SECRETS_MASTER_KEY`（后续替换为 KMS/envelope encryption）
- `RUNNER_ID`：全局唯一；启用 T3b 私有 endpoint 时还必须是该 configured runner slot 跨进程重启保持不变的逻辑身份（例如 StatefulSet ordinal 身份），不能用每次启动随机 UUID 或会随替换变化的 Pod UID
- `RUNNER_ADDR`：集群内可路由地址，不能是 `0.0.0.0`
- `INTERNAL_ROUTER_TOKEN`：router→runner 内部破坏性路由的共享凭证；production 必填，必须从 Secret 注入并与 router 完全一致
- `MAX_BODY_BYTES`：必须与 router 使用相同值；默认 1 MB，由 router 先拒绝超限请求
- `LIFECYCLE_OUTBOX_*`：runner 内置 terminal-event dispatcher 的 poll、claim lease、批量和退避边界；该 dispatcher 只处理 `session.tombstoned`，不是 purge worker
- `DATA_ERASURE_REQUESTS_ENABLED`：user erasure request writer capability，默认 `0`；直接控制新 POST，不撤销 durable gate或停止历史 job。status GET不依赖router writer gate，但仍按runner capability与healthy selected target fail-closed
- `DATA_GOVERNANCE_MANAGEMENT_ENABLED`：canonical retention-policy 与 multi legal-hold 管理端点开关，默认 `0`。置 `0` 只关闭 `/v1/retention-policies*`、`/v1/legal-holds*`，不会撤销已提交的 active policy/hold，也绝不启用 purge；具备 `0015` store contract 的 runner 仍会发布 `canonical-retention-v1`、`multi-legal-hold-v1` 代码感知 capability，管理端点是否已开放则由独立的 `dataGovernanceManagement` boolean 表示
- `PURGE_POLICY_EVALUATOR_ENABLED`：非破坏性policy evaluator开关，默认`0`，必须和router同名gate一起开启。开启后runner才创建worker；但code-aware runner即使gate关闭也会声明`purgePolicyEvaluation=["policy-evaluator-v1"]`。worker只有evaluation store权限，最多写不可执行target/decision/authority，绝不启用`session.purge`、Blob delete、usage anonymize或request completion
- `PURGE_POLICY_EVALUATOR_*`：poll、claim lease、job batch、target page和bounded retry边界。`evidence_changed`会以新build generation清空cursor/count/root后重建，不覆写旧证据；普通临时故障保留当前generation/cursor并重试
- `DATA_EXPORT_REQUESTS_ENABLED`：新user-export POST admission，默认`0`；要求admin key、明确user、Idempotency-Key和active policy中的正值`exportArtifactTtlMs`。关闭只拒绝新请求，不停止已有job、status或ready artifact下载
- `DATA_EXPORT_WORKER_ENABLED`、`DATA_EXPORT_CLEANUP_ENABLED`：runner内嵌build与artifact cleanup循环，产品默认`0`、local默认`1`；admission要求二者均开启。build在一致性数据库快照后生成确定性NDJSON分片，cleanup只按exact artifact identity处理独立delete outbox
- `DATA_EXPORT_*`：还包括poll、claim/download lease、snapshot page、staging TTL、batch与bounded retry。download lease总寿命有硬上限；普通TTL等待活动下载，erasure/revocation可取消下载并优先清理
- `TENANT_TELEMETRY_WRITER_ENABLED`：0034内嵌writer，默认`0`。0033 lifecycle一旦active，每个runner都必须以完全相同的target/ref-key配置开启；这仍不等于0035 application capture active。
- `TENANT_TELEMETRY_WRITER_ADAPTER=filesystem`与`TENANT_TELEMETRY_FILESYSTEM_*`：仅供本地单runner。必须显式提供私有目录、namespace/failure-domain identity并确认`TENANT_TELEMETRY_FILESYSTEM_SINGLE_RUNNER=1`；该确认不是自动证明，adapter无OS级跨进程锁，production会拒绝启动。deterministic operation staging在exact ACK前清理并fsync，正常durable job replay可恢复；但没有全目录startup sweeper，DB/job非原子丢失仍可能留下staging，属于restore/delete生命周期边界。
- `TENANT_TELEMETRY_WRITER_ADAPTER=s3`与`TENANT_TELEMETRY_S3_NAMESPACE_ID`、`TENANT_TELEMETRY_S3_FAILURE_DOMAIN_ID`、`TENANT_TELEMETRY_S3_BUCKET`、`TENANT_TELEMETRY_S3_PREFIX`、region/endpoint/addressing/private-ACK/request-timeout配置：runner-only共享writer target。custom endpoint在production必须是无credential的HTTPS origin；private-bucket ACK默认`0`，只能在独立验证匿名/public访问、IAM与policy后显式改为`1`，本地和production保持`0`都会fail closed。应用不会自动证明这些事实。target identity绑定content-free bucket/prefix/region/endpoint mode/namespace/failure-domain，不含credential。startup probe要求对`<prefix>/_agent_service_probe/*`具有Put/Get/Head/Delete；artifact写入仍只需create/read，Delete不得扩展到artifact key。response-loss或deadline耗尽可能留下content-free probe orphan，当前需监控并以受限operator权限清理。
- `TENANT_TELEMETRY_S3_ACCESS_KEY_ID`、`TENANT_TELEMETRY_S3_SECRET_ACCESS_KEY`与可选`TENANT_TELEMETRY_S3_SESSION_TOKEN`：只进入runner；也可使用受控provider chain。不得注入router、写入target identity或回显到日志。local-service会把telemetry bucket与Blob/restore/catalog bucket保持分离，并阻止这些credential进入router。
- `TENANT_TELEMETRY_REF_KEY`：仅供长期runner的0033 active exact 32-byte hex key，不得提交、打印或回显。一次性operator不能使用此环境输入，改用下文protected raw file；0035 v1与traces不得激活，0053独立v2 logs只由受控CLI启用。
- `PERSISTED_PROVIDER_FAILURE_CAPTURE_ENABLED`：runner-only、默认`0`，仅非生产且MySQL+稳定显式`RUNNER_ID`+S3 writer可开启；active v2要求真实DB exact control/receipt/key/target/0030 epoch，不能退回stdout或v1。
- `PERSISTED_PROVIDER_FAILURE_CAPTURE_FLEET_ENABLED`：router-only、默认`0`，非生产fresh configured-fleet gate；runner会拒绝或剥离该对端变量，router不持有key或S3 credential。每次请求核对全configured直连origin的nonce、唯一runner/boot和完整binding，不用cached readiness或healthy子集。
- `SESSION_DELETE_GRACE_RECOVERY_ENABLED`、`SESSION_DELETE_GRACE_RECOVERY_POLL_MS`、`SESSION_DELETE_GRACE_RECOVERY_BATCH_SIZE`：只属于runner的0050未seal来源恢复caller，默认分别为`0`、`30000`、`25`；batch上限100、poll上限300000ms。普通本地`start`保持关闭，`verify`清除ambient启用，router配置拒绝整组变量。只有在0050 schema、新writer与旧writer排空均核对后才可逐实例显式开启；它不安排或执行物理清理，坏候选可能阻断该批且停机须等待in-flight扫描。
- `ERASURE_WORKER_ENABLED`、`ERASURE_ROUTER_URL`：内嵌 durable worker及私有 router origin；产品默认 worker=`0`，local 显式设为 `1`，与 admission 独立。worker在每次claim前调用token-protected v2 router barrier，未获得固定ACK就不接触数据库queue；最多推进到 `awaiting_purge_policy`，不执行 anonymize/purge/completed
- `LEGACY_TOMBSTONE_COMPENSATION_ENABLED`：内嵌 generation-zero compensation worker；产品默认 `0`，local 显式 `1`。首次通过 v2 barrier 后可能激活 write-once cutover，之后不能再运行 pre-`0014` writer。`DATA_ERASURE_REQUESTS_ENABLED=1` 要求它与 `ERASURE_WORKER_ENABLED` 都为 `1`
- `LEGACY_TOMBSTONE_COMPENSATION_*`：compensation poll、claim lease、batch 和 bounded retry；只补齐 terminal proof/outbox/audit，不使 purge 可领取、不删除内容
- `ERASURE_WORKER_*`：poll、claim lease、job batch、session page、retry 与单次私有 router 请求超时；`ERASURE_WORKER_REQUEST_TIMEOUT_MS` 默认 20s
- `ERASURE_DRAIN_TIMEOUT_MS`：runner 内部等待 active turn 到安全边界的上限，默认 10s。部署必须保持 `ERASURE_DRAIN_TIMEOUT_MS < router UPSTREAM_HEADER_TIMEOUT_MS < ERASURE_WORKER_REQUEST_TIMEOUT_MS`（当前默认 10s < 15s < 20s），否则外层先超时会破坏 drain 的可判定性
- `TENANT_ERASURE_REQUESTS_ENABLED`：tenant erasure 的 runner-local admission gate，默认 `0`。即使关闭，code-aware runner 仍声明 `platform-control-v1`；开启时必须配置 `ERASURE_ROUTER_URL`，每次建立不可逆 tenant gate 前都取得 fresh router ACK。status与精确已提交POST的read-only replay不依赖该 gate；0030 generation `0`沿用已提交replay返回`202`的旧语义，0030 active后create/exact replay在terminal publication receipt可读前都返回可重试`503`，即使T1可能已经提交；调用方必须以相同tenant/body/`Idempotency-Key`重试。未命中的replay不会创建
- `TENANT_ERASURE_BARRIER_TIMEOUT_MS`：runner 请求 tenant admission barrier 的单次超时，范围 100–10000 ms，默认 2000 ms
- `TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED`：T3a runner内嵌credential-store worker gate，默认`0`，与新admission解耦。code-aware runner即使关闭也声明`tenantCredentialRevocation=["credential-store-v1"]`，开启后才声明worker-active并接触独立queue；它只删除本地DB API-key/provider行和清空tenant auth三列，不处理runtime/external/content
- `CREDENTIAL_LIFECYCLE_TRACKING_ENABLED`：`0026` versioned inventory的forward-only activation/observation gate，router/runner默认`0`；本地统一脚本仅在调用方未显式设置时默认`1`，便于可丢弃本地库完整运行。production不得照抄本地默认：必须先迁移、以`0`滚动全部ledger-aware writer并排空旧writer、核对全fleet `versioned-target-ledger-v1`，再先显式激活runner tracking、确认全runner active，最后开启router tracking gate。tracking active后不得回退pre-0026 writer；该flag不代表external/KMS adapter可执行
- `TENANT_CREDENTIAL_TARGET_EXECUTION_WORKER_ENABLED`：`0029` runner内嵌worker gate，默认`0`。开启时还要求tracking active、`ERASURE_ROUTER_URL`和可用adapter；worker只处理terminal T3a/0026证明中的external target，不接触KMS或全域completion
- `CREDENTIAL_TARGET_EXECUTION_ADAPTER`：当前唯一值`fake`，只允许`STORE=memory`且禁止`NODE_ENV=production`；用于隔离测试/故障注入，不是MySQL持久adapter或真实provider证明。标准`scripts/local-service.sh start`使用MySQL，会拒绝该变量或任一0029 gate非零，并传给runner的worker gate固定为`0`
- `TENANT_CREDENTIAL_TARGET_EXECUTION_*`：poll、claim lease、worker/materialize batch与bounded retry边界。fake的reference crypto与adapter state只用于本地进程内测试，不得把其opaque reference、密钥或故障配置写入文档/日志
- `RESTORE_JOURNAL_ADAPTER=s3`、`RESTORE_JOURNAL_DATABASE_NAMESPACE_ID`、`RESTORE_JOURNAL_RUNTIME_EPOCH_ID`、`RESTORE_JOURNAL_NAMESPACE_ID`、`RESTORE_JOURNAL_FAILURE_DOMAIN_ID`和`RESTORE_JOURNAL_INDEPENDENT_FAILURE_DOMAIN_ACK`：`0030` runner-only journal/runtime identity。启用时要求`STORE=mysql`；四个原始ID不进入router。independent ACK只能在外部验证journal确实位于primary database之外的独立故障域后设置；local同机MinIO即使使用不同名bucket也只是协议夹具
- `RESTORE_JOURNAL_S3_*`：独立journal target的endpoint、region、bucket、prefix、path-style、timeout、private-bucket ACK和credential。bucket必须与Blob bucket不同；production endpoint必须HTTPS且private-bucket ACK需要外部证据。当前runtime配置精确支持一个target，不能把同一个S3服务里的多个prefix描述成多个独立故障域
- `TENANT_RESTORE_JOURNAL_WORKER_ENABLED`：runner内嵌publisher gate，默认`0`；开启要求完整journal配置与`ERASURE_ROUTER_URL`。journal control一旦激活，所有runner必须保持该worker为`1`，否则startup preflight拒绝服务。worker只把已提交T1 fence发布到独立journal并持久化exact ACK，不创建backup或声称tenant erasure完成
- `TENANT_RESTORE_JOURNAL_*`：poll、DB-time claim lease、worker/materialize batch与bounded retry。lease必须覆盖tenant fleet barrier timeout、一次外部journal请求timeout及1000 ms余量；每个外部发布边界以fresh router ACK保护，MySQL与S3之间通过saga/response-loss exact replay收口，不是分布式事务
- `BACKUP_CATALOG_ADAPTER=s3`、`BACKUP_CATALOG_DATABASE_NAMESPACE_ID`、`BACKUP_CATALOG_NAMESPACE_ID`、`BACKUP_CATALOG_FAILURE_DOMAIN_ID`和`BACKUP_CATALOG_INDEPENDENT_FAILURE_DOMAIN_ACK`：仅供`0031` one-shot CLI的catalog identity。要求`STORE=mysql`；failure-domain ACK只能在独立验证catalog位于primary database之外后设置，本地MinIO第三个bucket不满足生产证明
- `BACKUP_CATALOG_S3_*`：catalog endpoint、region、bucket、prefix、path-style、request timeout、private-bucket ACK与可选静态credential。catalog bucket必须同时不同于Blob与restore-journal bucket；production custom endpoint必须HTTPS，private-bucket ACK仍只是外部检查后的operator确认。长期router/runner会剥离这些变量
- `BACKUP_CATALOG_MINIMUM_RETENTION_MS`、`BACKUP_CATALOG_MINIMUM_RECOVERABLE_BACKUPS`：activation时必填的forward-only retention policy输入；前者按MySQL时间约束eviction，后者至少为1。后续命令必须与active control完全一致，不能通过降低配置绕过已提交policy
- `TENANT_RUNTIME_DRAIN_ENABLED`：T3b runner-local 私有endpoint gate，默认`0`。code-aware runner在关闭时仍声明`runtime-drain-v1`，但endpoint不可用；开启时必须显式配置稳定`RUNNER_ID`
- `TENANT_RUNTIME_REVOCATION_WORKER_ENABLED`：T3b durable queue worker gate，默认`0`，且要求`TENANT_RUNTIME_DRAIN_ENABLED=1`与`ERASURE_ROUTER_URL`。它只由terminal T3a proof显式materialize `0020` job，调用router对全部configured targets广播，不执行content purge或completion
- `TENANT_RUNTIME_DRAIN_TIMEOUT_MS`、`TENANT_RUNTIME_REVOCATION_*`：本地等待active auth/provider/turn结算的上限，以及worker→router请求、poll、lease、batch和有界退避参数。必须保持local drain timeout小于worker请求timeout，超时后tenant仍保持本地fenced并只允许同一durable identity重试
- `TENANT_CONTENT_INVENTORY_WORKER_ENABLED`：T3c runner内嵌worker gate，默认`0`且不需要router执行端点。它只从terminal T3b proof建立`0021` DB-clock结构清单，store接口没有删除/匿名化能力；关闭只暂停新claim，不撤销已提交receipt
- `TENANT_CONTENT_INVENTORY_*`：poll、DB-time claim lease、materialize/job batch、session page和bounded retry参数。seal当前会以RR共享锁扫描全库五类content关系；这是local/CI正确性基线，不能在未完成索引/FK/分区和容量验证前宣称可扩展生产执行
- `TENANT_PURGE_PLAN_WORKER_ENABLED`：T3d runner内嵌planning worker gate，默认`0`且不需要router执行端点。它只从terminal T3c及完整immutable source建立`0022`固定33域content-free plan；store接口没有delete/anonymize/revoke/completion能力，关闭只暂停新claim
- `TENANT_PURGE_PLAN_*`：poll、DB-time claim lease、worker/materialize batch和bounded retry参数。生产worker不调用分页build，而是直接在一个原子seal中发布33域；store的domain-page API只供诊断/兼容，没有对应生产worker分页参数。catalog顺序与集合是协议常量，不能按adapter可用性裁剪；缺失Blob/export bytes、Redis、backup/restore、logs/traces或legacy external source必须写显式blocker
- `TENANT_PURGE_EXECUTION_WORKER_ENABLED`：T3e runner内嵌local execution/physical-ACK worker gate，默认`0`。code-aware runner即使关闭也声明`tenantPurgeExecution=["local-execution-ack-v1"]`，开启后才声明worker-active并接触`0023`独立queue；它只执行operational usage去身份化、Blob/export exact outbox、export revoke/download lease清除、snapshot pin release及completed outbox的physical ACK，固定不能声明全域完成
- `TENANT_PURGE_EXECUTION_*`：poll、DB-time claim lease、materialize/job batch与bounded retry。每个materialize、claim、lease、local cutover和physical seal边界都先请求router的fresh non-sticky all-configured ACK；pending physical ACK使用独立可重试状态，exact outbox dead-letter会原子阻断job而不是记成功
- 开启`TENANT_PURGE_EXECUTION_WORKER_ENABLED=1`还强制要求`BLOB_CLEANUP_ENABLED=1`与`DATA_EXPORT_CLEANUP_ENABLED=1`；filesystem模式另外要求`BLOB_FILESYSTEM_SINGLE_RUNNER=1`，S3模式则要求下述write-once control和共享namespace已经精确激活。T3e仍只是局部physical ACK，不能因此开放全域completion
- `TENANT_DATABASE_PURGE_WORKER_ENABLED`：T3f runner内嵌本地数据库内容/控制投影清理worker gate，默认`0`，且与T3e gate独立。code-aware runner同时声明`local-execution-ack-v1`与`local-db-content-delete-v1`，开启worker后才接触`0024`队列；它清理固定11个MySQL/Memory域并保留匿名billing facts，不清Redis、外部provider/KMS、backup/restore、logs/traces或全域completion
- `TENANT_DATABASE_PURGE_*`：poll、DB-time claim lease、materialize/job batch和bounded retry。materialize、claim、renew、destructive execute与模糊响应replay每个边界都取fresh no-store fleet ACK；单个Memory staged publication或MySQL `REPEATABLE READ`事务同时发布pre-delete证据、永久session grave、删除动作、exact ACK、terminal job/receipt和cutover，失败或lease丢失整体回滚
- `TENANT_REDIS_PURGE_WORKER_ENABLED`：T3g runner内嵌session-state Redis清理worker gate，默认`0`且与T3e/T3f gate独立；启用要求`STORE=mysql`、`REDIS_URL`、`REDIS_NAMESPACE_ID`和`ERASURE_ROUTER_URL`。code-aware runner声明`tenantRedisPurge=["session-state-delete-v1"]`及namespace digest，worker开启后才接触`0025` queue。任一durable T3g job或cutover已存在时关闭worker会使runner拒绝启动，因为未ACK marker也必须靠轮询收口。worker lease必须至少为barrier timeout的两倍再加1000 ms；worker还会在第二次fresh proof后检查续租耗时未超过lease的一半，超限时不进入Redis mutation
- `TENANT_REDIS_PURGE_*`：poll、DB-time claim lease、materialize/job batch、target/restore page、bounded retry与`TENANT_REDIS_PURGE_RESTORE_INTERVAL_MS`。runner在监听/ready前只重放已有durable target ACK的marker并周期重放；未ACK target在worker轮询后先执行existing-marker-only同slot原子replay，只有exact marker存在才按原bits再次删除三域，marker缺失零修改。namespace mismatch、marker conflict或Redis证据损坏fail startup或阻止新destructive work。fresh no-store fleet ACK只用于materialize和新的Redis mutation，mutation前固定`gate → renew claim → gate`；claim、existing-marker replay、ACK持久化/精确重放、durable restore与全ACK seal不取destructive gate
- `BLOB_STORE`：`filesystem`（默认）或`s3`。S3要求`STORE=mysql`，因为共享namespace cutover必须持久化；filesystem不得开启`BLOB_STORAGE_CONTROL_ENABLED`
- `BLOB_NAMESPACE_ID`：operator分配的非密钥逻辑对象存储身份；与`BLOB_S3_BUCKET`、`BLOB_S3_PREFIX`共同生成完整namespace SHA-256。endpoint刻意不进入digest，以允许同一服务别名切换；bucket/prefix/namespace id变化则是数据迁移，不能直接改配置
- `BLOB_STORAGE_CONTROL_ENABLED`：共享S3模式必须为`1`。runner在HTTP listener和worker之前以`0027`执行generation `0 → 1`一次性激活或精确观察；激活后filesystem或其它backend/namespace启动失败，只能forward-fix
- `BLOB_S3_ENDPOINT`、`BLOB_S3_REGION`、`BLOB_S3_BUCKET`、`BLOB_S3_PREFIX`、`BLOB_S3_FORCE_PATH_STYLE`、`BLOB_S3_REQUEST_TIMEOUT_MS`：S3数据面连接与有界请求配置。每个SDK command从credential/endpoint provider解析到全部transport尝试共享一个外层deadline，并在到期时abort底层请求；响应body另以同一配置值限制完整读取阶段。production自定义endpoint必须使用HTTPS，bucket必须从未启用versioning、没有任何lifecycle配置且未启用Object Lock，并支持`If-None-Match: *` create-only与`PutObject If-Match` CAS；不要求`DeleteObject If-Match`
- `BLOB_S3_ACCESS_KEY_ID`、`BLOB_S3_SECRET_ACCESS_KEY`、可选`BLOB_S3_SESSION_TOKEN`：runner-only credential；也可不设置而使用受控的标准AWS provider chain。router不得接收这些变量，本地统一脚本还会清除常见AWS/MinIO provider-chain变量
- `BLOB_S3_PRIVATE_BUCKET_ACK`：production S3必须为`1`，但它只是operator确认“已独立验证匿名/public访问被拒且IAM/policy正确”，不是应用自动证明。local MinIO保持`0`；CI真实MinIO套件另行执行anonymous raw GET拒绝用例
- `BLOB_DIR`：filesystem adapter的服务独占root；本地脚本默认`.local-run/blobs`，多runner/NFS语义未受支持，不能复制充当生产对象存储
- `BLOB_FILESYSTEM_SINGLE_RUNNER`：filesystem 模式的显式安全确认；write 或 cleanup 任一启用时都必须为 `1`。它只表示操作者承诺恰好一个 runner 独占该 root，不提供分布式互斥
- `BLOB_CLEANUP_ENABLED`：stale staging cleanup worker 开关；本地默认 `1`。当前 filesystem adapter 在 production 即使 cleanup-only 也会拒绝启动，防止任一 runner领取全局 outbox 后误删/漏删本机之外的数据
- `BLOB_ATTACHMENTS_ENABLED`：新 Blob 上传和大工具输出卸载的 writer gate；依赖 cleanup 已开启，本地默认 `1`；当前 filesystem adapter 在 production 会拒绝启动
- `BLOB_MAX_BYTES`、`BLOB_MAX_HYDRATED_BYTES`、`BLOB_TOOL_OUTPUT_THRESHOLD_BYTES`、`BLOB_STAGING_TTL_MS`：单对象、模型上下文水合、工具输出卸载和未绑定 staging 保留边界；`BLOB_MAX_BYTES` 不得超过 `MAX_BODY_BYTES`
- `BLOB_CLEANUP_*`：专用 Blob delete outbox worker 的 poll、claim lease、批量、退避和确定性 poison 上限；普通短暂故障不会因达到 poison 上限而丢弃
- `MIGRATION_ID`、`FLEET_DRAINED_EVIDENCE_SHA256`、`ROLLBACK_WINDOW_MS`、`SOURCE_CLEANUP_DELAY_MS`：仅供`0028`一次性mover的`prepare`/`run`使用。migration id必须稳定且每次attempt唯一；fleet digest是外部停服/排空证据的64位小写SHA-256，不是应用自动attestation；两个delay按MySQL时间解释且不可为负
- `MAX_OBJECT_BYTES`：`0028`维护入口读取、复制和回验单对象的硬上限，默认64 MiB、最大1 GiB；它与普通runtime的`BLOB_MAX_BYTES`不是同一配置，超限会在发布inventory/target ACK前fail closed
- `BLOB_MIGRATION_COMMIT`：只影响`run`命令，默认`0`并停在`verified`；显式设为`1`才在copy/verify后尝试cutover。即使为`1`也绝不自动执行`cleanup-source`
- `RESTORE_RUN_ID`、`RESTORE_FLEET_STOPPED_ACK`、`SOURCE_BACKUP_SHA256`、`RESTORE_REPLAY_PAGE_SIZE`与`RESTORE_JOURNAL_PRIMARY_ACTIVATION_ACK`：只供0030 restore CLI及0031明确复用停服证明的operator命令。restore run必须为全新、小写的`restore_<UUIDv4>`，不是裸UUID；fleet ACK是人工停服确认，不是自动attestation。primary activation必须同时提供primary-activation与fleet-stopped ACK，并显式声明`BLOB_STORE=filesystem`，或声明`BLOB_STORE=s3`及`BLOB_S3_BUCKET`；S3 Blob bucket必须与journal bucket不同，无法证明时在连接MySQL/S3前fail closed。0031的`prepare-eviction`与`record-eviction`也都要求该ACK，并要求从prepare前到record提交后持续停服。source digest必须与0031已选catalog entry/source binding完全一致；page size范围1–1000。这些变量会从长期runner/router进程中剥离，不能作为绕过0031的独立来源authority
- `BACKUP_ID`、`BACKUP_RUNTIME_EPOCH_ID`及各backup/restore/eviction evidence变量：只供`0031`一次性CLI。ID和evidence必须来自受控backup系统/当次operation并在响应丢失后原样重试；不得通过命令行参数传DSN、endpoint、locator、header或credential，也不得把这些值注入长期router/runner
- `BOOTSTRAP_API_KEY`仅限local/test；production必须拒绝该开发便利入口
- `ADMIN_BOOTSTRAP_TENANT`与`ADMIN_BOOTSTRAP_OUTPUT_FILE`：first-admin只允许受控one-shot runner同时设置这两个变量；output path必须为operator预先准备目录中的绝对路径，并以create-only `wx`、`0600`、文件与父目录`fsync`写入唯一key，绝不覆盖既有文件，也不在日志中输出tenant、path或key。它与`BOOTSTRAP_API_KEY`互斥，router拒绝接收output-file变量。当前文件互斥只覆盖同一共享文件系统，不是跨VM/Pod singleton；多主机生产流程仍需后续独立CLI/Job加数据库singleton claim，不能把这两个变量注入所有常驻runner

`TENANT_ERASURE_OPERATOR_TOKEN` 和 `TENANT_ERASURE_OPERATOR_ID` 是 router-only 配置；runner 不应接收 platform token，本地统一脚本会在启动 runner 时显式移除它。`DATA_ERASURE_REQUESTS_ENABLED` 仍只控制 user erasure，不能代替 tenant 开关。T3a worker只清除本地DB credential material，其receipt保持`runtimeDisposition=not_in_scope`、`externalDisposition=not_supported`、`contentPurgeRequired=true`。`0026`在同一T3a事务附加versioned inventory sidecar；受信任服务端provider写入可原子保存不含secret/header/URL/明文locator的受保护external target reference，legacy/source缺失目标仍保持blocker，KMS仍不可执行。`0029`从该精确source建立独立external target execution/ACK账本，但当前只有Memory-only非生产fake，标准MySQL本地栈不启用它，不能宣称远端撤销完成。T3b～T3g继续分别证明runtime、结构清单、33域plan、local usage/Blob/export、11个数据库投影与session-scoped Redis切片。所有terminal receipt仍固定`allDomainsComplete=false`、`contentPurgeExecuted=false`；0029还固定`kmsKeyExecutionComplete=false`。公开status保持`gated`、`dataPurgeExecution=false`，不能称为completed。

first-admin文件在数据库写入前发布，是为避免“数据库已有有效key但输出丢失”的不可恢复状态。若文件已成功写入而后续数据库操作失败或结果不明确，runner会fail closed并保留该文件；operator必须核对数据库状态后人工处置，应用不会自动删除、重写或在日志中回显。成功导入真正Secret manager并验证key后，应移除`ADMIN_BOOTSTRAP_TENANT`与`ADMIN_BOOTSTRAP_OUTPUT_FILE`再重启常驻runner。

`0028`维护配置只允许通过环境变量提供；CLI不接受DSN、filesystem path、endpoint、credential或namespace作为命令行参数。`status`只需要`MYSQL_URL`并使用独立非排他连接；其它命令按需要创建`BLOB_DIR` source与`BLOB_NAMESPACE_ID + BLOB_S3_BUCKET + BLOB_S3_PREFIX` target，S3 region、endpoint、path-style、private-bucket ACK、request timeout和credential沿用上面的runner-only契约。统一脚本会在加载`.env`前快照调用方显式提供的`NODE_ENV`、MySQL/migration/delay/limit、source/target/S3/credential变量和全部已导出的`AWS_*`，加载后再原样恢复；显式空字符串同样具有优先级，只有调用方未设置的变量才取`.env`。这避免本地默认值把一次性维护操作静默指向另一数据库或namespace，也保证显式`BLOB_MIGRATION_COMMIT=0`不会被`.env`改成`1`。CLI只输出不含locator或异常原文的有界JSON摘要/固定错误码，不得在操作记录、文档或工单中回显环境变量值。

`0030` restore CLI使用同样的环境-only authority边界，命令行只接受`status`、`activate-journal`、`prepare`、`replay-fences`、`verify`、`activate-runtime`、`abort`或`run`。`status`不构造object-store client；`verify`和`abort`也是DB-only恢复边界；其余命令要求完整runner-only journal配置并执行外部startup检查。所有命令使用verify-only store连接，要求完整migration marker集合且不执行DDL；0030 marker存在时还校验精确schema/trigger fingerprint，并在成功或失败后恢复临时调整的MySQL session `group_concat_max_len`。restore S3 client忽略AWS环境变量/shared profile配置的endpoint；durable target identity绑定受控region及normalized custom endpoint或明确的standard-endpoint模式。统一脚本在读取`.env`前快照并恢复所有`RESTORE_JOURNAL_*`、`TENANT_RESTORE_JOURNAL_*`、restore-run/backup/ACK变量及`AWS_*`，显式空值同样优先，且输出只含content-free计数、phase和固定错误码。禁止在shell history、工单或日志中粘贴DSN、endpoint、credential或原始错误。

`0031` backup-catalog CLI也只接受环境变量authority；旧metadata command为`status`、`activate`、`begin-backup`、`publish-backup`、`list`、`prepare-restore`、`resolve-restore`、`prepare-eviction`、`record-eviction`或`reconcile`。统一入口是`pnpm maintenance:backup-catalog -- <command>`。`status`和`list`只输出content-free identity/count/phase，绝不打印locator或credential；其它命令按各自边界要求完整catalog target、operation ID与evidence。统一脚本会在读取`.env`前快照并恢复全部`BACKUP_CATALOG_*`、`TENANT_BACKUP_CATALOG_*`和相关operation变量，显式空值同样优先；长期runner/router均动态剥离这些变量，router配置还会主动拒绝泄漏。catalog使用与Blob、journal不同名的S3-compatible bucket，不能复用二者；本地同机bucket分离不代表生产故障域独立。 新增`create-artifact/verify-artifact/restore-selected`的local-only配置、真实DDL import与first-attempt边界见下文“本地MySQL加密逻辑备份制品”，不能套用旧命令的自动exact replay导入。

Router 必需配置：

- `RUNNERS`：每个 runner 实例稳定、可达的 base URL 列表；不能填会在同一 URL 后随机选择多个版本 Pod 的普通负载均衡 Service，服务发现必须展开为实例地址
- `REDIS_URL`：与 runner 相同的逻辑 Redis 集群
- `REDIS_PREFIX`、`REDIS_NAMESPACE_ID`：必须与全部runner一致并准确标识同一个logical Redis cluster/database/prefix；router使用二者计算T3g期望namespace digest。启用T3g gate时namespace id必填，不能用URL变化代替受审计的逻辑身份迁移
- `INTERNAL_ROUTER_TOKEN`：与全部 runner 完全一致的共享凭证；router 会剥离客户端伪造的同名及全部`x-agent-service-*` header，只对显式allowlist中的版本化私有控制路由重新注入（包括tombstone、user-erasure drain/barrier、purge-evaluator barrier及tenant admission/status/replay），普通tenant代理永不注入
- `SESSION_TOMBSTONE_ENABLED`：显式 expand→activate 开关；local 脚本默认 `1`，staging/production 发布时默认保持 `0`，且 router 仍会要求全部健康 runner 声明 `tombstone`
- `DATA_ERASURE_REQUESTS_ENABLED`：user erasure writer gate，local/staging/production 默认都是 `0`。POST 还要求 `RUNNERS` 中全部 configured targets 均已健康探测并声明 capability，且选中 target 仍支持；暂时不可达的已配置实例也会阻断激活。状态 GET 不依赖这个 router writer gate，继续按当前 healthy fleet/selected target capability 规则 fail-closed；writer gate 开启时，所有 user-scoped runtime 每次转发都复核 selected target capability。另有不公开的 v2 worker barrier 要求本 router 进程曾逐一观察每个稳定地址同时声明 `quarantine-v1` 与 `legacy-tombstone-compensation-v1`；旧 v1 私有路径故意 404，不提供降级 fallback
- `TENANT_ERASURE_REQUESTS_ENABLED`：tenant erasure 新admission与私有 admission ACK 的 router gate，默认 `0`。开启后仍要求每个 configured 稳定 runner 当前健康、声明 `platform-control-v1` 且本地 tenant gate 已开；status GET与精确已提交POST的read-only replay和该gate解耦，但必须选到健康且code-aware的target。0030 generation `0`时精确已提交replay沿用原`202`；0030 active后，create可能已提交T1，但create/exact replay在publication receipt可读前均返回可重试`503`，receipt读取失败也fail closed，调用方必须以完全相同tenant/body/`Idempotency-Key`重试，receipt后才返回同一`202`。gate关闭时未知/不同key返回`503`且绝不创建；router一旦为请求选择replay模式，即使gate途中开启也不能升级到create
- `TENANT_CREDENTIAL_REVOCATION_EXECUTION_ENABLED`：T3a独立execution barrier gate，默认`0`；router自身还必须开启`CREDENTIAL_LIFECYCLE_TRACKING_ENABLED`，且全部configured稳定runner当前健康、声明`versioned-target-ledger-v1`、观察tracking active、理解`credential-store-v1`并且本地worker-active时，才返回token-protected固定ACK。它不控制新admission，也不改变公开tenant status或`dataPurgeExecution=false`
- `TENANT_CREDENTIAL_TARGET_EXECUTION_ENABLED`：`0029` external-target fresh barrier gate，默认`0`；要求router自身tracking active，并逐次刷新全部configured稳定runner，确认其声明`external-credential-execution-v1`且worker-active后才返回no-store ACK。该gate不授权KMS、content purge或completion；标准MySQL local-service固定传`0`
- `RESTORE_JOURNAL_NAMESPACE_SHA256`、`RESTORE_JOURNAL_TARGET_ROOT_SHA256`、`RESTORE_JOURNAL_RUNTIME_EPOCH_SHA256`：router唯一允许接收的`0030` identity，三者必须一起配置并与全部runner capability精确一致。它们是公开非密钥digest，不是原始namespace、endpoint、account或credential；原始`RESTORE_JOURNAL_*`配置在router启动边界会被清除
- `TENANT_RESTORE_JOURNAL_EXECUTION_ENABLED`：`0030` fresh publication barrier gate，默认`0`；要求三个identity digest齐全，并逐次确认全部configured稳定runner健康、声明`independent-restore-journal-v1`、identity精确一致且publisher worker-active。它只授权紧邻的T1 journal materialize/claim/publication边界，不授权backup、restore activation、T3a或全域completion
- `TENANT_PURGE_EXECUTION_ENABLED`：T3e独立execution barrier gate，默认`0`；每次私有请求都会刷新全部configured稳定runner，只有其当前健康、理解`local-execution-ack-v1`且本地worker-active时才返回token-protected固定ACK。该ACK只授权紧邻的有界local execution边界，不改变公开`dataPurgeExecution=false`，也不能证明任一未ACK domain完成
- `TENANT_DATABASE_PURGE_ENABLED`：T3f独立database-content barrier gate，默认`0`；要求全部configured runner当前健康、同时声明`local-execution-ack-v1`与`local-db-content-delete-v1`，且T3f worker-active。固定ACK必须带`Cache-Control: no-store`，只授权紧邻的单一worker边界，不继承T3e的启用状态
- `TENANT_REDIS_PURGE_ENABLED`：T3g独立Redis session-state destructive barrier gate，默认`0`；要求全部configured runner当前健康、声明`session-state-delete-v1`、T3g worker-active且namespace digest与router预期完全一致。每次ACK都fresh、non-sticky并带`Cache-Control: no-store`，只授权紧邻的materialize或新Redis mutation边界；关闭它不会撤销既有marker，也不会阻断claim、existing-marker-only replay、补ACK/seal或durable restore，因此仍不允许关闭runner worker
- `TENANT_RUNTIME_DRAIN_EXECUTION_ENABLED`：T3b router broadcast gate，默认`0`。开启后仍必须对`RUNNERS`中每个精确、直连的稳定URL在fanout前后重新探测，要求唯一`RUNNER_ID`和每进程随机`bootId`在整个操作中不变。任一target不可达、endpoint关闭、身份重复/变化、ACK/proof不匹配均整体fail closed，不使用healthy subset、hash-ring owner、sticky attestation或负载均衡别名
- `TENANT_ERASURE_OPERATOR_TOKEN`：独立 platform bearer，只能注入 router；开启 tenant gate 时必填，长度 32–256 且只接受 token-safe 字符，必须与 `INTERNAL_ROUTER_TOKEN`/`ROUTER_ADMIN_TOKEN` 不同。为使 admission 关闭后仍可读取已建立 request 的 status，运维期间仍应配置它
- `TENANT_ERASURE_OPERATOR_ID`：写入首条 audit 的稳定、非秘密 actor ID，不是凭据
- `DATA_GOVERNANCE_MANAGEMENT_ENABLED`：router 的独立管理面 gate，默认 `0`。即使置 `1`，也只有在每个 configured `RUNNERS` 稳定地址当前健康、同时声明 `canonical-retention-v1`、`multi-legal-hold-v1` 且 runner 自身 `dataGovernanceManagement=true` 时才开放；每次发送前还会复核选中 target。router 对外 capability 中 `dataGovernance` 表示全 fleet 已理解并会遵守 durable policy/hold，`dataGovernanceManagement` 才表示管理 API 已激活，二者不能混为一谈
- `PURGE_POLICY_EVALUATOR_ENABLED`：router的独立evaluator barrier gate，默认`0`。token-protected私有ACK只在该gate开启、`INTERNAL_ROUTER_TOKEN`存在且每个configured稳定runner当前健康并声明`policy-evaluator-v1`时返回；runner也必须独立开启同名gate才会请求ACK并schedule/claim。公开`purgePolicyEvaluation`只表示fleet代码感知，不能用来推断worker已经激活；`dataPurgeExecution`固定为`false`
- `DATA_EXPORT_REQUESTS_ENABLED`：router的新export writer gate，默认`0`。POST要求每个configured runner当前健康、code-aware `artifact-ndjson-v1`且admission-active；status/download不依赖writer gate，但仍要求healthy fleet和selected target code-aware。带`Idempotency-Key`的POST才允许一次安全重路由
- `BLOB_STORE`、`BLOB_NAMESPACE_ID`、`BLOB_STORAGE_CONTROL_ENABLED`、`BLOB_S3_BUCKET`、`BLOB_S3_PREFIX`：S3模式下必须与全部runner形成同一namespace digest/control generation。router不接收endpoint、region或credential，只比较每个健康runner的`backend/shared/namespaceSha256/controlGeneration` capability；mixed namespace不会进入writer surface
- `BLOB_FILESYSTEM_SINGLE_RUNNER`：当前 local router 与 runner 一致设为 `1`；只用于单 runner filesystem 拓扑，router 会强制 `RUNNERS` 去重后恰好一个地址，不能带入多实例环境
- `BLOB_ATTACHMENTS_ENABLED`：新 Blob 上传的独立 gate；local 默认 `1`，router 还要求全部健康 runner 声明 `blobAttachments`。当前 production filesystem 配置禁止开启
- `BLOB_MAX_BYTES`：只约束 raw Blob upload，必须与 runner 一致并且不大于双方的 `MAX_BODY_BYTES`
- `MAX_BODY_BYTES`：必须与 runner 相同，避免上游断开被误报成 502
- 网关/LB 必须关闭 SSE buffering，并把空闲超时设置得高于 SSE heartbeat

## 0053 本地受控 provider failure capture

它增加一次性`telemetry-capture`入口，不增加daemon或监听端口：源码由`pnpm maintenance:telemetry-capture -- <command>`调用，发布物为runner的`dist/telemetry-capture.js`。现在共六个产品JavaScript入口（runner五个、router一个），仍只有router/runner两个长期服务和两个OCI镜像。test-only SIGKILL/旧binary driver不在产品入口中。

先在独立可丢弃库验证，再做受控离线启用；不能直接对普通本地业务库复制下面命令。全部命令使用`migrationMode=verify`、不执行DDL，production在读取key或连接前拒绝；MYSQL_URL等authority只从受控环境进入。`TELEMETRY_CAPTURE_OPERATION_TIMEOUT_MS`默认30000、上限60000ms，以同一个AbortSignal覆盖store原生连接/query、named fence与S3 probe/send/body；取消不保证撤销已提交DB/S3动作，失败须保留现场并精确重放。

| 命令 | 行为和前提 |
| --- | --- |
| `status` | 真只读DB，不建S3 client或probe；inactive可无key，0033 active必须提供exact key以通过startup audit |
| `preflight` | 核对真实active0030 primary与当前schema/key/target；会创建并尝试删除content-free S3 probe，输出`capabilityProbe=true`、`mutatedProbeObjects=true`，不是严格只读或activation证明 |
| `activate-lifecycle` | 在单operator named fence下，原子建立0033双target/coverage/receipt；使用真实runtime前提和受控S3 capability，不能伪造receipt |
| `activate-logs` | 只激活v2 `provider.upstream_request_failed` logs，绑定exact lifecycle/key/logs target/current primary epoch/configured-fleet root；v1/traces保持inactive |
| `verify-source` | 独立RR快照核对真实failed item、item/completed、usage/billing、source/binding/membership/job/reservation/ACK/inventory；只输出状态、计数、摘要，不输出raw owner/source ID |

protected key通过`TELEMETRY_CAPTURE_REF_KEY_FILE`注入：绝对路径、当前UID、owner-only、single-link regular file，恰好32 raw bytes，不是hex文本；拒绝symlink/FIFO并前后复验身份。shared reader与backup/restore相同，不回显key或路径，临时buffer在资源收口后清零。direct CLI发现`TENANT_TELEMETRY_REF_KEY`存在（含空值）即拒绝；foreground wrapper显式`env -u`清除应用hex，保留caller-first file输入（含显式空值），不修改应用`.env`。长期runner/router剥离`TELEMETRY_CAPTURE_*`及operator file变量。

activation要求四个明确人工ACK：`TELEMETRY_CAPTURE_LOCAL_ONLY_ACK=1`、`TELEMETRY_CAPTURE_FLEET_STOPPED_ACK=1`、`TELEMETRY_CAPTURE_LEGACY_WRITERS_DRAINED_ACK=1`、`TELEMETRY_CAPTURE_PRODUCER_READY_ACK=1`，及精确`TELEMETRY_CAPTURE_CONFIGURED_FLEET_ROOT_SHA256`。ACK不是自动停服证明，也不冻结未来boot；必须先实际摘流、停止全部writer/在途事务，runtime前提从真实DB0030 primary epoch/lineage、journal target/head和receipt核对，不能用env自报epoch代替。启动后再由真实私有HTTP fresh gate验证boot和全部binding。

```bash
# 先完成独立schema迁移和0030受控primary activation；实际停服/排空后，
# 在受保护环境注入上述file、S3配置、fleet root和ACK，不把真实值粘进命令/日志。
pnpm maintenance:telemetry-capture -- status
pnpm maintenance:telemetry-capture -- preflight
pnpm maintenance:telemetry-capture -- activate-lifecycle
pnpm maintenance:telemetry-capture -- activate-logs
pnpm maintenance:telemetry-capture -- status
# 已有failed-step后，受控环境提供TENANT/SESSION/TURN/ITEM/STEP字段再verify-source。
pnpm maintenance:telemetry-capture -- verify-source
```

启用后的应用需exact配置runner gate、S3 writer/key及router gate，保持0035 v1/traces inactive。来源只接受PiEngine原始models stream result/error provenance，synthetic/executor/store/listener异常不能冒充provider；失败step原子COMMIT后再完成原turn-terminal COMMIT。内嵌0034worker在`claim/reserve/create/ack`四边界分别取fresh all-configured proof并独立复验source；首次create必须仍是live owner，历史exact object/ACK恢复只允许原operation、不获新的create权限。v2 gate不可用时仅领取legacy v1/traces队列，筛选发生在LIMIT前，不让旧job饿死，也绝不把v2降级成v1。

发布0053前须关闭相关gate，实际排空全部pre-0053 router/runner/writer与在途事务，再独立迁移，只启动0053-aware版本，不能热混跑或回改已发布0049，后续只能forward-fix。相关组合启动指纹为160，与当前全库662个trigger不是同一统计口径。真实`0052→0053`夹具使用钉住的旧代码编译/执行失败step，再核对旧来源NULL/0保持unknown、新capture默认休眠、marker-loss/partial DDL/drift和旧binary拒绝新指纹；fresh schema不替代该证明。最新运行数量和CI结果只看PROGRESS及当次required JSON，不在本文固定。

0053原始边界（0054有限例外见本页顶部与数据生命周期第13节）：本地验证需`verify`及`verify-s3`两层：前者含standalone真实MySQL、SIGKILL事务窗口与历史升级；后者显式运行backup制品和真实HTTP/stream→MySQL→MinIO bytes/ACK。它们证明本地协议，不证明云IAM/KMS、独立故障域或完整fleet规模。受保护key仅补旧backup/restore对active0033生命周期的审计兼容；active capture与旧epoch绑定，新epoch恢复没有自动rebind，仍fail closed。T3d/T3f第六来源、grant、外部删除/恢复、sealed source usage自动清理和全部completion继续硬拒。

## 0028 离线 filesystem→S3 搬迁

该入口只适用于`STORE=mysql`、source为`filesystem-v1`、target为S3-compatible namespace的全停机维护。它不是在线双写、rolling migration、S3→S3工具或常驻worker。`0028_blob_storage_migration.sql`只安装default-dormant ledger/guards；应用migration不会冻结runtime、扫描`BLOB_DIR`、复制对象、重写pointer或激活`0027`。真正动作只来自同一runner发布物内的一次性CLI：源码入口由`pnpm maintenance:blob-storage-migrate -- <command>`调用，构建后入口为`apps/agent-runner/dist/blob-storage-migrate.js`，runner OCI镜像也包含该文件，但不会把它作为默认长期进程启动。

inventory的authority来自MySQL ledger中live/open-intent的Blob/export记录：`blob_objects`、Blob delete intent、export artifact/part、snapshot pin和export delete intent。它只搬运这些记录精确指向的storage key，并额外允许这些已封存记录引用的legacy raw file + `.meta` sidecar；不会遍历、认领或证明`BLOB_DIR`下任意未知、无manifest文件。此类root orphan仍是独立运维风险，必须在维护前后另做只读盘点和人工审计，不能因为mover receipt成功就宣称“目录全部bytes已搬完”。

安全顺序如下。所有locator和credential先在当前shell或受控Secret注入中准备，命令行只放一个固定command；不要把环境值粘贴到日志或文档：

```bash
# 1. 先阻断入口并真实停止/排空全部router、runner及其它旧writer；本地单实例可用：
scripts/local-service.sh stop

# 2. 只读确认dormant control；status只需要MYSQL_URL。
pnpm maintenance:blob-storage-migrate -- status

# 3. 设置本节列出的MIGRATION_ID/FLEET_DRAINED_EVIDENCE_SHA256/delay，
#    以及现有MYSQL_URL/BLOB_DIR/BLOB_NAMESPACE_ID/BLOB_S3_*后，逐阶段执行。
pnpm maintenance:blob-storage-migrate -- prepare
pnpm maintenance:blob-storage-migrate -- copy
pnpm maintenance:blob-storage-migrate -- verify

# 4. 在verified阶段检查证据并等待数据库rollback window；仍需回退时只能在cutover前abort。
pnpm maintenance:blob-storage-migrate -- status
# pnpm maintenance:blob-storage-migrate -- abort

# 5. 明确提交不可逆pointer/control cutover；提交后只能forward-fix。
pnpm maintenance:blob-storage-migrate -- cutover
pnpm maintenance:blob-storage-migrate -- status

# 6. 等数据库source-cleanup delay后，显式清理source；任何run命令都不会代做此步。
pnpm maintenance:blob-storage-migrate -- cleanup-source
pnpm maintenance:blob-storage-migrate -- status
```

`run`等价于prepare→copy→verify；默认停在`verified`，只有`BLOB_MIGRATION_COMMIT=1`才继续cutover，且永远不自动source cleanup。推荐首次演练仍使用上面的显式分阶段命令。一个MySQL advisory lock只允许一个mutating operator，第二个operator会立即失败；独立`status`可并行观察。每个target put/delete/discard和source delete还会在事务中持有migration-control行共享锁，并在外部mutation前后确认dedicated连接仍是named-lock owner。若该连接在动作中丢失，外部对象可能已按create-only/CAS语义改变，但旧operator不会写ACK或推进phase；替代operator即使取得named lock也会等待行锁释放，再按exact owner/descriptor重放收敛。每次命令都可在response loss或进程重启后按相同durable identity精确重放，但不能更换migration id、source/target namespace或把另一次attempt的对象当作本次结果。

runner有两次startup gate：store连接后、S3 adapter打开前先读取`0028` control；adapter startup验证和`0027` exact Blob identity对账完成后，再用独立连接重读一次。第二次读取关闭“首次检查通过后，mover在adapter验证期间提交cutover”的窗口；普通generation-1 activation与freeze也按migration-control→blob-control锁序串行化，并拒绝任何历史attempt使用过的target namespace。不过两次gate都只是**启动前**检查，不会踢掉已经运行的进程，也不能约束第二次读取后被误启动的旧writer。因此`prepare`前必须实际停止并排空所有runner，等待active turn、worker claim和旧lease结算；仅依赖gate或数据库trigger不是停服证明。router可先停止/摘流，以免维护期间持续产生502/503，但router不参与mover，也不应持有`MYSQL_URL`或对象存储credential。runtime只在`inactive`、`aborted`、`source_cleaned`允许启动；`frozen`、`inventory_sealed`、`copying`、`verified`、`cutting_over`、`committed`和`abort_cleaning`都拒绝启动。abort只在cutover前可用，保留filesystem source并用CAS在target同key写永久migration-owned tombstone；aborted namespace永久不可复用。committed后没有回滚路径，即使source bytes尚在也只能完成`cleanup-source`再以exact target S3 identity恢复服务。

copy写入的对象带独立于upload token的`migrationOwnerSha256`。普通staging上传如果在停服前已经发布bytes、但MySQL upload ACK因崩溃未提交，cutover后可由ordinary exact retry继续完成；descriptor一致时不会剥掉migration provenance，内容或owner冲突仍fail closed。source cleanup会在再次核对committed control、target descriptor/owner与object ACK后删除filesystem envelope；legacy记录同时删除raw payload和`.meta`，并以per-key/rooted ACK收口崩溃重放。

当前实现优先保证正确性，不是生产规模承诺：prepare会把candidate/inventory集合装入进程内存；freeze用`SERIALIZABLE`全范围锁建立写冻结，inventory seal又是单个大型事务。没有分页、batch、dry-run、动态限速或operator HA；每对象虽有读取上限，Buffer复制仍会放大峰值内存。MySQL整库重启可能同时释放named lock与行锁，恢复正确性仍依赖create-only/CAS、永久owner tombstone和精确重放，不代表operator高可用。`MAX_OBJECT_BYTES`没有写入迁移账本，后续命令设得更小会安全阻断而不是继续。每次attempt必须使用新的逻辑namespace，并同时保证物理bucket/prefix从未被旧attempt使用；只更换`BLOB_NAMESPACE_ID`不能把重叠prefix变安全。filesystem identity绑定resolved path而非mount/inode，S3 identity也不含endpoint/region/account，这些映射必须由受控配置、挂载与IAM保证稳定。进入真实环境前必须以staging数据量验证维护窗口、容量、网络、IAM、超时、失败恢复和source备份，不能用本地MinIO结果替代。

## 0030 独立 restore journal 与恢复

`0030_tenant_restore_journal.sql`只安装default-dormant journal publication、runtime lineage与restore replay账本；migration本身不会选择target、访问对象存储、发布历史T1、建立backup、重放fence或切换runtime epoch。长期publisher内嵌于runner；router只返回fresh fleet ACK；真正恢复使用runner镜像内的一次性`restore-ledger-reconcile.js`，不会新增daemon、产品服务或镜像。

本地先用自动门禁验证，不需要激活普通开发库：

```bash
pnpm test:tenant-restore-journal-memory
MYSQL_TEST_URL="mysql://root@127.0.0.1:3306/agent_service_test" \
  pnpm test:tenant-restore-journal-mysql
scripts/local-service.sh verify-s3
pnpm build:check
```

`verify-s3`会bootstrap一个与Blob bucket不同的restore-journal bucket并强制真实MinIO suite零skip。但MySQL、Blob bucket和restore bucket通常都在同一台本机，两个bucket不是两个故障域；`RESTORE_JOURNAL_INDEPENDENT_FAILURE_DOMAIN_ACK=1`在这种场景只为可丢弃协议夹具解锁代码，不能作为staging/production证据。restore S3 client会忽略AWS环境变量/shared profile提供的endpoint override；受控region及normalized显式custom endpoint或standard-endpoint模式进入durable target identity，环境变化不能静默把同一账本指向另一目标。

primary activation只能用于独立可丢弃数据库或已经完成正式变更评审的环境。先应用0030，以router gate=`0`、runner worker=`0`发布新代码，配置runner-only database namespace、primary runtime epoch、journal namespace、failure-domain identity与S3 target；三个公开digest从runner capability取得后精确配置给router。确认外部head完全为空、所有pre-0030 writer均已排空，而且数据库不存在任何已经绕过journal完成的terminal T3a receipt，再停掉全部writer：

```bash
scripts/local-service.sh stop
```

activation必须同时声明两个ACK及Blob backend。filesystem Blob环境只运行下面这一组：

```bash
BLOB_STORE=filesystem \
RESTORE_FLEET_STOPPED_ACK=1 \
RESTORE_JOURNAL_PRIMARY_ACTIVATION_ACK=1 \
  pnpm maintenance:restore-ledger-reconcile -- activate-journal
```

S3 Blob环境只运行下面这一组；bucket值必须来自受控配置，且不得等于`RESTORE_JOURNAL_S3_BUCKET`：

```bash
BLOB_STORE=s3 \
BLOB_S3_BUCKET="$BLOB_S3_BUCKET" \
RESTORE_FLEET_STOPPED_ACK=1 \
RESTORE_JOURNAL_PRIMARY_ACTIVATION_ACK=1 \
  pnpm maintenance:restore-ledger-reconcile -- activate-journal
```

无论选择哪组，成功后再只读检查：

```bash
pnpm maintenance:restore-ledger-reconcile -- status
```

缺少`BLOB_STORE`、S3模式缺少`BLOB_S3_BUCKET`，或两个bucket相同都会在建立MySQL/S3连接前fail closed。该检查只证明名称分离，不证明独立故障域。

activation在同一个MySQL事务中建立journal control与primary runtime epoch，且只在外部head仍精确为空时成功；commit后只能forward-fix。随后所有runner必须使用exact raw target/runtime配置并保持`TENANT_RESTORE_JOURNAL_WORKER_ENABLED=1`，否则startup preflight拒绝服务。先保持router `TENANT_RESTORE_JOURNAL_EXECUTION_ENABLED=0`启动全部runner，核对每个稳定地址都报告`independent-restore-journal-v1`、三个digest一致且worker-active，再最后开router gate。每个新T1 gate与journal publication job/targets在Memory一个原子边界或MySQL同一事务内建立；publisher用claim lease、S3 create-only链和exact ACK/response-loss replay收口。这个saga不提供MySQL与S3分布式原子提交，关闭router gate也只暂停新publication边界，不撤销已有T1、journal record、ACK或lineage。

恢复演练的安全顺序如下。所有ID、digest、DSN、endpoint和credential必须经受控环境/Secret注入，命令行只放固定command，任何步骤都不能回显原始配置：

1. 摘流并停止全部router、runner和其它旧writer，等待active turn、worker claim、I/O与lease排空；从0031 authoritative catalog选择实际仍可恢复的backup。`RESTORE_FLEET_STOPPED_ACK=1`只是人工确认，CLI不会替operator完成停服。
2. 在仍存活的catalog authority侧首次执行`prepare-restore`：为全新`restore_<UUIDv4>`格式的`RESTORE_RUN_ID`绑定精确backup entry，并在外部catalog永久预留从未使用的`BACKUP_RUNTIME_EPOCH_ID`。把`BACKUP_ID`、`RESTORE_RUN_ID`、`BACKUP_RUNTIME_EPOCH_ID`、`SOURCE_BACKUP_SHA256`、publish evidence及精确catalog/journal target identity安全保存在数据库故障域之外；不得放入命令行、普通日志或工单正文。
3. 由backup producer/operator独立核验物理snapshot identity、manifest/provider evidence与source digest后，实际恢复该entry指向且包含selected backup exact local anchor的数据库制品，再由环境的独立migration Job把schema升级并验证到运行0030 CLI所需的完整版本。恢复出的selected快照不会包含步骤2新写的本地entry/binding/reservation/run，因此必须用步骤2完全相同的ID、source evidence、target identity和fleet-stopped ACK再次执行0031 `prepare-restore`；它会完整验证并镜像external catalog chain、从availability event重建entry、exact replay既有reservation，并原子重建binding/reservation/run。缺少所选anchor的更早/错误snapshot会fail closed，external mirror不会猜造anchor；但另一个更晚snapshot也可能仍含该anchor，应用不能仅凭anchor证明实际恢复bytes正确，物理核验不能省略。若缺anchor快照对应的external reservation已存在，当前也没有external-only orphan abort入口。active catalog会拒绝在这一步之前直接运行普通0030 `prepare`。restore CLI所有命令都使用verify-only连接，只读`schema_migrations`并在缺少任一随镜像发布的migration时fail closed，绝不获取migration lock、创建表或执行DDL；0030 marker存在时还必须通过精确schema/trigger fingerprint。`RESTORE_JOURNAL_RUNTIME_EPOCH_ID`与`SOURCE_BACKUP_SHA256`必须和重建后的0031 binding/reservation一致，不能由operator另行选择。
4. 执行`status`，再分阶段执行`replay-fences → verify`；也可使用`run`，但其中的0030 `prepare`此时只能是步骤3已重建run的exact replay。`replay-fences`把每条sealed record变成永久本地tenant fence；`verify`在全部entry精确入账后封存receipt。
5. 人工审阅content-free计数、phase与外部恢复证据；确认无缺口后显式执行`activate-runtime`。该命令会再次读取外部head并要求未发生漂移，随后提交新的runtime lineage；`run`绝不会自动完成这一步。成功后以相同operation执行0031 `resolve-restore`投影`activated`；若在允许中止的边界停止，则先按0030规则abort，再把同一reservation精确resolve为`aborted`。两种phase都会永久烧毁epoch。
6. 更新router的三个非密钥digest，先保持execution gate=`0`启动全部新runner，让startup preflight核对DB control/runtime/external heads并确认全fleet worker-active；最后才开journal gate，之后再按各自rollout恢复T3a/T3e/T3f/T3g等破坏性gate。

对应的恢复后命令骨架如下；先用恢复前安全保存的完全相同配置重跑0031 `prepare-restore`，确认本地binding/reservation/run已经重建，再进入0030 replay。全部步骤都提供`RESTORE_FLEET_STOPPED_ACK=1`：

```bash
pnpm maintenance:backup-catalog -- prepare-restore
pnpm maintenance:restore-ledger-reconcile -- status
pnpm maintenance:restore-ledger-reconcile -- replay-fences
pnpm maintenance:restore-ledger-reconcile -- verify
pnpm maintenance:restore-ledger-reconcile -- status
pnpm maintenance:restore-ledger-reconcile -- activate-runtime
pnpm maintenance:restore-ledger-reconcile -- status
```

`abort`只允许prepared但尚未active的run；它不会删除已经重放的永久fence，也不会允许复用该runtime epoch。`status`只读数据库；`verify`/`abort`为DB-only边界，可在object store暂时不可达时使用；`activate-journal`、`prepare`、`replay-fences`、`activate-runtime`和`run`会加载并验证真实adapter。所有命令都以verify-only方式检查完整migration marker集合而不执行migration；0030 marker存在时还执行精确schema/trigger fingerprint并恢复临时session设置。真实MySQL回归还会对空库执行`status`所用的verify-only连接，并证明失败后仍为零表。任何已激活或已abort的epoch都视为烧毁，不能因重试、回滚或改名而复用。

当前残余边界必须保留在上线清单中：journal和catalog均只有单target配置；跨MySQL/S3为可精确重放的saga而非分布式事务；0030 activation前external-head读取到DB commit仍有TOCTOU窗口；独立故障域、primary activation、fleet stopped、物理backup创建/删除仍含外部流程与人工ACK。当前journal S3 adapter只有逐请求deadline，没有覆盖完整chain scan/restore operation的统一deadline；分页scan每页从chain起点重验sealed prefix，整体为`O(n²)`对象读取。本地MinIO不能覆盖真实IAM、不可变策略、跨故障域网络、容量、请求费用或恢复窗口，必须在staging按实际规模压测。0031在独立catalog证据存续的前提下消除了游离backup digest和epoch复用的协议缺口，但不创建备份、不自动执行整链DR，也不证明backup内tenant erasure，因此仍不能称为完整生产backup/DR。

## 0031 权威 backup catalog

外部authority由create-only不可变event objects和单一可变`If-Match` CAS head构成，LIST不能作为尾部判断。启动会真实探测`If-None-Match: *`、正常CAS和陈旧ETag拒绝；event已创建但head写响应失败时，后续读取通过精确下一sequence和完整链校验推进head。生产IAM必须仅允许受控operator在固定head key上条件覆盖、允许event create，并禁止其它writer覆盖event/head；versioning、lifecycle与Object Lock保持关闭。忽略条件header或仍使用旧v1布局的兼容存储会fail closed。

`0031_authoritative_backup_catalog.sql`只安装default-dormant catalog control、完整external-event mirror、snapshot anchor、recoverable full-backup entry、restore source binding、runtime reservation与eviction账本；migration不联网、不创建/删除backup、不激活control。mirror是全链sequence/hash authority，但不是backup bytes、anchor或0030 ledger。真正操作来自runner镜像中的一次性`backup-catalog.js`，源码统一入口为`pnpm maintenance:backup-catalog -- <command>`，不会启动HTTP listener、worker或第三个产品服务。

先用可丢弃数据库和测试bucket执行自动门禁：

```bash
pnpm test:tenant-backup-catalog-mysql
scripts/local-service.sh verify-s3
pnpm check:backup-catalog-artifact
```

`verify-s3`会为catalog bootstrap第三个bucket，并强制真实MinIO chain suite执行；它与Blob、journal bucket名称不同，但同一MinIO进程仍不是生产独立故障域。手工操作前必须通过受控环境提供`BACKUP_CATALOG_ADAPTER=s3`、database/namespace/failure-domain ID、独立故障域ACK、S3 target和retention两项参数；不得在命令行、日志或工单中粘贴这些值。安全顺序是：

```bash
pnpm maintenance:backup-catalog -- status
pnpm maintenance:backup-catalog -- activate

# 每次backup：保持fleet停写，先完整mirror外部head并固定DB lineage，再由外部系统创建/验证full backup，最后发布其证据。
RESTORE_FLEET_STOPPED_ACK=1 pnpm maintenance:backup-catalog -- begin-backup
pnpm maintenance:backup-catalog -- publish-backup
pnpm maintenance:backup-catalog -- list

# 恢复前选择entry并永久预留epoch；物理恢复后以同一ID/evidence重跑本命令。
pnpm maintenance:backup-catalog -- prepare-restore
# 0030完成后再投影同一reservation为activated或aborted。
pnpm maintenance:backup-catalog -- resolve-restore

# 每次eviction：先停服并保持停服，取得计划，外部物理删除，最后记录永久tombstone。
RESTORE_FLEET_STOPPED_ACK=1 pnpm maintenance:backup-catalog -- prepare-eviction
# 这里必须保持全部writer/catalog operator停服，不能在外部删除窗口恢复服务。
RESTORE_FLEET_STOPPED_ACK=1 pnpm maintenance:backup-catalog -- record-eviction
pnpm maintenance:backup-catalog -- reconcile
```

`begin-backup`先完整验证/镜像external event chain，再生成与当前schema/runtime/journal/Blob control及source catalog sequence/root精确绑定的anchor；它不复制数据库，`RESTORE_FLEET_STOPPED_ACK=1`也只是人工停写声明。`publish-backup`只校验摘要格式、target/chain identity并绑定operator-attested artifact manifest/provider evidence digest；adapter不读取或验证物理backup、manifest/provider内容，真实producer/operator必须在外部独立验证。首次`prepare-restore`要求selected backup仍有exact local anchor，并把catalog binding、永久epoch reservation和0030 prepare原子提交；selected旧快照恢复后用相同ID/evidence再执行一次，从mirror重建availability并重建其它本地投影。exact anchor会拒绝不含它的更早快照，但不能排除仍含anchor的更晚错误快照，物理snapshot/provider evidence仍由operator独立核验。`resolve-restore`只有在本地reservation与terminal 0030 run匹配时才建立本地phase，否则resolution只保留在external mirror。active 0031 trigger会阻止pre-0031 writer创建unbound 0030 run，但不允许旧writer继续混跑；执行所有catalog操作前仍须排空旧writer、保持fleet stopped并确保只有一个operator。`prepare-eviction`会重验DB time、active retention digest、最少可恢复backup数、catalog head与活动reservation；制品物理不存在必须由operator独立确认，adapter只校验/绑定content-free absence acknowledgement，再由`record-eviction`追加event和本地投影。两条eviction命令的`RESTORE_FLEET_STOPPED_ACK=1`只是operator声明，CLI不会停止或持续探测fleet；必须在prepare前人工摘流/排空全部writer及其它catalog operator，并保持到record成功提交后。当前prepare不写durable two-phase eviction intent，因此该窗口仍依赖运维隔离，未来需要独立账本闭合。上述旧metadata command响应丢失都必须用相同operation ID和environment exact replay，不能换ID、手改digest或把“已请求删除”冒充“已物理不存在”。

`reconcile`只适用于恢复数据库仍保留active且identity匹配的0031 control、并希望用external sealed event chain核对或补齐catalog状态的场景。它会完整验证chain并把每个content-free event写入本地mirror；某个local anchor缺失不会阻断后继event的sequence/hash验证或镜像。availability与eviction acknowledgement可从mirror中的完整摘要重建本地投影；resolution只有在本地reservation与terminal 0030 run精确匹配时才投影，否则只保留external authority。selected backup仍必须有exact local anchor；若不含该anchor的旧快照对应的external reservation已经存在，必须由operator恢复并独立核验所选物理snapshot后按同一operation继续，当前不能仅凭external authority abort orphan reservation。anchor gate不能排除另一个仍含anchor的更晚错误快照。禁止手改SQL，或把mirror当成backup bytes、业务数据、anchor、source binding/reservation及0030 ledger的替代品。

## 本地MySQL加密逻辑备份制品

`backup-catalog`与`restore-ledger-reconcile`使用共享的受保护raw key文件接线：0033 lifecycle inactive时可不配置；active时必须提供`TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE`，source及物理恢复后的target均用完全相同的key执行verify-only startup audit，缺失、错误或receipt/coverage漂移仍fail closed，绝不绕过审计。单独提供该文件不授权active provider capture跨epoch写入，也不自动rebind旧receipt；0057已实现的单次受限流程与0058重复恢复候选分列如下。验收只看PROGRESS，不沿用旧inactive结果。

文件须为绝对路径、当前UID所有、单hard-link且owner-only的regular file，内容恰好32 raw bytes（不是64字符hex），不得是symlink或FIFO；reader以nonblocking/no-follow打开并在读取前后复核文件身份，错误输出只使用闭合类别，operator临时buffer在资源关闭后清零。此key与`BACKUP_ARTIFACT_KEY_FILE`的制品加密key独立；保留它不等于保存到数据库或制品中。应用仍使用`TENANT_TELEMETRY_REF_KEY` hex配置，direct CLI只要发现该变量存在（包括空值）即拒绝；三个foreground wrapper会清除此应用输入，保留受控file变量且不改`.env`，长期router/runner剥离operator file路径。不要回显key、文件路径、环境或数据库错误。旧restore-ledger及catalog metadata命令仍没有统一whole-operation deadline，本次key兼容接线不扩展其保证。

最初的producer是0052之后的code-only、受限本地切片，不是生产backup/DR；后续capture恢复依赖独立的0055～0057证据schema，0058再扩展重复恢复候选，不能把“CLI不自动迁移”解释成没有schema依赖。它们均扩展已有`backup-catalog.js`，不新增常驻服务、产品入口或镜像。旧`begin-backup/publish-backup`流程继续仅绑定外部operator attestation；新的`create-artifact`读取真实MySQL 8 InnoDB应用逻辑SQL，认证实际bytes后才发布catalog availability。`verify-artifact`会认证制品、当前anchor与catalog证据，也可对账content-free控制投影，不是严格只读。

手工体验只用可丢弃数据库，先完成0030/0031受控activation及上文catalog配置，并实际摘流、停止和排空全部writer。ACK、filesystem lock和MySQL named lock只能约束合作operator，不会替你停止任意应用或数据库writer。创建/验证制品和首次`restore-selected`要求source在线；这不是主库已丢失时的external-only首次恢复。source/target都必须是稳定loopback MySQL 8，首次导入的target须明确创建、为空且实际server UUID/database tuple不同；只换URL spelling不等于不同目标。导入后的五个selected continuation只连接同一已导入的target，不要求旧source仍在线，也不要求或允许清空target。

额外配置通过受控环境注入，禁止在命令行、日志、录屏或工单回显DSN、key、SQL和credential：

| 变量 | 契约 |
| --- | --- |
| `BACKUP_ARTIFACT_DIRECTORY` | canonical绝对路径、当前UID、0700私有目录和可信parent；不允许symlink |
| `BACKUP_ARTIFACT_KEY_FILE` | 独立raw 32-byte二进制key、0600私有文件；不是hex文本，不复用`SECRETS_MASTER_KEY` |
| `TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE` | 0033 active必需；同一受保护raw 32-byte ref key用于source/target审计，独立于制品加密key；inactive可省略 |
| `BACKUP_MYSQL_BINARY` / `BACKUP_MYSQLDUMP_BINARY` | 宿主机绝对可执行MySQL 8工具；runner镜像目前没有这两个工具 |
| `BACKUP_ARTIFACT_MAX_BYTES` | 默认256 MiB、上限1 GiB；预留约4倍上限的本地spool空间及额外开销 |
| `BACKUP_ARTIFACT_DEADLINE_MS` | 单次完整操作默认120000 ms、上限600000 ms |
| `BACKUP_ARTIFACT_LOCAL_ONLY_ACK` | 显式`1`；`NODE_ENV=production`仍拒绝 |
| `BACKUP_RESTORE_TARGET_MYSQL_URL` | 首次`restore-selected`指向隔离空target，不得指向source或已有业务库；后续五个selected命令保留同一个已导入的非空target，不能换库或清空 |

`BACKUP_ID`须为`backup_<UUIDv4>`，`RESTORE_RUN_ID`须为全新`restore_<UUIDv4>`（均小写，不是裸UUID）。安全保存这些ID、never-used `BACKUP_RUNTIME_EPOCH_ID`、制品及catalog/journal identity。恢复前必须把`RESTORE_JOURNAL_RUNTIME_EPOCH_ID`改为与`BACKUP_RUNTIME_EPOCH_ID`完全相同，或不显式提供让CLI注入；不可残留primary epoch，否则配置校验会拒绝。长期router/runner拒绝/剥离这些operator authority；显式caller值（包括空值）优先于`.env`，普通`local-service.sh verify/verify-s3`不会继承这些环境authority（`verify-artifact`本身仍要求制品配置）。新流程会自行建立anchor与reservation，不要先调用旧`prepare-restore`：

```bash
scripts/local-service.sh stop
# source保持在线；受控配置已注入，create和restore要求RESTORE_FLEET_STOPPED_ACK=1。
pnpm maintenance:backup-catalog -- create-artifact
pnpm maintenance:backup-catalog -- verify-artifact
pnpm maintenance:backup-catalog -- restore-selected
```

`create-artifact`以受保护defaults-file调用native mysqldump，不把password放argv或stderr；先校验同源anchor、完整marker/schema，再以AES-256-GCM、canonical manifest和create-only文件发布。恢复在完整认证之后、用同一持有的plaintext capability导入，不根据调用方摘要猜测bytes。schema-root v2只规范已证冗余utf8mb4列charset显示；literal/default/index/约束/trigger及其它bytes保持严格，unknown或backslash形态保持raw，可能安全拒绝其它合法schema。

`restore-selected`先在新鲜external chain上永久reserve run/epoch，再真实执行DDL/DML导入，随后verify-only核对完整schema/anchor并同ID重建binding/run。它不是DDL-free；MySQL DDL auto-COMMIT意味着失败可能留下部分target。任意既有run或epoch（包括已resolved）都永久拒绝再次自动导入，不能换artifact目录、target或恢复旧source快照绕过。失败必须保留原ID、制品、reservation与事件现场，只有独立确认完整导入且exact schema/anchor有效的target才可按旧0031 prepare/0030 replay路径人工forward-fix；`SOURCE_BACKUP_SHA256`必须取已认证catalog/restore输出的`sourceBackupSha256`，不手填猜测，部分import不能直接续接；禁止自动DROP、清空、重导、换epoch掩盖事故或直接启动服务。

### 0057 active-capture 新epoch流程（单次已实现，仅限本地隔离）

已激活0053的来源使用认证v2制品和49类checkpoint；不能走普通connect或旧generic命令绕过pending门禁。完整导入只到prepared，随后保持停服，保留同一制品/key、backup/run/epoch/target及catalog/journal配置，分别运行：

```bash
BACKUP_RESTORE_REPLAY_ACK=1 pnpm maintenance:backup-catalog -- replay-selected
BACKUP_RESTORE_VERIFY_ACK=1 pnpm maintenance:backup-catalog -- verify-selected
# 人工审阅实际run、来源和head后，才分别授权runtime与capture。
BACKUP_RESTORE_RUNTIME_ACTIVATION_ACK=1 pnpm maintenance:backup-catalog -- activate-selected
TELEMETRY_CAPTURE_RESTORED_EPOCH_ACTIVATION_ACK=1 pnpm maintenance:backup-catalog -- activate-capture-selected
BACKUP_RESTORE_CATALOG_RESOLUTION_ACK=1 pnpm maintenance:backup-catalog -- resolve-selected
```

以上还各自要求既有artifact local-only、`RESTORE_FLEET_STOPPED_ACK=1`及受保护operator ref-key；capture cutover另需local-only/fleet-stopped/legacy-writers-drained/producer-ready四项ACK和真实configured fleet root，完整变量以`backup-catalog --help`为准。命令持有认证GCM和target锁、使用统一预算，独立验证实际外部链/新head、0031 selection与0030历史，不重新import/reserve/prepare、不自动激活或切换应用。`resolve-selected`只收口实际active+capture-cutover后的该run为activated，不授予普通writer能力，不实现本批v2 abort；旧v1 `resolve-restore`保留原行为。响应丢失不得换ID或猜成功，只显式同命令exact retry。

新epoch普通runner仍须独立既有capture gate、受保护ref-key及每边界fresh fleet proof。旧pending仅完整validated-v2叶可获新attempt/token/permit；legacy/unknown不升权，旧CP/root、旧receipt与reservation descriptor不重签。0054 restored destructive仍拒。0057单次纵向已定向通过；0058已有下节所述分段真实双跳，仍未整包验收。其它domain联合灾备及生产IAM/KMS/故障域仍未闭环，不要把本节当生产操作许可。

首次`restore-selected`成功只返回`restorePhase=prepared`、`runtimeActivated=false`、`fenceReplayComplete=false`和`requiresExplicitReplayAndActivation=true`，不会自动执行后续步骤。仅inactive capture的旧v1恢复继续使用旧operator：将其`MYSQL_URL`明确改到已导入target，保留同一run/epoch/evidence与外部target identity，明确提供新epoch的`RESTORE_JOURNAL_RUNTIME_EPOCH_ID`，再分别执行`replay-fences → verify → status`、人工审阅、显式`activate-runtime`及0031 `resolve-restore`。active capture的v2恢复只按上节五个selected命令分别授权，不得改走旧generic路径。旧restore-ledger及metadata catalog命令仍只验证已安装migration、不执行DDL。

全操作单调deadline贯穿S3、native MySQL、child和文件spool；取消会终止受控socket/child，但已发送COMMIT或S3 CAS可能已成功，不是回滚证明。pending工作settle前不提前释放operator lock；超时可能遗留未发布spool/probe/orphan，不能宣称零残留。可信本机FS、同UID、endpoint稳定性及手工fleet停写仍是前提；不覆盖物理page/PITR、任意views/routines/events、Blob/Redis联合备份恢复、tenant backup-copy erasure、云IAM/KMS、独立故障域、RPO/RTO或容量。完整本地/CI实际执行证明以PROGRESS最新节为准，M1仍未冻结。

### 0058 重复备份／恢复（分段纵向通过，未整包验收）

以下是尚未完整验收的有限工作流，不是可用于业务库的操作教程：在同一已独立迁移的schema下，primary生成backup1（checkpoint v1／`ASMYSQL2`）→fresh DB1／never-used epoch1完成上述五个selected步骤→停服后从该restore1来源生成真正的新backup2（checkpoint v2／`ASMYSQL3`）→另一fresh DB2／never-used epoch2再执行同样步骤。每次使用各自的新backup/run/epoch ID，不能把旧制品exact replay当作第二次备份，也不能复用首次导入目标。每次`restore-selected`仍只到prepared，不自动activate、resolve或切换应用。

候选的受保护artifact路径使用独立backup-source maintenance facade，核对实际pool/server UUID/database、0030/0031与49类来源；CP2另绑定27类真实祖先投影，完整叶子由实际SQL dump携带并在导入后重验，不凭caller hash补证。新dump前后观察实际来源epoch、DB heads及外部catalog/journal完整链；source epoch来自服务端，不借用下一target的epoch配置。合法queued/reserved/written及legacy-unknown均可备份，unknown不提升；旧CP、history/cutover、P1、原reservation descriptor与对象bytes不重签。恢复后只能以新claim和精确P2续跑原operation，不能复活旧token。

source维护、exact-run恢复维护与普通runner写入三种权限分开。source prepare成功后禁止继续读/镜像该已fenced source；导入前只重新验证完整外部chain、selected availability及同一reservation，随后在target重建exact prepare。普通capture仍须独立runtime gate和fresh configured-fleet proof；operator不因维护factory而获得claim/reserve/create/ACK能力。已有制品exact replay只认证实际bytes与不可变历史，不重新seal或要求今日head未变。

0058候选还在实际source锁下、任何planned journal／外部reserve／import之前，将完整source migration root与认证manifest的anchor精确比较；不同即拒。`ASMYSQL1/2`旧bytes与历史读取兼容，不等于旧schema制品可import→upgrade→continuation；这条跨schema原生恢复仍缺，禁止自动DDL、重导或清空部分target。命令仍复用现有create/verify/restore与五个selected命令，没有新CLI、daemon、服务、JS入口或镜像，VM与容器交付边界仍为2/6/2。

0058八根已在隔离MySQL校准；完整SQL/冻结旧binary历史/单跳证据保留。有界trigger batch后，22:37的真实完整双跳在原180秒首次通过（178638.82ms），含newPi/finalcold/cleanup，独立资源复查零fixture库/三对象前缀残留。仅约1.36秒余量，仍有CI风险，不称稳定提速或整包通过；原超时与启动器配置失败均保留。300秒请求仍未答，原180/CLI120/lease/断言未变，不再据此阻断本地后续；完整verify/verify-s3、最终commit/push/新CI尚未执行。main3414五绿只证明原发布；默认off/local-only与production拒绝、0037、0054原primary-only、外删与自动off/completion=false不变，详见[PROGRESS](../PROGRESS.md)顶部及末节。

## 预发/生产资源就绪后的交付顺序

1. 建立独立的 staging MySQL、Redis、共享Blob对象存储、位于primary database故障域之外且彼此按设计隔离的restore-journal/catalog存储、Secret/KMS 和网络访问策略；实际云参数未提供前不生成或猜测endpoint、bucket、IAM、域名/TLS与Secret值。
2. 独立执行并验证数据库迁移、0031 catalog activation、真实backup producer、retention/eviction、备份/恢复与回滚演练。
3. 按实际容量与故障域部署 configured/N 个 runner，确认每实例唯一身份、稳定直连地址、readiness 和 graceful drain；需要验证接管时至少使用两个实例。
4. 部署 router，经 router 跑 session、SSE turn、断线重放和接管测试。
5. 接入真实 IdP、日志、指标和告警后再开放预发流量。
6. 生产环境重复同一流程，不复用 staging 的数据库、Redis、密钥或 service key。

目标日常交付采用共同的前半段：本地开发与 `verify` → CI 全部门禁 → 同一次构建产生受控交付物 → staging 验收 → 将同一交付物身份晋级 production。容器形态分别按 router/runner 不可变 image digest 晋级；VM 形态分别按 router/runner 完整 Node 24 发布归档的校验和与发布包身份晋级，不在环境中重新安装依赖或重新打包。两种形态都不共享 staging/production 的数据库、Redis、对象存储、密钥或 service key；环境差异只来自受控配置和 Secret。容器job当前仍以 `load: true` 临时构建并启动候选镜像；VM受限tar、独立工具与离线签名已在本地候选实现，CI候选也增加验真与artifact留存，本地证明不能替代main对应Linux CI结果。registry push、生产签名信任根/密钥管理、OCI签名/attestation、持久交付身份的staging→production promotion与受控安装仍未实现，不应把这些缺代码项归成只等云资源。

tombstone 是 protocol family `2026-10-08` 内的 additive capability；它没有为这次扩展提升 exact protocol version。router 不把 DELETE 发到旧公开路径，而是改写成带内部 token 的版本化 POST，并要求新 runner 回 ACK；即使错误地把共享 LB URL 配成 target 且探测/请求落到不同 Pod，旧 runner 也只会 404，不会执行旧删除语义。正确拓扑仍要求 `RUNNERS` 一项对应一个稳定实例。安全 rollout 顺序是：先在 API gateway 暂停精确 session DELETE（或把流量整体切到新 router 池）→ 发布新 router 且保持 `SESSION_TOMBSTONE_ENABLED=0` → 排空全部旧 router → 滚动新 runner → 核对配置中的每个健康 runner 都声明 `tombstone` → 将新 router 的 gate 设为 `1`。显式 gate、内部 token 与 router 的全健康 fleet capability 检查必须同时满足；升级窗口中其它 API 可继续提供，DELETE 返回可重试 `503 draining`。仅逐个替换 router 而不先阻断旧 router 的 DELETE 并不安全，因为旧进程没有这个 gate；runner 端口也必须通过网络策略保持内网不可直连。

Blob写入采用`0010` ownership manifest/outbox、`0027` shared namespace control与`0028` offline mover三层边界。先应用`0027`/`0028`并保持两个control dormant；部署理解S3 capability/control、mover runtime gate且Blob/export/T3e writer gate都关闭的新router/runner，随后彻底排空旧writer。独立验证目标bucket为private、从未启用versioning/Object Lock、没有lifecycle配置、仅服务writer可覆盖对象，并支持条件PUT/CAS和所需强一致性。空库可以直接设置`BLOB_STORE=s3`与`BLOB_STORAGE_CONTROL_ENABLED=1`让runner探测并执行generation 1 activation；非空filesystem库必须按上节停服并完成`0028` prepare/copy/verify/cutover/source-cleanup，不能手改manifest/control。恢复后核对全部configured runner报告相同`backend/shared/namespaceSha256/controlGeneration`，再依次开放cleanup/build/admission/writer gate。各VM本地目录、各Pod独立volume、NFS或手工复制仍不能冒充共享数据面；mover成功也只证明DB ledger授权的对象，不证明filesystem root不存在未知orphan。

`BLOB_S3_PRIVATE_BUCKET_ACK=1`仅是production启动所需的人工确认：应用无法跨所有S3-compatible供应商自动证明bucket policy/IAM完全私有。它必须在独立anonymous/public-access检查和权限审计后设置，并保留外部证据；startup probe只证明当时可达、unversioned、无lifecycle配置、Object-Lock关闭、条件create/CAS tombstone及随机probe对象cleanup可见性，不证明供应商支持或需要conditional DELETE。IAM/组织策略还要阻止运行后添加lifecycle或由外部writer覆盖同prefix，并把控制面漂移接入告警。真实云账号、bucket、IAM role、endpoint和Secret参数等待实际资源后填写，不能从本地MinIO值复制或编造。

user erasure 与 legacy tombstone compensation 共用 v2 expand→activate barrier，当前仍只允许本地对可丢弃 user体验：先应用 expand-only `0011`/`0012`/`0013` 和 dormant `0014`；发布 admission `0` 且只接受 v2 固定 ACK 的新 router，排空全部旧 router 与只认识 v1 的旧 worker并等待旧 lease 到期；再以两个 worker flag 都为 `0` 的状态滚动具备 `drain-v1`、`quarantine-v1` 与 legacy compensation 代码的新 runner。`0014` migration 只安装 inactive cutover、job/audit 表、索引和 guards，不扫描、排队、改写 session 或激活 purge。旧 v1 私有 endpoint 故意返回 404，不提供降级路径。

确认 fleet 都是新 binary 后，再逐实例开启`LEGACY_TOMBSTONE_COMPENSATION_ENABLED`；启用的 runner 才声明`legacy-tombstone-compensation-v1`。部分 rollout 期间 v2 barrier保持关闭，直到 router 在本进程观察每个稳定 `RUNNERS` 地址同时声明`quarantine-v1`与`legacy-tombstone-compensation-v1`，才返回固定 ACK。观察后的纯网络不可达会保留进程内 attestation；明确旧版/错误响应会撤销，router重启也会安全暂停claim，直到地址恢复或从配置移除。compensation worker首次获得 ACK 后激活 write-once cutover；从该线性化点起数据库拒绝新的 generation `0` tombstone 写入，不能回退 pre-`0014` writer。它会保留原 `deletedAt`，并在同一事务写 generation `1` terminal event、`session.tombstoned`/不可领取的 `session.purge` intent、append-only audit与job completion；任何失败均回滚且不会删除内容。随后才按需开启`ERASURE_WORKER_ENABLED`，最后依次开启runner、router admission。普通worker继续逐候选隔离确定性claim poison、跨 runner有界请求 abort、child-first tombstone、在 usage 写事务内重验 tombstone proof并停在 `awaiting_purge_policy`。两个 worker 在 staging/production 都默认 `0`，本地脚本显式设为 `1`；admission仍默认 `0`。紧急停止新请求时只关闭 router gate并保持 worker/capable runner运行；关闭 gate绝不撤销已提交 subject或已激活cutover。私有barrier只约束新worker，不能阻止仍直连数据库的旧worker，所以旧worker drain、网络/进程层阻断和forward-fix是硬发布条件。

`0015` 使用独立的 expand→code-aware→management-active 顺序。先在关闭新 erasure admission 的窗口独立应用 expand-only `0015`；再发布 `DATA_GOVERNANCE_MANAGEMENT_ENABLED=0` 的新 router并排空旧 router，随后滚动同样保持 management=`0` 的新 runner。此时新 runner即使管理端点关闭，也必须声明两项 `dataGovernance` 代码感知 capability；只有确认每个 configured稳定地址都健康且声明完整 contract 后，才逐实例将runner management gate设为`1`，最后开启router gate。任何 policy activate或legal-hold管理请求都只能在这个全 fleet门禁之后进入；runner端口仍须由网络策略保持内网不可直连。

policy activate 是提交即生效的 CAS，不提供“预设未来时间”调度。`effectiveAtMs` 是审计/控制时间：事务取得当前 control 锁后写入 `max(本次runner时间, 当前control时间)`，所以时钟落后的另一 runner 不会让审计时间倒退，也不会仅因墙钟回拨而返回 500；generation/行锁才是因果顺序。激活与新 erasure admission 共用 tenant control 锁作为线性化点：新请求若在该点观察到 active policy，就永久绑定其 version/hash，即使该 runner 提供的请求时间早于 `effectiveAtMs`；先提交的 backlog及其幂等 replay仍保留“未绑定”，不会被事后改写。`0015` 的 MySQL `BEFORE INSERT` guards在同一 control 上取共享锁，强制 dormant时必须是 `NULL/NULL`、active后必须是精确 version/hash，绕过新版应用的旧 writer只会失败，不能静默写入无绑定请求。

一旦首个 policy activation或canonical legal-hold control event提交，发布就进入另一条 forward-only 兼容边界：关闭management/admission gate只能停止新管理请求/新erasure请求，不能取消已激活策略、已设置hold或既有request绑定。不得回退到不会验证canonical ledger、不会在erasure admission绑定policy的pre-`0015` reader/writer，也不得删除control/event、手工清空policy identity或执行down migration；故障恢复必须保留证据并forward-fix。active legal hold会继续阻止尚未提交的usage anonymization；释放一个hold不会覆盖同subject的其它active hold。

`0016`采用独立的expand→code-aware→evaluator-active顺序。先在evaluator gate关闭时运行expand-only migration；它只建job/target/decision/authority表与append-only guards，不回填历史awaiting row、不开放任何purge intent。再部署`PURGE_POLICY_EVALUATOR_ENABLED=0`的新router并排空旧router，随后滚动同样gate=`0`、但会声明`policy-evaluator-v1`的新runner。确认每个configured稳定地址当前健康且code-aware后，逐runner开启该gate，最后开启router gate；每次schedule/claim仍需新的token-protected固定ACK。关闭gate只暂停新的evaluation pass，不撤销immutable evidence，也不恢复任何subject；它从不控制物理purge，因为本版本根本没有`dataPurgeExecution`开关。

evaluator rollout不能被描述为destructive activation。当前eligibility用runner记录的wall clock，target也不枚举turn/item/event/approval全量owner内容。`0021`另建DB-clock owner-scan receipt，`0022`把所有已知域与blocker固定为33域plan；`0023` T3e只以独立双gate和最小权限store执行local usage/Blob/export子集，`0024` T3f再原子清理session/idempotency/lifecycle/Blob/export等11个数据库投影，`0025` T3g最后精确清理session-scoped Redis lease/owner、fence与stream。三者都不把0016候选直接变成全局许可。`0030`只闭合T1 journal/fence恢复，`0031`再补backup来源authority和epoch reservation，`0032`～`0035`安装logs/traces安全入口、default-dormant lifecycle/writer/application-capture substrate及S3-compatible writer target；完整execution仍要取得external secret/KMS、backup内tenant erasure与其它domain恢复证据、telemetry delete/ACK/restore journal、真实managed环境及其它completion ACK。`0016` completion、`0022` executionReady及T3e/T3f/T3g `allDomainsComplete`都固定为false。

`0017` user export采用expand→code-aware→worker→admission。先独立应用migration，再发布`DATA_EXPORT_REQUESTS_ENABLED=0`的新router并排空旧router；滚动同样admission=`0`的新runner，使每个地址都声明`userDataExport=["artifact-ndjson-v1"]`。filesystem只允许本地单runner先开cleanup、再开build worker，确认独占root后才开放admission。共享S3模式还必须先完成空库`0027`activation或非空库`0028`离线cutover，并让全fleet namespace capability一致，再在staging依次验证跨runner snapshot pin、分片发布/下载、下载中断与续租、TTL/撤销竞态及exact-identity cleanup，最后才开放admission并promotion同一image digest。关闭admission不撤销已有请求；worker仍须把queued/building job推进到ready/failed或安全清理，status/download只要求code-aware healthy fleet。

`0018` tenant erasure schema 仍是 expand-only，T2 则在不改 schema 的前提下增加独立 platform authority、router-only admission/status/replay、runner-local gate 与 fresh all-configured fleet barrier。安全激活顺序是：先应用 `0018` → 发布 tenant gate=`0` 的新 router并排空旧router → 以gate=`0`滚动全部新runner → 逐runner开启local admission capability → 核对每个configured稳定地址当前健康且code-aware → 最后开启router gate。任一目标不可达、版本不兼容或local gate关闭都会阻止新admission；status与exact replay在router gate关闭时仍可用。0030 generation `0`沿用精确已提交replay返回`202`的旧语义；0030 active后，create可能已提交T1，但create/exact replay在publication receipt可读前均返回可重试`503`，调用方必须用完全相同tenant/body/`Idempotency-Key`重试，receipt可读后才返回同一`202`；未命中也返回`503`且绝不创建。首次提交会立即建立不可撤销的lifecycle/credential fence，之后只能forward-fix。

`0019` T3a在`0026`上线后采用expand→ledger-aware→drain-old-writer→tracking-cutover→worker→execution-gate顺序。先应用default-dormant `0026`；以`CREDENTIAL_LIFECYCLE_TRACKING_ENABLED=0`部署全部新router/runner并完全排空pre-0026 writer，核对每个configured runner声明`versioned-target-ledger-v1`；随后显式启用runner tracking，让一个实例完成write-once cutover，并确认全fleet观察active；再开启router tracking gate。activation在runner监听、bootstrap mutation和worker启动前执行，但在T3g durable restore preflight之后；restore、tracking读取或activation阶段失败会关闭当时已创建的store/lease/bus/adapter，commit后响应丢失只允许重读active恢复；后续bootstrap、应用装配或listen失败不在该显式清理边界内。此后再以`TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED=0`滚动/开启worker，核对`credential-store-v1`和worker-active，最后开启router execution gate。worker每次materialize/claim及紧邻不可逆事务前仍要求fresh ACK；新admission与execution gate独立。tracking或首个T3a receipt任一cutover后均不得回退旧writer/worker。当前activation由startup flag触发且没有fleet-barrier migration Job，误开会让旧writer fail closed并造成可用性事故；production必须严格执行drain顺序，M4再提升为独立受审计发布步骤。

`0029` external-credential target execution再使用独立的expand→code-aware→worker→execution-gate顺序：先应用default-dormant migration；发布`TENANT_CREDENTIAL_TARGET_EXECUTION_ENABLED=0`的新router并完全排空旧router；滚动`TENANT_CREDENTIAL_TARGET_EXECUTION_WORKER_ENABLED=0`且声明`external-credential-execution-v1`的新runner；确认全部configured稳定地址健康后逐实例开worker，最后才开router gate。materialize、claim、续租、adapter mutation和seal都重新取得fresh ACK；首个receipt/cutover后只能forward-fix。当前唯一fake adapter只允许Memory与非production，因此标准MySQL local-service固定双gate关闭；真实provider adapter完成、经安全审计并在staging验证前不得照此激活。KMS不在该执行面内，始终保持未完成。

`0020` T3b使用与T3a分离的expand→endpoint-aware→worker→execution-gate顺序。migration只建runtime job、immutable per-target receipt和aggregate receipt，不扫描/回填`0019`、不触发网络drain、不改写T3a receipt。先以`TENANT_RUNTIME_DRAIN_EXECUTION_ENABLED=0`部署新router并排空旧router；再以runner两个T3b gate=`0`滚动新代码，为每个configured slot配置唯一且重启不变的`RUNNER_ID`，并确保`RUNNERS`逐项是该实例的直连稳定URL。逐runner开启`TENANT_RUNTIME_DRAIN_ENABLED`，核对所有地址的私有ready identity后再开启`TENANT_RUNTIME_REVOCATION_WORKER_ENABLED`，最后开router execution gate。每个claim将terminal T3a proof广播到所有精确target；runner先同步fence新auth/provider/turn admission，中止tracked本地I/O、等待有界结算并丢弃policy/verifier/provider references。router在fanout前后重新取完整fleet快照，任一boot/runner/target变化都拒绝aggregate proof；store再把全部target receipts、aggregate receipt和terminal job于同一事务提交。

T3b的紧急回滚首先关闭router execution gate，再让worker在当前job边界停领；不要先撤私有endpoint，否则已claim的fanout只会反复失败。关闭gate不会重开已fenced tenant、恢复cache/reference、撤销immutable receipt或改变T3a proof；一旦有`0020` terminal证据，故障恢复必须保留schema/proof并forward-fix，不得回退到会忽略T3b fence的版本。

`0021` T3c采用独立的expand→worker-active顺序，不增加router端点或execution gate。先应用migration，再以`TENANT_CONTENT_INVENTORY_WORKER_ENABLED=0`滚动全部新runner；确认严格schema fingerprint、append-only guards和新binary已就绪后，才逐实例启用worker。materializer只从完整T1/T3a/T3b terminal proof建立job；anchor不得早于T3a/T3b DB proof high-water，clock落后source/anchor/evidence时保持可重试。build/seal事务显式使用REPEATABLE READ，并重验immutable policy、tenant及全部user legal hold、session/turn/item/event/approval关系、连续event seq和全局orphan；`contextCompaction` synthetic turn与legacy approval item字段按canonical兼容规则处理。page/seal在最后一个可能阻塞的receipt INSERT后重读DB time并复核live lease，过期整事务回滚。关闭worker只暂停新claim，不能撤销receipt；首个`0021`证据提交后必须保留schema并forward-fix。seal当前锁定并扫描五类全局content表，属于local/CI正确性基线；生产启用前仍要用owner索引/FK/分区或等价设计消除全表扫描，并完成容量与写阻塞验证。

`0022` T3d采用另一条独立、无router execution端点的expand→worker-active顺序。先应用migration，再以`TENANT_PURGE_PLAN_WORKER_ENABLED=0`滚动全部新runner；确认三张表的strict fingerprint、append-only guards和新binary已就绪后才逐实例启用。worker只从terminal T3c及完整immutable source显式materialize，并对新空job直接seal；Memory单一原子边界/MySQL单个RR事务一次性写33条entry、aggregate和terminal job，同时重验source、canonical hold、全局owner closure、DB clock与post-write lease。MySQL对idempotency、usage ledger/reconciliation的全范围owner扫描持有`FOR SHARE`锁至commit，阻止扫描后phantom；legacy pending `NULL`保留，legacy completed `{turnId}`只允许反向解析到同一session，现代值若带`sessionId`则也必须匹配。operational usage允许无turn row的synthetic/legacy turn，但必须同session owner；reconciliation必须匹配已tombstone session的精确正generation。lifecycle↔request/admission需双向闭合，purge target需精确匹配tombstone generation/time。分页build只保留诊断/兼容用途，不由生产worker调用。新plan按0026精确target disposition把真实external `executable_ref`记为可撤销，legacy/source blocker继续阻断，KMS仍全部阻断；历史pre-0026 plan继续按冻结的粗粒度T3a证据校验。关闭只暂停新plan，不撤销receipt；首个`0022`证据提交后必须forward-fix。计划含blocker仍可seal，但`planComplete`永远不能被promotion流程解释为execution ready。

`0023` T3e再采用独立的expand→code-aware→cleanup/worker→execution-gate顺序。先应用migration；发布`TENANT_PURGE_EXECUTION_ENABLED=0`的新router并排空旧router；再以`TENANT_PURGE_EXECUTION_WORKER_ENABLED=0`滚动全部新runner，使其先声明`local-execution-ack-v1`但不接触queue。filesystem只能在local单runner确认root独占后使用；S3多runner则必须先完成空库`0027`activation或非空库`0028`离线cutover、全fleet namespace收敛及真实staging跨runner cleanup验证。两种模式都要先开启Blob/export cleanup，待全部configured runner当前健康且T3e worker-active后最后开router gate。worker在materialize、claim、lease、cutover和physical seal前都取得fresh non-sticky all-configured ACK；首次cutover同时提交usage anonymize、export revoke/snapshot release、exact outbox、domain ACK和write-once cutover，以后只能forward-fix。关闭gate只暂停新边界，不能恢复已修改数据或撤销durable evidence；S3 adapter存在不等于external/KMS、backup/restore、logs/traces或全域completion已完成。

`0024` T3f采用单独的expand→router-first drain→runner worker→execution-gate顺序。先应用migration；发布`TENANT_DATABASE_PURGE_ENABLED=0`且理解两个capability的新router，并完全排空所有旧router；然后才以`TENANT_DATABASE_PURGE_WORKER_ENABLED=0`滚动新runner，再逐实例开worker，最后开router gate。不能runner-first：旧router的严格capability parser会拒绝新runner的`["local-execution-ack-v1","local-db-content-delete-v1"]`。首个T3f cutover后只能forward-fix；关闭任一gate只暂停新边界，不能恢复已删投影、移除grave或撤销不可变证据。

`0025` T3g采用独立的expand→marker-aware router→marker-aware runner→worker→execution-gate顺序。先应用migration，并给所有router/runner设置相同且准确的非密钥`REDIS_NAMESPACE_ID`与`REDIS_PREFIX`；发布`TENANT_REDIS_PURGE_ENABLED=0`的新router并完全排空旧router；再以`TENANT_REDIS_PURGE_WORKER_ENABLED=0`滚动marker-aware新runner，并在任何T3g mutation前完全排空旧runner。核对`RUNNERS`中的稳定直连地址全部健康、声明`session-state-delete-v1`且namespace digest一致后，保持router gate关闭并逐实例开启worker；这允许重放已有durable ACK marker，并用existing-marker-only Lua收口未ACK marker，但不会materialize新job或创建首次marker。全部worker-active后最后开启router gate。首个marker、target ACK或cutover后只能forward-fix：可关闭router gate暂停新materialize/mutation，但worker必须保持开启以继续existing-marker replay、补ACK/seal和durable restore，不能改namespace identity或回退到marker-unaware binary。fleet barrier无法约束仍存活且能直接写Redis的旧进程，所以旧runner drain不可省略。

`0032`～`0044`是expand/code-aware、default-dormant的telemetry链（`0043`无DDL）。`0033`负责lifecycle activation/coverage/inventory，`0034`负责payload-before-sink spool、reservation/ACK和默认关闭的runner worker，`0035`分离per-domain producer capture；当前只接`provider.upstream_request_failed` logs，traces必须inactive。filesystem writer仅限本地单runner且production拒绝；S3-compatible writer只提供对象写入协议，本地MinIO不证明云IAM/TLS/故障域。`0036`/`0037`的外部处置仍为非生产协议和真实grant硬拒；`0038`～`0041`依次封存新write membership、T3f owner closure、T3d source与观察目标；`0042`让新plan拥有精确逐artifact logs/traces count/root及独立receipt，旧plan缺catalog仍为unknown；`0043`只给出本地来源候选，`0044`原子封存默认休眠的pre-grant intent/claim。新plan即使非零target，两域依然`blocked_adapter_unconfigured`，无产品外部删除/恢复权。普通`start`/`verify`保持application capture与处置默认inactive；0035 v1及外部处置仍没有受控activation/operator CLI、source-valid DB grant、物理marker验真、最新external head恢复核对、旧快照replay/startup gate或外部处置跨MySQL/S3端到端证明。0053的local-only v2日志capture operator另见专节，不改变上述删除/恢复限制。后续仍须闭合不可扩权授权、执行/ACK和恢复链；LIST不能充当journal authority。所有terminal completion=false，0044不增加daemon、进程、bundle入口、维护命令或第三个镜像。

`0036→0037`是严格指纹变更，不是原地热切换：先保持全部telemetry disposition/grant/product mutation关闭并排空pre-0037 router/runner，再以独立migration Job轮换trigger并核对完整schema、83-trigger指纹及零执行footprint，最后只启动0037-aware binary。pre-0037 binary在post-0037 schema上会因strict fingerprint拒绝启动，不能靠回改0036或删marker“修复”；保留新hard-deny guard并forward-fix。MySQL grant INSERT即使claim hash匹配也仍拒绝，Memory/MySQL issue/get不签发grant；0037没有可用于生产的S3 v2 journal、ACK worker或恢复gate。

`0037→0038`也不能原地热切换：先保持telemetry writer、application capture、disposition及grant相关gate关闭，摘流并完全排空pre-0038 router/runner和在途write；用独立migration Job安装不可变sidecar表及additive job guard，核对严格schema/87-trigger指纹、零执行footprint和旧job未被回填；最后只启动0038-aware进程。pre-0038 binary在post-0038 schema上按严格指纹fail closed，新job不可能在缺少同事务sidecar时发布。不得删除marker、移除旧0035 guard或把历史job JSON补造为可信membership；保持grant hard-deny并forward-fix。写时keyed owner tuple claim也不是T3f之后的独立owner closure，T3d logs/traces继续零target blocker，不能把0038当作外部删除/restore启用许可。

`0038→0039`是另一次不兼容的strict fingerprint切换，不得把新schema与pre-0039 T3f writer滚动混跑。先关住telemetry writer/application capture、T3f和disposition相关gate，摘流并真实排空全部pre-0039 router/runner，特别是T3f claim与在途destructive事务；再由独立migration Job安装两张append-only closure表、原有write-job上的加法式身份guard与T3f terminal guard，核对严格schema/95-trigger指纹、default-dormant零执行footprint和历史数据无回填，最后只启动0039-aware进程并按原T3f gate顺序重新开放。pre-0039 binary在新指纹下fail closed；已提交的entry若缺aggregate/terminal，marker-loss重放也fail closed，不能删marker、删除guard或补造旧receipt来绕过。新的T3f要求0038 sidecar与live canonical owner重算，零write仍产生empty-set receipt；旧terminal缺receipt保持`unknown`，不自动赋予外部删除权。独立`0038→0039`真实MySQL夹具覆盖冻结0038 write保持、DDL断点/marker-loss、孤立entry投影阻断、schema/trigger冲突与缺closure的terminal更新；冻结0038二进制在真实旧schema完成terminal T3f再升级的专门夹具已通过，但旧terminal没有非空telemetry artifact；真实N-1混合发布仍待staging验证。

`0039→0040`同样是strict fingerprint边界，不允许在新schema上混跑pre-0040 T3d writer。先保持T3d、telemetry capture/disposition和grant相关gate关闭，摘流并排空旧router/runner与在途plan事务；独立migration Job安装append-only source entry/aggregate与同事务terminal guard，核对严格schema/103-trigger指纹、历史terminal未回填和零外部mutation，最后启动0040-aware进程。新T3d在原plan事务内全范围核对inventory、write job、ACK、0038 membership及0035 binding；legacy、未完成或孤立source显式为unknown，旧terminal缺0040 receipt也只能保持unknown。该证据只用于后续授权的前置审计，不解除logs/traces零target blocker、0037 grant硬拒或全域completion=false。全表锁与后续grant验证的容量、锁等待和lease预算仍需staging验收。

`0040→0041`仍是strict fingerprint边界，不能让pre-0041 T3d writer在新schema上热混跑。保持T3d、telemetry capture/disposition和grant gate关闭，摘流并排空旧router/runner及在途plan事务；由独立migration Job安装逐source观察目标entry/aggregate、append-only和terminal双receipt guard，核对111-trigger指纹、旧terminal未回填、grant与外部事件零新增，再只启动0041-aware进程，之后forward-fix。新T3d在0040同一事务逐源精确覆盖，只有inventory/job/ACK/membership/binding/owner闭合才有一个**观察**目标；unknown和孤立源为零观察目标。它不是33域可执行target，readiness固定`executionReady=false`，不能启用grant或产品外部mutation/restore。冻结0040旧二进制已在旧schema完成真实T3d terminal再升级，验证旧receipt保持、缺0041 manifest为unknown；该旧terminal没有非空telemetry artifact。全表锁/lease预算、真实旧版本排空及容量仍待staging验收。

`0041→0042`再次改变strict fingerprint，不能让pre-0042 T3d writer在新schema上热混跑。保持T3d、telemetry capture/disposition/grant gate关闭，摘流并排空旧router/runner与在途plan事务；独立migration Job安装逐artifact目录/receipt、append-only和terminal三receipt guard，核对119-trigger指纹、旧plan/hash不回填及零外部执行footprint，再只启动0042-aware进程并forward-fix。新T3d在同一次锁定的五源/owner快照上先推导logs/traces精确count/root，再与0040/0041、独立catalog receipt及terminal原子发布；零目标也写显式receipt。旧0041 terminal保留原零target plan、缺0042 catalog为unknown，不从观察目标反推。新plan即使目标非零也仍`blocked_adapter_unconfigured`、`executionReady=false`，不能启用grant或产品外部mutation/restore。冻结0041旧二进制非空terminal升级夹具只证明本地兼容；真实N-1排空、全表锁/lease预算与容量仍待staging验收。

`0043`不引入新migration或部署组件，在已安装0042 schema上是代码级升级。新T3e live recheck会在锁定的五类source与真实canonical owner上复算0040～0042证据及原plan的非零logs/traces count/root，避免把合法新plan错误地按旧零target处理；MySQL 1205/1213锁等待或死锁保持可重试，不应被持久化为永久`integrity_conflict`。T3f后新增的只读本地来源诊断仅在terminal T3f、0039 owner closure/grave、0040～0042目录、当前T1/hold/control、DB clock及restore runtime均闭合时返回`local_source_candidate`和content-free artifact count，其余为`unknown`；无论结果如何都固定`executionReady=false`、`externalAuthorityVerified=false`。它不授予0037 grant、不调用外部journal、marker或adapter，也不收口物理ACK/全域completion。冻结0042旧二进制的真实MySQL夹具核对旧非空T3e的已知阻断及旧零target T3f终态的只读兼容；旧代码已持久化为blocked的job不会自动解封，必须另设计受审计的operator修复协议，不能手改状态。0043没有strict fingerprint变化，但如果实际库尚未安装0042，仍须先按上面的停旧writer/独立迁移流程完成0042；不能因为0043只改代码就放松之前的滚动升级门禁。

`0044`需要新的独立迁移窗口：保持telemetry writer/application capture/disposition/grant和T3d/T3f相关gate关闭，摘流并排空pre-0044 router/runner与在途事务，安装两张append-only表及七个guard，验证严格126-trigger指纹、旧证据不变、历史plan未回填和默认零intent/claim，再仅启动0044-aware进程。新增guard使pre-0044 binary的旧指纹拒绝新schema，不能热混跑或删guard/marker回退。独立真实MySQL `0042→0044`迁移夹具固定发布的0042 SQL链（0043仅代码），证明首DDL中断和marker-loss重放；它没有执行冻结0042产品二进制或生成非空T3f terminal。普通本地`start`不创建pre-grant记录，只有显式store调用才可能写入；claim租约到期或DB时钟回退须整事务回滚。即使已记录intent/claim，0037 hard-deny、T3d logs/traces blocker、外部mutation与全部completion门禁仍保持。

`0045`～`0048`只增加GET-only v2/artifact/v3观察器和显式非生产v3 journal夹具，无新DDL或产品服务；即使真实MinIO suite观察到sealed chain或same-key tombstone，也不能据此执行删除或恢复。`0049`须再开独立schema窗口：停止telemetry capture/disposition和T3d/T3f相关gate，摘流并排空全部pre-0049 writer与在途事务，安装三张dormant表/13 guards并核对严格139-trigger指纹、legacy数据保持和零coverage/binding，之后只启动0049-aware进程。旧0044 binary不能在新指纹热混跑；control仍inactive、activation/binding/job SQL硬拒，异常v2 footprint让旧五源T3d/T3f及v1 writer安全拒绝。独立真实MySQL `0044→0049`夹具是SQL-shaped 0044历史，不是旧二进制非空terminal验收。

`0050`的五个nullable session证据列和CHECK可在停旧writer的迁移窗口安装，独立真实MySQL历史夹具从预置0044经0049升级到0050。旧DELETE writer即使在0050 schema上运行也只会留下origin NULL/unknown，0050阶段没有强制双写或write-once origin trigger；因此要保证新普通DELETE的30天来源覆盖，必须先停旧writer并只运行0050-aware路径。新DELETE首事务与tombstone/event/outbox原子提交origin，post-COMMIT第二事务才观察DB时间并seal保守floor；响应或第二事务失败可精确重试。后续runner内嵌恢复caller独立默认关闭，只有在旧writer及在途请求排空、0050 schema与新writer确认后才逐实例设置`SESSION_DELETE_GRACE_RECOVERY_ENABLED=1`；它只补可信未seal来源，没有CLI/新进程/物理purge权限。损坏候选会fail closed，不能通过跳过或手工伪造origin宣称完成。不得把floor写入`purge_after_ms`、手工开放`session.purge`或把30天取代90天等更长canonical policy/hold。SQL shape/marker漂移会阻断startup，但N-1 mixed-writer真实演练、不可绕过的来源覆盖和最终自动执行仍未完成。

`0050→0051`必须另开停流/排空窗口：先停止普通DELETE入口并排空全部pre-0051 writer及在途事务，单独安装create-only `BEFORE UPDATE` trigger后核对完整动作、140-trigger相关组合指纹与0051 marker，只启动0051-aware进程并forward-fix。已记录origin的digest、DB时间、BINARY owner、删除generation/time、lastSeq以及已seal的时间/floor/digest都write-once；旧无origin行不能事后补造ordinary。精确trigger已落库但marker未提交可重放，动作漂移会拒绝。trigger只限制行形状，不证明可信业务来源或跨COMMIT先后；旧普通DELETE仍可写unknown，T3f仍可删除整行。`session.purge`不可领取且物理清理仍默认关闭。

T3g restore不是完整Redis-loss保证：same-MySQL keyset只枚举已经写入durable target ACK的marker。正常marker-only窗口可由worker轮询中的existing-marker-only replay在gate关闭时收口；但若Lua已写marker而MySQL ACK尚未提交，且该marker在worker成功replay并持久化ACK前又从Redis丢失，首次lease/fence/stream existence bits无法恢复。MySQL和Redis同时恢复到旧snapshot也不受保护。大tenant restore keyset扫描/重放性能、独立故障域ledger、永久marker容量和普通live-session fence灾备仍待设计/压测。当前真实Redis自动测试使用standalone ioredis并验证same-slot key grammar，但真实Redis Cluster、ACL、persistence与failover只能在staging/production资源就绪后验收。

当前MySQL实现会在整个T3f destructive transaction内对全局cutover singleton持有`FOR UPDATE`锁，因此不同tenant的数据库清理会安全串行；这是local/CI正确性优先的实现，不是生产吞吐承诺。进入staging前必须以真实数据量验证锁等待、lease预算和超时，并决定是否需要可证明等价的分片/租户级协调。仓库已有冻结的pre-T3f capability parser测试来证明runner-first不兼容，但真实N-1 router镜像canary、排空和回滚演练仍必须在staging完成；不能只凭单进程单元测试宣称滚动升级已验证。

T3d上线staging前还必须验证全库RR/next-key owner扫描的索引、容量、跨tenant写阻塞/死锁、lease预算和锁超时；这些未被local/CI正确性证明覆盖。损坏queued plan envelope可能在逐候选隔离前饿死后续job，cursor重启还会重扫损坏前缀；当前fail-closed且无receipt/执行权，但需M4 raw-key quarantine/skip或人工维护。`0022` trigger fingerprint不校验action body，迁移夹具只显式模拟首个DDL auto-commit边界；预发还须扩展schema tamper与中断迁移演练。生产runtime principal无DDL/TRIGGER权限仍是**未实现的M4目标**：当前runner连接默认执行migration，verify-only校验又直接读取`INFORMATION_SCHEMA.TRIGGERS`。本机MySQL 8.0.26一次性账号实测，仅授予`SELECT`时直接查询与`SQL SECURITY DEFINER` view均看不到已存在的trigger；授予`TRIGGER`虽可见，也允许删除trigger；仅授予`EXECUTE`调用受限的definer procedure则能看到真实计数。后续须先以真实MySQL实现并验证可信只读元数据桥接，再交付独立schema-migrate Job、生产runner verify-only与无DDL账号；在此之前不能宣称生产最小权限隔离已经完成。

erasure 现在有三条不可逆回滚边界。第一条是“首次请求已接受”：关闭 router writer gate 只停止新的 erasure POST，绝不会撤销已持久化的 subject gate。writer gate 保持 `1` 时，router 会对 `/v1/sessions*`、`/v1/usage` 与 erasure 路径逐次检查 selected target capability，能力回退即返回可重试 `503` 而不转发；gate=`0` 的 expand mixed window仍可提供普通 runtime。首次接受后必须保持所有处理 user 请求的 runner 都 lifecycle-aware，并优先 forward-fix；不能把业务流量回退给 pre-`0011` 或其它不检查 `subject_lifecycle` 的 runner，否则已 gated subject 可能重新可见并产生新写入。

第二条是“任一 quarantine/maintenance control event或terminal incident已写入”：此后不能回退到pre-`0013` reader/worker。router sticky observation在明确观察到旧runner时会关闭新claim，但它约束不了绕过router、直接连接数据库的旧worker；事故处置必须forward-fix，或先排空/阻断全部旧worker和受影响流量。若确实必须恢复pre-`0011`版本，先在edge精确阻断受影响tenant/user；edge无法可靠识别时先阻断全部user-scoped runtime。`0011` gate/audit、`0012` queue和`0013` control/incident history都必须保留，不能用down migration、feature flag或镜像回滚把它们当作已撤销。

第三条是“`0014` cutover 已激活”：该 singleton 只允许 inactive generation `0` 到 active generation `1` 的一次转换，不能 disable、删除或重写证据。激活事务与 session writer 通过行锁线性化；提交后继续运行 pre-`0014` writer只会产生被数据库拒绝的 legacy 写入，并可能让业务请求失败。关闭 compensation worker不撤销 cutover，回滚必须是 forward-fix 到兼容 reader/writer，不能执行 down migration 或手工修改 singleton/trigger。

轮换 `INTERNAL_ROUTER_TOKEN` 时先把 tombstone、user-erasure、tenant-erasure writer gate、T3a/T3e/T3f/T3g/0030 execution gate与T3b router execution gate都设为`0`，并让会取得新authority的erasure worker在当前原子job边界停领；durable subject/tenant gate与历史job保持不变。T3g worker只停止新materialize/mutation，仍必须保持启动，以继续不扩权的existing-marker replay、补ACK/seal与durable restore；0030 control激活后publisher也必须保持配置/启动，但router gate关闭会暂停新的journal mutation。随后在新的破坏性请求被拒绝、历史job暂停推进的窗口内，让全部runner和router收敛到新值，核对私有barrier、drain、健康与公开capability后再先恢复endpoint/worker/execution、最后恢复writer gate。当前不支持双token重叠窗口。轮换 `TENANT_ERASURE_OPERATOR_TOKEN` 时也应先关闭 tenant admission；status 读取需要新 token，因此要协调客户端和 router 的切换，且该 token 永远不得注入 runner。任一 token 都不得写入镜像、Git、日志或公开 API 文档。

未来真正改变 protocol version 的不兼容 contract 仍由健康探测隔离：版本不匹配的 runner 不进入 hash ring，也不能通过 owner 重路由；这类升级需要全量 drain 的维护窗口或将旧/新 router+runner 整组 blue-green，除非另行实现 version range/按版本路由。`session/deleted` 本身不属于这类版本提升。

当前自动验证的候选发布物仍是两个独立的 Linux OCI 镜像：`agent-router` 与 `agent-runner` 分别构建和启动检查，未来可以位于不同虚拟机或容器节点；runner镜像除默认`main.js`外还包含显式调用的一次性`blob-storage-migrate.js`、`restore-ledger-reconcile.js`、`backup-catalog.js`和`telemetry-capture.js`，但不会因此新增额外常驻进程或镜像。当前 workflow 不上传它们。“不可变镜像”指未来发布到 registry 后由 digest 唯一确定，进入 staging/production 时不再重新编译或修改；不是 Windows/Linux 的虚拟机磁盘镜像。

`pnpm build`生成router长期入口`apps/agent-router/dist/main.js`、runner长期入口`apps/agent-runner/dist/main.js`和runner四个一次性维护入口`apps/agent-runner/dist/blob-storage-migrate.js`、`apps/agent-runner/dist/restore-ledger-reconcile.js`、`apps/agent-runner/dist/backup-catalog.js`和`apps/agent-runner/dist/telemetry-capture.js`，均为Node 24 ESM JavaScript bundle，可在装有对应production dependencies的Linux、macOS或Windows主机运行，但不是原生机器码二进制。目前CI对两个main、四个one-shot CLI和两个容器镜像都有执行门禁；OCI镜像冻结依赖、Node版本和文件布局。用户已决定M4同时交付容器与独立VM进程形态；VM还须增加带校验和的bundle + production `node_modules`发布包和systemd服务，不需要把两个长期服务合成一个二进制，也不应把维护CLI注册成常驻服务。

"本地完整"指已实现链路可在真实 MySQL + Redis + router/runner 下重复运行；当前自动门禁还覆盖双runner user-erasure、policy/hold/evaluator、异步user-export snapshot/artifact/download/TTL/撤销清理，tenant T1/T2 platform控制、T3a本地DB credential-store物理清除、`0026` versioned credential lifecycle/tracking/T3a inventory、`0027` write-once Blob namespace control与真实MinIO跨client语义、`0028`离线filesystem→S3 mover及runtime gate、T3b per-tenant runtime/cache/active-I/O drain与configured-fleet proof、T3c可信DB时间和owner-scan完整content receipt、T3d固定33域plan和显式blocker、T3e本地usage/Blob/export cutover与physical ACK、T3f本地数据库11域删除/ACK/grave/cutover、T3g真实Redis三域Lua删除/永久marker/startup-periodic replay、`0029`external-target Memory fake/真实MySQL账本、`0030` independent journal/runtime/replay ledger、`0031` authoritative catalog/snapshot/source-binding/runtime-reservation/retention账本、真实MinIO adapter与one-shot CLI，以及`0032`～`0035` safe structured logging/W3C tracing、原子telemetry activation/coverage/artifact inventory、default-dormant durable writer/reservation/ACK与S3-compatible writer target。它不表示云依赖已被本机替代，也不表示数据生命周期闭环：0029 fake不是远端provider证明，标准MySQL栈不会启用它；0030/0031仍是单target、跨DB/S3 saga与operator流程，0031不创建物理backup或证明backup内tenant erasure；0035只接单一provider failure logs producer；0053只补local-only v2日志capture operator；仍没有traces producer、0036～0044可执行delete/restore链或completion。0037只修正grant hard-deny guard并提供非生产v2 Memory事件夹具，0038仅给新受管write保存逐项sidecar，0039只补T3f本地owner-closure证据，0040～0042只补T3d本地source-accounting、观察目标及逐artifact目录证据；0043只提供本地来源候选，0044只封存默认休眠的source-bound pre-grant intent/claim；这些切片都不签发真实DB grant，也无产品v2 S3 mutation、physical ACK或旧快照恢复证明。真实provider adapter、全部KMS、完整telemetry执行生命周期、managed对象存储/IAM/KMS验收、completed proof及generic session/user物理purge仍待完成。filesystem Blob/export/T3e只证明单runner本地语义；本地MinIO证明S3-compatible协议、跨进程可见性和小规模mover/journal/catalog/telemetry writer正确性，但同机不同名bucket不能外推成故障域、云IAM、SLA、容量或维护时长验收。same-MySQL T3g replay也不能冒充独立restore proof；T3c全表扫描、`0028`全量内存/大事务inventory及0033/0034全tenant startup audit同样不能外推成生产容量；任何局部ACK都不能被当成全域adapter已实现。无云资源不阻碍这些local/CI代码范围，但真实对象存储、KMS/IAM、managed Redis、backup producer、恢复与rollout集成仍属于M4/环境交付缺口。

当前 `MysqlSessionStore.connect()` 仍会自动执行迁移，适合 local/CI，但还不满足上文“生产迁移作为独立 Job”的目标。进入 staging 前必须拆出显式 migration 命令/Job，并让业务进程只做 schema 版本检查、禁止启动时自动 DDL；同时完成备份恢复与迁移失败后的人工审计/重试演练。

暂不生成绑定某一云厂商的 Kubernetes YAML/Helm values；待 namespace、域名、镜像仓库、Secret/KMS、MySQL/Redis 地址和资源配额明确后再生成，避免把临时假设固化进部署资产。

迁移 `0008_atomic_turn_writes.sql` 会为 completed receipt 增加请求 hash，并给 usage ledger 建业务唯一键。

迁移 `0009_session_tombstone_outbox.sql` 增加 nullable `purge_after_ms`、默认 `0` 的 `deletion_generation`、parent lifecycle index 和 durable lifecycle outbox。固定 0008 历史库的真实 MySQL 夹具验证旧 deleted row 保持 generation `0`，迁移可重入且不会伪造 cleanup intent；这些历史 row 现在由 `0014` 的独立、可审计补偿流程处理，而不是由 migration DML 静默改写。

迁移 `0010_blob_ownership.sql` 是 expand-only：新增大小写敏感的 `blob_objects` ownership manifest 和独立 `blob_delete_outbox`，不回填或改写既有 session/lifecycle 行，也不启用 ready Blob purge。固定 0009 历史库夹具通过真实 migration runner 证明历史 session/outbox 保留、迁移重入安全、identity collation 与唯一索引符合预期；CI 另有显式不得 skip 的真实 MySQL Blob lifecycle 套件，证明 item 绑定原子性、owner 隔离、rollback 和并发 claim，而不仅是 fresh-schema 建表成功。

迁移 `0011_erasure_and_usage_separation.sql` 也是 expand-only：为 `usage_ledger` 增加 nullable、大小写敏感的 opaque `usage_id` 及唯一索引，新增只含最小财务字段的 `billing_usage_facts`、`usage_reconciliations`，以及 `subject_lifecycle`、`erasure_requests`、`erasure_audit_events`。它不会给历史 usage 伪造 ID 或 billing fact，不执行 reconcile/anonymize/purge，也不会伪造 erasure request；新写入才事务双写 operational 与 billing 两层。restart-safe `AFTER INSERT sessions` trigger 会为迁移后仍存活的旧 writer 原子补 tenant/user lifecycle 行，重放只做 insert、不会覆盖 gate/legal hold；它不拦截旧 writer 对已有 session 的写入，所以不能替代升级 drain。固定 0010 历史库的真实 MySQL 夹具验证 DDL auto-commit 中断后可重跑收敛、错误形状 identity 索引可修复、大小写敏感约束、旧 writer post-migration insert 与 gate/hold 保留，且既有 usage/session/outbox/blob 原样保留。CI 的 usage/subject lifecycle 独立套件不得 skip，并由 suite report 明确证明实际执行，而不是只验证 fresh schema。

迁移 `0012_erasure_job_queue.sql` 继续 expand-only：为 request 增加 availability、attempt、claim token/lease、bounded error 与 policy identity，并安装兼容 0011 writer 的 insert trigger。它不会激活 purge；waiting/terminal row 始终不可领取，重放不会覆盖 future retry 或 live claim，残缺 claim pair 会 fail-safe 清空。固定 0011 历史夹具覆盖全部状态、legal hold、不可领取 purge intent、partial DDL、错误索引和 marker-loss replay；CI 还独立强制运行 queue/session/catalog/claim-bound usage 四个真实 MySQL 套件，并从主 report证明真实 MySQL worker的事务内 proof重验确实执行。

迁移 `0013_erasure_job_control.sql` 也是 expand-only：为request增加control generation和三列quarantine overlay，新建append-only control event、append-only terminal incident表及quarantine-aware claim index；它不隔离既有row、不repair/resume、不激活purge。incident只保存request locator、exact raw control fence、fixed reason、SHA-256和时间，不复制tenant/user/subject/status/raw payload。MySQL 8.0.26兼容的多重UPDATE/DELETE trigger guard保证migration marker丢失或中断重放时仍收敛到两类append-only保护；早期错误unique-index形状会被修正，若同一request/generation已有冲突证据则迁移故意失败且不删除任一事件。固定0012历史夹具覆盖完整升级、control/incident建表断点、partial DDL/错误索引/marker-loss replay、两类append-only guards和冲突阻断；CI migration wrapper显式枚举该套件并拒绝missing/skipped。运行时按候选独立事务quarantine，maintenance control与普通worker capability分离。若监控发现 `control_audit_invalid`、terminal incident或safe-integer fence耗尽，则该row是永久terminal isolation：原始identity/time/BIGINT不得手工改写，不能补造event或调用普通repair；应保全证据、停止相关旧worker并通过后续受审计的专用迁移/事故流程处理。

迁移 `0014_legacy_tombstone_compensation.sql` 继续保持 expand-only 和 dormant：新增 inactive write-once cutover、每 session 一个 durable compensation job、append-only result audit、candidate/claim indexes 与 session row guards。应用 migration 本身不会激活 cutover、扫描或排队历史 row、生成 event/outbox、修改 generation、使 purge 可领取或删除内容。固定 `0013 → 0014` 历史夹具覆盖完整升级、DDL 中断/marker-loss replay、错误 index/trigger 收敛、旧数据原样保留、cutover 与并发 legacy writer 的锁线性化，以及激活后的 guard；CI migration manifest拒绝缺失或 skipped fixture。另有 `pnpm test:legacy-tombstone-mysql` named no-skip 套件使用真实 InnoDB 验证 claim/ABA、active资源结算、原子成功发布、audit/outbox失败回滚、child/owner隔离、terminal incident与幂等重试。migration marker本身不等于runtime cutover已激活。

迁移 `0015_retention_policy_and_legal_holds.sql` 仍是 expand-only：新增tenant immutable policy versions、generation-fenced active control与append-only activation audit，并把单个 `legal_hold_at_ms` 兼容shadow提升为tenant/user scoped multi-hold ledger、control和append-only audit。migration会为历史非空shadow生成确定性`legacy_unattributed`证据，但不会创建默认active policy、激活management、修改既有erasure backlog、调度purge、开放`session.purge` intent、anonymize usage、删除内容或推进job；retention duration为`NULL`时始终表示fail-closed不授权过期，当前非`NULL`值也没有自动开启物理purge。固定`0014 → 0015`真实MySQL夹具覆盖历史数据保留、legacy hold证据、DDL中断/marker-loss重放、冲突阻断、append-only/单向release guards以及purge继续dormant；migration wrapper显式枚举该夹具并拒绝missing/skipped。`pnpm test:retention-policy-mysql`是另一条named no-skip真实InnoDB门禁，覆盖immutable版本、并发CAS、事务回滚、跨runner时钟clamp、erasure admission绑定、multi hold及anonymization竞态；`scripts/local-service.sh verify`和GitHub CI都会执行两条门禁，而不是只验证fresh schema。

迁移 `0016_erasure_purge_policy_authority.sql` 继续expand-only和destructive-dormant：新增durable evaluation job、按build generation不可变的per-session target、rooted decision chain、generation-CAS active authority projection与append-only authority。migration不扫描或回填历史awaiting request、不设置`purge_after_ms`、不开放`session.purge`/ready Blob delete、不匿名化或删除任何数据，也不推进`purging/completed`。固定`0015 → 0016`真实MySQL夹具覆盖原policy/hold/request/content保留、partial DDL、marker-loss/replay、append-only trigger轮换、升级后同key异内容写入被拒并保留原证据，以及purge继续休眠；migration wrapper显式枚举该夹具并拒绝missing/skipped。`pnpm test:erasure-purge-policy-mysql`是另一条named no-skip真实InnoDB门禁，覆盖原子job建立、claim/ABA、deadline、live evidence/hold重评、并发锁顺序和seal回滚。

迁移 `0017_user_export_jobs_and_artifacts.sql` 继续expand-only：新增request/job、白名单snapshot、source-Blob pin、artifact/part、download lease与artifact-delete outbox表，不创建请求、不扫描或复制历史内容，也不打开任何HTTP gate。固定`0016 → 0017`真实MySQL夹具覆盖历史数据原样保留、完整升级、partial-DDL/marker-loss重放、append-only guard轮换和表/index/nullable staging descriptor契约；migration wrapper拒绝missing/skipped。`pnpm test:user-data-export-mysql`是named no-skip真实InnoDB门禁，并包含真实core worker跨越claim→consistent snapshot→stage→Blob put→upload ACK→ready publication的跨层证明。

迁移 `0018_tenant_credential_revocation_fence.sql` 仍是expand-only：新增每tenant至多一条、append-only的`tenant_erasure_admissions`和append-only credential fence，不创建tenant worker job、不撤销物理credential、不启动worker，也不修改旧`erasure_requests`或其scheduler trigger。固定`0017 → 0018`真实MySQL夹具精确检查新表列/索引/guard，证明历史credential/export/request/trigger保留、新admission脱离旧claim扫描、user scheduling保持，并覆盖partial-DDL、marker-loss逐语句重放与不兼容同名表在写marker前fail-fast；migration wrapper显式要求该夹具且不得skip。`pnpm test:tenant-credential-revocation-mysql`另以两个named真实InnoDB文件证明原子gate/fence/status proof、rollback、race与跨tenant隔离。

迁移 `0019_tenant_credential_physical_revocation.sql` 只安装独立credential job、immutable aggregate receipt、write-once cutover及其guards；不materialize历史`0018` admission、不claim、不删除credential/content、不激活cutover。固定`0018 → 0019`真实MySQL夹具覆盖旧admission/fence/audit/user queue保留、完整升级、partial-DDL/marker-loss replay、append-only guard、合法receipt重放与冲突形状fail-fast。`pnpm test:tenant-credential-physical-revocation-mysql`是独立named no-skip真实InnoDB门禁，还覆盖generation-0 orphan completion、active首job缺失/不匹配、immutable T1 source损坏、live lifecycle拒权及terminal proof跨`erased`/projection清理继续可用。

迁移 `0020_tenant_runtime_revocation.sql` 也是expand-only且execution-dormant：新增T3b runtime job、按configured target不可变receipt与aggregate receipt，只保存domain-separated target/runner/boot hash，不保存原始URL或身份标签。migration不扫描terminal T3a、不回填job、不清cache或中止I/O、不改lifecycle或content。固定`0019 → 0020`真实MySQL夹具覆盖历史T3a/T1证据保留、完整升级、首表auto-commit后无marker重放、append-only guards、合法terminal证据重放及冲突/超量target形状fail-fast。`pnpm test:tenant-runtime-revocation-mysql`是named no-skip真实InnoDB门禁，覆盖proof-checked materialize、DB-time claim/lease/ABA、完整target set与aggregate/job同事务、故障回滚、response-loss replay、tenant隔离与冲突阻断。该marker只证明`0020` schema/guards已安装，不表示T3a/T3b任一gate开启或任何tenant已处理。

迁移 `0021_tenant_content_inventory.sql` 同样expand-only且destructive-dormant：新增独立T3c job、append-only per-session结构receipt和tenant aggregate receipt；不扫描或回填terminal T3b、不读取/复制正文、不匿名化usage、不删除session/Blob/receipt/Redis数据，也不把公开status推进为completed。它严格fingerprint engine/collation/no-partition、列顺序/类型/default/charset/extra/generation、ENFORCED CHECK、完整index shape和精确trigger set，并保存/恢复session `group_concat_max_len`；queued未claim要求availability不早于updated，claimed要求lease不早于updated。固定`0020 → 0021`真实MySQL夹具覆盖T1/T3a/T3b历史证据与业务内容逐字节保留、完整升级、partial-DDL/marker-loss重放、append-only guards、错误prefix index/engine/CHECK/额外敏感列或trigger等冲突schema fail-fast。`pnpm test:tenant-content-inventory-mysql`是named no-skip真实InnoDB门禁，覆盖DB-time high-water/rollback、显式RR并发防phantom、canonical compaction/approval关系、topology drift、canonical hold/global orphan、阻塞INSERT跨lease全事务回滚、ABA和跨tenant隔离。

迁移 `0022_tenant_purge_plan.sql` 继续expand-only且execution-dormant：新增独立T3d job、严格固定33域的append-only entry和tenant aggregate receipt；不扫描或回填terminal T3c、不调用本地/云adapter、不删除/匿名化/撤销任何数据，也不把公开status推进为completed。它严格fingerprint engine/collation/no-partition、精确列/CHECK/index/trigger形状，并通过永久guards把receipt固定为`plan_complete=TRUE`、`execution_ready=FALSE`、`content_purge_executed=FALSE`。固定`0021 → 0022`真实MySQL夹具覆盖旧证据与业务数据保持、无隐式plan、首表DDL中断/marker-loss重放、append-only guards和不兼容schema fail-fast。`pnpm test:tenant-purge-plan-mysql`是named no-skip真实InnoDB门禁，覆盖固定catalog、blocker、source/hold、owner closure、full-range lock、claim/ABA、回滚、exact replay和隔离。

迁移 `0023_tenant_purge_execution_ack.sql` 继续expand-only并保持runtime gate默认关闭：新增execution job、33域执行投影、append-only domain ACK、local cutover/physical ACK receipt与write-once cutover；migration不materialize历史plan、不运行worker、不匿名化usage、不撤销export、不创建delete outbox或physical ACK。固定`0022 → 0023`真实MySQL夹具证明历史plan/业务证据保持、无隐式执行，并覆盖partial-DDL、marker-loss replay、append-only/固定false guards和严格schema fingerprint。`pnpm test:tenant-purge-execution-mysql`是独立named no-skip真实InnoDB门禁，覆盖原子cutover、exact outbox关联、cleanup completion/dead-letter、physical seal、claim/lease/response-loss、回滚和tenant隔离。`0023`的marker继续作为完整历史链的必经步骤；marker只证明schema/guards已安装，不表示worker/gate开启或任何tenant发生处理。

迁移 `0024_tenant_database_purge.sql` 安装T3f独立job、11域pre-delete entry/receipt、append-only domain ACK、terminal receipt、全局session grave与write-once cutover；不回填job、不执行删除、不启用worker/gate或推进公开completion。固定`0023 → 0024`真实MySQL夹具覆盖历史T3e/业务证据保持、无隐式处置、DDL auto-commit断点收敛、marker-loss replay、弱trigger修复/未知trigger拒绝、错误index/列/CHECK拒绝及grave禁止session ID复用。Memory/MySQL两个named no-skip套件分别证明staged atomicity与真实InnoDB事务、锁、回滚、response-loss replay和tenant隔离。

迁移 `0025_tenant_redis_purge.sql` 安装T3g独立job、per-session target、target ACK、三个domain ACK、terminal receipt与write-once cutover；不materialize历史T3f receipt、不连接或修改Redis、不写marker、不启用worker/gate或推进公开completion。固定`0024 → 0025`真实MySQL套件用全链hash固定的独立frozen schema证明历史业务行保持、无隐式job/mutation、DDL auto-commit断点收敛、marker-loss replay、append-only guards及不兼容schema拒绝；另用不依赖live旧迁移或当前writer的静态hash固定pre-0025 T3f evidence，逐字段证明全部七张T3f证据表升级后不变，并验证只有显式runtime materializer才会创建T3g job/target。Memory contract、真实MySQL、真实Redis Lua和cluster rollout均有独立named no-skip门禁。

迁移 `0026_credential_lifecycle_inventory.sql` 安装inactive tracking singleton、每tenant coverage/gap、永久provider slot与tenant-auth CAS投影、immutable credential version、固定双target disposition和T3a inventory sidecar；migration不扫描credential value、不生成locator、不激活tracking或T3a，也不改写历史T3a receipt。受信任服务端的新provider写路径可另行把content-free identity保护为`executable_ref`，secret/header/URL/明文locator仍不入账。固定`0025 → 0026`真实MySQL夹具从预置历史库验证旧业务/credential/T3a证据保持、无隐式subject/version/inventory、partial-DDL与marker-loss重放、三重永久guard、严格schema fingerprint和冲突schema阻断。Memory与真实MySQL named套件另覆盖cutover/writer锁序、source-generation CAS、delete/recreate ABA、时钟回退、source/material/target tamper fail-closed、T3a inventory同事务回滚及terminal replay。

迁移`0027_blob_storage_control.sql`安装default-dormant singleton、snapshot完整namespace pin和三代等价写guard；migration不选择backend、不搬bytes、不创建/删除对象，也不自动激活control。generation 1 activation在一个Memory原子边界或MySQL事务内锁定并核对全部live Blob/export manifest、未释放snapshot pin及所有未完成delete intent；dead-letter不等于physical completion，仍会阻断异backend cutover。固定`0026 → 0027`真实MySQL夹具证明0026业务/Blob/export状态保留、marker-loss/首DDL auto-commit收敛、冲突legacy manifest/pin/dead-letter阻断和弱同名schema fail-fast；Memory/MySQL named套件另覆盖并发activation、response-loss精确重读、后置失败回滚和active guard。该marker只证明dormant schema/guards安装，不表示generation 1已激活、bytes已迁移或bucket/IAM已通过生产验收。

迁移`0028_blob_storage_migration.sql`安装default-dormant offline mover control、sealed inventory、object/source-target cleanup ACK、append-only event/receipt及runtime写冻结guards；migration本身不冻结、枚举、复制、重写pointer、清理source或激活`0027`。固定`0027 → 0028`真实MySQL夹具验证旧业务/Blob/export/control逐字段保持、完整升级、首/中/末DDL auto-commit断点、marker-loss与owned trigger修复、不兼容schema/额外trigger拒绝、runtime freeze不可由connection variable绕过、activation/freeze只一方胜出、aborted namespace永久fence、cutover故障全回滚及exact ACK/cleanup。另有真实MySQL+MinIO named no-skip套件覆盖空库与data/tombstone/staging搬迁、legacy raw+sidecar、ordinary staging resume、带非空MIME的pending export delete、target丢失、abort只fence本attempt owner、exclusive operator/status reader、named-lock连接中断的in-flight mutation fence和对象上限。

迁移`0029_tenant_credential_target_execution.sql`安装default-dormant external target job/target/ACK/receipt/cutover；migration不materialize T3a、不解密reference、不调用provider、不启用worker/gate，也不把KMS变成可执行。固定`0028 → 0029`真实MySQL夹具从预置历史库验证业务、credential inventory、Blob control/mover状态保持、默认零job/ACK/receipt、partial-DDL与marker-loss重放、append-only guards和冲突schema fail-fast。`pnpm test:tenant-credential-target-execution-mysql`另以真实InnoDB证明source-bound materialize、claim/lease、exact ACK、terminal publication、response-loss replay、并发与SQL故障全回滚。

迁移`0030_tenant_restore_journal.sql`安装default-dormant journal control/target、T1 publication job/target/ACK、runtime control/head/event以及restore run/sealed target/permanent fence/receipt；migration不选择或访问S3、不激活journal/runtime、不materialize历史T1、不生成backup digest、不重放fence，也不推进任何T3a/completion。固定`0029 → 0030`真实MySQL夹具从预置历史库证明业务、credential target execution、Blob control/mover与全部lifecycle证据逐字段保持，默认零publication/replay动作，并覆盖partial-DDL、marker-loss收敛、append-only guards和冲突schema fail-fast。Memory/真实InnoDB named no-skip套件另证明原子T1 publication建立、claim/lease、ACK、runtime lineage、恢复fence/seal/activation、response-loss、并发与回滚；真实MinIO套件证明外部create-only chain/seal/replay。marker只证明dormant schema/guards已安装，不表示journal primary activation、外部publication、backup或restore已发生；verify-only runtime还会在marker存在时校验精确schema/trigger fingerprint，marker本身不能替代该检查。

迁移`0031_authoritative_backup_catalog.sql`安装default-dormant catalog control、完整external-event mirror、snapshot anchor、recoverable entry、restore source binding、runtime reservation和eviction账本；migration不访问S3、不创建或删除backup、不激活control、不选择restore source/epoch，也不推进erasure completion。固定`0030 → 0031`真实MySQL夹具从预置0030历史库证明业务、journal/runtime/restore、credential、Blob与lifecycle证据保持，默认零mirror/anchor/entry/binding/reservation/eviction，并覆盖partial-DDL、marker-loss、append-only/permanent guards、active control下旧writer unbound-run阻断和冲突schema fail-fast。Memory/真实InnoDB named套件证明source-catalog-head-bound anchor/publish、source binding/reservation+0030 prepare、mirror-first availability/eviction、受terminal 0030 run约束的resolution、retention、exact replay、并发与回滚；真实MinIO套件证明create-only immutable event sequence/hash chain、`If-Match` CAS authority head、LIST不判head、event/head response-loss恢复及fork/corruption拒绝。独立真实MySQL+MinIO CLI夹具使用随机数据库/prefix，证明缺local anchor时仍完整验证/镜像后继event，并证明包含selected anchor的快照可按同一reservation重建本地authority；它不证明任意含anchor snapshot的物理内容正确。marker仍只证明dormant schema/guards安装，不表示catalog已激活、任何物理backup已创建/验证、restore/eviction已执行或operator evidence真实。

迁移`0032_tenant_telemetry_lifecycle.sql`安装default-dormant、expand-only的telemetry control、固定`logs`/`traces`双target、per-tenant coverage/gap与T1-bound subject evidence；migration不激活control、不扫描/回填历史tenant或遥测、不生成subject ref、不配置或连接sink、不materialize删除任务，也不写delete ACK、restore或completion。固定`0031 → 0032`真实MySQL夹具从预置0031历史库证明既有tenant/admission/catalog证据保持、control精确停在generation `0`且details为空，并覆盖首/中/末DDL auto-commit重放、marker-loss trigger修复、append-only guards和冲突schema fail-fast。`pnpm test:tenant-telemetry-lifecycle`另验证0032/0033的content-free target/coverage/subject evidence、activation identity、artifact inventory及tenant owner绑定。0032 marker只证明schema/guards已安装；safe structured process logs与W3C trace传播也不等于sink、retention、删除或全域completion已完成。

迁移`0033_tenant_telemetry_activation_inventory.sql`新增write-once activation receipt与immutable artifact inventory，仍保持default dormant；migration不激活control、不生成或读取protected ref key、不回填coverage/artifact、不联网、不配置sink，也不执行删除、ACK、restore或completion。Memory/MySQL显式store把精确32-byte key identity、固定双target、全部canonical legacy coverage、receipt和control推进置于一个原子边界；激活后新tenant必须与complete coverage同事务创建，artifact exact replay重新绑定target、coverage、owner、policy/hold/restore与source evidence。固定`0032 → 0033`真实MySQL夹具覆盖旧证据保持、两张表DDL中断/marker-loss、严格schema/trigger fingerprint和default dormancy；命名Memory/MySQL套件覆盖serialization/SQL rollback、并发、启动审计与隔离。

迁移`0034_tenant_telemetry_durable_writer.sql`安装default-dormant的writer job、短期payload、write-once external-mutation-start reservation与immutable ACK；migration不激活control、不回填payload、不创建job/reservation、不联网、不配置或调用sink，也不执行delete、restore或completion。Memory/MySQL store在任何clone/serialization前要求live enqueue的原始record由`createStructuredTelemetry`实际生成且冻结、producer key匹配active lifecycle key；每条record必须带exact tenant ref，user/session还必须同时带exact owner ref，且不得夹带其它tenant/user/session ref。持久化后的read/claim/adapter则以闭合schema与hash验证完整性，不把格式匹配冒充来源证明。store保证payload-before-sink，claim按`adapterProtocol`过滤；首次external create前原子重验T1、user/session、policy/hold/restore/source并提交reservation，此后只允许exact operation replay，terminal ACK绑定reservation并与0033 inventory、written job及payload清理原子发布。`createWrite`发出后的任何异常都先续租并exact inspect，remote exact即收口；worker logger异常不能改变持久化状态机。公网router还会忽略caller trace identity并为每个request建立fresh internal root；runner作为内部服务继续严格的internal trace关联。Memory adapter仅是非生产fixture；HTTP adapter要求显式`expectedTargets` allowlist与双向target binding。`telemetry-s3-object-v1`另提供create-only、闭合checksum envelope、有界read-after-write和bucket capability preflight；它只扩展现有writer adapter，不修改0034 schema。migration另安装credential-job `BEFORE INSERT` guard，current writer改为subject-before-job；stale 0033 writer整笔T1回滚。guard通过仓库迁移器支持的scoped bootstrap exact verify-or-create安全轮换，drop-primary后崩溃重放仍保留一道fence；独立migration Job必须复用该语义。固定`0033 → 0034`历史夹具覆盖冻结历史、默认空spool、DDL断点/marker-loss、不完整projection阻断、active gap普通启动拒绝、专用DDL-free reconcile的ACK/key/全回滚/exact replay、in-flight/stale/current writer并发及严格组合schema/trigger guard。`0035_tenant_telemetry_application_capture.sql`另安装分域application control/receipt/coverage/write binding；固定`0034 → 0035`真实MySQL夹具覆盖旧ledger保持、default dormancy、legacy unbound、冲突、DDL断点/marker-loss和严格fingerprint。

CI runner image现检查至`0057_tenant_telemetry_capture_epoch_cutover.sql`的完整历史marker链，其中0054 retained source、0055 capture checkpoint、0056 restore history和0057 epoch cutover各要求精确COUNT=1；marker只证明schema/guards/证据列存在，不代表capture激活、恢复成功、处置执行或普通DELETE物理清理。0036另有独立Memory/真实MySQL suite和真实MinIO journal/同keyCAS协议夹具；0037另有独立历史迁移、grant Memory/真实MySQL hard-deny suite；0038另有固定历史迁移及0034 writer Memory/真实MySQL membership定向回归；0039另有冻结`0038→0039`真实MySQL历史迁移夹具和T3f Memory/真实MySQL closure回归；0040～0042有T3d Memory/真实MySQL source、观察目标和逐artifact目录套件及冻结旧二进制terminal升级夹具。0044有SQL-shaped `0042→0044`真实MySQL历史夹具和Memory/真实MySQL pre-grant定向套件；0049有SQL-shaped `0044→0049`真实MySQL夹具、139-trigger指纹与hard-deny guard回归；0050有预置0044经0049到0050的真实MySQL历史夹具及Memory/真实MySQL ordinary DELETE grace测试；0051另有`0050→0051`真实MySQL历史夹具与write-once/BINARY身份冻结专项。0045～0048的observer/非生产v3 fixture另有unit与真实MinIO必执行套件。外部处置、自动purge与全部completion仍拒绝；产品镜像只有router/runner两个，JavaScript入口现为六个（runner五、router一），新增telemetry-capture仅是一次性本地operator。

grave中的`ownerSha256`是与删除同一事务从live session捕获、由`0024` append-only guard和运行时最小权限保护的opaque ownership claim；T3c session receipt不含`userId`，因此它不是可脱离外部owner tuple独立重算的上游证明。全局session ID防复用依赖grave的`session_id`/PRIMARY KEY和`BEFORE INSERT`阻断，不依赖对`ownerSha256`的独立反推；legacy/purge-target路径仍会使用保留的`userId`重算并比对。

T3d owner closure还会复验Memory的export/user-erasure/tenant-admission request↔idempotency双向索引，以及Memory/MySQL legacy compensation deterministic `jobId`↔精确session owner/tombstone generation/time。MySQL还重算`candidateSha256`并校验`sourceLastSeq`；`erasure_claim`精确绑定request/generation，status精确对应单个audit/result，completed event seq等于`session.lastSeq`且success evidence完整；损坏不会产生partial plan/aggregate。全局orphan/cross-owner损坏会使claim终结为`blocked`，底层数据修复后不会自动resume/rebuild，所以需后续operator repair/resume协议，不得手工改job/evidence。

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

当前 DELETE 会原子提交 terminal `session/deleted`、单调 generation、`session.tombstoned` 与 `session.purge` 两条 durable intent；后者的 `available_at_ms` 保持 `NULL`。每个 runner 都启动 dispatcher，通过 claim lease/CAS、续租和有上限退避只投递前者；短暂存储/总线故障会持续重试，确定损坏的 envelope/event identity 才进入 dead-letter。语义是 at-least-once，重复发布用相同 event `seq`，订阅路径据此去重。dispatcher 不新增独立服务或镜像，也不会领取 purge。generation `0` 补偿现在会生成相同形状的 generation `1` terminal proof和两条 intent，但仍不会激活或执行 purge；物理 purge和 dead-letter 的管理端修复/重放/指标/告警尚未实现，terminal event 已投递不代表数据已清理。

Blob cleanup 使用独立专用 outbox。普通staging sweeper只为超过TTL仍未绑定的`staging`对象调度删除；T3e则可在受限cutover事务中把sealed tenant plan精确命中的staging/ready manifest标为`delete_pending`并写同一类exact outbox。worker claim 后重新核对canonical `blobId → storageKey`、manifest/backend/format/generation，物理delete成功后才把manifest标为`deleted`；T3e还必须等同一outbox identity实际completed后才能追加physical ACK。filesystem adapter以key-scoped小型cancellation fence阻止迟到writer复活；S3 adapter把永久tombstone写在数据对象的同一key上，并在ACK前强读回验exact tombstone。短暂后端错误、当前进程backend/namespace不匹配都持续重试而不被误判为poison；只有确定性identity/format损坏才可dead-letter，且所有未完成意图（包括dead-letter）都会阻断不兼容`0027`activation。两类永久marker均尚无GC。该worker/T3e不能替代普通session/user purge或完整全域tenant completion。
