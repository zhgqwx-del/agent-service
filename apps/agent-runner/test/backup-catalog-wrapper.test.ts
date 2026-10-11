import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CATALOG_PROCESS_AUTHORITY_ENV = [
  "BACKUP_CATALOG_ADAPTER",
  "BACKUP_CATALOG_DATABASE_NAMESPACE_ID",
  "BACKUP_CATALOG_NAMESPACE_ID",
  "BACKUP_CATALOG_FAILURE_DOMAIN_ID",
  "BACKUP_CATALOG_INDEPENDENT_FAILURE_DOMAIN_ACK",
  "BACKUP_CATALOG_S3_ENDPOINT",
  "BACKUP_CATALOG_S3_REGION",
  "BACKUP_CATALOG_S3_BUCKET",
  "BACKUP_CATALOG_S3_PREFIX",
  "BACKUP_CATALOG_S3_FORCE_PATH_STYLE",
  "BACKUP_CATALOG_S3_PRIVATE_BUCKET_ACK",
  "BACKUP_CATALOG_S3_REQUEST_TIMEOUT_MS",
  "BACKUP_CATALOG_S3_ACCESS_KEY_ID",
  "BACKUP_CATALOG_S3_SECRET_ACCESS_KEY",
  "BACKUP_CATALOG_S3_SESSION_TOKEN",
  "BACKUP_CATALOG_MINIMUM_RETENTION_MS",
  "BACKUP_CATALOG_MINIMUM_RECOVERABLE_BACKUPS",
  "BACKUP_CATALOG_ACTIVATION_ACK",
  "BACKUP_CATALOG_PAGE_SIZE",
  "BACKUP_CATALOG_AFTER_BACKUP_ID",
  "TENANT_BACKUP_CATALOG_DEBUG_AUTHORITY",
  "BACKUP_ID",
  "BACKUP_RUNTIME_EPOCH_ID",
  "SOURCE_SNAPSHOT_SHA256",
  "SOURCE_BACKUP_SHA256",
  "BACKUP_ARTIFACT_MANIFEST_SHA256",
  "BACKUP_PROVIDER_EVIDENCE_SHA256",
  "BACKUP_EVICTION_ID",
  "EXTERNAL_TOMBSTONE_SHA256",
  "BACKUP_PHYSICAL_ABSENCE_ACK",
  "RESTORE_RUN_ID",
  "RESTORE_FLEET_STOPPED_ACK",
] as const;

const CATALOG_COMMAND_AUTHORITY_ENV = [
  "NODE_ENV",
  "MYSQL_URL",
  ...CATALOG_PROCESS_AUTHORITY_ENV,
  "BLOB_STORE",
  "BLOB_S3_BUCKET",
  "RESTORE_JOURNAL_S3_BUCKET",
  "RESTORE_JOURNAL_RUNTIME_EPOCH_ID",
  "AWS_PROFILE",
  "AWS_ENDPOINT_URL_S3",
] as const;

async function prepareWrapperRoot(prefix: string): Promise<{
  root: string;
  binDir: string;
  wrapper: string;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
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
  return { root, binDir, wrapper };
}

describe("local backup-catalog wrapper", () => {
  it("keeps explicit caller authority, including empty values, ahead of .env without echoing it", async () => {
    const { root, binDir, wrapper } = await prepareWrapperRoot(
      "agent-service-backup-catalog-wrapper-",
    );
    try {
      const dotenvValues = Object.fromEntries(
        CATALOG_COMMAND_AUTHORITY_ENV.map((name, index) => [
          name,
          `dotenv-backup-catalog-sentinel-${index}`,
        ]),
      );
      await writeFile(
        join(root, ".env"),
        `${CATALOG_COMMAND_AUTHORITY_ENV.map((name) => `${name}=${dotenvValues[name]}`).join("\n")}\n`,
        { mode: 0o600 },
      );

      await writeFile(join(binDir, "node"), `#!/bin/bash
set -euo pipefail
if [ "\${1-}" = "-p" ]; then
  printf '24\\n'
  exit 0
fi
if [ "\${1-}" != "--import" ] \\
  || [ "\${2-}" != "tsx" ] \\
  || [ "\${3-}" != "apps/agent-runner/src/backup-catalog.ts" ] \\
  || [ "\${4-}" != "status" ]; then
  printf 'unexpected backup-catalog wrapper arguments\\n' >&2
  exit 41
fi
for name in ${CATALOG_COMMAND_AUTHORITY_ENV.join(" ")}; do
  expected_name="TEST_EXPECT_\${name}"
  if [ "\${!name+x}" != x ] || [ "\${!name}" != "\${!expected_name}" ]; then
    printf 'authority mismatch: %s\\n' "\${name}" >&2
    exit 42
  fi
done
printf 'backup-catalog-wrapper-ok\\n'
`, { mode: 0o755 });
      await writeFile(join(binDir, "pnpm"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });

      const callerValues = Object.fromEntries(
        CATALOG_COMMAND_AUTHORITY_ENV.map((name, index) => [
          name,
          `caller-backup-catalog-sentinel-${index}`,
        ]),
      ) as Record<(typeof CATALOG_COMMAND_AUTHORITY_ENV)[number], string>;
      callerValues.NODE_ENV = "production";
      callerValues.MYSQL_URL = "mysql://caller-user:caller-secret@caller-db/catalog";
      callerValues.BACKUP_CATALOG_S3_SECRET_ACCESS_KEY = "";
      callerValues.BACKUP_CATALOG_S3_SESSION_TOKEN = "";
      callerValues.AWS_PROFILE = "";

      const childEnv: NodeJS.ProcessEnv = {
        PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      };
      for (const name of CATALOG_COMMAND_AUTHORITY_ENV) {
        childEnv[name] = callerValues[name];
        childEnv[`TEST_EXPECT_${name}`] = callerValues[name];
      }

      const result = spawnSync(wrapper, ["backup-catalog", "status"], {
        cwd: root,
        encoding: "utf8",
        env: childEnv,
      });

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toBe("backup-catalog-wrapper-ok\n");
      expect(result.stderr).toBe("");
      for (const value of [
        ...Object.values(dotenvValues),
        ...Object.values(callerValues),
      ].filter((value) => value !== "")) {
        expect(result.stdout).not.toContain(value);
        expect(result.stderr).not.toContain(value);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("scrubs catalog and operation authority from long-running runner and router processes", async () => {
    const { root, binDir, wrapper } = await prepareWrapperRoot(
      "agent-service-backup-catalog-process-scrub-",
    );
    try {
      const deployDir = join(root, "deploy", "local");
      await mkdir(deployDir, { recursive: true });
      await writeFile(join(deployDir, "infra.sh"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
      const sentinels = Object.fromEntries(
        CATALOG_PROCESS_AUTHORITY_ENV.map((name, index) => [
          name,
          `must-not-reach-service-${index}`,
        ]),
      );
      await writeFile(
        join(root, ".env"),
        `${CATALOG_PROCESS_AUTHORITY_ENV.map((name) => `${name}=${sentinels[name]}`).join("\n")}\n`,
        { mode: 0o600 },
      );

      const runnerResult = join(root, "runner-env-result");
      const routerResult = join(root, "router-env-result");
      await writeFile(join(binDir, "node"), `#!/bin/bash
set -euo pipefail
if [ "\${1-}" = "-p" ]; then
  printf '24\\n'
  exit 0
fi
case "\${3-}" in
  apps/agent-runner/src/main.ts) result_file="$TEST_RUNNER_RESULT" ;;
  apps/agent-router/src/main.ts) result_file="$TEST_ROUTER_RESULT" ;;
  *) exit 43 ;;
esac
for name in ${CATALOG_PROCESS_AUTHORITY_ENV.join(" ")}; do
  if [ "\${!name+x}" = x ]; then
    printf 'leaked:%s\\n' "\${name}" >"$result_file"
    exit 44
  fi
done
printf 'scrubbed\\n' >"$result_file"
`, { mode: 0o755 });
      await writeFile(join(binDir, "pnpm"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
      await writeFile(join(binDir, "curl"), `#!/bin/bash
case "$*" in
  *8787*) test -f "$TEST_RUNNER_RESULT" ;;
  *8080*) test -f "$TEST_ROUTER_RESULT" ;;
  *) exit 45 ;;
esac
`, { mode: 0o755 });

      const childEnv: NodeJS.ProcessEnv = {
        PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        TEST_RUNNER_RESULT: runnerResult,
        TEST_ROUTER_RESULT: routerResult,
      };
      for (const [name, value] of Object.entries(sentinels)) childEnv[name] = value;
      const result = spawnSync(wrapper, ["start"], {
        cwd: root,
        encoding: "utf8",
        env: childEnv,
      });
      const runnerLog = await readFile(join(root, ".local-run", "runner.log"), "utf8")
        .catch(() => "<missing runner log>");
      const routerLog = await readFile(join(root, ".local-run", "router.log"), "utf8")
        .catch(() => "<missing router log>");

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(
        result.status,
        `${result.stdout}\n${result.stderr}\nrunner:\n${runnerLog}\nrouter:\n${routerLog}`,
      ).toBe(0);
      expect(await readFile(runnerResult, "utf8")).toBe("scrubbed\n");
      expect(await readFile(routerResult, "utf8")).toBe("scrubbed\n");
      for (const value of Object.values(sentinels)) {
        expect(result.stdout).not.toContain(value);
        expect(result.stderr).not.toContain(value);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
