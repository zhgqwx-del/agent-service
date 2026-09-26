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
  /** SIGTERM: graceful drain */
  term: () => void;
  exited: Promise<number | null>;
}

function launch(name: string, script: string, port: number, env: Record<string, string>): Proc {
  // `node --import tsx <script>` makes the spawned process BE the server. Running the `tsx` CLI would
  // add a wrapper process, and killing the wrapper leaves the real server alive — which silently turns
  // a takeover test into a no-op (it did, until this was fixed).
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    cwd: ROOT,
    env: { ...process.env, ...env, NODE_ENV: "test" },
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
  /** replies handed out by the fake vendor, round-robin across all runners */
  script?: ScriptedReply[];
  leaseTtlMs?: number;
  leaseHoldMs?: number;
}

/**
 * Boots a real cluster: N runner processes + 1 router process, all sharing one MySQL and one Redis,
 * pointed at a local fake vendor. This is the only place the distributed invariants of design §4 can
 * actually be tested — a single process cannot exercise lease takeover.
 */
export async function startCluster(opts: ClusterOptions = {}): Promise<Cluster> {
  const count = opts.runners ?? 2;
  assertDisposableClusterTargets(MYSQL_URL, REDIS_URL, process.env.AGENT_SERVICE_ALLOW_DESTRUCTIVE_TEST_DB === "1");

  // fresh database each run so seq/fence assertions start from a known state
  const admin = await mysql.createConnection({ uri: MYSQL_URL.replace(/\/[^/]*$/, "/mysql") });
  const dbName = decodeURIComponent(new URL(MYSQL_URL).pathname.split("/").filter(Boolean).at(-1)!);
  await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
  await admin.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4`);
  await admin.end();

  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
  await redis.flushdb();

  const vendor = new FakeVendor({ cacheDialect: "deepseek" });
  if (opts.script?.length) vendor.script(...opts.script);
  const vendorUrl = await vendor.start();

  const runnerEnv = (id: string, port: number): Record<string, string> => ({
    STORE: "mysql",
    MYSQL_URL,
    REDIS_URL,
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
    DEFAULT_MODEL: "fake-model",
    LEASE_TTL_MS: String(opts.leaseTtlMs ?? 3_000),
    LEASE_HOLD_MS: String(opts.leaseHoldMs ?? 500),
    SSE_HEARTBEAT_MS: "30000",
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
    const p = launch(`runner-${i}`, "apps/agent-runner/src/main.ts", port, runnerEnv(`runner-${i}`, port));
    started.push(p);
    await waitHttp(`${p.url}/readyz`).catch((e) => abandon(new Error(`${e.message}\n${p.log.slice(-20).join("\n")}`)));
    runners.push(p);
    return p;
  };
  for (let i = 1; i <= count; i++) await spawnRunner(i);

  const routerPort = await freePort();
  const router = launch("router", "apps/agent-router/src/main.ts", routerPort, {
    ROUTER_PORT: String(routerPort),
    ROUTER_HOST: "127.0.0.1",
    RUNNERS: runners.map((r) => r.url).join(","),
    REDIS_URL,
    HEALTH_INTERVAL_MS: "300",
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
