import { describe, expect, it } from "vitest";
import type { Approval, EventInput, Item, Turn } from "@agent-service/protocol";
import { emptyUsage } from "@agent-service/protocol";
import {
  BLOB_STORAGE_FORMAT,
  BlobStateError,
  MemorySessionStore,
  SessionGoneError,
  sanitizeBlobDeleteError,
} from "../src/index.js";
import { mkSession, newId } from "./conformance.js";

const ownerOf = (session: ReturnType<typeof mkSession>) => ({
  tenantId: session.tenantId,
  userId: session.userId,
});

async function uploadedBlob(
  store: MemorySessionStore,
  session: ReturnType<typeof mkSession>,
  options: { createdAtMs?: number; expiresAtMs?: number; fence?: number; blobId?: string; storageKey?: string } = {},
) {
  const createdAtMs = options.createdAtMs ?? Date.now();
  const blobId = options.blobId ?? newId("blob");
  const uploadToken = `upload-${blobId.slice(5, 29)}`;
  const fence = options.fence ?? 1;
  await store.stageBlob({
    owner: ownerOf(session),
    sessionId: session.id,
    fence,
    blobId,
    purpose: "tool_output",
    storageBackend: "memory-v1",
    storageFormat: BLOB_STORAGE_FORMAT,
    storageKey: options.storageKey ?? `objects/${blobId.slice(5)}`,
    uploadToken,
    createdAtMs,
    stagingExpiresAtMs: options.expiresAtMs ?? createdAtMs + 60_000,
  });
  await store.markBlobUploaded({
    owner: ownerOf(session),
    sessionId: session.id,
    fence,
    blobId,
    uploadToken,
    sha256: "a".repeat(64),
    sizeBytes: 128,
    contentType: "application/json",
    uploadedAtMs: createdAtMs + 1,
  });
  return { blobId, uploadToken, fence };
}

function toolResult(sessionId: string, blobId: string, itemId = newId("item")): Item {
  return {
    id: itemId,
    sessionId,
    turnId: newId("turn"),
    seq: 0,
    status: "completed",
    createdAtMs: Date.now(),
    completedAtMs: Date.now(),
    type: "toolResult",
    toolCallId: "call-1",
    name: "large-output",
    content: [{ type: "text", text: "stored externally" }],
    isError: false,
    outputRef: blobId,
  };
}

function itemEvent(item: Item): EventInput {
  return { type: "item/completed", sessionId: item.sessionId, emittedAtMs: Date.now(), item };
}

async function bindToolOutput(
  store: MemorySessionStore,
  session: ReturnType<typeof mkSession>,
  blobId: string,
  item = toolResult(session.id, blobId),
  fence = 1,
) {
  await store.commit({
    sessionId: session.id,
    fence,
    items: [item],
    blobBindings: [{ blobId, itemId: item.id, purpose: "tool_output" }],
    events: [itemEvent(item)],
  });
  return item;
}

describe("MemorySessionStore blob lifecycle", () => {
  it("atomically binds an uploaded manifest to its item and exposes it only through owner-scoped lookup", async () => {
    const store = new MemorySessionStore();
    const session = mkSession("tenant_blob", "user_blob");
    await store.createSession(session);
    const uploaded = await uploadedBlob(store, session);

    expect(await store.getBindableBlob({
      owner: ownerOf(session), sessionId: session.id, blobId: uploaded.blobId, purpose: "tool_output",
    })).toMatchObject({ state: "staging", uploadedAtMs: expect.any(Number) });
    expect(await store.getBlobManifest(uploaded.blobId)).not.toHaveProperty("itemId");

    const item = await bindToolOutput(store, session, uploaded.blobId);
    expect(item.seq).toBe(2);
    expect(await store.getBlobManifest(uploaded.blobId)).toMatchObject({
      state: "ready",
      itemId: item.id,
      readyAtMs: expect.any(Number),
      deletionGeneration: 0,
    });
    expect(await store.getReadyBlob({
      owner: ownerOf(session), sessionId: session.id, blobId: uploaded.blobId, itemId: item.id, purpose: "tool_output",
    })).toMatchObject({ blobId: uploaded.blobId, itemId: item.id, state: "ready" });
    expect(await store.getReadyBlob({
      owner: { tenantId: session.tenantId, userId: "another-user" },
      sessionId: session.id,
      blobId: uploaded.blobId,
    })).toBeNull();
  });

  it("treats the staging deadline as a hard bind boundary and leaves the expired object cleanable", async () => {
    const store = new MemorySessionStore();
    const session = mkSession("tenant_blob_expired", "user_blob_expired");
    await store.createSession(session);
    const now = Date.now();
    const uploaded = await uploadedBlob(store, session, {
      createdAtMs: now - 60_000,
      expiresAtMs: now - 1_000,
    });

    expect(await store.getBindableBlob({
      owner: ownerOf(session), sessionId: session.id, blobId: uploaded.blobId, purpose: "tool_output",
    })).toBeNull();

    const item = toolResult(session.id, uploaded.blobId);
    await expect(bindToolOutput(store, session, uploaded.blobId, item)).rejects.toBeInstanceOf(BlobStateError);
    expect(await store.getItem(session.id, item.id)).toBeNull();
    expect(await store.readEvents(session.id, 0, 10)).toHaveLength(1);
    expect(await store.getBlobManifest(uploaded.blobId)).toMatchObject({
      state: "staging",
      stagingExpiresAtMs: now - 1_000,
    });

    expect(await store.scheduleStaleBlobDeletes({ nowMs: now, limit: 10 })).toBe(1);
    expect(await store.getBlobManifest(uploaded.blobId)).toMatchObject({
      state: "delete_pending",
      deletionGeneration: 1,
    });
    expect(await store.getBlobDeleteOutbox(uploaded.blobId, 1)).toMatchObject({
      blobId: uploaded.blobId,
      generation: 1,
    });
  });

  it("keeps ownership and storage-key identities isolated across tenants and users", async () => {
    const store = new MemorySessionStore();
    const first = mkSession("tenant_a", "user_a");
    const second = mkSession("tenant_b", "user_b");
    await store.createSession(first);
    await store.createSession(second);
    const uploaded = await uploadedBlob(store, first);
    const manifest = await store.getBlobManifest(uploaded.blobId);

    await expect(store.markBlobUploaded({
      owner: ownerOf(second),
      sessionId: first.id,
      fence: 2,
      blobId: uploaded.blobId,
      uploadToken: uploaded.uploadToken,
      sha256: "a".repeat(64),
      sizeBytes: 128,
      contentType: "application/json",
      uploadedAtMs: Date.now(),
    })).rejects.toBeInstanceOf(SessionGoneError);
    expect(await store.getBindableBlob({
      owner: ownerOf(second), sessionId: first.id, blobId: uploaded.blobId, purpose: "tool_output",
    })).toBeNull();

    const foreignItem = toolResult(second.id, uploaded.blobId);
    await expect(bindToolOutput(store, second, uploaded.blobId, foreignItem)).rejects.toBeInstanceOf(BlobStateError);
    expect(await store.getItem(second.id, foreignItem.id)).toBeNull();
    expect(await store.readEvents(second.id, 0, 10)).toHaveLength(1);

    const collidingBlobId = newId("blob");
    await expect(store.stageBlob({
      owner: ownerOf(second),
      sessionId: second.id,
      fence: 1,
      blobId: collidingBlobId,
      purpose: "tool_output",
      storageBackend: "memory-v1",
      storageFormat: BLOB_STORAGE_FORMAT,
      storageKey: manifest!.storageKey,
      uploadToken: `upload-${collidingBlobId.slice(5, 29)}`,
      createdAtMs: Date.now(),
      stagingExpiresAtMs: Date.now() + 60_000,
    })).rejects.toBeInstanceOf(BlobStateError);
    expect(await store.getBlobManifest(collidingBlobId)).toBeNull();
    expect(await store.getSession(second.tenantId, second.id)).toMatchObject({ fenceToken: 0, lastSeq: 1 });
  });

  it("linearizes binding before cleanup so a ready blob cannot be swept", async () => {
    const store = new MemorySessionStore();
    const session = mkSession();
    await store.createSession(session);
    const createdAtMs = Date.now();
    const expiresAtMs = createdAtMs + 10;
    const uploaded = await uploadedBlob(store, session, { createdAtMs, expiresAtMs });

    const item = await bindToolOutput(store, session, uploaded.blobId);
    expect(await store.scheduleStaleBlobDeletes({ nowMs: expiresAtMs, limit: 10 })).toBe(0);
    expect(await store.getBlobManifest(uploaded.blobId)).toMatchObject({ state: "ready", itemId: item.id });
    expect(await store.getBlobDeleteOutbox(uploaded.blobId, 1)).toBeNull();
  });

  it("linearizes cleanup before binding and rolls the losing item commit back", async () => {
    const store = new MemorySessionStore();
    const session = mkSession();
    await store.createSession(session);
    const createdAtMs = Date.now();
    const expiresAtMs = createdAtMs + 10;
    const uploaded = await uploadedBlob(store, session, { createdAtMs, expiresAtMs });
    const item = toolResult(session.id, uploaded.blobId);

    expect(await store.scheduleStaleBlobDeletes({ nowMs: expiresAtMs, limit: 10 })).toBe(1);
    await expect(bindToolOutput(store, session, uploaded.blobId, item)).rejects.toBeInstanceOf(BlobStateError);
    expect(await store.getItem(session.id, item.id)).toBeNull();
    expect(await store.readEvents(session.id, 0, 10)).toHaveLength(1);
    expect(await store.getSession(session.tenantId, session.id)).toMatchObject({ lastSeq: 1, fenceToken: 1 });

    const [first, second] = await Promise.all([
      store.claimBlobDeletes({ nowMs: expiresAtMs, limit: 1, leaseMs: 100, claimToken: "worker-a" }),
      store.claimBlobDeletes({ nowMs: expiresAtMs, limit: 1, leaseMs: 100, claimToken: "worker-b" }),
    ]);
    expect([first.length, second.length].sort()).toEqual([0, 1]);
    const claimed = (first[0] ?? second[0])!;
    expect(await store.completeBlobDelete(claimed.outboxId, claimed.claimToken!, expiresAtMs + 1)).toBe(true);
    expect(await store.getBlobManifest(uploaded.blobId)).toMatchObject({
      state: "deleted",
      deletedAtMs: expiresAtMs + 1,
      deletionGeneration: 1,
    });
    expect(await store.getBlobManifest(uploaded.blobId)).not.toHaveProperty("sha256");
    expect(await store.getBlobDeleteOutbox(uploaded.blobId, 1)).toMatchObject({
      attempts: 1,
      completedAtMs: expiresAtMs + 1,
    });
  });

  it("leaves the manifest, event log, fence and item untouched when a blob-bearing commit fails", async () => {
    const store = new MemorySessionStore();
    const session = mkSession();
    await store.createSession(session);
    const uploaded = await uploadedBlob(store, session);
    const item = toolResult(session.id, uploaded.blobId);
    const metadata = {} as Record<string, unknown>;
    Object.defineProperty(metadata, "invalid", {
      enumerable: true,
      get: () => { throw new Error("injected blob commit serialization failure"); },
    });

    await expect(store.commit({
      sessionId: session.id,
      fence: 2,
      items: [item],
      blobBindings: [{ blobId: uploaded.blobId, itemId: item.id, purpose: "tool_output" }],
      events: [itemEvent(item)],
      sessionPatch: { metadata },
    })).rejects.toThrow("injected blob commit serialization failure");
    expect(await store.getBlobManifest(uploaded.blobId)).toMatchObject({ state: "staging" });
    expect(await store.getBlobManifest(uploaded.blobId)).not.toHaveProperty("itemId");
    expect(await store.getItem(session.id, item.id)).toBeNull();
    expect(await store.readEvents(session.id, 0, 10)).toHaveLength(1);
    expect(await store.getSession(session.tenantId, session.id)).toMatchObject({ fenceToken: 1, lastSeq: 1 });
    expect(item.seq).toBe(0);

    await expect(store.commit({
      sessionId: session.id,
      fence: 2,
      items: [item],
      blobBindings: [],
      events: [itemEvent(item)],
    })).rejects.toThrow("blob bindings must exactly match");
    expect(await store.getBlobManifest(uploaded.blobId)).toMatchObject({ state: "staging" });
  });

  it("rejects global item, turn and approval identity collisions before mutating another session", async () => {
    const store = new MemorySessionStore();
    const first = mkSession("tenant_a", "user_a");
    const second = mkSession("tenant_b", "user_b");
    await store.createSession(first);
    await store.createSession(second);
    const item: Item = {
      id: newId("item"), sessionId: first.id, turnId: newId("turn"), seq: 0,
      status: "completed", createdAtMs: 1, type: "userMessage", content: [{ type: "text", text: "first" }],
    };
    const turn: Turn = {
      id: newId("turn"), sessionId: first.id, status: "inProgress", seqStart: 2,
      steps: 0, toolCalls: 0, usage: emptyUsage(), startedAtMs: 1,
    };
    const approval: Approval = {
      id: newId("apr"), sessionId: first.id, turnId: turn.id, itemId: item.id,
      status: "pending", toolCallId: "call", toolName: "danger", args: {},
      availableDecisions: ["accept", "decline"], createdAtMs: 1, expiresAtMs: 10,
    };
    await store.commit({ sessionId: first.id, fence: 1, items: [item], turn, approvals: [approval] });

    const foreignItem = { ...item, sessionId: second.id, turnId: newId("turn"), seq: 0 };
    await expect(store.commit({ sessionId: second.id, fence: 1, items: [foreignItem] }))
      .rejects.toThrow("item identity conflicts");
    await expect(store.commit({ sessionId: second.id, fence: 1, turn: { ...turn, sessionId: second.id } }))
      .rejects.toThrow("turn identity conflicts");
    await expect(store.commit({
      sessionId: second.id,
      fence: 1,
      approvals: [{ ...approval, sessionId: second.id, turnId: newId("turn"), itemId: newId("item") }],
    })).rejects.toThrow("approval identity conflicts");

    expect(await store.getSession(second.tenantId, second.id)).toMatchObject({ fenceToken: 0, lastSeq: 1 });
    expect(await store.getItem(first.id, item.id)).toMatchObject({ sessionId: first.id, content: item.content });
    expect(await store.getTurn(first.id, turn.id)).toMatchObject({ sessionId: first.id });
    expect(await store.getApproval(first.id, approval.id)).toMatchObject({ sessionId: first.id });
  });
});

describe("sanitizeBlobDeleteError", () => {
  it("redacts real errno-style POSIX, Windows and UNC paths while preserving useful error context", () => {
    const posix = sanitizeBlobDeleteError(new Error(
      "ENOENT: no such file or directory, unlink '/Users/alice/agent data/blobs/objects/blob_123'",
    ));
    expect(posix).toContain("Error: ENOENT: no such file or directory, unlink '[redacted-path]'");
    expect(posix).not.toContain("/Users/alice");

    const windows = sanitizeBlobDeleteError(new Error(
      "EPERM: operation not permitted, unlink 'C:\\Users\\alice\\agent data\\blob_123'",
    ));
    expect(windows).toContain("Error: EPERM: operation not permitted, unlink '[redacted-path]'");
    expect(windows).not.toContain("C:\\Users\\alice");

    const unc = sanitizeBlobDeleteError("EACCES opening \\\\server\\private-share\\blob_123");
    expect(unc).toBe("EACCES opening [redacted-path]");
  });

  it("redacts locators and credentials without swallowing ordinary status text or fractions", () => {
    const safe = sanitizeBlobDeleteError(new Error(
      "backend HTTP 503 retry 2/3 authorization=Bearer super-secret token=another-secret",
    ));
    expect(safe).toContain("Error: backend HTTP 503 retry 2/3");
    expect(safe).toContain("authorization=[redacted]");
    expect(safe).toContain("token=[redacted]");
    expect(safe).not.toContain("super-secret");
    expect(safe).not.toContain("another-secret");
  });
});
