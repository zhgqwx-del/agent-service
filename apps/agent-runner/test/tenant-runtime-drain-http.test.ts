import { describe, expect, it, vi } from "vitest";
import {
  INTERNAL_ROUTER_TOKEN_HEADER,
  INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER,
  INTERNAL_TENANT_RUNTIME_DRAIN_ACK_VALUE,
  INTERNAL_TENANT_RUNTIME_DRAIN_READY_PATH,
  INTERNAL_TENANT_RUNTIME_DRAIN_RUNNER_PATH,
  TENANT_RUNTIME_DRAIN_V1,
  tenantRuntimeLocalReceiptSha256,
  tenantRuntimeTargetSha256,
  type TenantRuntimeDrainRunnerRequest,
} from "@agent-service/protocol";
import type { SessionHost, ToolRegistry } from "@agent-service/core";
import type { ProviderService } from "@agent-service/providers";
import type { SessionStore } from "@agent-service/store";
import { createApp } from "../src/app.js";

const TOKEN = "runner-runtime-drain-http-token-001";
const RUNNER_ID = "runner-a";
const BOOT_ID = "boot-a";
const AUTHORITY = {
  requestId: "erase_019a2b3c-4d5e-4f00-8a9b-0c1d2e3f4a5b",
  tenantId: "tenant-a",
  subjectGeneration: 3,
  t3aReceiptSha256: "a".repeat(64),
};

function localReceipt(input: TenantRuntimeDrainRunnerRequest) {
  const body = {
    targetSha256: input.targetSha256,
    runnerId: RUNNER_ID,
    bootId: BOOT_ID,
    requestId: input.requestId,
    tenantId: input.tenantId,
    subjectGeneration: input.subjectGeneration,
    t3aReceiptSha256: input.t3aReceiptSha256,
    cacheEntryCountBefore: 2,
    cacheEntryCountAfter: 0 as const,
    activeOperationCountBefore: 1,
    activeOperationCountAfter: 0 as const,
    activeTurnCountBefore: 1,
    activeTurnCountAfter: 0 as const,
    completedAtMs: 100,
  };
  return { ...body, receiptSha256: tenantRuntimeLocalReceiptSha256(body) };
}

function appWithRuntime(enabled: boolean) {
  const drain = vi.fn(async (input: TenantRuntimeDrainRunnerRequest) => localReceipt(input));
  const app = createApp({
    store: {} as SessionStore,
    host: {} as SessionHost,
    providers: {} as ProviderService,
    tools: {} as ToolRegistry,
    runnerId: RUNNER_ID,
    internalRouterToken: TOKEN,
    heartbeatMs: 60_000,
    maxBodyBytes: 1_000_000,
    tenantRuntimeDrain: { bootId: BOOT_ID, drain },
    tenantRuntimeDrainEnabled: enabled,
    ready: () => true,
    decryptSecret: async () => "",
    encryptSecret: async () => ({ ciphertext: Buffer.alloc(0), keyId: "test" }),
  });
  return { app, drain };
}

describe("runner tenant runtime drain private HTTP contract", () => {
  it("keeps code awareness separate from endpoint activation", async () => {
    const { app } = appWithRuntime(false);
    const capabilities = await (await app.request("/v1/capabilities")).json() as {
      features: { tenantRuntimeDrain: string[]; tenantRuntimeDrainEndpoint: boolean };
    };
    expect(capabilities.features.tenantRuntimeDrain).toEqual([TENANT_RUNTIME_DRAIN_V1]);
    expect(capabilities.features.tenantRuntimeDrainEndpoint).toBe(false);
    const ready = await app.request(INTERNAL_TENANT_RUNTIME_DRAIN_READY_PATH, {
      headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: TOKEN },
    });
    expect(ready.status).toBe(503);
    expect(ready.headers.get(INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER)).toBeNull();
    expect(ready.headers.get("cache-control")).toBe("no-store");
    const execute = await app.request(INTERNAL_TENANT_RUNTIME_DRAIN_RUNNER_PATH, {
      method: "POST",
      headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: TOKEN },
      body: "not json",
    });
    expect(execute.status).toBe(503);
  });

  it("authenticates before parsing and returns a private boot-bound ready identity", async () => {
    const { app } = appWithRuntime(true);
    const unauthorized = await app.request(INTERNAL_TENANT_RUNTIME_DRAIN_RUNNER_PATH, {
      method: "POST",
      body: "not json",
    });
    expect(unauthorized.status).toBe(404);
    expect(unauthorized.headers.get("cache-control")).toBe("no-store");

    const ready = await app.request(INTERNAL_TENANT_RUNTIME_DRAIN_READY_PATH, {
      headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: TOKEN },
    });
    expect(ready.status).toBe(200);
    expect(ready.headers.get(INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER)).toBe(
      INTERNAL_TENANT_RUNTIME_DRAIN_ACK_VALUE,
    );
    expect(await ready.json()).toEqual({
      protocolVersion: "2026-10-08",
      service: "agent-runner",
      capability: TENANT_RUNTIME_DRAIN_V1,
      endpointEnabled: true,
      runnerId: RUNNER_ID,
      bootId: BOOT_ID,
    });
  });

  it("rejects stale identity before local drain and validates the returned receipt", async () => {
    const { app, drain } = appWithRuntime(true);
    const targetSha256 = tenantRuntimeTargetSha256("http://runner-a:8787");
    const call = (expectedBootId: string) => app.request(INTERNAL_TENANT_RUNTIME_DRAIN_RUNNER_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [INTERNAL_ROUTER_TOKEN_HEADER]: TOKEN,
      },
      body: JSON.stringify({
        ...AUTHORITY,
        targetSha256,
        expectedRunnerId: RUNNER_ID,
        expectedBootId,
      }),
    });
    const stale = await call("boot-restarted");
    expect(stale.status).toBe(409);
    expect(stale.headers.get(INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER)).toBeNull();
    expect(drain).not.toHaveBeenCalled();

    const response = await call(BOOT_ID);
    expect(response.status).toBe(200);
    expect(response.headers.get(INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER)).toBe(
      INTERNAL_TENANT_RUNTIME_DRAIN_ACK_VALUE,
    );
    expect(await response.json()).toEqual(localReceipt({
      ...AUTHORITY,
      targetSha256,
      expectedRunnerId: RUNNER_ID,
      expectedBootId: BOOT_ID,
    }));
    expect(drain).toHaveBeenCalledOnce();

    const unsupported = await app.request(`${INTERNAL_TENANT_RUNTIME_DRAIN_RUNNER_PATH}/extra`, {
      method: "POST",
      headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: TOKEN },
    });
    expect(unsupported.status).toBe(404);
  });
});
