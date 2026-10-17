import { z } from "zod";

/** Managed registrations are a separate namespace from the existing operator mcpServers ids. */
export const McpRegistrationScope = z.enum(["platform", "tenant", "user"]);
export type McpRegistrationScope = z.infer<typeof McpRegistrationScope>;
export const McpRegistrationManagementScope = z.enum(["tenant", "user"]);
export type McpRegistrationManagementScope = z.infer<typeof McpRegistrationManagementScope>;
export const McpRegistrationName = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64);
export type McpRegistrationName = z.infer<typeof McpRegistrationName>;
export const McpRegistrationRef = z.object({
  scope: McpRegistrationScope,
  name: McpRegistrationName,
}).strict();
export type McpRegistrationRef = z.infer<typeof McpRegistrationRef>;
export const McpRegistrationRefs = z.array(McpRegistrationRef).max(8)
  .refine(values => new Set(values.map(value => JSON.stringify([value.scope, value.name]))).size === values.length,
    "MCP registration references must be distinct");
export type McpRegistrationRefs = z.infer<typeof McpRegistrationRefs>;

export const McpRegistryHeaders = z.object({
  "idempotency-key": z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/)
    .refine(value => new TextEncoder().encode(value).byteLength <= 128, "Idempotency key exceeds the UTF-8 byte limit"),
}).strict();
export const McpRegistrationNameParams = z.object({ name: McpRegistrationName }).strict();
export const McpRegistrationScopeQuery = z.object({ scope: McpRegistrationManagementScope }).strict();

const counter = z.number().int().safe().nonnegative();
const timestamp = z.number().int().safe().nonnegative();
const boundedText = (max: number) => z.string().min(1).max(max)
  .refine(value => new TextEncoder().encode(value).byteLength <= max && !/[\u0000-\u001f\u007f]/.test(value), "Invalid MCP text");
/** Network admission, DNS/socket pinning and issuer discovery are enforced by the service. */
export const McpRegistryUrl = z.string().url().max(2048).refine(value => {
  try { const url = new URL(value); return (url.protocol === "https:" || url.protocol === "http:") &&
    !url.username && !url.password && !url.search && !url.hash && url.href === value; } catch { return false; }
}, "Invalid MCP URL");
/** OAuth issuer identity is compared byte-for-byte with metadata and callback iss. A canonical
 * origin without its root slash is valid and must never be silently rewritten into another issuer. */
export const McpOAuthIssuerUrl = z.string().url().max(2048).refine(value => {
  try { const url = new URL(value); return (url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)) &&
    !url.username && !url.password && !value.includes("?") && !value.includes("#") && !/[\u0000-\u0020\u007f]/.test(value)
    && (url.href === value || url.pathname === "/" && url.origin === value); } catch { return false; }
}, "Invalid OAuth issuer URL");
export const McpProtocolVersion = z.enum(["2026-07-28", "2025-11-25"]);
export const McpOAuthScope = z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/);
export const McpOAuthScopes = z.array(McpOAuthScope).max(32)
  .refine(values => new Set(values).size === values.length, "OAuth scopes must be distinct");
const oauthPublicFields = {
  kind: z.literal("oauth"), issuer: McpOAuthIssuerUrl, clientId: boundedText(512),
  clientAuthentication: z.enum(["none", "client_secret_basic"]), scopes: McpOAuthScopes.default([]),
};
export const McpRegistrationAuthenticationRequest = z.union([
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ ...oauthPublicFields, clientSecret: boundedText(8192).describe("Write-only OAuth client secret; never returned by any endpoint.").optional() }).strict()
    .refine(value => value.clientAuthentication === "client_secret_basic" || value.clientSecret === undefined,
      "Public clients cannot supply a secret"),
]);
export const McpRegistrationAuthenticationResponse = z.union([
  z.object({ kind: z.literal("none") }).strict(), z.object(oauthPublicFields).strict(),
]);
export const McpRegistrationConfigRequest = z.object({
  endpoint: McpRegistryUrl, description: boundedText(2048), protocolVersion: McpProtocolVersion,
  authentication: McpRegistrationAuthenticationRequest,
}).strict();
export const McpRegistrationConfigResponse = McpRegistrationConfigRequest.omit({ authentication: true })
  .extend({ authentication: McpRegistrationAuthenticationResponse }).strict();
export const McpRegistrationUpsertRequest = z.object({
  scope: McpRegistrationManagementScope, name: McpRegistrationName, expectedRevision: counter,
  config: McpRegistrationConfigRequest,
}).strict();
export const PlatformMcpRegistrationUpsertRequest = McpRegistrationUpsertRequest.omit({ scope: true });
export const McpRegistrationStateRequest = z.object({
  scope: McpRegistrationManagementScope, state: z.enum(["enabled", "disabled"]), expectedRevision: counter,
}).strict();
export const PlatformMcpRegistrationStateRequest = McpRegistrationStateRequest.omit({ scope: true });
export const McpRegistrationDeleteRequest = z.object({ scope: McpRegistrationManagementScope, expectedRevision: counter }).strict();
export const PlatformMcpRegistrationDeleteRequest = McpRegistrationDeleteRequest.omit({ scope: true });
export const McpRegistrationListQuery = McpRegistrationScopeQuery.extend({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export const PlatformMcpRegistrationListQuery = McpRegistrationListQuery.omit({ scope: true });
export const McpRegistrationRuntimeQuery = z.object({ scope: McpRegistrationScope }).strict();
export const McpRegistrationRuntimeRequest = McpRegistrationRuntimeQuery;
export const McpAuthorizationDisconnectRequest = McpRegistrationRuntimeRequest.extend({ expectedAuthorizationEpoch: counter }).strict();
export const McpInstalledRegistrationResponse = z.object({
  scope: McpRegistrationScope, name: McpRegistrationName,
  revision: z.number().int().safe().positive(), generation: z.number().int().safe().positive(),
  state: z.enum(["enabled", "disabled", "deleted"]), currentVersionId: z.string().uuid().nullable(),
  createdAtMs: timestamp, updatedAtMs: timestamp,
}).strict();
export const McpRegistrationVersionResponse = z.object({
  configVersionId: z.string().uuid(), revision: z.number().int().safe().positive(), generation: z.number().int().safe().positive(),
  config: McpRegistrationConfigResponse, createdAtMs: timestamp,
}).strict();
export const McpRegistrationResponse = z.object({
  registration: McpInstalledRegistrationResponse, version: McpRegistrationVersionResponse.nullable(),
}).strict();
export const McpRegistrationListResponse = z.object({
  data: z.array(McpInstalledRegistrationResponse).max(100), nextCursor: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict();
export const McpAuthorizationBeginResponse = z.object({
  authorizationId: z.string().uuid(), authorizationUrl: z.string().url().max(8192).refine(value => {
    try { const url = new URL(value); return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && !url.hash; } catch { return false; }
  }, "Invalid authorization URL"), expiresAtMs: timestamp,
}).strict();
export const McpAuthorizationStatusResponse = z.object({
  scope: McpRegistrationScope, name: McpRegistrationName,
  authorization: z.object({
    state: z.enum(["pending", "connected", "disabled", "disconnected", "outcome_unknown"]),
    authorizationEpoch: counter, tokenRevision: counter, updatedAtMs: timestamp,
  }).strict().nullable(),
}).strict();
/** Query-only callback. Owner, redirect and credential material are never caller inputs. */
export const McpOAuthCallbackQuery = z.object({
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code: boundedText(4096).optional(), error: z.string().regex(/^[A-Za-z0-9_]{1,128}$/).optional(),
  error_description: z.string().max(2048).optional(), iss: McpOAuthIssuerUrl.optional(),
}).strict().refine(value => (value.code !== undefined) !== (value.error !== undefined), "Exactly one OAuth outcome is required");

export type McpRegistrationConfigRequest = z.infer<typeof McpRegistrationConfigRequest>;
export type McpRegistrationResponse = z.infer<typeof McpRegistrationResponse>;
export type McpInstalledRegistrationResponse = z.infer<typeof McpInstalledRegistrationResponse>;
export type McpAuthorizationStatusResponse = z.infer<typeof McpAuthorizationStatusResponse>;
