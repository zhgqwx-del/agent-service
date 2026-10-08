import { describe, expect, it, vi } from "vitest";
import {
  INTERNAL_PURGE_POLICY_EVALUATION_ACK_HEADER,
  INTERNAL_PURGE_POLICY_EVALUATION_ACK_VALUE,
  INTERNAL_PURGE_POLICY_EVALUATION_READY_PATH,
  INTERNAL_ROUTER_TOKEN_HEADER,
} from "@agent-service/protocol";
import { RouterPurgePolicyEvaluationGate } from "../src/purge-policy-evaluation-gate.js";

const TOKEN = "purge-policy-gate-private-token-0001";

describe("RouterPurgePolicyEvaluationGate", () => {
  it("accepts only the fixed versioned status and acknowledgement", async () => {
    const fetchImpl = vi.fn(async (
      _input: Parameters<typeof globalThis.fetch>[0],
      _init?: Parameters<typeof globalThis.fetch>[1],
    ) => new Response(null, {
      status: 204,
      headers: {
        [INTERNAL_PURGE_POLICY_EVALUATION_ACK_HEADER]:
          INTERNAL_PURGE_POLICY_EVALUATION_ACK_VALUE,
      },
    }));
    const gate = new RouterPurgePolicyEvaluationGate({
      routerBaseUrl: "https://router.internal:8443/",
      internalToken: TOKEN,
      requestTimeoutMs: 1_000,
      fetchImpl,
    });

    await expect(gate.canClaim()).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [input, init] = fetchImpl.mock.calls[0]!;
    expect(String(input)).toBe(
      `https://router.internal:8443${INTERNAL_PURGE_POLICY_EVALUATION_READY_PATH}`,
    );
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get(INTERNAL_ROUTER_TOKEN_HEADER)).toBe(TOKEN);
  });

  it("fails closed on transport, status, or acknowledgement mismatch", async () => {
    for (const fetchImpl of [
      vi.fn(async () => { throw new Error("private URL must not escape"); }),
      vi.fn(async () => new Response(null, {
        status: 503,
        headers: {
          [INTERNAL_PURGE_POLICY_EVALUATION_ACK_HEADER]:
            INTERNAL_PURGE_POLICY_EVALUATION_ACK_VALUE,
        },
      })),
      vi.fn(async () => new Response(null, { status: 204 })),
      vi.fn(async () => new Response(null, {
        status: 204,
        headers: { [INTERNAL_PURGE_POLICY_EVALUATION_ACK_HEADER]: "future-evaluator-v2" },
      })),
    ]) {
      const gate = new RouterPurgePolicyEvaluationGate({
        routerBaseUrl: "http://router.internal:8080",
        internalToken: TOKEN,
        requestTimeoutMs: 1_000,
        fetchImpl,
      });
      await expect(gate.canClaim()).resolves.toBe(false);
    }
  });

  it("rejects unsafe origins, tokens, and timeouts before probing", () => {
    expect(() => new RouterPurgePolicyEvaluationGate({
      routerBaseUrl: "https://user:secret@router.internal",
      internalToken: TOKEN,
      requestTimeoutMs: 1_000,
    })).toThrow(/credential-free/);
    expect(() => new RouterPurgePolicyEvaluationGate({
      routerBaseUrl: "https://router.internal",
      internalToken: "short",
      requestTimeoutMs: 1_000,
    })).toThrow(/internalToken/);
    expect(() => new RouterPurgePolicyEvaluationGate({
      routerBaseUrl: "https://router.internal",
      internalToken: TOKEN,
      requestTimeoutMs: 99,
    })).toThrow(/requestTimeoutMs/);
  });
});
