import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Principal } from "@agent-service/protocol";

/** Configuration ownership never conveys another user's OAuth authorization. */
export interface McpRegistrationOwner { readonly scope: "platform" | "tenant" | "user"; readonly tenantId: string | null; readonly userId: string | null }
export interface McpCredentialSubject { readonly tenantId: string; readonly userId: string }
export interface McpRegistryAccess { readonly kind: "mcp-registry-access-v1" }
export interface McpRegistrationAdmission { readonly kind: "mcp-registration-admission-v1" }
export type McpSecretPurpose = "oauth_state" | "oauth_tokens" | "as_client" | "as_dynamic_client";
export interface McpSecretEnvelope {
  readonly profile: "mcp-aes-256-gcm-v1"; readonly keyId: string;
  readonly iv: string; readonly ciphertext: string; readonly tag: string;
}
export interface McpSecretAad {
  readonly profile: "mcp-secret-aad-v1"; readonly purpose: McpSecretPurpose;
  readonly registrationId: string; readonly configVersionId: string; readonly registrationGeneration: number;
  readonly registrationRevision: number;
  readonly authorizationEpoch: number; readonly subject: McpCredentialSubject | null;
  readonly owner: McpRegistrationOwner; readonly materialId: string;
  readonly issuer: string; readonly resource: string; readonly clientId: string;
}
export interface McpEncryptedMaterialAdmission { readonly kind: "mcp-encrypted-material-admission-v1" }
export type McpRegistrationAuthentication = { readonly kind: "none" } | McpPreRegisteredAuthentication | McpDynamicAuthentication;
export interface McpPreRegisteredAuthentication {
  readonly kind: "oauth"; readonly issuer: string; readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string; readonly resource: string; readonly clientId: string; readonly redirectUri: string;
  readonly scopes: readonly string[]; readonly clientAuthentication: "none" | "client_secret_basic";
  readonly metadataSha256: string;
  readonly authorizationResponseIssParameterSupported: boolean;
}
export interface McpDynamicAuthentication extends Omit<McpPreRegisteredAuthentication, "kind" | "clientId"> {
  readonly kind: "oauth_dynamic"; readonly registrationEndpoint: string;
}
export interface McpRegistrationConfig {
  readonly endpoint: string; readonly description: string;
  readonly protocolVersion: "2026-07-28" | "2025-11-25"; readonly authentication: McpRegistrationAuthentication;
}
export interface McpRegistrationSlot {
  readonly registrationId: string; readonly owner: McpRegistrationOwner; readonly name: string;
  readonly revision: number; readonly generation: number; readonly state: "enabled" | "disabled" | "deleted";
  readonly currentVersionId: string | null; readonly createdAtMs: number; readonly updatedAtMs: number;
}
export interface McpRegistrationVersion {
  /** Ephemeral resolver output only; never stored in an immutable version. */
  readonly dynamicClientOperationId?: string;
  readonly dynamicClientRegistrationRevision?: number;
  readonly dynamicClientSecretExpiresAtMs?: number | null;
  readonly configVersionId: string; readonly configSha256: string; readonly registrationId: string;
  readonly owner: McpRegistrationOwner; readonly name: string; readonly revision: number; readonly generation: number;
  readonly config: McpRegistrationConfig; readonly createdAtMs: number;
  readonly clientSecretCommitmentSha256: string | null;
}
/** One atomic publication result; version is read from the same stored image. */
export interface McpRegistrationResult { readonly slot: McpRegistrationSlot; readonly version: McpRegistrationVersion }
export interface McpUserAuthorization {
  readonly authorizationKey: string; readonly registrationId: string; readonly subject: McpCredentialSubject;
  readonly configVersionId: string; readonly registrationGeneration: number;
  readonly registrationRevision: number;
  readonly authorizationEpoch: number; readonly tokenRevision: number;
  readonly state: "pending" | "connected" | "disabled" | "disconnected" | "outcome_unknown";
  readonly credentialVersionId: string | null; readonly updatedAtMs: number;
}
export interface McpPendingAuthorization {
  readonly authorizationId: string; readonly authorizationKey: string; readonly registrationId: string;
  readonly subject: McpCredentialSubject; readonly configVersionId: string; readonly registrationGeneration: number;
  readonly registrationRevision: number;
  readonly authorizationEpoch: number; readonly stateSha256: string; readonly redirectUri: string;
  readonly state: "pending" | "consumed" | "invalidated"; readonly pkceMaterialId: string;
  readonly createdAtMs: number; readonly expiresAtMs: number; readonly consumedAtMs: number | null;
}
export interface McpCredentialVersion {
  readonly credentialVersionId: string; readonly authorizationKey: string; readonly registrationId: string;
  readonly subject: McpCredentialSubject; readonly configVersionId: string; readonly registrationGeneration: number;
  readonly registrationRevision: number;
  readonly authorizationEpoch: number; readonly tokenRevision: number; readonly operationId: string;
  readonly scopes: readonly string[]; readonly accessTokenExpiresAtMs: number;
  readonly materialId: string; readonly createdAtMs: number;
}
/** No operation is ever reclaimed after dispatch may have happened. */
export interface McpCredentialOperation {
  readonly operationId: string; readonly authorizationKey: string; readonly registrationId: string;
  readonly subject: McpCredentialSubject; readonly configVersionId: string; readonly registrationGeneration: number;
  readonly registrationRevision: number;
  readonly authorizationEpoch: number; readonly predecessorTokenRevision: number; readonly predecessorCredentialVersionId: string | null;
  readonly kind: "exchange" | "refresh"; readonly authorizationId: string | null;
  readonly resultCredentialVersionId: string; readonly claimTokenSha256: string;
  readonly state: "pending" | "succeeded" | "failed_not_dispatched" | "outcome_unknown";
  readonly resultSha256: string | null; readonly createdAtMs: number; readonly deadlineAtMs: number; readonly completedAtMs: number | null;
}
export interface McpStoredMaterial { readonly materialId: string; readonly aad: McpSecretAad; readonly envelope: McpSecretEnvelope | null }
export interface McpOperationClaim {
  readonly operation: McpCredentialOperation; readonly claimToken: string;
  readonly registration: McpRegistrationVersion; readonly sourceMaterial: McpStoredMaterial;
  readonly resultAad: McpSecretAad; readonly clientMaterial: McpStoredMaterial | null;
}
export interface McpRegistryOwnerInput { readonly access: McpRegistryAccess; readonly owner: McpRegistrationOwner }
export interface McpRegistryNameInput extends McpRegistryOwnerInput { readonly name: string }
export interface UpsertMcpRegistrationInput extends McpRegistryNameInput {
  readonly expectedRevision: number; readonly idempotencyKey: string; readonly admission: McpRegistrationAdmission;
  readonly configVersionId: string; readonly clientSecret: McpEncryptedMaterialAdmission | null;
}
export interface SetMcpRegistrationStateInput extends McpRegistryNameInput {
  readonly expectedRevision: number; readonly idempotencyKey: string; readonly state: "enabled" | "disabled" | "deleted";
}
export interface ListMcpRegistrationsInput extends McpRegistryOwnerInput { readonly cursor: string | null; readonly limit: number }
export interface McpRegistrationPage { readonly items: readonly McpRegistrationSlot[]; readonly nextCursor: string | null }
export interface BeginMcpAuthorizationInput extends McpRegistryNameInput {
  readonly idempotencyKey: string;
  readonly configVersionId: string; readonly expectedAuthorizationEpoch: number; readonly authorizationId: string;
  readonly stateSha256: string; readonly expiresInMs: number; readonly pkce: McpEncryptedMaterialAdmission;
}
export interface ConsumeMcpAuthorizationInput extends McpRegistryNameInput {
  readonly authorizationId: string; readonly stateSha256: string; readonly redirectUri: string; readonly operationTimeoutMs: number;
}
export interface BeginMcpRefreshInput extends McpRegistryNameInput {
  readonly expectedAuthorizationEpoch: number; readonly expectedTokenRevision: number;
  readonly expectedCredentialVersionId: string; readonly operationTimeoutMs: number;
}
export interface FinishMcpCredentialOperationInput extends McpRegistryNameInput {
  readonly operationId: string; readonly claimToken: string;
  readonly result: { readonly kind: "success"; readonly material: McpEncryptedMaterialAdmission; readonly scopes: readonly string[]; readonly expiresInMs: number }
    | { readonly kind: "outcome_unknown" | "failed_not_dispatched" };
}
export interface SetMcpUserAuthorizationStateInput extends McpRegistryNameInput {
  readonly expectedAuthorizationEpoch: number; readonly idempotencyKey: string; readonly state: "disabled" | "disconnected";
}
export interface McpRuntimeAuthorization {
  readonly registration: McpRegistrationVersion; readonly slot: McpRegistrationSlot;
  readonly authorization: McpUserAuthorization | null; readonly credential: McpCredentialVersion | null;
  readonly material: McpStoredMaterial | null;
}
/** Internal service surface. Never spread these return values into public HTTP responses. */
export interface McpDynamicClientOperation {
  readonly operationId: string; readonly registrationId: string; readonly configVersionId: string;
  readonly owner: McpRegistrationOwner; readonly registrationGeneration: number; readonly registrationRevision: number;
  readonly requestSha256: string; readonly idempotencyKeySha256: string; readonly claimTokenSha256: string;
  readonly state: "prepared" | "sending" | "succeeded" | "failed_not_dispatched" | "outcome_unknown";
  readonly createdAtMs: number; readonly deadlineAtMs: number; readonly sentAtMs: number | null; readonly completedAtMs: number | null;
  readonly clientId: string | null; readonly responseSha256: string | null; readonly resultSha256: string | null;
  readonly clientSecretCommitmentSha256: string | null; readonly clientSecretExpiresAtMs: number | null; readonly clientMaterial: McpStoredMaterial | null;
}
export interface PrepareMcpDynamicClientInput extends McpRegistryNameInput {
  readonly configVersionId: string; readonly expectedRevision: number; readonly idempotencyKey: string; readonly operationTimeoutMs: number;
}
export interface McpDynamicClientClaim { readonly operation: McpDynamicClientOperation; readonly claimToken: string | null; readonly registration: McpRegistrationVersion }
export interface MarkMcpDynamicClientSendingInput extends McpRegistryNameInput { readonly operationId: string; readonly claimToken: string }
export interface FinishMcpDynamicClientInput extends MarkMcpDynamicClientSendingInput {
  readonly result: { readonly kind: "success"; readonly clientId: string; readonly responseSha256: string;
    readonly clientSecretCommitmentSha256: string | null; readonly clientSecretExpiresAtMs: number | null; readonly clientSecret: McpEncryptedMaterialAdmission | null }
    | { readonly kind: "outcome_unknown" | "failed_not_dispatched" };
}
export interface GetMcpDynamicClientInput extends McpRegistryNameInput { readonly configVersionId: string }
export interface McpRegistryStore {
  prepareMcpDynamicClient(input: PrepareMcpDynamicClientInput): Promise<McpDynamicClientClaim>;
  markMcpDynamicClientSending(input: MarkMcpDynamicClientSendingInput): Promise<McpDynamicClientOperation>;
  finishMcpDynamicClient(input: FinishMcpDynamicClientInput): Promise<McpDynamicClientOperation>;
  getMcpDynamicClient(input: GetMcpDynamicClientInput): Promise<McpDynamicClientOperation | null>;
  upsertMcpRegistration(input: UpsertMcpRegistrationInput): Promise<McpRegistrationResult>;
  setMcpRegistrationState(input: SetMcpRegistrationStateInput): Promise<McpRegistrationSlot>;
  listMcpRegistrations(input: ListMcpRegistrationsInput): Promise<McpRegistrationPage>;
  getMcpRegistration(input: McpRegistryNameInput): Promise<{ slot: McpRegistrationSlot; version: McpRegistrationVersion | null } | null>;
  beginMcpAuthorization(input: BeginMcpAuthorizationInput): Promise<McpPendingAuthorization>;
  getMcpPendingAuthorization(input: McpRegistryNameInput & { readonly idempotencyKey: string }): Promise<{ pending: McpPendingAuthorization; material: McpStoredMaterial } | null>;
  lookupMcpAuthorizationState(stateSha256: string): Promise<{ owner: McpRegistrationOwner; name: string; subject: McpCredentialSubject; authorizationId: string } | null>;
  consumeMcpAuthorization(input: ConsumeMcpAuthorizationInput): Promise<McpOperationClaim>;
  beginMcpRefresh(input: BeginMcpRefreshInput): Promise<McpOperationClaim>;
  finishMcpCredentialOperation(input: FinishMcpCredentialOperationInput): Promise<McpUserAuthorization>;
  getMcpUserAuthorization(input: McpRegistryNameInput): Promise<McpUserAuthorization | null>;
  setMcpUserAuthorizationState(input: SetMcpUserAuthorizationStateInput): Promise<McpUserAuthorization>;
  getMcpRuntimeAuthorization(input: McpRegistryNameInput): Promise<McpRuntimeAuthorization | null>;
  getMcpAuthorizationContext(input: McpRegistryNameInput): Promise<McpRuntimeAuthorization | null>;
}
export class McpRegistryIntegrityError extends Error { constructor() { super("MCP registry evidence is invalid"); this.name = "McpRegistryIntegrityError"; } }
export class McpRegistryConflictError extends Error { constructor() { super("MCP registry revision or operation conflict"); this.name = "McpRegistryConflictError"; } }
export class McpRegistryLifecycleBlockedError extends Error { constructor() { super("MCP registry lifecycle is not proven"); this.name = "McpRegistryLifecycleBlockedError"; } }

function invalid(): never { throw new McpRegistryIntegrityError(); }
function conflict(): never { throw new McpRegistryConflictError(); }
function closed(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(k => typeof k !== "string" || !fields.includes(k))) invalid();
  for (const key of keys) { const d = Object.getOwnPropertyDescriptor(value, key); if (!d || !("value" in d) || !d.enumerable) invalid(); }
}
function text(value: unknown, maximum: number): asserts value is string {
  if (typeof value !== "string" || !value.length || Buffer.byteLength(value) > maximum || /[\x00-\x1f\x7f]/.test(value)) invalid();
}
function natural(value: unknown, maximum = Number.MAX_SAFE_INTEGER): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) invalid(); }
function sha(value: unknown): asserts value is string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) invalid(); }
function id(value: unknown): asserts value is string { if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) invalid(); }
function name(value: unknown): asserts value is string { if (typeof value !== "string" || value.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) invalid(); }
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
export function mcpRegistryDigest(domain: string, value: unknown): string { return createHash("sha256").update(domain).update("\0").update(canonical(value)).digest("hex"); }
export function validateMcpCredentialSubject(value: unknown): asserts value is McpCredentialSubject {
  closed(value, ["tenantId", "userId"]); if (!Principal.safeParse(value).success) invalid(); text(value.tenantId, 512); text(value.userId, 128);
}
export function validateMcpRegistrationOwner(value: unknown): asserts value is McpRegistrationOwner {
  closed(value, ["scope", "tenantId", "userId"]);
  if (value.scope === "platform") { if (value.tenantId !== null || value.userId !== null) invalid(); return; }
  if (value.scope !== "tenant" && value.scope !== "user") invalid();
  validateMcpCredentialSubject({ tenantId: value.tenantId, userId: value.scope === "user" ? value.userId : "mcp-owner" });
  if (value.scope === "tenant" && value.userId !== null) invalid();
}
export function mcpRegistrationId(owner: McpRegistrationOwner, registrationName: string): string {
  validateMcpRegistrationOwner(owner); name(registrationName); return mcpRegistryDigest("mcp-registration-slot-v1", { owner, name: registrationName });
}
/** Stable per exact management attempt, so randomized encryption need not mint a new AAD on retry. */
export function mcpRegistrationVersionId(owner: McpRegistrationOwner, registrationName: string, expectedRevision: number, idempotencyKey: string): string {
  validateMcpRegistrationOwner(owner); name(registrationName); natural(expectedRevision); text(idempotencyKey, 128);
  const h = mcpRegistryDigest("mcp-registration-version-id-v1", { owner, name: registrationName, expectedRevision, idempotencyKey });
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
}
export function mcpAuthorizationKey(registrationId: string, subject: McpCredentialSubject): string {
  sha(registrationId); validateMcpCredentialSubject(subject); return mcpRegistryDigest("mcp-user-authorization-v1", { registrationId, subject });
}
export function validateMcpRegistrationConfig(value: unknown): asserts value is McpRegistrationConfig {
  closed(value, ["endpoint", "description", "protocolVersion", "authentication"]); text(value.description, 2048);
  const https = (v: unknown, issuer = false) => { text(v, 2048); let u: URL; try { u = new URL(v); } catch { return invalid(); }
    const fixture = process.env.NODE_ENV === "test" && process.env.MCP_ALLOW_LOOPBACK_FOR_TESTS === "1" && ["127.0.0.1", "[::1]"].includes(u.hostname);
    if ((u.protocol !== "https:" && !(fixture && u.protocol === "http:")) || u.username || u.password || u.hash || u.search || (u.href !== v && !(issuer && u.pathname === "/" && v === u.origin))) invalid(); };
  https(value.endpoint); if (value.protocolVersion !== "2026-07-28" && value.protocolVersion !== "2025-11-25") invalid();
  if (!value.authentication || typeof value.authentication !== "object") invalid();
  const a = value.authentication as Record<string, unknown>;
  const kindDescriptor = Object.getOwnPropertyDescriptor(a, "kind"); if (!kindDescriptor || !("value" in kindDescriptor)) invalid();
  if (kindDescriptor.value === "none") { closed(a, ["kind"]); return; }
  const dynamic = a.kind === "oauth_dynamic";
  closed(a, ["kind", "issuer", "authorizationEndpoint", "tokenEndpoint", "resource", ...(dynamic ? ["registrationEndpoint"] : ["clientId"]), "redirectUri", "scopes", "clientAuthentication", "metadataSha256", "authorizationResponseIssParameterSupported"]);
  if (typeof a.authorizationResponseIssParameterSupported !== "boolean") invalid();
  if (a.kind !== "oauth" && a.kind !== "oauth_dynamic" || !["none", "client_secret_basic"].includes(String(a.clientAuthentication))) invalid();
  for (const field of ["issuer", "authorizationEndpoint", "tokenEndpoint", "resource", "redirectUri"]) https(a[field], field === "issuer");
  if (dynamic) https(a.registrationEndpoint); else text(a.clientId, 512); sha(a.metadataSha256); validateScopes(a.scopes);
}
function validateScopes(value: unknown): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.length > 32 || new Set(value).size !== value.length) invalid();
  for (const scope of value) { text(scope, 128); if (!/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope)) invalid(); }
}
type Authority = "user_self" | "tenant_admin" | "platform_operator";
const accessRecords = new WeakMap<McpRegistryAccess, { principal: McpCredentialSubject; owner: McpRegistrationOwner; authority: Authority; access: "manage" | "runtime" }>();
/** Trusted auth integration only; callers must never deserialize authority from an HTTP body. */
export function createMcpRegistryAccess(input: { principal: McpCredentialSubject; owner: McpRegistrationOwner; authority: Authority; access: "manage" | "runtime" }): McpRegistryAccess {
  closed(input, ["principal", "owner", "authority", "access"]); validateMcpCredentialSubject(input.principal); validateMcpRegistrationOwner(input.owner);
  if (input.access !== "manage" && input.access !== "runtime") invalid();
  if (input.authority === "platform_operator") { if (input.owner.scope !== "platform" || input.access !== "manage") invalid(); }
  else if (input.authority === "tenant_admin") { if (input.owner.scope === "platform" || input.owner.tenantId !== input.principal.tenantId || input.access !== "manage") invalid(); }
  else if (input.authority === "user_self") {
    if (input.owner.scope !== "platform" && input.owner.tenantId !== input.principal.tenantId || input.owner.scope === "user" && input.owner.userId !== input.principal.userId || input.access === "manage" && input.owner.scope !== "user") invalid();
  } else invalid();
  const token = Object.freeze({ kind: "mcp-registry-access-v1" as const }); accessRecords.set(token, structuredClone(input)); return token;
}
export function assertMcpRegistryAccess(access: McpRegistryAccess, owner: McpRegistrationOwner, mode?: "manage" | "runtime") {
  validateMcpRegistrationOwner(owner); const record = accessRecords.get(access);
  if (!record || !Object.isFrozen(access) || canonical(record.owner) !== canonical(owner) || mode !== undefined && record.access !== mode) invalid();
  return Object.freeze({ principal: Object.freeze({ ...record.principal }), authority: record.authority, mode: record.access });
}
const registrations = new WeakMap<McpRegistrationAdmission, { config: McpRegistrationConfig; commitment: string | null }>();
/** Service issues only after endpoint/discovery validation; syntax is independently checked here. */
export function createMcpRegistrationAdmission(config: McpRegistrationConfig, clientSecretCommitmentSha256: string | null = null): McpRegistrationAdmission {
  validateMcpRegistrationConfig(config);
  if (config.authentication.kind === "oauth" && config.authentication.clientAuthentication === "client_secret_basic") sha(clientSecretCommitmentSha256);
  else if (clientSecretCommitmentSha256 !== null) invalid();
  const admission = Object.freeze({ kind: "mcp-registration-admission-v1" as const }); registrations.set(admission, { config: structuredClone(config), commitment: clientSecretCommitmentSha256 }); return admission;
}
export function assertMcpRegistrationAdmission(admission: McpRegistrationAdmission): McpRegistrationConfig {
  const stored = registrations.get(admission); if (!stored || !Object.isFrozen(admission)) invalid(); return structuredClone(stored.config);
}
const materials = new WeakMap<McpEncryptedMaterialAdmission, { aad: McpSecretAad; envelope: McpSecretEnvelope; envelopeSha256: string }>();
export function validateMcpSecretAad(aad: unknown): asserts aad is McpSecretAad {
  closed(aad, ["profile", "purpose", "registrationId", "configVersionId", "registrationGeneration", "registrationRevision", "authorizationEpoch", "subject", "owner", "materialId", "issuer", "resource", "clientId"]);
  if (aad.profile !== "mcp-secret-aad-v1" || !["oauth_state", "oauth_tokens", "as_client", "as_dynamic_client"].includes(String(aad.purpose))) invalid();
  sha(aad.registrationId); id(aad.configVersionId); id(aad.materialId); natural(aad.registrationGeneration); natural(aad.authorizationEpoch); validateMcpRegistrationOwner(aad.owner);
  natural(aad.registrationRevision); if (!aad.registrationGeneration || !aad.registrationRevision) invalid();
  if (aad.purpose === "as_client" || aad.purpose === "as_dynamic_client") { if (aad.subject !== null || aad.authorizationEpoch !== 0) invalid(); }
  else { validateMcpCredentialSubject(aad.subject); if (!aad.authorizationEpoch) invalid(); }
  text(aad.issuer, 2048); text(aad.resource, 2048); text(aad.clientId, 512);
}
export function createMcpEncryptedMaterialAdmission(input: { aad: McpSecretAad; envelope: McpSecretEnvelope }): McpEncryptedMaterialAdmission {
  closed(input, ["aad", "envelope"]); validateMcpSecretAad(input.aad); validateEnvelope(input.envelope);
  const token = Object.freeze({ kind: "mcp-encrypted-material-admission-v1" as const });
  materials.set(token, { aad: structuredClone(input.aad), envelope: input.envelope, envelopeSha256: mcpRegistryDigest("mcp-envelope-v1", input.envelope) }); return token;
}
function validateEnvelope(e: unknown): asserts e is McpSecretEnvelope {
  closed(e, ["profile", "keyId", "iv", "ciphertext", "tag"]); if (e.profile !== "mcp-aes-256-gcm-v1") invalid(); text(e.keyId, 128);
  for (const [field, bytes] of [["iv", 12], ["tag", 16], ["ciphertext", null]] as const) {
    const value = e[field]; text(value, 131072); const b = Buffer.from(value, "base64");
    if (b.toString("base64") !== value || !b.length || bytes !== null && b.length !== bytes || b.length > 65536) invalid();
  }
}
export function assertMcpEncryptedMaterialAdmission(token: McpEncryptedMaterialAdmission, expected: McpSecretAad): McpStoredMaterial {
  validateMcpSecretAad(expected); const stored = materials.get(token);
  if (!stored || !Object.isFrozen(token) || canonical(stored.aad) !== canonical(expected) || stored.envelopeSha256 !== mcpRegistryDigest("mcp-envelope-v1", stored.envelope)) invalid();
  return { materialId: expected.materialId, aad: structuredClone(expected), envelope: structuredClone(stored.envelope) };
}
export function mcpSecretAad(version: McpRegistrationVersion, purpose: McpSecretPurpose,
  subject: McpCredentialSubject | null, authorizationEpoch: number, materialId: string, registrationRevision = version.revision): McpSecretAad {
  const auth = version.config.authentication; if (auth.kind !== "oauth") invalid();
  const aad: McpSecretAad = { profile: "mcp-secret-aad-v1", purpose, registrationId: version.registrationId,
    configVersionId: version.configVersionId, registrationGeneration: version.generation, registrationRevision, authorizationEpoch,
    subject, owner: version.owner, materialId, issuer: auth.issuer, resource: auth.resource, clientId: auth.clientId };
  if (purpose === "as_client" && registrationRevision !== version.revision) invalid(); validateMcpSecretAad(aad); return aad;
}

/** Resolve a ready client for OAuth without changing the immutable intent or its hash. */
export function resolveMcpDynamicClient(version: McpRegistrationVersion, operation: McpDynamicClientOperation | null): McpRegistrationVersion {
  const a = version.config.authentication;
  if (a.kind !== "oauth_dynamic") return version;
  if (!operation || operation.state !== "succeeded" || !operation.clientId || operation.configVersionId !== version.configVersionId
    || operation.registrationId !== version.registrationId || operation.registrationGeneration !== version.generation
    || operation.registrationRevision < version.revision || canonical(operation.owner) !== canonical(version.owner)
    || a.clientAuthentication === "client_secret_basic" && !operation.clientMaterial) conflict();
  const { registrationEndpoint: _endpoint, kind: _kind, ...rest } = a;
  return { ...version, dynamicClientOperationId: operation.operationId, dynamicClientRegistrationRevision: operation.registrationRevision, dynamicClientSecretExpiresAtMs: operation.clientSecretExpiresAtMs,
    config: { ...version.config, authentication: { ...rest, kind: "oauth", clientId: operation.clientId } } };
}
function effectiveVersion(image: McpRegistryImage, version: McpRegistrationVersion): McpRegistrationVersion {
  return resolveMcpDynamicClient(version, image.dynamicClients.find(o => o.configVersionId === version.configVersionId) ?? null);
}
function currentEffective(image: McpRegistryImage, owner: McpRegistrationOwner, registrationName: string, now: number): McpRegistrationVersion {
  const version = effectiveVersion(image, current(image, owner, registrationName));
  if (version.dynamicClientSecretExpiresAtMs !== undefined && version.dynamicClientSecretExpiresAtMs !== null && version.dynamicClientSecretExpiresAtMs <= now) conflict();
  return version;
}
export function mcpDynamicClientSecretAad(version: McpRegistrationVersion, operation: McpDynamicClientOperation, clientId: string): McpSecretAad {
  const auth = version.config.authentication;
  if (auth.kind !== "oauth_dynamic" || operation.registrationId !== version.registrationId || operation.configVersionId !== version.configVersionId
    || operation.registrationGeneration !== version.generation || operation.registrationRevision < version.revision || canonical(operation.owner) !== canonical(version.owner)) invalid();
  const aad: McpSecretAad = { profile: "mcp-secret-aad-v1", purpose: "as_dynamic_client", registrationId: version.registrationId,
    configVersionId: version.configVersionId, registrationGeneration: version.generation, registrationRevision: operation.registrationRevision,
    authorizationEpoch: 0, subject: null, owner: version.owner, materialId: operation.operationId,
    issuer: auth.issuer, resource: auth.resource, clientId };
  validateMcpSecretAad(aad); return aad;
}
function dynamicOperation(image: McpRegistryImage, input: MarkMcpDynamicClientSendingInput): McpDynamicClientOperation {
  id(input.operationId); sha(input.claimToken);
  const op = image.dynamicClients.find(o => o.operationId === input.operationId);
  if (!op || op.claimTokenSha256 !== mcpRegistryDigest("mcp-dcr-claim-v1", input.claimToken)) conflict(); return op;
}
function replaceDynamic(image: McpRegistryImage, operation: McpDynamicClientOperation): McpDynamicClientOperation {
  image.dynamicClients = image.dynamicClients.map(o => o.operationId === operation.operationId ? operation : o); return operation;
}
function expireDynamic(operation: McpDynamicClientOperation, now: number): McpDynamicClientOperation {
  if (now < operation.deadlineAtMs || operation.state !== "prepared" && operation.state !== "sending") return operation;
  return { ...operation, state: operation.state === "prepared" ? "failed_not_dispatched" : "outcome_unknown", completedAtMs: now };
}
/** A config may create at most one AS client. Losing the one claim never authorizes a second send. */
export function prepareMcpDynamicClientImage(image: McpRegistryImage, input: PrepareMcpDynamicClientInput, now: number): McpDynamicClientClaim {
  id(input.configVersionId); natural(input.expectedRevision); natural(input.operationTimeoutMs, 120000); natural(now);
  if (input.operationTimeoutMs < 100) invalid(); text(input.idempotencyKey, 128);
  const version = current(image, input.owner, input.name);
  if (version.config.authentication.kind !== "oauth_dynamic" || version.configVersionId !== input.configVersionId || image.slot!.revision !== input.expectedRevision
    ) conflict();
  const requestSha256 = mcpRegistryDigest("mcp-dcr-request-v1", { registrationId: version.registrationId, configVersionId: version.configVersionId,
    owner: version.owner, generation: version.generation, revision: input.expectedRevision, config: version.config });
  const idempotencyKeySha256 = mcpRegistryDigest("mcp-dcr-idempotency-v1", { registrationId: version.registrationId, idempotencyKey: input.idempotencyKey });
  const existing = image.dynamicClients.find(o => o.configVersionId === version.configVersionId || o.idempotencyKeySha256 === idempotencyKeySha256);
  if (existing) {
    if (existing.requestSha256 !== requestSha256 || existing.idempotencyKeySha256 !== idempotencyKeySha256 || existing.configVersionId !== input.configVersionId) conflict();
    return { operation: replaceDynamic(image, expireDynamic(existing, now)), claimToken: null, registration: version };
  }
  const claimToken = randomBytes(32).toString("hex"), operation: McpDynamicClientOperation = {
    operationId: randomUUID(), registrationId: version.registrationId, configVersionId: version.configVersionId, owner: version.owner,
    registrationGeneration: version.generation, registrationRevision: input.expectedRevision, requestSha256, idempotencyKeySha256,
    claimTokenSha256: mcpRegistryDigest("mcp-dcr-claim-v1", claimToken), state: "prepared", createdAtMs: now, deadlineAtMs: now + input.operationTimeoutMs,
    sentAtMs: null, completedAtMs: null, clientId: null, responseSha256: null, resultSha256: null, clientSecretCommitmentSha256: null, clientSecretExpiresAtMs: null, clientMaterial: null };
  image.dynamicClients.push(operation); return { operation, claimToken, registration: version };
}
export function markMcpDynamicClientSendingImage(image: McpRegistryImage, input: MarkMcpDynamicClientSendingInput, now: number): McpDynamicClientOperation {
  const operation = dynamicOperation(image, input), version = current(image, input.owner, input.name);
  if (operation.state !== "prepared" || now >= operation.deadlineAtMs || version.configVersionId !== operation.configVersionId
    || image.slot!.revision !== operation.registrationRevision) conflict();
  return replaceDynamic(image, { ...operation, state: "sending", sentAtMs: now });
}
export function finishMcpDynamicClientImage(image: McpRegistryImage, input: FinishMcpDynamicClientInput, now: number): McpDynamicClientOperation {
  const operation = dynamicOperation(image, input), result = input.result;
  const version = image.versions.find(v => v.configVersionId === operation.configVersionId); if (!version || version.config.authentication.kind !== "oauth_dynamic") invalid();
  let clientMaterial: McpStoredMaterial | null = null;
  if (result.kind === "success") {
    text(result.clientId, 512); sha(result.responseSha256); if (result.clientSecretExpiresAtMs !== null) natural(result.clientSecretExpiresAtMs);
    if (version.config.authentication.clientAuthentication === "client_secret_basic") {
      sha(result.clientSecretCommitmentSha256); if (!result.clientSecret) invalid();
      clientMaterial = assertMcpEncryptedMaterialAdmission(result.clientSecret, mcpDynamicClientSecretAad(version, operation, result.clientId));
    } else if (result.clientSecret !== null || result.clientSecretCommitmentSha256 !== null || result.clientSecretExpiresAtMs !== null) invalid();
  }
  const resultSha256 = mcpRegistryDigest("mcp-dcr-result-v1", result.kind === "success" ? {
    kind: result.kind, clientId: result.clientId, responseSha256: result.responseSha256,
    clientSecretCommitmentSha256: result.clientSecretCommitmentSha256, clientSecretExpiresAtMs: result.clientSecretExpiresAtMs, clientAad: clientMaterial?.aad ?? null } : { kind: result.kind });
  if (operation.state === "succeeded") { if (result.kind === "success" && operation.resultSha256 === resultSha256) return operation; conflict(); }
  if (operation.state === result.kind && (result.kind === "outcome_unknown" || result.kind === "failed_not_dispatched")) return operation;
  if (operation.state !== "prepared" && operation.state !== "sending") conflict();
  if (result.kind === "failed_not_dispatched" && operation.state !== "prepared") conflict();
  if (result.kind === "success") {
    if (operation.state !== "sending") conflict();
    if (now >= operation.deadlineAtMs || result.clientSecretExpiresAtMs !== null && result.clientSecretExpiresAtMs <= now || image.slot?.state !== "enabled" || image.slot.currentVersionId !== operation.configVersionId
      || image.slot.revision !== operation.registrationRevision) return replaceDynamic(image, { ...operation, state: "outcome_unknown", completedAtMs: now, resultSha256 });
    return replaceDynamic(image, { ...operation, state: "succeeded", completedAtMs: now, clientId: result.clientId,
      responseSha256: result.responseSha256, resultSha256, clientSecretCommitmentSha256: result.clientSecretCommitmentSha256, clientSecretExpiresAtMs: result.clientSecretExpiresAtMs, clientMaterial });
  }
  return replaceDynamic(image, { ...operation, state: result.kind, completedAtMs: now, resultSha256 });
}
export function getMcpDynamicClientImage(image: McpRegistryImage, input: GetMcpDynamicClientInput, now: number): McpDynamicClientOperation | null {
  id(input.configVersionId); const version = image.versions.find(v => v.configVersionId === input.configVersionId);
  if (!version || version.config.authentication.kind !== "oauth_dynamic") conflict();
  const operation = image.dynamicClients.find(o => o.configVersionId === input.configVersionId);
  return operation ? replaceDynamic(image, expireDynamic(operation, now)) : null;
}
function assertMcpDynamicClientImage(image: McpRegistryImage): void {
  if (new Set(image.dynamicClients.map(o => o.configVersionId)).size !== image.dynamicClients.length
    || new Set(image.dynamicClients.map(o => o.operationId)).size !== image.dynamicClients.length
    || new Set(image.dynamicClients.map(o => o.idempotencyKeySha256)).size !== image.dynamicClients.length) invalid();
  for (const o of image.dynamicClients) {
    closed(o, ["operationId", "registrationId", "configVersionId", "owner", "registrationGeneration", "registrationRevision", "requestSha256", "idempotencyKeySha256", "claimTokenSha256", "state", "createdAtMs", "deadlineAtMs", "sentAtMs", "completedAtMs", "clientId", "responseSha256", "resultSha256", "clientSecretCommitmentSha256", "clientSecretExpiresAtMs", "clientMaterial"]);
    id(o.operationId); id(o.configVersionId); sha(o.requestSha256); sha(o.idempotencyKeySha256); sha(o.claimTokenSha256); validateMcpRegistrationOwner(o.owner);
    const v = image.versions.find(v => v.configVersionId === o.configVersionId);
    if (!v || v.config.authentication.kind !== "oauth_dynamic" || o.registrationId !== v.registrationId || canonical(o.owner) !== canonical(v.owner)
      || o.registrationGeneration !== v.generation || !Number.isSafeInteger(o.registrationRevision) || o.registrationRevision < v.revision || o.registrationRevision > image.slot!.revision
      || o.requestSha256 !== mcpRegistryDigest("mcp-dcr-request-v1", { registrationId: v.registrationId, configVersionId: v.configVersionId, owner: v.owner, generation: v.generation, revision: o.registrationRevision, config: v.config })) invalid();
    natural(o.createdAtMs); natural(o.deadlineAtMs); if (o.createdAtMs < v.createdAtMs || o.deadlineAtMs <= o.createdAtMs || o.deadlineAtMs - o.createdAtMs > 120000) invalid();
    if (!["prepared", "sending", "succeeded", "failed_not_dispatched", "outcome_unknown"].includes(o.state)) invalid();
    if (o.sentAtMs !== null) { natural(o.sentAtMs); if (o.sentAtMs < o.createdAtMs || o.sentAtMs >= o.deadlineAtMs) invalid(); }
    if (o.state === "prepared" || o.state === "sending") { if (o.completedAtMs !== null || (o.state === "prepared") !== (o.sentAtMs === null)) invalid(); }
    else { natural(o.completedAtMs); if (o.completedAtMs! < (o.sentAtMs ?? o.createdAtMs)) invalid(); }
    if (o.state === "succeeded") {
      if (o.sentAtMs === null || o.completedAtMs! >= o.deadlineAtMs) invalid(); if (o.clientSecretExpiresAtMs !== null) { natural(o.clientSecretExpiresAtMs); if (o.clientSecretExpiresAtMs <= o.completedAtMs!) invalid(); } text(o.clientId, 512); sha(o.responseSha256); sha(o.resultSha256);
      if (v.config.authentication.clientAuthentication === "client_secret_basic") {
        sha(o.clientSecretCommitmentSha256); const m = o.clientMaterial; if (!m) invalid();
        closed(m, ["materialId", "aad", "envelope"]); if (m.materialId !== o.operationId || canonical(m.aad) !== canonical(mcpDynamicClientSecretAad(v, o, o.clientId!))) invalid();
        if (m.envelope !== null) validateEnvelope(m.envelope);
      } else if (o.clientMaterial !== null || o.clientSecretCommitmentSha256 !== null || o.clientSecretExpiresAtMs !== null) invalid();
      if (o.resultSha256 !== mcpRegistryDigest("mcp-dcr-result-v1", { kind: "success", clientId: o.clientId, responseSha256: o.responseSha256, clientSecretCommitmentSha256: o.clientSecretCommitmentSha256, clientSecretExpiresAtMs: o.clientSecretExpiresAtMs, clientAad: o.clientMaterial?.aad ?? null })) invalid();
    } else if (o.clientId !== null || o.responseSha256 !== null || o.clientSecretCommitmentSha256 !== null || o.clientSecretExpiresAtMs !== null || o.clientMaterial !== null) invalid();
    if (o.resultSha256 !== null) sha(o.resultSha256);
    if ((o.state === "prepared" || o.state === "sending") && o.resultSha256 !== null) invalid();
    if (o.state === "failed_not_dispatched" && o.sentAtMs !== null) invalid();
  }
}
function invalidateDynamicClients(image: McpRegistryImage, now: number, clearSecrets: boolean): void {
  image.dynamicClients = image.dynamicClients.map(o => o.state === "prepared" || o.state === "sending"
    ? { ...o, state: o.state === "prepared" ? "failed_not_dispatched" : "outcome_unknown", completedAtMs: now }
    : clearSecrets && o.clientMaterial?.envelope ? { ...o, clientMaterial: { ...o.clientMaterial, envelope: null } } : o);
}

export interface McpRegistryReplay { keySha256: string; requestSha256: string; kind: "registration" | "authorization" | "begin"; result: McpRegistrationSlot | McpUserAuthorization | McpPendingAuthorization }
/** One real registration, not a platform/global mutex. All subjects remain distinct rows. */
export interface McpRegistryImage {
  slot: McpRegistrationSlot | null; versions: McpRegistrationVersion[]; authorizations: McpUserAuthorization[];
  pending: McpPendingAuthorization[]; credentials: McpCredentialVersion[]; operations: McpCredentialOperation[];
  materials: McpStoredMaterial[]; replays: McpRegistryReplay[]; dynamicClients: McpDynamicClientOperation[];
}
export const MCP_REGISTRY_EPOCH_OPERATION_LIMIT = 4096;
// Two independently valid epochs: one state material and at most one token
// material per operation; slot/current-auth/historical-epoch need at most 3 configs.
export const MCP_REGISTRY_HISTORICAL_MATERIAL_LIMIT = 2 * (MCP_REGISTRY_EPOCH_OPERATION_LIMIT + 1) + 3;
export function emptyMcpRegistryImage(): McpRegistryImage { return { slot: null, versions: [], authorizations: [], pending: [], credentials: [], operations: [], materials: [], replays: [], dynamicClients: [] }; }
export function mcpRegistryInput<I extends McpRegistryOwnerInput>(input: I, fields: readonly string[], mode?: "manage" | "runtime") {
  closed(input, fields); const context = assertMcpRegistryAccess(input.access, input.owner, mode);
  // Read every plain data descriptor before any await. Capability/admission originals are retained.
  const staged = { ...input, owner: structuredClone(input.owner) };
  if ("result" in input) {
    const result = input.result;
    if (!result || typeof result !== "object") invalid();
    const kindDescriptor = Object.getOwnPropertyDescriptor(result, "kind"); if (!kindDescriptor || !("value" in kindDescriptor)) invalid();
    if (kindDescriptor.value === "success") {
      if (fields === MCP_REGISTRY_INPUT_FIELDS.dynamicFinish) {
        closed(result, ["kind", "clientId", "responseSha256", "clientSecretCommitmentSha256", "clientSecretExpiresAtMs", "clientSecret"]);
        Object.assign(staged, { result: { ...result } });
      } else { closed(result, ["kind", "material", "scopes", "expiresInMs"]); validateScopes(result.scopes);
        Object.assign(staged, { result: { ...result, scopes: [...result.scopes] } }); }
    } else { closed(result, ["kind"]); if (result.kind !== "outcome_unknown" && result.kind !== "failed_not_dispatched") invalid(); Object.assign(staged, { result: { ...result } }); }
  }
  return { input: staged, ...context };
}
function current(image: McpRegistryImage, owner: McpRegistrationOwner, registrationName: string, enabled = true): McpRegistrationVersion {
  const slot = image.slot;
  if (!slot || slot.registrationId !== mcpRegistrationId(owner, registrationName) || slot.state === "deleted" || enabled && slot.state !== "enabled") conflict();
  const version = image.versions.find(v => v.configVersionId === slot.currentVersionId && v.generation === slot.generation);
  if (!version) invalid(); return version;
}
function actual(input: McpRegistryNameInput): McpCredentialSubject { return assertMcpRegistryAccess(input.access, input.owner, "runtime").principal; }
function authorization(image: McpRegistryImage, input: McpRegistryNameInput): McpUserAuthorization | undefined {
  return image.authorizations.find(a => a.authorizationKey === mcpAuthorizationKey(mcpRegistrationId(input.owner, input.name), actual(input)));
}
function replaceAuthorization(image: McpRegistryImage, row: McpUserAuthorization) {
  image.authorizations = [...image.authorizations.filter(a => a.authorizationKey !== row.authorizationKey), row];
}
function clearAuthorization(image: McpRegistryImage, key: string, now: number, state: "disabled" | "disconnected", epoch: number): McpUserAuthorization {
  const row = image.authorizations.find(a => a.authorizationKey === key); if (!row) conflict();
  image.pending = image.pending.map(p => p.authorizationKey === key && p.state === "pending" ? { ...p, state: "invalidated" } : p);
  image.operations = image.operations.map(o => o.authorizationKey === key && o.state === "pending" ? { ...o, state: "outcome_unknown", completedAtMs: now } : o);
  image.materials = image.materials.map(m => m.aad.subject && mcpAuthorizationKey(m.aad.registrationId, m.aad.subject) === key ? { ...m, envelope: null } : m);
  const next = { ...row, authorizationEpoch: epoch, state, credentialVersionId: null, updatedAtMs: now };
  replaceAuthorization(image, next); return next;
}
function replay(image: McpRegistryImage, domain: string, idempotencyKey: string, request: unknown): { key: string; digest: string; previous: McpRegistryReplay | undefined } {
  text(idempotencyKey, 128); const body = request as { owner: McpRegistrationOwner; name: string; subject?: McpCredentialSubject };
  const registrationId = image.slot?.registrationId ?? mcpRegistrationId(body.owner, body.name);
  const key = mcpRegistryDigest(domain, { registrationId, subject: body.subject ?? null, idempotencyKey }), digest = mcpRegistryDigest(`${domain}-request`, request);
  const previous = image.replays.find(r => r.keySha256 === key); if (previous && previous.requestSha256 !== digest) conflict();
  if (!previous && image.replays.length >= 4096) conflict(); return { key, digest, previous };
}
function saveReplay(image: McpRegistryImage, r: ReturnType<typeof replay>, kind: McpRegistryReplay["kind"], result: McpRegistryReplay["result"]) {
  image.replays.push({ keySha256: r.key, requestSha256: r.digest, kind, result: structuredClone(result) });
}
export function upsertMcpRegistryImage(image: McpRegistryImage, input: UpsertMcpRegistrationInput, now: number): McpRegistrationResult {
  name(input.name); natural(input.expectedRevision); natural(now); const config = assertMcpRegistrationAdmission(input.admission);
  const commitment = registrations.get(input.admission)!.commitment;
  if (input.configVersionId !== mcpRegistrationVersionId(input.owner, input.name, input.expectedRevision, input.idempotencyKey)) invalid();
  const r = replay(image, "mcp-registration-write-v1", input.idempotencyKey, { owner: input.owner, name: input.name, expectedRevision: input.expectedRevision, config, commitment });
  if (r.previous) {
    if (r.previous.kind !== "registration" || !image.slot || image.slot.revision !== (r.previous.result as McpRegistrationSlot).revision) conflict();
    const slot = r.previous.result as McpRegistrationSlot, version = image.versions.find(v => v.configVersionId === slot.currentVersionId && v.registrationId === slot.registrationId && v.generation === slot.generation);
    if (!version) invalid(); return { slot, version };
  }
  const old = image.slot;
  if (input.expectedRevision !== (old?.revision ?? 0) || image.versions.filter(v => v.generation === old?.generation).length >= 128 && old?.state !== "deleted") conflict();
  const slot: McpRegistrationSlot = { registrationId: mcpRegistrationId(input.owner, input.name), owner: input.owner, name: input.name,
    revision: (old?.revision ?? 0) + 1, generation: old ? old.generation + (old.state === "deleted" ? 1 : 0) : 1,
    state: "enabled", currentVersionId: input.configVersionId, createdAtMs: old?.createdAtMs ?? now, updatedAtMs: now };
  const version: McpRegistrationVersion = { configVersionId: slot.currentVersionId!, configSha256: mcpRegistryDigest("mcp-registration-config-v1", config),
    registrationId: slot.registrationId, owner: input.owner, name: input.name, revision: slot.revision, generation: slot.generation, config, createdAtMs: now, clientSecretCommitmentSha256: commitment };
  const clientMaterial = commitment !== null ? assertMcpEncryptedMaterialAdmission(input.clientSecret!, mcpSecretAad(version, "as_client", null, 0, version.configVersionId)) : null;
  if (commitment === null && input.clientSecret !== null) invalid();
  // Configuration publishes one immutable version/security revision. User grants
  // retain history and fail fresh revision checks; no scan of other users here.
  image.materials = image.materials.map(m => m.aad.purpose === "as_client" ? { ...m, envelope: null } : m); if (clientMaterial) image.materials.push(clientMaterial);
  invalidateDynamicClients(image, now, true);
  image.slot = slot; image.versions.push(version); saveReplay(image, r, "registration", slot);
  const storedVersion = image.versions.find(v => v.configVersionId === slot.currentVersionId); if (!storedVersion) invalid();
  return { slot, version: storedVersion };
}
export function setMcpRegistrationImageState(image: McpRegistryImage, input: SetMcpRegistrationStateInput, now: number): McpRegistrationSlot {
  name(input.name); natural(input.expectedRevision); natural(now); if (!["enabled", "disabled", "deleted"].includes(input.state)) invalid();
  const r = replay(image, "mcp-registration-state-v1", input.idempotencyKey, { owner: input.owner, name: input.name, expectedRevision: input.expectedRevision, state: input.state });
  if (r.previous) { if (r.previous.kind !== "registration" || image.slot?.revision !== (r.previous.result as McpRegistrationSlot).revision) conflict(); return r.previous.result as McpRegistrationSlot; }
  const old = image.slot; if (!old || old.state === "deleted" || old.revision !== input.expectedRevision) conflict();
  const next = { ...old, state: input.state, revision: old.revision + 1, currentVersionId: input.state === "deleted" ? null : old.currentVersionId, updatedAtMs: now };
  image.materials = image.materials.map(m => input.state === "deleted" && m.aad.purpose === "as_client" ? { ...m, envelope: null } : m);
  invalidateDynamicClients(image, now, input.state === "deleted");
  image.slot = next; saveReplay(image, r, "registration", next); return next;
}
export function beginMcpAuthorizationImage(image: McpRegistryImage, input: BeginMcpAuthorizationInput, now: number): McpPendingAuthorization {
  natural(now); id(input.authorizationId); sha(input.stateSha256); natural(input.expectedAuthorizationEpoch);
  natural(input.expiresInMs, 600000); if (input.expiresInMs < 1000) invalid();
  const subject = actual(input), v = currentEffective(image, input.owner, input.name, now), a = v.config.authentication; if (a.kind !== "oauth" || v.configVersionId !== input.configVersionId) conflict();
  const pkce = assertMcpEncryptedMaterialAdmission(input.pkce, mcpSecretAad(v, "oauth_state", subject, input.expectedAuthorizationEpoch + 1, input.authorizationId, image.slot!.revision));
  const r = replay(image, "mcp-authorization-begin-v1", input.idempotencyKey, { subject, configVersionId: input.configVersionId, expectedAuthorizationEpoch: input.expectedAuthorizationEpoch, authorizationId: input.authorizationId, stateSha256: input.stateSha256, expiresInMs: input.expiresInMs, pkce });
  if (r.previous) {
    if (r.previous.kind !== "begin") conflict(); const old = image.pending.find(p => p.authorizationId === (r.previous!.result as McpPendingAuthorization).authorizationId);
    if (!old || old.state !== "pending" || old.expiresAtMs <= now || authorization(image, input)?.authorizationEpoch !== old.authorizationEpoch) conflict(); return old;
  }
  const previous = authorization(image, input), key = mcpAuthorizationKey(v.registrationId, subject);
  if ((previous?.authorizationEpoch ?? 0) !== input.expectedAuthorizationEpoch || image.pending.length >= 2048 || image.pending.some(p => p.authorizationId === input.authorizationId || p.stateSha256 === input.stateSha256)) conflict();
  if (previous) clearAuthorization(image, key, now, "disconnected", previous.authorizationEpoch + 1);
  const next: McpUserAuthorization = { authorizationKey: key, registrationId: v.registrationId, subject, configVersionId: v.configVersionId,
    registrationGeneration: v.generation, authorizationEpoch: input.expectedAuthorizationEpoch + 1, tokenRevision: previous?.tokenRevision ?? 0,
    registrationRevision: image.slot!.revision,
    state: "pending", credentialVersionId: null, updatedAtMs: now };
  const row: McpPendingAuthorization = { authorizationId: input.authorizationId, authorizationKey: key, registrationId: v.registrationId,
    subject, configVersionId: v.configVersionId, registrationGeneration: v.generation, authorizationEpoch: next.authorizationEpoch,
    registrationRevision: image.slot!.revision,
    stateSha256: input.stateSha256, redirectUri: a.redirectUri, state: "pending", pkceMaterialId: input.authorizationId,
    createdAtMs: now, expiresAtMs: now + input.expiresInMs, consumedAtMs: null };
  replaceAuthorization(image, next); image.materials.push(pkce); image.pending.push(row); saveReplay(image, r, "begin", row); return row;
}
export function getMcpPendingImage(image: McpRegistryImage, input: McpRegistryNameInput & { idempotencyKey: string }, now: number) {
  text(input.idempotencyKey, 128); const subject = actual(input), v = current(image, input.owner, input.name);
  const key = mcpRegistryDigest("mcp-authorization-begin-v1", { registrationId: v.registrationId, subject, idempotencyKey: input.idempotencyKey }), r = image.replays.find(r => r.keySha256 === key);
  if (!r || r.kind !== "begin") return null;
  const pending = image.pending.find(p => p.authorizationId === (r.result as McpPendingAuthorization).authorizationId);
  if (!pending || canonical(pending.subject) !== canonical(subject)) return null;
  if (pending.state !== "pending" || pending.expiresAtMs <= now || pending.configVersionId !== v.configVersionId || pending.registrationRevision !== image.slot!.revision || authorization(image, input)?.authorizationEpoch !== pending.authorizationEpoch) conflict();
  const material = image.materials.find(m => m.materialId === pending.pkceMaterialId && m.envelope); if (!material) invalid(); return { pending, material };
}
function claim(image: McpRegistryImage, input: McpRegistryNameInput, kind: "exchange" | "refresh", sourceMaterial: McpStoredMaterial, now: number, timeout: number, pending: McpPendingAuthorization | null): McpOperationClaim {
  natural(timeout, 120000); if (timeout < 100) invalid(); const v = currentEffective(image, input.owner, input.name, now), auth = authorization(image, input); if (!auth) conflict();
  if (image.operations.length >= MCP_REGISTRY_EPOCH_OPERATION_LIMIT || image.operations.some(o => o.authorizationKey === auth.authorizationKey && o.authorizationEpoch === auth.authorizationEpoch && o.predecessorTokenRevision === auth.tokenRevision && o.state !== "failed_not_dispatched")) conflict();
  const token = randomBytes(32).toString("hex");
  const operation: McpCredentialOperation = { operationId: randomUUID(), authorizationKey: auth.authorizationKey, registrationId: v.registrationId,
    subject: auth.subject, configVersionId: v.configVersionId, registrationGeneration: v.generation, authorizationEpoch: auth.authorizationEpoch,
    registrationRevision: image.slot!.revision,
    predecessorTokenRevision: auth.tokenRevision, predecessorCredentialVersionId: auth.credentialVersionId,
    kind, authorizationId: pending?.authorizationId ?? null, resultCredentialVersionId: randomUUID(), claimTokenSha256: mcpRegistryDigest("mcp-operation-claim-v1", token),
    state: "pending", resultSha256: null, createdAtMs: now, deadlineAtMs: now + timeout, completedAtMs: null };
  const clientMaterial = v.dynamicClientOperationId ? image.dynamicClients.find(o => o.operationId === v.dynamicClientOperationId)?.clientMaterial ?? null : image.materials.find(m => m.aad.configVersionId === v.configVersionId && m.aad.purpose === "as_client" && m.envelope) ?? null;
  if (v.config.authentication.kind !== "oauth" || v.config.authentication.clientAuthentication !== "none" && !clientMaterial?.envelope || v.dynamicClientSecretExpiresAtMs !== undefined && v.dynamicClientSecretExpiresAtMs !== null && v.dynamicClientSecretExpiresAtMs <= now) conflict();
  image.operations.push(operation);
  return { operation, claimToken: token, registration: v, sourceMaterial, clientMaterial,
    resultAad: mcpSecretAad(v, "oauth_tokens", auth.subject, auth.authorizationEpoch, operation.resultCredentialVersionId, operation.registrationRevision) };
}
export function consumeMcpAuthorizationImage(image: McpRegistryImage, input: ConsumeMcpAuthorizationInput, now: number): McpOperationClaim {
  id(input.authorizationId); sha(input.stateSha256); const subject = actual(input), v = currentEffective(image, input.owner, input.name, now), auth = authorization(image, input);
  const p = image.pending.find(p => p.authorizationId === input.authorizationId);
  if (!p || canonical(p.subject) !== canonical(subject) || p.stateSha256 !== input.stateSha256 || p.redirectUri !== input.redirectUri || p.state !== "pending" || p.expiresAtMs <= now || p.configVersionId !== v.configVersionId || p.registrationRevision !== image.slot!.revision || auth?.state !== "pending" || auth.authorizationEpoch !== p.authorizationEpoch || auth.registrationRevision !== image.slot!.revision) conflict();
  const material = image.materials.find(m => m.materialId === p.pkceMaterialId && m.envelope); if (!material) invalid();
  const result = claim(image, input, "exchange", structuredClone(material), now, input.operationTimeoutMs, p);
  image.pending = image.pending.map(row => row === p ? { ...row, state: "consumed", consumedAtMs: now } : row);
  image.materials = image.materials.map(m => m === material ? { ...m, envelope: null } : m); return result;
}
export function beginMcpRefreshImage(image: McpRegistryImage, input: BeginMcpRefreshInput, now: number): McpOperationClaim {
  actual(input); const v = currentEffective(image, input.owner, input.name, now), auth = authorization(image, input);
  if (!auth || auth.state !== "connected" || auth.configVersionId !== v.configVersionId || auth.registrationRevision !== image.slot!.revision || auth.authorizationEpoch !== input.expectedAuthorizationEpoch || auth.tokenRevision !== input.expectedTokenRevision || auth.credentialVersionId !== input.expectedCredentialVersionId) conflict();
  const credential = image.credentials.find(c => c.credentialVersionId === auth.credentialVersionId), material = credential && image.materials.find(m => m.materialId === credential.materialId && m.envelope);
  if (!material) invalid(); return claim(image, input, "refresh", material, now, input.operationTimeoutMs, null);
}
export function finishMcpCredentialOperationImage(image: McpRegistryImage, input: FinishMcpCredentialOperationInput, now: number): McpUserAuthorization {
  id(input.operationId); sha(input.claimToken); const subject = actual(input), v = currentEffective(image, input.owner, input.name, now), auth = authorization(image, input);
  const op = image.operations.find(o => o.operationId === input.operationId);
  if (!op || canonical(op.subject) !== canonical(subject) || op.claimTokenSha256 !== mcpRegistryDigest("mcp-operation-claim-v1", input.claimToken) || !auth || auth.authorizationEpoch !== op.authorizationEpoch || auth.configVersionId !== op.configVersionId || v.configVersionId !== op.configVersionId || op.registrationRevision !== image.slot!.revision || auth.registrationRevision !== image.slot!.revision) conflict();
  const result = input.result;
  const material = result.kind === "success" ? assertMcpEncryptedMaterialAdmission(result.material, mcpSecretAad(v, "oauth_tokens", subject, op.authorizationEpoch, op.resultCredentialVersionId, op.registrationRevision)) : null;
  const digest = mcpRegistryDigest("mcp-operation-result-v1", { kind: result.kind, material, scopes: result.kind === "success" ? result.scopes : null, expiresInMs: result.kind === "success" ? result.expiresInMs : null });
  if (op.state !== "pending") { if (op.state === "succeeded" && op.resultSha256 === digest && auth.credentialVersionId === op.resultCredentialVersionId) return auth; conflict(); }
  if (auth.tokenRevision !== op.predecessorTokenRevision || auth.credentialVersionId !== op.predecessorCredentialVersionId) conflict();
  if (result.kind === "success") {
    const authentication = v.config.authentication;
    validateScopes(result.scopes); natural(result.expiresInMs, 86400000); if (!result.expiresInMs || now >= op.deadlineAtMs || authentication.kind !== "oauth" || result.scopes.some(s => !authentication.scopes.includes(s))) conflict();
    const credential: McpCredentialVersion = { credentialVersionId: op.resultCredentialVersionId, authorizationKey: auth.authorizationKey, registrationId: v.registrationId, subject,
      configVersionId: op.configVersionId, registrationGeneration: op.registrationGeneration, authorizationEpoch: op.authorizationEpoch,
      registrationRevision: op.registrationRevision,
      tokenRevision: auth.tokenRevision + 1, operationId: op.operationId, scopes: [...result.scopes], accessTokenExpiresAtMs: now + result.expiresInMs,
      materialId: op.resultCredentialVersionId, createdAtMs: now };
    image.materials = image.materials.map(m => m.materialId === op.predecessorCredentialVersionId ? { ...m, envelope: null } : m);
    image.materials.push(material!); image.credentials.push(credential);
    const next: McpUserAuthorization = { ...auth, tokenRevision: credential.tokenRevision, credentialVersionId: credential.credentialVersionId, state: "connected", updatedAtMs: now };
    replaceAuthorization(image, next); image.operations = image.operations.map(o => o === op ? { ...o, state: "succeeded", resultSha256: digest, completedAtMs: now } : o); return next;
  }
  image.operations = image.operations.map(o => o === op ? { ...o, state: result.kind, resultSha256: digest, completedAtMs: now } : o);
  // A refresh may already have rotated remotely. Retain its immutable predecessor
  // identity, never a live ciphertext/pointer that could be sent a second time.
  if (result.kind === "outcome_unknown") image.materials = image.materials.map(m => m.materialId === op.predecessorCredentialVersionId ? { ...m, envelope: null } : m);
  const next: McpUserAuthorization = { ...auth, state: result.kind === "outcome_unknown" ? "outcome_unknown" : "disconnected",
    credentialVersionId: result.kind === "outcome_unknown" ? null : auth.credentialVersionId, updatedAtMs: now };
  replaceAuthorization(image, next); return next;
}
export function setMcpUserAuthorizationImageState(image: McpRegistryImage, input: SetMcpUserAuthorizationStateInput, now: number): McpUserAuthorization {
  current(image, input.owner, input.name, false); const subject = actual(input); natural(input.expectedAuthorizationEpoch);
  if (input.state !== "disabled" && input.state !== "disconnected") invalid();
  const r = replay(image, "mcp-user-authorization-state-v1", input.idempotencyKey, { subject, epoch: input.expectedAuthorizationEpoch, state: input.state });
  if (r.previous) { const old = authorization(image, input); if (r.previous.kind !== "authorization" || old?.authorizationEpoch !== (r.previous.result as McpUserAuthorization).authorizationEpoch) conflict(); return old; }
  const old = authorization(image, input); if (!old || old.authorizationEpoch !== input.expectedAuthorizationEpoch) conflict();
  const next = clearAuthorization(image, old.authorizationKey, now, input.state, old.authorizationEpoch + 1); saveReplay(image, r, "authorization", next); return next;
}
export function getMcpUserAuthorizationImage(image: McpRegistryImage, input: McpRegistryNameInput): McpUserAuthorization | null {
  actual(input); const auth = authorization(image, input); if (!auth) return null;
  return auth.registrationRevision === image.slot?.revision ? auth : { ...auth, state: "disconnected", credentialVersionId: null };
}
export function getMcpRuntimeImage(image: McpRegistryImage, input: McpRegistryNameInput, now: number): McpRuntimeAuthorization | null {
  const result = getMcpAuthorizationContextImage(image, input, now);
  if (!result || result.registration.config.authentication.kind !== "none" && (!result.authorization || result.authorization.state !== "connected" || !result.credential || result.credential.accessTokenExpiresAtMs <= now || !result.material?.envelope)) return null;
  return result;
}
export function getMcpAuthorizationContextImage(image: McpRegistryImage, input: McpRegistryNameInput, now: number): McpRuntimeAuthorization | null {
  actual(input); if (!image.slot || image.slot.state !== "enabled") return null;
  const v = currentEffective(image, input.owner, input.name, now); if (v.config.authentication.kind === "none") return { registration: v, slot: image.slot, authorization: null, credential: null, material: null };
  const auth = authorization(image, input);
  if (!auth || auth.state !== "connected" || auth.configVersionId !== v.configVersionId || auth.registrationGeneration !== v.generation || auth.registrationRevision !== image.slot.revision) return { registration: v, slot: image.slot, authorization: getMcpUserAuthorizationImage(image, input), credential: null, material: null };
  const credential = image.credentials.find(c => c.credentialVersionId === auth.credentialVersionId && c.tokenRevision === auth.tokenRevision && c.authorizationEpoch === auth.authorizationEpoch);
  const material = credential && image.materials.find(m => m.materialId === credential.materialId && m.envelope);
  if (!credential || !material) invalid();
  return { registration: v, slot: image.slot, authorization: auth, credential, material };
}

/** Complete physical image validation; ciphertext syntax or a hash alone is never authorization. */
export function assertMcpRegistryImage(image: McpRegistryImage, owner: McpRegistrationOwner, registrationName: string): void {
  assertMcpRegistryImageWithinBounds(image, owner, registrationName, 8192);
}
/** Read-only startup audit of a selected historical epoch plus the current one.
 * This is not an admission/write mode and does not change any hot-path quota. */
export function assertMcpRegistryHistoricalEpochImage(image: McpRegistryImage, owner: McpRegistrationOwner, registrationName: string, auditEpoch: number): void {
  closed(image, ["slot", "versions", "authorizations", "pending", "credentials", "operations", "materials", "replays", "dynamicClients"]);
  for (const field of ["versions", "authorizations", "pending", "credentials", "operations", "materials", "replays", "dynamicClients"] as const) if (!Array.isArray(image[field])) invalid();
  if (image.authorizations.length !== 1 || !image.slot) invalid();
  const auth = image.authorizations[0]!; validateMcpCredentialSubject(auth.subject); natural(auth.authorizationEpoch); natural(auditEpoch);
  if (!auditEpoch || auditEpoch > auth.authorizationEpoch) invalid();
  const epochs = new Set([auditEpoch, auth.authorizationEpoch]), configs = new Map<number, Set<string>>();
  const include = (row: { subject: McpCredentialSubject; authorizationEpoch: number; configVersionId: string; authorizationKey?: string }) => {
    if (!epochs.has(row.authorizationEpoch) || canonical(row.subject) !== canonical(auth.subject) || row.authorizationKey !== undefined && row.authorizationKey !== auth.authorizationKey) invalid();
    const versions = configs.get(row.authorizationEpoch) ?? new Set<string>(); versions.add(row.configVersionId); if (versions.size !== 1) invalid(); configs.set(row.authorizationEpoch, versions);
  };
  include(auth);
  for (const field of ["pending", "operations", "credentials"] as const) for (const row of image[field]) include(row);
  for (const epoch of epochs) {
    if (image.pending.filter(p => p.authorizationEpoch === epoch).length > 1
      || image.operations.filter(o => o.authorizationEpoch === epoch).length > MCP_REGISTRY_EPOCH_OPERATION_LIMIT
      || image.credentials.filter(c => c.authorizationEpoch === epoch).length > MCP_REGISTRY_EPOCH_OPERATION_LIMIT) invalid();
  }
  for (const material of image.materials) if (material.aad.purpose !== "as_client") {
    if (!material.aad.subject) invalid(); include({ subject: material.aad.subject, authorizationEpoch: material.aad.authorizationEpoch, configVersionId: material.aad.configVersionId });
  }
  const requiredVersions = new Set([image.slot.currentVersionId, auth.configVersionId, ...[...configs.values()].flatMap(ids => [...ids])].filter((id): id is string => id !== null));
  if (requiredVersions.size > 3 || image.versions.some(v => !requiredVersions.has(v.configVersionId))) invalid();
  const clients = image.materials.filter(m => m.aad.purpose === "as_client");
  if (clients.length > requiredVersions.size || clients.some(m => m.materialId !== m.aad.configVersionId || !requiredVersions.has(m.aad.configVersionId))) invalid();
  for (const replay of image.replays) {
    if (replay.kind === "registration") invalid();
    include(replay.result as McpUserAuthorization | McpPendingAuthorization);
  }
  assertMcpRegistryImageWithinBounds(image, owner, registrationName, MCP_REGISTRY_HISTORICAL_MATERIAL_LIMIT);
}
function assertMcpRegistryImageWithinBounds(image: McpRegistryImage, owner: McpRegistrationOwner, registrationName: string, materialLimit: number): void {
  validateMcpRegistrationOwner(owner); name(registrationName); closed(image, ["slot", "versions", "authorizations", "pending", "credentials", "operations", "materials", "replays", "dynamicClients"]);
  for (const field of ["versions", "authorizations", "pending", "credentials", "operations", "materials", "replays", "dynamicClients"] as const) if (!Array.isArray(image[field]) || image[field].length > (field === "versions" ? 129 : field === "materials" ? materialLimit : 8192)) invalid();
  if (!image.slot) { if (Object.values(image).some(v => Array.isArray(v) && v.length)) invalid(); return; }
  const slot = image.slot, regId = mcpRegistrationId(owner, registrationName);
  closed(slot, ["registrationId", "owner", "name", "revision", "generation", "state", "currentVersionId", "createdAtMs", "updatedAtMs"]);
  if (slot.registrationId !== regId || canonical(slot.owner) !== canonical(owner) || slot.name !== registrationName || !["enabled", "disabled", "deleted"].includes(slot.state)) invalid();
  for (const n of [slot.revision, slot.generation, slot.createdAtMs, slot.updatedAtMs]) natural(n);
  if (!slot.revision || !slot.generation || slot.updatedAtMs < slot.createdAtMs || slot.state === "deleted" && slot.currentVersionId !== null) invalid();
  const unique = <T>(rows: readonly T[], get: (row: T) => string) => { if (new Set(rows.map(get)).size !== rows.length) invalid(); };
  unique(image.versions, r => r.configVersionId); unique(image.authorizations, r => r.authorizationKey); unique(image.pending, r => r.authorizationId); unique(image.pending, r => r.stateSha256);
  unique(image.credentials, r => r.credentialVersionId); unique(image.operations, r => r.operationId); unique(image.materials, r => r.materialId); unique(image.replays, r => r.keySha256);
  for (const v of image.versions) {
    closed(v, ["configVersionId", "configSha256", "registrationId", "owner", "name", "revision", "generation", "config", "createdAtMs", "clientSecretCommitmentSha256"]); id(v.configVersionId); validateMcpRegistrationConfig(v.config);
    if (v.config.authentication.kind === "oauth" && v.config.authentication.clientAuthentication === "client_secret_basic") sha(v.clientSecretCommitmentSha256);
    else if (v.clientSecretCommitmentSha256 !== null) invalid();
    if (v.registrationId !== regId || canonical(v.owner) !== canonical(owner) || v.name !== registrationName || v.configSha256 !== mcpRegistryDigest("mcp-registration-config-v1", v.config)) invalid();
    for (const n of [v.revision, v.generation, v.createdAtMs]) natural(n);
    if (!v.revision || v.revision > slot.revision || !v.generation || v.generation > slot.generation || v.createdAtMs < slot.createdAtMs || v.createdAtMs > slot.updatedAtMs) invalid();
  }
  if (slot.state !== "deleted" && !image.versions.some(v => v.configVersionId === slot.currentVersionId && v.generation === slot.generation)) invalid();
  assertMcpDynamicClientImage(image);
  for (const a of image.authorizations) {
    closed(a, ["authorizationKey", "registrationId", "subject", "configVersionId", "registrationGeneration", "registrationRevision", "authorizationEpoch", "tokenRevision", "state", "credentialVersionId", "updatedAtMs"]);
    validateMcpCredentialSubject(a.subject); natural(a.authorizationEpoch); natural(a.tokenRevision); natural(a.updatedAtMs); natural(a.registrationRevision); if (!a.registrationRevision || a.registrationRevision > slot.revision) invalid();
    const v = image.versions.find(v => v.configVersionId === a.configVersionId);
    if (a.registrationId !== regId || a.authorizationKey !== mcpAuthorizationKey(regId, a.subject) || !v || a.registrationGeneration !== v.generation || !a.authorizationEpoch || !["pending", "connected", "disabled", "disconnected", "outcome_unknown"].includes(a.state)) invalid();
    if (owner.scope !== "platform" && owner.tenantId !== a.subject.tenantId || owner.scope === "user" && owner.userId !== a.subject.userId) invalid();
    if (a.credentialVersionId !== null && !image.credentials.some(c => c.credentialVersionId === a.credentialVersionId && c.authorizationKey === a.authorizationKey && c.tokenRevision === a.tokenRevision && c.authorizationEpoch === a.authorizationEpoch && c.registrationRevision === a.registrationRevision)) invalid();
    if (a.state === "connected" && a.credentialVersionId === null) invalid();
  }
  for (const p of image.pending) {
    closed(p, ["authorizationId", "authorizationKey", "registrationId", "subject", "configVersionId", "registrationGeneration", "registrationRevision", "authorizationEpoch", "stateSha256", "redirectUri", "state", "pkceMaterialId", "createdAtMs", "expiresAtMs", "consumedAtMs"]);
    natural(p.registrationRevision); if (!p.registrationRevision || p.registrationRevision > slot.revision) invalid();
    id(p.authorizationId); sha(p.stateSha256); validateMcpCredentialSubject(p.subject); const storedVersion = image.versions.find(v => v.configVersionId === p.configVersionId), v = storedVersion && effectiveVersion(image, storedVersion), a = image.authorizations.find(a => a.authorizationKey === p.authorizationKey);
    if (p.registrationId !== regId || p.authorizationKey !== mcpAuthorizationKey(regId, p.subject) || !v || !a || v.config.authentication.kind !== "oauth" || p.redirectUri !== v.config.authentication.redirectUri || p.registrationGeneration !== v.generation || p.authorizationEpoch > a.authorizationEpoch || !["pending", "consumed", "invalidated"].includes(p.state) || p.pkceMaterialId !== p.authorizationId) invalid();
    natural(p.createdAtMs); natural(p.expiresAtMs); if (p.expiresAtMs <= p.createdAtMs || p.expiresAtMs - p.createdAtMs > 600000 || !image.materials.some(m => m.materialId === p.pkceMaterialId)) invalid();
    if (p.state === "consumed") { natural(p.consumedAtMs); if (p.consumedAtMs! < p.createdAtMs || p.consumedAtMs! >= p.expiresAtMs || !image.operations.some(o => o.authorizationId === p.authorizationId && o.kind === "exchange")) invalid(); }
    else if (p.consumedAtMs !== null) invalid();
  }
  for (const o of image.operations) {
    closed(o, ["operationId", "authorizationKey", "registrationId", "subject", "configVersionId", "registrationGeneration", "registrationRevision", "authorizationEpoch", "predecessorTokenRevision", "predecessorCredentialVersionId", "kind", "authorizationId", "resultCredentialVersionId", "claimTokenSha256", "state", "resultSha256", "createdAtMs", "deadlineAtMs", "completedAtMs"]);
    natural(o.registrationRevision); if (!o.registrationRevision || o.registrationRevision > slot.revision) invalid();
    id(o.operationId); id(o.resultCredentialVersionId); sha(o.claimTokenSha256); validateMcpCredentialSubject(o.subject);
    const a = image.authorizations.find(a => a.authorizationKey === o.authorizationKey), v = image.versions.find(v => v.configVersionId === o.configVersionId);
    if (o.registrationId !== regId || !a || !v || o.authorizationKey !== mcpAuthorizationKey(regId, o.subject) || o.registrationGeneration !== v.generation || o.authorizationEpoch > a.authorizationEpoch || !["pending", "succeeded", "failed_not_dispatched", "outcome_unknown"].includes(o.state)) invalid();
    natural(o.predecessorTokenRevision); natural(o.createdAtMs); natural(o.deadlineAtMs); if (o.deadlineAtMs <= o.createdAtMs || o.deadlineAtMs - o.createdAtMs > 120000) invalid();
    if (o.kind === "exchange") { if (!image.pending.some(p => p.authorizationId === o.authorizationId && p.authorizationKey === o.authorizationKey && p.authorizationEpoch === o.authorizationEpoch && p.registrationRevision === o.registrationRevision && p.configVersionId === o.configVersionId && p.state === "consumed")) invalid(); }
    else if (o.kind !== "refresh" || o.authorizationId !== null || !image.credentials.some(c => c.credentialVersionId === o.predecessorCredentialVersionId && c.authorizationKey === o.authorizationKey && c.tokenRevision === o.predecessorTokenRevision && c.authorizationEpoch === o.authorizationEpoch && c.registrationRevision === o.registrationRevision && c.configVersionId === o.configVersionId)) invalid();
    if (o.state === "pending") { if (o.completedAtMs !== null || o.resultSha256 !== null) invalid(); }
    else { natural(o.completedAtMs); if (o.completedAtMs! < o.createdAtMs || o.resultSha256 !== null && !/^[a-f0-9]{64}$/.test(o.resultSha256)) invalid(); }
    if (o.state === "succeeded" && !image.credentials.some(c => c.credentialVersionId === o.resultCredentialVersionId && c.operationId === o.operationId && c.tokenRevision === o.predecessorTokenRevision + 1)) invalid();
  }
  unique(image.operations.filter(o => o.state !== "failed_not_dispatched"), o => `${o.authorizationKey}:${o.authorizationEpoch}:${o.predecessorTokenRevision}`);
  for (const c of image.credentials) {
    closed(c, ["credentialVersionId", "authorizationKey", "registrationId", "subject", "configVersionId", "registrationGeneration", "registrationRevision", "authorizationEpoch", "tokenRevision", "operationId", "scopes", "accessTokenExpiresAtMs", "materialId", "createdAtMs"]);
    id(c.credentialVersionId); validateMcpCredentialSubject(c.subject); validateScopes(c.scopes); natural(c.createdAtMs); natural(c.accessTokenExpiresAtMs);
    const o = image.operations.find(o => o.operationId === c.operationId);
    if (!o || o.state !== "succeeded" || c.registrationId !== regId || c.authorizationKey !== mcpAuthorizationKey(regId, c.subject) || c.configVersionId !== o.configVersionId || c.registrationGeneration !== o.registrationGeneration || c.registrationRevision !== o.registrationRevision || canonical(c.subject) !== canonical(o.subject) || c.authorizationEpoch !== o.authorizationEpoch || c.tokenRevision !== o.predecessorTokenRevision + 1 || c.materialId !== c.credentialVersionId || c.accessTokenExpiresAtMs <= c.createdAtMs) invalid();
  }
  for (const m of image.materials) {
    closed(m, ["materialId", "aad", "envelope"]); id(m.materialId); validateMcpSecretAad(m.aad); if (m.envelope !== null) validateEnvelope(m.envelope);
    const storedVersion = image.versions.find(v => v.configVersionId === m.aad.configVersionId), v = storedVersion && effectiveVersion(image, storedVersion);
    if (!v || m.materialId !== m.aad.materialId || canonical(m.aad) !== canonical(mcpSecretAad(v, m.aad.purpose, m.aad.subject, m.aad.authorizationEpoch, m.materialId, m.aad.registrationRevision))) invalid();
    if (m.aad.purpose === "oauth_state" && !image.pending.some(p => p.pkceMaterialId === m.materialId && p.authorizationEpoch === m.aad.authorizationEpoch && p.registrationRevision === m.aad.registrationRevision && canonical(p.subject) === canonical(m.aad.subject))) invalid();
    if (m.aad.purpose === "oauth_tokens" && !image.credentials.some(c => c.materialId === m.materialId && c.authorizationEpoch === m.aad.authorizationEpoch && c.registrationRevision === m.aad.registrationRevision && canonical(c.subject) === canonical(m.aad.subject))) invalid();
  }
  for (const r of image.replays) {
    closed(r, ["keySha256", "requestSha256", "kind", "result"]); sha(r.keySha256); sha(r.requestSha256);
    if (!r.result || r.result.registrationId !== regId) invalid();
    if (r.kind === "registration") {
      const result = r.result as McpRegistrationSlot;
      if (canonical(result.owner) !== canonical(owner) || result.name !== registrationName || !Number.isSafeInteger(result.revision) || result.revision < 1 || result.revision > slot.revision || !Number.isSafeInteger(result.generation) || result.generation < 1 || result.generation > slot.generation) invalid();
    } else if (r.kind === "begin") {
      const result = r.result as McpPendingAuthorization, actual = image.pending.find(p => p.authorizationId === result.authorizationId);
      if (!actual || canonical({ ...actual, state: result.state, consumedAtMs: result.consumedAtMs }) !== canonical(result) || result.state !== "pending" || result.consumedAtMs !== null) invalid();
    } else if (r.kind === "authorization") {
      const result = r.result as McpUserAuthorization, actual = image.authorizations.find(a => a.authorizationKey === result.authorizationKey);
      if (!actual || canonical(actual.subject) !== canonical(result.subject) || result.authorizationEpoch > actual.authorizationEpoch || !["disabled", "disconnected"].includes(result.state) || result.credentialVersionId !== null) invalid();
    } else invalid();
  }
}

export const MCP_REGISTRY_INPUT_FIELDS = {
  upsert: ["access", "owner", "name", "expectedRevision", "idempotencyKey", "admission", "configVersionId", "clientSecret"],
  registrationState: ["access", "owner", "name", "expectedRevision", "idempotencyKey", "state"],
  dynamicPrepare: ["access", "owner", "name", "configVersionId", "expectedRevision", "idempotencyKey", "operationTimeoutMs"],
  dynamicSending: ["access", "owner", "name", "operationId", "claimToken"],
  dynamicFinish: ["access", "owner", "name", "operationId", "claimToken", "result"],
  dynamicGet: ["access", "owner", "name", "configVersionId"],
  name: ["access", "owner", "name"], list: ["access", "owner", "cursor", "limit"],
  begin: ["access", "owner", "name", "idempotencyKey", "configVersionId", "expectedAuthorizationEpoch", "authorizationId", "stateSha256", "expiresInMs", "pkce"],
  pending: ["access", "owner", "name", "idempotencyKey"],
  consume: ["access", "owner", "name", "authorizationId", "stateSha256", "redirectUri", "operationTimeoutMs"],
  refresh: ["access", "owner", "name", "expectedAuthorizationEpoch", "expectedTokenRevision", "expectedCredentialVersionId", "operationTimeoutMs"],
  finish: ["access", "owner", "name", "operationId", "claimToken", "result"],
  authorizationState: ["access", "owner", "name", "expectedAuthorizationEpoch", "idempotencyKey", "state"],
} as const;
/** Exact immutable replay identity, including retained generations/epochs. */
export function mcpRegistryMutationReplaySelection(input: McpRegistryNameInput, fields: readonly string[]): { keySha256: string; registrationId: string; subject: McpCredentialSubject | null; kind: McpRegistryReplay["kind"] } | null {
  const selected = fields === MCP_REGISTRY_INPUT_FIELDS.upsert ? ["mcp-registration-write-v1", "registration"] as const
    : fields === MCP_REGISTRY_INPUT_FIELDS.registrationState ? ["mcp-registration-state-v1", "registration"] as const
    : fields === MCP_REGISTRY_INPUT_FIELDS.begin ? ["mcp-authorization-begin-v1", "begin"] as const
    : fields === MCP_REGISTRY_INPUT_FIELDS.authorizationState ? ["mcp-user-authorization-state-v1", "authorization"] as const : null;
  if (!selected) return null;
  const idempotencyKey = (input as McpRegistryNameInput & { idempotencyKey: string }).idempotencyKey; text(idempotencyKey, 128);
  const subject = selected[1] === "registration" ? null : actual(input), registrationId = mcpRegistrationId(input.owner, input.name);
  return { keySha256: mcpRegistryDigest(selected[0], { registrationId, subject, idempotencyKey }), registrationId, subject, kind: selected[1] };
}
export function assertMcpRegistryReplayHistory(existing: McpRegistryReplay | null, selected: NonNullable<ReturnType<typeof mcpRegistryMutationReplaySelection>>, current: McpRegistryImage): void {
  if (!existing) return;
  const subject = existing.kind === "registration" ? null : (existing.result as McpPendingAuthorization | McpUserAuthorization).subject;
  if (existing.keySha256 !== selected.keySha256 || existing.kind !== selected.kind || existing.result.registrationId !== selected.registrationId || canonical(subject) !== canonical(selected.subject)) invalid();
  // A key from an older frontier cannot be rebound to a new body/epoch, even
  // though that old epoch is deliberately absent from the hot locking image.
  if (!current.replays.some(r => r.keySha256 === selected.keySha256)) conflict();
}
export function mcpRegistrationView(image: McpRegistryImage) { return image.slot ? { slot: image.slot, version: image.versions.find(v => v.configVersionId === image.slot!.currentVersionId) ?? null } : null; }
export function listMcpRegistrationImages(slots: readonly McpRegistrationSlot[], input: ListMcpRegistrationsInput): McpRegistrationPage {
  natural(input.limit, 100); if (!input.limit) invalid(); if (input.cursor !== null) sha(input.cursor);
  const rows = slots.filter(s => !input.cursor || s.registrationId > input.cursor).sort((a,b) => a.registrationId < b.registrationId ? -1 : a.registrationId > b.registrationId ? 1 : 0);
  return { items: rows.slice(0, input.limit), nextCursor: rows.length > input.limit ? rows[input.limit - 1]!.registrationId : null };
}
export type McpRegistryGateContext = ReturnType<typeof assertMcpRegistryAccess> & { owner: McpRegistrationOwner };
/** Hot transactions see one subject/epoch, never all users of shared configuration. */
export function scopeMcpRegistryImage(full: McpRegistryImage, subject: McpCredentialSubject | null): McpRegistryImage {
  const image = emptyMcpRegistryImage(); image.slot = full.slot; if (!full.slot) return image;
  const auth = subject && full.authorizations.find(a => canonical(a.subject) === canonical(subject));
  image.authorizations = auth ? [auth] : [];
  const belongs = (r: { subject: McpCredentialSubject; authorizationEpoch: number }) => Boolean(auth && canonical(r.subject) === canonical(subject) && r.authorizationEpoch === auth.authorizationEpoch);
  image.pending = full.pending.filter(belongs); image.operations = full.operations.filter(belongs); image.credentials = full.credentials.filter(belongs);
  image.versions = full.versions.filter(v => subject ? v.configVersionId === full.slot!.currentVersionId || v.configVersionId === auth?.configVersionId : v.generation === full.slot!.generation);
  const versions = new Set(image.versions.map(v => v.configVersionId));
  image.dynamicClients = full.dynamicClients.filter(o => versions.has(o.configVersionId));
  image.materials = full.materials.filter(m => m.aad.purpose === "as_client" ? versions.has(m.aad.configVersionId) : belongs({ subject: m.aad.subject!, authorizationEpoch: m.aad.authorizationEpoch }));
  image.replays = full.replays.filter(r => subject ? r.kind !== "registration" && canonical((r.result as McpUserAuthorization).subject) === canonical(subject) && (r.result as McpUserAuthorization).authorizationEpoch === auth?.authorizationEpoch : r.kind === "registration" && (r.result as McpRegistrationSlot).generation === full.slot!.generation);
  return structuredClone(image);
}
export function mergeMcpRegistryImage(full: McpRegistryImage, changed: McpRegistryImage): McpRegistryImage {
  const merged = structuredClone(full); merged.slot = structuredClone(changed.slot);
  function merge<T>(before: readonly T[], after: readonly T[], identity: (row: T) => string): T[] {
    const next = new Map(before.map(row => [identity(row), row])); for (const row of after) next.set(identity(row), structuredClone(row)); return [...next.values()];
  }
  merged.dynamicClients = merge(full.dynamicClients, changed.dynamicClients, r => r.operationId);
  merged.versions = merge(full.versions, changed.versions, r => r.configVersionId);
  merged.authorizations = merge(full.authorizations, changed.authorizations, r => r.authorizationKey);
  merged.pending = merge(full.pending, changed.pending, r => r.authorizationId); merged.credentials = merge(full.credentials, changed.credentials, r => r.credentialVersionId);
  merged.operations = merge(full.operations, changed.operations, r => r.operationId); merged.materials = merge(full.materials, changed.materials, r => r.materialId);
  merged.replays = merge(full.replays, changed.replays, r => r.keySha256); return merged;
}
export class MemoryMcpRegistry implements McpRegistryStore {
  private readonly images = new Map<string, McpRegistryImage>();
  private readonly replayIndex = new Map<string, McpRegistryReplay>();
  constructor(private readonly gate: (context: McpRegistryGateContext) => void, private readonly now: () => number = Date.now) {}
  private async operation<I extends McpRegistryNameInput, T>(input: I, fields: readonly string[], mode: "manage" | "runtime" | undefined, mutate: boolean, work: (image: McpRegistryImage, staged: I, now: number) => T): Promise<T> {
    const checked = mcpRegistryInput(input, fields, mode); this.gate({ ...checked, owner: checked.input.owner });
    const key = mcpRegistrationId(checked.input.owner, checked.input.name), previous = this.images.get(key);
    const image = scopeMcpRegistryImage(previous ?? emptyMcpRegistryImage(), checked.mode === "runtime" ? checked.principal : null);
    if (fields === MCP_REGISTRY_INPUT_FIELDS.dynamicGet && previous) {
      const selected = (checked.input as unknown as GetMcpDynamicClientInput).configVersionId;
      const version = previous.versions.find(v => v.configVersionId === selected);
      if (version && !image.versions.some(v => v.configVersionId === selected)) {
        image.versions.push(structuredClone(version));
        image.dynamicClients.push(...structuredClone(previous.dynamicClients.filter(o => o.configVersionId === selected)));
      }
    }
    assertMcpRegistryImage(image, checked.input.owner, checked.input.name);
    const selected = mutate ? mcpRegistryMutationReplaySelection(checked.input, fields) : null;
    const priorReplay = selected ? this.replayIndex.get(selected.keySha256) : undefined;
    if (selected) assertMcpRegistryReplayHistory(priorReplay ?? null, selected, image);
    const outbound = structuredClone(work(image, checked.input, this.now())); assertMcpRegistryImage(image, checked.input.owner, checked.input.name);
    if (mutate) {
      const published = mergeMcpRegistryImage(previous ?? emptyMcpRegistryImage(), image);
      for (const [otherKey, other] of this.images) if (otherKey !== key && image.pending.some(p => other.pending.some(o => o.authorizationId === p.authorizationId || o.stateSha256 === p.stateSha256))) conflict();
      const indexed = selected ? structuredClone(image.replays.find(r => r.keySha256 === selected.keySha256)) : undefined;
      try { this.images.set(key, published); if (selected && indexed) this.replayIndex.set(selected.keySha256, indexed); }
      catch (error) {
        if (previous) Map.prototype.set.call(this.images, key, previous); else Map.prototype.delete.call(this.images, key);
        if (selected) { if (priorReplay) Map.prototype.set.call(this.replayIndex, selected.keySha256, priorReplay); else Map.prototype.delete.call(this.replayIndex, selected.keySha256); }
        throw error;
      }
    }
    return outbound;
  }
  prepareMcpDynamicClient(i: PrepareMcpDynamicClientInput) { return this.operation(i, MCP_REGISTRY_INPUT_FIELDS.dynamicPrepare, "manage", true, prepareMcpDynamicClientImage); }
  markMcpDynamicClientSending(i: MarkMcpDynamicClientSendingInput) { return this.operation(i, MCP_REGISTRY_INPUT_FIELDS.dynamicSending, "manage", true, markMcpDynamicClientSendingImage); }
  finishMcpDynamicClient(i: FinishMcpDynamicClientInput) { return this.operation(i, MCP_REGISTRY_INPUT_FIELDS.dynamicFinish, "manage", true, finishMcpDynamicClientImage); }
  getMcpDynamicClient(i: GetMcpDynamicClientInput) { return this.operation(i, MCP_REGISTRY_INPUT_FIELDS.dynamicGet, undefined, true, getMcpDynamicClientImage); }
  upsertMcpRegistration(i: UpsertMcpRegistrationInput) { return this.operation(i, MCP_REGISTRY_INPUT_FIELDS.upsert, "manage", true, upsertMcpRegistryImage); }
  setMcpRegistrationState(i: SetMcpRegistrationStateInput) { return this.operation(i, MCP_REGISTRY_INPUT_FIELDS.registrationState, "manage", true, setMcpRegistrationImageState); }
  getMcpRegistration(i: McpRegistryNameInput) { return this.operation(i, MCP_REGISTRY_INPUT_FIELDS.name, undefined, false, mcpRegistrationView); }
  beginMcpAuthorization(i: BeginMcpAuthorizationInput) { return this.operation(i, MCP_REGISTRY_INPUT_FIELDS.begin, "runtime", true, beginMcpAuthorizationImage); }
  getMcpPendingAuthorization(i: McpRegistryNameInput & { idempotencyKey: string }) { return this.operation(i, MCP_REGISTRY_INPUT_FIELDS.pending, "runtime", false, getMcpPendingImage); }
  consumeMcpAuthorization(i: ConsumeMcpAuthorizationInput) { return this.operation(i, MCP_REGISTRY_INPUT_FIELDS.consume, "runtime", true, consumeMcpAuthorizationImage); }
  beginMcpRefresh(i: BeginMcpRefreshInput) { return this.operation(i, MCP_REGISTRY_INPUT_FIELDS.refresh, "runtime", true, beginMcpRefreshImage); }
  finishMcpCredentialOperation(i: FinishMcpCredentialOperationInput) { return this.operation(i, MCP_REGISTRY_INPUT_FIELDS.finish, "runtime", true, finishMcpCredentialOperationImage); }
  getMcpUserAuthorization(i: McpRegistryNameInput) { return this.operation(i, MCP_REGISTRY_INPUT_FIELDS.name, "runtime", false, getMcpUserAuthorizationImage); }
  setMcpUserAuthorizationState(i: SetMcpUserAuthorizationStateInput) { return this.operation(i, MCP_REGISTRY_INPUT_FIELDS.authorizationState, "runtime", true, setMcpUserAuthorizationImageState); }
  getMcpRuntimeAuthorization(i: McpRegistryNameInput) { return this.operation(i, MCP_REGISTRY_INPUT_FIELDS.name, "runtime", false, getMcpRuntimeImage); }
  getMcpAuthorizationContext(i: McpRegistryNameInput) { return this.operation(i, MCP_REGISTRY_INPUT_FIELDS.name, "runtime", false, getMcpAuthorizationContextImage); }
  async listMcpRegistrations(input: ListMcpRegistrationsInput) {
    const checked = mcpRegistryInput(input, MCP_REGISTRY_INPUT_FIELDS.list); this.gate({ ...checked, owner: checked.input.owner });
    const slots: McpRegistrationSlot[] = [];
    for (const image of this.images.values()) if (image.slot && canonical(image.slot.owner) === canonical(checked.input.owner)) {
      assertMcpRegistryImage(scopeMcpRegistryImage(image, null), checked.input.owner, image.slot.name); slots.push(image.slot);
    }
    return structuredClone(listMcpRegistrationImages(slots, checked.input));
  }
  async lookupMcpAuthorizationState(stateSha256: string) {
    sha(stateSha256); let found: { owner: McpRegistrationOwner; name: string; subject: McpCredentialSubject; authorizationId: string } | null = null;
    for (const image of this.images.values()) {
      const p = image.pending.find(p => p.stateSha256 === stateSha256); if (!p) continue; if (found || !image.slot) invalid();
      assertMcpRegistryImage(scopeMcpRegistryImage(image, p.subject), image.slot.owner, image.slot.name);
      if (p.state !== "pending" || p.expiresAtMs <= this.now() || image.slot.state !== "enabled" || image.slot.currentVersionId !== p.configVersionId || p.registrationRevision !== image.slot.revision) return null;
      const access = createMcpRegistryAccess({ principal: p.subject, owner: image.slot.owner, authority: "user_self", access: "runtime" });
      this.gate({ ...assertMcpRegistryAccess(access, image.slot.owner, "runtime"), owner: image.slot.owner });
      const a = image.authorizations.find(a => a.authorizationKey === p.authorizationKey);
      if (!a || a.authorizationEpoch !== p.authorizationEpoch || a.state !== "pending") return null;
      found = { owner: image.slot.owner, name: image.slot.name, subject: p.subject, authorizationId: p.authorizationId };
    }
    return structuredClone(found);
  }
  hasTenantFootprint(tenantId: string): boolean {
    for (const image of this.images.values()) if (image.slot?.owner.tenantId === tenantId || image.authorizations.some(a => a.subject.tenantId === tenantId)) return true;
    return false;
  }
}
