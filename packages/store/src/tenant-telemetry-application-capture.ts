import { createHash } from "node:crypto";
import {
  TENANT_TELEMETRY_DOMAINS,
  TENANT_TELEMETRY_HISTORY_STATUSES,
  type TenantTelemetryDomain,
  type TenantTelemetryHistoryStatus,
} from "./tenant-telemetry-lifecycle.js";

export const TENANT_TELEMETRY_APPLICATION_CAPTURE_PROTOCOL =
  "tenant-telemetry-application-capture-v1" as const;
export const TENANT_TELEMETRY_APPLICATION_DOMAIN_CONTROL_SCOPE =
  "tenant-telemetry-application-domain-control-v1" as const;
export const TENANT_TELEMETRY_APPLICATION_ACTIVATION_RECEIPT_SCOPE =
  "tenant-telemetry-application-activation-receipt-v1" as const;
export const TENANT_TELEMETRY_APPLICATION_COVERAGE_SCOPE =
  "tenant-telemetry-application-coverage-v1" as const;
export const TENANT_TELEMETRY_APPLICATION_WRITE_BINDING_SCOPE =
  "tenant-telemetry-application-write-binding-v1" as const;

export const TENANT_TELEMETRY_APPLICATION_FLEET_STOPPED_ACK =
  "fleet-stopped-v1" as const;
export const TENANT_TELEMETRY_APPLICATION_LEGACY_WRITERS_DRAINED_ACK =
  "legacy-writers-drained-v1" as const;
export const TENANT_TELEMETRY_APPLICATION_PRODUCER_READY_ACK =
  "producer-ready-v1" as const;

export const TENANT_TELEMETRY_APPLICATION_CAPTURE_STATUSES = [
  "capture_since_cutover",
  "capture_since_tenant_creation",
] as const;
export type TenantTelemetryApplicationCaptureStatus =
  (typeof TENANT_TELEMETRY_APPLICATION_CAPTURE_STATUSES)[number];

export const TENANT_TELEMETRY_APPLICATION_PRE_CUTOVER_HISTORY_STATUSES = [
  "pre_cutover_history_unknown",
  "pre_cutover_not_applicable",
] as const;
export type TenantTelemetryApplicationPreCutoverHistoryStatus =
  (typeof TENANT_TELEMETRY_APPLICATION_PRE_CUTOVER_HISTORY_STATUSES)[number];

const SHA256 = /^[0-9a-f]{64}$/;
const PRODUCER_PROTOCOL = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

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
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function nonNegative(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function tenantId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new Error("tenant telemetry application tenant id is invalid");
  }
}

function domain(value: unknown): asserts value is TenantTelemetryDomain {
  if (!(TENANT_TELEMETRY_DOMAINS as readonly unknown[]).includes(value)) {
    throw new Error("tenant telemetry application domain is invalid");
  }
}

function producerProtocol(value: unknown): asserts value is string {
  if (typeof value !== "string" || !PRODUCER_PROTOCOL.test(value)) {
    throw new Error("tenant telemetry application producer protocol is invalid");
  }
}

function lifecycleHistoryStatus(value: unknown): asserts value is TenantTelemetryHistoryStatus {
  if (!(TENANT_TELEMETRY_HISTORY_STATUSES as readonly unknown[]).includes(value)) {
    throw new Error("tenant telemetry application lifecycle history status is invalid");
  }
}

export interface InactiveTenantTelemetryApplicationDomainControl {
  domain: TenantTelemetryDomain;
  state: "inactive";
  controlGeneration: 0;
}

export interface ActiveTenantTelemetryApplicationDomainControlBody {
  domain: TenantTelemetryDomain;
  state: "active";
  controlGeneration: 1;
  scope: typeof TENANT_TELEMETRY_APPLICATION_DOMAIN_CONTROL_SCOPE;
  captureProtocol: typeof TENANT_TELEMETRY_APPLICATION_CAPTURE_PROTOCOL;
  producerProtocol: string;
  producerContractSha256: string;
  refKeyIdSha256: string;
  lifecycleControlGeneration: 1;
  lifecycleControlEvidenceSha256: string;
  lifecycleTargetSha256: string;
  lifecycleTargetReceiptSha256: string;
  coverageCount: number;
  coverageRootSha256: string;
  preCutoverWriteCount: number;
  preCutoverWriteRootSha256: string;
  activatedAtDbMs: number;
}

export interface ActiveTenantTelemetryApplicationDomainControl
  extends ActiveTenantTelemetryApplicationDomainControlBody {
  activationEvidenceSha256: string;
}

export type TenantTelemetryApplicationDomainControl =
  | InactiveTenantTelemetryApplicationDomainControl
  | ActiveTenantTelemetryApplicationDomainControl;

const ACTIVE_CONTROL_BODY_KEYS = [
  "domain",
  "state",
  "controlGeneration",
  "scope",
  "captureProtocol",
  "producerProtocol",
  "producerContractSha256",
  "refKeyIdSha256",
  "lifecycleControlGeneration",
  "lifecycleControlEvidenceSha256",
  "lifecycleTargetSha256",
  "lifecycleTargetReceiptSha256",
  "coverageCount",
  "coverageRootSha256",
  "preCutoverWriteCount",
  "preCutoverWriteRootSha256",
  "activatedAtDbMs",
] as const;

export function tenantTelemetryApplicationDomainControlEvidenceSha256(
  control: ActiveTenantTelemetryApplicationDomainControlBody,
): string {
  exactKeys(control, ACTIVE_CONTROL_BODY_KEYS,
    "tenant telemetry application domain control");
  domain(control.domain);
  if (control.state !== "active"
    || control.controlGeneration !== 1
    || control.scope !== TENANT_TELEMETRY_APPLICATION_DOMAIN_CONTROL_SCOPE
    || control.captureProtocol !== TENANT_TELEMETRY_APPLICATION_CAPTURE_PROTOCOL
    || control.lifecycleControlGeneration !== 1) {
    throw new Error("tenant telemetry application domain control protocol is invalid");
  }
  producerProtocol(control.producerProtocol);
  for (const [value, name] of [
    [control.producerContractSha256, "producer contract"],
    [control.refKeyIdSha256, "ref key id"],
    [control.lifecycleControlEvidenceSha256, "lifecycle control evidence"],
    [control.lifecycleTargetSha256, "lifecycle target"],
    [control.lifecycleTargetReceiptSha256, "lifecycle target receipt"],
    [control.coverageRootSha256, "coverage root"],
    [control.preCutoverWriteRootSha256, "pre-cutover write root"],
  ] as const) digest(value, `tenant telemetry application ${name}`);
  nonNegative(control.coverageCount, "tenant telemetry application coverage count");
  nonNegative(control.preCutoverWriteCount,
    "tenant telemetry application pre-cutover write count");
  timestamp(control.activatedAtDbMs, "tenant telemetry application activation time");
  return sha256([
    "tenant-telemetry-application-domain-control-evidence-v1",
    ...ACTIVE_CONTROL_BODY_KEYS.map((key) => control[key]),
  ]);
}

export function validateTenantTelemetryApplicationDomainControl(
  control: TenantTelemetryApplicationDomainControl,
): void {
  if (control.state === "inactive") {
    exactKeys(control, ["domain", "state", "controlGeneration"],
      "inactive tenant telemetry application domain control");
    domain(control.domain);
    if (control.controlGeneration !== 0) {
      throw new Error("inactive tenant telemetry application domain control is invalid");
    }
    return;
  }
  exactKeys(control, [...ACTIVE_CONTROL_BODY_KEYS, "activationEvidenceSha256"],
    "active tenant telemetry application domain control");
  digest(control.activationEvidenceSha256,
    "tenant telemetry application activation evidence");
  const { activationEvidenceSha256, ...body } = control;
  if (activationEvidenceSha256
    !== tenantTelemetryApplicationDomainControlEvidenceSha256(body)) {
    throw new Error("tenant telemetry application activation evidence mismatch");
  }
}

export interface ActivateTenantTelemetryApplicationCaptureInput {
  domain: TenantTelemetryDomain;
  expectedControlGeneration: 0;
  expectedLifecycleControlGeneration: 1;
  lifecycleControlEvidenceSha256: string;
  lifecycleTargetSha256: string;
  lifecycleTargetReceiptSha256: string;
  producerProtocol: string;
  producerContractSha256: string;
  fleetStoppedAck: typeof TENANT_TELEMETRY_APPLICATION_FLEET_STOPPED_ACK;
  legacyWritersDrainedAck:
    typeof TENANT_TELEMETRY_APPLICATION_LEGACY_WRITERS_DRAINED_ACK;
  producerReadyAck: typeof TENANT_TELEMETRY_APPLICATION_PRODUCER_READY_ACK;
}

const ACTIVATION_INPUT_KEYS = [
  "domain",
  "expectedControlGeneration",
  "expectedLifecycleControlGeneration",
  "lifecycleControlEvidenceSha256",
  "lifecycleTargetSha256",
  "lifecycleTargetReceiptSha256",
  "producerProtocol",
  "producerContractSha256",
  "fleetStoppedAck",
  "legacyWritersDrainedAck",
  "producerReadyAck",
] as const;

export function validateActivateTenantTelemetryApplicationCaptureInput(
  input: ActivateTenantTelemetryApplicationCaptureInput,
): void {
  exactKeys(input, ACTIVATION_INPUT_KEYS,
    "tenant telemetry application capture activation input");
  domain(input.domain);
  if (input.expectedControlGeneration !== 0
    || input.expectedLifecycleControlGeneration !== 1
    || input.fleetStoppedAck !== TENANT_TELEMETRY_APPLICATION_FLEET_STOPPED_ACK
    || input.legacyWritersDrainedAck
      !== TENANT_TELEMETRY_APPLICATION_LEGACY_WRITERS_DRAINED_ACK
    || input.producerReadyAck !== TENANT_TELEMETRY_APPLICATION_PRODUCER_READY_ACK) {
    throw new Error("tenant telemetry application capture activation protocol is invalid");
  }
  producerProtocol(input.producerProtocol);
  for (const [value, name] of [
    [input.lifecycleControlEvidenceSha256, "lifecycle control evidence"],
    [input.lifecycleTargetSha256, "lifecycle target"],
    [input.lifecycleTargetReceiptSha256, "lifecycle target receipt"],
    [input.producerContractSha256, "producer contract"],
  ] as const) digest(value, `tenant telemetry application activation ${name}`);
}

export function tenantTelemetryApplicationActivationRequestSha256(
  input: ActivateTenantTelemetryApplicationCaptureInput,
): string {
  validateActivateTenantTelemetryApplicationCaptureInput(input);
  return sha256([
    "tenant-telemetry-application-activation-request-v1",
    ...ACTIVATION_INPUT_KEYS.map((key) => input[key]),
  ]);
}

export interface TenantTelemetryApplicationCoverageBody {
  tenantId: string;
  domain: TenantTelemetryDomain;
  controlGeneration: 1;
  scope: typeof TENANT_TELEMETRY_APPLICATION_COVERAGE_SCOPE;
  captureStatus: TenantTelemetryApplicationCaptureStatus;
  preCutoverHistoryStatus: TenantTelemetryApplicationPreCutoverHistoryStatus;
  lifecycleCoverageEvidenceSha256: string;
  lifecycleHistoryStatus: TenantTelemetryHistoryStatus;
  subjectRefSha256: string;
  targetSha256: string;
  targetReceiptSha256: string;
  producerProtocol: string;
  producerContractSha256: string;
  coverageStartedAtDbMs: number;
}

export interface TenantTelemetryApplicationCoverage
  extends TenantTelemetryApplicationCoverageBody {
  evidenceSha256: string;
}

const COVERAGE_BODY_KEYS = [
  "tenantId",
  "domain",
  "controlGeneration",
  "scope",
  "captureStatus",
  "preCutoverHistoryStatus",
  "lifecycleCoverageEvidenceSha256",
  "lifecycleHistoryStatus",
  "subjectRefSha256",
  "targetSha256",
  "targetReceiptSha256",
  "producerProtocol",
  "producerContractSha256",
  "coverageStartedAtDbMs",
] as const;

export function tenantTelemetryApplicationCoverageEvidenceSha256(
  coverage: TenantTelemetryApplicationCoverageBody,
): string {
  exactKeys(coverage, COVERAGE_BODY_KEYS, "tenant telemetry application coverage");
  tenantId(coverage.tenantId);
  domain(coverage.domain);
  if (coverage.controlGeneration !== 1
    || coverage.scope !== TENANT_TELEMETRY_APPLICATION_COVERAGE_SCOPE
    || !(TENANT_TELEMETRY_APPLICATION_CAPTURE_STATUSES as readonly unknown[])
      .includes(coverage.captureStatus)
    || !(TENANT_TELEMETRY_APPLICATION_PRE_CUTOVER_HISTORY_STATUSES as readonly unknown[])
      .includes(coverage.preCutoverHistoryStatus)) {
    throw new Error("tenant telemetry application coverage protocol is invalid");
  }
  if ((coverage.captureStatus === "capture_since_cutover")
      !== (coverage.preCutoverHistoryStatus === "pre_cutover_history_unknown")) {
    throw new Error("tenant telemetry application coverage history is inconsistent");
  }
  lifecycleHistoryStatus(coverage.lifecycleHistoryStatus);
  if (coverage.captureStatus === "capture_since_tenant_creation"
    && coverage.lifecycleHistoryStatus !== "complete_since_creation") {
    throw new Error(
      "tenant telemetry application creation coverage requires complete lifecycle history",
    );
  }
  producerProtocol(coverage.producerProtocol);
  for (const [value, name] of [
    [coverage.lifecycleCoverageEvidenceSha256, "lifecycle coverage"],
    [coverage.subjectRefSha256, "subject ref"],
    [coverage.targetSha256, "target"],
    [coverage.targetReceiptSha256, "target receipt"],
    [coverage.producerContractSha256, "producer contract"],
  ] as const) digest(value, `tenant telemetry application coverage ${name}`);
  timestamp(coverage.coverageStartedAtDbMs,
    "tenant telemetry application coverage start time");
  return sha256([
    "tenant-telemetry-application-coverage-evidence-v1",
    ...COVERAGE_BODY_KEYS.map((key) => coverage[key]),
  ]);
}

export function validateTenantTelemetryApplicationCoverage(
  coverage: TenantTelemetryApplicationCoverage,
): void {
  exactKeys(coverage, [...COVERAGE_BODY_KEYS, "evidenceSha256"],
    "tenant telemetry application coverage record");
  digest(coverage.evidenceSha256, "tenant telemetry application coverage evidence");
  const { evidenceSha256, ...body } = coverage;
  if (evidenceSha256 !== tenantTelemetryApplicationCoverageEvidenceSha256(body)) {
    throw new Error("tenant telemetry application coverage evidence mismatch");
  }
}

export function tenantTelemetryApplicationCoverageRootSha256(
  domainValue: TenantTelemetryDomain,
  coverages: readonly TenantTelemetryApplicationCoverage[],
): string {
  domain(domainValue);
  if (!Array.isArray(coverages)) {
    throw new Error("tenant telemetry application coverage set is invalid");
  }
  const tenants = new Set<string>();
  const ordered = [...coverages].sort((left, right) =>
    Buffer.compare(Buffer.from(left.tenantId, "utf8"), Buffer.from(right.tenantId, "utf8")));
  for (const coverage of ordered) {
    validateTenantTelemetryApplicationCoverage(coverage);
    if (coverage.domain !== domainValue || tenants.has(coverage.tenantId)) {
      throw new Error("tenant telemetry application coverage set is invalid");
    }
    tenants.add(coverage.tenantId);
  }
  return sha256([
    "tenant-telemetry-application-coverage-root-v1",
    domainValue,
    ...ordered.map((coverage) => coverage.evidenceSha256),
  ]);
}

export function tenantTelemetryApplicationPreCutoverWriteRootSha256(
  domainValue: TenantTelemetryDomain,
  writeOperationSha256s: readonly string[],
): string {
  domain(domainValue);
  if (!Array.isArray(writeOperationSha256s)) {
    throw new Error("tenant telemetry application pre-cutover write set is invalid");
  }
  const unique = new Set(writeOperationSha256s);
  if (unique.size !== writeOperationSha256s.length) {
    throw new Error("tenant telemetry application pre-cutover write set is duplicated");
  }
  for (const operationSha256 of unique) {
    digest(operationSha256, "tenant telemetry application pre-cutover operation");
  }
  return sha256([
    "tenant-telemetry-application-pre-cutover-write-root-v1",
    domainValue,
    ...[...unique].sort(),
  ]);
}

export interface TenantTelemetryApplicationActivationReceiptBody {
  domain: TenantTelemetryDomain;
  controlGeneration: 1;
  scope: typeof TENANT_TELEMETRY_APPLICATION_ACTIVATION_RECEIPT_SCOPE;
  requestSha256: string;
  producerProtocol: string;
  producerContractSha256: string;
  refKeyIdSha256: string;
  lifecycleControlEvidenceSha256: string;
  lifecycleTargetSha256: string;
  lifecycleTargetReceiptSha256: string;
  coverageCount: number;
  coverageRootSha256: string;
  preCutoverWriteCount: number;
  preCutoverWriteRootSha256: string;
  fleetStoppedAck: typeof TENANT_TELEMETRY_APPLICATION_FLEET_STOPPED_ACK;
  legacyWritersDrainedAck:
    typeof TENANT_TELEMETRY_APPLICATION_LEGACY_WRITERS_DRAINED_ACK;
  producerReadyAck: typeof TENANT_TELEMETRY_APPLICATION_PRODUCER_READY_ACK;
  activatedAtDbMs: number;
  controlEvidenceSha256: string;
}

export interface TenantTelemetryApplicationActivationReceipt
  extends TenantTelemetryApplicationActivationReceiptBody {
  receiptSha256: string;
}

const ACTIVATION_RECEIPT_BODY_KEYS = [
  "domain",
  "controlGeneration",
  "scope",
  "requestSha256",
  "producerProtocol",
  "producerContractSha256",
  "refKeyIdSha256",
  "lifecycleControlEvidenceSha256",
  "lifecycleTargetSha256",
  "lifecycleTargetReceiptSha256",
  "coverageCount",
  "coverageRootSha256",
  "preCutoverWriteCount",
  "preCutoverWriteRootSha256",
  "fleetStoppedAck",
  "legacyWritersDrainedAck",
  "producerReadyAck",
  "activatedAtDbMs",
  "controlEvidenceSha256",
] as const;

export function tenantTelemetryApplicationActivationReceiptSha256(
  receipt: TenantTelemetryApplicationActivationReceiptBody,
): string {
  exactKeys(receipt, ACTIVATION_RECEIPT_BODY_KEYS,
    "tenant telemetry application activation receipt");
  domain(receipt.domain);
  if (receipt.controlGeneration !== 1
    || receipt.scope !== TENANT_TELEMETRY_APPLICATION_ACTIVATION_RECEIPT_SCOPE
    || receipt.fleetStoppedAck !== TENANT_TELEMETRY_APPLICATION_FLEET_STOPPED_ACK
    || receipt.legacyWritersDrainedAck
      !== TENANT_TELEMETRY_APPLICATION_LEGACY_WRITERS_DRAINED_ACK
    || receipt.producerReadyAck !== TENANT_TELEMETRY_APPLICATION_PRODUCER_READY_ACK) {
    throw new Error("tenant telemetry application activation receipt protocol is invalid");
  }
  producerProtocol(receipt.producerProtocol);
  for (const [value, name] of [
    [receipt.requestSha256, "request"],
    [receipt.producerContractSha256, "producer contract"],
    [receipt.refKeyIdSha256, "ref key id"],
    [receipt.lifecycleControlEvidenceSha256, "lifecycle control evidence"],
    [receipt.lifecycleTargetSha256, "lifecycle target"],
    [receipt.lifecycleTargetReceiptSha256, "lifecycle target receipt"],
    [receipt.coverageRootSha256, "coverage root"],
    [receipt.preCutoverWriteRootSha256, "pre-cutover write root"],
    [receipt.controlEvidenceSha256, "control evidence"],
  ] as const) digest(value, `tenant telemetry application activation receipt ${name}`);
  nonNegative(receipt.coverageCount, "tenant telemetry application receipt coverage count");
  nonNegative(receipt.preCutoverWriteCount,
    "tenant telemetry application receipt pre-cutover write count");
  timestamp(receipt.activatedAtDbMs,
    "tenant telemetry application activation receipt time");
  return sha256([
    "tenant-telemetry-application-activation-receipt-v1",
    ...ACTIVATION_RECEIPT_BODY_KEYS.map((key) => receipt[key]),
  ]);
}

export function validateTenantTelemetryApplicationActivationReceipt(
  receipt: TenantTelemetryApplicationActivationReceipt,
): void {
  exactKeys(receipt, [...ACTIVATION_RECEIPT_BODY_KEYS, "receiptSha256"],
    "tenant telemetry application activation receipt record");
  digest(receipt.receiptSha256,
    "tenant telemetry application activation receipt digest");
  const { receiptSha256, ...body } = receipt;
  if (receiptSha256 !== tenantTelemetryApplicationActivationReceiptSha256(body)) {
    throw new Error("tenant telemetry application activation receipt mismatch");
  }
}

export interface TenantTelemetryApplicationWriteBindingBody {
  scope: typeof TENANT_TELEMETRY_APPLICATION_WRITE_BINDING_SCOPE;
  protocol: typeof TENANT_TELEMETRY_APPLICATION_CAPTURE_PROTOCOL;
  writeOperationSha256: string;
  tenantId: string;
  domain: TenantTelemetryDomain;
  controlGeneration: 1;
  controlEvidenceSha256: string;
  coverageEvidenceSha256: string;
  lifecycleCoverageEvidenceSha256: string;
  targetSha256: string;
  targetReceiptSha256: string;
  producerProtocol: string;
  producerContractSha256: string;
  inventorySha256: string;
  manifestSha256: string;
  payloadSha256: string;
  boundAtDbMs: number;
}

export interface TenantTelemetryApplicationWriteBinding
  extends TenantTelemetryApplicationWriteBindingBody {
  receiptSha256: string;
}

const WRITE_BINDING_BODY_KEYS = [
  "scope",
  "protocol",
  "writeOperationSha256",
  "tenantId",
  "domain",
  "controlGeneration",
  "controlEvidenceSha256",
  "coverageEvidenceSha256",
  "lifecycleCoverageEvidenceSha256",
  "targetSha256",
  "targetReceiptSha256",
  "producerProtocol",
  "producerContractSha256",
  "inventorySha256",
  "manifestSha256",
  "payloadSha256",
  "boundAtDbMs",
] as const;

export function tenantTelemetryApplicationWriteBindingReceiptSha256(
  binding: TenantTelemetryApplicationWriteBindingBody,
): string {
  exactKeys(binding, WRITE_BINDING_BODY_KEYS,
    "tenant telemetry application write binding");
  if (binding.scope !== TENANT_TELEMETRY_APPLICATION_WRITE_BINDING_SCOPE
    || binding.protocol !== TENANT_TELEMETRY_APPLICATION_CAPTURE_PROTOCOL
    || binding.controlGeneration !== 1) {
    throw new Error("tenant telemetry application write binding protocol is invalid");
  }
  tenantId(binding.tenantId);
  domain(binding.domain);
  producerProtocol(binding.producerProtocol);
  for (const [value, name] of [
    [binding.writeOperationSha256, "operation"],
    [binding.controlEvidenceSha256, "control evidence"],
    [binding.coverageEvidenceSha256, "coverage evidence"],
    [binding.lifecycleCoverageEvidenceSha256, "lifecycle coverage evidence"],
    [binding.targetSha256, "target"],
    [binding.targetReceiptSha256, "target receipt"],
    [binding.producerContractSha256, "producer contract"],
    [binding.inventorySha256, "inventory"],
    [binding.manifestSha256, "manifest"],
    [binding.payloadSha256, "payload"],
  ] as const) digest(value, `tenant telemetry application write binding ${name}`);
  timestamp(binding.boundAtDbMs, "tenant telemetry application write binding time");
  return sha256([
    "tenant-telemetry-application-write-binding-receipt-v1",
    ...WRITE_BINDING_BODY_KEYS.map((key) => binding[key]),
  ]);
}

export function validateTenantTelemetryApplicationWriteBinding(
  binding: TenantTelemetryApplicationWriteBinding,
): void {
  exactKeys(binding, [...WRITE_BINDING_BODY_KEYS, "receiptSha256"],
    "tenant telemetry application write binding record");
  digest(binding.receiptSha256, "tenant telemetry application write binding receipt");
  const { receiptSha256, ...body } = binding;
  if (receiptSha256 !== tenantTelemetryApplicationWriteBindingReceiptSha256(body)) {
    throw new Error("tenant telemetry application write binding receipt mismatch");
  }
}

export interface TenantTelemetryApplicationActivationResult {
  control: ActiveTenantTelemetryApplicationDomainControl;
  receipt: TenantTelemetryApplicationActivationReceipt;
}

export class TenantTelemetryApplicationCaptureConflictError extends Error {
  constructor(
    message = "tenant telemetry application capture state conflicts with the requested operation",
  ) {
    super(message);
    this.name = "TenantTelemetryApplicationCaptureConflictError";
  }
}

export class TenantTelemetryApplicationCaptureIntegrityError extends Error {
  constructor(message = "tenant telemetry application capture evidence is invalid") {
    super(message);
    this.name = "TenantTelemetryApplicationCaptureIntegrityError";
  }
}

export interface TenantTelemetryApplicationCaptureStore {
  listTenantTelemetryApplicationDomainControls(
  ): Promise<TenantTelemetryApplicationDomainControl[]>;
  getTenantTelemetryApplicationDomainControl(
    domain: TenantTelemetryDomain,
  ): Promise<TenantTelemetryApplicationDomainControl>;
  getTenantTelemetryApplicationActivationReceipt(
    domain: TenantTelemetryDomain,
  ): Promise<TenantTelemetryApplicationActivationReceipt | null>;
  getTenantTelemetryApplicationCoverage(
    tenantId: string,
    domain: TenantTelemetryDomain,
  ): Promise<TenantTelemetryApplicationCoverage | null>;
  getTenantTelemetryApplicationWriteBinding(
    tenantId: string,
    writeOperationSha256: string,
  ): Promise<TenantTelemetryApplicationWriteBinding | null>;
  activateTenantTelemetryApplicationCapture(
    input: ActivateTenantTelemetryApplicationCaptureInput,
  ): Promise<TenantTelemetryApplicationActivationResult>;
}
