import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfiguredToolHookService } from "@agent-service/core";
import { ApiError } from "@agent-service/protocol";
import { createConfiguredToolHooks } from "../src/hooks-runtime.js";
import { loadToolHooksConfig } from "../src/hooks-config.js";

const owner = { tenantId: "tenant-hook", userId: "user-hook" };
const foreign = { tenantId: "tenant-hook", userId: "other-user" };
const message = "Invalid tool hooks runtime configuration";
const directories: string[] = [];
const services: ConfiguredToolHookService[] = [];
const control = () => new AbortController().signal;
const context = (principal = owner) => ({ owner: principal, sessionId: "session", turnId: "turn", toolCallId: "call",
  tool: { name: "write", kind: "builtin" as const, readOnly: false } });
const remote = (path: string) => ({ id: "remote", phase: "preToolUse", kind: "webhook", subjects: [owner],
  endpoint: "https://hooks.example.invalid/check", signingKeyFile: path });
const cfg = (hooks: unknown, enabled = true) => loadToolHooksConfig({ HOOKS_ENABLED: enabled ? "1" : "0", HOOKS_CONFIG_JSON: JSON.stringify(hooks) });
async function scratch() { const directory = await mkdtemp(join(tmpdir(), "agent-service-hooks-runtime-")); directories.push(directory); return directory; }
async function create(config: ReturnType<typeof cfg>) {
  const value = await createConfiguredToolHooks(config, {}); if (value) services.push(value); return value;
}
async function rejectsSafely(path: string) {
  let failure: unknown;
  try { await create(cfg([remote(path)])); } catch (error) { failure = error; }
  expect(failure instanceof Error && failure.message === message && failure.cause === undefined,
    "key loader must return only the fixed runtime configuration error").toBe(true);
  expect(String(failure).includes(path), "keyfile paths must not escape errors").toBe(false);
}
afterEach(async () => {
  for (const value of services.splice(0)) await value.close();
  // These are exactly this test's mkdtemp roots, never configured operator paths.
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("tool hooks protected-key runtime consumer", () => {
  it("does not open a pre-staged keyfile while disabled", async () => {
    const directory = await scratch(), missing = join(directory, "never-created.key");
    expect(await create(cfg([remote(missing)], false))).toBeUndefined();
  });
  it("constructs enabled builtin policies without any keyfile and retains exact owner scope", async () => {
    const value = await create(cfg([
      { id: "deny", phase: "preToolUse", kind: "deny-tools", subjects: [owner], tools: ["write"] },
      { id: "observe", phase: "postToolUse", kind: "observe-tool-result", subjects: [owner] },
    ]));
    expect(value?.version(owner)).toMatch(/^[a-f0-9]{64}$/); expect(value?.version(foreign)).toBeUndefined();
    expect(await value?.preToolUse(context(), control())).toMatchObject({ allow: false, reports: [{ outcome: "denied" }] });
    expect(await value?.postToolUse({ ...context(), isError: false }, control())).toMatchObject([{ outcome: "tool_success" }]);
    await value?.close(); expect(await value?.preToolUse(context(), control())).toMatchObject({ allow: false, reports: [{ outcome: "failed" }] });
  });
  it("treats a literal tenant identity as exact data, not an ACL wildcard", async () => {
    const value = await create(cfg([{ id: "deny", phase: "preToolUse", kind: "deny-tools",
      subjects: [{ tenantId: "*", userId: owner.userId }], tools: ["write"] }]));
    expect(value?.version(owner)).toBeUndefined();
    expect(await value?.preToolUse(context(), control())).toEqual({ allow: true, reports: [] });
  });
  it.each([false, true])("preserves protocol-valid long Unicode tenant identities (matched=%s)", async matched => {
    // externalId permits up to 128 UTF-16 characters. This valid 100-character
    // identity is 300 UTF-8 bytes and must not break unrelated no-hooks owners.
    const unicodeOwner = { tenantId: "中".repeat(100), userId: owner.userId };
    const value = await create(cfg([{ id: "deny", phase: "preToolUse", kind: "deny-tools",
      subjects: [matched ? unicodeOwner : owner], tools: ["write"] }]));
    expect(() => value?.version(unicodeOwner)).not.toThrow();
    if (matched) {
      expect(value?.version(unicodeOwner)).toMatch(/^[a-f0-9]{64}$/);
      expect(await value?.preToolUse(context(unicodeOwner), control())).toMatchObject({ allow: false, reports: [{ outcome: "denied" }] });
    } else {
      expect(value?.version(unicodeOwner)).toBeUndefined();
      expect(await value?.preToolUse(context(unicodeOwner), control())).toEqual({ allow: true, reports: [] });
    }
  });
  it.each([
    { label: "tenant beyond 128 characters", subject: { tenantId: "t".repeat(129), userId: owner.userId } },
    { label: "invalid user grammar", subject: { tenantId: owner.tenantId, userId: "*" } },
  ])("rejects $label at the core entrance without relying on config parsing", ({ subject }) => {
    expect(() => new ConfiguredToolHookService({ enabled: true, hooks: [{ id: "deny", kind: "deny-tools", phase: "preToolUse",
      subjects: [subject], tools: ["write"] }] }))
      .toThrowError(new ApiError("invalid_request", "Tool hook configuration is invalid."));
  });
  it.each([0o400, 0o600])("loads an owned regular 32-byte raw file with mode %s without doing HTTP", async mode => {
    const directory = await scratch(), path = join(directory, "independent-hook.key"), bytes = Buffer.alloc(32, 83);
    await writeFile(path, bytes, { mode: 0o600, flag: "wx" }); await chmod(path, mode);
    const value = await create(cfg([remote(path)]));
    // Compare only digest/booleans: never put key/cipher bytes in failure diffs. This
    // composes the actual reader with the actual service; it is not a network proof.
    const expected = new ConfiguredToolHookService({ enabled: true, hooks: [{ id: "remote", kind: "webhook", phase: "preToolUse",
      subjects: [owner], endpoint: remote(path).endpoint, signingKey: bytes }] }); services.push(expected);
    expect(typeof value?.version(owner) === "string").toBe(true);
    expect(value?.version(owner) === expected.version(owner), "loader must use the exact protected raw bytes").toBe(true);
    expect(value?.version(foreign)).toBeUndefined(); bytes.fill(0);
  });
  it.each([31, 33])("rejects a %s-byte key without exposing native diagnostics", async size => {
    const directory = await scratch(), path = join(directory, "invalid-size.key");
    await writeFile(path, Buffer.alloc(size, 84), { mode: 0o600, flag: "wx" }); await rejectsSafely(path);
  });
  it("rejects a group-readable key even if all other material is valid", async () => {
    const directory = await scratch(), path = join(directory, "unsafe-mode.key");
    await writeFile(path, Buffer.alloc(32, 85), { mode: 0o600, flag: "wx" }); await chmod(path, 0o640); await rejectsSafely(path);
  });
  it("rejects a symlink rather than following a configured alias", async () => {
    const directory = await scratch(), path = join(directory, "actual.key"), alias = join(directory, "alias.key");
    await writeFile(path, Buffer.alloc(32, 86), { mode: 0o600, flag: "wx" }); await symlink(path, alias); await rejectsSafely(alias);
  });
  it("rejects a hard-linked key rather than claiming single-owner file provenance", async () => {
    const directory = await scratch(), path = join(directory, "actual.key"), alias = join(directory, "hardlink.key");
    await writeFile(path, Buffer.alloc(32, 87), { mode: 0o600, flag: "wx" }); await link(path, alias); await rejectsSafely(path);
  });
  it("rejects a directory and a missing file with the same fixed error", async () => {
    const directory = await scratch(), path = join(directory, "not-a-file");
    await mkdir(path, { mode: 0o700 }); await rejectsSafely(path); await rejectsSafely(join(directory, "missing.key"));
  });
  it("does not return a partial service if a later protected key fails", async () => {
    const directory = await scratch(), path = join(directory, "valid.key"), missing = join(directory, "missing.key");
    await writeFile(path, Buffer.alloc(32, 88), { mode: 0o600, flag: "wx" });
    let failure: unknown, value: ConfiguredToolHookService | undefined;
    try { value = await create(cfg([remote(path), { ...remote(missing), id: "second" }])); } catch (error) { failure = error; }
    expect(value === undefined && failure instanceof Error && failure.message === message).toBe(true);
    expect(String(failure).includes(directory)).toBe(false);
  });
});
