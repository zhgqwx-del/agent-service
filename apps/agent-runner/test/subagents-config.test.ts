import { describe, expect, it } from "vitest";
import { loadSubagentsConfig } from "../src/subagents-config.js";

describe("root-lease subagent runtime configuration", () => {
  it("defaults off with frozen finite ceilings", () => {
    const value = loadSubagentsConfig({});
    expect(value).toMatchObject({ enabled: false, maxDepth: 3, maxConcurrent: 2, maxTasks: 8 });
    expect(Object.isFrozen(value)).toBe(true);
    expect(value.configSha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("binds the flag and every runtime ceiling in a deterministic public identity", () => {
    const base = loadSubagentsConfig({ SUBAGENTS_ENABLED: "1" });
    expect(loadSubagentsConfig({ SUBAGENTS_MAX_TASKS: "8", SUBAGENTS_ENABLED: "1" })).toEqual(base);
    for (const env of [{ SUBAGENTS_ENABLED: "0" }, { SUBAGENTS_ENABLED: "1", SUBAGENTS_MAX_DEPTH: "2" },
      { SUBAGENTS_ENABLED: "1", SUBAGENTS_MAX_CONCURRENT: "1" }, { SUBAGENTS_ENABLED: "1", SUBAGENTS_MAX_TASKS: "7" }]) {
      expect(loadSubagentsConfig(env).configSha256).not.toBe(base.configSha256);
    }
  });
  it("allows preconfiguration but still validates when execution is disabled", () => {
    expect(loadSubagentsConfig({ SUBAGENTS_ENABLED: "0", SUBAGENTS_MAX_DEPTH: "8",
      SUBAGENTS_MAX_CONCURRENT: "8", SUBAGENTS_MAX_TASKS: "64" })).toMatchObject({ enabled: false,
      maxDepth: 8, maxConcurrent: 8, maxTasks: 64 });
    expect(() => loadSubagentsConfig({ SUBAGENTS_ENABLED: "0", SUBAGENTS_MAX_DEPTH: "9" })).toThrow("Invalid subagents runtime configuration");
  });
  it.each(["", "true", "false", "yes", "2"])("rejects noncanonical flag %j", value => {
    expect(() => loadSubagentsConfig({ SUBAGENTS_ENABLED: value })).toThrow("Invalid subagents runtime configuration");
  });
  it.each(["", "0", "-1", "01", "1.5", "1e1", "Infinity", "9007199254740992"])("rejects noncanonical ceiling %j", value => {
    expect(() => loadSubagentsConfig({ SUBAGENTS_MAX_DEPTH: value })).toThrow("Invalid subagents runtime configuration");
    expect(() => loadSubagentsConfig({ SUBAGENTS_MAX_CONCURRENT: value })).toThrow("Invalid subagents runtime configuration");
    expect(() => loadSubagentsConfig({ SUBAGENTS_MAX_TASKS: value })).toThrow("Invalid subagents runtime configuration");
  });
  it("rejects unknown authority without echoing its name or value", () => {
    const secret = "fixture-secret-not-for-logs";
    for (const env of [{ SUBAGENTS_API_KEY: secret }, { SUBAGENTS_MODULE_PATH: "/untrusted/module.js" },
      { SUBAGENTS_ENABLED: "0", SUBAGENTS_CLOUD_ENDPOINT: "https://not-used.example" }]) {
      expect(() => loadSubagentsConfig(env)).toThrow(/^Invalid subagents runtime configuration$/);
      try { loadSubagentsConfig(env); } catch (error) { expect(String(error)).not.toContain(secret); }
    }
  });
  it("does not mutate the caller environment or infer enablement from another subsystem", () => {
    const env = Object.freeze({ MCP_REGISTRY_ENABLED: "1", HOOKS_ENABLED: "1", TENANT_HOOKS_ENABLED: "1" });
    expect(loadSubagentsConfig(env).enabled).toBe(false);
    expect(env).toEqual({ MCP_REGISTRY_ENABLED: "1", HOOKS_ENABLED: "1", TENANT_HOOKS_ENABLED: "1" });
  });
});
