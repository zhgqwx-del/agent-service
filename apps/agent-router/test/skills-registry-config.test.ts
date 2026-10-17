import { describe, expect, it } from "vitest";
import { skillRegistryFilesystemNamespaceSha256 } from "@agent-service/protocol";
import { loadRouterConfig } from "../src/config.js";

const base = { NODE_ENV: "test", RUNNERS: "http://runner:8787" };
const token = "skill-registry-operator-private-token-001";
describe("router managed skills registry configuration", () => {
  it("defaults off with no platform authority or namespace", () => {
    const cfg = loadRouterConfig(base); expect(cfg.SKILL_REGISTRY_ENABLED).toBe(false);
    expect(cfg.SKILL_REGISTRY_OPERATOR_TOKEN).toBeUndefined(); expect(cfg.skillRegistryStorage).toBeUndefined();
  });
  it("requires explicit single-runner filesystem scope rather than assuming shared storage", () => {
    const env = { ...base, SKILL_REGISTRY_ENABLED: "1", BLOB_FILESYSTEM_SINGLE_RUNNER: "1", BLOB_NAMESPACE_ID: "local-registry" };
    expect(loadRouterConfig(env).skillRegistryStorage).toEqual({ backend: "filesystem-v1", shared: false,
      namespaceSha256: skillRegistryFilesystemNamespaceSha256("local-registry") });
    expect(() => loadRouterConfig({ ...env, RUNNERS: "http://runner-a:8787,http://runner-b:8787" })).toThrow();
    expect(() => loadRouterConfig({ ...env, BLOB_NAMESPACE_ID: undefined })).toThrow();
    expect(() => loadRouterConfig({ ...env, BLOB_FILESYSTEM_SINGLE_RUNNER: "0" })).toThrow();
    expect(() => loadRouterConfig({ ...env, NODE_ENV: "production", INTERNAL_ROUTER_TOKEN: "private-internal-token-for-production" })).toThrow();
  });
  it.each(["INTERNAL_ROUTER_TOKEN", "ROUTER_ADMIN_TOKEN", "TENANT_ERASURE_OPERATOR_TOKEN", "METRICS_BEARER_TOKEN"])(
    "keeps the dedicated platform registry token independent from %s", key => {
      expect(() => loadRouterConfig({ ...base, SKILL_REGISTRY_OPERATOR_TOKEN: token, [key]: token })).toThrow();
    });
  it("permits user/tenant registry operation without inventing a platform credential", () => {
    const cfg = loadRouterConfig({ ...base, SKILL_REGISTRY_ENABLED: "1", BLOB_FILESYSTEM_SINGLE_RUNNER: "1", BLOB_NAMESPACE_ID: "local-registry" });
    expect(cfg.SKILL_REGISTRY_OPERATOR_TOKEN).toBeUndefined();
    expect(() => loadRouterConfig({ ...base, SKILL_REGISTRY_OPERATOR_TOKEN: "short" })).toThrow();
  });
});
