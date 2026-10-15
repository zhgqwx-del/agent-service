import { describe, expect, it } from "vitest";
import { loadRouterConfig } from "../src/config.js";

const TOKEN = "metrics-router-config-unit-token-000001";
const base = { RUNNERS: "http://127.0.0.1:9" };

function failure(env: NodeJS.ProcessEnv): string {
  let thrown: unknown;
  try { loadRouterConfig(env); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(Error);
  if (!(thrown instanceof Error)) throw new Error("metrics configuration unexpectedly succeeded");
  return thrown.message;
}

describe("router metrics configuration", () => {
  it("defaults off and does not activate a preprovisioned token", () => {
    expect(loadRouterConfig(base).METRICS_ENABLED).toBe(false);
    expect(loadRouterConfig(base).METRICS_BEARER_TOKEN).toBeUndefined();
    expect(loadRouterConfig({ ...base, METRICS_ENABLED: "0", METRICS_BEARER_TOKEN: TOKEN })).toMatchObject({
      METRICS_ENABLED: false, METRICS_BEARER_TOKEN: TOKEN,
    });
  });
  it.each(["a".repeat(32), "z".repeat(256), "metrics.unit-config_token~safe-000001"])("enables only explicitly valid metrics authority (%s)", (token) => {
    expect(loadRouterConfig({ ...base, METRICS_ENABLED: "1", METRICS_BEARER_TOKEN: token })).toMatchObject({ METRICS_ENABLED: true, METRICS_BEARER_TOKEN: token });
  });
  it("requires a credential when enabled", () => {
    expect(failure({ ...base, METRICS_ENABLED: "1" })).toMatch(/metrics/i);
  });
  it.each(["", "true", "false", "2", "yes", "01"])("rejects non-0/1 flags (%j)", (flag) => {
    expect(failure({ ...base, METRICS_ENABLED: flag, METRICS_BEARER_TOKEN: TOKEN })).not.toContain(TOKEN);
  });
  it.each([
    ["empty", ""], ["short", "a".repeat(31)], ["long", "a".repeat(257)],
    ["space", "metrics config token with spaces 000001"], ["newline", "metrics-config-token-000000000000000\n"],
    ["unicode", "metrics-config-token-000000000000000汉"], ["slash", "metrics/config/token/0000000000000000"],
    ["base64 punctuation", "metrics-config-token-000000000000000+="],
  ] as const)("rejects invalid syntax even when disabled: %s", (_label, token) => {
    const enabled = failure({ ...base, METRICS_ENABLED: "1", METRICS_BEARER_TOKEN: token });
    const disabled = failure({ ...base, METRICS_ENABLED: "0", METRICS_BEARER_TOKEN: token });
    expect(enabled).toMatch(/metrics/i);
    expect(disabled).toBe(enabled);
    if (token) expect(enabled).not.toContain(token);
  });
  it.each(["INTERNAL_ROUTER_TOKEN", "ROUTER_ADMIN_TOKEN", "TENANT_ERASURE_OPERATOR_TOKEN", "BOOTSTRAP_API_KEY", "API_KEY"])("keeps metrics separate from privileged authority: %s", (name) => {
    for (const enabled of ["0", "1"]) {
      const message = failure({ ...base, [name]: TOKEN, METRICS_ENABLED: enabled, METRICS_BEARER_TOKEN: TOKEN });
      // Do not reorder the pre-existing rejection of runner-only authority for this feature.
      expect(message).toMatch(name === "BOOTSTRAP_API_KEY" || name === "API_KEY" ? /runner-only/ : /metrics/i);
      expect(message).not.toContain(TOKEN);
    }
  });
  it("rejects a master-key match and the default local routing token", () => {
    const master = "11".repeat(32);
    expect(failure({ ...base, SECRETS_MASTER_KEY: master, METRICS_ENABLED: "1", METRICS_BEARER_TOKEN: master })).not.toContain(master);
    expect(failure({ ...base, METRICS_ENABLED: "1", METRICS_BEARER_TOKEN: "agent-service-local-router-token-v1" })).toMatch(/metrics/i);
  });
  it("reports the same fixed, content-free error for different invalid secrets", () => {
    const first = "invalid first private metrics token " + "a".repeat(32);
    const second = "invalid second private metrics token " + "b".repeat(32);
    const message = failure({ ...base, METRICS_ENABLED: "1", METRICS_BEARER_TOKEN: first });
    expect(message).toBe(failure({ ...base, METRICS_ENABLED: "1", METRICS_BEARER_TOKEN: second }));
    expect(message).not.toContain(first);
    expect(message).not.toContain(second);
  });
});
