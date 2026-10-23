import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { tenantTelemetryRefKeyIdSha256 } from "../src/tenant-telemetry-lifecycle.js";
import * as codec from "../src/tenant-telemetry-capture-restore.js";
import { validatePreflightTenantRestoreReplayFromBackupInput } from "../src/backup-catalog.js";
import { readTenantTelemetryCaptureCheckpointFromMysql } from "../src/mysql/tenant-telemetry-capture-checkpoint.js";
import type { Connection, PoolConnection } from "mysql2/promise";
import { MysqlSessionStore } from "../src/mysql/store.js";
import * as RestoreJournal from "../src/tenant-restore-journal.js";
import * as BackupCatalog from "../src/backup-catalog.js";
import { validateTenantTelemetryCaptureRestoreMaintenanceSelector,
  type TenantTelemetryCaptureBackupCheckpointRecord,
  type TenantTelemetryCaptureRestoreMaintenanceSelector } from "../src/tenant-telemetry-capture-restore-store.js";

// Pure, synthetic codec fixtures. None proves a database row, an actual backup,
// a current source-valid operation, a physical object or an operator ACK.
const key = Buffer.alloc(32, 0x51);
const wrongKey = Buffer.alloc(32, 0x52);
const h = (label: string): string => createHash("sha256").update(`capture-restore-pure-fixture\0${label}`).digest("hex");
const backupId = "backup_00000000-0000-4000-8000-000000000001";
const runId = "restore_00000000-0000-4000-8000-000000000002";
const otherRunId = "restore_00000000-0000-4000-8000-000000000003";
const operation = h("operation");
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function change<T>(value: T, fields: Record<string, unknown>): T { return { ...clone(value), ...fields } as T; }
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, child]) => `${JSON.stringify(name)}:${canonical(child)}`).join(",")}}`;
}
const proofHash = (scope: string, value: unknown) => createHash("sha256").update(scope).update("\0").update(canonical(value)).digest("hex");
function reseal<T extends { scope: string }>(value: T, fields: Record<string, unknown>, field = "receiptSha256"): T {
  const body = { ...clone(value), ...fields } as Record<string, unknown>; delete body[field];
  return { ...body, [field]: createHash("sha256").update(value.scope).update("\0").update(canonical(body)).digest("hex") } as T;
}
function leaf(family: codec.TenantTelemetryCaptureCheckpointFamily,
  state: codec.TenantTelemetryCaptureCheckpointState = "record", identity = "row",
  knowledge: codec.TenantTelemetryCaptureCheckpointKnowledge = "validated_projection"): codec.TenantTelemetryCaptureCheckpointLeaf {
  return { family, state, knowledge, sourceHighWaterDbMs: 950,
    identityRefSha256: codec.tenantTelemetryCaptureCheckpointOpaqueDigest(family, "identity", Buffer.from(identity), key),
    recordHmacSha256: codec.tenantTelemetryCaptureCheckpointOpaqueDigest(family, "record", Buffer.from(`validated-${identity}`), key) };
}
function operationLeaf(family: codec.TenantTelemetryCaptureCheckpointFamily,
  state: codec.TenantTelemetryCaptureCheckpointState): codec.TenantTelemetryCaptureCheckpointLeaf {
  return { ...leaf(family, state, `${family}-body`),
    identityRefSha256: codec.tenantTelemetryCaptureCheckpointOperationIdentity(family, operation, key) };
}
function header(): codec.TenantTelemetryCaptureBackupCheckpointHeader {
  return { backupId, anchorSha256: h("anchor"), anchorCreatedAtDbMs: 900, controlHighWaterDbMs: 925,
    logicalDatabaseNamespaceSha256: h("database"), schemaMigrationRootSha256: h("schema"), sourceRuntimeLineageKind: "primary",
    sourceRuntimeEpochSha256: h("primary-epoch"), sourceRuntimeBindingSha256: h("primary-static-binding"),
    sourceRuntimeControlEvidenceSha256: h("primary-runtime-control"), sourceRuntimeControlGeneration: 1,
    sourceHistoryReceiptSha256: null, sourceCaptureCutoverReceiptSha256: null,
    originalRuntimeEpochSha256: h("primary-epoch"), originalRuntimeBindingSha256: h("primary-static-binding"),
    originalCaptureActivationReceiptSha256: h("original-capture-activation"), refKeyIdSha256: tenantTelemetryRefKeyIdSha256(key),
    lifecycleControlEvidenceSha256: h("lifecycle-control"), captureControlEvidenceSha256: h("capture-control"),
    logsTargetSha256: h("logs-target"), logsTargetReceiptSha256: h("logs-target-receipt"), journalControlEvidenceSha256: h("journal-control"),
    journalTargetRootSha256: h("journal-target-root"), journalHeadRootSha256: h("journal-head"), catalogControlEvidenceSha256: h("catalog-control"),
    catalogHeadSequence: 0, catalogHeadRootSha256: h("catalog-head"), blobStorageControlEvidenceSha256: h("blob-control"), sealedAtDbMs: 1_000 };
}
interface FixtureOptions { jobState?: "queued" | "reserved" | "written" | "blocked"; jobUnknown?: boolean;
  unknownFamily?: codec.TenantTelemetryCaptureCheckpointFamily; omitPayload?: boolean; ack?: boolean }
function fixture(options: FixtureOptions = {}) {
  const state = options.jobState ?? "queued";
  const leaves = [operationLeaf("write_job", state), operationLeaf("membership", "record"),
    operationLeaf("provider_source_binding", "record"), operationLeaf("provider_failure_commit", "record"),
    leaf("legacy_failure", "legacy_unknown", "unrelated-legacy-gap", "legacy_unknown")];
  if (!options.omitPayload) leaves.push(operationLeaf("write_payload", "spooled"));
  if (state === "reserved") leaves.push(operationLeaf("write_reservation", "reserved"));
  if (options.ack) leaves.push(operationLeaf("write_ack", "record"));
  if (options.jobUnknown) leaves[0] = { ...leaves[0]!, knowledge: "legacy_unknown" };
  for (const row of leaves) if (row.family === options.unknownFamily) row.knowledge = "legacy_unknown";
  const checkpoint = codec.createTenantTelemetryCaptureBackupCheckpoint(header(), leaves, key);
  const binding: codec.TenantTelemetryCaptureRestoreActivationBinding = { backupId, anchorSha256: checkpoint.anchorSha256,
    checkpointSha256: checkpoint.checkpointSha256, artifactManifestSha256: h("actual-artifact-manifest"),
    sourceSnapshotSha256: h("actual-sql-snapshot"), providerEvidenceSha256: h("actual-artifact-provider-evidence"),
    sourceBindingSha256: h("0031-source-binding"), reservationSha256: h("0031-reservation"), reservationReceiptSha256: h("0031-reservation-receipt"),
    restoreRunId: runId, runtimeEpochSha256: h("new-runtime-epoch"), runtimeBindingSha256: h("new-runtime-binding"),
    runtimeControlEvidenceSha256: h("new-runtime-control"), runtimeControlGeneration: 2,
    replayReceiptSha256: h("0030-replay-receipt"), sealedJournalHeadRootSha256: h("fresh-sealed-journal-head"), activatedAtDbMs: 1_100 };
  const history = codec.createTenantTelemetryCaptureRestoreHistoryReceipt(binding, checkpoint, key);
  const cutoverInput: codec.TenantTelemetryCaptureEpochCutoverInput = {
    originalRuntimeEpochSha256: history.originalRuntimeEpochSha256, originalRuntimeBindingSha256: history.originalRuntimeBindingSha256,
    originalCaptureActivationReceiptSha256: history.originalCaptureActivationReceiptSha256, refKeyIdSha256: history.refKeyIdSha256,
    lifecycleControlEvidenceSha256: history.lifecycleControlEvidenceSha256, captureControlEvidenceSha256: history.captureControlEvidenceSha256,
    logsTargetSha256: history.logsTargetSha256, logsTargetReceiptSha256: history.logsTargetReceiptSha256, historyReceiptSha256: history.receiptSha256,
    restoreRunId: runId, runtimeEpochSha256: history.runtimeEpochSha256, runtimeBindingSha256: history.runtimeBindingSha256,
    runtimeControlEvidenceSha256: history.runtimeControlEvidenceSha256, runtimeControlGeneration: history.runtimeControlGeneration,
    configuredFleetRootSha256: h("fresh-fleet-root"), activatedAtDbMs: 1_200, fleetStoppedAck: "fleet-stopped-v1",
    legacyWritersDrainedAck: "legacy-writers-drained-v1", producerReadyAck: "provider-step-error-v2-ready-v1", localOnlyAck: "local-only-v1" };
  const cutover = codec.createTenantTelemetryCaptureEpochCutoverReceipt(cutoverInput, history, checkpoint, key);
  const evidence = (family: codec.TenantTelemetryCaptureCheckpointFamily) => leaves.find((row) => row.family === family)?.recordHmacSha256 ?? h(`absent-${family}`);
  const recoveryInput: codec.TenantTelemetryCaptureOperationRecoveryInput = {
    cutoverReceiptSha256: cutover.receiptSha256, historyReceiptSha256: history.receiptSha256, checkpointSha256: checkpoint.checkpointSha256,
    restoreRunId: runId, runtimeEpochSha256: history.runtimeEpochSha256, writeOperationSha256: operation,
    tenantRefSha256: h("tenant-ref"), ownerRefSha256: h("owner-ref"), sourceSessionRefSha256: h("session-ref"),
    sourceTurnRefSha256: h("turn-ref"), sourceItemRefSha256: h("item-ref"), sourceStepIndex: 1,
    inventorySha256: h("original-inventory"), payloadSha256: h("original-payload"), manifestSha256: h("original-manifest"),
    membershipSha256: h("original-membership"), sourceBindingReceiptSha256: h("original-source-binding"), failureCommitReceiptSha256: h("original-failure"),
    originalJobState: state === "reserved" ? "reserved" : "queued", originalJobEvidenceHmacSha256: evidence("write_job"),
    originalJobDescriptorSha256: h("original-job-descriptor"),
    originalPayloadEvidenceHmacSha256: evidence("write_payload"), originalMembershipEvidenceHmacSha256: evidence("membership"),
    originalSourceBindingEvidenceHmacSha256: evidence("provider_source_binding"), originalFailureEvidenceHmacSha256: evidence("provider_failure_commit"),
    originalReservationReceiptSha256: state === "reserved" ? h("original-reservation-receipt") : null,
    originalReservationEvidenceHmacSha256: state === "reserved" ? evidence("write_reservation") : null,
    originalReservationClaimAttempt: state === "reserved" ? 2 : null, originalReservationClaimTokenSha256: state === "reserved" ? h("reservation-old-token") : null,
    previousClaimAttempt: 3, previousClaimTokenSha256: h("previous-claim-token"), previousClaimLeaseUntilMs: 1_300,
    newClaimAttempt: 4, newClaimTokenSha256: h("new-claim-token"), newClaimLeaseUntilMs: 2_400, claimLeaseCeilingMs: 2_400,
    previousPermitReceiptSha256: null,
    reservationAtIssue: state === "reserved" ? { origin: "checkpoint", receiptSha256: h("original-reservation-receipt"),
      startedAtDbMs: 1_000, startedClaimAttempt: 2, startedClaimTokenSha256: h("reservation-old-token") } : { origin: "none" },
    issuedAtDbMs: 1_400,
    recoveryMode: state === "reserved" ? "resume_reserved" : "resume_queued" };
  const context = { key, checkpoint, history, cutover, originalLeaves: leaves, activationBinding: binding,
    recoveryBinding: { input: recoveryInput, claimLeaseUntilMs: recoveryInput.newClaimLeaseUntilMs, storeDbTimestampMs: 1_500 } };
  return { leaves, checkpoint, binding, history, cutoverInput, cutover, recoveryInput, context };
}
const rejected = (work: () => unknown) => expect(work).toThrow(codec.TenantTelemetryCaptureRestoreIntegrityError);
const createPermit = (f: ReturnType<typeof fixture>, input = f.recoveryInput) =>
  codec.createTenantTelemetryCaptureOperationRecoveryPermit(input, f.cutover, f.history, f.checkpoint, f.leaves, key);

/** Synthetic full-backup inclusion, not database ancestry or a physical dump. */
function repeatFixture(options: { wrongAncestorBinding?: boolean } = {}) {
  const first = fixture();
  const p1 = createPermit(first);
  const recordLeaf = (family: codec.TenantTelemetryCaptureLineageFamily, label: string): codec.TenantTelemetryCaptureLineageLeaf => ({
    family, identityRefSha256: codec.tenantTelemetryCaptureLineageOpaqueDigest(family, "identity", Buffer.from(label), key),
    recordHmacSha256: codec.tenantTelemetryCaptureLineageOpaqueDigest(family, "record", Buffer.from(`synthetic-${label}`), key), sourceHighWaterDbMs: 1_400,
  });
  const cpLeaf = recordLeaf("checkpoint", "first-cp"), historyLeaf = recordLeaf("restore_history", "first-history"),
    cutoverLeaf = recordLeaf("epoch_cutover", "first-cutover"), bindingLeaf = recordLeaf("restore_binding", "first-binding"),
    eventLeaf = recordLeaf("runtime_event", "first-activation"), permitLeaf = { ...recordLeaf("recovery_permit", "first-permit"),
      identityRefSha256: codec.tenantTelemetryCaptureLineagePermitIdentitySha256(p1.receiptSha256, key) };
  const lineageLeaves = [cpLeaf, historyLeaf, cutoverLeaf, bindingLeaf, eventLeaf, permitLeaf];
  const sourceBinding = options.wrongAncestorBinding ? h("self-consistent-wrong-ancestor-binding") : first.history.runtimeBindingSha256;
  const ancestor: codec.TenantTelemetryCaptureLineageAncestor = { restoreRunId: runId, checkpointSha256: first.checkpoint.checkpointSha256,
    historyReceiptSha256: first.history.receiptSha256, cutoverReceiptSha256: first.cutover.receiptSha256,
    runtimeEpochSha256: first.history.runtimeEpochSha256, runtimeBindingSha256: sourceBinding, runtimeControlGeneration: 2,
    checkpointIdentityRefSha256: cpLeaf.identityRefSha256, checkpointRecordHmacSha256: cpLeaf.recordHmacSha256,
    historyIdentityRefSha256: historyLeaf.identityRefSha256, historyRecordHmacSha256: historyLeaf.recordHmacSha256,
    cutoverIdentityRefSha256: cutoverLeaf.identityRefSha256, cutoverRecordHmacSha256: cutoverLeaf.recordHmacSha256,
    restoreBindingIdentityRefSha256: bindingLeaf.identityRefSha256, restoreBindingRecordHmacSha256: bindingLeaf.recordHmacSha256,
    runtimeEventIdentityRefSha256: eventLeaf.identityRefSha256, runtimeEventRecordHmacSha256: eventLeaf.recordHmacSha256 };
  const backup2 = "backup_00000000-0000-4000-8000-000000000004";
  const snapshotJob = { ...first.leaves.find((row) => row.family === "write_job")!, state: "reserved" as const, recordHmacSha256: h("snapshot-reserved-job") };
  const reservationLeaf = operationLeaf("write_reservation", "reserved");
  const leaves = [...first.leaves.filter((row) => row.family !== "write_job"), snapshotJob, reservationLeaf];
  const lineage = codec.createTenantTelemetryCaptureLineageCapsule({ backupId: backup2, anchorSha256: h("second-anchor"),
    refKeyIdSha256: first.checkpoint.refKeyIdSha256, sourceRestoreRunId: runId, sourceCheckpointSha256: first.checkpoint.checkpointSha256,
    sourceHistoryReceiptSha256: first.history.receiptSha256, sourceCaptureCutoverReceiptSha256: first.cutover.receiptSha256,
    sourceRuntimeEpochSha256: first.history.runtimeEpochSha256, sourceRuntimeBindingSha256: sourceBinding,
    sourceRuntimeControlEvidenceSha256: first.history.runtimeControlEvidenceSha256, sourceRuntimeControlGeneration: 2,
    sealedAtDbMs: 2_700 }, lineageLeaves, [ancestor], key);
  const cp2 = codec.createTenantTelemetryCaptureBackupCheckpointV2({ ...header(), backupId: backup2, anchorSha256: h("second-anchor"),
    anchorCreatedAtDbMs: 2_500, controlHighWaterDbMs: 2_600, sourceRuntimeLineageKind: "restore",
    sourceRuntimeEpochSha256: first.history.runtimeEpochSha256, sourceRuntimeBindingSha256: sourceBinding,
    sourceRuntimeControlEvidenceSha256: first.history.runtimeControlEvidenceSha256, sourceRuntimeControlGeneration: 2,
    sourceHistoryReceiptSha256: first.history.receiptSha256, sourceCaptureCutoverReceiptSha256: first.cutover.receiptSha256, sealedAtDbMs: 2_700 },
  leaves, lineage, lineageLeaves, key);
  const activation = { ...first.binding, backupId: backup2, anchorSha256: cp2.anchorSha256, checkpointSha256: cp2.checkpointSha256,
    restoreRunId: otherRunId, runtimeEpochSha256: h("second-epoch"), runtimeBindingSha256: h("second-binding"),
    runtimeControlEvidenceSha256: h("second-control"), runtimeControlGeneration: 3, activatedAtDbMs: 3_000 };
  const history = codec.createTenantTelemetryCaptureRestoreHistoryReceipt(activation, cp2, key);
  const cutover = codec.createTenantTelemetryCaptureEpochCutoverReceipt({ ...first.cutoverInput, historyReceiptSha256: history.receiptSha256,
    restoreRunId: otherRunId, runtimeEpochSha256: history.runtimeEpochSha256, runtimeBindingSha256: history.runtimeBindingSha256,
    runtimeControlEvidenceSha256: history.runtimeControlEvidenceSha256, runtimeControlGeneration: 3, activatedAtDbMs: 3_100 }, history, cp2, key);
  const input: codec.TenantTelemetryCaptureOperationRecoveryInputV2 = { ...first.recoveryInput,
    cutoverReceiptSha256: cutover.receiptSha256, historyReceiptSha256: history.receiptSha256, checkpointSha256: cp2.checkpointSha256,
    restoreRunId: otherRunId, runtimeEpochSha256: history.runtimeEpochSha256, previousClaimAttempt: p1.newClaimAttempt,
    previousClaimTokenSha256: p1.newClaimTokenSha256, previousClaimLeaseUntilMs: p1.newClaimLeaseUntilMs,
    newClaimAttempt: p1.newClaimAttempt + 1, newClaimTokenSha256: h("second-claim"), newClaimLeaseUntilMs: 4_000, claimLeaseCeilingMs: 4_000,
    issuedAtDbMs: 3_300, previousPermitReceiptSha256: p1.receiptSha256, recoveryMode: "resume_reserved",
    reservationAtIssue: { origin: "recovery-permit", receiptSha256: h("first-permit-reservation"), startedAtDbMs: 1_600,
      startedClaimAttempt: p1.newClaimAttempt, startedClaimTokenSha256: p1.newClaimTokenSha256, authorizingPermitReceiptSha256: p1.receiptSha256 },
    genesisCheckpointSha256: first.checkpoint.checkpointSha256, snapshotJobState: "reserved", snapshotJobEvidenceHmacSha256: snapshotJob.recordHmacSha256,
    snapshotReservationReceiptSha256: h("first-permit-reservation"), snapshotReservationEvidenceHmacSha256: reservationLeaf.recordHmacSha256,
    predecessorLineageEvidenceHmacSha256: permitLeaf.recordHmacSha256, reservationAuthorizerLineageEvidenceHmacSha256: permitLeaf.recordHmacSha256 };
  const context: codec.TenantTelemetryCaptureRecoveryContext = { checkpoint: cp2, leaves, lineageLeaves, history, cutover };
  const ancestors: codec.TenantTelemetryCaptureRecoveryChainRecord[] = [{ permit: p1,
    context: { checkpoint: first.checkpoint, leaves: first.leaves, history: first.history, cutover: first.cutover } }];
  return { first, p1, leaves, lineage, lineageLeaves, ancestor, cp2, history, cutover, input, context, ancestors };
}

describe("versioned repeat-capture backup and cross-checkpoint recovery codec", () => {
  it("keeps the published 49 families separate from the complete 27 physical lineage tables", () => {
    expect(codec.TENANT_TELEMETRY_CAPTURE_CHECKPOINT_FAMILIES).toHaveLength(49);
    expect(codec.TENANT_TELEMETRY_CAPTURE_LINEAGE_SQL).toHaveLength(27);
    expect(new Set(codec.TENANT_TELEMETRY_CAPTURE_LINEAGE_SQL.map((row) => row.table)).size).toBe(27);
    expect(codec.TENANT_TELEMETRY_CAPTURE_LINEAGE_SQL.filter((row) => row.excludeSelectedBackup).map((row) => row.family))
      .toEqual(["checkpoint", "checkpoint_leaf", "checkpoint_lineage_leaf"]);
  });
  it("binds the full second snapshot plus immutable ancestor inclusions without rewriting CP1 or P1", () => {
    const f = repeatFixture(); const before = JSON.stringify([f.first.checkpoint, f.p1]);
    const result = codec.createTenantTelemetryCaptureOperationRecoveryPermitV2(f.input, f.context, key, f.ancestors);
    expect(result).toMatchObject({ previousPermitReceiptSha256: f.p1.receiptSha256, genesisCheckpointSha256: f.first.checkpoint.checkpointSha256,
      originalJobState: "queued", snapshotJobState: "reserved", newReservationAuthorized: false, newExternalCreateAuthorized: true });
    expect(f.cp2.lineage.families).toHaveLength(27);
    expect(JSON.stringify([f.first.checkpoint, f.p1])).toBe(before);
    codec.assertTenantTelemetryCaptureLineageLeaves(f.lineage, [...f.lineageLeaves].reverse(), key);
  });
  it("does not accept a self-resealed wrong ancestor static binding", () => {
    const f = repeatFixture({ wrongAncestorBinding: true });
    rejected(() => codec.createTenantTelemetryCaptureOperationRecoveryPermitV2(f.input, f.context, key, f.ancestors));
  });
  it.each(["genesisCheckpointSha256", "snapshotJobEvidenceHmacSha256", "snapshotReservationEvidenceHmacSha256",
    "predecessorLineageEvidenceHmacSha256", "reservationAuthorizerLineageEvidenceHmacSha256"] as const)("rejects independently replaced %s even after resealing", (field) => {
    const f = repeatFixture(); rejected(() => codec.createTenantTelemetryCaptureOperationRecoveryPermitV2({ ...f.input, [field]: h("replacement") }, f.context, key, f.ancestors));
  });
  it("does not reset a cross-generation predecessor to a new genesis", () => {
    const f = repeatFixture(); rejected(() => codec.createTenantTelemetryCaptureOperationRecoveryPermitV2({ ...f.input,
      previousPermitReceiptSha256: null, predecessorLineageEvidenceHmacSha256: null }, f.context, key, f.ancestors));
  });
  it("requires both immutable history and actual permit inclusion, not only a supplied ancestor array", () => {
    const f = repeatFixture();
    rejected(() => codec.assertTenantTelemetryCaptureLineageLeaves(f.lineage, f.lineageLeaves.filter((row) => row.family !== "restore_history"), key));
    rejected(() => codec.validateTenantTelemetryCaptureOperationRecoveryPermitV2(
      codec.createTenantTelemetryCaptureOperationRecoveryPermitV2(f.input, f.context, key, f.ancestors),
      { ...f.context, lineageLeaves: f.lineageLeaves.filter((row) => row.family !== "recovery_permit") }, key, f.ancestors));
  });
  it("rejects duplicate raw identities and explicit missing-empty summaries", () => {
    const f = repeatFixture();
    rejected(() => codec.assertTenantTelemetryCaptureLineageLeaves(f.lineage, [...f.lineageLeaves, f.lineageLeaves[0]!], key));
    rejected(() => codec.validateTenantTelemetryCaptureLineageCapsule(reseal(f.lineage,
      { families: f.lineage.families.slice(1) }, "capsuleSha256"), key));
  });
});

describe("actual MySQL checkpoint reader boundary (pure driver doubles, not DB proof)", () => {
  const normalizeSql = (sql: string) => sql.replace(/\s+/g, " ").trim();
  const readerSql = {
    header: "SELECT backup_id,anchor_sha256,checkpoint_sha256,ref_key_id_sha256,sealed_at_db_ms,checkpoint_json FROM tenant_telemetry_capture_backup_checkpoints WHERE BINARY backup_id=BINARY ?",
    leaves: `SELECT backup_id,family,identity_ref_sha256,record_hmac_sha256,knowledge,state,source_high_water_db_ms FROM tenant_telemetry_capture_backup_checkpoint_leaves WHERE BINARY backup_id=BINARY ? ORDER BY family,identity_ref_sha256 LIMIT ${codec.TENANT_TELEMETRY_CAPTURE_RESTORE_MAX_LEAVES + 1}`,
    lineageTable: "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=DATABASE() AND BINARY table_name=BINARY 'tenant_telemetry_capture_checkpoint_lineage_leaves' AND table_type='BASE TABLE'",
    lineage: `SELECT backup_id,family,identity_ref_sha256,record_hmac_sha256,source_high_water_db_ms FROM tenant_telemetry_capture_checkpoint_lineage_leaves WHERE BINARY backup_id=BINARY ? ORDER BY family,identity_ref_sha256 LIMIT ${codec.TENANT_TELEMETRY_CAPTURE_RESTORE_MAX_LEAVES + 1}`,
  };
  function source(lineageInstalled = false) {
    const f = fixture();
    const header = { backup_id: backupId, anchor_sha256: f.checkpoint.anchorSha256,
      checkpoint_sha256: f.checkpoint.checkpointSha256, ref_key_id_sha256: f.checkpoint.refKeyIdSha256,
      sealed_at_db_ms: f.checkpoint.sealedAtDbMs, checkpoint_json: f.checkpoint };
    const rows = f.leaves.map((row) => ({ backup_id: backupId, family: row.family,
      identity_ref_sha256: row.identityRefSha256, record_hmac_sha256: row.recordHmacSha256,
      knowledge: row.knowledge, state: row.state, source_high_water_db_ms: row.sourceHighWaterDbMs }));
    const calls: { sql: string; parameters: unknown[] | undefined }[] = [];
    let headers: unknown[] = [header], leaves: unknown[] = rows, lineageRows: unknown[] = [];
    const executor = { async query(sql: string, parameters?: unknown[]) {
      const normalized = normalizeSql(sql);
      calls.push({ sql: normalized, parameters });
      if (normalized === readerSql.header) return [headers, []];
      if (normalized === readerSql.leaves) return [leaves, []];
      if (normalized === readerSql.lineageTable) return [[{ n: lineageInstalled ? 1 : 0 }], []];
      if (normalized === readerSql.lineage && lineageInstalled) return [lineageRows, []];
      throw new Error("unexpected checkpoint reader fixture SQL");
    } } as unknown as Connection;
    return { ...f, header, rows, executor, calls,
      setHeaders: (value: unknown[]) => { headers = value; },
      setLeaves: (value: unknown[]) => { leaves = value; },
      setLineageRows: (value: unknown[]) => { lineageRows = value; } };
  }
  it("reads every persisted leaf from the supplied connection and returns an isolated snapshot", async () => {
    const f = source();
    const result = await readTenantTelemetryCaptureCheckpointFromMysql(f.executor, backupId, key);
    expect(result).toEqual({ checkpoint: f.checkpoint, leaves: f.leaves });
    expect(result!.checkpoint).not.toBe(f.checkpoint);
    // Published pre-0058 schema: header + all 49 leaves + an actual metadata
    // presence query, not a fabricated lineage row or permissive SQL fallback.
    expect(f.calls).toEqual([
      { sql: readerSql.header, parameters: [backupId] },
      { sql: readerSql.leaves, parameters: [backupId] },
      { sql: readerSql.lineageTable, parameters: undefined },
    ]);
  });
  it("reads the empty lineage table explicitly for an unchanged v1 checkpoint on a newer schema", async () => {
    const f = source(true);
    expect(await readTenantTelemetryCaptureCheckpointFromMysql(f.executor, backupId, key))
      .toEqual({ checkpoint: f.checkpoint, leaves: f.leaves });
    expect(f.calls).toEqual([
      { sql: readerSql.header, parameters: [backupId] },
      { sql: readerSql.leaves, parameters: [backupId] },
      { sql: readerSql.lineageTable, parameters: undefined },
      { sql: readerSql.lineage, parameters: [backupId] },
    ]);
  });
  it("does not hide an orphan lineage row behind an old v1 checkpoint", async () => {
    const f = source(true);
    f.setLineageRows([{ backup_id: backupId, family: "restore_history", identity_ref_sha256: h("orphan-lineage-id"),
      record_hmac_sha256: h("orphan-lineage-row"), source_high_water_db_ms: 950 }]);
    await expect(readTenantTelemetryCaptureCheckpointFromMysql(f.executor, backupId, key)).rejects.toThrow();
    expect(f.calls).toHaveLength(4);
  });
  it("does not interpret missing historic header and leaves as verified inactive capture", async () => {
    const f = source(); f.setHeaders([]); f.setLeaves([]);
    expect(await readTenantTelemetryCaptureCheckpointFromMysql(f.executor, backupId, key)).toBeNull();
  });
  it("rejects orphan leaves rather than treating a missing header as no capture", async () => {
    const f = source(); f.setHeaders([]);
    await expect(readTenantTelemetryCaptureCheckpointFromMysql(f.executor, backupId, key)).rejects.toThrow();
  });
  it("binds the JSON backup ID independently of matching outer row columns", async () => {
    const f = source(); const other = codec.createTenantTelemetryCaptureBackupCheckpoint({ ...header(),
      backupId: "backup_00000000-0000-4000-8000-000000000004" }, f.leaves, key);
    f.setHeaders([{ ...f.header, checkpoint_json: other, checkpoint_sha256: other.checkpointSha256 }]);
    await expect(readTenantTelemetryCaptureCheckpointFromMysql(f.executor, backupId, key)).rejects.toThrow();
  });
  it.each(["anchor_sha256", "checkpoint_sha256", "ref_key_id_sha256", "backup_id"] as const)(
    "rejects the changed physical header column %s", async (column) => {
      const f = source(); f.setHeaders([{ ...f.header, [column]: h("changed-header-column") }]);
      await expect(readTenantTelemetryCaptureCheckpointFromMysql(f.executor, backupId, key)).rejects.toThrow();
    },
  );
  it("requires the independent protected key and rejects a missing original leaf", async () => {
    const f = source();
    await expect(readTenantTelemetryCaptureCheckpointFromMysql(f.executor, backupId, wrongKey)).rejects.toThrow();
    f.setLeaves(f.rows.slice(1));
    await expect(readTenantTelemetryCaptureCheckpointFromMysql(f.executor, backupId, key)).rejects.toThrow();
  });
  it("rejects a duplicate source leaf even when the copied row is otherwise exact", async () => {
    const f = source(); f.setLeaves([...f.rows, f.rows[0]!]);
    await expect(readTenantTelemetryCaptureCheckpointFromMysql(f.executor, backupId, key)).rejects.toThrow();
  });
  it("rejects malformed backup IDs before sending any SQL", async () => {
    const f = source();
    await expect(readTenantTelemetryCaptureCheckpointFromMysql(f.executor, "backup_' OR 1=1", key)).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
});

/** Synthetic records constructed with the official 0030 evidence algorithms.
 * These tests prove the shared identity/selector contract only, not a DB row,
 * remote head, actual publisher, stopped fleet, maintenance facade or activation. */
type RestoreRuntime = Extract<RestoreJournal.TenantRestoreRuntimeControlRecord, { lineageKind: "restore" }>;
function officialRestoreRuntimeFixture(options: { restoreRunId?: string; runtimeEpochSha256?: string; sourceBackupSha256?: string } = {}) {
  const target: RestoreJournal.TenantRestoreJournalTargetDescriptor = { targetOrdinal: 0,
    targetSha256: h("shared-runtime-target"), failureDomainSha256: h("shared-runtime-domain"),
    adapterProtocol: "memory-restore-journal-v1", journalNamespaceSha256: h("shared-runtime-journal") };
  const journalBody = { singletonId: RestoreJournal.TENANT_RESTORE_JOURNAL_CONTROL_SINGLETON_ID, controlGeneration: 1 as const,
    activatedAtDbMs: 800, protocol: RestoreJournal.TENANT_RESTORE_JOURNAL_PROTOCOL, adapterProtocol: target.adapterProtocol,
    journalNamespaceSha256: target.journalNamespaceSha256, logicalDatabaseNamespaceSha256: h("shared-runtime-database"),
    targetCount: 1, targetRootSha256: RestoreJournal.tenantRestoreJournalTargetRootSha256([target]) };
  const journal = { ...journalBody, evidenceSha256: RestoreJournal.tenantRestoreJournalControlEvidenceSha256(journalBody) };
  RestoreJournal.validateTenantRestoreJournalControlRecord(journal);
  const head = { ...target, logicalDatabaseNamespaceSha256: journal.logicalDatabaseNamespaceSha256,
    sealedRemoteSequence: 0, sealedHeadRootSha256: RestoreJournal.EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256 };
  const headRoot = RestoreJournal.tenantRestoreReplaySealedTargetRootSha256([head]);
  const primaryBody = { singletonId: RestoreJournal.TENANT_RESTORE_RUNTIME_CONTROL_SINGLETON_ID, state: "active" as const,
    controlGeneration: 1, updateKind: "primary_activation" as const, activatedAtDbMs: 900, updatedAtDbMs: 900,
    lineageKind: "primary" as const, runtimeEpochSha256: h("shared-runtime-original-primary"),
    controlEvidenceSha256: journal.evidenceSha256, logicalDatabaseNamespaceSha256: journal.logicalDatabaseNamespaceSha256,
    targetCount: journal.targetCount, targetRootSha256: journal.targetRootSha256, verifiedHeadRootSha256: headRoot,
    previousControlEvidenceSha256: RestoreJournal.EMPTY_TENANT_RESTORE_RUNTIME_CONTROL_EVIDENCE_SHA256 };
  const primary = { ...primaryBody, evidenceSha256: RestoreJournal.tenantRestoreRuntimeControlEvidenceSha256(primaryBody) };
  RestoreJournal.validateTenantRestoreRuntimeControlRecord(primary);
  const replayBody = { scope: RestoreJournal.TENANT_RESTORE_REPLAY_RECEIPT_SCOPE, restoreRunId: options.restoreRunId ?? runId,
    sourceBackupSha256: options.sourceBackupSha256 ?? h("shared-runtime-actual-backup"),
    runtimeEpochSha256: options.runtimeEpochSha256 ?? h("shared-runtime-new-epoch"), controlEvidenceSha256: journal.evidenceSha256,
    protocol: RestoreJournal.TENANT_RESTORE_JOURNAL_PROTOCOL, adapterProtocol: journal.adapterProtocol,
    journalNamespaceSha256: journal.journalNamespaceSha256, logicalDatabaseNamespaceSha256: journal.logicalDatabaseNamespaceSha256,
    targetCount: journal.targetCount, targetRootSha256: journal.targetRootSha256, sealedTargetRootSha256: headRoot,
    entryCount: 0, entryRootSha256: RestoreJournal.EMPTY_TENANT_RESTORE_REPLAY_ENTRY_ROOT_SHA256,
    fenceCount: 0, fenceRootSha256: RestoreJournal.EMPTY_TENANT_RESTORE_FENCE_ROOT_SHA256, storeDbTimestampMs: 1_050,
    restoreFenceReplayComplete: true as const, physicalReplayComplete: false as const,
    allDomainsComplete: false as const, contentPurgeExecuted: false as const };
  const replay = { ...replayBody, receiptSha256: RestoreJournal.tenantRestoreReplayReceiptSha256(replayBody) };
  RestoreJournal.validateTenantRestoreReplayReceipt(replay);
  const runtimeBody = { singletonId: RestoreJournal.TENANT_RESTORE_RUNTIME_CONTROL_SINGLETON_ID, state: "active" as const,
    controlGeneration: 2, updateKind: "restore_activation" as const, activatedAtDbMs: 1_100, updatedAtDbMs: 1_100,
    lineageKind: "restore" as const, restoreRunId: replay.restoreRunId, replayReceiptSha256: replay.receiptSha256,
    runtimeEpochSha256: replay.runtimeEpochSha256, controlEvidenceSha256: journal.evidenceSha256,
    logicalDatabaseNamespaceSha256: journal.logicalDatabaseNamespaceSha256, targetCount: journal.targetCount,
    targetRootSha256: journal.targetRootSha256, verifiedHeadRootSha256: replay.sealedTargetRootSha256,
    previousControlEvidenceSha256: primary.evidenceSha256 };
  const runtime: RestoreRuntime = { ...runtimeBody, evidenceSha256: RestoreJournal.tenantRestoreRuntimeControlEvidenceSha256(runtimeBody) };
  RestoreJournal.validateTenantRestoreRuntimeControlRecord(runtime);
  return { journal, primary, replay, runtime, target, head };
}
function officialRuntimeSuccessor(runtime: RestoreRuntime, verifiedHeadRootSha256: string): RestoreRuntime {
  const { evidenceSha256, ...prior } = runtime;
  const body = { ...prior, controlGeneration: prior.controlGeneration + 1, updateKind: "journal_head_advance" as const,
    updatedAtDbMs: prior.updatedAtDbMs + 100, verifiedHeadRootSha256, previousControlEvidenceSha256: evidenceSha256 };
  const successor = { ...body, evidenceSha256: RestoreJournal.tenantRestoreRuntimeControlEvidenceSha256(body) };
  RestoreJournal.validateTenantRestoreRuntimeControlRecord(successor);
  return successor;
}
function signedRuntimePatch(runtime: RestoreRuntime, patch: Partial<Omit<RestoreRuntime, "evidenceSha256">>): RestoreRuntime {
  const { evidenceSha256: ignored, ...prior } = runtime; void ignored;
  const body = { ...prior, ...patch };
  const changed = { ...body, evidenceSha256: RestoreJournal.tenantRestoreRuntimeControlEvidenceSha256(body) };
  RestoreJournal.validateTenantRestoreRuntimeControlRecord(changed);
  return changed;
}
function maintenanceSelector(): TenantTelemetryCaptureRestoreMaintenanceSelector {
  return { backupId, restoreRunId: runId, checkpointSha256: h("selected-checkpoint"), artifactManifestSha256: h("selected-manifest"),
    sourceSnapshotSha256: h("selected-sql-bytes"), providerEvidenceSha256: h("selected-provider-proof"),
    reservationSha256: h("selected-reservation"), reservationReceiptSha256: h("selected-external-reservation"),
    fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1" };
}

describe("shared restore-only runtime identity from official 0030 records", () => {
  it("binds the exact validated restore activation, journal and replay identities", () => {
    const f = officialRestoreRuntimeFixture();
    expect(f.runtime.previousControlEvidenceSha256).toBe(f.primary.evidenceSha256);
    expect(f.runtime.replayReceiptSha256).toBe(f.replay.receiptSha256);
    expect(f.runtime.verifiedHeadRootSha256).toBe(f.replay.sealedTargetRootSha256);
    expect(codec.tenantTelemetryCaptureRestoreRuntimeBindingSha256(f.runtime, f.journal)).toBe(proofHash(
      "tenant-telemetry-capture-restore-runtime-binding-v1", { lineageKind: "restore", restoreRunId: f.runtime.restoreRunId,
        replayReceiptSha256: f.replay.receiptSha256, runtimeEpochSha256: f.runtime.runtimeEpochSha256,
        journalControlEvidenceSha256: f.journal.evidenceSha256, logicalDatabaseNamespaceSha256: f.runtime.logicalDatabaseNamespaceSha256,
        journalTargetRootSha256: f.journal.targetRootSha256, targetCount: f.journal.targetCount }));
  });
  it("keeps identity across valid sequential head/publisher-control successors without making them write authority", () => {
    const f = officialRestoreRuntimeFixture(), original = codec.tenantTelemetryCaptureRestoreRuntimeBindingSha256(f.runtime, f.journal);
    const firstHead = { ...f.head, sealedRemoteSequence: 1, sealedHeadRootSha256: h("synthetic-published-head-one") };
    const secondHead = { ...f.head, sealedRemoteSequence: 2, sealedHeadRootSha256: h("synthetic-published-head-two") };
    const first = officialRuntimeSuccessor(f.runtime, RestoreJournal.tenantRestoreReplaySealedTargetRootSha256([firstHead]));
    const second = officialRuntimeSuccessor(first, RestoreJournal.tenantRestoreReplaySealedTargetRootSha256([secondHead]));
    expect(first.previousControlEvidenceSha256).toBe(f.runtime.evidenceSha256); expect(second.previousControlEvidenceSha256).toBe(first.evidenceSha256);
    expect(second.controlGeneration).toBe(4); expect(second.updatedAtDbMs).toBe(1_300);
    expect(new Set([f.runtime.evidenceSha256, first.evidenceSha256, second.evidenceSha256]).size).toBe(3);
    for (const current of [first, second]) expect(codec.tenantTelemetryCaptureRestoreRuntimeBindingSha256(current, f.journal)).toBe(original);
  });
  it("rejects valid primary and inactive records instead of broadening the old primary binding contract", () => {
    const f = officialRestoreRuntimeFixture();
    const inactiveRuntime: RestoreJournal.TenantRestoreRuntimeControlRecord = { singletonId: 1, state: "inactive", controlGeneration: 0 };
    const inactiveJournal: RestoreJournal.TenantRestoreJournalControlRecord = { singletonId: 1, controlGeneration: 0 };
    RestoreJournal.validateTenantRestoreRuntimeControlRecord(inactiveRuntime); RestoreJournal.validateTenantRestoreJournalControlRecord(inactiveJournal);
    rejected(() => codec.tenantTelemetryCaptureRestoreRuntimeBindingSha256(f.primary, f.journal));
    rejected(() => codec.tenantTelemetryCaptureRestoreRuntimeBindingSha256(inactiveRuntime, f.journal));
    rejected(() => codec.tenantTelemetryCaptureRestoreRuntimeBindingSha256(f.runtime, inactiveJournal));
  });
  it("rejects individually signed runtime records with a mismatched journal control, target, count or database", () => {
    const f = officialRestoreRuntimeFixture();
    for (const patch of [{ controlEvidenceSha256: h("other-journal-control") }, { targetRootSha256: h("other-journal-target-root") },
      { targetCount: 2 }, { logicalDatabaseNamespaceSha256: h("other-database") }]) {
      const changed = signedRuntimePatch(f.runtime, patch);
      rejected(() => codec.tenantTelemetryCaptureRestoreRuntimeBindingSha256(changed, f.journal));
    }
  });
  it.each(["run", "replay", "epoch"] as const)("changes identity for a different valid %s lineage", (kind) => {
    const original = officialRestoreRuntimeFixture();
    const changed = officialRestoreRuntimeFixture(kind === "run" ? { restoreRunId: otherRunId }
      : kind === "replay" ? { sourceBackupSha256: h("different-replayed-backup") } : { runtimeEpochSha256: h("different-restored-epoch") });
    expect(codec.tenantTelemetryCaptureRestoreRuntimeBindingSha256(changed.runtime, changed.journal))
      .not.toBe(codec.tenantTelemetryCaptureRestoreRuntimeBindingSha256(original.runtime, original.journal));
  });
  it("authenticates official record evidence before hashing rather than trusting digest-looking fields", () => {
    const f = officialRestoreRuntimeFixture();
    rejected(() => codec.tenantTelemetryCaptureRestoreRuntimeBindingSha256(change(f.runtime, { evidenceSha256: h("forged-runtime") }), f.journal));
    rejected(() => codec.tenantTelemetryCaptureRestoreRuntimeBindingSha256(f.runtime, change(f.journal, { evidenceSha256: h("forged-journal") })));
    rejected(() => codec.tenantTelemetryCaptureRestoreRuntimeBindingSha256(change(f.runtime, { captureWriteAuthorized: true }), f.journal));
  });
});

describe("shared exact-run maintenance selector closed input", () => {
  it("accepts the complete typed plain and null-prototype selectors without changing their fields", () => {
    const value = maintenanceSelector(), before = canonical(value);
    expect(() => validateTenantTelemetryCaptureRestoreMaintenanceSelector(value)).not.toThrow();
    const nullPrototype: TenantTelemetryCaptureRestoreMaintenanceSelector = Object.assign(Object.create(null), value);
    expect(() => validateTenantTelemetryCaptureRestoreMaintenanceSelector(nullPrototype)).not.toThrow();
    expect(canonical(value)).toBe(before);
  });
  it("requires every one of the ten fields, including both explicit ACKs", () => {
    for (const field of Object.keys(maintenanceSelector()) as (keyof TenantTelemetryCaptureRestoreMaintenanceSelector)[]) {
      const value = maintenanceSelector(); Reflect.deleteProperty(value, field);
      rejected(() => validateTenantTelemetryCaptureRestoreMaintenanceSelector(value));
    }
  });
  it("rejects undefined in every known field rather than treating it as omission/default", () => {
    for (const field of Object.keys(maintenanceSelector())) {
      const value = maintenanceSelector(); Reflect.set(value, field, undefined);
      rejected(() => validateTenantTelemetryCaptureRestoreMaintenanceSelector(value));
    }
  });
  it("rejects extra string/symbol authority and non-enumerable fields", () => {
    const extra = Object.assign(maintenanceSelector(), { skipAudit: true });
    const symbol = maintenanceSelector(); Object.defineProperty(symbol, Symbol("write-authority"), { value: true, enumerable: true });
    const hidden = maintenanceSelector(); Object.defineProperty(hidden, "checkpointSha256", { value: hidden.checkpointSha256, enumerable: false });
    for (const value of [extra, symbol, hidden]) rejected(() => validateTenantTelemetryCaptureRestoreMaintenanceSelector(value));
  });
  it("requires canonical lowercase 64-hex strings for all six selected evidence digests", () => {
    const fields = ["checkpointSha256", "artifactManifestSha256", "sourceSnapshotSha256", "providerEvidenceSha256", "reservationSha256", "reservationReceiptSha256"] as const;
    for (const field of fields) for (const invalid of ["", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), null, 0]) {
      const value = maintenanceSelector(); Reflect.set(value, field, invalid);
      rejected(() => validateTenantTelemetryCaptureRestoreMaintenanceSelector(value));
    }
  });
  it("requires v4 backup/run string IDs without invoking object or Symbol coercion", () => {
    for (const field of ["backupId", "restoreRunId"] as const) {
      for (const invalid of ["", field === "backupId" ? runId : backupId, "backup_00000000-0000-1000-8000-000000000001", Symbol("invalid-id")]) {
        const value = maintenanceSelector(); Reflect.set(value, field, invalid);
        rejected(() => validateTenantTelemetryCaptureRestoreMaintenanceSelector(value));
      }
      let coercions = 0;
      const value = maintenanceSelector(); Reflect.set(value, field, { toString() { coercions += 1; return field === "backupId" ? backupId : runId; } });
      rejected(() => validateTenantTelemetryCaptureRestoreMaintenanceSelector(value)); expect(coercions).toBe(0);
    }
  });
  it("does not coerce ACKs or permit caller write/erase permission in their place", () => {
    for (const field of ["fleetStoppedAck", "localOnlyAck"] as const) for (const invalid of [true, 1, "1", null, "production", "erase-authorized-v1"]) {
      const value = maintenanceSelector(); Reflect.set(value, field, invalid);
      rejected(() => validateTenantTelemetryCaptureRestoreMaintenanceSelector(value));
    }
  });
  it("rejects accessors on every field without evaluating even one getter", () => {
    for (const field of Object.keys(maintenanceSelector())) {
      let reads = 0;
      const value = maintenanceSelector(); Object.defineProperty(value, field, { enumerable: true, get() { reads += 1; throw new Error("getter must not execute"); } });
      rejected(() => validateTenantTelemetryCaptureRestoreMaintenanceSelector(value)); expect(reads).toBe(0);
    }
  });
  it("rejects custom/inherited prototypes and non-record carriers", () => {
    const inherited: TenantTelemetryCaptureRestoreMaintenanceSelector = Object.create(maintenanceSelector());
    const custom: TenantTelemetryCaptureRestoreMaintenanceSelector = Object.assign(Object.create({ inheritedAuthority: true }), maintenanceSelector());
    for (const value of [inherited, custom, [], null, new Map(), new Date(0)]) {
      rejected(() => validateTenantTelemetryCaptureRestoreMaintenanceSelector(value as TenantTelemetryCaptureRestoreMaintenanceSelector));
    }
  });
});

describe("capture restore fixed physical projection contract", () => {
  it("contains exactly 49 distinct families, real existing SQL tables and explicit special subprojections", () => {
    expect(codec.TENANT_TELEMETRY_CAPTURE_CHECKPOINT_FAMILIES).toHaveLength(49);
    expect(new Set(codec.TENANT_TELEMETRY_CAPTURE_CHECKPOINT_FAMILIES).size).toBe(49);
    expect(codec.TENANT_TELEMETRY_CAPTURE_CHECKPOINT_FAMILIES.filter((name) => name.startsWith("retained_"))).toHaveLength(9);
    const directory = new URL("../migrations/", import.meta.url);
    const sql = readdirSync(directory).filter((name) => /^[0-9]{4}_[a-z0-9_]+\.sql$/.test(name))
      .map((name) => readFileSync(new URL(name, directory), "utf8")).join("\n");
    for (const projection of codec.TENANT_TELEMETRY_CAPTURE_CHECKPOINT_SQL) {
      expect(Object.isFrozen(projection)).toBe(true); expect(Object.isFrozen(projection.tables)).toBe(true);
      for (const table of projection.tables) expect(sql).toMatch(new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? ${table}\\s*\\(`));
    }
    expect(codec.TENANT_TELEMETRY_CAPTURE_CHECKPOINT_SQL.find((row) => row.family === "write_reservation"))
      .toEqual({ family: "write_reservation", tables: ["tenant_telemetry_write_jobs"], projection: "non_null_reservation_columns" });
    expect(codec.TENANT_TELEMETRY_CAPTURE_CHECKPOINT_SQL.find((row) => row.family === "legacy_failure")?.tables).toEqual(["items", "events"]);
  });
  it("seals all fixed families including explicit empty roots and honestly preserves legacy unknown", () => {
    const f = fixture(); expect(f.checkpoint.families).toHaveLength(49); expect(f.checkpoint.observedRowCount).toBe(6);
    expect(f.checkpoint.legacyUnknownCount).toBe(1); expect(f.checkpoint.sourceHighWaterDbMs).toBe(950);
    expect(f.checkpoint.families.find((row) => row.family === "write_ack")).toMatchObject({ rowCount: 0, legacyUnknownCount: 0, sourceHighWaterDbMs: 0 });
    expect(f.checkpoint.families.find((row) => row.family === "write_job")?.states.queued).toBe(1);
    expect(Object.isFrozen(f.checkpoint)).toBe(true); expect(Object.isFrozen(f.checkpoint.families)).toBe(true);
    expect(Object.isFrozen(f.checkpoint.families[0]!.states)).toBe(true);
    codec.validateTenantTelemetryCaptureBackupCheckpoint(f.checkpoint, key);
  });
  it.each(["queued", "reserved", "written", "blocked"] as const)("backs up %s without requiring all ACKs or unknown=0", (state) => {
    const f = fixture({ jobState: state, omitPayload: state === "written", ack: state === "written" });
    expect(f.checkpoint.families.find((row) => row.family === "write_job")?.states[state]).toBe(1);
    expect(f.checkpoint.legacyUnknownCount).toBe(1);
    codec.assertTenantTelemetryCaptureCheckpointLeaves(f.checkpoint, f.leaves, key);
  });
  it("backs up an entirely empty physical projection with all 49 explicit roots", () => {
    const value = codec.createTenantTelemetryCaptureBackupCheckpoint(header(), [], key);
    expect(value.observedRowCount).toBe(0); expect(value.families.every((row) => row.rowCount === 0)).toBe(true);
    expect(value.sourceHighWaterDbMs).toBe(925);
  });
  it("orders the same complete leaves canonically, without mutating the originals", () => {
    const f = fixture(); const saved = canonical(f.leaves);
    const reordered = codec.createTenantTelemetryCaptureBackupCheckpoint(header(), [...f.leaves].reverse(), key);
    expect(reordered).toEqual(f.checkpoint); expect(canonical(f.leaves)).toBe(saved);
  });
  it("domain-separates the protected key, family and identity/record purpose", () => {
    const bytes = Buffer.from("same-low-entropy-input");
    const values = [codec.tenantTelemetryCaptureCheckpointOpaqueDigest("canonical_session", "identity", bytes, key),
      codec.tenantTelemetryCaptureCheckpointOpaqueDigest("canonical_session", "record", bytes, key),
      codec.tenantTelemetryCaptureCheckpointOpaqueDigest("canonical_item", "identity", bytes, key),
      codec.tenantTelemetryCaptureCheckpointOpaqueDigest("canonical_session", "identity", bytes, wrongKey)];
    expect(new Set(values).size).toBe(values.length); expect(values).not.toContain(h("same-low-entropy-input"));
    rejected(() => codec.tenantTelemetryCaptureCheckpointOpaqueDigest("canonical_session", "identity", bytes, Buffer.alloc(31)));
    rejected(() => codec.tenantTelemetryCaptureCheckpointOpaqueDigest("canonical_session", "identity", Buffer.alloc(0), key));
    rejected(() => codec.tenantTelemetryCaptureCheckpointOpaqueDigest("canonical_session", "identity", Buffer.alloc(codec.TENANT_TELEMETRY_CAPTURE_RESTORE_MAX_BYTES + 1), key));
  });
  it.each([
    ["unknown family", { family: "invented_source" }], ["unknown state", { state: "completed" }],
    ["invented completeness", { knowledge: "complete" }], ["invalid digest", { recordHmacSha256: "A".repeat(64) }],
    ["negative time", { sourceHighWaterDbMs: -1 }], ["unsafe time", { sourceHighWaterDbMs: Number.MAX_SAFE_INTEGER + 1 }],
    ["raw ID", { tenantId: "must-not-enter-checkpoint" }], ["unknown private metadata", { extra: {} }],
  ] as const)("rejects a leaf with %s", (_name, patch) => {
    rejected(() => codec.createTenantTelemetryCaptureBackupCheckpoint(header(), [change(leaf("canonical_item"), patch)], key));
  });
  it("rejects duplicate, sparse, accessor and over-limit leaves before hashing", () => {
    const row = leaf("canonical_item"); rejected(() => codec.createTenantTelemetryCaptureBackupCheckpoint(header(), [row, row], key));
    const sparse: codec.TenantTelemetryCaptureCheckpointLeaf[] = []; sparse.length = 1;
    rejected(() => codec.createTenantTelemetryCaptureBackupCheckpoint(header(), sparse, key));
    const large: codec.TenantTelemetryCaptureCheckpointLeaf[] = []; large.length = codec.TENANT_TELEMETRY_CAPTURE_RESTORE_MAX_LEAVES + 1;
    rejected(() => codec.createTenantTelemetryCaptureBackupCheckpoint(header(), large, key));
    let read = false;
    const accessor = { ...row }; Object.defineProperty(accessor, "recordHmacSha256", { enumerable: true, get() { read = true; return row.recordHmacSha256; } });
    rejected(() => codec.createTenantTelemetryCaptureBackupCheckpoint(header(), [accessor], key)); expect(read).toBe(false);
    rejected(() => codec.createTenantTelemetryCaptureBackupCheckpoint(header(), [change(row, { state: "written" })], key));
    rejected(() => codec.createTenantTelemetryCaptureBackupCheckpoint(header(), [leaf("legacy_failure", "legacy_unknown")], key));
  });
  it.each([
    ["key mismatch", { refKeyIdSha256: tenantTelemetryRefKeyIdSha256(wrongKey) }], ["fake self-build attestation", { sourceBuildMatch: "attested" }],
    ["bad backup ID", { backupId: "backup_not-a-uuid" }], ["zero runtime generation", { sourceRuntimeControlGeneration: 0 }],
    ["time before anchor", { sealedAtDbMs: 899 }], ["time before control", { controlHighWaterDbMs: 1_001 }], ["unknown lineage", { sourceRuntimeLineageKind: "promoted" }],
    ["primary rebind", { sourceRuntimeEpochSha256: h("other-primary") }], ["primary parent receipt", { sourceHistoryReceiptSha256: h("parent") }],
  ] as const)("rejects checkpoint header %s", (_name, patch) => {
    rejected(() => codec.createTenantTelemetryCaptureBackupCheckpoint(change(header(), patch), [], key));
  });
  it("rejects a DB clock before any captured row, a missing family, altered count/root and extra authority even after rehash", () => {
    rejected(() => codec.createTenantTelemetryCaptureBackupCheckpoint(header(), [change(leaf("canonical_item"), { sourceHighWaterDbMs: 1_001 })], key));
    const f = fixture();
    for (const patch of [
      { families: f.checkpoint.families.slice(1) }, { observedRowCount: 0 }, { legacyUnknownCount: 0 },
      { projectionRootSha256: h("fake-root") }, { executionReady: true }, { erasureAuthorized: true }, { allDomainsComplete: true }, { extra: "authority" },
    ]) rejected(() => codec.validateTenantTelemetryCaptureBackupCheckpoint(reseal(f.checkpoint, patch, "checkpointSha256"), key));
    const reversed = [...f.checkpoint.families].reverse();
    rejected(() => codec.validateTenantTelemetryCaptureBackupCheckpoint(reseal(f.checkpoint, { families: reversed }, "checkpointSha256"), key));
    rejected(() => codec.validateTenantTelemetryCaptureBackupCheckpoint(f.checkpoint, wrongKey));
  });
  it("compares dump before/after against the complete snapshot rather than timestamps or self-hashes alone", () => {
    const f = fixture(); const later = codec.createTenantTelemetryCaptureBackupCheckpoint({ ...header(), sealedAtDbMs: 1_020 }, f.leaves, key);
    codec.assertTenantTelemetryCaptureBackupCheckpointUnchanged(f.checkpoint, later, key);
    for (const family of ["write_payload", "write_ack", "billing_fact", "canonical_event", "retained_canonical_receipt"] as const) {
      const extra = family === "write_payload" ? operationLeaf(family, "spooled") : leaf(family);
      extra.identityRefSha256 = h(`added-${family}`);
      const changed = codec.createTenantTelemetryCaptureBackupCheckpoint({ ...header(), sealedAtDbMs: 1_020 }, [...f.leaves, extra], key);
      rejected(() => codec.assertTenantTelemetryCaptureBackupCheckpointUnchanged(f.checkpoint, changed, key));
    }
    const changedHead = codec.createTenantTelemetryCaptureBackupCheckpoint({ ...header(), journalHeadRootSha256: h("drifted-head"), sealedAtDbMs: 1_020 }, f.leaves, key);
    rejected(() => codec.assertTenantTelemetryCaptureBackupCheckpointUnchanged(f.checkpoint, changedHead, key));
    rejected(() => codec.assertTenantTelemetryCaptureCheckpointLeaves(f.checkpoint, f.leaves.slice(1), key));
  });
  it("rejects rehashed family state/completeness reinterpretation, not merely a stale outer hash", () => {
    const f = fixture();
    for (const mode of ["wrong_job_state", "upgrade_legacy_unknown"] as const) {
      const families = clone(f.checkpoint.families);
      if (mode === "wrong_job_state") {
        const job = families.find((row) => row.family === "write_job")!; job.states.queued = 0; job.states.record = 1;
      } else families.find((row) => row.family === "legacy_failure")!.legacyUnknownCount = 0;
      const forged = reseal(f.checkpoint, { families, legacyUnknownCount: mode === "upgrade_legacy_unknown" ? 0 : 1,
        projectionRootSha256: proofHash("tenant-telemetry-capture-checkpoint-projection-v1", families) }, "checkpointSha256");
      rejected(() => codec.validateTenantTelemetryCaptureBackupCheckpoint(forged, key));
    }
  });
  it("requires explicit parent history/cutover for a restored source while preserving the original primary activation", () => {
    const restored = { ...header(), sourceRuntimeLineageKind: "restore" as const, sourceRuntimeEpochSha256: h("prior-restore-epoch"),
      sourceRuntimeBindingSha256: h("prior-restore-binding"), sourceRuntimeControlGeneration: 2,
      sourceHistoryReceiptSha256: h("parent-history"), sourceCaptureCutoverReceiptSha256: h("parent-cutover") };
    const checkpoint = codec.createTenantTelemetryCaptureBackupCheckpoint(restored, [], key);
    expect(checkpoint.originalRuntimeEpochSha256).toBe(header().originalRuntimeEpochSha256);
    rejected(() => codec.createTenantTelemetryCaptureBackupCheckpoint({ ...restored, sourceHistoryReceiptSha256: null }, [], key));
    rejected(() => codec.createTenantTelemetryCaptureBackupCheckpoint({ ...restored, sourceCaptureCutoverReceiptSha256: null }, [], key));
  });
});

describe("authenticated-artifact capture checkpoint selection", () => {
  const base = {
    backupId: "backup_00000000-0000-4000-8000-000000000001",
    restoreRunId: "restore_00000000-0000-4000-8000-000000000002",
    runtimeEpochSha256: h("selection-new-epoch"),
  };
  it("preserves the exact legacy v1 input shape", () => {
    expect(() => validatePreflightTenantRestoreReplayFromBackupInput(base)).not.toThrow();
  });
  it("accepts a v2 digest as syntax, not evidence of an authenticated artifact", () => {
    expect(() => validatePreflightTenantRestoreReplayFromBackupInput({
      ...base, captureCheckpointSha256: h("selected-authenticated-checkpoint"),
    })).not.toThrow();
  });
  it.each([undefined, null, "", "A".repeat(64), "0".repeat(63), 1])(
    "does not downgrade an explicit invalid checkpoint %j into a v1 selection", (captureCheckpointSha256) => {
      expect(() => validatePreflightTenantRestoreReplayFromBackupInput({
        ...base, captureCheckpointSha256,
      } as unknown as Parameters<typeof validatePreflightTenantRestoreReplayFromBackupInput>[0])).toThrow();
    },
  );
  it("rejects caller authority fields instead of accepting a supplied snapshot", () => {
    expect(() => validatePreflightTenantRestoreReplayFromBackupInput({
      ...base, captureCheckpointSha256: h("checkpoint"), sourceVerified: true,
    } as unknown as Parameters<typeof validatePreflightTenantRestoreReplayFromBackupInput>[0])).toThrow();
  });
});

describe("capture restore history and explicit epoch cutover", () => {
  it("preserves honest unknown counts and original activation without granting writes or erasure", () => {
    const f = fixture(); const saved = canonical(f.checkpoint);
    expect(f.history).toMatchObject({ phase: "active", historyReadOnly: true, writeAuthorized: false, preservedLegacyUnknownCount: 1,
      erasureAuthorized: false, executionReady: false, externalAuthorityVerified: false, allDomainsComplete: false, contentPurgeExecuted: false });
    expect(f.history.originalCaptureActivationReceiptSha256).toBe(f.checkpoint.originalCaptureActivationReceiptSha256);
    expect(f.history.originalRuntimeEpochSha256).not.toBe(f.history.runtimeEpochSha256);
    expect(canonical(f.checkpoint)).toBe(saved);
    codec.assertTenantTelemetryCaptureRestoreActivationBinding(f.history, f.binding);
  });
  it.each([
    ["backup", { backupId: "backup_00000000-0000-4000-8000-000000000004" }], ["anchor", { anchorSha256: h("wrong-anchor") }],
    ["checkpoint", { checkpointSha256: h("wrong-checkpoint") }], ["old epoch", { runtimeEpochSha256: header().sourceRuntimeEpochSha256 }],
    ["old binding", { runtimeBindingSha256: header().sourceRuntimeBindingSha256 }], ["generation", { runtimeControlGeneration: 1 }],
    ["activation time", { activatedAtDbMs: 999 }], ["phase", { phase: "prepared" }],
  ] as const)("rejects history binding with wrong %s", (_name, patch) => {
    const f = fixture(); rejected(() => codec.createTenantTelemetryCaptureRestoreHistoryReceipt(change(f.binding, patch), f.checkpoint, key));
  });
  it.each(["restoreRunId", "artifactManifestSha256", "sourceSnapshotSha256", "providerEvidenceSha256", "sourceBindingSha256",
    "reservationSha256", "reservationReceiptSha256", "replayReceiptSha256", "sealedJournalHeadRootSha256"] as const)
    ("rejects a self-consistent substituted %s against the independent actual activation binding", (field) => {
      const f = fixture(); const patch = { [field]: field === "restoreRunId" ? otherRunId : h(`other-${field}`) };
      const substituted = codec.createTenantTelemetryCaptureRestoreHistoryReceipt(change(f.binding, patch), f.checkpoint, key);
      rejected(() => codec.assertTenantTelemetryCaptureRestoreActivationBinding(substituted, f.binding));
      rejected(() => codec.encodeTenantTelemetryCaptureRestoreRecord(substituted, f.context));
    });
  it.each([
    { phase: "replay_sealed" }, { preservedLegacyUnknownCount: 0 }, { historyReadOnly: false }, { writeAuthorized: true },
    { erasureAuthorized: true }, { originalCaptureActivationReceiptSha256: h("rebound-original") }, { refKeyIdSha256: tenantTelemetryRefKeyIdSha256(wrongKey) },
  ])("rejects forged history metadata %# even with recomputed hash", (patch) => {
    const f = fixture(); rejected(() => codec.validateTenantTelemetryCaptureRestoreHistoryReceipt(reseal(f.history, patch), f.checkpoint, key));
  });
  it("requires a distinct explicit cutover and does not thereby authorize historical operations", () => {
    const f = fixture(); expect(f.cutover).toMatchObject({ newCaptureWritesAuthorized: true, historicalOperationRecoveryAuthorized: false,
      erasureAuthorized: false, executionReady: false, allDomainsComplete: false, contentPurgeExecuted: false });
    expect(f.cutover.historyReceiptSha256).toBe(f.history.receiptSha256);
  });
  it.each(["fleetStoppedAck", "legacyWritersDrainedAck", "producerReadyAck", "localOnlyAck"] as const)("requires explicit %s", (field) => {
    const f = fixture(); rejected(() => codec.createTenantTelemetryCaptureEpochCutoverReceipt(change(f.cutoverInput, { [field]: "missing" }), f.history, f.checkpoint, key));
  });
  it.each(["refKeyIdSha256", "logsTargetSha256", "logsTargetReceiptSha256", "originalCaptureActivationReceiptSha256", "captureControlEvidenceSha256",
    "historyReceiptSha256", "runtimeEpochSha256", "runtimeBindingSha256", "runtimeControlEvidenceSha256"] as const)("rejects cutover substitution of %s", (field) => {
      const f = fixture(); rejected(() => codec.createTenantTelemetryCaptureEpochCutoverReceipt(change(f.cutoverInput, { [field]: h(`wrong-${field}`) }), f.history, f.checkpoint, key));
    });
  it("rejects early/old-run cutover and an attempt to reuse it as a historical recovery permit", () => {
    const f = fixture();
    rejected(() => codec.createTenantTelemetryCaptureEpochCutoverReceipt(change(f.cutoverInput, { activatedAtDbMs: 1_099 }), f.history, f.checkpoint, key));
    rejected(() => codec.createTenantTelemetryCaptureEpochCutoverReceipt(change(f.cutoverInput, { restoreRunId: otherRunId }), f.history, f.checkpoint, key));
    rejected(() => codec.validateTenantTelemetryCaptureEpochCutoverReceipt(reseal(f.cutover, { historicalOperationRecoveryAuthorized: true }), f.history, f.checkpoint, key));
  });
});

describe("exact pending-operation recovery inclusion and new-claim fencing", () => {
  it.each(["queued", "reserved"] as const)("binds %s original source/payload and a new claim without mutating old receipts", (state) => {
    const f = fixture({ jobState: state }); const saved = canonical([f.checkpoint, f.history, f.cutover, f.leaves]);
    const permit = createPermit(f); expect(permit.phase).toBe("leased"); expect(permit.newClaimAttempt).toBe(4);
    expect(permit.newExternalCreateAuthorized).toBe(true); expect(permit.erasureAuthorized).toBe(false); expect(permit.allDomainsComplete).toBe(false);
    expect(canonical([f.checkpoint, f.history, f.cutover, f.leaves])).toBe(saved);
    codec.validateTenantTelemetryCaptureOperationRecoveryPermit(permit, f.cutover, f.history, f.checkpoint, f.leaves, key);
  });
  it("preserves a never-claimed queued operation without inventing a historical claim", () => {
    const f = fixture(); const permit = createPermit(f, { ...f.recoveryInput, previousClaimAttempt: 0,
      previousClaimTokenSha256: null, previousClaimLeaseUntilMs: null, newClaimAttempt: 1 });
    expect(permit.previousClaimAttempt).toBe(0); expect(permit.previousClaimTokenSha256).toBeNull(); expect(permit.newClaimAttempt).toBe(1);
  });
  it("allows the reserved-before-external-create crash position to resume the ORIGINAL create-only descriptor under a new claim", () => {
    const f = fixture({ jobState: "reserved" }); const permit = createPermit(f);
    expect(permit.recoveryMode).toBe("resume_reserved"); expect(permit.newExternalCreateAuthorized).toBe(true);
    expect(permit.newReservationAuthorized).toBe(false);
    expect(permit.originalReservationReceiptSha256).toBe(f.recoveryInput.originalReservationReceiptSha256);
    expect(permit.inventorySha256).toBe(f.recoveryInput.inventorySha256); expect(permit.payloadSha256).toBe(f.recoveryInput.payloadSha256);
    expect(permit.manifestSha256).toBe(f.recoveryInput.manifestSha256); expect(permit.newClaimAttempt).toBeGreaterThan(permit.previousClaimAttempt);
    expect(permit.newClaimTokenSha256).not.toBe(permit.originalReservationClaimTokenSha256);
    rejected(() => createPermit(f, { ...f.recoveryInput, recoveryMode: "resume_queued" }));
    const queued = fixture(); rejected(() => createPermit(queued, { ...queued.recoveryInput, recoveryMode: "resume_reserved" }));
    rejected(() => codec.validateTenantTelemetryCaptureOperationRecoveryPermit(reseal(permit, { newReservationAuthorized: true }), f.cutover, f.history, f.checkpoint, f.leaves, key));
  });
  it("keeps reserved ACK-only recovery distinct from permission to reserve/create", () => {
    const f = fixture({ jobState: "reserved" }); const permit = createPermit(f, { ...f.recoveryInput, recoveryMode: "reserved_ack_only" });
    expect(permit.newExternalCreateAuthorized).toBe(false); expect(permit.newReservationAuthorized).toBe(false);
    rejected(() => codec.validateTenantTelemetryCaptureOperationRecoveryPermit(reseal(permit, { newExternalCreateAuthorized: true }), f.cutover, f.history, f.checkpoint, f.leaves, key));
    const queued = fixture(); rejected(() => createPermit(queued, { ...queued.recoveryInput, recoveryMode: "reserved_ack_only" }));
  });
  it.each([
    ["old attempt", { newClaimAttempt: 3 }], ["old token", { newClaimTokenSha256: h("previous-claim-token") }],
    ["old still-live lease", { previousClaimLeaseUntilMs: 1_401 }], ["expired new lease", { newClaimLeaseUntilMs: 1_400 }],
    ["overlong new lease", { newClaimLeaseUntilMs: 1_400 + codec.TENANT_TELEMETRY_CAPTURE_RECOVERY_MAX_LEASE_MS + 1 }],
    ["wrong run", { restoreRunId: otherRunId }], ["wrong epoch", { runtimeEpochSha256: h("old-or-other-epoch") }],
    ["wrong cutover", { cutoverReceiptSha256: h("other-cutover") }], ["wrong checkpoint", { checkpointSha256: h("other-checkpoint") }],
    ["unknown phase", { originalJobState: "unknown" }], ["wrong operation", { writeOperationSha256: h("other-operation") }],
    ["wrong payload evidence", { originalPayloadEvidenceHmacSha256: h("different-payload") }], ["missing claim half", { previousClaimTokenSha256: null }],
    ["early issue", { issuedAtDbMs: 1_199, previousClaimLeaseUntilMs: 1_100 }], ["extra authority", { erasureAuthorized: true }], ["raw claim token", { claimToken: "must-not-be-persisted" }],
  ] as const)("rejects recovery %s", (_name, patch) => { const f = fixture(); rejected(() => createPermit(f, change(f.recoveryInput, patch))); });
  it("rejects old reservation claim reuse, missing reservation, and queued NULL reservation smuggling", () => {
    const f = fixture({ jobState: "reserved" });
    for (const patch of [{ newClaimTokenSha256: h("reservation-old-token") }, { originalReservationReceiptSha256: null },
      { originalReservationClaimAttempt: 4 }, { originalReservationClaimTokenSha256: null }, { originalReservationEvidenceHmacSha256: h("wrong-reservation") }]) {
      rejected(() => createPermit(f, change(f.recoveryInput, patch)));
    }
    const queued = fixture(); rejected(() => createPermit(queued, change(queued.recoveryInput, { originalReservationClaimAttempt: 1 })));
  });
  it("does not upgrade a checkpointed unknown job or recover written/blocked/missing-payload sources", () => {
    for (const options of [{ jobUnknown: true }, { jobState: "written" as const, ack: true, omitPayload: true },
      { jobState: "blocked" as const }, { omitPayload: true }, { ack: true }]) {
      const f = fixture(options); rejected(() => createPermit(f));
    }
  });
  it("rejects unknown source members and incomplete/wrong-key original inclusion rather than accepting arbitrary hashes", () => {
    const f = fixture(); const permit = createPermit(f);
    for (const family of ["membership", "provider_source_binding", "provider_failure_commit", "write_payload"] as const) {
      const genuineUnknown = fixture({ unknownFamily: family }); rejected(() => createPermit(genuineUnknown));
      const changed = f.leaves.map((row) => row.family === family ? { ...row, knowledge: "legacy_unknown" as const } : row);
      rejected(() => codec.validateTenantTelemetryCaptureOperationRecoveryPermit(permit, f.cutover, f.history, f.checkpoint, changed, key));
    }
    rejected(() => codec.validateTenantTelemetryCaptureOperationRecoveryPermit(permit, f.cutover, f.history, f.checkpoint, f.leaves.slice(1), key));
    rejected(() => codec.validateTenantTelemetryCaptureOperationRecoveryPermit(permit, f.cutover, f.history, f.checkpoint, f.leaves, wrongKey));
  });
  it("binds actual current original descriptor/new claim and rejects an expired lease, not only the permit self-hash", () => {
    const f = fixture(); const permit = createPermit(f);
    codec.assertTenantTelemetryCaptureOperationRecoveryBinding(permit, f.context.recoveryBinding);
    for (const field of ["tenantRefSha256", "ownerRefSha256", "sourceItemRefSha256", "inventorySha256", "payloadSha256", "manifestSha256",
      "membershipSha256", "sourceBindingReceiptSha256", "failureCommitReceiptSha256", "newClaimTokenSha256"] as const) {
      const current = { input: { ...f.recoveryInput, [field]: h(`different-current-${field}`) }, claimLeaseUntilMs: 2_400, storeDbTimestampMs: 1_500 };
      rejected(() => codec.assertTenantTelemetryCaptureOperationRecoveryBinding(permit, current));
    }
    rejected(() => codec.assertTenantTelemetryCaptureOperationRecoveryBinding(permit, { ...f.context.recoveryBinding, storeDbTimestampMs: 2_400 }));
    rejected(() => codec.assertTenantTelemetryCaptureOperationRecoveryBinding(permit, { ...f.context.recoveryBinding, storeDbTimestampMs: 1_399 }));
    const context: codec.TenantTelemetryCaptureRestoreRecordContext = { ...f.context }; delete context.recoveryBinding;
    rejected(() => codec.encodeTenantTelemetryCaptureRestoreRecord(permit, context));
  });
});

describe("recovery permit predecessor and reservation-at-issue chain (pure fixtures only)", () => {
  function chain() {
    const f = fixture(), first = createPermit(f);
    const input: codec.TenantTelemetryCaptureOperationRecoveryInput = { ...f.recoveryInput,
      previousPermitReceiptSha256: first.receiptSha256, previousClaimAttempt: first.newClaimAttempt,
      previousClaimTokenSha256: first.newClaimTokenSha256, previousClaimLeaseUntilMs: 2_400,
      newClaimAttempt: 5, newClaimTokenSha256: h("p2-token"), newClaimLeaseUntilMs: 3_500,
      claimLeaseCeilingMs: 4_000, issuedAtDbMs: 2_500, recoveryMode: "resume_reserved",
      reservationAtIssue: { origin: "recovery-permit", receiptSha256: h("p1-created-reservation"),
        startedAtDbMs: 1_500, startedClaimAttempt: first.newClaimAttempt, startedClaimTokenSha256: first.newClaimTokenSha256,
        authorizingPermitReceiptSha256: first.receiptSha256 } };
    const links = { previousPermit: first, reservationAuthorizer: first };
    const second = codec.createTenantTelemetryCaptureOperationRecoveryPermit(input, f.cutover, f.history, f.checkpoint, f.leaves, key, links);
    return { f, first, input, links, second };
  }
  it("preserves snapshot queued/null reservation while P2 resumes the exact R authorized by P1", () => {
    const { f, second, links } = chain();
    expect(second.originalJobState).toBe("queued"); expect(second.originalReservationReceiptSha256).toBeNull();
    expect(second.newReservationAuthorized).toBe(false); expect(second.newExternalCreateAuthorized).toBe(true);
    codec.validateTenantTelemetryCaptureOperationRecoveryPermit(second, f.cutover, f.history, f.checkpoint, f.leaves, key, links);
  });
  it("requires actual predecessor/authorizer context rather than trusting valid rehashed link digests", () => {
    const { f, second, links } = chain();
    rejected(() => codec.validateTenantTelemetryCaptureOperationRecoveryPermit(second, f.cutover, f.history, f.checkpoint, f.leaves, key));
    for (const patch of [{ previousPermitReceiptSha256: h("different-predecessor") },
      { originalJobDescriptorSha256: h("changed-descriptor") }, { newClaimAttempt: 6 }]) {
      rejected(() => codec.validateTenantTelemetryCaptureOperationRecoveryPermit(reseal(second, patch), f.cutover, f.history, f.checkpoint, f.leaves, key, links));
    }
    const wrongR = { ...second.reservationAtIssue, startedClaimTokenSha256: h("other-token") };
    rejected(() => codec.validateTenantTelemetryCaptureOperationRecoveryPermit(reseal(second, { reservationAtIssue: wrongR }), f.cutover, f.history, f.checkpoint, f.leaves, key, links));
  });
  it("extends P3 from latest P2 without replacing P1 reservation or original checkpoint evidence", () => {
    const { f, first, second, input } = chain();
    const third = codec.createTenantTelemetryCaptureOperationRecoveryPermit({ ...input,
      previousPermitReceiptSha256: second.receiptSha256, previousClaimAttempt: second.newClaimAttempt,
      previousClaimTokenSha256: second.newClaimTokenSha256, previousClaimLeaseUntilMs: 3_500,
      newClaimAttempt: 6, newClaimTokenSha256: h("p3-token"), newClaimLeaseUntilMs: 5_000,
      claimLeaseCeilingMs: 5_500, issuedAtDbMs: 4_001 }, f.cutover, f.history, f.checkpoint, f.leaves, key,
    { previousPermit: second, reservationAuthorizer: first });
    expect(third.originalJobEvidenceHmacSha256).toBe(first.originalJobEvidenceHmacSha256);
    expect(third.reservationAtIssue).toEqual(second.reservationAtIssue);
    rejected(() => codec.validateTenantTelemetryCaptureOperationRecoveryPermit(reseal(third,
      { reservationAtIssue: { ...third.reservationAtIssue, receiptSha256: h("replacement-reservation") } }),
    f.cutover, f.history, f.checkpoint, f.leaves, key, { previousPermit: second, reservationAuthorizer: first }));
  });
  it("allows a current renewed lease below the fixed ceiling but rejects expiry/ceiling drift", () => {
    const f = fixture(), permit = createPermit(f, { ...f.recoveryInput, claimLeaseCeilingMs: 3_000 });
    const current = { input: { ...f.recoveryInput, claimLeaseCeilingMs: 3_000 }, claimLeaseUntilMs: 2_800, storeDbTimestampMs: 2_700 };
    codec.assertTenantTelemetryCaptureOperationRecoveryBinding(permit, current);
    rejected(() => codec.assertTenantTelemetryCaptureOperationRecoveryBinding(permit, { ...current, claimLeaseUntilMs: 3_001 }));
    rejected(() => codec.assertTenantTelemetryCaptureOperationRecoveryBinding(permit, { ...current, claimLeaseUntilMs: 2_399 }));
    rejected(() => codec.assertTenantTelemetryCaptureOperationRecoveryBinding(permit, { ...current, storeDbTimestampMs: 2_800 }));
  });
});

describe("closed canonical capture-restore transport", () => {
  it("rejects a UTF-8 BOM instead of accepting a second byte representation of canonical wire", () => {
    const f = fixture();
    const wire = codec.encodeTenantTelemetryCaptureRestoreRecord(f.checkpoint, f.context);
    rejected(() => codec.decodeTenantTelemetryCaptureRestoreRecord(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), wire]), f.context));
  });
  it("round-trips all four record kinds with full external context", () => {
    const f = fixture(); const permit = createPermit(f);
    for (const value of [f.checkpoint, f.history, f.cutover, permit]) {
      const wire = codec.encodeTenantTelemetryCaptureRestoreRecord(value, f.context);
      expect(codec.decodeTenantTelemetryCaptureRestoreRecord(wire, f.context)).toEqual(value);
    }
  });
  it("requires independent current activation context for history/cutover/recovery, not the received record's self-hash", () => {
    const f = fixture(); const permit = createPermit(f); const context: codec.TenantTelemetryCaptureRestoreRecordContext = { ...f.context }; delete context.activationBinding;
    for (const value of [f.history, f.cutover, permit]) rejected(() => codec.encodeTenantTelemetryCaptureRestoreRecord(value, context));
    const changed = { ...f.context, activationBinding: { ...f.binding, restoreRunId: otherRunId } };
    rejected(() => codec.decodeTenantTelemetryCaptureRestoreRecord(codec.encodeTenantTelemetryCaptureRestoreRecord(permit, f.context), changed));
  });
  it("rejects duplicate/unknown keys, noncanonical JSON, malformed UTF-8 and byte overruns", () => {
    const f = fixture(); const wire = Buffer.from(codec.encodeTenantTelemetryCaptureRestoreRecord(f.checkpoint, f.context)).toString("utf8");
    for (const text of [` ${wire}`, `${wire}\n`, JSON.stringify(f.checkpoint, null, 2),
      wire.replace("{", `{"protocol":${JSON.stringify(codec.TENANT_TELEMETRY_CAPTURE_RESTORE_PROTOCOL)},`),
      wire.replace("{", '{"unknown":0,')]) rejected(() => codec.decodeTenantTelemetryCaptureRestoreRecord(Buffer.from(text), f.context));
    rejected(() => codec.decodeTenantTelemetryCaptureRestoreRecord(Buffer.from([0xc3, 0x28]), f.context));
    rejected(() => codec.decodeTenantTelemetryCaptureRestoreRecord(Buffer.alloc(codec.TENANT_TELEMETRY_CAPTURE_RESTORE_MAX_BYTES + 1), f.context));
    rejected(() => codec.decodeTenantTelemetryCaptureRestoreRecord(Buffer.alloc(0), f.context));
    rejected(() => codec.decodeTenantTelemetryCaptureRestoreRecord(Buffer.from('{}'), f.context));
  });
  it("rejects unknown nested authority and corrupt hashes even when transport itself is canonical", () => {
    const f = fixture();
    const changed = clone(f.checkpoint); (changed.families[0]!.states as unknown as Record<string, unknown>).deleteAuthorized = true;
    rejected(() => codec.encodeTenantTelemetryCaptureRestoreRecord(changed, f.context));
    rejected(() => codec.decodeTenantTelemetryCaptureRestoreRecord(Buffer.from(canonical(change(f.history, { receiptSha256: h("forged") }))), f.context));
    const all = Buffer.from(codec.encodeTenantTelemetryCaptureRestoreRecord(f.checkpoint, f.context)).toString("utf8");
    expect(all).not.toContain("unrelated-legacy-gap"); expect(all).not.toContain("previous-claim-token");
  });
});

describe("ordinary-startup CP2 audit frame lifetime (pure doubles, not MySQL lock proof)", () => {
  interface AuditFrame { nonce: symbol; includedKeys: Set<string> }
  interface PrivateAuditStore {
    startupCaptureAuditFrames: WeakMap<PoolConnection, AuditFrame>;
    withStartupCaptureAuditFrame<T>(connection: PoolConnection, work: () => Promise<T>): Promise<T>;
    assertStoredCaptureCheckpointLineageIncluded(connection: PoolConnection,
      record: TenantTelemetryCaptureBackupCheckpointRecord, refKey: Buffer): Promise<void>;
    assertCaptureLineageCurrentRelations(connection: PoolConnection): Promise<void>;
    captureCheckpointLineageLeaves(connection: PoolConnection, selectedBackup: string,
      refKey: Buffer): Promise<codec.TenantTelemetryCaptureLineageLeaf[]>;
    assertStoredCaptureCheckpointLineageAncestors(connection: PoolConnection,
      record: TenantTelemetryCaptureBackupCheckpointRecord, refKey: Buffer): Promise<void>;
  }
  function auditFixture() {
    const f = repeatFixture();
    const record: TenantTelemetryCaptureBackupCheckpointRecord = {
      checkpoint: f.cp2, leaves: clone(f.leaves), lineageLeaves: clone(f.lineageLeaves),
    };
    codec.assertTenantTelemetryCaptureCheckpointLeaves(record.checkpoint, record.leaves, key);
    codec.assertTenantTelemetryCaptureLineageLeaves(f.lineage, f.lineageLeaves, key);
    const query = vi.fn(() => { throw new Error("pure audit fixture must not issue SQL"); });
    const connection = Object.freeze({ query }) as unknown as PoolConnection;
    const getConnection = vi.fn(() => { throw new Error("pure audit fixture must not acquire a connection"); });
    // Invoke only the actual constructor's in-memory initialization. The three
    // source readers below are transparent call-boundary doubles, not evidence
    // of a database, a row lock, an ancestor, or a valid alternate protected key.
    const store = Reflect.construct(MysqlSessionStore, [{ getConnection }]) as unknown as PrivateAuditStore;
    const current = vi.spyOn(store, "assertCaptureLineageCurrentRelations").mockResolvedValue(undefined);
    const leaves = vi.spyOn(store, "captureCheckpointLineageLeaves")
      .mockImplementation(async () => clone(f.lineageLeaves));
    const ancestors = vi.spyOn(store, "assertStoredCaptureCheckpointLineageAncestors").mockResolvedValue(undefined);
    const audit = (value = record, refKey = key, conn = connection) =>
      store.assertStoredCaptureCheckpointLineageIncluded(conn, value, refKey);
    const frame = <T>(work: () => Promise<T>, conn = connection) =>
      store.withStartupCaptureAuditFrame(conn, work);
    const noIo = () => { expect(query).not.toHaveBeenCalled(); expect(getConnection).not.toHaveBeenCalled(); };
    return { store, connection, record, current, leaves, ancestors, audit, frame, noIo };
  }

  it("reuses only a fully completed void audit for the exact input within one frame", async () => {
    const f = auditFixture();
    expect(await f.frame(async () => {
      expect(await f.audit()).toBeUndefined();
      expect(await f.audit(clone(f.record))).toBeUndefined();
      expect(await f.audit()).toBeUndefined();
      expect(f.store.startupCaptureAuditFrames.get(f.connection)?.includedKeys.size).toBe(1);
      return "callback_result";
    })).toBe("callback_result");
    expect(f.current).toHaveBeenCalledExactlyOnceWith(f.connection);
    expect(f.leaves).toHaveBeenCalledExactlyOnceWith(f.connection, f.record.checkpoint.backupId, key);
    expect(f.ancestors).toHaveBeenCalledExactlyOnceWith(f.connection, f.record, key);
    expect(f.store.startupCaptureAuditFrames.has(f.connection)).toBe(false);
    f.noIo();
  });

  it.each(["checkpoint", "49-leaf input", "27-leaf input", "protected key"] as const)(
    "does not reuse a success for a different %s", async (changed) => {
      const f = auditFixture();
      const alternate = clone(f.record);
      let refKey = key;
      if (changed === "checkpoint") {
        alternate.checkpoint = reseal(alternate.checkpoint,
          { sealedAtDbMs: alternate.checkpoint.sealedAtDbMs + 1 }, "checkpointSha256");
        codec.validateTenantTelemetryCaptureBackupCheckpoint(alternate.checkpoint, key);
        expect(alternate.checkpoint.checkpointSha256).not.toBe(f.record.checkpoint.checkpointSha256);
      } else if (changed === "49-leaf input") {
        alternate.leaves = [...alternate.leaves].reverse();
        codec.assertTenantTelemetryCaptureCheckpointLeaves(alternate.checkpoint, alternate.leaves, key);
      } else if (changed === "27-leaf input") {
        alternate.lineageLeaves = [...alternate.lineageLeaves!].reverse();
        if (alternate.checkpoint.scope !== codec.TENANT_TELEMETRY_CAPTURE_CHECKPOINT_V2_SCOPE) {
          throw new Error("pure fixture requires CP2");
        }
        codec.assertTenantTelemetryCaptureLineageLeaves(alternate.checkpoint.lineage, alternate.lineageLeaves, key);
      } else refKey = wrongKey;
      await f.frame(async () => {
        await f.audit();
        await f.audit(alternate, refKey);
        await f.audit(alternate, refKey);
        expect(f.current).toHaveBeenCalledTimes(2);
        expect(f.leaves).toHaveBeenCalledTimes(2);
        expect(f.ancestors).toHaveBeenCalledTimes(2);
      });
      f.noIo();
    });

  it("does not cache a late ancestor failure or a partially completed audit", async () => {
    const f = auditFixture();
    const failure = new codec.TenantTelemetryCaptureRestoreIntegrityError();
    f.ancestors.mockRejectedValueOnce(failure);
    await f.frame(async () => {
      await expect(f.audit()).rejects.toBe(failure);
      expect(f.store.startupCaptureAuditFrames.get(f.connection)?.includedKeys.size).toBe(0);
      await expect(f.audit()).resolves.toBeUndefined();
      await f.audit();
      expect(f.current).toHaveBeenCalledTimes(2);
      expect(f.leaves).toHaveBeenCalledTimes(2);
      expect(f.ancestors).toHaveBeenCalledTimes(2);
    });
    f.noIo();
  });

  it("revalidates on a fresh transaction frame and every unscoped later read using the same pooled connection", async () => {
    const f = auditFixture();
    let firstNonce: symbol | undefined;
    await f.frame(async () => {
      firstNonce = f.store.startupCaptureAuditFrames.get(f.connection)?.nonce;
      expect(typeof firstNonce).toBe("symbol");
      await f.audit(); await f.audit();
    });
    expect(f.store.startupCaptureAuditFrames.has(f.connection)).toBe(false);
    await f.frame(async () => {
      expect(f.store.startupCaptureAuditFrames.get(f.connection)?.nonce).not.toBe(firstNonce);
      expect(f.store.startupCaptureAuditFrames.get(f.connection)?.includedKeys.size).toBe(0);
      await f.audit(); await f.audit();
    });
    // Getter call sites do not create this private startup scope. In particular,
    // using the same pooled connection outside it is never reusable evidence.
    await f.audit(); await f.audit();
    expect(f.current).toHaveBeenCalledTimes(4);
    expect(f.leaves).toHaveBeenCalledTimes(4);
    expect(f.ancestors).toHaveBeenCalledTimes(4);
    f.noIo();
  });

  it("revokes successful evidence when the enclosing work rejects, before connection reuse", async () => {
    const f = auditFixture();
    const failure = new codec.TenantTelemetryCaptureRestoreIntegrityError();
    await expect(f.frame(async () => { await f.audit(); throw failure; })).rejects.toBe(failure);
    expect(f.store.startupCaptureAuditFrames.has(f.connection)).toBe(false);
    await f.audit();
    await f.frame(async () => { await f.audit(); await f.audit(); });
    expect(f.current).toHaveBeenCalledTimes(3);
    expect(f.ancestors).toHaveBeenCalledTimes(3);
    f.noIo();
  });

  it("rejects nested or concurrent frames for one connection without revoking its existing nonce", async () => {
    const f = auditFixture();
    const forbiddenWork = vi.fn(async () => {});
    await f.frame(async () => {
      const nonce = f.store.startupCaptureAuditFrames.get(f.connection)?.nonce;
      await f.audit();
      await expect(f.frame(forbiddenWork)).rejects.toBeInstanceOf(codec.TenantTelemetryCaptureRestoreIntegrityError);
      expect(forbiddenWork).not.toHaveBeenCalled();
      expect(f.store.startupCaptureAuditFrames.get(f.connection)?.nonce).toBe(nonce);
      await f.audit();
      expect(f.current).toHaveBeenCalledTimes(1);
      const otherConnection = Object.freeze({}) as unknown as PoolConnection;
      await f.frame(async () => {
        expect(f.store.startupCaptureAuditFrames.get(otherConnection)?.nonce).not.toBe(nonce);
        await f.audit(f.record, key, otherConnection);
        await f.audit(f.record, key, otherConnection);
      }, otherConnection);
      expect(f.store.startupCaptureAuditFrames.has(otherConnection)).toBe(false);
      expect(f.current).toHaveBeenCalledTimes(2);
    });
    f.noIo();
  });

  it("does not treat an in-flight audit as a completed success", async () => {
    const f = auditFixture();
    let release: () => void = () => { throw new Error("pure fixture gate is not initialized"); };
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.current.mockImplementation(() => gate);
    await f.frame(async () => {
      const first = f.audit(), second = f.audit();
      expect(f.current).toHaveBeenCalledTimes(2);
      expect(f.store.startupCaptureAuditFrames.get(f.connection)?.includedKeys.size).toBe(0);
      release();
      await Promise.all([first, second]);
      expect(f.leaves).toHaveBeenCalledTimes(2);
      expect(f.ancestors).toHaveBeenCalledTimes(2);
      await f.audit();
      expect(f.current).toHaveBeenCalledTimes(2);
    });
    f.noIo();
  });

  it("does not memoize the published v1 early-return path as a completed CP2 source audit", async () => {
    const f = auditFixture(), primary = fixture();
    const record = { checkpoint: primary.checkpoint, leaves: primary.leaves };
    await f.frame(async () => {
      await f.audit(record); await f.audit(record);
      expect(f.store.startupCaptureAuditFrames.get(f.connection)?.includedKeys.size).toBe(0);
    });
    expect(f.current).not.toHaveBeenCalled(); expect(f.leaves).not.toHaveBeenCalled();
    expect(f.ancestors).not.toHaveBeenCalled();
    f.noIo();
  });
});

describe("pristine dormant restore startup exception (pure SQL doubles, not database proof)", () => {
  type SqlRow = Record<string, unknown>;
  interface StubRestoreRun {
    restoreRunId: string; phase: "active"; runtimeEpochSha256: string;
  }
  interface StartupAuditStore {
    tenantTelemetryCaptureEpochCutoverSchemaInstalled: boolean;
    tenantTelemetryCaptureRepeatRestoreSchemaInstalled: boolean;
    assertCaptureRecoveryGlobalRelations(conn: PoolConnection, auditOnly?: boolean,
      startupPristineDormantRestore?: boolean): Promise<void>;
    activeCaptureEpochCutover(conn: PoolConnection, lock: string): Promise<null>;
    requireTenantTelemetryRefKey(): Buffer;
    assertTenantRestoreRuntimeProjection(conn: PoolConnection, lock: string): Promise<{
      control: { state: "active"; lineageKind: "restore"; restoreRunId: string; runtimeEpochSha256: string };
      heads: unknown[];
    }>;
    assertPersistedProviderCaptureProjection(conn: PoolConnection, lock: string): Promise<{
      domain: "logs"; state: "inactive"; controlGeneration: 0;
    }>;
    assertTenantBackupCatalogProjection(conn: PoolConnection, lock: string): Promise<{
      control: { state: "active" | "inactive" };
      replayRuns: Map<string, StubRestoreRun>;
      bindings: Map<string, BackupCatalog.TenantBackupRestoreSourceBinding>;
      reservations: Map<string, BackupCatalog.TenantBackupRuntimeReservation>;
    }>;
    loadTenantRestoreReplayRun(conn: PoolConnection, restoreRunId: string,
      lock: string): Promise<{ run: StubRestoreRun; row: SqlRow } | null>;
    loadTenantRestoreReplayEvidence(conn: PoolConnection, loaded: { run: StubRestoreRun; row: SqlRow },
      lock: string): Promise<{ receipt?: RestoreJournal.TenantRestoreReplayReceipt }>;
    assertPersistedFailureGlobalRelations(conn: PoolConnection): Promise<Map<string, unknown>>;
    assertTenantTelemetryWriterProjection(conn: PoolConnection): Promise<void>;
  }
  const emptyFamilies = [
    "tenant_telemetry_capture_v2_activation_receipts",
    "tenant_telemetry_capture_v2_coverages",
    "tenant_telemetry_capture_v2_source_bindings",
    "tenant_telemetry_capture_v2_failure_commit_receipts",
    "tenant_telemetry_capture_backup_checkpoints",
    "tenant_telemetry_capture_backup_checkpoint_leaves",
    "tenant_telemetry_capture_restore_bindings",
    "tenant_telemetry_capture_restore_history_receipts",
    "tenant_telemetry_capture_epoch_cutovers",
    "tenant_telemetry_capture_recovery_permits",
    "tenant_telemetry_capture_checkpoint_lineage_leaves",
    "tenant_telemetry_capture_recovery_permits_v2",
  ] as const;
  const materialFields = [
    "telemetry_capture_v2_operation_sha256",
    "telemetry_capture_v2_session_ref_sha256",
    "telemetry_capture_v2_turn_ref_sha256",
    "telemetry_capture_v2_item_ref_sha256",
    "telemetry_capture_v2_failure_receipt_sha256",
    "telemetry_capture_v2_business_batch_sha256",
  ] as const;
  const runtimeProbeSql = "SELECT state,lineage_kind FROM tenant_restore_runtime_control WHERE singleton_id=1";
  const captureProbeSql = "SELECT state FROM tenant_telemetry_capture_v2_controls WHERE domain='logs'";
  const bindingSql = "SELECT restore_run_id,backup_id,scope,protocol,"
    + "anchor_sha256,entry_sha256,source_snapshot_sha256,source_backup_sha256,"
    + "artifact_manifest_sha256,provider_evidence_sha256,control_evidence_sha256,"
    + "journal_control_evidence_sha256,sealed_target_root_sha256,runtime_epoch_sha256,"
    + "reservation_receipt_sha256,selected_catalog_sequence,selected_catalog_event_root_sha256,"
    + "bound_at_db_ms,binding_sha256 FROM backup_restore_source_bindings"
    + " WHERE BINARY restore_run_id=BINARY ? FOR SHARE";
  const reservationSql = "SELECT runtime_epoch_sha256,restore_run_id,backup_id,"
    + "scope,protocol,entry_sha256,binding_sha256,reservation_operation_sha256,"
    + "reservation_receipt_sha256,catalog_sequence,previous_catalog_event_root_sha256,"
    + "catalog_event_root_sha256,catalog_event_sha256,phase,reserved_at_db_ms,"
    + "resolution_operation_sha256,resolution_receipt_sha256,resolution_catalog_sequence,"
    + "resolution_previous_catalog_event_root_sha256,resolution_catalog_event_root_sha256,"
    + "resolution_catalog_event_sha256,resolved_at_db_ms,reservation_sha256"
    + " FROM backup_runtime_reservations WHERE BINARY restore_run_id=BINARY ? FOR SHARE";
  const subjectsSql = "SELECT telemetry_logs_capture_v2_generation FROM subject_lifecycle"
    + " ORDER BY tenant_id,subject_kind,subject_id FOR SHARE";
  const materialSql = (table: "items" | "events") =>
    "SELECT telemetry_failure_classification,telemetry_capture_v2_control_generation,"
    + materialFields.join(",") + " FROM " + table + " ORDER BY "
    + (table === "items" ? "item_id" : "session_id,seq") + " FOR SHARE";
  const jobsSql = "SELECT JSON_UNQUOTE(JSON_EXTRACT(inventory_json,'$.sourceSchema')) AS source_schema"
    + " FROM tenant_telemetry_write_jobs ORDER BY write_operation_sha256 FOR SHARE";
  const membershipsSql = "SELECT source_schema FROM tenant_telemetry_artifact_memberships"
    + " ORDER BY write_operation_sha256 FOR SHARE";
  const familySql = (table: string) => "SELECT 1 AS occupied FROM " + table + " FOR SHARE";
  const sqlKey = (sql: string) => sql.replace(/\s+/g, "").toLowerCase();
  const sqlRow = (record: object): SqlRow => Object.fromEntries(Object.entries(record)
    .map(([field, value]) => [field.replace(/[A-Z]/g, (letter) => "_" + letter.toLowerCase()), value]));

  function startupFixture() {
    const epoch = h("pristine-startup-restored-epoch");
    const reservationReceipt = h("pristine-startup-reservation-receipt");
    const selectedRoot = h("pristine-startup-selected-head");
    const bindingBody = {
      scope: BackupCatalog.TENANT_BACKUP_RESTORE_BINDING_SCOPE,
      protocol: BackupCatalog.TENANT_BACKUP_CATALOG_PROTOCOL,
      restoreRunId: runId, backupId,
      anchorSha256: h("pristine-startup-anchor"), entrySha256: h("pristine-startup-entry"),
      sourceSnapshotSha256: h("pristine-startup-snapshot"),
      sourceBackupSha256: h("pristine-startup-backup"),
      artifactManifestSha256: h("pristine-startup-manifest"),
      providerEvidenceSha256: h("pristine-startup-provider"),
      controlEvidenceSha256: h("pristine-startup-catalog-control"),
      journalControlEvidenceSha256: h("pristine-startup-journal-control"),
      sealedTargetRootSha256: h("pristine-startup-sealed-targets"),
      runtimeEpochSha256: epoch, reservationReceiptSha256: reservationReceipt,
      selectedCatalogSequence: 1, selectedCatalogEventRootSha256: selectedRoot, boundAtDbMs: 100,
    };
    const binding = { ...bindingBody,
      bindingSha256: BackupCatalog.tenantBackupRestoreSourceBindingSha256(bindingBody) };
    const reservationOperation = BackupCatalog.tenantBackupRuntimeReservationOperationSha256({
      backupId, restoreRunId: runId, entrySha256: binding.entrySha256, runtimeEpochSha256: epoch,
    });
    const catalogEventSha256 = BackupCatalog.tenantBackupCatalogEventSha256({
      eventType: "restore_reserved", operationSha256: reservationOperation, receiptSha256: reservationReceipt,
    });
    const reservationBody = {
      scope: BackupCatalog.TENANT_BACKUP_RUNTIME_RESERVATION_SCOPE,
      protocol: BackupCatalog.TENANT_BACKUP_CATALOG_PROTOCOL,
      restoreRunId: runId, backupId, entrySha256: binding.entrySha256,
      bindingSha256: binding.bindingSha256, runtimeEpochSha256: epoch,
      reservationOperationSha256: reservationOperation, reservationReceiptSha256: reservationReceipt,
      catalogSequence: 2, previousCatalogEventRootSha256: selectedRoot, catalogEventSha256,
      catalogEventRootSha256: BackupCatalog.tenantBackupCatalogNextEventRootSha256({
        catalogSequence: 2, previousCatalogEventRootSha256: selectedRoot, catalogEventSha256,
      }),
      reservedAtDbMs: 101,
    };
    const reservation = { ...reservationBody, phase: "reserved" as const,
      reservationSha256: BackupCatalog.tenantBackupRuntimeReservationSha256(reservationBody) };
    BackupCatalog.validateTenantBackupRestoreSourceBinding(binding);
    BackupCatalog.validateTenantBackupRuntimeReservation(reservation);
    const run: StubRestoreRun = { restoreRunId: runId, phase: "active", runtimeEpochSha256: epoch };
    const catalog = { control: { state: "active" as const },
      replayRuns: new Map([[runId, run]]), bindings: new Map([[runId, binding]]),
      reservations: new Map<string, BackupCatalog.TenantBackupRuntimeReservation>([[runId, reservation]]) };
    const reservationRow = sqlRow(reservation);
    for (const field of ["resolution_operation_sha256", "resolution_receipt_sha256",
      "resolution_catalog_sequence", "resolution_previous_catalog_event_root_sha256",
      "resolution_catalog_event_root_sha256", "resolution_catalog_event_sha256", "resolved_at_db_ms"]) {
      reservationRow[field] = null;
    }
    const responses = new Map<string, SqlRow[]>([
      [sqlKey(runtimeProbeSql), [{ state: "active", lineage_kind: "restore" }]],
      [sqlKey(captureProbeSql), [{ state: "inactive" }]],
      [sqlKey(bindingSql), [sqlRow(binding)]],
      [sqlKey(reservationSql), [reservationRow]],
      ...emptyFamilies.map((table): [string, SqlRow[]] => [sqlKey(familySql(table)), []]),
      [sqlKey(subjectsSql), [{ telemetry_logs_capture_v2_generation: 0 }]],
      [sqlKey(materialSql("items")), [{ telemetry_failure_classification: null,
        telemetry_capture_v2_control_generation: null,
        ...Object.fromEntries(materialFields.map((field) => [field, null])) }]],
      [sqlKey(materialSql("events")), [{ telemetry_failure_classification: "runtime_unknown",
        telemetry_capture_v2_control_generation: 0,
        ...Object.fromEntries(materialFields.map((field) => [field, null])) }]],
      [sqlKey(jobsSql), [{ source_schema: "legacy-fixture-v1" }]],
      [sqlKey(membershipsSql), [{ source_schema: "legacy-fixture-v1" }]],
    ]);
    const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
      const selected = sqlKey(sql);
      if (!/^\s*SELECT\b/i.test(sql) || !responses.has(selected)) {
        throw new Error("unexpected or mutating dormant-startup fixture SQL");
      }
      if (selected === sqlKey(bindingSql) || selected === sqlKey(reservationSql)) {
        expect(parameters).toEqual([runId]);
      } else expect(parameters).toBeUndefined();
      return [structuredClone(responses.get(selected)), []];
    });
    const connection = Object.freeze({ query }) as unknown as PoolConnection;
    const getConnection = vi.fn(() => { throw new Error("pure startup fixture must not acquire a connection"); });
    // The actual store/global audit and both exact-row codecs run. The complete runtime,
    // capture and catalog proof readers below are explicit doubles: this is neither an
    // actual MySQL transaction/range-lock proof nor external restore authorization.
    const store = Reflect.construct(MysqlSessionStore, [{ getConnection }]) as unknown as StartupAuditStore;
    store.tenantTelemetryCaptureEpochCutoverSchemaInstalled = true;
    store.tenantTelemetryCaptureRepeatRestoreSchemaInstalled = true;
    const strictFailure = new Error("strict-capture-audit-delegate-sentinel");
    const strict = vi.spyOn(store, "activeCaptureEpochCutover").mockRejectedValue(strictFailure);
    const protectedKey = vi.spyOn(store, "requireTenantTelemetryRefKey")
      .mockImplementation(() => { throw new Error("pristine startup must not read a protected key"); });
    const runtime = vi.spyOn(store, "assertTenantRestoreRuntimeProjection").mockResolvedValue({
      control: { state: "active", lineageKind: "restore", restoreRunId: runId, runtimeEpochSha256: epoch },
      heads: [],
    });
    const capture = vi.spyOn(store, "assertPersistedProviderCaptureProjection").mockResolvedValue({
      domain: "logs", state: "inactive", controlGeneration: 0,
    });
    const catalogProof = vi.spyOn(store, "assertTenantBackupCatalogProjection").mockResolvedValue(catalog);
    const currentRun = vi.spyOn(store, "loadTenantRestoreReplayRun").mockResolvedValue({ run, row: {} });
    const failures = vi.spyOn(store, "assertPersistedFailureGlobalRelations").mockResolvedValue(new Map());
    const writer = vi.spyOn(store, "assertTenantTelemetryWriterProjection").mockResolvedValue(undefined);
    const audit = (startup = true, auditOnly = false) =>
      store.assertCaptureRecoveryGlobalRelations(connection, auditOnly, startup);
    const setRows = (sql: string, rows: SqlRow[]) => { responses.set(sqlKey(sql), rows); };
    const noAuthority = () => {
      expect(protectedKey).not.toHaveBeenCalled(); expect(getConnection).not.toHaveBeenCalled();
    };
    return { store, connection, responses, query, strict, strictFailure, runtime, capture,
      catalogProof, currentRun, failures, writer, audit, setRows, noAuthority };
  }

  it("accepts only the explicit startup path after every exact current and empty-family read", async () => {
    const f = startupFixture();
    await expect(f.audit()).resolves.toBeUndefined();
    expect(f.query.mock.calls.map(([sql]) => sqlKey(sql))).toEqual([...f.responses.keys()]);
    expect(f.runtime).toHaveBeenCalledExactlyOnceWith(f.connection, "FOR SHARE");
    expect(f.capture).toHaveBeenCalledExactlyOnceWith(f.connection, "FOR SHARE");
    expect(f.catalogProof).toHaveBeenCalledExactlyOnceWith(f.connection, "FOR SHARE");
    expect(f.currentRun).toHaveBeenCalledExactlyOnceWith(f.connection, runId, "FOR SHARE");
    expect(f.failures).toHaveBeenCalledExactlyOnceWith(f.connection);
    expect(f.writer).toHaveBeenCalledExactlyOnceWith(f.connection);
    expect(f.strict).not.toHaveBeenCalled();
    f.noAuthority();
  });

  it.each([false, true])("does not waive the existing non-startup audit (auditOnly=%s)", async (auditOnly) => {
    const f = startupFixture();
    await expect(f.audit(false, auditOnly)).rejects.toBe(f.strictFailure);
    expect(f.strict).toHaveBeenCalledExactlyOnceWith(f.connection, "FOR SHARE");
    expect(f.query).not.toHaveBeenCalled(); expect(f.capture).not.toHaveBeenCalled();
    f.noAuthority();
  });

  it("does not waive active capture and invokes the original strict delegate", async () => {
    const f = startupFixture();
    f.setRows(captureProbeSql, [{ state: "active" }]);
    await expect(f.audit()).rejects.toBe(f.strictFailure);
    expect(f.strict).toHaveBeenCalledExactlyOnceWith(f.connection, "FOR SHARE");
    expect(f.runtime).not.toHaveBeenCalled();
    f.noAuthority();
  });

  it.each(emptyFamilies)("rejects any occupied %s instead of interpreting missing current cutover as pristine", async (table) => {
    const f = startupFixture();
    f.setRows(familySql(table), [{ occupied: 1 }]);
    await expect(f.audit()).rejects.toBeInstanceOf(codec.TenantTelemetryCaptureRestoreIntegrityError);
    expect(f.query).toHaveBeenCalledWith(familySql(table));
    expect(f.strict).not.toHaveBeenCalled(); expect(f.writer).not.toHaveBeenCalled();
    f.noAuthority();
  });

  it.each([runtimeProbeSql, captureProbeSql])("rejects a missing control probe rather than accepting empty evidence: %s", async (sql) => {
    const f = startupFixture();
    f.setRows(sql, []);
    await expect(f.audit()).rejects.toBeInstanceOf(codec.TenantTelemetryCaptureRestoreIntegrityError);
    expect(f.strict).not.toHaveBeenCalled(); expect(f.runtime).not.toHaveBeenCalled();
    f.noAuthority();
  });

  it("propagates malformed inactive control proof instead of trusting the cheap inactive probe", async () => {
    const f = startupFixture();
    const invalid = new codec.TenantTelemetryCaptureRestoreIntegrityError();
    f.capture.mockRejectedValue(invalid);
    await expect(f.audit()).rejects.toBe(invalid);
    expect(f.capture).toHaveBeenCalledExactlyOnceWith(f.connection, "FOR SHARE");
    expect(f.strict).not.toHaveBeenCalled(); expect(f.catalogProof).not.toHaveBeenCalled();
    f.noAuthority();
  });

  it.each([bindingSql, reservationSql])("rejects a missing current selected row despite its snapshot projection: %s", async (sql) => {
    const f = startupFixture();
    f.setRows(sql, []);
    await expect(f.audit()).rejects.toBeInstanceOf(codec.TenantTelemetryCaptureRestoreIntegrityError);
    expect(f.strict).not.toHaveBeenCalled(); expect(f.failures).not.toHaveBeenCalled();
    f.noAuthority();
  });

  it.each(["items", "events"] as const)("rejects runtime_unknown with NULL generation in %s", async (table) => {
    const f = startupFixture();
    f.setRows(materialSql(table), [{ telemetry_failure_classification: "runtime_unknown",
      telemetry_capture_v2_control_generation: null,
      ...Object.fromEntries(materialFields.map((field) => [field, null])) }]);
    await expect(f.audit()).rejects.toBeInstanceOf(codec.TenantTelemetryCaptureRestoreIntegrityError);
    expect(f.strict).not.toHaveBeenCalled(); expect(f.failures).not.toHaveBeenCalled();
    f.noAuthority();
  });

  it("rejects private source material even when classification and generation are legacy NULL", async () => {
    const f = startupFixture();
    f.setRows(materialSql("items"), [{ telemetry_failure_classification: null,
      telemetry_capture_v2_control_generation: null,
      ...Object.fromEntries(materialFields.map((field) => [field, null])),
      telemetry_capture_v2_operation_sha256: h("nonpristine-source") }]);
    await expect(f.audit()).rejects.toBeInstanceOf(codec.TenantTelemetryCaptureRestoreIntegrityError);
    expect(f.strict).not.toHaveBeenCalled();
    f.noAuthority();
  });

  it.each([null, 1, "invalid"])("rejects a malformed or nonzero subject generation: %s", async (generation) => {
    const f = startupFixture();
    f.setRows(subjectsSql, [{ telemetry_logs_capture_v2_generation: generation }]);
    await expect(f.audit()).rejects.toBeInstanceOf(codec.TenantTelemetryCaptureRestoreIntegrityError);
    expect(f.strict).not.toHaveBeenCalled();
    f.noAuthority();
  });

  it.each([jobsSql, membershipsSql])("rejects a v2 source in an otherwise empty projection: %s", async (sql) => {
    const f = startupFixture();
    f.setRows(sql, [{ source_schema: "provider-step-error-v2" }]);
    await expect(f.audit()).rejects.toBeInstanceOf(codec.TenantTelemetryCaptureRestoreIntegrityError);
    expect(f.strict).not.toHaveBeenCalled(); expect(f.failures).not.toHaveBeenCalled();
    f.noAuthority();
  });

  const inactiveCatalogFamilies = [
    "backup_catalog_external_events", "backup_snapshot_anchors", "backup_catalog_entries",
    "backup_restore_source_bindings", "backup_runtime_reservations", "backup_catalog_evictions",
  ] as const;
  const activationEpochSql = "SELECT control_generation FROM tenant_restore_runtime_events"
    + " WHERE singleton_id=1 AND activation_epoch_sha256=?"
    + " AND BINARY activation_epoch_sha256=BINARY ? AND update_kind='restore_activation' FOR SHARE";
  const activationEventSql = "SELECT singleton_id,'active' AS state,"
    + " control_generation,update_kind,lineage_kind,activated_at_db_ms,updated_at_db_ms,"
    + " restore_run_id,replay_receipt_sha256,runtime_epoch_sha256,control_evidence_sha256,"
    + " logical_database_namespace_sha256,target_count,target_root_sha256,"
    + " verified_head_root_sha256,previous_control_evidence_sha256,evidence_sha256"
    + " FROM tenant_restore_runtime_events WHERE singleton_id=1 AND control_generation=? FOR SHARE";
  function genericStartupFixture() {
    const f = startupFixture(), official = officialRestoreRuntimeFixture();
    const run: Extract<RestoreJournal.TenantRestoreReplayRunRecord, { phase: "active" }> = {
      restoreRunId: official.replay.restoreRunId, sourceBackupSha256: official.replay.sourceBackupSha256,
      runtimeEpochSha256: official.replay.runtimeEpochSha256, protocol: official.replay.protocol,
      controlEvidenceSha256: official.replay.controlEvidenceSha256, adapterProtocol: official.replay.adapterProtocol,
      journalNamespaceSha256: official.replay.journalNamespaceSha256,
      logicalDatabaseNamespaceSha256: official.replay.logicalDatabaseNamespaceSha256,
      targetCount: official.replay.targetCount, targetRootSha256: official.replay.targetRootSha256,
      sealedTargetRootSha256: official.replay.sealedTargetRootSha256,
      expectedEntryCount: official.replay.entryCount, entryCount: official.replay.entryCount,
      entryRootSha256: official.replay.entryRootSha256, fenceCount: official.replay.fenceCount,
      fenceRootSha256: official.replay.fenceRootSha256, phase: "active", createdAtDbMs: 1_000,
      updatedAtDbMs: official.runtime.activatedAtDbMs, sealedAtDbMs: official.replay.storeDbTimestampMs,
      activatedAtDbMs: official.runtime.activatedAtDbMs, terminalReceiptSha256: official.replay.receiptSha256,
    };
    RestoreJournal.validateTenantRestoreReplayRunRecord(run);
    const mutable = officialRuntimeSuccessor(official.runtime, h("generic-later-published-head"));
    f.runtime.mockResolvedValue({ control: mutable, heads: [] });
    f.catalogProof.mockResolvedValue({ control: { state: "inactive" },
      replayRuns: new Map([[runId, run]]), bindings: new Map(), reservations: new Map() });
    f.currentRun.mockResolvedValue({ run, row: {} });
    const evidence = vi.spyOn(f.store, "loadTenantRestoreReplayEvidence").mockResolvedValue({ receipt: official.replay });
    for (const table of inactiveCatalogFamilies) f.setRows(familySql(table), []);
    f.setRows(activationEpochSql, [{ control_generation: official.runtime.controlGeneration }]);
    f.setRows(activationEventSql, [sqlRow(official.runtime)]);
    // The immutable event uses the actual row codec. Full runtime and replay
    // readers above are explicit doubles, not native locking/source proof.
    const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
      if (sqlKey(sql) === sqlKey(activationEpochSql)) {
        expect(parameters).toEqual([run.runtimeEpochSha256, run.runtimeEpochSha256]);
      } else if (sqlKey(sql) === sqlKey(activationEventSql)) {
        expect(parameters).toEqual([official.runtime.controlGeneration]);
      } else return f.query(sql, parameters);
      return [structuredClone(f.responses.get(sqlKey(sql))), []];
    });
    const connection = Object.freeze({ query }) as unknown as PoolConnection;
    const audit = (startup = true, auditOnly = false) =>
      f.store.assertCaptureRecoveryGlobalRelations(connection, auditOnly, startup);
    return { ...f, connection, query, audit, official, run, mutable, evidence };
  }

  it("accepts a pristine generic 0030 restore with inactive catalog after its mutable journal head advances", async () => {
    const f = genericStartupFixture();
    expect(f.mutable.verifiedHeadRootSha256).not.toBe(f.run.sealedTargetRootSha256);
    expect(f.mutable.controlGeneration).toBeGreaterThan(f.official.runtime.controlGeneration);
    await expect(f.audit()).resolves.toBeUndefined();
    expect(f.currentRun).toHaveBeenCalledExactlyOnceWith(f.connection, runId, "FOR SHARE");
    expect(f.evidence).toHaveBeenCalledExactlyOnceWith(f.connection, { run: f.run, row: {} }, "FOR SHARE");
    expect(f.query.mock.calls.map(([sql]) => sqlKey(sql))).toEqual([runtimeProbeSql, captureProbeSql,
      ...inactiveCatalogFamilies.map(familySql), activationEpochSql, activationEventSql,
      ...emptyFamilies.map(familySql), subjectsSql, materialSql("items"), materialSql("events"),
      jobsSql, membershipsSql].map(sqlKey));
    expect(f.failures).toHaveBeenCalledExactlyOnceWith(f.connection);
    expect(f.writer).toHaveBeenCalledExactlyOnceWith(f.connection);
    expect(f.strict).not.toHaveBeenCalled(); f.noAuthority();
  });
  it.each(inactiveCatalogFamilies)("rejects current occupied inactive catalog family %s despite a pristine snapshot", async (table) => {
    const f = genericStartupFixture(); f.setRows(familySql(table), [{ occupied: 1 }]);
    await expect(f.audit()).rejects.toBeInstanceOf(codec.TenantTelemetryCaptureRestoreIntegrityError);
    expect(f.query).toHaveBeenCalledWith(familySql(table));
    expect(f.currentRun).not.toHaveBeenCalled(); expect(f.writer).not.toHaveBeenCalled(); f.noAuthority();
  });
  it.each(["missing", "wrong_epoch"] as const)("rejects %s current generic replay run instead of trusting its snapshot", async (kind) => {
    const f = genericStartupFixture();
    f.currentRun.mockResolvedValue(kind === "missing" ? null
      : { run: { ...f.run, runtimeEpochSha256: h("wrong-generic-epoch") }, row: {} });
    await expect(f.audit()).rejects.toBeInstanceOf(codec.TenantTelemetryCaptureRestoreIntegrityError);
    expect(f.evidence).not.toHaveBeenCalled(); expect(f.writer).not.toHaveBeenCalled(); f.noAuthority();
  });
  it("propagates the original generic replay evidence failure without granting the startup exception", async () => {
    const f = genericStartupFixture(), failure = new Error("original-replay-evidence-failure");
    f.evidence.mockRejectedValue(failure); await expect(f.audit()).rejects.toBe(failure);
    expect(f.writer).not.toHaveBeenCalled(); f.noAuthority();
  });
  it.each(["missing", "wrong_receipt"] as const)("rejects %s generic replay receipt before reading its activation", async (kind) => {
    const f = genericStartupFixture();
    f.evidence.mockResolvedValue(kind === "missing" ? {} : {
      receipt: { ...f.official.replay, receiptSha256: h("wrong-generic-receipt") },
    });
    await expect(f.audit()).rejects.toBeInstanceOf(codec.TenantTelemetryCaptureRestoreIntegrityError);
    expect(f.query.mock.calls.some(([sql]) => sqlKey(sql) === sqlKey(activationEpochSql))).toBe(false);
    expect(f.writer).not.toHaveBeenCalled(); f.noAuthority();
  });
  it.each(["missing", "duplicate", "wrong_epoch", "wrong_receipt", "wrong_head"] as const)("rejects %s immutable generic restore activation", async (kind) => {
    const f = genericStartupFixture();
    if (kind === "missing" || kind === "duplicate") {
      f.setRows(activationEpochSql, kind === "missing" ? [] : [
        { control_generation: f.official.runtime.controlGeneration },
        { control_generation: f.official.runtime.controlGeneration },
      ]);
    } else {
      const patch: Partial<Omit<RestoreRuntime, "evidenceSha256">> = kind === "wrong_epoch"
        ? { runtimeEpochSha256: h("wrong-immutable-epoch") }
        : kind === "wrong_receipt" ? { replayReceiptSha256: h("wrong-immutable-receipt") }
        : { verifiedHeadRootSha256: h("wrong-immutable-sealed-head") };
      f.setRows(activationEventSql, [sqlRow(signedRuntimePatch(f.official.runtime, patch))]);
    }
    await expect(f.audit()).rejects.toBeInstanceOf(codec.TenantTelemetryCaptureRestoreIntegrityError);
    expect(f.writer).not.toHaveBeenCalled(); f.noAuthority();
  });
  it.each([false, true])("does not waive non-startup generic restore audit (auditOnly=%s)", async (auditOnly) => {
    const f = genericStartupFixture();
    await expect(f.audit(false, auditOnly)).rejects.toBe(f.strictFailure);
    expect(f.strict).toHaveBeenCalledExactlyOnceWith(f.connection, "FOR SHARE");
    expect(f.query).not.toHaveBeenCalled(); expect(f.evidence).not.toHaveBeenCalled(); f.noAuthority();
  });
  it("still rejects capture history after the inactive generic catalog proof succeeds", async () => {
    const f = genericStartupFixture();
    f.setRows(familySql("tenant_telemetry_capture_restore_history_receipts"), [{ occupied: 1 }]);
    await expect(f.audit()).rejects.toBeInstanceOf(codec.TenantTelemetryCaptureRestoreIntegrityError);
    expect(f.evidence).toHaveBeenCalledExactlyOnceWith(f.connection, { run: f.run, row: {} }, "FOR SHARE");
    expect(f.writer).not.toHaveBeenCalled(); f.noAuthority();
  });
});
