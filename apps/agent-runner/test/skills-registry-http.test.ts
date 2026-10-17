import { afterEach, describe, expect, it } from "vitest";
import { RegisteredSkillService, SessionHost, StaticToolRegistry } from "@agent-service/core";
import { Capabilities, InstalledSkillResponse, SkillDocumentResponse, SkillExportResponse, SkillVersionResponse,
  INTERNAL_ROUTER_TOKEN_HEADER, INTERNAL_SKILL_REGISTRY_PLATFORM_PREFIX } from "@agent-service/protocol";
import { LocalAesGcmCipher, ProviderService } from "@agent-service/providers";
import { MemoryBlobStore, MemoryEventBus, MemoryLeaseStore, MemorySessionStore } from "@agent-service/store";
import { createApp } from "../src/app.js";
import { hashApiKey } from "../src/auth.js";

// Real Memory metadata, immutable Blob adapter, parser, guard, service, auth and HTTP routes.
// This suite does not substitute for the separately registered real MySQL/HTTP vertical.
const secret = "47".repeat(32), internal = "skill-registry-http-private-router-token";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const document = (body = "Use the release checklist.") => `---\nname: release-guide\ndescription: Safe release checklist\n---\n${body}\n`;
async function fixture(enabled = true) {
  const store = new MemorySessionStore(), blobs = new MemoryBlobStore(), bus = new MemoryEventBus(), lease = new MemoryLeaseStore();
  for (const [tenant, key, scopes] of [["tenant-a", "runtime-a", ["runtime"]], ["tenant-a", "admin-a", ["runtime", "admin"]],
    ["tenant-b", "runtime-b", ["runtime"]]] as const) await store.createApiKey(tenant, key, hashApiKey(key), [...scopes]);
  const registry = new RegisteredSkillService({ store, blobs, namespaceSha256: "7".repeat(64) });
  const tools = new StaticToolRegistry([]), cipher = new LocalAesGcmCipher(secret), providers = new ProviderService({ store, cipher, platform: [] });
  const host = new SessionHost({ store, bus, lease, skills: enabled ? registry : undefined, tools, providers,
    engine: { name: "unused", start: () => ({ steer() {}, interrupt() {}, done: Promise.resolve({ steps: 0, aborted: false }) }) },
    config: { runnerId: "skill-registry-http", runnerAddr: "127.0.0.1:8787", leaseHoldMs: 1 } });
  cleanup.push(async () => { await host.drain(1000); await registry.close(); await bus.close(); await lease.close(); await store.close(); });
  const app = createApp({ store, host, providers, tools, runnerId: "skill-registry-http", internalRouterToken: internal,
    skillRegistryEnabled: enabled, skillRegistry: enabled ? registry : undefined,
    skillRegistryStorage: { backend: blobs.backend, shared: false, namespaceSha256: "7".repeat(64) }, skillsEnabled: false,
    heartbeatMs: 60_000, maxBodyBytes: 400_000, ready: () => true,
    encryptSecret: async value => ({ ciphertext: await cipher.encrypt(value), keyId: cipher.keyId }),
    decryptSecret: value => cipher.decrypt(value.ciphertext, value.keyId) });
  const request = (path: string, method = "GET", body?: unknown, options: { key?: string; user?: string | null; idem?: string } = {}) => app.request(path, {
    method, headers: { authorization: `Bearer ${options.key ?? "runtime-a"}`, ...(options.user === null ? {} : { "x-user-id": options.user ?? "alice" }),
      ...(body === undefined ? {} : { "content-type": "application/json" }), ...(options.idem ? { "idempotency-key": options.idem } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const install = (scope = "user", options: Parameters<typeof request>[3] = {}) => request("/v1/skills", "POST",
    { scope, document: document(), expectedRevision: 0 }, { idem: `install-${scope}`, ...options });
  return { app, registry, request, install };
}
function privateResponse(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}
describe("managed skills authenticated HTTP", () => {
  it("allows an ordinary runtime principal to create/list/read/delete only their own user scope", async () => {
    const f = await fixture();
    const created = await f.install(); expect(created.status).toBe(201); privateResponse(created);
    const version = SkillVersionResponse.parse(await created.json());
    expect(version.scope).toBe("user"); expect(version.revision).toBe(1);
    const list = await f.request("/v1/skills?scope=user"); expect(list.status).toBe(200);
    const listed = await list.json() as { data: unknown[]; nextCursor: string | null };
    expect(listed.data).toHaveLength(1); expect(InstalledSkillResponse.parse(listed.data[0]).currentVersionId).toBe(version.versionId);
    const read = await f.request(`/v1/skills/release-guide/versions/${version.versionId}?scope=user`);
    expect(read.status).toBe(200); expect(SkillDocumentResponse.parse(await read.json()).document).toBe(document());
    for (const identity of [{ user: "bob" }, { key: "runtime-b" }]) {
      expect((await f.request(`/v1/skills/release-guide?scope=user`, "GET", undefined, identity)).status).toBe(404);
      expect((await f.request(`/v1/skills/release-guide/versions/${version.versionId}?scope=user`, "GET", undefined, identity)).status).toBe(404);
    }
    const deleted = await f.request("/v1/skills/release-guide", "DELETE", { scope: "user", expectedRevision: 1 }, { idem: "delete-user" });
    expect(deleted.status).toBe(200); expect(InstalledSkillResponse.parse(await deleted.json())).toMatchObject({ state: "deleted", revision: 2, currentVersionId: null });
    expect((await f.request(`/v1/skills/release-guide/versions/${version.versionId}?scope=user`)).status).toBe(404);
  });
  it("requires exact revisions and mutation idempotency while preserving stable successful replay", async () => {
    const f = await fixture(); const first = await f.install(); const v = await first.json();
    expect(await (await f.install()).json()).toEqual(v);
    expect((await f.request("/v1/skills", "POST", { scope: "user", document: document("Different body."), expectedRevision: 0 }, { idem: "install-user" })).status).toBe(409);
    expect((await f.request("/v1/skills", "POST", { scope: "user", document: document(), expectedRevision: 0 }, { idem: "different-operation" })).status).toBe(409);
    expect((await f.request("/v1/skills/release-guide", "DELETE", { scope: "user", expectedRevision: 1 })).status).toBe(400);
    const versions = await f.request("/v1/skills/release-guide/versions?scope=user"); expect(versions.status).toBe(200);
    expect((await versions.json() as { data: unknown[] }).data).toEqual([v]);
  });
  it("requires actual user identity but not admin for user scope, and admin for tenant scope", async () => {
    const f = await fixture();
    expect((await f.install("user", { user: null })).status).toBe(400);
    expect((await f.install("tenant")).status).toBe(403);
    const tenant = await f.install("tenant", { key: "admin-a", user: null }); expect(tenant.status).toBe(201);
    expect(SkillVersionResponse.parse(await tenant.json()).scope).toBe("tenant");
    expect((await f.request("/v1/skills?scope=tenant")).status).toBe(403);
    expect((await f.request("/v1/skills?scope=tenant", "GET", undefined, { key: "admin-a", user: null })).status).toBe(200);
    expect((await f.install("platform", { key: "admin-a" })).status).toBe(400);
  });
  it("never projects storage authority and refuses caller supplied authority", async () => {
    const f = await fixture();
    const result = await f.install(); const wire = await result.text();
    for (const key of ["storageKey", "storageNamespaceSha256", "installationId", "uploadToken", "backend", "tenantId", "userId"]) expect(wire).not.toContain(`"${key}"`);
    expect((await f.request("/v1/skills", "POST", { scope: "user", document: document(), expectedRevision: 0, access: { authority: "platform_operator" } }, { idem: "authority" })).status).toBe(400);
    expect((await f.request("/v1/skills?scope=user&tenantId=tenant-b")).status).toBe(400);
  });
  it("exports user-owned old/deleted immutable documents on a separate content-bearing profile", async () => {
    const f = await fixture(); const created = SkillVersionResponse.parse(await (await f.install()).json());
    await f.request("/v1/skills/release-guide", "DELETE", { scope: "user", expectedRevision: 1 }, { idem: "delete-export" });
    const exported = await f.request("/v1/skills/export?limit=1"); expect(exported.status).toBe(200); privateResponse(exported);
    const result = SkillExportResponse.parse(await exported.json());
    expect(result.slots).toEqual([expect.objectContaining({ state: "deleted", revision: 2 })]);
    expect(result.versions).toEqual([{ ...created, document: document() }]); expect(result.physicalErasureComplete).toBe(false);
    const other = await f.request("/v1/skills/export", "GET", undefined, { user: "bob" });
    expect(SkillExportResponse.parse(await other.json()).versions).toEqual([]);
    expect((await f.request("/v1/skills/export?scope=tenant", "GET", undefined, { key: "admin-a" })).status).toBe(400);
    expect((await f.request(`/v1/skills/export?cursor=${created.versionId}`)).status).toBe(400);
  });
  it("keeps platform bearer out of the runner and admits only the private versioned router channel", async () => {
    const f = await fixture();
    expect((await f.request("/v1/platform/skills")).status).toBe(404);
    expect((await f.request(INTERNAL_SKILL_REGISTRY_PLATFORM_PREFIX)).status).toBe(404);
    const created = await f.app.request(INTERNAL_SKILL_REGISTRY_PLATFORM_PREFIX, { method: "POST", headers: {
      [INTERNAL_ROUTER_TOKEN_HEADER]: internal, "content-type": "application/json", "idempotency-key": "platform-install" },
      body: JSON.stringify({ document: document(), expectedRevision: 0 }) });
    expect(created.status).toBe(201); privateResponse(created); expect(SkillVersionResponse.parse(await created.json()).scope).toBe("platform");
    expect((await f.request("/v1/skills/release-guide?scope=user")).status).toBe(404);
  });
  it("uses independent registry capability and fails closed with the gate off or service closed", async () => {
    const off = await fixture(false), caps = Capabilities.parse(await (await off.request("/v1/capabilities")).json());
    expect(caps.features.skills).toBe(false); expect(caps.features.skillRegistry).toEqual([]); expect(caps.features.skillRegistryStorage).toBeNull();
    expect((await off.install()).status).toBe(503);
    const active = await fixture(); const activeCaps = Capabilities.parse(await (await active.request("/v1/capabilities")).json());
    expect(activeCaps.features.skills).toBe(false); expect(activeCaps.features.skillRegistry).toEqual(["managed-skill-registry-v1"]);
    await active.registry.close(); expect((await active.install()).status).toBe(503);
  });
});
