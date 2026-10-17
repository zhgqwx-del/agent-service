# M3 静态 skills：operator Markdown 切片

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
