import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Models } from "@earendil-works/pi-ai";
import { type AgentDefinition } from "@agent-service/protocol";
import { MemoryEventBus, MemoryLeaseStore, MemorySessionStore, type CommitBatch } from "@agent-service/store";
import { PiEngine, SessionHost, StaticToolRegistry, createPersistedProviderFailureCapture, getPiProviderStepFailure, newId, type AgentEngine, type SessionHostDeps } from "../src/index.js";
import { activateMemoryPersistedProviderCapture } from "./persisted-provider-capture-fixture.js";

const hosts: SessionHost[] = [];
afterEach(async () => { await Promise.all(hosts.splice(0).map((host) => host.drain(1_000))); });
const principal = { tenantId: "capture-app-tenant", userId: "capture-app-user" };
const raw = (text: string, failed = true): AssistantMessage => ({
  role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture", timestamp: 1,
  content: [{ type: "text", text }], stopReason: failed ? "error" : "stop", errorMessage: "do-not-capture-raw-vendor-error",
  usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
async function setup(options: { text?: string; active?: boolean; suppressStep?: boolean; duplicate?: boolean; concurrentDuplicate?: boolean; sdkError?: boolean; captureError?: boolean; captureAfterCommitError?: boolean; aborted?: boolean; afterCaptureError?: boolean; realStoreCapture?: boolean } = {}) {
  const refKey = new Uint8Array(32).fill(47);
  const store = new MemorySessionStore({ now: () => Date.now() }, { tenantTelemetryRefKey: refKey, tenantTelemetryPersistedProviderCaptureLocalOnly: true });
  if (options.realStoreCapture) {
    await activateMemoryPersistedProviderCapture(store);
    await store.createApiKey(principal.tenantId, "real-capture-unit-key", "unit-hash");
  }
  const product = createPersistedProviderFailureCapture({ store, opaqueRefKey: refKey, requireFreshFleet: async (expected) => expected });
  const batches: CommitBatch[] = [];
  const sourceInputs: unknown[] = [];
  const capture: NonNullable<SessionHostDeps["persistedProviderFailureCapture"]> = { commit: vi.fn(async (batch, source) => {
    batches.push(structuredClone(batch)); sourceInputs.push(source);
    if (options.captureError) throw new Error("capture commit response is ambiguous");
    const result = await (options.realStoreCapture ? product.commit(batch, source) : store.commit(batch));
    if (options.captureAfterCommitError) throw new Error("unit response lost after source transaction committed");
    return result;
  }) };
  const models = { streamSimple: vi.fn(() => {
    if (options.sdkError) throw new Error("private sdk/runtime exception");
    const stream = createAssistantMessageEventStream();
    const message = raw(options.text ?? "partial response");
    if (options.aborted) message.stopReason = "aborted";
    if (message.content[0]?.type === "text" && message.content[0].text) {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "text_delta", contentIndex: 0, delta: message.content[0].text, partial: message });
    }
    stream.push({ type: "error", reason: options.aborted ? "aborted" : "error", error: message });
    return stream;
  }) } as unknown as Models;
  const pi = new PiEngine(models);
  const engine: AgentEngine = {
    name: "pi-fixture-wrapper",
    start(params, sink) {
      return pi.start(params, {
        ...sink,
        async onAssistantMessage(message) {
          if (options.suppressStep && getPiProviderStepFailure(message)) return;
          if (options.concurrentDuplicate && getPiProviderStepFailure(message)) {
            await Promise.all([sink.onAssistantMessage(message), sink.onAssistantMessage(message)]);
            return;
          }
          await sink.onAssistantMessage(message);
          if (options.duplicate && getPiProviderStepFailure(message)) await sink.onAssistantMessage(message);
          if (options.afterCaptureError && getPiProviderStepFailure(message)) throw new Error("late private Pi callback error after business commit");
        },
      });
    },
  };
  const agent: AgentDefinition = {
    id: newId("agt"), tenantId: principal.tenantId, version: 1, name: "fixture", instructions: "fixture",
    model: { provider: "fixture", model: "fixture" }, tools: [], mcpServers: [], skills: [], limits: {},
    approvalPolicy: "never", busyPolicy: "reject", sandbox: "none", metadata: {}, createdAtMs: Date.now(),
  };
  await store.createAgent(agent);
  const host = new SessionHost({
    store, lease: new MemoryLeaseStore(), bus: new MemoryEventBus(), engine, tools: new StaticToolRegistry([]),
    providers: { resolve: async () => ({ handle: { api: "openai-completions", provider: "fixture", id: "fixture" }, provider: "fixture", model: "fixture", contextWindow: 10000, input: ["text"], apiKey: async () => undefined }) },
    ...(options.active !== false ? { persistedProviderFailureCapture: capture } : {}),
    logger: { info() {}, warn() {}, error() {} },
    config: { runnerId: "capture-app", runnerAddr: "127.0.0.1:8787", leaseTtlMs: 5000, leaseHoldMs: 1 },
  });
  hosts.push(host);
  const session = await host.createSession(principal, { agentId: agent.id, metadata: {} });
  const turn = await host.startTurn(principal, session.id, { input: [{ type: "text", text: "go" }], stream: false, metadata: {} });
  await vi.waitFor(() => expect(host.activeTurn(session.id)).toBeUndefined());
  return { store, session, turn: await store.getTurn(session.id, turn.turn.id), batches, sourceInputs, capture, models };
}

describe("SessionHost first failed provider step capture", () => {
  it.each(["partial response", ""])("captures a real first-step item atomically before finish (%j)", async (text) => {
    const h = await setup({ text });
    expect(h.capture.commit).toHaveBeenCalledTimes(1);
    const batch = h.batches[0]!;
    expect(batch.turn?.status).toBe("inProgress");
    expect(batch.events?.map((event) => event.type)).toEqual(["item/completed", "usage/updated"]);
    expect(batch.items).toHaveLength(1);
    expect(batch.items?.[0]).toMatchObject({ type: "agentMessage", status: "failed", text, step: 1 });
    const items = await h.store.listItems(h.session.id, { limit: 10 });
    expect(items.filter((item) => item.type === "agentMessage")).toMatchObject([{ status: "failed", text }]);
    const events = await h.store.readEvents(h.session.id, 0, 100);
    expect(events.slice(-3).map((event) => event.type)).toEqual(["error", "turn/completed", "session/status/changed"]);
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    expect(h.turn).toMatchObject({ status: "failed", stopReason: "error", seqEnd: events.at(-1)?.seq });
    expect(JSON.stringify(h.sourceInputs)).not.toContain("do-not-capture-raw-vendor-error");
    expect(h.models.streamSimple).toHaveBeenCalledTimes(1);
  });

  it("reuses the original failed item and usage when callbacks duplicate or only done carries provenance", async () => {
    for (const mode of ["duplicate", "concurrentDuplicate", "suppressStep"] as const) {
      const h = await setup({ [mode]: true });
      expect(h.capture.commit).toHaveBeenCalledTimes(1);
      expect(h.batches[0]?.usageEntries).toHaveLength(1);
      expect(h.turn?.usage.totalTokens).toBe(3);
      const items = await h.store.listItems(h.session.id, { limit: 10 });
      expect(items.filter((item) => item.type === "agentMessage")).toHaveLength(1);
      expect(h.models.streamSimple).toHaveBeenCalledTimes(1);
    }
  });

  it("preserves failed streamed items with capture off and never captures synthetic runtime errors", async () => {
    const inactive = await setup({ active: false });
    expect(inactive.capture.commit).not.toHaveBeenCalled();
    expect((await inactive.store.listItems(inactive.session.id, { limit: 10 })).filter((item) => item.type === "agentMessage")).toMatchObject([{ status: "failed" }]);
    const unknown = await setup({ sdkError: true });
    expect(unknown.capture.commit).not.toHaveBeenCalled();
    expect(unknown.turn?.error?.message).toBe("Provider request failed.");
    expect(unknown.models.streamSimple).toHaveBeenCalledTimes(1);
  });

  it("fences an ambiguous first commit without capturing again or rerunning the model", async () => {
    const h = await setup({ captureError: true });
    expect(h.capture.commit).toHaveBeenCalledTimes(1);
    expect(h.models.streamSimple).toHaveBeenCalledTimes(1);
    expect(h.turn?.status).toBe("inProgress");
    expect((await h.store.readEvents(h.session.id, 0, 100)).some((event) => event.type === "turn/completed")).toBe(false);
    expect((await h.store.listItems(h.session.id, { limit: 10 })).filter((item) => item.type === "agentMessage")).toMatchObject([{ status: "inProgress" }]);
  });

  it("keeps genuine provider aborts on the ordinary interrupted path without a failure source", async () => {
    const h = await setup({ aborted: true });
    expect(h.capture.commit).not.toHaveBeenCalled();
    expect(h.turn).toMatchObject({ status: "interrupted", stopReason: "interrupted" });
    expect(h.turn?.error).toBeUndefined();
    expect(h.models.streamSimple).toHaveBeenCalledTimes(1);
  });

  it("does not rewrite a committed failed step when real Pi later synthesizes a listener error", async () => {
    const h = await setup({ afterCaptureError: true, realStoreCapture: true });
    expect(h.capture.commit).toHaveBeenCalledTimes(1);
    const original = h.batches[0]!.items![0]!;
    const items = await h.store.listItems(h.session.id, { limit: 10 });
    expect(items.filter((item) => item.type === "agentMessage")).toMatchObject([{ id: original.id, status: "failed", text: "partial response", completedAtMs: original.completedAtMs }]);
    const events = await h.store.readEvents(h.session.id, 0, 100);
    expect(events.filter((event) => event.type === "usage/updated")).toHaveLength(1);
    expect(events.filter((event) => event.type === "item/completed" && event.item.type === "agentMessage")).toHaveLength(1);
    const persistedItem = items.find((item) => item.id === original.id)!;
    const firstStarted = events.find((event) => event.type === "item/started" && event.item.id === original.id);
    const completed = events.find((event) => event.type === "item/completed" && event.item.id === original.id);
    expect(persistedItem.seq).toBeGreaterThan(0);
    expect(persistedItem.seq).toBe(firstStarted?.seq);
    expect(completed?.seq).toBeGreaterThan(persistedItem.seq);
    expect(completed?.type === "item/completed" ? completed.item.seq : undefined).toBe(persistedItem.seq);
    expect(events.slice(-3).map((event) => event.type)).toEqual(["error", "turn/completed", "session/status/changed"]);
    expect(h.turn).toMatchObject({ status: "failed", usage: { totalTokens: 3 }, seqEnd: events.at(-1)?.seq });
    expect(h.models.streamSimple).toHaveBeenCalledTimes(1);
    const proof = await h.store.getTenantTelemetryPersistedProviderCaptureBinding();
    expect(await h.store.verifyPersistedProviderStepFailureSource({ tenantId: principal.tenantId, sessionId: h.session.id, turnId: h.turn!.id,
      itemId: original.id, stepIndex: 1, freshProof: proof! })).toMatchObject({ status: "source_verified_queued", sourceCount: 1, executionReady: false, allDomainsComplete: false });
  });

  it("leaves a response-lost committed source intact but fences host continuation instead of replaying the model", async () => {
    const h = await setup({ realStoreCapture: true, captureAfterCommitError: true });
    expect(h.capture.commit).toHaveBeenCalledTimes(1);
    expect(h.models.streamSimple).toHaveBeenCalledTimes(1);
    expect(h.turn?.status).toBe("inProgress");
    const events = await h.store.readEvents(h.session.id, 0, 100);
    expect(events.filter((event) => event.type === "usage/updated")).toHaveLength(1);
    expect(events.some((event) => event.type === "turn/completed")).toBe(false);
    const item = (await h.store.listItems(h.session.id, { limit: 10 })).find((candidate) => candidate.type === "agentMessage")!;
    expect(item.status).toBe("failed");
    expect(await h.store.verifyPersistedProviderStepFailureSource({ tenantId: principal.tenantId, sessionId: h.session.id, turnId: h.turn!.id,
      itemId: item.id, stepIndex: 1, freshProof: (await h.store.getTenantTelemetryPersistedProviderCaptureBinding())! })).toMatchObject({ status: "source_verified_queued", sourceCount: 1 });
  });
});
