import { describe, expect, it } from "vitest";
import {
  TENANT_TELEMETRY_APPLICATION_CAPTURE_PROTOCOL,
  TENANT_TELEMETRY_APPLICATION_COVERAGE_SCOPE,
  TENANT_TELEMETRY_APPLICATION_FLEET_STOPPED_ACK,
  TENANT_TELEMETRY_APPLICATION_LEGACY_WRITERS_DRAINED_ACK,
  TENANT_TELEMETRY_APPLICATION_PRODUCER_READY_ACK,
  TENANT_TELEMETRY_APPLICATION_WRITE_BINDING_SCOPE,
  tenantTelemetryApplicationActivationRequestSha256,
  tenantTelemetryApplicationCoverageEvidenceSha256,
  tenantTelemetryApplicationCoverageRootSha256,
  tenantTelemetryApplicationPreCutoverWriteRootSha256,
  tenantTelemetryApplicationWriteBindingReceiptSha256,
  validateActivateTenantTelemetryApplicationCaptureInput,
  validateTenantTelemetryApplicationCoverage,
  validateTenantTelemetryApplicationWriteBinding,
  type ActivateTenantTelemetryApplicationCaptureInput,
  type TenantTelemetryApplicationCoverageBody,
  type TenantTelemetryApplicationWriteBindingBody,
} from "../src/index.js";

const D = (character: string): string => character.repeat(64);

const activation: ActivateTenantTelemetryApplicationCaptureInput = {
  domain: "logs",
  expectedControlGeneration: 0,
  expectedLifecycleControlGeneration: 1,
  lifecycleControlEvidenceSha256: D("1"),
  lifecycleTargetSha256: D("2"),
  lifecycleTargetReceiptSha256: D("3"),
  producerProtocol: "application-dual-write-v1",
  producerContractSha256: D("4"),
  fleetStoppedAck: TENANT_TELEMETRY_APPLICATION_FLEET_STOPPED_ACK,
  legacyWritersDrainedAck:
    TENANT_TELEMETRY_APPLICATION_LEGACY_WRITERS_DRAINED_ACK,
  producerReadyAck: TENANT_TELEMETRY_APPLICATION_PRODUCER_READY_ACK,
};

function coverageBody(
  tenantId: string,
  complete = false,
): TenantTelemetryApplicationCoverageBody {
  return {
    tenantId,
    domain: "logs",
    controlGeneration: 1,
    scope: TENANT_TELEMETRY_APPLICATION_COVERAGE_SCOPE,
    captureStatus: complete
      ? "capture_since_tenant_creation"
      : "capture_since_cutover",
    preCutoverHistoryStatus: complete
      ? "pre_cutover_not_applicable"
      : "pre_cutover_history_unknown",
    lifecycleCoverageEvidenceSha256: D("5"),
    lifecycleHistoryStatus: complete
      ? "complete_since_creation"
      : "legacy_history_unknown",
    subjectRefSha256: D("6"),
    targetSha256: D("2"),
    targetReceiptSha256: D("3"),
    producerProtocol: activation.producerProtocol,
    producerContractSha256: activation.producerContractSha256,
    coverageStartedAtDbMs: 1_000,
  };
}

describe("tenant telemetry application capture protocol", () => {
  it("hashes a closed activation request and rejects missing rollout acknowledgements", () => {
    validateActivateTenantTelemetryApplicationCaptureInput(activation);
    expect(tenantTelemetryApplicationActivationRequestSha256(activation))
      .toMatch(/^[0-9a-f]{64}$/);
    expect(() => validateActivateTenantTelemetryApplicationCaptureInput({
      ...activation,
      producerReadyAck: "wrong" as typeof activation.producerReadyAck,
    })).toThrow(/activation protocol/);
    expect(() => validateActivateTenantTelemetryApplicationCaptureInput({
      ...activation,
      extra: true,
    } as ActivateTenantTelemetryApplicationCaptureInput)).toThrow(/unknown or missing fields/);
  });

  it("couples cutover coverage status to pre-cutover history and roots UTF-8 tenants", () => {
    const firstBody = coverageBody("tenant-z");
    const secondBody = coverageBody("租户-a", true);
    const first = {
      ...firstBody,
      evidenceSha256: tenantTelemetryApplicationCoverageEvidenceSha256(firstBody),
    };
    const second = {
      ...secondBody,
      evidenceSha256: tenantTelemetryApplicationCoverageEvidenceSha256(secondBody),
    };
    validateTenantTelemetryApplicationCoverage(first);
    validateTenantTelemetryApplicationCoverage(second);
    expect(tenantTelemetryApplicationCoverageRootSha256("logs", [first, second]))
      .toBe(tenantTelemetryApplicationCoverageRootSha256("logs", [second, first]));
    expect(() => tenantTelemetryApplicationCoverageEvidenceSha256({
      ...firstBody,
      preCutoverHistoryStatus: "pre_cutover_not_applicable",
    })).toThrow(/history is inconsistent/);
    expect(() => tenantTelemetryApplicationCoverageRootSha256("traces", [first]))
      .toThrow(/coverage set is invalid/);
  });

  it("freezes the pre-cutover operation set and validates exact write bindings", () => {
    expect(tenantTelemetryApplicationPreCutoverWriteRootSha256(
      "logs",
      [D("b"), D("a")],
    )).toBe(tenantTelemetryApplicationPreCutoverWriteRootSha256(
      "logs",
      [D("a"), D("b")],
    ));
    expect(() => tenantTelemetryApplicationPreCutoverWriteRootSha256(
      "logs",
      [D("a"), D("a")],
    )).toThrow(/duplicated/);

    const body: TenantTelemetryApplicationWriteBindingBody = {
      scope: TENANT_TELEMETRY_APPLICATION_WRITE_BINDING_SCOPE,
      protocol: TENANT_TELEMETRY_APPLICATION_CAPTURE_PROTOCOL,
      writeOperationSha256: D("1"),
      tenantId: "tenant-binding",
      domain: "logs",
      controlGeneration: 1,
      controlEvidenceSha256: D("2"),
      coverageEvidenceSha256: D("3"),
      lifecycleCoverageEvidenceSha256: D("4"),
      targetSha256: D("5"),
      targetReceiptSha256: D("6"),
      producerProtocol: "application-dual-write-v1",
      producerContractSha256: D("7"),
      inventorySha256: D("8"),
      manifestSha256: D("9"),
      payloadSha256: D("a"),
      boundAtDbMs: 1_000,
    };
    const binding = {
      ...body,
      receiptSha256: tenantTelemetryApplicationWriteBindingReceiptSha256(body),
    };
    validateTenantTelemetryApplicationWriteBinding(binding);
    expect(() => validateTenantTelemetryApplicationWriteBinding({
      ...binding,
      payloadSha256: D("b"),
    })).toThrow(/receipt mismatch/);
  });
});
