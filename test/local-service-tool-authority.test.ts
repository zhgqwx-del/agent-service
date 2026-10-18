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
  "HOOKS_ALLOW_LOOPBACK_FOR_TESTS", "HOOKS_FUTURE_RUNTIME_AUTHORITY"] as const;
const shared = ["MCP_REGISTRY_ENABLED", "MCP_REGISTRY_CREDENTIAL_KEY_ID",
  "MCP_REGISTRY_OAUTH_CALLBACK_URL", "MCP_ALLOW_LOOPBACK_FOR_TESTS",
  "HOOKS_MASTER_KEY_ID", "TENANT_HOOKS_ENABLED"] as const;
const operator = "MCP_REGISTRY_OPERATOR_TOKEN";

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
  it.each(["0", "1", ""] as const)("dist boot clears all optional tool families, including explicit %j values, before actual role parsing", enabled => {
    const input: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: "/fixture/kept-path", KEEP_ME: "fixture-kept-value",
      MCP_REGISTRY_ENABLED: enabled, HOOKS_ENABLED: enabled, TENANT_HOOKS_ENABLED: enabled,
      MCP_REGISTRY_CREDENTIAL_KEY_FILE: "/fixture/never-read/mcp-key", MCP_REGISTRY_OPERATOR_TOKEN: "fixture-mcp-operator",
      MCP_SERVERS_JSON: "fixture-invalid-json", MCP_FUTURE_CREDENTIAL: "fixture-future-credential",
      MCP_ALLOW_LOOPBACK_FOR_TESTS: "1", HOOKS_CONFIG_JSON: "fixture-invalid-json",
      HOOKS_MASTER_KEY_FILE: "/fixture/never-read/hooks-key", HOOKS_MASTER_KEY_ID: "fixture-hooks-key-id",
      HOOKS_FUTURE_RUNTIME_AUTHORITY: "fixture-future-authority", TENANT_HOOKS_FUTURE_AUTHORITY: "fixture-future-authority",
      SECRETS_MASTER_KEY: "fixture-ambient-master", REDIS_URL: "fixture-ambient-redis",
      MYSQL_URL: "fixture-ambient-mysql", AWS_SECRET_ACCESS_KEY: "fixture-ambient-aws" };
    const original = { ...input };
    const cleaned = cleanDistBootEnv(input);
    expect(cleaned).toEqual({ NODE_ENV: "test", PATH: "/fixture/kept-path", KEEP_ME: "fixture-kept-value" });
    expect(input).toEqual(original);
    expect(Object.keys(cleaned).filter(key => ["MCP_", "HOOKS_", "TENANT_HOOKS_"].some(prefix => key.startsWith(prefix)))).toEqual([]);
    // These are the real source parsers. The helper does not load a key file, resolve DNS,
    // start a service, or relax the router's rejection of runner-only authority (even "0").
    expect(() => loadRouterConfig({ NODE_ENV: "test", RUNNERS: "http://127.0.0.1:8787", HOOKS_ENABLED: "0" }))
      .toThrow("Managed tenant hooks secret/runtime configuration is runner-only");
    expect(loadRouterConfig({ ...cleaned, RUNNERS: "http://127.0.0.1:8787" }))
      .toMatchObject({ MCP_REGISTRY_ENABLED: false, TENANT_HOOKS_ENABLED: false });
    const runner = loadConfig({ ...cleaned, STORE: "memory", SECRETS_MASTER_KEY: "77".repeat(32) });
    expect(runner.hooks.enabled).toBe(false); expect(runner.tenantHooks.enabled).toBe(false);
    expect(runner.mcpRegistry.enabled).toBe(false);
  });

  for (const enabled of ["0", "1"] as const) it(`distributes only role authority and preserves explicit caller values (${enabled})`, async () => {
    const f = await fixture();
    try {
      const names = [...shared, ...runnerOnly, operator];
      const dotenv = Object.fromEntries(names.map(name => [name, `dotenv-${sentinel(name)}`]));
      const caller = Object.fromEntries(names.map(name => [name, sentinel(name)]));
      caller.MCP_REGISTRY_ENABLED = enabled;
      caller.TENANT_HOOKS_ENABLED = enabled;
      caller.MCP_REGISTRY_POOL_TTL_MS = "";
      await writeFile(join(f.root, ".env"), names.map(name => `${name}=${quote(dotenv[name]!)}`).join("\n") + "\n", { mode: 0o600 });
      const checks = (role: "runner" | "router") => names.map(name => {
        const absent = role === "runner" ? name === operator : (runnerOnly as readonly string[]).includes(name);
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
      const names = [...shared, ...runnerOnly, operator, "MCP_FUTURE_CREDENTIAL",
        "TENANT_HOOKS_FUTURE_AUTHORITY"];
      const dotenv = Object.fromEntries(names.map(name => [name, `dotenv-${sentinel(name)}`]));
      await writeFile(join(f.root, ".env"), names.map(name => `${name}=${quote(dotenv[name]!)}`).join("\n")
        + "\nAPI_KEY=fixture-not-an-upstream-key\n", { mode: 0o600 });
      const assertion = `
for candidate_name in $(compgen -e); do
  case "$candidate_name" in
    MCP_REGISTRY_ENABLED|HOOKS_ENABLED|TENANT_HOOKS_ENABLED)
      test "\${!candidate_name}" = 0 || exit 76 ;;
    MCP_*|HOOKS_*|TENANT_HOOKS_*)
      printf 'leaked-name:%s\\n' "$candidate_name" >&2; exit 77 ;;
  esac
done
test "$MCP_REGISTRY_ENABLED" = 0
test "$HOOKS_ENABLED" = 0
test "$TENANT_HOOKS_ENABLED" = 0`;
      await f.executable(join(f.bin, "node"), `if [ "\${1-}" = "-p" ]; then printf '24\\n'; exit 0; fi\nexit 78`);
      await f.executable(join(f.root, "deploy", "local", "infra.sh"), assertion + "\nexit 0");
      // Deliberately stop at the first pnpm command; no suite, infra or model is executed.
      await f.executable(join(f.bin, "pnpm"), assertion + "\nprintf 'tool-authority-cleared\\n'\nexit 73");
      const result = spawnSync("/bin/bash", [f.wrapper, command], { cwd: f.root,
        env: { ...baseEnv(f.bin), MCP_REGISTRY_ENABLED: "1", HOOKS_ENABLED: "1",
          TENANT_HOOKS_ENABLED: "1", MCP_REGISTRY_POOL_TTL_MS: "" },
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
