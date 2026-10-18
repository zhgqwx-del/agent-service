import { afterEach,describe,expect,it,vi } from "vitest";
import { MemorySessionStore } from "../src/memory.js";
import * as W from "../src/tenant-webhooks.js";
import { newErasureRequestId,userErasureRequestHash,SubjectDeletingError } from "../src/subject-lifecycle.js";
import { webhookSession,webhookMilestone,webhookWrite,webhookSha,webhookCommit } from "./fixtures/tenant-webhooks.js";
import { newId } from "./conformance.js";

afterEach(()=>vi.restoreAllMocks());
describe("tenant webhook actual Memory fenced consumers",()=>{
  it("keeps default-off empty tenants footprint-free and isolates actual admin/runtime owners",async()=>{
    const store=new MemorySessionStore(),f=await webhookSession(store),other=await webhookSession(store);
    await expect(store.assertTenantWebhookRuntimeGate(false)).resolves.toBeUndefined();
    expect(await store.getTenantWebhookRuntimePolicy({access:f.access})).toEqual([]);
    await store.upsertTenantWebhook(webhookWrite(f.admin));
    await expect(store.assertTenantWebhookRuntimeGate(false)).rejects.toThrow(W.TenantWebhookIntegrityError);
    expect(await store.getTenantWebhookRuntimePolicy({access:other.access})).toEqual([]);
    await expect(store.getTenantWebhookRuntimePolicy({access:f.admin})).rejects.toThrow(W.TenantWebhookIntegrityError);
    await expect(store.upsertTenantWebhook({...webhookWrite(f.admin),access:structuredClone(f.admin)})).rejects.toThrow(W.TenantWebhookIntegrityError);
  });
  it("serializes competing CAS and rejects same-key different-body without partial config",async()=>{
    const store=new MemorySessionStore(),f=await webhookSession(store),one=webhookWrite(f.admin),two=webhookWrite(f.admin,"observer",0,"other");
    const results=await Promise.allSettled([store.upsertTenantWebhook(one),store.upsertTenantWebhook(two)]);
    expect(results.map(r=>r.status).sort()).toEqual(["fulfilled","rejected"]);
    expect((await store.getTenantWebhook({access:f.admin,name:"observer"}))?.slot.revision).toBe(1);
  });
  it("ordinary off-mode tool starts cannot bypass a policy enabled after startup",async()=>{
    const store=new MemorySessionStore(),f=await webhookSession(store);await store.assertTenantWebhookRuntimeGate(false);
    await store.upsertTenantWebhook(webhookWrite(f.admin));const before=await store.readEvents(f.session.id,0,100);
    await expect(store.commit({sessionId:f.session.id,fence:1,items:[{...f.call,startedAtMs:Date.now()}],events:[]})).rejects.toThrow(W.TenantWebhookIntegrityError);
    expect(await store.readEvents(f.session.id,0,100)).toEqual(before);
  });
  it("metadata-only never compiles unused arguments and pins raw text through the original prefix",async()=>{
    const store=new MemorySessionStore(),f=await webhookSession(store);await store.upsertTenantWebhook(webhookWrite(f.admin));
    let source=await store.readTenantWebhookSources({access:f.access,sessionId:f.session.id,turnId:f.turn.id,callItemId:f.call.id,fence:1});
    expect(source.value.prompt.parts).toEqual([]);expect(source.value.arguments).toBeNull();
    await store.upsertTenantWebhook(webhookWrite(f.admin,"observer",1,"body",{endpoint:"https://hooks.example.test/observe",phase:"postToolUse",bodyScopes:["prompt","tool_arguments"]}));
    const plan=await webhookMilestone(f,"started"),oldWatermark=plan.source.value.throughSeq;
    const steer={...f.user,id:newId("item"),seq:0,content:[{type:"text" as const,text:"later steer"}]};
    await store.commit({sessionId:f.session.id,fence:1,items:[steer],events:[{type:"item/completed",sessionId:f.session.id,item:steer,emittedAtMs:Date.now()}]});
    await webhookCommit(store,plan);
    source=await store.readTenantWebhookSources({access:f.access,sessionId:f.session.id,turnId:f.turn.id,callItemId:f.call.id,fence:1});
    expect(source.value.startedSnapshots[0]?.throughSeq).toBe(oldWatermark);expect(source.value.prompt.parts).toEqual([]);expect(source.value.arguments).toBeNull();
  });
  it.each(["update","disable","delete","disable-enable"] as const)("preserves canonical result and blocks old post delivery after mid-tool %s",async change=>{
    const store=new MemorySessionStore(),f=await webhookSession(store);const old=await store.upsertTenantWebhook(webhookWrite(f.admin));
    await webhookCommit(store,await webhookMilestone(f,"started"));
    if(change==="update")await store.upsertTenantWebhook(webhookWrite(f.admin,"observer",1,"new-config"));
    else {await store.setTenantWebhookState({access:f.admin,name:"observer",expectedRevision:1,idempotencyKey:change,state:change==="delete"?"deleted":"disabled"});
      if(change==="disable-enable")await store.setTenantWebhookState({access:f.admin,name:"observer",expectedRevision:2,idempotencyKey:"enable",state:"enabled"});}
    const post=await webhookMilestone(f,"post"),result=await webhookCommit(store,post),intent=result.tenantWebhookIntents[0]!;
    expect(intent.configVersionId).toBe(old.version!.configVersionId);expect(intent.state).toBe("blocked");
    expect(store.items.get(post.canonicalResult!.itemId)?.type).toBe("toolResult");
    expect(await store.claimTenantWebhookDelivery({access:f.access,intentId:intent.intentId,timeoutMs:100})).toBeNull();
  });
  it("legacy already-started calls may commit their result after first activation without invented intent",async()=>{
    const store=new MemorySessionStore(),f=await webhookSession(store);
    await store.commit({sessionId:f.session.id,fence:1,items:[{...f.call,startedAtMs:Date.now()}],events:[]});
    await store.upsertTenantWebhook(webhookWrite(f.admin));const post=await webhookMilestone(f,"post");
    expect(post.source.value.registrations).toEqual([]);expect((await webhookCommit(store,post)).tenantWebhookIntents).toEqual([]);
    expect(store.items.get(post.canonicalResult!.itemId)?.type).toBe("toolResult");
  });
  it("a real post snapshot forbids ordinary result commit before the same fenced milestone succeeds",async()=>{
    const store=new MemorySessionStore(),f=await webhookSession(store);await store.upsertTenantWebhook(webhookWrite(f.admin));
    await webhookCommit(store,await webhookMilestone(f,"started"));const post=await webhookMilestone(f,"post"),before=await store.readEvents(f.session.id,0,100);
    await expect(store.commit(post.batch)).rejects.toThrow(W.TenantWebhookIntegrityError);
    expect(await store.readEvents(f.session.id,0,100)).toEqual(before);expect(store.items.has(post.canonicalResult!.itemId)).toBe(false);
    expect((await webhookCommit(store,post)).tenantWebhookIntents).toHaveLength(1);
  });
  it("a later legacy call reusing a model id never borrows an older call item's post snapshot",async()=>{
    const store=new MemorySessionStore(),f=await webhookSession(store);await store.upsertTenantWebhook(webhookWrite(f.admin));await webhookCommit(store,await webhookMilestone(f,"started"));await webhookCommit(store,await webhookMilestone(f,"post"));
    await store.setTenantWebhookState({access:f.admin,name:"observer",expectedRevision:1,idempotencyKey:"disable",state:"disabled"});
    const next={...f.call,id:newId("item"),seq:0,step:2};await store.commit({sessionId:f.session.id,fence:1,items:[next],events:[{type:"item/started",sessionId:f.session.id,item:next,emittedAtMs:Date.now()}]});
    await store.commit({sessionId:f.session.id,fence:1,items:[{...next,startedAtMs:Date.now()}],events:[]});
    await store.setTenantWebhookState({access:f.admin,name:"observer",expectedRevision:2,idempotencyKey:"enable",state:"enabled"});
    const result={id:newId("item"),sessionId:f.session.id,turnId:f.turn.id,seq:0,step:2,type:"toolResult" as const,status:"completed" as const,createdAtMs:Date.now(),toolCallId:next.toolCallId,name:next.name,isError:false,content:[{type:"text" as const,text:"legacy second result"}]};
    await store.commit({sessionId:f.session.id,fence:1,items:[result],events:[{type:"item/completed",sessionId:f.session.id,item:result,emittedAtMs:Date.now()}]});
    expect(store.items.get(result.id)?.type).toBe("toolResult");expect((await store.listTenantWebhookDeliveries({access:f.admin,name:"observer",cursor:null,limit:100})).items).toHaveLength(1);
  });
  it("single claim, exact finish and durable unknown never permit request replay",async()=>{
    const store=new MemorySessionStore(),f=await webhookSession(store);await store.upsertTenantWebhook(webhookWrite(f.admin,"observer",0,"install",{endpoint:"https://hooks.example.test/observe",phase:"preToolUse",bodyScopes:[]}));
    const pre=await webhookCommit(store,await webhookMilestone(f,"pre")),intent=pre.tenantWebhookIntents[0]!;
    const claims=await Promise.all([store.claimTenantWebhookDelivery({access:f.access,intentId:intent.intentId,timeoutMs:1000}),store.claimTenantWebhookDelivery({access:f.access,intentId:intent.intentId,timeoutMs:1000})]);
    expect(claims.filter(Boolean)).toHaveLength(1);const claim=claims.find(c=>c!==null)!;
    const input={access:f.access,intentId:intent.intentId,claimToken:claim.claimToken,outcome:"outcome_unknown" as const,resultSha256:webhookSha("unknown")};
    const terminal=await store.finishTenantWebhookDelivery(input);expect(terminal.state).toBe("outcome_unknown");expect(await store.finishTenantWebhookDelivery(input)).toEqual(terminal);
    await expect(store.finishTenantWebhookDelivery({...input,outcome:"acknowledged"})).rejects.toThrow(W.TenantWebhookConflictError);
    expect(await store.claimTenantWebhookDelivery({access:f.access,intentId:intent.intentId,timeoutMs:1000})).toBeNull();
  });
  it("phase abandonment closes only prepared without claiming, changing sending or accepting another owner",async()=>{
    const store=new MemorySessionStore(),f=await webhookSession(store),config:W.TenantWebhookConfig={endpoint:"https://hooks.example.test/observe",phase:"preToolUse",bodyScopes:[]};
    await store.upsertTenantWebhook(webhookWrite(f.admin,"first",0,"install",config));await store.upsertTenantWebhook(webhookWrite(f.admin,"second",0,"install",config));
    const intents=(await webhookCommit(store,await webhookMilestone(f,"pre"))).tenantWebhookIntents;
    const sending=await store.claimTenantWebhookDelivery({access:f.access,intentId:intents[0]!.intentId,timeoutMs:1000});if(!sending)throw new Error("claim missing");
    expect(await store.abandonPreparedTenantWebhookDelivery({access:f.access,intentId:sending.intent.intentId})).toEqual(sending.intent);
    const terminal=await store.abandonPreparedTenantWebhookDelivery({access:f.access,intentId:intents[1]!.intentId});expect(terminal).toMatchObject({state:"failed_not_dispatched",claimTokenSha256:null});
    expect(await store.claimTenantWebhookDelivery({access:f.access,intentId:intents[1]!.intentId,timeoutMs:1000})).toBeNull();
    expect(await store.abandonPreparedTenantWebhookDelivery({access:W.createTenantWebhookRuntimeAccess({...f.owner,userId:"other"}),intentId:intents[1]!.intentId})).toBeNull();
  });
  it("late first finish seals unknown atomically, never upgrades late ACK, then only exact-replays",async()=>{
    const store=new MemorySessionStore(),f=await webhookSession(store);await store.upsertTenantWebhook(webhookWrite(f.admin,"observer",0,"install",{endpoint:"https://hooks.example.test/observe",phase:"preToolUse",bodyScopes:[]}));
    const intent=(await webhookCommit(store,await webhookMilestone(f,"pre"))).tenantWebhookIntents[0]!;
    const claim=await store.claimTenantWebhookDelivery({access:f.access,intentId:intent.intentId,timeoutMs:1});if(!claim)throw new Error("claim missing");
    vi.spyOn(Date,"now").mockReturnValue(claim.intent.sendDeadlineAtMs!+1);
    const input={access:f.access,intentId:intent.intentId,claimToken:claim.claimToken,outcome:"acknowledged" as const,resultSha256:webhookSha("late-ack")};
    const receipt=await store.finishTenantWebhookDelivery(input);expect(receipt.state).toBe("outcome_unknown");expect((await store.getTenantWebhookDelivery({access:f.access,intentId:intent.intentId}))?.state).toBe("outcome_unknown");
    expect(await store.finishTenantWebhookDelivery(input)).toEqual(receipt);await expect(store.finishTenantWebhookDelivery({...input,resultSha256:webhookSha("different")})).rejects.toThrow(W.TenantWebhookConflictError);
  });
  it("cold reconciliation closes prepared and sending without HTTP or new claims",async()=>{
    const store=new MemorySessionStore(),f=await webhookSession(store);await store.upsertTenantWebhook(webhookWrite(f.admin,"observer",0,"install",{endpoint:"https://hooks.example.test/observe",phase:"preToolUse",bodyScopes:[]}));
    const intent=(await webhookCommit(store,await webhookMilestone(f,"pre"))).tenantWebhookIntents[0]!;
    vi.spyOn(Date,"now").mockReturnValue(intent.preparedDeadlineAtMs+1);
    expect((await store.reconcileTenantWebhookDeliveries({cursor:null,limit:100})).changed).toBe(1);
    expect((await store.getTenantWebhookDelivery({access:f.access,intentId:intent.intentId}))?.state).toBe("failed_not_dispatched");expect(await store.claimTenantWebhookDelivery({access:f.access,intentId:intent.intentId,timeoutMs:100})).toBeNull();
  });
  it.each(["get","reconcile"] as const)("first legal finish binds an already-expired unknown after %s without changing the receipt",async settle=>{
    const store=new MemorySessionStore(),f=await webhookSession(store);await store.upsertTenantWebhook(webhookWrite(f.admin,"observer",0,"install",{endpoint:"https://hooks.example.test/observe",phase:"preToolUse",bodyScopes:[]}));
    const intent=(await webhookCommit(store,await webhookMilestone(f,"pre"))).tenantWebhookIntents[0]!,claim=await store.claimTenantWebhookDelivery({access:f.access,intentId:intent.intentId,timeoutMs:1});if(!claim)throw new Error("claim missing");
    vi.spyOn(Date,"now").mockReturnValue(claim.intent.sendDeadlineAtMs!+1);
    if(settle==="get")await store.getTenantWebhookDelivery({access:f.access,intentId:intent.intentId});else await store.reconcileTenantWebhookDeliveries({cursor:null,limit:100});
    const before=await store.getTenantWebhookDelivery({access:f.access,intentId:intent.intentId});expect(before?.state).toBe("outcome_unknown");expect(before?.finishRequestSha256).toBeNull();
    const input={access:f.access,intentId:intent.intentId,claimToken:claim.claimToken,outcome:"acknowledged" as const,resultSha256:webhookSha("late-ack")},terminal=await store.finishTenantWebhookDelivery(input);
    expect({...terminal,finishRequestSha256:null}).toEqual(before);expect(await store.finishTenantWebhookDelivery(input)).toEqual(terminal);
    await expect(store.finishTenantWebhookDelivery({...input,outcome:"outcome_unknown"})).rejects.toThrow(W.TenantWebhookConflictError);
  });
  it("unavailable original snapshot and oversized post observation commit canonical output with no sendable material",async()=>{
    const store=new MemorySessionStore(),f=await webhookSession(store);await store.upsertTenantWebhook(webhookWrite(f.admin));
    await webhookCommit(store,await webhookMilestone(f,"started",true));
    const post=await webhookMilestone(f,"post",true),result=await webhookCommit(store,post),intent=result.tenantWebhookIntents[0]!;
    expect(intent).toMatchObject({state:"failed_not_dispatched",payload:null,requestSha256:null,payloadSha256:null,payloadBytes:null,invocationId:null});
    expect(store.items.get(post.canonicalResult!.itemId)?.type).toBe("toolResult");expect(await store.claimTenantWebhookDelivery({access:f.access,intentId:intent.intentId,timeoutMs:100})).toBeNull();
  });
  it("serialization or cloned milestone failure leaves neither result nor durable intent",async()=>{
    const store=new MemorySessionStore(),f=await webhookSession(store);await store.upsertTenantWebhook(webhookWrite(f.admin));await webhookCommit(store,await webhookMilestone(f,"started"));
    const post=await webhookMilestone(f,"post"),before=await store.readEvents(f.session.id,0,100);
    await expect(webhookCommit(store,{...post,admission:structuredClone(post.admission)})).rejects.toThrow(W.TenantWebhookIntegrityError);
    post.batch.items![0]!.createdAtMs+=1;
    await expect(webhookCommit(store,post)).rejects.toThrow(W.TenantWebhookIntegrityError);
    expect(await store.readEvents(f.session.id,0,100)).toEqual(before);expect(store.items.has(post.canonicalResult!.itemId)).toBe(false);
    expect((await store.listTenantWebhookDeliveries({access:f.admin,name:"observer",cursor:null,limit:100})).items).toEqual([]);
  });
  it("fresh actual-user lifecycle denies delivery reads and starts after T1",async()=>{
    const store=new MemorySessionStore(),f=await webhookSession(store);await store.upsertTenantWebhook(webhookWrite(f.admin));
    await store.requestUserErasure({requestId:newErasureRequestId(),...f.owner,requestedByKeyId:"test",idempotencyKey:"erase",requestHash:userErasureRequestHash(f.owner.tenantId,f.owner.userId),atMs:Date.now()});
    await expect(store.getTenantWebhookRuntimePolicy({access:f.access})).rejects.toThrow(SubjectDeletingError);
    await expect(store.readTenantWebhookSources({access:f.access,sessionId:f.session.id,turnId:f.turn.id,callItemId:f.call.id,fence:1})).rejects.toThrow(SubjectDeletingError);
  });
});
