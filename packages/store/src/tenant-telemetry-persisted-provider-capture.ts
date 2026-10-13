import { createHash } from "node:crypto";
import { assertTrustedStructuredTelemetryRecordOwnerBinding, telemetryCaptureLogsSourceRefSha256, type StructuredTelemetryRecord, type PersistedEvent, type Item } from "@agent-service/protocol";
import type { CommitBatch, CommitResult } from "./types.js";
import type { TenantRestoreJournalControlRecord, TenantRestoreRuntimeControlRecord } from "./tenant-restore-journal.js";
import type { TenantTelemetryLifecycleCoverageRecord, TenantTelemetryArtifactInventoryRecord, TenantTelemetryLifecycleTargetRecord } from "./tenant-telemetry-lifecycle.js";
import * as Writer from "./tenant-telemetry-writer.js";
import * as Membership from "./tenant-telemetry-artifact-membership.js";

export const PERSISTED_PROVIDER_CAPTURE_PROTOCOL = "tenant-telemetry-persisted-step-v2" as const;
export const PERSISTED_PROVIDER_CAPTURE_PRODUCER_PROTOCOL = "provider-step-error-v2" as const;
export const PERSISTED_PROVIDER_CAPTURE_FLEET_PROTOCOL = "persisted-provider-capture-fleet-v2" as const;
export const PERSISTED_PROVIDER_CAPTURE_CONTRACT_SHA256 = createHash("sha256")
  .update("provider.upstream_request_failed:durable-failed-step:v2").digest("hex");
export const PERSISTED_PROVIDER_CAPTURE_SOURCE_SCHEMA = "provider-step-error-v2" as const;

/** Expected identities from a freshly obtained configured-fleet gate, not a drain/provider proof. */
export interface TenantTelemetryPersistedProviderCaptureProof {
  protocol: typeof PERSISTED_PROVIDER_CAPTURE_FLEET_PROTOCOL;
  configuredFleetRootSha256: string;
  captureControlEvidenceSha256: string;
  refKeyIdSha256: string;
  logsTargetSha256: string;
  logsTargetReceiptSha256: string;
  runtimeEpochSha256: string;
  runtimeBindingSha256: string;
}
export interface ActivateTenantTelemetryPersistedProviderCaptureInput {
  expectedControlGeneration: 0;
  lifecycleControlEvidenceSha256: string;
  logsTargetSha256: string;
  logsTargetReceiptSha256: string;
  configuredFleetRootSha256: string;
  fleetStoppedAck: "fleet-stopped-v1";
  legacyWritersDrainedAck: "legacy-writers-drained-v1";
  producerReadyAck: "provider-step-error-v2-ready-v1";
  localOnlyAck: "local-only-v1";
}
export interface TenantTelemetryCaptureOperatorFence {
  readonly scope: "tenant-telemetry-capture-operator-fence-v2";
  checkOwned(): Promise<void>;
}
export interface TenantTelemetryPersistedProviderCapturePrerequisites {
  runtimeEpochSha256: string;
  runtimeBindingSha256: string;
  runtimeControlEvidenceSha256: string;
  runtimeControlGeneration: number;
  journalControlEvidenceSha256: string;
  journalTargetRootSha256: string;
  journalHeadRootSha256: string;
}
export interface TenantTelemetryPersistedProviderCaptureActivationReceipt {
  scope: "tenant-telemetry-capture-activation-receipt-v2";
  protocol: typeof PERSISTED_PROVIDER_CAPTURE_PROTOCOL;
  domain: "logs";
  requestSha256: string;
  producerContractSha256: string;
  refKeyIdSha256: string;
  lifecycleControlEvidenceSha256: string;
  logsTargetSha256: string;
  logsTargetReceiptSha256: string;
  configuredFleetRootSha256: string;
  runtimeEpochSha256: string;
  runtimeBindingSha256: string;
  runtimeControlEvidenceSha256: string;
  runtimeControlGeneration: number;
  journalControlEvidenceSha256: string;
  journalTargetRootSha256: string;
  journalHeadRootSha256: string;
  coverageCount: number;
  coverageRootSha256: string;
  preCutoverFailureCount: number;
  preCutoverFailureRootSha256: string;
  preCutoverWriteCount: number;
  preCutoverWriteRootSha256: string;
  activatedAtDbMs: number;
  fleetStoppedAck: "fleet-stopped-v1";
  legacyWritersDrainedAck: "legacy-writers-drained-v1";
  producerReadyAck: "provider-step-error-v2-ready-v1";
  localOnlyAck: "local-only-v1";
  receiptSha256: string;
}
export type TenantTelemetryPersistedProviderCaptureControl =
  | { domain: "logs"; state: "inactive"; controlGeneration: 0 }
  | { domain: "logs"; state: "active"; controlGeneration: 1;
      activatedAtDbMs: number; activationEvidenceSha256: string;
      receipt: TenantTelemetryPersistedProviderCaptureActivationReceipt };
export interface TenantTelemetryPersistedProviderCaptureCoverage {
  tenantId: string;
  domain: "logs";
  scope: "tenant-telemetry-capture-coverage-v2";
  controlGeneration: 1;
  captureStatus: "capture_since_cutover" | "capture_since_tenant_creation";
  preCutoverHistoryStatus: "pre_cutover_history_unknown" | "pre_cutover_not_applicable";
  lifecycleCoverageEvidenceSha256: string;
  subjectRefSha256: string;
  producerContractSha256: string;
  coverageStartedAtDbMs: number;
  evidenceSha256: string;
}
export interface TenantTelemetryPersistedProviderCaptureSourceBinding {
  scope: "tenant-telemetry-capture-source-binding-v2";
  tenantId: string;
  domain: "logs";
  controlGeneration: 1;
  writeOperationSha256: string;
  coverageEvidenceSha256: string;
  producerContractSha256: string;
  sourceSessionRefSha256: string;
  sourceTurnRefSha256: string;
  sourceItemRefSha256: string;
  sourceStepIndex: number;
  sourceEventSeq: number;
  ownerRefSha256: string;
  payloadSha256: string;
  boundAtDbMs: number;
  receiptSha256: string;
}
export interface PersistedProviderStepFailureSource {
  tenantId: string;
  userId: string;
  turnId: string;
  itemId: string;
  stepIndex: number;
  failureKind: "provider_step_error";
}
export interface CommitPersistedProviderStepFailureInput {
  batch: CommitBatch;
  source: PersistedProviderStepFailureSource;
  /** Original frozen structured-producer record; no clone may precede provenance validation. */
  record: Readonly<StructuredTelemetryRecord>;
  freshProof: TenantTelemetryPersistedProviderCaptureProof;
}
export interface PersistedProviderStepFailureCommitReceipt {
  scope: "tenant-telemetry-provider-step-failure-commit-receipt-v2";
  tenantId: string;
  sourceSessionRefSha256: string;
  sourceTurnRefSha256: string;
  sourceItemRefSha256: string;
  sourceStepIndex: number;
  sourceEventSeq: number;
  fenceToken: number;
  beginLastSeq: number;
  endLastSeq: number;
  eventCount: number;
  eventRootSha256: string;
  businessBatchSha256: string;
  billingRootSha256: string;
  usageIdSha256: string;
  captureControlEvidenceSha256: string;
  runtimeEpochSha256: string;
  runtimeBindingSha256: string;
  writeOperationSha256: string;
  bindingReceiptSha256: string;
  membershipSha256: string;
  payloadSha256: string;
  committedAtDbMs: number;
  receiptSha256: string;
}
export type CommitPersistedProviderStepFailureResult = CommitResult & {
  failureCommitReceipt: PersistedProviderStepFailureCommitReceipt;
  replayed: boolean;
};
export interface VerifyPersistedProviderStepFailureSourceInput {
  tenantId: string;
  sessionId: string;
  turnId: string;
  itemId: string;
  stepIndex: number;
  freshProof?: TenantTelemetryPersistedProviderCaptureProof;
}
export interface PersistedProviderStepFailureSourceVerification {
  status: "not_found" | "source_verified_queued" | "source_verified_reserved" | "source_verified_written" | "source_verified_blocked";
  sourceCount: 0 | 1;
  failureCommitReceiptSha256: string | null;
  sourceBindingReceiptSha256: string | null;
  writeOperationSha256: string | null;
  membershipSha256: string | null;
  writeAckReceiptSha256: string | null;
  inventoryReceiptSha256: string | null;
  executionReady: false;
  allDomainsComplete: false;
}
export type PersistedProviderStepFailureWriteBoundary = "reserve" | "create" | "ack";
export interface TenantTelemetryPersistedProviderCaptureStore {
  getTenantTelemetryPersistedProviderCapturePrerequisites(): Promise<TenantTelemetryPersistedProviderCapturePrerequisites>;
  getTenantTelemetryPersistedProviderCaptureControl(): Promise<TenantTelemetryPersistedProviderCaptureControl>;
  getTenantTelemetryPersistedProviderCaptureBinding(): Promise<TenantTelemetryPersistedProviderCaptureProof | null>;
  getTenantTelemetryPersistedProviderCaptureActivationReceipt(): Promise<TenantTelemetryPersistedProviderCaptureActivationReceipt | null>;
  getTenantTelemetryPersistedProviderCaptureCoverage(tenantId: string): Promise<TenantTelemetryPersistedProviderCaptureCoverage | null>;
  getTenantTelemetryPersistedProviderCaptureSourceBinding(tenantId: string, operationSha256: string): Promise<TenantTelemetryPersistedProviderCaptureSourceBinding | null>;
  getTenantTelemetryPersistedProviderCaptureFailureCommitReceipt(input: VerifyPersistedProviderStepFailureSourceInput): Promise<PersistedProviderStepFailureCommitReceipt | null>;
  verifyPersistedProviderStepFailureSource(input: VerifyPersistedProviderStepFailureSourceInput): Promise<PersistedProviderStepFailureSourceVerification>;
  /** reserve/create require live owner/current gates; omission and ACK only verify history. */
  verifyPersistedProviderStepFailureWrite(tenantId: string, operationSha256: string, freshProof: TenantTelemetryPersistedProviderCaptureProof, boundary?: PersistedProviderStepFailureWriteBoundary): Promise<PersistedProviderStepFailureSourceVerification>;
  withTenantTelemetryCaptureOperatorFence<T>(work: (fence: TenantTelemetryCaptureOperatorFence) => Promise<T>, options: { timeoutMs: number; operationAbortSignal?: AbortSignal }): Promise<T>;
  activateTenantTelemetryPersistedProviderCapture(input: ActivateTenantTelemetryPersistedProviderCaptureInput, fence: TenantTelemetryCaptureOperatorFence): Promise<{ control: Extract<TenantTelemetryPersistedProviderCaptureControl, { state: "active" }>; receipt: TenantTelemetryPersistedProviderCaptureActivationReceipt }>;
}

export class PersistedProviderCaptureIntegrityError extends Error {
  constructor(message = "persisted provider capture evidence is invalid") { super(message); this.name = "PersistedProviderCaptureIntegrityError"; }
}
export class PersistedProviderCaptureConflictError extends Error {
  constructor(message = "persisted provider capture identity conflicts") { super(message); this.name = "PersistedProviderCaptureConflictError"; }
}
export function persistedProviderCaptureCanonicalJson(value: unknown): string {
  // Hash the actual JSON persistence semantics (Date.toJSON, omitted undefined
  // object fields, and null array slots), not arbitrary in-process object shapes.
  const json = JSON.stringify(value);
  if (json === undefined) throw new PersistedProviderCaptureIntegrityError("capture value is not serializable JSON");
  return canonicalPersistedJsonValue(JSON.parse(json));
}
function canonicalPersistedJsonValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalPersistedJsonValue).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalPersistedJsonValue(child)}`).join(",")}}`;
}
export function persistedProviderCaptureSha256(scope: string, value: unknown): string {
  return createHash("sha256").update(scope).update("\0").update(persistedProviderCaptureCanonicalJson(value)).digest("hex");
}
export function persistedProviderCaptureReceiptSha256<T extends { scope: string; receiptSha256?: string }>(value: T): string {
  const { receiptSha256: ignored, ...body } = value;
  void ignored;
  return persistedProviderCaptureSha256(body.scope, body);
}
export function persistedProviderCaptureCoverageSha256(value: Omit<TenantTelemetryPersistedProviderCaptureCoverage, "evidenceSha256">): string {
  const { evidenceSha256: _ignored, ...body } = value as TenantTelemetryPersistedProviderCaptureCoverage;
  return persistedProviderCaptureSha256(value.scope, body);
}
function assertClosedRecord(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("|") !== [...keys].sort().join("|")) throw new PersistedProviderCaptureIntegrityError();
}
function assertSafeCounters(value: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0) throw new PersistedProviderCaptureIntegrityError();
}
function assertDigestFields(value: Record<string, unknown>) {
  for (const [key, field] of Object.entries(value)) if (key.endsWith("Sha256") && (typeof field !== "string" || !/^[0-9a-f]{64}$/.test(field))) throw new PersistedProviderCaptureIntegrityError();
}
export function validatePersistedProviderCaptureActivationReceipt(value: TenantTelemetryPersistedProviderCaptureActivationReceipt): void {
  assertClosedRecord(value, ["scope","protocol","domain","requestSha256","producerContractSha256","refKeyIdSha256","lifecycleControlEvidenceSha256","logsTargetSha256","logsTargetReceiptSha256","configuredFleetRootSha256","runtimeEpochSha256","runtimeBindingSha256","runtimeControlEvidenceSha256","runtimeControlGeneration","journalControlEvidenceSha256","journalTargetRootSha256","journalHeadRootSha256","coverageCount","coverageRootSha256","preCutoverFailureCount","preCutoverFailureRootSha256","preCutoverWriteCount","preCutoverWriteRootSha256","activatedAtDbMs","fleetStoppedAck","legacyWritersDrainedAck","producerReadyAck","localOnlyAck","receiptSha256"]);
  assertDigestFields(value); assertSafeCounters(value,["runtimeControlGeneration","coverageCount","preCutoverFailureCount","preCutoverWriteCount","activatedAtDbMs"]);
  if (value.scope !== "tenant-telemetry-capture-activation-receipt-v2" || value.protocol !== PERSISTED_PROVIDER_CAPTURE_PROTOCOL || value.domain !== "logs" || value.producerContractSha256 !== PERSISTED_PROVIDER_CAPTURE_CONTRACT_SHA256 || value.runtimeControlGeneration < 1
    || value.fleetStoppedAck !== "fleet-stopped-v1" || value.legacyWritersDrainedAck !== "legacy-writers-drained-v1" || value.producerReadyAck !== "provider-step-error-v2-ready-v1" || value.localOnlyAck !== "local-only-v1"
    || value.receiptSha256 !== persistedProviderCaptureReceiptSha256(value)) throw new PersistedProviderCaptureIntegrityError();
}
export function validatePersistedProviderCaptureCoverage(value: TenantTelemetryPersistedProviderCaptureCoverage): void {
  assertClosedRecord(value,["tenantId","domain","scope","controlGeneration","captureStatus","preCutoverHistoryStatus","lifecycleCoverageEvidenceSha256","subjectRefSha256","producerContractSha256","coverageStartedAtDbMs","evidenceSha256"]);
  assertDigestFields(value); assertSafeCounters(value,["controlGeneration","coverageStartedAtDbMs"]);
  if (typeof value.tenantId !== "string" || !value.tenantId || value.tenantId.length > 128 || value.domain !== "logs" || value.scope !== "tenant-telemetry-capture-coverage-v2" || value.controlGeneration !== 1 || value.producerContractSha256 !== PERSISTED_PROVIDER_CAPTURE_CONTRACT_SHA256
    || !((value.captureStatus === "capture_since_cutover" && value.preCutoverHistoryStatus === "pre_cutover_history_unknown") || (value.captureStatus === "capture_since_tenant_creation" && value.preCutoverHistoryStatus === "pre_cutover_not_applicable"))
    || value.evidenceSha256 !== persistedProviderCaptureCoverageSha256(value)) throw new PersistedProviderCaptureIntegrityError();
}
export function validatePersistedProviderCaptureSourceBinding(value: TenantTelemetryPersistedProviderCaptureSourceBinding): void {
  assertClosedRecord(value,["scope","tenantId","domain","controlGeneration","writeOperationSha256","coverageEvidenceSha256","producerContractSha256","sourceSessionRefSha256","sourceTurnRefSha256","sourceItemRefSha256","sourceStepIndex","sourceEventSeq","ownerRefSha256","payloadSha256","boundAtDbMs","receiptSha256"]);
  assertDigestFields(value); assertSafeCounters(value,["controlGeneration","sourceStepIndex","sourceEventSeq","boundAtDbMs"]);
  if (typeof value.tenantId !== "string" || !value.tenantId || value.tenantId.length > 128 || value.scope !== "tenant-telemetry-capture-source-binding-v2" || value.domain !== "logs" || value.controlGeneration !== 1 || value.producerContractSha256 !== PERSISTED_PROVIDER_CAPTURE_CONTRACT_SHA256 || value.sourceEventSeq < 1 || value.sourceStepIndex < 1
    || value.receiptSha256 !== persistedProviderCaptureReceiptSha256(value)) throw new PersistedProviderCaptureIntegrityError();
}
export function validatePersistedProviderFailureCommitReceipt(value: PersistedProviderStepFailureCommitReceipt): void {
  assertClosedRecord(value,["scope","tenantId","sourceSessionRefSha256","sourceTurnRefSha256","sourceItemRefSha256","sourceStepIndex","sourceEventSeq","fenceToken","beginLastSeq","endLastSeq","eventCount","eventRootSha256","businessBatchSha256","billingRootSha256","usageIdSha256","captureControlEvidenceSha256","runtimeEpochSha256","runtimeBindingSha256","writeOperationSha256","bindingReceiptSha256","membershipSha256","payloadSha256","committedAtDbMs","receiptSha256"]);
  assertDigestFields(value); assertSafeCounters(value,["sourceStepIndex","sourceEventSeq","fenceToken","beginLastSeq","endLastSeq","eventCount","committedAtDbMs"]);
  if (typeof value.tenantId !== "string" || !value.tenantId || value.tenantId.length > 128 || value.scope !== "tenant-telemetry-provider-step-failure-commit-receipt-v2" || value.eventCount < 1 || value.sourceStepIndex < 1 || value.fenceToken < 1 || value.endLastSeq-value.beginLastSeq !== value.eventCount || value.sourceEventSeq <= value.beginLastSeq || value.sourceEventSeq > value.endLastSeq
    || value.receiptSha256 !== persistedProviderCaptureReceiptSha256(value)) throw new PersistedProviderCaptureIntegrityError();
}
/** Static primary lineage identity. Normal journal head advancement is deliberately excluded. */
export function persistedProviderCaptureRuntimeBindingSha256(runtime: TenantRestoreRuntimeControlRecord, journal: TenantRestoreJournalControlRecord): string {
  if (runtime.state !== "active" || runtime.lineageKind !== "primary" || journal.controlGeneration !== 1
    || runtime.controlEvidenceSha256 !== journal.evidenceSha256
    || runtime.logicalDatabaseNamespaceSha256 !== journal.logicalDatabaseNamespaceSha256
    || runtime.targetRootSha256 !== journal.targetRootSha256 || runtime.targetCount !== journal.targetCount) {
    throw new PersistedProviderCaptureConflictError("capture requires an exact active primary restore runtime");
  }
  return persistedProviderCaptureSha256("tenant-telemetry-capture-runtime-binding-v2", {
    lineageKind: "primary", runtimeEpochSha256: runtime.runtimeEpochSha256,
    journalControlEvidenceSha256: journal.evidenceSha256,
    logicalDatabaseNamespaceSha256: runtime.logicalDatabaseNamespaceSha256,
    journalTargetRootSha256: journal.targetRootSha256, targetCount: journal.targetCount,
  });
}
export function validatePersistedProviderCaptureProof(proof: TenantTelemetryPersistedProviderCaptureProof): void {
  const keys = ["protocol", "configuredFleetRootSha256", "captureControlEvidenceSha256", "refKeyIdSha256", "logsTargetSha256", "logsTargetReceiptSha256", "runtimeEpochSha256", "runtimeBindingSha256"];
  if (Object.keys(proof).sort().join("|") !== keys.sort().join("|") || proof.protocol !== PERSISTED_PROVIDER_CAPTURE_FLEET_PROTOCOL
    || Object.entries(proof).some(([key, value]) => key !== "protocol" && (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)))) {
    throw new PersistedProviderCaptureIntegrityError("capture fleet expected identities are invalid");
  }
}
export function validatePersistedProviderFailureWriteBoundary(boundary?: PersistedProviderStepFailureWriteBoundary): void {
  if (boundary !== undefined && boundary !== "reserve" && boundary !== "create" && boundary !== "ack") {
    throw new PersistedProviderCaptureIntegrityError("capture write boundary is invalid");
  }
}
export function validateActivatePersistedProviderCaptureInput(input: ActivateTenantTelemetryPersistedProviderCaptureInput): void {
  const expected = ["expectedControlGeneration", "lifecycleControlEvidenceSha256", "logsTargetSha256", "logsTargetReceiptSha256", "configuredFleetRootSha256", "fleetStoppedAck", "legacyWritersDrainedAck", "producerReadyAck", "localOnlyAck"];
  if (Object.keys(input).sort().join("|") !== expected.sort().join("|") || input.expectedControlGeneration !== 0
    || input.fleetStoppedAck !== "fleet-stopped-v1" || input.legacyWritersDrainedAck !== "legacy-writers-drained-v1"
    || input.producerReadyAck !== "provider-step-error-v2-ready-v1" || input.localOnlyAck !== "local-only-v1"
    || [input.lifecycleControlEvidenceSha256, input.logsTargetSha256, input.logsTargetReceiptSha256, input.configuredFleetRootSha256]
      .some((v) => typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v))) {
    throw new PersistedProviderCaptureIntegrityError("capture activation acknowledgements or identities are invalid");
  }
}
/** Assigned output sequences do not turn an exact caller replay into a different business batch. */
export function persistedProviderFailureBusinessBatchSha256(batch: CommitBatch): string {
  const copy = structuredClone(batch);
  for (const item of copy.items ?? []) item.seq = 0;
  if (copy.turn) delete copy.turn.seqEnd;
  for (const event of copy.events ?? []) {
    if (event.type === "item/started" || event.type === "item/completed") event.item.seq = 0;
    if (event.type === "turn/completed") delete event.turn.seqEnd;
  }
  return persistedProviderCaptureSha256("tenant-telemetry-provider-step-business-batch-v2", copy);
}

export function captureTrustedPersistedProviderFailureInput(input: CommitPersistedProviderStepFailureInput, key: Uint8Array): CommitPersistedProviderStepFailureInput {
  const batch = input.batch;
  const source = input.source;
  const record = input.record;
  const freshProof = input.freshProof;
  const sourceSessionId = batch.sessionId;
  if (Object.keys(input).sort().join("|") !== "batch|freshProof|record|source") throw new PersistedProviderCaptureIntegrityError();
  const capturedSource = structuredClone(source);
  if (Object.keys(capturedSource).sort().join("|") !== "failureKind|itemId|stepIndex|tenantId|turnId|userId"
    || capturedSource.failureKind !== "provider_step_error" || !Number.isSafeInteger(capturedSource.stepIndex) || capturedSource.stepIndex < 1
    || typeof capturedSource.userId !== "string" || !capturedSource.userId || capturedSource.userId.length > 128) throw new PersistedProviderCaptureIntegrityError();
  for (const [kind, id] of [["session", sourceSessionId], ["turn", capturedSource.turnId], ["item", capturedSource.itemId]] as const) {
    telemetryCaptureLogsSourceRefSha256(kind, capturedSource.tenantId, id, key);
  }
  assertTrustedStructuredTelemetryRecordOwnerBinding(record, capturedSource.tenantId, "session", sourceSessionId, key);
  if (record.component !== "provider" || record.level !== "warn" || record.code !== "provider.upstream_request_failed"
    || Object.keys(record.fields).sort().join("|") !== "errorKind|ownerRef|subjectRef" || record.fields.errorKind !== "unknown") {
    throw new PersistedProviderCaptureIntegrityError("provider failure record must use the closed content-free producer contract");
  }
  validatePersistedProviderCaptureProof(freshProof);
  const captured = { batch: structuredClone(batch), source: capturedSource, record: structuredClone(record), freshProof: structuredClone(freshProof) };
  if (captured.batch.sessionId !== sourceSessionId) throw new PersistedProviderCaptureIntegrityError();
  validatePersistedProviderCaptureProof(captured.freshProof);
  assertPersistedProviderFailureWriteSet(captured.batch, captured.source);
  return captured;
}
export function assertPersistedProviderFailureWriteSet(batch: CommitBatch, source: PersistedProviderStepFailureSource): Item {
  if (!Number.isSafeInteger(batch.fence) || batch.fence < 1 || batch.lifecycle || batch.fenceClaim || batch.idempotency || batch.approvals?.length || batch.blobBindings?.length
    || !batch.turn || batch.turn.id !== source.turnId || batch.turn.sessionId !== batch.sessionId || batch.turn.status !== "inProgress") {
    throw new PersistedProviderCaptureIntegrityError("provider source requires one durable failed step, not a terminal turn");
  }
  const items = (batch.items ?? []).filter((i) => i.id === source.itemId);
  const item = items[0];
  if (items.length !== 1 || !item || item.type !== "agentMessage" || item.status !== "failed"
    || item.sessionId !== batch.sessionId || item.turnId !== source.turnId || item.step !== source.stepIndex
    || item.completedAtMs === undefined) throw new PersistedProviderCaptureIntegrityError("provider failure requires a real failed agentMessage item");
  const events = (batch.events ?? []).filter((event) => event.type === "item/completed" && event.item.id === source.itemId);
  if (events.length !== 1 || events[0]?.type !== "item/completed"
    || persistedProviderCaptureCanonicalJson(events[0].item) !== persistedProviderCaptureCanonicalJson(item)) {
    throw new PersistedProviderCaptureIntegrityError("provider failure requires the exact completed item snapshot");
  }
  const usages = (batch.usageEntries ?? []).filter((u) => u.turnId === source.turnId && u.step === source.stepIndex);
  const usageEvents = (batch.events ?? []).filter((e) => e.type === "usage/updated" && e.turnId === source.turnId && e.step === source.stepIndex);
  if (usages.length !== 1 || (batch.usageEntries?.length ?? 0) !== 1 || usageEvents.length !== 1
    || usageEvents[0]?.type !== "usage/updated"
    || persistedProviderCaptureCanonicalJson(usageEvents[0].stepUsage) !== persistedProviderCaptureCanonicalJson(usages[0]!.usage)) {
    throw new PersistedProviderCaptureIntegrityError("provider failure requires one exact accounted step");
  }
  return item;
}
export function persistedProviderCaptureProofFromReceipt(receipt: TenantTelemetryPersistedProviderCaptureActivationReceipt): TenantTelemetryPersistedProviderCaptureProof {
  return { protocol: PERSISTED_PROVIDER_CAPTURE_FLEET_PROTOCOL, configuredFleetRootSha256: receipt.configuredFleetRootSha256,
    captureControlEvidenceSha256: receipt.receiptSha256, refKeyIdSha256: receipt.refKeyIdSha256,
    logsTargetSha256: receipt.logsTargetSha256, logsTargetReceiptSha256: receipt.logsTargetReceiptSha256,
    runtimeEpochSha256: receipt.runtimeEpochSha256, runtimeBindingSha256: receipt.runtimeBindingSha256 };
}
export function assertPersistedProviderCaptureExpectedProof(actual: TenantTelemetryPersistedProviderCaptureProof, expected: TenantTelemetryPersistedProviderCaptureProof): void {
  validatePersistedProviderCaptureProof(expected);
  if (persistedProviderCaptureCanonicalJson(actual) !== persistedProviderCaptureCanonicalJson(expected)) throw new PersistedProviderCaptureConflictError("configured fleet capture identity changed");
}
export function persistedProviderCaptureEventRoot(events: readonly PersistedEvent[]): string {
  return persistedProviderCaptureSha256("tenant-telemetry-provider-step-events-v2", events);
}
export function noPersistedProviderFailureSource(): PersistedProviderStepFailureSourceVerification {
  return { status: "not_found", sourceCount: 0, failureCommitReceiptSha256: null, sourceBindingReceiptSha256: null,
    writeOperationSha256: null, membershipSha256: null, writeAckReceiptSha256: null, inventoryReceiptSha256: null,
    executionReady: false, allDomainsComplete: false };
}
export function createPersistedProviderCaptureCoverage(lifecycle: TenantTelemetryLifecycleCoverageRecord, atMs: number, existingTenant: boolean): TenantTelemetryPersistedProviderCaptureCoverage {
  const body: Omit<TenantTelemetryPersistedProviderCaptureCoverage, "evidenceSha256"> = {
    scope: "tenant-telemetry-capture-coverage-v2", tenantId: lifecycle.tenantId, domain: "logs", controlGeneration: 1,
    captureStatus: existingTenant ? "capture_since_cutover" : "capture_since_tenant_creation",
    preCutoverHistoryStatus: existingTenant ? "pre_cutover_history_unknown" : "pre_cutover_not_applicable",
    lifecycleCoverageEvidenceSha256: lifecycle.evidenceSha256, subjectRefSha256: lifecycle.subjectRefSha256,
    producerContractSha256: PERSISTED_PROVIDER_CAPTURE_CONTRACT_SHA256, coverageStartedAtDbMs: atMs,
  };
  return { ...body, evidenceSha256: persistedProviderCaptureCoverageSha256(body) };
}
export function createPersistedProviderCaptureActivationReceipt(input: ActivateTenantTelemetryPersistedProviderCaptureInput, source: TenantTelemetryPersistedProviderCapturePrerequisites & {
  refKeyIdSha256: string; coverages: TenantTelemetryPersistedProviderCaptureCoverage[];
  preCutoverFailures: unknown[]; preCutoverWrites: string[]; atMs: number;
}): TenantTelemetryPersistedProviderCaptureActivationReceipt {
  const body: Omit<TenantTelemetryPersistedProviderCaptureActivationReceipt, "receiptSha256"> = {
    ...input, scope: "tenant-telemetry-capture-activation-receipt-v2", protocol: PERSISTED_PROVIDER_CAPTURE_PROTOCOL, domain: "logs",
    requestSha256: persistedProviderCaptureSha256("tenant-telemetry-capture-activation-request-v2", input),
    producerContractSha256: PERSISTED_PROVIDER_CAPTURE_CONTRACT_SHA256, refKeyIdSha256: source.refKeyIdSha256,
    runtimeEpochSha256: source.runtimeEpochSha256, runtimeBindingSha256: source.runtimeBindingSha256,
    runtimeControlEvidenceSha256: source.runtimeControlEvidenceSha256, runtimeControlGeneration: source.runtimeControlGeneration,
    journalControlEvidenceSha256: source.journalControlEvidenceSha256, journalTargetRootSha256: source.journalTargetRootSha256,
    journalHeadRootSha256: source.journalHeadRootSha256,
    coverageCount: source.coverages.length, coverageRootSha256: persistedProviderCaptureSha256("tenant-telemetry-capture-coverage-root-v2", source.coverages),
    preCutoverFailureCount: source.preCutoverFailures.length, preCutoverFailureRootSha256: persistedProviderCaptureSha256("tenant-telemetry-capture-legacy-failures-v2", source.preCutoverFailures),
    preCutoverWriteCount: source.preCutoverWrites.length, preCutoverWriteRootSha256: persistedProviderCaptureSha256("tenant-telemetry-capture-legacy-writes-v2", [...source.preCutoverWrites].sort()),
    activatedAtDbMs: source.atMs,
  };
  // expectedControlGeneration is an input CAS, not part of the durable receipt wire family.
  delete (body as unknown as { expectedControlGeneration?: number }).expectedControlGeneration;
  return { ...body, receiptSha256: persistedProviderCaptureReceiptSha256(body) };
}
export function persistedProviderFailureArtifactSha256(source: PersistedProviderStepFailureSource, sessionId: string, proof: TenantTelemetryPersistedProviderCaptureProof, key: Uint8Array): string {
  return persistedProviderCaptureSha256("tenant-telemetry-provider-step-artifact-v2", {
    control: proof.captureControlEvidenceSha256, epoch: proof.runtimeEpochSha256,
    session: telemetryCaptureLogsSourceRefSha256("session", source.tenantId, sessionId, key),
    turn: telemetryCaptureLogsSourceRefSha256("turn", source.tenantId, source.turnId, key),
    item: telemetryCaptureLogsSourceRefSha256("item", source.tenantId, source.itemId, key), step: source.stepIndex,
  });
}
export function createPersistedProviderFailureWriteSet(args: {
  input: CommitPersistedProviderStepFailureInput; key: Uint8Array; beginLastSeq: number; events: PersistedEvent[];
  coverage: TenantTelemetryPersistedProviderCaptureCoverage; inventory: TenantTelemetryArtifactInventoryRecord;
  target: TenantTelemetryLifecycleTargetRecord; operationSha256: string; billingRootSha256: string;
}): { job: Writer.TenantTelemetryWriteJobRecord; payload: Writer.TenantTelemetryWritePayloadRecord;
  membership: Membership.TenantTelemetryArtifactMembershipRecord; binding: TenantTelemetryPersistedProviderCaptureSourceBinding; receipt: PersistedProviderStepFailureCommitReceipt } {
  const { input, key, inventory, target, operationSha256 } = args;
  const payload = Writer.canonicalizeTenantTelemetryArtifactPayload({ schema: Writer.TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA, domain: "logs", records: [input.record] });
  const at = inventory.createdAtDbMs;
  const count = payload.records.length;
  const bytes = Buffer.byteLength(Writer.tenantTelemetryArtifactPayloadCanonicalJson(payload));
  const job: Writer.TenantTelemetryWriteJobRecord = { writeOperationSha256: operationSha256, tenantId: input.source.tenantId,
    protocol: Writer.TENANT_TELEMETRY_WRITE_PROTOCOL, phase: "queued", target, inventory, recordCount: count,
    payloadByteLength: bytes, attempts: 0, availableAtMs: at, createdAtMs: at, updatedAtMs: at };
  const payloadRecord: Writer.TenantTelemetryWritePayloadRecord = { writeOperationSha256: operationSha256, tenantId: input.source.tenantId,
    payload, payloadSha256: inventory.payloadSha256, recordCount: count, payloadByteLength: bytes, createdAtMs: at };
  const membership = Membership.createTenantTelemetryArtifactMembership({ writeOperationSha256: operationSha256, inventory,
    ownerId: input.batch.sessionId, ownerUserId: input.source.userId, refKey: key, applicationBinding: null });
  const sourceEvent = args.events.find((e) => e.type === "item/completed" && e.item.id === input.source.itemId);
  if (!sourceEvent) throw new PersistedProviderCaptureIntegrityError();
  const bindingBody: Omit<TenantTelemetryPersistedProviderCaptureSourceBinding, "receiptSha256"> = {
    scope: "tenant-telemetry-capture-source-binding-v2", tenantId: input.source.tenantId, domain: "logs", controlGeneration: 1,
    writeOperationSha256: operationSha256, coverageEvidenceSha256: args.coverage.evidenceSha256,
    producerContractSha256: PERSISTED_PROVIDER_CAPTURE_CONTRACT_SHA256,
    sourceSessionRefSha256: telemetryCaptureLogsSourceRefSha256("session", input.source.tenantId, input.batch.sessionId, key),
    sourceTurnRefSha256: telemetryCaptureLogsSourceRefSha256("turn", input.source.tenantId, input.source.turnId, key),
    sourceItemRefSha256: telemetryCaptureLogsSourceRefSha256("item", input.source.tenantId, input.source.itemId, key),
    sourceStepIndex: input.source.stepIndex, sourceEventSeq: sourceEvent.seq, ownerRefSha256: inventory.ownerRefSha256,
    payloadSha256: inventory.payloadSha256, boundAtDbMs: at,
  };
  const binding = { ...bindingBody, receiptSha256: persistedProviderCaptureReceiptSha256(bindingBody) };
  const receiptBody: Omit<PersistedProviderStepFailureCommitReceipt, "receiptSha256"> = {
    scope: "tenant-telemetry-provider-step-failure-commit-receipt-v2", tenantId: input.source.tenantId,
    sourceSessionRefSha256: binding.sourceSessionRefSha256, sourceTurnRefSha256: binding.sourceTurnRefSha256,
    sourceItemRefSha256: binding.sourceItemRefSha256, sourceStepIndex: binding.sourceStepIndex, sourceEventSeq: binding.sourceEventSeq,
    fenceToken: input.batch.fence, beginLastSeq: args.beginLastSeq, endLastSeq: args.events.at(-1)!.seq, eventCount: args.events.length,
    eventRootSha256: persistedProviderCaptureEventRoot(args.events), businessBatchSha256: persistedProviderFailureBusinessBatchSha256(input.batch),
    billingRootSha256: args.billingRootSha256, usageIdSha256: persistedProviderCaptureSha256("tenant-telemetry-step-usage-id-v2", input.batch.usageEntries![0]!.usageId),
    captureControlEvidenceSha256: input.freshProof.captureControlEvidenceSha256, runtimeEpochSha256: input.freshProof.runtimeEpochSha256,
    runtimeBindingSha256: input.freshProof.runtimeBindingSha256, writeOperationSha256: operationSha256,
    bindingReceiptSha256: binding.receiptSha256, membershipSha256: membership.membershipSha256,
    payloadSha256: inventory.payloadSha256, committedAtDbMs: at,
  };
  const receipt = { ...receiptBody, receiptSha256: persistedProviderCaptureReceiptSha256(receiptBody) };
  validatePersistedProviderCaptureSourceBinding(binding); validatePersistedProviderFailureCommitReceipt(receipt);
  Writer.validateTenantTelemetryWriteJobRecord(job); Writer.validateTenantTelemetryWritePayloadRecord(payloadRecord);
  return { job, payload: payloadRecord, membership, binding, receipt };
}
