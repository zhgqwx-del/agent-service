import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INTERNAL_ROUTER_TOKEN_HEADER,
  INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER,
  INTERNAL_TENANT_RUNTIME_DRAIN_ACK_VALUE,
  INTERNAL_TENANT_RUNTIME_DRAIN_READY_PATH,
  INTERNAL_TENANT_RUNTIME_DRAIN_ROUTER_PATH,
  INTERNAL_TENANT_RUNTIME_DRAIN_RUNNER_PATH,
  TenantRuntimeDrainRunnerRequest,
  TenantRuntimeRevocationFleetProof,
  tenantRuntimeFleetSha256,
  tenantRuntimeLocalReceiptSha256,
  tenantRuntimeTargetSha256,
  type TenantRuntimeDrainRequest,
} from "@agent-service/protocol";
import { createRouterApp } from "../src/app.js";
import type {
  RunnerRegistry,
  TenantRuntimeDrainFleetSnapshot,
  TenantRuntimeDrainTarget,
} from "../src/registry.js";

const INTERNAL_TOKEN = "router-runtime-drain-token-000001";
const AUTHORITY: TenantRuntimeDrainRequest = {
  requestId: "erase_019a2b3c-4d5e-4f00-8a9b-0c1d2e3f4a5b",
  tenantId: "tenant-a",
  subjectGeneration: 3,
  t3aReceiptSha256: "a".repeat(64),
};

afterEach(() => vi.unstubAllGlobals());

function snapshot(targets: readonly TenantRuntimeDrainTarget[]): TenantRuntimeDrainFleetSnapshot {
  const canonical = [...targets].sort((left, right) => (
    left.targetSha256 < right.targetSha256 ? -1 : 1
  ));
  return {
    fleetSha256: tenantRuntimeFleetSha256(canonical),
    targets: canonical,
  };
}

function registryWithSnapshots(
  snapshots: readonly TenantRuntimeDrainFleetSnapshot[],
  calls: { count: number },
): RunnerRegistry {
  return {
    freshTenantRuntimeDrainSnapshot: async () => {
      const next = snapshots[Math.min(calls.count, snapshots.length - 1)];
      calls.count += 1;
      if (!next) throw new Error("no snapshot");
      return next;
    },
  } as unknown as RunnerRegistry;
}

function target(url: string, runnerId: string, bootId: string): TenantRuntimeDrainTarget {
  return { url, targetSha256: tenantRuntimeTargetSha256(url), runnerId, bootId };
}

function runtimeFetch(options: {
  missingAckRunnerId?: string;
  oversizedRunnerId?: string;
  mutate?: (receipt: Record<string, unknown>, input: TenantRuntimeDrainRunnerRequest) => void;
} = {}) {
  const requests = new Map<string, TenantRuntimeDrainRunnerRequest[]>();
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname !== INTERNAL_TENANT_RUNTIME_DRAIN_RUNNER_PATH) {
      return new Response(null, { status: 404 });
    }
    const request = TenantRuntimeDrainRunnerRequest.parse(JSON.parse(String(init?.body)));
    const received = requests.get(request.expectedRunnerId) ?? [];
    received.push(request);
    requests.set(request.expectedRunnerId, received);
    if (request.expectedRunnerId === options.oversizedRunnerId) {
      return new Response("x".repeat(8_193), {
        headers: {
          [INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER]:
            INTERNAL_TENANT_RUNTIME_DRAIN_ACK_VALUE,
          "cache-control": "no-store",
        },
      });
    }
    const body = {
      targetSha256: request.targetSha256,
      runnerId: request.expectedRunnerId,
      bootId: request.expectedBootId,
      requestId: request.requestId,
      tenantId: request.tenantId,
      subjectGeneration: request.subjectGeneration,
      t3aReceiptSha256: request.t3aReceiptSha256,
      cacheEntryCountBefore: 2,
      cacheEntryCountAfter: 0 as const,
      activeOperationCountBefore: 1,
      activeOperationCountAfter: 0 as const,
      activeTurnCountBefore: 1,
      activeTurnCountAfter: 0 as const,
      completedAtMs: 100,
    };
    const receipt: Record<string, unknown> = {
      ...body,
      receiptSha256: tenantRuntimeLocalReceiptSha256(body),
    };
    options.mutate?.(receipt, request);
    return Response.json(receipt, {
      headers: request.expectedRunnerId === options.missingAckRunnerId
        ? { "cache-control": "no-store" }
        : {
            [INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER]:
              INTERNAL_TENANT_RUNTIME_DRAIN_ACK_VALUE,
            "cache-control": "no-store",
          },
    });
  });
  return { fetchImpl, requests };
}

describe("router tenant runtime drain fanout", () => {
  it("authenticates before parsing and keeps the execution gate closed by default", async () => {
    const calls = { count: 0 };
    const registry = registryWithSnapshots([], calls);
    const app = createRouterApp({ registry, internalRunnerToken: INTERNAL_TOKEN });
    const unauthorized = await app.request(INTERNAL_TENANT_RUNTIME_DRAIN_ROUTER_PATH, {
      method: "POST",
      body: "not json",
    });
    expect(unauthorized.status).toBe(404);
    expect(unauthorized.headers.get("cache-control")).toBe("no-store");
    const gated = await app.request(INTERNAL_TENANT_RUNTIME_DRAIN_ROUTER_PATH, {
      method: "POST",
      headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_TOKEN },
      body: "not json",
    });
    expect(gated.status).toBe(503);
    const reserved = await app.request(INTERNAL_TENANT_RUNTIME_DRAIN_READY_PATH, {
      headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_TOKEN },
    });
    expect(reserved.status).toBe(404);
    expect(reserved.headers.get("cache-control")).toBe("no-store");
    expect(calls.count).toBe(0);

    const enabled = createRouterApp({
      registry,
      internalRunnerToken: INTERNAL_TOKEN,
      tenantRuntimeDrainExecutionEnabled: () => true,
    });
    const oversized = await enabled.request(INTERNAL_TENANT_RUNTIME_DRAIN_ROUTER_PATH, {
      method: "POST",
      headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_TOKEN },
      body: "x".repeat(4_097),
    });
    expect(oversized.status).toBe(400);
    expect(calls.count).toBe(0);
  });

  it("broadcasts once to every exact snapshot target and returns a canonical fleet proof", async () => {
    const fleet = snapshot([
      target("http://runner-a:8787", "runner-a", "boot-a"),
      target("http://runner-b:8787", "runner-b", "boot-b"),
    ]);
    const calls = { count: 0 };
    const { requests, fetchImpl } = runtimeFetch();
    const app = createRouterApp({
      registry: registryWithSnapshots([fleet, fleet], calls),
      internalRunnerToken: INTERNAL_TOKEN,
      tenantRuntimeDrainExecutionEnabled: () => true,
      fetchImpl,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    const response = await app.request(INTERNAL_TENANT_RUNTIME_DRAIN_ROUTER_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_TOKEN,
      },
      body: JSON.stringify(AUTHORITY),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get(INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER)).toBe(
      INTERNAL_TENANT_RUNTIME_DRAIN_ACK_VALUE,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    const proof = TenantRuntimeRevocationFleetProof.parse(await response.json());
    expect(proof.fleetSha256).toBe(fleet.fleetSha256);
    expect(proof.targets.map((receipt) => receipt.runnerId).sort()).toEqual([
      "runner-a",
      "runner-b",
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(requests.get("runner-a")).toHaveLength(1);
    expect(requests.get("runner-b")).toHaveLength(1);
    expect(requests.get("runner-a")?.[0]).toMatchObject({
      ...AUTHORITY,
      expectedRunnerId: "runner-a",
    });
    expect(calls.count).toBe(2);
  });

  it("fails closed on one bad ACK and on a boot change after a successful partial fanout", async () => {
    const first = snapshot([
      target("http://runner-a:8787", "runner-a", "boot-a"),
      target("http://runner-b:8787", "runner-b", "boot-b"),
    ]);
    const badAckCalls = { count: 0 };
    const badAckFetch = runtimeFetch({ missingAckRunnerId: "runner-b" });
    const badAck = createRouterApp({
      registry: registryWithSnapshots([first], badAckCalls),
      internalRunnerToken: INTERNAL_TOKEN,
      tenantRuntimeDrainExecutionEnabled: () => true,
      fetchImpl: badAckFetch.fetchImpl,
    });
    const request = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_TOKEN,
      },
      body: JSON.stringify(AUTHORITY),
    } satisfies RequestInit;
    expect((await badAck.request(INTERNAL_TENANT_RUNTIME_DRAIN_ROUTER_PATH, request)).status)
      .toBe(503);
    expect(badAckFetch.requests.get("runner-a")).toHaveLength(1);
    expect(badAckFetch.requests.get("runner-b")).toHaveLength(1);

    const before = snapshot([target("http://runner-c:8787", "runner-c", "boot-c")]);
    const after = snapshot([
      target("http://runner-c:8787", "runner-c", "boot-c-restarted"),
    ]);
    const restartCalls = { count: 0 };
    const restartFetch = runtimeFetch();
    const restart = createRouterApp({
      registry: registryWithSnapshots([before, after], restartCalls),
      internalRunnerToken: INTERNAL_TOKEN,
      tenantRuntimeDrainExecutionEnabled: () => true,
      fetchImpl: restartFetch.fetchImpl,
    });
    const changed = await restart.request(INTERNAL_TENANT_RUNTIME_DRAIN_ROUTER_PATH, request);
    expect(changed.status).toBe(503);
    expect(changed.headers.get(INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER)).toBeNull();
    expect(restartFetch.requests.get("runner-c")).toHaveLength(1);
    expect(restartCalls.count).toBe(2);
  });

  it("rejects an acknowledged runner response above the private receipt ceiling", async () => {
    const fleet = snapshot([
      target("http://runner-a:8787", "runner-a", "boot-a"),
    ]);
    const calls = { count: 0 };
    const transport = runtimeFetch({ oversizedRunnerId: "runner-a" });
    const app = createRouterApp({
      registry: registryWithSnapshots([fleet], calls),
      internalRunnerToken: INTERNAL_TOKEN,
      tenantRuntimeDrainExecutionEnabled: () => true,
      fetchImpl: transport.fetchImpl,
    });
    const response = await app.request(INTERNAL_TENANT_RUNTIME_DRAIN_ROUTER_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_TOKEN,
      },
      body: JSON.stringify(AUTHORITY),
    });
    expect(response.status).toBe(503);
    expect(response.headers.get(INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER)).toBeNull();
    expect(calls.count).toBe(1);
  });
});
