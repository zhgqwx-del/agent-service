import { describe, expect, it, vi } from "vitest";
import {
  INTERNAL_ROUTER_TOKEN_HEADER,
  INTERNAL_TENANT_RESTORE_JOURNAL_ACK_HEADER,
  INTERNAL_TENANT_RESTORE_JOURNAL_ACK_VALUE,
  INTERNAL_TENANT_RESTORE_JOURNAL_READY_PATH,
} from "@agent-service/protocol";
import { RouterTenantRestoreJournalGate } from "../src/tenant-restore-journal-gate.js";

const token = "restore-journal-private-router-token-v1";

describe("RouterTenantRestoreJournalGate", () => {
  it("accepts only the exact private 204 acknowledgement", async () => {
    const fetchImpl = vi.fn(async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ) => {
      expect(String(input)).toBe(
        `https://router.internal:8443${INTERNAL_TENANT_RESTORE_JOURNAL_READY_PATH}`,
      );
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get(INTERNAL_ROUTER_TOKEN_HEADER)).toBe(token);
      return new Response(null, {
        status: 204,
        headers: {
          [INTERNAL_TENANT_RESTORE_JOURNAL_ACK_HEADER]:
            INTERNAL_TENANT_RESTORE_JOURNAL_ACK_VALUE,
          "cache-control": "private, No-Store",
        },
      });
    });
    const gate = new RouterTenantRestoreJournalGate({
      routerBaseUrl: "https://router.internal:8443/",
      internalToken: token,
      requestTimeoutMs: 2_000,
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(gate.canExecute()).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    new Response(null, { status: 503 }),
    new Response(null, { status: 204 }),
    new Response(null, {
      status: 204,
      headers: {
        [INTERNAL_TENANT_RESTORE_JOURNAL_ACK_HEADER]: "wrong-version-v1",
        "cache-control": "no-store",
      },
    }),
    new Response(null, {
      status: 204,
      headers: {
        [INTERNAL_TENANT_RESTORE_JOURNAL_ACK_HEADER]:
          INTERNAL_TENANT_RESTORE_JOURNAL_ACK_VALUE,
      },
    }),
    new Response(null, {
      status: 204,
      headers: {
        [INTERNAL_TENANT_RESTORE_JOURNAL_ACK_HEADER]:
          INTERNAL_TENANT_RESTORE_JOURNAL_ACK_VALUE,
        "cache-control": "private, max-age=0",
      },
    }),
  ])("fails closed for a non-exact response", async (response) => {
    const gate = new RouterTenantRestoreJournalGate({
      routerBaseUrl: "http://router.internal",
      internalToken: token,
      requestTimeoutMs: 2_000,
      fetchImpl: vi.fn(async () => response) as typeof fetch,
    });
    await expect(gate.canExecute()).resolves.toBe(false);
  });

  it("fails closed for transport errors and rejects unsafe configuration", async () => {
    const gate = new RouterTenantRestoreJournalGate({
      routerBaseUrl: "http://router.internal",
      internalToken: token,
      requestTimeoutMs: 2_000,
      fetchImpl: vi.fn(async () => { throw new Error("sensitive transport detail"); }) as typeof fetch,
    });
    await expect(gate.canExecute()).resolves.toBe(false);

    expect(() => new RouterTenantRestoreJournalGate({
      routerBaseUrl: "https://user:password@router.internal/path",
      internalToken: token,
      requestTimeoutMs: 2_000,
    })).toThrow(/credential-free/);
    expect(() => new RouterTenantRestoreJournalGate({
      routerBaseUrl: "http://router.internal",
      internalToken: "short",
      requestTimeoutMs: 2_000,
    })).toThrow(/internalToken/);
  });
});
