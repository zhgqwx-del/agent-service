import { randomUUID } from "node:crypto";
import {
  DEFAULT_AUTH_POLICY,
  emptyUsage,
  tenantRuntimeFleetSha256,
  tenantRuntimeLocalReceiptSha256,
  tenantRuntimeTargetReceiptsSha256,
  tenantRuntimeTargetSha256,
  type AgentDefinition,
  type ProviderConfig,
  type TenantAuthPolicy,
  type TenantRuntimeRevocationFleetProof,
  type Turn,
} from "@agent-service/protocol";
import { describe, expect, it } from "vitest";
import {
  MemorySessionStore,
  TenantErasureIntegrityError,
  TenantPurgePlanEvidenceChangedError,
  legacyTombstoneCompensationJobIdForSession,
  legacyTombstoneSuccessEvidenceSha256,
  newErasureRequestId,
  newUserDataExportRequestId,
  subjectLifecycleKey,
  tenantErasureRequestHash,
  userErasureRequestHash,
  userDataExportRequestHash,
  validateTenantPurgePlanCompletionProof,
  type RetentionPolicyDocumentV1,
  type TenantContentInventoryAuthorization,
  type TenantCredentialRevocationAuthorization,
  type TenantPurgePlanAuthorization,
  type TenantRuntimeRevocationAuthorization,
} from "../src/index.js";
import { mkSession, newId } from "./conformance.js";

const AUTH_POLICY: TenantAuthPolicy = {
  mode: "end_user_token",
  tokenHeader: "x-end-user-token",
  verifier: {
    kind: "jwt",
    hs256: true,
    algorithms: ["HS256"],
    subjectClaim: "sub",
    clockToleranceSec: 0,
  },
};

function policy(contentRetentionMs: number | null): RetentionPolicyDocumentV1 {
  return {
    sessionContentRetentionMs: contentRetentionMs,
    userErasureGraceMs: 0,
    operationalUsageRetentionMs: 0,
    idempotencyReceiptRetentionMs: 0,
    billingFactRetentionMs: null,
    lifecycleAuditRetentionMs: null,
    exportArtifactTtlMs: 60_000,
  };
}

function provider(tenantId: string, id = "private-provider"): ProviderConfig {
  return {
    tenantId,
    id,
    api: "openai-completions",
    baseUrl: "https://private-provider.invalid/v1",
    apiKeyRef: `secret:${tenantId}:${id}`,
    headers: { Authorization: "Bearer never-copy-this-secret" },
    models: [{
      id: "private-model",
      contextWindow: 1_000,
      maxOutputTokens: 100,
      input: ["text"],
      reasoning: false,
    }],
    quota: {},
    fallback: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function agent(tenantId: string, id = newId("agt")): AgentDefinition {
  return {
    id,
    tenantId,
    version: 1,
    name: "private agent body",
    instructions: "never copy this instruction",
    model: { provider: "private-provider", model: "private-model" },
    tools: [],
    mcpServers: [],
    skills: [],
    limits: {},
    approvalPolicy: "on-request",
    busyPolicy: "steer",
    sandbox: "none",
    metadata: { secret: "never copy metadata" },
    createdAtMs: 1,
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

function planAuthorization(
  claim: Awaited<ReturnType<MemorySessionStore["claimTenantPurgePlans"]>>[number],
): TenantPurgePlanAuthorization {
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
  contentRetentionMs: number,
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

interface AdvanceOptions {
  requestId?: string;
  credentials?: boolean;
  contentRetentionMs?: number;
  beforeTenantErasure?: (store: MemorySessionStore, tenantId: string) => Promise<void>;
  beforeContentSeal?: () => void;
}

async function advanceThroughT3c(
  store: MemorySessionStore,
  tenantId: string,
  options: AdvanceOptions = {},
) {
  if (options.credentials) {
    await store.setTenantAuth(tenantId, AUTH_POLICY, {
      ciphertext: Buffer.from("never-copy-auth-cipher"),
      keyId: "never-copy-auth-key-id",
    });
    await store.upsertProviderConfig(provider(tenantId), {
      ciphertext: Buffer.from("never-copy-provider-cipher"),
      keyId: "never-copy-provider-key-id",
    });
  } else {
    await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
  }
  await installPolicy(store, tenantId, options.contentRetentionMs ?? 0);
  await options.beforeTenantErasure?.(store, tenantId);
  const request = {
    requestId: options.requestId ?? newErasureRequestId(),
    tenantId,
    requestedByKeyId: "platform-lifecycle-admin",
    idempotencyKey: `purge-plan-${randomUUID()}`,
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
  await store.materializeTenantRuntimeRevocationJobs({ limit: 10 });
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
  await store.materializeTenantContentInventoryJobs({ limit: 10 });
  const inventoryClaim = (await store.claimTenantContentInventories({
    limit: 10,
    leaseMs: 10_000,
    claimToken: `inventory-${tenantId}`,
  })).find((claim) => claim.requestId === request.requestId)!;
  const inventoryAuth = inventoryAuthorization(inventoryClaim);
  await store.buildTenantContentInventoryPage(inventoryAuth, { limit: 100 });
  options.beforeContentSeal?.();
  const contentReceipt = await store.sealTenantContentInventory(inventoryAuth);
  expect(contentReceipt).not.toBeNull();
  return {
    request,
    credentialReceipt: credentialReceipt!,
    runtimeReceipt: runtimeReceipt!,
    contentReceipt: contentReceipt!,
  };
}

async function prepareUserPurgeTarget(
  store: MemorySessionStore,
  tenantId: string,
  userId: string,
  baseMs: number,
) {
  const session = {
    ...mkSession(tenantId, userId),
    createdAtMs: baseMs,
    updatedAtMs: baseMs,
  };
  await store.createSession(session);
  await store.commit({
    sessionId: session.id,
    fence: 1,
    lifecycle: {
      type: "tombstone",
      tenantId,
      userId,
      deletionGeneration: 1,
      atMs: baseMs + 1,
    },
    events: [{
      type: "session/deleted",
      sessionId: session.id,
      deletionGeneration: 1,
      emittedAtMs: baseMs + 1,
    }],
  });
  await store.reconcileSessionUsage({
    tenantId,
    userId,
    sessionId: session.id,
    deletionGeneration: 1,
    nowMs: baseMs + 2,
  });

  const requestId = newErasureRequestId();
  await store.requestUserErasure({
    requestId,
    tenantId,
    userId,
    requestedByKeyId: "purge-plan-user-admin",
    idempotencyKey: `purge-plan-user-${randomUUID()}`,
    requestHash: userErasureRequestHash(tenantId, userId),
    atMs: baseMs + 3,
  });
  const transitions = [
    ["gated", "draining"],
    ["draining", "tombstoning"],
    ["tombstoning", "reconciling_usage"],
    ["reconciling_usage", "awaiting_purge_policy"],
  ] as const;
  for (const [index, [fromStatus, toStatus]] of transitions.entries()) {
    const atMs = baseMs + 4 + index;
    const claim = (await store.claimErasureJobs({
      nowMs: atMs,
      limit: 1,
      leaseMs: 100,
      claimToken: `purge-plan-user-job-${index}`,
    })).find((candidate) => candidate.requestId === requestId);
    if (!claim) throw new Error("expected user erasure claim");
    const transitioned = await store.transitionErasureJob({
      tenantId: claim.tenantId,
      subjectKind: claim.subjectKind,
      subjectId: claim.subjectId,
      requestId: claim.requestId,
      subjectGeneration: claim.subjectGeneration,
      claimToken: claim.claimToken,
      claimAttempt: claim.attempts,
    }, {
      fromStatus,
      toStatus,
      atMs,
      ...(toStatus === "awaiting_purge_policy" ? {} : { availableAtMs: atMs }),
    });
    if (!transitioned) throw new Error("expected user erasure transition");
  }
  const evaluation = (await store.claimErasurePolicyEvaluations({
    nowMs: baseMs + 8,
    limit: 1,
    leaseMs: 100,
    claimToken: "purge-plan-user-evaluation",
  })).find((candidate) => candidate.requestId === requestId);
  if (!evaluation) throw new Error("expected user purge-policy claim");
  await store.buildErasurePurgeTargetPage({
    requestId: evaluation.requestId,
    tenantId: evaluation.tenantId,
    subjectKind: evaluation.subjectKind,
    subjectId: evaluation.subjectId,
    subjectGeneration: evaluation.subjectGeneration,
    buildGeneration: evaluation.buildGeneration,
    claimToken: evaluation.claimToken,
    claimAttempt: evaluation.claimAttempt,
  }, {
    nowMs: baseMs + 9,
    limit: 10,
  });
  const targetEntry = [...store.erasurePurgeTargets.entries()].find(([, target]) => (
    target.requestId === requestId && target.sessionId === session.id
  ));
  if (!targetEntry) throw new Error("expected user purge target");
  return { requestId, session, targetEntry };
}

class FailOnceMap<K, V> extends Map<K, V> {
  private remaining: number;

  constructor(entries: readonly (readonly [K, V])[], failOnSet: number) {
    super(entries);
    this.remaining = failOnSet;
  }

  override set(key: K, value: V): this {
    this.remaining -= 1;
    if (this.remaining === 0) throw new Error("injected plan entry write failure");
    return super.set(key, value);
  }
}

describe("MemorySessionStore tenant purge plan", () => {
  it("seals all 33 content-free domains with explicit legacy/adapter blockers and no mutation", async () => {
    let nowMs = 5_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    const tenantId = "tenant-purge-plan-success";
    const session = mkSession(tenantId, "raw-private-user");
    await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
    await store.createSession(session);
    store.agents.set(JSON.stringify([tenantId, "private-agent", 1]), agent(tenantId));
    const sourceBefore = structuredClone({
      sessions: [...store.sessions.entries()],
      turns: [...store.turns.entries()],
      items: [...store.items.entries()],
      approvals: [...store.approvals.entries()],
      events: [...store.events.entries()],
    });
    const source = await advanceThroughT3c(store, tenantId, { credentials: true });

    expect(await store.materializeTenantPurgePlanJobs({ limit: 10 })).toBe(1);
    const [claim] = await store.claimTenantPurgePlans({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "plan-success-secret-token",
    });
    const authorization = planAuthorization(claim!);
    expect(await store.buildTenantPurgePlanPage(authorization, { limit: 7 }))
      .toMatchObject({ built: 7, done: false, cursorDomain: "billing_facts" });
    expect(await store.buildTenantPurgePlanPage(authorization, { limit: 26 }))
      .toMatchObject({ built: 26, done: true, cursorDomain: "traces" });

    const entries = await store.getTenantPurgePlanEntries(
      tenantId,
      source.request.requestId,
      1,
    );
    expect(entries.map((entry) => entry.domain)).toEqual([
      "tenant_registry", "tenant_profile", "agent_definitions", "session_content",
      "idempotency_receipts", "operational_usage", "billing_facts",
      "billing_reconciliation", "blob_manifest", "blob_bytes", "blob_outbox",
      "lifecycle_outbox", "user_export_control", "user_export_snapshots",
      "user_export_artifacts", "user_export_bytes", "user_erasure_evidence",
      "user_purge_policy_evidence", "governance_policy", "legal_holds",
      "tenant_t1_evidence", "tenant_t3a_evidence", "tenant_t3b_evidence",
      "tenant_t3c_evidence", "redis_leases", "redis_fences", "redis_streams",
      "external_provider", "kms", "backup_ledger", "restore_ledger", "logs", "traces",
    ]);
    expect(entries.find((entry) => entry.domain === "external_provider")).toMatchObject({
      targetCount: 1,
      disposition: "blocked_legacy_external_source_unavailable",
    });
    expect(entries.find((entry) => entry.domain === "kms")).toMatchObject({
      targetCount: 2,
      disposition: "blocked_legacy_external_source_unavailable",
    });
    expect(entries.find((entry) => entry.domain === "restore_ledger")).toMatchObject({
      targetCount: 0,
      disposition: "blocked_restore_replay_unproven",
    });
    expect(entries.find((entry) => entry.domain === "logs")).toMatchObject({
      targetCount: 0,
      disposition: "blocked_adapter_unconfigured",
    });
    const serialized = JSON.stringify(entries);
    for (const forbidden of [
      session.id,
      "raw-private-user",
      "private-provider",
      "private-model",
      "never-copy",
      "plan-success-secret-token",
    ]) expect(serialized).not.toContain(forbidden);

    const receipt = await store.sealTenantPurgePlan(authorization);
    expect(receipt).toMatchObject({
      requestId: source.request.requestId,
      planEntryCount: 33,
      blockerCount: 11,
      planComplete: true,
      executionReady: false,
      contentPurgeExecuted: false,
      storeDbTimestampMs: nowMs,
    });
    expect(await store.sealTenantPurgePlan(authorization)).toEqual(receipt);
    expect(await store.sealTenantPurgePlan({
      ...authorization,
      claimToken: "wrong-response-loss-token",
    })).toBeNull();
    expect(await store.getTenantPurgePlanReceipt("neighbor", source.request.requestId)).toBeNull();
    expect(await store.getTenantPurgePlanEntries("neighbor", source.request.requestId, 1)).toEqual([]);
    expect({
      sessions: [...store.sessions.entries()],
      turns: [...store.turns.entries()],
      items: [...store.items.entries()],
      approvals: [...store.approvals.entries()],
      events: [...store.events.entries()],
    }).toEqual(sourceBefore);
    const job = await store.getTenantPurgePlanJob(tenantId, source.request.requestId);
    if (!job || job.phase !== "plan_sealed" || !receipt) {
      throw new Error("expected sealed plan evidence");
    }
    expect(() => validateTenantPurgePlanCompletionProof(job, entries, receipt)).not.toThrow();
  });

  it("marks proven-zero legacy provider/KMS domains not-applicable without hiding real blockers", async () => {
    const store = new MemorySessionStore({ now: () => 5_100 });
    const source = await advanceThroughT3c(store, "tenant-purge-plan-no-external");
    await store.materializeTenantPurgePlanJobs({ limit: 1 });
    const [claim] = await store.claimTenantPurgePlans({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "no-external-plan",
    });
    const authorization = planAuthorization(claim!);
    await store.buildTenantPurgePlanPage(authorization, { limit: 33 });
    const receipt = await store.sealTenantPurgePlan(authorization);
    const entries = await store.getTenantPurgePlanEntries(
      source.request.tenantId,
      source.request.requestId,
      1,
    );

    for (const domain of ["external_provider", "kms"] as const) {
      expect(entries.find((entry) => entry.domain === domain)).toMatchObject({
        targetCount: 0,
        disposition: "not_applicable",
      });
    }
    expect(receipt).toMatchObject({ blockerCount: 9, executionReady: false });
  });

  it("fails KMS closed when T3a erased provider material but no tenant auth secret", async () => {
    const store = new MemorySessionStore({ now: () => 5_200 });
    const tenantId = "tenant-purge-plan-provider-secret-only";
    const source = await advanceThroughT3c(store, tenantId, {
      beforeTenantErasure: async () => {
        await store.upsertProviderConfig(provider(tenantId, "provider-secret-only"), {
          ciphertext: Buffer.from("never-copy-provider-only-cipher"),
          keyId: "never-copy-provider-only-key-id",
        });
      },
    });
    await store.materializeTenantPurgePlanJobs({ limit: 1 });
    const [claim] = await store.claimTenantPurgePlans({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "provider-only-plan",
    });
    const receipt = await store.sealTenantPurgePlan(planAuthorization(claim!));
    const entries = await store.getTenantPurgePlanEntries(
      tenantId,
      source.request.requestId,
      1,
    );

    for (const domain of ["external_provider", "kms"] as const) {
      expect(entries.find((entry) => entry.domain === domain)).toMatchObject({
        targetCount: 1,
        disposition: "blocked_legacy_external_source_unavailable",
      });
    }
    expect(receipt).toMatchObject({ blockerCount: 11, executionReady: false });
  });

  it("records ten blockers for a tenant auth envelope without provider material", async () => {
    const store = new MemorySessionStore({ now: () => 5_300 });
    const tenantId = "tenant-purge-plan-auth-secret-only";
    const source = await advanceThroughT3c(store, tenantId, {
      beforeTenantErasure: async () => {
        await store.setTenantAuth(tenantId, AUTH_POLICY, {
          ciphertext: Buffer.from("never-copy-auth-only-cipher"),
          keyId: "never-copy-auth-only-key-id",
        });
      },
    });
    await store.materializeTenantPurgePlanJobs({ limit: 1 });
    const [claim] = await store.claimTenantPurgePlans({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "auth-only-plan",
    });
    const receipt = await store.sealTenantPurgePlan(planAuthorization(claim!));
    const entries = await store.getTenantPurgePlanEntries(
      tenantId,
      source.request.requestId,
      1,
    );

    expect(entries.find((entry) => entry.domain === "external_provider")).toMatchObject({
      targetCount: 0,
      disposition: "not_applicable",
    });
    expect(entries.find((entry) => entry.domain === "kms")).toMatchObject({
      targetCount: 1,
      disposition: "blocked_legacy_external_source_unavailable",
    });
    expect(receipt).toMatchObject({ blockerCount: 10, executionReady: false });
  });

  it("fails retryably on source/deadline/evidence clock rollback without publishing partial plan", async () => {
    let nowMs = 6_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    const source = await advanceThroughT3c(store, "tenant-purge-plan-clock", {
      contentRetentionMs: 100,
      beforeContentSeal: () => { nowMs = 6_200; },
    });
    nowMs = 6_199;
    await expect(store.materializeTenantPurgePlanJobs({ limit: 1 }))
      .rejects.toMatchObject({ reason: "trusted_clock_before_source" });
    expect(store.tenantPurgePlanJobs.size).toBe(0);
    expect(store.tenantPurgePlanEntries.size).toBe(0);

    nowMs = 6_200;
    await store.materializeTenantPurgePlanJobs({ limit: 1 });
    const [claim] = await store.claimTenantPurgePlans({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "clock-plan",
    });
    const authorization = planAuthorization(claim!);
    nowMs = 6_050;
    await expect(store.buildTenantPurgePlanPage(authorization, { limit: 33 }))
      .rejects.toMatchObject({ reason: "deadline_not_reached" });
    nowMs = 6_150;
    await expect(store.buildTenantPurgePlanPage(authorization, { limit: 33 }))
      .rejects.toMatchObject({ reason: "trusted_clock_before_evidence" });
    expect(store.tenantPurgePlanEntries.size).toBe(0);
    expect(store.tenantPurgePlanJobs.get(source.request.requestId)).toMatchObject({
      phase: "queued",
      planEntryCount: 0,
      scanComplete: false,
    });
    nowMs = 6_200;
    await expect(store.buildTenantPurgePlanPage(authorization, { limit: 33 }))
      .resolves.toMatchObject({ built: 33, done: true });
  });

  it("rechecks a canonical hold at seal and never treats the plan as execution authority", async () => {
    let nowMs = 7_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    const tenantId = "tenant-purge-plan-hold";
    const source = await advanceThroughT3c(store, tenantId);
    await store.materializeTenantPurgePlanJobs({ limit: 1 });
    const [claim] = await store.claimTenantPurgePlans({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "hold-plan",
    });
    const authorization = planAuthorization(claim!);
    await store.buildTenantPurgePlanPage(authorization, { limit: 33 });

    // Model a management-plane race/misconfiguration after T3c by using the real canonical hold
    // writer while temporarily restoring writability, then restore the durable deleting fence.
    const lifecycleKey = subjectLifecycleKey(tenantId, "tenant", tenantId);
    const deleting = structuredClone(store.subjectLifecycles.get(lifecycleKey)!);
    const admission = store.tenantErasureAdmissions.get(source.request.requestId)!;
    const fence = store.tenantCredentialRevocationFences.get(tenantId)!;
    store.tenantErasureAdmissions.delete(source.request.requestId);
    store.tenantCredentialRevocationFences.delete(tenantId);
    store.subjectLifecycles.set(lifecycleKey, {
      ...deleting,
      state: "active",
      activeRequestId: undefined,
    });
    const hold = await store.setLegalHold({
      tenantId,
      holdId: "hold_after_t3c",
      subjectKind: "tenant",
      subjectId: tenantId,
      reasonCode: "litigation",
      expectedControlGeneration: 0,
      actorKeyId: "legal-admin",
      atMs: nowMs,
    });
    store.tenantErasureAdmissions.set(source.request.requestId, admission);
    store.tenantCredentialRevocationFences.set(tenantId, fence);
    store.subjectLifecycles.set(lifecycleKey, {
      ...deleting,
      legalHoldAtMs: hold.createdAtMs,
    });

    await expect(store.sealTenantPurgePlan(authorization))
      .rejects.toMatchObject({ reason: "active_legal_hold" });
    expect(await store.getTenantPurgePlanReceipt(tenantId, source.request.requestId)).toBeNull();
    expect(store.tenantPurgePlanJobs.get(source.request.requestId)).toMatchObject({
      phase: "queued",
      scanComplete: true,
    });
  });

  it("rechecks canonical holds for every known tenant user before sealing", async () => {
    const nowMs = 7_100;
    const store = new MemorySessionStore({ now: () => nowMs });
    const tenantId = "tenant-purge-plan-user-hold";
    const userId = "held-user";
    await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
    await store.createSession(mkSession(tenantId, userId));
    const source = await advanceThroughT3c(store, tenantId);
    await store.materializeTenantPurgePlanJobs({ limit: 1 });
    const [claim] = await store.claimTenantPurgePlans({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "user-hold-plan",
    });
    const authorization = planAuthorization(claim!);
    await store.buildTenantPurgePlanPage(authorization, { limit: 33 });

    // Use the real management writer while temporarily restoring writability,
    // then restore the tenant's durable deleting fence.
    const tenantLifecycleKey = subjectLifecycleKey(tenantId, "tenant", tenantId);
    const deleting = structuredClone(store.subjectLifecycles.get(tenantLifecycleKey)!);
    const admission = store.tenantErasureAdmissions.get(source.request.requestId)!;
    const fence = store.tenantCredentialRevocationFences.get(tenantId)!;
    store.tenantErasureAdmissions.delete(source.request.requestId);
    store.tenantCredentialRevocationFences.delete(tenantId);
    store.subjectLifecycles.set(tenantLifecycleKey, {
      ...deleting,
      state: "active",
      activeRequestId: undefined,
    });
    await store.setLegalHold({
      tenantId,
      holdId: "hold_user_after_t3c",
      subjectKind: "user",
      subjectId: userId,
      reasonCode: "litigation",
      expectedControlGeneration: 0,
      actorKeyId: "legal-admin",
      atMs: nowMs,
    });
    store.tenantErasureAdmissions.set(source.request.requestId, admission);
    store.tenantCredentialRevocationFences.set(tenantId, fence);
    store.subjectLifecycles.set(tenantLifecycleKey, deleting);

    await expect(store.sealTenantPurgePlan(authorization))
      .rejects.toMatchObject({ reason: "active_legal_hold" });
    expect(await store.getTenantPurgePlanReceipt(tenantId, source.request.requestId)).toBeNull();
    expect(store.tenantPurgePlanJobs.get(source.request.requestId)).toMatchObject({
      phase: "queued",
      scanComplete: true,
    });
  });

  it("detects diagnostic-page drift, and atomically rolls back direct-seal entry writes", async () => {
    const driftStore = new MemorySessionStore({ now: () => 8_000 });
    const driftTenant = "tenant-purge-plan-drift";
    const driftSource = await advanceThroughT3c(driftStore, driftTenant);
    await driftStore.materializeTenantPurgePlanJobs({ limit: 1 });
    const [driftClaim] = await driftStore.claimTenantPurgePlans({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "drift-plan",
    });
    const driftAuthorization = planAuthorization(driftClaim!);
    await driftStore.buildTenantPurgePlanPage(driftAuthorization, { limit: 3 });
    driftStore.agents.set(
      JSON.stringify([driftTenant, "late-agent", 1]),
      agent(driftTenant),
    );
    await expect(driftStore.buildTenantPurgePlanPage(driftAuthorization, { limit: 30 }))
      .rejects.toBeInstanceOf(TenantPurgePlanEvidenceChangedError);
    expect(driftStore.tenantPurgePlanEntries.size).toBe(3);
    expect(driftStore.tenantPurgePlanJobs.get(driftSource.request.requestId)).toMatchObject({
      planEntryCount: 3,
      cursorDomain: "agent_definitions",
      scanComplete: false,
    });

    const rollbackStore = new MemorySessionStore({ now: () => 8_100 });
    const rollbackSource = await advanceThroughT3c(rollbackStore, "tenant-purge-plan-rollback");
    await rollbackStore.materializeTenantPurgePlanJobs({ limit: 1 });
    const [rollbackClaim] = await rollbackStore.claimTenantPurgePlans({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "rollback-plan",
    });
    rollbackStore.tenantPurgePlanEntries = new FailOnceMap([], 2);
    await expect(rollbackStore.sealTenantPurgePlan(planAuthorization(rollbackClaim!)))
      .rejects.toThrow("injected plan entry write failure");
    expect(rollbackStore.tenantPurgePlanEntries.size).toBe(0);
    expect(rollbackStore.tenantPurgePlanReceipts.size).toBe(0);
    expect(rollbackStore.tenantPurgePlanJobs.get(rollbackSource.request.requestId)).toMatchObject({
      planEntryCount: 0,
      blockerCount: 0,
      scanComplete: false,
    });
  });

  it("fails closed on an unattributable child row before page or aggregate publication", async () => {
    const store = new MemorySessionStore({ now: () => 8_500 });
    const tenantId = "tenant-purge-plan-orphan";
    const source = await advanceThroughT3c(store, tenantId);
    await store.materializeTenantPurgePlanJobs({ limit: 1 });
    const [claim] = await store.claimTenantPurgePlans({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "orphan-plan",
    });
    const authorization = planAuthorization(claim!);
    const orphan = {
      outboxId: 99,
      blobId: "blob_missing_parent",
      generation: 1,
      storageBackend: "memory",
      storageFormat: "raw-v1",
      storageKey: "opaque",
      uploadToken: "opaque-token",
      availableAtMs: 8_500,
      attempts: 0,
      createdAtMs: 8_500,
    };
    store.blobDeleteOutbox.set("orphan-before-page", orphan);

    await expect(store.buildTenantPurgePlanPage(authorization, { limit: 33 }))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    expect(store.tenantPurgePlanEntries.size).toBe(0);
    expect(store.tenantPurgePlanJobs.get(source.request.requestId)).toMatchObject({
      phase: "queued",
      planEntryCount: 0,
      scanComplete: false,
    });

    store.blobDeleteOutbox.delete("orphan-before-page");
    await expect(store.buildTenantPurgePlanPage(authorization, { limit: 33 }))
      .resolves.toMatchObject({ built: 33, done: true });
    store.blobDeleteOutbox.set("orphan-before-seal", orphan);
    await expect(store.sealTenantPurgePlan(authorization))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    expect(await store.getTenantPurgePlanReceipt(tenantId, source.request.requestId)).toBeNull();
    expect(store.tenantPurgePlanJobs.get(source.request.requestId)).toMatchObject({
      phase: "queued",
      planEntryCount: 33,
      scanComplete: true,
    });
  });

  it("rejects cross-owner runtime and erasure indexes before atomic seal", async () => {
    const nowMs = 8_550;
    const store = new MemorySessionStore({ now: () => nowMs });
    const tenantId = "tenant-purge-plan-owner-relations";
    const session = mkSession(tenantId, "owner-user");
    await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
    await store.createSession(session);
    const turn: Turn = {
      id: newId("turn"),
      sessionId: session.id,
      status: "inProgress",
      seqStart: 2,
      steps: 0,
      toolCalls: 0,
      usage: emptyUsage(),
      startedAtMs: nowMs,
    };
    await store.commit({
      sessionId: session.id,
      fence: 1,
      turn,
      events: [{
        type: "turn/started",
        sessionId: session.id,
        emittedAtMs: nowMs,
        turn,
      }],
    });
    const source = await advanceThroughT3c(store, tenantId);
    await store.materializeTenantPurgePlanJobs({ limit: 1 });
    const [claim] = await store.claimTenantPurgePlans({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "owner-relation-plan",
    });
    const authorization = planAuthorization(claim!);
    const expectNoPublication = async () => {
      await expect(store.sealTenantPurgePlan(authorization))
        .rejects.toBeInstanceOf(TenantErasureIntegrityError);
      expect(store.tenantPurgePlanEntries.size).toBe(0);
      expect(store.tenantPurgePlanReceipts.size).toBe(0);
      expect(store.tenantPurgePlanJobs.get(source.request.requestId)).toMatchObject({
        phase: "queued",
        planEntryCount: 0,
        scanComplete: false,
      });
    };

    const badIdempotencyKey = JSON.stringify([
      "foreign-tenant",
      session.userId,
      session.id,
      "cross-owner-idempotency",
    ]);
    store.idem.set(badIdempotencyKey, {
      value: null,
      requestHash: "a".repeat(64),
      expiresAt: nowMs + 60_000,
    });
    await expectNoPublication();
    store.idem.delete(badIdempotencyKey);

    const completedIdempotencyKey = JSON.stringify([
      tenantId,
      session.userId,
      session.id,
      "completed-idempotency",
    ]);
    const completedIdempotency = store.idem as Map<string, {
      value: { turnId: string; sessionId?: string } | null;
      requestHash?: string;
      expiresAt: number;
    }>;
    completedIdempotency.set(completedIdempotencyKey, {
      value: { turnId: newId("turn") },
      requestHash: "a".repeat(64),
      expiresAt: nowMs + 60_000,
    });
    await expectNoPublication();
    completedIdempotency.set(completedIdempotencyKey, {
      value: { turnId: turn.id, sessionId: newId("sess") },
      requestHash: "a".repeat(64),
      expiresAt: nowMs + 60_000,
    });
    await expectNoPublication();
    // Frozen historical databases can carry the completed legacy shape with no sessionId. The
    // scoped row plus the referenced turn still bind it unambiguously to this session.
    completedIdempotency.set(completedIdempotencyKey, {
      value: { turnId: turn.id },
      requestHash: "a".repeat(64),
      expiresAt: nowMs + 60_000,
    });

    store.usageLedger.push({
      tenantId: "foreign-tenant",
      userId: session.userId,
      sessionId: session.id,
      turnId: newId("turn"),
      step: 0,
      provider: "provider-a",
      model: "model-a",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
      },
      createdAtMs: nowMs,
    });
    await expectNoPublication();
    store.usageLedger.length = 0;

    const reconciliationKey = JSON.stringify([session.id, 1]);
    store.usageReconciliations.set(reconciliationKey, {
      tenantId: "foreign-tenant",
      userId: session.userId,
      sessionId: session.id,
      deletionGeneration: 1,
      status: "verified",
      rowCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      knownCostRows: 0,
      checksum: "b".repeat(64),
      verifiedAtMs: nowMs,
    });
    await expectNoPublication();
    store.usageReconciliations.delete(reconciliationKey);

    const erasureIdempotency = (store as unknown as {
      erasureIdempotency: Map<string, string>;
    }).erasureIdempotency;
    const badErasureKey = JSON.stringify([
      "foreign-tenant",
      "tenant",
      tenantId,
      source.request.idempotencyKey,
    ]);
    erasureIdempotency.set(badErasureKey, source.request.requestId);
    await expectNoPublication();
    erasureIdempotency.delete(badErasureKey);

    const legacyTenantId = "legacy-owner-tenant";
    const legacyUserId = "legacy-owner-user";
    await store.setTenantAuth(legacyTenantId, DEFAULT_AUTH_POLICY);
    const legacySession = mkSession(legacyTenantId, legacyUserId);
    await store.createSession(legacySession);
    const legacyDeletedAtMs = Math.max(
      legacySession.createdAtMs,
      legacySession.updatedAtMs,
    ) + 1;
    await store.commit({
      sessionId: legacySession.id,
      fence: 1,
      lifecycle: {
        type: "tombstone",
        tenantId: legacyTenantId,
        userId: legacyUserId,
        deletionGeneration: 1,
        atMs: legacyDeletedAtMs,
      },
      events: [{
        type: "session/deleted",
        sessionId: legacySession.id,
        deletionGeneration: 1,
        emittedAtMs: legacyDeletedAtMs,
      }],
    });
    const legacySourceRequestId = newErasureRequestId();
    const legacySourceRequest = await store.requestUserErasure({
      requestId: legacySourceRequestId,
      tenantId: legacyTenantId,
      userId: legacyUserId,
      requestedByKeyId: "legacy-source-admin",
      idempotencyKey: `legacy-source-${randomUUID()}`,
      requestHash: userErasureRequestHash(legacyTenantId, legacyUserId),
      atMs: legacyDeletedAtMs + 1,
    });
    const storedLegacySession = store.sessions.get(legacySession.id)!;
    const legacyJobId = legacyTombstoneCompensationJobIdForSession(legacySession.id);
    const legacyCompletedAtMs = legacyDeletedAtMs + 2;
    const legacyJob = {
      jobId: legacyJobId,
      tenantId: legacyTenantId,
      userId: legacyUserId,
      sessionId: legacySession.id,
      sourceKind: "erasure_claim" as const,
      sourceRequestId: legacySourceRequestId,
      sourceSubjectGeneration: legacySourceRequest.generation,
      sourceClaimAttempt: 1,
      sourceClaimTokenSha256: "c".repeat(64),
      cutoverGeneration: 1 as const,
      legacyDeletedAtMs,
      status: "completed" as const,
      createdAtMs: legacyDeletedAtMs,
      updatedAtMs: legacyCompletedAtMs,
      attempts: 1,
      completedAtMs: legacyCompletedAtMs,
      completedEventSeq: storedLegacySession.lastSeq,
      completedClaimAttempt: 1,
      completedClaimTokenSha256: "d".repeat(64),
    };
    const legacyEvidenceSha256 = legacyTombstoneSuccessEvidenceSha256({
      jobId: legacyJobId,
      tenantId: legacyTenantId,
      userId: legacyUserId,
      sessionId: legacySession.id,
      cutoverGeneration: 1,
      legacyDeletedAtMs,
      deletionGeneration: 1,
      eventSeq: storedLegacySession.lastSeq,
      claimAttempt: 1,
      emittedAtMs: legacyCompletedAtMs,
    });
    const legacyAudit = {
      auditId: 10_000,
      jobId: legacyJobId,
      type: "legacy_tombstone/compensated" as const,
      sessionId: legacySession.id,
      cutoverGeneration: 1 as const,
      deletionGeneration: 1 as const,
      eventSeq: storedLegacySession.lastSeq,
      claimAttempt: 1,
      evidenceSha256: legacyEvidenceSha256,
      emittedAtMs: legacyCompletedAtMs,
    };
    store.legacyTombstoneCompensationAudits.set(legacyJobId, [legacyAudit]);
    // A forged tenant attribute would otherwise make the evidence scan count this job for the
    // planned tenant and omit it from the session's real owner.
    store.legacyTombstoneCompensationJobs.set(legacyJobId, {
      ...legacyJob,
      tenantId,
    });
    await expectNoPublication();
    // Even with the physical owner repaired, an erasure-claim source must bind the exact user
    // request and generation that authorized enqueue.
    store.legacyTombstoneCompensationJobs.set(legacyJobId, {
      ...legacyJob,
      sourceSubjectGeneration: legacySourceRequest.generation + 1,
    });
    await expectNoPublication();
    const forgedCompletedEventSeq = storedLegacySession.lastSeq + 1;
    store.legacyTombstoneCompensationJobs.set(legacyJobId, {
      ...legacyJob,
      completedEventSeq: forgedCompletedEventSeq,
    });
    store.legacyTombstoneCompensationAudits.set(legacyJobId, [{
      ...legacyAudit,
      eventSeq: forgedCompletedEventSeq,
      evidenceSha256: legacyTombstoneSuccessEvidenceSha256({
        jobId: legacyJobId,
        tenantId: legacyTenantId,
        userId: legacyUserId,
        sessionId: legacySession.id,
        cutoverGeneration: 1,
        legacyDeletedAtMs,
        deletionGeneration: 1,
        eventSeq: forgedCompletedEventSeq,
        claimAttempt: 1,
        emittedAtMs: legacyCompletedAtMs,
      }),
    }]);
    await expectNoPublication();
    store.legacyTombstoneCompensationJobs.set(legacyJobId, legacyJob);
    store.legacyTombstoneCompensationAudits.set(legacyJobId, [legacyAudit]);

    await expect(store.sealTenantPurgePlan(authorization)).resolves.toMatchObject({
      planComplete: true,
      executionReady: false,
    });
  });

  it("binds every erasure request and purge target to its live lifecycle and tombstone", async () => {
    const nowMs = 8_575;
    const store = new MemorySessionStore({ now: () => nowMs });
    const tenantId = "tenant-purge-plan-subject-relations";
    let userSource: Awaited<ReturnType<typeof prepareUserPurgeTarget>> | undefined;
    const source = await advanceThroughT3c(store, tenantId, {
      beforeTenantErasure: async (candidateStore, candidateTenantId) => {
        userSource = await prepareUserPurgeTarget(
          candidateStore,
          candidateTenantId,
          "purge-target-user",
          8_000,
        );
      },
    });
    if (!userSource) throw new Error("expected user purge target source");
    await store.materializeTenantPurgePlanJobs({ limit: 1 });
    const [claim] = await store.claimTenantPurgePlans({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "subject-relation-plan",
    });
    const authorization = planAuthorization(claim!);
    const expectNoPublication = async () => {
      await expect(store.sealTenantPurgePlan(authorization))
        .rejects.toBeInstanceOf(TenantErasureIntegrityError);
      expect(store.tenantPurgePlanEntries.size).toBe(0);
      expect(store.tenantPurgePlanReceipts.size).toBe(0);
      expect(store.tenantPurgePlanJobs.get(source.request.requestId)).toMatchObject({
        phase: "queued",
        planEntryCount: 0,
        scanComplete: false,
      });
    };

    const [targetKey, target] = userSource.targetEntry;
    store.erasurePurgeTargets.set(targetKey, {
      ...target,
      sessionId: newId("sess"),
    });
    await expectNoPublication();
    store.erasurePurgeTargets.set(targetKey, {
      ...target,
      deletionGeneration: target.deletionGeneration + 1,
    });
    await expectNoPublication();
    store.erasurePurgeTargets.set(targetKey, {
      ...target,
      deletedAtMs: target.deletedAtMs + 1,
    });
    await expectNoPublication();
    store.erasurePurgeTargets.set(targetKey, target);

    const userLifecycleKey = subjectLifecycleKey(tenantId, "user", "purge-target-user");
    const userLifecycle = store.subjectLifecycles.get(userLifecycleKey)!;
    const userRequest = store.erasureRequests.get(userSource.requestId)!;
    store.erasureRequests.set(userSource.requestId, {
      ...userRequest,
      subjectKind: "tenant",
      subjectId: tenantId,
    });
    await expectNoPublication();
    store.erasureRequests.set(userSource.requestId, userRequest);
    store.subjectLifecycles.set(userLifecycleKey, {
      ...userLifecycle,
      activeRequestId: newErasureRequestId(),
    });
    await expectNoPublication();
    store.subjectLifecycles.set(userLifecycleKey, userLifecycle);

    const orphanUserId = "orphan-deleting-user";
    const orphanLifecycleKey = subjectLifecycleKey(tenantId, "user", orphanUserId);
    store.subjectLifecycles.set(orphanLifecycleKey, {
      tenantId,
      subjectKind: "user",
      subjectId: orphanUserId,
      state: "deleting",
      generation: 1,
      activeRequestId: newErasureRequestId(),
      createdAtMs: 8_100,
      updatedAtMs: 8_100,
    });
    await expectNoPublication();
    store.subjectLifecycles.delete(orphanLifecycleKey);

    const tenantLifecycleKey = subjectLifecycleKey(tenantId, "tenant", tenantId);
    const tenantLifecycle = store.subjectLifecycles.get(tenantLifecycleKey)!;
    store.subjectLifecycles.set(tenantLifecycleKey, {
      ...tenantLifecycle,
      generation: tenantLifecycle.generation + 1,
    });
    await expectNoPublication();
    store.subjectLifecycles.set(tenantLifecycleKey, tenantLifecycle);

    await expect(store.sealTenantPurgePlan(authorization)).resolves.toMatchObject({
      planComplete: true,
      executionReady: false,
    });
  });

  it("atomically seals with a normal generation-zero export created before tenant erasure", async () => {
    const nowMs = 8_600;
    const store = new MemorySessionStore({ now: () => nowMs });
    const tenantId = "tenant-purge-plan-export-generation-zero";
    const userId = "generation-zero-user";
    const exportRequestId = newUserDataExportRequestId();
    const source = await advanceThroughT3c(store, tenantId, {
      beforeTenantErasure: async () => {
        await store.requestUserDataExport({
          requestId: exportRequestId,
          tenantId,
          userId,
          requestedByKeyId: "export-admin",
          idempotencyKeySha256: "b".repeat(64),
          requestHash: userDataExportRequestHash(tenantId, userId),
        });
      },
    });
    expect(store.userDataExportRequests.get(exportRequestId)).toMatchObject({
      subjectGeneration: 0,
      currentBuildGeneration: 0,
      status: "queued",
    });
    expect(store.userDataExportJobs.get(exportRequestId)).toMatchObject({
      buildGeneration: 0,
      status: "queued",
    });

    await store.materializeTenantPurgePlanJobs({ limit: 1 });
    const [claim] = await store.claimTenantPurgePlans({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "generation-zero-export-plan",
    });
    const authorization = planAuthorization(claim!);
    await expect(store.sealTenantPurgePlan(authorization)).resolves.toMatchObject({
      planComplete: true,
      executionReady: false,
    });
    const entries = await store.getTenantPurgePlanEntries(
      tenantId,
      source.request.requestId,
      1,
    );
    expect(entries.find((entry) => entry.domain === "user_export_control"))
      .toMatchObject({ targetCount: 3, disposition: "delete" });
  });

  it("distinguishes concurrent export download leases without persisting bearer tokens", async () => {
    const nowMs = 8_700;
    const store = new MemorySessionStore({ now: () => nowMs });
    const tenantId = "tenant-purge-plan-download-leases";
    const userId = "download-user";
    const requestId = `export_${randomUUID()}`;
    const artifactId = `xart_${randomUUID()}`;
    const hash = "a".repeat(64);
    const leaseTokens = ["download-lease-alpha", "download-lease-beta"];
    const source = await advanceThroughT3c(store, tenantId, {
      beforeTenantErasure: async () => {
        const request = await store.requestUserDataExport({
          requestId,
          tenantId,
          userId,
          requestedByKeyId: "export-admin",
          idempotencyKeySha256: hash,
          requestHash: userDataExportRequestHash(tenantId, userId),
        });
        store.userDataExportRequests.set(requestId, {
          ...request,
          status: "ready",
          currentBuildGeneration: 1,
          currentArtifactId: artifactId,
          snapshotAtMs: nowMs,
          readyAtMs: nowMs,
          expiresAtMs: nowMs + 60_000,
          artifactSha256: hash,
          artifactSizeBytes: 0,
          recordCount: 0,
          updatedAtMs: nowMs,
        });
        store.userDataExportJobs.set(requestId, {
          requestId,
          status: "completed",
          buildGeneration: 1,
          attempts: 1,
          currentArtifactId: artifactId,
          completedAtMs: nowMs,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        });
        store.userDataExportArtifacts.set(artifactId, {
          artifactId,
          requestId,
          tenantId,
          userId,
          subjectGeneration: 0,
          buildGeneration: 1,
          state: "ready",
          format: "ndjson-v1",
          schemaVersion: 1,
          contentType: "application/vnd.agent-service.user-export+ndjson",
          storageBackend: "memory",
          storageFormat: "raw-v1",
          policyVersion: request.policyVersion,
          policySha256: request.policySha256,
          snapshotRootSha256: hash,
          artifactTtlMs: 60_000,
          partCount: 0,
          recordCount: 0,
          totalSizeBytes: 0,
          contentSha256: hash,
          manifestSha256: hash,
          snapshotAtMs: nowMs,
          stagingExpiresAtMs: nowMs + 60_000,
          readyAtMs: nowMs,
          expiresAtMs: nowMs + 60_000,
          deletionGeneration: 0,
          createdAtMs: nowMs,
        });
        for (const leaseToken of leaseTokens) {
          store.userDataExportDownloadLeases.set(JSON.stringify([artifactId, leaseToken]), {
            artifactId,
            requestId,
            tenantId,
            userId,
            leaseToken,
            leaseUntilMs: nowMs + 30_000,
            createdAtMs: nowMs,
          });
        }
      },
    });

    await store.materializeTenantPurgePlanJobs({ limit: 1 });
    const [claim] = await store.claimTenantPurgePlans({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "download-lease-plan",
    });
    const authorization = planAuthorization(claim!);
    await expect(store.sealTenantPurgePlan(authorization)).resolves.toMatchObject({
      planComplete: true,
      executionReady: false,
    });
    const entries = await store.getTenantPurgePlanEntries(
      tenantId,
      source.request.requestId,
      1,
    );
    expect(entries.find((entry) => entry.domain === "user_export_control"))
      .toMatchObject({ targetCount: 5, disposition: "delete" });
    const serialized = JSON.stringify(entries);
    for (const token of leaseTokens) expect(serialized).not.toContain(token);
  });

  it("rolls back a page that crosses its lease and preserves claim-attempt ABA", async () => {
    let nowMs = 9_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    const source = await advanceThroughT3c(store, "tenant-purge-plan-lease");
    await store.materializeTenantPurgePlanJobs({ limit: 1 });
    const [left, right] = await Promise.all([
      store.claimTenantPurgePlans({
        limit: 1,
        leaseMs: 10,
        claimToken: "left-plan-claim",
      }),
      store.claimTenantPurgePlans({
        limit: 1,
        leaseMs: 10,
        claimToken: "right-plan-claim",
      }),
    ]);
    expect(left.length + right.length).toBe(1);
    const first = (left[0] ?? right[0])!;
    const firstAuthorization = planAuthorization(first);
    class LeaseCrossingMap<K, V> extends Map<K, V> {
      override set(key: K, value: V): this {
        const result = super.set(key, value);
        nowMs = 9_010;
        return result;
      }
    }
    store.tenantPurgePlanEntries = new LeaseCrossingMap();
    await expect(store.buildTenantPurgePlanPage(firstAuthorization, { limit: 33 }))
      .rejects.toThrow(/lease expired/);
    expect(store.tenantPurgePlanEntries.size).toBe(0);
    expect(store.tenantPurgePlanJobs.get(source.request.requestId)).toMatchObject({
      attempts: 1,
      planEntryCount: 0,
    });
    expect(await store.renewTenantPurgePlan(firstAuthorization, { leaseMs: 100 })).toBe(false);
    const [second] = await store.claimTenantPurgePlans({
      limit: 1,
      leaseMs: 100,
      claimToken: "second-plan-claim",
    });
    expect(second).toMatchObject({ claimAttempt: 2 });
    expect(await store.renewTenantPurgePlan(firstAuthorization, { leaseMs: 100 })).toBe(false);
    expect(await store.retryTenantPurgePlan(planAuthorization(second!), {
      delayMs: 25,
      errorCode: "temporary_failure",
    })).toBe(true);
    expect(store.tenantPurgePlanJobs.get(source.request.requestId)).toMatchObject({
      attempts: 2,
      availableAtMs: 9_035,
      lastErrorCode: "temporary_failure",
    });
  });

  it("publishes a healthy neighbor before reporting a damaged T3c source", async () => {
    const store = new MemorySessionStore({ now: () => 10_000 });
    const damaged = await advanceThroughT3c(store, "tenant-purge-plan-damaged", {
      requestId: "erase_00000000-0000-4000-8000-000000000031",
    });
    const healthy = await advanceThroughT3c(store, "tenant-purge-plan-healthy", {
      requestId: "erase_ffffffff-ffff-4fff-bfff-fffffffffff3",
    });
    store.tenantContentInventoryReceipts.delete(damaged.request.requestId);

    await expect(store.materializeTenantPurgePlanJobs({ limit: 1 }))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    expect(store.tenantPurgePlanJobs.has(damaged.request.requestId)).toBe(false);
    expect(store.tenantPurgePlanJobs.get(healthy.request.requestId)).toMatchObject({
      phase: "queued",
      attempts: 0,
    });
    await expect(store.claimTenantPurgePlans({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "healthy-neighbor-plan",
    })).resolves.toEqual([
      expect.objectContaining({ requestId: healthy.request.requestId, claimAttempt: 1 }),
    ]);
  });

  it("requires every export and erasure request to retain its reverse idempotency index", async () => {
    let nowMs = 10_100;
    const store = new MemorySessionStore({ now: () => nowMs });
    const tenantId = "tenant-purge-plan-reverse-idempotency";
    const userId = "reverse-idempotency-user";
    const exportRequestId = newUserDataExportRequestId();
    const exportIdempotencyKeySha256 = "c".repeat(64);
    let userRequestId: string | undefined;
    let userIdempotencyKey: string | undefined;
    const source = await advanceThroughT3c(store, tenantId, {
      beforeTenantErasure: async () => {
        await store.requestUserDataExport({
          requestId: exportRequestId,
          tenantId,
          userId,
          requestedByKeyId: "export-admin",
          idempotencyKeySha256: exportIdempotencyKeySha256,
          requestHash: userDataExportRequestHash(tenantId, userId),
        });
        const userSource = await prepareUserPurgeTarget(store, tenantId, userId, 10_200);
        userRequestId = userSource.requestId;
        const userRequest = store.erasureRequests.get(userRequestId)!;
        userIdempotencyKey = userRequest.idempotencyKey;
        nowMs = 10_300;
      },
    });
    if (!userRequestId || !userIdempotencyKey) {
      throw new Error("expected user erasure request");
    }
    await store.materializeTenantPurgePlanJobs({ limit: 1 });
    const [claim] = await store.claimTenantPurgePlans({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "reverse-idempotency-plan",
    });
    const authorization = planAuthorization(claim!);
    const expectNoPublication = async () => {
      await expect(store.sealTenantPurgePlan(authorization))
        .rejects.toBeInstanceOf(TenantErasureIntegrityError);
      expect(store.tenantPurgePlanEntries.size).toBe(0);
      expect(store.tenantPurgePlanReceipts.size).toBe(0);
    };
    const privateIndexes = store as unknown as {
      userDataExportIdempotency: Map<string, string>;
      erasureIdempotency: Map<string, string>;
    };
    const exportKey = JSON.stringify([tenantId, userId, exportIdempotencyKeySha256]);
    const userKey = JSON.stringify([tenantId, "user", userId, userIdempotencyKey]);
    const tenantKey = JSON.stringify([
      tenantId,
      "tenant",
      tenantId,
      source.request.idempotencyKey,
    ]);

    privateIndexes.userDataExportIdempotency.delete(exportKey);
    await expectNoPublication();
    privateIndexes.userDataExportIdempotency.set(exportKey, exportRequestId);
    privateIndexes.erasureIdempotency.delete(userKey);
    await expectNoPublication();
    privateIndexes.erasureIdempotency.set(userKey, userRequestId);
    privateIndexes.erasureIdempotency.delete(tenantKey);
    await expectNoPublication();
    privateIndexes.erasureIdempotency.set(tenantKey, source.request.requestId);

    await expect(store.sealTenantPurgePlan(authorization)).resolves.toMatchObject({
      planComplete: true,
      executionReady: false,
    });
  });
});
