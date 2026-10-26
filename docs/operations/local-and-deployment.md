# 运行、配置与受控维护契约

新建环境先按 [schema/身份初始化](schema-bootstrap.md) 完成独立预置；单 Linux 双角色部署按 [production 手册](initial-production.md)。本文集中说明角色配置、发布验真、启用前提和受控维护，不代替目标环境验收。

通用部署包 `61c3a58` 已完成具名本地/CI 验收；实际生产验收待资源。正式本地 A 继续使用其已接受版本，B 不会自动加载到 A。当前版本与证据唯一入口为 [PROGRESS](../PROGRESS.md)。完整 M1/M3/M4/P2 未完成。

既有安全门禁保持：0037真实grant签发硬拒、0054 destructive仅original primary、旧CP/receipt/descriptor不重签、unknown不提升、外部disposition与自动内容purge关闭、全域completion=false。停writer、独立验真和严格指纹是操作前提，default-off不能掩盖普通路径正确性问题。

## M4 独立迁移与 runtime 权限

<a id="m4-独立迁移与-runtime-权限开发中不是部署步骤"></a>

普通 MySQL runner 只接受零 argv 并硬 verify，不执行 DDL、安装 metadata、建库/建账号或授权。`main.js schema migrate|verify|install-metadata` 和 `authority preflight|activate` 是严格 one-shot 模式，复用 runner 发布入口，不启动 Redis/provider/HTTP/worker。

新环境的顺序为：人工新建 app → 全 writer 实际停服排空 → 独立 migrate → 人工 metadata/locked definer/runtime 逐表 ACL → install-metadata → 人工 exact procedure EXECUTE → operator verify → 0066 固定初始 command preflight/activate 与同 command 实际确认 → 受限 runtime 冷启。已有 binding 或恢复环境按实际后继协议，不能重做 initial/adopt。完整 SQL、权限与确认步骤见 [bootstrap §3–6](schema-bootstrap.md#3-人工新建-app--停服-ack--migrate)。

schema 使用独立 `SCHEMA_MYSQL_URL`，不回退 `MYSQL_URL`；migrate/install-metadata 要求 `SCHEMA_FLEET_STOPPED_ACK=all-application-writers-stopped-v1`。默认/最高 operation timeout 均 120000ms，named-lock 等待另受 0–60秒及总预算限制。到期中止连接后仍等真实关闭，DDL/DML 可能已提交，取消不等于回滚，不自动重试。

runtime 必须提供 `MYSQL_URL` 与 `MYSQL_SCHEMA_METADATA_SCHEMA`、`MYSQL_SCHEMA_METADATA_DEFINER_USER`、`MYSQL_SCHEMA_METADATA_DEFINER_HOST`。metadata 桥只用于 verify，完整核对固定无参 definer procedure、真实 app 库、正文/属性、marker、表及 trigger 根；schema verify 不能代替普通启动的 key/owner/projection/ACL 审计。

runtime 对每个实际 BASE TABLE 逐表 SELECT/IUD，`schema_migrations` 和三张 `session_authority_*` 控制表仅 SELECT，另有 exact procedure EXECUTE、全局 SHOW_ROUTINE/USAGE。它不获得 TRIGGER、DDL、库级数据 grant、跨库/列级 grant、角色、PROXY 或 GRANT OPTION。locked definer 独立预置、ACCOUNT LOCK，须看见精确 app schema 的完整 trigger 集合；逐现表授 TRIGGER 会漏未来未知表。`partial_revokes` 对 schema 名的通配语义及64字节限制见 bootstrap，不能省略转义或放宽权限。

`SHOW_ROUTINE` 会暴露同 MySQL 实例其它 procedure/function 定义，部署必须披露接受这项全局只读范围；它不是业务库行读取权。installer 核固定 routine 与 locked 账号，不自证 definer grants 完整。首次安装 CREATE 及失败可能已提交，不 DROP/REPLACE 漂移对象。native runtime 启动观察不抵御后续特权 DBA 改权/ABA，停服窗口和权限隔离仍必需。

缺 marker、部分 DDL、未知/缺失/额外 guard 或指纹漂移一律拒绝；复用正式迁移器的 scoped guard 轮换语义，不用朴素 SQL splitter。迁移发布后不可改，保留旧证据，只能 forward-fix。operator 配置不进入长期 runner/router，也不放入 systemd ExecStartPre。源码及 VM/OCI 的具体命令均见 bootstrap。

## 完整轻池 runtime extensions：受控启用契约

runner 的 `LIFECYCLE_HOOKS_ENABLED` 与 `SUBAGENTS_ENABLED` 默认均为 `0`。lifecycle 只允许固定可信包 `audit`、`prompt-policy`、`tool-policy`、`memory-injection` 与实际 tenant/user ACL，不导入任意代码/URL/密钥；timeout 默认1500ms（100–5000），每user并发默认2（1–8）。子任务 depth/concurrent/tasks 默认3/2/8，最高8/8/64，仍受 agent 白名单、固定版本和更严预算约束。

子任务产品启用要求 MySQL、显式 Redis URL/namespace；两扩展 gate 均要求 internal token、正确 router 回连和完整 configured-fleet 新鲜 nonce 证明。router 只接两个 enable flag，不接其它 `LIFECYCLE_HOOKS_*`/`SUBAGENTS_*` 参数；所有 runner 的能力、gate 与配置 digest 必须一致，缺实例/旧版本/漂移均拒绝，不能只取 healthy subset。

受管 child 只能由实际 owner 通过 root/task 寻址控制，不能直接普通 start/steer/approval/tool-result/interrupt/DELETE。terminal child 逻辑 DELETE 另需 tombstone gate，保留30天来源/宽限；不因开启 SUBAGENTS 获得物理删除权。新 footprint 尚未覆盖的生命周期仍阻断，旧 receipt 不重签、unknown 不提升、completion=false。详细合同见 [子任务](../design/02-subagents.md)、[hooks](../design/08-tool-hooks.md)；专项学习见 [开发指南](development-and-ci-guide.md#5-按功能学习与验证)。

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

验真复用`scripts/lib/vm-release.mjs`的`verifyVmReleaseDirectory(directory, role, trustedManifestSha256)`，摘要从独立可信构建/晋级渠道取得，不能把包内自算摘要当认证。同一目录、manifest和完整依赖闭包应保持不变后再晋级，目标环境不运行pnpm或重新构建。目录清单本身不是归档签名、跨平台确定性构建或生产许可；`productionAccepted=false`固定。受限 tar、独立工具及签名能力已有具名本地/CI验收；Linux实际启动和下载字节证明见PROGRESS。registry/promotion自动化及目标环境仍须另验。

### 受限 tar 与独立工具

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

同目录的`transport-proof.json`只是证据副本，**不能自行认证**工具或归档；攻击者同时替换sidecar、manifest和payload时，自算摘要仍没有可信来源。必须先信任构建渠道并人工/后续发布系统比较预期tool摘要，不能先执行未知工具让它验证自己。工具只用Node内置模块，无源码checkout、pnpm、网络、`.env`或数据库依赖；没有服务安装、DDL、current指针切换或应用启动权限。独立工具源码、root package/lock与release冻结input清单必须逐字节匹配；编译器版本与实际入口也须匹配。构建不继承应用秘密，工具观察摘要不构成完整冻结toolchain、vendor认证、恶意same-UID防护或可复现构建证明。归档120秒deadline是共用计时的协作式检查，native文件系统I/O不能被它硬取消；成功副本也不是断电持久性或原子生产晋级证明。

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

这是offline脚本能力，不增加六个应用dist入口、两个常驻服务或两个OCI镜像。签名不证明freshness、撤销、密钥管理/生产信任根、OCI签名、自动promotion、生产验收或任意重放防护；caller选择的精确commit只是选定release约束。sign/inspect/unpack各有协作式120秒operation预算，消费工具自hash另有独立预算；native文件系统I/O不能被硬取消，受控parent/可信本机及非恶意same-UID仍是前提。

systemd模板仅提供Linux非root样例：手工核对专用账号、Node24绝对路径、只读release/current布局和独立`/var/lib/agent-service/<role>`状态目录；配置从独立`/etc/agent-service/<role>.env`提供，建议0600，仅配置权限与职责匹配的变量。模板设置`StateDirectoryMode=0700`、`UMask=0077`和runner外置Blob目录；不会创建账号、安装unit、改当前release指针、执行DDL或启动真实服务。普通MySQL runner现已只接受零argv并硬verify schema/runtime权限，不再自动migration；须先按[独立预置合同](schema-bootstrap.md)完成迁移、只读metadata procedure与最小权限账号，不向长期服务分发operator配置，也不在ExecStartPre偷偷执行DDL。该能力已有本地/CI发布验收，真实生产部署仍待环境验收；schema cutover后的回滚须服从forward-fix，不能仅替换旧目录。



## 本地生命周期

使用 Node24 与 packageManager 固定的 pnpm。首次初始化只走 [人工预置](schema-bootstrap.md)，普通 start/restart 不补 DDL 或授权。`--external-infra run` 消费显式角色 JSON，运行与退出合同见 [bootstrap §7](schema-bootstrap.md#7-显式-external-infra-前台运行)，不管理外部基础设施；传统 local-service 入口的 `stop` 只停应用，`down` 还停其拥有的基础设施。状态和日志在私有 `.local-run`，不提交。

停止必须等待实际 HTTP/SSE、Host、worker、外部 I/O 和连接结清。默认 wrapper 的停止超时保留现场，不擅自 SIGKILL；systemd 最后超时强杀也不能算正常 drain。不凭旧 PID、临时目录名或一次 ready 响应认领/清理资源。

后继启动保持同一 DB、master、Redis DB/prefix/namespace 和稳定 Blob 路径，移除 first-admin pair 并使用新 state。`ADMIN_BOOTSTRAP_OUTPUT_FILE` 是 create-only `0600`单行 key 文件，不是 JSON；文件先于 DB 写入，存在不证明提交，失败保留文件和 DB 现场人工核对。只有受控唯一 runner 同时接收该变量与 `ADMIN_BOOTSTRAP_TENANT`；完成后移除两者再正常启动，不交给 router 或全部常驻 runner。

### 受管 MCP 注册、OAuth 与池

`MCP_REGISTRY_ENABLED` 在两 role 默认0，独立于旧匿名 `mcpServers` mount；agent 使用 `mcpRegistrations:[{scope,name}]`。runner 要求 MySQL、显式 Redis namespace、独立 raw32-byte credential key file/key-id、固定 HTTPS `/v1/mcp/oauth/callback`、internal token 和 router 回连；router 只接相同公开身份/flag，不接 key file、pool 参数或 MySQL。平台 `MCP_REGISTRY_OPERATOR_TOKEN` 只在 router 终止，不能复用其它 bearer。

credential 文件须当前 UID、owner-only、单 hardlink、无 symlink 的 regular file；不是 telemetry/artifact/master key。callback 不从 Host 头推导，不带 credentials/query/fragment。全 configured runner 的真实 key/key-id、callback、SQL/Redis authority 与 namespace 必须一致；namespace digest 不证明物理 Redis 相同。pool TTL/max entries 默认60000ms/128，MCP timeout 默认15000ms，每user并发默认2。

user 注册本人管理、tenant 注册同 tenant admin、platform 独立 operator；共享注册不共享 OAuth state/PKCE/access/refresh。支持 no-auth、预注册 OAuth 及受限自动 AS DCR，协议 pin `2026-07-28` 或 `2025-11-25`；公共进度与2025 stateful已有验收范围。DCR只接受闭合 public/basic client profile，不把代码存在等同于真实远端 AS 兼容。SID/GET不迁移，所有工具仍强制审批，已派发 outcome-unknown 不自动重试；disable/disconnect不等于远端 revoke或备份清除。详细范围和限制见 [MCP](../design/06-mcp.md)。

升级须关闭相关gate、全旧writer/事务停服排空、独立迁移、按实际marker核完整根并更新runtime逐表ACL，再统一新版本冷启；不使用历史某一迁移的固定trigger数量作当前根。新域footprint阻断未覆盖的生命周期，旧receipt/unknown/0037/0054/completion=false保持。

<a id="受管-skills-的隔离启用边界候选验收后使用"></a>

### 受管 skills 的隔离启用边界（验收后使用）

静态 mount 的 `SKILLS_ENABLED` 与受管 `SKILL_REGISTRY_ENABLED` 分开，后者两 role 默认0。只接不超过64KiB UTF-8单一 `SKILL.md`，不执行脚本或抓取引用。平台token只交router；user-own按实际owner授权，tenant管理需同tenant admin。`registry:<name>`最多8个，按user > tenant > platform解析；override只pin已挂载且授权版本，steer不能替换。

filesystem仅本地单runner，明确私有目录、`BLOB_FILESYSTEM_SINGLE_RUNNER=1`和namespace，router恰一个configured地址；production拒绝。多runner须已受控共享S3，完整configured-fleet fresh能力和storage identity一致，不因healthy子集可用而降级。DELETE要求永久revision与幂等key，只逻辑撤销；历史/已admit stage仍计配额，物理包purge、namespace搬迁及backup/restore覆盖未完成。完整合同见 [skills](../design/07-skills.md)。

### 受保护的 L0 runtime metrics

router与runner在各自现有端口分别提供`GET`/`HEAD /metrics`，不新增进程或端口，默认`METRICS_ENABLED=0`并返回`404`。要手动体验，先在本机受保护的`.env`中为`METRICS_BEARER_TOKEN`配置独立于业务/internal/admin凭据的32～256位ASCII token，再设置`METRICS_ENABLED=1`并重启本地服务；不要在终端命令、日志、工单或文档中打印真实token。`local-service`共用一份`.env`，两role可用同一运维token；独立部署时可按role分别配置，不要求两role必然不同。token预置但开关仍为`0`时，指标不可读，但该凭据在其它路径仍受防转发拒绝保护。

scrape只接受`Authorization: Bearer <token>`（scheme大小写不敏感、单个ASCII空格、token大小写敏感），不能用query或`X-Internal`代替。开启后缺失/错误凭据为`401`，已授权的非`GET`/`HEAD`为`405`；响应`Cache-Control: no-store`，`HEAD`不返回指标正文。可由操作者在受控渠道准备权限`0600`的curl配置文件，其中`header = "Authorization: Bearer <replace-privately>"`只作格式占位，真实值仅写入该文件、不得回显；然后分别检查：

```bash
curl --config /absolute/protected-metrics-curl.conf -i http://127.0.0.1:8080/metrics
curl --config /absolute/protected-metrics-curl.conf -I http://127.0.0.1:8787/metrics
```

指标只有进程内的闭合低基数HTTP/进程量，重启后计数清零；header-ready时延和in-progress handler不是SSE流寿命或active turn。此开关不启用0054/0037、外部对象删除或任何自动清理gate，也不证明生产网络/TLS、独立采集授权、容量、collector/dashboard/SLO/告警已经验收。

监控部署与规则校验见 [基础监控](../../deploy/production/monitoring.md)。应用指标已实现；实际采集、规则触发、通知和值守须在目标环境验收。

## 模块边界

- router是公开API与fleet门禁，不持业务DB、provider/master、原始journal/catalog或operator权限；`RUNNERS`每项对应稳定直连实例，不能用随机分流多版本的LB地址代替。
- runner承载Runtime及内嵌worker，使用唯一稳定`RUNNER_ID`与可达`RUNNER_ADDR`。ordinary session owner/fence来自MySQL0066 authority；Redis承担事件与Gateway等独立域，不能互相代证持久性。
- MySQL是业务及控制证据权威；Redis和对象存储仍需其各自持久化、配置身份与恢复验收。MinIO的多个bucket只证明协议/名称隔离。
- 四个维护CLI为mover、restore-ledger、backup-catalog、telemetry-capture；schema/authority在runner main内。one-shot不得注册daemon；VM/OCI都仍只有router/runner两个长期服务。

## 环境配置原则

本地源码进程、CI 镜像和部署镜像遵循同一套环境变量契约，不把环境地址或密钥写进构建产物。当前 local 默认运行源码进程；CI 会临时构建并启动两个 OCI 镜像，但尚未上传 registry。staging/production 就绪后，各应用才按下述目标 promotion 契约使用同一 digest。

Runner 必需配置：

- `STORE=mysql`、受限 `MYSQL_URL`、三项 `MYSQL_SCHEMA_METADATA_*`、`REDIS_URL`；schema/authority/operator权限不得进入长期进程
- `REDIS_PREFIX`：Redis session key前缀，默认`as`；T3g保留的legacy lease/fence及stream/evt/purge按session hash slot关联；它们不是当前ordinary owner/fence权威。已有T3g evidence后不能随意更改
- `REDIS_NAMESPACE_ID`：operator指定的非密钥逻辑Redis身份；启用T3g worker时必填，与prefix共同计算公开namespace digest。它必须准确、唯一地标识实际cluster/database/prefix，不能在无关namespace复用；URL故意不进入digest
- `SECRETS_MASTER_KEY`（当前应用密钥；KMS/envelope属于后续范围）
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
- `ADMIN_BOOTSTRAP_TENANT`与`ADMIN_BOOTSTRAP_OUTPUT_FILE`：first-admin只允许受控one-shot runner同时设置这两个变量；output path必须为operator预先准备目录中的绝对路径，并以create-only `wx`、`0600`、文件与父目录`fsync`写入唯一key，绝不覆盖既有文件，也不在日志中输出tenant、path或key。它与`BOOTSTRAP_API_KEY`互斥，router拒绝接收output-file变量。当前文件互斥只覆盖同一共享文件系统，不是跨VM/Pod singleton；多主机生产流程仍需跨主机bootstrap控制，不能把这两个变量注入所有常驻runner

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

### Gateway 配置

`PROVIDER_GATEWAY_ENABLED`默认0；启用须显式独占Redis namespace、internal身份和全configured runner新鲜证明。runner读取tenant/user/platform quota JSON、受保护平台key-pool文件、平台/BYOK breaker与精确provider/model fallback JSON；router只接最终非secret policy digest，不复制原始策略/密钥。平台pool存在时`API_KEY`变量必须不存在，空`API_KEY=`也冲突；breaker只能与相应pool/策略配置组合。真实policy取得及启动顺序见 [production §5.1](initial-production.md#51-用真实-runner-得到-gateway-最终-policy再启动-router)。

新provider quota只接受1–1,000,000；历史更大值按原值脱敏读取供迁移，但运行期拒绝。Gateway关闭且provider quota非空也不派发，不能自动clamp、删配置或把default-off当忽略限制。fallback只允许key-selection遇open/disabled、尚未派发且未入预算的显式候选；BYOK→平台另需tenant-admin付费opt-in。已派发、结果/费用unknown不重试。完整格式与边界见 [Gateway](../design/09-provider-gateway.md)。

## SSE 观察资源上限

以下有限配置同源传给 runner HTTP 传输与 SessionHost；具名验证范围见 [PROGRESS](../PROGRESS.md)。这些参数仅配置在 runner，显式 external-infra 的 runner JSON 也接受它们。router 继续传递流，不根据调用方自报的 tenant/user 字段建立可信配额。

| 配置 | 默认值及含义 |
|---|---|
| `SSE_MAX_CONNECTIONS` / `SSE_MAX_CONNECTIONS_PER_TENANT` | 128 / 32；同一 runner 的 GET events 与 POST streaming turn 共享，按鉴权后的 tenant 计量；仍有后台清理的连接继续占用额度。 |
| `SSE_MAX_QUEUED_EVENTS` / `SSE_MAX_QUEUED_BYTES` | 256 / 4194304；观察层和传输层各自限制待处理事件/帧，包含正在处理的一个；没有每事件追加的无界任务链。 |
| `SSE_MAX_FRAME_BYTES` | 2097152；包含 event/data/id framing 的 UTF-8 字节，超限结束观察，不截断持久数据。 |
| `SSE_MAX_REPLAY_EVENTS` / `SSE_MAX_REPLAY_BYTES` | 10000 / 33554432；初次历史、live gap 与重连 catch-up 各自的追赶 episode 上限；excluded 持久行同样计入。 |
| `SSE_REPLAY_TIMEOUT_MS` / `SSE_WRITE_STALL_MS` | 30000 / 30000；追赶 episode 与传输无消费进展的等待上限，独立于业务 turn、lease 和模型期限。 |
| `SSE_HEARTBEAT_MS` | 10000；心跳与业务事件共用一个 writer，拥塞时合并或略过，不获得持久 seq。 |

所有值为正安全整数，0不能关闭限制；两个等待值和 heartbeat 不超过原生 timer 上限2147483647ms，单帧不超过 queue 字节上限、per-tenant 不超过 global。单 runner、单 tenant 的1000并发专用压测显式把两个连接上限设为该轮所选请求总数（工具上限2000），为实际晚到的清理保留额度；保留原有并发、负载规模和对账标准。这不改变普通部署默认值，也不证明生产容量。

在 headers 发出前超过连接额度返回现有 `quota_exceeded`（429）；POST 在创建新 turn、steer 和派发模型前取得额度，既有精确幂等 key 的 JSON replay 不创建 SSE。为识别精确重放，Host 可能先取得持久 fence，并将旧 owner 遗留的子任务族记录为 interrupted/outcome_unknown；因此 429 不承诺数据库零写入，但不会创建新 turn、steer 或派发新模型。开流后的超限、慢读或取消直接结束该观察，不伪造 error/terminal/seq，也不取消已经提交的业务 turn。调用方应保存**实际解析到的最后持久 id**，查询原 turn 状态并按已有 GET events `after` / `Last-Event-ID` 合同续读；不能因断流换新 key 再派发一次。

EOF 本身不表示已追平。如果配置的 episode 小于一段连续 excluded 持久行，连接可能在没有新可见 id 时结束；调用方须停止同 cursor 的自动重连，移除该 exclude 后续读，或查询持久 session/turn 状态后决定操作。服务不会为隐藏正文伪造 cursor，也不会跳过尚未补齐的 durable seq。

该上限不是整个进程 RSS、HTTP/TLS/OS buffer、fd 或跨 fleet 公平调度的硬保证。SQL 按行分页，一个大历史行可能先被 driver 解码才被拒；合法但超过配置单帧上限的数据仍保存在 store，应通过既有 item/turn 查询检查，或由操作者评估后显式调整有限配置。`readEvents` 当前没有逐调用物理取消：断流后已发读操作和迟到退订必须真实结清才释放额度，依赖黑洞可能耗尽有限名额并拒绝新观察，不能把响应已结束称为后台 I/O 已取消。真实 LB、Redis 故障恢复、持续容量及公平性另验。

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

0053原始边界（0054 original-primary-only的有限例外见数据生命周期第13节）：本地验证需`verify`及`verify-s3`两层：前者含standalone真实MySQL、SIGKILL事务窗口与历史升级；后者显式运行backup制品和真实HTTP/stream→MySQL→MinIO bytes/ACK。它们证明本地协议，不证明云IAM/KMS、独立故障域或完整fleet规模。受保护key仅补旧backup/restore对active0033生命周期的审计兼容；active capture与旧epoch绑定，新epoch恢复没有自动rebind，仍fail closed。T3d/T3f第六来源、grant、外部删除/恢复、sealed source usage自动清理和全部completion继续硬拒。

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

真实S3协议测试使用独立的Blob/journal/catalog/telemetry/disposition bucket；同机MinIO只证明协议，不证明独立故障域。restore S3 client忽略AWS环境/shared profile的endpoint override，受控region及normalized显式endpoint或standard模式进入durable identity。自动验证入口统一见 [开发指南](development-and-ci-guide.md#6-分层验证路径)。

primary activation只能用于独立可丢弃数据库或已经完成正式变更评审的环境；0066后必须同时满足固定authority context与同command实际确认，不能只复制下方命令骨架。先应用0030，以router gate=`0`、runner worker=`0`发布新代码，配置runner-only database namespace、primary runtime epoch、journal namespace、failure-domain identity与S3 target；三个公开digest从runner capability取得后精确配置给router。确认外部head完全为空、所有pre-0030 writer均已排空，而且数据库不存在任何已经绕过journal完成的terminal T3a receipt，再停掉全部writer：

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
5. 人工审阅content-free计数、phase与外部恢复证据；确认无缺口后显式执行`activate-runtime`。该命令会再次读取外部head并要求未发生漂移，随后提交新的runtime lineage及实际0066 successor；固定authority command和同command实际确认见[bootstrap](schema-bootstrap.md#55-0066-单一-mysql-authority独立停止窗口与固定初始绑定)。`run`绝不会自动完成这一步。成功后以相同operation执行0031 `resolve-restore`投影`activated`；若在允许中止的边界停止，则先按0030规则abort，再把同一reservation精确resolve为`aborted`。两种phase都会永久烧毁epoch。
6. 更新router的三个非密钥digest，先保持execution gate=`0`启动全部新runner，让startup preflight核对DB control/runtime/external heads并确认全fleet worker-active；最后才开journal gate，之后再按各自rollout恢复T3a/T3e/T3f/T3g等破坏性gate。

恢复到不同 MySQL native UUID/数据库名的 `0066` 快照会保留旧 source 的 immutable authority binding；在独立 restore activation 与同一固定 command 的只读确认完成前，普通 runtime 连接必须拒绝。仅对此类已由 operator 独立核验物理制品/实际 import 状态的手工 `prepare-restore` forward-fix，可显式注入 `BACKUP_CATALOG_PREPARE_RESTORE_STOPPED_LOCAL_ACK=1`，并同时保留 `RESTORE_FLEET_STOPPED_ACK=1`。该 opt-in 默认不存在、仅限本地且 production 拒绝；未知/空值或其它 backup-catalog command 携带它都在 key/adapter/DB 资源之前拒绝。缺省仍走原普通受限 runtime profile，失败绝不自动切成 operator；`BACKUP_ARTIFACT_LOCAL_ONLY_ACK=1` 不能代替此授权。新分支只使用正式 stopped-source facade，核验原完整 schema/native target identity，并重用原0031 external chain/availability/anchor/source evidence、永久 reservation 与真实数据库事务；不执行 DDL、import、binding 激活、普通写入或自动重试。MYSQL_URL 在此分支显式指向已核实的现有目标 operator 端点，普通 metadata/权限参数不被转交给它。

新分支完全保留 existing stopped-source 校验：尤其 active persisted-provider capture 与 prepared/replay_sealed pending run 仍会被原 `capturePrerequisites` 拒绝，不保证所有 active-capture 场景都能用本 generic 入口重试。当前已认证 import/target-prepare crash 的非 capture 前态可用此能力完成手工重建；active-capture 的后续恢复仍须原 exact-selector maintenance 与独立 selected 命令，不能改 key、旧 source 或 pending gate 使普通 source 通过。

这是原 generic0031 的人工 physical-evidence、single-operator/fleet-stopped、DB RR 锁与 external CAS 合同，**不会重新验证 GCM 制品，也不会继承已经释放的 artifact 目录/source/target 锁**；不得据此声称五个 selected continuation 的证据已被重新验证。物理导入、目标 metadata 准备与实际 authority successor/confirm 仍须分别在既有受控 artifact/activation 的真实锁与认证窗口中完成；不修改旧 binding/receipt，不把 unknown 换成新 ID，原 snapshot/provider evidence 的独立人工核验不省略。五个 selected continuation 仍要求其各自的 held GCM、精确 target/operator 锁与全部 ACK，且本 opt-in 不能用于它们。此命令成功只到 prepared，随后 ordinary 仍不可启动，直到独立 activation/确认收口。


对于已经独立核验、完成物理 import 的本地 generic 0030/0031 目标，旧 0066 binding 仍指向 source native UUID/数据库时，可仅为单次 `status`、`replay-fences` 或 `verify` 显式提供 `RESTORE_LEDGER_REPLAY_STOPPED_LOCAL_ACK=1`，并同时提供原 `RESTORE_FLEET_STOPPED_ACK=1`。缺省仍使用原 runtime-maintenance 与受限 runtime metadata；普通 runtime admission 失败不会自动提升角色。新 flag 必须是自有、可枚举的精确字符串 `1`；其它值、其它命令、任意 `AUTHORITY_*` 输入及传入环境或实际进程的 production 均在 key、adapter、DB 资源前拒绝。`MYSQL_URL` 在这个显式分支只指向 operator 已核验的现有停止目标，普通 metadata、flags 与 namespace 不被转交；不执行迁移、DDL、权限变更、import、初始 binding、epoch activation 或 ordinary session 写入。

必须保持全部应用 writer 停服排空，且只按命令注入该 flag，不将它留给后续 activation：

```bash
RESTORE_LEDGER_REPLAY_STOPPED_LOCAL_ACK=1 RESTORE_FLEET_STOPPED_ACK=1 pnpm maintenance:restore-ledger-reconcile -- status
RESTORE_LEDGER_REPLAY_STOPPED_LOCAL_ACK=1 RESTORE_FLEET_STOPPED_ACK=1 pnpm maintenance:restore-ledger-reconcile -- replay-fences
RESTORE_LEDGER_REPLAY_STOPPED_LOCAL_ACK=1 RESTORE_FLEET_STOPPED_ACK=1 pnpm maintenance:restore-ledger-reconcile -- verify
```

该角色只经私有八方法 port 调用原 journal/runtime/run 读取、replay entry、seal/receipt 与 close，保留真实目标 identity、完整 schema/source 与原事务验真。`status` 与 `verify` 不构造 S3 client；`verify` 仍会按原协议在 DB 内 seal/核对 receipt，不能称为纯查询。`replay-fences` 继续核对原外部 chain 与 exact replay。三者共享原 CLI 120 秒 stop budget、同一 signal 和实际原 Promise/close 结清，不另开期限；隐藏 credential-provider transport 不因此获得独立句柄结清证明。它不提供 artifact held GCM、双物理锁或自动停服证明，不替代五个 selected continuation，也不使 active persisted capture 的 pending source 或跨 epoch writer gate 可用。显式 activation 仍须移除本 flag，使用原固定 `AUTHORITY_*` command 与同 command 的只读确认；确认后 ordinary 调用才改用目标新受限账号与实际 metadata。

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

手工操作前必须通过受控环境提供`BACKUP_CATALOG_ADAPTER=s3`、database/namespace/failure-domain ID、独立故障域ACK、S3 target和retention两项参数；不得在命令行、日志或工单中粘贴这些值。安全顺序是：

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

`backup-catalog`与`restore-ledger-reconcile`使用共享的受保护raw key文件接线：0033 lifecycle inactive时可不配置；active时必须提供`TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE`，source及物理恢复后的target均用完全相同的key执行verify-only startup audit，缺失、错误或receipt/coverage漂移仍fail closed，绝不绕过审计。单独提供该文件不授权active provider capture跨epoch写入，也不自动rebind旧receipt；0057已实现的单次受限流程与0058重复恢复流程分列如下。验收只看PROGRESS，不沿用旧inactive结果。

文件须为绝对路径、当前UID所有、单hard-link且owner-only的regular file，内容恰好32 raw bytes（不是64字符hex），不得是symlink或FIFO；reader以nonblocking/no-follow打开并在读取前后复核文件身份，错误输出只使用闭合类别，operator临时buffer在资源关闭后清零。此key与`BACKUP_ARTIFACT_KEY_FILE`的制品加密key独立；保留它不等于保存到数据库或制品中。应用仍使用`TENANT_TELEMETRY_REF_KEY` hex配置，direct CLI只要发现该变量存在（包括空值）即拒绝；三个foreground wrapper会清除此应用输入，保留受控file变量且不改`.env`，长期router/runner剥离operator file路径。不要回显key、文件路径、环境或数据库错误。restore-ledger 八个命令现共用原 120 秒 stop budget（两项 epoch activation 只可按显式 authority 配置收紧），取消后仍等待原操作与实际 close；这不保证隐藏 credential provider 的独立原生任务已经结清。旧 catalog metadata 命令的统一 whole-operation 生命周期仍须另行验收。

最初的producer是0052之后的code-only、受限本地切片，不是生产backup/DR；后续capture恢复依赖独立的0055～0057证据schema，0058再扩展重复恢复，不能把“CLI不自动迁移”解释成没有schema依赖。它们均扩展已有`backup-catalog.js`，不新增常驻服务、产品入口或镜像。旧`begin-backup/publish-backup`流程继续仅绑定外部operator attestation；新的`create-artifact`读取真实MySQL 8 InnoDB应用逻辑SQL，认证实际bytes后才发布catalog availability。`verify-artifact`会认证制品、当前anchor与catalog证据，也可对账content-free控制投影，不是严格只读。

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

新epoch普通runner仍须独立既有capture gate、受保护ref-key及每边界fresh fleet proof。旧pending仅完整validated-v2叶可获新attempt/token/permit；legacy/unknown不升权，旧CP/root、旧receipt与reservation descriptor不重签。0054 restored destructive仍拒。0057/0058的具名本地/CI发布验收范围见PROGRESS；发布通过不解除本节local-only和production拒绝。其它domain联合灾备及生产IAM/KMS/故障域仍未闭环，不要把本节当生产操作许可。

首次`restore-selected`成功只返回`restorePhase=prepared`、`runtimeActivated=false`、`fenceReplayComplete=false`和`requiresExplicitReplayAndActivation=true`，不会自动执行后续步骤。仅inactive capture的旧v1恢复继续使用旧operator：将其`MYSQL_URL`明确改到已导入target，保留同一run/epoch/evidence与外部target identity，明确提供新epoch的`RESTORE_JOURNAL_RUNTIME_EPOCH_ID`，再分别执行`replay-fences → verify → status`、人工审阅、显式`activate-runtime`及0031 `resolve-restore`。active capture的v2恢复只按上节五个selected命令分别授权，不得改走旧generic路径。旧restore-ledger及metadata catalog命令仍只验证已安装migration、不执行DDL。

全操作单调deadline贯穿S3、native MySQL、child和文件spool；取消会终止受控socket/child，但已发送COMMIT或S3 CAS可能已成功，不是回滚证明。pending工作settle前不提前释放operator lock；超时可能遗留未发布spool/probe/orphan，不能宣称零残留。可信本机FS、同UID、endpoint稳定性及手工fleet停写仍是前提；不覆盖物理page/PITR、任意views/routines/events、Blob/Redis联合备份恢复、tenant backup-copy erasure、云IAM/KMS、独立故障域、RPO/RTO或容量。完整本地/CI实际执行证明以PROGRESS最新节为准，M1仍未冻结。

<a id="0058-重复备份恢复候选尚未真实验收"></a>

### 0058 重复备份／恢复（仅限本地隔离）

以下有限工作流已有具名验收范围，手工学习仍仅用隔离可丢弃数据：在同一已独立迁移的schema下，primary生成backup1（checkpoint v1／`ASMYSQL2`）→fresh DB1／never-used epoch1完成上述五个selected步骤→停服后从该restore1来源生成真正的新backup2（checkpoint v2／`ASMYSQL3`）→另一fresh DB2／never-used epoch2再执行同样步骤。每次使用各自的新backup/run/epoch ID，不能把旧制品exact replay当作第二次备份，也不能复用首次导入目标。每次`restore-selected`仍只到prepared，不自动activate、resolve或切换应用。

受保护artifact路径使用独立backup-source maintenance facade，核对实际pool/server UUID/database、0030/0031与49类来源；CP2另绑定27类真实祖先投影，完整叶子由实际SQL dump携带并在导入后重验，不凭caller hash补证。新dump前后观察实际来源epoch、DB heads及外部catalog/journal完整链；source epoch来自服务端，不借用下一target的epoch配置。合法queued/reserved/written及legacy-unknown均可备份，unknown不提升；旧CP、history/cutover、P1、原reservation descriptor与对象bytes不重签。恢复后只能以新claim和精确P2续跑原operation，不能复活旧token。

source维护、exact-run恢复维护与普通runner写入三种权限分开。source prepare成功后禁止继续读/镜像该已fenced source；导入前只重新验证完整外部chain、selected availability及同一reservation，随后在target重建exact prepare。普通capture仍须独立runtime gate和fresh configured-fleet proof；operator不因维护factory而获得claim/reserve/create/ACK能力。已有制品exact replay只认证实际bytes与不可变历史，不重新seal或要求今日head未变。

0058还在实际source锁下、任何planned journal／外部reserve／import之前，将完整source migration root与认证manifest的anchor精确比较；不同即拒。`ASMYSQL1/2`旧bytes与历史读取兼容，不等于旧schema制品可import→upgrade→continuation；这条跨schema原生恢复仍缺，禁止自动DDL、重导或清空部分target。命令仍复用现有create/verify/restore与五个selected命令，没有新CLI、daemon、服务、JS入口或镜像，VM与容器交付边界仍为2/6/2。

旧指纹校准、预算授权、超时和双跳分段报告保留在 [PROGRESS](../PROGRESS.md) 及历史快照；它们不能覆盖最终 exact-SHA CI 的结果，也不改写原失败。跨schema原生import→upgrade→continuation、其它domain联合恢复、云故障域/IAM/KMS仍未完成；default-off、local-only/production拒绝、0037、0054 original-primary-only、外删与自动off/completion=false保持。

## 预发/生产资源就绪后的交付顺序

首版支持单Linux双角色，具体资源、制品信任、systemd、TLS/SSE、Gateway、Redis AOF、监控及故障处理依次见 [production手册](initial-production.md)。源健康可读的手工单次R1使用正式外部producer/importer：全writer持续停服，先source外部reserve/prepare，再物理导入，受限目标prepare/replay/verify，真实0066 successor、同command确认、冷读及resolve。详见 [R1完整顺序](initial-production.md#8-受控手工单次-r1-恢复)；不能套用上面的local-only artifact或selected接口绕过production拒绝。

以同一已验制品身份晋级，目标不重新装依赖/构建；staging/production的DB、Redis、对象存储与密钥分离。现有CI临时镜像`load:true`，不自动push registry；生产trust root、OCI签名/attestation、自动promotion、跨主机HA/自动灾备、源不可读恢复和完整P2仍未完成。多实例历史expand→activate合同不是本轮单机初始化快捷步骤；旧writer未停妥或schema/control已推进时只能forward-fix。

## 普通 DELETE 与 usage 保留

普通session DELETE按30天建立来源与post-COMMIT数据库时间floor；更长policy/hold继续生效。`purge_after_ms`仍为`NULL`，`session.purge`不可领取，DELETE不等于内容物理清理。旧/erasure/legacy来源与无完整证据的状态保持unknown，不回填或手工伪造origin/seal。

0052只提供默认关闭、production拒绝的本地operational usage retention：runner的`SESSION_USAGE_RETENTION_WORKER_ENABLED/POLL_MS/BATCH_SIZE`默认`0/30000/25`（poll最大300000，batch最大100），router独立`SESSION_USAGE_RETENTION_ENABLED=0`。每个scan/reconcile/execute均需fresh configured-fleet proof，并在原子边界复核owner、可信来源、policy、0051 seal、DB-time30天/更长期限、hold、erasure/restore fence、reconciliation和独立billing facts；每session最多10000facts，超限拒绝而不截断。只删除operational ledger，保留session内容与匿名账单。0053 sealed failed-step source不能被该worker清理，T3f桥接/旧hash及其它生命周期门禁见 [生命周期](../design/04-data-lifecycle.md)。

BYOK删除只清除本系统保存的key，厂商侧撤销由客户负责；0029唯一adapter仍是Memory-only非生产fake，标准MySQL栈不启用，KMS和真实provider执行未完成。不能将external blocker改写成远端撤销成功。

## 幂等记录、事件与 Blob 清理

为保护仍可能存在的旧writer，迁移不会批量删除旧版 runner 可能仍在使用的 legacy pending 幂等占位。新版 runner 命中 pending 时返回 `409 idempotency_conflict`，不会接管或替换该记录；否则旧 runner 的 delayed complete 可能在稍后覆写新版结果。发布时必须先排空并下线全部旧 runner，确认不存在旧进程后，再清理已过期 pending。旧版已完成 receipt 无法反推原请求，其 `request_hash` 保持 `NULL`；在该 receipt TTL 内新版会为兼容性直接重放，无法对“同 key 异请求”做 409 校验。

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

## 历史与验收来源

逐迁移实现/测试过程、旧候选数量及逐轮CI保留在 [原运维契约快照](../history/2026-10-25/docs/operations/local-and-deployment.md) 和 [PROGRESS](../PROGRESS.md)。当前能力与不变量见 [架构](../design/00-architecture.md)、[生命周期](../design/04-data-lifecycle.md)、[观测](../design/05-observability.md)。历史“当前/待验/下一步”只保留其时点身份，不替代现有版本或授权。
