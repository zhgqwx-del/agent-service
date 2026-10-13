// Verify the sixth distributable JS entry, not TypeScript execution through a dev loader.
import { spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifact = resolve(root, "apps/agent-runner/dist/telemetry-capture.js");
const artifactStat = await stat(artifact).catch(() => undefined);
if (!artifactStat?.isFile() || artifactStat.size === 0) {
  throw new Error("runner telemetry-capture artifact is missing or empty");
}
const result = spawnSync(process.execPath, [artifact, "--help"], {
  cwd: root,
  encoding: "utf8",
  env: { NODE_ENV: "test", PATH: process.env.PATH ?? "" },
  timeout: 5_000,
  maxBuffer: 64 * 1024,
});
if (result.error || result.signal || result.status !== 0 || result.stderr.trim() !== ""
  || !result.stdout.includes("Usage: telemetry-capture")) {
  // Never reflect a subprocess diagnostic: a malformed artifact may print ambient secrets.
  throw new Error("runner telemetry-capture artifact failed its plain Node help check");
}
const rejected = spawnSync(process.execPath, [artifact, "status"], {
  cwd: root, encoding: "utf8", env: { NODE_ENV: "production", PATH: process.env.PATH ?? "" },
  timeout: 5_000, maxBuffer: 64 * 1024,
});
if (rejected.error || rejected.signal || rejected.status !== 1 || rejected.stdout !== ""
  || rejected.stderr !== "telemetry-capture failed (operation_failed)\n") {
  throw new Error("runner telemetry-capture artifact did not safely reject production");
}
console.log(`runner telemetry-capture artifact executed under plain Node (${artifactStat.size} bytes)`);
