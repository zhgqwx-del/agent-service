import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, open, realpath, rm, rmdir, stat, lstat, unlink, link, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import {
  tenantBackupSchemaMigrationRootSha256, validateTenantBackupSnapshotAnchor,
  assertTenantTelemetryCaptureCheckpointLeaves,
  assertTenantTelemetryCaptureLineageLeaves,
  assertMysqlSessionStoreDatabaseBinding,
  readTenantTelemetryCaptureCheckpointFromMysql,
  PERSISTED_PROVIDER_CAPTURE_PROTOCOL, PERSISTED_PROVIDER_CAPTURE_PRODUCER_PROTOCOL, PERSISTED_PROVIDER_CAPTURE_CONTRACT_SHA256,
  TENANT_TELEMETRY_CAPTURE_CHECKPOINT_SQL,
  TENANT_TELEMETRY_CAPTURE_CHECKPOINT_V2_SCOPE,
  type TenantBackupSnapshotAnchor,
  type TenantTelemetryCaptureBackupCheckpoint,
  type TenantTelemetryCaptureBackupCheckpointStore,
} from "@agent-service/store";
import {
  MYSQL_BACKUP_ARTIFACT_MAGIC, MYSQL_BACKUP_ARTIFACT_MANIFEST_LIMIT,
  MYSQL_BACKUP_ARTIFACT_PRODUCER_VERSION, MYSQL_BACKUP_ARTIFACT_SCOPE, MYSQL_BACKUP_ARTIFACT_SCHEMA_SCOPE,
  MYSQL_BACKUP_ARTIFACT_V2_MAGIC, MYSQL_BACKUP_ARTIFACT_V2_MANIFEST_LIMIT,
  MYSQL_BACKUP_ARTIFACT_V2_PRODUCER_VERSION, MYSQL_BACKUP_ARTIFACT_V2_SCOPE,
  MYSQL_BACKUP_ARTIFACT_V3_MAGIC, MYSQL_BACKUP_ARTIFACT_V3_MANIFEST_LIMIT,
  MYSQL_BACKUP_ARTIFACT_V3_PRODUCER_VERSION, MYSQL_BACKUP_ARTIFACT_V3_SCOPE,
  MySqlBackupArtifactError, artifactAad, artifactEvidence, artifactFailure,
  assertArtifactCaptureCheckpoint, assertArtifactEvidence, canonicalJson, canonicalMySqlBackupTableDefinition, decodeArtifactManifest, encodeArtifactManifest, sha256,
  type ArtifactEvidence, type MySqlBackupArtifactManifest, type MySqlBackupArtifactImportDiagnostic,
} from "./mysql-backup-artifact-codec.js";
import { assertMySqlBackupArtifactSourceObserved, type MySqlBackupArtifactSourceObserver } from "./mysql-backup-artifact-source-observer.js";

export { MySqlBackupArtifactError };
export type { ArtifactEvidence, MySqlBackupArtifactManifest, MySqlBackupArtifactImportDiagnostic };

const MAX_MANIFEST_LIMIT = Math.max(MYSQL_BACKUP_ARTIFACT_V2_MANIFEST_LIMIT, MYSQL_BACKUP_ARTIFACT_V3_MANIFEST_LIMIT);

export interface MySqlBackupArtifactTools { mysql: string; mysqldump: string }
export interface MySqlBackupArtifactOptions {
  artifactDirectory: string;
  deadlineMs: number;
  localOnlyAck: true;
  nodeEnv?: string;
  operationAbortSignal?: AbortSignal;
  /** Protected operator ref key, distinct from the artifact encryption key. Never serialized. */
  tenantTelemetryRefKey?: Uint8Array;
}
export interface MySqlBackupArtifactOperatorOptions extends MySqlBackupArtifactOptions {
  sourceUrl: string;
  targetUrl?: string;
  fleetStoppedAck: true;
}
export interface MySqlBackupArtifactOperator {
  readonly sourceIdentitySha256: string;
  readonly targetIdentitySha256?: string;
  assertHeld(): Promise<void>;
  bindRestoreOperation(input: {
    manifest: MySqlBackupArtifactManifest; evidence: ArtifactEvidence;
    restoreRunId: string; runtimeEpochSha256: string;
  }): Promise<void>;
  markRestorePrepared(restoreRunId: string): Promise<void>;
  close(): Promise<void>;
}
export interface CreateMySqlBackupArtifactOptions extends MySqlBackupArtifactOptions {
  sourceUrl: string;
  anchor: TenantBackupSnapshotAnchor;
  keyFile: string;
  tools: MySqlBackupArtifactTools;
  maxBytes: number;
  fleetStoppedAck: true;
  operator?: MySqlBackupArtifactOperator;
  /** The actual source store; only its verified-null result permits the legacy v1 envelope. */
  captureCheckpointStore: TenantTelemetryCaptureBackupCheckpointStore;
  /** Branded read-only assembly; required for new restored-source/CP2 bytes.
   * Existing authenticated artifacts never re-observe today's mutable source. */
  sourceObserver?: MySqlBackupArtifactSourceObserver;
}
export interface VerifyMySqlBackupArtifactOptions extends MySqlBackupArtifactOptions {
  backupId: string;
  keyFile: string;
  maxBytes: number;
  expectedAnchor?: TenantBackupSnapshotAnchor;
  expectedEvidence?: ArtifactEvidence;
}
/** A capability backed by a held, already authenticated, unlinked private file. No pathname or FD is exposed. */
export interface VerifiedMySqlBackupArtifact {
  readonly manifest: MySqlBackupArtifactManifest;
  readonly evidence: ArtifactEvidence;
  close(): Promise<void>;
}
export interface ImportVerifiedMySqlBackupArtifactOptions {
  targetUrl: string;
  tools: MySqlBackupArtifactTools;
  deadlineMs: number;
  localOnlyAck: true;
  fleetStoppedAck: true;
  nodeEnv?: string;
  operationAbortSignal?: AbortSignal;
  operator: MySqlBackupArtifactOperator;
  restoreRunId: string;
  runtimeEpochSha256: string;
}

class Deadline {
  readonly controller = new AbortController();
  readonly expires: number;
  readonly wallExpires: number;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly abortListeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  constructor(ms: number, parent?: Deadline, signal?: AbortSignal) {
    if (!Number.isSafeInteger(ms) || ms < 1 || ms > 600_000) artifactFailure("deadline_invalid");
    this.expires = Math.min(performance.now() + ms, parent?.expires ?? Infinity);
    this.wallExpires = Math.min(Date.now() + ms, parent?.wallExpires ?? Infinity);
    this.timer = setTimeout(() => this.controller.abort(), Math.max(1, this.expires - performance.now()));
    this.timer.unref();
    for (const inherited of [parent?.controller.signal, signal]) {
      if (!inherited) continue;
      const listener = () => this.controller.abort();
      if (inherited.aborted) listener();
      else { inherited.addEventListener("abort", listener, { once: true }); this.abortListeners.push({ signal: inherited, listener }); }
    }
  }
  check(): number {
    // A backward wall-clock adjustment cannot extend the monotonic cap. The
    // wall-clock cap also catches suspended hosts whose monotonic clock pauses.
    const left = Math.floor(Math.min(this.expires - performance.now(), this.wallExpires - Date.now()));
    if (left <= 0 || this.controller.signal.aborted) artifactFailure("operation_deadline");
    return left;
  }
  async bound<T>(promise: Promise<T>, cancel?: () => void, lateDispose?: (value: T) => Promise<unknown>): Promise<T> {
    let abandoned = false; let delivered = false; let disposed = false; let value: T;
    const disposeLate = () => {
      if (!abandoned || !delivered || disposed || !lateDispose) return;
      disposed = true;
      // Native fs.open cannot be cancelled. A late resource still has an owner,
      // including when the initial check fails after the promise was started.
      try { void lateDispose(value).catch(() => {}); } catch { /* content-free best-effort cleanup */ }
    };
    const settled = promise.then((result) => { value = result; delivered = true; disposeLate(); return result; });
    // Observe a rejected native operation even when no race is entered.
    void settled.catch(() => {});
    try { this.check(); } catch (error) { abandoned = true; cancel?.(); disposeLate(); throw error; }
    let listener: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      listener = () => { abandoned = true; cancel?.(); disposeLate(); reject(new MySqlBackupArtifactError("operation_deadline")); };
      this.controller.signal.addEventListener("abort", listener, { once: true });
    });
    try { const result = await Promise.race([settled, aborted]); this.check(); return result; }
    catch (error) { abandoned = true; disposeLate(); throw error; }
    finally { this.controller.signal.removeEventListener("abort", listener); }
  }
  dispose(): void {
    clearTimeout(this.timer);
    for (const { signal, listener } of this.abortListeners) signal.removeEventListener("abort", listener);
  }
}

type SqlRow = RowDataPacket & Record<string, unknown>;
interface DatabaseAddress { host: string; port: number; user: string; password: string; database: string }
interface DatabaseIdentity { identitySha256: string; serverUuid: string; serverVersion: string; database: string }
interface LockedDatabase { url: string; connection: Connection; identity: DatabaseIdentity; lockName: string }
interface OperatorState {
  directory: string; workDirectory: string; lockPath: string; lockHandle: FileHandle;
  deadline: Deadline; source: LockedDatabase; target?: LockedDatabase;
  closed: boolean; bindings: Map<string, RestoreOperationBinding>;
  tenantTelemetryRefKey?: Buffer;
}
interface RestoreOperationBinding {
  scope: "mysql-logical-full-artifact-restore-operation-v1";
  backupId: string; restoreRunId: string; runtimeEpochSha256: string;
  anchorSha256: string; sourceIdentitySha256: string; targetIdentitySha256: string;
  evidence: ArtifactEvidence;
}
interface VerifiedState { handle: FileHandle; workDirectory: string; consumed: boolean; closed: boolean }
const operators = new WeakMap<MySqlBackupArtifactOperator, OperatorState>();
const verifiedArtifacts = new WeakMap<VerifiedMySqlBackupArtifact, VerifiedState>();

function safety(options: { localOnlyAck: true; nodeEnv?: string; fleetStoppedAck?: true }, requireStopped = false): void {
  if (options.localOnlyAck !== true || options.nodeEnv === "production" || process.env.NODE_ENV === "production") {
    artifactFailure("local_only_required");
  }
  if (requireStopped && options.fleetStoppedAck !== true) artifactFailure("fleet_stopped_required");
}
function byteLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_073_741_824) artifactFailure("artifact_limit_invalid");
}
function copyRefKey(key: Uint8Array | undefined): Buffer | undefined {
  if (key === undefined) return;
  if (!(key instanceof Uint8Array) || key.length !== 32) artifactFailure("capture_ref_key_required");
  return Buffer.from(key);
}
function backupName(backupId: string): string {
  if (!/^backup_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(backupId)) artifactFailure("backup_id_invalid");
  return `${backupId}.asmbak`;
}
function cloneAnchor(anchor: TenantBackupSnapshotAnchor): TenantBackupSnapshotAnchor {
  try { return structuredClone(anchor); }
  catch { return artifactFailure("source_anchor_invalid"); }
}
function restoreName(runId: string): string {
  if (!/^restore_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(runId)) artifactFailure("restore_id_invalid");
  return runId;
}
function address(urlString: string): DatabaseAddress {
  try {
    const url = new URL(urlString);
    const database = decodeURIComponent(url.pathname.slice(1));
    const user = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    if (url.protocol !== "mysql:" || url.hash || url.search
      || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      || !/^[a-zA-Z0-9_]{1,64}$/.test(database)
      || ["mysql", "sys", "information_schema", "performance_schema"].includes(database.toLowerCase())
      || !user || /[\x00-\x1f\x7f]/.test(user + password)) artifactFailure("database_address_invalid");
    const port = url.port ? Number(url.port) : 3306;
    if (!Number.isInteger(port) || port < 1 || port > 65535) artifactFailure("database_address_invalid");
    return { host: url.hostname === "[::1]" ? "::1" : url.hostname, port, database, user, password };
  } catch { return artifactFailure("database_address_invalid"); }
}

async function privateDirectory(raw: string, deadline: Deadline): Promise<string> {
  if (!isAbsolute(raw) || resolve(raw) !== raw) artifactFailure("artifact_directory_invalid");
  deadline.check();
  // mkdir fulfillment proves this call created the leaf; EEXIST never reaches
  // the disposer. Only remove an empty newly-created leaf, never its contents.
  try { await deadline.bound(mkdir(raw, { mode: 0o700 }), undefined, async () => { await rmdir(raw).catch(() => {}); }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const resolved = await deadline.bound(realpath(raw));
  const info = await deadline.bound(stat(raw));
  if (resolved !== raw || !info.isDirectory() || (info.mode & 0o777) !== 0o700
    || (process.getuid && info.uid !== process.getuid())) artifactFailure("artifact_directory_unprotected");
  // Persist both the directory and its parent entry, including an operator-created
  // directory that has not previously crossed a durability barrier.
  await syncDirectory(resolved, deadline);
  await syncDirectory(dirname(resolved), deadline);
  return resolved;
}
async function privateFile(path: string, deadline: Deadline, maximumBytes: number): Promise<FileHandle> {
  // O_NONBLOCK prevents a protected-looking FIFO from blocking libuv before
  // fstat can reject it. Only regular, private, single-link files are accepted.
  const handle = await deadline.bound(open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
    undefined, async (late) => { await late.close(); });
  try {
    const info = await deadline.bound(handle.stat());
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.nlink !== 1
      || (process.getuid && info.uid !== process.getuid()) || info.size > maximumBytes) artifactFailure("artifact_file_unprotected");
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
async function syncDirectory(path: string, deadline: Deadline): Promise<void> {
  const handle = await deadline.bound(open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
    undefined, async (late) => { await late.close(); });
  try { await deadline.bound(handle.sync()); } finally { await handle.close(); }
}
async function discardCreatedFile(path: string, handle: FileHandle): Promise<void> {
  try {
    const held = await handle.stat().catch(() => undefined);
    const current = await lstat(path).catch(() => undefined);
    // A replacement pathname is never ours to remove, even under the same UID.
    if (held && current && held.ino === current.ino && held.dev === current.dev) await unlink(path).catch(() => {});
  } finally { await handle.close().catch(() => {}); }
}
async function createdFile(path: string, flags: "wx" | "wx+", deadline: Deadline): Promise<FileHandle> {
  return deadline.bound(open(path, flags, 0o600), undefined, async (late) => { await discardCreatedFile(path, late); });
}
async function workDirectory(prefix: string, deadline: Deadline): Promise<string> {
  // mkdtemp's returned path is a newly-created empty directory, not a caller
  // supplied/pre-existing path. Late cleanup is deliberately non-recursive.
  return deadline.bound(mkdtemp(prefix), undefined, async (late) => { await rmdir(late).catch(() => {}); });
}
async function unlinkedSpool(workDirectory: string, deadline: Deadline): Promise<FileHandle> {
  const path = join(workDirectory, `spool-${randomUUID()}`);
  const handle = await createdFile(path, "wx+", deadline);
  try { await deadline.bound(unlink(path)); return handle; }
  catch (error) { await discardCreatedFile(path, handle); throw error; }
}
// The FileHandle remains the sole FD owner. Non-owning streams must not retain a
// FileHandle close reference or wait for a close event they deliberately never emit.
function heldRead(handle: FileHandle, start = 0) {
  return createReadStream("", { fd: handle.fd, start, autoClose: false, emitClose: false });
}
function heldWrite(handle: FileHandle, start?: number) {
  return createWriteStream("", { fd: handle.fd, start, autoClose: false, emitClose: false });
}
async function keyBytes(path: string, deadline: Deadline): Promise<Buffer> {
  if (!isAbsolute(path) || resolve(path) !== path) artifactFailure("key_file_invalid");
  const handle = await privateFile(path, deadline, 32);
  try {
    const info = await handle.stat();
    if (info.size !== 32) artifactFailure("key_file_invalid");
    const bytes = Buffer.alloc(32);
    const read = await deadline.bound(handle.read(bytes, 0, 32, 0));
    if (read.bytesRead !== 32) { bytes.fill(0); artifactFailure("key_file_invalid"); }
    return bytes;
  } finally { await handle.close(); }
}

async function connect(url: string, deadline: Deadline): Promise<Connection> {
  const config = address(url);
  const pending = mysql.createConnection({ ...config, connectTimeout: Math.min(10_000, deadline.check()),
    enableKeepAlive: false, multipleStatements: false, supportBigNumbers: true, bigNumberStrings: true });
  let abandoned = false;
  try {
    // Do not destroy an idle named-lock session on a signal: a child import or
    // external catalog mutation may still be settling. The caller closes this
    // session only after its in-flight work has acknowledged cancellation.
    return await deadline.bound(pending, () => { abandoned = true; });
  } catch (error) {
    abandoned = true;
    void pending.then((connection) => { if (abandoned) connection.destroy(); }, () => {});
    if (error instanceof MySqlBackupArtifactError) throw error;
    return artifactFailure("database_unavailable");
  }
}
async function rows(connection: Connection, sql: string, values: unknown[], deadline: Deadline): Promise<SqlRow[]> {
  try {
    const [result] = await deadline.bound(connection.query<RowDataPacket[]>({ sql, timeout: deadline.check() }, values), () => connection.destroy());
    deadline.check();
    return result as SqlRow[];
  } catch (error) {
    if (error instanceof MySqlBackupArtifactError) throw error;
    return artifactFailure("database_query_failed");
  }
}
async function identify(connection: Connection, deadline: Deadline): Promise<DatabaseIdentity> {
  const result = await rows(connection, "SELECT @@server_uuid AS server_uuid, @@version AS version, DATABASE() AS database_name", [], deadline);
  const row = result[0];
  if (!row || typeof row.server_uuid !== "string" || !/^[0-9a-f-]{36}$/i.test(row.server_uuid)
    || typeof row.version !== "string" || !/^8\.\d+\.\d+[a-zA-Z0-9.+_-]*$/.test(row.version)
    || typeof row.database_name !== "string" || !/^[a-zA-Z0-9_]{1,64}$/.test(row.database_name)) artifactFailure("server_version_invalid");
  return { identitySha256: sha256(canonicalJson({ scope: "mysql-physical-database-identity-v1",
    serverUuid: row.server_uuid.toLowerCase(), database: row.database_name })), serverUuid: row.server_uuid.toLowerCase(),
  serverVersion: row.version, database: row.database_name };
}
async function assertLock(database: LockedDatabase, deadline: Deadline): Promise<void> {
  const result = await rows(database.connection, "SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS owned", [database.lockName], deadline);
  if (Number(result[0]?.owned) !== 1) artifactFailure("operator_lock_lost");
}
async function assertEmpty(database: LockedDatabase, deadline: Deadline): Promise<void> {
  const result = await rows(database.connection,
    `SELECT (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=?)
      + (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=?)
      + (SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA=?) AS object_count`,
    [database.identity.database, database.identity.database, database.identity.database], deadline);
  if (Number(result[0]?.object_count) !== 0) artifactFailure("target_not_empty");
}
function operatorState(operator: MySqlBackupArtifactOperator): OperatorState {
  const state = operators.get(operator);
  if (!state || state.closed) return artifactFailure("operator_invalid");
  state.deadline.check();
  return state;
}
async function createOnlyJson(path: string, value: unknown, state: OperatorState): Promise<void> {
  const bytes = Buffer.from(canonicalJson(value));
  const temporary = join(state.workDirectory, `journal-${randomUUID()}`);
  const handle = await createdFile(temporary, "wx", state.deadline);
  try { await state.deadline.bound(handle.writeFile(bytes)); await state.deadline.bound(handle.sync()); }
  finally { await handle.close(); }
  try {
    await state.deadline.bound(link(temporary, path));
    await state.deadline.bound(unlink(temporary));
    await syncDirectory(state.directory, state.deadline);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await privateFile(path, state.deadline, 8192);
    try {
      if (!(await state.deadline.bound(existing.readFile())).equals(bytes)) artifactFailure("restore_operation_conflict");
    } finally { await existing.close(); }
  }
}
async function journalStage(state: OperatorState, binding: RestoreOperationBinding, stage: string): Promise<void> {
  await assertLock(state.source, state.deadline);
  if (!state.target) artifactFailure("operator_invalid");
  await assertLock(state.target, state.deadline);
  await createOnlyJson(join(state.directory, `${restoreName(binding.restoreRunId)}.${stage}.json`),
    { ...binding, phase: stage }, state);
}
async function safeRestoreOperation(action: () => Promise<void>): Promise<void> {
  try { await action(); }
  catch (error) {
    if (error instanceof MySqlBackupArtifactError) throw error;
    artifactFailure("restore_operation_unavailable");
  }
}

/** Exclusive cooperating-operator locks. A crash-left filesystem lock is deliberately not stolen. */
export async function acquireMySqlBackupArtifactOperator(options: MySqlBackupArtifactOperatorOptions): Promise<MySqlBackupArtifactOperator> {
  options = { ...options };
  safety(options, true);
  const refKey = copyRefKey(options.tenantTelemetryRefKey);
  let deadline: Deadline;
  try { deadline = new Deadline(options.deadlineMs, undefined, options.operationAbortSignal); }
  catch (error) { refKey?.fill(0); throw error; }
  let operationDirectory: string | undefined;
  let lockHandle: FileHandle | undefined;
  let lockPath: string | undefined;
  const databases: LockedDatabase[] = [];
  try {
    address(options.sourceUrl);
    if (options.targetUrl) address(options.targetUrl);
    const directory = await privateDirectory(options.artifactDirectory, deadline);
    lockPath = join(directory, ".mysql-backup-artifact.operator.lock");
    try { lockHandle = await createdFile(lockPath, "wx+", deadline); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") artifactFailure("operator_busy"); throw error; }
    await deadline.bound(lockHandle.writeFile("mysql-backup-artifact-operator-v1\n"));
    await deadline.bound(lockHandle.sync());
    await syncDirectory(directory, deadline);
    operationDirectory = await workDirectory(join(directory, ".operator-"), deadline);
    for (const url of [options.sourceUrl, ...(options.targetUrl ? [options.targetUrl] : [])]) {
      const connection = await connect(url, deadline);
      try {
        const identity = await identify(connection, deadline);
        databases.push({ url, connection, identity, lockName: `as.mysql-backup-v1:${identity.identitySha256.slice(0, 40)}` });
      } catch (error) { connection.destroy(); throw error; }
    }
    const source = databases[0]!;
    const target = databases[1];
    if (target && target.identity.identitySha256 === source.identity.identitySha256) artifactFailure("target_is_source");
    for (const database of [...databases].sort((a, b) => a.lockName.localeCompare(b.lockName))) {
      const result = await rows(database.connection, "SELECT GET_LOCK(?, 0) AS acquired", [database.lockName], deadline);
      if (Number(result[0]?.acquired) !== 1) artifactFailure("operator_busy");
    }
    if (target) await assertEmpty(target, deadline);
    const state: OperatorState = { directory, workDirectory: operationDirectory, lockPath, lockHandle, deadline, source, target,
      closed: false, bindings: new Map(), tenantTelemetryRefKey: refKey };
    const operator: MySqlBackupArtifactOperator = Object.freeze({
      sourceIdentitySha256: source.identity.identitySha256,
      targetIdentitySha256: target?.identity.identitySha256,
      async assertHeld(): Promise<void> {
        operatorState(operator);
        for (const database of databases) {
          await assertLock(database, deadline);
          if ((await identify(database.connection, deadline)).identitySha256 !== database.identity.identitySha256) {
            artifactFailure("operator_identity_mismatch");
          }
        }
      },
      async bindRestoreOperation(input: { manifest: MySqlBackupArtifactManifest; evidence: ArtifactEvidence; restoreRunId: string; runtimeEpochSha256: string }): Promise<void> {
        return safeRestoreOperation(async () => {
          input = structuredClone(input);
          operatorState(operator);
          if (!state.target || !/^[0-9a-f]{64}$/.test(input.runtimeEpochSha256)) artifactFailure("restore_operation_invalid");
          restoreName(input.restoreRunId);
          encodeArtifactManifest(input.manifest, 1_073_741_824, state.tenantTelemetryRefKey);
          assertArtifactEvidence(artifactEvidence(input.manifest, input.evidence.sourceBackupSha256), input.evidence);
          if (input.manifest.sourceIdentitySha256 !== state.source.identity.identitySha256) artifactFailure("source_identity_mismatch");
          // This verify-only native path cannot upgrade an old dump between
          // import and target prepare. Reject an unsupported historical schema
          // against the ACTUAL locked source before planned journal, external
          // epoch reservation or import. Envelope compatibility is separate.
          await inspectSource(state.source, input.manifest.anchor, deadline);
          await assertEmpty(state.target, deadline);
          const binding: RestoreOperationBinding = { scope: "mysql-logical-full-artifact-restore-operation-v1",
            backupId: input.manifest.backupId, restoreRunId: input.restoreRunId, runtimeEpochSha256: input.runtimeEpochSha256,
            anchorSha256: input.manifest.anchor.anchorSha256, sourceIdentitySha256: state.source.identity.identitySha256,
            targetIdentitySha256: state.target.identity.identitySha256, evidence: structuredClone(input.evidence) };
          await journalStage(state, binding, "planned");
          state.bindings.set(input.restoreRunId, binding);
        });
      },
      async markRestorePrepared(restoreRunId: string): Promise<void> {
        return safeRestoreOperation(async () => {
          operatorState(operator);
          const binding = state.bindings.get(restoreRunId);
          if (!binding) artifactFailure("restore_operation_invalid");
          // This stage cannot precede the durable successful-import stage.
          const file = await privateFile(join(directory, `${restoreName(restoreRunId)}.import_completed.json`), deadline, 8192);
          try {
            if ((await deadline.bound(file.readFile())).toString() !== canonicalJson({ ...binding, phase: "import_completed" })) artifactFailure("restore_operation_conflict");
          } finally { await file.close(); }
          await journalStage(state, binding, "target_prepared");
        });
      },
      async close(): Promise<void> {
        if (state.closed) return;
        state.closed = true;
        state.tenantTelemetryRefKey?.fill(0);
        deadline.dispose();
        for (const database of databases) database.connection.destroy();
        await discardCreatedFile(lockPath!, lockHandle!);
        try { await rm(operationDirectory!, { recursive: true, force: true }); }
        catch { artifactFailure("operator_cleanup_failed"); }
      },
    });
    operators.set(operator, state);
    return operator;
  } catch (error) {
    refKey?.fill(0);
    for (const database of databases) database.connection.destroy();
    deadline.dispose();
    if (lockHandle && lockPath) await discardCreatedFile(lockPath, lockHandle);
    if (operationDirectory) await rm(operationDirectory, { recursive: true, force: true }).catch(() => {});
    if (error instanceof MySqlBackupArtifactError) throw error;
    return artifactFailure("operator_unavailable");
  }
}

function anchorFromRow(row: SqlRow): TenantBackupSnapshotAnchor {
  const n = (key: string) => Number(row[key]);
  const s = (key: string) => String(row[key]);
  const heads = row.source_runtime_head_catalog_json;
  const anchor: TenantBackupSnapshotAnchor = {
    scope: s("scope") as TenantBackupSnapshotAnchor["scope"], protocol: s("protocol") as TenantBackupSnapshotAnchor["protocol"],
    backupKind: s("backup_kind") as "full", backupId: s("backup_id"), controlEvidenceSha256: s("control_evidence_sha256"),
    logicalDatabaseNamespaceSha256: s("logical_database_namespace_sha256"), journalControlEvidenceSha256: s("journal_control_evidence_sha256"),
    sourceRuntimeEpochSha256: s("source_runtime_epoch_sha256"), sourceRuntimeControlGeneration: n("source_runtime_control_generation"),
    sourceRuntimeControlEvidenceSha256: s("source_runtime_control_evidence_sha256"), sourceRuntimeTargetCount: n("source_runtime_target_count"),
    sourceRuntimeHeads: (typeof heads === "string" ? JSON.parse(heads) : heads) as TenantBackupSnapshotAnchor["sourceRuntimeHeads"],
    sourceRuntimeHeadRootSha256: s("source_runtime_head_root_sha256"), schemaMigrationRootSha256: s("schema_migration_root_sha256"),
    blobStorageControlEvidenceSha256: s("blob_storage_control_evidence_sha256"), sourceCatalogSequence: n("source_catalog_sequence"),
    sourceCatalogEventRootSha256: s("source_catalog_event_root_sha256"), retentionUntilDbMs: n("retention_until_db_ms"),
    createdAtDbMs: n("created_at_db_ms"), anchorSha256: s("anchor_sha256"),
  };
  try { validateTenantBackupSnapshotAnchor(anchor); } catch { artifactFailure("source_anchor_invalid"); }
  return anchor;
}
function sqlIdentifier(name: unknown): string {
  if (typeof name !== "string" || !/^[a-zA-Z0-9_]{1,64}$/.test(name)) artifactFailure("source_schema_invalid");
  return `\`${name}\``;
}
function sourceQualifiedSql(sql: string, database: string): boolean {
  // The supported database identifier grammar has no regexp metacharacters.
  // Include whitespace and ANSI quoting, not only `source`.`table`.
  return new RegExp(`(?:\\\`${database}\\\`|"${database}"|\\b${database}\\b)\\s*\\.`, "i").test(sql);
}
async function inspectSource(database: LockedDatabase, anchor: TenantBackupSnapshotAnchor, deadline: Deadline): Promise<{ identity: DatabaseIdentity; schemaSha256: string }> {
  await assertLock(database, deadline);
  const identity = await identify(database.connection, deadline);
  if (identity.identitySha256 !== database.identity.identitySha256) artifactFailure("source_identity_mismatch");
  const migrationRows = await rows(database.connection, "SELECT name FROM schema_migrations ORDER BY BINARY name", [], deadline);
  const migrationRoot = tenantBackupSchemaMigrationRootSha256(migrationRows.map((row) => String(row.name)));
  if (migrationRoot !== anchor.schemaMigrationRootSha256) artifactFailure("source_migration_mismatch");
  const anchors = await rows(database.connection, "SELECT * FROM backup_snapshot_anchors WHERE backup_id=?", [anchor.backupId], deadline);
  if (anchors.length !== 1 || canonicalJson(anchorFromRow(anchors[0]!)) !== canonicalJson(anchor)) artifactFailure("source_anchor_mismatch");
  const objects = await rows(database.connection,
    "SELECT TABLE_NAME AS name, TABLE_TYPE AS kind, ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ORDER BY BINARY TABLE_NAME LIMIT 2049",
    [identity.database], deadline);
  if (!objects.length || objects.length > 2048 || objects.some((row) => row.kind === "BASE TABLE" && row.engine !== "InnoDB")) artifactFailure("source_schema_invalid");
  if (objects.some((row) => row.kind === "VIEW")) artifactFailure("source_views_unsupported");
  const schema: unknown[] = [];
  let metadataBytes = 0;
  const add = (kind: string, name: unknown, sql: unknown) => {
    if (typeof sql !== "string" || sourceQualifiedSql(sql, identity.database)) artifactFailure("source_schema_nonportable");
    metadataBytes += Buffer.byteLength(sql);
    if (metadataBytes > 16 * 1024 * 1024) artifactFailure("source_schema_limit");
    schema.push({ kind, name, sql: kind === "BASE TABLE" ? canonicalMySqlBackupTableDefinition(sql) : sql });
  };
  for (const object of objects) {
    if (object.kind !== "BASE TABLE") artifactFailure("source_schema_invalid");
    const definition = await rows(database.connection, `SHOW CREATE TABLE ${sqlIdentifier(object.name)}`, [], deadline);
    add("BASE TABLE", object.name, definition[0]?.["Create Table"]);
  }
  const triggerSizes = await rows(database.connection,
    "SELECT TRIGGER_NAME AS name, OCTET_LENGTH(ACTION_STATEMENT) AS body_bytes FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=? ORDER BY BINARY TRIGGER_NAME LIMIT 2049",
    [identity.database], deadline);
  if (triggerSizes.length > 2048) artifactFailure("source_schema_limit");
  const expectedTriggers: Array<{ name: string; body_bytes: number }> = [];
  const seenTriggerNames = new Set<string>();
  let expectedBodyBytes = 0;
  for (const triggerSize of triggerSizes) {
    const name = triggerSize.name;
    if (typeof name !== "string" || name.length === 0 || Array.from(name).length > 64
      || /[\p{Cc}\p{Cs}]/u.test(name) || seenTriggerNames.has(name)) artifactFailure("source_schema_invalid");
    seenTriggerNames.add(name);
    const rawBytes = triggerSize.body_bytes;
    const bodyBytes = typeof rawBytes === "number" || (typeof rawBytes === "string" && /^(0|[1-9][0-9]*)$/.test(rawBytes))
      ? Number(rawBytes) : NaN;
    if (!Number.isSafeInteger(bodyBytes) || bodyBytes < 0
      || bodyBytes > 16 * 1024 * 1024 - metadataBytes - expectedBodyBytes) artifactFailure("source_schema_limit");
    expectedBodyBytes += bodyBytes;
    expectedTriggers.push({ name, body_bytes: bodyBytes });
  }
  const descriptors = expectedTriggers.length === 0 ? [] : await rows(database.connection,
    `SELECT t.TRIGGER_NAME AS name, t.ACTION_STATEMENT AS body, t.EVENT_MANIPULATION AS event,
            t.ACTION_TIMING AS timing, t.EVENT_OBJECT_TABLE AS table_name, t.ACTION_ORDER AS action_order,
            t.SQL_MODE AS sql_mode, t.DEFINER AS definer, t.CHARACTER_SET_CLIENT AS charset,
            t.COLLATION_CONNECTION AS collation, t.DATABASE_COLLATION AS database_collation
       FROM JSON_TABLE(?, '$[*]' COLUMNS (
         ordinal FOR ORDINALITY,
         expected_name VARCHAR(64) PATH '$.name',
         expected_body_bytes BIGINT UNSIGNED PATH '$.body_bytes'
       )) AS wanted
       JOIN information_schema.TRIGGERS AS t
         ON t.TRIGGER_SCHEMA=? AND BINARY t.TRIGGER_NAME=BINARY wanted.expected_name
        AND OCTET_LENGTH(t.ACTION_STATEMENT)=wanted.expected_body_bytes
      ORDER BY wanted.ordinal LIMIT 2049`,
    [JSON.stringify(expectedTriggers), identity.database], deadline);
  if (descriptors.length !== expectedTriggers.length) artifactFailure("source_changed");
  for (const [index, descriptor] of descriptors.entries()) {
    if (descriptor.name !== expectedTriggers[index]!.name || typeof descriptor.body !== "string"
      || Buffer.byteLength(descriptor.body) !== expectedTriggers[index]!.body_bytes) artifactFailure("source_changed");
    const trigger = { ...descriptor };
    if (sourceQualifiedSql(String(trigger.body), identity.database)) artifactFailure("source_schema_nonportable");
    metadataBytes += Buffer.byteLength(canonicalJson(trigger));
    if (metadataBytes > 16 * 1024 * 1024) artifactFailure("source_schema_limit");
    schema.push({ kind: "TRIGGER", ...trigger });
  }
  const routines = await rows(database.connection,
    "SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS kind FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=? ORDER BY BINARY ROUTINE_NAME, ROUTINE_TYPE LIMIT 2049",
    [identity.database], deadline);
  const events = await rows(database.connection,
    "SELECT EVENT_NAME AS name FROM information_schema.EVENTS WHERE EVENT_SCHEMA=? ORDER BY BINARY EVENT_NAME LIMIT 2049", [identity.database], deadline);
  if (routines.length + events.length > 2048) artifactFailure("source_schema_limit");
  // An ENABLED event can run during import before erasure replay/runtime activation.
  // This application currently defines no events; reject all rather than modifying
  // global event_scheduler or silently dropping executable objects from a full dump.
  if (events.length !== 0) artifactFailure("source_events_unsupported");
  if (routines.length !== 0) artifactFailure("source_routines_unsupported");
  if (metadataBytes > 16 * 1024 * 1024) artifactFailure("source_schema_limit");
  return { identity, schemaSha256: sha256(canonicalJson({ scope: MYSQL_BACKUP_ARTIFACT_SCHEMA_SCOPE, schema })) };
}

/** v1 means verified inactive on this actual source, never merely no checkpoint. */
async function assertActualInactiveCapture(database: LockedDatabase, deadline: Deadline): Promise<void> {
  const controls = await rows(database.connection, `SELECT domain,scope,control_generation,state,capture_protocol,
    producer_protocol,producer_contract_sha256,activated_at_db_ms FROM tenant_telemetry_capture_v2_controls ORDER BY BINARY domain`, [], deadline);
  if (controls.length !== 2 || controls[0]?.domain !== "logs" || controls[1]?.domain !== "traces"
    || controls.some((control) => control.scope !== "tenant-telemetry-capture-control-v2" || control.state !== "inactive"
      || (control.control_generation !== 0 && control.control_generation !== "0") || control.activated_at_db_ms !== null
      || control.capture_protocol !== PERSISTED_PROVIDER_CAPTURE_PROTOCOL)
    || controls[0]!.producer_protocol !== PERSISTED_PROVIDER_CAPTURE_PRODUCER_PROTOCOL
    || controls[0]!.producer_contract_sha256 !== PERSISTED_PROVIDER_CAPTURE_CONTRACT_SHA256
    || controls[1]!.producer_protocol !== null || controls[1]!.producer_contract_sha256 !== null) artifactFailure("capture_inactive_source_invalid");
  // An active legacy v1 application producer remains legal here. Only v2
  // footprints/private gen1 and retained/checkpoint authority forbid v1 backup.
  const zeroTables = ["tenant_telemetry_capture_v2_activation_receipts", "tenant_telemetry_capture_v2_coverages",
    "tenant_telemetry_capture_v2_source_bindings", "tenant_telemetry_capture_v2_failure_commit_receipts",
    ...TENANT_TELEMETRY_CAPTURE_CHECKPOINT_SQL.filter((projection) => projection.family.startsWith("retained_")).flatMap((projection) => projection.tables),
    "tenant_telemetry_capture_backup_checkpoints", "tenant_telemetry_capture_backup_checkpoint_leaves",
    "tenant_telemetry_capture_restore_bindings", "tenant_telemetry_capture_restore_history_receipts",
    "tenant_telemetry_capture_epoch_cutovers", "tenant_telemetry_capture_recovery_permits",
    "tenant_telemetry_capture_checkpoint_lineage_leaves", "tenant_telemetry_capture_recovery_permits_v2"];
  const predicates = zeroTables.map((table) => `SELECT COUNT(*) FROM ${sqlIdentifier(table)}`);
  predicates.push("SELECT COUNT(*) FROM tenant_telemetry_artifact_inventory WHERE source_schema='provider-step-error-v2'",
    "SELECT COUNT(*) FROM tenant_telemetry_write_jobs WHERE JSON_UNQUOTE(JSON_EXTRACT(inventory_json,'$.sourceSchema'))='provider-step-error-v2'",
    "SELECT COUNT(*) FROM subject_lifecycle WHERE telemetry_logs_capture_v2_generation<>0");
  for (const table of ["items", "events"]) predicates.push(`SELECT COUNT(*) FROM ${table} WHERE
    (telemetry_capture_v2_control_generation IS NOT NULL AND telemetry_capture_v2_control_generation<>0)
    OR telemetry_capture_v2_operation_sha256 IS NOT NULL OR telemetry_capture_v2_session_ref_sha256 IS NOT NULL
    OR telemetry_capture_v2_turn_ref_sha256 IS NOT NULL OR telemetry_capture_v2_item_ref_sha256 IS NOT NULL
    OR telemetry_capture_v2_failure_receipt_sha256 IS NOT NULL OR telemetry_capture_v2_business_batch_sha256 IS NOT NULL
    OR (telemetry_failure_classification IS NOT NULL AND (telemetry_failure_classification<>'runtime_unknown'
      OR telemetry_capture_v2_control_generation IS NULL))`);
  const names = predicates.map((_predicate, index) => `capture_inactive_footprint_${index}`);
  const footprint = await rows(database.connection, `SELECT ${predicates.map((predicate, index) => `(${predicate}) AS ${names[index]}`).join(",")}`, [], deadline);
  if (footprint.length !== 1 || Object.keys(footprint[0]!).sort().join("\0") !== [...names].sort().join("\0")
    || names.some((name) => footprint[0]![name] !== 0 && footprint[0]![name] !== "0")) artifactFailure("capture_inactive_source_invalid");
}

async function assertActualHistoricalCheckpoint(database: LockedDatabase, checkpoint: TenantTelemetryCaptureBackupCheckpoint,
  refKey: Uint8Array | undefined, deadline: Deadline): Promise<void> {
  if (!(refKey instanceof Uint8Array) || refKey.length !== 32) artifactFailure("capture_ref_key_required");
  const actual = await deadline.bound(readTenantTelemetryCaptureCheckpointFromMysql(database.connection, checkpoint.backupId, refKey),
    () => database.connection.destroy());
  if (!actual || canonicalJson(actual.checkpoint) !== canonicalJson(checkpoint)) artifactFailure("capture_checkpoint_source_mismatch");
  if (checkpoint.scope === TENANT_TELEMETRY_CAPTURE_CHECKPOINT_V2_SCOPE) {
    if (!actual.lineageLeaves) artifactFailure("capture_checkpoint_source_mismatch");
    try { assertTenantTelemetryCaptureLineageLeaves(checkpoint.lineage, actual.lineageLeaves, refKey); }
    catch { artifactFailure("capture_checkpoint_source_mismatch"); }
  } else if (actual.lineageLeaves !== undefined) artifactFailure("capture_checkpoint_source_mismatch");
}

function counted(maximum: number): { stream: Transform; result(): { bytes: number; sha256: string } } {
  let bytes = 0;
  const hash = createHash("sha256");
  const stream = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > maximum) { callback(new MySqlBackupArtifactError("artifact_limit")); return; }
    hash.update(chunk); callback(null, chunk);
  } });
  return { stream, result: () => ({ bytes, sha256: hash.digest("hex") }) };
}
async function toolPath(raw: string, deadline: Deadline): Promise<string> {
  if (!isAbsolute(raw) || raw.includes("\0")) artifactFailure("tool_path_invalid");
  const path = await deadline.bound(realpath(raw));
  const info = await deadline.bound(stat(path));
  if (!info.isFile() || !(info.mode & 0o111) || (info.mode & 0o022)) artifactFailure("tool_path_invalid");
  return path;
}
async function runTool(path: string, args: string[], workDirectory: string, deadline: Deadline,
  output?: FileHandle, input?: FileHandle): Promise<string> {
  deadline.check();
  const child = spawn(path, args, { shell: false, cwd: workDirectory,
    env: { LANG: "C", LC_ALL: "C", MYSQL_TEST_LOGIN_FILE: join(workDirectory, "no-login-file") },
    stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
  // Neither a raw process error nor stderr/argv is exposed to callers or logs.
  child.stderr!.on("data", () => {});
  let version = Buffer.alloc(0);
  if (!output) child.stdout!.on("data", (chunk: Buffer) => {
    if (version.length + chunk.length > 4096) child.kill("SIGKILL");
    else version = Buffer.concat([version, chunk]);
  });
  const completion = new Promise<void>((resolveExit, reject) => {
    child.once("error", () => reject(new MySqlBackupArtifactError("tool_unavailable")));
    child.once("close", (code) => code === 0 ? resolveExit() : reject(new MySqlBackupArtifactError("tool_failed")));
  });
  const abort = () => child.kill("SIGKILL");
  deadline.controller.signal.addEventListener("abort", abort, { once: true });
  const streams: Promise<void>[] = [];
  if (output) streams.push(pipeline(child.stdout!, heldWrite(output), { signal: deadline.controller.signal }));
  if (input) streams.push(pipeline(heldRead(input), child.stdin!, { signal: deadline.controller.signal }));
  try {
    await deadline.bound(Promise.all([completion, ...streams]), abort);
    deadline.check();
    return version.toString("utf8").trim();
  } catch (error) {
    child.kill("SIGKILL");
    await Promise.allSettled([completion, ...streams]);
    if (error instanceof MySqlBackupArtifactError) throw error;
    return artifactFailure(deadline.controller.signal.aborted ? "operation_deadline" : "tool_failed");
  } finally { deadline.controller.signal.removeEventListener("abort", abort); }
}
async function toolVersion(path: string, workDirectory: string, deadline: Deadline): Promise<string> {
  const version = await runTool(path, ["--no-defaults", "--version"], workDirectory, deadline);
  if (!/^[\x20-\x7e]{1,512}$/.test(version) || !/\b(?:Ver|Distrib) 8\.\d+\.\d+\b/.test(version)
    || /mariadb/i.test(version)) artifactFailure("tool_version_invalid");
  return version;
}
async function defaultsFile(url: string, workDirectory: string, deadline: Deadline): Promise<string> {
  const config = address(url);
  const escape = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  const path = join(workDirectory, `client-${randomUUID()}.cnf`);
  const handle = await createdFile(path, "wx", deadline);
  try {
    await deadline.bound(handle.writeFile(`[client]\nhost=${escape(config.host)}\nport=${config.port}\nuser=${escape(config.user)}\npassword=${escape(config.password)}\nprotocol=TCP\n`));
    await deadline.bound(handle.sync());
  } finally { await handle.close(); }
  return path;
}
async function hashFile(handle: FileHandle, maximum: number, deadline: Deadline): Promise<{ bytes: number; sha256: string }> {
  const counter = counted(maximum);
  const sink = new Transform({ transform(_chunk, _encoding, callback) { callback(); } });
  await pipeline(heldRead(handle), counter.stream, sink, { signal: deadline.controller.signal });
  deadline.check();
  return counter.result();
}
function frozen<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}

export async function verifyMySqlBackupArtifact(options: VerifyMySqlBackupArtifactOptions): Promise<VerifiedMySqlBackupArtifact> {
  options = { ...options, expectedAnchor: options.expectedAnchor && cloneAnchor(options.expectedAnchor),
    expectedEvidence: options.expectedEvidence && { ...options.expectedEvidence } };
  safety(options); byteLimit(options.maxBytes); backupName(options.backupId);
  const refKey = copyRefKey(options.tenantTelemetryRefKey);
  let deadline: Deadline;
  try { deadline = new Deadline(options.deadlineMs, undefined, options.operationAbortSignal); }
  catch (error) { refKey?.fill(0); throw error; }
  let verificationDirectory: string | undefined;
  let artifact: FileHandle | undefined;
  let spool: FileHandle | undefined;
  let key: Buffer | undefined;
  try {
    const directory = await privateDirectory(options.artifactDirectory, deadline);
    artifact = await privateFile(join(directory, backupName(options.backupId)), deadline,
      options.maxBytes + MAX_MANIFEST_LIMIT + 12);
    const header = Buffer.alloc(12);
    if ((await deadline.bound(artifact.read(header, 0, 12, 0))).bytesRead !== 12
      || (!header.subarray(0, 8).equals(MYSQL_BACKUP_ARTIFACT_MAGIC)
        && !header.subarray(0, 8).equals(MYSQL_BACKUP_ARTIFACT_V2_MAGIC)
        && !header.subarray(0, 8).equals(MYSQL_BACKUP_ARTIFACT_V3_MAGIC))) artifactFailure("artifact_format_invalid");
    const version = header.subarray(0, 8).equals(MYSQL_BACKUP_ARTIFACT_V3_MAGIC) ? 3
      : header.subarray(0, 8).equals(MYSQL_BACKUP_ARTIFACT_V2_MAGIC) ? 2 : 1;
    const length = header.readUInt32BE(8);
    if (length < 1 || length > (version === 3 ? MYSQL_BACKUP_ARTIFACT_V3_MANIFEST_LIMIT
      : version === 2 ? MYSQL_BACKUP_ARTIFACT_V2_MANIFEST_LIMIT : MYSQL_BACKUP_ARTIFACT_MANIFEST_LIMIT)) artifactFailure("manifest_limit");
    const bytes = Buffer.alloc(length);
    if ((await deadline.bound(artifact.read(bytes, 0, length, 12))).bytesRead !== length) artifactFailure("artifact_format_invalid");
    const manifest = decodeArtifactManifest(bytes, options.maxBytes, refKey);
    if (manifest.version !== version) artifactFailure("artifact_format_invalid");
    if (manifest.backupId !== options.backupId) artifactFailure("backup_id_mismatch");
    if (options.expectedAnchor && canonicalJson(manifest.anchor) !== canonicalJson(options.expectedAnchor)) artifactFailure("anchor_mismatch");
    const info = await artifact.stat();
    if (info.size !== 12 + length + manifest.ciphertextBytes) artifactFailure("artifact_length_mismatch");
    verificationDirectory = await workDirectory(join(directory, ".verify-"), deadline);
    spool = await unlinkedSpool(verificationDirectory, deadline);
    key = await keyBytes(options.keyFile, deadline);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(manifest.encryption.nonceHex, "hex"));
    decipher.setAAD(artifactAad(manifest));
    decipher.setAuthTag(Buffer.from(manifest.encryption.authTagHex, "hex"));
    const ciphertext = counted(options.maxBytes);
    // Commit to exactly the bytes consumed by GCM, never a second pathname/FD read that
    // could observe a same-inode replacement after authentication.
    const wholeArtifact = createHash("sha256").update(header).update(bytes);
    const artifactHasher = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      wholeArtifact.update(chunk); callback(null, chunk);
    } });
    const plaintext = counted(options.maxBytes);
    try {
      await pipeline(heldRead(artifact, 12 + length), artifactHasher, ciphertext.stream, decipher,
        plaintext.stream, heldWrite(spool), { signal: deadline.controller.signal });
    } catch (error) {
      if (error instanceof MySqlBackupArtifactError) throw error;
      artifactFailure(deadline.controller.signal.aborted ? "operation_deadline" : "authentication_failed");
    }
    const encryptedDigest = ciphertext.result(); const plainDigest = plaintext.result();
    if (encryptedDigest.bytes !== manifest.ciphertextBytes || encryptedDigest.sha256 !== manifest.ciphertextSha256
      || plainDigest.bytes !== manifest.plaintextBytes || plainDigest.sha256 !== manifest.plaintextSha256) artifactFailure("artifact_digest_mismatch");
    await deadline.bound(spool.sync());
    const evidence = artifactEvidence(manifest, wholeArtifact.digest("hex"));
    if (options.expectedEvidence) assertArtifactEvidence(evidence, options.expectedEvidence);
    const state: VerifiedState = { handle: spool, workDirectory: verificationDirectory, consumed: false, closed: false };
    const verified: VerifiedMySqlBackupArtifact = Object.freeze({ manifest: frozen(manifest), evidence: frozen(evidence), async close(): Promise<void> {
      if (state.closed) return; state.closed = true;
      await state.handle.close().catch(() => {});
      // The only plaintext file was unlinked before use and is now closed.
      // A failure to remove the empty staging directory cannot override an
      // authentication/import error with a native locator-bearing exception.
      await rm(state.workDirectory, { recursive: true, force: true }).catch(() => {});
    } });
    verifiedArtifacts.set(verified, state);
    spool = undefined; verificationDirectory = undefined;
    return verified;
  } catch (error) {
    if (error instanceof MySqlBackupArtifactError) throw error;
    return artifactFailure("artifact_unavailable");
  } finally {
    deadline.dispose(); key?.fill(0); refKey?.fill(0);
    await artifact?.close().catch(() => {}); await spool?.close().catch(() => {});
    if (verificationDirectory) await rm(verificationDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

export async function createMySqlBackupArtifact(options: CreateMySqlBackupArtifactOptions): Promise<{
  disposition: "created" | "exact_replay"; manifest: MySqlBackupArtifactManifest; evidence: ArtifactEvidence;
}> {
  options = { ...options, anchor: cloneAnchor(options.anchor), tools: { ...options.tools } };
  safety(options, true); byteLimit(options.maxBytes);
  try { validateTenantBackupSnapshotAnchor(options.anchor); } catch { artifactFailure("source_anchor_invalid"); }
  backupName(options.anchor.backupId);
  if (!options.captureCheckpointStore || typeof options.captureCheckpointStore.sealTenantTelemetryCaptureBackupCheckpoint !== "function"
    || typeof options.captureCheckpointStore.assertTenantTelemetryCaptureBackupCheckpointUnchanged !== "function") artifactFailure("capture_checkpoint_store_required");
  const refKey = copyRefKey(options.tenantTelemetryRefKey);
  options = { ...options, ...(refKey === undefined ? {} : { tenantTelemetryRefKey: refKey }) };
  const ownedOperator = options.operator === undefined;
  let operator: MySqlBackupArtifactOperator;
  try { operator = options.operator ?? await acquireMySqlBackupArtifactOperator(options); }
  catch (error) { refKey?.fill(0); throw error; }
  let state: OperatorState; let deadline: Deadline;
  try {
    state = operatorState(operator);
    deadline = new Deadline(options.deadlineMs, state.deadline, options.operationAbortSignal);
  } catch (error) { refKey?.fill(0); if (ownedOperator) await operator.close(); throw error; }
  let key: Buffer | undefined; let plain: FileHandle | undefined; let encrypted: FileHandle | undefined;
  let packed: FileHandle | undefined; let temporary: string | undefined; let credentials: string | undefined;
  try {
    if (state.source.url !== options.sourceUrl || state.directory !== options.artifactDirectory) artifactFailure("operator_invalid");
    const before = await inspectSource(state.source, options.anchor, deadline);
    const destination = join(state.directory, backupName(options.anchor.backupId));
    try {
      const existing = await privateFile(destination, deadline, options.maxBytes + MAX_MANIFEST_LIMIT + 12);
      await existing.close();
      const verified = await verifyMySqlBackupArtifact({ ...options, backupId: options.anchor.backupId,
        expectedAnchor: options.anchor, deadlineMs: deadline.check() });
      try {
        if (verified.manifest.sourceIdentitySha256 !== before.identity.identitySha256
          || verified.manifest.schemaSha256 !== before.schemaSha256) artifactFailure("source_identity_mismatch");
        // This operation creates no new dump. Catalog/source rows may have
        // legitimately advanced since publication; authenticate immutable
        // history instead of trying to reseal today's source as the old dump.
        if (verified.manifest.version !== 1) await assertActualHistoricalCheckpoint(state.source,
          verified.manifest.captureCheckpoint, refKey, deadline);
        if (canonicalJson(await inspectSource(state.source, options.anchor, deadline)) !== canonicalJson(before)) artifactFailure("source_changed");
        await operator.assertHeld();
        return { disposition: "exact_replay", manifest: verified.manifest, evidence: verified.evidence };
      } finally { await verified.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    // The store derives and persists the complete physical projection. A digest
    // supplied by an operator/caller is never substituted for this source read.
    const checkpointStore = options.captureCheckpointStore;
    // A historical checkpoint alone cannot prove that this store's live audit
    // reads the locked database: another database may contain the same history.
    // The store module recognizes only a successful, unclosed MySQL instance
    // and rechecks its own pool connection's actual server/database identity.
    await assertMysqlSessionStoreDatabaseBinding(checkpointStore, {
      serverUuid: before.identity.serverUuid, database: before.identity.database,
    }, { timeoutMs: deadline.check(), operationAbortSignal: deadline.controller.signal });
    deadline.check();
    // This is only an EARLY rejection hint, never source authorization. Query
    // the locked actual DB (not the caller's facade) so a missing restored-v2
    // observer cannot even seal a checkpoint. The full store/reader audits
    // below remain mandatory; inactive legacy restore backups stay v1-capable.
    const observationMode = await rows(state.source.connection, `SELECT r.state AS runtime_state,
      r.lineage_kind,c.state AS capture_state FROM tenant_restore_runtime_control r
      JOIN tenant_telemetry_capture_v2_controls c ON c.domain='logs' WHERE r.singleton_id=1`, [], deadline);
    if (observationMode.length !== 1 || observationMode[0]!.runtime_state !== "active"
      || !["primary", "restore"].includes(String(observationMode[0]!.lineage_kind))
      || !["inactive", "active"].includes(String(observationMode[0]!.capture_state))) artifactFailure("capture_source_observation_invalid");
    if (observationMode[0]!.lineage_kind === "restore" && observationMode[0]!.capture_state === "active"
      && options.sourceObserver === undefined) artifactFailure("capture_source_observer_required");
    const sealInput = { backupId: options.anchor.backupId, fleetStoppedAck: "fleet-stopped-v1" as const, localOnlyAck: "local-only-v1" as const };
    if (options.sourceObserver !== undefined) {
      await operator.assertHeld();
      await assertMySqlBackupArtifactSourceObserved(options.sourceObserver, checkpointStore, options.anchor);
      await operator.assertHeld();
    }
    deadline.check();
    const sealed = await checkpointStore.sealTenantTelemetryCaptureBackupCheckpoint(sealInput);
    deadline.check();
    let checkpoint: TenantTelemetryCaptureBackupCheckpoint | undefined;
    if (sealed !== null) {
      const record = structuredClone(sealed.value);
      assertArtifactCaptureCheckpoint(record.checkpoint, options.anchor, refKey);
      if (record.checkpoint.sourceRuntimeLineageKind === "restore"
        && record.checkpoint.scope !== TENANT_TELEMETRY_CAPTURE_CHECKPOINT_V2_SCOPE) artifactFailure("capture_checkpoint_version_mismatch");
      if (record.checkpoint.scope === TENANT_TELEMETRY_CAPTURE_CHECKPOINT_V2_SCOPE && options.sourceObserver === undefined) {
        artifactFailure("capture_source_observer_required");
      }
      try {
        assertTenantTelemetryCaptureCheckpointLeaves(record.checkpoint, record.leaves, refKey!);
        if (record.checkpoint.scope === TENANT_TELEMETRY_CAPTURE_CHECKPOINT_V2_SCOPE) {
          if (!record.lineageLeaves) artifactFailure("capture_checkpoint_invalid");
          assertTenantTelemetryCaptureLineageLeaves(record.checkpoint.lineage, record.lineageLeaves, refKey!);
        } else if (record.lineageLeaves !== undefined) artifactFailure("capture_checkpoint_invalid");
      }
      catch { artifactFailure("capture_checkpoint_invalid"); }
      checkpoint = record.checkpoint;
    }
    const assertActualCheckpoint = async () => {
      if (!checkpoint) { await assertActualInactiveCapture(state.source, deadline); return; }
      deadline.check();
      await assertActualHistoricalCheckpoint(state.source, checkpoint, refKey, deadline);
      deadline.check();
      // read... validates every physical header column and all actual leaf roots.
      // A caller-owned Memory/wrong-DB store cannot substitute an authentic-looking
      // checkpoint for the rows that will enter this operator's actual dump.
    };
    await assertActualCheckpoint();
    const assertCheckpointUnchanged = async () => {
      deadline.check();
      // Wait for the actual store operation to settle before releasing operator
      // locks, even if its inherited whole-operation abort has already fired.
      if (checkpoint) await checkpointStore.assertTenantTelemetryCaptureBackupCheckpointUnchanged({ ...sealInput,
        checkpointSha256: checkpoint.checkpointSha256 });
      else if (await checkpointStore.sealTenantTelemetryCaptureBackupCheckpoint(sealInput) !== null) artifactFailure("capture_checkpoint_changed");
      await assertActualCheckpoint();
      if (options.sourceObserver !== undefined) {
        await operator.assertHeld();
        await assertMySqlBackupArtifactSourceObserved(options.sourceObserver, checkpointStore, options.anchor);
        await operator.assertHeld();
      }
      deadline.check();
    };
    const mysqlPath = await toolPath(options.tools.mysql, deadline);
    const dumpPath = await toolPath(options.tools.mysqldump, deadline);
    const mysqlVersion = await toolVersion(mysqlPath, state.workDirectory, deadline);
    const mysqldumpVersion = await toolVersion(dumpPath, state.workDirectory, deadline);
    credentials = await defaultsFile(options.sourceUrl, state.workDirectory, deadline);
    plain = await unlinkedSpool(state.workDirectory, deadline);
    // A no-path held spool bounds bytes while the producer is still running, not after completion.
    const limited = counted(options.maxBytes);
    const child = spawn(dumpPath, [`--defaults-file=${credentials}`, "--single-transaction", "--skip-lock-tables",
      "--routines", "--events", "--triggers", "--hex-blob", "--no-tablespaces", "--set-gtid-purged=OFF",
      "--column-statistics=0", "--default-character-set=utf8mb4", "--skip-comments", "--skip-add-drop-table",
      before.identity.database], { shell: false, cwd: state.workDirectory,
      env: { LANG: "C", LC_ALL: "C", MYSQL_TEST_LOGIN_FILE: join(state.workDirectory, "no-login-file") },
      stdio: ["ignore", "pipe", "pipe"] });
    child.stderr.on("data", () => {});
    const completion = new Promise<void>((done, reject) => {
      child.once("error", () => reject(new MySqlBackupArtifactError("tool_unavailable")));
      child.once("close", (code) => code === 0 ? done() : reject(new MySqlBackupArtifactError("dump_failed")));
    });
    const abort = () => child.kill("SIGKILL");
    deadline.controller.signal.addEventListener("abort", abort, { once: true });
    const stream = pipeline(child.stdout, limited.stream, heldWrite(plain), { signal: deadline.controller.signal });
    try { await deadline.bound(Promise.all([completion, stream]), abort); }
    catch (error) { abort(); await Promise.allSettled([completion, stream]); throw error; }
    finally { deadline.controller.signal.removeEventListener("abort", abort); }
    const plaintext = limited.result();
    if (!plaintext.bytes) artifactFailure("dump_empty");
    const after = await inspectSource(state.source, options.anchor, deadline);
    if (canonicalJson(before) !== canonicalJson(after)) artifactFailure("source_changed");
    await assertCheckpointUnchanged();
    key = await keyBytes(options.keyFile, deadline);
    const nonce = randomBytes(12);
    const body = {
      backupId: options.anchor.backupId, anchor: structuredClone(options.anchor),
      schemaMigrationRootSha256: options.anchor.schemaMigrationRootSha256, sourceIdentitySha256: before.identity.identitySha256,
      schemaSha256: before.schemaSha256,
      mysqlVersion, mysqldumpVersion, serverVersion: before.identity.serverVersion,
      plaintextBytes: plaintext.bytes, plaintextSha256: plaintext.sha256,
      ciphertextBytes: plaintext.bytes, ciphertextSha256: "0".repeat(64),
      encryption: { algorithm: "aes-256-gcm" as const, nonceHex: nonce.toString("hex"), authTagHex: "0".repeat(32) },
    };
    const manifest: MySqlBackupArtifactManifest = checkpoint
      ? checkpoint.scope === TENANT_TELEMETRY_CAPTURE_CHECKPOINT_V2_SCOPE
        ? { ...body, scope: MYSQL_BACKUP_ARTIFACT_V3_SCOPE, version: 3, producerVersion: MYSQL_BACKUP_ARTIFACT_V3_PRODUCER_VERSION, captureCheckpoint: checkpoint }
        : { ...body, scope: MYSQL_BACKUP_ARTIFACT_V2_SCOPE, version: 2, producerVersion: MYSQL_BACKUP_ARTIFACT_V2_PRODUCER_VERSION, captureCheckpoint: checkpoint }
      : { ...body, scope: MYSQL_BACKUP_ARTIFACT_SCOPE, version: 1, producerVersion: MYSQL_BACKUP_ARTIFACT_PRODUCER_VERSION };
    encrypted = await unlinkedSpool(state.workDirectory, deadline);
    const cipher = createCipheriv("aes-256-gcm", key, nonce); cipher.setAAD(artifactAad(manifest));
    const counter = counted(options.maxBytes);
    await pipeline(heldRead(plain), cipher, counter.stream,
      heldWrite(encrypted), { signal: deadline.controller.signal });
    const encryptedDigest = counter.result();
    manifest.ciphertextBytes = encryptedDigest.bytes; manifest.ciphertextSha256 = encryptedDigest.sha256;
    manifest.encryption.authTagHex = cipher.getAuthTag().toString("hex");
    const manifestBytes = encodeArtifactManifest(manifest, options.maxBytes, refKey);
    const header = Buffer.alloc(12); (manifest.version === 3 ? MYSQL_BACKUP_ARTIFACT_V3_MAGIC
      : manifest.version === 2 ? MYSQL_BACKUP_ARTIFACT_V2_MAGIC : MYSQL_BACKUP_ARTIFACT_MAGIC).copy(header); header.writeUInt32BE(manifestBytes.length, 8);
    temporary = join(state.workDirectory, `artifact-${randomUUID()}`);
    packed = await createdFile(temporary, "wx+", deadline);
    await deadline.bound(packed.writeFile(Buffer.concat([header, manifestBytes])));
    await pipeline(heldRead(encrypted), heldWrite(packed, 12 + manifestBytes.length), { signal: deadline.controller.signal });
    await deadline.bound(packed.sync());
    const digest = await hashFile(packed, options.maxBytes + MAX_MANIFEST_LIMIT + 12, deadline);
    await assertLock(state.source, deadline);
    await assertCheckpointUnchanged();
    // Atomic create-only publication: EEXIST is never replaced, even after a partially observed failure.
    await deadline.bound(link(temporary, destination));
    await deadline.bound(unlink(temporary)); temporary = undefined;
    await syncDirectory(state.directory, deadline);
    const expected = artifactEvidence(manifest, digest.sha256);
    const verified = await verifyMySqlBackupArtifact({ ...options, backupId: options.anchor.backupId,
      expectedAnchor: options.anchor, expectedEvidence: expected, deadlineMs: deadline.check() });
    try { await operator.assertHeld(); return { disposition: "created", manifest: verified.manifest, evidence: verified.evidence }; }
    finally { await verified.close(); }
  } catch (error) {
    if (error instanceof MySqlBackupArtifactError) throw error;
    return artifactFailure("artifact_create_failed");
  } finally {
    deadline.dispose(); key?.fill(0); refKey?.fill(0);
    await plain?.close().catch(() => {}); await encrypted?.close().catch(() => {}); await packed?.close().catch(() => {});
    if (credentials) await unlink(credentials).catch(() => {});
    if (temporary) await unlink(temporary).catch(() => {});
    if (ownedOperator) await operator.close();
  }
}

export async function importVerifiedMySqlBackupArtifact(verified: VerifiedMySqlBackupArtifact,
  options: ImportVerifiedMySqlBackupArtifactOptions): Promise<void> {
  options = { ...options, tools: { ...options.tools } };
  safety(options, true);
  const verifiedState = verifiedArtifacts.get(verified);
  if (!verifiedState || verifiedState.closed || verifiedState.consumed) artifactFailure("verified_capability_invalid");
  const state = operatorState(options.operator);
  const deadline = new Deadline(options.deadlineMs, state.deadline, options.operationAbortSignal);
  let credentials: string | undefined; let started = false;
  let phase: MySqlBackupArtifactImportDiagnostic["phase"] = "native_import";
  try {
    if (!state.target || state.target.url !== options.targetUrl
      || state.source.identity.identitySha256 !== verified.manifest.sourceIdentitySha256
      || state.target.identity.identitySha256 === verified.manifest.sourceIdentitySha256) artifactFailure("target_is_source");
    const binding = state.bindings.get(options.restoreRunId);
    if (!binding || binding.runtimeEpochSha256 !== options.runtimeEpochSha256
      || binding.backupId !== verified.manifest.backupId
      || binding.anchorSha256 !== verified.manifest.anchor.anchorSha256
      || binding.sourceIdentitySha256 !== verified.manifest.sourceIdentitySha256
      || binding.targetIdentitySha256 !== state.target.identity.identitySha256
      || canonicalJson(binding.evidence) !== canonicalJson(verified.evidence)) artifactFailure("restore_operation_conflict");
    await assertLock(state.source, deadline); await assertLock(state.target, deadline); await assertEmpty(state.target, deadline);
    const identity = await identify(state.target.connection, deadline);
    if (identity.identitySha256 !== state.target.identity.identitySha256) artifactFailure("target_identity_mismatch");
    const mysqlPath = await toolPath(options.tools.mysql, deadline);
    await toolVersion(mysqlPath, state.workDirectory, deadline);
    credentials = await defaultsFile(options.targetUrl, state.workDirectory, deadline);
    await journalStage(state, binding, "import_started");
    verifiedState.consumed = true; started = true;
    await runTool(mysqlPath, [`--defaults-file=${credentials}`, "--binary-mode=1", "--skip-reconnect",
      "--local-infile=0", "--default-character-set=utf8mb4", `--database=${identity.database}`],
      state.workDirectory, deadline, undefined, verifiedState.handle);
    phase = "lock_recheck";
    await assertLock(state.source, deadline); await assertLock(state.target, deadline);
    phase = "schema_inspection";
    const imported = await inspectSource(state.target, verified.manifest.anchor, deadline);
    phase = "schema_digest";
    if (imported.schemaSha256 !== verified.manifest.schemaSha256) artifactFailure("target_schema_mismatch");
    phase = "import_completed_journal";
    await journalStage(state, binding, "import_completed");
  } catch (error) {
    // MySQL DDL auto-commits: never claim rollback or remove a partially imported target.
    if (started) {
      // This diagnostic is an in-process, content-free closed vocabulary, not a
      // native cause/message/SQL or a reason to weaken target-isolation behavior.
      const allowedCodes = new Set<string>(["tool_failed", "tool_unavailable", "operation_deadline", "operator_lock_lost",
        "database_query_failed", "server_version_invalid", "source_identity_mismatch", "source_migration_mismatch",
        "source_anchor_invalid", "source_anchor_mismatch", "source_changed", "source_schema_invalid", "source_schema_limit",
        "source_schema_nonportable", "source_views_unsupported", "source_routines_unsupported", "source_events_unsupported",
        "target_schema_mismatch", "manifest_invalid", "artifact_file_unprotected", "restore_operation_conflict", "operator_invalid"]);
      const code = error instanceof MySqlBackupArtifactError && allowedCodes.has(error.code)
        ? error.code as MySqlBackupArtifactImportDiagnostic["code"] : "unclassified";
      throw new MySqlBackupArtifactError("import_failed_target_isolated", true, Object.freeze({ phase, code }));
    }
    if (error instanceof MySqlBackupArtifactError) throw error;
    artifactFailure("import_unavailable");
  } finally {
    deadline.dispose(); if (credentials) await unlink(credentials).catch(() => {});
    if (started) await verified.close();
  }
}
