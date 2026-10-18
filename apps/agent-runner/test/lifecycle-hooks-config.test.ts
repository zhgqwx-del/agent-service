import { describe, expect, it, vi } from "vitest";
import { loadLifecycleHooksConfig } from "../src/lifecycle-hooks-config.js";

const owner = { tenantId: "tenant", userId: "user" };
const audit = () => ({ id: "audit", package: "audit", subjects: [owner], phases: ["SessionStart", "Stop"] });
const prompt = () => ({ id: "prompt", package: "prompt-policy", subjects: [owner], prependText: "prefix", appendText: "append",
  modelRef: { provider: "configured", model: "small" }, limits: { maxSteps: 2, maxCostCNY: 0.5 } });
const tool = () => ({ id: "tool", package: "tool-policy", subjects: [owner], denyTools: ["remove"], rewrites: [{ tool: "write", args: { safe: true } }] });
const memory = () => ({ id: "memory", package: "memory-injection", subjects: [owner], prefix: "memory prefix", append: "memory append" });
const parse = (packages: unknown, env: NodeJS.ProcessEnv = {}) => loadLifecycleHooksConfig({ LIFECYCLE_HOOKS_CONFIG_JSON: JSON.stringify(packages), ...env });
const message = "Invalid lifecycle hooks operator configuration";

describe("fixed lifecycle hooks runner configuration", () => {
  it("defaults off and does not consult ambient env, files, DNS or fetch", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    try {
      const result = loadLifecycleHooksConfig({});
      expect(result).toMatchObject({ enabled: false, packages: [], timeoutMs: 1500, maxConcurrentPerUser: 2 });
      expect(result.configSha256).toMatch(/^[a-f0-9]{64}$/); expect(fetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  it("registers all four trusted built-ins with exact immutable copied configuration", () => {
    const definitions = [audit(), prompt(), tool(), memory()];
    const result = parse(definitions, { LIFECYCLE_HOOKS_ENABLED: "1" });
    expect(result.packages).toEqual(definitions); expect(result.enabled).toBe(true);
    expect([result, result.packages, ...result.packages, ...result.packages.flatMap(p => p.subjects)].every(Object.isFrozen)).toBe(true);
    expect(result.packages.map(p => p.package)).toEqual(["audit", "prompt-policy", "tool-policy", "memory-injection"]);
  });
  it("permits valid disabled staging but enabled requires at least one package", () => {
    expect(parse([audit()]).enabled).toBe(false);
    expect(() => parse([], { LIFECYCLE_HOOKS_ENABLED: "1" })).toThrowError(new Error(message));
  });
  it("accepts closed budget bounds and hashes phase/ACL/config/order/budget changes", () => {
    const initial = parse([audit(), memory()]);
    const variants = [parse([audit(), memory()], { LIFECYCLE_HOOKS_ENABLED: "1" }),
      parse([audit(), memory()], { LIFECYCLE_HOOKS_TIMEOUT_MS: "100", LIFECYCLE_HOOKS_MAX_CONCURRENT_PER_USER: "1" }),
      parse([audit(), memory()], { LIFECYCLE_HOOKS_TIMEOUT_MS: "5000", LIFECYCLE_HOOKS_MAX_CONCURRENT_PER_USER: "8" }),
      parse([memory(), audit()]), parse([{ ...audit(), phases: ["Interrupt"] }, memory()]),
      parse([{ ...audit(), subjects: [{ ...owner, userId: "other" }] }, memory()]),
      parse([audit(), { ...memory(), append: "different" }])];
    expect(new Set([initial, ...variants].map(config => config.configSha256)).size).toBe(variants.length + 1);
  });
  it("canonicalizes object keys and exact ACL permutations, not locale identities", () => {
    const subjects = [{ tenantId: "é", userId: "same" }, { tenantId: "e\u0301", userId: "same" }, { tenantId: "ASCII", userId: "same" }];
    const first = parse([{ ...audit(), subjects }]);
    const second = parse([{ phases: ["Stop", "SessionStart"], subjects: [...subjects].reverse(), package: "audit", id: "audit" }]);
    expect(first.configSha256).toBe(second.configSha256);
    expect(parse([{ ...audit(), subjects: [{ tenantId: "中".repeat(100), userId: "same" }] }]).packages[0]?.subjects[0]?.tenantId).toBe("中".repeat(100));
  });
  it.each([
    null, {}, true, [audit(), audit()], [{ ...audit(), id: "*" }], [{ ...audit(), phases: [] }],
    [{ ...audit(), phases: ["sessionStart"] }], [{ ...audit(), phases: ["ModelStep"] }],
    [{ ...audit(), subjects: [] }], [{ ...audit(), subjects: [owner, owner] }],
    [{ ...audit(), subjects: [{ tenantId: "x".repeat(129), userId: "user" }] }],
    [{ ...audit(), subjects: [{ tenantId: "tenant", userId: "*" }] }], [{ ...audit(), subjects: [{ ...owner, role: "admin" }] }],
    [{ ...prompt(), limits: { maxCostCNY: 0 } }], [{ ...prompt(), limits: { maxSteps: 1, apiKey: "secret" } }],
    [{ ...prompt(), maxPromptBytes: 0 }], [{ ...prompt(), maxModelInputBytes: 33_554_433 }],
    [{ ...prompt(), modelRef: { provider: "p", model: "m", fetch: "private" } }],
    [{ ...tool(), rewrites: [{ tool: "write", args: {} }, { tool: "write", args: {} }] }],
    [{ ...tool(), denyTools: ["write"], rewrites: [{ tool: "write", args: {} }] }],
    [{ ...memory(), prefix: "x".repeat(8193) }], [{ ...memory(), append: "hidden\u0000control" }],
    Array.from({ length: 9 }, (_, n) => ({ ...audit(), id: `a${n}` })),
  ].map(value => ({ value })))("rejects invalid registry/phase/ACL/limits while disabled too (%#)", ({ value }) => {
    expect(() => parse(value)).toThrowError(new Error(message));
  });
  it.each([
    { ...audit(), module: "/private/code.js" }, { ...audit(), package: "tenant-code" },
    { ...audit(), headers: { authorization: "secret-canary" } }, { ...audit(), token: "secret-canary" },
    { ...audit(), endpoint: "https://private.invalid/hook" }, { ...audit(), fetch: "private" },
    { ...prompt(), system: "private" }, { ...prompt(), readOnly: true }, { ...tool(), needsApproval: false },
  ])("rejects dynamic loaders, transport, secrets and authority extensions (%#)", value => {
    expect(() => parse([value])).toThrowError(new Error(message));
  });
  it.each([
    '[{"id":"audit","id":"other","package":"audit","subjects":[{"tenantId":"t","userId":"u"}],"phases":["Stop"]}]',
    '[{"id":"audit","\\u0069d":"other","package":"audit","subjects":[{"tenantId":"t","userId":"u"}],"phases":["Stop"]}]',
    '[{"id":"audit","package":"audit","subjects":[{"tenantId":"t","userId":"u","user\\u0049d":"other"}],"phases":["Stop"]}]',
    '[{"id":"tool","package":"tool-policy","subjects":[{"tenantId":"t","userId":"u"}],"denyTools":[],"rewrites":[{"tool":"write","args":{"x":1,"x":2}}]}]',
    "[] extra", " ".repeat(65_537), "",
  ])("rejects malformed/oversized or escaped duplicate JSON authority (%#)", raw => {
    expect(() => loadLifecycleHooksConfig({ LIFECYCLE_HOOKS_CONFIG_JSON: raw })).toThrowError(new Error(message));
  });
  it.each([
    { LIFECYCLE_HOOKS_ENABLED: "true" }, { LIFECYCLE_HOOKS_ENABLED: "" },
    { LIFECYCLE_HOOKS_TIMEOUT_MS: "99" }, { LIFECYCLE_HOOKS_TIMEOUT_MS: "5001" }, { LIFECYCLE_HOOKS_TIMEOUT_MS: "0100" },
    { LIFECYCLE_HOOKS_MAX_CONCURRENT_PER_USER: "0" }, { LIFECYCLE_HOOKS_MAX_CONCURRENT_PER_USER: "9" },
    { LIFECYCLE_HOOKS_TIMEOUT_MS: "9007199254740992" }, { LIFECYCLE_HOOKS_MODULE: "private" },
    { LIFECYCLE_HOOKS_API_KEY: "secret-canary" }, { LIFECYCLE_HOOKS_FUTURE: "" },
  ])("rejects unknown env, secrets and malformed budget values (%#)", env => {
    expect(() => parse([audit()], env)).toThrowError(new Error(message));
  });
  it("does not consume or reinterpret old v1/v2 config families", () => {
    expect(loadLifecycleHooksConfig({ HOOKS_ENABLED: "1", HOOKS_CONFIG_JSON: "invalid", TENANT_HOOKS_ENABLED: "1" }))
      .toEqual(loadLifecycleHooksConfig({}));
  });
});
