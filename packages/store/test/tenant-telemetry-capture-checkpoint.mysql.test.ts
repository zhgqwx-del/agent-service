import { createHash, randomUUID } from "node:crypto";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, describe, expect, it, type TestContext } from "vitest";
import {
  EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
  MysqlSessionStore,
  TENANT_BACKUP_CATALOG_ENTRY_SCOPE,
  TENANT_BACKUP_CATALOG_PROTOCOL,
  TenantTelemetryCaptureRestoreIntegrityError,
  assertMysqlSessionStoreDatabaseBinding,
  newTenantBackupId,
  readTenantTelemetryCaptureCheckpointFromMysql,
  tenantBackupAvailabilityOperationSha256,
  tenantBackupAvailabilityReceiptSha256,
  tenantBackupCatalogEntrySha256,
  tenantBackupCatalogEventSha256,
  tenantBackupCatalogNextEventRootSha256,
  tenantBackupReservationReceiptSha256,
  tenantBackupRuntimeReservationOperationSha256,
  tenantRestoreRuntimeEpochSha256,
  tenantTelemetryWriteAdapterResult,
  type TenantBackupCatalogEntry,
  type TenantBackupCatalogEventProof,
  type TenantBackupRuntimeReservationAdapterResult,
} from "../src/index.js";
import { activateCaptureFixture, captureRefKey, captureStepFixture } from "./persisted-provider-capture.fixture.js";
import { createMysqlOperationAbortTransport } from "../src/mysql/operation-abort.js";

const BASE_MYSQL_URL = process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const h = (value: string) => createHash("sha256").update(value).digest("hex");
const d = (value: string) => value.repeat(64);

function disposableBase(raw: string): URL {
  const base = new URL(raw);
  const name = decodeURIComponent(base.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (base.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)
    || !/(?:^|[_-])test(?:$|[_-])/i.test(name)) {
    throw new Error("MYSQL_TEST_URL must name a local disposable test database");
  }
  return base;
}
function databaseUrl(base: URL, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("0055 capture checkpoint: real isolated MySQL physical projection", () => {
    let base: URL;
    const owned = new Set<string>();
    type Raw = { connection?: Connection; admin: boolean; errorSeen?: boolean; error?: unknown;
      transport: ReturnType<typeof createMysqlOperationAbortTransport>; closing?: Promise<void> };
    type Fixture = { name: string; admin?: Connection; created: boolean };
    type CaseScope = { signal: AbortSignal; startups: Set<Promise<unknown>>; stores: Set<MysqlSessionStore>;
      raw: Set<Raw>; fixtures: Fixture[]; failed: boolean; cleanupReported: boolean; settled: boolean;
      work?: Promise<void>; closing?: Promise<void> };
    const cases = new Set<CaseScope>();

    function startup<T>(scope: CaseScope, promise: Promise<T>): Promise<T> {
      scope.startups.add(promise);
      void promise.then(() => scope.startups.delete(promise), () => scope.startups.delete(promise));
      return promise;
    }
    async function joinStartups(scope: CaseScope): Promise<void> {
      while (scope.startups.size) await Promise.allSettled([...scope.startups]);
    }
    function openStore(scope: CaseScope, options: Parameters<typeof MysqlSessionStore.connect>[0]) {
      scope.signal.throwIfAborted();
      return startup(scope, MysqlSessionStore.connect({ ...options, operationAbortSignal: scope.signal }).then(store => {
        scope.stores.add(store); scope.signal.throwIfAborted(); return store;
      }));
    }
    function openRaw(scope: CaseScope, url: string, admin = false): Promise<Connection> {
      scope.signal.throwIfAborted();
      const raw: Raw = { admin, transport: createMysqlOperationAbortTransport(scope.signal) };
      scope.raw.add(raw);
      return startup(scope, mysql.createConnection({ uri: url, stream: raw.transport.stream }).then(connection => {
        raw.connection = connection;
        connection.on("error", (error: unknown) => { raw.errorSeen = true; raw.error = error; });
        scope.signal.throwIfAborted(); return connection;
      }));
    }
    function closeRaw(raw: Raw): Promise<void> {
      return raw.closing ??= (async () => {
        try { await raw.connection?.end(); }
        finally { raw.transport.close(); await raw.transport.settled(); }
        if (raw.errorSeen) throw raw.error;
      })();
    }
    function closeCase(scope: CaseScope): Promise<void> {
      return scope.closing ??= (async () => {
        // Never join the whole body here: its original finally is awaiting this close.
        await joinStartups(scope);
        const failures: unknown[] = [];
        const closed = await Promise.allSettled([
          ...[...scope.stores].map(store => store.close()),
          ...[...scope.raw].filter(raw => !raw.admin).map(closeRaw),
        ]);
        for (const result of closed) if (result.status === "rejected") failures.push(result.reason);
        try {
          if (!scope.failed && !scope.signal.aborted && failures.length === 0) {
            for (const fixture of scope.fixtures) {
              if (!fixture.created || !fixture.admin) throw new Error("checkpoint fixture CREATE is not confirmed");
              if ([...scope.raw].some(raw => raw.admin && raw.errorSeen)) throw new Error("checkpoint fixture admin failed");
              await fixture.admin.query(`DROP DATABASE \`${fixture.name}\``);
              owned.delete(fixture.name);
            }
          }
        } catch (error) { failures.push(error); }
        const admins = await Promise.allSettled([...scope.raw].filter(raw => raw.admin).map(closeRaw));
        for (const result of admins) if (result.status === "rejected") failures.push(result.reason);
        if (failures.length) throw failures[0];
      })();
    }
    async function finishCase(scope: CaseScope): Promise<void> {
      try { await closeCase(scope); }
      catch (error) {
        if (!scope.failed) { scope.failed = true; throw error; }
        if (!scope.cleanupReported) {
          scope.cleanupReported = true;
          try { console.warn("checkpoint_fixture_cleanup_failed_after_primary_failure"); } catch { /* Preserve the primary failure. */ }
        }
      }
    }
    function runCase(body: (scope: CaseScope) => Promise<void>) {
      return (context: TestContext): Promise<void> => {
        if ([...cases].some(previous => !previous.settled)) throw new Error("checkpoint previous case work is not settled");
        const scope: CaseScope = { signal: context.signal, startups: new Set(), stores: new Set(), raw: new Set(),
          fixtures: [], failed: false, cleanupReported: false, settled: false };
        cases.add(scope);
        // Register the complete original body before its first fixture can start.
        const work = Promise.resolve().then(async () => {
          try { scope.signal.throwIfAborted(); await body(scope); scope.signal.throwIfAborted(); }
          catch (error) { scope.failed = true; throw error; }
          finally { await finishCase(scope); }
        });
        scope.work = work;
        void work.then(() => { scope.settled = true; }, () => { scope.settled = true; });
        return work;
      };
    }

    beforeAll(() => {
      base = disposableBase(BASE_MYSQL_URL);
    });
    afterEach(async () => {
      for (const scope of cases) {
        await Promise.allSettled([scope.work!]);
        await joinStartups(scope);
        await finishCase(scope);
      }
    });
    afterAll(async () => {
      for (const scope of cases) {
        await Promise.allSettled([scope.work!]);
        await joinStartups(scope);
        await finishCase(scope);
      }
      if (owned.size) {
        try { console.warn(JSON.stringify({ schema: "checkpoint-fixture-cleanup-v1", status: "retained_or_unknown", databases: [...owned] })); }
        catch { /* Reporting cannot replace the original case failure. */ }
        if (![...cases].some(scope => scope.failed || scope.signal.aborted)) {
          throw new Error("checkpoint fixture cleanup is not proven");
        }
      }
    });

    function fixture(scope: CaseScope, active: boolean, withRefKey = true) {
      scope.signal.throwIfAborted();
      const work = (async () => {
        const name = `agent_service_ckpt_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        const record: Fixture = { name, created: false }; scope.fixtures.push(record);
        const admin = await openRaw(scope, databaseUrl(base, "mysql"), true); record.admin = admin;
        const [existing] = await admin.query<RowDataPacket[]>(
          "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", [name],
        );
        if (existing.length) throw new Error("isolated checkpoint database already exists");
        scope.signal.throwIfAborted();
        // An interrupted CREATE response is not evidence that its DDL rolled back.
        owned.add(name);
        await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`);
        record.created = true; scope.signal.throwIfAborted();
        const url = databaseUrl(base, name);
        const store = await openStore(scope, { url, connectionLimit: 4,
          ...(withRefKey ? { tenantTelemetryRefKey: captureRefKey } : {}),
          tenantTelemetryPersistedProviderCaptureLocalOnly: true,
          tenantTelemetryCaptureRestoreLocalOnly: true });
        const conn = await openRaw(scope, url);
        if (active) {
          // This is an in-process journal/fleet fixture and does not claim S3,
          // sink or external writer ACK; the checkpoint itself is local-only.
          await activateCaptureFixture(store);
          await store.activateBlobStorageControl({ expectedControlGeneration: 0,
            storageBackend: "s3v1-checkpoint-fixture", namespaceSha256: h("checkpoint-blob") });
          const journal = await store.getTenantRestoreJournalControl();
          if (journal.controlGeneration !== 1) throw new Error("fixture journal inactive");
          await store.activateTenantBackupCatalogControl({ expectedControlGeneration: 0,
            adapterProtocol: "mysql-authoritative-backup-catalog-v1",
            catalogNamespaceSha256: h("checkpoint-catalog-namespace"),
            catalogTargetSha256: h("checkpoint-catalog-target"),
            failureDomainSha256: h("checkpoint-catalog-failure-domain"),
            logicalDatabaseNamespaceSha256: d("4"),
            journalControlEvidenceSha256: journal.evidenceSha256,
            retentionPolicySha256: h("checkpoint-catalog-retention"),
            minimumRetentionMs: 60_000, minimumRecoverableBackups: 1 });
        }
        return { name, url, store, conn, close: () => finishCase(scope) };
      })();
      return startup(scope, work);
    }
    async function anchor(store: MysqlSessionStore) {
      const control = await store.getTenantBackupCatalogControl();
      if (control.state !== "active") throw new Error("fixture catalog inactive");
      const backupId = newTenantBackupId();
      const created = await store.createTenantBackupSnapshotAnchor({ backupId,
        controlEvidenceSha256: control.evidenceSha256 });
      expect(created.value.backupId).toBe(backupId);
      return { backupId, anchorSha256: created.value.anchorSha256 };
    }
    const input = (backupId: string) => ({ backupId, fleetStoppedAck: "fleet-stopped-v1" as const,
      localOnlyAck: "local-only-v1" as const });
    function eventProof(sequence: number, previous: string, eventType: "backup_recoverable" | "restore_reserved",
      operationSha256: string, receiptSha256: string): TenantBackupCatalogEventProof {
      const catalogEventSha256 = tenantBackupCatalogEventSha256({ eventType, operationSha256, receiptSha256 });
      return { catalogSequence: sequence, previousCatalogEventRootSha256: previous, catalogEventSha256,
        catalogEventRootSha256: tenantBackupCatalogNextEventRootSha256({
          catalogSequence: sequence, previousCatalogEventRootSha256: previous, catalogEventSha256,
        }) };
    }
    async function publishAvailability(store: MysqlSessionStore, backupId: string): Promise<TenantBackupCatalogEntry> {
      const control = await store.getTenantBackupCatalogControl();
      const anchor = await store.getTenantBackupSnapshotAnchor(backupId);
      if (control.state !== "active" || !anchor) throw new Error("checkpoint availability fixture has no anchor");
      const base = { backupId, anchorSha256: anchor.anchorSha256,
        sourceSnapshotSha256: h(`checkpoint-source-snapshot-${backupId}`),
        sourceBackupSha256: h(`checkpoint-source-backup-${backupId}`),
        artifactManifestSha256: h(`checkpoint-artifact-manifest-${backupId}`),
        providerEvidenceSha256: h(`checkpoint-provider-evidence-${backupId}`),
        controlEvidenceSha256: anchor.controlEvidenceSha256,
        logicalDatabaseNamespaceSha256: anchor.logicalDatabaseNamespaceSha256,
        retentionPolicySha256: control.retentionPolicySha256,
        retentionUntilDbMs: anchor.retentionUntilDbMs,
        registeredAtDbMs: anchor.createdAtDbMs,
        catalogNamespaceSha256: control.catalogNamespaceSha256,
        catalogTargetSha256: control.catalogTargetSha256 };
      const availabilityOperationSha256 = tenantBackupAvailabilityOperationSha256(base);
      const availabilityReceiptSha256 = tenantBackupAvailabilityReceiptSha256({
        adapterProtocol: control.adapterProtocol, catalogNamespaceSha256: control.catalogNamespaceSha256,
        catalogTargetSha256: control.catalogTargetSha256, failureDomainSha256: control.failureDomainSha256,
      }, base, availabilityOperationSha256);
      const evidence = { adapterProtocol: control.adapterProtocol,
        failureDomainSha256: control.failureDomainSha256, ...base,
        availabilityOperationSha256, availabilityReceiptSha256,
        ...eventProof(1, EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
          "backup_recoverable", availabilityOperationSha256, availabilityReceiptSha256) };
      return (await store.recordTenantBackupCatalogAvailability({ ...evidence,
        entrySha256: tenantBackupCatalogEntrySha256({
          scope: TENANT_BACKUP_CATALOG_ENTRY_SCOPE, protocol: TENANT_BACKUP_CATALOG_PROTOCOL, ...evidence,
        }),
      })).value;
    }
    async function prepareInput(store: MysqlSessionStore, entry: TenantBackupCatalogEntry,
      checkpointSha256: string) {
      const control = await store.getTenantBackupCatalogControl();
      if (control.state !== "active") throw new Error("checkpoint reservation fixture catalog inactive");
      const restoreRunId = `restore_${randomUUID()}`;
      const runtimeEpochSha256 = tenantRestoreRuntimeEpochSha256(`checkpoint-new-epoch-${restoreRunId}`);
      const identity = { backupId: entry.backupId, restoreRunId, entrySha256: entry.entrySha256,
        runtimeEpochSha256 };
      const reservationOperationSha256 = tenantBackupRuntimeReservationOperationSha256(identity);
      const reservationReceiptSha256 = tenantBackupReservationReceiptSha256({
        adapterProtocol: control.adapterProtocol, catalogNamespaceSha256: control.catalogNamespaceSha256,
        catalogTargetSha256: control.catalogTargetSha256, failureDomainSha256: control.failureDomainSha256,
      }, identity, reservationOperationSha256);
      const reservation: TenantBackupRuntimeReservationAdapterResult = {
        adapterProtocol: control.adapterProtocol, catalogNamespaceSha256: control.catalogNamespaceSha256,
        catalogTargetSha256: control.catalogTargetSha256, ...identity,
        reservationOperationSha256, reservationReceiptSha256,
        ...eventProof(2, entry.catalogEventRootSha256, "restore_reserved",
          reservationOperationSha256, reservationReceiptSha256),
      };
      return { backupId: entry.backupId, restoreRunId, runtimeEpochSha256,
        controlEvidenceSha256: control.journalControlEvidenceSha256,
        sealedTargets: await store.getTenantRestoreRuntimeHeads(), reservation, captureCheckpointSha256: checkpointSha256 };
    }
    async function checkpointedAvailable(store: MysqlSessionStore) {
      const selected = await anchor(store);
      const sealed = await store.sealTenantTelemetryCaptureBackupCheckpoint(input(selected.backupId));
      if (!sealed || sealed.disposition !== "created") throw new Error("fixture checkpoint not sealed");
      const entry = await publishAvailability(store, selected.backupId);
      return { checkpoint: sealed.value.checkpoint, entry };
    }
    async function withOnlyOwnedSidecarDeleteGuardRemoved(
      conn: Connection, database: string, action: () => Promise<void>,
    ) {
      if (!/^agent_service_ckpt_test_[a-f0-9]{12}$/.test(database)) {
        throw new Error("unsafe checkpoint guard fixture database");
      }
      const guard = "trg_tt_capture_restore_binding_immutable_delete";
      const table = "tenant_telemetry_capture_restore_bindings";
      const query = `SELECT TRIGGER_NAME AS name,ACTION_ORDER AS actionOrder,ACTION_STATEMENT AS body,
        SQL_MODE AS sqlMode,DEFINER AS definer FROM information_schema.TRIGGERS
        WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=? AND ACTION_TIMING='BEFORE'
          AND EVENT_MANIPULATION='DELETE' ORDER BY ACTION_ORDER`;
      const [context] = await conn.query<RowDataPacket[]>("SELECT DATABASE() AS activeDb,@@SESSION.sql_mode AS sqlMode");
      if (context[0]?.activeDb !== database || typeof context[0]?.sqlMode !== "string") {
        throw new Error("checkpoint guard fixture changed database context");
      }
      const originalMode = context[0].sqlMode as string;
      const [before] = await conn.query<RowDataPacket[]>(query, [table]);
      expect(before.map((row) => row.name)).toEqual([guard]);
      const originalFingerprint = h(JSON.stringify(before.map((row) => ({
        name: row.name, order: row.actionOrder, body: row.body, mode: row.sqlMode, definer: row.definer,
      }))));
      const [definition] = await conn.query<RowDataPacket[]>(`SHOW CREATE TRIGGER \`${guard}\``);
      const createSql = definition[0]?.["SQL Original Statement"];
      const sqlMode = definition[0]?.sql_mode;
      if (typeof createSql !== "string" || typeof sqlMode !== "string" || !createSql.includes(guard)) {
        throw new Error("checkpoint guard source not exact");
      }
      await conn.query(`DROP TRIGGER \`${guard}\``);
      try { await action(); }
      finally {
        try {
          await conn.query("SET SESSION sql_mode=?", [sqlMode]);
          await conn.query(createSql);
        } finally { await conn.query("SET SESSION sql_mode=?", [originalMode]); }
      }
      const [after] = await conn.query<RowDataPacket[]>(query, [table]);
      expect(h(JSON.stringify(after.map((row) => ({
        name: row.name, order: row.actionOrder, body: row.body, mode: row.sqlMode, definer: row.definer,
      }))))).toBe(originalFingerprint);
    }
    async function expectNoCheckpoint(conn: Connection, backupId: string) {
      const [headers] = await conn.query<RowDataPacket[]>(
        "SELECT backup_id FROM tenant_telemetry_capture_backup_checkpoints WHERE BINARY backup_id=BINARY ?", [backupId]);
      const [leaves] = await conn.query<RowDataPacket[]>(
        "SELECT family FROM tenant_telemetry_capture_backup_checkpoint_leaves WHERE BINARY backup_id=BINARY ?", [backupId]);
      expect(headers).toHaveLength(0);
      expect(leaves).toHaveLength(0);
    }

    it("returns null only for a real inactive control with no 0055 footprint", runCase(async scope => {
      const f = await fixture(scope, false, false);
      try {
        const backupId = newTenantBackupId();
        expect(await f.store.sealTenantTelemetryCaptureBackupCheckpoint(input(backupId))).toBeNull();
        const [headers] = await f.conn.query<RowDataPacket[]>(
          "SELECT backup_id FROM tenant_telemetry_capture_backup_checkpoints");
        expect(headers).toHaveLength(0);
      } catch (error) { scope.failed = true; throw error; }
      finally { await f.close(); }
    }));

    it("binds only real open stores to the actual server/database identity across independent pools", runCase(async scope => {
      const f = await fixture(scope, false);
      let second: MysqlSessionStore | undefined;
      try {
        const [identity] = await f.conn.query<RowDataPacket[]>(
          "SELECT @@server_uuid AS serverUuid,DATABASE() AS databaseName");
        expect(identity).toHaveLength(1);
        expect(typeof identity[0]!.serverUuid).toBe("string");
        expect(identity[0]!.databaseName).toBe(f.name);
        const expected = { serverUuid: String(identity[0]!.serverUuid), database: f.name };
        const options = { timeoutMs: 2_000, operationAbortSignal: scope.signal };
        await expect(assertMysqlSessionStoreDatabaseBinding(f.store, expected, options))
          .resolves.toBeUndefined();
        second = await openStore(scope, { url: f.url, connectionLimit: 2,
          migrationMode: "verify", tenantTelemetryRefKey: captureRefKey,
          tenantTelemetryCaptureRestoreLocalOnly: true });
        await expect(assertMysqlSessionStoreDatabaseBinding(second, expected, options))
          .resolves.toBeUndefined();
        const other = await fixture(scope, false);
        const [otherIdentity] = await other.conn.query<RowDataPacket[]>(
          "SELECT @@server_uuid AS serverUuid,DATABASE() AS databaseName");
        expect(otherIdentity[0]!.serverUuid).toBe(expected.serverUuid);
        expect(otherIdentity[0]!.databaseName).toBe(other.name);
        await expect(assertMysqlSessionStoreDatabaseBinding(other.store, expected, options))
          .rejects.toBeInstanceOf(TenantTelemetryCaptureRestoreIntegrityError);
        const lookalike = { close: async () => {},
          getTenantRestoreRuntimeControl: f.store.getTenantRestoreRuntimeControl.bind(f.store) };
        await expect(assertMysqlSessionStoreDatabaseBinding(lookalike, expected, options))
          .rejects.toBeInstanceOf(TenantTelemetryCaptureRestoreIntegrityError);
        // Even the real prototype is not a module-owned open pool registration.
        const forgedPrototype: unknown = Object.create(Object.getPrototypeOf(f.store));
        await expect(assertMysqlSessionStoreDatabaseBinding(forgedPrototype, expected, options))
          .rejects.toBeInstanceOf(TenantTelemetryCaptureRestoreIntegrityError);
        const closed = second;
        await second.close();
        second = undefined;
        await expect(assertMysqlSessionStoreDatabaseBinding(closed, expected, options))
          .rejects.toBeInstanceOf(TenantTelemetryCaptureRestoreIntegrityError);
      } catch (error) { scope.failed = true; throw error; }
      finally { await f.close(); }
    }), 60_000);

    it("atomically seals all 49 families from a real queued v2 source; exact replay and historical read survive later source change", runCase(async scope => {
      const f = await fixture(scope, true);
      try {
        const step = await captureStepFixture(f.store, { tenantId: `tenant-${randomUUID()}`,
          userId: `user-${randomUUID()}` });
        const committed = await f.store.commitPersistedProviderStepFailure(step.input);
        expect(committed.failureCommitReceipt.writeOperationSha256).toMatch(/^[0-9a-f]{64}$/);
        const selected = await anchor(f.store);
        const first = await f.store.sealTenantTelemetryCaptureBackupCheckpoint(input(selected.backupId));
        expect(first?.disposition).toBe("created");
        const record = first!.value;
        expect(record.checkpoint).toMatchObject({ backupId: selected.backupId,
          anchorSha256: selected.anchorSha256, sourceRuntimeLineageKind: "primary",
          executionReady: false, externalAuthorityVerified: false,
          erasureAuthorized: false, allDomainsComplete: false, contentPurgeExecuted: false });
        expect(record.checkpoint.families).toHaveLength(49);
        expect(record.checkpoint.families.map((family) => family.family))
          .toEqual([...new Set(record.checkpoint.families.map((family) => family.family))]);
        expect(record.leaves.some((leaf) => leaf.family === "write_job" && leaf.state === "queued")).toBe(true);
        expect(record.leaves.some((leaf) => leaf.family === "provider_failure_commit")).toBe(true);
        expect(record.leaves.some((leaf) => leaf.family === "canonical_item")).toBe(true);
        const actual = await readTenantTelemetryCaptureCheckpointFromMysql(f.conn, selected.backupId, captureRefKey);
        expect(actual).toEqual(record);
        expect(await f.store.getTenantTelemetryCaptureBackupCheckpoint(selected.backupId)).toEqual(record);
        await expect(f.store.assertTenantTelemetryCaptureBackupCheckpointUnchanged({
          ...input(selected.backupId), checkpointSha256: record.checkpoint.checkpointSha256,
        })).resolves.toBeUndefined();
        const replay = await f.store.sealTenantTelemetryCaptureBackupCheckpoint(input(selected.backupId));
        expect(replay).toEqual({ disposition: "exact_replay", value: record });
        const [headers] = await f.conn.query<RowDataPacket[]>(
          "SELECT checkpoint_json FROM tenant_telemetry_capture_backup_checkpoints WHERE backup_id=?", [selected.backupId]);
        const serialized = JSON.stringify(headers[0]!.checkpoint_json);
        for (const sensitive of [step.session.tenantId, step.session.id, step.turn.id, step.item.id,
          "private partial assistant content"]) expect(serialized).not.toContain(sensitive);
        await f.store.commit({ sessionId: step.session.id, fence: 1, expectedLastSeq: 4,
          sessionPatch: { status: { type: "idle" } } });
        await expect(f.store.assertTenantTelemetryCaptureBackupCheckpointUnchanged({
          ...input(selected.backupId), checkpointSha256: record.checkpoint.checkpointSha256,
        })).rejects.toThrow();
        expect(await f.store.getTenantTelemetryCaptureBackupCheckpoint(selected.backupId)).toEqual(record);
      } catch (error) { scope.failed = true; throw error; }
      finally { await f.close(); }
    }));

    it("serializes two independent MySQL pools on the same existing anchor into create plus exact replay", runCase(async scope => {
      const f = await fixture(scope, true);
      let second: MysqlSessionStore | undefined;
      try {
        const selected = await anchor(f.store);
        second = await openStore(scope, { url: f.url, connectionLimit: 2,
          migrationMode: "verify", tenantTelemetryRefKey: captureRefKey,
          tenantTelemetryPersistedProviderCaptureLocalOnly: true,
          tenantTelemetryCaptureRestoreLocalOnly: true });
        const [a, b] = await Promise.all([
          f.store.sealTenantTelemetryCaptureBackupCheckpoint(input(selected.backupId)),
          second.sealTenantTelemetryCaptureBackupCheckpoint(input(selected.backupId)),
        ]);
        expect([a?.disposition, b?.disposition].sort()).toEqual(["created", "exact_replay"]);
        expect(a?.value).toEqual(b?.value);
        const [headers] = await f.conn.query<RowDataPacket[]>(
          "SELECT backup_id FROM tenant_telemetry_capture_backup_checkpoints WHERE BINARY backup_id=BINARY ?",
          [selected.backupId]);
        expect(headers).toHaveLength(1);
      } catch (error) { scope.failed = true; throw error; }
      finally { await f.close(); }
    }));

    it("includes an actual reserved source without treating its in-process adapter result as external proof", runCase(async scope => {
      const f = await fixture(scope, true);
      try {
        const step = await captureStepFixture(f.store, { tenantId: `tenant-${randomUUID()}`,
          userId: `user-${randomUUID()}` });
        const committed = await f.store.commitPersistedProviderStepFailure(step.input);
        const claim = (await f.store.claimTenantTelemetryWriteJobs({ limit: 100,
          leaseMs: 300_000, claimToken: `checkpoint-${randomUUID()}`,
          adapterProtocol: "telemetry-s3-object-v1", captureMode: "include_v2", freshProof: step.proof }))
          .find((value) => value.writeOperationSha256 === committed.failureCommitReceipt.writeOperationSha256);
        if (!claim) throw new Error("fixture did not claim its exact source");
        const authorization = { tenantId: claim.tenantId, writeOperationSha256: claim.writeOperationSha256,
          claimAttempt: claim.claimAttempt, claimToken: claim.claimToken };
        expect(await f.store.reserveTenantTelemetryExternalMutation(
          authorization, claim.target.adapterProtocol, step.proof)).not.toBeNull();
        const selected = await anchor(f.store);
        const sealed = await f.store.sealTenantTelemetryCaptureBackupCheckpoint(input(selected.backupId));
        expect(sealed?.value.leaves.some((leaf) => leaf.family === "write_job" && leaf.state === "reserved")).toBe(true);
        expect(sealed?.value.leaves.some((leaf) => leaf.family === "write_reservation" && leaf.state === "reserved")).toBe(true);
        // Simulated local ACK is used only to prove the later source changes;
        // it is not a provider/S3 disposition acknowledgement.
        const adapterInput = { writeOperationSha256: claim.writeOperationSha256,
          target: claim.target, inventory: claim.inventory, payload: claim.payload };
        const adapter = tenantTelemetryWriteAdapterResult(claim.target.adapterProtocol, adapterInput, "written", false);
        expect(await f.store.completeTenantTelemetryWrite(authorization, adapter, step.proof)).not.toBeNull();
        await expect(f.store.assertTenantTelemetryCaptureBackupCheckpointUnchanged({
          ...input(selected.backupId), checkpointSha256: sealed!.value.checkpoint.checkpointSha256,
        })).rejects.toThrow();
      } catch (error) { scope.failed = true; throw error; }
      finally { await f.close(); }
    }));

    it("rejects a real legacy NULL-identity usage row whose session has a different tenant", runCase(async scope => {
      const f = await fixture(scope, true);
      try {
        const step = await captureStepFixture(f.store, { tenantId: `tenant-${randomUUID()}`,
          userId: `user-${randomUUID()}` });
        await f.store.commitPersistedProviderStepFailure(step.input);
        const selected = await anchor(f.store);
        const [inserted] = await f.conn.query<mysql.ResultSetHeader>(
          `INSERT INTO usage_ledger
            (usage_id,tenant_id,user_id,session_id,turn_id,step,provider,model,usage_json,created_at_ms)
           SELECT NULL,?,user_id,session_id,turn_id,step+100,provider,model,usage_json,created_at_ms
             FROM usage_ledger WHERE BINARY session_id=BINARY ? LIMIT 1`,
          [`other-${randomUUID()}`, step.session.id],
        );
        expect(inserted.affectedRows).toBe(1);
        await expect(f.store.sealTenantTelemetryCaptureBackupCheckpoint(input(selected.backupId)))
          .rejects.toThrow();
        await expectNoCheckpoint(f.conn, selected.backupId);
      } catch (error) { scope.failed = true; throw error; }
      finally { await f.close(); }
    }));

    it("rejects a modern usage owner mutation despite unchanged independent billing", runCase(async scope => {
      const f = await fixture(scope, true);
      try {
        const step = await captureStepFixture(f.store, { tenantId: `tenant-${randomUUID()}`,
          userId: `user-${randomUUID()}` });
        await f.store.commitPersistedProviderStepFailure(step.input);
        const selected = await anchor(f.store);
        const [billingBefore] = await f.conn.query<RowDataPacket[]>(
          "SELECT fact_sha256 FROM billing_usage_facts WHERE BINARY tenant_id=BINARY ?", [step.session.tenantId]);
        expect(billingBefore).toHaveLength(1);
        const [changed] = await f.conn.query<mysql.ResultSetHeader>(
          "UPDATE usage_ledger SET user_id=? WHERE BINARY session_id=BINARY ?",
          [`other-${randomUUID()}`, step.session.id],
        );
        expect(changed.affectedRows).toBe(1);
        const [billingAfter] = await f.conn.query<RowDataPacket[]>(
          "SELECT fact_sha256 FROM billing_usage_facts WHERE BINARY tenant_id=BINARY ?", [step.session.tenantId]);
        expect(billingAfter).toEqual(billingBefore);
        await expect(f.store.sealTenantTelemetryCaptureBackupCheckpoint(input(selected.backupId)))
          .rejects.toThrow();
        await expectNoCheckpoint(f.conn, selected.backupId);
      } catch (error) { scope.failed = true; throw error; }
      finally { await f.close(); }
    }));

    it("preserves a missing legacy turn as unknown but rejects an actual foreign-session turn before sealing", runCase(async scope => {
      const f = await fixture(scope, true);
      try {
        const own = await captureStepFixture(f.store, { tenantId: `tenant-${randomUUID()}`,
          userId: `user-${randomUUID()}` });
        await f.store.commitPersistedProviderStepFailure(own.input);
        const foreign = await captureStepFixture(f.store, { tenantId: `other-tenant-${randomUUID()}`,
          userId: `other-user-${randomUUID()}` });
        await f.store.commitPersistedProviderStepFailure(foreign.input);
        const syntheticTurnId = `turn_${randomUUID()}`;
        const [absent] = await f.conn.query<RowDataPacket[]>(
          "SELECT turn_id FROM turns WHERE BINARY turn_id=BINARY ?", [syntheticTurnId]);
        expect(absent).toHaveLength(0);
        // This real SQL legacy-shape fixture is not managed provider provenance.
        // Its NULL usage ID must not bypass an existing turn's owner relation.
        const [inserted] = await f.conn.query<mysql.ResultSetHeader>(
          `INSERT INTO usage_ledger
            (usage_id,tenant_id,user_id,session_id,turn_id,step,provider,model,usage_json,created_at_ms)
           SELECT NULL,tenant_id,user_id,session_id,?,step+100,provider,model,usage_json,created_at_ms
             FROM usage_ledger WHERE BINARY session_id=BINARY ? LIMIT 1`,
          [syntheticTurnId, own.session.id],
        );
        expect(inserted.affectedRows).toBe(1);
        expect(Number.isSafeInteger(inserted.insertId) && inserted.insertId > 0).toBe(true);
        const compatible = await anchor(f.store);
        const preserved = await f.store.sealTenantTelemetryCaptureBackupCheckpoint(input(compatible.backupId));
        expect(preserved?.disposition).toBe("created");
        expect(preserved!.value.checkpoint.families.find((row) => row.family === "operational_usage"))
          .toMatchObject({ rowCount: 3, legacyUnknownCount: 1 });
        const [billingBefore] = await f.conn.query<RowDataPacket[]>(
          "SELECT usage_id,fact_sha256 FROM billing_usage_facts ORDER BY usage_id");
        const [changed] = await f.conn.query<mysql.ResultSetHeader>(
          "UPDATE usage_ledger SET turn_id=? WHERE id=? AND usage_id IS NULL",
          [foreign.turn.id, inserted.insertId],
        );
        expect(changed.affectedRows).toBe(1);
        const [actualTurn] = await f.conn.query<RowDataPacket[]>(
          "SELECT session_id FROM turns WHERE BINARY turn_id=BINARY ?", [foreign.turn.id]);
        expect(actualTurn).toHaveLength(1);
        expect(actualTurn[0]!.session_id).toBe(foreign.session.id);
        expect(actualTurn[0]!.session_id).not.toBe(own.session.id);
        const [billingAfter] = await f.conn.query<RowDataPacket[]>(
          "SELECT usage_id,fact_sha256 FROM billing_usage_facts ORDER BY usage_id");
        expect(billingAfter).toEqual(billingBefore);
        const rejected = await anchor(f.store);
        await expect(f.store.sealTenantTelemetryCaptureBackupCheckpoint(input(rejected.backupId)))
          .rejects.toBeInstanceOf(TenantTelemetryCaptureRestoreIntegrityError);
        await expectNoCheckpoint(f.conn, rejected.backupId);
      } catch (error) { scope.failed = true; throw error; }
      finally { await f.close(); }
    }));

    it("requires the exact selected checkpoint before reservation and atomically binds its 0031/0030 sidecar", runCase(async scope => {
      const f = await fixture(scope, true);
      try {
        const { checkpoint, entry } = await checkpointedAvailable(f.store);
        const preparedInput = await prepareInput(f.store, entry, checkpoint.checkpointSha256);
        const preflight = { backupId: entry.backupId, restoreRunId: preparedInput.restoreRunId,
          runtimeEpochSha256: preparedInput.runtimeEpochSha256,
          captureCheckpointSha256: checkpoint.checkpointSha256 };
        const withoutCheckpoint = { backupId: preflight.backupId,
          restoreRunId: preflight.restoreRunId, runtimeEpochSha256: preflight.runtimeEpochSha256 };
        await expect(f.store.preflightTenantRestoreReplayFromBackup(withoutCheckpoint))
          .rejects.toBeInstanceOf(TenantTelemetryCaptureRestoreIntegrityError);
        await expect(f.store.preflightTenantRestoreReplayFromBackup({
          ...preflight, captureCheckpointSha256: h("wrong selected checkpoint"),
        })).rejects.toBeInstanceOf(TenantTelemetryCaptureRestoreIntegrityError);
        await expect(f.store.preflightTenantRestoreReplayFromBackup(preflight)).resolves.toEqual(entry);
        const prepared = await f.store.prepareTenantRestoreReplayFromBackup(preparedInput);
        expect(prepared.disposition).toBe("created");
        const [rows] = await f.conn.query<RowDataPacket[]>(`SELECT * FROM tenant_telemetry_capture_restore_bindings
          WHERE BINARY restore_run_id=BINARY ?`, [preparedInput.restoreRunId]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ backup_id: entry.backupId,
          checkpoint_sha256: checkpoint.checkpointSha256,
          artifact_manifest_sha256: entry.artifactManifestSha256,
          source_snapshot_sha256: entry.sourceSnapshotSha256,
          provider_evidence_sha256: entry.providerEvidenceSha256,
          source_binding_sha256: prepared.value.binding.bindingSha256,
          reservation_sha256: prepared.value.reservation.reservationSha256,
          reservation_receipt_sha256: prepared.value.reservation.reservationReceiptSha256 });
        expect(Number(rows[0]!.bound_at_db_ms)).toBe(prepared.value.binding.boundAtDbMs);
        expect(await f.store.prepareTenantRestoreReplayFromBackup(preparedInput))
          .toEqual({ disposition: "exact_replay", value: prepared.value });
        await expect(f.store.preflightTenantRestoreReplayFromBackup(preflight)).resolves.toEqual(entry);
        expect((await f.store.getTenantTelemetryCaptureBackupCheckpoint(entry.backupId))?.checkpoint)
          .toEqual(checkpoint);
      } catch (error) { scope.failed = true; throw error; }
      finally { await f.close(); }
    }));

    it("rolls back the old 0031 binding/reservation and 0030 run if the final 0055 sidecar insert fails", runCase(async scope => {
      const f = await fixture(scope, true);
      try {
        const { checkpoint, entry } = await checkpointedAvailable(f.store);
        const preparedInput = await prepareInput(f.store, entry, checkpoint.checkpointSha256);
        const trigger = `test_checkpoint_sidecar_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
        await f.conn.query(`CREATE TRIGGER \`${trigger}\` BEFORE INSERT ON tenant_telemetry_capture_restore_bindings
          FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected checkpoint sidecar rollback'`);
        try {
          await expect(f.store.prepareTenantRestoreReplayFromBackup(preparedInput))
            .rejects.toThrow("injected checkpoint sidecar rollback");
        } finally { await f.conn.query(`DROP TRIGGER \`${trigger}\``); }
        const [rows] = await f.conn.query<RowDataPacket[]>(`SELECT
          (SELECT COUNT(*) FROM backup_restore_source_bindings) AS bindingCount,
          (SELECT COUNT(*) FROM backup_runtime_reservations) AS reservationCount,
          (SELECT COUNT(*) FROM tenant_restore_replay_runs) AS runCount,
          (SELECT COUNT(*) FROM tenant_telemetry_capture_restore_bindings) AS sidecarCount,
          (SELECT COUNT(*) FROM backup_catalog_external_events) AS eventCount`);
        expect(rows[0]).toMatchObject({ bindingCount: 0, reservationCount: 0,
          runCount: 0, sidecarCount: 0, eventCount: 1 });
        expect((await f.store.prepareTenantRestoreReplayFromBackup(preparedInput)).disposition).toBe("created");
      } catch (error) { scope.failed = true; throw error; }
      finally { await f.close(); }
    }));

    it("rejects a deleted sidecar on cold startup even after the exact immutable guard is restored", runCase(async scope => {
      const f = await fixture(scope, true);
      try {
        const { checkpoint, entry } = await checkpointedAvailable(f.store);
        const preparedInput = await prepareInput(f.store, entry, checkpoint.checkpointSha256);
        expect((await f.store.prepareTenantRestoreReplayFromBackup(preparedInput)).disposition).toBe("created");
        // A prepared active-capture run is independently rejected by the old
        // ordinary-writer pending gate. Abort through the normal product API
        // first, then prove clean cold startup succeeds before corrupting only
        // this sidecar. Otherwise the negative could pass at the wrong gate.
        expect(await f.store.abortTenantRestoreReplay(preparedInput.restoreRunId)).toBe(true);
        const reconnectOptions = { url: f.url, connectionLimit: 2,
          migrationMode: "verify" as const, tenantTelemetryRefKey: captureRefKey,
          tenantTelemetryPersistedProviderCaptureLocalOnly: true,
          tenantTelemetryCaptureRestoreLocalOnly: true };
        const intact = await openStore(scope, reconnectOptions);
        await intact.close();
        await withOnlyOwnedSidecarDeleteGuardRemoved(f.conn, f.name, async () => {
          const [deleted] = await f.conn.query<mysql.ResultSetHeader>(
            "DELETE FROM tenant_telemetry_capture_restore_bindings WHERE BINARY restore_run_id=BINARY ?",
            [preparedInput.restoreRunId]);
          expect(deleted.affectedRows).toBe(1);
        });
        await expect(openStore(scope, reconnectOptions))
          .rejects.toBeInstanceOf(TenantTelemetryCaptureRestoreIntegrityError);
      } catch (error) { scope.failed = true; throw error; }
      finally { await f.close(); }
    }));

    it("rolls back header and every leaf together when the final leaf insert fails", runCase(async scope => {
      const f = await fixture(scope, true);
      try {
        const selected = await anchor(f.store);
        const trigger = `test_checkpoint_rollback_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
        await f.conn.query(`CREATE TRIGGER \`${trigger}\` BEFORE INSERT ON tenant_telemetry_capture_backup_checkpoint_leaves
          FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected checkpoint leaf rollback'`);
        try {
          await expect(f.store.sealTenantTelemetryCaptureBackupCheckpoint(input(selected.backupId)))
            .rejects.toThrow("injected checkpoint leaf rollback");
        } finally { await f.conn.query(`DROP TRIGGER \`${trigger}\``); }
        const [headers] = await f.conn.query<RowDataPacket[]>(
          "SELECT backup_id FROM tenant_telemetry_capture_backup_checkpoints WHERE backup_id=?", [selected.backupId]);
        const [leaves] = await f.conn.query<RowDataPacket[]>(
          "SELECT family FROM tenant_telemetry_capture_backup_checkpoint_leaves WHERE backup_id=?", [selected.backupId]);
        expect(headers).toHaveLength(0);
        expect(leaves).toHaveLength(0);
      } catch (error) { scope.failed = true; throw error; }
      finally { await f.close(); }
    }));
  });
}
