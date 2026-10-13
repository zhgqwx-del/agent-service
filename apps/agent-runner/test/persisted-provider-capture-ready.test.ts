import { describe, expect, it, vi } from "vitest";
import { MemorySessionStore } from "@agent-service/store";
import { INTERNAL_ROUTER_TOKEN_HEADER, INTERNAL_PERSISTED_PROVIDER_CAPTURE_READY_PATH, INTERNAL_PERSISTED_PROVIDER_CAPTURE_NONCE_HEADER,
  INTERNAL_PERSISTED_PROVIDER_CAPTURE_ACK_HEADER, INTERNAL_PERSISTED_PROVIDER_CAPTURE_ACK_VALUE, PersistedProviderCaptureRunnerReady, type PersistedProviderCaptureFleetProof } from "@agent-service/protocol";
import { createApp, type AppDeps } from "../src/app.js";

const token = "capture-ready-local-internal-token-0001";
const proof: PersistedProviderCaptureFleetProof = {
  protocol: "persisted-provider-capture-fleet-v2", configuredFleetRootSha256: "0".repeat(64),
  captureControlEvidenceSha256: "1".repeat(64), refKeyIdSha256: "2".repeat(64), logsTargetSha256: "3".repeat(64),
  logsTargetReceiptSha256: "4".repeat(64), runtimeEpochSha256: "5".repeat(64), runtimeBindingSha256: "6".repeat(64),
};
function fixture(capture?: AppDeps["persistedProviderCapture"]) {
  let ready = true;
  const deps: AppDeps = {
    store: new MemorySessionStore(), host: {} as AppDeps["host"], providers: {} as AppDeps["providers"], tools: {} as AppDeps["tools"],
    runnerId: "capture-ready-a", internalRouterToken: token, heartbeatMs: 1000, maxBodyBytes: 100000,
    ready: () => ready, decryptSecret: async () => "", encryptSecret: async () => ({ ciphertext: Buffer.alloc(0), keyId: "fixture" }),
    persistedProviderCapture: capture,
  };
  const app = createApp(deps);
  const request = (overrides: { method?: string; token?: string; nonce?: string; signal?: AbortSignal } = {}) => app.request(new Request(`http://runner${INTERNAL_PERSISTED_PROVIDER_CAPTURE_READY_PATH}`, {
    method: overrides.method ?? "GET", headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: overrides.token ?? token,
      [INTERNAL_PERSISTED_PROVIDER_CAPTURE_NONCE_HEADER]: overrides.nonce ?? "7".repeat(64) }, signal: overrides.signal,
  }));
  return { app, request, setNotReady() { ready = false; } };
}
const capture = (getBinding: NonNullable<AppDeps["persistedProviderCapture"]>["getBinding"]): NonNullable<AppDeps["persistedProviderCapture"]> => ({
  bootId: "00000000-0000-4000-8000-000000000001", localEnabled: true, writerEnabled: true, getBinding,
});

describe("runner capture readiness is local and fresh", () => {
  it("has no default gate, never reads DB on unauthorized or disabled requests and hides private routes", async () => {
    const binding = vi.fn(async () => proof);
    const h = fixture({ ...capture(binding), localEnabled: false });
    for (const overrides of [{ token: "wrong" }, { method: "POST" }]) {
      const response = await h.request(overrides);
      expect(response.status).toBe(404); expect(response.headers.get("cache-control")).toContain("no-store");
    }
    expect((await h.request()).status).toBe(503);
    expect((await fixture().request()).status).toBe(503);
    expect(binding).not.toHaveBeenCalled();
  });

  it("re-reads exact epoch/control/key/target binding on every nonce without sticky readiness or router calls", async () => {
    const binding = vi.fn<NonNullable<AppDeps["persistedProviderCapture"]>["getBinding"]>().mockResolvedValue(proof);
    const h = fixture(capture(binding));
    for (const nonce of ["7".repeat(64), "8".repeat(64)]) {
      const response = await h.request({ nonce });
      expect(response.status).toBe(200);
      expect(response.headers.get(INTERNAL_PERSISTED_PROVIDER_CAPTURE_ACK_HEADER)).toBe(INTERNAL_PERSISTED_PROVIDER_CAPTURE_ACK_VALUE);
      expect(PersistedProviderCaptureRunnerReady.parse(await response.json())).toMatchObject({ nonce, runnerId: "capture-ready-a", binding: { runtimeEpochSha256: proof.runtimeEpochSha256 } });
    }
    expect(binding).toHaveBeenCalledTimes(2);
    binding.mockResolvedValueOnce(null);
    expect((await h.request()).status).toBe(503);
    expect((await h.request({ nonce: "bad" })).status).toBe(503);
    h.setNotReady();
    expect((await h.request()).status).toBe(503);
    expect(binding).toHaveBeenCalledTimes(3);
  });

  it("does not ACK after caller cancellation or local drain during a noncooperative database read", async () => {
    const controller = new AbortController();
    let finish!: (value: PersistedProviderCaptureFleetProof) => void;
    const binding = vi.fn(() => new Promise<PersistedProviderCaptureFleetProof>((resolve) => { finish = resolve; }));
    const h = fixture(capture(binding));
    const pending = h.request({ signal: controller.signal });
    await vi.waitFor(() => expect(binding).toHaveBeenCalledTimes(1));
    controller.abort(new Error("cancelled"));
    expect((await pending).status).toBe(503);
    finish(proof);
    await Promise.resolve();
    binding.mockImplementationOnce(async () => { h.setNotReady(); return proof; });
    expect((await h.request()).status).toBe(503);
  });
});
