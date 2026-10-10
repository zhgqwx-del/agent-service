import { describe, expect, it, vi } from "vitest";
import type { SessionHost, ToolRegistry } from "@agent-service/core";
import type { ProviderService } from "@agent-service/providers";
import {
  INTERNAL_ROUTER_TOKEN_HEADER,
  INTERNAL_TENANT_ERASURE_ACTOR_HEADER,
  INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX,
  INTERNAL_TENANT_ERASURE_REPLAY_ACK_HEADER,
  INTERNAL_TENANT_ERASURE_REPLAY_ACK_VALUE,
  INTERNAL_TENANT_ERASURE_REPLAY_PATH,
  INTERNAL_TENANT_ERASURE_ROUTE_ACK_HEADER,
  INTERNAL_TENANT_ERASURE_ROUTE_ACK_VALUE,
  TENANT_ERASURE_PLATFORM_CONTROL_V1,
} from "@agent-service/protocol";
import {
  EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  MemorySessionStore,
  newErasureRequestId,
  userErasureRequestHash,
} from "@agent-service/store";
import { createApp } from "../src/app.js";
import { hashApiKey } from "../src/auth.js";

const INTERNAL_TOKEN = "tenant-erasure-runner-private-token-0001";

async function fixture(options: {
  enabled?: boolean;
  attachStore?: boolean;
  gate?: () => Promise<boolean>;
  publicationReady?: (tenantId: string, requestId: string) => Promise<boolean>;
  useStorePublicationReady?: boolean;
} = {}) {
  const store = new MemorySessionStore();
  await store.createApiKey("t_target", "admin", hashApiKey("tenant-key"), ["runtime", "admin"]);
  await store.createApiKey("t_other", "admin", hashApiKey("other-key"), ["runtime", "admin"]);
  const gate = vi.fn(options.gate ?? (async () => true));
  const attachStore = options.attachStore ?? true;
  const app = createApp({
    store,
    host: {} as SessionHost,
    providers: {} as ProviderService,
    tools: {} as ToolRegistry,
    runnerId: "tenant-erasure-test",
    internalRouterToken: INTERNAL_TOKEN,
    heartbeatMs: 60_000,
    maxBodyBytes: 1_000_000,
    subjectLifecycle: attachStore ? store : undefined,
    tenantErasureRequestsEnabled: options.enabled ?? false,
    tenantErasureAdmissionGate: options.enabled ? { canAdmit: gate } : undefined,
    tenantRestoreJournalPublicationReady: options.useStorePublicationReady
      ? async (tenantId: string, requestId: string) => {
          const control = await store.getTenantRestoreJournalControl();
          if (control.controlGeneration === 0) return true;
          return (await store.getTenantRestoreJournalPublicationBundle(tenantId, requestId))
            ?.receipt !== undefined;
        }
      : options.publicationReady,
    ready: () => true,
    decryptSecret: async () => "unused",
    encryptSecret: async () => ({ ciphertext: Buffer.from("unused"), keyId: "unused" }),
  });
  const internal = (path: string, init: RequestInit = {}, token = INTERNAL_TOKEN) => {
    const headers = new Headers(init.headers);
    headers.set(INTERNAL_ROUTER_TOKEN_HEADER, token);
    headers.set(INTERNAL_TENANT_ERASURE_ACTOR_HEADER, "platform-test-operator");
    return app.request(path, { ...init, headers });
  };
  return { app, store, gate, internal };
}

function expectPrivate(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

function expectControlAck(response: Response): void {
  expect(response.headers.get(INTERNAL_TENANT_ERASURE_ROUTE_ACK_HEADER))
    .toBe(INTERNAL_TENANT_ERASURE_ROUTE_ACK_VALUE);
}

function expectReplayAck(response: Response): void {
  expect(response.headers.get(INTERNAL_TENANT_ERASURE_REPLAY_ACK_HEADER))
    .toBe(INTERNAL_TENANT_ERASURE_REPLAY_ACK_VALUE);
}

describe("runner-only tenant erasure control", () => {
  it("advertises code awareness separately from local admission", async () => {
    const readable = await fixture();
    const active = await fixture({ enabled: true });
    const absent = await fixture({ attachStore: false });

    expect(await (await readable.app.request("/v1/capabilities")).json()).toMatchObject({
      features: {
        tenantErasureControl: [TENANT_ERASURE_PLATFORM_CONTROL_V1],
        tenantErasureRequests: false,
      },
    });
    expect(await (await active.app.request("/v1/capabilities")).json()).toMatchObject({
      features: {
        tenantErasureControl: [TENANT_ERASURE_PLATFORM_CONTROL_V1],
        tenantErasureRequests: true,
      },
    });
    expect(await (await absent.app.request("/v1/capabilities")).json()).toMatchObject({
      features: { tenantErasureControl: [], tenantErasureRequests: false },
    });
  });

  it("authenticates the private route before parsing a target or body", async () => {
    const { app, store, gate } = await fixture({ enabled: true });
    const request = vi.spyOn(store, "requestTenantErasure");
    const response = await app.request(INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "secret-probe" },
      body: "{".repeat(4_096),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "not_found", message: "not found" } });
    expectPrivate(response);
    expect(response.headers.get(INTERNAL_TENANT_ERASURE_ROUTE_ACK_HEADER)).toBeNull();
    expect(gate).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("requires both the local gate and a fresh fleet proof before the atomic admission", async () => {
    const closed = await fixture({ enabled: true, gate: async () => false });
    const request = vi.spyOn(closed.store, "requestTenantErasure");
    const response = await closed.internal(INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "closed-fleet" },
      body: JSON.stringify({ tenantId: "t_target" }),
    });
    expect(response.status).toBe(503);
    expectPrivate(response);
    expectControlAck(response);
    expect(closed.gate).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
    expect(await closed.store.getTenantErasureRequest("t_target", newErasureRequestId())).toBeNull();

    const localOff = await fixture();
    const localResponse = await localOff.internal(INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "local-off" },
      body: JSON.stringify({ tenantId: "t_target" }),
    });
    expect(localResponse.status).toBe(503);
    expectControlAck(localResponse);
    expect(localOff.gate).not.toHaveBeenCalled();
  });

  it("admits once, safely replays, records only the configured actor, and revokes tenant keys", async () => {
    const { app, store, gate, internal } = await fixture({ enabled: true });
    const post = () => internal(INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "tenant-op-1" },
      body: JSON.stringify({ tenantId: "t_target", actor: "untrusted-client-value" }),
    });

    // Strict parsing rejects caller-controlled actor material before the fleet proof.
    const invalid = await post();
    expect(invalid.status).toBe(400);
    expect(gate).not.toHaveBeenCalled();

    const send = () => internal(INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "tenant-op-1" },
      body: JSON.stringify({ tenantId: "t_target" }),
    });
    const first = await send();
    const replay = await send();
    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expectPrivate(first);
    expectControlAck(first);
    const firstBody = await first.json() as { id: string; status: string; tenantId: string };
    expect(await replay.json()).toEqual(firstBody);
    expect(firstBody).toMatchObject({ scope: "tenant", tenantId: "t_target", status: "gated" });
    // A committed exact replay is read-only and does not depend on the current admission barrier.
    expect(gate).toHaveBeenCalledTimes(1);

    const record = await store.getTenantErasureRequest("t_target", firstBody.id);
    expect(record?.requestedByKeyId).toBe("platform-test-operator");
    const tenantKey = await app.request("/v1/capabilities", {
      headers: { authorization: "Bearer tenant-key" },
    });
    expect(tenantKey.status).toBe(200);
    const rejectedRuntime = await app.request("/v1/agents", {
      headers: { authorization: "Bearer tenant-key" },
    });
    expect(rejectedRuntime.status).toBe(401);
  });

  it("withholds both create and replay acknowledgements until the active journal receipt exists", async () => {
    let published = false;
    const publicationReady = vi.fn(async () => published);
    const { store, internal } = await fixture({ enabled: true, publicationReady });
    const create = vi.spyOn(store, "requestTenantErasure");
    const send = (path: string = INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX) => internal(path, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "journal-fenced" },
      body: JSON.stringify({ tenantId: "t_target" }),
    });

    const first = await send();
    expect(first.status).toBe(503);
    expectPrivate(first);
    expectControlAck(first);
    expect(create).toHaveBeenCalledOnce();
    expect(store.tenantErasureAdmissions.size).toBe(1);
    const [committed] = [...store.tenantErasureAdmissions.values()];
    expect(committed).toBeDefined();
    expect(publicationReady).toHaveBeenLastCalledWith("t_target", committed!.requestId);

    const pendingReplay = await send();
    expect(pendingReplay.status).toBe(503);
    expect(create).toHaveBeenCalledOnce();
    expect(store.tenantErasureAdmissions.size).toBe(1);

    const dedicatedPendingReplay = await send(INTERNAL_TENANT_ERASURE_REPLAY_PATH);
    expect(dedicatedPendingReplay.status).toBe(503);
    expectReplayAck(dedicatedPendingReplay);
    expect(create).toHaveBeenCalledOnce();

    published = true;
    const accepted = await send();
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({
      id: committed!.requestId,
      tenantId: "t_target",
      status: "gated",
    });
    expect(create).toHaveBeenCalledOnce();
    expect(store.tenantErasureAdmissions.size).toBe(1);

    const dedicatedAccepted = await send(INTERNAL_TENANT_ERASURE_REPLAY_PATH);
    expect(dedicatedAccepted.status).toBe(202);
    expectReplayAck(dedicatedAccepted);
    expect(await dedicatedAccepted.json()).toMatchObject({ id: committed!.requestId });
    expect(create).toHaveBeenCalledOnce();
  });

  it("keeps a pre-activation T1 readable while its new journal publication is pending", async () => {
    const { store, internal } = await fixture({
      enabled: true,
      useStorePublicationReady: true,
    });
    const send = (path: string = INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX) => internal(path, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "pre-journal-t1" },
      body: JSON.stringify({ tenantId: "t_target" }),
    });

    const admitted = await send();
    expect(admitted.status).toBe(202);
    const admittedBody = await admitted.json() as { id: string };
    const logicalDatabaseNamespaceSha256 = "1".repeat(64);
    const target = {
      targetOrdinal: 0,
      targetSha256: "2".repeat(64),
      failureDomainSha256: "3".repeat(64),
      adapterProtocol: "memory-restore-journal-v1",
      journalNamespaceSha256: "4".repeat(64),
    };
    await store.activateTenantRestoreJournalControl({
      adapterProtocol: target.adapterProtocol,
      journalNamespaceSha256: target.journalNamespaceSha256,
      logicalDatabaseNamespaceSha256,
      runtimeEpochSha256: "5".repeat(64),
      targets: [target],
      observedHeads: [{
        ...target,
        logicalDatabaseNamespaceSha256,
        sealedRemoteSequence: 0,
        sealedHeadRootSha256: EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
      }],
    });
    expect(await store.getTenantRestoreJournalPublicationBundle("t_target", admittedBody.id))
      .toBeNull();

    const exactReplay = await send();
    expect(exactReplay.status).toBe(503);
    expectControlAck(exactReplay);
    const dedicatedReplay = await send(INTERNAL_TENANT_ERASURE_REPLAY_PATH);
    expect(dedicatedReplay.status).toBe(503);
    expectReplayAck(dedicatedReplay);

    const status = await internal(
      `${INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX}/${admittedBody.id}?tenantId=t_target`,
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ id: admittedBody.id, tenantId: "t_target" });
  });

  it("maps an active journal receipt read failure to a retryable response", async () => {
    const publicationReady = vi.fn(async () => {
      throw new Error("sensitive dependency failure");
    });
    const { store, internal } = await fixture({ enabled: true, publicationReady });
    const create = vi.spyOn(store, "requestTenantErasure");
    const response = await internal(INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "journal-read-error" },
      body: JSON.stringify({ tenantId: "t_target" }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "draining", message: "tenant erasure journal publication is pending" },
    });
    expect(create).toHaveBeenCalledOnce();
    expect(store.tenantErasureAdmissions.size).toBe(1);
  });

  it("keeps status readable while admission is off and confines it to the requested tenant", async () => {
    const seeded = await fixture({ enabled: true });
    const accepted = await seeded.internal(INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "status-readable" },
      body: JSON.stringify({ tenantId: "t_target" }),
    });
    const body = await accepted.json() as { id: string };

    const app = createApp({
      store: seeded.store,
      host: {} as SessionHost,
      providers: {} as ProviderService,
      tools: {} as ToolRegistry,
      runnerId: "tenant-erasure-status-test",
      internalRouterToken: INTERNAL_TOKEN,
      heartbeatMs: 60_000,
      maxBodyBytes: 1_000_000,
      subjectLifecycle: seeded.store,
      tenantErasureRequestsEnabled: false,
      ready: () => true,
      decryptSecret: async () => "unused",
      encryptSecret: async () => ({ ciphertext: Buffer.from("unused"), keyId: "unused" }),
    });
    const create = vi.spyOn(seeded.store, "requestTenantErasure");
    const replayRead = vi.spyOn(seeded.store, "replayTenantErasure");
    const replay = await app.request(INTERNAL_TENANT_ERASURE_REPLAY_PATH, {
      method: "POST",
      headers: {
        [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_TOKEN,
        "content-type": "application/json",
        "idempotency-key": "status-readable",
      },
      body: JSON.stringify({ tenantId: "t_target" }),
    });
    expect(replay.status).toBe(202);
    expectPrivate(replay);
    expectReplayAck(replay);
    expect(await replay.json()).toMatchObject({ id: body.id, tenantId: "t_target" });
    expect(create).not.toHaveBeenCalled();
    expect(replayRead).toHaveBeenCalledOnce();

    const missingReplay = await app.request(INTERNAL_TENANT_ERASURE_REPLAY_PATH, {
      method: "POST",
      headers: {
        [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_TOKEN,
        "content-type": "application/json",
        "idempotency-key": "different-key",
      },
      body: JSON.stringify({ tenantId: "t_target" }),
    });
    expect(missingReplay.status).toBe(503);
    expectReplayAck(missingReplay);
    expect(create).not.toHaveBeenCalled();

    const get = (tenantId: string) => app.request(
      `${INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX}/${body.id}?tenantId=${tenantId}`,
      { headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_TOKEN } },
    );
    const status = await get("t_target");
    expect(status.status).toBe(200);
    expectPrivate(status);
    expectControlAck(status);
    expect(await status.json()).toMatchObject({ id: body.id, tenantId: "t_target", status: "gated" });
    expect((await get("t_other")).status).toBe(404);
    expect((await app.request(
      `${INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX}/${body.id}?tenantId=t_target`,
      { headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: "wrong-private-token-000000000000" } },
    )).status).toBe(404);
  });

  it("replays before a closing admission barrier and never calls the create primitive", async () => {
    const seeded = await fixture({ enabled: true });
    const accepted = await seeded.internal(INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "barrier-closes" },
      body: JSON.stringify({ tenantId: "t_target" }),
    });
    const expected = await accepted.json();
    seeded.gate.mockResolvedValue(false);
    seeded.gate.mockClear();
    const create = vi.spyOn(seeded.store, "requestTenantErasure");

    const replay = await seeded.internal(INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "barrier-closes" },
      body: JSON.stringify({ tenantId: "t_target" }),
    });
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual(expected);
    expect(seeded.gate).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("maps an active user-erasure worker authority to a stable state conflict", async () => {
    const { store, internal } = await fixture({ enabled: true });
    const userRequestId = newErasureRequestId();
    await store.requestUserErasure({
      requestId: userRequestId,
      tenantId: "t_target",
      userId: "u_active",
      requestedByKeyId: "admin",
      idempotencyKey: "active-user-erasure",
      requestHash: userErasureRequestHash("t_target", "u_active"),
      atMs: 1_000,
    });
    const response = await internal(INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "tenant-conflict" },
      body: JSON.stringify({ tenantId: "t_target" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "state_conflict" } });
    expectControlAck(response);
  });

  it("returns an owner-hiding 404 for an unregistered tenant without leaving lifecycle residue", async () => {
    const { store, internal } = await fixture({ enabled: true });
    const response = await internal(INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "unknown-target" },
      body: JSON.stringify({ tenantId: "t_typo" }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "not found" },
    });
    expectPrivate(response);
    expectControlAck(response);
    expect(await store.getSubjectLifecycle("t_typo", "tenant", "t_typo")).toBeNull();
    expect([...store.tenantErasureAdmissions.values()].some((row) => row.tenantId === "t_typo"))
      .toBe(false);
  });

  it("fails corrupt status and replay proofs as generic private 500s with route-specific ACKs", async () => {
    const { store, internal } = await fixture({ enabled: true });
    const accepted = await internal(INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "corrupt-status" },
      body: JSON.stringify({ tenantId: "t_target" }),
    });
    const { id } = await accepted.json() as { id: string };
    store.tenantCredentialRevocationFences.delete("t_target");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await internal(
      `${INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX}/${id}?tenantId=t_target`,
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "internal_error", message: "internal error" },
    });
    expectPrivate(response);
    expectControlAck(response);
    const replay = await internal(INTERNAL_TENANT_ERASURE_REPLAY_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "corrupt-status" },
      body: JSON.stringify({ tenantId: "t_target" }),
    });
    expect(replay.status).toBe(500);
    expect(await replay.json()).toEqual({
      error: { code: "internal_error", message: "internal error" },
    });
    expectPrivate(replay);
    expectReplayAck(replay);
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});
