import { afterEach, describe, expect, it } from "vitest";
import {
  INTERNAL_ROUTER_TOKEN_HEADER,
  INTERNAL_TENANT_REDIS_PURGE_ACK_HEADER,
  INTERNAL_TENANT_REDIS_PURGE_ACK_VALUE,
  INTERNAL_TENANT_REDIS_PURGE_READY_PATH,
  TENANT_REDIS_PURGE_SESSION_STATE_DELETE_V1,
  tenantRedisNamespaceSha256,
} from "../../packages/protocol/src/index.js";
import {
  api,
  INTERNAL_ROUTER_TOKEN,
  startCluster,
  type Cluster,
  type ClusterOptions,
} from "./harness.js";

const enabled = !!process.env.AGENT_SERVICE_CLUSTER;
let cluster: Cluster | undefined;
let pendingStart: Promise<Cluster> | undefined;

function startCaseCluster(options: ClusterOptions, signal: AbortSignal): Promise<Cluster> {
  const pending = startCluster({ ...options, signal });
  pendingStart = pending;
  void pending.catch(() => {}); // The body and failure cleanup still join the original promise.
  return pending;
}

afterEach(async ({ task }) => {
  try {
    if (pendingStart) {
      const [startup] = await Promise.allSettled([pendingStart] as const);
      if (startup.status === "fulfilled") cluster = startup.value;
      // A rejected start has already joined the harness's native failure cleanup.
    }
    await cluster?.stop({ successful: task.result?.state === "pass" });
  } finally {
    cluster = undefined;
    pendingStart = undefined;
  }
});

async function redisPurgeBarrier(base: string, signal: AbortSignal): Promise<Response> {
  return fetch(`${base}${INTERNAL_TENANT_REDIS_PURGE_READY_PATH}`, {
    headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_ROUTER_TOKEN },
    signal,
  });
}

interface RedisPurgeCapabilities {
  features: {
    tenantRedisPurge: string[];
    tenantRedisPurgeWorker: boolean;
    tenantRedisPurgeNamespaceSha256: string | null;
    dataPurgeExecution: boolean;
  };
}

describe.skipIf(!enabled)("cluster: tenant Redis purge rollout", () => {
  it("advertises code awareness without granting destructive authority by default", async (testContext) => {
    cluster = await startCaseCluster({ runners: 1, mysqlPreparationTimeoutMs: 35_000 }, testContext.signal);
    const namespaceSha256 = tenantRedisNamespaceSha256("agent-service-cluster-db3", "as");

    const runner = await api<RedisPurgeCapabilities>(
      cluster.runners[0]!.url,
      "/v1/capabilities",
      { signal: testContext.signal },
    );
    expect(runner.status).toBe(200);
    expect(runner.body.features.tenantRedisPurge).toEqual([
      TENANT_REDIS_PURGE_SESSION_STATE_DELETE_V1,
    ]);
    expect(runner.body.features.tenantRedisPurgeWorker).toBe(false);
    expect(runner.body.features.tenantRedisPurgeNamespaceSha256).toBe(namespaceSha256);

    const router = await api<RedisPurgeCapabilities>(cluster.router.url, "/v1/capabilities", { signal: testContext.signal });
    expect(router.status).toBe(200);
    expect(router.body.features.tenantRedisPurge).toEqual([
      TENANT_REDIS_PURGE_SESSION_STATE_DELETE_V1,
    ]);
    expect(router.body.features.tenantRedisPurgeWorker).toBe(false);
    expect(router.body.features.tenantRedisPurgeNamespaceSha256).toBe(namespaceSha256);
    expect(router.body.features.dataPurgeExecution).toBe(false);

    const barrier = await redisPurgeBarrier(cluster.router.url, testContext.signal);
    expect(barrier.status).toBe(503);
    expect(barrier.headers.get(INTERNAL_TENANT_REDIS_PURGE_ACK_HEADER)).toBeNull();
    expect(barrier.headers.get("cache-control")).toContain("no-store");
  }, 45_000);

  const mismatchedFleets: Array<{ label: string; options: ClusterOptions }> = [
    { label: "worker disabled", options: {
      runners: 2,
      tenantRedisPurgeEnabled: true,
      tenantRedisPurgeWorkerEnabled: true,
      tenantRedisPurgeWorkerEnabledForRunner: (runnerNumber) => runnerNumber === 1,
    } },
    { label: "namespace mismatch", options: {
      runners: 2,
      tenantRedisPurgeEnabled: true,
      tenantRedisPurgeWorkerEnabled: true,
      runnerEnv: (runnerNumber): Record<string, string> => runnerNumber === 2
        ? { REDIS_NAMESPACE_ID: "different-cluster-namespace" }
        : {},
    } },
  ];
  for (const { label, options } of mismatchedFleets) {
    it(`fails closed for a configured fleet: '${label}'`, async (testContext) => {
      cluster = await startCaseCluster(options, testContext.signal);
      const barrier = await redisPurgeBarrier(cluster.router.url, testContext.signal);
      expect(barrier.status).toBe(503);
      expect(barrier.headers.get(INTERNAL_TENANT_REDIS_PURGE_ACK_HEADER)).toBeNull();
      // Keep successful cleanup inside each independent scenario's budget.
      await cluster.stop({ successful: true });
      cluster = undefined;
      pendingStart = undefined;
    }, 45_000);
  }

  it("ACKs only an active all-configured fleet bound to the exact namespace", async (testContext) => {
    cluster = await startCaseCluster({
      runners: 2,
      tenantRedisPurgeEnabled: true,
      tenantRedisPurgeWorkerEnabled: true,
    }, testContext.signal);

    const barrier = await redisPurgeBarrier(cluster.router.url, testContext.signal);
    expect(barrier.status).toBe(204);
    expect(barrier.headers.get(INTERNAL_TENANT_REDIS_PURGE_ACK_HEADER)).toBe(
      INTERNAL_TENANT_REDIS_PURGE_ACK_VALUE,
    );
    expect(barrier.headers.get("cache-control")).toBe("no-store");

    const capabilities = await api<RedisPurgeCapabilities>(
      cluster.router.url,
      "/v1/capabilities",
      { signal: testContext.signal },
    );
    expect(capabilities.status).toBe(200);
    expect(capabilities.body.features.tenantRedisPurgeWorker).toBe(true);
    expect(capabilities.body.features.tenantRedisPurgeNamespaceSha256).toBe(
      tenantRedisNamespaceSha256("agent-service-cluster-db3", "as"),
    );
    expect(capabilities.body.features.dataPurgeExecution).toBe(false);
  }, 45_000);
});
