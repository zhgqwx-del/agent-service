import { describe, expect, it } from "vitest";
import { AgentServiceHttpError, upsertTenantHook, listTenantHooks, getTenantHook,
  setTenantHookState, deleteTenantHook, listTenantHookDeliveries } from "../src/client.js";

describe("tenant administrator observer SDK", () => {
  it("uses only the tenant admin surface with exact CAS/idempotency and no implicit user identity", async () => {
    const requests: Request[] = [];
    const options = { baseUrl: "https://agent.example.test", serviceApiKey: "fixture-admin-private", fetch: (async (input, init) => {
      requests.push(new Request(input, init)); return Response.json({});
    }) as typeof fetch };
    const config = { endpoint: "https://observer.example.test/receive", phase: "postToolUse" as const, bodyScopes: ["tool_result" as const] };
    await upsertTenantHook(options, { name: "audit", expectedRevision: 0, config, signingKey: "a6".repeat(32), disclosureAck: "tenant-admin-body-disclosure-v1" }, "create-audit");
    await listTenantHooks(options, { cursor: "a".repeat(64), limit: 2 });
    await getTenantHook(options, "audit");
    await setTenantHookState(options, "audit", { state: "disabled", expectedRevision: 1 }, "disable-audit");
    await deleteTenantHook(options, "audit", { expectedRevision: 2 }, "delete-audit");
    await listTenantHookDeliveries(options, "audit", { limit: 3 });
    expect(requests.map(r => [r.method, new URL(r.url).pathname, r.headers.get("idempotency-key")])).toEqual([
      ["POST", "/v1/tenant-hooks", "create-audit"], ["GET", "/v1/tenant-hooks", null], ["GET", "/v1/tenant-hooks/audit", null],
      ["POST", "/v1/tenant-hooks/audit/state", "disable-audit"], ["DELETE", "/v1/tenant-hooks/audit", "delete-audit"],
      ["GET", "/v1/tenant-hooks/audit/deliveries", null],
    ]);
    expect(await requests[0]!.json()).toEqual({ name: "audit", expectedRevision: 0, config, signingKey: "a6".repeat(32), disclosureAck: "tenant-admin-body-disclosure-v1" });
    expect(await requests[3]!.json()).toEqual({ state: "disabled", expectedRevision: 1 });
    for (const request of requests) {
      expect(request.headers.get("authorization")).toBe("Bearer fixture-admin-private");
      expect(request.headers.get("x-user-id")).toBeNull(); expect(request.url).not.toContain("fixture-admin-private");
      expect(request.url).not.toContain("a6".repeat(32));
    }
  });
  it("does not retry a response-loss status or turn remote body into the SDK error message", async () => {
    let calls = 0;
    const options = { baseUrl: "https://agent.example.test", fetch: (async () => {
      calls++; return Response.json({ error: { message: "fixture-private-canary" } }, { status: 503 });
    }) as typeof fetch };
    await expect(listTenantHookDeliveries(options, "audit")).rejects.toBeInstanceOf(AgentServiceHttpError);
    expect(calls).toBe(1);
    try { await getTenantHook(options, "audit"); } catch (error) {
      expect((error as Error).message).toBe("agent-service request failed with HTTP 503");
    }
    expect(calls).toBe(2);
  });
});
