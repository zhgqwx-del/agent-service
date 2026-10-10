// Fail-closed distributable check for the runner's one-shot Blob migration command. This checks the
// exact plain-Node artifact shipped in the image; source execution under tsx is not sufficient proof.
import { spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifact = resolve(ROOT, "apps/agent-runner/dist/blob-storage-migrate.js");
const artifactStat = await stat(artifact).catch(() => undefined);
if (!artifactStat?.isFile() || artifactStat.size === 0) {
  throw new Error("runner blob-storage-migrate artifact is missing or empty");
}

const result = spawnSync(process.execPath, [artifact, "--help"], {
  cwd: ROOT,
  encoding: "utf8",
  env: {
    NODE_ENV: "test",
    PATH: process.env.PATH ?? "",
  },
  maxBuffer: 64 * 1024,
  timeout: 5_000,
});
if (result.error) throw result.error;
if (result.signal) throw new Error(`blob-storage-migrate --help terminated by ${result.signal}`);
if (result.status !== 0) {
  throw new Error(`blob-storage-migrate --help exited ${result.status}: ${result.stderr.trim()}`);
}
if (result.stderr.trim() !== "") {
  throw new Error(`blob-storage-migrate --help wrote unexpected stderr: ${result.stderr.trim()}`);
}
if (!result.stdout.includes("Usage: blob-storage-migrate")) {
  throw new Error("blob-storage-migrate --help did not emit its stable usage marker");
}

console.log(`runner blob-storage-migrate artifact executed under plain Node (${artifactStat.size} bytes)`);
