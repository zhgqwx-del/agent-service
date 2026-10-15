import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tenantTelemetryRefKeyIdSha256 } from "../src/tenant-telemetry-lifecycle.js";
import * as codec from "../src/tenant-telemetry-capture-restore.js";
import { validatePreflightTenantRestoreReplayFromBackupInput } from "../src/backup-catalog.js";
import { readTenantTelemetryCaptureCheckpointFromMysql } from "../src/mysql/tenant-telemetry-capture-checkpoint.js";
import type { Connection } from "mysql2/promise";

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
    originalPayloadEvidenceHmacSha256: evidence("write_payload"), originalMembershipEvidenceHmacSha256: evidence("membership"),
    originalSourceBindingEvidenceHmacSha256: evidence("provider_source_binding"), originalFailureEvidenceHmacSha256: evidence("provider_failure_commit"),
    originalReservationReceiptSha256: state === "reserved" ? h("original-reservation-receipt") : null,
    originalReservationEvidenceHmacSha256: state === "reserved" ? evidence("write_reservation") : null,
    originalReservationClaimAttempt: state === "reserved" ? 2 : null, originalReservationClaimTokenSha256: state === "reserved" ? h("reservation-old-token") : null,
    previousClaimAttempt: 3, previousClaimTokenSha256: h("previous-claim-token"), previousClaimLeaseUntilMs: 1_300,
    newClaimAttempt: 4, newClaimTokenSha256: h("new-claim-token"), newClaimLeaseUntilMs: 2_400, issuedAtDbMs: 1_400,
    recoveryMode: state === "reserved" ? "resume_reserved" : "resume_queued" };
  const context = { key, checkpoint, history, cutover, originalLeaves: leaves, activationBinding: binding,
    recoveryBinding: { input: recoveryInput, storeDbTimestampMs: 1_500 } };
  return { leaves, checkpoint, binding, history, cutoverInput, cutover, recoveryInput, context };
}
const rejected = (work: () => unknown) => expect(work).toThrow(codec.TenantTelemetryCaptureRestoreIntegrityError);
const createPermit = (f: ReturnType<typeof fixture>, input = f.recoveryInput) =>
  codec.createTenantTelemetryCaptureOperationRecoveryPermit(input, f.cutover, f.history, f.checkpoint, f.leaves, key);

describe("actual MySQL checkpoint reader boundary (pure driver doubles, not DB proof)", () => {
  function source() {
    const f = fixture();
    const header = { backup_id: backupId, anchor_sha256: f.checkpoint.anchorSha256,
      checkpoint_sha256: f.checkpoint.checkpointSha256, ref_key_id_sha256: f.checkpoint.refKeyIdSha256,
      sealed_at_db_ms: f.checkpoint.sealedAtDbMs, checkpoint_json: f.checkpoint };
    const rows = f.leaves.map((row) => ({ backup_id: backupId, family: row.family,
      identity_ref_sha256: row.identityRefSha256, record_hmac_sha256: row.recordHmacSha256,
      knowledge: row.knowledge, state: row.state, source_high_water_db_ms: row.sourceHighWaterDbMs }));
    const calls: { sql: string; parameters: unknown[] }[] = [];
    let headers: unknown[] = [header], leaves: unknown[] = rows;
    const executor = { async query(sql: string, parameters: unknown[]) {
      calls.push({ sql, parameters });
      return [sql.includes("FROM tenant_telemetry_capture_backup_checkpoint_leaves") ? leaves : headers, []];
    } } as unknown as Connection;
    return { ...f, header, rows, executor, calls,
      setHeaders: (value: unknown[]) => { headers = value; },
      setLeaves: (value: unknown[]) => { leaves = value; } };
  }
  it("reads every persisted leaf from the supplied connection and returns an isolated snapshot", async () => {
    const f = source();
    const result = await readTenantTelemetryCaptureCheckpointFromMysql(f.executor, backupId, key);
    expect(result).toEqual({ checkpoint: f.checkpoint, leaves: f.leaves });
    expect(result!.checkpoint).not.toBe(f.checkpoint);
    expect(f.calls).toHaveLength(2);
    for (const call of f.calls) {
      expect(call.parameters).toEqual([backupId]);
      expect(call.sql).not.toContain(backupId);
    }
    expect(f.calls[1]!.sql).toContain(`LIMIT ${codec.TENANT_TELEMETRY_CAPTURE_RESTORE_MAX_LEAVES + 1}`);
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
      const current = { input: { ...f.recoveryInput, [field]: h(`different-current-${field}`) }, storeDbTimestampMs: 1_500 };
      rejected(() => codec.assertTenantTelemetryCaptureOperationRecoveryBinding(permit, current));
    }
    rejected(() => codec.assertTenantTelemetryCaptureOperationRecoveryBinding(permit, { ...f.context.recoveryBinding, storeDbTimestampMs: 2_400 }));
    rejected(() => codec.assertTenantTelemetryCaptureOperationRecoveryBinding(permit, { ...f.context.recoveryBinding, storeDbTimestampMs: 1_399 }));
    const context: codec.TenantTelemetryCaptureRestoreRecordContext = { ...f.context }; delete context.recoveryBinding;
    rejected(() => codec.encodeTenantTelemetryCaptureRestoreRecord(permit, context));
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
