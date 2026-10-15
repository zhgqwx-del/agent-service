import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import mysql, { type ResultSetHeader, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TenantRestoreJournalPublicationWorker, TenantRuntimeCoordinator } from "@agent-service/core";
import { LocalAesGcmCipher, ProviderService } from "@agent-service/providers";
import {
  DEFAULT_AUTH_POLICY,
  persistedProviderCaptureConfiguredFleetRootSha256,
  tenantRuntimeFleetSha256,
  tenantRuntimeLocalReceiptSha256,
  tenantRuntimeTargetReceiptsSha256,
  tenantRuntimeTargetSha256,
} from "@agent-service/protocol";
import {
  MysqlSessionStore,
  TenantCredentialResponsibilityIntegrityError,
  newErasureRequestId,
  newTenantBackupEvictionId,
  newTenantBackupId,
  tenantErasureRequestHash,
  s3TenantTelemetryTargetIdentity,
  readTenantTelemetryCaptureCheckpointFromMysql,
  type TenantBackupRuntimeReservation,
} from "@agent-service/store";
import {
  createTenantBackupCatalogAdapter,
  loadTenantBackupCatalogConfig,
} from "../src/tenant-backup-catalog-config.js";
import {
  createTenantRestoreJournalAdapters,
  loadTenantRestoreJournalConfig,
} from "../src/tenant-restore-journal-config.js";
import * as artifactOperations from "../src/mysql-backup-artifact.js";
import type { BackupCatalogCliDependencies } from "../src/backup-catalog-cli.js";
import {
  MySqlBackupArtifactFixture,
  backupArtifactIntegrationEnabled,
  loseOneCatalogResponse,
  type CapturedCommand,
  type MySqlBackupSchemaDifference,
  type MySqlBackupSchemaSnapshot,
} from "../../../packages/store/test/mysql-backup-artifact-test-helper.js";

const describeIntegration = backupArtifactIntegrationEnabled ? describe : describe.skip;
const SHA256 = /^[0-9a-f]{64}$/;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function artifactPath(fixture: MySqlBackupArtifactFixture, backupId = fixture.backupId): string {
  return join(fixture.artifactDirectory, `${backupId}.asmbak`);
}

function manifest(bytes: Buffer): Record<string, unknown> {
  expect(bytes.subarray(0, 8).toString("ascii")).toBe("ASMYSQL1");
  const length = bytes.readUInt32BE(8);
  expect(length).toBeGreaterThan(0);
  expect(length).toBeLessThan(bytes.length - 12);
  return JSON.parse(bytes.subarray(12, 12 + length).toString("utf8")) as Record<string, unknown>;
}

function externalReservationIdentity(reservation: TenantBackupRuntimeReservation | null) {
  if (!reservation) throw new Error("fixture_external_reservation_missing");
  // A restored DB uses its own current DB time for the new local binding/seal.
  // The permanent external authority, not those local reconstruction timestamps,
  // must be reused byte-for-byte; this matches the established 0031 roundtrip.
  return {
    backupId: reservation.backupId, restoreRunId: reservation.restoreRunId,
    entrySha256: reservation.entrySha256, runtimeEpochSha256: reservation.runtimeEpochSha256,
    reservationOperationSha256: reservation.reservationOperationSha256,
    reservationReceiptSha256: reservation.reservationReceiptSha256,
    catalogSequence: reservation.catalogSequence,
    previousCatalogEventRootSha256: reservation.previousCatalogEventRootSha256,
    catalogEventRootSha256: reservation.catalogEventRootSha256,
    catalogEventSha256: reservation.catalogEventSha256,
  };
}

describeIntegration("product MySQL backup artifacts with real MySQL and MinIO", () => {
  let fixture: MySqlBackupArtifactFixture;
  let baseline: Record<string, unknown>;
  let originalArtifact: Buffer;
  let expectedSourceSchema: MySqlBackupSchemaSnapshot;

  async function expectPrivate(result: CapturedCommand): Promise<void> {
    const output = result.stdout + result.stderr;
    const key = await readFile(fixture.keyFile);
    try {
      for (const forbidden of [
        fixture.payloadCanary,
        fixture.sourceUrl,
        fixture.privateDirectory,
        decodeURIComponent(fixture.base.password),
        process.env.S3_TEST_ACCESS_KEY_ID ?? "",
        process.env.S3_TEST_SECRET_ACCESS_KEY ?? "",
        key.toString("hex"),
        key.toString("base64"),
      ]) {
        // Assertion failure must not print the forbidden credential as its expected value.
        if (forbidden) expect(output.includes(forbidden), "closed output must not expose fixture private material").toBe(false);
      }
    } finally { key.fill(0); }
  }

  async function success(result: CapturedCommand, schemaDifference?: MySqlBackupSchemaDifference): Promise<Record<string, unknown>> {
    await expectPrivate(result);
    expect(result.status, JSON.stringify({ error: result.stderr, diagnostic: result.failureDiagnostic, schemaDifference })).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(result.value).toMatchObject({ status: "ok" });
    return result.value!;
  }

  async function failure(result: CapturedCommand): Promise<void> {
    await expectPrivate(result);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    const body = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(body).toMatchObject({ status: "error" });
    const keys = Object.keys(body).sort();
    if (body.reservationMayBeConsumed === true) {
      expect(body).toMatchObject({ requiresManualForwardFix: true, runtimeActivated: false });
      expect(typeof body.targetMayContainPartialImport).toBe("boolean");
      expect(keys).toEqual([
        "code", "requiresManualForwardFix", "reservationMayBeConsumed", "runtimeActivated",
        "status", "targetMayContainPartialImport",
      ]);
    } else expect(keys).toEqual(["code", "status"]);
  }

  async function storeAt<T>(url: string, action: (store: MysqlSessionStore) => Promise<T>): Promise<T> {
    const store = await MysqlSessionStore.connect({ url, connectionLimit: 2, migrationMode: "verify" });
    try { return await action(store); } finally { await store.close(); }
  }

  async function clonedArtifact(bytes: Buffer): Promise<string> {
    const directory = join(fixture.privateDirectory, `bad-artifact-${randomUUID()}`);
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, `${fixture.backupId}.asmbak`), bytes, {
      mode: 0o600, flag: "wx",
    });
    return directory;
  }

  async function independentFixture(action: () => Promise<void>): Promise<void> {
    // Mutating operator scenarios get their own database, key, catalog, journal, and artifact.
    // The shared fixture is read-only and every scenario may also be selected with Vitest -t.
    const previous = { fixture, baseline, originalArtifact, expectedSourceSchema };
    const isolated = new MySqlBackupArtifactFixture();
    fixture = isolated;
    try {
      await fixture.setup();
      baseline = await success(await fixture.command("create-artifact"));
      originalArtifact = await readFile(artifactPath(fixture));
      expectedSourceSchema = await fixture.schemaSnapshot();
      const sourceValid = expectedSourceSchema.schemaSha256 === manifest(originalArtifact).schemaSha256;
      expect(sourceValid, JSON.stringify({ sourceValid })).toBe(true);
      await action();
    } finally {
      try { await isolated.cleanup(); }
      finally {
        fixture = previous.fixture;
        baseline = previous.baseline;
        originalArtifact = previous.originalArtifact;
        expectedSourceSchema = previous.expectedSourceSchema;
      }
    }
  }

  // These are actual MySQL rows, not a new checkpoint family or a replacement
  // responsibility codec. Only opaque digests/counts can reach assertion output.
  const responsibilityTables = [
    "tenant_credential_responsibility_sources", "tenant_credential_responsibility_entries",
    "tenant_credential_responsibility_receipts", "tenant_credential_versions",
    "tenant_credential_target_dispositions", "tenant_credential_provider_slots",
    "tenant_credential_inventory_receipts", "tenant_credential_revocation_fences",
    "tenant_credential_revocation_jobs", "tenant_credential_revocation_receipts",
    "tenant_erasure_admissions", "tenant_runtime_revocation_jobs",
    "tenant_runtime_revocation_target_receipts", "tenant_runtime_revocation_receipts",
  ] as const;

  async function responsibilityRows(url: string, tenantId: string) {
    const connection = await mysql.createConnection(url);
    try {
      const rows = await Promise.all(responsibilityTables.map(async (table) => {
        const [columns] = await connection.query<RowDataPacket[]>(
          "SELECT COLUMN_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX",
          [table],
        );
        const names = columns.map((column) => {
          if (typeof column.name !== "string" || !/^[a-z_][a-z0-9_]*$/.test(column.name)) {
            throw new Error("responsibility_fixture_primary_key_invalid");
          }
          return `\`${column.name}\``;
        });
        if (!names.length) throw new Error("responsibility_fixture_primary_key_missing");
        const [actual] = await connection.query<RowDataPacket[]>(
          `SELECT * FROM \`${table}\` WHERE tenant_id=? ORDER BY ${names.join(",")}`, [tenantId],
        );
        return [table, { count: actual.length, sha256: sha256(Buffer.from(JSON.stringify(actual))) }] as const;
      }));
      return Object.fromEntries(rows);
    } finally { await connection.end(); }
  }

  async function checkpointRows(url: string, backupId: string) {
    const connection = await mysql.createConnection(url);
    try {
      const [header] = await connection.query<RowDataPacket[]>(
        "SELECT * FROM tenant_telemetry_capture_backup_checkpoints WHERE backup_id=?", [backupId],
      );
      const [leaves] = await connection.query<RowDataPacket[]>(
        "SELECT * FROM tenant_telemetry_capture_backup_checkpoint_leaves WHERE backup_id=? ORDER BY family,identity_ref_sha256", [backupId],
      );
      const [lineage] = await connection.query<RowDataPacket[]>(
        "SELECT * FROM tenant_telemetry_capture_checkpoint_lineage_leaves WHERE backup_id=? ORDER BY family,identity_ref_sha256", [backupId],
      );
      expect(header).toHaveLength(1);
      expect(leaves.length).toBeGreaterThan(0);
      return { header: sha256(Buffer.from(JSON.stringify(header))),
        leaves: sha256(Buffer.from(JSON.stringify(leaves))),
        lineage: sha256(Buffer.from(JSON.stringify(lineage))) };
    } finally { await connection.end(); }
  }

  async function nonemptyResponsibilitySource() {
    const refKey = randomBytes(32), keyFile = join(fixture.privateDirectory, "byok-ref-key.bin");
    await writeFile(keyFile, refKey, { mode: 0o600, flag: "wx" });
    const tenantId = `${fixture.tenantId}-byok`, requestId = newErasureRequestId();
    const origin = "http://127.0.0.1:18080";
    const fleetRoot = persistedProviderCaptureConfiguredFleetRootSha256([
      { url: origin, runnerId: "byok-artifact-fixture-runner" },
    ]);
    const options = { url: fixture.sourceUrl, connectionLimit: 2, migrationMode: "verify" as const,
      tenantTelemetryRefKey: refKey, tenantTelemetryPersistedProviderCaptureLocalOnly: true,
      tenantTelemetryCaptureRestoreLocalOnly: true };
    const store = await MysqlSessionStore.connect(options);
    let publisher: TenantRestoreJournalPublicationWorker | undefined;
    try {
      await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
      // The real primary/journal already exists. Activate only the empty capture
      // substrate; no telemetry object or provider-management request is made.
      await store.activateTenantTelemetryLifecycle({ expectedControlGeneration: 0,
        targets: (["logs", "traces"] as const).map((domain) => ({ domain,
          ...s3TenantTelemetryTargetIdentity({ namespaceId: `byok-${fixture.runId}`,
            failureDomainId: `fixture-${fixture.runId}`, bucket: fixture.catalogBucket,
            prefix: `${fixture.catalogPrefix}/telemetry`, region: process.env.S3_TEST_REGION!,
            endpoint: process.env.S3_TEST_ENDPOINT!,
            forcePathStyle: process.env.S3_TEST_FORCE_PATH_STYLE === "1", domain,
            allowInsecureHttpForLocalTest: true }) })) });
      const lifecycle = await store.getTenantTelemetryLifecycleControl();
      if (lifecycle.state !== "active") throw new Error("responsibility_fixture_lifecycle_missing");
      const logs = (await store.listTenantTelemetryLifecycleTargets()).find((target) => target.domain === "logs");
      if (!logs) throw new Error("responsibility_fixture_logs_target_missing");
      await store.withTenantTelemetryCaptureOperatorFence((fence) => store.activateTenantTelemetryPersistedProviderCapture({
        expectedControlGeneration: 0, lifecycleControlEvidenceSha256: lifecycle.activationEvidenceSha256,
        logsTargetSha256: logs.targetSha256, logsTargetReceiptSha256: logs.receiptSha256,
        configuredFleetRootSha256: fleetRoot, fleetStoppedAck: "fleet-stopped-v1",
        legacyWritersDrainedAck: "legacy-writers-drained-v1", producerReadyAck: "provider-step-error-v2-ready-v1",
        localOnlyAck: "local-only-v1",
      }, fence), { timeoutMs: 5_000 });
      await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
      const coordinator = new TenantRuntimeCoordinator();
      const outbound = vi.fn<typeof fetch>(async () => { throw new Error("unexpected_byok_fixture_fetch"); });
      const cipher = new LocalAesGcmCipher(randomBytes(32).toString("hex"), "byok-shared-envelope-fixture");
      const providers = new ProviderService({ store, cipher, tenantRuntime: coordinator, fetch: outbound,
        assertBaseUrl: async () => {} });
      coordinator.sealParticipants();
      const apiKey = `byok-fixture-${randomUUID()}`;
      await providers.upsertTenantProvider(tenantId, { id: "byok", api: "openai-completions",
        baseUrl: "https://byok-artifact.invalid/v1", headers: {}, quota: {}, fallback: [], apiKey,
        models: [{ id: "model", contextWindow: 1_000, maxOutputTokens: 10, input: ["text"], reasoning: false }] });
      const model = await providers.resolve({ tenantId, userId: "byok-fixture-user" }, { provider: "byok", model: "model" });
      expect((await model.apiKey()) === apiKey, "actual encrypted provider key must roundtrip").toBe(true);
      const journalConfig = loadTenantRestoreJournalConfig(fixture.journalEnv(), { production: false, store: "mysql" });
      if (!journalConfig) throw new Error("responsibility_fixture_journal_missing");
      publisher = new TenantRestoreJournalPublicationWorker({ store,
        adapters: createTenantRestoreJournalAdapters(journalConfig), canExecute: async () => true,
        logger: { warn: () => {} } });
      expect(await store.requestTenantErasure({ tenantId, requestId, requestedByKeyId: "byok-fixture-operator",
        idempotencyKey: `byok-artifact-${randomUUID()}`, requestHash: tenantErasureRequestHash(tenantId), atMs: Date.now() }))
        .toMatchObject({ status: "gated", generation: 1 });
      expect(await publisher.processOnce()).toBe(1);
      expect((await store.getTenantRestoreJournalPublicationBundle(tenantId, requestId))?.receipt)
        .toMatchObject({ restoreFencePublicationComplete: true, allDomainsComplete: false });
      let credentialClaim: Awaited<ReturnType<MysqlSessionStore["claimTenantCredentialRevocations"]>>[number] | undefined;
      const due = Date.now() + 2_000;
      while (!credentialClaim && Date.now() < due) {
        credentialClaim = (await store.claimTenantCredentialRevocations({ limit: 10, leaseMs: 120_000,
          claimToken: `byok-artifact-${randomUUID()}` })).find((claim) => claim.requestId === requestId);
        if (!credentialClaim) await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      if (!credentialClaim) throw new Error("responsibility_fixture_t3a_claim_missing");
      const t3a = await store.revokeTenantCredentialMaterial({ tenantId, requestId,
        subjectGeneration: credentialClaim.subjectGeneration, claimAttempt: credentialClaim.claimAttempt,
        claimToken: credentialClaim.claimToken });
      expect(t3a).not.toBeNull();
      expect(await store.materializeTenantRuntimeRevocationJobs({ limit: 10 })).toBe(1);
      const runtimeClaim = (await store.claimTenantRuntimeRevocations({ limit: 10, leaseMs: 120_000,
        claimToken: `byok-runtime-${randomUUID()}` })).find((claim) => claim.requestId === requestId);
      if (!runtimeClaim || !t3a) throw new Error("responsibility_fixture_t3b_claim_missing");
      // Actual ProviderService participant drain, not a zeroed cache fixture.
      // This is one in-process test runner, not an HTTP/fresh-fleet or zeroization claim.
      const local = await coordinator.drain({ tenantId, requestId,
        subjectGeneration: runtimeClaim.subjectGeneration, t3aReceiptSha256: t3a.receiptSha256 }, 1_000);
      // The local model/cipher variables are not erased or asserted zeroized.
      // Only the coordinator's actually registered references are evidenced.
      expect(local.cacheEntryCountBefore).toBeGreaterThan(0);
      expect([local.cacheEntryCountAfter, local.activeOperationCountAfter, local.activeTurnCountAfter]).toEqual([0, 0, 0]);
      const body = { tenantId, requestId, subjectGeneration: runtimeClaim.subjectGeneration,
        t3aReceiptSha256: t3a.receiptSha256, targetSha256: tenantRuntimeTargetSha256(origin),
        runnerId: "byok-artifact-fixture-runner", bootId: "byok-artifact-fixture-boot",
        cacheEntryCountBefore: local.cacheEntryCountBefore, cacheEntryCountAfter: 0 as const,
        activeOperationCountBefore: local.activeOperationCountBefore, activeOperationCountAfter: 0 as const,
        activeTurnCountBefore: local.activeTurnCountBefore, activeTurnCountAfter: 0 as const, completedAtMs: local.completedAtMs };
      const targets = [{ ...body, receiptSha256: tenantRuntimeLocalReceiptSha256(body) }];
      const t3b = await store.completeTenantRuntimeRevocation({ tenantId, requestId,
        subjectGeneration: runtimeClaim.subjectGeneration, claimAttempt: runtimeClaim.claimAttempt,
        claimToken: runtimeClaim.claimToken }, { targets, fleetSha256: tenantRuntimeFleetSha256(targets),
        targetReceiptsSha256: tenantRuntimeTargetReceiptsSha256(targets) });
      expect(t3b).not.toBeNull();
      const readiness = await store.getTenantCredentialResponsibilityReadiness(tenantId, requestId);
      expect(readiness).toMatchObject({ status: "local_responsibility_observed", localDatabase: "cleared",
        trackedRuntimeReferences: "dropped_not_zeroized", remoteCredentials: "customer_responsibility_recorded",
        customerManagedApiKeyCount: 1, unknownMaterialCount: 0, backupCopies: "unknown", otherCopies: "unknown",
        t3aReceiptSha256: t3a.receiptSha256, t3bReceiptSha256: t3b!.receiptSha256,
        executionReady: false, externalAuthorityVerified: false, allDomainsComplete: false, contentPurgeExecuted: false });
      expect(readiness!.versionCount).toBeGreaterThan(0);
      expect(outbound).not.toHaveBeenCalled();
      const raw = await responsibilityRows(fixture.sourceUrl, tenantId);
      expect(raw.tenant_credential_responsibility_sources?.count).toBe(1);
      expect(raw.tenant_credential_responsibility_entries?.count).toBe(readiness!.versionCount);
      expect(raw.tenant_credential_responsibility_receipts?.count).toBe(1);
      for (const table of responsibilityTables) {
        expect(raw[table]?.count, "actual responsibility/T1/T3a/T3b evidence must be nonempty").toBeGreaterThan(0);
      }
      const env = { TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: keyFile };
      return { tenantId, requestId, readiness, raw, refKey, fleetRoot, env };
    } catch (error) { refKey.fill(0); throw error; }
    finally { try { await publisher?.stop(); } finally { await store.close(); } }
  }

  async function refusedBeforeImport(extra: NodeJS.ProcessEnv, reason:
    "authentication_failed" | "artifact_length_mismatch" | "manifest_invalid" | "evidence_mismatch" | "catalog"
  ): Promise<void> {
    const targetUrl = await fixture.newDatabase();
    const importArtifact = vi.fn(artifactOperations.importVerifiedMySqlBackupArtifact);
    const verifyArtifact = vi.fn(artifactOperations.verifyMySqlBackupArtifact);
    const result = await fixture.command("restore-selected", {
      BACKUP_RESTORE_TARGET_MYSQL_URL: targetUrl,
      RESTORE_RUN_ID: `restore_${randomUUID()}`,
      BACKUP_RUNTIME_EPOCH_ID: `artifact-negative-${randomUUID()}`,
      ...extra,
    }, { artifactOperations: {
      ...artifactOperations, importVerifiedMySqlBackupArtifact: importArtifact,
      verifyMySqlBackupArtifact: verifyArtifact,
    } });
    await failure(result);
    expect(JSON.parse(result.stderr)).toMatchObject({ code: reason === "catalog" ? "catalog_conflict" : "operation_failed" });
    if (reason !== "catalog") {
      expect(verifyArtifact).toHaveBeenCalledTimes(1);
      expect(result.failureDiagnostic).toMatchObject({ stage: "verify", code: reason });
    }
    expect(importArtifact).not.toHaveBeenCalled();
    expect(await fixture.tableNames(targetUrl)).toEqual([]);
  }

  async function copiedRootRefusesPriorAttempt(settings: NodeJS.ProcessEnv): Promise<void> {
    const root = join(fixture.privateDirectory, `copied-operator-root-${randomUUID()}`);
    const directory = join(root, "artifacts");
    const keyFile = join(root, "artifact-key.bin");
    await mkdir(root, { mode: 0o700 });
    await mkdir(directory, { mode: 0o700 });
    await copyFile(fixture.keyFile, keyFile);
    await chmod(keyFile, 0o600);
    await copyFile(artifactPath(fixture), join(directory, `${fixture.backupId}.asmbak`));
    await chmod(join(directory, `${fixture.backupId}.asmbak`), 0o600);
    const targetUrl = await fixture.newDatabase();
    const importer = vi.fn(artifactOperations.importVerifiedMySqlBackupArtifact);
    let bindCount = 0;
    const acquire: typeof artifactOperations.acquireMySqlBackupArtifactOperator = async (options) => {
      const real = await artifactOperations.acquireMySqlBackupArtifactOperator(options);
      // The product operator is frozen: a Proxy cannot replace its own immutable
      // method properties. This negative-only facade forwards the actual locks;
      // successful imports always use the original branded product operator.
      return {
        sourceIdentitySha256: real.sourceIdentitySha256,
        ...(real.targetIdentitySha256 === undefined ? {} : { targetIdentitySha256: real.targetIdentitySha256 }),
        assertHeld: () => real.assertHeld(),
        bindRestoreOperation: async (input) => { bindCount += 1; await real.bindRestoreOperation(input); },
        markRestorePrepared: (restoreRunId) => real.markRestorePrepared(restoreRunId),
        close: () => real.close(),
      };
    };
    const rejected = await fixture.command("restore-selected", {
      ...settings,
      BACKUP_ARTIFACT_DIRECTORY: directory, BACKUP_ARTIFACT_KEY_FILE: keyFile,
      BACKUP_RESTORE_TARGET_MYSQL_URL: targetUrl,
    }, {
      artifactOperations: {
        ...artifactOperations, acquireMySqlBackupArtifactOperator: acquire,
        importVerifiedMySqlBackupArtifact: importer,
      },
    });
    await failure(rejected);
    expect(JSON.parse(rejected.stderr), JSON.stringify(rejected.failureDiagnostic)).toMatchObject({ code: "catalog_conflict" });
    // Actual external authority rejects the consumed run/epoch before local binding/import;
    // neither an empty database nor a fresh filesystem lock root resets that authority.
    expect(bindCount).toBe(0);
    expect(importer).not.toHaveBeenCalled();
    expect(await fixture.tableNames(targetUrl)).toEqual([]);
  }

  beforeAll(async () => {
    fixture = new MySqlBackupArtifactFixture();
    await fixture.setup();
    baseline = await success(await fixture.command("create-artifact"));
    originalArtifact = await readFile(artifactPath(fixture));
    expectedSourceSchema = await fixture.schemaSnapshot();
    const sourceValid = expectedSourceSchema.schemaSha256 === manifest(originalArtifact).schemaSha256;
    expect(sourceValid, JSON.stringify({ sourceValid })).toBe(true);
  }, 180_000);

  afterAll(async () => { await fixture?.cleanup(); }, 60_000);

  it("preserves nonempty BYOK responsibility bytes through real backup, fresh import, selected maintenance and ordinary cold readiness", async () => independentFixture(async () => {
    const source = await nonemptyResponsibilitySource();
    const backupId = newTenantBackupId(), targetUrl = await fixture.newDatabase();
    const maintenance = vi.fn((options: Parameters<typeof MysqlSessionStore.connectTenantTelemetryCaptureArtifactRestoreMaintenance>[0]) =>
      MysqlSessionStore.connectTenantTelemetryCaptureArtifactRestoreMaintenance(options));
    const dependencies: Partial<BackupCatalogCliDependencies> = {
      connectCaptureArtifactRestoreMaintenance: maintenance,
      connectCaptureRestoreMaintenance: (options) => MysqlSessionStore.connectTenantTelemetryCaptureRestoreMaintenance(options),
    };
    try {
      const created = await success(await fixture.command("create-artifact", {
        ...source.env, BACKUP_ID: backupId,
      }, dependencies));
      expect(created).toMatchObject({ backupId, artifactVerified: true });
      expect(await responsibilityRows(fixture.sourceUrl, source.tenantId)).toEqual(source.raw);
      const encrypted = await readFile(artifactPath(fixture, backupId));
      expect(encrypted.subarray(0, 8).toString("ascii")).toBe("ASMYSQL2");
      expect(encrypted.includes(source.refKey), "protected ref key must not be present in ciphertext output").toBe(false);
      const originalCheckpoint = await checkpointRows(fixture.sourceUrl, backupId);
      const reader = await mysql.createConnection(fixture.sourceUrl);
      try {
        const actual = await readTenantTelemetryCaptureCheckpointFromMysql(reader, backupId, source.refKey);
        expect(actual?.checkpoint.scope).toBe("tenant-telemetry-capture-backup-checkpoint-v1");
        expect(actual?.checkpoint.families).toHaveLength(49);
        // 0059 is covered by the actual full dump and its own complete business
        // audit, not by reinterpreting any of the immutable 49/27 old families.
        expect(actual?.lineageLeaves ?? []).toEqual([]);
      } finally { await reader.end(); }

      const selected = { ...source.env, BACKUP_ID: backupId, RESTORE_RUN_ID: fixture.restoreRunId,
        BACKUP_RUNTIME_EPOCH_ID: fixture.restoredEpochId, BACKUP_RESTORE_TARGET_MYSQL_URL: targetUrl };
      expect(await success(await fixture.command("restore-selected", selected, dependencies)))
        .toMatchObject({ backupId, restorePhase: "prepared", runtimeActivated: false });
      // Independent native SELECTs prove every persisted old/new row survived
      // the real dump/import byte-for-byte, before any maintenance continuation.
      expect(await responsibilityRows(targetUrl, source.tenantId)).toEqual(source.raw);
      expect(await checkpointRows(targetUrl, backupId)).toEqual(originalCheckpoint);
      const restoredSchema = await fixture.schemaDifference(await fixture.schemaSnapshot(), targetUrl);
      expect(restoredSchema).toMatchObject({ missingTables: 0, extraTables: 0, missingTriggers: 0, extraTriggers: 0 });
      expect(Object.values(restoredSchema.metadataTableMismatchCounts)).toEqual([0, 0, 0, 0, 0, 0, 0]);
      expect(Object.values(restoredSchema.triggerFieldMismatchCounts)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

      await success(await fixture.command("replay-selected", { ...selected, BACKUP_RESTORE_REPLAY_ACK: "1" }, dependencies));
      await success(await fixture.command("verify-selected", { ...selected, BACKUP_RESTORE_VERIFY_ACK: "1" }, dependencies));
      await success(await fixture.command("activate-selected", { ...selected, BACKUP_RESTORE_RUNTIME_ACTIVATION_ACK: "1" }, dependencies));
      const options = { url: targetUrl, connectionLimit: 2, migrationMode: "verify" as const,
        tenantTelemetryRefKey: source.refKey, tenantTelemetryPersistedProviderCaptureLocalOnly: true };
      // Read-only history is not ordinary runtime authority before capture cutover.
      await expect(MysqlSessionStore.connect(options)).rejects.toThrow();
      await success(await fixture.command("activate-capture-selected", { ...selected,
        TELEMETRY_CAPTURE_RESTORED_EPOCH_ACTIVATION_ACK: "1", TELEMETRY_CAPTURE_LOCAL_ONLY_ACK: "1",
        TELEMETRY_CAPTURE_FLEET_STOPPED_ACK: "1", TELEMETRY_CAPTURE_LEGACY_WRITERS_DRAINED_ACK: "1",
        TELEMETRY_CAPTURE_PRODUCER_READY_ACK: "1", TELEMETRY_CAPTURE_CONFIGURED_FLEET_ROOT_SHA256: source.fleetRoot,
      }, dependencies));
      await success(await fixture.command("resolve-selected", { ...selected,
        BACKUP_RESTORE_CATALOG_RESOLUTION_ACK: "1" }, dependencies));
      expect(maintenance).toHaveBeenCalledTimes(5);
      const cold = await MysqlSessionStore.connect(options);
      try {
        expect(await cold.getTenantRestoreReplayRun(fixture.restoreRunId)).toMatchObject({ phase: "active" });
        expect(await cold.getTenantBackupRuntimeReservation(fixture.restoreRunId)).toMatchObject({ phase: "activated" });
        expect(await cold.getTenantCredentialResponsibilityReadiness(source.tenantId, source.requestId)).toEqual(source.readiness);
        expect((await cold.getProviderConfig(source.tenantId, "byok")) === null,
          "cleared provider must not reappear after physical restore").toBe(true);
        expect(await cold.getTenantCredentialResponsibilityReadiness(fixture.tenantId, source.requestId)).toBeNull();
      } finally { await cold.close(); }
      // New runtime/history rows may advance. The original CP/root and all
      // responsibility/T1/T3a/T3b immutable evidence may not be re-signed.
      expect(await responsibilityRows(targetUrl, source.tenantId)).toEqual(source.raw);
      expect(await checkpointRows(targetUrl, backupId)).toEqual(originalCheckpoint);
    } finally { source.refKey.fill(0); }
  }), 180_000);

  it("rejects a missing actual 0059 guard after a valid nonempty BYOK baseline before publishing any new artifact", async () => independentFixture(async () => {
    const source = await nonemptyResponsibilitySource();
    const backupId = newTenantBackupId();
    const options = { url: fixture.sourceUrl, connectionLimit: 2, tenantTelemetryRefKey: source.refKey,
      fleetStoppedAck: "fleet-stopped-v1" as const, localOnlyAck: "local-only-v1" as const };
    const connection = await mysql.createConnection(fixture.sourceUrl);
    try {
      // The exact factory must pass before the single causal schema mutation.
      // This prevents a setup failure from masquerading as the negative oracle.
      const valid = await MysqlSessionStore.connectTenantTelemetryCaptureBackupSourceMaintenance(options);
      await valid.close();
      expect(await responsibilityRows(fixture.sourceUrl, source.tenantId)).toEqual(source.raw);
      const [guards] = await connection.query<RowDataPacket[]>(
        "SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME='trg_credential_responsibility_sources_bu'",
      );
      expect(guards).toHaveLength(1);
      // Privileged tamper only in this owned disposable DB. No product method
      // obtains DDL authority and the fixture later drops only its own database.
      await connection.query("DROP TRIGGER trg_credential_responsibility_sources_bu");
      await expect(MysqlSessionStore.connectTenantTelemetryCaptureBackupSourceMaintenance(options))
        .rejects.toThrow("0059 credential responsibility fingerprint verification failed");
      const sourceFactory = vi.fn((input: Parameters<typeof MysqlSessionStore.connectTenantTelemetryCaptureBackupSourceMaintenance>[0]) =>
        MysqlSessionStore.connectTenantTelemetryCaptureBackupSourceMaintenance(input));
      const createArtifact = vi.fn(artifactOperations.createMySqlBackupArtifact);
      const importArtifact = vi.fn(artifactOperations.importVerifiedMySqlBackupArtifact);
      await failure(await fixture.command("create-artifact", { ...source.env, BACKUP_ID: backupId }, {
        connectCaptureBackupSourceMaintenance: sourceFactory,
        artifactOperations: { ...artifactOperations, createMySqlBackupArtifact: createArtifact,
          importVerifiedMySqlBackupArtifact: importArtifact },
      }));
      expect(sourceFactory).toHaveBeenCalledOnce();
      expect(createArtifact).not.toHaveBeenCalled();
      expect(importArtifact).not.toHaveBeenCalled();
      for (const table of ["backup_snapshot_anchors", "backup_catalog_entries", "tenant_telemetry_capture_backup_checkpoints"] as const) {
        const [rows] = await connection.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE backup_id=?`, [backupId]);
        expect(Number(rows[0]?.n)).toBe(0);
      }
      await expect(stat(artifactPath(fixture, backupId))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await responsibilityRows(fixture.sourceUrl, source.tenantId)).toEqual(source.raw);
    } finally { await connection.end(); source.refKey.fill(0); }
  }), 180_000);

  it("rejects corrupted BYOK business evidence after a real full import with exact guards before target prepare", async () => independentFixture(async () => {
    const source = await nonemptyResponsibilitySource();
    const backupId = newTenantBackupId(), targetUrl = await fixture.newDatabase();
    let importCompleted = false, mutationCount = 0, guardRestoredExactly = false;
    let targetResponsibilityRejected = false;
    let importedMarkersSha256 = "", restoredMarkersSha256 = "";
    try {
      await success(await fixture.command("create-artifact", { ...source.env, BACKUP_ID: backupId }));
      const originalArtifactSha256 = sha256(await readFile(artifactPath(fixture, backupId)));
      expect(await responsibilityRows(fixture.sourceUrl, source.tenantId)).toEqual(source.raw);
      const importArtifact = vi.fn(async (...args: Parameters<typeof artifactOperations.importVerifiedMySqlBackupArtifact>) => {
        // The product imports authenticated bytes and verifies its actual schema
        // first. The only mutation is afterwards in this exact owned target,
        // before the CLI cold-opens its target source-maintenance factory.
        const result = await artifactOperations.importVerifiedMySqlBackupArtifact(...args);
        importCompleted = true;
        const before = await fixture.schemaSnapshot(targetUrl);
        const connection = await mysql.createConnection(targetUrl);
        try {
          const [markers] = await connection.query<RowDataPacket[]>("SELECT * FROM schema_migrations ORDER BY BINARY name");
          importedMarkersSha256 = sha256(Buffer.from(JSON.stringify(markers)));
          const [definitions] = await connection.query<RowDataPacket[]>(
            "SHOW CREATE TRIGGER trg_credential_responsibility_sources_bu",
          );
          const definition = definitions[0];
          const ddl: unknown = definition?.["SQL Original Statement"];
          const sqlMode: unknown = definition?.sql_mode;
          const charset: unknown = definition?.character_set_client;
          const collation: unknown = definition?.collation_connection;
          if (typeof ddl !== "string" || typeof sqlMode !== "string"
            || typeof charset !== "string" || typeof collation !== "string") {
            throw new Error("byok_fixture_original_trigger_metadata_missing");
          }
          await connection.query("DROP TRIGGER trg_credential_responsibility_sources_bu");
          const [changed] = await connection.query<ResultSetHeader>(
            "UPDATE tenant_credential_responsibility_sources SET source_json=JSON_SET(source_json,'$.secretEnvelopeSha256',?) WHERE tenant_id=?",
            ["0".repeat(64), source.tenantId],
          );
          mutationCount = changed.affectedRows;
          // Restore the actual original definition under its exact recorded
          // parser metadata, not a fabricated guard/fingerprint or a bypass.
          await connection.query("SET SESSION sql_mode=?", [sqlMode]);
          await connection.query("SET SESSION character_set_client=?, collation_connection=?", [charset, collation]);
          await connection.query(ddl);
          const [restoredMarkers] = await connection.query<RowDataPacket[]>("SELECT * FROM schema_migrations ORDER BY BINARY name");
          restoredMarkersSha256 = sha256(Buffer.from(JSON.stringify(restoredMarkers)));
        } finally { await connection.end(); }
        const after = await fixture.schemaSnapshot(targetUrl);
        guardRestoredExactly = before.triggers.size === 743 && after.triggers.size === 743
          && before.schemaSha256 === after.schemaSha256;
        return result;
      });
      const targetFactory = vi.fn(async (options: Parameters<typeof MysqlSessionStore.connectTenantTelemetryCaptureBackupSourceMaintenance>[0]) => {
        try { return await MysqlSessionStore.connectTenantTelemetryCaptureBackupSourceMaintenance(options); }
        catch (error) {
          // This exact factory first runs the real committed strict schema
          // verifier. The distinct business-integrity error proves it reached
          // 0059 projection after that verifier, not a source/setup schema error.
          if (options.url === targetUrl && error instanceof TenantCredentialResponsibilityIntegrityError) {
            targetResponsibilityRejected = true;
          }
          throw error;
        }
      });
      const exactMaintenance = vi.fn((options: Parameters<typeof MysqlSessionStore.connectTenantTelemetryCaptureRestoreMaintenance>[0]) =>
        MysqlSessionStore.connectTenantTelemetryCaptureRestoreMaintenance(options));
      const rejected = await fixture.command("restore-selected", { ...source.env, BACKUP_ID: backupId,
        RESTORE_RUN_ID: fixture.restoreRunId, BACKUP_RUNTIME_EPOCH_ID: fixture.restoredEpochId,
        BACKUP_RESTORE_TARGET_MYSQL_URL: targetUrl,
      }, { connectCaptureBackupSourceMaintenance: targetFactory,
        connectCaptureRestoreMaintenance: exactMaintenance,
        artifactOperations: { ...artifactOperations, importVerifiedMySqlBackupArtifact: importArtifact } });
      await failure(rejected);
      expect(JSON.parse(rejected.stderr)).toMatchObject({ reservationMayBeConsumed: true,
        targetMayContainPartialImport: true, requiresManualForwardFix: true, runtimeActivated: false });

      expect(importArtifact).toHaveBeenCalledOnce();
      expect(importCompleted, "actual native import and its schema verification must finish").toBe(true);
      expect(mutationCount).toBe(1);
      expect(guardRestoredExactly, "all 743 original guards and schema must be byte-equivalent after tamper").toBe(true);
      expect(importedMarkersSha256).toMatch(SHA256);
      expect(restoredMarkersSha256).toBe(importedMarkersSha256);
      expect(targetFactory.mock.calls.filter(([options]) => options.url === targetUrl)).toHaveLength(1);
      expect(targetResponsibilityRejected, "actual target projection, not schema/setup, must reject the sidecar").toBe(true);
      expect(exactMaintenance).not.toHaveBeenCalled();
      const target = await mysql.createConnection(targetUrl);
      try {
        for (const table of ["tenant_restore_replay_runs", "backup_restore_source_bindings", "backup_runtime_reservations",
          "tenant_telemetry_capture_restore_bindings", "tenant_telemetry_capture_restore_history_receipts", "tenant_telemetry_capture_epoch_cutovers"] as const) {
          const [rows] = await target.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE restore_run_id=?`, [fixture.restoreRunId]);
          expect(Number(rows[0]?.n), "target prepare/activation must not advance after business rejection").toBe(0);
        }
      } finally { await target.end(); }
      expect((await fixture.tableNames(targetUrl)).length, "failed target remains physically imported for explicit forward-fix").toBeGreaterThan(0);
      const corrupted = await responsibilityRows(targetUrl, source.tenantId);
      expect(corrupted.tenant_credential_responsibility_sources?.sha256)
        .not.toBe(source.raw.tenant_credential_responsibility_sources?.sha256);
      for (const table of responsibilityTables.filter((table) => table !== "tenant_credential_responsibility_sources")) {
        expect(corrupted[table], "original receipts/version/T1/T3a/T3b must remain unmodified").toEqual(source.raw[table]);
      }
      expect(sha256(await readFile(artifactPath(fixture, backupId)))).toBe(originalArtifactSha256);
      // No retry, re-import, target clearing or automatic repair is attempted.
      // The pre-existing fixture cleanup owns the final disposable DB removal.
    } finally { source.refKey.fill(0); }
  }), 180_000);

  it("creates a real encrypted full artifact, binds actual digests, and verifies it without plaintext output", async () => {
    expect(baseline).toMatchObject({
      command: "create-artifact", backupId: fixture.backupId, artifactVerified: true,
    });
    for (const field of [
      "sourceSnapshotSha256", "sourceBackupSha256", "artifactManifestSha256", "providerEvidenceSha256",
    ]) expect(baseline[field]).toMatch(SHA256);
    expect(baseline.sourceBackupSha256).toBe(sha256(originalArtifact));
    expect(originalArtifact.includes(Buffer.from(fixture.payloadCanary))).toBe(false);
    expect(originalArtifact.includes(Buffer.from("CREATE TABLE"))).toBe(false);
    expect((await stat(artifactPath(fixture))).mode & 0o077).toBe(0);
    expect(manifest(originalArtifact)).toMatchObject({
      scope: "mysql-logical-full-artifact-v1", version: 1, backupId: fixture.backupId,
    });
    await storeAt(fixture.sourceUrl, async (store) => {
      const entry = await store.getTenantBackupCatalogEntry(fixture.backupId);
      expect(entry).toMatchObject({
        sourceBackupSha256: baseline.sourceBackupSha256,
        sourceSnapshotSha256: baseline.sourceSnapshotSha256,
        artifactManifestSha256: baseline.artifactManifestSha256,
        providerEvidenceSha256: baseline.providerEvidenceSha256,
      });
      expect(await store.getTenantBackupSnapshotAnchor(fixture.backupId)).not.toBeNull();
    });
    expect(await success(await fixture.command("verify-artifact"))).toMatchObject({
      command: "verify-artifact", artifactVerified: true,
      sourceBackupSha256: baseline.sourceBackupSha256,
    });
  }, 180_000);

  it("backs up active 0033 with a protected exact key, restores real bytes, and seals explicit restore-ledger verification", async () => independentFixture(async () => {
    const keyFile = join(fixture.privateDirectory, "telemetry-ref-key.bin");
    const wrongKeyFile = join(fixture.privateDirectory, "wrong-telemetry-ref-key.bin");
    const refKey = randomBytes(32);
    const wrongKey = randomBytes(32);
    await writeFile(keyFile, refKey, { mode: 0o600, flag: "wx" });
    await writeFile(wrongKeyFile, wrongKey, { mode: 0o600, flag: "wx" });
    const keyedStoreAt = async <T>(url: string, action: (store: MysqlSessionStore) => Promise<T>): Promise<T> => {
      const store = await MysqlSessionStore.connect({ url, connectionLimit: 2, migrationMode: "verify", tenantTelemetryRefKey: refKey });
      try { return await action(store); } finally { await store.close(); }
    };
    try {
      const activated = await keyedStoreAt(fixture.sourceUrl, (store) => store.activateTenantTelemetryLifecycle({
        expectedControlGeneration: 0,
        // These content-free lifecycle identities exercise 0033 startup audit only. This
        // case does not configure a telemetry sink or activate application capture.
        targets: (["logs", "traces"] as const).map((domain) => ({
          domain, backendKind: "backup-fixture", adapterProtocol: "backup-active-telemetry-fixture-v1",
          namespaceSha256: sha256(Buffer.from(`telemetry-namespace-${fixture.runId}-${domain}`)),
          failureDomainSha256: sha256(Buffer.from(`telemetry-domain-${fixture.runId}-${domain}`)),
        })),
      }));
      for (const badFile of [undefined, wrongKeyFile]) {
        for (const restoreLedger of [false, true]) {
          await failure(await fixture.command("status", { TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: badFile }, {}, restoreLedger));
        }
      }
      const backupId = newTenantBackupId();
      const keyEnv = { TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: keyFile, BACKUP_ID: backupId };
      const created = await success(await fixture.command("create-artifact", keyEnv));
      expect(created).toMatchObject({ command: "create-artifact", artifactVerified: true, backupId });
      const ciphertext = await readFile(artifactPath(fixture, backupId));
      expect(ciphertext.includes(refKey), "backup must not serialize a process-only ref key").toBe(false);
      expect(await success(await fixture.command("verify-artifact", keyEnv))).toMatchObject({ artifactVerified: true });
      const targetUrl = await fixture.newDatabase();
      const restoreRunId = `restore_${randomUUID()}`;
      const epochId = `active-telemetry-restored-${randomUUID()}`;
      const restored = await fixture.command("restore-selected", { ...keyEnv,
        RESTORE_RUN_ID: restoreRunId, BACKUP_RUNTIME_EPOCH_ID: epochId,
        BACKUP_RESTORE_TARGET_MYSQL_URL: targetUrl,
      });
      expect(await success(restored)).toMatchObject({ restorePhase: "prepared", runtimeActivated: false });
      const targetEnv = { ...keyEnv, MYSQL_URL: targetUrl, RESTORE_RUN_ID: restoreRunId,
        BACKUP_RUNTIME_EPOCH_ID: epochId, SOURCE_BACKUP_SHA256: String(created.sourceBackupSha256) };
      expect(await success(await fixture.command("replay-fences", targetEnv, {}, true))).toMatchObject({ restorePhase: "prepared" });
      expect(await success(await fixture.command("verify", targetEnv, {}, true))).toMatchObject({ command: "verify", restorePhase: "replay_sealed" });
      expect(await success(await fixture.command("status", targetEnv, {}, true))).toMatchObject({ restorePhase: "replay_sealed" });
      await keyedStoreAt(targetUrl, async (store) => {
        expect(await store.getTenantTelemetryLifecycleControl()).toEqual(activated.control);
        expect(await store.listTenantTelemetryLifecycleTargets()).toEqual(activated.targets);
        expect(await store.getTenantTelemetryLifecycleCoverage(fixture.tenantId)).toMatchObject({ historyStatus: "legacy_history_unknown" });
        expect(await store.getTenantRestoreReplayRun(restoreRunId)).toMatchObject({ phase: "replay_sealed" });
        expect(await store.getSession(fixture.tenantId, fixture.session.id)).toMatchObject({ metadata: { fixtureContent: fixture.payloadCanary } });
        expect(await store.getTenantTelemetryPersistedProviderCaptureControl()).toMatchObject({ state: "inactive", controlGeneration: 0 });
      });
      const independent = await mysql.createConnection(targetUrl);
      try {
        const [rows] = await independent.query<RowDataPacket[]>(
          "SELECT receipt_sha256,ref_key_id_sha256 FROM tenant_telemetry_activation_receipts WHERE singleton_id=1",
        );
        expect(rows).toEqual([{ receipt_sha256: activated.receipt.receiptSha256, ref_key_id_sha256: activated.receipt.refKeyIdSha256 }]);
      } finally { await independent.end(); }
      for (const badFile of [undefined, wrongKeyFile]) {
        await failure(await fixture.command("status", { ...targetEnv, TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: badFile }, {}, true));
      }
      for (const result of [restored]) {
        for (const key of [refKey, wrongKey]) for (const encoding of ["hex", "base64"] as const) {
          expect((result.stdout + result.stderr).includes(key.toString(encoding)), "ref key must not appear in CLI output").toBe(false);
        }
      }
    } finally { refKey.fill(0); wrongKey.fill(0); }
  }), 240_000);

  it("reuses the identical artifact after a real external availability commit loses its response", async () => independentFixture(async () => {
    const newerBackupId = newTenantBackupId();
    const createAdapter = loseOneCatalogResponse(createTenantBackupCatalogAdapter, "publishAvailability");
    await failure(await fixture.command("create-artifact", { BACKUP_ID: newerBackupId }, {
      createCatalogAdapter: createAdapter,
    }));
    const newerArtifact = await readFile(artifactPath(fixture, newerBackupId));
    const firstSha256 = sha256(newerArtifact);
    const retry = await success(await fixture.command("create-artifact", { BACKUP_ID: newerBackupId }, {
      createCatalogAdapter: createAdapter,
    }));
    expect(retry.sourceBackupSha256).toBe(firstSha256);
    expect(await readFile(artifactPath(fixture, newerBackupId))).toEqual(newerArtifact);
    const replay = await success(await fixture.command("create-artifact", { BACKUP_ID: newerBackupId }));
    expect(replay.sourceBackupSha256).toBe(firstSha256);
    expect(replay.catalogSequence).toBe(retry.catalogSequence);
    expect(firstSha256).not.toBe(baseline.sourceBackupSha256);
  }), 240_000);

  it.each(["corruption", "truncation", "manifest-conflict"] as const)(
    "rejects %s before importing even one target table",
    async (mutation) => {
      let bytes = Buffer.from(originalArtifact);
      if (mutation === "corruption") bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0x80;
      else if (mutation === "truncation") bytes = bytes.subarray(0, bytes.length - 17);
      else {
        const length = bytes.readUInt32BE(8);
        const body = manifest(bytes);
        body.backupId = newTenantBackupId();
        const replacement = Buffer.from(JSON.stringify(body));
        const header = Buffer.alloc(12);
        header.write("ASMYSQL1", 0, "ascii");
        header.writeUInt32BE(replacement.length, 8);
        bytes = Buffer.concat([header, replacement, bytes.subarray(12 + length)]);
      }
      const expectedCode = {
        corruption: "authentication_failed", truncation: "artifact_length_mismatch",
        // The new top-level identity disagrees with the unchanged anchor identity.
        "manifest-conflict": "manifest_invalid",
      } as const;
      await refusedBeforeImport({ BACKUP_ARTIFACT_DIRECTORY: await clonedArtifact(bytes) }, expectedCode[mutation]);
    }, 180_000,
  );

  it("rejects an independent wrong key and never echoes its bytes or database credentials", async () => {
    const keyFile = join(fixture.privateDirectory, "wrong-key.bin");
    const wrongKey = randomBytes(32);
    await writeFile(keyFile, wrongKey, { mode: 0o600, flag: "wx" });
    const result = await fixture.command("verify-artifact", { BACKUP_ARTIFACT_KEY_FILE: keyFile });
    await failure(result);
    expect(result.failureDiagnostic).toMatchObject({ stage: "verify", code: "authentication_failed" });
    expect(result.stderr.includes(wrongKey.toString("hex")), "wrong-key bytes must not be emitted").toBe(false);
    expect(result.stderr.includes(wrongKey.toString("base64")), "wrong-key bytes must not be emitted").toBe(false);
    wrongKey.fill(0);
    await refusedBeforeImport({ BACKUP_ARTIFACT_KEY_FILE: keyFile }, "authentication_failed");
  }, 180_000);

  it("rejects a newer product snapshot even though the source still has the selected old anchor", async () => independentFixture(async () => {
    await storeAt(fixture.sourceUrl, async (store) => {
      expect(await store.getTenantBackupSnapshotAnchor(fixture.backupId)).not.toBeNull();
      await store.commit({ sessionId: fixture.session.id, fence: 2,
        sessionPatch: { title: `newer-snapshot-${fixture.payloadCanary}` } });
    });
    const directory = join(fixture.privateDirectory, "newer-same-anchor-artifact");
    await mkdir(directory, { mode: 0o700 });
    // The real producer captures newer business rows under the SAME backupId and full anchor.
    // Immutable external availability refuses its different digests; the locally created artifact
    // is nevertheless genuine authenticated producer output, not fixture-encrypted fake SQL.
    const rejectedAvailability = await fixture.command("create-artifact", { BACKUP_ARTIFACT_DIRECTORY: directory });
    await failure(rejectedAvailability);
    expect(JSON.parse(rejectedAvailability.stderr)).toMatchObject({ code: "catalog_conflict" });
    const newerArtifact = await readFile(join(directory, `${fixture.backupId}.asmbak`));
    expect(manifest(newerArtifact).backupId).toBe(fixture.backupId);
    expect(manifest(newerArtifact).anchor).toEqual(manifest(originalArtifact).anchor);
    expect(manifest(newerArtifact).plaintextSha256).not.toBe(manifest(originalArtifact).plaintextSha256);
    expect(sha256(newerArtifact)).not.toBe(baseline.sourceBackupSha256);
    await refusedBeforeImport({ BACKUP_ARTIFACT_DIRECTORY: directory }, "evidence_mismatch");
  }), 240_000);

  it("refuses both a nonempty target and the actual source database without calling the importer", async () => {
    const targetUrl = await fixture.newDatabase();
    const target = await mysql.createConnection(targetUrl);
    try { await target.query("CREATE TABLE do_not_overwrite (value INT NOT NULL)"); }
    finally { await target.end(); }
    for (const [url, expectedCode] of [[targetUrl, "target_not_empty"], [fixture.sourceUrl, "target_is_source"]] as const) {
      const importer = vi.fn(artifactOperations.importVerifiedMySqlBackupArtifact);
      const result = await fixture.command("restore-selected", {
        BACKUP_RESTORE_TARGET_MYSQL_URL: url,
        RESTORE_RUN_ID: `restore_${randomUUID()}`,
        BACKUP_RUNTIME_EPOCH_ID: `artifact-target-refusal-${randomUUID()}`,
      }, { artifactOperations: { ...artifactOperations, importVerifiedMySqlBackupArtifact: importer } });
      await failure(result);
      expect(result.failureDiagnostic).toMatchObject({ stage: "acquire", code: expectedCode });
      expect(importer).not.toHaveBeenCalled();
    }
    expect(await fixture.tableNames(targetUrl)).toEqual(["do_not_overwrite"]);
    await storeAt(fixture.sourceUrl, async (store) => {
      expect(await store.getSession(fixture.tenantId, fixture.session.id))
        .toMatchObject({ metadata: { fixtureContent: fixture.payloadCanary }, lastSeq: 3 });
    });
    for (const [kind, createSql, objectName, catalogSql] of [
      ["view", "CREATE VIEW fixture_target_view AS SELECT 1 AS safe_value", "fixture_target_view",
        "SELECT COUNT(*) AS count FROM information_schema.VIEWS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?"],
      ["routine", "CREATE PROCEDURE fixture_target_routine() SELECT 1", "fixture_target_routine",
        "SELECT COUNT(*) AS count FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE() AND ROUTINE_NAME=?"],
      ["event", "CREATE EVENT fixture_target_event ON SCHEDULE AT CURRENT_TIMESTAMP + INTERVAL 1 DAY ON COMPLETION PRESERVE DISABLE DO SELECT 1", "fixture_target_event",
        "SELECT COUNT(*) AS count FROM information_schema.EVENTS WHERE EVENT_SCHEMA=DATABASE() AND EVENT_NAME=?"],
    ] as const) {
      const objectTargetUrl = await fixture.newDatabase();
      const connection = await mysql.createConnection(objectTargetUrl);
      try {
        await connection.query(createSql);
        const importer = vi.fn(artifactOperations.importVerifiedMySqlBackupArtifact);
        const result = await fixture.command("restore-selected", {
          BACKUP_RESTORE_TARGET_MYSQL_URL: objectTargetUrl,
          RESTORE_RUN_ID: `restore_${randomUUID()}`,
          BACKUP_RUNTIME_EPOCH_ID: `artifact-${kind}-target-${randomUUID()}`,
        }, { artifactOperations: { ...artifactOperations, importVerifiedMySqlBackupArtifact: importer } });
        await failure(result);
        expect(result.failureDiagnostic).toMatchObject({ stage: "acquire", code: "target_not_empty" });
        expect(importer).not.toHaveBeenCalled();
        const [objects] = await connection.query<RowDataPacket[]>(catalogSql, [objectName]);
        expect(Number(objects[0]?.count)).toBe(1);
        expect(await fixture.tableNames(objectTargetUrl))
          .toEqual(kind === "view" ? [objectName] : []);
      } finally { await connection.end(); }
    }
  }, 180_000);

  it("keeps an unpublished producer crash out of the catalog and leaves no usable artifact", async () => independentFixture(async () => {
    const crashedBackupId = newTenantBackupId();
    const wrapper = join(fixture.privateDirectory, "crashing-mysqldump");
    // Preserve real tool-version verification, but crash the actual child before it emits SQL.
    // No DSN, option-file content, plaintext or key is printed by this executable fixture.
    await writeFile(wrapper, [
      "#!/bin/sh",
      `case \"$*\" in *--version*) exec \"${fixture.mysqldumpBinary}\" --version ;; esac`,
      "kill -KILL $$",
      "",
    ].join("\n"), { mode: 0o700, flag: "wx" });
    const result = await fixture.command("create-artifact", {
      BACKUP_ID: crashedBackupId, BACKUP_MYSQLDUMP_BINARY: wrapper,
    });
    await failure(result);
    expect(result.failureDiagnostic).toMatchObject({ stage: "create", code: "dump_failed" });
    await expect(readFile(artifactPath(fixture, crashedBackupId))).rejects.toMatchObject({ code: "ENOENT" });
    await storeAt(fixture.sourceUrl, async (store) => {
      expect(await store.getTenantBackupCatalogEntry(crashedBackupId)).toBeNull();
    });
  }), 240_000);

  it("serializes cooperating operators with actual MySQL named locks across different private roots", async () => {
    const targetUrl = await fixture.newDatabase();
    const firstDirectory = join(fixture.privateDirectory, "named-lock-first");
    const secondDirectory = join(fixture.privateDirectory, "named-lock-second");
    await mkdir(firstDirectory, { mode: 0o700 });
    await mkdir(secondDirectory, { mode: 0o700 });
    const common = {
      sourceUrl: fixture.sourceUrl, targetUrl, deadlineMs: 15_000,
      localOnlyAck: true as const, fleetStoppedAck: true as const, nodeEnv: "test",
    };
    const first = await artifactOperations.acquireMySqlBackupArtifactOperator({
      ...common, artifactDirectory: firstDirectory,
    });
    try {
      await expect(artifactOperations.acquireMySqlBackupArtifactOperator({
        ...common, artifactDirectory: secondDirectory,
      })).rejects.toMatchObject({ code: "operator_busy" });
      await first.assertHeld();
      expect(await fixture.tableNames(targetUrl)).toEqual([]);
    } finally { await first.close(); }
    // The rejected attempt releases its partial connections/files; once the genuine owner
    // closes, another root can acquire the same actual database tuple without lock theft.
    const next = await artifactOperations.acquireMySqlBackupArtifactOperator({
      ...common, artifactDirectory: secondDirectory,
    });
    await next.close();
  }, 60_000);

  it.each([
    ["view", "CREATE VIEW fixture_select_view AS SELECT 1 AS safe_value", "DROP VIEW fixture_select_view"],
    ["routine", "CREATE PROCEDURE fixture_select_only() SELECT 1", "DROP PROCEDURE fixture_select_only"],
    ["event", "CREATE EVENT fixture_future_event ON SCHEDULE AT CURRENT_TIMESTAMP + INTERVAL 1 DAY ON COMPLETION PRESERVE DISABLE DO SELECT 1", "DROP EVENT fixture_future_event"],
  ] as const)("refuses a source containing an unsupported %s without publishing an artifact", async (_kind, createSql, dropSql) => independentFixture(async () => {
    const backupId = newTenantBackupId();
    const source = await mysql.createConnection(fixture.sourceUrl);
    const config = loadTenantBackupCatalogConfig(fixture.catalogEnv, {
      production: false, store: "mysql", restoreJournalS3Bucket: fixture.journalBucket,
      requireRetentionPolicy: true,
    })!;
    const catalog = createTenantBackupCatalogAdapter(config);
    try {
      const head = await catalog.readHead();
      await source.query(createSql);
      if (_kind === "event") {
        const [events] = await source.query<RowDataPacket[]>(
          "SELECT STATUS, EXECUTE_AT > CURRENT_TIMESTAMP AS future_schedule FROM information_schema.EVENTS WHERE EVENT_SCHEMA=DATABASE() AND EVENT_NAME='fixture_future_event'",
        );
        expect(events).toMatchObject([{ STATUS: "DISABLED", future_schedule: 1 }]);
      }
      const producer = vi.fn(async (options: Parameters<typeof artifactOperations.createMySqlBackupArtifact>[0]) => {
        // Exercise the real CLI-to-producer connection. An unrelated Memory/null
        // fake cannot stand in for the actual source checkpoint store.
        expect(options.captureCheckpointStore).toBeInstanceOf(MysqlSessionStore);
        return artifactOperations.createMySqlBackupArtifact(options);
      });
      const result = await fixture.command("create-artifact", { BACKUP_ID: backupId }, {
        artifactOperations: { ...artifactOperations, createMySqlBackupArtifact: producer },
      });
      await failure(result);
      const expectedCode = {
        view: "source_views_unsupported", routine: "source_routines_unsupported", event: "source_events_unsupported",
      } as const;
      expect(result.failureDiagnostic).toMatchObject({ stage: "create", code: expectedCode[_kind] });
      expect(producer).toHaveBeenCalledTimes(1);
      await expect(readFile(artifactPath(fixture, backupId))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await catalog.inspectAvailability(backupId)).toBeNull();
      expect(await catalog.readHead()).toEqual(head);
      await storeAt(fixture.sourceUrl, async (store) => {
        expect(await store.getTenantBackupCatalogEntry(backupId)).toBeNull();
      });
    } finally {
      await source.query(dropSql);
      await Promise.all([source.end(), catalog.close()]);
    }
  }), 240_000);

  it("cancels an actual locked catalog write and leaves no anchor or new migration state", async () => independentFixture(async () => {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(MysqlSessionStore.connect({
      url: fixture.sourceUrl, connectionLimit: 2, migrationMode: "verify",
      operationAbortSignal: alreadyAborted.signal,
    })).rejects.toThrow("MySQL maintenance operation aborted");
    const controller = new AbortController();
    const store = await MysqlSessionStore.connect({
      url: fixture.sourceUrl, connectionLimit: 2, migrationMode: "verify",
      operationAbortSignal: controller.signal,
    });
    const blocker = await mysql.createConnection(fixture.sourceUrl);
    const backupId = newTenantBackupId();
    const databaseName = decodeURIComponent(new URL(fixture.sourceUrl).pathname.slice(1));
    let pending: Promise<{ value?: unknown; error?: unknown }> | undefined;
    const pendingDiagnostic = { settled: false, outcome: "pending", errorName: "none", errorCode: "none" };
    try {
      const control = await store.getTenantBackupCatalogControl();
      expect(control.state).toBe("active");
      if (control.state !== "active") throw new Error("fixture catalog must be active");
      const [markersBefore] = await blocker.query<RowDataPacket[]>(
        "SELECT name FROM schema_migrations ORDER BY BINARY name",
      );
      await blocker.beginTransaction();
      await blocker.query("SELECT singleton_id FROM backup_catalog_control WHERE singleton_id=1 FOR UPDATE");
      const [blockingRows] = await blocker.query<RowDataPacket[]>("SELECT CONNECTION_ID() AS id");
      const blockerId = Number(blockingRows[0]?.id);
      expect(Number.isSafeInteger(blockerId) && blockerId > 0).toBe(true);
      pending = store.createTenantBackupSnapshotAnchor({
        backupId, controlEvidenceSha256: control.evidenceSha256,
      }).then((value) => {
        pendingDiagnostic.settled = true;
        pendingDiagnostic.outcome = "resolved";
        return { value };
      }, (error: unknown) => {
        pendingDiagnostic.settled = true;
        pendingDiagnostic.outcome = "rejected";
        const record = error !== null && typeof error === "object" ? error as Record<string, unknown> : {};
        const names = new Set(["Error", "AbortError", "TenantBackupCatalogIntegrityError",
          "TenantBackupCatalogNotReadyError", "TenantBackupCatalogConflictError", "TenantErasureIntegrityError"]);
        const codes = new Set(["ER_LOCK_WAIT_TIMEOUT", "ER_LOCK_DEADLOCK", "PROTOCOL_CONNECTION_LOST",
          "ER_QUERY_INTERRUPTED", "schema_not_installed", "runtime_lineage_mismatch", "blob_control_mismatch",
          "restore_run_pending", "catalog_control_inactive"]);
        pendingDiagnostic.errorName = typeof record.name === "string" && names.has(record.name) ? record.name : "unclassified";
        pendingDiagnostic.errorCode = typeof record.code === "string" && codes.has(record.code) ? record.code : "unclassified";
        return { error };
      });
      let observedLockWait = false;
      let allLockWaitCount = 0;
      let scopedActiveQueryCount = 0;
      let scopedMetadataWaitCount = 0;
      const expires = Date.now() + 5_000;
      while (Date.now() < expires && !observedLockWait) {
        const [waits] = await fixture.admin!.query<RowDataPacket[]>(
          "SELECT COUNT(*) AS all_waiting, COALESCE(SUM(p.DB=?),0) AS waiting FROM information_schema.INNODB_TRX t LEFT JOIN information_schema.PROCESSLIST p ON p.ID=t.TRX_MYSQL_THREAD_ID WHERE t.TRX_STATE='LOCK WAIT'",
          [databaseName],
        );
        allLockWaitCount = Math.max(allLockWaitCount, Number(waits[0]?.all_waiting ?? 0));
        const [exactWaits] = await fixture.admin!.query<RowDataPacket[]>(
          "SELECT COUNT(*) AS waiting FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l ON l.ENGINE=w.ENGINE AND l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID JOIN performance_schema.threads b ON b.THREAD_ID=w.BLOCKING_THREAD_ID WHERE l.OBJECT_SCHEMA=? AND l.OBJECT_NAME='backup_catalog_control' AND b.PROCESSLIST_ID=?",
          [databaseName, blockerId],
        );
        const [processes] = await fixture.admin!.query<RowDataPacket[]>(
          "SELECT COALESCE(SUM(COMMAND='Query'),0) AS active_queries, COALESCE(SUM(STATE='Waiting for table metadata lock'),0) AS metadata_waits FROM information_schema.PROCESSLIST WHERE DB=? AND ID<>?",
          [databaseName, blockerId],
        );
        scopedActiveQueryCount = Math.max(scopedActiveQueryCount, Number(processes[0]?.active_queries ?? 0));
        scopedMetadataWaitCount = Math.max(scopedMetadataWaitCount, Number(processes[0]?.metadata_waits ?? 0));
        // Bind the actual waiting lock to this fixture's exact control row and
        // this driver-owned blocker, not a global unrelated LOCK WAIT count.
        observedLockWait = Number(exactWaits[0]?.waiting) > 0;
        if (!observedLockWait) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(observedLockWait, JSON.stringify({ ...pendingDiagnostic, allLockWaitCount,
        scopedActiveQueryCount, scopedMetadataWaitCount })).toBe(true);
      expect(pendingDiagnostic.settled).toBe(false);
      controller.abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("catalog write cancellation did not settle")), 2_000);
        }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      expect(settled.error).toBeDefined();
      expect(settled.value).toBeUndefined();
      const reusedCancelledPool = await store.getTenantBackupSnapshotAnchor(backupId).then(
        () => true,
        (error: unknown) => !(error instanceof Error
          && ["MySQL maintenance operation aborted", "Pool is closed."].includes(error.message)),
      );
      expect(reusedCancelledPool).toBe(false);
      await blocker.rollback();
      await storeAt(fixture.sourceUrl, async (reader) => {
        expect(await reader.getTenantBackupSnapshotAnchor(backupId)).toBeNull();
        expect(await reader.getTenantBackupCatalogEntry(backupId)).toBeNull();
      });
      const [markersAfter] = await blocker.query<RowDataPacket[]>(
        "SELECT name FROM schema_migrations ORDER BY BINARY name",
      );
      expect(markersAfter).toEqual(markersBefore);
    } finally {
      controller.abort();
      await blocker.rollback().catch(() => {});
      await pending;
      await Promise.all([blocker.end(), store.close()]);
    }
  }), 240_000);

  it("honors real catalog eviction even when an old encrypted artifact is presented again", async () => independentFixture(async () => {
    const newerBackupId = newTenantBackupId();
    await success(await fixture.command("create-artifact", { BACKUP_ID: newerBackupId }));
    const newerArtifact = await readFile(artifactPath(fixture, newerBackupId));
    const evictionId = newTenantBackupEvictionId();
    await success(await fixture.command("prepare-eviction", {
      BACKUP_ID: newerBackupId, BACKUP_EVICTION_ID: evictionId,
    }));
    await rm(artifactPath(fixture, newerBackupId));
    await success(await fixture.command("record-eviction", {
      BACKUP_ID: newerBackupId,
      BACKUP_EVICTION_ID: evictionId,
      BACKUP_PHYSICAL_ABSENCE_ACK: "1",
      EXTERNAL_TOMBSTONE_SHA256: sha256(Buffer.from(`deleted-local-artifact-${newerBackupId}`)),
    }));
    // The reintroduced file is fixture-only: external authority, not file existence, determines
    // recoverability. Only the disposable generated backup is ever removed or reintroduced.
    await writeFile(artifactPath(fixture, newerBackupId), newerArtifact, { mode: 0o600, flag: "wx" });
    await refusedBeforeImport({ BACKUP_ID: newerBackupId }, "catalog");
  }), 240_000);

  async function publishPostBackupErasure(): Promise<void> {
    const journalConfig = loadTenantRestoreJournalConfig(fixture.journalEnv(), {
      production: false, store: "mysql",
    })!;
    const adapters = createTenantRestoreJournalAdapters(journalConfig);
    const store = await MysqlSessionStore.connect({
      url: fixture.sourceUrl, connectionLimit: 2, migrationMode: "verify",
    });
    const requestId = newErasureRequestId();
    const worker = new TenantRestoreJournalPublicationWorker({
      store, adapters, canExecute: async () => true, logger: { warn: () => {} },
    });
    try {
      expect(await store.getTenantRestoreJournalControl()).toMatchObject({ controlGeneration: 1 });
      expect(await store.getTenantRestoreRuntimeControl()).toMatchObject({ state: "active", lineageKind: "primary" });
      // The trusted store returns its committed T1 admission; the HTTP dependency
      // gate is a different boundary. Prove the real publication is pending here.
      expect(await store.requestTenantErasure({
        requestId, tenantId: fixture.tenantId, requestedByKeyId: "artifact-fixture-admin",
        idempotencyKey: `artifact-delete-${randomUUID()}`,
        requestHash: tenantErasureRequestHash(fixture.tenantId), atMs: Date.now(),
      })).toMatchObject({ status: "gated", generation: 1 });
      expect(await store.getTenantRestoreJournalPublicationJob(fixture.tenantId, requestId))
        .toMatchObject({ phase: "queued", targetAckCount: 0 });
      const pendingBundle = await store.getTenantRestoreJournalPublicationBundle(fixture.tenantId, requestId);
      expect(pendingBundle?.targets).toHaveLength(1);
      expect(pendingBundle?.targets[0]).toMatchObject({ targetOrdinal: 0 });
      expect(pendingBundle?.targetAcks).toEqual([]);
      expect(pendingBundle?.receipt).toBeUndefined();
      const headsBefore = await store.getTenantRestoreRuntimeHeads();
      expect(headsBefore).toMatchObject([{ sealedRemoteSequence: 0 }]);
      expect(await worker.processOnce()).toBe(1);
      expect(await store.getTenantRestoreJournalPublicationJob(fixture.tenantId, requestId))
        .toMatchObject({ phase: "published" });
      expect((await store.getTenantRestoreJournalPublicationBundle(fixture.tenantId, requestId))?.receipt)
        .toMatchObject({ restoreFencePublicationComplete: true, allDomainsComplete: false });
      const headsAfter = await store.getTenantRestoreRuntimeHeads();
      expect(headsAfter).toMatchObject([{ sealedRemoteSequence: 1 }]);
      expect(headsAfter[0]?.sealedHeadRootSha256).not.toBe(headsBefore[0]?.sealedHeadRootSha256);
    } finally { await worker.stop(); await store.close(); }
  }

  it("imports authenticated business rows and guards, rebuilds the same reservation, and explicitly replays/ verifies without activating", async () => independentFixture(async () => {
    await publishPostBackupErasure();
    const targetUrl = await fixture.newDatabase();
    const restoreSettings = {
      BACKUP_RESTORE_TARGET_MYSQL_URL: targetUrl,
      RESTORE_RUN_ID: fixture.restoreRunId,
      BACKUP_RUNTIME_EPOCH_ID: fixture.restoredEpochId,
    };
    const result = await fixture.command("restore-selected", restoreSettings);
    const schemaDifference = result.failureDiagnostic?.productCode === "target_schema_mismatch"
      ? await fixture.schemaDifference(expectedSourceSchema, targetUrl) : undefined;
    const restored = await success(result, schemaDifference);
    expect(restored).toMatchObject({
      command: "restore-selected", backupId: fixture.backupId,
      restoreRunId: fixture.restoreRunId, restorePhase: "prepared",
      artifactVerified: true, runtimeActivated: false, fenceReplayComplete: false,
      requiresExplicitReplayAndActivation: true,
    });
    // Independently inspect real MySQL semantics, not just the shared digest codec.
    // This compares the pre-T1 source to the imported target without printing names/DDL.
    const importedMetadata = await fixture.schemaDifference(expectedSourceSchema, targetUrl);
    expect(importedMetadata).toMatchObject({ missingTables: 0, extraTables: 0, missingTriggers: 0, extraTriggers: 0 });
    expect(Object.values(importedMetadata.metadataTableMismatchCounts)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(Object.values(importedMetadata.triggerFieldMismatchCounts)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(importedMetadata.tableSqlMismatchCount)
      .toBe(importedMetadata.redundantExplicitCharsetMismatchCount);
    const sourceReservation = await storeAt(fixture.sourceUrl, async (store) => (
      store.getTenantBackupRuntimeReservation(fixture.restoreRunId)
    ));
    expect(sourceReservation).toMatchObject({ phase: "reserved" });
    await storeAt(targetUrl, async (store) => {
      const reservation = await store.getTenantBackupRuntimeReservation(fixture.restoreRunId);
      expect(externalReservationIdentity(reservation)).toEqual(externalReservationIdentity(sourceReservation));
      expect(reservation).toMatchObject({ phase: "reserved" });
      expect(await store.getTenantBackupRestoreSourceBinding(fixture.restoreRunId))
        .toMatchObject({ backupId: fixture.backupId, sourceBackupSha256: baseline.sourceBackupSha256,
          bindingSha256: reservation?.bindingSha256 });
      expect(await store.getSession(fixture.tenantId, fixture.session.id))
        .toMatchObject({ metadata: { fixtureContent: fixture.payloadCanary }, lastSeq: 3, usage: fixture.usage });
      const events = await store.readEvents(fixture.session.id, 0, 5);
      expect(events.map((event) => ({ type: event.type, seq: event.seq }))).toEqual([
        { type: "session/created", seq: 1 }, { type: "item/completed", seq: 2 },
        { type: "turn/completed", seq: 3 },
      ]);
      expect(events[0]).toEqual({
        type: "session/created", sessionId: fixture.session.id,
        emittedAtMs: fixture.session.createdAtMs, seq: 1,
      });
      expect(await store.getItem(fixture.session.id, fixture.item.id))
        .toMatchObject({ content: [{ type: "text", text: fixture.payloadCanary }], seq: 2 });
      expect(await store.getTurn(fixture.session.id, fixture.turn.id))
        .toMatchObject({ status: "completed", usage: fixture.usage });
      expect((await store.queryUsage(fixture.tenantId, {
        sessionId: fixture.session.id, groupBy: "total", limit: 10,
      })).data).toEqual([expect.objectContaining({ steps: 1, usage: fixture.usage })]);
      expect(await store.getTenantRestoreFence(fixture.tenantId)).toBeNull();
    });
    const source = await mysql.createConnection(fixture.sourceUrl);
    const target = await mysql.createConnection(targetUrl);
    try {
      const [sourceMarkers] = await source.query<RowDataPacket[]>("SELECT name FROM schema_migrations ORDER BY BINARY name");
      const [targetMarkers] = await target.query<RowDataPacket[]>("SELECT name FROM schema_migrations ORDER BY BINARY name");
      expect(targetMarkers).toEqual(sourceMarkers);
      const [sourceBilling] = await source.query<RowDataPacket[]>(
        "SELECT * FROM billing_usage_facts WHERE usage_id=?", [fixture.usageId],
      );
      const [targetBilling] = await target.query<RowDataPacket[]>(
        "SELECT * FROM billing_usage_facts WHERE usage_id=?", [fixture.usageId],
      );
      expect(sourceBilling).toHaveLength(1);
      expect(targetBilling).toEqual(sourceBilling);
      const triggerSql = "SELECT TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, EVENT_OBJECT_TABLE, ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY BINARY TRIGGER_NAME";
      const [sourceTriggers] = await source.query<RowDataPacket[]>(triggerSql);
      const [targetTriggers] = await target.query<RowDataPacket[]>(triggerSql);
      expect(sourceTriggers.length).toBeGreaterThan(0);
      expect(targetTriggers).toEqual(sourceTriggers);
      await expect(target.query("DELETE FROM backup_snapshot_anchors WHERE backup_id=?", [fixture.backupId]))
        .rejects.toThrow();
    } finally { await Promise.all([source.end(), target.end()]); }
    const targetEnv = {
      MYSQL_URL: targetUrl, ...fixture.journalEnv(fixture.restoredEpochId),
      RESTORE_RUN_ID: fixture.restoreRunId,
    };
    expect(await success(await fixture.command("replay-fences", targetEnv, {}, true)))
      .toMatchObject({ command: "replay-fences", restorePhase: "prepared" });
    expect(await success(await fixture.command("verify", targetEnv, {}, true)))
      .toMatchObject({ command: "verify", restorePhase: "replay_sealed" });
    await storeAt(targetUrl, async (store) => {
      expect(await store.getTenantRestoreFence(fixture.tenantId)).not.toBeNull();
      expect(await store.getTenantRestoreReplayRun(fixture.restoreRunId))
        .toMatchObject({ phase: "replay_sealed" });
      expect(await store.getTenantRestoreRuntimeControl()).not.toMatchObject({
        runtimeEpochSha256: restored.runtimeEpochSha256,
      });
    });
    const importer = vi.fn(artifactOperations.importVerifiedMySqlBackupArtifact);
    await failure(await fixture.command("restore-selected", restoreSettings, {
      artifactOperations: { ...artifactOperations, importVerifiedMySqlBackupArtifact: importer },
    }));
    expect(importer).not.toHaveBeenCalled();
    await copiedRootRefusesPriorAttempt(restoreSettings);
    await copiedRootRefusesPriorAttempt({ ...restoreSettings,
      BACKUP_RUNTIME_EPOCH_ID: `artifact-new-epoch-for-consumed-run-${randomUUID()}` });
    await copiedRootRefusesPriorAttempt({ ...restoreSettings,
      RESTORE_RUN_ID: `restore_${randomUUID()}` });
    // Explicitly abort the SOURCE-side prepared run and resolve its external reservation. The
    // isolated target remains replay_sealed/unactivated. This makes the epoch-reuse assertion
    // exercise a permanently used epoch, rather than merely the active-reservation mutex.
    await success(await fixture.command("abort", {
      RESTORE_RUN_ID: fixture.restoreRunId,
    }, {}, true));
    await success(await fixture.command("resolve-restore", {
      RESTORE_RUN_ID: fixture.restoreRunId,
    }));
    await storeAt(fixture.sourceUrl, async (store) => {
      expect(await store.getTenantBackupRuntimeReservation(fixture.restoreRunId))
        .toMatchObject({ phase: "aborted" });
    });
    await copiedRootRefusesPriorAttempt(restoreSettings);
    // A second run cannot reuse the permanently reserved epoch on another empty target.
    await refusedBeforeImport({ BACKUP_RUNTIME_EPOCH_ID: fixture.restoredEpochId }, "catalog");
  }), 240_000);

  it("retains an import-success/target-prepare crash for explicit same-reservation forward-fix, never a second import", async () => independentFixture(async () => {
    await publishPostBackupErasure();
    const targetUrl = await fixture.newDatabase();
    const restoreRunId = `restore_${randomUUID()}`;
    const epochId = `artifact-crash-restored-${randomUUID()}`;
    const restoreSettings = {
      BACKUP_RESTORE_TARGET_MYSQL_URL: targetUrl,
      RESTORE_RUN_ID: restoreRunId, BACKUP_RUNTIME_EPOCH_ID: epochId,
    };
    const importer = vi.fn(artifactOperations.importVerifiedMySqlBackupArtifact);
    let targetConnectFailureInjected = false;
    const crashed = await fixture.command("restore-selected", restoreSettings, {
      artifactOperations: { ...artifactOperations, importVerifiedMySqlBackupArtifact: importer },
      connectStore: async (options) => {
        if (options.url === targetUrl) {
          targetConnectFailureInjected = true;
          throw new Error(`private-post-import-${fixture.payloadCanary}`);
        }
        return MysqlSessionStore.connect(options);
      },
      connectCaptureBackupSourceMaintenance: async (options) => {
        if (options.url === targetUrl) {
          targetConnectFailureInjected = true;
          throw new Error(`private-post-import-${fixture.payloadCanary}`);
        }
        return MysqlSessionStore.connectTenantTelemetryCaptureBackupSourceMaintenance(options);
      },
    });
    await failure(crashed);
    const schemaDifference = crashed.failureDiagnostic?.productCode === "target_schema_mismatch"
      ? await fixture.schemaDifference(expectedSourceSchema, targetUrl) : undefined;
    expect(targetConnectFailureInjected, JSON.stringify({ diagnostic: crashed.failureDiagnostic, schemaDifference })).toBe(true);
    expect(JSON.parse(crashed.stderr)).toMatchObject({
      reservationMayBeConsumed: true, targetMayContainPartialImport: true,
      requiresManualForwardFix: true, runtimeActivated: false,
    });
    expect(importer).toHaveBeenCalledTimes(1);
    expect(await fixture.tableNames(targetUrl)).toEqual(await fixture.tableNames(fixture.sourceUrl));
    const reservation = await storeAt(fixture.sourceUrl, (store) => (
      store.getTenantBackupRuntimeReservation(restoreRunId)
    ));
    expect(reservation).toMatchObject({ phase: "reserved" });
    await storeAt(targetUrl, async (store) => {
      expect(await store.getTenantBackupRuntimeReservation(restoreRunId)).toBeNull();
      expect(await store.getTenantRestoreReplayRun(restoreRunId)).toBeNull();
    });
    await copiedRootRefusesPriorAttempt(restoreSettings);
    // The imported snapshot is a genuine old database image, not a fixture dump or a table
    // rewrite: it predates this reservation and has no local binding/run. Reusing it as the
    // source still cannot erase the permanent external first-attempt authority.
    await copiedRootRefusesPriorAttempt({ ...restoreSettings, MYSQL_URL: targetUrl });
    importer.mockClear();
    await failure(await fixture.command("restore-selected", restoreSettings, {
      artifactOperations: { ...artifactOperations, importVerifiedMySqlBackupArtifact: importer },
    }));
    expect(importer).not.toHaveBeenCalled();
    const forwardFix = {
      MYSQL_URL: targetUrl, ...fixture.journalEnv(epochId),
      RESTORE_RUN_ID: restoreRunId, BACKUP_RUNTIME_EPOCH_ID: epochId,
      SOURCE_BACKUP_SHA256: String(baseline.sourceBackupSha256),
    };
    await success(await fixture.command("prepare-restore", forwardFix));
    await storeAt(targetUrl, async (store) => {
      const recovered = await store.getTenantBackupRuntimeReservation(restoreRunId);
      expect(externalReservationIdentity(recovered)).toEqual(externalReservationIdentity(reservation));
      expect(recovered).toMatchObject({ phase: "reserved" });
      expect(await store.getTenantBackupRestoreSourceBinding(restoreRunId))
        .toMatchObject({ bindingSha256: recovered?.bindingSha256, sourceBackupSha256: baseline.sourceBackupSha256 });
      expect(await store.getTenantRestoreReplayRun(restoreRunId)).toMatchObject({ phase: "prepared" });
    });
    await success(await fixture.command("replay-fences", forwardFix, {}, true));
    await success(await fixture.command("verify", forwardFix, {}, true));
    await storeAt(targetUrl, async (store) => {
      expect(await store.getTenantRestoreReplayRun(restoreRunId)).toMatchObject({ phase: "replay_sealed" });
      expect(await store.getTenantRestoreFence(fixture.tenantId)).not.toBeNull();
    });
  }), 240_000);
});
