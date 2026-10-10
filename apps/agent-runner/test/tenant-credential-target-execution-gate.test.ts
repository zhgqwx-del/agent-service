import { describe, expect, it, vi } from "vitest";
import {
  INTERNAL_ROUTER_TOKEN_HEADER,
  INTERNAL_TENANT_CREDENTIAL_TARGET_EXECUTION_ACK_HEADER,
  INTERNAL_TENANT_CREDENTIAL_TARGET_EXECUTION_ACK_VALUE,
  INTERNAL_TENANT_CREDENTIAL_TARGET_EXECUTION_READY_PATH,
} from "@agent-service/protocol";
import { RouterTenantCredentialTargetExecutionGate } from
  "../src/tenant-credential-target-execution-gate.js";

const TOKEN = "credential-target-execution-private-token-0001";

describe("RouterTenantCredentialTargetExecutionGate", () => {
  it("accepts only the exact versioned 204 acknowledgement", async () => {
    const fetchImpl = vi.fn(async (
      _input: Parameters<typeof globalThis.fetch>[0],
      _init?: Parameters<typeof globalThis.fetch>[1],
    ) => new Response(null, {
      status: 204,
      headers: {
        [INTERNAL_TENANT_CREDENTIAL_TARGET_EXECUTION_ACK_HEADER]:
          INTERNAL_TENANT_CREDENTIAL_TARGET_EXECUTION_ACK_VALUE,
      },
    }));
    const gate = new RouterTenantCredentialTargetExecutionGate({
      routerBaseUrl: "https://router.internal:8443/",
      internalToken: TOKEN,
      requestTimeoutMs: 1_000,
      fetchImpl,
    });

    await expect(gate.canExecute()).resolves.toBe(true);
    const [input, init] = fetchImpl.mock.calls[0]!;
    expect(String(input)).toBe(
      `https://router.internal:8443${INTERNAL_TENANT_CREDENTIAL_TARGET_EXECUTION_READY_PATH}`,
    );
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get(INTERNAL_ROUTER_TOKEN_HEADER)).toBe(TOKEN);
  });

  it.each([
    new Response(null, {
      status: 200,
      headers: {
        [INTERNAL_TENANT_CREDENTIAL_TARGET_EXECUTION_ACK_HEADER]:
          INTERNAL_TENANT_CREDENTIAL_TARGET_EXECUTION_ACK_VALUE,
      },
    }),
    new Response(null, { status: 204 }),
    new Response(null, {
      status: 204,
      headers: {
        [INTERNAL_TENANT_CREDENTIAL_TARGET_EXECUTION_ACK_HEADER]: "wrong-version-v1",
      },
    }),
  ])("fails closed on status or acknowledgement drift", async (response) => {
    const gate = new RouterTenantCredentialTargetExecutionGate({
      routerBaseUrl: "http://router.internal",
      internalToken: TOKEN,
      requestTimeoutMs: 1_000,
      fetchImpl: vi.fn(async () => response),
    });
    await expect(gate.canExecute()).resolves.toBe(false);
  });

  it("fails closed on transport errors and unsafe configuration", async () => {
    const gate = new RouterTenantCredentialTargetExecutionGate({
      routerBaseUrl: "http://router.internal",
      internalToken: TOKEN,
      requestTimeoutMs: 1_000,
      fetchImpl: vi.fn(async () => { throw new Error("secret remote failure"); }),
    });
    await expect(gate.canExecute()).resolves.toBe(false);
    expect(() => new RouterTenantCredentialTargetExecutionGate({
      routerBaseUrl: "https://user:secret@router.internal/private",
      internalToken: TOKEN,
      requestTimeoutMs: 1_000,
    })).toThrow(/credential-free/);
    expect(() => new RouterTenantCredentialTargetExecutionGate({
      routerBaseUrl: "http://router.internal",
      internalToken: "short",
      requestTimeoutMs: 1_000,
    })).toThrow(/internalToken/);
  });
});
