import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../apps/agent-runner/src/config.js";
import { loadRouterConfig } from "../apps/agent-router/src/config.js";

let cleanDistBootEnv: (input: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
beforeAll(async () => {
  ({ cleanDistBootEnv } = await import(new URL("../scripts/lib/dist-boot-env.mjs", import.meta.url).href) as {
    cleanDistBootEnv(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  });
});

const wrapperSource = fileURLToPath(new URL("../scripts/local-service.sh", import.meta.url));
const sentinel = (name: string) => `fixture-${name.toLowerCase().replaceAll("_", "-")}`;
const runnerOnly = ["MCP_REGISTRY_CREDENTIAL_KEY_FILE", "MCP_REGISTRY_POOL_TTL_MS",
  "MCP_REGISTRY_POOL_MAX_ENTRIES", "MCP_SERVERS_JSON", "MCP_TIMEOUT_MS",
  "MCP_MAX_CONCURRENT_PER_USER", "HOOKS_MASTER_KEY_FILE", "HOOKS_ENABLED",
  "HOOKS_CONFIG_JSON", "HOOKS_TIMEOUT_MS", "HOOKS_MAX_CONCURRENT_PER_USER",
  "HOOKS_ALLOW_LOOPBACK_FOR_TESTS", "HOOKS_FUTURE_RUNTIME_AUTHORITY",
  "LIFECYCLE_HOOKS_CONFIG_JSON", "LIFECYCLE_HOOKS_TIMEOUT_MS", "LIFECYCLE_HOOKS_MAX_CONCURRENT_PER_USER",
  "SUBAGENTS_MAX_DEPTH", "SUBAGENTS_MAX_CONCURRENT", "SUBAGENTS_MAX_TASKS",
  "PLATFORM_PROVIDER_KEY_POOL_FILE", "PLATFORM_PROVIDER_KEY_POOL_FUTURE_AUTHORITY", "PLATFORM_PROVIDER_BREAKER_JSON", "PLATFORM_PROVIDER_BREAKER_FUTURE_AUTHORITY",
  "PLATFORM_PROVIDER_FALLBACK_JSON", "PLATFORM_PROVIDER_FALLBACK_FUTURE_AUTHORITY",
  "MYSQL_SCHEMA_METADATA_SCHEMA", "MYSQL_SCHEMA_METADATA_DEFINER_USER", "MYSQL_SCHEMA_METADATA_DEFINER_HOST"] as const;
const shared = ["MCP_REGISTRY_ENABLED", "MCP_REGISTRY_CREDENTIAL_KEY_ID",
  "MCP_REGISTRY_OAUTH_CALLBACK_URL", "MCP_ALLOW_LOOPBACK_FOR_TESTS",
  "HOOKS_MASTER_KEY_ID", "TENANT_HOOKS_ENABLED", "LIFECYCLE_HOOKS_ENABLED", "SUBAGENTS_ENABLED"] as const;
const operator = "MCP_REGISTRY_OPERATOR_TOKEN";
const schemaOperator = ["SCHEMA_MYSQL_URL", "SCHEMA_METADATA_SCHEMA", "SCHEMA_FLEET_STOPPED_ACK", "SCHEMA_FUTURE_AUTHORITY",
  "AGENT_SERVICE_MIGRATIONS_DIR", "MYSQL_PWD", "MYSQL_TEST_URL", "MYSQL_TEST_AUTHORITY_ACK", "MYSQL_TEST_OWNED_SERVER_UUID"] as const;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agent-service-tool-env-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "deploy", "local"), { recursive: true });
  const wrapper = join(root, "scripts", "local-service.sh");
  await copyFile(wrapperSource, wrapper);
  const executable = async (path: string, body: string) => writeFile(path,
    `#!/bin/bash\nset -euo pipefail\n${body}\n`, { mode: 0o755 });
  await executable(join(root, "deploy", "local", "infra.sh"), "exit 0");
  await executable(join(bin, "pnpm"), "exit 0");
  return { root, bin, wrapper, executable };
}

function baseEnv(bin: string): NodeJS.ProcessEnv {
  return { PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`, HOME: process.env.HOME,
    TMPDIR: tmpdir(), NODE_ENV: "test" };
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

describe("local-service optional tool authority", () => {
  it.each(["migrate", "verify", "install-metadata", "--help"] as const)
    ("forwards schema %s only as a foreground command without starting infrastructure", async command => {
      const f = await fixture();
      try {
        await writeFile(join(f.root, ".env"), "SCHEMA_MYSQL_URL='fixture-dotenv-operator'\nSCHEMA_FLEET_STOPPED_ACK='fixture-dotenv-ack'\n", { mode: 0o600 });
        await f.executable(join(f.root, "deploy", "local", "infra.sh"), "exit 81");
        await f.executable(join(f.bin, "node"), `
if [ "\${1-}" = "-p" ]; then printf '24\\n'; exit 0; fi
test "$#" = 5 && test "$1" = --import && test "$2" = tsx
test "$3" = apps/agent-runner/src/main.ts && test "$4" = schema && test "$5" = ${quote(command)}
test "$SCHEMA_MYSQL_URL" = fixture-caller-operator && test "\${SCHEMA_FLEET_STOPPED_ACK+x}" = x && test -z "$SCHEMA_FLEET_STOPPED_ACK"
printf 'foreground-only\\n' >"$TEST_SCHEMA_RESULT"`);
        const result = spawnSync("/bin/bash", [f.wrapper, "schema", command], { cwd: f.root, encoding: "utf8", timeout: 10_000,
          env: { ...baseEnv(f.bin), SCHEMA_MYSQL_URL: "fixture-caller-operator", SCHEMA_FLEET_STOPPED_ACK: "",
            TEST_SCHEMA_RESULT: join(f.root, "schema-result") } });
        expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status).toBe(0);
        expect(await readFile(join(f.root, "schema-result"), "utf8")).toBe("foreground-only\n");
        expect(result.stdout).not.toMatch(/fixture-(?:caller|dotenv)/); expect(result.stderr).not.toMatch(/fixture-(?:caller|dotenv)/);
      } finally { await rm(f.root, { recursive: true, force: true }); }
    });

  it("refuses start before infrastructure or runtime when explicit metadata settings are missing", async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.root, ".env"), "MYSQL_URL='fixture-never-opened-dsn'\n", { mode: 0o600 });
      await f.executable(join(f.root, "deploy", "local", "infra.sh"), "exit 81");
      await f.executable(join(f.bin, "node"), `if [ "\${1-}" = "-p" ]; then printf '24\\n'; exit 0; fi\nexit 82`);
      const result = spawnSync("/bin/bash", [f.wrapper, "start"], { cwd: f.root, env: baseEnv(f.bin), encoding: "utf8", timeout: 10_000 });
      expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status).toBe(1);
      expect(result.stderr).toContain("explicit MySQL runtime metadata configuration is required");
      expect(result.stdout).not.toContain("fixture-never-opened-dsn"); expect(result.stderr).not.toContain("fixture-never-opened-dsn");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it.each(["0", "1", ""] as const)("dist boot clears all optional tool families, including explicit %j values, before actual role parsing", enabled => {
    const input: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: "/fixture/kept-path", KEEP_ME: "fixture-kept-value",
      MCP_REGISTRY_ENABLED: enabled, HOOKS_ENABLED: enabled, TENANT_HOOKS_ENABLED: enabled,
      LIFECYCLE_HOOKS_ENABLED: enabled, SUBAGENTS_ENABLED: enabled,
      PROVIDER_GATEWAY_ENABLED: enabled, PROVIDER_GATEWAY_POLICY_SHA256: "fixture-ambient-policy",
      PROVIDER_TENANT_QUOTA_JSON: "fixture-ambient-quota", PROVIDER_USER_QUOTA_JSON: "fixture-ambient-quota",
      PLATFORM_PROVIDER_QUOTA_JSON: "fixture-ambient-quota", PROVIDER_GATEWAY_FUTURE_AUTHORITY: "fixture-ambient-authority",
      PLATFORM_PROVIDER_KEY_POOL_FILE: "/fixture/never-read/provider-pool", PLATFORM_PROVIDER_BREAKER_JSON: "fixture-invalid-breaker",
      PLATFORM_PROVIDER_KEY_POOL_FUTURE: "fixture-future-key", PLATFORM_PROVIDER_BREAKER_FUTURE: "fixture-future-breaker",
      PLATFORM_PROVIDER_FALLBACK_JSON: "fixture-invalid-mapping", PLATFORM_PROVIDER_FALLBACK_FUTURE: "fixture-future-mapping",
      LIFECYCLE_HOOKS_CONFIG_JSON: "fixture-invalid-json", SUBAGENTS_MAX_DEPTH: "fixture-invalid-depth",
      LIFECYCLE_HOOKS_FUTURE_AUTHORITY: "fixture-future-authority", SUBAGENTS_FUTURE_AUTHORITY: "fixture-future-authority",
      MCP_REGISTRY_CREDENTIAL_KEY_FILE: "/fixture/never-read/mcp-key", MCP_REGISTRY_OPERATOR_TOKEN: "fixture-mcp-operator",
      MCP_SERVERS_JSON: "fixture-invalid-json", MCP_FUTURE_CREDENTIAL: "fixture-future-credential",
      MCP_ALLOW_LOOPBACK_FOR_TESTS: "1", HOOKS_CONFIG_JSON: "fixture-invalid-json",
      HOOKS_MASTER_KEY_FILE: "/fixture/never-read/hooks-key", HOOKS_MASTER_KEY_ID: "fixture-hooks-key-id",
      HOOKS_FUTURE_RUNTIME_AUTHORITY: "fixture-future-authority", TENANT_HOOKS_FUTURE_AUTHORITY: "fixture-future-authority",
      SECRETS_MASTER_KEY: "fixture-ambient-master", REDIS_URL: "fixture-ambient-redis",
      MYSQL_URL: "fixture-ambient-mysql", AWS_SECRET_ACCESS_KEY: "fixture-ambient-aws",
      MYSQL_SCHEMA_METADATA_SCHEMA: "fixture-ambient-metadata", SCHEMA_MYSQL_URL: "fixture-operator-mysql",
      SCHEMA_FUTURE_AUTHORITY: "fixture-operator-future", AGENT_SERVICE_MIGRATIONS_DIR: "fixture-operator-directory" };
    const original = { ...input };
    const cleaned = cleanDistBootEnv(input);
    expect(cleaned).toEqual({ NODE_ENV: "test", PATH: "/fixture/kept-path", KEEP_ME: "fixture-kept-value" });
    expect(input).toEqual(original);
    expect(Object.keys(cleaned).filter(key => ["MCP_", "HOOKS_", "TENANT_HOOKS_", "LIFECYCLE_HOOKS_", "SUBAGENTS_"].some(prefix => key.startsWith(prefix)))).toEqual([]);
    // These are the real source parsers. The helper does not load a key file, resolve DNS,
    // start a service, or relax the router's rejection of runner-only authority (even "0").
    expect(() => loadRouterConfig({ NODE_ENV: "test", RUNNERS: "http://127.0.0.1:8787", HOOKS_ENABLED: "0" }))
      .toThrow("Managed tenant hooks secret/runtime configuration is runner-only");
    expect(loadRouterConfig({ ...cleaned, RUNNERS: "http://127.0.0.1:8787" }))
      .toMatchObject({ MCP_REGISTRY_ENABLED: false, TENANT_HOOKS_ENABLED: false });
    const runner = loadConfig({ ...cleaned, STORE: "memory", SECRETS_MASTER_KEY: "77".repeat(32) });
    expect(runner.hooks.enabled).toBe(false); expect(runner.tenantHooks.enabled).toBe(false);
    expect(runner.mcpRegistry.enabled).toBe(false);
    expect(runner.lifecycleHooks.enabled).toBe(false); expect(runner.subagents.enabled).toBe(false);
  });

  for (const enabled of ["0", "1"] as const) it(`distributes only role authority and preserves explicit caller values (${enabled})`, async () => {
    const f = await fixture();
    try {
      const names = [...shared, ...runnerOnly, operator, ...schemaOperator];
      const dotenv = Object.fromEntries(names.map(name => [name, `dotenv-${sentinel(name)}`]));
      const caller = Object.fromEntries(names.map(name => [name, sentinel(name)]));
      caller.MCP_REGISTRY_ENABLED = enabled;
      caller.TENANT_HOOKS_ENABLED = enabled;
      caller.LIFECYCLE_HOOKS_ENABLED = enabled;
      caller.SUBAGENTS_ENABLED = enabled;
      caller.MCP_REGISTRY_POOL_TTL_MS = "";
      await writeFile(join(f.root, ".env"), names.map(name => `${name}=${quote(dotenv[name]!)}`).join("\n") + "\n", { mode: 0o600 });
      const checks = (role: "runner" | "router") => names.map(name => {
        const absent = (schemaOperator as readonly string[]).includes(name)
          || (role === "runner" ? name === operator : (runnerOnly as readonly string[]).includes(name));
        return absent
          ? `test "\${${name}+x}" != x || { printf 'leaked-name:%s\\n' ${quote(name)} >"$result_file"; exit 71; }`
          : `test "\${${name}+x}" = x && test "\$${name}" = ${quote(caller[name]!)} || { printf 'wrong-name:%s\\n' ${quote(name)} >"$result_file"; exit 72; }`;
      }).join("\n");
      await f.executable(join(f.bin, "node"), `
if [ "\${1-}" = "-p" ]; then printf '24\\n'; exit 0; fi
case "\${3-}" in
  apps/agent-runner/src/main.ts)
    result_file="$TEST_RUNNER_RESULT"
    ${checks("runner")}
    ;;
  apps/agent-router/src/main.ts)
    result_file="$TEST_ROUTER_RESULT"
    ${checks("router")}
    ;;
  *) exit 74 ;;
esac
printf 'role-closed\\n' >"$result_file"`);
      await f.executable(join(f.bin, "curl"), `
case "$*" in
  *8787*) test -f "$TEST_RUNNER_RESULT" ;;
  *8080*) test -f "$TEST_ROUTER_RESULT" ;;
  *) exit 75 ;;
esac`);
      const result = spawnSync("/bin/bash", [f.wrapper, "start"], { cwd: f.root,
        env: { ...baseEnv(f.bin), ...caller, TEST_RUNNER_RESULT: join(f.root, "runner-result"),
          TEST_ROUTER_RESULT: join(f.root, "router-result") }, encoding: "utf8", timeout: 10_000 });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(await readFile(join(f.root, "runner-result"), "utf8")).toBe("role-closed\n");
      expect(await readFile(join(f.root, "router-result"), "utf8")).toBe("role-closed\n");
      for (const value of [...Object.values(dotenv), ...Object.values(caller)].filter(value => value.length > 1)) {
        expect(result.stdout).not.toContain(value);
        expect(result.stderr).not.toContain(value);
      }
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  for (const command of ["verify", "verify-s3", "verify-real"] as const) it(`clears ambient tool authority before ${command} subprocesses`, async () => {
    const f = await fixture();
    try {
      const names = [...shared, ...runnerOnly, operator, ...schemaOperator, "MCP_FUTURE_CREDENTIAL",
        "TENANT_HOOKS_FUTURE_AUTHORITY", "LIFECYCLE_HOOKS_FUTURE_AUTHORITY", "SUBAGENTS_FUTURE_AUTHORITY"];
      const dotenv = Object.fromEntries(names.map(name => [name, `dotenv-${sentinel(name)}`]));
      await writeFile(join(f.root, ".env"), names.map(name => `${name}=${quote(dotenv[name]!)}`).join("\n")
        + "\nAPI_KEY=fixture-not-an-upstream-key\n", { mode: 0o600 });
      const assertion = `
for candidate_name in $(compgen -e); do
  case "$candidate_name" in
    MCP_REGISTRY_ENABLED|HOOKS_ENABLED|TENANT_HOOKS_ENABLED|LIFECYCLE_HOOKS_ENABLED|SUBAGENTS_ENABLED)
      test "\${!candidate_name}" = 0 || exit 76 ;;
    SCHEMA_*|MYSQL_SCHEMA_METADATA_*|AGENT_SERVICE_MIGRATIONS_DIR|MCP_*|HOOKS_*|TENANT_HOOKS_*|LIFECYCLE_HOOKS_*|SUBAGENTS_*|PLATFORM_PROVIDER_KEY_POOL_*|PLATFORM_PROVIDER_BREAKER_*|PLATFORM_PROVIDER_FALLBACK_*)
      printf 'leaked-name:%s\\n' "$candidate_name" >&2; exit 77 ;;
  esac
done
test "$MCP_REGISTRY_ENABLED" = 0
test "$HOOKS_ENABLED" = 0
test "$TENANT_HOOKS_ENABLED" = 0
test "$LIFECYCLE_HOOKS_ENABLED" = 0
test "$SUBAGENTS_ENABLED" = 0`;
      await f.executable(join(f.bin, "node"), `if [ "\${1-}" = "-p" ]; then printf '24\\n'; exit 0; fi\nexit 78`);
      await f.executable(join(f.root, "deploy", "local", "infra.sh"), assertion + "\nexit 0");
      // Deliberately stop at the first pnpm command; no suite, infra or model is executed.
      await f.executable(join(f.bin, "pnpm"), assertion + "\nprintf 'tool-authority-cleared\\n'\nexit 73");
      const result = spawnSync("/bin/bash", [f.wrapper, command], { cwd: f.root,
        env: { ...baseEnv(f.bin), MCP_REGISTRY_ENABLED: "1", HOOKS_ENABLED: "1",
          TENANT_HOOKS_ENABLED: "1", LIFECYCLE_HOOKS_ENABLED: "1", SUBAGENTS_ENABLED: "1", MCP_REGISTRY_POOL_TTL_MS: "" },
        encoding: "utf8", timeout: 10_000 });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(73);
      expect(result.stdout).toContain("tool-authority-cleared");
      for (const value of Object.values(dotenv)) {
        expect(result.stdout).not.toContain(value);
        expect(result.stderr).not.toContain(value);
      }
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});
