import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isIP } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BLOB_STORAGE_FORMAT,
  BlobStorageControlConflictError,
  BlobStorageMigrationConflictError,
  FsBlobStore,
  MysqlBlobStorageMigrationCoordinator,
  MysqlSessionStore,
  blobStorageMigrationTargetOwnerSha256,
  type BeginBlobStorageMigrationInput,
  type BlobDescriptor,
  type BlobMigrationStore,
} from "../../src/index.js";
import { buildSchemaMetadataProcedure } from "../../src/mysql/schema-metadata-codec.js";
import { activateCurrentSchemaFixtureAuthority } from "../fixtures/schema-current-authority.js";
import { OwnedRetirementConnection } from "../fixtures/authority-retirement.js";

const BASE_URL = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, "../../migrations");
const MIGRATION_NAME = "0028_blob_storage_migration.sql";
const MAX_BYTES = 1024 * 1024;
const FLEET_EVIDENCE = "f".repeat(64);

const FROZEN_0027_MIGRATIONS = [
  ["0001_init.sql", "4ddae03c6822ae65b8defc65d7c1a96f053f2b56e5442ac7ca9aacb2331d5026"],
  ["0002_auto_approved.sql", "d71b98781d5637762f840e33baeb2f423d7b2275fa309c9a433ec7c75b83b3a9"],
  ["0003_tenant_auth.sql", "7e394446ba094dce0bec563d9e1301f32590ace5080296668fa867e5f9b16d6e"],
  ["0004_compaction.sql", "7dff8f813a82107f76047f8e1d5e00a33784e2225d2ea6ac882ee9cc8bc20db5"],
  ["0005_api_key_scopes.sql", "9e6c3006906c035d13761bb861423a1af6cb91dc2c8eb38471bc8556a16bf68b"],
  ["0006_id_collation.sql", "87b4e8e20b9950ade9a63da4889027abd6ed0763e34efce5c7693a2be777169f"],
  ["0007_strict_ids_and_idempotency_scope.sql", "98a26299739412a3be9ab0c58a09a08819517c32dfd5c1f225dfb3aa11c6f705"],
  ["0008_atomic_turn_writes.sql", "9070634545ab705897ce7cf56a9d794d39b5f3974fcf46dcac7b8c163cecfcb1"],
  ["0009_session_tombstone_outbox.sql", "97e97d2a6c3c3fec75ac28baf8c72ce459df708373b161f9fe4b270a5b2f0d63"],
  ["0010_blob_ownership.sql", "df248cebda2344953e742af74ef87e40fedcae33bf80813c3a44b81b75054129"],
  ["0011_erasure_and_usage_separation.sql", "ef3d5a6931020360f83358159684256ca55bc5346f59c203f049ebcf4469b53e"],
  ["0012_erasure_job_queue.sql", "80de4af2338e18a9cbca69bae21e7414ecef57daeb39c962d61e5a2a520249fb"],
  ["0013_erasure_job_control.sql", "16b99546bec9d3e8b169dd104a5f3c7633db526f438e11043af42ff1ea050334"],
  ["0014_legacy_tombstone_compensation.sql", "609832231836e1ed332b88c77bd95ef86ca8eb7eff7345157ab2541a1289954c"],
  ["0015_retention_policy_and_legal_holds.sql", "5a0eddbaaed07e318d18ea2b6de777d5c0a6e3975168e100a9087d2be8d6eadb"],
  ["0016_erasure_purge_policy_authority.sql", "b7adefcf769adc884dd2efd901fea4767afacf3426dee97771f826cf80d1d3e3"],
  ["0017_user_export_jobs_and_artifacts.sql", "82ad26228fe29051c8d72e1339934420f12d5ee1d7506fea6419b46845a5a189"],
  ["0018_tenant_credential_revocation_fence.sql", "225b1571a990f534211f6c9ae8cc39816a449c13b87e28a67f306e7e7488d4dd"],
  ["0019_tenant_credential_physical_revocation.sql", "0a116472878dbbefeccff6830f836f786adced7384513979e0c600fef5886dfa"],
  ["0020_tenant_runtime_revocation.sql", "f09170eeed0616e5db1283e2761e3a3140c1960bdcf866e133fa9ef03bd3837b"],
  ["0021_tenant_content_inventory.sql", "fe2934d216dfde16f5912af551d387193bbabba4c8903e8484dbc248bfa365c8"],
  ["0022_tenant_purge_plan.sql", "9dcbcfb27a2a307552943da2c8b15df50f64730f9b15eeb4fe1ce055c60ca5f1"],
  ["0023_tenant_purge_execution_ack.sql", "b0535b89012703b89bbfc7cb9cf8dd949a6e750f11421905467f29e4f87295d9"],
  ["0024_tenant_database_purge.sql", "8260d0331d737923fc803cec506de0261d9962d8fce742d21e07bf07f4040e0e"],
  ["0025_tenant_redis_purge.sql", "c93ca46a13965bfbdd79e1d8dab5d4b75cd515d3c66a29cea6c27f1cef643c28"],
  ["0026_credential_lifecycle_inventory.sql", "75c67a6c430189674653d486a3d747c4ba99811c2ec967fc6990e2e40780895e"],
  ["0027_blob_storage_control.sql", "bacd1cddcaac9bb1d8a56b22ade18e7d0c3abb26ec5d41e7769505dd89b51636"],
] as const;

type Row = RowDataPacket;

function disposableBase(raw: string): URL {
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !/(?:^|[_-])(test|migration)(?:$|[_-])/i.test(database)) {
    throw new Error(`MYSQL_MIGRATION_TEST_URL must name a test/migration database, got ${database}`);
  }
  return url;
}

function databaseUrl(base: URL, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function databaseName(): string {
  return `agent_service_migration_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

function plainRows(rows: Row[]): unknown[] {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    Buffer.isBuffer(value) ? value.toString("hex") : value,
  ])));
}

function targetBackend(namespaceSha256: string): string {
  return `s3-v1-${namespaceSha256.slice(0, 24)}`;
}

interface StoreFixture {
  source: FsBlobStore;
  target: BlobMigrationStore;
  sourceRoot: string;
  targetRoot: string;
  targetNamespaceSha256: string;
  targetBackend: string;
}

async function createStores(suffix: string): Promise<StoreFixture> {
  const sourceRoot = await mkdtemp(join(tmpdir(), `agent-service-0028-source-${suffix}-`));
  const targetRoot = await mkdtemp(join(tmpdir(), `agent-service-0028-target-${suffix}-`));
  const source = new FsBlobStore(sourceRoot);
  const targetNamespaceSha256 = createHash("sha256")
    .update(`agent-service-0028-target-${suffix}`)
    .digest("hex");
  const backend = targetBackend(targetNamespaceSha256);
  const target = new FsBlobStore(targetRoot);
  Object.defineProperties(target, {
    backend: { configurable: true, value: backend },
    namespaceSha256: { configurable: true, value: targetNamespaceSha256 },
    shared: { configurable: true, value: true },
  });
  return {
    source,
    target: target as unknown as BlobMigrationStore,
    sourceRoot,
    targetRoot,
    targetNamespaceSha256,
    targetBackend: backend,
  };
}

async function cleanupStores(stores: StoreFixture | undefined): Promise<void> {
  if (!stores) return;
  await rm(stores.sourceRoot, { recursive: true, force: true });
  await rm(stores.targetRoot, { recursive: true, force: true });
}

function migrationInput(
  stores: StoreFixture,
  migrationId: string,
  expectedControlGeneration = 0,
): BeginBlobStorageMigrationInput {
  return {
    migrationId,
    expectedControlGeneration,
    sourceBackend: "filesystem-v1",
    sourceNamespaceSha256: stores.source.namespaceSha256,
    targetBackend: stores.targetBackend,
    targetNamespaceSha256: stores.targetNamespaceSha256,
    rollbackWindowMs: 0,
    sourceCleanupDelayMs: 0,
    fleetDrainedEvidenceSha256: FLEET_EVIDENCE,
  };
}

async function seedStagingBlob(conn: Connection, suffix: string): Promise<void> {
  await conn.query(
    `INSERT INTO blob_objects
       (blob_id,tenant_id,user_id,session_id,item_id,purpose,storage_backend,storage_format,
        storage_key,upload_token,state,deletion_generation,created_at_ms)
     VALUES (?,?,?,?,NULL,'tool_output','filesystem-v1',?,?,?,'staging',0,1)`,
    [
      `blob-${suffix}`,
      `tenant-${suffix}`,
      `user-${suffix}`,
      `session-${suffix}`,
      BLOB_STORAGE_FORMAT,
      `objects/${suffix}`,
      `upload-${suffix}`,
    ],
  );
}

async function seedStagingExportPart(conn: Connection, suffix: string): Promise<void> {
  await conn.query(
    `INSERT INTO user_export_artifact_parts
       (artifact_id,part_number,request_id,build_generation,tenant_id,user_id,
        subject_generation,state,storage_backend,storage_format,storage_key,upload_token,
        content_type,content_encoding,sha256,size_bytes,record_count,staging_expires_at_ms,
        uploaded_at_ms,delete_after_ms,deleted_at_ms,deletion_generation,created_at_ms,updated_at_ms)
     VALUES (?,0,?,1,?,?,1,'staging','filesystem-v1',?,?,?,NULL,'identity',NULL,NULL,NULL,
             10000000000000,NULL,NULL,NULL,0,1,1)`,
    [
      `artifact-${suffix}`,
      `request-${suffix}`,
      `tenant-${suffix}`,
      `user-${suffix}`,
      BLOB_STORAGE_FORMAT,
      `exports/${suffix}`,
      `export-upload-${suffix}`,
    ],
  );
}

async function seedReadyBlob(
  conn: Connection,
  source: FsBlobStore,
  suffix: string,
  data = `payload-${suffix}`,
): Promise<{ descriptor: BlobDescriptor; uploadToken: string }> {
  const storageKey = `objects/${suffix}`;
  const uploadToken = `upload-${suffix}`;
  const descriptor = await source.putIfAbsent(storageKey, data, {
    uploadToken,
    maxBytes: MAX_BYTES,
    contentType: "text/plain",
  });
  await conn.query(
    `INSERT INTO blob_objects
       (blob_id,tenant_id,user_id,session_id,item_id,purpose,storage_backend,storage_format,
        storage_key,upload_token,state,sha256,size_bytes,content_type,uploaded_at_ms,ready_at_ms,
        deletion_generation,created_at_ms)
     VALUES (?,?,?,?,NULL,'tool_output','filesystem-v1',?,?,?,'ready',UNHEX(?),?,? ,1,1,0,1)`,
    [
      `blob-${suffix}`,
      `tenant-${suffix}`,
      `user-${suffix}`,
      `session-${suffix}`,
      BLOB_STORAGE_FORMAT,
      storageKey,
      uploadToken,
      descriptor.sha256,
      descriptor.sizeBytes,
      descriptor.contentType,
    ],
  );
  return { descriptor, uploadToken };
}

describe("0027 -> 0028 Blob storage migration ledger", () => {
  let admin: Connection;
  let base: URL;
  let pre0028Dir: string;
  let migrationSql: string;
  let migrationStatements: string[];
  let createTableStatements: string[];

  beforeAll(async () => {
    base = disposableBase(BASE_URL);
    const adminUrl = new URL(base);
    adminUrl.pathname = "/";
    admin = await mysql.createConnection(adminUrl.toString());
    pre0028Dir = await mkdtemp(join(tmpdir(), "agent-service-pre0028-"));
    for (const [file, expectedSha256] of FROZEN_0027_MIGRATIONS) {
      const bytes = await readFile(join(MIGRATIONS_DIR, file));
      expect(createHash("sha256").update(bytes).digest("hex"), file).toBe(expectedSha256);
      await copyFile(join(MIGRATIONS_DIR, file), join(pre0028Dir, file));
    }
    migrationSql = await readFile(join(MIGRATIONS_DIR, MIGRATION_NAME), "utf8");
    migrationStatements = migrationSql.replace(/^\s*--.*$/gm, "")
      .split(/;\s*\n/).map((statement) => statement.trim()).filter(Boolean);
    createTableStatements = migrationStatements.filter((statement) => (
      statement.startsWith("CREATE TABLE IF NOT EXISTS blob_storage_migration_")
    ));
    expect(createTableStatements).toHaveLength(7);
  });

  afterAll(async () => {
    await admin?.end();
    if (pre0028Dir) await rm(pre0028Dir, { recursive: true, force: true });
  });

  async function create0027(database: string): Promise<void> {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const store = await MysqlSessionStore.connect({
      url: databaseUrl(base, database),
      migrationsDir: pre0028Dir,
    });
    await store.close();
  }

  async function cleanup(database: string): Promise<void> {
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
  }

  async function migrateCurrent(database: string, signal: AbortSignal): Promise<void> {
    await MysqlSessionStore.runSchemaOperation({ url: databaseUrl(base, database), operation: "migrate",
      migrationsDir: MIGRATIONS_DIR, migrationLockTimeoutSeconds: 60, fleetStoppedAck: "all-application-writers-stopped-v1", operationAbortSignal: signal });
  }

  /** Three ordinary Blob-control cases on an already-owned current schema. No adoption/fresh-DB witness. */
  class ExistingBlobControlRuntime {
    private readonly suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    private readonly metadataSchema = `agent_service_test_blob_meta_${this.suffix}`;
    private readonly runtimeUser = `bm_rt_${this.suffix}`;
    private readonly definerUser = `bm_df_${this.suffix}`;
    private readonly password = randomBytes(32).toString("hex");
    private readonly owners = new Set<OwnedRetirementConnection>();
    private readonly pending = new Set<Promise<unknown>>();
    private readonly stores = new Set<MysqlSessionStore>();
    private readonly accountAttempts = new Set<string>();
    private metadataAttempted = false;
    private host = "";
    private uuid = "";
    private bindingId = "";
    private ready = false;
    private preparing?: Promise<void>;
    private closing?: Promise<void>;
    private operator?: OwnedRetirementConnection;
    private options?: Parameters<typeof MysqlSessionStore.connect>[0];

    constructor(private readonly database: string, private readonly signal: AbortSignal) {
      if (!/^agent_service_migration_test_[0-9]+_[a-f0-9]{8}$/.test(database)) throw Error("blob_runtime_fixture_identity");
    }
    private own<T>(task: Promise<T>): Promise<T> {
      this.pending.add(task); void task.then(() => this.pending.delete(task), () => this.pending.delete(task)); return task;
    }
    private account(user: string): string { return `${mysql.escape(user)}@${mysql.escape(this.host)}`; }
    private active(): void { this.signal.throwIfAborted(); }
    private async createAccount(user: string): Promise<void> {
      const conn = this.operator!;
      if ((await conn.rows("SELECT User,Host FROM mysql.user WHERE BINARY User=BINARY ?", [user])).length) throw Error("blob_runtime_fixture_identity");
      this.accountAttempts.add(user); // Unknown CREATE retains this exact issued identity.
      try {
        await conn.exec(`CREATE USER ${this.account(user)} ${user === this.runtimeUser ? "IDENTIFIED BY ?" : "ACCOUNT LOCK"}`,
          user === this.runtimeUser ? [this.password] : []);
      } catch (error) {
        const safe = new Error("Blob migration fixture account creation failed.");
        for (const key of ["code", "errno", "sqlState"] as const) {
          try {
            const d = error !== null && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, key) : undefined;
            if (!d || !("value" in d)) continue;
            const value: unknown = d.value;
            if (key === "code" && typeof value === "string" && /^(?:(?:ER|WARN|EE|CR|HA_ERR|PROTOCOL|ERR)_[A-Z0-9_]{1,80}|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|ABORT_ERR)$/.test(value)
              || key === "errno" && typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 65_535
              || key === "sqlState" && typeof value === "string" && /^[A-Z0-9]{5}$/.test(value)) Object.defineProperty(safe, key, { value, enumerable: true });
          } catch { /* Do not expose a credential-bearing diagnostic getter/raw error. */ }
        }
        throw safe;
      }
    }
    prepare(): Promise<void> {
      if (this.preparing) return this.preparing;
      if (this.closing) return Promise.reject(Error("blob_runtime_fixture_closed"));
      return this.preparing = this.own((async () => {
        this.active();
        this.operator = await OwnedRetirementConnection.open(databaseUrl(base, this.database), this.signal, owner => this.owners.add(owner));
        const conn = this.operator;
        const identity = await conn.rows("SELECT @@server_uuid AS uuid,DATABASE() AS db,SUBSTRING_INDEX(USER(),'@',-1) AS client_host,@@GLOBAL.partial_revokes AS partial_revokes");
        const row = identity[0], mode: unknown = row?.partial_revokes;
        this.host = String(row?.client_host); this.uuid = String(row?.uuid).toLowerCase();
        if (identity.length !== 1 || row?.db !== this.database || !/^[a-f0-9-]{36}$/.test(this.uuid)
          || mode !== 0 && mode !== 1 || !this.host || this.host.length > 255 || /[%_@\\/\u0000-\u0020\u007f]/.test(this.host)
          || isIP(this.host) === 0 && !this.host.split(".").every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) throw Error("blob_runtime_fixture_identity");
        if ((await conn.rows("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", [this.metadataSchema])).length) throw Error("blob_runtime_fixture_identity");
        this.metadataAttempted = true;
        await conn.exec(`CREATE DATABASE ${mysql.escapeId(this.metadataSchema)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
        await this.createAccount(this.runtimeUser); await this.createAccount(this.definerUser);
        const tables = await conn.rows("SELECT TABLE_NAME FROM information_schema.TABLES WHERE BINARY TABLE_SCHEMA=BINARY ? AND TABLE_TYPE='BASE TABLE' ORDER BY BINARY TABLE_NAME", [this.database]);
        if (!tables.length) throw Error("blob_runtime_fixture_identity");
        for (const table of tables) {
          const name = String(table.TABLE_NAME), readOnly = ["schema_migrations", "session_authority_control", "session_authority_bindings", "session_authority_runtime_accounts"].includes(name);
          await conn.exec(`GRANT ${readOnly ? "SELECT" : "SELECT,INSERT,UPDATE,DELETE"} ON ${mysql.escapeId(this.database)}.${mysql.escapeId(name)} TO ${this.account(this.runtimeUser)}`);
        }
        const grantSchema = mode === 0 ? this.database.replaceAll("_", "\\_").replaceAll("%", "\\%") : this.database;
        await conn.exec(`GRANT TRIGGER ON ${mysql.escapeId(grantSchema)}.* TO ${this.account(this.definerUser)}`);
        const afterMode = await conn.rows("SELECT @@GLOBAL.partial_revokes AS partial_revokes");
        if (afterMode.length !== 1 || afterMode[0]?.partial_revokes !== mode) throw Error("blob_runtime_fixture_identity");
        await conn.exec(`GRANT SHOW_ROUTINE ON *.* TO ${this.account(this.runtimeUser)}`);
        const schemaMetadata = { metadataSchema: this.metadataSchema, trustedDefiner: { user: this.definerUser, host: this.host } };
        await MysqlSessionStore.runSchemaOperation({ url: databaseUrl(base, this.database), operation: "install-metadata", schemaMetadata,
          migrationsDir: MIGRATIONS_DIR, fleetStoppedAck: "all-application-writers-stopped-v1", operationAbortSignal: this.signal });
        const procedure = buildSchemaMetadataProcedure(this.database, this.metadataSchema);
        for (const user of [this.runtimeUser, this.definerUser]) await conn.exec(`GRANT EXECUTE ON PROCEDURE ${mysql.escapeId(this.metadataSchema)}.${mysql.escapeId(procedure.routineName)} TO ${this.account(user)}`);
        // No old ordinary runtime was issued, no canonical session exists, and the actual initial
        // product transaction verifies this inactive source and the same private fixed command.
        await activateCurrentSchemaFixtureAuthority({ operatorUrl: databaseUrl(base, this.database), database: this.database,
          serverUuid: this.uuid, schemaMetadata, runtimeAccount: { user: this.runtimeUser, host: this.host }, signal: this.signal });
        const bindings = await conn.rows("SELECT current_binding_id FROM session_authority_control WHERE control_id=1");
        this.bindingId = String(bindings[0]?.current_binding_id);
        if (bindings.length !== 1 || !/^[a-f0-9-]{36}$/.test(this.bindingId)) throw Error("blob_runtime_fixture_identity");
        const runtime = new URL(databaseUrl(base, this.database)); runtime.username = this.runtimeUser; runtime.password = this.password;
        this.options = { url: runtime.toString(), migrationMode: "verify", schemaMetadata, operationAbortSignal: this.signal };
        this.active(); this.ready = true;
      })());
    }
    openStore(): Promise<MysqlSessionStore> {
      if (!this.ready || !this.options || this.closing) return Promise.reject(Error("blob_runtime_fixture_not_ready"));
      this.active();
      return this.own(MysqlSessionStore.connect(this.options).then(store => { this.stores.add(store); return store; }));
    }
    close(successful: boolean): Promise<void> {
      if (this.closing) return this.closing;
      return this.closing = (async () => {
        let failure: { reason: unknown } | undefined;
        const attempt = async (work: () => Promise<unknown>) => { try { await work(); } catch (reason) { failure ??= { reason }; } };
        while (this.pending.size) await Promise.allSettled([...this.pending]);
        for (const store of this.stores) await attempt(() => store.close());
        if (successful && (!this.ready || this.signal.aborted)) failure ??= { reason: Error("blob_runtime_fixture_not_settled") };
      const clean = successful && this.ready && !this.signal.aborted && !failure;
        try {
          if (clean) {
            const conn = this.operator!;
            const identity = await conn.rows("SELECT @@server_uuid AS uuid,DATABASE() AS db,CONNECTION_ID() AS id,@@SESSION.autocommit AS autocommit");
            const operatorId: unknown = identity[0]?.id;
            if (identity.length !== 1 || String(identity[0]?.uuid).toLowerCase() !== this.uuid || identity[0]?.db !== this.database
              || identity[0]?.autocommit !== 1 || typeof operatorId !== "number" || !Number.isSafeInteger(operatorId) || operatorId < 1) throw Error("blob_runtime_fixture_identity");
            const metadata = await conn.rows("SELECT DEFAULT_CHARACTER_SET_NAME AS charset,DEFAULT_COLLATION_NAME AS collation FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", [this.metadataSchema]);
            if (metadata.length !== 1 || metadata[0]?.charset !== "utf8mb4" || metadata[0]?.collation !== "utf8mb4_0900_ai_ci") throw Error("blob_runtime_fixture_identity");
            const routines = await conn.rows("SELECT ROUTINE_NAME,DEFINER,SECURITY_TYPE,ROUTINE_TYPE FROM information_schema.ROUTINES WHERE BINARY ROUTINE_SCHEMA=BINARY ?", [this.metadataSchema]);
            if (routines.length !== 1 || routines[0]?.ROUTINE_NAME !== buildSchemaMetadataProcedure(this.database, this.metadataSchema).routineName
              || routines[0]?.DEFINER !== `${this.definerUser}@${this.host}` || routines[0]?.SECURITY_TYPE !== "DEFINER" || routines[0]?.ROUTINE_TYPE !== "PROCEDURE") throw Error("blob_runtime_fixture_identity");
            const bindings = await conn.rows("SELECT current_binding_id FROM session_authority_control WHERE control_id=1");
            const members = await conn.rows("SELECT binding_id,account_user,account_host FROM session_authority_runtime_accounts");
            if (bindings.length !== 1 || bindings[0]?.current_binding_id !== this.bindingId || members.length !== 1
              || members[0]?.binding_id !== this.bindingId || members[0]?.account_user !== this.runtimeUser || members[0]?.account_host !== this.host) throw Error("blob_runtime_fixture_identity");
            for (const user of [this.runtimeUser, this.definerUser]) {
              const users = await conn.rows("SELECT User,Host,account_locked FROM mysql.user WHERE BINARY User=BINARY ?", [user]);
              if (users.length !== 1 || users[0]?.User !== user || users[0]?.Host !== this.host
                || users[0]?.account_locked !== (user === this.definerUser ? "Y" : "N")) throw Error("blob_runtime_fixture_identity");
              if ((await conn.rows("SELECT PROCESSLIST_ID FROM performance_schema.threads WHERE TYPE='FOREGROUND' AND BINARY PROCESSLIST_USER=BINARY ?", [user])).length) throw Error("blob_runtime_fixture_native_live");
            }
            for (const schema of [this.database, this.metadataSchema]) {
              const clients = await conn.rows("SELECT ID FROM information_schema.PROCESSLIST WHERE BINARY DB=BINARY ? AND ID<>?", [schema, identity[0]!.id]);
              const tx = await conn.rows("SELECT t.trx_id FROM information_schema.INNODB_TRX t JOIN information_schema.PROCESSLIST p ON p.ID=t.trx_mysql_thread_id WHERE BINARY p.DB=BINARY ? AND p.ID<>?", [schema, operatorId]);
              if (clients.length || tx.length) throw Error("blob_runtime_fixture_native_live");
            }
            await conn.exec(`DROP DATABASE ${mysql.escapeId(this.metadataSchema)}`);
            if ((await conn.rows("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", [this.metadataSchema])).length) throw Error("blob_runtime_fixture_cleanup");
            for (const user of [this.runtimeUser, this.definerUser]) {
              await conn.exec(`DROP USER ${this.account(user)}`);
              if ((await conn.rows("SELECT User FROM mysql.user WHERE BINARY User=BINARY ?", [user])).length) throw Error("blob_runtime_fixture_cleanup");
            }
          }
        } catch (reason) { failure ??= { reason }; }
        finally {
          for (const owner of this.owners) await attempt(() => owner.close());
          if (!clean || failure) {
            try { console.warn(JSON.stringify({ schema: "blob-migration-current-profile-retained-v1", applicationDatabase: this.database,
              metadataSchema: this.metadataAttempted ? this.metadataSchema : null, accounts: [...this.accountAttempts], status: "retained_or_unknown" })); }
            catch (reason) { failure ??= { reason }; }
          }
        }
        if (failure) throw failure.reason;
      })();
    }
  }

  async function finishBlobRuntimeCase(profile: ExistingBlobControlRuntime, signal: AbortSignal, successful: boolean,
    failure: { reason: unknown } | undefined, closeConsumers: readonly (() => Promise<unknown>)[], cleanup: () => Promise<void>): Promise<void> {
    for (const close of closeConsumers) try { await close(); } catch (reason) { failure ??= { reason }; }
    const clean = successful && !failure;
    try { await profile.close(clean); } catch (reason) { failure ??= { reason }; }
    if (clean && !failure) try { signal.throwIfAborted(); await cleanup(); } catch (reason) { failure ??= { reason }; }
    if (failure) throw failure.reason;
  }

  async function expectInstalled(conn: Connection): Promise<void> {
    const [markers] = await conn.query<Row[]>(
      "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?",
      [MIGRATION_NAME],
    );
    expect(Number(markers[0]!.count)).toBe(1);
    const [tables] = await conn.query<Row[]>(
      `SELECT COUNT(*) AS count FROM information_schema.tables
        WHERE table_schema=DATABASE() AND table_name LIKE 'blob_storage_migration\\_%'`,
    );
    expect(Number(tables[0]!.count)).toBe(7);
    const [columns] = await conn.query<Row[]>(
      `SELECT COUNT(*) AS count FROM information_schema.columns
        WHERE table_schema=DATABASE() AND table_name LIKE 'blob_storage_migration\\_%'`,
    );
    expect(Number(columns[0]!.count)).toBe(117);
    const [checks] = await conn.query<Row[]>(
      `SELECT COUNT(*) AS count FROM information_schema.table_constraints
        WHERE table_schema=DATABASE() AND constraint_type='CHECK'
          AND table_name LIKE 'blob_storage_migration\\_%'`,
    );
    expect(Number(checks[0]!.count)).toBe(13);
    const [triggers] = await conn.query<Row[]>(
      `SELECT COUNT(*) AS count FROM information_schema.triggers
        WHERE trigger_schema=DATABASE() AND (
          trigger_name LIKE 'trg_blob_mover\\_%'
          OR trigger_name IN (
            'trg_blob_storage_object_bu_guard_a','trg_blob_storage_object_bu',
            'trg_blob_storage_export_artifact_bu_guard_a','trg_blob_storage_export_artifact_bu',
            'trg_blob_storage_export_part_bu_guard_a','trg_blob_storage_export_part_bu',
            'trg_blob_storage_snapshot_bu_guard_a','trg_blob_storage_snapshot_bu',
            'trg_blob_storage_export_outbox_bu_guard_a','trg_blob_storage_export_outbox_bu',
            'trg_blob_storage_control_bu_bootstrap','trg_blob_storage_control_bu',
            'trg_blob_storage_control_bu_guard_a'))`,
    );
    expect(Number(triggers[0]!.count)).toBe(89);
    const [blobControlTriggers] = await conn.query<Row[]>(
      `SELECT trigger_name,action_statement FROM information_schema.triggers
        WHERE trigger_schema=DATABASE()
          AND trigger_name IN ('trg_blob_storage_control_bu_bootstrap',
            'trg_blob_storage_control_bu','trg_blob_storage_control_bu_guard_a')
        ORDER BY trigger_name`,
    );
    expect(blobControlTriggers).toHaveLength(3);
    for (const row of blobControlTriggers) {
      const body = String(row.action_statement ?? row.ACTION_STATEMENT)
        .toLowerCase().replaceAll("_utf8mb4", "").replace(/\s+/g, "");
      expect(body).toContain("m.phase='cutting_over'");
      expect(body).toContain("m.phasein('inactive','aborted')");
      expect(body).toContain("blob_storage_migration_receipts");
      expect(body).toContain("blob_storage_migration_target_cleanup_acks");
    }
    const [controlTriggers] = await conn.query<Row[]>(
      `SELECT trigger_name,action_order,action_statement
         FROM information_schema.triggers
        WHERE trigger_schema=DATABASE()
          AND trigger_name IN ('trg_blob_mover_control_receipt_visibility_bu',
            'trg_blob_mover_control_bu_invariants',
            'trg_blob_mover_control_bu','trg_blob_mover_control_bu_guard_a')
        ORDER BY action_order`,
    );
    expect(controlTriggers.map((row) => [
      row.trigger_name ?? row.TRIGGER_NAME,
      Number(row.action_order ?? row.ACTION_ORDER),
    ])).toEqual([
      ["trg_blob_mover_control_receipt_visibility_bu", 1],
      ["trg_blob_mover_control_bu_invariants", 2],
      ["trg_blob_mover_control_bu", 3],
      ["trg_blob_mover_control_bu_guard_a", 4],
    ]);
    const normalizedControlBodies = controlTriggers.map((row) => String(
      row.action_statement ?? row.ACTION_STATEMENT,
    )
      .toLowerCase().replaceAll("_utf8mb4", "").replace(/\s+/g, ""));
    expect(normalizedControlBodies[0]).toContain("forshare");
    expect(normalizedControlBodies[1]).toContain(
      "r.receipt_kind='source_cleaned'andbinaryr.receipt_sha256=binarynew.terminal_receipt_sha256"
      + "andr.source_cleanup_ack_count=new.source_cleanup_ack_count"
      + "andbinaryr.source_cleanup_ack_root_sha256=binarynew.source_cleanup_ack_root_sha256",
    );
    expect(normalizedControlBodies[2]).not.toContain("r.receipt_kind='source_cleaned'");
    expect(normalizedControlBodies[3]).not.toContain("r.receipt_kind='source_cleaned'");
    const [inventoryTriggers] = await conn.query<Row[]>(
      `SELECT trigger_name,action_statement
         FROM information_schema.triggers
        WHERE trigger_schema=DATABASE()
          AND trigger_name IN ('trg_blob_mover_inventory_bi_guard_a','trg_blob_mover_inventory_bi')
        ORDER BY trigger_name`,
    );
    expect(inventoryTriggers).toHaveLength(2);
    for (const row of inventoryTriggers) {
      const body = String(row.action_statement ?? row.ACTION_STATEMENT)
        .toLowerCase().replaceAll("_utf8mb4", "").replace(/\s+/g, "");
      expect(body).toContain(
        "b.state='staging'andb.sha256isnullandb.size_bytesisnull"
        + "andb.content_typeisnullandb.uploaded_at_msisnullandb.ready_at_msisnull"
        + "andb.delete_after_msisnullandb.deleted_at_msisnull",
      );
      expect(body).toContain(
        "p.state='staging'andp.sha256isnullandp.size_bytesisnull"
        + "andp.content_typeisnullandp.record_countisnullandp.uploaded_at_msisnull"
        + "andp.delete_after_msisnullandp.deleted_at_msisnull",
      );
      expect(body.match(/new\.object_disposition='data'andnew\.expected_sha256regexp/g))
        .toHaveLength(2);
    }
  }

  it("upgrades a frozen 0027 database default-dormant without rewriting legacy pointers", async ({ signal }) => {
    const database = databaseName();
    await create0027(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await seedStagingBlob(conn, "preserved-0027");
      const [before] = await conn.query<Row[]>(
        "SELECT blob_id,storage_backend,storage_key,state FROM blob_objects",
      );
      await migrateCurrent(database, signal);
      await expectInstalled(conn);
      const [control] = await conn.query<Row[]>(
        `SELECT control_generation,phase,migration_id,evidence_sha256
           FROM blob_storage_migration_control WHERE singleton_id=1`,
      );
      expect(control[0]).toMatchObject({
        control_generation: 0,
        phase: "inactive",
        migration_id: null,
        evidence_sha256: null,
      });
      const [after] = await conn.query<Row[]>(
        "SELECT blob_id,storage_backend,storage_key,state FROM blob_objects",
      );
      expect(plainRows(after)).toEqual(plainRows(before));
      for (const table of [
        "blob_storage_migration_inventory",
        "blob_storage_migration_object_acks",
        "blob_storage_migration_events",
        "blob_storage_migration_receipts",
        "blob_storage_migration_source_cleanup_acks",
        "blob_storage_migration_target_cleanup_acks",
      ]) {
        const [rows] = await conn.query<Row[]>(`SELECT COUNT(*) AS count FROM ${table}`);
        expect(Number(rows[0]!.count), table).toBe(0);
      }
    } finally {
      await conn.end();
      await cleanup(database);
    }
  });

  it("serializes mutating coordinators while allowing status readers and releases the DB lock", async ({ signal }) => {
    const database = databaseName();
    await create0027(database);
    let operator: MysqlBlobStorageMigrationCoordinator | undefined;
    let reader: MysqlBlobStorageMigrationCoordinator | undefined;
    let successor: MysqlBlobStorageMigrationCoordinator | undefined;
    try {
      await migrateCurrent(database, signal);
      operator = await MysqlBlobStorageMigrationCoordinator.connect({
        url: databaseUrl(base, database),
      });
      await expect(MysqlBlobStorageMigrationCoordinator.connect({
        url: databaseUrl(base, database),
      })).rejects.toThrow(/another blob migration operator is active/);
      reader = await MysqlBlobStorageMigrationCoordinator.connect({
        url: databaseUrl(base, database),
        connectionLimit: 1,
        exclusive: false,
      });
      expect((await reader.getControl()).phase).toBe("inactive");
      await expect(reader.freeze({
        migrationId: "move-reader-rejected",
        expectedControlGeneration: 0,
        sourceBackend: "filesystem-v1",
        sourceNamespaceSha256: "1".repeat(64),
        targetBackend: targetBackend("2".repeat(64)),
        targetNamespaceSha256: "2".repeat(64),
        rollbackWindowMs: 0,
        sourceCleanupDelayMs: 0,
        fleetDrainedEvidenceSha256: FLEET_EVIDENCE,
      })).rejects.toThrow(/mutation requires the exclusive operator lock/);
      await reader.close();
      reader = undefined;
      await operator.close();
      operator = undefined;
      successor = await MysqlBlobStorageMigrationCoordinator.connect({
        url: databaseUrl(base, database),
      });
      expect((await successor.getControl()).phase).toBe("inactive");
    } finally {
      await successor?.close();
      await reader?.close();
      await operator?.close();
      await cleanup(database);
    }
  });

  it("seals published final bytes for staging blob and export-part crash windows", async ({ signal }) => {
    const database = databaseName();
    await create0027(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    let coordinator: MysqlBlobStorageMigrationCoordinator | undefined;
    let stores: StoreFixture | undefined;
    try {
      stores = await createStores("staging-published");
      await seedStagingBlob(conn, "staging-published-blob");
      await seedStagingExportPart(conn, "staging-published-part");
      const blobDescriptor = await stores.source.putIfAbsent(
        "objects/staging-published-blob",
        "published blob bytes",
        {
          uploadToken: "upload-staging-published-blob",
          maxBytes: MAX_BYTES,
          contentType: "image/png",
        },
      );
      const partDescriptor = await stores.source.putIfAbsent(
        "exports/staging-published-part",
        "published export part bytes",
        {
          uploadToken: "export-upload-staging-published-part",
          maxBytes: MAX_BYTES,
          contentType: "application/x-ndjson",
        },
      );
      await migrateCurrent(database, signal);
      coordinator = await MysqlBlobStorageMigrationCoordinator.connect({
        url: databaseUrl(base, database),
      });
      const sealed = await coordinator.prepare(
        stores.source,
        stores.target,
        migrationInput(stores, "move-staging-published"),
        MAX_BYTES,
      );
      expect(sealed.phase).toBe("inventory_sealed");
      const [inventory] = await conn.query<Row[]>(
        `SELECT record_kind,record_id,record_sub_id,record_aux_id,storage_key,
                object_disposition,expected_sha256,expected_size_bytes,expected_content_type
           FROM blob_storage_migration_inventory
          WHERE migration_id='move-staging-published' ORDER BY entry_ordinal`,
      );
      expect(plainRows(inventory)).toEqual([
        {
          record_kind: "blob_object",
          record_id: "blob-staging-published-blob",
          record_sub_id: 0,
          record_aux_id: 0,
          storage_key: "objects/staging-published-blob",
          object_disposition: "data",
          expected_sha256: blobDescriptor.sha256,
          expected_size_bytes: blobDescriptor.sizeBytes,
          expected_content_type: blobDescriptor.contentType,
        },
        {
          record_kind: "export_part",
          record_id: "artifact-staging-published-part",
          record_sub_id: 0,
          record_aux_id: 1,
          storage_key: "exports/staging-published-part",
          object_disposition: "data",
          expected_sha256: partDescriptor.sha256,
          expected_size_bytes: partDescriptor.sizeBytes,
          expected_content_type: partDescriptor.contentType,
        },
      ]);
      const [sourceRows] = await conn.query<Row[]>(
        `SELECT state,sha256,size_bytes,content_type,uploaded_at_ms FROM blob_objects
          WHERE blob_id='blob-staging-published-blob'
         UNION ALL
         SELECT state,sha256,size_bytes,content_type,uploaded_at_ms
           FROM user_export_artifact_parts
          WHERE artifact_id='artifact-staging-published-part' AND part_number=0`,
      );
      expect(plainRows(sourceRows)).toEqual([
        { state: "staging", sha256: null, size_bytes: null, content_type: null, uploaded_at_ms: null },
        { state: "staging", sha256: null, size_bytes: null, content_type: null, uploaded_at_ms: null },
      ]);
    } finally {
      await coordinator?.close();
      await conn.end();
      await cleanupStores(stores);
      await cleanup(database);
    }
  });

  it("preserves non-terminal evidence during marker-loss replay", async ({ signal }) => {
    const database = databaseName();
    await create0027(database);
    let coordinator: MysqlBlobStorageMigrationCoordinator | undefined;
    let stores: StoreFixture | undefined;
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await migrateCurrent(database, signal);
      stores = await createStores("replay");
      await seedStagingBlob(conn, "replay");
      coordinator = await MysqlBlobStorageMigrationCoordinator.connect({
        url: databaseUrl(base, database),
      });
      const sealed = await coordinator.prepare(
        stores.source,
        stores.target,
        migrationInput(stores, "move-replay"),
        MAX_BYTES,
      );
      expect(sealed.phase).toBe("inventory_sealed");
      await coordinator.close();
      coordinator = undefined;
      const [controlBefore] = await conn.query<Row[]>("SELECT * FROM blob_storage_migration_control");
      const [inventoryBefore] = await conn.query<Row[]>(
        "SELECT * FROM blob_storage_migration_inventory ORDER BY entry_ordinal",
      );
      const [eventsBefore] = await conn.query<Row[]>(
        "SELECT * FROM blob_storage_migration_events ORDER BY event_seq",
      );
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await migrateCurrent(database, signal);
      await expectInstalled(conn);
      const [controlAfter] = await conn.query<Row[]>("SELECT * FROM blob_storage_migration_control");
      const [inventoryAfter] = await conn.query<Row[]>(
        "SELECT * FROM blob_storage_migration_inventory ORDER BY entry_ordinal",
      );
      const [eventsAfter] = await conn.query<Row[]>(
        "SELECT * FROM blob_storage_migration_events ORDER BY event_seq",
      );
      expect(plainRows(controlAfter)).toEqual(plainRows(controlBefore));
      expect(plainRows(inventoryAfter)).toEqual(plainRows(inventoryBefore));
      expect(plainRows(eventsAfter)).toEqual(plainRows(eventsBefore));
    } finally {
      await coordinator?.close();
      await conn.end();
      await cleanupStores(stores);
      await cleanup(database);
    }
  });

  // Each boundary seeds an independent old database and upgrades the complete current tail.
  // Give each proof the unchanged per-test deadline instead of sharing it across three upgrades.
  it.for([
    { boundary: "first", createCount: 1 },
    { boundary: "middle", createCount: 4 },
    { boundary: "last", createCount: 7 },
  ])("converges from the $boundary CREATE TABLE auto-commit boundary", async ({ createCount: boundary }, { signal }) => {
    const database = databaseName();
    await create0027(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      for (const statement of createTableStatements.slice(0, boundary)) {
        await conn.query(statement);
      }
      const [before] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?",
        [MIGRATION_NAME],
      );
      expect(Number(before[0]!.count), `boundary ${boundary}`).toBe(0);
      await migrateCurrent(database, signal);
      await expectInstalled(conn);
    } finally {
      await conn.end();
      await cleanup(database);
    }
  });

  it("rejects a weaker same-name table without recording the marker", async ({ signal }) => {
    const database = databaseName();
    await create0027(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      const weakControl = createTableStatements[0]!.replace(
        "inventory_entry_count      BIGINT UNSIGNED NOT NULL DEFAULT 0",
        "inventory_entry_count      BIGINT NOT NULL DEFAULT 0",
      );
      expect(weakControl).not.toBe(createTableStatements[0]);
      await conn.query(weakControl);
      await expect(migrateCurrent(database, signal))
        .rejects.toThrow(/migration 0028_blob_storage_migration\.sql failed/);
      const [markers] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?",
        [MIGRATION_NAME],
      );
      expect(Number(markers[0]!.count)).toBe(0);
    } finally {
      await conn.end();
      await cleanup(database);
    }
  });

  it("repairs missing or changed owned triggers during marker-loss replay", async ({ signal }) => {
    const database = databaseName();
    await create0027(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await migrateCurrent(database, signal);
      await conn.query("DROP TRIGGER trg_blob_mover_inventory_bu");
      await conn.query("DROP TRIGGER trg_blob_mover_inventory_bd");
      await conn.query(
        `CREATE TRIGGER trg_blob_mover_inventory_bd BEFORE DELETE
           ON blob_storage_migration_inventory FOR EACH ROW
           SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='weaker drifted trigger'`,
      );
      await conn.query("DROP TRIGGER trg_blob_storage_control_bu_guard_a");
      await conn.query(
        `CREATE TRIGGER trg_blob_storage_control_bu_guard_a BEFORE UPDATE
           ON blob_storage_control FOR EACH ROW SET @weaker_blob_control_guard=1`,
      );
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await migrateCurrent(database, signal);
      await expectInstalled(conn);
      const [triggers] = await conn.query<Row[]>(
        `SELECT trigger_name FROM information_schema.triggers
          WHERE trigger_schema=DATABASE()
            AND trigger_name IN ('trg_blob_mover_inventory_bu','trg_blob_mover_inventory_bd')
            AND action_statement LIKE '%blob migration inventory is append-only%'
          ORDER BY trigger_name`,
      );
      expect(triggers).toHaveLength(2);
    } finally {
      await conn.end();
      await cleanup(database);
    }
  });

  it("rejects an extra migration-owned trigger during marker-loss replay", async ({ signal }) => {
    const database = databaseName();
    await create0027(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await migrateCurrent(database, signal);
      await conn.query(
        `CREATE TRIGGER trg_blob_mover_unexpected_extra BEFORE INSERT
           ON blob_storage_migration_events FOR EACH ROW SET @unexpected_blob_mover_trigger=1`,
      );
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await expect(migrateCurrent(database, signal))
        .rejects.toThrow(/migration 0028_blob_storage_migration\.sql failed/);
      const [markers] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?",
        [MIGRATION_NAME],
      );
      expect(Number(markers[0]!.count)).toBe(0);
    } finally {
      await conn.end();
      await cleanup(database);
    }
  });

  it("freezes runtime writes and cannot be bypassed with connection variables", async ({ signal }) => {
    const database = databaseName();
    await create0027(database);
    let coordinator: MysqlBlobStorageMigrationCoordinator | undefined;
    let stores: StoreFixture | undefined;
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await migrateCurrent(database, signal);
      stores = await createStores("freeze");
      await seedStagingBlob(conn, "freeze");
      coordinator = await MysqlBlobStorageMigrationCoordinator.connect({
        url: databaseUrl(base, database),
      });
      const frozen = await coordinator.freeze(migrationInput(stores, "move-freeze"));
      expect(frozen.phase).toBe("frozen");
      await conn.query(
        "SET @blob_storage_migration_authorized=1,@blob_storage_cutover_authorized=1,@allow_blob_migration=1",
      );
      await expect(conn.query(
        "UPDATE blob_objects SET storage_backend=? WHERE blob_id='blob-freeze'",
        [stores.targetBackend],
      )).rejects.toThrow(/blob migration freeze rejects blob update/);
      await expect(seedStagingBlob(conn, "freeze-late"))
        .rejects.toThrow(/blob migration freeze rejects blob insert/);
      const [row] = await conn.query<Row[]>(
        "SELECT storage_backend,state FROM blob_objects WHERE blob_id='blob-freeze'",
      );
      expect(row[0]).toMatchObject({ storage_backend: "filesystem-v1", state: "staging" });
    } finally {
      await coordinator?.close();
      await conn.end();
      await cleanupStores(stores);
      await cleanup(database);
    }
  });

  it("serializes an empty freeze against ordinary activation without publishing split control", async ({ signal }) => {
    const database = databaseName();
    await create0027(database);
    let store: MysqlSessionStore | undefined;
    let coordinator: MysqlBlobStorageMigrationCoordinator | undefined;
    let stores: StoreFixture | undefined;
    const conn = await mysql.createConnection(databaseUrl(base, database));
    const profile = new ExistingBlobControlRuntime(database, signal);
    let successful = false;
    let failure: { reason: unknown } | undefined;
    try {
      await migrateCurrent(database, signal);
      await profile.prepare();
      store = await profile.openStore();
      stores = await createStores("activation-race");
      coordinator = await MysqlBlobStorageMigrationCoordinator.connect({
        url: databaseUrl(base, database),
      });
      const [freezeResult, activationResult] = await Promise.allSettled([
        coordinator.freeze(migrationInput(stores, "move-activation-race")),
        store.activateBlobStorageControl({
          expectedControlGeneration: 0,
          storageBackend: stores.targetBackend,
          namespaceSha256: stores.targetNamespaceSha256,
        }),
      ]);
      expect([freezeResult.status, activationResult.status].sort())
        .toEqual(["fulfilled", "rejected"]);

      const [rows] = await conn.query<Row[]>(
        `SELECT m.phase,b.control_generation
           FROM blob_storage_migration_control m
           JOIN blob_storage_control b ON b.singleton_id=1
          WHERE m.singleton_id=1`,
      );
      expect([
        String(rows[0]!.phase),
        Number(rows[0]!.control_generation),
      ]).toEqual(freezeResult.status === "fulfilled" ? ["frozen", 0] : ["inactive", 1]);
      successful = true;
    } catch (reason) { failure = { reason }; }
    finally {
      await finishBlobRuntimeCase(profile, signal, successful, failure, [
        () => coordinator?.close() ?? Promise.resolve(),
        () => store?.close() ?? Promise.resolve(),
        () => conn.end(),
        () => cleanupStores(stores),
      ], () => cleanup(database));
    }
  });

  it("blocks empty frozen activation and permanently fences an aborted target namespace", async ({ signal }) => {
    const database = databaseName();
    await create0027(database);
    let store: MysqlSessionStore | undefined;
    let coordinator: MysqlBlobStorageMigrationCoordinator | undefined;
    let stores: StoreFixture | undefined;
    let freshStores: StoreFixture | undefined;
    const conn = await mysql.createConnection(databaseUrl(base, database));
    const profile = new ExistingBlobControlRuntime(database, signal);
    let successful = false;
    let failure: { reason: unknown } | undefined;
    try {
      await migrateCurrent(database, signal);
      await profile.prepare();
      store = await profile.openStore();
      stores = await createStores("activation-fence");
      coordinator = await MysqlBlobStorageMigrationCoordinator.connect({
        url: databaseUrl(base, database),
      });
      await coordinator.freeze(migrationInput(stores, "move-activation-fence"));
      const attemptedActivation = {
        expectedControlGeneration: 0 as const,
        storageBackend: stores.targetBackend,
        namespaceSha256: stores.targetNamespaceSha256,
      };
      await expect(store.activateBlobStorageControl(attemptedActivation))
        .rejects.toBeInstanceOf(BlobStorageControlConflictError);
      await expect(conn.query(
        `UPDATE blob_storage_control
            SET control_generation=1,storage_backend=?,namespace_sha256=?,
                activated_at_db_ms=1,evidence_sha256=?
          WHERE singleton_id=1`,
        [stores.targetBackend, stores.targetNamespaceSha256, "a".repeat(64)],
      )).rejects.toThrow(/write-once|inventory conflicts/);

      const aborted = await coordinator.abort(stores.target, MAX_BYTES);
      expect(aborted.phase).toBe("aborted");
      await expect(store.activateBlobStorageControl(attemptedActivation))
        .rejects.toBeInstanceOf(BlobStorageControlConflictError);
      await expect(conn.query(
        `UPDATE blob_storage_control
            SET control_generation=1,storage_backend=?,namespace_sha256=?,
                activated_at_db_ms=1,evidence_sha256=?
          WHERE singleton_id=1`,
        [stores.targetBackend, stores.targetNamespaceSha256, "b".repeat(64)],
      )).rejects.toThrow(/write-once|inventory conflicts/);

      freshStores = await createStores("activation-fresh");
      await expect(store.activateBlobStorageControl({
        expectedControlGeneration: 0,
        storageBackend: freshStores.targetBackend,
        namespaceSha256: freshStores.targetNamespaceSha256,
      })).resolves.toMatchObject({
        controlGeneration: 1,
        storageBackend: freshStores.targetBackend,
        namespaceSha256: freshStores.targetNamespaceSha256,
      });
      successful = true;
    } catch (reason) { failure = { reason }; }
    finally {
      await finishBlobRuntimeCase(profile, signal, successful, failure, [
        () => coordinator?.close() ?? Promise.resolve(),
        () => store?.close() ?? Promise.resolve(),
        () => conn.end(),
        () => cleanupStores(stores),
        () => cleanupStores(freshStores),
      ], () => cleanup(database));
    }
  });

  it("rolls back an injected cutover failure, rejects mismatched ACKs, then commits and cleans", async ({ signal }) => {
    const database = databaseName();
    await create0027(database);
    let runtimeStore: MysqlSessionStore | undefined;
    let coordinator: MysqlBlobStorageMigrationCoordinator | undefined;
    let stores: StoreFixture | undefined;
    const conn = await mysql.createConnection(databaseUrl(base, database));
    const profile = new ExistingBlobControlRuntime(database, signal);
    let successful = false;
    let failure: { reason: unknown } | undefined;
    try {
      await migrateCurrent(database, signal);
      await profile.prepare();
      stores = await createStores("cutover");
      await seedReadyBlob(conn, stores.source, "cutover");
      coordinator = await MysqlBlobStorageMigrationCoordinator.connect({
        url: databaseUrl(base, database),
      });
      await coordinator.prepare(
        stores.source,
        stores.target,
        migrationInput(stores, "move-cutover"),
        MAX_BYTES,
      );
      await coordinator.copy(stores.source, stores.target, MAX_BYTES);
      const [ackRows] = await conn.query<Row[]>(
        "SELECT * FROM blob_storage_migration_object_acks WHERE migration_id='move-cutover'",
      );
      const ack = ackRows[0]!;
      await expect(conn.query(
        `INSERT INTO blob_storage_migration_object_acks
           (migration_id,storage_key,object_disposition,target_backend,target_namespace_sha256,
            expected_sha256,expected_size_bytes,expected_content_type,source_observed_kind,
            target_observed_kind,source_descriptor_sha256,target_descriptor_sha256,
            verified_at_db_ms,ack_sha256)
         VALUES (?,?,?,?,?,?,?,'application/json',?,?,?,?,?,?)`,
        [
          ack.migration_id,
          ack.storage_key,
          ack.object_disposition,
          ack.target_backend,
          ack.target_namespace_sha256,
          ack.expected_sha256,
          ack.expected_size_bytes,
          ack.source_observed_kind,
          ack.target_observed_kind,
          ack.source_descriptor_sha256,
          ack.target_descriptor_sha256,
          ack.verified_at_db_ms,
          "0".repeat(64),
        ],
      )).rejects.toThrow(/blob migration object ack is not inventory-bound/);
      await coordinator.verify(stores.source, stores.target, MAX_BYTES);

      await conn.query(
        `CREATE TRIGGER test_blob_migration_cutover_failure BEFORE UPDATE
           ON blob_storage_control FOR EACH ROW
           BEGIN
             IF OLD.control_generation=0 AND NEW.control_generation=1 THEN
               SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected cutover failure';
             END IF;
           END`,
      );
      await expect(coordinator.cutover(stores.source, stores.target, MAX_BYTES))
        .rejects.toThrow(/injected cutover failure/);
      const [rolledBack] = await conn.query<Row[]>(
        `SELECT m.phase,b.control_generation,o.storage_backend,
                (SELECT COUNT(*) FROM blob_storage_migration_receipts
                  WHERE receipt_kind='committed') AS committed_receipts
           FROM blob_storage_migration_control m
           JOIN blob_storage_control b ON b.singleton_id=1
           JOIN blob_objects o ON o.blob_id='blob-cutover'
          WHERE m.singleton_id=1`,
      );
      expect(rolledBack[0]).toMatchObject({
        phase: "verified",
        control_generation: 0,
        storage_backend: "filesystem-v1",
        committed_receipts: 0,
      });
      await conn.query("DROP TRIGGER test_blob_migration_cutover_failure");

      const committed = await coordinator.cutover(stores.source, stores.target, MAX_BYTES);
      expect(committed.phase).toBe("committed");
      const [cutover] = await conn.query<Row[]>(
        `SELECT m.phase,b.control_generation,b.storage_backend AS active_backend,
                o.storage_backend AS object_backend
           FROM blob_storage_migration_control m
           JOIN blob_storage_control b ON b.singleton_id=1
           JOIN blob_objects o ON o.blob_id='blob-cutover'
          WHERE m.singleton_id=1`,
      );
      expect(cutover[0]).toMatchObject({
        phase: "committed",
        control_generation: 1,
        active_backend: stores.targetBackend,
        object_backend: stores.targetBackend,
      });
      runtimeStore = await profile.openStore();
      const exactActivation = {
        expectedControlGeneration: 0 as const,
        storageBackend: stores.targetBackend,
        namespaceSha256: stores.targetNamespaceSha256,
      };
      await expect(runtimeStore.activateBlobStorageControl(exactActivation))
        .rejects.toBeInstanceOf(BlobStorageControlConflictError);
      const cleaned = await coordinator.cleanupSource(stores.source, stores.target, MAX_BYTES);
      expect(cleaned.phase).toBe("source_cleaned");
      expect(await coordinator.cleanupSource(stores.source, stores.target, MAX_BYTES)).toEqual(cleaned);
      await expect(runtimeStore.activateBlobStorageControl(exactActivation)).resolves.toMatchObject({
        controlGeneration: 1,
        storageBackend: stores.targetBackend,
        namespaceSha256: stores.targetNamespaceSha256,
      });
      const [receipts] = await conn.query<Row[]>(
        `SELECT receipt_kind,blob_control_evidence_sha256
           FROM blob_storage_migration_receipts ORDER BY receipt_kind`,
      );
      expect(receipts.map((row) => row.receipt_kind)).toEqual(["committed", "source_cleaned"]);
      expect(String(receipts[1]!.blob_control_evidence_sha256)).toMatch(/^[0-9a-f]{64}$/);
      successful = true;
    } catch (reason) { failure = { reason }; }
    finally {
      await finishBlobRuntimeCase(profile, signal, successful, failure, [
        () => conn.query("DROP TRIGGER IF EXISTS test_blob_migration_cutover_failure").catch(() => undefined),
        () => coordinator?.close() ?? Promise.resolve(),
        () => runtimeStore?.close() ?? Promise.resolve(),
        () => conn.end(),
        () => cleanupStores(stores),
      ], () => cleanup(database));
    }
  }, 60_000);

  it("fences owned partial-copy bytes, preserves foreign conflicts, and rejects namespace ABA", async ({ signal }) => {
    const database = databaseName();
    await create0027(database);
    let coordinator: MysqlBlobStorageMigrationCoordinator | undefined;
    let stores: StoreFixture | undefined;
    let secondStores: StoreFixture | undefined;
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await migrateCurrent(database, signal);
      stores = await createStores("abort");
      await seedReadyBlob(conn, stores.source, "a-owned");
      await seedReadyBlob(conn, stores.source, "z-foreign");
      coordinator = await MysqlBlobStorageMigrationCoordinator.connect({
        url: databaseUrl(base, database),
      });
      await coordinator.prepare(
        stores.source,
        stores.target,
        migrationInput(stores, "move-abort"),
        MAX_BYTES,
      );
      await stores.target.putIfAbsent("objects/z-foreign", "payload-z-foreign", {
        uploadToken: "foreign-writer",
        maxBytes: MAX_BYTES,
        contentType: "text/plain",
      });
      await expect(coordinator.copy(stores.source, stores.target, MAX_BYTES))
        .rejects.toBeInstanceOf(BlobStorageMigrationConflictError);
      const aborted = await coordinator.abort(stores.target, MAX_BYTES);
      expect(aborted.phase).toBe("aborted");
      expect(await coordinator.abort(stores.target, MAX_BYTES)).toEqual(aborted);
      const [acks] = await conn.query<Row[]>(
        `SELECT storage_key,cleanup_result,target_observed_kind,target_migration_owner_sha256
           FROM blob_storage_migration_target_cleanup_acks
          WHERE migration_id='move-abort' ORDER BY storage_key`,
      );
      expect(plainRows(acks)).toEqual([
        {
          storage_key: "objects/a-owned",
          cleanup_result: "fenced_tombstone",
          target_observed_kind: "tombstone",
          target_migration_owner_sha256: blobStorageMigrationTargetOwnerSha256(
            "move-abort",
            stores.targetNamespaceSha256,
            "objects/a-owned",
          ),
        },
        {
          storage_key: "objects/z-foreign",
          cleanup_result: "preserved_conflict",
          target_observed_kind: "data",
          target_migration_owner_sha256: null,
        },
      ]);
      expect(await stores.target.inspectExact("objects/a-owned", { maxBytes: MAX_BYTES }))
        .toMatchObject({ kind: "tombstone" });
      expect(await stores.target.inspectExact("objects/z-foreign", { maxBytes: MAX_BYTES }))
        .toMatchObject({ kind: "data" });
      secondStores = await createStores("abort-second-target");
      const secondInput: BeginBlobStorageMigrationInput = {
        ...migrationInput(secondStores, "move-abort-second", 1),
        sourceNamespaceSha256: stores.source.namespaceSha256,
      };
      const secondPrepared = await coordinator.prepare(
        stores.source,
        secondStores.target,
        secondInput,
        MAX_BYTES,
      );
      expect(secondPrepared.phase).toBe("inventory_sealed");
      const secondAborted = await coordinator.abort(secondStores.target, MAX_BYTES);
      expect(secondAborted.phase).toBe("aborted");
      await expect(coordinator.freeze({
        ...migrationInput(stores, "move-aba", 2),
      })).rejects.toBeInstanceOf(BlobStorageMigrationConflictError);
      const [control] = await conn.query<Row[]>(
        "SELECT phase,control_generation,target_namespace_sha256 FROM blob_storage_migration_control",
      );
      expect(control[0]).toMatchObject({
        phase: "aborted",
        control_generation: 2,
        target_namespace_sha256: secondStores.targetNamespaceSha256,
      });
    } finally {
      await coordinator?.close();
      await conn.end();
      await cleanupStores(stores);
      await cleanupStores(secondStores);
      await cleanup(database);
    }
  });
});
