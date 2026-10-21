import { describe, expect, it, vi } from "vitest";
import { ApiError, DEFAULT_AUTH_POLICY, createStructuredTelemetry } from "@agent-service/protocol";
import {
  MemoryProviderQuotaCoordinator, MemorySessionStore, ProviderQuotaError, SubjectDeletingError, newErasureRequestId, tenantErasureRequestHash,
  type ProviderQuotaCoordinator, type ProviderQuotaLease, type ProviderQuotaRequest,
} from "@agent-service/store";
import { TenantRuntimeCoordinator } from "@agent-service/core";
import { LocalAesGcmCipher, ProviderService } from "../src/index.js";

const KEY = "12".repeat(32);
const ref = { provider: "fixture", model: "model" };
const subject = { tenantId: "tenant-a", userId: "user-a" };
const config = () => ({ id: ref.provider, api: "openai-completions" as const, baseUrl: "https://provider.example/v1",
  headers: {}, quota: {}, fallback: [], models: [{ id: ref.model, contextWindow: 1000,
    maxOutputTokens: 100, input: ["text" as const], reasoning: false }] });
function barrier() {
  let resolve: () => void = () => { throw new Error("barrier not initialized"); };
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
class ControlledSlot implements ProviderQuotaLease {
  readonly abort = new AbortController();
  readonly signal = this.abort.signal;
  readonly releasing = barrier();
  readonly released = barrier();
  releaseGate?: Promise<void>;
  releaseError?: unknown;
  readonly assertOpen = vi.fn(async () => {
    if (this.signal.aborted) throw new ProviderQuotaError("unavailable");
  });
  readonly release = vi.fn(async () => {
    this.releasing.resolve();
    try { await this.releaseGate; if (this.releaseError !== undefined) throw this.releaseError; }
    finally { this.released.resolve(); }
  });
}
/** Contract double only: the real Response/ReadableStream lifetime is exercised here, not Redis
 * atomic quota admission, expiry or cross-process coordination. Those belong to coordinator tests. */
class RecordingQuota implements ProviderQuotaCoordinator {
  readonly namespaceSha256 = "a".repeat(64);
  readonly requests: ProviderQuotaRequest[] = [];
  readonly slots: ControlledSlot[] = [];
  readonly assertReady = vi.fn(async () => {});
  onEnter?: (slot: ControlledSlot, signal: AbortSignal) => Promise<void>;
  readonly enter = vi.fn(async (request: ProviderQuotaRequest, signal: AbortSignal) => {
    const slot = new ControlledSlot(); this.requests.push(request); this.slots.push(slot);
    await this.onEnter?.(slot, signal); return slot;
  });
  readonly close = vi.fn(async () => {
    for (const slot of this.slots) slot.abort.abort(new ProviderQuotaError("unavailable"));
    await Promise.all(this.slots.map(slot => slot.released.promise));
  });
}
async function fixture(options: {
  fetch?: typeof fetch; quota?: RecordingQuota; runtime?: TenantRuntimeCoordinator;
  authorizeFleet?: (signal: AbortSignal) => Promise<void>; persisted?: boolean;
} = {}) {
  const store = new MemorySessionStore(), quota = options.quota ?? new RecordingQuota(), records: unknown[] = [];
  const delegate = vi.fn(options.fetch ?? (async () => new Response(null, { status: 204 })));
  const service = new ProviderService({ store, cipher: new LocalAesGcmCipher(KEY), assertBaseUrl: async () => {},
    fetch: delegate, tenantRuntime: options.runtime,
    persistedProviderFailureCaptureActive: options.persisted,
    telemetry: createStructuredTelemetry({ component: "provider", opaqueRefKey: Buffer.alloc(32, 7), sink: { write(record) { records.push(record); } } }),
    quota: { coordinator: quota, tenant: { rpm: 100, concurrency: 8 }, user: { rpm: 20, concurrency: 2 },
      platformProvider: { rpm: 10, concurrency: 3 }, authorizeFleet: options.authorizeFleet } });
  await service.upsertTenantProvider(subject.tenantId, config());
  return { store, quota, service, delegate, records, resolved: await service.resolve(subject, ref) };
}
async function gateTenant(store: MemorySessionStore) {
  await store.setTenantAuth(subject.tenantId, DEFAULT_AUTH_POLICY);
  await store.requestTenantErasure({ requestId: newErasureRequestId(), tenantId: subject.tenantId,
    requestedByKeyId: "fixture-admin", idempotencyKey: "gate", requestHash: tenantErasureRequestHash(subject.tenantId), atMs: Date.now() });
}

describe("ProviderService quota dispatch and real response settlement", () => {
  it("captures immutable policy and resolved subjects, keeping tenant providers separate and platform providers shared", async () => {
    const store = new MemorySessionStore(), quota = new RecordingQuota();
    const policy = { coordinator: quota, tenant: { rpm: 100, concurrency: 8 }, user: { rpm: 20, concurrency: 2 },
      platformProvider: { rpm: 10, concurrency: 3 } };
    const platform = { config: { ...config(), quota: { rpm: 50, concurrency: 1 } }, apiKey: "private-platform-canary" };
    const service = new ProviderService({ store, cipher: new LocalAesGcmCipher(KEY), assertBaseUrl: async () => {},
      fetch: async () => new Response(null, { status: 204 }), platform: [platform], quota: policy });
    policy.tenant.rpm = 1; policy.user.concurrency = 1; policy.platformProvider.rpm = 1;
    platform.config.quota.rpm = 999; platform.apiKey = "mutated-platform-canary";
    for (const tenantId of ["tenant-a", "tenant-b"]) await service.upsertTenantProvider(tenantId,
      { ...config(), quota: { rpm: 80, concurrency: 5 } });
    for (const p of [subject, { ...subject, userId: "user-b" }, { tenantId: "tenant-b", userId: "user-a" },
      { tenantId: "tenant-c", userId: "user-a" }, { tenantId: "tenant-d", userId: "user-b" }]) {
      const resolved = await service.resolve(p, ref);
      await resolved.fetch!("https://provider.example/v1/chat", { headers: { "x-user-id": "forged-user", "x-tenant-id": "forged-tenant" } });
    }
    expect(quota.requests.map(r => [r.tenantId, r.userId, r.provider])).toEqual([
      ["tenant-a", "user-a", { scope: "tenant", id: "fixture" }],
      ["tenant-a", "user-b", { scope: "tenant", id: "fixture" }],
      ["tenant-b", "user-a", { scope: "tenant", id: "fixture" }],
      ["tenant-c", "user-a", { scope: "platform", id: "fixture" }],
      ["tenant-d", "user-b", { scope: "platform", id: "fixture" }],
    ]);
    expect(quota.requests.map(r => r.providerLimit)).toEqual([
      { rpm: 80, concurrency: 5 }, { rpm: 80, concurrency: 5 }, { rpm: 80, concurrency: 5 },
      { rpm: 10, concurrency: 1 }, { rpm: 10, concurrency: 1 },
    ]);
    for (const request of quota.requests) {
      expect(request.tenant).toEqual({ rpm: 100, concurrency: 8 }); expect(request.user).toEqual({ rpm: 20, concurrency: 2 });
      expect(Object.isFrozen(request) && Object.isFrozen(request.provider) && Object.isFrozen(request.providerLimit)).toBe(true);
    }
    const resolved = await service.resolve({ tenantId: "tenant-c", userId: "user-a" }, ref);
    expect((await resolved.apiKey()) === "private-platform-canary").toBe(true);
    expect(quota.slots.every(slot => slot.release.mock.calls.length === 1)).toBe(true);
  });

  it("rejects configured tenant and platform limits without a coordinator before writing or resolving", async () => {
    const store = new MemorySessionStore(), cipher = new LocalAesGcmCipher(KEY), delegate = vi.fn();
    const service = new ProviderService({ store, cipher, assertBaseUrl: async () => {}, fetch: delegate });
    await expect(service.upsertTenantProvider(subject.tenantId, { ...config(), quota: { rpm: 1 } })).rejects.toBeInstanceOf(ProviderQuotaError);
    expect(await store.getProviderConfig(subject.tenantId, ref.provider)).toBeNull();
    const seeded = new ProviderService({ store, cipher, assertBaseUrl: async () => {}, quota: { coordinator: new RecordingQuota(), tenant: {}, user: {} } });
    await seeded.upsertTenantProvider(subject.tenantId, { ...config(), quota: { concurrency: 1 } });
    await expect(service.resolve(subject, ref)).rejects.toBeInstanceOf(ProviderQuotaError);
    const platform = new ProviderService({ store: new MemorySessionStore(), cipher, fetch: delegate,
      platform: [{ config: { ...config(), quota: { rpm: 1 } } }] });
    await expect(platform.resolve(subject, ref)).rejects.toBeInstanceOf(ProviderQuotaError);
    expect(delegate).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1_000_001])("rejects invalid injected limit %s", value => {
    expect(() => new ProviderService({ store: new MemorySessionStore(), cipher: new LocalAesGcmCipher(KEY),
      quota: { coordinator: new RecordingQuota(), tenant: { rpm: value }, user: {} } })).toThrow("Invalid provider quota configuration.");
  });

  it("refuses unknown policy fields and never invokes policy getters", () => {
    let reads = 0;
    const policy = Object.defineProperty({ coordinator: new RecordingQuota(), tenant: {}, user: {} }, "secret", { enumerable: true, get() { reads++; return "private-canary"; } });
    expect(() => new ProviderService({ store: new MemorySessionStore(), cipher: new LocalAesGcmCipher(KEY), quota: policy })).toThrow("Invalid provider quota configuration.");
    expect(reads).toBe(0);
  });

  it("rejects admission without dispatch or upstream-failure telemetry", async () => {
    const quota = new RecordingQuota(); quota.onEnter = async () => { throw new ProviderQuotaError("concurrency"); };
    const f = await fixture({ quota });
    await expect(f.resolved.fetch!("https://provider.example/v1/chat")).rejects.toMatchObject({ reason: "concurrency" });
    expect(f.delegate).not.toHaveBeenCalled(); expect(f.records).toEqual([]);
  });

  it("requires two fresh fleet proofs and does not dispatch when the second proof fails", async () => {
    const authorizeFleet = vi.fn(async () => {}), f = await fixture({ authorizeFleet });
    authorizeFleet.mockRejectedValueOnce(undefined);
    await expect(f.resolved.fetch!("https://provider.example/v1/chat")).rejects.toMatchObject({ reason: "unavailable" });
    expect(f.delegate).not.toHaveBeenCalled(); expect(f.quota.enter).not.toHaveBeenCalled();
    authorizeFleet.mockReset(); authorizeFleet.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("private-fleet-canary"));
    await expect(f.resolved.fetch!("https://provider.example/v1/chat")).rejects.toMatchObject({ reason: "unavailable" });
    expect(authorizeFleet).toHaveBeenCalledTimes(2); expect(f.delegate).not.toHaveBeenCalled();
    expect(f.quota.slots[0]!.release).toHaveBeenCalledOnce();
  });

  it("holds both leases until actual EOF and asynchronous quota release settle", async () => {
    const runtime = new TenantRuntimeCoordinator(), quota = new RecordingQuota(), releaseAck = barrier();
    let source: ReadableStreamDefaultController<Uint8Array> | undefined;
    quota.onEnter = async slot => { slot.releaseGate = releaseAck.promise; };
    const f = await fixture({ quota, runtime, fetch: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { source = controller; } })) });
    const response = await f.resolved.fetch!("https://provider.example/v1/chat");
    let settled = false; const text = response.text().finally(() => { settled = true; });
    source!.enqueue(new TextEncoder().encode("ok")); source!.close();
    try {
      expect(runtime.snapshot(subject.tenantId).providerOperations).toBe(1); expect(quota.slots[0]!.release).not.toHaveBeenCalled();
      await quota.slots[0]!.releasing.promise;
      expect(settled).toBe(false); expect(runtime.snapshot(subject.tenantId).providerOperations).toBe(1);
      releaseAck.resolve(); expect(await text).toBe("ok"); expect(settled).toBe(true);
      expect(runtime.snapshot(subject.tenantId).providerOperations).toBe(0); expect(quota.slots[0]!.release).toHaveBeenCalledOnce();
    } finally { releaseAck.resolve(); await Promise.allSettled([text]); }
  });

  it("completes normal EOF with the real Memory coordinator whose release aborts its own signal", async () => {
    const quota = new MemoryProviderQuotaCoordinator({ store: "memory", prefix: "quota-service-eof", namespaceId: "fixture" });
    const store = new MemorySessionStore(), runtime = new TenantRuntimeCoordinator();
    const service = new ProviderService({ store, cipher: new LocalAesGcmCipher(KEY), tenantRuntime: runtime,
      assertBaseUrl: async () => {}, fetch: async () => new Response("actual EOF"),
      quota: { coordinator: quota, tenant: { concurrency: 1 }, user: {} } });
    let response: Response | undefined;
    try {
      await service.upsertTenantProvider(subject.tenantId, config());
      const resolved = await service.resolve(subject, ref);
      response = await resolved.fetch!("https://provider.example/v1/chat");
      expect(await response.text()).toBe("actual EOF");
      expect(runtime.snapshot(subject.tenantId).providerOperations).toBe(0);
      response = await resolved.fetch!("https://provider.example/v1/chat");
      expect(await response.text()).toBe("actual EOF");
      expect(runtime.snapshot(subject.tenantId).providerOperations).toBe(0);
    } finally {
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
      await quota.close();
    }
  });

  it.each(["caller", "tenant"] as const)("does not accept EOF when %s authority aborts during held quota release", async mode => {
    const runtime = new TenantRuntimeCoordinator(), quota = new RecordingQuota(), releaseAck = barrier(), caller = new AbortController();
    quota.onEnter = async slot => { slot.releaseGate = releaseAck.promise; };
    const f = await fixture({ quota, runtime, fetch: async () => new Response("EOF before release") }); runtime.sealParticipants();
    const response = await f.resolved.fetch!("https://provider.example/v1/chat", { signal: caller.signal });
    let settled = false; const text = response.text().finally(() => { settled = true; });
    const rejected = expect(text).rejects.toMatchObject({ name: "AbortError" });
    let drain: ReturnType<TenantRuntimeCoordinator["drain"]> | undefined;
    try {
      await quota.slots[0]!.releasing.promise;
      if (mode === "caller") caller.abort();
      else drain = runtime.drain({ tenantId: subject.tenantId, requestId: "fixture-erasure", subjectGeneration: 1,
        t3aReceiptSha256: "b".repeat(64) }, 1000);
      expect(settled).toBe(false); expect(runtime.snapshot(subject.tenantId).providerOperations).toBe(1);
      releaseAck.resolve(); await rejected;
      if (drain) await expect(drain).resolves.toMatchObject({ activeOperationCountAfter: 0 });
      expect(runtime.snapshot(subject.tenantId).providerOperations).toBe(0);
      expect(quota.slots[0]!.release).toHaveBeenCalledOnce();
    } finally { releaseAck.resolve(); await Promise.allSettled([rejected, ...(drain ? [drain] : [])]); }
  });

  it("keeps both leases during an actual consumer cancellation barrier", async () => {
    const runtime = new TenantRuntimeCoordinator(), cancelEntered = barrier(), cancelAck = barrier();
    const f = await fixture({ runtime, fetch: async () => new Response(new ReadableStream<Uint8Array>({
      async cancel() { cancelEntered.resolve(); await cancelAck.promise; },
    })) });
    const response = await f.resolved.fetch!("https://provider.example/v1/chat");
    let settled = false; const cancelled = response.body!.cancel().finally(() => { settled = true; });
    try {
      await cancelEntered.promise;
      expect(settled).toBe(false); expect(f.quota.slots[0]!.release).not.toHaveBeenCalled();
      expect(runtime.snapshot(subject.tenantId).providerOperations).toBe(1);
      cancelAck.resolve(); await cancelled;
      expect(f.quota.slots[0]!.release).toHaveBeenCalledOnce(); expect(runtime.snapshot(subject.tenantId).providerOperations).toBe(0);
    } finally { cancelAck.resolve(); await Promise.allSettled([cancelled]); }
  });

  it("aborts real body consumption on lost slot without releasing before cancellation settles", async () => {
    const cancelEntered = barrier(), cancelAck = barrier(), runtime = new TenantRuntimeCoordinator();
    const f = await fixture({ runtime, fetch: async () => new Response(new ReadableStream<Uint8Array>({
      async cancel() { cancelEntered.resolve(); await cancelAck.promise; },
    })) });
    const response = await f.resolved.fetch!("https://provider.example/v1/chat"), consumed = response.text();
    const rejected = expect(consumed).rejects.toBeInstanceOf(ProviderQuotaError);
    try {
      f.quota.slots[0]!.abort.abort(new ProviderQuotaError("unavailable")); await cancelEntered.promise;
      expect(f.quota.slots[0]!.release).not.toHaveBeenCalled(); expect(runtime.snapshot(subject.tenantId).providerOperations).toBe(1);
      cancelAck.resolve(); await rejected; await f.quota.slots[0]!.released.promise;
      expect(f.quota.slots[0]!.release).toHaveBeenCalledOnce();
    } finally { cancelAck.resolve(); await Promise.allSettled([rejected, f.quota.slots[0]!.released.promise]); }
  });

  it("keeps T3b drain pending until the quota stream's actual cancellation acknowledgement", async () => {
    const cancelEntered = barrier(), cancelAck = barrier(), runtime = new TenantRuntimeCoordinator();
    const f = await fixture({ runtime, fetch: async () => new Response(new ReadableStream<Uint8Array>({
      async cancel() { cancelEntered.resolve(); await cancelAck.promise; },
    })) }); runtime.sealParticipants();
    const response = await f.resolved.fetch!("https://provider.example/v1/chat");
    const consumed = expect(response.text()).rejects.toMatchObject({ name: "AbortError" });
    let drained = false;
    const drain = runtime.drain({ tenantId: subject.tenantId, requestId: "fixture-erasure", subjectGeneration: 1,
      t3aReceiptSha256: "b".repeat(64) }, 1000).then(value => { drained = true; return value; });
    try {
      await cancelEntered.promise; expect(drained).toBe(false); expect(f.quota.slots[0]!.release).not.toHaveBeenCalled();
      cancelAck.resolve(); await consumed; await expect(drain).resolves.toMatchObject({ activeOperationCountAfter: 0 });
    } finally { cancelAck.resolve(); await Promise.allSettled([consumed, drain]); }
  });

  it("cancels a late response before releasing after lost authority", async () => {
    const fetchEntered = barrier(), fetchAck = barrier(), cancelEntered = barrier(), cancelAck = barrier();
    const f = await fixture({ fetch: async () => {
      fetchEntered.resolve(); await fetchAck.promise;
      return new Response(new ReadableStream<Uint8Array>({ async cancel() { cancelEntered.resolve(); await cancelAck.promise; } }));
    } });
    const pending = f.resolved.fetch!("https://provider.example/v1/chat"), rejected = expect(pending).rejects.toBeInstanceOf(ProviderQuotaError);
    try {
      await fetchEntered.promise; f.quota.slots[0]!.abort.abort(new ProviderQuotaError("unavailable")); fetchAck.resolve();
      await cancelEntered.promise; expect(f.quota.slots[0]!.release).not.toHaveBeenCalled();
      cancelAck.resolve(); await rejected; expect(f.quota.slots[0]!.release).toHaveBeenCalledOnce();
    } finally { fetchAck.resolve(); cancelAck.resolve(); await Promise.allSettled([rejected]); }
  });

  it("rejects stale handles after tightening, deletion and recreation without resetting the provider quota identity", async () => {
    const f = await fixture(), old = f.resolved;
    await f.service.upsertTenantProvider(subject.tenantId, { ...config(), quota: { concurrency: 1 } });
    await expect(old.fetch!("https://provider.example/v1/chat")).rejects.toBeInstanceOf(ProviderQuotaError);
    expect(f.delegate).not.toHaveBeenCalled(); expect(f.quota.enter).not.toHaveBeenCalled();
    const current = await f.service.resolve(subject, ref); await current.fetch!("https://provider.example/v1/chat");
    expect(f.quota.requests[0]!.provider).toEqual({ scope: "tenant", id: "fixture" });
    await f.service.deleteTenantProvider(subject.tenantId, ref.provider);
    await expect(current.fetch!("https://provider.example/v1/chat")).rejects.toBeInstanceOf(ProviderQuotaError);
    await f.service.upsertTenantProvider(subject.tenantId, config());
    await expect(current.fetch!("https://provider.example/v1/chat")).rejects.toBeInstanceOf(ProviderQuotaError);
    expect(f.delegate).toHaveBeenCalledOnce();
  });

  it("does not let an old no-quota handle bypass newly configured quota", async () => {
    const store = new MemorySessionStore(), cipher = new LocalAesGcmCipher(KEY), delegate = vi.fn(async () => new Response(null, { status: 204 }));
    const oldService = new ProviderService({ store, cipher, fetch: delegate, assertBaseUrl: async () => {} });
    await oldService.upsertTenantProvider(subject.tenantId, config());
    const old = await oldService.resolve(subject, ref);
    const currentService = new ProviderService({ store, cipher, assertBaseUrl: async () => {},
      quota: { coordinator: new RecordingQuota(), tenant: {}, user: {} } });
    await currentService.upsertTenantProvider(subject.tenantId, { ...config(), quota: { rpm: 1 } });
    await expect(old.fetch!("https://provider.example/v1/chat")).rejects.toBeInstanceOf(ProviderQuotaError);
    expect(delegate).not.toHaveBeenCalled();
  });

  it("rechecks config and tenant generation after a held admission before dispatch", async () => {
    for (const change of ["config", "tenant"] as const) {
      const entered = barrier(), resume = barrier(), quota = new RecordingQuota();
      quota.onEnter = async () => { entered.resolve(); await resume.promise; };
      const f = await fixture({ quota }); const pending = f.resolved.fetch!("https://provider.example/v1/chat");
      const rejected = change === "tenant" ? expect(pending).rejects.toBeInstanceOf(SubjectDeletingError)
        : expect(pending).rejects.toBeInstanceOf(ProviderQuotaError);
      try {
        await entered.promise;
        if (change === "tenant") await gateTenant(f.store);
        else await f.service.upsertTenantProvider(subject.tenantId, { ...config(), quota: { rpm: 1 } });
        resume.resolve(); await rejected; expect(f.delegate).not.toHaveBeenCalled(); expect(quota.slots[0]!.release).toHaveBeenCalledOnce();
      } finally { resume.resolve(); await Promise.allSettled([rejected]); }
    }
  });

  it("does not replace an original provider failure with an uncertain release or leak its private cause", async () => {
    const secret = "private-provider-and-release-canary", original = new Error(secret), quota = new RecordingQuota();
    quota.onEnter = async slot => { slot.releaseError = new Error(secret); };
    const f = await fixture({ quota, persisted: true, fetch: async () => { throw original; } });
    await expect(f.resolved.fetch!("https://provider.example/v1/chat")).rejects.toBe(original);
    await expect(f.service.resolve(subject, ref)).rejects.toMatchObject({ reason: "unavailable", message: "Provider admission is unavailable." });
    expect(f.delegate).toHaveBeenCalledOnce(); expect(JSON.stringify(f.records).includes(secret)).toBe(false);
  });

  it("rejects successful EOF if release is uncertain, fences later dispatch and retains no raw release cause", async () => {
    const quota = new RecordingQuota(); quota.onEnter = async slot => { slot.releaseError = new Error("private-release-canary"); };
    const f = await fixture({ quota, fetch: async () => new Response("completed") });
    const response = await f.resolved.fetch!("https://provider.example/v1/chat");
    await expect(response.text()).rejects.toMatchObject({ reason: "unavailable", message: "Provider admission is unavailable." });
    await expect(f.resolved.fetch!("https://provider.example/v1/chat")).rejects.toMatchObject({ reason: "unavailable" });
    expect(f.delegate).toHaveBeenCalledOnce(); expect(quota.slots[0]!.release).toHaveBeenCalledOnce();
  });

  it("preserves a real non-2xx status and body after EOF release failure but permanently fences later dispatch", async () => {
    const quota = new RecordingQuota(); quota.onEnter = async slot => { slot.releaseError = new Error("private-http-release-canary"); };
    const f = await fixture({ quota, fetch: async () => new Response("provider failed", { status: 503 }) });
    const response = await f.resolved.fetch!("https://provider.example/v1/chat");
    expect(response.status).toBe(503); expect(await response.text()).toBe("provider failed");
    await expect(f.resolved.fetch!("https://provider.example/v1/chat")).rejects.toMatchObject({ reason: "unavailable", message: "Provider admission is unavailable." });
    expect(f.delegate).toHaveBeenCalledOnce(); expect(quota.slots[0]!.release).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.records).includes("private-http-release-canary")).toBe(false);
  });
});

describe("legacy quota compatibility", () => {
  it.each([false, true])("legacy quota compatibility: rejects old over-limit rows before dispatch with Gateway enabled=%s", async enabled => {
    const store = new MemorySessionStore(), quota = new RecordingQuota(), delegate = vi.fn();
    const legacy = { ...config(), tenantId: subject.tenantId, quota: { rpm: 1_000_001, concurrency: 1_000_002 },
      createdAtMs: 1, updatedAtMs: 2 };
    // Store-level old rows remain readable; execution must not clamp or ignore their limits.
    await store.upsertProviderConfig(legacy);
    const before = await store.getProviderConfig(subject.tenantId, ref.provider);
    expect(before?.config).toEqual(legacy);
    const service = new ProviderService({ store, cipher: new LocalAesGcmCipher(KEY), assertBaseUrl: async () => {}, fetch: delegate,
      ...(enabled ? { quota: { coordinator: quota, tenant: {}, user: {} } } : {}) });
    try {
      const rejected = await service.resolve(subject, ref).then(() => undefined, error => error);
      expect(rejected).toBeInstanceOf(ApiError);
      expect(rejected).toMatchObject({ code: "invalid_request", message: "Invalid provider quota configuration." });
      expect(delegate).not.toHaveBeenCalled();
      expect(quota.enter).not.toHaveBeenCalled();
      expect(await store.getProviderConfig(subject.tenantId, ref.provider)).toEqual(before);
    } finally { await quota.close(); }
  });
});
