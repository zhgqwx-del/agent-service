import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionHost, ToolRegistry } from "@agent-service/core";
import {
  ErrorBody,
  INTERNAL_ROUTER_TOKEN_HEADER,
  INTERNAL_TENANT_ERASURE_ACTOR_HEADER,
  INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX,
  INTERNAL_TENANT_ERASURE_REPLAY_PATH,
  TenantErasureRequest,
  TenantErasureStatusResponse,
} from "@agent-service/protocol";
import { newErasureRequestId } from "@agent-service/store";
import { credentialResponsibilityFixture, responsibilityProvider } from "../../../packages/providers/test/credential-responsibility.fixture.js";
import { createApp } from "../src/app.js";
import { createRouterApp } from "../../agent-router/src/app.js";
import type { RunnerRegistry } from "../../agent-router/src/registry.js";

const INTERNAL = "credential-responsibility-internal-token-0001";
const OPERATOR = "credential-responsibility-platform-token-0001";
const ACTOR = "responsibility-platform-operator";
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => {
    server.closeAllConnections();
    return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }));
});

async function fixture(options: { attachReadiness?: boolean; tracking?: boolean } = {}) {
  const f = await credentialResponsibilityFixture({ tracking: options.tracking });
  const app = createApp({ store: f.store, providers: f.providers,
    host: {} as SessionHost, tools: {} as ToolRegistry,
    runnerId: "responsibility-http-runner", internalRouterToken: INTERNAL,
    heartbeatMs: 60_000, maxBodyBytes: 1_000_000, subjectLifecycle: f.store,
    ...(options.attachReadiness === false ? {} : { tenantCredentialResponsibility: f.store }),
    ready: () => true, decryptSecret: async () => "unused",
    encryptSecret: async () => ({ ciphertext: Buffer.from("unused"), keyId: "unused" }) });
  await f.providers.upsertTenantProvider(f.tenantId, responsibilityProvider());
  const request = await f.admit();
  const statusPath = `${INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX}/${request.requestId}?tenantId=${f.tenantId}`;
  const internal = (path = statusPath, init: RequestInit = {}) => app.request(path, {
    ...init, headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL,
      [INTERNAL_TENANT_ERASURE_ACTOR_HEADER]: ACTOR, ...Object.fromEntries(new Headers(init.headers)) },
  });
  return { ...f, app, request, statusPath, internal };
}

function expectPrivate(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}
async function readyFixture() {
  const f = await fixture(); await f.clearLocal(); await f.drainRuntime(); return f;
}

/** Real HTTP forwarding to the actual Memory-backed runner, not a precomputed successful DTO. */
async function routerFor(f: Awaited<ReturnType<typeof fixture>>, mutate?: (body: unknown) => unknown) {
  const seen: Array<{ path: string; authorization?: string; internal?: string; actor?: string }> = [];
  const server = createServer((req, res) => {
    void (async () => {
      seen.push({ path: req.url!, authorization: req.headers.authorization,
        internal: req.headers[INTERNAL_ROUTER_TOKEN_HEADER] as string | undefined,
        actor: req.headers[INTERNAL_TENANT_ERASURE_ACTOR_HEADER] as string | undefined });
      const response = await f.app.request(req.url!, { method: req.method,
        headers: Object.fromEntries(Object.entries(req.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")) });
      const body: unknown = await response.json();
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(JSON.stringify(mutate ? mutate(body) : body));
    })().catch(() => { res.writeHead(500); res.end(); });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const refresh = vi.fn(async () => {});
  const selected = vi.fn(() => origin);
  const supports = vi.fn(() => true);
  // Only the existing tenant-status registry surface is exercised here. Production registry
  // discovery/capability freshness has its own suites; this cannot authorize a new admission.
  const registry = { refresh, anyHealthy: selected,
    allHealthySupportTenantErasureControl: () => true,
    supportsTenantErasureControl: supports,
    markFailure: vi.fn(), list: () => [{ url: origin, healthy: true, lastCheckMs: Date.now(), consecutiveFailures: 0 }],
  } as unknown as RunnerRegistry;
  const router = createRouterApp({ registry, internalRunnerToken: INTERNAL,
    tenantErasureOperatorToken: OPERATOR, tenantErasureOperatorId: ACTOR,
    tenantErasureRequestsEnabled: () => false, logger: { info: () => {}, warn: () => {}, error: () => {} } });
  const publicPath = `/v1/tenant-erasure-requests/${f.request.requestId}?tenantId=${f.tenantId}`;
  return { router, publicPath, seen, refresh, selected, supports };
}

describe("tenant operator credential responsibility status", () => {
  it("consumes real source/T3a/T3b evidence and projects no private tuple or completion authority", async () => {
    const f = await fixture();
    const initial = await f.internal(); expect(initial.status).toBe(200); expectPrivate(initial);
    expect(TenantErasureStatusResponse.parse(await initial.json()).credentialResponsibility).toMatchObject({ status: "unknown", versionCount: null,
      customerManagedApiKeyCount: null, unknownMaterialCount: null, remoteCredentials: "unknown" });
    await f.clearLocal();
    const local = await f.internal(); expect(local.status).toBe(200);
    expect(TenantErasureStatusResponse.parse(await local.json()).credentialResponsibility).toMatchObject({ status: "awaiting_runtime_drain",
      localDatabase: "cleared", trackedRuntimeReferences: "not_drained" });
    await f.drainRuntime();
    const response = await f.internal(); expect(response.status).toBe(200); expectPrivate(response);
    const body = TenantErasureStatusResponse.parse(await response.json());
    expect(body.status).toBe("gated");
    expect(body.credentialResponsibility).toMatchObject({ schema: "tenant-credential-responsibility-status-v1",
      status: "local_responsibility_observed", localDatabase: "cleared",
      trackedRuntimeReferences: "dropped_not_zeroized", remoteCredentials: "customer_responsibility_recorded",
      versionCount: 1, customerManagedApiKeyCount: 1, unknownMaterialCount: 0,
      sharedKeys: "platform_shared_not_tenant_deletable", backupCopies: "unknown", otherCopies: "unknown",
      executionReady: false, externalAuthorityVerified: false, allDomainsComplete: false, contentPurgeExecuted: false });
    const projection = body.credentialResponsibility!;
    expect(Object.keys(projection).sort()).toEqual(["allDomainsComplete", "backupCopies", "contentPurgeExecuted",
      "customerManagedApiKeyCount", "executionReady", "externalAuthorityVerified", "localDatabase", "otherCopies",
      "remoteCredentials", "schema", "sharedKeys", "status", "trackedRuntimeReferences", "unknownMaterialCount", "versionCount"]);
    for (const field of ["tenantId", "requestId", "t1FenceSha256", "t3aReceiptSha256", "t3bReceiptSha256",
      "responsibilityReceiptSha256", "credentialVersionId", "secret", "targetReference"]) expect(projection).not.toHaveProperty(field);
    expect(JSON.stringify(body)).not.toContain("responsibility-fixture-customer-key");
  });

  it("keeps old-runner absence unknown and leaves POST/exact replay response unchanged", async () => {
    const f = await fixture({ attachReadiness: false });
    const response = await f.internal(); expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).not.toHaveProperty("credentialResponsibility");
    expect(TenantErasureStatusResponse.safeParse(body).success).toBe(true);
    const replay = await f.internal(INTERNAL_TENANT_ERASURE_REPLAY_PATH, { method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "fixture-erase" },
      body: JSON.stringify({ tenantId: f.tenantId }) });
    expect(replay.status).toBe(202); expectPrivate(replay);
    const replayBody = await replay.json();
    expect(TenantErasureRequest.safeParse(replayBody).success).toBe(true);
    expect(replayBody).not.toHaveProperty("credentialResponsibility");
  });

  it("keeps an actual legacy/inactive T3a/T3b terminal without inventory unknown, not a proved empty set", async () => {
    const f = await fixture({ tracking: false });
    await f.clearLocal(); await f.drainRuntime();
    const raw = await f.store.getTenantCredentialResponsibilityReadiness(f.tenantId, f.request.requestId);
    expect(raw).toMatchObject({ status: "unknown", responsibilityReceiptSha256: null,
      localDatabase: "cleared", trackedRuntimeReferences: "dropped_not_zeroized",
      versionCount: null, customerManagedApiKeyCount: null, unknownMaterialCount: null });
    const response = await f.internal(); expect(response.status).toBe(200); expectPrivate(response);
    expect(TenantErasureStatusResponse.parse(await response.json()).credentialResponsibility).toMatchObject({ status: "unknown",
      localDatabase: "cleared", trackedRuntimeReferences: "dropped_not_zeroized", remoteCredentials: "unknown",
      versionCount: null, customerManagedApiKeyCount: null, unknownMaterialCount: null, allDomainsComplete: false });
  });

  it("hides wrong-owner requests before consulting readiness and rejects a mismatched trusted getter tuple", async () => {
    const f = await readyFixture();
    const getter = vi.spyOn(f.store, "getTenantCredentialResponsibilityReadiness");
    const denied = await f.internal(`${INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX}/${f.request.requestId}?tenantId=responsibility-neighbor`);
    const absent = await f.internal(`${INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX}/${newErasureRequestId()}?tenantId=responsibility-neighbor`);
    expect(denied.status).toBe(404); expect(absent.status).toBe(404);
    expect(await denied.json()).toEqual(await absent.json());
    expect(getter).not.toHaveBeenCalled();
    const actual = await f.store.getTenantCredentialResponsibilityReadiness(f.tenantId, f.request.requestId);
    expect(actual).not.toBeNull();
    getter.mockResolvedValue({ ...actual!, tenantId: "responsibility-neighbor" });
    const invalid = await f.internal(); expect(invalid.status).toBe(503); expectPrivate(invalid);
    expect(ErrorBody.parse(await invalid.json()).error.code).toBe("draining");
  });

  it("authenticates at the router before observing fleet and preserves the closed projection through actual HTTP", async () => {
    const f = await readyFixture(); const r = await routerFor(f);
    const unauthorized = await r.router.request(r.publicPath, { headers: { authorization: "Bearer tenant-service-key" } });
    expect(unauthorized.status).toBe(401); expectPrivate(unauthorized);
    expect(r.refresh).not.toHaveBeenCalled(); expect(r.selected).not.toHaveBeenCalled();
    expect(r.supports).not.toHaveBeenCalled(); expect(r.seen).toHaveLength(0);
    const response = await r.router.request(r.publicPath, { headers: { authorization: `Bearer ${OPERATOR}` } });
    expect(response.status).toBe(200); expectPrivate(response);
    const body = TenantErasureStatusResponse.parse(await response.json());
    expect(body.credentialResponsibility?.status).toBe("local_responsibility_observed");
    expect(r.selected).toHaveBeenCalledOnce(); expect(r.supports).toHaveBeenCalledOnce(); expect(r.seen).toHaveLength(1);
    expect(r.seen[0]).toMatchObject({ authorization: undefined, internal: INTERNAL, actor: ACTOR });
    expect(r.seen[0]!.path).toBe(f.statusPath);
  });

  it.each(["private-field", "completion", "contradictory", "missing-count", "mixed-counts"] as const)(
    "fails closed before forwarding an invalid responsibility projection: %s", async (kind) => {
      const f = await readyFixture();
      const r = await routerFor(f, (body) => {
        const result = structuredClone(body) as Record<string, unknown>;
        const detail = result.credentialResponsibility as Record<string, unknown>;
        if (kind === "private-field") detail.t1FenceSha256 = "0".repeat(64);
        if (kind === "completion") detail.allDomainsComplete = true;
        if (kind === "contradictory") detail.localDatabase = "unknown";
        if (kind === "missing-count") detail.unknownMaterialCount = null;
        if (kind === "mixed-counts") { detail.status = "unknown"; detail.versionCount = null; }
        return result;
      });
      const response = await r.router.request(r.publicPath, { headers: { authorization: `Bearer ${OPERATOR}` } });
      expect(response.status).toBe(503); expectPrivate(response);
      expect(await response.json()).toMatchObject({ error: { code: "draining" } });
    });
});
