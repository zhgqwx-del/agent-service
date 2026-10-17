import { afterEach, describe, expect, it, vi } from "vitest";
import { loadToolHooksConfig } from "../src/hooks-config.js";

const message = "Invalid tool hooks operator configuration";
const owner = () => ({ tenantId: "tenant-hook", userId: "user-hook" });
const deny = () => ({ id: "deny", phase: "preToolUse", kind: "deny-tools", subjects: [owner()], tools: ["write"] });
const observe = () => ({ id: "observe", phase: "postToolUse", kind: "observe-tool-result", subjects: [owner()] });
const webhook = () => ({ id: "remote", phase: "preToolUse", kind: "webhook", subjects: [owner()],
  endpoint: "https://hooks.example.invalid/check", signingKeyFile: "/private/operator-not-opened/hook.key" });
const config = (hooks: unknown, extra: NodeJS.ProcessEnv = {}) => loadToolHooksConfig({ HOOKS_CONFIG_JSON: JSON.stringify(hooks), ...extra });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

// These are resource-free parser tests. An accepted HTTPS name is not a DNS/public-IP
// attestation: the unchanged native HTTP substrate enforces that at actual dispatch.
describe("tool hooks operator configuration", () => {
  it("defaults off with an empty list and does not inherit ambient configuration", () => {
    vi.stubEnv("HOOKS_ENABLED", "1"); vi.stubEnv("HOOKS_SIGNING_KEY", "secret-canary");
    expect(loadToolHooksConfig({})).toEqual({ enabled: false, hooks: [], timeoutMs: 1500,
      maxConcurrentPerUser: 2, allowLoopbackForTests: false });
  });
  it("parses all three closed kinds without opening a keyfile, resolving DNS or calling fetch", () => {
    const fetch = vi.fn(() => { throw new Error("unexpected network"); }); vi.stubGlobal("fetch", fetch);
    const result = config([deny(), observe(), webhook()], { HOOKS_ENABLED: "1" });
    expect(result.enabled).toBe(true); expect(result.hooks).toEqual([deny(), observe(), webhook()]);
    expect(fetch.mock.calls.length).toBe(0);
    expect([result, result.hooks, ...result.hooks, ...result.hooks.map(h => h.subjects),
      ...result.hooks.flatMap(h => h.subjects)].every(Object.isFrozen)).toBe(true);
    const d = result.hooks[0]; expect(d?.kind === "deny-tools" && Object.isFrozen(d.tools)).toBe(true);
  });
  it("allows valid pre-staged configuration without enabling it", () => {
    const result = config([webhook()]); expect(result.enabled).toBe(false); expect(result.hooks).toHaveLength(1);
  });
  it("accepts pretty JSON and arbitrary property order without changing exact ACL data", () => {
    const raw = JSON.stringify([{ tools: ["write"], subjects: [owner()], kind: "deny-tools", phase: "preToolUse", id: "deny" }], null, 2);
    expect(loadToolHooksConfig({ HOOKS_CONFIG_JSON: raw }).hooks).toEqual([deny()]);
  });
  it("accepts the finite upper bounds and retains configured hook order", () => {
    const hooks = Array.from({ length: 8 }, (_, i) => ({ ...deny(), id: `hook_${i}`,
      tools: Array.from({ length: 64 }, (_, n) => `tool_${n}`),
      subjects: Array.from({ length: 64 }, (_, n) => ({ tenantId: "tenant", userId: `user_${n}` })) }));
    const result = config(hooks, { HOOKS_ENABLED: "1", HOOKS_TIMEOUT_MS: "5000", HOOKS_MAX_CONCURRENT_PER_USER: "8" });
    expect(result.hooks.map(h => h.id)).toEqual(hooks.map(h => h.id)); expect(result.timeoutMs).toBe(5000);
    expect(result.maxConcurrentPerUser).toBe(8);
    expect(config([deny()], { HOOKS_TIMEOUT_MS: "100", HOOKS_MAX_CONCURRENT_PER_USER: "1" }).timeoutMs).toBe(100);
  });
  it.each([
    null, {}, true, [], [deny(), deny()], [{ ...deny(), id: "*" }], [{ ...deny(), id: "x".repeat(65) }],
    [{ ...deny(), kind: "script" }], [{ ...deny(), phase: "postToolUse" }], [{ ...observe(), phase: "preToolUse" }],
    [{ ...deny(), subjects: [] }], [{ ...deny(), subjects: [owner(), owner()] }],
    [{ ...deny(), subjects: [{ tenantId: "tenant", userId: "*" }] }],
    [{ ...deny(), subjects: [{ ...owner(), role: "admin" }] }], [{ ...deny(), subjects: [{ tenantId: "", userId: "user" }] }],
    [{ ...deny(), subjects: [{ tenantId: "t".repeat(129), userId: "user" }] }],
    [{ ...deny(), tools: [] }], [{ ...deny(), tools: ["write", "write"] }], [{ ...deny(), tools: ["*"] }],
    [{ ...deny(), tools: ["prefix_*"] }], [{ ...deny(), tools: ["tool.with.dot"] }], [{ ...deny(), tools: ["x".repeat(65)] }],
    Array.from({ length: 9 }, (_, i) => ({ ...deny(), id: `hook_${i}` })),
    [{ ...deny(), subjects: Array.from({ length: 65 }, (_, i) => ({ tenantId: "tenant", userId: `u_${i}` })) }],
    [{ ...deny(), tools: Array.from({ length: 65 }, (_, i) => `tool_${i}`) }],
  ].map(value => ({ value })))("rejects invalid kind/phase/identity/ACL/bounds even while enabled (%#)", ({ value }) => {
    expect(() => config(value, { HOOKS_ENABLED: "1" })).toThrowError(new Error(message));
  });
  it.each([
    { ...webhook(), signingKey: "secret-canary" }, { ...webhook(), signingKeyBase64: "secret-canary" },
    { ...webhook(), headers: { authorization: "secret-canary" } }, { ...webhook(), redirect: "follow" },
    { ...webhook(), auth: { token: "secret-canary" } }, { ...webhook(), client: {} },
    { ...webhook(), signingKeyFile: "relative.key" }, { ...webhook(), signingKeyFile: "/private/secret\u0000canary" },
    { ...webhook(), endpoint: "http://hooks.example.invalid/check" },
    { ...webhook(), endpoint: "https://user:secret-canary@hooks.example.invalid/check" },
    { ...webhook(), endpoint: "https://hooks.example.invalid/check?token=secret-canary" },
    { ...webhook(), endpoint: "https://hooks.example.invalid/check#secret-canary" },
    { ...webhook(), endpoint: "file:///private/secret-canary" },
  ])("rejects material/transport extensions and invalid paths/URLs when disabled too (%#)", value => {
    expect(() => config([value])).toThrowError(new Error(message));
  });
  it.each([
    '[{"id":"deny","id":"other","phase":"preToolUse","kind":"deny-tools","subjects":[{"tenantId":"t","userId":"u"}],"tools":["write"]}]',
    '[{"id":"deny","\\u0069d":"other","phase":"preToolUse","kind":"deny-tools","subjects":[{"tenantId":"t","userId":"u"}],"tools":["write"]}]',
    '[{"id":"deny","phase":"preToolUse","kind":"deny-tools","subjects":[{"tenantId":"t","userId":"u","userId":"other"}],"tools":["write"]}]',
    '[{"id":"deny","phase":"preToolUse","kind":"deny-tools","subjects":[{"tenantId":"t","userId":"u","user\\u0049d":"other"}],"tools":["write"]}]',
    '[{"id":"remote","phase":"preToolUse","kind":"webhook","subjects":[{"tenantId":"t","userId":"u"}],"endpoint":"https://a.invalid/","endpoint":"https://b.invalid/","signingKeyFile":"/private/key"}]',
  ])("rejects duplicate and escaped-duplicate JSON keys at every authority layer (%#)", raw => {
    expect(() => loadToolHooksConfig({ HOOKS_CONFIG_JSON: raw })).toThrowError(new Error(message));
  });
  it.each(["", "null", "{}", "[] trailing", " ".repeat(65_537)])("rejects malformed or oversized JSON (%#)", raw => {
    expect(() => loadToolHooksConfig({ HOOKS_CONFIG_JSON: raw })).toThrowError(new Error(message));
  });
  it.each([
    { HOOKS_ENABLED: "true" }, { HOOKS_ENABLED: "2" }, { HOOKS_ALLOW_LOOPBACK_FOR_TESTS: "true" },
    { HOOKS_TIMEOUT_MS: "99" }, { HOOKS_TIMEOUT_MS: "5001" }, { HOOKS_TIMEOUT_MS: "1.5" }, { HOOKS_TIMEOUT_MS: "0100" },
    { HOOKS_MAX_CONCURRENT_PER_USER: "0" }, { HOOKS_MAX_CONCURRENT_PER_USER: "9" },
    { HOOKS_TIMEOUT_MS: "9007199254740992" }, { HOOKS_SIGNING_KEY: "secret-canary" },
    { HOOKS_BEARER_TOKEN: "secret-canary" }, { HOOKS_UNKNOWN: "secret-canary" },
  ] as NodeJS.ProcessEnv[])("rejects unknown env material, malformed flags and out-of-range budgets (%#)", env => {
    expect(() => loadToolHooksConfig(env)).toThrowError(new Error(message));
  });
  it("admits loopback HTTP only under all three explicit fixture conditions", () => {
    const hooks = [{ ...webhook(), endpoint: "http://127.0.0.1:12345/hook" }];
    const allowed = { NODE_ENV: "test", HOOKS_ALLOW_LOOPBACK_FOR_TESTS: "1", MCP_ALLOW_LOOPBACK_FOR_TESTS: "1" };
    expect(config(hooks, allowed).allowLoopbackForTests).toBe(true);
    expect(config([{ ...webhook(), endpoint: "http://[::1]:12345/hook" }], allowed).allowLoopbackForTests).toBe(true);
    for (const extra of [{}, { ...allowed, NODE_ENV: "production" }, { ...allowed, NODE_ENV: undefined },
      { ...allowed, HOOKS_ALLOW_LOOPBACK_FOR_TESTS: "0" }, { ...allowed, MCP_ALLOW_LOOPBACK_FOR_TESTS: "0" }]) {
      expect(() => config(hooks, extra)).toThrowError(new Error(message));
    }
    expect(() => config([{ ...webhook(), endpoint: "http://public.example.invalid/hook" }], allowed)).toThrowError(new Error(message));
  });
  it("returns only a fixed error rather than config, key material or URL", () => {
    let failure: unknown;
    try { loadToolHooksConfig({ HOOKS_SIGNING_KEY: "secret-canary" }); } catch (error) { failure = error; }
    expect(failure instanceof Error && failure.message === message && failure.cause === undefined).toBe(true);
    expect(String(failure).includes("secret-canary")).toBe(false);
  });
});
