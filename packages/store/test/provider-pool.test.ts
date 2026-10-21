import { describe, expect, it } from "vitest";
import { MemoryProviderPoolCoordinator, captureProviderPoolInventory, captureProviderPoolOutcome, captureProviderPoolPolicy } from "../src/provider-pool-memory.js";
import { ProviderPoolError, type ProviderPoolInventory, type ProviderPoolLease } from "../src/provider-pool.js";

const inventory = (slots = ["a", "b"], version = "v1", providerId = "provider-a"): ProviderPoolInventory => ({
  version: "provider-key-pool-v1", providerId, slots: slots.map(id => ({ id, version })),
});
async function fixture(body: (f: { pool: MemoryProviderPoolCoordinator; now: (value: number) => void;
  lease: (source?: ProviderPoolInventory, policy?: Parameters<MemoryProviderPoolCoordinator["select"]>[1]) => Promise<ProviderPoolLease> }) => Promise<void>) {
  let now = 10_000;
  const pool = new MemoryProviderPoolCoordinator({ store: "memory", prefix: "pool-test", namespaceId: "pool-test", now: () => now });
  const leases = new Set<ProviderPoolLease>();
  try { await body({ pool, now: value => { now = value; }, lease: async (source = inventory(), policy = {}) => {
    const lease = await pool.acquire(await pool.select(source, policy, new AbortController().signal), new AbortController().signal); leases.add(lease); return lease;
  } }); }
  finally { await Promise.allSettled([...leases].map(lease => lease.release({ kind: "neutral" }))); await pool.close(); }
}
describe("memory platform provider pool", () => {
  it("requires explicit memory, closed settings and the shared quota namespace hash", async () => {
    expect(() => new MemoryProviderPoolCoordinator({ prefix: "p", namespaceId: "n" } as never)).toThrow(ProviderPoolError);
    expect(() => new MemoryProviderPoolCoordinator({ store: "memory", prefix: "p", namespaceId: "n", secret: "not-accepted" } as never)).toThrow(ProviderPoolError);
    await fixture(async f => { await f.pool.assertReady(); expect(f.pool.namespaceSha256).toMatch(/^[a-f0-9]{64}$/); });
  });
  it("copies and freezes inventory and policy without credential material", () => {
    const source = inventory(), copied = captureProviderPoolInventory(source); expect(copied).toEqual(source); expect(copied).not.toBe(source);
    expect(Object.isFrozen(copied)).toBe(true); expect(Object.isFrozen(copied.slots)).toBe(true); expect(Object.isFrozen(copied.slots[0])).toBe(true);
    expect(captureProviderPoolPolicy({})).toEqual({ threshold: 5, windowMs: 60000, cooldownMs: 30000, rateLimitCooldownMs: 30000 });
    expect(captureProviderPoolInventory(inventory(["a"], "v1", "中".repeat(100) + " ")).providerId).toBe("中".repeat(100) + " ");
  });
  it.each([
    () => ({ ...inventory(), secret: "x" }), () => inventory(["a", "a"]), () => inventory([]), () => inventory(Array.from({ length: 33 }, (_, n) => "s" + n)),
    () => inventory(["bad\n"]), () => ({ ...inventory(), slots: Array(1) }),
    () => ({ ...inventory(), slots: [{ id: "a", version: "v1", apiKey: "x" }] }),
    () => Object.defineProperty({}, "version", { get: () => { throw new Error("never"); }, enumerable: true }),
  ])("rejects malformed inventory without reading secrets or getters %#", make => {
    expect(() => captureProviderPoolInventory(make() as never)).toThrow(new ProviderPoolError("unavailable"));
  });
  it.each([{ threshold: 0 }, { threshold: 101 }, { windowMs: 99 }, { cooldownMs: 3600001 }, { rateLimitCooldownMs: NaN }, { threshold: undefined }, { extra: true }])("rejects an invalid closed policy %#", policy => {
    expect(() => captureProviderPoolPolicy(policy as never)).toThrow(ProviderPoolError);
  });
  it("round robins without acquiring a permit and rejects forged, cross-instance or reused selections", async () => {
    await fixture(async f => {
      const signal = new AbortController().signal, a = await f.pool.select(inventory(), {}, signal), b = await f.pool.select(inventory(), {}, signal);
      expect([a.slot.id, b.slot.id, (await f.pool.select(inventory(), {}, signal)).slot.id]).toEqual(["a", "b", "a"]);
      await expect(f.pool.acquire({ ...a }, signal)).rejects.toBeInstanceOf(ProviderPoolError);
      const other = new MemoryProviderPoolCoordinator({ store: "memory", prefix: "p", namespaceId: "n" });
      try { await expect(other.acquire(a, signal)).rejects.toBeInstanceOf(ProviderPoolError); } finally { await other.close(); }
      const lease = await f.pool.acquire(a, signal); try { await expect(f.pool.acquire(a, signal)).rejects.toBeInstanceOf(ProviderPoolError); } finally { await lease.release({ kind: "success" }); }
    });
  });
  it("counts consecutive failures inside the rolling window and resets on success", async () => {
    await fixture(async f => {
      const source = inventory(["a"]), policy = { threshold: 2, windowMs: 100, cooldownMs: 100 };
      await (await f.lease(source, policy)).release({ kind: "failure" }); f.now(10101);
      await (await f.lease(source, policy)).release({ kind: "failure" });
      await (await f.lease(source, policy)).release({ kind: "success" });
      await (await f.lease(source, policy)).release({ kind: "failure" });
      await (await f.lease(source, policy)).release({ kind: "failure" });
      await expect(f.pool.select(source, policy, new AbortController().signal)).rejects.toMatchObject({ reason: "open", retryAfterMs: 100 });
    });
  });
  it("grants one half-open probe and an old closed success cannot close its newer epoch", async () => {
    await fixture(async f => {
      const source = inventory(["a"]), policy = { threshold: 1, cooldownMs: 100 }, old = await f.lease(source, policy);
      await (await f.lease(source, policy)).release({ kind: "failure" }); f.now(10100);
      const signal = new AbortController().signal, a = await f.pool.select(source, policy, signal), b = await f.pool.select(source, policy, signal);
      const probe = await f.pool.acquire(a, signal);
      try {
        await expect(f.pool.acquire(b, signal)).rejects.toMatchObject({ reason: "open" }); await old.release({ kind: "success" });
        await expect(f.pool.select(source, policy, signal)).rejects.toMatchObject({ reason: "open" });
      } finally { await probe.release({ kind: "success" }); }
      await (await f.lease(source, policy)).release({ kind: "success" });
    });
  });
  it.each(["cancelled", "neutral"] as const)("a %s half-open probe reopens rather than declaring healthy", async kind => {
    await fixture(async f => { const source = inventory(["a"]), policy = { threshold: 1, cooldownMs: 100 };
      await (await f.lease(source, policy)).release({ kind: "failure" }); f.now(10100);
      await (await f.lease(source, policy)).release({ kind });
      await expect(f.pool.select(source, policy, new AbortController().signal)).rejects.toMatchObject({ reason: "open" }); });
  });
  it.each(["success", "credential_rejected"] as const)("an expired probe's late %s cannot mutate the next probe epoch", async kind => {
    await fixture(async f => { const source = inventory(["a"]), policy = { threshold: 1, cooldownMs: 100 };
      await (await f.lease(source, policy)).release({ kind: "failure" }); f.now(10100); const old = await f.lease(source, policy);
      f.now(40200); const next = await f.lease(source, policy);
      await old.release({ kind }); await expect(f.pool.select(source, policy, new AbortController().signal)).rejects.toMatchObject({ reason: "open" });
      await next.release({ kind: "success" }); });
  });
  it("disables only the exact slot version, skips it, and retains the tombstone across idle expiry", async () => {
    await fixture(async f => {
      await (await f.lease()).release({ kind: "credential_rejected" });
      expect((await f.pool.select(inventory(), {}, new AbortController().signal)).slot.id).toBe("b"); f.now(10_000_000);
      await expect(f.pool.select(inventory(["a"]), {}, new AbortController().signal)).rejects.toMatchObject({ reason: "disabled" });
      await (await f.lease(inventory(["a"], "v2"))).release({ kind: "success" });
      await (await f.lease(inventory(["a"], "v1", "provider-b"))).release({ kind: "success" });
    });
  });
  it("a valid concurrent credential rejection dominates a failure that already advanced the health epoch", async () => {
    await fixture(async f => { const source = inventory(["a"]), policy = { threshold: 1, cooldownMs: 100 };
      const failure = await f.lease(source, policy), rejected = await f.lease(source, policy);
      await failure.release({ kind: "failure" }); await rejected.release({ kind: "credential_rejected" });
      await expect(f.pool.select(source, policy, new AbortController().signal)).rejects.toMatchObject({ reason: "disabled" });
      await (await f.lease(inventory(["a"], "v2"), policy)).release({ kind: "success" });
    });
  });
  it.each([{ retryDelayMs: Number.MAX_SAFE_INTEGER }, { retryAtMs: Number.MAX_SAFE_INTEGER }, { retryAtMs: 1 }])("anchors and bounds rate-limit hints without immediate reopening %#", async hint => {
    await fixture(async f => { const source = inventory(["a"]), policy = { rateLimitCooldownMs: 100 };
      await (await f.lease(source, policy)).release({ kind: "rate_limited", ...hint });
      await expect(f.pool.select(source, policy, new AbortController().signal)).rejects.toMatchObject({ reason: "open", retryAfterMs: hint.retryAtMs === 1 ? 100 : 3600000 }); });
  });
  it("validates completion before mutation and makes only the same semantic outcome idempotent", async () => {
    await fixture(async f => { const lease = await f.lease();
      for (const outcome of [{ kind: "success", retryDelayMs: 1 }, { kind: "rate_limited", retryAtMs: 2, retryDelayMs: 1 }, { kind: { toString: () => "success" } }, { kind: "rate_limited", retryDelayMs: -1 }]) {
        await expect(lease.release(outcome as never)).rejects.toBeInstanceOf(ProviderPoolError); expect(lease.signal.aborted).toBe(false);
      }
      await lease.release({ kind: "rate_limited", retryDelayMs: 100 }); await lease.release({ retryDelayMs: 100, kind: "rate_limited" });
      await expect(lease.release({ kind: "success" })).rejects.toBeInstanceOf(ProviderPoolError);
      expect(captureProviderPoolOutcome({ kind: "success" })).toEqual({ kind: "success" }); });
  });
  it("close aborts but waits for real consumer release and external abort does not release", async () => {
    const pool = new MemoryProviderPoolCoordinator({ store: "memory", prefix: "p", namespaceId: "n" }), controller = new AbortController();
    const lease = await pool.acquire(await pool.select(inventory(), {}, controller.signal), controller.signal); controller.abort();
    expect(lease.signal.aborted).toBe(true); let closed = false; const closing = pool.close().then(() => { closed = true; });
    try { await Promise.resolve(); expect(closed).toBe(false); await expect(pool.assertReady()).rejects.toBeInstanceOf(ProviderPoolError); }
    finally { await lease.release({ kind: "cancelled" }); await closing; } expect(closed).toBe(true);
  });
  it("a backwards or invalid memory clock aborts the actual held consumer", async () => {
    await fixture(async f => { const lease = await f.lease(); f.now(1); await expect(lease.assertOpen()).rejects.toBeInstanceOf(ProviderPoolError);
      expect(lease.signal.aborted).toBe(true); await expect(lease.release({ kind: "neutral" })).rejects.toBeInstanceOf(ProviderPoolError); });
  });
});
