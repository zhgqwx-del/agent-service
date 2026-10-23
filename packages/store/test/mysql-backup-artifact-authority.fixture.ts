/** Artifact-test-private native ownership. Draft: not a product API or generic runtime owner. */
import { createConnection as createSocket, type Socket, type LookupFunction } from "node:net";
import { lookup } from "node:dns";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { Readable } from "node:stream";
import { S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MySqlBackupArtifactOperator, MySqlBackupArtifactOperatorOptions } from "../../../apps/agent-runner/src/mysql-backup-artifact.js";
import { canonicalJson } from "../../../apps/agent-runner/src/mysql-backup-artifact-codec.js";
import mysql, { type Connection, type PoolConnection, type RowDataPacket } from "mysql2/promise";
import { MysqlSessionStore, prepareSessionAuthorityBindingCommand, captureSessionAuthorityBindingCommand,
  assertSessionAuthorityActivationAdmission, SessionAuthorityError, TenantErasureIntegrityError, type MysqlStoreOptions, type ActivateTenantRestoreJournalControlInput } from "../src/index.js";
import { prepareSessionAuthorityActivationRequest, captureSessionAuthorityActivationRequest, readSessionAuthorityBindingSource,
  loadActiveSessionAuthorityBinding, assertSessionAuthorityRuntimeConnection } from "../src/mysql/session-authority-binding.js";
import type { SessionAuthorityBindingOperatorContext, PreparedSessionAuthorityBindingCommand,
  SessionAuthorityBindingSource, SessionAuthorityBindingCommandInput } from "../src/mysql/session-authority-binding-types.js";
import { assertSchemaRuntimePrivileges } from "../src/mysql/schema-runtime-privileges.js";
import { verifySchemaMetadataProcedureIdentity } from "../src/mysql/schema-metadata.js";
import { createMysqlOperationAbortTransport, bindMysqlOperationAbort } from "../src/mysql/operation-abort.js";
import { witnessAbsentMysqlFixtureDatabase, prepareMysqlRuntimeFixture } from "../../../test/fixtures/mysql-runtime.mjs";
import { createMysqlSchemaCliExecutor } from "../../../test/fixtures/mysql-schema-cli.mjs";
import { captureMysqlFixtureAuthorityCommand, createMysqlAuthorityCliExecutor } from "../../../test/fixtures/mysql-authority-cli.mjs";
import { CaptureMysqlInspection } from "./fixtures/capture-mysql-runtime.js";

const invalid = () => new Error("Physical artifact fixture ownership is not proven");
type Closeable = { close(): Promise<void> };
export async function artifactCloseAfter<T>(body: () => Promise<T>, close: () => Promise<unknown>): Promise<T> {
  let failure: { reason: unknown } | undefined, value: T | undefined;
  try { value = await body(); } catch (reason) { failure = { reason }; }
  try { await close(); } catch (reason) { failure ??= { reason }; }
  if (failure) throw failure.reason;
  return value as T;
}

/** An admitted factory, actual returned facade and its original close are tracked separately.
 * This never wraps a product-issued facade or replaces its original Promise/receiver. */
export class ArtifactFixtureNativeOwnership {
  private readonly cancellation = new AbortController();
  private readonly work = new Set<Promise<unknown>>();
  private readonly resources = new Set<Closeable>();
  private readonly inspections = new Set<CaptureMysqlInspection>();
  private readonly sockets = new Map<Socket, Promise<void>>();
  private readonly nativeFailures: unknown[] = [];
  private readonly endpoints = new Set<string>();
  private closing: Promise<void> | undefined;
  private serverUuid: string | undefined;
  readonly signal = this.cancellation.signal;

  constructor(private readonly operatorBase: string) {
    const base = new URL(operatorBase);
    if (base.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)
      || base.search || base.hash) throw invalid();
    base.pathname = "/mysql";
    this.endpoints.add(base.toString());
  }
  admitDatabase(operatorUrl: string): void {
    if (this.closing || this.signal.aborted) throw invalid();
    const expected = new URL(this.operatorBase), actual = new URL(operatorUrl);
    if (actual.protocol !== expected.protocol || actual.host !== expected.host || actual.username !== expected.username
      || actual.password !== expected.password || actual.search || actual.hash
      || !/^agent_service_backup_artifact_test_[0-9]+_[0-9a-f]{8}_[0-9]+$/.test(decodeURIComponent(actual.pathname.slice(1)))) throw invalid();
    this.endpoints.add(actual.toString());
  }
  isIssuedOperatorEndpoint(url: string): boolean { return this.endpoints.has(url); }
  rememberNativeFailure(reason: unknown): void { this.nativeFailures.push(reason); }
  observeOperatorSocket(socket: Socket): void {
    if (this.sockets.has(socket)) return;
    const closed = socket.closed ? Promise.resolve() : new Promise<void>(resolve => socket.once("close", () => resolve()));
    this.sockets.set(socket, closed); void closed.then(() => this.sockets.delete(socket));
  }
  own<T>(original: Promise<T>): Promise<T> {
    this.work.add(original);
    void original.then(() => this.work.delete(original), () => this.work.delete(original));
    return original;
  }
  factory<T extends Closeable>(start: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T> {
    if (this.closing || this.signal.aborted || external?.aborted) return Promise.reject(invalid());
    const signal = external ? AbortSignal.any([this.signal, external]) : this.signal;
    let original: Promise<T>;
    try { original = start(signal); } catch (reason) { return Promise.reject(reason); }
    void original.then(value => { this.resources.add(value); }, () => {});
    return this.own(original);
  }
  adopt<T extends Closeable>(actual:T):T {if(this.closing||this.signal.aborted)throw invalid();this.resources.add(actual);return actual;}
  /** The original resource stays branded. Only its actual close Promise is observed. */
  closeResource(resource: Closeable): Promise<void> {
    return this.own(resource.close());
  }
  inspect(operatorUrl: string, external?: AbortSignal): Promise<CaptureMysqlInspection> {
    if (this.closing || this.signal.aborted || !this.endpoints.has(operatorUrl) || external?.aborted) return Promise.reject(invalid());
    const signal = external ? AbortSignal.any([this.signal, external]) : this.signal;
    return this.own((async () => {
      let connection: Connection | undefined, socket: Socket | undefined;
      const abort = () => {
        try { connection?.destroy(); } catch (reason) { this.nativeFailures.push(reason); }
        try { socket?.destroy(); } catch (reason) { this.nativeFailures.push(reason); }
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        signal.throwIfAborted();
        connection = await mysql.createConnection({ uri: operatorUrl, connectTimeout: 10_000,
          stream: (options: { config: { host: string; port: number } }) => {
            if (socket) throw invalid();
            const nativeLookup:LookupFunction=(hostname,settings,callback)=>{
              let done!:()=>void;const raw=new Promise<void>(resolve=>{done=resolve;});this.own(raw);
              try{lookup(hostname,settings,(error,address,family)=>{try{callback(error,address,family);}finally{done();}});}
              catch(reason){done();throw reason;}
            };
            socket = createSocket({ host: options.config.host, port: options.config.port,lookup:nativeLookup });
            const accepted = socket;
            const closed = new Promise<void>(resolve => accepted.once("close", () => resolve()));
            this.sockets.set(accepted, closed); void closed.then(() => this.sockets.delete(accepted));
            if (signal.aborted) queueMicrotask(abort);
            return accepted;
          } });
        if (!socket || signal.aborted) throw invalid();
        const actual = new CaptureMysqlInspection(connection, socket, this.sockets.get(socket)!, signal,
          () => signal.removeEventListener("abort", abort));
        this.inspections.add(actual);
        const [identity] = await actual.query<import("mysql2/promise").RowDataPacket[]>("SELECT @@server_uuid AS uuid,DATABASE() AS db");
        const row = identity[0];
        if (identity.length !== 1 || !row || typeof row.uuid !== "string" || !/^[a-f0-9-]{36}$/.test(row.uuid)
          || row.db !== decodeURIComponent(new URL(operatorUrl).pathname.slice(1))
          || this.serverUuid !== undefined && row.uuid !== this.serverUuid) throw invalid();
        this.serverUuid ??= row.uuid;
        return actual;
      } catch (reason) {
        abort(); if (socket) await this.sockets.get(socket);
        signal.removeEventListener("abort", abort); throw reason;
      }
    })());
  }
  accepted():readonly Promise<unknown>[] {return [...this.work];}
  async drainFactories(): Promise<void> {
    while (this.work.size) await Promise.allSettled([...this.work]);
  }
  /** Called only after the caller synchronously fences role-specific new borrowers. */
  async closeVisitors(): Promise<void> {
    await this.drainFactories();
    let failure: { reason: unknown } | undefined;
    const closes:Promise<void>[]=[];
    for(const value of this.resources)try{closes.push(value.close());}catch(reason){closes.push(Promise.reject(reason));}
    for(const value of this.inspections)try{closes.push(value.end());}catch(reason){closes.push(Promise.reject(reason));}
    for(const result of await Promise.allSettled(closes))if(result.status==="rejected")failure??={reason:result.reason};
    // Product operator.close() destroys connections but does not join socket.close.
    // Protected original work and every accepted factory have settled before this extra barrier.
    try { await closeArtifactOperatorConnections(this); } catch (reason) { failure ??= { reason }; }
    while (this.sockets.size) await Promise.all([...this.sockets.values()]);
    if (this.nativeFailures.length) failure ??= { reason: this.nativeFailures[0] };
    if (failure) throw failure.reason;
  }
  stop(): void { this.cancellation.abort(); }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stop();
    return this.closing = this.closeVisitors();
  }
  /** Content-free equality input for the artifact-specific role registry, never activation proof. */
  observedServerUuid(): string {
    if (this.serverUuid === undefined) throw invalid();
    return this.serverUuid;
  }
}

/** A direct existing Store can be owned without changing its nominal/WeakMap identity. */
export function ownArtifactStore<T extends MysqlSessionStore>(owner: ArtifactFixtureNativeOwnership,
  start: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T> {
  return owner.factory(start, external);
}


type OperatorAddress = { host: string; port: number; database: string; user: string; password: string };
type OperatorConnectionScope = {
  readonly owner: ArtifactFixtureNativeOwnership;
  readonly addresses: readonly OperatorAddress[];
  readonly calls: Map<string, number>;
  readonly native: Set<Promise<Connection>>;
  readonly connections: Set<Connection>;
  factorySettled: boolean;
};
const operatorContext = new AsyncLocalStorage<OperatorConnectionScope>();
const activeOperatorScopes = new Set<OperatorConnectionScope>();
const operatorScopes = new WeakMap<ArtifactFixtureNativeOwnership, Set<OperatorConnectionScope>>();
let originalConnectionDescriptor: PropertyDescriptor | undefined;
let originalConnectionFactory: typeof mysql.createConnection | undefined;
let operatorConnectionDispatcher: typeof mysql.createConnection | undefined;

function operatorAddress(url: string): OperatorAddress {
  const parsed = new URL(url), database = decodeURIComponent(parsed.pathname.slice(1));
  if (parsed.protocol !== "mysql:" || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
    || parsed.search || parsed.hash || !/^agent_service_backup_artifact_test_[0-9]+_[0-9a-f]{8}_[0-9]+$/.test(database)) throw invalid();
  return { host: parsed.hostname === "[::1]" ? "::1" : parsed.hostname, port: parsed.port ? Number(parsed.port) : 3306,
    database, user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) };
}
function connectionAddressKey(address: OperatorAddress): string {
  // Private map key only. Never emitted or used as authority evidence.
  return JSON.stringify([address.host, address.port, address.database, address.user, address.password]);
}
function nativeOperatorStream(scope: OperatorConnectionScope, wanted: OperatorAddress) {
  return (options: { config: { host: string; port: number; socketPath?: string; enableKeepAlive?: boolean } }): Socket => {
    if (options.config.host !== wanted.host || options.config.port !== wanted.port || options.config.socketPath
      || options.config.enableKeepAlive !== false) throw invalid();
    const nativeLookup: LookupFunction = (hostname, settings, callback) => {
      let done!: () => void;
      const actual = new Promise<void>(resolve => { done = resolve; }); scope.owner.own(actual);
      try { lookup(hostname, settings, (error, address, family) => {
        try { callback(error, address, family); } finally { done(); }
      }); } catch (reason) { done(); throw reason; }
    };
    const socket = createSocket({ host: wanted.host, port: wanted.port, lookup: nativeLookup });
    socket.setNoDelay(true); scope.owner.observeOperatorSocket(socket);
    // Deliberately do NOT attach outer abort to this idle lock socket. The product owns
    // when protected import/COMMIT/CAS work has settled enough to release its named locks.
    return socket;
  };
}
function installOperatorDispatcher(): void {
  if (operatorConnectionDispatcher) return;
  originalConnectionDescriptor = Object.getOwnPropertyDescriptor(mysql, "createConnection");
  originalConnectionFactory = mysql.createConnection;
  const original = originalConnectionFactory;
  const dispatcher: typeof mysql.createConnection = function (this: typeof mysql, ...args: Parameters<typeof mysql.createConnection> | [string]) {
    const scope = operatorContext.getStore();
    if (!scope || !activeOperatorScopes.has(scope)) return Reflect.apply(original, this, args) as ReturnType<typeof mysql.createConnection>;
    const options: unknown = args[0];
    if (this !== mysql || args.length !== 1 || !options || typeof options !== "object" || Object.getPrototypeOf(options) !== Object.prototype) throw invalid();
    const descriptors = Object.getOwnPropertyDescriptors(options);
    const expected = ["host", "port", "database", "user", "password", "connectTimeout", "enableKeepAlive", "multipleStatements", "supportBigNumbers", "bigNumberStrings"];
    if (Reflect.ownKeys(descriptors).length !== expected.length || expected.some(key => {
      const descriptor = descriptors[key]; return !descriptor?.enumerable || !("value" in descriptor);
    })) throw invalid();
    const value = Object.fromEntries(expected.map(key => [key, descriptors[key]!.value])) as Record<string, unknown>;
    const wanted = scope.addresses.find(address => address.host === value.host && address.port === value.port
      && address.database === value.database && address.user === value.user && address.password === value.password);
    if (!wanted || !Number.isSafeInteger(value.connectTimeout) || Number(value.connectTimeout) < 1 || Number(value.connectTimeout) > 10_000
      || value.enableKeepAlive !== false || value.multipleStatements !== false || value.supportBigNumbers !== true
      || value.bigNumberStrings !== true) throw invalid();
    const key = connectionAddressKey(wanted), count = (scope.calls.get(key) ?? 0) + 1;
    const expectedCount = scope.addresses.filter(address => connectionAddressKey(address) === key).length;
    if (count > expectedCount) throw invalid(); scope.calls.set(key, count);
    // The sole added option is a same-endpoint stream. All original options, raw native
    // Promise, receiver and resulting actual Connection are otherwise preserved.
    const raw = Reflect.apply(original, this, [{ ...options, stream: nativeOperatorStream(scope, wanted) }]) as Promise<Connection>;
    scope.native.add(raw); scope.owner.own(raw);
    void raw.then(connection => { scope.connections.add(connection); }, () => {});
    return raw;
  };
  operatorConnectionDispatcher = dispatcher;
  Object.defineProperty(mysql, "createConnection", { ...originalConnectionDescriptor, value: dispatcher });
}
function releaseOperatorDispatcher(scope: OperatorConnectionScope): void {
  if (!activeOperatorScopes.delete(scope) || activeOperatorScopes.size) return;
  const current = Object.getOwnPropertyDescriptor(mysql, "createConnection");
  // Do not overwrite an unrelated test's changed descriptor. A mismatch blocks cleanup.
  if (current?.value !== operatorConnectionDispatcher) scope.owner.rememberNativeFailure(invalid());
  else if (originalConnectionDescriptor) Object.defineProperty(mysql, "createConnection", originalConnectionDescriptor);
  else Reflect.deleteProperty(mysql, "createConnection");
  operatorConnectionDispatcher = undefined; originalConnectionFactory = undefined; originalConnectionDescriptor = undefined;
}

/** AsyncLocalStorage binds each actual asynchronous acquire to its own issued endpoints.
 * Nested/concurrent different-root operators cannot steal one another's native connections.
 * The returned Promise and frozen product operator are exactly the originals. */
export function observeArtifactOperatorAcquisition(owner: ArtifactFixtureNativeOwnership,
  options: MySqlBackupArtifactOperatorOptions, start: () => Promise<MySqlBackupArtifactOperator>): Promise<MySqlBackupArtifactOperator> {
  if (owner.signal.aborted || !owner.isIssuedOperatorEndpoint(options.sourceUrl)
    || options.targetUrl !== undefined && !owner.isIssuedOperatorEndpoint(options.targetUrl)) return Promise.reject(invalid());
  const scope: OperatorConnectionScope = { owner, addresses: [operatorAddress(options.sourceUrl),
    ...(options.targetUrl === undefined ? [] : [operatorAddress(options.targetUrl)])], calls: new Map(), native: new Set(), connections: new Set(), factorySettled: false };
  let accepted = operatorScopes.get(owner); if (!accepted) operatorScopes.set(owner, accepted = new Set()); accepted.add(scope);
  installOperatorDispatcher(); activeOperatorScopes.add(scope);
  let raw: Promise<MySqlBackupArtifactOperator>;
  try { raw = operatorContext.run(scope, start); }
  catch (reason) { scope.factorySettled = true;
    try { releaseOperatorDispatcher(scope); } catch (cleanup) { owner.rememberNativeFailure(cleanup); }
    return Promise.reject(reason); }
  const done = () => {
    scope.factorySettled = true;
    try { releaseOperatorDispatcher(scope); } catch (reason) { owner.rememberNativeFailure(reason); }
  };
  void raw.then(operator => {
    const totalCalls = [...scope.calls.values()].reduce((sum, count) => sum + count, 0);
    if (totalCalls !== scope.addresses.length || scope.addresses.some(address => {
      const key = connectionAddressKey(address);
      return scope.calls.get(key) !== scope.addresses.filter(candidate => connectionAddressKey(candidate) === key).length;
    })) owner.rememberNativeFailure(invalid());
    done(); return operator;
  }, done);
  return owner.own(raw);
}
async function closeArtifactOperatorConnections(owner: ArtifactFixtureNativeOwnership): Promise<void> {
  const scopes = [...(operatorScopes.get(owner) ?? [])];
  for (const scope of scopes) {
    if (!scope.factorySettled) throw invalid();
    await Promise.allSettled([...scope.native]);
  }
  // The caller already joined all protected work and actual product resource.close calls.
  // Only now can these remaining actual Connections be interrupted and socket.close joined.
  for (const scope of scopes) for (const connection of scope.connections) {
    try { connection.destroy(); } catch (reason) { owner.rememberNativeFailure(reason); }
  }
}

type RuntimeHandle = Awaited<ReturnType<typeof prepareMysqlRuntimeFixture>>;
type Metadata = NonNullable<MysqlStoreOptions["schemaMetadata"]>;
type RuntimeAccount = { readonly user: string; readonly host: string; readonly password?: string; attempted: boolean; created: boolean };
type DatabaseRole = {
  readonly operatorUrl: string; readonly database: string; readonly witness: Awaited<ReturnType<typeof witnessAbsentMysqlFixtureDatabase>>;
  createAttempted: boolean; created: boolean; initial?: RuntimeHandle; metadata?: Metadata; metadataDefiner?: RuntimeAccount; prebound?: RuntimeAccount;
  defaults:ArtifactFixtureStoreSelection; expectedSourcePrepared?:{readonly restoreRunId:string;readonly rowsSha256:string}; refusedObjectsSha256?:string; expectedUnactivated?:{readonly restoreRunId:string;readonly phase:"prepared"|"replay_sealed";readonly rowsSha256:string}; retirement?:{readonly rowsSha256:string;readonly bindingId:string;readonly names:readonly string[]};
  readonly accounts: RuntimeAccount[]; readonly historicalAccounts: Set<string>; metadataAttempted: boolean;
  current?: { readonly account: RuntimeAccount; readonly options: MysqlStoreOptions; readonly bindingId: string };
  staged?: ArtifactFixtureBinding; phase: "empty" | "current" | "imported-unbound" | "prepared" | "replay_sealed" | "source-prepared" | "retired" | "retained-corrupt";
  imported?: { readonly rowsSha256: string; readonly oldBindingId: string; readonly oldSequence: number; readonly oldRows: string };
};
/** Fixed per-source-transaction command. Instances never authorize a write themselves. */
export type ArtifactFixtureBinding = {
  readonly command: PreparedSessionAuthorityBindingCommand;
  readonly context: SessionAuthorityBindingOperatorContext;
  readonly account: RuntimeAccount;
  readonly commandFile: string;
  readonly authorityEnv: Readonly<Record<string,string>>;
  readonly database: string;
  confirmed: boolean;
};
export interface ArtifactFixtureStoreSelection {
  tenantTelemetryRefKey?: Uint8Array;
  tenantTelemetryPersistedProviderCaptureLocalOnly?: boolean;
  tenantTelemetryCaptureRestoreLocalOnly?: boolean;
  tenantRedisPurgeNamespaceSha256?: string;
}
function storeSelection(input: ArtifactFixtureStoreSelection = {}): ArtifactFixtureStoreSelection {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype) throw invalid();
  const result: ArtifactFixtureStoreSelection = {};
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input,key);
    if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)) throw invalid();
    const value: unknown = descriptor.value;
    if (key === "tenantTelemetryRefKey") {
      if (!(value instanceof Uint8Array) || value.byteLength !== 32) throw invalid(); result.tenantTelemetryRefKey = Buffer.from(value);
    } else if (key === "tenantTelemetryPersistedProviderCaptureLocalOnly" || key === "tenantTelemetryCaptureRestoreLocalOnly") {
      if (typeof value !== "boolean") throw invalid(); result[key] = value;
    } else if (key === "tenantRedisPurgeNamespaceSha256") {
      if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw invalid(); result.tenantRedisPurgeNamespaceSha256 = value;
    } else throw invalid();
  }
  return result;
}
function safeAccountError(reason: unknown): Error {
  const result = new Error("artifact_fixture_account_creation_failed");
  if (reason && typeof reason === "object") for (const key of ["code","errno","sqlState"] as const) {
    const value = Object.getOwnPropertyDescriptor(reason,key)?.value;
    if (key === "code" && typeof value === "string" && /^ER_[A-Z0-9_]{1,80}$/.test(value)
      || key === "errno" && typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 65535
      || key === "sqlState" && typeof value === "string" && /^[A-Z0-9]{5}$/.test(value))
      Object.defineProperty(result,key,{value,enumerable:true});
  }
  return result;
}

/** Private to the two physical-artifact consumers. Each registered DB is witnessed absent
 * before the caller's original CREATE. A restored DB never passes migrate/initial activation. */
export class ArtifactFixtureAuthority {
  private readonly roles = new Map<string, DatabaseRole>();
  private readonly held = new Set<MysqlSessionStore>();
  private readonly bindings = new Set<ArtifactFixtureBinding>();
  private closing = false;
  private uuid: string | undefined;
  constructor(readonly native: ArtifactFixtureNativeOwnership, private readonly privateDirectory: string,
    private readonly verifyExternalPhase:(operatorUrl:string,restoreRunId:string)=>Promise<void>) {}

  private role(url: string): DatabaseRole {
    const value = this.roles.get(url)??[...this.roles.values()].find(role=>role.current?.options.url===url
      ||role.prebound!==undefined&&this.restrictedUrl(role,role.prebound)===url);
    if (!value || !this.native.isIssuedOperatorEndpoint(value.operatorUrl)) throw invalid(); return value;
  }
  private active(url: string): DatabaseRole & { current: NonNullable<DatabaseRole["current"]>; metadata: Metadata } {
    const role = this.role(url);
    if (this.closing || role.phase !== "current" || !role.current || !role.metadata || role.staged && !role.staged.confirmed) throw invalid();
    return role as DatabaseRole & { current: NonNullable<DatabaseRole["current"]>; metadata: Metadata };
  }
  /** Exact original operator endpoint; no caller-supplied schema/profile/account override. */
  async witness(url: string): Promise<void> {
    if (this.closing || this.roles.has(url)) throw invalid(); this.native.admitDatabase(url);
    const database = decodeURIComponent(new URL(url).pathname.slice(1));
    const witness = await this.native.own(witnessAbsentMysqlFixtureDatabase({ operatorUrl:url, applicationDatabase:database,
      operationAbortSignal:this.native.signal }));
    this.roles.set(url,{operatorUrl:url,database,witness,createAttempted:false,created:false,accounts:[],historicalAccounts:new Set(),
      metadataAttempted:false,defaults:{},phase:"empty"});
  }
  beforeCreate(url: string): void { const role=this.role(url); if (role.createAttempted) throw invalid(); role.createAttempted=true; }
  created(url: string): void { const role=this.role(url); if (!role.createAttempted || role.created) throw invalid(); role.created=true; }

  private restrictedUrl(role:DatabaseRole,account:RuntimeAccount):string {
    if(account.password===undefined)throw invalid();const result=new URL(role.operatorUrl);result.username=account.user;result.password=account.password;return result.toString();
  }
  /** Actual native pool/query/rollback/socket ownership. Restricted calls are admitted only
   * with this registry's exact issued account; they run the existing native validators. */
  private nativeAt<T>(url: string, operation: (connection: PoolConnection)=>Promise<T>, signal=this.native.signal): Promise<T> {
    const admitted=this.native.isIssuedOperatorEndpoint(url)||[...this.roles.values()].some(role=>
      role.current?.options.url===url||role.prebound!==undefined&&this.restrictedUrl(role,role.prebound)===url);
    if (!admitted) return Promise.reject(invalid());
    return this.native.own((async()=>{
      const transport=createMysqlOperationAbortTransport(signal);
      let pool: ReturnType<typeof mysql.createPool>|undefined, scope:ReturnType<typeof bindMysqlOperationAbort>|undefined,
        connection:PoolConnection|undefined, result:T|undefined, failure:{reason:unknown}|undefined;
      try {
        signal.throwIfAborted(); pool=mysql.createPool({uri:url,connectionLimit:1,connectTimeout:10_000,
          stream:transport.stream,supportBigNumbers:true,bigNumberStrings:false,timezone:"Z"});
        scope=bindMysqlOperationAbort(pool,signal,transport); connection=await pool.getConnection();
        const [rows]=await connection.query<RowDataPacket[]>("SELECT @@GLOBAL.server_uuid AS uuid,DATABASE() AS db");
        const database=decodeURIComponent(new URL(url).pathname.slice(1));
        if(rows.length!==1||rows[0]?.db!==database||typeof rows[0]?.uuid!=="string"||!/^[a-f0-9-]{36}$/.test(rows[0].uuid)
          || this.uuid!==undefined&&this.uuid!==rows[0].uuid)throw invalid();
        this.uuid??=rows[0].uuid; result=await operation(connection); signal.throwIfAborted();
      }catch(reason){failure={reason};}
      finally {
        try{if(failure)connection?.destroy();else connection?.release();}catch(reason){failure??={reason};}
        try{if(scope)await scope.close();else if(pool)await pool.end();}catch(reason){failure??={reason};}
        transport.close(); try{await transport.settled();}catch(reason){failure??={reason};}
      }
      if(failure)throw failure.reason;return result as T;
    })());
  }
  async initial(url: string): Promise<void> {
    const role=this.role(url); if(this.closing||!role.created||role.phase!=="empty"||role.initial)throw invalid();
    const cwd=resolve(fileURLToPath(new URL("../../../",import.meta.url)));
    const entrypoint=fileURLToPath(new URL("../../../apps/agent-runner/src/main.ts",import.meta.url));
    let original:ReturnType<typeof captureMysqlFixtureAuthorityCommand>["command"]|undefined;
    role.initial=await this.native.own(prepareMysqlRuntimeFixture(role.witness,{
      schemaExecutor:createMysqlSchemaCliExecutor({entrypoint,mode:"source",cwd}),
      authorityExecutor:async operation=>{original=captureMysqlFixtureAuthorityCommand(operation.command).command;
        await createMysqlAuthorityCliExecutor({entrypoint,mode:"source",cwd})(operation);},
    }));
    if(!original||original.expectedBindingId!==null||original.expectedSequence!==0||original.newAccounts.length!==1)throw invalid();
    await role.initial.assertReusable(url);
    role.metadata=role.initial.runtimeStoreOptions.schemaMetadata;if(!role.metadata)throw invalid();
    const account={...original.newAccounts[0]!,attempted:true,created:true};role.accounts.push(account);role.historicalAccounts.add(account.user);
    role.current={account,options:role.initial.runtimeStoreOptions,bindingId:original.bindingId};role.phase="current";
    if(original.serverUuid!==this.native.observedServerUuid()||this.uuid!==undefined&&original.serverUuid!==this.uuid)throw invalid();this.uuid=original.serverUuid;
  }
  selection(url:string):ArtifactFixtureStoreSelection {return storeSelection(this.role(url).defaults);}
  configure(url:string,selection:ArtifactFixtureStoreSelection):void {
    const role=this.role(url),captured=storeSelection(selection);if(this.closing)throw invalid();
    for(const key of Object.keys(captured) as (keyof ArtifactFixtureStoreSelection)[]){
      const prior=role.defaults[key],next=captured[key];
      if(prior!==undefined&&(prior instanceof Uint8Array?!(next instanceof Uint8Array)||!Buffer.from(prior).equals(Buffer.from(next)):prior!==next))throw invalid();
    }
    role.defaults={...role.defaults,...captured};
  }
  options(url: string, selection?:ArtifactFixtureStoreSelection):MysqlStoreOptions {
    const role=this.role(url);if(this.closing||!role.metadata)throw invalid();
    const base=role.current?.options??(role.prebound?{url:this.restrictedUrl(role,role.prebound),migrationMode:"verify" as const,schemaMetadata:role.metadata}:undefined);
    if(!base)throw invalid();return {...base,...storeSelection(role.defaults),...storeSelection(selection)};
  }
  runtimeEnv(url: string):Readonly<Record<string,string>> {
    const role=this.active(url);return Object.freeze({MYSQL_URL:role.current.options.url,
      MYSQL_SCHEMA_METADATA_SCHEMA:role.metadata.metadataSchema,MYSQL_SCHEMA_METADATA_DEFINER_USER:role.metadata.trustedDefiner.user,
      MYSQL_SCHEMA_METADATA_DEFINER_HOST:role.metadata.trustedDefiner.host});
  }
  openStore(url:string, connectionLimit=2, selection?:ArtifactFixtureStoreSelection, signal?:AbortSignal):Promise<MysqlSessionStore> {
    this.active(url);const options=this.options(url,selection);
    return this.native.factory(async combined=>{
      const store=await MysqlSessionStore.connect({...options,connectionLimit,operationAbortSignal:combined});this.held.add(store);return store;
    },signal);
  }
  /** Explicit ordinary factory mapping; options retains all original non-authority fields. */
  connect(options:MysqlStoreOptions):Promise<MysqlSessionStore> {
    const role=this.active(options.url);
    const selected=this.options(role.operatorUrl,{
      ...(options.tenantTelemetryRefKey===undefined?{}:{tenantTelemetryRefKey:options.tenantTelemetryRefKey}),
      ...(options.tenantTelemetryPersistedProviderCaptureLocalOnly===undefined?{}:{tenantTelemetryPersistedProviderCaptureLocalOnly:options.tenantTelemetryPersistedProviderCaptureLocalOnly}),
      ...(options.tenantTelemetryCaptureRestoreLocalOnly===undefined?{}:{tenantTelemetryCaptureRestoreLocalOnly:options.tenantTelemetryCaptureRestoreLocalOnly}),
      ...(options.tenantRedisPurgeNamespaceSha256===undefined?{}:{tenantRedisPurgeNamespaceSha256:options.tenantRedisPurgeNamespaceSha256}),
    });
    // Ordinary factory receives the caller's explicit key absence/wrong-key unchanged;
    // only URL/metadata/migration profile are this registry's restricted resource mapping.
    if(options.tenantTelemetryRefKey===undefined)delete selected.tenantTelemetryRefKey;
    return this.native.factory(async signal=>{const store=await MysqlSessionStore.connect({...options,...selected,
      operationAbortSignal:signal});this.held.add(store);return store;},options.operationAbortSignal);
  }
  /** Fence new ordinary borrowing before joining every accepted original factory/pool. */
  private async fenceAndClose(role:DatabaseRole,accepted=this.native.accepted()):Promise<void> {
    if(role.phase!=="current"&&role.phase!=="imported-unbound")throw invalid();role.phase="retired";
    // Capture precedes the caller registering its own transition/factory Promise, so joining
    // all previously admitted work cannot form a transition -> itself cycle.
    let failure:{reason:unknown}|undefined;
    for(const result of await Promise.allSettled(accepted))if(result.status==="rejected")failure??={reason:result.reason};
    const closes:Promise<void>[]=[];
    for(const store of this.held)try{closes.push(store.close());}catch(reason){closes.push(Promise.reject(reason));}
    for(const result of await Promise.allSettled(closes))if(result.status==="rejected")failure??={reason:result.reason};
    if(failure)throw failure.reason;
  }
  private async grantRuntime(url:string,account:RuntimeAccount,metadata:Metadata,signal=this.native.signal):Promise<void> {
    const role=this.role(url);
    await this.nativeAt(url,async connection=>{
      const [prior]=await connection.query<RowDataPacket[]>("SELECT User FROM mysql.user WHERE BINARY User=BINARY ?",[account.user]);if(prior.length)throw invalid();
      account.attempted=true;
      try{await connection.query(`CREATE USER ${mysql.escape(account.user)}@${mysql.escape(account.host)} IDENTIFIED BY ?`,[account.password]);}
      catch(reason){throw safeAccountError(reason);}account.created=true;
      const [tables]=await connection.query<RowDataPacket[]>("SELECT TABLE_NAME FROM information_schema.TABLES WHERE BINARY TABLE_SCHEMA=BINARY ? AND TABLE_TYPE='BASE TABLE' ORDER BY BINARY TABLE_NAME",[role.database]);
      const names=tables.map(row=>row.TABLE_NAME),controls=["schema_migrations","session_authority_control","session_authority_bindings","session_authority_runtime_accounts"];
      if(!names.length||new Set(names).size!==names.length||names.some(name=>typeof name!=="string"||!/^[a-z0-9_]+$/.test(name))||controls.some(name=>!names.includes(name)))throw invalid();
      for(const name of names)await connection.query(`GRANT ${controls.includes(name)?"SELECT":"SELECT,INSERT,UPDATE,DELETE"} ON ${mysql.escapeId(role.database)}.${mysql.escapeId(String(name))} TO ${mysql.escape(account.user)}@${mysql.escape(account.host)}`);
      await connection.query(`GRANT SHOW_ROUTINE ON *.* TO ${mysql.escape(account.user)}@${mysql.escape(account.host)}`);
      await connection.query(`GRANT EXECUTE ON PROCEDURE ${mysql.escapeId(metadata.metadataSchema)}.${mysql.escapeId(createHash("sha256").update(role.database).digest("hex"))} TO ${mysql.escape(account.user)}@${mysql.escape(account.host)}`);
    },signal);
  }
  private async retire(url:string,names:readonly string[]):Promise<void> {
    // Same-server current predecessors are witnessed before native all-host retirement.
    // Their old durable rows/receipts remain byte-for-byte; they are never called ready.
    for(const prior of this.roles.values())if(prior.current&&names.includes(prior.current.account.user)&&prior.operatorUrl!==url){
      prior.retirement={rowsSha256:await this.rowsSha256(prior.operatorUrl),bindingId:prior.current.bindingId,names:[...names]};prior.phase="retired";
    }
    if(!names.length||new Set(names).size!==names.length)throw invalid();
    await this.nativeAt(url,async connection=>{
      for(const name of names){
        const [accounts]=await connection.query<RowDataPacket[]>("SELECT User,Host,account_locked FROM mysql.user WHERE BINARY User=BINARY ?",[name]);
        if(!accounts.length)throw invalid();
        for(const account of accounts){
          if(typeof account.Host!=="string"||!account.Host.length)throw invalid();
          const [busy]=await connection.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE BINARY USER=BINARY ?",[name]);
          if(busy.length!==1||Number(busy[0]?.n)!==0)throw invalid();
          // Revoke SHOW_ROUTINE if present, then exact all-host USAGE-only lock. No KILL/GRANT to ordinary.
          const [grants]=await connection.query<RowDataPacket[]>(`SHOW GRANTS FOR ${mysql.escape(name)}@${mysql.escape(account.Host)}`);
          if(grants.some(row=>Object.values(row).some(value=>typeof value==="string"&&/\bSHOW_ROUTINE\b/.test(value))))
            await connection.query(`REVOKE SHOW_ROUTINE ON *.* FROM ${mysql.escape(name)}@${mysql.escape(account.Host)}`);
          await connection.query(`REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${mysql.escape(name)}@${mysql.escape(account.Host)}`);
          await connection.query(`ALTER USER ${mysql.escape(name)}@${mysql.escape(account.Host)} ACCOUNT LOCK`);
        }
      }
    });
  }
  private async saveBinding(role:DatabaseRole,account:RuntimeAccount,data:Omit<SessionAuthorityBindingCommandInput,"bindingId"|"activationId"|"newAccounts"|"activationEvidenceSha256">):Promise<ArtifactFixtureBinding> {
    if(!role.metadata)throw invalid();
    const command=prepareSessionAuthorityBindingCommand({...data,bindingId:randomUUID(),activationId:randomUUID(),
      newAccounts:[{user:account.user,host:account.host}],activationEvidenceSha256:createHash("sha256").update(JSON.stringify([
        "physical-artifact-fixture-native-transition-v1",role.database,data.expectedBindingId,account.user,data.nextEpoch])).digest("hex")});
    const captured=captureSessionAuthorityBindingCommand(command),commandFile=join(this.privateDirectory,`authority-${captured.bindingId}.json`);
    const input:SessionAuthorityBindingCommandInput={bindingId:captured.bindingId,activationId:captured.activationId,
      expectedBindingId:captured.expectedBindingId,expectedSequence:captured.expectedSequence,serverUuid:captured.serverUuid,
      applicationDatabase:captured.applicationDatabase,newAccounts:captured.newAccounts,oldAccountNames:captured.oldAccountNames,
      activationEvidenceSha256:captured.activationEvidenceSha256,expectedSource:captured.expectedSource,nextEpoch:captured.nextEpoch};
    await writeFile(commandFile,JSON.stringify(input),{mode:0o600,flag:"wx"});
    const authorityEnv=Object.freeze({AUTHORITY_MYSQL_URL:role.operatorUrl,AUTHORITY_COMMAND_FILE:commandFile,
      AUTHORITY_FLEET_STOPPED_ACK:"all-application-writers-stopped-v1",AUTHORITY_EXCLUSIVE_CHANGE_ACK:"exclusive-authority-permissions-window-v1",
      AUTHORITY_METADATA_SCHEMA:role.metadata.metadataSchema,AUTHORITY_METADATA_DEFINER_USER:role.metadata.trustedDefiner.user,
      AUTHORITY_METADATA_DEFINER_HOST:role.metadata.trustedDefiner.host});
    const context=Object.freeze({command,schemaMetadata:role.metadata,assertNativeAdmission:assertSessionAuthorityActivationAdmission});
    const binding={command,context,account,commandFile,authorityEnv,database:role.database,confirmed:false};this.bindings.add(binding);role.staged=binding;return binding;
  }
  async stagePrimary(url:string,input:ActivateTenantRestoreJournalControlInput):Promise<ArtifactFixtureBinding> {
    const role=this.active(url),request=captureSessionAuthorityActivationRequest(prepareSessionAuthorityActivationRequest("primary_activation",input));
    if(request.kind!=="primary_activation"||!this.uuid||!role.metadata)throw invalid();
    const snapshot=await this.nativeAt(url,async connection=>{
      const before=await loadActiveSessionAuthorityBinding(connection,false),source=await readSessionAuthorityBindingSource(connection);
      if(before.bindingId!==role.current.bindingId)throw invalid();return {before,source};
    });
    await this.fenceAndClose(role);
    const account={user:"mba_r_"+randomBytes(8).toString("hex"),host:role.metadata.trustedDefiner.host,password:randomBytes(32).toString("hex"),attempted:false,created:false};
    role.accounts.push(account);await this.retire(url,[...role.historicalAccounts]);await this.grantRuntime(url,account,role.metadata);
    return this.saveBinding(role,account,{expectedBindingId:snapshot.before.bindingId,expectedSequence:snapshot.before.bindingSequence,
      serverUuid:this.uuid,applicationDatabase:role.database,oldAccountNames:[...role.historicalAccounts],expectedSource:snapshot.source,
      nextEpoch:{kind:"primary_activation",runtimeEpochSha256:request.input.runtimeEpochSha256,restoreRunId:null,
        activationRequestSha256:request.activationRequestSha256,sealedReplayReceiptSha256:null}});
  }
  /** Publication only after the original facade's actual same-command confirmation. */
  async confirmed(url:string,binding:ArtifactFixtureBinding):Promise<void> {
    const role=this.role(url);if(this.closing||!this.bindings.has(binding)||role.staged!==binding||binding.database!==role.database||!role.metadata)throw invalid();
    const command=captureSessionAuthorityBindingCommand(binding.command);
    const active=await this.nativeAt(url,connection=>loadActiveSessionAuthorityBinding(connection,false));
    if(active.bindingId!==command.bindingId||active.bindingSequence!==command.expectedSequence+1
      ||active.serverUuid!==this.uuid||active.applicationDatabase!==role.database)throw invalid();
    const restricted=new URL(url);restricted.username=binding.account.user;restricted.password=binding.account.password!;
    role.current={account:binding.account,options:{url:restricted.toString(),migrationMode:"verify",schemaMetadata:role.metadata},bindingId:command.bindingId};
    role.historicalAccounts.add(binding.account.user);binding.confirmed=true;role.phase="current";
  }

  /** Called only while a NEW actual authenticated capability and the original physical
   * source/target operator are held. This writes external metadata/accounts, never app rows. */
  async imported(url:string,operator:MySqlBackupArtifactOperator,signal:AbortSignal):Promise<void> {
    const role=this.role(url);if(this.closing||!role.created||role.phase!=="empty"||role.metadata||role.prebound)throw invalid();
    signal.throwIfAborted();await operator.assertHeld();
    await MysqlSessionStore.runSchemaOperation({url,operation:"verify",operationAbortSignal:signal});
    const saved=await this.nativeAt(url,async connection=>{
      const [identity]=await connection.query<RowDataPacket[]>("SELECT @@server_uuid AS server_uuid,DATABASE() AS database_name");
      const id=identity[0];
      if(identity.length!==1||typeof id?.server_uuid!=="string"||id.database_name!==role.database
        ||createHash("sha256").update(canonicalJson({scope:"mysql-physical-database-identity-v1",serverUuid:id.server_uuid.toLowerCase(),database:id.database_name})).digest("hex")!==operator.targetIdentitySha256)
        throw invalid();
      const [control]=await connection.query<RowDataPacket[]>("SELECT protocol,current_binding_id,binding_sequence FROM session_authority_control WHERE control_id=1");
      if(control.length!==1||control[0]?.protocol!=="mysql-live-session-v1"||typeof control[0]?.current_binding_id!=="string"
        ||!Number.isSafeInteger(Number(control[0].binding_sequence))||Number(control[0].binding_sequence)<1)throw invalid();
      const [accounts]=await connection.query<RowDataPacket[]>("SELECT account_user,account_host FROM session_authority_runtime_accounts ORDER BY BINARY account_user,BINARY account_host");
      if(!accounts.length||accounts.some(row=>typeof row.account_user!=="string"||typeof row.account_host!=="string"))throw invalid();
      const [bindings]=await connection.query<RowDataPacket[]>("SELECT * FROM session_authority_bindings ORDER BY binding_sequence");
      const source=await readSessionAuthorityBindingSource(connection);
      return {id:String(control[0].current_binding_id),sequence:Number(control[0].binding_sequence),accounts,source,
        oldRows:JSON.stringify({control,accounts,bindings})};
    },signal);
    role.imported={rowsSha256:await this.rowsSha256(url,signal),oldBindingId:saved.id,oldSequence:saved.sequence,oldRows:saved.oldRows};
    for(const account of saved.accounts)role.historicalAccounts.add(String(account.account_user));
    const suffix=randomBytes(8).toString("hex"),metadataSchema="agent_service_test_artifact_meta_"+suffix;
    const host=await this.nativeAt(url,async connection=>{
      const [rows]=await connection.query<RowDataPacket[]>("SELECT SUBSTRING_INDEX(USER(),'@',-1) AS host");
      const actual=rows[0]?.host;if(rows.length!==1||typeof actual!=="string"||!actual.length||actual.length>253||/[\u0000-\u0020\u007f%_@\\/]/.test(actual))throw invalid();return actual;
    },signal);
    const definer:RuntimeAccount={user:"mba_d_"+suffix,host,password:randomBytes(32).toString("hex"),attempted:false,created:false};
    const runtime:RuntimeAccount={user:"mba_r_"+suffix,host,password:randomBytes(32).toString("hex"),attempted:false,created:false};
    const metadata=Object.freeze({metadataSchema,trustedDefiner:Object.freeze({user:definer.user,host})});
    role.metadata=metadata;role.metadataDefiner=definer;role.prebound=runtime;role.accounts.push(runtime);
    await operator.assertHeld();
    await this.nativeAt(url,async connection=>{
      const [schemas]=await connection.query<RowDataPacket[]>("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?",[metadataSchema]);
      const [users]=await connection.query<RowDataPacket[]>("SELECT User FROM mysql.user WHERE BINARY User=BINARY ? OR BINARY User=BINARY ?",[definer.user,runtime.user]);
      if(schemas.length||users.length)throw invalid();role.metadataAttempted=true;
      await connection.query(`CREATE DATABASE ${mysql.escapeId(metadataSchema)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
      definer.attempted=true;try{await connection.query(`CREATE USER ${mysql.escape(definer.user)}@${mysql.escape(host)} IDENTIFIED BY ? ACCOUNT LOCK`,[definer.password]);}
      catch(reason){throw safeAccountError(reason);}definer.created=true;
      const [before]=await connection.query<RowDataPacket[]>("SELECT @@GLOBAL.partial_revokes AS enabled");
      if(before.length!==1||![0,1,"0","1"].includes(before[0]?.enabled))throw invalid();const partial=Number(before[0]!.enabled);
      const schema=partial===0?role.database.replace(/[%_]/g,"\\$&"):role.database;
      await connection.query(`GRANT TRIGGER ON ${mysql.escapeId(schema)}.* TO ${mysql.escape(definer.user)}@${mysql.escape(host)}`);
      const [after]=await connection.query<RowDataPacket[]>("SELECT @@GLOBAL.partial_revokes AS enabled");
      if(after.length!==1||Number(after[0]?.enabled)!==partial)throw invalid();
    },signal);
    await MysqlSessionStore.runSchemaOperation({url,operation:"install-metadata",fleetStoppedAck:"all-application-writers-stopped-v1",
      schemaMetadata:metadata,operationAbortSignal:signal});
    // Match the formal fresh fixture: the locked definer also receives only the
    // exact metadata procedure EXECUTE; its TRIGGER visibility remains application-scoped.
    await this.nativeAt(url,async connection=>{
      const routine=createHash("sha256").update(role.database).digest("hex");
      const [installed]=await connection.query<RowDataPacket[]>("SELECT ROUTINE_NAME,DEFINER,SECURITY_TYPE,ROUTINE_TYPE FROM information_schema.ROUTINES WHERE BINARY ROUTINE_SCHEMA=BINARY ?",[metadataSchema]);
      if(installed.length!==1||installed[0]?.ROUTINE_NAME!==routine||installed[0]?.DEFINER!==`${definer.user}@${host}`
        ||installed[0]?.SECURITY_TYPE!=="DEFINER"||installed[0]?.ROUTINE_TYPE!=="PROCEDURE")throw invalid();
      await connection.query(`GRANT EXECUTE ON PROCEDURE ${mysql.escapeId(metadataSchema)}.${mysql.escapeId(routine)} TO ${mysql.escape(definer.user)}@${mysql.escape(host)}`);
    },signal);
    await this.grantRuntime(url,runtime,metadata,signal);
    await this.nativeAt(this.restrictedUrl(role,runtime),async connection=>{
      await assertSchemaRuntimePrivileges(connection,metadata);await verifySchemaMetadataProcedureIdentity(connection,role.database,metadata);
      const [control]=await connection.query<RowDataPacket[]>("SELECT current_binding_id,binding_sequence FROM session_authority_control WHERE control_id=1");
      if(control.length!==1||control[0]?.current_binding_id!==saved.id||Number(control[0].binding_sequence)!==saved.sequence)throw invalid();
      // The new account is deliberately UNBOUND. Physical import did not grant live writer membership.
      const [members]=await connection.query<RowDataPacket[]>("SELECT account_user FROM session_authority_runtime_accounts WHERE BINARY account_user=BINARY ?",[runtime.user]);
      if(members.length!==0)throw invalid();
      // Ordinary active-capture connect may fail at its business gate first. Separately
      // exercise the actual native binding validator on this real prebound connection.
      let bindingRejected=false;
      try{await loadActiveSessionAuthorityBinding(connection,false);}
      catch(reason){if(!(reason instanceof SessionAuthorityError)||reason.code!=="session_authority_unavailable")throw reason;bindingRejected=true;}
      if(!bindingRejected)throw invalid();
    },signal);
    if(await this.rowsSha256(url,signal)!==role.imported.rowsSha256)throw invalid();
    await operator.assertHeld();signal.throwIfAborted();role.phase="imported-unbound";
  }
  private rowsSha256(url:string,signal=this.native.signal):Promise<string> {
    return this.nativeAt(url,async connection=>{
      await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");await connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
      let failure:{reason:unknown}|undefined;
      try{
        const [tables]=await connection.query<RowDataPacket[]>("SELECT TABLE_NAME FROM information_schema.TABLES WHERE BINARY TABLE_SCHEMA=BINARY ? AND TABLE_TYPE='BASE TABLE' ORDER BY BINARY TABLE_NAME",[this.role(url).database]);
        const hash=createHash("sha256");
        for(const table of tables){const name=table.TABLE_NAME;if(typeof name!=="string"||!/^[a-z0-9_]+$/.test(name))throw invalid();
          const [rows]=await connection.query<RowDataPacket[]>(`SELECT * FROM ${mysql.escapeId(name)}`);hash.update(JSON.stringify([name,rows.map(row=>JSON.stringify(row)).sort()]));}
        await connection.commit();return hash.digest("hex");
      }catch(reason){failure={reason};try{await connection.rollback();}catch(rollback){this.native.rememberNativeFailure(rollback);}throw failure.reason;}
    },signal);
  }
  /** Read-only fixed proposal. Retirement is postponed until the actual selected factory,
   * after the CLI has acquired its original operator and a new actual held GCM capability. */
  async stageRestore(url:string,restoreRunId:string):Promise<ArtifactFixtureBinding> {
    const role=this.role(url);if(this.closing||role.phase!=="imported-unbound"||!role.imported||!role.prebound||!role.metadata||role.staged||!this.uuid)throw invalid();
    const snapshot=await this.nativeAt(url,async connection=>{
      const [control]=await connection.query<RowDataPacket[]>("SELECT current_binding_id,binding_sequence FROM session_authority_control WHERE control_id=1");
      if(control.length!==1||control[0]?.current_binding_id!==role.imported!.oldBindingId||Number(control[0].binding_sequence)!==role.imported!.oldSequence)throw invalid();
      const [runtime]=await connection.query<RowDataPacket[]>("SELECT state,control_generation FROM tenant_restore_runtime_control WHERE singleton_id=1");
      const [runs]=await connection.query<RowDataPacket[]>("SELECT phase,runtime_epoch_sha256,terminal_receipt_sha256 FROM tenant_restore_replay_runs WHERE BINARY restore_run_id=BINARY ?",[restoreRunId]);
      if(runtime.length!==1||runtime[0]?.state!=="active"||runs.length!==1||runs[0]?.phase!=="replay_sealed"
        ||typeof runs[0].runtime_epoch_sha256!=="string"||typeof runs[0].terminal_receipt_sha256!=="string")throw invalid();
      const request=captureSessionAuthorityActivationRequest(prepareSessionAuthorityActivationRequest("restore_activation",{
        restoreRunId,expectedControlGeneration:Number(runtime[0].control_generation)}));
      if(request.kind!=="restore_activation")throw invalid();
      return {request,run:runs[0],source:await readSessionAuthorityBindingSource(connection)};
    });
    return this.saveBinding(role,role.prebound,{expectedBindingId:role.imported.oldBindingId,expectedSequence:role.imported.oldSequence,
      serverUuid:this.uuid,applicationDatabase:role.database,oldAccountNames:[...role.historicalAccounts].sort(),expectedSource:snapshot.source,
      nextEpoch:{kind:"restore_activation",runtimeEpochSha256:String(snapshot.run.runtime_epoch_sha256),restoreRunId,
        activationRequestSha256:snapshot.request.activationRequestSha256,sealedReplayReceiptSha256:String(snapshot.run.terminal_receipt_sha256)}});
  }
  /** Called from the selected actual module factory, with its unchanged operator profile.
   * It returns the SAME profile/context; neither a proxy facade nor an authorization DTO is made. */
  async retireForSelected(url:string,context:SessionAuthorityBindingOperatorContext,operator:MySqlBackupArtifactOperator,accepted:readonly Promise<unknown>[]):Promise<void> {
    const role=this.role(url),binding=role.staged;
    if(this.closing||!binding||!["imported-unbound","retired","current"].includes(role.phase))throw invalid();
    const fixed=captureSessionAuthorityBindingCommand(binding.command),actual=captureSessionAuthorityBindingCommand(context.command);
    if(!role.metadata||JSON.stringify(fixed)!==JSON.stringify(actual)||context.schemaMetadata.metadataSchema!==role.metadata.metadataSchema
      ||context.schemaMetadata.trustedDefiner.user!==role.metadata.trustedDefiner.user
      ||context.schemaMetadata.trustedDefiner.host!==role.metadata.trustedDefiner.host
      ||context.assertNativeAdmission!==assertSessionAuthorityActivationAdmission)throw invalid();
    await operator.assertHeld();
    if(binding.confirmed)return; // Same command confirm; never mint a successor on exact replay.
    if(role.phase==="retired"){await this.assertRetiredNames(url,fixed.oldAccountNames);return;}
    // All previously accepted ordinary pools must be genuinely closed. The product's two
    // named-lock connections use the operator account and remain held throughout this phase.
    await this.fenceAndClose(role,accepted);await this.retire(url,fixed.oldAccountNames);await operator.assertHeld();
  }
  metadata(url:string):Metadata {const role=this.role(url);if(!role.metadata)throw invalid();return role.metadata;}
  staged(url:string):ArtifactFixtureBinding|undefined{return this.role(url).staged;}
  phase(url:string):DatabaseRole["phase"]{return this.role(url).phase;}

  /** Before a refusal attempt, seal only this issued target's original complete objects/data. */
  async witnessRefusedTarget(url:string):Promise<void> {
    const role=this.role(url);if(this.closing||role.phase!=="empty"||role.initial||role.imported||role.refusedObjectsSha256!==undefined)throw invalid();
    role.refusedObjectsSha256=await this.refusedObjectsSnapshot(role);
  }
  private refusedObjectsSnapshot(role:DatabaseRole):Promise<string> {
    return this.nativeAt(role.operatorUrl,async connection=>{
      const rows:unknown[]=[];
      const [tables]=await connection.query<RowDataPacket[]>("SELECT TABLE_NAME,TABLE_TYPE FROM information_schema.TABLES WHERE BINARY TABLE_SCHEMA=BINARY ? ORDER BY BINARY TABLE_NAME",[role.database]);
      for(const table of tables){const name=table.TABLE_NAME,kind=table.TABLE_TYPE;
        if(typeof name!=="string"||!name.length||name.length>64||!["BASE TABLE","VIEW"].includes(String(kind)))throw invalid();
        const [definition]=await connection.query<RowDataPacket[]>(`SHOW CREATE ${kind==="VIEW"?"VIEW":"TABLE"} ${mysql.escapeId(name)}`);rows.push([kind,name,definition]);
        if(kind==="BASE TABLE"){const [values]=await connection.query<RowDataPacket[]>(`SELECT * FROM ${mysql.escapeId(name)}`);rows.push(["rows",name,values.map(row=>JSON.stringify(row)).sort()]);}
      }
      const [routines]=await connection.query<RowDataPacket[]>("SELECT ROUTINE_NAME,ROUTINE_TYPE FROM information_schema.ROUTINES WHERE BINARY ROUTINE_SCHEMA=BINARY ? ORDER BY BINARY ROUTINE_NAME",[role.database]);
      for(const routine of routines){if(typeof routine.ROUTINE_NAME!=="string"||!["PROCEDURE","FUNCTION"].includes(String(routine.ROUTINE_TYPE)))throw invalid();
        const [definition]=await connection.query<RowDataPacket[]>(`SHOW CREATE ${routine.ROUTINE_TYPE} ${mysql.escapeId(routine.ROUTINE_NAME)}`);rows.push(["routine",definition]);}
      const [events]=await connection.query<RowDataPacket[]>("SELECT EVENT_NAME FROM information_schema.EVENTS WHERE BINARY EVENT_SCHEMA=BINARY ? ORDER BY BINARY EVENT_NAME",[role.database]);
      for(const event of events){if(typeof event.EVENT_NAME!=="string")throw invalid();const [definition]=await connection.query<RowDataPacket[]>(`SHOW CREATE EVENT ${mysql.escapeId(event.EVENT_NAME)}`);rows.push(["event",definition]);}
      return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    });
  }
  /** Exactly one current physical source case selects this after all original oracles.
   * Keep complete fresh startup; readiness, rather than connect, must reject its pending run. */
  async expectPreparedSource(url:string,restoreRunId:string):Promise<void> {
    const role=this.active(url);if(role.expectedSourcePrepared)throw invalid();
    await this.nativeAt(role.operatorUrl,async connection=>{
      const [runs]=await connection.query<RowDataPacket[]>("SELECT phase FROM tenant_restore_replay_runs WHERE BINARY restore_run_id=BINARY ?",[restoreRunId]);
      if(runs.length!==1||runs[0]?.phase!=="prepared")throw invalid();
    });role.expectedSourcePrepared={restoreRunId,rowsSha256:await this.rowsSha256(role.operatorUrl)};role.phase="source-prepared";
  }
  async expectUnactivated(url:string,restoreRunId:string,phase:"prepared"|"replay_sealed"):Promise<void> {
    const role=this.role(url);if(this.closing||!role.imported||!role.prebound||role.staged||role.current
      ||!["prepared","replay_sealed"].includes(phase))throw invalid();
    await this.nativeAt(url,async connection=>{
      const [runs]=await connection.query<RowDataPacket[]>("SELECT phase FROM tenant_restore_replay_runs WHERE BINARY restore_run_id=BINARY ?",[restoreRunId]);
      if(runs.length!==1||runs[0]?.phase!==phase)throw invalid();
    });
    role.expectedUnactivated={restoreRunId,phase,rowsSha256:await this.rowsSha256(url)};role.phase=phase;
  }
  retainCorrupt(url:string):void {const role=this.role(url);if(this.closing||!role.created)throw invalid();role.phase="retained-corrupt";}

  /** All checks are completed before the first irreversible DROP. This returns false for
   * an intentionally retained corrupt target and keeps its dependent artifact/prefix too. */
  async closeInitialHandles():Promise<void> {
    let failure:{reason:unknown}|undefined;
    const closes:Promise<void>[]=[];
    for(const role of this.roles.values())if(role.initial)try{closes.push(role.initial.close({successful:false}));}catch(reason){closes.push(Promise.reject(reason));}
    for(const result of await Promise.allSettled(closes))if(result.status==="rejected")failure??={reason:result.reason};
    if(failure)throw failure.reason;
  }
  async verifyBeforeCleanup(successful:boolean):Promise<boolean> {
    if(this.closing)throw invalid();this.closing=true;
    if(!successful){await artifactCloseAfter(()=>this.native.close(),()=>this.closeInitialHandles());return false;}
    await this.native.closeVisitors();
    await this.closeInitialHandles();
    if([...this.roles.values()].some(role=>role.phase==="retained-corrupt"))return false;
    for(const role of this.roles.values()){
      if(!role.created)throw invalid();
      if(role.phase==="empty"){
        await this.nativeAt(role.operatorUrl,async connection=>{
          const [counts]=await connection.query<RowDataPacket[]>("SELECT (SELECT COUNT(*) FROM information_schema.TABLES WHERE BINARY TABLE_SCHEMA=BINARY ?)+(SELECT COUNT(*) FROM information_schema.ROUTINES WHERE BINARY ROUTINE_SCHEMA=BINARY ?)+(SELECT COUNT(*) FROM information_schema.EVENTS WHERE BINARY EVENT_SCHEMA=BINARY ?) AS n",[role.database,role.database,role.database]);
          if(counts.length!==1||!Number.isSafeInteger(Number(counts[0]?.n)))throw invalid();
          if(role.refusedObjectsSha256===undefined&&Number(counts[0]?.n)!==0)throw invalid();
        });if(role.refusedObjectsSha256!==undefined&&await this.refusedObjectsSnapshot(role)!==role.refusedObjectsSha256)throw invalid();continue;
      }
      if(!role.metadata)throw invalid();
      await MysqlSessionStore.runSchemaOperation({url:role.operatorUrl,operation:"verify",operationAbortSignal:this.native.signal});
      if(role.phase==="current"||role.phase==="source-prepared"){
        if(!role.current||role.staged&&!role.staged.confirmed)throw invalid();
        const actual=await this.native.factory(signal=>MysqlSessionStore.connect({...role.current!.options,...storeSelection(role.defaults),connectionLimit:1,operationAbortSignal:signal}));
        await artifactCloseAfter(async()=>{
          await actual.sessionAuthority.identity();
          if(role.phase==="source-prepared"){
            const expected=role.expectedSourcePrepared;if(!expected||await this.rowsSha256(role.operatorUrl)!==expected.rowsSha256)throw invalid();
            const run=await actual.getTenantRestoreReplayRun(expected.restoreRunId),control=await actual.getTenantRestoreRuntimeControl(),heads=await actual.getTenantRestoreRuntimeHeads();
            if(run?.phase!=="prepared"||control.state!=="active")throw invalid();
            let rejected=false;try{await actual.assertTenantRestoreRuntimeReady({runtimeEpochSha256:control.runtimeEpochSha256,
              controlEvidenceSha256:control.controlEvidenceSha256,observedHeads:heads});}
            catch(reason){if(!(reason instanceof TenantErasureIntegrityError))throw reason;rejected=true;}
            if(!rejected||await this.rowsSha256(role.operatorUrl)!==expected.rowsSha256)throw invalid();
          }
        },()=>actual.close());
        await this.nativeAt(role.current.options.url,async connection=>{
          await assertSessionAuthorityRuntimeConnection(connection,role.metadata);await verifySchemaMetadataProcedureIdentity(connection,role.database,role.metadata!);
          const active=await loadActiveSessionAuthorityBinding(connection,false);if(active.bindingId!==role.current!.bindingId)throw invalid();
        });
      }else if(role.phase==="retired"){
        const retirement=role.retirement;if(!retirement||!role.current||role.current.bindingId!==retirement.bindingId
          ||await this.rowsSha256(role.operatorUrl)!==retirement.rowsSha256)throw invalid();
        await this.nativeAt(role.operatorUrl,async connection=>{
          await verifySchemaMetadataProcedureIdentity(connection,role.database,role.metadata!);
          const old=await loadActiveSessionAuthorityBinding(connection,false);if(old.bindingId!==retirement.bindingId||old.serverUuid!==this.uuid)throw invalid();
        });
        const successors=[...this.roles.values()].filter(target=>target.phase==="current"&&target.staged?.confirmed&&target.current&&target.operatorUrl!==role.operatorUrl
          &&captureSessionAuthorityBindingCommand(target.staged.command).oldAccountNames.includes(role.current!.account.user));
        if(successors.length!==1||!this.uuid)throw invalid();
        // Native actual current successor must be this same MySQL server; no remote fencing claim.
        await this.nativeAt(successors[0]!.operatorUrl,async connection=>{
          const active=await loadActiveSessionAuthorityBinding(connection,false);if(active.bindingId!==successors[0]!.current!.bindingId||active.serverUuid!==this.uuid)throw invalid();
        });
        await this.assertRetiredNames(role.operatorUrl,retirement.names);
      }else if(role.phase==="prepared"||role.phase==="replay_sealed"){
        const expected=role.expectedUnactivated;if(!expected||!role.imported||!role.prebound||role.current||role.staged
          ||await this.rowsSha256(role.operatorUrl)!==expected.rowsSha256)throw invalid();
        await this.nativeAt(this.restrictedUrl(role,role.prebound),async connection=>{
          await assertSchemaRuntimePrivileges(connection,role.metadata!);await verifySchemaMetadataProcedureIdentity(connection,role.database,role.metadata!);
          let rejected=false;try{await loadActiveSessionAuthorityBinding(connection,false);}catch(reason){
            if(!(reason instanceof SessionAuthorityError)||reason.code!=="session_authority_unavailable")throw reason;rejected=true;}
          if(!rejected)throw invalid();
          const [control]=await connection.query<RowDataPacket[]>("SELECT current_binding_id,binding_sequence FROM session_authority_control WHERE control_id=1");
          const [membership]=await connection.query<RowDataPacket[]>("SELECT account_user FROM session_authority_runtime_accounts WHERE BINARY account_user=BINARY ?",[role.prebound!.user]);
          const [runs]=await connection.query<RowDataPacket[]>("SELECT phase FROM tenant_restore_replay_runs WHERE BINARY restore_run_id=BINARY ?",[expected.restoreRunId]);
          if(control.length!==1||control[0]?.current_binding_id!==role.imported!.oldBindingId||Number(control[0]?.binding_sequence)!==role.imported!.oldSequence
            ||membership.length||runs.length!==1||runs[0]?.phase!==expected.phase)throw invalid();
        });
      }else throw invalid();
    }
    // A native row hash cannot prove the external reservation. These callback reads use
    // this fixture's actual GET-only committed-chain observation, never readHead mutation.
    for(const role of this.roles.values()){
      const expected=role.expectedUnactivated??role.expectedSourcePrepared;
      if(expected)await this.verifyExternalPhase(role.operatorUrl,expected.restoreRunId);
    }
    await this.native.closeVisitors();
    // Original resource objects cannot reconnect after close. Prove native zero references
    // and exact known labels/locks for every role before granting the caller delete authority.
    await this.assertCleanupResources();return true;
  }
  private async assertRetiredNames(url:string,names:readonly string[]):Promise<void> {
    await this.nativeAt(url,async connection=>{for(const name of names){
      const [rows]=await connection.query<RowDataPacket[]>("SELECT User,Host,account_locked FROM mysql.user WHERE BINARY User=BINARY ?",[name]);if(!rows.length)throw invalid();
      for(const row of rows){if(row.account_locked!=="Y"||typeof row.Host!=="string")throw invalid();
        const [grants]=await connection.query<RowDataPacket[]>(`SHOW GRANTS FOR ${mysql.escape(name)}@${mysql.escape(row.Host)}`);
        if(grants.length!==1||Object.values(grants[0]!).length!==1||Object.values(grants[0]!)[0]!==`GRANT USAGE ON *.* TO \`${name}\`@\`${row.Host}\``)throw invalid();}
    }});
  }
  private async assertCleanupResources():Promise<void> {
    const root=[...this.roles.values()][0];if(!root||!this.uuid)throw invalid();
    const names=new Map<string,{host:string;locked:string}>();
    for(const role of this.roles.values()){
      if(role.metadata)names.set(role.metadata.trustedDefiner.user,{host:role.metadata.trustedDefiner.host,locked:"Y"});
      for(const account of role.accounts)if(account.attempted){
        const retired=[...this.roles.values()].some(value=>value.staged?.confirmed&&captureSessionAuthorityBindingCommand(value.staged.command).oldAccountNames.includes(account.user));
        names.set(account.user,{host:account.host,locked:retired?"Y":"N"});}
    }
    await this.nativeAt(root.operatorUrl,async connection=>{
      for(const [name,expected] of names){const [accounts]=await connection.query<RowDataPacket[]>("SELECT User,Host,account_locked FROM mysql.user WHERE BINARY User=BINARY ?",[name]);
        if(accounts.length!==1||accounts[0]?.Host!==expected.host||accounts[0]?.account_locked!==expected.locked)throw invalid();
        const [busy]=await connection.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE BINARY USER=BINARY ?",[name]);if(busy.length!==1||Number(busy[0]?.n)!==0)throw invalid();}
      for(const role of this.roles.values())for(const name of [role.database,...(role.metadata?[role.metadata.metadataSchema]:[])]){
        // The verifier's own operator connection is the only permitted app process here.
        const [busy]=await connection.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE BINARY DB=BINARY ? AND ID<>CONNECTION_ID()",[name]);
        const [tx]=await connection.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM information_schema.INNODB_TRX t JOIN information_schema.PROCESSLIST p ON p.ID=t.trx_mysql_thread_id WHERE BINARY p.DB=BINARY ?",[name]);
        const [locks]=await connection.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM performance_schema.metadata_locks WHERE BINARY OBJECT_SCHEMA=BINARY ? OR (OBJECT_TYPE='SCHEMA' AND BINARY OBJECT_NAME=BINARY ?)",[name,name]);
        if([busy,tx,locks].some(rows=>rows.length!==1||Number(rows[0]?.n)!==0))throw invalid();
      }
    });
  }
  async dropKnownResources():Promise<void> {
    if(!this.closing)throw invalid();const root=[...this.roles.values()][0];if(!root)throw invalid();
    // Nothing is dropped until all role/native/fullcold checks completed successfully.
    await this.assertCleanupResources();
    await this.nativeAt(root.operatorUrl,async connection=>{
      for(const role of this.roles.values())if(role.metadata){
        await connection.query(`DROP DATABASE ${mysql.escapeId(role.metadata.metadataSchema)}`);
        const [left]=await connection.query<RowDataPacket[]>("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?",[role.metadata.metadataSchema]);
        if(left.length)throw invalid();
      }
      const accounts=new Map<string,string>();for(const role of this.roles.values()){
        if(role.metadata)accounts.set(role.metadata.trustedDefiner.user,role.metadata.trustedDefiner.host);
        for(const account of role.accounts)if(account.created)accounts.set(account.user,account.host);}
      for(const [user,host]of accounts){await connection.query(`DROP USER ${mysql.escape(user)}@${mysql.escape(host)}`);
        const [left]=await connection.query<RowDataPacket[]>("SELECT User FROM mysql.user WHERE BINARY User=BINARY ?",[user]);if(left.length)throw invalid();}
    });
  }
  zeroKeys():void {if(!this.closing)throw invalid();for(const role of this.roles.values())role.defaults.tenantTelemetryRefKey?.fill(0);}
  retainedLabels():readonly Record<string,unknown>[] {
    return [...this.roles.values()].map(role=>({applicationDatabase:role.database,metadataSchema:role.metadata?.metadataSchema??null,
      runtimeAccounts:role.accounts.map(account=>account.user),historicalRuntimeAccounts:[...role.historicalAccounts],phase:role.phase,status:"retained_or_unknown"}));
  }

}


/** Artifact-private real SDK owner. Original SDK config/send Promise/response Body and
 * receiver are retained; only SDK-default Agents gain actual socket/DNS close observation. */
export function createArtifactFixtureS3Client(config:S3ClientConfig,signal?:AbortSignal){
  let stopped=false,closing:Promise<void>|undefined,failure:{reason:unknown}|undefined;
  const pending=new Set<Promise<unknown>>(),closes=new Set<Promise<unknown>>(),sockets=new Set<Readable>(),bodies=new Set<Readable>();
  const remember=(reason:unknown)=>{failure??={reason};};
  const own=<T>(raw:Promise<T>):Promise<T>=>{pending.add(raw);void raw.then(()=>pending.delete(raw),()=>pending.delete(raw));return raw;};
  const nativeLookup:LookupFunction=(hostname,options,callback)=>{
    if(stopped)throw invalid();let done!:()=>void;const raw=new Promise<void>(resolve=>{done=resolve;});closes.add(raw);
    const finish=()=>{closes.delete(raw);done();};
    try{lookup(hostname,options,(error,address,family)=>{try{callback(error,address,family);}finally{finish();}});}
    catch(reason){finish();throw reason;}
  };
  const httpAgent=new HttpAgent({keepAlive:true,maxSockets:50,lookup:nativeLookup}),httpsAgent=new HttpsAgent({keepAlive:true,maxSockets:50,lookup:nativeLookup});
  const observe=(actual:Readable,registry:Set<Readable>)=>{
    if(actual.closed||sockets.has(actual)||bodies.has(actual))return;registry.add(actual);
    const onError=()=>{};actual.on("error",onError);
    const closed=new Promise<void>(resolve=>actual.once("close",()=>{registry.delete(actual);actual.off("error",onError);resolve();}));
    closes.add(closed);void closed.then(()=>closes.delete(closed));if(stopped)try{actual.destroy();}catch(reason){remember(reason);}
  };
  const observeAgent=(agent:HttpAgent)=>{
    const original=agent.createConnection;
    agent.createConnection=function(this:HttpAgent,...args:Parameters<typeof original>){
      if(stopped)throw invalid();const socket=Reflect.apply(original,this,args) as ReturnType<typeof original>;
      if(!socket)throw invalid();observe(socket,sockets);return socket;
    };
  };
  observeAgent(httpAgent);observeAgent(httpsAgent);
  let client:S3Client;
  try{client=new S3Client({...config,requestHandler:{httpAgent,httpsAgent}});}
  catch(reason){for(const agent of [httpAgent,httpsAgent])try{agent.destroy();}catch{}throw reason;}
  const send=client.send;
  Object.defineProperty(client,"send",{configurable:true,writable:true,value:function(this:S3Client,...args:unknown[]){
    if(this!==client||stopped)throw invalid();const raw:unknown=Reflect.apply(send,this,args);if(!(raw instanceof Promise))throw invalid();own(raw);
    void raw.then(output=>{
      if(!output||typeof output!=="object")return;const descriptor=Object.getOwnPropertyDescriptor(output,"Body");
      if(!descriptor)return;if(!("value"in descriptor)){remember(invalid());return;}const body:unknown=descriptor.value;
      if(body===undefined||body instanceof Uint8Array)return;if(!(body instanceof Readable)){remember(invalid());return;}observe(body,bodies);
    },()=>{}).catch(remember);return raw;
  }});
  const stop=()=>{stopped=true;for(const operation of [()=>client.destroy(),()=>httpAgent.destroy(),()=>httpsAgent.destroy(),
    ...[...sockets].map(socket=>()=>socket.destroy()),...[...bodies].map(body=>()=>body.destroy())])try{operation();}catch(reason){remember(reason);}};
  signal?.addEventListener("abort",stop,{once:true});if(signal?.aborted)stop();
  return {client,stop,close():Promise<void>{return closing??=(async()=>{
    stop();try{while(pending.size||closes.size)await Promise.allSettled([...pending,...closes]);}
    finally{signal?.removeEventListener("abort",stop);}if(failure)throw failure.reason;
  })();}};
}
