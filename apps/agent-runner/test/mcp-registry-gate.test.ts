import { describe, expect, it } from "vitest";
import {
  INTERNAL_ROUTER_TOKEN_HEADER, INTERNAL_MCP_REGISTRY_READY_PATH,
  INTERNAL_MCP_REGISTRY_FLEET_ACK_HEADER, INTERNAL_MCP_REGISTRY_FLEET_ACK_VALUE,
  type McpRegistryIdentityCapability,
} from "@agent-service/protocol";
import { RouterMcpRegistryGate } from "../src/mcp-registry-gate.js";

const token = "private-internal-mcp-fleet-token-001";
const identity: McpRegistryIdentityCapability = {
  credentialKeyId: "mcp-local-v1", credentialKeySha256: "ab".repeat(32),
  callbackUrlSha256: "cd".repeat(32), coordinationNamespaceSha256: "ef".repeat(32),
};
const options = { routerBaseUrl: "https://router.example", internalToken: token };
const message = "Managed MCP configured fleet is unavailable";
const headers = { [INTERNAL_MCP_REGISTRY_FLEET_ACK_HEADER]: INTERNAL_MCP_REGISTRY_FLEET_ACK_VALUE,
  "cache-control": "no-store" };
const request = (init?: RequestInit): { nonce: string; identity: McpRegistryIdentityCapability } => JSON.parse(String(init?.body));
const response = (init?: RequestInit) => Response.json(request(init), { headers });
const signal = () => new AbortController().signal;

// Internal gate component tests; not a substitute for the real router/runner fleet vertical.
describe("managed MCP private configured-fleet gate", () => {
  it("sends one uncached nonce-bound proof per boundary with no user credential or identity", async () => {
    const calls: { input: string; init: RequestInit }[] = [];
    const gate = new RouterMcpRegistryGate({ ...options, fetchImpl: async (input, init) => {
      calls.push({ input: String(input), init: init! }); return response(init);
    } });
    await gate.requireFreshFleet(identity, signal()); await gate.requireFreshFleet(identity, signal());
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.input).toBe("https://router.example" + INTERNAL_MCP_REGISTRY_READY_PATH);
      expect(call.init.method).toBe("POST"); expect(call.init.redirect).toBe("manual");
      expect(Object.fromEntries(new Headers(call.init.headers))).toEqual({
        "content-type": "application/json", [INTERNAL_ROUTER_TOKEN_HEADER]: token,
      });
      expect(Object.keys(request(call.init)).sort()).toEqual(["identity", "nonce"]);
      expect(request(call.init).identity).toEqual(identity);
      expect(request(call.init).nonce).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(request(calls[0]!.init).nonce).not.toBe(request(calls[1]!.init).nonce);
  });
  it.each([
    { "cache-control": "max-age=60" },
    { [INTERNAL_MCP_REGISTRY_FLEET_ACK_HEADER]: "legacy" },
    { [INTERNAL_MCP_REGISTRY_FLEET_ACK_HEADER]: "" },
    { "content-type": "text/plain" },
  ])("rejects missing freshness or acknowledgement (%#)", async patch => {
    const gate = new RouterMcpRegistryGate({ ...options, fetchImpl: async (_input, init) =>
      Response.json(request(init), { headers: { ...headers, ...patch } }) });
    await expect(gate.requireFreshFleet(identity, signal())).rejects.toThrow(message);
  });
  it.each([302, 400, 503])("rejects status %s without accepting a cached or redirected proof", async status => {
    const gate = new RouterMcpRegistryGate({ ...options, fetchImpl: async () => new Response("", { status, headers }) });
    await expect(gate.requireFreshFleet(identity, signal())).rejects.toThrow(message);
  });
  it("rejects a valid-shaped response bound to a different request", async () => {
    const gate = new RouterMcpRegistryGate({ ...options, fetchImpl: async (_input, init) =>
      Response.json({ ...request(init), nonce: "00".repeat(32) }, { headers }) });
    await expect(gate.requireFreshFleet(identity, signal())).rejects.toThrow(message);
  });
  it.each(Object.keys(identity) as (keyof McpRegistryIdentityCapability)[])("rejects drift of %s", async field => {
    const gate = new RouterMcpRegistryGate({ ...options, fetchImpl: async (_input, init) =>
      Response.json({ ...request(init), identity: { ...identity,
        [field]: field === "credentialKeyId" ? "other-key" : "01".repeat(32) } }, { headers }) });
    await expect(gate.requireFreshFleet(identity, signal())).rejects.toThrow(message);
  });
  it("rejects extra fields and malformed JSON rather than accepting a partial proof", async () => {
    for (const extra of [true, false]) {
      const gate = new RouterMcpRegistryGate({ ...options, fetchImpl: async (_input, init) => extra
        ? Response.json({ ...request(init), unexpected: true }, { headers })
        : new Response("not json", { headers: { ...headers, "content-type": "application/json" } }) });
      await expect(gate.requireFreshFleet(identity, signal())).rejects.toThrow(message);
    }
  });
  it("bounds the streamed response and awaits cancellation", async () => {
    let cancelled = false;
    const gate = new RouterMcpRegistryGate({ ...options, fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(2049)); },
      async cancel() { await Promise.resolve(); cancelled = true; },
    }), { headers: { ...headers, "content-type": "application/json" } }) });
    await expect(gate.requireFreshFleet(identity, signal())).rejects.toThrow(message);
    expect(cancelled).toBe(true);
  });
  it("does not dispatch when the caller is already cancelled or leak its reason", async () => {
    let calls = 0; const cancelled = new AbortController(); cancelled.abort(new Error("private-fixture-value"));
    const gate = new RouterMcpRegistryGate({ ...options, fetchImpl: async (_input, init) => { calls++; return response(init); } });
    await expect(gate.requireFreshFleet(identity, cancelled.signal)).rejects.toThrow(message);
    expect(calls).toBe(0);
  });
  it("waits for an uncooperative late fetch and cancels its body before releasing the boundary", async () => {
    let release!: (value: Response) => void, cancelled = false, settled = false;
    const late = new Promise<Response>(resolve => { release = resolve; });
    const caller = new AbortController();
    const gate = new RouterMcpRegistryGate({ ...options, fetchImpl: async () => late });
    const operation = gate.requireFreshFleet(identity, caller.signal).then(
      () => { settled = true; return "unexpected"; }, error => { settled = true; return (error as Error).message; });
    caller.abort(); await Promise.resolve(); await Promise.resolve(); expect(settled).toBe(false);
    release(new Response(new ReadableStream({ async cancel() { await Promise.resolve(); cancelled = true; } }), { headers }));
    expect(await operation).toBe(message); expect(cancelled).toBe(true);
  });
  it("passes the whole request deadline to the actual transport without detached retries", async () => {
    let calls = 0;
    const gate = new RouterMcpRegistryGate({ ...options, requestTimeoutMs: 100, fetchImpl: async (_input, init) => {
      calls++; return new Promise<Response>((_resolve, reject) => {
        const requestSignal = init!.signal!;
        requestSignal.addEventListener("abort", () => reject(requestSignal.reason), { once: true });
        if (requestSignal.aborted) reject(requestSignal.reason);
      });
    } });
    await expect(gate.requireFreshFleet(identity, signal())).rejects.toThrow(message); expect(calls).toBe(1);
  });
  it("cancels and settles an open response stream when the whole request deadline expires", async () => {
    let cancelled = false, released!: () => void;
    const bodyClosed = new Promise<void>(resolve => { released = resolve; });
    const gate = new RouterMcpRegistryGate({ ...options, requestTimeoutMs: 100,
      fetchImpl: async () => new Response(new ReadableStream({
        async cancel() { await Promise.resolve(); cancelled = true; released(); },
      }), { headers: { ...headers, "content-type": "application/json" } }),
    });
    await expect(gate.requireFreshFleet(identity, signal())).rejects.toThrow(message);
    await bodyClosed;
    expect(cancelled).toBe(true);
  });
  it.each(["https://user:private-fixture-value@router.example", "https://router.example/path",
    "https://router.example?", "https://router.example#", "file:///tmp/router"])("rejects unsafe router origins (%#)", routerBaseUrl => {
    expect(() => new RouterMcpRegistryGate({ ...options, routerBaseUrl })).toThrow(message);
  });
});
