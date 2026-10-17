import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemorySessionStore } from "../src/memory.js";
import { newErasureRequestId, userErasureRequestHash } from "../src/subject-lifecycle.js";
import { createSkillPackageAdmission, createSkillRegistryAccess, SkillRegistryConflictError,
  SkillRegistryIntegrityError, type SkillOwner, type SkillInstallation, type PrepareSkillInstallationInput } from "../src/skills.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const owner: SkillOwner = { scope: "user", tenantId: "skill-tenant", userId: "skill-user" };
function fixture(scope: SkillOwner = owner) {
  const store = new MemorySessionStore();
  const access = createSkillRegistryAccess({ principal: { tenantId: "skill-tenant", userId: "skill-user" }, owner: scope,
    authority: scope.scope === "user" ? "user_self" : scope.scope === "tenant" ? "tenant_admin" : "platform_operator", access: "manage" });
  const prepare = (revision = 0, key = "install-first", label = "one", name = "example"): PrepareSkillInstallationInput => ({ access, owner: scope,
    name, expectedRevision: revision, idempotencyKey: key, backend: "memory-skills", storageNamespaceSha256: sha("namespace"),
    admission: createSkillPackageAdmission({ owner: scope, metadata: { name, description: `Example ${label}`, whenToUse: null,
      disableModelInvocation: false, userInvocable: true, dependencies: { tools: ["read"] } },
    sha256: sha(label), sizeBytes: 100, parserProfile: "skill-markdown-v1", guardProfile: "skills-guard-v1" }) });
  const publish = (stage: SkillInstallation) => store.publishSkillInstallation({ access, owner: scope,
    installationId: stage.installationId, uploadToken: stage.uploadToken, descriptor: { storageKey: stage.storageKey,
      sha256: stage.sha256, sizeBytes: stage.sizeBytes, contentType: stage.contentType } });
  return { store, access, owner: scope, prepare, publish };
}
afterEach(() => vi.restoreAllMocks());
describe("skill registry actual MemoryStore consumers", () => {
  it.each(["user", "tenant", "platform"] as const)("stages independently and atomically publishes a ready immutable %s version", async scope => {
    const f = fixture(scope === "user" ? owner : { scope, tenantId: scope === "tenant" ? owner.tenantId : null, userId: null });
    const input = f.prepare(), stage = await f.store.prepareSkillInstallation(input);
    expect(stage.state).toBe("staging"); expect(f.store.blobManifests.size).toBe(0);
    expect(await f.store.getReadableSkillVersion({ access: f.access, owner: f.owner, name: "example", versionId: null })).toBeNull();
    expect(await f.store.prepareSkillInstallation(input)).toEqual(stage);
    const version = await f.publish(stage);
    expect(version.versionSha256).toMatch(/^[a-f0-9]{64}$/); expect(version.storageNamespaceSha256).toBe(sha("namespace"));
    expect(await f.publish(stage)).toEqual(version);
    expect(await f.store.getReadableSkillVersion({ access: f.access, owner: f.owner, name: "example", versionId: version.versionId })).toEqual(version);
    expect((await f.store.listSkillVersions({ access: f.access, owner: f.owner, name: "example", cursor: null, limit: 1 })).items).toEqual([version]);
  });
  it("serializes competing CAS and rejects same-key different-body/namespace without partial publication", async () => {
    const f = fixture(), first = f.prepare();
    const outcomes = await Promise.allSettled([f.store.prepareSkillInstallation(first), f.store.prepareSkillInstallation(f.prepare(0,"competing"))]);
    expect(outcomes.map(x => x.status).sort()).toEqual(["fulfilled", "rejected"]);
    await expect(f.store.prepareSkillInstallation(f.prepare(0,"install-first","different"))).rejects.toThrow(SkillRegistryConflictError);
    await expect(f.store.prepareSkillInstallation({ ...first, storageNamespaceSha256: sha("other") })).rejects.toThrow(SkillRegistryConflictError);
    expect((await f.store.getSkillSlot({ access: f.access, owner, name: "example" }))?.revision).toBe(1);
  });
  it("rejects exact descriptor/token drift and retains the real staged manifest", async () => {
    const f = fixture(), stage = await f.store.prepareSkillInstallation(f.prepare());
    for (const field of ["storageKey", "sha256", "sizeBytes", "contentType"] as const) {
      const descriptor = { storageKey: stage.storageKey, sha256: stage.sha256, sizeBytes: stage.sizeBytes, contentType: stage.contentType };
      Object.assign(descriptor, { [field]: field === "sizeBytes" ? 101 : "wrong" });
      await expect(f.store.publishSkillInstallation({ access: f.access, owner, installationId: stage.installationId, uploadToken: stage.uploadToken, descriptor })).rejects.toThrow(SkillRegistryConflictError);
    }
    expect((await f.publish(stage)).sha256).toBe(stage.sha256);
  });
  it("permanent revision/generation prevents ABA and old stages/versions/replays after deletion", async () => {
    const f = fixture(), input = f.prepare(), stage = await f.store.prepareSkillInstallation(input), v1 = await f.publish(stage);
    const deleted = await f.store.deleteSkillSlot({ access: f.access, owner, name: "example", expectedRevision: 1, idempotencyKey: "delete" });
    expect(deleted.revision).toBe(2); expect((await f.store.getSkillSlot({ access: f.access, owner, name: "example" }))?.state).toBe("deleted");
    expect(await f.store.getReadableSkillVersion({ access: f.access, owner, name: "example", versionId: v1.versionId })).toBeNull();
    await expect(f.publish(stage)).rejects.toThrow(SkillRegistryConflictError);
    await expect(f.store.prepareSkillInstallation(input)).rejects.toThrow(SkillRegistryConflictError);
    await expect(f.store.prepareSkillInstallation(f.prepare(0,"recreate-old"))).rejects.toThrow(SkillRegistryConflictError);
    const next = await f.store.prepareSkillInstallation(f.prepare(2,"recreate"));
    expect(next.generation).toBe(2); expect(next.revision).toBe(3); await f.publish(next);
    expect(await f.store.getReadableSkillVersion({ access: f.access, owner, name: "example", versionId: v1.versionId })).toBeNull();
    const exported = await f.store.listUserSkillExportSnapshot({ access: f.access, owner });
    expect(exported.versions).toHaveLength(2); expect(exported.packages).toHaveLength(2); expect(exported.physicalErasureComplete).toBe(false);
    expect(exported.packages.every(x => !("uploadToken" in x))).toBe(true);
  });
  it("rejects forged/accessor/cross-owner tokens without reading their payload", async () => {
    const f = fixture(), input = f.prepare();
    await expect(f.store.prepareSkillInstallation({ ...input, access: structuredClone(f.access) })).rejects.toThrow(SkillRegistryIntegrityError);
    await expect(f.store.prepareSkillInstallation({ ...input, owner: { ...owner, tenantId: "foreign" } })).rejects.toThrow(SkillRegistryIntegrityError);
    await expect(f.store.prepareSkillInstallation({ ...input, admission: structuredClone(input.admission) })).rejects.toThrow(SkillRegistryIntegrityError);
    expect(await f.store.getSkillSlot({ access: f.access, owner, name: "example" })).toBeNull();
  });
  it("retains all deleted-slot metadata and ready packages, never uncommitted stages, in one export snapshot", async () => {
    const f = fixture(), stage = await f.store.prepareSkillInstallation(f.prepare()); await f.publish(stage);
    await f.store.prepareSkillInstallation(f.prepare(1,"uncommitted","two"));
    await f.store.deleteSkillSlot({ access: f.access, owner, name: "example", expectedRevision: 2, idempotencyKey: "delete" });
    const snapshot = await f.store.listUserSkillExportSnapshot({ access: f.access, owner });
    expect(snapshot.slots[0]?.state).toBe("deleted"); expect(snapshot.versions).toHaveLength(1); expect(snapshot.packages).toHaveLength(1);
  });
  it("does not publish on late outbound serialization failure", async () => {
    const f = fixture(), original = globalThis.structuredClone;
    vi.spyOn(globalThis,"structuredClone").mockImplementation(<T>(value: T, options?: Parameters<typeof structuredClone>[1]): T => {
      if (value && typeof value === "object" && "installationId" in value && "uploadToken" in value) throw new Error("injected serialization failure");
      return original(value, options);
    });
    await expect(f.store.prepareSkillInstallation(f.prepare())).rejects.toThrow("injected serialization failure"); vi.restoreAllMocks();
    expect(await f.store.getSkillSlot({ access: f.access, owner, name: "example" })).toBeNull();
  });
  it("T1/user lifecycle gates hide existing versions and stop publish/export without resurrecting bytes", async () => {
    const f = fixture(), stage = await f.store.prepareSkillInstallation(f.prepare()); await f.publish(stage);
    await f.store.requestUserErasure({ requestId: newErasureRequestId(), tenantId: owner.tenantId!, userId: owner.userId!,
      requestedByKeyId: "skill-test", idempotencyKey: "erase", requestHash: userErasureRequestHash(owner.tenantId!,owner.userId!), atMs: Date.now() });
    await expect(f.store.getReadableSkillVersion({ access: f.access, owner, name: "example", versionId: null })).rejects.toThrow();
    await expect(f.store.listUserSkillExportSnapshot({ access: f.access, owner })).rejects.toThrow();
  });
  it("keeps trusted tenant/platform management distinct from real user-only export", async () => {
    const store = new MemorySessionStore(), tenantOwner: SkillOwner = { scope: "tenant", tenantId: "tenant-admin", userId: null };
    const access = createSkillRegistryAccess({ principal: { tenantId: "tenant-admin", userId: "skill-registry-admin" }, owner: tenantOwner, authority: "tenant_admin", access: "manage" });
    expect(await store.getSkillSlot({ access, owner: tenantOwner, name: "example" })).toBeNull();
    expect(() => createSkillRegistryAccess({ principal: { tenantId: "operator", userId: "operator" }, owner, authority: "platform_operator", access: "manage" })).toThrow(SkillRegistryIntegrityError);
    const admin = createSkillRegistryAccess({ principal: { tenantId: owner.tenantId!, userId: "skill-registry-admin" }, owner, authority: "tenant_admin", access: "read" });
    await expect(store.listUserSkillExportSnapshot({ access: admin, owner })).rejects.toThrow(SkillRegistryIntegrityError);
  });
  it("bounds aggregate admitted bytes including uncommitted and historical stages", async () => {
    const f = fixture();
    for (let i=0;i<128;i++) {
      const input=f.prepare(i,`quota-${i}`);
      const admission=createSkillPackageAdmission({owner,metadata:{name:"example",description:"Quota",whenToUse:null,disableModelInvocation:false,userInvocable:true,dependencies:{tools:[]}},sha256:sha(`quota-${i}`),sizeBytes:65536,parserProfile:"skill-markdown-v1",guardProfile:"skills-guard-v1"});
      await f.store.prepareSkillInstallation({...input,admission});
    }
    await expect(f.store.prepareSkillInstallation(f.prepare(0,"extra","one","another"))).rejects.toThrow(SkillRegistryConflictError);
    expect(await f.store.getSkillSlot({access:f.access,owner,name:"another"})).toBeNull();
  });
  it("rolls back a Map publication that throws after mutation", async () => {
    const f=fixture(), stage=await f.store.prepareSkillInstallation(f.prepare());
    const images=Reflect.get(f.store,"skillRegistryImages") as Map<string,unknown>;
    const set=images.set.bind(images);
    vi.spyOn(images,"set").mockImplementation((key,value)=>{set(key,value);throw new Error("injected late map publication");});
    await expect(f.publish(stage)).rejects.toThrow("injected late map publication");vi.restoreAllMocks();
    expect(await f.store.getReadableSkillVersion({access:f.access,owner,name:"example",versionId:null})).toBeNull();
    expect((await f.publish(stage)).installationId).toBe(stage.installationId);
  });
});
