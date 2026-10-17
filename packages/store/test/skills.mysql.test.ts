import { createHash, randomUUID } from "node:crypto";
import mysql, { type Connection, type Pool, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { blobS3Backend } from "@agent-service/protocol";
import { MysqlSessionStore } from "../src/mysql/store.js";
import { MysqlBlobStorageMigrationCoordinator } from "../src/mysql/blob-storage-migration.js";
import { BlobStorageMigrationConflictError } from "../src/blob-storage-migration.js";
import { newErasureRequestId, userErasureRequestHash } from "../src/subject-lifecycle.js";
import { createSkillPackageAdmission, createSkillRegistryAccess, SkillRegistryConflictError, SkillRegistryIntegrityError,
  publishSkillRegistryImage, skillRegistryDigest, type SkillOwner, type SkillInstallation, type SkillVersion, type PrepareSkillInstallationInput } from "../src/skills.js";
import { readMysqlSkillRegistryImage } from "../src/mysql/skills-registry.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const configured = process.env.MYSQL_TEST_URL ?? "mysql://root@127.0.0.1:3306/agent_service_test";
function disposableBase(raw: string) {
  const url = new URL(raw), name = decodeURIComponent(url.pathname.slice(1));
  if (url.protocol !== "mysql:" || !["localhost","127.0.0.1","[::1]"].includes(url.hostname) || !/(?:^|[_-])test(?:$|[_-])/i.test(name)) throw new Error("skill registry fixture requires local disposable MySQL");
  return url;
}
function urlFor(base: URL, name: string) { const url = new URL(base); url.pathname = `/${name}`; return url.toString(); }

function cleanupFailure(): never { throw new Error("skill registry fixture cleanup is not proven"); }
function remaining(deadline: number, signals: readonly AbortSignal[]): number {
  const ms=Math.floor(deadline-performance.now());
  if(ms<=0||signals.some(signal=>signal.aborted))cleanupFailure();return ms;
}
async function dropOwnedDatabase(admin:Connection,database:string,serverUuid:string,adminId:number,deadline:number,signals:readonly AbortSignal[]) {
  if(!/^agent_service_skill_registry_test_[0-9]+_[0-9a-f]{12}$/.test(database))cleanupFailure();
  const query=async(sql:string,values:readonly (string|number)[]=[])=>{
    const [rows]=await admin.query<RowDataPacket[]>({sql,timeout:remaining(deadline,signals)},[...values]);remaining(deadline,signals);return rows;
  };
  const identity=await query("SELECT @@server_uuid AS server_uuid,CONNECTION_ID() AS id,DATABASE() AS db");
  if(identity.length!==1||String(identity[0]?.server_uuid).toLowerCase()!==serverUuid||Number(identity[0]?.id)!==adminId||identity[0]?.db!=="mysql")cleanupFailure();
  const schemas=await query("SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?",[database]);
  if(schemas.length!==1||schemas[0]?.name!==database)cleanupFailure();
  for(;;){
    const connections=await query("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE BINARY DB=BINARY ?",[database]);
    const transactions=await query("SELECT COUNT(*) AS n FROM information_schema.INNODB_TRX t JOIN information_schema.PROCESSLIST p ON p.ID=t.trx_mysql_thread_id WHERE BINARY p.DB=BINARY ?",[database]);
    const metadata=await query("SELECT COUNT(*) AS n FROM performance_schema.metadata_locks WHERE BINARY OBJECT_SCHEMA=BINARY ? OR (OBJECT_TYPE='SCHEMA' AND BINARY OBJECT_NAME=BINARY ?)",[database,database]);
    const counts=[connections,transactions,metadata].map(rows=>rows.length===1?Number(rows[0]?.n):Number.NaN);
    if(counts.some(count=>!Number.isSafeInteger(count)||count<0))cleanupFailure();
    if(counts.every(count=>count===0))break;
    await new Promise<void>(resolve=>setTimeout(resolve,Math.min(10,remaining(deadline,signals))));
  }
  remaining(deadline,signals);
  await admin.query({sql:`DROP DATABASE \`${database}\``,timeout:remaining(deadline,signals)});
  const after=await query("SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?",[database]);
  if(after.length!==1||Number(after[0]?.n)!==0)cleanupFailure();
}

if (process.env.AGENT_SERVICE_INTEGRATION) describe("skill registry isolated real MySQL", () => {
  let admin: Connection, inspect: Connection, store: MysqlSessionStore, second: MysqlSessionStore, database: string, created = false;
  let url: string;
  let setupComplete=false,serverUuid="",adminId=0;
  beforeAll(async () => {
    const deadline=performance.now()+120_000;
    const base = disposableBase(configured); admin = await mysql.createConnection(urlFor(base,"mysql"));
    const [identity]=await admin.query<RowDataPacket[]>("SELECT @@server_uuid AS server_uuid,CONNECTION_ID() AS id,DATABASE() AS db");
    serverUuid=String(identity[0]?.server_uuid).toLowerCase();adminId=Number(identity[0]?.id);
    if(identity.length!==1||!/^[0-9a-f-]{36}$/.test(serverUuid)||!Number.isSafeInteger(adminId)||adminId<1||identity[0]?.db!=="mysql")cleanupFailure();
    database = `agent_service_skill_registry_test_${process.pid}_${randomUUID().replaceAll("-","").slice(0,12)}`;
    const [existing] = await admin.query<RowDataPacket[]>("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?",[database]);
    if (existing.length) throw new Error("skill registry fixture database already exists");
    remaining(deadline,[]);
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`); created = true;
    url = urlFor(base,database); store = await MysqlSessionStore.connect({ url, connectionLimit: 4 });
    second = await MysqlSessionStore.connect({ url, migrationMode: "verify", connectionLimit: 4 });
    inspect = await mysql.createConnection(url);
    const [target]=await inspect.query<RowDataPacket[]>("SELECT @@server_uuid AS server_uuid,DATABASE() AS db");
    if(target.length!==1||String(target[0]?.server_uuid).toLowerCase()!==serverUuid||target[0]?.db!==database)cleanupFailure();
    remaining(deadline,[]);setupComplete=true;
  },120_000);
  afterAll(async ({},suite) => {
    const deadline=performance.now()+120_000;
    const allPassed=setupComplete&&suite.tasks.length===12&&suite.tasks.every(task=>task.type==="test"&&task.mode==="run"&&task.result?.state==="pass"&&
      !task.result.errors?.length&&(task.result.retryCount??0)===0&&(task.result.repeatCount??0)===0&&typeof task.result.duration==="number"&&Number.isFinite(task.result.duration)&&task.result.duration>=0&&task.result.duration<=30_000);
    let removed=false;
    try {
      const closed=await Promise.allSettled([second?.close(),store?.close(),inspect?.end()]);
      if(closed.some(result=>result.status!=="fulfilled"))cleanupFailure();
      remaining(deadline,[]);
      // A filtered, failed, timed-out or incomplete suite preserves its one owned DB.
      if(created&&allPassed){await dropOwnedDatabase(admin,database,serverUuid,adminId,deadline,[]);removed=true;}
    }catch{cleanupFailure();}
    finally{
      if(created&&!removed)console.warn(JSON.stringify({schema:"skill-registry-fixture-cleanup-v1",status:"retained_or_unknown",database}));
      try{await admin?.end();}catch{cleanupFailure();}
    }
  },120_000);
  function fixture(scope: SkillOwner["scope"] = "user") {
    const tenantId = `skills-${randomUUID()}`, userId = "user";
    const owner: SkillOwner = { scope, tenantId: scope === "platform" ? null : tenantId, userId: scope === "user" ? userId : null };
    const access = createSkillRegistryAccess({ principal: { tenantId, userId }, owner,
      authority: scope === "platform" ? "platform_operator" : scope === "tenant" ? "tenant_admin" : "user_self", access: "manage" });
    const prepare = (revision=0,key="first",label="first"): PrepareSkillInstallationInput => ({ access,owner,name:"example",expectedRevision:revision,idempotencyKey:key,
      backend:"filesystem-v1",storageNamespaceSha256:sha("skill-namespace"),admission:createSkillPackageAdmission({ owner,
        metadata:{ name:"example",description:label,whenToUse:null,disableModelInvocation:false,userInvocable:true,dependencies:{tools:[]} },
        sha256:sha(label),sizeBytes:100,parserProfile:"skill-markdown-v1",guardProfile:"skills-guard-v1" }) });
    const publish = (stage: SkillInstallation) => store.publishSkillInstallation({ access,owner,installationId:stage.installationId,uploadToken:stage.uploadToken,
      descriptor:{ storageKey:stage.storageKey,sha256:stage.sha256,sizeBytes:stage.sizeBytes,contentType:stage.contentType } });
    return { owner,access,prepare,publish,tenantId,userId };
  }
  it.each(["user","tenant","platform"] as const)("publishes an independent %s package and exact replay without session blobs",async scope => {
    const f=fixture(scope),input=f.prepare(),stage=await store.prepareSkillInstallation(input);
    expect(stage.state).toBe("staging"); expect(await store.prepareSkillInstallation(input)).toEqual(stage);
    const version=await f.publish(stage); expect(await f.publish(stage)).toEqual(version);
    expect(await second.getReadableSkillVersion({access:f.access,owner:f.owner,name:"example",versionId:null})).toEqual(version);
    const [rows]=await inspect.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM blob_objects WHERE storage_key=?",[stage.storageKey]);
    expect(Number(rows[0]?.n)).toBe(0);
  });
  it("two real pools serialize same-owner CAS, with exactly one winner and exact revision",async () => {
    const f=fixture();
    const result=await Promise.allSettled([store.prepareSkillInstallation(f.prepare(0,"one")),second.prepareSkillInstallation(f.prepare(0,"two"))]);
    expect(result.map(x=>x.status).sort()).toEqual(["fulfilled","rejected"]);
    expect((await store.getSkillSlot({access:f.access,owner:f.owner,name:"example"}))?.revision).toBe(1);
    const winner=result.find(x=>x.status==="fulfilled"); if(!winner||winner.status!=="fulfilled")throw new Error("missing CAS winner");
    await f.publish(winner.value);
    expect((await store.listSkillVersions({access:f.access,owner:f.owner,name:"example",cursor:null,limit:100})).items).toHaveLength(1);
  });
  it("different new owners both publish concurrently without missing-key gap retries",async()=>{
    const left=fixture(),right=fixture();
    const [a,b]=await Promise.all([store.prepareSkillInstallation(left.prepare()),second.prepareSkillInstallation(right.prepare())]);
    const [first,last]=await Promise.all([left.publish(a),right.publish(b)]);
    expect(first.owner).toEqual(left.owner);expect(last.owner).toEqual(right.owner);
    expect(await second.getReadableSkillVersion({access:left.access,owner:left.owner,name:"example",versionId:null})).toEqual(first);
    expect(await store.getReadableSkillVersion({access:right.access,owner:right.owner,name:"example",versionId:null})).toEqual(last);
  });
  it("samples mutation DB time after a proven owner-lock wait and intervening native publication",async()=>{
    const f=fixture(),first=await store.prepareSkillInstallation(f.prepare());
    const ownerSha=skillRegistryDigest("skill-registry-owner-v1",f.owner);
    const holder=await (Reflect.get(store,"pool") as Pool).getConnection();
    let pending: Promise<SkillInstallation>|undefined;
    try {
      await holder.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");await holder.beginTransaction();
      await holder.query("SELECT owner_sha256 FROM skill_registry_owners WHERE owner_sha256=? FOR UPDATE",[ownerSha]);
      pending=second.prepareSkillInstallation(f.prepare(1,"after-wait","second"));
      // Attach a rejection observer immediately; do not replace the actual result.
      void pending.catch(()=>{});
      let waiting=false;const deadline=Date.now()+2_000;
      while(Date.now()<deadline){
        const [rows]=await inspect.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits w
          JOIN performance_schema.data_locks r ON r.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID AND r.ENGINE=w.ENGINE
          WHERE r.OBJECT_SCHEMA=? AND r.OBJECT_NAME='skill_registry_owners' AND r.INDEX_NAME='PRIMARY' AND r.LOCK_DATA LIKE ?`,[database,`%${ownerSha}%`]);
        if(Number(rows[0]?.n)>0){waiting=true;break;}
        await new Promise<void>(resolve=>setTimeout(resolve,10));
      }
      expect(waiting).toBe(true);
      // Advance through real native guards using an actual already-admitted stage.
      // This SQL-shaped writer is only a concurrency fixture, not a second API proof.
      await holder.query("DO SLEEP(0.02)");
      const image=await readMysqlSkillRegistryImage(holder,f.owner,true);
      const [clock]=await holder.query<RowDataPacket[]>("SELECT CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED) AS now_ms");
      const published=publishSkillRegistryImage(image,{access:f.access,owner:f.owner,installationId:first.installationId,uploadToken:first.uploadToken,
        descriptor:{storageKey:first.storageKey,sha256:first.sha256,sizeBytes:first.sizeBytes,contentType:first.contentType}},Number(clock[0]?.now_ms));
      const manifest=image.installations.find(row=>row.installationId===first.installationId)!;
      const slot=image.slots.find(row=>row.slotId===first.slotId)!;
      await holder.query("INSERT INTO skill_registry_versions (version_id,owner_sha256,slot_id,revision,generation,installation_id,version_sha256,record_json) VALUES (?,?,?,?,?,?,?,?)",
        [published.versionId,ownerSha,published.slotId,published.revision,published.generation,published.installationId,published.versionSha256,JSON.stringify(published)]);
      await holder.query("UPDATE skill_registry_installations SET state=?,version_id=?,record_json=? WHERE installation_id=? AND state='staging'",[manifest.state,manifest.versionId,JSON.stringify(manifest),manifest.installationId]);
      await holder.query("UPDATE skill_registry_slots SET current_version_id=?,updated_at_ms=?,record_json=? WHERE slot_id=? AND revision=1",[slot.currentVersionId,slot.updatedAtMs,JSON.stringify(slot),slot.slotId]);
      await holder.commit();
      const next=await pending;expect(next.revision).toBe(2);expect(next.createdAtMs).toBeGreaterThanOrEqual(published.createdAtMs);
      expect((await store.getSkillSlot({access:f.access,owner:f.owner,name:"example"}))?.currentVersionId).toBe(published.versionId);
    }finally{
      await holder.rollback().catch(()=>{});holder.release();await pending?.catch(()=>{});
    }
  });
  it("rejects same idempotency key with another body/namespace and wrong original authority",async()=>{
    const f=fixture(),input=f.prepare(); await store.prepareSkillInstallation(input);
    await expect(store.prepareSkillInstallation(f.prepare(0,"first","changed"))).rejects.toThrow(SkillRegistryConflictError);
    await expect(store.prepareSkillInstallation({...input,storageNamespaceSha256:sha("other")})).rejects.toThrow(SkillRegistryConflictError);
    await expect(store.prepareSkillInstallation({...input,owner:{...f.owner,userId:"foreign"}})).rejects.toThrow(SkillRegistryIntegrityError);
    await expect(store.prepareSkillInstallation({...input,access:structuredClone(f.access)})).rejects.toThrow(SkillRegistryIntegrityError);
  });
  it("native late SQL failure rolls back version, ready manifest, and current slot together",async()=>{
    const f=fixture(),stage=await store.prepareSkillInstallation(f.prepare());
    await inspect.query("CREATE TRIGGER skill_registry_test_late_failure BEFORE UPDATE ON skill_registry_installations FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected skill publish failure'");
    try { await expect(f.publish(stage)).rejects.toMatchObject({code:"ER_SIGNAL_EXCEPTION"}); }
    finally { await inspect.query("DROP TRIGGER skill_registry_test_late_failure"); }
    const [versions]=await inspect.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM skill_registry_versions WHERE installation_id=?",[stage.installationId]);
    const [installs]=await inspect.query<RowDataPacket[]>("SELECT state,version_id FROM skill_registry_installations WHERE installation_id=?",[stage.installationId]);
    expect(Number(versions[0]?.n)).toBe(0); expect(installs[0]?.state).toBe("staging"); expect(installs[0]?.version_id).toBeNull();
    expect((await f.publish(stage)).installationId).toBe(stage.installationId);
  });
  it("retains permanent deletion revision, prevents ABA/replay, and exports historical ready generations",async()=>{
    const f=fixture(),input=f.prepare(),stage=await store.prepareSkillInstallation(input),old=await f.publish(stage);
    const deletion={access:f.access,owner:f.owner,name:"example",expectedRevision:1,idempotencyKey:"delete"};
    const deleted=await store.deleteSkillSlot(deletion); expect(await second.deleteSkillSlot(deletion)).toEqual(deleted);
    expect(deleted.revision).toBe(2);
    expect(await store.getReadableSkillVersion({access:f.access,owner:f.owner,name:"example",versionId:old.versionId})).toBeNull();
    await expect(f.publish(stage)).rejects.toThrow(SkillRegistryConflictError);
    await expect(store.prepareSkillInstallation(input)).rejects.toThrow(SkillRegistryConflictError);
    const next=await store.prepareSkillInstallation(f.prepare(2,"recreated")); expect(next.generation).toBe(2); await f.publish(next);
    expect(await store.getReadableSkillVersion({access:f.access,owner:f.owner,name:"example",versionId:old.versionId})).toBeNull();
    const snapshot=await store.listUserSkillExportSnapshot({access:f.access,owner:f.owner});
    expect(snapshot.versions).toHaveLength(2);expect(snapshot.packages).toHaveLength(2);expect(snapshot.physicalErasureComplete).toBe(false);
  });
  it("actual user T1 blocks ordinary reads/publish/export and native SQL version insertion",async()=>{
    const f=fixture(),stage=await store.prepareSkillInstallation(f.prepare());
    const pool=Reflect.get(store,"pool") as Pool;
    const conn=await pool.getConnection(); let version: SkillVersion;
    try { const image=await readMysqlSkillRegistryImage(conn,f.owner); version=publishSkillRegistryImage(image,{access:f.access,owner:f.owner,installationId:stage.installationId,uploadToken:stage.uploadToken,
      descriptor:{storageKey:stage.storageKey,sha256:stage.sha256,sizeBytes:stage.sizeBytes,contentType:stage.contentType}},Date.now()); } finally {conn.release();}
    await store.requestUserErasure({requestId:newErasureRequestId(),tenantId:f.tenantId,userId:f.userId,requestedByKeyId:"skill-test",idempotencyKey:"erase",requestHash:userErasureRequestHash(f.tenantId,f.userId),atMs:Date.now()});
    await expect(f.publish(stage)).rejects.toThrow();
    await expect(store.getReadableSkillVersion({access:f.access,owner:f.owner,name:"example",versionId:null})).rejects.toThrow();
    await expect(store.listUserSkillExportSnapshot({access:f.access,owner:f.owner})).rejects.toThrow();
    const ownerSha=(await inspect.query<RowDataPacket[]>("SELECT owner_sha256 FROM skill_registry_installations WHERE installation_id=?",[stage.installationId]))[0][0]?.owner_sha256;
    await expect(inspect.query("INSERT INTO skill_registry_versions (version_id,owner_sha256,slot_id,revision,generation,installation_id,version_sha256,record_json) VALUES (?,?,?,?,?,?,?,?)",
      [version.versionId,ownerSha,version.slotId,version.revision,version.generation,version.installationId,version.versionSha256,JSON.stringify(version)])).rejects.toMatchObject({code:"ER_SIGNAL_EXCEPTION"});
  });
  it("native SQL cannot mutate or delete retained ready versions and permanent slots",async()=>{
    const f=fixture(),stage=await store.prepareSkillInstallation(f.prepare()),version=await f.publish(stage);
    await expect(inspect.query("UPDATE skill_registry_versions SET generation=generation+1 WHERE version_id=?",[version.versionId])).rejects.toMatchObject({code:"ER_SIGNAL_EXCEPTION"});
    await expect(inspect.query("DELETE FROM skill_registry_versions WHERE version_id=?",[version.versionId])).rejects.toMatchObject({code:"ER_SIGNAL_EXCEPTION"});
    await expect(inspect.query("DELETE FROM skill_registry_slots WHERE slot_id=?",[stage.slotId])).rejects.toMatchObject({code:"ER_SIGNAL_EXCEPTION"});
    expect(await store.getReadableSkillVersion({access:f.access,owner:f.owner,name:"example",versionId:null})).toEqual(version);
  });
  it("old blob mover freeze refuses registry footprints with no partial control phase",async()=>{
    const f=fixture(); await store.prepareSkillInstallation(f.prepare());
    const mover=await MysqlBlobStorageMigrationCoordinator.connect({url});
    try {
      const before=await mover.getControl();
      await expect(mover.freeze({migrationId:`skill-${randomUUID()}`,expectedControlGeneration:before.controlGeneration,sourceBackend:"filesystem-v1",
        sourceNamespaceSha256:sha("source"),targetBackend:blobS3Backend(sha("target")),targetNamespaceSha256:sha("target"),rollbackWindowMs:0,sourceCleanupDelayMs:0,fleetDrainedEvidenceSha256:sha("fleet")})).rejects.toThrow(BlobStorageMigrationConflictError);
      expect(await mover.getControl()).toEqual(before);
    } finally { await mover.close(); }
  });
});
else describe.skip("skill registry isolated real MySQL",()=>{it("requires explicit integration profile",()=>{});});
