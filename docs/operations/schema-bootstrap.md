# 首次人工 schema 预置、管理员引导与隔离启动

本文只面向**新建、可丢弃、由操作者独占的本地 MySQL/Redis 实例**。不是既有业务库升级、生产部署授权或自动建库/授权工具。底层 schema/runtime 权限切片已有发布证据；首次管理员及 external-infra 接线已通过隔离真实 MySQL/Redis 自动夹具，本包仍待最终同SHA CI。本文人工逐句SQL流程尚未独立演练，不据此宣称人工流程或云/生产已验收；精确结果见PROGRESS。

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
| runner runtime | 每个实际 app BASE TABLE 的 SELECT/IUD，惟 `schema_migrations` **仅 SELECT**；exact procedure EXECUTE；全局 SHOW_ROUTINE 与 USAGE | 无 TRIGGER、库级数据 grant、跨库表/列级 grant、DDL、GRANT OPTION、角色（包括 inactive/mandatory）、PROXY |

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
-- 对清单中每一个其它 BASE TABLE，人工逐项执行，不包含 marker 表：
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

## 6. 受限 runtime 冷启动与唯一 first-admin

长期 runner 只拿受限 `MYSQL_URL`、`MYSQL_SCHEMA_METADATA_{SCHEMA,DEFINER_USER,DEFINER_HOST}` 及必要 runtime 配置；不带 `SCHEMA_*`、operator DSN、迁移目录或任何授权脚本。router 不拿 MySQL、加密 master、provider、admin/bootstrap 权力。普通 MySQL main 固定 verify；缺 schema/metadata/ACL 均失败，不通过开关回退 apply。

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

`/readyz` 200 不是 Redis 逻辑 DB 选择成功或全部依赖健康的证明；继续按[开发指南的 API 体验](development-and-ci-guide.md#5-手动体验-agent-runtime)执行鉴权、创建与读回。显式 DB 必须是所选实例实际存在的数据库，不能假定所有实例都恰有 16 个。当前待验修复在每个正式 Redis 连接及派生连接上保护 SELECT：选择失败时断开并销毁该连接，禁止继续在默认 DB0 派发；这不自动修正配置、切库、证明实际 socket 已关闭或使 supervisor 获得基础设施管理权。修正配置后须先等待旧应用实际退出，再显式启动新一轮；不要以一次预检代替重连时的连接保护。修复验收状态仍只认 PROGRESS。

这是首次隔离演练入口，不是已有 state 的 restart/migration 管理器。下次 run 使用新 state，但保留相同的稳定 `BLOB_DIR`；退出后保留的目录不能仅因进程停止而删除。filesystem namespace 绑定 physical root，不能换路径再假称能冷读原对象；确需搬迁必须另走受控存储/迁移流程，本模式不提供迁移能力。

## 8. 同一入口用于 VM / OCI，验证仍分层

- VM：先在目标 OS/CPU 上独立验真完整 release（archive/manifest/tool 摘要、所选 role/commit，以及使用签名时的独立 SPKI pin）；携带同包 production dependencies 与 migrations。显式 `node /ABS/release/dist/main.js schema ...`，不从另一 checkout 偷借迁移，不在 systemd `ExecStartPre` 自动迁移；普通 `ExecStart` 仍零 argv。
- OCI：镜像声明的是 `CMD ["node","dist/main.js"]`，不是固定 ENTRYPOINT。命令应显式选择**同一不可变 runner image ID/digest**，例如 `docker run ... IMAGE node /app/dist/main.js schema migrate`；只写 `IMAGE schema migrate` 不会调用 Node。operator 配置用已审 `0600 --env-file`（不是 `-e SCHEMA_MYSQL_URL=...` 把密码带进 argv），安装阶段用独立安装文件；不得把 operator env-file 复用于长期容器。
- OCI 网络/账号 host 按实际连接设计，不能把本文本地 loopback、容器 `localhost` 或 VM 地址直接互换。first-admin 输出目录另以受保护 mount 保留；不能只放进 `--rm` 容器后声称失败文件仍可核对。外部基础设施/生产网络、IAM/TLS、容量及 rollout 都须另验。

本包真实验收计划：root 用全新独占实例核身份与授权前后库存；按手册 migrate/install/exact EXEC/verify；受限 runtime 冷启并确认缺表权限/库级权限/role/PROXY/漂移均拒绝；真实首 admin 文件 mode、鉴权、失败保留及去 pair 后重启；external 前台两 role 退出只收自有 child、原基础设施与保留目录不变。沿用原期限/断言，不把纯 parser/template 检查当作 SQL/VM/OCI 或人工演练证据；通过状态由 PROGRESS 记录，本文不预填结果。

实现依据：[schema CLI](../../apps/agent-runner/src/schema-cli.ts)、[installer](../../packages/store/src/mysql/schema-metadata-install.ts)、[命名/正文 codec](../../packages/store/src/mysql/schema-metadata-codec.ts)、[native runtime ACL](../../packages/store/src/mysql/schema-runtime-privileges.ts)、[普通 main 与 first-admin](../../apps/agent-runner/src/main.ts)。测试专用 `test/fixtures/mysql-runtime.mjs` / CI image helper 会建测试资源，不是部署预置器，不应拿来操作用户实例。既有 0037/0054、旧 receipt/unknown、自动删除关闭和全域 completion=false 边界保持不变。
