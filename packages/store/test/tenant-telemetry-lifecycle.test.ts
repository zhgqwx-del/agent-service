import { describe, expect, it } from "vitest";
import {
  TENANT_TELEMETRY_LIFECYCLE_CONTROL_SINGLETON_ID,
  TENANT_TELEMETRY_LIFECYCLE_COVERAGE_SCOPE,
  TENANT_TELEMETRY_LIFECYCLE_PROTOCOL,
  TENANT_TELEMETRY_LIFECYCLE_SUBJECT_SCOPE,
  TENANT_TELEMETRY_LIFECYCLE_TARGET_SCOPE,
  TENANT_TELEMETRY_WRITER_PROTOCOL,
  tenantTelemetryLifecycleActivationEvidenceSha256,
  tenantTelemetryLifecycleCoverageEvidenceSha256,
  tenantTelemetryLifecycleSubjectReceiptSha256,
  tenantTelemetryLifecycleTargetReceiptSha256,
  tenantTelemetryLifecycleTargetRootSha256,
  tenantTelemetryLifecycleTargetSha256,
  tenantTelemetrySubjectRefForTenantSha256,
  tenantTelemetrySubjectRefSha256,
  validateTenantTelemetryLifecycleControl,
  validateTenantTelemetryLifecycleCoverage,
  validateTenantTelemetryLifecycleSubject,
  validateTenantTelemetryLifecycleTarget,
  type ActiveTenantTelemetryLifecycleControlRecord,
  type TenantTelemetryLifecycleCoverageRecord,
  type TenantTelemetryLifecycleSubjectRecord,
  type TenantTelemetryLifecycleTargetBody,
  type TenantTelemetryLifecycleTargetRecord,
} from "../src/index.js";
import { telemetryOpaqueRef } from "@agent-service/protocol";

const D = (value: string) => value.repeat(64);
const REQUEST_ID = "erase_11111111-1111-4111-8111-111111111111";

function target(
  domain: "logs" | "traces",
  targetOrdinal: 0 | 1,
): TenantTelemetryLifecycleTargetRecord {
  const body: TenantTelemetryLifecycleTargetBody = {
    singletonId: TENANT_TELEMETRY_LIFECYCLE_CONTROL_SINGLETON_ID,
    controlGeneration: 1,
    domain,
    targetOrdinal,
    scope: TENANT_TELEMETRY_LIFECYCLE_TARGET_SCOPE,
    backendKind: "http_fixture",
    adapterProtocol: "telemetry-http-v1",
    namespaceSha256: D(domain === "logs" ? "1" : "2"),
    failureDomainSha256: D(domain === "logs" ? "3" : "4"),
    createdAtDbMs: 100 + targetOrdinal,
  };
  const targetSha256 = tenantTelemetryLifecycleTargetSha256(body);
  return {
    ...body,
    targetSha256,
    receiptSha256: tenantTelemetryLifecycleTargetReceiptSha256({ ...body, targetSha256 }),
  };
}

describe("tenant telemetry lifecycle evidence", () => {
  it("binds the exact logs/traces target set independently of caller order", () => {
    const logs = target("logs", 0);
    const traces = target("traces", 1);
    validateTenantTelemetryLifecycleTarget(logs);
    validateTenantTelemetryLifecycleTarget(traces);
    expect(tenantTelemetryLifecycleTargetRootSha256([logs, traces]))
      .toBe(tenantTelemetryLifecycleTargetRootSha256([traces, logs]));

    expect(() => tenantTelemetryLifecycleTargetRootSha256([logs, logs])).toThrow();
    expect(() => validateTenantTelemetryLifecycleTarget({
      ...logs,
      receiptSha256: D("f"),
    })).toThrow(/receipt mismatch/);
    const { targetSha256: _targetSha256, receiptSha256: _receiptSha256, ...logsBody } = logs;
    expect(() => tenantTelemetryLifecycleTargetSha256({
      ...logsBody,
      targetOrdinal: 1,
    } as TenantTelemetryLifecycleTargetBody)).toThrow(/ordinal/);
  });

  it("validates inactive and write-once active control evidence", () => {
    validateTenantTelemetryLifecycleControl({
      singletonId: TENANT_TELEMETRY_LIFECYCLE_CONTROL_SINGLETON_ID,
      state: "inactive",
      controlGeneration: 0,
    });
    const targetRootSha256 = tenantTelemetryLifecycleTargetRootSha256([
      target("logs", 0),
      target("traces", 1),
    ]);
    const body = {
      singletonId: TENANT_TELEMETRY_LIFECYCLE_CONTROL_SINGLETON_ID,
      state: "active" as const,
      controlGeneration: 1 as const,
      activatedAtDbMs: 200,
      lifecycleProtocol: TENANT_TELEMETRY_LIFECYCLE_PROTOCOL,
      writerProtocol: TENANT_TELEMETRY_WRITER_PROTOCOL,
      refKeyIdSha256: D("5"),
      targetCount: 2 as const,
      targetRootSha256,
    };
    const record: ActiveTenantTelemetryLifecycleControlRecord = {
      ...body,
      activationEvidenceSha256:
        tenantTelemetryLifecycleActivationEvidenceSha256(body),
    };
    validateTenantTelemetryLifecycleControl(record);
    expect(() => validateTenantTelemetryLifecycleControl({
      ...record,
      targetRootSha256: D("6"),
    })).toThrow(/evidence mismatch/);
    expect(() => validateTenantTelemetryLifecycleControl({
      singletonId: 1,
      state: "inactive",
      controlGeneration: 0,
      extra: true,
    } as never)).toThrow(/unknown or missing/);
  });

  it("uses the runtime keyed opaque tenant ref as the durable subject identity", () => {
    const key = Buffer.alloc(32, 7);
    const opaque = telemetryOpaqueRef("tenant", "tenant-private", key);
    const subjectRef = tenantTelemetrySubjectRefSha256(opaque);
    expect(subjectRef).toMatch(/^[0-9a-f]{64}$/);
    expect(subjectRef).toBe(
      tenantTelemetrySubjectRefForTenantSha256("tenant-private", key),
    );
    expect(subjectRef).not.toContain("tenant-private");
    expect(tenantTelemetrySubjectRefForTenantSha256("tenant-other", key))
      .not.toBe(subjectRef);
    expect(() => tenantTelemetrySubjectRefSha256(
      telemetryOpaqueRef("user", "tenant-private", key),
    )).toThrow(/tenant opaque ref/);
  });

  it("binds coverage and erasure subject receipts to exact owner tuples", () => {
    const targetRootSha256 = tenantTelemetryLifecycleTargetRootSha256([
      target("logs", 0),
      target("traces", 1),
    ]);
    const coverageBody = {
      tenantId: "tenant-a",
      controlGeneration: 1 as const,
      scope: TENANT_TELEMETRY_LIFECYCLE_COVERAGE_SCOPE,
      historyStatus: "complete_since_creation" as const,
      subjectRefSha256: D("7"),
      targetCount: 2 as const,
      targetRootSha256,
      coverageStartedAtDbMs: 300,
    };
    const coverage: TenantTelemetryLifecycleCoverageRecord = {
      ...coverageBody,
      evidenceSha256: tenantTelemetryLifecycleCoverageEvidenceSha256(coverageBody),
    };
    validateTenantTelemetryLifecycleCoverage(coverage);
    expect(tenantTelemetryLifecycleCoverageEvidenceSha256({
      ...coverageBody,
      tenantId: "tenant-b",
    })).not.toBe(coverage.evidenceSha256);

    const subjectBody = {
      requestId: REQUEST_ID,
      tenantId: coverage.tenantId,
      subjectGeneration: 1,
      controlGeneration: 1 as const,
      scope: TENANT_TELEMETRY_LIFECYCLE_SUBJECT_SCOPE,
      t1FenceSha256: D("8"),
      coverageEvidenceSha256: coverage.evidenceSha256,
      historyStatus: coverage.historyStatus,
      subjectRefSha256: coverage.subjectRefSha256,
      targetCount: 2 as const,
      targetRootSha256,
      boundAtDbMs: 400,
    };
    const subject: TenantTelemetryLifecycleSubjectRecord = {
      ...subjectBody,
      receiptSha256: tenantTelemetryLifecycleSubjectReceiptSha256(subjectBody),
    };
    validateTenantTelemetryLifecycleSubject(subject);
    expect(tenantTelemetryLifecycleSubjectReceiptSha256({
      ...subjectBody,
      tenantId: "tenant-b",
    })).not.toBe(subject.receiptSha256);
    expect(() => validateTenantTelemetryLifecycleSubject({
      ...subject,
      coverageEvidenceSha256: D("9"),
    })).toThrow(/receipt mismatch/);
  });
});
