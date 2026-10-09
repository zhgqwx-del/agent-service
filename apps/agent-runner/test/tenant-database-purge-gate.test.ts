import { describe, expect, it, vi } from "vitest";
import {
  INTERNAL_ROUTER_TOKEN_HEADER,
  INTERNAL_TENANT_DATABASE_PURGE_ACK_HEADER,
  INTERNAL_TENANT_DATABASE_PURGE_ACK_VALUE,
  INTERNAL_TENANT_DATABASE_PURGE_READY_PATH,
} from "@agent-service/protocol";
import { RouterTenantDatabasePurgeGate } from "../src/tenant-database-purge-gate.js";

const TOKEN = "tenant-database-purge-private-token-0001";

describe("RouterTenantDatabasePurgeGate", () => {
  it("accepts only the exact versioned 204 acknowledgement", async () => {
    const fetchImpl = vi.fn(async (
      _input: Parameters<typeof globalThis.fetch>[0],
      _init?: Parameters<typeof globalThis.fetch>[1],
    ) => new Response(null, {
      status: 204,
      headers: {
        [INTERNAL_TENANT_DATABASE_PURGE_ACK_HEADER]:
          INTERNAL_TENANT_DATABASE_PURGE_ACK_VALUE,
        "cache-control": "no-store",
      },
    }));
    const gate = new RouterTenantDatabasePurgeGate({
      routerBaseUrl: "https://router.internal:8443/",
      internalToken: TOKEN,
      requestTimeoutMs: 1_000,
      fetchImpl,
    });

    await expect(gate.canExecute()).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [input, init] = fetchImpl.mock.calls[0]!;
    expect(String(input)).toBe(
      `https://router.internal:8443${INTERNAL_TENANT_DATABASE_PURGE_READY_PATH}`,
    );
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get(INTERNAL_ROUTER_TOKEN_HEADER)).toBe(TOKEN);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    new Response(null, {
      status: 200,
      headers: {
        [INTERNAL_TENANT_DATABASE_PURGE_ACK_HEADER]:
          INTERNAL_TENANT_DATABASE_PURGE_ACK_VALUE,
      },
    }),
    new Response(null, { status: 204 }),
    new Response(null, {
      status: 204,
      headers: {
        [INTERNAL_TENANT_DATABASE_PURGE_ACK_HEADER]:
          INTERNAL_TENANT_DATABASE_PURGE_ACK_VALUE,
      },
    }),
    new Response(null, {
      status: 204,
      headers: {
        "cache-control": "private",
        [INTERNAL_TENANT_DATABASE_PURGE_ACK_HEADER]:
          INTERNAL_TENANT_DATABASE_PURGE_ACK_VALUE,
      },
    }),
    new Response(null, {
      status: 204,
      headers: {
        "cache-control": "no-store",
        [INTERNAL_TENANT_DATABASE_PURGE_ACK_HEADER]: "local-db-content-delete-v2",
      },
    }),
    new Response(null, {
      status: 204,
      headers: {
        "cache-control": "no-store",
        [INTERNAL_TENANT_DATABASE_PURGE_ACK_HEADER]: "local-execution-ack-v1",
      },
    }),
    new Response(null, {
      status: 302,
      headers: {
        location: "https://other.internal/ready",
        "cache-control": "no-store",
        [INTERNAL_TENANT_DATABASE_PURGE_ACK_HEADER]:
          INTERNAL_TENANT_DATABASE_PURGE_ACK_VALUE,
      },
    }),
    new Response(null, { status: 404 }),
    new Response(null, { status: 503 }),
  ])("fails closed on status, redirect, cache, or acknowledgement drift", async (response) => {
    const gate = new RouterTenantDatabasePurgeGate({
      routerBaseUrl: "http://router.internal",
      internalToken: TOKEN,
      requestTimeoutMs: 1_000,
      fetchImpl: vi.fn(async () => response),
    });
    await expect(gate.canExecute()).resolves.toBe(false);
  });

  it("fails closed on timeout or transport errors and rejects unsafe configuration", async () => {
    for (const error of [
      new DOMException("timed out", "TimeoutError"),
      new Error("unreachable"),
    ]) {
      const gate = new RouterTenantDatabasePurgeGate({
        routerBaseUrl: "http://router.internal",
        internalToken: TOKEN,
        requestTimeoutMs: 1_000,
        fetchImpl: vi.fn(async () => { throw error; }),
      });
      await expect(gate.canExecute()).resolves.toBe(false);
    }
    expect(() => new RouterTenantDatabasePurgeGate({
      routerBaseUrl: "https://user:secret@router.internal/private",
      internalToken: TOKEN,
      requestTimeoutMs: 1_000,
    })).toThrow(/credential-free http\(s\) origin/);
    expect(() => new RouterTenantDatabasePurgeGate({
      routerBaseUrl: "http://router.internal",
      internalToken: "short",
      requestTimeoutMs: 1_000,
    })).toThrow(/internalToken/);
    expect(() => new RouterTenantDatabasePurgeGate({
      routerBaseUrl: "http://router.internal",
      internalToken: TOKEN,
      requestTimeoutMs: 99,
    })).toThrow(/requestTimeoutMs/);
  });
});
