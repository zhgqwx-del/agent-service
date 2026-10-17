import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import * as M from "../../src/mcp-registry.js";

export const mcpFixtureConfig: M.McpRegistrationConfig = {
  endpoint: "https://mcp.example.test/tools", description: "Fixture server", protocolVersion: "2025-11-25",
  authentication: { kind: "oauth", issuer: "https://as.example.test", authorizationEndpoint: "https://as.example.test/authorize",
    tokenEndpoint: "https://as.example.test/token", resource: "https://mcp.example.test/tools", clientId: "fixture-client",
    redirectUri: "https://app.example.test/v1/mcp/oauth/callback", scopes: ["read"], clientAuthentication: "none",
    metadataSha256: "a".repeat(64), authorizationResponseIssParameterSupported: true },
};
export const mcpFixtureDigest = (value: string) => createHash("sha256").update(value).digest("hex");
export function mcpFixtureMaterial(aad: M.McpSecretAad, plaintext = "fixture-material"): M.McpEncryptedMaterialAdmission {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", Buffer.alloc(32, 7), iv);
  cipher.setAAD(Buffer.from(JSON.stringify(aad)));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return M.createMcpEncryptedMaterialAdmission({ aad, envelope: { profile: "mcp-aes-256-gcm-v1", keyId: "fixture-key",
    iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") } });
}
export function mcpFixtureAccess(owner: M.McpRegistrationOwner, subject: M.McpCredentialSubject, mode: "manage" | "runtime") {
  return M.createMcpRegistryAccess({ owner, principal: subject, access: mode,
    authority: mode === "runtime" || owner.scope === "user" ? "user_self" : owner.scope === "tenant" ? "tenant_admin" : "platform_operator" });
}
export function mcpFixtureWrite(owner: M.McpRegistrationOwner, subject: M.McpCredentialSubject, expectedRevision = 0, idempotencyKey = "install", config: M.McpRegistrationConfig = mcpFixtureConfig, generation = 1, name = "example"): M.UpsertMcpRegistrationInput {
  const access = mcpFixtureAccess(owner, subject, "manage"), configVersionId = M.mcpRegistrationVersionId(owner, name, expectedRevision, idempotencyKey);
  const basic = config.authentication.kind === "oauth" && config.authentication.clientAuthentication === "client_secret_basic";
  const version: M.McpRegistrationVersion = { configVersionId, configSha256: M.mcpRegistryDigest("mcp-registration-config-v1", config),
    registrationId: M.mcpRegistrationId(owner, name), owner, name, revision: expectedRevision + 1, generation, config,
    clientSecretCommitmentSha256: basic ? mcpFixtureDigest("keyed-test-secret-commitment") : null, createdAtMs: 0 };
  return { access, owner, name, expectedRevision, idempotencyKey, configVersionId,
    admission: M.createMcpRegistrationAdmission(config, version.clientSecretCommitmentSha256),
    clientSecret: basic ? mcpFixtureMaterial(M.mcpSecretAad(version, "as_client", null, 0, configVersionId)) : null };
}
export async function mcpFixtureBegin(store: M.McpRegistryStore, owner: M.McpRegistrationOwner, subject: M.McpCredentialSubject, idempotencyKey = "authorize", name = "example") {
  const access = mcpFixtureAccess(owner, subject, "runtime"), ref = { access, owner, name };
  const view = await store.getMcpAuthorizationContext(ref); if (!view) throw new Error("MCP fixture registration missing");
  const authorizationId = randomUUID(), expectedAuthorizationEpoch = view.authorization?.authorizationEpoch ?? 0;
  const input: M.BeginMcpAuthorizationInput = { ...ref, idempotencyKey, configVersionId: view.registration.configVersionId, authorizationId,
    expectedAuthorizationEpoch, stateSha256: mcpFixtureDigest(randomUUID()), expiresInMs: 60000,
    pkce: mcpFixtureMaterial(M.mcpSecretAad(view.registration, "oauth_state", subject, expectedAuthorizationEpoch + 1, authorizationId, view.slot.revision)) };
  const pending = await store.beginMcpAuthorization(input); return { ref, input, pending, view };
}
export async function mcpFixtureExchange(store: M.McpRegistryStore, owner: M.McpRegistrationOwner, subject: M.McpCredentialSubject, idempotencyKey = "authorize", name = "example") {
  const begun = await mcpFixtureBegin(store, owner, subject, idempotencyKey, name);
  const auth = begun.view.registration.config.authentication; if (auth.kind !== "oauth") throw new Error("MCP fixture OAuth missing");
  const consume: M.ConsumeMcpAuthorizationInput = { ...begun.ref, authorizationId: begun.pending.authorizationId, stateSha256: begun.pending.stateSha256, redirectUri: auth.redirectUri, operationTimeoutMs: 30000 };
  const claim = await store.consumeMcpAuthorization(consume);
  const finish: M.FinishMcpCredentialOperationInput = { ...begun.ref, operationId: claim.operation.operationId, claimToken: claim.claimToken,
    result: { kind: "success", material: mcpFixtureMaterial(claim.resultAad), scopes: ["read"], expiresInMs: 3600000 } };
  const authorization = await store.finishMcpCredentialOperation(finish); return { ...begun, consume, claim, finish, authorization };
}
