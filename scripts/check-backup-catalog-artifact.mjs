// Fail closed unless the exact one-shot catalog command shipped in agent-runner executes under
// plain Node. Source execution through tsx is not distributable-artifact proof.
import { spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifact = resolve(ROOT, "apps/agent-runner/dist/backup-catalog.js");
const artifactStat = await stat(artifact).catch(() => undefined);
if (!artifactStat?.isFile() || artifactStat.size === 0) {
  throw new Error("runner backup-catalog artifact is missing or empty");
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
if (result.signal) throw new Error(`backup-catalog --help terminated by ${result.signal}`);
if (result.status !== 0) {
  throw new Error(`backup-catalog --help exited ${result.status}: ${result.stderr.trim()}`);
}
if (result.stderr.trim() !== "") {
  throw new Error(`backup-catalog --help wrote unexpected stderr: ${result.stderr.trim()}`);
}
if (!result.stdout.includes("Usage: backup-catalog")) {
  throw new Error("backup-catalog --help did not emit its stable usage marker");
}
for (const prerequisite of [
  "create-artifact", "verify-artifact", "restore-selected",
  "BACKUP_ARTIFACT_LOCAL_ONLY_ACK=1", "BACKUP_ARTIFACT_KEY_FILE",
  "BACKUP_MYSQL_BINARY/BACKUP_MYSQLDUMP_BINARY", "Install MySQL 8 mysql/mysqldump externally",
  "current runner image does not include these tools", "Production use is rejected",
  "publish-backup remains attestation-only",
  "TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE", "32 raw bytes (not hex)",
  "Direct commands reject any ambient TENANT_TELEMETRY_REF_KEY",
  "active provider-capture restore is unsupported",
]) {
  if (!result.stdout.includes(prerequisite)) {
    throw new Error("backup-catalog --help omitted an artifact command or safety prerequisite");
  }
}

const rejected = spawnSync(process.execPath, [artifact, "status"], {
  cwd: ROOT, encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024,
  env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", TENANT_TELEMETRY_REF_KEY: "" },
});
if (rejected.error || rejected.signal || rejected.status !== 1 || rejected.stdout !== ""
  || rejected.stderr !== '{"status":"error","code":"invalid_configuration"}\n') {
  throw new Error("backup-catalog artifact did not safely reject ambient application key authority");
}

console.log(`runner backup-catalog artifact executed under plain Node (${artifactStat.size} bytes)`);
