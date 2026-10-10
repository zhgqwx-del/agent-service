// Fail closed unless the exact one-shot restore command shipped in agent-runner executes under
// plain Node. Source execution through tsx is not distributable-artifact proof.
import { spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifact = resolve(ROOT, "apps/agent-runner/dist/restore-ledger-reconcile.js");
const artifactStat = await stat(artifact).catch(() => undefined);
if (!artifactStat?.isFile() || artifactStat.size === 0) {
  throw new Error("runner restore-ledger-reconcile artifact is missing or empty");
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
if (result.signal) throw new Error(`restore-ledger-reconcile --help terminated by ${result.signal}`);
if (result.status !== 0) {
  throw new Error(`restore-ledger-reconcile --help exited ${result.status}: ${result.stderr.trim()}`);
}
if (result.stderr.trim() !== "") {
  throw new Error(
    `restore-ledger-reconcile --help wrote unexpected stderr: ${result.stderr.trim()}`,
  );
}
if (!result.stdout.includes("Usage: restore-ledger-reconcile")) {
  throw new Error("restore-ledger-reconcile --help did not emit its stable usage marker");
}

console.log(
  `runner restore-ledger-reconcile artifact executed under plain Node (${artifactStat.size} bytes)`,
);
