import { describe, expect, it } from "vitest";
import { createAgentServiceClient } from "../src/client.js";
import type { components } from "../src/generated/schema.js";

const root = "sess_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
const turn = "turn_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
const taskId = "sat_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
const approvalId = "apr_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";

describe("generated root-addressed subagent SDK", () => {
  it("uses all six actual typed paths and only the normal same-user runtime credential", async () => {
    const requests: Request[] = [];
    const client = createAgentServiceClient({ baseUrl: "https://agent.example.test", serviceApiKey: "fixture-runtime-api-key", userId: "fixture-user",
      fetch: async request => { requests.push(request); return request.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({}); },
    });
    await client.GET("/v1/sessions/{id}/subagents", { params: { path: { id: root }, query: { rootTurnId: turn } } });
    await client.GET("/v1/sessions/{id}/subagents/{taskId}", { params: { path: { id: root, taskId } } });
    await client.POST("/v1/sessions/{id}/subagents/{taskId}/approvals/{approvalId}", {
      params: { path: { id: root, taskId, approvalId } }, body: { decision: "accept" },
    });
    await client.POST("/v1/sessions/{id}/subagents/{taskId}/tool-results", {
      params: { path: { id: root, taskId } }, body: { toolCallId: "actual-call", content: [{ type: "text", text: "fixture-result" }] },
    });
    await client.POST("/v1/sessions/{id}/subagents/{taskId}/interrupt", { params: { path: { id: root, taskId } }, body: {} });
    await client.DELETE("/v1/sessions/{id}/subagents/{taskId}/session", { params: { path: { id: root, taskId } } });
    expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
      ["GET", `/v1/sessions/${root}/subagents`], ["GET", `/v1/sessions/${root}/subagents/${taskId}`],
      ["POST", `/v1/sessions/${root}/subagents/${taskId}/approvals/${approvalId}`],
      ["POST", `/v1/sessions/${root}/subagents/${taskId}/tool-results`],
      ["POST", `/v1/sessions/${root}/subagents/${taskId}/interrupt`],
      ["DELETE", `/v1/sessions/${root}/subagents/${taskId}/session`],
    ]);
    expect(new URL(requests[0]!.url).searchParams.get("rootTurnId")).toBe(turn);
    expect(await requests[2]!.json()).toEqual({ decision: "accept" });
    expect(await requests[4]!.json()).toEqual({});
    for (const request of requests) {
      expect(request.headers.get("authorization")).toBe("Bearer fixture-runtime-api-key");
      expect(request.headers.get("x-user-id")).toBe("fixture-user");
      expect(request.headers.get("x-agent-service-internal-token")).toBeNull();
      expect(request.url).not.toContain("fixture-runtime-api-key");
    }
  });
  it("does not retry a failed control response or manufacture a replacement child turn", async () => {
    let calls = 0;
    const client = createAgentServiceClient({ baseUrl: "https://agent.example.test", fetch: async () => {
      calls++; return Response.json({ error: { code: "draining", message: "fixed-fixture-message" } }, { status: 503 });
    } });
    const response = await client.POST("/v1/sessions/{id}/subagents/{taskId}/interrupt", { params: { path: { id: root, taskId } }, body: {} });
    expect(response.response.status).toBe(503); expect(calls).toBe(1);
  });
});

// These compile-only checks exercise the generated contract, not a widened handwritten facade.
if (false) {
  // @ts-expect-error Task control cannot select a different tenant.
  const decision: components["schemas"]["SubagentApprovalRequest"] = { decision: "accept", tenantId: "forged" };
  // @ts-expect-error Status does not expose the root fencing token.
  const status: components["schemas"]["SubagentTaskStatusResponse"] = { rootFence: 1 };
  void decision; void status;
}
