import { describe, expect, it } from "vitest";
import { providerQuotaNamespaceSha256 } from "@agent-service/protocol";
import { loadRouterConfig } from "../src/config.js";

const env = () => ({ RUNNERS: "http://127.0.0.1:8787", REDIS_URL: "redis://127.0.0.1:6479/0",
  REDIS_NAMESPACE_ID: "quota-config", PROVIDER_GATEWAY_ENABLED: "1", PROVIDER_GATEWAY_POLICY_SHA256: "a".repeat(64) });
describe("provider gateway router policy expectation", () => {
  it("defaults off without claiming a quota fleet", () => {
    const config = loadRouterConfig({ RUNNERS: "http://127.0.0.1:8787" });
    expect(config.PROVIDER_GATEWAY_ENABLED).toBe(false); expect(config.providerGatewayIdentity).toBeUndefined();
  });
  it("binds independently configured policy and namespace without credential material", () => {
    const config = loadRouterConfig(env());
    expect(config.providerGatewayIdentity).toEqual({
      namespaceSha256: providerQuotaNamespaceSha256({ prefix: "as", namespaceId: "quota-config" }), policySha256: "a".repeat(64),
    });
    expect(loadRouterConfig({ ...env(), REDIS_URL: "rediss://user:secret@localhost:6479/0" }).providerGatewayIdentity).toEqual(config.providerGatewayIdentity);
  });
  it.each(["REDIS_URL", "REDIS_NAMESPACE_ID", "PROVIDER_GATEWAY_POLICY_SHA256"])("rejects enabled without %s", name => {
    const config: NodeJS.ProcessEnv = env(); delete config[name];
    expect(() => loadRouterConfig(config)).toThrow("Invalid provider gateway fleet configuration");
  });
  it("rejects a disabled but supplied policy rather than silently dropping operator intent", () => {
    expect(() => loadRouterConfig({ ...env(), PROVIDER_GATEWAY_ENABLED: "0" })).toThrow("Invalid provider gateway fleet configuration");
  });
  it.each(["", "false", "true", "01", " 1"])("rejects ambiguous activation %s", flag => {
    expect(() => loadRouterConfig({ ...env(), PROVIDER_GATEWAY_ENABLED: flag })).toThrow();
  });
  it("does not permit hash-tag injection or malformed policy digest", () => {
    expect(() => loadRouterConfig({ ...env(), REDIS_PREFIX: "as{tag}" })).toThrow();
    expect(() => loadRouterConfig({ ...env(), PROVIDER_GATEWAY_POLICY_SHA256: "A".repeat(64) })).toThrow();
  });
  it.each(["PROVIDER_TENANT_QUOTA_JSON", "PROVIDER_USER_QUOTA_JSON", "PLATFORM_PROVIDER_QUOTA_JSON"])("rejects runner-only %s even while disabled", key => {
    for (const value of [undefined, "", "{}", "private-policy-canary"]) {
      expect(() => loadRouterConfig({ RUNNERS: "http://127.0.0.1:8787", [key]: value })).toThrow("Provider gateway quota policy is runner-only");
    }
  });
  it.each(["PLATFORM_PROVIDER_FALLBACK_JSON", "PLATFORM_PROVIDER_FALLBACK_FUTURE"])("rejects operator mapping %s by presence, not value", key => {
    for (const value of [undefined, "", "[]", "private-mapping-canary"]) {
      expect(() => loadRouterConfig({ RUNNERS: "http://127.0.0.1:8787", [key]: value })).toThrow("runner-only");
    }
    const hidden = { RUNNERS: "http://127.0.0.1:8787" }; Object.defineProperty(hidden, key, { value: "[]" });
    expect(() => loadRouterConfig(hidden)).toThrow("runner-only");
  });
});
