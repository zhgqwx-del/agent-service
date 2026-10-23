import { transferSessionWriteAdmission } from "./session-authority.js";
import { Principal } from "@agent-service/protocol";
import { createHash } from "node:crypto";
import type { CommitBatch, CommitResult } from "./types.js";

/** Tenant configuration authority is separate from the actual session user's runtime authority. */
export interface TenantWebhookAccess { readonly kind: "tenant-webhook-access-v2" }
export interface TenantWebhookConfigAdmission { readonly kind: "tenant-webhook-config-admission-v2" }
export interface TenantWebhookSource { readonly kind: "tenant-webhook-source-v2"; readonly value: TenantWebhookSourceValue }
export interface TenantWebhookMilestoneAdmission { readonly kind: "tenant-webhook-milestone-admission-v2" }
export type TenantWebhookPhase = "preToolUse" | "postToolUse";
export type TenantWebhookBodyScope = "prompt" | "tool_arguments" | "tool_result";
export interface TenantWebhookConfig {
  readonly endpoint: string; readonly phase: TenantWebhookPhase; readonly bodyScopes: readonly TenantWebhookBodyScope[];
}
export interface TenantWebhookEnvelope {
  readonly profile: "tenant-webhook-aes-256-gcm-v2"; readonly keyId: string;
  readonly iv: string; readonly ciphertext: string; readonly tag: string;
}
export interface TenantWebhookAad {
  readonly profile: "tenant-webhook-secret-aad-v2"; readonly purpose: "signing_key" | "invocation_snapshot" | "delivery_payload";
  readonly tenantId: string; readonly webhookId: string; readonly configVersionId: string; readonly generation: number;
  readonly materialId: string; readonly subject: Principal | null; readonly sessionId: string | null;
  readonly turnId: string | null; readonly callItemId: string | null; readonly phase: TenantWebhookPhase;
  readonly endpointSha256: string; readonly bodyScopesSha256: string;
}
export interface TenantWebhookSlot {
  readonly webhookId: string; readonly tenantId: string; readonly name: string; readonly revision: number;
  readonly generation: number; readonly state: "enabled" | "disabled" | "deleted";
  readonly currentVersionId: string | null; readonly createdAtMs: number; readonly updatedAtMs: number;
}
export interface TenantWebhookVersion {
  readonly configVersionId: string; readonly webhookId: string; readonly tenantId: string; readonly name: string;
  readonly revision: number; readonly generation: number; readonly config: TenantWebhookConfig; readonly configSha256: string;
  readonly keyVersionId: string; readonly keyCommitmentSha256: string; readonly signingKey: TenantWebhookEnvelope;
  readonly disclosureSha256: string | null; readonly adminApiKeyId: string; readonly createdAtMs: number;
}
export interface TenantWebhookRegistration { readonly slot: TenantWebhookSlot; readonly version: TenantWebhookVersion | null }
export interface TenantWebhookPromptPart {
  readonly itemId: string; readonly seq: number; readonly partIndex: number; readonly text: string; readonly textSha256: string;
}
export interface TenantWebhookPromptSnapshot {
  readonly profile: "current_turn_user_text_v1"; readonly throughSeq: number;
  readonly parts: readonly TenantWebhookPromptPart[]; readonly sha256: string;
}
/** Ephemeral selected plaintext only. Never serialize this object into a row, log or HTTP response. */
export interface TenantWebhookSourceValue {
  readonly principal: Principal; readonly sessionId: string; readonly turnId: string; readonly fence: number;
  readonly callItemId: string; readonly toolCallId: string; readonly toolName: string; readonly toolKind: string;
  readonly throughSeq: number; readonly sourceSha256: string;
  /** Selected body could not fit the observation budget; not incomplete DB evidence. */
  readonly observationUnavailable: boolean;
  readonly prompt: TenantWebhookPromptSnapshot; readonly arguments: unknown;
  readonly registrations: readonly TenantWebhookRegistration[];
  readonly startedSnapshots: readonly TenantWebhookInvocationSnapshot[];
}
export interface TenantWebhookInvocationSnapshot {
  readonly snapshotId: string; readonly webhookId: string; readonly configVersionId: string;
  readonly generation: number; readonly registrationRevision: number; readonly fence: number;
  readonly subject: Principal; readonly sessionId: string; readonly turnId: string;
  readonly callItemId: string; readonly toolCallId: string; readonly throughSeq: number; readonly sourceSha256: string;
  readonly availability: "available" | "unavailable";
  readonly plaintextSha256: string | null; readonly envelope: TenantWebhookEnvelope | null; readonly createdAtMs: number;
}
export interface TenantWebhookIntent {
  readonly intentId: string; readonly webhookId: string; readonly tenantId: string; readonly configVersionId: string;
  readonly generation: number; readonly registrationRevision: number; readonly fence: number;
  readonly phase: TenantWebhookPhase; readonly subject: Principal;
  readonly sessionId: string; readonly turnId: string; readonly callItemId: string; readonly toolCallId: string;
  readonly resultItemId: string | null; readonly throughSeq: number; readonly sourceSha256: string;
  readonly requestSha256: string | null; readonly payloadSha256: string | null; readonly payloadBytes: number | null;
  readonly payload: TenantWebhookEnvelope | null; readonly invocationId: string | null;
  readonly state: "prepared" | "sending" | "acknowledged" | "failed_not_dispatched" | "outcome_unknown" | "blocked";
  readonly preparedDeadlineAtMs: number;
  readonly claimTokenSha256: string | null; readonly sendDeadlineAtMs: number | null;
  readonly resultSha256: string | null; readonly createdAtMs: number; readonly completedAtMs: number | null;
  readonly finishRequestSha256: string | null;
}
export interface TenantWebhookPreparedPayload {
  readonly configVersionId: string; readonly invocationId: string; readonly requestSha256: string;
  readonly payloadSha256: string; readonly payloadBytes: number; readonly envelope: TenantWebhookEnvelope;
}
export interface TenantWebhookPreparedSnapshot {
  readonly configVersionId: string; readonly plaintextSha256: string; readonly envelope: TenantWebhookEnvelope;
}
export interface TenantWebhookCanonicalResult {
  readonly itemId: string; readonly isError: boolean; readonly payloadSha256: string; readonly payloadBytes: number;
  /** Ephemeral canonical JSON payload, never persisted in this domain in plaintext. */
  readonly payload: { readonly content: readonly unknown[]; readonly details?: unknown };
}
export interface TenantWebhookNameInput { readonly access: TenantWebhookAccess; readonly name: string }
export interface UpsertTenantWebhookInput extends TenantWebhookNameInput {
  readonly expectedRevision: number; readonly idempotencyKey: string; readonly admission: TenantWebhookConfigAdmission;
}
export interface TenantWebhookSourceInput {
  readonly access: TenantWebhookAccess; readonly sessionId: string; readonly turnId: string;
  readonly callItemId: string; readonly fence: number;
}
export interface TenantWebhookDeliveryClaim {
  readonly intent: TenantWebhookIntent & { readonly payload: TenantWebhookEnvelope; readonly requestSha256: string;
    readonly payloadSha256: string; readonly payloadBytes: number; readonly invocationId: string };
  readonly registration: TenantWebhookVersion;
  readonly claimToken: string;
}
export interface TenantWebhookStore {
  assertTenantWebhookRuntimeGate(enabled: boolean): Promise<void>;
  /** Internal owner-scoped digest only; never returns key or body material. */
  getTenantWebhookRuntimePolicy(input: { readonly access: TenantWebhookAccess }):
    Promise<readonly { readonly configVersionId: string; readonly configSha256: string; readonly phase: TenantWebhookPhase }[]>;
  upsertTenantWebhook(input: UpsertTenantWebhookInput): Promise<TenantWebhookRegistration>;
  setTenantWebhookState(input: TenantWebhookNameInput & { readonly expectedRevision: number;
    readonly idempotencyKey: string; readonly state: "enabled" | "disabled" | "deleted" }): Promise<TenantWebhookSlot>;
  getTenantWebhook(input: TenantWebhookNameInput): Promise<TenantWebhookRegistration | null>;
  listTenantWebhooks(input: { readonly access: TenantWebhookAccess; readonly cursor: string | null; readonly limit: number }):
    Promise<{ readonly items: readonly TenantWebhookRegistration[]; readonly nextCursor: string | null }>;
  readTenantWebhookSources(input: TenantWebhookSourceInput): Promise<TenantWebhookSource>;
  /** Same actual session-fenced transaction as normal commit; no network or second intent transaction. */
  commitTenantWebhookMilestone(input: { readonly batch: CommitBatch; readonly admission: TenantWebhookMilestoneAdmission }):
    Promise<CommitResult & { readonly tenantWebhookIntents: readonly TenantWebhookIntent[] }>;
  claimTenantWebhookDelivery(input: { readonly access: TenantWebhookAccess; readonly intentId: string;
    readonly timeoutMs: number }): Promise<TenantWebhookDeliveryClaim | null>;
  getTenantWebhookDelivery(input: { readonly access: TenantWebhookAccess; readonly intentId: string }): Promise<TenantWebhookIntent | null>;
  /** Local bounded observer phase ended before dispatch; never claims or changes sending. */
  abandonPreparedTenantWebhookDelivery(input: { readonly access: TenantWebhookAccess; readonly intentId: string }): Promise<TenantWebhookIntent | null>;
  finishTenantWebhookDelivery(input: { readonly access: TenantWebhookAccess; readonly intentId: string; readonly claimToken: string;
    readonly outcome: "acknowledged" | "failed_not_dispatched" | "outcome_unknown"; readonly resultSha256: string }): Promise<TenantWebhookIntent>;
  listTenantWebhookDeliveries(input: TenantWebhookNameInput & { readonly cursor: string | null; readonly limit: number }):
    Promise<{ readonly items: readonly TenantWebhookIntent[]; readonly nextCursor: string | null }>;
  /** Trusted startup/local-state reconciliation only: expired prepared->not_dispatched,
   * sending->unknown. Never performs HTTP or reclaims/reposts a request. */
  reconcileTenantWebhookDeliveries(input: { readonly cursor: string | null; readonly limit: number }):
    Promise<{ readonly changed: number; readonly nextCursor: string | null }>;
}

export class TenantWebhookIntegrityError extends Error { constructor() { super("Tenant webhook evidence is invalid"); this.name = "TenantWebhookIntegrityError"; } }
export class TenantWebhookConflictError extends Error { constructor() { super("Tenant webhook revision or operation conflict"); this.name = "TenantWebhookConflictError"; } }
export class TenantWebhookLifecycleBlockedError extends Error { constructor() { super("Tenant webhook lifecycle is not proven"); this.name = "TenantWebhookLifecycleBlockedError"; } }
export class TenantWebhookSizeError extends Error { constructor() { super("Tenant webhook observation exceeds its size limit"); this.name = "TenantWebhookSizeError"; } }

function fail(): never { throw new TenantWebhookIntegrityError(); }
export function tenantWebhookClosed(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !fields.includes(key))) fail();
  for (const key of keys) { const d = Object.getOwnPropertyDescriptor(value, key); if (!d || !("value" in d) || !d.enumerable) fail(); }
}
export function tenantWebhookText(value: unknown, maximum: number): asserts value is string {
  if (typeof value !== "string" || !value.length || Buffer.byteLength(value) > maximum || /[\x00-\x1f\x7f]/.test(value)) fail();
}
export function tenantWebhookNatural(value: unknown): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < 0) fail(); }
export function tenantWebhookSha(value: unknown): asserts value is string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail(); }
export function tenantWebhookName(value: unknown): asserts value is string { if (typeof value !== "string" || value.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) fail(); }
export function tenantWebhookPrincipal(value: unknown): asserts value is Principal {
  tenantWebhookClosed(value, ["tenantId", "userId"]); if (!Principal.safeParse(value).success) fail();
  tenantWebhookText(value.tenantId, 512); tenantWebhookText(value.userId, 128);
}
function canonical(value: unknown, depth = 0): string {
  if (depth > 32) fail();
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    if (typeof value === "number" && !Number.isFinite(value)) fail(); return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(v => canonical(v, depth + 1)).join(",")}]`;
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const entries: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const d = Object.getOwnPropertyDescriptor(value, key); if (!d || !("value" in d)) fail();
    if (d.value !== undefined) entries.push(`${JSON.stringify(key)}:${canonical(d.value, depth + 1)}`);
  }
  return `{${entries.join(",")}}`;
}
function frozen<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) frozen(child); Object.freeze(value); } return value;
}
export function tenantWebhookDigest(domain: string, value: unknown): string { return createHash("sha256").update(domain).update("\0").update(canonical(value)).digest("hex"); }
export function tenantWebhookId(tenantId: string, name: string): string {
  tenantWebhookPrincipal({ tenantId, userId: "tenant-webhook" }); tenantWebhookName(name);
  return tenantWebhookDigest("tenant-webhook-slot-v2", { tenantId, name });
}
export function tenantWebhookVersionId(tenantId: string, name: string, expectedRevision: number, idempotencyKey: string): string {
  const webhookId = tenantWebhookId(tenantId, name); tenantWebhookNatural(expectedRevision); tenantWebhookText(idempotencyKey, 128);
  return tenantWebhookDigest("tenant-webhook-version-v2", { webhookId, expectedRevision, idempotencyKey });
}
export function tenantWebhookSnapshotId(configVersionId: string, callItemId: string): string {
  tenantWebhookSha(configVersionId); tenantWebhookText(callItemId, 128); return tenantWebhookDigest("tenant-webhook-call-snapshot-v2", { configVersionId, callItemId });
}
export function tenantWebhookIntentId(configVersionId: string, callItemId: string, phase: TenantWebhookPhase): string {
  tenantWebhookSha(configVersionId); tenantWebhookText(callItemId, 128); if (!["preToolUse", "postToolUse"].includes(phase)) fail();
  return tenantWebhookDigest("tenant-webhook-delivery-v2", { configVersionId, callItemId, phase });
}
export function validateTenantWebhookConfig(value: unknown): asserts value is TenantWebhookConfig {
  tenantWebhookClosed(value, ["endpoint", "phase", "bodyScopes"]); tenantWebhookText(value.endpoint, 2048);
  let url: URL; try { url = new URL(value.endpoint); } catch { return fail(); }
  const fixture = process.env.NODE_ENV === "test" && process.env.MCP_ALLOW_LOOPBACK_FOR_TESTS === "1"
    && process.env.HOOKS_ALLOW_LOOPBACK_FOR_TESTS === "1" && ["127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.href !== value.endpoint || url.username || url.password || url.search || url.hash || url.protocol !== "https:" && !(fixture && url.protocol === "http:")) fail();
  if (value.phase !== "preToolUse" && value.phase !== "postToolUse" || !Array.isArray(value.bodyScopes)
    || value.bodyScopes.length > 3 || new Set(value.bodyScopes).size !== value.bodyScopes.length
    || value.bodyScopes.some(scope => !["prompt", "tool_arguments", "tool_result"].includes(String(scope)))
    || value.phase === "preToolUse" && value.bodyScopes.includes("tool_result")) fail();
}
export function validateTenantWebhookEnvelope(value: unknown, maximumBytes = 65_536): asserts value is TenantWebhookEnvelope {
  tenantWebhookClosed(value, ["profile", "keyId", "iv", "ciphertext", "tag"]);
  if (value.profile !== "tenant-webhook-aes-256-gcm-v2") fail(); tenantWebhookText(value.keyId, 64);
  for (const [field, length] of [["iv", 12], ["tag", 16]] as const) {
    const raw = value[field]; if (typeof raw !== "string" || Buffer.from(raw, "base64").length !== length || Buffer.from(raw, "base64").toString("base64") !== raw) fail();
  }
  if (typeof value.ciphertext !== "string" || !value.ciphertext.length || Buffer.from(value.ciphertext, "base64").toString("base64") !== value.ciphertext
    || Buffer.from(value.ciphertext, "base64").length > maximumBytes) fail();
}
type AccessContext = { readonly mode: "admin" | "runtime"; readonly tenantId: string; readonly apiKeyId: string | null; readonly principal: Principal | null };
const accesses = new WeakMap<TenantWebhookAccess, AccessContext>();
export function createTenantWebhookAdminAccess(input: { tenantId: string; apiKeyId: string }): TenantWebhookAccess {
  tenantWebhookClosed(input, ["tenantId", "apiKeyId"]); tenantWebhookPrincipal({ tenantId: input.tenantId, userId: "tenant-webhook-admin" }); tenantWebhookText(input.apiKeyId, 128);
  const access = Object.freeze({ kind: "tenant-webhook-access-v2" as const }); accesses.set(access, Object.freeze({ mode: "admin", ...input, principal: null })); return access;
}
export function createTenantWebhookRuntimeAccess(principal: Principal): TenantWebhookAccess {
  tenantWebhookPrincipal(principal); const access = Object.freeze({ kind: "tenant-webhook-access-v2" as const });
  accesses.set(access, Object.freeze({ mode: "runtime", tenantId: principal.tenantId, principal: Object.freeze({ ...principal }), apiKeyId: null })); return access;
}
export function assertTenantWebhookAccess(access: TenantWebhookAccess, mode?: "admin" | "runtime"): AccessContext {
  const value = accesses.get(access); if (!value || mode !== undefined && value.mode !== mode) fail(); return value;
}
export interface TenantWebhookConfigAdmissionInput {
  readonly access: TenantWebhookAccess; readonly name: string; readonly expectedRevision: number; readonly generation: number;
  readonly idempotencyKey: string; readonly config: TenantWebhookConfig; readonly signingKey: TenantWebhookEnvelope;
  readonly keyCommitmentSha256: string; readonly disclosureAck: "tenant-admin-body-disclosure-v1" | null;
}
const configAdmissions = new WeakMap<TenantWebhookConfigAdmission, Readonly<TenantWebhookConfigAdmissionInput>>();
export function createTenantWebhookConfigAdmission(input: TenantWebhookConfigAdmissionInput): TenantWebhookConfigAdmission {
  tenantWebhookClosed(input, ["access", "name", "expectedRevision", "generation", "idempotencyKey", "config", "signingKey", "keyCommitmentSha256", "disclosureAck"]);
  assertTenantWebhookAccess(input.access, "admin"); tenantWebhookName(input.name); tenantWebhookNatural(input.expectedRevision); tenantWebhookNatural(input.generation);
  tenantWebhookText(input.idempotencyKey, 128); validateTenantWebhookConfig(input.config); validateTenantWebhookEnvelope(input.signingKey, 32);
  if (Buffer.from(input.signingKey.ciphertext, "base64").length !== 32) fail(); tenantWebhookSha(input.keyCommitmentSha256);
  if (input.config.bodyScopes.length ? input.disclosureAck !== "tenant-admin-body-disclosure-v1" : input.disclosureAck !== null) fail();
  const token = Object.freeze({ kind: "tenant-webhook-config-admission-v2" as const });
  configAdmissions.set(token, frozen({ ...structuredClone({ ...input, access: undefined }), access: input.access })); return token;
}
export function assertTenantWebhookConfigAdmission(admission: TenantWebhookConfigAdmission): Readonly<TenantWebhookConfigAdmissionInput> {
  const value = configAdmissions.get(admission); if (!value) fail(); return value;
}
export function tenantWebhookAad(version: Pick<TenantWebhookVersion, "configVersionId" | "webhookId" | "tenantId" | "generation" | "config" | "keyVersionId">,
  purpose: TenantWebhookAad["purpose"], input: { principal: Principal; sessionId: string; turnId: string; callItemId: string } | null = null): TenantWebhookAad {
  if (!["signing_key", "invocation_snapshot", "delivery_payload"].includes(purpose) || (purpose === "signing_key") !== (input === null)) fail();
  if (input) { tenantWebhookPrincipal(input.principal); if (input.principal.tenantId !== version.tenantId) fail(); }
  return { profile: "tenant-webhook-secret-aad-v2", purpose, tenantId: version.tenantId, webhookId: version.webhookId,
    configVersionId: version.configVersionId, generation: version.generation,
    materialId: purpose === "signing_key" ? version.keyVersionId : purpose === "invocation_snapshot" ? tenantWebhookSnapshotId(version.configVersionId, input!.callItemId)
      : tenantWebhookIntentId(version.configVersionId, input!.callItemId, version.config.phase), subject: input?.principal ?? null,
    sessionId: input?.sessionId ?? null, turnId: input?.turnId ?? null, callItemId: input?.callItemId ?? null, phase: version.config.phase,
    endpointSha256: tenantWebhookDigest("tenant-webhook-endpoint-v2", version.config.endpoint), bodyScopesSha256: tenantWebhookDigest("tenant-webhook-scopes-v2", [...version.config.bodyScopes].sort()) };
}
const sourceRecords = new WeakSet<TenantWebhookSource>();
/** Backend-only source issuer. Authorization/source relationships must already be independently checked. */
export function createStoredTenantWebhookSource(value: TenantWebhookSourceValue, admissionSource?: object): TenantWebhookSource {
  canonical(value); const source = frozen({ kind: "tenant-webhook-source-v2" as const, value: structuredClone(value) });
  sourceRecords.add(source);
  transferSessionWriteAdmission(admissionSource ?? value, source);
  transferSessionWriteAdmission(admissionSource ?? value, source.value); return source;
}
export function assertTenantWebhookSource(source: TenantWebhookSource): TenantWebhookSourceValue {
  if (!sourceRecords.has(source)) fail(); return source.value;
}
export interface TenantWebhookMilestoneAdmissionInput {
  readonly source: TenantWebhookSource; readonly kind: "pre" | "started" | "post"; readonly batch: CommitBatch;
  readonly snapshots: readonly TenantWebhookPreparedSnapshot[]; readonly payloads: readonly TenantWebhookPreparedPayload[];
  readonly failures: readonly { readonly configVersionId: string; readonly code: "observation_unavailable" }[];
  readonly canonicalResult: TenantWebhookCanonicalResult | null;
}
const milestoneRecords = new WeakMap<TenantWebhookMilestoneAdmission, { input: TenantWebhookMilestoneAdmissionInput; batchSha256: string }>();
export function createTenantWebhookMilestoneAdmission(input: TenantWebhookMilestoneAdmissionInput): TenantWebhookMilestoneAdmission {
  tenantWebhookClosed(input, ["source", "kind", "batch", "snapshots", "payloads", "failures", "canonicalResult"]);
  if (!sourceRecords.has(input.source) || !["pre", "started", "post"].includes(input.kind) || !Array.isArray(input.snapshots) || !Array.isArray(input.payloads)) fail();
  if (!Array.isArray(input.failures) || input.failures.length > 8 || input.snapshots.length > 8 || input.payloads.length > 8 || new Set(input.snapshots.map(x => x.configVersionId)).size !== input.snapshots.length
    || new Set(input.payloads.map(x => x.configVersionId)).size !== input.payloads.length) fail();
  const batchSha256 = tenantWebhookDigest("tenant-webhook-commit-batch-v2", input.batch);
  const selectedIds = [...input.snapshots,...input.payloads,...input.failures].map(x => x.configVersionId);
  if (new Set(selectedIds).size !== selectedIds.length) fail();
  for (const failure of input.failures) { tenantWebhookClosed(failure, ["configVersionId", "code"]); tenantWebhookSha(failure.configVersionId); if (failure.code !== "observation_unavailable") fail(); }
  for (const snapshot of input.snapshots) { tenantWebhookClosed(snapshot, ["configVersionId", "plaintextSha256", "envelope"]); tenantWebhookSha(snapshot.configVersionId); tenantWebhookSha(snapshot.plaintextSha256); validateTenantWebhookEnvelope(snapshot.envelope); }
  for (const payload of input.payloads) { tenantWebhookClosed(payload, ["configVersionId", "invocationId", "requestSha256", "payloadSha256", "payloadBytes", "envelope"]);
    tenantWebhookSha(payload.configVersionId); tenantWebhookSha(payload.requestSha256); tenantWebhookSha(payload.payloadSha256); tenantWebhookText(payload.invocationId, 64);
    tenantWebhookNatural(payload.payloadBytes); if (!payload.payloadBytes || payload.payloadBytes > 65_536) throw new TenantWebhookSizeError(); validateTenantWebhookEnvelope(payload.envelope); }
  if (input.kind === "post") { if (!input.canonicalResult) fail(); tenantWebhookClosed(input.canonicalResult, ["itemId", "isError", "payloadSha256", "payloadBytes", "payload"]);
    tenantWebhookText(input.canonicalResult.itemId, 128); tenantWebhookSha(input.canonicalResult.payloadSha256); tenantWebhookNatural(input.canonicalResult.payloadBytes); if (typeof input.canonicalResult.isError !== "boolean") fail();
    canonical(input.canonicalResult.payload);
    const raw = JSON.stringify(input.canonicalResult.payload);
    if (createHash("sha256").update(raw).digest("hex") !== input.canonicalResult.payloadSha256 || Buffer.byteLength(raw) !== input.canonicalResult.payloadBytes) fail();
  } else if (input.canonicalResult !== null) fail();
  if (input.kind === "started" ? input.payloads.length !== 0 : input.snapshots.length !== 0) fail();
  const token = Object.freeze({ kind: "tenant-webhook-milestone-admission-v2" as const });
  const snapshot = frozen({ ...structuredClone({ ...input, source: undefined }), source: input.source });
  transferSessionWriteAdmission(input.batch, snapshot.batch);
  transferSessionWriteAdmission(input.source, token);
  milestoneRecords.set(token, { input: snapshot, batchSha256 }); return token;
}
export function assertTenantWebhookMilestoneAdmission(admission: TenantWebhookMilestoneAdmission, batch: CommitBatch): TenantWebhookMilestoneAdmissionInput {
  const value = milestoneRecords.get(admission); if (!value || value.batchSha256 !== tenantWebhookDigest("tenant-webhook-commit-batch-v2", batch)) fail(); return value.input;
}
