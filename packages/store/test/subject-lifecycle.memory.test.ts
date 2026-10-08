import { describe, expect, it } from "vitest";
import {
  BLOB_STORAGE_FORMAT,
  MemorySessionStore,
  SessionGoneError,
  SubjectDeletingError,
  newErasureRequestId,
  userErasureRequestHash,
} from "../src/index.js";
import { mkSession, newId } from "./conformance.js";

function requestInput(tenantId: string, userId: string, idempotencyKey = "erase-once") {
  return {
    requestId: newErasureRequestId(),
    tenantId,
    userId,
    requestedByKeyId: "admin-key",
    idempotencyKey,
    requestHash: userErasureRequestHash(tenantId, userId),
    atMs: 1_800_000_000_000,
  };
}

describe("MemorySessionStore subject lifecycle", () => {
  it("atomically installs the user gate, request and first audit event", async () => {
    const store = new MemorySessionStore();
    const session = mkSession("tenant-gate", "user-gate");
    await store.createSession(session);
    const input = requestInput(session.tenantId, session.userId);

    const request = await store.requestUserErasure(input);
    expect(request).toMatchObject({
      requestId: input.requestId,
      tenantId: session.tenantId,
      subjectKind: "user",
      subjectId: session.userId,
      generation: 1,
      status: "gated",
      gatedAtMs: input.atMs,
    });
    expect(await store.getSubjectLifecycle(session.tenantId, "user", session.userId)).toMatchObject({
      state: "deleting",
      generation: 1,
      activeRequestId: input.requestId,
    });
    expect(await store.listErasureAuditEvents(input.requestId)).toEqual([{
      requestId: input.requestId,
      seq: 1,
      type: "erasure/gated",
      payload: { status: "gated", subjectKind: "user", generation: 1 },
      emittedAtMs: input.atMs,
    }]);

    // Ordinary owner APIs become non-oracles immediately, while the internal lifecycle view stays
    // available to the future erasure worker.
    expect(await store.getSession(session.tenantId, session.id)).toBeNull();
    expect((await store.listSessions(session.tenantId, { userId: session.userId, limit: 20 })).data).toEqual([]);
    expect(await store.getSessionLifecycle(session.tenantId, session.userId, session.id)).toMatchObject({
      session: { id: session.id },
    });
    await expect(store.commit({ sessionId: session.id, fence: 1, sessionPatch: { title: "late" } }))
      .rejects.toBeInstanceOf(SessionGoneError);
    await expect(store.createSession(mkSession(session.tenantId, session.userId)))
      .rejects.toBeInstanceOf(SubjectDeletingError);
  });

  it("replays by subject-scoped key and isolates the same key across users and tenants", async () => {
    const store = new MemorySessionStore();
    const first = requestInput("tenant-a", "user-a", "shared-key");
    const replay = { ...first, requestId: newErasureRequestId(), atMs: first.atMs + 1 };
    const secondUser = requestInput("tenant-a", "user-b", "shared-key");
    const secondTenant = requestInput("tenant-b", "user-a", "shared-key");

    const created = await store.requestUserErasure(first);
    expect(await store.requestUserErasure(replay)).toEqual(created);
    expect(await store.requestUserErasure({ ...replay, idempotencyKey: "another-key" })).toEqual(created);
    expect((await store.requestUserErasure(secondUser)).requestId).toBe(secondUser.requestId);
    expect((await store.requestUserErasure(secondTenant)).requestId).toBe(secondTenant.requestId);
    expect(store.erasureRequests).toHaveLength(3);
    expect(store.erasureAuditEvents).toHaveLength(3);
  });

  it("fails closed when replay indexes cross scope or point at an unreadable active request", async () => {
    const store = new MemorySessionStore();
    const input = requestInput("tenant-replay-integrity", "user-replay-integrity", "replay-key");
    const foreign = requestInput("tenant-replay-integrity", "foreign-user", "foreign-key");
    await store.requestUserErasure(input);
    await store.requestUserErasure(foreign);
    const internals = store as unknown as { erasureIdempotency: Map<string, string> };
    const replayKey = JSON.stringify([
      input.tenantId,
      "user",
      input.userId,
      input.idempotencyKey,
    ]);
    internals.erasureIdempotency.set(replayKey, foreign.requestId);

    await expect(store.requestUserErasure({ ...input, requestId: newErasureRequestId() }))
      .rejects.toThrow("erasure idempotency index is corrupt");

    internals.erasureIdempotency.set(replayKey, input.requestId);
    store.erasureRequests.get(input.requestId)!.quarantinedAtMs = input.atMs;
    await expect(store.requestUserErasure({ ...input, requestId: newErasureRequestId() }))
      .rejects.toThrow("quarantine markers are incomplete");
    await expect(store.requestUserErasure({
      ...input,
      requestId: newErasureRequestId(),
      idempotencyKey: "different-replay-key",
    })).rejects.toThrow("quarantine markers are incomplete");
  });

  it("keeps lifecycle time monotonic when a clock-behind runner gates and replays", async () => {
    const store = new MemorySessionStore();
    const lifecycleAtMs = 2_000_000_000_000;
    const session = {
      ...mkSession("tenant-clock-skew", "user-clock-skew"),
      createdAtMs: lifecycleAtMs,
      updatedAtMs: lifecycleAtMs,
    };
    await store.createSession(session);
    const input = {
      ...requestInput(session.tenantId, session.userId, "clock-skew-key"),
      atMs: lifecycleAtMs - 1_000,
    };

    const created = await store.requestUserErasure(input);
    expect(created).toMatchObject({
      createdAtMs: input.atMs,
      gatedAtMs: input.atMs,
      updatedAtMs: input.atMs,
    });
    expect(await store.getSubjectLifecycle(session.tenantId, "user", session.userId)).toMatchObject({
      state: "deleting",
      createdAtMs: lifecycleAtMs,
      updatedAtMs: lifecycleAtMs,
    });
    expect(await store.requestUserErasure({
      ...input,
      requestId: newErasureRequestId(),
      atMs: input.atMs - 1_000,
    })).toEqual(created);
    expect(await store.listErasureAuditEvents(input.requestId)).toEqual([
      expect.objectContaining({ emittedAtMs: input.atMs }),
    ]);
  });

  it("validates the whole request before publishing any durable-looking state", async () => {
    const store = new MemorySessionStore();
    const input = requestInput("tenant-rollback", "user-rollback");
    await expect(store.requestUserErasure({ ...input, requestedByKeyId: "invalid key" }))
      .rejects.toThrow("invalid erasure actor key id");

    expect(store.subjectLifecycles).toHaveLength(0);
    expect(store.erasureRequests).toHaveLength(0);
    expect(store.erasureAuditEvents).toHaveLength(0);
    expect(await store.getSubjectLifecycle(input.tenantId, "user", input.userId)).toBeNull();
  });

  it("rolls back every gate map when the final idempotency publication fails", async () => {
    const store = new MemorySessionStore();
    const input = requestInput("tenant-publish-rollback", "user-publish-rollback");
    const internals = store as unknown as { erasureIdempotency: Map<string, string> };
    const idempotency = internals.erasureIdempotency;
    const originalSet = idempotency.set.bind(idempotency);
    let fail = true;
    Object.defineProperty(idempotency, "set", {
      configurable: true,
      value: (key: string, value: string) => {
        if (fail) {
          fail = false;
          throw new Error("injected idempotency publication failure");
        }
        return originalSet(key, value);
      },
    });

    await expect(store.requestUserErasure(input))
      .rejects.toThrow("injected idempotency publication failure");
    expect(store.subjectLifecycles).toHaveLength(0);
    expect(store.erasureRequests).toHaveLength(0);
    expect(store.erasureAuditEvents).toHaveLength(0);
    expect(idempotency).toHaveLength(0);

    await expect(store.requestUserErasure(input)).resolves.toMatchObject({
      requestId: input.requestId,
      status: "gated",
    });
    expect(store.subjectLifecycles).toHaveLength(2);
    expect(store.erasureRequests).toHaveLength(1);
    expect(store.erasureAuditEvents).toHaveLength(1);
    expect(idempotency).toHaveLength(1);
  });

  it("linearizes the gate against create, commit and blob writes without crossing owners", async () => {
    const store = new MemorySessionStore();
    const target = mkSession("tenant-race", "target-user");
    const neighbor = mkSession("tenant-race", "neighbor-user");
    await store.createSession(target);
    await store.createSession(neighbor);

    // Model an upload that has already published its ownership manifest but has not yet published
    // the physical-object descriptor. If erasure wins next, the manifest must remain recoverable as
    // staging rather than becoming an owner-readable ready object.
    const interruptedBlobId = newId("blob");
    await store.stageBlob({
      owner: { tenantId: target.tenantId, userId: target.userId },
      sessionId: target.id,
      fence: 1,
      blobId: interruptedBlobId,
      purpose: "tool_output",
      storageBackend: "memory-v1",
      storageFormat: BLOB_STORAGE_FORMAT,
      storageKey: `objects/${interruptedBlobId.slice(5)}`,
      uploadToken: "upload-before-erasure-1234567890",
      createdAtMs: 100,
      stagingExpiresAtMs: 60_100,
    });

    const input = requestInput(target.tenantId, target.userId, "race-key");
    const racedCreate = mkSession(target.tenantId, target.userId);
    const outcomes = await Promise.allSettled([
      store.requestUserErasure(input),
      store.createSession(racedCreate),
      store.commit({ sessionId: target.id, fence: 1, sessionPatch: { title: "late" } }),
    ]);
    expect(outcomes[0]?.status).toBe("fulfilled");
    expect(outcomes[1]).toMatchObject({ status: "rejected", reason: expect.any(SubjectDeletingError) });
    expect(outcomes[2]).toMatchObject({ status: "rejected", reason: expect.any(SessionGoneError) });
    expect(await store.getSessionLifecycle(target.tenantId, target.userId, racedCreate.id)).toBeNull();

    await expect(store.markBlobUploaded({
      owner: { tenantId: target.tenantId, userId: target.userId },
      sessionId: target.id,
      fence: 1,
      blobId: interruptedBlobId,
      uploadToken: "upload-before-erasure-1234567890",
      sha256: "a".repeat(64),
      sizeBytes: 3,
      contentType: "application/json",
      uploadedAtMs: input.atMs,
    })).rejects.toBeInstanceOf(SessionGoneError);
    const interruptedManifest = await store.getBlobManifest(interruptedBlobId);
    expect(interruptedManifest).toMatchObject({ state: "staging" });
    expect(interruptedManifest).not.toHaveProperty("uploadedAtMs");

    await expect(store.stageBlob({
      owner: { tenantId: target.tenantId, userId: target.userId },
      sessionId: target.id,
      fence: 1,
      blobId: newId("blob"),
      purpose: "tool_output",
      storageBackend: "memory-v1",
      storageFormat: BLOB_STORAGE_FORMAT,
      storageKey: `objects/${newId("blob").slice(5)}`,
      uploadToken: "upload-token-1234567890",
      createdAtMs: input.atMs,
      stagingExpiresAtMs: input.atMs + 60_000,
    })).rejects.toBeInstanceOf(SessionGoneError);

    // The same tenant's other user and a different tenant remain fully writable and visible.
    await store.commit({ sessionId: neighbor.id, fence: 1, sessionPatch: { title: "kept" } });
    expect(await store.getSession(neighbor.tenantId, neighbor.id)).toMatchObject({ title: "kept" });
    const outsider = mkSession("tenant-other", target.userId);
    await store.createSession(outsider);
    expect(await store.getSession(outsider.tenantId, outsider.id)).toMatchObject({ id: outsider.id });
  });

  it("derives usage legal hold from persisted tenant or user lifecycle state", async () => {
    const store = new MemorySessionStore();
    const session = mkSession("tenant-held", "user-held");
    await store.createSession(session);
    await store.setLegalHold({
      tenantId: session.tenantId,
      holdId: "hold_tenant_usage",
      subjectKind: "tenant",
      subjectId: session.tenantId,
      reasonCode: "litigation",
      expectedControlGeneration: 0,
      actorKeyId: "legal-admin",
      atMs: 123,
    });

    // This assertion deliberately inspects only the trusted hook integration. Full reconcile and
    // anonymize behavior (including preserving rows) is covered by usage-lifecycle.memory.test.ts.
    const held = (store as unknown as {
      isUsageAnonymizationLegalHoldActive(input: {
        tenantId: string; userId: string; sessionId: string; deletionGeneration: number;
        expectedChecksum: string; nowMs: number; enabled: true;
      }): boolean;
    }).isUsageAnonymizationLegalHoldActive({
      tenantId: session.tenantId,
      userId: session.userId,
      sessionId: session.id,
      deletionGeneration: 1,
      expectedChecksum: "a".repeat(64),
      nowMs: 124,
      enabled: true,
    });
    expect(held).toBe(true);
  });
});
