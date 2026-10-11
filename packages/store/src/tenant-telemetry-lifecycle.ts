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
export const TENANT_TELEMETRY_LIFECYCLE_ACTIVATION_SCOPE =
  "tenant-telemetry-lifecycle-activation-v1" as const;
export const TENANT_TELEMETRY_ARTIFACT_INVENTORY_SCOPE =
  "tenant-telemetry-artifact-inventory-v1" as const;
export const TENANT_TELEMETRY_RETENTION_CLASS =
  "telemetry_policy_unconfigured" as const;

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
const SOURCE_SCHEMA = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

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

function nonNegative(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
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

export class TenantTelemetryLifecycleConflictError extends Error {
  constructor(message = "tenant telemetry lifecycle state conflicts with the requested operation") {
    super(message);
    this.name = "TenantTelemetryLifecycleConflictError";
  }
}

export class TenantTelemetryLifecycleIntegrityError extends Error {
  constructor(message = "tenant telemetry lifecycle evidence is invalid") {
    super(message);
    this.name = "TenantTelemetryLifecycleIntegrityError";
  }
}

export interface ActivateTenantTelemetryTargetInput {
  domain: TenantTelemetryDomain;
  backendKind: string;
  adapterProtocol: string;
  namespaceSha256: string;
  failureDomainSha256: string;
}

export interface ActivateTenantTelemetryLifecycleInput {
  expectedControlGeneration: 0;
  targets: ActivateTenantTelemetryTargetInput[];
}

const ACTIVATION_TARGET_INPUT_KEYS = [
  "domain",
  "backendKind",
  "adapterProtocol",
  "namespaceSha256",
  "failureDomainSha256",
] as const;

const ACTIVATION_INPUT_KEYS = [
  "expectedControlGeneration",
  "targets",
] as const;

export function validateActivateTenantTelemetryLifecycleInput(
  input: ActivateTenantTelemetryLifecycleInput,
): void {
  exactKeys(input, ACTIVATION_INPUT_KEYS, "tenant telemetry lifecycle activation input");
  if (input.expectedControlGeneration !== 0) {
    throw new Error("tenant telemetry activation expected generation must be zero");
  }
  if (!Array.isArray(input.targets) || input.targets.length !== 2) {
    throw new Error("tenant telemetry activation requires exactly two targets");
  }
  const domains = new Set<TenantTelemetryDomain>();
  const namespaces = new Set<string>();
  for (const target of input.targets) {
    exactKeys(target, ACTIVATION_TARGET_INPUT_KEYS, "tenant telemetry activation target input");
    if (!(TENANT_TELEMETRY_DOMAINS as readonly unknown[]).includes(target.domain)) {
      throw new Error("tenant telemetry activation target domain is invalid");
    }
    if (!BACKEND_KIND.test(target.backendKind)) {
      throw new Error("tenant telemetry activation backend kind is invalid");
    }
    if (!ADAPTER_PROTOCOL.test(target.adapterProtocol)) {
      throw new Error("tenant telemetry activation adapter protocol is invalid");
    }
    digest(target.namespaceSha256, "tenant telemetry activation namespace");
    digest(target.failureDomainSha256, "tenant telemetry activation failure domain");
    if (domains.has(target.domain)) {
      throw new Error("tenant telemetry activation target domain is duplicated");
    }
    if (namespaces.has(target.namespaceSha256)) {
      throw new Error("tenant telemetry activation target namespace is duplicated");
    }
    domains.add(target.domain);
    namespaces.add(target.namespaceSha256);
  }
  if (!domains.has("logs") || !domains.has("traces")) {
    throw new Error("tenant telemetry activation target set is incomplete");
  }
}

function activationTargetSortKey(target: ActivateTenantTelemetryTargetInput): number {
  return target.domain === "logs" ? 0 : 1;
}

export function tenantTelemetryLifecycleActivationRequestSha256(
  input: ActivateTenantTelemetryLifecycleInput,
  refKeyIdSha256: string,
): string {
  validateActivateTenantTelemetryLifecycleInput(input);
  digest(refKeyIdSha256, "tenant telemetry activation ref key id");
  const targets = [...input.targets]
    .sort((left, right) => activationTargetSortKey(left) - activationTargetSortKey(right));
  return sha256([
    "tenant-telemetry-lifecycle-activation-request-v1",
    input.expectedControlGeneration,
    refKeyIdSha256,
    targets.map((target) => [
      target.domain,
      target.backendKind,
      target.adapterProtocol,
      target.namespaceSha256,
      target.failureDomainSha256,
    ]),
  ]);
}

export function tenantTelemetryLifecycleCoverageRootSha256(
  coverages: readonly TenantTelemetryLifecycleCoverageRecord[],
): string {
  if (!Array.isArray(coverages)) {
    throw new Error("tenant telemetry lifecycle coverage set is invalid");
  }
  const tenants = new Set<string>();
  const refs = new Set<string>();
  const ordered = [...coverages].sort((left, right) =>
    Buffer.compare(Buffer.from(left.tenantId, "utf8"), Buffer.from(right.tenantId, "utf8")));
  for (const coverage of ordered) {
    validateTenantTelemetryLifecycleCoverage(coverage);
    if (tenants.has(coverage.tenantId) || refs.has(coverage.subjectRefSha256)) {
      throw new Error("tenant telemetry lifecycle coverage set is duplicated");
    }
    tenants.add(coverage.tenantId);
    refs.add(coverage.subjectRefSha256);
  }
  return sha256([
    "tenant-telemetry-lifecycle-coverage-root-v1",
    ...ordered.map((coverage) => coverage.evidenceSha256),
  ]);
}

export interface TenantTelemetryLifecycleActivationReceiptBody {
  singletonId: typeof TENANT_TELEMETRY_LIFECYCLE_CONTROL_SINGLETON_ID;
  controlGeneration: 1;
  scope: typeof TENANT_TELEMETRY_LIFECYCLE_ACTIVATION_SCOPE;
  requestSha256: string;
  refKeyIdSha256: string;
  targetCount: 2;
  targetRootSha256: string;
  coverageCount: number;
  coverageRootSha256: string;
  controlEvidenceSha256: string;
  activatedAtDbMs: number;
}

export interface TenantTelemetryLifecycleActivationReceipt
  extends TenantTelemetryLifecycleActivationReceiptBody {
  receiptSha256: string;
}

const ACTIVATION_RECEIPT_BODY_KEYS = [
  "singletonId",
  "controlGeneration",
  "scope",
  "requestSha256",
  "refKeyIdSha256",
  "targetCount",
  "targetRootSha256",
  "coverageCount",
  "coverageRootSha256",
  "controlEvidenceSha256",
  "activatedAtDbMs",
] as const;

export function tenantTelemetryLifecycleActivationReceiptSha256(
  receipt: TenantTelemetryLifecycleActivationReceiptBody,
): string {
  exactKeys(
    receipt,
    ACTIVATION_RECEIPT_BODY_KEYS,
    "tenant telemetry lifecycle activation receipt",
  );
  if (receipt.singletonId !== TENANT_TELEMETRY_LIFECYCLE_CONTROL_SINGLETON_ID
    || receipt.controlGeneration !== 1
    || receipt.scope !== TENANT_TELEMETRY_LIFECYCLE_ACTIVATION_SCOPE
    || receipt.targetCount !== 2) {
    throw new Error("tenant telemetry lifecycle activation receipt protocol is invalid");
  }
  digest(receipt.requestSha256, "tenant telemetry activation request");
  digest(receipt.refKeyIdSha256, "tenant telemetry activation ref key id");
  digest(receipt.targetRootSha256, "tenant telemetry activation target root");
  nonNegative(receipt.coverageCount, "tenant telemetry activation coverage count");
  digest(receipt.coverageRootSha256, "tenant telemetry activation coverage root");
  digest(receipt.controlEvidenceSha256, "tenant telemetry activation control evidence");
  timestamp(receipt.activatedAtDbMs, "tenant telemetry activation receipt time");
  return sha256([
    "tenant-telemetry-lifecycle-activation-receipt-v1",
    ...ACTIVATION_RECEIPT_BODY_KEYS.map((key) => receipt[key]),
  ]);
}

export function validateTenantTelemetryLifecycleActivationReceipt(
  receipt: TenantTelemetryLifecycleActivationReceipt,
): void {
  exactKeys(
    receipt,
    [...ACTIVATION_RECEIPT_BODY_KEYS, "receiptSha256"],
    "tenant telemetry lifecycle activation receipt record",
  );
  digest(receipt.receiptSha256, "tenant telemetry activation receipt");
  const { receiptSha256, ...body } = receipt;
  if (receiptSha256 !== tenantTelemetryLifecycleActivationReceiptSha256(body)) {
    throw new Error("tenant telemetry activation receipt mismatch");
  }
}

export interface TenantTelemetryLifecycleActivationResult {
  control: ActiveTenantTelemetryLifecycleControlRecord;
  targets: TenantTelemetryLifecycleTargetRecord[];
  receipt: TenantTelemetryLifecycleActivationReceipt;
}

export interface RegisterTenantTelemetryCoverageInput {
  tenantId: string;
  expectedControlGeneration: 1;
  historyStatus: "complete_since_creation";
}

const REGISTER_COVERAGE_INPUT_KEYS = [
  "tenantId",
  "expectedControlGeneration",
  "historyStatus",
] as const;

export function validateRegisterTenantTelemetryCoverageInput(
  input: RegisterTenantTelemetryCoverageInput,
): void {
  exactKeys(input, REGISTER_COVERAGE_INPUT_KEYS, "tenant telemetry coverage registration input");
  tenantId(input.tenantId);
  if (input.expectedControlGeneration !== 1
    || input.historyStatus !== "complete_since_creation") {
    throw new Error("tenant telemetry coverage registration protocol is invalid");
  }
}

export const TENANT_TELEMETRY_OWNER_KINDS = ["tenant", "user", "session"] as const;
export type TenantTelemetryOwnerKind = (typeof TENANT_TELEMETRY_OWNER_KINDS)[number];

export interface RegisterTenantTelemetryArtifactInput {
  tenantId: string;
  expectedControlGeneration: 1;
  domain: TenantTelemetryDomain;
  artifactIdSha256: string;
  artifactGeneration: number;
  ownerKind: TenantTelemetryOwnerKind;
  ownerId: string;
  ownerUserId: string | null;
  sourceSchema: string;
  sourceGeneration: number;
  sourceHighWaterDbMs: number;
  payloadSha256: string;
  manifestSha256: string;
}

const REGISTER_ARTIFACT_INPUT_KEYS = [
  "tenantId",
  "expectedControlGeneration",
  "domain",
  "artifactIdSha256",
  "artifactGeneration",
  "ownerKind",
  "ownerId",
  "ownerUserId",
  "sourceSchema",
  "sourceGeneration",
  "sourceHighWaterDbMs",
  "payloadSha256",
  "manifestSha256",
] as const;

export function validateRegisterTenantTelemetryArtifactInput(
  input: RegisterTenantTelemetryArtifactInput,
): void {
  exactKeys(input, REGISTER_ARTIFACT_INPUT_KEYS, "tenant telemetry artifact registration input");
  tenantId(input.tenantId);
  if (input.expectedControlGeneration !== 1
    || !(TENANT_TELEMETRY_DOMAINS as readonly unknown[]).includes(input.domain)) {
    throw new Error("tenant telemetry artifact registration protocol is invalid");
  }
  digest(input.artifactIdSha256, "tenant telemetry artifact id");
  positive(input.artifactGeneration, "tenant telemetry artifact generation");
  if (!(TENANT_TELEMETRY_OWNER_KINDS as readonly unknown[]).includes(input.ownerKind)) {
    throw new Error("tenant telemetry artifact owner kind is invalid");
  }
  if (typeof input.ownerId !== "string" || input.ownerId.length < 1 || input.ownerId.length > 128) {
    throw new Error("tenant telemetry artifact owner id is invalid");
  }
  if (input.ownerKind === "tenant") {
    if (input.ownerId !== input.tenantId || input.ownerUserId !== null) {
      throw new Error("tenant telemetry tenant owner must match the tenant id");
    }
  } else {
    if (typeof input.ownerUserId !== "string"
      || input.ownerUserId.length < 1
      || input.ownerUserId.length > 128) {
      throw new Error("tenant telemetry artifact owner user id is invalid");
    }
    if (input.ownerKind === "user" && input.ownerUserId !== input.ownerId) {
      throw new Error("tenant telemetry user owner must match the owner user id");
    }
  }
  if (!SOURCE_SCHEMA.test(input.sourceSchema)) {
    throw new Error("tenant telemetry artifact source schema is invalid");
  }
  nonNegative(input.sourceGeneration, "tenant telemetry artifact source generation");
  timestamp(input.sourceHighWaterDbMs, "tenant telemetry artifact source high-water");
  digest(input.payloadSha256, "tenant telemetry artifact payload");
  digest(input.manifestSha256, "tenant telemetry artifact manifest");
}

export function tenantTelemetryRefKeyIdSha256(refKey: Uint8Array): string {
  if (!(refKey instanceof Uint8Array) || refKey.byteLength !== 32) {
    throw new Error("tenant telemetry ref key must contain exactly 32 bytes");
  }
  return createHash("sha256")
    .update("agent-service/tenant-telemetry-ref-key-id/v1\0", "utf8")
    .update(refKey)
    .digest("hex");
}

export function tenantTelemetryOwnerRefSha256(
  ownerKind: TenantTelemetryOwnerKind,
  rawOwnerId: string,
  refKey: Uint8Array,
): string {
  if (!(TENANT_TELEMETRY_OWNER_KINDS as readonly unknown[]).includes(ownerKind)) {
    throw new Error("tenant telemetry owner kind is invalid");
  }
  if (typeof rawOwnerId !== "string" || rawOwnerId.length < 1 || rawOwnerId.length > 128) {
    throw new Error("tenant telemetry owner id is invalid");
  }
  tenantTelemetryRefKeyIdSha256(refKey);
  return telemetryOpaqueRefSha256(ownerKind, rawOwnerId, refKey);
}

export interface TenantTelemetryArtifactInventoryBody {
  inventorySha256: string;
  tenantId: string;
  controlGeneration: 1;
  scope: typeof TENANT_TELEMETRY_ARTIFACT_INVENTORY_SCOPE;
  domain: TenantTelemetryDomain;
  targetSha256: string;
  artifactIdSha256: string;
  artifactGeneration: number;
  ownerKind: TenantTelemetryOwnerKind;
  tenantRefSha256: string;
  ownerRefSha256: string;
  holdSubjectRefSha256: string;
  coverageEvidenceSha256: string;
  historyStatus: TenantTelemetryHistoryStatus;
  writerProtocol: typeof TENANT_TELEMETRY_WRITER_PROTOCOL;
  writerGeneration: 1;
  sourceSchema: string;
  sourceGeneration: number;
  sourceHighWaterDbMs: number;
  payloadSha256: string;
  manifestSha256: string;
  retentionClass: typeof TENANT_TELEMETRY_RETENTION_CLASS;
  retentionPolicyControlGeneration: number;
  retentionPolicySha256: string | null;
  disposeAfterDbMs: number | null;
  tenantHoldControlGeneration: number;
  tenantHoldProjectionSha256: string;
  ownerHoldControlGeneration: number;
  ownerHoldProjectionSha256: string;
  restoreControlGeneration: number;
  restoreLineageKind: "inactive" | "primary" | "restore";
  restoreUpdatedAtDbMs: number;
  runtimeEpochSha256: string | null;
  createdAtDbMs: number;
}

export interface TenantTelemetryArtifactInventoryRecord
  extends TenantTelemetryArtifactInventoryBody {
  receiptSha256: string;
}

const ARTIFACT_INVENTORY_BODY_KEYS = [
  "inventorySha256",
  "tenantId",
  "controlGeneration",
  "scope",
  "domain",
  "targetSha256",
  "artifactIdSha256",
  "artifactGeneration",
  "ownerKind",
  "tenantRefSha256",
  "ownerRefSha256",
  "holdSubjectRefSha256",
  "coverageEvidenceSha256",
  "historyStatus",
  "writerProtocol",
  "writerGeneration",
  "sourceSchema",
  "sourceGeneration",
  "sourceHighWaterDbMs",
  "payloadSha256",
  "manifestSha256",
  "retentionClass",
  "retentionPolicyControlGeneration",
  "retentionPolicySha256",
  "disposeAfterDbMs",
  "tenantHoldControlGeneration",
  "tenantHoldProjectionSha256",
  "ownerHoldControlGeneration",
  "ownerHoldProjectionSha256",
  "restoreControlGeneration",
  "restoreLineageKind",
  "restoreUpdatedAtDbMs",
  "runtimeEpochSha256",
  "createdAtDbMs",
] as const;

export function tenantTelemetryArtifactInventorySha256(input: Pick<
  TenantTelemetryArtifactInventoryBody,
  | "tenantId"
  | "controlGeneration"
  | "domain"
  | "targetSha256"
  | "artifactIdSha256"
  | "artifactGeneration"
  | "ownerKind"
  | "tenantRefSha256"
  | "ownerRefSha256"
>): string {
  if (input.controlGeneration !== 1
    || !(TENANT_TELEMETRY_DOMAINS as readonly unknown[]).includes(input.domain)) {
    throw new Error("tenant telemetry artifact inventory identity protocol is invalid");
  }
  digest(input.targetSha256, "tenant telemetry inventory target");
  digest(input.artifactIdSha256, "tenant telemetry inventory artifact id");
  tenantId(input.tenantId);
  if (!(TENANT_TELEMETRY_OWNER_KINDS as readonly unknown[]).includes(input.ownerKind)) {
    throw new Error("tenant telemetry inventory owner kind is invalid");
  }
  digest(input.tenantRefSha256, "tenant telemetry inventory tenant ref");
  digest(input.ownerRefSha256, "tenant telemetry inventory owner ref");
  positive(input.artifactGeneration, "tenant telemetry inventory artifact generation");
  return sha256([
    "tenant-telemetry-artifact-inventory-identity-v1",
    input.tenantId,
    input.controlGeneration,
    input.domain,
    input.targetSha256,
    input.artifactIdSha256,
    input.artifactGeneration,
    input.ownerKind,
    input.tenantRefSha256,
    input.ownerRefSha256,
  ]);
}

export function tenantTelemetryArtifactInventoryReceiptSha256(
  inventory: TenantTelemetryArtifactInventoryBody,
): string {
  exactKeys(inventory, ARTIFACT_INVENTORY_BODY_KEYS, "tenant telemetry artifact inventory receipt");
  digest(inventory.inventorySha256, "tenant telemetry inventory identity");
  tenantId(inventory.tenantId);
  if (inventory.controlGeneration !== 1
    || inventory.scope !== TENANT_TELEMETRY_ARTIFACT_INVENTORY_SCOPE
    || !(TENANT_TELEMETRY_DOMAINS as readonly unknown[]).includes(inventory.domain)
    || !(TENANT_TELEMETRY_OWNER_KINDS as readonly unknown[]).includes(inventory.ownerKind)
    || inventory.writerProtocol !== TENANT_TELEMETRY_WRITER_PROTOCOL
    || inventory.writerGeneration !== 1
    || inventory.retentionClass !== TENANT_TELEMETRY_RETENTION_CLASS) {
    throw new Error("tenant telemetry artifact inventory protocol is invalid");
  }
  digest(inventory.targetSha256, "tenant telemetry inventory target");
  digest(inventory.artifactIdSha256, "tenant telemetry inventory artifact id");
  positive(inventory.artifactGeneration, "tenant telemetry inventory artifact generation");
  digest(inventory.tenantRefSha256, "tenant telemetry inventory tenant ref");
  digest(inventory.ownerRefSha256, "tenant telemetry inventory owner ref");
  digest(inventory.holdSubjectRefSha256, "tenant telemetry inventory hold subject ref");
  digest(inventory.coverageEvidenceSha256, "tenant telemetry inventory coverage evidence");
  historyStatus(inventory.historyStatus);
  if (inventory.ownerKind === "tenant") {
    if (inventory.ownerRefSha256 !== inventory.tenantRefSha256
      || inventory.holdSubjectRefSha256 !== inventory.tenantRefSha256) {
      throw new Error("tenant telemetry inventory tenant owner ref is invalid");
    }
  } else if (inventory.ownerKind === "user"
    && inventory.ownerRefSha256 !== inventory.holdSubjectRefSha256) {
    throw new Error("tenant telemetry inventory user hold subject ref is invalid");
  }
  if (!SOURCE_SCHEMA.test(inventory.sourceSchema)) {
    throw new Error("tenant telemetry inventory source schema is invalid");
  }
  nonNegative(inventory.sourceGeneration, "tenant telemetry inventory source generation");
  timestamp(inventory.sourceHighWaterDbMs, "tenant telemetry inventory source high-water");
  digest(inventory.payloadSha256, "tenant telemetry inventory payload");
  digest(inventory.manifestSha256, "tenant telemetry inventory manifest");
  nonNegative(
    inventory.retentionPolicyControlGeneration,
    "tenant telemetry inventory retention generation",
  );
  if (inventory.disposeAfterDbMs !== null) {
    throw new Error("tenant telemetry retention is not configured for disposal");
  }
  if (inventory.retentionPolicySha256 === null) {
    if (inventory.retentionPolicyControlGeneration !== 0) {
      throw new Error("tenant telemetry inventory inactive retention binding is invalid");
    }
  } else {
    positive(
      inventory.retentionPolicyControlGeneration,
      "tenant telemetry inventory active retention generation",
    );
    digest(inventory.retentionPolicySha256, "tenant telemetry inventory retention policy");
  }
  nonNegative(inventory.tenantHoldControlGeneration, "tenant telemetry tenant hold generation");
  digest(inventory.tenantHoldProjectionSha256, "tenant telemetry tenant hold projection");
  nonNegative(inventory.ownerHoldControlGeneration, "tenant telemetry owner hold generation");
  digest(inventory.ownerHoldProjectionSha256, "tenant telemetry owner hold projection");
  nonNegative(inventory.restoreControlGeneration, "tenant telemetry restore generation");
  timestamp(inventory.restoreUpdatedAtDbMs, "tenant telemetry restore update time");
  if (inventory.runtimeEpochSha256 === null) {
    if (inventory.restoreControlGeneration !== 0
      || inventory.restoreLineageKind !== "inactive"
      || inventory.restoreUpdatedAtDbMs !== 0) {
      throw new Error("tenant telemetry inactive restore binding is invalid");
    }
  } else {
    positive(inventory.restoreControlGeneration, "tenant telemetry active restore generation");
    digest(inventory.runtimeEpochSha256, "tenant telemetry runtime epoch");
    if (inventory.restoreLineageKind !== "primary"
      && inventory.restoreLineageKind !== "restore") {
      throw new Error("tenant telemetry active restore lineage is invalid");
    }
    if (inventory.restoreUpdatedAtDbMs > inventory.createdAtDbMs) {
      throw new Error("tenant telemetry restore high-water exceeds creation time");
    }
  }
  timestamp(inventory.createdAtDbMs, "tenant telemetry inventory creation time");
  if (inventory.sourceHighWaterDbMs > inventory.createdAtDbMs) {
    throw new Error("tenant telemetry inventory source high-water exceeds creation time");
  }
  const expectedIdentity = tenantTelemetryArtifactInventorySha256(inventory);
  if (inventory.inventorySha256 !== expectedIdentity) {
    throw new Error("tenant telemetry artifact inventory identity mismatch");
  }
  return sha256([
    "tenant-telemetry-artifact-inventory-receipt-v1",
    ...ARTIFACT_INVENTORY_BODY_KEYS.map((key) => inventory[key]),
  ]);
}

export function validateTenantTelemetryArtifactInventory(
  inventory: TenantTelemetryArtifactInventoryRecord,
): void {
  exactKeys(
    inventory,
    [...ARTIFACT_INVENTORY_BODY_KEYS, "receiptSha256"],
    "tenant telemetry artifact inventory record",
  );
  digest(inventory.receiptSha256, "tenant telemetry artifact inventory receipt");
  const { receiptSha256, ...body } = inventory;
  if (receiptSha256 !== tenantTelemetryArtifactInventoryReceiptSha256(body)) {
    throw new Error("tenant telemetry artifact inventory receipt mismatch");
  }
}

export interface TenantTelemetryLifecycleStore {
  getTenantTelemetryLifecycleControl(): Promise<TenantTelemetryLifecycleControlRecord>;
  listTenantTelemetryLifecycleTargets(): Promise<TenantTelemetryLifecycleTargetRecord[]>;
  getTenantTelemetryLifecycleCoverage(
    tenantId: string,
  ): Promise<TenantTelemetryLifecycleCoverageRecord | null>;
  getTenantTelemetryLifecycleSubject(
    tenantId: string,
    requestId: string,
  ): Promise<TenantTelemetryLifecycleSubjectRecord | null>;
  activateTenantTelemetryLifecycle(
    input: ActivateTenantTelemetryLifecycleInput,
  ): Promise<TenantTelemetryLifecycleActivationResult>;
  registerTenantTelemetryCoverage(
    input: RegisterTenantTelemetryCoverageInput,
  ): Promise<TenantTelemetryLifecycleCoverageRecord>;
  registerTenantTelemetryArtifact(
    input: RegisterTenantTelemetryArtifactInput,
  ): Promise<TenantTelemetryArtifactInventoryRecord>;
  getTenantTelemetryArtifact(
    tenantId: string,
    domain: TenantTelemetryDomain,
    artifactIdSha256: string,
    artifactGeneration: number,
  ): Promise<TenantTelemetryArtifactInventoryRecord | null>;
}
