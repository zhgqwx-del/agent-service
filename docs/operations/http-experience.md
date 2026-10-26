# 通过公开 HTTP API 体验 Agent Service

本文面向还没有 App 的使用者：先把通用服务部署在本机，再用可信客户端完成三轮对话。将来 App 后端调用同一套 HTTP 合同，不必为本次体验先建立业务仓储、跨 session 记忆或工作流系统。

纯HTTP客户端与有限假厂商已有具名本地/CI验收，具体版本、失败和证据见 [PROGRESS](../PROGRESS.md)。自动验证使用隔离真实MySQL/Redis、test-only ACL和实际schema CLI，不证明目标人工SQL预置或模型质量。本文是通用流程；`/ABS/...`、端口、agent ID和凭据占位须由操作者替换，不能套用本机旧交接地址。

## 1. 先准备服务与身份

按[人工 schema 预置、首次管理员与 external-infra](schema-bootstrap.md)准备新的、独占的本地 MySQL/Redis、schema、metadata reader、受限 runtime 账号和稳定 Blob 目录。普通启动只 verify，不自动迁移或补授权。runtime 的全局 `SHOW_ROUTINE` 定义可见范围、停服排空和 forward-fix 边界仍按该手册执行。

首次管理员引导只在一个受控 runner 上执行。`ADMIN_BOOTSTRAP_OUTPUT_FILE` 保存一行 first-admin key，不是 JSON；文件存在不证明数据库提交，失败或响应不明时保留文件和数据库证据，由人工核对。引导完成并实际停止后，从正常角色配置移除全部 `ADMIN_BOOTSTRAP_*`，不要改用开发 bootstrap 快捷 key。

开始体验前，由获授权的管理员另行完成以下准备；本体验客户端不代为执行：

- 在本 tenant 建立并核验一个已有 agent，记录明确的 `id` 和不可变 `version`，确认其实际 provider/model。首轮不挂载工具或扩展，便于只观察模型与上下文合同。
- 建立专用 `runtime` scope service key，保留在可信后端或本机私有配置；first-admin key 只用于管理，不充当日常体验 key。创建 key 的响应会包含秘密，应直接进入受保护通道，不打印或复制到体验结果。
- 明确 tenant 鉴权策略。本文使用 `trusted_caller`：service key 建立 tenant 身份，可信调用方用 `X-User-Id` 指定实际 user。终端用户不能自行持有此 key 或伪造这个可信后端。

固定 agent/version 是本客户端的选择约束，不把 service key 变成只可访问该 agent 的新权限。若 tenant 使用 `end_user_token`，须按其真实 verifier/header 合同接入；不要为运行本文而关闭真实用户验证。首版体验脚本仅按下述可信调用方 profile 使用。

在另一个终端按已有 external-infra 合同检查所选 runner/router `/readyz`。两者 ready 后仍须验证业务鉴权与读写，ready 不代替实际用户或依赖正确性证明。所有公开 API 请求发给 router；不把 runner 内部 token、数据库 DSN、operator 或 provider 密钥交给客户端。

## 2. 使用无费用的本地假厂商（可选）

此profile使用新建、由操作者拥有的本地fixture，不读取项目`.env`或任何真实厂商密钥。fixture 只在随机 loopback 端口提供确定性兼容响应，不连接远端模型。它证明 HTTP 接线与续聊编排，不证明模型理解或真实厂商质量。

使用项目固定的 Node 24 和已准备好的依赖，不通过 `npx` 等入口临时下载代码。

先人工准备 owned `0700` 私有父目录。`--state-dir` 必须是该目录下尚不存在的绝对路径；不要复用旧运行目录。

```sh
umask 077
node --import tsx scripts/ops/experience-fixture.ts \
  --state-dir /ABS/private/new-experience-fixture
```

fixture 前台运行，状态文件为私有 `fixture.json`。描述包含 `kind: "http-experience-fixture-v1"`、随机 `baseUrl`、`provider: "deepseek"`、`model: "deepseek-chat"` 和只用于该 fixture 的 `apiKey`。默认最多响应三次有效模型请求，额外请求拒绝；三轮之外的重放应读取已提交结果，不应再消耗模型响应。

需要单独保留一个可做多组三轮的人工体验环境时，可显式追加 `--max-responses 30`；只接受3的倍数、范围3～30，三份脚本回复依次循环，实际额度记录在描述的 `maxResponses`。这仍是有限的本地假响应，不是任意请求代理。正式默认3次的证据与另一个新 state 的人工环境分开，不能混用计数；`acceptedRequests` 是已消耗响应槽数，`completedResponses` 包含错误状态等所有完成的 HTTP 响应。

操作者在私有编辑器中读取本轮描述，将下表逐项放入 runner 的受保护角色 JSON。不要将文件作为shell source，也不要把真实配置打印到终端。

| runner 配置 | 来自本轮 fixture 描述 |
|---|---|
| `API_BASE_URL` | `baseUrl`，包含 `/v1` |
| `API_KEY` | `apiKey`，仅 fixture token |
| `PLATFORM_PROVIDER` | `provider` |
| `DEFAULT_MODEL` | `model` |

这些字段只进入 runner，不能放进 router。按 [external-infra 前台运行](schema-bootstrap.md#7-显式-external-infra-前台运行)启动已经人工预置的服务，再由授权管理员用公开 API 建立固定 agent/version；体验脚本不创建 agent 或 provider。

fixture 与应用 supervisor 是独立前台进程。结束时分别 Ctrl-C/TERM 并等待它们实际退出，保留 state、输出和外部 MySQL/Redis；fixture 不获得基础设施管理权限，不使用 `down`、`killall` 或删除数据目录代替停止证明。

## 3. 运行三轮纯客户端

在私有编辑器中保存绝对路径的配置 JSON。文件须 owned `0600`、直接父目录 `0700`，全路径无 symlink；真实 key 只存在于这份受保护输入配置，不进入 argv、结果 JSON 或 stdout/stderr。

```json
{
  "BASE_URL": "http://127.0.0.1:REPLACE_ROUTER_PORT",
  "SERVICE_API_KEY": "<REPLACE_RUNTIME_SERVICE_KEY>",
  "USER_ID": "http_demo_user",
  "AGENT_ID": "agt_REPLACE_EXISTING_ID",
  "AGENT_VERSION": "1",
  "MODEL_CALL_ACK": "allow-model-calls-v1",
  "REQUEST_TIMEOUT_MS": "30000",
  "OPERATION_TIMEOUT_MS": "120000"
}
```

这是闭合的八个字符串字段，不是角色 env JSON；不要加入数据库、admin、provider 或内部凭据。`BASE_URL` 是 router origin，不带 `/v1`、userinfo、query 或 fragment。HTTP 只用于显式端口的 loopback；其它目标使用明确 HTTPS origin，不跟随 redirect。`REQUEST_TIMEOUT_MS` 接受100～120000，`OPERATION_TIMEOUT_MS` 不小于前者且不超过600000。它们限制客户端等待，不改变服务端租约、工具或模型预算；取消后仍等待 DNS/native I/O 结清，不承诺硬期限一到即返回。

`MODEL_CALL_ACK` 只声明操作者允许模型调用，不会鉴别目标是否假厂商，也不构成任意真实模型预算。先核对实际 runner/agent 路由；使用无费用profile时只指向上节owned fixture；真实模型须先另定实际调用预算。

输出必须是 owned 私有父目录下尚不存在的绝对目录。CLI 不加载 `.env`、不启动或停止任何服务、不迁移或授权、不创建 agent/provider，只通过公开 API 消费已经准备好的服务。

```sh
umask 077
node scripts/ops/http-experience.mjs run \
  --config /ABS/private/http-experience.json \
  --output /ABS/private/new-http-experience-output
```

客户端预设三份合成输入：第一轮分析记录并要求缺信息时反问；第二轮提交更新版本、补充并更正；第三轮依据前文做同主题追问。三轮使用同一 `sessionId`、明确的固定 agent/version，各自使用独立稳定的 turn 幂等 key。每次请求前先把对应请求身份和正文保存在私有输出；正文经 `input` 的 text 部分发送，metadata 只保存关联字段，不会自动装配为模型上下文。

客户端固定使用 POST SSE，等待每轮持久 turn 的 `completed` + `end_turn`，再开始下一轮；从 GET turn 和 GET items 读取持久状态及回答。固定成功/失败码可以输出到终端，认证头、key、记录及回答正文不输出。私有输出目录及 JSON 为 `0700` / `0600`，create-only，主要内容如下：

| 文件 | 用途 |
|---|---|
| `run.json` | 非秘密连接/固定版本、配置摘要及本轮身份；不保存 service key。 |
| `session-request.json`、`session-response.json` | 发送前保存的创建正文与已确认 session 身份。 |
| `turn-N-request.json` | 第N轮发送前落盘的 path、完整 body、body摘要及稳定幂等 key。 |
| `turn-N-stream.json`、`turn-N-response.json` | 持久事件，以及 GET turn/items 得到的回答、关联版本和usage；N为1～3。 |
| `turn-1-replay-request.json`、`turn-1-replay-response.json` | 第一次 turn 精确 body/key 重放的请求与原 turn。 |
| `events-response.json` | 三轮完成后，从第一轮终态水位发起新订阅读回后两轮事件；不冒称中途断流的自动恢复。 |
| `result.json` 或失败时的 `failure.json` | 完成摘要，或固定失败码、unknown/停止状态及已知请求身份；失败目录可能只有部分文件。 |

客户端不保存认证头或原始 HTTP headers，并遮掉被响应反射的 service key，包括 JSON 对象键中的反射。它不自动重连 SSE 或重提 POST；中断后交人工核实。现有自动纵向证明见第7节，不扩写为真实厂商账务、模型理解或完整生产验收。

最后一次第一轮的精确 body/key 重放用于核对返回原 turn，不是让模型重新回答。脚本不自动恢复不明请求，不提供新的通用任务队列或持久业务主题映射。

## 4. 用 curl 理解同一 HTTP 合同

以下示例用于人工逐步观察，不能与自动客户端并行消费同一个三响应 fixture。每一套体验使用新的 fixture 和输出目录。所有路径均替换为真实私有绝对路径，父目录先人工准备为 `0700`，文件使用 `0600`，不覆盖已有输出。

在私有编辑器中建立 `/ABS/private/http-auth.curl.conf`：

```text
header = "Authorization: Bearer <REPLACE_RUNTIME_SERVICE_KEY>"
header = "X-User-Id: http_demo_user"
noproxy = "*"
silent
show-error
connect-timeout = 5
max-time = 30
```

这是含秘密的私有输入文件，不提交或分享。不要改成 `curl -H "Authorization: Bearer ..."`、命令替换读取 key、`--verbose`、trace 或 `set -x`。下列 curl 用 `--disable` 禁用隐式 `.curlrc`，`noproxy` 禁用环境代理，不使用 `--location`；响应正文和 headers 保存到私有文件，终端只显示 HTTP 状态码。配置中的 bearer 不会出现在 argv。人工 curl 会覆盖同名输出，须先确认下面输出文件不存在，不重复粘贴同一命令；自动客户端另有 create-only 输出约束。

用私有编辑器准备 `/ABS/private/create-session.json`，只放非秘密业务输入：

```json
{
  "agentId": "agt_REPLACE_EXISTING_ID",
  "agentVersion": 1,
  "title": "HTTP 三轮体验",
  "metadata": { "experience": "http-three-turns-v1", "topicId": "topic-demo" }
}
```

在设定 `umask 077` 的 shell 中执行一次，输出文件事先必须不存在：

```sh
curl --disable --config /ABS/private/http-auth.curl.conf \
  --request POST --url http://127.0.0.1:REPLACE_ROUTER_PORT/v1/sessions \
  --header 'Content-Type: application/json' \
  --data-binary @/ABS/private/create-session.json \
  --output /ABS/private/session-create.response.json \
  --dump-header /ABS/private/session-create.response.headers \
  --write-out '%{http_code}\n'
```

`201` 后从私有响应读取 `id`，将其作为下面所有 `<SESSION_ID>`。创建 session 不提供 turn 那种幂等保证；如果连接断开或响应不明，先人工核实已建资源，不盲目重发或换 session 重建。

第一轮私有 `/ABS/private/turn-1.json` 示例：

```json
{
  "input": [
    { "type": "text", "text": "记录ID=record-demo，版本=1。项目代号青禾，周五提交。请分析；缺少交付形式时先问我，不要猜测。" }
  ],
  "stream": false,
  "metadata": { "topicId": "topic-demo", "recordId": "record-demo", "recordVersion": 1 }
}
```

```sh
curl --disable --config /ABS/private/http-auth.curl.conf \
  --request POST --url 'http://127.0.0.1:REPLACE_ROUTER_PORT/v1/sessions/<SESSION_ID>/turns' \
  --header 'Content-Type: application/json' \
  --header 'Idempotency-Key: http-demo-run-REPLACE_UNIQUE-turn-1' \
  --data-binary @/ABS/private/turn-1.json \
  --output /ABS/private/turn-1.accepted.json \
  --dump-header /ABS/private/turn-1.accepted.headers \
  --write-out '%{http_code}\n'
```

新的非流式 turn 返回 `202`，响应内 `turn.id` 是后续读取对象；`202` 只代表已接受，不能当作分析成功。使用同一鉴权读取 `GET /v1/sessions/<SESSION_ID>/turns/<TURN_ID>`，直到得到持久终态。`completed` 仍须结合 `stopReason`，本体验只把 `end_turn` 当自然完成；`failed`、`interrupted` 或预算上限不能当作完整回答。

需要实时事件时，可以使用单独的订阅，持续保存到私有文件：

```sh
curl --disable --config /ABS/private/http-auth.curl.conf --no-buffer \
  --url 'http://127.0.0.1:REPLACE_ROUTER_PORT/v1/sessions/<SESSION_ID>/events?after=0' \
  --header 'Accept: text/event-stream' \
  --output /ABS/private/session.events.sse \
  --dump-header /ABS/private/session.events.headers \
  --write-out '%{http_code}\n'
```

SSE 的连接结束、HTTP 200、最后一个 delta 都不是持久 turn 终态。只按本 turn 的 `turn/completed` 及其 turn 状态判断；最终内容从持久 assistant item 读取，不能用不持久 delta 拼出的文本替代。重连时用已消费的持久 `seq` 作为 `after`，delta、progress、heartbeat 没有持久 seq。curl 的30秒等待到期只结束这个客户端连接，不证明 turn 已停止；仍应查询原 turn，必要时由实际 owner 显式调用 interrupt 并观察终态。

第二轮在同一 session 发送新的 text：`记录ID=record-demo，版本=2。代号更正为青禾二期，日期仍为周五。补充：按列表交付，请按更正继续。`；第三轮再问：`依据前文，最终项目代号、日期和交付形式是什么？`。每轮使用新的请求文件、独立的稳定幂等 key 和新的输出文件，依次等待前轮自然完成。metadata 可关联 record/version，但更正正文仍须写进 input；更正不会自动删除旧历史或使摘要和其它副本失效。

## 5. 失败、精确重试与人工核实

| 观察 | 正确处理 |
|---|---|
| `202` 或仍为 `inProgress` | 继续读取原 turn/事件，不另发下一轮。 |
| 精确 key 重放返回 `200` JSON | 核对同一个turn；它可能仍为`inProgress`，JSON只确认重放身份，不证明完成。继续读取原turn直到持久终态，不能只按SSE格式解析。 |
| 同 key、不同正文 | 视为幂等冲突，保留原请求；不要换 key 掩盖。 |
| `session_busy`、draining、quota 或鉴权拒绝 | 保留固定状态和错误码，核对原 session 与配置；客户端不改权限、自动排队或切模型。 |
| 请求响应不明、SSE 提前断开、费用或副作用 unknown | 停止自动派发，保留私有请求及已知 session/turn/key，人工只读核实；不自动新建 session、换 key 或重试付费/工具动作。 |
| 需要人工重发已确认的 turn 请求 | 同 session、同实际 user、同 agent/version、同 body 和同 `Idempotency-Key`；不从改写后的文件补造“相同请求”。 |

如固定 agent 挂载了工具，审批是独立资源，不能因 HTTP 体验、skill 文本或 observer ACK 自动接受。应由实际 owner 读取审批和可用决策，明确决定后再等待终态。本文首轮固定 agent 不挂工具，脚本不实现自动审批。

客户端失败或退出不证明服务器 turn 已取消、上游免费或数据库未提交。输出目录中若已有 unknown 状态，先核实再决定下一步，不删目录重跑。输出中含 session、合成正文、回答或关联信息，仍按私有资料保存；不上传整份目录当作公开问题描述。

## 6. 改用真实模型及未来 App 后端

真实模型需要明确选择provider/model、真实endpoint与密钥、价格/usage口径及调用预算，再由授权管理流程配置runner/agent。`allow-model-calls-v1`、有限客户端等待或本地假厂商成功不能代替该预算，也不提供厂商账单或总金额硬限。不要仅为运行示例而接入未知真实路由。

真实 App 后端继续使用相同的 service key + 实际用户鉴权、固定 agent/version、session/turn、SSE及幂等合同。App负责在调用前验证用户与记录权限，把授权记录的具体版本正文放入 input，持久保存业务 topic→session 映射及结果关联；metadata 只用于关联。终端始终不接触 service key。

跨设备映射 CAS、业务记录删除/撤权后的历史与摘要失效、跨 session 检索、长期回调和完整生命周期不由这份三轮体验补齐。需要业务参考时查看[记录助手 SDK 样例](../../examples/record-assistant/README.md)，其内存 App fixture也不等于真实业务仓储。

## 7. 验收与本机环境分别管理

公开HTTP的具名验收覆盖同session三轮、精确body/key重放、异user隔离及停服后受限冷读持久内容；发布CI和字节审计只证明对应版本及范围。有限fixture不证明真实模型理解、回答质量、厂商计费、生产容量或恢复能力；客户端要求`completed/end_turn`，不能把`completed/max_steps`当成该自然完成条件。

已有本机环境使用其独立私有交接与OWNER生命周期入口；先核实际活体、加载版本和数据身份，再执行授权操作。旧端口/历史PID不作当前状态证明。保留原DB/master/Redis namespace/稳定Blob路径，不自动初始化、迁移、升级、重置key或重新创建fixture。`client.json`供体验CLI读取，curl使用独立auth配置，两者不能混用。

手动用户日常调用与助手验收额度分开。当前助手四次真实调用额度已用尽；未经新的具名provider/turn/step/工具/重试预算，不运行三轮CLI或POST turn。只读状态与文档核对不需要付费前置。具体A/B/C身份见 [PROGRESS](../PROGRESS.md)，旧57819环境及完整首包过程见 [原HTTP手册快照](../history/2026-10-25/docs/operations/http-experience.md)，其中本机地址不是通用安装步骤。
