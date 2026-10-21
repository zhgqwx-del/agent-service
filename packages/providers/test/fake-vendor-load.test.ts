import { request } from "node:http";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { FakeVendor } from "../../testkit/src/fake-vendor.js";

async function observed(predicate: () => boolean): Promise<void> {
  const until = performance.now() + 5_000;
  while (!predicate()) {
    if (performance.now() >= until) throw new Error("native fixture observation did not settle");
    await setImmediate();
  }
}

describe("FakeVendor native I/O observations", () => {
  it("holds actual requests before the response and counts close rather than barrier arrival", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered = 0;
    const vendor = new FakeVendor({ beforeResponse: async signal => { entered++; await held; signal.throwIfAborted(); } });
    vendor.script({ text: "ok" }, { text: "ok" });
    const origin = await vendor.start();
    const pending = [0, 1].map(() => fetch(`${origin}/chat/completions`, { method: "POST", body: "{}" })
      .then(async response => { expect(response.status).toBe(200); await response.text(); }));
    const settled = Promise.allSettled(pending);
    try {
      await observed(() => entered === 2);
      expect(vendor.ioSnapshot).toEqual({ requests: 2, active: 2, peak: 2, closed: 0, accepted: 2, completed: 0, aborted: 0 });
      expect(Object.isFrozen(vendor.ioSnapshot)).toBe(true);
      release(); await Promise.all(pending);
    } finally { release(); await settled; await vendor.stop(); }
    expect(vendor.ioSnapshot).toEqual({ requests: 2, active: 0, peak: 2, closed: 2, accepted: 2, completed: 2, aborted: 0 });
  });

  it("observes cancelled native bodies and invalid requests without invoking a response barrier", async () => {
    let barrierCalls = 0;
    const vendor = new FakeVendor({ expectApiKey: "fixture-canary", beforeResponse: async () => { barrierCalls++; } });
    const origin = await vendor.start();
    const partial = request(`${origin}/chat/completions`, { method: "POST" });
    partial.on("error", () => {});
    const closed = new Promise<void>(resolve => partial.once("close", resolve));
    try {
      partial.flushHeaders();
      await observed(() => vendor.ioSnapshot.active === 1);
      partial.destroy(); await closed;
      const invalid = await fetch(`${origin}/chat/completions`, { method: "POST", body: "{}" });
      expect(invalid.status).toBe(401); await invalid.text();
      expect(barrierCalls).toBe(0);
    } finally { partial.destroy(); await closed; await vendor.stop(); }
    expect(vendor.ioSnapshot).toMatchObject({ requests: 2, active: 0, closed: 2 });
    expect(JSON.stringify(vendor.ioSnapshot)).not.toContain("fixture-canary");
  });

  it("delivers valid-request cancellation to the fixture barrier and joins native close", async () => {
    let entered = false, cancelled = false;
    const vendor = new FakeVendor({ beforeResponse: signal => new Promise<void>((_resolve, reject) => {
      entered = true;
      signal.addEventListener("abort", () => { cancelled = true; reject(new Error("fixture cancelled")); }, { once: true });
    }) });
    const origin = await vendor.start(), controller = new AbortController();
    const pending = fetch(`${origin}/chat/completions`, { method: "POST", body: "{}", signal: controller.signal });
    const settled = Promise.allSettled([pending]);
    try {
      await observed(() => entered); controller.abort();
      expect((await settled)[0]?.status).toBe("rejected");
      await observed(() => cancelled && vendor.ioSnapshot.active === 0);
    } finally { controller.abort(); await settled; await vendor.stop(); }
    expect(vendor.ioSnapshot).toMatchObject({ requests: 1, accepted: 1, completed: 0, aborted: 1, active: 0, closed: 1 });
  });
});
