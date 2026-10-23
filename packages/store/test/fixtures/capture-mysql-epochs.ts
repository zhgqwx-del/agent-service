import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createConnection as createSocket, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import mysql, { type Connection, type PoolConnection, type RowDataPacket } from "mysql2/promise";
import { MysqlSessionStore, prepareSessionAuthorityBindingCommand, assertSessionAuthorityActivationAdmission,
  type MysqlStoreOptions, type TenantTelemetryCaptureRestoreMaintenanceSelector } from "../../src/index.js";
import { assertSessionAuthorityRuntimeConnection, loadActiveSessionAuthorityBinding,
  readSessionAuthorityBindingSource, captureSessionAuthorityBindingCommand,
  prepareSessionAuthorityActivationRequest, captureSessionAuthorityActivationRequest,
  preflightSessionAuthorityBinding } from "../../src/mysql/session-authority-binding.js";
import type { PreparedSessionAuthorityBindingCommand, SessionAuthorityBindingOperatorContext,
  ActiveSessionAuthorityBinding, SessionAuthorityNextEpoch } from "../../src/mysql/session-authority-binding-types.js";
import { validateTenantTelemetryCaptureRestoreMaintenanceSelector } from "../../src/tenant-telemetry-capture-restore-store.js";
import type { ActivateTenantRestoreRuntimeInput } from "../../src/tenant-restore-journal.js";
import { verifySchemaMetadataProcedureIdentity } from "../../src/mysql/schema-metadata.js";
import { assertSchemaRuntimePrivileges } from "../../src/mysql/schema-runtime-privileges.js";
import { createMysqlOperationAbortTransport, bindMysqlOperationAbort } from "../../src/mysql/operation-abort.js";
import { CaptureMysqlInspection, type CaptureMysqlStoreSelection } from "./capture-mysql-runtime.js";
import { capturePrimaryJournalFixtureInput, captureRefKey } from "../persisted-provider-capture.fixture.js";
import { prepareMysqlRuntimeFixture, witnessAbsentMysqlFixtureDatabase } from "../../../../test/fixtures/mysql-runtime.mjs";
import { createMysqlSchemaCliExecutor } from "../../../../test/fixtures/mysql-schema-cli.mjs";
import { captureMysqlFixtureAuthorityCommand, createMysqlAuthorityCliExecutor } from "../../../../test/fixtures/mysql-authority-cli.mjs";

const failed = () => new Error("Capture MySQL epoch fixture ownership is not proven");
const at = (base: URL, database: string) => { const url = new URL(base); url.pathname = `/${database}`; return url.toString(); };
async function closeAfter<T>(work: () => Promise<T>, close: () => Promise<void>): Promise<T> {
  let failure: { reason: unknown } | undefined, value: T | undefined;
  try { value = await work(); } catch (reason) { failure = { reason }; }
  try { await close(); } catch (reason) { failure ??= { reason }; }
  if (failure) throw failure.reason; return value as T;
}
type Facade = Awaited<ReturnType<typeof MysqlSessionStore.connectTenantTelemetryCaptureRestoreMaintenance>>;
type SourceFacade = Awaited<ReturnType<typeof MysqlSessionStore.connectTenantTelemetryCaptureBackupSourceMaintenance>>;
type Closable = { close(): Promise<void> };
type Outcome = { state: "fulfilled" } | { state: "rejected"; reason: unknown };
type Account = { readonly user: string; readonly host: string; readonly password?: string; attempted: boolean; created: boolean };
declare const transitionBrand: unique symbol;
export interface CaptureMysqlEpochTransition { readonly [transitionBrand]: true }
declare const rollbackBrand: unique symbol;
export interface CaptureMysqlEpochRollbackWitness { readonly [rollbackBrand]: true }
type Transition = {
  readonly owner: CaptureMysqlEpochRuntimeOwner; readonly command: PreparedSessionAuthorityBindingCommand;
  readonly context: SessionAuthorityBindingOperatorContext; readonly account: Account;
  readonly before: ActiveSessionAuthorityBinding; readonly input?: Readonly<ActivateTenantRestoreRuntimeInput>;
  readonly selector?: Readonly<TenantTelemetryCaptureRestoreMaintenanceSelector>;
  readonly facades: Set<Closable>; readonly activations: Map<Promise<unknown>, Outcome | undefined>;
  state: "staged" | "ready" | "unknown" | "confirmed" | "unapplied-proved";
  confirming?: Promise<void>;
};
const transitions = new WeakMap<object, Transition>();
const rollbackWitnesses = new WeakMap<object, { owner: CaptureMysqlEpochRuntimeOwner; transition: Transition; sha256: string }>();

function selectedOptions(base: MysqlStoreOptions, selection?: CaptureMysqlStoreSelection): MysqlStoreOptions {
  const selected = { ...base };
  if (selection === undefined) return selected;
  if (!selection || typeof selection !== "object" || Object.getPrototypeOf(selection) !== Object.prototype) throw failed();
  const descriptors = Object.getOwnPropertyDescriptors(selection);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !["tenantTelemetryRefKey", "tenantTelemetryPersistedProviderCaptureLocalOnly",
      "tenantTelemetryCaptureRestoreLocalOnly", "tenantRedisPurgeNamespaceSha256"].includes(key)) throw failed();
    const descriptor = descriptors[key]!; if (!("value" in descriptor) || !descriptor.enumerable) throw failed();
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
function safeCreateError(reason: unknown): Error {
  const safe = new Error("capture_epoch_fixture_account_creation_failed");
  if (reason && typeof reason === "object") for (const key of ["code", "errno", "sqlState"] as const) {
    const value = Object.getOwnPropertyDescriptor(reason, key)?.value;
    if (key === "code" && typeof value === "string" && /^ER_[A-Z0-9_]{1,80}$/.test(value)
      || key === "errno" && Number.isSafeInteger(value) && value >= 0 && value <= 65535
      || key === "sqlState" && typeof value === "string" && /^[A-Z0-9]{5}$/.test(value))
      Object.defineProperty(safe, key, { value, enumerable: true });
  }
  return safe;
}

/** Current native tests only. Separate owner: the original once-primary helper is unchanged.
 * All epoch/account changes use original product transactions and the same fixed command confirm.
 * This owner is not an App/runtime adapter. Operator URLs stay private; ordinary Stores use only the restricted profile. */
export class CaptureMysqlEpochRuntimeOwner {
  readonly database = `agent_service_test_capture_epochs_${randomBytes(12).toString("hex")}`;
  private readonly base: URL;
  private readonly preparation = new AbortController();
  private readonly consumers = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly stores = new Set<MysqlSessionStore>();
  private readonly facades = new Set<Closable>();
  private readonly inspections = new Set<CaptureMysqlInspection>();
  private readonly sockets = new Map<Socket, Promise<void>>();
  private readonly nativeFailures: unknown[] = [];
  private readonly accounts: Account[] = [];
  private readonly epochs: Transition[] = [];
  private runtime: Awaited<ReturnType<typeof prepareMysqlRuntimeFixture>> | undefined;
  private initial: ReturnType<typeof captureMysqlFixtureAuthorityCommand>["command"] | undefined;
  private current: ActiveSessionAuthorityBinding | undefined;
  private currentAccount: Account | undefined;
  private currentOptions: MysqlStoreOptions | undefined;
  private uuid = "";
  private ready = false;
  private createAttempted = false;
  private preparing: Promise<void> | undefined;
  private primaryWork: Promise<void> | undefined;
  private staging = false;
  private unresolved: Transition | undefined;
  private closing: Promise<void> | undefined;

  constructor(operatorUrl: string) {
    try {
      this.base = new URL(operatorUrl);
      if (this.base.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(this.base.hostname)
        || this.base.search || this.base.hash || !/(?:^|[_-])test(?:$|[_-])/i.test(decodeURIComponent(this.base.pathname.slice(1)))) throw failed();
      this.base.pathname = "/mysql";
    } catch { throw failed(); }
  }
  private own<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work); void work.then(() => this.pending.delete(work), () => this.pending.delete(work)); return work;
  }
  /** Own original method Promises without a logical race. View never changes original receiver/args. */
  private ownFacade<T extends Closable>(facade: T, transition?: Transition): T {
    const view = Object.fromEntries(Object.entries(facade).map(([key, value]) => {
      if (typeof value !== "function") throw failed();
      return [key, (...args: unknown[]) => {
        const work: Promise<unknown> = Reflect.apply(value, facade, args);
        if (!(work instanceof Promise)) throw failed();
        if (transition && key === "activateTenantRestoreRuntime") {
          if (transition.state !== "confirmed") transition.state = "unknown";
          transition.activations.set(work, undefined);
          void work.then(() => transition.activations.set(work, { state: "fulfilled" }),
            reason => transition.activations.set(work, { state: "rejected", reason }));
        }
        return this.own(work);
      }];
    })) as T;
    Object.freeze(view); this.facades.add(view); transition?.facades.add(view); return view;
  }
  private async native<T>(url: string, work: (connection: PoolConnection) => Promise<T>): Promise<T> {
    const transport = createMysqlOperationAbortTransport(this.preparation.signal);
    let pool: ReturnType<typeof mysql.createPool> | undefined, scope: ReturnType<typeof bindMysqlOperationAbort> | undefined;
    let connection: PoolConnection | undefined, hasError = false, firstError: unknown, value: T | undefined;
    const remember = (reason: unknown) => { if (!hasError) { hasError = true; firstError = reason; } };
    try {
      pool = mysql.createPool({ uri: url, connectionLimit: 1, connectTimeout: 10_000, stream: transport.stream,
        supportBigNumbers: true, bigNumberStrings: false, timezone: "Z" });
      scope = bindMysqlOperationAbort(pool, this.preparation.signal, transport);
      connection = await pool.getConnection();
      const [identity] = await connection.query<RowDataPacket[]>("SELECT @@GLOBAL.server_uuid AS uuid,DATABASE() AS db");
      const expectedDatabase = decodeURIComponent(new URL(url).pathname.slice(1));
      if (identity.length !== 1 || typeof identity[0]?.uuid !== "string" || !/^[a-f0-9-]{36}$/.test(identity[0].uuid)
        || identity[0].db !== expectedDatabase || this.uuid && identity[0].uuid !== this.uuid) throw failed();
      if (!this.uuid) this.uuid = identity[0].uuid;
      value = await work(connection);
    } catch (reason) { remember(reason); }
    finally {
      try { if (hasError) connection?.destroy(); else connection?.release(); } catch (reason) { remember(reason); }
      try { if (scope) await scope.close(); else if (pool) await pool.end(); } catch (reason) { remember(reason); }
      transport.close(); await transport.settled();
    }
    if (hasError) throw firstError; return value as T;
  }
  prepare(): Promise<void> {
    if (this.preparing) return this.preparing;
    if (this.closing) return Promise.reject(failed());
    return this.preparing = this.own((async () => {
      const url = at(this.base, this.database);
      const witness = await witnessAbsentMysqlFixtureDatabase({ operatorUrl: url, applicationDatabase: this.database,
        operationAbortSignal: this.preparation.signal });
      this.createAttempted = true;
      await this.native(at(this.base, "mysql"), async conn => {
        await conn.query(`CREATE DATABASE ${mysql.escapeId(this.database)} CHARACTER SET utf8mb4`);
      });
      const cwd = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
      const entrypoint = fileURLToPath(new URL("../../../../apps/agent-runner/src/main.ts", import.meta.url));
      this.runtime = await prepareMysqlRuntimeFixture(witness, {
        schemaExecutor: createMysqlSchemaCliExecutor({ entrypoint, mode: "source", cwd }),
        authorityExecutor: async operation => {
          this.initial = captureMysqlFixtureAuthorityCommand(operation.command).command;
          await createMysqlAuthorityCliExecutor({ entrypoint, mode: "source", cwd })(operation);
        },
      });
      await this.runtime.assertReusable(url);
      if (!this.initial || this.initial.newAccounts.length !== 1) throw failed();
      const account = this.initial.newAccounts[0]!;
      this.currentAccount = { user: account.user, host: account.host, attempted: true, created: true };
      this.accounts.push(this.currentAccount);
      this.currentOptions = { ...this.runtime.runtimeStoreOptions, tenantTelemetryRefKey: captureRefKey,
        tenantTelemetryPersistedProviderCaptureLocalOnly: true, tenantTelemetryCaptureRestoreLocalOnly: true };
      if (this.uuid !== this.initial.serverUuid) throw failed();
      this.current = await this.native(url, conn => loadActiveSessionAuthorityBinding(conn, false));
      if (this.current.bindingId !== this.initial.bindingId || this.current.bindingSequence !== 1
        || this.current.serverUuid !== this.uuid || this.current.applicationDatabase !== this.database) throw failed();
      this.ready = true;
    })());
  }
  openStore(limit: number, signal?: AbortSignal, selection?: CaptureMysqlStoreSelection): Promise<MysqlSessionStore> {
    if (!this.ready || this.closing || this.staging || this.unresolved || !this.currentOptions) return Promise.reject(failed());
    const options = selectedOptions(this.currentOptions, selection);
    const abortSignal = signal ? AbortSignal.any([this.consumers.signal, signal]) : this.consumers.signal;
    return this.own(MysqlSessionStore.connect({ ...options, connectionLimit: limit, operationAbortSignal: abortSignal })
      .then(store => { this.stores.add(store); return store; }));
  }
  openInspection(signal?: AbortSignal): Promise<CaptureMysqlInspection> {
    if (!this.ready || this.closing) return Promise.reject(failed());
    const aborted = signal ? AbortSignal.any([this.consumers.signal, signal]) : this.consumers.signal;
    return this.own((async () => {
      let connection: Connection | undefined, socket: Socket | undefined;
      const abort = () => {
        try { connection?.destroy(); } catch (reason) { this.nativeFailures.push(reason); }
        try { socket?.destroy(); } catch (reason) { this.nativeFailures.push(reason); }
      };
      aborted.addEventListener("abort", abort, { once: true });
      try {
        aborted.throwIfAborted();
        connection = await mysql.createConnection({ uri: at(this.base, this.database), connectTimeout: 10_000,
          stream: (options: { config: { host: string; port: number } }) => {
            if (socket) throw failed(); socket = createSocket({ host: options.config.host, port: options.config.port });
            const closed = new Promise<void>(resolve => socket!.once("close", () => resolve()));
            this.sockets.set(socket, closed); void closed.then(() => this.sockets.delete(socket!));
            if (aborted.aborted) queueMicrotask(abort); return socket;
          } });
        if (!socket || aborted.aborted) throw failed();
        const inspection = new CaptureMysqlInspection(connection, socket, this.sockets.get(socket)!, aborted,
          () => aborted.removeEventListener("abort", abort));
        this.inspections.add(inspection);
        const [identity] = await inspection.query<RowDataPacket[]>("SELECT @@server_uuid AS uuid,DATABASE() AS db");
        if (identity.length !== 1 || identity[0]?.uuid !== this.uuid || identity[0]?.db !== this.database) throw failed();
        return inspection;
      } catch (error) {
        abort(); if (socket) await this.sockets.get(socket); aborted.removeEventListener("abort", abort); throw error;
      }
    })());
  }
  openRestoreRead(selector: TenantTelemetryCaptureRestoreMaintenanceSelector, key: Uint8Array = captureRefKey): Promise<Facade> {
    if (!this.ready || this.closing || this.staging || this.unresolved) return Promise.reject(failed());
    const refKey = Buffer.from(key);
    return this.own(MysqlSessionStore.connectTenantTelemetryCaptureRestoreMaintenance({ url: at(this.base, this.database),
      tenantTelemetryRefKey: refKey, selector, operationAbortSignal: this.consumers.signal },
      { kind: "stopped-fleet-maintenance", fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1" })
      .then(facade => this.ownFacade(facade)));
  }
  openBackupSource(): Promise<SourceFacade> {
    if (!this.ready || this.closing || this.staging || this.unresolved) return Promise.reject(failed());
    return this.own(MysqlSessionStore.connectTenantTelemetryCaptureBackupSourceMaintenance({ url: at(this.base, this.database),
      tenantTelemetryRefKey: captureRefKey, fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1",
      operationAbortSignal: this.consumers.signal },
      { kind: "stopped-fleet-maintenance", fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1" })
      .then(facade => this.ownFacade(facade)));
  }
  private transition(token: CaptureMysqlEpochTransition): Transition {
    const value = transitions.get(token); if (!value || value.owner !== this) throw failed(); return value;
  }
  private async drainAccepted(accepted: readonly Promise<unknown>[]): Promise<void> {
    let failure: { reason: unknown } | undefined;
    for (const result of await Promise.allSettled(accepted)) if (result.status === "rejected") failure ??= { reason: result.reason };
    const closing = await Promise.allSettled([...this.stores].map(store => store.close()).concat([...this.facades].map(facade => facade.close())));
    for (const result of closing) if (result.status === "rejected") failure ??= { reason: result.reason };
    if (failure) throw failure.reason;
  }
  private async stage(next: (conn: PoolConnection) => Promise<{ nextEpoch: SessionAuthorityNextEpoch;
    input?: Readonly<ActivateTenantRestoreRuntimeInput>; selector?: Readonly<TenantTelemetryCaptureRestoreMaintenanceSelector> }>,
    accepted: readonly Promise<unknown>[]): Promise<CaptureMysqlEpochTransition> {
    await this.drainAccepted(accepted);
    const before = this.current, old = this.currentAccount, options = this.currentOptions;
    if (!before || !old || !options?.schemaMetadata) throw failed();
    const snapshot = await this.native(at(this.base, this.database), async conn => {
      await conn.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"); await conn.beginTransaction();
      try {
        const active = await loadActiveSessionAuthorityBinding(conn, true);
        if (active.bindingId !== before.bindingId || active.bindingSequence !== before.bindingSequence) throw failed();
        const source = await readSessionAuthorityBindingSource(conn), selected = await next(conn);
        await conn.commit(); return { source, ...selected };
      } catch (reason) { try { await conn.rollback(); } catch (rollback) { this.nativeFailures.push(rollback); } throw reason; }
    });
    const account: Account = { user: "mce_r_" + randomBytes(8).toString("hex"), host: old.host,
      password: randomBytes(32).toString("hex"), attempted: false, created: false };
    const command = prepareSessionAuthorityBindingCommand({ bindingId: randomUUID(), activationId: randomUUID(),
      expectedBindingId: before.bindingId, expectedSequence: before.bindingSequence, serverUuid: this.uuid,
      applicationDatabase: this.database, newAccounts: [{ user: account.user, host: account.host }],
      oldAccountNames: this.accounts.map(value => value.user),
      activationEvidenceSha256: createHash("sha256").update(JSON.stringify(["capture-epochs-fixture-v1", before.bindingId,
        this.database, account.user, snapshot.nextEpoch.activationRequestSha256])).digest("hex"),
      expectedSource: snapshot.source, nextEpoch: snapshot.nextEpoch });
    const context = Object.freeze({ command, schemaMetadata: options.schemaMetadata, assertNativeAdmission: assertSessionAuthorityActivationAdmission });
    const record: Transition = { owner: this, command, context, account, before, input: snapshot.input,
      selector: snapshot.selector, state: "staged", facades: new Set(), activations: new Map() };
    const token = Object.freeze({}) as CaptureMysqlEpochTransition;
    transitions.set(token, record); this.epochs.push(record); this.unresolved = record;
    this.accounts.push(account); // Record CREATE uncertainty before any account mutation.
    await this.native(at(this.base, "mysql"), async conn => {
      const users = this.accounts.map(value => value.user);
      const [rows] = await conn.query<RowDataPacket[]>(`SELECT User,Host,account_locked FROM mysql.user WHERE User IN (${users.map(() => "?").join(",")})`, users);
      if (rows.length !== this.accounts.length - 1 || this.accounts.filter(value => value !== account).some(value =>
        rows.filter(row => row.User === value.user && row.Host === value.host && row.account_locked === (value === old ? "N" : "Y")).length !== 1)) throw failed();
      const [busy] = await conn.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE USER IN (${users.map(() => "?").join(",")})`, users);
      if (busy.length !== 1 || Number(busy[0]?.n) !== 0) throw failed();
      await conn.query(`REVOKE SHOW_ROUTINE ON *.* FROM ${mysql.escape(old.user)}@${mysql.escape(old.host)}`);
      await conn.query(`REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${mysql.escape(old.user)}@${mysql.escape(old.host)}`);
      await conn.query(`ALTER USER ${mysql.escape(old.user)}@${mysql.escape(old.host)} ACCOUNT LOCK`);
      account.attempted = true;
      try { await conn.query(`CREATE USER ${mysql.escape(account.user)}@${mysql.escape(account.host)} IDENTIFIED BY ?`, [account.password]); }
      catch (reason) { throw safeCreateError(reason); }
      account.created = true;
      const [tables] = await conn.query<RowDataPacket[]>("SELECT TABLE_NAME FROM information_schema.TABLES WHERE BINARY TABLE_SCHEMA=BINARY ? AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME", [this.database]);
      const names = tables.map(row => row.TABLE_NAME as string), controls = ["schema_migrations", "session_authority_control", "session_authority_bindings", "session_authority_runtime_accounts"];
      if (!names.length || new Set(names).size !== names.length || names.some(name => !/^[a-z0-9_]+$/.test(name)) || controls.some(name => !names.includes(name))) throw failed();
      for (const name of names) await conn.query(`GRANT ${controls.includes(name) ? "SELECT" : "SELECT,INSERT,UPDATE,DELETE"} ON ${mysql.escapeId(this.database)}.${mysql.escapeId(name)} TO ${mysql.escape(account.user)}@${mysql.escape(account.host)}`);
      await conn.query(`GRANT SHOW_ROUTINE ON *.* TO ${mysql.escape(account.user)}@${mysql.escape(account.host)}`);
      await conn.query(`GRANT EXECUTE ON PROCEDURE ${mysql.escapeId(options.schemaMetadata!.metadataSchema)}.${mysql.escapeId(createHash("sha256").update(this.database).digest("hex"))} TO ${mysql.escape(account.user)}@${mysql.escape(account.host)}`);
    });
    record.state = "ready"; return token;
  }
  primary(): Promise<void> {
    if (this.primaryWork) return this.primaryWork;
    if (!this.ready || this.closing || this.staging || this.unresolved) return Promise.reject(failed());
    const input = capturePrimaryJournalFixtureInput();
    const request = captureSessionAuthorityActivationRequest(prepareSessionAuthorityActivationRequest("primary_activation", input));
    const accepted = [...this.pending]; this.staging = true;
    return this.primaryWork = this.own((async () => {
      try {
        const token = await this.stage(async () => ({ nextEpoch: { kind: "primary_activation", runtimeEpochSha256: input.runtimeEpochSha256,
          restoreRunId: null, activationRequestSha256: request.activationRequestSha256, sealedReplayReceiptSha256: null } }), accepted);
        const record = this.transition(token);
        const facade = await this.own(MysqlSessionStore.connectRestoreJournalMaintenance({ url: at(this.base, this.database),
          tenantTelemetryRefKey: captureRefKey, operationAbortSignal: this.consumers.signal }, { kind: "operator-maintenance", binding: record.context })
          .then(value => this.ownFacade(value, record)));
        await closeAfter(async () => { await facade.activateTenantRestoreJournalControl(input); await this.confirmRecord(record, facade); }, () => facade.close());
      } finally { this.staging = false; }
    })());
  }
  stageRestore(input: ActivateTenantRestoreRuntimeInput, selector: TenantTelemetryCaptureRestoreMaintenanceSelector): Promise<CaptureMysqlEpochTransition> {
    if (!this.ready || this.closing || this.staging || this.unresolved || !this.primaryWork
      || !this.epochs.some(record => record.state === "confirmed"
        && captureSessionAuthorityBindingCommand(record.command).nextEpoch?.kind === "primary_activation")) return Promise.reject(failed());
    const request = captureSessionAuthorityActivationRequest(prepareSessionAuthorityActivationRequest("restore_activation", input));
    if (request.kind !== "restore_activation") return Promise.reject(failed());
    validateTenantTelemetryCaptureRestoreMaintenanceSelector(selector);
    const captured = Object.freeze(structuredClone(selector));
    if (request.input.restoreRunId !== captured.restoreRunId) return Promise.reject(failed());
    const accepted = [...this.pending]; this.staging = true;
    return this.own((async () => {
      try {
        return await this.stage(async conn => {
          const [rows] = await conn.query<RowDataPacket[]>("SELECT phase,runtime_epoch_sha256,terminal_receipt_sha256 FROM tenant_restore_replay_runs WHERE BINARY restore_run_id=BINARY ? FOR SHARE", [captured.restoreRunId]);
          const row = rows[0];
          if (rows.length !== 1 || row?.phase !== "replay_sealed" || typeof row.runtime_epoch_sha256 !== "string"
            || typeof row.terminal_receipt_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.terminal_receipt_sha256)) throw failed();
          return { input: request.input, selector: captured, nextEpoch: { kind: "restore_activation", runtimeEpochSha256: row.runtime_epoch_sha256,
            restoreRunId: captured.restoreRunId, activationRequestSha256: request.activationRequestSha256, sealedReplayReceiptSha256: row.terminal_receipt_sha256 } };
        }, accepted);
      } finally { this.staging = false; }
    })());
  }
  openActivationFacade(token: CaptureMysqlEpochTransition, limit?: number): Promise<Facade> {
    const record = this.transition(token);
    if (this.closing || !record.selector || !["ready", "unknown", "confirmed", "unapplied-proved"].includes(record.state)) return Promise.reject(failed());
    return this.own(MysqlSessionStore.connectTenantTelemetryCaptureRestoreMaintenance({ url: at(this.base, this.database),
      ...(limit === undefined ? {} : { connectionLimit: limit }), tenantTelemetryRefKey: captureRefKey,
      selector: record.selector, operationAbortSignal: this.consumers.signal },
      { kind: "operator-maintenance", binding: record.context }).then(value => this.ownFacade(value, record)));
  }
  private confirmRecord(record: Transition, facade: Closable & { confirmSessionAuthorityBinding(): Promise<void> }): Promise<void> {
    if (!record.facades.has(facade) || this.closing) return Promise.reject(failed());
    if (record.confirming) return record.confirming;
    const work = this.own((async () => {
      // Never publish a successor while another actual activation call on its token is unresolved.
      await Promise.allSettled([...record.activations.keys()]);
      // void means success only after the actual same-command confirm transaction completes.
      await facade.confirmSessionAuthorityBinding();
      const command = captureSessionAuthorityBindingCommand(record.command);
      const active = await this.native(at(this.base, this.database), conn => loadActiveSessionAuthorityBinding(conn, false));
      if (active.bindingId !== command.bindingId || active.bindingSequence !== command.expectedSequence + 1
        || active.serverUuid !== this.uuid || active.applicationDatabase !== this.database) throw failed();
      const url = new URL(at(this.base, this.database)); url.username = record.account.user; url.password = record.account.password!;
      this.current = active; this.currentAccount = record.account;
      this.currentOptions = { ...this.runtime!.runtimeStoreOptions, url: url.toString(), tenantTelemetryRefKey: captureRefKey,
        tenantTelemetryPersistedProviderCaptureLocalOnly: true, tenantTelemetryCaptureRestoreLocalOnly: true };
      record.state = "confirmed"; if (this.unresolved === record) this.unresolved = undefined;
    })());
    record.confirming = work;
    void work.catch(() => { if (record.confirming === work) record.confirming = undefined; });
    return work;
  }
  confirm(token: CaptureMysqlEpochTransition, facade: Facade): Promise<void> {
    return this.confirmRecord(this.transition(token), facade);
  }
  private rowsSha256(): Promise<string> {
    return this.native(at(this.base, this.database), async conn => {
      await conn.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await conn.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
      try {
        const [tables] = await conn.query<RowDataPacket[]>("SELECT TABLE_NAME FROM information_schema.TABLES WHERE BINARY TABLE_SCHEMA=BINARY ? AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME", [this.database]);
        const hash = createHash("sha256");
        for (const table of tables) {
          const name = table.TABLE_NAME; if (typeof name !== "string" || !/^[a-z0-9_]+$/.test(name)) throw failed();
          const [rows] = await conn.query<RowDataPacket[]>(`SELECT * FROM ${mysql.escapeId(name)}`);
          hash.update(JSON.stringify([name, rows.map(row => JSON.stringify(row)).sort()]));
        }
        await conn.commit(); return hash.digest("hex");
      } catch (reason) { try { await conn.rollback(); }
        catch (rollback) { this.nativeFailures.push(rollback); } throw reason; }
    });
  }
  snapshotForRollback(token: CaptureMysqlEpochTransition): Promise<CaptureMysqlEpochRollbackWitness> {
    const record = this.transition(token);
    if (record.state !== "ready" || record.activations.size !== 0 || this.closing) return Promise.reject(failed());
    return this.own((async () => {
      const sha256 = await this.rowsSha256();
      if (record.state !== "ready" || record.activations.size !== 0) throw failed();
      const witness = Object.freeze({}) as CaptureMysqlEpochRollbackWitness;
      rollbackWitnesses.set(witness, { owner: this, transition: record, sha256 }); return witness;
    })());
  }
  proveLateHistoryRollback(token: CaptureMysqlEpochTransition, activation: Promise<unknown>, witness: CaptureMysqlEpochRollbackWitness): Promise<void> {
    const record = this.transition(token), before = rollbackWitnesses.get(witness);
    if (!before || before.owner !== this || before.transition !== record || !record.activations.has(activation) || this.closing) return Promise.reject(failed());
    return this.own((async () => {
      await Promise.allSettled([activation]);
      const outcome = record.activations.get(activation);
      if (outcome?.state !== "rejected" || !(outcome.reason instanceof Error)) throw failed();
      const field = (name: string) => Object.getOwnPropertyDescriptor(outcome.reason, name)?.value;
      if (field("code") !== "ER_SIGNAL_EXCEPTION" || field("sqlState") !== "45000" || field("sqlMessage") !== "isolated late history reject") throw failed();
      if (await this.rowsSha256() !== before.sha256) throw failed();
      record.state = "unapplied-proved";
    })());
  }
  close(input: { successful: boolean; readiness: "ordinary-ready" | "history-only" | "prepared" | "structure-after-intentional-data-corruption";
    expectedUnapplied?: CaptureMysqlEpochTransition }): Promise<void> {
    if (this.closing) return this.closing;
    if (!input || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).some(key => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      return typeof key !== "string" || !["successful", "readiness", "expectedUnapplied"].includes(key)
        || !descriptor?.enumerable || !("value" in descriptor);
    }) || typeof input.successful !== "boolean" || !["ordinary-ready", "history-only", "prepared", "structure-after-intentional-data-corruption"].includes(input.readiness)) return Promise.reject(failed());
    const successfulRequested = input.successful, readiness = input.readiness;
    const unapplied = input.expectedUnapplied === undefined ? undefined : this.transition(input.expectedUnapplied);
    if (!this.ready || this.pending.size) this.preparation.abort(); this.consumers.abort();
    return this.closing = (async () => {
      let failure: { reason: unknown } | undefined;
      const remember = (reason: unknown) => { failure ??= { reason }; };
      while (this.pending.size) await Promise.allSettled([...this.pending]);
      for (const result of await Promise.allSettled([...this.stores].map(store => store.close()).concat(
        [...this.facades].map(facade => facade.close()), [...this.inspections].map(value => value.end())))) if (result.status === "rejected") remember(result.reason);
      while (this.sockets.size) await Promise.all([...this.sockets.values()]);
      for (const reason of this.nativeFailures) remember(reason);
      let successful = successfulRequested && this.ready && !this.preparation.signal.aborted && !failure;
      try {
        await this.runtime?.close({ successful: false });
        if (successful) {
          if (!this.runtime || !this.current || !this.currentOptions || !this.currentAccount || !this.initial) throw failed();
          if (this.unresolved !== unapplied || unapplied && (unapplied.state !== "unapplied-proved" || readiness !== "prepared")) throw failed();
          const currentEpoch = this.epochs.find(record => captureSessionAuthorityBindingCommand(record.command).bindingId === this.current!.bindingId);
          if (readiness === "history-only" && (!currentEpoch || currentEpoch.state !== "confirmed"
            || captureSessionAuthorityBindingCommand(currentEpoch.command).nextEpoch?.kind !== "restore_activation")) throw failed();
          if (readiness !== "ordinary-ready" || unapplied) {
            await MysqlSessionStore.runSchemaOperation({ url: at(this.base, this.database), operation: "verify", operationAbortSignal: this.preparation.signal });
          }
          const config = this.currentOptions.schemaMetadata; if (!config) throw failed();
          if (unapplied) {
            await this.native(at(this.base, this.database), async conn => {
              await conn.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"); await conn.beginTransaction();
              try { await preflightSessionAuthorityBinding(conn, unapplied.context); await conn.commit(); }
              catch (reason) { try { await conn.rollback(); } catch (rollback) { this.nativeFailures.push(rollback); } throw reason; }
            });
            const url = new URL(at(this.base, this.database)); url.username = unapplied.account.user; url.password = unapplied.account.password!;
            // Unbound staged Rn is checked as a real native *profile*, never active membership.
            await this.native(url.toString(), async conn => { await assertSchemaRuntimePrivileges(conn, config);
              await verifySchemaMetadataProcedureIdentity(conn, this.database, config); });
          } else {
            await this.native(this.currentOptions.url, async conn => {
              await assertSessionAuthorityRuntimeConnection(conn, config); await verifySchemaMetadataProcedureIdentity(conn, this.database, config);
              const active = await loadActiveSessionAuthorityBinding(conn, false);
              if (active.bindingId !== this.current!.bindingId || active.bindingSequence !== this.current!.bindingSequence) throw failed();
            });
            if (readiness === "ordinary-ready") {
              const store = await MysqlSessionStore.connect({ ...this.currentOptions, connectionLimit: 1, operationAbortSignal: this.preparation.signal });
              await closeAfter(() => store.sessionAuthority.identity(), () => store.close());
            }
          }
          await this.native(at(this.base, "mysql"), async conn => {
            const current = unapplied?.account ?? this.currentAccount!;
            const expected = [{ user: config.trustedDefiner.user, host: config.trustedDefiner.host, locked: "Y" },
              ...this.accounts.map(value => ({ user: value.user, host: value.host, locked: value === current ? "N" : "Y" }))];
            const [accounts] = await conn.query<RowDataPacket[]>(`SELECT User,Host,account_locked FROM mysql.user WHERE User IN (${expected.map(() => "?").join(",")})`, expected.map(value => value.user));
            if (accounts.length !== expected.length || expected.some(value => accounts.filter(row => row.User === value.user && row.Host === value.host && row.account_locked === value.locked).length !== 1)) throw failed();
            for (const account of this.accounts.filter(value => value !== current)) {
              const [grants] = await conn.query<RowDataPacket[]>(`SHOW GRANTS FOR ${mysql.escape(account.user)}@${mysql.escape(account.host)}`);
              if (grants.length !== 1 || Object.values(grants[0]!).length !== 1
                || Object.values(grants[0]!)[0] !== ("GRANT USAGE ON *.* TO `" + account.user + "`@`" + account.host + "`")) throw failed();
            }
            const [schemas] = await conn.query<RowDataPacket[]>("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ? OR BINARY SCHEMA_NAME=BINARY ?", [this.database, config.metadataSchema]);
            if (schemas.length !== 2 || new Set(schemas.map(row => row.SCHEMA_NAME)).size !== 2) throw failed();
            for (const name of [this.database, config.metadataSchema]) {
              for (const [sql, values] of [
                ["SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE BINARY DB=BINARY ?", [name]],
                ["SELECT COUNT(*) AS n FROM information_schema.INNODB_TRX t JOIN information_schema.PROCESSLIST p ON p.ID=t.trx_mysql_thread_id WHERE BINARY p.DB=BINARY ?", [name]],
                ["SELECT COUNT(*) AS n FROM performance_schema.metadata_locks WHERE BINARY OBJECT_SCHEMA=BINARY ? OR (OBJECT_TYPE='SCHEMA' AND BINARY OBJECT_NAME=BINARY ?)", [name, name]],
              ] as const) { const [rows] = await conn.query<RowDataPacket[]>(sql, [...values]); if (rows.length !== 1 || Number(rows[0]?.n) !== 0) throw failed(); }
            }
            for (const account of expected) { const [rows] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE BINARY USER=BINARY ?", [account.user]); if (rows.length !== 1 || Number(rows[0]?.n) !== 0) throw failed(); }
            for (const name of [this.database, config.metadataSchema]) {
              await conn.query(`DROP DATABASE ${mysql.escapeId(name)}`);
              const [rows] = await conn.query<RowDataPacket[]>("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", [name]); if (rows.length) throw failed();
            }
            for (const account of expected) {
              await conn.query(`DROP USER ${mysql.escape(account.user)}@${mysql.escape(account.host)}`);
              const [rows] = await conn.query<RowDataPacket[]>("SELECT User FROM mysql.user WHERE BINARY User=BINARY ?", [account.user]); if (rows.length) throw failed();
            }
          });
        }
      } catch (reason) { successful = false; remember(reason); }
      finally {
        if (!successful && this.createAttempted) console.warn(JSON.stringify({ schema: "capture-epochs-fixture-retained-v1", applicationDatabase: this.database,
          metadataSchema: this.runtime?.runtimeEnv.MYSQL_SCHEMA_METADATA_SCHEMA, ownedAccounts: this.accounts.map(value => ({ user: value.user, host: value.host, createAttempted: value.attempted })),
          metadataDefiner: this.runtime?.runtimeEnv.MYSQL_SCHEMA_METADATA_DEFINER_USER ?? null, status: "retained_or_unknown" }));
        this.preparation.abort();
        for (const result of await Promise.allSettled([...this.inspections].map(value => value.end()))) if (result.status === "rejected") remember(result.reason);
        while (this.sockets.size) await Promise.all([...this.sockets.values()]);
      }
      for (const reason of this.nativeFailures) remember(reason);
      if (failure) throw failure.reason;
    })();
  }
}
