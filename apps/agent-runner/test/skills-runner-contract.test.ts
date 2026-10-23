import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfiguredStaticSkillSource, PiEngine, SessionHost, StaticToolRegistry } from "@agent-service/core";
import { Capabilities } from "@agent-service/protocol";
import { LocalAesGcmCipher, ProviderService } from "@agent-service/providers";
import { MemoryEventBus, MemorySessionStore } from "@agent-service/store";
import { createApp } from "../src/app.js";
import { hashApiKey } from "../src/auth.js";
import { loadConfig } from "../src/config.js";

// Tripwires only: configuration/capabilities must not read an operator's package. These spies do
// not stub authentication, owner authorization, protocol schemas, stores, or ConfiguredSkillSource.
// No file, listener, database, model request, or native child process is created by this suite.
const { fileRead } = vi.hoisted(() => ({ fileRead: vi.fn(() => { throw new Error("unexpected skill configuration filesystem access"); }) }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, access: fileRead, lstat: fileRead, open: fileRead, opendir: fileRead,
    readFile: fileRead, readdir: fileRead, readlink: fileRead, realpath: fileRead, stat: fileRead };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, accessSync: fileRead, lstatSync: fileRead, openSync: fileRead, opendirSync: fileRead,
    readFileSync: fileRead, readdirSync: fileRead, readlinkSync: fileRead, realpathSync: fileRead, statSync: fileRead };
});

const SECRET = "22".repeat(32);
const KEY = "skills-runner-contract-private-tenant-key";
const INTERNAL = "skills-runner-contract-private-internal-token";
const PRIVATE_PATH = "/private/tmp/agent-service-skills-runner-config-must-never-be-read";
const PRIVATE_CONTENT = "private-package-content-marker";
const mount = { id: "Platform_Notes-1", directory: PRIVATE_PATH, subjects: [{ tenantId: "tenant-skills", userId: "owner-skills" }] };
const base: NodeJS.ProcessEnv = { NODE_ENV: "test", SECRETS_MASTER_KEY: SECRET };
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
  fileRead.mockClear();
});

async function appFor(env: NodeJS.ProcessEnv) {
  const cfg = loadConfig(env);
  const store = new MemorySessionStore(), lease = store.sessionAuthority, bus = new MemoryEventBus();
  const cipher = new LocalAesGcmCipher(SECRET);
  const providers = new ProviderService({ store, cipher, platform: [] });
  const tools = new StaticToolRegistry([]);
  const skills = cfg.skills.enabled ? new ConfiguredStaticSkillSource({ skills: cfg.skills.skills }) : undefined;
  const host = new SessionHost({ store, lease, bus, providers, tools, skills, engine: new PiEngine(providers.models),
    config: { runnerId: "skills-contract-runner", runnerAddr: "127.0.0.1:8787", leaseHoldMs: 1 } });
  cleanups.push(async () => { await host.drain(100); await skills?.close(); await bus.close(); await lease.close(); await store.close(); });
  await store.createApiKey("tenant-skills", "skills-contract-key", hashApiKey(KEY), ["runtime", "admin"]);
  const app = createApp({ store, host, providers, tools, skillsEnabled: skills?.enabled === true,
    runnerId: "skills-contract-runner", internalRouterToken: INTERNAL, heartbeatMs: 60000, maxBodyBytes: 1_000_000,
    ready: () => true,
    decryptSecret: secret => cipher.decrypt(secret.ciphertext, secret.keyId),
    encryptSecret: async plain => ({ ciphertext: await cipher.encrypt(plain), keyId: cipher.keyId }),
  });
  return { app, cfg, skills };
}
const auth = { authorization: `Bearer ${KEY}`, "x-user-id": "owner-skills", "content-type": "application/json" };
const agent = { name: "Static skill runner contract", model: { provider: "deepseek", model: "deepseek-chat" }, tools: [] };

describe("runner static skills configuration and public contract", () => {
  it("defaults off with no ambient configuration, filesystem access, database or Redis", () => {
    vi.stubEnv("SKILLS_ENABLED", "1");
    vi.stubEnv("SKILLS_CONFIG_JSON", JSON.stringify([mount]));
    const cfg = loadConfig(base);
    expect(cfg.skills).toEqual({ enabled: false, skills: [] });
    expect(cfg.STORE).toBe("memory");
    expect(cfg.REDIS_URL).toBeUndefined();
    expect(fileRead).not.toHaveBeenCalled();
  });

  it.each(["0", "1"])("parses a closed operator catalog without opening files when enabled=%s", (flag) => {
    const cfg = loadConfig({ ...base, SKILLS_ENABLED: flag, SKILLS_CONFIG_JSON: JSON.stringify([mount]) });
    expect(cfg.skills).toEqual({ enabled: flag === "1", skills: [mount] });
    expect(Object.isFrozen(cfg.skills.skills)).toBe(true);
    expect(Object.isFrozen(cfg.skills.skills[0]?.subjects)).toBe(true);
    expect(fileRead).not.toHaveBeenCalled();
  });

  it.each(["", "true", "false", "2", "01"])("rejects noncanonical activation flag %j without echo", (flag) => {
    expect(() => loadConfig({ ...base, SKILLS_ENABLED: flag, SKILLS_CONFIG_JSON: JSON.stringify([mount]) }))
      .toThrow("Invalid static skills operator configuration");
    expect(fileRead).not.toHaveBeenCalled();
  });

  it.each([undefined, "[]"])("does not enable an absent or empty mount catalog (%s)", (raw) => {
    expect(() => loadConfig({ ...base, SKILLS_ENABLED: "1", SKILLS_CONFIG_JSON: raw }))
      .toThrow("Invalid static skills operator configuration");
    expect(fileRead).not.toHaveBeenCalled();
  });

  it.each([
    { label: "invalid JSON", raw: `{"private":"${PRIVATE_CONTENT}"` },
    { label: "object instead of catalog", raw: JSON.stringify({ directory: PRIVATE_PATH, body: PRIVATE_CONTENT }) },
    { label: "duplicate mounts", raw: JSON.stringify([mount, mount]) },
    { label: "extra package content", raw: JSON.stringify([{ ...mount, body: PRIVATE_CONTENT }]) },
    { label: "relative directory", raw: JSON.stringify([{ ...mount, directory: `relative/${PRIVATE_CONTENT}` }]) },
    { label: "extra subject scope", raw: JSON.stringify([{ ...mount, subjects: [{ ...mount.subjects[0], scope: PRIVATE_CONTENT }] }]) },
    { label: "oversized content", raw: PRIVATE_CONTENT.repeat(5000) },
  ])("validates even disabled config and never echoes private fields: $label", ({ raw }) => {
    let captured: unknown;
    try { loadConfig({ ...base, SKILLS_ENABLED: "0", SKILLS_CONFIG_JSON: raw }); } catch (error) { captured = error; }
    expect(captured).toBeInstanceOf(Error);
    const error = captured as Error;
    expect(error.message).toBe("Invalid static skills operator configuration");
    expect(error.message).not.toContain(PRIVATE_PATH);
    expect(error.message).not.toContain(PRIVATE_CONTENT);
    expect(error.message).not.toContain(raw);
    expect(error).not.toHaveProperty("cause");
    expect(fileRead).not.toHaveBeenCalled();
  });

  it.each([
    { label: "unset", flag: undefined, raw: undefined, enabled: false },
    { label: "preconfigured but off", flag: "0", raw: JSON.stringify([mount]), enabled: false },
    { label: "configured and enabled", flag: "1", raw: JSON.stringify([mount]), enabled: true },
  ])("publishes only the actual source activation, without paths or content: $label", async ({ flag, raw, enabled }) => {
    const { app, cfg, skills } = await appFor({ ...base, SKILLS_ENABLED: flag, SKILLS_CONFIG_JSON: raw });
    expect(cfg.skills.enabled).toBe(enabled);
    expect(skills?.enabled === true).toBe(enabled);
    const response = await app.request("/v1/capabilities");
    expect(response.status).toBe(200);
    const wire = await response.text(), value = Capabilities.parse(JSON.parse(wire));
    expect(value.service).toBe("agent-runner");
    expect(value.features.skills).toBe(enabled);
    expect(wire).not.toContain(PRIVATE_PATH);
    expect(wire).not.toContain(PRIVATE_CONTENT);
    expect(wire).not.toContain(KEY);
    expect(wire).not.toContain(INTERNAL);
    expect(fileRead).not.toHaveBeenCalled();
  });

  it("keeps nonempty mounts unavailable on both agent POST and PUT while disabled", async () => {
    const { app } = await appFor({ ...base, SKILLS_ENABLED: "0", SKILLS_CONFIG_JSON: JSON.stringify([mount]) });
    const forbidden = await app.request("/v1/agents", { method: "POST", headers: auth, body: JSON.stringify({ ...agent, skills: [mount.id] }) });
    expect(forbidden.status).toBe(400);
    expect(await forbidden.json()).toMatchObject({ error: { code: "invalid_request", message: "Skills are not configured" } });
    const created = await app.request("/v1/agents", { method: "POST", headers: auth, body: JSON.stringify(agent) });
    expect(created.status).toBe(201);
    const value = await created.json() as { id: string; skills: string[] };
    expect(value.skills).toEqual([]);
    const updated = await app.request(`/v1/agents/${value.id}`, { method: "PUT", headers: auth, body: JSON.stringify({ ...agent, skills: [mount.id] }) });
    expect(updated.status).toBe(400);
    expect(await updated.json()).toMatchObject({ error: { code: "invalid_request", message: "Skills are not configured" } });
    expect(fileRead).not.toHaveBeenCalled();
  });
});
