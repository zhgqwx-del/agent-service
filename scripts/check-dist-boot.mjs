// CI gate: both production bundles must boot under plain Node (without tsx), and the router must
// discover and forward to the bundled runner.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MASTER_KEY = "77".repeat(32); // deterministic test-only key

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
    "BOOTSTRAP_API_KEY",
    "ADMIN_BOOTSTRAP_TENANT",
    "MYSQL_URL",
    "REDIS_URL",
    "ROUTER_ADMIN_TOKEN",
  ]) delete env[key];
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

  router = launch("router", "apps/agent-router/dist/main.js", {
    NODE_ENV: "test",
    ROUTER_HOST: "127.0.0.1",
    ROUTER_PORT: String(routerPort),
    RUNNERS: `http://127.0.0.1:${runnerPort}`,
    HEALTH_INTERVAL_MS: "100",
    SHUTDOWN_GRACE_MS: "0",
  });
  await waitHttp(`http://127.0.0.1:${routerPort}/readyz`, "bundled router");
  await waitHttp(`http://127.0.0.1:${routerPort}/v1/capabilities`, "router forwarding");
  console.log("bundled runner and router started; readiness and forwarding passed");
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
