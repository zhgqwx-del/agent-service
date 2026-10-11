import { createHash } from "node:crypto";
import {
  telemetryOpaqueRefSha256,
  type TelemetryOpaqueRef,
} from "@agent-service/protocol";

export const TENANT_TELEMETRY_LIFECYCLE_CONTROL_SINGLETON_ID = 1 as const;
export const TENANT_TELEMETRY_LIFECYCLE_PROTOCOL =
  "tenant-telemetry-lifecycle-v1" as const;
export const TENANT_TELEMETRY_WRITER_PROTOCOL = "structured-telemetry-v1" as const;
export const TENANT_TELEMETRY_LIFECYCLE_TARGET_SCOPE =
  "tenant-telemetry-lifecycle-target-v1" as const;
export const TENANT_TELEMETRY_LIFECYCLE_COVERAGE_SCOPE =
  "tenant-telemetry-lifecycle-coverage-v1" as const;
export const TENANT_TELEMETRY_LIFECYCLE_SUBJECT_SCOPE =
  "tenant-telemetry-lifecycle-subject-v1" as const;

export const TENANT_TELEMETRY_DOMAINS = ["logs", "traces"] as const;
export type TenantTelemetryDomain = (typeof TENANT_TELEMETRY_DOMAINS)[number];

export const TENANT_TELEMETRY_HISTORY_STATUSES = [
  "legacy_history_unknown",
  "complete_since_creation",
] as const;
export type TenantTelemetryHistoryStatus =
  (typeof TENANT_TELEMETRY_HISTORY_STATUSES)[number];

const SHA256 = /^[0-9a-f]{64}$/;
const BACKEND_KIND = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const ADAPTER_PROTOCOL = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const TENANT_REF = /^oref_tenant_([0-9a-f]{64})$/;
const REQUEST_ID =
  /^erase_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function exactKeys(value: object, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${name} has unknown or missing fields`);
  }
}

function digest(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 digest`);
  }
}

function timestamp(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function positive(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function tenantId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new Error("tenant telemetry tenant id is invalid");
  }
}

function historyStatus(
  value: unknown,
): asserts value is TenantTelemetryHistoryStatus {
  if (!(TENANT_TELEMETRY_HISTORY_STATUSES as readonly unknown[]).includes(value)) {
    throw new Error("tenant telemetry history status is invalid");
  }
}

function requestId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !REQUEST_ID.test(value)) {
    throw new Error("tenant telemetry erasure request id is invalid");
  }
}

/**
 * The SQL ledger stores only the digest portion of the runtime's keyed tenant opaque ref.  It
 * never stores the HMAC key or the full log field, and cannot derive a raw tenant id from it.
 */
export function tenantTelemetrySubjectRefSha256(ref: TelemetryOpaqueRef): string {
  const match = TENANT_REF.exec(ref);
  if (!match) throw new Error("tenant telemetry subject ref must be a tenant opaque ref");
  return match[1]!;
}

export function tenantTelemetrySubjectRefForTenantSha256(
  rawTenantId: string,
  refKey: Uint8Array,
): string {
  tenantId(rawTenantId);
  return telemetryOpaqueRefSha256("tenant", rawTenantId, refKey);
}

export interface TenantTelemetryLifecycleTargetBody {
  singletonId: typeof TENANT_TELEMETRY_LIFECYCLE_CONTROL_SINGLETON_ID;
  controlGeneration: 1;
  domain: TenantTelemetryDomain;
  targetOrdinal: 0 | 1;
  scope: typeof TENANT_TELEMETRY_LIFECYCLE_TARGET_SCOPE;
  backendKind: string;
  adapterProtocol: string;
  namespaceSha256: string;
  failureDomainSha256: string;
  createdAtDbMs: number;
}

export interface TenantTelemetryLifecycleTargetRecord
  extends TenantTelemetryLifecycleTargetBody {
  targetSha256: string;
  receiptSha256: string;
}

const TARGET_BODY_KEYS = [
  "singletonId",
  "controlGeneration",
  "domain",
  "targetOrdinal",
  "scope",
  "backendKind",
  "adapterProtocol",
  "namespaceSha256",
  "failureDomainSha256",
  "createdAtDbMs",
] as const;

function validateTargetBody(target: TenantTelemetryLifecycleTargetBody): void {
  exactKeys(target, TARGET_BODY_KEYS, "tenant telemetry lifecycle target");
  if (target.singletonId !== TENANT_TELEMETRY_LIFECYCLE_CONTROL_SINGLETON_ID
    || target.controlGeneration !== 1
    || target.scope !== TENANT_TELEMETRY_LIFECYCLE_TARGET_SCOPE) {
    throw new Error("tenant telemetry lifecycle target protocol is invalid");
  }
  if (target.domain === "logs") {
    if (target.targetOrdinal !== 0) throw new Error("logs target ordinal must be zero");
  } else if (target.domain === "traces") {
    if (target.targetOrdinal !== 1) throw new Error("traces target ordinal must be one");
  } else {
    throw new Error("tenant telemetry lifecycle target domain is invalid");
  }
  if (!BACKEND_KIND.test(target.backendKind)) {
    throw new Error("tenant telemetry lifecycle backend kind is invalid");
  }
  if (!ADAPTER_PROTOCOL.test(target.adapterProtocol)) {
    throw new Error("tenant telemetry lifecycle adapter protocol is invalid");
  }
  digest(target.namespaceSha256, "tenant telemetry namespace");
  digest(target.failureDomainSha256, "tenant telemetry failure domain");
  timestamp(target.createdAtDbMs, "tenant telemetry target creation time");
}

export function tenantTelemetryLifecycleTargetSha256(
  target: TenantTelemetryLifecycleTargetBody,
): string {
  validateTargetBody(target);
  return sha256([
    "tenant-telemetry-lifecycle-target-identity-v1",
    target.singletonId,
    target.controlGeneration,
    target.domain,
    target.targetOrdinal,
    target.scope,
    target.backendKind,
    target.adapterProtocol,
    target.namespaceSha256,
    target.failureDomainSha256,
  ]);
}

export function tenantTelemetryLifecycleTargetReceiptSha256(
  target: Omit<TenantTelemetryLifecycleTargetRecord, "receiptSha256">,
): string {
  exactKeys(target, [...TARGET_BODY_KEYS, "targetSha256"],
    "tenant telemetry lifecycle target receipt");
  const { targetSha256, ...body } = target;
  digest(targetSha256, "tenant telemetry target identity");
  if (targetSha256 !== tenantTelemetryLifecycleTargetSha256(body)) {
    throw new Error("tenant telemetry target identity mismatch");
  }
  return sha256([
    "tenant-telemetry-lifecycle-target-receipt-v1",
    targetSha256,
    target.createdAtDbMs,
  ]);
}

export function validateTenantTelemetryLifecycleTarget(
  target: TenantTelemetryLifecycleTargetRecord,
): void {
  exactKeys(target, [...TARGET_BODY_KEYS, "targetSha256", "receiptSha256"],
    "tenant telemetry lifecycle target record");
  digest(target.receiptSha256, "tenant telemetry target receipt");
  const { receiptSha256, ...body } = target;
  if (receiptSha256 !== tenantTelemetryLifecycleTargetReceiptSha256(body)) {
    throw new Error("tenant telemetry target receipt mismatch");
  }
}

export function tenantTelemetryLifecycleTargetRootSha256(
  targets: readonly TenantTelemetryLifecycleTargetRecord[],
): string {
  if (!Array.isArray(targets) || targets.length !== 2) {
    throw new Error("tenant telemetry lifecycle requires exactly two targets");
  }
  for (const target of targets) validateTenantTelemetryLifecycleTarget(target);
  const ordered = [...targets].sort((left, right) => left.targetOrdinal - right.targetOrdinal);
  if (ordered[0]!.domain !== "logs" || ordered[0]!.targetOrdinal !== 0
    || ordered[1]!.domain !== "traces" || ordered[1]!.targetOrdinal !== 1) {
    throw new Error("tenant telemetry lifecycle target set is incomplete");
  }
  return sha256([
    "tenant-telemetry-lifecycle-target-root-v1",
    ...ordered.map((target) => target.receiptSha256),
  ]);
}

export interface InactiveTenantTelemetryLifecycleControlRecord {
  singletonId: typeof TENANT_TELEMETRY_LIFECYCLE_CONTROL_SINGLETON_ID;
  state: "inactive";
  controlGeneration: 0;
}

export interface ActiveTenantTelemetryLifecycleControlRecord {
  singletonId: typeof TENANT_TELEMETRY_LIFECYCLE_CONTROL_SINGLETON_ID;
  state: "active";
  controlGeneration: 1;
  activatedAtDbMs: number;
  lifecycleProtocol: typeof TENANT_TELEMETRY_LIFECYCLE_PROTOCOL;
  writerProtocol: typeof TENANT_TELEMETRY_WRITER_PROTOCOL;
  refKeyIdSha256: string;
  targetCount: 2;
  targetRootSha256: string;
  activationEvidenceSha256: string;
}

export type TenantTelemetryLifecycleControlRecord =
  | InactiveTenantTelemetryLifecycleControlRecord
  | ActiveTenantTelemetryLifecycleControlRecord;

const ACTIVE_CONTROL_BODY_KEYS = [
  "singletonId",
  "state",
  "controlGeneration",
  "activatedAtDbMs",
  "lifecycleProtocol",
  "writerProtocol",
  "refKeyIdSha256",
  "targetCount",
  "targetRootSha256",
] as const;

export function tenantTelemetryLifecycleActivationEvidenceSha256(
  control: Omit<ActiveTenantTelemetryLifecycleControlRecord, "activationEvidenceSha256">,
): string {
  exactKeys(control, ACTIVE_CONTROL_BODY_KEYS, "tenant telemetry lifecycle activation");
  if (control.singletonId !== TENANT_TELEMETRY_LIFECYCLE_CONTROL_SINGLETON_ID
    || control.state !== "active"
    || control.controlGeneration !== 1
    || control.lifecycleProtocol !== TENANT_TELEMETRY_LIFECYCLE_PROTOCOL
    || control.writerProtocol !== TENANT_TELEMETRY_WRITER_PROTOCOL
    || control.targetCount !== 2) {
    throw new Error("tenant telemetry lifecycle activation protocol is invalid");
  }
  timestamp(control.activatedAtDbMs, "tenant telemetry lifecycle activation time");
  digest(control.refKeyIdSha256, "tenant telemetry ref key id");
  digest(control.targetRootSha256, "tenant telemetry target root");
  return sha256([
    "tenant-telemetry-lifecycle-activation-evidence-v1",
    ...ACTIVE_CONTROL_BODY_KEYS.map((key) => control[key]),
  ]);
}

export function validateTenantTelemetryLifecycleControl(
  control: TenantTelemetryLifecycleControlRecord,
): void {
  if (control.state === "inactive") {
    exactKeys(control, ["singletonId", "state", "controlGeneration"],
      "inactive tenant telemetry lifecycle control");
    if (control.singletonId !== TENANT_TELEMETRY_LIFECYCLE_CONTROL_SINGLETON_ID
      || control.controlGeneration !== 0) {
      throw new Error("inactive tenant telemetry lifecycle control is invalid");
    }
    return;
  }
  exactKeys(control, [...ACTIVE_CONTROL_BODY_KEYS, "activationEvidenceSha256"],
    "active tenant telemetry lifecycle control");
  digest(control.activationEvidenceSha256, "tenant telemetry activation evidence");
  const { activationEvidenceSha256, ...body } = control;
  if (activationEvidenceSha256 !== tenantTelemetryLifecycleActivationEvidenceSha256(body)) {
    throw new Error("tenant telemetry activation evidence mismatch");
  }
}

export interface TenantTelemetryLifecycleCoverageBody {
  tenantId: string;
  controlGeneration: 1;
  scope: typeof TENANT_TELEMETRY_LIFECYCLE_COVERAGE_SCOPE;
  historyStatus: TenantTelemetryHistoryStatus;
  subjectRefSha256: string;
  targetCount: 2;
  targetRootSha256: string;
  coverageStartedAtDbMs: number;
}

export interface TenantTelemetryLifecycleCoverageRecord
  extends TenantTelemetryLifecycleCoverageBody {
  evidenceSha256: string;
}

const COVERAGE_BODY_KEYS = [
  "tenantId",
  "controlGeneration",
  "scope",
  "historyStatus",
  "subjectRefSha256",
  "targetCount",
  "targetRootSha256",
  "coverageStartedAtDbMs",
] as const;

export function tenantTelemetryLifecycleCoverageEvidenceSha256(
  coverage: TenantTelemetryLifecycleCoverageBody,
): string {
  exactKeys(coverage, COVERAGE_BODY_KEYS, "tenant telemetry lifecycle coverage");
  tenantId(coverage.tenantId);
  if (coverage.controlGeneration !== 1
    || coverage.scope !== TENANT_TELEMETRY_LIFECYCLE_COVERAGE_SCOPE
    || coverage.targetCount !== 2) {
    throw new Error("tenant telemetry lifecycle coverage protocol is invalid");
  }
  historyStatus(coverage.historyStatus);
  digest(coverage.subjectRefSha256, "tenant telemetry coverage subject ref");
  digest(coverage.targetRootSha256, "tenant telemetry coverage target root");
  timestamp(coverage.coverageStartedAtDbMs, "tenant telemetry coverage start time");
  return sha256([
    "tenant-telemetry-lifecycle-coverage-evidence-v1",
    coverage.tenantId,
    coverage.controlGeneration,
    coverage.scope,
    coverage.historyStatus,
    coverage.subjectRefSha256,
    coverage.targetCount,
    coverage.targetRootSha256,
    coverage.coverageStartedAtDbMs,
  ]);
}

export function validateTenantTelemetryLifecycleCoverage(
  coverage: TenantTelemetryLifecycleCoverageRecord,
): void {
  exactKeys(coverage, [...COVERAGE_BODY_KEYS, "evidenceSha256"],
    "tenant telemetry lifecycle coverage record");
  digest(coverage.evidenceSha256, "tenant telemetry coverage evidence");
  const { evidenceSha256, ...body } = coverage;
  if (evidenceSha256 !== tenantTelemetryLifecycleCoverageEvidenceSha256(body)) {
    throw new Error("tenant telemetry coverage evidence mismatch");
  }
}

export interface TenantTelemetryLifecycleSubjectBody {
  requestId: string;
  tenantId: string;
  subjectGeneration: number;
  controlGeneration: 1;
  scope: typeof TENANT_TELEMETRY_LIFECYCLE_SUBJECT_SCOPE;
  t1FenceSha256: string;
  coverageEvidenceSha256: string;
  historyStatus: TenantTelemetryHistoryStatus;
  subjectRefSha256: string;
  targetCount: 2;
  targetRootSha256: string;
  boundAtDbMs: number;
}

export interface TenantTelemetryLifecycleSubjectRecord
  extends TenantTelemetryLifecycleSubjectBody {
  receiptSha256: string;
}

const SUBJECT_BODY_KEYS = [
  "requestId",
  "tenantId",
  "subjectGeneration",
  "controlGeneration",
  "scope",
  "t1FenceSha256",
  "coverageEvidenceSha256",
  "historyStatus",
  "subjectRefSha256",
  "targetCount",
  "targetRootSha256",
  "boundAtDbMs",
] as const;

export function tenantTelemetryLifecycleSubjectReceiptSha256(
  subject: TenantTelemetryLifecycleSubjectBody,
): string {
  exactKeys(subject, SUBJECT_BODY_KEYS, "tenant telemetry lifecycle subject");
  requestId(subject.requestId);
  tenantId(subject.tenantId);
  positive(subject.subjectGeneration, "tenant telemetry subject generation");
  if (subject.controlGeneration !== 1
    || subject.scope !== TENANT_TELEMETRY_LIFECYCLE_SUBJECT_SCOPE
    || subject.targetCount !== 2) {
    throw new Error("tenant telemetry lifecycle subject protocol is invalid");
  }
  historyStatus(subject.historyStatus);
  digest(subject.t1FenceSha256, "tenant telemetry subject T1 fence");
  digest(subject.coverageEvidenceSha256, "tenant telemetry subject coverage evidence");
  digest(subject.subjectRefSha256, "tenant telemetry subject ref");
  digest(subject.targetRootSha256, "tenant telemetry subject target root");
  timestamp(subject.boundAtDbMs, "tenant telemetry subject binding time");
  return sha256([
    "tenant-telemetry-lifecycle-subject-receipt-v1",
    subject.requestId,
    subject.tenantId,
    subject.subjectGeneration,
    subject.controlGeneration,
    subject.scope,
    subject.t1FenceSha256,
    subject.coverageEvidenceSha256,
    subject.historyStatus,
    subject.subjectRefSha256,
    subject.targetCount,
    subject.targetRootSha256,
    subject.boundAtDbMs,
  ]);
}

export function validateTenantTelemetryLifecycleSubject(
  subject: TenantTelemetryLifecycleSubjectRecord,
): void {
  exactKeys(subject, [...SUBJECT_BODY_KEYS, "receiptSha256"],
    "tenant telemetry lifecycle subject record");
  digest(subject.receiptSha256, "tenant telemetry subject receipt");
  const { receiptSha256, ...body } = subject;
  if (receiptSha256 !== tenantTelemetryLifecycleSubjectReceiptSha256(body)) {
    throw new Error("tenant telemetry subject receipt mismatch");
  }
}
