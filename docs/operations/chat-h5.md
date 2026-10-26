# 本地 H5：从部署到手动聊天

这个工具供本机操作者模拟 App，发送自定义文本、实时查看流式分片、在同一会话继续追问，并核对服务已经持久化的回答。它由一个本机 Node 代理和 H5 页面组成：浏览器只访问代理，代理用私有 runtime 配置调用 agent-router，service key 不进入网页。它是独立开发测试工具，不进入既有两个长期服务、六个产品 JS 入口和两个 OCI 镜像，也不自动部署或升级服务。

已有正式本地 A 时，先走第 1 节，再启动第 4 节的页面。要亲自从零准备另一套环境，走第 2 节；Linux 生产部署见第 3 节。当前 A/B/C 版本与验收范围只看 [PROGRESS](../PROGRESS.md)。

## 1. 最快使用：复用正式本地 A

本机正式 A 已恢复由新的独立本机 OWNER overlay 管理。当前管理入口、实际选定配置与验收状态以 [PROGRESS](../PROGRESS.md) 和[新私有用户交接页](../../.local-run/environment-control-20261026-v1/USER-HANDOFF.md)为准；私有链接只在保留此环境的本机可用。先按新交接页核对当前 OWNER 活体、已接受应用字节与数据身份，再查看第 4 节的环境面板。服务已正常运行时直接使用，不为打开 H5 重启服务。

旧 OWNER 的 sealed、current、report、lock 和[原交接页](../../.local-run/accepted-local-http/USER-HANDOFF.md)原位保留，作为原环境的证据；不要再照旧手册执行 `start` 或 `restart`，也不删除旧 lock 来恢复管理。新 overlay 复用既有应用与数据配置，不代表更换应用版本或新的 binary 验收。

OWNER 独立于 H5 代理运行；按新交接页连接该管理器后，可通过环境面板进行受控启停。不要把通用 `local-service.sh start/down` 用到 A，不依据旧 PID 操作。OWNER 或组件返回 `unknown`、操作结果不明或出现失败保留状态时，保留现场，先核实原操作；不能把 `/readyz` 成功当作可直接接管或重启的依据。

H5 的 `--config` 使用新交接页选定的原私有 runtime client JSON；无需复制或修改旧 sealed 文件。下文 `/ABS/private/client.json` 和 `/ABS/private/control.json` 都是绝对路径占位，分别替换为 runtime client 与新 OWNER 的私有连接配置。不要把独立 curl auth 配置传给 H5，也不要把 client JSON 当作 curl 配置。

这条路径沿用 A 的实际 provider/model、固定 agent/version、数据库、master、Redis namespace 和稳定 Blob 目录。它不执行初始化、迁移、密钥轮换、应用升级或 fixture 重建。B 通用部署包的验收不表示 A 已加载 B；旧端口环境也不作为 A 的替代入口。

## 2. 从源码部署一套全新独立本地环境

本节用于新的、明确独占的资源，不用于重新初始化 A 或已有业务库。完整权限、SQL、停止窗口、失败保留及确认步骤以[初始化手册](schema-bootstrap.md)为准；这里列操作顺序，不提供可直接粘贴到未知数据库的 DDL。

1. 使用 [`.node-version`](../../.node-version) 固定的 Node 24 和 [`package.json`](../../package.json) 固定的 pnpm。进入源码目录后安装已锁定依赖：

   ```sh
   pnpm install --frozen-lockfile
   ```

2. 按[隔离与身份准备](schema-bootstrap.md#1-先隔离再放入凭据)人工准备独占 MySQL、Redis、显式 loopback 端口和唯一 namespace，核真实实例归属、数据库及 Redis DB。准备受保护私有配置目录和稳定 Blob 目录；不要使用共享开发库或仅凭默认端口认领实例。
3. 按[独立 schema 流程](schema-bootstrap.md#3-人工新建-app--停服-ack--migrate)依次完成：人工 app 库 → 全 writer 实际停服排空 → 独立 `schema migrate` → 人工 metadata schema、locked definer 和 runtime 逐表最小 ACL → `schema install-metadata` → 人工授予 exact procedure `EXECUTE` → operator `schema verify`。各身份使用各自配置，普通 runner 不拿 operator DSN，也不自动迁移或补授权。
4. 按[0066 authority 初始绑定](schema-bootstrap.md#55-0066-单一-mysql-authority独立停止窗口与固定初始绑定)，使用固定 command 完成 `preflight`、`activate` 和同 command 实际结果确认。新库也要核真实 inventory。已有 binding 或业务数据时不能照抄空库 initial 来源；结果不明时保留 command 和现场。
5. 按[唯一 first-admin 引导](schema-bootstrap.md#6-受限-runtime-冷启动与唯一-first-admin)只启动一个受控 runner，核真实管理员鉴权，再停止并等待实际退出。从后续普通配置移除全部 `ADMIN_BOOTSTRAP_*`。first-admin 文件是一行 key，不是 JSON；失败或结果不明时保留文件，不覆盖重造。
6. 选定 runner 的实际模型配置，准备两份受保护角色 JSON，再按[external-infra 前台模式](schema-bootstrap.md#7-显式-external-infra-前台运行)启动正常双角色：

   ```sh
   scripts/local-service.sh --external-infra run \
     --runner-env /ABS/private/runner.env.json \
     --router-env /ABS/private/router.env.json \
     --state-dir /ABS/private/new-runtime-state
   ```

   配置文件 owned `0600`，直接父目录 owned `0700`，全路径无 symlink。state 必须尚不存在；后继启动换新 state，但保持同一 DB、master、Redis DB/prefix/namespace 和稳定 `BLOB_DIR`。前台 Ctrl-C/TERM 只收回本次应用 child，等待实际退出，保留外部基础设施和数据；不使用默认 `down`。
7. 在另一终端分别检查本轮 runner/router 的 `/readyz`；全部公开业务 API 发给 router。ready 只说明启动检查结果，接着仍要核业务鉴权与读写。
8. 按 [HTTP 手册的管理员一次性准备](http-experience.md#管理员一次性准备)建立并核验 agent 的明确 `id/version/model`，为日常体验创建仅有 `runtime` scope 的 service key。建议选择无工具、无 MCP、无 skills 和其它扩展的 agent；H5 不处理工具审批。first-admin key 只做管理，不放进日常 client 配置。
9. 准备第 4 节的 client JSON，启动 H5 并手动发送第一条消息。

### 使用真实模型和现有 `.env`

真实模型由 runner/agent 决定，H5 不直接调用厂商，也不读取项目 `.env`。有已授权的 `.env` 时，可以在私有编辑器中核对并按需把以下四项复制到**新环境 runner** 的受保护配置；不要打印、提交、放进 argv 或传给 router/网页：

| runner 配置 | 作用 |
|---|---|
| `API_KEY` | 实际厂商凭据 |
| `API_BASE_URL` | 已核验的厂商兼容 API 地址 |
| `DEFAULT_MODEL` | 实际可用模型名称 |
| `PLATFORM_PROVIDER` | 对应的 provider 路由 |

external-infra 在加载项目 `.env` 之前分流，不从 ambient env 补角色凭据；只修改 `.env` 不会改变这条启动路径。角色 JSON 是闭合字符串 map，不能把整份 `.env` 或 shell 格式直接塞进去。固定 agent/version 的 `model` 也须与所选路由一致，不能仅凭模型名称判断实际厂商。详见[运行配置](local-and-deployment.md#环境配置原则)与 [HTTP 真实模型说明](http-experience.md#6-改用真实模型及未来-app-后端)。

复用 A 时保留 A 的既有配置；改变其 provider、release 或数据身份属于另一次受控变更。若只想先熟悉部署和页面，可在新环境使用 [HTTP 手册的有限假厂商](http-experience.md#2-使用无费用的本地假厂商可选)，不要把它的确定性回复当成真实模型质量。

## 3. Linux 生产部署入口

Linux 主机上的完整操作使用[首个 production HTTP 部署手册](initial-production.md)：验真匹配目标 OS/CPU 的 runner/router 制品及独立可信摘要 → 固定非 root 账号和 release/state 目录 → 独立 schema/authority → first-admin → 普通 runner → 核真实 Gateway policy → router → TLS 反代、限流和受保护指标 → 实际业务与停启验收。目标机器不要重新 `pnpm install`，不要把 CI 临时签名当生产信任根。

H5 保持在操作者本机运行，消费已授权的 router origin；它不安装 systemd、数据库、Redis、TLS 或反代，不作为生产网页发布。当前实际生产验收仍以 PROGRESS 的 C 状态为准。

## 4. 启动本地 H5

使用同一套 Node 24 和项目依赖。在源码目录的另一个终端运行：

```sh
pnpm experience:h5 --config /ABS/private/client.json --port 58655
```

连接已按所属环境交接页启动的独立 OWNER 时，显式增加管理连接配置：

```sh
pnpm experience:h5 --config /ABS/private/client.json \
  --control-config /ABS/private/control.json --port 58655
```

`--control-config` 与八字段 runtime client 分开保存，只由本机代理读取，不通过网页提交路径、进程号或凭据。启动 H5 只连接明确绑定的 OWNER，不自动启动组件、接管未知进程或恢复未完成操作；OWNER daemon 的准备和启动按所属环境的新私有交接页执行。未配置管理连接时，环境面板显示“未连接本机管理器”，聊天仍按原 client 配置使用。

保持进程前台运行，在本机浏览器打开它显示的 `http://127.0.0.1:58655`。端口被占用时显式选另一个空闲端口，不停止未知进程。工具只监听 `127.0.0.1`，不支持 LAN、手机远程访问或公网部署；不要通过端口转发或修改监听地址公开它。

client JSON 复用[三轮 HTTP 客户端配置](http-experience.md#3-运行三轮纯客户端)的八个字符串字段：

```json
{
  "BASE_URL": "http://127.0.0.1:REPLACE_ROUTER_PORT",
  "SERVICE_API_KEY": "<REPLACE_RUNTIME_SERVICE_KEY>",
  "USER_ID": "h5_demo_user",
  "AGENT_ID": "agt_REPLACE_EXISTING_ID",
  "AGENT_VERSION": "1",
  "MODEL_CALL_ACK": "allow-model-calls-v1",
  "REQUEST_TIMEOUT_MS": "30000",
  "OPERATION_TIMEOUT_MS": "120000"
}
```

文件须 owned `0600`、直接父目录 owned `0700`、绝对路径且无 symlink。`BASE_URL` 是 router origin，不带 `/v1`、userinfo、query 或 fragment；HTTP 仅允许显式端口的 loopback，其它目标使用明确 HTTPS。所有字段名、格式与期限约束见 HTTP 手册。`SERVICE_API_KEY` 是仅有 runtime scope 的真实 bearer，不是 keyId 标签；`USER_ID` 和 agent/version 固定在服务端，不能由网页切换。

这份 JSON 不包含 provider key、数据库、master、admin 或 internal token。代理在服务端注入鉴权，网页不读取/编辑凭据。它仅面向本机可信操作者，不代替真实 App 的用户登录和权限验证。

### 本地环境面板与安全启停

聊天配置下方的“本地环境”默认收起，只显示环境概况和检查时间。点击展开浮层，可查看 OWNER、Router、Runner、MySQL、Redis 五个组件的状态和最近操作；浮层内部滚动，收起后继续使用原聊天区域。面板首次读取一次状态，展开时每 5 秒刷新，收起后可手动点击刷新。

面板只提供六项固定动作，按钮是否可用以管理器本次返回的 capability 为准：

| 分组 | 动作 |
|---|---|
| 应用服务 | 启动服务、停止服务、重启服务 |
| 数据库与缓存 | 启动数据库、停止数据库、重启数据库，均对应已绑定的 MySQL 与 Redis |

停止、重启需要在面板内确认。先等待当前 turn 完成并核对持久结果；管理器无法确认任务空闲、组件身份或操作结果时，会拒绝新的启停，不自动中断聊天任务。服务写入与管理动作互斥；动作进行中或结果不明时按钮保持锁定，页面不会重复执行。

完整停启顺序为：

1. 记录当前 session ID，等待执行结束；点击“停止服务”，确认 Router 和 Runner 均为已停止。
2. 需要停止依赖时，再点击“停止数据库”，确认 MySQL 和 Redis 均为已停止。
3. 点击“启动数据库”，等待依赖就绪，再点击“启动服务”，等待 Router 和 Runner 就绪。
4. 返回原会话，只读核对已有消息；不必为验证恢复而再次调用模型。

“重启数据库”同样要求应用服务已经停止；它不会替你停止 Router/Runner。只重启应用时使用“重启服务”，无需停止数据库。全部动作保留既有数据库、Redis 数据、稳定 Blob 路径、密钥和数据配置；不执行初始化、迁移、reset、清库或环境重建。

每次主动操作生成独立幂等 UUID，并以同一 UUID 关联操作记录。操作串行执行；提交超时或结果不明时，保留当前页面和现场，通过状态读取核对原操作，不自动换 key、重试或继续未完成动作。失败原因会保留到下一次主动管理动作。OWNER 重启也不会自动恢复未知操作，须按私有交接页核实并人工处理。

管理器独立于网页代理运行。关闭 H5、浏览器标签页或对 H5 使用 Ctrl-C，都不会自动停止 OWNER、应用服务、数据库或已经派发的 turn。对 OWNER 自身的停止和恢复仍按新交接页执行。

## 5. 手动体验一遍

1. 打开页面，确认所连服务和固定 agent/version。读取会话列表并选择已有会话，或点击新建会话；创建会话和读取历史不调用模型。
2. 在输入框发送下面的第一轮文本。发送动作会向配置的真实 provider 派发 turn，可能收费；页面启动、刷新和历史读取不会主动提交 turn。
3. 观察 turn 状态和逐片出现的回答。页面以 `stream:true` 提交，通过 SSE 实时追加 `item/agentMessage/delta`，把临时内容标成“流式片段 · 待持久核对”。分片大小由模型/provider 和传输决定，不保证每片恰好一个 token。最终消息快照替换临时文本，并用 GET turn/items 与会话 idle 核实收尾；`completed` 仍须结合 `stopReason`。`end_turn` 表示自然结束，`max_steps` 等预算终态需要单独判断。
4. 前一轮结束并确认会话 idle 后，在**同一个会话**继续第二、第三轮，核对更正是否进入最终回答。
5. 刷新页面，从列表重新选择该会话，核消息与回答仍能读回。可切换另一会话再返回，确认不同会话的上下文和展示没有混合。
6. 需要停止正在执行的 turn 时点击停止，继续观察原 turn 的持久状态。停止请求发出、浏览器断连或关闭标签页，都不能单独证明服务端已经停止。

建议的三轮输入：

| 轮次 | 输入 |
|---|---|
| 1：分析并反问 | `项目代号青禾，周五提交。请分析；缺少交付形式时先问我，不要猜测。` |
| 2：补充并更正 | `代号更正为青禾二期，日期仍为周五。补充：按列表交付，请按更正继续。` |
| 3：依据上下文追问 | `依据前文，最终项目代号、日期和交付形式是什么？` |

正文进入 `input` 才是模型可见输入；metadata 只是关联，不自动成为上下文。更正保留旧历史，不会自动删除旧正文或使摘要和其它副本失效。回答质量由人工评估，不能由状态码或文字出现某个关键词代替。

H5 对每次新 turn 使用固定上限：最多 6 steps、1 tool call、60000ms wall clock、每 step 最多 1024 output tokens。这些请求参数只进一步收紧 agent/server 的有效限制，不能保证实际允许值就是上述数字，也不是总 token、金额或厂商账单硬限。请选无工具 agent；请求上限不会移除 agent 已有的工具权限。

### 刷新、重启与未知结果

最终回答以服务端持久 items 为准，临时 delta 不作为完成或成功证据。发送中刷新、超时或网络异常时，不应把输入当成“未发送”；保留原 session/turn 和幂等 key，只读查询原结果。页面对结果不明的提交保留 key 并停止自动派发，不自动换 key、创建新会话或重发 POST。原 key 与原 body 的精确重放合同见 [HTTP 失败处理](http-experience.md#5-失败精确重试与人工核实)。

刷新或断流后，页面先只读核对原 turn；结果不明时仅按 exact 幂等键找回匹配执行，再用 `GET /events?after=<持久 event.seq>` 恢复观察。每次选择会话/新发送最多自动尝试两次只读订阅，失败后继续轮询，不重新提交 turn。delta 没有持久 seq，断开期间的分片不能重放，最终通过消息快照恢复完整内容；不会拿继承的 SSE id 或 `item.seq` 充当新的事件游标。

“流式连接已断开”只表示观察断开；SSE EOF 不表示执行完成，也不自动停止模型。切会话或关闭页面会收回当前订阅，服务端 turn 仍可能运行。停止执行仍需显式 interrupt，并核对终态。代理使用配置的请求等待期限和流式操作期限，单帧/整流也有读取预算；这些是客户端观察边界，不扩大服务端执行或费用上限。精确幂等重放即使请求流式，也可返回原 turn 的 JSON，页面会转为只读核实。

原聊天请求、幂等键、草稿和当前会话 ID 保存在本标签页的 `sessionStorage`，可能含聊天内容；不要在共享浏览器中使用。刷新页面保留这些记录，关闭标签页或清除站点存储可能丢失本地对账线索，服务端历史仍需按原 session ID 读取。代理明确返回 `turn_not_submitted`，或因维护/环境状态返回 `503 environment_not_ready`，都表示提交前检查已失败、尚未派发 turn：页面保留草稿，允许服务恢复并刷新确认后由你手动发送，不自动重发。已经派发的超时或失败不会用这些错误码解锁。

维护拒绝只关闭新建会话和新 turn 的写入入口。历史读取、只读 SSE 订阅和 interrupt 不因管理器故障被本机代理阻断；它们仍取决于 Router 和所属环境是否实际可访问，不能保证已停止的服务继续响应。

要体验服务重启后的持久性，先等待当前 turn 和连接正常结清，记录所选 session ID，再通过第 4 节的环境面板停止应用并确认实际退出；按对应顺序重新启动，保持原 DB/master/Redis namespace/稳定 Blob 路径。重新打开 H5 并选择原会话，只读核对已有消息即可，无需再发一次模型请求。A 使用新独立 OWNER overlay；没有接入管理器的新 external-infra 环境仍使用其前台 supervisor 和新 state，不重新初始化或更换数据目录。

停止 H5 时 Ctrl-C 并等待进程退出。停止网页代理不等于停止独立 OWNER、agent-service、MySQL、Redis 或已派发的 turn。

## 6. 诊断与验证范围

| 现象 | 先做什么 |
|---|---|
| 页面连不上 | 核 H5 前台进程和本次监听端口，再检查所属环境 OWNER 或 runner/router `/readyz`；不因此重新初始化。 |
| 鉴权拒绝或会话不可见 | 核服务端私有 client 的 runtime scope、固定 USER_ID、tenant 与 agent/version，不在浏览器粘贴 key 或切换成 admin。 |
| `session_busy` | 读取原 turn 与 session 状态，等待原 turn 结清；不循环发送。 |
| `503 environment_not_ready` | 本次新会话或 turn 尚未提交；保留草稿，在环境面板核对管理操作和组件状态，恢复就绪后手动发送。 |
| 环境操作 busy、unknown 或失败 | 保留当前页面、原操作 UUID 与现场；读取最近操作和五个组件状态，按新交接页核实，不删除旧 lock、不重复启停。 |
| `completed/max_steps` | 保留此终态，读取同 turn 的持久 agentMessage、usage、错误及已有配置。它表示步骤预算结束，不能自动当自然回答成功；检查无需新增模型调用。确要改 limits/agent 或重问时，作为新的显式付费操作决定。 |
| `failed`、`interrupted`、quota、超时或 unknown | 保留原 session/turn/key，继续只读核实。断连不证明未提交、免费或无副作用；不自动重发、切模型或扩大期限。 |
| 有状态但没有最终回答 | 从原 turn 的持久 items 核对 completed agentMessage，满页继续分页；不把临时文本或空结果发布成成功。 |

自动集成测试入口为：

```sh
pnpm test:chat-h5
```

该入口覆盖本地工具的假后端 HTTP/SSE、维护互斥和 native 管理边界检查，不使用真实模型。真实环境的冷启与历史读回也无需派发模型请求；其实际执行范围、浏览器观察和结果统一记录在 [PROGRESS](../PROGRESS.md)，本页不以测试文件存在代替通过。健康与历史读回只证明当次验证范围，不证明新 turn、模型质量或厂商账单。

本轮工具建设和自动验证不增加付费请求；既有助手真实模型验收额度 4/4 已耗尽的身份保持。用户在页面手动点击产生的日常调用与该助手额度分开；助手后续自动发送真实 turn、step、工具或重试仍需新的具名预算。`allow-model-calls-v1` 只是配置 ACK，不提供任意费用授权。完整 e2e、服务重启、真实厂商与 Linux 目标验收分别记录，不把假后端成功扩写为全部通过。
