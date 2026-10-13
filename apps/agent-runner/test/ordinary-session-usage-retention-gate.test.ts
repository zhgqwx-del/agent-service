import { describe, expect, it, vi } from "vitest";
import { INTERNAL_ROUTER_TOKEN_HEADER, INTERNAL_SESSION_USAGE_RETENTION_ACK_HEADER,
  INTERNAL_SESSION_USAGE_RETENTION_ACK_VALUE, INTERNAL_SESSION_USAGE_RETENTION_READY_PATH } from "@agent-service/protocol";
import { RouterOrdinarySessionUsageRetentionGate } from "../src/ordinary-session-usage-retention-gate.js";

const token = "ordinary-usage-retention-local-token-0001";
const ack = { "cache-control": "no-store", [INTERNAL_SESSION_USAGE_RETENTION_ACK_HEADER]: INTERNAL_SESSION_USAGE_RETENTION_ACK_VALUE };
function gate(fetchImpl: typeof fetch) {
  return new RouterOrdinarySessionUsageRetentionGate({ routerBaseUrl: "http://router.internal/", internalToken: token, requestTimeoutMs: 1000, fetchImpl });
}

describe("ordinary session usage retention private gate", () => {
  it("requests an exact fresh, private 204/no-store ACK each time", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 204, headers: ack }));
    const client = gate(fetchImpl);
    expect(await client.canExecute()).toBe(true);
    expect(await client.canExecute()).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(`http://router.internal${INTERNAL_SESSION_USAGE_RETENTION_READY_PATH}`);
    expect(init?.method).toBe("GET"); expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get(INTERNAL_ROUTER_TOKEN_HEADER)).toBe(token);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    [200, ack], [404, ack], [503, ack], [302, { ...ack, location: "https://other.internal" }],
    [204, {}], [204, { [INTERNAL_SESSION_USAGE_RETENTION_ACK_HEADER]: INTERNAL_SESSION_USAGE_RETENTION_ACK_VALUE }],
    [204, { ...ack, "cache-control": "private" }],
    [204, { ...ack, [INTERNAL_SESSION_USAGE_RETENTION_ACK_HEADER]: "local-db-content-delete-v1" }],
    [204, { ...ack, [INTERNAL_SESSION_USAGE_RETENTION_ACK_HEADER]: "local-operational-usage-v2" }],
  ] as const)("denies status/cache/version drift (%s)", async (status, headers) => {
    expect(await gate(async () => new Response(null, { status, headers })).canExecute()).toBe(false);
  });

  it("denies network/timeout failures without exposing error text", async () => {
    expect(await gate(async () => { throw new Error("secret upstream detail"); }).canExecute()).toBe(false);
    expect(await gate(async () => { throw new DOMException("expired", "TimeoutError"); }).canExecute()).toBe(false);
  });

  it("has a bounded deadline even when an injected transport ignores abort", async () => {
    const client = new RouterOrdinarySessionUsageRetentionGate({ routerBaseUrl: "http://router.internal",
      internalToken: token, requestTimeoutMs: 100, fetchImpl: async () => new Promise<Response>(() => {}) });
    expect(await client.canExecute()).toBe(false);
  });

  it("rejects unsafe origins, private tokens and unbounded request timeouts", () => {
    for (const routerBaseUrl of ["https://user:secret@router", "http://router/private", "http://router?", "http://router/#", "ftp://router", "invalid"]) {
      expect(() => new RouterOrdinarySessionUsageRetentionGate({ routerBaseUrl, internalToken: token, requestTimeoutMs: 1000 })).toThrow();
    }
    for (const value of [{ internalToken: "short", requestTimeoutMs: 1000 }, { internalToken: token, requestTimeoutMs: 0 }, { internalToken: token, requestTimeoutMs: 30_001 }]) {
      expect(() => new RouterOrdinarySessionUsageRetentionGate({ routerBaseUrl: "http://router", ...value })).toThrow();
    }
  });
});
