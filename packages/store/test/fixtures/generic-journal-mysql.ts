import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createConnection as createSocket, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdtemp, open, realpath, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import mysql, { type Connection, type PoolConnection, type RowDataPacket } from "mysql2/promise";
import { MysqlSessionStore, prepareSessionAuthorityBindingCommand, assertSessionAuthorityActivationAdmission,
  TenantErasureIntegrityError, type ActivateTenantRestoreJournalControlInput, type MysqlStoreOptions } from "../../src/index.js";
import { assertSessionAuthorityRuntimeConnection, loadActiveSessionAuthorityBinding,
  readSessionAuthorityBindingSource, captureSessionAuthorityBindingCommand,
  prepareSessionAuthorityActivationRequest, captureSessionAuthorityActivationRequest } from "../../src/mysql/session-authority-binding.js";
import type { PreparedSessionAuthorityBindingCommand, SessionAuthorityBindingOperatorContext,
  ActiveSessionAuthorityBinding, SessionAuthorityNextEpoch } from "../../src/mysql/session-authority-binding-types.js";
import type { ActivateTenantRestoreRuntimeInput } from "../../src/tenant-restore-journal.js";
import { verifySchemaMetadataProcedureIdentity } from "../../src/mysql/schema-metadata.js";
import { createMysqlOperationAbortTransport, bindMysqlOperationAbort } from "../../src/mysql/operation-abort.js";
import { CaptureMysqlInspection, captureMysqlNamedFreshDatabase, type CaptureMysqlNamedFreshSelection } from "./capture-mysql-runtime.js";
import { prepareMysqlRuntimeFixture, witnessAbsentMysqlFixtureDatabase } from "../../../../test/fixtures/mysql-runtime.mjs";
import { createMysqlSchemaCliExecutor } from "../../../../test/fixtures/mysql-schema-cli.mjs";
import { captureMysqlFixtureAuthorityCommand, createMysqlAuthorityCliExecutor } from "../../../../test/fixtures/mysql-authority-cli.mjs";

const failed = () => new Error("Generic journal MySQL fixture ownership is not proven");
const at = (base: URL, database: string) => { const url = new URL(base); url.pathname = `/${database}`; return url.toString(); };
async function closeAfter<T>(work: () => Promise<T>, close: () => Promise<void>): Promise<T> {
  let failure: { reason: unknown } | undefined, value: T | undefined;
  try { value = await work(); } catch (reason) { failure = { reason }; }
  try { await close(); } catch (reason) { failure ??= { reason }; }
  if (failure) throw failure.reason; return value as T;
}
type ActualNativePool = ReturnType<typeof mysql.createPool>;
type NativeTxMethod = 'beginTransaction' | 'commit' | 'rollback';
type NativeActivationAttempt = {
  raw?: Promise<unknown>; facade?: Closable; connection?: PoolConnection; threadId?: number; complete: boolean; invalid: boolean;
  calls: Record<NativeTxMethod, number>; completed: Record<NativeTxMethod, number>;
  failed: Record<NativeTxMethod, number>; trace: string[];
};
/** Public native surfaces only. Installation happens AFTER startup, activation windows before dispatch. */
class NativeActivationObserver {
  private active: NativeActivationAttempt | undefined;
  private readonly installed = new WeakSet<PoolConnection>();
  private readonly restores: Array<() => void> = [];
  private restored = false;
  constructor(private readonly pool: ActualNativePool) {
    const owner = this, original = pool.getConnection, descriptor = Object.getOwnPropertyDescriptor(pool, 'getConnection');
    const wrapped: typeof pool.getConnection = function(this: ActualNativePool, ...args: Parameters<ActualNativePool['getConnection']>) {
      const accepted = owner.active;
      const work = Reflect.apply(original, this, args) as ReturnType<ActualNativePool['getConnection']>;
      // Bind the invocation window, never a later activation which happens to overlap completion.
      // Register before the consumer's await, but return the identical original borrow Promise.
      void work.then(connection => {
        const attempt = accepted;
        if (!attempt) return;
        if (owner.active !== attempt) attempt.invalid = true;
        if (this !== pool || attempt.connection && attempt.connection !== connection
          || !Number.isSafeInteger(connection.threadId) || connection.threadId < 1) attempt.invalid = true;
        attempt.connection ??= connection; attempt.threadId ??= connection.threadId;
        try { owner.installConnection(connection); } catch { attempt.invalid = true; }
      }, () => { if (accepted) accepted.invalid = true; });
      return work;
    };
    pool.getConnection = wrapped;
    this.restores.push(() => { if (descriptor) Object.defineProperty(pool, 'getConnection', descriptor); else Reflect.deleteProperty(pool, 'getConnection'); });
  }
  private installConnection(connection: PoolConnection): void {
    if (this.installed.has(connection)) return;
    this.installed.add(connection);
    for (const key of ['beginTransaction', 'commit', 'rollback'] as const) {
      const owner = this, original = connection[key], descriptor = Object.getOwnPropertyDescriptor(connection, key);
      const wrapped: PoolConnection[typeof key] = function(this: PoolConnection, ...args: Parameters<PoolConnection[typeof key]>) {
        const attempt = owner.active;
        if (attempt) {
          if (attempt.connection !== this || this !== connection) attempt.invalid = true;
          attempt.calls[key]++; attempt.trace.push(key + ':called');
        }
        let work: ReturnType<PoolConnection[typeof key]>;
        try { work = Reflect.apply(original, this, args) as ReturnType<PoolConnection[typeof key]>; }
        catch (reason) { if (attempt) { attempt.failed[key]++; attempt.invalid = true; } throw reason; }
        void work.then(() => { if (attempt) { attempt.completed[key]++; attempt.trace.push(key + ':completed'); } },
          () => { if (attempt) { attempt.failed[key]++; attempt.trace.push(key + ':failed'); } });
        return work;
      };
      connection[key] = wrapped;
      this.restores.push(() => { if (descriptor) Object.defineProperty(connection, key, descriptor); else Reflect.deleteProperty(connection, key); });
    }
  }
  start(): NativeActivationAttempt {
    if (this.active || this.restored) throw failed();
    const zero = () => ({ beginTransaction: 0, commit: 0, rollback: 0 });
    return this.active = { complete: false, invalid: false, calls: zero(), completed: zero(), failed: zero(), trace: [] };
  }
  bind(attempt: NativeActivationAttempt, raw: Promise<unknown>): void {
    if (this.active !== attempt || attempt.raw) throw failed(); attempt.raw = raw;
  }
  finish(attempt: NativeActivationAttempt): void {
    if (this.active !== attempt) { attempt.invalid = true; return; }
    attempt.complete = true; this.active = undefined;
  }
  abandon(attempt: NativeActivationAttempt): void { attempt.invalid = true; this.finish(attempt); }
  restore(): void {
    if (this.restored) return;
    if (this.active) throw failed();
    let failure: { reason: unknown } | undefined;
    for (const restore of [...this.restores].reverse()) try { restore(); } catch (reason) { failure ??= { reason }; }
    this.restored = true; if (failure) throw failure.reason;
  }
}

type Facade = Awaited<ReturnType<typeof MysqlSessionStore.connectRestoreJournalMaintenance>>;
type Closable = { close(): Promise<void> };
type Outcome = { state: "fulfilled" } | { state: "rejected"; reason: unknown };
/** The original source CLI's synchronous spawnSync result; no result here proves database success. */
export interface GenericJournalMysqlCliResult {
  readonly status: number | null; readonly signal: NodeJS.Signals | null;
  readonly stdout: string; readonly stderr: string;
}
type OwnedCliCommandFile = {
  readonly directory: string; readonly path: string;
  directoryIdentity?: string; fileIdentity?: string; sha256?: string;
};
function privateDirectoryIdentity(stat: Stats): string {
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o700) throw failed();
  return [stat.dev, stat.ino, stat.uid, stat.mode].join(":");
}
function privateFileIdentity(stat: Stats): string {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.nlink !== 1
    || (stat.mode & 0o7777) !== 0o600 || stat.size < 2 || stat.size > 65_536) throw failed();
  return [stat.dev, stat.ino, stat.uid, stat.mode, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}
type Account = { readonly user: string; readonly host: string; readonly password?: string; attempted: boolean; created: boolean };
declare const transitionBrand: unique symbol;
export interface GenericJournalMysqlTransition { readonly [transitionBrand]: true }
declare const rollbackBrand: unique symbol;
export interface GenericJournalMysqlRollbackWitness { readonly [rollbackBrand]: true }
type Transition = {
  readonly owner: GenericJournalMysqlRuntimeOwner; readonly command: PreparedSessionAuthorityBindingCommand;
  readonly context: SessionAuthorityBindingOperatorContext; readonly account: Account;
  readonly before: ActiveSessionAuthorityBinding; readonly predecessorRuntimeHead: Readonly<{ generation: number; evidenceSha256: string | null }>; readonly input?: Readonly<ActivateTenantRestoreRuntimeInput>;
  readonly facades: Set<Closable>; readonly activations: Map<Promise<unknown>, Outcome | undefined>;
  readonly attempts: Map<Promise<unknown>, NativeActivationAttempt>;
  state: "staged" | "ready" | "unknown" | "confirmed" | "unapplied-proved";
  confirming?: Promise<void>;
  cliWork?: Promise<GenericJournalMysqlCliResult>;
};
const transitions = new WeakMap<object, Transition>();
const rollbackWitnesses = new WeakMap<object, { owner: GenericJournalMysqlRuntimeOwner; transition: Transition; facade: Facade; sha256: string }>();

function safeCreateError(reason: unknown): Error {
  const safe = new Error("generic_journal_fixture_account_creation_failed");
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
export class GenericJournalMysqlRuntimeOwner {
  readonly database = `agent_service_test_generic_journal_${randomBytes(12).toString("hex")}`;
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
  private allocating: Promise<void> | undefined;
  private allocatedWitness: Awaited<ReturnType<typeof witnessAbsentMysqlFixtureDatabase>> | undefined;
  private readonly namedFresh: boolean;
  private readonly cliFiles = new Set<OwnedCliCommandFile>();
  private primaryWork: Promise<void> | undefined;
  private primaryRequestSha256: string | undefined;
  private staging = false;
  private unresolved: Transition | undefined;
  private closing: Promise<void> | undefined;

  constructor(operatorUrl: string, namedFresh?: CaptureMysqlNamedFreshSelection) {
    try {
      this.base = new URL(operatorUrl);
      if (this.base.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(this.base.hostname)
        || this.base.search || this.base.hash || !/(?:^|[_-])test(?:$|[_-])/i.test(decodeURIComponent(this.base.pathname.slice(1)))) throw failed();
      this.base.pathname = "/mysql";
      this.namedFresh = namedFresh !== undefined;
      if (namedFresh !== undefined) this.database = captureMysqlNamedFreshDatabase(namedFresh);
    } catch { throw failed(); }
  }
  private own<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work); void work.then(() => this.pending.delete(work), () => this.pending.delete(work)); return work;
  }
  /** Narrow facade view: real methods retain their original receiver, args and raw Promise. */
  private ownFacade<T extends Closable>(facade: T, transition?: Transition, observer?: NativeActivationObserver): T {
    const view = Object.fromEntries(Object.entries(facade).map(([key, value]) => {
      if (typeof value !== 'function') throw failed();
      return [key, (...args: unknown[]) => {
        let attempt: NativeActivationAttempt | undefined;
        if (transition && key === 'activateTenantRestoreRuntime') {
          if (!observer || transition.state === 'unknown' || transition.state === 'staged' || transition.cliWork || this.nativeFailures.length !== 0) throw failed();
          attempt = observer.start(); attempt.facade = view;
        }
        let work: Promise<unknown>;
        try {
          work = Reflect.apply(value, facade, args);
          if (!(work instanceof Promise)) throw failed();
          if (attempt) observer!.bind(attempt, work);
        } catch (reason) { if (attempt) observer!.abandon(attempt); throw reason; }
        if (transition && attempt) {
          if (transition.state !== 'confirmed') transition.state = 'unknown';
          transition.attempts.set(work, attempt); transition.activations.set(work, undefined);
          void work.then(() => { observer!.finish(attempt!); transition.activations.set(work, { state: 'fulfilled' }); },
            reason => { observer!.finish(attempt!); transition.activations.set(work, { state: 'rejected', reason }); });
        }
        if (key === 'close' && observer) {
          const restore = () => { try { observer.restore(); } catch (reason) { this.nativeFailures.push(reason); } };
          void work.then(restore, restore);
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
  /** Keep the original caller's CREATE hook separate from its later in-body schema preparation. */
  allocateFresh(): Promise<void> {
    if (this.allocating) return this.allocating;
    if (!this.namedFresh || this.preparing || this.closing || this.createAttempted) return Promise.reject(failed());
    return this.allocating = this.own((async () => {
      const url = at(this.base, this.database);
      const witness = await witnessAbsentMysqlFixtureDatabase({ operatorUrl: url, applicationDatabase: this.database,
        operationAbortSignal: this.preparation.signal });
      this.createAttempted = true;
      await this.native(at(this.base, "mysql"), async conn => {
        await conn.query(`CREATE DATABASE ${mysql.escapeId(this.database)} CHARACTER SET utf8mb4`);
      });
      this.allocatedWitness = witness;
    })());
  }

  prepare(): Promise<void> {
    if (this.preparing) return this.preparing;
    if (this.closing) return Promise.reject(failed());
    return this.preparing = this.own((async () => {
      const url = at(this.base, this.database);
      let witness: Awaited<ReturnType<typeof witnessAbsentMysqlFixtureDatabase>>;
      if (this.allocating) {
        await this.allocating;
        if (!this.allocatedWitness) throw failed();
        witness = this.allocatedWitness;
      } else {
        witness = await witnessAbsentMysqlFixtureDatabase({ operatorUrl: url, applicationDatabase: this.database,
          operationAbortSignal: this.preparation.signal });
        this.createAttempted = true;
        await this.native(at(this.base, "mysql"), async conn => {
          await conn.query(`CREATE DATABASE ${mysql.escapeId(this.database)} CHARACTER SET utf8mb4`);
        });
      }
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
      this.currentOptions = { ...this.runtime.runtimeStoreOptions,
        tenantTelemetryPersistedProviderCaptureLocalOnly: false, tenantTelemetryCaptureRestoreLocalOnly: false };
      if (this.uuid !== this.initial.serverUuid) throw failed();
      this.current = await this.native(url, conn => loadActiveSessionAuthorityBinding(conn, false));
      if (this.current.bindingId !== this.initial.bindingId || this.current.bindingSequence !== 1
        || this.current.serverUuid !== this.uuid || this.current.applicationDatabase !== this.database) throw failed();
      this.ready = true;
    })());
  }
  openStore(limit: number, signal?: AbortSignal): Promise<MysqlSessionStore> {
    if (!this.ready || this.closing || this.staging || this.unresolved || !this.currentOptions) return Promise.reject(failed());
    const options = { ...this.currentOptions };
    const abortSignal = signal ? AbortSignal.any([this.consumers.signal, signal]) : this.consumers.signal;
    return this.own(MysqlSessionStore.connect({ ...options, connectionLimit: limit, operationAbortSignal: abortSignal })
      .then(store => { this.stores.add(store); return store; }));
  }
  openInspection(signal?: AbortSignal): Promise<CaptureMysqlInspection> {
    if (!this.ready || this.closing || this.staging) return Promise.reject(failed());
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
  runtimeEnv(): Readonly<Record<string, string>> {
    if (!this.ready || this.closing || this.staging || this.unresolved || !this.runtime || !this.currentOptions) throw failed();
    return Object.freeze({ ...this.runtime.runtimeEnv, MYSQL_URL: this.currentOptions.url });
  }
  openRuntimeMaintenance(limit?: number, signal?: AbortSignal): Promise<Facade> {
    if (!this.ready || this.closing || this.staging || this.unresolved || !this.currentOptions?.schemaMetadata) return Promise.reject(failed());
    const aborted = signal ? AbortSignal.any([this.consumers.signal, signal]) : this.consumers.signal;
    return this.own(MysqlSessionStore.connectRestoreJournalMaintenance({ url: this.currentOptions.url,
      ...(limit === undefined ? {} : { connectionLimit: limit }), operationAbortSignal: aborted },
      { kind: 'runtime-maintenance', schemaMetadata: this.currentOptions.schemaMetadata }).then(value => this.ownFacade(value)));
  }
  migrateWithLockTimeout(lockTimeoutSeconds: 60): Promise<void> {
    if (!this.ready || this.closing || this.staging || this.pending.size || lockTimeoutSeconds !== 60) return Promise.reject(failed());
    this.staging = true;
    return this.own((async () => {
      try {
        await this.drainAccepted([], false);
        await MysqlSessionStore.runSchemaOperation({ url: at(this.base, this.database), operation: 'migrate',
          fleetStoppedAck: 'all-application-writers-stopped-v1', migrationLockTimeoutSeconds: lockTimeoutSeconds,
          operationAbortSignal: this.consumers.signal });
      } finally { this.staging = false; }
    })());
  }
  verifySchema(): Promise<void> {
    if (!this.ready || this.closing || this.staging || this.pending.size) return Promise.reject(failed());
    return this.own(MysqlSessionStore.runSchemaOperation({ url: at(this.base, this.database), operation: 'verify',
      operationAbortSignal: this.consumers.signal }));
  }
  private transition(token: GenericJournalMysqlTransition): Transition {
    const value = transitions.get(token); if (!value || value.owner !== this) throw failed(); return value;
  }
  private async drainAccepted(accepted: readonly Promise<unknown>[], closeInspections = true): Promise<void> {
    let failure: { reason: unknown } | undefined;
    for (const result of await Promise.allSettled(accepted)) if (result.status === "rejected") failure ??= { reason: result.reason };
    const closing = await Promise.allSettled([...this.stores].map(store => store.close()).concat(
      [...this.facades].map(facade => facade.close()), closeInspections ? [...this.inspections].map(inspection => inspection.end()) : []));
    for (const result of closing) if (result.status === "rejected") failure ??= { reason: result.reason };
    if (failure) throw failure.reason;
  }
  private async stage(next: (conn: PoolConnection) => Promise<{ nextEpoch: SessionAuthorityNextEpoch;
    input?: Readonly<ActivateTenantRestoreRuntimeInput> }>,
    accepted: readonly Promise<unknown>[]): Promise<GenericJournalMysqlTransition> {
    await this.drainAccepted(accepted);
    const before = this.current, old = this.currentAccount, options = this.currentOptions;
    if (!before || !old || !options?.schemaMetadata) throw failed();
    const snapshot = await this.native(at(this.base, this.database), async conn => {
      await conn.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"); await conn.beginTransaction();
      try {
        const active = await loadActiveSessionAuthorityBinding(conn, true);
        if (active.bindingId !== before.bindingId || active.bindingSequence !== before.bindingSequence) throw failed();
        const source = await readSessionAuthorityBindingSource(conn), selected = await next(conn);
        const [heads] = await conn.query<RowDataPacket[]>("SELECT state,control_generation,evidence_sha256 FROM tenant_restore_runtime_control WHERE singleton_id=1 FOR SHARE");
        const head = heads[0], generation = Number(head?.control_generation);
        if (heads.length !== 1 || !Number.isSafeInteger(generation) || generation < source.runtimeControlGeneration
          || head?.state !== (source.kind === "inactive" ? "inactive" : "active")
          || source.kind === "inactive" && (generation !== 0 || head.evidence_sha256 !== null)
          || source.kind !== "inactive" && (typeof head.evidence_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(head.evidence_sha256))) throw failed();
        const predecessorRuntimeHead = Object.freeze({ generation, evidenceSha256: head.evidence_sha256 as string | null });
        // Immutable activation K is the fixed source. Mutable current M is evidence only; product begin re-locks M.
        await conn.commit(); return { source, predecessorRuntimeHead, ...selected };
      } catch (reason) { try { await conn.rollback(); } catch (rollback) { this.nativeFailures.push(rollback); } throw reason; }
    });
    const account: Account = { user: "mgj_r_" + randomBytes(8).toString("hex"), host: old.host,
      password: randomBytes(32).toString("hex"), attempted: false, created: false };
    const command = prepareSessionAuthorityBindingCommand({ bindingId: randomUUID(), activationId: randomUUID(),
      expectedBindingId: before.bindingId, expectedSequence: before.bindingSequence, serverUuid: this.uuid,
      applicationDatabase: this.database, newAccounts: [{ user: account.user, host: account.host }],
      oldAccountNames: this.accounts.map(value => value.user),
      activationEvidenceSha256: createHash("sha256").update(JSON.stringify(["generic-journal-fixture-v1", before.bindingId,
        this.database, account.user, snapshot.nextEpoch.activationRequestSha256])).digest("hex"),
      expectedSource: snapshot.source, nextEpoch: snapshot.nextEpoch });
    const context = Object.freeze({ command, schemaMetadata: options.schemaMetadata, assertNativeAdmission: assertSessionAuthorityActivationAdmission });
    const record: Transition = { owner: this, command, context, account, before, predecessorRuntimeHead: snapshot.predecessorRuntimeHead, input: snapshot.input,
      state: "staged", facades: new Set(), activations: new Map(), attempts: new Map() };
    const token = Object.freeze({}) as GenericJournalMysqlTransition;
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
  activatePrimary(originalInput: ActivateTenantRestoreJournalControlInput): Promise<void> {
    let request: ReturnType<typeof captureSessionAuthorityActivationRequest>;
    try { request = captureSessionAuthorityActivationRequest(prepareSessionAuthorityActivationRequest('primary_activation', originalInput)); }
    catch (reason) { return Promise.reject(reason); }
    if (request.kind !== 'primary_activation') return Promise.reject(failed());
    if (this.primaryWork) return request.activationRequestSha256 === this.primaryRequestSha256 ? this.primaryWork : Promise.reject(failed());
    if (!this.ready || this.closing || this.staging || this.unresolved) return Promise.reject(failed());
    const input = request.input, accepted = [...this.pending]; this.staging = true;
    this.primaryRequestSha256 = request.activationRequestSha256;
    return this.primaryWork = this.own((async () => {
      try {
        const token = await this.stage(async () => ({ nextEpoch: { kind: 'primary_activation', runtimeEpochSha256: input.runtimeEpochSha256,
          restoreRunId: null, activationRequestSha256: request.activationRequestSha256, sealedReplayReceiptSha256: null } }), accepted);
        const record = this.transition(token);
        const facade = await this.own(MysqlSessionStore.connectRestoreJournalMaintenance({ url: at(this.base, this.database),
          operationAbortSignal: this.consumers.signal }, { kind: 'operator-maintenance', binding: record.context })
          .then(value => this.ownFacade(value, record)));
        await closeAfter(async () => { await facade.activateTenantRestoreJournalControl(input); await this.confirmRecord(record, facade); }, () => facade.close());
      } finally { this.staging = false; }
    })());
  }
  stageRestore(input: ActivateTenantRestoreRuntimeInput): Promise<GenericJournalMysqlTransition> {
    if (!this.ready || this.closing || this.staging || this.unresolved || !this.primaryWork
      || this.epochs.some(record => captureSessionAuthorityBindingCommand(record.command).nextEpoch?.kind === 'restore_activation')
      || !this.epochs.some(record => record.state === 'confirmed'
        && captureSessionAuthorityBindingCommand(record.command).nextEpoch?.kind === 'primary_activation')) return Promise.reject(failed());
    let request: ReturnType<typeof captureSessionAuthorityActivationRequest>;
    try { request = captureSessionAuthorityActivationRequest(prepareSessionAuthorityActivationRequest('restore_activation', input)); }
    catch (reason) { return Promise.reject(reason); }
    if (request.kind !== 'restore_activation') return Promise.reject(failed());
    const captured = request.input, accepted = [...this.pending]; this.staging = true;
    return this.own((async () => {
      try {
        return await this.stage(async conn => {
          const [rows] = await conn.query<RowDataPacket[]>('SELECT phase,runtime_epoch_sha256,terminal_receipt_sha256 FROM tenant_restore_replay_runs WHERE BINARY restore_run_id=BINARY ? FOR SHARE', [captured.restoreRunId]);
          const row = rows[0];
          if (rows.length !== 1 || row?.phase !== 'replay_sealed' || typeof row.runtime_epoch_sha256 !== 'string'
            || typeof row.terminal_receipt_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.terminal_receipt_sha256)) throw failed();
          return { input: captured, nextEpoch: { kind: 'restore_activation', runtimeEpochSha256: row.runtime_epoch_sha256,
            restoreRunId: captured.restoreRunId, activationRequestSha256: request.activationRequestSha256, sealedReplayReceiptSha256: row.terminal_receipt_sha256 } };
        }, accepted);
      } finally { this.staging = false; }
    })());
  }
  restoreInput(token: GenericJournalMysqlTransition): Readonly<ActivateTenantRestoreRuntimeInput> {
    const record = this.transition(token); if (!record.input) throw failed(); return record.input;
  }
  private async saveCliCommand(record: Transition): Promise<string> {
    const signal = this.consumers.signal;
    signal.throwIfAborted();
    const parent = await realpath(tmpdir()); signal.throwIfAborted();
    const directory = await mkdtemp(join(parent, "agent-service-generic-journal-command-"));
    // Register even a late/partial mkdtemp before checking cancellation or doing another await.
    const owned: OwnedCliCommandFile = { directory, path: join(directory, "command.json") };
    this.cliFiles.add(owned);
    signal.throwIfAborted(); await chmod(directory, 0o700);
    const beforeDirectory = privateDirectoryIdentity(await lstat(directory));
    if (await realpath(directory) !== directory) throw failed();
    signal.throwIfAborted();
    // Project only the fixed command's input. Its two derived hashes are not accepted JSON input fields.
    const { accountsSha256: _accountsSha256, commandSha256: _commandSha256, ...input } = captureSessionAuthorityBindingCommand(record.command);
    const bytes = Buffer.from(JSON.stringify(input) + "\n");
    try {
      if (bytes.length > 65_536) throw failed();
      const file = await open(owned.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await closeAfter(async () => {
        const stat = await file.stat();
        if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600) throw failed();
        signal.throwIfAborted(); await file.writeFile(bytes); signal.throwIfAborted(); await file.sync();
      }, async () => { try { await file.close(); } catch (reason) { this.nativeFailures.push(reason); throw reason; } });
      signal.throwIfAborted();
      const dir = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      await closeAfter(() => dir.sync(), async () => { try { await dir.close(); } catch (reason) { this.nativeFailures.push(reason); throw reason; } });
      const afterDirectory = privateDirectoryIdentity(await lstat(directory));
      const saved = await lstat(owned.path);
      if (beforeDirectory !== afterDirectory || await realpath(directory) !== directory || saved.size !== bytes.length
        || await realpath(owned.path) !== owned.path) throw failed();
      owned.directoryIdentity = afterDirectory; owned.fileIdentity = privateFileIdentity(saved);
      owned.sha256 = createHash("sha256").update(bytes).digest("hex");
      signal.throwIfAborted(); return owned.path;
    } finally { bytes.fill(0); }
  }
  private async verifyCliCommand(owned: OwnedCliCommandFile): Promise<void> {
    if (!owned.directoryIdentity || !owned.fileIdentity || !owned.sha256
      || privateDirectoryIdentity(await lstat(owned.directory)) !== owned.directoryIdentity
      || await realpath(owned.directory) !== owned.directory
      || privateFileIdentity(await lstat(owned.path)) !== owned.fileIdentity) throw failed();
    const file = await open(owned.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer | undefined;
    await closeAfter(async () => {
      if (privateFileIdentity(await file.stat()) !== owned.fileIdentity) throw failed();
      bytes = Buffer.alloc(65_537); let count = 0;
      while (count < bytes.length) {
        const result = await file.read(bytes, count, bytes.length - count, count);
        if (!result.bytesRead) break; count += result.bytesRead;
      }
      if (count > 65_536 || privateFileIdentity(await file.stat()) !== owned.fileIdentity
        || createHash("sha256").update(bytes.subarray(0, count)).digest("hex") !== owned.sha256) throw failed();
    }, async () => {
      try { await file.close(); } catch (reason) { this.nativeFailures.push(reason); throw reason; }
      finally { bytes?.fill(0); }
    });
    if (privateDirectoryIdentity(await lstat(owned.directory)) !== owned.directoryIdentity
      || privateFileIdentity(await lstat(owned.path)) !== owned.fileIdentity) throw failed();
  }
  private async removeCliCommands(): Promise<void> {
    for (const owned of this.cliFiles) {
      await this.verifyCliCommand(owned);
      await unlink(owned.path); await rmdir(owned.directory); this.cliFiles.delete(owned);
    }
  }
  /** Only the caller's original synchronous runSourceCli/spawnSync(30s) belongs here.
   * No child is replaced or retried; raw result is returned unchanged. Confirmation stays separate. */
  runActivationCli(token: GenericJournalMysqlTransition,
    invoke: (environment: Readonly<Record<string, string>>) => GenericJournalMysqlCliResult): Promise<GenericJournalMysqlCliResult> {
    const record = this.transition(token);
    if (this.closing || this.staging || !record.input || record.state !== "ready" || record.cliWork
      || record.activations.size !== 0 || this.nativeFailures.length !== 0 || typeof invoke !== "function") return Promise.reject(failed());
    // Reserve the one dispatch before the first file await. Every interruption remains unknown/retained.
    record.state = "unknown";
    return record.cliWork = this.own((async () => {
      const commandFile = await this.saveCliCommand(record);
      if (this.closing || this.nativeFailures.length !== 0) throw failed(); this.consumers.signal.throwIfAborted();
      const metadata = record.context.schemaMetadata;
      const environment = Object.freeze({ AUTHORITY_MYSQL_URL: at(this.base, this.database), AUTHORITY_COMMAND_FILE: commandFile,
        AUTHORITY_FLEET_STOPPED_ACK: "all-application-writers-stopped-v1",
        AUTHORITY_EXCLUSIVE_CHANGE_ACK: "exclusive-authority-permissions-window-v1", AUTHORITY_OPERATION_TIMEOUT_MS: "120000",
        AUTHORITY_METADATA_SCHEMA: metadata.metadataSchema, AUTHORITY_METADATA_DEFINER_USER: metadata.trustedDefiner.user,
        AUTHORITY_METADATA_DEFINER_HOST: metadata.trustedDefiner.host });
      const result: unknown = invoke(environment);
      if (result instanceof Promise) {
        // An invalid async callback is never accepted as a sync child result. Still join its original Promise.
        const error = failed(); await Promise.allSettled([this.own(result)]); throw error;
      }
      if (!result || typeof result !== "object" || Object.getPrototypeOf(result) !== Object.prototype) throw failed();
      const descriptors = Object.getOwnPropertyDescriptors(result), fields = ["status", "signal", "stdout", "stderr"];
      if (Reflect.ownKeys(descriptors).length !== fields.length || fields.some(key => !descriptors[key]?.enumerable
        || !("value" in descriptors[key]!)) || !(descriptors.status!.value === null || Number.isInteger(descriptors.status!.value))
        || !(descriptors.signal!.value === null || typeof descriptors.signal!.value === "string")
        || typeof descriptors.stdout!.value !== "string" || typeof descriptors.stderr!.value !== "string") throw failed();
      return result as GenericJournalMysqlCliResult;
    })());
  }

  openActivationFacade(token: GenericJournalMysqlTransition, limit?: number): Promise<Facade> {
    const record = this.transition(token);
    if (this.closing || !record.input || !['ready', 'unknown', 'confirmed', 'unapplied-proved'].includes(record.state)) return Promise.reject(failed());
    const url = at(this.base, this.database);
    let captured: ActualNativePool | undefined, captureCount = 0;
    const originalFactory = mysql.createPool;
    const descriptor = Object.getOwnPropertyDescriptor(mysql, 'createPool');
    const factory: typeof mysql.createPool = function(this: typeof mysql, ...args: Parameters<typeof mysql.createPool> | [string]) {
      const config = args[0];
      if (args.length !== 1 || !config || typeof config !== 'object'
        || Object.getOwnPropertyDescriptor(config, 'uri')?.value !== url || ++captureCount !== 1) throw failed();
      captured = Reflect.apply(originalFactory, this, args) as ActualNativePool;
      return captured;
    };
    let original: Promise<Facade>;
    try {
      mysql.createPool = factory;
      original = MysqlSessionStore.connectRestoreJournalMaintenance({ url,
        ...(limit === undefined ? {} : { connectionLimit: limit }), operationAbortSignal: this.consumers.signal },
        { kind: 'operator-maintenance', binding: record.context });
    } finally {
      if (descriptor) Object.defineProperty(mysql, 'createPool', descriptor); else mysql.createPool = originalFactory;
    }
    return this.own(original.then(async facade => {
      try {
        if (!captured || captureCount !== 1) throw failed();
        // Install only after the original full startup/schema audit has actually completed.
        const observer = new NativeActivationObserver(captured);
        return this.ownFacade(facade, record, observer);
      } catch (reason) {
        await facade.close().catch(error => this.nativeFailures.push(error)); throw reason;
      }
    }));
  }
  private confirmRecord(record: Transition, facade: Closable & { confirmSessionAuthorityBinding(): Promise<void> }): Promise<void> {
    if (!record.facades.has(facade) || this.closing) return Promise.reject(failed());
    if (record.confirming) return record.confirming;
    const work = this.own((async () => {
      // Never publish a successor while another actual activation call on its token is unresolved.
      await Promise.allSettled([...record.activations.keys(), ...(record.cliWork ? [record.cliWork] : [])]);
      // void means success only after the actual same-command confirm transaction completes.
      await facade.confirmSessionAuthorityBinding();
      const command = captureSessionAuthorityBindingCommand(record.command);
      const active = await this.native(at(this.base, this.database), conn => loadActiveSessionAuthorityBinding(conn, false));
      if (active.bindingId !== command.bindingId || active.bindingSequence !== command.expectedSequence + 1
        || active.serverUuid !== this.uuid || active.applicationDatabase !== this.database) throw failed();
      const url = new URL(at(this.base, this.database)); url.username = record.account.user; url.password = record.account.password!;
      this.current = active; this.currentAccount = record.account;
      this.currentOptions = { ...this.runtime!.runtimeStoreOptions, url: url.toString(),
        tenantTelemetryPersistedProviderCaptureLocalOnly: false, tenantTelemetryCaptureRestoreLocalOnly: false };
      record.state = "confirmed"; if (this.unresolved === record) this.unresolved = undefined;
    })());
    record.confirming = work;
    void work.then(() => { if (record.confirming === work) record.confirming = undefined; },
      () => { if (record.confirming === work) record.confirming = undefined; });
    return work;
  }
  confirm(token: GenericJournalMysqlTransition, facade: Facade): Promise<void> {
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
  snapshotForRejectedActivation(token: GenericJournalMysqlTransition, facade: Facade): Promise<GenericJournalMysqlRollbackWitness> {
    const record = this.transition(token);
    if (record.state !== 'ready' || record.activations.size !== 0 || !record.facades.has(facade) || this.closing || this.nativeFailures.length !== 0) return Promise.reject(failed());
    return this.own((async () => {
      const sha256 = await this.rowsSha256();
      if (record.state !== 'ready' || record.activations.size !== 0 || this.nativeFailures.length !== 0) throw failed();
      const witness = Object.freeze({}) as GenericJournalMysqlRollbackWitness;
      rollbackWitnesses.set(witness, { owner: this, transition: record, facade, sha256 }); return witness;
    })());
  }
  proveProjectionRejected(token: GenericJournalMysqlTransition, activation: Promise<unknown>, witness: GenericJournalMysqlRollbackWitness): Promise<void> {
    const record = this.transition(token), before = rollbackWitnesses.get(witness);
    if (!before || before.owner !== this || before.transition !== record || record.activations.size !== 1
      || !record.activations.has(activation) || this.closing || this.nativeFailures.length !== 0) return Promise.reject(failed());
    rollbackWitnesses.delete(witness);
    return this.own((async () => {
      await Promise.allSettled([activation]);
      const outcome = record.activations.get(activation), attempt = record.attempts.get(activation);
      if (record.activations.size !== 1 || outcome?.state !== 'rejected' || !(outcome.reason instanceof TenantErasureIntegrityError)
        || !attempt || attempt.raw !== activation || attempt.facade !== before.facade || !record.facades.has(before.facade) || !attempt.complete || attempt.invalid || !attempt.connection
        || !Number.isSafeInteger(attempt.threadId) || attempt.threadId! < 1
        || attempt.calls.beginTransaction !== 1 || attempt.completed.beginTransaction !== 1 || attempt.failed.beginTransaction !== 0
        || attempt.calls.rollback !== 1 || attempt.completed.rollback !== 1 || attempt.failed.rollback !== 0
        || attempt.calls.commit !== 0 || attempt.completed.commit !== 0 || attempt.failed.commit !== 0
        || attempt.trace.indexOf('beginTransaction:completed') < 0
        || attempt.trace.indexOf('beginTransaction:completed') >= attempt.trace.indexOf('rollback:called')) throw failed();
      if (await this.rowsSha256() !== before.sha256 || record.activations.size !== 1 || this.nativeFailures.length !== 0) throw failed();
      // Only this same fixed command/input may be called explicitly after the original head repair.
      record.state = 'unapplied-proved';
    })());
  }
  close(input: { successful: boolean; readiness?: "structure-after-intentional-data-corruption-v1" }): Promise<void> {
    if (this.closing) return this.closing;
    if (!input || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).some(key => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      return typeof key !== "string" || !["successful", "readiness"].includes(key)
        || !descriptor?.enumerable || !("value" in descriptor);
    }) || typeof input.successful !== "boolean" || input.readiness !== undefined
      && input.readiness !== "structure-after-intentional-data-corruption-v1") return Promise.reject(failed());
    const successfulRequested = input.successful, readiness = input.readiness;
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
          if (this.unresolved || this.epochs.some(record => record.state !== "confirmed")) throw failed();
          await MysqlSessionStore.runSchemaOperation({ url: at(this.base, this.database), operation: "verify", operationAbortSignal: this.preparation.signal });
          const config = this.currentOptions.schemaMetadata; if (!config) throw failed();
          await this.native(this.currentOptions.url, async conn => {
            await assertSessionAuthorityRuntimeConnection(conn, config); await verifySchemaMetadataProcedureIdentity(conn, this.database, config);
            const active = await loadActiveSessionAuthorityBinding(conn, false);
            if (active.bindingId !== this.current!.bindingId || active.bindingSequence !== this.current!.bindingSequence) throw failed();
          });
          if (readiness === undefined) {
            const store = await MysqlSessionStore.connect({ ...this.currentOptions, connectionLimit: 1, operationAbortSignal: this.preparation.signal });
            await closeAfter(() => store.sessionAuthority.identity(), () => store.close());
          }
          // Validate every issued private command before any destructive native cleanup.
          for (const owned of this.cliFiles) await this.verifyCliCommand(owned);
          await this.native(at(this.base, "mysql"), async conn => {
            const current = this.currentAccount!;
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
          // No accepted CLI can still read these files: its synchronous child returned and all owner work settled.
          if (this.cliFiles.size) await this.removeCliCommands();
        }
      } catch (reason) { successful = false; remember(reason); }
      finally {
        if (!successful && this.createAttempted) console.warn(JSON.stringify({ schema: "generic-journal-fixture-retained-v1", applicationDatabase: this.database,
          metadataSchema: this.runtime?.runtimeEnv.MYSQL_SCHEMA_METADATA_SCHEMA, ownedAccounts: this.accounts.map(value => ({ user: value.user, host: value.host, createAttempted: value.attempted })),
          metadataDefiner: this.runtime?.runtimeEnv.MYSQL_SCHEMA_METADATA_DEFINER_USER ?? null, status: "retained_or_unknown" }));
        if (!successful && this.cliFiles.size) console.warn(JSON.stringify({ schema: "generic-journal-cli-files-retained-v1",
          commandDirectories: [...this.cliFiles].map(value => value.directory), status: "retained_or_unknown" }));
        this.preparation.abort();
        for (const result of await Promise.allSettled([...this.inspections].map(value => value.end()))) if (result.status === "rejected") remember(result.reason);
        while (this.sockets.size) await Promise.all([...this.sockets.values()]);
      }
      for (const reason of this.nativeFailures) remember(reason);
      if (failure) throw failure.reason;
    })();
  }
}
