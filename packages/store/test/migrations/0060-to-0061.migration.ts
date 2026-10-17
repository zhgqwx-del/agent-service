import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MysqlSessionStore } from "../../src/mysql/store.js";
import { SKILL_REGISTRY_TABLES, SKILL_REGISTRY_MIGRATION, SKILL_REGISTRY_NATIVE_LOOKUP_MIGRATION, skillRegistryFingerprintStatement } from "../../src/mysql/skills-registry.js";
import { createSkillPackageAdmission, createSkillRegistryAccess, SkillRegistryIntegrityError, type SkillOwner } from "../../src/skills.js";

// Original 0060 SQL plus actual product-created registry rows on real MySQL.
// This is a historical SQL-prefix upgrade, not a frozen-binary or physical-backup proof.
const migrations = resolve(dirname(fileURLToPath(import.meta.url)), "../../migrations");
const baseInput = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL ?? "mysql://root@127.0.0.1:3306/agent_service_test";
function safeBase() {
  const url = new URL(baseInput), database = decodeURIComponent(url.pathname.slice(1));
  if (url.protocol !== "mysql:" || !["127.0.0.1","localhost","[::1]"].includes(url.hostname) || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) throw new Error("0061 migration fixture requires a local disposable database");
  return url;
}
function at(base: URL, database: string) { const url = new URL(base); url.pathname = `/${database}`; return url.toString(); }
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(value)) throw new Error("0061 historical identifier invalid");
  return `\`${value}\``;
}
function digest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function cleanupFailure(): never { throw new Error("0061 historical fixture cleanup is not proven"); }
function remaining(deadline:number,signal?:AbortSignal):number {
  const ms=Math.floor(deadline-performance.now());if(ms<=0||signal?.aborted)cleanupFailure();return ms;
}
async function dropOwnedDatabase(admin:Connection,name:string,serverUuid:string,adminId:number,deadline:number,signal:AbortSignal) {
  if(!/^agent_service_migration_test_0061_[0-9]+_[0-9a-f]{8}$/.test(name))cleanupFailure();
  const query=async(sql:string,values:readonly (string|number)[]=[])=>{
    const [rows]=await admin.query<RowDataPacket[]>({sql,timeout:remaining(deadline,signal)},[...values]);remaining(deadline,signal);return rows;
  };
  const identity=await query("SELECT @@server_uuid AS server_uuid,CONNECTION_ID() AS id,DATABASE() AS db");
  if(identity.length!==1||String(identity[0]?.server_uuid).toLowerCase()!==serverUuid||Number(identity[0]?.id)!==adminId||identity[0]?.db!=="mysql")cleanupFailure();
  const schemas=await query("SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?",[name]);
  if(schemas.length!==1||schemas[0]?.name!==name)cleanupFailure();
  for(;;){
    const connections=await query("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE BINARY DB=BINARY ?",[name]);
    const transactions=await query("SELECT COUNT(*) AS n FROM information_schema.INNODB_TRX t JOIN information_schema.PROCESSLIST p ON p.ID=t.trx_mysql_thread_id WHERE BINARY p.DB=BINARY ?",[name]);
    const metadata=await query("SELECT COUNT(*) AS n FROM performance_schema.metadata_locks WHERE BINARY OBJECT_SCHEMA=BINARY ? OR (OBJECT_TYPE='SCHEMA' AND BINARY OBJECT_NAME=BINARY ?)",[name,name]);
    const counts=[connections,transactions,metadata].map(rows=>rows.length===1?Number(rows[0]?.n):Number.NaN);
    if(counts.some(count=>!Number.isSafeInteger(count)||count<0))cleanupFailure();
    if(counts.every(count=>count===0))break;
    await new Promise<void>(resolve=>setTimeout(resolve,Math.min(10,remaining(deadline,signal))));
  }
  remaining(deadline,signal);await admin.query({sql:`DROP DATABASE ${identifier(name)}`,timeout:remaining(deadline,signal)});
  const after=await query("SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?",[name]);
  if(after.length!==1||Number(after[0]?.n)!==0)cleanupFailure();
}
async function oldRows(conn: Connection): Promise<string> {
  const [tables] = await conn.query<RowDataPacket[]>("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY BINARY TABLE_NAME");
  const snapshot: unknown[] = [];
  for (const table of tables) {
    const name = String(table.name); if (name === "schema_migrations") continue;
    const [columns] = await conn.query<RowDataPacket[]>("SELECT COLUMN_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX",[name]);
    const order = columns.length ? ` ORDER BY ${columns.map(row=>identifier(row.name)).join(",")}` : "";
    const [rows] = await conn.query<RowDataPacket[]>(`SELECT * FROM ${identifier(name)}${order}`);
    snapshot.push([name, rows]);
  }
  return digest(snapshot);
}
describe("0060 nonempty registry to 0061 native lookup upgrade on isolated MySQL",()=>{
  let admin: Connection, base: URL, oldDirectory: string;
  const owned = new Set<string>();
  let serverUuid="",adminId=0,caseDeadline=0,caseSignal:AbortSignal|undefined;
  beforeAll(async()=>{
    const deadline=performance.now()+120_000;
    base=safeBase(); admin=await mysql.createConnection(at(base,"mysql"));
    const [identity]=await admin.query<RowDataPacket[]>("SELECT @@server_uuid AS server_uuid,CONNECTION_ID() AS id,DATABASE() AS db");
    serverUuid=String(identity[0]?.server_uuid).toLowerCase();adminId=Number(identity[0]?.id);
    if(identity.length!==1||!/^[0-9a-f-]{36}$/.test(serverUuid)||!Number.isSafeInteger(adminId)||adminId<1||identity[0]?.db!=="mysql")cleanupFailure();
    oldDirectory=await mkdtemp(join(tmpdir(),"agent-service-pre0061-"));
    for(const name of (await readdir(migrations)).filter(name=>name.endsWith(".sql")&&name<SKILL_REGISTRY_NATIVE_LOOKUP_MIGRATION)) await copyFile(join(migrations,name),join(oldDirectory,name));
    remaining(deadline);
  },120_000);
  beforeEach(context=>{caseDeadline=performance.now()+30_000;caseSignal=context.signal;});
  afterAll(async({},suite)=>{
    // Never sweep retained/uncertain databases from a late hook.
    try{await admin?.end();}catch{cleanupFailure();}
    if(oldDirectory&&owned.size===0&&suite.tasks.length===4&&suite.tasks.every(task=>task.type==="test"&&task.result?.state==="pass"))await rm(oldDirectory,{recursive:true,force:true});
  },120_000);
  async function fixture(work:(conn:Connection,url:string,before:string)=>Promise<void>) {
    const deadline=caseDeadline,signal=caseSignal;
    if(!signal)cleanupFailure();remaining(deadline,signal);
    const name=`agent_service_migration_test_0061_${process.pid}_${randomUUID().replaceAll("-","").slice(0,8)}`;
    const [existing]=await admin.query<RowDataPacket[]>("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?",[name]);
    if(existing.length)throw new Error("0061 isolated database already exists");
    remaining(deadline,signal);
    await admin.query(`CREATE DATABASE ${identifier(name)} CHARACTER SET utf8mb4`); owned.add(name);
    const url=at(base,name);let old:MysqlSessionStore|undefined,conn:Connection|undefined,removed=false;
    try {
      remaining(deadline,signal);
      old=await MysqlSessionStore.connect({url,migrationsDir:oldDirectory});
      await old.createApiKey("pre0061-tenant","old-key",createHash("sha256").update("nonsecret-fixture-token").digest("hex"),["admin"]);
      const owner:SkillOwner={scope:"user",tenantId:"pre0061-tenant",userId:"owner"};
      const access=createSkillRegistryAccess({principal:{tenantId:"pre0061-tenant",userId:"owner"},owner,authority:"user_self",access:"manage"});
      const body=Buffer.from("---\nname: example\ndescription: Historical package\n---\nHistorical body.\n");
      const staged=await old.prepareSkillInstallation({access,owner,name:"example",expectedRevision:0,idempotencyKey:"old-ready",backend:"filesystem-v1",
        storageNamespaceSha256:createHash("sha256").update("historical-registry-namespace").digest("hex"),
        admission:createSkillPackageAdmission({owner,metadata:{name:"example",description:"Historical package",whenToUse:null,disableModelInvocation:false,userInvocable:true,dependencies:{tools:[]}},
          sha256:createHash("sha256").update(body).digest("hex"),sizeBytes:body.length,parserProfile:"skill-markdown-v1",guardProfile:"skills-guard-v1"})});
      await old.publishSkillInstallation({access,owner,installationId:staged.installationId,uploadToken:staged.uploadToken,
        descriptor:{storageKey:staged.storageKey,sha256:staged.sha256,sizeBytes:staged.sizeBytes,contentType:staged.contentType}});
      await old.close();old=undefined;conn=await mysql.createConnection(url);
      const [target]=await conn.query<RowDataPacket[]>("SELECT @@server_uuid AS server_uuid,DATABASE() AS db");
      if(target.length!==1||String(target[0]?.server_uuid).toLowerCase()!==serverUuid||target[0]?.db!==name)cleanupFailure();
      const before=await oldRows(conn);remaining(deadline,signal);await work(conn,url,before);
      remaining(deadline,signal);
      const closing=conn;conn=undefined;await closing.end();remaining(deadline,signal);
      if(!owned.has(name))cleanupFailure();
      await dropOwnedDatabase(admin,name,serverUuid,adminId,deadline,signal);owned.delete(name);removed=true;
    } finally {
      const closed=await Promise.allSettled([old?.close(),conn?.end()]);
      if(!removed)console.warn(JSON.stringify({schema:"skill-registry-history-cleanup-v1",status:"retained_or_unknown",database:name}));
      if(closed.some(result=>result.status!=="fulfilled"))cleanupFailure();
    }
  }
  it("preserves every 0060 physical business row and nonempty package while old complete trigger root becomes invalid",async()=>fixture(async(conn,url,before)=>{
    const [beforeCounts]=await conn.query<RowDataPacket[]>("SELECT (SELECT COUNT(*) FROM skill_registry_owners) AS owners,(SELECT COUNT(*) FROM skill_registry_slots) AS slots,(SELECT COUNT(*) FROM skill_registry_installations WHERE state='ready') AS ready,(SELECT COUNT(*) FROM skill_registry_versions) AS versions");
    expect(beforeCounts).toEqual([{owners:1,slots:1,ready:1,versions:1}]);
    const current=await MysqlSessionStore.connect({url});try {
      expect(await oldRows(conn)).toBe(before);
      const [markers]=await conn.query<RowDataPacket[]>("SELECT name FROM schema_migrations WHERE name IN (?,?) ORDER BY name",[SKILL_REGISTRY_MIGRATION,SKILL_REGISTRY_NATIVE_LOOKUP_MIGRATION]);
      expect(markers.map(row=>row.name)).toEqual([SKILL_REGISTRY_MIGRATION,SKILL_REGISTRY_NATIVE_LOOKUP_MIGRATION]);
      const [tables]=await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'skill_registry_%'");
      const [guards]=await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME LIKE 'trg_skill_registry_%'");
      expect(Number(tables[0]?.n)).toBe(SKILL_REGISTRY_TABLES.length);expect(Number(guards[0]?.n)).toBe(20);
      const source=await readFile(join(oldDirectory,SKILL_REGISTRY_MIGRATION),"utf8");
      await conn.query("SET @history0061_gcml=@@SESSION.group_concat_max_len");
      try {
        await conn.query("SET SESSION group_concat_max_len=1048576");
        await conn.query(skillRegistryFingerprintStatement(source,"triggers"));
        const [oldRoot]=await conn.query<RowDataPacket[]>("SELECT @skill_registry_triggers_ok AS ok");expect(Number(oldRoot[0]?.ok)).toBe(0);
      }finally{await conn.query("SET SESSION group_concat_max_len=@history0061_gcml");}
      const owner:SkillOwner={scope:"user",tenantId:"pre0061-tenant",userId:"owner"};
      const access=createSkillRegistryAccess({principal:{tenantId:"pre0061-tenant",userId:"owner"},owner,authority:"user_self",access:"read"});
      expect((await current.getReadableSkillVersion({access,owner,name:"example",versionId:null}))?.metadata.description).toBe("Historical package");
    }finally{await current.close();}
  }));
  it("missing rotated native guard rejects exact current verify without returning a writer",async()=>fixture(async(conn,url,before)=>{
    const current=await MysqlSessionStore.connect({url});await current.close();
    await conn.query("DROP TRIGGER trg_skill_registry_slots_gate_bi");
    const attempt=MysqlSessionStore.connect({url,migrationMode:"verify"}).then(async unexpected=>{await unexpected.close();return unexpected;});
    await expect(attempt).rejects.toThrow(SkillRegistryIntegrityError);expect(await oldRows(conn)).toBe(before);
  }));
  it("0061 marker loss rejects forward migration rather than re-signing or replaying rotated guards",async()=>fixture(async(conn,url,before)=>{
    const current=await MysqlSessionStore.connect({url});await current.close();
    await conn.query("DELETE FROM schema_migrations WHERE name=?",[SKILL_REGISTRY_NATIVE_LOOKUP_MIGRATION]);
    const [guardsBefore]=await conn.query<RowDataPacket[]>("SELECT TRIGGER_NAME,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY TRIGGER_NAME");
    const attempt=MysqlSessionStore.connect({url}).then(async unexpected=>{await unexpected.close();return unexpected;});
    await expect(attempt).rejects.toThrow(SkillRegistryIntegrityError);expect(await oldRows(conn)).toBe(before);
    const [guardsAfter]=await conn.query<RowDataPacket[]>("SELECT TRIGGER_NAME,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY TRIGGER_NAME");
    expect(digest(guardsAfter)).toBe(digest(guardsBefore));
    const [markers]=await conn.query<RowDataPacket[]>("SELECT name FROM schema_migrations WHERE name=?",[SKILL_REGISTRY_NATIVE_LOOKUP_MIGRATION]);expect(markers).toHaveLength(0);
  }));
  it("an auto-committed deny-plus-first-rotation prefix remains fail-closed and is never silently resumed",async()=>fixture(async(conn,url,before)=>{
    const sql=await readFile(join(migrations,SKILL_REGISTRY_NATIVE_LOOKUP_MIGRATION),"utf8");
    // Identical statement splitting to the existing product executor; no result or DDL is faked.
    const statements=sql.replace(/^\s*--.*$/gm,"").split(/;\s*\n/).map(value=>value.trim()).filter(Boolean);
    const boundary=statements.findIndex(value=>value.startsWith("CREATE TRIGGER trg_skill_registry_slots_bi "));
    expect(boundary).toBeGreaterThan(0);
    for(const statement of statements.slice(0,boundary+1))await conn.query(statement);
    const [temps]=await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME LIKE 'trg_skill_registry_native_lookup_%_block'");
    expect(Number(temps[0]?.n)).toBe(3);
    const attempt=MysqlSessionStore.connect({url}).then(async unexpected=>{await unexpected.close();return unexpected;});
    await expect(attempt).rejects.toThrow(SkillRegistryIntegrityError);expect(await oldRows(conn)).toBe(before);
    const [markers]=await conn.query<RowDataPacket[]>("SELECT name FROM schema_migrations WHERE name=?",[SKILL_REGISTRY_NATIVE_LOOKUP_MIGRATION]);expect(markers).toHaveLength(0);
  }));
});
