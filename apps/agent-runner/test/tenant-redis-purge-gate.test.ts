import { describe, expect, it, vi } from "vitest";
import {
  INTERNAL_ROUTER_TOKEN_HEADER,
  INTERNAL_TENANT_REDIS_PURGE_ACK_HEADER,
  INTERNAL_TENANT_REDIS_PURGE_ACK_VALUE,
  INTERNAL_TENANT_REDIS_PURGE_READY_PATH,
} from "@agent-service/protocol";
import { RouterTenantRedisPurgeGate } from "../src/tenant-redis-purge-gate.js";

const TOKEN = "tenant-redis-purge-private-token-0001";

describe("RouterTenantRedisPurgeGate", () => {
  it("accepts only the exact versioned no-store 204 acknowledgement", async () => {
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(null, {
      status: 204,
      headers: {
        [INTERNAL_TENANT_REDIS_PURGE_ACK_HEADER]: INTERNAL_TENANT_REDIS_PURGE_ACK_VALUE,
        "cache-control": "no-store",
      },
    }));
    const gate = new RouterTenantRedisPurgeGate({
      routerBaseUrl: "https://router.internal:8443/",
      internalToken: TOKEN,
      requestTimeoutMs: 1_000,
      fetchImpl,
    });

    await expect(gate.canExecute()).resolves.toBe(true);
    const [input, init] = fetchImpl.mock.calls[0]!;
    expect(String(input)).toBe(
      `https://router.internal:8443${INTERNAL_TENANT_REDIS_PURGE_READY_PATH}`,
    );
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get(INTERNAL_ROUTER_TOKEN_HEADER)).toBe(TOKEN);
  });

  it.each([
    new Response(null, { status: 200, headers: {
      [INTERNAL_TENANT_REDIS_PURGE_ACK_HEADER]: INTERNAL_TENANT_REDIS_PURGE_ACK_VALUE,
      "cache-control": "no-store",
    } }),
    new Response(null, { status: 204 }),
    new Response(null, { status: 204, headers: {
      [INTERNAL_TENANT_REDIS_PURGE_ACK_HEADER]: INTERNAL_TENANT_REDIS_PURGE_ACK_VALUE,
    } }),
    new Response(null, { status: 204, headers: {
      [INTERNAL_TENANT_REDIS_PURGE_ACK_HEADER]: "local-db-content-delete-v1",
      "cache-control": "no-store",
    } }),
    new Response(null, { status: 302, headers: {
      location: "https://other.internal/ready",
      [INTERNAL_TENANT_REDIS_PURGE_ACK_HEADER]: INTERNAL_TENANT_REDIS_PURGE_ACK_VALUE,
      "cache-control": "no-store",
    } }),
    new Response(null, { status: 503 }),
  ])("fails closed on response drift", async (response) => {
    const gate = new RouterTenantRedisPurgeGate({
      routerBaseUrl: "http://router.internal",
      internalToken: TOKEN,
      requestTimeoutMs: 1_000,
      fetchImpl: vi.fn(async () => response),
    });
    await expect(gate.canExecute()).resolves.toBe(false);
  });

  it("fails closed on transport errors and rejects unsafe configuration", async () => {
    const gate = new RouterTenantRedisPurgeGate({
      routerBaseUrl: "http://router.internal",
      internalToken: TOKEN,
      requestTimeoutMs: 1_000,
      fetchImpl: vi.fn(async () => { throw new Error("unreachable"); }),
    });
    await expect(gate.canExecute()).resolves.toBe(false);
    expect(() => new RouterTenantRedisPurgeGate({
      routerBaseUrl: "https://user:secret@router.internal/private",
      internalToken: TOKEN,
      requestTimeoutMs: 1_000,
    })).toThrow(/credential-free http\(s\) origin/);
    expect(() => new RouterTenantRedisPurgeGate({
      routerBaseUrl: "http://router.internal",
      internalToken: "short",
      requestTimeoutMs: 1_000,
    })).toThrow(/internalToken/);
  });
});
