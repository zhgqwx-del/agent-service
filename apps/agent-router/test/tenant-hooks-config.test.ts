import { describe, expect, it } from "vitest";
import { loadRouterConfig } from "../src/config.js";

describe("router managed tenant hooks role separation", () => {
  const base = { NODE_ENV: "test", RUNNERS: "http://runner.example.test:8787" };
  it("defaults off and accepts only the public key identity", () => {
    expect(loadRouterConfig(base).TENANT_HOOKS_ENABLED).toBe(false);
    const config = loadRouterConfig({ ...base, TENANT_HOOKS_ENABLED: "1", HOOKS_MASTER_KEY_ID: "fixture-v2" });
    expect(config.TENANT_HOOKS_ENABLED).toBe(true); expect(config.HOOKS_MASTER_KEY_ID).toBe("fixture-v2");
  });
  it.each(["HOOKS_MASTER_KEY_FILE", "HOOKS_MASTER_KEY", "HOOKS_MASTER_KEY_JSON", "HOOKS_CONFIG_JSON", "HOOKS_ALLOW_LOOPBACK_FOR_TESTS", "TENANT_HOOKS_HEADERS"])(
    "rejects runner-only material and transport configuration even while off: %s", name => {
      expect(() => loadRouterConfig({ ...base, [name]: "fixture-private-canary" }))
        .toThrow(/^Managed tenant hooks secret\/runtime configuration is runner-only$/);
    });
  it("accepts production-shaped nonsecret expectations only beside existing internal authority requirements", () => {
    const env = { ...base, NODE_ENV: "production", TENANT_HOOKS_ENABLED: "1", REDIS_URL: "redis://127.0.0.1:6479",
      INTERNAL_ROUTER_TOKEN: "fixture-production-shaped-internal-token" };
    expect(loadRouterConfig(env).TENANT_HOOKS_ENABLED).toBe(true);
    expect(() => loadRouterConfig({ ...env, INTERNAL_ROUTER_TOKEN: undefined })).toThrow("INTERNAL_ROUTER_TOKEN is required in production");
    expect(() => loadRouterConfig({ ...env, HOOKS_ALLOW_LOOPBACK_FOR_TESTS: "1" })).toThrow("runner-only");
  });
});
