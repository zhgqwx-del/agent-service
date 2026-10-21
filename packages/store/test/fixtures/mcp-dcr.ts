import * as M from "../../src/mcp-registry.js";
import { mcpFixtureConfig, mcpFixtureDigest, mcpFixtureMaterial, mcpFixtureWrite } from "./mcp-registry.js";

export function mcpDcrConfig(authentication: "none" | "client_secret_basic" = "none"): M.McpRegistrationConfig {
  const old = mcpFixtureConfig.authentication; if (old.kind !== "oauth") throw new Error("DCR fixture base is invalid");
  const { clientId: _clientId, kind: _kind, ...rest } = old;
  return { ...mcpFixtureConfig, authentication: { ...rest, kind: "oauth_dynamic", registrationEndpoint: "https://as.example.test/register", clientAuthentication: authentication } };
}
export function mcpDcrWrite(owner: M.McpRegistrationOwner, subject: M.McpCredentialSubject, expectedRevision = 0, idempotencyKey = "install", authentication: "none" | "client_secret_basic" = "none", generation = 1, name = "example") {
  return mcpFixtureWrite(owner, subject, expectedRevision, idempotencyKey, mcpDcrConfig(authentication), generation, name);
}
export function mcpDcrSuccess(claim: M.McpDynamicClientClaim, clientId = "dynamic-fixture-client", expiresAtMs: number | null = null): M.FinishMcpDynamicClientInput["result"] {
  const auth = claim.registration.config.authentication;
  if (auth.kind !== "oauth_dynamic") throw new Error("DCR fixture requires immutable intent");
  const basic = auth.clientAuthentication === "client_secret_basic";
  return { kind: "success", clientId, responseSha256: mcpFixtureDigest(`closed-response:${clientId}`),
    clientSecretCommitmentSha256: basic ? mcpFixtureDigest(`dynamic-secret:${clientId}`) : null,
    clientSecretExpiresAtMs: basic ? expiresAtMs : null,
    clientSecret: basic ? mcpFixtureMaterial(M.mcpDynamicClientSecretAad(claim.registration, claim.operation, clientId)) : null };
}
export async function mcpDcrReady(store: M.McpRegistryStore, input: M.UpsertMcpRegistrationInput, expiresAtMs: number | null = null) {
  const view = await store.upsertMcpRegistration(input), ref = { access: input.access, owner: input.owner, name: input.name };
  const prepare = { ...ref, configVersionId: view.version.configVersionId, expectedRevision: view.slot.revision, idempotencyKey: "register", operationTimeoutMs: 30000 };
  const claim = await store.prepareMcpDynamicClient(prepare); if (!claim.claimToken) throw new Error("DCR fixture requires the single new claim");
  const operationRef = { ...ref, operationId: claim.operation.operationId, claimToken: claim.claimToken };
  await store.markMcpDynamicClientSending(operationRef);
  const result = mcpDcrSuccess(claim, "dynamic-fixture-client", expiresAtMs), operation = await store.finishMcpDynamicClient({ ...operationRef, result });
  return { view, ref, prepare, claim, operationRef, result, operation };
}
