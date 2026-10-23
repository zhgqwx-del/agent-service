import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createConnection as createSocket, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import mysql, { type PoolConnection, type Connection, type FieldPacket, type QueryOptions, type QueryResult, type QueryValues, type RowDataPacket } from "mysql2/promise";
import { MysqlSessionStore, prepareSessionAuthorityBindingCommand, captureSessionAuthorityBindingCommand, assertSessionAuthorityActivationAdmission,
  readTenantTelemetryCaptureCheckpointFromMysql, type ActivateTenantRestoreJournalControlInput, type MysqlStoreOptions } from "../../src/index.js";
import { assertSessionAuthorityRuntimeConnection, loadActiveSessionAuthorityBinding, prepareSessionAuthorityActivationRequest, captureSessionAuthorityActivationRequest } from "../../src/mysql/session-authority-binding.js";
import { capturePrimaryJournalFixtureInput, captureRefKey } from "../persisted-provider-capture.fixture.js";
import { verifySchemaMetadataProcedureIdentity } from "../../src/mysql/schema-metadata.js";
import { createMysqlOperationAbortTransport, bindMysqlOperationAbort } from "../../src/mysql/operation-abort.js";
import { prepareMysqlRuntimeFixture, witnessAbsentMysqlFixtureDatabase } from "../../../../test/fixtures/mysql-runtime.mjs";
import { createMysqlSchemaCliExecutor } from "../../../../test/fixtures/mysql-schema-cli.mjs";
import { captureMysqlFixtureAuthorityCommand, createMysqlAuthorityCliExecutor } from "../../../../test/fixtures/mysql-authority-cli.mjs";

const failed = () => new Error("Capture MySQL test fixture ownership is not proven");
async function closeOwned<T>(work: () => Promise<T>, close: () => Promise<void>): Promise<T> {
  let hasError=false, firstError:unknown, value:T|undefined;
  try { value=await work(); } catch(error) { hasError=true;firstError=error; }
  try { await close(); } catch(error) { if(!hasError){hasError=true;firstError=error;} }
  if(hasError)throw firstError;return value as T;
}
const at = (base: URL, database: string) => { const url = new URL(base); url.pathname = `/${database}`; return url.toString(); };

/** Only these current-test switches may differ from the owner's restricted native profile.
 * No URL, account, profile, schema metadata, migration mode or authority override is accepted. */
export type CaptureMysqlCleanupValidation = "structure-after-intentional-data-corruption-v1";
export interface CaptureMysqlStoreSelection {
  tenantTelemetryRefKey?: Uint8Array | null;
  tenantTelemetryPersistedProviderCaptureLocalOnly?: boolean;
  tenantTelemetryCaptureRestoreLocalOnly?: boolean;
  tenantRedisPurgeNamespaceSha256?: string;
}
function selectStoreOptions(base: MysqlStoreOptions, selection?: CaptureMysqlStoreSelection): MysqlStoreOptions {
  if (selection === undefined) return { ...base };
  if (!selection || typeof selection !== "object" || Object.getPrototypeOf(selection) !== Object.prototype) throw failed();
  const descriptors = Object.getOwnPropertyDescriptors(selection);
  const selected = { ...base };
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !["tenantTelemetryRefKey", "tenantTelemetryPersistedProviderCaptureLocalOnly",
      "tenantTelemetryCaptureRestoreLocalOnly", "tenantRedisPurgeNamespaceSha256"].includes(key)) throw failed();
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor) || !descriptor.enumerable) throw failed();
    const value: unknown = descriptor.value;
    if (key === "tenantTelemetryRefKey") {
      if (value === null) delete selected.tenantTelemetryRefKey;
      else if (value instanceof Uint8Array && value.byteLength === 32) selected.tenantTelemetryRefKey = Buffer.from(value);
      else throw failed();
    } else if (key === "tenantRedisPurgeNamespaceSha256") {
      if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw failed();
      selected.tenantRedisPurgeNamespaceSha256 = value;
    } else {
      if (typeof value !== "boolean") throw failed();
      if (key === "tenantTelemetryPersistedProviderCaptureLocalOnly") selected.tenantTelemetryPersistedProviderCaptureLocalOnly = value;
      else selected.tenantTelemetryCaptureRestoreLocalOnly = value;
    }
  }
  return selected;
}

/** Test-only fresh name, fixed synchronously. This never adopts the URL's database or an existing schema. */
export interface CaptureMysqlNamedFreshSelection { readonly applicationDatabase: string }
export function captureMysqlNamedFreshDatabase(selection: CaptureMysqlNamedFreshSelection): string {
  if (!selection || typeof selection !== "object" || Object.getPrototypeOf(selection) !== Object.prototype) throw failed();
  const descriptors = Object.getOwnPropertyDescriptors(selection), keys = Reflect.ownKeys(descriptors);
  const descriptor = descriptors.applicationDatabase;
  if (keys.length !== 1 || keys[0] !== "applicationDatabase" || !descriptor?.enumerable || !("value" in descriptor)
    || typeof descriptor.value !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(descriptor.value)
    || !/(?:^|[_-])(?:test|cluster)(?:$|[_-])/i.test(descriptor.value)) throw failed();
  return descriptor.value;
}

/** An operator SQL observer, never an ordinary store. Own query promises and the actual socket. */
export class CaptureMysqlInspection {
  private readonly pending = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;
  constructor(private readonly connection: Connection, private readonly socket: Socket,
    private readonly nativeClosed: Promise<void>, private readonly signal: AbortSignal,
    private readonly detachAbort: () => void) {}

  query<T extends QueryResult = QueryResult>(sql: string | QueryOptions, values?: QueryValues): Promise<[T, FieldPacket[]]> {
    if (this.closing || this.signal.aborted) return Promise.reject(failed());
    const work = typeof sql === "string" ? this.connection.query<T>(sql, values) : this.connection.query<T>(sql, values);
    this.pending.add(work); void work.then(() => this.pending.delete(work), () => this.pending.delete(work));
    return work;
  }

  private own<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work); void work.then(() => this.pending.delete(work), () => this.pending.delete(work)); return work;
  }

  beginTransaction(): Promise<void> {
    if (this.closing || this.signal.aborted) return Promise.reject(failed());
    return this.own(this.connection.beginTransaction());
  }
  commit(): Promise<void> {
    if (this.closing || this.signal.aborted) return Promise.reject(failed());
    return this.own(this.connection.commit());
  }
  rollback(): Promise<void> {
    if (this.closing || this.signal.aborted) return Promise.reject(failed());
    return this.own(this.connection.rollback());
  }
  /** Pass the actual native connection to the existing projection reader; no Connection-shaped cast. */
  readCaptureCheckpoint(backupId: string, refKey: Uint8Array) {
    if (this.closing || this.signal.aborted) return Promise.reject(failed());
    return this.own(readTenantTelemetryCaptureCheckpointFromMysql(this.connection, backupId, refKey));
  }

  end(): Promise<void> {
    if (this.closing) return this.closing;
    return this.closing = (async () => {
      let failure: { reason: unknown } | undefined;
      try { if (!this.signal.aborted) await this.connection.end(); }
      catch (reason) { failure = { reason }; }
      finally {
        try { this.connection.destroy(); } catch (reason) { failure ??= { reason }; }
        try { this.socket.destroy(); } catch (reason) { failure ??= { reason }; }
        await this.nativeClosed;
        while (this.pending.size) await Promise.allSettled([...this.pending]);
        this.detachAbort();
      }
      if (failure) throw failure.reason;
    })();
  }
}

/** One current-schema test file's new database. No adoption of the URL's existing app schema. */
export class CaptureMysqlRuntimeOwner {
  readonly database = `agent_service_test_capture_${randomBytes(12).toString("hex")}`;
  private readonly base: URL;
  private readonly defaults: Readonly<CaptureMysqlStoreSelection>;
  private primaryActivationRequestSha256: string | undefined;
  private readonly preparation = new AbortController();
  private readonly consumers = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly stores = new Set<MysqlSessionStore>();
  private readonly inspections = new Set<CaptureMysqlInspection>();
  private readonly sockets = new Map<Socket, Promise<void>>();
  private readonly nativeFailures: unknown[] = [];
  private runtime: Awaited<ReturnType<typeof prepareMysqlRuntimeFixture>> | undefined;
  private preparing: Promise<void> | undefined;
  private allocating: Promise<void> | undefined;
  private allocatedWitness: Awaited<ReturnType<typeof witnessAbsentMysqlFixtureDatabase>> | undefined;
  private readonly namedFresh: boolean;
  private closing: Promise<void> | undefined;
  private uuid = "";
  private ready = false;
  private createAttempted = false;
  private initialCommand: ReturnType<typeof captureMysqlFixtureAuthorityCommand>["command"] | undefined;
  private currentOptions: MysqlStoreOptions | undefined;
  private currentBindingId: string | undefined;
  private currentEnv: Readonly<Record<string,string>> | undefined;
  private newUser: string | undefined;
  private newUserCreateAttempted = false;
  private rotating = false;
  private rotation: Promise<void> | undefined;
  private rotated = false;
  private readonly probes = new Set<string>();
  private created = false;

  constructor(operatorUrl: string, defaultSelection?: CaptureMysqlStoreSelection, namedFresh?: CaptureMysqlNamedFreshSelection) {
    try {
      this.base = new URL(operatorUrl);
      if (this.base.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(this.base.hostname)
        || this.base.search || this.base.hash || !/(?:^|[_-])test(?:$|[_-])/i.test(decodeURIComponent(this.base.pathname.slice(1)))) throw failed();
      // The provided path is only a caller safety token. Every actual connection uses mysql or our new DB.
      this.base.pathname = "/mysql";
      this.namedFresh = namedFresh !== undefined;
      if (namedFresh !== undefined) this.database = captureMysqlNamedFreshDatabase(namedFresh);
      // Fix all permitted defaults synchronously, before prepare can issue any native work.
      // Reuse the same closed four-field validator; URL/account/profile/metadata are not inputs.
      const selected = selectStoreOptions({ url: at(this.base, this.database),
        tenantTelemetryRefKey: Buffer.from(captureRefKey),
        tenantTelemetryPersistedProviderCaptureLocalOnly: true }, defaultSelection);
      this.defaults = Object.freeze({
        tenantTelemetryRefKey: selected.tenantTelemetryRefKey === undefined
          ? null : Buffer.from(selected.tenantTelemetryRefKey),
        ...(selected.tenantTelemetryPersistedProviderCaptureLocalOnly !== undefined
          ? { tenantTelemetryPersistedProviderCaptureLocalOnly: selected.tenantTelemetryPersistedProviderCaptureLocalOnly } : {}),
        ...(selected.tenantTelemetryCaptureRestoreLocalOnly !== undefined
          ? { tenantTelemetryCaptureRestoreLocalOnly: selected.tenantTelemetryCaptureRestoreLocalOnly } : {}),
        ...(selected.tenantRedisPurgeNamespaceSha256 !== undefined
          ? { tenantRedisPurgeNamespaceSha256: selected.tenantRedisPurgeNamespaceSha256 } : {}),
      });
    } catch { throw failed(); }
  }

  private own<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work); void work.then(() => this.pending.delete(work), () => this.pending.delete(work)); return work;
  }

  private observe(socket: Socket): Socket {
    const closed = socket.closed ? Promise.resolve() : new Promise<void>(resolve => socket.once("close", () => resolve()));
    this.sockets.set(socket, closed); void closed.then(() => this.sockets.delete(socket)); return socket;
  }

  private async inspect(database: string, signal: AbortSignal, connectTimeoutMs = 10_000): Promise<CaptureMysqlInspection> {
    if (signal.aborted) throw failed();
    let socket: Socket | undefined, connection: Connection | undefined;
    const abort = () => {
      try { connection?.destroy(); } catch (error) { this.nativeFailures.push(error); }
      try { socket?.destroy(); } catch (error) { this.nativeFailures.push(error); }
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      connection = await mysql.createConnection({ uri: at(this.base, database), connectTimeout: connectTimeoutMs,
        stream: (options: { config: { host: string; port: number } }) => {
          if (socket) throw failed();
          socket = this.observe(createSocket({ host: options.config.host, port: options.config.port }));
          if (signal.aborted) queueMicrotask(abort); return socket;
        } });
      if (!socket || signal.aborted) throw failed();
      const value = new CaptureMysqlInspection(connection, socket, this.sockets.get(socket) ?? Promise.resolve(), signal,
        () => signal.removeEventListener("abort", abort));
      this.inspections.add(value);
      const [identity] = await value.query<RowDataPacket[]>({ sql: "SELECT @@server_uuid AS uuid,DATABASE() AS db", timeout: connectTimeoutMs });
      if (identity.length !== 1 || identity[0]?.db !== database || typeof identity[0]?.uuid !== "string"
        || !/^[a-f0-9-]{36}$/i.test(identity[0].uuid) || this.uuid && identity[0].uuid.toLowerCase() !== this.uuid) throw failed();
      if (!this.uuid) this.uuid = identity[0].uuid.toLowerCase(); return value;
    } catch (error) {
      abort();
      if (socket) await (this.sockets.get(socket) ?? Promise.resolve());
      signal.removeEventListener("abort", abort); throw error;
    }
  }

  /** Optional old-hook CREATE boundary. The original witness and actual CREATE are single-use, including failure. */
  allocateFresh(): Promise<void> {
    if (this.allocating) return this.allocating;
    if (!this.namedFresh || this.preparing || this.closing || this.createAttempted) return Promise.reject(failed());
    return this.allocating = this.own((async () => {
      const admin = await this.inspect("mysql", this.preparation.signal);
      await closeOwned(async () => {
        const url = at(this.base, this.database);
        const witness = await witnessAbsentMysqlFixtureDatabase({ operatorUrl: url, applicationDatabase: this.database,
          operationAbortSignal: this.preparation.signal });
        this.createAttempted = true;
        await admin.query({ sql: `CREATE DATABASE \`${this.database}\` CHARACTER SET utf8mb4`, timeout: 10_000 });
        this.created = true;
        this.allocatedWitness = witness;
      }, () => admin.end());
    })());
  }

  prepare(): Promise<void> {
    if (this.preparing) return this.preparing;
    if (this.closing) return Promise.reject(failed());
    return this.preparing = this.own((async () => {
      const admin = this.allocating ? undefined : await this.inspect("mysql", this.preparation.signal);
      await closeOwned(async () => {
        const url = at(this.base, this.database);
        let witness: Awaited<ReturnType<typeof witnessAbsentMysqlFixtureDatabase>>;
        if (this.allocating) {
          await this.allocating;
          if (!this.allocatedWitness || !this.created) throw failed();
          witness = this.allocatedWitness;
        } else {
          witness = await witnessAbsentMysqlFixtureDatabase({ operatorUrl: url, applicationDatabase: this.database,
            operationAbortSignal: this.preparation.signal });
          this.createAttempted = true;
          await admin!.query({ sql: `CREATE DATABASE \`${this.database}\` CHARACTER SET utf8mb4`, timeout: 10_000 });
          this.created = true;
        }
        const cwd = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
        const entrypoint = fileURLToPath(new URL("../../../../apps/agent-runner/src/main.ts", import.meta.url));
        this.runtime = await prepareMysqlRuntimeFixture(witness, {
          schemaExecutor: createMysqlSchemaCliExecutor({ entrypoint, mode: "source", cwd }),
          authorityExecutor: async operation => {
            this.initialCommand = captureMysqlFixtureAuthorityCommand(operation.command).command;
            // Preserve the formal fixture's exact initial command; never replace its account/intent.
            await createMysqlAuthorityCliExecutor({ entrypoint, mode: "source", cwd })(operation);
          },
        });
        await this.runtime.assertReusable(url);
        this.currentOptions = selectStoreOptions(this.runtime.runtimeStoreOptions, this.defaults);
        this.currentEnv = this.runtime.runtimeEnv;
        this.currentBindingId = this.initialCommand?.bindingId;
      }, () => admin ? admin.end() : Promise.resolve());
      // Readiness includes the original bootstrap observer's actual native close.
      this.ready = true;
    })());
  }

  openStore(connectionLimit: number, operationAbortSignal?: AbortSignal, selection?: CaptureMysqlStoreSelection): Promise<MysqlSessionStore> {
    if (!this.ready || !this.runtime || !this.currentOptions || this.rotating || this.closing) return Promise.reject(failed());
    const signal = operationAbortSignal ? AbortSignal.any([this.consumers.signal, operationAbortSignal]) : this.consumers.signal;
    // Validate and copy the exact ref key before starting the original native factory.
    const options = selectStoreOptions(this.currentOptions, selection);
    return this.own(MysqlSessionStore.connect({ ...options, connectionLimit,
      operationAbortSignal: signal }).then(store => { this.stores.add(store); return store; }));
  }

  openInspection(operationAbortSignal?: AbortSignal, connectTimeoutMs = 10_000): Promise<CaptureMysqlInspection> {
    if (!this.ready || this.rotating || this.closing || !Number.isSafeInteger(connectTimeoutMs)
      || connectTimeoutMs < 1 || connectTimeoutMs > 10_000) return Promise.reject(failed());
    const signal = operationAbortSignal ? AbortSignal.any([this.consumers.signal, operationAbortSignal]) : this.consumers.signal;
    return this.own(this.inspect(this.database, signal, connectTimeoutMs));
  }


  /** Protected test-only runtime configuration; never operator credentials. */
  runtimeEnv(): Readonly<Record<string,string>> {
    if (!this.ready || this.rotating || this.closing || !this.currentEnv) throw failed();
    return this.currentEnv;
  }

  /** One fixed true account-rotation/primary transaction. Never retries unknown work with new IDs. */
  activatePrimary(originalInput?: ActivateTenantRestoreJournalControlInput): Promise<void> {
    // No-argument reuse preserves the original fixed rotation, including an unknown result.
    if (this.rotation && originalInput === undefined) return this.rotation;
    if (!this.rotation && (!this.ready || !this.runtime || !this.initialCommand || this.closing)) return Promise.reject(failed());
    let request: ReturnType<typeof captureSessionAuthorityActivationRequest>;
    try {
      request = captureSessionAuthorityActivationRequest(prepareSessionAuthorityActivationRequest(
        "primary_activation", originalInput === undefined ? capturePrimaryJournalFixtureInput() : originalInput));
    } catch (error) { return Promise.reject(error); }
    if (request.kind !== "primary_activation") return Promise.reject(failed());
    if (this.rotation) {
      if (request.activationRequestSha256 !== this.primaryActivationRequestSha256) return Promise.reject(failed());
      return this.rotation;
    }
    // Only the product-captured immutable input is used after the first await.
    const input = request.input;
    if (!this.ready || !this.runtime || !this.initialCommand || this.closing) return Promise.reject(failed());
    const initial = this.initialCommand, config = this.runtime.runtimeStoreOptions.schemaMetadata;
    if (!config || initial.newAccounts.length !== 1 || initial.expectedSequence !== 0 || initial.expectedBindingId !== null
      || initial.nextEpoch !== null || initial.expectedSource.kind !== "inactive") return Promise.reject(failed());
    const old = initial.newAccounts[0]!;
    if (!/^mrt_r_[a-f0-9]{16}$/.test(old.user) || old.host !== config.trustedDefiner.host) return Promise.reject(failed());
    const user = "mcp_z_" + randomBytes(8).toString("hex"), password = randomBytes(32).toString("hex");
    this.newUser = user;
    const command = prepareSessionAuthorityBindingCommand({ bindingId: randomUUID(), activationId: randomUUID(),
      expectedBindingId: initial.bindingId, expectedSequence: 1, serverUuid: initial.serverUuid, applicationDatabase: this.database,
      newAccounts: [{ user, host: old.host }], oldAccountNames: [old.user],
      activationEvidenceSha256: createHash("sha256").update(JSON.stringify(["capture-fixture-primary-v1",initial.bindingId,this.database,user])).digest("hex"),
      expectedSource: initial.expectedSource, nextEpoch: { kind: "primary_activation", runtimeEpochSha256: input.runtimeEpochSha256,
        restoreRunId: null, activationRequestSha256: request.activationRequestSha256, sealedReplayReceiptSha256: null } });
    const accepted=[...this.pending]; // Capture before registering the rotation itself.
    this.primaryActivationRequestSha256 = request.activationRequestSha256;
    this.rotating = true;
    return this.rotation = this.own((async () => {
      let maintenance: Awaited<ReturnType<typeof MysqlSessionStore.connectRestoreJournalMaintenance>> | undefined;
      let hasError = false, firstError: unknown;
      const remember = (error: unknown) => { if (!hasError) { hasError = true; firstError = error; } };
      try {
        // No new ordinary borrow is admitted while rotating. Every previously returned Y pool
        // must finish its actual close before native retirement or the source transaction.
        const preceding=await Promise.allSettled(accepted);
        for(const result of preceding)if(result.status==="rejected")remember(result.reason);
        const drained = await Promise.allSettled([...this.stores].map(store => store.close()));
        for (const result of drained) if (result.status === "rejected") remember(result.reason);
        if (hasError) throw firstError; this.preparation.signal.throwIfAborted();
        const admin = await this.inspect("mysql", this.preparation.signal);
        await closeOwned(async () => {
          const [absent] = await admin.query<RowDataPacket[]>("SELECT User FROM mysql.user WHERE BINARY User=BINARY ?", [user]);
          if (absent.length !== 0) throw failed();
          await admin.query(`REVOKE SHOW_ROUTINE ON *.* FROM ${mysql.escape(old.user)}@${mysql.escape(old.host)}`);
          await admin.query(`REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${mysql.escape(old.user)}@${mysql.escape(old.host)}`);
          await admin.query(`ALTER USER ${mysql.escape(old.user)}@${mysql.escape(old.host)} ACCOUNT LOCK`);
          this.newUserCreateAttempted = true;
          try { await admin.query(`CREATE USER ${mysql.escape(user)}@${mysql.escape(old.host)} IDENTIFIED BY ?`, [password]); }
          catch (error) {
            // mysql2 may include expanded SQL/password in message/sql. Never retain that error/cause.
            const safe = new Error("capture_fixture_account_creation_failed");
            if (error && typeof error === "object") {
              for (const key of ["code","errno","sqlState"] as const) {
                const value=Object.getOwnPropertyDescriptor(error,key)?.value;
                if (key==="code" && typeof value==="string" && /^ER_[A-Z0-9_]{1,80}$/.test(value)
                  || key==="errno" && Number.isSafeInteger(value) && value>=0 && value<=65535
                  || key==="sqlState" && typeof value==="string" && /^[A-Z0-9]{5}$/.test(value))
                  Object.defineProperty(safe,key,{value,enumerable:true});
              }
            }
            throw safe;
          }
          const [tables] = await admin.query<RowDataPacket[]>("SELECT TABLE_NAME FROM information_schema.TABLES WHERE BINARY TABLE_SCHEMA=BINARY ? AND TABLE_TYPE='BASE TABLE' ORDER BY BINARY TABLE_NAME", [this.database]);
          const controls = ["schema_migrations","session_authority_control","session_authority_bindings","session_authority_runtime_accounts"];
          const names = tables.map(row => row.TABLE_NAME);
          if (!names.length || new Set(names).size !== names.length || names.some(name => typeof name !== "string"
            || !/^[a-z0-9_]+$/.test(name)) || controls.some(name => !names.includes(name))) throw failed();
          for (const name of names) await admin.query(`GRANT ${controls.includes(name) ? "SELECT" : "SELECT,INSERT,UPDATE,DELETE"} ON ${mysql.escapeId(this.database)}.${mysql.escapeId(name)} TO ${mysql.escape(user)}@${mysql.escape(old.host)}`);
          await admin.query(`GRANT SHOW_ROUTINE ON *.* TO ${mysql.escape(user)}@${mysql.escape(old.host)}`);
          const routine = createHash("sha256").update(this.database).digest("hex");
          await admin.query(`GRANT EXECUTE ON PROCEDURE ${mysql.escapeId(config.metadataSchema)}.${mysql.escapeId(routine)} TO ${mysql.escape(user)}@${mysql.escape(old.host)}`);
        }, () => admin.end());
        // Maintenance has its own narrow API: carry the fixed key, never ordinary flags or namespace.
        const maintenanceRefKey = this.defaults.tenantTelemetryRefKey;
        maintenance = await MysqlSessionStore.connectRestoreJournalMaintenance({ url: at(this.base,this.database),
          connectionLimit: 1, operationAbortSignal: this.preparation.signal,
          ...(maintenanceRefKey === undefined || maintenanceRefKey === null ? {} : { tenantTelemetryRefKey: maintenanceRefKey }) },
          { kind: "operator-maintenance", binding: { command, schemaMetadata: config, assertNativeAdmission: assertSessionAuthorityActivationAdmission } });
        await maintenance.activateTenantRestoreJournalControl(input);
        await maintenance.confirmSessionAuthorityBinding();
        this.preparation.signal.throwIfAborted();
        const url = new URL(at(this.base,this.database)); url.username = user; url.password = password;
        this.currentOptions = selectStoreOptions({ ...this.runtime!.runtimeStoreOptions, url: url.toString() }, this.defaults);
        this.currentEnv = Object.freeze({ ...this.runtime!.runtimeEnv, MYSQL_URL: url.toString() });
        this.currentBindingId = captureSessionAuthorityBindingCommand(command).bindingId;
        this.rotated = true;
      } catch (error) { remember(error); }
      finally { if (maintenance) try { await maintenance.close(); } catch (error) { remember(error); } }
      if (hasError) { this.ready = false; throw firstError; }
      this.rotating = false;
    })());
  }


  /** Exact owned extra table used only by the original real-RR phantom oracle. */
  createIsolationProbe(): Promise<string> {
    if(!this.ready||this.rotating||this.closing||!this.currentEnv||!this.initialCommand)return Promise.reject(failed());
    const name="capture_fixture_isolation_"+randomBytes(8).toString("hex");
    const user=decodeURIComponent(new URL(this.currentEnv.MYSQL_URL!).username),host=this.initialCommand.newAccounts[0]!.host;
    return this.own((async()=>{const admin=await this.inspect("mysql",this.preparation.signal);
      return closeOwned(async()=>{
        const [rows]=await admin.query<RowDataPacket[]>("SELECT TABLE_NAME FROM information_schema.TABLES WHERE BINARY TABLE_SCHEMA=BINARY ? AND BINARY TABLE_NAME=BINARY ?",[this.database,name]);
        if(rows.length!==0)throw failed();this.probes.add(name);
        await admin.query(`CREATE TABLE ${mysql.escapeId(this.database)}.${mysql.escapeId(name)} (id INT PRIMARY KEY) ENGINE=InnoDB`);
        // The current closed per-table runtime profile requires the exact business-table set.
        await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${mysql.escapeId(this.database)}.${mysql.escapeId(name)} TO ${mysql.escape(user)}@${mysql.escape(host)}`);
        return name;
      },()=>admin.end());})());
  }
  dropIsolationProbe(name:string):Promise<void>{
    if(!this.probes.has(name)||!/^capture_fixture_isolation_[a-f0-9]{16}$/.test(name)||!this.currentEnv||!this.initialCommand)return Promise.reject(failed());
    const user=decodeURIComponent(new URL(this.currentEnv.MYSQL_URL!).username),host=this.initialCommand.newAccounts[0]!.host;
    return this.own((async()=>{const admin=await this.inspect("mysql",this.preparation.signal);
      await closeOwned(async()=>{
        await admin.query(`REVOKE SELECT,INSERT,UPDATE,DELETE ON ${mysql.escapeId(this.database)}.${mysql.escapeId(name)} FROM ${mysql.escape(user)}@${mysql.escape(host)}`);
        await admin.query(`DROP TABLE ${mysql.escapeId(this.database)}.${mysql.escapeId(name)}`);
        const [rows]=await admin.query<RowDataPacket[]>("SELECT TABLE_NAME FROM information_schema.TABLES WHERE BINARY TABLE_SCHEMA=BINARY ? AND BINARY TABLE_NAME=BINARY ?",[this.database,name]);
        if(rows.length!==0)throw failed();this.probes.delete(name);
      },()=>admin.end());})());
  }

  /** Explicit operator negative only. No ordinary store or runtime fallback is produced. */
  migrateWithLockTimeout(seconds: number): Promise<void> {
    if (!this.ready || this.closing) return Promise.reject(failed());
    return this.own(MysqlSessionStore.runSchemaOperation({ url: at(this.base, this.database), operation: "migrate",
      fleetStoppedAck: "all-application-writers-stopped-v1", operationAbortSignal: this.consumers.signal,
      migrationLockTimeoutSeconds: seconds }));
  }

  /** Only intentional corruption consumers select this alternative. Ordinary startup data
   * audit is not claimed: exact structure, native restricted profile and binding are still checked. */
  private async verifyStructureForCorruptionCleanup(): Promise<void> {
    const config = this.currentOptions?.schemaMetadata;
    if (!this.currentOptions || !config || !this.currentBindingId) throw failed();
    // The public schema operation rejects schemaMetadata except for install-metadata.
    // This is the original full structural verifier; it omits only runtime data/config auditing.
    await MysqlSessionStore.runSchemaOperation({ url: at(this.base, this.database), operation: "verify",
      operationAbortSignal: this.preparation.signal });
    const transport = createMysqlOperationAbortTransport(this.preparation.signal);
    let pool: ReturnType<typeof mysql.createPool> | undefined;
    let scope: ReturnType<typeof bindMysqlOperationAbort> | undefined;
    let connection: PoolConnection | undefined;
    let hasError = false, firstError: unknown;
    const remember = (error: unknown) => { if (!hasError) { hasError = true; firstError = error; } };
    try {
      pool = mysql.createPool({ uri: this.currentOptions.url, connectionLimit: 1, connectTimeout: 10_000,
        stream: transport.stream });
      scope = bindMysqlOperationAbort(pool, this.preparation.signal, transport);
      connection = await pool.getConnection();
      // Reuse the real native validators, including CURRENT_USER, exact runtime table grants,
      // current binding membership, physical identity and original source/epoch; no forged DTO proof.
      await assertSessionAuthorityRuntimeConnection(connection, config);
      await verifySchemaMetadataProcedureIdentity(connection, this.database, config);
      const binding = await loadActiveSessionAuthorityBinding(connection, false);
      if (binding.serverUuid !== this.uuid || binding.applicationDatabase !== this.database
        || binding.bindingId !== this.currentBindingId) throw failed();
    } catch (error) { remember(error); }
    finally {
      try { if (hasError) connection?.destroy(); else connection?.release(); } catch (error) { remember(error); }
      try { if (scope) await scope.close(); else if (pool) await pool.end(); } catch (error) { remember(error); }
      transport.close(); await transport.settled();
    }
    if (hasError) throw firstError;
  }

  close(input: { successful: boolean; cleanupValidation?: CaptureMysqlCleanupValidation }): Promise<void> {
    // The original first-call cached close remains the only owner. No later request changes its policy.
    if (this.closing) return this.closing;
    if (!input || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype
      || Reflect.ownKeys(input).some(key => {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        return typeof key !== "string" || !["successful", "cleanupValidation"].includes(key)
          || !descriptor?.enumerable || !("value" in descriptor);
      }) || typeof input.successful !== "boolean" || input.cleanupValidation !== undefined
        && input.cleanupValidation !== "structure-after-intentional-data-corruption-v1") return Promise.reject(failed());
    const successfulRequested = input.successful, cleanupValidation = input.cleanupValidation;
    if (!this.ready || this.rotating || this.pending.size>0) this.preparation.abort();
    this.consumers.abort();
    return this.closing = (async () => {
      const failures: unknown[] = [];
      while (this.pending.size) await Promise.allSettled([...this.pending]);
      const closed = await Promise.allSettled([...this.stores].map(store => store.close()).concat(
        [...this.inspections].map(observer => observer.end())));
      for (const result of closed) if (result.status === "rejected") failures.push(result.reason);
      while (this.sockets.size) await Promise.all([...this.sockets.values()]);
      let successful = successfulRequested && this.ready && this.created && this.probes.size===0 && !this.preparation.signal.aborted
        && !failures.length && !this.nativeFailures.length;
      try {
        // The original fixture's success path assumes Y remains unlocked. Transfer cleanup
        // responsibility explicitly; do not invoke that incompatible success path after rotation.
        if (this.runtime) await this.runtime.close({ successful: false });
        if (successful) {
          if (!this.currentOptions || !this.initialCommand || !this.runtime) throw failed();
          if (cleanupValidation === "structure-after-intentional-data-corruption-v1") {
            await this.verifyStructureForCorruptionCleanup();
          } else {
            // Default unchanged: real fresh restricted startup checks all ordinary runtime data.
            const checked = await MysqlSessionStore.connect({ ...this.currentOptions, connectionLimit: 1,
              operationAbortSignal: this.preparation.signal });
            await closeOwned(() => checked.sessionAuthority.identity(), () => checked.close());
          }
          const config = this.runtime.runtimeStoreOptions.schemaMetadata; if (!config) throw failed();
          const old = this.initialCommand.newAccounts[0]!;
          const expected = [{ user: config.trustedDefiner.user, locked: "Y" },
            { user: old.user, locked: this.rotated ? "Y" : "N" },
            ...(this.rotated && this.newUser ? [{ user: this.newUser, locked: "N" }] : [])];
          const admin = await this.inspect("mysql", this.preparation.signal);
          await closeOwned(async () => {
            const [actual] = await admin.query<RowDataPacket[]>(`SELECT User,Host,account_locked FROM mysql.user WHERE User IN (${expected.map(()=>"?").join(",")})`, expected.map(row=>row.user));
            if (actual.length !== expected.length || expected.some(row=>actual.filter(a=>a.User===row.user
              && a.Host===old.host && a.account_locked===row.locked).length!==1)) throw failed();
            const [schemas] = await admin.query<RowDataPacket[]>("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ? OR BINARY SCHEMA_NAME=BINARY ?", [this.database,config.metadataSchema]);
            if (schemas.length!==2 || new Set(schemas.map(row=>row.SCHEMA_NAME)).size!==2) throw failed();
            const [routines] = await admin.query<RowDataPacket[]>("SELECT ROUTINE_NAME,DEFINER,SECURITY_TYPE,ROUTINE_TYPE FROM information_schema.ROUTINES WHERE BINARY ROUTINE_SCHEMA=BINARY ?", [config.metadataSchema]);
            if (routines.length!==1 || routines[0]?.ROUTINE_NAME!==createHash("sha256").update(this.database).digest("hex")
              || routines[0]?.DEFINER!==config.trustedDefiner.user+"@"+config.trustedDefiner.host
              || routines[0]?.SECURITY_TYPE!=="DEFINER" || routines[0]?.ROUTINE_TYPE!=="PROCEDURE") throw failed();
            if (this.rotated) {
              const [grants] = await admin.query<RowDataPacket[]>(`SHOW GRANTS FOR ${mysql.escape(old.user)}@${mysql.escape(old.host)}`);
              if (grants.length!==1 || Object.values(grants[0]!).length!==1
                || Object.values(grants[0]!)[0]!==("GRANT USAGE ON *.* TO `"+old.user+"`@`"+old.host+"`")) throw failed();
            }
            for (const name of [this.database,config.metadataSchema]) {
              for (const [sql,values] of [
                ["SELECT COUNT(*) n FROM information_schema.PROCESSLIST WHERE BINARY DB=BINARY ?",[name]],
                ["SELECT COUNT(*) n FROM information_schema.INNODB_TRX t JOIN information_schema.PROCESSLIST p ON p.ID=t.trx_mysql_thread_id WHERE BINARY p.DB=BINARY ?",[name]],
                ["SELECT COUNT(*) n FROM performance_schema.metadata_locks WHERE BINARY OBJECT_SCHEMA=BINARY ? OR (OBJECT_TYPE='SCHEMA' AND BINARY OBJECT_NAME=BINARY ?)",[name,name]],
              ] as const) { const [rows]=await admin.query<RowDataPacket[]>(sql,[...values]); if(rows.length!==1||Number(rows[0]?.n)!==0)throw failed(); }
            }
            for (const row of expected) { const [rows]=await admin.query<RowDataPacket[]>("SELECT COUNT(*) n FROM information_schema.PROCESSLIST WHERE BINARY USER=BINARY ?",[row.user]); if(rows.length!==1||Number(rows[0]?.n)!==0)throw failed(); }
            for (const name of [this.database,config.metadataSchema]) {
              await admin.query(`DROP DATABASE ${mysql.escapeId(name)}`);
              const [rows]=await admin.query<RowDataPacket[]>("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?",[name]);if(rows.length!==0)throw failed();
            }
            for (const row of expected) {
              await admin.query(`DROP USER ${mysql.escape(row.user)}@${mysql.escape(old.host)}`);
              const [rows]=await admin.query<RowDataPacket[]>("SELECT User FROM mysql.user WHERE BINARY User=BINARY ?",[row.user]);if(rows.length!==0)throw failed();
            }
          }, () => admin.end());
        }
      } catch(error) { successful=false;failures.push(error); }
      finally {
        if (!successful && this.createAttempted) console.warn(JSON.stringify({schema:"capture-current-fixture-retained-v1",
          applicationDatabase:this.database,metadataSchema:this.runtime?.runtimeEnv.MYSQL_SCHEMA_METADATA_SCHEMA,
          runtimeRotationCreateAttempted:this.newUserCreateAttempted,
          runtimeAccountY:this.initialCommand?.newAccounts[0]?.user??null,runtimeAccountZ:this.newUser??null,
          metadataDefiner:this.runtime?.runtimeEnv.MYSQL_SCHEMA_METADATA_DEFINER_USER??null,serverUuid:this.uuid||null,
          status:"retained_or_unknown"}));
        this.preparation.abort();
        const final=await Promise.allSettled([...this.inspections].map(observer=>observer.end()));
        for(const result of final)if(result.status==="rejected")failures.push(result.reason);
        while(this.sockets.size)await Promise.all([...this.sockets.values()]);
      }
      failures.push(...this.nativeFailures);
      if(failures.length)throw new AggregateError(failures,"Capture MySQL fixture close failed");
    })();
  }
}
