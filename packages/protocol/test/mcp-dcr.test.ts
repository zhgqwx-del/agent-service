import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { McpRegistrationConfigRequest, McpRegistrationConfigResponse, McpDynamicClientRegistrationRequest,
  PlatformMcpDynamicClientRegistrationRequest, McpDynamicClientStatusQuery, McpDynamicClientStatusResponse } from "../src/mcp.js";

const config = { endpoint: "https://resource.example/mcp", description: "Dynamic fixture", protocolVersion: "2026-07-28",
  authentication: { kind: "oauth_dynamic", issuer: "https://issuer.example", clientAuthentication: "none", scopes: ["echo"] } };
describe("MCP explicit dynamic client contract", () => {
  it.each(["none", "client_secret_basic"])("accepts an immutable %s intent without pre-existing client material", clientAuthentication => {
    const input = { ...config, authentication: { ...config.authentication, clientAuthentication } };
    expect(McpRegistrationConfigRequest.parse(input)).toEqual(input);
    expect(McpRegistrationConfigResponse.parse(input)).toEqual(input);
  });
  it.each(["clientId", "clientSecret", "initialAccessToken", "registrationEndpoint", "redirectUri", "owner", "registrationAccessToken"])("rejects caller-supplied %s on a dynamic intent", field => {
    expect(McpRegistrationConfigRequest.safeParse({ ...config, authentication: { ...config.authentication, [field]: "forbidden" } }).success).toBe(false);
  });
  it("requires exact version/revision and keeps platform authority out of ordinary registration bodies", () => {
    const input = { scope: "tenant", configVersionId: randomUUID(), expectedRevision: 1 };
    expect(McpDynamicClientRegistrationRequest.parse(input)).toEqual(input);
    expect(McpDynamicClientRegistrationRequest.safeParse({ ...input, scope: "platform" }).success).toBe(false);
    expect(McpDynamicClientRegistrationRequest.safeParse({ ...input, expectedRevision: -1 }).success).toBe(false);
    expect(McpDynamicClientRegistrationRequest.safeParse({ ...input, configVersionId: "latest" }).success).toBe(false);
    expect(McpDynamicClientRegistrationRequest.safeParse({ ...input, registrationEndpoint: "https://elsewhere.example/" }).success).toBe(false);
    expect(PlatformMcpDynamicClientRegistrationRequest.parse({ configVersionId: input.configVersionId, expectedRevision: 1 })).toEqual({ configVersionId: input.configVersionId, expectedRevision: 1 });
    expect(PlatformMcpDynamicClientRegistrationRequest.safeParse(input).success).toBe(false);
    expect(McpDynamicClientStatusQuery.parse({ scope: "user", configVersionId: input.configVersionId })).toEqual({ scope: "user", configVersionId: input.configVersionId });
  });
  it.each(["unregistered", "prepared", "sending", "ready", "failed_not_dispatched", "outcome_unknown"])("exposes only the closed content-free %s projection", state => {
    const value = { scope: "tenant", name: "echo", configVersionId: randomUUID(), registration: {
      state, operationId: state === "unregistered" ? null : randomUUID(), createdAtMs: null, deadlineAtMs: null, completedAtMs: null,
      manualReviewRequired: state === "outcome_unknown", remoteRevocationSupported: false,
    } };
    expect(McpDynamicClientStatusResponse.parse(value)).toEqual(value);
    for (const field of ["clientId", "clientSecret", "registrationUri", "registrationAccessToken", "responseBody"]) {
      expect(McpDynamicClientStatusResponse.safeParse({ ...value, registration: { ...value.registration, [field]: "forbidden" } }).success).toBe(false);
    }
    expect(McpDynamicClientStatusResponse.safeParse({ ...value, registration: { ...value.registration, remoteRevocationSupported: true } }).success).toBe(false);
  });
});
