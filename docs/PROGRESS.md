# 当前状态与验收

更新于 2026-10-25。**通用部署包已完成，实际生产验收待资源。** 本页维护当前版本、正式验收和剩余事项；完整开发过程及原失败见[历史索引](history/README.md)。代码描述行为，验收只证明具名版本和范围，纯文档变更及其提交不构成新 binary 验收。

## A/B/C 分源

| 对象 | 版本与范围 | 状态 |
|---|---|---|
| A 正式本地持续体验 | `5ce317d9071eed6c063a62764ed98e96e9c01aee`；HTTP58654；普通无 hook 双角色；infra generation2 / Redis8.4.7 | 已接受并保留运行，未升级为 B。本轮 OWNER 只读 status 为 ready / infrastructureHealthy |
| B 通用部署包 | `61c3a58aa0dcc00cc6ecd9bffef16aaa92df7875`；单 Linux 双角色、VM 与 OCI 交付 | [CI40211433064](https://github.com/zhgqwx-del/agent-service/actions/runs/40211433064)/attempt1 全部 13job success，三独立审计通过，六公开 VM 文件持久保存 |
| C 实际生产环境 | 目标机器、信任根、存储、网络、职责等资源尚未提供 | 未部署、未验收；本地/CI 成功不能替代目标验收 |

旧 HTTP57819 是独立保留环境，其历史 readyz 响应不证明当前业务健康或模型余额。A 的配置与启停只看本机 `.local-run/accepted-local-http/USER-HANDOFF.md`；公开通用调用见[HTTP 手册](operations/http-experience.md)。

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

文档规范化已以 `88ab9e6` 提交推送，二次复核及分层图补充已完成，按用户后继授权收尾提交推送，手动体验可辅助发现使用问题；不自动重启完整 M3/M4/P2 队列。核心正确性阻断才按最小修复流程定向处理，原安全门禁不缩减。

C 等待 Linux 主机/固定目录、DNS/TLS/网络、MySQL 身份与停写窗口、Redis binary/ACL/持久化、制品信任根、手工 R1 外部存储与职责、另行模型费用预算、监控和值守八类资源。清单与前置见[初版部署](operations/initial-production.md)。手工 R1 限健康可读源、全 writer 持续停服、先 reserve/prepare 后物理导入、0066 successor 与同 command 确认/受限冷读/resolve，不扩成 HA 或源不可读灾备。

## 2026-10-25 文档规范化

本轮开始时继承原 README/PROGRESS/AGENTS 三份未提交同步，更新文档地图、当前设计和使用/运维合同，整理前全文及旧位置映射保存在[history](history/README.md)。CLAUDE 改为单一协作入口的兼容指针；主张核对与静态验证见[对齐记录](documentation-alignment.md)。

本轮不改产品、SQL、测试、生成产物或 sealed 环境，不迁移/升级/重置/清理、不新增付费调用。用户后继明确授权文档收尾、提交与推送；本次纯文档提交使用 `[skip ci]` 避免启动长 CI，工作流和产品门禁不变。文档静态检查只证明本次文档一致性；B 正式验收身份保持上述 61c，A 继续 5ce。ACTIVE/本机交接索引随本轮收口更新，原证据保持。


## 2026-10-25 文档二次复核

对 `88ab9e6` 的整体复核参考本地 Ultrawork、OpenCode、Pi、DeepSeek Harness 固定快照。已修正架构安全阀/skills预算与恢复期限描述，补齐 first-admin→agent/runtime key→turn→持久结果的通用使用步骤，统一请求期限、curl调用方式及配置分组，减少专题重复验收状态；证据与参考身份见[对齐记录](documentation-alignment.md#二次复核)。重复工具调用检测仍是未实现的原设计目标，未因改文档删除；既有IdP网络验证缺口仍待单独安全审查。

本轮只有文档小修；用户后继已明确授权二次复核与分层图补充一起收尾、提交和推送，继续使用`[skip ci]`。不运行types/build/产品测试/CI、真实模型或任何启停/迁移/部署/清理。A/B/C版本与正式验收身份保持，原历史文件未改；ACTIVE绑定本轮复核及静态检查结果。

分层图补充：根据用户指定旧方案的总体分层及仓库归档，已在[架构§3.3](design/00-architecture.md#current-layered-architecture)恢复当前分层总览，明确共享轻池已实现、隔离重池未交付，保留§3.2组件图和旧锚点。图按当前两服务、runner内Gateway、MySQL0066和Redis协调职责重画；不引入旧方案组件、额外服务、密度或生产承诺。
