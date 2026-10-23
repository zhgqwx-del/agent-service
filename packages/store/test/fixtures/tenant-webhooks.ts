import { attachSessionWriteAdmission } from "../../src/session-authority.js";
import { acquireFixtureSessionAuthority } from "./session-authority.js";
import { createHash, randomUUID } from "node:crypto";
import { emptyUsage, type Item, type Turn } from "@agent-service/protocol";
import * as W from "../../src/tenant-webhooks.js";
import type { CommitBatch, SessionStore } from "../../src/types.js";
import { mkSession, newId } from "../conformance.js";

export const webhookSha = (value: string) => createHash("sha256").update(value).digest("hex");
/** Store-only envelope fixture, not a cryptographic or HTTP delivery proof. */
export function webhookEnvelope(size = 32): W.TenantWebhookEnvelope {
  return { profile: "tenant-webhook-aes-256-gcm-v2", keyId: "test-hooks-master", iv: Buffer.alloc(12, 1).toString("base64"),
    ciphertext: Buffer.alloc(size, 2).toString("base64"), tag: Buffer.alloc(16, 3).toString("base64") };
}
export function webhookWrite(access: W.TenantWebhookAccess, name = "observer", expectedRevision = 0, idempotencyKey = "install",
  config: W.TenantWebhookConfig = { endpoint: "https://hooks.example.test/observe", phase: "postToolUse", bodyScopes: [] }, generation = 1): W.UpsertTenantWebhookInput {
  return { access, name, expectedRevision, idempotencyKey, admission: W.createTenantWebhookConfigAdmission({ access,name,expectedRevision,idempotencyKey,generation,config,
    signingKey: webhookEnvelope(), keyCommitmentSha256: webhookSha("fixture signing commitment"),
    disclosureAck: config.bodyScopes.length ? "tenant-admin-body-disclosure-v1" : null }) };
}
export async function webhookSession(store: SessionStore, tenantId = `hook-${randomUUID()}`, userId = "owner") {
  const keyId = `key-${randomUUID()}`;
  await store.createApiKey(tenantId,keyId,webhookSha(randomUUID()),["admin"]);
  const owner = { tenantId,userId }, admin = W.createTenantWebhookAdminAccess({ tenantId,apiKeyId:keyId });
  const session = mkSession(tenantId,userId); await store.createSession(session);
  const lease = await acquireFixtureSessionAuthority(store, session, 0);
  const access = attachSessionWriteAdmission(W.createTenantWebhookRuntimeAccess(owner), lease.proof);
  try {
  const turn: Turn = { id:newId("turn"),sessionId:session.id,status:"inProgress",seqStart:0,steps:0,toolCalls:0,usage:emptyUsage(),startedAtMs:Date.now() };
  const user: Extract<Item,{type:"userMessage"}> = { id:newId("item"),sessionId:session.id,turnId:turn.id,seq:0,type:"userMessage",status:"completed",createdAtMs:Date.now(),content:[{type:"text",text:"original user text"}] };
  const call: Extract<Item,{type:"toolCall"}> = { id:newId("item"),sessionId:session.id,turnId:turn.id,seq:0,type:"toolCall",status:"inProgress",createdAtMs:Date.now(),toolCallId:"call_reusable",name:"echo",kind:"builtin",args:{text:"tool argument"} };
  await store.commit(lease.admit({ sessionId:session.id,fence:1,turn,items:[user,call],events:[
    {type:"turn/started",sessionId:session.id,turn,emittedAtMs:Date.now()},
    {type:"item/completed",sessionId:session.id,item:user,emittedAtMs:Date.now()},
    {type:"item/started",sessionId:session.id,item:call,emittedAtMs:Date.now()},
  ] }));
  return { store,owner,admin,access,session,turn,user,call,lease };
  } catch (reason) { try { await lease.release(); } catch { /* Preserve the preparation failure. */ } throw reason; }
}
export type WebhookFixture = Awaited<ReturnType<typeof webhookSession>>;
export function webhookCommit(store: SessionStore, plan: { batch: CommitBatch; admission: W.TenantWebhookMilestoneAdmission }) {
  return store.commitTenantWebhookMilestone({ batch: plan.batch, admission: plan.admission });
}
export async function webhookMilestone(f: WebhookFixture, kind: "pre"|"started"|"post", unavailable = false) {
  const source = await f.store.readTenantWebhookSources({ access:f.access,sessionId:f.session.id,turnId:f.turn.id,callItemId:f.call.id,fence:1 });
  const batch: CommitBatch = { sessionId:f.session.id,fence:1,events:[] };
  let canonicalResult: W.TenantWebhookCanonicalResult|null = null;
  if (kind === "started") { const call = {...f.call,startedAtMs:Date.now()}; batch.items=[call];batch.events=[{type:"item/started",sessionId:f.session.id,item:call,emittedAtMs:Date.now()}]; }
  if (kind === "post") { const content=[{type:"text" as const,text:"canonical output"}], payload={content,details:["canonical",1]};
    const item: Extract<Item,{type:"toolResult"}> = { id:newId("item"),sessionId:f.session.id,turnId:f.turn.id,seq:0,type:"toolResult",status:"completed",createdAtMs:Date.now(),toolCallId:f.call.toolCallId,name:f.call.name,isError:false,...payload };
    batch.items=[item];batch.events=[{type:"item/completed",sessionId:f.session.id,item,emittedAtMs:Date.now()}];
    canonicalResult={itemId:item.id,isError:false,payload,payloadSha256:webhookSha(JSON.stringify(payload)),payloadBytes:Buffer.byteLength(JSON.stringify(payload))}; }
  const selected = source.value.registrations.filter(r => kind === "started" ? r.version?.config.phase === "postToolUse" : r.version?.config.phase === (kind === "pre" ? "preToolUse":"postToolUse"));
  const failures = unavailable ? selected.map(r=>({configVersionId:r.version!.configVersionId,code:"observation_unavailable" as const})) : [];
  const snapshots = kind === "started" && !unavailable ? selected.map(r=>({configVersionId:r.version!.configVersionId,plaintextSha256:webhookSha("snapshot fixture"),envelope:webhookEnvelope(64)})) : [];
  const payloads = kind !== "started" && !unavailable ? selected.map(r=>({configVersionId:r.version!.configVersionId,invocationId:randomUUID(),requestSha256:webhookSha("request fixture"),payloadSha256:webhookSha("payload fixture"),payloadBytes:64,envelope:webhookEnvelope(64)})) : [];
  attachSessionWriteAdmission(batch, f.lease.proof);
  const admission=W.createTenantWebhookMilestoneAdmission({ source,kind,batch,snapshots,payloads,failures,canonicalResult });
  return { source,batch,admission,canonicalResult,payloads,snapshots,failures };
}
