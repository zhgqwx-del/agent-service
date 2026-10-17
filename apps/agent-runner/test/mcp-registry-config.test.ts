import { describe, expect, it } from "vitest";
import { loadMcpRegistryConfig, MCP_OAUTH_CALLBACK_PATH } from "../src/mcp-registry-config.js";
import { loadConfig } from "../src/config.js";

const configured = {
  MCP_REGISTRY_ENABLED: "1",
  MCP_REGISTRY_CREDENTIAL_KEY_FILE: "/private/managed-mcp-key",
  MCP_REGISTRY_OAUTH_CALLBACK_URL: `https://runtime.example${MCP_OAUTH_CALLBACK_PATH}`,
};
const durable = { STORE: "mysql", REDIS_URL: "redis://127.0.0.1:6479", REDIS_NAMESPACE_ID: "mcp-config-test",
  ERASURE_ROUTER_URL: "http://127.0.0.1:8080" };
const rejects = (env: NodeJS.ProcessEnv) => expect(() => loadMcpRegistryConfig(env))
  .toThrow("Invalid managed MCP configuration");

describe("managed MCP runtime configuration", () => {
  it("uses the fixed router callback contract, not an inferred host or caller return target", () => {
    expect(MCP_OAUTH_CALLBACK_PATH).toBe("/v1/mcp/oauth/callback");
  });
  it("defaults off without reading files or ambient provider credentials", () => {
    const config = loadMcpRegistryConfig({ SECRETS_MASTER_KEY: "not-a-managed-credential" });
    expect(config).toEqual({ enabled: false, credentialKeyId: "local-mcp-v1", timeoutMs: 15_000,
      poolTtlMs: 60_000, maxPoolEntries: 128, maxConcurrentPerUser: 2, allowLoopbackForTests: false });
    expect(Object.isFrozen(config)).toBe(true);
  });
  it("keeps the credential file as a reference and normalizes the explicit fixed callback", () => {
    expect(loadMcpRegistryConfig({ ...configured,
      MCP_REGISTRY_OAUTH_CALLBACK_URL: `https://RUNTIME.EXAMPLE:443${MCP_OAUTH_CALLBACK_PATH}`,
    })).toMatchObject({ enabled: true, credentialKeyFile: configured.MCP_REGISTRY_CREDENTIAL_KEY_FILE,
      callbackUrl: configured.MCP_REGISTRY_OAUTH_CALLBACK_URL });
    expect(loadMcpRegistryConfig({ ...configured, MCP_REGISTRY_ENABLED: "0" }).enabled).toBe(false);
  });
  it("wires the managed settings through the actual runner config independently of anonymous MCP", () => {
    const config = loadConfig({ ...configured, ...durable, NODE_ENV: "test", SECRETS_MASTER_KEY: "63".repeat(32) });
    expect(config.mcpRegistry).toMatchObject({ enabled: true, callbackUrl: configured.MCP_REGISTRY_OAUTH_CALLBACK_URL });
    expect(config.mcp.enabled).toBe(false);
  });
  it("requires durable SQL authority and an explicit shared coordination namespace in the product runner", () => {
    const env = { ...configured, ...durable, NODE_ENV: "test", SECRETS_MASTER_KEY: "63".repeat(32) };
    for (const change of [{ STORE: "memory" }, { REDIS_URL: undefined }, { REDIS_NAMESPACE_ID: undefined }]) {
      expect(() => loadConfig({ ...env, ...change }))
        .toThrow("Managed MCP requires MySQL and an explicit Redis connection and namespace");
    }
  });
  it("requires the explicit private router origin for every product fleet boundary", () => {
    expect(() => loadConfig({ ...configured, ...durable, ERASURE_ROUTER_URL: undefined,
      NODE_ENV: "test", SECRETS_MASTER_KEY: "63".repeat(32) })).toThrow("ERASURE_ROUTER_URL is required");
  });
  it.each(["", "private-platform-mcp-registry-token"])("rejects router-only platform authority even while off (%#)", token => {
    expect(() => loadConfig({ NODE_ENV: "test", SECRETS_MASTER_KEY: "63".repeat(32),
      MCP_REGISTRY_OPERATOR_TOKEN: token })).toThrow("MCP_REGISTRY_OPERATOR_TOKEN is router-only");
  });
  it.each(["", "true", "2"])("rejects an activation flag without coercion: %j", flag => {
    rejects({ ...configured, MCP_REGISTRY_ENABLED: flag });
  });
  it("requires the complete key/callback pair even when the supplied configuration is disabled", () => {
    rejects({ MCP_REGISTRY_ENABLED: "1" });
    rejects({ MCP_REGISTRY_CREDENTIAL_KEY_FILE: configured.MCP_REGISTRY_CREDENTIAL_KEY_FILE });
    rejects({ MCP_REGISTRY_OAUTH_CALLBACK_URL: configured.MCP_REGISTRY_OAUTH_CALLBACK_URL });
    rejects({ ...configured, MCP_REGISTRY_CREDENTIAL_KEY_FILE: undefined });
    rejects({ ...configured, MCP_REGISTRY_OAUTH_CALLBACK_URL: undefined });
  });
  it.each(["", "relative-key", "/private/key\nvalue", "/" + "a".repeat(4096)])(
    "rejects an invalid protected key reference: %j", path => rejects({ ...configured, MCP_REGISTRY_CREDENTIAL_KEY_FILE: path }));
  it.each(["", "key id", "key/other", "x".repeat(65)])("rejects an invalid key identity: %j", keyId => {
    rejects({ ...configured, MCP_REGISTRY_CREDENTIAL_KEY_ID: keyId });
  });
  it.each([
    "", "not-a-url", "file:///v1/mcp/oauth/callback", "http://runtime.example/v1/mcp/oauth/callback",
    "https://user:private-fixture-value@runtime.example/v1/mcp/oauth/callback",
    "https://runtime.example/v1/mcp/oauth/callback?", "https://runtime.example/v1/mcp/oauth/callback#",
    "https://runtime.example/v1/mcp/oauth/callback?returnTo=https://other.example",
    "https://runtime.example/v1/mcp/oauth/callback/", "https://runtime.example/v1/mcp/oauth/%63allback",
    "https://runtime.example/other", " https://runtime.example/v1/mcp/oauth/callback",
    "https://runtime.example/v1/mcp/oauth/callback\n",
  ])("rejects callback injection, alternate routes and insecure schemes: %j", callback => {
    rejects({ ...configured, MCP_REGISTRY_OAUTH_CALLBACK_URL: callback });
  });
  it("allows HTTP loopback callbacks only with the existing explicit test gates", () => {
    for (const hostname of ["127.0.0.1", "[::1]"]) {
      const env = { ...configured, NODE_ENV: "test", MCP_ALLOW_LOOPBACK_FOR_TESTS: "1",
        MCP_REGISTRY_OAUTH_CALLBACK_URL: `http://${hostname}:8080${MCP_OAUTH_CALLBACK_PATH}` };
      expect(loadMcpRegistryConfig(env).callbackUrl).toBe(env.MCP_REGISTRY_OAUTH_CALLBACK_URL);
      for (const NODE_ENV of ["development", "production", undefined]) rejects({ ...env, NODE_ENV });
      rejects({ ...env, MCP_ALLOW_LOOPBACK_FOR_TESTS: "0" });
      rejects({ ...env, MCP_REGISTRY_OAUTH_CALLBACK_URL: `http://localhost:8080${MCP_OAUTH_CALLBACK_PATH}` });
    }
  });
  it.each(["MCP_REGISTRY_CREDENTIAL_KEY", "MCP_REGISTRY_HEADERS", "MCP_REGISTRY_PROXY", "MCP_REGISTRY_OPERATOR_TOKEN"])(
    "rejects ambient credentials and unknown managed settings without echoing them: %s", name => {
      const privateValue = "private-fixture-value";
      try { loadMcpRegistryConfig({ ...configured, [name]: privateValue }); throw new Error("unexpected success"); }
      catch (error) { expect(error).toBeInstanceOf(Error); expect((error as Error).message).toBe("Invalid managed MCP configuration"); }
    });
  it.each([
    ["MCP_TIMEOUT_MS", "0"], ["MCP_TIMEOUT_MS", "30001"], ["MCP_TIMEOUT_MS", "01"],
    ["MCP_REGISTRY_POOL_TTL_MS", "999"], ["MCP_REGISTRY_POOL_TTL_MS", "300001"],
    ["MCP_REGISTRY_POOL_MAX_ENTRIES", "0"], ["MCP_REGISTRY_POOL_MAX_ENTRIES", "129"],
    ["MCP_MAX_CONCURRENT_PER_USER", "0"], ["MCP_MAX_CONCURRENT_PER_USER", "9"],
  ])("bounds %s=%s while disabled", (name, value) => rejects({ [name]: value }));
});
