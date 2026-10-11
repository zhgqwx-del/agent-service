import { describe, expect, it } from "vitest";
import {
  TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
  canonicalizeTenantTelemetryArtifactPayload,
  tenantTelemetryArtifactManifestSha256,
  tenantTelemetryArtifactPayloadByteLength,
  tenantTelemetryArtifactPayloadCanonicalJson,
  tenantTelemetryArtifactPayloadSha256,
  tenantTelemetryWriteAdapterEvidenceSha256,
  tenantTelemetryWriteOperationSha256,
  validateTenantTelemetryWriteAdapterResult,
  type TenantTelemetryArtifactManifestInput,
  type TenantTelemetryArtifactPayload,
} from "../src/index.js";

const D = (character: string) => character.repeat(64);

const record = (fields: Record<string, unknown> = {}) => ({
  schema: "agent-service.telemetry.v1" as const,
  timestampMs: 100,
  level: "info" as const,
  component: "runner" as const,
  code: "runner.runtime.info" as const,
  fields,
});

const payload = (fields: Record<string, unknown> = {}): TenantTelemetryArtifactPayload => ({
  schema: TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
  domain: "logs",
  records: [record(fields)],
});

const manifestInput = (): TenantTelemetryArtifactManifestInput => ({
  tenantId: "tenant-a",
  controlGeneration: 1,
  domain: "logs",
  targetSha256: D("1"),
  artifactIdSha256: D("2"),
  artifactGeneration: 1,
  ownerKind: "session",
  tenantRefSha256: D("3"),
  ownerRefSha256: D("4"),
  holdSubjectRefSha256: D("5"),
  coverageEvidenceSha256: D("6"),
  sourceSchema: "structured-log-batch-v1",
  sourceGeneration: 7,
  sourceHighWaterDbMs: 101,
  payloadSha256: D("7"),
});

describe("durable tenant telemetry writer evidence", () => {
  it("canonicalizes the closed telemetry vocabulary and hashes UTF-8 bytes", () => {
    const left = payload({
      ownerRef: `oref_owner_${D("a")}`,
      retryable: true,
      attempt: 2,
    });
    const right = payload({
      attempt: 2,
      retryable: true,
      ownerRef: `oref_owner_${D("a")}`,
    });
    const canonical = canonicalizeTenantTelemetryArtifactPayload(left);
    expect(Object.isFrozen(canonical)).toBe(true);
    expect(Object.isFrozen(canonical.records)).toBe(true);
    expect(Object.isFrozen(canonical.records[0])).toBe(true);
    expect(Object.isFrozen(canonical.records[0]!.fields)).toBe(true);
    expect(tenantTelemetryArtifactPayloadCanonicalJson(left))
      .toBe(tenantTelemetryArtifactPayloadCanonicalJson(right));
    expect(tenantTelemetryArtifactPayloadSha256(left))
      .toBe(tenantTelemetryArtifactPayloadSha256(right));
    expect(tenantTelemetryArtifactPayloadByteLength(left))
      .toBe(Buffer.byteLength(tenantTelemetryArtifactPayloadCanonicalJson(left), "utf8"));
  });

  it("rejects extra fields, raw identifiers and out-of-range batches", () => {
    expect(() => canonicalizeTenantTelemetryArtifactPayload({
      ...payload(),
      endpoint: "https://logs.example.invalid",
    })).toThrow(/unknown or missing/);
    expect(() => canonicalizeTenantTelemetryArtifactPayload(payload({
      tenantId: "raw-tenant",
    }))).toThrow(/not allowlisted/);
    expect(() => canonicalizeTenantTelemetryArtifactPayload({
      ...payload(),
      records: [],
    })).toThrow(/record count/);
    expect(() => canonicalizeTenantTelemetryArtifactPayload({
      ...payload(),
      records: Array.from({ length: 101 }, () => record()),
    })).toThrow(/record count/);
  });

  it("binds every protected owner/source field into the manifest and operation", () => {
    const base = manifestInput();
    const digest = tenantTelemetryArtifactManifestSha256(base);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    const variants: TenantTelemetryArtifactManifestInput[] = [
      { ...base, tenantId: "tenant-b" },
      { ...base, domain: "traces" },
      { ...base, targetSha256: D("8") },
      { ...base, artifactIdSha256: D("9") },
      { ...base, artifactGeneration: 2 },
      { ...base, ownerKind: "user" },
      { ...base, tenantRefSha256: D("a") },
      { ...base, ownerRefSha256: D("b") },
      { ...base, holdSubjectRefSha256: D("c") },
      { ...base, coverageEvidenceSha256: D("d") },
      { ...base, sourceSchema: "structured-trace-batch-v1" },
      { ...base, sourceGeneration: 8 },
      { ...base, sourceHighWaterDbMs: 102 },
      { ...base, payloadSha256: D("e") },
    ];
    for (const variant of variants) {
      expect(tenantTelemetryArtifactManifestSha256(variant)).not.toBe(digest);
    }
    expect(tenantTelemetryWriteOperationSha256(digest)).toMatch(/^[0-9a-f]{64}$/);
    expect(tenantTelemetryWriteOperationSha256(digest))
      .not.toBe(tenantTelemetryWriteOperationSha256(D("f")));
  });

  it("makes outcome and replay semantics part of adapter evidence", () => {
    const evidence = {
      adapterProtocol: "telemetry-memory-v1",
      domain: "logs" as const,
      targetSha256: D("1"),
      writeOperationSha256: D("2"),
      artifactIdSha256: D("3"),
      artifactGeneration: 1,
      payloadSha256: D("4"),
      manifestSha256: D("5"),
      outcome: "written" as const,
      replayed: false,
    };
    const result = {
      ...evidence,
      evidenceSha256: tenantTelemetryWriteAdapterEvidenceSha256(evidence),
    };
    expect(() => validateTenantTelemetryWriteAdapterResult(result)).not.toThrow();
    expect(tenantTelemetryWriteAdapterEvidenceSha256({ ...evidence, replayed: true }))
      .not.toBe(result.evidenceSha256);
    expect(() => validateTenantTelemetryWriteAdapterResult({
      ...result,
      replayed: true,
    })).toThrow(/does not match/);
  });
});
