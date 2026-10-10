import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MOVER_AUTHORITY_ENV = [
  "NODE_ENV",
  "MYSQL_URL",
  "MIGRATION_ID",
  "FLEET_DRAINED_EVIDENCE_SHA256",
  "ROLLBACK_WINDOW_MS",
  "SOURCE_CLEANUP_DELAY_MS",
  "MAX_OBJECT_BYTES",
  "BLOB_MIGRATION_COMMIT",
  "BLOB_DIR",
  "BLOB_NAMESPACE_ID",
  "BLOB_S3_ENDPOINT",
  "BLOB_S3_REGION",
  "BLOB_S3_BUCKET",
  "BLOB_S3_PREFIX",
  "BLOB_S3_FORCE_PATH_STYLE",
  "BLOB_S3_PRIVATE_BUCKET_ACK",
  "BLOB_S3_REQUEST_TIMEOUT_MS",
  "BLOB_S3_ACCESS_KEY_ID",
  "BLOB_S3_SECRET_ACCESS_KEY",
  "BLOB_S3_SESSION_TOKEN",
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

describe("local blob-storage-migrate wrapper", () => {
  it("keeps explicit caller authority, including empty values, ahead of .env without echoing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-service-mover-wrapper-"));
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
        MOVER_AUTHORITY_ENV.map((name, index) => [name, `dotenv-sentinel-${index}`]),
      );
      dotenvValues.BLOB_MIGRATION_COMMIT = "1";
      dotenvValues.MYSQL_URL = "mysql://dotenv-user:dotenv-secret@dotenv-db/dotenv";
      await writeFile(
        join(root, ".env"),
        `${MOVER_AUTHORITY_ENV.map((name) => `${name}=${dotenvValues[name]}`).join("\n")}\n`,
        { mode: 0o600 },
      );

      const nodeShim = join(binDir, "node");
      await writeFile(nodeShim, `#!/bin/bash
set -euo pipefail
if [ "\${1-}" = "-p" ]; then
  printf '24\\n'
  exit 0
fi
for name in ${MOVER_AUTHORITY_ENV.join(" ")}; do
  expected_name="TEST_EXPECT_\${name}"
  if [ "\${!name+x}" != x ] || [ "\${!name}" != "\${!expected_name}" ]; then
    printf 'authority mismatch: %s\\n' "\${name}" >&2
    exit 42
  fi
done
printf 'wrapper-ok\\n'
`, { mode: 0o755 });
      const pnpmShim = join(binDir, "pnpm");
      await writeFile(pnpmShim, "#!/bin/bash\nexit 0\n", { mode: 0o755 });

      const callerValues: Record<(typeof MOVER_AUTHORITY_ENV)[number], string> = Object.fromEntries(
        MOVER_AUTHORITY_ENV.map((name, index) => [name, `caller-sentinel-${index}`]),
      ) as Record<(typeof MOVER_AUTHORITY_ENV)[number], string>;
      callerValues.NODE_ENV = "production";
      callerValues.MYSQL_URL = "mysql://caller-user:caller-secret@caller-db/caller";
      callerValues.BLOB_MIGRATION_COMMIT = "0";
      callerValues.BLOB_S3_SECRET_ACCESS_KEY = "";
      callerValues.AWS_PROFILE = "";

      const childEnv: NodeJS.ProcessEnv = {
        PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      };
      for (const name of MOVER_AUTHORITY_ENV) {
        childEnv[name] = callerValues[name];
        childEnv[`TEST_EXPECT_${name}`] = callerValues[name];
      }

      const result = spawnSync(wrapper, ["blob-storage-migrate", "run"], {
        cwd: root,
        encoding: "utf8",
        env: childEnv,
      });

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("wrapper-ok\n");
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
