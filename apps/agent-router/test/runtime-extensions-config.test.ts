import { describe, expect, it } from "vitest";
import { loadRouterConfig } from "../src/config.js";
import { loadConfig } from "../../agent-runner/src/config.js";

const router = { NODE_ENV: "test", RUNNERS: "http://runner.example:8787" };
const runner = { NODE_ENV: "test", SECRETS_MASTER_KEY: "11".repeat(32) };
describe("runtime extension role-separated configuration", () => {
  it("defaults both roles off and allows only router activation flags", () => {
    expect(loadRouterConfig(router)).toMatchObject({ LIFECYCLE_HOOKS_ENABLED: false, SUBAGENTS_ENABLED: false });
    expect(loadConfig(runner)).toMatchObject({ lifecycleHooks: { enabled: false }, subagents: { enabled: false } });
    expect(loadRouterConfig({ ...router, LIFECYCLE_HOOKS_ENABLED: "1", SUBAGENTS_ENABLED: "1" }))
      .toMatchObject({ LIFECYCLE_HOOKS_ENABLED: true, SUBAGENTS_ENABLED: true });
  });
  it.each(["LIFECYCLE_HOOKS_CONFIG_JSON", "LIFECYCLE_HOOKS_TIMEOUT_MS", "LIFECYCLE_HOOKS_MAX_CONCURRENT_PER_USER",
    "SUBAGENTS_MAX_DEPTH", "SUBAGENTS_MAX_CONCURRENT", "SUBAGENTS_MAX_TASKS", "SUBAGENTS_UNKNOWN"])("rejects runner-only %s even when empty or disabled", field => {
    for (const value of ["", "0", "1"]) expect(() => loadRouterConfig({ ...router, [field]: value })).toThrow(/^Lifecycle package and subagent runtime configuration is runner-only$/);
  });
  it("requires durable shared storage and an explicit Redis namespace for product subagents", () => {
    const enabled = { ...runner, SUBAGENTS_ENABLED: "1", STORE: "mysql", REDIS_URL: "redis://fixture.invalid:1",
      REDIS_NAMESPACE_ID: "fixture-subagents", ERASURE_ROUTER_URL: "http://router.example" };
    expect(loadConfig(enabled).subagents.enabled).toBe(true);
    for (const field of ["REDIS_URL", "REDIS_NAMESPACE_ID"]) expect(() => loadConfig({ ...enabled, [field]: undefined })).toThrow(/Subagents require MySQL/);
    expect(() => loadConfig({ ...enabled, STORE: "memory" })).toThrow(/Subagents require MySQL/);
    expect(() => loadConfig({ ...enabled, ERASURE_ROUTER_URL: undefined })).toThrow(/ERASURE_ROUTER_URL/);
  });
  it("requires a router fleet endpoint for an enabled fixed lifecycle package", () => {
    const enabled = { ...runner, LIFECYCLE_HOOKS_ENABLED: "1", LIFECYCLE_HOOKS_CONFIG_JSON: JSON.stringify([
      { id: "fixture", package: "audit", subjects: [{ tenantId: "fixture", userId: "fixture" }], phases: ["Stop"] },
    ]) };
    expect(() => loadConfig(enabled)).toThrow(/ERASURE_ROUTER_URL/);
    expect(loadConfig({ ...enabled, ERASURE_ROUTER_URL: "http://router.example" }).lifecycleHooks.enabled).toBe(true);
  });
});
