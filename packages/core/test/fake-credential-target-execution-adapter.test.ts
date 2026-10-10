import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  TENANT_CREDENTIAL_TARGET_EXECUTION_TARGET_SCOPE,
  tenantCredentialTargetExecutionOperationIdSha256,
  tenantCredentialTargetExecutionTargetSha256,
  type TenantCredentialTargetExecutionAdapterInput,
  type TenantCredentialTargetExecutionEncryptedReference,
  type TenantCredentialTargetExecutionTarget,
} from "@agent-service/store";
import {
  createFakeCredentialTargetExecutionAdapterState,
  FakeCredentialTargetExecutionAdapter,
  queueFakeCredentialTargetExecutionFault,
  TenantCredentialTargetExecutionAdapterConflictError,
  TenantCredentialTargetExecutionAdapterPermanentError,
  TenantCredentialTargetExecutionAdapterTemporaryError,
} from "../src/index.js";

const REQUEST_ID = "erase_12345678-1234-4123-8123-123456789abc";
const PROTOCOL = "fake-external-credential-revoke-v1";
const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function adapterInput(secret = "opaque-secret-reference"): TenantCredentialTargetExecutionAdapterInput {
  const cipher = new TextEncoder().encode(secret);
  const identity = {
    requestId: REQUEST_ID,
    tenantId: "tenant-a",
    subjectGeneration: 2,
    targetExecutionGeneration: 1,
  };
  const operationIdSha256 = tenantCredentialTargetExecutionOperationIdSha256({
    identity,
    credentialVersionId: A,
    domain: "external_credential",
    targetDispositionEvidenceSha256: B,
    adapterProtocol: PROTOCOL,
    targetReferenceCipherSha256: sha256(cipher),
    targetReferenceKeyId: "local-test-key-v1",
    targetReferenceSha256: C,
  });
  const body = {
    ...identity,
    scope: TENANT_CREDENTIAL_TARGET_EXECUTION_TARGET_SCOPE,
    targetOrdinal: 0,
    credentialVersionId: A,
    domain: "external_credential" as const,
    sourceDisposition: "executable_ref" as const,
    targetDispositionEvidenceSha256: B,
    adapterProtocol: PROTOCOL,
    targetReferenceCipherSha256: sha256(cipher),
    targetReferenceKeyId: "local-test-key-v1",
    targetReferenceSha256: C,
    operationIdSha256,
    capturedAtDbMs: 1_000,
  };
  const target: TenantCredentialTargetExecutionTarget = {
    ...body,
    receiptSha256: tenantCredentialTargetExecutionTargetSha256(body),
  };
  const reference: TenantCredentialTargetExecutionEncryptedReference = {
    tenantId: target.tenantId,
    credentialVersionId: target.credentialVersionId,
    domain: "external_credential",
    adapterProtocol: target.adapterProtocol,
    targetDispositionEvidenceSha256: target.targetDispositionEvidenceSha256,
    targetReferenceCipher: cipher,
    targetReferenceCipherSha256: target.targetReferenceCipherSha256,
    targetReferenceKeyId: target.targetReferenceKeyId,
    targetReferenceSha256: target.targetReferenceSha256,
  };
  return { target, reference };
}

describe("FakeCredentialTargetExecutionAdapter", () => {
  it("persists a secret-free operation ledger across adapter instances", async () => {
    const input = adapterInput("do-not-retain-this-value");
    const state = createFakeCredentialTargetExecutionAdapterState();
    const first = new FakeCredentialTargetExecutionAdapter(state);

    await expect(first.inspectTarget(input)).resolves.toBeNull();
    await expect(first.applyTarget(input)).resolves.toMatchObject({
      outcome: "revoked",
      replayed: false,
      operationIdSha256: input.target.operationIdSha256,
    });
    await first.close();

    const second = new FakeCredentialTargetExecutionAdapter(state);
    await expect(second.inspectTarget(input)).resolves.toMatchObject({
      outcome: "revoked",
      replayed: true,
    });
    expect(JSON.stringify([...state.operations.values()]))
      .not.toContain("do-not-retain-this-value");
    expect([...state.operations.values()][0]).not.toHaveProperty("targetReferenceCipher");
  });

  it("records already-absent as a successful immutable outcome", async () => {
    const input = adapterInput();
    const state = createFakeCredentialTargetExecutionAdapterState();
    state.absentTargetReferences.add(input.target.targetReferenceSha256);
    const adapter = new FakeCredentialTargetExecutionAdapter(state);

    await expect(adapter.applyTarget(input)).resolves.toMatchObject({
      outcome: "already_absent",
      replayed: false,
    });
    await expect(adapter.applyTarget(input)).resolves.toMatchObject({
      outcome: "already_absent",
      replayed: true,
    });
  });

  it("supports temporary, permanent, and explicit conflict faults", async () => {
    for (const [kind, error] of [
      ["temporary_failure", TenantCredentialTargetExecutionAdapterTemporaryError],
      ["permanent_failure", TenantCredentialTargetExecutionAdapterPermanentError],
      ["operation_conflict", TenantCredentialTargetExecutionAdapterConflictError],
    ] as const) {
      const input = adapterInput();
      const state = createFakeCredentialTargetExecutionAdapterState();
      queueFakeCredentialTargetExecutionFault(state, input.target.operationIdSha256, {
        method: "apply",
        kind,
      });
      const adapter = new FakeCredentialTargetExecutionAdapter(state);
      await expect(adapter.applyTarget(input)).rejects.toBeInstanceOf(error);
      expect(state.operations).toHaveLength(0);
    }
  });

  it("survives an apply-committed response loss through durable inspection", async () => {
    const input = adapterInput();
    const state = createFakeCredentialTargetExecutionAdapterState();
    queueFakeCredentialTargetExecutionFault(state, input.target.operationIdSha256, {
      method: "apply",
      kind: "apply_committed_response_lost",
    });
    const first = new FakeCredentialTargetExecutionAdapter(state);

    await expect(first.applyTarget(input))
      .rejects.toBeInstanceOf(TenantCredentialTargetExecutionAdapterTemporaryError);
    expect(state.operations).toHaveLength(1);

    const second = new FakeCredentialTargetExecutionAdapter(state);
    await expect(second.inspectTarget(input)).resolves.toMatchObject({
      outcome: "revoked",
      replayed: true,
    });
  });

  it("fails closed when an operation id is bound to different durable evidence", async () => {
    const input = adapterInput();
    const state = createFakeCredentialTargetExecutionAdapterState();
    const adapter = new FakeCredentialTargetExecutionAdapter(state);
    const applied = await adapter.applyTarget(input);
    state.operations.set(input.target.operationIdSha256, {
      ...applied,
      targetReferenceSha256: A,
    });

    await expect(adapter.inspectTarget(input))
      .rejects.toBeInstanceOf(TenantCredentialTargetExecutionAdapterConflictError);
  });
});
