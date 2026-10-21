import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ProviderPoolInventory } from "@agent-service/store";
import { loadConfig } from "../src/config.js";
import { loadRouterConfig } from "../../agent-router/src/config.js";
import { deriveProviderGatewayPolicySha256, loadProviderGatewayConfig, ProviderGatewayConfigError } from "../src/provider-gateway-config.js";

const defaults = { threshold: 5, windowMs: 60_000, cooldownMs: 30_000, rateLimitCooldownMs: 30_000 };
const base = (): NodeJS.ProcessEnv => ({ PROVIDER_GATEWAY_ENABLED: "1", REDIS_URL: "redis://127.0.0.1:6479/1", REDIS_NAMESPACE_ID: "byok-breaker" });
const pool = (): ProviderPoolInventory => ({ version: "provider-key-pool-v1", providerId: "dashscope", slots: [{ id: "platform", version: "v1" }] });
const digest = (domain: string, value: unknown) => createHash("sha256").update(domain + "\0").update(JSON.stringify(value)).digest("hex");
const secret = "test-only-private-byok-policy-canary";
function rejected(env: NodeJS.ProcessEnv) {
  expect(() => loadProviderGatewayConfig(env)).toThrow(ProviderGatewayConfigError);
  try { loadProviderGatewayConfig(env); } catch (error) {
    expect(String(error)).not.toContain(secret); expect(String(error)).not.toContain("redis://");
    expect(Object.hasOwn(error as object, "cause")).toBe(false);
  }
}

describe("explicit operator BYOK breaker configuration", () => {
  it("does not add DTO keys or alter v1/v2 policies when BYOK is absent", () => {
    const original = loadProviderGatewayConfig(base()), off = loadProviderGatewayConfig({});
    expect(Object.keys(original)).toEqual(["enabled", "tenant", "user", "platformProvider", "policySha256"]);
    expect(Object.keys(off)).toEqual(["enabled", "tenant", "user", "platformProvider", "policySha256"]);
    expect(deriveProviderGatewayPolicySha256(original)).toBe(original.policySha256);
    expect(deriveProviderGatewayPolicySha256(off)).toBeNull();
    const platform = loadProviderGatewayConfig({ ...base(), PLATFORM_PROVIDER_KEY_POOL_FILE: "/private/fixture/pool.json", PLATFORM_PROVIDER_BREAKER_JSON: "{}" });
    expect(Object.hasOwn(platform, "byokBreakerPolicy")).toBe(false);
    expect(deriveProviderGatewayPolicySha256(platform, pool())).toBe(digest("provider-gateway-policy-v2", {
      algorithm: "provider-gateway-pool-v1", quotaPolicySha256: original.policySha256, inventory: pool(), breaker: defaults,
    }));
  });

  it("normalizes explicit BYOK defaults without a platform pool or any file read", () => {
    const config = loadProviderGatewayConfig({ ...base(), PROVIDER_BYOK_BREAKER_JSON: "{}" });
    expect(config).toMatchObject({ enabled: true, policySha256: null, byokBreakerPolicy: defaults });
    expect(config.quotaPolicySha256).toBe(loadProviderGatewayConfig(base()).policySha256);
    expect(Object.hasOwn(config, "keyPoolFile")).toBe(false); expect(Object.hasOwn(config, "breakerPolicy")).toBe(false);
    expect(Object.isFrozen(config)).toBe(true); expect(Object.isFrozen(config.byokBreakerPolicy)).toBe(true);
    expect(deriveProviderGatewayPolicySha256(config)).toBe(digest("provider-gateway-policy-v3", {
      algorithm: "provider-gateway-byok-breaker-v1", quotaPolicySha256: config.quotaPolicySha256,
      platformPool: null, byokBreakerPolicy: defaults,
    }));
    expect(() => deriveProviderGatewayPolicySha256(config, pool())).toThrow(ProviderGatewayConfigError);
  });

  it("binds v3 only to quota, optional public platform inventory, and the two independent policies", () => {
    const env = { ...base(), PROVIDER_BYOK_BREAKER_JSON: '{"threshold":2}', PLATFORM_PROVIDER_KEY_POOL_FILE: "/private/fixture/pool.json",
      PLATFORM_PROVIDER_BREAKER_JSON: '{"threshold":9}' };
    const config = loadProviderGatewayConfig(env), expected = digest("provider-gateway-policy-v3", {
      algorithm: "provider-gateway-byok-breaker-v1", quotaPolicySha256: config.quotaPolicySha256,
      platformPool: { inventory: pool(), policy: { ...defaults, threshold: 9 } }, byokBreakerPolicy: { ...defaults, threshold: 2 },
    });
    expect(deriveProviderGatewayPolicySha256(config, pool())).toBe(expected);
    expect(deriveProviderGatewayPolicySha256(loadProviderGatewayConfig({ ...env, PLATFORM_PROVIDER_KEY_POOL_FILE: "/another/private/path" }), pool())).toBe(expected);
    expect(() => deriveProviderGatewayPolicySha256(config)).toThrow(ProviderGatewayConfigError);
    expect(() => deriveProviderGatewayPolicySha256(config, { ...pool(), apiKey: secret } as ProviderPoolInventory)).toThrow(ProviderGatewayConfigError);
    expect(deriveProviderGatewayPolicySha256(config, { ...pool(), slots: [{ id: "platform", version: "v2" }] })).not.toBe(expected);
    expect(deriveProviderGatewayPolicySha256(loadProviderGatewayConfig({ ...env, PLATFORM_PROVIDER_BREAKER_JSON: '{"threshold":8}' }), pool())).not.toBe(expected);
  });

  it("canonicalizes the BYOK policy and binds every normalized parameter plus operator quota", () => {
    const config = loadProviderGatewayConfig({ ...base(), PROVIDER_BYOK_BREAKER_JSON: "{}" }), original = deriveProviderGatewayPolicySha256(config);
    for (const [key, value] of Object.entries(defaults)) {
      expect(deriveProviderGatewayPolicySha256(loadProviderGatewayConfig({ ...base(), PROVIDER_BYOK_BREAKER_JSON: JSON.stringify({ [key]: value + 1 }) }))).not.toBe(original);
    }
    expect(deriveProviderGatewayPolicySha256(loadProviderGatewayConfig({ ...base(), PROVIDER_BYOK_BREAKER_JSON: '{"rateLimitCooldownMs":3e4,"cooldownMs":30000.0,"windowMs":60000,"threshold":5}' }))).toBe(original);
    expect(deriveProviderGatewayPolicySha256(loadProviderGatewayConfig({ ...base(), PROVIDER_BYOK_BREAKER_JSON: "{}", PROVIDER_TENANT_QUOTA_JSON: '{"rpm":1}' }))).not.toBe(original);
  });

  it("rejects disabled policy presence, including empty and undefined, without silently enabling it", () => {
    for (const value of [undefined, "", "{}", secret]) {
      rejected({ PROVIDER_BYOK_BREAKER_JSON: value });
      rejected({ PROVIDER_GATEWAY_ENABLED: "0", PROVIDER_BYOK_BREAKER_JSON: value });
    }
  });

  it("rejects unknown family members and all non-string, malformed, duplicate or open policy objects", () => {
    for (const key of ["PROVIDER_BYOK_BREAKER_FUTURE", "PROVIDER_BYOK_BREAKER_API_KEY", "PROVIDER_BYOK_BREAKER_FILE"]) {
      for (const value of [undefined, "", secret]) rejected({ ...base(), [key]: value });
    }
    for (const value of [undefined, "", "null", "[]", "0", '{"unknown":1}', '{"threshold":1,"threshold":2}',
      '{"threshold":1,"t\\u0068reshold":2}', '{"threshold":"5"}', '{"threshold":null}', '{"windowMs":1e309}', " ".repeat(2049)]) {
      rejected({ ...base(), PROVIDER_BYOK_BREAKER_JSON: value });
    }
  });

  it("enforces the same four exact integer bounds without borrowing platform configuration", () => {
    for (const value of ['{"threshold":0}', '{"threshold":101}', '{"threshold":1.5}', '{"windowMs":99}', '{"cooldownMs":3600001}', '{"rateLimitCooldownMs":99}']) {
      rejected({ ...base(), PROVIDER_BYOK_BREAKER_JSON: value });
    }
    expect(loadProviderGatewayConfig({ ...base(), PROVIDER_BYOK_BREAKER_JSON: '{"threshold":1,"windowMs":100,"cooldownMs":3600000,"rateLimitCooldownMs":100}' }).byokBreakerPolicy)
      .toEqual({ threshold: 1, windowMs: 100, cooldownMs: 3_600_000, rateLimitCooldownMs: 100 });
    rejected({ ...base(), PROVIDER_BYOK_BREAKER_JSON: "{}", PLATFORM_PROVIDER_BREAKER_JSON: "{}" });
    const singleKey = loadProviderGatewayConfig({ ...base(), PROVIDER_BYOK_BREAKER_JSON: "{}", API_KEY: secret });
    expect(singleKey.byokBreakerPolicy).toEqual(defaults); expect(Object.hasOwn(singleKey, "keyPoolFile")).toBe(false);
  });

  it("rejects accessor and inherited policy values without evaluating them", () => {
    let called = false;
    const env = Object.defineProperty(base(), "PROVIDER_BYOK_BREAKER_JSON", { enumerable: true, get() { called = true; return "{}"; } });
    rejected(env); expect(called).toBe(false);
    rejected(Object.assign(Object.create({ PROVIDER_BYOK_BREAKER_JSON: "{}" }) as NodeJS.ProcessEnv, base()));
  });

  it("keeps all BYOK breaker authority out of the router while accepting the finalized digest", () => {
    for (const key of ["PROVIDER_BYOK_BREAKER_JSON", "PROVIDER_BYOK_BREAKER_FUTURE"]) for (const value of [undefined, "", secret]) {
      expect(() => loadRouterConfig({ RUNNERS: "http://127.0.0.1:8787", [key]: value })).toThrow("runner-only");
    }
    const runner = loadConfig({ ...base(), PROVIDER_BYOK_BREAKER_JSON: "{}", STORE: "memory", SECRETS_MASTER_KEY: "11".repeat(32),
      RUNNER_ID: "byok-config", RUNNER_ADDR: "127.0.0.1:8787", ERASURE_ROUTER_URL: "http://127.0.0.1:8080", INTERNAL_ROUTER_TOKEN: "test-only-private-byok-router-token" });
    const sha = deriveProviderGatewayPolicySha256(runner.providerGateway)!;
    expect(loadRouterConfig({ RUNNERS: "http://127.0.0.1:8787", REDIS_URL: base().REDIS_URL, REDIS_NAMESPACE_ID: base().REDIS_NAMESPACE_ID,
      PROVIDER_GATEWAY_ENABLED: "1", PROVIDER_GATEWAY_POLICY_SHA256: sha }).providerGatewayIdentity?.policySha256).toBe(sha);
  });

  it("clears the complete BYOK family from dist boot copies and all three local-service scrub boundaries", async () => {
    const { cleanDistBootEnv } = await import(new URL("../../../scripts/lib/dist-boot-env.mjs", import.meta.url).href) as {
      cleanDistBootEnv(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
    };
    const input = { KEEP: "kept", PROVIDER_BYOK_BREAKER_JSON: "{}", PROVIDER_BYOK_BREAKER_FUTURE: secret };
    expect(cleanDistBootEnv(input)).toEqual({ KEEP: "kept" }); expect(input.PROVIDER_BYOK_BREAKER_FUTURE).toBe(secret);
    // Structural shell proof only; the existing authority suite executes its fake-role boundaries.
    const shell = await readFile(new URL("../../../scripts/local-service.sh", import.meta.url), "utf8");
    expect(shell.split("\n").filter(line => line.includes("PROVIDER_BYOK_BREAKER_*") && line.includes("PLATFORM_PROVIDER_BREAKER_*")).length).toBe(3);
  });
});
