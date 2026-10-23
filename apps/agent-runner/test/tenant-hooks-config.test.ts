import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { loadTenantHooksConfig } from "../src/tenant-hooks-config.js";
import { loadConfig } from "../src/config.js";

const configured = { TENANT_HOOKS_ENABLED: "1", HOOKS_MASTER_KEY_FILE: "/private/nonexistent-fixture-key" };
// Synthetic parser inputs only; no native metadata/account or actual-main startup is exercised here.
const fixtureMetadata = { MYSQL_SCHEMA_METADATA_SCHEMA: "mock_tenant_hooks_metadata",
  MYSQL_SCHEMA_METADATA_DEFINER_USER: "mock_tenant_hooks_definer", MYSQL_SCHEMA_METADATA_DEFINER_HOST: "localhost" };
describe("managed tenant hooks configuration", () => {
  it("defaults off and never opens even a supplied file reference", () => {
    expect(loadTenantHooksConfig({})).toEqual({ enabled: false, masterKeyId: "local-tenant-hooks-v1", timeoutMs: 1500,
      maxConcurrentPerUser: 2, allowLoopbackForTests: false });
    expect(loadTenantHooksConfig(configured).masterKeyFile).toBe(configured.HOOKS_MASTER_KEY_FILE);
    expect(Object.isFrozen(loadTenantHooksConfig(configured))).toBe(true);
  });
  it("wires the protected file-only configuration through real runner config, independently of legacy operator hooks", () => {
    const cfg = loadConfig({ ...configured, NODE_ENV: "test", SECRETS_MASTER_KEY: "69".repeat(32), ERASURE_ROUTER_URL: "http://127.0.0.1:8080" });
    expect(cfg.tenantHooks.enabled).toBe(true); expect(cfg.hooks.enabled).toBe(false);
    expect(() => loadConfig({ ...configured, NODE_ENV: "test", SECRETS_MASTER_KEY: "69".repeat(32) })).toThrow("ERASURE_ROUTER_URL is required");
  });
  it.each(["0", "1"])("rejects exact and normalized shared MCP key files even when MCP enabled=%s without opening either file", enabled => {
    const env = { ...configured, ...fixtureMetadata, NODE_ENV: "test", SECRETS_MASTER_KEY: "69".repeat(32), STORE: "mysql",
      REDIS_URL: "redis://127.0.0.1:6479", REDIS_NAMESPACE_ID: "hooks-key-file-config-test",
      ERASURE_ROUTER_URL: "http://127.0.0.1:8080", MCP_REGISTRY_ENABLED: enabled,
      MCP_REGISTRY_OAUTH_CALLBACK_URL: "https://runtime.example.test/v1/mcp/oauth/callback" };
    for (const path of [configured.HOOKS_MASTER_KEY_FILE, "/private/unused-directory/../nonexistent-fixture-key"]) {
      expect(() => loadConfig({ ...env, MCP_REGISTRY_CREDENTIAL_KEY_FILE: path }))
        .toThrow(/^Managed tenant hooks require an independent master key file$/);
    }
    const independent = loadConfig({ ...env, MCP_REGISTRY_CREDENTIAL_KEY_FILE: "/private/nonexistent-independent-mcp-key" });
    expect(independent.tenantHooks.masterKeyFile).toBe(configured.HOOKS_MASTER_KEY_FILE);
    expect(independent.mcpRegistry.credentialKeyFile).toBe("/private/nonexistent-independent-mcp-key");
    expect(independent.mcpRegistry.enabled).toBe(enabled === "1");
  });
  it("keeps Host drain before observer close and real service settlement before master-key zeroing", async () => {
    // Deliberately narrow static bootstrap contract, not an actual shutdown/network-drain proof.
    const main = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
    const closeStart = main.indexOf("const closeTenantHooks = async () => {");
    const closeEnd = main.indexOf("\n  };", closeStart);
    expect(closeStart).toBeGreaterThan(-1); expect(closeEnd).toBeGreaterThan(closeStart);
    expect(main.slice(closeStart, closeEnd)).toMatch(/try\s*\{\s*await tenantHooks\?\.close\(\);\s*\}\s*finally\s*\{\s*tenantHooksCipher\?\.close\(\);\s*\}/);
    const shutdownStart = main.indexOf("shutdownPromise = (async () => {");
    const shutdownEnd = main.indexOf("\n    })();", shutdownStart);
    expect(shutdownStart).toBeGreaterThan(-1); expect(shutdownEnd).toBeGreaterThan(shutdownStart);
    const shutdown = main.slice(shutdownStart, shutdownEnd);
    // Exact process-owner stages replace the former try/finally-only sequence. Host drain remains
    // first; cancellable Redis live hints and native input stop before HTTP/Host/observer joins.
    // All eight cipher users settle before their owning SQL store or cipher is closed; the final
    // bus close is an idempotent join of its earlier native cancellation.
    const drain = "await failures.stage([() => host.drain(30_000)]);";
    const nativeClose = 'await failures.stage([() => { if (!transportClosed && "closeAllConnections" in server) server.closeAllConnections(); }]);';
    const nativeJoin = "await failures.stage([() => serverClosed]);";
    const stops = `const stoppedTransports = failures.start([
          () => sseAdmission.close(),
          () => bus instanceof RedisEventBus ? bus.close() : undefined,
          () => mcp?.stop(), () => mcpRegistry?.stop(), () => tenantHooks?.stop(),
          () => hooks?.stop(), () => lifecycleHooks?.stop(),
          () => providerQuota?.stop(), () => providerPool?.stop(),
        ]);`;
    const users = "await failures.stage([() => host.settle(), () => httpOwner.settle(), () => stoppedTransports]);";
    const extensions = `await failures.stage([
          () => providerQuota?.close(), () => providerPool?.close(), () => mcp?.close(),
          () => closeMcpRegistry(), () => closeTenantHooks(), () => skills?.close(),
          () => hooks?.close(), () => lifecycleHooks?.close(),
        ]);`;
    const infrastructure = `await failures.stage([
          () => store.close(), () => bus.close(),
          () => tenantRedisPurgeAdapter?.close(),
          () => blobStore instanceof S3BlobStore ? blobStore.close() : undefined,
        ]);`;
    let previous = -1;
    for (const exact of [drain, "httpOwner.abort();", stops, nativeClose, nativeJoin, users, extensions,
      "await failures.stage([() => providerTenantTelemetry?.close()]);",
      "await failures.stage([() => tenantTelemetryWriterRuntime?.worker?.stop()]);",
      "await failures.stage([() => lifecycleOutbox.stop(), () => blobCleanup.stop()]);", infrastructure,
      "failures.throwIfAny();"]) {
      const at = shutdown.indexOf(exact); expect(at).toBeGreaterThan(previous); previous = at;
      expect(shutdown.indexOf(exact, at + exact.length)).toBe(-1);
    }
    expect(shutdown).not.toMatch(/Promise\.all(?:Settled)?\(\[[^\]]*host\.drain/);
    expect(shutdown).not.toContain("lease.close()"); // The owning store alone closes its authority.
    const owner = await readFile(new URL("../../../packages/protocol/src/process-owner.ts", import.meta.url), "utf8");
    expect(owner).toContain("if (!this.failed) { this.failed = true; this.first = reason; }");
    expect(owner).toContain("await Promise.allSettled(actions.map(action => Promise.resolve().then(action).catch(reason => {");
    expect(owner).toContain("throwIfAny(): void { if (this.failed) throw this.first; }");
  });
  it.each(["", "true", "2", "01"])("requires an explicit binary flag (%#)", TENANT_HOOKS_ENABLED => {
    expect(() => loadTenantHooksConfig({ ...configured, TENANT_HOOKS_ENABLED })).toThrow("Invalid managed tenant hooks configuration");
  });
  it.each(["", "relative-key", "/private/key\nvalue", "/" + "x".repeat(4096)])("rejects unsafe key references without reflecting the path (%#)", path => {
    expect(() => loadTenantHooksConfig({ ...configured, HOOKS_MASTER_KEY_FILE: path })).toThrow(/^Invalid managed tenant hooks configuration$/);
  });
  it.each(["HOOKS_MASTER_KEY", "HOOKS_MASTER_KEY_JSON", "HOOKS_MASTER_KEY_BYTES", "TENANT_HOOKS_HEADERS", "TENANT_HOOKS_PROXY"])(
    "rejects secret/environment injection even while disabled (%s)", name => {
      expect(() => loadTenantHooksConfig({ [name]: "fixture-private-canary" })).toThrow(/^Invalid managed tenant hooks configuration$/);
    });
  it("requires a dedicated file and durable production authority without activating any service", () => {
    expect(() => loadTenantHooksConfig({ TENANT_HOOKS_ENABLED: "1" })).toThrow("Invalid managed tenant hooks configuration");
    expect(() => loadTenantHooksConfig({ ...configured, NODE_ENV: "production" })).toThrow("Invalid managed tenant hooks configuration");
    expect(loadTenantHooksConfig({ ...configured, NODE_ENV: "production", STORE: "mysql" }).enabled).toBe(true);
    const production = { ...configured, ...fixtureMetadata, NODE_ENV: "production", STORE: "mysql", SECRETS_MASTER_KEY: "69".repeat(32),
      REDIS_URL: "redis://127.0.0.1:6479", RUNNER_ADDR: "https://runner.example.test",
      ERASURE_ROUTER_URL: "https://router.example.test", INTERNAL_ROUTER_TOKEN: "fixture-production-shaped-internal-token" };
    expect(loadConfig(production).tenantHooks.enabled).toBe(true);
    expect(() => loadConfig({ ...production, INTERNAL_ROUTER_TOKEN: undefined })).toThrow("INTERNAL_ROUTER_TOKEN is required in production");
  });
  it("requires all fixture gates without changing normal network policy", () => {
    const fixture = { ...configured, NODE_ENV: "test", HOOKS_ALLOW_LOOPBACK_FOR_TESTS: "1", MCP_ALLOW_LOOPBACK_FOR_TESTS: "1" };
    expect(loadTenantHooksConfig(fixture).allowLoopbackForTests).toBe(true);
    for (const change of [{ NODE_ENV: "production" }, { NODE_ENV: "development" }, { MCP_ALLOW_LOOPBACK_FOR_TESTS: "0" }])
      expect(() => loadTenantHooksConfig({ ...fixture, ...change })).toThrow("Invalid managed tenant hooks configuration");
  });
  it.each([["HOOKS_TIMEOUT_MS", "99"], ["HOOKS_TIMEOUT_MS", "5001"], ["HOOKS_TIMEOUT_MS", "01"],
    ["HOOKS_MAX_CONCURRENT_PER_USER", "0"], ["HOOKS_MAX_CONCURRENT_PER_USER", "9"]])("bounds %s (%s)", (name, value) => {
    expect(() => loadTenantHooksConfig({ [name]: value })).toThrow("Invalid managed tenant hooks configuration");
  });
});
