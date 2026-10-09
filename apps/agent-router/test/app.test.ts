import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INTERNAL_ERASURE_DRAIN_ACK_HEADER,
  INTERNAL_ERASURE_DRAIN_ACK_VALUE,
  INTERNAL_ERASURE_DRAIN_LOCAL_FENCED_HEADER,
  INTERNAL_ERASURE_DRAIN_LOCAL_FENCED_VALUE,
  INTERNAL_ERASURE_DRAIN_ROUTER_PATH_PREFIX,
  INTERNAL_ERASURE_DRAIN_RUNNER_PATH_PREFIX,
  INTERNAL_ERASURE_JOB_CONTROL_ACK_HEADER,
  INTERNAL_ERASURE_JOB_CONTROL_ACK_VALUE,
  INTERNAL_ERASURE_JOB_CONTROL_READY_PATH,
  INTERNAL_ERASURE_JOB_CONTROL_V1_READY_PATH,
  INTERNAL_PURGE_POLICY_EVALUATION_ACK_HEADER,
  INTERNAL_PURGE_POLICY_EVALUATION_ACK_VALUE,
  INTERNAL_PURGE_POLICY_EVALUATION_READY_PATH,
  INTERNAL_ROUTER_TOKEN_HEADER,
  INTERNAL_TENANT_ERASURE_ADMISSION_ACK_HEADER,
  INTERNAL_TENANT_ERASURE_ADMISSION_ACK_VALUE,
  INTERNAL_TENANT_ERASURE_ADMISSION_READY_PATH,
  INTERNAL_TENANT_ERASURE_ACTOR_HEADER,
  INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX,
  INTERNAL_TENANT_ERASURE_REPLAY_ACK_HEADER,
  INTERNAL_TENANT_ERASURE_REPLAY_ACK_VALUE,
  INTERNAL_TENANT_ERASURE_REPLAY_PATH,
  INTERNAL_TENANT_ERASURE_ROUTE_ACK_HEADER,
  INTERNAL_TENANT_ERASURE_ROUTE_ACK_VALUE,
  INTERNAL_TOMBSTONE_ACK_HEADER,
  INTERNAL_TOMBSTONE_ACK_VALUE,
  INTERNAL_TOMBSTONE_PATH_PREFIX,
  PROTOCOL_VERSION,
  USER_DATA_EXPORT_ARTIFACT_NDJSON_V1,
} from "@agent-service/protocol";
import { createRouterApp } from "../src/app.js";
import type { RunnerRegistry, RunnerTarget } from "../src/registry.js";

/**
 * Router behaviour without a cluster: a fake registry plus small upstream servers cover the routing and
 * proxying rules in milliseconds. The cluster tests then prove the same rules hold across real processes.
 */

const SID = "sess_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
const INTERNAL_TOKEN = "router-test-internal-token-000001";
const TENANT_ERASURE_OPERATOR_TOKEN = "tenant-erasure-operator-token-0001";
const TENANT_ERASURE_REQUEST_ID = "erase_019a2b3c-4d5e-4f00-8a9b-0c1d2e3f4a5b";
let servers: Server[] = [];
afterEach(async () => {
  // closeAllConnections first: keep-alive sockets keep `close()` pending forever otherwise, and the
  // afterEach hook times out instead of the test failing.
  await Promise.all(
    servers.map((s) => {
      s.closeAllConnections?.();
      return new Promise<void>((r) => s.close(() => r()));
    }),
  );
  servers = [];
});

interface Upstream {
  url: string;
  requests: { method: string; path: string; headers: Record<string, string>; body: string }[];
  state: { abortedResponses: number };
}

/** A stand-in runner. `reply` decides the status/headers/body per request. */
async function upstream(reply: (req: { path: string; method: string; body: string; n: number }) => { status?: number; headers?: Record<string, string>; body?: string } | "hang" | "drop"): Promise<Upstream> {
  const requests: Upstream["requests"] = [];
  const state = { abortedResponses: 0 };
  const server = createServer((req, res) => {
    res.on("close", () => {
      if (!res.writableEnded) state.abortedResponses += 1;
    });
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      requests.push({ method: req.method ?? "", path: req.url ?? "", headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])), body });
      const out = reply({ path: req.url ?? "", method: req.method ?? "", body, n: requests.length });
      if (out === "hang") return; // never respond: exercises the header timeout
      if (out === "drop") return res.destroy(); // transport failure after the server received the request
      res.writeHead(out.status ?? 200, { "content-type": "application/json", ...(out.headers ?? {}) });
      res.end(out.body ?? "{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, state };
}

function fakeRegistry(
  targets: string[],
  opts: {
    owner?: string | (() => string | undefined);
    leaseOwnerPresent?: boolean | (() => boolean | undefined);
    healthy?: (url: string) => boolean;
    tombstone?: boolean;
    targetTombstone?: boolean;
    blobs?: boolean;
    targetBlobs?: boolean;
    erasure?: boolean;
    configuredErasure?: boolean;
    targetErasure?: boolean | (() => boolean);
    worker?: boolean;
    targetWorker?: boolean | ((url: string) => boolean);
    jobControl?: boolean;
    governance?: boolean;
    targetGovernance?: boolean;
    governanceManagement?: boolean;
    targetGovernanceManagement?: boolean;
    purgePolicyEvaluation?: boolean;
    exportReadable?: boolean;
    exportAdmission?: boolean;
    targetExport?: boolean | ((url: string) => boolean);
    tenantControl?: boolean;
    tenantAdmission?: boolean;
    targetTenantControl?: boolean | ((url: string) => boolean);
    targetTenantAdmission?: boolean | ((url: string) => boolean);
    refresh?: () => void | Promise<void>;
  } = {},
): RunnerRegistry {
  const list = (): RunnerTarget[] => targets.map((url) => ({ url, healthy: opts.healthy ? opts.healthy(url) : true, lastCheckMs: Date.now(), consecutiveFailures: 0 }));
  let rr = 0;
  const reg = {
    list,
    owner: async () => typeof opts.owner === "function" ? opts.owner() : opts.owner,
    hasLeaseOwner: async () => typeof opts.leaseOwnerPresent === "function"
      ? opts.leaseOwnerPresent()
      : opts.leaseOwnerPresent ?? (
        (typeof opts.owner === "function" ? opts.owner() : opts.owner) !== undefined
      ),
    candidate: () => list().find((t) => t.healthy)?.url,
    anyHealthy: () => {
      const healthy = list().filter((t) => t.healthy);
      return healthy.length ? healthy[rr++ % healthy.length]!.url : undefined;
    },
    allHealthySupportLifecycle: () => opts.tombstone ?? true,
    supportsLifecycle: () => opts.targetTombstone ?? opts.tombstone ?? true,
    allHealthySupportBlobAttachments: () => opts.blobs ?? true,
    supportsBlobAttachments: () => opts.targetBlobs ?? opts.blobs ?? true,
    allHealthySupportDataErasureRequests: () => opts.erasure ?? true,
    allConfiguredSupportDataErasureRequests: () => opts.configuredErasure ?? opts.erasure ?? true,
    supportsDataErasureRequests: () => (
      typeof opts.targetErasure === "function"
        ? opts.targetErasure()
        : opts.targetErasure ?? opts.erasure ?? true
    ),
    allConfiguredSupportDataGovernance: () => opts.governance ?? true,
    supportsDataGovernance: () => opts.targetGovernance ?? opts.governance ?? true,
    allConfiguredSupportDataGovernanceManagement: () => (
      opts.governanceManagement ?? opts.governance ?? true
    ),
    supportsDataGovernanceManagement: () => (
      opts.targetGovernanceManagement
      ?? opts.governanceManagement
      ?? opts.targetGovernance
      ?? opts.governance
      ?? true
    ),
    allHealthySupportUserErasureWorker: () => opts.worker ?? false,
    supportsUserErasureWorker: (url: string) => (
      typeof opts.targetWorker === "function"
        ? opts.targetWorker(url)
        : opts.targetWorker ?? opts.worker ?? false
    ),
    allConfiguredSupportErasureJobControl: () => opts.jobControl ?? true,
    allConfiguredSupportPurgePolicyEvaluation: () => opts.purgePolicyEvaluation ?? false,
    allHealthySupportUserDataExport: () => opts.exportReadable ?? false,
    allConfiguredSupportUserDataExportAdmission: () => opts.exportAdmission ?? false,
    supportsUserDataExport: (url: string) => (
      typeof opts.targetExport === "function"
        ? opts.targetExport(url)
        : opts.targetExport ?? opts.exportReadable ?? false
    ),
    allConfiguredSupportTenantErasureControl: () => opts.tenantControl ?? false,
    allHealthySupportTenantErasureControl: () => opts.tenantControl ?? false,
    allConfiguredSupportTenantErasureAdmission: () => (
      opts.tenantAdmission ?? opts.tenantControl ?? false
    ),
    supportsTenantErasureControl: (url: string) => (
      typeof opts.targetTenantControl === "function"
        ? opts.targetTenantControl(url)
        : opts.targetTenantControl ?? opts.tenantControl ?? false
    ),
    supportsTenantErasureAdmission: (url: string) => (
      typeof opts.targetTenantAdmission === "function"
        ? opts.targetTenantAdmission(url)
        : opts.targetTenantAdmission
          ?? (typeof opts.targetTenantControl === "function"
            ? opts.targetTenantControl(url)
            : opts.targetTenantControl)
          ?? opts.tenantAdmission
          ?? opts.tenantControl
          ?? false
    ),
    toUrl: (addr: string) => targets.find((t) => t.replace(/^https?:\/\//, "") === addr.replace(/^https?:\/\//, "")),
    routeableUrl: (addr: string) => list().find((t) => t.healthy && t.url.replace(/^https?:\/\//, "") === addr.replace(/^https?:\/\//, ""))?.url,
    markFailure: () => {},
    refresh: async () => { await opts.refresh?.(); },
    start: () => {},
    close: async () => {},
    waitForFirstProbe: async () => {},
  };
  return reg as unknown as RunnerRegistry;
}

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const ERASURE_AUTHORITY = {
  tenantId: "tenant-a",
  userId: "user-a",
  requestId: "erase_019a2b3c-4d5e-4f00-8a9b-0c1d2e3f4a5b",
  subjectGeneration: 3,
  claimToken: "worker.claim-3",
  claimAttempt: 4,
};

function expectPrivateLifecycleResponse(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

describe("tenant-erasure platform control", () => {
  it("authenticates before parsing input or observing fleet state", async () => {
    const refresh = vi.fn();
    const app = createRouterApp({
      registry: fakeRegistry(["http://runner.invalid"], {
        tenantControl: true,
        tenantAdmission: true,
        refresh,
      }),
      internalRunnerToken: INTERNAL_TOKEN,
      tenantErasureOperatorToken: TENANT_ERASURE_OPERATOR_TOKEN,
      tenantErasureOperatorId: "platform-lifecycle-admin",
      tenantErasureRequestsEnabled: () => true,
      logger: silent,
    });

    const response = await app.request("/v1/tenant-erasure-requests", {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-tenant-erasure-token-000001",
        "idempotency-key": "tenant-create-1",
        "content-type": "application/json",
      },
      body: "not-json",
    });
    expect(response.status).toBe(401);
    expectPrivateLifecycleResponse(response);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("rewrites an authenticated POST to the runner-only route without forwarding platform headers", async () => {
    const runner = await upstream(() => ({
      status: 202,
      headers: {
        [INTERNAL_TENANT_ERASURE_ROUTE_ACK_HEADER]: INTERNAL_TENANT_ERASURE_ROUTE_ACK_VALUE,
        "x-agent-service-private-extra": "must-not-exist-in-response",
      },
      body: JSON.stringify({
        id: TENANT_ERASURE_REQUEST_ID,
        scope: "tenant",
        tenantId: "tenant-a",
        generation: 1,
        status: "gated",
        createdAtMs: 1,
        updatedAtMs: 1,
      }),
    }));
    const refresh = vi.fn();
    const app = createRouterApp({
      registry: fakeRegistry([runner.url], {
        tenantControl: true,
        tenantAdmission: true,
        refresh,
      }),
      internalRunnerToken: INTERNAL_TOKEN,
      tenantErasureOperatorToken: TENANT_ERASURE_OPERATOR_TOKEN,
      tenantErasureOperatorId: "platform-lifecycle-admin",
      tenantErasureRequestsEnabled: () => true,
      logger: silent,
    });

    const response = await app.request("/v1/tenant-erasure-requests", {
      method: "POST",
      headers: {
        authorization: `bEaReR ${TENANT_ERASURE_OPERATOR_TOKEN}`,
        "idempotency-key": " tenant-create-1 ",
        "content-type": "application/json",
        "x-user-id": "must-not-be-forwarded",
        [INTERNAL_ROUTER_TOKEN_HEADER]: "external-spoofed-internal-token-001",
        [INTERNAL_TENANT_ERASURE_ACTOR_HEADER]: "external-spoofed-actor",
        [INTERNAL_TENANT_ERASURE_ROUTE_ACK_HEADER]: "external-spoofed-ack",
      },
      body: JSON.stringify({ tenantId: "tenant-a" }),
    });

    expect(response.status).toBe(202);
    expectPrivateLifecycleResponse(response);
    expect(response.headers.get(INTERNAL_TENANT_ERASURE_ROUTE_ACK_HEADER)).toBeNull();
    expect(response.headers.get("x-agent-service-private-extra")).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(runner.requests).toHaveLength(1);
    expect(runner.requests[0]).toMatchObject({
      method: "POST",
      path: INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX,
      body: JSON.stringify({ tenantId: "tenant-a" }),
    });
    expect(runner.requests[0]!.headers.authorization).toBeUndefined();
    expect(runner.requests[0]!.headers["x-user-id"]).toBeUndefined();
    expect(runner.requests[0]!.headers[INTERNAL_ROUTER_TOKEN_HEADER]).toBe(INTERNAL_TOKEN);
    expect(runner.requests[0]!.headers[INTERNAL_TENANT_ERASURE_ACTOR_HEADER]).toBe(
      "platform-lifecycle-admin",
    );
    expect(runner.requests[0]!.headers[INTERNAL_TENANT_ERASURE_ROUTE_ACK_HEADER]).toBeUndefined();
    expect(runner.requests[0]!.headers["idempotency-key"]).toBe("tenant-create-1");
  });

  it("fails closed when an ACK-bearing runner violates the public success contract", async () => {
    const runner = await upstream(({ n }) => ({
      status: n === 1 ? 201 : 202,
      headers: {
        [INTERNAL_TENANT_ERASURE_ROUTE_ACK_HEADER]: INTERNAL_TENANT_ERASURE_ROUTE_ACK_VALUE,
      },
      body: JSON.stringify({
        id: TENANT_ERASURE_REQUEST_ID,
        scope: "tenant",
        tenantId: n === 1 ? "tenant-a" : "tenant-b",
        generation: 1,
        status: "gated",
        createdAtMs: 1,
        updatedAtMs: 1,
      }),
    }));
    const app = createRouterApp({
      registry: fakeRegistry([runner.url], { tenantControl: true, tenantAdmission: true }),
      internalRunnerToken: INTERNAL_TOKEN,
      tenantErasureOperatorToken: TENANT_ERASURE_OPERATOR_TOKEN,
      tenantErasureOperatorId: "platform-lifecycle-admin",
      tenantErasureRequestsEnabled: () => true,
      logger: silent,
    });
    const request = (idempotencyKey: string) => app.request("/v1/tenant-erasure-requests", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TENANT_ERASURE_OPERATOR_TOKEN}`,
        "idempotency-key": idempotencyKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ tenantId: "tenant-a" }),
    });

    const wrongStatus = await request("tenant-create-wrong-status");
    expect(wrongStatus.status).toBe(503);
    expectPrivateLifecycleResponse(wrongStatus);

    const wrongIdentity = await request("tenant-create-wrong-identity");
    expect(wrongIdentity.status).toBe(503);
    expectPrivateLifecycleResponse(wrongIdentity);
    expect(runner.requests).toHaveLength(2);
  });

  it("uses a fixed read-only replay route while admission is closed", async () => {
    let admissionEnabled = false;
    const runner = await upstream(() => {
      // Opening the writer gate after route selection must not upgrade this request into a create.
      admissionEnabled = true;
      return {
        status: 202,
        headers: {
          [INTERNAL_TENANT_ERASURE_REPLAY_ACK_HEADER]: INTERNAL_TENANT_ERASURE_REPLAY_ACK_VALUE,
        },
        body: JSON.stringify({
          id: TENANT_ERASURE_REQUEST_ID,
          scope: "tenant",
          tenantId: "tenant-a",
          generation: 1,
          status: "gated",
          createdAtMs: 1,
          updatedAtMs: 1,
        }),
      };
    });
    const app = createRouterApp({
      registry: fakeRegistry([runner.url], { tenantControl: true, tenantAdmission: true }),
      internalRunnerToken: INTERNAL_TOKEN,
      tenantErasureOperatorToken: TENANT_ERASURE_OPERATOR_TOKEN,
      tenantErasureOperatorId: "platform-lifecycle-admin",
      tenantErasureRequestsEnabled: () => admissionEnabled,
      logger: silent,
    });

    const response = await app.request("/v1/tenant-erasure-requests", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TENANT_ERASURE_OPERATOR_TOKEN}`,
        "idempotency-key": "tenant-create-recover",
        "content-type": "application/json",
      },
      body: JSON.stringify({ tenantId: "tenant-a" }),
    });
    expect(response.status).toBe(202);
    expectPrivateLifecycleResponse(response);
    expect(response.headers.get(INTERNAL_TENANT_ERASURE_REPLAY_ACK_HEADER)).toBeNull();
    expect(runner.requests).toHaveLength(1);
    expect(runner.requests[0]).toMatchObject({
      method: "POST",
      path: INTERNAL_TENANT_ERASURE_REPLAY_PATH,
      body: JSON.stringify({ tenantId: "tenant-a" }),
    });
  });

  it("keeps status readable while admission is off and requires the fixed runner ACK on errors", async () => {
    const runner = await upstream(() => ({
      status: 404,
      headers: {
        [INTERNAL_TENANT_ERASURE_ROUTE_ACK_HEADER]: INTERNAL_TENANT_ERASURE_ROUTE_ACK_VALUE,
      },
      body: JSON.stringify({ error: { code: "not_found", message: "not found" } }),
    }));
    const app = createRouterApp({
      registry: fakeRegistry([runner.url], { tenantControl: true, tenantAdmission: false }),
      internalRunnerToken: INTERNAL_TOKEN,
      tenantErasureOperatorToken: TENANT_ERASURE_OPERATOR_TOKEN,
      tenantErasureOperatorId: "platform-lifecycle-admin",
      tenantErasureRequestsEnabled: () => false,
      logger: silent,
    });

    const response = await app.request(
      `/v1/tenant-erasure-requests/${TENANT_ERASURE_REQUEST_ID}?tenantId=tenant-a`,
      { headers: { authorization: `Bearer ${TENANT_ERASURE_OPERATOR_TOKEN}` } },
    );
    expect(response.status).toBe(404);
    expectPrivateLifecycleResponse(response);
    expect(runner.requests[0]!.path).toBe(
      `${INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX}/${TENANT_ERASURE_REQUEST_ID}?tenantId=tenant-a`,
    );
    expect(runner.requests[0]!.headers.authorization).toBeUndefined();
    expect(runner.requests[0]!.headers[INTERNAL_ROUTER_TOKEN_HEADER]).toBe(INTERNAL_TOKEN);
  });

  it("fails closed on mixed fleet state, a missing route ACK, and generic-path bypass attempts", async () => {
    const runner = await upstream(() => ({ status: 201, body: "{}" }));
    const mixed = createRouterApp({
      registry: fakeRegistry([runner.url], { tenantControl: true, tenantAdmission: false }),
      internalRunnerToken: INTERNAL_TOKEN,
      tenantErasureOperatorToken: TENANT_ERASURE_OPERATOR_TOKEN,
      tenantErasureOperatorId: "platform-lifecycle-admin",
      tenantErasureRequestsEnabled: () => true,
      logger: silent,
    });
    const request = {
      method: "POST",
      headers: {
        authorization: `Bearer ${TENANT_ERASURE_OPERATOR_TOKEN}`,
        "idempotency-key": "tenant-create-1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ tenantId: "tenant-a" }),
    };
    const mixedResponse = await mixed.request("/v1/tenant-erasure-requests", request);
    expect(mixedResponse.status).toBe(503);
    expectPrivateLifecycleResponse(mixedResponse);
    expect(runner.requests).toHaveLength(1);
    expect(runner.requests[0]!.path).toBe(INTERNAL_TENANT_ERASURE_REPLAY_PATH);

    const missingAck = createRouterApp({
      registry: fakeRegistry([runner.url], { tenantControl: true, tenantAdmission: true }),
      internalRunnerToken: INTERNAL_TOKEN,
      tenantErasureOperatorToken: TENANT_ERASURE_OPERATOR_TOKEN,
      tenantErasureOperatorId: "platform-lifecycle-admin",
      tenantErasureRequestsEnabled: () => true,
      logger: silent,
    });
    const missingAckResponse = await missingAck.request("/v1/tenant-erasure-requests", request);
    expect(missingAckResponse.status).toBe(503);
    expectPrivateLifecycleResponse(missingAckResponse);

    const bypass = await missingAck.request(INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX, {
      method: "POST",
      headers: { authorization: `Bearer ${TENANT_ERASURE_OPERATOR_TOKEN}` },
    });
    expect(bypass.status).toBe(404);
    expectPrivateLifecycleResponse(bypass);
    const replayBypass = await missingAck.request(INTERNAL_TENANT_ERASURE_REPLAY_PATH, {
      method: "POST",
      headers: { authorization: `Bearer ${TENANT_ERASURE_OPERATOR_TOKEN}` },
    });
    expect(replayBypass.status).toBe(404);
    expectPrivateLifecycleResponse(replayBypass);
    const wrongMethod = await missingAck.request("/v1/tenant-erasure-requests", {
      method: "PUT",
      headers: { authorization: `Bearer ${TENANT_ERASURE_OPERATOR_TOKEN}` },
    });
    expect(wrongMethod.status).toBe(404);
    expectPrivateLifecycleResponse(wrongMethod);

    for (const { path, authorization = `Bearer ${TENANT_ERASURE_OPERATOR_TOKEN}` } of [
      { path: "/v1/tenant-erasure-requests%2Fprobe" },
      { path: "/v1/%74enant-erasure-requests-extra/probe" },
      { path: "/v1/%2574enant-erasure-requests/probe" },
      // Even an unrelated malformed path cannot carry the platform credential through the
      // generic tenant proxy: this token terminates at the router, not merely at one path regex.
      { path: "/v1/agents%2Fencoded", authorization: `bearer ${TENANT_ERASURE_OPERATOR_TOKEN}` },
      { path: "/v1/agents%2Fspaces", authorization: `Bearer  ${TENANT_ERASURE_OPERATOR_TOKEN}` },
      { path: "/v1/agents%2Ftab", authorization: `Bearer\t${TENANT_ERASURE_OPERATOR_TOKEN}` },
      {
        path: "/v1/agents%2Fcombined-auth",
        authorization: `Bearer tenant-key, Bearer ${TENANT_ERASURE_OPERATOR_TOKEN}`,
      },
    ]) {
      const encoded = await missingAck.request(path, {
        headers: { authorization },
      });
      expect(encoded.status).toBe(404);
      expectPrivateLifecycleResponse(encoded);
    }
    // The replay-only and missing-ACK probes reached the upstream; every bypass stayed at the edge.
    expect(runner.requests).toHaveLength(2);
  });

  it("refreshes the current fleet before returning the private admission ACK", async () => {
    const refresh = vi.fn();
    const enabled = createRouterApp({
      registry: fakeRegistry(["http://runner.internal"], {
        tenantControl: true,
        tenantAdmission: true,
        refresh,
      }),
      internalRunnerToken: INTERNAL_TOKEN,
      tenantErasureOperatorToken: TENANT_ERASURE_OPERATOR_TOKEN,
      tenantErasureOperatorId: "platform-lifecycle-admin",
      tenantErasureRequestsEnabled: () => true,
      logger: silent,
    });
    const denied = await enabled.request(INTERNAL_TENANT_ERASURE_ADMISSION_READY_PATH, {
      headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: "wrong-internal-token-000000000001" },
    });
    expect(denied.status).toBe(404);
    expect(refresh).not.toHaveBeenCalled();

    const response = await enabled.request(INTERNAL_TENANT_ERASURE_ADMISSION_READY_PATH, {
      headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_TOKEN },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get(INTERNAL_TENANT_ERASURE_ADMISSION_ACK_HEADER)).toBe(
      INTERNAL_TENANT_ERASURE_ADMISSION_ACK_VALUE,
    );
    expectPrivateLifecycleResponse(response);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe("internal user-erasure routing", () => {
  it("keeps policy-evaluation claims behind their own private fleet barrier", async () => {
    const target = "http://runner.internal:8787";
    const enabled = createRouterApp({
      registry: fakeRegistry([target], { purgePolicyEvaluation: true }),
      internalRunnerToken: INTERNAL_TOKEN,
      purgePolicyEvaluatorEnabled: () => true,
      logger: silent,
    });

    for (const headers of [
      undefined,
      { [INTERNAL_ROUTER_TOKEN_HEADER]: "wrong-internal-token-000000000000" },
    ]) {
      const hidden = await enabled.request(INTERNAL_PURGE_POLICY_EVALUATION_READY_PATH, { headers });
      expect(hidden.status).toBe(404);
      expect(hidden.headers.get(INTERNAL_PURGE_POLICY_EVALUATION_ACK_HEADER)).toBeNull();
      expectPrivateLifecycleResponse(hidden);
    }

    const ready = await enabled.request(INTERNAL_PURGE_POLICY_EVALUATION_READY_PATH, {
      headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_TOKEN },
    });
    expect(ready.status).toBe(204);
    expect(ready.headers.get(INTERNAL_PURGE_POLICY_EVALUATION_ACK_HEADER)).toBe(
      INTERNAL_PURGE_POLICY_EVALUATION_ACK_VALUE,
    );
    expectPrivateLifecycleResponse(ready);

    for (const unavailable of [
      createRouterApp({
        registry: fakeRegistry([target], { purgePolicyEvaluation: true }),
        internalRunnerToken: INTERNAL_TOKEN,
        logger: silent,
      }),
      createRouterApp({
        registry: fakeRegistry([target], { purgePolicyEvaluation: false }),
        internalRunnerToken: INTERNAL_TOKEN,
        purgePolicyEvaluatorEnabled: () => true,
        logger: silent,
      }),
    ]) {
      const response = await unavailable.request(INTERNAL_PURGE_POLICY_EVALUATION_READY_PATH, {
        headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_TOKEN },
      });
      expect(response.status).toBe(503);
      expect(response.headers.get(INTERNAL_PURGE_POLICY_EVALUATION_ACK_HEADER)).toBeNull();
      expectPrivateLifecycleResponse(response);
    }
    expect((await enabled.request(`${INTERNAL_PURGE_POLICY_EVALUATION_READY_PATH}/extra`, {
      headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_TOKEN },
    })).status).toBe(404);
  });

  it("keeps the job-control readiness route private and ACKs only a homogeneous configured fleet", async () => {
    const target = await upstream(() => ({ body: "{}" }));
    const capable = createRouterApp({
      registry: fakeRegistry([target.url], { jobControl: true }),
      internalRunnerToken: INTERNAL_TOKEN,
      logger: silent,
    });

    for (const headers of [
      undefined,
      { [INTERNAL_ROUTER_TOKEN_HEADER]: "wrong-internal-token-000000000000" },
    ]) {
      const hidden = await capable.request(INTERNAL_ERASURE_JOB_CONTROL_READY_PATH, { headers });
      expect(hidden.status).toBe(404);
      expect(hidden.headers.get(INTERNAL_ERASURE_JOB_CONTROL_ACK_HEADER)).toBeNull();
      expectPrivateLifecycleResponse(hidden);
    }
    expect((await capable.request(`${INTERNAL_ERASURE_JOB_CONTROL_READY_PATH}/extra`, {
      headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_TOKEN },
    })).status).toBe(404);

    const legacyV1 = await capable.request(INTERNAL_ERASURE_JOB_CONTROL_V1_READY_PATH, {
      headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_TOKEN },
    });
    expect(legacyV1.status).toBe(404);
    expect(legacyV1.headers.get(INTERNAL_ERASURE_JOB_CONTROL_ACK_HEADER)).toBeNull();
    expectPrivateLifecycleResponse(legacyV1);

    const ready = await capable.request(INTERNAL_ERASURE_JOB_CONTROL_READY_PATH, {
      headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_TOKEN },
    });
    expect(ready.status).toBe(204);
    expect(ready.headers.get(INTERNAL_ERASURE_JOB_CONTROL_ACK_HEADER)).toBe(
      INTERNAL_ERASURE_JOB_CONTROL_ACK_VALUE,
    );
    expect(INTERNAL_ERASURE_JOB_CONTROL_READY_PATH).toBe("/_internal/user-erasure-job-control-v2/ready");
    expect(INTERNAL_ERASURE_JOB_CONTROL_ACK_VALUE).toBe("job-control-v2");
    expect(ready.headers.get(INTERNAL_ERASURE_JOB_CONTROL_ACK_HEADER)).not.toBe("quarantine-v1");
    expectPrivateLifecycleResponse(ready);

    const mixed = createRouterApp({
      registry: fakeRegistry([target.url], { jobControl: false }),
      internalRunnerToken: INTERNAL_TOKEN,
      logger: silent,
    });
    const unavailable = await mixed.request(INTERNAL_ERASURE_JOB_CONTROL_READY_PATH, {
      headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_TOKEN },
    });
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get(INTERNAL_ERASURE_JOB_CONTROL_ACK_HEADER)).toBeNull();
    expectPrivateLifecycleResponse(unavailable);
    expect(target.requests).toEqual([]);
  });

  it("authenticates before parsing identity or body and never forwards the runner-only path", async () => {
    const target = await upstream(() => ({ status: 204, body: "" }));
    const app = createRouterApp({
      registry: fakeRegistry([target.url], { worker: true }),
      internalRunnerToken: INTERNAL_TOKEN,
      logger: silent,
    });

    const hidden = await app.request(`${INTERNAL_ERASURE_DRAIN_ROUTER_PATH_PREFIX}/${SID}`, {
      method: "POST",
      headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: "wrong-internal-token-000000000000" },
      body: "{not-json",
    });
    expect(hidden.status).toBe(404);
    expectPrivateLifecycleResponse(hidden);
    expect(target.requests).toHaveLength(0);

    const oversized = await app.request(`${INTERNAL_ERASURE_DRAIN_ROUTER_PATH_PREFIX}/${SID}`, {
      method: "POST",
      headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_TOKEN },
      body: "x".repeat(4_097),
    });
    expect(oversized.status).toBe(400);
    expectPrivateLifecycleResponse(oversized);
    expect(target.requests).toHaveLength(0);

    const runnerOnly = await app.request(`${INTERNAL_ERASURE_DRAIN_RUNNER_PATH_PREFIX}/${SID}`, {
      method: "POST",
      headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_TOKEN },
      body: JSON.stringify(ERASURE_AUTHORITY),
    });
    expect(runnerOnly.status).toBe(404);
    expect(target.requests).toHaveLength(0);
  });

  it("forwards only the strict claim envelope to the configured owner and validates its ACK", async () => {
    const target = await upstream(() => ({
      status: 204,
      headers: { [INTERNAL_ERASURE_DRAIN_ACK_HEADER]: INTERNAL_ERASURE_DRAIN_ACK_VALUE },
      body: "",
    }));
    const app = createRouterApp({
      registry: fakeRegistry([target.url], { owner: target.url, worker: true }),
      internalRunnerToken: INTERNAL_TOKEN,
      logger: silent,
    });

    const extra = await app.request(`${INTERNAL_ERASURE_DRAIN_ROUTER_PATH_PREFIX}/${SID}`, {
      method: "POST",
      headers: {
        [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...ERASURE_AUTHORITY, phase: "tombstoning" }),
    });
    expect(extra.status).toBe(400);
    expectPrivateLifecycleResponse(extra);
    expect(target.requests).toHaveLength(0);

    const response = await app.request(`${INTERNAL_ERASURE_DRAIN_ROUTER_PATH_PREFIX}/${SID}`, {
      method: "POST",
      headers: {
        [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_TOKEN,
        "content-type": "application/json",
        "x-untrusted-forward-me": "no",
      },
      body: JSON.stringify(ERASURE_AUTHORITY),
    });
    expect(response.status).toBe(204);
    expect(response.headers.get(INTERNAL_ERASURE_DRAIN_ACK_HEADER)).toBe(INTERNAL_ERASURE_DRAIN_ACK_VALUE);
    expect(response.headers.get("x-owner")).toBeNull();
    expectPrivateLifecycleResponse(response);
    expect(target.requests).toHaveLength(1);
    expect(target.requests[0]).toMatchObject({
      method: "POST",
      path: `${INTERNAL_ERASURE_DRAIN_RUNNER_PATH_PREFIX}/${SID}`,
      headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_TOKEN },
      body: JSON.stringify(ERASURE_AUTHORITY),
    });
    expect(target.requests[0]!.headers["x-untrusted-forward-me"]).toBeUndefined();
  });

  it("reroutes one acknowledged lease conflict only to a configured capable owner", async () => {
    let ownerUrl = "";
    const wrong = await upstream(() => ({
      status: 409,
      headers: {
        [INTERNAL_ERASURE_DRAIN_ACK_HEADER]: INTERNAL_ERASURE_DRAIN_ACK_VALUE,
        "x-owner": ownerUrl.replace(/^http:\/\//, ""),
      },
      body: JSON.stringify({ error: { code: "session_lease_conflict", message: "conflict" } }),
    }));
    const owner = await upstream(() => ({
      status: 204,
      headers: { [INTERNAL_ERASURE_DRAIN_ACK_HEADER]: INTERNAL_ERASURE_DRAIN_ACK_VALUE },
      body: "",
    }));
    ownerUrl = owner.url;
    const app = createRouterApp({
      registry: fakeRegistry([wrong.url, owner.url], { owner: wrong.url, worker: true }),
      internalRunnerToken: INTERNAL_TOKEN,
      logger: silent,
    });

    const response = await app.request(`${INTERNAL_ERASURE_DRAIN_ROUTER_PATH_PREFIX}/${SID}`, {
      method: "POST",
      headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_TOKEN },
      body: JSON.stringify(ERASURE_AUTHORITY),
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("x-owner")).toBeNull();
    expect(wrong.requests).toHaveLength(1);
    expect(owner.requests).toHaveLength(1);
  });

  it("waits for a locally-fenced owner's lease to expire before bypassing its hash candidate", async () => {
    const old = await upstream(() => ({
      status: 409,
      headers: {
        [INTERNAL_ERASURE_DRAIN_ACK_HEADER]: INTERNAL_ERASURE_DRAIN_ACK_VALUE,
        [INTERNAL_ERASURE_DRAIN_LOCAL_FENCED_HEADER]: INTERNAL_ERASURE_DRAIN_LOCAL_FENCED_VALUE,
      },
      body: JSON.stringify({ error: { code: "session_busy", message: "still draining" } }),
    }));
    const takeover = await upstream(() => ({
      status: 204,
      headers: { [INTERNAL_ERASURE_DRAIN_ACK_HEADER]: INTERNAL_ERASURE_DRAIN_ACK_VALUE },
      body: "",
    }));
    let liveOwner: string | undefined = old.url;
    let leaseOwnerPresent: boolean | undefined = true;
    const app = createRouterApp({
      registry: fakeRegistry([old.url, takeover.url], {
        owner: () => liveOwner,
        leaseOwnerPresent: () => leaseOwnerPresent,
        worker: true,
      }),
      internalRunnerToken: INTERNAL_TOKEN,
      logger: silent,
    });

    const blocked = await app.request(`${INTERNAL_ERASURE_DRAIN_ROUTER_PATH_PREFIX}/${SID}`, {
      method: "POST",
      headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_TOKEN },
      body: JSON.stringify(ERASURE_AUTHORITY),
    });
    expect(blocked.status).toBe(409);
    expect(blocked.headers.get(INTERNAL_ERASURE_DRAIN_LOCAL_FENCED_HEADER)).toBeNull();
    expect(old.requests).toHaveLength(1);
    expect(takeover.requests).toHaveLength(0);

    liveOwner = undefined;
    leaseOwnerPresent = undefined;
    const indeterminate = await app.request(`${INTERNAL_ERASURE_DRAIN_ROUTER_PATH_PREFIX}/${SID}`, {
      method: "POST",
      headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_TOKEN },
      body: JSON.stringify(ERASURE_AUTHORITY),
    });
    expect(indeterminate.status).toBe(409);
    expect(old.requests).toHaveLength(2);
    expect(takeover.requests).toHaveLength(0);

    leaseOwnerPresent = false;
    const recovered = await app.request(`${INTERNAL_ERASURE_DRAIN_ROUTER_PATH_PREFIX}/${SID}`, {
      method: "POST",
      headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_TOKEN },
      body: JSON.stringify(ERASURE_AUTHORITY),
    });
    expect(recovered.status).toBe(204);
    expect(recovered.headers.get(INTERNAL_ERASURE_DRAIN_LOCAL_FENCED_HEADER)).toBeNull();
    expect(old.requests).toHaveLength(3);
    expect(takeover.requests).toHaveLength(1);
  });

  it("does not follow an unconfigured advertised owner or expose its topology", async () => {
    const target = await upstream(() => ({
      status: 409,
      headers: {
        [INTERNAL_ERASURE_DRAIN_ACK_HEADER]: INTERNAL_ERASURE_DRAIN_ACK_VALUE,
        "x-owner": "unconfigured.internal:9443",
      },
      body: JSON.stringify({ error: { code: "session_lease_conflict", message: "conflict" } }),
    }));
    const app = createRouterApp({
      registry: fakeRegistry([target.url], { owner: target.url, worker: true }),
      internalRunnerToken: INTERNAL_TOKEN,
      logger: silent,
    });
    const response = await app.request(`${INTERNAL_ERASURE_DRAIN_ROUTER_PATH_PREFIX}/${SID}`, {
      method: "POST",
      headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_TOKEN },
      body: JSON.stringify(ERASURE_AUTHORITY),
    });
    expect(response.status).toBe(409);
    expect(response.headers.get("x-owner")).toBeNull();
    expect(target.requests).toHaveLength(1);
  });

  it("uses at most one capable fallback after a transport failure", async () => {
    const dead = "http://127.0.0.1:1";
    const alive = await upstream(() => ({
      status: 204,
      headers: { [INTERNAL_ERASURE_DRAIN_ACK_HEADER]: INTERNAL_ERASURE_DRAIN_ACK_VALUE },
      body: "",
    }));
    const app = createRouterApp({
      registry: fakeRegistry([dead, alive.url], { owner: dead, worker: true }),
      internalRunnerToken: INTERNAL_TOKEN,
      logger: silent,
    });
    const response = await app.request(`${INTERNAL_ERASURE_DRAIN_ROUTER_PATH_PREFIX}/${SID}`, {
      method: "POST",
      headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_TOKEN },
      body: JSON.stringify(ERASURE_AUTHORITY),
    });
    expect(response.status).toBe(204);
    expect(alive.requests).toHaveLength(1);
  });

  it("fails closed for an incapable target or a missing drain-v1 acknowledgement", async () => {
    const legacy = await upstream(() => ({ status: 404, body: "{}" }));
    const incapable = createRouterApp({
      registry: fakeRegistry([legacy.url], { owner: legacy.url, worker: false }),
      internalRunnerToken: INTERNAL_TOKEN,
      logger: silent,
    });
    expect((await incapable.request(`${INTERNAL_ERASURE_DRAIN_ROUTER_PATH_PREFIX}/${SID}`, {
      method: "POST",
      headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_TOKEN },
      body: JSON.stringify(ERASURE_AUTHORITY),
    })).status).toBe(503);
    expect(legacy.requests).toHaveLength(0);

    const noAck = createRouterApp({
      registry: fakeRegistry([legacy.url], { owner: legacy.url, worker: true }),
      internalRunnerToken: INTERNAL_TOKEN,
      logger: silent,
    });
    expect((await noAck.request(`${INTERNAL_ERASURE_DRAIN_ROUTER_PATH_PREFIX}/${SID}`, {
      method: "POST",
      headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_TOKEN },
      body: JSON.stringify(ERASURE_AUTHORITY),
    })).status).toBe(503);
    expect(legacy.requests).toHaveLength(1);
  });
});

describe("session routing", () => {
  it("sends a session request to the runner the directory names as owner", async () => {
    const a = await upstream(() => ({ body: '{"who":"a"}' }));
    const b = await upstream(() => ({ body: '{"who":"b"}' }));
    const app = createRouterApp({ registry: fakeRegistry([a.url, b.url], { owner: b.url }), logger: silent });
    const res = await app.request(`/v1/sessions/${SID}/items`);
    expect(await res.json()).toEqual({ who: "b" });
    expect(a.requests).toHaveLength(0);
    expect(b.requests).toHaveLength(1);
  });

  it("re-routes exactly once on 409 + X-Owner and does not leak the header onward", async () => {
    const owner = await upstream(() => ({ body: '{"ok":true}' }));
    let wrongCalls = 0;
    const wrong = await upstream(() => {
      wrongCalls += 1;
      return { status: 409, headers: { "x-owner": owner.url.replace("http://", "") }, body: '{"error":{"code":"session_lease_conflict"}}' };
    });
    const app = createRouterApp({ registry: fakeRegistry([wrong.url, owner.url], { owner: wrong.url }), logger: silent });
    const res = await app.request(`/v1/sessions/${SID}/turns`, { method: "POST", body: JSON.stringify({ input: [{ type: "text", text: "hi" }] }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(wrongCalls).toBe(1);
    expect(owner.requests).toHaveLength(1);
    expect(owner.requests[0]!.body).toContain("hi"); // the body was replayed
    expect(res.headers.get("x-owner")).toBeNull();
  });

  it("gives up after one re-route instead of ping-ponging", async () => {
    // both runners insist the other one owns it
    const pair: Upstream[] = [];
    const a = await upstream(() => ({ status: 409, headers: { "x-owner": pair[1]!.url.replace("http://", "") }, body: "{}" }));
    const b = await upstream(() => ({ status: 409, headers: { "x-owner": pair[0]!.url.replace("http://", "") }, body: "{}" }));
    pair.push(a, b);
    const app = createRouterApp({ registry: fakeRegistry([a.url, b.url], { owner: a.url }), logger: silent });
    const res = await app.request(`/v1/sessions/${SID}/items`);
    expect(res.status).toBe(409);
    expect(a.requests.length + b.requests.length).toBe(2);
  });

  it("treats a non-canonical session id as unroutable and lets the runner reject it", async () => {
    // the same session id in a different case must not become "no session", which would scatter a
    // session's requests across runners while the runner still resolved them to one row
    const a = await upstream(() => ({ body: '{"who":"a"}' }));
    const b = await upstream(() => ({ body: '{"who":"b"}' }));
    const app = createRouterApp({ registry: fakeRegistry([a.url, b.url], { owner: b.url }), logger: silent });
    const res = await app.request(`/v1/sessions/${SID.toUpperCase()}/items`);
    expect(res.status).toBe(200);
    // routed as a non-session request (round-robin), NOT to the owner: the runner will 404 it
    expect(a.requests.length + b.requests.length).toBe(1);
  });
});

describe("request and response handling", () => {
  it("strips hop-by-hop request headers and forwards auth and idempotency", async () => {
    const a = await upstream(() => ({ body: "{}" }));
    const app = createRouterApp({ registry: fakeRegistry([a.url]), logger: silent });
    await app.request("/v1/agents", {
      method: "POST",
      body: "{}",
      headers: { authorization: "Bearer k", "x-user-id": "u1", "idempotency-key": "idem-1", connection: "keep-alive", te: "trailers" },
    });
    const got = a.requests[0]!.headers;
    expect(got.authorization).toBe("Bearer k");
    expect(got["x-user-id"]).toBe("u1");
    expect(got["idempotency-key"]).toBe("idem-1");
    expect(got.te).toBeUndefined();
  });

  it("preserves the query string and the method", async () => {
    const a = await upstream(() => ({ body: "{}" }));
    const app = createRouterApp({ registry: fakeRegistry([a.url]), logger: silent });
    await app.request(`/v1/sessions/${SID}/events?after=42&exclude=heartbeat`, { method: "GET" });
    expect(a.requests[0]!.path).toBe(`/v1/sessions/${SID}/events?after=42&exclude=heartbeat`);
    expect(a.requests[0]!.method).toBe("GET");
  });

  it("marks SSE responses unbuffered and streams them through", async () => {
    const a = await upstream(() => ({ headers: { "content-type": "text/event-stream" }, body: "event: turn/started\ndata: {}\n\n" }));
    const app = createRouterApp({ registry: fakeRegistry([a.url]), logger: silent });
    const res = await app.request(`/v1/sessions/${SID}/turns`, { method: "POST", body: "{}" });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(await res.text()).toContain("turn/started");
  });

  it("refuses a body larger than the limit before forwarding anything", async () => {
    const a = await upstream(() => ({ body: "{}" }));
    const app = createRouterApp({ registry: fakeRegistry([a.url]), maxBodyBytes: 1_000, logger: silent });
    const res = await app.request("/v1/agents", { method: "POST", body: "x".repeat(5_000) });
    // Match the runner's public error contract: invalid_request maps to HTTP 400.
    expect(res.status).toBe(400);
    expect(a.requests).toHaveLength(0);
  });

  it("gates blob writes on both deployment and fleet capability while keeping reads available", async () => {
    const a = await upstream(() => ({ body: '{"ok":true}' }));
    const disabled = createRouterApp({ registry: fakeRegistry([a.url]), logger: silent });
    expect((await disabled.request(`/v1/sessions/${SID}/blobs`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: "image",
    })).status).toBe(503);
    expect((await disabled.request(`/v1/sessions/${SID}/blobs/blob_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b`)).status).toBe(200);
    expect(a.requests).toHaveLength(1);

    const mixed = createRouterApp({
      registry: fakeRegistry([a.url], { blobs: false }),
      blobAttachmentsEnabled: () => true,
      logger: silent,
    });
    expect((await mixed.request(`/v1/sessions/${SID}/blobs`, { method: "POST", body: "image" })).status).toBe(503);

    const enabled = createRouterApp({
      registry: fakeRegistry([a.url], { blobs: true, targetBlobs: true }),
      blobAttachmentsEnabled: () => true,
      maxBodyBytes: 4,
      maxBlobBytes: 10,
      logger: silent,
    });
    expect((await enabled.request(`/v1/sessions/${SID}/blobs`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: "12345678",
    })).status).toBe(200);
    expect(a.requests.at(-1)?.body).toBe("12345678");
  });

  it("enforces the dedicated blob body ceiling before selecting an upstream", async () => {
    const a = await upstream(() => ({ body: "{}" }));
    const app = createRouterApp({
      registry: fakeRegistry([a.url], { blobs: true }),
      blobAttachmentsEnabled: () => true,
      maxBlobBytes: 5,
      logger: silent,
    });
    const response = await app.request(`/v1/sessions/${SID}/blobs`, { method: "POST", body: "123456" });
    expect(response.status).toBe(400);
    expect(a.requests).toHaveLength(0);
  });

  it("gates erasure requests on both deployment and every selected runner capability", async () => {
    const a = await upstream(() => ({
      status: 202,
      headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
      body: '{"status":"gated"}',
    }));
    const request = { method: "POST", headers: { "idempotency-key": "erase-1" } } as const;

    const disabled = createRouterApp({
      registry: fakeRegistry([a.url], { erasure: true }),
      internalRunnerToken: INTERNAL_TOKEN,
      logger: silent,
    });
    const disabledResponse = await disabled.request("/v1/data-erasure-requests", request);
    expect(disabledResponse.status).toBe(503);
    expectPrivateLifecycleResponse(disabledResponse);
    const mixed = createRouterApp({
      registry: fakeRegistry([a.url], { erasure: false }),
      erasureRequestsEnabled: () => true,
      internalRunnerToken: INTERNAL_TOKEN,
      logger: silent,
    });
    const mixedResponse = await mixed.request("/v1/data-erasure-requests", request);
    expect(mixedResponse.status).toBe(503);
    expectPrivateLifecycleResponse(mixedResponse);
    const unavailableConfiguredTarget = createRouterApp({
      registry: fakeRegistry([a.url], { erasure: true, configuredErasure: false }),
      erasureRequestsEnabled: () => true,
      internalRunnerToken: INTERNAL_TOKEN,
      logger: silent,
    });
    const unavailableResponse = await unavailableConfiguredTarget.request("/v1/data-erasure-requests", request);
    expect(unavailableResponse.status).toBe(503);
    expectPrivateLifecycleResponse(unavailableResponse);
    const staleTarget = createRouterApp({
      registry: fakeRegistry([a.url], { erasure: true, targetErasure: false }),
      erasureRequestsEnabled: () => true,
      internalRunnerToken: INTERNAL_TOKEN,
      logger: silent,
    });
    const staleTargetResponse = await staleTarget.request("/v1/data-erasure-requests", request);
    expect(staleTargetResponse.status).toBe(503);
    expectPrivateLifecycleResponse(staleTargetResponse);
    // A pre-policy runner may still advertise the older erasure boolean. It must not admit a new
    // request because it would omit an already-active canonical policy binding.
    const legacyGovernanceWriter = createRouterApp({
      registry: fakeRegistry([a.url], { erasure: true, governance: false }),
      erasureRequestsEnabled: () => true,
      internalRunnerToken: INTERNAL_TOKEN,
      logger: silent,
    });
    expect((await legacyGovernanceWriter.request("/v1/data-erasure-requests", request)).status).toBe(503);
    const staleGovernanceTarget = createRouterApp({
      registry: fakeRegistry([a.url], {
        erasure: true,
        governance: true,
        targetGovernance: false,
      }),
      erasureRequestsEnabled: () => true,
      internalRunnerToken: INTERNAL_TOKEN,
      logger: silent,
    });
    expect((await staleGovernanceTarget.request("/v1/data-erasure-requests", request)).status).toBe(503);

    const enabled = createRouterApp({
      registry: fakeRegistry([a.url], { erasure: true }),
      erasureRequestsEnabled: () => true,
      internalRunnerToken: INTERNAL_TOKEN,
      logger: silent,
    });
    const enabledResponse = await enabled.request("/v1/data-erasure-requests", request);
    expect(enabledResponse.status).toBe(202);
    expectPrivateLifecycleResponse(enabledResponse);
    // Status remains readable after the write gate is turned off, but only when every healthy
    // runner and the selected target still implement the additive contract.
    const readableStatus = await disabled.request(
      "/v1/data-erasure-requests/erase_019a2b3c-4d5e-4f00-8a9b-0c1d2e3f4a5b",
    );
    expect(readableStatus.status).toBe(202);
    expectPrivateLifecycleResponse(readableStatus);
    const mixedStatus = await mixed.request(
      "/v1/data-erasure-requests/erase_019a2b3c-4d5e-4f00-8a9b-0c1d2e3f4a5b",
    );
    expect(mixedStatus.status).toBe(503);
    expectPrivateLifecycleResponse(mixedStatus);
    const mixedControl = createRouterApp({
      registry: fakeRegistry([a.url], { erasure: true, jobControl: false }),
      erasureRequestsEnabled: () => true,
      internalRunnerToken: INTERNAL_TOKEN,
      logger: silent,
    });
    const mixedControlPost = await mixedControl.request("/v1/data-erasure-requests", request);
    expect(mixedControlPost.status).toBe(503);
    expectPrivateLifecycleResponse(mixedControlPost);
    const mixedControlStatus = await mixedControl.request(
      "/v1/data-erasure-requests/erase_019a2b3c-4d5e-4f00-8a9b-0c1d2e3f4a5b",
    );
    expect(mixedControlStatus.status).toBe(503);
    expectPrivateLifecycleResponse(mixedControlStatus);
    const staleStatus = await staleTarget.request(
      "/v1/data-erasure-requests/erase_019a2b3c-4d5e-4f00-8a9b-0c1d2e3f4a5b",
    );
    expect(staleStatus.status).toBe(503);
    expectPrivateLifecycleResponse(staleStatus);
    expect(a.requests).toHaveLength(2);
  });

  it("keeps an owner-hiding erasure status 404 private while proxying it", async () => {
    const a = await upstream(() => ({
      status: 404,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-test-upstream": "preserved",
      },
      body: '{"error":{"code":"not_found","message":"erasure request not found"}}',
    }));
    const app = createRouterApp({
      registry: fakeRegistry([a.url], { erasure: true }),
      internalRunnerToken: INTERNAL_TOKEN,
      logger: silent,
    });

    const response = await app.request(
      "/v1/data-erasure-requests/erase_019a2b3c-4d5e-4f00-8a9b-0c1d2e3f4a5b",
    );

    expect(response.status).toBe(404);
    expectPrivateLifecycleResponse(response);
    expect(response.headers.get("x-test-upstream")).toBe("preserved");
  });

  it("stops user-scoped runtime from reaching a target whose erasure capability regressed", async () => {
    let targetCapable = true;
    const a = await upstream(() => ({ body: '{"ok":true}' }));
    const app = createRouterApp({
      registry: fakeRegistry([a.url], {
        erasure: true,
        configuredErasure: true,
        targetErasure: () => targetCapable,
      }),
      erasureRequestsEnabled: () => true,
      internalRunnerToken: INTERNAL_TOKEN,
      logger: silent,
    });

    expect((await app.request("/v1/sessions")).status).toBe(200);
    targetCapable = false;
    for (const path of [
      "/v1/sessions",
      `/v1/sessions/${SID}`,
      "/v1/usage",
      "/v1/data-erasure-requests/erase_019a2b3c-4d5e-4f00-8a9b-0c1d2e3f4a5b",
    ]) {
      const response = await app.request(path);
      expect(response.status).toBe(503);
      expect((await response.json()) as object).toMatchObject({
        error: { code: "draining", retryable: true },
      });
    }
    expect(a.requests).toHaveLength(1);

    // Tenant-scoped administration is outside the user erasure gate and remains routable.
    expect((await app.request("/v1/agents")).status).toBe(200);
    expect(a.requests).toHaveLength(2);
  });

  it("keeps the mixed-fleet expand window open while the erasure writer gate is off", async () => {
    const a = await upstream(() => ({ body: '{"ok":true}' }));
    const app = createRouterApp({
      registry: fakeRegistry([a.url], { erasure: false, targetErasure: false }),
      erasureRequestsEnabled: () => false,
      logger: silent,
    });

    expect((await app.request("/v1/sessions")).status).toBe(200);
    expect((await app.request(`/v1/sessions/${SID}`)).status).toBe(200);
    expect((await app.request("/v1/usage")).status).toBe(200);
    expect(a.requests).toHaveLength(3);
  });

  it("gates canonical policy and legal-hold management on the whole configured fleet", async () => {
    const target = await upstream(() => ({ body: '{"ok":true}' }));
    const request = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        holdId: "hold_router-gate",
        subjectKind: "user",
        subjectId: "u_1",
        reasonCode: "litigation",
        expectedControlGeneration: 0,
      }),
    };

    const gateOff = createRouterApp({
      registry: fakeRegistry([target.url], { governance: true }),
      logger: silent,
    });
    const closed = await gateOff.request("/v1/legal-holds", request);
    expect(closed.status).toBe(503);
    expectPrivateLifecycleResponse(closed);

    const mixed = createRouterApp({
      registry: fakeRegistry([target.url], { governance: false }),
      dataGovernanceManagementEnabled: () => true,
      logger: silent,
    });
    expect((await mixed.request("/v1/legal-holds", request)).status).toBe(503);

    const managementOff = createRouterApp({
      registry: fakeRegistry([target.url], {
        governance: true,
        governanceManagement: false,
      }),
      dataGovernanceManagementEnabled: () => true,
      logger: silent,
    });
    expect((await managementOff.request("/v1/legal-holds", request)).status).toBe(503);

    const staleTarget = createRouterApp({
      registry: fakeRegistry([target.url], { governance: true, targetGovernance: false }),
      dataGovernanceManagementEnabled: () => true,
      logger: silent,
    });
    expect((await staleTarget.request("/v1/legal-holds", request)).status).toBe(503);

    const enabled = createRouterApp({
      registry: fakeRegistry([target.url], { governance: true }),
      dataGovernanceManagementEnabled: () => true,
      logger: silent,
    });
    const forwarded = await enabled.request("/v1/legal-holds", request);
    expect(forwarded.status).toBe(200);
    expectPrivateLifecycleResponse(forwarded);
    expect(target.requests).toHaveLength(1);
    expect(target.requests[0]).toMatchObject({ method: "POST", path: "/v1/legal-holds" });
  });
});

describe("failure handling", () => {
  it("retries generation-CAS governance writes after a transport failure", async () => {
    const dead = "http://127.0.0.1:1";
    const alive = await upstream(() => ({ body: '{"holdId":"hold_retry"}' }));
    const app = createRouterApp({
      registry: fakeRegistry([dead, alive.url], { governance: true }),
      dataGovernanceManagementEnabled: () => true,
      maxAttempts: 2,
      logger: silent,
    });
    const response = await app.request("/v1/legal-holds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        holdId: "hold_retry",
        subjectKind: "user",
        subjectId: "u_1",
        reasonCode: "litigation",
        expectedControlGeneration: 0,
      }),
    });
    expect(response.status).toBe(200);
    expect(alive.requests).toHaveLength(1);
  });

  it("retries only an idempotency-keyed erasure request after a transport failure", async () => {
    const dead = "http://127.0.0.1:1";
    const alive = await upstream(() => ({ status: 202, body: '{"status":"gated"}' }));
    const noRetry = createRouterApp({
      registry: fakeRegistry([dead, alive.url], { erasure: true }),
      erasureRequestsEnabled: () => true,
      internalRunnerToken: INTERNAL_TOKEN,
      maxAttempts: 2,
      logger: silent,
    });
    expect((await noRetry.request("/v1/data-erasure-requests", { method: "POST" })).status).toBe(502);
    expect(alive.requests).toHaveLength(0);

    const retrying = createRouterApp({
      registry: fakeRegistry([dead, alive.url], { erasure: true }),
      erasureRequestsEnabled: () => true,
      internalRunnerToken: INTERNAL_TOKEN,
      maxAttempts: 2,
      logger: silent,
    });
    expect((await retrying.request("/v1/data-erasure-requests", {
      method: "POST",
      headers: { "idempotency-key": "erase-transport-1" },
    })).status).toBe(202);
    expect(alive.requests).toHaveLength(1);
  });

  it("only retries the idempotent turn POST after a transport failure", async () => {
    const dead = "http://127.0.0.1:1";
    const alive = await upstream(() => ({ body: '{"ok":true}' }));
    const app = createRouterApp({ registry: fakeRegistry([dead, alive.url], { owner: dead }), logger: silent });

    const noKey = await app.request(`/v1/sessions/${SID}/turns`, { method: "POST", body: "{}" });
    expect(noKey.status).toBe(502);
    expect(alive.requests).toHaveLength(0); // a second turn must not be started

    const withKey = await app.request(`/v1/sessions/${SID}/turns`, { method: "POST", body: "{}", headers: { "idempotency-key": "k1" } });
    expect(withKey.status).toBe(200);
    expect(alive.requests).toHaveLength(1);

    // Arbitrary POST endpoints do not implement idempotency. A caller adding the same header must
    // not make agent/API-key/session creation replayable.
    const otherAlive = await upstream(() => ({ body: '{"ok":true}' }));
    const other = createRouterApp({ registry: fakeRegistry([dead, otherAlive.url]), logger: silent });
    const agentPost = await other.request("/v1/agents", { method: "POST", body: "{}", headers: { "idempotency-key": "k1" } });
    expect(agentPost.status).toBe(502);
    expect(otherAlive.requests).toHaveLength(0);
  });

  it("retries only the exact idempotent session DELETE after a transport failure", async () => {
    const dead = "http://127.0.0.1:1";
    const alive = await upstream(() => ({
      status: 204,
      headers: { [INTERNAL_TOMBSTONE_ACK_HEADER]: INTERNAL_TOMBSTONE_ACK_VALUE },
      body: "",
    }));
    const app = createRouterApp({
      registry: fakeRegistry([dead, alive.url], { owner: dead }),
      tombstoneEnabled: () => true,
      internalRunnerToken: INTERNAL_TOKEN,
      logger: silent,
    });

    const deleted = await app.request(`/v1/sessions/${SID}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    expect(deleted.headers.get(INTERNAL_TOMBSTONE_ACK_HEADER)).toBeNull();
    expect(alive.requests).toHaveLength(1);
    expect(alive.requests[0]).toMatchObject({
      method: "POST",
      path: `${INTERNAL_TOMBSTONE_PATH_PREFIX}/${SID}`,
      headers: { "x-agent-service-internal-token": INTERNAL_TOKEN },
    });

    // A DELETE on a child resource has no tombstone idempotency contract and must not be replayed.
    const nestedAlive = await upstream(() => ({ status: 204, body: "" }));
    const nested = createRouterApp({ registry: fakeRegistry([dead, nestedAlive.url], { owner: dead }), logger: silent });
    expect((await nested.request(`/v1/sessions/${SID}/items`, { method: "DELETE" })).status).toBe(502);
    expect(nestedAlive.requests).toHaveLength(0);

    // Nor does this rule make unrelated resource deletion replayable.
    const providerAlive = await upstream(() => ({ status: 204, body: "" }));
    const provider = createRouterApp({ registry: fakeRegistry([dead, providerAlive.url]), logger: silent });
    expect((await provider.request("/v1/providers/mine", { method: "DELETE" })).status).toBe(502);
    expect(providerAlive.requests).toHaveLength(0);
  });

  it("rechecks the tombstone fleet gate after the asynchronous owner lookup", async () => {
    const target = await upstream(() => ({ status: 204, body: "" }));
    let fleetSupportsTombstone = true;
    const registry = fakeRegistry([target.url]);
    registry.owner = async () => {
      fleetSupportsTombstone = false;
      return target.url;
    };
    registry.allHealthySupportLifecycle = () => fleetSupportsTombstone;

    const app = createRouterApp({ registry, tombstoneEnabled: () => true, internalRunnerToken: INTERNAL_TOKEN, logger: silent });
    const response = await app.request(`/v1/sessions/${SID}`, { method: "DELETE" });

    expect(response.status).toBe(503);
    expect(target.requests).toHaveLength(0);
  });

  it("fails closed when the selected destination no longer has the tombstone capability", async () => {
    const target = await upstream(() => ({
      status: 204,
      headers: { [INTERNAL_TOMBSTONE_ACK_HEADER]: INTERNAL_TOMBSTONE_ACK_VALUE },
      body: "",
    }));
    const app = createRouterApp({
      registry: fakeRegistry([target.url], { tombstone: true, targetTombstone: false }),
      tombstoneEnabled: () => true,
      internalRunnerToken: INTERNAL_TOKEN,
      logger: silent,
    });

    expect((await app.request(`/v1/sessions/${SID}`, { method: "DELETE" })).status).toBe(503);
    expect(target.requests).toHaveLength(0);
  });

  it("fails closed when a target does not acknowledge the versioned internal tombstone contract", async () => {
    const legacyBehindBalancer = await upstream(() => ({ status: 404, body: "{}" }));
    const app = createRouterApp({
      registry: fakeRegistry([legacyBehindBalancer.url]),
      tombstoneEnabled: () => true,
      internalRunnerToken: INTERNAL_TOKEN,
      logger: silent,
    });

    const response = await app.request(`/v1/sessions/${SID}`, { method: "DELETE" });
    expect(response.status).toBe(503);
    expect(legacyBehindBalancer.requests[0]).toMatchObject({
      method: "POST",
      path: `${INTERNAL_TOMBSTONE_PATH_PREFIX}/${SID}`,
    });
  });

  it("never forwards a client request to the runner-internal tombstone path", async () => {
    const target = await upstream(() => ({ status: 204, body: "" }));
    const app = createRouterApp({
      registry: fakeRegistry([target.url]),
      tombstoneEnabled: () => true,
      internalRunnerToken: INTERNAL_TOKEN,
      logger: silent,
    });

    const response = await app.request(`${INTERNAL_TOMBSTONE_PATH_PREFIX}/${SID}`, {
      method: "POST",
      headers: { "x-agent-service-internal-token": INTERNAL_TOKEN },
    });
    expect(response.status).toBe(404);
    expect(target.requests).toHaveLength(0);
  });

  it("treats maxAttempts as the total number of upstream sends", async () => {
    const a = await upstream(() => "drop");
    const b = await upstream(() => "drop");
    const c = await upstream(() => ({ body: '{"shouldNot":"be reached"}' }));
    const app = createRouterApp({ registry: fakeRegistry([a.url, b.url, c.url], { owner: a.url }), maxAttempts: 2, logger: silent });
    const res = await app.request(`/v1/sessions/${SID}/items`);
    expect(res.status).toBe(502);
    expect(a.requests).toHaveLength(1);
    expect(b.requests).toHaveLength(1);
    expect(c.requests).toHaveLength(0);
  });

  it("retries a GET on another runner after a transport failure", async () => {
    const dead = "http://127.0.0.1:1";
    const alive = await upstream(() => ({ body: '{"ok":true}' }));
    const app = createRouterApp({ registry: fakeRegistry([dead, alive.url], { owner: dead }), logger: silent });
    const res = await app.request(`/v1/sessions/${SID}/items`);
    expect(res.status).toBe(200);
    expect(alive.requests).toHaveLength(1);
  });

  it("503s when no runner is healthy", async () => {
    const app = createRouterApp({ registry: fakeRegistry(["http://127.0.0.1:1"], { healthy: () => false }), logger: silent });
    const res = await app.request("/v1/agents");
    expect(res.status).toBe(503);
  });

  it("times out waiting for upstream headers without cutting a streaming body", async () => {
    const hang = await upstream(() => "hang");
    const alive = await upstream(() => ({ body: '{"ok":true}' }));
    const app = createRouterApp({ registry: fakeRegistry([hang.url, alive.url], { owner: hang.url }), upstreamHeaderTimeoutMs: 200, logger: silent });
    const res = await app.request(`/v1/sessions/${SID}/items`);
    // a GET may be retried, so it lands on the healthy one
    expect([200, 502]).toContain(res.status);
  });

  it("aborts a timed-out upstream request and does not replay an unsafe POST", async () => {
    const hang = await upstream(() => "hang");
    const alive = await upstream(() => ({ body: '{"ok":true}' }));
    const app = createRouterApp({ registry: fakeRegistry([hang.url, alive.url]), upstreamHeaderTimeoutMs: 50, logger: silent });
    const res = await app.request("/v1/agents", { method: "POST", body: "{}", headers: { "idempotency-key": "not-supported-here" } });
    expect(res.status).toBe(502);
    expect(alive.requests).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(hang.state.abortedResponses).toBe(1);
  });
});

describe("user data export routing", () => {
  const capabilities = (admission = true) => ({
    protocolVersion: PROTOCOL_VERSION,
    service: "agent-runner",
    features: {
      streaming: true,
      replay: { persistedEvents: true, hotWindowMs: 1 },
      approvals: true,
      sessionLifecycle: ["archive", "unarchive", "tombstone"],
      blobAttachments: false,
      dataErasureRequests: false,
      userErasureWorker: [],
      erasureJobControl: [],
      dataGovernance: [],
      dataGovernanceManagement: false,
      purgePolicyEvaluation: [],
      dataPurgeExecution: false,
      userDataExport: [USER_DATA_EXPORT_ARTIFACT_NDJSON_V1],
      dataExportRequests: admission,
      dynamicTools: true,
      mcp: [],
      skills: false,
      sandbox: ["none"],
      byok: true,
    },
  });

  it("aggregates code awareness separately from fleet-wide admission", async () => {
    const runner = await upstream(() => ({ body: JSON.stringify(capabilities()) }));
    const enabled = createRouterApp({
      registry: fakeRegistry([runner.url], {
        exportReadable: true,
        exportAdmission: true,
        targetExport: true,
      }),
      dataExportArtifactsEnabled: () => true,
      dataExportRequestsEnabled: () => true,
      logger: silent,
    });
    expect(await (await enabled.request("/v1/capabilities")).json()).toMatchObject({
      service: "agent-router",
      features: {
        userDataExport: [USER_DATA_EXPORT_ARTIFACT_NDJSON_V1],
        dataExportRequests: true,
      },
    });

    const gated = createRouterApp({
      registry: fakeRegistry([runner.url], {
        exportReadable: true,
        exportAdmission: true,
        targetExport: true,
      }),
      dataExportArtifactsEnabled: () => true,
      dataExportRequestsEnabled: () => false,
      logger: silent,
    });
    expect(await (await gated.request("/v1/capabilities")).json()).toMatchObject({
      features: {
        userDataExport: [USER_DATA_EXPORT_ARTIFACT_NDJSON_V1],
        dataExportRequests: false,
      },
    });

    const mixed = createRouterApp({
      registry: fakeRegistry([runner.url], {
        exportReadable: false,
        exportAdmission: false,
        targetExport: false,
      }),
      dataExportArtifactsEnabled: () => true,
      dataExportRequestsEnabled: () => true,
      logger: silent,
    });
    expect(await (await mixed.request("/v1/capabilities")).json()).toMatchObject({
      features: { userDataExport: [], dataExportRequests: false },
    });

    const filesystemDisabled = createRouterApp({
      registry: fakeRegistry([runner.url], {
        exportReadable: true,
        exportAdmission: true,
        targetExport: true,
      }),
      dataExportArtifactsEnabled: () => false,
      dataExportRequestsEnabled: () => true,
      logger: silent,
    });
    expect(await (await filesystemDisabled.request("/v1/capabilities")).json()).toMatchObject({
      features: { userDataExport: [], dataExportRequests: false },
    });
    const forwardedBefore = runner.requests.length;
    for (const [path, method] of [
      ["/v1/data-export-requests/export_request", "GET"],
      ["/v1/data-export-requests/export_request/download", "GET"],
      ["/v1/data-export-requests", "POST"],
    ] as const) {
      const response = await filesystemDisabled.request(path, { method });
      expect(response.status).toBe(503);
      expectPrivateLifecycleResponse(response);
    }
    expect(runner.requests).toHaveLength(forwardedBefore);
  });

  it("keeps status and download independent of admission while requiring a healthy code-aware fleet", async () => {
    const runner = await upstream(({ path }) => ({
      status: 200,
      body: path.endsWith("/download") ? "export-bytes" : JSON.stringify({ status: "queued" }),
    }));
    const readable = createRouterApp({
      registry: fakeRegistry([runner.url], {
        exportReadable: true,
        exportAdmission: true,
        targetExport: true,
      }),
      dataExportArtifactsEnabled: () => true,
      dataExportRequestsEnabled: () => false,
      logger: silent,
    });
    const status = await readable.request(`/v1/data-export-requests/export_request`);
    const download = await readable.request(`/v1/data-export-requests/export_request/download`);
    expect(status.status).toBe(200);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("export-bytes");
    expectPrivateLifecycleResponse(status);
    expectPrivateLifecycleResponse(download);

    const post = await readable.request("/v1/data-export-requests", {
      method: "POST",
      headers: { "idempotency-key": "once" },
    });
    expect(post.status).toBe(503);
    expectPrivateLifecycleResponse(post);

    for (const app of [
      createRouterApp({
        registry: fakeRegistry([runner.url], {
          exportReadable: false,
          exportAdmission: false,
          targetExport: false,
        }),
        dataExportArtifactsEnabled: () => true,
        dataExportRequestsEnabled: () => true,
        logger: silent,
      }),
      createRouterApp({
        registry: fakeRegistry([runner.url], {
          exportReadable: true,
          exportAdmission: true,
          targetExport: false,
        }),
        dataExportArtifactsEnabled: () => true,
        dataExportRequestsEnabled: () => true,
        logger: silent,
      }),
    ]) {
      const response = await app.request(`/v1/data-export-requests/export_request`);
      expect(response.status).toBe(503);
      expectPrivateLifecycleResponse(response);
    }
  });

  it("opens POST only after every configured target advertises admission", async () => {
    const runner = await upstream(() => ({ status: 202, body: "{}" }));
    for (const registry of [
      fakeRegistry([runner.url, "http://configured-but-unavailable"], {
        exportReadable: true,
        exportAdmission: false,
        targetExport: true,
      }),
      fakeRegistry([runner.url, "http://configured-legacy"], {
        exportReadable: false,
        exportAdmission: false,
        targetExport: (url) => url === runner.url,
      }),
    ]) {
      const app = createRouterApp({
        registry,
        dataExportArtifactsEnabled: () => true,
        dataExportRequestsEnabled: () => true,
        logger: silent,
      });
      const response = await app.request("/v1/data-export-requests", {
        method: "POST",
        headers: { "idempotency-key": "once" },
      });
      expect(response.status).toBe(503);
      expectPrivateLifecycleResponse(response);
    }
    expect(runner.requests).toHaveLength(0);
  });

  it("retries export POST after transport failure only when Idempotency-Key is present", async () => {
    const first = await upstream(() => "drop");
    const second = await upstream(() => ({ status: 202, body: JSON.stringify({ status: "queued" }) }));
    const opts = {
      exportReadable: true,
      exportAdmission: true,
      targetExport: true,
    } as const;
    const retrying = createRouterApp({
      registry: fakeRegistry([first.url, second.url], opts),
      dataExportArtifactsEnabled: () => true,
      dataExportRequestsEnabled: () => true,
      maxAttempts: 2,
      logger: silent,
    });
    const retried = await retrying.request("/v1/data-export-requests", {
      method: "POST",
      headers: {
        authorization: "Bearer admin",
        "x-user-id": "user-a",
        "idempotency-key": "export-once",
        [INTERNAL_ROUTER_TOKEN_HEADER]: "must-not-be-forwarded",
      },
    });
    expect(retried.status).toBe(202);
    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(1);
    expect(second.requests[0]!.headers["idempotency-key"]).toBe("export-once");
    expect(second.requests[0]!.headers[INTERNAL_ROUTER_TOKEN_HEADER]).toBeUndefined();

    const secondCount = second.requests.length;
    const nonRetrying = createRouterApp({
      registry: fakeRegistry([first.url, second.url], opts),
      dataExportArtifactsEnabled: () => true,
      dataExportRequestsEnabled: () => true,
      maxAttempts: 2,
      logger: silent,
    });
    const notRetried = await nonRetrying.request("/v1/data-export-requests", {
      method: "POST",
      headers: { authorization: "Bearer admin", "x-user-id": "user-a" },
    });
    expect(notRetried.status).toBe(502);
    expect(await notRetried.json()).toMatchObject({
      error: { code: "provider_error", retryable: false },
    });
    expect(second.requests).toHaveLength(secondCount);
  });

  it("preserves export integrity metadata while stripping private topology and framing headers", async () => {
    const runner = await upstream(() => ({
      status: 200,
      headers: {
        "content-type": "application/vnd.agent-service.user-export+ndjson",
        "content-length": "12",
        "content-digest": "sha-256=:YWJjZA==:",
        "x-artifact-size": "12",
        "x-owner": "runner.internal:8787",
        [INTERNAL_TOMBSTONE_ACK_HEADER]: INTERNAL_TOMBSTONE_ACK_VALUE,
      },
      body: "export-bytes",
    }));
    const app = createRouterApp({
      registry: fakeRegistry([runner.url], {
        exportReadable: true,
        targetExport: true,
      }),
      dataExportArtifactsEnabled: () => true,
      dataExportRequestsEnabled: () => false,
      logger: silent,
    });
    const response = await app.request("/v1/data-export-requests/export_request/download", {
      headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: "external-probe-must-be-stripped" },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("export-bytes");
    expect(response.headers.get("content-digest")).toBe("sha-256=:YWJjZA==:");
    expect(response.headers.get("x-artifact-size")).toBe("12");
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("x-owner")).toBeNull();
    expect(response.headers.get(INTERNAL_TOMBSTONE_ACK_HEADER)).toBeNull();
    expectPrivateLifecycleResponse(response);
    expect(runner.requests[0]!.headers[INTERNAL_ROUTER_TOKEN_HEADER]).toBeUndefined();
  });
});

describe("operational endpoints", () => {
  it("hides /_router/targets unless an admin token is configured, then requires it", async () => {
    const a = await upstream(() => ({ body: "{}" }));
    const off = createRouterApp({ registry: fakeRegistry([a.url]), logger: silent });
    expect((await off.request("/_router/targets")).status).toBe(404);

    const on = createRouterApp({ registry: fakeRegistry([a.url]), adminToken: "sekret", logger: silent });
    expect((await on.request("/_router/targets")).status).toBe(401);
    const ok = await on.request("/_router/targets", { headers: { authorization: "Bearer sekret" } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { runners: unknown[] }).runners).toHaveLength(1);
  });

  it("reports not-ready while draining", async () => {
    const a = await upstream(() => ({ body: "{}" }));
    let ready = true;
    const app = createRouterApp({ registry: fakeRegistry([a.url]), ready: () => ready, logger: silent });
    expect((await app.request("/readyz")).status).toBe(200);
    ready = false;
    expect((await app.request("/readyz")).status).toBe(503);
    expect((await app.request("/healthz")).status).toBe(200); // liveness stays up while draining
  });

  it("answers capabilities from a runner rather than inventing them", async () => {
    const a = await upstream(() => ({ body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, service: "agent-runner", features: { streaming: true, replay: { persistedEvents: true, hotWindowMs: 1 }, approvals: true, sessionLifecycle: ["archive", "unarchive", "tombstone", "purge"], blobAttachments: true, dataErasureRequests: true, userErasureWorker: ["drain-v1"], erasureJobControl: ["quarantine-v1", "legacy-tombstone-compensation-v1"], dataGovernance: ["canonical-retention-v1", "multi-legal-hold-v1"], dataGovernanceManagement: true, purgePolicyEvaluation: ["policy-evaluator-v1"], dataPurgeExecution: false, dynamicTools: true, mcp: ["streamable-http"], skills: true, sandbox: ["none"], byok: true } }) }));
    const app = createRouterApp({
      registry: fakeRegistry([a.url], {
        blobs: true,
        worker: true,
        purgePolicyEvaluation: true,
      }),
      tombstoneEnabled: () => true,
      blobAttachmentsEnabled: () => true,
      erasureRequestsEnabled: () => true,
      dataGovernanceManagementEnabled: () => true,
      internalRunnerToken: INTERNAL_TOKEN,
      logger: silent,
    });
    const caps = (await (await app.request("/v1/capabilities")).json()) as { service: string; features: { skills: boolean; mcp: string[]; sessionLifecycle: string[]; blobAttachments: boolean; dataErasureRequests: boolean; userErasureWorker: string[]; erasureJobControl: string[]; dataGovernance: string[]; dataGovernanceManagement: boolean; purgePolicyEvaluation: string[]; dataPurgeExecution: boolean } };
    expect(caps.service).toBe("agent-router");
    expect(caps.features.skills).toBe(true);
    expect(caps.features.mcp).toEqual(["streamable-http"]);
    expect(caps.features.sessionLifecycle).toEqual(["archive", "unarchive", "tombstone"]);
    expect(caps.features.blobAttachments).toBe(true);
    expect(caps.features.dataErasureRequests).toBe(true);
    expect(caps.features.userErasureWorker).toEqual(["drain-v1"]);
    expect(caps.features.erasureJobControl).toEqual([]);
    expect(caps.features.dataGovernance).toEqual(["canonical-retention-v1", "multi-legal-hold-v1"]);
    expect(caps.features.dataGovernanceManagement).toBe(true);
    expect(caps.features.purgePolicyEvaluation).toEqual(["policy-evaluator-v1"]);
    expect(caps.features.dataPurgeExecution).toBe(false);

    const noToken = createRouterApp({
      registry: fakeRegistry([a.url], { worker: true }),
      logger: silent,
    });
    expect(await (await noToken.request("/v1/capabilities")).json()).toMatchObject({
      features: {
        userErasureWorker: [],
        erasureJobControl: [],
        dataGovernance: ["canonical-retention-v1", "multi-legal-hold-v1"],
        dataGovernanceManagement: false,
      },
    });
  });

  it("withholds the erasure capability until the deployment gate and whole healthy fleet agree", async () => {
    const runnerCapabilities = JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      service: "agent-runner",
      features: {
        streaming: true,
        replay: { persistedEvents: true, hotWindowMs: 1 },
        approvals: true,
        sessionLifecycle: ["archive", "unarchive"],
        blobAttachments: false,
        dataErasureRequests: true,
        erasureJobControl: ["quarantine-v1", "legacy-tombstone-compensation-v1"],
        dynamicTools: true,
        mcp: [],
        skills: false,
        sandbox: ["none"],
        byok: true,
      },
    });
    const a = await upstream(() => ({ body: runnerCapabilities }));
    const gateOff = createRouterApp({
      registry: fakeRegistry([a.url], { erasure: true }),
      logger: silent,
    });
    expect(await (await gateOff.request("/v1/capabilities")).json()).toMatchObject({
      features: { dataErasureRequests: false },
    });

    const mixedFleet = createRouterApp({
      registry: fakeRegistry([a.url], { erasure: false }),
      erasureRequestsEnabled: () => true,
      internalRunnerToken: INTERNAL_TOKEN,
      logger: silent,
    });
    expect(await (await mixedFleet.request("/v1/capabilities")).json()).toMatchObject({
      features: { dataErasureRequests: false },
    });

    const oldControlFleet = createRouterApp({
      registry: fakeRegistry([a.url], { erasure: true, jobControl: false }),
      erasureRequestsEnabled: () => true,
      internalRunnerToken: INTERNAL_TOKEN,
      logger: silent,
    });
    expect(await (await oldControlFleet.request("/v1/capabilities")).json()).toMatchObject({
      features: { dataErasureRequests: false, erasureJobControl: [] },
    });
  });

  it("withholds tombstone and rejects DELETE until every healthy runner supports it", async () => {
    const a = await upstream(() => ({
      body: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        service: "agent-runner",
        features: {
          streaming: true,
          replay: { persistedEvents: true, hotWindowMs: 1 },
          approvals: true,
          sessionLifecycle: ["archive", "unarchive", "tombstone"],
          dynamicTools: true,
          mcp: [],
          skills: false,
          sandbox: ["none"],
          byok: true,
        },
      }),
    }));
    const app = createRouterApp({
      registry: fakeRegistry([a.url], { tombstone: false }),
      tombstoneEnabled: () => true,
      internalRunnerToken: INTERNAL_TOKEN,
      logger: silent,
    });

    const capabilities = await (await app.request("/v1/capabilities")).json() as {
      features: { sessionLifecycle: string[] };
    };
    expect(capabilities.features.sessionLifecycle).toEqual(["archive", "unarchive"]);
    expect((await app.request(`/v1/sessions/${SID}`, { method: "DELETE" })).status).toBe(503);
    expect(a.requests).toHaveLength(1);

    const explicitlyDisabled = createRouterApp({
      registry: fakeRegistry([a.url]),
      tombstoneEnabled: () => false,
      internalRunnerToken: INTERNAL_TOKEN,
      logger: silent,
    });
    expect((await explicitlyDisabled.request(`/v1/sessions/${SID}`, { method: "DELETE" })).status).toBe(503);
    const omittedGate = createRouterApp({
      registry: fakeRegistry([a.url]),
      internalRunnerToken: INTERNAL_TOKEN,
      logger: silent,
    });
    expect((await omittedGate.request(`/v1/sessions/${SID}`, { method: "DELETE" })).status).toBe(503);
    expect(a.requests).toHaveLength(1);
  });

  it("does not publish capabilities from a runner on an older protocol contract", async () => {
    const a = await upstream(() => ({ body: JSON.stringify({ protocolVersion: "2026-09-22", service: "agent-runner", features: { streaming: true, replay: { persistedEvents: true, hotWindowMs: 1 }, approvals: true, sessionLifecycle: ["archive", "unarchive"], dynamicTools: true, mcp: ["streamable-http"], skills: true, sandbox: ["none"], byok: true } }) }));
    const app = createRouterApp({ registry: fakeRegistry([a.url]), logger: silent });
    const response = await app.request("/v1/capabilities");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "draining", retryable: true },
    });
  });
});
