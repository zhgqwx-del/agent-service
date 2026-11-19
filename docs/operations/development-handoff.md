# 换电脑继续开发

从 GitHub clone 工作分支，再用 Codex 打开仓库根目录，即可继续源码或文档工作。需要运行 HTTP/SSE 或 H5 时，可以连接获准使用的已有服务，或在新电脑上初始化独占实例。已有会话数据的迁移需要单独安排。

## Git 和 Codex 交接

```sh
git clone https://github.com/zhgqwx-del/agent-service.git
cd agent-service
git status --short --branch --untracked-files=all
git rev-parse HEAD
```

如果续接的任务在其他分支，切换到该分支并对照交接记录中的 commit SHA。换机前检查旧电脑各 worktree 的未推送提交、已暂存和未暂存改动，以及未跟踪文件。经授权推送工作分支，或通过受保护渠道交接审过的补丁及所需文件。

在 Codex 中从仓库根目录开新聊天。项目规则随根目录的 `AGENTS.md` 获取。先读 [协作约定](../../AGENTS.md)、[README](../../README.md)、[PROGRESS](../PROGRESS.md) 开头与末节，再按[文档地图](../README.md)进入相关专题。A 原主机正式本地环境、B 通用部署包、C 目标生产和 N 独立本机体验各有自己的版本与验收范围。历史段的状态按记录日期理解，当前 Git checkout 以实际命令结果为准。

Codex 本地记忆和个人设置位于各自的 Codex 主机，Git clone 不会带上。项目约定放在版本化文档里。若任务尚未收尾，留一段无密钥摘要，写明任务目标、分支和 commit SHA、已有改动及位置、已跑验证与原失败、下一步和当前授权。个人指令或工具配置仅在确有需要时审阅后逐项配置。无需复制 `~/.codex` 或旧聊天记录。[Codex 项目指令](https://learn.chatgpt.com/docs/agent-configuration/agents-md)、[Codex 本地记忆](https://learn.chatgpt.com/docs/customization/memories)

## 本机配置、证据和数据

| 项目 | 新电脑如何处理 |
| --- | --- |
| Node、pnpm、依赖及构建产物 | 按仓库锁定版本安装依赖。按目标 OS/CPU 重新构建，或通过可信渠道取得匹配制品并核摘要。`node_modules/`、`dist/` 和 coverage 可重建。 |
| `.env`、角色 env、DB/operator 凭据、master/internal token、管理员及 runtime key | 通过密码管理器等受保护渠道按用途配置。新独占实例生成自己的账号与密钥。实际角色 JSON、schema/first-admin 输入、runtime `client.json`、curl auth 和 OWNER control 分开保存。Git 只保留[无秘密的模板](../../deploy/local/examples)。 |
| `.local-run/`、OWNER、launch/current、boot 登记、锁、PID、私有初始化脚本及验收原件 | 原机保留。新机为自己的资源生成新记录。若缺原 `ACTIVE-ROOT-LATEST.json`，记录“新主机未持有原本机证据”，原验收保持未独立复核，继续独立源码工作。若有权威原件，按 [AGENTS](../../AGENTS.md) 校验 ACTIVE 绑定的 checkpoint、acceptance、handoff 的 SHA 与字节数。 |
| 旧会话、turn、事件和 Blob，Redis 协调状态，H5 标签页草稿 | clone 后不会出现。独立开发从新数据开始。确需保留旧业务数据时，先按[数据生命周期](../design/04-data-lifecycle.md)和[受控手工 R1](initial-production.md#8-受控手工单次-r1-恢复)评估并另行授权。旧 turn 结果不明时在原环境只读核对原请求，避免重发。 |

## 源码和定向验证

仅阅读或编辑文档可直接开始。运行代码、类型检查或定向测试前，按 [`.node-version`](../../.node-version) 安装 Node `24.21.0`，按 [`package.json`](../../package.json) 安装 `pnpm@12.5.1`，确认版本后安装依赖。

```sh
node --version
pnpm --version
pnpm install --frozen-lockfile
```

代码改动按[开发与 CI 指南](development-and-ci-guide.md)选择 `pnpm typecheck` 和受影响的定向验证。需要真实 MySQL、Redis 或 S3 的用例使用独占测试资源。纯文档做 diff、链接、锚点和命令的静态核查。

## 首次初始化独占 HTTP/H5 环境

1. **准备本机资源。** 配置 MySQL 8 和经验证的 Redis，选择空闲 loopback 端口、独立 Redis DB/prefix/namespace、稳定的 Blob 目录及独立密钥。核实实例归属和真实数据路径。私有配置使用绝对路径，全路径无 symlink，目录 `0700`、文件 `0600`。按[初始化手册](schema-bootstrap.md)操作。
2. **预置数据库和身份。** 人工创建新 app 库，核实所有 writer 已停并排空，再执行独立 `schema migrate`。准备 metadata schema、locked definer 与 runtime 逐表最小权限，依次完成 `schema install-metadata`、精确的 procedure `EXECUTE` 授权和 `schema verify`。按手册核真实 inventory，完成 0066 `preflight`、`activate` 和同 command 结果确认。仅启动一个受控 runner 完成 first-admin 并核鉴权，等该进程实际退出后，从常驻配置移除 `ADMIN_BOOTSTRAP_*`。
3. **启动双角色。** 参照模板准备私有 `runner.env.json` 和 `router.env.json`，将下列占位路径换成本机真实路径。`--state-dir` 每次用尚不存在的新目录，复用本实例原 DB、Redis、master 和稳定 Blob 目录。前台 Ctrl-C/TERM 仅收回本次应用进程，外部 MySQL/Redis 按各自归属管理。[external-infra 契约](schema-bootstrap.md#7-显式-external-infra-前台运行)

   ```sh
   scripts/local-service.sh --external-infra run \
     --runner-env /ABS/private/runner.env.json \
     --router-env /ABS/private/router.env.json \
     --state-dir /ABS/private/new-runtime-state
   ```

4. **验证和打开 H5。** 检查两角色 `/readyz`，再按 HTTP 手册经 router 准备固定 agent/version 与 runtime-only service key。用该身份核业务鉴权、创建空会话并用 GET/SSE 读回。填写八字段 `client.json`，将下方示例端口换成本机空闲端口，执行命令后打开实际输出的地址。H5 可以单独运行。[HTTP 管理员准备](http-experience.md#管理员一次性准备)、[H5 启动与 client 格式](chat-h5.md#4-启动本地-h5)

   ```sh
   pnpm experience:h5 --config /ABS/private/client.json --port 18080
   ```

N 首次创建无工具 agent 时，router 在转发前拒绝了 HTTP 示例中的显式空 `mcpRegistrations`。当时先用 GET 确认列表为空，再省略该可选字段完成创建。排查同样的拒绝时，先核对本机配置和实际列表。[N 初始化记录](../PROGRESS.md#new-host-n-initialization)

无费用的模型调用演练，先按[有限本地 fixture](http-experience.md#2-使用无费用的本地假厂商可选)启动假厂商，再把新 runner 和固定 agent/version 明确配置到该 fixture。使用真实厂商时，`API_KEY`、`API_BASE_URL`、`DEFAULT_MODEL`、`PLATFORM_PROVIDER` 仅写入受保护的 runner JSON。`external-infra` 与 H5 不读取仓库根 `.env`。助手既有真实模型额度已用尽，真实 turn、`verify-real`、`acceptance` 和真实三轮 CLI 需要新的具名预算。凭据不进入聊天、命令行、日志或 Git。

### 已登记环境的手动恢复

确需 `pnpm experience:up` 时，另外在该电脑登记真实 OWNER、profile、与目标平台匹配且已验的双角色制品，以及本机 boot 和数据身份。当前 boot 检查有 macOS 和 Linux 实现。首次登记需要本机操作者按真实资源准备。后续恢复时，按 `.local-run/chat-experience/launch.json` 的 `stateDirectory` 找到所选 `current.json`，首次启动前读取该目录的 `registration.json`。结合本机私有交接核实际 OWNER、boot、配置及进程，再按授权启动。原机登记不能用于新机。[H5 恢复说明](chat-h5.md#1-最快使用复用正式本地-a)

## 新电脑发给 Codex 的 prompt

```text
这是我在另一台电脑 clone 的 agent-service。请从仓库根目录接续。我会在下方填入任务，留空时先做只读接续检查。

先查实际分支、HEAD、工作树及已有未提交改动，再读 AGENTS.md、README.md、docs/PROGRESS.md 的开头和末节、docs/README.md，并按任务去读对应专题。以实际 checkout、当前进度和源码为准，把 A/B/C/N 的版本与验收分别对照。历史待办和旧授权按原范围理解。若没有原 ACTIVE，记录“新主机未持有原本机证据”，原验收保持未独立复核，继续源码工作。

只读接续时，请反馈当前分支和 SHA、相关已完成事项、已知阻断及任务的第一步。任务需要运行时，先核 .node-version 与 package.json 的固定版本，按需 pnpm install --frozen-lockfile。全新本地 HTTP/H5 按 docs/operations/schema-bootstrap.md、docs/operations/chat-h5.md 和 docs/operations/http-experience.md。先核本机资源与本次授权。pnpm experience:up 仅用于本机已登记环境。

保留现有改动和安全门禁。凭据不打印、不进 Git。没有本次相应授权时，保持已有环境和数据原状，不执行初始化、迁移、启停、commit/push 或真实模型调用。助手既有真实模型额度已经用尽，无费用体验使用隔离 fixture。

本次任务：[填要继续做什么，或留空]
上一轮未完成事项及本次授权：[有则填分支/SHA、改动位置、已跑验证、已知失败和允许操作的范围。不要粘贴密钥。]
```

需要 Codex 在新电脑搭建体验环境时，可在最后补上下面这段授权。

> 我授权你仅在这台电脑新建并初始化独占的本地 MySQL、Redis、Blob 和开发身份，使用前台 runner/router 与 H5，做无费用 HTTP/SSE 核对。需要模型响应时使用本地 fixture。保持其它环境和数据原状。一键恢复登记另行安排。
