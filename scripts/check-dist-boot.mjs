// CI gate: both production bundles must boot under plain Node (without tsx), and the router must
// discover and forward to the bundled runner.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

function cleanEnv() {
  const env = { ...process.env };
  // The bundle check must be deterministic and must never inherit real services or credentials.
  for (const key of [
    "API_KEY",
    "API_BASE_URL",
    "DEFAULT_MODEL",
    "PLATFORM_PROVIDER",
    "BOOTSTRAP_API_KEY",
    "BOOTSTRAP_TENANT_ID",
    "ADMIN_BOOTSTRAP_TENANT",
    "MYSQL_URL",
    "SECRETS_MASTER_KEY",
    "REDIS_URL",
    "ROUTER_ADMIN_TOKEN",
    "INTERNAL_ROUTER_TOKEN",
    "DATA_ERASURE_REQUESTS_ENABLED",
    "TENANT_ERASURE_REQUESTS_ENABLED",
    "TENANT_ERASURE_OPERATOR_TOKEN",
    "TENANT_ERASURE_OPERATOR_ID",
    "TENANT_ERASURE_BARRIER_TIMEOUT_MS",
    "DATA_GOVERNANCE_MANAGEMENT_ENABLED",
    "ERASURE_WORKER_ENABLED",
    "LEGACY_TOMBSTONE_COMPENSATION_ENABLED",
    "PURGE_POLICY_EVALUATOR_ENABLED",
    "DATA_EXPORT_REQUESTS_ENABLED",
    "DATA_EXPORT_WORKER_ENABLED",
    "DATA_EXPORT_CLEANUP_ENABLED",
    "ERASURE_ROUTER_URL",
    "ERASURE_WORKER_POLL_MS",
    "ERASURE_WORKER_LEASE_MS",
    "ERASURE_WORKER_BATCH_SIZE",
    "ERASURE_WORKER_SESSION_PAGE_SIZE",
    "ERASURE_WORKER_RETRY_BASE_MS",
    "ERASURE_WORKER_RETRY_MAX_MS",
    "LEGACY_TOMBSTONE_COMPENSATION_POLL_MS",
    "LEGACY_TOMBSTONE_COMPENSATION_LEASE_MS",
    "LEGACY_TOMBSTONE_COMPENSATION_BATCH_SIZE",
    "LEGACY_TOMBSTONE_COMPENSATION_RETRY_BASE_MS",
    "LEGACY_TOMBSTONE_COMPENSATION_RETRY_MAX_MS",
    "PURGE_POLICY_EVALUATOR_POLL_MS",
    "PURGE_POLICY_EVALUATOR_LEASE_MS",
    "PURGE_POLICY_EVALUATOR_BATCH_SIZE",
    "PURGE_POLICY_EVALUATOR_TARGET_PAGE_SIZE",
    "PURGE_POLICY_EVALUATOR_RETRY_BASE_MS",
    "PURGE_POLICY_EVALUATOR_RETRY_MAX_MS",
    "DATA_EXPORT_WORKER_POLL_MS",
    "DATA_EXPORT_WORKER_LEASE_MS",
    "DATA_EXPORT_WORKER_BATCH_SIZE",
    "DATA_EXPORT_SNAPSHOT_PAGE_SIZE",
    "DATA_EXPORT_ARTIFACT_STAGING_TTL_MS",
    "DATA_EXPORT_WORKER_RETRY_BASE_MS",
    "DATA_EXPORT_WORKER_RETRY_MAX_MS",
    "DATA_EXPORT_WORKER_POISON_MAX_ATTEMPTS",
    "DATA_EXPORT_CLEANUP_POLL_MS",
    "DATA_EXPORT_CLEANUP_LEASE_MS",
    "DATA_EXPORT_CLEANUP_BATCH_SIZE",
    "DATA_EXPORT_CLEANUP_RETRY_BASE_MS",
    "DATA_EXPORT_CLEANUP_RETRY_MAX_MS",
    "DATA_EXPORT_CLEANUP_POISON_MAX_ATTEMPTS",
    "DATA_EXPORT_DOWNLOAD_LEASE_MS",
    "ERASURE_WORKER_REQUEST_TIMEOUT_MS",
    "ERASURE_DRAIN_TIMEOUT_MS",
  ]) delete env[key];
  // Lifecycle rollout flags and tuning grow independently. Strip each family so a developer's
  // sourced .env cannot accidentally start a worker or expose a private execution surface here.
  for (const key of Object.keys(env)) {
    if ([
      "AWS_",
      "MYSQL_",
      "BLOB_",
      "MINIO_",
      "S3_TEST_",
      "TENANT_ERASURE_",
      "TENANT_CREDENTIAL_REVOCATION_",
      "TENANT_CREDENTIAL_TARGET_EXECUTION_",
      "CREDENTIAL_TARGET_EXECUTION_",
      "RESTORE_JOURNAL_",
      "TENANT_RESTORE_JOURNAL_",
      "TENANT_RUNTIME_",
      "TENANT_CONTENT_INVENTORY_",
      "TENANT_PURGE_PLAN_",
      "TENANT_PURGE_EXECUTION_",
      "TENANT_DATABASE_PURGE_",
      "TENANT_REDIS_PURGE_",
    ].some((prefix) => key.startsWith(prefix))) delete env[key];
  }
  return env;
}

function launch(name, entry, env) {
  const child = spawn(process.execPath, [resolve(ROOT, entry)], {
    cwd: ROOT,
    env: { ...cleanEnv(), ...env },
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
let runner;
let router;
try {
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
