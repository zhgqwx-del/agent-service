# M3 tool hooks：operator 策略与租户观察

> 最新发布与开发边界（2026-10-18）：operator v1、tenant-admin v2及公共MCP progress/stateful已发布；第7节的轻池11阶段lifecycle/四个固定可信middleware包与真实subagent已实现并完成本地分段收口，发布待最终同SHA完整CI。不是租户任意代码执行或完整M3/生产验收；下方旧候选状态只保留为历史，最新证据见PROGRESS。

> 当前合同分层（2026-10-18）：第1～5节描述已发布的operator v1；第6节是正在收口、尚未发布验收的tenant-admin observer v2。两者不复用配置、密钥或远端决策权限。准确验证状态以PROGRESS顶部与末节为准，不能用v1发布CI为v2工作树背书。

状态：本地受限切片已实现，core/Host/协议/配置/Memory、真实MySQL提交时序与停服冷读、hooks-enabled plain-Node双进程均已有分段验证，类型/API/secret scan及实际构建通过。跨step复用toolCallId的memo正确性缺陷有实际红绿闭合；此前Unicode正控、夹具和类型失败保留，不拼一次全量成功。完整发布状态只认当前main exact-SHA CI，不表示整体M3或生产验收完成。批次及后续状态以 [PROGRESS](../PROGRESS.md) 为准。

## 1. 范围、配置与 owner

本切片只实现 `preToolUse` 与 `postToolUse`。operator 固定配置三种闭合定义：

| kind | phase | 行为 |
| --- | --- | --- |
| `deny-tools` | `preToolUse` | 精确工具名命中即拒绝，否则继续；不改写参数 |
| `observe-tool-result` | `postToolUse` | 只报告 canonical 结果的成功/错误布尔状态 |
| `webhook` | 两者之一 | 固定 endpoint 的匿名 JSON POST；pre 收 allow/deny，post 仅收 ACK |

本节的 operator v1 不加载租户代码、动态模块或脚本，不支持任意 callback 配置、上传/注册 API、LLM/参数改写、结果正文检查或其它生命周期 hook。策略不能增加工具可见性、突破原审批或借 `readOnly` 扩权；webhook 也没有工具参数可供规则判断。后继固定平台 middleware 另见第7节，不扩张本协议的远端权限。

默认 `HOOKS_ENABLED=0`、`HOOKS_CONFIG_JSON=[]`。配置即使只预置、未启用也必须合法；启用须非空。最多 8 个不同 hook id，每项 1～64 个不同精确 `(tenantId,userId)` subject；`deny-tools` 有 1～64 个不同工具名。id/工具名为 `[A-Za-z0-9_-]{1,64}`，没有模式匹配或通配规则。tenant/user 复用共享 Principal 语法；Unicode tenant 不按 128 UTF-8 字节误拒。字面 tenant `*` 也只可能匹配这个完整身份，不代表其它租户。

operator JSON 是闭合 schema，拒绝未知字段、错误 phase/kind、重复 id/subject/tool，以及重复 JSON key（包括转义后同名）。原始配置最多 64 KiB；不接受内联 key、headers、Authorization、客户端、代理、动态模块或 redirect 配置。`HOOKS_` 未知环境字段也拒绝，不读取 `.env`。配置按给定 hook 顺序执行；subject 的排序使用与 locale 无关的精确全序，不规范化或合并不同 Unicode 身份。

`HOOKS_TIMEOUT_MS` 是整个 phase 的预算，默认 1500，operator 范围 100～5000 ms；不是每 hook 重置。`HOOKS_MAX_CONCURRENT_PER_USER` 默认 2、范围 1～8，按完整 tenant/user tuple 计数。配置与 ACL 被复制并冻结；不把远端响应放入跨请求缓存。

## 2. Host 执行与提交顺序

Host 在 unknown tool、停止/失权状态与工具调用次数上限检查之后、审批申请与真实 execution-start 写前标记之前执行 pre。包括已有 session grant 的调用在内，每次实际执行仍经过当前 pre 策略。hook allow 只允许继续原 gate，不等于审批通过；MCP 的 mandatory approval、scope 与不明结果后撤销 grant 的逻辑不变。

pre 按顺序运行，首个 deny、授权/验证错误、超时或取消即不执行工具，其余 hook 记为 skipped，不继续出站。hook 返回后重验 lease、tenant runtime 与 turn 状态；report 和 started COMMIT 进入原串行写链后，在真正调用 store 的边界再次检查。迟到的 allow 不能让已中断或失权的调用写入 started 后继续执行。

post 只针对确实有 started 标记、工具身份匹配且 canonical tool-result 已 COMMIT 的调用，不观察未知/被阻止工具的合成结果。传入的 `isError` 来自最终实际保存/交给 engine 的 canonical 结果，包含序列化或 Blob 存储失败后的固定错误，而不是原始工具输出。

同 turn 的兼容回调以实际 write-ahead call item.id、toolCallId 和 name/isError/JSON-safe payload 身份登记一个 promise，登记发生在异步工作开始前；同一次调用的相同结果复用它，不重复 COMMIT 或发 post，不同身份拒绝。后续 step 即使复用外部 toolCallId，也有独立 durable call item，必须另行提交结果与观察，不吞掉已执行调用或账务。原结果 JSON round-trip、字节上限、Blob 卸载及 canonical engine transcript 语义保留，不把 storage marker 当作结果正文。

post callback 的错误是 observer fail-open，不改写已经保存的工具结果；后续本地 observer 可继续，但 phase 已取消/耗尽后不再发新 I/O。只有 callback 调用位于 fail-open catch 内，store/report COMMIT 错误及后继 owner/fence 检查不被吞掉；它们仍能停止失权 writer 或下一模型步骤。

`hook/completed` 事件仅含原 EventBase 与 session/turn/toolCall 关联、hookId、phase、kind、outcome、configSha256。outcome 闭合为 `allowed`、`denied`、`tool_success`、`tool_error`、`acknowledged`、`failed`、`cancelled`、`timed_out`、`skipped`。不记录 reason 正文、参数、结果、endpoint、key 或远端错误。wire invocationId 不加入此事件。

## 3. Webhook MAC 与匿名 HTTP

每项 webhook 使用 operator 独立提供的 raw 32-byte HMAC key。JSON/env 只存 `signingKeyFile` 的绝对路径，不接受 key 内容；loader 复用的只是 protected-file reader，不是 telemetry/ref/artifact/master key 或其授权。文件必须 owner-owned、owner-only、regular、单链接；以 no-follow/nonblocking FD 读取并核对读取前后身份、大小与时间，恰好 32 字节。0400/0600 可读，群组可读、symlink、hardlink、目录及错误长度拒绝。错误为固定文本，不输出 path/key/native cause。

loader 顺序读取文件，失败不返回部分 service；core 在构造时复制 key，再 best-effort 清临时 buffer，close 后也 best-effort 清自己的副本。这不是可靠 zeroization 或其它内存/备份副本销毁证明。key 的生成、分发、保管与轮换由 operator 负责，不是本切片新增的租户凭据执行能力。

请求为闭合 `agent-service-tool-hook-request-v1`：

```text
schema, hookId, phase, invocationId, configSha256,
refs {tenant,user,session,turn,toolCall},
tool {name,kind,readOnly}, isError, requestSha256, macSha256
```

invocationId 是每次随机的 16-byte hex；refs 为 key 和 kind/domain 分离的 opaque HMAC，绑定真实 owner/session/turn/call，不发送原始身份。pre 的 isError 必须 null，post 必须 boolean。tool kind 只可为 builtin/mcp/dynamic/skill；session/turn/call 文本有界，toolCallId 最多 256 字节。没有 args、结果正文、headers、key 或 URL 字段；opaque refs 仍可在同 key 范围内关联，不能称为完全不可关联。

固定字段顺序的 payload 以独立 request-digest domain 求 SHA-256，再对 payload 加 requestSha256 的闭合对象用 request-MAC domain 求 HMAC-SHA256；domain 与 JSON 之间包含 NUL。响应为闭合 `agent-service-tool-hook-response-v1`：

```text
schema, hookId, phase, invocationId, configSha256,
requestSha256, decision, macSha256
```

响应须 exact 绑定本次 hook/phase/invocation/config/request digest，并以独立 response-MAC domain 验证；pre decision 只能 allow/deny，post 只能 ack。digest/MAC 为小写 64hex，比较使用 timing-safe equality。body MAC 不是非对称签名、远端执行收据或生命周期 grant。

operator 可复用 `validateToolHookWebhookRequest(value,key)` 和 `createToolHookWebhookResponse(request,decision,key)`：前者验证完整闭合对象/digest/MAC并返回冻结副本，后者会再次认证请求并检查 phase/decision，不接受自称已解析的伪外壳。接收方仍须先对原始 JSON 执行有界、严格 UTF-8 与 duplicate-key 检查；JS 对象本身无法证明原 wire 没有重复字段。精确 domain 和编码以 [service 实现](../../packages/core/src/hooks/service.ts) 为准，不自行换编码或把任意 JSON.stringify 顺序视为同一 MAC。

出站只产生固定 `content-type: application/json` 与 `accept: application/json` 应用 headers，MAC 放在 body。复用原匿名 MCP HTTP substrate，不修改其 header/鉴权合同：固定公网 HTTPS endpoint，拒绝 credentials/query/fragment、代理、重定向、压缩 body 与非允许 header；逐次检查所有 DNS 地址并将选定地址 pin 到实际 socket，保留 TLS/SNI 身份检查。没有全局 dispatcher、远端资源抓取或自动 retry。请求最多 16 KiB，响应最多 8 KiB；只接受 HTTP 200/application-json、严格 UTF-8、闭合字段及无重复/转义重复 key 的响应。坏响应/response loss 对 pre 是拒绝，对 post 是失败报告，均不重试。

loopback HTTP 只供显式非生产 fixture，同时要求 `HOOKS_ALLOW_LOOPBACK_FOR_TESTS=1`、`NODE_ENV=test`、原 `MCP_ALLOW_LOOPBACK_FOR_TESTS=1` 与 core 的显式 test option。production 不能打开此豁免；parser 接受 HTTPS 名称不代表 DNS 已验真，实际请求才执行原出站检查。允许配置生产 HTTPS 不等于本候选已完成生产验收。

## 4. 取消、drain 与配置版本边界

每 phase 持有真实 tenant runtime `provider` operation lease，signal 合并 caller、service close 与租户 fence。runner 注入的 fresh authorizer 在执行/I/O 前后按实际 owner 重查 tenant runtime 与 user lifecycle；代建 session 不借用创建者 ACL。不可取消的授权读取必须实际 settle，HTTP 则在 finally 等待 owned request/socket 真正关闭，再归还 lease。close 同步禁止新操作、abort 自有在途并等待其完成；不能把 Promise 已取消当作 I/O 已排空。

phase 预算控制后续 admission/dispatch；实际安全关停或不可取消的授权等待可以超过该预算，不承诺硬截止返回。网络断开/超时也不能证明远端没收到或没执行；没有自动重试、exactly-once、durable webhook outbox、崩溃补发或 webhook 远端回滚保证。post 结果已提交与报告/远端 ACK 之间可有故障空窗，缺事件不能补造成成功观察。

`version(owner)` 同步返回适用 immutable 配置的 digest；disabled/无精确匹配返回 undefined，不改变原无 hooks epoch 编码。适用策略版本进入 contextEpoch，变化在下一 turn 产生 content-free policy/catalog notice；它不泄露配置正文，也不单独授执行权。close 不把适用策略静默变成 undefined，关闭后的 pre 仍拒绝。

当前移除边界：若最后一个扩展就是 hooks，随后 disabled 或移出该 owner，Host 的旧普通 session 可以保留原 contextEpoch，而不额外写一份“已移除”状态；实际调用按当前配置不再运行该 hook。它不是 fleet-wide 即时撤销、清除旧 grants 或删除历史事件的协议。配置/key/ACL 更新须按 whole-fleet 停服排空、统一配置后重启处理；不可用某台 runner 的 epoch 当作独立全 fleet 权威。

## 5. 本地配置与交付边界

只体验 builtin 策略无需 keyfile 或 webhook。给现有本地 runner 预置以下示例，并让 agent 显式允许实际内置工具 `current_time`、使用与 ACL 一致的真实 owner：

```dotenv
HOOKS_ENABLED=1
HOOKS_CONFIG_JSON='[{"id":"deny-time","phase":"preToolUse","kind":"deny-tools","subjects":[{"tenantId":"tenant-example","userId":"user-example"}],"tools":["current_time"]},{"id":"observe","phase":"postToolUse","kind":"observe-tool-result","subjects":[{"tenantId":"tenant-example","userId":"user-example"}]}]'
HOOKS_TIMEOUT_MS=1500
HOOKS_MAX_CONCURRENT_PER_USER=2
HOOKS_ALLOW_LOOPBACK_FOR_TESTS=0
```

命中时 pre denied，工具无 started/执行，也无该调用的 post；将 deny 清单改为其它工具后，current_time 仍经过原审批，再由 observer 记录 canonical 成功/错误。内置 hook 本身不联网；若通过真实模型 turn 触发，模型调用仍可能收费。无模型/外部网络的现有 parser/loader 测试可用 `pnpm exec vitest run apps/agent-runner/test/hooks-config.test.ts apps/agent-runner/test/hooks-runtime.test.ts`，它们不是 SQL 或实际发布包证明，不新增产品 fake 模式。

本包不新增 SQL、常驻服务、JavaScript 产品入口或镜像，仍为 router/runner 两服务、六入口、两镜像。router capability 取全部 configured、当前健康且明确支持 hooks 的 runner 交集；missing/stale/unhealthy/任一不支持均不能按 healthy subset 宣告可用。

M1 未冻结、M2 冻结，M3 仅推进此有限增量。0037 hard-deny、0054 original-primary-only destructive、旧 receipt/unknown 不提升、外部删除/自动清理关闭与全域 completion=false 不变。hooks 不签发 grant、不完成 erasure/灾备，也不以默认 off 掩盖普通启动、迁移或运行正确性缺陷。

## 6. Tenant-admin observer v2（未发布候选）

这是独立的受管观察能力，不把旧operator pre allow/deny协议开放给租户。新peer只可认证并ACK，不能拒绝工具、重写参数或绕过审批；原operator pre deny、unknown tool、停止/失权和工具次数门禁先于新出站观察，MCP mandatory approval保持不变。仍只有router/runner两个常驻服务、六个JavaScript入口、两个产品镜像，无新dispatcher服务或重投daemon。完整11阶段Host生命周期、middleware/改写和真实subagent producer不在本切片中，仍未完成。

公共管理面只允许实际同tenant admin key：`POST/GET /v1/tenant-hooks`、`GET/DELETE /v1/tenant-hooks/:name`、`POST /v1/tenant-hooks/:name/state`、`GET /v1/tenant-hooks/:name/deliveries`。修改使用`expectedRevision`与独立`Idempotency-Key`，永久slot/generation抵抗删除重建ABA，配置与密钥版本不可变。实际`auth.apiKeyId`进入披露授权证据，不用`X-User-Id`冒充管理员。普通用户和platform registry没有此管理权限。

管理面的DELETE是当前配置逻辑失效，不是隐私抹除或远端密钥撤销：永久slot和旧版本、加密signing key/调用快照/意图仍可保留。完整新域物理生命周期属于后续闭环；当前不能据DELETE宣称数据已销毁。master key目前是单受保护身份，没有多key在线轮换/旧密文重加密产品链；更换文件/key-id不能被当作既有历史仍可解密的保证。

默认`bodyScopes=[]`，只发送工具名称/类别、状态和keyed opaque关联标识。管理员可逐版本选择`prompt`、`tool_arguments`、`tool_result`；非空必须显式`disclosureAck="tenant-admin-body-disclosure-v1"`，绑定endpoint/phase/scopes/version/admin，pre不能选择尚不存在的result。pre在逐工具审批之前，因此此项管理员披露不是“该次工具已审批”。配置、provider/OAuth凭据、认证header、master/signing key等已知secret来源不输入正文编制器；不承诺识别任意用户文本中手贴的所有秘密。

`prompt`的精确定义是`current_turn_user_text_v1`：当前turn截至调用水位已经提交的原始`UserMessage.content`文本，包括该水位前已提交的steer；排除skill/mention展开、system/developer/reasoning、历史/compaction、附件/图片/Blob及后来steer。Store绑定真实owner、session/turn、durable call item、seq/partIndex与摘要，post-only也在started时固定快照。它不证明模型实际消费了哪些文本：当前engine没有steer source-ID消费ACK，不能用step/seq/contextEpoch代替消费因果。参数来自真实已持久化tool call；结果来自JSON-round-trip、大小限制与Blob处理后的canonical输出，不是原始返回对象或storage marker。

pre意图先持久化再HTTP；post意图与canonical result/blob bindings处于同一次fenced Memory原子发布/MySQL事务，禁止先写结果再补意图的崩溃空窗。身份绑定实际call item.id与phase，跨step复用model toolCallId仍是不同调用。工具执行途中update/disable/delete policy只阻止后续不再获准的披露/派发，不阻止canonical结果保存；legacy/启用前已started且无快照的调用不补造新观察覆盖。预算超限使用显式不可发送状态，不制造零摘要或密文fallback；真实source、DB、owner/fence及GCM错误不得吞作observer网络失败。

每个意图最多一次有durable witness的有界尝试：`prepared→sending`先CAS，HTTP丢响应、发送后崩溃或到期保持`outcome_unknown`，不自动重投、不重执行工具。过期prepared收为`failed_not_dispatched`；startup有界分页只收敛本地状态，不做HTTP。晚ACK不能升级已封存unknown；合法finish只按精确claim/请求身份收口。管理员delivery列表仅返回ID/digest、phase、状态与时间，不返回payload、owner、密文、claim token或key。它不是可靠重试outbox、exactly-once远端执行或远端回滚证明。

默认`TENANT_HOOKS_ENABLED=0`。启用只接受受保护raw32byte的`HOOKS_MASTER_KEY_FILE`与`HOOKS_MASTER_KEY_ID`，不接受raw master env/JSON；与MCP、provider/ref/artifact及旧operator signing key分离。管理员`signingKey`是精确64位小写hex的write-only输入，独立purpose/owner/call AAD加密后持久化，响应与日志均不回显。新`managed-tenant-hooks-v1` capability、实际key identity及nonce-bound fresh完整configured fleet证明独立于旧`hooks:true`；缺实例/旧版本/身份不一致不能降级为healthy subset。关闭顺序为Host drain→service等待真实授权/DB/HTTP settlement→cipher清零，best-effort buffer清零不是全部内存/备份销毁证明。

0063为独立前向迁移，最终完整表/guard指纹、真实历史升级与并发回滚结果以正式验收为准；必须关闭gate、排空全部旧writer/事务、独立迁移并仅运行新版本，不能热混跑、删marker或让业务库普通启动隐式修复DDL。新secret/body/意图域存在时，旧T3a/T3d/T3f不得遗漏并宣称完成；本候选先硬拒未覆盖的物理生命周期，不提升旧receipt、unknown或全域completion。HTTPS/SSRF/DNS pin/匿名headers与预算沿用受控HTTP substrate，production禁止loopback测试豁免；配置允许生产形态不等于实际生产启用或云验收。

## 7. 完整轻池 lifecycle / middleware（开发中）

本节是后继 coherent 功能包合同，尚未完成真实父子执行、MySQL、历史迁移和最终 CI 验收；不能用前述 v1/v2 或 `8f8c493` 的发布结果代证。它内嵌 runner，不新增 daemon、JavaScript 入口或镜像。

固定可信平台包采用独立 `LIFECYCLE_HOOKS_ENABLED=0`、`LIFECYCLE_HOOKS_CONFIG_JSON`、`LIFECYCLE_HOOKS_TIMEOUT_MS`、`LIFECYCLE_HOOKS_MAX_CONCURRENT_PER_USER`。配置是有界闭合 JSON，ACL 精确匹配实际 `tenantId+userId`，不接收动态 import、脚本路径、URL、header、密钥或租户上传代码。允许的包只有 `audit`、`prompt-policy`、`tool-policy`、`memory-injection`；数组顺序、ACL、参数与预算共同进入不可变配置摘要。旧 `HOOKS_*` 和 tenant-admin webhook 的授权/密钥/披露协议保持独立。

| 真实阶段 | 观察的事实边界 |
| --- | --- |
| SessionStart | 原子 session+seq1 已提交；受管 child 使用根 authority，不取子租约 |
| UserPromptSubmit | initial/steer 的原始与有效输入已提交；不是每次模型 step |
| PreToolUse / PermissionRequest | 工具参数策略和完整 schema 校验；审批请求真正提交后才发后者 |
| PostToolUse | canonical tool result、Blob 与原业务账本提交之后 |
| PreCompact / PostCompact | 真正摘要调用之前 / summary+watermark+usage 原子提交之后 |
| SubagentStart / SubagentStop | 真实 task-child 首 turn / terminal 提交；普通 parentSessionId 不产生事件 |
| Stop / Interrupt | terminal 提交之后 / 先关闭准入并发出真实取消，观察不能阻止取消 |

观察持久化为带独立 invocation ID 的 `lifecycle-hook/started` / `lifecycle-hook/completed`，报告仅含 package/phase/outcome/config digest。权限、owner/fence/T1、序列化或数据库失败不能吞作观察成功；缺 completed 只能解释为未完成。固定纯审计包不具备执行、工具批准或删除授权，也不提供任意远端 observer 回调能力。

middleware 有独立的 `prompt` / `model` / `tool` stage 和 `lifecycle-middleware/completed`，不伪造第十二种 hook。prompt 仅改文本并保留非文本来源；持久 `UserMessage.content` 保留用户原提交，`effectiveContent` 记录真实生效文本并用于冷投影/compaction。tenant v2 的 `current_turn_user_text_v1` 仍指原始 content，不借此次变更扩大披露。

model 策略在每次真实 Pi 请求准备处生效：前缀/追加两个 memory 注入槽、完整输入/系统文本限额、实际模型重新解析及有效限制只收紧。Pi 0.87 的系统提示在官方 system message carrier 中，不是虚构的 `AgentContext.systemPrompt` 字段；真实 provider、凭据和每 step usage 必须对齐。tool 策略只可 deny 或重写独立参数，重验实际工具 schema 后将有效参数持久化并供审批、真正 execute 和后继/冷历史一致使用；不能改工具身份、scope 或审批要求。`item/toolCall/parametersChanged` 关联真实 call item，不依赖可能跨 step 重用的模型 toolCallId。

`lifecycle-root-lease-runtime-v1` 是独立能力，不从旧 `hooks:true` 推断。router 只接收 lifecycle/subagent 两个 enable flag，不持有 runner 的 package JSON 或预算配置；每个 configured runner 必须健康、理解新协议并对两个启用状态与完整 digest 达成一致。nonce-bound 私有证明不缓存、不选 healthy 子集，实际 package/模型/任务边界再验；取消和 close 等待真正授权/传输结清，不以 Promise race 当排空。

真实子执行、共享预算、根寻址审批/动态结果、有限在途成本超支和 SIGKILL 后未知副作用不重派见[02](02-subagents.md)。已有 P2 生命周期与生产门禁不变；新 task/预算 footprint 未闭合的物理清理必须明确阻断，不能升级旧 receipt 或全域 completion。
