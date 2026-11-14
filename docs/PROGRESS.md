# 当前状态与验收

更新于 2026-11-13。**通用部署包已完成，实际生产验收待资源。** 本页维护当前版本、正式验收和剩余事项；完整开发过程及原失败见[历史索引](history/README.md)。代码描述行为，验收只证明具名版本和范围，纯文档变更及其提交不构成新 binary 验收。各日期段落的“未提交/下一步”等按当时状态读取，后继收尾另记，不据旧段落推断当前 Git 或环境状态。

## A/B/C 与新主机 N 分源

| 对象 | 版本与范围 | 状态 |
|---|---|---|
| A 原主机正式本地持续体验 | `5ce317d9071eed6c063a62764ed98e96e9c01aee`；HTTP58654；普通无 hook 双角色；Redis8.4.7；原 infra generation2 收据保持，后续 overlay 代际见[第二批 H5 记录](#2026-10-26-h5-检查耗时下一条草稿与长历史) | 原主机已接受，未升级为 B；原数据与配置保留。新主机无原私有证据，未独立复核其当前活体或验收原件 |
| B 通用部署包 | `61c3a58aa0dcc00cc6ecd9bffef16aaa92df7875`；单 Linux 双角色、VM 与 OCI 交付 | [CI40211433064](https://github.com/zhgqwx-del/agent-service/actions/runs/40211433064)/attempt1 全部 13job success，三独立审计通过，六公开 VM 文件持久保存 |
| C 实际生产环境 | 目标机器、信任根、存储、网络、职责等资源尚未提供 | 未部署、未验收；本地/CI 成功不能替代目标验收 |
| N 新主机独立体验 | 源码及本机 Darwin arm64 双角色包 `5d38b2cd6307aab9c8dec2c475b1bebf886d8283`；独占新数据；实际入口见 [N 初始化记录](#new-host-n-initialization) | 初始化、真实 OWNER 登记、统一命令全停冷启和无费用 HTTP/SSE 核对通过；真实模型回复与实际 OS 重启未验，不替代 A/B/C |

旧 HTTP57819 是独立保留环境，其历史 readyz 响应不证明当前业务健康或模型余额。A 的配置与启停沿原主机[统一启动交接](../.local-run/chat-experience-20261026-v1/USER-HANDOFF.md)及其 launch/current 选定的 OWNER 续接；environment-control 与 accepted-local-http 旧交接、OWNER 记录原位保留为证据，不再执行旧 start/restart。N 使用自身登记及[新机交接](../.local-run/NEW-HOST-USER-HANDOFF.md)。公开通用调用见[HTTP 手册](operations/http-experience.md)。

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

原主机私有 hub 记录为 `.local-run/core-http-sequence-20261022-kvd0yoee`。正式根验收：`current61c3a58-abc-delivery-final-acceptance-v2/acceptance.json`，SHA-256 `18daee561106ed5e26fddfedd88bc047e1d45cf2726d10908ed7ca471a5ff837`，35603 字节。持有原件时通过 hub 的 `ACTIVE-ROOT-LATEST.json` 读取绑定的 checkpoint、验收及交接，校验 SHA/bytes；新主机 N 未持有、未独立复核这些原件，私有资料不作为公开初始化的前置。

原主机记录的六个公开 VM 文件保存位置为 `.local-run/deliveries/61c3a58aa0dcc00cc6ecd9bffef16aaa92df7875/ci40211433064-attempt1/linux-dual-vm`，每 role 为 release.tar / transport-proof.json / vm-release-tool.mjs；新主机 N 未持有这些旧交付字节。Linux x64/Node24，构建 Node24.21.0；runner tar 195145216 字节 / SHA `6dfad64e427b8fd28b24526000a05673af253768d6fd140d3ea6d6190f0cecba`，router tar 13940224 字节 / SHA `1f8c75f70eee4df9083d97c9aea054adeeda0f81750315e38c34b50586b2206d`。CI 临时签名不等于生产信任根。

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

产品与体验工具源码基线为`5d38b2c`，包括本地H5/SSE/环境控制、手动统一启动及两批H5优化；本轮Super-agent后继仅提交文档，不代表应用或已验制品升级。该源码基线的CI40321108482/attempt1记录为failure，不能沿用B的CI通过记录，既有阻断不扩展为本轮修复范围。新主机N已完成独立初始化、登记和统一启动，原A私有验收未独立复核，入口和本机证明范围见本页新机记录。不自动重启完整M3/M4/P2队列；核心正确性阻断按最小修复流程定向处理，原安全门禁不缩减。

C 等待 Linux 主机/固定目录、DNS/TLS/网络、MySQL 身份与停写窗口、Redis binary/ACL/持久化、制品信任根、手工 R1 外部存储与职责、另行模型费用预算、监控和值守八类资源。清单与前置见[初版部署](operations/initial-production.md)。手工 R1 限健康可读源、全 writer 持续停服、先 reserve/prepare 后物理导入、0066 successor 与同 command 确认/受限冷读/resolve，不扩成 HA 或源不可读灾备。

Super-agent文章与原型的新增研究及后继深查见[10-31～11-01记录](#superagent-design-followups)。来源/压缩失效已细化为[设计11](design/11-source-context-invalidation.md)的推荐首包方案，待人工评审，尚未开发；[后续任务与依赖](#runtime-source-context-plan)区分文档细化和实现验收。Runtime创建核对可并行设计，SDK/App持久映射另需真实仓储与业务权限输入。持久事件/长期任务、语义协调和重池按需求触发，不自动进入完整开发队列。

轻池多用户资源隔离的[最小补齐方案](design/12-light-pool-resource-admission.md)已整理为设计提案：runner总量、tenant/user占用份额、工具I/O与dynamic待决预算、可信硬ceiling和有界入口/steer。当前均为规划未实现，配置数值与实施评审待完成；[工作包与验收出口](#light-pool-resource-admission-plan)不替代现有来源方案或自动恢复完整M3/M4/P2开发。

[chat-demo研究与客户端候选](#chat-demo-followups)已补充客户端投影、聊天动作及可选富文本的设计边界；保持两服务和Pi分工，不将上游功能清单变成近期Runtime开发队列。

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

<a id="new-host-n-initialization"></a>

## 2026-10-28 新主机独立环境初始化与统一启动

用户授权在当前主机初始化并登记独占本地环境，再执行 `pnpm experience:up`。本轮开始时实际 checkout 为干净 `main` / `5d38b2cd6307aab9c8dec2c475b1bebf886d8283`，包含统一启动和两批 H5 优化；原摘要“尚未提交、推送”滞后于 Git 事实，本轮已同步。新主机未持有原本机证据：没有原 `.local-run`、ACTIVE、A 数据、制品或 OWNER，原私有验收未独立复核。本次新建环境记为 N，不迁移原 A，不改变 A/B/C 接受身份。

N 使用 macOS 15.8.2 / arm64、Node 24.21.0、pnpm 12.5.1、MySQL 8.0.46 和 Redis 8.10.3。固定 Node 官方下载字节经 SHA-256 校验，依赖用 frozen lockfile 安装；从上述干净 HEAD 实际构建并独立记录两个 Darwin arm64 VM 包的可信摘要，OWNER 与 boot 链按原合同核完整 release。新建私有 MySQL/Redis/Blob 目录、namespace、独立密钥及明确 loopback 端口；未使用共享或业务实例，未执行 Homebrew 登录自启。通过一次性私有 operator 脚本执行已审阅的 schema migrate、metadata/locked definer、runtime 逐表最小 ACL、固定 0066 preflight/activate/同 command 确认及读回；唯一 first-admin 鉴权后正常退出，普通双角色不含 bootstrap/operator 配置。建立无工具/扩展的固定 agent/version 和专用 runtime key，真实模型配置仅在本机从 `.env` 映射到受保护 runner 配置；没有真实 provider 请求。

真实初始化控制器及其后继控制器留下原生 witness、配置和独立库存，正常退出后由 OWNER 严格接续；未用任意 sleeper、假 ACTIVE、旧 PID 或手写 boot 身份凑登记。首次 OWNER 在核空闲后实际停止 Router/Runner，再正常停止 Redis/MySQL；数据和记录保留。使用真实内核 boot、数据 UUID、完整 ledger/journal 和两份 release 生成 enrollment，关闭首次 OWNER后，实际执行 `pnpm experience:up` 从四组件停止状态恢复整套环境与 H5。重复执行返回复用，四组件完整 witness 不变；本轮未实际重启电脑，不能冒充跨 OS boot 的实机验收。

N 的 Router 为 `http://127.0.0.1:58963`，H5 为 `http://127.0.0.1:58964/`；MySQL/Redis/Runner 端口分别为 58960/58961/58962。当前默认配置为 `.local-run/chat-experience/launch.json`，实际 OWNER 和恢复证据沿它选定的 current/profile 读取，入口见[新机私有交接](../.local-run/NEW-HOST-USER-HANDOFF.md)。这套 N 的地址、账号及数据不作为原 A 的新观察，旧主机 A 的链接/证据仍只适用于原主机。

当时实际验证：workspace typecheck 通过；统一启动三个定向文件 **58/58 passed**；两份完整本机 VM 包构建与摘要验真通过；OWNER 正常全停、统一命令冷启、重复复用、五组件健康/原生身份及 UUID/数据目录核对通过。真实浏览器显示“本地服务就绪”和“环境就绪”；经 H5→Router→Runner 创建一条合成空会话并 GET/SSE 读回 `session/created`，当时数据库为 **1 session / 0 turns / 0 items / 1 event**，助手真实模型调用为零。模型回复、厂商鉴权/余额/质量未验；未跑新 full verify、S3/历史/cluster/VM 完整矩阵或生产验收。当时已核源码基线 `5d38b2c` 的 GitHub CI40321108482/attempt1 为 failure（main 分片1/3与 runner image Redis 冷启步骤及其依赖聚合）；未重跑或修复 CI，不称全绿。

保留原失败：MySQL 安装包 HTTP/2 传输中断，仅调整该次下载到 HTTP/1.1 后安装完成；首次本机库存把 event scheduler 与 GTID 压缩系统线程计入客户端，在任何 CREATE/DDL 前拒绝。只读核完整线程类型、确认 app/meta/账号均不存在后，保留原报告，按这两种明确系统线程重做独立库存继续；产品门禁未改。首次创建 agent 的显式空 `mcpRegistrations` 被 router 门禁在转发前拒绝；GET 实际列表为零后，以省略该可选字段的普通请求成功，保留原请求和响应。手册示例与此空字段行为的差异仍需单独核对，不通过文档改写把公开合同冲突合法化。

初始化阶段仅同步本机续接和使用说明，不改产品源码、工作流或门禁，当时未 commit/push；后继授权见[四份文档收尾](#new-host-docs-closeout)。私有配置、数据、初始化脚本和原始证据均不提交；N 的登记不能复制到另一台机器使用。

<a id="superagent-design-followups"></a>

## 2026-10-31～11-01 Super-agent研究与设计后续

按用户要求完整阅读本地《Super-agent 设计探索》正文、关键架构/实验图片，并下载官方`deepseek-ai/dsh-superagent-prototype`固定`6337fc823ce20251c8de8085948165c81aaa701e`，静态阅读领域、授权、执行、队列、上下文和部署实现。文章愿景、公开原型差异、实验限定及本项目适配分析见[研究08](research/08-superagent-prototype-analysis.md)。不将合成研发消息实验外推为本项目容量、模型质量或费用结论。

本轮设计结论：保留现有router/runner与Pi边界，明确文章语义Router/Worker不对应本项目两个服务。优先吸收业务任务与执行分离、有界上下文/授权续读、来源版本和对人可行动状态；不引入全局常驻LLM、投机写入、自治Watchdog或BYOM执行。新增[设计10](design/10-task-context-and-orchestration.md)区分现状和后续规划，架构与索引同步；以下是设计后续，不构成代码开发或模型费用授权。

| 顺序 / 触发 | 后续工作 | 当前状态与完成条件 |
| --- | --- | --- |
| 优先完善Runtime设计 | 来源绑定、派生依赖闭包及更正/撤权/删除后的历史/压缩失效 | [推荐首包方案已细化](design/11-source-context-invalidation.md)，待评审、未实现；已确认保守整代隔离和保留SSE。来源控制、全部读取面、摘要/主模型准入及在途结算分包见[最新TODO](#runtime-source-context-plan)；真实来源权威与通知时效另验 |
| 可并行完善Runtime设计 | session创建幂等及按原创建operation精确只读核对 | 规划未实现；现有pending保留只能避免盲重建，不能保证查回。需原子创建/收据、异请求冲突、跨owner、COMMIT后响应丢失/重启、过期/删除不自动重建的验收出口 |
| 通用合同确定后 | SDK持久operation/topic映射小接口与受控持久fixture，再接真实App | 完整恢复依赖创建核对，来源正确性依赖Runtime失效；验证跨进程CAS、未知只读核对、保存失败只重存和旧结果不成current。真实仓储、来源权威/权限及通知时效仍需业务输入，不由fixture替代 |
| 需要检索续读时 | 有界摘要/引用、分页、缺口及每跳授权 | 依赖来源/失效合同；复用history/Blob/skills/预算，不另建通用记忆平台，不让引用扩权 |
| 真实长期事件需求确认后 | 先定跨turn总预算，再做持久inbox、task/执行轮次、投递/消费、取消/到期与unknown核对 | 需求触发候选；根turn的family限额不自动覆盖后继turn或前置摘要。补不可变事件/编辑冲突、每成员权限、代际回执和控制开关语义；active steer/resume/SSE不证明跨进程续跑 |
| 确定性关联不足时 | 受限语义协调与按业务界面的可行动通知 | 候选；先比较直接调用基线的正确关联、延迟、usage与公平性；不把模型角色塞入公共router，不改变API/SSE事实 |
| 确有脚本/设备需求时 | 隔离重池、stdio/脚本或远端执行环境 | 保留原长期候选，未交付；独立评审身份、沙箱、网络/密钥、IPC、取消结算和生命周期，不因上游目录/daemon愿景提前立项 |

2026-11-01后继深查沿来源接收、gate/批次、follow-up所有者、配置变更、读取、Effects、消息消费、slot/后台工作和停止/恢复继续对照源码及测试夹具。更正首轮“Worker只读自身相关对象”的过宽概括：部分领域视图按Ticket限制，但GitHub原始读取与OS/shell权限更广；补明停止有界等待、worker slot和恢复提示都不能替代本项目真实结算/预算/unknown合同。研究已足以支持本次架构适配，不声称全仓逐行审计或上游实测；链路证据见[研究§7](research/08-superagent-prototype-analysis.md#7-后继源码深查实现链与证据边界)。

研究与深查阶段仅有文档变更，继承此前四份未提交文档同步；新主机未持有原本机证据，原A私有验收仍未独立复核。首轮diff、33处本地链接/锚点、20处固定上游文件引用及关键源码符号静态核对通过；后继对六份研究/设计/索引/进度文档新增或改动段的40处本地链接/锚点、35处固定上游文件/行号边界和12个上游测试文件引用静态核对通过，最终二审修订已收口。继承的AGENTS/README/H5说明字节不变，原有进度和私有证据保留。未运行types/build/产品测试/完整CI或上游测试，未启停/迁移环境，新增真实模型调用为零；该研究阶段未commit/push。A/B/C/N版本和既有CI阻断不变。

2026-11-01收尾授权：用户明确要求本轮Super-agent研究、架构设计和TODO整体复核后提交并推送，限文档。root收口研究中的重复优先级、投递/flush先后措辞与阶段授权说明，复核研究→设计→PROGRESS的来源、职责和候选触发条件后，以`[skip ci]`提交本轮六份文档；AGENTS/README/H5及PROGRESS中的既有新机同步保留工作树，不混入本提交。最终提交与远端结果以Git记录及本轮回执为准，不预称新CI或binary验收通过。

<a id="new-host-docs-closeout"></a>

## 2026-11-01 剩余四份本机说明收尾

Super-agent六份文档已提交并推送为`4d4bc0c386ada67cf025fbfb7245eeac9b869695`。用户后继明确授权剩余AGENTS、README、PROGRESS、H5操作说明复核后提交并推送，仍限文档。产品源码与N双角色制品基线保持`5d38b2c`；本次仅使用`[skip ci]`同步说明，最终提交与远端结果以Git记录及本轮回执为准，不重跑产品验证或修复既有CI。

对照当前启动/OWNER/H5源码与本机留存证据：launch/current/profile/client摘要绑定匹配，profile所列八个配置/工具文件摘要保持；原始启动测试报告为三个文件、58/58、零失败，留存smoke报告与上述空会话/GET/SSE、重复启动进程身份保持和助手零真实模型调用一致。原主机ACTIVE及原验收仍未持有、未独立复核；实际OS重启、真实模型回复及目标生产不因本次文档核对新增验收。

收口过时的“末节”、原A旧OWNER入口与阶段授权/提交时态，保留原失败和A/B/C/N分源。只读核记录与文件字节不代表当前进程已重新做健康验收；本次不调用OWNER启停、不查询业务数据库、不迁移/升级、不新增provider请求。私有配置、数据、制品与原始报告保持原位，不进入Git。

<a id="runtime-source-context-plan"></a>

## 2026-11-02 来源绑定与上下文失效方案收口

用户授权按需调整文档/方案，暂不修改产品代码。已把讨论中的保守整代隔离和来源模式保留SSE两项确认写入[设计10](design/10-task-context-and-orchestration.md#source-context-first-slice)，新增[设计11](design/11-source-context-invalidation.md)细化推荐最小范围、来源控制、代际与视图、协议、SSE失效/重放、安全快照、在途结算、数据与兼容验收。当前状态是**文档细化完成、推荐方案待人工评审、代码未开发**；新建opt-in、单owner/文本来源和固定无工具agent等限制是首包建议，不冒充用户已确认的全部产品范围。

核源码后明确两处约束：item/turn正文会原位更新，安全快照不能由旧seq过滤和多次普通GET拼接；现有provider派发callback后仍有await，不能独自代表最终业务来源准入。整代封口后旧代迟到结算不追加canonical session事件；派发结果/usage unknown的新增阻断和既有费用门禁分开定义，不能称为普通路径已有统一能力。来源控制ACK、关流、执行排空和费用结算分别报告，已交付网络的字节不承诺撤回。

| 工作包 | 依赖与最小交付 | 完成条件 / 当前状态 |
| --- | --- | --- |
| S0 详细方案评审 | 本次设计11；选定首包限制、DTO/路由/标识编码、来源namespace权威与通知责任 | 文档细化完成，人工评审待进行；真实App参数不由合成源替代 |
| S1 来源控制与数据基础 | S0后；来源head/版本、稳定operation/CAS、显式mode、代际/seed/dispatch记录，正式迁移与权限/fingerprint | 待开发；同operation异请求冲突、跨owner、缺失/删除来源、旧修订及重启核对负例；不能在此时开放未完成的来源模式 |
| S2 代际、快照与上下文 | S1后；App显式重确认、整代隔离、独立压缩水位及一次有界一致性快照 | 待开发；模型实际输入无旧依赖；不能从旧summary提取“安全约束”；快照与H一致，超限不推进 |
| S3 派发、取消与结算 | S1后可与S2并行；自动/显式摘要、主模型/fallback准入、原dispatch唯一usage、unknown门禁、接管封口及窄结算 | 待开发；迟到成功不采纳正文/水位、不丢账、不自动重派；旧代公开事件在新floor前封口，未知不靠新代解除 |
| S4 全读取面及SSE客户端 | S2/S3后集成；协议/view协商，producer/Host/writer三层关闭，重放/gap、全部内容出口、SDK/H5与迟到请求隔离 | 待开发；旧视图/旧客户端拒绝，normal drain可强关；持久游标不跳号，安全恢复不自动重复POST |
| S5 生命周期、兼容与功能包验收 | S1–S4完成；新域inventory/export/restore、旧fleet排空与前向迁移、定向及适用完整门禁 | 待开发与验收；FakeVendor输入捕获、真实隔离MySQL竞态、router→runner慢socket、恢复/普通会话/邻租户回归和资源测量，详见[验收矩阵](design/11-source-context-invalidation.md#acceptance) |

S1–S4是同一功能包的实现切分，不是可分别对外启用的半成品；通过S5前来源模式保持不可用。session创建幂等/精确核对仍是独立待设计事项，未被source operation替代；真实SDK/App跨进程完整恢复继续依赖它。有界检索、长期任务、语义协调和重池仍按上表原有业务触发条件推进。

方案细化阶段保留现有router/runner/Pi分工和原验收结论，diff与新增/变更本地链接、锚点及关键源码引用静查通过；原主机私有交接缺失仍按原身份保留。该阶段不运行types/build/产品测试/CI，不启停或迁移环境，不新增真实模型调用，变更当时保留工作树、未commit/push；后继收尾授权见下节。新主机未持有原本机证据，原A验收仍未独立复核。[文档地图](README.md)区分新手快速阅读、会议介绍和来源专题评审；来源专项按00概览→10取舍→11详细合同→本节TODO阅读，研究08按需选读。

## 2026-11-02 方案与阅读路线文档收尾

用户后继明确授权本次所有文档修改复核后提交并推送。收尾范围为README、文档地图、PROGRESS、架构、设计10/11与设计索引七份Markdown；root复核推荐方案、当前源码触点、TODO及新手/会议阅读路线一致性，采用`[skip ci]`提交并推送，不修改产品代码、测试、工作流或门禁。来源模式仍是规划未实现，首包范围与协议细节待人工评审；纯文档提交不扩大A/B/C/N、模型费用或生产验收。私有配置、数据、验收原件不提交，最终SHA和远端结果以Git记录及本轮回执为准。

<a id="light-pool-resource-admission-plan"></a>

## 2026-11-10～11-11 轻池资源准入与租户占用份额方案

用户要求将多用户轻池最小补齐方案整理进设计与进度，先不改产品代码。本轮从干净`main / 2d55b9b`静态核对当前接收、预检、Agent启动、工具派发、取消与结算链，新增[设计12](design/12-light-pool-resource-admission.md)，在[架构§9.1](design/00-architecture.md#light-pool-resource-admission)保留总览，并同步设计索引与文档地图。当前状态是**设计提案已整理，规划未实现；拟议配置尚未接入解析器，实际容量数值待隔离无费用测量与实施评审**。本次文档授权不开始产品开发、配置启用、环境操作或付费验收。

已确认的当前缺口：没有runner总执行生命周期容量、统一tenant/user活跃执行份额和跨工具总I/O准入；session启动/steer等待链及dynamic待决总量缺少统一界限。现有SSE、Gateway、MCP/hooks限额各自有效，不能据此声称已有全runner保障。当前turn limits仅对已给的agent/request/适用子策略取最小、缺字段才用默认值，尚无通用runner硬ceiling；本轮修正架构中的过宽概括，不改变源码或把缺口改写成已实现合同。

推荐首包：本地资源准入器原子检查runner/tenant/tenant-user容量；短请求在入队前限量，完整执行名额在重预检前预留、成功后移交、真实settle后释放；覆盖root、child、自动摘要及显式compact。精确replay/steer不重复占长执行槽，仍受请求与累计输入预算。工具/扩展实际I/O、dynamic pending分别限量，审批和父task等待不持有子任务所需的I/O槽；保留独立有界控制通道。具体配置字段、准入/释放时序、超限、字节检查和验收矩阵以设计12为准。

公平目标限定为本进程占用份额隔离；满额直接拒绝，不承诺无饥饿、每租户最低吞吐、跨runner公平、全进程RSS或费用硬上限。资源拒绝不更改既有MySQL authority、Gateway Redis配额、审批/write-ahead及unknown不重派合同；前置摘要、已提交事实与原派发usage不能因后续拒绝被抹去。不新增持久公平队列、负载感知路由或重池，既有来源失效及长期任务规划的范围与依赖保持。

| 工作包 | 最小交付 / 依赖 | 完成条件 / 当前状态 |
| --- | --- | --- |
| L0 配置与合同评审 | 设计12的有限配置、错误分类、部署容量和兼容范围 | 提案已整理；配置数值、发布策略与实施评审待完成，未配置/启用 |
| L1 执行与入口准入 | L0后；短请求/执行runner-tenant-user原子计数、硬ceiling、有界session/steer、root/child/compact覆盖和控制通道 | 待开发；预检/SSE/commit失败、replay/steer、取消/失权/drain及精确一次释放通过 |
| L2 工具资源与字节预算 | L0后可与L1分文件开发；工具/扩展实际I/O、dynamic pending、各入口与模型step/摘要的有界内容 | 待开发；不改变原授权和账务，父子/审批无自阻塞，DNS/body/授权未结清不提前释放，拒绝不伪造unknown |
| L3 观测、兼容与功能包验收 | L1/L2集成；有限标签指标、文档/协议/SDK与运维适配 | 待开发与验收；按[设计12矩阵](design/12-light-pool-resource-admission.md#acceptance)完成无费用定向、真实服务竞态与适用完整门禁；目标持续容量另验 |

L1/L2为同一coherent功能包的实现切分，不能把局部计数器当完整保障；本表不授予自动开发或新增模型预算。新主机未持有原本机证据，原A私有验收仍未独立复核；A/B/C/N版本、既有CI阻断和助手付费额度4/4耗尽保持。本轮仅文档修改，未运行types/build/产品测试/CI，不启停/迁移环境，不新增真实模型请求；私有配置、数据和原始证据保持原位，未commit/push。

本轮静态核查：五份Markdown的新增/变更部分37处本地链接与锚点通过，12项当前源码接点及四组拟议配置尚未落入产品解析器的状态核对通过；独立二审已收口MCP池/后台GET名额移交、dynamic通知前预留、原key查询能力与已有stopReason边界。diff、空白及围栏检查通过。这些结果仅证明文档一致性，设计12的功能验收矩阵仍全部待实现、待执行。

2026-11-11收尾授权：用户后继明确要求本轮文档收尾、提交并推送。范围为设计12、总体架构、设计索引、文档地图与PROGRESS五份Markdown；root复核最终字节及静态检查后，使用`[skip ci]`提交并推送，最终SHA和远端结果以Git记录及本轮回执为准。前述“未commit/push”为整理阶段状态，方案仍规划未实现；不改产品代码、测试、工作流或门禁，不运行产品验证、启停环境或新增真实模型请求，不提交私有资料。

<a id="chat-demo-followups"></a>

## 2026-11-13 DeepSeek chat-demo研究与客户端设计补充

按用户要求调研[官方chat-demo](https://github.com/deepseek-ai/chat-demo)的说明与源码，固定到`5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c / 0.1.1`；来源、控制流、消息树、请求投影、本地存储/归档、附件和渲染分析见[研究09](research/09-deepseek-chat-demo-analysis.md)。上游是浏览器直连厂商API的静态客户端，其服务端搜索/读链接实现不在仓库内。它未提供替换本项目多租户持久执行、Host或Pi的等价实现依据；本轮保留router/runner分工，在[架构§5.6](design/00-architecture.md#56-客户端投影与聊天动作边界)及[设计10 §5.1–5.2](design/10-task-context-and-orchestration.md#chat-client-projection)补充客户端投影与聊天动作合同。

可吸收协议内容、临时流式状态、派生视图、草稿与缓存的分层方法，以及未来富文本的绘制节流；不把上游浏览器保存provider Key的方式用于本项目service key，不继承附件失效后自动重发、缺结尾帧时按本地stopReason判完成或用聊天ZIP恢复Runtime的语义。H5已有草稿隔离、旧view回调丢弃、未知请求只读核对、终态回读和原位增量渲染，未重复列成缺口。

| 项目 | 触发与范围 | 状态与后续完成条件 |
| --- | --- | --- |
| 客户端事实/投影与动作边界 | 明确临时delta、持久事实、草稿及模型上下文的不同职责，区分更正、重新回答、继续与分支 | 本轮文档已整理；不新增API或改变现有H5行为 |
| H5状态、传输与渲染拆分 | 后续体验需求使当前模块难以维护时再立项，不强制迁移React/Zustand | 可选、未开发；实现时沿用现有准入/恢复合同，以无费用后端核对请求轨迹、切换/迟到/终态/unknown及草稿，不增加POST或丢持久事件 |
| 富文本、步骤与引用展示 | App明确需要Markdown/来源/图表时先定公共内容与远程资源策略，媒体仍按业务职责评审 | 可选、未设计完整方案；实现前确定输入/渲染预算，验证长回答、交互延迟、安全链接/图表、来源视图失效与迟到绘制；不据此承诺所有provider输出思考或搜索块 |
| 可执行分支、前缀续写或聊天历史导入 | 明确产品需求后独立设计，不从parentSessionId或UI选择推导fork | 需求触发候选；先定分叉/复制/来源授权、派发与usage、幂等/unknown、生命周期及兼容合同。普通新turn可表达更正或请求继续，但不回退原执行 |

这些候选不调整[来源失效S1–S5](#runtime-source-context-plan)、[轻池准入L0–L3](#light-pool-resource-admission-plan)、Runtime创建幂等/精确核对及App持久映射的既有依赖与优先判断，不自动启动M3/M4/P2或新聊天产品开发。

研究整理阶段从干净`main / ae6011f`开始，只修改六份研究/设计/索引/进度Markdown；上游下载留临时目录，未加入仓库。静态源码研究和公开初始界面查看未填写Key、未发送消息；未运行上游安装/构建/测试或本项目types/build/产品测试/CI，未启停/迁移环境、未新增真实模型请求，当时尚未commit/push。新主机未持有原本机证据，原A验收仍未独立复核；既有A/B/C/N验收、CI阻断与费用边界保持。

文档静态核查：diff/空白/围栏、新增本地链接与锚点、上游固定SHA路径和源码行号检查通过；三份独立静态复核已收口语音调用支路、视图内引用编号及Key类别表述。这些检查只证明研究与文档一致性，不替代上游运行或本项目功能验收。

2026-11-13收尾授权与复核：用户后继明确授权本次调研、架构设计及TODO文档整体复核后一并收尾、提交并推送，继续仅改文档，提交使用`[skip ci]`。范围为研究09、调研索引、总体架构、设计10、设计索引及本页六份Markdown；root与三份独立静态复核确认研究事实、已有/规划状态、动作边界及TODO依赖一致，新增31处本地链接/锚点与36处上游固定SHA路径/行号核查通过。最终SHA和远端结果以Git记录及本轮回执为准；不改产品代码、测试、工作流或门禁，不运行产品验证、启停环境或新增真实模型请求，不提交上游仓库、私有配置、数据或验收原件。
