import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Principal } from "@agent-service/protocol";
import type { BlobDescriptor } from "./types.js";

/** Registry packages are independent objects, never session BlobManifest rows. */
export interface SkillOwner {
  readonly scope: "platform" | "tenant" | "user";
  readonly tenantId: string | null;
  readonly userId: string | null;
}
export interface SkillRegistryPrincipal { readonly tenantId: string; readonly userId: string }
/** In-process server authority. Neither literals nor serialized/cloned tokens are accepted. */
export interface SkillRegistryAccess { readonly kind: "skill-registry-access-v1" }
export interface SkillPackageMetadata {
  readonly name: string;
  readonly description: string;
  readonly whenToUse: string | null;
  readonly disableModelInvocation: boolean;
  readonly userInvocable: boolean;
  readonly dependencies: { readonly tools: readonly string[] };
}
/** Issued only after the trusted service has parsed and scanned the exact uploaded bytes. */
export interface SkillPackageAdmission { readonly kind: "skill-package-admission-v1" }
export interface SkillPackageAdmissionInput {
  readonly owner: SkillOwner;
  readonly metadata: SkillPackageMetadata;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly parserProfile: "skill-markdown-v1";
  readonly guardProfile: "skills-guard-v1";
}
export interface SkillSlot {
  readonly slotId: string;
  readonly owner: SkillOwner;
  readonly name: string;
  readonly revision: number;
  readonly generation: number;
  readonly state: "active" | "deleted";
  readonly currentVersionId: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}
export interface SkillInstallation {
  readonly installationId: string;
  readonly slotId: string;
  readonly owner: SkillOwner;
  readonly name: string;
  readonly revision: number;
  readonly generation: number;
  readonly idempotencyKeySha256: string;
  readonly requestSha256: string;
  readonly metadata: SkillPackageMetadata;
  readonly parserProfile: "skill-markdown-v1";
  readonly guardProfile: "skills-guard-v1";
  readonly backend: string;
  readonly storageNamespaceSha256: string;
  readonly storageKey: string;
  readonly uploadToken: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly contentType: "text/markdown; charset=utf-8";
  readonly state: "staging" | "ready";
  readonly versionId: string | null;
  readonly createdAtMs: number;
  readonly publishedAtMs: number | null;
}
export interface SkillVersion {
  readonly versionId: string;
  readonly versionSha256: string;
  readonly slotId: string;
  readonly owner: SkillOwner;
  readonly name: string;
  readonly revision: number;
  readonly generation: number;
  readonly metadata: SkillPackageMetadata;
  readonly installationId: string;
  readonly backend: string;
  readonly storageNamespaceSha256: string;
  readonly storageKey: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly contentType: "text/markdown; charset=utf-8";
  readonly parserProfile: "skill-markdown-v1";
  readonly guardProfile: "skills-guard-v1";
  readonly createdAtMs: number;
}
export interface SkillRegistryOwnerInput { readonly access: SkillRegistryAccess; readonly owner: SkillOwner }
export interface PrepareSkillInstallationInput extends SkillRegistryOwnerInput {
  readonly name: string;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly admission: SkillPackageAdmission;
  readonly backend: string;
  readonly storageNamespaceSha256: string;
}
export interface PublishSkillInstallationInput extends SkillRegistryOwnerInput {
  readonly installationId: string;
  readonly uploadToken: string;
  readonly descriptor: BlobDescriptor;
}
export interface ListSkillSlotsInput extends SkillRegistryOwnerInput { readonly limit: number; readonly cursor: string | null }
export interface GetSkillSlotInput extends SkillRegistryOwnerInput { readonly name: string }
export interface GetReadableSkillVersionInput extends GetSkillSlotInput { readonly versionId: string | null }
export interface ListSkillVersionsInput extends GetSkillSlotInput { readonly cursor: string | null; readonly limit: number }
export interface SkillVersionPage { readonly items: readonly SkillVersion[]; readonly nextCursor: string | null }
export interface DeleteSkillSlotInput extends GetSkillSlotInput { readonly expectedRevision: number; readonly idempotencyKey: string }
export interface SkillSlotPage { readonly items: readonly SkillSlot[]; readonly nextCursor: string | null }
export interface UserSkillExportSnapshot {
  readonly schema: "user-skill-export-snapshot-v1";
  readonly owner: SkillOwner;
  readonly slots: readonly SkillSlot[];
  readonly versions: readonly SkillVersion[];
  readonly packages: readonly Omit<SkillInstallation, "uploadToken" | "idempotencyKeySha256" | "requestSha256">[];
  readonly physicalErasureComplete: false;
}
export interface SkillRegistryStore {
  prepareSkillInstallation(input: PrepareSkillInstallationInput): Promise<SkillInstallation>;
  publishSkillInstallation(input: PublishSkillInstallationInput): Promise<SkillVersion>;
  listSkillSlots(input: ListSkillSlotsInput): Promise<SkillSlotPage>;
  getSkillSlot(input: GetSkillSlotInput): Promise<SkillSlot | null>;
  getReadableSkillVersion(input: GetReadableSkillVersionInput): Promise<SkillVersion | null>;
  listSkillVersions(input: ListSkillVersionsInput): Promise<SkillVersionPage>;
  deleteSkillSlot(input: DeleteSkillSlotInput): Promise<SkillSlot>;
  listUserSkillExportSnapshot(input: SkillRegistryOwnerInput): Promise<UserSkillExportSnapshot>;
}
export class SkillRegistryIntegrityError extends Error {
  constructor() { super("skill registry evidence is invalid"); this.name = "SkillRegistryIntegrityError"; }
}
export class SkillRegistryConflictError extends Error {
  constructor() { super("skill registry revision or idempotency conflict"); this.name = "SkillRegistryConflictError"; }
}
export class SkillRegistryLifecycleBlockedError extends Error {
  constructor() { super("skill registry physical lifecycle is not proven"); this.name = "SkillRegistryLifecycleBlockedError"; }
}
function invalid(): never { throw new SkillRegistryIntegrityError(); }
function conflict(): never { throw new SkillRegistryConflictError(); }
function closed(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(k => typeof k !== "string" || !fields.includes(k))) invalid();
  for (const k of keys) { const d = Object.getOwnPropertyDescriptor(value, k); if (!d || !("value" in d) || !d.enumerable) invalid(); }
}
function text(value: unknown, maximum: number): asserts value is string {
  if (typeof value !== "string" || !value.length || Buffer.byteLength(value) > maximum || /[\x00-\x1f\x7f]/.test(value)) invalid();
}
function sha(value: unknown): asserts value is string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) invalid(); }
function natural(value: unknown, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) invalid();
}
function name(value: unknown): asserts value is string { if (typeof value !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) || value.length > 64) invalid(); }
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
}
export function skillRegistryDigest(domain: string, value: unknown): string {
  return createHash("sha256").update(domain).update("\0").update(canonical(value)).digest("hex");
}
export function validateSkillOwner(value: unknown): asserts value is SkillOwner {
  closed(value, ["scope", "tenantId", "userId"]);
  if (value.scope === "platform") { if (value.tenantId !== null || value.userId !== null) invalid(); return; }
  if (value.scope !== "tenant" && value.scope !== "user") invalid();
  // The shared Principal grammar counts characters; the byte bound is only an additional safety cap.
  if (!Principal.safeParse({ tenantId: value.tenantId, userId: value.scope === "user" ? value.userId : "skill-owner" }).success) invalid();
  text(value.tenantId, 512);
  if (value.scope === "tenant") { if (value.userId !== null) invalid(); } else text(value.userId, 128);
}
export function skillOwnerKey(owner: SkillOwner): string { validateSkillOwner(owner); return canonical(owner); }
export function skillSlotId(owner: SkillOwner, skillName: string): string { name(skillName); return skillRegistryDigest("skill-registry-slot-v1", { owner, name: skillName }); }
export function validateSkillPackageMetadata(value: unknown): asserts value is SkillPackageMetadata {
  closed(value, ["name", "description", "whenToUse", "disableModelInvocation", "userInvocable", "dependencies"]);
  name(value.name); text(value.description, 1024);
  if (value.whenToUse !== null) text(value.whenToUse, 1024);
  if (typeof value.disableModelInvocation !== "boolean" || typeof value.userInvocable !== "boolean") invalid();
  closed(value.dependencies, ["tools"]);
  const tools = value.dependencies.tools;
  if (!Array.isArray(tools) || tools.length > 64 || new Set(tools).size !== tools.length) invalid();
  for (const tool of tools) if (typeof tool !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tool)) invalid();
}
const accessRecords = new WeakMap<SkillRegistryAccess, { principal: SkillRegistryPrincipal; owner: SkillOwner; access: "read" | "manage"; authority: "user_self" | "tenant_admin" | "platform_operator" }>();
/** Trusted authentication/operator integration only. Never deserialize this input from a client. */
export function createSkillRegistryAccess(input: {
  principal: SkillRegistryPrincipal; owner: SkillOwner;
  authority: "user_self" | "tenant_admin" | "platform_operator"; access: "read" | "manage";
}): SkillRegistryAccess {
  closed(input, ["principal", "owner", "authority", "access"]);
  closed(input.principal, ["tenantId", "userId"]);
  if (!Principal.safeParse(input.principal).success) invalid();
  validateSkillOwner(input.owner);
  if (input.access !== "read" && input.access !== "manage") invalid();
  if (input.authority === "user_self") {
    if (input.owner.scope === "platform") { if (input.access !== "read") invalid(); }
    else if (input.owner.tenantId !== input.principal.tenantId ||
      (input.owner.scope === "tenant" && input.access !== "read") ||
      (input.owner.scope === "user" && input.owner.userId !== input.principal.userId)) invalid();
  } else if (input.authority === "tenant_admin") {
    if (input.owner.scope === "platform" || input.owner.tenantId !== input.principal.tenantId) invalid();
  } else if (input.authority !== "platform_operator" || input.owner.scope !== "platform") invalid();
  const token = Object.freeze({ kind: "skill-registry-access-v1" as const });
  accessRecords.set(token, { principal: structuredClone(input.principal), owner: structuredClone(input.owner), access: input.access, authority: input.authority });
  return token;
}
export function assertSkillRegistryAccess(token: SkillRegistryAccess, owner: SkillOwner, manage: boolean): Readonly<SkillRegistryPrincipal> {
  validateSkillOwner(owner);
  const record = accessRecords.get(token);
  if (!record || !Object.isFrozen(token) || skillOwnerKey(record.owner) !== skillOwnerKey(owner) || (manage && record.access !== "manage")) invalid();
  return Object.freeze({ ...record.principal });
}
const admissionRecords = new WeakMap<SkillPackageAdmission, SkillPackageAdmissionInput>();
export function createSkillPackageAdmission(input: SkillPackageAdmissionInput): SkillPackageAdmission {
  closed(input, ["owner", "metadata", "sha256", "sizeBytes", "parserProfile", "guardProfile"]);
  validateSkillOwner(input.owner); validateSkillPackageMetadata(input.metadata); sha(input.sha256);
  natural(input.sizeBytes, 65536); if (input.sizeBytes === 0 || input.parserProfile !== "skill-markdown-v1" || input.guardProfile !== "skills-guard-v1") invalid();
  const token = Object.freeze({ kind: "skill-package-admission-v1" as const });
  admissionRecords.set(token, structuredClone(input)); return token;
}
export function assertSkillPackageAdmission(token: SkillPackageAdmission, owner: SkillOwner, skillName: string): SkillPackageAdmissionInput {
  const record = admissionRecords.get(token);
  if (!record || !Object.isFrozen(token) || skillOwnerKey(record.owner) !== skillOwnerKey(owner) || record.metadata.name !== skillName) invalid();
  return structuredClone(record);
}

/** Internal bounded transaction image shared by both real store consumers. Not an authorization API. */
export interface SkillRegistryImage { slots: SkillSlot[]; installations: SkillInstallation[]; versions: SkillVersion[]; deletions: SkillDeletion[] }
export interface SkillDeletion { owner: SkillOwner; name: string; idempotencyKeySha256: string; requestSha256: string; slot: SkillSlot }
export function emptySkillRegistryImage(): SkillRegistryImage { return { slots: [], installations: [], versions: [], deletions: [] }; }
export function skillRegistryInput<T extends SkillRegistryOwnerInput>(input: T, fields: readonly string[], manage: boolean): { input: T; principal: Readonly<SkillRegistryPrincipal>; authority: "user_self" | "tenant_admin" | "platform_operator" } {
  closed(input, fields); const principal = assertSkillRegistryAccess(input.access, input.owner, manage);
  // The original admission must be checked before clone/serialization; tokens themselves stay private.
  const copy = { ...input, owner: structuredClone(input.owner) };
  if ("descriptor" in input) {
    closed(input.descriptor, ["storageKey", "sha256", "sizeBytes", "contentType"]);
    Object.assign(copy, { descriptor: structuredClone(input.descriptor) });
  }
  return { input: copy, principal, authority: accessRecords.get(input.access)!.authority };
}
export function assertSkillExportOwner(input: SkillRegistryOwnerInput): void {
  const checked = skillRegistryInput(input, ["access", "owner"], false);
  if (checked.authority !== "user_self" || input.owner.scope !== "user" ||
    input.owner.tenantId !== checked.principal.tenantId || input.owner.userId !== checked.principal.userId) invalid();
}
export function prepareSkillRegistryImage(image: SkillRegistryImage, input: PrepareSkillInstallationInput, now: number): SkillInstallation {
  natural(now); name(input.name); text(input.idempotencyKey, 128); text(input.backend, 64); sha(input.storageNamespaceSha256);
  if (!/^[A-Za-z0-9_-]+$/.test(input.backend)) invalid();
  natural(input.expectedRevision);
  const admitted = assertSkillPackageAdmission(input.admission, input.owner, input.name);
  if (image.installations.some(row => row.backend !== input.backend || row.storageNamespaceSha256 !== input.storageNamespaceSha256)) conflict();
  const idempotencyKeySha256 = skillRegistryDigest("skill-install-idempotency-v1", input.idempotencyKey);
  const requestSha256 = skillRegistryDigest("skill-install-request-v1", { owner: input.owner, name: input.name,
    expectedRevision: input.expectedRevision, backend: input.backend, storageNamespaceSha256: input.storageNamespaceSha256, admitted });
  const previous = image.installations.find(x => x.idempotencyKeySha256 === idempotencyKeySha256);
  const slotId = skillSlotId(input.owner, input.name), slot = image.slots.find(x => x.slotId === slotId);
  if (previous) {
    if (previous.requestSha256 !== requestSha256 || !slot || slot.state !== "active" || slot.generation !== previous.generation) conflict();
    return previous;
  }
  if ((!slot && input.expectedRevision !== 0) || (slot && slot.revision !== input.expectedRevision)) conflict();
  if (image.slots.length >= 256 && !slot || image.installations.filter(x => x.slotId === slotId).length >= 128 || image.installations.length >= 32768 ||
    image.installations.reduce((sum, row) => sum + row.sizeBytes, 0) + admitted.sizeBytes > 8 * 1024 * 1024) conflict();
  const next: SkillSlot = { slotId, owner: structuredClone(input.owner), name: input.name, revision: (slot?.revision ?? 0) + 1,
    generation: slot ? slot.generation + (slot.state === "deleted" ? 1 : 0) : 1, state: "active",
    currentVersionId: slot?.state === "active" ? slot.currentVersionId : null, createdAtMs: slot?.createdAtMs ?? now, updatedAtMs: now };
  const installationId = randomUUID();
  const installed: SkillInstallation = { installationId, slotId, owner: next.owner, name: input.name,
    revision: next.revision, generation: next.generation, idempotencyKeySha256, requestSha256,
    metadata: admitted.metadata, parserProfile: admitted.parserProfile, guardProfile: admitted.guardProfile,
    backend: input.backend, storageNamespaceSha256: input.storageNamespaceSha256,
    storageKey: `skill-packages/${slotId}/${installationId}/document`, uploadToken: randomBytes(32).toString("hex"),
    sha256: admitted.sha256, sizeBytes: admitted.sizeBytes, contentType: "text/markdown; charset=utf-8", state: "staging", versionId: null,
    createdAtMs: now, publishedAtMs: null };
  image.slots = [...image.slots.filter(x => x.slotId !== slotId), next]; image.installations.push(installed); return installed;
}
export function publishSkillRegistryImage(image: SkillRegistryImage, input: PublishSkillInstallationInput, now: number): SkillVersion {
  natural(now); text(input.installationId, 64); sha(input.uploadToken);
  const d = input.descriptor; closed(d, ["storageKey", "sha256", "sizeBytes", "contentType"]);
  const install = image.installations.find(x => x.installationId === input.installationId);
  const slot = install && image.slots.find(x => x.slotId === install.slotId);
  if (!install || !slot || skillOwnerKey(install.owner) !== skillOwnerKey(input.owner) || slot.state !== "active" ||
    slot.generation !== install.generation || input.uploadToken !== install.uploadToken || d.storageKey !== install.storageKey ||
    d.sha256 !== install.sha256 || d.sizeBytes !== install.sizeBytes || d.contentType !== install.contentType) conflict();
  if (install.state === "ready") {
    const existing = image.versions.find(x => x.versionId === install.versionId); if (!existing) invalid(); return existing;
  }
  if (slot.revision !== install.revision) conflict();
  const core = { versionId: randomUUID(), slotId: install.slotId, owner: install.owner, name: install.name, revision: install.revision,
    generation: install.generation, metadata: install.metadata, installationId: install.installationId, backend: install.backend, storageNamespaceSha256: install.storageNamespaceSha256,
    storageKey: install.storageKey, sha256: install.sha256, sizeBytes: install.sizeBytes, contentType: install.contentType,
    parserProfile: install.parserProfile, guardProfile: install.guardProfile, createdAtMs: now };
  const version: SkillVersion = { ...core, versionSha256: skillRegistryDigest("skill-registry-version-v1", core) };
  image.versions.push(version);
  image.installations = image.installations.map(x => x === install ? { ...install, state: "ready", versionId: version.versionId, publishedAtMs: now } : x);
  image.slots = image.slots.map(x => x === slot ? { ...slot, currentVersionId: version.versionId, updatedAtMs: now } : x);
  return version;
}
export function deleteSkillRegistryImage(image: SkillRegistryImage, input: DeleteSkillSlotInput, now: number): SkillSlot {
  name(input.name); natural(now); natural(input.expectedRevision); text(input.idempotencyKey, 128);
  const idempotencyKeySha256 = skillRegistryDigest("skill-delete-idempotency-v1", input.idempotencyKey);
  const requestSha256 = skillRegistryDigest("skill-delete-request-v1", { owner: input.owner, name: input.name, expectedRevision: input.expectedRevision });
  const previous = image.deletions.find(x => x.idempotencyKeySha256 === idempotencyKeySha256);
  const slot = image.slots.find(x => x.slotId === skillSlotId(input.owner, input.name));
  if (previous) { if (previous.requestSha256 !== requestSha256 || !slot || slot.revision !== previous.slot.revision || slot.state !== "deleted") conflict(); return previous.slot; }
  if (!slot || slot.revision !== input.expectedRevision || slot.state !== "active") conflict();
  const deleted: SkillSlot = { ...slot, state: "deleted", revision: slot.revision + 1, currentVersionId: null, updatedAtMs: now };
  image.slots = image.slots.map(x => x === slot ? deleted : x);
  image.deletions.push({ owner: input.owner, name: input.name, idempotencyKeySha256, requestSha256, slot: deleted }); return deleted;
}
export function readSkillRegistryImage(image: SkillRegistryImage, input: GetReadableSkillVersionInput): SkillVersion | null {
  name(input.name); if (input.versionId !== null) text(input.versionId, 64);
  const slot = image.slots.find(x => x.slotId === skillSlotId(input.owner, input.name));
  if (!slot || slot.state !== "active") return null;
  return image.versions.find(x => x.slotId === slot.slotId && x.generation === slot.generation && x.versionId === (input.versionId ?? slot.currentVersionId)) ?? null;
}
export function listSkillRegistryImage(image: SkillRegistryImage, input: ListSkillSlotsInput): SkillSlotPage {
  natural(input.limit, 100); if (!input.limit || input.cursor !== null && (typeof input.cursor !== "string" || !/^[a-f0-9]{64}$/.test(input.cursor))) invalid();
  const rows = image.slots.filter(x => x.state === "active" && (!input.cursor || x.slotId > input.cursor)).sort((a, b) => a.slotId < b.slotId ? -1 : a.slotId > b.slotId ? 1 : 0);
  const items = rows.slice(0, input.limit); return { items, nextCursor: rows.length > input.limit ? items[items.length - 1]!.slotId : null };
}
export function listSkillRegistryVersions(image: SkillRegistryImage, input: ListSkillVersionsInput): SkillVersionPage {
  name(input.name); natural(input.limit, 100); if (!input.limit) invalid();
  if (input.cursor !== null) text(input.cursor, 64);
  const slot = image.slots.find(x => x.slotId === skillSlotId(input.owner, input.name));
  if (!slot || slot.state !== "active") return { items: [], nextCursor: null };
  const rows = image.versions.filter(x => x.slotId === slot.slotId && x.generation === slot.generation && (!input.cursor || x.versionId > input.cursor))
    .sort((a, b) => a.versionId < b.versionId ? -1 : a.versionId > b.versionId ? 1 : 0);
  const items = rows.slice(0, input.limit); return { items, nextCursor: rows.length > input.limit ? items[items.length - 1]!.versionId : null };
}
export function exportSkillRegistryImage(image: SkillRegistryImage, owner: SkillOwner): UserSkillExportSnapshot {
  if (owner.scope !== "user") invalid();
  const slots = image.slots, versions = image.versions;
  const packageIds = new Set(versions.map(x => x.installationId));
  return { schema: "user-skill-export-snapshot-v1", owner, slots, versions,
    packages: image.installations.filter(x => packageIds.has(x.installationId)).map(({ uploadToken: _token, idempotencyKeySha256: _key, requestSha256: _request, ...rest }) => rest), physicalErasureComplete: false };
}

/** Revalidate the complete owner image, including dormant stages and old generations. */
export function assertSkillRegistryImage(value: unknown, owner: SkillOwner): asserts value is SkillRegistryImage {
  validateSkillOwner(owner); closed(value, ["slots", "installations", "versions", "deletions"]);
  for (const field of ["slots", "installations", "versions", "deletions"]) if (!Array.isArray(value[field])) invalid();
  const image = value as unknown as SkillRegistryImage;
  if (image.slots.length > 256 || image.installations.length > 32768 || image.versions.length > 32768 || image.deletions.length > 32768) invalid();
  if (image.installations.reduce((sum, row) => sum + row.sizeBytes, 0) > 8 * 1024 * 1024) invalid();
  const ownerKey = skillOwnerKey(owner);
  const belongs = (row: { owner: SkillOwner }) => { if (skillOwnerKey(row.owner) !== ownerKey) invalid(); };
  const unique = <T>(rows: readonly T[], key: (row: T) => string) => { if (new Set(rows.map(key)).size !== rows.length) invalid(); };
  const checkSlot = (slot: SkillSlot) => {
    closed(slot, ["slotId", "owner", "name", "revision", "generation", "state", "currentVersionId", "createdAtMs", "updatedAtMs"]);
    belongs(slot); name(slot.name); sha(slot.slotId); natural(slot.revision); natural(slot.generation); natural(slot.createdAtMs); natural(slot.updatedAtMs);
    if (slot.slotId !== skillSlotId(owner, slot.name) || slot.revision < 1 || slot.generation < 1 || slot.updatedAtMs < slot.createdAtMs ||
      (slot.state !== "active" && slot.state !== "deleted") || (slot.state === "deleted" && slot.currentVersionId !== null) ||
      (slot.currentVersionId !== null && typeof slot.currentVersionId !== "string")) invalid();
  };
  for (const slot of image.slots) checkSlot(slot);
  unique(image.slots, x => x.slotId); unique(image.slots, x => x.name);
  for (const row of image.installations) {
    closed(row, ["installationId", "slotId", "owner", "name", "revision", "generation", "idempotencyKeySha256", "requestSha256", "metadata", "parserProfile", "guardProfile", "backend", "storageNamespaceSha256", "storageKey", "uploadToken", "sha256", "sizeBytes", "contentType", "state", "versionId", "createdAtMs", "publishedAtMs"]);
    belongs(row); text(row.installationId, 64); name(row.name); sha(row.idempotencyKeySha256); sha(row.requestSha256); sha(row.uploadToken); sha(row.sha256); sha(row.storageNamespaceSha256);
    validateSkillPackageMetadata(row.metadata); natural(row.revision); natural(row.generation); natural(row.sizeBytes, 65536); natural(row.createdAtMs); text(row.backend, 64);
    const slot = image.slots.find(x => x.slotId === row.slotId);
    if (!slot || slot.name !== row.name || row.metadata.name !== row.name || row.generation < 1 || row.generation > slot.generation || row.revision < 1 || row.revision > slot.revision ||
      row.sizeBytes === 0 || row.storageKey !== `skill-packages/${row.slotId}/${row.installationId}/document` ||
      row.parserProfile !== "skill-markdown-v1" || row.guardProfile !== "skills-guard-v1" || row.contentType !== "text/markdown; charset=utf-8" ||
      !/^[A-Za-z0-9_-]+$/.test(row.backend)) invalid();
    if (row.state === "staging") { if (row.versionId !== null || row.publishedAtMs !== null) invalid(); }
    else if (row.state === "ready") {
      natural(row.publishedAtMs); if (row.publishedAtMs! < row.createdAtMs || typeof row.versionId !== "string") invalid();
    } else invalid();
  }
  unique(image.installations, x => x.installationId); unique(image.installations, x => x.idempotencyKeySha256);
  unique(image.installations, x => `${x.slotId}:${x.revision}`); unique(image.installations, x => x.storageKey);
  for (const version of image.versions) {
    closed(version, ["versionId", "versionSha256", "slotId", "owner", "name", "revision", "generation", "metadata", "installationId", "backend", "storageNamespaceSha256", "storageKey", "sha256", "sizeBytes", "contentType", "parserProfile", "guardProfile", "createdAtMs"]);
    belongs(version); text(version.versionId, 64); sha(version.versionSha256); natural(version.createdAtMs); validateSkillPackageMetadata(version.metadata);
    const { versionSha256, ...core } = version;
    if (versionSha256 !== skillRegistryDigest("skill-registry-version-v1", core)) invalid();
    const install = image.installations.find(x => x.installationId === version.installationId);
    if (!install || install.state !== "ready" || install.versionId !== version.versionId || install.publishedAtMs !== version.createdAtMs ||
      ["slotId", "name", "revision", "generation", "backend", "storageNamespaceSha256", "storageKey", "sha256", "sizeBytes", "contentType", "parserProfile", "guardProfile"].some(k =>
        (install as unknown as Record<string, unknown>)[k] !== (version as unknown as Record<string, unknown>)[k]) || canonical(install.metadata) !== canonical(version.metadata)) invalid();
  }
  unique(image.versions, x => x.versionId); unique(image.versions, x => x.versionSha256); unique(image.versions, x => x.installationId);
  for (const install of image.installations) if (install.state === "ready" && !image.versions.some(x => x.versionId === install.versionId)) invalid();
  for (const slot of image.slots) if (slot.currentVersionId !== null && !image.versions.some(x => x.versionId === slot.currentVersionId && x.slotId === slot.slotId && x.generation === slot.generation)) invalid();
  for (const row of image.deletions) {
    closed(row, ["owner", "name", "idempotencyKeySha256", "requestSha256", "slot"]); belongs(row); name(row.name); sha(row.idempotencyKeySha256); sha(row.requestSha256); checkSlot(row.slot);
    const slot = image.slots.find(x => x.slotId === row.slot.slotId);
    if (!slot || row.name !== row.slot.name || row.slot.state !== "deleted" || row.slot.revision > slot.revision || row.slot.generation > slot.generation) invalid();
  }
  unique(image.deletions, x => x.idempotencyKeySha256);
  for (const slot of image.slots) {
    const history = [
      ...image.installations.filter(x => x.slotId === slot.slotId).map(x => ({ revision: x.revision, generation: x.generation, deleted: false,
        at: x.publishedAtMs ?? x.createdAtMs, created: x.createdAtMs })),
      ...image.deletions.filter(x => x.slot.slotId === slot.slotId).map(x => ({ revision: x.slot.revision, generation: x.slot.generation, deleted: true,
        at: x.slot.updatedAtMs, created: x.slot.createdAtMs })),
    ].sort((a, b) => a.revision - b.revision);
    if (!history.length || history[0]!.revision !== 1 || history[0]!.generation !== 1 || history[0]!.deleted || slot.createdAtMs !== history[0]!.created) invalid();
    for (let i = 1; i < history.length; i++) {
      const previous = history[i - 1]!, row = history[i]!;
      if (row.revision !== previous.revision + 1 || row.at < previous.at ||
        row.generation !== previous.generation + (previous.deleted && !row.deleted ? 1 : 0) || previous.deleted && row.deleted) invalid();
    }
    const last = history.at(-1)!;
    if (last.revision !== slot.revision || last.generation !== slot.generation || last.deleted !== (slot.state === "deleted") || last.at !== slot.updatedAtMs) invalid();
    const newestReady = image.versions.filter(x => x.slotId === slot.slotId && x.generation === slot.generation).sort((a, b) => b.revision - a.revision)[0];
    if (slot.state === "active" && slot.currentVersionId !== (newestReady?.versionId ?? null)) invalid();
  }
}
