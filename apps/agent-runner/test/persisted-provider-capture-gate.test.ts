import { describe, expect, it, vi } from "vitest";
import {
  INTERNAL_PERSISTED_PROVIDER_CAPTURE_ACK_HEADER,
  INTERNAL_PERSISTED_PROVIDER_CAPTURE_ACK_VALUE,
  PERSISTED_PROVIDER_CAPTURE_FLEET_PROTOCOL,
  type PersistedProviderCaptureFleetProof,
} from "@agent-service/protocol";
import { RouterPersistedProviderCaptureGate } from "../src/persisted-provider-capture-gate.js";
const proof: PersistedProviderCaptureFleetProof = {
  protocol: PERSISTED_PROVIDER_CAPTURE_FLEET_PROTOCOL, configuredFleetRootSha256: "0".repeat(64),
  captureControlEvidenceSha256: "1".repeat(64), refKeyIdSha256: "2".repeat(64), logsTargetSha256: "3".repeat(64),
  logsTargetReceiptSha256: "4".repeat(64), runtimeEpochSha256: "5".repeat(64), runtimeBindingSha256: "6".repeat(64),
};
const options = {
  routerBaseUrl: "http://router:8080", internalToken: "capture-private-internal-router-token-0001",
  runnerId: "capture-a", bootId: "00000000-0000-4000-8000-000000000001",
};
describe("runner persisted provider capture fresh barrier", () => {
  it("rejects unsafe origins, malformed process identity, weak tokens and unbounded deadlines", () => {
    for (const routerBaseUrl of ["https://user:password@router", "http://router/path", "http://router?", "http://router/#", "ftp://router", "invalid"]) {
      expect(() => new RouterPersistedProviderCaptureGate({ ...options, routerBaseUrl })).toThrow();
    }
    for (const override of [{ runnerId: "bad runner" }, { bootId: "not-a-boot" }, { internalToken: "short" }, { requestTimeoutMs: 99 }, { requestTimeoutMs: 30001 }]) {
      expect(() => new RouterPersistedProviderCaptureGate({ ...options, ...override })).toThrow();
    }
  });
  it("binds nonce, requester, boundary and exact expected tuple with no sticky success", async () => {
    const transport = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ nonce: body.nonce, runnerId: body.runnerId, bootId: body.bootId,
        boundary: body.boundary, proof, fleetObservationSha256: "7".repeat(64) }), {
        headers: { "cache-control": "private, no-store", [INTERNAL_PERSISTED_PROVIDER_CAPTURE_ACK_HEADER]: INTERNAL_PERSISTED_PROVIDER_CAPTURE_ACK_VALUE },
      });
    });
    const gate = new RouterPersistedProviderCaptureGate({ ...options, fetchImpl: transport });
    expect(await gate.requireFreshFleet(proof, "capture")).toEqual(proof);
    expect(await gate.requireFreshFleet(proof, "ack")).toEqual(proof);
    expect(transport).toHaveBeenCalledTimes(2);
    const bodies = transport.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies[0].nonce).not.toBe(bodies[1].nonce);
    transport.mockImplementationOnce(async () => new Response(null, { status: 503 }));
    await expect(gate.requireFreshFleet(proof, "create")).rejects.toThrow();
  });

  it("bounds the whole response body and cancels a stalled or oversized response", async () => {
    const cancelled = vi.fn();
    const gate = new RouterPersistedProviderCaptureGate({ ...options, requestTimeoutMs: 100,
      fetchImpl: async () => new Response(new ReadableStream({ cancel: cancelled }), {
        headers: { "cache-control": "no-store", [INTERNAL_PERSISTED_PROVIDER_CAPTURE_ACK_HEADER]: INTERNAL_PERSISTED_PROVIDER_CAPTURE_ACK_VALUE },
      }),
    });
    await expect(gate.requireFreshFleet(proof, "ack")).rejects.toThrow();
    expect(cancelled).toHaveBeenCalledTimes(1);
    const excessive = new RouterPersistedProviderCaptureGate({ ...options, fetchImpl: async () => new Response("x".repeat(32769), {
      headers: { "cache-control": "no-store", [INTERNAL_PERSISTED_PROVIDER_CAPTURE_ACK_HEADER]: INTERNAL_PERSISTED_PROVIDER_CAPTURE_ACK_VALUE },
    }) });
    await expect(excessive.requireFreshFleet(proof, "capture")).rejects.toThrow(/bound/);
  });

  it("observes and cancels late headers when a noncooperative transport exceeds the single deadline", async () => {
    let resolve!: (response: Response) => void;
    const cancelled = vi.fn();
    const gate = new RouterPersistedProviderCaptureGate({ ...options, requestTimeoutMs: 100,
      fetchImpl: () => new Promise((done) => { resolve = done; }),
    });
    await expect(gate.requireFreshFleet(proof, "capture")).rejects.toThrow();
    resolve(new Response(new ReadableStream({ cancel: cancelled })));
    await Promise.resolve(); await Promise.resolve();
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("does not reset the body budget after slow headers", async () => {
    const cancelled = vi.fn();
    const controller = new AbortController();
    const deadline = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    let release!: (response: Response) => void;
    const headers = new Promise<Response>((resolve) => { release = resolve; });
    try {
      const gate = new RouterPersistedProviderCaptureGate({ ...options, requestTimeoutMs: 100,
        fetchImpl: async (_input, init) => { expect(init?.signal).toBe(controller.signal); return headers; },
      });
      const pending = expect(gate.requireFreshFleet(proof, "ack")).rejects.toThrow();
      release(new Response(new ReadableStream({ cancel: cancelled }), {
          headers: { "cache-control": "no-store", [INTERNAL_PERSISTED_PROVIDER_CAPTURE_ACK_HEADER]: INTERNAL_PERSISTED_PROVIDER_CAPTURE_ACK_VALUE },
      }));
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      controller.abort(new Error("same whole-operation budget expired"));
      await pending;
      expect(deadline).toHaveBeenCalledTimes(1);
      expect(deadline).toHaveBeenCalledWith(100);
      expect(cancelled).toHaveBeenCalledTimes(1);
    } finally { deadline.mockRestore(); }
  });
});
