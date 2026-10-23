import { createHash, randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection as createSocket, type Socket } from "node:net";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdtemp, open, readFile, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { expect, type TestContext } from "vitest";
import type { Session } from "@agent-service/protocol";
import { MysqlSessionStore, prepareSessionAuthorityBindingCommand, assertSessionAuthorityActivationAdmission,
  attachSessionWriteAdmission, createSessionAcquireCommand, type SchemaMetadataReaderConfig,
  newUsageId, type SessionAuthorityBindingOperatorContext, type SessionAuthorityBindingCommandInput, type MysqlRestoreJournalMaintenance } from "../../src/index.js";
import { mkSession, newId } from "../conformance.js";
import { createMysqlSchemaCliExecutor } from "../../../../test/fixtures/mysql-schema-cli.mjs";

export const ROOT = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const MIGRATIONS = join(ROOT, "packages/store/migrations");
const OLD_MARKER = "0065_mcp_dcr.sql", NEW_MARKER = "0066_mysql_live_session_authority.sql";
const STOP = "all-application-writers-stopped-v1" as const;
export const OLD_VM = Object.freeze({ manifest: "5b835e7aba949a3bd6011baca7dc9753716a41dfddd806cb2b6c42f5ef451bd3",
  input: "cb14af3a436c2a7dd3c9f7e4f07585522f6e9b122b020b56fc64fdf2524aa382",
  commit: "38c75a606661267f1626ddce088d5250992d1a3b", archive: "7c086b7584ac7ea83ea445990e9d0b91bdb7a23d56380a77e164b54efcaca1ea" });
const q = mysql.escapeId, account = (user: string, host: string) => `${mysql.escape(user)}@${mysql.escape(host)}`;
const at = (base: URL, database: string, user?: string, password?: string) => {
  const u = new URL(base); u.pathname = `/${database}`;
  if (user !== undefined) { u.username = user; u.password = password ?? ""; } return u.toString();
};
function active(signal: AbortSignal) { signal.throwIfAborted(); }
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
/** CREATE USER errors can carry the expanded password in message/sql/stack. Retain only
 * closed native identity fields on a new controlled Error, without a cause/raw Error reference. */
function credentialDdlFailure(error: unknown): Error {
  const failure = new Error("Retirement fixture credential DDL failed."); failure.name = "RetirementCredentialDdlError";
  for (const key of ["code", "errno", "sqlState"] as const) {
    try {
      const descriptor = error !== null && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, key) : undefined;
      if (!descriptor || !("value" in descriptor)) continue;
      const value: unknown = descriptor.value;
      if (key === "code" && typeof value === "string" && value.length <= 96
        && /^(?:(?:ER|WARN|EE|CR|HA_ERR|PROTOCOL|ERR)_[A-Z0-9_]+|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|ABORT_ERR)$/.test(value)
        || key === "errno" && typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 65_535
        || key === "sqlState" && typeof value === "string" && /^[A-Z0-9]{5}$/.test(value)) {
        Object.defineProperty(failure, key, { value, enumerable: true });
      }
    } catch { /* A diagnostic getter/proxy must never expose its own raw failure. */ }
  }
  return failure;
}
async function preserveFirst<T>(work: () => Promise<T>, close: () => Promise<void>): Promise<T> {
  let failed = false, first: unknown, value!: T;
  try { value = await work(); } catch (error) { failed = true; first = error; }
  try { await close(); } catch (error) { if (!failed) { failed = true; first = error; } }
  if (failed) throw first; return value;
}

/** Native connection owner, installed before mysql2 creates its first socket, including failures. */
export class OwnedRetirementConnection {
  private readonly sockets = new Set<Socket>();
  private readonly native = new Set<Promise<void>>();
  private readonly pending = new Set<Promise<unknown>>();
  private connection?: Connection;
  private connecting?: Promise<Connection>;
  private closing?: Promise<void>;
  private opened = 0;
  private closed = 0;
  private inTransaction = false;
  private destroyFailure?: { reason: unknown };
  private readonly destroy = () => {
    try { this.connection?.destroy(); } catch (reason) { this.destroyFailure ??= { reason }; }
    for (const socket of this.sockets) try { socket.destroy(); } catch (reason) { this.destroyFailure ??= { reason }; }
  };
  private constructor(readonly signal: AbortSignal) { signal.addEventListener("abort", this.destroy, { once: true }); }
  static async open(url: string, signal: AbortSignal, register: (owner: OwnedRetirementConnection) => void): Promise<OwnedRetirementConnection> {
    const owner = new OwnedRetirementConnection(signal); register(owner);
    try {
      active(signal);
      owner.connecting = mysql.createConnection({ uri: url, connectTimeout: 5_000, timezone: "Z", supportBigNumbers: true,
        stream: ({ config }: { config: { host: string; port: number; socketPath?: string } }) => {
          const socket = config.socketPath ? createSocket(config.socketPath) : createSocket(config.port, config.host);
          owner.opened++; owner.sockets.add(socket);
          const done = new Promise<void>(yes => socket.once("close", () => yes())); owner.native.add(done);
          void done.then(() => { owner.closed++; owner.sockets.delete(socket); owner.native.delete(done); });
          if (signal.aborted || owner.closing) queueMicrotask(() => socket.destroy()); return socket;
        } });
      owner.connection = await owner.connecting; active(signal); return owner;
    } catch (error) { try { await owner.close(); } catch { /* Opening error remains first; close still joins. */ } throw error; }
  }
  async rows(sql: string, values: readonly unknown[] = []): Promise<RowDataPacket[]> {
    active(this.signal); if (this.closing || !this.connection) throw Error("retirement_connection_closed");
    const task = this.connection.query<RowDataPacket[]>({ sql, timeout: 5_000 }, [...values]);
    this.pending.add(task); void task.then(() => this.pending.delete(task), () => this.pending.delete(task));
    const [result] = await task; active(this.signal);
    // DDL/DML returns ResultSetHeader. Callers of exec do not misrepresent it as rows.
    if (!Array.isArray(result)) throw Error("retirement_expected_rows"); return result;
  }
  async exec(sql: string, values: readonly unknown[] = []): Promise<void> {
    active(this.signal); if (this.closing || !this.connection) throw Error("retirement_connection_closed");
    const task = this.connection.query({ sql, timeout: 5_000 }, [...values]);
    this.pending.add(task); void task.then(() => this.pending.delete(task), () => this.pending.delete(task)); await task; active(this.signal);
  }
  async begin(): Promise<void> { await this.exec("START TRANSACTION"); this.inTransaction = true; }
  async rollback(): Promise<void> {
    if (!this.inTransaction) return;
    try { await this.exec("ROLLBACK"); this.inTransaction = false; }
    catch (error) { this.destroy(); try { await this.close(); } catch { /* Preserve actual rollback failure. */ } throw error; }
  }
  evidence() { return { opened: this.opened, closed: this.closed, pending: this.pending.size, socketPromises: this.native.size }; }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      let first: { reason: unknown } | undefined;
      try { await this.connecting; } catch { /* Open reports its own error; cleanup must still join without rethrowing an expected auth denial. */ }
      try {
        if (this.inTransaction && !this.signal.aborted && this.connection) {
          try { await this.connection.query({ sql: "ROLLBACK", timeout: 5_000 }); this.inTransaction = false; }
          catch (reason) { first ??= { reason }; this.destroy(); }
        }
        if (!this.signal.aborted) await this.connection?.end();
      } catch (reason) { first ??= { reason }; }
      finally {
        this.destroy();
        while (this.native.size) await Promise.all([...this.native]);
        while (this.pending.size) await Promise.allSettled([...this.pending]);
        this.signal.removeEventListener("abort", this.destroy);
        if (this.opened !== this.closed) first ??= { reason: Error("retirement_native_not_closed") };
        first ??= this.destroyFailure;
      }
      if (first) throw first.reason;
    })();
  }
}

/** Immutable preparatory copy only; no DB, account, service or shared mutable fixture in hooks. */
export async function prepareRetirementOldMigrations(): Promise<string> {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "agent-service-old65-sql-"));
  await chmod(directory, 0o700);
  const names = (await readdir(MIGRATIONS)).filter(name => name.endsWith(".sql") && name <= OLD_MARKER).sort();
  expect(names.at(-1)).toBe(OLD_MARKER); expect(names).not.toContain(NEW_MARKER);
  for (const name of names) {
    const source = join(MIGRATIONS, name), target = join(directory, name);
    const before = await readFile(source); await copyFile(source, target);
    expect(sha(await readFile(target))).toBe(sha(before));
  }
  return directory;
}

/** Explicit local profile only; root must first unpack the independently pinned local archive.
 * Complete payload/native target/source checks run before any archived code is invoked. */
export async function verifyRetirementOldVm(): Promise<string> {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw Error("old_vm_profile_requires_actual_darwin_arm64");
  const root = process.env.AUTHORITY_OLD_VM_DIRECTORY;
  if (!root || resolve(root) !== root || await realpath(root) !== root) throw Error("explicit_old_vm_required");
  const stat = await lstat(root), parent = dirname(root), parentStat = await lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
    || await realpath(parent) !== parent || !parentStat.isDirectory() || parentStat.isSymbolicLink()
    || parentStat.uid !== process.getuid?.() || (parentStat.mode & 0o7777) !== 0o700
    || !basename(parent).startsWith("agent-service-authority-old-vm-")) throw Error("old_vm_identity");
  const module: unknown = await import(new URL("../../../../scripts/lib/vm-release.mjs", import.meta.url).href);
  const verify: unknown = module !== null && typeof module === "object" ? Reflect.get(module, "verifyVmReleaseDirectory") : undefined;
  if (typeof verify !== "function") throw Error("old_vm_verifier_missing");
  const manifest: unknown = await verify(root, "agent-runner", OLD_VM.manifest);
  if (manifest === null || typeof manifest !== "object") throw Error("old_vm_manifest_invalid");
  expect(Reflect.get(manifest, "targetRuntime")).toEqual({ nodeMajor: 24, platform: "darwin", arch: "arm64" });
  expect(Number(process.versions.node.split(".")[0])).toBe(24);
  expect(Reflect.get(manifest, "source")).toMatchObject({ sourceCommit: OLD_VM.commit, sourceDirty: true, inputSha256: OLD_VM.input });
  const names = (await readdir(join(root, "dist/migrations"))).filter(name => name.endsWith(".sql")).sort();
  expect(names.at(-1)).toBe(OLD_MARKER); return root;
}

export type RetirementDiagnostic = (event: { stage: string; state?: unknown; child?: unknown; childIndex?: number; credentialMode?: "legacy" | "current" }) => void;
function emitRetirementDiagnostic(observer: RetirementDiagnostic | undefined, event: Parameters<RetirementDiagnostic>[0]): void {
  try { observer?.(event); } catch { /* Test observation cannot change a native result or first failure. */ }
}

export class OwnedOldRunner {
  private readonly native: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private stopping = false;
  private closed = false;
  private exited = false;
  private spawnFailed = false;
  private code: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private observedExitCode: number | null = null;
  private observedExitSignal: NodeJS.Signals | null = null;
  private readyAttempts = 0;
  private lastReadyStatus: number | null = null;
  private readyFulfilled = false;
  private bytes = 0;
  private readonly chunks: Buffer[] = [];
  private readonly requests = new Set<Promise<unknown>>();
  private clientClosing = false;
  private readonly abort = () => this.stop();
  private constructor(private readonly child: ChildProcess, readonly baseUrl: string, private readonly signal: AbortSignal,
    private readonly observe?: (stage: string, state: ReturnType<OwnedOldRunner["diagnosticState"]>) => void) {
    this.native = new Promise<void>(yes => {
      child.once("error", () => { this.spawnFailed = true; this.report("child_spawn_error"); this.stop(); });
      child.once("exit", (code, signal) => {
        this.exited = true; this.observedExitCode = code; this.observedExitSignal = signal; this.report("child_exit");
      });
      child.once("close", (code, exitSignal) => {
        this.closed = true; this.code = code; this.exitSignal = exitSignal;
        if (this.timer !== undefined) clearTimeout(this.timer);
        signal.removeEventListener("abort", this.abort); this.report("child_close"); yes();
      });
      for (const stream of [child.stdout, child.stderr]) {
        if (!stream) { this.spawnFailed = true; continue; }
        stream.on("data", chunk => {
          const b = Buffer.from(chunk); this.bytes += b.length;
          if (this.bytes > 65_536) { this.spawnFailed = true; this.stop(); } else this.chunks.push(b);
        });
        stream.once("error", () => { this.spawnFailed = true; this.stop(); });
      }
    });
    signal.addEventListener("abort", this.abort, { once: true }); if (signal.aborted) this.stop();
  }
  private report(stage: string): void { try { this.observe?.(stage, this.diagnosticState()); } catch { /* Observation only. */ } }
  diagnosticState() {
    const captured = Buffer.concat(this.chunks);
    return { pid: this.child.pid ?? null, closed: this.closed, exited: this.exited, stopping: this.stopping, spawnFailed: this.spawnFailed,
      closeCode: this.code, closeSignal: this.exitSignal, exitCode: this.observedExitCode, exitSignal: this.observedExitSignal,
      outputBytes: this.bytes, capturedBytes: captured.length, startFailedMarker: captured.includes(Buffer.from("runner.process.start_failed")),
      startedMarker: captured.includes(Buffer.from("runner.lifecycle.started")), requestsPending: this.requests.size,
      readyAttempts: this.readyAttempts, lastReadyStatus: this.lastReadyStatus, readyFulfilled: this.readyFulfilled };
  }
  static async start(vm: string, environment: NodeJS.ProcessEnv, state: string, signal: AbortSignal,
    observe?: (stage: string, state: ReturnType<OwnedOldRunner["diagnosticState"]>) => void): Promise<OwnedOldRunner> {
    active(signal); expect(await realpath(vm)).toBe(vm); active(signal);
    const net = await import("node:net"); active(signal);
    const listener = net.createServer();
    const port = await new Promise<number>((yes, no) => {
      listener.once("error", no); listener.listen(0, "127.0.0.1", () => {
        const address = listener.address();
        listener.close(error => error ? no(error) : typeof address === "object" && address ? yes(address.port) : no(Error("old_vm_port")));
      });
    });
    active(signal);
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: state, TMPDIR: state, NODE_ENV: "test", NO_COLOR: "1",
      STORE: "mysql", RUNNER_HOST: "127.0.0.1", RUNNER_PORT: String(port), RUNNER_ADDR: `127.0.0.1:${port}`,
      BLOB_STORE: "filesystem", BLOB_FILESYSTEM_SINGLE_RUNNER: "1", BLOB_DIR: join(state, "blobs"),
      SHUTDOWN_GRACE_MS: "0", ...environment };
    // Only this authenticated VM entrypoint; no source/dist fallback or shell.
    const child = spawn(process.execPath, [join(vm, "dist/main.js")], { cwd: vm, env, stdio: ["ignore", "pipe", "pipe"], detached: false, shell: false });
    const owner = new OwnedOldRunner(child, `http://127.0.0.1:${port}`, signal, observe); owner.report("child_spawned"); return owner;
  }
  request(path: string, body?: unknown): Promise<{ status: number; body: string }> {
    if (this.clientClosing) return Promise.reject(Error("old_vm_client_closed"));
    const url = new URL(path, this.baseUrl); if (url.origin !== this.baseUrl) throw Error("old_vm_local_http_only");
    const task = (async () => {
      active(this.signal);
      let response: IncomingMessage | undefined, socket: Socket | undefined;
      let socketClosed: Promise<void> | undefined;
      const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      let stop: () => void = () => {};
      let requestClosed: Promise<void> | undefined;
      const signal = AbortSignal.any([this.signal, AbortSignal.timeout(body === undefined ? 500 : 5_000)]);
      const finished = new Promise<{ status: number; body: string }>((yes, no) => {
        const req = httpRequest(url, { method: body === undefined ? "GET" : "POST", agent: false,
          headers: { Authorization: "Bearer old-vm-fixture-only-key", "X-User-Id": "old-vm-user",
            ...(bytes ? { "Content-Type": "application/json", "Content-Length": String(bytes.length) } : {}) } }, res => {
          response = res; const chunks: Buffer[] = []; let count = 0;
          res.on("data", chunk => { const value = Buffer.from(chunk); count += value.length;
            if (count > 65_536) req.destroy(Error("old_vm_http_bound")); else chunks.push(value); });
          res.once("error", no); res.once("aborted", () => no(Error("old_vm_http_aborted")));
          res.once("end", () => yes({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        });
        requestClosed = new Promise<void>(resolveClosed => req.once("close", () => resolveClosed()));
        stop = () => { response?.destroy(); req.destroy(Error("old_vm_http_cancelled")); };
        req.once("socket", value => { socket = value; socketClosed = value.closed ? Promise.resolve() : new Promise<void>(resolveClosed => value.once("close", () => resolveClosed()));
          if (signal.aborted) value.destroy(); });
        req.once("error", no); signal.addEventListener("abort", stop, { once: true });
        if (signal.aborted) stop(); else req.end(bytes);
      });
      try { return await finished; }
      finally { signal.removeEventListener("abort", stop); stop(); if (socket && !socket.closed) socket.destroy(); await requestClosed; await socketClosed; }
    })();
    this.requests.add(task); void task.then(() => this.requests.delete(task), () => this.requests.delete(task)); return task;
  }
  async ready(): Promise<void> {
    this.report("child_ready_enter");
    while (!this.closed) {
      active(this.signal); this.readyAttempts++;
      try {
        this.lastReadyStatus = (await this.request("/readyz")).status;
        if (this.lastReadyStatus === 200) { this.readyFulfilled = true; this.report("child_ready_done"); return; }
      } catch { active(this.signal); }
      await delay(20, undefined, { signal: this.signal });
    }
    throw Error("old_vm_closed_before_ready");
  }
  stop(): void {
    if (this.closed || this.stopping || this.exited) return; this.stopping = true; this.report("child_stop_requested");
    try { this.child.kill("SIGTERM"); } catch { this.spawnFailed = true; }
    this.timer = setTimeout(() => { if (!this.closed && !this.exited) { try { this.child.kill("SIGKILL"); } catch { this.spawnFailed = true; } } }, 5_000);
  }
  async close(): Promise<void> { this.clientClosing = true; this.stop(); await this.native; while (this.requests.size) await Promise.allSettled([...this.requests]); if (this.spawnFailed) throw Error("old_vm_native_failed"); }
  async expectColdRefusal(): Promise<void> {
    this.report("child_cold_native_wait"); await this.native; this.report("child_cold_native_done");
    expect(this.spawnFailed).toBe(false); expect(this.code).toBe(1); expect(this.exitSignal).toBeNull();
    expect(Buffer.concat(this.chunks).toString("utf8")).toContain("runner.process.start_failed");
    await expect(this.request("/readyz")).rejects.toMatchObject({ code: "ECONNREFUSED" }); this.report("child_cold_refusal_done");
  }
}

export class RetirementFixture {
  readonly database = `agent_service_test_retirement_${randomBytes(10).toString("hex")}`;
  readonly metadataDatabase = `agent_service_test_retire_meta_${randomBytes(10).toString("hex")}`;
  readonly oldName = `saold_${randomBytes(8).toString("hex")}`;
  readonly newName = `sanew_${randomBytes(8).toString("hex")}`;
  readonly definerName = `sadef_${randomBytes(8).toString("hex")}`;
  private readonly oldPassword = randomBytes(32).toString("hex");
  private readonly newPassword = randomBytes(32).toString("hex");
  private readonly definerPassword = randomBytes(32).toString("hex");
  private readonly raw: OwnedRetirementConnection[] = [];
  private readonly stores: Array<{ close(): Promise<void> }> = [];
  private readonly runners: OwnedOldRunner[] = [];
  private readonly attempts: string[] = [];
  private readonly startup = new Set<Promise<unknown>>();
  private closing?: Promise<void>;
  private rootUrl!: URL;
  private admin!: OwnedRetirementConnection;
  uuid = "";
  host = "";
  evidenceDirectory = "";
  command?: SessionAuthorityBindingOperatorContext;
  readonly extraOldHost = "198.51.100.1"; // An unused literal host; never dialed.
  metadata!: SchemaMetadataReaderConfig;
  private constructor(readonly context: TestContext, readonly oldDirectory: string, private readonly oldVm?: string,
    private readonly observe?: RetirementDiagnostic) {}
  diagnosticState() {
    return { startupPending: this.startup.size, storeOwners: this.stores.length, runners: this.runners.slice(0, 2).map(runner => runner.diagnosticState()),
      rawConnections: this.raw.slice(0, 8).map(connection => connection.evidence()) };
  }
  report(stage: string): void { if (this.observe) emitRetirementDiagnostic(this.observe, { stage, state: this.diagnosticState() }); }
  get signal() { return this.context.signal; }
  get operatorUrl() { return at(this.rootUrl, this.database); }
  get oldUrl() { return at(this.rootUrl, this.database, this.oldName, this.oldPassword); }
  get newUrl() { return at(this.rootUrl, this.database, this.newName, this.newPassword); }
  runtimeOptions(old = false) { return { url: old ? this.oldUrl : this.newUrl, migrationMode: "verify" as const,
    connectionLimit: 1, schemaMetadata: this.metadata, operationAbortSignal: this.signal, migrationsDir: old ? this.oldDirectory : MIGRATIONS }; }
  private own<T>(task: Promise<T>): Promise<T> { this.startup.add(task); void task.then(() => this.startup.delete(task), () => this.startup.delete(task)); return task; }
  static async create(context: TestContext, oldDirectory: string, oldVm?: string, observe?: RetirementDiagnostic): Promise<RetirementFixture> {
    const f = new RetirementFixture(context, oldDirectory, oldVm, observe);
    try { await f.prepare(); return f; }
    catch (error) { try { await f.close(false); } catch { /* Original preparation error remains first. */ } throw error; }
  }
  private async prepare() {
    const source = process.env.MYSQL_TEST_URL, expectedUuid = process.env.MYSQL_AUTHORITY_EXPECTED_UUID;
    if (!source || !expectedUuid || !/^[a-f0-9-]{36}$/i.test(expectedUuid)) throw Error("explicit_owned_retirement_mysql_required");
    this.evidenceDirectory = await mkdtemp(join(await realpath(tmpdir()), "agent-service-authority-retirement-evidence-"));
    await chmod(this.evidenceDirectory, 0o700);
    this.rootUrl = new URL(source);
    if (this.rootUrl.protocol !== "mysql:" || !["localhost", "127.0.0.1", "[::1]"].includes(this.rootUrl.hostname)
      || this.rootUrl.search || this.rootUrl.hash || !/(?:^|[_-])test(?:$|[_-])/i.test(decodeURIComponent(this.rootUrl.pathname.slice(1)))) throw Error("owned_test_mysql_required");
    this.admin = await this.connectRaw(at(this.rootUrl, "mysql"));
    const info = await this.admin.rows("SELECT @@GLOBAL.server_uuid AS uuid,DATABASE() AS db,SUBSTRING_INDEX(USER(),'@',-1) AS host");
    expect(info).toHaveLength(1); expect(String(info[0]!.uuid).toLowerCase()).toBe(expectedUuid.toLowerCase()); expect(info[0]!.db).toBe("mysql");
    this.uuid = String(info[0]!.uuid); this.host = String(info[0]!.host);
    if (!/^[a-z0-9.:-]+$/i.test(this.host) || this.host === this.extraOldHost) throw Error("literal_authenticated_host_required");
    this.metadata = Object.freeze({ metadataSchema: this.metadataDatabase, trustedDefiner: Object.freeze({ user: this.definerName, host: this.host }) });
    expect(await this.admin.rows("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME IN (?,?)", [this.database, this.metadataDatabase])).toEqual([]);
    expect(await this.admin.rows("SELECT User FROM mysql.user WHERE BINARY User IN (?,?,?)", [this.oldName, this.newName, this.definerName])).toEqual([]);
    this.attempts.push("application"); await this.admin.exec(`CREATE DATABASE ${q(this.database)} CHARACTER SET utf8mb4`);
    await this.schema("migrate", this.oldDirectory);
    const markers = await this.admin.rows(`SELECT name FROM ${q(this.database)}.schema_migrations ORDER BY name`);
    expect(markers.at(-1)?.name).toBe(OLD_MARKER);
    this.attempts.push("metadata"); await this.admin.exec(`CREATE DATABASE ${q(this.metadataDatabase)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    this.attempts.push("definer"); await this.createAccount(this.definerName, this.host, this.definerPassword, true);
    const revokes = await this.admin.rows("SELECT @@GLOBAL.partial_revokes AS v"); expect([0, 1]).toContain(Number(revokes[0]!.v));
    const schema = Number(revokes[0]!.v) === 0 ? this.database.replace(/[%_]/g, "\\$&") : this.database;
    await this.admin.exec(`GRANT TRIGGER ON ${q(schema)}.* TO ${account(this.definerName, this.host)}`);
    for (const host of [this.host, this.extraOldHost]) {
      this.attempts.push(`old:${host}`); await this.createAccount(this.oldName, host, this.oldPassword);
      await this.grantRuntime(this.oldName, host);
    }
    await this.schema("install-metadata", this.oldDirectory, this.metadata);
    await this.metadataExecute(this.definerName, [this.host]); await this.metadataExecute(this.oldName, [this.host, this.extraOldHost]);
  }
  async schema(operation: "migrate" | "verify" | "install-metadata", directory?: string, metadata?: SchemaMetadataReaderConfig) {
    active(this.signal);
    const options = { url: this.operatorUrl, operation, operationAbortSignal: this.signal,
      ...(operation === "verify" ? {} : { fleetStoppedAck: STOP }), ...(metadata ? { schemaMetadata: metadata } : {}) };
    if (directory === this.oldDirectory && this.oldVm) {
      await this.own(createMysqlSchemaCliExecutor({ entrypoint: join(this.oldVm, "dist/main.js"), mode: "dist", cwd: this.oldVm })(options));
    } else if (directory === undefined) {
      await this.own(createMysqlSchemaCliExecutor({ entrypoint: join(ROOT, "apps/agent-runner/src/main.ts"), mode: "source", cwd: ROOT })(options));
    } else {
      // The cross-platform ACL cases need a real old schema, not an old process.
      // Preserve each published SQL byte and use only the explicit capped product schema API.
      await this.own(MysqlSessionStore.runSchemaOperation({ ...options, migrationsDir: directory }));
    }
  }
  private async createAccount(user: string, host: string, password: string, locked = false): Promise<void> {
    // This is the only password-bearing SQL class in this private fixture. General exec errors,
    // particularly all twelve ACL native error oracles, remain the original errors.
    try { await this.admin.exec(`CREATE USER ${account(user, host)} IDENTIFIED BY ?${locked ? " ACCOUNT LOCK" : ""}`, [password]); }
    catch (error) { throw credentialDdlFailure(error); }
  }
  private async grantRuntime(user: string, host: string) {
    const tables = await this.admin.rows("SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE BINARY TABLE_SCHEMA=BINARY ? AND TABLE_TYPE='BASE TABLE' ORDER BY BINARY TABLE_NAME", [this.database]);
    expect(tables.length).toBeGreaterThan(0);
    for (const row of tables) {
      const name = String(row.n), readOnly = ["schema_migrations", "session_authority_control", "session_authority_bindings", "session_authority_runtime_accounts"].includes(name);
      await this.admin.exec(`GRANT ${readOnly ? "SELECT" : "SELECT,INSERT,UPDATE,DELETE"} ON ${q(this.database)}.${q(name)} TO ${account(user, host)}`);
    }
    await this.admin.exec(`GRANT SHOW_ROUTINE ON *.* TO ${account(user, host)}`);
  }
  private async metadataExecute(user: string, hosts: string[]) {
    const procedure = sha(this.database);
    for (const host of hosts) await this.admin.exec(`GRANT EXECUTE ON PROCEDURE ${q(this.metadataDatabase)}.${q(procedure)} TO ${account(user, host)}`);
  }
  async upgrade() {
    await this.schema("migrate"); await this.schema("install-metadata", undefined, this.metadata);
    await this.metadataExecute(this.definerName, [this.host]); await this.schema("verify");
    this.attempts.push("new"); await this.createAccount(this.newName, this.host, this.newPassword);
    await this.grantRuntime(this.newName, this.host); await this.metadataExecute(this.newName, [this.host]);
  }
  async retireOld() {
    for (const host of [this.host, this.extraOldHost]) {
      await this.admin.exec(`REVOKE SHOW_ROUTINE ON *.* FROM ${account(this.oldName, host)}`);
      await this.admin.exec(`REVOKE ALL PRIVILEGES,GRANT OPTION FROM ${account(this.oldName, host)}`);
      await this.admin.exec(`ALTER USER ${account(this.oldName, host)} ACCOUNT LOCK`);
    }
    const old = await this.admin.rows("SELECT User,Host,account_locked FROM mysql.user WHERE BINARY User=BINARY ? ORDER BY BINARY Host", [this.oldName]);
    expect(old).toEqual([this.extraOldHost, this.host].sort().map(host => expect.objectContaining({ User: this.oldName, Host: host, account_locked: "Y" })));
  }
  async connectRaw(url: string): Promise<OwnedRetirementConnection> {
    active(this.signal);
    const conn = await this.own(OwnedRetirementConnection.open(url, this.signal, owner => this.raw.push(owner))); active(this.signal); return conn;
  }
  async oldStore(): Promise<MysqlSessionStore> {
    active(this.signal); const store = await this.own(MysqlSessionStore.connect(this.runtimeOptions(true))); this.stores.push(store); active(this.signal); return store;
  }
  async newStore(): Promise<MysqlSessionStore> {
    active(this.signal); const store = await this.own(MysqlSessionStore.connect(this.runtimeOptions())); this.stores.push(store); active(this.signal); return store;
  }
  async operator(): Promise<MysqlRestoreJournalMaintenance> {
    active(this.signal);
    if (!this.command) {
      const input: SessionAuthorityBindingCommandInput = { bindingId: randomUUID(), activationId: randomUUID(),
        expectedBindingId: null, expectedSequence: 0, serverUuid: this.uuid, applicationDatabase: this.database,
        oldAccountNames: [this.oldName], newAccounts: [{ user: this.newName, host: this.host }], activationEvidenceSha256: sha(`retirement:${this.uuid}:${this.database}`),
        expectedSource: { kind: "inactive", runtimeControlGeneration: 0, runtimeControlEvidenceSha256: null, runtimeEpochSha256: null, restoreRunId: null, replayReceiptSha256: null }, nextEpoch: null };
      const prepared = prepareSessionAuthorityBindingCommand(input), bytes = Buffer.from(JSON.stringify(input) + "\n");
      const before = await lstat(this.evidenceDirectory);
      expect(await realpath(this.evidenceDirectory)).toBe(this.evidenceDirectory);
      expect(before.isDirectory() && !before.isSymbolicLink() && before.uid === process.getuid?.() && (before.mode & 0o7777) === 0o700).toBe(true);
      active(this.signal);
      const file = await open(join(this.evidenceDirectory, "authority-command.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await preserveFirst(async () => {
        const stat = await file.stat(); expect(stat.isFile() && stat.uid === process.getuid?.() && stat.nlink === 1 && (stat.mode & 0o7777) === 0o600).toBe(true);
        await file.writeFile(bytes); await file.sync();
      }, () => file.close());
      const directory = await open(this.evidenceDirectory, constants.O_RDONLY | constants.O_NOFOLLOW);
      await preserveFirst(() => directory.sync(), () => directory.close());
      const after = await lstat(this.evidenceDirectory);
      expect([after.dev, after.ino, after.uid, after.mode]).toEqual([before.dev, before.ino, before.uid, before.mode]);
      active(this.signal);
      this.command = { command: prepared, schemaMetadata: this.metadata, assertNativeAdmission: assertSessionAuthorityActivationAdmission };
    }
    const store = await this.own(MysqlSessionStore.connectRestoreJournalMaintenance({ url: this.operatorUrl, connectionLimit: 1,
      migrationsDir: MIGRATIONS, operationAbortSignal: this.signal }, { kind: "operator-maintenance", binding: this.command }));
    this.stores.push(store); active(this.signal); return store;
  }
  async seed() {
    const store = await this.oldStore(), session = mkSession("retirement_tenant", "retirement_user");
    return preserveFirst(async () => {
      await store.createSession(session); await store.commit({ sessionId: session.id, fence: 1, sessionPatch: { title: "old-stable" },
        events: [{ type: "session/created", sessionId: session.id, emittedAtMs: 10 }] }); return session;
    }, () => store.close());
  }
  async snapshot(legacyColumns = false, only?: readonly string[]) {
    const tables = await this.admin.rows("SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE BINARY TABLE_SCHEMA=BINARY ? AND TABLE_TYPE='BASE TABLE' ORDER BY BINARY TABLE_NAME", [this.database]);
    if (only) expect(tables.map(row => String(row.n))).toEqual(expect.arrayContaining([...only]));
    const result: Record<string, unknown> = {};
    for (const row of tables) {
      const name = String(row.n); if (only && !only.includes(name) || legacyColumns && name.startsWith("session_authority_")) continue;
      const columns = await this.admin.rows("SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS WHERE BINARY TABLE_SCHEMA=BINARY ? AND BINARY TABLE_NAME=BINARY ? ORDER BY ORDINAL_POSITION", [this.database, name]);
      const selected = columns.map(c => String(c.n)).filter(c => !legacyColumns || name !== "sessions" || !c.startsWith("authority_"));
      const order = await this.admin.rows("SELECT COLUMN_NAME AS n FROM information_schema.STATISTICS WHERE BINARY TABLE_SCHEMA=BINARY ? AND BINARY TABLE_NAME=BINARY ? AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX", [this.database, name]);
      const rows = await this.admin.rows(`SELECT ${selected.map(c => q(c)).join(",")} FROM ${q(this.database)}.${q(name)}${order.length ? ` ORDER BY ${order.map(c => q(String(c.n))).join(",")}` : ""}`);
      result[name] = legacyColumns && name === "schema_migrations" ? rows.filter(r => r.name !== NEW_MARKER) : rows;
    }
    return result;
  }
  async inspect(sql: string, values: readonly unknown[] = []) { return this.admin.rows(sql, values); }
  async awaitOldClosed() {
    for (;;) {
      active(this.signal); const state = await this.oldNativeState();
      if (state.threads.length === 0 && state.transactions.length === 0) return;
      await delay(20, undefined, { signal: this.signal });
    }
  }
  async awaitOldTransaction(id: number | string) {
    for (;;) {
      active(this.signal); const state = await this.oldNativeState();
      if (state.transactions.some(row => String(row.trx_mysql_thread_id) === String(id))) return state;
      await delay(20, undefined, { signal: this.signal });
    }
  }
  async oldNativeState() {
    const threads = await this.admin.rows("SELECT PROCESSLIST_ID AS id,PROCESSLIST_USER AS user FROM performance_schema.threads WHERE TYPE='FOREGROUND' AND BINARY PROCESSLIST_USER=BINARY ? ORDER BY PROCESSLIST_ID", [this.oldName]);
    const transactions = await this.admin.rows("SELECT t.trx_id,t.trx_mysql_thread_id FROM information_schema.INNODB_TRX t LEFT JOIN performance_schema.threads p ON p.PROCESSLIST_ID=t.trx_mysql_thread_id WHERE p.PROCESSLIST_ID IS NULL OR BINARY p.PROCESSLIST_USER=BINARY ? ORDER BY t.trx_id", [this.oldName]);
    return { threads, transactions };
  }
  async activate(operator?: MysqlRestoreJournalMaintenance) {
    const actual = operator ?? await this.operator(); await actual.preflightSessionAuthorityBinding();
    await actual.initializeSessionAuthorityBinding(); await actual.confirmSessionAuthorityBinding();
  }
  async proveOrdinaryWrite(session?: Session) {
    const store = await this.newStore(), subject = session ?? mkSession("retirement_new", "owner");
    if (!session) await store.createSession(subject);
    const before = await store.getSession(subject.tenantId, subject.id); if (!before) throw Error("ordinary_session_missing");
    const command = createSessionAcquireCommand({ sessionId: subject.id, principal: { tenantId: subject.tenantId, userId: subject.userId }, expectedFence: before.fenceToken,
      runnerId: "retirement-new", runnerAddr: "127.0.0.1:1", bootId: randomUUID(), acquisitionId: randomUUID(), ttlMs: 30_000 });
    const acquired = await store.sessionAuthority.acquire(command); if (!acquired.ok) throw Error("ordinary_authority_not_acquired");
    await preserveFirst(async () => {
      const usageId = newUsageId(), turnId = newId("turn"), itemId = newId("item");
      const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costCNY: 0 };
      const turn = { id: turnId, sessionId: subject.id, status: "completed" as const, stopReason: "end_turn" as const,
        seqStart: before.lastSeq + 1, steps: 1, toolCalls: 0, usage, startedAtMs: 10, completedAtMs: 11 };
      const item = { id: itemId, sessionId: subject.id, turnId, seq: 0, type: "userMessage" as const,
        status: "completed" as const, content: [{ type: "text" as const, text: "synthetic native admission witness" }], createdAtMs: 11, completedAtMs: 11 };
      await store.commit(attachSessionWriteAdmission({ sessionId: subject.id, fence: acquired.fence, turn, items: [item], sessionPatch: { title: "new-exact-writer" },
        usageEntries: [{ usageId, turnId, step: 1, provider: "fixture-no-call", model: "synthetic", createdAtMs: 11,
          usage }], events: [{ type: "turn/completed", sessionId: subject.id, turn, stopReason: "end_turn", emittedAtMs: 11 },
          { type: "item/completed", sessionId: subject.id, item, emittedAtMs: 11 }] }, acquired.proof));
      expect(await store.getItem(subject.id, itemId)).toMatchObject({ id: itemId, sessionId: subject.id, turnId });
      expect((await store.getSession(subject.tenantId, subject.id))?.title).toBe("new-exact-writer");
      const rows = await this.admin.rows(`SELECT usage_id FROM ${q(this.database)}.usage_ledger WHERE BINARY usage_id=BINARY ?`, [usageId]); expect(rows).toHaveLength(1);
      expect(await this.admin.rows(`SELECT usage_id FROM ${q(this.database)}.billing_usage_facts WHERE BINARY usage_id=BINARY ?`, [usageId])).toHaveLength(1);
    }, () => preserveFirst(async () => {
      if (!this.signal.aborted) await store.sessionAuthority.release(acquired.proof);
    }, () => store.close()));
  }
  async startOldVm(vm: string, newAccount = false) {
    const childIndex = this.runners.length + 1;
    active(this.signal); const state = await mkdtemp(join(await realpath(tmpdir()), "agent-service-old-vm-state-")); await chmod(state, 0o700);
    const runner = await this.own(OwnedOldRunner.start(vm, { MYSQL_URL: newAccount ? this.newUrl : this.oldUrl,
      MYSQL_SCHEMA_METADATA_SCHEMA: this.metadataDatabase, MYSQL_SCHEMA_METADATA_DEFINER_USER: this.definerName,
      MYSQL_SCHEMA_METADATA_DEFINER_HOST: this.host, SECRETS_MASTER_KEY: "77".repeat(32),
      BOOTSTRAP_API_KEY: "old-vm-fixture-only-key", BOOTSTRAP_TENANT_ID: "old-vm-fixture-tenant" }, state, this.signal,
      (stage, child) => emitRetirementDiagnostic(this.observe, { stage, child, childIndex,
        credentialMode: newAccount ? "current" : "legacy" })));
    this.runners.push(runner); active(this.signal); return runner;
  }
  close(successful: boolean): Promise<void> {
    return this.closing ??= (async () => {
      let first: { reason: unknown } | undefined;
      const remember = (reason: unknown) => { first ??= { reason }; };
      // Startup promises settle even if their actual resource is returned after cancellation.
      this.report("cleanup_startup_wait");
      while (this.startup.size) await Promise.allSettled([...this.startup]);
      this.report("cleanup_runner_join");
      for (const result of await Promise.allSettled(this.runners.map(r => r.close()))) if (result.status === "rejected") remember(result.reason);
      this.report("cleanup_store_join");
      for (const result of await Promise.allSettled(this.stores.map(s => s.close()))) if (result.status === "rejected") remember(result.reason);
      this.report("cleanup_raw_join");
      for (const conn of this.raw.filter(c => c !== this.admin)) try { await conn.close(); } catch (reason) { remember(reason); }
      if (successful && !first && !this.signal.aborted && this.admin) {
        this.report("cleanup_native_preflight");
        try {
          expect(await this.oldNativeState()).toEqual({ threads: [], transactions: [] });
          const identity = await this.admin.rows("SELECT @@GLOBAL.server_uuid AS uuid,DATABASE() AS db"); expect(identity).toEqual([expect.objectContaining({ uuid: this.uuid, db: "mysql" })]);
          for (;;) {
            const clients = await this.admin.rows("SELECT PROCESSLIST_ID FROM performance_schema.threads WHERE TYPE='FOREGROUND' AND (BINARY PROCESSLIST_DB IN (?,?) OR BINARY PROCESSLIST_USER IN (?,?,?))", [this.database, this.metadataDatabase, this.oldName, this.newName, this.definerName]);
            if (clients.length === 0) break;
            await delay(20, undefined, { signal: this.signal });
          }
          this.report("cleanup_drop_databases");
          await this.admin.exec(`DROP DATABASE ${q(this.metadataDatabase)}`); await this.admin.exec(`DROP DATABASE ${q(this.database)}`);
          for (const [user, hosts] of [[this.oldName, [this.host, this.extraOldHost]], [this.newName, [this.host]], [this.definerName, [this.host]]] as const)
            for (const host of hosts) await this.admin.exec(`DROP USER ${account(user, host)}`);
          expect(await this.admin.rows("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME IN (?,?)", [this.database, this.metadataDatabase])).toEqual([]);
          expect(await this.admin.rows("SELECT User FROM mysql.user WHERE BINARY User IN (?,?,?)", [this.oldName, this.newName, this.definerName])).toEqual([]);
        } catch (reason) { remember(reason); }
      }
      this.report("cleanup_admin_join");
      try { await this.admin?.close(); } catch (reason) { remember(reason); }
      if (!successful || first || this.signal.aborted) console.warn(JSON.stringify({ schema: "authority-retirement-retained-v1", database: this.database,
        metadataDatabase: this.metadataDatabase, oldAccount: this.oldName, newAccount: this.newName, serverUuid: this.uuid, attempts: this.attempts, evidenceDirectory: this.evidenceDirectory, status: "retained_or_partially_cleaned_or_unknown" }));
      const rawEvidence = this.raw.map(conn => conn.evidence());
      if (successful && !first && !this.signal.aborted) {
        expect(rawEvidence.every(v => v.opened === v.closed && v.pending === 0 && v.socketPromises === 0)).toBe(true);
        console.info(JSON.stringify({ schema: "authority-retirement-native-joined-v1", database: this.database, serverUuid: this.uuid,
          evidenceDirectory: this.evidenceDirectory, ownedConnections: rawEvidence.length, socketsOpened: rawEvidence.reduce((n, v) => n + v.opened, 0),
          socketsClosed: rawEvidence.reduce((n, v) => n + v.closed, 0), allOwnedRawJoined: true, cleanupComplete: true }));
      }
      this.report(first ? "cleanup_failed" : "cleanup_done");
      if (first) throw first.reason;
    })();
  }
}

export async function retirementCase(context: TestContext, oldDirectory: string, work: (fixture: RetirementFixture) => Promise<void>, oldVm?: string,
  observe?: RetirementDiagnostic) {
  let fixture: RetirementFixture | undefined, passed = false, failed = false, first: unknown;
  emitRetirementDiagnostic(observe, { stage: "fixture_prepare_enter" });
  try {
    fixture = await RetirementFixture.create(context, oldDirectory, oldVm, observe); fixture.report("fixture_prepare_done");
    await work(fixture); active(context.signal); passed = true;
  } catch (error) { failed = true; first = error; }
  finally {
    if (observe) emitRetirementDiagnostic(observe, { stage: "fixture_cleanup_enter", state: fixture?.diagnosticState() });
    try { await fixture?.close(passed && !failed); } catch (error) { if (!failed) { failed = true; first = error; } }
    if (observe) emitRetirementDiagnostic(observe, { stage: "fixture_cleanup_settled", state: fixture?.diagnosticState() });
  }
  if (failed) throw first;
}
