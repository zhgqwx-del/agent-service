import { spawn, type ChildProcess } from "node:child_process";
import { createConnection as createSocket, createServer, type Socket } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Redis } from "ioredis";
import mysql, { type Connection } from "mysql2/promise";
import { FakeVendor, type ScriptedReply } from "@agent-service/testkit";
import { MysqlSessionStore } from "../../packages/store/src/index.js";
import { prepareMysqlRuntimeFixture, witnessAbsentMysqlFixtureDatabase } from "../fixtures/mysql-runtime.mjs";
import { createMysqlAuthorityCliExecutor } from "../fixtures/mysql-authority-cli.mjs";
import { assertDisposableClusterTargets } from "./safety.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const MYSQL_URL = process.env.CLUSTER_MYSQL_URL ?? "mysql://root@127.0.0.1:3306/agent_service_cluster";
export const REDIS_URL = process.env.CLUSTER_REDIS_URL ?? "redis://127.0.0.1:6379/3";
const SECRET = "55".repeat(32);
export const INTERNAL_ROUTER_TOKEN = "cluster-internal-router-token-v1-0001";
export const TENANT_ERASURE_OPERATOR_TOKEN = "cluster-platform-operator-token-v1-0001";

const CLUSTER_OS_ENV_KEYS = [
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TZ",
  "SystemRoot",
  "WINDIR",
] as const;
const ROUTER_FORBIDDEN_RUNNER_SECRET_KEYS = new Set([
  "ADMIN_BOOTSTRAP_OUTPUT_FILE",
  "ADMIN_BOOTSTRAP_TENANT",
  "API_BASE_URL",
  "API_KEY",
  "BOOTSTRAP_API_KEY",
  "BOOTSTRAP_TENANT_ID",
  "CREDENTIAL_TARGET_EXECUTION_ADAPTER",
  "DEFAULT_MODEL",
  "PLATFORM_PROVIDER",
  "SECRETS_MASTER_KEY",
]);
const ROUTER_ALLOWED_BLOB_S3_KEYS = new Set(["BLOB_S3_BUCKET", "BLOB_S3_PREFIX"]);
const ROUTER_ALLOWED_RESTORE_JOURNAL_KEYS = new Set([
  "RESTORE_JOURNAL_NAMESPACE_SHA256",
  "RESTORE_JOURNAL_RUNTIME_EPOCH_SHA256",
  "RESTORE_JOURNAL_TARGET_ROOT_SHA256",
]);
const ROUTER_ALLOWED_TENANT_RESTORE_JOURNAL_KEYS = new Set([
  "TENANT_RESTORE_JOURNAL_EXECUTION_ENABLED",
]);
const RUNNER_FORBIDDEN_ROUTER_OR_CLI_KEYS = new Set([
  "RESTORE_FLEET_STOPPED_ACK",
  "RESTORE_JOURNAL_NAMESPACE_SHA256",
  "RESTORE_JOURNAL_PRIMARY_ACTIVATION_ACK",
  "RESTORE_JOURNAL_RUNTIME_EPOCH_SHA256",
  "RESTORE_JOURNAL_TARGET_ROOT_SHA256",
  "RESTORE_REPLAY_PAGE_SIZE",
  "RESTORE_RUN_ID",
  "SOURCE_BACKUP_SHA256",
  "TENANT_CREDENTIAL_REVOCATION_EXECUTION_ENABLED",
  "TENANT_CREDENTIAL_TARGET_EXECUTION_ENABLED",
  "TENANT_DATABASE_PURGE_ENABLED",
  "TENANT_ERASURE_OPERATOR_ID",
  "TENANT_ERASURE_OPERATOR_TOKEN",
  "TENANT_PURGE_EXECUTION_ENABLED",
  "TENANT_REDIS_PURGE_ENABLED",
  "TENANT_RESTORE_JOURNAL_EXECUTION_ENABLED",
  "TENANT_RUNTIME_DRAIN_EXECUTION_ENABLED",
]);

export type ClusterChildRole = "runner" | "router";

function isRouterOnlyForbidden(key: string): boolean {
  return ROUTER_FORBIDDEN_RUNNER_SECRET_KEYS.has(key)
    || key.startsWith("LIFECYCLE_HOOKS_") && key !== "LIFECYCLE_HOOKS_ENABLED"
    || key.startsWith("SUBAGENTS_") && key !== "SUBAGENTS_ENABLED"
    || key.startsWith("MYSQL_")
    || key.startsWith("S3_TEST_")
    || (
      key.startsWith("TENANT_RESTORE_JOURNAL_")
      && !ROUTER_ALLOWED_TENANT_RESTORE_JOURNAL_KEYS.has(key)
    )
    || key.startsWith("AWS_")
    || key.startsWith("MINIO_ROOT_")
    || key === "BLOB_DIR"
    || (key.startsWith("BLOB_S3_") && !ROUTER_ALLOWED_BLOB_S3_KEYS.has(key))
    || (
      key.startsWith("RESTORE_JOURNAL_")
      && !ROUTER_ALLOWED_RESTORE_JOURNAL_KEYS.has(key)
    );
}

/**
 * Builds the exact environment handed to a cluster child process.
 *
 * A developer's `.env` is deliberately visible to the Vitest parent, but it must not silently
 * select an external database/object store or enable restore-journal authority in a child. Only
 * values declared by this harness (including a test's explicit runner fixture) may reintroduce
 * application configuration after inherited values have been removed.
 */
export function buildClusterChildEnv(
  inherited: NodeJS.ProcessEnv,
  explicit: Readonly<Record<string, string>>,
  role: ClusterChildRole,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of CLUSTER_OS_ENV_KEYS) {
    const value = inherited[key];
    if (value !== undefined) childEnv[key] = value;
  }
  Object.assign(childEnv, explicit);
  childEnv.NODE_ENV = "test";
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith("SCHEMA_") || key === "AGENT_SERVICE_MIGRATIONS_DIR") delete childEnv[key];
  }

  if (role === "runner") {
    for (const key of RUNNER_FORBIDDEN_ROUTER_OR_CLI_KEYS) delete childEnv[key];
  } else {
    for (const key of Object.keys(childEnv)) {
      if (isRouterOnlyForbidden(key)) delete childEnv[key];
    }
  }
  return childEnv;
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

async function waitHttp(url: string, timeoutMs = 30_000, signal?: AbortSignal, expectedBody?: string): Promise<void> {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < timeoutMs) {
    signal?.throwIfAborted();
    try {
      const r = await fetch(url, { signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(1_000)]) : AbortSignal.timeout(1_000) });
      const matches = expectedBody === undefined ? (await r.body?.cancel(), true) : await r.text() === expectedBody;
      signal?.throwIfAborted();
      if (r.ok && matches) return;
      last = r.ok ? "configured readiness count mismatch" : `status ${r.status}`;
    } catch (e) {
      signal?.throwIfAborted();
      last = (e as Error).message;
    }
    await delay(150, undefined, { signal });
  }
  throw new Error(`${url} not ready after ${timeoutMs}ms (${last})`);
}

/** The preparation connection owns its stream before connect, including late abort/failure. */
async function withClusterAdmin(signal: AbortSignal, work: (query: (sql: string) => Promise<void>) => Promise<void>): Promise<void> {
  signal.throwIfAborted();
  const sockets = new Set<Socket>(), closes = new Set<Promise<void>>(), failures: unknown[] = [];
  let connection: Connection | undefined;
  const destroy = () => {
    try { connection?.destroy(); } catch (error) { failures.push(error); }
    for (const socket of sockets) socket.destroy();
  };
  const stream = ({ config }: { config: { socketPath?: string; host: string; port: number } }) => {
    const socket = config.socketPath ? createSocket(config.socketPath) : createSocket({ host: config.host, port: config.port });
    sockets.add(socket);
    const closed = new Promise<void>(resolve => { socket.once("close", () => resolve()); }); closes.add(closed);
    void closed.then(() => { sockets.delete(socket); closes.delete(closed); });
    if (signal.aborted) queueMicrotask(destroy);
    return socket;
  };
  signal.addEventListener("abort", destroy, { once: true });
  let connectExpired = false;
  let timer = setTimeout(() => { connectExpired = true; destroy(); }, 10_000);
  try {
    const ownedConnection = await mysql.createConnection({ uri: MYSQL_URL.replace(/\/[^/]*$/, "/mysql"), connectTimeout: 10_000, stream });
    connection = ownedConnection;
    clearTimeout(timer); signal.throwIfAborted();
    if (connectExpired) throw new Error("cluster preparation connect expired");
    await work(async sql => {
      signal.throwIfAborted();
      let expired = false;
      const queryTimer = setTimeout(() => { expired = true; destroy(); }, 10_000);
      try {
        await ownedConnection.query({ sql, timeout: 10_000 });
        signal.throwIfAborted();
        if (expired) throw new Error("cluster preparation SQL expired");
      } finally { clearTimeout(queryTimer); }
    });
    signal.throwIfAborted();
  } catch (error) { failures.push(error); }
  finally {
    clearTimeout(timer);
    timer = setTimeout(() => { failures.push(new Error("cluster preparation close expired")); destroy(); }, 10_000);
    try { await connection?.end(); } catch (error) { failures.push(error); }
    finally {
      for (const socket of sockets) socket.destroy();
      while (closes.size) await Promise.all([...closes]);
      clearTimeout(timer); signal.removeEventListener("abort", destroy);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "cluster preparation and native close failed");
  signal.throwIfAborted();
}

async function closeClusterRedis(redis: Redis): Promise<void> {
  if (redis.status === "end") return;
  const ended = new Promise<void>(resolve => { redis.once("end", () => resolve()); });
  let failed = false, failure: unknown;
  try { await redis.quit(); }
  catch (error) { failed = true; failure = error; redis.disconnect(); }
  await ended;
  if (failed) throw failure;
}

export interface Proc {
  name: string;
  url: string;
  port: number;
  child: ChildProcess;
  log: string[];
  /** SIGKILL: simulates a crash with no chance to drain */
  kill: () => void;
  /** SIGSTOP: freezes the process while preserving its live sockets and durable leases. */
  pause: () => void;
  /** SIGCONT: resumes a process previously frozen with pause(). */
  resume: () => void;
  /** SIGTERM: graceful drain */
  term: () => void;
  exited: Promise<number | null>;
  /** Includes native stdio/socket close; exit alone is not a cleanup barrier. */
  closed: Promise<void>;
}

function launch(
  name: string,
  script: string,
  port: number,
  env: Record<string, string>,
  role: ClusterChildRole,
): Proc {
  // `node --import tsx <script>` makes the spawned process BE the server. Running the `tsx` CLI would
  // add a wrapper process, and killing the wrapper leaves the real server alive — which silently turns
  // a takeover test into a no-op (it did, until this was fixed).
  const childEnv = buildClusterChildEnv(process.env, env, role);
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    cwd: ROOT,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group, so a kill takes any grandchildren with it
  });
  const log: string[] = [];
  const collect = (buf: Buffer) => {
    for (const line of buf.toString().split("\n")) if (line.trim()) log.push(`[${name}] ${line}`);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const exited = new Promise<number | null>((res) => child.once("exit", (code) => res(code)));
  const closed = new Promise<void>((res) => child.once("close", () => res()));
  // A failed spawn still emits close; readiness owns the failure, not an unhandled event.
  child.on("error", () => {});
  const signal = (sig: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, sig); // whole group
    } catch {
      child.kill(sig);
    }
  };
  return {
    name,
    port,
    url: `http://127.0.0.1:${port}`,
    child,
    log,
    kill: () => signal("SIGKILL"),
    pause: () => signal("SIGSTOP"),
    resume: () => signal("SIGCONT"),
    term: () => signal("SIGTERM"),
    exited,
    closed,
  };
}

export interface Cluster {
  runners: Proc[];
  router: Proc;
  vendor: FakeVendor;
  redis: Redis;
  /** start one more runner mid-test */
  addRunner: () => Promise<Proc>;
  /** Replace only an actually closed owned slot, preserving its configured URL and runner id. */
  restartRunner: (original: Proc) => Promise<Proc>;
  mysqlRuntime: Awaited<ReturnType<typeof prepareMysqlRuntimeFixture>>;
  stop: (options?: { successful?: boolean; retainMysqlRuntime?: boolean }) => Promise<void>;
  logs: () => string[];
}

export interface ClusterOptions {
  /** Actual Vitest cancellation; omitted callers retain the original startup deadlines. */
  signal?: AbortSignal;
  runners?: number;
  /** Explicit per-case MySQL bootstrap budget; omitted callers keep 25 seconds. */
  mysqlPreparationTimeoutMs?: 25_000 | 35_000;
  /** Keep an existing disposable database for restart/rollout tests; defaults to a fresh database. */
  resetDatabase?: boolean;
  /** Required for an explicit same-database restart; never reconstruct or re-prepare from a URL. */
  mysqlRuntime?: Awaited<ReturnType<typeof prepareMysqlRuntimeFixture>>;
  /** replies handed out by the fake vendor, round-robin across all runners */
  script?: ScriptedReply[];
  leaseTtlMs?: number;
  leaseHoldMs?: number;
  /** Enables both runner admission and the router fleet gate; implies the durable worker. */
  dataErasureRequestsEnabled?: boolean;
  /** Enables the independent platform tenant-admission gate on router and every runner. */
  tenantErasureRequestsEnabled?: boolean;
  /** Activates the router's T3a execution barrier; independent from tenant admission. */
  tenantCredentialRevocationExecutionEnabled?: boolean;
  /** Runs the local-database credential revocation worker on every runner. */
  tenantCredentialRevocationWorkerEnabled?: boolean;
  /** Activates the router's exact-namespace T3g Redis deletion barrier. */
  tenantRedisPurgeEnabled?: boolean;
  /** Runs the Redis lease/fence/stream purge worker on every runner. */
  tenantRedisPurgeWorkerEnabled?: boolean;
  /** Non-secret logical identity shared by the router and Redis-purge-capable runners. */
  redisNamespaceId?: string;
  /** Redis key prefix shared by the router and runners. */
  redisPrefix?: string;
  /** Activates the router's all-configured T3b broadcast gate. */
  tenantRuntimeDrainExecutionEnabled?: boolean;
  /** Activates each runner's private process-local T3b endpoint. */
  tenantRuntimeDrainEnabled?: boolean;
  /** Runs the durable erasure worker without necessarily accepting new requests. */
  erasureWorkerEnabled?: boolean;
  /**
   * Runs the generation-zero compensation worker and advertises the v2 claim barrier contract.
   * Defaults on for the whole configured fleet whenever erasure orchestration is requested.
   */
  legacyTombstoneCompensationEnabled?: boolean;
  /** Fast-test worker timing; production defaults remain owned by runner config. */
  erasureWorkerPollMs?: number;
  erasureWorkerLeaseMs?: number;
  erasureWorkerRetryBaseMs?: number;
  erasureWorkerRetryMaxMs?: number;
  erasureDrainTimeoutMs?: number;
  erasureWorkerRequestTimeoutMs?: number;
  /** Per-runner non-secret overrides, useful for deterministic multi-worker races. */
  runnerEnv?: (runnerNumber: number) => Record<string, string>;
  /** Optional deterministic worker placement; defaults to the cluster-wide worker setting. */
  erasureWorkerEnabledForRunner?: (runnerNumber: number) => boolean;
  /** Optional deterministic admission placement; defaults to the cluster-wide admission gate. */
  dataErasureRequestsEnabledForRunner?: (runnerNumber: number) => boolean;
  /** Optional mixed-rollout placement for the irreversible tenant-admission barrier. */
  tenantErasureRequestsEnabledForRunner?: (runnerNumber: number) => boolean;
  /** Optional mixed-rollout placement for the T3a worker activation signal. */
  tenantCredentialRevocationWorkerEnabledForRunner?: (runnerNumber: number) => boolean;
  /** Optional mixed-rollout placement for the T3g worker activation signal. */
  tenantRedisPurgeWorkerEnabledForRunner?: (runnerNumber: number) => boolean;
  /** Optional mixed-rollout placement for the private T3b endpoint. */
  tenantRuntimeDrainEnabledForRunner?: (runnerNumber: number) => boolean;
  /** Optional mixed-rollout placement; a disabled configured target intentionally blocks v2 claims. */
  legacyTombstoneCompensationEnabledForRunner?: (runnerNumber: number) => boolean;
  /** Extra stable targets configured only on the router, used to exercise mixed/failed rollout. */
  additionalRunnerUrls?: string[];
}

/**
 * Boots a real cluster: N runner processes + 1 router process, all sharing one MySQL and one Redis,
 * pointed at a local fake vendor. This is the only place the distributed invariants of design §4 can
 * actually be tested — a single process cannot exercise lease takeover.
 */
export async function startCluster(opts: ClusterOptions = {}): Promise<Cluster> {
  const count = opts.runners ?? 2;
  const preparationTimeoutMs = opts.mysqlPreparationTimeoutMs;
  if (preparationTimeoutMs !== undefined && preparationTimeoutMs !== 25_000 && preparationTimeoutMs !== 35_000) {
    throw new Error("invalid cluster MySQL preparation timeout");
  }
  const erasureWorkerEnabled = opts.erasureWorkerEnabled === true
    || opts.dataErasureRequestsEnabled === true;
  const legacyTombstoneCompensationEnabled = opts.legacyTombstoneCompensationEnabled
    ?? (
      erasureWorkerEnabled
      || opts.erasureWorkerEnabledForRunner !== undefined
      || opts.dataErasureRequestsEnabledForRunner !== undefined
    );
  assertDisposableClusterTargets(MYSQL_URL, REDIS_URL, process.env.AGENT_SERVICE_ALLOW_DESTRUCTIVE_TEST_DB === "1");
  const signal = opts.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const begunAt = performance.now(), started: Proc[] = [], readiness = new Set<Promise<void>>();
  const readinessCancelled = new AbortController();
  let phase = "preparation", admissionClosed = false, firstReadinessFailure: unknown, readinessFailed = false;
  let ownedRedis: Redis | undefined, ownedVendor: FakeVendor | undefined;
  let mysqlRuntime: Awaited<ReturnType<typeof prepareMysqlRuntimeFixture>> | undefined;
  let closing: Promise<void> | undefined;
  function active(): void {
    signal.throwIfAborted();
    if (admissionClosed) throw new Error("cluster startup admission is closed");
  }
  function closeAdmission(): void {
    admissionClosed = true;
    readinessCancelled.abort();
    for (const proc of started) proc.kill();
  }
  const cancelled = () => { closeAdmission(); ownedRedis?.disconnect(); };
  signal.addEventListener("abort", cancelled, { once: true });
  async function closeOwned(options: { successful?: boolean; retainMysqlRuntime?: boolean } = {}): Promise<void> {
    if (closing) return closing;
    closing = (async () => {
      closeAdmission();
      await Promise.allSettled([...readiness]);
      // Every process is registered synchronously before any readiness await, including failures.
      await Promise.all(started.map(proc => proc.closed));
      const failures: unknown[] = [];
      try { await ownedVendor?.stop(); } catch (error) { failures.push(error); }
      if (ownedRedis) { try { await closeClusterRedis(ownedRedis); } catch (error) { failures.push(error); } }
      if (mysqlRuntime && !options.retainMysqlRuntime) {
        try { await mysqlRuntime.close({ successful: options.successful === true && !signal.aborted && failures.length === 0 }); }
        catch (error) { failures.push(error); }
      }
      signal.removeEventListener("abort", cancelled);
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, "cluster native cleanup failed");
    })();
    return closing;
  }
  async function allocatePort(): Promise<number> {
    active(); const port = await freePort(); active(); return port;
  }
  function ready(proc: Proc, expectedBody?: string): Promise<void> {
    const childClosed = new AbortController();
    void proc.closed.then(() => childClosed.abort(new Error("cluster child closed before readiness")));
    const task = waitHttp(proc.url + "/readyz", 30_000,
      AbortSignal.any([signal, readinessCancelled.signal, childClosed.signal]), expectedBody).catch(error => {
        if (!readinessFailed) { readinessFailed = true; firstReadinessFailure = error; }
        closeAdmission();
        throw error;
      });
    readiness.add(task);
    void task.then(() => readiness.delete(task), () => readiness.delete(task));
    return task;
  }

  try {
    // Most tests start fresh; rollout/restart tests reopen only the original prepared handle.
    const dbName = decodeURIComponent(new URL(MYSQL_URL).pathname.split("/").filter(Boolean).at(-1)!);
    if (opts.resetDatabase === false) {
      if (!opts.mysqlRuntime) throw new Error("cluster restart requires the original prepared MySQL runtime handle");
      mysqlRuntime = opts.mysqlRuntime;
      await mysqlRuntime.assertReusable(MYSQL_URL); active();
    } else {
      if (opts.mysqlRuntime) throw new Error("fresh cluster cannot reuse or re-prepare a MySQL runtime handle");
      let timerFired = false, preparationFailureRecorded = false;
      let lastPreparationPhase = "admin-open";
      const preparation = new AbortController(), timer = setTimeout(() => { timerFired = true; preparation.abort(); }, preparationTimeoutMs ?? 25_000);
      const preparationSignal = AbortSignal.any([signal, preparation.signal]);
      const observePreparation = <T>(work: () => Promise<T>, phases: readonly [string, string, string]): Promise<T> => {
        lastPreparationPhase = phases[0];
        let original: Promise<T>;
        try { original = work(); }
        catch (error) { lastPreparationPhase = phases[2]; throw error; }
        try {
          void original.then(() => { lastPreparationPhase = phases[1]; }, () => { lastPreparationPhase = phases[2]; });
        } catch {} // Observation cannot replace the original operation or its error.
        return original;
      };
      const recordPreparationFailure = (catchSite: "admin-work-before-cleanup" | "admin-settled-fallback"): void => {
        if (preparationFailureRecorded) return;
        preparationFailureRecorded = true;
        try { console.warn(JSON.stringify({ schema: "cluster-mysql-preparation-diagnostic-v1", catchSite,
          phase: lastPreparationPhase, elapsedMs: Math.round(performance.now() - begunAt), timerFired,
          preparationSignalAborted: preparation.signal.aborted, caseSignalAborted: signal.aborted })); } catch {}
      };
      try {
        await withClusterAdmin(preparationSignal, async query => {
          try {
            lastPreparationPhase = "drop-database";
            await query(`DROP DATABASE IF EXISTS \`${dbName}\``);
            lastPreparationPhase = "witness-absence";
            const witness = await witnessAbsentMysqlFixtureDatabase({ operatorUrl: MYSQL_URL, applicationDatabase: dbName,
              operationAbortSignal: preparationSignal });
            preparationSignal.throwIfAborted();
            lastPreparationPhase = "create-database";
            await query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4`);
            lastPreparationPhase = "authority-executor-configuration";
            const authorityExecutor = createMysqlAuthorityCliExecutor({
              entrypoint: resolve(ROOT, "apps/agent-runner/src/main.ts"), mode: "source", cwd: ROOT,
            });
            lastPreparationPhase = "prepare-fixture";
            mysqlRuntime = await prepareMysqlRuntimeFixture(witness, {
              schemaExecutor: options => {
                const phases = options.operation === "migrate"
                  ? ["schema-migrate-entered", "schema-migrate-fulfilled", "schema-migrate-rejected"] as const
                  : options.operation === "install-metadata"
                    ? ["schema-install-metadata-entered", "schema-install-metadata-fulfilled", "schema-install-metadata-rejected"] as const
                    : options.operation === "verify"
                      ? ["schema-verify-entered", "schema-verify-fulfilled", "schema-verify-rejected"] as const
                      : ["schema-unknown-entered", "schema-unknown-fulfilled", "schema-unknown-rejected"] as const;
                return observePreparation(() => MysqlSessionStore.runSchemaOperation(options), phases);
              },
              authorityExecutor: options => observePreparation(() => authorityExecutor(options),
                ["authority-activate-entered", "authority-activate-fulfilled", "authority-activate-rejected"]),
            });
          } catch (error) {
            recordPreparationFailure("admin-work-before-cleanup");
            throw error;
          }
        });
      } catch (error) {
        recordPreparationFailure("admin-settled-fallback");
        throw error;
      } finally { clearTimeout(timer); }
      active();
    }
    if (!mysqlRuntime) throw new Error("cluster prepared MySQL runtime is missing");
    const preparedMysqlRuntime = mysqlRuntime;

    phase = "redis";
    const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 }); ownedRedis = redis;
    active(); await redis.flushdb(); active();

    phase = "vendor";
    const vendor = new FakeVendor({ cacheDialect: "deepseek" }); ownedVendor = vendor;
    if (opts.script?.length) vendor.script(...opts.script);
    active(); const vendorUrl = await vendor.start(); active();

    // Every runner receives one immutable router origin, even before the router is listening.
    const routerPort = await allocatePort();
    const routerUrl = `http://127.0.0.1:${routerPort}`;
    const redisPrefix = opts.redisPrefix ?? "as";
    const redisNamespaceId = opts.redisNamespaceId ?? "agent-service-cluster-db3";

    const runnerEnv = (id: string, port: number, runnerNumber: number): Record<string, string> => ({
      STORE: "mysql",
      REDIS_URL,
      REDIS_PREFIX: redisPrefix,
      REDIS_NAMESPACE_ID: redisNamespaceId,
      RUNNER_ID: id,
      RUNNER_PORT: String(port),
      RUNNER_HOST: "127.0.0.1",
      RUNNER_ADDR: `127.0.0.1:${port}`,
      SECRETS_MASTER_KEY: SECRET,
      BOOTSTRAP_API_KEY: "cluster-key",
      BOOTSTRAP_TENANT_ID: "t_cluster",
      PLATFORM_PROVIDER: "deepseek",
      API_KEY: "sk-fake",
      API_BASE_URL: vendorUrl,
      LEASE_TTL_MS: String(opts.leaseTtlMs ?? 3_000),
      LEASE_HOLD_MS: String(opts.leaseHoldMs ?? 500),
      SSE_HEARTBEAT_MS: "30000",
      ERASURE_WORKER_POLL_MS: String(opts.erasureWorkerPollMs ?? 100),
      ERASURE_WORKER_LEASE_MS: String(opts.erasureWorkerLeaseMs ?? 2_000),
      ERASURE_WORKER_RETRY_BASE_MS: String(opts.erasureWorkerRetryBaseMs ?? 100),
      ERASURE_WORKER_RETRY_MAX_MS: String(opts.erasureWorkerRetryMaxMs ?? 1_000),
      ERASURE_DRAIN_TIMEOUT_MS: String(opts.erasureDrainTimeoutMs ?? 250),
      ERASURE_WORKER_REQUEST_TIMEOUT_MS: String(opts.erasureWorkerRequestTimeoutMs ?? 2_000),
      ...opts.runnerEnv?.(runnerNumber),
      // Every initial/replacement process uses the same already-prepared runtime identity.
      // Custom tuning cannot replace it with the operator account or a migration fallback.
      ...preparedMysqlRuntime.runtimeEnv,
      // Security/activation values are intentionally applied after custom test tuning. Every process
      // in one cluster must share the same private credential and router origin.
      INTERNAL_ROUTER_TOKEN,
      ERASURE_WORKER_ENABLED: (
        opts.erasureWorkerEnabledForRunner?.(runnerNumber) ?? erasureWorkerEnabled
      ) ? "1" : "0",
      LEGACY_TOMBSTONE_COMPENSATION_ENABLED: (
        opts.legacyTombstoneCompensationEnabledForRunner?.(runnerNumber)
          ?? legacyTombstoneCompensationEnabled
      ) ? "1" : "0",
      ERASURE_ROUTER_URL: routerUrl,
      DATA_ERASURE_REQUESTS_ENABLED: (
        opts.dataErasureRequestsEnabledForRunner?.(runnerNumber)
          ?? opts.dataErasureRequestsEnabled === true
      ) ? "1" : "0",
      TENANT_ERASURE_REQUESTS_ENABLED: (
        opts.tenantErasureRequestsEnabledForRunner?.(runnerNumber)
          ?? opts.tenantErasureRequestsEnabled === true
      ) ? "1" : "0",
      TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED: (
        opts.tenantCredentialRevocationWorkerEnabledForRunner?.(runnerNumber)
          ?? opts.tenantCredentialRevocationWorkerEnabled === true
      ) ? "1" : "0",
      CREDENTIAL_LIFECYCLE_TRACKING_ENABLED: (
        opts.tenantCredentialRevocationWorkerEnabled === true
        || opts.tenantCredentialRevocationExecutionEnabled === true
        || opts.tenantCredentialRevocationWorkerEnabledForRunner !== undefined
      ) ? "1" : "0",
      TENANT_REDIS_PURGE_WORKER_ENABLED: (
        opts.tenantRedisPurgeWorkerEnabledForRunner?.(runnerNumber)
          ?? opts.tenantRedisPurgeWorkerEnabled === true
      ) ? "1" : "0",
      TENANT_RUNTIME_DRAIN_ENABLED: (
        opts.tenantRuntimeDrainEnabledForRunner?.(runnerNumber)
          ?? opts.tenantRuntimeDrainEnabled === true
      ) ? "1" : "0",
      TENANT_ERASURE_BARRIER_TIMEOUT_MS: "2000",
    });
    const runners: Proc[] = [];
    function launchRunner(i: number, port: number): Proc {
      active();
      const proc = launch("runner-" + i, "apps/agent-runner/src/main.ts", port,
        runnerEnv("runner-" + i, port, i), "runner");
      started.push(proc); runners.push(proc);
      return proc;
    }
    phase = "first-runner";
    // Preserve the original first bootstrap: no second process starts until its COMMIT/readiness.
    if (count > 0) {
      const firstRunner = launchRunner(1, await allocatePort());
      await ready(firstRunner); active();
    }

    phase = "remaining-runners-and-router";
    const remainingPorts: number[] = [];
    for (let i = 2; i <= count; i++) remainingPorts.push(await allocatePort());
    for (let i = 2; i <= count; i++) launchRunner(i, remainingPorts[i - 2]!);
    active();
    const router = launch("router", "apps/agent-router/src/main.ts", routerPort, {
      ROUTER_PORT: String(routerPort),
      SESSION_TOMBSTONE_ENABLED: "1",
      ROUTER_HOST: "127.0.0.1",
      RUNNERS: [
        ...runners.map((r) => r.url),
        ...(opts.additionalRunnerUrls ?? []),
      ].join(","),
      REDIS_URL,
      REDIS_PREFIX: redisPrefix,
      REDIS_NAMESPACE_ID: redisNamespaceId,
      HEALTH_INTERVAL_MS: "300",
      UPSTREAM_HEADER_TIMEOUT_MS: erasureWorkerEnabled ? "1000" : "15000",
      INTERNAL_ROUTER_TOKEN,
      DATA_ERASURE_REQUESTS_ENABLED: opts.dataErasureRequestsEnabled ? "1" : "0",
      TENANT_ERASURE_REQUESTS_ENABLED: opts.tenantErasureRequestsEnabled ? "1" : "0",
      TENANT_CREDENTIAL_REVOCATION_EXECUTION_ENABLED:
        opts.tenantCredentialRevocationExecutionEnabled ? "1" : "0",
      CREDENTIAL_LIFECYCLE_TRACKING_ENABLED:
        opts.tenantCredentialRevocationExecutionEnabled ? "1" : "0",
      TENANT_REDIS_PURGE_ENABLED: opts.tenantRedisPurgeEnabled ? "1" : "0",
      TENANT_RUNTIME_DRAIN_EXECUTION_ENABLED:
        opts.tenantRuntimeDrainExecutionEnabled ? "1" : "0",
      TENANT_ERASURE_OPERATOR_TOKEN,
      TENANT_ERASURE_OPERATOR_ID: "cluster-platform-operator",
    }, "router");
    started.push(router);
    // The configured list is already complete. Only startup work overlaps; readiness is not waived.
    const outcomes = await Promise.allSettled([...runners.slice(1).map(proc => ready(proc)),
      ready(router, `ready (${runners.length + (opts.additionalRunnerUrls?.length ?? 0)} runners)`)]);
    if (outcomes.some(outcome => outcome.status === "rejected")) throw firstReadinessFailure;
    active();
    const cluster: Cluster = {
      runners, router, vendor, redis, mysqlRuntime: preparedMysqlRuntime,
      addRunner: async () => {
        try {
          const proc = launchRunner(runners.length + 1, await allocatePort());
          await ready(proc); active(); return proc;
        } catch (error) {
          try { await closeOwned({ successful: false }); }
          catch (cleanup) { throw new AggregateError([error, cleanup], "cluster additional runner and cleanup failed"); }
          throw error;
        }
      },
      restartRunner: async original => {
        const index = runners.indexOf(original);
        if (index < 0 || !started.includes(original)
          || original.child.exitCode === null && original.child.signalCode === null) throw new Error("cluster replacement requires a closed owned runner");
        await original.closed; active();
        try {
          const replacement = launchRunner(index + 1, original.port);
          // launchRunner already registered native ownership synchronously. Keep the exact fleet URL
          // set and logical slot count; the old native process remains in started for final cleanup.
          if (runners.pop() !== replacement) throw new Error("cluster replacement slot mismatch");
          runners[index] = replacement;
          await ready(replacement); active(); return replacement;
        } catch (error) {
          try { await closeOwned({ successful: false }); }
          catch (cleanup) { throw new AggregateError([error, cleanup], "cluster replacement and cleanup failed"); }
          throw error;
        }
      },
      logs: () => [...runners.flatMap(proc => proc.log), ...router.log],
      stop: closeOwned,
    };
    phase = "ready";
    return cluster;
  } catch (error) {
    // Never append child stdout/stderr: it can contain test credentials. Preserve the real error.
    try { console.warn(JSON.stringify({ schema: "cluster-startup-failure-v1", phase, elapsedMs: Math.round(performance.now() - begunAt) })); }
    catch { /* Diagnostics cannot prevent native cleanup or replace the original failure. */ }
    try { await closeOwned({ successful: false }); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "cluster startup and cleanup failed"); }
    throw error;
  }
}

// ---------- client helpers ----------

export const H = {
  authorization: "Bearer cluster-key",
  "x-user-id": "u_cluster",
  "content-type": "application/json",
};

export async function api<T = unknown>(base: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: T; headers: Headers }> {
  const res = await fetch(`${base}${path}`, { ...init, headers: { ...H, ...(init.headers as Record<string, string> | undefined) } });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: (text ? JSON.parse(text) : undefined) as T };
}

export interface SseEvent {
  event: string;
  id?: number;
  data: Record<string, unknown>;
}

/** Open an SSE stream and hand back a live list of parsed events plus a cancel function. */
export function openSse(base: string, path: string, init: RequestInit = {}) {
  const events: SseEvent[] = [];
  const ac = new AbortController();
  const done = (async () => {
    const res = await fetch(`${base}${path}`, { ...init, headers: { ...H, ...(init.headers as Record<string, string> | undefined) }, signal: ac.signal });
    if (!res.body) return { status: res.status, events };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done: fin, value } = await reader.read();
        if (fin) break;
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1];
          const id = /^id: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (ev && data) events.push({ event: ev, id: id ? Number(id) : undefined, data: JSON.parse(data) });
        }
      }
    } catch {
      /* aborted or connection dropped: the caller asserts on what arrived */
    }
    return { status: res.status, events };
  })();
  return { events, cancel: () => ac.abort(), done };
}

export async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 15_000, label = "condition"): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for ${label}`);
}

export async function queryDb<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const conn = await mysql.createConnection({ uri: MYSQL_URL });
  try {
    const [rows] = await conn.query(sql, params);
    return rows as T[];
  } finally {
    await conn.end();
  }
}
