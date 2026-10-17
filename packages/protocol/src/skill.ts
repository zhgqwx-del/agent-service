import { z } from "zod";

export const SkillName = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64);
export type SkillName = z.infer<typeof SkillName>;

/** Legacy operator ids retain their exact meaning; only this explicit prefix selects the registry. */
export const SkillMountSelector = z.union([
  z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  z.string().regex(/^registry:[a-z0-9]+(?:-[a-z0-9]+)*$/).max(73),
]);
export const SkillMountSelectors = z.array(SkillMountSelector).max(8)
  .refine(values => new Set(values).size === values.length, "Skill selectors must be distinct");
export type SkillMountSelectors = z.infer<typeof SkillMountSelectors>;

export const SkillVersionId = z.string().uuid();
export const SkillOverride = z.object({ name: SkillName, versionId: SkillVersionId }).strict();
export const SkillOverrides = z.array(SkillOverride).max(8)
  .refine(values => new Set(values.map(value => value.name)).size === values.length, "Skill override names must be distinct");
export type SkillOverride = z.infer<typeof SkillOverride>;
export type SkillOverrides = z.infer<typeof SkillOverrides>;

export const SkillScope = z.enum(["platform", "tenant", "user"]);
export const SkillManagementScope = z.enum(["tenant", "user"]);
export const SkillRegistryHeaders = z.object({
  "idempotency-key": z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/),
});
export const SkillDocument = z.string().min(1).max(65_536)
  .refine(value => new TextEncoder().encode(value).byteLength <= 65_536, "SKILL.md exceeds the UTF-8 byte limit");
export const SkillInstallRequest = z.object({
  scope: SkillManagementScope,
  document: SkillDocument,
  expectedRevision: z.number().int().safe().nonnegative(),
}).strict();
export const PlatformSkillInstallRequest = SkillInstallRequest.omit({ scope: true });
export const SkillDeleteRequest = z.object({
  scope: SkillManagementScope,
  expectedRevision: z.number().int().safe().nonnegative(),
}).strict();
export const PlatformSkillDeleteRequest = SkillDeleteRequest.omit({ scope: true });
export const SkillNameParams = z.object({ name: SkillName });
export const SkillVersionParams = SkillNameParams.extend({ versionId: SkillVersionId });
export const SkillScopeQuery = z.object({ scope: SkillManagementScope }).strict();
export const SkillListQuery = SkillScopeQuery.extend({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export const PlatformSkillListQuery = SkillListQuery.omit({ scope: true });
export const SkillVersionsQuery = SkillScopeQuery.extend({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: SkillVersionId.optional(),
});
export const PlatformSkillVersionsQuery = SkillVersionsQuery.omit({ scope: true });
export const SkillPackageMetadata = z.object({
  name: SkillName,
  description: z.string().min(1).max(1024),
  whenToUse: z.string().max(1024).nullable(),
  disableModelInvocation: z.boolean(),
  userInvocable: z.boolean(),
  dependencies: z.object({ tools: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)).max(64) }).strict(),
}).strict();
export const SkillVersionResponse = z.object({
  scope: SkillScope,
  name: SkillName,
  versionId: SkillVersionId,
  versionSha256: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().safe().positive(),
  generation: z.number().int().safe().positive(),
  metadata: SkillPackageMetadata,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().positive().max(65_536),
  createdAtMs: z.number().int().safe().nonnegative(),
}).strict();
export const InstalledSkillResponse = z.object({
  scope: SkillScope,
  name: SkillName,
  revision: z.number().int().safe().positive(),
  generation: z.number().int().safe().positive(),
  state: z.enum(["active", "deleted"]),
  currentVersionId: SkillVersionId.nullable(),
  createdAtMs: z.number().int().safe().nonnegative(),
  updatedAtMs: z.number().int().safe().nonnegative(),
}).strict();
export const SkillListResponse = z.object({ data: z.array(InstalledSkillResponse), nextCursor: z.string().nullable() }).strict();
export const SkillVersionsResponse = z.object({ data: z.array(SkillVersionResponse), nextCursor: z.string().nullable() }).strict();
export const SkillDocumentResponse = z.object({ version: SkillVersionResponse, document: SkillDocument }).strict();
export const SkillExportQuery = z.object({
  limit: z.coerce.number().int().min(1).max(25).default(10),
  cursor: SkillVersionId.optional(),
  snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().refine(value => value.cursor === undefined || value.snapshotSha256 !== undefined,
  "A continuation cursor requires the original snapshot digest");
export const SkillExportResponse = z.object({
  schema: z.literal("user-skill-registry-export-v1"), snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
  scope: z.literal("user"), slots: z.array(InstalledSkillResponse),
  versions: z.array(SkillVersionResponse.extend({ document: SkillDocument })),
  nextCursor: SkillVersionId.nullable(), physicalErasureComplete: z.literal(false),
}).strict();
export type SkillInstallRequest = z.infer<typeof SkillInstallRequest>;
export type SkillDeleteRequest = z.infer<typeof SkillDeleteRequest>;
export type SkillVersionResponse = z.infer<typeof SkillVersionResponse>;
export type InstalledSkillResponse = z.infer<typeof InstalledSkillResponse>;
