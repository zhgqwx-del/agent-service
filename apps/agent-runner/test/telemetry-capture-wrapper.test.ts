import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const OPERATOR_KEYS = [
  "TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE",
  "TELEMETRY_CAPTURE_REF_KEY_FILE", "TELEMETRY_CAPTURE_LOCAL_ONLY_ACK",
  "TELEMETRY_CAPTURE_FLEET_STOPPED_ACK", "TELEMETRY_CAPTURE_LEGACY_WRITERS_DRAINED_ACK",
  "TELEMETRY_CAPTURE_PRODUCER_READY_ACK", "TELEMETRY_CAPTURE_CONFIGURED_FLEET_ROOT_SHA256",
  "TELEMETRY_CAPTURE_OPERATION_TIMEOUT_MS", "TELEMETRY_CAPTURE_TENANT_ID",
  "TELEMETRY_CAPTURE_SESSION_ID", "TELEMETRY_CAPTURE_TURN_ID", "TELEMETRY_CAPTURE_ITEM_ID",
  "TELEMETRY_CAPTURE_STEP_INDEX", "TELEMETRY_CAPTURE_FUTURE_PRIVATE_AUTHORITY",
] as const;
const AUTHORITY_KEYS = ["NODE_ENV", "MYSQL_URL", "RUNNERS", ...OPERATOR_KEYS,
  "TENANT_TELEMETRY_S3_ENDPOINT", "TENANT_TELEMETRY_S3_SECRET_ACCESS_KEY", "AWS_PROFILE",
  "PERSISTED_PROVIDER_FAILURE_CAPTURE_ENABLED", "PERSISTED_PROVIDER_FAILURE_CAPTURE_FLEET_ENABLED"] as const;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "capture-wrapper-"));
  const bin = join(root, "bin");
  await mkdir(join(root, "scripts"));
  await mkdir(bin);
  const wrapper = join(root, "scripts/local-service.sh");
  await copyFile(fileURLToPath(new URL("../../../scripts/local-service.sh", import.meta.url)), wrapper);
  await chmod(wrapper, 0o755);
  await writeFile(join(bin, "pnpm"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  return { root, bin, wrapper };
}

describe("local telemetry capture wrapper", () => {
  it("preserves every explicit caller authority including empty values ahead of .env", async () => {
    const { root, bin, wrapper } = await fixture();
    try {
      const dotenv = [...AUTHORITY_KEYS.map((key, i) => `${key}=dotenv-private-${i}`),
        "TENANT_TELEMETRY_REF_KEY=dotenv-application-hex-key"].join("\n");
      await writeFile(join(root, ".env"), dotenv, { mode: 0o600 });
      await writeFile(join(bin, "node"), `#!/bin/bash
set -euo pipefail
if [ "\${1-}" = "-p" ]; then printf '24\\n'; exit 0; fi
test "\${1-}" = --import && test "\${2-}" = tsx
test "\${3-}" = apps/agent-runner/src/telemetry-capture.ts && test "\${4-}" = status
test "\${TENANT_TELEMETRY_REF_KEY+x}" != x || exit 46
for name in ${AUTHORITY_KEYS.join(" ")}; do
  expected_name="EXPECT_\${name}"
  test "\${!name+x}" = x && test "\${!name}" = "\${!expected_name}" || exit 42
done
printf 'capture-wrapper-ok\\n'
`, { mode: 0o755 });
      const env: NodeJS.ProcessEnv = { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        TENANT_TELEMETRY_REF_KEY: "caller-application-hex-key" };
      for (const [i, key] of AUTHORITY_KEYS.entries()) {
        const value = key === "TENANT_TELEMETRY_S3_SECRET_ACCESS_KEY" || key === "AWS_PROFILE" ? "" : `caller-private-${i}`;
        env[key] = value;
        env[`EXPECT_${key}`] = value;
      }
      const result = spawnSync(wrapper, ["telemetry-capture", "status"], { cwd: root, env, encoding: "utf8", timeout: 5_000 });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("capture-wrapper-ok\n");
      expect(result.stderr).toBe("");
      expect(await readFile(join(root, ".env"), "utf8")).toBe(dotenv);
      expect(env.TENANT_TELEMETRY_REF_KEY).toBe("caller-application-hex-key");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("strips the complete operator prefix from both long-running services", async () => {
    const { root, bin, wrapper } = await fixture();
    try {
      await mkdir(join(root, "deploy/local"), { recursive: true });
      await writeFile(join(root, "deploy/local/infra.sh"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
      await writeFile(join(root, ".env"), [...OPERATOR_KEYS.map((key) => `${key}=private-must-not-reach-service`),
        "PERSISTED_PROVIDER_FAILURE_CAPTURE_ENABLED=1", "PERSISTED_PROVIDER_FAILURE_CAPTURE_FLEET_ENABLED=1"].join("\n"), { mode: 0o600 });
      const runnerResult = join(root, "runner-result");
      const routerResult = join(root, "router-result");
      await writeFile(join(bin, "node"), `#!/bin/bash
set -euo pipefail
if [ "\${1-}" = "-p" ]; then printf '24\\n'; exit 0; fi
case "\${3-}" in
  apps/agent-runner/src/main.ts)
    result_file="$TEST_RUNNER_RESULT"
    test "\${PERSISTED_PROVIDER_FAILURE_CAPTURE_FLEET_ENABLED+x}" != x || exit 47
    test "\${PERSISTED_PROVIDER_FAILURE_CAPTURE_ENABLED-}" = 0 || exit 48 ;;
  apps/agent-router/src/main.ts)
    result_file="$TEST_ROUTER_RESULT"
    test "\${PERSISTED_PROVIDER_FAILURE_CAPTURE_ENABLED+x}" != x || exit 49
    test "\${PERSISTED_PROVIDER_FAILURE_CAPTURE_FLEET_ENABLED-}" = 0 || exit 50 ;;
  *) exit 43 ;;
esac
for name in ${OPERATOR_KEYS.join(" ")}; do test "\${!name+x}" != x || exit 44; done
printf 'scrubbed\\n' >"$result_file"
`, { mode: 0o755 });
      await writeFile(join(bin, "curl"), `#!/bin/bash
case "$*" in
  *8787*) test -f "$TEST_RUNNER_RESULT" ;;
  *8080*) test -f "$TEST_ROUTER_RESULT" ;;
  *) exit 45 ;;
esac
`, { mode: 0o755 });
      const result = spawnSync(wrapper, ["start"], { cwd: root, encoding: "utf8", timeout: 10_000,
        env: { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, TEST_RUNNER_RESULT: runnerResult, TEST_ROUTER_RESULT: routerResult,
          // Mock-only startup preconditions; this does not prove native metadata or ACLs.
          MYSQL_SCHEMA_METADATA_SCHEMA: "capture_wrapper_metadata", MYSQL_SCHEMA_METADATA_DEFINER_USER: "capture_wrapper_definer",
          MYSQL_SCHEMA_METADATA_DEFINER_HOST: "localhost",
          PERSISTED_PROVIDER_FAILURE_CAPTURE_ENABLED: "0", PERSISTED_PROVIDER_FAILURE_CAPTURE_FLEET_ENABLED: "0" } });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(await readFile(runnerResult, "utf8")).toBe("scrubbed\n");
      expect(await readFile(routerResult, "utf8")).toBe("scrubbed\n");
      expect(result.stdout + result.stderr).not.toContain("private-must-not-reach-service");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
