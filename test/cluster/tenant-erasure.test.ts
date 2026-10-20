import { afterEach, describe, expect, it } from "vitest";
import {
  INTERNAL_ROUTER_TOKEN_HEADER,
  INTERNAL_TENANT_ERASURE_ACTOR_HEADER,
  INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX,
  INTERNAL_TENANT_ERASURE_REPLAY_PATH,
  type TenantErasureStatusResponse,
} from "../../packages/protocol/src/index.js";
import {
  api,
  INTERNAL_ROUTER_TOKEN,
  queryDb,
  startCluster,
  TENANT_ERASURE_OPERATOR_TOKEN,
  type Cluster,
} from "./harness.js";

const enabled = !!process.env.AGENT_SERVICE_CLUSTER;
let cluster: Cluster | undefined;
let pendingStart: Promise<Cluster> | undefined;

function beginCluster(signal: AbortSignal, options: Parameters<typeof startCluster>[0]): Promise<Cluster> {
  const startup = startCluster({ ...options, signal });
  pendingStart = startup;
  // Vitest may time out before the test resumes; afterEach still owns the original promise.
  void startup.catch(() => {});
  return startup;
}

afterEach(async ({ task }) => {
  const startup = pendingStart; pendingStart = undefined;
  try {
    const prepared = startup ? await startup : undefined;
    await (cluster ?? prepared)?.stop({ successful: task.result?.state === "pass" });
  } finally { cluster = undefined; }
});

interface TenantErasureResponse {
  id: string;
  scope: "tenant";
  tenantId: string;
  generation: number;
  status: "gated";
  createdAtMs: number;
  updatedAtMs: number;
  requestedByKeyId?: never;
  idempotencyKey?: never;
  requestHash?: never;
}

function platformHeaders(idempotencyKey?: string): Record<string, string> {
  return {
    authorization: `Bearer ${TENANT_ERASURE_OPERATOR_TOKEN}`,
    ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
  };
}

describe.skipIf(!enabled)("cluster: platform tenant-erasure admission", () => {
  it("authenticates independently, converges concurrent replay, fences credentials, and preserves status", async ({ signal }) => {
    cluster = await beginCluster(signal, { runners: 2, tenantErasureRequestsEnabled: true });

    const tenantCredential = await api(cluster.router.url, "/v1/agents");
    expect(tenantCredential.status).toBe(200);
    const wrongAuthority = await api(cluster.router.url, "/v1/tenant-erasure-requests", {
      method: "POST",
      headers: { "idempotency-key": "wrong-authority" },
      body: JSON.stringify({ tenantId: "t_cluster" }),
    });
    expect(wrongAuthority.status).toBe(401);
    expect(await queryDb<{ n: number }>(
      "SELECT COUNT(*) AS n FROM tenant_erasure_admissions",
    )).toEqual([{ n: 0 }]);

    const attempts = await Promise.all(Array.from({ length: 8 }, (_, index) => (
      api<TenantErasureResponse>(cluster!.router.url, "/v1/tenant-erasure-requests", {
        method: "POST",
        headers: platformHeaders(index % 2 === 0 ? "tenant-offboard-a" : "tenant-offboard-b"),
        body: JSON.stringify({ tenantId: "t_cluster" }),
      })
    )));
    expect(attempts.every((attempt) => attempt.status === 202)).toBe(true);
    const ids = new Set(attempts.map((attempt) => attempt.body.id));
    expect(ids.size).toBe(1);
    const request = attempts[0]!.body;
    expect(request).toEqual({
      id: request.id,
      scope: "tenant",
      tenantId: "t_cluster",
      generation: 1,
      status: "gated",
      createdAtMs: request.createdAtMs,
      updatedAtMs: request.updatedAtMs,
    });
    expect(attempts[0]!.headers.get("x-agent-service-tenant-erasure-route")).toBeNull();

    const [proof] = await queryDb<{
      request_id: string;
      requested_by_key_id: string;
      lifecycle_state: string;
      lifecycle_request_id: string;
      fence_request_id: string;
      audit_type: string;
    }>(
      `SELECT a.request_id, a.requested_by_key_id, l.state AS lifecycle_state,
              l.active_request_id AS lifecycle_request_id,
              f.request_id AS fence_request_id, e.event_type AS audit_type
         FROM tenant_erasure_admissions a
         JOIN subject_lifecycle l
           ON l.tenant_id=a.tenant_id AND l.subject_kind='tenant' AND l.subject_id=a.tenant_id
         JOIN tenant_credential_revocation_fences f ON f.tenant_id=a.tenant_id
         JOIN erasure_audit_events e ON e.request_id=a.request_id AND e.seq=1`,
    );
    expect(proof).toEqual({
      request_id: request.id,
      requested_by_key_id: "cluster-platform-operator",
      lifecycle_state: "deleting",
      lifecycle_request_id: request.id,
      fence_request_id: request.id,
      audit_type: "erasure/gated",
    });

    const status = await api<TenantErasureStatusResponse>(
      cluster.router.url,
      `/v1/tenant-erasure-requests/${request.id}?tenantId=t_cluster`,
      { headers: platformHeaders() },
    );
    expect(status.status).toBe(200);
    // GET adds the closed 0059 observation; admission/replay POST above keeps its exact
    // seven-field contract. No worker has cleared credentials or established remote scope.
    const expectedStatus: TenantErasureStatusResponse = {
      ...request,
      credentialResponsibility: {
        schema: "tenant-credential-responsibility-status-v1",
        status: "unknown",
        localDatabase: "not_cleared",
        trackedRuntimeReferences: "unknown",
        remoteCredentials: "unknown",
        sharedKeys: "platform_shared_not_tenant_deletable",
        backupCopies: "unknown",
        otherCopies: "unknown",
        versionCount: null,
        customerManagedApiKeyCount: null,
        unknownMaterialCount: null,
        executionReady: false,
        externalAuthorityVerified: false,
        allDomainsComplete: false,
        contentPurgeExecuted: false,
      },
    };
    expect(status.body).toEqual(expectedStatus);
    expect(status.headers.get("cache-control")).toBe("no-store");
    expect(status.headers.get("x-content-type-options")).toBe("nosniff");
    expect(status.headers.get("x-agent-service-tenant-erasure-route")).toBeNull();

    const wrongTenant = await api(
      cluster.router.url,
      `/v1/tenant-erasure-requests/${request.id}?tenantId=t_other`,
      { headers: platformHeaders() },
    );
    expect(wrongTenant.status).toBe(404);
    expect((await api(cluster.router.url, "/v1/agents")).status).toBe(401);

    // The operator token is not accepted by a directly reached runner, and the versioned route
    // reveals nothing without the separate router-internal credential.
    const directPublic = await api(cluster.runners[0]!.url, "/v1/tenant-erasure-requests", {
      method: "POST",
      headers: platformHeaders("direct-public"),
      body: JSON.stringify({ tenantId: "t_cluster" }),
    });
    expect(directPublic.status).toBe(401);
    const directPrivate = await fetch(
      `${cluster.runners[0]!.url}${INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TENANT_ERASURE_OPERATOR_TOKEN}`,
          "content-type": "application/json",
          "idempotency-key": "direct-private",
        },
        body: JSON.stringify({ tenantId: "t_cluster" }),
      },
    );
    expect(directPrivate.status).toBe(404);
    const directReplay = await fetch(`${cluster.runners[0]!.url}${INTERNAL_TENANT_ERASURE_REPLAY_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TENANT_ERASURE_OPERATOR_TOKEN}`,
        "content-type": "application/json",
        "idempotency-key": "direct-replay",
      },
      body: JSON.stringify({ tenantId: "t_cluster" }),
    });
    expect(directReplay.status).toBe(404);
  }, 45_000);

  it("blocks mixed-fleet admission at both the router and the selected runner", async ({ signal }) => {
    cluster = await beginCluster(signal, {
      runners: 2,
      tenantErasureRequestsEnabled: true,
      tenantErasureRequestsEnabledForRunner: (runnerNumber) => runnerNumber === 1,
    });

    const edge = await api(cluster.router.url, "/v1/tenant-erasure-requests", {
      method: "POST",
      headers: platformHeaders("mixed-edge"),
      body: JSON.stringify({ tenantId: "t_cluster" }),
    });
    expect(edge.status).toBe(503);

    const bypass = await fetch(
      `${cluster.runners[0]!.url}${INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "mixed-direct",
          [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_ROUTER_TOKEN,
          [INTERNAL_TENANT_ERASURE_ACTOR_HEADER]: "cluster-platform-operator",
        },
        body: JSON.stringify({ tenantId: "t_cluster" }),
      },
    );
    expect(bypass.status).toBe(503);
    expect(await queryDb<{ n: number }>(
      "SELECT COUNT(*) AS n FROM tenant_erasure_admissions",
    )).toEqual([{ n: 0 }]);
    expect((await api(cluster.router.url, "/v1/agents")).status).toBe(200);
  }, 45_000);

  it("recovers only the exact committed POST after a gate-off fleet restart", async ({ signal }) => {
    cluster = await beginCluster(signal, { runners: 2, tenantErasureRequestsEnabled: true });
    const first = await api<TenantErasureResponse>(
      cluster.router.url,
      "/v1/tenant-erasure-requests",
      {
        method: "POST",
        headers: platformHeaders("restart-replay-exact"),
        body: JSON.stringify({ tenantId: "t_cluster" }),
      },
    );
    expect(first.status).toBe(202);
    const retainedMysqlRuntime = cluster.mysqlRuntime;
    await cluster.stop({ retainMysqlRuntime: true });
    cluster = undefined;

    cluster = await beginCluster(signal, {
      runners: 2,
      tenantErasureRequestsEnabled: false,
      resetDatabase: false,
      mysqlRuntime: retainedMysqlRuntime,
    });
    const replay = await api<TenantErasureResponse>(
      cluster.router.url,
      "/v1/tenant-erasure-requests",
      {
        method: "POST",
        headers: platformHeaders("restart-replay-exact"),
        body: JSON.stringify({ tenantId: "t_cluster" }),
      },
    );
    expect(replay.status).toBe(202);
    expect(replay.body).toEqual(first.body);

    for (const [tenantId, key] of [
      ["t_cluster", "restart-replay-different"],
      ["t_other", "restart-replay-exact"],
    ] as const) {
      const absent = await api(cluster.router.url, "/v1/tenant-erasure-requests", {
        method: "POST",
        headers: platformHeaders(key),
        body: JSON.stringify({ tenantId }),
      });
      expect(absent.status).toBe(503);
    }

    const [counts] = await queryDb<{
      admissions: number;
      audits: number;
      fences: number;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM tenant_erasure_admissions) AS admissions,
         (SELECT COUNT(*) FROM erasure_audit_events WHERE request_id=?) AS audits,
         (SELECT COUNT(*) FROM tenant_credential_revocation_fences) AS fences`,
      [first.body.id],
    );
    expect(counts).toEqual({ admissions: 1, audits: 1, fences: 1 });
  }, 45_000);
});
