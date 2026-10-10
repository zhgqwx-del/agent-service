// Real application-wiring smoke: a source or bundled runner activates the durable S3 namespace
// control in a disposable MySQL database, then a router must negotiate that exact namespace.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MASTER_KEY = "88".repeat(32); // deterministic test-only encryption key
const INTERNAL_TOKEN = "app-smoke-internal-router-token-0001";
const MAX_LOG_BYTES = 1_000_000;

function required(name, fallback) {
  const value = (process.env[name] ?? fallback)?.trim();
  if (!value) throw new Error(`${name} is required for the real S3 application smoke`);
  return value;
}

function parseOrigin(raw) {
  let value;
  try {
    value = new URL(raw);
  } catch {
    throw new Error("S3_TEST_ENDPOINT must be an absolute http(s) origin");
  }
  if (
    !["http:", "https:"].includes(value.protocol)
    || value.username
    || value.password
    || value.search
    || value.hash
    || (value.pathname && value.pathname !== "/")
  ) throw new Error("S3_TEST_ENDPOINT must be an absolute http(s) origin without credentials");
  return value.origin;
}

function parseBucket(value) {
  if (
    !/^[a-z0-9][a-z0-9.-]+[a-z0-9]$/.test(value)
    || value.length > 63
    || value.includes("..")
    || value.includes(".-")
    || value.includes("-.")
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)
  ) throw new Error("S3_TEST_BUCKET must be a safe DNS-style bucket name");
  return value;
}

function parseMysqlUrl(raw) {
  let value;
  try {
    value = new URL(raw);
  } catch {
    throw new Error("MYSQL_APP_SMOKE_URL must be an absolute mysql:// URL");
  }
  if (value.protocol !== "mysql:" || !value.hostname) {
    throw new Error("MYSQL_APP_SMOKE_URL must be an absolute mysql:// URL");
  }
  return value;
}

function baseChildEnv() {
  // Use an allowlist instead of copying process.env: a developer's sourced .env, AWS profile,
  // workload token or MinIO root credential must not silently enter either application process.
  const env = {};
  for (const key of [
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "TZ",
    "SystemRoot",
    "WINDIR",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate a loopback port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

function sourceArgs(entry, mode) {
  if (mode === "source") return ["--import", "tsx", entry.replace("/dist/", "/src/").replace(/\.js$/, ".ts")];
  return [entry];
}

function launch(name, entry, mode, env) {
  const output = [];
  let outputBytes = 0;
  let outputOverflow = false;
  const child = spawn(process.execPath, sourceArgs(entry, mode), {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (chunk) => {
    const text = chunk.toString();
    outputBytes += Buffer.byteLength(text);
    if (outputBytes <= MAX_LOG_BYTES) output.push(text);
    else outputOverflow = true;
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const closed = new Promise((resolveExit) => child.once("close", (code, signal) => {
    resolveExit({ code, signal });
  }));
  return { name, child, closed, output, get outputOverflow() { return outputOverflow; } };
}

async function waitHttp(proc, url, label, predicate = (response) => response.ok) {
  const deadline = Date.now() + 90_000;
  let last = "not attempted";
  while (Date.now() < deadline) {
    if (proc.child.exitCode !== null || proc.child.signalCode !== null) {
      throw new Error(`${label} process exited before becoming ready`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
      if (await predicate(response)) return response;
      last = `HTTP ${response.status}`;
      await response.body?.cancel().catch(() => {});
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`${label} did not become ready (${last})`);
}

async function stop(proc) {
  if (!proc) return;
  if (proc.child.exitCode === null && proc.child.signalCode === null) proc.child.kill("SIGTERM");
  await Promise.race([
    proc.closed,
    new Promise((resolveWait) => setTimeout(resolveWait, 10_000)),
  ]);
  if (proc.child.exitCode === null && proc.child.signalCode === null) {
    proc.child.kill("SIGKILL");
    await proc.closed;
  }
}

function namespaceIdentity(namespaceId, bucket, prefix) {
  const namespaceSha256 = createHash("sha256")
    .update(JSON.stringify(["blob-s3-namespace-v1", namespaceId, bucket, prefix]))
    .digest("hex");
  return {
    backend: `s3-v1-${namespaceSha256.slice(0, 24)}`,
    shared: true,
    namespaceSha256,
    controlGeneration: 1,
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function credentialKeys(env) {
  return Object.keys(env).filter((key) => (
    key.startsWith("AWS_")
    || key.startsWith("MINIO_ROOT_")
    || key.startsWith("S3_TEST_")
    || (key.startsWith("BLOB_S3_") && !["BLOB_S3_BUCKET", "BLOB_S3_PREFIX"].includes(key))
  ));
}

function containsSensitiveValue(value, sensitiveValues) {
  return sensitiveValues.some((secret) => secret && value.includes(secret));
}

function redact(value, sensitiveValues) {
  let safe = String(value);
  for (const secret of [...sensitiveValues].sort((a, b) => b.length - a.length)) {
    if (secret) safe = safe.split(secret).join("[redacted]");
  }
  return safe;
}

function processOutput(proc) {
  return proc?.output.join("") ?? "";
}

function assertNoCredentialOutput(processes, sensitiveValues) {
  for (const proc of processes) {
    if (!proc) continue;
    if (proc.outputOverflow) throw new Error(`${proc.name} exceeded the bounded smoke log capture`);
    if (containsSensitiveValue(processOutput(proc), sensitiveValues)) {
      throw new Error(`${proc.name} emitted an object-store credential`);
    }
  }
}

if (Number(process.versions.node.split(".")[0]) < 24) {
  throw new Error(`Node 24+ is required (current: ${process.version})`);
}

const mode = process.env.AGENT_SERVICE_APP_SMOKE_MODE ?? "source";
if (!new Set(["source", "dist"]).has(mode)) {
  throw new Error("AGENT_SERVICE_APP_SMOKE_MODE must be source or dist");
}
if (mode === "dist") {
  await access(resolve(ROOT, "apps/agent-runner/dist/main.js"));
  await access(resolve(ROOT, "apps/agent-router/dist/main.js"));
}

const mysqlBaseUrl = parseMysqlUrl(required(
  "MYSQL_APP_SMOKE_URL",
  process.env.MYSQL_TEST_URL,
));
const endpoint = parseOrigin(required("S3_TEST_ENDPOINT"));
const region = required("S3_TEST_REGION");
const bucket = parseBucket(required("S3_TEST_BUCKET"));
const accessKeyId = required("S3_TEST_ACCESS_KEY_ID");
const secretAccessKey = required("S3_TEST_SECRET_ACCESS_KEY");
const sessionToken = process.env.S3_TEST_SESSION_TOKEN?.trim();
const forcePathStyle = process.env.S3_TEST_FORCE_PATH_STYLE ?? "0";
if (!new Set(["0", "1"]).has(forcePathStyle)) {
  throw new Error("S3_TEST_FORCE_PATH_STYLE must be 0 or 1");
}
// Very short fixture credentials make a meaningful log-leak assertion impossible because ordinary
// prose can contain them by coincidence. Real AWS and the repository's MinIO fixtures exceed these.
if (accessKeyId.length < 8 || secretAccessKey.length < 16 || (sessionToken && sessionToken.length < 8)) {
  throw new Error("S3 application smoke credentials are too short for reliable leak detection");
}

const runId = randomBytes(8).toString("hex");
const databaseName = `agent_service_s3_smoke_${process.pid}_${runId}`;
if (!/^[a-z0-9_]{1,64}$/.test(databaseName)) throw new Error("unsafe disposable database name");
const namespaceId = `app-smoke-${runId}`;
const prefix = `app-smoke/${runId}`;
const expectedStorage = namespaceIdentity(namespaceId, bucket, prefix);
const adminUrl = new URL(mysqlBaseUrl);
adminUrl.pathname = "/";
const databaseUrl = new URL(mysqlBaseUrl);
databaseUrl.pathname = `/${databaseName}`;
const mysqlPassword = decodeURIComponent(mysqlBaseUrl.password);
const objectStoreCredentialValues = [
  accessKeyId,
  secretAccessKey,
  sessionToken,
].filter((value) => typeof value === "string" && value.length > 0);
const sensitiveValues = [
  ...objectStoreCredentialValues,
  MASTER_KEY,
  INTERNAL_TOKEN,
  mysqlPassword,
  mysqlBaseUrl.toString(),
].filter((value) => typeof value === "string" && value.length > 0);

const runnerPort = await freePort();
const routerPort = await freePort();
const runnerUrl = `http://127.0.0.1:${runnerPort}`;
const commonEnv = {
  ...baseChildEnv(),
  NODE_ENV: "test",
  SHUTDOWN_GRACE_MS: "0",
  INTERNAL_ROUTER_TOKEN: INTERNAL_TOKEN,
};
const runnerEnv = {
  ...commonEnv,
  STORE: "mysql",
  MYSQL_URL: databaseUrl.toString(),
  SECRETS_MASTER_KEY: MASTER_KEY,
  RUNNER_HOST: "127.0.0.1",
  RUNNER_PORT: String(runnerPort),
  RUNNER_ID: `app-smoke-${runId}`,
  RUNNER_ADDR: `127.0.0.1:${runnerPort}`,
  BLOB_STORE: "s3",
  BLOB_NAMESPACE_ID: namespaceId,
  BLOB_FILESYSTEM_SINGLE_RUNNER: "0",
  BLOB_S3_ENDPOINT: endpoint,
  BLOB_S3_REGION: region,
  BLOB_S3_BUCKET: bucket,
  BLOB_S3_PREFIX: prefix,
  BLOB_S3_FORCE_PATH_STYLE: forcePathStyle,
  BLOB_S3_PRIVATE_BUCKET_ACK: "0",
  BLOB_S3_REQUEST_TIMEOUT_MS: "30000",
  BLOB_S3_ACCESS_KEY_ID: accessKeyId,
  BLOB_S3_SECRET_ACCESS_KEY: secretAccessKey,
  ...(sessionToken ? { BLOB_S3_SESSION_TOKEN: sessionToken } : {}),
  BLOB_STORAGE_CONTROL_ENABLED: "1",
  BLOB_ATTACHMENTS_ENABLED: "1",
  BLOB_CLEANUP_ENABLED: "1",
  CREDENTIAL_LIFECYCLE_TRACKING_ENABLED: "0",
  ERASURE_WORKER_ENABLED: "0",
  LEGACY_TOMBSTONE_COMPENSATION_ENABLED: "0",
  DATA_EXPORT_WORKER_ENABLED: "0",
  DATA_EXPORT_CLEANUP_ENABLED: "0",
  AWS_EC2_METADATA_DISABLED: "true",
};
const routerEnv = {
  ...commonEnv,
  ROUTER_HOST: "127.0.0.1",
  ROUTER_PORT: String(routerPort),
  RUNNERS: runnerUrl,
  HEALTH_INTERVAL_MS: "100",
  BLOB_STORE: "s3",
  BLOB_NAMESPACE_ID: namespaceId,
  BLOB_FILESYSTEM_SINGLE_RUNNER: "0",
  BLOB_S3_BUCKET: bucket,
  BLOB_S3_PREFIX: prefix,
  BLOB_STORAGE_CONTROL_ENABLED: "1",
  BLOB_ATTACHMENTS_ENABLED: "1",
};

const forbiddenRouterKeys = credentialKeys(routerEnv);
if (forbiddenRouterKeys.length > 0) {
  throw new Error("router smoke environment contains object-store authority");
}
if (containsSensitiveValue(JSON.stringify(routerEnv), objectStoreCredentialValues)) {
  throw new Error("router smoke environment contains an object-store credential value");
}

let admin;
let inspection;
let runner;
let router;
let databaseCreated = false;
let verified = false;
let failure;
try {
  admin = await mysql.createConnection({ uri: adminUrl.toString(), multipleStatements: false });
  await admin.query(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  databaseCreated = true;

  runner = launch("runner", "apps/agent-runner/dist/main.js", mode, runnerEnv);
  const runnerCapabilitiesResponse = await waitHttp(
    runner,
    `${runnerUrl}/v1/capabilities`,
    "S3 runner capabilities",
  );
  const runnerCapabilities = await runnerCapabilitiesResponse.json();
  if (
    runnerCapabilities?.service !== "agent-runner"
    || runnerCapabilities?.features?.blobAttachments !== true
    || !sameJson(runnerCapabilities?.features?.blobStorage, expectedStorage)
  ) throw new Error("runner did not advertise the exact active S3 namespace capability");

  inspection = await mysql.createConnection({
    uri: databaseUrl.toString(),
    supportBigNumbers: true,
    bigNumberStrings: false,
  });
  const expectedMigrationNames = [
    "0027_blob_storage_control.sql",
    "0028_blob_storage_migration.sql",
    "0029_tenant_credential_target_execution.sql",
    "0030_tenant_restore_journal.sql",
  ];
  const [migrationRows] = await inspection.query(
    "SELECT name FROM schema_migrations WHERE name IN (?,?,?,?) ORDER BY name",
    expectedMigrationNames,
  );
  if (
    migrationRows.length !== expectedMigrationNames.length
    || migrationRows.some((row, index) => row.name !== expectedMigrationNames[index])
  ) throw new Error("runner did not apply migrations 0027 through 0030");
  const [controlRows] = await inspection.query(
    `SELECT control_generation,storage_backend,namespace_sha256,
            activated_at_db_ms,evidence_sha256
       FROM blob_storage_control WHERE singleton_id=1`,
  );
  if (controlRows.length !== 1) throw new Error("runner did not create the blob storage control singleton");
  const control = controlRows[0];
  const activatedAtDbMs = Number(control.activated_at_db_ms);
  const expectedEvidence = createHash("sha256").update(JSON.stringify([
    "blob-storage-control-v1",
    1,
    1,
    expectedStorage.backend,
    expectedStorage.namespaceSha256,
    activatedAtDbMs,
  ])).digest("hex");
  if (
    Number(control.control_generation) !== 1
    || control.storage_backend !== expectedStorage.backend
    || control.namespace_sha256 !== expectedStorage.namespaceSha256
    || !Number.isSafeInteger(activatedAtDbMs)
    || activatedAtDbMs < 0
    || control.evidence_sha256 !== expectedEvidence
  ) throw new Error("migration 0027 control was not activated with the exact S3 namespace evidence");

  const [dormantRows] = await inspection.query(
    `SELECT
       (SELECT COUNT(*) FROM blob_storage_migration_control
         WHERE singleton_id=1 AND control_generation=0 AND phase='inactive') AS blob_mover_control,
       (SELECT COUNT(*) FROM tenant_credential_target_execution_cutover
         WHERE singleton_id=1 AND control_generation=0) AS credential_target_control,
       (SELECT COUNT(*) FROM tenant_credential_target_execution_jobs) AS credential_target_jobs,
       (SELECT COUNT(*) FROM tenant_restore_journal_control
         WHERE singleton_id=1 AND control_generation=0) AS restore_journal_control,
       (SELECT COUNT(*) FROM tenant_restore_runtime_control
         WHERE singleton_id=1 AND state='inactive' AND control_generation=0) AS restore_runtime_control,
       (SELECT COUNT(*) FROM tenant_restore_journal_jobs) AS restore_journal_jobs,
       (SELECT COUNT(*) FROM tenant_restore_replay_runs) AS restore_replay_runs,
       (SELECT COUNT(*) FROM tenant_restore_fences) AS restore_fences`,
  );
  const dormant = dormantRows[0];
  if (
    !dormant
    || Number(dormant.blob_mover_control) !== 1
    || Number(dormant.credential_target_control) !== 1
    || Number(dormant.credential_target_jobs) !== 0
    || Number(dormant.restore_journal_control) !== 1
    || Number(dormant.restore_runtime_control) !== 1
    || Number(dormant.restore_journal_jobs) !== 0
    || Number(dormant.restore_replay_runs) !== 0
    || Number(dormant.restore_fences) !== 0
  ) throw new Error("migrations 0028 through 0030 were not applied as dormant ledgers");

  router = launch("router", "apps/agent-router/dist/main.js", mode, routerEnv);
  const routerUrl = `http://127.0.0.1:${routerPort}`;
  await waitHttp(router, `${routerUrl}/readyz`, "S3 router");
  const routerCapabilitiesResponse = await waitHttp(
    router,
    `${routerUrl}/v1/capabilities`,
    "S3 router capabilities",
    async (response) => {
      if (!response.ok) return false;
      const payload = await response.clone().json().catch(() => undefined);
      return payload?.features?.blobAttachments === true
        && sameJson(payload?.features?.blobStorage, expectedStorage);
    },
  );
  const routerCapabilities = await routerCapabilitiesResponse.json();
  if (
    routerCapabilities?.service !== "agent-router"
    || routerCapabilities?.features?.blobAttachments !== true
    || !sameJson(routerCapabilities?.features?.blobStorage, expectedStorage)
  ) throw new Error("router did not negotiate the exact runner S3 namespace capability");

  const capabilityText = JSON.stringify([runnerCapabilities, routerCapabilities]);
  if (containsSensitiveValue(capabilityText, sensitiveValues)) {
    throw new Error("a public capability document exposed an object-store credential");
  }
  verified = true;
} catch (error) {
  failure = error;
} finally {
  await stop(router).catch((error) => { failure ??= error; });
  await stop(runner).catch((error) => { failure ??= error; });
  try {
    assertNoCredentialOutput([runner, router], sensitiveValues);
  } catch (error) {
    failure ??= error;
  }
  await inspection?.end().catch(() => {});
  if (databaseCreated && admin) {
    await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``).catch((error) => {
      failure ??= error;
    });
  }
  await admin?.end().catch(() => {});
}

if (failure) {
  process.exitCode = 1;
  const message = failure instanceof Error ? failure.stack ?? failure.message : String(failure);
  console.error(redact(message, sensitiveValues));
  for (const proc of [runner, router]) {
    if (!proc) continue;
    const output = processOutput(proc);
    if (output) console.error(`--- ${proc.name} ---\n${redact(output, sensitiveValues)}`);
  }
} else if (verified) {
  console.log(
    `real S3 application assembly passed (${mode} runner/router, disposable MySQL, `
      + "0027 activation, exact namespace negotiation, credential isolation)",
  );
}
