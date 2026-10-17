import { describe, expect, it } from "vitest";
import { skillRegistryFilesystemNamespaceSha256 } from "@agent-service/protocol";
import { loadConfig } from "../src/config.js";

const base = { NODE_ENV: "test", SECRETS_MASTER_KEY: "63".repeat(32) };
describe("runner managed skills registry configuration", () => {
  it("defaults off independently of old static skills and does not infer a namespace", () => {
    const cfg = loadConfig(base);
    expect(cfg.SKILL_REGISTRY_ENABLED).toBe(false); expect(cfg.skillRegistryStorage).toBeUndefined();
    expect(cfg.skills.enabled).toBe(false);
  });
  it("allows filesystem only with explicit nonproduction single-runner and namespace declarations", () => {
    const env = { ...base, SKILL_REGISTRY_ENABLED: "1", BLOB_FILESYSTEM_SINGLE_RUNNER: "1", BLOB_NAMESPACE_ID: "local-registry" };
    expect(loadConfig(env).skillRegistryStorage).toEqual({ backend: "filesystem-v1", shared: false,
      namespaceSha256: skillRegistryFilesystemNamespaceSha256("local-registry") });
    for (const key of ["BLOB_FILESYSTEM_SINGLE_RUNNER", "BLOB_NAMESPACE_ID"] as const) expect(() => loadConfig({ ...env, [key]: undefined })).toThrow();
    expect(() => loadConfig({ ...env, NODE_ENV: "production" })).toThrow();
  });
  it.each(["true", "false", "", "2"])("rejects noncanonical gate %j", value => {
    expect(() => loadConfig({ ...base, SKILL_REGISTRY_ENABLED: value })).toThrow();
  });
  it.each(["", "private-platform-skill-registry-token"])("rejects ambient router-only platform authority even when disabled (%#)", token => {
    expect(() => loadConfig({ ...base, SKILL_REGISTRY_OPERATOR_TOKEN: token })).toThrow("SKILL_REGISTRY_OPERATOR_TOKEN is router-only");
  });
});
