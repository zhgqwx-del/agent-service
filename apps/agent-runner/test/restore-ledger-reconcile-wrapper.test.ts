import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RESTORE_AUTHORITY_ENV = [
  "NODE_ENV",
  "MYSQL_URL",
  "RESTORE_RUN_ID",
  "RESTORE_FLEET_STOPPED_ACK",
  "SOURCE_BACKUP_SHA256",
  "RESTORE_REPLAY_PAGE_SIZE",
  "BLOB_STORE",
  "RESTORE_JOURNAL_ADAPTER",
  "RESTORE_JOURNAL_DATABASE_NAMESPACE_ID",
  "RESTORE_JOURNAL_RUNTIME_EPOCH_ID",
  "RESTORE_JOURNAL_NAMESPACE_ID",
  "RESTORE_JOURNAL_FAILURE_DOMAIN_ID",
  "RESTORE_JOURNAL_INDEPENDENT_FAILURE_DOMAIN_ACK",
  "RESTORE_JOURNAL_S3_ENDPOINT",
  "RESTORE_JOURNAL_S3_REGION",
  "RESTORE_JOURNAL_S3_BUCKET",
  "RESTORE_JOURNAL_S3_PREFIX",
  "RESTORE_JOURNAL_S3_FORCE_PATH_STYLE",
  "RESTORE_JOURNAL_S3_PRIVATE_BUCKET_ACK",
  "RESTORE_JOURNAL_S3_REQUEST_TIMEOUT_MS",
  "RESTORE_JOURNAL_S3_ACCESS_KEY_ID",
  "RESTORE_JOURNAL_S3_SECRET_ACCESS_KEY",
  "RESTORE_JOURNAL_S3_SESSION_TOKEN",
  "RESTORE_JOURNAL_PRIMARY_ACTIVATION_ACK",
  "RESTORE_JOURNAL_NAMESPACE_SHA256",
  "RESTORE_JOURNAL_TARGET_ROOT_SHA256",
  "RESTORE_JOURNAL_RUNTIME_EPOCH_SHA256",
  "TENANT_RESTORE_JOURNAL_WORKER_ENABLED",
  "TENANT_RESTORE_JOURNAL_WORKER_POLL_MS",
  "TENANT_RESTORE_JOURNAL_WORKER_LEASE_MS",
  "TENANT_RESTORE_JOURNAL_WORKER_BATCH_SIZE",
  "TENANT_RESTORE_JOURNAL_MATERIALIZE_BATCH_SIZE",
  "TENANT_RESTORE_JOURNAL_RETRY_BASE_MS",
  "TENANT_RESTORE_JOURNAL_RETRY_MAX_MS",
  "TENANT_RESTORE_JOURNAL_EXECUTION_ENABLED",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONFIG_FILE",
  "AWS_CREDENTIAL_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_ENDPOINT_URL",
  "AWS_ENDPOINT_URL_S3",
] as const;

describe("local restore-ledger-reconcile wrapper", () => {
  it("keeps explicit caller authority, including empty values, ahead of .env without echoing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-service-restore-wrapper-"));
    try {
      const scriptsDir = join(root, "scripts");
      const binDir = join(root, "bin");
      await mkdir(scriptsDir, { recursive: true });
      await mkdir(binDir, { recursive: true });

      const wrapper = join(scriptsDir, "local-service.sh");
      await copyFile(
        fileURLToPath(new URL("../../../scripts/local-service.sh", import.meta.url)),
        wrapper,
      );
      await chmod(wrapper, 0o755);

      const dotenvValues = Object.fromEntries(
        RESTORE_AUTHORITY_ENV.map((name, index) => [name, `dotenv-restore-sentinel-${index}`]),
      );
      dotenvValues.MYSQL_URL = "mysql://dotenv-user:dotenv-secret@dotenv-db/dotenv";
      await writeFile(
        join(root, ".env"),
        `${RESTORE_AUTHORITY_ENV.map((name) => `${name}=${dotenvValues[name]}`).join("\n")}\n`,
        { mode: 0o600 },
      );

      const nodeShim = join(binDir, "node");
      await writeFile(nodeShim, `#!/bin/bash
set -euo pipefail
if [ "\${1-}" = "-p" ]; then
  printf '24\\n'
  exit 0
fi
if [ "\${1-}" != "--import" ] \
  || [ "\${2-}" != "tsx" ] \
  || [ "\${3-}" != "apps/agent-runner/src/restore-ledger-reconcile.ts" ] \
  || [ "\${4-}" != "run" ]; then
  printf 'unexpected restore wrapper arguments\\n' >&2
  exit 41
fi
for name in ${RESTORE_AUTHORITY_ENV.join(" ")}; do
  expected_name="TEST_EXPECT_\${name}"
  if [ "\${!name+x}" != x ] || [ "\${!name}" != "\${!expected_name}" ]; then
    printf 'authority mismatch: %s\\n' "\${name}" >&2
    exit 42
  fi
done
printf 'restore-wrapper-ok\\n'
`, { mode: 0o755 });
      const pnpmShim = join(binDir, "pnpm");
      await writeFile(pnpmShim, "#!/bin/bash\nexit 0\n", { mode: 0o755 });

      const callerValues: Record<(typeof RESTORE_AUTHORITY_ENV)[number], string> =
        Object.fromEntries(
          RESTORE_AUTHORITY_ENV.map((name, index) => [name, `caller-restore-sentinel-${index}`]),
        ) as Record<(typeof RESTORE_AUTHORITY_ENV)[number], string>;
      callerValues.NODE_ENV = "production";
      callerValues.MYSQL_URL = "mysql://caller-user:caller-secret@caller-db/caller";
      callerValues.RESTORE_REPLAY_PAGE_SIZE = "";
      callerValues.RESTORE_JOURNAL_S3_SESSION_TOKEN = "";
      callerValues.TENANT_RESTORE_JOURNAL_WORKER_ENABLED = "";
      callerValues.AWS_PROFILE = "";

      const childEnv: NodeJS.ProcessEnv = {
        PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      };
      for (const name of RESTORE_AUTHORITY_ENV) {
        childEnv[name] = callerValues[name];
        childEnv[`TEST_EXPECT_${name}`] = callerValues[name];
      }

      const result = spawnSync(wrapper, ["restore-ledger-reconcile", "run"], {
        cwd: root,
        encoding: "utf8",
        env: childEnv,
      });

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("restore-wrapper-ok\n");
      expect(result.stderr).toBe("");
      for (const value of Object.values(dotenvValues)) {
        expect(result.stdout).not.toContain(value);
        expect(result.stderr).not.toContain(value);
      }
      for (const value of Object.values(callerValues).filter((value) => value !== "")) {
        expect(result.stdout).not.toContain(value);
        expect(result.stderr).not.toContain(value);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
