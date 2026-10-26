# 首次人工 schema 预置、管理员引导与隔离启动

本文只面向**新建、可丢弃、由操作者独占的本地 MySQL/Redis 实例**。不是既有业务库升级、生产部署授权或自动建库/授权工具。schema/runtime权限、首次管理员及external-infra接线已有隔离真实MySQL/Redis与发布CI范围验收；当前B包和A/C边界见 [PROGRESS](../PROGRESS.md)。本文人工逐句SQL流程尚未独立演练，目标主机预置/启动仍须实证；自动夹具不等于人工流程或云/生产验收。

全程仍是 router/runner 两服务、六个产品 JavaScript 入口、四个独立维护 CLI、两镜像。`main.js schema ...` 是 runner main 的严格独立命令模式，不是第七入口。产品 main、installer 和 external-infra 都不替人 CREATE DATABASE/USER 或 GRANT；下文 SQL 只能由获准的人工 operator 审阅后执行。

## 1. 先隔离，再放入凭据

- 不使用项目 `.env`、旧 `.env.example` 的 root/3306 快捷配置或共享 Redis。先独立准备本轮实例、显式 loopback 端口/Redis DB 与唯一 namespace，记录真实 server UUID、进程/数据目录和启动来源；不能只凭一个自报 UUID 认领共享实例。
- 连接后核对 `@@server_uuid`、`@@port`、`@@version`、`@@datadir`、`@@pid_file`、`@@socket`、`@@log_bin`、`CURRENT_USER()`、`USER()`。核实无其它应用连接/事务，目标 app/metadata schema 和两个账号均不存在。任何不确定都停止，不 DROP/覆盖既有对象。
- 只使用新、短、ASCII 小写名字；app 与 metadata 必须不同。metadata 名须匹配 `[a-z][a-z0-9_]{0,63}`。账号使用实际传输所需的精确 host，不能把 `localhost`、`127.0.0.1` 和容器来源地址视作相同，也不以 `%` 代替网络设计。
- 配置、SQL 和 MySQL client options 文件放在操作者拥有的真实非 symlink `0700` 目录，文件 `0600`，不提交。密码由密码管理器等受保护通道生成，不放命令行参数、shell 历史、`set -x`、日志或 `GITHUB_ENV`。MySQL client 可使用已审阅的绝对 `--defaults-file=/ABS/private/operator.cnf`（该选项须在最前），不要 `-pPASSWORD`、`MYSQL_PWD` 或在 argv 放 DSN。
- 新模板均有故意无效的 `<REPLACE_...>` 占位，**原样不能启动**。复制到保护目录再编辑；仓库模板的权限不是运行配置的权限。JSON 是字符串 map，不是可插入注释或未知键的任意配置。

模板位于 [deploy/local/examples](../../deploy/local/examples)：`runner.env.json`、`router.env.json`、`schema.env.example`、`first-admin.env.example`。后两份是需人工审阅后 source 的可信 shell 文件，不得把下载的任意 env 当作数据执行。

## 2. 四类身份不可混用

| 身份 | 本流程所需权限/职责 | 不交给长期进程 |
| --- | --- | --- |
| 人工 provisioning/migration operator | 新实例中人工新建 app/schema/账号和授权；执行本 release 包装的迁移 DDL/DML、完整指纹校验与 named lock | operator DSN、密码、`SCHEMA_*`、迁移目录权力 |
| metadata installer operator | 逐 app BASE TABLE 的 SELECT（含 marker）及精确 app schema TRIGGER；metadata schema 的 CREATE ROUTINE；`mysql.user` 的 `User,Host,account_locked` 三列 SELECT；SHOW_ROUTINE；当前 MySQL 8.0 基线指定其它 DEFINER 所需的 SET_USER_ID | 不把这些高权限转给 runtime；不用 ALL/GRANT OPTION 迁就失败 |
| locked definer | 精确 app **schema 范围** TRIGGER，以及安装后对自己那一个 procedure 的 EXECUTE | ACCOUNT LOCK；不另授业务 SELECT/IUD、其它 DDL、角色、PROXY 或 GRANT OPTION |
| runner runtime | 每个实际 app BASE TABLE 的 SELECT/IUD，惟 `schema_migrations` 和三个 authority control/binding 表 **仅 SELECT**；exact procedure EXECUTE；全局 SHOW_ROUTINE 与 USAGE | 无 TRIGGER、库级数据 grant、跨库表/列级 grant、DDL、GRANT OPTION、角色（包括 inactive/mandatory）、PROXY |

runtime 的 `SHOW_ROUTINE ON *.*` 会使其看到**同实例其它 procedure/function 的定义**，不是只看本 metadata schema；这是已接受但部署仍须披露的全局只读范围，不赋予业务行读取或 DDL。不能把 `CURRENT_ROLE()='NONE'` 当成没有角色授权；同时要求实际 `@@GLOBAL.mandatory_roles=''` 和 `@@SESSION.proxy_user IS NULL`。本文不改变任何 GLOBAL 配置。DBA 后续改权/改后复原的 ABA 不由启动检查解决。

installer 会核 locked 账号、固定 routine 正文/属性/零参数，但**不独立证明 definer 的 TRIGGER 授权完整**。这仍是 operator 的责任。只给 definer 当前表逐项 TRIGGER 会漏未来未知表，不能保证完整 trigger 集合。

## 3. 人工新建 app → 停服 ACK → migrate

本文 SQL 中 `<QUOTED_...>`、`<PRIVATE_SQL_PASSWORD_LITERAL>` 都是故意不可直接执行的占位；由操作者按已确认名字逐项替换、引用和审阅。标识符用反引号，名字里的反引号须双写；账号是分别引用的 `'user'@'exact-host'`。不要用 shell 字符串拼接密码或 SQL。

在已确认的本轮新实例中人工执行，不用 `IF NOT EXISTS` 掩盖撞名：

```sql
CREATE DATABASE <QUOTED_NEW_APP_SCHEMA>
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
```

先停止并真实排空**所有** router/runner、后台 worker、旧 binary、其它维护脚本及其连接/事务，只有本次受控前台 operator 操作可连接，覆盖整个迁移与安装窗口。ACK 是人工声明，不是命令自动证明已排空；不能放进普通 start/restart 或 systemd `ExecStartPre`。

在干净 shell 中载入显式 operator 配置。下面所有路径均须替换为实际绝对路径；`NODE` 为 Node 24，`RUNNER_MAIN` 来自同一已验完整发布包（源码开发时仅将调用替换为 `node --import tsx .../src/main.ts`）：

```sh
# 先进入闭合 shell，再读取秘密；env 的 argv 中只有非秘密路径，没有 DSN/密码。
env -i HOME=/ABS/operator-home PATH=/ABS/node24-bin:/usr/bin:/bin /bin/sh
set +x
umask 077
NODE=/ABS/node24-bin/node
RUNNER_MAIN=/ABS/verified-runner-release/dist/main.js
set -a
. /ABS/private/schema.env
set +a
unset SCHEMA_METADATA_SCHEMA SCHEMA_METADATA_DEFINER_USER SCHEMA_METADATA_DEFINER_HOST
"$NODE" "$RUNNER_MAIN" schema migrate
```

`SCHEMA_MYSQL_URL` 必须显式使用 operator 账号并选中刚建的 app 库，无 query/fragment；URL 中密码正确 percent-encode 后只保留在保护文件/子进程环境，不回退 `MYSQL_URL`。migrate/install 要求精确 `SCHEMA_FLEET_STOPPED_ACK=all-application-writers-stopped-v1`。成功只输出 `{"status":"ok","command":"migrate"}`；失败保留目标和记录，由人审计 forward-fix，不自动重试、清库或假称 DDL 回滚。

默认/最高操作预算 `120000ms`，允许 `1000..120000`；named lock 默认 30 秒，允许整数 `0..60`，且不能超过操作预算。取消/到期仍等待原生工作与 socket 关闭，不保证硬期限一到就退出。产品只使用包装在同 release 中的迁移，不接受 argv/环境迁移目录覆盖。

## 4. 人工 metadata schema、账号和最小 ACL

迁移成功且 writer 继续停止后，再人工准备：

```sql
CREATE DATABASE <QUOTED_NEW_METADATA_SCHEMA>
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER <QUOTED_LOCKED_DEFINER_ACCOUNT>
  IDENTIFIED BY <PRIVATE_SQL_PASSWORD_LITERAL> ACCOUNT LOCK;
CREATE USER <QUOTED_RUNTIME_ACCOUNT>
  IDENTIFIED BY <DIFFERENT_PRIVATE_SQL_PASSWORD_LITERAL>;
SELECT @@GLOBAL.partial_revokes, @@GLOBAL.mandatory_roles;
```

不要 SET GLOBAL 来适配本流程。`mandatory_roles` 非空、现有角色/PROXY 或不确定权限来源时停止。新 runtime 应只有预期的 USAGE 起点，再逐项加下面权限；不要对旧高权限账号做“看似减权后复用”。

### definer 的 schema TRIGGER：partial_revokes 必须区别处理

schema 级 grant 中，反引号**不自动消除** `_`/`%` 通配：

- `partial_revokes=0`：先把实际 app 名每个 `_`/`%` 分别变为 `\_`/`\%`，再做反引号引用。
- `partial_revokes=1`：使用实际 app 原名的 literal 标识符，不添加这些反斜杠。
- 授权前后都读取实际 `@@GLOBAL.partial_revokes`，必须一致。转义后的模式仍受 64 字符标识符限制；本文限定 ASCII，因此须在执行前确认**转义后不超过 64 字节**。原 61 字节名可能变 66 字节而报 1059，不能省略转义来绕过。`%` 不可放行到近似库；名字有其它复杂字符时先另行审计，不猜。

installer 的 app-schema TRIGGER、metadata-schema CREATE ROUTINE 也按同一规则分别处理各自 schema 名并检查转义后长度；不能只修 definer 的名字却让维护账号跨库。它们只授维护账号，不授 runtime。

例如实际 app 名为短 ASCII `as_bootstrap_test_a1b2`，只选择与实际模式对应的一行，账号占位仍须替换：

```sql
-- partial_revokes=0：反引号内保留这些反斜杠，精确覆盖该库所有当前/未来表。
GRANT TRIGGER ON `as\_bootstrap\_test\_a1b2`.* TO <QUOTED_LOCKED_DEFINER_ACCOUNT>;
-- partial_revokes=1：literal 原名；不是把两行都执行。
GRANT TRIGGER ON `as_bootstrap_test_a1b2`.* TO <QUOTED_LOCKED_DEFINER_ACCOUNT>;
```

这不给 definer 业务 IUD，但 TRIGGER 权限本身也具有该库 trigger 管理能力，不能谎称账号在权限层面“纯只读”。安全边界还依赖 ACCOUNT LOCK、固定只读 procedure 正文与可信 operator 不解锁/扩权；不得将 definer 解锁用作普通连接。

### runtime：按真实 BASE TABLE 清单逐表授权

通过 operator 选中实际 app，读取完整清单，不从文档复制过期表数，不静态跳过新表：

```sql
SELECT DATABASE() AS actual_app;
SELECT TABLE_NAME FROM information_schema.TABLES
 WHERE BINARY TABLE_SCHEMA=BINARY DATABASE() AND TABLE_TYPE='BASE TABLE'
 ORDER BY BINARY TABLE_NAME;
GRANT SELECT ON <QUOTED_APP_SCHEMA>.`schema_migrations` TO <QUOTED_RUNTIME_ACCOUNT>;
GRANT SELECT ON <QUOTED_APP_SCHEMA>.`session_authority_control` TO <QUOTED_RUNTIME_ACCOUNT>;
GRANT SELECT ON <QUOTED_APP_SCHEMA>.`session_authority_bindings` TO <QUOTED_RUNTIME_ACCOUNT>;
GRANT SELECT ON <QUOTED_APP_SCHEMA>.`session_authority_runtime_accounts` TO <QUOTED_RUNTIME_ACCOUNT>;
-- 对清单中每一个其它 BASE TABLE，人工逐项执行；排除上面四个只读表：
GRANT SELECT, INSERT, UPDATE, DELETE
 ON <QUOTED_APP_SCHEMA>.<QUOTED_ACTUAL_BASE_TABLE> TO <QUOTED_RUNTIME_ACCOUNT>;
GRANT SHOW_ROUTINE ON *.* TO <QUOTED_RUNTIME_ACCOUNT>;
```

不要 `GRANT SELECT/IUD ON app.*`、跨库、列级、ALL、角色或 PROXY。新迁移增加表后必须重新人工核清单并补**精确逐表**权限，runtime 不会自修授权。这里没有自动生成或执行 GRANT 的工具。

## 5. install-metadata → 人工 exact EXECUTE → verify

procedure 名只由**实际连接的 `SELECT DATABASE()` 返回值**决定：原字符串经 UTF-8 编码，SHA-256，取完整 64 位小写十六进制。没有 domain 前缀、截断、大小写归一、trim 或 SQL quoting 后再 hash。profile `schema-trigger-metadata-v1` 是 routine 属性，不是 hash 前缀。固定正文用实际 app 的 UTF-8 hex literal 限定完整 trigger 集合，不用 routine 内的 `DATABASE()`，也不按已知 trigger 名过滤。

可在选中 app 的 operator 连接中只读核对，不复制人为猜测的 hash：

```sql
SELECT DATABASE() AS actual_app,
       HEX(CONVERT(DATABASE() USING utf8mb4)) AS actual_app_utf8_hex,
       LOWER(SHA2(CONVERT(DATABASE() USING utf8mb4),256)) AS exact_procedure_name;
```

回到第 3 节的干净 operator shell，重新载入同一已审文件以获得安装专用三项：

```sh
set -a
. /ABS/private/schema.env
set +a
"$NODE" "$RUNNER_MAIN" schema install-metadata
```

metadata schema 与 locked definer 必须已存在；安装者按第 2 节预置权限。安装持 migration named lock，安装前后验证全部正式 marker/schema/guard；routine 不存在才 CREATE，存在只验真，漂移不 DROP/REPLACE，也不 CALL。创建失联/失败不证明未提交，须保留现场。成功输出 `{"status":"ok","command":"install-metadata"}`。

之后由人工 operator 核实际 routine 的全 64 位名字、精确 schema/definer/零参数，再分别授给 definer **自身**和 runtime：

```sql
GRANT EXECUTE ON PROCEDURE <QUOTED_METADATA_SCHEMA>.<QUOTED_FULL_64_HEX_NAME>
 TO <QUOTED_LOCKED_DEFINER_ACCOUNT>;
GRANT EXECUTE ON PROCEDURE <QUOTED_METADATA_SCHEMA>.<QUOTED_FULL_64_HEX_NAME>
 TO <QUOTED_RUNTIME_ACCOUNT>;
```

最后 operator verify 必须去掉安装专用变量；即使空值也不能保留：

```sh
unset SCHEMA_METADATA_SCHEMA SCHEMA_METADATA_DEFINER_USER SCHEMA_METADATA_DEFINER_HOST
unset SCHEMA_FLEET_STOPPED_ACK
"$NODE" "$RUNNER_MAIN" schema verify
exit
```

`schema verify` 核包装 schema/guard，但**不是 runtime ACL、metadata reader、key/owner/projection 或真实启动证明**。不能将 operator 成功当作 runtime 可用；不要拿 runtime DSN 改称 operator verify，也不把 metadata 三项塞给这个子命令（会拒绝）。

## 5.5. 0066 单一 MySQL authority：独立停止窗口与固定初始绑定

本节是0066初始绑定的操作合同；schema与原生具名验收范围见PROGRESS，目标环境仍须单独验证。迁移本身不激活绑定、不新建账号、不回填旧lease、不删除Redis键。0066普通runner没有inactive/numeric-only/Redis fallback；先完成下面的显式绑定才可启动。Redis仍承担事件/cache等既有用途，不能把Redis重建或`DEL lease/counter`作为新的session ownership决定。

操作者先停止并等待全部旧router/runner、worker、catalog/restore等写入者及事务实际结清，封住自动重启和重连通道。盘点并永久退出全部旧runtime用户名的所有host、角色、PROXY及间接权限；为新binary准备新的runtime用户名，按上文四只读表和其余逐表IUD、metadata EXECUTE/SHOW_ROUTINE闭合授权。仅ACCOUNT LOCK不终止已有连接，人工ACK也不证明已排空。任何旧用户名的实际权限、native连接/事务或完整库存不确定，均停止激活；不要自动KILL/GRANT来迁就preflight。

在独占权限变更窗口内，人工准备owned0700、canonical且无symlink的私有目录和owned0600、单hardlink、UTF-8 fixed JSON文件；总文件不超过65,536B，newAccounts最多64行，仍受总字节上限约束。初始命令固定bindingId/activationId、实际`@@server_uuid`和`DATABASE()`、精确newAccounts、完整oldAccountNames、独立activationEvidenceSha256、expectedBindingId=null、expectedSequence=0、nextEpoch=null，以及实际的当前immutable expectedSource。新建空库的source只能明确为inactive/gen0/其余四字段null；产品仍会原生重验，不把手写JSON当证明。oldAccountNames=[]只接受这种初始inactive且session实际为空的情况，仍不豁免完整fleet停止与独占窗口声明。不可为unknown换ID、刷新source、重做库存或另建command掩盖原结果。

仅对**刚独立初始化、从未运行应用、无旧runtime身份和session、0030 runtime control仍inactive/generation0、0066尚无binding**的真空库，可在私有编辑器保存以下初绑JSON。所有`<REPLACE_...>`是故意无效的占位，须依据本次已核实的原生身份/账号和独立证据替换；不包含DSN、密码、key或SQL，不要原样执行：

```json
{
  "bindingId": "<REPLACE_NEW_BINDING_UUID>",
  "activationId": "<REPLACE_NEW_ACTIVATION_UUID>",
  "expectedBindingId": null,
  "expectedSequence": 0,
  "serverUuid": "<REPLACE_ACTUAL_SERVER_UUID>",
  "applicationDatabase": "<REPLACE_ACTUAL_APP_DATABASE>",
  "newAccounts": [
    {
      "user": "<REPLACE_NEW_RUNTIME_USER>",
      "host": "<REPLACE_EXACT_RUNTIME_HOST>"
    }
  ],
  "oldAccountNames": [],
  "activationEvidenceSha256": "<REPLACE_INDEPENDENT_64_LOWER_HEX_EVIDENCE>",
  "expectedSource": {
    "kind": "inactive",
    "runtimeControlGeneration": 0,
    "runtimeControlEvidenceSha256": null,
    "runtimeEpochSha256": null,
    "restoreRunId": null,
    "replayReceiptSha256": null
  },
  "nextEpoch": null
}
```

这是闭合11字段对象：`expectedSequence`与`runtimeControlGeneration`是JSON数字，`null`不是字符串；ID均为小写合法UUID，`serverUuid`必须是实际`@@server_uuid`，`applicationDatabase`必须精确等于实际`DATABASE()`。`newAccounts`是1–64个不重复的`{user,host}`对象，填MySQL实际账号的独立user/host，不拼`user@host`；`activationEvidenceSha256`是操作者独立验真记录的64位小写SHA-256，不从模板或待验证DB自报值补造。不要增加注释、重复键、摘要字段或未知字段。

此模板的`oldAccountNames:[]`**仅适用于上述真空库**；原生校验还会核无当前binding、source inactive和sessions零行，但这些检查不能替代操作者对旧身份/连接/事务的完整库存。已有业务、旧runtime用户名、已激活0030或已有binding的环境不得照抄本模板；应按其真实source/旧账号与后继协议准备固定命令，不能把事实改成inactive/空列表。字段的完整类型与闭合验证以 [command types](../../packages/store/src/mysql/session-authority-binding-types.ts)、[command/source parser](../../packages/store/src/mysql/session-authority-binding.ts) 为准；环境字段以 [operator config](../../apps/agent-runner/src/session-authority-operator-config.ts) 为准。

已有 `0033` telemetry lifecycle 为 active 时，`authority preflight` 和 `authority activate` 也必须显式提供原来的 `TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE`；真正 inactive 的库可省略。该文件与 backup/restore operator 共用现有规范：绝对路径、当前 UID、owner-only 权限、single-link regular file，恰好 32 raw bytes（不是 hex 文本）；现 reader 使用 no-follow/nonblocking open，并核读前后文件身份。应用 `TENANT_TELEMETRY_REF_KEY`（包括空值）在 operator 中必须不存在；不得把 key 写入 argv、AUTHORITY command JSON、输出或日志，也不能生成替代 key。原整项期限覆盖实际 key 读取、SQL 与关闭；取消仍等待原读取/连接/操作和 Store close 结清，随后清零 CLI 拥有的临时 key buffer。缺失或错误 key 仍由完整 startup audit 拒绝，不跳过已有 receipt/coverage/source 校验。

第5节末尾的`exit`已结束schema operator shell；**不能依赖其中的`NODE`/`RUNNER_MAIN`变量继续执行**。人工预置本次owned `0600`的`/ABS/private/authority.env`，放在owned `0700`私有目录，只包含已审阅的authority字段与必要的原ref-key文件路径：`AUTHORITY_MYSQL_URL`、`AUTHORITY_COMMAND_FILE`、三项`AUTHORITY_METADATA_*`、两个精确ACK，以及可选`AUTHORITY_OPERATION_TIMEOUT_MS`。两个ACK须逐字为`AUTHORITY_FLEET_STOPPED_ACK=all-application-writers-stopped-v1`与`AUTHORITY_EXCLUSIVE_CHANGE_ACK=exclusive-authority-permissions-window-v1`；可选timeout为十进制字符串`1000..120000`，缺省`120000`。command file指向上面固定JSON；URL显式选中同一实际app库，不回退`MYSQL_URL`。不要从schema.env、项目.env或旧ambient环境借权限；该shell配置是受信任代码，不能source任意下载文件。

重新进入干净operator shell，重设**同一已验制品**的Node/main绝对路径，再加载这份受保护配置；本段命令中的路径也是占位，argv不含秘密：

```sh
env -i HOME=/ABS/operator-home PATH=/ABS/node24-bin:/usr/bin:/bin /bin/sh
set +x
umask 077
NODE=/ABS/node24-bin/node
RUNNER_MAIN=/ABS/verified-runner-release/dist/main.js
set -a
. /ABS/private/authority.env
set +a
"$NODE" "$RUNNER_MAIN" authority preflight
```

preflight实际退出0且无待结清工作、原权限/停服窗口和固定command均保持后，再在**这个authority shell**执行：

```sh
"$NODE" "$RUNNER_MAIN" authority activate
```

`activate`内部依次执行initial binding与同command的实际结果确认，成功才输出`status:"ok"`、`activated:true`及该`commandSha256`；这不是另一个可调用的`confirm`子命令。失败/unknown保留同一文件、ID和DB，按原协议核实，不因preflight曾成功而继续启动。实现见 [authority CLI](../../apps/agent-runner/src/session-authority-cli.ts)。全部原操作和close真实结清、结果已核实后，才退出这个专用shell：

```sh
exit
```

长期应用不取得authority配置。authority仍使用既有runner main，不增加daemon、产品JS入口或镜像。已有active0033所需的原`TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE`也只从这份受保护authority配置载入；inactive真空库省略，不在终端打印或临时生成替代key。

默认整项操作期限120000ms，显式只接受1000..120000；取消后仍等待实际SQL/传输close，不能靠响应结束证明后台已停。输出只含状态/command摘要；任何超时、连接中断或unknown均保留固定文件和DB，先用同一command确认原结果。preflight只观察和拒绝，不执行DDL、GRANT、KILL、控制激活或隐式修复。原生准入需要独立operator的完整连接可见性，并核实际CURRENT_USER/roles/proxy、所有旧host grant/连接/事务、新账号闭合grant和metadata身份；上线前须在实际MySQL版本验证所需权限，不把过滤后的零行当已排空。

初始绑定之后再发生0030 primary/restore epoch激活，必须由原受控激活事务绑定新的实际epoch结果；固定command另外绑定完整activation请求的内容无关摘要与已存在的sealed source。它不要求操作者猜未来DB时间或事件摘要，也不重签旧receipt。后继不由`authority activate`建立；使用既有restore操作的显式operator profile并核同command实际结果。物理恢复仍需0030/0031原source、catalog/reservation、停服/独立证据及原fence链，不能用本绑定替代备份字节、旧primary停机或云故障域证明。

全部操作成功并确认资源实际结清后，退出operator进程、移除AUTHORITY_*，仅把新版本runtime凭据和metadata交给新runner。启动核实际账号/绑定和完整schema；每个实际pool借用仍重验身份及闭合授权。DBA恶意改权/改后复原、误把新credential交给旧binary、数据库物理回退及双primary等仍须独立部署控制和后续灾备验收，本节不宣称能防御这些条件。

## 5.6. 备份恢复的专用维护连接

现有本地 backup source/selected restore 命令使用停止窗口内的专用维护 facade。它保留原 operator 的完整 native schema/source 校验，并在每次实际借用连接时核对初审的 UUID、数据库和 CURRENT_USER；不返回普通 SessionStore，不提供 session acquire，也不获得 epoch 激活权。物理导入后的新 target 无须为了这一步在命令中隐式安装 metadata procedure；普通 runtime 和真正 epoch 激活仍执行各自的完整 metadata/权限门禁。

`create-artifact`、`verify-artifact`、`restore-selected` 均须显式提供原 `RESTORE_FLEET_STOPPED_ACK=1` 与 `BACKUP_ARTIFACT_LOCAL_ONLY_ACK=1`。verify 路径也会核对及镜像 catalog，不能把名称理解成无前置条件的离线字节读取。有无 protected ref key 均走此专用 facade；无 key 只允许原 validator 证实的 inactive、无 checkpoint 足迹的 NULL 投影，active、keyed 或 unknown 仍拒绝，不生成替代 key。

五个 selected continuation 继续要求 exact run、各自 ACK、真实 target/operator 锁、held GCM 与完整外部链。只有 `activate-selected` 额外读取固定 `AUTHORITY_*` command：`AUTHORITY_MYSQL_URL` 必须与所选 `BACKUP_RESTORE_TARGET_MYSQL_URL` 完全相同，并核实际物理身份等于持锁目标。原激活 receipt 或 response-loss 读回之外，还必须独立确认同一 authority command 的实际结果；不能重建 command、刷新 source 或补造 binding。其它 continuation 拒绝混入 `AUTHORITY_*`，专用 stopped profile 不能绕过 epoch 激活门禁。

组合 `activate-selected` 采用原 artifact 操作期限与 `AUTHORITY_OPERATION_TIMEOUT_MS` 的较小值，后者默认/最大120000ms；不会把原预算放大。普通 catalog/telemetry 命令继续使用显式 metadata 的受限 runtime 连接。上述维护连接的具名兼容与发布范围见PROGRESS；本地限定及production拒绝不因发布通过而解除。

## 6. 受限 runtime 冷启动与唯一 first-admin

长期 runner 只拿受限 `MYSQL_URL`、`MYSQL_SCHEMA_METADATA_{SCHEMA,DEFINER_USER,DEFINER_HOST}` 及必要 runtime 配置；不带 `AUTHORITY_*`、`SCHEMA_*`、operator DSN、迁移目录或任何授权脚本。router 不拿 MySQL、加密 master、provider、admin/bootstrap 权力。普通 MySQL main 固定 verify；缺 schema/metadata/ACL 均失败，不通过开关回退 apply。

首次 admin 仍是**一个受控 ordinary runner 的前台启动**，不是 schema 命令或新 one-shot CLI：

1. 其它 runner/router/writer 保持停止，只有一个 operator 实例。复制并审阅 `first-admin.env.example` 为绝对 `0600` 私有文件，使用受限 runtime DSN；与后续正常 runner 保持同一个部署的 master key、internal token、DB 与 Redis 身份，不为重启重新生成 master。独立密钥指不同用途不可复用，不是每次启动换 key。输出目录预先 `0700`，`ADMIN_BOOTSTRAP_OUTPUT_FILE` 是该目录下尚不存在的绝对文件。
2. 人工预建独立、稳定、owned uid、`0700`、全路径无 symlink 的 Blob 目录；first-admin 和后续普通 runner 的 `BLOB_DIR` 必须使用完全同一绝对路径。它独立于下一节每次全新的 external `--state-dir`；即使首次不发 turn、不写 Blob/附件、不激活生命周期，也不能把更换 physical root 当成普通重启。
3. 进入干净 shell后 source 已审文件，直接前台 main，不经过会清理/拒绝 admin pair 的普通 local start/external run：

   ```sh
   env -i HOME=/ABS/bootstrap-home PATH=/ABS/node24-bin:/usr/bin:/bin /bin/sh
   set +x
   umask 077
   set -a
   . /ABS/private/first-admin.env
   set +a
   exec /ABS/node24-bin/node /ABS/verified-runner-release/dist/main.js
   ```

4. readiness 后核真实 admin scope/鉴权。输出文件是**一行 key 加换行，不是 JSON**。没有 admin 时 API key 由产品随机生成，仅输出文件；已有未撤销 admin 时不会另造 key。下面在另一个干净 shell 执行，只把非秘密绝对路径和实际 loopback runner URL 放进 argv；key 仅在内存进入 header。`GET /v1/tenant/api-keys` 要求 admin，示例不输出响应、header 或 key，也不调用模型。

   ```sh
   env -i HOME=/ABS/client-home PATH=/ABS/node24-bin:/usr/bin:/bin \
     /ABS/node24-bin/node --input-type=module - \
     /ABS/private/first-admin-key http://127.0.0.1:REPLACE_RUNNER_PORT <<'NODE'
   import { constants, openSync, fstatSync, readSync, closeSync, lstatSync, realpathSync } from 'node:fs';
   import { dirname, isAbsolute } from 'node:path';
   let fd;
   try {
     const [file, base] = process.argv.slice(2), check = value => { if (!value) throw Error(); };
     check(process.argv.length === 4 && typeof process.getuid === 'function' && isAbsolute(file));
     const parent = dirname(file), directory = lstatSync(parent);
     check(realpathSync(parent) === parent && directory.isDirectory() && !directory.isSymbolicLink()
       && directory.uid === process.getuid() && (directory.mode & 0o777) === 0o700);
     check(realpathSync(file) === file && typeof constants.O_NOFOLLOW === 'number');
     fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
     const stat = fstatSync(fd), bytes = Buffer.alloc(4097);
     check(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600
       && stat.size > 0 && stat.size <= 4096);
     const length = readSync(fd, bytes, 0, bytes.length, 0), line = bytes.subarray(0, length).toString('utf8');
     check(length === stat.size && /^ask_[A-Za-z0-9_-]{32}\n$/.test(line));
     closeSync(fd); fd = undefined;
     check(/^http:\/\/127\.0\.0\.1:[0-9]+\/?$/.test(base));
     const url = new URL(base); check(Number(url.port) >= 1 && Number(url.port) <= 65535);
     const response = await fetch(new URL('/v1/tenant/api-keys', url), {
       headers: { Authorization: `Bearer ${line.slice(0, -1)}`, 'X-User-Id': 'manual_verifier' },
       signal: AbortSignal.timeout(5000), redirect: 'error',
     });
     await response.body?.cancel(); check(response.status === 200);
     console.log('first-admin-check-ok');
   } catch { console.error('first-admin-check-rejected'); process.exitCode = 1; }
   finally { if (fd !== undefined) { try { closeSync(fd); } catch { process.exitCode = 1; } } }
   NODE
   ```

   不要改成 `cat` key、`curl -H "Bearer $(cat ...)"`（会进 argv），也不把 key 写入角色 JSON/日志。这里仅验证本 runner 的真实 admin 鉴权，不代替后续 router/进程退出和冷启验证。
5. `Ctrl-C`/TERM 后等待实际 drain/退出，再去掉 `ADMIN_BOOTSTRAP_TENANT` 与 `ADMIN_BOOTSTRAP_OUTPUT_FILE`，后续正常配置二者均**不存在**。`BOOTSTRAP_API_KEY` 是开发快捷途径、production 拒绝且与 admin pair 互斥，不能替代这条受控首次引导流程。

输出文件以 create-only `wx`、`0600`、文件与父目录 fsync **先于**数据库写入。文件存在不证明 DB 提交；DB 失败/响应不明时保留该文件及 DB 证据，人工核对，不覆盖、删掉重造或自动重签。它只是同一文件系统上的互斥，不是跨 VM singleton；不要同时启动多个 first-admin 实例。

## 7. 显式 external-infra 前台运行

该模式只消费人工已经预置的 MySQL/Redis，不执行默认 infra 脚本，不默认使用 3306/6379，只连接显式所选 loopback 端口；它不独立证明这些端口属于 dedicated 实例，仍须操作者按第 1 节验真。不创建库/账号/GRANT、停止 Redis/MySQL 或执行任何 DROP。`--external-infra` 在加载项目 `.env` **之前**分流；不从 ambient env 补角色凭据。

```sh
scripts/local-service.sh --external-infra run \
  --runner-env /ABS/private/runner.env.json \
  --router-env /ABS/private/router.env.json \
  --state-dir /ABS/private/new-runtime-state
```

两个 JSON 须 owned uid、`0600`、直接 parent `0700`、全路径无 symlink；启动会重验字节漂移。state 必须尚不存在，由本次新建 `0700`，只承载本轮日志与私有 HOME/TMP。runner `BLOB_DIR` 则是人工预建、独立于 state 的稳定 owned `0700`、全路径无 symlink 目录；run 只验真并使用，不创建、迁移或删除，后继正常前台 run 继续使用同一路径。两 role 的 Redis URL（显式端口与 DB）、prefix/namespace、internal token 与 Blob 宣告须一致；runner/router 端口不同且未占用。模板仅本地单 runner filesystem，附件/清理/Blob control 关闭，不是 S3 或生产模板。

模板不带 provider 凭据，schema/首次管理员/鉴权检查不需要付费模型。要执行真实模型 turn，须另行明确配置 runner 可选的 `API_KEY`、`API_BASE_URL`、`DEFAULT_MODEL`、`PLATFORM_PROVIDER` 并获相应调用授权；这些字段不能进 router。FakeVendor 结果不是付费模型验证。本模式不接受任意 feature/env 字段来绕过其它包的启用合同。

普通 run 拒绝全部 `BOOTSTRAP_*` / `ADMIN_BOOTSTRAP_*`（含空）；也不载入 operator 配置。router JSON 不能放 MySQL/provider/master/admin 字段。前台 Ctrl-C/TERM 仅停止本次拥有的两个 child 并等待真实 close，保留 state/DB/Redis，不宣称清理外部资源。不要用 `killall` 或删除 data directory 来代替退出证明。

这个模式只有 `--help` 与 `run`；`start/status/logs/stop/restart/down/schema/verify/verify-s3` 均拒绝，不回落默认共享 infra。前台 supervisor 不打印 ready；另一个终端检查显式所选的 runner/router `/readyz`，两者均 200 才开始 API 操作。角色日志在本轮 state 的 `runner.log` / `router.log`（`0600`），不要把日志直接公开。不要为了查询状态改用默认 `status`，也不要 `down` 外部服务。schema 使用前述独立受控 main 命令；测试的 verify/verify-s3 由隔离专用夹具另行负责，不能把业务 operator/env 传进去。

`/readyz` 200 不是 Redis 逻辑 DB 选择成功或全部依赖健康的证明；继续按[开发指南的 API 体验](development-and-ci-guide.md#5-手动体验-agent-runtime)执行鉴权、创建与读回。显式 DB 必须是所选实例实际存在的数据库，不能假定所有实例都恰有 16 个。当前实现在每个正式Redis连接及派生连接上保护SELECT：选择失败时断开并销毁该连接，禁止继续在默认 DB0 派发；这不自动修正配置、切库、证明实际 socket 已关闭或使 supervisor 获得基础设施管理权。修正配置后须先等待旧应用实际退出，再显式启动新一轮；不要以一次预检代替重连时的连接保护。具名验收版本与范围只认PROGRESS。

这是首次隔离演练入口，不是已有 state 的 restart/migration 管理器。下次 run 使用新 state，但保留相同的稳定 `BLOB_DIR`；退出后保留的目录不能仅因进程停止而删除。filesystem namespace 绑定 physical root，不能换路径再假称能冷读原对象；确需搬迁必须另走受控存储/迁移流程，本模式不提供迁移能力。

## 8. 同一入口用于 VM / OCI，验证仍分层

- VM：先在目标 OS/CPU 上独立验真完整 release（archive/manifest/tool 摘要、所选 role/commit，以及使用签名时的独立 SPKI pin）；携带同包 production dependencies 与 migrations。显式 `node /ABS/release/dist/main.js schema ...`，不从另一 checkout 偷借迁移，不在 systemd `ExecStartPre` 自动迁移；普通 `ExecStart` 仍零 argv。
- OCI：镜像声明的是 `CMD ["node","dist/main.js"]`，不是固定 ENTRYPOINT。命令应显式选择**同一不可变 runner image ID/digest**，例如 `docker run ... IMAGE node /app/dist/main.js schema migrate`；只写 `IMAGE schema migrate` 不会调用 Node。operator 配置用已审 `0600 --env-file`（不是 `-e SCHEMA_MYSQL_URL=...` 把密码带进 argv），安装阶段用独立安装文件；不得把 operator env-file 复用于长期容器。
- OCI 网络/账号 host 按实际连接设计，不能把本文本地 loopback、容器 `localhost` 或 VM 地址直接互换。first-admin 输出目录另以受保护 mount 保留；不能只放进 `--rm` 容器后声称失败文件仍可核对。外部基础设施/生产网络、IAM/TLS、容量及 rollout 都须另验。

验证分层：自动夹具用全新独占实例核身份与授权前后库存；按手册 migrate/install/exact EXEC/verify；受限 runtime 冷启并确认缺表权限/库级权限/role/PROXY/漂移均拒绝；真实首 admin 文件 mode、鉴权、失败保留及去 pair 后重启；external 前台两 role 退出只收自有 child、原基础设施与保留目录不变。沿用原期限/断言，不把纯 parser/template 检查当作 SQL/VM/OCI 或人工演练证据；具名自动验证结果由PROGRESS记录；人工执行仍须保存本次真实身份、权限和退出证据。

实现依据：[schema CLI](../../apps/agent-runner/src/schema-cli.ts)、[installer](../../packages/store/src/mysql/schema-metadata-install.ts)、[命名/正文 codec](../../packages/store/src/mysql/schema-metadata-codec.ts)、[native runtime ACL](../../packages/store/src/mysql/schema-runtime-privileges.ts)、[普通 main 与 first-admin](../../apps/agent-runner/src/main.ts)。测试专用 `test/fixtures/mysql-runtime.mjs` / CI image helper 会建测试资源，不是部署预置器，不应拿来操作用户实例。既有 0037/0054、旧 receipt/unknown、自动删除关闭和全域 completion=false 边界保持不变。
