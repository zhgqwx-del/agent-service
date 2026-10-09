import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  INTERNAL_ROUTER_TOKEN_HEADER,
  INTERNAL_TENANT_CREDENTIAL_REVOCATION_ACK_HEADER,
  INTERNAL_TENANT_CREDENTIAL_REVOCATION_ACK_VALUE,
  INTERNAL_TENANT_CREDENTIAL_REVOCATION_READY_PATH,
  PROTOCOL_VERSION,
} from "../../packages/protocol/src/index.js";
import {
  api,
  INTERNAL_ROUTER_TOKEN,
  queryDb,
  startCluster,
  TENANT_ERASURE_OPERATOR_TOKEN,
  waitFor,
  type Cluster,
} from "./harness.js";

const enabled = !!process.env.AGENT_SERVICE_CLUSTER;
let cluster: Cluster | undefined;
let fakeRunner: Server | undefined;

afterEach(async () => {
  await cluster?.stop();
  cluster = undefined;
  if (fakeRunner) {
    fakeRunner.closeAllConnections();
    await new Promise<void>((resolve) => fakeRunner!.close(() => resolve()));
    fakeRunner = undefined;
  }
});

interface TenantErasureResponse {
  id: string;
  scope: "tenant";
  tenantId: string;
  generation: number;
  status: "gated";
  createdAtMs: number;
  updatedAtMs: number;
}

const platformHeaders = (idempotencyKey?: string): Record<string, string> => ({
  authorization: `Bearer ${TENANT_ERASURE_OPERATOR_TOKEN}`,
  ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
});

async function credentialBarrier(base: string): Promise<Response> {
  return fetch(`${base}${INTERNAL_TENANT_CREDENTIAL_REVOCATION_READY_PATH}`, {
    headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_ROUTER_TOKEN },
  });
}

async function startOldCapabilityRunner(): Promise<{
  url: string;
  setHealthy: (healthy: boolean) => void;
}> {
  let healthy = true;
  const capability = {
    protocolVersion: PROTOCOL_VERSION,
    service: "agent-runner",
    features: {
      streaming: true,
      replay: { persistedEvents: true, hotWindowMs: 60_000 },
      approvals: true,
      sessionLifecycle: ["archive", "unarchive", "tombstone"],
      dynamicTools: false,
      mcp: [],
      skills: false,
      sandbox: ["none"],
      byok: true,
      // Deliberately omit additive T3a fields, as a pre-rollout runner would.
    },
  };
  fakeRunner = createServer((request, response) => {
    if (request.url === "/readyz") {
      response.writeHead(healthy ? 200 : 503, { "content-type": "text/plain" });
      response.end(healthy ? "ready" : "draining");
      return;
    }
    if (request.url === "/v1/capabilities") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(capability));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    fakeRunner!.once("error", reject);
    fakeRunner!.listen(0, "127.0.0.1", resolve);
  });
  const address = fakeRunner.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    setHealthy: (value) => { healthy = value; },
  };
}

describe.skipIf(!enabled)("cluster: tenant credential revocation rollout", () => {
  it("keeps both activation gates off by default", async () => {
    cluster = await startCluster({ runners: 1 });

    const runnerCapabilities = await api<{
      features: { tenantCredentialRevocationWorker: boolean; dataPurgeExecution: boolean };
    }>(cluster.runners[0]!.url, "/v1/capabilities");
    expect(runnerCapabilities.status).toBe(200);
    expect(runnerCapabilities.body.features.tenantCredentialRevocationWorker).toBe(false);
    expect(runnerCapabilities.body.features.dataPurgeExecution).toBe(false);

    const barrier = await credentialBarrier(cluster.router.url);
    expect(barrier.status).toBe(503);
    expect(barrier.headers.get(INTERNAL_TENANT_CREDENTIAL_REVOCATION_ACK_HEADER)).toBeNull();
  });

  it("rejects execution when one configured runner has its worker disabled", async () => {
    cluster = await startCluster({
      runners: 2,
      tenantCredentialRevocationExecutionEnabled: true,
      tenantCredentialRevocationWorkerEnabled: true,
      tenantCredentialRevocationWorkerEnabledForRunner: (runnerNumber) => runnerNumber === 1,
    });

    const barrier = await credentialBarrier(cluster.router.url);
    expect(barrier.status).toBe(503);
    expect(barrier.headers.get(INTERNAL_TENANT_CREDENTIAL_REVOCATION_ACK_HEADER)).toBeNull();
  });

  it("rejects a healthy old capability and then a currently unhealthy configured target", async () => {
    const oldRunner = await startOldCapabilityRunner();
    cluster = await startCluster({
      runners: 1,
      tenantCredentialRevocationExecutionEnabled: true,
      tenantCredentialRevocationWorkerEnabled: true,
      additionalRunnerUrls: [oldRunner.url],
    });

    const oldCapability = await credentialBarrier(cluster.router.url);
    expect(oldCapability.status).toBe(503);
    expect(oldCapability.headers.get(INTERNAL_TENANT_CREDENTIAL_REVOCATION_ACK_HEADER)).toBeNull();

    oldRunner.setHealthy(false);
    const unhealthy = await credentialBarrier(cluster.router.url);
    expect(unhealthy.status).toBe(503);
    expect(unhealthy.headers.get(INTERNAL_TENANT_CREDENTIAL_REVOCATION_ACK_HEADER)).toBeNull();
  });

  it("ACKs an active fleet and processes one MySQL job without claiming content purge", async () => {
    cluster = await startCluster({
      runners: 2,
      tenantErasureRequestsEnabled: true,
      tenantCredentialRevocationExecutionEnabled: true,
      tenantCredentialRevocationWorkerEnabled: true,
    });

    const barrier = await credentialBarrier(cluster.router.url);
    expect(barrier.status).toBe(204);
    expect(barrier.headers.get(INTERNAL_TENANT_CREDENTIAL_REVOCATION_ACK_HEADER)).toBe(
      INTERNAL_TENANT_CREDENTIAL_REVOCATION_ACK_VALUE,
    );

    const admitted = await api<TenantErasureResponse>(
      cluster.router.url,
      "/v1/tenant-erasure-requests",
      {
        method: "POST",
        headers: platformHeaders("credential-revocation-cluster"),
        body: JSON.stringify({ tenantId: "t_cluster" }),
      },
    );
    expect(admitted.status).toBe(202);
    expect(admitted.body.status).toBe("gated");

    const [receipt] = await waitFor(async () => {
      const rows = await queryDb<{
        request_id: string;
        scope: string;
        api_key_count_before: number;
        api_key_count_after: number;
        content_purge_required: number;
      }>(
        `SELECT request_id, scope, api_key_count_before, api_key_count_after,
                content_purge_required
           FROM tenant_credential_revocation_receipts
          WHERE tenant_id=?`,
        ["t_cluster"],
      );
      return rows.length === 1 ? rows : undefined;
    }, 15_000, "tenant credential revocation receipt");
    expect(receipt).toEqual({
      request_id: admitted.body.id,
      scope: "local-db-credential-material-v1",
      api_key_count_before: 1,
      api_key_count_after: 0,
      content_purge_required: 1,
    });

    expect(await queryDb<{ n: number }>(
      "SELECT COUNT(*) AS n FROM api_keys WHERE tenant_id=?",
      ["t_cluster"],
    )).toEqual([{ n: 0 }]);
    expect(await queryDb<{ phase: string }>(
      "SELECT phase FROM tenant_credential_revocation_jobs WHERE request_id=?",
      [admitted.body.id],
    )).toEqual([{ phase: "credential_store_revoked" }]);

    const status = await api<TenantErasureResponse>(
      cluster.router.url,
      `/v1/tenant-erasure-requests/${admitted.body.id}?tenantId=t_cluster`,
      { headers: platformHeaders() },
    );
    expect(status.status).toBe(200);
    expect(status.body.status).toBe("gated");

    const publicCapabilities = await api<{
      features: {
        tenantCredentialRevocationWorker: boolean;
        dataPurgeExecution: boolean;
      };
    }>(cluster.router.url, "/v1/capabilities");
    expect(publicCapabilities.status).toBe(200);
    expect(publicCapabilities.body.features.tenantCredentialRevocationWorker).toBe(true);
    expect(publicCapabilities.body.features.dataPurgeExecution).toBe(false);
  });
});
