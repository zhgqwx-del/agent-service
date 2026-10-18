import { describe, expect, it } from "vitest";
import { INTERNAL_ROUTER_TOKEN_HEADER, INTERNAL_RUNTIME_EXTENSIONS_READY_PATH,
  INTERNAL_RUNTIME_EXTENSIONS_ACK_HEADER, INTERNAL_RUNTIME_EXTENSIONS_ACK_VALUE,
  type RuntimeExtensionsIdentity } from "@agent-service/protocol";
import { RouterRuntimeExtensionsGate } from "../src/runtime-extensions-gate.js";

const identity: RuntimeExtensionsIdentity = { lifecycleHooksSha256: "a".repeat(64), subagentsSha256: "b".repeat(64) };
const options = { routerBaseUrl: "https://router.example", internalToken: "fixture-runtime-internal-token-0001" };
const headers = { "cache-control": "no-store", [INTERNAL_RUNTIME_EXTENSIONS_ACK_HEADER]: INTERNAL_RUNTIME_EXTENSIONS_ACK_VALUE };
const body = (init?: RequestInit) => JSON.parse(String(init?.body));
const message = "Runtime extensions configured fleet is unavailable";
const signal = () => new AbortController().signal;

// Resource-free transport component tests, not evidence of a real shared Store/runner vertical.
describe("lifecycle and subagent configured-fleet proof", () => {
  it("binds each actual request to a new nonce and the entire two-feature identity", async () => {
    const calls: RequestInit[] = [];
    const gate = new RouterRuntimeExtensionsGate({ ...options, fetchImpl: async (url, init) => {
      expect(String(url)).toBe(options.routerBaseUrl + INTERNAL_RUNTIME_EXTENSIONS_READY_PATH);
      expect(init?.method).toBe("POST"); expect(init?.redirect).toBe("manual");
      expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
        "content-type": "application/json", [INTERNAL_ROUTER_TOKEN_HEADER]: options.internalToken,
      });
      calls.push(init!); return Response.json(body(init), { headers });
    } });
    await gate.requireFreshFleet(identity, signal()); await gate.requireFreshFleet(identity, signal());
    expect(calls).toHaveLength(2); expect(body(calls[0]).nonce).not.toBe(body(calls[1]).nonce);
    expect(body(calls[0]).identity).toEqual(identity); expect(Object.keys(body(calls[0])).sort()).toEqual(["identity", "nonce"]);
  });
  it.each([
    { "cache-control": "max-age=60" }, { [INTERNAL_RUNTIME_EXTENSIONS_ACK_HEADER]: "legacy" },
    { "content-type": "text/plain" }, { "content-length": "2049" }, { "content-length": "1e3" },
  ])("rejects freshness, acknowledgement or framing drift (%#)", async patch => {
    const gate = new RouterRuntimeExtensionsGate({ ...options, fetchImpl: async (_url, init) => Response.json(body(init), { headers: { ...headers, ...patch } }) });
    await expect(gate.requireFreshFleet(identity, signal())).rejects.toThrow(message);
  });
  it.each([302, 400, 503])("never accepts or follows status %s", async status => {
    const gate = new RouterRuntimeExtensionsGate({ ...options, fetchImpl: async () => new Response("", { status, headers }) });
    await expect(gate.requireFreshFleet(identity, signal())).rejects.toThrow(message);
  });
  it.each(["nonce", "lifecycleHooksSha256", "subagentsSha256", "unexpected"])("rejects exact identity/nonce/closed-shape drift: %s", async field => {
    const gate = new RouterRuntimeExtensionsGate({ ...options, fetchImpl: async (_url, init) => {
      const value = body(init);
      if (field === "nonce") value.nonce = "0".repeat(64);
      else if (field === "unexpected") value.prompt = "fixture-private-canary";
      else value.identity[field] = "c".repeat(64);
      return Response.json(value, { headers });
    } });
    await expect(gate.requireFreshFleet(identity, signal())).rejects.toThrow(message);
  });
  it("rejects a dormant expected identity without any transport call", async () => {
    let calls = 0;
    const gate = new RouterRuntimeExtensionsGate({ ...options, fetchImpl: async () => { calls++; throw new Error(); } });
    await expect(gate.requireFreshFleet({ lifecycleHooksSha256: null, subagentsSha256: null }, signal())).rejects.toThrow(message);
    expect(calls).toBe(0);
  });
  it("does not dispatch a caller-cancelled operation or disclose its abort reason", async () => {
    let calls = 0; const controller = new AbortController(); controller.abort(new Error("fixture-private-canary"));
    const gate = new RouterRuntimeExtensionsGate({ ...options, fetchImpl: async () => { calls++; throw new Error(); } });
    await expect(gate.requireFreshFleet(identity, controller.signal)).rejects.toThrow(message); expect(calls).toBe(0);
  });
  it("retains the operation until a non-cooperative fetch actually settles and its late body is cancelled", async () => {
    let release!: (response: Response) => void, settled = false, cancelled = false;
    const late = new Promise<Response>(resolve => { release = resolve; }), controller = new AbortController();
    const gate = new RouterRuntimeExtensionsGate({ ...options, fetchImpl: async () => late });
    const pending = gate.requireFreshFleet(identity, controller.signal).then(() => "unexpected", error => (error as Error).message).finally(() => { settled = true; });
    controller.abort(); await Promise.resolve(); expect(settled).toBe(false);
    release(new Response(new ReadableStream({ async cancel() { await Promise.resolve(); cancelled = true; } }), { headers }));
    expect(await pending).toBe(message); expect(cancelled).toBe(true);
  });
  it("cancels and awaits an oversized body instead of leaving detached reads", async () => {
    let cancelled = false;
    const gate = new RouterRuntimeExtensionsGate({ ...options, fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(2049)); }, async cancel() { await Promise.resolve(); cancelled = true; },
    }), { headers: { ...headers, "content-type": "application/json" } }) });
    await expect(gate.requireFreshFleet(identity, signal())).rejects.toThrow(message); expect(cancelled).toBe(true);
  });
  it("applies one whole-operation deadline to response reads and awaits body cancellation", async () => {
    let cancelled = false;
    const gate = new RouterRuntimeExtensionsGate({ ...options, requestTimeoutMs: 100, fetchImpl: async () => new Response(new ReadableStream({
      async cancel() { await Promise.resolve(); cancelled = true; },
    }), { headers: { ...headers, "content-type": "application/json" } }) });
    await expect(gate.requireFreshFleet(identity, signal())).rejects.toThrow(message); expect(cancelled).toBe(true);
  });
  it.each(["https://user:private@router.example", "https://router.example/path", "https://router.example?", "https://router.example#", "file:///tmp/router"])("rejects unsafe operator origins (%#)", routerBaseUrl => {
    expect(() => new RouterRuntimeExtensionsGate({ ...options, routerBaseUrl })).toThrow(message);
  });
  it.each([0, 99, 5001, NaN, Infinity])("rejects an invalid RPC budget (%#)", requestTimeoutMs => {
    expect(() => new RouterRuntimeExtensionsGate({ ...options, requestTimeoutMs })).toThrow(message);
  });
});
