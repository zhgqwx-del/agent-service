import { describe, expect, it, vi } from "vitest";
import {
  INTERNAL_ROUTER_TOKEN_HEADER,
  INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER,
  INTERNAL_TENANT_RUNTIME_DRAIN_ACK_VALUE,
  INTERNAL_TENANT_RUNTIME_DRAIN_ROUTER_PATH,
  tenantRuntimeFleetSha256,
  tenantRuntimeLocalReceiptSha256,
  tenantRuntimeTargetReceiptsSha256,
  tenantRuntimeTargetSha256,
  type TenantRuntimeDrainRequest,
} from "@agent-service/protocol";
import { RouterTenantRuntimeDrainClient } from "../src/tenant-runtime-drain-client.js";

const TOKEN = "runner-runtime-drain-client-token-01";
const AUTHORITY: TenantRuntimeDrainRequest = {
  requestId: "erase_019a2b3c-4d5e-4f00-8a9b-0c1d2e3f4a5b",
  tenantId: "tenant-a",
  subjectGeneration: 3,
  t3aReceiptSha256: "a".repeat(64),
};

function proof(overrides: Record<string, unknown> = {}) {
  const body = {
    targetSha256: tenantRuntimeTargetSha256("http://runner-a:8787"),
    runnerId: "runner-a",
    bootId: "boot-a",
    ...AUTHORITY,
    cacheEntryCountBefore: 2,
    cacheEntryCountAfter: 0 as const,
    activeOperationCountBefore: 1,
    activeOperationCountAfter: 0 as const,
    activeTurnCountBefore: 1,
    activeTurnCountAfter: 0 as const,
    completedAtMs: 100,
  };
  const receipt = {
    ...body,
    receiptSha256: tenantRuntimeLocalReceiptSha256(body),
    ...overrides,
  };
  return {
    fleetSha256: tenantRuntimeFleetSha256([receipt]),
    targetReceiptsSha256: tenantRuntimeTargetReceiptsSha256([receipt]),
    targets: [receipt],
  };
}

function response(
  body: unknown,
  options: { ack?: boolean; noStore?: boolean; status?: number } = {},
): Response {
  return Response.json(body, {
    status: options.status ?? 200,
    headers: {
      ...(options.ack === false
        ? {}
        : {
            [INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER]:
              INTERNAL_TENANT_RUNTIME_DRAIN_ACK_VALUE,
          }),
      ...(options.noStore === false ? {} : { "cache-control": "private, no-store" }),
    },
  });
}

describe("RouterTenantRuntimeDrainClient", () => {
  it("posts only the strict T3a authority and accepts a bound canonical fleet proof", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(`http://router.internal${INTERNAL_TENANT_RUNTIME_DRAIN_ROUTER_PATH}`);
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get(INTERNAL_ROUTER_TOKEN_HEADER)).toBe(TOKEN);
      expect(JSON.parse(String(init?.body))).toEqual(AUTHORITY);
      return response(proof());
    });
    const client = new RouterTenantRuntimeDrainClient({
      routerBaseUrl: "HTTP://Router.Internal:80/",
      internalToken: TOKEN,
      requestTimeoutMs: 1_000,
      fetchImpl,
    });
    await expect(client.drain(AUTHORITY)).resolves.toEqual(proof());
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects missing ACK/no-store, malformed roots and authority substitution", async () => {
    const replies = [
      response(proof(), { ack: false }),
      response(proof(), { noStore: false }),
      response({ ...proof(), fleetSha256: "b".repeat(64) }),
      response(proof({ tenantId: "tenant-b" })),
      new Response("not json", {
        status: 200,
        headers: {
          [INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER]:
            INTERNAL_TENANT_RUNTIME_DRAIN_ACK_VALUE,
          "cache-control": "no-store",
        },
      }),
      new Response("{}", {
        status: 200,
        headers: {
          [INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER]:
            INTERNAL_TENANT_RUNTIME_DRAIN_ACK_VALUE,
          "cache-control": "no-store",
          "content-length": String(128 * 1024 + 1),
        },
      }),
    ];
    const client = new RouterTenantRuntimeDrainClient({
      routerBaseUrl: "http://router.internal",
      internalToken: TOKEN,
      requestTimeoutMs: 1_000,
      fetchImpl: vi.fn(async () => replies.shift()!),
    });
    for (let index = 0; index < 6; index++) {
      await expect(client.drain(AUTHORITY)).resolves.toBeNull();
    }
  });

  it("fails before transport for invalid configuration or non-content-free authority", async () => {
    expect(() => new RouterTenantRuntimeDrainClient({
      routerBaseUrl: "https://user:secret@router.internal/private",
      internalToken: TOKEN,
      requestTimeoutMs: 1_000,
    })).toThrow(/credential-free/);
    expect(() => new RouterTenantRuntimeDrainClient({
      routerBaseUrl: "http://router.internal",
      internalToken: "short",
      requestTimeoutMs: 1_000,
    })).toThrow(/internalToken/);
    const fetchImpl = vi.fn();
    const client = new RouterTenantRuntimeDrainClient({
      routerBaseUrl: "http://router.internal",
      internalToken: TOKEN,
      requestTimeoutMs: 1_000,
      fetchImpl,
    });
    await expect(client.drain({ ...AUTHORITY, content: "forbidden" } as never)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
