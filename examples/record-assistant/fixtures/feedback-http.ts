import type { AgentServiceClient } from "../../../packages/sdk/src/index.js";
import type { FeedbackRuntime } from "./feedback.js";

export function createRouterFeedbackRuntime(client: AgentServiceClient, owner: { tenantId: string; ownerId: string }): FeedbackRuntime {
  const boundOwner = { ...owner };
  const checkOwner = (caller: typeof owner) => {
    if (caller.tenantId !== boundOwner.tenantId || caller.ownerId !== boundOwner.ownerId) throw new Error("Fixture owner mismatch");
  };
  return {
    async submit(caller, id, input, key) {
      checkOwner(caller);
      const params = { path: { id }, query: { limit: 1 } };
      const history = await client.GET("/v1/sessions/{id}/items", { params });
      if (!history.data || history.data.data.length) throw new Error("Feedback requires an empty session");
      const result = await client.POST("/v1/sessions/{id}/turns", {
        params: { path: { id }, header: { "idempotency-key": key } },
        body: { input: [{ type: "text", text: input }], metadata: { diandiFeedbackKey: key }, busyPolicy: "reject", stream: false },
      });
      if (result.response.status !== 202 || !result.data || typeof result.data !== "object"
        || result.data.turn.sessionId !== id || result.data.turn.metadata?.diandiFeedbackKey !== key) {
        throw new Error("Feedback HTTP dispatch was not confirmed");
      }
      const { turn } = result.data;
      return {
        turnId: turn.id,
        async cancel() {
          await client.POST("/v1/sessions/{id}/turns/{turnId}/interrupt", { params: { path: { id, turnId: turn.id } } });
        },
      };
    },
    async findSubmittedTurn(caller, id, key) {
      checkOwner(caller);
      const { data } = await client.GET("/v1/sessions/{id}/turns", {
        params: { path: { id }, query: { limit: 2 } },
      });
      // Each feedback uses its own session. A partial or ambiguous list proves no binding.
      if (data?.data.length !== 1 || data.nextCursor !== null) return null;
      const turn = data.data[0]!;
      return turn.sessionId === id && turn.metadata?.diandiFeedbackKey === key ? turn.id : null;
    },
    async observe(caller, id, turnId) {
      checkOwner(caller);
      const result = await client.GET("/v1/sessions/{id}/turns/{turnId}", { params: { path: { id, turnId } } });
      const turn = result.data;
      if (!turn || turn.id !== turnId || turn.sessionId !== id || turn.status === "inProgress") return { status: "pending" };
      if (turn.status !== "completed" || turn.stopReason !== "end_turn") return { status: "failed" };
      const items = await client.GET("/v1/sessions/{id}/items", { params: { path: { id }, query: { turnId, limit: 200 } } });
      const final = items.data?.data.findLast(item => item.type === "agentMessage" && item.status === "completed"
        && item.phase === "finalAnswer" && item.sessionId === id && item.turnId === turnId && item.text.trim());
      return final?.type === "agentMessage"
        ? { status: "completed", itemId: final.id, text: final.text }
        : { status: "pending" };
    },
  };
}
