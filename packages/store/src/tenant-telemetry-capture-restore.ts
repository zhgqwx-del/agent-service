import { createHash, createHmac } from "node:crypto";
import { tenantTelemetryRefKeyIdSha256 } from "./tenant-telemetry-lifecycle.js";
import {
  validateTenantRestoreJournalControlRecord, validateTenantRestoreRuntimeControlRecord,
  type TenantRestoreJournalControlRecord, type TenantRestoreRuntimeControlRecord,
} from "./tenant-restore-journal.js";

/**
 * Content-free codecs, NOT a database/source verifier or an operator capability.
 * The store must construct leaves from one complete, locked, independently
 * validated physical snapshot. In particular, a syntactically valid digest is
 * not evidence that a row existed, that a legacy gap is complete, or that bytes
 * were backed up. The encrypted artifact/0031/0030 consumers must bind these
 * records to the actual bytes, reservation, run, replay and atomic activation.
 * Nothing here relaxes 0054's original-primary destructive qualification.
 */
export const TENANT_TELEMETRY_CAPTURE_RESTORE_PROTOCOL = "tenant-telemetry-capture-restore-v1" as const;
export const TENANT_TELEMETRY_CAPTURE_CHECKPOINT_SCOPE = "tenant-telemetry-capture-backup-checkpoint-v1" as const;
export const TENANT_TELEMETRY_CAPTURE_RESTORE_HISTORY_SCOPE = "tenant-telemetry-capture-restore-history-v1" as const;
export const TENANT_TELEMETRY_CAPTURE_EPOCH_CUTOVER_SCOPE = "tenant-telemetry-capture-epoch-cutover-v1" as const;
export const TENANT_TELEMETRY_CAPTURE_RECOVERY_PERMIT_SCOPE = "tenant-telemetry-capture-operation-recovery-v1" as const;
export const TENANT_TELEMETRY_CAPTURE_RESTORE_MAX_LEAVES = 100_000;
export const TENANT_TELEMETRY_CAPTURE_RESTORE_MAX_BYTES = 1_048_576;
export const TENANT_TELEMETRY_CAPTURE_RECOVERY_MAX_LEASE_MS = 300_000;

/** Fixed SQL projection inventory. No family may be omitted, even when empty.
 * `all_rows` means the whole physical table, not only the selected tenant or
 * convenient completed operations. Row semantics/owner closure are validated
 * before HMAC projection. Control/canonical JSON is never accepted by this codec.
 * The two special projections are NOT new SQL tables: reservations are
 * non-NULL reservation columns in jobs; legacy failures are the existing
 * NULL/gen0 failed-item/event projections, not post-cutover runtime_unknown/gen1.
 * Reservation predicate: mutation_reservation_receipt_sha256 IS NOT NULL; bind
 * mutation_adapter_protocol, mutation_started_at_db_ms,
 * mutation_started_claim_attempt, mutation_started_claim_token_sha256 and
 * mutation_reservation_receipt_sha256, plus the original operation/tenant/
 * inventory/manifest descriptor. An inconsistent partial tuple is corruption,
 * not a missing reservation. SQL phase remains queued: codec state reserved is
 * queued + exact non-NULL reservation; written/blocked keep their own state.
 * Canonical item/event HMACs include the 0053 telemetry_failure_classification
 * and telemetry_capture_v2_* columns as well as the validated full JSON body;
 * legacy_failure separately classifies actual failed agentMessage/item-completed
 * rows with NULL/0 telemetry_capture_v2_control_generation. It must not infer a
 * failure or owner from orphan JSON or omit unmatched rows from canonical roots.
 */
export const TENANT_TELEMETRY_CAPTURE_CHECKPOINT_SQL = Object.freeze([
  { family: "lifecycle_control", tables: ["tenant_telemetry_lifecycle_control"], projection: "all_rows" },
  { family: "lifecycle_target", tables: ["tenant_telemetry_lifecycle_targets"], projection: "all_rows" },
  { family: "lifecycle_activation", tables: ["tenant_telemetry_activation_receipts"], projection: "all_rows" },
  { family: "lifecycle_coverage", tables: ["tenant_telemetry_lifecycle_coverages"], projection: "all_rows" },
  { family: "lifecycle_subject", tables: ["tenant_telemetry_lifecycle_subjects"], projection: "all_rows" },
  { family: "application_control", tables: ["tenant_telemetry_application_domain_controls"], projection: "all_rows" },
  { family: "application_activation", tables: ["tenant_telemetry_application_activation_receipts"], projection: "all_rows" },
  { family: "application_coverage", tables: ["tenant_telemetry_application_coverages"], projection: "all_rows" },
  { family: "capture_control", tables: ["tenant_telemetry_capture_v2_controls"], projection: "all_rows" },
  { family: "capture_activation", tables: ["tenant_telemetry_capture_v2_activation_receipts"], projection: "all_rows" },
  { family: "capture_coverage", tables: ["tenant_telemetry_capture_v2_coverages"], projection: "all_rows" },
  { family: "inventory", tables: ["tenant_telemetry_artifact_inventory"], projection: "all_rows" },
  { family: "write_job", tables: ["tenant_telemetry_write_jobs"], projection: "all_rows" },
  { family: "write_ack", tables: ["tenant_telemetry_write_acks"], projection: "all_rows" },
  { family: "membership", tables: ["tenant_telemetry_artifact_memberships"], projection: "all_rows" },
  { family: "application_binding", tables: ["tenant_telemetry_application_write_bindings"], projection: "all_rows" },
  { family: "provider_source_binding", tables: ["tenant_telemetry_capture_v2_source_bindings"], projection: "all_rows" },
  { family: "provider_failure_commit", tables: ["tenant_telemetry_capture_v2_failure_commit_receipts"], projection: "all_rows" },
  { family: "write_payload", tables: ["tenant_telemetry_write_payloads"], projection: "all_rows" },
  { family: "write_reservation", tables: ["tenant_telemetry_write_jobs"], projection: "non_null_reservation_columns" },
  { family: "canonical_session", tables: ["sessions"], projection: "all_rows" },
  { family: "canonical_turn", tables: ["turns"], projection: "all_rows" },
  { family: "canonical_item", tables: ["items"], projection: "all_rows" },
  { family: "canonical_event", tables: ["events"], projection: "all_rows" },
  { family: "canonical_approval", tables: ["approvals"], projection: "all_rows" },
  { family: "canonical_subject", tables: ["subject_lifecycle"], projection: "all_rows" },
  { family: "canonical_tenant", tables: ["tenants"], projection: "all_rows" },
  { family: "operational_usage", tables: ["usage_ledger"], projection: "all_rows" },
  { family: "billing_fact", tables: ["billing_usage_facts"], projection: "all_rows" },
  { family: "usage_reconciliation", tables: ["usage_reconciliations"], projection: "all_rows" },
  { family: "owner_closure_entry", tables: ["tenant_telemetry_owner_closure_entries"], projection: "all_rows" },
  { family: "owner_closure_receipt", tables: ["tenant_telemetry_owner_closure_receipts"], projection: "all_rows" },
  { family: "session_grave", tables: ["tenant_purge_session_grave_markers"], projection: "all_rows" },
  { family: "source_accounting_entry", tables: ["tenant_telemetry_source_accounting_entries"], projection: "all_rows" },
  { family: "source_accounting_receipt", tables: ["tenant_telemetry_source_accounting_receipts"], projection: "all_rows" },
  { family: "target_manifest_entry", tables: ["tenant_telemetry_target_manifest_entries"], projection: "all_rows" },
  { family: "target_manifest_receipt", tables: ["tenant_telemetry_target_manifest_receipts"], projection: "all_rows" },
  { family: "plan_artifact_target", tables: ["tenant_telemetry_plan_artifact_targets"], projection: "all_rows" },
  { family: "plan_artifact_target_receipt", tables: ["tenant_telemetry_plan_artifact_target_receipts"], projection: "all_rows" },
  { family: "retained_t1_entry", tables: ["tenant_telemetry_retained_source_t1_entries"], projection: "all_rows" },
  { family: "retained_t1_receipt", tables: ["tenant_telemetry_retained_source_t1_receipts"], projection: "all_rows" },
  { family: "retained_catalog_source", tables: ["tenant_telemetry_retained_source_catalog_sources"], projection: "all_rows" },
  { family: "retained_catalog_target", tables: ["tenant_telemetry_retained_source_catalog_targets"], projection: "all_rows" },
  { family: "retained_catalog_receipt", tables: ["tenant_telemetry_retained_source_catalog_receipts"], projection: "all_rows" },
  { family: "retained_usage_entry", tables: ["tenant_telemetry_retained_source_usage_entries"], projection: "all_rows" },
  { family: "retained_usage_receipt", tables: ["tenant_telemetry_retained_source_usage_receipts"], projection: "all_rows" },
  { family: "retained_canonical_entry", tables: ["tenant_telemetry_retained_source_canonical_entries"], projection: "all_rows" },
  { family: "retained_canonical_receipt", tables: ["tenant_telemetry_retained_source_canonical_receipts"], projection: "all_rows" },
  { family: "legacy_failure", tables: ["items", "events"], projection: "null_or_gen0_failed_item_and_event" },
] as const);
for (const projection of TENANT_TELEMETRY_CAPTURE_CHECKPOINT_SQL) { Object.freeze(projection.tables); Object.freeze(projection); }
export type TenantTelemetryCaptureCheckpointFamily = (typeof TENANT_TELEMETRY_CAPTURE_CHECKPOINT_SQL)[number]["family"];
export const TENANT_TELEMETRY_CAPTURE_CHECKPOINT_FAMILIES = Object.freeze(TENANT_TELEMETRY_CAPTURE_CHECKPOINT_SQL.map((entry) => entry.family));
export const TENANT_TELEMETRY_CAPTURE_CHECKPOINT_STATES = Object.freeze([
  "record", "inactive", "active", "queued", "reserved", "written", "blocked", "spooled", "legacy_unknown",
] as const);
export type TenantTelemetryCaptureCheckpointState = (typeof TENANT_TELEMETRY_CAPTURE_CHECKPOINT_STATES)[number];
export type TenantTelemetryCaptureCheckpointKnowledge = "validated_projection" | "legacy_unknown";

export interface TenantTelemetryCaptureCheckpointLeaf {
  family: TenantTelemetryCaptureCheckpointFamily;
  identityRefSha256: string;
  recordHmacSha256: string;
  knowledge: TenantTelemetryCaptureCheckpointKnowledge;
  state: TenantTelemetryCaptureCheckpointState;
  sourceHighWaterDbMs: number;
}
export interface TenantTelemetryCaptureCheckpointFamilySummary {
  family: TenantTelemetryCaptureCheckpointFamily;
  rowCount: number;
  legacyUnknownCount: number;
  states: Record<TenantTelemetryCaptureCheckpointState, number>;
  sourceHighWaterDbMs: number;
  rootSha256: string;
}
export interface TenantTelemetryCaptureBackupCheckpointHeader {
  backupId: string;
  anchorSha256: string;
  anchorCreatedAtDbMs: number;
  /** Maximum validated 0030/0031/Blob/header-control DB high-water. */
  controlHighWaterDbMs: number;
  logicalDatabaseNamespaceSha256: string;
  schemaMigrationRootSha256: string;
  sourceRuntimeLineageKind: "primary" | "restore";
  sourceRuntimeEpochSha256: string;
  sourceRuntimeBindingSha256: string;
  sourceRuntimeControlEvidenceSha256: string;
  sourceRuntimeControlGeneration: number;
  sourceHistoryReceiptSha256: string | null;
  sourceCaptureCutoverReceiptSha256: string | null;
  originalRuntimeEpochSha256: string;
  originalRuntimeBindingSha256: string;
  originalCaptureActivationReceiptSha256: string;
  refKeyIdSha256: string;
  lifecycleControlEvidenceSha256: string;
  captureControlEvidenceSha256: string;
  logsTargetSha256: string;
  logsTargetReceiptSha256: string;
  journalControlEvidenceSha256: string;
  journalTargetRootSha256: string;
  journalHeadRootSha256: string;
  catalogControlEvidenceSha256: string;
  catalogHeadSequence: number;
  catalogHeadRootSha256: string;
  blobStorageControlEvidenceSha256: string;
  sealedAtDbMs: number;
}
interface CaptureRestoreSafety {
  executionReady: false;
  externalAuthorityVerified: false;
  erasureAuthorized: false;
  allDomainsComplete: false;
  contentPurgeExecuted: false;
}
const SAFETY = Object.freeze({ executionReady: false, externalAuthorityVerified: false,
  erasureAuthorized: false, allDomainsComplete: false, contentPurgeExecuted: false } as const);
export interface TenantTelemetryCaptureBackupCheckpoint extends TenantTelemetryCaptureBackupCheckpointHeader, CaptureRestoreSafety {
  scope: typeof TENANT_TELEMETRY_CAPTURE_CHECKPOINT_SCOPE;
  protocol: typeof TENANT_TELEMETRY_CAPTURE_RESTORE_PROTOCOL;
  phase: "sealed_before_dump";
  families: readonly TenantTelemetryCaptureCheckpointFamilySummary[];
  observedRowCount: number;
  legacyUnknownCount: number;
  sourceHighWaterDbMs: number;
  projectionRootSha256: string;
  checkpointSha256: string;
}
/** All values below must be independently read from the exact verified artifact,
 * 0031 binding/reservation and active 0030 run/runtime by the transaction caller.
 * This closed projection does not replace those original validators. */
export interface TenantTelemetryCaptureRestoreActivationBinding {
  backupId: string;
  anchorSha256: string;
  checkpointSha256: string;
  artifactManifestSha256: string;
  sourceSnapshotSha256: string;
  providerEvidenceSha256: string;
  sourceBindingSha256: string;
  reservationSha256: string;
  reservationReceiptSha256: string;
  restoreRunId: string;
  runtimeEpochSha256: string;
  runtimeBindingSha256: string;
  runtimeControlEvidenceSha256: string;
  runtimeControlGeneration: number;
  replayReceiptSha256: string;
  sealedJournalHeadRootSha256: string;
  activatedAtDbMs: number;
}
interface CaptureOriginalLineage {
  originalRuntimeEpochSha256: string;
  originalRuntimeBindingSha256: string;
  originalCaptureActivationReceiptSha256: string;
  refKeyIdSha256: string;
  lifecycleControlEvidenceSha256: string;
  captureControlEvidenceSha256: string;
  logsTargetSha256: string;
  logsTargetReceiptSha256: string;
}
export interface TenantTelemetryCaptureRestoreHistoryReceipt extends TenantTelemetryCaptureRestoreActivationBinding,
  CaptureOriginalLineage, CaptureRestoreSafety {
  scope: typeof TENANT_TELEMETRY_CAPTURE_RESTORE_HISTORY_SCOPE;
  protocol: typeof TENANT_TELEMETRY_CAPTURE_RESTORE_PROTOCOL;
  phase: "active";
  sourceRuntimeEpochSha256: string;
  sourceProjectionRootSha256: string;
  preservedRowCount: number;
  preservedLegacyUnknownCount: number;
  historyReadOnly: true;
  writeAuthorized: false;
  receiptSha256: string;
}
export interface TenantTelemetryCaptureEpochCutoverInput extends CaptureOriginalLineage {
  historyReceiptSha256: string;
  restoreRunId: string;
  runtimeEpochSha256: string;
  runtimeBindingSha256: string;
  runtimeControlEvidenceSha256: string;
  runtimeControlGeneration: number;
  configuredFleetRootSha256: string;
  activatedAtDbMs: number;
  fleetStoppedAck: "fleet-stopped-v1";
  legacyWritersDrainedAck: "legacy-writers-drained-v1";
  producerReadyAck: "provider-step-error-v2-ready-v1";
  localOnlyAck: "local-only-v1";
}
export interface TenantTelemetryCaptureEpochCutoverReceipt extends TenantTelemetryCaptureEpochCutoverInput, CaptureRestoreSafety {
  scope: typeof TENANT_TELEMETRY_CAPTURE_EPOCH_CUTOVER_SCOPE;
  protocol: typeof TENANT_TELEMETRY_CAPTURE_RESTORE_PROTOCOL;
  phase: "active";
  checkpointSha256: string;
  newCaptureWritesAuthorized: true;
  historicalOperationRecoveryAuthorized: false;
  receiptSha256: string;
}
export interface TenantTelemetryCaptureOperationRecoveryInput {
  cutoverReceiptSha256: string;
  historyReceiptSha256: string;
  checkpointSha256: string;
  restoreRunId: string;
  runtimeEpochSha256: string;
  writeOperationSha256: string;
  tenantRefSha256: string;
  ownerRefSha256: string;
  sourceSessionRefSha256: string;
  sourceTurnRefSha256: string;
  sourceItemRefSha256: string;
  sourceStepIndex: number;
  inventorySha256: string;
  payloadSha256: string;
  manifestSha256: string;
  membershipSha256: string;
  sourceBindingReceiptSha256: string;
  failureCommitReceiptSha256: string;
  originalJobState: "queued" | "reserved";
  originalJobEvidenceHmacSha256: string;
  originalPayloadEvidenceHmacSha256: string;
  originalMembershipEvidenceHmacSha256: string;
  originalSourceBindingEvidenceHmacSha256: string;
  originalFailureEvidenceHmacSha256: string;
  originalReservationReceiptSha256: string | null;
  originalReservationEvidenceHmacSha256: string | null;
  originalReservationClaimAttempt: number | null;
  originalReservationClaimTokenSha256: string | null;
  previousClaimAttempt: number;
  previousClaimTokenSha256: string | null;
  previousClaimLeaseUntilMs: number | null;
  newClaimAttempt: number;
  newClaimTokenSha256: string;
  newClaimLeaseUntilMs: number;
  issuedAtDbMs: number;
  /** The consumer must still recheck current T1/owner/policy/hold/fleet at every
   * boundary. ACK-only never allows a new reserve or external create. */
  recoveryMode: "resume_queued" | "resume_reserved" | "reserved_ack_only";
}
export interface TenantTelemetryCaptureOperationRecoveryPermit extends TenantTelemetryCaptureOperationRecoveryInput, CaptureRestoreSafety {
  scope: typeof TENANT_TELEMETRY_CAPTURE_RECOVERY_PERMIT_SCOPE;
  protocol: typeof TENANT_TELEMETRY_CAPTURE_RESTORE_PROTOCOL;
  phase: "leased";
  sourceKind: "persisted-provider-v2";
  newReservationAuthorized: boolean;
  newExternalCreateAuthorized: boolean;
  receiptSha256: string;
}

export class TenantTelemetryCaptureRestoreIntegrityError extends Error {
  constructor() { super("tenant telemetry capture restore evidence is invalid"); this.name = "TenantTelemetryCaptureRestoreIntegrityError"; }
}
function reject(): never { throw new TenantTelemetryCaptureRestoreIntegrityError(); }
function requireValue(value: unknown): asserts value { if (!value) reject(); }
function closed(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value));
  const prototype: unknown = Object.getPrototypeOf(value);
  requireValue(prototype === Object.prototype || prototype === null);
  const actual = Reflect.ownKeys(value);
  requireValue(actual.length === keys.length && actual.every((key) => typeof key === "string" && keys.includes(key)));
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireValue(descriptor && "value" in descriptor && descriptor.enumerable);
  }
}
function array(value: unknown, maximum: number): asserts value is unknown[] {
  requireValue(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= maximum);
  requireValue(Reflect.ownKeys(value).length === value.length + 1);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    requireValue(descriptor && "value" in descriptor && descriptor.enumerable);
  }
}
function digest(value: unknown): asserts value is string { requireValue(typeof value === "string" && /^[0-9a-f]{64}$/.test(value)); }
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
  requireValue(Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum);
}
function backupId(value: unknown): asserts value is string {
  requireValue(typeof value === "string" && /^backup_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value));
}
function restoreRunId(value: unknown): asserts value is string {
  requireValue(typeof value === "string" && /^restore_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value));
}
function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") { integer(value); return String(value); }
  if (Array.isArray(value)) { array(value, TENANT_TELEMETRY_CAPTURE_RESTORE_MAX_LEAVES); return `[${value.map(canonical).join(",")}]`; }
  requireValue(value !== null && typeof value === "object");
  const keys = Object.keys(value).sort(); closed(value, keys);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function hash(scope: string, value: unknown): string {
  return createHash("sha256").update(scope).update("\0").update(canonical(value)).digest("hex");
}

/** Stable restore-lineage identity; does not broaden the published primary
 * helper. The store must separately prove the immutable activation event and
 * complete current runtime chain. Legitimate journal/head advancement must not
 * change this identity, nor authorize capture writes without explicit cutover. */
export function tenantTelemetryCaptureRestoreRuntimeBindingSha256(
  runtime: TenantRestoreRuntimeControlRecord,
  journal: TenantRestoreJournalControlRecord,
): string {
  try {
    validateTenantRestoreRuntimeControlRecord(runtime);
    validateTenantRestoreJournalControlRecord(journal);
  } catch { reject(); }
  requireValue(runtime.state === "active" && runtime.lineageKind === "restore" && journal.controlGeneration === 1);
  if (runtime.state !== "active" || runtime.lineageKind !== "restore" || journal.controlGeneration !== 1) return reject();
  requireValue(runtime.controlEvidenceSha256 === journal.evidenceSha256
    && runtime.logicalDatabaseNamespaceSha256 === journal.logicalDatabaseNamespaceSha256
    && runtime.targetRootSha256 === journal.targetRootSha256 && runtime.targetCount === journal.targetCount);
  return hash("tenant-telemetry-capture-restore-runtime-binding-v1", {
    lineageKind: "restore", restoreRunId: runtime.restoreRunId,
    replayReceiptSha256: runtime.replayReceiptSha256, runtimeEpochSha256: runtime.runtimeEpochSha256,
    journalControlEvidenceSha256: journal.evidenceSha256,
    logicalDatabaseNamespaceSha256: runtime.logicalDatabaseNamespaceSha256,
    journalTargetRootSha256: journal.targetRootSha256, targetCount: journal.targetCount,
  });
}
function validateDigests(value: Record<string, unknown>, nullable: readonly string[] = []): void {
  for (const [key, child] of Object.entries(value)) {
    if (key.endsWith("Sha256")) { if (nullable.includes(key) && child === null) continue; digest(child); }
  }
}
function validateSafety(value: CaptureRestoreSafety): void {
  for (const key of Object.keys(SAFETY) as (keyof CaptureRestoreSafety)[]) requireValue(value[key] === false);
}
function keyMatches(value: { refKeyIdSha256: string }, key: Uint8Array): void {
  requireValue(key instanceof Uint8Array && key.byteLength === 32);
  requireValue(value.refKeyIdSha256 === tenantTelemetryRefKeyIdSha256(key));
}
/** Input bytes must come from the relevant closed, independently validated row
 * serializer. Never use plain SHA256 of error text, tenant/user IDs or payload.
 * Key/family/purpose separation prevents cross-kind and cross-key substitution.
 */
export function tenantTelemetryCaptureCheckpointOpaqueDigest(
  family: TenantTelemetryCaptureCheckpointFamily, purpose: "identity" | "record", sourceBytes: Uint8Array, key: Uint8Array,
): string {
  requireValue(TENANT_TELEMETRY_CAPTURE_CHECKPOINT_FAMILIES.includes(family) && (purpose === "identity" || purpose === "record"));
  requireValue(key instanceof Uint8Array && key.byteLength === 32 && sourceBytes instanceof Uint8Array
    && sourceBytes.byteLength > 0 && sourceBytes.byteLength <= TENANT_TELEMETRY_CAPTURE_RESTORE_MAX_BYTES);
  return createHmac("sha256", key).update("agent-service/tenant-telemetry-capture-checkpoint-ref/v1\0")
    .update(family).update("\0").update(purpose).update("\0").update(sourceBytes).digest("hex");
}
/** Operation-addressed physical projections use the exact operation digest
 * as their canonical identity bytes. Inventories retain their own inventory PK;
 * queued jobs' embedded inventory is covered by their full job record HMAC. */
export function tenantTelemetryCaptureCheckpointOperationIdentity(
  family: TenantTelemetryCaptureCheckpointFamily, operationSha256: string, key: Uint8Array,
): string {
  requireValue(["write_job", "write_ack", "membership", "application_binding", "provider_source_binding",
    "provider_failure_commit", "write_payload", "write_reservation"].includes(family));
  digest(operationSha256);
  return tenantTelemetryCaptureCheckpointOpaqueDigest(family, "identity", Buffer.from(operationSha256, "ascii"), key);
}
const LEAF_KEYS = ["family", "identityRefSha256", "recordHmacSha256", "knowledge", "state", "sourceHighWaterDbMs"] as const;
function allowedStates(family: TenantTelemetryCaptureCheckpointFamily): readonly string[] {
  if (["lifecycle_control", "application_control", "capture_control"].includes(family)) return ["inactive", "active"];
  if (family === "write_job") return ["queued", "reserved", "written", "blocked"];
  if (family === "write_payload") return ["spooled"];
  if (family === "write_reservation") return ["reserved"];
  if (family === "legacy_failure") return ["legacy_unknown"];
  return ["record"];
}
export function validateTenantTelemetryCaptureCheckpointLeaf(value: TenantTelemetryCaptureCheckpointLeaf): void {
  closed(value, LEAF_KEYS); digest(value.identityRefSha256); digest(value.recordHmacSha256); integer(value.sourceHighWaterDbMs);
  requireValue(TENANT_TELEMETRY_CAPTURE_CHECKPOINT_FAMILIES.includes(value.family)
    && (value.knowledge === "validated_projection" || value.knowledge === "legacy_unknown"));
  requireValue(allowedStates(value.family).includes(value.state));
  if (value.state === "legacy_unknown") requireValue(value.knowledge === "legacy_unknown");
}
function emptyStates(): Record<TenantTelemetryCaptureCheckpointState, number> {
  return { record: 0, inactive: 0, active: 0, queued: 0, reserved: 0, written: 0, blocked: 0, spooled: 0, legacy_unknown: 0 };
}
function familyRoot(family: TenantTelemetryCaptureCheckpointFamily, leaves: readonly TenantTelemetryCaptureCheckpointLeaf[]): string {
  return hash("tenant-telemetry-capture-checkpoint-family-v1", { family, leaves });
}
function summarize(leaves: readonly TenantTelemetryCaptureCheckpointLeaf[]): TenantTelemetryCaptureCheckpointFamilySummary[] {
  array(leaves, TENANT_TELEMETRY_CAPTURE_RESTORE_MAX_LEAVES);
  const grouped = new Map<TenantTelemetryCaptureCheckpointFamily, TenantTelemetryCaptureCheckpointLeaf[]>();
  const seen = new Set<string>();
  for (const leaf of leaves) {
    validateTenantTelemetryCaptureCheckpointLeaf(leaf);
    const identity = `${leaf.family}:${leaf.identityRefSha256}`; requireValue(!seen.has(identity)); seen.add(identity);
    const list = grouped.get(leaf.family) ?? []; list.push({ ...leaf }); grouped.set(leaf.family, list);
  }
  return TENANT_TELEMETRY_CAPTURE_CHECKPOINT_FAMILIES.map((family) => {
    const rows = (grouped.get(family) ?? []).sort((a, b) => a.identityRefSha256 < b.identityRefSha256 ? -1 : a.identityRefSha256 > b.identityRefSha256 ? 1 : 0);
    const states = emptyStates(); let highWater = 0; let unknown = 0;
    for (const row of rows) { states[row.state] += 1; highWater = Math.max(highWater, row.sourceHighWaterDbMs); if (row.knowledge === "legacy_unknown") unknown += 1; }
    return { family, rowCount: rows.length, legacyUnknownCount: unknown, states, sourceHighWaterDbMs: highWater, rootSha256: familyRoot(family, rows) };
  });
}
const HEADER_KEYS = ["backupId", "anchorSha256", "anchorCreatedAtDbMs", "controlHighWaterDbMs", "logicalDatabaseNamespaceSha256", "schemaMigrationRootSha256",
  "sourceRuntimeLineageKind", "sourceRuntimeEpochSha256", "sourceRuntimeBindingSha256", "sourceRuntimeControlEvidenceSha256",
  "sourceRuntimeControlGeneration", "sourceHistoryReceiptSha256", "sourceCaptureCutoverReceiptSha256", "originalRuntimeEpochSha256",
  "originalRuntimeBindingSha256", "originalCaptureActivationReceiptSha256", "refKeyIdSha256", "lifecycleControlEvidenceSha256",
  "captureControlEvidenceSha256", "logsTargetSha256", "logsTargetReceiptSha256", "journalControlEvidenceSha256", "journalTargetRootSha256",
  "journalHeadRootSha256", "catalogControlEvidenceSha256", "catalogHeadSequence", "catalogHeadRootSha256", "blobStorageControlEvidenceSha256", "sealedAtDbMs"] as const;
const SAFETY_KEYS = Object.keys(SAFETY);
function validateHeader(value: TenantTelemetryCaptureBackupCheckpointHeader): void {
  closed(value, HEADER_KEYS); backupId(value.backupId);
  validateDigests(value, ["sourceHistoryReceiptSha256", "sourceCaptureCutoverReceiptSha256"]);
  integer(value.anchorCreatedAtDbMs); integer(value.controlHighWaterDbMs); integer(value.sourceRuntimeControlGeneration, 1); integer(value.catalogHeadSequence); integer(value.sealedAtDbMs);
  requireValue(value.sealedAtDbMs >= Math.max(value.anchorCreatedAtDbMs, value.controlHighWaterDbMs));
  if (value.sourceRuntimeLineageKind === "primary") {
    requireValue(value.sourceHistoryReceiptSha256 === null && value.sourceCaptureCutoverReceiptSha256 === null
      && value.sourceRuntimeEpochSha256 === value.originalRuntimeEpochSha256 && value.sourceRuntimeBindingSha256 === value.originalRuntimeBindingSha256);
  } else {
    requireValue(value.sourceRuntimeLineageKind === "restore" && value.sourceHistoryReceiptSha256 !== null && value.sourceCaptureCutoverReceiptSha256 !== null
      && value.sourceRuntimeEpochSha256 !== value.originalRuntimeEpochSha256 && value.sourceRuntimeBindingSha256 !== value.originalRuntimeBindingSha256);
  }
}
function receiptHash(value: Record<string, unknown>, field: "checkpointSha256" | "receiptSha256"): string {
  const { [field]: ignored, ...body } = value; void ignored;
  requireValue(typeof body.scope === "string"); return hash(body.scope, body);
}
const CHECKPOINT_KEYS = ["scope", "protocol", "phase", ...HEADER_KEYS, "families", "observedRowCount", "legacyUnknownCount",
  "sourceHighWaterDbMs", "projectionRootSha256", ...SAFETY_KEYS, "checkpointSha256"] as const;
export function validateTenantTelemetryCaptureBackupCheckpoint(value: TenantTelemetryCaptureBackupCheckpoint, key: Uint8Array): void {
  closed(value, CHECKPOINT_KEYS);
  requireValue(value.scope === TENANT_TELEMETRY_CAPTURE_CHECKPOINT_SCOPE && value.protocol === TENANT_TELEMETRY_CAPTURE_RESTORE_PROTOCOL && value.phase === "sealed_before_dump");
  const header = Object.fromEntries(HEADER_KEYS.map((name) => [name, value[name]])) as unknown as TenantTelemetryCaptureBackupCheckpointHeader;
  validateHeader(header); keyMatches(value, key); validateSafety(value);
  array(value.families, TENANT_TELEMETRY_CAPTURE_CHECKPOINT_FAMILIES.length);
  requireValue(value.families.length === TENANT_TELEMETRY_CAPTURE_CHECKPOINT_FAMILIES.length);
  let total = 0; let unknown = 0; let highWater = Math.max(value.anchorCreatedAtDbMs, value.controlHighWaterDbMs);
  for (const [index, summary] of value.families.entries()) {
    closed(summary, ["family", "rowCount", "legacyUnknownCount", "states", "sourceHighWaterDbMs", "rootSha256"]);
    requireValue(summary.family === TENANT_TELEMETRY_CAPTURE_CHECKPOINT_FAMILIES[index]);
    integer(summary.rowCount, 0, TENANT_TELEMETRY_CAPTURE_RESTORE_MAX_LEAVES); integer(summary.legacyUnknownCount, 0, summary.rowCount);
    integer(summary.sourceHighWaterDbMs); digest(summary.rootSha256); closed(summary.states, TENANT_TELEMETRY_CAPTURE_CHECKPOINT_STATES);
    let states = 0;
    for (const state of TENANT_TELEMETRY_CAPTURE_CHECKPOINT_STATES) {
      integer(summary.states[state], 0, summary.rowCount); states += summary.states[state];
      if (!allowedStates(summary.family).includes(state)) requireValue(summary.states[state] === 0);
    }
    requireValue(states === summary.rowCount);
    if (summary.family === "legacy_failure") requireValue(summary.legacyUnknownCount === summary.rowCount);
    if (summary.rowCount === 0) requireValue(summary.sourceHighWaterDbMs === 0 && summary.rootSha256 === familyRoot(summary.family, []));
    else requireValue(summary.rootSha256 !== familyRoot(summary.family, []));
    total += summary.rowCount; unknown += summary.legacyUnknownCount; highWater = Math.max(highWater, summary.sourceHighWaterDbMs);
  }
  integer(total, 0, TENANT_TELEMETRY_CAPTURE_RESTORE_MAX_LEAVES);
  requireValue(value.observedRowCount === total && value.legacyUnknownCount === unknown && value.sourceHighWaterDbMs === highWater && value.sealedAtDbMs >= highWater);
  digest(value.projectionRootSha256); digest(value.checkpointSha256);
  requireValue(value.projectionRootSha256 === hash("tenant-telemetry-capture-checkpoint-projection-v1", value.families)
    && value.checkpointSha256 === receiptHash(value, "checkpointSha256"));
}
export function createTenantTelemetryCaptureBackupCheckpoint(
  header: TenantTelemetryCaptureBackupCheckpointHeader, leaves: readonly TenantTelemetryCaptureCheckpointLeaf[], key: Uint8Array,
): TenantTelemetryCaptureBackupCheckpoint {
  validateHeader(header); keyMatches(header, key); const families = summarize(leaves);
  const body = { scope: TENANT_TELEMETRY_CAPTURE_CHECKPOINT_SCOPE, protocol: TENANT_TELEMETRY_CAPTURE_RESTORE_PROTOCOL,
    phase: "sealed_before_dump" as const, ...header, families,
    observedRowCount: leaves.length, legacyUnknownCount: families.reduce((sum, family) => sum + family.legacyUnknownCount, 0),
    sourceHighWaterDbMs: families.reduce((high, family) => Math.max(high, family.sourceHighWaterDbMs), Math.max(header.anchorCreatedAtDbMs, header.controlHighWaterDbMs)),
    projectionRootSha256: hash("tenant-telemetry-capture-checkpoint-projection-v1", families), ...SAFETY };
  const result = { ...body, checkpointSha256: hash(body.scope, body) };
  validateTenantTelemetryCaptureBackupCheckpoint(result, key);
  for (const summary of families) { Object.freeze(summary.states); Object.freeze(summary); } Object.freeze(families);
  return Object.freeze(result);
}
export function assertTenantTelemetryCaptureCheckpointLeaves(
  checkpoint: TenantTelemetryCaptureBackupCheckpoint, leaves: readonly TenantTelemetryCaptureCheckpointLeaf[], key: Uint8Array,
): void {
  validateTenantTelemetryCaptureBackupCheckpoint(checkpoint, key);
  requireValue(canonical(summarize(leaves)) === canonical(checkpoint.families));
}
/** Before/after dump comparison excludes only observation time and its digest.
 * It never treats a matching self-hash as proof of actual artifact bytes. */
export function assertTenantTelemetryCaptureBackupCheckpointUnchanged(
  before: TenantTelemetryCaptureBackupCheckpoint, after: TenantTelemetryCaptureBackupCheckpoint, key: Uint8Array,
): void {
  validateTenantTelemetryCaptureBackupCheckpoint(before, key); validateTenantTelemetryCaptureBackupCheckpoint(after, key);
  requireValue(after.sealedAtDbMs >= before.sealedAtDbMs);
  const { sealedAtDbMs: a, checkpointSha256: b, ...left } = before; void a; void b;
  const { sealedAtDbMs: c, checkpointSha256: d, ...right } = after; void c; void d;
  requireValue(canonical(left) === canonical(right));
}
const ORIGINAL_KEYS = ["originalRuntimeEpochSha256", "originalRuntimeBindingSha256", "originalCaptureActivationReceiptSha256", "refKeyIdSha256",
  "lifecycleControlEvidenceSha256", "captureControlEvidenceSha256", "logsTargetSha256", "logsTargetReceiptSha256"] as const;
const ACTIVATION_KEYS = ["backupId", "anchorSha256", "checkpointSha256", "artifactManifestSha256", "sourceSnapshotSha256", "providerEvidenceSha256",
  "sourceBindingSha256", "reservationSha256", "reservationReceiptSha256", "restoreRunId", "runtimeEpochSha256", "runtimeBindingSha256",
  "runtimeControlEvidenceSha256", "runtimeControlGeneration", "replayReceiptSha256", "sealedJournalHeadRootSha256", "activatedAtDbMs"] as const;
function validateActivation(value: TenantTelemetryCaptureRestoreActivationBinding): void {
  closed(value, ACTIVATION_KEYS); backupId(value.backupId); restoreRunId(value.restoreRunId); validateDigests(value);
  integer(value.runtimeControlGeneration, 1); integer(value.activatedAtDbMs);
}
const HISTORY_KEYS = ["scope", "protocol", "phase", ...ACTIVATION_KEYS, ...ORIGINAL_KEYS, "sourceRuntimeEpochSha256",
  "sourceProjectionRootSha256", "preservedRowCount", "preservedLegacyUnknownCount", "historyReadOnly", "writeAuthorized", ...SAFETY_KEYS, "receiptSha256"] as const;
export function validateTenantTelemetryCaptureRestoreHistoryReceipt(
  value: TenantTelemetryCaptureRestoreHistoryReceipt, checkpoint: TenantTelemetryCaptureBackupCheckpoint, key: Uint8Array,
): void {
  closed(value, HISTORY_KEYS); validateTenantTelemetryCaptureBackupCheckpoint(checkpoint, key); keyMatches(value, key); validateSafety(value);
  validateActivation(Object.fromEntries(ACTIVATION_KEYS.map((name) => [name, value[name]])) as unknown as TenantTelemetryCaptureRestoreActivationBinding);
  validateDigests(value);
  requireValue(value.scope === TENANT_TELEMETRY_CAPTURE_RESTORE_HISTORY_SCOPE && value.protocol === TENANT_TELEMETRY_CAPTURE_RESTORE_PROTOCOL
    && value.phase === "active" && value.historyReadOnly === true && value.writeAuthorized === false);
  for (const field of ["backupId", "anchorSha256", "checkpointSha256", ...ORIGINAL_KEYS] as const) requireValue(value[field] === checkpoint[field]);
  requireValue(value.sourceRuntimeEpochSha256 === checkpoint.sourceRuntimeEpochSha256 && value.runtimeEpochSha256 !== value.sourceRuntimeEpochSha256
    && value.runtimeEpochSha256 !== checkpoint.originalRuntimeEpochSha256 && value.runtimeControlGeneration > checkpoint.sourceRuntimeControlGeneration
    && value.runtimeBindingSha256 !== checkpoint.sourceRuntimeBindingSha256 && value.runtimeBindingSha256 !== checkpoint.originalRuntimeBindingSha256
    && value.activatedAtDbMs >= checkpoint.sealedAtDbMs && value.sourceProjectionRootSha256 === checkpoint.projectionRootSha256
    && value.preservedRowCount === checkpoint.observedRowCount && value.preservedLegacyUnknownCount === checkpoint.legacyUnknownCount
    && value.receiptSha256 === receiptHash(value, "receiptSha256"));
}
export function createTenantTelemetryCaptureRestoreHistoryReceipt(
  binding: TenantTelemetryCaptureRestoreActivationBinding, checkpoint: TenantTelemetryCaptureBackupCheckpoint, key: Uint8Array,
): TenantTelemetryCaptureRestoreHistoryReceipt {
  validateActivation(binding); validateTenantTelemetryCaptureBackupCheckpoint(checkpoint, key);
  const original = Object.fromEntries(ORIGINAL_KEYS.map((name) => [name, checkpoint[name]])) as unknown as CaptureOriginalLineage;
  const body = { scope: TENANT_TELEMETRY_CAPTURE_RESTORE_HISTORY_SCOPE, protocol: TENANT_TELEMETRY_CAPTURE_RESTORE_PROTOCOL,
    phase: "active" as const, ...binding, ...original, sourceRuntimeEpochSha256: checkpoint.sourceRuntimeEpochSha256,
    sourceProjectionRootSha256: checkpoint.projectionRootSha256, preservedRowCount: checkpoint.observedRowCount,
    preservedLegacyUnknownCount: checkpoint.legacyUnknownCount, historyReadOnly: true as const, writeAuthorized: false as const, ...SAFETY };
  const result = { ...body, receiptSha256: hash(body.scope, body) };
  validateTenantTelemetryCaptureRestoreHistoryReceipt(result, checkpoint, key); return Object.freeze(result);
}
/** Required when consuming a durable history receipt: compare against actual
 * current run/binding/reservation/runtime, not only the receipt's own hash. */
export function assertTenantTelemetryCaptureRestoreActivationBinding(
  history: TenantTelemetryCaptureRestoreHistoryReceipt, expected: TenantTelemetryCaptureRestoreActivationBinding,
): void {
  closed(history, HISTORY_KEYS);
  validateActivation(expected);
  for (const field of ACTIVATION_KEYS) requireValue(history[field] === expected[field]);
}
const CUTOVER_INPUT_KEYS = [...ORIGINAL_KEYS, "historyReceiptSha256", "restoreRunId", "runtimeEpochSha256", "runtimeBindingSha256",
  "runtimeControlEvidenceSha256", "runtimeControlGeneration", "configuredFleetRootSha256", "activatedAtDbMs", "fleetStoppedAck",
  "legacyWritersDrainedAck", "producerReadyAck", "localOnlyAck"] as const;
function validateCutoverInput(value: TenantTelemetryCaptureEpochCutoverInput): void {
  closed(value, CUTOVER_INPUT_KEYS); validateDigests(value); restoreRunId(value.restoreRunId); integer(value.runtimeControlGeneration, 1); integer(value.activatedAtDbMs);
  requireValue(value.fleetStoppedAck === "fleet-stopped-v1" && value.legacyWritersDrainedAck === "legacy-writers-drained-v1"
    && value.producerReadyAck === "provider-step-error-v2-ready-v1" && value.localOnlyAck === "local-only-v1");
}
const CUTOVER_KEYS = ["scope", "protocol", "phase", ...CUTOVER_INPUT_KEYS, "checkpointSha256", "newCaptureWritesAuthorized",
  "historicalOperationRecoveryAuthorized", ...SAFETY_KEYS, "receiptSha256"] as const;
export function validateTenantTelemetryCaptureEpochCutoverReceipt(
  value: TenantTelemetryCaptureEpochCutoverReceipt, history: TenantTelemetryCaptureRestoreHistoryReceipt,
  checkpoint: TenantTelemetryCaptureBackupCheckpoint, key: Uint8Array,
): void {
  closed(value, CUTOVER_KEYS); validateTenantTelemetryCaptureRestoreHistoryReceipt(history, checkpoint, key); validateSafety(value); keyMatches(value, key);
  validateCutoverInput(Object.fromEntries(CUTOVER_INPUT_KEYS.map((name) => [name, value[name]])) as unknown as TenantTelemetryCaptureEpochCutoverInput);
  requireValue(value.scope === TENANT_TELEMETRY_CAPTURE_EPOCH_CUTOVER_SCOPE && value.protocol === TENANT_TELEMETRY_CAPTURE_RESTORE_PROTOCOL
    && value.phase === "active" && value.newCaptureWritesAuthorized === true && value.historicalOperationRecoveryAuthorized === false);
  for (const field of [...ORIGINAL_KEYS, "restoreRunId", "runtimeEpochSha256", "runtimeBindingSha256", "runtimeControlEvidenceSha256", "runtimeControlGeneration", "checkpointSha256"] as const) requireValue(value[field] === history[field]);
  requireValue(value.historyReceiptSha256 === history.receiptSha256 && value.activatedAtDbMs >= history.activatedAtDbMs
    && value.receiptSha256 === receiptHash(value, "receiptSha256"));
}
export function createTenantTelemetryCaptureEpochCutoverReceipt(
  input: TenantTelemetryCaptureEpochCutoverInput, history: TenantTelemetryCaptureRestoreHistoryReceipt,
  checkpoint: TenantTelemetryCaptureBackupCheckpoint, key: Uint8Array,
): TenantTelemetryCaptureEpochCutoverReceipt {
  validateCutoverInput(input);
  const body = { scope: TENANT_TELEMETRY_CAPTURE_EPOCH_CUTOVER_SCOPE, protocol: TENANT_TELEMETRY_CAPTURE_RESTORE_PROTOCOL, phase: "active" as const,
    ...input, checkpointSha256: checkpoint.checkpointSha256, newCaptureWritesAuthorized: true as const,
    historicalOperationRecoveryAuthorized: false as const, ...SAFETY };
  const result = { ...body, receiptSha256: hash(body.scope, body) };
  validateTenantTelemetryCaptureEpochCutoverReceipt(result, history, checkpoint, key); return Object.freeze(result);
}
const RECOVERY_INPUT_KEYS = ["cutoverReceiptSha256", "historyReceiptSha256", "checkpointSha256", "restoreRunId", "runtimeEpochSha256",
  "writeOperationSha256", "tenantRefSha256", "ownerRefSha256", "sourceSessionRefSha256", "sourceTurnRefSha256", "sourceItemRefSha256", "sourceStepIndex",
  "inventorySha256", "payloadSha256", "manifestSha256", "membershipSha256", "sourceBindingReceiptSha256", "failureCommitReceiptSha256", "originalJobState",
  "originalJobEvidenceHmacSha256", "originalPayloadEvidenceHmacSha256", "originalMembershipEvidenceHmacSha256", "originalSourceBindingEvidenceHmacSha256",
  "originalFailureEvidenceHmacSha256", "originalReservationReceiptSha256", "originalReservationEvidenceHmacSha256", "originalReservationClaimAttempt",
  "originalReservationClaimTokenSha256", "previousClaimAttempt", "previousClaimTokenSha256", "previousClaimLeaseUntilMs", "newClaimAttempt",
  "newClaimTokenSha256", "newClaimLeaseUntilMs", "issuedAtDbMs", "recoveryMode"] as const;
const NULL_RECOVERY_DIGESTS = ["originalReservationReceiptSha256", "originalReservationEvidenceHmacSha256", "originalReservationClaimTokenSha256", "previousClaimTokenSha256"];
function validateRecoveryInput(value: TenantTelemetryCaptureOperationRecoveryInput): void {
  closed(value, RECOVERY_INPUT_KEYS); validateDigests(value, NULL_RECOVERY_DIGESTS); restoreRunId(value.restoreRunId);
  integer(value.sourceStepIndex, 1); integer(value.previousClaimAttempt); integer(value.newClaimAttempt, 1); integer(value.issuedAtDbMs); integer(value.newClaimLeaseUntilMs);
  requireValue((value.originalJobState === "queued" || value.originalJobState === "reserved") && value.newClaimAttempt > value.previousClaimAttempt
    && value.newClaimLeaseUntilMs > value.issuedAtDbMs && value.newClaimLeaseUntilMs - value.issuedAtDbMs <= TENANT_TELEMETRY_CAPTURE_RECOVERY_MAX_LEASE_MS
    && (value.recoveryMode === "resume_queued" || value.recoveryMode === "resume_reserved" || value.recoveryMode === "reserved_ack_only"));
  requireValue((value.previousClaimTokenSha256 === null) === (value.previousClaimLeaseUntilMs === null));
  if (value.previousClaimTokenSha256 !== null) {
    integer(value.previousClaimLeaseUntilMs); requireValue(value.previousClaimAttempt > 0 && value.previousClaimLeaseUntilMs <= value.issuedAtDbMs
      && value.newClaimTokenSha256 !== value.previousClaimTokenSha256);
  }
  if (value.originalReservationReceiptSha256 === null) {
    requireValue(value.originalJobState === "queued" && value.recoveryMode === "resume_queued" && value.originalReservationEvidenceHmacSha256 === null
      && value.originalReservationClaimAttempt === null && value.originalReservationClaimTokenSha256 === null);
  } else {
    requireValue(value.originalJobState === "reserved" && (value.recoveryMode === "resume_reserved" || value.recoveryMode === "reserved_ack_only")
      && value.originalReservationEvidenceHmacSha256 !== null && value.originalReservationClaimTokenSha256 !== null);
    integer(value.originalReservationClaimAttempt, 1);
    requireValue(value.previousClaimAttempt >= value.originalReservationClaimAttempt && value.newClaimAttempt > value.originalReservationClaimAttempt
      && value.newClaimTokenSha256 !== value.originalReservationClaimTokenSha256);
  }
}
const RECOVERY_KEYS = ["scope", "protocol", "phase", ...RECOVERY_INPUT_KEYS, "sourceKind", "newReservationAuthorized", "newExternalCreateAuthorized", ...SAFETY_KEYS, "receiptSha256"] as const;
export function validateTenantTelemetryCaptureOperationRecoveryPermit(
  value: TenantTelemetryCaptureOperationRecoveryPermit, cutover: TenantTelemetryCaptureEpochCutoverReceipt,
  history: TenantTelemetryCaptureRestoreHistoryReceipt, checkpoint: TenantTelemetryCaptureBackupCheckpoint,
  originalLeaves: readonly TenantTelemetryCaptureCheckpointLeaf[], key: Uint8Array,
): void {
  closed(value, RECOVERY_KEYS); validateTenantTelemetryCaptureEpochCutoverReceipt(cutover, history, checkpoint, key);
  assertTenantTelemetryCaptureCheckpointLeaves(checkpoint, originalLeaves, key); validateSafety(value);
  validateRecoveryInput(Object.fromEntries(RECOVERY_INPUT_KEYS.map((name) => [name, value[name]])) as unknown as TenantTelemetryCaptureOperationRecoveryInput);
  requireValue(value.scope === TENANT_TELEMETRY_CAPTURE_RECOVERY_PERMIT_SCOPE && value.protocol === TENANT_TELEMETRY_CAPTURE_RESTORE_PROTOCOL
    && value.phase === "leased" && value.sourceKind === "persisted-provider-v2"
    && value.newReservationAuthorized === (value.recoveryMode === "resume_queued") && value.newExternalCreateAuthorized === (value.recoveryMode !== "reserved_ack_only")
    && value.cutoverReceiptSha256 === cutover.receiptSha256 && value.historyReceiptSha256 === history.receiptSha256 && value.checkpointSha256 === checkpoint.checkpointSha256
    && value.restoreRunId === cutover.restoreRunId && value.runtimeEpochSha256 === cutover.runtimeEpochSha256 && value.issuedAtDbMs >= cutover.activatedAtDbMs);
  const required: [TenantTelemetryCaptureCheckpointFamily, string, TenantTelemetryCaptureCheckpointState][] = [
    ["write_job", value.originalJobEvidenceHmacSha256, value.originalJobState], ["write_payload", value.originalPayloadEvidenceHmacSha256, "spooled"],
    ["membership", value.originalMembershipEvidenceHmacSha256, "record"], ["provider_source_binding", value.originalSourceBindingEvidenceHmacSha256, "record"],
    ["provider_failure_commit", value.originalFailureEvidenceHmacSha256, "record"],
  ];
  if (value.originalReservationEvidenceHmacSha256 !== null) required.push(["write_reservation", value.originalReservationEvidenceHmacSha256, "reserved"]);
  for (const [family, evidence, state] of required) {
    const identity = tenantTelemetryCaptureCheckpointOperationIdentity(family, value.writeOperationSha256, key);
    const selected = originalLeaves.filter((leaf) => leaf.family === family && leaf.identityRefSha256 === identity);
    requireValue(selected.length === 1 && selected[0]!.recordHmacSha256 === evidence && selected[0]!.state === state && selected[0]!.knowledge === "validated_projection");
  }
  requireValue(!originalLeaves.some((leaf) => leaf.family === "write_ack"
    && leaf.identityRefSha256 === tenantTelemetryCaptureCheckpointOperationIdentity("write_ack", value.writeOperationSha256, key)));
  if (value.originalReservationReceiptSha256 === null) requireValue(!originalLeaves.some((leaf) => leaf.family === "write_reservation"
    && leaf.identityRefSha256 === tenantTelemetryCaptureCheckpointOperationIdentity("write_reservation", value.writeOperationSha256, key)));
  requireValue(value.receiptSha256 === receiptHash(value, "receiptSha256"));
}
/** This receipt is a necessary original-snapshot inclusion/lineage guard, not
 * sufficient source authorization. Its transaction consumer must independently
 * match every original inventory/payload/source/reservation field to the actual
 * closed records AND CAS-install the exact new claim. resume_reserved explicitly
 * covers a crash after DB reservation but BEFORE external create: if the exact
 * object is absent it may continue create-only with the ORIGINAL immutable
 * descriptor after fresh current owner/T1/policy/hold/fleet/source checks. It
 * cannot issue another reservation, change the descriptor, or revive the old
 * claim. reserved_ack_only cannot reserve/create even in that absent-object case.
 * Do not turn knowledge=
 * legacy_unknown into validated_projection or replay an old claim. */
export function createTenantTelemetryCaptureOperationRecoveryPermit(
  input: TenantTelemetryCaptureOperationRecoveryInput, cutover: TenantTelemetryCaptureEpochCutoverReceipt,
  history: TenantTelemetryCaptureRestoreHistoryReceipt, checkpoint: TenantTelemetryCaptureBackupCheckpoint,
  originalLeaves: readonly TenantTelemetryCaptureCheckpointLeaf[], key: Uint8Array,
): TenantTelemetryCaptureOperationRecoveryPermit {
  validateRecoveryInput(input);
  const body = { scope: TENANT_TELEMETRY_CAPTURE_RECOVERY_PERMIT_SCOPE, protocol: TENANT_TELEMETRY_CAPTURE_RESTORE_PROTOCOL, phase: "leased" as const,
    ...input, sourceKind: "persisted-provider-v2" as const, newReservationAuthorized: input.recoveryMode === "resume_queued",
    newExternalCreateAuthorized: input.recoveryMode !== "reserved_ack_only", ...SAFETY };
  const result = { ...body, receiptSha256: hash(body.scope, body) };
  validateTenantTelemetryCaptureOperationRecoveryPermit(result, cutover, history, checkpoint, originalLeaves, key); return Object.freeze(result);
}
export interface TenantTelemetryCaptureRecoveryCurrentBinding {
  /** Independently reconstructed original source/descriptor/reservation and the
   * atomically installed new claim; never copied from the received permit. */
  input: TenantTelemetryCaptureOperationRecoveryInput;
  storeDbTimestampMs: number;
}
export function assertTenantTelemetryCaptureOperationRecoveryBinding(
  permit: TenantTelemetryCaptureOperationRecoveryPermit, current: TenantTelemetryCaptureRecoveryCurrentBinding,
): void {
  closed(permit, RECOVERY_KEYS); closed(current, ["input", "storeDbTimestampMs"]);
  validateRecoveryInput(current.input); integer(current.storeDbTimestampMs);
  for (const field of RECOVERY_INPUT_KEYS) requireValue(permit[field] === current.input[field]);
  requireValue(current.storeDbTimestampMs >= permit.issuedAtDbMs && current.storeDbTimestampMs < permit.newClaimLeaseUntilMs);
}

export type TenantTelemetryCaptureRestoreWireRecord = TenantTelemetryCaptureBackupCheckpoint | TenantTelemetryCaptureRestoreHistoryReceipt
  | TenantTelemetryCaptureEpochCutoverReceipt | TenantTelemetryCaptureOperationRecoveryPermit;
export interface TenantTelemetryCaptureRestoreRecordContext {
  key: Uint8Array;
  checkpoint?: TenantTelemetryCaptureBackupCheckpoint;
  history?: TenantTelemetryCaptureRestoreHistoryReceipt;
  cutover?: TenantTelemetryCaptureEpochCutoverReceipt;
  originalLeaves?: readonly TenantTelemetryCaptureCheckpointLeaf[];
  recoveryBinding?: TenantTelemetryCaptureRecoveryCurrentBinding;
  /** Actual immutable 0031/0030 activation projection, never read from the wire
   * being decoded. A later journal-head advancement must be independently
   * checked against the runtime event chain; it does not rewrite this binding. */
  activationBinding?: TenantTelemetryCaptureRestoreActivationBinding;
}
export function validateTenantTelemetryCaptureRestoreRecord(
  value: unknown, context: TenantTelemetryCaptureRestoreRecordContext,
): asserts value is TenantTelemetryCaptureRestoreWireRecord {
  requireValue(context !== null && typeof context === "object");
  closed(context, Object.keys(context));
  requireValue(Object.keys(context).every((key) => ["key", "checkpoint", "history", "cutover", "originalLeaves", "activationBinding", "recoveryBinding"].includes(key)));
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value));
  closed(value, Object.keys(value));
  if (value.scope === TENANT_TELEMETRY_CAPTURE_CHECKPOINT_SCOPE) {
    validateTenantTelemetryCaptureBackupCheckpoint(value as unknown as TenantTelemetryCaptureBackupCheckpoint, context.key); return;
  }
  requireValue(context.checkpoint !== undefined && context.activationBinding !== undefined);
  if (value.scope === TENANT_TELEMETRY_CAPTURE_RESTORE_HISTORY_SCOPE) {
    const receipt = value as unknown as TenantTelemetryCaptureRestoreHistoryReceipt;
    validateTenantTelemetryCaptureRestoreHistoryReceipt(receipt, context.checkpoint, context.key);
    assertTenantTelemetryCaptureRestoreActivationBinding(receipt, context.activationBinding); return;
  }
  requireValue(context.history !== undefined);
  assertTenantTelemetryCaptureRestoreActivationBinding(context.history, context.activationBinding);
  if (value.scope === TENANT_TELEMETRY_CAPTURE_EPOCH_CUTOVER_SCOPE) {
    validateTenantTelemetryCaptureEpochCutoverReceipt(value as unknown as TenantTelemetryCaptureEpochCutoverReceipt,
      context.history, context.checkpoint, context.key); return;
  }
  requireValue(value.scope === TENANT_TELEMETRY_CAPTURE_RECOVERY_PERMIT_SCOPE && context.cutover !== undefined && context.originalLeaves !== undefined && context.recoveryBinding !== undefined);
  const permit = value as unknown as TenantTelemetryCaptureOperationRecoveryPermit;
  validateTenantTelemetryCaptureOperationRecoveryPermit(permit,
    context.cutover, context.history, context.checkpoint, context.originalLeaves, context.key);
  assertTenantTelemetryCaptureOperationRecoveryBinding(permit, context.recoveryBinding);
}
/** Full closed-schema/integrity and independently supplied context validation;
 * transport decoding still cannot prove that context came from the database. */
export function encodeTenantTelemetryCaptureRestoreRecord(value: TenantTelemetryCaptureRestoreWireRecord,
  context: TenantTelemetryCaptureRestoreRecordContext): Uint8Array {
  validateTenantTelemetryCaptureRestoreRecord(value, context);
  const wire = canonical(value); requireValue(Buffer.byteLength(wire, "utf8") <= TENANT_TELEMETRY_CAPTURE_RESTORE_MAX_BYTES);
  return Buffer.from(wire, "utf8");
}
export function decodeTenantTelemetryCaptureRestoreRecord(bytes: Uint8Array,
  context: TenantTelemetryCaptureRestoreRecordContext): TenantTelemetryCaptureRestoreWireRecord {
  requireValue(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= TENANT_TELEMETRY_CAPTURE_RESTORE_MAX_BYTES);
  let text: string; let value: unknown;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); value = JSON.parse(text); } catch { return reject(); }
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value));
  const keys = Object.keys(value); closed(value, keys);
  validateTenantTelemetryCaptureRestoreRecord(value, context);
  requireValue(canonical(value) === text); return value;
}
