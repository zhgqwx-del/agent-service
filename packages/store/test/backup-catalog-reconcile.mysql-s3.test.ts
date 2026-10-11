import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import mysql, { type Connection } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
  EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  MysqlSessionStore,
  newTenantBackupId,
  tenantRestoreRuntimeEpochSha256,
  type TenantBackupSnapshotAnchor,
  type TenantRestoreJournalTargetDescriptor,
} from "../src/index.js";
import {
  createTenantBackupCatalogAdapter,
  loadTenantBackupCatalogConfig,
} from "../../../apps/agent-runner/src/tenant-backup-catalog-config.js";

const mysqlGate = process.env.AGENT_SERVICE_INTEGRATION ?? "0";
const reconcileGate = process.env.AGENT_SERVICE_BACKUP_CATALOG_RECONCILE_INTEGRATION ?? "0";
if (!["0", "1"].includes(mysqlGate) || !["0", "1"].includes(reconcileGate)) {
  throw new Error("backup catalog reconcile integration gates must be 0 or 1");
}
const integrationEnabled = mysqlGate === "1" && reconcileGate === "1";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for the real backup-catalog reconcile suite`);
  }
  return value;
}

function disposableBase(raw: string): URL {
  const url = new URL(raw);
  const databaseName = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !/(?:^|[_-])test(?:$|[_-])/i.test(databaseName)) {
    throw new Error(`MYSQL_TEST_URL must name a disposable test database, got ${databaseName}`);
  }
  return url;
}

function databaseUrl(baseUrl: URL, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function testEndpoint(raw: string): URL {
  let endpointUrl: URL;
  try {
    endpointUrl = new URL(raw);
  } catch {
    throw new Error("S3_TEST_ENDPOINT must be an absolute http(s) origin");
  }
  if (
    !["http:", "https:"].includes(endpointUrl.protocol)
    || endpointUrl.username
    || endpointUrl.password
    || endpointUrl.search
    || endpointUrl.hash
    || (endpointUrl.pathname && endpointUrl.pathname !== "/")
  ) {
    throw new Error("S3_TEST_ENDPOINT must be a credential-free http(s) origin");
  }
  return endpointUrl;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const base = integrationEnabled
  ? disposableBase(required("MYSQL_TEST_URL"))
  : new URL("mysql://root@127.0.0.1:3306/agent_service_test");
const endpoint = integrationEnabled
  ? testEndpoint(required("S3_TEST_ENDPOINT"))
  : new URL("http://127.0.0.1:9000");
const region = integrationEnabled ? required("S3_TEST_REGION") : "us-east-1";
const bucket = integrationEnabled
  ? required("S3_BACKUP_CATALOG_TEST_BUCKET")
  : "disabled-backup-catalog-reconcile";
const accessKeyId = integrationEnabled ? required("S3_TEST_ACCESS_KEY_ID") : "disabled";
const secretAccessKey = integrationEnabled
  ? required("S3_TEST_SECRET_ACCESS_KEY")
  : "disabled";
const forcePathStyleRaw = integrationEnabled ? required("S3_TEST_FORCE_PATH_STYLE") : "1";
if (forcePathStyleRaw !== "0" && forcePathStyleRaw !== "1") {
  throw new Error("S3_TEST_FORCE_PATH_STYLE must be 0 or 1");
}
const forcePathStyle = forcePathStyleRaw === "1";
const runId = randomBytes(12).toString("hex");
const prefix = `backup-catalog-reconcile-tests/${runId}`;
const database = `agent_service_backup_reconcile_test_${process.pid}_${randomBytes(6)
  .toString("hex")}`;
const mysqlUrl = databaseUrl(base, database);
const root = fileURLToPath(new URL("../../../", import.meta.url));

function assertGeneratedDatabaseName(value: string): void {
  if (!/^agent_service_backup_reconcile_test_[0-9]+_[0-9a-f]{12}$/.test(value)) {
    throw new Error("refusing to operate on a non-generated reconcile test database");
  }
}

function assertGeneratedPrefix(value: string): void {
  if (!/^backup-catalog-reconcile-tests\/[0-9a-f]{24}$/.test(value)) {
    throw new Error("refusing to clean a non-generated reconcile test prefix");
  }
}

const s3ClientConfig: S3ClientConfig = {
  endpoint: endpoint.origin,
  region,
  forcePathStyle,
  credentials: { accessKeyId, secretAccessKey },
  maxAttempts: 2,
};

const catalogEnv: NodeJS.ProcessEnv = {
  BACKUP_CATALOG_ADAPTER: "s3",
  BACKUP_CATALOG_DATABASE_NAMESPACE_ID: `reconcile-db-${runId}`,
  BACKUP_CATALOG_NAMESPACE_ID: `reconcile-catalog-${runId}`,
  BACKUP_CATALOG_FAILURE_DOMAIN_ID: `reconcile-minio-${runId}`,
  BACKUP_CATALOG_INDEPENDENT_FAILURE_DOMAIN_ACK: "1",
  BACKUP_CATALOG_S3_ENDPOINT: endpoint.origin,
  BACKUP_CATALOG_S3_REGION: region,
  BACKUP_CATALOG_S3_BUCKET: bucket,
  BACKUP_CATALOG_S3_PREFIX: prefix,
  BACKUP_CATALOG_S3_FORCE_PATH_STYLE: forcePathStyleRaw,
  BACKUP_CATALOG_S3_PRIVATE_BUCKET_ACK: "1",
  BACKUP_CATALOG_S3_REQUEST_TIMEOUT_MS: "5000",
  BACKUP_CATALOG_S3_ACCESS_KEY_ID: accessKeyId,
  BACKUP_CATALOG_S3_SECRET_ACCESS_KEY: secretAccessKey,
  BACKUP_CATALOG_MINIMUM_RETENTION_MS: "600000",
  BACKUP_CATALOG_MINIMUM_RECOVERABLE_BACKUPS: "1",
};

const catalogConfig = loadTenantBackupCatalogConfig(catalogEnv, {
  production: false,
  store: "mysql",
  requireRetentionPolicy: true,
});
if (integrationEnabled && !catalogConfig) {
  throw new Error("backup catalog reconcile config did not load");
}

let admin: Connection | undefined;
let cleanupClient: S3Client | undefined;

async function listPrefix(): Promise<string[]> {
  assertGeneratedPrefix(prefix);
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await cleanupClient!.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: `${prefix}/`,
      ContinuationToken: continuationToken,
    }));
    for (const object of page.Contents ?? []) {
      if (!object.Key?.startsWith(`${prefix}/`)) {
        throw new Error("backup catalog reconcile cleanup escaped its generated prefix");
      }
      keys.push(object.Key);
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && !continuationToken) {
      throw new Error("backup catalog reconcile cleanup omitted a continuation token");
    }
  } while (continuationToken);
  return keys;
}

async function cleanupPrefix(): Promise<void> {
  while (true) {
    const keys = await listPrefix();
    if (keys.length === 0) return;
    for (let offset = 0; offset < keys.length; offset += 1_000) {
      const batch = keys.slice(offset, offset + 1_000);
      const result = await cleanupClient!.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Quiet: true, Objects: batch.map((Key) => ({ Key })) },
      }));
      if ((result.Errors?.length ?? 0) > 0) {
        throw new Error("backup catalog reconcile cleanup reported an object error");
      }
    }
  }
}

function availability(
  backupId: string,
  anchorSha256: string,
  anchor: TenantBackupSnapshotAnchor,
  label: string,
) {
  if (catalogConfig?.retentionPolicySha256 === undefined) {
    throw new Error("backup catalog retention policy is missing");
  }
  return {
    backupId,
    anchorSha256,
    sourceSnapshotSha256: sha256(`${label}-snapshot`),
    sourceBackupSha256: sha256(`${label}-backup`),
    artifactManifestSha256: sha256(`${label}-manifest`),
    providerEvidenceSha256: sha256(`${label}-provider-evidence`),
    controlEvidenceSha256: anchor.controlEvidenceSha256,
    logicalDatabaseNamespaceSha256: anchor.logicalDatabaseNamespaceSha256,
    retentionPolicySha256: catalogConfig.retentionPolicySha256,
    retentionUntilDbMs: anchor.retentionUntilDbMs,
    registeredAtDbMs: anchor.createdAtDbMs,
  };
}

function runReconcile() {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    MYSQL_URL: mysqlUrl,
    BACKUP_CATALOG_PAGE_SIZE: "1",
    ...catalogEnv,
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
  };
  return spawnSync(process.execPath, [
    "--import",
    "tsx",
    "apps/agent-runner/src/backup-catalog.ts",
    "reconcile",
  ], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
}

function expectNoAuthorityLeak(stdout: string, stderr: string): void {
  const output = `${stdout}\n${stderr}`;
  for (const value of [accessKeyId, secretAccessKey, base.username, base.password]) {
    if (value) expect(output).not.toContain(value);
  }
}

const describeIntegration = integrationEnabled ? describe : describe.skip;

describeIntegration("backup-catalog CLI reconcile with real MySQL and MinIO", () => {
  beforeAll(async () => {
    assertGeneratedDatabaseName(database);
    admin = await mysql.createConnection(databaseUrl(base, "mysql"));
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    cleanupClient = new S3Client(s3ClientConfig);
  }, 30_000);

  afterAll(async () => {
    try {
      if (cleanupClient) await cleanupPrefix();
    } finally {
      cleanupClient?.destroy();
      if (admin) {
        assertGeneratedDatabaseName(database);
        await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
        await admin.end();
      }
    }
  }, 30_000);

  it("mirrors the complete external chain page-by-page and requires an exact local restore anchor", async () => {
    const config = catalogConfig!;
    let store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 2 });
    const blob = await store.activateBlobStorageControl({
      expectedControlGeneration: 0,
      storageBackend: "s3v1-backup-reconcile-test",
      namespaceSha256: sha256(`reconcile-blob-${runId}`),
    });
    const journalTarget: TenantRestoreJournalTargetDescriptor = {
      targetOrdinal: 0,
      targetSha256: sha256(`reconcile-journal-target-${runId}`),
      failureDomainSha256: sha256(`reconcile-journal-failure-domain-${runId}`),
      adapterProtocol: "mysql-backup-reconcile-journal-v1",
      journalNamespaceSha256: sha256(`reconcile-journal-namespace-${runId}`),
    };
    const sealedTarget = {
      ...journalTarget,
      logicalDatabaseNamespaceSha256: config.logicalDatabaseNamespaceSha256,
      sealedRemoteSequence: 0,
      sealedHeadRootSha256: EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
    };
    await store.activateTenantRestoreJournalControl({
      adapterProtocol: journalTarget.adapterProtocol,
      journalNamespaceSha256: journalTarget.journalNamespaceSha256,
      logicalDatabaseNamespaceSha256: config.logicalDatabaseNamespaceSha256,
      runtimeEpochSha256: tenantRestoreRuntimeEpochSha256(`reconcile-primary-${runId}`),
      targets: [journalTarget],
      observedHeads: [sealedTarget],
    });
    const journal = await store.getTenantRestoreJournalControl();
    const runtime = await store.getTenantRestoreRuntimeControl();
    expect(journal.controlGeneration).toBe(1);
    expect(runtime).toMatchObject({ state: "active", controlGeneration: 1 });
    expect(blob).toMatchObject({ controlGeneration: 1 });
    if (journal.controlGeneration !== 1 || config.retentionPolicySha256 === undefined) {
      throw new Error("backup catalog reconcile prerequisites did not activate");
    }
    const activated = await store.activateTenantBackupCatalogControl({
      expectedControlGeneration: 0,
      adapterProtocol: config.adapterProtocol,
      catalogNamespaceSha256: config.catalogNamespaceSha256,
      catalogTargetSha256: config.catalogTargetSha256,
      failureDomainSha256: config.failureDomainSha256,
      logicalDatabaseNamespaceSha256: config.logicalDatabaseNamespaceSha256,
      journalControlEvidenceSha256: journal.evidenceSha256,
      retentionPolicySha256: config.retentionPolicySha256,
      minimumRetentionMs: config.minimumRetentionMs!,
      minimumRecoverableBackups: config.minimumRecoverableBackups!,
    });
    expect(activated.value).toMatchObject({ state: "active", controlGeneration: 1 });

    const firstBackupId = newTenantBackupId();
    const secondBackupId = newTenantBackupId();
    const firstAnchor = (await store.createTenantBackupSnapshotAnchor({
      backupId: firstBackupId,
      controlEvidenceSha256: activated.value.evidenceSha256,
    })).value;
    const secondAnchor = (await store.createTenantBackupSnapshotAnchor({
      backupId: secondBackupId,
      controlEvidenceSha256: activated.value.evidenceSha256,
    })).value;
    expect(await store.getTenantBackupCatalogEntry(firstBackupId)).toBeNull();
    expect(await store.getTenantBackupCatalogEntry(secondBackupId)).toBeNull();

    const adapter = createTenantBackupCatalogAdapter(config);
    try {
      await adapter.validateStartup();
      await adapter.publishAvailability(availability(
        firstBackupId,
        firstAnchor.anchorSha256,
        firstAnchor,
        "reconcile-first",
      ));
      await adapter.publishAvailability(availability(
        secondBackupId,
        secondAnchor.anchorSha256,
        secondAnchor,
        "reconcile-second",
      ));
      expect(await store.getTenantBackupCatalogEntry(firstBackupId)).toBeNull();
      expect(await store.getTenantBackupCatalogEntry(secondBackupId)).toBeNull();
      await store.close();

      const firstRun = runReconcile();
      if (firstRun.error) throw firstRun.error;
      expectNoAuthorityLeak(firstRun.stdout, firstRun.stderr);
      expect(firstRun.signal).toBeNull();
      expect(firstRun.status, firstRun.stderr).toBe(0);
      expect(firstRun.stderr).toBe("");
      expect(JSON.parse(firstRun.stdout.trim())).toEqual({
        status: "ok",
        command: "reconcile",
        eventCount: 2,
        projectedCount: 2,
      });

      store = await MysqlSessionStore.connect({
        url: mysqlUrl,
        connectionLimit: 2,
        migrationMode: "verify",
      });
      expect(await store.getTenantBackupCatalogEntry(firstBackupId)).not.toBeNull();
      expect(await store.getTenantBackupCatalogEntry(secondBackupId)).not.toBeNull();
      expect(await store.listRecoverableTenantBackups({ limit: 10 })).toHaveLength(2);
      await store.close();

      const replay = runReconcile();
      if (replay.error) throw replay.error;
      expectNoAuthorityLeak(replay.stdout, replay.stderr);
      expect(replay.signal).toBeNull();
      expect(replay.status, replay.stderr).toBe(0);
      expect(JSON.parse(replay.stdout.trim())).toMatchObject({
        command: "reconcile",
        eventCount: 2,
        projectedCount: 2,
      });

      store = await MysqlSessionStore.connect({
        url: mysqlUrl,
        connectionLimit: 2,
        migrationMode: "verify",
      });
      const firstEntry = await store.getTenantBackupCatalogEntry(firstBackupId);
      if (!firstEntry) throw new Error("expected the reconciled backup entry");
      const restoreRunId = `restore_${randomUUID()}`;
      const restoredEpochSha256 = tenantRestoreRuntimeEpochSha256(
        `reconcile-restored-${runId}`,
      );
      const reserved = await adapter.reserveRestore({
        backupId: firstBackupId,
        restoreRunId,
        entrySha256: firstEntry.entrySha256,
        runtimeEpochSha256: restoredEpochSha256,
      });
      const prepared = await store.prepareTenantRestoreReplayFromBackup({
        backupId: firstBackupId,
        restoreRunId,
        runtimeEpochSha256: restoredEpochSha256,
        controlEvidenceSha256: journal.evidenceSha256,
        sealedTargets: [sealedTarget],
        reservation: reserved,
      });
      await store.sealTenantRestoreReplay(restoreRunId);
      const beforeRestoreActivation = await store.getTenantRestoreRuntimeControl();
      if (beforeRestoreActivation.state !== "active") {
        throw new Error("expected an active runtime before restore activation");
      }
      await store.activateTenantRestoreRuntime({
        restoreRunId,
        expectedControlGeneration: beforeRestoreActivation.controlGeneration,
      });
      await adapter.resolveRestore({
        restoreRunId,
        reservationReceiptSha256: prepared.value.reservation.reservationReceiptSha256,
        phase: "activated",
      });
      expect(await store.getTenantBackupRuntimeReservation(restoreRunId))
        .toMatchObject({ phase: "reserved" });
      expect(await store.getTenantRestoreReplayRun(restoreRunId))
        .toMatchObject({ phase: "active" });
      await store.close();

      const resolutionRecovery = runReconcile();
      if (resolutionRecovery.error) throw resolutionRecovery.error;
      expectNoAuthorityLeak(resolutionRecovery.stdout, resolutionRecovery.stderr);
      expect(resolutionRecovery.signal).toBeNull();
      expect(resolutionRecovery.status, resolutionRecovery.stderr).toBe(0);
      expect(JSON.parse(resolutionRecovery.stdout.trim())).toMatchObject({
        command: "reconcile",
        eventCount: 4,
        projectedCount: 4,
      });

      store = await MysqlSessionStore.connect({
        url: mysqlUrl,
        connectionLimit: 2,
        migrationMode: "verify",
      });
      expect(await store.getTenantBackupRuntimeReservation(restoreRunId))
        .toMatchObject({ phase: "activated" });
      await store.close();

      const resolutionReplay = runReconcile();
      if (resolutionReplay.error) throw resolutionReplay.error;
      expectNoAuthorityLeak(resolutionReplay.stdout, resolutionReplay.stderr);
      expect(resolutionReplay.signal).toBeNull();
      expect(resolutionReplay.status, resolutionReplay.stderr).toBe(0);
      expect(JSON.parse(resolutionReplay.stdout.trim())).toMatchObject({
        command: "reconcile",
        eventCount: 4,
        projectedCount: 4,
      });

      const missingAnchorBackupId = newTenantBackupId();
      const blockedSuccessorBackupId = newTenantBackupId();
      store = await MysqlSessionStore.connect({
        url: mysqlUrl,
        connectionLimit: 2,
        migrationMode: "verify",
      });
      const blockedSuccessorAnchor = (await store.createTenantBackupSnapshotAnchor({
        backupId: blockedSuccessorBackupId,
        controlEvidenceSha256: activated.value.evidenceSha256,
      })).value;
      await store.close();

      await adapter.publishAvailability(availability(
        missingAnchorBackupId,
        sha256(`missing-anchor-${runId}`),
        firstAnchor,
        "reconcile-missing-anchor",
      ));
      await adapter.publishAvailability(availability(
        blockedSuccessorBackupId,
        blockedSuccessorAnchor.anchorSha256,
        blockedSuccessorAnchor,
        "reconcile-blocked-successor",
      ));
      const sealedHead = await adapter.readHead();
      expect(sealedHead.catalogSequence).toBe(6);

      const completed = runReconcile();
      if (completed.error) throw completed.error;
      expectNoAuthorityLeak(completed.stdout, completed.stderr);
      expect(completed.signal).toBeNull();
      expect(completed.status, completed.stderr).toBe(0);
      expect(completed.stderr).toBe("");
      expect(JSON.parse(completed.stdout.trim())).toEqual({
        status: "ok",
        command: "reconcile",
        eventCount: 6,
        projectedCount: 6,
      });
      expect(await adapter.readHead()).toEqual(sealedHead);

      store = await MysqlSessionStore.connect({
        url: mysqlUrl,
        connectionLimit: 2,
        migrationMode: "verify",
      });
      expect(await store.getTenantBackupCatalogEntry(missingAnchorBackupId)).not.toBeNull();
      expect(await store.getTenantBackupCatalogEntry(blockedSuccessorBackupId)).not.toBeNull();
      expect(await store.listRecoverableTenantBackups({ limit: 10 })).toHaveLength(4);
      await expect(store.preflightTenantRestoreReplayFromBackup({
        backupId: missingAnchorBackupId,
        restoreRunId: `restore_${randomUUID()}`,
        runtimeEpochSha256: tenantRestoreRuntimeEpochSha256(
          `reconcile-missing-anchor-restore-${runId}`,
        ),
      })).rejects.toMatchObject({ reason: "backup_not_recoverable" });
      await store.close();

      const eventBackupIds: string[] = [];
      const eventTypes: string[] = [];
      let sequence = 0;
      let rootSha256 = EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256;
      while (true) {
        const page = await adapter.scanEvents({
          sealedHead,
          afterCatalogSequence: sequence,
          afterCatalogEventRootSha256: rootSha256,
          limit: 1,
        });
        for (const event of page.events) {
          eventTypes.push(event.eventType);
          if (event.eventType === "backup_recoverable") {
            eventBackupIds.push(event.result.backupId);
          }
        }
        sequence = page.nextCatalogSequence;
        rootSha256 = page.nextCatalogEventRootSha256;
        if (page.complete) break;
      }
      expect(sequence).toBe(sealedHead.catalogSequence);
      expect(rootSha256).toBe(sealedHead.catalogEventRootSha256);
      expect(eventTypes).toEqual([
        "backup_recoverable",
        "backup_recoverable",
        "restore_reserved",
        "restore_resolved",
        "backup_recoverable",
        "backup_recoverable",
      ]);
      expect(eventBackupIds).toEqual([
        firstBackupId,
        secondBackupId,
        missingAnchorBackupId,
        blockedSuccessorBackupId,
      ]);
    } finally {
      await store.close().catch(() => {});
      await adapter.close();
    }
  }, 120_000);
});
