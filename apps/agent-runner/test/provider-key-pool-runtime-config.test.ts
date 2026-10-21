import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ProviderPoolInventory } from "@agent-service/store";
import { loadConfig } from "../src/config.js";
import { loadRouterConfig } from "../../agent-router/src/config.js";
import { deriveProviderGatewayPolicySha256, loadProviderGatewayConfig, ProviderGatewayConfigError } from "../src/provider-gateway-config.js";

const path = "/private/fixture/provider-pool.json", secret = "private-pool-runtime-canary";
const base = () => ({ PROVIDER_GATEWAY_ENABLED: "1", REDIS_URL: "redis://127.0.0.1:6479/1", REDIS_NAMESPACE_ID: "pool-config",
  PLATFORM_PROVIDER_KEY_POOL_FILE: path });
const inventory = (): ProviderPoolInventory => ({ version: "provider-key-pool-v1", providerId: "dashscope",
  slots: [{ id: "slot-A", version: "v1" }, { id: "slot-B", version: "v2" }] });
function rejected(env: NodeJS.ProcessEnv) {
  expect(() => loadProviderGatewayConfig(env)).toThrow(ProviderGatewayConfigError);
  try { loadProviderGatewayConfig(env); } catch (error) {
    expect(String(error)).not.toContain(secret); expect(String(error)).not.toContain(path);
    expect(Object.hasOwn(error as object, "cause")).toBe(false);
  }
}

describe("provider pool resource-free operator configuration", () => {
  it("keeps the original no-pool DTO and exact v1 digest unchanged", () => {
    const env: NodeJS.ProcessEnv = base(); delete env.PLATFORM_PROVIDER_KEY_POOL_FILE;
    const config = loadProviderGatewayConfig(env);
    expect(Object.keys(config)).toEqual(["enabled", "tenant", "user", "platformProvider", "policySha256"]);
    expect(deriveProviderGatewayPolicySha256(config)).toBe(config.policySha256);
    expect(deriveProviderGatewayPolicySha256(loadProviderGatewayConfig({}))).toBeNull();
    expect(() => deriveProviderGatewayPolicySha256(config, inventory())).toThrow(ProviderGatewayConfigError);
  });

  it("requires protected inventory before deriving v2 and never reads a file in the parser", () => {
    const config = loadProviderGatewayConfig(base());
    expect(config).toMatchObject({ enabled: true, keyPoolFile: path, policySha256: null,
      breakerPolicy: { threshold: 5, windowMs: 60_000, cooldownMs: 30_000, rateLimitCooldownMs: 30_000 } });
    expect(config.quotaPolicySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(config.breakerPolicy)).toBe(true);
    expect(() => deriveProviderGatewayPolicySha256(config)).toThrow(ProviderGatewayConfigError);
    const expected = createHash("sha256").update("provider-gateway-policy-v2\0").update(JSON.stringify({
      algorithm: "provider-gateway-pool-v1", quotaPolicySha256: config.quotaPolicySha256,
      inventory: inventory(), breaker: config.breakerPolicy,
    })).digest("hex");
    expect(deriveProviderGatewayPolicySha256(config, inventory())).toBe(expected);
    expect(deriveProviderGatewayPolicySha256(loadProviderGatewayConfig({ ...base(), PLATFORM_PROVIDER_KEY_POOL_FILE: "/different/private/path" }), inventory())).toBe(expected);
  });

  it("binds inventory order, identity, version and each breaker parameter without secret-derived material", () => {
    const config = loadProviderGatewayConfig(base()), original = deriveProviderGatewayPolicySha256(config, inventory());
    for (const changed of [{ ...inventory(), providerId: "other" }, { ...inventory(), slots: [...inventory().slots].reverse() },
      { ...inventory(), slots: [{ id: "slot-A", version: "v3" }, inventory().slots[1]!] }]) {
      expect(deriveProviderGatewayPolicySha256(config, changed)).not.toBe(original);
    }
    for (const [key, value] of Object.entries(config.breakerPolicy!)) {
      expect(deriveProviderGatewayPolicySha256(loadProviderGatewayConfig({ ...base(),
        PLATFORM_PROVIDER_BREAKER_JSON: JSON.stringify({ [key]: value + 1 }) }), inventory())).not.toBe(original);
    }
    expect(deriveProviderGatewayPolicySha256(loadProviderGatewayConfig({ ...base(),
      PLATFORM_PROVIDER_BREAKER_JSON: '{"rateLimitCooldownMs":3e4,"cooldownMs":30000.0,"windowMs":60000,"threshold":5}' }), inventory())).toBe(original);
  });

  it.each([undefined, "", secret])("rejects API_KEY presence even when its value is %j", value => {
    rejected({ ...base(), API_KEY: value });
  });

  it.each(["PLATFORM_PROVIDER_KEY_POOL_FILE", "PLATFORM_PROVIDER_BREAKER_JSON"])("rejects disabled %s by presence", key => {
    for (const value of [undefined, "", "{}", path]) rejected({ PROVIDER_GATEWAY_ENABLED: "0", [key]: value });
  });

  it("rejects relative, empty, NUL, overlong paths and ambient key families", () => {
    for (const value of [undefined, "", "relative", "/bad\0path", "/" + "x".repeat(4096)]) rejected({ ...base(), PLATFORM_PROVIDER_KEY_POOL_FILE: value });
    for (const key of ["PLATFORM_PROVIDER_KEY_POOL_JSON", "PLATFORM_PROVIDER_KEY_POOL_API_KEY", "PLATFORM_PROVIDER_BREAKER_FUTURE"]) rejected({ ...base(), [key]: secret });
    rejected({ ...base(), PLATFORM_PROVIDER_KEY_POOL_FILE: undefined });
    const noPool: NodeJS.ProcessEnv = base(); delete noPool.PLATFORM_PROVIDER_KEY_POOL_FILE;
    rejected({ ...noPool, PLATFORM_PROVIDER_BREAKER_JSON: "{}" });
  });

  it("enforces closed numeric policies, duplicate rejection and exact bounds", () => {
    for (const raw of [undefined, "", "null", "[]", "1", '{"extra":1}', '{"threshold":1,"threshold":2}',
      '{"threshold":1,"t\\u0068reshold":2}', '{"threshold":0}', '{"threshold":101}', '{"threshold":1.5}',
      '{"windowMs":99}', '{"cooldownMs":3600001}', '{"rateLimitCooldownMs":1e309}', '{"threshold":"5"}', " ".repeat(2049)]) {
      rejected({ ...base(), PLATFORM_PROVIDER_BREAKER_JSON: raw });
    }
    expect(loadProviderGatewayConfig({ ...base(), PLATFORM_PROVIDER_BREAKER_JSON: '{"threshold":1,"windowMs":100,"cooldownMs":3600000,"rateLimitCooldownMs":100}' }).breakerPolicy)
      .toEqual({ threshold: 1, windowMs: 100, cooldownMs: 3_600_000, rateLimitCooldownMs: 100 });
  });

  it("rejects credential/unknown/getter fields in public inventory without evaluating the getter", () => {
    const config = loadProviderGatewayConfig(base());
    for (const bad of [{ ...inventory(), apiKey: secret }, { ...inventory(), slots: [{ id: "slot-A", version: "v1", apiKey: secret }] },
      { ...inventory(), slots: [{ id: "slot-A", version: "v1" }, { id: "slot-A", version: "v2" }] },
      { ...inventory(), version: "other" }]) {
      expect(() => deriveProviderGatewayPolicySha256(config, bad as ProviderPoolInventory)).toThrow(ProviderGatewayConfigError);
    }
    const getter = vi.fn(() => secret), bad = inventory();
    Object.defineProperty(bad.slots[0], "version", { enumerable: true, get: getter });
    expect(() => deriveProviderGatewayPolicySha256(config, bad)).toThrow(ProviderGatewayConfigError); expect(getter).not.toHaveBeenCalled();
    const arrayField = inventory(); Object.defineProperty(arrayField.slots, "apiKey", { value: secret });
    expect(() => deriveProviderGatewayPolicySha256(config, arrayField)).toThrow(ProviderGatewayConfigError);
    const arrayGetter = inventory(); Object.defineProperty(arrayGetter.slots, "0", { enumerable: true, get: getter });
    expect(() => deriveProviderGatewayPolicySha256(config, arrayGetter)).toThrow(ProviderGatewayConfigError); expect(getter).not.toHaveBeenCalled();
  });

  it("keeps the runner private path out of the router and accepts only its finalized digest", () => {
    for (const key of ["PLATFORM_PROVIDER_KEY_POOL_FILE", "PLATFORM_PROVIDER_KEY_POOL_FUTURE", "PLATFORM_PROVIDER_BREAKER_JSON", "PLATFORM_PROVIDER_BREAKER_FUTURE"]) {
      for (const value of [undefined, "", secret]) expect(() => loadRouterConfig({ RUNNERS: "http://127.0.0.1:8787", [key]: value })).toThrow("runner-only");
    }
    const runner = loadConfig({ ...base(), STORE: "memory", SECRETS_MASTER_KEY: "11".repeat(32), RUNNER_ID: "pool-config",
      RUNNER_ADDR: "127.0.0.1:8787", ERASURE_ROUTER_URL: "http://127.0.0.1:8080", INTERNAL_ROUTER_TOKEN: "pool-private-token-000000000000001" });
    const digest = deriveProviderGatewayPolicySha256(runner.providerGateway, inventory())!;
    expect(loadRouterConfig({ RUNNERS: "http://127.0.0.1:8787", REDIS_URL: base().REDIS_URL, REDIS_NAMESPACE_ID: base().REDIS_NAMESPACE_ID,
      PROVIDER_GATEWAY_ENABLED: "1", PROVIDER_GATEWAY_POLICY_SHA256: digest }).providerGatewayIdentity?.policySha256).toBe(digest);
  });
});
