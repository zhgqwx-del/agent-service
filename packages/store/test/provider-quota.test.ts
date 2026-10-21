import { describe, expect, it } from "vitest";
import { MemoryProviderQuotaCoordinator, captureProviderQuotaRequest } from "../src/provider-quota-memory.js";
import { ProviderQuotaError, providerQuotaNamespaceSha256, type ProviderQuotaLease, type ProviderQuotaRequest } from "../src/provider-quota.js";

const request = (patch: Partial<ProviderQuotaRequest> = {}): ProviderQuotaRequest => ({ tenantId: "tenant-a", userId: "user-a",
  provider: { scope: "platform", id: "provider-a" }, tenant: {}, user: {}, providerLimit: {}, ...patch });
const coordinator = (now?: () => number) => new MemoryProviderQuotaCoordinator({ store: "memory", prefix: "quota-test", namespaceId: "memory-test", ...(now ? { now } : {}) });
const signal = () => new AbortController().signal;

describe("explicit Memory provider quota", () => {
  it("uses the independent namespace domain and keeps identities out of captured layer keys", async () => {
    const quota = coordinator();
    expect(quota.namespaceSha256).toBe(providerQuotaNamespaceSha256({ prefix: "quota-test", namespaceId: "memory-test" }));
    const layers = captureProviderQuotaRequest(request());
    expect(layers).toHaveLength(3); expect(new Set(layers.map(x => x.identitySha256)).size).toBe(3);
    expect(JSON.stringify(layers)).not.toContain("tenant-a"); expect(JSON.stringify(layers)).not.toContain("provider-a");
    expect(Object.isFrozen(layers)).toBe(true); expect(layers.every(Object.isFrozen)).toBe(true);
    await quota.assertReady(); await quota.close(); await expect(quota.assertReady()).rejects.toBeInstanceOf(ProviderQuotaError);
  });
  it("atomically checks tenant, user and provider without consuming other tiers on a denial", async () => {
    const quota = coordinator(); const base = request({ tenant: { rpm: 2 }, user: { rpm: 1 }, providerLimit: { rpm: 2 } });
    try {
      const first = await quota.enter(base, signal()); await first.release();
      await expect(quota.enter(base, signal())).rejects.toMatchObject({ reason: "rpm" });
      const second = await quota.enter({ ...base, userId: "user-b" }, signal()); await second.release();
      await expect(quota.enter({ ...base, userId: "user-c" }, signal())).rejects.toMatchObject({ reason: "rpm" });
    } finally { await quota.close(); }
  });
  it("does not refund RPM on release and expires the exact rolling sixty-second boundary", async () => {
    let now = 1000; const quota = coordinator(() => now), input = request({ tenant: { rpm: 1 } });
    try {
      const lease = await quota.enter(input, signal()); await lease.release(); await lease.release();
      now = 60_999; await expect(quota.enter(input, signal())).rejects.toMatchObject({ reason: "rpm", retryAfterMs: 1 });
      now = 61_000; const next = await quota.enter(input, signal()); await next.release();
    } finally { await quota.close(); }
  });
  it("shares platform provider limits across tenants but not tenant provider identities", async () => {
    const tenantId = "中".repeat(100) + " ", providerId = "模".repeat(100) + " ";
    const quota = coordinator(), first = await quota.enter(request({ tenantId, provider: { scope: "platform", id: providerId }, providerLimit: { concurrency: 1 } }), signal());
    try {
      await expect(quota.enter(request({ tenantId: tenantId + "b", provider: { scope: "platform", id: providerId }, providerLimit: { concurrency: 1 } }), signal())).rejects.toMatchObject({ reason: "concurrency" });
      const scopedA = await quota.enter(request({ tenantId, provider: { scope: "tenant", id: providerId }, providerLimit: { concurrency: 1 } }), signal());
      const scopedB = await quota.enter(request({ tenantId: tenantId + "b", provider: { scope: "tenant", id: providerId }, providerLimit: { concurrency: 1 } }), signal());
      await scopedA.release(); await scopedB.release();
    } finally { await first.release(); await quota.close(); }
  });
  it("isolates per-user limits while enforcing the shared tenant concurrency ceiling", async () => {
    const quota = coordinator(), base = request({ tenant: { concurrency: 2 }, user: { concurrency: 1 } });
    const first = await quota.enter(base, signal()); let second: ProviderQuotaLease | undefined;
    try {
      await expect(quota.enter(base, signal())).rejects.toMatchObject({ reason: "concurrency" });
      second = await quota.enter({ ...base, userId: "user-b" }, signal());
      await expect(quota.enter({ ...base, userId: "user-c" }, signal())).rejects.toMatchObject({ reason: "concurrency" });
    } finally { await first.release(); await second?.release(); await quota.close(); }
  });
  it("consumer abort fences execution but holds its slot until actual consumer release", async () => {
    const quota = coordinator(), controller = new AbortController(), input = request({ tenant: { concurrency: 1 } });
    const lease = await quota.enter(input, controller.signal);
    try {
      controller.abort(); expect(lease.signal.aborted).toBe(true);
      await expect(lease.assertOpen()).rejects.toMatchObject({ reason: "unavailable" });
      await expect(quota.enter(input, signal())).rejects.toMatchObject({ reason: "concurrency" });
      await lease.release(); const next = await quota.enter(input, signal()); await next.release();
    } finally { await lease.release(); await quota.close(); }
  });
  it("close aborts real consumers and waits their release rather than pretending I/O stopped", async () => {
    const quota = coordinator(), lease = await quota.enter(request(), signal()); let closed = false;
    const closing = quota.close().then(() => { closed = true; });
    try {
      expect(lease.signal.aborted).toBe(true); await Promise.resolve(); expect(closed).toBe(false);
      await expect(quota.enter(request(), signal())).rejects.toMatchObject({ reason: "unavailable" });
      await lease.release(); await closing; expect(closed).toBe(true); expect(quota.close()).toBe(quota.close());
    } finally { await lease.release(); await closing; }
  });
  it("renews concurrency without creating another request in the RPM window", async () => {
    let now = 1000; const quota = coordinator(() => now), input = request({ tenant: { rpm: 2, concurrency: 1 } });
    const first = await quota.enter(input, signal());
    try {
      now = 29_000; await first.assertOpen(); now = 50_000; await first.assertOpen();
      await first.release(); const second = await quota.enter(input, signal()); await second.release();
      await expect(quota.enter(input, signal())).rejects.toMatchObject({ reason: "rpm" });
    } finally { await first.release(); await quota.close(); }
  });
  it("fences an expired lease without treating its abort as a completed release", async () => {
    let now = 1000; const quota = coordinator(() => now), first = await quota.enter(request(), signal());
    try {
      now = 31_000; await expect(first.assertOpen()).rejects.toBeInstanceOf(ProviderQuotaError);
      expect(first.signal.aborted).toBe(true);
    } finally { await first.release(); await quota.close(); }
  });
  it("captures a copy of limits and rejects a clock rollback with a fixed error", async () => {
    let now = 1000; const quota = coordinator(() => now), mutable = { concurrency: 1 };
    const first = await quota.enter(request({ tenant: mutable }), signal());
    try {
      mutable.concurrency = 10; now = 999;
      await expect(first.assertOpen()).rejects.toMatchObject({ reason: "unavailable", message: "Provider admission is unavailable." });
      expect(first.signal.aborted).toBe(true);
    } finally { await first.release(); await quota.close(); }
  });
  it("rejects an already-aborted admission without consuming RPM", async () => {
    const quota = coordinator(), controller = new AbortController(); controller.abort();
    try {
      await expect(quota.enter(request({ tenant: { rpm: 1 } }), controller.signal)).rejects.toMatchObject({ reason: "unavailable" });
      const next = await quota.enter(request({ tenant: { rpm: 1 } }), signal()); await next.release();
    } finally { await quota.close(); }
  });
  it.each([0, -1, 1.5, 1_000_001, Infinity, NaN])("rejects invalid bounded limits before admitting: %s", async value => {
    const quota = coordinator();
    try { await expect(quota.enter(request({ tenant: { rpm: value } }), signal())).rejects.toMatchObject({ reason: "unavailable" }); }
    finally { await quota.close(); }
  });
  it("rejects getters, hidden keys, secret fields and malformed identities without evaluating them", async () => {
    const quota = coordinator(); let getters = 0;
    const getter = Object.defineProperty({}, "rpm", { enumerable: true, get() { getters++; return 1; } });
    const hidden = Object.defineProperty({}, "rpm", { enumerable: false, value: 1 });
    try {
      for (const tenant of [getter, hidden, { rpm: 1, apiKey: "never-accepted" }]) {
        await expect(quota.enter(request({ tenant }), signal())).rejects.toMatchObject({ reason: "unavailable" });
      }
      await expect(quota.enter(request({ userId: "bad\nidentity" }), signal())).rejects.toMatchObject({ reason: "unavailable" });
      await expect(quota.enter(request({ userId: "trailing-newline\n" }), signal())).rejects.toMatchObject({ reason: "unavailable" });
      expect(getters).toBe(0);
    } finally { await quota.close(); }
  });
  it("requires explicit memory mode and rejects namespace/options widening", () => {
    for (const options of [{ prefix: "q", namespaceId: "n" }, { store: "mysql", prefix: "q", namespaceId: "n" },
      { store: "memory", prefix: "q{raw}", namespaceId: "n" }, { store: "memory", prefix: "q", namespaceId: "n", secret: "not-allowed" },
      { store: "memory", prefix: "q", namespaceId: "n", leaseMs: 300, renewIntervalMs: 200 }]) {
      expect(() => new MemoryProviderQuotaCoordinator(options as never)).toThrow("Provider admission is unavailable.");
    }
  });
});
