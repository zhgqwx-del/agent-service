import {
  canonicalizeTenantTelemetryArtifactPayload,
  tenantTelemetryArtifactManifestSha256,
  tenantTelemetryArtifactPayloadCanonicalJson,
  tenantTelemetryArtifactPayloadSha256,
  tenantTelemetryWriteAdapterEvidenceSha256,
  tenantTelemetryWriteOperationSha256,
  validateTenantTelemetryWriteAdapterResult,
  type TenantTelemetryArtifactPayload,
  type TenantTelemetryWriteAdapterResult,
  type TenantTelemetryWriteOutcome,
} from "../tenant-telemetry-writer.js";
import {
  validateTenantTelemetryArtifactInventory,
  validateTenantTelemetryLifecycleTarget,
  type TenantTelemetryArtifactInventoryRecord,
  type TenantTelemetryLifecycleTargetRecord,
} from "../tenant-telemetry-lifecycle.js";

export interface TenantTelemetryWriteAdapterInput {
  writeOperationSha256: string;
  target: TenantTelemetryLifecycleTargetRecord;
  inventory: TenantTelemetryArtifactInventoryRecord;
  payload: Readonly<TenantTelemetryArtifactPayload>;
}

export type TenantTelemetryWriteInspection =
  | { status: "absent" }
  | { status: "exact"; result: TenantTelemetryWriteAdapterResult }
  | { status: "conflict" };

export interface TenantTelemetryWriteAdapter {
  readonly adapterProtocol: string;
  inspectWrite(input: TenantTelemetryWriteAdapterInput): Promise<TenantTelemetryWriteInspection>;
  createWrite(input: TenantTelemetryWriteAdapterInput): Promise<TenantTelemetryWriteAdapterResult>;
  close(): Promise<void>;
}

/** A retryable transport/dependency failure. The message deliberately contains no remote detail. */
export class TenantTelemetryWriteAdapterTemporaryError extends Error {
  constructor() {
    super("tenant telemetry sink is temporarily unavailable");
    this.name = "TenantTelemetryWriteAdapterTemporaryError";
  }
}

/** The immutable remote slot exists with different evidence or violated the closed protocol. */
export class TenantTelemetryWriteAdapterConflictError extends Error {
  constructor() {
    super("tenant telemetry sink conflicts with immutable write evidence");
    this.name = "TenantTelemetryWriteAdapterConflictError";
  }
}

function exactKeys(value: object, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    throw new TenantTelemetryWriteAdapterConflictError();
  }
}

export function validateTenantTelemetryWriteAdapterInput(
  input: TenantTelemetryWriteAdapterInput,
): Readonly<TenantTelemetryArtifactPayload> {
  try {
    exactKeys(input, ["writeOperationSha256", "target", "inventory", "payload"],
      "tenant telemetry write adapter input");
    validateTenantTelemetryLifecycleTarget(input.target);
    validateTenantTelemetryArtifactInventory(input.inventory);
    const payload = canonicalizeTenantTelemetryArtifactPayload(input.payload);
    const manifestSha256 = tenantTelemetryArtifactManifestSha256({
      tenantId: input.inventory.tenantId,
      controlGeneration: input.inventory.controlGeneration,
      domain: input.inventory.domain,
      targetSha256: input.inventory.targetSha256,
      artifactIdSha256: input.inventory.artifactIdSha256,
      artifactGeneration: input.inventory.artifactGeneration,
      ownerKind: input.inventory.ownerKind,
      tenantRefSha256: input.inventory.tenantRefSha256,
      ownerRefSha256: input.inventory.ownerRefSha256,
      holdSubjectRefSha256: input.inventory.holdSubjectRefSha256,
      coverageEvidenceSha256: input.inventory.coverageEvidenceSha256,
      sourceSchema: input.inventory.sourceSchema,
      sourceGeneration: input.inventory.sourceGeneration,
      sourceHighWaterDbMs: input.inventory.sourceHighWaterDbMs,
      payloadSha256: input.inventory.payloadSha256,
    });
    if (input.inventory.tenantId.length < 1
      || input.target.targetSha256 !== input.inventory.targetSha256
      || input.target.domain !== input.inventory.domain
      || payload.domain !== input.inventory.domain
      || tenantTelemetryWriteOperationSha256(input.inventory.manifestSha256)
        !== input.writeOperationSha256
      || tenantTelemetryArtifactPayloadSha256(payload) !== input.inventory.payloadSha256) {
      throw new Error("binding mismatch");
    }
    if (manifestSha256 !== input.inventory.manifestSha256) {
      throw new Error("manifest mismatch");
    }
    return payload;
  } catch (error) {
    if (error instanceof TenantTelemetryWriteAdapterConflictError) throw error;
    throw new TenantTelemetryWriteAdapterConflictError();
  }
}

export function tenantTelemetryWriteAdapterResult(
  adapterProtocol: string,
  input: TenantTelemetryWriteAdapterInput,
  outcome: TenantTelemetryWriteOutcome,
  replayed: boolean,
): TenantTelemetryWriteAdapterResult {
  validateTenantTelemetryWriteAdapterInput(input);
  if (adapterProtocol !== input.target.adapterProtocol) {
    throw new TenantTelemetryWriteAdapterConflictError();
  }
  const evidence = {
    adapterProtocol,
    domain: input.inventory.domain,
    targetSha256: input.target.targetSha256,
    writeOperationSha256: input.writeOperationSha256,
    artifactIdSha256: input.inventory.artifactIdSha256,
    artifactGeneration: input.inventory.artifactGeneration,
    payloadSha256: input.inventory.payloadSha256,
    manifestSha256: input.inventory.manifestSha256,
    outcome,
    replayed,
  };
  const result: TenantTelemetryWriteAdapterResult = {
    ...evidence,
    evidenceSha256: tenantTelemetryWriteAdapterEvidenceSha256(evidence),
  };
  validateTenantTelemetryWriteAdapterResult(result);
  return result;
}

export function assertExactTenantTelemetryWriteAdapterResult(
  adapterProtocol: string,
  input: TenantTelemetryWriteAdapterInput,
  result: TenantTelemetryWriteAdapterResult,
): void {
  try {
    validateTenantTelemetryWriteAdapterInput(input);
    validateTenantTelemetryWriteAdapterResult(result);
    if (result.adapterProtocol !== adapterProtocol
      || result.adapterProtocol !== input.target.adapterProtocol
      || result.domain !== input.inventory.domain
      || result.targetSha256 !== input.target.targetSha256
      || result.writeOperationSha256 !== input.writeOperationSha256
      || result.artifactIdSha256 !== input.inventory.artifactIdSha256
      || result.artifactGeneration !== input.inventory.artifactGeneration
      || result.payloadSha256 !== input.inventory.payloadSha256
      || result.manifestSha256 !== input.inventory.manifestSha256) {
      throw new Error("result binding mismatch");
    }
  } catch (error) {
    if (error instanceof TenantTelemetryWriteAdapterConflictError) throw error;
    throw new TenantTelemetryWriteAdapterConflictError();
  }
}

export function validateTenantTelemetryWriteInspection(
  adapterProtocol: string,
  input: TenantTelemetryWriteAdapterInput,
  inspection: TenantTelemetryWriteInspection,
): void {
  if (typeof inspection !== "object" || inspection === null || Array.isArray(inspection)) {
    throw new TenantTelemetryWriteAdapterConflictError();
  }
  if (inspection.status === "absent" || inspection.status === "conflict") {
    exactKeys(inspection, ["status"], "tenant telemetry write inspection");
    return;
  }
  if (inspection.status === "exact") {
    exactKeys(inspection, ["status", "result"], "tenant telemetry write inspection");
    assertExactTenantTelemetryWriteAdapterResult(adapterProtocol, input, inspection.result);
    return;
  }
  throw new TenantTelemetryWriteAdapterConflictError();
}

export function sameTenantTelemetryWriteAdapterInput(
  left: TenantTelemetryWriteAdapterInput,
  right: TenantTelemetryWriteAdapterInput,
): boolean {
  try {
    validateTenantTelemetryWriteAdapterInput(left);
    validateTenantTelemetryWriteAdapterInput(right);
  } catch {
    return false;
  }
  return left.writeOperationSha256 === right.writeOperationSha256
    && left.target.targetSha256 === right.target.targetSha256
    && left.inventory.artifactIdSha256 === right.inventory.artifactIdSha256
    && left.inventory.artifactGeneration === right.inventory.artifactGeneration
    && left.inventory.payloadSha256 === right.inventory.payloadSha256
    && left.inventory.manifestSha256 === right.inventory.manifestSha256
    && tenantTelemetryArtifactPayloadCanonicalJson(left.payload)
      === tenantTelemetryArtifactPayloadCanonicalJson(right.payload);
}
