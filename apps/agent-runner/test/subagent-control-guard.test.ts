import { afterEach, describe, expect, it, vi } from "vitest";
import { INTERNAL_ROUTER_TOKEN_HEADER, INTERNAL_TOMBSTONE_ACK_HEADER,
  INTERNAL_SUBAGENT_TOMBSTONE_ACK_VALUE } from "@agent-service/protocol";
import { StaticToolRegistry, createSubagentTaskDescriptor, type SessionHost, type SubagentControlService } from "@agent-service/core";
import { MemorySessionStore } from "@agent-service/store";
import type { ProviderService } from "@agent-service/providers";
import { createApp } from "../src/app.js";
import { hashApiKey } from "../src/auth.js";

const token = "fixture-subagent-delete-private-token";
const root = "sess_00000000-0000-7000-8000-000000000001", taskId = "sat_00000000-0000-7000-8000-000000000002";
const path = `/v1/sessions/${root}/subagents/${taskId}/session`;
const stores: MemorySessionStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); });
async function fixture(enabled = true) {
  const store = new MemorySessionStore(); stores.push(store);
  await store.createApiKey("fixture-tenant", "fixture-api", hashApiKey("fixture-api-key"), ["runtime"]);
  const remove = vi.fn(async () => {});
  const forbidden = async (): Promise<never> => { throw new Error("unexpected control method"); };
  const controls: SubagentControlService = { deleteDelegatedSession: remove, listDelegatedTasks: forbidden,
    getDelegatedTask: forbidden, resolveDelegatedApproval: forbidden, submitDelegatedToolResult: forbidden, interruptDelegatedTask: forbidden };
  const app = createApp({ store, host: {} as SessionHost, providers: {} as ProviderService, tools: new StaticToolRegistry(),
    subagentsEnabled: enabled, subagentControls: controls, runnerId: "fixture-runner", internalRouterToken: token,
    ready: () => true, heartbeatMs: 1000, maxBodyBytes: 1000, decryptSecret: async () => "unused", encryptSecret: async () => ({ ciphertext: Buffer.alloc(0), keyId: "unused" }) });
  const request = (internalToken?: string, apiKey = "fixture-api-key", method = "DELETE") => app.request(path, { method, headers: {
    authorization: `Bearer ${apiKey}`, "x-user-id": "actual-owner", ...(internalToken === undefined ? {} : { [INTERNAL_ROUTER_TOKEN_HEADER]: internalToken }),
  } });
  return { request, remove, app };
}

// Real source-app middleware assembly; service spy proves admission only, not actual tombstone SQL.
describe("source-app delegated child tombstone admission", () => {
  it("requires independent private router authority even with a valid user key and enabled subagents", async () => {
    const f = await fixture();
    for (const value of [undefined, "wrong-token", `${token}, ${token}`]) {
      const response = await f.request(value); expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store"); expect(f.remove).not.toHaveBeenCalled();
    }
  });
  it("still requires real API authentication after the private code-awareness acknowledgement", async () => {
    const f = await fixture(), response = await f.request(token, "wrong-api-key");
    expect(response.status).toBe(401); expect(response.headers.get("cache-control")).toBe("no-store"); expect(f.remove).not.toHaveBeenCalled();
  });
  it("passes only the actual principal and root/task mapping after both gates", async () => {
    const f = await fixture(), response = await f.request(token);
    expect(response.status).toBe(204); expect(response.headers.get(INTERNAL_TOMBSTONE_ACK_HEADER)).toBe(INTERNAL_SUBAGENT_TOMBSTONE_ACK_VALUE);
    expect(f.remove.mock.calls).toEqual([[{ tenantId: "fixture-tenant", userId: "actual-owner" }, root, taskId]]);
  });
  it("does not let private authority substitute for a disabled subagent service or an unsupported method", async () => {
    const off = await fixture(false); expect((await off.request(token)).status).toBe(503); expect(off.remove).not.toHaveBeenCalled();
    const f = await fixture(); expect((await f.request(token, "fixture-api-key", "GET")).status).toBe(404); expect(f.remove).not.toHaveBeenCalled();
  });
  it("discovers the same closed task schema without an executor or per-agent authority", async () => {
    const f = await fixture(), response = await f.app.request("/v1/tools", { headers: { authorization: "Bearer fixture-api-key", "x-user-id": "actual-owner" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [createSubagentTaskDescriptor()] });
    expect(f.remove).not.toHaveBeenCalled();
    const first = createSubagentTaskDescriptor(); first.parameters.injected = true;
    expect(createSubagentTaskDescriptor().parameters).not.toHaveProperty("injected");
  });
  it("does not advertise a disabled task runtime", async () => {
    const f = await fixture(false), response = await f.app.request("/v1/tools", { headers: { authorization: "Bearer fixture-api-key", "x-user-id": "actual-owner" } });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ data: [] });
  });
});
