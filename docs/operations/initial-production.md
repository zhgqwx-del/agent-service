# 单台 Linux 的首个 production HTTP 部署

本文是待验证的通用部署候选；尚无生产主机、域名、证书、数据库或厂商配置，未执行安装、启动、DDL、GRANT 或付费模型调用。上线使用最终完整 CI 与独立审计验收的实际 SHA/制品，不能把开发 dirty VM、scratch 测试签名或本模板本身当成生产验收。

首版运行两个既有长期进程：runner 与 router。沿用 [runner unit](../../deploy/vm/agent-runner.service.template)、[router unit](../../deploy/vm/agent-router.service.template) 和现有 VM 工具，不新增产品入口或常驻业务服务。一个已有的 TLS 反代是主机基础设施；MySQL、Redis 和该反代均由操作者另外提供，不由本包自动安装或管理。单机没有 HA，重启时可以短暂拒绝请求；不宣称跨主机接管或灾备完成。

## 1. 最小拓扑和能力

公网可信调用方 → TLS :443 → 本机 router 127.0.0.1:8080 → 本机唯一 runner 127.0.0.1:8787；MySQL/Redis 仅 loopback 或经过明确加密及访问控制的私网，不能暴露公网。当前 env 示例固定本机基础设施，换远端资源必须另外核其 TLS/认证和网络配置，不能只换主机名。

纯文本 agent/session/turn/SSE、审批与既有内置工具可按公开 HTTP 合同使用。初始配置保持 MCP、managed skills、hooks、subagents 和生命周期附加 gate 关闭；已有 Gateway 以显式有限 RPM/并发策略开启，未完成下述真实摘要和 fleet 确认前不开放入口。Blob 附件、filesystem 写入/cleanup、导出和 telemetry filesystem writer 均关闭；production 允许这个无 Blob 写入的 profile，仍必须用真实 MySQL 和 Redis。不是把 NODE_ENV 改成 development 绕过 production 限制。已有 active telemetry/capture/restore 或非空 Blob 库不能套这个 fresh profile：启动的完整审计必须通过，原 key、receipt、source 和恢复 gate 不能删除或补造。

之后需要 production managed skills/附件，应另行准备并验收共享私有 S3、不可变 namespace/control 和正式 writer gate；需要 MCP 时还须真实 HTTPS OAuth callback、独立受保护 credential key 及对应 fleet 配置。此首版不伪造 S3、AS 或 provider quota；Gateway 复用真实 Redis admission，边缘限流不能替代它。

## 2. 验真、解包和固定目录

目标为 Linux、与归档完全相同的 CPU 架构及 Node 24。运行工具前，从独立可信交付渠道取得实际 role/commit、tool/archive/manifest 摘要；校验工具原始字节。现有 vm-release-tool 仅 pack/unpack/verify/inspect-signed/unpack-signed，没有 run、配置生成、安装、迁移或 service-enable 能力。完整参数和签名步骤复用 [VM 发布合同](local-and-deployment.md#vm-进程发布包地基)。signed 路径必须使用真实受信公钥 pin 与选定 commit，失败无 unsigned fallback；CI/local 的 ephemeral-test-only 签名不是生产签名根。

每个 role 解包至此前不存在的 /opt/agent-service/<role>/releases/<selected-commit>，保留只读 dist、production node_modules 和 release-manifest.json。先 verify 两 role/OS/CPU/commit/manifest/运输字节再选择各自 current symlink；不能覆盖原目录或在目标主机 pnpm install。新版本选择与启动是操作者显式动作，没有自动 promotion。准备固定非登录账号 agent-runner/agent-router，release 由可信 operator 控制，业务账号只能写各自 /var/lib/agent-service/<role>。原 unit 的 /usr/bin/node 必须确为 Node 24。

## 3. 先独立 schema/authority，再普通进程

严格依次完成 [schema-bootstrap](schema-bootstrap.md)：人工预置 app → 停服窗口 → 正式 schema migrate → 人工 locked definer/metadata schema/runtime 逐表最小授权 → install-metadata/人工 exact EXECUTE → operator verify → [0066 固定初始绑定](schema-bootstrap.md#55-0066-单一-mysql-authority独立停止窗口与固定初始绑定) preflight/activate 与同 command 实际确认 → 受限 runtime 冷启。authority preflight 不是自动停服证明，旧 writer 的所有 host 登录、事务和 client 都必须按正式 admission 退休；新库也须真实 inventory。

已有0066 current binding 的环境不能重新走 initial；必须按其实际版本与既有 binding/source 选择后继协议。尚未绑定但已有业务数据的旧库，初绑仍须完整核验真实 expectedSource 和所有旧 runtime 用户名的全部 host；不得照抄空库来源或 oldAccountNames=[]，更不能换新 command 掩盖未知结果。

长期 runner 只有受限 MYSQL_URL 和三项 MYSQL_SCHEMA_METADATA_*，没有 operator DSN、AUTHORITY_*、SCHEMA_*、迁移目录或 GRANT 权。router 不持 MySQL、master、provider 或 bootstrap 权。旧 active0033 的 authority 命令必须提供原 protected raw32 operator ref key；不能生成替代 key。schema/authority 命令仍是原 runner main 显式 one-shot，不注册 daemon，不放在 ExecStartPre 自动执行。生产恢复继续受原 hard-deny/既有控制门禁约束；本手册不允许自动 import、自动重试 unknown、换 command/source 或跳过 receipt 校验。

## 4. 角色配置与首次管理员

候选文件为 [runner.env.example](../../deploy/production/runner.env.example)、[router.env.example](../../deploy/production/router.env.example)。这些是 systemd EnvironmentFile 文本，不是 shell/JSON；每个 __...__ 都须在私下替换，未替换模板不是可启动配置。master 必须独立随机64hex，internal token 为两 role 同一随机32～256位允许字符；密码要正确 URL-encode。示例厂商只展示已有 deepseek/deepseek-chat preset，不是采购建议；实际厂商/精确已定价模型/权限和付费预算由操作者选择。API_KEY 仅 runner，不能照抄根 .env 或 local root DSN。

配置分别放 /etc/agent-service/agent-runner.env 与 agent-router.env，root-owned0600，并保护父目录。它们仅由 PID1 读后分发环境；不要 source、echo、放入 release/argv/公开配置。master、数据库、Redis namespace 和将来的 Blob 状态在重启之间保持稳定；RUNNER_ID 固定为该单实例 slot，不能每次换随机名字。不同 Redis 凭据必须访问同一实际 DB/prefix/namespace；实际 ACL 由基础设施管理员预置和验证。

复用原两 unit，核 User/Group、current 路径与 StateDirectory；保留原60秒 TimeoutStopSec。普通 EnvironmentFile 不含 ADMIN_BOOTSTRAP_*。首次管理员另按 [bootstrap 第6节](schema-bootstrap.md#6-受限-runtime-冷启动与唯一-first-admin) 进行：只给这次受控 runner 同时注入 ADMIN_BOOTSTRAP_TENANT 和位于其可写私有 state 目录的绝对 ADMIN_BOOTSTRAP_OUTPUT_FILE，create-only0600输出，等待真实 ready/文件证据后正常停止，私下交付 key 给可信后端，再移除这对变量后重新启动长期 runner；最后启动 router。不得使用 production 拒绝的 BOOTSTRAP_API_KEY，也不能把管理员对传给 router 或永久保留在所有实例。

service key 和 X-User-Id 的 trusted-caller 合同面向可信 operator/App 后端，不能把 service key 放网页/移动端；无需真实 App，操作者可用受保护 HTTP 客户端体验。首次接入按 [HTTP 手册](http-experience.md) 做同 SID 三轮、精确 key/body replay；202、断流或响应不明按原 turn/status/事件查询处理，unknown 不换新 key 自动重放。

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

只有服务 ready 和文件存在仍不够：按 bootstrap 手册通过受保护通道验证 first-admin key 真实可认证，随后真实停止该 runner。确认 `MainPID=0`、unit cgroup 无残余进程、原 DB 无这个 runtime 的连接/事务；不能仅以 stop 请求返回当作排空。私下保管原 create-only key 文件和已提交事实，不打印或重新引导。

```sh
systemctl stop agent-runner.service
systemctl is-active agent-runner.service
```

最后一个命令应报告 inactive；其非零状态是预期停止状态，不应放进会误判的自动修复循环。移除**本次创建且身份已核实的唯一** `first-admin.conf`，保留其它 drop-in；去掉任何普通 env 中的管理员对，然后 `systemctl daemon-reload`。重新启动正常 runner，按下节获取真实 Gateway 摘要并完成 router 配置，再启动 router；两角色真实业务与停启验收后，才按需要 `systemctl enable agent-runner.service agent-router.service`。首次管理员 key 仅供管理；另建 runtime-scope key 给可信调用方。反代配置须先在实际主机通过 `nginx -t`，外部入口最后开放。

## 5. TLS 反代、边缘限流与指标

[nginx.conf.template](../../deploy/production/nginx.conf.template) 仅放在既有 nginx 的 http context。操作者替换真实域名、受保护证书/key路径和可信调用方固定出口 CIDR，并通过该主机原生 nginx -t；没有自动发证、DNS、iptables 或 enable 操作。当前有意仅允许 HTTPS /v1/，internal、_internal、_router、metrics 及本地 health/ready 诊断不向公网发布，反代清除实际内部认证头。原 runner/router 端口保持 loopback；防火墙仅开放已审443和必要受控运维入口。

模板保完整 /v1 URI、原 Authorization/user header，不缓存/缓冲 SSE，不拦截上游业务错误，不忽略客户端断开，也不自动重试已可能 started 的 POST。body 上限精确1000000字节；75秒是反代读空闲期限，高于10秒 SSE heartbeat，不能说成模型整项期限。访问日志关闭，不能记录 URI/id/query/header/body/key；nginx系统错误日志也须按主机权限/留存策略审阅，不宣称其内容天然与应用闭合日志相同。

5r/s、burst10、每IP32连接/该vhost64连接是待实机验证的保守边缘起值，支持429。它们仅是 IP/连接资源上界：NAT会共享，不能保证跨tenant公平，也不是 provider/model quota、token/费用硬限。候选真实 Gateway 限额为 tenant60RPM/并发2、user30RPM/并发1、platform provider60RPM/并发2；这些只是待验证起值，不是容量承诺。Redis quota 约束真实上游派发；异步turn可能先返回202再以quota错误终结，不能把所有超限都硬断言为同步HTTP429。它不是token/总金额硬限，也不能将独立 BYOK/其它厂商/其它进程费用自动归成全局现金封顶。不得填任意 policy digest；按下一节从本次已验真 runner 取得最终身份。真实费用仍需厂商侧额度/告警、应用 agent limits 和明确调用预算，任何付费 smoke 另经授权。

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
4. 保持 edge 关闭，沿既有私有 HTTP 合同对本机 router POST /_internal/provider-gateway-quota-v1/ready：JSON为 {nonce:新随机64hex,identity:刚取到的完整两字段}，Content-Type为application/json，认证头为 x-agent-service-internal-token。真实token只放operator预置0600 curl-config文件，不放argv/文档/日志；request/response/header文件同样私有。用 curl --config 指向该文件并把response/header输出到新私有文件。必须核 HTTP200、Cache-Control:no-store、x-agent-service-provider-gateway:provider-quota-ready-v1，以及完整回执恰为相同nonce和identity；只看status或readyz不够。无ACK/503/mismatch停止，不选healthy subset或临时关gate。
5. 先用有限本地 fake provider 验证 quota 拒绝、并发与取消清理，再在明确的真实模型预算内做小额 smoke；这些关口和恢复验收完成后，才开放已审可信 caller 的 TLS edge。该准备过程不调用模型、不创建额外服务，也不产生policy自认证。

## 6. 上线前必须实证

本包尚未在真实 Linux 资源运行。root 先验证替换后的两 role 配置确实通过 production 解析，以及 router 无 runner/operator 权限；检查完整 CI/三审计和实际 Linux 双 VM 字节。目标机再核账号、只读 release/current、EnvironmentFile/state 权限、Node24、unit 原生校验、TLS域名/证书和 nginx 原生配置检查。

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

当前内置本地 `create-artifact`、`restore-selected` 和部分 continuation 仍有 production 硬拒绝。本包不删除这些 guard，也不通过设置 development/test 绕过。生产可用版的剩余关键路径是正式外部 backup producer/恢复路线，或单独开发经原生验证的生产冷恢复切片；必须覆盖旧主持续 fencing、独立 source/head 证据、真实数据库/必要对象/keys、原事务中的0066 successor与同 command 确认。完整自动灾备、长期 workflow 和其它生命周期边角可后置，这条最小真实恢复关口仍不能省略。
