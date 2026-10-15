import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const MASTER = "11".repeat(32);
const TOKEN = "metrics-runner-config-unit-token-000001";
const base = { SECRETS_MASTER_KEY: MASTER };

function failure(env: NodeJS.ProcessEnv): string {
  let thrown: unknown;
  try { loadConfig(env); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(Error);
  if (!(thrown instanceof Error)) throw new Error("metrics configuration unexpectedly succeeded");
  return thrown.message;
}

describe("runner metrics configuration", () => {
  it("defaults off and permits a valid provisioned credential without activating metrics", () => {
    expect(loadConfig(base).METRICS_ENABLED).toBe(false);
    expect(loadConfig(base).METRICS_BEARER_TOKEN).toBeUndefined();
    expect(loadConfig({ ...base, METRICS_ENABLED: "0", METRICS_BEARER_TOKEN: TOKEN })).toMatchObject({
      METRICS_ENABLED: false, METRICS_BEARER_TOKEN: TOKEN,
    });
  });
  it.each(["a".repeat(32), "z".repeat(256), "metrics.unit-config_token~safe-000001"])("enables only an explicitly configured valid credential (%s)", (token) => {
    expect(loadConfig({ ...base, METRICS_ENABLED: "1", METRICS_BEARER_TOKEN: token })).toMatchObject({ METRICS_ENABLED: true, METRICS_BEARER_TOKEN: token });
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
  ] as const)("validates even disabled token syntax: %s", (_label, token) => {
    const enabled = failure({ ...base, METRICS_ENABLED: "1", METRICS_BEARER_TOKEN: token });
    const disabled = failure({ ...base, METRICS_ENABLED: "0", METRICS_BEARER_TOKEN: token });
    expect(enabled).toMatch(/metrics/i);
    expect(disabled).toBe(enabled);
    if (token) expect(enabled).not.toContain(token);
  });
  it.each(["INTERNAL_ROUTER_TOKEN", "ROUTER_ADMIN_TOKEN", "TENANT_ERASURE_OPERATOR_TOKEN", "BOOTSTRAP_API_KEY", "API_KEY"])("rejects known privileged credential reuse without echoing it: %s", (name) => {
    for (const enabled of ["0", "1"]) {
      const message = failure({ ...base, [name]: TOKEN, METRICS_ENABLED: enabled, METRICS_BEARER_TOKEN: TOKEN });
      // Existing role-only rejection keeps precedence; it is still fixed and fail closed.
      expect(message).toMatch(name === "TENANT_ERASURE_OPERATOR_TOKEN" ? /router-only/ : /metrics/i);
      expect(message).not.toContain(TOKEN);
    }
  });
  it("does not reuse the master key or implicit local routing token", () => {
    expect(failure({ ...base, METRICS_ENABLED: "1", METRICS_BEARER_TOKEN: MASTER })).not.toContain(MASTER);
    expect(failure({ ...base, METRICS_ENABLED: "1", METRICS_BEARER_TOKEN: "agent-service-local-router-token-v1" })).toMatch(/metrics/i);
  });
  it("uses the same fixed error for different invalid secret values", () => {
    const first = "invalid first private metrics token " + "a".repeat(32);
    const second = "invalid second private metrics token " + "b".repeat(32);
    const message = failure({ ...base, METRICS_ENABLED: "1", METRICS_BEARER_TOKEN: first });
    expect(message).toBe(failure({ ...base, METRICS_ENABLED: "1", METRICS_BEARER_TOKEN: second }));
    expect(message).not.toContain(first);
    expect(message).not.toContain(second);
  });
});
