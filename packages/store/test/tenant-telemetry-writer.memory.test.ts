import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MemorySessionStore,
  SubjectDeletingError,
  TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
  TenantTelemetryWriteConflictError,
  newErasureRequestId,
  tenantErasureRequestHash,
  tenantTelemetryWriteAdapterEvidenceSha256,
  tenantTelemetryArtifactMembershipSha256,
  tenantTelemetryArtifactOwnerBindingSha256,
  tenantTelemetryRefKeyIdSha256,
  type EnqueueTenantTelemetryArtifactInput,
  type TenantTelemetryWriteAdapterResult,
  type TenantTelemetryWriteAuthorization,
  type TenantTelemetryWriteClaim,
} from "../src/index.js";
import { mkSession } from "./conformance.js";
import {
  statefulTelemetryEnqueueCaptureFixture,
  trustedRunnerTelemetryRecord,
} from "./tenant-telemetry-adapter.fixture.js";

const D = (character: string) => character.repeat(64);
const REF_KEY = new Uint8Array(32).fill(13);
const LEGACY_REF_KEY = new Uint8Array(32).fill(14);

const activation = () => ({
  expectedControlGeneration: 0 as const,
  targets: [
    {
      domain: "logs" as const,
      backendKind: "memory",
      adapterProtocol: "telemetry-memory-v1",
      namespaceSha256: D("1"),
      failureDomainSha256: D("2"),
    },
    {
      domain: "traces" as const,
      backendKind: "memory",
      adapterProtocol: "telemetry-memory-v1",
      namespaceSha256: D("3"),
      failureDomainSha256: D("4"),
    },
  ],
});

function input(
  tenantId: string,
  overrides: Partial<EnqueueTenantTelemetryArtifactInput> = {},
  refKey: Uint8Array = REF_KEY,
): EnqueueTenantTelemetryArtifactInput {
  const ownerKind = overrides.ownerKind ?? "tenant";
  const ownerId = overrides.ownerId ?? tenantId;
  return {
    tenantId,
    expectedControlGeneration: 1,
    domain: "logs",
    artifactIdSha256: D("5"),
    artifactGeneration: 1,
    ownerKind,
    ownerId,
    ownerUserId: null,
    sourceSchema: "structured-log-batch-v1",
    sourceGeneration: 0,
    sourceHighWaterDbMs: 1_100,
    payload: {
      schema: TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
      domain: "logs",
      records: [trustedRunnerTelemetryRecord(1_100, {
        opaqueRefKey: refKey,
        tenantValue: tenantId,
        ownerKind,
        ownerValue: ownerId,
        attempt: 1,
      })],
    },
    ...overrides,
  };
}

function authorization(claim: TenantTelemetryWriteClaim): TenantTelemetryWriteAuthorization {
  return {
    writeOperationSha256: claim.writeOperationSha256,
    tenantId: claim.tenantId,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function adapterResult(
  claim: TenantTelemetryWriteClaim,
  replayed = false,
): TenantTelemetryWriteAdapterResult {
  const evidence = {
    adapterProtocol: claim.target.adapterProtocol,
    domain: claim.inventory.domain,
    targetSha256: claim.target.targetSha256,
    writeOperationSha256: claim.writeOperationSha256,
    artifactIdSha256: claim.inventory.artifactIdSha256,
    artifactGeneration: claim.inventory.artifactGeneration,
    payloadSha256: claim.inventory.payloadSha256,
    manifestSha256: claim.inventory.manifestSha256,
    outcome: "written" as const,
    replayed,
  };
  return {
    ...evidence,
    evidenceSha256: tenantTelemetryWriteAdapterEvidenceSha256(evidence),
  };
}

async function activeStore(now: () => number): Promise<MemorySessionStore> {
  const store = new MemorySessionStore(
    { now },
    { tenantTelemetryRefKey: REF_KEY },
  );
  await store.activateTenantTelemetryLifecycle(activation());
  return store;
}

describe("MemorySessionStore durable tenant telemetry writer", () => {
  it("atomically preserves a content-free per-write membership without granting deletion", async () => {
    let nowMs = 1_000;
    const store = await activeStore(() => nowMs);
    nowMs = 1_100;
    const tenantId = "writer-membership";
    await store.createApiKey(tenantId, "key", "hash");
    const writeInput = input(tenantId);
    const job = await store.enqueueTenantTelemetryArtifact(writeInput);
    const membership = await store.getTenantTelemetryArtifactMembership(
      tenantId,
      job.writeOperationSha256,
    );
    expect(membership).toMatchObject({
      writeOperationSha256: job.writeOperationSha256,
      tenantId,
      inventorySha256: job.inventory.inventorySha256,
      applicationBindingReceiptSha256: null,
      ownerBindingSha256: tenantTelemetryArtifactOwnerBindingSha256({
        tenantId,
        ownerKind: "tenant",
        ownerId: tenantId,
        ownerUserId: null,
      }, REF_KEY),
      refKeyIdSha256: tenantTelemetryRefKeyIdSha256(REF_KEY),
    });
    expect(membership?.membershipSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(membership)).not.toContain("claimToken");
    await expect(store.getTenantTelemetryArtifactMembership(
      "foreign-tenant",
      job.writeOperationSha256,
    )).resolves.toBeNull();
    await expect(store.enqueueTenantTelemetryArtifact(writeInput)).resolves.toEqual(job);
    await expect(store.getTenantTelemetryArtifactMembership(
      tenantId,
      job.writeOperationSha256,
    )).resolves.toEqual(membership);
    // There is no T3f owner-closure proof, no executable T3d target and no grant issuance.
    expect(store.tenantTelemetryDispositionAuthorizationGrants).toHaveLength(0);
  });

  it("rejects a second pending operation for the same artifact slot without changing its sidecar", async () => {
    let nowMs = 1_000;
    const store = await activeStore(() => nowMs);
    nowMs = 1_100;
    const tenantId = "writer-membership-duplicate-slot";
    await store.createApiKey(tenantId, "key", "hash");
    const first = await store.enqueueTenantTelemetryArtifact(input(tenantId));
    const membership = await store.getTenantTelemetryArtifactMembership(
      tenantId, first.writeOperationSha256,
    );
    await expect(store.enqueueTenantTelemetryArtifact(input(tenantId, {
      sourceGeneration: 2,
    }))).rejects.toBeInstanceOf(TenantTelemetryWriteConflictError);
    expect(store.tenantTelemetryWriteJobs.size).toBe(1);
    expect(store.tenantTelemetryArtifactMemberships.size).toBe(1);
    await expect(store.getTenantTelemetryArtifactMembership(
      tenantId, first.writeOperationSha256,
    )).resolves.toEqual(membership);
  });

  it("fails closed on an orphan or forged membership without rewriting legacy absence", async () => {
    let nowMs = 1_000;
    const store = await activeStore(() => nowMs);
    nowMs = 1_100;
    await store.createApiKey("writer-membership-corrupt", "key", "hash");
    const job = await store.enqueueTenantTelemetryArtifact(input("writer-membership-corrupt"));
    const original = store.tenantTelemetryArtifactMemberships.get(job.writeOperationSha256)!;
    store.tenantTelemetryArtifactMemberships.delete(job.writeOperationSha256);
    await expect(store.getTenantTelemetryArtifactMembership(
      job.tenantId,
      job.writeOperationSha256,
    )).resolves.toBeNull(); // A pre-0038 job is unknown, never reconstructed.
    const { membershipSha256: _receipt, ...body } = original;
    store.tenantTelemetryArtifactMemberships.set(job.writeOperationSha256, {
      ...original,
      targetSha256: D("a"),
      membershipSha256: tenantTelemetryArtifactMembershipSha256({
        ...body,
        targetSha256: D("a"),
      }),
    });
    await expect(store.getTenantTelemetryArtifactMembership(
      job.tenantId,
      job.writeOperationSha256,
    )).rejects.toThrow();
    store.tenantTelemetryArtifactMemberships.set(job.writeOperationSha256, original);
    store.tenantTelemetryWriteJobs.delete(job.writeOperationSha256);
    await expect(store.getTenantTelemetryArtifactMembership(
      job.tenantId,
      job.writeOperationSha256,
    )).rejects.toThrow();
  });

  it("rejects a valid-shaped job whose creation time drifts from its membership", async () => {
    let nowMs = 1_000;
    const store = await activeStore(() => nowMs);
    nowMs = 1_100;
    await store.createApiKey("writer-membership-time-drift", "key", "hash");
    const job = await store.enqueueTenantTelemetryArtifact(input("writer-membership-time-drift"));
    const stored = store.tenantTelemetryWriteJobs.get(job.writeOperationSha256)!;
    if (stored.phase !== "queued") throw new Error("expected a queued telemetry job");
    store.tenantTelemetryWriteJobs.set(job.writeOperationSha256, {
      ...stored,
      createdAtMs: stored.createdAtMs + 1,
      updatedAtMs: stored.updatedAtMs + 1,
      availableAtMs: stored.availableAtMs + 1,
    });
    await expect(store.getTenantTelemetryArtifactMembership(
      job.tenantId, job.writeOperationSha256,
    )).rejects.toThrow();
  });

  it("rejects a syntax-valid literal record at live enqueue capture", async () => {
    let nowMs = 1_000;
    const store = await activeStore(() => nowMs);
    nowMs = 1_100;
    await store.createApiKey("writer-untrusted", "key", "hash");
    const writeInput = input("writer-untrusted");
    writeInput.payload = structuredClone(writeInput.payload);
    await expect(store.enqueueTenantTelemetryArtifact(writeInput))
      .rejects.toThrow(/not produced by createStructuredTelemetry/);
    expect(store.tenantTelemetryWriteJobs).toHaveLength(0);
    expect(store.tenantTelemetryWritePayloads).toHaveLength(0);
  });

  it("rejects trusted records bound to another producer key or lifecycle owner", async () => {
    let nowMs = 1_000;
    const store = await activeStore(() => nowMs);
    nowMs = 1_100;
    const tenantId = "writer-owner-binding";
    await store.createApiKey(tenantId, "key", "hash");

    const wrongKey = input(tenantId);
    wrongKey.payload = {
      ...wrongKey.payload,
      records: [trustedRunnerTelemetryRecord(nowMs, {
        opaqueRefKey: new Uint8Array(32).fill(99),
        ownerKind: "tenant",
        ownerValue: tenantId,
      })],
    };
    await expect(store.enqueueTenantTelemetryArtifact(wrongKey))
      .rejects.toThrow(/producer key/);

    const wrongOwner = input(tenantId);
    wrongOwner.payload = {
      ...wrongOwner.payload,
      records: [trustedRunnerTelemetryRecord(nowMs, {
        opaqueRefKey: REF_KEY,
        ownerKind: "tenant",
        ownerValue: "another-tenant",
      })],
    };
    await expect(store.enqueueTenantTelemetryArtifact(wrongOwner))
      .rejects.toThrow(/tenant binding/);

    const crossOwner = input(tenantId);
    crossOwner.payload = {
      ...crossOwner.payload,
      records: [trustedRunnerTelemetryRecord(nowMs, {
        opaqueRefKey: REF_KEY,
        ownerKind: "tenant",
        ownerValue: tenantId,
        subjectKind: "tenant",
        subjectValue: "another-tenant",
      })],
    };
    await expect(store.enqueueTenantTelemetryArtifact(crossOwner))
      .rejects.toThrow(/cross-owner lifecycle reference/);
    expect(store.tenantTelemetryWriteJobs).toHaveLength(0);
    expect(store.tenantTelemetryWritePayloads).toHaveLength(0);
  });

  it("binds the principal tenant alongside shared user and session owner references", async () => {
    let nowMs = 1_000;
    const store = await activeStore(() => nowMs);
    nowMs = 1_100;
    const tenantA = "writer-principal-a";
    const tenantB = "writer-principal-b";
    const sharedUserId = "writer-shared-user";
    const sessionA = {
      ...mkSession(tenantA, sharedUserId),
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    const sessionB = {
      ...mkSession(tenantB, sharedUserId),
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    await store.createSession(sessionA);
    await store.createSession(sessionB);

    await expect(store.enqueueTenantTelemetryArtifact(input(tenantA, {
      artifactIdSha256: D("6"),
      ownerKind: "user",
      ownerId: sharedUserId,
      ownerUserId: sharedUserId,
    }))).resolves.toMatchObject({ tenantId: tenantA, phase: "queued" });

    const crossTenantUser = input(tenantB, {
      artifactIdSha256: D("7"),
      ownerKind: "user",
      ownerId: sharedUserId,
      ownerUserId: sharedUserId,
    });
    crossTenantUser.payload = {
      ...crossTenantUser.payload,
      records: [trustedRunnerTelemetryRecord(nowMs, {
        opaqueRefKey: REF_KEY,
        tenantValue: tenantA,
        ownerKind: "user",
        ownerValue: sharedUserId,
      })],
    };
    await expect(store.enqueueTenantTelemetryArtifact(crossTenantUser))
      .rejects.toThrow(/tenant binding/);

    await expect(store.enqueueTenantTelemetryArtifact(input(tenantA, {
      artifactIdSha256: D("8"),
      ownerKind: "session",
      ownerId: sessionA.id,
      ownerUserId: sharedUserId,
    }))).resolves.toMatchObject({ tenantId: tenantA, phase: "queued" });

    const wrongSession = input(tenantA, {
      artifactIdSha256: D("9"),
      ownerKind: "session",
      ownerId: sessionA.id,
      ownerUserId: sharedUserId,
    });
    wrongSession.payload = {
      ...wrongSession.payload,
      records: [trustedRunnerTelemetryRecord(nowMs, {
        opaqueRefKey: REF_KEY,
        tenantValue: tenantA,
        ownerKind: "session",
        ownerValue: sessionB.id,
      })],
    };
    await expect(store.enqueueTenantTelemetryArtifact(wrongSession))
      .rejects.toThrow(/owner binding/);
  });

  it("captures stateful enqueue getters once and cannot swap in a literal record", async () => {
    let nowMs = 1_000;
    const store = await activeStore(() => nowMs);
    nowMs = 1_100;
    const tenantId = "writer-stateful-capture";
    await store.createApiKey(tenantId, "key", "hash");
    const fixture = statefulTelemetryEnqueueCaptureFixture(input(tenantId));

    const queued = await store.enqueueTenantTelemetryArtifact(fixture.input);
    expect([...fixture.topLevelReads.values()]).toEqual(Array(12).fill(1));
    expect(Object.fromEntries(fixture.payloadReads)).toEqual({
      schema: 1,
      domain: 1,
      records: 1,
    });
    expect(Object.fromEntries(fixture.recordArrayReads)).toEqual({ length: 1, 0: 1 });

    const [claim] = await store.claimTenantTelemetryWriteJobs({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "writer-stateful-capture-claim",
      adapterProtocol: "telemetry-memory-v1",
    });
    expect(claim?.writeOperationSha256).toBe(queued.writeOperationSha256);
    expect(claim?.payload.records[0]?.fields.attempt).toBe(1);
    expect(claim?.payload.records[0]?.fields.attempt)
      .not.toBe(fixture.injectedLiteralAttempt);
  });

  it("rejects a records Proxy with a non-integer captured length", async () => {
    let nowMs = 1_000;
    const store = await activeStore(() => nowMs);
    nowMs = 1_100;
    const tenantId = "writer-record-length";
    await store.createApiKey(tenantId, "key", "hash");
    const writeInput = input(tenantId);
    writeInput.payload = {
      ...writeInput.payload,
      records: new Proxy([...writeInput.payload.records], {
        get(target, property, receiver) {
          return property === "length" ? 1.5 : Reflect.get(target, property, receiver);
        },
      }),
    };
    await expect(store.enqueueTenantTelemetryArtifact(writeInput))
      .rejects.toThrow(/record count/);
    expect(store.tenantTelemetryWriteJobs).toHaveLength(0);
    expect(store.tenantTelemetryWritePayloads).toHaveLength(0);
  });

  it("atomically spools a protected batch and seals inventory plus ACK", async () => {
    let nowMs = 1_000;
    const store = await activeStore(() => nowMs);
    nowMs = 1_100;
    const session = {
      ...mkSession("writer-tenant", "writer-user"),
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    await store.createSession(session);
    const writeInput = input(session.tenantId, {
      ownerKind: "session",
      ownerId: session.id,
      ownerUserId: session.userId,
    });

    const queued = await store.enqueueTenantTelemetryArtifact(writeInput);
    expect(queued).toMatchObject({ phase: "queued", attempts: 0, recordCount: 1 });
    expect(JSON.stringify(queued)).not.toContain(session.id);
    expect(JSON.stringify(queued)).not.toContain(session.userId);
    expect(JSON.stringify(store.tenantTelemetryWritePayloads.get(
      queued.writeOperationSha256,
    ))).not.toContain(session.id);
    await expect(store.enqueueTenantTelemetryArtifact(writeInput)).resolves.toEqual(queued);

    const [claim] = await store.claimTenantTelemetryWriteJobs({
      limit: 10,
      leaseMs: 1_000,
      claimToken: "writer-claim-1",
      adapterProtocol: "telemetry-memory-v1",
    });
    expect(claim).toBeDefined();
    const auth = authorization(claim!);
    await expect(store.completeTenantTelemetryWrite(auth, adapterResult(claim!)))
      .rejects.toBeInstanceOf(TenantTelemetryWriteConflictError);
    await store.reserveTenantTelemetryExternalMutation(auth, claim!.target.adapterProtocol);
    claim!.reservation = (await store.getTenantTelemetryWriteJob(
      claim!.tenantId, claim!.writeOperationSha256,
    ))!.reservation;
    const result = adapterResult(claim!);
    const ack = await store.completeTenantTelemetryWrite(auth, result);
    expect(ack).toMatchObject({
      tenantId: session.tenantId,
      writeOperationSha256: queued.writeOperationSha256,
      outcome: "written",
    });
    expect(store.tenantTelemetryWritePayloads.has(queued.writeOperationSha256)).toBe(false);
    await expect(store.getTenantTelemetryArtifact(
      session.tenantId,
      "logs",
      writeInput.artifactIdSha256,
      writeInput.artifactGeneration,
    )).resolves.toMatchObject({ receiptSha256: ack!.inventoryReceiptSha256 });
    await expect(store.completeTenantTelemetryWrite(auth, result)).resolves.toEqual(ack);
    await expect(store.completeTenantTelemetryWrite({
      ...auth,
      claimToken: "writer-stale-token",
    }, result)).resolves.toBeNull();
    await expect(store.getTenantTelemetryWriteJob(
      "other-tenant",
      queued.writeOperationSha256,
    )).resolves.toBeNull();
    await expect(store.getTenantTelemetryWriteAck(
      "other-tenant",
      queued.writeOperationSha256,
    )).resolves.toBeNull();
  });

  it("rolls back both enqueue projections when publication fails", async () => {
    let nowMs = 1_000;
    const store = await activeStore(() => nowMs);
    nowMs = 1_100;
    await store.createApiKey("writer-enqueue-rollback", "key", "hash");
    const originalSet = store.tenantTelemetryWriteJobs.set.bind(store.tenantTelemetryWriteJobs);
    let fail = true;
    Object.defineProperty(store.tenantTelemetryWriteJobs, "set", {
      configurable: true,
      value: (key: string, value: Parameters<typeof originalSet>[1]) => {
        if (fail) {
          fail = false;
          throw new Error("injected telemetry write job failure");
        }
        return originalSet(key, value);
      },
    });

    await expect(store.enqueueTenantTelemetryArtifact(input("writer-enqueue-rollback")))
      .rejects.toThrow("injected telemetry write job failure");
    expect(store.tenantTelemetryWriteJobs).toHaveLength(0);
    expect(store.tenantTelemetryWritePayloads).toHaveLength(0);
    expect(store.tenantTelemetryWriteAcks).toHaveLength(0);
    expect(store.tenantTelemetryArtifactMemberships).toHaveLength(0);
  });

  it("rolls back job, payload and application-independent membership on late sidecar failure", async () => {
    let nowMs = 1_000;
    const store = await activeStore(() => nowMs);
    nowMs = 1_100;
    await store.createApiKey("writer-membership-rollback", "key", "hash");
    const originalSet = store.tenantTelemetryArtifactMemberships.set.bind(
      store.tenantTelemetryArtifactMemberships,
    );
    let fail = true;
    Object.defineProperty(store.tenantTelemetryArtifactMemberships, "set", {
      configurable: true,
      value: (key: string, value: Parameters<typeof originalSet>[1]) => {
        if (fail) {
          fail = false;
          throw new Error("injected membership publication failure");
        }
        return originalSet(key, value);
      },
    });
    await expect(store.enqueueTenantTelemetryArtifact(input("writer-membership-rollback")))
      .rejects.toThrow("injected membership publication failure");
    expect(store.tenantTelemetryWriteJobs).toHaveLength(0);
    expect(store.tenantTelemetryWritePayloads).toHaveLength(0);
    expect(store.tenantTelemetryArtifactMemberships).toHaveLength(0);
  });

  it("rolls back inventory, ACK, terminal job and payload cleanup together", async () => {
    let nowMs = 1_000;
    const store = await activeStore(() => nowMs);
    nowMs = 1_100;
    await store.createApiKey("writer-complete-rollback", "key", "hash");
    const writeInput = input("writer-complete-rollback");
    const queued = await store.enqueueTenantTelemetryArtifact(writeInput);
    const [claim] = await store.claimTenantTelemetryWriteJobs({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "writer-complete-rollback",
      adapterProtocol: "telemetry-memory-v1",
    });
    const originalSet = store.tenantTelemetryWriteAcks.set.bind(store.tenantTelemetryWriteAcks);
    let fail = true;
    Object.defineProperty(store.tenantTelemetryWriteAcks, "set", {
      configurable: true,
      value: (key: string, value: Parameters<typeof originalSet>[1]) => {
        if (fail) {
          fail = false;
          throw new Error("injected telemetry write ACK failure");
        }
        return originalSet(key, value);
      },
    });
    await store.reserveTenantTelemetryExternalMutation(
      authorization(claim!), claim!.target.adapterProtocol,
    );
    await expect(store.completeTenantTelemetryWrite(
      authorization(claim!),
      adapterResult(claim!),
    )).rejects.toThrow("injected telemetry write ACK failure");
    await expect(store.getTenantTelemetryWriteJob(
      writeInput.tenantId,
      queued.writeOperationSha256,
    )).resolves.toMatchObject({ phase: "queued" });
    expect(store.tenantTelemetryWritePayloads.has(queued.writeOperationSha256)).toBe(true);
    expect(store.tenantTelemetryWriteAcks).toHaveLength(0);
    await expect(store.getTenantTelemetryArtifact(
      writeInput.tenantId,
      writeInput.domain,
      writeInput.artifactIdSha256,
      writeInput.artifactGeneration,
    )).resolves.toBeNull();
  });

  it("uses attempt-bound leases to prevent ABA completion", async () => {
    let nowMs = 1_000;
    const store = await activeStore(() => nowMs);
    nowMs = 1_100;
    await store.createApiKey("writer-aba", "key", "hash");
    await store.enqueueTenantTelemetryArtifact(input("writer-aba"));
    const [first] = await store.claimTenantTelemetryWriteJobs({
      limit: 1,
      leaseMs: 10,
      claimToken: "writer-aba-first",
      adapterProtocol: "telemetry-memory-v1",
    });
    await store.reserveTenantTelemetryExternalMutation(
      authorization(first!), first!.target.adapterProtocol,
    );
    nowMs = 1_111;
    const [second] = await store.claimTenantTelemetryWriteJobs({
      limit: 1,
      leaseMs: 100,
      claimToken: "writer-aba-second",
      adapterProtocol: "telemetry-memory-v1",
    });
    expect(second!.claimAttempt).toBe(first!.claimAttempt + 1);
    await expect(store.renewTenantTelemetryWrite(authorization(first!), { leaseMs: 100 }))
      .resolves.toBe(false);
    await expect(store.retryTenantTelemetryWrite(authorization(first!), {
      delayMs: 0,
      errorCode: "temporary_failure",
    })).resolves.toBe(false);
    await expect(store.completeTenantTelemetryWrite(
      authorization(first!),
      adapterResult(first!),
    )).resolves.toBeNull();
    await expect(store.completeTenantTelemetryWrite(
      authorization(second!),
      adapterResult(second!),
    )).resolves.toMatchObject({ completedClaimAttempt: 2 });
  });

  it("claims only the exact adapter protocol without blocking another adapter queue", async () => {
    let nowMs = 1_000;
    const store = new MemorySessionStore(
      { now: () => nowMs },
      { tenantTelemetryRefKey: new Uint8Array(32).fill(13) },
    );
    await store.activateTenantTelemetryLifecycle({
      expectedControlGeneration: 0,
      targets: [
        activation().targets[0]!,
        { ...activation().targets[1]!, adapterProtocol: "telemetry-other-v1" },
      ],
    });
    nowMs = 1_100;
    await store.createApiKey("writer-mixed-adapter", "key", "hash");
    await store.enqueueTenantTelemetryArtifact(input("writer-mixed-adapter", {
      artifactIdSha256: D("6"),
    }));
    await store.enqueueTenantTelemetryArtifact(input("writer-mixed-adapter", {
      domain: "traces",
      artifactIdSha256: D("7"),
      payload: {
        ...input("writer-mixed-adapter").payload,
        domain: "traces",
      },
    }));

    const memoryClaims = await store.claimTenantTelemetryWriteJobs({
      limit: 10,
      leaseMs: 1_000,
      claimToken: "writer-mixed-memory",
      adapterProtocol: "telemetry-memory-v1",
    });
    expect(memoryClaims).toHaveLength(1);
    expect(memoryClaims[0]!.inventory.domain).toBe("logs");
    const otherClaims = await store.claimTenantTelemetryWriteJobs({
      limit: 10,
      leaseMs: 1_000,
      claimToken: "writer-mixed-other",
      adapterProtocol: "telemetry-other-v1",
    });
    expect(otherClaims).toHaveLength(1);
    expect(otherClaims[0]!.inventory.domain).toBe("traces");
  });

  it("refuses first-mutation reservation when a legal-hold generation changes after enqueue", async () => {
    let nowMs = 1_000;
    const store = await activeStore(() => nowMs);
    nowMs = 1_100;
    const tenantId = "writer-hold-race";
    await store.createApiKey(tenantId, "key", "hash");
    await store.enqueueTenantTelemetryArtifact(input(tenantId, {
      artifactIdSha256: D("8"),
    }));
    const [claim] = await store.claimTenantTelemetryWriteJobs({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "writer-hold-race",
      adapterProtocol: "telemetry-memory-v1",
    });
    nowMs = 1_200;
    await store.setLegalHold({
      tenantId,
      holdId: "hold_writer_race",
      subjectKind: "tenant",
      subjectId: tenantId,
      reasonCode: "litigation",
      expectedControlGeneration: 0,
      actorKeyId: "hold-admin",
      atMs: nowMs,
    });
    await expect(store.reserveTenantTelemetryExternalMutation(
      authorization(claim!), claim!.target.adapterProtocol,
    )).resolves.toBeNull();
    expect((await store.getTenantTelemetryWriteJob(
      tenantId, claim!.writeOperationSha256,
    ))).not.toHaveProperty("reservation");
  });

  it("blocks legacy coverage and all new writes after the tenant T1 fence", async () => {
    let nowMs = 1_000;
    const legacyStore = new MemorySessionStore(
      { now: () => nowMs },
      { tenantTelemetryRefKey: LEGACY_REF_KEY },
    );
    await legacyStore.createApiKey("writer-legacy", "key", "hash");
    nowMs = 1_100;
    await legacyStore.activateTenantTelemetryLifecycle(activation());
    await expect(legacyStore.enqueueTenantTelemetryArtifact(
      input("writer-legacy", {}, LEGACY_REF_KEY),
    ))
      .rejects.toBeInstanceOf(TenantTelemetryWriteConflictError);

    nowMs = 2_000;
    const store = await activeStore(() => nowMs);
    nowMs = 2_100;
    await store.createApiKey("writer-t1", "key", "hash");
    const beforeT1 = input("writer-t1", {
      sourceHighWaterDbMs: nowMs,
      artifactIdSha256: D("8"),
    });
    await store.enqueueTenantTelemetryArtifact(beforeT1);
    const [claim] = await store.claimTenantTelemetryWriteJobs({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "writer-before-t1",
      adapterProtocol: "telemetry-memory-v1",
    });
    await store.reserveTenantTelemetryExternalMutation(
      authorization(claim!), claim!.target.adapterProtocol,
    );
    nowMs = 2_200;
    await store.requestTenantErasure({
      requestId: newErasureRequestId(),
      tenantId: "writer-t1",
      requestedByKeyId: "writer-test",
      idempotencyKey: randomUUID(),
      requestHash: tenantErasureRequestHash("writer-t1"),
      atMs: nowMs,
    });
    await expect(store.enqueueTenantTelemetryArtifact(input("writer-t1", {
      sourceHighWaterDbMs: nowMs,
      artifactIdSha256: D("9"),
    }))).rejects.toBeInstanceOf(SubjectDeletingError);

    // If the external sink committed before T1, its exact durable ACK must still be recorded so
    // the later deletion worker can discover and remove the artifact instead of losing authority.
    await expect(store.completeTenantTelemetryWrite(
      authorization(claim!),
      adapterResult(claim!),
    )).resolves.toMatchObject({ tenantId: "writer-t1" });
  });
});
