import { randomUUID } from "node:crypto";
import {type Pool,type RowDataPacket} from "mysql2/promise";
import {emptyUsage,type Item,type Turn} from "@agent-service/protocol";
import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
import { MysqlSessionStore } from "../src/mysql/store.js";
import * as W from "../src/tenant-webhooks.js";
import {newErasureRequestId,SubjectDeletingError,tenantErasureRequestHash,userErasureRequestHash} from "../src/subject-lifecycle.js";
import {webhookWrite,webhookMilestone as legacyWebhookMilestone,webhookCommit,webhookSha} from "./fixtures/tenant-webhooks.js";
import {attachSessionWriteAdmission} from "../src/session-authority.js";
import { CurrentMysqlRuntimeOwner, type CurrentMysqlInspection } from "./fixtures/current-mysql-runtime.js";
import { acquireFixtureSessionAuthority } from "./fixtures/session-authority.js";

import {mkSession,newId} from "./conformance.js";

const baseInput = process.env.MYSQL_TEST_URL ?? "mysql://root@127.0.0.1:3306/agent_service_test";

type FixtureTask = { type: string; mode?: string; tasks?: readonly FixtureTask[];
  result?: { state: string; errors?: readonly unknown[]; retryCount?: number; repeatCount?: number; duration?: number } };
function successfulFixtureTasks(tasks: readonly FixtureTask[], expected: number): boolean {
  const leaves = (entries: readonly FixtureTask[]): FixtureTask[] => entries.flatMap(entry => entry.type === "suite" ? leaves(entry.tasks ?? []) : [entry]);
  const tests = leaves(tasks);
  return tests.length === expected && tests.every(task => task.type === "test" && task.mode === "run"
    && task.result?.state === "pass" && !task.result.errors?.length
    && (task.result.retryCount ?? 0) === 0 && (task.result.repeatCount ?? 0) === 0
    && typeof task.result.duration === "number" && task.result.duration <= 30_000);
}

// Current SQL fixture: the same genuine P1 authorizes runtime access and milestone batches across both pools.
async function webhookSession(store: MysqlSessionStore, tenantId = `hook-${randomUUID()}`, userId = "owner") {
  const keyId = `key-${randomUUID()}`;
  await store.createApiKey(tenantId,keyId,webhookSha(randomUUID()),["admin"]);
  const owner = { tenantId,userId }, admin = W.createTenantWebhookAdminAccess({ tenantId,apiKeyId:keyId });
  const session = mkSession(tenantId,userId); await store.createSession(session);
  const lease = await acquireFixtureSessionAuthority(store, session, 0);
  const access = attachSessionWriteAdmission(W.createTenantWebhookRuntimeAccess(owner), lease.proof);
  const turn: Turn = { id:newId("turn"),sessionId:session.id,status:"inProgress",seqStart:0,steps:0,toolCalls:0,usage:emptyUsage(),startedAtMs:Date.now() };
  const user: Extract<Item,{type:"userMessage"}> = { id:newId("item"),sessionId:session.id,turnId:turn.id,seq:0,type:"userMessage",status:"completed",createdAtMs:Date.now(),content:[{type:"text",text:"original user text"}] };
  const call: Extract<Item,{type:"toolCall"}> = { id:newId("item"),sessionId:session.id,turnId:turn.id,seq:0,type:"toolCall",status:"inProgress",createdAtMs:Date.now(),toolCallId:"call_reusable",name:"echo",kind:"builtin",args:{text:"tool argument"} };
  await store.commit(lease.admit({ sessionId:session.id,fence:1,turn,items:[user,call],events:[
    {type:"turn/started",sessionId:session.id,turn,emittedAtMs:Date.now()},
    {type:"item/completed",sessionId:session.id,item:user,emittedAtMs:Date.now()},
    {type:"item/started",sessionId:session.id,item:call,emittedAtMs:Date.now()},
  ] }));
  return { store,owner,admin,access,session,turn,user,call,lease };
}
async function webhookMilestone(f: Awaited<ReturnType<typeof webhookSession>>, kind: "pre"|"started"|"post", unavailable = false) {
  const plan = await legacyWebhookMilestone(f, kind, unavailable);
  attachSessionWriteAdmission(plan.batch, f.lease.proof);
  // Reissue the ordinary W admission from the same genuine source after attaching P1,
  // so its captured batch also preserves the exact opaque write proof. No payload or digest changes.
  const { source, batch, snapshots, payloads, failures, canonicalResult } = plan;
  return { ...plan, admission: W.createTenantWebhookMilestoneAdmission({ source, kind, batch, snapshots, payloads, failures, canonicalResult }) };
}

describe.skipIf(!process.env.AGENT_SERVICE_INTEGRATION)("Tenant webhook v2 isolated actual MySQL",()=>{
  let owner: CurrentMysqlRuntimeOwner, inspect: CurrentMysqlInspection, store: MysqlSessionStore, second: MysqlSessionStore;
  let setupComplete = false;
  beforeAll(async () => {
    owner = new CurrentMysqlRuntimeOwner(baseInput);
    await owner.prepare();
    store = await owner.openStore(4);
    second = await owner.openStore(4);
    inspect = await owner.openInspection();
    setupComplete = true;
  }, 120_000);
  afterAll(async ({}, suite) => {
    await owner?.close({ successful: setupComplete && successfulFixtureTasks(suite.tasks, 19) });
  }, 120_000);

  it("publishes encrypted config and exact management replay without leaking authority across tenants",async()=>{
    const f=await webhookSession(store),first=await store.upsertTenantWebhook(webhookWrite(f.admin));
    expect(await second.upsertTenantWebhook(webhookWrite(f.admin))).toEqual(first);
    const other=await webhookSession(second);expect(await second.getTenantWebhookRuntimePolicy({access:other.access})).toEqual([]);
    expect((await second.getTenantWebhookRuntimePolicy({access:f.access}))[0]?.configVersionId).toBe(first.version!.configVersionId);
    await expect(second.upsertTenantWebhook({...webhookWrite(f.admin),access:structuredClone(f.admin)})).rejects.toThrow(W.TenantWebhookIntegrityError);
    const next=await second.upsertTenantWebhook(webhookWrite(f.admin,"observer",1,"v2"));expect(next.slot.revision).toBe(2);expect(next.version?.configVersionId).not.toBe(first.version?.configVersionId);
  });
  it("concurrent real management lists retain shared locks without X-upgrade deadlocks",async()=>{
    const f=await webhookSession(store);await store.upsertTenantWebhook(webhookWrite(f.admin));
    const input={access:f.admin,cursor:null,limit:100};const [a,b]=await Promise.all([store.listTenantWebhooks(input),second.listTenantWebhooks(input)]);
    expect(a).toEqual(b);expect(a.items).toHaveLength(1);
  });
  it("first publication accepts SQL NULL time history while native timestamp regressions preserve exact slot bytes",async()=>{
    const f=await webhookSession(store),first=await store.upsertTenantWebhook(webhookWrite(f.admin));
    expect(first.slot).toMatchObject({revision:1,generation:1,state:"enabled"});
    expect(first.slot.createdAtMs).toBe(first.slot.updatedAtMs);expect(first.slot.currentVersionId).toBe(first.version!.configVersionId);
    // Advance the real database clock so updatedAt-1 remains >= createdAt. The
    // updated-time negative then isolates p17 rather than the new-row floor p18.
    await inspect.query("DO SLEEP(0.01)");
    const current=await second.upsertTenantWebhook(webhookWrite(f.admin,"observer",1,"second-version"));
    expect(current.slot.revision).toBe(2);expect(current.slot.createdAtMs).toBe(first.slot.createdAtMs);
    expect(current.slot.updatedAtMs).toBeGreaterThan(current.slot.createdAtMs);
    const readBytes=async()=>{const [rows]=await inspect.query<RowDataPacket[]>("SELECT webhook_id,tenant_id,name,state,SHA2(CAST(record_json AS BINARY),256) AS record_sha256 FROM tenant_webhook_slots WHERE webhook_id=?",[current.slot.webhookId]);return rows;};
    const before=await readBytes(),valid={...current.slot,revision:3,state:"disabled" as const};
    // Prove the same revision/generation/state/current-version tuple is a valid
    // native transition. Roll it back before varying only the time predicate.
    await inspect.query("START TRANSACTION");
    try {await inspect.query("UPDATE tenant_webhook_slots SET state=?,record_json=? WHERE webhook_id=?",[valid.state,JSON.stringify(valid),valid.webhookId]);}
    finally {await inspect.query("ROLLBACK");}
    expect(await readBytes()).toEqual(before);
    await expect(inspect.query("UPDATE tenant_webhook_slots SET state=?,record_json=? WHERE webhook_id=?",[valid.state,JSON.stringify({...valid,createdAtMs:valid.createdAtMs-1}),valid.webhookId])).rejects.toThrow("Tenant webhook row is immutable");
    expect(await readBytes()).toEqual(before);
    await expect(inspect.query("UPDATE tenant_webhook_slots SET state=?,record_json=? WHERE webhook_id=?",[valid.state,JSON.stringify({...valid,updatedAtMs:valid.updatedAtMs-1}),valid.webhookId])).rejects.toThrow("Tenant webhook row is immutable");
    expect(await readBytes()).toEqual(before);
    const next=await store.setTenantWebhookState({access:f.admin,name:"observer",expectedRevision:2,idempotencyKey:"valid-disable",state:"disabled"});
    expect(next).toMatchObject({revision:3,generation:1,state:"disabled",createdAtMs:current.slot.createdAtMs,currentVersionId:current.slot.currentVersionId});
    expect(next.updatedAtMs).toBeGreaterThanOrEqual(current.slot.updatedAtMs);
  });
  it("two independent pools preserve CAS, immutable versions and permanent delete/recreate generation",async()=>{
    const f=await webhookSession(store),outcomes=await Promise.allSettled([store.upsertTenantWebhook(webhookWrite(f.admin)),second.upsertTenantWebhook(webhookWrite(f.admin,"observer",0,"other"))]);
    expect(outcomes.map(o=>o.status).sort()).toEqual(["fulfilled","rejected"]);
    const gone=await store.setTenantWebhookState({access:f.admin,name:"observer",expectedRevision:1,idempotencyKey:"delete",state:"deleted"});
    await expect(second.upsertTenantWebhook(webhookWrite(f.admin))).rejects.toThrow(W.TenantWebhookConflictError);
    const next=await second.upsertTenantWebhook(webhookWrite(f.admin,"observer",gone.revision,"recreate",undefined,2));expect(next.slot).toMatchObject({revision:3,generation:2});
    const [versions]=await inspect.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM tenant_webhook_versions WHERE webhook_id=?",[next.slot.webhookId]);expect(Number(versions[0]?.n)).toBe(2);
  });
  it("different Unicode tenants publish concurrently without cross-owner serialization or aliasing",async()=>{
    const a=await webhookSession(store,"中".repeat(100)),b=await webhookSession(second,"文".repeat(100));
    const [first,last]=await Promise.all([store.upsertTenantWebhook(webhookWrite(a.admin)),second.upsertTenantWebhook(webhookWrite(b.admin))]);
    expect(first.slot.webhookId).not.toBe(last.slot.webhookId);expect((await store.getTenantWebhookRuntimePolicy({access:a.access}))[0]?.configVersionId).toBe(first.version!.configVersionId);
    expect((await second.getTenantWebhookRuntimePolicy({access:b.access}))[0]?.configVersionId).toBe(last.version!.configVersionId);
  });
  it("fresh source prefix pins earlier text and excludes later committed steer and unused bodies",async()=>{
    const f=await webhookSession(store);await store.upsertTenantWebhook(webhookWrite(f.admin));
    const metadata=await store.readTenantWebhookSources({access:f.access,sessionId:f.session.id,turnId:f.turn.id,callItemId:f.call.id,fence:1});
    expect(metadata.value.prompt.parts).toEqual([]);expect(metadata.value.arguments).toBeNull();
    await store.upsertTenantWebhook(webhookWrite(f.admin,"observer",1,"body",{endpoint:"https://hooks.example.test/observe",phase:"postToolUse",bodyScopes:["prompt","tool_arguments"]}));
    const plan=await webhookMilestone(f,"started"),through=plan.source.value.throughSeq;
    const steer={...f.user,id:newId("item"),seq:0,content:[{type:"text" as const,text:"later text"}]};
    await second.commit(f.lease.admit({sessionId:f.session.id,fence:1,items:[steer],events:[{type:"item/completed",sessionId:f.session.id,item:steer,emittedAtMs:Date.now()}]}));
    await webhookCommit(store,plan);
    const source=await store.readTenantWebhookSources({access:f.access,sessionId:f.session.id,turnId:f.turn.id,callItemId:f.call.id,fence:1});
    expect(source.value.startedSnapshots[0]?.throughSeq).toBe(through);expect(source.value.prompt.parts).toEqual([]);expect(source.value.arguments).toBeNull();
  });
  it("ordinary and native starts cannot bypass active policy, but real started/result intents commit atomically",async()=>{
    const f=await webhookSession(store);await store.upsertTenantWebhook(webhookWrite(f.admin));
    const started={...f.call,startedAtMs:Date.now()};
    await expect(store.commit(f.lease.admit({sessionId:f.session.id,fence:1,items:[started],events:[]}))).rejects.toThrow(W.TenantWebhookIntegrityError);
    await expect(inspect.query("UPDATE items SET body=? WHERE item_id=?",[JSON.stringify(started),f.call.id])).rejects.toThrow("Tenant webhook milestone admission is required");
    await webhookCommit(store,await webhookMilestone(f,"started"));
    const post=await webhookMilestone(f,"post"),before=await store.readEvents(f.session.id,0,100);
    await expect(store.commit(f.lease.admit(post.batch))).rejects.toThrow(W.TenantWebhookIntegrityError);expect(await store.readEvents(f.session.id,0,100)).toEqual(before);
    const resultItem=post.batch.items![0]!;
    await expect(inspect.query("INSERT INTO items(item_id,session_id,user_id,turn_id,seq,type,status,body,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?)",[resultItem.id,f.session.id,f.owner.userId,f.turn.id,999,"toolResult","completed",JSON.stringify({...resultItem,seq:999}),Date.now()])).rejects.toThrow("Tenant webhook milestone admission is required");
    const committed=await webhookCommit(store,post),intent=committed.tenantWebhookIntents[0]!;
    const [rows]=await inspect.query<RowDataPacket[]>("SELECT i.type,d.state FROM items i JOIN tenant_webhook_intents d ON JSON_UNQUOTE(JSON_EXTRACT(d.record_json,'$.resultItemId'))=i.item_id WHERE d.intent_id=?",[intent.intentId]);
    expect(rows).toEqual([{type:"toolResult",state:"prepared"}]);
    const claim=await second.claimTenantWebhookDelivery({access:f.access,intentId:intent.intentId,timeoutMs:1000});expect(Boolean(claim)).toBe(true);
    expect(await store.claimTenantWebhookDelivery({access:f.access,intentId:intent.intentId,timeoutMs:1000})).toBeNull();
  });
  it.each(["update","disable","delete","disable-enable"] as const)("mid-tool %s preserves canonical result and irrevocably blocks the old delivery",async change=>{
    const f=await webhookSession(store),old=await store.upsertTenantWebhook(webhookWrite(f.admin));await webhookCommit(store,await webhookMilestone(f,"started"));
    if(change==="update")await second.upsertTenantWebhook(webhookWrite(f.admin,"observer",1,"new-version"));
    else {await second.setTenantWebhookState({access:f.admin,name:"observer",expectedRevision:1,idempotencyKey:change,state:change==="delete"?"deleted":"disabled"});
      if(change==="disable-enable")await second.setTenantWebhookState({access:f.admin,name:"observer",expectedRevision:2,idempotencyKey:"enable",state:"enabled"});}
    const post=await webhookMilestone(f,"post"),result=await webhookCommit(store,post),intent=result.tenantWebhookIntents[0]!;
    expect(intent).toMatchObject({configVersionId:old.version!.configVersionId,state:"blocked"});
    const [rows]=await inspect.query<RowDataPacket[]>("SELECT type FROM items WHERE item_id=?",[post.canonicalResult!.itemId]);expect(rows).toEqual([{type:"toolResult"}]);
    expect(await second.claimTenantWebhookDelivery({access:f.access,intentId:intent.intentId,timeoutMs:1000})).toBeNull();
  });
  it("a genuine COMMIT rejection rolls back canonical result, intent and post milestone together",async()=>{
    const f=await webhookSession(store);await store.upsertTenantWebhook(webhookWrite(f.admin));await webhookCommit(store,await webhookMilestone(f,"started"));
    const post=await webhookMilestone(f,"post"),pool=Reflect.get(store,"pool") as Pool;
    const originalGetConnection=pool.getConnection,seen=new Set<Awaited<ReturnType<Pool["getConnection"]>>>();
    const commitSpies:{mockRestore():void}[]=[];let commitCalls=0,rejectNextCommit=true;
    // The current subagent front read also checks out a connection. Instrument every actual
    // guarded checkout so that only the real business COMMIT consumes the injected rejection.
    const acquisition=vi.spyOn(pool,"getConnection").mockImplementation(async(...args:Parameters<Pool["getConnection"]>)=>{
      const conn=await originalGetConnection.apply(pool,args);
      if(!seen.has(conn)){seen.add(conn);const originalCommit=conn.commit;
        commitSpies.push(vi.spyOn(conn,"commit").mockImplementation(async(...commitArgs:Parameters<typeof originalCommit>)=>{
          commitCalls++;if(rejectNextCommit){rejectNextCommit=false;throw new Error("injected webhook commit failure");}
          return originalCommit.apply(conn,commitArgs);
        }));}
      return conn;
    });
    try {await expect(webhookCommit(store,post)).rejects.toThrow("injected webhook commit failure");expect(commitCalls).toBe(1);}
    finally{acquisition.mockRestore();for(const commit of commitSpies)commit.mockRestore();}
    const [rows]=await inspect.query<RowDataPacket[]>("SELECT item_id FROM items WHERE item_id=?",[post.canonicalResult!.itemId]);expect(rows).toHaveLength(0);
    expect((await second.listTenantWebhookDeliveries({access:f.admin,name:"observer",cursor:null,limit:100})).items).toEqual([]);
    const [milestones]=await inspect.query<RowDataPacket[]>("SELECT milestone_id FROM tenant_webhook_milestones WHERE call_item_id=? AND kind='post'",[f.call.id]);expect(milestones).toHaveLength(0);
  });
  it("actual DB lease expiry seals first late finish unknown and exact-replays without a second send",async()=>{
    const f=await webhookSession(store);await store.upsertTenantWebhook(webhookWrite(f.admin,"observer",0,"pre",{endpoint:"https://hooks.example.test/observe",phase:"preToolUse",bodyScopes:[]}));
    const intent=(await webhookCommit(store,await webhookMilestone(f,"pre"))).tenantWebhookIntents[0]!,claim=await store.claimTenantWebhookDelivery({access:f.access,intentId:intent.intentId,timeoutMs:1});if(!claim)throw new Error("claim missing");
    await inspect.query("DO SLEEP(0.01)");
    const input={access:f.access,intentId:intent.intentId,claimToken:claim.claimToken,outcome:"acknowledged" as const,resultSha256:webhookSha("late-ack")};
    const terminal=await second.finishTenantWebhookDelivery(input);expect(terminal.state).toBe("outcome_unknown");expect(await store.finishTenantWebhookDelivery(input)).toEqual(terminal);
    expect((await second.getTenantWebhookDelivery({access:f.access,intentId:intent.intentId}))?.state).toBe("outcome_unknown");expect(await store.claimTenantWebhookDelivery({access:f.access,intentId:intent.intentId,timeoutMs:1000})).toBeNull();
  });
  it.each(["get","reconcile"] as const)("actual expired sending receipt stays unknown when %s wins before the first legal finish",async settle=>{
    const f=await webhookSession(store);await store.upsertTenantWebhook(webhookWrite(f.admin,"observer",0,"pre",{endpoint:"https://hooks.example.test/observe",phase:"preToolUse",bodyScopes:[]}));
    const intent=(await webhookCommit(store,await webhookMilestone(f,"pre"))).tenantWebhookIntents[0]!,claim=await store.claimTenantWebhookDelivery({access:f.access,intentId:intent.intentId,timeoutMs:1});if(!claim)throw new Error("claim missing");
    await inspect.query("DO SLEEP(0.01)");if(settle==="get")await second.getTenantWebhookDelivery({access:f.access,intentId:intent.intentId});else await second.reconcileTenantWebhookDeliveries({cursor:null,limit:100});
    const before=await second.getTenantWebhookDelivery({access:f.access,intentId:intent.intentId});expect(before?.state).toBe("outcome_unknown");expect(before?.finishRequestSha256).toBeNull();
    const input={access:f.access,intentId:intent.intentId,claimToken:claim.claimToken,outcome:"acknowledged" as const,resultSha256:webhookSha("late")},terminal=await store.finishTenantWebhookDelivery(input);
    expect({...terminal,finishRequestSha256:null}).toEqual(before);expect(await second.finishTenantWebhookDelivery(input)).toEqual(terminal);
    await expect(store.finishTenantWebhookDelivery({...input,outcome:"outcome_unknown"})).rejects.toThrow(W.TenantWebhookConflictError);
  });
  it("local phase abandonment CAS never fabricates sending or changes an existing sending request",async()=>{
    const f=await webhookSession(store),config:W.TenantWebhookConfig={endpoint:"https://hooks.example.test/observe",phase:"preToolUse",bodyScopes:[]};
    await store.upsertTenantWebhook(webhookWrite(f.admin,"first",0,"install",config));await store.upsertTenantWebhook(webhookWrite(f.admin,"second",0,"install",config));
    const intents=(await webhookCommit(store,await webhookMilestone(f,"pre"))).tenantWebhookIntents,claim=await store.claimTenantWebhookDelivery({access:f.access,intentId:intents[0]!.intentId,timeoutMs:1000});if(!claim)throw new Error("claim missing");
    expect(await second.abandonPreparedTenantWebhookDelivery({access:f.access,intentId:claim.intent.intentId})).toEqual(claim.intent);
    const terminal=await second.abandonPreparedTenantWebhookDelivery({access:f.access,intentId:intents[1]!.intentId});expect(terminal).toMatchObject({state:"failed_not_dispatched",claimTokenSha256:null});
    expect(await store.claimTenantWebhookDelivery({access:f.access,intentId:intents[1]!.intentId,timeoutMs:1000})).toBeNull();
  });
  it("fresh T1 blocks actual-user reads and native active owner writes",async()=>{
    const f=await webhookSession(store),slot=await store.upsertTenantWebhook(webhookWrite(f.admin));
    await store.requestUserErasure({requestId:newErasureRequestId(),...f.owner,requestedByKeyId:"test",idempotencyKey:randomUUID(),requestHash:userErasureRequestHash(f.owner.tenantId,f.owner.userId),atMs:Date.now()});
    await expect(second.getTenantWebhookRuntimePolicy({access:f.access})).rejects.toThrow(SubjectDeletingError);
    await expect(inspect.query("UPDATE tenant_webhook_slots SET record_json=record_json WHERE webhook_id=?",[slot.slot.webhookId])).rejects.toThrow("Tenant webhook row is immutable");
  });
  it("tenant footprint blocks old T3a while unrelated canonical tenant remains supported",async()=>{
    const f=await webhookSession(store);await store.upsertTenantWebhook(webhookWrite(f.admin));
    async function claim(tenantId:string){const requestId=newErasureRequestId();await store.requestTenantErasure({requestId,tenantId,requestedByKeyId:"test",idempotencyKey:randomUUID(),requestHash:tenantErasureRequestHash(tenantId),atMs:Date.now()});
      const c=(await store.claimTenantCredentialRevocations({limit:100,leaseMs:120000,claimToken:randomUUID()})).find(x=>x.requestId===requestId);if(!c)throw new Error("claim missing");
      return {requestId:c.requestId,tenantId:c.tenantId,subjectGeneration:c.subjectGeneration,claimAttempt:c.claimAttempt,claimToken:c.claimToken};}
    const unrelated=await webhookSession(second);expect(await store.revokeTenantCredentialMaterial(await claim(unrelated.owner.tenantId))).not.toBeNull();
    await expect(store.revokeTenantCredentialMaterial(await claim(f.owner.tenantId))).rejects.toThrow(W.TenantWebhookLifecycleBlockedError);
  });
  it("cold verify audits nonempty immutable sources and terminal intent without replaying an HTTP attempt",async()=>{
    const f=await webhookSession(store);await store.upsertTenantWebhook(webhookWrite(f.admin));await webhookCommit(store,await webhookMilestone(f,"started"));
    const intent=(await webhookCommit(store,await webhookMilestone(f,"post"))).tenantWebhookIntents[0]!,claim=await store.claimTenantWebhookDelivery({access:f.access,intentId:intent.intentId,timeoutMs:1000});if(!claim)throw new Error("claim missing");
    await store.finishTenantWebhookDelivery({access:f.access,intentId:intent.intentId,claimToken:claim.claimToken,outcome:"acknowledged",resultSha256:webhookSha("ack")});
    const cold=await owner.openStore(2);try{expect((await cold.getTenantWebhookDelivery({access:f.access,intentId:intent.intentId}))?.state).toBe("acknowledged");
      expect(await cold.claimTenantWebhookDelivery({access:f.access,intentId:intent.intentId,timeoutMs:1000})).toBeNull();}finally{await cold.close();}
  });
});
