# agent-service 协作约定

## 开始工作与权威入口

1. 检查实际工作树，继承已有改动；不 reset、squash 或覆盖用户新改动。默认继续现有工作树。
2. 读 [README](README.md)、[PROGRESS](docs/PROGRESS.md) 当前状态与末节，再按[文档地图](docs/README.md)阅读相关专题。架构、运行与数据安全入口分别为[架构](docs/design/00-architecture.md)、[运维](docs/operations/README.md)、[数据生命周期](docs/design/04-data-lifecycle.md)。
3. 本机续接读取 `.local-run/core-http-sequence-20261022-kvd0yoee/ACTIVE-ROOT-LATEST.json`，沿其 checkpoint、authoritativeAcceptance、nextWindowHandoff 校验真实 SHA/bytes。旧日期快照不覆盖 ACTIVE 的最新绑定。

当前版本/验收数字只维护在 PROGRESS；CLAUDE.md 是独立兼容入口，只链接本约定。research、review 和 history 都是时间点资料，旧“下一步/待验/当前”不得当作现状。专业合同放设计/运维专题，入口只留规则和指针。

## 当前授权范围

本轮对已提交的文档规范化版本 `88ab9e6` 做整体二次复核，参考本地 Ultrawork、OpenCode、Pi 和 DeepSeek Harness 的文档组织，修正已确认的文档差异，并补回架构分层与轻池/重池总览图。图中明确当前实现与规划，不改变部署或执行权限。手动体验仅辅助发现使用问题，不是非付费文档工作的前置；不自动恢复完整 M3/M4/P2 开发。只做文档时使用 diff、链接/锚点、命令与引用静态核查，不重跑 types/build/完整 CI，不新增大检查框架或产品脚本。

A 正式本地环境继续使用已接受 `5ce317d`、`http://127.0.0.1:58654`、普通无验证 hook 双角色和 infra generation2；B `61c3a58` 通用部署包已接受；C 实际生产验收待资源。精确事实见 PROGRESS。纯文档变更及其提交不代表新的 binary 验收。上一轮纯文档提交 `88ab9e6` 已按用户授权推送，使用 `[skip ci]`，未启动新 CI；用户后继已明确授权本轮二次复核和分层图补充一起收尾、提交与推送，由root执行，继续使用 `[skip ci]`；不修改工作流或产品门禁。

用户后继已授权并完成本地 H5、SSE 流式分片、状态面板、独立 OWNER 管理链恢复、保留原数据的安全启停与重启恢复测试；当前范围与验收见 PROGRESS 末节。用户现已明确授权这些代码、测试与文档统一收尾、提交和推送，由 root 执行。此次包含工具代码，正常触发现有 CI，不沿用前述纯文档的 `[skip ci]`；不修改工作流或产品门禁，私有配置与证据不提交。

用户后继授权补齐电脑重启后的手动统一启动命令 `pnpm experience:up`，恢复已登记的 OWNER、原数据库/服务及 H5；不安装开机或登录自启，不增加助手模型调用。开机恢复须核真实 OS boot 与同主机证明、原 profile/数据/制品和全端口空闲，保留旧锁与追加恢复链；sameboot 仍严格核完整进程身份，未知、失败及未结算操作不自动重试。此轮新增工作不自动推定为新的提交/推送授权。

用户后继已授权第一批 H5 体验优化：即时气泡、精确消息状态、等待阶段、主动发送回底/历史阅读位置、环境状态同步与页面耗时诊断；按无费用后端验证。保留既有发送准入、终态核对与不自动重发；下一条草稿、完整长历史性能和管理检查重构属于后续范围，不混入本包。与上轮统一启动改动共同保留，未获新的提交/推送授权。

用户后继已授权第二批：合并单次 OWNER 检查中的重复快照、独立组件有界并行、回复期间编辑下一条草稿、长历史消息原位增量渲染。不得跨请求缓存 ready 作为写入授权，保留健康检查后的独立身份重核和全部启停准入；不自动发送下一条草稿，未知请求只读核对。仅用无费用后端验证；原 A 可在核空闲与完整身份后正常重载管理/H5，复用原应用进程和数据，不新增模型预算或 Git 提交/推送授权。

用户现已明确授权统一启动与两批 H5 体验优化的现有代码、测试和文档一起收尾、提交、推送，由 root 执行。复核冻结源字节及已有验证后正常触发现有 CI，不使用 `[skip ci]`，不修改工作流或修复范围外的既有 CI 门禁；私有配置、数据与验收原件不提交，不新增真实模型调用。

操作 A 前先读 `.local-run/chat-experience-20261026-v1/USER-HANDOFF.md`，按统一启动 `current.json` 选定的 OWNER status 核活体及 overlay 代际。原 `.local-run/environment-control-20261026-v1/USER-HANDOFF.md`、`.local-run/accepted-local-http/USER-HANDOFF.md`、seal、current/report、锁和原 infra generation2 保留为证据，不再执行旧 OWNER 的 start/restart。复用原数据，不自动初始化、迁移、升级、替换密钥或 namespace；旧 HTTP57819 独立保留，不作为正式 A，也不推断其模型余量或业务健康。不凭历史 PID 盲停，不按 `/private/tmp/agent-service-*` 目录名清理。

助手真实 DashScope qwen3.8-max 验收额度 **4/4 已耗尽**：同 session 三轮加完整冷启后一轮，均 1step/0tool、completed/max_steps；不证明 normal6 自然 end_turn、回答质量或厂商账单。新增 provider 请求/turn/step/工具/重试须另有具名预算，禁止自动 POST turn 或运行真实三轮 CLI。用户日常调用与助手额度分开；同类额外测试 case 预算默认授权不包含模型费用。

## 协作与验证规则

- root 统一执行 test/build/DB/Git/network；作者仅编码和静态审查，冻结后不擅改。并行作者分配互不重叠的文件，root 收口。
- 代码改动先类型检查与受影响定向测试；SQL、事务、删除、鉴权正确性改动立即做真实服务及并发/回滚/隔离负例。不得通过改文档把公开合同冲突合法化。
- 相关定向通过形成 coherent 包，冻结后一次完整 verify 及相关 verify-s3，历史/S3/cluster/SDK/实际 bundle/VM 门禁不省略。较大阶段集中提交，验最终 SHA 完整 CI；提交与推送按用户授权的范围执行；产品功能包仍按完整门禁验收。
- 完整运行失败保留原报告与已过结果，只修缺陷、复验失败和影响范围、补剩余门禁。分段不拼成一次 full 绿；required 登记、代码或测试文件存在不证明通过。coverage group 是重叠子集，不重复计数；分片必须同 run/attempt/SHA 精确并集及官方 coverage merge。
- 不降低 coverage、跳过用例、泛化错误 oracle 或扩大 global/hook/lease/SQL/生产期限。用户默认批准同类额外 case 预算，仍逐项记原因和范围；既有具名例外与原失败保留在[历史进度](docs/history/2026-10-25/docs/PROGRESS.md)及原始报告，不能扩大为全局授权。
- 新迁移改变 trigger root 时，先排查 fresh-current-schema 的旧固定数量和错误类型；不改冻结历史前态、不放宽完整集合。旧 writer/事务必须排空，独立迁移与严格指纹核验后只运行新 binary，forward-fix；不热混跑、不删 marker 或隐式 DDL。

## 不变的安全与交付边界

- M1 未冻结、M2 本地/CI 冻结，完整 M3/M4/P2 与目标生产未完成。长期顺序仍为功能包验收 → 尽早体验 → M3 真实纵向 → 必要 M4 → P2 生命周期/灾备，云验收待资源；M1 全闭环不再是进入 M3 的前提。
- 全部 P0、普通路径和启动/迁移正确性仍是发布门禁，不能用 default-off 掩盖。生命周期既有 default-off、local-only/production 拒绝、0037 grant 硬拒、0054 original-primary-only destructive、产品外部删除与自动清理 off、completion=false 保持。旧 CP/receipt/descriptor 不重签，unknown 不提升，不回填历史授权。
- `replay-selected`、`verify-selected`、`activate-selected`、`activate-capture-selected`、`resolve-selected` 要求 exact run、独立 ACK、held GCM、真实 target/operator 锁和完整外部链验真。runtime 每次写入仍须 fresh configured-fleet proof；operator 不获得 ordinary writer 权限。细节见[生命周期](docs/design/04-data-lifecycle.md)与[运行合同](docs/operations/local-and-deployment.md)。
- 初版手工 R1 限健康可读源、全 writer 持续停服、先 external reserve/prepare 再物理导入、真实 0066 successor 和同 command 确认/受限冷读/resolve。失败保留 reservation/部分目标，只能人工 forward-fix，不自动重导、清空或重试导入；它不等于 HA、自动恢复、源不可读灾备、PITR 或联合灾备。完整步骤见[初版部署](docs/operations/initial-production.md)。
- VM 发布绑定目标 OS/CPU、clean/publishable 字节、独立可信摘要/SPKI pin 和选定 role/commit；未知工具不自认证，失败无 unsigned fallback。CI 临时签名不是生产信任根。长期服务/产品 JS 入口/镜像保持 2/6/2。
- 不打印或提交 `.env`、client/auth 配置、token、DSN、header 或密钥。公开样例只用明确占位符；本机 `client.json` 给体验 CLI，curl 使用独立 auth 配置，不混用。exact 32-byte ref key 与 artifact 加密 key 分离。BYOK 只清除系统保存的 key，厂商撤销由客户负责，不能用 fake 或 blocker 冒充撤销完成。
- 保留祖先 `24d5ae4`、原失败/私有报告、加密制品和需保留的测试资源；不广删、不搬私有原件进公开文档。本轮仅更新本项目范围，不改参考项目或全局工具记忆。

整理前的详细协作/技术历史完整保存在[AGENTS 快照](docs/history/2026-10-25/AGENTS.md)；专题当前合同和本约定优先，历史预算与失败身份不因精简而失效。
