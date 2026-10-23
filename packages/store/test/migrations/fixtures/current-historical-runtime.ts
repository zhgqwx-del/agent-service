import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, readFile, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { MysqlSessionStore } from "../../../src/index.js";
import { buildSchemaMetadataProcedure } from "../../../src/mysql/schema-metadata-codec.js";
import { OwnedRetirementConnection } from "../../fixtures/authority-retirement.js";
import { activateCurrentSchemaFixtureAuthority } from "../../fixtures/schema-current-authority.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/", import.meta.url));

/** Only the three archived-worker tests: current full-tail/public reads on an actually owned existing schema. */
export class HistoricalCurrentRuntimeProfile {
  private readonly suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  private readonly metadataSchema = `agent_service_test_history_meta_${this.suffix}`;
  private readonly runtimeUser = `hc_rt_${this.suffix}`;
  private readonly definerUser = `hc_df_${this.suffix}`;
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
  private cleaned = false;
  private readonly refKey?: Buffer;
  private keyDirectory?: string;
  private keyFile?: string;
  private keyDirectoryIdentity?: string;
  private keyIdentity?: string;
  private preparing?: Promise<void>;
  private closing?: Promise<void>;
  private operator?: OwnedRetirementConnection;
  private options?: Parameters<typeof MysqlSessionStore.connect>[0];

  constructor(private readonly operatorUrl: string, private readonly database: string, private readonly signal: AbortSignal, refKey?: Uint8Array) {
    const url = new URL(operatorUrl);
    if (url.protocol !== "mysql:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.search || url.hash
      || decodeURIComponent(url.pathname.slice(1)) !== database
      || !/^agent_service_migration_test_pre004[012]_[0-9]+_[a-f0-9]{8}$/.test(database)) throw Error("historical_current_fixture_identity");
    if (refKey !== undefined) {
      if (!(refKey instanceof Uint8Array) || refKey.byteLength !== 32) throw Error("historical_current_fixture_key");
      this.refKey = Buffer.from(refKey); // Fix the original key before the first await; never mutate the caller buffer.
    }
  }
  didClean(): boolean { return this.cleaned; }
  private own<T>(task: Promise<T>): Promise<T> {
    this.pending.add(task); void task.then(() => this.pending.delete(task), () => this.pending.delete(task)); return task;
  }
  private account(user: string): string { return `${mysql.escape(user)}@${mysql.escape(this.host)}`; }
  private active(): void { this.signal.throwIfAborted(); }
  private async createAccount(user: string): Promise<void> {
    const conn = this.operator!;
    if ((await conn.rows("SELECT User,Host FROM mysql.user WHERE BINARY User=BINARY ?", [user])).length) throw Error("historical_current_fixture_identity");
    this.accountAttempts.add(user); // Unknown CREATE retains this exact issued identity.
    try {
      await conn.exec(`CREATE USER ${this.account(user)} ${user === this.runtimeUser ? "IDENTIFIED BY ?" : "ACCOUNT LOCK"}`,
        user === this.runtimeUser ? [this.password] : []);
    } catch (error) {
      const safe = new Error("Historical current fixture account creation failed.");
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

  private async prepareKeyFile(): Promise<void> {
    if (this.refKey === undefined) return;
    this.active(); const temp = await realpath(tmpdir()); this.active();
    this.keyDirectory = await mkdtemp(join(temp, "agent-service-history-current-key-"));
    this.active(); await chmod(this.keyDirectory, 0o700);
    const directory = await lstat(this.keyDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.()
      || (directory.mode & 0o7777) !== 0o700 || await realpath(this.keyDirectory) !== this.keyDirectory) throw Error("historical_current_fixture_key");
    this.keyDirectoryIdentity = [directory.dev, directory.ino, directory.uid, directory.mode].join(":");
    this.keyFile = join(this.keyDirectory, "telemetry-ref-key.bin");
    let file: Awaited<ReturnType<typeof open>> | undefined, failure: { reason: unknown } | undefined;
    try {
      this.active(); file = await open(this.keyFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600) throw Error("historical_current_fixture_key");
      this.active(); await file.writeFile(this.refKey); await file.sync();
    } catch (reason) { failure = { reason }; }
    try { await file?.close(); } catch (reason) { failure ??= { reason }; }
    if (failure) throw failure.reason;
    let parent: Awaited<ReturnType<typeof open>> | undefined;
    try {
      this.active(); parent = await open(this.keyDirectory, constants.O_RDONLY | constants.O_NOFOLLOW);
      await parent.sync();
    } catch (reason) { failure = { reason }; }
    try { await parent?.close(); } catch (reason) { failure ??= { reason }; }
    if (failure) throw failure.reason;
    const saved = await lstat(this.keyFile), after = await lstat(this.keyDirectory);
    if (!saved.isFile() || saved.isSymbolicLink() || saved.size !== 32 || saved.uid !== process.getuid?.()
      || saved.nlink !== 1 || (saved.mode & 0o7777) !== 0o600 || await realpath(this.keyDirectory) !== this.keyDirectory
      || [after.dev, after.ino, after.uid, after.mode].join(":") !== this.keyDirectoryIdentity) throw Error("historical_current_fixture_key");
    this.keyIdentity = [saved.dev, saved.ino, saved.uid, saved.mode, saved.nlink, saved.size, saved.mtimeMs, saved.ctimeMs].join(":");
    this.active();
  }
  private async cleanupKeyFile(): Promise<void> {
    if (this.refKey === undefined) return;
    if (!this.keyDirectory || !this.keyFile || !this.keyDirectoryIdentity || !this.keyIdentity) throw Error("historical_current_fixture_key");
    this.active(); const directory = await lstat(this.keyDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(this.keyDirectory) !== this.keyDirectory
      || [directory.dev, directory.ino, directory.uid, directory.mode].join(":") !== this.keyDirectoryIdentity) throw Error("historical_current_fixture_key");
    const before = await lstat(this.keyFile);
    const stamp = (stat: typeof before) => [stat.dev, stat.ino, stat.uid, stat.mode, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
    if (!before.isFile() || before.isSymbolicLink() || stamp(before) !== this.keyIdentity) throw Error("historical_current_fixture_key");
    const contents = await readFile(this.keyFile);
    try {
      if (contents.length !== 32 || !contents.equals(this.refKey) || stamp(await lstat(this.keyFile)) !== this.keyIdentity
        || JSON.stringify(await readdir(this.keyDirectory)) !== JSON.stringify(["telemetry-ref-key.bin"])) throw Error("historical_current_fixture_key");
    } finally { contents.fill(0); }
    this.active(); await unlink(this.keyFile); await rmdir(this.keyDirectory);
  }

  prepare(): Promise<void> {
    if (this.preparing) return this.preparing;
    if (this.closing) return Promise.reject(Error("historical_current_fixture_closed"));
    return this.preparing = this.own((async () => {
      this.active();
      await MysqlSessionStore.runSchemaOperation({ url: this.operatorUrl, operation: "migrate", migrationsDir: MIGRATIONS_DIR,
        migrationLockTimeoutSeconds: 60, fleetStoppedAck: "all-application-writers-stopped-v1", operationAbortSignal: this.signal });
      this.operator = await OwnedRetirementConnection.open(this.operatorUrl, this.signal, owner => this.owners.add(owner));
      const conn = this.operator;
      const identity = await conn.rows("SELECT @@server_uuid AS uuid,DATABASE() AS db,SUBSTRING_INDEX(USER(),'@',-1) AS client_host,@@GLOBAL.partial_revokes AS partial_revokes");
      const row = identity[0], mode: unknown = row?.partial_revokes;
      this.host = String(row?.client_host); this.uuid = String(row?.uuid).toLowerCase();
      if (identity.length !== 1 || row?.db !== this.database || !/^[a-f0-9-]{36}$/.test(this.uuid)
        || mode !== 0 && mode !== 1 || !this.host || this.host.length > 255 || /[%_@\\/\u0000-\u0020\u007f]/.test(this.host)
        || isIP(this.host) === 0 && !this.host.split(".").every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) throw Error("historical_current_fixture_identity");
      if ((await conn.rows("SELECT session_id FROM sessions LIMIT 1")).length) throw Error("historical_current_fixture_requires_empty_sessions");
      // This observation does not mint a proof; the product initial-binding transaction rechecks under its actual locks.
      if ((await conn.rows("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", [this.metadataSchema])).length) throw Error("historical_current_fixture_identity");
      this.metadataAttempted = true;
      await conn.exec(`CREATE DATABASE ${mysql.escapeId(this.metadataSchema)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
      await this.createAccount(this.runtimeUser); await this.createAccount(this.definerUser);
      const tables = await conn.rows("SELECT TABLE_NAME FROM information_schema.TABLES WHERE BINARY TABLE_SCHEMA=BINARY ? AND TABLE_TYPE='BASE TABLE' ORDER BY BINARY TABLE_NAME", [this.database]);
      if (!tables.length) throw Error("historical_current_fixture_identity");
      for (const table of tables) {
        const name = String(table.TABLE_NAME), readOnly = ["schema_migrations", "session_authority_control", "session_authority_bindings", "session_authority_runtime_accounts"].includes(name);
        await conn.exec(`GRANT ${readOnly ? "SELECT" : "SELECT,INSERT,UPDATE,DELETE"} ON ${mysql.escapeId(this.database)}.${mysql.escapeId(name)} TO ${this.account(this.runtimeUser)}`);
      }
      const grantSchema = mode === 0 ? this.database.replaceAll("_", "\\_").replaceAll("%", "\\%") : this.database;
      await conn.exec(`GRANT TRIGGER ON ${mysql.escapeId(grantSchema)}.* TO ${this.account(this.definerUser)}`);
      const afterMode = await conn.rows("SELECT @@GLOBAL.partial_revokes AS partial_revokes");
      if (afterMode.length !== 1 || afterMode[0]?.partial_revokes !== mode) throw Error("historical_current_fixture_identity");
      await conn.exec(`GRANT SHOW_ROUTINE ON *.* TO ${this.account(this.runtimeUser)}`);
      const schemaMetadata = { metadataSchema: this.metadataSchema, trustedDefiner: { user: this.definerUser, host: this.host } };
      await MysqlSessionStore.runSchemaOperation({ url: this.operatorUrl, operation: "install-metadata", schemaMetadata,
        migrationsDir: MIGRATIONS_DIR, fleetStoppedAck: "all-application-writers-stopped-v1", operationAbortSignal: this.signal });
      const procedure = buildSchemaMetadataProcedure(this.database, this.metadataSchema);
      for (const user of [this.runtimeUser, this.definerUser]) await conn.exec(`GRANT EXECUTE ON PROCEDURE ${mysql.escapeId(this.metadataSchema)}.${mysql.escapeId(procedure.routineName)} TO ${this.account(user)}`);
      // No old ordinary runtime was issued, no canonical session exists, and the actual initial
      // product transaction verifies this inactive source and the same private fixed command.
      await this.prepareKeyFile();
      await activateCurrentSchemaFixtureAuthority({ operatorUrl: this.operatorUrl, database: this.database,
        serverUuid: this.uuid, schemaMetadata, runtimeAccount: { user: this.runtimeUser, host: this.host }, signal: this.signal,
        ...(this.keyFile === undefined ? {} : { tenantTelemetryRefKeyFile: this.keyFile }) });
      const bindings = await conn.rows("SELECT current_binding_id FROM session_authority_control WHERE control_id=1");
      this.bindingId = String(bindings[0]?.current_binding_id);
      if (bindings.length !== 1 || !/^[a-f0-9-]{36}$/.test(this.bindingId)) throw Error("historical_current_fixture_identity");
      const runtime = new URL(this.operatorUrl); runtime.username = this.runtimeUser; runtime.password = this.password;
      this.options = { url: runtime.toString(), migrationMode: "verify", schemaMetadata, operationAbortSignal: this.signal,
        ...(this.refKey === undefined ? {} : { tenantTelemetryRefKey: this.refKey }) };
      this.active(); this.ready = true;
    })());
  }
  openStore(): Promise<MysqlSessionStore> {
    if (!this.ready || !this.options || this.closing) return Promise.reject(Error("historical_current_fixture_not_ready"));
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
      if (successful && (!this.ready || this.signal.aborted)) failure ??= { reason: Error("historical_current_fixture_not_settled") };
      const clean = successful && this.ready && !this.signal.aborted && !failure;
      try {
        if (clean) {
          const conn = this.operator!;
          const identity = await conn.rows("SELECT @@server_uuid AS uuid,DATABASE() AS db,CONNECTION_ID() AS id,@@SESSION.autocommit AS autocommit");
          if (identity.length !== 1 || String(identity[0]?.uuid).toLowerCase() !== this.uuid || identity[0]?.db !== this.database
            || identity[0]?.autocommit !== 1 || !Number.isSafeInteger(Number(identity[0]?.id)) || Number(identity[0]?.id) < 1) throw Error("historical_current_fixture_identity");
          const metadata = await conn.rows("SELECT DEFAULT_CHARACTER_SET_NAME AS charset,DEFAULT_COLLATION_NAME AS collation FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", [this.metadataSchema]);
          if (metadata.length !== 1 || metadata[0]?.charset !== "utf8mb4" || metadata[0]?.collation !== "utf8mb4_0900_ai_ci") throw Error("historical_current_fixture_identity");
          const routines = await conn.rows("SELECT ROUTINE_NAME,DEFINER,SECURITY_TYPE,ROUTINE_TYPE FROM information_schema.ROUTINES WHERE BINARY ROUTINE_SCHEMA=BINARY ?", [this.metadataSchema]);
          if (routines.length !== 1 || routines[0]?.ROUTINE_NAME !== buildSchemaMetadataProcedure(this.database, this.metadataSchema).routineName
            || routines[0]?.DEFINER !== `${this.definerUser}@${this.host}` || routines[0]?.SECURITY_TYPE !== "DEFINER" || routines[0]?.ROUTINE_TYPE !== "PROCEDURE") throw Error("historical_current_fixture_identity");
          const bindings = await conn.rows("SELECT current_binding_id FROM session_authority_control WHERE control_id=1");
          const members = await conn.rows("SELECT binding_id,account_user,account_host FROM session_authority_runtime_accounts");
          if (bindings.length !== 1 || bindings[0]?.current_binding_id !== this.bindingId || members.length !== 1
            || members[0]?.binding_id !== this.bindingId || members[0]?.account_user !== this.runtimeUser || members[0]?.account_host !== this.host) throw Error("historical_current_fixture_identity");
          for (const user of [this.runtimeUser, this.definerUser]) {
            const users = await conn.rows("SELECT User,Host,account_locked FROM mysql.user WHERE BINARY User=BINARY ?", [user]);
            if (users.length !== 1 || users[0]?.User !== user || users[0]?.Host !== this.host
              || users[0]?.account_locked !== (user === this.definerUser ? "Y" : "N")) throw Error("historical_current_fixture_identity");
            if ((await conn.rows("SELECT PROCESSLIST_ID FROM performance_schema.threads WHERE TYPE='FOREGROUND' AND BINARY PROCESSLIST_USER=BINARY ?", [user])).length) throw Error("historical_current_fixture_native_live");
          }
          for (const schema of [this.database, this.metadataSchema]) {
            const clients = await conn.rows("SELECT ID FROM information_schema.PROCESSLIST WHERE BINARY DB=BINARY ? AND ID<>?", [schema, identity[0]!.id]);
            const tx = await conn.rows("SELECT t.trx_id FROM information_schema.INNODB_TRX t JOIN information_schema.PROCESSLIST p ON p.ID=t.trx_mysql_thread_id WHERE BINARY p.DB=BINARY ? AND p.ID<>?", [schema, identity[0]!.id]);
            if (clients.length || tx.length) throw Error("historical_current_fixture_native_live");
          }
          await conn.exec(`DROP DATABASE ${mysql.escapeId(this.metadataSchema)}`);
          if ((await conn.rows("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", [this.metadataSchema])).length) throw Error("historical_current_fixture_cleanup");
          for (const user of [this.runtimeUser, this.definerUser]) {
            await conn.exec(`DROP USER ${this.account(user)}`);
            if ((await conn.rows("SELECT User FROM mysql.user WHERE BINARY User=BINARY ?", [user])).length) throw Error("historical_current_fixture_cleanup");
          }
          await this.cleanupKeyFile();
        }
      } catch (reason) { failure ??= { reason }; }
      finally {
        for (const owner of this.owners) await attempt(() => owner.close());
        this.refKey?.fill(0); // Only after CLI, Store factories and actual native connections settle.
        if (clean && this.signal.aborted) failure ??= { reason: Error("historical_current_fixture_cancelled") };
        this.cleaned = clean && !failure;
        if (!this.cleaned) try { console.warn(JSON.stringify({ schema: "historical-current-profile-retained-v1", applicationDatabase: this.database,
          metadataSchema: this.metadataAttempted ? this.metadataSchema : null, accounts: [...this.accountAttempts],
          keyDirectory: this.keyDirectory ?? null, status: "retained_or_unknown" })); } catch (reason) { failure ??= { reason }; }
      }
      if (failure) throw failure.reason;
    })();
  }
}
