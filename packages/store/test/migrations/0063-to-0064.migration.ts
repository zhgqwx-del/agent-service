import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MysqlSessionStore } from "../../src/mysql/store.js";
import { SUBAGENT_MIGRATION, SUBAGENT_TABLES, subagentFingerprintStatement } from "../../src/mysql/subagents.js";
import { SubagentIntegrityError } from "../../src/subagents.js";
import { mkSession } from "../conformance.js";
import { MCP_REGISTRY_MIGRATION,mcpRegistryFingerprintStatement } from "../../src/mysql/mcp-registry.js";
import {mcpFixtureWrite,mcpFixtureExchange} from "../fixtures/mcp-registry.js";
import { TenantWebhookIntegrityError } from "../../src/tenant-webhooks.js";
import { createSkillPackageAdmission, createSkillRegistryAccess, SkillRegistryIntegrityError, type SkillOwner } from "../../src/skills.js";
import { installFrozenDependencies } from "./fixtures/frozen-dependencies.js";

// Exact through-0063 SQL prefix plus actual product-created nonempty MCP and skill rows on real MySQL.
// The original four cases are SQL-prefix history. The separately named fifth case also runs
// actual immutable published 0063 code; none of these cases is a physical-backup proof.
const migrations = resolve(dirname(fileURLToPath(import.meta.url)), "../../migrations");
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const FROZEN_0063_COMMIT = "8f8c493c987aa530316d1c9510ed65d60284f424";
const exec = promisify(execFile);
const baseInput = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL ?? "mysql://root@127.0.0.1:3306/agent_service_test";
function safeBase() {
  const url = new URL(baseInput), database = decodeURIComponent(url.pathname.slice(1));
  if (url.protocol !== "mysql:" || !["127.0.0.1","localhost","[::1]"].includes(url.hostname) || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) throw new Error("0064 migration fixture requires a local disposable database");
  return url;
}
function at(base: URL, database: string) { const url = new URL(base); url.pathname = `/${database}`; return url.toString(); }
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(value)) throw new Error("0064 historical identifier invalid");
  return `\`${value}\``;
}
function digest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function cleanupFailure(): never { throw new Error("0064 historical fixture cleanup is not proven"); }
function remaining(deadline:number,signal?:AbortSignal):number {
  const ms=Math.floor(deadline-performance.now());if(ms<=0||signal?.aborted)cleanupFailure();return ms;
}
function frozenEnvironment(scratch: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch, CI: "1", NODE_ENV: "test", NO_COLOR: "1",
    COREPACK_ENABLE_NETWORK: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", ...extra };
}
async function fixedProcess(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, deadline: number, signal?: AbortSignal): Promise<string> {
  try {
    const result = await exec(file, args, { cwd, env, timeout: remaining(deadline, signal), killSignal: "SIGKILL", maxBuffer: 1_048_576 });
    remaining(deadline, signal); if (result.stderr !== "") cleanupFailure(); return result.stdout.trim();
  } catch { throw new Error("Frozen 0063 process did not prove its expected outcome."); }
}
const frozenProbe = `
import { MysqlSessionStore } from './packages/store/src/mysql/store.ts';
import { SkillRegistryIntegrityError } from './packages/store/src/skills.ts';
import { AgentDefinition, emptyUsageAccumulator } from './packages/protocol/src/index.ts';
import { newId as id } from './packages/core/src/ids.ts';
const mode=process.env.FROZEN_MODE; let store;
try {
  if(!['setup','verify','apply'].includes(mode)) throw new Error('mode');
  try { store=await MysqlSessionStore.connect({url:process.env.FROZEN_MYSQL_URL,migrationMode:mode==='verify'?'verify':'apply'}); }
  catch(error) {
    if(mode==='setup'||!(error instanceof SkillRegistryIntegrityError)) throw new Error('unexpected');
    process.stdout.write('frozen-0063-'+mode+'-rejected\\n');
  }
  if(store) {
    if(mode!=='setup') throw new Error('old-writer-accepted');
    const at=Date.now();
    const agent=AgentDefinition.parse({id:id('agt'),tenantId:'frozen0063-tenant',version:1,name:'Frozen actual writer',model:{provider:'fixture-provider',model:'fixture-model'},tools:[],createdAtMs:at});
    await store.createAgent(agent);
    await store.createSession({id:id('sess'),tenantId:agent.tenantId,userId:'owner',agentId:agent.id,agentVersion:1,status:{type:'idle'},lastSeq:0,contextEpoch:'frozen0063',fenceToken:0,usage:emptyUsageAccumulator(),autoApprovedTools:[],createdAtMs:at,updatedAtMs:at,metadata:{}});
    await store.close(); store=undefined; process.stdout.write('frozen-0063-setup-written\\n');
  }
} catch { process.stderr.write('frozen-0063-probe-failed\\n'); process.exitCode=1; }
finally { if(store) { try { await store.close(); } catch { process.exitCode=1; } } }
`;
async function dropOwnedDatabase(admin:Connection,name:string,serverUuid:string,adminId:number,deadline:number,signal:AbortSignal) {
  if(!/^agent_service_migration_test_0064_[0-9]+_[0-9a-f]{8}$/.test(name))cleanupFailure();
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
    const name = String(table.name); if (name === "schema_migrations" || name.startsWith("subagent_")) continue;
    const [columns] = await conn.query<RowDataPacket[]>("SELECT COLUMN_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX",[name]);
    const order = columns.length ? ` ORDER BY ${columns.map(row=>identifier(row.name)).join(",")}` : "";
    const [rows] = await conn.query<RowDataPacket[]>(`SELECT * FROM ${identifier(name)}${order}`);
    snapshot.push([name, rows]);
  }
  return digest(snapshot);
}
describe("0063 nonempty MCP and skill registry to 0064 root-fenced subagent upgrade on isolated MySQL",()=>{
  let admin: Connection, base: URL, oldDirectory: string,targetDirectory:string, archiveRoot:string, frozenCheckout:string;
  const owned = new Set<string>();
  let serverUuid="",adminId=0,caseDeadline=0,caseSignal:AbortSignal|undefined;
  beforeAll(async()=>{
    const deadline=performance.now()+120_000;
    base=safeBase(); admin=await mysql.createConnection(at(base,"mysql"));
    const [identity]=await admin.query<RowDataPacket[]>("SELECT @@server_uuid AS server_uuid,CONNECTION_ID() AS id,DATABASE() AS db");
    serverUuid=String(identity[0]?.server_uuid).toLowerCase();adminId=Number(identity[0]?.id);
    if(identity.length!==1||!/^[0-9a-f-]{36}$/.test(serverUuid)||!Number.isSafeInteger(adminId)||adminId<1||identity[0]?.db!=="mysql")cleanupFailure();
    oldDirectory=await mkdtemp(join(tmpdir(),"agent-service-pre0064-"));
    targetDirectory=await mkdtemp(join(tmpdir(),"agent-service-through0064-"));
    for(const name of (await readdir(migrations)).filter(name=>name.endsWith(".sql")&&name<SUBAGENT_MIGRATION)) await copyFile(join(migrations,name),join(oldDirectory,name));
    for(const name of (await readdir(migrations)).filter(name=>name.endsWith(".sql")&&name<=SUBAGENT_MIGRATION))await copyFile(join(migrations,name),join(targetDirectory,name));
    archiveRoot=await mkdtemp(join(tmpdir(),"agent-service-frozen0063-"));frozenCheckout=join(archiveRoot,"checkout");await mkdir(frozenCheckout);
    const env=frozenEnvironment(archiveRoot),archive=join(archiveRoot,"source.tar");
    expect(await fixedProcess("git",["rev-parse","--verify",`${FROZEN_0063_COMMIT}^{commit}`],repository,env,deadline)).toBe(FROZEN_0063_COMMIT);
    await fixedProcess("git",["merge-base","--is-ancestor",FROZEN_0063_COMMIT,"HEAD"],repository,env,deadline);
    await fixedProcess("git",["archive","--format=tar",`--output=${archive}`,FROZEN_0063_COMMIT],repository,env,deadline);
    await fixedProcess("tar",["-xf",archive,"-C",frozenCheckout],repository,env,deadline);
    await installFrozenDependencies(repository,frozenCheckout);
    remaining(deadline);
  },120_000);
  beforeEach(context=>{caseDeadline=performance.now()+30_000;caseSignal=context.signal;});
  afterAll(async({},suite)=>{
    // Never sweep retained/uncertain databases from a late hook.
    try{await admin?.end();}catch{cleanupFailure();}
    if(oldDirectory&&owned.size===0&&suite.tasks.length===5&&suite.tasks.every(task=>task.type==="test"&&task.result?.state==="pass"))await Promise.all([rm(oldDirectory,{recursive:true,force:true}),rm(targetDirectory,{recursive:true,force:true}),rm(archiveRoot,{recursive:true,force:true})]);
  },120_000);
  async function fixture(work:(conn:Connection,url:string,before:string)=>Promise<void>) {
    const deadline=caseDeadline,signal=caseSignal;
    if(!signal)cleanupFailure();remaining(deadline,signal);
    const name=`agent_service_migration_test_0064_${process.pid}_${randomUUID().replaceAll("-","").slice(0,8)}`;
    const [existing]=await admin.query<RowDataPacket[]>("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?",[name]);
    if(existing.length)throw new Error("0064 isolated database already exists");
    remaining(deadline,signal);
    await admin.query(`CREATE DATABASE ${identifier(name)} CHARACTER SET utf8mb4`); owned.add(name);
    const url=at(base,name);let old:MysqlSessionStore|undefined,conn:Connection|undefined,removed=false;
    try {
      remaining(deadline,signal);
      old=await MysqlSessionStore.connect({url,migrationsDir:oldDirectory});
      await old.createApiKey("pre0063-tenant","old-key",createHash("sha256").update("nonsecret-fixture-token").digest("hex"),["admin"]);
      const owner:SkillOwner={scope:"user",tenantId:"pre0063-tenant",userId:"owner"};
      const access=createSkillRegistryAccess({principal:{tenantId:"pre0063-tenant",userId:"owner"},owner,authority:"user_self",access:"manage"});
      const body=Buffer.from("---\nname: example\ndescription: Historical package\n---\nHistorical body.\n");
      const staged=await old.prepareSkillInstallation({access,owner,name:"example",expectedRevision:0,idempotencyKey:"old-ready",backend:"filesystem-v1",
        storageNamespaceSha256:createHash("sha256").update("historical-registry-namespace").digest("hex"),
        admission:createSkillPackageAdmission({owner,metadata:{name:"example",description:"Historical package",whenToUse:null,disableModelInvocation:false,userInvocable:true,dependencies:{tools:[]}},
          sha256:createHash("sha256").update(body).digest("hex"),sizeBytes:body.length,parserProfile:"skill-markdown-v1",guardProfile:"skills-guard-v1"})});
      await old.publishSkillInstallation({access,owner,installationId:staged.installationId,uploadToken:staged.uploadToken,
        descriptor:{storageKey:staged.storageKey,sha256:staged.sha256,sizeBytes:staged.sizeBytes,contentType:staged.contentType}});
      const credentialSubject={tenantId:"pre0063-tenant",userId:"owner"},registrationOwner={scope:"user" as const,tenantId:credentialSubject.tenantId,userId:credentialSubject.userId};
      await old.upsertMcpRegistration(mcpFixtureWrite(registrationOwner,credentialSubject));
      await mcpFixtureExchange(old,registrationOwner,credentialSubject,"historical-authorization");
      await old.createSession(mkSession("pre0063-tenant","owner"));
      await old.close();old=undefined;conn=await mysql.createConnection(url);
      const [target]=await conn.query<RowDataPacket[]>("SELECT @@server_uuid AS server_uuid,DATABASE() AS db");
      if(target.length!==1||String(target[0]?.server_uuid).toLowerCase()!==serverUuid||target[0]?.db!==name)cleanupFailure();
      const [material]=await conn.query<RowDataPacket[]>("SELECT (SELECT COUNT(*) FROM mcp_registry_credentials) AS credentials,(SELECT COUNT(*) FROM mcp_registry_materials) AS materials,(SELECT COUNT(*) FROM skill_registry_versions) AS skills");
      expect(Number(material[0]?.credentials)).toBeGreaterThan(0);expect(Number(material[0]?.materials)).toBeGreaterThan(0);expect(Number(material[0]?.skills)).toBeGreaterThan(0);
      const before=await oldRows(conn);remaining(deadline,signal);await work(conn,url,before);
      remaining(deadline,signal);
      const closing=conn;conn=undefined;await closing.end();remaining(deadline,signal);
      if(!owned.has(name))cleanupFailure();
      await dropOwnedDatabase(admin,name,serverUuid,adminId,deadline,signal);owned.delete(name);removed=true;
    } finally {
      const closed=await Promise.allSettled([old?.close(),conn?.end()]);
      if(!removed)console.warn(JSON.stringify({schema:"subagent-history-cleanup-v1",status:"retained_or_unknown",database:name}));
      if(closed.some(result=>result.status!=="fulfilled"))cleanupFailure();
    }
  }

  it("preserves nonempty predecessor rows and all 818 old native guards while adding the exact domain",async()=>{
    await fixture(async(conn,url,before)=>{
      const [oldTriggers]=await conn.query<RowDataPacket[]>("SELECT * FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY TRIGGER_NAME");
      expect(oldTriggers).toHaveLength(818);
      const upgraded=await MysqlSessionStore.connect({url,migrationsDir:targetDirectory});
      try{expect(await oldRows(conn)).toBe(before);
        const [tables]=await conn.query<RowDataPacket[]>("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'subagent_%' ORDER BY TABLE_NAME");
        expect(tables.map(row=>row.TABLE_NAME)).toEqual([...SUBAGENT_TABLES].sort());
        const [triggers]=await conn.query<RowDataPacket[]>("SELECT * FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME NOT LIKE 'trg_subagent%' ORDER BY TRIGGER_NAME");
        expect(triggers).toEqual(oldTriggers);
        const [counts]=await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()");expect(Number(counts[0]?.n)).toBe(842);
        await upgraded.assertSubagentRuntimeGate(false);
      }finally{await upgraded.close();}
      const cold=await MysqlSessionStore.connect({url,migrationsDir:targetDirectory,migrationMode:"verify"});await cold.close();
    });
  });
  it("rejects marker loss without dropping proofs or reapplying DDL",async()=>{
    await fixture(async(conn,url,before)=>{
      const upgraded=await MysqlSessionStore.connect({url,migrationsDir:targetDirectory});await upgraded.close();
      await conn.query("DELETE FROM schema_migrations WHERE name=?",[SUBAGENT_MIGRATION]);
      const [guards]=await conn.query<RowDataPacket[]>("SELECT TRIGGER_NAME,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY TRIGGER_NAME");
      await expect(MysqlSessionStore.connect({url,migrationsDir:targetDirectory})).rejects.toThrow(SkillRegistryIntegrityError);
      const [after]=await conn.query<RowDataPacket[]>("SELECT TRIGGER_NAME,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY TRIGGER_NAME");
      expect(after).toEqual(guards);expect(await oldRows(conn)).toBe(before);
    });
  });
  it("refuses a table-only auto-committed partial installation instead of replaying CREATE",async()=>{
    await fixture(async(conn,url,before)=>{
      const sql=await readFile(join(migrations,SUBAGENT_MIGRATION),"utf8");
      const statement=sql.split(/;\s*\n/).map(value=>value.replace(/^\s*--.*$/gm,"").trim()).find(value=>value.startsWith("CREATE TABLE subagent_root_turns "));
      expect(statement).toBeDefined();if(!statement)cleanupFailure();await conn.query(statement);
      await expect(MysqlSessionStore.connect({url,migrationsDir:targetDirectory})).rejects.toThrow(SubagentIntegrityError);
      const [tables]=await conn.query<RowDataPacket[]>("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'subagent_%'");
      expect(tables.map(row=>row.TABLE_NAME)).toEqual(["subagent_root_turns"]);expect(await oldRows(conn)).toBe(before);
    });
  });
  it("rejects missing native writer guards at verify-only startup without any implicit repair",async()=>{
    await fixture(async(conn,url,before)=>{
      const upgraded=await MysqlSessionStore.connect({url,migrationsDir:targetDirectory});await upgraded.close();
      await conn.query("DROP TRIGGER trg_subagent_items_bu");
      await expect(MysqlSessionStore.connect({url,migrationsDir:targetDirectory,migrationMode:"verify"})).rejects.toThrow(SkillRegistryIntegrityError);
      const [triggers]=await conn.query<RowDataPacket[]>("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME='trg_subagent_items_bu'");
      expect(triggers).toEqual([]);expect(await oldRows(conn)).toBe(before);
    });
  });
  it("actual published 0063 code writes the predecessor then rejects both verify and apply on 0064 without changing rows, markers or guards",async()=>{
    await fixture(async(conn,url)=>{
      const invoke=(mode:"setup"|"verify"|"apply")=>fixedProcess(process.execPath,["--import","tsx","--input-type=module","-e",frozenProbe],frozenCheckout,
        frozenEnvironment(archiveRoot,{FROZEN_MODE:mode,FROZEN_MYSQL_URL:url}),caseDeadline,caseSignal);
      expect(await invoke("setup")).toBe("frozen-0063-setup-written");
      const [written]=await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM sessions WHERE tenant_id='frozen0063-tenant'");expect(Number(written[0]?.n)).toBe(1);
      const before=await oldRows(conn),upgraded=await MysqlSessionStore.connect({url,migrationsDir:targetDirectory});await upgraded.close();expect(await oldRows(conn)).toBe(before);
      const [markers]=await conn.query<RowDataPacket[]>("SELECT * FROM schema_migrations ORDER BY name");
      const [guards]=await conn.query<RowDataPacket[]>("SELECT * FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY TRIGGER_NAME");expect(guards).toHaveLength(842);
      expect(await invoke("verify")).toBe("frozen-0063-verify-rejected");expect(await invoke("apply")).toBe("frozen-0063-apply-rejected");
      const [afterMarkers]=await conn.query<RowDataPacket[]>("SELECT * FROM schema_migrations ORDER BY name");
      const [afterGuards]=await conn.query<RowDataPacket[]>("SELECT * FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY TRIGGER_NAME");
      expect(afterMarkers).toEqual(markers);expect(afterGuards).toEqual(guards);expect(await oldRows(conn)).toBe(before);
      await conn.query("SET @history0064_binary_gcml=@@SESSION.group_concat_max_len");
      try{await conn.query("SET SESSION group_concat_max_len=1048576");await conn.query(subagentFingerprintStatement(await readFile(join(targetDirectory,SUBAGENT_MIGRATION),"utf8")));
        const [root]=await conn.query<RowDataPacket[]>("SELECT @skill_registry_triggers_ok AS ok");expect(Number(root[0]?.ok)).toBe(1);
      }finally{await conn.query("SET SESSION group_concat_max_len=@history0064_binary_gcml");}
    });
  });
});
