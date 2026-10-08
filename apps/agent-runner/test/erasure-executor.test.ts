import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INTERNAL_ERASURE_DRAIN_ACK_HEADER,
  INTERNAL_ERASURE_DRAIN_ACK_VALUE,
  INTERNAL_ERASURE_DRAIN_ROUTER_PATH_PREFIX,
  INTERNAL_ROUTER_TOKEN_HEADER,
} from "@agent-service/protocol";
import {
  ErasureSessionExecutionError,
  newId,
} from "@agent-service/core";
import { newErasureRequestId, type ErasureWriteAuthorization } from "@agent-service/store";
import { RouterErasureSessionExecutor } from "../src/erasure-executor.js";

const TOKEN = "runner-router-erasure-private-token-0001";
const SESSION_ID = newId("sess");
const AUTHORITY: ErasureWriteAuthorization = {
  tenantId: "tenant_executor",
  userId: "user_executor",
  requestId: newErasureRequestId(),
  subjectGeneration: 3,
  claimToken: "claim-token-3",
  claimAttempt: 4,
};

interface ResponseDouble {
  response: Response;
  cancel: ReturnType<typeof vi.fn>;
}

function responseDouble(status: number, acknowledged = false): ResponseDouble {
  const cancel = vi.fn(async () => {});
  return {
    response: {
      status,
      headers: new Headers(
        acknowledged
          ? { [INTERNAL_ERASURE_DRAIN_ACK_HEADER]: INTERNAL_ERASURE_DRAIN_ACK_VALUE }
          : {},
      ),
      body: { cancel },
    } as unknown as Response,
    cancel,
  };
}

function executor(fetchImpl: typeof globalThis.fetch, requestTimeoutMs = 500): RouterErasureSessionExecutor {
  return new RouterErasureSessionExecutor({
    routerBaseUrl: "http://router.internal:8080/",
    internalToken: TOKEN,
    requestTimeoutMs,
    fetchImpl,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RouterErasureSessionExecutor", () => {
  it("sends only the strict claim envelope for both operations and requires the versioned ACK", async () => {
    const doubled = [responseDouble(204, true), responseDouble(204, true)];
    const responses = [...doubled];
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => responses.shift()!.response);
    const client = executor(fetchImpl);

    await client.drainSessionForErasure(AUTHORITY, SESSION_ID);
    await client.eraseSessionForErasure(AUTHORITY, SESSION_ID);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [input, init] of fetchImpl.mock.calls) {
      expect(String(input)).toBe(
        `http://router.internal:8080${INTERNAL_ERASURE_DRAIN_ROUTER_PATH_PREFIX}/${SESSION_ID}`,
      );
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("manual");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get(INTERNAL_ROUTER_TOKEN_HEADER)).toBe(TOKEN);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toEqual(AUTHORITY);
      expect(Object.keys(body).sort()).toEqual([
        "claimAttempt",
        "claimToken",
        "requestId",
        "subjectGeneration",
        "tenantId",
        "userId",
      ]);
      expect(body).not.toHaveProperty("sessionId");
      expect(body).not.toHaveProperty("phase");
    }
    expect(responses).toEqual([]);
    expect(doubled.every((item) => item.cancel.mock.calls.length === 1)).toBe(true);
  });

  it.each([409, 502, 503])("maps HTTP %i to bounded owner_unavailable", async (status) => {
    const doubled = responseDouble(status);
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => doubled.response);
    await expect(executor(fetchImpl).drainSessionForErasure(AUTHORITY, SESSION_ID)).rejects.toMatchObject({
      name: "ErasureSessionExecutionError",
      code: "owner_unavailable",
    });
    expect(doubled.cancel).toHaveBeenCalledOnce();
  });

  it.each([
    [204, false],
    [200, true],
    [302, true],
    [400, true],
    [404, true],
    [500, true],
  ])("maps HTTP %i with ACK=%s to bounded temporary_failure", async (status, acknowledged) => {
    const doubled = responseDouble(status as number, acknowledged as boolean);
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => doubled.response);
    await expect(executor(fetchImpl).eraseSessionForErasure(AUTHORITY, SESSION_ID)).rejects.toMatchObject({
      name: "ErasureSessionExecutionError",
      code: "temporary_failure",
    });
    expect(doubled.cancel).toHaveBeenCalledOnce();
  });

  it("collapses transport details without logging or leaking URL, token, or body", async () => {
    const leaked = `http://router.internal ${TOKEN} ${JSON.stringify(AUTHORITY)}`;
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error(leaked);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = await executor(fetchImpl)
      .drainSessionForErasure(AUTHORITY, SESSION_ID)
      .catch((caught: unknown) => caught);

    expect(failure).toBeInstanceOf(ErasureSessionExecutionError);
    expect(failure).toMatchObject({ code: "owner_unavailable" });
    expect(String(failure)).not.toContain("router.internal");
    expect(String(failure)).not.toContain(TOKEN);
    expect(String(failure)).not.toContain(AUTHORITY.claimToken);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("enforces its short abort deadline and maps timeout to owner_unavailable", async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    await expect(executor(fetchImpl, 100).drainSessionForErasure(AUTHORITY, SESSION_ID)).rejects.toMatchObject({
      code: "owner_unavailable",
    });
  });

  it("fails locally on a malformed identity and never widens the wire request", async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>();
    const client = executor(fetchImpl);
    await expect(client.drainSessionForErasure(
      { ...AUTHORITY, unexpected: "must-not-send" } as ErasureWriteAuthorization,
      SESSION_ID,
    )).rejects.toMatchObject({ code: "temporary_failure" });
    await expect(client.drainSessionForErasure(AUTHORITY, "sess_not-canonical"))
      .rejects.toMatchObject({ code: "temporary_failure" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects unsafe construction inputs without echoing them", () => {
    expect(() => new RouterErasureSessionExecutor({
      routerBaseUrl: "https://user:secret@router.internal/private?token=value",
      internalToken: TOKEN,
      requestTimeoutMs: 500,
    })).toThrow("credential-free http(s) origin");
    expect(() => new RouterErasureSessionExecutor({
      routerBaseUrl: "http://router.internal",
      internalToken: "short",
      requestTimeoutMs: 500,
    })).toThrow("valid private router token");
    expect(() => new RouterErasureSessionExecutor({
      routerBaseUrl: "http://router.internal",
      internalToken: TOKEN,
      requestTimeoutMs: 30_001,
    })).toThrow("between 100 and 30000");
  });
});
