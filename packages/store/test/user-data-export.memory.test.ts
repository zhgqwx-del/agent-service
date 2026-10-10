import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  emptyUsage,
  type Approval,
  type Item,
  type Session,
  type Turn,
} from "@agent-service/protocol";
import {
  BLOB_STORAGE_FORMAT,
  EMPTY_USER_DATA_EXPORT_SNAPSHOT_ROOT_SHA256,
  MemorySessionStore,
  SubjectDeletingError,
  USER_DATA_EXPORT_CONTENT_TYPE,
  USER_DATA_EXPORT_RECORD_KIND_ORDER,
  UserDataExportIntegrityError,
  UserDataExportPolicyUnavailableError,
  UserDataExportStateError,
  canonicalUserDataExportBytes,
  newErasureRequestId,
  newUsageId,
  newUserDataExportArtifactId,
  newUserDataExportRequestId,
  nextUserDataExportSnapshotRootSha256,
  subjectLifecycleKey,
  userDataExportAttachmentLogicalKey,
  userDataExportAuthorization,
  userDataExportIdempotencyKeySha256,
  userDataExportManifestSha256,
  userDataExportRequestHash,
  userDataExportStorageKey,
  userErasureRequestHash,
  type RequestUserDataExportInput,
  type RetentionPolicyDocumentV1,
  type UserDataExportAuthorization,
  type UserDataExportSnapshotBlob,
  type UserDataExportSnapshotRecord,
  type UserDataExportSnapshotSummary,
} from "../src/index.js";
import { mkSession, newId } from "./conformance.js";

const BASE = Date.UTC(2026, 9, 9, 12);
const EXPORT_TTL_MS = 1_000;

function policy(exportArtifactTtlMs: number | null): RetentionPolicyDocumentV1 {
  return {
    sessionContentRetentionMs: 30 * 24 * 60 * 60 * 1_000,
    userErasureGraceMs: 7 * 24 * 60 * 60 * 1_000,
    operationalUsageRetentionMs: null,
    idempotencyReceiptRetentionMs: 24 * 60 * 60 * 1_000,
    billingFactRetentionMs: null,
    lifecycleAuditRetentionMs: null,
    exportArtifactTtlMs,
  };
}

function harness(atMs = BASE + 100) {
  let now = atMs;
  return {
    store: new MemorySessionStore({ now: () => now }),
    now: () => now,
    setNow: (next: number) => { now = next; },
    advance: (deltaMs: number) => { now += deltaMs; },
  };
}

async function activatePolicy(
  store: MemorySessionStore,
  tenantId: string,
  exportArtifactTtlMs: number | null = EXPORT_TTL_MS,
  policyVersion = "policy-export-v1",
) {
  const version = await store.putRetentionPolicy({
    tenantId,
    policyVersion,
    policy: policy(exportArtifactTtlMs),
    actorKeyId: "policy-admin",
    atMs: BASE,
  });
  await store.activateRetentionPolicy({
    tenantId,
    policyVersion,
    expectedControlGeneration: 0,
    actorKeyId: "policy-admin",
    atMs: BASE + 1,
  });
  return version;
}

function exportInput(
  tenantId: string,
  userId: string,
  idempotencyKey: string,
  requestId = newUserDataExportRequestId(),
): RequestUserDataExportInput {
  return {
    requestId,
    tenantId,
    userId,
    requestedByKeyId: "export-admin",
    idempotencyKeySha256: userDataExportIdempotencyKeySha256(idempotencyKey),
    requestHash: userDataExportRequestHash(tenantId, userId),
  };
}

async function claimOne(
  store: MemorySessionStore,
  claimToken = "export-worker-0001",
  leaseMs = 100,
): Promise<UserDataExportAuthorization> {
  const claims = await store.claimUserDataExports({ limit: 1, leaseMs, claimToken });
  if (!claims[0]) throw new Error("expected one export claim");
  return userDataExportAuthorization(claims[0]);
}

function sessionAt(tenantId: string, userId: string, atMs: number): Session {
  return { ...mkSession(tenantId, userId), createdAtMs: atMs, updatedAtMs: atMs };
}

async function seedAttachmentGraph(
  store: MemorySessionStore,
  session: Session,
  atMs: number,
) {
  const turn: Turn = {
    id: newId("turn"),
    sessionId: session.id,
    status: "inProgress",
    seqStart: 2,
    steps: 1,
    toolCalls: 1,
    usage: emptyUsage(),
    startedAtMs: atMs,
    idempotencyKey: "must-not-be-exported",
    metadata: { safe: "turn metadata" },
  };
  await store.commit({
    sessionId: session.id,
    fence: 1,
    turn,
    usageEntries: [{
      usageId: newUsageId(),
      turnId: turn.id,
      step: 1,
      provider: "provider-a",
      model: "model-a",
      usage: { ...emptyUsage(), inputTokens: 2, outputTokens: 1, totalTokens: 3 },
      createdAtMs: atMs,
    }],
    events: [{ type: "turn/started", sessionId: session.id, emittedAtMs: atMs, turn }],
  });

  const blobId = newId("blob");
  const uploadToken = `upload-${blobId.slice(5, 29)}`;
  const storageKey = `objects/${blobId.slice(5)}`;
  await store.stageBlob({
    owner: { tenantId: session.tenantId, userId: session.userId },
    sessionId: session.id,
    fence: 1,
    blobId,
    purpose: "tool_output",
    storageBackend: "memory-v1",
    storageFormat: BLOB_STORAGE_FORMAT,
    storageKey,
    uploadToken,
    createdAtMs: atMs + 1,
    stagingExpiresAtMs: atMs + 10_000,
  });
  await store.markBlobUploaded({
    owner: { tenantId: session.tenantId, userId: session.userId },
    sessionId: session.id,
    fence: 1,
    blobId,
    uploadToken,
    sha256: "a".repeat(64),
    sizeBytes: 128,
    contentType: "application/json",
    uploadedAtMs: atMs + 2,
  });

  const item: Item = {
    id: newId("item"),
    sessionId: session.id,
    turnId: turn.id,
    seq: 0,
    step: 1,
    status: "completed",
    createdAtMs: atMs + 3,
    completedAtMs: atMs + 3,
    type: "toolResult",
    toolCallId: "call-export",
    name: "large-output",
    content: [{ type: "text", text: "stored externally" }],
    isError: false,
    outputRef: blobId,
  };
  const approval: Approval = {
    id: newId("apr"),
    sessionId: session.id,
    turnId: turn.id,
    itemId: item.id,
    status: "pending",
    toolCallId: item.toolCallId,
    toolName: item.name,
    args: { reason: "exercise export" },
    availableDecisions: ["accept", "decline"],
    createdAtMs: atMs + 3,
    expiresAtMs: atMs + 60_000,
  };
  await store.commit({
    sessionId: session.id,
    fence: 1,
    items: [item],
    approvals: [approval],
    blobBindings: [{ blobId, itemId: item.id, purpose: "tool_output" }],
    events: [{ type: "item/completed", sessionId: session.id, emittedAtMs: atMs + 3, item }],
  });
  return { turn, item, approval, blobId, storageKey, uploadToken };
}

async function readAllRecords(
  store: MemorySessionStore,
  authorization: UserDataExportAuthorization,
) {
  const rows: UserDataExportSnapshotRecord[] = [];
  let afterOrdinal: number | undefined;
  do {
    const page = await store.readUserDataExportSnapshotRecords(authorization, {
      ...(afterOrdinal === undefined ? {} : { afterOrdinal }),
      limit: 2,
    });
    rows.push(...page.data);
    afterOrdinal = page.nextOrdinal ?? undefined;
    if (page.nextOrdinal === null) break;
  } while (true);
  return rows;
}

async function readAllBlobs(
  store: MemorySessionStore,
  authorization: UserDataExportAuthorization,
) {
  const rows: UserDataExportSnapshotBlob[] = [];
  let afterOrdinal: number | undefined;
  do {
    const page = await store.readUserDataExportSnapshotBlobs(authorization, {
      ...(afterOrdinal === undefined ? {} : { afterOrdinal }),
      limit: 1,
    });
    rows.push(...page.data);
    afterOrdinal = page.nextOrdinal ?? undefined;
    if (page.nextOrdinal === null) break;
  } while (true);
  return rows;
}

async function publishSinglePartArtifact(
  store: MemorySessionStore,
  authorization: UserDataExportAuthorization,
  summary: UserDataExportSnapshotSummary,
) {
  const artifactId = newUserDataExportArtifactId();
  const startInput = {
    artifactId,
    storageBackend: "memory-v1",
    storageFormat: BLOB_STORAGE_FORMAT,
    stagingTtlMs: 500,
  };
  const artifact = await store.startUserDataExportArtifact(authorization, startInput);
  const storageKey = userDataExportStorageKey(
    { tenantId: authorization.tenantId, userId: authorization.userId },
    authorization.requestId,
    artifactId,
    0,
  );
  const uploadToken = "export-part-upload-0001";
  await store.stageUserDataExportPart(authorization, {
    artifactId,
    partNumber: 0,
    storageBackend: artifact.storageBackend,
    storageFormat: artifact.storageFormat,
    storageKey,
    uploadToken,
  });
  const bytes = Buffer.from("deterministic export artifact", "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const part = await store.markUserDataExportPartUploaded(authorization, {
    artifactId,
    partNumber: 0,
    descriptor: {
      storageKey,
      sha256,
      sizeBytes: bytes.byteLength,
      contentType: USER_DATA_EXPORT_CONTENT_TYPE,
    },
  });
  const manifestSha256 = userDataExportManifestSha256([part]);
  const request = await store.completeUserDataExportArtifact(authorization, {
    artifactId,
    snapshotAtMs: summary.snapshotAtMs,
    partCount: 1,
    recordCount: summary.recordCount,
    totalSizeBytes: bytes.byteLength,
    contentSha256: sha256,
    manifestSha256,
  });
  return { artifactId, storageKey, uploadToken, sha256, part, request, startInput };
}

function erasureInput(tenantId: string, userId: string, atMs: number, idempotencyKey: string) {
  return {
    requestId: newErasureRequestId(),
    tenantId,
    userId,
    requestedByKeyId: "erasure-admin",
    idempotencyKey,
    requestHash: userErasureRequestHash(tenantId, userId),
    atMs,
  };
}

describe("MemorySessionStore user data export", () => {
  it("requires an active positive-TTL policy and isolates idempotency by tenant and user", async () => {
    const missing = harness();
    await expect(missing.store.requestUserDataExport(exportInput(
      "tenant-export-missing",
      "user-export-missing",
      "same-key",
    ))).rejects.toBeInstanceOf(UserDataExportPolicyUnavailableError);

    for (const [suffix, ttl] of [["null", null], ["zero", 0]] as const) {
      const invalid = harness();
      const tenantId = `tenant-export-${suffix}`;
      await activatePolicy(invalid.store, tenantId, ttl, `policy-${suffix}`);
      await expect(invalid.store.requestUserDataExport(exportInput(
        tenantId,
        `user-export-${suffix}`,
        "same-key",
      ))).rejects.toBeInstanceOf(UserDataExportPolicyUnavailableError);
      expect(invalid.store.userDataExportRequests).toHaveLength(0);
      expect(invalid.store.userDataExportJobs).toHaveLength(0);
    }

    const { store } = harness();
    const tenantId = "tenant-export-idempotency";
    await activatePolicy(store, tenantId);
    const firstInput = exportInput(tenantId, "user-a", "same-key");
    const [first, replay] = await Promise.all([
      store.requestUserDataExport(firstInput),
      store.requestUserDataExport({ ...firstInput, requestId: newUserDataExportRequestId() }),
    ]);
    expect(replay).toEqual(first);
    expect(store.userDataExportRequests).toHaveLength(1);
    expect(store.userDataExportJobs).toHaveLength(1);

    await expect(store.requestUserDataExport({
      ...firstInput,
      requestId: newUserDataExportRequestId(),
      requestHash: "f".repeat(64),
    })).rejects.toThrow("data export request hash does not match its subject");

    const otherUser = await store.requestUserDataExport(exportInput(tenantId, "user-b", "same-key"));
    await activatePolicy(store, "tenant-export-other");
    const otherTenant = await store.requestUserDataExport(exportInput(
      "tenant-export-other",
      "user-a",
      "same-key",
    ));
    expect(new Set([first.requestId, otherUser.requestId, otherTenant.requestId]).size).toBe(3);
    await expect(store.getUserDataExport(tenantId, "user-b", first.requestId)).resolves.toBeNull();
    await expect(store.getUserDataExport("tenant-export-other", "user-a", first.requestId))
      .resolves.toBeNull();
  });

  it("rolls admission back completely when request/job publication fails", async () => {
    const { store } = harness();
    const tenantId = "tenant-export-admission-rollback";
    const userId = "user-export-admission-rollback";
    await activatePolicy(store, tenantId);
    const input = exportInput(tenantId, userId, "admission-rollback");
    const jobs = store.userDataExportJobs;
    const originalSet = jobs.set.bind(jobs);
    let fail = true;
    Object.defineProperty(jobs, "set", {
      configurable: true,
      value: (key: string, value: unknown) => {
        if (fail) {
          fail = false;
          throw new Error("injected export job publication failure");
        }
        return originalSet(key, value as never);
      },
    });
    await expect(store.requestUserDataExport(input))
      .rejects.toThrow("injected export job publication failure");
    Reflect.deleteProperty(jobs, "set");

    expect(store.userDataExportRequests).toHaveLength(0);
    expect(store.userDataExportJobs).toHaveLength(0);
    expect(await store.getSubjectLifecycle(tenantId, "tenant", tenantId)).toBeNull();
    expect(await store.getSubjectLifecycle(tenantId, "user", userId)).toBeNull();
    await expect(store.requestUserDataExport(input)).resolves.toMatchObject({
      requestId: input.requestId,
      subjectGeneration: 0,
      status: "queued",
    });
  });

  it("seals a canonical owner snapshot containing active, archived, tombstoned and attachment data", async () => {
    const { store, now } = harness();
    const tenantId = "tenant-export-snapshot";
    const userId = "user-export-snapshot";
    await activatePolicy(store, tenantId);
    const storageNamespaceSha256 = "b".repeat(64);
    await store.activateBlobStorageControl({
      expectedControlGeneration: 0,
      storageBackend: "memory-v1",
      namespaceSha256: storageNamespaceSha256,
    });
    const active = sessionAt(tenantId, userId, BASE - 500);
    const archived = sessionAt(tenantId, userId, BASE - 400);
    const tombstoned = sessionAt(tenantId, userId, BASE - 300);
    const neighbor = sessionAt(tenantId, "user-export-neighbor", BASE - 200);
    for (const session of [active, archived, tombstoned, neighbor]) await store.createSession(session);
    const graph = await seedAttachmentGraph(store, active, BASE - 100);
    const archivedAtMs = BASE - 50;
    await store.commit({
      sessionId: archived.id,
      fence: 1,
      lifecycle: { type: "archive", tenantId, userId, atMs: archivedAtMs },
      events: [{ type: "session/archived", sessionId: archived.id, emittedAtMs: archivedAtMs }],
    });
    const deletedAtMs = BASE - 25;
    await store.commit({
      sessionId: tombstoned.id,
      fence: 1,
      lifecycle: {
        type: "tombstone",
        tenantId,
        userId,
        deletionGeneration: 1,
        atMs: deletedAtMs,
      },
      events: [{
        type: "session/deleted",
        sessionId: tombstoned.id,
        deletionGeneration: 1,
        emittedAtMs: deletedAtMs,
      }],
    });

    const request = await store.requestUserDataExport(exportInput(tenantId, userId, "snapshot"));
    const authorization = await claimOne(store);
    const summary = await store.captureAndSealUserDataExportSnapshot(authorization);
    expect(summary.snapshotAtMs).toBe(now());
    expect(summary.counts).toMatchObject({
      session: 3,
      turn: 1,
      item: 1,
      approval: 1,
      operational_usage: 1,
      attachment: 1,
    });

    const records = await readAllRecords(store, authorization);
    const blobs = await readAllBlobs(store, authorization);
    expect(records.map((record) => record.ordinal)).toEqual(records.map((_, index) => index));
    expect(blobs.map((blob) => blob.ordinal)).toEqual([0]);
    expect(summary.recordCount).toBe(records.length + blobs.length);
    const kindOrder = new Map(USER_DATA_EXPORT_RECORD_KIND_ORDER.map((kind, index) => [kind, index]));
    expect(records).toEqual([...records].sort((left, right) => (
      kindOrder.get(left.kind)! - kindOrder.get(right.kind)!
      || (left.logicalKey < right.logicalKey ? -1 : left.logicalKey > right.logicalKey ? 1 : 0)
    )));

    const decoded = records.map((record) => {
      expect(Buffer.isBuffer(record.canonicalBytes)).toBe(true);
      const canonicalBytes = Buffer.from(record.canonicalBytes);
      expect(record.sha256).toBe(createHash("sha256").update(canonicalBytes).digest("hex"));
      expect(record.sizeBytes).toBe(canonicalBytes.byteLength);
      const entry = JSON.parse(canonicalBytes.toString("utf8")) as {
        type: string;
        value: Record<string, unknown>;
      };
      expect(canonicalBytes).toEqual(canonicalUserDataExportBytes(entry as never));
      return entry;
    });
    const sessions = decoded.filter((entry) => entry.type === "session").map((entry) => entry.value);
    expect(sessions.map((session) => session.id)).toEqual(
      [active.id, archived.id, tombstoned.id].sort((left, right) => left < right ? -1 : 1),
    );
    expect(sessions.find((session) => session.id === archived.id)).toMatchObject({ archivedAtMs });
    expect(sessions.find((session) => session.id === tombstoned.id)).toMatchObject({ deletedAtMs });
    expect(sessions.some((session) => session.id === neighbor.id)).toBe(false);

    const blob = blobs[0]!;
    expect(blob).toMatchObject({
      blobId: graph.blobId,
      sessionId: active.id,
      itemId: graph.item.id,
      purpose: "tool_output",
      sha256: "a".repeat(64),
      sizeBytes: 128,
      storageNamespaceSha256,
    });
    const publicAttachment = {
      blobId: blob.blobId,
      sessionId: blob.sessionId,
      ...(blob.itemId === undefined ? {} : { itemId: blob.itemId }),
      purpose: blob.purpose,
      ...(blob.contentType === undefined ? {} : { contentType: blob.contentType }),
      sha256: blob.sha256,
      sizeBytes: blob.sizeBytes,
    };
    expect(Object.keys(publicAttachment)).not.toEqual(expect.arrayContaining([
      "storageKey",
      "sourceUploadToken",
      "pinToken",
    ]));
    const publicSurface = JSON.stringify({ decoded, attachment: publicAttachment });
    for (const forbidden of [
      "idempotencyKey",
      "must-not-be-exported",
      "fenceToken",
      "contextEpoch",
      "usageId",
      graph.storageKey,
      graph.uploadToken,
      "sourceUploadToken",
      "pinToken",
    ]) expect(publicSurface).not.toContain(forbidden);

    let root = EMPTY_USER_DATA_EXPORT_SNAPSHOT_ROOT_SHA256;
    for (const record of records) {
      root = nextUserDataExportSnapshotRootSha256(
        root,
        record.kind,
        record.logicalKey,
        record.sha256,
        record.sizeBytes,
      );
    }
    const attachmentBytes = canonicalUserDataExportBytes({
      type: "attachment",
      value: publicAttachment,
    });
    root = nextUserDataExportSnapshotRootSha256(
      root,
      "attachment",
      userDataExportAttachmentLogicalKey(publicAttachment),
      createHash("sha256").update(attachmentBytes).digest("hex"),
      attachmentBytes.byteLength,
    );
    expect(root).toBe(summary.snapshotRootSha256);
    expect(store.userDataExportRequests.get(request.requestId)).toMatchObject({
      snapshotAtMs: now(),
      status: "building",
    });
  });

  it("publishes no snapshot on serialization or final multi-map publication failure", async () => {
    const serialization = harness();
    const tenantId = "tenant-export-serialization";
    const userId = "user-export-serialization";
    await activatePolicy(serialization.store, tenantId);
    const session = sessionAt(tenantId, userId, BASE);
    await serialization.store.createSession(session);
    const request = await serialization.store.requestUserDataExport(exportInput(
      tenantId,
      userId,
      "serialization",
    ));
    const authorization = await claimOne(serialization.store);
    serialization.store.sessions.get(session.id)!.metadata = { unsupported: 1n };
    await expect(serialization.store.captureAndSealUserDataExportSnapshot(authorization))
      .rejects.toBeInstanceOf(UserDataExportIntegrityError);
    expect(serialization.store.userDataExportSnapshotRecords.has(request.requestId)).toBe(false);
    expect(serialization.store.userDataExportSnapshotBlobs.has(request.requestId)).toBe(false);
    expect(serialization.store.userDataExportJobs.get(request.requestId)).not.toHaveProperty("snapshot");
    expect(serialization.store.userDataExportRequests.get(request.requestId)).not.toHaveProperty("snapshotAtMs");
    serialization.store.sessions.get(session.id)!.metadata = {};
    await expect(serialization.store.captureAndSealUserDataExportSnapshot(authorization))
      .resolves.toMatchObject({ snapshotAtMs: serialization.now() });

    const publication = harness();
    const publishTenant = "tenant-export-publication";
    const publishUser = "user-export-publication";
    await activatePolicy(publication.store, publishTenant);
    await publication.store.createSession(sessionAt(publishTenant, publishUser, BASE));
    const publishRequest = await publication.store.requestUserDataExport(exportInput(
      publishTenant,
      publishUser,
      "publication",
    ));
    const publishAuthorization = await claimOne(publication.store);
    const jobs = publication.store.userDataExportJobs;
    const originalSet = jobs.set.bind(jobs);
    let fail = true;
    Object.defineProperty(jobs, "set", {
      configurable: true,
      value: (key: string, value: unknown) => {
        if (fail) {
          fail = false;
          throw new Error("injected snapshot seal publication failure");
        }
        return originalSet(key, value as never);
      },
    });
    await expect(publication.store.captureAndSealUserDataExportSnapshot(publishAuthorization))
      .rejects.toThrow("injected snapshot seal publication failure");
    Reflect.deleteProperty(jobs, "set");
    expect(publication.store.userDataExportSnapshotRecords.has(publishRequest.requestId)).toBe(false);
    expect(publication.store.userDataExportSnapshotBlobs.has(publishRequest.requestId)).toBe(false);
    expect(publication.store.userDataExportJobs.get(publishRequest.requestId)).not.toHaveProperty("snapshot");
    expect(publication.store.userDataExportRequests.get(publishRequest.requestId))
      .not.toHaveProperty("snapshotAtMs");
    await expect(publication.store.captureAndSealUserDataExportSnapshot(publishAuthorization))
      .resolves.toMatchObject({ snapshotAtMs: publication.now() });
  });

  it("fences concurrent claims and token ABA while a sealed crash retry preserves its build", async () => {
    const { store, advance } = harness();
    const tenantId = "tenant-export-claim";
    const userId = "user-export-claim";
    await activatePolicy(store, tenantId);
    await store.createSession(sessionAt(tenantId, userId, BASE));
    await store.requestUserDataExport(exportInput(tenantId, userId, "claim"));

    const [left, right] = await Promise.all([
      store.claimUserDataExports({ limit: 1, leaseMs: 10, claimToken: "worker-a" }),
      store.claimUserDataExports({ limit: 1, leaseMs: 10, claimToken: "worker-b" }),
    ]);
    expect([left.length, right.length].sort()).toEqual([0, 1]);
    const first = (left[0] ?? right[0])!;
    const firstAuthorization = userDataExportAuthorization(first);
    expect(first).toMatchObject({ buildGeneration: 1, claimAttempt: 1 });

    advance(10);
    expect(await store.renewUserDataExportClaim(firstAuthorization, 10)).toBe(false);
    const second = (await store.claimUserDataExports({
      limit: 1,
      leaseMs: 10,
      claimToken: first.claimToken,
    }))[0]!;
    expect(second).toMatchObject({ buildGeneration: 2, claimAttempt: 2, claimToken: first.claimToken });
    const secondAuthorization = userDataExportAuthorization(second);
    await expect(store.captureAndSealUserDataExportSnapshot(firstAuthorization))
      .rejects.toBeInstanceOf(UserDataExportStateError);
    const summary = await store.captureAndSealUserDataExportSnapshot(secondAuthorization);
    const artifactId = newUserDataExportArtifactId();
    const startInput = {
      artifactId,
      storageBackend: "memory-v1",
      storageFormat: BLOB_STORAGE_FORMAT,
      stagingTtlMs: 100,
    };
    const artifact = await store.startUserDataExportArtifact(secondAuthorization, startInput);

    advance(10);
    const third = (await store.claimUserDataExports({
      limit: 1,
      leaseMs: 10,
      claimToken: first.claimToken,
    }))[0]!;
    expect(third).toMatchObject({ buildGeneration: 2, claimAttempt: 3, claimToken: first.claimToken });
    const thirdAuthorization = userDataExportAuthorization(third);
    expect(await store.renewUserDataExportClaim(secondAuthorization, 10)).toBe(false);
    await expect(store.captureAndSealUserDataExportSnapshot(thirdAuthorization)).resolves.toEqual(summary);
    await expect(store.startUserDataExportArtifact(thirdAuthorization, startInput)).resolves.toEqual(artifact);
    await expect(store.stageUserDataExportPart(secondAuthorization, {
      artifactId,
      partNumber: 0,
      storageBackend: "memory-v1",
      storageFormat: BLOB_STORAGE_FORMAT,
      storageKey: userDataExportStorageKey(
        { tenantId: secondAuthorization.tenantId, userId: secondAuthorization.userId },
        secondAuthorization.requestId,
        artifactId,
        0,
      ),
      uploadToken: "stale-upload-token-0001",
    })).rejects.toBeInstanceOf(UserDataExportStateError);
  });

  it("publishes a ready artifact atomically and honors TTL download leases before cleanup", async () => {
    const { store, now, setNow } = harness();
    const tenantId = "tenant-export-download";
    const userId = "user-export-download";
    await activatePolicy(store, tenantId, 100);
    await store.createSession(sessionAt(tenantId, userId, BASE));
    const request = await store.requestUserDataExport(exportInput(tenantId, userId, "download"));
    const authorization = await claimOne(store, "download-builder", 1_000);
    const summary = await store.captureAndSealUserDataExportSnapshot(authorization);
    const published = await publishSinglePartArtifact(store, authorization, summary);
    expect(published.request).toMatchObject({
      status: "ready",
      readyAtMs: now(),
      expiresAtMs: now() + 100,
      artifactSha256: published.sha256,
    });
    expect(store.userDataExportSnapshotRecords.has(request.requestId)).toBe(false);

    setNow(published.request.readyAtMs! + 90);
    const download = await store.acquireUserDataExportDownload(
      tenantId,
      userId,
      request.requestId,
      "download-lease-0001",
      60,
    );
    expect(download).toMatchObject({
      leaseUntilMs: published.request.readyAtMs! + 150,
      artifact: { artifactId: published.artifactId, state: "ready" },
      parts: [{ partNumber: 0, state: "uploaded", storageKey: published.storageKey }],
    });
    await expect(store.acquireUserDataExportDownload(
      tenantId,
      "another-user",
      request.requestId,
      "foreign-download",
      60,
    )).resolves.toBeNull();

    setNow(published.request.expiresAtMs!);
    expect(await store.scheduleUserDataExportDeletes(10)).toBe(0);
    expect(store.userDataExportArtifacts.get(published.artifactId)).toMatchObject({ state: "ready" });
    expect(await store.renewUserDataExportDownload(
      published.artifactId,
      "download-lease-0001",
      60,
    )).toBe(true);
    await store.releaseUserDataExportDownload(published.artifactId, "download-lease-0001");
    expect(await store.scheduleUserDataExportDeletes(10)).toBe(1);
    expect(await store.getUserDataExport(tenantId, userId, request.requestId)).toMatchObject({
      status: "expired",
    });
    expect(store.userDataExportArtifacts.get(published.artifactId)).toMatchObject({
      state: "delete_pending",
      deletionGeneration: 1,
    });
    await expect(store.acquireUserDataExportDownload(
      tenantId,
      userId,
      request.requestId,
      "after-expiry",
      60,
    )).resolves.toBeNull();
  });

  it("treats staging TTL as an orphan cutoff while an active build claim completes", async () => {
    const { store, advance } = harness();
    const tenantId = "tenant-export-staging-cutoff";
    const userId = "user-export-staging-cutoff";
    await activatePolicy(store, tenantId);
    await store.createSession(sessionAt(tenantId, userId, BASE));
    await store.requestUserDataExport(exportInput(tenantId, userId, "staging-cutoff"));
    const authorization = await claimOne(store, "staging-cutoff-builder", 1_000);
    const summary = await store.captureAndSealUserDataExportSnapshot(authorization);
    const artifactId = newUserDataExportArtifactId();
    const artifact = await store.startUserDataExportArtifact(authorization, {
      artifactId,
      storageBackend: "memory-v1",
      storageFormat: BLOB_STORAGE_FORMAT,
      stagingTtlMs: 10,
    });
    advance(20);
    expect(await store.scheduleUserDataExportDeletes(10)).toBe(0);

    const storageKey = userDataExportStorageKey(
      { tenantId, userId },
      authorization.requestId,
      artifactId,
      0,
    );
    await store.stageUserDataExportPart(authorization, {
      artifactId,
      partNumber: 0,
      storageBackend: artifact.storageBackend,
      storageFormat: artifact.storageFormat,
      storageKey,
      uploadToken: "staging-cutoff-upload-0001",
    });
    const bytes = Buffer.from("active build survives its orphan cutoff", "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const part = await store.markUserDataExportPartUploaded(authorization, {
      artifactId,
      partNumber: 0,
      descriptor: {
        storageKey,
        sha256,
        sizeBytes: bytes.byteLength,
        contentType: USER_DATA_EXPORT_CONTENT_TYPE,
      },
    });
    await expect(store.completeUserDataExportArtifact(authorization, {
      artifactId,
      snapshotAtMs: summary.snapshotAtMs,
      partCount: 1,
      recordCount: summary.recordCount,
      totalSizeBytes: bytes.byteLength,
      contentSha256: sha256,
      manifestSha256: userDataExportManifestSha256([part]),
    })).resolves.toMatchObject({ status: "ready" });
  });

  it("keeps repeated download acquisition monotonic and caps one live lease at ten minutes", async () => {
    const { store, now, setNow } = harness();
    const tenantId = "tenant-export-download-cap";
    const userId = "user-export-download-cap";
    await activatePolicy(store, tenantId, 20 * 60_000);
    await store.createSession(sessionAt(tenantId, userId, BASE));
    const request = await store.requestUserDataExport(exportInput(tenantId, userId, "download-cap"));
    const authorization = await claimOne(store, "download-cap-builder", 1_000);
    const summary = await store.captureAndSealUserDataExportSnapshot(authorization);
    await publishSinglePartArtifact(store, authorization, summary);
    const createdAtMs = now();
    const first = await store.acquireUserDataExportDownload(
      tenantId,
      userId,
      request.requestId,
      "download-cap-lease",
      60_000,
    );
    expect(first?.leaseUntilMs).toBe(createdAtMs + 60_000);

    setNow(createdAtMs + 10_000);
    expect(await store.renewUserDataExportDownload(
      first!.artifact.artifactId,
      "download-cap-lease",
      1,
    )).toBe(true);
    expect([...store.userDataExportDownloadLeases.values()][0]?.leaseUntilMs)
      .toBe(first?.leaseUntilMs);
    const replay = await store.acquireUserDataExportDownload(
      tenantId,
      userId,
      request.requestId,
      "download-cap-lease",
      1,
    );
    expect(replay?.leaseUntilMs).toBe(first?.leaseUntilMs);

    for (let elapsedMs = 50_000; elapsedMs <= 550_000; elapsedMs += 50_000) {
      setNow(createdAtMs + elapsedMs);
      await expect(store.acquireUserDataExportDownload(
        tenantId,
        userId,
        request.requestId,
        "download-cap-lease",
        60_000,
      )).resolves.not.toBeNull();
    }
    setNow(createdAtMs + 9 * 60_000 + 50_000);
    const capped = await store.acquireUserDataExportDownload(
      tenantId,
      userId,
      request.requestId,
      "download-cap-lease",
      60_000,
    );
    expect(capped?.leaseUntilMs).toBe(createdAtMs + 10 * 60_000);
  });

  it("rejects corrupted ready owner and deterministic part identity before leasing a download", async () => {
    const { store } = harness();
    const tenantId = "tenant-export-corrupt-download";
    const userId = "user-export-corrupt-download";
    await activatePolicy(store, tenantId);
    await store.createSession(sessionAt(tenantId, userId, BASE));
    const request = await store.requestUserDataExport(exportInput(
      tenantId,
      userId,
      "corrupt-download",
    ));
    const authorization = await claimOne(store, "corrupt-download-builder", 1_000);
    const summary = await store.captureAndSealUserDataExportSnapshot(authorization);
    const published = await publishSinglePartArtifact(store, authorization, summary);
    const part = [...store.userDataExportParts.values()][0]!;

    part.storageKey = userDataExportStorageKey(
      { tenantId, userId: "neighbor-user" },
      request.requestId,
      published.artifactId,
      0,
    );
    await expect(store.acquireUserDataExportDownload(
      tenantId,
      userId,
      request.requestId,
      "corrupt-key-lease",
      60,
    )).rejects.toBeInstanceOf(UserDataExportIntegrityError);
    expect(store.userDataExportDownloadLeases).toHaveLength(0);

    part.storageKey = published.storageKey;
    const artifact = store.userDataExportArtifacts.get(published.artifactId)!;
    artifact.subjectGeneration += 1;
    await expect(store.acquireUserDataExportDownload(
      tenantId,
      userId,
      request.requestId,
      "corrupt-owner-lease",
      60,
    )).rejects.toBeInstanceOf(UserDataExportIntegrityError);
    expect(store.userDataExportDownloadLeases).toHaveLength(0);
  });

  it("uses lease and generation CAS for delete takeover, stale ACK and lost-ACK replay", async () => {
    const { store, advance } = harness();
    const tenantId = "tenant-export-delete";
    const userId = "user-export-delete";
    await activatePolicy(store, tenantId, 10);
    await store.createSession(sessionAt(tenantId, userId, BASE));
    await store.requestUserDataExport(exportInput(tenantId, userId, "delete"));
    const authorization = await claimOne(store, "delete-builder", 1_000);
    const summary = await store.captureAndSealUserDataExportSnapshot(authorization);
    const published = await publishSinglePartArtifact(store, authorization, summary);
    advance(10);
    expect(await store.scheduleUserDataExportDeletes(10)).toBe(1);

    const first = (await store.claimUserDataExportDeletes({
      limit: 1,
      leaseMs: 10,
      claimToken: "delete-worker-a",
    }))[0]!;
    expect(first).toMatchObject({ attempts: 1, deletionGeneration: 1 });
    advance(10);
    const second = (await store.claimUserDataExportDeletes({
      limit: 1,
      leaseMs: 10,
      claimToken: "delete-worker-b",
    }))[0]!;
    expect(second).toMatchObject({
      outboxId: first.outboxId,
      attempts: 2,
      deletionGeneration: first.deletionGeneration,
    });
    expect(await store.completeUserDataExportDelete(first.outboxId, "delete-worker-a")).toBe(false);
    expect(await store.retryUserDataExportDelete(first.outboxId, "delete-worker-a", {
      delayMs: 0,
      error: new Error("stale"),
    })).toBe(false);
    expect(await store.completeUserDataExportDelete(second.outboxId, "delete-worker-b")).toBe(true);
    // A response can be lost after commit; the replay must not mutate the completed generation.
    expect(await store.completeUserDataExportDelete(second.outboxId, "delete-worker-b")).toBe(false);
    expect(await store.claimUserDataExportDeletes({
      limit: 1,
      leaseMs: 10,
      claimToken: "delete-after-complete",
    })).toEqual([]);
    expect(store.userDataExportArtifacts.get(published.artifactId)).toMatchObject({
      state: "deleted",
      deletionGeneration: 1,
    });
    expect([...store.userDataExportParts.values()]).toEqual([
      expect.objectContaining({ state: "deleted", deletionGeneration: 1 }),
    ]);
  });

  it("orders erasure against export and rolls both sides back if revocation publication fails", async () => {
    const erasureFirst = harness();
    const tenantId = "tenant-export-erasure-first";
    const userId = "user-export-erasure-first";
    await activatePolicy(erasureFirst.store, tenantId);
    await erasureFirst.store.requestUserErasure(erasureInput(
      tenantId,
      userId,
      erasureFirst.now(),
      "erasure-first",
    ));
    await expect(erasureFirst.store.requestUserDataExport(exportInput(
      tenantId,
      userId,
      "must-be-rejected",
    ))).rejects.toBeInstanceOf(SubjectDeletingError);
    expect(erasureFirst.store.userDataExportRequests).toHaveLength(0);

    const exportFirst = harness();
    const exportTenant = "tenant-export-erasure-second";
    const exportUser = "user-export-erasure-second";
    await activatePolicy(exportFirst.store, exportTenant);
    await exportFirst.store.createSession(sessionAt(exportTenant, exportUser, BASE));
    const exportRequest = await exportFirst.store.requestUserDataExport(exportInput(
      exportTenant,
      exportUser,
      "export-first",
    ));
    const authorization = await claimOne(exportFirst.store, "erasure-builder", 1_000);
    const summary = await exportFirst.store.captureAndSealUserDataExportSnapshot(authorization);
    const published = await publishSinglePartArtifact(exportFirst.store, authorization, summary);
    await exportFirst.store.acquireUserDataExportDownload(
      exportTenant,
      exportUser,
      exportRequest.requestId,
      "revoked-download",
      60,
    );

    const erasure = erasureInput(
      exportTenant,
      exportUser,
      exportFirst.now(),
      "export-first-erasure",
    );
    const outbox = exportFirst.store.userDataExportDeleteOutbox;
    const originalSet = outbox.set.bind(outbox);
    let fail = true;
    Object.defineProperty(outbox, "set", {
      configurable: true,
      value: (key: string, value: unknown) => {
        if (fail) {
          fail = false;
          throw new Error("injected export revocation outbox failure");
        }
        return originalSet(key, value as never);
      },
    });
    await expect(exportFirst.store.requestUserErasure(erasure))
      .rejects.toThrow("injected export revocation outbox failure");
    Reflect.deleteProperty(outbox, "set");

    expect(await exportFirst.store.getSubjectLifecycle(exportTenant, "user", exportUser))
      .toMatchObject({ state: "active", generation: 0 });
    expect(await exportFirst.store.getUserErasureRequest(
      exportTenant,
      exportUser,
      erasure.requestId,
    )).toBeNull();
    expect(exportFirst.store.userDataExportRequests.get(exportRequest.requestId))
      .toMatchObject({ status: "ready", currentArtifactId: published.artifactId });
    expect(exportFirst.store.userDataExportArtifacts.get(published.artifactId))
      .toMatchObject({ state: "ready", deletionGeneration: 0 });
    expect([...exportFirst.store.userDataExportParts.values()])
      .toEqual([expect.objectContaining({ state: "uploaded", deletionGeneration: 0 })]);
    expect(exportFirst.store.userDataExportDeleteOutbox).toHaveLength(0);
    expect(await exportFirst.store.renewUserDataExportDownload(
      published.artifactId,
      "revoked-download",
      60,
    )).toBe(true);

    await expect(exportFirst.store.requestUserErasure(erasure)).resolves.toMatchObject({
      requestId: erasure.requestId,
      status: "gated",
    });
    expect(exportFirst.store.subjectLifecycles.get(subjectLifecycleKey(
      exportTenant,
      "user",
      exportUser,
    ))).toMatchObject({ state: "deleting", generation: 1 });
    expect(exportFirst.store.userDataExportRequests.get(exportRequest.requestId))
      .toMatchObject({ status: "revoked" });
    expect(exportFirst.store.userDataExportArtifacts.get(published.artifactId))
      .toMatchObject({ state: "delete_pending", deletionGeneration: 1 });
    expect(exportFirst.store.userDataExportDeleteOutbox).toHaveLength(1);
    expect(await exportFirst.store.renewUserDataExportDownload(
      published.artifactId,
      "revoked-download",
      60,
    )).toBe(false);
    await expect(exportFirst.store.acquireUserDataExportDownload(
      exportTenant,
      exportUser,
      exportRequest.requestId,
      "after-revocation",
      60,
    )).resolves.toBeNull();
  });
});
