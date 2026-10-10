import {
  tenantCredentialTargetExecutionAdapterEvidenceSha256,
  validateTenantCredentialTargetExecutionAdapterInput,
  type TenantCredentialTargetExecutionAdapter,
  type TenantCredentialTargetExecutionAdapterInput,
  type TenantCredentialTargetExecutionAdapterResult,
  type TenantCredentialTargetExecutionOutcome,
} from "@agent-service/store";
import {
  TenantCredentialTargetExecutionAdapterConflictError,
  TenantCredentialTargetExecutionAdapterPermanentError,
  TenantCredentialTargetExecutionAdapterTemporaryError,
} from "./tenant-credential-target-execution-worker.js";

export type FakeCredentialTargetExecutionFaultKind =
  | "temporary_failure"
  | "permanent_failure"
  | "operation_conflict"
  | "apply_committed_response_lost";

export const FAKE_CREDENTIAL_TARGET_EXECUTION_ADAPTER_PROTOCOL =
  "fake-external-credential-revoke-v1" as const;

export interface FakeCredentialTargetExecutionFault {
  method: "inspect" | "apply";
  kind: FakeCredentialTargetExecutionFaultKind;
}

export interface FakeCredentialTargetExecutionLedgerRecord {
  adapterProtocol: string;
  domain: "external_credential";
  operationIdSha256: string;
  targetReferenceSha256: string;
  outcome: TenantCredentialTargetExecutionOutcome;
  evidenceSha256: string;
}

export interface FakeCredentialTargetExecutionAdapterState {
  /** Durable, secret-free provider idempotency ledger shared explicitly by adapter instances. */
  operations: Map<string, FakeCredentialTargetExecutionLedgerRecord>;
  /** Provider-side target presence, keyed only by the trusted reference digest. */
  absentTargetReferences: Set<string>;
  /** Ordered, one-shot fault injection. This is test control state, not provider evidence. */
  faults: Map<string, FakeCredentialTargetExecutionFault[]>;
}

export function createFakeCredentialTargetExecutionAdapterState():
  FakeCredentialTargetExecutionAdapterState {
  return {
    operations: new Map(),
    absentTargetReferences: new Set(),
    faults: new Map(),
  };
}

export function queueFakeCredentialTargetExecutionFault(
  state: FakeCredentialTargetExecutionAdapterState,
  operationIdSha256: string,
  fault: FakeCredentialTargetExecutionFault,
): void {
  const queue = state.faults.get(operationIdSha256) ?? [];
  queue.push(fault);
  state.faults.set(operationIdSha256, queue);
}

function adapterResult(
  record: FakeCredentialTargetExecutionLedgerRecord,
  replayed: boolean,
): TenantCredentialTargetExecutionAdapterResult {
  return { ...record, replayed };
}

function takeFault(
  state: FakeCredentialTargetExecutionAdapterState,
  operationIdSha256: string,
  method: "inspect" | "apply",
): FakeCredentialTargetExecutionFaultKind | null {
  const queue = state.faults.get(operationIdSha256);
  if (!queue?.length || queue[0]!.method !== method) return null;
  const fault = queue.shift()!;
  if (queue.length === 0) state.faults.delete(operationIdSha256);
  return fault.kind;
}

function throwFault(kind: FakeCredentialTargetExecutionFaultKind): never {
  if (kind === "temporary_failure" || kind === "apply_committed_response_lost") {
    throw new TenantCredentialTargetExecutionAdapterTemporaryError();
  }
  if (kind === "permanent_failure") {
    throw new TenantCredentialTargetExecutionAdapterPermanentError();
  }
  throw new TenantCredentialTargetExecutionAdapterConflictError();
}

/** A deterministic, persistent fake provider. It never retains ciphertext or plaintext locators. */
export class FakeCredentialTargetExecutionAdapter
implements TenantCredentialTargetExecutionAdapter {
  readonly domain = "external_credential" as const;
  private closed = false;

  constructor(
    readonly state: FakeCredentialTargetExecutionAdapterState,
    readonly adapterProtocol = FAKE_CREDENTIAL_TARGET_EXECUTION_ADAPTER_PROTOCOL,
  ) {}

  async inspectTarget(
    input: TenantCredentialTargetExecutionAdapterInput,
  ): Promise<TenantCredentialTargetExecutionAdapterResult | null> {
    this.validateInput(input);
    const existing = this.state.operations.get(input.target.operationIdSha256);
    if (existing) {
      this.assertExactRecord(input, existing);
      return adapterResult(existing, true);
    }
    const fault = takeFault(
      this.state,
      input.target.operationIdSha256,
      "inspect",
    );
    if (fault) throwFault(fault);
    return null;
  }

  async applyTarget(
    input: TenantCredentialTargetExecutionAdapterInput,
  ): Promise<TenantCredentialTargetExecutionAdapterResult> {
    this.validateInput(input);
    const existing = this.state.operations.get(input.target.operationIdSha256);
    if (existing) {
      this.assertExactRecord(input, existing);
      return adapterResult(existing, true);
    }

    const fault = takeFault(this.state, input.target.operationIdSha256, "apply");
    if (fault && fault !== "apply_committed_response_lost") throwFault(fault);

    const outcome = this.state.absentTargetReferences.has(input.target.targetReferenceSha256)
      ? "already_absent" as const
      : "revoked" as const;
    const evidence = {
      adapterProtocol: this.adapterProtocol,
      domain: this.domain,
      operationIdSha256: input.target.operationIdSha256,
      targetReferenceSha256: input.target.targetReferenceSha256,
      outcome,
    };
    const record: FakeCredentialTargetExecutionLedgerRecord = {
      ...evidence,
      evidenceSha256: tenantCredentialTargetExecutionAdapterEvidenceSha256(evidence),
    };
    this.state.operations.set(record.operationIdSha256, record);
    this.state.absentTargetReferences.add(record.targetReferenceSha256);
    if (fault === "apply_committed_response_lost") throwFault(fault);
    return adapterResult(record, false);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private validateInput(input: TenantCredentialTargetExecutionAdapterInput): void {
    if (this.closed) throw new TenantCredentialTargetExecutionAdapterTemporaryError();
    try {
      validateTenantCredentialTargetExecutionAdapterInput(input);
      if (input.target.adapterProtocol !== this.adapterProtocol
        || input.target.domain !== this.domain) {
        throw new Error("wrong adapter");
      }
    } catch {
      throw new TenantCredentialTargetExecutionAdapterConflictError();
    }
  }

  private assertExactRecord(
    input: TenantCredentialTargetExecutionAdapterInput,
    record: FakeCredentialTargetExecutionLedgerRecord,
  ): void {
    const expectedEvidenceSha256 = tenantCredentialTargetExecutionAdapterEvidenceSha256({
      adapterProtocol: record.adapterProtocol,
      domain: record.domain,
      operationIdSha256: record.operationIdSha256,
      targetReferenceSha256: record.targetReferenceSha256,
      outcome: record.outcome,
    });
    if (record.adapterProtocol !== this.adapterProtocol
      || record.domain !== this.domain
      || record.operationIdSha256 !== input.target.operationIdSha256
      || record.targetReferenceSha256 !== input.target.targetReferenceSha256
      || record.evidenceSha256 !== expectedEvidenceSha256) {
      throw new TenantCredentialTargetExecutionAdapterConflictError();
    }
  }
}
