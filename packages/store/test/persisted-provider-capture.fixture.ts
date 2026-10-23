import { randomUUID } from "node:crypto";
import { createStructuredTelemetry,emptyUsage,type Item,type StructuredTelemetryRecord,type Turn } from "@agent-service/protocol";
import { attachSessionWriteAdmission,createSessionAcquireCommand,EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,newUsageId,s3TenantTelemetryTargetIdentity,type CommitBatch,type CommitPersistedProviderStepFailureInput,type TenantTelemetryPersistedProviderCaptureStore,type SessionStore,type TenantTelemetryLifecycleStore,type TenantRestoreJournalStore } from "../src/index.js";
import { mkSession,newId } from "./conformance.js";

export const captureRefKey=Buffer.alloc(32,0x43);
const D=(c:string)=>c.repeat(64);
export type CaptureFixtureStore=SessionStore&TenantTelemetryPersistedProviderCaptureStore&TenantTelemetryLifecycleStore&TenantRestoreJournalStore;
export async function activateCaptureFixture(store:CaptureFixtureStore){
  const target={targetOrdinal:0,targetSha256:D("1"),failureDomainSha256:D("2"),adapterProtocol:"memory-restore-journal-v1",journalNamespaceSha256:D("3")};
  await store.activateTenantRestoreJournalControl({adapterProtocol:target.adapterProtocol,journalNamespaceSha256:target.journalNamespaceSha256,logicalDatabaseNamespaceSha256:D("4"),runtimeEpochSha256:D("5"),targets:[target],observedHeads:[{...target,logicalDatabaseNamespaceSha256:D("4"),sealedRemoteSequence:0,sealedHeadRootSha256:EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256}]});
  await store.activateTenantTelemetryLifecycle({expectedControlGeneration:0,targets:(["logs","traces"] as const).map((domain)=>({domain,...s3TenantTelemetryTargetIdentity({namespaceId:"store-unit",failureDomainId:"unit-no-external-sink",bucket:"store-unit",prefix:"capture",region:"us-east-1",endpoint:null,forcePathStyle:false,domain})}))});
  const lifecycle=await store.getTenantTelemetryLifecycleControl();if(lifecycle.state !== "active")throw new Error("fixture lifecycle missing");
  const logs=(await store.listTenantTelemetryLifecycleTargets()).find((t)=>t.domain === "logs")!;
  const activation={expectedControlGeneration:0 as const,lifecycleControlEvidenceSha256:lifecycle.activationEvidenceSha256,logsTargetSha256:logs.targetSha256,logsTargetReceiptSha256:logs.receiptSha256,configuredFleetRootSha256:D("6"),fleetStoppedAck:"fleet-stopped-v1" as const,legacyWritersDrainedAck:"legacy-writers-drained-v1" as const,producerReadyAck:"provider-step-error-v2-ready-v1" as const,localOnlyAck:"local-only-v1" as const};
  await store.withTenantTelemetryCaptureOperatorFence((fence)=>store.activateTenantTelemetryPersistedProviderCapture(activation,fence),{timeoutMs:5000});
  return activation;
}
export async function uncapturedStepFixture(store:SessionStore,options:{tenantId?:string;userId?:string;empty?:boolean}={}){
  const session=mkSession(options.tenantId ?? "capture-tenant",options.userId ?? "capture-user");
  await store.createSession(session);
  const now=Date.now(),turn:Turn={id:newId("turn"),sessionId:session.id,status:"inProgress",seqStart:2,steps:1,toolCalls:0,usage:emptyUsage(),startedAtMs:now,metadata:{}};
  await store.commit({sessionId:session.id,fence:1,turn,events:[{type:"turn/started",sessionId:session.id,emittedAtMs:now,turn}],sessionPatch:{status:{type:"active",turnId:turn.id,activeFlags:[]}}});
  const item:Item={id:newId("item"),sessionId:session.id,turnId:turn.id,seq:0,step:1,type:"agentMessage",status:"failed",createdAtMs:now,completedAtMs:now,text:options.empty ? "" : "private partial assistant content",phase:"finalAnswer"};
  const usage={...emptyUsage(),inputTokens:2,outputTokens:1,totalTokens:3};
  const batch:CommitBatch={sessionId:session.id,fence:1,expectedLastSeq:2,turn:{...turn,usage},items:[item],events:[{type:"item/completed",sessionId:session.id,emittedAtMs:now,item},{type:"usage/updated",sessionId:session.id,emittedAtMs:now,turnId:turn.id,step:1,stepUsage:usage,turnUsage:usage,sessionUsage:usage,runtime:{provider:"unit",model:"unit"}}],usageEntries:[{usageId:newUsageId(),turnId:turn.id,step:1,provider:"unit",model:"unit",usage,createdAtMs:now}],sessionPatch:{usage}};
  const lookup={tenantId:session.tenantId,sessionId:session.id,turnId:turn.id,itemId:item.id,stepIndex:1};
  return {session,turn,item,batch,lookup};
}
export async function captureStepFixture(store:CaptureFixtureStore,options:{tenantId?:string;userId?:string;empty?:boolean}={}){
  const {session,turn,item,batch,lookup}=await uncapturedStepFixture(store,options);
  const now=item.createdAtMs;
  let record:StructuredTelemetryRecord|undefined;
  const telemetry=createStructuredTelemetry({component:"provider",opaqueRefKey:captureRefKey,now:()=>now,sink:{write(value){record=value;}}});
  telemetry.warn("provider.upstream_request_failed",{subjectRef:telemetry.opaqueRef("tenant",session.tenantId),ownerRef:telemetry.opaqueRef("session",session.id),errorKind:"unknown"});
  const proof=await store.getTenantTelemetryPersistedProviderCaptureBinding();if(!proof || !record)throw new Error("fixture capture not ready");
  const input:CommitPersistedProviderStepFailureInput={batch,source:{tenantId:session.tenantId,userId:session.userId,turnId:turn.id,itemId:item.id,stepIndex:1,failureKind:"provider_step_error"},record,freshProof:proof};
  return {session,turn,item,batch,input,lookup,proof};
}

/** Current-only paths: historical exports above deliberately retain their old schema contract.
 * No Vitest import: native crash/old-writer child processes also load this module.
 * The returned business batch remains unadmitted until its final caller-controlled content is fixed. */
export async function uncapturedCurrentStepFixture(store:SessionStore,options:{tenantId?:string;userId?:string;empty?:boolean}={}){
  const session=mkSession(options.tenantId ?? "capture-tenant",options.userId ?? "capture-user");
  await store.createSession(session);
  const command=createSessionAcquireCommand({sessionId:session.id,principal:{tenantId:session.tenantId,userId:session.userId},
    expectedFence:0,runnerId:"capture-fixture",runnerAddr:"127.0.0.1:1",bootId:randomUUID(),acquisitionId:randomUUID(),ttlMs:30_000});
  const acquired=await store.sessionAuthority.acquire(command);
  if(!acquired.ok||acquired.fence!==1)throw new Error("current_capture_fixture_authority_missing");
  let releasing:Promise<void>|undefined;
  const lease=Object.freeze({command,proof:acquired.proof,fence:acquired.fence,
    admit<T extends object>(value:T):T{return attachSessionWriteAdmission(value,acquired.proof);},
    release():Promise<void>{return releasing??=store.sessionAuthority.release(acquired.proof);}});
  const now=Date.now(),turn:Turn={id:newId("turn"),sessionId:session.id,status:"inProgress",seqStart:2,steps:1,toolCalls:0,usage:emptyUsage(),startedAtMs:now,metadata:{}};
  await store.commit(lease.admit({sessionId:session.id,fence:1,turn,events:[{type:"turn/started",sessionId:session.id,emittedAtMs:now,turn}],sessionPatch:{status:{type:"active",turnId:turn.id,activeFlags:[]}}}));
  const item:Item={id:newId("item"),sessionId:session.id,turnId:turn.id,seq:0,step:1,type:"agentMessage",status:"failed",createdAtMs:now,completedAtMs:now,text:options.empty ? "" : "private partial assistant content",phase:"finalAnswer"};
  const usage={...emptyUsage(),inputTokens:2,outputTokens:1,totalTokens:3};
  const batch:CommitBatch={sessionId:session.id,fence:1,expectedLastSeq:2,turn:{...turn,usage},items:[item],events:[{type:"item/completed",sessionId:session.id,emittedAtMs:now,item},{type:"usage/updated",sessionId:session.id,emittedAtMs:now,turnId:turn.id,step:1,stepUsage:usage,turnUsage:usage,sessionUsage:usage,runtime:{provider:"unit",model:"unit"}}],usageEntries:[{usageId:newUsageId(),turnId:turn.id,step:1,provider:"unit",model:"unit",usage,createdAtMs:now}],sessionPatch:{usage}};
  const lookup={tenantId:session.tenantId,sessionId:session.id,turnId:turn.id,itemId:item.id,stepIndex:1};
  return {session,turn,item,batch,lookup,lease};
}

export async function captureCurrentStepFixture(store:CaptureFixtureStore,options:{tenantId?:string;userId?:string;empty?:boolean}={}){
  const {session,turn,item,batch,lookup,lease}=await uncapturedCurrentStepFixture(store,options);
  const now=item.createdAtMs;
  let record:StructuredTelemetryRecord|undefined;
  const telemetry=createStructuredTelemetry({component:"provider",opaqueRefKey:captureRefKey,now:()=>now,sink:{write(value){record=value;}}});
  telemetry.warn("provider.upstream_request_failed",{subjectRef:telemetry.opaqueRef("tenant",session.tenantId),ownerRef:telemetry.opaqueRef("session",session.id),errorKind:"unknown"});
  const proof=await store.getTenantTelemetryPersistedProviderCaptureBinding();if(!proof || !record)throw new Error("fixture capture not ready");
  const input:CommitPersistedProviderStepFailureInput={batch,source:{tenantId:session.tenantId,userId:session.userId,turnId:turn.id,itemId:item.id,stepIndex:1,failureKind:"provider_step_error"},record,freshProof:proof};
  return {session,turn,item,batch,input,lookup,proof,lease};
}


/** Same synthetic journal descriptor as the historical helper; not external S3/fleet evidence. */
export function capturePrimaryJournalFixtureInput(){
  const target={targetOrdinal:0,targetSha256:D("1"),failureDomainSha256:D("2"),adapterProtocol:"memory-restore-journal-v1",journalNamespaceSha256:D("3")};
  return {adapterProtocol:target.adapterProtocol,journalNamespaceSha256:target.journalNamespaceSha256,logicalDatabaseNamespaceSha256:D("4"),runtimeEpochSha256:D("5"),targets:[target],observedHeads:[{...target,logicalDatabaseNamespaceSha256:D("4"),sealedRemoteSequence:0,sealedHeadRootSha256:EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256}]};
}

/** Current MySQL owner has already committed the genuine primary+binding successor. */
export async function activateCurrentCaptureFixture(store:CaptureFixtureStore){
  const journal=await store.getTenantRestoreJournalControl();
  if(journal.controlGeneration!==1||journal.adapterProtocol!=="memory-restore-journal-v1"
    ||journal.journalNamespaceSha256!==D("3"))throw new Error("current_capture_fixture_primary_missing");
  await store.activateTenantTelemetryLifecycle({expectedControlGeneration:0,targets:(["logs","traces"] as const).map((domain)=>({domain,...s3TenantTelemetryTargetIdentity({namespaceId:"store-unit",failureDomainId:"unit-no-external-sink",bucket:"store-unit",prefix:"capture",region:"us-east-1",endpoint:null,forcePathStyle:false,domain})}))});
  const lifecycle=await store.getTenantTelemetryLifecycleControl();if(lifecycle.state !== "active")throw new Error("fixture lifecycle missing");
  const logs=(await store.listTenantTelemetryLifecycleTargets()).find((t)=>t.domain === "logs")!;
  const activation={expectedControlGeneration:0 as const,lifecycleControlEvidenceSha256:lifecycle.activationEvidenceSha256,logsTargetSha256:logs.targetSha256,logsTargetReceiptSha256:logs.receiptSha256,configuredFleetRootSha256:D("6"),fleetStoppedAck:"fleet-stopped-v1" as const,legacyWritersDrainedAck:"legacy-writers-drained-v1" as const,producerReadyAck:"provider-step-error-v2-ready-v1" as const,localOnlyAck:"local-only-v1" as const};
  await store.withTenantTelemetryCaptureOperatorFence((fence)=>store.activateTenantTelemetryPersistedProviderCapture(activation,fence),{timeoutMs:5000});
  return activation;
}
