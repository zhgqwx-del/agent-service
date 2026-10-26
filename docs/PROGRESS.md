# 当前状态与验收

更新于 2026-10-26。**通用部署包已完成，实际生产验收待资源。** 本页维护当前版本、正式验收和剩余事项；完整开发过程及原失败见[历史索引](history/README.md)。代码描述行为，验收只证明具名版本和范围，纯文档变更及其提交不构成新 binary 验收。

## A/B/C 分源

| 对象 | 版本与范围 | 状态 |
|---|---|---|
| A 正式本地持续体验 | `5ce317d9071eed6c063a62764ed98e96e9c01aee`；HTTP58654；普通无 hook 双角色；Redis8.4.7；原 infra generation2 不变，现由独立 overlay generation2 管理新进程 | 已接受，未升级为 B。2026-10-26 新 OWNER 已恢复管理链，五组件 ready；六项网页启停和真实冷启读回已验证，原数据与配置保留 |
| B 通用部署包 | `61c3a58aa0dcc00cc6ecd9bffef16aaa92df7875`；单 Linux 双角色、VM 与 OCI 交付 | [CI40211433064](https://github.com/zhgqwx-del/agent-service/actions/runs/40211433064)/attempt1 全部 13job success，三独立审计通过，六公开 VM 文件持久保存 |
| C 实际生产环境 | 目标机器、信任根、存储、网络、职责等资源尚未提供 | 未部署、未验收；本地/CI 成功不能替代目标验收 |

旧 HTTP57819 是独立保留环境，其历史 readyz 响应不证明当前业务健康或模型余额。A 的当前配置与启停看[新私有交接页](../.local-run/environment-control-20261026-v1/USER-HANDOFF.md)；原 accepted-local-http 交接页与 OWNER 记录原位保留为证据，不再执行旧 start/restart。公开通用调用见[HTTP 手册](operations/http-experience.md)。

## 当前验收证据

B 的 source freeze 为 1124 输入，root `cb255cbac4adacba55285f45a06bee7a83a0d53ebc3ac5d96e4ee82aa7d65f9e`，freeze SHA `6d2d91920dcb3660ba47989311a43cf98e29314061dbbec9e7944c995214fbaa`。同 SHA clean build、双 Darwin 开发 VM、Linux CI 及下载字节证据分别保存，不混称同一个运行。

| 门禁 | CI40211433064 / attempt1 结果 |
|---|---|
| 主测试 | 8564 passed，88 专用 skip：86 项 S3 另过、1 项付费模型与 1 项 local-only 旧 VM 未在本 CI 跑 |
| required | 336 unique 文件 / 7535 断言 / 130 重叠 group，不重复计算重叠子集 |
| 历史 | 3 个独立分片聚合，58 文件 / 358 项，零 fail/skip/todo |
| S3 / cluster | S3 16 文件 / 86 项零 skip；cluster 12 文件 / 41 项；独立 T3g4 是重叠子集 |
| coverage | lines 85.74 / statements 82.57 / functions 89.85 / branches 79.14，阈值未降 |
| 独立审计 | 主历史、runtime、Linux 双 VM 实际下载字节均原生 0；每 VM 396 源输入对应 exact commit |

本机私有 hub 为 `.local-run/core-http-sequence-20261022-kvd0yoee`。正式根验收：`current61c3a58-abc-delivery-final-acceptance-v2/acceptance.json`，SHA-256 `18daee561106ed5e26fddfedd88bc047e1d45cf2726d10908ed7ca471a5ff837`，35603 字节。通过 hub 的 `ACTIVE-ROOT-LATEST.json` 读取绑定的 checkpoint、验收及交接，校验 SHA/bytes；私有资料不作为公开初始化的前置。

六个公开 VM 文件保存在本机 `.local-run/deliveries/61c3a58aa0dcc00cc6ecd9bffef16aaa92df7875/ci40211433064-attempt1/linux-dual-vm`，每 role 为 release.tar / transport-proof.json / vm-release-tool.mjs。Linux x64/Node24，构建 Node24.21.0；runner tar 195145216 字节 / SHA `6dfad64e427b8fd28b24526000a05673af253768d6fd140d3ea6d6190f0cecba`，router tar 13940224 字节 / SHA `1f8c75f70eee4df9083d97c9aea054adeeda0f81750315e38c34b50586b2206d`。CI 临时签名不等于生产信任根。

原 00dd 等 CI 失败、私有审计拒绝、时钟 RED/GREEN、分段结果和保留资源均见[原始进度全文](history/2026-10-25/docs/PROGRESS.md)。不将其改成成功，不宣称旧超时根因已证明，不拼一次本地 full 绿。官方 API 有 13 制品，按名单下载 11 份，另两份 Docker build 记录；此次不新增官方原 ZIP 字节/CRC 已验的声称。

## 能力与剩余范围

| 范围 | 当前判定 |
|---|---|
| M0 | 完成 |
| M1 | 核心 session/turn/items/SSE、OpenAPI/SDK 与多项生命周期切片已有验收；完整数据生命周期未闭环，未冻结 |
| M2 | router、多 runner、fencing/接管的本地/CI 代码范围冻结；云上拓扑未因此验收 |
| M3 | HTTP MCP/OAuth/DCR、公共 progress/2025 stateful、静态/受管 SKILL.md、hooks/webhook 与轻池子任务有具名发布范围；stdio/脚本/资源执行重池及完整兼容矩阵未完成 |
| M4 | Gateway 基础 quota/有限指标、VM/OCI、schema/metadata/authority、单 Linux/手工 R1 样例已有本地/CI 范围；目标托管/TLS/采集告警和完整生产化待验 |
| P2 | 完整生命周期、联合备份/灾备及全域证明未完成，长期目标保留 |

已实现且在具名范围验收的能力仍受各专题的开关、权限和失败条件约束；本地/CI 与目标待验可并存。受限/实验性生命周期保持 default-off、local-only/production 拒绝及 0037 硬拒；0054 仍 original-primary-only，旧 receipt 不重签、unknown 不提升、产品外部删除/自动清理 off、completion=false。[设计索引](design/README.md)维护各能力边界。

A 的四次真实 DashScope qwen3.8-max 仅验证同 SID 三轮及完整冷启后一轮，均 1step/0tool、completed/max_steps。助手额度 4/4 用尽，不证明 normal6 自然 end_turn、回答质量或厂商账单；新增模型调用必须另有具名预算。用户日常调用与该助手验收额度分开。

## 下一步与阻断

文档规范化及二次复核、分层图补充已提交推送。本地 H5、流式分片、环境面板和安全启停管理已按授权提交推送，回执及其既有 CI 阻断通过本机 ACTIVE 绑定。用户后继要求的手动统一启动与第一批 H5 体验优化已完成实现与本机验收，这些后继改动尚未提交、推送；当前入口和验收见末节。不自动重启完整 M3/M4/P2 队列；核心正确性阻断按最小修复流程定向处理，原安全门禁不缩减。

C 等待 Linux 主机/固定目录、DNS/TLS/网络、MySQL 身份与停写窗口、Redis binary/ACL/持久化、制品信任根、手工 R1 外部存储与职责、另行模型费用预算、监控和值守八类资源。清单与前置见[初版部署](operations/initial-production.md)。手工 R1 限健康可读源、全 writer 持续停服、先 reserve/prepare 后物理导入、0066 successor 与同 command 确认/受限冷读/resolve，不扩成 HA 或源不可读灾备。

## 2026-10-25 文档规范化

本轮开始时继承原 README/PROGRESS/AGENTS 三份未提交同步，更新文档地图、当前设计和使用/运维合同，整理前全文及旧位置映射保存在[history](history/README.md)。CLAUDE 改为单一协作入口的兼容指针；主张核对与静态验证见[对齐记录](documentation-alignment.md)。

本轮不改产品、SQL、测试、生成产物或 sealed 环境，不迁移/升级/重置/清理、不新增付费调用。用户后继明确授权文档收尾、提交与推送；本次纯文档提交使用 `[skip ci]` 避免启动长 CI，工作流和产品门禁不变。文档静态检查只证明本次文档一致性；B 正式验收身份保持上述 61c，A 继续 5ce。ACTIVE/本机交接索引随本轮收口更新，原证据保持。


## 2026-10-25 文档二次复核

对 `88ab9e6` 的整体复核参考本地 Ultrawork、OpenCode、Pi、DeepSeek Harness 固定快照。已修正架构安全阀/skills预算与恢复期限描述，补齐 first-admin→agent/runtime key→turn→持久结果的通用使用步骤，统一请求期限、curl调用方式及配置分组，减少专题重复验收状态；证据与参考身份见[对齐记录](documentation-alignment.md#二次复核)。重复工具调用检测仍是未实现的原设计目标，未因改文档删除；既有IdP网络验证缺口仍待单独安全审查。

本轮只有文档小修；用户后继已明确授权二次复核与分层图补充一起收尾、提交和推送，继续使用`[skip ci]`。不运行types/build/产品测试/CI、真实模型或任何启停/迁移/部署/清理。A/B/C版本与正式验收身份保持，原历史文件未改；ACTIVE绑定本轮复核及静态检查结果。

分层图补充：根据用户指定旧方案的总体分层及仓库归档，已在[架构§3.3](design/00-architecture.md#current-layered-architecture)恢复当前分层总览，明确共享轻池已实现、隔离重池未交付，保留§3.2组件图和旧锚点。图按当前两服务、runner内Gateway、MySQL0066和Redis协调职责重画；不引入旧方案组件、额外服务、密度或生产承诺。

## 2026-10-26 本地 H5 体验工具

用户后继要求完整部署/调用步骤、本地 H5 模拟 App 聊天、按需真实模型及测试。已新增[操作指南](operations/chat-h5.md)、`experience:h5` 本机代理和中文响应式页面，支持新建/恢复会话、自定义文本、多轮聊天、分页持久消息、执行终态、停止和未知提交只读核对。凭据只在代理内，固定 user/agent/version；不匹配的历史会话只读。工具不进入产品 2/6/2 入口，不初始化、迁移或升级 A。

冻结后 workspace typecheck 通过；H5 与原 HTTP 客户端两文件定向回归 **46/46 passed**（H5 23 项），secret scan 1147 文件、Node 语法与 diff 检查通过。真实浏览器在有限假后端完成三轮、刷新恢复、文本安全展示、未知响应按原 key 恢复、停止、max_steps 区分、提交前失败保留草稿、多会话隔离与 390px 布局；最终假后端只有 7 个 turn、2 个 session，没有自动重复派发。自动测试和浏览器假后端均不调用真实 provider。本轮不声称新的产品 full verify、S3/历史/cluster/VM/CI 或生产验收；B 的正式门禁身份保持原记录。

本机 H5 地址 `http://127.0.0.1:58655`，复用 A 的原 private client；用户手动点击发送使用 A 的实际模型配置。实际 A 只读核对：router `/readyz` 为 200 文本，已有 4 轮/8 项验收消息可从 H5 读回，日常会话输入框可用；助手未提交真实 turn，既有 4/4 模型额度保持。H5 中的就绪标记仅说明 router readiness 请求成功。

该阶段结束时，原 OWNER controller PID 已不存在；原 runner/router 仍运行，router listener 与原记录一致。OWNER status 返回 `failed_or_unknown/native_identity_unavailable`，旧 current/report 的 ready 不作为新观察；未删除锁、重绑、盲停、重启、重建或改 sealed 字节。当时聊天可访问，但原 OWNER 启停管理需要单独按活体证据处理。私有浏览器截图与续接记录保留在本机 `.local-run`，不移入公开文档；该阶段文件留在工作树，尚未提交或推送。

## 2026-10-26 H5 流式分片

按用户后继要求，将 H5 从非流式提交加轮询改为 POST SSE 实时展示，代理逐帧校验/脱敏后转发；支持无持久 seq 的文本 delta、完整消息快照替换、精确幂等 JSON replay、GET events 只读恢复及终态 GET 核实。切会话收回观察，不隐式 interrupt；结果不明不自动重 POST。修复旧 GET 快照回写覆盖新流式 turn 的竞态，保留固定身份、原 limits 和费用边界。

workspace typecheck、H5 两文件 **54/54** 定向测试通过；既有 SDK SSE、runner SSE bounds、router app 三文件 **89/89** 通过。H5 首轮新增测试中 6 项发现上游坏帧被误映射为本地 500，已保留失败身份并修为泛化上游 502，原断言未放宽，复验通过；另补独立 delta 之间的凭据拼接脱敏与末尾 CR 覆盖。未修改 router/runner 产品代码，不声称新 full verify、S3、VM、CI 或 binary 验收。

真实浏览器在有限假后端验证终态前首片可见、第二片追加、快照无重复、刷新后只读续接、执行中停止、断流无重复 POST、切会话隔离及原会话恢复。实际 A 仅以 GET 经 H5→router→runner 读取既有 SSE 事件，200 / `session/created`；没有新增助手真实 turn 或模型调用。该阶段结束时，H5 已在原地址更新，单独重启本机代理；A 尚未启停或升级，原 OWNER unknown 保留，尚未提交/推送。

## 2026-10-26 H5 环境控制与 OWNER 恢复

用户明确授权在不影响原聊天功能的前提下增加状态面板、恢复 OWNER 管理链、开放保留数据的安全启停并补重启恢复测试。新增独立本机 OWNER、私有 UDS 与持久操作/进程 ledger；H5 默认收起的浮层展示 OWNER、Router、Runner、MySQL、Redis，提供六项固定动作及停止/重启确认。浏览器不能指定命令、路径、PID 或凭据。旧 OWNER 活体缺失已核实，原 seal、六 sealed 文件、current/report、锁和 generation 均保留，未改成“原 ChildProcess 已关闭”。新 overlay 的首次接管退出记录只证明 native PID/PGID 消失；随后自有 child 的真实 close 另有记录。

管理操作有 UUID 幂等记录、互斥及未结算操作拒绝；新聊天写入与管理准入互斥，修复会话预读后才停服的竞态。维护前明确拒绝的消息保留草稿，读取、SSE 与 interrupt 沿原链路。停服务先 Router 后 Runner，持续核全库 active turn；停库须两角色实际退出、MySQL 全实例无其它连接/事务、Redis 实际 SAVE 连接精确核 runId/PID/目录与客户端集合；只正常 TERM，不 SIGKILL、NOSAVE、初始化、迁移、清库或自动重试。操作期间暂停健康观察，连接等待原生 close，避免状态轮询干扰停库证明。

实际网页六动作全部成功：应用 stop/start/restart 与 MySQL/Redis stop/start/restart。原数据目录、数据库 UUID、Redis DB/prefix/namespace、master、Blob 目录和已接受 5ce 制品不变；新进程绑定在本机 overlay generation2，原 infra generation2 收据保持原字节。停启前后全库 **7 sessions / 12 turns / 23 items / 102 events** 内容摘要完全一致；runtime 用户可见六会话经 H5 逐个读取，原 Blob 文件数为零且未新增。严格原 native collector 对同一 initial 基线的冷启前后 schema/grants/account/authority/Redis 投影比较通过。实际 A 既有 SSE 经 H5→Router→Runner GET 返回 200，未新增助手 turn/provider 调用，既有 4/4 模型费用边界保持。

workspace typecheck 通过，最终同次九文件 **126/126** 定向测试通过，涵盖聊天/SSE、维护并发、幂等/unknown、私有 IPC、真实临时进程身份与完整冷启顺序；可重复的 H5→OWNER→四临时进程→原会话读回 E2E 一并通过。secret scan 1162 文件通过。桌面与 390px 页面核验通过，浮层内部滚动，收起后聊天输入区保持可见。工具保持独立开发入口，不改产品 2/6/2，不声称新的产品 full verify、S3/历史/cluster/VM/CI 或生产验收。

保留当轮失败：首次运行 native collector 时应用仍有连接，严格拒绝；一次 root 核验误把 cold 收据用作必须为 initial 的基线，严格拒绝，随后改回原 initial 基线通过，比较未放宽。首次新 OWNER 关闭时遇自动释放 socket 的 ENOENT，旧锁/日志保留，修复并以新的私有控制目录恢复；后续 OWNER 正常退出接续及 UDS 测试通过。原失败报告和全部私有记录保留在 `.local-run`，不移入公开文档。当前 H5 为 `http://127.0.0.1:58655`，最终 OWNER 管理链、连接配置与恢复步骤见[新私有交接页](../.local-run/environment-control-20261026-v1/USER-HANDOFF.md)。

本轮收尾提交包含 H5、SSE、本机 OWNER/环境控制、九文件定向测试及使用文档；功能逻辑保持上述已通过的冻结版本，仅同步当前协作入口、提交授权并清理 CSS 文件末尾多余空行。私有 `.local-run`、`.env`、runtime/control 配置、日志与截图保持本机保存。此次为代码提交，沿用现有 CI 正常触发；最终 SHA 的 CI 结果另行绑定，不以本地定向结果代替。

## 2026-10-26 手动统一启动

按用户要求新增 `pnpm experience:up`：电脑重启后，在项目目录手动执行，核已登记的私有配置与原数据身份，恢复 OWNER，依次启动 MySQL/Redis、Runner/Router 和 H5。成功后 CLI 退出，OWNER/H5 后台工具继续运行；重复执行复用已经核验的环境。不安装开机、登录自启或定时任务，不从 `.env` 猜配置，不初始化、迁移、升级或重置数据。使用步骤见[H5 手册](operations/chat-h5.md#1-最快使用复用正式本地-a)，当前私有入口见[统一启动交接](../.local-run/chat-experience-20261026-v1/USER-HANDOFF.md)。

恢复链以真实内核 boot 身份和同主机证明区分系统重启与进程重启；旧开机记录须配置/制品/数据目录、MySQL UUID、精确 ledger/journal 和四端口无人监听等全部证明才可恢复为停止状态，旧 PID 即使复用也不被操作。同次开机仍严格核完整 PID/PGID/UID/start/executable witness。首次登记在原 OWNER 活体上完成，并在受控交接时写入新的 boot 字段；旧 profile、seal、报告、原代际与历史证据保留。未结算、失败或未知状态不重试，启动信号取消等待已接受动作结算后关闭 OWNER/H5，不继续派发下一动作，也不隐式停止应用/数据库。

冻结后 workspace typecheck 通过，最终同次十二文件 **185/185** 定向测试通过，覆盖原聊天/SSE/维护互斥、真实 native 身份/IPC/冷启，以及新启动顺序、重复执行、完整 runtime 退出恢复、跨两次 boot 的追加证明链、端口冲突、未知操作拒绝和启动途中信号取消。额外收紧同 PID OWNER 的完整 witness 比较并验证不发信号。secret scan、Node 语法与 diff 检查通过。测试不调用真实 provider；未实际重启用户电脑，跨 OS boot 证明由程序化身份 fixture 验证，不冒充实际关机验收。

实际 A 已完成旧 H5/OWNER 正常交接，以及 OWNER/H5、应用和数据库全部停止后的统一命令冷启动。重复执行后 runtime/组件 PID、连接收据、process ledger 与操作 journal 均不变，没有重复动作。全库 **8 sessions / 18 turns / 35 items / 151 events** 与本轮启停前基线内容摘要一致，runtime 用户可见七个会话逐个读回，Blob 仍为零文件；既有 SSE 通过 H5→Router→Runner GET 返回 200，浏览器原会话与环境就绪状态恢复。原配置/已接受制品 pin 保持，当前 overlay 为 infrastructure generation3；原 infra generation2 收据和 A 的 5ce 应用字节不变。助手新增 turn/provider 调用为零，4/4 额度保持；用户日常调用形成的新基线不计作助手验收。

首次私有登记脚本把 `lsof -Fp` 的文件描述符行误作 PID，严格拒绝后修正为只读 `p` 字段；当时仅新增启动配置，没有停进程或改业务数据，拒绝记录保留。启动取消竞态由静态复核发现并在真实延迟 OWNER/H5 fixture 中验证修复。工具继续独立于产品 2/6/2，不声称新的产品 full verify、S3/历史/cluster/VM、CI 或生产验收；本轮尚未提交、推送。前一提交 5c8c72c 的既有 CI 固定源文件数量阻断按原 ACTIVE 记录保留，本轮不改工作流、门禁或扩展 CI 修复范围。

## 2026-10-26 H5 即时反馈与状态同步

按用户确认的第一批体验建议实施：请求与幂等键持久保存后即显示本机发送气泡；用精确 key→turnId→唯一 userMessage 身份合并到服务端消息，不按正文去重，保留同一气泡节点。明确未提交/拒绝保留带状态的原文与草稿；结果不明维持只读核对，不自动重发。已认证执行的后继响应允许省略可选幂等键，显式冲突仍拒绝；终态解锁沿用原合同，不因缺用户消息额外永锁，缺持久消息时保留本机原文并明确待核对。

增加等待阶段、本机经过时间、四段页面观察耗时；本地反馈指 DOM 更新，接收确认可以来自 SSE/GET，不冒充纯模型时间。主动发送先完成状态栏布局，再立即回底；阅读历史时分片保留位置并提供新消息/回底按钮。环境面板发出去重的固定状态事件，聊天只读重核健康和当前会话，停启期间保留草稿；进行中的已接受管理操作即使收起面板也继续只读追踪。不改代理/OWNER 的实时发送准入，不缓存 ready 作为新写入授权；管理重复检查与下一条草稿/完整长历史性能留待后续。

冻结后 workspace typecheck 通过，最终同次十三文件 **204/204** 定向测试通过，其中新增 **19** 项执行真实前端脚本的有限 DOM/fetch/SSE 行为测试；覆盖即时反馈、同文双发、SSE/GET交错去重、拒绝与未知、刷新切会话、滚动、环境同步、可选字段/冲突和诊断边界。真实浏览器在有限假后端完成延迟反馈、同文两次独立消息、明确拒绝、断流后恢复、环境 stop/start 草稿保留、长历史滚动与 390px 视口检查；本地反馈观察为 **2–5ms**，向上阅读的 scrollTop 在被动输出期间保持 **2321**，主动发送/回底到实际底部。浏览器恰有 **7** 次显式合成 turn POST，无自动重复、无真实 provider 调用。

原 A 仅 GET 核五组件 ready，并在空闲且无输入草稿时刷新前端，已经加载新交互；没有重启应用、OWNER或数据库，没有修改原配置、数据或已接受制品。统一启动入口保持，之前未提交的启动改动一并保留。本轮原失败报告保留：首次 helper 类型注解缺失、DOM 替身未模拟 disabled 的布尔转换，以及管理测试 fixture 返回错误 UUID；修复测试基础与 fixture 后保持严格行为断言。浏览器另发现状态栏布局导致回底时点过早，已调整顺序并保留调整前通过报告，最终冻结版本完整复验通过。secret scan、语法、链接与 diff 静态核查通过。本轮尚未提交/推送，不声称新的产品 full verify、CI、VM 或生产验收；正式 A/B/C 与既有 CI 阻断保持。私有证据见[本轮交接](../.local-run/chat-feedback-20261026-v1/USER-HANDOFF.md)。

## 2026-10-26 H5 检查耗时、下一条草稿与长历史

按用户确认的第二批建议实施。OWNER 的单次 `inspect` 合并显示快照与空闲检查，四个独立组件最多并行四个探测；每个组件内部仍按原顺序核进程、监听者及完整身份，健康检查后的第二轮原生核验和全部启停边界保留。不跨请求缓存 ready。若第二轮发现组件退出或身份状态变化，返回快照也收紧为 unknown，同时阻止聊天准入与管理操作；普通业务忙碌只关闭管理动作，不被误判为身份故障。

发送请求持久保存后立即分离下一条草稿，回复期间输入框可编辑，发送按钮保持原核对门禁。接受确认、终态、错误、切换会话和刷新均不清除已编辑的新草稿，包括相同文字或主动清空；没有自动排队或发送。明确拒绝只在未编辑下一条且输入仍空时恢复原文，原请求继续保留在状态气泡中。长历史按 item/localKey 原位更新，未变 article、正文与 Text 节点保持，分片使用 Text 追加，保留展开、选区及阅读位置；继续使用原 1 秒兜底轮询、SSE 与终态 GET 合同。

最终冻结后 workspace typecheck 通过，同次十三文件 **221/221** 定向测试通过；比第一批增加 **17** 项（前端 9、driver 3、controller 5）。包含 500 条历史的节点身份与无效 DOM 写入检查、同长度正文修正、下一条同文草稿、终态未空闲不解锁、拒绝/断流/刷新切会话、第二轮探测竞态及拒绝后无原生操作。真实浏览器完成 500 条历史、回复期间编辑、终态草稿保留、切换/刷新恢复与 390px 布局；完整只读刷新后选区“回复”和 scrollTop **47387** 均保持。两个隔离假后端恰有 **3** 次显式 turn POST，无自动重复、无真实 provider 调用。

实际 A 在核空闲、无页面草稿、真实 boot 与完整 witness 后，仅正常 TERM 并恢复 OWNER/H5，原 Router/Runner/MySQL/Redis 四个进程 witness、配置摘要、infra generation3 与业务读回摘要均保持。runtime 用户可见 **8 sessions / 22 turns / 43 items** 是本轮重载前后相同的只读基线，包含用户日常调用，不作为新增助手模型验收。原页面仍为 `http://127.0.0.1:58655/`，已经刷新并恢复就绪；`pnpm experience:up` 入口保持。各十次实际只读状态样本：优化前 p50 **2032ms** / p95 **2188ms**，优化后 p50 **786ms** / p95 **800ms**，p50 约减少 **61%**；这是共享环境检查阶段，不是完整发送或模型延迟。

保留首次前端 27/28 失败报告：稳定 localKey 的无效删除导致晚到持久消息替换气泡，修复后原严格断言通过。提前启动的一次组合运行已中止并保留日志；修正后、准入收紧前的 221 通过报告也保留，最终报告单独绑定冻结字节。secret scan、Node 语法、diff 与本地文档链接存在性检查通过。未提交/推送，不声称新的产品 full verify、CI、VM 或生产验收，不改既有 CI 固定源数量阻断。A/B/C 接受身份保持，助手付费额度仍 4/4 耗尽；私有证据与当前管理入口见[第二批交接](../.local-run/chat-second-20261026-v1/USER-HANDOFF.md)。

## 2026-10-26 统一启动与两批体验优化收尾

用户后继授权将上述三轮现有改动统一提交、推送。提交前核对第二批冻结快照：全部 23 个待提交源文件与记录一致，复用同次 13 文件 221 项测试和 workspace typecheck 的原始通过报告；独立静态复核未发现新增阻断。此次仅补充收尾授权和状态说明，不再修改已验证的工具逻辑。私有 `.local-run`、配置、数据、日志与截图留在本机，不纳入提交。

代码提交正常触发现有完整 CI，不使用 `[skip ci]`；最终 SHA 与 CI 的实际结果分别绑定在本机 ACTIVE 交接，不以本地定向结果声称 CI 全绿。上一提交固定源文件数量门禁的既有阻断保留，不在本轮修改工作流或放宽门禁。运行中的 A 应用、数据库与 H5 不因 Git 操作停启或升级，助手新增真实模型调用为零。
