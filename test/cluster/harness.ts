import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";
import mysql from "mysql2/promise";
import { FakeVendor, type ScriptedReply } from "@agent-service/testkit";
import { assertDisposableClusterTargets } from "./safety.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const MYSQL_URL = process.env.CLUSTER_MYSQL_URL ?? "mysql://root@127.0.0.1:3306/agent_service_cluster";
export const REDIS_URL = process.env.CLUSTER_REDIS_URL ?? "redis://127.0.0.1:6379/3";
const SECRET = "55".repeat(32);
export const INTERNAL_ROUTER_TOKEN = "cluster-internal-router-token-v1-0001";
export const TENANT_ERASURE_OPERATOR_TOKEN = "cluster-platform-operator-token-v1-0001";

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

async function waitHttp(url: string, timeoutMs = 30_000): Promise<void> {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (r.ok) return;
      last = `status ${r.status}`;
    } catch (e) {
      last = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`${url} not ready after ${timeoutMs}ms (${last})`);
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
}

function launch(
  name: string,
  script: string,
  port: number,
  env: Record<string, string>,
  options: { runner?: boolean } = {},
): Proc {
  // `node --import tsx <script>` makes the spawned process BE the server. Running the `tsx` CLI would
  // add a wrapper process, and killing the wrapper leaves the real server alive — which silently turns
  // a takeover test into a no-op (it did, until this was fixed).
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, NODE_ENV: "test" };
  if (options.runner) {
    delete childEnv.TENANT_ERASURE_OPERATOR_TOKEN;
    delete childEnv.TENANT_ERASURE_OPERATOR_ID;
  }
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
  };
}

export interface Cluster {
  runners: Proc[];
  router: Proc;
  vendor: FakeVendor;
  redis: Redis;
  /** start one more runner mid-test */
  addRunner: () => Promise<Proc>;
  stop: () => Promise<void>;
  logs: () => string[];
}

export interface ClusterOptions {
  runners?: number;
  /** Keep an existing disposable database for restart/rollout tests; defaults to a fresh database. */
  resetDatabase?: boolean;
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
  const erasureWorkerEnabled = opts.erasureWorkerEnabled === true
    || opts.dataErasureRequestsEnabled === true;
  const legacyTombstoneCompensationEnabled = opts.legacyTombstoneCompensationEnabled
    ?? (
      erasureWorkerEnabled
      || opts.erasureWorkerEnabledForRunner !== undefined
      || opts.dataErasureRequestsEnabledForRunner !== undefined
    );
  assertDisposableClusterTargets(MYSQL_URL, REDIS_URL, process.env.AGENT_SERVICE_ALLOW_DESTRUCTIVE_TEST_DB === "1");

  // Most tests start fresh; rollout/restart tests can deliberately reopen the same disposable DB.
  const admin = await mysql.createConnection({ uri: MYSQL_URL.replace(/\/[^/]*$/, "/mysql") });
  const dbName = decodeURIComponent(new URL(MYSQL_URL).pathname.split("/").filter(Boolean).at(-1)!);
  if (opts.resetDatabase !== false) {
    await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await admin.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4`);
  }
  await admin.end();

  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
  await redis.flushdb();

  const vendor = new FakeVendor({ cacheDialect: "deepseek" });
  if (opts.script?.length) vendor.script(...opts.script);
  const vendorUrl = await vendor.start();

  // Allocate the control-plane address before any runner starts so every process receives one
  // immutable router origin. The router itself still starts after the runner list is complete.
  const routerPort = await freePort();
  const routerUrl = `http://127.0.0.1:${routerPort}`;
  const redisPrefix = opts.redisPrefix ?? "as";
  const redisNamespaceId = opts.redisNamespaceId ?? "agent-service-cluster-db3";

  const runnerEnv = (id: string, port: number, runnerNumber: number): Record<string, string> => ({
    STORE: "mysql",
    MYSQL_URL,
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
  /** Everything started so far, so a failure part-way through can still be cleaned up. */
  const started: Proc[] = [];
  const abandon = async (reason: Error): Promise<never> => {
    for (const p of started) p.kill();
    await Promise.all(started.map((p) => p.exited)).catch(() => {});
    await vendor.stop().catch(() => {});
    await redis.quit().catch(() => {});
    throw reason;
  };
  const spawnRunner = async (i: number): Promise<Proc> => {
    const port = await freePort();
    const p = launch(
      `runner-${i}`,
      "apps/agent-runner/src/main.ts",
      port,
      runnerEnv(`runner-${i}`, port, i),
      { runner: true },
    );
    started.push(p);
    await waitHttp(`${p.url}/readyz`).catch((e) => abandon(new Error(`${e.message}\n${p.log.slice(-20).join("\n")}`)));
    runners.push(p);
    return p;
  };
  for (let i = 1; i <= count; i++) await spawnRunner(i);

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
    TENANT_REDIS_PURGE_ENABLED: opts.tenantRedisPurgeEnabled ? "1" : "0",
    TENANT_RUNTIME_DRAIN_EXECUTION_ENABLED:
      opts.tenantRuntimeDrainExecutionEnabled ? "1" : "0",
    TENANT_ERASURE_OPERATOR_TOKEN,
    TENANT_ERASURE_OPERATOR_ID: "cluster-platform-operator",
  });
  started.push(router);
  await waitHttp(`${router.url}/readyz`).catch((e) => abandon(new Error(`${e.message}\n${router.log.slice(-20).join("\n")}`)));

  const cluster: Cluster = {
    runners,
    router,
    vendor,
    redis,
    addRunner: () => spawnRunner(runners.length + 1),
    logs: () => [...runners.flatMap((r) => r.log), ...router.log],
    stop: async () => {
      for (const p of [router, ...runners]) p.kill();
      await Promise.all([router.exited, ...runners.map((r) => r.exited)]);
      await vendor.stop();
      await redis.quit().catch(() => {});
    },
  };
  return cluster;
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
