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

async function freePorts() {
  const reservations = [], ports = [];
  let failed = false, firstError;
  const remember = error => { if (!failed) { failed = true; firstError = error; } };
  try {
    for (let i = 0; i < 2; i++) {
      const server = createServer(); reservations.push(server);
      const port = await new Promise((resolvePort, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (!address || typeof address === "string" || !Number.isInteger(address.port) || address.port < 1) {
            reject(new Error("bundled boot port reservation failed"));
          } else resolvePort(address.port);
        });
      });
      ports.push(port);
    }
    if (ports[0] === ports[1]) throw new Error("bundled boot ports were not distinct");
  } catch (error) { remember(error); } finally {
    const closed = await Promise.allSettled(reservations.map(server => new Promise((resolveClose, reject) => {
      server.close(error => {
        if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
        else resolveClose();
      });
    })));
    for (const result of closed) if (result.status === "rejected") remember(result.reason);
  }
  if (failed) throw firstError;
  return ports;
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
  const proc = { name, child, output: [], closed: false, failed: false, firstError: undefined, result: undefined, stopping: undefined };
  proc.finished = new Promise(resolveClose => {
    child.once("error", error => {
      if (!proc.failed) { proc.failed = true; proc.firstError = error; }
    });
    child.once("close", (status, signal) => {
      proc.closed = true; proc.result = { status, signal }; resolveClose(proc.result);
    });
  });
  child.stdout.on("data", chunk => proc.output.push(chunk.toString()));
  child.stderr.on("data", chunk => proc.output.push(chunk.toString()));
  return proc;
}

function assertChildRunning(proc) {
  if (proc.failed) throw proc.firstError;
  if (proc.closed || proc.child.exitCode !== null || proc.child.signalCode !== null) {
    throw new Error(`bundled ${proc.name} exited before its HTTP proof`);
  }
}

async function waitHttp(url, label, proc) {
  const deadline = Date.now() + 30_000;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    assertChildRunning(proc);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      assertChildRunning(proc);
      if (response.ok) return response;
      lastError = `HTTP ${response.status}`;
      await response.arrayBuffer();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`${label} did not become ready at ${url} (${lastError})`);
}

async function assertOpenApi(url, label, proc) {
  const response = await waitHttp(url, label, proc);
  const actual = await response.json();
  if (JSON.stringify(actual) !== JSON.stringify(canonicalOpenApi)) {
    throw new Error(`${label} did not serve the canonical OpenAPI document`);
  }
}

async function assertRole(base, role, proc) {
  assertChildRunning(proc);
  const response = await fetch(`${base}/v1/capabilities`, { signal: AbortSignal.timeout(1_000) });
  assertChildRunning(proc);
  if (!response.ok) {
    await response.arrayBuffer();
    throw new Error(`bundled ${role} capability request failed`);
  }
  const capabilities = await response.json();
  assertChildRunning(proc);
  if (capabilities?.service !== `agent-${role}`) {
    throw new Error(`bundled ${role} capability role mismatch`);
  }
}

function stop(proc) {
  if (!proc) return Promise.resolve();
  if (proc.stopping) return proc.stopping;
  proc.stopping = (async () => {
    let timer, forced = false, failed = false, firstError;
    const remember = error => { if (!failed) { failed = true; firstError = error; } };
    if (proc.failed) remember(proc.firstError);
    if (proc.closed || proc.child.exitCode !== null || proc.child.signalCode !== null) {
      remember(new Error(`bundled ${proc.name} exited before requested shutdown`));
    }
    if (!proc.closed) {
      timer = setTimeout(() => {
        if (!proc.closed) {
          forced = true;
          try { proc.child.kill("SIGKILL"); } catch (error) { remember(error); }
        }
      }, 5_000);
      if (proc.child.exitCode === null && proc.child.signalCode === null) {
        try { proc.child.kill("SIGTERM"); } catch (error) { remember(error); }
      }
    }
    let result;
    try { result = await proc.finished; } finally { clearTimeout(timer); }
    if (proc.failed) remember(proc.firstError);
    if (forced) remember(new Error(`bundled ${proc.name} required SIGKILL`));
    if (result.status !== 0 || result.signal !== null) remember(new Error(`bundled ${proc.name} did not close cleanly`));
    if (failed) throw firstError;
  })();
  return proc.stopping;
}

const [runnerPort, routerPort] = await freePorts();
const runnerMetricsToken = "agent-service-runner-metrics-test-only-v1";
const routerMetricsToken = "agent-service-router-metrics-test-only-v1";
let runner;
let router;
let failed = false, firstError, metricsFailureDiagnostic;
const rememberFailure = error => { if (!failed) { failed = true; firstError = error; } };

async function assertMetrics(base, token, component, otherToken) {
  const request = (path, authorization, method = "GET") => fetch(`${base}${path}`, {
    method, headers: authorization === undefined ? {} : { Authorization: authorization },
    signal: AbortSignal.timeout(2_000),
  });
  for (const authorization of [undefined, `Bearer ${otherToken}`]) {
    const response = await request("/metrics", authorization);
    if (response.status !== 401 || response.headers.get("Cache-Control") !== "no-store") {
      const cacheControl = response.headers.get("Cache-Control");
      const diagnostic = { component, authVariant: authorization === undefined ? "missing" : "other-role",
        status: response.status, cacheControl: cacheControl === null || cacheControl === "no-store" ? cacheControl : "other" };
      metricsFailureDiagnostic = diagnostic;
      const failure = new Error(`bundled metrics authentication boundary failed ${JSON.stringify(diagnostic)}`);
      try { await response.arrayBuffer(); } catch { /* Preserve the observed boundary failure after the real body promise settles. */ }
      throw failure;
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
  await (await waitHttp(`http://127.0.0.1:${runnerPort}/readyz`, "bundled runner", runner)).arrayBuffer();
  await assertRole(`http://127.0.0.1:${runnerPort}`, "runner", runner);
  await assertOpenApi(`http://127.0.0.1:${runnerPort}/openapi.json`, "bundled runner OpenAPI", runner);

  router = launch("router", "apps/agent-router/dist/main.js", {
    NODE_ENV: "test",
    ROUTER_HOST: "127.0.0.1",
    ROUTER_PORT: String(routerPort),
    RUNNERS: `http://127.0.0.1:${runnerPort}`,
    HEALTH_INTERVAL_MS: "100",
    SHUTDOWN_GRACE_MS: "0",
  });
  await (await waitHttp(`http://127.0.0.1:${routerPort}/readyz`, "bundled router", router)).arrayBuffer();
  await assertRole(`http://127.0.0.1:${routerPort}`, "router", router);
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
  await assertOpenApi(`http://127.0.0.1:${routerPort}/openapi.json`, "bundled router OpenAPI", router);
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
  await (await waitHttp(`http://127.0.0.1:${runnerPort}/readyz`, "metrics bundled runner", runner)).arrayBuffer();
  await assertRole(`http://127.0.0.1:${runnerPort}`, "runner", runner);
  router = launch("router-metrics", "apps/agent-router/dist/main.js", {
    NODE_ENV: "test", ROUTER_HOST: "127.0.0.1", ROUTER_PORT: String(routerPort),
    RUNNERS: `http://127.0.0.1:${runnerPort}`, HEALTH_INTERVAL_MS: "100", SHUTDOWN_GRACE_MS: "0",
    METRICS_ENABLED: "1", METRICS_BEARER_TOKEN: routerMetricsToken,
  });
  await (await waitHttp(`http://127.0.0.1:${routerPort}/readyz`, "metrics bundled router", router)).arrayBuffer();
  await assertRole(`http://127.0.0.1:${routerPort}`, "router", router);
  await assertMetrics(`http://127.0.0.1:${runnerPort}`, runnerMetricsToken, "runner", routerMetricsToken);
  await assertMetrics(`http://127.0.0.1:${routerPort}`, routerMetricsToken, "router", runnerMetricsToken);
  for (const proc of [runner, router]) {
    if (proc.output.some((line) => line.includes(runnerMetricsToken) || line.includes(routerMetricsToken))) {
      throw new Error("bundled metrics credential appeared in process output");
    }
  }
  console.log("bundled independent metrics: default-off, role auth, HEAD/method guard, closed output and no business authority passed");
} catch (error) {
  rememberFailure(error);
} finally {
  for (const proc of [router, runner]) {
    try { await stop(proc); } catch (error) { rememberFailure(error); }
  }
  if (failed) {
    console.error("bundled boot gate failed");
    console.error(JSON.stringify({ schema: "dist-boot-gate-failure-v1", runnerPort, routerPort,
      failureKind: firstError === undefined ? "undefined" : firstError instanceof Error ? "error" : "non-error",
      metrics: metricsFailureDiagnostic ?? null,
      children: [runner, router].filter(Boolean).map(proc => ({ name: proc.name, pid: proc.child.pid ?? null,
        closed: proc.closed, spawnFailed: proc.failed, status: proc.result?.status ?? null, signal: proc.result?.signal ?? null })) }));
    process.exitCode = 1;
  }
}
