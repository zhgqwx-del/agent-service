import { describe, expect, it } from "vitest";
import {
  AgentServiceHttpError, createAgentServiceMcpRegistryOperatorClient, upsertMcpRegistration, listMcpRegistrations,
  getMcpRegistration, setMcpRegistrationState, deleteMcpRegistration, discoverMcpTools, refreshMcpCatalog,
  beginMcpAuthorization, getMcpAuthorization, disconnectMcpAuthorization,
} from "../src/client.js";

describe("managed MCP SDK", () => {
  const config = { endpoint: "https://mcp.example.test/", description: "MCP", protocolVersion: "2026-07-28" as const,
    authentication: { kind: "none" as const } };
  function fixture() {
    const requests: Request[] = [];
    const options = { baseUrl: "https://agent.example.test", serviceApiKey: "fixture-private-runtime", userId: "alice",
      fetch: (async (input, init) => { requests.push(new Request(input, init)); return Response.json({}); }) as typeof fetch };
    return { requests, options };
  }
  it("preserves exact mutation CAS/idempotency and keeps runtime credentials in headers", async () => {
    const f = fixture();
    await upsertMcpRegistration(f.options, { scope: "user", name: "review", expectedRevision: 0, config }, "register");
    await setMcpRegistrationState(f.options, "review", { scope: "user", state: "disabled", expectedRevision: 1 }, "disable");
    await deleteMcpRegistration(f.options, "review", { scope: "user", expectedRevision: 2 }, "delete");
    expect(f.requests.map(r => [r.method, new URL(r.url).pathname, r.headers.get("idempotency-key")])).toEqual([
      ["POST", "/v1/mcp-servers", "register"], ["POST", "/v1/mcp-servers/review/state", "disable"], ["DELETE", "/v1/mcp-servers/review", "delete"],
    ]);
    expect(await f.requests[0]!.json()).toEqual({ scope: "user", name: "review", expectedRevision: 0, config });
    expect(await f.requests[1]!.json()).toEqual({ scope: "user", state: "disabled", expectedRevision: 1 });
    for (const request of f.requests) {
      expect(request.headers.get("authorization")).toBe("Bearer fixture-private-runtime");
      expect(request.headers.get("x-user-id")).toBe("alice"); expect(request.url).not.toContain("fixture-private-runtime");
    }
  });
  it("uses explicit owner scopes and keeps OAuth subject selection out of all request bodies", async () => {
    const f = fixture();
    await listMcpRegistrations(f.options, { scope: "user", limit: 2, cursor: "a".repeat(64) });
    await getMcpRegistration(f.options, "review", "tenant");
    await discoverMcpTools(f.options, "review", "platform");
    await refreshMcpCatalog(f.options, "review", "user");
    await beginMcpAuthorization(f.options, "review", "tenant", "begin-one");
    await getMcpAuthorization(f.options, "review", "tenant");
    await disconnectMcpAuthorization(f.options, "review", "tenant", 3, "disconnect-one");
    expect(f.requests.map(r => new URL(r.url).pathname)).toEqual(["/v1/mcp-servers", "/v1/mcp-servers/review", "/v1/mcp-servers/review/tools",
      "/v1/mcp-servers/review/refresh", "/v1/mcp-servers/review/oauth/begin", "/v1/mcp-servers/review/oauth/status", "/v1/mcp-servers/review/oauth/disconnect"]);
    expect(Object.fromEntries(new URL(f.requests[0]!.url).searchParams)).toEqual({ scope: "user", limit: "2", cursor: "a".repeat(64) });
    expect(await f.requests[3]!.json()).toEqual({ scope: "user" });
    expect(await f.requests[4]!.json()).toEqual({ scope: "tenant" });
    expect(await f.requests[6]!.json()).toEqual({ scope: "tenant", expectedAuthorizationEpoch: 3 });
    expect(f.requests[3]!.headers.get("idempotency-key")).toBeNull();
    expect(f.requests[4]!.headers.get("idempotency-key")).toBe("begin-one");
  });
  it("isolates the independent platform MCP credential on its narrow path-typed client", async () => {
    let request: Request | undefined;
    const token = "fixture-mcp-registry-operator-token-001";
    const client = createAgentServiceMcpRegistryOperatorClient({ baseUrl: "https://agent.example.test", mcpRegistryOperatorToken: token,
      fetch: async input => { request = input; return Response.json({ data: [], nextCursor: null }); } });
    await client.GET("/v1/platform/mcp-servers");
    expect(request!.url).toBe("https://agent.example.test/v1/platform/mcp-servers");
    expect(request!.headers.get("authorization")).toBe(`Bearer ${token}`); expect(request!.headers.get("x-user-id")).toBeNull();
    expect(() => createAgentServiceMcpRegistryOperatorClient({ baseUrl: "https://agent.example.test", mcpRegistryOperatorToken: "short" })).toThrow(TypeError);
  });
  it("does not retry unknown credential/catalog outcomes and keeps raw remote errors out of SDK messages", async () => {
    let calls = 0;
    const options = { baseUrl: "https://agent.example.test", fetch: (async () => {
      calls++; return Response.json({ error: { code: "state_conflict", message: "fixture-private-upstream-body" } }, { status: 409 });
    }) as typeof fetch };
    try { await refreshMcpCatalog(options, "review", "user"); throw new Error("expected HTTP failure"); }
    catch (error) { expect(error).toBeInstanceOf(AgentServiceHttpError); expect((error as Error).message).toBe("agent-service request failed with HTTP 409"); }
    expect(calls).toBe(1);
  });
});
