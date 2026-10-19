// CI gate: both production bundles must boot under plain Node (without tsx), and the router must
// discover and forward to the bundled runner.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanDistBootEnv } from "./lib/dist-boot-env.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MASTER_KEY = "77".repeat(32); // deterministic test-only key
const canonicalOpenApi = JSON.parse(await readFile(resolve(ROOT, "packages/protocol/openapi.json"), "utf8"));
const runnerBundleSource = await readFile(resolve(ROOT, "apps/agent-runner/dist/main.js"), "utf8");
if (/(?:from\s+|import\s*\(|require\s*\(|__require\s*\()\s*["']@aws-sdk\/client-s3(?:\/[^"']*)?["']/.test(
  runnerBundleSource,
)) {
  throw new Error("bundled runner retained a runtime @aws-sdk/client-s3 import");
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function checkSchemaMain(cwd, args) {
  // Only the actual plain-Node bundle is invoked, from a fresh cwd containing no .env.
  const child = spawn(process.execPath, [resolve(ROOT, "apps/agent-runner/dist/main.js"), ...args], {
    cwd, env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" }, stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [], stderr = []; let bytes = 0, overflow = false, timedOut = false, failed = false, closed = false;
  const terminate = () => { if (!closed) child.kill("SIGKILL"); };
  const capture = output => chunk => {
    bytes += chunk.length;
    if (bytes > 64 * 1024) { overflow = true; terminate(); } else output.push(chunk);
  };
  child.stdout.on("data", capture(stdout)); child.stderr.on("data", capture(stderr));
  const finished = new Promise(resolveClose => {
    child.once("error", () => { failed = true; });
    child.once("close", (status, signal) => { closed = true; resolveClose({ status, signal }); });
  });
  const timer = setTimeout(() => { timedOut = true; terminate(); }, 5_000);
  let result; try { result = await finished; } finally { clearTimeout(timer); }
  // close, not a timeout race, is the process/stdio settlement barrier. A server fallback
  // cannot satisfy this bounded one-shot exit contract, even without any database config.
  const out = Buffer.concat(stdout).toString("utf8"), err = Buffer.concat(stderr).toString("utf8");
  const help = args.length === 2 && args[1] === "--help";
  const valid = help ? result.status === 0 && err === ""
    && out.startsWith("Usage: agent-runner schema <command>\n\n")
    && out.includes("This command never creates a database, starts a service or activates runtime controls.\n")
    && out.endsWith("  schema -h, schema --help  Show this help without opening resources.\n\n")
    : result.status === 1 && out === "" && err === '{"status":"error","code":"invalid_arguments"}\n';
  if (failed || timedOut || overflow || result.signal || !valid) throw new Error("bundled main schema mode failed its closed plain Node contract");
}

function launch(name, entry, env) {
  const child = spawn(process.execPath, [resolve(ROOT, entry)], {
    cwd: ROOT,
    env: { ...cleanDistBootEnv(process.env), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  return { name, child, output };
}

async function waitHttp(url, label) {
  const deadline = Date.now() + 30_000;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return response;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`${label} did not become ready at ${url} (${lastError})`);
}

async function assertOpenApi(url, label) {
  const response = await waitHttp(url, label);
  const actual = await response.json();
  if (JSON.stringify(actual) !== JSON.stringify(canonicalOpenApi)) {
    throw new Error(`${label} did not serve the canonical OpenAPI document`);
  }
}

async function stop(proc) {
  if (!proc || proc.child.exitCode !== null) return;
  proc.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => proc.child.once("exit", resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
  ]);
  if (proc.child.exitCode === null) proc.child.kill("SIGKILL");
}

const runnerPort = await freePort();
const routerPort = await freePort();
const runnerMetricsToken = "agent-service-runner-metrics-test-only-v1";
const routerMetricsToken = "agent-service-router-metrics-test-only-v1";
let runner;
let router;

async function assertMetrics(base, token, component, otherToken) {
  const request = (path, authorization, method = "GET") => fetch(`${base}${path}`, {
    method, headers: authorization === undefined ? {} : { Authorization: authorization },
    signal: AbortSignal.timeout(2_000),
  });
  for (const authorization of [undefined, `Bearer ${otherToken}`]) {
    const response = await request("/metrics", authorization);
    if (response.status !== 401 || response.headers.get("Cache-Control") !== "no-store") {
      throw new Error("bundled metrics authentication boundary failed");
    }
    await response.arrayBuffer();
  }
  const response = await request("/metrics", `Bearer ${token}`);
  const text = await response.text();
  if (response.status !== 200 || response.headers.get("Cache-Control") !== "no-store"
      || !response.headers.get("Content-Type")?.startsWith("text/plain; version=0.0.4")
      || !text.includes('agent_service_http_requests_total{component="' + component + '"')
      || !text.includes("# TYPE agent_service_http_response_headers_duration_seconds histogram")
      || !text.includes("# TYPE agent_service_process_cpu_user_seconds_total counter")
      || text.includes(token) || text.includes(otherToken)) {
    throw new Error("bundled metrics scrape or closed-content proof failed");
  }
  const head = await request("/metrics", `Bearer ${token}`, "HEAD");
  if (head.status !== 200 || (await head.text()) !== "") throw new Error("bundled metrics HEAD failed");
  const post = await request("/metrics", `Bearer ${token}`, "POST");
  if (post.status !== 405 || post.headers.get("Allow") !== "GET, HEAD") throw new Error("bundled metrics method guard failed");
  await post.arrayBuffer();
  const ordinary = await request("/v1/agents", `Bearer ${token}`);
  if (ordinary.status !== 403) throw new Error("bundled scrape token gained business authority");
  await ordinary.arrayBuffer();
  const nested = await request("/metrics/nested", `Bearer ${token}`);
  if (nested.status !== 404) throw new Error("bundled metrics family was forwarded");
  await nested.arrayBuffer();
}

try {
  const schemaScratch = await mkdtemp(join(tmpdir(), "agent-service-dist-schema-check-"));
  try {
    for (const args of [["schema", "--help"], ["schema", "unknown"], ["schema", "--help", "extra"]]) {
      await checkSchemaMain(schemaScratch, args);
    }
  } finally { await rm(schemaScratch, { recursive: true, force: true }); }
  console.log("bundled main schema mode: help and closed unknown/extra argument rejection passed without a service or database");
  runner = launch("runner", "apps/agent-runner/dist/main.js", {
    NODE_ENV: "test",
    STORE: "memory",
    SECRETS_MASTER_KEY: MASTER_KEY,
    RUNNER_HOST: "127.0.0.1",
    RUNNER_PORT: String(runnerPort),
    RUNNER_ADDR: `127.0.0.1:${runnerPort}`,
    SHUTDOWN_GRACE_MS: "0",
  });
  await waitHttp(`http://127.0.0.1:${runnerPort}/readyz`, "bundled runner");
  await assertOpenApi(`http://127.0.0.1:${runnerPort}/openapi.json`, "bundled runner OpenAPI");

  router = launch("router", "apps/agent-router/dist/main.js", {
    NODE_ENV: "test",
    ROUTER_HOST: "127.0.0.1",
    ROUTER_PORT: String(routerPort),
    RUNNERS: `http://127.0.0.1:${runnerPort}`,
    HEALTH_INTERVAL_MS: "100",
    SHUTDOWN_GRACE_MS: "0",
  });
  await waitHttp(`http://127.0.0.1:${routerPort}/readyz`, "bundled router");
  await waitHttp(`http://127.0.0.1:${routerPort}/v1/capabilities`, "router protocol discovery");
  const forwarded = await fetch(`http://127.0.0.1:${routerPort}/v1/agents`);
  const forwardedBody = await forwarded.json();
  if (forwarded.status !== 401 || forwardedBody?.error?.code !== "unauthorized") {
    throw new Error("bundled router did not forward an authenticated API route to the runner");
  }
  const platformControl = await fetch(
    `http://127.0.0.1:${routerPort}/v1/tenant-erasure-requests`,
    { method: "POST" },
  );
  const platformControlBody = await platformControl.json();
  if (platformControl.status !== 401 || platformControlBody?.error?.code !== "unauthorized") {
    throw new Error("bundled router did not retain the platform tenant-erasure auth boundary");
  }
  await assertOpenApi(`http://127.0.0.1:${routerPort}/openapi.json`, "bundled router OpenAPI");
  console.log("bundled runner and router started; readiness, tenant/platform auth boundaries, forwarding, and OpenAPI passed");
  for (const port of [runnerPort, routerPort]) {
    const hidden = await fetch(`http://127.0.0.1:${port}/metrics`, { signal: AbortSignal.timeout(2_000) });
    if (hidden.status !== 404) throw new Error("bundled metrics was not default-disabled");
    await hidden.arrayBuffer();
  }
  await stop(router); await stop(runner);
  runner = launch("runner-metrics", "apps/agent-runner/dist/main.js", {
    NODE_ENV: "test", STORE: "memory", SECRETS_MASTER_KEY: MASTER_KEY,
    RUNNER_HOST: "127.0.0.1", RUNNER_PORT: String(runnerPort),
    RUNNER_ADDR: `127.0.0.1:${runnerPort}`, SHUTDOWN_GRACE_MS: "0",
    METRICS_ENABLED: "1", METRICS_BEARER_TOKEN: runnerMetricsToken,
  });
  await waitHttp(`http://127.0.0.1:${runnerPort}/readyz`, "metrics bundled runner");
  router = launch("router-metrics", "apps/agent-router/dist/main.js", {
    NODE_ENV: "test", ROUTER_HOST: "127.0.0.1", ROUTER_PORT: String(routerPort),
    RUNNERS: `http://127.0.0.1:${runnerPort}`, HEALTH_INTERVAL_MS: "100", SHUTDOWN_GRACE_MS: "0",
    METRICS_ENABLED: "1", METRICS_BEARER_TOKEN: routerMetricsToken,
  });
  await waitHttp(`http://127.0.0.1:${routerPort}/readyz`, "metrics bundled router");
  await assertMetrics(`http://127.0.0.1:${runnerPort}`, runnerMetricsToken, "runner", routerMetricsToken);
  await assertMetrics(`http://127.0.0.1:${routerPort}`, routerMetricsToken, "router", runnerMetricsToken);
  for (const proc of [runner, router]) {
    if (proc.output.some((line) => line.includes(runnerMetricsToken) || line.includes(routerMetricsToken))) {
      throw new Error("bundled metrics credential appeared in process output");
    }
  }
  console.log("bundled independent metrics: default-off, role auth, HEAD/method guard, closed output and no business authority passed");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  for (const proc of [runner, router]) {
    if (proc) console.error(`--- ${proc.name} ---\n${proc.output.join("")}`);
  }
  process.exitCode = 1;
} finally {
  await stop(router);
  await stop(runner);
}
