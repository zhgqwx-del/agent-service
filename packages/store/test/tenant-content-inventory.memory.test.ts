import { randomUUID } from "node:crypto";
import {
  DEFAULT_AUTH_POLICY,
  emptyUsage,
  tenantRuntimeFleetSha256,
  tenantRuntimeLocalReceiptSha256,
  tenantRuntimeTargetReceiptsSha256,
  tenantRuntimeTargetSha256,
  type Approval,
  type Item,
  type TenantRuntimeRevocationFleetProof,
  type Turn,
} from "@agent-service/protocol";
import { describe, expect, it } from "vitest";
import {
  MemorySessionStore,
  TenantContentInventoryEvidenceChangedError,
  TenantErasureIntegrityError,
  newErasureRequestId,
  tenantContentInventoryReceiptSha256,
  tenantContentInventorySessionReceiptRootSha256,
  tenantErasureRequestHash,
  tenantSessionContentReceiptSha256,
  validateTenantContentInventoryCompletionProof,
  validateTenantContentInventoryJobRecord,
  type RetentionPolicyDocumentV1,
  type TenantContentInventoryAuthorization,
  type TenantCredentialRevocationAuthorization,
  type TenantRuntimeRevocationAuthorization,
} from "../src/index.js";
import { mkSession, newId } from "./conformance.js";

function omitReceiptSha256<T extends { receiptSha256: string }>(
  value: T,
): Omit<T, "receiptSha256"> {
  const { receiptSha256, ...body } = value;
  void receiptSha256;
  return body;
}

function policy(contentRetentionMs: number | null): RetentionPolicyDocumentV1 {
  return {
    sessionContentRetentionMs: contentRetentionMs,
    userErasureGraceMs: 0,
    operationalUsageRetentionMs: null,
    idempotencyReceiptRetentionMs: null,
    billingFactRetentionMs: null,
    lifecycleAuditRetentionMs: null,
    exportArtifactTtlMs: 60_000,
  };
}

function credentialAuthorization(
  claim: Awaited<ReturnType<MemorySessionStore["claimTenantCredentialRevocations"]>>[number],
): TenantCredentialRevocationAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function runtimeAuthorization(
  claim: Awaited<ReturnType<MemorySessionStore["claimTenantRuntimeRevocations"]>>[number],
): TenantRuntimeRevocationAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function inventoryAuthorization(
  claim: Awaited<ReturnType<MemorySessionStore["claimTenantContentInventories"]>>[number],
): TenantContentInventoryAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    buildGeneration: claim.buildGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function fleetProof(
  source: { requestId: string; tenantId: string; subjectGeneration: number; t3aReceiptSha256: string },
): TenantRuntimeRevocationFleetProof {
  const body = {
    targetSha256: tenantRuntimeTargetSha256("http://runner-1.internal:8080"),
    runnerId: "runner-1",
    bootId: "boot-1",
    requestId: source.requestId,
    tenantId: source.tenantId,
    subjectGeneration: source.subjectGeneration,
    t3aReceiptSha256: source.t3aReceiptSha256,
    cacheEntryCountBefore: 1,
    cacheEntryCountAfter: 0 as const,
    activeOperationCountBefore: 1,
    activeOperationCountAfter: 0 as const,
    activeTurnCountBefore: 1,
    activeTurnCountAfter: 0 as const,
    completedAtMs: 900,
  };
  const targets = [{ ...body, receiptSha256: tenantRuntimeLocalReceiptSha256(body) }];
  return {
    fleetSha256: tenantRuntimeFleetSha256(targets),
    targetReceiptsSha256: tenantRuntimeTargetReceiptsSha256(targets),
    targets,
  };
}

async function installPolicy(
  store: MemorySessionStore,
  tenantId: string,
  contentRetentionMs: number | null,
): Promise<void> {
  await store.putRetentionPolicy({
    tenantId,
    policyVersion: "policy-v1",
    policy: policy(contentRetentionMs),
    actorKeyId: "policy-admin",
    atMs: 10,
  });
  await store.activateRetentionPolicy({
    tenantId,
    policyVersion: "policy-v1",
    expectedControlGeneration: 0,
    actorKeyId: "policy-admin",
    atMs: 11,
  });
}

async function createRichSession(
  store: MemorySessionStore,
  tenantId: string,
  userId: string,
  parentSessionId?: string,
) {
  const session = { ...mkSession(tenantId, userId), ...(parentSessionId ? { parentSessionId } : {}) };
  await store.createSession(session);
  const turn: Turn = {
    id: newId("turn"),
    sessionId: session.id,
    status: "inProgress",
    seqStart: 2,
    steps: 1,
    toolCalls: 0,
    usage: emptyUsage(),
    startedAtMs: 20,
  };
  const approvalId = newId("apr");
  const item: Item = {
    id: newId("item"),
    sessionId: session.id,
    turnId: turn.id,
    seq: 0,
    step: 1,
    status: "completed",
    createdAtMs: 21,
    completedAtMs: 22,
    type: "approvalRequest",
    approvalId,
    toolCallId: "private-tool-call",
    name: "private-tool",
    args: { secret: "never-in-receipt" },
  };
  const approval: Approval = {
    id: approvalId,
    sessionId: session.id,
    turnId: turn.id,
    // Legacy writers did not consistently point this field at the approvalRequest item. The
    // canonical durable association is item.approvalId -> approval.id.
    itemId: newId("item"),
    status: "pending",
    toolCallId: "private-tool-call",
    toolName: "private-tool",
    args: { secret: "never-in-receipt" },
    availableDecisions: ["accept", "decline"],
    createdAtMs: 22,
    expiresAtMs: 1_000,
  };
  await store.commit({
    sessionId: session.id,
    fence: 1,
    turn,
    items: [item],
    approvals: [approval],
    events: [
      { type: "turn/started", sessionId: session.id, emittedAtMs: 20, turn },
      { type: "item/completed", sessionId: session.id, emittedAtMs: 21, item },
      { type: "approval/requested", sessionId: session.id, emittedAtMs: 22, approval },
    ],
  });
  return { session, turn, item, approval };
}

async function createEvolvedSession(
  store: MemorySessionStore,
  tenantId: string,
  userId: string,
) {
  const session = mkSession(tenantId, userId);
  await store.createSession(session);
  const turn: Turn = {
    id: newId("turn"),
    sessionId: session.id,
    status: "inProgress",
    seqStart: 2,
    steps: 1,
    toolCalls: 0,
    usage: emptyUsage(),
    startedAtMs: 20,
  };
  const approvalId = newId("apr");
  const item: Item = {
    id: newId("item"),
    sessionId: session.id,
    turnId: turn.id,
    seq: 0,
    step: 1,
    status: "inProgress",
    createdAtMs: 20,
    type: "approvalRequest",
    approvalId,
    toolCallId: "normal-tool-call",
    name: "normal-tool",
    args: {},
  };
  const approval: Approval = {
    id: approvalId,
    sessionId: session.id,
    turnId: turn.id,
    itemId: newId("item"),
    status: "pending",
    toolCallId: "normal-tool-call",
    toolName: "normal-tool",
    args: {},
    availableDecisions: ["accept", "decline"],
    createdAtMs: 20,
    expiresAtMs: 1_000,
  };
  await store.commit({
    sessionId: session.id,
    fence: 1,
    turn,
    items: [item],
    approvals: [approval],
    events: [
      { type: "turn/started", sessionId: session.id, emittedAtMs: 20, turn },
      { type: "item/started", sessionId: session.id, emittedAtMs: 20, item },
      { type: "approval/requested", sessionId: session.id, emittedAtMs: 20, approval },
    ],
  });
  const completedItem: Item = { ...item, status: "completed", completedAtMs: 21 };
  const resolvedApproval: Approval = {
    ...approval,
    status: "resolved",
    decision: "accept",
    decidedBy: "normal-operator",
    resolvedAtMs: 21,
  };
  const completedTurn: Turn = {
    ...turn,
    status: "completed",
    stopReason: "end_turn",
    completedAtMs: 21,
  };
  await store.commit({
    sessionId: session.id,
    fence: 1,
    turn: completedTurn,
    items: [completedItem],
    approvals: [resolvedApproval],
    events: [
      { type: "item/completed", sessionId: session.id, emittedAtMs: 21, item: completedItem },
      {
        type: "approval/resolved",
        sessionId: session.id,
        emittedAtMs: 21,
        approval: resolvedApproval,
      },
      {
        type: "turn/completed",
        sessionId: session.id,
        emittedAtMs: 21,
        turn: completedTurn,
        stopReason: "end_turn",
      },
    ],
  });
  return { session, turn: completedTurn, item: completedItem, approval: resolvedApproval };
}

async function createStandaloneCompaction(
  store: MemorySessionStore,
  tenantId: string,
  userId: string,
) {
  const session = mkSession(tenantId, userId);
  await store.createSession(session);
  const item: Item = {
    id: newId("item"),
    sessionId: session.id,
    turnId: newId("turn"),
    seq: 0,
    status: "completed",
    createdAtMs: 30,
    completedAtMs: 30,
    type: "contextCompaction",
    replacesUpToSeq: 1,
    summary: "private compaction summary",
    usageSnapshot: emptyUsage(),
  };
  await store.commit({
    sessionId: session.id,
    fence: 1,
    items: [item],
    events: [
      { type: "item/completed", sessionId: session.id, emittedAtMs: 30, item },
      { type: "session/compacted", sessionId: session.id, emittedAtMs: 30, itemId: item.id },
    ],
    sessionPatch: { lastCompactionSeq: 1 },
  });
  return { session, item };
}

async function advanceThroughT3b(
  store: MemorySessionStore,
  tenantId: string,
  contentRetentionMs: number | null | undefined,
  requestId = newErasureRequestId(),
  beforeRuntimeCompletion?: () => void,
) {
  await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
  if (contentRetentionMs !== undefined) {
    await installPolicy(store, tenantId, contentRetentionMs);
  }
  const request = {
    requestId,
    tenantId,
    requestedByKeyId: "platform-lifecycle-admin",
    idempotencyKey: `content-${randomUUID()}`,
    requestHash: tenantErasureRequestHash(tenantId),
    atMs: 100,
  };
  await store.requestTenantErasure(request);
  const credentialClaim = (await store.claimTenantCredentialRevocations({
    limit: 10,
    leaseMs: 10_000,
    claimToken: `credential-${tenantId}`,
  })).find((claim) => claim.requestId === request.requestId)!;
  const credentialReceipt = await store.revokeTenantCredentialMaterial(
    credentialAuthorization(credentialClaim),
  );
  expect(credentialReceipt).not.toBeNull();
  beforeRuntimeCompletion?.();
  expect(await store.materializeTenantRuntimeRevocationJobs({ limit: 10 })).toBe(1);
  const runtimeClaim = (await store.claimTenantRuntimeRevocations({
    limit: 10,
    leaseMs: 10_000,
    claimToken: `runtime-${tenantId}`,
  })).find((claim) => claim.requestId === request.requestId)!;
  const runtimeReceipt = await store.completeTenantRuntimeRevocation(
    runtimeAuthorization(runtimeClaim),
    fleetProof(runtimeClaim),
  );
  expect(runtimeReceipt).not.toBeNull();
  return { request, credentialReceipt: credentialReceipt!, runtimeReceipt: runtimeReceipt! };
}

describe("MemorySessionStore tenant content inventory", () => {
  it("uses a trusted retention anchor, scans every content owner page, and seals content-free proof", async () => {
    let nowMs = 1_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    const tenantId = "tenant-content-success";
    await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
    await installPolicy(store, tenantId, 100);
    const first = await createRichSession(store, tenantId, "user-private");
    const second = { ...mkSession(tenantId, "user-private"), parentSessionId: first.session.id };
    await store.createSession(second);
    const neighbor = mkSession("tenant-content-neighbor", "neighbor-user");
    await store.createSession(neighbor);

    const request = {
      requestId: newErasureRequestId(),
      tenantId,
      requestedByKeyId: "platform-lifecycle-admin",
      idempotencyKey: `content-${randomUUID()}`,
      requestHash: tenantErasureRequestHash(tenantId),
      atMs: 7,
    };
    await store.requestTenantErasure(request);
    const credentialClaim = (await store.claimTenantCredentialRevocations({
      limit: 10,
      leaseMs: 10_000,
      claimToken: "credential-success",
    }))[0]!;
    await store.revokeTenantCredentialMaterial(credentialAuthorization(credentialClaim));
    await store.materializeTenantRuntimeRevocationJobs({ limit: 10 });
    const runtimeClaim = (await store.claimTenantRuntimeRevocations({
      limit: 10,
      leaseMs: 10_000,
      claimToken: "runtime-success",
    }))[0]!;
    await store.completeTenantRuntimeRevocation(
      runtimeAuthorization(runtimeClaim),
      fleetProof(runtimeClaim),
    );

    const sourceBefore = structuredClone({
      sessions: [...store.sessions.entries()],
      turns: [...store.turns.entries()],
      items: [...store.items.entries()],
      approvals: [...store.approvals.entries()],
      events: [...store.events.entries()],
    });
    nowMs = 5_000;
    expect(await store.materializeTenantContentInventoryJobs({ limit: 10 })).toBe(1);
    expect(await store.materializeTenantContentInventoryJobs({ limit: 10 })).toBe(0);
    expect(await store.getTenantContentInventoryJob(tenantId, request.requestId)).toMatchObject({
      retentionAnchorDbMs: 5_000,
      contentNotBeforeDbMs: 5_100,
      phase: "queued",
      sessionReceiptCount: 0,
    });
    const [claim] = await store.claimTenantContentInventories({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "inventory-success",
    });
    const authorization = inventoryAuthorization(claim!);
    expect(await store.buildTenantContentInventoryPage(authorization, { limit: 1 }))
      .toMatchObject({ built: 1, done: false, sessionReceiptCount: 1 });
    expect(await store.buildTenantContentInventoryPage(authorization, { limit: 1 }))
      .toMatchObject({ built: 1, done: true, sessionReceiptCount: 2 });
    const sessionReceipts = await store.getTenantSessionContentReceipts(
      tenantId,
      request.requestId,
      1,
    );
    expect(sessionReceipts).toHaveLength(2);
    expect(sessionReceipts.reduce((sum, receipt) => sum + receipt.contentRecordCount, 0)).toBe(10);
    const serializedReceipts = JSON.stringify(sessionReceipts);
    expect(serializedReceipts).not.toContain("user-private");
    expect(serializedReceipts).not.toContain("private-body");
    expect(serializedReceipts).not.toContain("private-tool");
    expect(serializedReceipts).not.toContain("secret");

    nowMs = 5_099;
    await expect(store.sealTenantContentInventory(authorization))
      .rejects.toMatchObject({ reason: "deadline_not_reached" });
    nowMs = 5_100;
    const receipt = await store.sealTenantContentInventory(authorization);
    expect(receipt).toMatchObject({
      tenantId,
      retentionAnchorDbMs: 5_000,
      contentNotBeforeDbMs: 5_100,
      storeDbTimestampMs: 5_100,
      sessionReceiptCount: 2,
      contentRecordCount: 10,
      globalOrphanCheck: "passed",
      contentInventoryComplete: true,
      contentPurgeExecuted: false,
    });
    expect(await store.sealTenantContentInventory(authorization)).toEqual(receipt);
    expect(await store.sealTenantContentInventory({
      ...authorization,
      claimToken: "wrong-response-replay-token",
    })).toBeNull();
    expect(await store.getTenantContentInventoryReceipt(tenantId, request.requestId))
      .toEqual(receipt);
    expect(await store.getTenantContentInventoryReceipt("tenant-content-neighbor", request.requestId))
      .toBeNull();
    expect(await store.getTenantSessionContentReceipts(
      "tenant-content-neighbor",
      request.requestId,
      1,
    )).toEqual([]);
    expect({
      sessions: [...store.sessions.entries()],
      turns: [...store.turns.entries()],
      items: [...store.items.entries()],
      approvals: [...store.approvals.entries()],
      events: [...store.events.entries()],
    }).toEqual(sourceBefore);

    if (!receipt) throw new Error("expected a sealed tenant content inventory receipt");
    const sealedJob = await store.getTenantContentInventoryJob(tenantId, request.requestId);
    if (!sealedJob || sealedJob.phase !== "inventory_sealed") {
      throw new Error("expected a sealed tenant content inventory job");
    }
    const staleSessionBody = {
      ...omitReceiptSha256(sessionReceipts[0]!),
      capturedAtDbMs: sealedJob.retentionAnchorDbMs - 1,
    };
    const staleSessionReceipt = {
      ...staleSessionBody,
      receiptSha256: tenantSessionContentReceiptSha256(staleSessionBody),
    };
    const staleSessionReceipts = [staleSessionReceipt, ...sessionReceipts.slice(1)];
    const staleSessionRoot = tenantContentInventorySessionReceiptRootSha256(
      staleSessionReceipts,
    );
    const staleAggregateBody = {
      ...omitReceiptSha256(receipt),
      sessionReceiptRootSha256: staleSessionRoot,
    };
    const staleAggregate = {
      ...staleAggregateBody,
      receiptSha256: tenantContentInventoryReceiptSha256(staleAggregateBody),
    };
    const staleJob = {
      ...sealedJob,
      sessionReceiptRootSha256: staleSessionRoot,
      aggregateReceiptSha256: staleAggregate.receiptSha256,
    };
    expect(() => validateTenantContentInventoryCompletionProof(
      staleJob,
      staleSessionReceipts,
      staleAggregate,
    )).toThrow(/source binding is inconsistent/);
  });

  it("accepts normal resource evolution and publishes nothing while the trusted clock is pre-anchor", async () => {
    let nowMs = 1_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    const tenantId = "tenant-content-normal-history";
    await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
    await installPolicy(store, tenantId, 0);
    await createEvolvedSession(store, tenantId, "history-user");
    const source = await advanceThroughExistingPolicyT3b(store, tenantId);
    expect(await store.materializeTenantContentInventoryJobs({ limit: 10 })).toBe(1);
    const [claim] = await store.claimTenantContentInventories({
      limit: 1,
      leaseMs: 10_000,
      claimToken: "normal-history-inventory",
    });
    const authorization = inventoryAuthorization(claim!);
    nowMs = 999;
    await expect(store.buildTenantContentInventoryPage(authorization, { limit: 10 }))
      .rejects.toMatchObject({ reason: "trusted_clock_before_anchor" });
    expect(store.tenantSessionContentReceipts.size).toBe(0);
    expect(store.tenantContentInventoryJobs.get(source.request.requestId)).toMatchObject({
      sessionReceiptCount: 0,
      scanComplete: false,
    });
    expect(store.tenantContentInventoryJobs.get(source.request.requestId)?.cursorSessionId)
      .toBeUndefined();
    nowMs = 1_000;
    expect(await store.buildTenantContentInventoryPage(authorization, { limit: 10 }))
      .toMatchObject({ built: 1, done: true });
    expect(await store.sealTenantContentInventory(authorization))
      .toMatchObject({ tenantId, contentInventoryComplete: true });
  });

  it("waits for the maximum T3a/T3b source clock without starving a healthy neighbor", async () => {
    let highT3bNowMs = 1_000;
    const highT3bStore = new MemorySessionStore({ now: () => highT3bNowMs });
    const highT3b = await advanceThroughT3b(
      highT3bStore,
      "tenant-content-high-t3b-clock",
      0,
      "erase_00000000-0000-4000-8000-000000000021",
      () => { highT3bNowMs = 2_000; },
    );
    highT3bNowMs = 1_500;
    const healthy = await advanceThroughT3b(
      highT3bStore,
      "tenant-content-clock-healthy-neighbor",
      0,
      "erase_ffffffff-ffff-4fff-bfff-fffffffffff2",
    );
    highT3bNowMs = 1_999;
    await expect(highT3bStore.materializeTenantContentInventoryJobs({ limit: 1 }))
      .rejects.toMatchObject({ reason: "trusted_clock_before_source" });
    expect(highT3bStore.tenantContentInventoryJobs.has(highT3b.request.requestId)).toBe(false);
    expect(highT3bStore.tenantContentInventoryJobs.get(healthy.request.requestId)).toMatchObject({
      phase: "queued",
      retentionAnchorDbMs: 1_999,
    });
    expect(highT3bStore.tenantSessionContentReceipts.size).toBe(0);
    expect(highT3bStore.tenantContentInventoryReceipts.size).toBe(0);
    highT3bNowMs = 2_000;
    expect(await highT3bStore.materializeTenantContentInventoryJobs({ limit: 1 })).toBe(1);
    expect(highT3bStore.tenantContentInventoryJobs.get(highT3b.request.requestId))
      .toMatchObject({ retentionAnchorDbMs: 2_000 });

    let highT3aNowMs = 4_000;
    const highT3aStore = new MemorySessionStore({ now: () => highT3aNowMs });
    const highT3a = await advanceThroughT3b(
      highT3aStore,
      "tenant-content-high-t3a-clock",
      0,
      newErasureRequestId(),
      () => { highT3aNowMs = 3_000; },
    );
    expect(highT3a.credentialReceipt.storeDbTimestampMs).toBe(4_000);
    expect(highT3a.runtimeReceipt.storeDbTimestampMs).toBe(3_000);
    highT3aNowMs = 3_500;
    await expect(highT3aStore.materializeTenantContentInventoryJobs({ limit: 1 }))
      .rejects.toMatchObject({ reason: "trusted_clock_before_source" });
    expect(highT3aStore.tenantContentInventoryJobs.size).toBe(0);
    expect(highT3aStore.tenantSessionContentReceipts.size).toBe(0);
    expect(highT3aStore.tenantContentInventoryReceipts.size).toBe(0);
    highT3aNowMs = 4_000;
    expect(await highT3aStore.materializeTenantContentInventoryJobs({ limit: 1 })).toBe(1);
    expect(highT3aStore.tenantContentInventoryJobs.get(highT3a.request.requestId))
      .toMatchObject({ retentionAnchorDbMs: 4_000 });
  });

  it("seals a canonical standalone context-compaction item without a turns row", async () => {
    const store = new MemorySessionStore({ now: () => 5_000 });
    const tenantId = "tenant-content-standalone-compaction";
    await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
    await installPolicy(store, tenantId, 0);
    const compacted = await createStandaloneCompaction(store, tenantId, "compaction-user");
    expect(store.turns.has(compacted.item.turnId)).toBe(false);
    const source = await advanceThroughExistingPolicyT3b(store, tenantId);
    expect(await store.materializeTenantContentInventoryJobs({ limit: 1 })).toBe(1);
    const [claim] = await store.claimTenantContentInventories({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "standalone-compaction",
    });
    const authorization = inventoryAuthorization(claim!);
    expect(await store.buildTenantContentInventoryPage(authorization, { limit: 10 }))
      .toMatchObject({ built: 1, done: true });
    expect(await store.sealTenantContentInventory(authorization)).toMatchObject({
      requestId: source.request.requestId,
      contentInventoryComplete: true,
    });
  });

  it("keeps the job retryable when seal time rolls behind captured page evidence", async () => {
    let nowMs = 7_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    const tenantId = "tenant-content-seal-evidence-clock";
    await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
    await installPolicy(store, tenantId, 0);
    await store.createSession(mkSession(tenantId, "evidence-clock-user"));
    const source = await advanceThroughExistingPolicyT3b(store, tenantId);
    await store.materializeTenantContentInventoryJobs({ limit: 1 });
    const [claim] = await store.claimTenantContentInventories({
      limit: 1,
      leaseMs: 10_000,
      claimToken: "evidence-clock",
    });
    const authorization = inventoryAuthorization(claim!);
    nowMs = 9_000;
    await store.buildTenantContentInventoryPage(authorization, { limit: 10 });
    nowMs = 8_000;
    await expect(store.sealTenantContentInventory(authorization))
      .rejects.toMatchObject({ reason: "trusted_clock_before_evidence" });
    expect(store.tenantContentInventoryReceipts.size).toBe(0);
    expect(store.tenantContentInventoryJobs.get(source.request.requestId)).toMatchObject({
      phase: "queued",
      scanComplete: true,
    });
    nowMs = 9_000;
    expect(await store.sealTenantContentInventory(authorization)).toMatchObject({
      requestId: source.request.requestId,
      storeDbTimestampMs: 9_000,
    });
  });

  it("rejects ordinary, orphaned, and duplicate approval-request associations", async () => {
    const store = new MemorySessionStore({ now: () => 5_200 });
    const tenantId = "tenant-content-approval-association";
    await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
    await installPolicy(store, tenantId, 0);
    const rich = await createRichSession(store, tenantId, "approval-user");
    expect(rich.approval.itemId).not.toBe(rich.item.id);
    const source = await advanceThroughExistingPolicyT3b(store, tenantId);
    await store.materializeTenantContentInventoryJobs({ limit: 1 });
    const [claim] = await store.claimTenantContentInventories({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "approval-association",
    });
    const authorization = inventoryAuthorization(claim!);
    const original = structuredClone(store.items.get(rich.item.id)!);
    if (original.type !== "approvalRequest") throw new Error("expected approval request fixture");

    store.items.set(original.id, {
      id: original.id,
      sessionId: original.sessionId,
      turnId: original.turnId,
      seq: original.seq,
      ...(original.step === undefined ? {} : { step: original.step }),
      status: original.status,
      createdAtMs: original.createdAtMs,
      ...(original.completedAtMs === undefined ? {} : { completedAtMs: original.completedAtMs }),
      type: "agentMessage",
      text: "schema-valid but not an approval request",
      phase: "finalAnswer",
    });
    await expect(store.buildTenantContentInventoryPage(authorization, { limit: 10 }))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    expect(store.tenantSessionContentReceipts.size).toBe(0);

    store.items.set(original.id, { ...original, approvalId: newId("apr") });
    await expect(store.buildTenantContentInventoryPage(authorization, { limit: 10 }))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    expect(store.tenantSessionContentReceipts.size).toBe(0);

    store.items.set(original.id, original);
    const duplicate = {
      ...original,
      id: newId("item"),
      seq: 2,
    };
    store.items.set(duplicate.id, duplicate);
    await expect(store.buildTenantContentInventoryPage(authorization, { limit: 10 }))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    expect(store.tenantSessionContentReceipts.size).toBe(0);
    store.items.delete(duplicate.id);

    expect(await store.buildTenantContentInventoryPage(authorization, { limit: 10 }))
      .toMatchObject({ built: 1, done: true });
    expect(await store.sealTenantContentInventory(authorization)).toMatchObject({
      requestId: source.request.requestId,
      contentInventoryComplete: true,
    });
  });

  it("detects valid-to-valid approvalId topology swaps after page capture", async () => {
    const store = new MemorySessionStore({ now: () => 5_400 });
    const tenantId = "tenant-content-approval-swap";
    await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
    await installPolicy(store, tenantId, 0);
    const first = await createRichSession(store, tenantId, "approval-swap-user");
    const secondApprovalId = newId("apr");
    const secondItem: Extract<Item, { type: "approvalRequest" }> = {
      id: newId("item"),
      sessionId: first.session.id,
      turnId: first.turn.id,
      seq: 0,
      step: 1,
      status: "completed",
      createdAtMs: 23,
      completedAtMs: 23,
      type: "approvalRequest",
      approvalId: secondApprovalId,
      toolCallId: first.approval.toolCallId,
      name: first.approval.toolName,
      args: {},
    };
    const secondApproval: Approval = {
      ...first.approval,
      id: secondApprovalId,
      itemId: newId("item"),
      createdAtMs: 23,
      expiresAtMs: 1_100,
    };
    await store.commit({
      sessionId: first.session.id,
      fence: 1,
      items: [secondItem],
      approvals: [secondApproval],
      events: [
        { type: "item/completed", sessionId: first.session.id, emittedAtMs: 23, item: secondItem },
        {
          type: "approval/requested",
          sessionId: first.session.id,
          emittedAtMs: 23,
          approval: secondApproval,
        },
      ],
    });
    const source = await advanceThroughExistingPolicyT3b(store, tenantId);
    await store.materializeTenantContentInventoryJobs({ limit: 1 });
    const [claim] = await store.claimTenantContentInventories({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "approval-swap",
    });
    const authorization = inventoryAuthorization(claim!);
    await store.buildTenantContentInventoryPage(authorization, { limit: 10 });

    const firstStored = store.items.get(first.item.id)!;
    const secondStored = store.items.get(secondItem.id)!;
    if (firstStored.type !== "approvalRequest" || secondStored.type !== "approvalRequest") {
      throw new Error("expected approval request fixtures");
    }
    store.items.set(firstStored.id, { ...firstStored, approvalId: secondApproval.id });
    store.items.set(secondStored.id, { ...secondStored, approvalId: first.approval.id });
    store.events.set(first.session.id, store.events.get(first.session.id)!.map((event) => {
      if (event.type !== "item/completed" || event.item.type !== "approvalRequest") return event;
      if (event.item.id === firstStored.id) {
        return { ...event, item: { ...event.item, approvalId: secondApproval.id } };
      }
      if (event.item.id === secondStored.id) {
        return { ...event, item: { ...event.item, approvalId: first.approval.id } };
      }
      return event;
    }));
    await expect(store.sealTenantContentInventory(authorization))
      .rejects.toBeInstanceOf(TenantContentInventoryEvidenceChangedError);
    expect(await store.getTenantContentInventoryReceipt(tenantId, source.request.requestId))
      .toBeNull();
  });

  it("enforces one claimant, database-time lease renewal/retry, and claim-attempt ABA", async () => {
    let nowMs = 2_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    const source = await advanceThroughT3b(store, "tenant-content-lease", 0);
    expect(await store.materializeTenantContentInventoryJobs({ limit: 10 })).toBe(1);
    const [left, right] = await Promise.all([
      store.claimTenantContentInventories({ limit: 1, leaseMs: 100, claimToken: "left" }),
      store.claimTenantContentInventories({ limit: 1, leaseMs: 100, claimToken: "right" }),
    ]);
    expect(left.length + right.length).toBe(1);
    const firstClaim = (left[0] ?? right[0])!;
    const firstAuthorization = inventoryAuthorization(firstClaim);
    nowMs = 2_050;
    expect(await store.renewTenantContentInventory(firstAuthorization, { leaseMs: 200 })).toBe(true);
    expect(store.tenantContentInventoryJobs.get(source.request.requestId)?.leaseUntilMs).toBe(2_250);
    nowMs = 2_051;
    expect(await store.renewTenantContentInventory(firstAuthorization, { leaseMs: 10 })).toBe(true);
    expect(store.tenantContentInventoryJobs.get(source.request.requestId)?.leaseUntilMs).toBe(2_250);
    nowMs = 1_900;
    expect(await store.renewTenantContentInventory(firstAuthorization, { leaseMs: 10 })).toBe(true);
    expect(store.tenantContentInventoryJobs.get(source.request.requestId)?.leaseUntilMs).toBe(2_250);
    nowMs = 2_050;
    expect(await store.retryTenantContentInventory(firstAuthorization, {
      delayMs: 25,
      errorCode: "temporary_failure",
    })).toBe(true);
    expect(await store.renewTenantContentInventory(firstAuthorization, { leaseMs: 200 })).toBe(false);
    expect(await store.claimTenantContentInventories({
      limit: 1,
      leaseMs: 100,
      claimToken: "too-early",
    })).toEqual([]);
    nowMs = 2_076;
    const [secondClaim] = await store.claimTenantContentInventories({
      limit: 1,
      leaseMs: 100,
      claimToken: "second",
    });
    expect(secondClaim).toMatchObject({ claimAttempt: 2, requestId: source.request.requestId });
    expect(await store.renewTenantContentInventory(firstAuthorization, { leaseMs: 200 })).toBe(false);
    const secondAuthorization = inventoryAuthorization(secondClaim!);
    nowMs = 2_100;
    expect(await store.renewTenantContentInventory(secondAuthorization, { leaseMs: 200 })).toBe(true);
    nowMs = 2_000;
    expect(await store.retryTenantContentInventory(secondAuthorization, {
      delayMs: 25,
      errorCode: "temporary_failure",
    })).toBe(true);
    expect(store.tenantContentInventoryJobs.get(source.request.requestId)).toMatchObject({
      availableAtMs: 2_125,
      updatedAtMs: 2_100,
    });
    nowMs = 2_124;
    expect(await store.claimTenantContentInventories({
      limit: 1,
      leaseMs: 100,
      claimToken: "retry-clock-too-early",
    })).toEqual([]);
    nowMs = 2_125;
    const [thirdClaim] = await store.claimTenantContentInventories({
      limit: 1,
      leaseMs: 100,
      claimToken: "retry-clock-third",
    });
    expect(thirdClaim).toMatchObject({ claimAttempt: 3, requestId: source.request.requestId });
    const claimedJob = store.tenantContentInventoryJobs.get(source.request.requestId)!;
    if (claimedJob.phase !== "queued") throw new Error("expected queued inventory job");
    expect(() => validateTenantContentInventoryJobRecord({
      ...claimedJob,
      lastErrorCode: "temporary_failure",
    })).toThrow(/retains a retry error/);
    const thirdAuthorization = inventoryAuthorization(thirdClaim!);
    expect(await store.buildTenantContentInventoryPage(thirdAuthorization, { limit: 10 }))
      .toMatchObject({ built: 0, done: true, contentRecordCount: 0 });
    expect(await store.sealTenantContentInventory(thirdAuthorization)).toMatchObject({
      completedClaimAttempt: 3,
      contentRecordCount: 0,
    });
  });

  it("fails closed on deadline overflow and saturates leases at the safe-integer boundary", async () => {
    let leaseNowMs = 2_300;
    const leaseStore = new MemorySessionStore({ now: () => leaseNowMs });
    const leaseSource = await advanceThroughT3b(
      leaseStore,
      "tenant-content-max-safe-lease",
      0,
    );
    expect(await leaseStore.materializeTenantContentInventoryJobs({ limit: 1 })).toBe(1);

    leaseNowMs = Number.MAX_SAFE_INTEGER - 1;
    const [claim] = await leaseStore.claimTenantContentInventories({
      limit: 1,
      leaseMs: 100,
      claimToken: "max-safe-lease",
    });
    expect(claim).toMatchObject({
      requestId: leaseSource.request.requestId,
      claimAttempt: 1,
      leaseUntilMs: Number.MAX_SAFE_INTEGER,
    });
    const authorization = inventoryAuthorization(claim!);
    expect(await leaseStore.renewTenantContentInventory(
      authorization,
      { leaseMs: 100 },
    )).toBe(true);
    const beforeExhaustion = structuredClone(
      leaseStore.tenantContentInventoryJobs.get(leaseSource.request.requestId),
    );
    expect(beforeExhaustion).toMatchObject({
      attempts: 1,
      leaseUntilMs: Number.MAX_SAFE_INTEGER,
      updatedAtMs: Number.MAX_SAFE_INTEGER - 1,
    });

    leaseNowMs = Number.MAX_SAFE_INTEGER;
    expect(await leaseStore.claimTenantContentInventories({
      limit: 1,
      leaseMs: 100,
      claimToken: "max-safe-exhausted",
    })).toEqual([]);
    expect(await leaseStore.renewTenantContentInventory(
      authorization,
      { leaseMs: 100 },
    )).toBe(false);
    expect(leaseStore.tenantContentInventoryJobs.get(leaseSource.request.requestId))
      .toEqual(beforeExhaustion);

    let overflowNowMs = 2_400;
    const overflowStore = new MemorySessionStore({ now: () => overflowNowMs });
    const overflowSource = await advanceThroughT3b(
      overflowStore,
      "tenant-content-deadline-overflow",
      10,
    );
    overflowNowMs = Number.MAX_SAFE_INTEGER - 5;
    await expect(overflowStore.materializeTenantContentInventoryJobs({ limit: 1 }))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    expect(overflowStore.tenantContentInventoryJobs.has(overflowSource.request.requestId))
      .toBe(false);
  });

  it("does not let unbound or unconfigured retention candidates consume the materialization limit", async () => {
    const store = new MemorySessionStore({ now: () => 2_500 });
    await advanceThroughT3b(
      store,
      "tenant-content-policy-unbound",
      undefined,
      "erase_00000000-0000-4000-8000-000000000001",
    );
    await advanceThroughT3b(
      store,
      "tenant-content-policy-unconfigured",
      null,
      "erase_80000000-0000-4000-8000-000000000002",
    );
    const healthy = await advanceThroughT3b(
      store,
      "tenant-content-policy-eligible",
      0,
      "erase_ffffffff-ffff-4fff-bfff-ffffffffffff",
    );

    expect(await store.materializeTenantContentInventoryJobs({ limit: 1 })).toBe(1);
    expect([...store.tenantContentInventoryJobs.keys()]).toEqual([healthy.request.requestId]);
    expect(await store.materializeTenantContentInventoryJobs({ limit: 1 })).toBe(0);
  });

  it("publishes a healthy materialization neighbor before reporting a damaged T3b source", async () => {
    const store = new MemorySessionStore({ now: () => 2_700 });
    const damaged = await advanceThroughT3b(
      store,
      "tenant-content-materialize-damaged",
      0,
      "erase_00000000-0000-4000-8000-000000000011",
    );
    const healthy = await advanceThroughT3b(
      store,
      "tenant-content-materialize-healthy",
      0,
      "erase_ffffffff-ffff-4fff-bfff-fffffffffff1",
    );
    store.tenantRuntimeRevocationReceipts.delete(damaged.request.requestId);

    await expect(store.materializeTenantContentInventoryJobs({ limit: 1 }))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    expect(store.tenantContentInventoryJobs.has(damaged.request.requestId)).toBe(false);
    expect(store.tenantContentInventoryJobs.get(healthy.request.requestId)).toMatchObject({
      phase: "queued",
      attempts: 0,
    });
    await expect(store.claimTenantContentInventories({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "healthy-after-materialize-conflict",
    })).resolves.toEqual([
      expect.objectContaining({ requestId: healthy.request.requestId, claimAttempt: 1 }),
    ]);
  });

  it("fails closed for owner/orphan corruption, active hold, policy ABA, and post-page drift", async () => {
    let nowMs = 3_000;
    const orphanStore = new MemorySessionStore({ now: () => nowMs });
    await advanceThroughT3b(orphanStore, "tenant-content-orphan", 0);
    await orphanStore.materializeTenantContentInventoryJobs({ limit: 10 });
    const [orphanClaim] = await orphanStore.claimTenantContentInventories({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "orphan",
    });
    const orphanTurn: Turn = {
      id: newId("turn"),
      sessionId: newId("sess"),
      status: "inProgress",
      seqStart: 0,
      steps: 0,
      toolCalls: 0,
      usage: emptyUsage(),
      startedAtMs: 1,
    };
    orphanStore.turns.set(orphanTurn.id, orphanTurn);
    await expect(orphanStore.buildTenantContentInventoryPage(
      inventoryAuthorization(orphanClaim!),
      { limit: 10 },
    )).rejects.toBeInstanceOf(TenantErasureIntegrityError);

    const holdStore = new MemorySessionStore({ now: () => nowMs });
    const holdTenant = "tenant-content-hold";
    await holdStore.setTenantAuth(holdTenant, DEFAULT_AUTH_POLICY);
    await installPolicy(holdStore, holdTenant, 0);
    const held = await createRichSession(holdStore, holdTenant, "held-user");
    await holdStore.setLegalHold({
      tenantId: holdTenant,
      holdId: "hold_content_inventory",
      subjectKind: "user",
      subjectId: held.session.userId,
      reasonCode: "litigation",
      expectedControlGeneration: 0,
      actorKeyId: "legal-admin",
      atMs: 50,
    });
    const holdRequest = {
      requestId: newErasureRequestId(),
      tenantId: holdTenant,
      requestedByKeyId: "platform-lifecycle-admin",
      idempotencyKey: `hold-${randomUUID()}`,
      requestHash: tenantErasureRequestHash(holdTenant),
      atMs: 100,
    };
    await holdStore.requestTenantErasure(holdRequest);
    const credential = (await holdStore.claimTenantCredentialRevocations({
      limit: 1,
      leaseMs: 10_000,
      claimToken: "hold-credential",
    }))[0]!;
    await holdStore.revokeTenantCredentialMaterial(credentialAuthorization(credential));
    await holdStore.materializeTenantRuntimeRevocationJobs({ limit: 1 });
    const runtime = (await holdStore.claimTenantRuntimeRevocations({
      limit: 1,
      leaseMs: 10_000,
      claimToken: "hold-runtime",
    }))[0]!;
    await holdStore.completeTenantRuntimeRevocation(runtimeAuthorization(runtime), fleetProof(runtime));
    await holdStore.materializeTenantContentInventoryJobs({ limit: 1 });
    const [holdClaim] = await holdStore.claimTenantContentInventories({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "hold-inventory",
    });
    const holdAuthorization = inventoryAuthorization(holdClaim!);
    await holdStore.buildTenantContentInventoryPage(holdAuthorization, { limit: 10 });
    await expect(holdStore.sealTenantContentInventory(holdAuthorization))
      .rejects.toMatchObject({ reason: "active_legal_hold" });

    const driftStore = new MemorySessionStore({ now: () => nowMs });
    const driftTenant = "tenant-content-drift";
    await driftStore.setTenantAuth(driftTenant, DEFAULT_AUTH_POLICY);
    await installPolicy(driftStore, driftTenant, 0);
    const driftSession = await createRichSession(driftStore, driftTenant, "drift-user");
    await advanceThroughExistingPolicyT3b(driftStore, driftTenant);
    await driftStore.materializeTenantContentInventoryJobs({ limit: 1 });
    const [driftClaim] = await driftStore.claimTenantContentInventories({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "drift-inventory",
    });
    const driftAuthorization = inventoryAuthorization(driftClaim!);
    await driftStore.buildTenantContentInventoryPage(driftAuthorization, { limit: 10 });
    const extraTurn: Turn = {
      id: newId("turn"),
      sessionId: driftSession.session.id,
      status: "inProgress",
      seqStart: 2,
      steps: 0,
      toolCalls: 0,
      usage: emptyUsage(),
      startedAtMs: 60,
    };
    driftStore.turns.set(extraTurn.id, extraTurn);
    await expect(driftStore.sealTenantContentInventory(driftAuthorization))
      .rejects.toBeInstanceOf(TenantContentInventoryEvidenceChangedError);

    const policyStore = new MemorySessionStore({ now: () => nowMs });
    await advanceThroughT3b(policyStore, "tenant-content-policy-aba", 0);
    await policyStore.materializeTenantContentInventoryJobs({ limit: 1 });
    const bound = [...policyStore.retentionPolicies.values()][0]!;
    (bound.policy as { sessionContentRetentionMs: number | null }).sessionContentRetentionMs = 1;
    await expect(policyStore.claimTenantContentInventories({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "policy-corrupt",
    })).resolves.toEqual([]);
    expect([...policyStore.tenantContentInventoryJobs.values()]).toEqual([
      expect.objectContaining({
        phase: "blocked",
        attempts: 1,
        blockedReasonCode: "integrity_conflict",
      }),
    ]);
  });

  it("rejects parent cycles and both directions of the terminal tombstone relation", async () => {
    const buildFor = async (store: MemorySessionStore, tenantId: string, token: string) => {
      await advanceThroughT3b(store, tenantId, 0);
      await store.materializeTenantContentInventoryJobs({ limit: 1 });
      const [claim] = await store.claimTenantContentInventories({
        limit: 1,
        leaseMs: 1_000,
        claimToken: token,
      });
      return store.buildTenantContentInventoryPage(inventoryAuthorization(claim!), { limit: 10 });
    };

    const cycleStore = new MemorySessionStore({ now: () => 5_000 });
    const cycleTenant = "tenant-content-parent-cycle";
    const parent = mkSession(cycleTenant, "cycle-user");
    const child = { ...mkSession(cycleTenant, "cycle-user"), parentSessionId: parent.id };
    await cycleStore.createSession(parent);
    await cycleStore.createSession(child);
    cycleStore.sessions.get(parent.id)!.parentSessionId = child.id;
    await expect(buildFor(cycleStore, cycleTenant, "cycle-inventory"))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);

    const liveStore = new MemorySessionStore({ now: () => 5_000 });
    const liveTenant = "tenant-content-live-tombstone-event";
    const live = mkSession(liveTenant, "live-user");
    await liveStore.createSession(live);
    const created = liveStore.events.get(live.id)![0]!;
    liveStore.events.set(live.id, [{
      type: "session/deleted",
      sessionId: live.id,
      seq: created.seq,
      emittedAtMs: created.emittedAtMs,
      deletionGeneration: 1,
    }]);
    await expect(buildFor(liveStore, liveTenant, "live-tombstone-inventory"))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);

    const terminalStore = new MemorySessionStore({ now: () => 5_000 });
    const terminalTenant = "tenant-content-nonterminal-tombstone";
    const terminal = mkSession(terminalTenant, "terminal-user");
    await terminalStore.createSession(terminal);
    const terminalCreated = terminalStore.events.get(terminal.id)![0]!;
    const deletedAtMs = terminalCreated.emittedAtMs + 1;
    terminalStore.events.set(terminal.id, [
      terminalCreated,
      {
        type: "session/deleted",
        sessionId: terminal.id,
        seq: 2,
        emittedAtMs: deletedAtMs,
        deletionGeneration: 1,
      },
      {
        type: "warning",
        sessionId: terminal.id,
        seq: 3,
        emittedAtMs: deletedAtMs + 1,
        code: "post_delete",
        message: "must fail closed",
      },
    ]);
    terminalStore.sessions.get(terminal.id)!.lastSeq = 3;
    terminalStore.deleted.set(terminal.id, { deletedAtMs, deletionGeneration: 1 });
    await expect(buildFor(terminalStore, terminalTenant, "terminal-tombstone-inventory"))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
  });

  it("fails closed for a non-canonical tenant legal-hold event subject", async () => {
    let nowMs = 3_500;
    const store = new MemorySessionStore({ now: () => nowMs });
    const tenantId = "tenant-content-invalid-hold-event";
    const source = await advanceThroughT3b(store, tenantId, 0);
    expect(await store.materializeTenantContentInventoryJobs({ limit: 1 })).toBe(1);
    const [claim] = await store.claimTenantContentInventories({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "invalid-hold-event",
    });
    const authorization = inventoryAuthorization(claim!);
    await store.buildTenantContentInventoryPage(authorization, { limit: 10 });

    const invalidSubjectId = "different-tenant-subject";
    store.legalHoldEvents.set(
      JSON.stringify([tenantId, "tenant", invalidSubjectId]),
      [{
        eventId: 1,
        tenantId,
        subjectKind: "tenant",
        subjectId: invalidSubjectId,
        controlGeneration: 1,
        holdId: "hold_invalid_tenant_subject",
        eventType: "legal_hold/set",
        reasonCode: "litigation",
        actorKeyId: "legal-admin",
        beforeSha256: "0".repeat(64),
        afterSha256: "1".repeat(64),
        emittedAtMs: nowMs,
      }],
    );

    await expect(store.sealTenantContentInventory(authorization))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    expect(store.tenantContentInventoryJobs.get(source.request.requestId)?.phase).toBe("queued");
  });

  it("durably blocks a damaged source without starving or repeatedly claiming healthy work", async () => {
    let nowMs = 3_800;
    const store = new MemorySessionStore({ now: () => nowMs });
    const damaged = await advanceThroughT3b(store, "tenant-content-source-damaged", 0);
    const healthy = await advanceThroughT3b(store, "tenant-content-source-healthy", 0);
    expect(await store.materializeTenantContentInventoryJobs({ limit: 10 })).toBe(2);
    store.tenantRuntimeRevocationReceipts.delete(damaged.request.requestId);

    const claims = await store.claimTenantContentInventories({
      limit: 10,
      leaseMs: 1_000,
      claimToken: "mixed-source-batch",
    });
    expect(claims.map((claim) => claim.requestId)).toEqual([healthy.request.requestId]);
    expect(store.tenantContentInventoryJobs.get(damaged.request.requestId)).toMatchObject({
      phase: "blocked",
      attempts: 1,
      blockedReasonCode: "integrity_conflict",
    });

    const healthyAuthorization = inventoryAuthorization(claims[0]!);
    await expect(store.buildTenantContentInventoryPage(healthyAuthorization, { limit: 10 }))
      .resolves.toMatchObject({ done: true });
    await expect(store.sealTenantContentInventory(healthyAuthorization))
      .resolves.toMatchObject({ requestId: healthy.request.requestId });
    expect(await store.claimTenantContentInventories({
      limit: 10,
      leaseMs: 1_000,
      claimToken: "no-repeat-damaged-source",
    })).toEqual([]);

    nowMs = 4_000;
    const postClaimStore = new MemorySessionStore({ now: () => nowMs });
    const postClaim = await advanceThroughT3b(
      postClaimStore,
      "tenant-content-source-damaged-after-claim",
      0,
    );
    await postClaimStore.materializeTenantContentInventoryJobs({ limit: 1 });
    const [validClaim] = await postClaimStore.claimTenantContentInventories({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "source-damaged-after-claim",
    });
    postClaimStore.tenantRuntimeRevocationReceipts.delete(postClaim.request.requestId);
    expect(await postClaimStore.blockTenantContentInventory(
      inventoryAuthorization(validClaim!),
    )).toBe(true);
    expect(postClaimStore.tenantContentInventoryJobs.get(postClaim.request.requestId))
      .toMatchObject({ phase: "blocked", attempts: 1 });
    expect(await postClaimStore.claimTenantContentInventories({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "source-damaged-not-reclaimed",
    })).toEqual([]);

    let rollbackNowMs = 6_000;
    const rollbackStore = new MemorySessionStore({ now: () => rollbackNowMs });
    const rollback = await advanceThroughT3b(
      rollbackStore,
      "tenant-content-block-clock-rollback",
      0,
    );
    await rollbackStore.materializeTenantContentInventoryJobs({ limit: 1 });
    const [rollbackClaim] = await rollbackStore.claimTenantContentInventories({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "block-clock-rollback",
    });
    const rollbackAuthorization = inventoryAuthorization(rollbackClaim!);
    rollbackNowMs = 6_500;
    expect(await rollbackStore.renewTenantContentInventory(
      rollbackAuthorization,
      { leaseMs: 1_000 },
    )).toBe(true);
    rollbackNowMs = 6_100;
    expect(await rollbackStore.blockTenantContentInventory(rollbackAuthorization)).toBe(true);
    expect(rollbackStore.tenantContentInventoryJobs.get(rollback.request.requestId)).toMatchObject({
      phase: "blocked",
      updatedAtMs: 6_500,
      blockedAtDbMs: 6_500,
    });
  });

  it("rolls back page and aggregate publication failures and permits exact seal replay", async () => {
    let nowMs = 4_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    const tenantId = "tenant-content-rollback";
    await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
    await installPolicy(store, tenantId, 0);
    await store.createSession(mkSession(tenantId, "rollback-user"));
    await store.createSession(mkSession(tenantId, "rollback-user"));
    const source = await advanceThroughExistingPolicyT3b(store, tenantId);
    await store.materializeTenantContentInventoryJobs({ limit: 1 });
    const [claim] = await store.claimTenantContentInventories({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "rollback-inventory",
    });
    const authorization = inventoryAuthorization(claim!);

    const receiptMap = store.tenantSessionContentReceipts;
    const originalReceiptSet = receiptMap.set;
    let receiptSetCalls = 0;
    receiptMap.set = function injected(key, value) {
      originalReceiptSet.call(this, key, value);
      receiptSetCalls += 1;
      if (receiptSetCalls === 2) throw new Error("injected page publication failure");
      return this;
    };
    await expect(store.buildTenantContentInventoryPage(authorization, { limit: 2 }))
      .rejects.toThrow("injected page publication failure");
    delete (receiptMap as unknown as { set?: unknown }).set;
    expect(store.tenantSessionContentReceipts.size).toBe(0);
    expect(store.tenantContentInventoryJobs.get(source.request.requestId)).toMatchObject({
      scanComplete: false,
      sessionReceiptCount: 0,
      claimToken: authorization.claimToken,
    });

    await store.buildTenantContentInventoryPage(authorization, { limit: 2 });
    const jobs = store.tenantContentInventoryJobs;
    const originalJobSet = jobs.set;
    jobs.set = function injected(key, value) {
      if (value.phase === "inventory_sealed") {
        throw new Error("injected aggregate publication failure");
      }
      return originalJobSet.call(this, key, value);
    };
    await expect(store.sealTenantContentInventory(authorization))
      .rejects.toThrow("injected aggregate publication failure");
    delete (jobs as unknown as { set?: unknown }).set;
    expect(store.tenantContentInventoryReceipts.size).toBe(0);
    expect(store.tenantContentInventoryJobs.get(source.request.requestId)).toMatchObject({
      phase: "queued",
      claimToken: authorization.claimToken,
    });

    const receipt = await store.sealTenantContentInventory(authorization);
    expect(await store.sealTenantContentInventory(authorization)).toEqual(receipt);
    expect(await store.getTenantContentInventoryReceipt(tenantId, source.request.requestId))
      .toEqual(receipt);
  });
});

async function advanceThroughExistingPolicyT3b(
  store: MemorySessionStore,
  tenantId: string,
) {
  const request = {
    requestId: newErasureRequestId(),
    tenantId,
    requestedByKeyId: "platform-lifecycle-admin",
    idempotencyKey: `existing-policy-${randomUUID()}`,
    requestHash: tenantErasureRequestHash(tenantId),
    atMs: 100,
  };
  await store.requestTenantErasure(request);
  const credentialClaim = (await store.claimTenantCredentialRevocations({
    limit: 10,
    leaseMs: 10_000,
    claimToken: `credential-existing-${tenantId}`,
  })).find((claim) => claim.requestId === request.requestId)!;
  await store.revokeTenantCredentialMaterial(credentialAuthorization(credentialClaim));
  await store.materializeTenantRuntimeRevocationJobs({ limit: 10 });
  const runtimeClaim = (await store.claimTenantRuntimeRevocations({
    limit: 10,
    leaseMs: 10_000,
    claimToken: `runtime-existing-${tenantId}`,
  })).find((claim) => claim.requestId === request.requestId)!;
  await store.completeTenantRuntimeRevocation(runtimeAuthorization(runtimeClaim), fleetProof(runtimeClaim));
  return { request };
}
