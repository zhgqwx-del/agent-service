import { createHash, randomUUID } from "node:crypto";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
  MysqlSessionStore,
  TENANT_BACKUP_CATALOG_ENTRY_SCOPE,
  TENANT_BACKUP_CATALOG_PROTOCOL,
  newTenantBackupId,
  tenantBackupAvailabilityOperationSha256,
  tenantBackupAvailabilityReceiptSha256,
  tenantBackupCatalogEntrySha256,
  tenantBackupCatalogEventSha256,
  tenantBackupCatalogNextEventRootSha256,
  tenantBackupReservationReceiptSha256,
  tenantBackupRuntimeReservationOperationSha256,
  tenantRestoreRuntimeEpochSha256,
  tenantTelemetryCaptureCheckpointOperationIdentity,
  tenantTelemetryWriteAckSha256,
  tenantTelemetryWriteAdapterResult,
  type TenantBackupCatalogEventProof,
  type TenantTelemetryCaptureRestoreMaintenanceSelector,
} from "../src/index.js";
import { activateCaptureFixture, captureRefKey, captureStepFixture,
  uncapturedStepFixture } from "./persisted-provider-capture.fixture.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const BASE = process.env.MYSQL_TEST_URL ?? "mysql://root@127.0.0.1:3306/agent_service_test";

function localTestBase(raw: string): URL {
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) {
    throw new Error("MYSQL_TEST_URL must name a local disposable test database");
  }
  return url;
}
function databaseUrl(base: URL, name: string): string {
  const url = new URL(base); url.pathname = `/${name}`; return url.toString();
}
function eventProof(sequence: number, previous: string,
  eventType: "backup_recoverable" | "restore_reserved", operationSha256: string,
  receiptSha256: string): TenantBackupCatalogEventProof {
  const catalogEventSha256 = tenantBackupCatalogEventSha256({ eventType, operationSha256, receiptSha256 });
  return { catalogSequence: sequence, previousCatalogEventRootSha256: previous, catalogEventSha256,
    catalogEventRootSha256: tenantBackupCatalogNextEventRootSha256({
      catalogSequence: sequence, previousCatalogEventRootSha256: previous, catalogEventSha256,
    }) };
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("0057 capture epoch cutover and immutable recovery: isolated real MySQL", () => {
    let admin: Connection;
    let base: URL;
    const owned = new Set<string>();
    beforeAll(async () => {
      base = localTestBase(BASE);
      admin = await mysql.createConnection(databaseUrl(base, "mysql"));
    });
    afterAll(async () => {
      if (!admin) return;
      for (const name of owned) await admin.query(`DROP DATABASE \`${name}\``);
      await admin.end();
    });
    async function fixture(options: { preActivationFailure?: boolean } = {}) {
      const name = `agent_service_cutover_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const [existing] = await admin.query<RowDataPacket[]>(
        "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", [name]);
      if (existing.length) throw new Error("isolated cutover database already exists");
      await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`); owned.add(name);
      const url = databaseUrl(base, name);
      let store: MysqlSessionStore | undefined;
      let conn: Connection | undefined;
      let storeClosePromise: Promise<void> | undefined;
      const closeStore = (): Promise<void> => {
        if (!store) return Promise.resolve();
        return storeClosePromise ??= store.close();
      };
      const closeOwned = async (): Promise<void> => {
        const closed = await Promise.allSettled([closeStore(), conn?.end() ?? Promise.resolve()]);
        const dropped = await Promise.allSettled([admin.query(`DROP DATABASE \`${name}\``)]);
        if (dropped[0]!.status === "fulfilled") owned.delete(name);
        const failure = [...closed, ...dropped].find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      };
      try {
        store = await MysqlSessionStore.connect({ url, connectionLimit: 4,
          tenantTelemetryRefKey: captureRefKey,
          tenantTelemetryPersistedProviderCaptureLocalOnly: true,
          tenantTelemetryCaptureRestoreLocalOnly: true });
        conn = await mysql.createConnection(url);
        if (options.preActivationFailure) {
          // This creates the tenant and a genuine legacy failed item before
          // lifecycle/capture activation. Later provider-step commits for this
          // same tenant still have their own complete v2 source graph.
          const legacy = await uncapturedStepFixture(store);
          await store.commit(legacy.batch);
        }
        await activateCaptureFixture(store);
        await store.activateBlobStorageControl({ expectedControlGeneration: 0,
          storageBackend: "s3v1-cutover-local-fixture", namespaceSha256: sha("cutover-blob") });
        const journal = await store.getTenantRestoreJournalControl();
        if (journal.controlGeneration !== 1) throw new Error("fixture journal inactive");
        await store.activateTenantBackupCatalogControl({ expectedControlGeneration: 0,
          adapterProtocol: "mysql-authoritative-backup-catalog-v1",
          catalogNamespaceSha256: sha("cutover-catalog-namespace"),
          catalogTargetSha256: sha("cutover-catalog-target"),
          failureDomainSha256: sha("cutover-catalog-failure-domain"),
          logicalDatabaseNamespaceSha256: "4".repeat(64),
          journalControlEvidenceSha256: journal.evidenceSha256,
          retentionPolicySha256: sha("cutover-catalog-retention"),
          minimumRetentionMs: 60_000, minimumRecoverableBackups: 1 });
        return { url, store, conn, closeStore, close: closeOwned };
      } catch (error) {
        await closeOwned().catch(() => {});
        throw error;
      }
    }
    async function finishFixture(
      f: { close: () => Promise<void> }, extras: readonly (Promise<unknown> | undefined)[],
      bodyFailed: boolean,
    ): Promise<void> {
      const closed = await Promise.allSettled(extras.map((value) => value ?? Promise.resolve()));
      const fixtureClosed = await Promise.allSettled([f.close()]);
      if (!bodyFailed) {
        const failure = [...closed, ...fixtureClosed].find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      }
    }
    async function prepare(store: MysqlSessionStore): Promise<TenantTelemetryCaptureRestoreMaintenanceSelector> {
      const control = await store.getTenantBackupCatalogControl();
      if (control.state !== "active") throw new Error("fixture catalog inactive");
      const backupId = newTenantBackupId();
      const anchor = (await store.createTenantBackupSnapshotAnchor({ backupId,
        controlEvidenceSha256: control.evidenceSha256 })).value;
      const sealed = await store.sealTenantTelemetryCaptureBackupCheckpoint({ backupId,
        fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1" });
      if (!sealed || sealed.disposition !== "created" || sealed.value.checkpoint.families.length !== 49) {
        throw new Error("fixture checkpoint not sealed");
      }
      const descriptor = { backupId, anchorSha256: anchor.anchorSha256,
        sourceSnapshotSha256: sha(`cutover-source-snapshot-${backupId}`),
        sourceBackupSha256: sha(`cutover-source-backup-${backupId}`),
        artifactManifestSha256: sha(`cutover-artifact-${backupId}`),
        providerEvidenceSha256: sha(`cutover-provider-${backupId}`),
        controlEvidenceSha256: anchor.controlEvidenceSha256,
        logicalDatabaseNamespaceSha256: anchor.logicalDatabaseNamespaceSha256,
        retentionPolicySha256: control.retentionPolicySha256,
        retentionUntilDbMs: anchor.retentionUntilDbMs, registeredAtDbMs: anchor.createdAtDbMs,
        catalogNamespaceSha256: control.catalogNamespaceSha256,
        catalogTargetSha256: control.catalogTargetSha256 };
      const availabilityOperationSha256 = tenantBackupAvailabilityOperationSha256(descriptor);
      const availabilityReceiptSha256 = tenantBackupAvailabilityReceiptSha256({
        adapterProtocol: control.adapterProtocol, catalogNamespaceSha256: control.catalogNamespaceSha256,
        catalogTargetSha256: control.catalogTargetSha256, failureDomainSha256: control.failureDomainSha256,
      }, descriptor, availabilityOperationSha256);
      const evidence = { adapterProtocol: control.adapterProtocol,
        failureDomainSha256: control.failureDomainSha256, ...descriptor,
        availabilityOperationSha256, availabilityReceiptSha256,
        ...eventProof(1, EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
          "backup_recoverable", availabilityOperationSha256, availabilityReceiptSha256) };
      const entry = (await store.recordTenantBackupCatalogAvailability({ ...evidence,
        entrySha256: tenantBackupCatalogEntrySha256({
          scope: TENANT_BACKUP_CATALOG_ENTRY_SCOPE,
          protocol: TENANT_BACKUP_CATALOG_PROTOCOL, ...evidence,
        }),
      })).value;
      const restoreRunId = `restore_${randomUUID()}`;
      const runtimeEpochSha256 = tenantRestoreRuntimeEpochSha256(`cutover-epoch-${restoreRunId}`);
      const identity = { backupId, restoreRunId, entrySha256: entry.entrySha256, runtimeEpochSha256 };
      const reservationOperationSha256 = tenantBackupRuntimeReservationOperationSha256(identity);
      const reservationReceiptSha256 = tenantBackupReservationReceiptSha256({
        adapterProtocol: control.adapterProtocol, catalogNamespaceSha256: control.catalogNamespaceSha256,
        catalogTargetSha256: control.catalogTargetSha256, failureDomainSha256: control.failureDomainSha256,
      }, identity, reservationOperationSha256);
      const result = await store.prepareTenantRestoreReplayFromBackup({ backupId, restoreRunId,
        runtimeEpochSha256, controlEvidenceSha256: control.journalControlEvidenceSha256,
        sealedTargets: await store.getTenantRestoreRuntimeHeads(),
        captureCheckpointSha256: sealed.value.checkpoint.checkpointSha256,
        reservation: { adapterProtocol: control.adapterProtocol,
          catalogNamespaceSha256: control.catalogNamespaceSha256,
          catalogTargetSha256: control.catalogTargetSha256, ...identity,
          reservationOperationSha256, reservationReceiptSha256,
          ...eventProof(2, entry.catalogEventRootSha256, "restore_reserved",
            reservationOperationSha256, reservationReceiptSha256) },
      });
      expect(result.disposition).toBe("created");
      return { backupId, restoreRunId, checkpointSha256: sealed.value.checkpoint.checkpointSha256,
        artifactManifestSha256: entry.artifactManifestSha256,
        sourceSnapshotSha256: entry.sourceSnapshotSha256,
        providerEvidenceSha256: entry.providerEvidenceSha256,
        reservationSha256: result.value.reservation.reservationSha256,
        reservationReceiptSha256: result.value.reservation.reservationReceiptSha256,
        fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1" };
    }

    async function activatePreparedRestore(url: string,
      selector: TenantTelemetryCaptureRestoreMaintenanceSelector,
      configuredFleetRootSha256: string) {
      const maintenance = await MysqlSessionStore.connectTenantTelemetryCaptureRestoreMaintenance({
        url, tenantTelemetryRefKey: captureRefKey, selector,
      });
      try {
        expect(await maintenance.sealTenantRestoreReplay(selector.restoreRunId)).not.toBeNull();
        const before = await maintenance.getTenantRestoreRuntimeControl();
        if (before.state !== "active") throw new Error("fixture primary runtime missing");
        const activated = await maintenance.activateTenantRestoreRuntime({
          restoreRunId: selector.restoreRunId, expectedControlGeneration: before.controlGeneration,
        });
        if (activated.state !== "active" || activated.lineageKind !== "restore") {
          throw new Error("fixture restore activation missing");
        }
        const cutover = await maintenance.activateTenantTelemetryCaptureRestoredEpoch({
          expectedRuntimeEpochSha256: activated.runtimeEpochSha256,
          configuredFleetRootSha256,
          legacyWritersDrainedAck: "legacy-writers-drained-v1",
          producerReadyAck: "provider-step-error-v2-ready-v1",
        });
        expect(await maintenance.getTenantTelemetryCaptureEpochCutoverReceipt()).toEqual(cutover);
        return cutover;
      } finally { await maintenance.close(); }
    }

    it("keeps genuine pre-lifecycle history unknown while sealing a later fully verified v2 membership for the same tenant", async () => {
      const f = await fixture({ preActivationFailure: true });
      let cold: MysqlSessionStore | undefined;
      let bodyFailed = false;
      try {
        const step = await captureStepFixture(f.store);
        expect(step.session.tenantId).toBe("capture-tenant");
        const committed = await f.store.commitPersistedProviderStepFailure(step.input);
        expect(committed.replayed).toBe(false);
        expect(await f.store.getTenantTelemetryLifecycleCoverage(step.session.tenantId))
          .toMatchObject({ historyStatus: "legacy_history_unknown" });
        const selector = await prepare(f.store);
        const sealed = await f.store.getTenantTelemetryCaptureBackupCheckpoint(selector.backupId);
        expect(sealed?.checkpoint.checkpointSha256).toBe(selector.checkpointSha256);
        const operation = committed.failureCommitReceipt.writeOperationSha256;
        for (const family of ["write_job", "write_payload", "membership", "provider_source_binding",
          "provider_failure_commit"] as const) {
          const identity = tenantTelemetryCaptureCheckpointOperationIdentity(family, operation, captureRefKey);
          const actual = sealed!.leaves.filter((leaf) => leaf.family === family && leaf.identityRefSha256 === identity);
          expect(actual, `verified operation ${family} has one sealed leaf`).toHaveLength(1);
          expect(actual[0]!.knowledge, `verified operation ${family} knowledge`).toBe("validated_projection");
        }
        expect(sealed!.leaves.filter((leaf) => leaf.family === "legacy_failure"))
          .toEqual(expect.arrayContaining([expect.objectContaining({ knowledge: "legacy_unknown" })]));
        expect(sealed!.leaves.filter((leaf) => leaf.family === "lifecycle_coverage"))
          .toEqual(expect.arrayContaining([expect.objectContaining({ knowledge: "legacy_unknown" })]));
        const cutover = await activatePreparedRestore(f.url, selector, step.proof.configuredFleetRootSha256);
        await f.closeStore();
        cold = await MysqlSessionStore.connect({ url: f.url, migrationMode: "verify",
          tenantTelemetryRefKey: captureRefKey, tenantTelemetryPersistedProviderCaptureLocalOnly: true });
        expect((await cold.getTenantTelemetryPersistedProviderCaptureBinding())?.captureControlEvidenceSha256)
          .toBe(cutover.receiptSha256);
      } catch (error) { bodyFailed = true; throw error; }
      finally { await finishFixture(f, [cold?.close()], bodyFailed); }
    });

    it("rejects a checkpoint when the actual captured usage diverges from its independently retained billing fact", async () => {
      const f = await fixture();
      let bodyFailed = false;
      try {
        const step = await captureStepFixture(f.store);
        const committed = await f.store.commitPersistedProviderStepFailure(step.input);
        expect(committed.replayed).toBe(false);
        const usageId = step.batch.usageEntries?.[0]?.usageId;
        if (!usageId) throw new Error("fixture captured usage ID missing");
        const control = await f.store.getTenantBackupCatalogControl();
        if (control.state !== "active") throw new Error("fixture catalog inactive");
        const backupId = newTenantBackupId();
        await f.store.createTenantBackupSnapshotAnchor({ backupId,
          controlEvidenceSha256: control.evidenceSha256 });
        const [before] = await f.conn.query<RowDataPacket[]>(`SELECT model FROM usage_ledger
          WHERE BINARY usage_id=BINARY ?`, [usageId]);
        expect(before).toHaveLength(1);
        const originalModel = before[0]?.model;
        if (typeof originalModel !== "string") throw new Error("fixture usage model invalid");
        const [corrupted] = await f.conn.query<mysql.ResultSetHeader>(`UPDATE usage_ledger
          SET model=CONCAT(model,'-corrupted') WHERE BINARY usage_id=BINARY ?`, [usageId]);
        expect(corrupted.affectedRows).toBe(1);
        const [changed] = await f.conn.query<RowDataPacket[]>(`SELECT model FROM usage_ledger
          WHERE BINARY usage_id=BINARY ?`, [usageId]);
        expect(changed).toHaveLength(1);
        expect(changed[0]!.model).not.toBe(originalModel);
        await expect(f.store.sealTenantTelemetryCaptureBackupCheckpoint({ backupId,
          fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1" })).rejects.toMatchObject({
          name: "TenantTelemetryCaptureRestoreIntegrityError",
        });
        const [headers] = await f.conn.query<RowDataPacket[]>(`SELECT backup_id
          FROM tenant_telemetry_capture_backup_checkpoints WHERE BINARY backup_id=BINARY ?`, [backupId]);
        const [leaves] = await f.conn.query<RowDataPacket[]>(`SELECT backup_id
          FROM tenant_telemetry_capture_backup_checkpoint_leaves WHERE BINARY backup_id=BINARY ?`, [backupId]);
        expect(headers).toHaveLength(0);
        expect(leaves).toHaveLength(0);
        const [restored] = await f.conn.query<mysql.ResultSetHeader>(`UPDATE usage_ledger
          SET model=? WHERE BINARY usage_id=BINARY ?`, [originalModel, usageId]);
        expect(restored.affectedRows).toBe(1);
        const sealed = await f.store.sealTenantTelemetryCaptureBackupCheckpoint({ backupId,
          fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1" });
        expect(sealed?.disposition).toBe("created");
        const operation = committed.failureCommitReceipt.writeOperationSha256;
        const membershipIdentity = tenantTelemetryCaptureCheckpointOperationIdentity(
          "membership", operation, captureRefKey);
        expect(sealed?.value.leaves.filter((leaf) => leaf.family === "membership"
          && leaf.identityRefSha256 === membershipIdentity)).toEqual([
          expect.objectContaining({ knowledge: "validated_projection" }),
        ]);
      } catch (error) { bodyFailed = true; throw error; }
      finally { await finishFixture(f, [], bodyFailed); }
    });

    it("rejects an old-epoch raw claim without a permit, then atomically recovers the exact queued source and admits a new-epoch capture on ordinary cold start", async () => {
      const f = await fixture();
      let maintenance: Awaited<ReturnType<typeof MysqlSessionStore.connectTenantTelemetryCaptureRestoreMaintenance>> | undefined;
      let cold: MysqlSessionStore | undefined;
      let bodyFailed = false;
      try {
        const step = await captureStepFixture(f.store);
        const committed = await f.store.commitPersistedProviderStepFailure(step.input);
        expect(committed.replayed).toBe(false);
        const selector = await prepare(f.store);
        maintenance = await MysqlSessionStore.connectTenantTelemetryCaptureRestoreMaintenance({
          url: f.url, tenantTelemetryRefKey: captureRefKey, selector,
        });
        expect(await maintenance.sealTenantRestoreReplay(selector.restoreRunId)).not.toBeNull();
        const before = await maintenance.getTenantRestoreRuntimeControl();
        if (before.state !== "active") throw new Error("fixture primary runtime missing");
        const activated = await maintenance.activateTenantRestoreRuntime({
          restoreRunId: selector.restoreRunId, expectedControlGeneration: before.controlGeneration,
        });
        if (activated.state !== "active" || activated.lineageKind !== "restore") {
          throw new Error("fixture restore activation missing");
        }
        const cutover = await maintenance.activateTenantTelemetryCaptureRestoredEpoch({
          expectedRuntimeEpochSha256: selector.restoreRunId === activated.restoreRunId
            ? activated.runtimeEpochSha256 : "0".repeat(64),
          configuredFleetRootSha256: step.proof.configuredFleetRootSha256,
          legacyWritersDrainedAck: "legacy-writers-drained-v1",
          producerReadyAck: "provider-step-error-v2-ready-v1",
        });
        expect(cutover).toMatchObject({ phase: "active", newCaptureWritesAuthorized: true,
          historicalOperationRecoveryAuthorized: false, allDomainsComplete: false,
          contentPurgeExecuted: false });
        expect(await maintenance.getTenantTelemetryCaptureEpochCutoverReceipt()).toEqual(cutover);
        await maintenance.close(); maintenance = undefined;
        await f.closeStore();
        cold = await MysqlSessionStore.connect({ url: f.url, migrationMode: "verify",
          tenantTelemetryRefKey: captureRefKey,
          tenantTelemetryPersistedProviderCaptureLocalOnly: true });
        const newProof = await cold.getTenantTelemetryPersistedProviderCaptureBinding();
        expect(newProof).toMatchObject({ runtimeEpochSha256: cutover.runtimeEpochSha256,
          captureControlEvidenceSha256: cutover.receiptSha256 });
        const [oldRows] = await f.conn.query<RowDataPacket[]>(`SELECT write_operation_sha256,attempts,
          claim_token,lease_until_ms FROM tenant_telemetry_write_jobs WHERE BINARY tenant_id=BINARY ?`,
        [step.session.tenantId]);
        expect(oldRows).toHaveLength(1);
        const old = oldRows[0]!;
        await expect(f.conn.query(`UPDATE tenant_telemetry_write_jobs SET attempts=attempts+1,
          claim_token='forged',lease_until_ms=9999999999999 WHERE BINARY write_operation_sha256=BINARY ?`,
        [old.write_operation_sha256])).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION" });
        const [untouched] = await f.conn.query<RowDataPacket[]>(`SELECT attempts,claim_token,lease_until_ms
          FROM tenant_telemetry_write_jobs WHERE BINARY write_operation_sha256=BINARY ?`,
        [old.write_operation_sha256]);
        expect(untouched).toHaveLength(1);
        expect(untouched[0]!.attempts).toBe(old.attempts);
        expect(untouched[0]!.claim_token).toBe(old.claim_token);
        expect(untouched[0]!.lease_until_ms).toBe(old.lease_until_ms);
        const [none] = await f.conn.query<RowDataPacket[]>(
          "SELECT permit_receipt_sha256 FROM tenant_telemetry_capture_recovery_permits");
        expect(none).toHaveLength(0);
        const claim = (await cold.claimTenantTelemetryWriteJobs({ limit: 10, leaseMs: 120_000,
          claimToken: `cutover-claim-${randomUUID()}`,
          adapterProtocol: "telemetry-s3-object-v1", captureMode: "include_v2",
          freshProof: newProof!,
        })).find((value) => value.tenantId === step.session.tenantId);
        if (!claim?.captureRecovery) throw new Error("exact old-epoch recovery claim missing");
        expect(claim.captureRecovery).toMatchObject({ recoveryMode: "resume_queued" });
        const [permits] = await f.conn.query<RowDataPacket[]>(`SELECT permit_receipt_sha256,
          new_claim_attempt,cutover_receipt_sha256,checkpoint_sha256 FROM tenant_telemetry_capture_recovery_permits`);
        expect(permits).toHaveLength(1);
        expect(permits[0]!.permit_receipt_sha256).toBe(claim.captureRecovery.permitReceiptSha256);
        expect(permits[0]!.new_claim_attempt).toBe(claim.claimAttempt);
        expect(permits[0]!.cutover_receipt_sha256).toBe(cutover.receiptSha256);
        expect(permits[0]!.checkpoint_sha256).toBe(selector.checkpointSha256);
        const auth = { tenantId: claim.tenantId, writeOperationSha256: claim.writeOperationSha256,
          claimAttempt: claim.claimAttempt, claimToken: claim.claimToken };
        const reserved = await cold.reserveTenantTelemetryExternalMutation(auth,
          "telemetry-s3-object-v1", newProof!);
        expect(reserved).not.toBeNull();
        const localResult = tenantTelemetryWriteAdapterResult("telemetry-s3-object-v1", {
          writeOperationSha256: claim.writeOperationSha256, target: claim.target,
          inventory: claim.inventory, payload: claim.payload,
        }, "already_present", true);
        expect(await cold.completeTenantTelemetryWrite(auth, localResult, newProof!)).not.toBeNull();
        expect(await cold.completeTenantTelemetryWrite(auth, localResult, newProof!)).not.toBeNull();
        const next = await captureStepFixture(cold);
        const newCommit = await cold.commitPersistedProviderStepFailure(next.input);
        expect(newCommit.replayed).toBe(false);
        expect(newCommit.failureCommitReceipt.runtimeEpochSha256).toBe(cutover.runtimeEpochSha256);
        expect(newCommit.failureCommitReceipt.captureControlEvidenceSha256).toBe(cutover.receiptSha256);
      } catch (error) { bodyFailed = true; throw error; }
      finally { await finishFixture(f, [cold?.close(), maintenance?.close()], bodyFailed); }
    });

    it("recovers the exact pre-create reservation without issuing another reservation", async () => {
      const f = await fixture();
      let cold: MysqlSessionStore | undefined;
      let bodyFailed = false;
      try {
        const step = await captureStepFixture(f.store);
        const committed = await f.store.commitPersistedProviderStepFailure(step.input);
        expect(committed.replayed).toBe(false);
        const original = (await f.store.claimTenantTelemetryWriteJobs({ limit: 1, leaseMs: 30_000,
          claimToken: `pre-checkpoint-${randomUUID()}`, adapterProtocol: "telemetry-s3-object-v1",
          captureMode: "include_v2", freshProof: step.proof,
        }))[0];
        if (!original) throw new Error("fixture original claim missing");
        const originalAuth = { tenantId: original.tenantId, writeOperationSha256: original.writeOperationSha256,
          claimAttempt: original.claimAttempt, claimToken: original.claimToken };
        const originalReservation = await f.store.reserveTenantTelemetryExternalMutation(
          originalAuth, "telemetry-s3-object-v1", step.proof,
        );
        if (!originalReservation) throw new Error("fixture original reservation missing");
        expect(await f.store.retryTenantTelemetryWrite(originalAuth,
          { delayMs: 0, errorCode: "temporary_failure" })).toBe(true);
        const selector = await prepare(f.store);
        const cutover = await activatePreparedRestore(f.url, selector, step.proof.configuredFleetRootSha256);
        await f.closeStore();
        cold = await MysqlSessionStore.connect({ url: f.url, migrationMode: "verify",
          tenantTelemetryRefKey: captureRefKey, tenantTelemetryPersistedProviderCaptureLocalOnly: true });
        const proof = await cold.getTenantTelemetryPersistedProviderCaptureBinding();
        expect(proof?.captureControlEvidenceSha256).toBe(cutover.receiptSha256);
        const recovered = (await cold.claimTenantTelemetryWriteJobs({ limit: 1, leaseMs: 30_000,
          claimToken: `recovered-reserved-${randomUUID()}`, adapterProtocol: "telemetry-s3-object-v1",
          captureMode: "include_v2", freshProof: proof!,
        }))[0];
        if (!recovered?.captureRecovery) throw new Error("fixture recovery permit missing");
        expect(recovered.captureRecovery.recoveryMode).toBe("resume_reserved");
        expect(recovered.reservation).toEqual(originalReservation);
        const [permitRows] = await f.conn.query<RowDataPacket[]>(`SELECT receipt_json
          FROM tenant_telemetry_capture_recovery_permits WHERE BINARY write_operation_sha256=BINARY ?`,
        [original.writeOperationSha256]);
        expect(permitRows).toHaveLength(1);
        const permitValue: unknown = permitRows[0]!.receipt_json;
        const permit = (typeof permitValue === "string" ? JSON.parse(permitValue) : permitValue) as {
          reservationAtIssue: unknown;
        };
        expect(permit.reservationAtIssue).toMatchObject({ origin: "checkpoint",
          receiptSha256: originalReservation.receiptSha256 });
        const recoveredAuth = { tenantId: recovered.tenantId, writeOperationSha256: recovered.writeOperationSha256,
          claimAttempt: recovered.claimAttempt, claimToken: recovered.claimToken };
        expect(await cold.reserveTenantTelemetryExternalMutation(
          recoveredAuth, "telemetry-s3-object-v1", proof!)).toEqual(originalReservation);
        const [after] = await f.conn.query<RowDataPacket[]>(`SELECT mutation_reservation_receipt_sha256,
          mutation_started_claim_attempt FROM tenant_telemetry_write_jobs
          WHERE BINARY write_operation_sha256=BINARY ?`, [original.writeOperationSha256]);
        expect(after).toHaveLength(1);
        expect(after[0]!.mutation_reservation_receipt_sha256).toBe(originalReservation.receiptSha256);
        expect(after[0]!.mutation_started_claim_attempt).toBe(originalReservation.startedClaimAttempt);
        expect(await cold.verifyPersistedProviderStepFailureWrite(
          recovered.tenantId, recovered.writeOperationSha256, proof!, "create"))
          .toMatchObject({ sourceCount: 1 });
      } catch (error) { bodyFailed = true; throw error; }
      finally { await finishFixture(f, [cold?.close()], bodyFailed); }
    });

    it("keeps operator-only history readable without granting an ordinary runtime capture gate", async () => {
      const f = await fixture();
      let operator: Awaited<ReturnType<typeof MysqlSessionStore.connectTenantTelemetryCaptureRestoreMaintenance>> | undefined;
      let bodyFailed = false;
      try {
        const step = await captureStepFixture(f.store);
        expect((await f.store.commitPersistedProviderStepFailure(step.input)).replayed).toBe(false);
        const selector = await prepare(f.store);
        const cutover = await activatePreparedRestore(f.url, selector, step.proof.configuredFleetRootSha256);
        await f.closeStore();
        operator = await MysqlSessionStore.connectTenantTelemetryCaptureRestoreMaintenance({
          url: f.url, tenantTelemetryRefKey: captureRefKey, selector,
        });
        expect(await operator.getTenantTelemetryCaptureEpochCutoverReceipt()).toEqual(cutover);
        expect(await operator.getTenantTelemetryCaptureRestoreHistoryReceipt()).not.toBeNull();
        await expect(MysqlSessionStore.connect({ url: f.url, migrationMode: "verify",
          tenantTelemetryRefKey: captureRefKey, tenantTelemetryCaptureRestoreLocalOnly: true,
          tenantTelemetryPersistedProviderCaptureLocalOnly: false })).rejects.toThrow();
        const [unchanged] = await f.conn.query<RowDataPacket[]>(
          "SELECT permit_receipt_sha256 FROM tenant_telemetry_capture_recovery_permits");
        expect(unchanged).toHaveLength(0);
      } catch (error) { bodyFailed = true; throw error; }
      finally { await finishFixture(f, [operator?.close()], bodyFailed); }
    });

    it("serializes two real RR recovery claims to one durable permit and one claim", async () => {
      const f = await fixture();
      let first: MysqlSessionStore | undefined;
      let second: MysqlSessionStore | undefined;
      let held = false;
      let bodyFailed = false;
      const pending: Array<ReturnType<MysqlSessionStore["claimTenantTelemetryWriteJobs"]>> = [];
      const watched: Array<Promise<PromiseSettledResult<Awaited<ReturnType<
        MysqlSessionStore["claimTenantTelemetryWriteJobs"]>>>>> = [];
      try {
        const step = await captureStepFixture(f.store);
        expect((await f.store.commitPersistedProviderStepFailure(step.input)).replayed).toBe(false);
        const selector = await prepare(f.store);
        await activatePreparedRestore(f.url, selector, step.proof.configuredFleetRootSha256);
        await f.closeStore();
        first = await MysqlSessionStore.connect({ url: f.url, migrationMode: "verify",
          connectionLimit: 1, tenantTelemetryRefKey: captureRefKey,
          tenantTelemetryPersistedProviderCaptureLocalOnly: true });
        second = await MysqlSessionStore.connect({ url: f.url, migrationMode: "verify",
          connectionLimit: 1, tenantTelemetryRefKey: captureRefKey,
          tenantTelemetryPersistedProviderCaptureLocalOnly: true });
        const proof = await first.getTenantTelemetryPersistedProviderCaptureBinding();
        expect(proof).not.toBeNull();
        expect(await second.getTenantTelemetryPersistedProviderCaptureBinding()).toEqual(proof);
        await f.conn.beginTransaction(); held = true;
        const [locked] = await f.conn.query<RowDataPacket[]>(`SELECT domain
          FROM tenant_telemetry_capture_v2_controls WHERE domain='logs' FOR UPDATE`);
        expect(locked).toHaveLength(1);
        for (const store of [first, second]) {
          const claim = store.claimTenantTelemetryWriteJobs({ limit: 1, leaseMs: 30_000,
            claimToken: `parallel-claim-${randomUUID()}`, adapterProtocol: "telemetry-s3-object-v1",
            captureMode: "include_v2", freshProof: proof!,
          });
          pending.push(claim);
          watched.push(claim.then(
            (value) => ({ status: "fulfilled", value } as const),
            (reason: unknown) => ({ status: "rejected", reason } as const),
          ));
        }
        const database = decodeURIComponent(new URL(f.url).pathname.slice(1));
        const deadline = Date.now() + 10_000;
        let observedBothRR = false;
        // MySQL 8.0.26 refreshes the I_S transaction cache only after >100ms without a read;
        // faster polling can retain the pre-claim snapshot throughout this observation window.
        // https://github.com/mysql/mysql-server/blob/mysql-8.0.26/storage/innobase/trx/trx0i_s.cc
        while (Date.now() < deadline) {
          const [waiters] = await admin.query<RowDataPacket[]>(`SELECT
              COUNT(DISTINCT w.REQUESTING_THREAD_ID) AS waiting_transactions,
              COUNT(DISTINCT CASE WHEN t.trx_isolation_level='REPEATABLE READ'
                THEN w.REQUESTING_THREAD_ID END) AS rr_transactions
            FROM performance_schema.data_lock_waits w
            JOIN performance_schema.data_locks l
              ON l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID
            JOIN performance_schema.threads p
              ON p.THREAD_ID=w.REQUESTING_THREAD_ID
            JOIN information_schema.innodb_trx t
              ON t.trx_mysql_thread_id=p.PROCESSLIST_ID
            WHERE BINARY l.OBJECT_SCHEMA=BINARY ?
              AND BINARY l.OBJECT_NAME=BINARY 'tenant_telemetry_capture_v2_controls'
              AND BINARY l.INDEX_NAME=BINARY 'PRIMARY'`, [database]);
          if (Number(waiters[0]?.waiting_transactions) === 2
            && Number(waiters[0]?.rr_transactions) === 2) {
            expect(Number(waiters[0]?.rr_transactions)).toBe(2);
            observedBothRR = true;
            break;
          }
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) break;
          await new Promise<void>((resolve) => setTimeout(resolve, Math.min(125, remainingMs)));
        }
        expect(observedBothRR).toBe(true);
        await f.conn.commit(); held = false;
        const settled = await Promise.all(watched);
        const results = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
        const claims = results.flat();
        if (claims.length !== 1 || results.length !== 2
          || results.filter((result) => result.length === 0).length !== 1) {
          const classified = settled.map((result) => {
            if (result.status === "fulfilled") return { state: "fulfilled" as const,
              claimCount: result.value.length };
            const failure = result.reason && typeof result.reason === "object"
              ? result.reason as { name?: unknown; code?: unknown; stack?: unknown } : {};
            const category = typeof failure.name === "string" && [
              "TenantTelemetryCaptureRestoreIntegrityError", "TenantTelemetryWriteIntegrityError",
              "TenantTelemetryWriteConflictError", "PersistedProviderCaptureConflictError",
            ].includes(failure.name) ? failure.name : "other";
            const sqlCode = typeof failure.code === "string" && [
              "ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT", "ER_SIGNAL_EXCEPTION",
            ].includes(failure.code) ? failure.code : "other";
            const sourceLine = typeof failure.stack === "string"
              ? failure.stack.match(/\/packages\/store\/src\/mysql\/store\.ts:(\d+):\d+/)?.[1] : undefined;
            return { state: "rejected" as const, category, sqlCode,
              firstStoreLine: sourceLine === undefined ? null : Number(sourceLine) };
          });
          let eligibility: { rows: number; queued?: boolean; available?: boolean;
            leaseClaimable?: boolean; sourceV2?: boolean; runtimeCandidate?: boolean;
            adapterCandidate?: boolean; readFailed?: boolean } = { rows: 0, readFailed: true };
          try {
            const [candidateRows] = await f.conn.query<RowDataPacket[]>(`SELECT
              j.phase='queued' AS queued,
              j.available_at_ms<=FLOOR(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000) AS available,
              (j.claim_token IS NULL OR j.lease_until_ms<=FLOOR(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000)) AS lease_claimable,
              BINARY JSON_UNQUOTE(JSON_EXTRACT(j.inventory_json,'$.sourceSchema'))=BINARY 'provider-step-error-v2' AS source_v2,
              EXISTS (SELECT 1 FROM tenant_restore_runtime_control r
                WHERE r.singleton_id=1 AND (r.state='inactive'
                  OR (r.state='active' AND (r.lineage_kind='primary'
                    OR (BINARY r.runtime_epoch_sha256=BINARY JSON_UNQUOTE(JSON_EXTRACT(j.inventory_json,'$.runtimeEpochSha256'))
                      AND BINARY r.lineage_kind=BINARY JSON_UNQUOTE(JSON_EXTRACT(j.inventory_json,'$.restoreLineageKind')))
                    OR BINARY JSON_UNQUOTE(JSON_EXTRACT(j.inventory_json,'$.sourceSchema'))=BINARY 'provider-step-error-v2')))) AS runtime_candidate,
              EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_targets t
                WHERE t.target_sha256=j.target_sha256 AND t.adapter_protocol='telemetry-s3-object-v1') AS adapter_candidate
              FROM tenant_telemetry_write_jobs j WHERE BINARY j.tenant_id=BINARY ?`,
            [step.session.tenantId]);
            eligibility = { rows: candidateRows.length, readFailed: false };
            if (candidateRows.length === 1) {
              const row = candidateRows[0]!;
              eligibility = { ...eligibility, queued: Number(row.queued) === 1,
                available: Number(row.available) === 1,
                leaseClaimable: Number(row.lease_claimable) === 1,
                sourceV2: Number(row.source_v2) === 1,
                runtimeCandidate: Number(row.runtime_candidate) === 1,
                adapterCandidate: Number(row.adapter_candidate) === 1 };
            }
          } catch { /* Keep only the fixed diagnostic read-failure bit. */ }
          throw new Error(`parallel claim cardinality changed: ${JSON.stringify({ classified, eligibility })}`);
        }
        expect(claims).toHaveLength(1);
        expect(results.filter((result) => result.length === 0)).toHaveLength(1);
        const claim = claims[0]!;
        expect(claim.tenantId).toBe(step.session.tenantId);
        expect(claim.captureRecovery?.recoveryMode).toBe("resume_queued");
        const [jobs] = await f.conn.query<RowDataPacket[]>(`SELECT attempts,claim_token,lease_until_ms
          FROM tenant_telemetry_write_jobs WHERE BINARY write_operation_sha256=BINARY ?`,
        [claim.writeOperationSha256]);
        const [permits] = await f.conn.query<RowDataPacket[]>(`SELECT permit_receipt_sha256
          FROM tenant_telemetry_capture_recovery_permits
          WHERE BINARY write_operation_sha256=BINARY ?`, [claim.writeOperationSha256]);
        expect(jobs).toHaveLength(1);
        expect(jobs[0]!.attempts).toBe(1);
        expect(jobs[0]!.claim_token).toBe(claim.claimToken);
        expect(jobs[0]!.lease_until_ms).toBe(claim.leaseUntilMs);
        expect(permits).toHaveLength(1);
        expect(permits[0]!.permit_receipt_sha256).toBe(claim.captureRecovery?.permitReceiptSha256);
      } catch (error) { bodyFailed = true; throw error; }
      finally {
        if (held) await f.conn.rollback().catch(() => {});
        if (pending.length) await Promise.allSettled(pending);
        await finishFixture(f, [first?.close(), second?.close()], bodyFailed);
      }
    });

    it("rolls a reached permit INSERT and job CAS back when the final DB lease expires", async () => {
      const f = await fixture();
      let cold: MysqlSessionStore | undefined;
      let bodyFailed = false;
      const probe = "fixture_0057_late_claim_probe";
      const nonce = randomUUID().replaceAll("-", "").slice(0, 16);
      const permitTrigger = `fixture_0057_permit_sleep_${nonce}`;
      const jobTrigger = `fixture_0057_job_cas_${nonce}`;
      let probeCreated = false;
      let permitTriggerCreated = false;
      let jobTriggerCreated = false;
      try {
        const step = await captureStepFixture(f.store);
        expect((await f.store.commitPersistedProviderStepFailure(step.input)).replayed).toBe(false);
        const selector = await prepare(f.store);
        await activatePreparedRestore(f.url, selector, step.proof.configuredFleetRootSha256);
        await f.closeStore();
        cold = await MysqlSessionStore.connect({ url: f.url, migrationMode: "verify",
          tenantTelemetryRefKey: captureRefKey,
          tenantTelemetryPersistedProviderCaptureLocalOnly: true });
        const proof = await cold.getTenantTelemetryPersistedProviderCaptureBinding();
        expect(proof).not.toBeNull();
        const [source] = await f.conn.query<RowDataPacket[]>(`SELECT write_operation_sha256
          FROM tenant_telemetry_write_jobs WHERE BINARY tenant_id=BINARY ?`, [step.session.tenantId]);
        expect(source).toHaveLength(1);
        const operation = String(source[0]!.write_operation_sha256);
        if (!/^[0-9a-f]{64}$/.test(operation)) throw new Error("invalid fixture operation identity");
        const snapshot = async () => {
          const tables = ["tenant_telemetry_write_jobs", "tenant_telemetry_capture_recovery_permits",
            "tenant_telemetry_write_payloads", "tenant_telemetry_write_acks",
            "tenant_telemetry_artifact_inventory"] as const;
          const result: Record<string, RowDataPacket[]> = {};
          for (const table of tables) {
            const [rows] = await f.conn.query<RowDataPacket[]>(`SELECT * FROM ${table}`);
            result[table] = rows;
          }
          return result;
        };
        const before = await snapshot();
        await f.conn.query(`CREATE TABLE \`${probe}\` (phase VARCHAR(24) NOT NULL PRIMARY KEY)
          ENGINE=MEMORY`); probeCreated = true;
        await f.conn.query(`CREATE TRIGGER \`${permitTrigger}\` AFTER INSERT
          ON tenant_telemetry_capture_recovery_permits FOR EACH ROW BEGIN
          INSERT INTO \`${probe}\` (phase) VALUES ('permit_inserted');
          DO SLEEP(3.2);
        END`); permitTriggerCreated = true;
        await f.conn.query(`CREATE TRIGGER \`${jobTrigger}\` AFTER UPDATE
          ON tenant_telemetry_write_jobs FOR EACH ROW BEGIN
          IF NEW.attempts=OLD.attempts+1
            AND BINARY NEW.write_operation_sha256=BINARY '${operation}' THEN
            INSERT INTO \`${probe}\` (phase) VALUES ('job_cas');
          END IF;
        END`); jobTriggerCreated = true;
        let outcome: { state: "fulfilled" } | { state: "rejected"; error: unknown };
        try {
          await cold.claimTenantTelemetryWriteJobs({ limit: 1, leaseMs: 1_000,
            claimToken: `late-lease-${randomUUID()}`, adapterProtocol: "telemetry-s3-object-v1",
            captureMode: "include_v2", freshProof: proof!,
          });
          outcome = { state: "fulfilled" };
        } catch (error) { outcome = { state: "rejected", error }; }
        const [marks] = await f.conn.query<RowDataPacket[]>(`SELECT phase FROM \`${probe}\` ORDER BY phase`);
        expect(marks.map((row) => row.phase)).toEqual(["job_cas", "permit_inserted"]);
        expect(outcome.state).toBe("rejected");
        if (outcome.state === "rejected") {
          expect(outcome.error).toMatchObject({ name: "TenantTelemetryCaptureRestoreIntegrityError" });
        }
        await f.conn.query(`DROP TRIGGER \`${jobTrigger}\``); jobTriggerCreated = false;
        await f.conn.query(`DROP TRIGGER \`${permitTrigger}\``); permitTriggerCreated = false;
        await f.conn.query(`DROP TABLE \`${probe}\``); probeCreated = false;
        expect(await snapshot()).toEqual(before);
      } catch (error) { bodyFailed = true; throw error; }
      finally {
        const cleanup = await Promise.allSettled([
          ...(jobTriggerCreated ? [f.conn.query(`DROP TRIGGER \`${jobTrigger}\``)] : []),
          ...(permitTriggerCreated ? [f.conn.query(`DROP TRIGGER \`${permitTrigger}\``)] : []),
        ]);
        if (probeCreated) cleanup.push(...await Promise.allSettled([f.conn.query(`DROP TABLE \`${probe}\``)]));
        const cleanupFailed = cleanup.find((result) => result.status === "rejected");
        const hadBodyFailure = bodyFailed;
        await finishFixture(f, [cold?.close()], bodyFailed || cleanupFailed?.status === "rejected");
        if (cleanupFailed?.status === "rejected" && !hadBodyFailure) throw cleanupFailed.reason;
      }
    });

    it("rejects a re-signed written ACK and job completion token that differs from the durable latest permit", async () => {
      const f = await fixture();
      let cold: MysqlSessionStore | undefined;
      let bodyFailed = false;
      try {
        const step = await captureStepFixture(f.store);
        expect((await f.store.commitPersistedProviderStepFailure(step.input)).replayed).toBe(false);
        const selector = await prepare(f.store);
        await activatePreparedRestore(f.url, selector, step.proof.configuredFleetRootSha256);
        await f.closeStore();
        cold = await MysqlSessionStore.connect({ url: f.url, migrationMode: "verify",
          tenantTelemetryRefKey: captureRefKey,
          tenantTelemetryPersistedProviderCaptureLocalOnly: true });
        const proof = await cold.getTenantTelemetryPersistedProviderCaptureBinding();
        expect(proof).not.toBeNull();
        const claim = (await cold.claimTenantTelemetryWriteJobs({ limit: 1, leaseMs: 30_000,
          claimToken: `written-recovery-${randomUUID()}`, adapterProtocol: "telemetry-s3-object-v1",
          captureMode: "include_v2", freshProof: proof!,
        }))[0];
        if (!claim?.captureRecovery) throw new Error("fixture recovered claim missing");
        const authorization = { tenantId: claim.tenantId,
          writeOperationSha256: claim.writeOperationSha256,
          claimAttempt: claim.claimAttempt, claimToken: claim.claimToken };
        expect(await cold.reserveTenantTelemetryExternalMutation(
          authorization, "telemetry-s3-object-v1", proof!)).not.toBeNull();
        const result = tenantTelemetryWriteAdapterResult("telemetry-s3-object-v1", {
          writeOperationSha256: claim.writeOperationSha256, target: claim.target,
          inventory: claim.inventory, payload: claim.payload,
        }, "already_present", true);
        expect(await cold.completeTenantTelemetryWrite(authorization, result, proof!)).not.toBeNull();
        const ack = await cold.getTenantTelemetryWriteAck(claim.tenantId, claim.writeOperationSha256);
        if (!ack) throw new Error("fixture written ACK missing");
        const [permitRows] = await f.conn.query<RowDataPacket[]>(`SELECT new_claim_attempt,new_claim_token_sha256
          FROM tenant_telemetry_capture_recovery_permits
          WHERE BINARY write_operation_sha256=BINARY ?`, [claim.writeOperationSha256]);
        expect(permitRows).toHaveLength(1);
        expect(ack.completedClaimAttempt).toBe(Number(permitRows[0]!.new_claim_attempt));
        expect(ack.completedClaimTokenSha256).toBe(permitRows[0]!.new_claim_token_sha256);
        const forgedTokenSha256 = sha(`different-completion-token-${randomUUID()}`);
        expect(forgedTokenSha256).not.toBe(ack.completedClaimTokenSha256);
        const { receiptSha256: originalAckSha256, ...ackBody } = ack;
        const forgedAckBody = { ...ackBody, completedClaimTokenSha256: forgedTokenSha256 };
        const forgedAckSha256 = tenantTelemetryWriteAckSha256(forgedAckBody);
        expect(forgedAckSha256).not.toBe(originalAckSha256);

        const database = decodeURIComponent(new URL(f.url).pathname.slice(1));
        if (!/^agent_service_cutover_test_[0-9a-f]{12}$/.test(database)) {
          throw new Error("unsafe isolated written-ACK fixture database");
        }
        const [sessionRows] = await f.conn.query<RowDataPacket[]>(
          "SELECT DATABASE() AS activeDb,@@SESSION.sql_mode AS sqlMode");
        if (sessionRows.length !== 1 || sessionRows[0]!.activeDb !== database
          || typeof sessionRows[0]!.sqlMode !== "string") {
          throw new Error("written-ACK fixture connection is not bound to its isolated database");
        }
        const originalSqlMode = String(sessionRows[0]!.sqlMode);
        const guardedTables = [
          { table: "tenant_telemetry_write_jobs", names: [
            "trg_managed_telemetry_write_jobs_bu",
            "trg_managed_telemetry_write_jobs_reservation_bu",
            "trg_managed_telemetry_write_jobs_terminal_reservation_bu",
            "trg_tt_owner_closure_write_job_bu",
            "trg_tt_capture_recovery_write_job_bu",
          ] },
          { table: "tenant_telemetry_write_acks", names: [
            "trg_managed_telemetry_write_acks_bu",
          ] },
        ] as const;
        const triggerMetadata = async (table: string) => {
          const [rows] = await f.conn.query<RowDataPacket[]>(`SELECT TRIGGER_NAME AS name,
            ACTION_ORDER AS actionOrder,ACTION_STATEMENT AS body,SQL_MODE AS sqlMode,
            DEFINER AS definer FROM information_schema.TRIGGERS
            WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?
              AND ACTION_TIMING='BEFORE' AND EVENT_MANIPULATION='UPDATE'
            ORDER BY ACTION_ORDER`, [table]);
          return rows.map((row) => ({ name: String(row.name), actionOrder: Number(row.actionOrder),
            body: String(row.body), sqlMode: String(row.sqlMode), definer: String(row.definer) }));
        };
        const beforeGuards = new Map<string, Awaited<ReturnType<typeof triggerMetadata>>>();
        const originals: Array<{ name: string; createSql: string; sqlMode: string }> = [];
        for (const guarded of guardedTables) {
          const rows = await triggerMetadata(guarded.table);
          expect(rows.map((row) => row.name).sort()).toEqual([...guarded.names].sort());
          beforeGuards.set(guarded.table, rows);
          for (const row of rows) {
            const [definition] = await f.conn.query<RowDataPacket[]>(`SHOW CREATE TRIGGER \`${row.name}\``);
            const createSql = definition[0]?.["SQL Original Statement"];
            const sqlMode = definition[0]?.sql_mode;
            if (typeof createSql !== "string" || typeof sqlMode !== "string"
              || !createSql.includes(row.name)) throw new Error("isolated guard definition missing");
            originals.push({ name: row.name, createSql, sqlMode });
          }
        }
        await expect(f.conn.query(`UPDATE tenant_telemetry_write_acks
          SET completed_claim_token_sha256=? WHERE BINARY write_operation_sha256=BINARY ?`,
        [forgedTokenSha256, claim.writeOperationSha256])).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION" });
        const dropped: typeof originals = [];
        let corruptionError: unknown;
        let restoreError: unknown;
        try {
          for (const guard of [...originals].reverse()) {
            await f.conn.query(`DROP TRIGGER \`${guard.name}\``);
            dropped.push(guard);
          }
          const [updatedAck] = await f.conn.query<mysql.ResultSetHeader>(`UPDATE tenant_telemetry_write_acks
            SET completed_claim_token_sha256=?,receipt_sha256=?
            WHERE BINARY write_operation_sha256=BINARY ?`,
          [forgedTokenSha256, forgedAckSha256, claim.writeOperationSha256]);
          const [updatedJob] = await f.conn.query<mysql.ResultSetHeader>(`UPDATE tenant_telemetry_write_jobs
            SET completed_claim_token_sha256=?,write_ack_receipt_sha256=?
            WHERE BINARY write_operation_sha256=BINARY ?`,
          [forgedTokenSha256, forgedAckSha256, claim.writeOperationSha256]);
          expect(updatedAck.affectedRows).toBe(1);
          expect(updatedJob.affectedRows).toBe(1);
        } catch (error) { corruptionError = error; }
        finally {
          for (const guard of [...dropped].reverse()) {
            try {
              await f.conn.query("SET SESSION sql_mode=?", [guard.sqlMode]);
              await f.conn.query(guard.createSql);
            } catch (error) { restoreError ??= error; }
          }
          try { await f.conn.query("SET SESSION sql_mode=?", [originalSqlMode]); }
          catch (error) { restoreError ??= error; }
        }
        if (corruptionError || restoreError) {
          throw new AggregateError([corruptionError, restoreError].filter((value) => value !== undefined),
            "isolated written-ACK re-signing or guard restoration failed");
        }
        for (const guarded of guardedTables) {
          expect(await triggerMetadata(guarded.table)).toEqual(beforeGuards.get(guarded.table));
        }
        const [forgedAckRows] = await f.conn.query<RowDataPacket[]>(`SELECT completed_claim_token_sha256,
          receipt_sha256 FROM tenant_telemetry_write_acks
          WHERE BINARY write_operation_sha256=BINARY ?`, [claim.writeOperationSha256]);
        const [forgedJobRows] = await f.conn.query<RowDataPacket[]>(`SELECT completed_claim_token_sha256,
          write_ack_receipt_sha256 FROM tenant_telemetry_write_jobs
          WHERE BINARY write_operation_sha256=BINARY ?`, [claim.writeOperationSha256]);
        expect(forgedAckRows).toHaveLength(1);
        expect(forgedJobRows).toHaveLength(1);
        expect(forgedAckRows[0]).toMatchObject({ completed_claim_token_sha256: forgedTokenSha256,
          receipt_sha256: forgedAckSha256 });
        expect(forgedJobRows[0]).toMatchObject({ completed_claim_token_sha256: forgedTokenSha256,
          write_ack_receipt_sha256: forgedAckSha256 });
        expect(tenantTelemetryWriteAckSha256(forgedAckBody)).toBe(forgedAckSha256);
        await expect(cold.getTenantTelemetryPersistedProviderCaptureBinding()).rejects.toMatchObject({
          name: "TenantTelemetryCaptureRestoreIntegrityError",
        });
        await expect(MysqlSessionStore.connect({ url: f.url, migrationMode: "verify",
          tenantTelemetryRefKey: captureRefKey,
          tenantTelemetryPersistedProviderCaptureLocalOnly: true })).rejects.toMatchObject({
          name: "TenantTelemetryWriteIntegrityError",
          message: "tenant telemetry write evidence is invalid",
        });
      } catch (error) { bodyFailed = true; throw error; }
      finally { await finishFixture(f, [cold?.close()], bodyFailed); }
    });
  });
} else {
  describe.skip("0057 capture epoch cutover requires local MySQL integration", () => {
    it("requires AGENT_SERVICE_INTEGRATION", () => {});
  });
}
