import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import type { RowDataPacket } from "mysql2/promise";
import { GenericJournalMysqlRuntimeOwner } from "./fixtures/generic-journal-mysql.js";
import { artifactCloseAfter, createArtifactFixtureS3Client } from "./mysql-backup-artifact-authority.fixture.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type MysqlSessionStore,
  S3TenantBackupCatalogAdapter,
  newTenantBackupId,
  type TenantRestoreReplaySealedTarget,
} from "../src/index.js";
import {
  loadTenantBackupCatalogConfig,
} from "../../../apps/agent-runner/src/tenant-backup-catalog-config.js";
import {
  createTenantRestoreJournalAdapters,
  loadTenantRestoreJournalConfig,
} from "../../../apps/agent-runner/src/tenant-restore-journal-config.js";

const mysqlGate = process.env.AGENT_SERVICE_INTEGRATION ?? "0";
const roundtripGate =
  process.env.AGENT_SERVICE_BACKUP_CATALOG_RESTORE_ROUNDTRIP_INTEGRATION ?? "0";
if (!['0', '1'].includes(mysqlGate) || !['0', '1'].includes(roundtripGate)) {
  throw new Error("backup catalog restore roundtrip integration gates must be 0 or 1");
}
const integrationEnabled = mysqlGate === "1" && roundtripGate === "1";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for the real backup-catalog restore roundtrip suite`);
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

function safeBucket(raw: string, name: string): string {
  if (
    raw.length < 3
    || raw.length > 63
    || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(raw)
    || raw.includes("..")
    || raw.includes(".-")
    || raw.includes("-.")
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(raw)
  ) throw new Error(`${name} must be a safe DNS-style bucket name`);
  return raw;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

const base = integrationEnabled
  ? disposableBase(required("MYSQL_TEST_URL"))
  : new URL("mysql://root@127.0.0.1:3306/agent_service_test");
const endpoint = integrationEnabled
  ? testEndpoint(required("S3_TEST_ENDPOINT"))
  : new URL("http://127.0.0.1:9000");
const region = integrationEnabled ? required("S3_TEST_REGION") : "us-east-1";
const catalogBucket = integrationEnabled
  ? safeBucket(required("S3_BACKUP_CATALOG_TEST_BUCKET"), "S3_BACKUP_CATALOG_TEST_BUCKET")
  : "disabled-backup-catalog-roundtrip";
const journalBucket = integrationEnabled
  ? safeBucket(required("S3_RESTORE_JOURNAL_TEST_BUCKET"), "S3_RESTORE_JOURNAL_TEST_BUCKET")
  : "disabled-restore-journal-roundtrip";
if (catalogBucket === journalBucket) {
  throw new Error("backup catalog and restore journal test buckets must be distinct");
}
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
const database = `agent_service_backup_roundtrip_test_${process.pid}_${randomBytes(4)
  .toString("hex")}`;
const mysqlUrl = databaseUrl(base, database);
const catalogPrefix = `backup-catalog-restore-roundtrip-tests/catalog/${runId}`;
const journalPrefix = `backup-catalog-restore-roundtrip-tests/journal/${runId}`;
const logicalDatabaseNamespaceId = `restore-roundtrip-db-${runId}`;
const primaryRuntimeEpochId = `restore-roundtrip-primary-${runId}`;
const restoredRuntimeEpochId = `restore-roundtrip-restored-${runId}`;
const backupId = newTenantBackupId();
const newerBackupId = newTenantBackupId();
const restoreRunId = `restore_${randomUUID()}`;
const root = fileURLToPath(new URL("../../../", import.meta.url));

function assertGeneratedDatabaseName(value: string): void {
  if (!/^agent_service_backup_roundtrip_test_[0-9]+_[0-9a-f]{8}$/.test(value)) {
    throw new Error("refusing to operate on a non-generated restore roundtrip database");
  }
}

function assertGeneratedPrefix(value: string): void {
  if (!/^backup-catalog-restore-roundtrip-tests\/(?:catalog|journal)\/[0-9a-f]{24}$/.test(value)) {
    throw new Error("refusing to clean a non-generated restore roundtrip prefix");
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
  BACKUP_CATALOG_DATABASE_NAMESPACE_ID: logicalDatabaseNamespaceId,
  BACKUP_CATALOG_NAMESPACE_ID: `restore-roundtrip-catalog-${runId}`,
  BACKUP_CATALOG_FAILURE_DOMAIN_ID: `restore-roundtrip-catalog-domain-${runId}`,
  BACKUP_CATALOG_INDEPENDENT_FAILURE_DOMAIN_ACK: "1",
  BACKUP_CATALOG_S3_ENDPOINT: endpoint.origin,
  BACKUP_CATALOG_S3_REGION: region,
  BACKUP_CATALOG_S3_BUCKET: catalogBucket,
  BACKUP_CATALOG_S3_PREFIX: catalogPrefix,
  BACKUP_CATALOG_S3_FORCE_PATH_STYLE: forcePathStyleRaw,
  BACKUP_CATALOG_S3_PRIVATE_BUCKET_ACK: "1",
  BACKUP_CATALOG_S3_REQUEST_TIMEOUT_MS: "5000",
  BACKUP_CATALOG_S3_ACCESS_KEY_ID: accessKeyId,
  BACKUP_CATALOG_S3_SECRET_ACCESS_KEY: secretAccessKey,
  BACKUP_CATALOG_MINIMUM_RETENTION_MS: "600000",
  BACKUP_CATALOG_MINIMUM_RECOVERABLE_BACKUPS: "1",
  RESTORE_JOURNAL_S3_BUCKET: journalBucket,
};

function journalEnv(runtimeEpochId: string): NodeJS.ProcessEnv {
  return {
    RESTORE_JOURNAL_ADAPTER: "s3",
    RESTORE_JOURNAL_DATABASE_NAMESPACE_ID: logicalDatabaseNamespaceId,
    RESTORE_JOURNAL_RUNTIME_EPOCH_ID: runtimeEpochId,
    RESTORE_JOURNAL_NAMESPACE_ID: `restore-roundtrip-journal-${runId}`,
    RESTORE_JOURNAL_FAILURE_DOMAIN_ID: `restore-roundtrip-journal-domain-${runId}`,
    RESTORE_JOURNAL_INDEPENDENT_FAILURE_DOMAIN_ACK: "1",
    RESTORE_JOURNAL_S3_ENDPOINT: endpoint.origin,
    RESTORE_JOURNAL_S3_REGION: region,
    RESTORE_JOURNAL_S3_BUCKET: journalBucket,
    RESTORE_JOURNAL_S3_PREFIX: journalPrefix,
    RESTORE_JOURNAL_S3_FORCE_PATH_STYLE: forcePathStyleRaw,
    RESTORE_JOURNAL_S3_PRIVATE_BUCKET_ACK: "1",
    RESTORE_JOURNAL_S3_REQUEST_TIMEOUT_MS: "5000",
    RESTORE_JOURNAL_S3_ACCESS_KEY_ID: accessKeyId,
    RESTORE_JOURNAL_S3_SECRET_ACCESS_KEY: secretAccessKey,
  };
}

const primaryJournalEnv = journalEnv(primaryRuntimeEpochId);
const restoredJournalEnv = journalEnv(restoredRuntimeEpochId);
const catalogConfig = loadTenantBackupCatalogConfig(catalogEnv, {
  production: false,
  store: "mysql",
  restoreJournalS3Bucket: journalBucket,
  requireRetentionPolicy: true,
});
const primaryJournalConfig = loadTenantRestoreJournalConfig(primaryJournalEnv, {
  production: false,
  store: "mysql",
});
const restoredJournalConfig = loadTenantRestoreJournalConfig(restoredJournalEnv, {
  production: false,
  store: "mysql",
});
if (integrationEnabled && (!catalogConfig || !primaryJournalConfig || !restoredJournalConfig)) {
  throw new Error("backup catalog restore roundtrip configuration did not load");
}

let owner: GenericJournalMysqlRuntimeOwner | undefined;
let setupComplete = false;
const nativeFailures: unknown[] = [];
let cleanupOwner: ReturnType<typeof createArtifactFixtureS3Client> | undefined;
const catalogOwners = new Set<ReturnType<typeof createArtifactFixtureS3Client>>();
function actualCatalogAdapter(config: NonNullable<typeof catalogConfig>, signal: AbortSignal) {
  const options = config.options;
  const owned = createArtifactFixtureS3Client({ region: options.region,
    ...(options.endpoint === null ? {} : { endpoint: options.endpoint }), forcePathStyle: options.forcePathStyle,
    ignoreConfiguredEndpointUrls: true, useFipsEndpoint: false, useDualstackEndpoint: false, useAccelerateEndpoint: false,
    useGlobalEndpoint: false, useArnRegion: false, disableMultiregionAccessPoints: true, followRegionRedirects: false,
    bucketEndpoint: false, maxAttempts: 2, ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
  }, signal);
  catalogOwners.add(owned);
  return new S3TenantBackupCatalogAdapter({ ...options, operationAbortSignal: signal, client: owned.client });
}

let cleanupClient: S3Client | undefined;
let mysqlClientDefaultsDirectory: string | undefined;
let mysqlClientDefaultsPath: string | undefined;

async function listPrefix(bucket: string, prefix: string): Promise<string[]> {
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
        throw new Error("backup restore roundtrip cleanup escaped its generated prefix");
      }
      keys.push(object.Key);
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && !continuationToken) {
      throw new Error("backup restore roundtrip cleanup omitted a continuation token");
    }
  } while (continuationToken);
  return keys;
}

async function cleanupPrefix(bucket: string, prefix: string): Promise<void> {
  while (true) {
    const keys = await listPrefix(bucket, prefix);
    if (keys.length === 0) return;
    for (let offset = 0; offset < keys.length; offset += 1_000) {
      const batch = keys.slice(offset, offset + 1_000);
      const result = await cleanupClient!.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Quiet: true, Objects: batch.map((Key) => ({ Key })) },
      }));
      if ((result.Errors?.length ?? 0) > 0) {
        throw new Error("backup restore roundtrip cleanup reported an object error");
      }
    }
  }
}

function mysqlOptionValue(value: string, name: string): string {
  if (value.includes("\0") || value.includes("\r") || value.includes("\n")) {
    throw new Error(`${name} cannot contain control characters in this integration fixture`);
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function createMysqlClientDefaults(): Promise<void> {
  const username = decodeURIComponent(base.username);
  const password = decodeURIComponent(base.password);
  if (!username || !base.hostname) {
    throw new Error("MYSQL_TEST_URL must include a username and TCP hostname");
  }
  mysqlClientDefaultsDirectory = await mkdtemp(
    join(tmpdir(), "agent-service-backup-restore-roundtrip-"),
  );
  mysqlClientDefaultsPath = join(mysqlClientDefaultsDirectory, "client.cnf");
  const body = [
    "[client]",
    "protocol=TCP",
    `host=${mysqlOptionValue(base.hostname, "MySQL hostname")}`,
    `port=${mysqlOptionValue(base.port || "3306", "MySQL port")}`,
    `user=${mysqlOptionValue(username, "MySQL username")}`,
    `password=${mysqlOptionValue(password, "MySQL password")}`,
    "default-character-set=utf8mb4",
    "",
  ].join("\n");
  await writeFile(mysqlClientDefaultsPath, body, { encoding: "utf8", mode: 0o600 });
}

function minimalProcessEnv(): NodeJS.ProcessEnv {
  return {
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
  };
}

async function authoritySnapshot(signal: AbortSignal): Promise<string> {
  const inspection = await owner!.openInspection(signal);
  try {
    const [identity] = await inspection.query<RowDataPacket[]>("SELECT @@GLOBAL.server_uuid AS uuid,DATABASE() AS db");
    if (identity.length !== 1 || identity[0]?.db !== database) throw new Error("roundtrip_authority_identity_invalid");
    const [others] = await inspection.query<RowDataPacket[]>(
      "SELECT ID FROM information_schema.PROCESSLIST WHERE BINARY DB=BINARY ? AND ID<>CONNECTION_ID()", [database]);
    const [transactions] = await inspection.query<RowDataPacket[]>(
      "SELECT trx_mysql_thread_id FROM information_schema.INNODB_TRX WHERE trx_mysql_thread_id IN (SELECT ID FROM information_schema.PROCESSLIST WHERE BINARY DB=BINARY ? AND ID<>CONNECTION_ID())", [database]);
    if (others.length || transactions.length) throw new Error("roundtrip_owned_clients_not_joined");
    const rows: unknown[] = [identity];
    for (const [table, order] of [["session_authority_control", "control_id"],
      ["session_authority_bindings", "binding_sequence"],
      ["session_authority_runtime_accounts", "binding_id,account_user,account_host"],
      ["tenant_restore_runtime_events", "control_generation"]] as const) {
      const [actual] = await inspection.query(`SELECT * FROM ${table} ORDER BY ${order}`); rows.push(actual);
    }
    return sha256(JSON.stringify(rows));
  } finally { await inspection.end(); }
}

function createLogicalSnapshot(): Buffer {
  if (!mysqlClientDefaultsPath) throw new Error("MySQL client defaults are unavailable");
  const result = spawnSync("mysqldump", [
    `--defaults-extra-file=${mysqlClientDefaultsPath}`,
    "--single-transaction",
    "--skip-lock-tables",
    "--hex-blob",
    "--no-tablespaces",
    "--skip-comments",
    "--default-character-set=utf8mb4",
    database,
  ], {
    cwd: root,
    env: minimalProcessEnv(),
    encoding: null,
    timeout: 60_000,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error || result.signal || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    throw new Error("logical_snapshot_failed");
  }
  if (result.stdout.length < 1_000 || !result.stdout.includes(Buffer.from("CREATE TABLE"))) {
    throw new Error("logical_snapshot_incomplete");
  }
  return result.stdout;
}

function restoreLogicalSnapshot(snapshot: Buffer): void {
  if (!mysqlClientDefaultsPath) throw new Error("MySQL client defaults are unavailable");
  const result = spawnSync("mysql", [
    `--defaults-extra-file=${mysqlClientDefaultsPath}`,
    "--binary-mode",
    "--default-character-set=utf8mb4",
    database,
  ], {
    cwd: root,
    env: minimalProcessEnv(),
    input: snapshot,
    encoding: null,
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error("logical_snapshot_restore_failed");
  }
}

interface CliResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runSourceCli(
  entrypoint: "backup-catalog.ts" | "restore-ledger-reconcile.ts",
  command: string,
  env: NodeJS.ProcessEnv,
): CliResult {
  const result = spawnSync(process.execPath, [
    "--import",
    "tsx",
    `apps/agent-runner/src/${entrypoint}`,
    command,
  ], {
    cwd: root,
    env: {
      NODE_ENV: "test",
      ...(entrypoint === "restore-ledger-reconcile.ts" && command === "activate-runtime"
        ? { MYSQL_URL: mysqlUrl }
        : entrypoint === "restore-ledger-reconcile.ts" && ["status", "replay-fences", "verify"].includes(command)
          ? { MYSQL_URL: mysqlUrl, RESTORE_LEDGER_REPLAY_STOPPED_LOCAL_ACK: "1" }
          : runtimeEnvironment()),
      ...env,
      ...minimalProcessEnv(),
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) throw new Error("one_shot_cli_process_failed");
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

const issuedRuntimeSecrets = new Set<string>(), cliOutputs: string[] = [];
function runtimeEnvironment(): Readonly<Record<string, string>> {
  const environment = owner!.runtimeEnv(), runtimeUrl = environment.MYSQL_URL;
  if (typeof runtimeUrl !== "string" || !runtimeUrl) throw new Error("runtime_profile_url_missing");
  const address = new URL(runtimeUrl);
  for (const value of [address.toString(), decodeURIComponent(address.password)]) if (value) issuedRuntimeSecrets.add(value);
  for (const output of cliOutputs) for (const value of issuedRuntimeSecrets) expect(output.includes(value)).toBe(false);
  return environment;
}
function expectNoAuthorityLeak(result: CliResult): void {
  const output = `${result.stdout}\n${result.stderr}`;
  for (const value of [
    accessKeyId,
    secretAccessKey,
    decodeURIComponent(base.username),
    decodeURIComponent(base.password),
  ]) {
    if (value) expect(output).not.toContain(value);
  }
  cliOutputs.push(output);
  for (const value of issuedRuntimeSecrets) expect(output.includes(value)).toBe(false);
}

function expectCliSuccess(result: CliResult): Record<string, unknown> {
  expectNoAuthorityLeak(result);
  expect(result.signal).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

function sealedJournalHead(
  config: NonNullable<typeof primaryJournalConfig>,
  remoteSequence: number,
  headRootSha256: string,
): TenantRestoreReplaySealedTarget {
  return {
    ...config.targets[0].descriptor,
    logicalDatabaseNamespaceSha256: config.logicalDatabaseNamespaceSha256,
    sealedRemoteSequence: remoteSequence,
    sealedHeadRootSha256: headRootSha256,
  };
}

const describeIntegration = integrationEnabled ? describe : describe.skip;

describeIntegration("backup-catalog old-snapshot restore roundtrip with real MySQL and MinIO", () => {
  beforeAll(async () => {
    assertGeneratedDatabaseName(database);
    owner = new GenericJournalMysqlRuntimeOwner(base.toString(), { applicationDatabase: database });
    await owner.allocateFresh();
    cleanupOwner = createArtifactFixtureS3Client(s3ClientConfig); cleanupClient = cleanupOwner.client;
    await createMysqlClientDefaults(); setupComplete = true;
  }, 30_000);

  afterAll(async ({}, suite) => {
    const passed = setupComplete && nativeFailures.length === 0 && suite.tasks.length === 1
      && suite.tasks.every(task => task.type === "test" && task.mode === "run" && task.result?.state === "pass"
        && !task.result.errors?.length && (task.result.retryCount ?? 0) === 0 && (task.result.repeatCount ?? 0) === 0);
    let failure: { reason: unknown } | undefined;
    const remember = (reason: unknown) => { failure ??= { reason }; };
    if (!passed) { cleanupOwner?.stop(); for (const owned of catalogOwners) owned.stop(); }
    for (const owned of catalogOwners) { try { await owned.close(); } catch (reason) { remember(reason); } }
    try { await owner?.close({ successful: passed && !failure }); } catch (reason) { remember(reason); }
    if (passed && !failure && cleanupClient) {
      for (const [bucket, prefix] of [[catalogBucket, catalogPrefix], [journalBucket, journalPrefix]] as const) {
        try { await cleanupPrefix(bucket, prefix); } catch (reason) { remember(reason); }
      }
    }
    try { await cleanupOwner?.close(); } catch (reason) { remember(reason); }
    if (passed && !failure && mysqlClientDefaultsDirectory) {
      const expectedPrefix = join(tmpdir(), "agent-service-backup-restore-roundtrip-");
      if (!mysqlClientDefaultsDirectory.startsWith(expectedPrefix)) remember(new Error("refusing to clean an unexpected defaults directory"));
      else try { await rm(mysqlClientDefaultsDirectory, { recursive: true, force: true }); } catch (reason) { remember(reason); }
    }
    if (failure) throw failure.reason;
  }, 30_000);

  it("replays the same external reservation after restoring the anchored old snapshot", async context => {
    const catalog = catalogConfig!;
    const journal = primaryJournalConfig!;
    const [journalAdapter] = createTenantRestoreJournalAdapters(journal, { ownedNativeTransport: true, operationAbortSignal: context.signal });
    if (!journalAdapter) throw new Error("restore journal adapter did not load");
    const catalogAdapter = actualCatalogAdapter(catalog, context.signal);
    let store: MysqlSessionStore | undefined, bodyFailed = false;
    try {
      await journalAdapter.validateStartup();
      await catalogAdapter.validateStartup();
      const initialJournalHead = await journalAdapter.readHead();
      expect(initialJournalHead.remoteSequence).toBe(0);

      await owner!.prepare();
      store = await owner!.openStore(2, context.signal);
      await store.activateBlobStorageControl({
        expectedControlGeneration: 0,
        storageBackend: "s3v1-roundtrip-test",
        namespaceSha256: sha256(`restore-roundtrip-blob-${runId}`),
      });
      await owner!.activatePrimary({
        adapterProtocol: journal.adapterProtocol,
        journalNamespaceSha256: journal.journalNamespaceSha256,
        logicalDatabaseNamespaceSha256: journal.logicalDatabaseNamespaceSha256,
        runtimeEpochSha256: journal.runtimeEpochSha256,
        targets: journal.targets.map((target) => target.descriptor),
        observedHeads: [sealedJournalHead(
          journal,
          initialJournalHead.remoteSequence,
          initialJournalHead.headRootSha256,
        )],
      });
      await store.close();
      store = undefined;

      expect(expectCliSuccess(runSourceCli("backup-catalog.ts", "activate", {
        ...catalogEnv,
        BACKUP_CATALOG_ACTIVATION_ACK: "1",
        RESTORE_FLEET_STOPPED_ACK: "1",
      }))).toMatchObject({
        status: "ok",
        command: "activate",
        catalogControlGeneration: 1,
      });
      const anchored = expectCliSuccess(runSourceCli("backup-catalog.ts", "begin-backup", {
        ...catalogEnv,
        BACKUP_ID: backupId,
        RESTORE_FLEET_STOPPED_ACK: "1",
      }));
      expect(anchored).toMatchObject({
        status: "ok",
        command: "begin-backup",
        disposition: "created",
        backupId,
      });

      // This is the actual old database image: it contains the active 0031 control and the anchor,
      // but predates availability projection, restore binding, reservation and 0030 replay run.
      const sourceAuthoritySha256 = await authoritySnapshot(context.signal);
      const oldSnapshot = createLogicalSnapshot();
      const sourceBackupSha256 = sha256(oldSnapshot);
      const sourceSnapshotSha256 = sha256(`mysql-logical-snapshot-v1:${sourceBackupSha256}`);
      const artifactManifestSha256 = sha256(`mysql-logical-manifest-v1:${sourceBackupSha256}`);
      const providerEvidenceSha256 = sha256(`mysqldump-provider-evidence-v1:${sourceBackupSha256}`);

      expect(expectCliSuccess(runSourceCli("backup-catalog.ts", "publish-backup", {
        ...catalogEnv,
        BACKUP_ID: backupId,
        SOURCE_SNAPSHOT_SHA256: sourceSnapshotSha256,
        SOURCE_BACKUP_SHA256: sourceBackupSha256,
        BACKUP_ARTIFACT_MANIFEST_SHA256: artifactManifestSha256,
        BACKUP_PROVIDER_EVIDENCE_SHA256: providerEvidenceSha256,
      }))).toMatchObject({
        status: "ok",
        command: "publish-backup",
        disposition: "created",
        backupId,
        catalogSequence: 1,
      });

      const newerAnchored = expectCliSuccess(runSourceCli(
        "backup-catalog.ts",
        "begin-backup",
        {
          ...catalogEnv,
          BACKUP_ID: newerBackupId,
          RESTORE_FLEET_STOPPED_ACK: "1",
        },
      ));
      expect(newerAnchored).toMatchObject({
        status: "ok",
        command: "begin-backup",
        disposition: "created",
        backupId: newerBackupId,
      });
      const newerSnapshot = createLogicalSnapshot();
      const newerSourceBackupSha256 = sha256(newerSnapshot);
      expect(newerSourceBackupSha256).not.toBe(sourceBackupSha256);
      expect(expectCliSuccess(runSourceCli("backup-catalog.ts", "publish-backup", {
        ...catalogEnv,
        BACKUP_ID: newerBackupId,
        SOURCE_SNAPSHOT_SHA256:
          sha256(`mysql-logical-snapshot-v1:${newerSourceBackupSha256}`),
        SOURCE_BACKUP_SHA256: newerSourceBackupSha256,
        BACKUP_ARTIFACT_MANIFEST_SHA256:
          sha256(`mysql-logical-manifest-v1:${newerSourceBackupSha256}`),
        BACKUP_PROVIDER_EVIDENCE_SHA256:
          sha256(`mysqldump-provider-evidence-v1:${newerSourceBackupSha256}`),
      }))).toMatchObject({
        status: "ok",
        command: "publish-backup",
        disposition: "created",
        backupId: newerBackupId,
        catalogSequence: 2,
      });

      const prepareRestoreEnv = {
        ...catalogEnv,
        ...restoredJournalEnv,
        BACKUP_ID: backupId,
        RESTORE_RUN_ID: restoreRunId,
        BACKUP_RUNTIME_EPOCH_ID: restoredRuntimeEpochId,
        SOURCE_BACKUP_SHA256: sourceBackupSha256,
        RESTORE_FLEET_STOPPED_ACK: "1",
      };
      const initiallyPrepared = expectCliSuccess(runSourceCli(
        "backup-catalog.ts",
        "prepare-restore",
        prepareRestoreEnv,
      ));
      expect(initiallyPrepared).toMatchObject({
        status: "ok",
        command: "prepare-restore",
        disposition: "created",
        backupId,
        restoreRunId,
        restorePhase: "prepared",
        catalogSequence: 3,
      });
      const reservedHead = await catalogAdapter.readHead();
      expect(reservedHead.catalogSequence).toBe(3);

      store = await owner!.openStore(2, context.signal);
      const initialEntry = await store.getTenantBackupCatalogEntry(backupId);
      const initialNewerEntry = await store.getTenantBackupCatalogEntry(newerBackupId);
      expect(initialEntry).not.toBeNull();
      expect(initialNewerEntry).not.toBeNull();
      if (!initialEntry || !initialNewerEntry) {
        throw new Error("initial backup availability was not projected");
      }
      expect(await store.getTenantBackupRestoreSourceBinding(restoreRunId)).not.toBeNull();
      const initialReservation = await store.getTenantBackupRuntimeReservation(restoreRunId);
      expect(initialReservation).toMatchObject({ phase: "reserved" });
      if (!initialReservation) throw new Error("initial restore reservation was not projected");
      const stableExternalReservationIdentity = {
        backupId: initialReservation.backupId,
        restoreRunId: initialReservation.restoreRunId,
        entrySha256: initialReservation.entrySha256,
        runtimeEpochSha256: initialReservation.runtimeEpochSha256,
        reservationOperationSha256: initialReservation.reservationOperationSha256,
        reservationReceiptSha256: initialReservation.reservationReceiptSha256,
        catalogSequence: initialReservation.catalogSequence,
        previousCatalogEventRootSha256: initialReservation.previousCatalogEventRootSha256,
        catalogEventRootSha256: initialReservation.catalogEventRootSha256,
        catalogEventSha256: initialReservation.catalogEventSha256,
      };
      expect(await store.getTenantRestoreReplayRun(restoreRunId))
        .toMatchObject({ phase: "prepared" });
      await store.close();
      store = undefined;

      await authoritySnapshot(context.signal); // Actual owned clients/transactions must be idle before native import.
      restoreLogicalSnapshot(oldSnapshot);
      if (await authoritySnapshot(context.signal) !== sourceAuthoritySha256) throw new Error("roundtrip_old_authority_image_changed");

      store = await owner!.openStore(2, context.signal);
      expect(await store.getTenantBackupCatalogControl())
        .toMatchObject({ state: "active", controlGeneration: 1 });
      expect(await store.getTenantBackupSnapshotAnchor(backupId)).not.toBeNull();
      expect(await store.getTenantBackupCatalogEntry(backupId)).toBeNull();
      expect(await store.getTenantBackupSnapshotAnchor(newerBackupId)).toBeNull();
      expect(await store.getTenantBackupCatalogEntry(newerBackupId)).toBeNull();
      expect(await store.getTenantBackupRestoreSourceBinding(restoreRunId)).toBeNull();
      expect(await store.getTenantBackupRuntimeReservation(restoreRunId)).toBeNull();
      expect(await store.getTenantRestoreReplayRun(restoreRunId)).toBeNull();
      await store.close();
      store = undefined;

      const ordinaryPrepare = runSourceCli("restore-ledger-reconcile.ts", "prepare", {
        ...restoredJournalEnv,
        RESTORE_RUN_ID: restoreRunId,
        SOURCE_BACKUP_SHA256: sourceBackupSha256,
        RESTORE_FLEET_STOPPED_ACK: "1",
      });
      expectNoAuthorityLeak(ordinaryPrepare);
      expect(ordinaryPrepare.signal).toBeNull();
      expect(ordinaryPrepare.status).toBe(1);
      expect(ordinaryPrepare.stdout).toBe("");
      expect(ordinaryPrepare.stderr).toBe(
        '{"status":"error","code":"operation_failed"}\n',
      );

      store = await owner!.openStore(2, context.signal);
      const restoredJournal = restoredJournalConfig!;
      const restoredControl = await store.getTenantRestoreJournalControl();
      expect(restoredControl.controlGeneration).toBe(1);
      if (restoredControl.controlGeneration !== 1) {
        throw new Error("restore journal control was not preserved by the old snapshot");
      }
      const restoredExternalHead = await journalAdapter.readHead();
      await expect(store.prepareTenantRestoreReplay({
        restoreRunId,
        sourceBackupSha256,
        runtimeEpochSha256: restoredJournal.runtimeEpochSha256,
        controlEvidenceSha256: restoredControl.evidenceSha256,
        sealedTargets: [sealedJournalHead(
          restoredJournal,
          restoredExternalHead.remoteSequence,
          restoredExternalHead.headRootSha256,
        )],
      })).rejects.toMatchObject({ reason: "catalog_binding_required" });
      expect(await store.getTenantBackupRestoreSourceBinding(restoreRunId)).toBeNull();
      expect(await store.getTenantBackupRuntimeReservation(restoreRunId)).toBeNull();
      expect(await store.getTenantRestoreReplayRun(restoreRunId)).toBeNull();
      await store.close();
      store = undefined;

      const recovered = expectCliSuccess(runSourceCli(
        "backup-catalog.ts",
        "prepare-restore",
        prepareRestoreEnv,
      ));
      expect(recovered).toMatchObject({
        status: "ok",
        command: "prepare-restore",
        disposition: "created",
        backupId,
        restoreRunId,
        restorePhase: "prepared",
        catalogSequence: stableExternalReservationIdentity.catalogSequence,
      });
      expect(await catalogAdapter.readHead()).toEqual(reservedHead);

      store = await owner!.openStore(2, context.signal);
      expect(await store.getTenantBackupCatalogEntry(backupId)).toEqual(initialEntry);
      expect(await store.getTenantBackupCatalogEntry(newerBackupId)).toEqual(initialNewerEntry);
      expect(await store.getTenantBackupRestoreSourceBinding(restoreRunId))
        .toMatchObject({ backupId, sourceBackupSha256 });
      expect(await store.getTenantBackupRuntimeReservation(restoreRunId)).toMatchObject({
        ...stableExternalReservationIdentity,
        backupId,
        phase: "reserved",
      });
      expect(await store.getTenantRestoreReplayRun(restoreRunId)).toMatchObject({
        restoreRunId,
        sourceBackupSha256,
        phase: "prepared",
      });
      await store.close();
      store = undefined;

      const restoreEnv = {
        ...restoredJournalEnv,
        RESTORE_RUN_ID: restoreRunId,
        RESTORE_FLEET_STOPPED_ACK: "1",
      };
      expect(expectCliSuccess(runSourceCli(
        "restore-ledger-reconcile.ts",
        "replay-fences",
        restoreEnv,
      ))).toMatchObject({ command: "replay-fences", restorePhase: "prepared" });
      expect(expectCliSuccess(runSourceCli(
        "restore-ledger-reconcile.ts",
        "verify",
        restoreEnv,
      ))).toMatchObject({ command: "verify", restorePhase: "replay_sealed" });
      const beforeActivation = await owner!.openRuntimeMaintenance(2, context.signal);
      const expectedControlGeneration = await artifactCloseAfter(
        async () => (await beforeActivation.getTenantRestoreRuntimeControl()).controlGeneration,
        () => beforeActivation.close());
      const transition = await owner!.stageRestore({ restoreRunId, expectedControlGeneration });
      const activated = await owner!.runActivationCli(transition, fixedEnvironment => runSourceCli(
        "restore-ledger-reconcile.ts", "activate-runtime", { ...restoreEnv, ...fixedEnvironment },
      ));
      expect(expectCliSuccess(activated)).toMatchObject({ command: "activate-runtime", restorePhase: "active" });
      const confirmation = await owner!.openActivationFacade(transition, 2);
      await artifactCloseAfter(() => owner!.confirm(transition, confirmation), () => confirmation.close());
      runtimeEnvironment(); // Recheck all original output against the now-confirmed successor credential too.
      expect(expectCliSuccess(runSourceCli("backup-catalog.ts", "resolve-restore", {
        ...catalogEnv,
        RESTORE_RUN_ID: restoreRunId,
        RESTORE_FLEET_STOPPED_ACK: "1",
      }))).toMatchObject({
        command: "resolve-restore",
        disposition: "created",
        restoreRunId,
        phase: "activated",
        resolutionCatalogSequence: 4,
      });

      store = await owner!.openStore(2, context.signal);
      expect(await store.getTenantRestoreReplayRun(restoreRunId))
        .toMatchObject({ phase: "active" });
      expect(await store.getTenantBackupRuntimeReservation(restoreRunId))
        .toMatchObject({ phase: "activated" });
      await store.close();
      store = undefined;
      expect((await catalogAdapter.readHead()).catalogSequence).toBe(4);
    } catch (reason) { bodyFailed = true; throw reason; }
    finally {
      let failure: { reason: unknown } | undefined;
      for (const close of [() => store?.close(), () => journalAdapter.close(), () => catalogAdapter.close()]) {
        try { await close(); } catch (reason) { nativeFailures.push(reason); failure ??= { reason }; }
      }
      if (failure && !bodyFailed) throw failure.reason;
    }
  }, 180_000);
});
