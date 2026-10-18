import { createHash, randomBytes } from "node:crypto";
import type { Item } from "@agent-service/protocol";
import * as W from "./tenant-webhooks.js";

export interface TenantWebhookReplay { keySha256: string; requestSha256: string; result: W.TenantWebhookRegistration }
export interface TenantWebhookImage {
  slot: W.TenantWebhookSlot | null; versions: W.TenantWebhookVersion[]; replays: TenantWebhookReplay[];
  snapshots: W.TenantWebhookInvocationSnapshot[]; intents: W.TenantWebhookIntent[];
}
export const emptyTenantWebhookImage = (): TenantWebhookImage => ({ slot: null, versions: [], replays: [], snapshots: [], intents: [] });
function fail(): never { throw new W.TenantWebhookIntegrityError(); }
function conflict(): never { throw new W.TenantWebhookConflictError(); }
export const webhookSame = (a: unknown, b: unknown) => W.tenantWebhookDigest("tenant-webhook-row-v2", a) === W.tenantWebhookDigest("tenant-webhook-row-v2", b);
export const webhookRawSha = (raw: string) => createHash("sha256").update(raw).digest("hex");
/** Model toolCallId is not unique: select the actual latest durable write-ahead
 * item in this turn/step, not a historical call's snapshot with the same id. */
export function actualWebhookResultCall(items: readonly Item[], result: Extract<Item,{type:"toolResult"}>): Extract<Item,{type:"toolCall"}> | null {
  const candidates = items.filter((item): item is Extract<Item,{type:"toolCall"}> => item.type === "toolCall" && item.sessionId === result.sessionId
    && item.turnId === result.turnId && item.toolCallId === result.toolCallId && item.name === result.name
    && (result.step === undefined || item.step === result.step));
  candidates.sort((a,b)=>b.seq-a.seq); return candidates[0] ?? null;
}
function exceedsObservationDepth(value: unknown, depth = 0): boolean {
  if (depth > 24) return true;
  return !!value && typeof value === "object" && Object.values(value).some(child => exceedsObservationDepth(child, depth + 1));
}
export function validateTenantWebhookImage(image: TenantWebhookImage): void {
  if (!image.slot) { if (image.versions.length || image.replays.length || image.snapshots.length || image.intents.length) fail(); return; }
  const slot = image.slot; if (slot.webhookId !== W.tenantWebhookId(slot.tenantId, slot.name)) fail();
  W.tenantWebhookClosed(slot, ["webhookId","tenantId","name","revision","generation","state","currentVersionId","createdAtMs","updatedAtMs"]);
  W.tenantWebhookNatural(slot.revision); W.tenantWebhookNatural(slot.generation); if (!slot.revision || !slot.generation) fail();
  W.tenantWebhookNatural(slot.createdAtMs); W.tenantWebhookNatural(slot.updatedAtMs); if (slot.updatedAtMs < slot.createdAtMs) fail();
  if (!["enabled", "disabled", "deleted"].includes(slot.state) || (slot.state === "deleted") !== (slot.currentVersionId === null)) fail();
  if (new Set(image.versions.map(v => v.configVersionId)).size !== image.versions.length) fail();
  for (const version of image.versions) {
    W.tenantWebhookClosed(version, ["configVersionId","webhookId","tenantId","name","revision","generation","config","configSha256","keyVersionId","keyCommitmentSha256","signingKey","disclosureSha256","adminApiKeyId","createdAtMs"]);
    W.tenantWebhookSha(version.configVersionId); W.tenantWebhookNatural(version.createdAtMs); W.tenantWebhookNatural(version.revision); W.tenantWebhookNatural(version.generation);
    W.validateTenantWebhookConfig(version.config); W.validateTenantWebhookEnvelope(version.signingKey, 32);
    if (version.webhookId !== slot.webhookId || version.tenantId !== slot.tenantId || version.name !== slot.name
      || version.generation > slot.generation || version.revision > slot.revision || version.keyVersionId !== version.configVersionId
      || version.configSha256 !== W.tenantWebhookDigest("tenant-webhook-config-v2", version.config)) fail();
    W.tenantWebhookSha(version.keyCommitmentSha256); W.tenantWebhookText(version.adminApiKeyId, 128);
    const disclosure = version.config.bodyScopes.length ? W.tenantWebhookDigest("tenant-webhook-admin-disclosure-v2", {
      tenantId: slot.tenantId, adminApiKeyId: version.adminApiKeyId, configVersionId: version.configVersionId,
      keyVersionId: version.keyVersionId, config: version.config,
    }) : null;
    if (version.disclosureSha256 !== disclosure) fail();
  }
  if (slot.currentVersionId !== null && !image.versions.some(v => v.configVersionId === slot.currentVersionId && v.generation === slot.generation)) fail();
  if (new Set(image.intents.map(i => i.intentId)).size !== image.intents.length || new Set(image.snapshots.map(i => i.snapshotId)).size !== image.snapshots.length) fail();
  for (const row of [...image.intents, ...image.snapshots]) {
    if (row.webhookId !== slot.webhookId || row.subject.tenantId !== slot.tenantId || !image.versions.some(v => v.configVersionId === row.configVersionId && v.generation === row.generation)) fail();
    W.tenantWebhookPrincipal(row.subject); W.tenantWebhookSha(row.sourceSha256);
    W.tenantWebhookNatural(row.fence); W.tenantWebhookNatural(row.registrationRevision);
    W.tenantWebhookNatural(row.throughSeq); W.tenantWebhookNatural(row.createdAtMs);
    for (const value of [row.sessionId,row.turnId,row.callItemId,row.toolCallId]) W.tenantWebhookText(value,128);
    if (!row.registrationRevision || row.registrationRevision > slot.revision) fail();
  }
  for (const intent of image.intents) {
    W.tenantWebhookClosed(intent, ["intentId","webhookId","tenantId","configVersionId","generation","registrationRevision","fence","phase","subject","sessionId","turnId","callItemId","toolCallId","resultItemId","throughSeq","sourceSha256","requestSha256","payloadSha256","payloadBytes","payload","invocationId","state","preparedDeadlineAtMs","claimTokenSha256","sendDeadlineAtMs","resultSha256","createdAtMs","completedAtMs","finishRequestSha256"]);
    const version = image.versions.find(v => v.configVersionId === intent.configVersionId)!;
    if (intent.intentId !== W.tenantWebhookIntentId(intent.configVersionId, intent.callItemId, intent.phase) || intent.phase !== version.config.phase) fail();
    const noPayload = intent.payload === null;
    if (noPayload) { if (intent.state !== "failed_not_dispatched" || intent.payloadSha256 !== null || intent.requestSha256 !== null || intent.payloadBytes !== null || intent.invocationId !== null || intent.claimTokenSha256 !== null) fail(); }
    else { W.validateTenantWebhookEnvelope(intent.payload); W.tenantWebhookSha(intent.payloadSha256); W.tenantWebhookSha(intent.requestSha256); }
    if (!["prepared", "sending", "acknowledged", "failed_not_dispatched", "outcome_unknown", "blocked"].includes(intent.state)
      || intent.preparedDeadlineAtMs < intent.createdAtMs || !noPayload && (intent.payloadBytes === null || intent.payloadBytes < 1 || intent.payloadBytes > 65_536)) fail();
    if (intent.state === "prepared" && (intent.claimTokenSha256 !== null || intent.sendDeadlineAtMs !== null || intent.completedAtMs !== null)) fail();
    if (intent.state === "sending" && (!intent.claimTokenSha256 || intent.sendDeadlineAtMs === null || intent.completedAtMs !== null)) fail();
    if (!["prepared", "sending"].includes(intent.state) && (intent.completedAtMs === null || intent.resultSha256 === null)) fail();
  }
  for (const snapshot of image.snapshots) {
    W.tenantWebhookClosed(snapshot, ["snapshotId","webhookId","configVersionId","generation","registrationRevision","fence","subject","sessionId","turnId","callItemId","toolCallId","throughSeq","sourceSha256","availability","plaintextSha256","envelope","createdAtMs"]);
    if (snapshot.snapshotId !== W.tenantWebhookSnapshotId(snapshot.configVersionId, snapshot.callItemId)) fail();
    if (snapshot.availability === "unavailable") { if (snapshot.envelope !== null || snapshot.plaintextSha256 !== null) fail(); }
    else { if (snapshot.availability !== "available") fail(); W.validateTenantWebhookEnvelope(snapshot.envelope); W.tenantWebhookSha(snapshot.plaintextSha256); }
  }
  for (const receipt of image.replays) { W.tenantWebhookClosed(receipt, ["keySha256","requestSha256","result"]); W.tenantWebhookSha(receipt.keySha256); W.tenantWebhookSha(receipt.requestSha256);
    if (receipt.result.slot.webhookId !== slot.webhookId || receipt.result.slot.tenantId !== slot.tenantId || receipt.result.slot.revision > slot.revision
      || receipt.result.version && !image.versions.some(v => webhookSame(v,receipt.result.version))) fail(); }
}
export function webhookReplayKey(webhookId: string, kind: "upsert" | "state", key: string): string {
  W.tenantWebhookText(key, 128); return W.tenantWebhookDigest("tenant-webhook-management-replay-v2", { webhookId, kind, key });
}
export function upsertWebhook(image: TenantWebhookImage, input: W.UpsertTenantWebhookInput, now: number): W.TenantWebhookRegistration {
  W.tenantWebhookClosed(input, ["access", "name", "expectedRevision", "idempotencyKey", "admission"]);
  const authority = W.assertTenantWebhookAccess(input.access, "admin"), admitted = W.assertTenantWebhookConfigAdmission(input.admission);
  if (admitted.access !== input.access || admitted.name !== input.name || admitted.expectedRevision !== input.expectedRevision || admitted.idempotencyKey !== input.idempotencyKey) fail();
  const webhookId = W.tenantWebhookId(authority.tenantId, input.name), keySha256 = webhookReplayKey(webhookId, "upsert", input.idempotencyKey);
  const requestSha256 = W.tenantWebhookDigest("tenant-webhook-upsert-v2", { expectedRevision: input.expectedRevision, config: admitted.config, keyCommitmentSha256: admitted.keyCommitmentSha256,
    adminApiKeyId: authority.apiKeyId, disclosureAck: admitted.disclosureAck });
  const old = image.replays.find(r => r.keySha256 === keySha256);
  if (old) { if (old.requestSha256 !== requestSha256 || image.slot?.revision !== old.result.slot.revision) conflict(); return structuredClone(old.result); }
  if ((image.slot?.revision ?? 0) !== input.expectedRevision) conflict();
  const generation = image.slot ? image.slot.generation + (image.slot.state === "deleted" ? 1 : 0) : 1;
  if (admitted.generation !== generation) conflict();
  if (image.versions.filter(v => v.generation === generation).length >= 128) conflict();
  const configVersionId = W.tenantWebhookVersionId(authority.tenantId, input.name, input.expectedRevision, input.idempotencyKey);
  const config = structuredClone(admitted.config), version: W.TenantWebhookVersion = {
    configVersionId, webhookId, tenantId: authority.tenantId, name: input.name, revision: input.expectedRevision + 1,
    generation, config, configSha256: W.tenantWebhookDigest("tenant-webhook-config-v2", config), keyVersionId: configVersionId,
    keyCommitmentSha256: admitted.keyCommitmentSha256, signingKey: structuredClone(admitted.signingKey),
    disclosureSha256: config.bodyScopes.length ? W.tenantWebhookDigest("tenant-webhook-admin-disclosure-v2", {
      tenantId: authority.tenantId, adminApiKeyId: authority.apiKeyId, configVersionId, keyVersionId: configVersionId, config,
    }) : null, adminApiKeyId: authority.apiKeyId!, createdAtMs: now,
  };
  const slot: W.TenantWebhookSlot = { webhookId, tenantId: authority.tenantId, name: input.name, revision: version.revision,
    generation, state: "enabled", currentVersionId: configVersionId, createdAtMs: image.slot?.createdAtMs ?? now, updatedAtMs: now };
  image.slot = slot; image.versions.push(version); const result = { slot, version };
  image.replays.push({ keySha256, requestSha256, result }); return structuredClone(result);
}
export function setWebhookState(image: TenantWebhookImage, input: W.TenantWebhookNameInput & { expectedRevision: number; idempotencyKey: string; state: "enabled" | "disabled" | "deleted" }, now: number): W.TenantWebhookSlot {
  W.tenantWebhookClosed(input, ["access", "name", "expectedRevision", "idempotencyKey", "state"]);
  const access = W.assertTenantWebhookAccess(input.access, "admin"), webhookId = W.tenantWebhookId(access.tenantId, input.name);
  if (!["enabled", "disabled", "deleted"].includes(input.state)) fail(); W.tenantWebhookNatural(input.expectedRevision);
  const keySha256 = webhookReplayKey(webhookId, "state", input.idempotencyKey), requestSha256 = W.tenantWebhookDigest("tenant-webhook-state-v2", { expectedRevision: input.expectedRevision, state: input.state, adminApiKeyId: access.apiKeyId });
  const replay = image.replays.find(r => r.keySha256 === keySha256);
  if (replay) { if (replay.requestSha256 !== requestSha256 || image.slot?.revision !== replay.result.slot.revision) conflict(); return structuredClone(replay.result.slot); }
  const old = image.slot; if (!old || old.revision !== input.expectedRevision || old.state === "deleted") conflict();
  const slot = { ...old, revision: old.revision + 1, state: input.state, currentVersionId: input.state === "deleted" ? null : old.currentVersionId, updatedAtMs: now };
  image.slot = slot; image.replays.push({ keySha256, requestSha256, result: { slot, version: slot.currentVersionId ? image.versions.find(v => v.configVersionId === slot.currentVersionId)! : null } });
  return structuredClone(slot);
}
export function sourceValue(input: W.TenantWebhookSourceInput, items: readonly Item[], throughSeq: number, registrations: readonly W.TenantWebhookRegistration[], snapshots: readonly W.TenantWebhookInvocationSnapshot[]): W.TenantWebhookSourceValue {
  const access = W.assertTenantWebhookAccess(input.access, "runtime"), principal = access.principal!;
  const call = items.find(item => item.id === input.callItemId);
  if (!call || call.type !== "toolCall" || call.sessionId !== input.sessionId || call.turnId !== input.turnId || call.seq > throughSeq) fail();
  const afterStart = call.startedAtMs !== undefined;
  const active = registrations.filter(r => r.version !== null && (afterStart ? snapshots.some(s => s.configVersionId === r.version!.configVersionId) : r.slot.state === "enabled"));
  if (active.length > 8) conflict();
  const needPrompt = !afterStart && active.some(r => r.version!.config.bodyScopes.includes("prompt"));
  const needArgs = !afterStart && active.some(r => r.version!.config.bodyScopes.includes("tool_arguments"));
  const parts: W.TenantWebhookPromptPart[] = [];
  if (needPrompt) for (const item of [...items].sort((a, b) => a.seq - b.seq)) {
    if (item.type !== "userMessage" || item.turnId !== input.turnId || item.sessionId !== input.sessionId || item.seq > throughSeq) continue;
    item.content.forEach((part, partIndex) => { if (part.type === "text") parts.push({ itemId: item.id, seq: item.seq, partIndex, text: part.text, textSha256: webhookRawSha(part.text) }); });
  }
  const fullPromptSha256 = W.tenantWebhookDigest("tenant-webhook-prompt-snapshot-v2", { throughSeq, parts });
  const argsJson = needArgs ? JSON.stringify(call.args) : "null";
  const observationUnavailable = parts.length > 256 || parts.reduce((n, p) => n + Buffer.byteLength(p.text), 0) > 65_536
    || typeof argsJson !== "string" || Buffer.byteLength(argsJson) > 65_536 || needArgs && exceedsObservationDepth(call.args);
  const prompt = { profile: "current_turn_user_text_v1" as const, throughSeq, parts: observationUnavailable ? [] : parts,
    sha256: fullPromptSha256 };
  const args = needArgs && !observationUnavailable ? structuredClone(call.args) : null;
  const sourceSha256 = W.tenantWebhookDigest("tenant-webhook-source-snapshot-v2", {
    principal, sessionId: input.sessionId, turnId: input.turnId, callItemId: call.id, toolCallId: call.toolCallId,
    toolName: call.name, toolKind: call.kind, throughSeq, promptSha256: prompt.sha256,
    argumentsSha256: webhookRawSha(argsJson ?? "null"), observationUnavailable,
  });
  return { principal, sessionId: input.sessionId, turnId: input.turnId, fence: input.fence, callItemId: call.id,
    toolCallId: call.toolCallId, toolName: call.name, toolKind: call.kind, throughSeq, sourceSha256, observationUnavailable, prompt, arguments: args,
    registrations: structuredClone(active), startedSnapshots: structuredClone(snapshots) };
}
export function applyWebhookMilestone(image: TenantWebhookImage, input: W.TenantWebhookMilestoneAdmissionInput, current: W.TenantWebhookSourceValue, now: number): W.TenantWebhookIntent[] {
  const original = W.assertTenantWebhookSource(input.source), batch = input.batch;
  if (!webhookSame(original.principal, current.principal) || original.sessionId !== batch.sessionId || original.fence !== batch.fence
    || original.callItemId !== current.callItemId || original.sourceSha256 !== current.sourceSha256) conflict();
  const slot = image.slot;
  if (!slot) conflict();
  const selected = original.registrations.find(r => r.slot.webhookId === slot.webhookId);
  const version = image.versions.find(v => v.configVersionId === (input.kind === "post" ? selected?.version?.configVersionId : slot.currentVersionId));
  if (!selected || !version || input.kind !== "post" && (slot.state !== "enabled" || !webhookSame(selected.slot, slot))) conflict();
  if (input.kind === "started") {
    const call = batch.items?.find(i => i.id === original.callItemId);
    if (!call || call.type !== "toolCall" || !call.startedAtMs) fail();
    if (version.config.phase !== "postToolUse") return [];
    const prepared = input.snapshots.find(p => p.configVersionId === version.configVersionId), unavailable = input.failures.some(p => p.configVersionId === version.configVersionId);
    if (!prepared && !unavailable) fail();
    const snapshotId = W.tenantWebhookSnapshotId(version.configVersionId, original.callItemId);
    const row: W.TenantWebhookInvocationSnapshot = { snapshotId, webhookId: slot.webhookId, configVersionId: version.configVersionId,
      generation: version.generation, registrationRevision: slot.revision, fence: original.fence,
      subject: original.principal, sessionId: original.sessionId, turnId: original.turnId,
      callItemId: original.callItemId, toolCallId: original.toolCallId, throughSeq: original.throughSeq, sourceSha256: original.sourceSha256,
      availability: unavailable ? "unavailable" : "available", plaintextSha256: prepared?.plaintextSha256 ?? null, envelope: prepared ? structuredClone(prepared.envelope) : null, createdAtMs: now };
    const prior = image.snapshots.find(s => s.snapshotId === snapshotId);
    if (prior && !webhookSame({ ...prior, createdAtMs: now }, row)) conflict();
    if (!prior) image.snapshots.push(row); return [];
  }
  const phase = input.kind === "pre" ? "preToolUse" : "postToolUse";
  if (version.config.phase !== phase) return [];
  const payload = input.payloads.find(p => p.configVersionId === version.configVersionId), unavailable = input.failures.some(p => p.configVersionId === version.configVersionId);
  if (!payload && !unavailable) fail();
  let snapshot = original, registrationRevision = slot.revision;
  if (phase === "postToolUse") {
    const fixed = image.snapshots.find(s => s.snapshotId === W.tenantWebhookSnapshotId(version.configVersionId, original.callItemId));
    if (!fixed || fixed.sessionId !== original.sessionId || !webhookSame(fixed.subject, original.principal)) fail();
    if (fixed.availability === "unavailable" && !unavailable) fail();
    const result = input.canonicalResult, item = batch.items?.find(i => i.id === result?.itemId);
    if (!result || !item || item.type !== "toolResult" || item.toolCallId !== original.toolCallId || item.turnId !== original.turnId || item.name !== original.toolName || item.isError !== result.isError) fail();
    if (!item.outputRef && webhookRawSha(JSON.stringify({ content: item.content, ...(item.details === undefined ? {} : { details: item.details }) })) !== result.payloadSha256) fail();
    snapshot = { ...original, throughSeq: fixed.throughSeq, sourceSha256: fixed.sourceSha256 };
    registrationRevision = fixed.registrationRevision;
  }
  const intentId = W.tenantWebhookIntentId(version.configVersionId, original.callItemId, phase), old = image.intents.find(i => i.intentId === intentId);
  if (old) { if (old.requestSha256 !== (payload?.requestSha256 ?? null) || old.payloadSha256 !== (payload?.payloadSha256 ?? null)) conflict(); return [structuredClone(old)]; }
  const permitted = slot.state === "enabled" && slot.currentVersionId === version.configVersionId && slot.generation === version.generation && slot.revision === registrationRevision;
  const intent: W.TenantWebhookIntent = { intentId, webhookId: slot.webhookId, tenantId: slot.tenantId, configVersionId: version.configVersionId,
    generation: version.generation, registrationRevision, fence: original.fence, phase, subject: original.principal, sessionId: original.sessionId, turnId: original.turnId, callItemId: original.callItemId,
    toolCallId: original.toolCallId, resultItemId: input.canonicalResult?.itemId ?? null, throughSeq: snapshot.throughSeq, sourceSha256: snapshot.sourceSha256,
    requestSha256: payload?.requestSha256 ?? null, payloadSha256: payload?.payloadSha256 ?? null, payloadBytes: payload?.payloadBytes ?? null, payload: payload ? structuredClone(payload.envelope) : null, invocationId: payload?.invocationId ?? null,
    state: unavailable ? "failed_not_dispatched" : permitted ? "prepared" : "blocked",
    preparedDeadlineAtMs: now + 5000, claimTokenSha256: null, sendDeadlineAtMs: null,
    resultSha256: unavailable ? W.tenantWebhookDigest("tenant-webhook-observation-unavailable-v2", intentId) : permitted ? null : W.tenantWebhookDigest("tenant-webhook-revoked-v2", intentId),
    createdAtMs: now, completedAtMs: !unavailable && permitted ? null : now, finishRequestSha256: null };
  image.intents.push(intent); return [structuredClone(intent)];
}
export function settleExpiredWebhookIntent(intent: W.TenantWebhookIntent, now: number): W.TenantWebhookIntent {
  const expired = intent.state === "prepared" && now >= intent.preparedDeadlineAtMs || intent.state === "sending" && now >= intent.sendDeadlineAtMs!;
  return expired ? { ...intent, state: intent.state === "prepared" ? "failed_not_dispatched" : "outcome_unknown", completedAtMs: now,
    resultSha256: W.tenantWebhookDigest("tenant-webhook-expired-v2", { intentId: intent.intentId, state: intent.state }) } : intent;
}
export function abandonPreparedWebhook(image: TenantWebhookImage, intentId: string, now: number): W.TenantWebhookIntent | null {
  W.tenantWebhookSha(intentId); const at=image.intents.findIndex(i=>i.intentId===intentId); if(at<0)return null;
  const current=image.intents[at]!; if(current.state!=="prepared")return structuredClone(current);
  const terminal:W.TenantWebhookIntent={...current,state:"failed_not_dispatched",completedAtMs:now,
    resultSha256:W.tenantWebhookDigest("tenant-webhook-phase-ended-before-dispatch-v2",intentId)};
  image.intents[at]=terminal;return structuredClone(terminal);
}
export function claimWebhook(image: TenantWebhookImage, intentId: string, now: number, timeoutMs: number): W.TenantWebhookDeliveryClaim | null {
  W.tenantWebhookSha(intentId); W.tenantWebhookNatural(timeoutMs); if (timeoutMs < 1 || timeoutMs > 5000) fail();
  const at = image.intents.findIndex(i => i.intentId === intentId); if (at < 0) return null;
  image.intents[at] = settleExpiredWebhookIntent(image.intents[at]!, now); const current = image.intents[at]!;
  if (current.state !== "prepared") return null;
  if (current.payload === null || current.requestSha256 === null || current.payloadSha256 === null || current.payloadBytes === null || current.invocationId === null) fail();
  const version = image.versions.find(v => v.configVersionId === current.configVersionId)!;
  if (image.slot?.state !== "enabled" || image.slot.currentVersionId !== current.configVersionId || image.slot.generation !== current.generation || image.slot.revision !== current.registrationRevision) {
    image.intents[at] = { ...current, state: "blocked", completedAtMs: now, resultSha256: W.tenantWebhookDigest("tenant-webhook-blocked-v2", intentId) }; return null;
  }
  const claimToken = randomBytes(32).toString("hex"), intent = { ...current, state: "sending" as const,
    claimTokenSha256: W.tenantWebhookDigest("tenant-webhook-claim-v2", claimToken), sendDeadlineAtMs: now + timeoutMs };
  image.intents[at] = intent; return { intent: structuredClone({ ...intent, payload: current.payload, requestSha256: current.requestSha256,
    payloadSha256: current.payloadSha256, payloadBytes: current.payloadBytes, invocationId: current.invocationId }), registration: structuredClone(version), claimToken };
}
export function finishWebhook(image: TenantWebhookImage, input: { intentId: string; claimToken: string; outcome: "acknowledged" | "failed_not_dispatched" | "outcome_unknown"; resultSha256: string }, now: number): W.TenantWebhookIntent {
  W.tenantWebhookSha(input.intentId); W.tenantWebhookSha(input.resultSha256); W.tenantWebhookText(input.claimToken, 64);
  if (!["acknowledged", "failed_not_dispatched", "outcome_unknown"].includes(input.outcome)) fail();
  const at = image.intents.findIndex(i => i.intentId === input.intentId); if (at < 0) conflict();
  const original = image.intents[at]!, token = W.tenantWebhookDigest("tenant-webhook-claim-v2", input.claimToken);
  if (original.claimTokenSha256 !== token) conflict();
  const finishRequestSha256 = W.tenantWebhookDigest("tenant-webhook-finish-request-v2", { claimTokenSha256: token, outcome: input.outcome, resultSha256: input.resultSha256 });
  const current = settleExpiredWebhookIntent(original, now);
  if (original.state === "sending" && current.state === "outcome_unknown") {
    const terminal = { ...current, finishRequestSha256 }; image.intents[at] = terminal; return structuredClone(terminal);
  }
  if (current.state !== "sending") {
    if (current.state === "outcome_unknown" && current.finishRequestSha256 === null && current.sendDeadlineAtMs !== null
      && now >= current.sendDeadlineAtMs && current.resultSha256 === W.tenantWebhookDigest("tenant-webhook-expired-v2", {intentId:current.intentId,state:"sending"})) {
      const terminal = {...current,finishRequestSha256}; image.intents[at] = terminal; return structuredClone(terminal);
    }
    if (current.finishRequestSha256 !== finishRequestSha256) conflict(); return structuredClone(current);
  }
  if (image.slot?.state !== "enabled" || image.slot.currentVersionId !== current.configVersionId || image.slot.generation !== current.generation || image.slot.revision !== current.registrationRevision) {
    const unknown = { ...current, state: "outcome_unknown" as const, completedAtMs: now, resultSha256: input.resultSha256, finishRequestSha256 };
    image.intents[at] = unknown; return structuredClone(unknown);
  }
  const finished = { ...current, state: input.outcome, completedAtMs: now, resultSha256: input.resultSha256, finishRequestSha256 };
  image.intents[at] = finished; return structuredClone(finished);
}
