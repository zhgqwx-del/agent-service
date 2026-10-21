import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { providerQuotaNamespaceSha256 } from "@agent-service/store";
import { parseProviderKeyPools } from "../src/provider-key-pool.js";
import { deriveProviderGatewayPolicySha256, loadProviderGatewayConfig, ProviderGatewayConfigError, validatePlatformProviderFallbacks } from "../src/provider-gateway-config.js";

const base = () => ({ PROVIDER_GATEWAY_ENABLED: "1", REDIS_URL: "redis://127.0.0.1:6479/1", REDIS_NAMESPACE_ID: "explicit-fallback" });
const mapping = () => [{ provider: "dashscope", rules: [{ model: "qwen-plus", targets: [
  { provider: "deepseek", model: "deepseek-chat" }, { provider: "dashscope", model: "qwen-turbo" },
] }] }];
const actual = () => [{ id: "dashscope", models: [{ id: "qwen-plus" }, { id: "qwen-turbo" }] },
  { id: "deepseek", models: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }] }];
const config = (rules: unknown = mapping()) => loadProviderGatewayConfig({ ...base(), PLATFORM_PROVIDER_FALLBACK_JSON: JSON.stringify(rules) });
const pools = () => parseProviderKeyPools(JSON.stringify({ version: "provider-key-pools-v2", providers: actual().map(({ id }) => ({
  version: "provider-key-pool-v1", providerId: id, slots: [{ id: "slot-A", version: "v1", apiKey: "private-fallback-key-canary" + id }],
})) }));
function rejected(raw: string | undefined) {
  try { loadProviderGatewayConfig({ ...base(), PLATFORM_PROVIDER_FALLBACK_JSON: raw }); throw new Error("Invalid mapping accepted."); }
  catch (error) { expect(error).toBeInstanceOf(ProviderGatewayConfigError); expect(Object.hasOwn(error as object, "cause")).toBe(false);
    expect(String(error)).not.toContain("private-fallback"); }
}

describe("explicit operator platform fallback configuration", () => {
  it("preserves the old absent-field DTO and exact quota v1 identity", () => {
    const old = loadProviderGatewayConfig(base());
    expect(Object.keys(old)).toEqual(["enabled", "tenant", "user", "platformProvider", "policySha256"]);
    expect(deriveProviderGatewayPolicySha256(old)).toBe(createHash("sha256").update("provider-gateway-policy-v1\0").update(JSON.stringify({
      algorithm: "provider-quota-v1", redisNamespaceSha256: providerQuotaNamespaceSha256({ prefix: "as", namespaceId: base().REDIS_NAMESPACE_ID }),
      tenant: {}, user: {}, platformProvider: {},
    })).digest("hex"));
    expect(Object.hasOwn(old, "platformFallbacks")).toBe(false);
  });
  it("copies and freezes exact mappings, preserving target priority and no raw key/path", () => {
    const input = mapping(), loaded = config(input), rules = loaded.platformFallbacks!;
    expect(rules).toEqual(input); input[0]!.rules[0]!.targets.reverse(); expect(rules).toEqual(mapping());
    for (const value of [loaded, rules, rules[0], rules[0]!.rules, rules[0]!.rules[0], rules[0]!.rules[0]!.targets,
      ...rules[0]!.rules[0]!.targets]) expect(Object.isFrozen(value)).toBe(true);
    expect(loaded.policySha256).toBeNull(); expect(loaded.quotaPolicySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => validatePlatformProviderFallbacks(loaded, actual())).not.toThrow();
  });
  it("canonicalizes source-provider and source-model order but not target priority", () => {
    const first = [{ provider: "deepseek", rules: [{ model: "deepseek-reasoner", targets: [{ provider: "dashscope", model: "qwen-plus" }] }] },
      { provider: "dashscope", rules: [mapping()[0]!.rules[0]!, { model: "qwen-turbo", targets: [{ provider: "deepseek", model: "deepseek-chat" }] }] }];
    const reordered = structuredClone(first).reverse(); reordered[0]!.rules.reverse();
    expect(deriveProviderGatewayPolicySha256(config(first))).toBe(deriveProviderGatewayPolicySha256(config(reordered)));
    const reversedTargets = mapping(); reversedTargets[0]!.rules[0]!.targets.reverse();
    expect(deriveProviderGatewayPolicySha256(config(reversedTargets))).not.toBe(deriveProviderGatewayPolicySha256(config()));
  });
  it("supports exact Unicode and whitespace externalIds without alias folding", () => {
    const provider = "中".repeat(128), model = " source ", target = "目标 ";
    const loaded = config([{ provider, rules: [{ model, targets: [{ provider, model: target }] }] }]);
    expect(() => validatePlatformProviderFallbacks(loaded, [{ id: provider, models: [{ id: model }, { id: target }] }])).not.toThrow();
    expect(() => validatePlatformProviderFallbacks(loaded, [{ id: provider.trim(), models: [{ id: model.trim() }, { id: target }] }])).toThrow(ProviderGatewayConfigError);
  });
  it("accepts all thirty-two rules and three ordered targets, rejecting one extra", () => {
    const rules = Array.from({ length: 32 }, (_, n) => ({ model: `m${n}`, targets: Array.from({ length: 3 }, (_, t) => ({ provider: "target", model: `t${t}` })) }));
    expect(config([{ provider: "source", rules }]).platformFallbacks![0]!.rules).toHaveLength(32);
    rejected(JSON.stringify([{ provider: "source", rules: [...rules, { ...rules[0], model: "extra" }] }]));
    rejected(JSON.stringify([{ provider: "source", rules: [{ model: "m", targets: [...rules[0]!.targets, { provider: "target", model: "extra" }] }] }]));
  });
  it.each([
    ["undefined", undefined], ["empty", ""], ["null", "null"], ["object", "{}"], ["malformed", "["],
    ["unknown entry", JSON.stringify([{ ...mapping()[0], key: "private-fallback-secret" }])],
    ["unknown rule", JSON.stringify([{ provider: "p", rules: [{ model: "m", targets: [{ provider: "q", model: "n" }], path: "private-fallback-path" }] }])],
    ["unknown target", JSON.stringify([{ provider: "p", rules: [{ model: "m", targets: [{ provider: "q", model: "n", apiKey: "private-fallback-key" }] }] }])],
    ["self", JSON.stringify([{ provider: "p", rules: [{ model: "m", targets: [{ provider: "p", model: "m" }] }] }])],
    ["duplicate provider", JSON.stringify([mapping()[0], mapping()[0]])],
    ["duplicate source", JSON.stringify([{ provider: "p", rules: [mapping()[0]!.rules[0], mapping()[0]!.rules[0]] }])],
    ["duplicate target", JSON.stringify([{ provider: "p", rules: [{ model: "m", targets: [{ provider: "q", model: "n" }, { provider: "q", model: "n" }] }] }])],
    ["missing targets", JSON.stringify([{ provider: "p", rules: [{ model: "m", targets: [] }] }])],
    ["long identity", JSON.stringify([{ provider: "p".repeat(129), rules: [] }])],
    ["duplicate decoded key", '[{"provider":"p","rules":[],"\\u0072ules":[]}]'],
    ["duplicate nested key", '[{"provider":"p","rules":[{"model":"m","targets":[{"provider":"q","model":"a","model":"b"}]}]}]'],
    ["oversized", " ".repeat(4 * 1024 * 1024 + 1)], ["excessive nesting", "[".repeat(9) + "]".repeat(9)],
  ])("rejects strict mapping violation %s without content in errors", (_label, raw) => { rejected(raw); });
  it("rejects disabled, unknown-family, hidden and getter authority by presence without calling getters", () => {
    for (const value of [undefined, "", "[]"]) expect(() => loadProviderGatewayConfig({ PROVIDER_GATEWAY_ENABLED: "0", PLATFORM_PROVIDER_FALLBACK_JSON: value })).toThrow(ProviderGatewayConfigError);
    expect(() => loadProviderGatewayConfig({ ...base(), PLATFORM_PROVIDER_FALLBACK_FUTURE: "private-fallback-secret" })).toThrow(ProviderGatewayConfigError);
    const getter = vi.fn(() => "[]"), env = base(); Object.defineProperty(env, "PLATFORM_PROVIDER_FALLBACK_JSON", { enumerable: true, get: getter });
    expect(() => loadProviderGatewayConfig(env)).toThrow(ProviderGatewayConfigError); expect(getter).not.toHaveBeenCalled();
    const hidden = base(); Object.defineProperty(hidden, "PLATFORM_PROVIDER_FALLBACK_JSON", { value: "[]" });
    expect(() => loadProviderGatewayConfig(hidden)).toThrow(ProviderGatewayConfigError);
  });
  it("rejects unknown source/target/provider against actual credentialed model inventory, not preset existence", () => {
    for (const rules of [[{ provider: "missing", rules: [] }], [{ provider: "dashscope", rules: [{ model: "missing", targets: [{ provider: "deepseek", model: "deepseek-chat" }] }] }],
      [{ provider: "dashscope", rules: [{ model: "qwen-plus", targets: [{ provider: "missing", model: "deepseek-chat" }] }] }],
      [{ provider: "dashscope", rules: [{ model: "qwen-plus", targets: [{ provider: "deepseek", model: "missing" }] }] }]]) {
      expect(() => validatePlatformProviderFallbacks(config(rules), actual())).toThrow(ProviderGatewayConfigError);
    }
    expect(() => validatePlatformProviderFallbacks(config(), [actual()[0]!])).toThrow(ProviderGatewayConfigError);
    expect(() => validatePlatformProviderFallbacks(config(), [...actual(), actual()[0]!])).toThrow(ProviderGatewayConfigError);
  });
  it("binds the full multi inventory, policy and explicit mapping to v4 without keys or private paths", () => {
    const loaded = pools(), cfg = loadProviderGatewayConfig({ ...base(), PLATFORM_PROVIDER_KEY_POOL_FILE: "/private/pool.json", PLATFORM_PROVIDER_FALLBACK_JSON: JSON.stringify(mapping()) });
    const digest = deriveProviderGatewayPolicySha256(cfg, loaded.inventory);
    expect(digest).toBe(createHash("sha256").update("provider-gateway-policy-v4\0").update(JSON.stringify({
      algorithm: "provider-gateway-explicit-fallback-v1", quotaPolicySha256: cfg.quotaPolicySha256,
      platformPool: { inventory: loaded.inventory, policy: cfg.breakerPolicy }, byokBreakerPolicy: null, platformFallbacks: cfg.platformFallbacks,
    })).digest("hex"));
    const reversed = structuredClone(loaded.inventory);
    if (reversed.version !== "provider-key-pools-v2") throw new Error("Expected multi inventory.");
    const reordered = { ...reversed, providers: [...reversed.providers].reverse() };
    expect(deriveProviderGatewayPolicySha256(cfg, reordered)).toBe(digest);
    const changed = { ...reversed, providers: reversed.providers.map((p, i) => i ? { ...p, slots: [{ id: "slot-A", version: "v2" }] } : p) };
    expect(deriveProviderGatewayPolicySha256(cfg, changed)).not.toBe(digest);
    expect(deriveProviderGatewayPolicySha256({ ...cfg, keyPoolFile: "/different/private/path" }, loaded.inventory)).toBe(digest);
    expect(deriveProviderGatewayPolicySha256({ ...cfg, byokBreakerPolicy: cfg.breakerPolicy }, loaded.inventory)).not.toBe(digest);
  });
  it("uses v4 for multi inventory even without fallback, while absent mapping v1 keeps v2/v3", () => {
    const cfg = loadProviderGatewayConfig({ ...base(), PLATFORM_PROVIDER_KEY_POOL_FILE: "/private/pool.json" }), loaded = pools();
    const multi = deriveProviderGatewayPolicySha256(cfg, loaded.inventory), single = loaded.providers[0]!.inventory;
    expect(multi).not.toBe(deriveProviderGatewayPolicySha256(cfg, single));
    expect(deriveProviderGatewayPolicySha256(cfg, single)).toBe(createHash("sha256").update("provider-gateway-policy-v2\0").update(JSON.stringify({
      algorithm: "provider-gateway-pool-v1", quotaPolicySha256: cfg.quotaPolicySha256, inventory: single, breaker: cfg.breakerPolicy,
    })).digest("hex"));
    const byok = loadProviderGatewayConfig({ ...base(), PLATFORM_PROVIDER_KEY_POOL_FILE: "/private/pool.json", PROVIDER_BYOK_BREAKER_JSON: "{}" });
    expect(deriveProviderGatewayPolicySha256(byok, single)).toBe(createHash("sha256").update("provider-gateway-policy-v3\0").update(JSON.stringify({
      algorithm: "provider-gateway-byok-breaker-v1", quotaPolicySha256: byok.quotaPolicySha256,
      platformPool: { inventory: single, policy: byok.breakerPolicy }, byokBreakerPolicy: byok.byokBreakerPolicy,
    })).digest("hex"));
  });
  it("rejects invalid multi inventory and accessors without deriving a partial fleet identity", () => {
    const cfg = loadProviderGatewayConfig({ ...base(), PLATFORM_PROVIDER_KEY_POOL_FILE: "/private/pool.json" }), loaded = pools();
    if (loaded.inventory.version !== "provider-key-pools-v2") throw new Error("Expected multi inventory.");
    for (const value of [{ ...loaded.inventory, providers: [] }, { ...loaded.inventory, providers: [loaded.inventory.providers[0], loaded.inventory.providers[0]] },
      { ...loaded.inventory, apiKey: "private-fallback-key" }]) expect(() => deriveProviderGatewayPolicySha256(cfg, value as typeof loaded.inventory)).toThrow(ProviderGatewayConfigError);
    const bad = { ...loaded.inventory }, getter = vi.fn(() => "provider-key-pools-v2"); Object.defineProperty(bad, "version", { enumerable: true, get: getter });
    expect(() => deriveProviderGatewayPolicySha256(cfg, bad)).toThrow(ProviderGatewayConfigError); expect(getter).not.toHaveBeenCalled();
  });
});
