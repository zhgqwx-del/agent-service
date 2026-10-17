import { createHash } from "node:crypto";
import { ApiError, InstalledSkillResponse, SkillVersionResponse } from "@agent-service/protocol";
import {
  assertSkillRegistryAccess,
  skillOwnerKey,
  skillRegistryDigest,
  skillSlotId,
  type BlobStore,
  type SkillOwner,
  type SkillRegistryAccess,
  type SkillRegistryStore,
  type SkillVersion,
  type UserSkillExportSnapshot,
} from "@agent-service/store";
import { parseSkillDocument } from "./document.js";

/** A separate registry-domain export. It does not reinterpret historical ndjson-v1 artifacts. */
export interface SkillRegistryExportPage {
  schema: "user-skill-registry-export-v1";
  scope: "user";
  snapshotSha256: string;
  slots: InstalledSkillResponse[];
  versions: (SkillVersionResponse & { document: string })[];
  nextCursor: string | null;
  physicalErasureComplete: false;
}
export interface SkillRegistryExportOptions {
  limit: number;
  cursor?: string;
  snapshotSha256?: string;
}
export interface SkillRegistryExportDependencies {
  store: Pick<SkillRegistryStore, "listUserSkillExportSnapshot">;
  blobs: BlobStore;
  owner: SkillOwner;
  access: SkillRegistryAccess;
  /** Actual service namespace, including the explicit single-runner filesystem identity. */
  namespaceSha256: string;
}
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_RETAINED_BYTES = 8 * 1024 * 1024;
function invalid(): never { throw new ApiError("internal_error", "Skill export is unavailable."); }
function changed(): never { throw new ApiError("state_conflict", "Skill export changed. Restart the export."); }
function active(signal: AbortSignal): void {
  if (signal.aborted) throw new ApiError("draining", "Skill export is unavailable.", undefined, true);
}
function same(left: unknown, right: unknown): boolean {
  return skillRegistryDigest("skill-export-comparison-v1", left) === skillRegistryDigest("skill-export-comparison-v1", right);
}
function safeVersion(version: SkillVersion): SkillVersionResponse {
  return SkillVersionResponse.parse({
    scope: version.owner.scope, name: version.name, versionId: version.versionId,
    versionSha256: version.versionSha256, revision: version.revision, generation: version.generation,
    metadata: version.metadata, sha256: version.sha256, sizeBytes: version.sizeBytes,
    createdAtMs: version.createdAtMs,
  });
}
function projection(snapshot: UserSkillExportSnapshot, owner: SkillOwner) {
  if (snapshot.schema !== "user-skill-export-snapshot-v1" || snapshot.physicalErasureComplete !== false
    || skillOwnerKey(snapshot.owner) !== skillOwnerKey(owner) || !Array.isArray(snapshot.slots)
    || !Array.isArray(snapshot.versions) || !Array.isArray(snapshot.packages)
    || snapshot.slots.length > 256 || snapshot.versions.length > 32768
    || snapshot.packages.length !== snapshot.versions.length) invalid();
  const slots = snapshot.slots.map(slot => {
    if (skillOwnerKey(slot.owner) !== skillOwnerKey(owner) || slot.slotId !== skillSlotId(owner, slot.name)) invalid();
    return InstalledSkillResponse.parse({
      scope: "user", name: slot.name, revision: slot.revision, generation: slot.generation,
      state: slot.state, currentVersionId: slot.currentVersionId,
      createdAtMs: slot.createdAtMs, updatedAtMs: slot.updatedAtMs,
    });
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (new Set(slots.map(slot => slot.name)).size !== slots.length) invalid();
  const versions = [...snapshot.versions].sort((a, b) => a.versionId < b.versionId ? -1 : a.versionId > b.versionId ? 1 : 0);
  if (new Set(versions.map(version => version.versionId)).size !== versions.length
    || new Set(snapshot.packages.map(pkg => pkg.installationId)).size !== snapshot.packages.length) invalid();
  const slotsById = new Map(snapshot.slots.map(slot => [slot.slotId, slot]));
  const packagesById = new Map(snapshot.packages.map(pkg => [pkg.installationId, pkg]));
  let bytes = 0;
  const publicVersions = versions.map(version => {
    const slot = slotsById.get(version.slotId);
    const pkg = packagesById.get(version.installationId);
    const { versionSha256, ...core } = version;
    if (skillOwnerKey(version.owner) !== skillOwnerKey(owner) || version.slotId !== skillSlotId(owner, version.name)
      || !slot || slot.name !== version.name || slot.generation < version.generation || slot.revision < version.revision
      || versionSha256 !== skillRegistryDigest("skill-registry-version-v1", core)
      || !pkg || skillOwnerKey(pkg.owner) !== skillOwnerKey(owner) || pkg.state !== "ready"
      || pkg.versionId !== version.versionId || pkg.slotId !== version.slotId || pkg.generation !== version.generation
      || pkg.revision !== version.revision || pkg.name !== version.name || !same(pkg.metadata, version.metadata)
      || pkg.storageKey !== version.storageKey || pkg.backend !== version.backend
      || pkg.storageNamespaceSha256 !== version.storageNamespaceSha256
      || pkg.sha256 !== version.sha256 || pkg.sizeBytes !== version.sizeBytes
      || pkg.contentType !== version.contentType || pkg.parserProfile !== version.parserProfile
      || pkg.guardProfile !== version.guardProfile || pkg.publishedAtMs !== version.createdAtMs
      || version.storageKey !== `skill-packages/${version.slotId}/${version.installationId}/document`
      || version.parserProfile !== "skill-markdown-v1" || version.guardProfile !== "skills-guard-v1"
      || version.contentType !== "text/markdown; charset=utf-8") invalid();
    bytes += version.sizeBytes;
    if (!Number.isSafeInteger(bytes) || bytes > MAX_RETAINED_BYTES) invalid();
    return safeVersion(version);
  });
  const versionsById = new Map(publicVersions.map(version => [version.versionId, version]));
  for (const slot of slots) {
    if (slot.state === "deleted" && slot.currentVersionId !== null) invalid();
    const current = slot.currentVersionId === null ? undefined : versionsById.get(slot.currentVersionId);
    if (slot.currentVersionId !== null && (!current || current.name !== slot.name || current.generation !== slot.generation)) invalid();
  }
  // Include the authenticated owner in the commitment, but never publish it or any object locator.
  const snapshotSha256 = skillRegistryDigest("user-skill-registry-export-v1", { owner, slots, versions: publicVersions });
  return { slots, versions, publicVersions, snapshotSha256 };
}

/** The caller owns operation/coordinator lifetime and must recheck current lifecycle on exit.
 * SQL snapshot/image is atomic; immutable ready bytes are read separately. A changed image rejects
 * the whole page. Pagination is optimistic, not a durable pin or permission to revive a deleted skill.
 * Accepted versions, including logically deleted generations, are exportable; unpublished stages
 * are not committed skill versions and are excluded. Physical cleanup is a separate default-off domain.
 */
export async function exportRegisteredUserSkills(
  deps: SkillRegistryExportDependencies,
  options: SkillRegistryExportOptions,
  signal: AbortSignal,
): Promise<SkillRegistryExportPage> {
  const principal = assertSkillRegistryAccess(deps.access, deps.owner, false);
  if (deps.owner.scope !== "user" || deps.owner.tenantId !== principal.tenantId || deps.owner.userId !== principal.userId) {
    throw new ApiError("forbidden", "Skill export is unavailable.");
  }
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 25
    || options.cursor !== undefined && !UUID.test(options.cursor)
    || options.snapshotSha256 !== undefined && !SHA.test(options.snapshotSha256)
    || options.cursor !== undefined && options.snapshotSha256 === undefined) {
    throw new ApiError("invalid_request", "Invalid skill export page.");
  }
  if (!SHA.test(deps.namespaceSha256)) invalid();
  active(signal);
  const input = { access: deps.access, owner: deps.owner };
  const before = projection(await deps.store.listUserSkillExportSnapshot(input), deps.owner);
  active(signal);
  if (options.snapshotSha256 !== undefined && options.snapshotSha256 !== before.snapshotSha256) changed();
  const cursorIndex = options.cursor === undefined ? -1 : before.versions.findIndex(version => version.versionId === options.cursor);
  if (options.cursor !== undefined && cursorIndex < 0) changed();
  const selected = before.versions.slice(cursorIndex + 1, cursorIndex + 1 + options.limit);
  const versions: SkillRegistryExportPage["versions"] = [];
  for (const version of selected) {
    active(signal);
    if (version.backend !== deps.blobs.backend || version.storageNamespaceSha256 !== deps.namespaceSha256) invalid();
    const object = await deps.blobs.get(version.storageKey, { maxBytes: version.sizeBytes });
    active(signal);
    if (!object || !Buffer.isBuffer(object.data) || object.storageKey !== version.storageKey
      || object.sha256 !== version.sha256 || object.sizeBytes !== version.sizeBytes
      || object.contentType !== version.contentType || object.data.byteLength !== version.sizeBytes
      || createHash("sha256").update(object.data).digest("hex") !== version.sha256) invalid();
    const parsed = parseSkillDocument(object.data);
    if (parsed.contentSha256 !== version.sha256 || parsed.sizeBytes !== version.sizeBytes
      || !same(parsed.metadata, version.metadata)) invalid();
    versions.push({ ...safeVersion(version), document: new TextDecoder("utf-8", { fatal: true }).decode(object.data) });
  }
  // Revalidate the complete owner projection and all current subject gates, not only selected rows.
  const after = projection(await deps.store.listUserSkillExportSnapshot(input), deps.owner);
  active(signal);
  if (after.snapshotSha256 !== before.snapshotSha256) changed();
  return {
    schema: "user-skill-registry-export-v1", scope: "user", snapshotSha256: before.snapshotSha256,
    slots: before.slots, versions,
    nextCursor: cursorIndex + 1 + selected.length < before.versions.length ? selected.at(-1)!.versionId : null,
    physicalErasureComplete: false,
  };
}
