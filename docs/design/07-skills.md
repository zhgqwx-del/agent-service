# M3 skills：静态挂载与受管注册包

> 当前候选（2026-10-17，发布前快照）：下述静态挂载是已通过 ad92 CI 的初始范围；受管注册包已有真实纵向与历史分段证据。`d74f7fa` 的 CI 唯一失败为不同新 owner 并发 prepare 的 1213，真实锁图确认是 owner/subject 索引记录的 S/X 锁环，不是 gap。`0061` forward-only 修复已完成本地校准和受影响定向，仍须最终 SHA CI；rollout 见第 6 节，精确发布状态见 [PROGRESS](../PROGRESS.md)，不能用此本地快照替代发布验收。

状态：本地受限切片已实现，真实regular文件、协议/配置、Memory/Host、真实MySQL提交时序/停服冷读及plain-Node调用均已有分段验证；整合检查点25d0e6a的正式MySQL纵向再次通过。共享Principal语法保留合法Unicode tenant，129字符及非法UserId仍拒绝。完整发布状态只认当前main exact-SHA CI，精确证据看 [PROGRESS](../PROGRESS.md)。本节不表示整体M3、生产或完整生命周期验收完成。

## 1. 范围与信任边界

本切片只读取 operator 随 runner 部署的固定目录中的 `SKILL.md`。它是有界 Markdown 指令材料，不是可执行插件，不提供上传、注册/编辑 API、数据库 skill 包、远端 references 抓取、脚本/模板执行或请求/user/tenant/platform 三级覆盖。文件正文中的链接、代码块及 `$ARGUMENTS` 均保持文本；用户参数单独作为有来源标记的文本传入，不做代码或模板求值。

配置由可信 operator 提供，包含 mount id、绝对目录和精确的 `(tenantId,userId)` ACL；不接受请求提供目录、URL、headers、token 或权限。mount id 与 frontmatter 的 skill name 不同：agent 的 `skills` 挂载 operator id，显式输入及 `skill` 工具按 name 选择。一个 agent 挂载的不同 id 如解析成同名 skill，拒绝歧义，不以 Map 覆盖。

默认 `SKILLS_ENABLED=0`、`SKILLS_CONFIG_JSON=[]`。启用必须有合法非空清单；配置即使预置而未启用也必须合法，不因提供清单自动激活。当前 HTTP agent 最多 8 个不同 mount id，技能输入最多 8 个不同 name，参数 UTF-8 最多 8192 字节；`mention` 仍未开放。

```dotenv
SKILLS_ENABLED=0
SKILLS_CONFIG_JSON=[]
# operator 预置示意；仅确认目录、ACL和发布门禁后另行启用：
# SKILLS_CONFIG_JSON='[{"id":"operator-review","directory":"/opt/agent-service/skills/review","subjects":[{"tenantId":"tenant-example","userId":"user-example"}]}]'
```

目录须为规范绝对路径，不含 `..`、重复分隔符或尾分隔符。所有祖先组件及 skill 目录均须是真实目录，不得为 symlink；`SKILL.md` 须为 regular、单链接文件。读取使用 no-follow 文件描述符并在读取前后核对文件身份、大小与时间、命名路径及 realpath；不遍历包内其它资源。Kubernetes projected ConfigMap/Secret 常用 symlink 布局，不能直接声称受支持；应由 operator 提供满足此契约的可信 regular 文件布局，不以关闭路径检查兼容。

目录/config 变更按 whole-fleet 停服排空、统一部署/检查后再启动处理，不支持把某个 runner 的新文件视为即时 fleet-wide 撤销。router 的 skills capability 是全部 configured、当前健康且明确支持的 runner 的交集，不是 healthy subset；配置未探测、缺失、旧协议或不支持均不能宣告可用。

## 2. 文档格式与预算

正式生产依赖是精确 `yaml@2.9.0`。使用 `parseDocument`，启用 strict、uniqueKeys、stringKeys，关闭 parser 日志并检查 errors/warnings；不使用可能打印原输入诊断的 `parse()`。应用接受的是闭合 YAML 1.2 subset，不是任意 YAML：拒绝 alias、anchor、显式 tag、directive、merge key、复杂 key、多文档及显式文档结束；限制 AST 节点/深度，再验证固定字段及类型。解析选项依据见 [YAML 官方文档](https://eemeli.org/yaml/#parse-options)。

```markdown
---
name: review-change
description: >
  Review a change
  without running scripts.
whenToUse: Before reviewing a proposed change
disable-model-invocation: false
user-invocable: true
dependencies:
  tools: [current_time]
metadata:
  audience: operator
---
Read the supplied change and explain the risks. This text grants no tools.
```

- name 为最多 64 字符的 lower-kebab；description 必填，whenToUse 可省略。两个摘要字段先校验原值 UTF-8、1024 字节上限、非法控制字符与 `<`/`>`，再只折叠合法空白为单行；支持普通 folded/literal block，不把非法控制字符吞成空格。
- metadata 仅限有界 flat string map；dependencies 只接受有界、不同名的 tools 清单。其它字段、嵌套材料或未知类型拒绝，不从 metadata 推断权限。
- 完整文件 UTF-8 严格解码，最多 64 KiB；frontmatter 最多 16 KiB，正文最多 32 KiB，摘要目录有独立 16 KiB 上限。正文 Markdown 水平线允许，不把正文中的 `---` 当作额外 YAML 授权。
- source 每次读取真实文件，不缓存正文或跨 owner 结果。默认整次操作预算 5 秒、每 owner 最多 4 个在途操作；配置上限为 30 秒/16 个，并受现有 turn/租约预算收紧。

`contentSha256` 绑定完整原始 SKILL.md 字节，包括 frontmatter 和原行尾；摘要空白规范化不改变该 hash。`versionSha256` 另绑定固定 parser profile、mount id、精确 ACL 与 full-document digest。它们是版本身份，不是仅凭独立正文就能重算的证明，更不证明正文安全或授予执行权。加载须匹配 list 时取得的 exact expected version；目录之后变化会拒绝陈旧加载，不悄悄替换已列出/已选择的材料。

## 3. 模型与用户两条加载路径

授权 list 返回实际 owner 的完整挂载 metadata；Host 只向模型目录展示未设置 `disable-model-invocation` 的条目，并提供固定只读 `skill` 工具。模型调用仅能选择当前授权目录中的 name，不能提供新目录或正文。

显式 `{type:"skill",name,args?}` 输入还要求 `user-invocable=true`。`disable-model-invocation=true` 不禁止本来允许的用户显式调用；反之，`user-invocable=false` 不因模型可调用就放开用户路径。两个字段默认分别为 false/true，实际 load 仍独立强制检查，不仅依赖目录过滤。

dependencies.tools 只能要求 agent/request 已授权工具集合中的名字；缺依赖即拒绝，不补挂 builtin/MCP/dynamic 工具、不更改审批策略或扩大预算。`skill` 的 read-only 仅指读取静态文本；正文或远端工具 hint 不能为其它工具颁发权限，MCP mandatory approval、write-ahead 与未知结果语义不变。

session 代建按实际 session owner，而非管理员/caller 的个人身份解析。未知、无权及不允许的 invocation 不泄露其它 owner 的存在；输出不包含物理路径、ACL 或 parser 原始错误。list/load 前后检查当前 tenant/user 状态，且以真实 `TenantRuntimeCoordinator` operation lease 跟踪文件读取/授权工作。取消与 close 阻止新工作和结果返回；文件描述符与实际在途任务结清后才释放 lease。native FS/授权查询是合作式预算，不能声称 timeout 已硬终止底层工作或完成内存零化。

## 4. Typed 快照、回放与 compaction

Host 只把真实 source load 结果映射为 server-only `ResolvedSkillContext`：id、name、content/version digest 与完整 body。显式输入的快照随 userMessage 持久化；模型加载随匹配的 skill-kind toolCall/toolResult 持久化。普通用户文本、任意 tool details 或 summariser 正文不能铸造该来源 metadata。

实际内容/版本参与 context epoch，目录变化在安全边界追加通知，不改写旧 item。回放及 compaction 使用已存 typed body，不回读今日文件；旧输入如缺 typed snapshot，不事后补造。Blob 卸载保留完整 content/details，水合必须按 owner/session/item/purpose 验证；无法恢复完整 skill snapshot 时拒绝推进，不把小型 storage marker 当作原正文。

写前对保留历史及新加载进行同一 prospective union，按 `(id,versionSha256)` 去重，冲突拒绝；最多 8 个版本、canonical JSON UTF-8 最多 64 KiB。模型 load 与已接受 steer 共用同步预留，不能各自以孤立预算通过后写出超限历史；compaction 显式携带并核验同一 bounded typed 集合，技能输出不按普通 tool 文本静默裁剪。

容量检查自身失败不会发布 prospective map。后续加载/写入失败可能保守占用当前 turn 的预留，直至 turn 结束；这不是事务回滚或完全无状态重试保证。只有实际提交的 item metadata 会被下一 turn 重建，内存预留本身不是历史或权限。现有 fenced commit、seq、幂等、审批与 tenant/user gate 保持原语义。

## 5. 验收与明确未完成项

当前定向证据覆盖真实 regular 文件、YAML/路径/字节边界、owner ACL、版本漂移、两种 invocation、dependencies、真实 coordinator drain、typed item/Blob/compaction，以及 Memory/Host 纵向。正式七文件158项、共享 Host 的完整 MCP 199项回归、类型检查、API一致性及实际 SDK/六入口/四CLI/dist启动已分段通过；具体批次与原失败以 PROGRESS 为准。这些分段不替代真实 MySQL 纵向、最终源码的完整 verify/CI 或生产环境验收。

YAML 的 Node CommonJS entry 随闭包打入 ESM；发布脚本提供仅允许真实 Node builtin 的 require 桥，拒绝第三方包、相对/绝对路径及伪 `node:` 名称。原 source-edge dependency closure 审计继续拒绝任何非builtin泄漏，不把 YAML 留作部署时临时解析的裸依赖，也不换用语义不同的 browser entry。

本切片不新增 SQL、常驻服务、JavaScript 产品入口或镜像；仍是 router/runner 两服务、六入口、两镜像。租户上传、版本存储/包分发、三级覆盖、安装 guard、webhook/hooks、脚本与隔离重池属于后续独立消费者，不能据本模块存在宣称已完成。

M1 仍未冻结、M2 冻结，M3 只交付有界增量。0037 hard-deny、0054 original-primary-only destructive、旧 receipt/unknown 不提升、外部删除/自动清理关闭与全域 completion=false 不变；该文本能力不扩大原 M1/P2 权限或灾备承诺。

## 6. 受管注册包候选：独立版本域

本包接入独立 MySQL metadata 与对象包，不把技能伪装成 session、`input_image` 或 `tool_output`。当前可安装包只含一个 `SKILL.md`；引用、代码块和模板均为文本，不执行脚本、不下载 references。`SKILL_REGISTRY_ENABLED=0` 默认关闭，和旧 `SKILLS_ENABLED` 分开；它不新增服务、进程、JavaScript 发布入口或镜像。

### 选择与调用

旧 agent `skills` 中的 operator mount id 保持原义；新注册名显式写作 `registry:review-change`。最多 8 个 selector，静态和注册源解析成同名时拒绝歧义。正常解析优先级为 user > tenant > platform；turn start 可带 `skillOverrides:[{name,versionId}]`，只选择已挂载同名、当前授权 generation 中的不可变版本，形成 request > user > tenant > platform。它不是新权限或新挂载，也不接受目录、URL 或原始指令正文。

session 代建仍按实际 session owner 解析。override 进入请求幂等 hash、实际显式输入和模型 `skill` 工具；steer 沿用已接受 turn 的选择，不接受中途替换 override。调用标志、dependencies、typed snapshot、Blob 水合、历史回放及 compaction 预算仍按第 3～4 节执行。

### 安装、并发与权限

`POST /v1/skills` 接受闭合的 `{scope,document,expectedRevision}`，变更还须 `Idempotency-Key`。user scope 只需实际用户身份，不强制 admin；tenant scope 只许同 tenant admin。平台管理位于独立 `/v1/platform/skills`，只由 router 验证专用 `SKILL_REGISTRY_OPERATOR_TOKEN`，通过 versioned 私有 route 转发；runner 拒绝该环境变量，也不接收平台 bearer。服务端原始 access/admission 对象不是 HTTP 可序列化权限，更不能代替此前的真实认证。

安装依次严格解析、扫描原始内容、提交独立 staging、create-only 写对象、读回核对实际 bytes，再原子发布 immutable version 与 current pointer。对象键为服务端 opaque 小写安全片段，不使用 `SKILL.md` 作为底层键。版本绑定完整文档摘要、metadata、scope/owner、parser/guard profile、backend 与 namespace。失败保留精确 stage 供同 key 重试；ready replay 不重建已丢失对象。

registry 操作含 export 在显式 S3 I/O settlement scope 中保留 provider 租约，原请求/响应流超时后仍等待底层 SDK、迟到 Body 和实际 reader 结清，`close()` 不提前报告排空。不同 scope 不全局串行，原非 scope S3 请求期限与全局 close 不变。底层不响应取消可能使排空超期；本地结清不证明远端 mutation 已取消或回滚，仍需精确 staging/replay 协议。

slot 的 revision/generation 永久保留。`expectedRevision=0` 只允许从未存在的 slot；删除/重建须精确当前 revision，旧 generation 的 stage、版本和 replay 不得复活。Memory 采用完整图片的单次原子发布；新 registry MySQL 事务采用 RC + exact owner-control X 锁串行所有同 owner 读写，子行仍为 current locking reads。RC 本身不能消除 native trigger 的跨 owner 记录扫描锁环；`0061` 另以精确索引前筛收窄这些查找。旧 M1 的 RR 事务不改。mutation 的 DB time 在 owner 锁等待后采样；1205/1213 只返回固定可重试 503，不自动重试或回显 SQL。

每 owner 最多 256 个 slot、每 slot 最多 128 个版本、全部已 admission 包（包括 stage/历史）累计最多 8 MiB，分页最多 100。未完成 stage 和逻辑删除 bytes 不自动释放该容量；这是当前保守配额，不是物理清理完成证明。

### 安装 guard

固定翻译 [Hermes skills_guard.py](https://github.com/NousResearch/hermes-agent/blob/ee472a7fdbbc55924f91ab122dbaa29bd07668b0/tools/skills_guard.py) 的 SKILL.md 适用规则，源 SHA256 为 `9534cf7b658ec0cb6c85dc2c35fa08a4b46a3a1284be1bbe3c4af2deeb4df7a0`，保留 MIT 归属。`skills-guard-v1` 的 high/critical 阻断，medium/low 仅信息；没有 trust/ignore/force 绕过。结果只保留 rule id、severity、category 和行号，不回显匹配正文。

本地翻译额外采用线性空白/Unicode 字符类规范化与行、word、boundary、finding 工作量上限，超限阻断而非截断后放行；原文 digest、行号与 invisible 检查不变。它是保守启发式，不宣称与 Python 对任意输入完全等价，也不证明文本安全，更不授予工具或执行能力。

### 分发、导出与逻辑删除

独立 `managed-skill-registry-v1` capability 与 storage identity 需要全部 configured runner 的 fresh 探测一致，不能用旧 `skills=true` 或 healthy subset 代替。filesystem 只允许显式本地单 runner + `BLOB_FILESYSTEM_SINGLE_RUNNER=1` + `BLOB_NAMESPACE_ID`，production 拒绝；该 ID 是 operator 声明，不证明其它主机同路径。多 runner 复用已受控的共享 S3 adapter/namespace，真实云 IAM/TLS/容量验收仍待资源。存在 registry footprint 时，旧 Blob activation/mover 不得忽略新域后切换 backend/namespace；当前拒绝，而非假称已支持迁移这些包。

`DELETE /v1/skills/:name` 逻辑删除后，新 runtime list/load/override 均不可使用该 generation。tenant/user erasure gate 同样阻止后续读取与发布。受管 bytes 物理清理尚未实现，不扩写旧33域 plan/旧 receipt；非空 registry 域会阻断未覆盖它的新 T3d/T3f，而不是静默跳过或推进全域 completion。

用户通过 `GET /v1/skills/export` 导出独立 `user-skill-registry-export-v1` 分页：仅实际 user-own，包含全部当前/已删除 slot 与已发布历史版本的原始文档，排除未提交 stage。每页最多 25 个版本；后续 cursor 必须携带原 `snapshotSha256`，完整 owner projection 前后不一致返回 409 重启，不混页。响应无 owner ID、locator、upload token 或 backend，显式 `physicalErasureComplete=false`。这是 registry 域补充导出，不改写旧 `ndjson-v1` 制品，也不是 durable snapshot pin；并发变更可使分页需重启。

### 发布与待验收

`0060` 为 expand-only 的 5 表/20 guard，不回填、联网、激活或删除；其已发布 SQL 字节不改。`0061` 仅轮换 9 个 point-relationship guard，为 owner/slot/installation/version 及 lifecycle/fence 查找增加可索引的完整 PK/unique 等值前筛，保留全部原 BINARY、NULL、owner、metadata、active 和 fence 拒绝残余；5 表、20 个 registry guard 与全库 763 trigger 的数量不变。

升级须关闭 gate、完整停服排空全部 pre-0061 writer，再独立迁移并只启动统一新版本。迁移先核完整 0060 前态，以临时 deny 保护轮换，移除临时 guard 后验证唯一精确新根，最后写 marker；schema 仍按 0060 核验，trigger 严格按实际 marker 选择单一根，不接受任选旧/新根。partial DDL 或 marker-loss 拒绝启动和自动续 DDL，不能热混跑、删 marker/guard 或自动修复，只能受控 forward-fix。

本地已通过保留原 12 项的新版真实 MySQL 13 项，其中新增固定 foreign owner/subject record-lock 回归，不靠重试、概率循环或增加超时；非空原 0060 prefix→0061 历史 4 项及 0059→current 历史 4 项也已通过。历史前态按实际 SQL prefix 与产品生成行证明，不冒称冻结旧二进制。它们是分段证据，不替代尚未完成的新提交/最终 SHA CI；当前进度只认 PROGRESS 末节。物理 package purge、namespace 搬迁、backup/restore 覆盖与云环境证据继续明确后置，旧 completion/unknown、receipt 与 native 恢复边界不变。
