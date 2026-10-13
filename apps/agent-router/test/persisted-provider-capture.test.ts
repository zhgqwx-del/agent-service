import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INTERNAL_ROUTER_TOKEN_HEADER,
  INTERNAL_PERSISTED_PROVIDER_CAPTURE_ACK_HEADER,
  INTERNAL_PERSISTED_PROVIDER_CAPTURE_ACK_VALUE,
  INTERNAL_PERSISTED_PROVIDER_CAPTURE_FLEET_PATH,
  INTERNAL_PERSISTED_PROVIDER_CAPTURE_NONCE_HEADER,
  PERSISTED_PROVIDER_CAPTURE_FLEET_PROTOCOL,
  PROTOCOL_VERSION,
  PersistedProviderCaptureFleetResponse,
  persistedProviderCaptureConfiguredFleetRootSha256,
  type PersistedProviderCaptureFleetRequest,
} from "@agent-service/protocol";
import { RunnerRegistry } from "../src/registry.js";
import { createRouterApp } from "../src/app.js";

const TOKEN = "capture-private-internal-router-token-0001";
const binding = {
  captureControlEvidenceSha256: "1".repeat(64), refKeyIdSha256: "2".repeat(64),
  logsTargetSha256: "3".repeat(64), logsTargetReceiptSha256: "4".repeat(64),
  runtimeEpochSha256: "5".repeat(64), runtimeBindingSha256: "6".repeat(64),
};
const targets = [
  { url: "http://capture-a:8787", runnerId: "capture-a", bootId: "00000000-0000-4000-8000-000000000001" },
  { url: "http://capture-b:8787", runnerId: "capture-b", bootId: "00000000-0000-4000-8000-000000000002" },
];
const configuredFleetRootSha256 = persistedProviderCaptureConfiguredFleetRootSha256(targets);
const request = (): PersistedProviderCaptureFleetRequest => ({
  runnerId: targets[0]!.runnerId, bootId: targets[0]!.bootId, nonce: "7".repeat(64), boundary: "capture", binding,
  configuredFleetRootSha256,
});
const registries: RunnerRegistry[] = [];
afterEach(async () => { await Promise.all(registries.splice(0).map((registry) => registry.close())); });
function fixture(change?: (value: Record<string, unknown>, targetIndex: number) => void) {
  let unavailable = false;
  const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const index = targets.findIndex((target) => String(input).startsWith(target.url));
    if (unavailable && index === 1) throw new Error("configured target unavailable");
    const ready: Record<string, unknown> = {
      protocolVersion: PROTOCOL_VERSION, service: "agent-runner", capability: PERSISTED_PROVIDER_CAPTURE_FLEET_PROTOCOL,
      runnerId: targets[index]!.runnerId, bootId: targets[index]!.bootId, localEnabled: true, writerEnabled: true,
      nonce: new Headers(init?.headers).get(INTERNAL_PERSISTED_PROVIDER_CAPTURE_NONCE_HEADER), binding: { ...binding }, configuredFleetRootSha256,
    };
    change?.(ready, index);
    return new Response(JSON.stringify(ready), { headers: {
      "cache-control": "private, no-store", [INTERNAL_PERSISTED_PROVIDER_CAPTURE_ACK_HEADER]: INTERNAL_PERSISTED_PROVIDER_CAPTURE_ACK_VALUE,
    } });
  });
  const registry = new RunnerRegistry({ runners: targets.map((target) => target.url), internalRouterToken: TOKEN, captureFetchImpl: transport });
  registries.push(registry);
  return { registry, transport, setUnavailable() { unavailable = true; } };
}

describe("fresh configured persisted provider capture fleet", () => {
  it("does a separate nonce-bound probe for every configured target on every boundary", async () => {
    const h = fixture();
    expect(h.registry.list().every((target) => !target.healthy)).toBe(true);
    const first = await h.registry.freshPersistedProviderCaptureSnapshot(request(), AbortSignal.timeout(1000));
    expect(first.proof).toEqual({ protocol: PERSISTED_PROVIDER_CAPTURE_FLEET_PROTOCOL, configuredFleetRootSha256, ...binding });
    await h.registry.freshPersistedProviderCaptureSnapshot(request(), AbortSignal.timeout(1000));
    expect(h.transport).toHaveBeenCalledTimes(4);
    const nonces = h.transport.mock.calls.map(([, init]) => new Headers(init?.headers).get(INTERNAL_PERSISTED_PROVIDER_CAPTURE_NONCE_HEADER));
    expect(new Set(nonces).size).toBe(4);
    h.setUnavailable();
    await expect(h.registry.freshPersistedProviderCaptureSnapshot(request(), AbortSignal.timeout(1000))).rejects.toThrow();
    expect(h.transport).toHaveBeenCalledTimes(6);
  });

  it.each(["key", "target", "epoch", "boot", "runner", "protocol", "nonce"])("rejects %s drift without using a healthy subset", async (kind) => {
    const h = fixture((ready, index) => {
      if (index !== 1) return;
      if (kind === "boot") ready.bootId = targets[0]!.bootId;
      else if (kind === "runner") ready.runnerId = targets[0]!.runnerId;
      else if (kind === "protocol") ready.capability = "old-v1";
      else if (kind === "nonce") ready.nonce = "0".repeat(64);
      else (ready.binding as Record<string, string>)[kind === "key" ? "refKeyIdSha256" : kind === "target" ? "logsTargetSha256" : "runtimeEpochSha256"] = "0".repeat(64);
    });
    await expect(h.registry.freshPersistedProviderCaptureSnapshot(request(), AbortSignal.timeout(1000))).rejects.toThrow();
  });

  it("protects the router barrier with token, exact requester boot, closed body and a default-off gate", async () => {
    const h = fixture();
    let enabled = false;
    const app = createRouterApp({ registry: h.registry, ready: () => true, internalRunnerToken: TOKEN,
      persistedProviderFailureCaptureFleetEnabled: () => enabled });
    const send = (body = request(), token = TOKEN) => app.request(INTERNAL_PERSISTED_PROVIDER_CAPTURE_FLEET_PATH, {
      method: "POST", headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: token, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect((await send(request(), "wrong")).status).toBe(404);
    expect((await send()).status).toBe(503);
    expect(h.transport).not.toHaveBeenCalled();
    enabled = true;
    const result = await send();
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toContain("no-store");
    expect(PersistedProviderCaptureFleetResponse.parse(await result.json()).nonce).toBe(request().nonce);
    expect((await send({ ...request(), bootId: "00000000-0000-4000-8000-000000000099" })).status).toBe(503);
    expect((await send({ ...request(), secret: "must-reject" } as PersistedProviderCaptureFleetRequest)).status).toBe(503);
  });
});
