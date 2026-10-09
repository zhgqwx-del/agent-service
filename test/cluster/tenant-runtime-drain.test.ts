import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  INTERNAL_ROUTER_TOKEN_HEADER,
  INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER,
  INTERNAL_TENANT_RUNTIME_DRAIN_ACK_VALUE,
  INTERNAL_TENANT_RUNTIME_DRAIN_READY_PATH,
  INTERNAL_TENANT_RUNTIME_DRAIN_ROUTER_PATH,
  INTERNAL_TENANT_RUNTIME_DRAIN_RUNNER_PATH,
  PROTOCOL_VERSION,
  TENANT_RUNTIME_DRAIN_V1,
  TenantRuntimeDrainReady,
  TenantRuntimeDrainRunnerRequest,
  TenantRuntimeRevocationFleetProof,
  tenantRuntimeLocalReceiptSha256,
  tenantRuntimeTargetSha256,
} from "../../packages/protocol/src/index.js";
import {
  INTERNAL_ROUTER_TOKEN,
  startCluster,
  type Cluster,
} from "./harness.js";

const enabled = process.env.AGENT_SERVICE_CLUSTER === "1";
const AUTHORITY = {
  requestId: "erase_019a2b3c-4d5e-4f00-8a9b-0c1d2e3f4a5b",
  tenantId: "t_runtime_cluster",
  subjectGeneration: 1,
  t3aReceiptSha256: "3".repeat(64),
};
let cluster: Cluster | undefined;
const fakeRunners: Server[] = [];

afterEach(async () => {
  await cluster?.stop();
  cluster = undefined;
  await Promise.all(fakeRunners.splice(0).map((server) => {
    server.closeAllConnections?.();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

interface RuntimeRunner {
  url: string;
  runnerId: string;
  bootId: string;
  executeCalls: TenantRuntimeDrainRunnerRequest[];
}

/**
 * A process-level HTTP fixture for the runner-private protocol. It deliberately stubs only the
 * already-authorized local coordinator boundary, so this suite never invokes credential deletion.
 */
async function startRuntimeRunner(
  runnerId: string,
  bootId: string,
  endpointEnabled = true,
): Promise<RuntimeRunner> {
  const executeCalls: TenantRuntimeDrainRunnerRequest[] = [];
  const server = createServer((request, response) => {
    const replyJson = (status: number, value: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...headers,
      });
      response.end(JSON.stringify(value));
    };
    if (request.url === "/readyz" && request.method === "GET") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ready");
      return;
    }
    if (request.url === "/v1/capabilities" && request.method === "GET") {
      replyJson(200, {
        protocolVersion: PROTOCOL_VERSION,
        service: "agent-runner",
        features: {
          streaming: true,
          replay: { persistedEvents: true, hotWindowMs: 60_000 },
          approvals: true,
          sessionLifecycle: ["archive", "unarchive", "tombstone"],
          tenantRuntimeDrain: [TENANT_RUNTIME_DRAIN_V1],
          tenantRuntimeDrainEndpoint: endpointEnabled,
          dynamicTools: false,
          mcp: [],
          skills: false,
          sandbox: ["none"],
          byok: true,
        },
      });
      return;
    }
    const authenticated = request.headers[INTERNAL_ROUTER_TOKEN_HEADER]
      === INTERNAL_ROUTER_TOKEN;
    if (
      request.url === INTERNAL_TENANT_RUNTIME_DRAIN_READY_PATH
      && request.method === "GET"
    ) {
      if (!authenticated) return replyJson(404, { error: { code: "not_found" } });
      if (!endpointEnabled) return replyJson(503, {});
      replyJson(200, {
        protocolVersion: PROTOCOL_VERSION,
        service: "agent-runner",
        capability: TENANT_RUNTIME_DRAIN_V1,
        endpointEnabled: true,
        runnerId,
        bootId,
      }, {
        [INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER]:
          INTERNAL_TENANT_RUNTIME_DRAIN_ACK_VALUE,
      });
      return;
    }
    if (
      request.url === INTERNAL_TENANT_RUNTIME_DRAIN_RUNNER_PATH
      && request.method === "POST"
    ) {
      if (!authenticated) return replyJson(404, { error: { code: "not_found" } });
      if (!endpointEnabled) return replyJson(503, {});
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => {
        const input = TenantRuntimeDrainRunnerRequest.parse(
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
        );
        executeCalls.push(input);
        const body = {
          targetSha256: input.targetSha256,
          runnerId,
          bootId,
          requestId: input.requestId,
          tenantId: input.tenantId,
          subjectGeneration: input.subjectGeneration,
          t3aReceiptSha256: input.t3aReceiptSha256,
          cacheEntryCountBefore: 0,
          cacheEntryCountAfter: 0 as const,
          activeOperationCountBefore: 0,
          activeOperationCountAfter: 0 as const,
          activeTurnCountBefore: 0,
          activeTurnCountAfter: 0 as const,
          completedAtMs: 100,
        };
        replyJson(200, {
          ...body,
          receiptSha256: tenantRuntimeLocalReceiptSha256(body),
        }, {
          [INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER]:
            INTERNAL_TENANT_RUNTIME_DRAIN_ACK_VALUE,
        });
      });
      return;
    }
    replyJson(404, { error: { code: "not_found" } });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  fakeRunners.push(server);
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    runnerId,
    bootId,
    executeCalls,
  };
}

async function privateReady(runner: RuntimeRunner): Promise<TenantRuntimeDrainReady> {
  const response = await fetch(`${runner.url}${INTERNAL_TENANT_RUNTIME_DRAIN_READY_PATH}`, {
    headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_ROUTER_TOKEN },
  });
  expect(response.status).toBe(200);
  return TenantRuntimeDrainReady.parse(await response.json());
}

async function drainFleet(): Promise<Response> {
  return fetch(`${cluster!.router.url}${INTERNAL_TENANT_RUNTIME_DRAIN_ROUTER_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_ROUTER_TOKEN,
    },
    body: JSON.stringify(AUTHORITY),
  });
}

describe.skipIf(!enabled)("cluster: tenant runtime drain fleet fanout", () => {
  it("binds one receipt to each exact configured target and stable before/after boot identity", async () => {
    const runners = await Promise.all([
      startRuntimeRunner("runner-1", "boot-1"),
      startRuntimeRunner("runner-2", "boot-2"),
    ]);
    cluster = await startCluster({
      runners: 0,
      additionalRunnerUrls: runners.map((runner) => runner.url),
      tenantRuntimeDrainExecutionEnabled: true,
    });
    const before = await Promise.all(runners.map(privateReady));
    const response = await drainFleet();
    expect(response.status).toBe(200);
    expect(response.headers.get(INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER)).toBe(
      INTERNAL_TENANT_RUNTIME_DRAIN_ACK_VALUE,
    );
    const proof = TenantRuntimeRevocationFleetProof.parse(await response.json());
    const after = await Promise.all(runners.map(privateReady));

    expect(runners.map((runner) => runner.executeCalls.length)).toEqual([1, 1]);
    expect(proof.targets.map((target) => target.targetSha256).sort()).toEqual(
      runners.map((runner) => tenantRuntimeTargetSha256(runner.url)).sort(),
    );
    const proofIdentity = new Map(proof.targets.map((target) => [
      target.runnerId,
      target.bootId,
    ]));
    for (const identity of [...before, ...after]) {
      expect(proofIdentity.get(identity.runnerId)).toBe(identity.bootId);
    }
    expect(proof.targets.every((target) => (
      target.requestId === AUTHORITY.requestId
      && target.tenantId === AUTHORITY.tenantId
      && target.subjectGeneration === AUTHORITY.subjectGeneration
      && target.t3aReceiptSha256 === AUTHORITY.t3aReceiptSha256
    ))).toBe(true);
  });

  it("returns 503 without a proof when one exact configured endpoint is disabled", async () => {
    const active = await startRuntimeRunner("runner-1", "boot-1");
    const disabled = await startRuntimeRunner("runner-2", "boot-2", false);
    cluster = await startCluster({
      runners: 0,
      additionalRunnerUrls: [active.url, disabled.url],
      tenantRuntimeDrainExecutionEnabled: true,
    });
    const response = await drainFleet();
    expect(response.status).toBe(503);
    expect(response.headers.get(INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER)).toBeNull();
    expect(active.executeCalls).toHaveLength(0);
    expect(disabled.executeCalls).toHaveLength(0);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "draining", retryable: true },
    });
  });
});
