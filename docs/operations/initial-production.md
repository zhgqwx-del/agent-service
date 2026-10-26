# 单台 Linux 的首个 production HTTP 部署

通用部署包 `61c3a58` 已完成 CI40211433064/attempt1 全13 job与三项独立审计；实际生产环境尚未部署，验收待资源。Linux CI已验证生产样例配置和受控Redis冷恢复，未证明目标主机的systemd托管、真实TLS、指标采集/通知或R1运行。上线须使用经独立可信渠道验真的实际SHA/制品；开发dirty VM、CI临时签名和模板本身都不能代替生产信任与目标验收。精确证据见 [PROGRESS](../PROGRESS.md)。

首版运行两个既有长期进程：runner 与 router。沿用 [runner unit](../../deploy/vm/agent-runner.service.template)、[router unit](../../deploy/vm/agent-router.service.template) 和现有 VM 工具，不新增产品入口或常驻业务服务。一个已有的 TLS 反代是主机基础设施；MySQL、Redis 和该反代均由操作者另外提供，不由本包自动安装或管理。单机没有 HA，重启时可以短暂拒绝请求；不宣称跨主机接管或灾备完成。

## 1. 最小拓扑和能力

公网可信调用方 → TLS :443 → 本机 router 127.0.0.1:8080 → 本机唯一 runner 127.0.0.1:8787；MySQL/Redis 仅 loopback 或经过明确加密及访问控制的私网，不能暴露公网。当前 env 示例固定本机基础设施，换远端资源必须另外核其 TLS/认证和网络配置，不能只换主机名。

纯文本 agent/session/turn/SSE、审批与既有内置工具可按公开 HTTP 合同使用。初始配置保持 MCP、managed skills、hooks、subagents 和生命周期附加 gate 关闭；已有 Gateway 以显式有限 RPM/并发策略开启，未完成下述真实摘要和 fleet 确认前不开放入口。Blob 附件、filesystem 写入/cleanup、导出和 telemetry filesystem writer 均关闭；production 允许这个无 Blob 写入的 profile，仍必须用真实 MySQL 和 Redis。不是把 NODE_ENV 改成 development 绕过 production 限制。已有 active telemetry/capture/restore 或非空 Blob 库不能套这个 fresh profile：启动的完整审计必须通过，原 key、receipt、source 和恢复 gate 不能删除或补造。

之后需要 production managed skills/附件，应另行准备并验收共享私有 S3、不可变 namespace/control 和正式 writer gate；需要 MCP 时还须真实 HTTPS OAuth callback、独立受保护 credential key 及对应 fleet 配置。此首版不伪造 S3、AS 或 provider quota；Gateway 复用真实 Redis admission，边缘限流不能替代它。

## 2. 验真、解包和固定目录

目标为 Linux、与归档完全相同的 CPU 架构及 Node 24。运行工具前，从独立可信交付渠道取得实际 role/commit、tool/archive/manifest 摘要；校验工具原始字节。现有 vm-release-tool 仅 pack/unpack/verify/inspect-signed/unpack-signed，没有 run、配置生成、安装、迁移或 service-enable 能力。完整参数和签名步骤复用 [VM 发布合同](local-and-deployment.md#vm-进程发布包地基)。signed 路径必须使用真实受信公钥 pin 与选定 commit，失败无 unsigned fallback；CI/local 的 ephemeral-test-only 签名不是生产签名根。

每个 role 解包至此前不存在的 /opt/agent-service/<role>/releases/<selected-commit>，保留只读 dist、production node_modules 和 release-manifest.json。先 verify 两 role/OS/CPU/commit/manifest/运输字节再选择各自 current symlink；不能覆盖原目录或在目标主机 pnpm install。新版本选择与启动是操作者显式动作，没有自动 promotion。准备固定非登录账号 agent-runner/agent-router，release 由可信 operator 控制，业务账号只能写各自 /var/lib/agent-service/<role>。原 unit 的 /usr/bin/node 必须确为 Node 24。

## 3. 先独立 schema/authority，再普通进程

严格依次完成 [schema-bootstrap](schema-bootstrap.md)：人工预置 app → 停服窗口 → 正式 schema migrate → 人工 locked definer/metadata schema/runtime 逐表最小授权 → install-metadata/人工 exact EXECUTE → operator verify → [0066 固定初始绑定](schema-bootstrap.md#55-0066-单一-mysql-authority独立停止窗口与固定初始绑定) preflight/activate 与同 command 实际确认 → 受限 runtime 冷启。authority preflight 不是自动停服证明，旧 writer 的所有 host 登录、事务和 client 都必须按正式 admission 退休；新库也须真实 inventory。 §5 schema shell退出后，须按bootstrap §5.5新开干净authority shell，重设同一已验制品的Node/main并加载独立受保护authority配置；仅真空库可使用其inactive初绑JSON，成功确认且close结清后退出该shell，不依赖前一阶段已退出的变量。

已有0066 current binding 的环境不能重新走 initial；必须按其实际版本与既有 binding/source 选择后继协议。尚未绑定但已有业务数据的旧库，初绑仍须完整核验真实 expectedSource 和所有旧 runtime 用户名的全部 host；不得照抄空库来源或 oldAccountNames=[]，更不能换新 command 掩盖未知结果。

长期 runner 只有受限 MYSQL_URL 和三项 MYSQL_SCHEMA_METADATA_*，没有 operator DSN、AUTHORITY_*、SCHEMA_*、迁移目录或 GRANT 权。router 不持 MySQL、master、provider 或 bootstrap 权。旧 active0033 的 authority 命令必须提供原 protected raw32 operator ref key；不能生成替代 key。schema/authority 命令仍是原 runner main 显式 one-shot，不注册 daemon，不放在 ExecStartPre 自动执行。生产恢复继续受原 hard-deny/既有控制门禁约束；本手册不允许自动 import、自动重试 unknown、换 command/source 或跳过 receipt 校验。

## 4. 角色配置与首次管理员

角色模板为 [runner.env.example](../../deploy/production/runner.env.example)、[router.env.example](../../deploy/production/router.env.example)。这些是 systemd EnvironmentFile 文本，不是 shell/JSON；每个 __...__ 都须在私下替换，未替换模板不是可启动配置。master 必须独立随机64hex，internal token 为两 role 同一随机32～256位允许字符；密码要正确 URL-encode。示例厂商只展示已有 deepseek/deepseek-chat preset，不是采购建议；实际厂商/精确已定价模型/权限和付费预算由操作者选择。API_KEY 仅 runner，不能照抄根 .env 或 local root DSN。

配置分别放 /etc/agent-service/agent-runner.env 与 agent-router.env，root-owned0600，并保护父目录。它们仅由 PID1 读后分发环境；不要 source、echo、放入 release/argv/公开配置。master、数据库、Redis namespace 和将来的 Blob 状态在重启之间保持稳定；RUNNER_ID 固定为该单实例 slot，不能每次换随机名字。不同 Redis 凭据必须访问同一实际 DB/prefix/namespace；实际 ACL 由基础设施管理员预置和验证。

复用原两 unit，核 User/Group、current 路径与 StateDirectory；保留原60秒 TimeoutStopSec。普通 EnvironmentFile 不含 ADMIN_BOOTSTRAP_*。首次管理员另按 [bootstrap 第6节](schema-bootstrap.md#6-受限-runtime-冷启动与唯一-first-admin) 进行：只给这次受控 runner 同时注入 ADMIN_BOOTSTRAP_TENANT 和位于其可写私有 state 目录的绝对 ADMIN_BOOTSTRAP_OUTPUT_FILE，create-only0600输出，等待真实 ready/文件证据后正常停止，私下交付 key 给可信后端，再移除这对变量后重新启动长期 runner；最后启动 router。不得使用 production 拒绝的 BOOTSTRAP_API_KEY，也不能把管理员对传给 router 或永久保留在所有实例。

service key 和 X-User-Id 的 trusted-caller 合同面向可信 operator/App 后端，不能把 service key 放网页/移动端；无需真实 App，操作者可用受保护 HTTP 客户端体验。首次接入按 [HTTP 手册](http-experience.md) 做同 SID 三轮、精确 key/body replay；202、断流或响应不明按原 turn/status/事件查询处理，unknown 不换新 key 自动重放。

### Redis 7+：此 Gateway 单 key profile 的受限 ACL

本节仅覆盖本手册的 Gateway=1、无 pool/breaker/MCP/清理 worker 配置，Redis 7+ 只是使用 ACL selectors 的语法前提；实际选用的二进制/版本/配置/ACL 组合还须完成下述目标 Linux AOF 冷恢复验收，不能由版本号推断兼容。先由 DBA 在受控窗口预置独立 operator 与业务账号；本次全新隔离验收实例的 default 行固定为 `user default reset off`，不为 AOF loader 放宽它。既有部署须先保全数据并完成停服维护，不据此重置未知账号。不把 operator 凭据交给两 role，不用 `+@all` 或全键/全 channel grant 迁就业务失败。未来启用其它域须另审其权限，不能沿用本最小集合宣称已覆盖。

先按同一已验 source 中的正式 `providerQuotaNamespaceSha256({prefix:REDIS_PREFIX,namespaceId:REDIS_NAMESPACE_ID})` 得到非秘密 namespace 摘要，并与 §5.1 实际 runner capability 的 namespaceSha256 对账，不手写摘要算法。quota 键为 `provider-quota-v1:{namespaceSha256}:<opaque-hash>:rpm|concurrency` 与 `...:cancel:<opaque-member>`，**不在** `REDIS_PREFIX:*` 内。前缀和 namespace 都必须是本部署独占身份。

下面是需私下替换的 **一行 Redis ACL file 内容**，不是 shell 命令；不要把真实 token 放入 argv、历史或输出。`__PREFIX__`、`__QUOTA_NAMESPACE_SHA256__` 必须换成上面实际值；账号与 runner.env 中的 Redis 用户一致，独立随机 token 只进入受保护 ACL 文件与 runner env。`reset` 只用于 DBA 本次新建、已核无撞名的业务账号，不能据此重置既有未知用户。

```text
user __RUNNER_REDIS_USER__ reset on >__PRIVATE_RUNTIME_TOKEN__ -@all resetkeys resetchannels +hello +auth +select +info +ping +quit +time +eval +evalsha ~__PREFIX__:stream:* ~__PREFIX__:purge:* ~provider-quota-v1:{__QUOTA_NAMESPACE_SHA256__}:* (~__PREFIX__:purge:* +exists) (~__PREFIX__:stream:* +type +xadd +pexpire +xrange) (&__PREFIX__:evt:* +publish +subscribe +unsubscribe) (~provider-quota-v1:{__QUOTA_NAMESPACE_SHA256__}:*:rpm ~provider-quota-v1:{__QUOTA_NAMESPACE_SHA256__}:*:concurrency +type +zadd +zrem +zscore +zremrangebyscore +zcard +zrange +pexpire) (~provider-quota-v1:{__QUOTA_NAMESPACE_SHA256__}:cancel:* +type +psetex)
```

根 selector 仅提供连接/只读 server identity/TIME 与 Lua 入口的 KEY 范围；实际数据命令按各 selector 分开。stream 写入/TTL 不获得 purge marker 写权；cancel 只允许 TYPE/PSETEX，不获得 zset/其它 TTL 权；业务账号不得 CONFIG/ACL/DEL/FLUSH/SHUTDOWN，也不得读写其它 namespace/key/channel。Lua 的内层命令仍受当前 Redis user ACL 检查，不能只通过 `ACL DRYRUN EVAL` 就称真实 quota 或 event bus 已可用。

本版本 router 以各 runner 的 MySQL authority observation 路由，未建立直接 Redis 数据客户端；router 的 Redis 配置仍须声明同一部署身份，不向其专属账号分发 runner 的 quota/stream/Lua 数据写权或 operator 管理权。不能用过时 Redis lease/counter 授权来替代 0066。

开放入口前，以新隔离实例复用实际 `RedisProviderQuotaCoordinator` 与 `RedisEventBus` 验证：native TIME、三个 scope 的 acquire/renew/release 与 RPM/并发拒绝、close 等实际 lease release、持久 publish/XRANGE replay、live pub/sub/unsubscribe、全部 transport close；另以 operator `ACL DRYRUN` 核正向命令和拒绝管理/越界命令，并做业务凭据的实际无害拒绝检查。不得实际试执行可能获准的 FLUSH/SHUTDOWN/DEL 来“证明拒绝”。只有 bus 的 Gateway=0 本地 ACL 不足以证明本 profile。该 ACL/真实客户端验收不调用模型，不改变生产 quota/期限。

开放入口前还须在目标 Linux 的全新隔离实例，以同一实际 binary SHA/配置/ACL/datadir 完成 AOF 冷恢复：`appendonly yes`、`appendfsync everysec`、`save ""`、禁自动 AOF rewrite 并拒绝截断加载；保持上面的 runtime ACL 原样及 default reset off。复用原 B native driver 的真实 RedisEventBus 写入3条原事件，持有原 foreground child 正常 `SHUTDOWN NOSAVE` 后实际 wait/close0 与 PGID/TCP gone，再同目录冷启。必须核原 stream ID/seq/完整事件 hash/绝对 expiry 一致、PTTL 正且递减；再写另一个 SID 的3条 future 事件并第二次正常停启，原与 future 两组都须保持同样原字节和 TTL，且每阶段普通账号管理/越界操作仍被拒绝。正常停机 AOF fsync 与完整 appendonlydir/log/原始失败证据须保留，不用新 dump.rdb、刷新 TTL、重新 seed、额外权限或自动重试掩盖回放失败。第二次冷读结束后的第三个最终 Redis 进程也须正常 NOSAVE 关闭并由原父进程实际 wait/close0、核 PGID/TCP gone；不能只结清两次 restart 的前态就声称全部资源已停。

Redis7+ selector 可用、在线 publish/XRANGE 可用和结构投影相等都不等于 AOF 数据恢复；兼容性按该确切 Linux binary/build/config/ACL 的实际冷恢复结果验收，不盲设 semver floor。B的Linux CI已用官方Redis8.4.7源码构建，执行原/后写两组三事件、两次cold与三个原child正常NOSAVE退出，逐项核ID/seq/hash/绝对expiry、正递减PTTL及原ACL拒绝。该证据只绑定当次binary/build/config/ACL；目标机器仍须执行上述实际验收，不能由版本号或本机Darwin结果替代。正常冷恢复不证明断电durability、HA/灾备或C类验收。

## 4.1. systemd 首次启动顺序

以下命令仅在目标 Linux 主机由获授权操作者执行；本机 macOS 不执行。它们不准备数据库或修改权限：先完成上节独立预置、绑定与可信制品验真，人工安装两个既有 unit 至 `/etc/systemd/system/agent-{runner,router}.service`，准备对应账号、受保护 env 与受信 `current`。不要运行会展示环境秘密的 `systemctl show -p Environment`。

```sh
systemd-analyze verify /etc/systemd/system/agent-runner.service /etc/systemd/system/agent-router.service
systemctl daemon-reload
```

首次管理员使用单独的 [first-admin.conf.example](../../deploy/production/first-admin.conf.example)：私下替换实际 tenant，把它以 root-owned0600 保存为 `/etc/systemd/system/agent-runner.service.d/first-admin.conf`，不可覆盖已有 drop-in。只给这次受控 runner 引导，入口保持关闭。

```sh
systemctl daemon-reload
systemctl start agent-runner.service
systemctl is-active agent-runner.service
curl --noproxy '*' --fail --silent --show-error --connect-timeout 2 --max-time 5 http://127.0.0.1:8787/readyz
```

只有服务 ready 和文件存在仍不够：按 bootstrap 手册通过受保护通道验证 first-admin key 真实可认证，随后真实停止该 runner。本节 key 文件由 systemd 的 `User=agent-runner` 创建；复用 schema-bootstrap 第6节的私有鉴权脚本时，须由授权 operator 显式以该 UID 执行（例如使用主机现有 `runuser -u agent-runner --` 启动该干净 `env -i`/Node 检查），并使用该 UID 拥有的私有 client-home。保留原 owned0600、UID 与 no-follow 校验，不复制/chown key 或放宽权限来绕过。确认 `MainPID=0`、unit cgroup 无残余进程、原 DB 无这个 runtime 的连接/事务；不能仅以 stop 请求返回当作排空。私下保管原 create-only key 文件和已提交事实，不打印或重新引导。

```sh
systemctl stop agent-runner.service
systemctl is-active agent-runner.service
```

最后一个命令应报告 inactive；其非零状态是预期停止状态，不应放进会误判的自动修复循环。移除**本次创建且身份已核实的唯一** `first-admin.conf`，保留其它 drop-in；去掉任何普通 env 中的管理员对，然后 `systemctl daemon-reload`。重新启动正常 runner，按下节获取真实 Gateway 摘要并完成 router 配置，再启动 router；两角色真实业务与停启验收后，才按需要 `systemctl enable agent-runner.service agent-router.service`。首次管理员 key 仅供管理；另建 runtime-scope key 给可信调用方。反代配置须先在实际主机通过 `nginx -t`，外部入口最后开放。

## 5. TLS 反代、边缘限流与指标

[nginx.conf.template](../../deploy/production/nginx.conf.template) 仅放在既有 nginx 的 http context。操作者替换真实域名、受保护证书/key路径和可信调用方固定出口 CIDR，并通过该主机原生 nginx -t；没有自动发证、DNS、iptables 或 enable 操作。当前有意仅允许 HTTPS /v1/，internal、_internal、_router、metrics 及本地 health/ready 诊断不向公网发布，反代清除实际内部认证头。原 runner/router 端口保持 loopback；防火墙仅开放已审443和必要受控运维入口。

模板保完整 /v1 URI、原 Authorization/user header，不缓存/缓冲 SSE，不拦截上游业务错误，不忽略客户端断开，也不自动重试已可能 started 的 POST。body 上限精确1000000字节；75秒是反代读空闲期限，高于10秒 SSE heartbeat，不能说成模型整项期限。访问日志关闭，不能记录 URI/id/query/header/body/key；nginx系统错误日志也须按主机权限/留存策略审阅，不宣称其内容天然与应用闭合日志相同。

5r/s、burst10、每IP32连接/该vhost64连接是待实机验证的保守边缘起值，支持429。它们仅是 IP/连接资源上界：NAT会共享，不能保证跨tenant公平，也不是 provider/model quota、token/费用硬限。此profile的 Gateway 限额为 tenant60RPM/并发2、user30RPM/并发1、platform provider60RPM/并发2；这些只是待验证起值，不是容量承诺。Redis quota 约束真实上游派发；异步turn可能先返回202再以quota错误终结，不能把所有超限都硬断言为同步HTTP429。它不是token/总金额硬限，也不能将独立 BYOK/其它厂商/其它进程费用自动归成全局现金封顶。不得填任意 policy digest；按下一节从本次已验真 runner 取得最终身份。真实费用仍需厂商侧额度/告警、应用 agent limits 和明确调用预算，任何付费 smoke 另经授权。

本部署 profile 显式设置 METRICS_ENABLED=1，并要求每个 role 的独立 METRICS_BEARER_TOKEN；产品本身的默认值仍为0。仅受控本机/私网采集 GET/HEAD /metrics，采集和告警接入见[基础监控样例](../../deploy/production/monitoring.md)，本包不安装采集daemon。L0只覆盖闭合低基数HTTP/进程量，重启清零，不代表 turn成功率、持久账本或计费；公网反代仍固定拒 /metrics。

## 5.1. 用真实 runner 得到 Gateway 最终 policy，再启动 router

无需手写摘要算法、预填任意64hex或改 external-infra 脚本。先保 TLS edge 关闭，独立完成 schema/authority 后只启动 runner。其现成 main 先 derive 最终策略；启动的 assertReady 只核本地 Redis，RouterProviderGatewayGate 构造不请求 router，模型派发才请求 fresh fleet。ERASURE_ROUTER_URL 此处只是既有私有router地址，不会开启 erasure。first-admin阶段同样不能开放业务流量。

1. 操作者先以验真 manifest/selected commit 确认当前 unit 的 Node24/ExecStart/current 目录，并核本机8787监听 PID 确为该 runner 的 MainPID。不能拿任意 localhost stub 或旧进程 capabilities 当可信来源。
2. 仅在该已验真主机运行下面已有 Node24 的只读 HTTP，校验 wire version、role、真实 quota capability 和闭合两字段 identity；仅打印非secret身份，不打印完整capabilities、env、credential或策略配置。失败停止，不填假摘要。

```sh
/usr/bin/node --input-type=module <<'NODE'
const response = await fetch("http://127.0.0.1:8787/v1/capabilities", {
  redirect: "error", signal: AbortSignal.timeout(5000),
});
if (response.status !== 200) throw new Error("runner_capability_unavailable");
const value = await response.json();
const identity = value?.features?.providerGatewayIdentity;
if (value?.protocolVersion !== "2026-10-08" || value?.service !== "agent-runner"
  || JSON.stringify(value?.features?.providerGateway) !== '["provider-gateway-quota-v1"]'
  || !identity || typeof identity !== "object" || Array.isArray(identity)
  || Object.keys(identity).sort().join(",") !== "namespaceSha256,policySha256"
  || typeof identity.namespaceSha256 !== "string" || typeof identity.policySha256 !== "string"
  || !/^[a-f0-9]{64}$/.test(identity.namespaceSha256)
  || !/^[a-f0-9]{64}$/.test(identity.policySha256)) throw new Error("runner_gateway_identity_invalid");
process.stdout.write(JSON.stringify(identity) + "\n");
NODE
```

3. 人工把该实际 policySha256 写入 router 受保护EnvironmentFile的 PROVIDER_GATEWAY_POLICY_SHA256。两role的真实Redis连接必须相同DB/prefix/namespace；router仅保存最终digest，不持三份quota JSON/厂商key/pool配置。启动 router；本例单key/无pool/fallback/byok-breaker，不是这些可选功能的默认隐式激活。以后改变策略或库存必须重新取得最终digest并在入口关闭时协调重启，旧digest不能继续复用。
4. 保持 edge 关闭，沿既有私有 HTTP 合同对本机 router POST /_internal/provider-gateway-quota-v1/ready：JSON为 {nonce:新随机64hex,identity:刚取到的完整两字段}，Content-Type为application/json，认证头为 x-agent-service-internal-token。真实token只放operator预置0600 curl-config文件中的认证header，不放argv/文档/日志；配置不含redirect、verbose或trace选项。按[HTTP手册的受保护调用基线](http-experience.md#4-用-curl-理解同一-http-合同)，以 `curl --disable --noproxy '*' --config /ABS/private/internal-auth.curl.conf` 开始调用（`--disable`必须是首参数），显式设置连接/请求等待上限，并用`--data-binary @/ABS/private/ready-request.json`、`--output`和`--dump-header`分别读取请求、保存response/header。先设`umask 077`，私有父目录为0700、请求和配置为0600，所有输出路径须尚不存在；不跟随redirect，终端只用`--write-out '%{http_code}\n'`显示状态码。必须核 HTTP200、Cache-Control:no-store、x-agent-service-provider-gateway:provider-quota-ready-v1，以及完整回执恰为相同nonce和identity；只看status或readyz不够。无ACK/503/mismatch停止，不选healthy subset或临时关gate。
5. 先用有限本地 fake provider 验证 quota 拒绝、并发与取消清理，再在明确的真实模型预算内做小额 smoke；这些关口和恢复验收完成后，才开放已审可信 caller 的 TLS edge。该准备过程不调用模型、不创建额外服务，也不产生policy自认证。

## 6. 上线前必须实证

本包尚未在目标生产主机部署。替换模板后，操作者先验证两role配置实际通过production解析且router无runner/operator权限；检查完整CI/三审计和实际Linux双VM字节。目标机再核账号、只读 release/current、EnvironmentFile/state 权限、Node24、unit 原生校验、TLS域名/证书和 nginx 原生配置检查。

在新隔离真实 MySQL/Redis 用同 main/source 或目标 VM 验证完整0066和metadata/低权冷启（缺绑定/错账号/错schema必须失败）；用 owned 本地 fake provider 做真实 HTTPS→router→runner 三轮和幂等、SSE断连/重放、401/413/边缘429与真实Gateway quota拒绝、metrics隔离，不产生付费调用。此 fake smoke 不替代真实厂商 TLS/凭据/费用验收。停止两 unit 后必须实际 join 所有 native 工作，不能只看 systemctl 请求成功；再同DB/master/namespace冷启，核原三轮 durable 内容，确保没有隐式迁移或 side effect replay。60秒 unit超时是OS最后停止边界，不是所有依赖一定在60秒完成的保证。

首个真实公网流量前，操作者须提供实际资源、可信交付/签名来源、持久化备份与独立恢复办法、受控调用方与密钥保管、TLS/网络和最小观测告警。单机可用性、云IAM/KMS、真实容量、跨故障域恢复及完整M3/M4/P2仍未由此模板验收。升级 schema 后只按原 forward-fix 协议；不能自动切旧binary或混跑旧writer。文档和示例不授权实际部署。

反代参考：[nginx proxy](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)、[limit_req](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html)。

## 7. 已有环境升级与故障处理

升级前固定新 release 的实际 commit、Linux OS/CPU 和受信摘要，解包到新目录；保留原 release、数据和独立备份，不能覆盖运行目录。先关闭业务入口并停止新请求，依次停止 router 和 runner，等待实际 HTTP/SSE、Host、外部 I/O、native 连接与 unit cgroup 结清。`TimeoutStopSec=60s` 可能由系统强杀；这种结果必须保留为失败，不能报告正常 drain。确认没有其它 writer/维护命令或自动重启渠道，才按 schema/metadata/账号退休/authority 的**实际版本合同**独立迁移；并非每次重启都重新初始化0066或轮换 epoch。

停服窗口内，operator 才能把每个受信 `current` 指向已验真的新目录；先核原指针确为由本部署管理的 symlink，使用同目录新临时链接和原子 rename，不覆盖未知目录。先冷启 runner、核当前 Gateway identity，再配置并冷启 router。用原业务 key、实际 user 和已有 session 核对持久回答/事件/usage，再做一组有限验收，最后开放入口。失败保留原/新身份、报告和数据；schema/control 已推进后只能 forward-fix，不能自动换旧 binary、删 marker、清库重建或换新幂等 key 重放未知操作。

| 故障 | 立即动作与恢复门槛 |
| --- | --- |
| 未 ready、schema/metadata/账号或0066错误 | 保持入口关闭，核实际制品、DB UUID、完整 schema/trigger、受限 ACL 和固定 binding；不由长期进程补 DDL/GRANT，不生成新 initial command 掩盖未知。 |
| 模型超时、断流或202后未知 | 保留原 session/turn/幂等 key，先查持久 turn/events/usage；只有同一 body/key 的精确重试，不自动换 key 重新派发，不把 unknown 当免费。 |
| Redis 不可达、重启或状态丢失 | 关闭入口并排空全部 runner 实际上游工作，核持久化与原 DB/prefix/namespace、quota/fleet 身份后按受控步骤重启；不 FLUSH、换 namespace 或手改计数“恢复”。MySQL0066所有权与 Redis quota/事件状态是不同域，不能因前者安全就声称后者无损恢复。 |
| MySQL 切换到不同 server_uuid 或从旧快照恢复 | 不同 UUID 会由现有0066 gate 拒绝；任何旧快照目标都须由 operator 保持入口封闭，不能假设同 UUID/同凭据的整库回滚会被库内 binding 自动识别。先完成受审的旧 primary fencing、真实备份来源/外部链与受控 successor 恢复，不 initial/adopt 重置，不默认接受云端自动 failover。 |
| 磁盘满、进程被OOM/强杀、主机重启 | 停止放量、保留原失败和数据，核宿主资源、基础设施持久化及旧工作结清，再冷启并读取原业务；不删除未核身份的目录腾空间。 |
| 备份不可读或未成功演练恢复 | 保持生产验收未完成。定时任务成功或对象存在不足以证明可恢复；核实际 bytes、独立密钥、RPO/RTO、隔离目标导入与冷启业务。 |

当前内置本地 `create-artifact`、`restore-selected` 和部分 continuation 仍有 production 硬拒绝。本包不删除这些 guard，也不通过设置 development/test 绕过。上线前的剩余关键路径是落实正式外部backup producer/importer，并在目标环境验收下节R1路线；必须覆盖旧主持续fencing、独立source/head证据、真实数据库/必要对象/keys、原事务中的0066 successor与同command确认。完整自动灾备、长期 workflow 和其它生命周期边角可后置，这条最小真实恢复关口仍不能省略。


<a id="8-受控手工单次-r1-恢复候选"></a>

## 8. 受控手工单次 R1 恢复

本节对应已在B包具名真实MySQL/S3与最终CI范围验收的受控恢复路线；目标生产恢复尚未验收。支持域是 current schema、原0030/0031协议、capture inactive 的单次手工恢复；原 source 必须仍可核读，**先在 source 真实完成 external reservation/prepare，再物理导入 target**。原 source 已不可读且灾前没有预留的丢主机路径不在本切片内。不能翻 NODE_ENV、删 guard、使用 initial/adopt 重置旧 binding，或声称所有灾难恢复均可用。

灾前先准备正式独立且私有的 S3 Blob namespace（实际 inventory 为空时才允许现成 Blob control 初次激活），完成真实 generation1；再依原固定 command/operator 及同 command 确认完成0030 primary activation，最后激活0031 catalog。当前第1节的 filesystem/Blob control0纯文本配置不能直接激活 catalog；需要恢复资格时必须在正式备份前另行完成这组 S3/primary/catalog 前置。旧已激活域、protected ref key、source/receipt 及 immutable history 原样保留。Blob、journal、catalog 的真实 TLS、私有权限、CAS、持续配置和独立故障域由操作者验收，本地不同 bucket 不证明这些事实。

全过程人工关闭入口，停止并实际 join 全部 router/runner/worker/其它 writer 和维护命令，阻断旧 primary 的所有再启动/写入渠道，并持续保持原 `RESTORE_FLEET_STOPPED_ACK=1` 与 single-operator/fencing 窗口。ACK 不自动证明 fencing；本包不增加停服、远程 kill、backup scheduler 或 importer。步骤只使用正式既有命令；DSN、密钥、原 backup/run/epoch/evidence 和 metadata 通过各次独立受保护配置注入，不放 argv/日志，不把 operator DSN交给普通服务。

1. 在 source 上用 `backup-catalog begin-backup` 建立原 anchor，外部正式 producer 生成并独立核验实际 full backup bytes、加密/密钥、snapshot/provider provenance；再 `publish-backup` 与 `list`。catalog 只绑定 producer 给出的 opaque evidence，不证明备份 bytes。恢复所需 master、ref key、对象与其它应用依赖必须安全保存在数据库故障域之外。
2. source 仍可核读时，以原受限已绑定账号运行 `backup-catalog prepare-restore`，使用固定 backup/run、从未用过的 epoch 和精确 source evidence，真实写入 external reservation。把这些原值和所有 target identity 安全保存；unknown 只核实/精确重试同一操作，不换 ID/epoch。不允许把 target 上的第一次预留冒充本步骤。
3. 外部正式 importer 将选定的完整备份恢复到独立、此前为空且 native UUID/DB 身份已核实的目标。独立核验实际 bytes 与原 anchor/evidence。schema 工具只对该目标做必要升级/严格 verify，按正式 metadata 合同准备 locked definer、exact EXECUTE 和新受限 Z；不得恢复 mysql.*、重签旧 CP/receipt/binding、激活 initial 或把 Z 提前加入旧 membership。新 Z 的完整表级权限保持原 runtime 合同，`schema_migrations`与三张`session_authority_control`、`session_authority_bindings`、`session_authority_runtime_accounts`仍SELECT-only。
4. 目标第二次0031 prepare 只为这一轮命令提供 `BACKUP_CATALOG_PREPARE_RESTORE_RUNTIME_MAINTENANCE_ACK=1` 和原 `RESTORE_FLEET_STOPPED_ACK=1`；MYSQL_URL 是目标新 Z，三项 MYSQL_SCHEMA_METADATA_* 必须精确属于该目标。运行原 `backup-catalog prepare-restore`，所有 backup/run/epoch/evidence/外部 identity 与步骤2完全相同。该profile只暴露原五项恢复元数据方法与 close，允许 production 且 force verify，复用 runtime-maintenance 的完整 schema/business/metadata/ACL 校验，不要求 Z 已获得 ordinary membership。它完整验证 sealed external chain，缺少同 backup/run/epoch 既有 reservation 则拒绝，不能在此分支首次预留。已有 terminal/冲突 reservation 仍由原 kernel/adapter 精确拒绝。
5. 移除上述新 ACK，目标 Z 与 metadata 沿既有默认 runtime-maintenance 依次运行 `restore-ledger-reconcile status`、`replay-fences`、`verify`。不要带任何 local-only ACK，verify 会提交原 sealed receipt，不能称为纯查询。原 restore CLI 整体120秒与 signal/close 合同不变；generic catalog prepare 原来没有整体120秒 timer，本包也不冒称硬实时退出。
6. 人工审阅完整恢复、source/head、fence和sealed receipt。按既有固定AUTHORITY context执行`restore-ledger-reconcile activate-runtime`，在原事务创建真正0066 successor，并核同一command的实际结果；CLI在原激活后执行`confirmSessionAuthorityBinding`，不是另调一个不存在的confirm子命令。旧runtime用户名的全部host必须退休，旧ordinary pool/业务工作持续结清；不可用只支持初绑的`authority activate`替代。等待该命令及其连接/adapter实际close后，仍保持TLS入口关闭、全部main/worker/其它writer停止。
7. 在这个停写窗口，用目标新Z与精确metadata执行**有限的普通Store冷读验收**：以`MysqlSessionStore.connect`、显式`migrationMode:"verify"`及原key配置建立新连接，只调用identity/run/reservation/session等所选读取方法，不acquire session、不执行turn或其它mutation。核真实current membership/successor、该run为active、reservation仍reserved、原T1 fence仍使受影响session不可读，并按选定备份证据核应保留的业务/usage事实。随后必须等待这个Store的`close()`及全部已接收读取真实结清。

   这一步是独立受审的有限读核验器，**不是启动runner `main.js`、关闭几个gate运行后台worker，也不是产品新增的只读启动模式**。具名B验证使用同源码[真实R1夹具](../../apps/agent-runner/test/mysql-backup-artifact.mysql-s3.test.ts)中的`openStore`→有限读取→`close`；[普通Store连接](../../packages/store/src/mysql/store.ts)保留完整schema/business/metadata/ACL与ordinary authority准入。测试fixture不是部署工具；本包没有通用业务冷读CLI。目标操作者须事先准备并审阅只调用这些既有读取方法的有限核验器及具体预期；未具备或未完成此步，就保留**R1目标验收未完成**，不能用普通服务启动掩盖缺口。现有`restore-ledger-reconcile status`只给恢复控制摘要，不代替ordinary membership和业务可见性冷读。
8. 冷读连接已关闭且全writer仍停止后，移除activation专属AUTHORITY输入，保留原backup/run/epoch/evidence、目标Z/metadata与外部identity，执行原`backup-catalog resolve-restore`。核同run的external resolution及本地reservation实际为activated，CLI及其连接/adapter全部结清；结果未知仍保留同一operation核实。只有这一步完成后，才允许普通runner/router按既有启动顺序冷启，再做原业务/usage/fleet与监控核对，最后人工开放入口。不要在resolve前为“冷读”启动任何长期服务。


该profile的opt-in缺省不存在；原 ordinary 路径失败绝不 fallback。它仅接受 prepare-restore，不能与旧 stopped-local ACK、AUTHORITY_* 或 artifact/selected 配置混用；ACK、互斥 authority 及 metadata 配置格式错误在 key、adapter、DB 前拒绝；真实 metadata identity/ACL 由受限 native connect 严格验证，失败无 fallback。真实进程为 production 时不能通过传入测试 env 降低 adapter TLS/private-domain 校验。active0053、selected checkpoint、pending/source/完整性 gate 原样保留，不传 capture local flags 绕过。

此路线使用原 generic0030/0031 的人工 provenance、DB 事务锁与 external CAS 合同。它**不重新提供 GCM 认证、不继承 importer 已释放的能力/双物理锁、不放开 production artifact 或五 selected continuation**。startup/读取在空外部 bucket 可能有原协议 genesis 行为，但没有合法既有 reservation 仍必须拒绝，不意味着该 bucket 是恢复来源。有效 external mirror 可能在后续拒绝前独立提交；CLI 失败不意味着这些合法元数据也被整体回滚。任何未知结果保留 source/target/制品和配置身份，不自动导入、删除或重试。真实 Linux/云对象存储验收、RPO/RTO 和调用预算仍须操作者资源就绪后另行完成；没有源可读/灾前预留的灾难路径、自动恢复与完整 P2 后置。
