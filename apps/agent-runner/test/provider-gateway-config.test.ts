import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { providerQuotaNamespaceSha256 } from "@agent-service/store";
import { loadProviderGatewayConfig, ProviderGatewayConfigError } from "../src/provider-gateway-config.js";

const CANARY = "private-provider-gateway-config-canary";
const POLICY_KEYS = ["PROVIDER_TENANT_QUOTA_JSON", "PROVIDER_USER_QUOTA_JSON", "PLATFORM_PROVIDER_QUOTA_JSON"] as const;
function enabled(): NodeJS.ProcessEnv {
  return { PROVIDER_GATEWAY_ENABLED: "1", REDIS_URL: "redis://127.0.0.1:6479/0", REDIS_NAMESPACE_ID: "gateway-config-test" };
}
function rejected(env: unknown): void {
  let failure: unknown;
  try { loadProviderGatewayConfig(env as NodeJS.ProcessEnv); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(ProviderGatewayConfigError);
  expect(failure).toMatchObject({ name: "ProviderGatewayConfigError", code: "provider_gateway_config_invalid",
    message: "Provider gateway configuration is invalid." });
  expect(Object.hasOwn(failure as object, "cause")).toBe(false);
  expect(String(failure)).not.toContain(CANARY);
}

describe("provider gateway operator quota configuration", () => {
  it("defaults off with independent frozen unlimited scopes and no digest", () => {
    const first = loadProviderGatewayConfig({}), second = loadProviderGatewayConfig({ PROVIDER_GATEWAY_ENABLED: "0" });
    expect(first).toEqual({ enabled: false, tenant: {}, user: {}, platformProvider: {}, policySha256: null });
    expect(second).toEqual(first);
    for (const value of [first, first.tenant, first.user, first.platformProvider]) expect(Object.isFrozen(value)).toBe(true);
    expect(first.tenant).not.toBe(first.user); expect(first.tenant).not.toBe(second.tenant);
  });

  it("does not inspect unrelated secrets or disabled Redis authority", () => {
    const getter = vi.fn(() => { throw new Error(CANARY); }), env: NodeJS.ProcessEnv = {};
    for (const key of ["UNRELATED_SECRET", "REDIS_URL", "REDIS_NAMESPACE_ID", "REDIS_PREFIX"]) {
      Object.defineProperty(env, key, { enumerable: true, get: getter });
    }
    expect(loadProviderGatewayConfig(env).enabled).toBe(false); expect(getter).not.toHaveBeenCalled();
  });

  it("requires Redis even for explicitly selected Memory storage", () => {
    expect(loadProviderGatewayConfig({ ...enabled(), STORE: "memory" })).toMatchObject({ enabled: true, tenant: {}, user: {}, platformProvider: {} });
    for (const key of ["REDIS_URL", "REDIS_NAMESPACE_ID"]) {
      const env: NodeJS.ProcessEnv = { ...enabled(), STORE: "memory" }; delete env[key]; rejected(env);
    }
  });

  it("returns an immutable clone without mutating a frozen or null-prototype environment", () => {
    const env = { ...enabled(), PROVIDER_TENANT_QUOTA_JSON: '{"concurrency":2,"rpm":600}',
      PROVIDER_USER_QUOTA_JSON: '{"rpm":1}', PLATFORM_PROVIDER_QUOTA_JSON: '{"concurrency":1000000}' };
    const before = structuredClone(env), config = loadProviderGatewayConfig(Object.freeze({ ...env }));
    expect(config).toMatchObject({ enabled: true, tenant: { rpm: 600, concurrency: 2 }, user: { rpm: 1 }, platformProvider: { concurrency: 1_000_000 } });
    expect(loadProviderGatewayConfig(Object.assign(Object.create(null), env))).toEqual(config);
    expect(env).toEqual(before);
    for (const value of [config, config.tenant, config.user, config.platformProvider]) expect(Object.isFrozen(value)).toBe(true);
    expect(() => Object.defineProperty(config.tenant, "rpm", { value: 999 })).toThrow(TypeError);
    env.PROVIDER_TENANT_QUOTA_JSON = '{"rpm":999}'; expect(config.tenant.rpm).toBe(600);
  });

  it("uses the shared namespace domain and a fixed versioned canonical policy", () => {
    const env = { ...enabled(), PROVIDER_TENANT_QUOTA_JSON: '{"rpm":600,"concurrency":2}',
      PROVIDER_USER_QUOTA_JSON: '{"concurrency":3}', PLATFORM_PROVIDER_QUOTA_JSON: '{"rpm":1000}' };
    const redisNamespaceSha256 = createHash("sha256").update("provider-quota-namespace-v1\0")
      .update(JSON.stringify({ prefix: "as", namespaceId: "gateway-config-test" })).digest("hex");
    expect(providerQuotaNamespaceSha256({ prefix: "as", namespaceId: "gateway-config-test" })).toBe(redisNamespaceSha256);
    const expected = createHash("sha256").update("provider-gateway-policy-v1\0")
      .update(JSON.stringify({ algorithm: "provider-quota-v1", redisNamespaceSha256,
        tenant: { rpm: 600, concurrency: 2 }, user: { concurrency: 3 }, platformProvider: { rpm: 1000 } })).digest("hex");
    expect(loadProviderGatewayConfig(env).policySha256).toBe(expected);
    expect(loadProviderGatewayConfig({ ...env, PROVIDER_TENANT_QUOTA_JSON: ' { "concurrency": 2.0, "r\\u0070m": 6e2 } ' }).policySha256).toBe(expected);
    expect(loadProviderGatewayConfig({ ...env, REDIS_PREFIX: "as" }).policySha256).toBe(expected);
  });

  it("binds each scope, prefix and namespace, but not a Redis credential or transport spelling", () => {
    const env = { ...enabled(), PROVIDER_TENANT_QUOTA_JSON: '{"rpm":10}', PROVIDER_USER_QUOTA_JSON: '{"rpm":20}',
      PLATFORM_PROVIDER_QUOTA_JSON: '{"rpm":30}' }, digest = loadProviderGatewayConfig(env).policySha256;
    for (const change of [{ PROVIDER_TENANT_QUOTA_JSON: '{"rpm":11}' }, { PROVIDER_USER_QUOTA_JSON: '{"rpm":21}' },
      { PLATFORM_PROVIDER_QUOTA_JSON: '{"rpm":31}' }, { REDIS_PREFIX: "other" }, { REDIS_NAMESPACE_ID: "other" }]) {
      expect(loadProviderGatewayConfig({ ...env, ...change }).policySha256).not.toBe(digest);
    }
    expect(loadProviderGatewayConfig({ ...env, REDIS_URL: `rediss://user:${CANARY}@localhost:6479/0` }).policySha256).toBe(digest);
    expect(JSON.stringify(loadProviderGatewayConfig(env))).not.toContain("REDIS_URL");
    expect(JSON.stringify(loadProviderGatewayConfig(env))).not.toContain("gateway-config-test");
  });

  it("canonicalizes absent and explicitly empty quotas as unlimited without inheriting tenant API policy", () => {
    const config = loadProviderGatewayConfig(enabled());
    expect(loadProviderGatewayConfig({ ...enabled(), PROVIDER_TENANT_QUOTA_JSON: "{}", PROVIDER_USER_QUOTA_JSON: "{}",
      PLATFORM_PROVIDER_QUOTA_JSON: "{}", PROVIDERS_JSON: CANARY })).toEqual(config);
    expect(config.policySha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(POLICY_KEYS)("rejects provided %s while disabled, including empty and undefined", key => {
    for (const flag of [undefined, "0"]) for (const value of [undefined, "", "{}", CANARY]) {
      rejected({ ...(flag === undefined ? {} : { PROVIDER_GATEWAY_ENABLED: flag }), [key]: value });
    }
  });

  it.each(["", "true", "false", "01", "2", " 1", "1\n", undefined, null, 1])("rejects a nonliteral activation flag (%#)", value => {
    rejected({ ...enabled(), PROVIDER_GATEWAY_ENABLED: value });
  });

  it.each(POLICY_KEYS)("rejects invalid or duplicate JSON members in %s", key => {
    for (const raw of ["", " ", "null", "[]", "1", '"quota"', '{"rpm":1,}', '{rpm:1}',
      '{"rpm":1,"extra":2}', '{"__proto__":{"rpm":1}}', '{"rpm":{"rpm":1}}', '{"rpm":[1]}',
      '{"rpm":null}', '{"rpm":"1"}', '{"rpm":true}', '{"rpm":0}', '{"rpm":-1}', '{"rpm":1.5}',
      '{"rpm":1000001}', '{"rpm":1e309}', '{"concurrency":0}', '{"concurrency":1000001}',
      '{"rpm":1,"rpm":2}', '{"rpm":1,"r\\u0070m":2}', '{"concurrency":1,"concurrency":2}',
      '{"rpm":null,"rpm":1}', '{"rpm":1}//comment', `{${CANARY}}`]) rejected({ ...enabled(), [key]: raw });
    for (const value of [undefined, null, 1, {}, []]) rejected({ ...enabled(), [key]: value });
  });

  it("enforces the exact UTF8 byte limit before JSON parsing", () => {
    const raw = " ".repeat(2046) + "{}";
    expect(loadProviderGatewayConfig({ ...enabled(), PROVIDER_TENANT_QUOTA_JSON: raw }).tenant).toEqual({});
    rejected({ ...enabled(), PROVIDER_TENANT_QUOTA_JSON: " " + raw });
    rejected({ ...enabled(), PROVIDER_TENANT_QUOTA_JSON: JSON.stringify({ ["中".repeat(700)]: 1 }) });
  });

  it.each(["REDIS_URL", "REDIS_NAMESPACE_ID"])("requires an explicit nonempty %s", key => {
    const missing = enabled(); delete missing[key]; rejected(missing);
    for (const value of [undefined, "", null, 1]) rejected({ ...enabled(), [key]: value });
  });

  it("rejects malformed Redis URLs without echoing credentials", () => {
    for (const url of [CANARY, `https://${CANARY}.invalid`, "redis://", "redis://127.0.0.1:0/0", "redis://127.0.0.1:65536/0",
      " redis://127.0.0.1:6479", "redis://127.0.0.1:6479\n", `redis://user:${CANARY}@localhost:6479/0#fragment`]) {
      rejected({ ...enabled(), REDIS_URL: url });
    }
    expect(loadProviderGatewayConfig({ ...enabled(), REDIS_URL: "rediss://[::1]:6479/0" }).enabled).toBe(true);
  });

  it("accepts only exact hash-tag-free prefix and namespace identities at their bounds", () => {
    expect(loadProviderGatewayConfig({ ...enabled(), REDIS_PREFIX: "A" + "x".repeat(63), REDIS_NAMESPACE_ID: "n".repeat(128) }).enabled).toBe(true);
    for (const prefix of ["", ".hidden", "_hidden", "-hidden", ":hidden", "a".repeat(65), "a{tag}", "a/b", "a b", "中", undefined, null]) {
      rejected({ ...enabled(), REDIS_PREFIX: prefix });
    }
    for (const namespace of ["n".repeat(129), "n{tag}", "n/b", "n b", "中", "n\n"]) rejected({ ...enabled(), REDIS_NAMESPACE_ID: namespace });
  });

  it("rejects accessors, hidden and inherited inputs without invoking their getters", () => {
    for (const key of ["PROVIDER_GATEWAY_ENABLED", ...POLICY_KEYS, "REDIS_URL", "REDIS_NAMESPACE_ID", "REDIS_PREFIX"]) {
      const getter = vi.fn(() => { throw new Error(CANARY); }), env = enabled();
      Object.defineProperty(env, key, { enumerable: true, get: getter }); rejected(env); expect(getter).not.toHaveBeenCalled();
      const hidden = enabled(); Object.defineProperty(hidden, key, { value: CANARY, enumerable: false }); rejected(hidden);
      const inherited = enabled(); delete inherited[key]; Object.setPrototypeOf(inherited, { [key]: CANARY }); rejected(inherited);
    }
  });

  it("normalizes hostile descriptor failures and invalid environments into fixed errors", () => {
    rejected(new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error(CANARY, { cause: CANARY }); } }));
    for (const env of [undefined, null, [], "env", 1]) rejected(env);
  });
});
