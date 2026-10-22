// Local-only measured runner load. Never discovers .env or uses a shared database/Redis namespace.
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, statfs } from "node:fs/promises";
import { createServer, createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";
import { ErrorCode, Event, isCanonicalId, providerQuotaNamespaceSha256 } from "../packages/protocol/src/index.js";
import { FakeVendor } from "../packages/testkit/src/index.js";
import { bindMysqlOperationAbort, createMysqlOperationAbortTransport } from "../packages/store/src/mysql/operation-abort.js";
import { prepareMysqlRuntimeFixture, witnessAbsentMysqlFixtureDatabase, type MysqlRuntimeFixture } from "../test/fixtures/mysql-runtime.mjs";
import { createMysqlSchemaCliExecutor } from "../test/fixtures/mysql-schema-cli.mjs";
import { deriveProviderGatewayPolicySha256, loadProviderGatewayConfig } from "../apps/agent-runner/src/provider-gateway-config.js";
import { RouterProviderGatewayGate } from "../apps/agent-runner/src/provider-gateway-gate.js";

interface LoadOptions { turns: number; concurrency: number; ttftMs: number; deadlineMs: number; providerGateway?: true }
interface GatewayMetricScope { attempts: number; active: number; completions: Record<string, number>;
  rejections: Record<string, number>; durationCount: number; durationSum: number }
type GatewayMetrics = Record<"platform" | "byok", GatewayMetricScope>;
interface VendorIo { requests: number; active: number; peak: number; closed: number;
  accepted: number; completed: number; aborted: number }
type Outcome = "completed" | "http_error" | "protocol_error" | "deadline" | "transport_error";
interface TrackerReport {
  turns: number; concurrency: number; scheduled: number; started: number; terminal: number;
  completed: number; failed: number; inFlight: number; activePeak: number;
  outcomes: Record<Outcome, number>;
  startLatencyMs: { p50: number | null; p95: number | null; p99: number | null };
  completionLatencyMs: { p50: number | null; p95: number | null; p99: number | null };
  elapsedMs: number; throughputPerSecond: number; targetConcurrencyMet: boolean;
}
interface Tracker {
  schedule(index: number, atMs: number): void;
  started(index: number, atMs: number): void;
  terminal(index: number, result: { atMs: number; outcome: Outcome }): void;
  report(atMs: number): TrackerReport;
}
interface LoadApi {
  parseRunnerLoadArgs(args: unknown): LoadOptions | { help: true };
  createRunnerLoadTracker(options: { turns: number; concurrency: number; startedAtMs: number }): Tracker;
  createRunnerLoadSseDecoder(): { feed(bytes: Uint8Array): { event: string; data: unknown }[];
    end(): { event: string; data: unknown }[] };
  parseRunnerLoadGatewayMetrics(text: string): GatewayMetrics;
}
interface HttpDiagnostics {
  statusCounts: Record<string, number>;
  errorCodeCounts: Partial<Record<ErrorCode | "unknown", number>>;
}
type Phase = "preflight" | "mysql" | "redis" | "vendor" | "runner" | "sessions" | "load" | "verify" | "cleanup";
type FailureKind = "operation_failed" | "deadline" | "cancelled" | "resource_limit" | "integrity" | "target_not_met";
class BenchmarkFailure extends Error {
  constructor(readonly kind: FailureKind) { super("runner load benchmark failed"); }
}
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = fileURLToPath(import.meta.url);
const DIST = join(ROOT, "apps/agent-runner/dist/main.js");
const ROUTER_DIST = join(ROOT, "apps/agent-router/dist/main.js");
const MIGRATIONS = join(ROOT, "apps/agent-runner/dist/migrations");
const RSS_LIMIT = 2 * 1024 * 1024 * 1024;
const exec = promisify(execFile);
const now = () => Math.floor(performance.now());
function failed(kind: FailureKind = "operation_failed"): never { throw new BenchmarkFailure(kind); }
const HELP = `Usage: benchmark-runner [--turns 1..2000] [--concurrency 1..1000]
  [--ttft-ms 1..60000] [--deadline-ms 1000..600000] [--provider-gateway]

Local-only Node 24 benchmark using the existing runner dist, a disposable MySQL database,
an owned non-persistent Redis child and the original local FakeVendor in an owned child.
Requires RUNNER_BENCH_LOCAL_ONLY_ACK=1, RUNNER_BENCH_MYSQL_ADMIN_URL (loopback mysql
administrative schema), and RUNNER_BENCH_REDIS_BINARY (trusted absolute regular executable).
Never pass database URLs or keys on the command line. Production mode is rejected. No .env is read.

--ttft-ms controls only fakeVendorTtftMs, not a latency SLO. Active peak is measured from real
turn/started to normal turn/completed, not queued requests. Start-event latency is not model TTFT.
Success also requires independent MySQL/usage/billing/event and vendor-count checks and complete
created-only cleanup. Existing dist is hashed, not claimed to match a fresh source build.
Runner RSS is bounded at 2 GiB when measurable; unavailable samples are reported honestly as null.
Private create-only reports are retained under .local-run/. No deployment or production acceptance.
--provider-gateway adds a real router dist/private fleet, platform key pool, BYOK breaker policy
and authenticated Gateway metrics. Only platform I/O capacity is assessed: private BYOK endpoints
are not permitted by the product SSRF policy. Native vendor response-close overlap is independent
of SSE/DB overlap. Source-to-build attestation remains external, never inferred from these hashes.
--help opens no database, process, release or report resources.
`;

class Budget {
  readonly started = now();
  readonly expires: number;
  readonly workExpires: number;
  readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  kind: FailureKind | undefined;
  constructor(duration: number) {
    this.expires = this.started + duration;
    this.workExpires = this.expires - Math.min(30_000, Math.max(250, Math.floor(duration / 4)));
    this.timer = setTimeout(() => this.abort("deadline"), Math.max(1, this.workExpires - now()));
    this.timer.unref();
  }
  abort(kind: FailureKind): void { this.kind ??= kind; this.controller.abort(); }
  remaining(cleanup = false): number {
    const remaining = (cleanup ? this.expires : this.workExpires) - now();
    if (remaining < 1 || !cleanup && this.controller.signal.aborted) failed(this.kind ?? "deadline");
    return remaining;
  }
  dispose(): void { clearTimeout(this.timer); }
}

function osEnv(scratch: string): Record<string, string> {
  return { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    TMPDIR: scratch, NODE_ENV: "test", NO_COLOR: "1", CI: "1" };
}
function count(value: unknown): number {
  if (typeof value !== "number" && !(typeof value === "string" && /^[0-9]{1,16}$/.test(value))) failed("integrity");
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) failed("integrity");
  return result;
}
function validateEnvironment(env: NodeJS.ProcessEnv): { adminUrl: string; redisBinary: string } {
  if (Number(process.versions.node.split(".")[0]) !== 24 || env.NODE_ENV === "production"
    || env.RUNNER_BENCH_LOCAL_ONLY_ACK !== "1") failed();
  const raw = env.RUNNER_BENCH_MYSQL_ADMIN_URL;
  const binary = env.RUNNER_BENCH_REDIS_BINARY;
  if (typeof raw !== "string" || typeof binary !== "string" || !isAbsolute(binary)
    || /[\p{Cc}\p{Cs}]/u.test(raw + binary)) failed();
  let url: URL;
  try { url = new URL(raw); } catch { return failed(); }
  if (url.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || !/^[1-9][0-9]*$/.test(url.port) || Number(url.port) > 65535
    || url.pathname !== "/mysql" || url.search !== "" || url.hash !== "") failed();
  return { adminUrl: url.toString(), redisBinary: binary };
}

async function hashRegular(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > 32 * 1024 * 1024) failed();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== before.size || after.size !== before.size || after.ino !== before.ino
      || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs) failed();
    return createHash("sha256").update(bytes).digest("hex");
  } finally { await handle.close(); }
}
async function distIdentity() {
  const directory = await lstat(MIGRATIONS);
  if (!directory.isDirectory() || directory.isSymbolicLink()) failed();
  const names = (await readdir(MIGRATIONS)).sort();
  if (names.length === 0 || names.some((name) => !/^[0-9]{4}_[a-z0-9_]+\.sql$/.test(name))) failed();
  const migrations = [];
  for (const name of names) migrations.push({ name, sha256: await hashRegular(join(MIGRATIONS, name)) });
  return { mainSha256: await hashRegular(DIST), migrationCount: migrations.length, migrations,
    migrationRootSha256: createHash("sha256").update(JSON.stringify(migrations)).digest("hex") };
}
async function sourceIdentity(budget: Budget, scratch: string) {
  const options = { cwd: ROOT, env: osEnv(scratch), timeout: Math.min(5_000, budget.remaining()),
    maxBuffer: 64 * 1024, signal: budget.controller.signal };
  const commit = (await exec("/usr/bin/git", ["rev-parse", "HEAD"], options)).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) failed();
  const dirty = await exec("/usr/bin/git", ["status", "--porcelain=v1", "--untracked-files=all"], options);
  return { sourceCommit: commit, sourceDirty: dirty.stdout !== "", sourceBuildMatch: "not-attested" as const };
}

interface SqlScope { rows(sql: string, values?: unknown[]): Promise<RowDataPacket[]>;
  execute(sql: string): Promise<void>; close(): Promise<void> }
function sqlScope(url: string, budget: Budget, cleanup = false): SqlScope {
  const controller = cleanup ? new AbortController() : budget.controller;
  const timeout = cleanup ? setTimeout(() => controller.abort(), budget.remaining(true)) : undefined;
  timeout?.unref();
  const transport = createMysqlOperationAbortTransport(controller.signal);
  const pool: Pool = mysql.createPool({ uri: url, connectionLimit: 1, connectTimeout: Math.min(5_000, budget.remaining(cleanup)),
    waitForConnections: true, supportBigNumbers: true, bigNumberStrings: false, timezone: "Z", stream: transport.stream });
  const binding = bindMysqlOperationAbort(pool, controller.signal, transport);
  return {
    async rows(sql, values = []) {
      const [rows] = await pool.query<RowDataPacket[]>({ sql, timeout: budget.remaining(cleanup) }, values);
      return rows;
    },
    async execute(sql) { await pool.query({ sql, timeout: budget.remaining(cleanup) }); },
    async close() {
      try { await binding.close(); }
      finally { if (timeout) clearTimeout(timeout); transport.close(); await transport.settled(); }
    },
  };
}

interface OwnedChild { child: ChildProcess; closed: boolean; exited: Promise<void>; forcedKill: boolean; discardedOutputBytes: number;
  credentialOutputDetected: boolean }
function launch(binary: string, args: string[], cwd: string, env: Record<string, string>, ipc = false,
  sensitiveValues: readonly string[] = []): OwnedChild {
  const child = spawn(binary, args, { cwd, env, detached: true,
    stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"] });
  const owned: OwnedChild = { child, closed: false, exited: Promise.resolve(), forcedKill: false, discardedOutputBytes: 0,
    credentialOutputDetected: false };
  // Consume without retaining or printing any raw process output, including errors and credentials.
  const secrets = sensitiveValues.filter(Boolean).map(value => Buffer.from(value));
  const retainedBytes = Math.max(0, ...secrets.map(value => value.length - 1));
  const discard = () => {
    let tail = Buffer.alloc(0);
    return (bytes: Buffer) => {
      owned.discardedOutputBytes = Math.min(1024 * 1024, owned.discardedOutputBytes + bytes.length);
      const window = Buffer.concat([tail, bytes]);
      if (secrets.some(secret => window.includes(secret))) owned.credentialOutputDetected = true;
      tail = Buffer.from(window.subarray(Math.max(0, window.length - retainedBytes)));
    };
  };
  child.stdout?.on("data", discard()); child.stderr?.on("data", discard());
  child.on("error", () => {});
  owned.exited = new Promise((resolveExit) => child.once("close", () => { owned.closed = true; resolveExit(); }));
  return owned;
}
function signalChild(owned: OwnedChild, signal: NodeJS.Signals): void {
  const pid = owned.child.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1) return;
  if (!groupAlive(owned)) return;
  try { process.kill(-pid, signal); } catch { /* Never signal an unowned replacement PID. */ }
}
function groupAlive(owned: OwnedChild): boolean {
  const pid = owned.child.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1) return !owned.closed;
  try { process.kill(-pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
async function waitChild(owned: OwnedChild, milliseconds: number): Promise<boolean> {
  const until = now() + milliseconds;
  while (!owned.closed || groupAlive(owned)) {
    if (now() >= until) return false;
    await new Promise<void>(resolveWait => setTimeout(resolveWait, Math.min(20, until - now())));
  }
  return true;
}
async function stopChild(owned: OwnedChild | undefined, budget: Budget): Promise<boolean> {
  if (!owned) return true;
  if (owned.closed && !groupAlive(owned)) return !owned.forcedKill;
  signalChild(owned, "SIGTERM");
  if (await waitChild(owned, Math.min(3_000, Math.max(0, budget.expires - now())))) return true;
  owned.forcedKill = true; signalChild(owned, "SIGKILL");
  await waitChild(owned, Math.max(0, budget.expires - now()));
  return false; // A forced or unproved shutdown is failure, even if the group eventually disappears.
}
async function freePort(budget: Budget): Promise<number> {
  budget.remaining();
  const server = createServer();
  return new Promise((resolvePort, reject) => {
    server.once("error", () => reject(new BenchmarkFailure("operation_failed")));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") return server.close(() => reject(new BenchmarkFailure("operation_failed")));
      server.close(() => resolvePort(address.port));
    });
  });
}
async function pause(budget: Budget, ms = 100): Promise<void> {
  await new Promise<void>((resolvePause) => setTimeout(resolvePause, Math.min(ms, budget.remaining())));
  budget.remaining();
}
async function redisOwnedAt(port: number, pid: number, budget: Budget): Promise<boolean> {
  const remaining = budget.remaining();
  const socket = createConnection({ host: "127.0.0.1", port });
  return new Promise((resolveProbe) => {
    let bytes = Buffer.alloc(0), settled = false, result = false;
    const finish = (value: boolean) => {
      if (settled) return; settled = true; clearTimeout(timer);
      budget.controller.signal.removeEventListener("abort", abort); result = value; socket.destroy();
    };
    const abort = () => finish(false);
    const timer = setTimeout(abort, Math.min(1_000, remaining));
    budget.controller.signal.addEventListener("abort", abort, { once: true });
    socket.once("error", abort);
    socket.once("close", () => { if (!settled) finish(false); resolveProbe(result); });
    socket.once("connect", () => socket.write("*2\r\n$4\r\nINFO\r\n$6\r\nserver\r\n"));
    socket.on("data", (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 64 * 1024) return finish(false);
      const first = bytes.indexOf("\r\n");
      if (first < 0) return;
      const prefix = bytes.subarray(0, first).toString("ascii");
      if (!/^\$[0-9]{1,5}$/.test(prefix)) return finish(false);
      const length = Number(prefix.slice(1));
      if (bytes.length >= first + 2 + length + 2) {
        const body = bytes.subarray(first + 2, first + 2 + length).toString("utf8");
        finish(body.split("\r\n").includes(`process_id:${pid}`));
      }
    });
    if (budget.controller.signal.aborted) abort();
  });
}
function waitIpc(owned: OwnedChild, kind: "booted" | "ready" | "count", budget: Budget): Promise<Record<string, unknown>> {
  return new Promise((resolveMessage, reject) => {
    const done = (value?: Record<string, unknown>) => {
      clearTimeout(timer); owned.child.removeListener("message", receive); owned.child.removeListener("close", close);
      budget.controller.signal.removeEventListener("abort", close);
      if (value) resolveMessage(value); else reject(new BenchmarkFailure(budget.kind ?? "operation_failed"));
    };
    const receive = (value: unknown) => {
      if (value !== null && typeof value === "object" && !Array.isArray(value)
        && (value as Record<string, unknown>).kind === kind) done(value as Record<string, unknown>);
    };
    const close = () => done();
    const timer = setTimeout(close, budget.remaining());
    owned.child.on("message", receive); owned.child.once("close", close);
    budget.controller.signal.addEventListener("abort", close, { once: true });
    if (owned.closed || budget.controller.signal.aborted) close();
  });
}

// Private fixture mode is reachable only through a real inherited IPC channel, never public args.
async function vendorWorker(): Promise<void> {
  if (process.env.NODE_ENV !== "test" || typeof process.send !== "function") failed();
  let vendor: FakeVendor | undefined;
  let gatewayKeys: readonly string[] | undefined;
  process.on("message", (value: unknown) => { void (async () => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) failed();
    const input = value as Record<string, unknown>;
    if (input.command === "start" && ["command,ttftMs,turns", "command,gateway,ttftMs,turns"].includes(Object.keys(input).sort().join(","))
      && Number.isSafeInteger(input.turns) && Number(input.turns) >= 1 && Number(input.turns) <= 2_000
      && Number.isSafeInteger(input.ttftMs) && Number(input.ttftMs) >= 1 && Number(input.ttftMs) <= 60_000 && !vendor) {
      let beforeResponse: ((signal: AbortSignal) => Promise<void>) | undefined;
      if (input.gateway !== undefined) {
        if (!input.gateway || typeof input.gateway !== "object" || Array.isArray(input.gateway)) failed();
        const gateway = input.gateway as Record<string, unknown>;
        if (Object.keys(gateway).sort().join(",") !== "concurrency,keys" || !Number.isSafeInteger(gateway.concurrency)
          || Number(gateway.concurrency) < 1 || Number(gateway.concurrency) > Math.min(1_000, Number(input.turns))
          || !Array.isArray(gateway.keys) || gateway.keys.length !== 2
          || gateway.keys.some(key => typeof key !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(key))
          || new Set(gateway.keys).size !== 2) failed();
        gatewayKeys = gateway.keys as string[];
        let released = 0, pending: { resolve(): void; reject(): void; detach(): void }[] = [], cancelled = false;
        beforeResponse = signal => new Promise<void>((resolveBarrier, rejectBarrier) => {
          if (cancelled || signal.aborted) { rejectBarrier(new BenchmarkFailure("cancelled")); return; }
          if (released >= Number(input.turns)) { rejectBarrier(new BenchmarkFailure("integrity")); return; }
          const abort = () => {
            cancelled = true;
            const waiting = pending; pending = [];
            for (const entry of waiting) { entry.detach(); entry.reject(); }
          };
          const entry = { resolve: resolveBarrier, reject: () => rejectBarrier(new BenchmarkFailure("cancelled")),
            detach: () => signal.removeEventListener("abort", abort) };
          pending.push(entry); signal.addEventListener("abort", abort, { once: true });
          const target = Math.min(Number(gateway.concurrency), Number(input.turns) - released);
          if (pending.length === target) {
            const waiting = pending; pending = []; released += waiting.length;
            for (const current of waiting) { current.detach(); current.resolve(); }
          }
        });
      }
      vendor = new FakeVendor({ cacheDialect: "deepseek", ...(beforeResponse ? { beforeResponse } : {}) });
      for (let i = 0; i < Number(input.turns); i += 1) vendor.script({ text: "ok", ttftMs: Number(input.ttftMs),
        usage: { promptTokens: 10, completionTokens: 2, cachedTokens: 0 } });
      process.send!({ kind: "ready", origin: await vendor.start() });
    } else if (input.command === "count" && Object.keys(input).join(",") === "command" && vendor) {
      if (gatewayKeys) {
        const keyUses = gatewayKeys.map(key => vendor!.requests.filter(request => request.headers.authorization === `Bearer ${key}`).length);
        const traces = new Set<string>(); let duplicateTraceparents = 0, invalidTraceparents = 0;
        for (const request of vendor.requests) {
          const trace = request.headers.traceparent;
          if (!trace || !/^00-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{2}$/.test(trace)) invalidTraceparents++;
          else if (traces.has(trace)) duplicateTraceparents++; else traces.add(trace);
        }
        process.send!({ kind: "count", count: vendor.requests.length, io: vendor.ioSnapshot,
          keyUses, duplicateTraceparents, invalidTraceparents });
      } else process.send!({ kind: "count", count: vendor.requests.length });
    } else failed();
  })().catch(() => { process.exit(1); }); });
  process.send({ kind: "booted" });
}

async function boundedJson(response: Response): Promise<unknown> {
  return JSON.parse(await boundedText(response, 64 * 1024));
}
async function boundedText(response: Response, maximum: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) failed();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const read = await reader.read(); if (read.done) break;
      size += read.value.byteLength; if (size > maximum) failed(); chunks.push(read.value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally { await reader.cancel().catch(() => {}); }
}
async function gatewayMetrics(api: LoadApi, origin: string, token: string, budget: Budget): Promise<GatewayMetrics> {
  const response = await fetch(new URL("/metrics", origin), { redirect: "manual",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.any([budget.controller.signal, AbortSignal.timeout(Math.min(5_000, budget.remaining()))]) });
  if (response.status !== 200) { await response.body?.cancel(); failed("integrity"); }
  return api.parseRunnerLoadGatewayMetrics(await boundedText(response, 256 * 1024));
}

async function gatewayReconcile(sql: SqlScope, turns: number) {
  const rows = await sql.rows(`SELECT COUNT(*) AS entries,
    SUM(BINARY u.provider=BINARY 'platform:deepseek' AND BINARY u.model=BINARY 'deepseek-chat') AS exact_model,
    SUM((JSON_CONTAINS_PATH(u.usage_json,'one','$.costCNY')=0 AND b.cost_cny IS NULL)
      OR (JSON_TYPE(JSON_EXTRACT(u.usage_json,'$.costCNY')) IN ('INTEGER','UNSIGNED INTEGER','DOUBLE','DECIMAL')
        AND CAST(JSON_UNQUOTE(JSON_EXTRACT(u.usage_json,'$.costCNY')) AS DECIMAL(24,9))=b.cost_cny)) AS matched_cost,
    SUM(JSON_CONTAINS_PATH(u.usage_json,'one','$.costCNY')=1) AS known_cost,
    SUM(JSON_CONTAINS_PATH(u.usage_json,'one','$.costCNY')=0) AS unknown_cost
    FROM usage_ledger u JOIN billing_usage_facts b ON BINARY b.usage_id=BINARY u.usage_id
      AND BINARY b.tenant_id=BINARY u.tenant_id AND BINARY b.provider=BINARY u.provider AND BINARY b.model=BINARY u.model`);
  if (rows.length !== 1) failed("integrity");
  const counts = Object.fromEntries(Object.entries(rows[0]!).map(([key, value]) => [key, count(value)]));
  return { counts, consistent: counts.entries === turns && counts.exact_model === turns && counts.matched_cost === turns
    && (counts.known_cost ?? -1) + (counts.unknown_cost ?? -1) === turns, costEvidence: "configured-estimate-not-vendor-invoice" };
}
// Content-free projection only: never read message/details or retain an unrecognized code.
// The HTTP path supplies bounded decoded JSON; this pure boundary also refuses accessors.
export function projectRunnerLoadHttpErrorCode(value: unknown): ErrorCode | "unknown" {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return "unknown";
    const errorField = Object.getOwnPropertyDescriptor(value, "error");
    if (!errorField || !("value" in errorField)) return "unknown";
    const error: unknown = errorField.value;
    if (error === null || typeof error !== "object" || Array.isArray(error)) return "unknown";
    const codeField = Object.getOwnPropertyDescriptor(error, "code");
    if (!codeField || !("value" in codeField)) return "unknown";
    const code: unknown = codeField.value;
    const parsed = ErrorCode.safeParse(code);
    return parsed.success ? parsed.data : "unknown";
  } catch { return "unknown"; }
}
async function jsonApi(origin: string, path: string, token: string, body: unknown, budget: Budget): Promise<Record<string, unknown>> {
  budget.remaining();
  const response = await fetch(new URL(path, origin), { method: "POST", redirect: "manual",
    headers: { authorization: `Bearer ${token}`, "x-user-id": "benchmark-user", "content-type": "application/json" },
    body: JSON.stringify(body), signal: budget.controller.signal });
  if (response.status !== 201) { await response.body?.cancel(); failed(); }
  const parsed = await boundedJson(response);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) failed();
  return parsed as Record<string, unknown>;
}
async function childRss(pid: number, scratch: string): Promise<number | null> {
  try {
    let text: string;
    if (process.platform === "linux") {
      text = /^VmRSS:\s+([0-9]+)\s+kB$/m.exec(await readFile(`/proc/${pid}/status`, "utf8"))?.[1] ?? "";
    } else if (process.platform === "darwin") {
      text = (await exec("/bin/ps", ["-o", "rss=", "-p", String(pid)],
        { env: osEnv(scratch), timeout: 1_000, maxBuffer: 1024 })).stdout.trim();
    } else return null;
    if (!/^[0-9]{1,13}$/.test(text)) return null;
    const bytes = Number(text) * 1024;
    return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
  } catch { return null; }
}

async function reconcile(sql: SqlScope, turns: number) {
  const summary: Record<string, number> = {};
  const itemOwners = "FROM items i JOIN sessions s ON BINARY s.session_id=BINARY i.session_id AND BINARY s.user_id=BINARY i.user_id JOIN turns t ON BINARY t.turn_id=BINARY i.turn_id AND BINARY t.session_id=BINARY i.session_id AND BINARY t.user_id=BINARY i.user_id JOIN usage_ledger u ON BINARY u.turn_id=BINARY t.turn_id AND BINARY u.session_id=BINARY s.session_id AND BINARY u.user_id=BINARY s.user_id AND BINARY u.tenant_id=BINARY s.tenant_id WHERE i.status='completed' AND i.completed_at_ms IS NOT NULL AND t.status='completed' AND BINARY JSON_UNQUOTE(JSON_EXTRACT(i.body,'$.id'))=BINARY i.item_id AND BINARY JSON_UNQUOTE(JSON_EXTRACT(i.body,'$.sessionId'))=BINARY i.session_id AND BINARY JSON_UNQUOTE(JSON_EXTRACT(i.body,'$.turnId'))=BINARY i.turn_id AND JSON_UNQUOTE(JSON_EXTRACT(i.body,'$.status'))='completed'";
  const projections: [string, string][] = [
    ["sessions", "SELECT COUNT(*) AS n FROM sessions"],
    ["idleSessions", "SELECT COUNT(*) AS n FROM sessions WHERE JSON_UNQUOTE(JSON_EXTRACT(status,'$.type'))='idle' AND deleted_at_ms IS NULL AND JSON_EXTRACT(usage_json,'$.inputTokens')=10 AND JSON_EXTRACT(usage_json,'$.outputTokens')=2 AND JSON_EXTRACT(usage_json,'$.totalTokens')=12"],
    ["turns", "SELECT COUNT(*) AS n FROM turns"],
    ["normalCompletedTurns", "SELECT COUNT(*) AS n FROM turns WHERE status='completed' AND stop_reason='end_turn' AND completed_at_ms IS NOT NULL"],
    ["usageRows", "SELECT COUNT(*) AS n FROM usage_ledger"],
    ["billingFacts", "SELECT COUNT(*) AS n FROM billing_usage_facts WHERE input_tokens=10 AND output_tokens=2 AND total_tokens=12"],
    ["allBillingFacts", "SELECT COUNT(*) AS n FROM billing_usage_facts"],
    ["allItems", "SELECT COUNT(*) AS n FROM items"],
    ["completedUserMessages", `SELECT COUNT(*) AS n ${itemOwners} AND i.type='userMessage' AND JSON_UNQUOTE(JSON_EXTRACT(i.body,'$.type'))='userMessage' AND JSON_EXTRACT(i.body,'$.content')=JSON_ARRAY(JSON_OBJECT('type','text','text','benchmark'))`],
    ["completedAgentMessages", `SELECT COUNT(*) AS n ${itemOwners} AND i.type='agentMessage' AND JSON_UNQUOTE(JSON_EXTRACT(i.body,'$.type'))='agentMessage' AND BINARY JSON_UNQUOTE(JSON_EXTRACT(i.body,'$.text'))=BINARY 'ok' AND JSON_UNQUOTE(JSON_EXTRACT(i.body,'$.phase'))='finalAnswer'`],
    ["completeItemPairs", "SELECT COUNT(*) AS n FROM turns t JOIN (SELECT session_id,turn_id,COUNT(*) n,SUM(type='userMessage') user_n,SUM(type='agentMessage') agent_n FROM items GROUP BY session_id,turn_id) i ON BINARY i.turn_id=BINARY t.turn_id AND BINARY i.session_id=BINARY t.session_id WHERE i.n=2 AND i.user_n=1 AND i.agent_n=1"],
    ["sessionCreatedEvents", "SELECT COUNT(*) AS n FROM events WHERE type='session/created'"],
    ["startedEvents", "SELECT COUNT(*) AS n FROM events WHERE type='turn/started'"],
    ["completedEvents", "SELECT COUNT(*) AS n FROM events WHERE type='turn/completed' AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.stopReason'))='end_turn' AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.turn.status'))='completed'"],
    ["usageEvents", "SELECT COUNT(*) AS n FROM events WHERE type='usage/updated'"],
    ["contiguousSessionEvents", "SELECT COUNT(*) AS n FROM sessions s JOIN (SELECT session_id,MIN(seq) lo,MAX(seq) hi,COUNT(*) n FROM events GROUP BY session_id) e ON e.session_id=s.session_id WHERE e.lo=1 AND e.hi=e.n AND e.hi=s.last_seq"],
    ["consistentUsageBilling", "SELECT COUNT(*) AS n FROM usage_ledger u JOIN sessions s ON BINARY s.session_id=BINARY u.session_id AND BINARY s.tenant_id=BINARY u.tenant_id AND BINARY s.user_id=BINARY u.user_id JOIN turns t ON BINARY t.turn_id=BINARY u.turn_id AND BINARY t.session_id=BINARY u.session_id AND BINARY t.user_id=BINARY u.user_id JOIN billing_usage_facts b ON BINARY b.usage_id=BINARY u.usage_id AND BINARY b.tenant_id=BINARY u.tenant_id AND BINARY b.provider=BINARY u.provider AND BINARY b.model=BINARY u.model WHERE JSON_EXTRACT(u.usage_json,'$.inputTokens')=b.input_tokens AND JSON_EXTRACT(u.usage_json,'$.outputTokens')=b.output_tokens AND JSON_EXTRACT(u.usage_json,'$.totalTokens')=b.total_tokens"],
    ["consistentEvents", "SELECT COUNT(*) AS n FROM events e JOIN sessions s ON BINARY s.session_id=BINARY e.session_id AND BINARY s.user_id=BINARY e.user_id"],
    ["events", "SELECT COUNT(*) AS n FROM events"],
  ];
  for (const [name, query] of projections) {
    const rows = await sql.rows(query); if (rows.length !== 1) failed("integrity"); summary[name] = count(rows[0]!.n);
  }
  const { consistentEvents, events, allItems, ...perTurn } = summary;
  return { counts: summary, consistent: Object.values(perTurn).every((n) => n === turns)
    && allItems === 2 * turns && consistentEvents === events && (events ?? 0) > turns };
}

async function turnRequest(api: LoadApi, tracker: Tracker, index: number, sessionId: string,
  origin: string, token: string, budget: Budget, http: HttpDiagnostics): Promise<void> {
  tracker.schedule(index, now());
  let terminal = false, startedTurn: string | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const failTurn = (outcome: Outcome) => { if (!terminal) { tracker.terminal(index, { atMs: now(), outcome }); terminal = true; } };
  try {
    budget.remaining();
    const response = await fetch(new URL(`/v1/sessions/${sessionId}/turns`, origin), {
      method: "POST", redirect: "manual", headers: { authorization: `Bearer ${token}`,
        "x-user-id": "benchmark-user", "content-type": "application/json" },
      body: JSON.stringify({ input: [{ type: "text", text: "benchmark" }] }), signal: budget.controller.signal,
    });
    const status = String(response.status);
    http.statusCounts[status] = (http.statusCounts[status] ?? 0) + 1;
    if (response.status !== 200) {
      // Classify the actual HTTP failure before optional diagnostics. Bad/oversize/aborted
      // error bodies stay http_error rather than becoming a success or transport failure.
      failTurn("http_error");
      let code: ErrorCode | "unknown" = "unknown";
      try { code = projectRunnerLoadHttpErrorCode(await boundedJson(response)); } catch { /* Fixed unknown only. */ }
      http.errorCodeCounts[code] = (http.errorCodeCounts[code] ?? 0) + 1;
      return;
    }
    reader = response.body?.getReader();
    if (!reader || !response.headers.get("content-type")?.includes("text/event-stream")) {
      failTurn("protocol_error"); return;
    }
    const decoder = api.createRunnerLoadSseDecoder();
    let bytes = 0;
    while (!terminal) {
      const read = await reader.read();
      const frames = read.done ? decoder.end() : decoder.feed(read.value);
      bytes += read.value?.byteLength ?? 0;
      if (bytes > 1024 * 1024) { failTurn("protocol_error"); break; }
      for (const frame of frames) {
        const parsed = Event.safeParse(frame.data);
        if (parsed.success && parsed.data.type === "error" && parsed.data.type === frame.event && parsed.data.sessionId === sessionId) {
          const allowed = ErrorCode.safeParse(parsed.data.code), code = allowed.success ? allowed.data : "unknown";
          http.errorCodeCounts[code] = (http.errorCodeCounts[code] ?? 0) + 1;
          failTurn("protocol_error"); break;
        }
        if (!parsed.success || parsed.data.type !== frame.event || parsed.data.sessionId !== sessionId
          || (parsed.data.type !== "turn/started" && parsed.data.type !== "turn/completed")
          || parsed.data.turn.sessionId !== sessionId) { failTurn("protocol_error"); break; }
        const event = parsed.data;
        if (event.type === "turn/started") {
          if (startedTurn !== undefined || event.turn.status !== "inProgress") { failTurn("protocol_error"); break; }
          startedTurn = event.turn.id; tracker.started(index, now());
        } else {
          if (event.turn.id !== startedTurn || event.stopReason !== "end_turn"
            || event.turn.status !== "completed" || event.turn.stopReason !== "end_turn") {
            const allowed = ErrorCode.safeParse(event.turn.error?.code), code = allowed.success ? allowed.data : "unknown";
            http.errorCodeCounts[code] = (http.errorCodeCounts[code] ?? 0) + 1;
            failTurn("protocol_error"); break;
          }
          tracker.terminal(index, { atMs: now(), outcome: "completed" }); terminal = true; break;
        }
      }
      if (read.done && !terminal) failTurn("protocol_error");
    }
  } catch {
    failTurn(budget.kind === "deadline" ? "deadline" : "transport_error");
  } finally { await reader?.cancel().catch(() => {}); }
}

export async function main(args: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let api: LoadApi, options: LoadOptions, configured: { adminUrl: string; redisBinary: string };
  try {
    const imported: unknown = await import(new URL("./lib/runner-load.mjs", import.meta.url).href);
    api = imported as LoadApi;
    const parsed = api.parseRunnerLoadArgs(args);
    if ("help" in parsed) { process.stdout.write(HELP); return 0; }
    options = parsed; configured = validateEnvironment(env);
  } catch { process.stderr.write("Runner load benchmark failed (operation_failed)\n"); return 1; }
  const budget = new Budget(options.deadlineMs);
  // Keep fixture cleanup inside the existing total budget, not the earlier work-only abort.
  const fixtureAbort = new AbortController();
  const fixtureTimer = setTimeout(() => fixtureAbort.abort(), Math.max(1, budget.expires - now()));
  fixtureTimer.unref();
  const stopFixtureWork = () => fixtureAbort.abort();
  budget.controller.signal.addEventListener("abort", stopFixtureWork, { once: true });
  const cancel = () => { budget.abort("cancelled"); fixtureAbort.abort(); };
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  let phase: Phase = "preflight", failurePhase: Phase | null = null, failureKind: FailureKind | null = null;
  let scratch: string | undefined, reportDirectory: string | undefined;
  let admin: SqlScope | undefined, database: SqlScope | undefined, samplingDatabase: SqlScope | undefined;
  let mysqlRuntime: MysqlRuntimeFixture | undefined;
  const sensitiveValues = [configured.adminUrl];
  let createdDatabase = false, ambiguousDatabaseCreate = false;
  let redis: OwnedChild | undefined, runner: OwnedChild | undefined, router: OwnedChild | undefined, vendor: OwnedChild | undefined;
  let tracker: Tracker | undefined, workload: TrackerReport | null = null;
  const httpDiagnostics: HttpDiagnostics = { statusCounts: Object.create(null) as Record<string, number>, errorCodeCounts: {} };
  let provenance: (Awaited<ReturnType<typeof distIdentity>> & Awaited<ReturnType<typeof sourceIdentity>>) | null = null;
  let databaseEvidence: Awaited<ReturnType<typeof reconcile>> | null = null, vendorRequestCount: number | null = null;
  let rssPeakBytes: number | null = null, rssSamples = 0, rssTimer: ReturnType<typeof setInterval> | undefined;
  let rssInFlight: Promise<void> | undefined;
  let committedInProgressPeak = 0, committedInProgressSamples = 0, committedSamplingFailed = false;
  let committedTimer: ReturnType<typeof setInterval> | undefined, committedInFlight: Promise<void> | undefined;
  let distUnchangedAfterRun: boolean | null = null;
  let routerExited = true, routerMainSha256: string | null = null, policySha256: string | null = null;
  let privateFleetVerified = false, gatewayActivePeak = 0, gatewaySamples = 0, gatewayFinal: GatewayMetrics | null = null;
  let gatewayDatabase: Awaited<ReturnType<typeof gatewayReconcile>> | null = null;
  let vendorIo: VendorIo | null = null, vendorKeyUses: number[] | null = null;
  let duplicateTraceparents: number | null = null, invalidTraceparents: number | null = null;
  const platformKeys = options.providerGateway ? [0, 1].map(() => `bench_${randomBytes(24).toString("hex")}`) : [];
  const metricsToken = options.providerGateway ? randomBytes(32).toString("hex") : "";
  const internalToken = options.providerGateway ? randomBytes(32).toString("hex") : "";
  sensitiveValues.push(...platformKeys, metricsToken, internalToken);
  const cleanup = { runnerExited: false, redisExited: false, vendorExited: false,
    databaseCreated: false, databaseDropped: false, ambiguousDatabaseCreate: false,
    runtimeFixtureReleased: false, temporaryDirectoryRemoved: false, complete: false };
  const databaseName = `agent_service_test_bench_${randomBytes(16).toString("hex")}`;
  try {
    const binary = await lstat(configured.redisBinary);
    if (!binary.isFile() || binary.isSymbolicLink() || (binary.mode & 0o111) === 0) failed();
    const disk = await statfs(tmpdir(), { bigint: true });
    if (disk.bavail * disk.bsize < 1024n * 1024n * 1024n) failed("resource_limit");
    scratch = await mkdtemp(join(tmpdir(), "agent-service-runner-load-")); await chmod(scratch, 0o700);
    const reportsRoot = join(ROOT, ".local-run"); await mkdir(reportsRoot, { recursive: true });
    const reportsStat = await lstat(reportsRoot);
    if (!reportsStat.isDirectory() || reportsStat.isSymbolicLink()) failed();
    reportDirectory = await mkdtemp(join(reportsRoot, "runner-load-")); await chmod(reportDirectory, 0o700);
    provenance = { ...await distIdentity(), ...await sourceIdentity(budget, scratch) };
    if (options.providerGateway) routerMainSha256 = await hashRegular(ROUTER_DIST);
    phase = "mysql";
    admin = sqlScope(configured.adminUrl, budget);
    const exists = await admin.rows("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", [databaseName]);
    if (exists.length !== 0) failed("integrity");
    if (!/^agent_service_test_bench_[0-9a-f]{32}$/.test(databaseName)) failed();
    const ownUrl = new URL(configured.adminUrl); ownUrl.pathname = `/${databaseName}`;
    const witness = await witnessAbsentMysqlFixtureDatabase({ operatorUrl: ownUrl.toString(),
      applicationDatabase: databaseName, operationAbortSignal: fixtureAbort.signal });
    budget.remaining();
    ambiguousDatabaseCreate = true;
    await admin.execute(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4`);
    createdDatabase = true; ambiguousDatabaseCreate = false;
    const schemaExecutor = createMysqlSchemaCliExecutor({ entrypoint: DIST, mode: "dist", cwd: ROOT });
    mysqlRuntime = await prepareMysqlRuntimeFixture(witness, { schemaExecutor: operation => schemaExecutor({ ...operation,
      operationAbortSignal: AbortSignal.any([operation.operationAbortSignal, budget.controller.signal]) }) });
    budget.remaining();
    const runtimeUrl = new URL(mysqlRuntime.runtimeEnv.MYSQL_URL);
    sensitiveValues.push(ownUrl.toString(), runtimeUrl.toString(), runtimeUrl.password, decodeURIComponent(runtimeUrl.password));
    await mysqlRuntime.assertReusable(ownUrl.toString());
    budget.remaining();
    database = sqlScope(mysqlRuntime.runtimeEnv.MYSQL_URL, budget);
    phase = "redis";
    const redisPort = await freePort(budget), runnerPort = await freePort(budget);
    const routerPort = options.providerGateway ? await freePort(budget) : undefined;
    if (redisPort === runnerPort || routerPort === redisPort || routerPort === runnerPort) failed("integrity");
    const redisDirectory = join(scratch, "redis"); await mkdir(redisDirectory, { mode: 0o700 });
    redis = launch(configured.redisBinary, ["--bind", "127.0.0.1", "--protected-mode", "yes", "--port", String(redisPort),
      "--save", "", "--appendonly", "no", "--daemonize", "no", "--dir", redisDirectory,
      "--maxmemory", "536870912", "--maxmemory-policy", "noeviction", "--loglevel", "warning"], scratch, osEnv(scratch));
    while (!await redisOwnedAt(redisPort, redis.child.pid ?? 0, budget)) {
      if (redis.closed) failed(); await pause(budget);
    }
    phase = "vendor";
    vendor = launch(process.execPath, ["--import", "tsx", SCRIPT, "--vendor-worker"], ROOT, osEnv(scratch), true);
    await waitIpc(vendor, "booted", budget);
    const ready = waitIpc(vendor, "ready", budget);
    vendor.child.send!({ command: "start", turns: options.turns, ttftMs: options.ttftMs,
      ...(options.providerGateway ? { gateway: { concurrency: options.concurrency, keys: platformKeys } } : {}) });
    const message = await ready;
    if (Object.keys(message).sort().join(",") !== "kind,origin" || typeof message.origin !== "string") failed();
    const vendorOrigin = new URL(message.origin);
    if (vendorOrigin.protocol !== "http:" || vendorOrigin.hostname !== "127.0.0.1" || !/^[0-9]+$/.test(vendorOrigin.port)
      || vendorOrigin.pathname !== "/v1" || vendorOrigin.username !== "" || vendorOrigin.password !== ""
      || vendorOrigin.search !== "" || vendorOrigin.hash !== "") failed();
    phase = "runner";
    const token = `benchmark-${randomBytes(24).toString("hex")}`;
    const tenant = `bench_${randomBytes(12).toString("hex")}`;
    const runnerOrigin = `http://127.0.0.1:${runnerPort}`;
    const masterKey = randomBytes(32).toString("hex");
    sensitiveValues.push(token, masterKey, "benchmark-fake-key");
    let gatewayEnv: Record<string, string> = {};
    const redisEnv = { REDIS_URL: `redis://127.0.0.1:${redisPort}/0`, REDIS_PREFIX: "benchmark", REDIS_NAMESPACE_ID: "owned-benchmark" };
    const routerOrigin = `http://127.0.0.1:${routerPort}`;
    if (options.providerGateway) {
      const poolFile = join(scratch, "platform-key-pool.json");
      const inventory = { version: "provider-key-pool-v1" as const, providerId: "deepseek",
        slots: platformKeys.map((_, index) => ({ id: `slot${index + 1}`, version: "v1" })) };
      const pool = await open(poolFile, "wx", 0o600);
      try { await pool.writeFile(JSON.stringify({ ...inventory,
        slots: inventory.slots.map((slot, index) => ({ ...slot, apiKey: platformKeys[index] })) })); await pool.sync(); }
      finally { await pool.close(); }
      const limit = JSON.stringify({ rpm: options.turns, concurrency: options.concurrency });
      gatewayEnv = { PROVIDER_GATEWAY_ENABLED: "1", PROVIDER_TENANT_QUOTA_JSON: limit,
        PROVIDER_USER_QUOTA_JSON: limit, PLATFORM_PROVIDER_QUOTA_JSON: limit,
        PLATFORM_PROVIDER_KEY_POOL_FILE: poolFile, PLATFORM_PROVIDER_BREAKER_JSON: "{}", PROVIDER_BYOK_BREAKER_JSON: "{}",
        METRICS_ENABLED: "1", METRICS_BEARER_TOKEN: metricsToken, INTERNAL_ROUTER_TOKEN: internalToken,
        ERASURE_ROUTER_URL: routerOrigin };
      policySha256 = deriveProviderGatewayPolicySha256(loadProviderGatewayConfig({ ...redisEnv, ...gatewayEnv }), inventory);
      if (!policySha256) failed("integrity");
      budget.remaining();
      router = launch(process.execPath, [ROUTER_DIST], scratch, { ...osEnv(scratch), ...redisEnv,
        ROUTER_HOST: "127.0.0.1", ROUTER_PORT: String(routerPort), RUNNERS: runnerOrigin,
        // This fixture stops only after every turn/body has settled; it does not assess drain grace.
        SHUTDOWN_GRACE_MS: "0",
        INTERNAL_ROUTER_TOKEN: internalToken, PROVIDER_GATEWAY_ENABLED: "1", PROVIDER_GATEWAY_POLICY_SHA256: policySha256,
        BLOB_FILESYSTEM_SINGLE_RUNNER: "1" }, false, sensitiveValues);
      routerExited = false;
    }
    budget.remaining();
    runner = launch(process.execPath, [DIST], scratch, { ...osEnv(scratch),
      STORE: "mysql", ...mysqlRuntime.runtimeEnv, REDIS_URL: `redis://127.0.0.1:${redisPort}/0`,
      RUNNER_HOST: "127.0.0.1", RUNNER_PORT: String(runnerPort), RUNNER_ID: "benchmark-runner",
      RUNNER_ADDR: `127.0.0.1:${runnerPort}`, REDIS_PREFIX: "benchmark", REDIS_NAMESPACE_ID: "owned-benchmark",
      BLOB_DIR: join(scratch, "blobs"), BLOB_FILESYSTEM_SINGLE_RUNNER: "1", SECRETS_MASTER_KEY: masterKey,
      BOOTSTRAP_API_KEY: token, BOOTSTRAP_TENANT_ID: tenant,
      PLATFORM_PROVIDER: "deepseek", ...(options.providerGateway ? gatewayEnv : { API_KEY: "benchmark-fake-key" }), API_BASE_URL: vendorOrigin.toString(),
      LEASE_TTL_MS: "30000", LEASE_HOLD_MS: "100", SSE_HEARTBEAT_MS: "30000",
      // This owned one-tenant profile admits every selected request, including real late cleanup.
      // Ordinary deployment defaults remain smaller; neither load size nor reconciliation changes.
      SSE_MAX_CONNECTIONS: String(options.turns),
      SSE_MAX_CONNECTIONS_PER_TENANT: String(options.turns) }, false, sensitiveValues);
    const runnerForSampling = runner;
    const sample = async () => {
      if (runnerForSampling.closed || !runnerForSampling.child.pid) return;
      const bytes = await childRss(runnerForSampling.child.pid, scratch!);
      if (bytes !== null) { rssSamples += 1; rssPeakBytes = Math.max(rssPeakBytes ?? 0, bytes); if (bytes > RSS_LIMIT) budget.abort("resource_limit"); }
    };
    rssTimer = setInterval(() => { if (!rssInFlight) { rssInFlight = sample().finally(() => { rssInFlight = undefined; }); } }, 1_000);
    rssTimer.unref();
    while (true) {
      budget.remaining(); if (runner.closed) failed();
      try {
        const response = await fetch(new URL("/readyz", runnerOrigin), {
          signal: AbortSignal.any([budget.controller.signal, AbortSignal.timeout(Math.min(1_000, budget.remaining()))]) });
        const readyStatus = response.status === 200; await response.body?.cancel(); if (readyStatus) break;
      } catch { if (budget.controller.signal.aborted) failed(budget.kind ?? "deadline"); }
      await pause(budget);
    }
    if (options.providerGateway) {
      if (!policySha256) failed("integrity");
      const finalizedPolicy = policySha256;
      const gate = new RouterProviderGatewayGate({ routerBaseUrl: routerOrigin, internalToken });
      while (!privateFleetVerified) {
        budget.remaining(); if (router?.closed || runner.closed) failed();
        try {
          await gate.requireFreshFleet({ namespaceSha256: providerQuotaNamespaceSha256({ prefix: redisEnv.REDIS_PREFIX,
            namespaceId: redisEnv.REDIS_NAMESPACE_ID }), policySha256: finalizedPolicy }, budget.controller.signal);
          privateFleetVerified = true;
        } catch { await pause(budget); }
      }
      gatewayFinal = await gatewayMetrics(api, runnerOrigin, metricsToken, budget);
      if (gatewayFinal.platform.attempts !== 0 || gatewayFinal.byok.attempts !== 0) failed("integrity");
    }
    phase = "sessions";
    const agent = await jsonApi(runnerOrigin, "/v1/agents", token, { name: "benchmark", instructions: "Reply briefly.",
      model: { provider: "deepseek", model: "deepseek-chat" }, tools: [], limits: { maxSteps: 4 } }, budget);
    if (typeof agent.id !== "string" || !isCanonicalId("agt", agent.id)) failed("integrity");
    const sessions: string[] = Array(options.turns);
    let prepareIndex = 0;
    await Promise.all(Array.from({ length: Math.min(20, options.turns) }, async () => {
      while (prepareIndex < options.turns) {
        const index = prepareIndex++;
        const session = await jsonApi(runnerOrigin, "/v1/sessions", token, { agentId: agent.id }, budget);
        if (typeof session.id !== "string" || !isCanonicalId("sess", session.id)) failed("integrity");
        sessions[index] = session.id;
      }
    }));
    phase = "load";
    samplingDatabase = sqlScope(mysqlRuntime.runtimeEnv.MYSQL_URL, budget);
    const sampler = samplingDatabase;
    const sampleCommitted = async () => {
      try {
        const rows = await sampler.rows("SELECT COUNT(*) AS n FROM turns WHERE status='inProgress'");
        if (rows.length !== 1) failed("integrity");
        const observed = count(rows[0]!.n);
        committedInProgressSamples += 1;
        committedInProgressPeak = Math.max(committedInProgressPeak, observed);
        if (options.providerGateway) {
          const metrics = await gatewayMetrics(api, runnerOrigin, metricsToken, budget);
          gatewaySamples++; gatewayActivePeak = Math.max(gatewayActivePeak, metrics.platform.active);
          if (metrics.byok.attempts !== 0) failed("integrity");
        }
      } catch { committedSamplingFailed = true; budget.abort("integrity"); }
    };
    await sampleCommitted(); budget.remaining();
    committedTimer = setInterval(() => {
      if (!committedInFlight) committedInFlight = sampleCommitted().finally(() => { committedInFlight = undefined; });
    }, 100);
    committedTimer.unref();
    tracker = api.createRunnerLoadTracker({ turns: options.turns, concurrency: options.concurrency, startedAtMs: now() });
    const activeTracker = tracker;
    let next = 0;
    await Promise.all(Array.from({ length: options.concurrency }, async () => {
      while (next < sessions.length) {
        const index = next++;
        await turnRequest(api, activeTracker, index, sessions[index]!, runnerOrigin, token, budget, httpDiagnostics);
      }
    }));
    clearInterval(committedTimer); committedTimer = undefined; await committedInFlight;
    workload = tracker.report(now());
    budget.remaining();
    phase = "verify";
    databaseEvidence = await reconcile(database, options.turns);
    do {
      const countMessage = waitIpc(vendor, "count", budget); vendor.child.send!({ command: "count" });
      const reply = await countMessage;
      if (!options.providerGateway) {
        if (Object.keys(reply).sort().join(",") !== "count,kind") failed("integrity");
      } else {
        if (Object.keys(reply).sort().join(",") !== "count,duplicateTraceparents,invalidTraceparents,io,keyUses,kind"
          || !reply.io || typeof reply.io !== "object" || Array.isArray(reply.io)
          || Object.keys(reply.io).sort().join(",") !== "aborted,accepted,active,closed,completed,peak,requests"
          || !Array.isArray(reply.keyUses) || reply.keyUses.length !== 2) failed("integrity");
        const io = reply.io as Record<string, unknown>;
        vendorIo = { requests: count(io.requests), active: count(io.active), peak: count(io.peak), closed: count(io.closed),
          accepted: count(io.accepted), completed: count(io.completed), aborted: count(io.aborted) };
        vendorKeyUses = reply.keyUses.map(count);
        duplicateTraceparents = count(reply.duplicateTraceparents); invalidTraceparents = count(reply.invalidTraceparents);
      }
      vendorRequestCount = count(reply.count);
      if (vendorIo && vendorIo.active > 0) await pause(budget);
    } while (vendorIo && vendorIo.active > 0);
    distUnchangedAfterRun = JSON.stringify(await distIdentity()) === JSON.stringify({ mainSha256: provenance.mainSha256,
      migrationCount: provenance.migrationCount, migrations: provenance.migrations, migrationRootSha256: provenance.migrationRootSha256 });
    if (options.providerGateway && !databaseEvidence.consistent) {
      // Optional failure diagnostics must not present the startup zero snapshot as final state,
      // nor replace the independently established SQL failure if metrics are unavailable too.
      failurePhase = phase; failureKind = "integrity";
      gatewayFinal = null;
      try { gatewayFinal = await gatewayMetrics(api, runnerOrigin, metricsToken, budget); } catch { /* Keep null and the SQL primary. */ }
    }
    if (!databaseEvidence.consistent || vendorRequestCount !== options.turns || !distUnchangedAfterRun) failed("integrity");
    if (options.providerGateway) {
      gatewayFinal = await gatewayMetrics(api, runnerOrigin, metricsToken, budget);
      gatewayDatabase = await gatewayReconcile(database, options.turns);
      distUnchangedAfterRun = distUnchangedAfterRun && routerMainSha256 === await hashRegular(ROUTER_DIST);
      if (!distUnchangedAfterRun || !privateFleetVerified || !gatewayDatabase.consistent || !vendorIo || !vendorKeyUses
        || vendorIo.requests !== options.turns || vendorIo.accepted !== options.turns || vendorIo.completed !== options.turns
        || vendorIo.closed !== options.turns || vendorIo.active !== 0 || vendorIo.aborted !== 0
        || vendorKeyUses.reduce((a, b) => a + b, 0) !== options.turns || duplicateTraceparents !== 0 || invalidTraceparents !== 0
        || options.turns > 1 && vendorKeyUses.some(value => value === 0)
        || gatewayFinal.platform.attempts !== options.turns || gatewayFinal.platform.active !== 0
        || gatewayFinal.platform.completions.completed !== options.turns || gatewayFinal.platform.durationCount !== options.turns
        || Object.entries(gatewayFinal.platform.completions).some(([key, value]) => key !== "completed" && value !== 0)
        || Object.values(gatewayFinal.platform.rejections).some(value => value !== 0)
        || gatewayFinal.byok.attempts !== 0 || gatewayFinal.byok.active !== 0) failed("integrity");
      if (vendorIo.peak < options.concurrency || gatewaySamples === 0 || gatewayActivePeak < options.concurrency) failed("target_not_met");
    }
    if (committedSamplingFailed || committedInProgressSamples === 0) failed("integrity");
    if (!workload.targetConcurrencyMet || committedInProgressPeak < options.concurrency) failed("target_not_met");
  } catch (error) {
    failurePhase ??= phase; failureKind ??= budget.kind ?? (error instanceof BenchmarkFailure ? error.kind : "operation_failed");
  } finally {
    if (tracker && workload === null) workload = tracker.report(now());
    phase = "cleanup";
    if (rssTimer) clearInterval(rssTimer);
    if (committedTimer) clearInterval(committedTimer);
    budget.controller.signal.removeEventListener("abort", stopFixtureWork);
    budget.abort(budget.kind ?? "cancelled");
    await rssInFlight; await committedInFlight;
    // Stop all owned writers/fixture timers before touching even this invocation's database.
    [cleanup.runnerExited, routerExited] = await Promise.all([stopChild(runner, budget), stopChild(router, budget)]);
    [cleanup.redisExited, cleanup.vendorExited] = await Promise.all([stopChild(redis, budget), stopChild(vendor, budget)]);
    let mysqlConsumersClosed = true;
    for (const consumer of [samplingDatabase, database, admin]) {
      try { await consumer?.close(); }
      catch { mysqlConsumersClosed = false; failurePhase ??= "cleanup"; failureKind ??= "operation_failed"; }
    }
    if ([runner, router, vendor].some(child => child?.credentialOutputDetected)) { failurePhase ??= "verify"; failureKind ??= "integrity"; }
    const consumersStopped = cleanup.runnerExited && routerExited && cleanup.redisExited && cleanup.vendorExited && mysqlConsumersClosed;
    try {
      await mysqlRuntime?.close({ successful: failureKind === null && consumersStopped && !fixtureAbort.signal.aborted });
      cleanup.runtimeFixtureReleased = mysqlRuntime !== undefined && failureKind === null && consumersStopped && !fixtureAbort.signal.aborted;
    } catch { failurePhase ??= "cleanup"; failureKind ??= "operation_failed"; }
    cleanup.databaseCreated = createdDatabase; cleanup.ambiguousDatabaseCreate = ambiguousDatabaseCreate;
    if (failureKind === null && createdDatabase && consumersStopped && cleanup.runtimeFixtureReleased) {
      let drop: SqlScope | undefined;
      try {
        budget.remaining(true);
        drop = sqlScope(configured.adminUrl, budget, true);
        // Exact validated generated name, and only after a successful CREATE response in this run.
        if (!/^agent_service_test_bench_[0-9a-f]{32}$/.test(databaseName)) failed();
        await drop.execute(`DROP DATABASE \`${databaseName}\``);
        const rows = await drop.rows("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", [databaseName]);
        cleanup.databaseDropped = rows.length === 0;
      } catch { /* No success claim; ambiguous DDL is never described as rolled back. */ }
      finally {
        try { await drop?.close(); }
        catch { mysqlConsumersClosed = false; failurePhase ??= "cleanup"; failureKind ??= "operation_failed"; }
      }
    }
    if (failureKind === null && scratch && consumersStopped && cleanup.databaseDropped) {
      try { budget.remaining(true); await rm(scratch, { recursive: true, force: true }); cleanup.temporaryDirectoryRemoved = true; }
      catch { /* Keep the exact own scratch if safe bounded cleanup did not finish. */ }
    }
    cleanup.complete = cleanup.runnerExited && routerExited && cleanup.redisExited && cleanup.vendorExited && mysqlConsumersClosed
      && !ambiguousDatabaseCreate && (!createdDatabase || cleanup.databaseDropped)
      && (!createdDatabase || cleanup.runtimeFixtureReleased)
      && (scratch === undefined || cleanup.temporaryDirectoryRemoved);
    if (!cleanup.complete || now() >= budget.expires) {
      failurePhase ??= "cleanup"; failureKind ??= now() >= budget.expires ? "deadline" : "operation_failed";
    }
    clearTimeout(fixtureTimer); budget.dispose(); process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
  }
  const measuredWorkload = workload === null ? null : (() => {
    const { activePeak, targetConcurrencyMet, ...rest } = workload;
    return { ...rest, observedSseActivePeak: activePeak,
      observedSseTargetConcurrencyMet: targetConcurrencyMet,
      committedInProgressPeak, committedInProgressSamples, committedSamplingFailed,
      targetConcurrencyMet: targetConcurrencyMet && !committedSamplingFailed
        && committedInProgressSamples > 0 && committedInProgressPeak >= options.concurrency };
  })();
  const report = {
    schema: options.providerGateway ? "agent-service-runner-provider-gateway-load-v1" : "agent-service-runner-load-v1",
    profile: options.providerGateway ? "local-fake-vendor-dist-platform-gateway-mysql-redis" : "local-fake-vendor-dist-mysql-redis",
    status: failureKind === null ? "passed" : "failed", failurePhase, failureKind,
    configuration: { turns: options.turns, concurrency: options.concurrency, fakeVendorTtftMs: options.ttftMs, deadlineMs: options.deadlineMs },
    runtime: { node: process.versions.node, platform: process.platform, arch: process.arch },
    provenance, distUnchangedAfterRun, workload: measuredWorkload, httpDiagnostics, database: databaseEvidence, vendorRequestCount,
    ...(options.providerGateway ? { providerGateway: { enabled: true, assessedScope: "platform", byokBreakerConfigured: true,
      byokIoCapacityAssessed: false, byokIoBoundary: "private-endpoint-rejected-by-product-ssrf", fallbackCapacityAssessed: false,
      platformPoolSlots: 2, routerShutdownGraceMs: 0, shutdownAssessed: "quiesced-not-in-flight-drain",
      routerMainSha256, policySha256, privateFleetVerified,
      metrics: gatewayFinal, observedMetricsActivePeak: gatewayActivePeak, metricsSamples: gatewaySamples,
      vendorIo, vendorKeyUses, duplicateTraceparents, invalidTraceparents, database: gatewayDatabase, routerExited } } : {}),
    resources: { runnerPeakRssBytes: rssPeakBytes, rssSamples, runnerRssLimitBytes: RSS_LIMIT,
      assessment: rssSamples === 0 ? "not-measured" : (rssPeakBytes ?? 0) > RSS_LIMIT ? "limit-exceeded" : "observed-below-limit" },
    cleanup, elapsedMs: now() - budget.started, productionAccepted: false,
  };
  try {
    const reportText = JSON.stringify(report, null, 2);
    if (sensitiveValues.some(secret => secret && reportText.includes(secret))) failed("integrity");
    if (!reportDirectory) failed();
    const handle = await open(join(reportDirectory, "report.json"), "wx", 0o600);
    try { await handle.writeFile(`${reportText}\n`); await handle.sync(); } finally { await handle.close(); }
  } catch { process.stderr.write("Runner load benchmark failed (operation_failed)\n"); return 1; }
  if (failureKind !== null) { process.stderr.write("Runner load benchmark failed (operation_failed)\n"); return 1; }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return 0;
}

async function isDirectEntrypoint(): Promise<boolean> {
  try { return typeof process.argv[1] === "string" && await realpath(process.argv[1]) === await realpath(SCRIPT); }
  catch { return false; }
}
if (await isDirectEntrypoint()) {
  if (process.argv.length === 3 && process.argv[2] === "--vendor-worker" && typeof process.send === "function") {
    await vendorWorker();
  } else process.exitCode = await main();
}
