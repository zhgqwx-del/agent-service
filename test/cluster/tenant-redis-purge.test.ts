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
} from "./harness.js";

const enabled = !!process.env.AGENT_SERVICE_CLUSTER;
let cluster: Cluster | undefined;

afterEach(async () => {
  await cluster?.stop();
  cluster = undefined;
});

async function redisPurgeBarrier(base: string): Promise<Response> {
  return fetch(`${base}${INTERNAL_TENANT_REDIS_PURGE_READY_PATH}`, {
    headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_ROUTER_TOKEN },
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
  it("advertises code awareness without granting destructive authority by default", async () => {
    cluster = await startCluster({ runners: 1 });
    const namespaceSha256 = tenantRedisNamespaceSha256("agent-service-cluster-db3", "as");

    const runner = await api<RedisPurgeCapabilities>(
      cluster.runners[0]!.url,
      "/v1/capabilities",
    );
    expect(runner.status).toBe(200);
    expect(runner.body.features.tenantRedisPurge).toEqual([
      TENANT_REDIS_PURGE_SESSION_STATE_DELETE_V1,
    ]);
    expect(runner.body.features.tenantRedisPurgeWorker).toBe(false);
    expect(runner.body.features.tenantRedisPurgeNamespaceSha256).toBe(namespaceSha256);

    const router = await api<RedisPurgeCapabilities>(cluster.router.url, "/v1/capabilities");
    expect(router.status).toBe(200);
    expect(router.body.features.tenantRedisPurge).toEqual([
      TENANT_REDIS_PURGE_SESSION_STATE_DELETE_V1,
    ]);
    expect(router.body.features.tenantRedisPurgeWorker).toBe(false);
    expect(router.body.features.tenantRedisPurgeNamespaceSha256).toBe(namespaceSha256);
    expect(router.body.features.dataPurgeExecution).toBe(false);

    const barrier = await redisPurgeBarrier(cluster.router.url);
    expect(barrier.status).toBe(503);
    expect(barrier.headers.get(INTERNAL_TENANT_REDIS_PURGE_ACK_HEADER)).toBeNull();
    expect(barrier.headers.get("cache-control")).toContain("no-store");
  });

  it("fails closed when one configured worker is disabled or targets another namespace", async () => {
    cluster = await startCluster({
      runners: 2,
      tenantRedisPurgeEnabled: true,
      tenantRedisPurgeWorkerEnabled: true,
      tenantRedisPurgeWorkerEnabledForRunner: (runnerNumber) => runnerNumber === 1,
    });
    const mixedWorkers = await redisPurgeBarrier(cluster.router.url);
    expect(mixedWorkers.status).toBe(503);
    expect(mixedWorkers.headers.get(INTERNAL_TENANT_REDIS_PURGE_ACK_HEADER)).toBeNull();
    await cluster.stop();
    cluster = undefined;

    cluster = await startCluster({
      runners: 2,
      tenantRedisPurgeEnabled: true,
      tenantRedisPurgeWorkerEnabled: true,
      runnerEnv: (runnerNumber): Record<string, string> => runnerNumber === 2
        ? { REDIS_NAMESPACE_ID: "different-cluster-namespace" }
        : {},
    });
    const mixedNamespaces = await redisPurgeBarrier(cluster.router.url);
    expect(mixedNamespaces.status).toBe(503);
    expect(mixedNamespaces.headers.get(INTERNAL_TENANT_REDIS_PURGE_ACK_HEADER)).toBeNull();
  });

  it("ACKs only an active all-configured fleet bound to the exact namespace", async () => {
    cluster = await startCluster({
      runners: 2,
      tenantRedisPurgeEnabled: true,
      tenantRedisPurgeWorkerEnabled: true,
    });

    const barrier = await redisPurgeBarrier(cluster.router.url);
    expect(barrier.status).toBe(204);
    expect(barrier.headers.get(INTERNAL_TENANT_REDIS_PURGE_ACK_HEADER)).toBe(
      INTERNAL_TENANT_REDIS_PURGE_ACK_VALUE,
    );
    expect(barrier.headers.get("cache-control")).toBe("no-store");

    const capabilities = await api<RedisPurgeCapabilities>(
      cluster.router.url,
      "/v1/capabilities",
    );
    expect(capabilities.status).toBe(200);
    expect(capabilities.body.features.tenantRedisPurgeWorker).toBe(true);
    expect(capabilities.body.features.tenantRedisPurgeNamespaceSha256).toBe(
      tenantRedisNamespaceSha256("agent-service-cluster-db3", "as"),
    );
    expect(capabilities.body.features.dataPurgeExecution).toBe(false);
  });
});
