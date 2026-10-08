import { afterEach, describe, expect, it, vi } from "vitest";
import { ErasureLocalTurnFencedError, SessionHost, StaticToolRegistry, builtinTools, newId, type AgentEngine, type EngineRun, type EngineSink, type EngineTurnParams, type ResolvedModel } from "@agent-service/core";
import {
  MemoryEventBus,
  MemoryLeaseStore,
  MemorySessionStore,
  newErasureRequestId,
  userErasureRequestHash,
  validateErasureRequestRecord,
  type ErasureJobClaim,
} from "@agent-service/store";
import {
  ApiError,
  INTERNAL_ERASURE_DRAIN_ACK_HEADER,
  INTERNAL_ERASURE_DRAIN_ACK_VALUE,
  INTERNAL_ERASURE_DRAIN_LOCAL_FENCED_HEADER,
  INTERNAL_ERASURE_DRAIN_LOCAL_FENCED_VALUE,
  INTERNAL_ERASURE_DRAIN_RUNNER_PATH_PREFIX,
  INTERNAL_TOMBSTONE_ACK_HEADER,
  INTERNAL_TOMBSTONE_ACK_VALUE,
  INTERNAL_TOMBSTONE_PATH_PREFIX,
  INTERNAL_ROUTER_TOKEN_HEADER,
  emptyUsage,
  type UserErasureDrainRequest,
} from "@agent-service/protocol";
import { LocalAesGcmCipher, ProviderService } from "@agent-service/providers";
import { createApp } from "../src/app.js";
import { hashApiKey } from "../src/auth.js";

/** typed json read: the suite used to be full of `unknown`, which hid drift from the real API */
const j = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const INTERNAL_ROUTER_TOKEN = "runner-test-internal-token-000001";

/** Echo engine: replies with the user's text; calls `current_time` when asked for time. */
class EchoEngine implements AgentEngine {
  readonly name = "echo";
  start(params: EngineTurnParams, sink: EngineSink): EngineRun {
    const text = params.input.map((p) => (p.type === "text" ? p.text : "")).join("");
    const done = (async () => {
      await sink.onStepStart(1);
      const wantsTime = /time/i.test(text);
      const toolCalls = wantsTime ? [{ id: "call_1", name: "current_time", args: {} }] : [];
      for (const ch of `echo: ${text}`.split(" ")) sink.onTextDelta(ch + " ");
      // This deterministic fake is explicitly known-free; production providers omit costCNY when
      // pricing is unknown, which the host treats fail-closed under maxCostCNY.
      const msg = { text: `echo: ${text} `, toolCalls, usage: { ...emptyUsage(), inputTokens: 3, outputTokens: 2, totalTokens: 5, costCNY: 0 }, stopReason: toolCalls.length ? ("toolUse" as const) : ("stop" as const), provider: "fake", model: "fake" };
      await sink.onAssistantMessage(msg);
      for (const tc of toolCalls) {
        const d = await sink.beforeToolCall(tc, msg);
        if (!d.allow) continue;
        await sink.onToolExecutionStart(tc.id);
        const r = await params.tools.find((t) => t.name === tc.name)!.execute(tc.args, { ...params.toolContext, toolCallId: tc.id, signal: params.signal });
        await sink.onToolResult({ toolCallId: tc.id, name: tc.name, content: r.content, isError: !!r.isError });
      }
      if (toolCalls.length) {
        await sink.onStepEnd(1, msg);
        await sink.onStepStart(2);
        sink.onTextDelta("the time is above");
        await sink.onAssistantMessage({ ...msg, text: "the time is above", toolCalls: [] });
        await sink.onStepEnd(2, { ...msg, toolCalls: [] });
      } else await sink.onStepEnd(1, msg);
      return { steps: toolCalls.length ? 2 : 1, aborted: false };
    })();
    return { steer: () => {}, interrupt: () => {}, done };
  }
}

const hosts: SessionHost[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const h of hosts.splice(0)) await h.drain(1_000).catch(() => {});
});

async function makeApp(
  heartbeatMs = 60_000,
  lifecycle: { enabled?: boolean; attachStore?: boolean } = {},
) {
  const store = new MemorySessionStore();
  await store.createApiKey("t_dev", "k1", hashApiKey("dev-key"), ["runtime", "admin"]);
  const providers = new ProviderService({
    store,
    cipher: new LocalAesGcmCipher("33".repeat(32)),
    platform: [ProviderService.preset("dashscope", "x")],
    assertBaseUrl: async () => {},
  });
  const fake: ResolvedModel = { handle: {}, provider: "fake", model: "fake", contextWindow: 1000, input: ["text"], apiKey: async () => "k" };
  const tools = new StaticToolRegistry(builtinTools);
  const host = new SessionHost({ store, lease: new MemoryLeaseStore(), bus: new MemoryEventBus(), engine: new EchoEngine(), providers: { resolve: async () => fake }, tools, config: { runnerId: "r", runnerAddr: "x", leaseHoldMs: 10 } });
  const cipher = new LocalAesGcmCipher("33".repeat(32));
  const app = createApp({
    store, host, providers, tools, runnerId: "r", internalRouterToken: INTERNAL_ROUTER_TOKEN,
    heartbeatMs, maxBodyBytes: 1_000_000, ready: () => true,
    erasureRequestsEnabled: lifecycle.enabled,
    subjectLifecycle: lifecycle.attachStore ? store : undefined,
    decryptSecret: (s) => cipher.decrypt(s.ciphertext, s.keyId),
    encryptSecret: async (p) => ({ ciphertext: await cipher.encrypt(p), keyId: cipher.keyId }),
    assertPublicUrl: async () => {},
  });
  hosts.push(host);
  const H = { authorization: "Bearer dev-key", "x-user-id": "u_1", "content-type": "application/json" };
  const call = (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { ...H, ...(init.headers as Record<string, string> | undefined) } });
  return { app, store, host, call, H };
}

function erasureJobAuthorization(claim: ErasureJobClaim) {
  return {
    tenantId: claim.tenantId,
    subjectKind: claim.subjectKind,
    subjectId: claim.subjectId,
    requestId: claim.requestId,
    subjectGeneration: claim.subjectGeneration,
    claimToken: claim.claimToken,
    claimAttempt: claim.attempts,
  };
}

function erasureDrainBody(claim: ErasureJobClaim): UserErasureDrainRequest {
  if (claim.subjectKind !== "user") throw new Error("test requires a user erasure claim");
  return {
    tenantId: claim.tenantId,
    userId: claim.subjectId,
    requestId: claim.requestId,
    subjectGeneration: claim.subjectGeneration,
    claimToken: claim.claimToken,
    claimAttempt: claim.attempts,
  };
}

async function claimErasurePhase(
  store: MemorySessionStore,
  userId: string,
  target: "gated" | "draining" | "tombstoning" | "reconciling_usage",
): Promise<ErasureJobClaim> {
  let nowMs = Date.now();
  const requestId = newErasureRequestId();
  await store.requestUserErasure({
    requestId,
    tenantId: "t_dev",
    userId,
    requestedByKeyId: "runner-http-test",
    idempotencyKey: requestId,
    requestHash: userErasureRequestHash("t_dev", userId),
    atMs: nowMs,
  });
  let claim = (await store.claimErasureJobs({
    nowMs,
    limit: 1,
    leaseMs: 120_000,
    claimToken: "runner-http-gated",
  }))[0]!;
  if (target === "gated") return claim;

  const advance = async (
    fromStatus: "gated" | "draining" | "tombstoning",
    toStatus: "draining" | "tombstoning" | "reconciling_usage",
  ) => {
    nowMs += 1;
    expect(await store.transitionErasureJob(erasureJobAuthorization(claim), {
      fromStatus,
      toStatus,
      atMs: nowMs,
      availableAtMs: nowMs,
    })).toBe(true);
    claim = (await store.claimErasureJobs({
      nowMs,
      limit: 1,
      leaseMs: 120_000,
      claimToken: `runner-http-${toStatus}`,
    }))[0]!;
  };

  await advance("gated", "draining");
  if (target === "draining") return claim;
  await advance("draining", "tombstoning");
  if (target === "tombstoning") return claim;
  await advance("tombstoning", "reconciling_usage");
  return claim;
}

function callInternalErasureDrain(
  app: Awaited<ReturnType<typeof makeApp>>["app"],
  sessionId: string,
  body: unknown,
  token = INTERNAL_ROUTER_TOKEN,
) {
  return app.request(`${INTERNAL_ERASURE_DRAIN_RUNNER_PATH_PREFIX}/${sessionId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [INTERNAL_ROUTER_TOKEN_HEADER]: token,
    },
    body: JSON.stringify(body),
  });
}

const parseSse = (text: string) =>
  text
    .split("\n\n")
    .filter((b) => b.includes("data:"))
    .map((b) => {
      const id = /^id: (.*)$/m.exec(b)?.[1];
      const data = JSON.parse(/^data: (.*)$/m.exec(b)![1]!);
      return { id, ...data };
    });

function expectPrivateLifecycleResponse(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

describe("agent-runner HTTP API", () => {
  it("advertises tombstone support without claiming physical purge", async () => {
    const { app } = await makeApp();
    const response = await app.request("/v1/capabilities");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      protocolVersion: "2026-10-08",
      service: "agent-runner",
      features: {
        sessionLifecycle: ["archive", "unarchive", "tombstone"],
        dataErasureRequests: false,
        erasureJobControl: [],
      },
    });
  });

  it("advertises erasure requests only when both the deployment gate and store boundary are present", async () => {
    const gateOnly = await makeApp(60_000, { enabled: true });
    const storeOnly = await makeApp(60_000, { attachStore: true });
    const enabled = await makeApp(60_000, { enabled: true, attachStore: true });

    expect(await (await gateOnly.app.request("/v1/capabilities")).json()).toMatchObject({
      features: { dataErasureRequests: false, userErasureWorker: [], erasureJobControl: [] },
    });
    // Closing admission must not strand an already-durable erasure job.
    expect(await (await storeOnly.app.request("/v1/capabilities")).json()).toMatchObject({
      features: {
        dataErasureRequests: false,
        userErasureWorker: ["drain-v1"],
        erasureJobControl: ["quarantine-v1"],
      },
    });
    expect(await (await enabled.app.request("/v1/capabilities")).json()).toMatchObject({
      features: {
        dataErasureRequests: true,
        userErasureWorker: ["drain-v1"],
        erasureJobControl: ["quarantine-v1"],
      },
    });
  });

  it("authenticates internal erasure drain before id and body parsing", async () => {
    const { app, store } = await makeApp(60_000, { attachStore: true });
    const lookup = vi.spyOn(store, "getUserErasureRequest");
    const untrusted = await app.request(
      `${INTERNAL_ERASURE_DRAIN_RUNNER_PATH_PREFIX}/not-a-session`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `{${"x".repeat(4_096)}`,
      },
    );
    expect(untrusted.status).toBe(404);
    expect(await untrusted.json()).toMatchObject({ error: { code: "not_found" } });
    expectPrivateLifecycleResponse(untrusted);
    expect(lookup).not.toHaveBeenCalled();

    const wrongToken = await app.request(
      `${INTERNAL_ERASURE_DRAIN_RUNNER_PATH_PREFIX}/${newId("sess")}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [INTERNAL_ROUTER_TOKEN_HEADER]: "wrong-token",
        },
        body: `{${"x".repeat(4_096)}`,
      },
    );
    expect(wrongToken.status).toBe(404);
    expectPrivateLifecycleResponse(wrongToken);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("strictly validates the small claim-only erasure drain body and rejects stale or wrong-phase claims", async () => {
    const draining = await makeApp(60_000, { attachStore: true });
    const claim = await claimErasurePhase(draining.store, "u_1", "draining");
    const sessionId = newId("sess");
    const body = erasureDrainBody(claim);
    const drain = vi.spyOn(draining.host, "drainSessionForErasure").mockResolvedValue();

    const extraField = await callInternalErasureDrain(draining.app, sessionId, {
      ...body,
      phase: "draining",
    });
    expect(extraField.status).toBe(400);
    expectPrivateLifecycleResponse(extraField);
    expect(drain).not.toHaveBeenCalled();

    const oversized = await callInternalErasureDrain(draining.app, sessionId, {
      ...body,
      content: "x".repeat(4_096),
    });
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toMatchObject({
      error: { message: "request body exceeds 2048 bytes" },
    });
    expectPrivateLifecycleResponse(oversized);
    expect(drain).not.toHaveBeenCalled();

    const stale = await callInternalErasureDrain(draining.app, sessionId, {
      ...body,
      claimAttempt: body.claimAttempt + 1,
    });
    expect(stale.status).toBe(404);
    expectPrivateLifecycleResponse(stale);
    expect(stale.headers.get(INTERNAL_ERASURE_DRAIN_ACK_HEADER)).toBeNull();
    expect(drain).not.toHaveBeenCalled();

    const wrongPhase = await makeApp(60_000, { attachStore: true });
    const reconciling = await claimErasurePhase(wrongPhase.store, "u_phase", "reconciling_usage");
    const unsupported = await callInternalErasureDrain(
      wrongPhase.app,
      sessionId,
      erasureDrainBody(reconciling),
    );
    expect(unsupported.status).toBe(404);
    expectPrivateLifecycleResponse(unsupported);
    expect(unsupported.headers.get(INTERNAL_ERASURE_DRAIN_ACK_HEADER)).toBeNull();
  });

  it("dispatches durable draining and tombstoning phases and acknowledges success and routing conflicts", async () => {
    const draining = await makeApp(60_000, { attachStore: true });
    const drainClaim = await claimErasurePhase(draining.store, "u_drain", "draining");
    const drainBody = erasureDrainBody(drainClaim);
    const drainSessionId = newId("sess");
    const drain = vi.spyOn(draining.host, "drainSessionForErasure").mockResolvedValue();
    const erase = vi.spyOn(draining.host, "eraseSessionForErasure").mockResolvedValue();
    const drained = await callInternalErasureDrain(draining.app, drainSessionId, drainBody);
    expect(drained.status).toBe(204);
    expect(drained.headers.get(INTERNAL_ERASURE_DRAIN_ACK_HEADER)).toBe(INTERNAL_ERASURE_DRAIN_ACK_VALUE);
    expectPrivateLifecycleResponse(drained);
    expect(drain).toHaveBeenCalledWith(drainBody, drainSessionId);
    expect(erase).not.toHaveBeenCalled();

    drain.mockRejectedValueOnce(new ApiError(
      "session_lease_conflict",
      "session owned by another runner",
      { ownerAddr: "http://owner.internal" },
    ));
    const conflict = await callInternalErasureDrain(draining.app, drainSessionId, drainBody);
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get(INTERNAL_ERASURE_DRAIN_ACK_HEADER)).toBe(INTERNAL_ERASURE_DRAIN_ACK_VALUE);
    expect(conflict.headers.get("x-owner")).toBe("http://owner.internal");
    expectPrivateLifecycleResponse(conflict);

    drain.mockRejectedValueOnce(new ErasureLocalTurnFencedError());
    const locallyFenced = await callInternalErasureDrain(draining.app, drainSessionId, drainBody);
    expect(locallyFenced.status).toBe(409);
    expect(locallyFenced.headers.get(INTERNAL_ERASURE_DRAIN_ACK_HEADER)).toBe(
      INTERNAL_ERASURE_DRAIN_ACK_VALUE,
    );
    expect(locallyFenced.headers.get(INTERNAL_ERASURE_DRAIN_LOCAL_FENCED_HEADER)).toBe(
      INTERNAL_ERASURE_DRAIN_LOCAL_FENCED_VALUE,
    );
    expectPrivateLifecycleResponse(locallyFenced);

    const tombstoning = await makeApp(60_000, { attachStore: true });
    const tombstoneClaim = await claimErasurePhase(tombstoning.store, "u_tombstone", "tombstoning");
    const tombstoneBody = erasureDrainBody(tombstoneClaim);
    const tombstoneSessionId = newId("sess");
    const tombstoneDrain = vi.spyOn(tombstoning.host, "drainSessionForErasure").mockResolvedValue();
    const tombstoneErase = vi.spyOn(tombstoning.host, "eraseSessionForErasure").mockResolvedValue();
    const erased = await callInternalErasureDrain(
      tombstoning.app,
      tombstoneSessionId,
      tombstoneBody,
    );
    expect(erased.status).toBe(204);
    expect(erased.headers.get(INTERNAL_ERASURE_DRAIN_ACK_HEADER)).toBe(INTERNAL_ERASURE_DRAIN_ACK_VALUE);
    expectPrivateLifecycleResponse(erased);
    expect(tombstoneErase).toHaveBeenCalledWith(tombstoneBody, tombstoneSessionId);
    expect(tombstoneDrain).not.toHaveBeenCalled();
  });

  it("returns a private 404 when a valid erasure claim targets another user's session", async () => {
    const { app, store, call } = await makeApp(60_000, { attachStore: true });
    const agent = await j<{ id: string }>(await call("/v1/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "erasure-cross-owner",
        instructions: "",
        model: { provider: "dashscope", model: "qwen-plus" },
      }),
    }));
    const foreignSession = await j<{ id: string }>(await call("/v1/sessions", {
      method: "POST",
      headers: { "x-user-id": "u_other" },
      body: JSON.stringify({ agentId: agent.id }),
    }));
    const claim = await claimErasurePhase(store, "u_1", "draining");

    const response = await callInternalErasureDrain(app, foreignSession.id, erasureDrainBody(claim));
    expect(response.status).toBe(404);
    expectPrivateLifecycleResponse(response);
    expect(response.headers.get(INTERNAL_ERASURE_DRAIN_ACK_HEADER)).toBeNull();
  });

  it("keeps erasure writes closed by default and enforces admin, user and idempotency identity", async () => {
    const closed = await makeApp();
    const disabled = await closed.call("/v1/data-erasure-requests", {
      method: "POST",
      headers: { "idempotency-key": "erase-default-off" },
    });
    expect(disabled.status).toBe(503);
    expectPrivateLifecycleResponse(disabled);

    const { app, store, call } = await makeApp(60_000, { enabled: true, attachStore: true });
    await store.createApiKey("t_dev", "runtime-only", hashApiKey("runtime-key"), ["runtime"]);

    const forbidden = await call("/v1/data-erasure-requests", {
      method: "POST",
      headers: { authorization: "Bearer runtime-key", "idempotency-key": "erase-no-admin" },
    });
    expect(forbidden.status).toBe(403);
    expectPrivateLifecycleResponse(forbidden);
    expect((await call("/v1/data-erasure-requests", {
      method: "POST",
      headers: { "x-user-id": "", "idempotency-key": "erase-no-user" },
    })).status).toBe(400);
    expect((await call("/v1/data-erasure-requests", { method: "POST" })).status).toBe(400);
    expect((await call("/v1/data-erasure-requests", {
      method: "POST",
      headers: { "idempotency-key": "   " },
    })).status).toBe(400);

    // The feature route remains behind service-key authentication even when its deployment gate is on.
    const unauthorized = await app.request("/v1/data-erasure-requests", {
      method: "POST",
      headers: { "idempotency-key": "erase-no-service-key", "x-user-id": "u_1" },
    });
    expect(unauthorized.status).toBe(401);
    expectPrivateLifecycleResponse(unauthorized);
  });

  it("replays a subject request without leaking receipts and isolates the same key across users and tenants", async () => {
    const { store, call } = await makeApp(60_000, { enabled: true, attachStore: true });
    await store.createApiKey("t_other", "other-admin", hashApiKey("other-key"), ["admin"]);
    await store.createApiKey("t_dev", "runtime-only", hashApiKey("runtime-key"), ["runtime"]);

    const post = (userId: string, authorization = "Bearer dev-key") => call("/v1/data-erasure-requests", {
      method: "POST",
      headers: { authorization, "x-user-id": userId, "idempotency-key": "same-key" },
    });
    const agent = await j<{ id: string }>(await call("/v1/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "erasure-gate",
        instructions: "",
        model: { provider: "dashscope", model: "qwen-plus" },
      }),
    }));
    const existingSession = await j<{ id: string }>(await call("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ agentId: agent.id }),
    }));
    const firstResponse = await post("u_1");
    expect(firstResponse.status).toBe(202);
    expectPrivateLifecycleResponse(firstResponse);
    const first = await j<Record<string, unknown> & { id: string; generation: number }>(firstResponse);
    expect(first).toMatchObject({ scope: "user", userId: "u_1", generation: 1, status: "gated" });
    expect(Object.keys(first).sort()).toEqual([
      "createdAtMs", "generation", "id", "scope", "status", "updatedAtMs", "userId",
    ]);
    expect((await call(`/v1/sessions/${existingSession.id}`)).status).toBe(404);
    const blockedCreate = await call("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ agentId: agent.id }),
    });
    expect(blockedCreate.status).toBe(409);
    expect(await blockedCreate.json()).toMatchObject({ error: { code: "subject_deleting" } });

    const replay = await j<{ id: string; generation: number }>(await post("u_1"));
    expect(replay).toMatchObject({ id: first.id, generation: 1 });

    const second = await j<{ id: string; generation: number; userId: string }>(await post("u_2"));
    expect(second).toMatchObject({ generation: 1, userId: "u_2" });
    expect(second.id).not.toBe(first.id);

    const own = await call(`/v1/data-erasure-requests/${first.id}`);
    expect(own.status).toBe(200);
    expectPrivateLifecycleResponse(own);
    expect(await own.json()).toMatchObject({ id: first.id, userId: "u_1" });
    const otherUser = await call(`/v1/data-erasure-requests/${first.id}`, {
      headers: { "x-user-id": "u_2" },
    });
    expect(otherUser.status).toBe(404);
    expectPrivateLifecycleResponse(otherUser);
    const otherTenant = await call(`/v1/data-erasure-requests/${first.id}`, {
      headers: { authorization: "Bearer other-key", "x-user-id": "u_1" },
    });
    expect(otherTenant.status).toBe(404);
    expectPrivateLifecycleResponse(otherTenant);
    expect((await call(`/v1/data-erasure-requests/${first.id}`, {
      headers: { authorization: "Bearer runtime-key", "x-user-id": "u_1" },
    })).status).toBe(403);
  });

  it("projects an active quarantine as public blocked without leaking control-plane evidence", async () => {
    const { store, call } = await makeApp(60_000, { enabled: true, attachStore: true });
    const idempotencyKey = "quarantine-public-projection";
    const createdResponse = await call("/v1/data-erasure-requests", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
    });
    expect(createdResponse.status).toBe(202);
    const created = await j<{ id: string; status: string }>(createdResponse);
    expect(created.status).toBe("gated");

    // Seed the complete Memory quarantine overlay directly. It deliberately preserves the durable
    // phase (`gated`) while revoking worker authority; only the public projection becomes blocked.
    const current = store.erasureRequests.get(created.id)!;
    const evidence = "f".repeat(64);
    const quarantined = {
      ...current,
      controlGeneration: current.controlGeneration + 1,
      quarantinedAtMs: current.updatedAtMs + 1,
      quarantineReasonCode: "audit_chain_invalid" as const,
      quarantineEvidenceSha256: evidence,
      updatedAtMs: current.updatedAtMs + 1,
    };
    delete quarantined.availableAtMs;
    delete quarantined.claimToken;
    delete quarantined.leaseUntilMs;
    validateErasureRequestRecord(quarantined);
    store.erasureRequests.set(created.id, quarantined);

    const statusResponse = await call(`/v1/data-erasure-requests/${created.id}`);
    const replayResponse = await call("/v1/data-erasure-requests", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
    });
    for (const [response, expectedStatus] of [
      [statusResponse, 200],
      [replayResponse, 202],
    ] as const) {
      expect(response.status).toBe(expectedStatus);
      expectPrivateLifecycleResponse(response);
      const body = await j<Record<string, unknown>>(response);
      expect(body).toMatchObject({ id: created.id, status: "blocked" });
      expect(Object.keys(body).sort()).toEqual([
        "createdAtMs", "generation", "id", "scope", "status", "updatedAtMs", "userId",
      ]);
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("audit_chain_invalid");
      expect(serialized).not.toContain(evidence);
      expect(serialized).not.toContain("controlGeneration");
    }
    expect(store.erasureRequests.get(created.id)).toMatchObject({
      status: "gated",
      quarantineReasonCode: "audit_chain_invalid",
      quarantineEvidenceSha256: evidence,
    });
  });

  it("rejects M3-only agent declarations and turn inputs at the HTTP contract boundary", async () => {
    const { call } = await makeApp();
    const futureAgent = {
      name: "future",
      instructions: "",
      model: { provider: "dashscope", model: "qwen-plus" },
      skills: ["not-enabled"],
    };
    expect((await call("/v1/agents", { method: "POST", body: JSON.stringify(futureAgent) })).status).toBe(400);

    const agent = await j<{ id: string }>(await call("/v1/agents", {
      method: "POST",
      body: JSON.stringify({ name: "current", instructions: "", model: futureAgent.model }),
    }));
    const session = await j<{ id: string }>(await call("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ agentId: agent.id }),
    }));
    for (const input of [
      { type: "image", url: "https://example.test/image.png" },
      { type: "skill", name: "future" },
      { type: "mention", name: "future" },
    ]) {
      const response = await call(`/v1/sessions/${session.id}/turns`, {
        method: "POST",
        body: JSON.stringify({ input: [input], stream: false }),
      });
      expect(response.status).toBe(400);
    }
  });

  it("uses the shared HTTP schemas for boolean and numeric query validation", async () => {
    const { call } = await makeApp();
    const agent = await j<{ id: string }>(await call("/v1/agents", {
      method: "POST",
      body: JSON.stringify({ name: "queries", instructions: "", model: { provider: "dashscope", model: "qwen-plus" } }),
    }));
    const session = await j<{ id: string }>(await call("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ agentId: agent.id }),
    }));
    const archivedResponse = await call(`/v1/sessions/${session.id}/archive`, { method: "POST" });
    expect(archivedResponse.status).toBe(200);
    expect((await j<{ archivedAtMs?: number }>(archivedResponse)).archivedAtMs).toEqual(expect.any(Number));

    const hidden = await j<{ data: unknown[] }>(await call("/v1/sessions?includeArchived=false"));
    const visible = await j<{ data: { id: string }[] }>(await call("/v1/sessions?includeArchived=true"));
    expect(hidden.data).toEqual([]);
    expect(visible.data.map(({ id }) => id)).toEqual([session.id]);
    const archivedTurn = await call(`/v1/sessions/${session.id}/turns`, {
      method: "POST",
      body: JSON.stringify({ input: [{ type: "text", text: "blocked" }], stream: false }),
    });
    expect(archivedTurn.status).toBe(409);
    expect((await j<{ error: { code: string } }>(archivedTurn)).error.code).toBe("session_archived");
    expect((await call("/v1/sessions?includeArchived=not-a-boolean")).status).toBe(400);
    expect((await call(`/v1/agents/${agent.id}?version=not-a-number`)).status).toBe(400);
    expect((await call(`/v1/sessions/${session.id}/events?after=not-a-number`)).status).toBe(400);
    expect((await call(`/v1/providers/${"p".repeat(129)}`, {
      method: "PUT",
      body: JSON.stringify({}),
    })).status).toBe(400);
    expect((await call("/v1/tenant/api-keys/invalid%20key", { method: "DELETE" })).status).toBe(400);
    expect((await call(`/v1/sessions/${session.id}/turns`, {
      method: "POST",
      headers: { "idempotency-key": "   " },
      body: JSON.stringify({ input: [{ type: "text", text: "ignored" }], stream: false }),
    })).status).toBe(400);

    const unarchivedResponse = await call(`/v1/sessions/${session.id}/unarchive`, { method: "POST" });
    expect(unarchivedResponse.status).toBe(200);
    expect((await j<{ archivedAtMs?: number }>(unarchivedResponse)).archivedAtMs).toBeUndefined();
    expect((await call(`/v1/sessions/${session.id}/unarchive`, { method: "POST" })).status).toBe(200);
    expect((await j<{ data: { id: string }[] }>(await call("/v1/sessions"))).data.map(({ id }) => id)).toEqual([session.id]);
  });

  it("tombstones idempotently, emits the terminal lifecycle event and closes an established SSE", async () => {
    const { call } = await makeApp(5);
    const agent = await j<{ id: string }>(await call("/v1/agents", {
      method: "POST",
      body: JSON.stringify({ name: "delete", instructions: "", model: { provider: "dashscope", model: "qwen-plus" } }),
    }));
    const session = await j<{ id: string }>(await call("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ agentId: agent.id }),
    }));

    const response = await call(`/v1/sessions/${session.id}/events?after=1`);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let wire = "";
    let ended = false;
    try {
      // Receiving a heartbeat proves the stream callback is running before DELETE publishes.
      const first = await reader.read();
      wire += new TextDecoder().decode(first.value ?? new Uint8Array());

      const untrusted = await call(`${INTERNAL_TOMBSTONE_PATH_PREFIX}/${session.id}`, { method: "POST" });
      expect(untrusted.status).toBe(404);
      const deleted = await call(`${INTERNAL_TOMBSTONE_PATH_PREFIX}/${session.id}`, {
        method: "POST",
        headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_ROUTER_TOKEN },
      });
      expect(deleted.status).toBe(204);
      expect(deleted.headers.get(INTERNAL_TOMBSTONE_ACK_HEADER)).toBe(INTERNAL_TOMBSTONE_ACK_VALUE);
      expect(await deleted.text()).toBe("");

      for (let i = 0; i < 20; i++) {
        const next = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("deleted session SSE did not close")), 250)),
        ]);
        wire += new TextDecoder().decode(next.value ?? new Uint8Array());
        if (next.done) {
          ended = true;
          break;
        }
      }
    } finally {
      if (!ended) await reader.cancel().catch(() => {});
    }

    expect(ended).toBe(true);
    expect(parseSse(wire).filter((event) => event.type === "session/deleted")).toEqual([
      expect.objectContaining({ sessionId: session.id, deletionGeneration: 1, id: expect.any(String) }),
    ]);

    // A lost 204 may be retried by the router. It must not create another lifecycle event.
    expect((await call(`/v1/sessions/${session.id}`, { method: "DELETE" })).status).toBe(204);
    for (const [method, path] of [
      ["GET", `/v1/sessions/${session.id}`],
      ["GET", `/v1/sessions/${session.id}/items`],
      ["GET", `/v1/sessions/${session.id}/events`],
      ["POST", `/v1/sessions/${session.id}/archive`],
      ["POST", `/v1/sessions/${session.id}/unarchive`],
    ] as const) {
      expect((await call(path, { method })).status, `${method} ${path}`).toBe(404);
    }
  });

  it("refuses to tombstone a parent while a non-deleted child exists", async () => {
    const { call } = await makeApp();
    const agent = await j<{ id: string }>(await call("/v1/agents", {
      method: "POST",
      body: JSON.stringify({ name: "children", instructions: "", model: { provider: "dashscope", model: "qwen-plus" } }),
    }));
    const parent = await j<{ id: string }>(await call("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ agentId: agent.id }),
    }));
    const child = await j<{ id: string }>(await call("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ agentId: agent.id, parentSessionId: parent.id }),
    }));

    const blocked = await call(`/v1/sessions/${parent.id}`, { method: "DELETE" });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { code: "session_has_children" } });

    expect((await call(`/v1/sessions/${child.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await call(`/v1/sessions/${parent.id}`, { method: "DELETE" })).status).toBe(204);
  });

  it("emits protocol-valid heartbeats with the subscribed session id", async () => {
    const { call } = await makeApp(5);
    const agent = await j<{ id: string }>(await call("/v1/agents", {
      method: "POST",
      body: JSON.stringify({ name: "heartbeat", instructions: "", model: { provider: "dashscope", model: "qwen-plus" } }),
    }));
    const session = await j<{ id: string }>(await call("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ agentId: agent.id }),
    }));

    const response = await call(`/v1/sessions/${session.id}/events?after=1`);
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    const events = parseSse(new TextDecoder().decode(value ?? new Uint8Array()));
    expect(events[0]).toMatchObject({ type: "heartbeat", sessionId: session.id });
  });

  it("rejects missing/invalid auth and requires X-User-Id for user-scoped routes", async () => {
    const { app, call } = await makeApp();
    expect((await app.request("/v1/agents")).status).toBe(401);
    expect((await app.request("/v1/agents", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    const r = await call("/v1/sessions", { method: "POST", headers: { "x-user-id": "" }, body: JSON.stringify({ agentId: "agt_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b" }) });
    expect(r.status).toBe(400);
    expect((await j<{ error: { code: string } }>(r)).error.code).toBe("invalid_request");
  });

  it("agent → session → streaming turn → items → replay", async () => {
    const { call } = await makeApp();
    const agentRes = await call("/v1/agents", { method: "POST", body: JSON.stringify({ name: "echo", instructions: "echo", model: { provider: "dashscope", model: "qwen-plus" }, tools: ["current_time"] }) });
    expect(agentRes.status).toBe(201);
    const agent = await j<{ id: string; version: number }>(agentRes);
    expect(agent.version).toBe(1);

    const sessRes = await call("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: agent.id }) });
    expect(sessRes.status).toBe(201);
    const session = await j<{ id: string; status: { type: string } }>(sessRes);
    expect(session.status).toEqual({ type: "idle" });

    const turnRes = await call(`/v1/sessions/${session.id}/turns`, { method: "POST", body: JSON.stringify({ input: [{ type: "text", text: "what time is it" }] }) });
    expect(turnRes.status).toBe(200);
    expect(turnRes.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSse(await turnRes.text());
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("turn/started");
    expect(types).toContain("item/agentMessage/delta");
    expect(types).toContain("item/started");
    expect(types.at(-2)).toBe("turn/completed");
    expect(types.at(-1)).toBe("session/status/changed");
    const ids = events.filter((e) => e.id).map((e) => Number(e.id));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    const completed = events.find((e) => e.type === "turn/completed");
    expect(completed.turn.status).toBe("completed");
    expect(completed.turn.toolCalls).toBe(1);

    const items = await j<{ data: { type: string; content: { text: string }[] }[] }>(await call(`/v1/sessions/${session.id}/items`));
    expect(items.data.map((i) => i.type)).toEqual(["userMessage", "agentMessage", "toolCall", "toolResult", "agentMessage"]);
    const toolResult = items.data.find((i) => i.type === "toolResult")!;
    expect(toolResult.content[0]!.text).toMatch(/Asia\/Shanghai/);

    // replay from the middle with Last-Event-ID; the stream ends because the session is idle
    const mid: number = ids[Math.floor(ids.length / 2)]!;
    const replayRes = await call(`/v1/sessions/${session.id}/events?after=${mid}`, { headers: { accept: "text/event-stream" } });
    // the events endpoint stays open (idle sessions still stream heartbeats); read the first chunk then cancel
    const reader = replayRes.body!.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    const replayed = parseSse(new TextDecoder().decode(value ?? new Uint8Array()));
    expect(replayed.every((e) => Number(e.id) > mid!)).toBe(true);
    expect(replayed.map((e) => e.type)).not.toContain("item/agentMessage/delta");

    const resume = await j<{ recentTurns: unknown[]; lastSeq: number }>(await call(`/v1/sessions/${session.id}/resume`, { method: "POST" }));
    expect(resume.recentTurns).toHaveLength(1);
    expect(resume.lastSeq).toBe(ids.at(-1));
  });

  it("non-streaming turn returns 202 and honours Idempotency-Key", async () => {
    const { call } = await makeApp();
    const agent = await j<{ id: string }>(await call("/v1/agents", { method: "POST", body: JSON.stringify({ name: "e", instructions: "", model: { provider: "dashscope", model: "qwen-plus" } }) }));
    const session = await j<{ id: string }>(await call("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: agent.id }) }));
    const body = JSON.stringify({ input: [{ type: "text", text: "hi" }], stream: false });
    const r1 = await call(`/v1/sessions/${session.id}/turns`, { method: "POST", headers: { "idempotency-key": "abc" }, body });
    expect(r1.status).toBe(202);
    const t1 = (await j<{ turn: { id: string } }>(r1)).turn;
    await new Promise((r) => setTimeout(r, 100));
    // `stream` is transport-only, so changing it must still replay the same resource as JSON.
    const r2 = await call(`/v1/sessions/${session.id}/turns`, {
      method: "POST",
      headers: { "idempotency-key": "abc" },
      body: JSON.stringify({ input: [{ type: "text", text: "hi" }], stream: true }),
    });
    expect(r2.status).toBe(200);
    expect(r2.headers.get("idempotency-replayed")).toBe("true");
    expect((await j<{ turn: { id: string } }>(r2)).turn.id).toBe(t1.id);
    const mismatch = await call(`/v1/sessions/${session.id}/turns`, {
      method: "POST",
      headers: { "idempotency-key": "abc" },
      body: JSON.stringify({ input: [{ type: "text", text: "different" }], stream: false }),
    });
    expect(mismatch.status).toBe(409);
    expect((await j<{ error: { code: string } }>(mismatch)).error.code).toBe("idempotency_conflict");
    expect((await j<{ data: unknown[] }>(await call(`/v1/sessions/${session.id}/turns`))).data).toHaveLength(1);
    expect((await j<{ data: unknown[] }>(await call(`/v1/sessions/${session.id}/items`))).data).toHaveLength(2);
    const turn = await j<{ status: string }>(await call(`/v1/sessions/${session.id}/turns/${t1.id}`));
    expect(turn.status).toBe("completed");
  });

  it("authorizes idempotency replay and scopes the same key by user and session", async () => {
    const { call } = await makeApp();
    const agent = await j<{ id: string }>(await call("/v1/agents", {
      method: "POST",
      body: JSON.stringify({ name: "e", instructions: "", model: { provider: "dashscope", model: "qwen-plus" } }),
    }));
    const victimSession = await j<{ id: string }>(await call("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ agentId: agent.id }),
    }));
    const body = JSON.stringify({ input: [{ type: "text", text: "private" }], stream: false });
    const first = await call(`/v1/sessions/${victimSession.id}/turns`, {
      method: "POST", headers: { "idempotency-key": "shared-key" }, body,
    });
    expect(first.status).toBe(202);

    // Regression: tenant-wide key lookup used to return the victim's completed turn before checking
    // whether the current end user owned the session.
    const stolenReplay = await call(`/v1/sessions/${victimSession.id}/turns`, {
      method: "POST", headers: { "x-user-id": "u_2", "idempotency-key": "shared-key" }, body,
    });
    expect(stolenReplay.status).toBe(404);

    const attackerSession = await j<{ id: string }>(await call("/v1/sessions", {
      method: "POST", headers: { "x-user-id": "u_2" }, body: JSON.stringify({ agentId: agent.id }),
    }));
    const independent = await call(`/v1/sessions/${attackerSession.id}/turns`, {
      method: "POST", headers: { "x-user-id": "u_2", "idempotency-key": "shared-key" }, body,
    });
    expect(independent.status).toBe(202);
  });

  it("tenant isolation: another tenant's key cannot see the session", async () => {
    const { call, store } = await makeApp();
    await store.createApiKey("t_other", "k2", hashApiKey("other-key"), ["runtime", "admin"]);
    const agent = await j<{ id: string }>(await call("/v1/agents", { method: "POST", body: JSON.stringify({ name: "e", instructions: "", model: { provider: "dashscope", model: "qwen-plus" } }) }));
    const session = await j<{ id: string }>(await call("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: agent.id }) }));
    const r = await call(`/v1/sessions/${session.id}`, { headers: { authorization: "Bearer other-key" } });
    expect(r.status).toBe(404);
  });

  it("BYOK provider config is write-only and listed alongside platform presets", async () => {
    const { call } = await makeApp();
    const r = await call("/v1/providers/mine", { method: "PUT", body: JSON.stringify({ baseUrl: "https://example.com/v1", apiKey: "sk-xyz", models: [{ id: "m" }] }) });
    expect(r.status).toBe(200);
    const cfg = await j<Record<string, unknown>>(r);
    expect(JSON.stringify(cfg)).not.toContain("sk-xyz");
    const list = await j<{ data: { id: string }[] }>(await call("/v1/providers"));
    expect(list.data.map((p) => p.id)).toEqual(["mine", "dashscope"]);
    const models = await j<{ data: { provider: string; id: string }[] }>(await call("/v1/models"));
    expect(models.data.some((m) => m.provider === "mine" && m.id === "m")).toBe(true);
    expect((await call("/v1/providers/mine", { method: "DELETE" })).status).toBe(204);
  });

  it("rejects empty, image-only, and duplicate model capabilities at the HTTP boundary", async () => {
    const { call } = await makeApp();
    const invalidInputs = [[], ["image"], ["text", "text"], ["image", "image"]];
    for (const [index, input] of invalidInputs.entries()) {
      const response = await call(`/v1/providers/invalid-${index}`, {
        method: "PUT",
        body: JSON.stringify({ baseUrl: "https://example.com/v1", models: [{ id: "m", input }] }),
      });
      expect(response.status, JSON.stringify(input)).toBe(400);
    }
    const listed = await j<{ data: { id: string }[] }>(await call("/v1/providers"));
    expect(listed.data.some((provider) => provider.id.startsWith("invalid-"))).toBe(false);
  });
});
