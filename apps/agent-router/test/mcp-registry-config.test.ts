import { describe, expect, it } from "vitest";
import { loadRouterConfig } from "../src/config.js";

const base = { NODE_ENV: "test", RUNNERS: "http://runner:8787" };
const callback = "https://runtime.example/v1/mcp/oauth/callback";
const token = "private-mcp-registry-platform-token-001";
const coordination = { REDIS_URL: "redis://127.0.0.1:6479", REDIS_NAMESPACE_ID: "mcp-config-test" };

describe("router managed MCP configuration", () => {
  it("defaults off without callback, key bytes or platform authority", () => {
    const config = loadRouterConfig(base);
    expect(config.MCP_REGISTRY_ENABLED).toBe(false);
    expect(config.MCP_REGISTRY_OPERATOR_TOKEN).toBeUndefined();
    expect(config.MCP_REGISTRY_OAUTH_CALLBACK_URL).toBeUndefined();
    expect(config.MCP_REGISTRY_CREDENTIAL_KEY_ID).toBe("local-mcp-v1");
  });
  it("accepts only the public callback/key identity and does not invent platform credentials", () => {
    const config = loadRouterConfig({ ...base, ...coordination, MCP_REGISTRY_ENABLED: "1",
      MCP_REGISTRY_OAUTH_CALLBACK_URL: "https://RUNTIME.EXAMPLE:443/v1/mcp/oauth/callback" });
    expect(config.MCP_REGISTRY_OAUTH_CALLBACK_URL).toBe(callback);
    expect(config.MCP_REGISTRY_OPERATOR_TOKEN).toBeUndefined();
    expect(() => loadRouterConfig({ ...base, MCP_REGISTRY_ENABLED: "1" })).toThrow("Explicit managed MCP callback URL is required");
  });
  it("does not advertise managed operation without an explicit shared coordination namespace", () => {
    const env = { ...base, ...coordination, MCP_REGISTRY_ENABLED: "1", MCP_REGISTRY_OAUTH_CALLBACK_URL: callback };
    expect(() => loadRouterConfig({ ...env, REDIS_URL: undefined })).toThrow("Managed MCP requires an explicit Redis connection and namespace");
    expect(() => loadRouterConfig({ ...env, REDIS_NAMESPACE_ID: undefined })).toThrow("Managed MCP requires an explicit Redis connection and namespace");
  });
  it.each(["MCP_REGISTRY_CREDENTIAL_KEY_FILE", "MCP_REGISTRY_CREDENTIAL_KEY", "MCP_REGISTRY_HEADERS",
    "MCP_REGISTRY_POOL_TTL_MS", "MCP_REGISTRY_POOL_MAX_ENTRIES"])("rejects runner-only or unknown %s even while off", name => {
    expect(() => loadRouterConfig({ ...base, [name]: "private-fixture-value" }))
      .toThrow("Managed MCP credential/runtime configuration is runner-only");
  });
  it.each(["INTERNAL_ROUTER_TOKEN", "ROUTER_ADMIN_TOKEN", "TENANT_ERASURE_OPERATOR_TOKEN",
    "SKILL_REGISTRY_OPERATOR_TOKEN", "METRICS_BEARER_TOKEN"])("does not share platform authority with %s", name => {
    expect(() => loadRouterConfig({ ...base, MCP_REGISTRY_OPERATOR_TOKEN: token, [name]: token })).toThrow();
  });
  it.each(["", "true", "2"])("does not coerce the activation flag %j", value => {
    expect(() => loadRouterConfig({ ...base, MCP_REGISTRY_ENABLED: value })).toThrow();
  });
  it.each(["", "key id", "key/other", "x".repeat(65)])("rejects invalid public key identity %j", value => {
    expect(() => loadRouterConfig({ ...base, MCP_REGISTRY_CREDENTIAL_KEY_ID: value })).toThrow();
  });
  it.each(["", "not-a-url", "http://runtime.example/v1/mcp/oauth/callback",
    "https://user:private-fixture-value@runtime.example/v1/mcp/oauth/callback",
    callback + "?", callback + "#", callback + "/", callback.replace("callback", "%63allback"),
    " " + callback, callback + "\n"])("rejects a caller-adjustable callback even while off (%#)", value => {
    expect(() => loadRouterConfig({ ...base, MCP_REGISTRY_OAUTH_CALLBACK_URL: value }))
      .toThrow("Invalid managed MCP callback configuration");
  });
  it("allows an explicit loopback callback only under both test gates", () => {
    const env = { ...base, ...coordination, MCP_REGISTRY_ENABLED: "1", MCP_ALLOW_LOOPBACK_FOR_TESTS: "1",
      MCP_REGISTRY_OAUTH_CALLBACK_URL: "http://127.0.0.1:8080/v1/mcp/oauth/callback" };
    expect(loadRouterConfig(env).MCP_REGISTRY_OAUTH_CALLBACK_URL).toBe(env.MCP_REGISTRY_OAUTH_CALLBACK_URL);
    expect(() => loadRouterConfig({ ...env, MCP_ALLOW_LOOPBACK_FOR_TESTS: "0" })).toThrow();
    expect(() => loadRouterConfig({ ...env, NODE_ENV: "development" })).toThrow();
    expect(() => loadRouterConfig({ ...env, NODE_ENV: "production" })).toThrow();
    expect(() => loadRouterConfig({ ...env, MCP_REGISTRY_OAUTH_CALLBACK_URL: "http://localhost:8080/v1/mcp/oauth/callback" })).toThrow();
  });
});
