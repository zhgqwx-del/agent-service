import { afterEach, describe, expect, it, vi } from "vitest";
import { Capabilities, PROTOCOL_VERSION, ORDINARY_SESSION_USAGE_RETENTION_LOCAL_V1,
  INTERNAL_ROUTER_TOKEN_HEADER, INTERNAL_SESSION_USAGE_RETENTION_ACK_HEADER,
  INTERNAL_SESSION_USAGE_RETENTION_ACK_VALUE, INTERNAL_SESSION_USAGE_RETENTION_READY_PATH } from "@agent-service/protocol";
import { createRouterApp } from "../src/app.js";
import { RunnerRegistry } from "../src/registry.js";

const token = "ordinary-usage-retention-local-token-0001";
const registries: RunnerRegistry[] = [];
afterEach(async () => { await Promise.all(registries.splice(0).map((r) => r.close())); vi.unstubAllGlobals(); });

function document(aware = true, worker = true) {
  return { protocolVersion: PROTOCOL_VERSION, service: "agent-runner", features: {
    streaming: true, replay: { persistedEvents: true, hotWindowMs: 1 }, approvals: true,
    sessionLifecycle: ["archive", "unarchive", "tombstone"],
    ...(aware ? { ordinarySessionUsageRetention: [ORDINARY_SESSION_USAGE_RETENTION_LOCAL_V1], ordinarySessionUsageRetentionWorker: worker } : {}),
    dynamicTools: true, mcp: [], skills: false, sandbox: ["none"], byok: true,
  } };
}

describe("ordinary session usage retention fresh all-configured gate", () => {
  it("requires every configured URL healthy, exact code-aware and active, without sticky ACK", async () => {
    let state: "legacy" | "code-only" | "active" | "down" | "malformed" | "redirect" | "cap-redirect" = "legacy";
    let probes = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/readyz")) {
        probes++;
        if (url.startsWith("http://b/") && state === "redirect") return new Response(null, { status: 302, headers: { location: "http://a/readyz" } });
        return new Response("ready", { status: url.startsWith("http://b/") && state === "down" ? 503 : 200 });
      }
      if (url.endsWith("/v1/capabilities")) {
        if (url.startsWith("http://a/")) return Response.json(document());
        if (state === "cap-redirect") return new Response(null, { status: 302, headers: { location: "http://a/v1/capabilities" } });
        if (state === "malformed") return Response.json({ ...document(), features: { ...document().features, ordinarySessionUsageRetention: ["future-v9"] } });
        return Response.json(document(state !== "legacy", state === "active"));
      }
      return new Response(null, { status: 404 });
    }));
    const registry = new RunnerRegistry({ runners: ["http://a", "http://b"], healthIntervalMs: 60_000 });
    registries.push(registry); registry.start(); await registry.waitForFirstProbe();
    const app = createRouterApp({ registry, internalRunnerToken: token, ordinarySessionUsageRetentionEnabled: () => true, logger: { info() {}, warn() {}, error() {} } });
    const request = () => app.request(INTERNAL_SESSION_USAGE_RETENTION_READY_PATH, { headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: token } });
    const initial = probes;
    const hidden = await app.request(INTERNAL_SESSION_USAGE_RETENTION_READY_PATH, { headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: "wrong-private-token-000000000000" } });
    expect(hidden.status).toBe(404); expect(probes).toBe(initial);
    for (const next of ["legacy", "code-only", "active", "down", "active", "malformed", "redirect", "cap-redirect"] as const) {
      state = next;
      const previous = probes;
      const response = await request();
      expect(probes).toBe(previous + 2);
      expect(response.status).toBe(next === "active" ? 204 : 503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get(INTERNAL_SESSION_USAGE_RETENTION_ACK_HEADER)).toBe(next === "active" ? INTERNAL_SESSION_USAGE_RETENTION_ACK_VALUE : null);
    }
    state = "active";
    expect((await request()).status).toBe(204);
    const off = createRouterApp({ registry, internalRunnerToken: token, logger: { info() {}, warn() {}, error() {} } });
    expect((await off.request(INTERNAL_SESSION_USAGE_RETENTION_READY_PATH, { headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: token } })).status).toBe(503);
    const draining = createRouterApp({ registry, internalRunnerToken: token, ready: () => false,
      ordinarySessionUsageRetentionEnabled: () => true, logger: { info() {}, warn() {}, error() {} } });
    const beforeDrain = probes;
    const denied = await draining.request(INTERNAL_SESSION_USAGE_RETENTION_READY_PATH, { headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: token } });
    expect(denied.status).toBe(503); expect(denied.headers.get(INTERNAL_SESSION_USAGE_RETENTION_ACK_HEADER)).toBeNull();
    expect(probes).toBe(beforeDrain);
    for (const [path, method] of [[INTERNAL_SESSION_USAGE_RETENTION_READY_PATH, "POST"], [`${INTERNAL_SESSION_USAGE_RETENTION_READY_PATH}/extra`, "GET"]]) {
      expect((await app.request(path!, { method, headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: token } })).status).toBe(404);
    }
    expect(vi.mocked(fetch).mock.calls.every((call) => call[1]?.redirect === "manual")).toBe(true);
    const publicCaps = Capabilities.parse(await (await app.request("/v1/capabilities")).json());
    expect(publicCaps.features.ordinarySessionUsageRetention).toEqual([ORDINARY_SESSION_USAGE_RETENTION_LOCAL_V1]);
    expect(publicCaps.features.dataPurgeExecution).toBe(false);
    expect(publicCaps.features.sessionLifecycle).not.toContain("purge");
  });

  it("normalizes old documents to no authority and rejects unknown versions", () => {
    const legacy = Capabilities.parse(document(false));
    expect(legacy.features.ordinarySessionUsageRetention).toEqual([]);
    expect(legacy.features.ordinarySessionUsageRetentionWorker).toBe(false);
    expect(Capabilities.safeParse({ ...document(), features: { ...document().features, ordinarySessionUsageRetention: ["unknown-v2"] } }).success).toBe(false);
  });

  it("queues distinct dedicated probes after an overlapping periodic probe", async () => {
    let release!: () => void;
    let readyCalls = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (String(input).endsWith("/readyz")) {
        readyCalls++;
        if (readyCalls === 1) await new Promise<void>((resolve) => { release = resolve; });
        return new Response(null, { status: 200 });
      }
      return Response.json(document(true, false));
    });
    vi.stubGlobal("fetch", fetcher);
    const registry = new RunnerRegistry({ runners: ["http://a"] });
    registries.push(registry);
    const periodic = registry.refresh();
    await vi.waitFor(() => expect(readyCalls).toBe(1));
    const first = registry.refreshOrdinarySessionUsageRetention();
    const second = registry.refreshOrdinarySessionUsageRetention();
    await Promise.resolve();
    expect(readyCalls).toBe(1);
    release();
    await Promise.all([periodic, first, second]);
    expect(readyCalls).toBe(3); // Neither dedicated request inherits an earlier probe.
    expect(registry.allConfiguredSupportOrdinarySessionUsageRetention()).toBe(true);
    expect(registry.allConfiguredSupportOrdinarySessionUsageRetentionWorker()).toBe(false);
  });

  it("fails a waiting boundary on deadline and never starts its expired queued probe", async () => {
    let release!: () => void;
    let readyCalls = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (String(input).endsWith("/readyz")) {
        readyCalls++;
        if (readyCalls === 1) await new Promise<void>((resolve) => { release = resolve; });
        return new Response(null, { status: 200 });
      }
      return Response.json(document());
    }));
    const registry = new RunnerRegistry({ runners: ["http://a"] });
    registries.push(registry);
    const periodic = registry.refresh();
    await vi.waitFor(() => expect(readyCalls).toBe(1));
    const app = createRouterApp({ registry, internalRunnerToken: token,
      ordinarySessionUsageRetentionEnabled: () => true, logger: { info() {}, warn() {}, error() {} } });
    const response = await app.request(INTERNAL_SESSION_USAGE_RETENTION_READY_PATH, {
      headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: token }, signal: AbortSignal.timeout(20),
    });
    expect(response.status).toBe(503);
    expect(response.headers.get(INTERNAL_SESSION_USAGE_RETENTION_ACK_HEADER)).toBeNull();
    release();
    await periodic;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readyCalls).toBe(1);
  });

  it("never ACKs a dedicated probe whose own capability request exceeds the boundary deadline", async () => {
    let probes = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      if (String(input).endsWith("/readyz")) { probes++; return new Response(null, { status: 200 }); }
      await new Promise<void>((_, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error("missing probe deadline");
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        if (signal.aborted) reject(signal.reason);
      });
      return Response.json(document());
    }));
    const registry = new RunnerRegistry({ runners: ["http://a"] });
    registries.push(registry);
    const app = createRouterApp({ registry, internalRunnerToken: token,
      ordinarySessionUsageRetentionEnabled: () => true, logger: { info() {}, warn() {}, error() {} } });
    const response = await app.request(INTERNAL_SESSION_USAGE_RETENTION_READY_PATH, {
      headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: token }, signal: AbortSignal.timeout(20),
    });
    expect(probes).toBe(1);
    expect(response.status).toBe(503);
    expect(response.headers.get(INTERNAL_SESSION_USAGE_RETENTION_ACK_HEADER)).toBeNull();
  });

  it("rechecks shutdown readiness and activation after the fresh probe completes", async () => {
    let ready = true;
    let enabled = true;
    let release: (() => void) | undefined;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (String(input).endsWith("/readyz")) return new Response(null, { status: 200 });
      await new Promise<void>((resolve) => { release = resolve; });
      return Response.json(document());
    }));
    const registry = new RunnerRegistry({ runners: ["http://a"] });
    registries.push(registry);
    const app = createRouterApp({ registry, internalRunnerToken: token, ready: () => ready,
      ordinarySessionUsageRetentionEnabled: () => enabled, logger: { info() {}, warn() {}, error() {} } });
    for (const close of ["shutdown", "gate"] as const) {
      ready = true; enabled = true; release = undefined;
      const pending = app.request(INTERNAL_SESSION_USAGE_RETENTION_READY_PATH, { headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: token } });
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      if (close === "shutdown") ready = false; else enabled = false;
      release!();
      const response = await pending;
      expect(response.status).toBe(503);
      expect(response.headers.get(INTERNAL_SESSION_USAGE_RETENTION_ACK_HEADER)).toBeNull();
    }
  });

  it("keeps periodic probes separate from an expired retention queue", async () => {
    let release!: () => void;
    let readyCalls = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (String(input).endsWith("/readyz")) {
        readyCalls++;
        if (readyCalls === 1) await new Promise<void>((resolve) => { release = resolve; });
        return new Response(null, { status: 200 });
      }
      return Response.json(document());
    }));
    const registry = new RunnerRegistry({ runners: ["http://a"], healthIntervalMs: 5 });
    registries.push(registry); registry.start();
    await vi.waitFor(() => expect(readyCalls).toBe(1));
    await expect(registry.refreshOrdinarySessionUsageRetention(AbortSignal.timeout(20))).rejects.toThrow();
    release();
    await vi.waitFor(() => expect(readyCalls).toBeGreaterThanOrEqual(2));
    expect(registry.allConfiguredSupportOrdinarySessionUsageRetentionWorker()).toBe(true);
  });

  it("does not let an expired queued request masquerade as an actual old refresh probe", async () => {
    let release!: () => void;
    let readyCalls = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (String(input).endsWith("/readyz")) {
        readyCalls++;
        if (readyCalls === 1) await new Promise<void>((resolve) => { release = resolve; });
        return new Response(null, { status: 200 });
      }
      return Response.json(document());
    }));
    const registry = new RunnerRegistry({ runners: ["http://a"] });
    registries.push(registry);
    const actual = registry.refresh();
    await vi.waitFor(() => expect(readyCalls).toBe(1));
    await expect(registry.refreshOrdinarySessionUsageRetention(AbortSignal.timeout(20))).rejects.toThrow();
    release();
    await actual;
    await registry.refresh(); // Must begin/follow a real new probe, never just the expired queue tail.
    expect(readyCalls).toBe(2);
  });

  it("closes pending retention requests without starting another probe after shutdown", async () => {
    let release!: () => void;
    let readyCalls = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (String(input).endsWith("/readyz")) {
        readyCalls++;
        if (readyCalls === 1) await new Promise<void>((resolve) => { release = resolve; });
        return new Response(null, { status: 200 });
      }
      return Response.json(document());
    }));
    const registry = new RunnerRegistry({ runners: ["http://a"] });
    registries.push(registry);
    const actual = registry.refresh();
    await vi.waitFor(() => expect(readyCalls).toBe(1));
    const queued = registry.refreshOrdinarySessionUsageRetention();
    const rejected = expect(queued).rejects.toThrow(/closing/);
    const closed = registry.close();
    release();
    await Promise.all([actual, rejected, closed]);
    expect(readyCalls).toBe(1);
    await expect(registry.refreshOrdinarySessionUsageRetention()).rejects.toThrow(/closing/);
  });
});
