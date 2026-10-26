# 文档职责与实现核对记录

整理日期：2026-10-25。本轮依据的产品源码及正式验收基线为 `61c3a58aa0dcc00cc6ecd9bffef16aaa92df7875`；本轮开始时继承 README、PROGRESS、AGENTS 三份未提交状态同步。此次只有文档改动，未产生新 binary 或新 CI 验收。当前版本证据集中于 [PROGRESS](PROGRESS.md)，文档职责见[地图](README.md)。

## 盘点与分工

盘点覆盖根 README/AGENTS/独立 CLAUDE、docs 入口、全部 design/operations/research/review、SDK/参考示例说明、deploy 说明及关联 scripts/package.json/OpenAPI/工作流。`spikes/pi-embed/README.md` 是原 PoC 的局部说明，保留其原有范围，不用作正式部署入口。

README 回答用途、支持范围和最短路径；专题索引按任务分流；设计解释当前模块/流与不变量；运维保留前置、命令顺序与危险边界；PROGRESS 只管当前验收/阻断；AGENTS 管协作规则，CLAUDE 只转入同一规则。旧调研/评审各加历史身份指针，由目录索引维护当前替代。未新建空目录或独立 ADR 体系来重复已有决策。

## 主张 → 依据 → 验收范围 → 处理

下表的“B具名范围”指 PROGRESS 的 CI40211433064/attempt1 及独立审计；它不覆盖实际 C 环境。`受限/实验性` 与 `已实现待验` 按具体能力/环境区分，默认关闭不构成通过证明。

| 文档主张或差异 | 代码/配置依据 | 验收范围与处理结果 |
|---|---|---|
| 服务拓扑、入口和工具版本 | [package.json](../package.json)、[runner main](../apps/agent-runner/src/main.ts)、[router main](../apps/agent-router/src/main.ts)、[构建脚本](../scripts/build-app.mjs) | 已实现并在 B 具名范围验收：2 长期服务/6 JS入口/2镜像；Node24、pnpm12.5.1；移出历史构建流水 |
| 默认端口与持久目录 | [runner config](../apps/agent-runner/src/config.ts)、[router config](../apps/agent-router/src/config.ts)、[本地模板](../deploy/local/examples) | 默认8080/8787与A58654分开；源码准备与现有实例分流，稳定DB/master/Redis/Blob与新run state要求保留 |
| schema/metadata/authority 初始化顺序 | [schema配置](../apps/agent-runner/src/mysql-schema-config.ts)、[authority CLI](../apps/agent-runner/src/session-authority-cli.ts)、[runtime权限](../packages/store/src/mysql/schema-runtime-privileges.ts) | 已实现并在B具名范围验收；普通main verify-only，operator迁移、metadata、逐表ACL、0066停止窗口和同command确认不省略 |
| ordinary/root owner 与 fence | [session authority](../packages/core/src/session/authority.ts)、[Host](../packages/core/src/session/host.ts)、[MySQL authority](../packages/store/src/mysql/session-authority.ts) | 修正“Redis lease 是普通会话写入权威”的旧描述；当前以0066 MySQL authority为准，Redis保留协调/通知职责 |
| 生产R1四张只读表的数目 | [runtime权限](../packages/store/src/mysql/schema-runtime-privileges.ts) | 文档过期：四张是schema_migrations加三个authority表，不能称“四张0066控制表”；已明确列出 |
| 身份、tenant/user与BYOK | [鉴权实现](../apps/agent-runner/src/auth.ts)、[SDK client](../packages/sdk/src/client.ts) | B具名范围；service key只供可信后端，end_user_token与trusted_caller分清，独立operator不混入普通key；客户负责厂商侧撤销 |
| IdP网络验证 | [policy](../apps/agent-runner/src/auth-policy.ts)、[end-user verifier](../apps/agent-runner/src/end-user-auth.ts) | 现有实现/验证缺口：HTTPS/公网预检不等于实际socket绑定；introspection未显式禁止redirect。保留安全目标，需单独安全审查；未复现攻击/未定核心等级，不借MCP/web_fetch验收覆盖 |
| session/turn/items、继续对话 | [HTTP app](../apps/agent-runner/src/app.ts)、[Host](../packages/core/src/session/host.ts)、[SDK](../packages/sdk/src/client.ts) | 同SID续聊，先等前轮终态；resume是快照，unarchive才恢复归档可写；metadata不自动成为模型上下文 |
| 幂等JSON重放 | [Host](../packages/core/src/session/host.ts)、[HTTP app](../apps/agent-runner/src/app.ts) | 文档缺项：200 JSON也可为inProgress；补只读查询原turn直到终态，JSON不证明自然完成，不自动换key重提 |
| 幂等与业务去重期限 | [Host](../packages/core/src/session/host.ts)、[MySQL store](../packages/store/src/mysql/store.ts) | 默认24小时不是永久业务去重；SDK和示例补App长期操作映射责任 |
| SSE、失败与停启持久化 | [Host](../packages/core/src/session/host.ts)、[SDK SSE](../packages/sdk/src/client.ts)、[HTTP客户端](../scripts/ops/http-experience.mjs) | B具名HTTP/冷读范围；断流不取消turn，delta/progress不作durable cursor，结果不明保留身份并只读核实 |
| 参考App与模型质量 | [参考实现](../examples/record-assistant/reference.ts) | 合成App/本地FakeVendor只证接线和关联；A四次真实模型是1step/0tool/max_steps，不能升级成自然end_turn/质量证明 |
| provider/model、Gateway池与fallback | [Gateway配置](../apps/agent-runner/src/provider-gateway-config.ts)、[provider服务](../packages/providers/src) | 已实现并在B具名范围验收；修正旧“WIP/未发布”，保留多key独立身份、三级quota、unknown费用和仅未派发fallback条件 |
| HTTP MCP/OAuth/DCR、progress/stateful | [MCP配置](../apps/agent-runner/src/mcp-registry-config.ts)、[MCP](../packages/core/src/mcp)、[注册路由](../apps/agent-runner/src/mcp-registry-routes.ts) | 已实现并在B具名范围验收；删除旧“DCR未交付”断言；SID/GET不迁移、unknown不重发，stdio/脚本/资源重池与完整矩阵仍规划未实现 |
| skills/hooks/subagents | [skills配置](../apps/agent-runner/src/skills-config.ts)、[hooks](../packages/core/src/hooks)、[子任务](../apps/agent-runner/src/subagents-config.ts) | 静态/受管SKILL.md与轻池有B具名范围，逐gate/owner/fleet授权；filesystem/任意代码/重池限制保留，tenant observer仅ACK |
| 生命周期与受控恢复 | [store](../packages/store/src)、[生命周期](design/04-data-lifecycle.md)、[运维合同](operations/local-and-deployment.md) | 受限/实验性与规划未完成分开；保留0037硬拒、0054 primary-only、unknown/旧receipt、external delete/自动清理off、completion=false |
| Linux/VM信任、R1与监控 | [生产模板](../deploy/production)、[VM工具](../scripts/vm-release-tool.mjs)、[CI](../.github/workflows/ci.yml) | B通用包已接受；目标C的真实托管/TLS/采集告警/存储与恢复待资源验收；手工R1非HA/自动灾备/源不可读恢复 |
| 旧里程碑/待办与新状态互相冲突 | [正式验收指针](PROGRESS.md)、[历史全文](history/2026-10-25/docs/PROGRESS.md) | CLAUDE旧838基线及各处M3未开始/旧CI待验标为历史已替代；M1/M3/M4/P2整体仍未完成，不删除长期目标 |

静审没有确认需要本轮产品修复的核心阻断；文档过期或缺少使用说明已纠正，IdP网络验证缺口单独登记为待安全审查，未把它改写成认可的安全合同。目标生产资源缺失和模型自然完成/质量未验均保留为未验，不通过编辑文字变成完成。

独立复核还补正两处可执行步骤：schema bootstrap退出schema shell后，authority步骤重新建立干净shell、同制品路径及受保护配置，并给出仅真空库initial的闭合JSON；R1明确同command激活确认/close → 持续停写下有限Store冷读/close → resolve确认/close → 普通服务启动。没有新增只读runner模式或业务冷读CLI，目标缺少受审有限核验器时R1验收仍未完成。

## 历史迁移与参考

[迁移清单](history/2026-10-25/README.md)登记11份完整原文的旧位置→新位置、原始SHA/bytes；原位置保留当前入口。原文仅重定位相对Markdown链接，标题/历史正文与证据身份保留，必要旧锚点兼容。17篇research/review正文留原位，只增加历史身份指针；私有原件、原失败报告/测试资源和密钥制品均未迁移或删除。

实际组织参考是本机只读的 [zhgqwx-del/ultrawork](https://github.com/zhgqwx-del/ultrawork/tree/0bff3bd091a780b33f9d65f4cc671e7080425b1c)，HEAD `0bff3bd091a780b33f9d65f4cc671e7080425b1c`，读取日期2026-10-25：README、docs/document-map.md、getting-started.md、architecture-phase1.md、decisions/README.md、archive/README.md。仅借鉴短入口、按角色路径、现状/规划分离与专题/历史分工；未照搬技术栈、文件数或结论，未修改参考仓库。未读取外部OpenCode/DeepSeek新资料，旧research只按其原commit和日期保留，不声称已确认其当前官方来源。

## 首轮静态检查

检查包含实际diff与仅Markdown范围、所有本地Markdown链接/fragment、代码围栏、pnpm命令名、SDK/HTTP配置与示例的源码对照、历史正文保全和ACTIVE绑定。外部URL未联网探测，静态核查不证明真实IdP、模型或目标部署行为。

21项必要继承证据（checkpoint/验收/交接、四阶段稳定小报告及输出、export-proof与六个持久交付文件）SHA/bytes全部一致。A只读OWNER status仍为ready/infrastructureHealthy；首个相对state路径被拒、随后沙箱内socket读取失败，均未触发启停或模型调用，获准的绝对路径只读重查原生0。具体最终检查数字与本机证据绑定在本轮ACTIVE checkpoint；本轮没有执行types/build/test/CI或付费/破坏性示例。

最终静态结果：62份Markdown、854个本地链接/锚点零缺失；29份现行说明中的6段完整JSON可解析、73处pnpm命令名可对应package.json；SDK/示例3段TypeScript仅语法解析通过，未运行类型检查或示例。11份归档全文加17份历史原位正文共28份保全核对通过。`git diff --check`及既有秘密扫描通过（1141个tracked/非忽略untracked文件，值不输出）。最终变更为61份Markdown（含17份新索引/核对记录/归档文件），无产品、测试、工作流或生成产物改动。以上静态收口时尚未提交；用户后继已明确授权本次文档提交与推送，由root执行，采用`[skip ci]`保留纯文档不启动长CI的范围。

提交收尾只同步授权与提交状态，不重做已接受制品验收。GitHub的[提交信息跳过工作流机制](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs)适用于本仓现有push/pull_request触发器；本次不修改工作流、不声称新文档提交有完整binary验收。实际提交/远端身份及结果写入本项目ACTIVE绑定的后继收口记录。


<a id="二次复核"></a>

## 二次复核：清晰性、完备性与代码对齐

复核日期2026-10-25，文档基线为已推送的 `88ab9e6`，产品与正式验收仍为61c，A实际运行版本未变。此次按首次使用者、接入者、架构维护者与运维四条路径，核对文档是否能把任务完成，而非只检查链接或按行数减短。

实际参考下列**本机固定快照**，未联网更新或宣称是当前上游最新版，未修改参考项目：

| 本地项目/commit | 实际参考与借鉴 |
|---|---|
| [Ultrawork `0bff3bd`](https://github.com/zhgqwx-del/ultrawork/tree/0bff3bd091a780b33f9d65f4cc671e7080425b1c) | README、document-map、getting-started、architecture-phase1、decisions索引：短入口、单一索引职责与现状/规划分离 |
| [OpenCode `fe3f3a4`](https://github.com/sst/opencode/tree/fe3f3a41f79ad292cc3c7c629567385a20ec5130) | README、sdk-next、web文档的sdk/server：连接已有服务、返回值/错误模型、按任务定位接口；不照搬单用户权限或远程安装 |
| [Pi `1a584a7`](https://github.com/earendil-works/pi/tree/1a584a7a56eb5e7b4ff8ccbd46430f1533282eed) | 根及agent/ai/coding-agent README、SDK examples：包职责分流、局部概念/事件说明、由最小到进阶的例子 |
| [DeepSeek Harness `ddefc45`](https://github.com/deepseek-ai/deepseek-harness/tree/ddefc45fbc7f8e46dd73185e68295696d1297887) | README、subsystems、persistence-changes、user guide/Python SDK/examples：任务前置→输入→输出→同session续用，行为说明与数据词汇分工 |

### 已处理的差异

| 问题与影响 | 最小处理与代码依据 |
|---|---|
| 架构把重复工具检测、必有partialText写成当前安全阀 | 按[五项Limits](../packages/protocol/src/common.ts)和[Host](../packages/core/src/session/host.ts)描述真实预算及可选partialText；重复检测明确保留为尚未实现的目标，不把现有限额充作该能力 |
| Skills概览残留上游伪接口、token截断与不清晰优先级 | 对齐[parser](../packages/core/src/skills/document.ts)、[registry](../packages/core/src/skills/registered.ts)及Host：静态独立、受管scope解析、已授权挂载名version pin、完整typed快照超限拒绝 |
| journal“没有统一期限”与已有CLI不符 | [restore CLI](../apps/agent-runner/src/restore-ledger-reconcile-cli.ts)的8命令共用最多120秒stop budget，[S3](../packages/store/src/restore-journal/s3.ts)逐请求timeout与operation signal叠加；仍等待native close，不承诺硬120秒退出；generic catalog原限制保留 |
| first-admin之后缺agent/runtime key的准备步骤 | [HTTP手册](operations/http-experience.md#管理员一次性准备)补正式管理endpoint、最小无工具JSON、独立admin/runtime配置、私有响应与201字段核对；字段对照[app](../apps/agent-runner/src/app.ts)/[agent](../packages/protocol/src/agent.ts)/[auth](../packages/protocol/src/auth.ts)，未实际执行创建 |
| curl turn缺显式并发/执行约束，读答流程缺末步 | 对齐[已有CLI](../scripts/ops/http-experience.mjs)的reject与4step/1tool/30s/512限制，明确非费用硬限；补GET turn/items、turnId/afterSeq及持久回答判断 |
| SDK只有流有期限，create/分页GET仍无期限 | 每个[示例请求](../packages/sdk/README.md)分别设置新signal，不复用过期signal；仅语法与源码核对，不执行请求 |
| 含凭据的运维curl未统一处理ambient配置/代理 | 复用HTTP私有配置基线，首参数`--disable`、本机`--noproxy '*'`、私有输出及禁redirect/trace；本机curl手册确认选项语义，未发网络请求 |
| “Runner必需”混入可选域/维护字段，专题重复发布状态 | [运维配置](operations/local-and-deployment.md#runner-配置参考)分基础连接、按能力/持久控制、一次性维护；design只保留topic范围/限制，版本数字短链PROGRESS；skills旧数字转历史深链，原文与证据未改 |

当前任务路径与专题分层可以继续使用。更进一步的大范围整理可按真实阅读需求把重型维护协议拆成独立runbook，但本轮未为减少行数机械分拆，也未复制一套新API/配置目录或引入文档框架。完整恢复、IdP网络安全、真实模型质量与目标生产的缺口保持原身份，不能由文档补齐。复核完成时修正仅在工作树中；用户后继已明确授权与分层图补充一起收尾、提交和推送。

二次复核静查：62份Markdown、906个本地链接/fragment零缺失；8段完整JSON、73处pnpm命令名、3段SDK/示例TypeScript语法检查通过（未运行类型检查或示例）。32份history/research/review文件与88ab基线逐字节一致；diff、既有secret scan1141文件及24d5ae4祖先检查通过。二次复核静查当时20份Markdown改动留在原工作树，未改代码或生成物、尚未提交；后继提交授权另行收口。


### 分层图补回

用户指出分层与轻/重池总体关系在精简后不够直观。核对确认：旧分层ASCII图移入归档，当前§3.2仍有组件图、§7.6仍有轻/重池对比，但§3.3只剩指针。因此在[架构§3.3](design/00-architecture.md#current-layered-architecture)补回按职责分层的Mermaid总览及执行池边界表，保留原锚点并更新§3.0导航。

实际只读参考用户指定《02-Agent-Runtime架构方案.md》§2，原文件57721字节、SHA-256 `609ee78ceffa18f6424a712b4215eac781103a3ab0ecc61b2a5810fba209b3bb`；原件保持本机原位，公开文档不依赖它才能理解当前图。仓库旧图仍在[历史§3.3](history/2026-10-25/docs/design/00-architecture.md#current-layered-architecture)和[职责对照§3.4](history/2026-10-25/docs/design/00-architecture.md#34-历史方案按职责对齐)，未改历史正文。

图按现行代码重新表达：外部业务/接入 → router → runner内核与共享轻池，模型治理为runner内库，MySQL/Redis/对象存储并列；重池、stdio、脚本/resources、exec-server和替代harness使用单独未交付区域与虚线接口。只保留分层表达方式，不沿用旧tenant=user、同进程peer-forwarding、Redis普通写权、Kafka/PG/TiDB或多harness已实现等结论。独立静审确认与runner装配、Pi每turn对象、authority和sandbox仅none的实现一致；图义与Mermaid源文本静查不替代目标部署或实际图形渲染验收。

二次复核与分层图提交收尾：用户已明确授权提交和推送本轮20份Markdown修正。提交使用`[skip ci]`，不修改工作流、不触发文档专用长矩阵，也不构成新的binary验收；exact提交、远端回读和CI观察保存在ACTIVE绑定的后继收口记录。原图未做实际渲染验证的限制保持，不因提交而升级证明。
