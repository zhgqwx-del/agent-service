import {describe,expect,it,vi} from "vitest";
import {MemorySessionStore,TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,tenantTelemetryWriteAdapterResult,persistedProviderCaptureReceiptSha256,persistedProviderCaptureCanonicalJson,persistedProviderCaptureCoverageSha256,validatePersistedProviderCaptureActivationReceipt,validatePersistedProviderFailureCommitReceipt,validatePersistedProviderCaptureCoverage,validatePersistedProviderCaptureSourceBinding} from "../src/index.js";
import {trustedRunnerTelemetryRecord} from "./tenant-telemetry-adapter.fixture.js";
import {activateCaptureFixture,captureRefKey,captureCurrentStepFixture as captureStepFixture,uncapturedCurrentStepFixture as uncapturedStepFixture} from "./persisted-provider-capture.fixture.js";
import { acquireFixtureSessionAuthority } from "./fixtures/session-authority.js";
import type { CommitPersistedProviderStepFailureInput } from "../src/index.js";
import {newId} from "./conformance.js";

type Step = Awaited<ReturnType<typeof captureStepFixture>>;
function admitCapture(step: Step, input: CommitPersistedProviderStepFailureInput = step.input) {
  // Final content is fixed before admission; a fresh top-level batch avoids re-admitting a mutated identity.
  return { ...input, batch: step.lease.admit({ ...input.batch }) };
}
function fullMemorySnapshot(store: MemorySessionStore) {
  const containers = Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(store))
    .filter(([,descriptor]) => "value" in descriptor && (descriptor.value instanceof Map
      || descriptor.value instanceof Set || Array.isArray(descriptor.value) || descriptor.value === null
      || ["string","number","boolean","undefined"].includes(typeof descriptor.value)))
    .map(([key,descriptor]) => [key, descriptor.value]));
  const authority = store.sessionAuthority as unknown as { bindingId: string; tuples: Map<string,unknown> };
  return structuredClone({ containers, authority: { bindingId: authority.bindingId, tuples: authority.tuples } });
}

async function fixture(){const store=new MemorySessionStore({now:()=>Date.now()},{tenantTelemetryRefKey:captureRefKey,tenantTelemetryPersistedProviderCaptureLocalOnly:true});const activation=await activateCaptureFixture(store);return {store,activation};}
describe("trusted persisted provider-step source atomic Memory contract",()=>{
  it.each([false,true])("commits the real %s empty failed item, first source, membership, payload and independent receipt without terminating its turn",async(empty)=>{
    const {store}=await fixture(),h=await captureStepFixture(store,{empty});
    const result=await store.commitPersistedProviderStepFailure(admitCapture(h, h.input));
    expect(result).toMatchObject({lastSeq:4,replayed:false,failureCommitReceipt:{beginLastSeq:2,endLastSeq:4,eventCount:2}});
    expect((await store.getTurn(h.session.id,h.turn.id))?.status).toBe("inProgress");
    expect(await store.verifyPersistedProviderStepFailureSource(h.lookup)).toMatchObject({status:"source_verified_queued",sourceCount:1,executionReady:false,allDomainsComplete:false});
    const claim=(await store.claimTenantTelemetryWriteJobs({limit:1,leaseMs:5000,claimToken:"capture-unit-claim",adapterProtocol:"telemetry-s3-object-v1",captureMode:"include_v2",freshProof:h.proof}))[0]!;
    const serialized=JSON.stringify(claim.payload);
    expect(serialized).not.toContain(h.session.tenantId);expect(serialized).not.toContain(h.item.id);expect(serialized).not.toContain("private partial");
    expect(await store.verifyPersistedProviderStepFailureSource({...h.lookup,tenantId:"other-tenant"})).toMatchObject({sourceCount:0,status:"not_found"});
  });
  it("linearizes concurrent exact retries once and returns the original event range after a second business commit",async()=>{
    const {store}=await fixture(),h=await captureStepFixture(store);
    const results=await Promise.all([store.commitPersistedProviderStepFailure(admitCapture(h, h.input)),store.commitPersistedProviderStepFailure(admitCapture(h, h.input))]);
    expect(results.map((r)=>r.replayed).sort()).toEqual([false,true]);expect(results[0]!.failureCommitReceipt.receiptSha256).toBe(results[1]!.failureCommitReceipt.receiptSha256);
    await store.commit(h.lease.admit({sessionId:h.session.id,fence:1,events:[{type:"turn/started",sessionId:h.session.id,emittedAtMs:Date.now(),turn:h.turn}]}));
    expect((await store.commitPersistedProviderStepFailure(admitCapture(h, h.input))).lastSeq).toBe(4);expect((await store.getSession(h.session.tenantId,h.session.id))?.lastSeq).toBe(5);
    expect(store.usageLedger).toHaveLength(1);expect(store.billingUsageFacts.size).toBe(1);
  });
  it("preserves a streamed item's first sequence while sealing its later failed completion and rejecting sequence tampering",async()=>{
    const {store}=await fixture(),h=await captureStepFixture(store);
    const started=structuredClone(h.item);started.status="inProgress";delete started.completedAtMs;
    await store.commit(h.lease.admit({sessionId:h.session.id,fence:1,expectedLastSeq:2,items:[started],events:[{type:"item/started",sessionId:h.session.id,emittedAtMs:started.createdAtMs,item:started}]}));
    expect(started.seq).toBe(3);
    h.item.seq=started.seq;h.batch.expectedLastSeq=3;
    const result=await store.commitPersistedProviderStepFailure(admitCapture(h, h.input));
    expect(result).toMatchObject({lastSeq:5,replayed:false,failureCommitReceipt:{beginLastSeq:3,endLastSeq:5,eventCount:2,sourceEventSeq:4}});
    expect(result.events.map((event)=>[event.type,event.seq])).toEqual([["item/completed",4],["usage/updated",5]]);
    expect((await store.getItem(h.session.id,h.item.id))?.seq).toBe(3);
    expect(await store.verifyPersistedProviderStepFailureSource(h.lookup)).toMatchObject({sourceCount:1,status:"source_verified_queued"});
    expect(await store.getTenantTelemetryPersistedProviderCaptureFailureCommitReceipt(h.lookup)).toEqual(result.failureCommitReceipt);
    expect(await store.commitPersistedProviderStepFailure(admitCapture(h, h.input))).toMatchObject({lastSeq:5,replayed:true,failureCommitReceipt:result.failureCommitReceipt,events:result.events});
    const saved=structuredClone(store.items.get(h.item.id)!);
    for(const seq of [0,6,1.5,Number.MAX_SAFE_INTEGER+1,2]){
      store.items.set(h.item.id,{...saved,seq});
      await expect(store.verifyPersistedProviderStepFailureSource(h.lookup)).rejects.toThrow();
      await expect(store.getTenantTelemetryPersistedProviderCaptureFailureCommitReceipt(h.lookup)).rejects.toThrow();
    }
    store.items.set(h.item.id,saved);
    expect(await store.verifyPersistedProviderStepFailureSource(h.lookup)).toMatchObject({sourceCount:1,status:"source_verified_queued"});
    expect(store.usageLedger).toHaveLength(1);expect(store.billingUsageFacts.size).toBe(1);
  });
  it("filters v2 before LIMIT without changing its lease/attempt and requires an exact fresh tuple to include it",async()=>{
    const {store}=await fixture(),h=await captureStepFixture(store);
    const result=await store.commitPersistedProviderStepFailure(admitCapture(h, h.input)),operation=result.failureCommitReceipt.writeOperationSha256;
    const now=Date.now();
    const trace=await store.enqueueTenantTelemetryArtifact({tenantId:h.session.tenantId,expectedControlGeneration:1,domain:"traces",artifactIdSha256:"7".repeat(64),artifactGeneration:1,ownerKind:"tenant",ownerId:h.session.tenantId,ownerUserId:null,sourceSchema:"trace-batch-v1",sourceGeneration:0,sourceHighWaterDbMs:now,payload:{schema:TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,domain:"traces",records:[trustedRunnerTelemetryRecord(now,{opaqueRefKey:captureRefKey,tenantValue:h.session.tenantId,ownerKind:"tenant",ownerValue:h.session.tenantId,attempt:1})]}});
    const base={limit:1,leaseMs:5000,claimToken:"legacy-only-claim",adapterProtocol:"telemetry-s3-object-v1"};
    const [legacy]=await store.claimTenantTelemetryWriteJobs(base);
    expect(legacy?.writeOperationSha256).toBe(trace.writeOperationSha256);
    expect(await store.getTenantTelemetryWriteJob(h.session.tenantId,operation)).toMatchObject({attempts:0});
    expect((await store.getTenantTelemetryWriteJob(h.session.tenantId,operation))?.leaseUntilMs).toBeUndefined();
    await expect(store.claimTenantTelemetryWriteJobs({...base,captureMode:"include_v2",freshProof:{...h.proof,runtimeEpochSha256:"8".repeat(64)}})).rejects.toThrow();
    await expect(store.claimTenantTelemetryWriteJobs({...base,captureMode:"include_v2"} as never)).rejects.toThrow();
    expect(await store.getTenantTelemetryWriteJob(h.session.tenantId,operation)).toMatchObject({attempts:0});
    const [captured]=await store.claimTenantTelemetryWriteJobs({...base,captureMode:"include_v2",freshProof:h.proof});
    expect(captured?.writeOperationSha256).toBe(operation);
    expect(captured?.claimAttempt).toBe(1);
  });
  it("does not upgrade generic unknown or a second item at the same provider step",async()=>{
    const {store}=await fixture(),h=await captureStepFixture(store);
    await store.commit(h.lease.admit({ ...h.batch }));
    expect(await store.verifyPersistedProviderStepFailureSource(h.lookup)).toMatchObject({status:"not_found",sourceCount:0});
    await expect(store.commitPersistedProviderStepFailure(admitCapture(h, h.input))).rejects.toThrow();
    const h2=await captureStepFixture(store,{tenantId:"second-tenant"});await store.commitPersistedProviderStepFailure(admitCapture(h2, h2.input));
    const other=newId("item"),batch=structuredClone(h2.batch);batch.expectedLastSeq=4;batch.items![0]!.id=other;
    const event=batch.events![0]!;if(event.type === "item/completed")event.item.id=other;
    await expect(store.commitPersistedProviderStepFailure(admitCapture(h2, {...h2.input,batch,source:{...h2.input.source,itemId:other}}))).rejects.toThrow();
    expect((await store.getSession(h2.session.tenantId,h2.session.id))?.lastSeq).toBe(4);
  });
  it("rolls back serialization failure before any business or capture publication",async()=>{
    const {store}=await fixture(),h=await captureStepFixture(store);
    const before=fullMemorySnapshot(store);
    const fail=vi.spyOn(globalThis,"structuredClone").mockImplementationOnce(()=>{throw new Error("unit serialization failure");});
    try { await expect(store.commitPersistedProviderStepFailure(admitCapture(h, h.input))).rejects.toThrow("unit serialization failure"); }
    finally { fail.mockRestore(); }
    expect(fullMemorySnapshot(store)).toEqual(before);
    expect((await store.getSession(h.session.tenantId,h.session.id))?.lastSeq).toBe(2);expect(store.items.size).toBe(0);expect(store.usageLedger).toHaveLength(0);expect(store.billingUsageFacts.size).toBe(0);
    expect(await store.verifyPersistedProviderStepFailureSource(h.lookup)).toMatchObject({sourceCount:0});
    await store.commitPersistedProviderStepFailure(admitCapture(h, h.input));
  });
  it("refuses changed owner/fence/proof, literals and a runtime-epoch rebind",async()=>{
    const {store}=await fixture(),h=await captureStepFixture(store);
    await expect(store.commitPersistedProviderStepFailure(admitCapture(h, {...h.input,record:structuredClone(h.input.record)}))).rejects.toThrow();
    await expect(store.commitPersistedProviderStepFailure(admitCapture(h, {...h.input,source:{...h.input.source,userId:"other-user"}}))).rejects.toThrow();
    await expect(store.commitPersistedProviderStepFailure(admitCapture(h, {...h.input,freshProof:{...h.proof,runtimeEpochSha256:"9".repeat(64)}}))).rejects.toThrow();
    await store.commitPersistedProviderStepFailure(admitCapture(h, h.input));
    await h.lease.release();
    const replacement = await acquireFixtureSessionAuthority(store, h.session, 1);
    await store.commit(replacement.admit({sessionId:h.session.id,fence:2,fenceClaim:{tenantId:h.session.tenantId,userId:h.session.userId}}));
    await expect(store.commitPersistedProviderStepFailure(admitCapture(h, h.input))).rejects.toThrow();
  });
  it("rejects closed receipt extras even when their non-secret digest is recomputed",async()=>{
    const {store}=await fixture(),h=await captureStepFixture(store);const result=await store.commitPersistedProviderStepFailure(admitCapture(h, h.input));
    const receipt={...result.failureCommitReceipt,extra:"not-a-wire-field"};receipt.receiptSha256=persistedProviderCaptureReceiptSha256(receipt);
    expect(()=>validatePersistedProviderFailureCommitReceipt(receipt)).toThrow();
    const activation={...(await store.getTenantTelemetryPersistedProviderCaptureActivationReceipt())!,extra:"not-a-wire-field"};activation.receiptSha256=persistedProviderCaptureReceiptSha256(activation);
    expect(()=>validatePersistedProviderCaptureActivationReceipt(activation)).toThrow();
    const binding={...(await store.getTenantTelemetryPersistedProviderCaptureSourceBinding(h.session.tenantId,result.failureCommitReceipt.writeOperationSha256))!,extra:"not-a-wire-field"};binding.receiptSha256=persistedProviderCaptureReceiptSha256(binding);
    expect(()=>validatePersistedProviderCaptureSourceBinding(binding)).toThrow();
    const coverage={...(await store.getTenantTelemetryPersistedProviderCaptureCoverage(h.session.tenantId))!,extra:"not-a-wire-field"};coverage.evidenceSha256=persistedProviderCaptureCoverageSha256(coverage);
    expect(()=>validatePersistedProviderCaptureCoverage(coverage)).toThrow();
  });
  it("independently rejects a missing payload from the standalone exact failure receipt getter",async()=>{
    const {store}=await fixture(),h=await captureStepFixture(store);const result=await store.commitPersistedProviderStepFailure(admitCapture(h, h.input));
    const payloads=(store as unknown as {tenantTelemetryWritePayloads:Map<string,unknown>}).tenantTelemetryWritePayloads;
    const saved=payloads.get(result.failureCommitReceipt.writeOperationSha256)!;payloads.delete(result.failureCommitReceipt.writeOperationSha256);
    await expect(store.getTenantTelemetryPersistedProviderCaptureFailureCommitReceipt(h.lookup)).rejects.toThrow();
    payloads.set(result.failureCommitReceipt.writeOperationSha256,saved);
    expect(await store.getTenantTelemetryPersistedProviderCaptureFailureCommitReceipt(h.lookup)).toEqual(result.failureCommitReceipt);
  });
  it("rejects active event-only failure omission atomically while preserving dormant event-only behavior",async()=>{
    const {store}=await fixture(),h=await uncapturedStepFixture(store,{tenantId:"active-omission"});
    const event=h.batch.events![0]!;
    await expect(store.commit(h.lease.admit({sessionId:h.session.id,fence:1,events:[event]}))).rejects.toThrow();
    expect((await store.getSession(h.session.tenantId,h.session.id))?.lastSeq).toBe(2);expect(store.items.size).toBe(0);
    expect(await store.verifyPersistedProviderStepFailureSource(h.lookup)).toMatchObject({sourceCount:0,status:"not_found"});
    const dormant=new MemorySessionStore(),old=await uncapturedStepFixture(dormant,{tenantId:"dormant-omission"});
    expect(await dormant.commit(old.lease.admit({sessionId:old.session.id,fence:1,events:[old.batch.events![0]!]}))).toMatchObject({lastSeq:3});
  });
  it("keeps the immutable cutover root inclusive of inactive unknown/legacy but exclusive of backdated active unknown",async()=>{
    const store=new MemorySessionStore({now:()=>Date.now()},{tenantTelemetryRefKey:captureRefKey,tenantTelemetryPersistedProviderCaptureLocalOnly:true});
    const old=await uncapturedStepFixture(store,{tenantId:"inactive-unknown"});await store.commit(old.lease.admit({ ...old.batch }));
    const legacy=await uncapturedStepFixture(store,{tenantId:"legacy-failed"});await store.commit(legacy.lease.admit({ ...legacy.batch }));
    // This fixture removes only the private in-memory sidecar to represent a genuine old writer.
    const classes=(store as unknown as {persistedProviderFailureClasses:Map<string,{classification:string;generation:number}>}).persistedProviderFailureClasses;
    expect(classes.get(old.item.id)).toMatchObject({classification:"runtime_unknown",generation:0});classes.delete(legacy.item.id);
    const activation=await activateCaptureFixture(store);
    const receipt=await store.getTenantTelemetryPersistedProviderCaptureActivationReceipt();expect(receipt).toMatchObject({preCutoverFailureCount:2});
    const current=await uncapturedStepFixture(store,{tenantId:"active-unknown"});
    current.batch.items![0]!.createdAtMs=1;current.batch.items![0]!.completedAtMs=1;
    const event=current.batch.events![0]!;if(event.type === "item/completed"){event.item.createdAtMs=1;event.item.completedAtMs=1;event.emittedAtMs=1;}
    await store.commit(current.lease.admit({ ...current.batch }));expect(classes.get(current.item.id)).toMatchObject({classification:"runtime_unknown",generation:1});
    expect(await store.getTenantTelemetryPersistedProviderCaptureActivationReceipt()).toEqual(receipt);
    await store.withTenantTelemetryCaptureOperatorFence((fence)=>store.activateTenantTelemetryPersistedProviderCapture(activation,fence),{timeoutMs:5000});
    for(const source of [old,legacy]){
      // Primary activation retired the previous binding. Acquire the fixed next floor before
      // checking the immutable item gate, so stale authority cannot satisfy this negative case.
      const currentLease=await acquireFixtureSessionAuthority(store,source.session,1);
      const beforeRewrite=fullMemorySnapshot(store);
      await expect(store.commit(currentLease.admit({sessionId:source.session.id,fence:currentLease.fence,items:[{...source.item,text:"changed pre-cutover failure"}]}))).rejects.toThrow("pre-cutover failed item snapshot is immutable");
      expect(fullMemorySnapshot(store)).toEqual(beforeRewrite);
      expect(await store.verifyPersistedProviderStepFailureSource(source.lookup)).toMatchObject({sourceCount:0,status:"not_found"});
    }
    expect(await store.getTenantTelemetryPersistedProviderCaptureActivationReceipt()).toEqual(receipt);
  });
  it("returns honest absence from dormant source reads without requiring a ref key",async()=>{
    const store=new MemorySessionStore();
    const source={tenantId:"dormant",sessionId:"session",turnId:"turn",itemId:"item",stepIndex:1};
    expect(await store.getTenantTelemetryPersistedProviderCaptureFailureCommitReceipt(source)).toBeNull();
    expect(await store.verifyPersistedProviderStepFailureSource(source)).toMatchObject({sourceCount:0,status:"not_found"});
  });
  it("normalizes exact replay to real JSON semantics without Date or undefined-array hash collisions",async()=>{
    expect(persistedProviderCaptureCanonicalJson({date:new Date("2020-01-01T00:00:00Z"),omitted:undefined})).toBe('{"date":"2020-01-01T00:00:00.000Z"}');
    expect(persistedProviderCaptureCanonicalJson([undefined])).toBe("[null]");
    expect(persistedProviderCaptureCanonicalJson([undefined])).not.toBe(persistedProviderCaptureCanonicalJson([]));
    expect(()=>persistedProviderCaptureCanonicalJson(undefined)).toThrow();
    expect(()=>persistedProviderCaptureCanonicalJson(1n)).toThrow();
    const {store}=await fixture(),h=await captureStepFixture(store);
    // The canonical codec assertions above preserve Date/undefined semantics. Current authority
    // accepts closed plain JSON, so normalize the intended body explicitly before admission.
    h.batch.turn!.metadata=JSON.parse(persistedProviderCaptureCanonicalJson({date:new Date("2020-01-01T00:00:00Z"),omitted:undefined,slots:[undefined]}));
    const result=await store.commitPersistedProviderStepFailure(admitCapture(h, h.input));
    const equivalent=structuredClone(h.batch);equivalent.turn!.metadata={date:"2020-01-01T00:00:00.000Z",slots:[null]};
    expect(await store.commitPersistedProviderStepFailure(admitCapture(h, {...h.input,batch:equivalent}))).toMatchObject({replayed:true,failureCommitReceipt:result.failureCommitReceipt});
    for(const metadata of [{date:new Date("2020-01-02T00:00:00Z"),slots:[null]},{date:"2020-01-01T00:00:00.000Z",slots:[]}]){
      const changed=structuredClone(h.batch);changed.turn!.metadata=JSON.parse(persistedProviderCaptureCanonicalJson(metadata));
      await expect(store.commitPersistedProviderStepFailure(admitCapture(h, {...h.input,batch:changed}))).rejects.toThrow();
    }
    expect(store.usageLedger).toHaveLength(1);
  });
  it("retains historical source proof after ordinary DELETE but denies live writes and usage destruction",async()=>{
    let clock=Date.now();
    const store=new MemorySessionStore({now:()=>clock},{tenantTelemetryRefKey:captureRefKey,tenantTelemetryPersistedProviderCaptureLocalOnly:true});
    await activateCaptureFixture(store);const h=await captureStepFixture(store);
    const result=await store.commitPersistedProviderStepFailure(admitCapture(h, h.input));
    clock=Math.max(clock,Date.now())+10;
    await store.putRetentionPolicy({tenantId:h.session.tenantId,policyVersion:"capture-retention",policy:{sessionContentRetentionMs:30*86400000,userErasureGraceMs:30*86400000,operationalUsageRetentionMs:0,idempotencyReceiptRetentionMs:null,billingFactRetentionMs:null,lifecycleAuditRetentionMs:null,exportArtifactTtlMs:86400000},actorKeyId:"unit-admin",atMs:clock});
    await store.activateRetentionPolicy({tenantId:h.session.tenantId,policyVersion:"capture-retention",expectedControlGeneration:0,actorKeyId:"unit-admin",atMs:clock});
    await store.commit(h.lease.admit({sessionId:h.session.id,fence:1,turn:{...h.batch.turn!,status:"failed",stopReason:"error",completedAtMs:clock},sessionPatch:{status:{type:"idle"}}}));
    const claim=(await store.claimTenantTelemetryWriteJobs({limit:1,leaseMs:5000,claimToken:"capture-tombstone-claim",adapterProtocol:"telemetry-s3-object-v1",captureMode:"include_v2",freshProof:h.proof}))[0]!;
    expect(claim).toBeDefined();
    await store.commitOrdinarySessionDelete(h.lease.admit({sessionId:h.session.id,fence:1,lifecycle:{type:"tombstone",tenantId:h.session.tenantId,userId:h.session.userId,atMs:clock,purgeAfterMs:null,deletionGeneration:1},events:[{type:"session/deleted",sessionId:h.session.id,emittedAtMs:clock,deletionGeneration:1}]}));
    await store.sealOrdinarySessionDeleteGrace(h.session.tenantId,h.session.userId,h.session.id);
    expect(await store.getTenantTelemetryPersistedProviderCaptureFailureCommitReceipt(h.lookup)).toEqual(result.failureCommitReceipt);
    expect(await store.verifyPersistedProviderStepFailureSource(h.lookup)).toMatchObject({sourceCount:1,status:"source_verified_queued"});
    expect(await store.reserveTenantTelemetryExternalMutation({tenantId:claim.tenantId,writeOperationSha256:claim.writeOperationSha256,claimAttempt:claim.claimAttempt,claimToken:claim.claimToken},"telemetry-s3-object-v1",h.proof)).toBeNull();
    await expect(store.commitPersistedProviderStepFailure(admitCapture(h, h.input))).rejects.toThrow();
    const owner={tenantId:h.session.tenantId,userId:h.session.userId,sessionId:h.session.id,deletionGeneration:1};
    const reconciliation=await store.reconcileSessionUsage({...owner,nowMs:clock});clock+=31*86400000;
    const input={...owner,expectedChecksum:reconciliation.checksum,enabled:true as const};
    await expect(store.executeOrdinarySessionUsageRetention(input)).rejects.toThrow("operational usage is retained by sealed provider-step capture");
    await expect(store.anonymizeSessionUsage({...input,nowMs:clock})).rejects.toThrow("operational usage is retained by sealed provider-step capture");
    expect(store.usageLedger).toHaveLength(1);expect(store.billingUsageFacts.size).toBe(1);
    expect(await store.verifyPersistedProviderStepFailureSource(h.lookup)).toMatchObject({sourceCount:1});
  });
  it("denies new creation and reservation replay after DELETE but can ACK the exact already-authorized external result",async()=>{
    const {store}=await fixture(),h=await captureStepFixture(store);
    const committed=await store.commitPersistedProviderStepFailure(admitCapture(h, h.input)),operation=committed.failureCommitReceipt.writeOperationSha256;
    const [claim]=await store.claimTenantTelemetryWriteJobs({limit:1,leaseMs:10000,claimToken:"reserved-owner-delete",adapterProtocol:"telemetry-s3-object-v1",captureMode:"include_v2",freshProof:h.proof});
    const auth={tenantId:claim!.tenantId,writeOperationSha256:operation,claimAttempt:claim!.claimAttempt,claimToken:claim!.claimToken};
    expect(await store.verifyPersistedProviderStepFailureWrite(h.session.tenantId,operation,h.proof,"create")).toMatchObject({sourceCount:1});
    expect(await store.reserveTenantTelemetryExternalMutation(auth,"telemetry-s3-object-v1",h.proof)).not.toBeNull();
    const at=Date.now();
    await store.commit(h.lease.admit({sessionId:h.session.id,fence:1,turn:{...h.batch.turn!,status:"failed",stopReason:"error",completedAtMs:at},sessionPatch:{status:{type:"idle"}}}));
    await store.commitOrdinarySessionDelete(h.lease.admit({sessionId:h.session.id,fence:1,lifecycle:{type:"tombstone",tenantId:h.session.tenantId,userId:h.session.userId,atMs:at,purgeAfterMs:null,deletionGeneration:1},events:[{type:"session/deleted",sessionId:h.session.id,emittedAtMs:at,deletionGeneration:1}]}));
    expect(await store.verifyPersistedProviderStepFailureSource(h.lookup)).toMatchObject({status:"source_verified_reserved"});
    for(const boundary of ["reserve","create"] as const)await expect(store.verifyPersistedProviderStepFailureWrite(h.session.tenantId,operation,h.proof,boundary)).rejects.toThrow("live owner");
    expect(await store.reserveTenantTelemetryExternalMutation(auth,"telemetry-s3-object-v1",h.proof)).toBeNull();
    expect(await store.verifyPersistedProviderStepFailureWrite(h.session.tenantId,operation,h.proof,"ack")).toMatchObject({sourceCount:1});
    // This is only a closed unit result, not evidence that any real external sink was contacted.
    const result=tenantTelemetryWriteAdapterResult("telemetry-s3-object-v1",{writeOperationSha256:operation,target:claim!.target,inventory:claim!.inventory,payload:claim!.payload},"already_present",true);
    expect(await store.completeTenantTelemetryWrite(auth,result,h.proof)).not.toBeNull();
    expect(await store.verifyPersistedProviderStepFailureSource(h.lookup)).toMatchObject({status:"source_verified_written"});
  });
});
