import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  MemorySessionStore, createSkillPackageAdmission, createSkillRegistryAccess,
  type BlobDescriptor, type BlobObject, type BlobPutOptions, type BlobStore,
  type SkillOwner, type SkillVersion,
} from "@agent-service/store";
import { parseSkillDocument } from "../src/skills/document.js";
import { exportRegisteredUserSkills } from "../src/skills/export.js";

const owner: SkillOwner = { scope: "user", tenantId: "tenant-export", userId: "alice" };
const principal = { tenantId: "tenant-export", userId: "alice" };
const namespaceSha256 = "a".repeat(64);
const document = (body: string) => `---\nname: review\ndescription: Review the supplied change\n---\n${body}\n`;
const signal = () => new AbortController().signal;
class Bytes implements BlobStore {
  readonly backend = "fixture";
  readonly namespaceSha256 = namespaceSha256;
  readonly objects = new Map<string, BlobObject>();
  beforeGet: (() => Promise<void>) | undefined;
  async putIfAbsent(storageKey: string, data: Buffer | string, options: BlobPutOptions): Promise<BlobDescriptor> {
    const bytes = Buffer.from(data), descriptor = { storageKey, sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), contentType: options.contentType };
    this.objects.set(storageKey, { ...descriptor, data: bytes });
    return descriptor;
  }
  async get(key: string): Promise<BlobObject | null> {
    await this.beforeGet?.();
    const object = this.objects.get(key);
    return object ? { ...object, data: Buffer.from(object.data) } : null;
  }
  async delete(key: string) { this.objects.delete(key); }
}
function fixture() {
  const store = new MemorySessionStore(), blobs = new Bytes();
  const access = createSkillRegistryAccess({ principal, owner, authority: "user_self", access: "manage" });
  const deps = { store, blobs, access, owner, namespaceSha256 };
  let sequence = 0;
  async function install(body: string): Promise<SkillVersion> {
    const bytes = Buffer.from(document(body)), parsed = parseSkillDocument(bytes);
    const slot = await store.getSkillSlot({ access, owner, name: "review" });
    const admission = createSkillPackageAdmission({ owner, metadata: parsed.metadata, sha256: parsed.contentSha256,
      sizeBytes: parsed.sizeBytes, parserProfile: "skill-markdown-v1", guardProfile: "skills-guard-v1" });
    const stage = await store.prepareSkillInstallation({ access, owner, name: "review", expectedRevision: slot?.revision ?? 0,
      idempotencyKey: `install-${++sequence}`, admission, backend: blobs.backend, storageNamespaceSha256: namespaceSha256 });
    const descriptor = await blobs.putIfAbsent(stage.storageKey, bytes, { uploadToken: stage.uploadToken,
      maxBytes: stage.sizeBytes, contentType: stage.contentType });
    return store.publishSkillInstallation({ access, owner, installationId: stage.installationId,
      uploadToken: stage.uploadToken, descriptor });
  }
  return { ...deps, deps, install };
}

describe("versioned user skill registry export (not historical NDJSON)", () => {
  it("exports an explicitly empty user-owned snapshot with stable domain identity", async () => {
    const { deps } = fixture();
    const first = await exportRegisteredUserSkills(deps, { limit: 10 }, signal());
    const second = await exportRegisteredUserSkills(deps, { limit: 10 }, signal());
    expect(first).toEqual(second);
    expect(first).toMatchObject({ schema: "user-skill-registry-export-v1", scope: "user", slots: [], versions: [],
      nextCursor: null, physicalErasureComplete: false });
    expect(first.snapshotSha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("exports exact immutable raw documents with safe DTOs and snapshot-bound pagination", async () => {
    const { deps, install } = fixture();
    const a = await install("First accepted body."), b = await install("Second accepted body.");
    const first = await exportRegisteredUserSkills(deps, { limit: 1 }, signal());
    expect(first.versions).toHaveLength(1); expect(first.nextCursor).toBe(first.versions[0]!.versionId);
    const second = await exportRegisteredUserSkills(deps, { limit: 1, cursor: first.nextCursor!, snapshotSha256: first.snapshotSha256 }, signal());
    expect(second.nextCursor).toBeNull(); expect(second.snapshotSha256).toBe(first.snapshotSha256);
    const rows = [...first.versions, ...second.versions];
    expect(new Set(rows.map(row => row.versionId))).toEqual(new Set([a.versionId, b.versionId]));
    expect(new Set(rows.map(row => row.document))).toEqual(new Set([document("First accepted body."), document("Second accepted body.")]));
    const encoded = JSON.stringify(first);
    for (const forbidden of ["storageKey", "storageNamespace", "uploadToken", "installationId", "tenantId", "userId", "backend", "idempotency"]) {
      expect(encoded).not.toContain(forbidden);
    }
    expect(first.slots[0]).toMatchObject({ state: "active", revision: 2, currentVersionId: b.versionId });
  });
  it("retains export access to accepted deleted generations without restoring runtime visibility", async () => {
    const { deps, install, store, access } = fixture();
    const old = await install("Old accepted private text.");
    await store.deleteSkillSlot({ access, owner, name: "review", expectedRevision: 1, idempotencyKey: "delete-1" });
    expect(await store.getReadableSkillVersion({ access, owner, name: "review", versionId: old.versionId })).toBeNull();
    const deleted = await exportRegisteredUserSkills(deps, { limit: 10 }, signal());
    expect(deleted.slots[0]).toMatchObject({ state: "deleted", currentVersionId: null });
    expect(deleted.versions.map(row => row.versionId)).toEqual([old.versionId]);
    const current = await install("New generation text.");
    const recreated = await exportRegisteredUserSkills(deps, { limit: 10 }, signal());
    expect(new Set(recreated.versions.map(row => row.generation))).toEqual(new Set([1, 2]));
    expect(recreated.slots[0]!.currentVersionId).toBe(current.versionId);
    expect(await store.getReadableSkillVersion({ access, owner, name: "review", versionId: old.versionId })).toBeNull();
  });
  it("excludes unpublished stages rather than claiming they are accepted skill versions", async () => {
    const { deps, store, access } = fixture();
    const parsed = parseSkillDocument(Buffer.from(document("Not published.")));
    const admission = createSkillPackageAdmission({ owner, metadata: parsed.metadata, sha256: parsed.contentSha256,
      sizeBytes: parsed.sizeBytes, parserProfile: "skill-markdown-v1", guardProfile: "skills-guard-v1" });
    await store.prepareSkillInstallation({ access, owner, name: "review", expectedRevision: 0, idempotencyKey: "stage-only",
      admission, backend: deps.blobs.backend, storageNamespaceSha256: namespaceSha256 });
    const result = await exportRegisteredUserSkills(deps, { limit: 10 }, signal());
    expect(result.versions).toEqual([]); expect(result.slots[0]!.currentVersionId).toBeNull();
  });
  it.each([
    { limit: 0 }, { limit: 26 }, { limit: 1.1 }, { limit: 1, cursor: "not-a-uuid" },
    { limit: 1, cursor: "00000000-0000-4000-8000-000000000000" }, { limit: 1, snapshotSha256: "wrong" },
  ])("rejects invalid or unbound page options %#", async options => {
    const { deps } = fixture();
    await expect(exportRegisteredUserSkills(deps, options, signal())).rejects.toMatchObject({ code: "invalid_request" });
  });
  it("rejects a cursor absent from the exact snapshot", async () => {
    const { deps } = fixture();
    const first = await exportRegisteredUserSkills(deps, { limit: 1 }, signal());
    await expect(exportRegisteredUserSkills(deps, { limit: 1, cursor: "00000000-0000-4000-8000-000000000000",
      snapshotSha256: first.snapshotSha256 }, signal())).rejects.toMatchObject({ code: "state_conflict" });
  });
  it("rejects old snapshot pagination after another committed version", async () => {
    const { deps, install } = fixture();
    await install("First version."); await install("Second version.");
    const first = await exportRegisteredUserSkills(deps, { limit: 1 }, signal());
    await install("Concurrent third version.");
    await expect(exportRegisteredUserSkills(deps, { limit: 1, cursor: first.nextCursor!, snapshotSha256: first.snapshotSha256 }, signal()))
      .rejects.toMatchObject({ code: "state_conflict" });
  });
  it("does not return a partial mixed snapshot when deletion commits during object I/O", async () => {
    const { deps, install, blobs, store, access } = fixture();
    await install("Private text.");
    blobs.beforeGet = async () => { blobs.beforeGet = undefined;
      await store.deleteSkillSlot({ access, owner, name: "review", expectedRevision: 1, idempotencyKey: "concurrent-delete" }); };
    await expect(exportRegisteredUserSkills(deps, { limit: 10 }, signal())).rejects.toMatchObject({ code: "state_conflict" });
  });
  it.each(["missing", "bytes", "descriptor", "namespace"] as const)("fails closed on %s object identity", async fault => {
    const { deps, install, blobs } = fixture();
    const version = await install("Only exact bytes may be exported.");
    const original = blobs.objects.get(version.storageKey)!;
    if (fault === "missing") blobs.objects.delete(version.storageKey);
    if (fault === "bytes") blobs.objects.set(version.storageKey, { ...original, data: Buffer.alloc(original.data.length, 65) });
    if (fault === "descriptor") blobs.objects.set(version.storageKey, { ...original, sha256: "f".repeat(64) });
    await expect(exportRegisteredUserSkills({ ...deps, namespaceSha256: fault === "namespace" ? "b".repeat(64) : namespaceSha256 },
      { limit: 10 }, signal())).rejects.toMatchObject({ code: "internal_error" });
  });
  it("rejects a foreign owner even when an administrator has a valid store read capability", async () => {
    const { deps } = fixture();
    const foreign: SkillOwner = { ...owner, userId: "bob" };
    const access = createSkillRegistryAccess({ principal, owner: foreign, authority: "tenant_admin", access: "read" });
    await expect(exportRegisteredUserSkills({ ...deps, owner: foreign, access }, { limit: 10 }, signal()))
      .rejects.toMatchObject({ code: "forbidden" });
  });
  it("does not accept serialized access tokens", async () => {
    const { deps } = fixture();
    await expect(exportRegisteredUserSkills({ ...deps, access: structuredClone(deps.access) }, { limit: 10 }, signal())).rejects.toThrow();
  });
  it("rechecks subject authorization at the final snapshot read", async () => {
    const { deps, install, store } = fixture();
    await install("Private text.");
    const read = store.listUserSkillExportSnapshot.bind(store);
    let reads = 0;
    vi.spyOn(store, "listUserSkillExportSnapshot").mockImplementation(async input => {
      if (++reads === 2) throw new Error("subject gate closed");
      return read(input);
    });
    await expect(exportRegisteredUserSkills(deps, { limit: 10 }, signal())).rejects.toThrow("subject gate closed");
    expect(reads).toBe(2);
  });
  it("observes cancellation before I/O and while an actual read settles", async () => {
    const { deps, install, blobs } = fixture();
    await install("Private text.");
    const early = new AbortController(); early.abort();
    const get = vi.spyOn(blobs, "get");
    await expect(exportRegisteredUserSkills(deps, { limit: 10 }, early.signal)).rejects.toMatchObject({ code: "draining" });
    expect(get).not.toHaveBeenCalled();
    const during = new AbortController(); blobs.beforeGet = async () => { during.abort(); };
    await expect(exportRegisteredUserSkills(deps, { limit: 10 }, during.signal)).rejects.toMatchObject({ code: "draining" });
    expect(get).toHaveBeenCalledTimes(1);
  });
});
