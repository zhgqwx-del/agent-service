import { createHash } from "node:crypto";
import {
  TENANT_TELEMETRY_DOMAINS,
  type TenantTelemetryDomain,
} from "./tenant-telemetry-lifecycle.js";

export const TENANT_TELEMETRY_DISPOSITION_PROTOCOL =
  "tenant-telemetry-disposition-v1" as const;
export const TENANT_TELEMETRY_DISPOSITION_JOB_SCOPE =
  "tenant-telemetry-disposition-job-v1" as const;
export const TENANT_TELEMETRY_DISPOSITION_AUTHORIZATION_GRANT_SCOPE =
  "tenant-telemetry-disposition-authorization-grant-v1" as const;
export const TENANT_TELEMETRY_EXTERNAL_AUTHORIZATION_SCOPE =
  "tenant-telemetry-external-delete-authorization-v1" as const;
export const TENANT_TELEMETRY_SAME_KEY_TOMBSTONE_ACK_SCOPE =
  "tenant-telemetry-same-key-tombstone-ack-v1" as const;
export const TENANT_TELEMETRY_DISPOSITION_RECEIPT_SCOPE =
  "tenant-telemetry-disposition-receipt-v1" as const;
export const TENANT_TELEMETRY_DISPOSITION_REPLAY_FENCE_SCOPE =
  "tenant-telemetry-disposition-replay-fence-v1" as const;
export const TENANT_TELEMETRY_DISPOSITION_EXTERNAL_EVENT_SCOPE =
  "tenant-telemetry-disposition-external-event-v1" as const;
export const TENANT_TELEMETRY_DISPOSITION_EXTERNAL_HEAD_SCOPE =
  "tenant-telemetry-disposition-external-head-v1" as const;
export const TENANT_TELEMETRY_DISPOSITION_CONTROL_SINGLETON_ID =
  "tenant-telemetry-disposition-control" as const;
export const TENANT_TELEMETRY_DISPOSITION_CONTROL_SCOPE =
  "tenant-telemetry-disposition-control-v1" as const;
export const TENANT_TELEMETRY_DISPOSITION_ACTIVATION_RECEIPT_SCOPE =
  "tenant-telemetry-disposition-activation-receipt-v1" as const;
export const TENANT_TELEMETRY_DISPOSITION_FLEET_STOPPED_ACK =
  "telemetry-disposition-fleet-stopped-ack-v1" as const;
export const TENANT_TELEMETRY_DISPOSITION_LEGACY_WRITERS_DRAINED_ACK =
  "telemetry-disposition-legacy-writers-drained-ack-v1" as const;

const SHA256 = /^[0-9a-f]{64}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/;
const CLAIM_TOKEN = /^[A-Za-z0-9._:~-]{1,128}$/;
const ADAPTER_PROTOCOL = /^[A-Za-z0-9][A-Za-z0-9._:~/-]{0,127}$/;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("tenant telemetry disposition hash input contains an unsupported value");
  }
  return encoded;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function exactKeys(value: object, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${name} has unknown or missing fields`);
  }
}

function digest(value: string, name: string): void {
  if (!SHA256.test(value)) throw new Error(`${name} must be a lowercase SHA-256 digest`);
}

function positive(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be positive`);
}

function nonNegative(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be non-negative`);
}

function domain(value: TenantTelemetryDomain): void {
  if (!(TENANT_TELEMETRY_DOMAINS as readonly unknown[]).includes(value)) {
    throw new Error("tenant telemetry disposition domain is invalid");
  }
}

function nullableDigest(value: string | null, name: string): void {
  if (value !== null) digest(value, name);
}

function validTenantId(value: unknown): value is string {
  // Match the existing SessionStore/0033/0034 contract. JS length is intentionally used
  // here because the core tenant identity boundary also counts UTF-16 code units.
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

export interface TenantTelemetryDispositionIdentity {
  domain: TenantTelemetryDomain;
  targetSha256: string;
  artifactIdSha256: string;
  artifactGeneration: number;
}

export interface TenantTelemetryDispositionEvidence extends TenantTelemetryDispositionIdentity {
  inventorySha256: string;
  inventoryReceiptSha256: string;
  writeOperationSha256: string;
  writeAckReceiptSha256: string;
  payloadSha256: string;
  manifestSha256: string;
  lifecycleCoverageEvidenceSha256: string;
  applicationCoverageEvidenceSha256: string | null;
  applicationWriteBindingReceiptSha256: string | null;
  t3cReceiptSha256: string;
  t3dPlanReceiptSha256: string;
  t3dPlanEntryReceiptSha256: string;
  dispositionOperationSha256: string;
}

/**
 * The content-free per-artifact tuple that a future T3d logs/traces plan must enumerate.
 * A 0036 job is not executable until the sealed T3d target count/root matches this
 * exact inventory+writer-ACK set. The current T3d zero-target blocker never matches it.
 */
export interface TenantTelemetryDispositionPlanTarget
  extends TenantTelemetryDispositionIdentity {
  inventoryReceiptSha256: string;
  writeAckReceiptSha256: string;
}

const DISPOSITION_PLAN_TARGET_KEYS = [
  "domain",
  "targetSha256",
  "artifactIdSha256",
  "artifactGeneration",
  "inventoryReceiptSha256",
  "writeAckReceiptSha256",
] as const;

export function tenantTelemetryDispositionPlanTargetSha256(
  target: TenantTelemetryDispositionPlanTarget,
): string {
  exactKeys(target, DISPOSITION_PLAN_TARGET_KEYS,
    "tenant telemetry disposition plan target");
  domain(target.domain);
  positive(target.artifactGeneration,
    "tenant telemetry disposition plan target artifact generation");
  for (const [value, name] of [
    [target.targetSha256, "target"],
    [target.artifactIdSha256, "artifact id"],
    [target.inventoryReceiptSha256, "inventory receipt"],
    [target.writeAckReceiptSha256, "write ACK receipt"],
  ] as const) digest(value, `tenant telemetry disposition plan ${name}`);
  return sha256([
    "tenant-purge-plan-target-v1",
    target.domain,
    [
      target.targetSha256,
      target.artifactIdSha256,
      target.artifactGeneration,
      target.inventoryReceiptSha256,
      target.writeAckReceiptSha256,
    ],
  ]);
}

/** Uses the same canonical root grammar as T3d, independent of artifact order. */
export function tenantTelemetryDispositionInventoryTargetRootSha256(
  domainValue: TenantTelemetryDomain,
  targets: readonly TenantTelemetryDispositionPlanTarget[],
): string {
  domain(domainValue);
  const identities = new Set<string>();
  const targetHashes = targets.map((target) => {
    if (target.domain !== domainValue) {
      throw new Error("tenant telemetry disposition plan target domain does not match");
    }
    const key = `${target.targetSha256}:${target.artifactIdSha256}:${target.artifactGeneration}`;
    if (identities.has(key)) {
      throw new Error("tenant telemetry disposition plan artifact is duplicated");
    }
    identities.add(key);
    return tenantTelemetryDispositionPlanTargetSha256(target);
  }).sort();
  return sha256(["tenant-purge-plan-target-root-v1", domainValue, ...targetHashes]);
}

const DISPOSITION_EVIDENCE_KEYS = [
  "domain",
  "targetSha256",
  "artifactIdSha256",
  "artifactGeneration",
  "inventorySha256",
  "inventoryReceiptSha256",
  "writeOperationSha256",
  "writeAckReceiptSha256",
  "payloadSha256",
  "manifestSha256",
  "lifecycleCoverageEvidenceSha256",
  "applicationCoverageEvidenceSha256",
  "applicationWriteBindingReceiptSha256",
  "t3cReceiptSha256",
  "t3dPlanReceiptSha256",
  "t3dPlanEntryReceiptSha256",
  "dispositionOperationSha256",
] as const;

type DispositionOperationInput = Omit<
  TenantTelemetryDispositionEvidence,
  "dispositionOperationSha256"
>;

export function tenantTelemetryDispositionOperationSha256(
  input: DispositionOperationInput,
): string {
  exactKeys(input, DISPOSITION_EVIDENCE_KEYS.filter(
    (key) => key !== "dispositionOperationSha256",
  ), "tenant telemetry disposition operation");
  domain(input.domain);
  for (const [value, name] of [
    [input.targetSha256, "target"],
    [input.artifactIdSha256, "artifact id"],
    [input.inventorySha256, "inventory"],
    [input.inventoryReceiptSha256, "inventory receipt"],
    [input.writeOperationSha256, "write operation"],
    [input.writeAckReceiptSha256, "write ACK receipt"],
    [input.payloadSha256, "payload"],
    [input.manifestSha256, "manifest"],
    [input.lifecycleCoverageEvidenceSha256, "lifecycle coverage"],
    [input.t3cReceiptSha256, "T3c receipt"],
    [input.t3dPlanReceiptSha256, "T3d plan receipt"],
    [input.t3dPlanEntryReceiptSha256, "T3d plan entry receipt"],
  ] as const) digest(value, `tenant telemetry disposition ${name}`);
  nullableDigest(input.applicationCoverageEvidenceSha256,
    "tenant telemetry disposition application coverage");
  nullableDigest(input.applicationWriteBindingReceiptSha256,
    "tenant telemetry disposition application write binding receipt");
  if ((input.applicationCoverageEvidenceSha256 === null)
    !== (input.applicationWriteBindingReceiptSha256 === null)) {
    throw new Error("tenant telemetry disposition application evidence is incomplete");
  }
  positive(input.artifactGeneration, "tenant telemetry disposition artifact generation");
  return sha256([
    "tenant-telemetry-disposition-operation-v1",
    ...DISPOSITION_EVIDENCE_KEYS
      .filter((key) => key !== "dispositionOperationSha256")
      .map((key) => input[key]),
  ]);
}

export function validateTenantTelemetryDispositionEvidence(
  evidence: TenantTelemetryDispositionEvidence,
): void {
  exactKeys(evidence, DISPOSITION_EVIDENCE_KEYS, "tenant telemetry disposition evidence");
  digest(evidence.dispositionOperationSha256,
    "tenant telemetry disposition operation digest");
  const { dispositionOperationSha256, ...source } = evidence;
  if (dispositionOperationSha256 !== tenantTelemetryDispositionOperationSha256(source)) {
    throw new Error("tenant telemetry disposition operation digest does not match");
  }
}

export interface TenantTelemetryDispositionJournalIdentity {
  adapterProtocol: string;
  journalNamespaceSha256: string;
  journalTargetSha256: string;
  failureDomainSha256: string;
  logicalDatabaseNamespaceSha256: string;
}

const JOURNAL_IDENTITY_KEYS = [
  "adapterProtocol",
  "journalNamespaceSha256",
  "journalTargetSha256",
  "failureDomainSha256",
  "logicalDatabaseNamespaceSha256",
] as const;

export function validateTenantTelemetryDispositionJournalIdentity(
  identity: TenantTelemetryDispositionJournalIdentity,
): void {
  exactKeys(identity, JOURNAL_IDENTITY_KEYS,
    "tenant telemetry disposition journal identity");
  if (!ADAPTER_PROTOCOL.test(identity.adapterProtocol)) {
    throw new Error("tenant telemetry disposition journal adapter protocol is invalid");
  }
  for (const [value, name] of [
    [identity.journalNamespaceSha256, "journal namespace"],
    [identity.journalTargetSha256, "journal target"],
    [identity.failureDomainSha256, "failure domain"],
    [identity.logicalDatabaseNamespaceSha256, "logical database namespace"],
  ] as const) digest(value, `tenant telemetry disposition ${name}`);
}

export interface InactiveTenantTelemetryDispositionControl {
  singletonId: typeof TENANT_TELEMETRY_DISPOSITION_CONTROL_SINGLETON_ID;
  state: "inactive";
  controlGeneration: 0;
}

export interface ActiveTenantTelemetryDispositionControlBody
  extends TenantTelemetryDispositionJournalIdentity {
  singletonId: typeof TENANT_TELEMETRY_DISPOSITION_CONTROL_SINGLETON_ID;
  state: "active";
  controlGeneration: 1;
  scope: typeof TENANT_TELEMETRY_DISPOSITION_CONTROL_SCOPE;
  protocol: typeof TENANT_TELEMETRY_DISPOSITION_PROTOCOL;
  lifecycleControlGeneration: 1;
  lifecycleTargetRootSha256: string;
  activatedAtDbMs: number;
}

export interface ActiveTenantTelemetryDispositionControl
  extends ActiveTenantTelemetryDispositionControlBody {
  activationEvidenceSha256: string;
}

export type TenantTelemetryDispositionControl =
  | InactiveTenantTelemetryDispositionControl
  | ActiveTenantTelemetryDispositionControl;

const ACTIVE_DISPOSITION_CONTROL_BODY_KEYS = [
  "singletonId",
  "state",
  "controlGeneration",
  "scope",
  "protocol",
  "lifecycleControlGeneration",
  "lifecycleTargetRootSha256",
  ...JOURNAL_IDENTITY_KEYS,
  "activatedAtDbMs",
] as const;

export function tenantTelemetryDispositionActivationEvidenceSha256(
  control: ActiveTenantTelemetryDispositionControlBody,
): string {
  exactKeys(control, ACTIVE_DISPOSITION_CONTROL_BODY_KEYS,
    "tenant telemetry disposition active control");
  if (control.singletonId !== TENANT_TELEMETRY_DISPOSITION_CONTROL_SINGLETON_ID
    || control.state !== "active"
    || control.controlGeneration !== 1
    || control.scope !== TENANT_TELEMETRY_DISPOSITION_CONTROL_SCOPE
    || control.protocol !== TENANT_TELEMETRY_DISPOSITION_PROTOCOL
    || control.lifecycleControlGeneration !== 1) {
    throw new Error("tenant telemetry disposition active control protocol is invalid");
  }
  digest(control.lifecycleTargetRootSha256,
    "tenant telemetry disposition lifecycle target root");
  const identity = Object.fromEntries(JOURNAL_IDENTITY_KEYS.map(
    (key) => [key, control[key]],
  )) as unknown as TenantTelemetryDispositionJournalIdentity;
  validateTenantTelemetryDispositionJournalIdentity(identity);
  nonNegative(control.activatedAtDbMs,
    "tenant telemetry disposition activation timestamp");
  return sha256([
    "tenant-telemetry-disposition-activation-evidence-v1",
    ...ACTIVE_DISPOSITION_CONTROL_BODY_KEYS.map((key) => control[key]),
  ]);
}

export function validateTenantTelemetryDispositionControl(
  control: TenantTelemetryDispositionControl,
): void {
  if (control.state === "inactive") {
    exactKeys(control, ["singletonId", "state", "controlGeneration"],
      "inactive tenant telemetry disposition control");
    if (control.singletonId !== TENANT_TELEMETRY_DISPOSITION_CONTROL_SINGLETON_ID
      || control.controlGeneration !== 0) {
      throw new Error("inactive tenant telemetry disposition control is invalid");
    }
    return;
  }
  exactKeys(control, [
    ...ACTIVE_DISPOSITION_CONTROL_BODY_KEYS, "activationEvidenceSha256",
  ], "active tenant telemetry disposition control");
  const { activationEvidenceSha256, ...body } = control;
  digest(activationEvidenceSha256,
    "tenant telemetry disposition activation evidence");
  if (activationEvidenceSha256 !== tenantTelemetryDispositionActivationEvidenceSha256(body)) {
    throw new Error("tenant telemetry disposition activation evidence does not match");
  }
}

export interface ActivateTenantTelemetryDispositionInput
  extends TenantTelemetryDispositionJournalIdentity {
  expectedControlGeneration: 0;
  expectedLifecycleControlGeneration: 1;
  lifecycleTargetRootSha256: string;
  fleetStoppedAck: typeof TENANT_TELEMETRY_DISPOSITION_FLEET_STOPPED_ACK;
  legacyWritersDrainedAck:
    typeof TENANT_TELEMETRY_DISPOSITION_LEGACY_WRITERS_DRAINED_ACK;
}

const ACTIVATE_DISPOSITION_INPUT_KEYS = [
  "expectedControlGeneration",
  "expectedLifecycleControlGeneration",
  "lifecycleTargetRootSha256",
  ...JOURNAL_IDENTITY_KEYS,
  "fleetStoppedAck",
  "legacyWritersDrainedAck",
] as const;

export function validateActivateTenantTelemetryDispositionInput(
  input: ActivateTenantTelemetryDispositionInput,
): void {
  exactKeys(input, ACTIVATE_DISPOSITION_INPUT_KEYS,
    "activate tenant telemetry disposition input");
  if (input.expectedControlGeneration !== 0
    || input.expectedLifecycleControlGeneration !== 1
    || input.fleetStoppedAck !== TENANT_TELEMETRY_DISPOSITION_FLEET_STOPPED_ACK
    || input.legacyWritersDrainedAck
      !== TENANT_TELEMETRY_DISPOSITION_LEGACY_WRITERS_DRAINED_ACK) {
    throw new Error("activate tenant telemetry disposition protocol is invalid");
  }
  digest(input.lifecycleTargetRootSha256,
    "activate tenant telemetry disposition lifecycle target root");
  const identity = Object.fromEntries(JOURNAL_IDENTITY_KEYS.map(
    (key) => [key, input[key]],
  )) as unknown as TenantTelemetryDispositionJournalIdentity;
  validateTenantTelemetryDispositionJournalIdentity(identity);
}

export interface TenantTelemetryDispositionActivationReceiptBody {
  scope: typeof TENANT_TELEMETRY_DISPOSITION_ACTIVATION_RECEIPT_SCOPE;
  protocol: typeof TENANT_TELEMETRY_DISPOSITION_PROTOCOL;
  controlGeneration: 1;
  activationEvidenceSha256: string;
  lifecycleTargetRootSha256: string;
  journalNamespaceSha256: string;
  journalTargetSha256: string;
  failureDomainSha256: string;
  logicalDatabaseNamespaceSha256: string;
  activatedAtDbMs: number;
}

export interface TenantTelemetryDispositionActivationReceipt
  extends TenantTelemetryDispositionActivationReceiptBody {
  receiptSha256: string;
}

const ACTIVATION_RECEIPT_BODY_KEYS = [
  "scope",
  "protocol",
  "controlGeneration",
  "activationEvidenceSha256",
  "lifecycleTargetRootSha256",
  "journalNamespaceSha256",
  "journalTargetSha256",
  "failureDomainSha256",
  "logicalDatabaseNamespaceSha256",
  "activatedAtDbMs",
] as const;

export function tenantTelemetryDispositionActivationReceiptSha256(
  receipt: TenantTelemetryDispositionActivationReceiptBody,
): string {
  exactKeys(receipt, ACTIVATION_RECEIPT_BODY_KEYS,
    "tenant telemetry disposition activation receipt");
  if (receipt.scope !== TENANT_TELEMETRY_DISPOSITION_ACTIVATION_RECEIPT_SCOPE
    || receipt.protocol !== TENANT_TELEMETRY_DISPOSITION_PROTOCOL
    || receipt.controlGeneration !== 1) {
    throw new Error("tenant telemetry disposition activation receipt protocol is invalid");
  }
  for (const [value, name] of [
    [receipt.activationEvidenceSha256, "activation evidence"],
    [receipt.lifecycleTargetRootSha256, "lifecycle target root"],
    [receipt.journalNamespaceSha256, "journal namespace"],
    [receipt.journalTargetSha256, "journal target"],
    [receipt.failureDomainSha256, "failure domain"],
    [receipt.logicalDatabaseNamespaceSha256, "logical database namespace"],
  ] as const) digest(value, `tenant telemetry disposition activation receipt ${name}`);
  nonNegative(receipt.activatedAtDbMs,
    "tenant telemetry disposition activation receipt timestamp");
  return sha256([
    "tenant-telemetry-disposition-activation-receipt-v1",
    ...ACTIVATION_RECEIPT_BODY_KEYS.map((key) => receipt[key]),
  ]);
}

export function validateTenantTelemetryDispositionActivationReceipt(
  receipt: TenantTelemetryDispositionActivationReceipt,
): void {
  exactKeys(receipt, [...ACTIVATION_RECEIPT_BODY_KEYS, "receiptSha256"],
    "tenant telemetry disposition activation receipt record");
  const { receiptSha256, ...body } = receipt;
  digest(receiptSha256, "tenant telemetry disposition activation receipt digest");
  if (receiptSha256 !== tenantTelemetryDispositionActivationReceiptSha256(body)) {
    throw new Error("tenant telemetry disposition activation receipt digest does not match");
  }
}

export interface TenantTelemetryDispositionActivationResult {
  control: ActiveTenantTelemetryDispositionControl;
  receipt: TenantTelemetryDispositionActivationReceipt;
}

export interface TenantTelemetryDispositionEventProof {
  journalSequence: number;
  previousJournalEventRootSha256: string;
  journalEventSha256: string;
  journalEventRootSha256: string;
}

const EVENT_PROOF_KEYS = [
  "journalSequence",
  "previousJournalEventRootSha256",
  "journalEventSha256",
  "journalEventRootSha256",
] as const;

export const EMPTY_TENANT_TELEMETRY_DISPOSITION_EVENT_ROOT_SHA256 = sha256([
  "tenant-telemetry-disposition-external-event-root-v1",
  "empty",
]);

export function tenantTelemetryDispositionExternalEventSha256(input: {
  eventType: TenantTelemetryDispositionExternalEventType;
  dispositionOperationSha256: string;
  eventReceiptSha256: string;
}): string {
  exactKeys(input, ["eventType", "dispositionOperationSha256", "eventReceiptSha256"],
    "tenant telemetry disposition external event digest input");
  if (input.eventType !== "delete_authorized" && input.eventType !== "delete_tombstoned") {
    throw new Error("tenant telemetry disposition external event type is invalid");
  }
  digest(input.dispositionOperationSha256,
    "tenant telemetry disposition external event operation");
  digest(input.eventReceiptSha256,
    "tenant telemetry disposition external event receipt");
  return sha256([
    "tenant-telemetry-disposition-external-event-v1",
    input.eventType,
    input.dispositionOperationSha256,
    input.eventReceiptSha256,
  ]);
}

export function tenantTelemetryDispositionNextEventRootSha256(input: {
  previousJournalEventRootSha256: string;
  journalSequence: number;
  journalEventSha256: string;
}): string {
  exactKeys(input, [
    "previousJournalEventRootSha256", "journalSequence", "journalEventSha256",
  ], "tenant telemetry disposition event root input");
  digest(input.previousJournalEventRootSha256,
    "tenant telemetry disposition previous event root");
  positive(input.journalSequence, "tenant telemetry disposition journal sequence");
  digest(input.journalEventSha256, "tenant telemetry disposition event digest");
  return sha256([
    "tenant-telemetry-disposition-external-event-root-v1",
    input.previousJournalEventRootSha256,
    input.journalSequence,
    input.journalEventSha256,
  ]);
}

export function validateTenantTelemetryDispositionEventProof(
  proof: TenantTelemetryDispositionEventProof,
  expectedEventSha256?: string,
): void {
  exactKeys(proof, EVENT_PROOF_KEYS, "tenant telemetry disposition event proof");
  positive(proof.journalSequence, "tenant telemetry disposition journal sequence");
  for (const [value, name] of [
    [proof.previousJournalEventRootSha256, "previous event root"],
    [proof.journalEventSha256, "event"],
    [proof.journalEventRootSha256, "event root"],
  ] as const) digest(value, `tenant telemetry disposition ${name}`);
  if ((expectedEventSha256 !== undefined && proof.journalEventSha256 !== expectedEventSha256)
    || proof.journalEventRootSha256 !== tenantTelemetryDispositionNextEventRootSha256({
      previousJournalEventRootSha256: proof.previousJournalEventRootSha256,
      journalSequence: proof.journalSequence,
      journalEventSha256: proof.journalEventSha256,
    })) {
    throw new Error("tenant telemetry disposition event proof does not match");
  }
}

export interface TenantTelemetryExternalAuthorizationBody
  extends TenantTelemetryDispositionEvidence, TenantTelemetryDispositionJournalIdentity {
  scope: typeof TENANT_TELEMETRY_EXTERNAL_AUTHORIZATION_SCOPE;
  protocol: typeof TENANT_TELEMETRY_DISPOSITION_PROTOCOL;
}

export interface TenantTelemetryExternalAuthorizationProof
  extends TenantTelemetryExternalAuthorizationBody, TenantTelemetryDispositionEventProof {
  authorizationReceiptSha256: string;
}

const AUTHORIZATION_BODY_KEYS = [
  "scope",
  "protocol",
  ...DISPOSITION_EVIDENCE_KEYS,
  ...JOURNAL_IDENTITY_KEYS,
] as const;

export function tenantTelemetryExternalAuthorizationReceiptSha256(
  authorization: TenantTelemetryExternalAuthorizationBody,
): string {
  exactKeys(authorization, AUTHORIZATION_BODY_KEYS,
    "tenant telemetry external delete authorization");
  if (authorization.scope !== TENANT_TELEMETRY_EXTERNAL_AUTHORIZATION_SCOPE
    || authorization.protocol !== TENANT_TELEMETRY_DISPOSITION_PROTOCOL) {
    throw new Error("tenant telemetry external delete authorization protocol is invalid");
  }
  const evidence = Object.fromEntries(DISPOSITION_EVIDENCE_KEYS.map(
    (key) => [key, authorization[key]],
  )) as unknown as TenantTelemetryDispositionEvidence;
  const identity = Object.fromEntries(JOURNAL_IDENTITY_KEYS.map(
    (key) => [key, authorization[key]],
  )) as unknown as TenantTelemetryDispositionJournalIdentity;
  validateTenantTelemetryDispositionEvidence(evidence);
  validateTenantTelemetryDispositionJournalIdentity(identity);
  return sha256([
    "tenant-telemetry-external-delete-authorization-receipt-v1",
    ...AUTHORIZATION_BODY_KEYS.map((key) => authorization[key]),
  ]);
}

export function validateTenantTelemetryExternalAuthorizationProof(
  proof: TenantTelemetryExternalAuthorizationProof,
): void {
  exactKeys(proof, [
    ...AUTHORIZATION_BODY_KEYS,
    "authorizationReceiptSha256",
    ...EVENT_PROOF_KEYS,
  ], "tenant telemetry external delete authorization proof");
  const body = Object.fromEntries(AUTHORIZATION_BODY_KEYS.map(
    (key) => [key, proof[key]],
  )) as unknown as TenantTelemetryExternalAuthorizationBody;
  digest(proof.authorizationReceiptSha256,
    "tenant telemetry external authorization receipt");
  if (proof.authorizationReceiptSha256
    !== tenantTelemetryExternalAuthorizationReceiptSha256(body)) {
    throw new Error("tenant telemetry external authorization receipt does not match");
  }
  validateTenantTelemetryDispositionEventProof({
    journalSequence: proof.journalSequence,
    previousJournalEventRootSha256: proof.previousJournalEventRootSha256,
    journalEventSha256: proof.journalEventSha256,
    journalEventRootSha256: proof.journalEventRootSha256,
  }, tenantTelemetryDispositionExternalEventSha256({
      eventType: "delete_authorized",
      dispositionOperationSha256: proof.dispositionOperationSha256,
      eventReceiptSha256: proof.authorizationReceiptSha256,
    }));
}

export const TENANT_TELEMETRY_TOMBSTONE_OUTCOMES = [
  "tombstoned",
  "already_tombstoned",
] as const;
export type TenantTelemetryTombstoneOutcome =
  (typeof TENANT_TELEMETRY_TOMBSTONE_OUTCOMES)[number];

export interface TenantTelemetrySameKeyTombstoneAckBody
  extends TenantTelemetryDispositionEvidence {
  scope: typeof TENANT_TELEMETRY_SAME_KEY_TOMBSTONE_ACK_SCOPE;
  protocol: typeof TENANT_TELEMETRY_DISPOSITION_PROTOCOL;
  authorizationReceiptSha256: string;
  outcome: TenantTelemetryTombstoneOutcome;
  tombstoneSha256: string;
  /** SHA-256 of the artifact object's ETag observed before same-key CAS. */
  objectEtagSha256: string;
  adapterEvidenceSha256: string;
}

export interface TenantTelemetrySameKeyTombstoneAck
  extends TenantTelemetrySameKeyTombstoneAckBody {
  receiptSha256: string;
}

const TOMBSTONE_ACK_BODY_KEYS = [
  "scope",
  "protocol",
  ...DISPOSITION_EVIDENCE_KEYS,
  "authorizationReceiptSha256",
  "outcome",
  "tombstoneSha256",
  "objectEtagSha256",
  "adapterEvidenceSha256",
] as const;

export function tenantTelemetrySameKeyTombstoneAckSha256(
  ack: TenantTelemetrySameKeyTombstoneAckBody,
): string {
  exactKeys(ack, TOMBSTONE_ACK_BODY_KEYS, "tenant telemetry same-key tombstone ACK");
  if (ack.scope !== TENANT_TELEMETRY_SAME_KEY_TOMBSTONE_ACK_SCOPE
    || ack.protocol !== TENANT_TELEMETRY_DISPOSITION_PROTOCOL) {
    throw new Error("tenant telemetry same-key tombstone ACK protocol is invalid");
  }
  const evidence = Object.fromEntries(DISPOSITION_EVIDENCE_KEYS.map(
    (key) => [key, ack[key]],
  )) as unknown as TenantTelemetryDispositionEvidence;
  validateTenantTelemetryDispositionEvidence(evidence);
  digest(ack.authorizationReceiptSha256,
    "tenant telemetry same-key tombstone authorization receipt");
  if (!(TENANT_TELEMETRY_TOMBSTONE_OUTCOMES as readonly unknown[]).includes(ack.outcome)) {
    throw new Error("tenant telemetry same-key tombstone outcome is invalid");
  }
  for (const [value, name] of [
    [ack.tombstoneSha256, "tombstone"],
    [ack.objectEtagSha256, "object ETag"],
    [ack.adapterEvidenceSha256, "adapter evidence"],
  ] as const) digest(value, `tenant telemetry same-key tombstone ${name}`);
  return sha256([
    "tenant-telemetry-same-key-tombstone-ack-v1",
    ...TOMBSTONE_ACK_BODY_KEYS.map((key) => ack[key]),
  ]);
}

export function validateTenantTelemetrySameKeyTombstoneAck(
  ack: TenantTelemetrySameKeyTombstoneAck,
): void {
  exactKeys(ack, [...TOMBSTONE_ACK_BODY_KEYS, "receiptSha256"],
    "tenant telemetry same-key tombstone ACK record");
  const { receiptSha256, ...body } = ack;
  digest(receiptSha256, "tenant telemetry same-key tombstone ACK receipt");
  if (receiptSha256 !== tenantTelemetrySameKeyTombstoneAckSha256(body)) {
    throw new Error("tenant telemetry same-key tombstone ACK receipt does not match");
  }
}

export interface TenantTelemetryExternalTombstoneBody
  extends TenantTelemetryDispositionJournalIdentity {
  scope: typeof TENANT_TELEMETRY_DISPOSITION_EXTERNAL_EVENT_SCOPE;
  protocol: typeof TENANT_TELEMETRY_DISPOSITION_PROTOCOL;
  authorization: TenantTelemetryExternalAuthorizationProof;
  tombstoneAck: TenantTelemetrySameKeyTombstoneAck;
}

export interface TenantTelemetryExternalTombstoneProof
  extends TenantTelemetryExternalTombstoneBody, TenantTelemetryDispositionEventProof {
  terminalReceiptSha256: string;
}

const EXTERNAL_TOMBSTONE_BODY_KEYS = [
  "scope",
  "protocol",
  ...JOURNAL_IDENTITY_KEYS,
  "authorization",
  "tombstoneAck",
] as const;

export function tenantTelemetryExternalTombstoneReceiptSha256(
  terminal: TenantTelemetryExternalTombstoneBody,
): string {
  exactKeys(terminal, EXTERNAL_TOMBSTONE_BODY_KEYS,
    "tenant telemetry external tombstone event");
  if (terminal.scope !== TENANT_TELEMETRY_DISPOSITION_EXTERNAL_EVENT_SCOPE
    || terminal.protocol !== TENANT_TELEMETRY_DISPOSITION_PROTOCOL) {
    throw new Error("tenant telemetry external tombstone event protocol is invalid");
  }
  const identity = Object.fromEntries(JOURNAL_IDENTITY_KEYS.map(
    (key) => [key, terminal[key]],
  )) as unknown as TenantTelemetryDispositionJournalIdentity;
  validateTenantTelemetryDispositionJournalIdentity(identity);
  validateTenantTelemetryExternalAuthorizationProof(terminal.authorization);
  validateTenantTelemetrySameKeyTombstoneAck(terminal.tombstoneAck);
  for (const key of JOURNAL_IDENTITY_KEYS) {
    if (terminal[key] !== terminal.authorization[key]) {
      throw new Error("tenant telemetry external tombstone journal identity does not match");
    }
  }
  if (terminal.authorization.dispositionOperationSha256
      !== terminal.tombstoneAck.dispositionOperationSha256
    || terminal.authorization.authorizationReceiptSha256
      !== terminal.tombstoneAck.authorizationReceiptSha256) {
    throw new Error("tenant telemetry external tombstone authorization does not match");
  }
  for (const key of DISPOSITION_EVIDENCE_KEYS) {
    if (terminal.authorization[key] !== terminal.tombstoneAck[key]) {
      throw new Error("tenant telemetry external tombstone evidence does not match");
    }
  }
  return sha256([
    "tenant-telemetry-external-tombstone-receipt-v1",
    ...EXTERNAL_TOMBSTONE_BODY_KEYS.map((key) => terminal[key]),
  ]);
}

export function validateTenantTelemetryExternalTombstoneProof(
  proof: TenantTelemetryExternalTombstoneProof,
): void {
  exactKeys(proof, [
    ...EXTERNAL_TOMBSTONE_BODY_KEYS,
    "terminalReceiptSha256",
    ...EVENT_PROOF_KEYS,
  ], "tenant telemetry external tombstone proof");
  const body = Object.fromEntries(EXTERNAL_TOMBSTONE_BODY_KEYS.map(
    (key) => [key, proof[key]],
  )) as unknown as TenantTelemetryExternalTombstoneBody;
  digest(proof.terminalReceiptSha256,
    "tenant telemetry external tombstone terminal receipt");
  if (proof.terminalReceiptSha256 !== tenantTelemetryExternalTombstoneReceiptSha256(body)) {
    throw new Error("tenant telemetry external tombstone terminal receipt does not match");
  }
  validateTenantTelemetryDispositionEventProof({
    journalSequence: proof.journalSequence,
    previousJournalEventRootSha256: proof.previousJournalEventRootSha256,
    journalEventSha256: proof.journalEventSha256,
    journalEventRootSha256: proof.journalEventRootSha256,
  }, tenantTelemetryDispositionExternalEventSha256({
      eventType: "delete_tombstoned",
      dispositionOperationSha256: proof.authorization.dispositionOperationSha256,
      eventReceiptSha256: proof.terminalReceiptSha256,
    }));
}

export type TenantTelemetryDispositionExternalEventType =
  | "delete_authorized"
  | "delete_tombstoned";

export type TenantTelemetryDispositionExternalEvent =
  | { eventType: "delete_authorized"; result: TenantTelemetryExternalAuthorizationProof }
  | { eventType: "delete_tombstoned"; result: TenantTelemetryExternalTombstoneProof };

export function validateTenantTelemetryDispositionExternalEvent(
  event: TenantTelemetryDispositionExternalEvent,
): void {
  exactKeys(event, ["eventType", "result"],
    "tenant telemetry disposition external event");
  if (event.eventType === "delete_authorized") {
    validateTenantTelemetryExternalAuthorizationProof(event.result);
    return;
  }
  if (event.eventType === "delete_tombstoned") {
    validateTenantTelemetryExternalTombstoneProof(event.result);
    return;
  }
  throw new Error("tenant telemetry disposition external event type is invalid");
}

export function tenantTelemetryDispositionExternalEventOperation(
  event: TenantTelemetryDispositionExternalEvent,
): string {
  return event.eventType === "delete_authorized"
    ? event.result.dispositionOperationSha256
    : event.result.authorization.dispositionOperationSha256;
}

export function tenantTelemetryDispositionExternalEventReceipt(
  event: TenantTelemetryDispositionExternalEvent,
): string {
  return event.eventType === "delete_authorized"
    ? event.result.authorizationReceiptSha256
    : event.result.terminalReceiptSha256;
}

export function tenantTelemetryDispositionExternalEventProof(
  event: TenantTelemetryDispositionExternalEvent,
): TenantTelemetryDispositionEventProof {
  return {
    journalSequence: event.result.journalSequence,
    previousJournalEventRootSha256: event.result.previousJournalEventRootSha256,
    journalEventSha256: event.result.journalEventSha256,
    journalEventRootSha256: event.result.journalEventRootSha256,
  };
}

export interface TenantTelemetryDispositionExternalHead
  extends TenantTelemetryDispositionJournalIdentity {
  scope: typeof TENANT_TELEMETRY_DISPOSITION_EXTERNAL_HEAD_SCOPE;
  protocol: typeof TENANT_TELEMETRY_DISPOSITION_PROTOCOL;
  journalSequence: number;
  journalEventRootSha256: string;
}

const EXTERNAL_HEAD_KEYS = [
  "scope",
  "protocol",
  ...JOURNAL_IDENTITY_KEYS,
  "journalSequence",
  "journalEventRootSha256",
] as const;

export function validateTenantTelemetryDispositionExternalHead(
  head: TenantTelemetryDispositionExternalHead,
): void {
  exactKeys(head, EXTERNAL_HEAD_KEYS, "tenant telemetry disposition external head");
  if (head.scope !== TENANT_TELEMETRY_DISPOSITION_EXTERNAL_HEAD_SCOPE
    || head.protocol !== TENANT_TELEMETRY_DISPOSITION_PROTOCOL) {
    throw new Error("tenant telemetry disposition external head protocol is invalid");
  }
  const identity = Object.fromEntries(JOURNAL_IDENTITY_KEYS.map(
    (key) => [key, head[key]],
  )) as unknown as TenantTelemetryDispositionJournalIdentity;
  validateTenantTelemetryDispositionJournalIdentity(identity);
  nonNegative(head.journalSequence, "tenant telemetry disposition head sequence");
  digest(head.journalEventRootSha256,
    "tenant telemetry disposition head event root");
  if (head.journalSequence === 0
    && head.journalEventRootSha256
      !== EMPTY_TENANT_TELEMETRY_DISPOSITION_EVENT_ROOT_SHA256) {
    throw new Error("tenant telemetry disposition genesis head root is invalid");
  }
}

export type TenantTelemetryDispositionJobPhase =
  | "queued"
  | "authorized"
  | "tombstoned"
  | "blocked";
export type TenantTelemetryDispositionRetryErrorCode =
  | "temporary_failure"
  | "dependency_pending";
export type TenantTelemetryDispositionBlockReasonCode = "integrity_conflict";

interface TenantTelemetryDispositionJobBase extends TenantTelemetryDispositionEvidence {
  scope: typeof TENANT_TELEMETRY_DISPOSITION_JOB_SCOPE;
  protocol: typeof TENANT_TELEMETRY_DISPOSITION_PROTOCOL;
  tenantId: string;
  requestId: string;
  phase: TenantTelemetryDispositionJobPhase;
  attempts: number;
  createdAtDbMs: number;
  updatedAtDbMs: number;
}

export type TenantTelemetryDispositionJobRecord = TenantTelemetryDispositionJobBase & (
  | {
      phase: "queued" | "authorized";
      availableAtDbMs: number;
      claimToken?: string;
      leaseUntilDbMs?: number;
      lastErrorCode?: TenantTelemetryDispositionRetryErrorCode;
      externalAuthorizationProof?: TenantTelemetryExternalAuthorizationProof;
      terminalReceiptSha256?: never;
      tombstonedAtDbMs?: never;
      blockedAtDbMs?: never;
      blockedReasonCode?: never;
    }
  | {
      phase: "tombstoned";
      availableAtDbMs?: never;
      claimToken?: never;
      leaseUntilDbMs?: never;
      lastErrorCode?: never;
      externalAuthorizationProof: TenantTelemetryExternalAuthorizationProof;
      terminalReceiptSha256: string;
      tombstonedAtDbMs: number;
      blockedAtDbMs?: never;
      blockedReasonCode?: never;
    }
  | {
      phase: "blocked";
      availableAtDbMs?: never;
      claimToken?: never;
      leaseUntilDbMs?: never;
      lastErrorCode?: never;
      externalAuthorizationProof?: TenantTelemetryExternalAuthorizationProof;
      terminalReceiptSha256?: never;
      tombstonedAtDbMs?: never;
      blockedAtDbMs: number;
      blockedReasonCode: TenantTelemetryDispositionBlockReasonCode;
    }
);

export interface MaterializeTenantTelemetryDispositionJobsOptions { limit: number }
export interface ClaimTenantTelemetryDispositionsOptions {
  limit: number;
  leaseMs: number;
  claimToken: string;
}
export interface RenewTenantTelemetryDispositionOptions { leaseMs: number }
export interface RetryTenantTelemetryDispositionOptions {
  delayMs: number;
  errorCode: TenantTelemetryDispositionRetryErrorCode;
}

export interface TenantTelemetryDispositionClaim extends TenantTelemetryDispositionEvidence {
  tenantId: string;
  requestId: string;
  phase: "queued" | "authorized";
  claimAttempt: number;
  claimToken: string;
  leaseUntilDbMs: number;
  externalAuthorizationProof?: TenantTelemetryExternalAuthorizationProof;
}

function dispositionEvidenceFromRecord(
  record: TenantTelemetryDispositionEvidence,
): TenantTelemetryDispositionEvidence {
  return Object.fromEntries(DISPOSITION_EVIDENCE_KEYS.map(
    (key) => [key, record[key]],
  )) as unknown as TenantTelemetryDispositionEvidence;
}

function validateMatchingDispositionAuthorizationProof(
  record: TenantTelemetryDispositionEvidence,
  proof: TenantTelemetryExternalAuthorizationProof,
): void {
  validateTenantTelemetryExternalAuthorizationProof(proof);
  for (const key of DISPOSITION_EVIDENCE_KEYS) {
    if (record[key] !== proof[key]) {
      throw new Error("tenant telemetry disposition external authorization evidence does not match");
    }
  }
}

const DISPOSITION_JOB_BASE_KEYS = [
  "scope",
  "protocol",
  "tenantId",
  "requestId",
  ...DISPOSITION_EVIDENCE_KEYS,
  "phase",
  "attempts",
  "createdAtDbMs",
  "updatedAtDbMs",
] as const;

export function validateTenantTelemetryDispositionJobRecord(
  job: TenantTelemetryDispositionJobRecord,
): void {
  validateTenantTelemetryDispositionEvidence(dispositionEvidenceFromRecord(job));
  if (job.scope !== TENANT_TELEMETRY_DISPOSITION_JOB_SCOPE
    || job.protocol !== TENANT_TELEMETRY_DISPOSITION_PROTOCOL
    || !validTenantId(job.tenantId)
    || !REQUEST_ID.test(job.requestId)) {
    throw new Error("tenant telemetry disposition job protocol or owner is invalid");
  }
  nonNegative(job.attempts, "tenant telemetry disposition job attempts");
  nonNegative(job.createdAtDbMs, "tenant telemetry disposition job creation time");
  nonNegative(job.updatedAtDbMs, "tenant telemetry disposition job update time");
  if (job.updatedAtDbMs < job.createdAtDbMs) {
    throw new Error("tenant telemetry disposition job update precedes creation");
  }
  if (job.phase === "queued" || job.phase === "authorized") {
    exactKeys(job, [
      ...DISPOSITION_JOB_BASE_KEYS,
      "availableAtDbMs",
      ...(job.claimToken === undefined ? [] : ["claimToken"]),
      ...(job.leaseUntilDbMs === undefined ? [] : ["leaseUntilDbMs"]),
      ...(job.lastErrorCode === undefined ? [] : ["lastErrorCode"]),
      ...(job.externalAuthorizationProof === undefined
        ? [] : ["externalAuthorizationProof"]),
    ], `${job.phase} tenant telemetry disposition job`);
    nonNegative(job.availableAtDbMs,
      "tenant telemetry disposition job availability");
    if ((job.claimToken === undefined) !== (job.leaseUntilDbMs === undefined)) {
      throw new Error("tenant telemetry disposition job claim is incomplete");
    }
    if (job.claimToken === undefined) {
      if (job.availableAtDbMs < job.updatedAtDbMs) {
        throw new Error("tenant telemetry disposition job availability predates update");
      }
    } else {
      tenantTelemetryDispositionClaimTokenSha256(job.claimToken);
      nonNegative(job.leaseUntilDbMs!, "tenant telemetry disposition job lease");
      if (job.attempts < 1 || job.leaseUntilDbMs! < job.updatedAtDbMs
        || job.lastErrorCode !== undefined) {
        throw new Error("tenant telemetry disposition job active claim is invalid");
      }
    }
    if (job.lastErrorCode !== undefined
      && job.lastErrorCode !== "temporary_failure"
      && job.lastErrorCode !== "dependency_pending") {
      throw new Error("tenant telemetry disposition job retry code is invalid");
    }
    if (job.phase === "queued") {
      if (job.externalAuthorizationProof !== undefined) {
        throw new Error("queued tenant telemetry disposition job has external authorization");
      }
    } else {
      if (job.externalAuthorizationProof === undefined) {
        throw new Error("authorized tenant telemetry disposition job lacks external proof");
      }
      validateMatchingDispositionAuthorizationProof(job, job.externalAuthorizationProof);
    }
    return;
  }
  if (job.phase === "tombstoned") {
    exactKeys(job, [
      ...DISPOSITION_JOB_BASE_KEYS,
      "externalAuthorizationProof",
      "terminalReceiptSha256",
      "tombstonedAtDbMs",
    ], "tombstoned tenant telemetry disposition job");
    validateMatchingDispositionAuthorizationProof(job, job.externalAuthorizationProof);
    digest(job.terminalReceiptSha256,
      "tenant telemetry disposition job terminal receipt");
    nonNegative(job.tombstonedAtDbMs,
      "tenant telemetry disposition job tombstone time");
    if (job.attempts < 1 || job.tombstonedAtDbMs < job.createdAtDbMs
      || job.tombstonedAtDbMs > job.updatedAtDbMs) {
      throw new Error("tombstoned tenant telemetry disposition job evidence is invalid");
    }
    return;
  }
  if (job.phase === "blocked") {
    exactKeys(job, [
      ...DISPOSITION_JOB_BASE_KEYS,
      "blockedAtDbMs",
      "blockedReasonCode",
    ], "blocked tenant telemetry disposition job");
    nonNegative(job.blockedAtDbMs,
      "tenant telemetry disposition job block time");
    if (job.blockedReasonCode !== "integrity_conflict"
      || job.blockedAtDbMs < job.createdAtDbMs
      || job.blockedAtDbMs > job.updatedAtDbMs) {
      throw new Error("blocked tenant telemetry disposition job evidence is invalid");
    }
    return;
  }
  throw new Error("tenant telemetry disposition job phase is invalid");
}

export function validateMaterializeTenantTelemetryDispositionJobsOptions(
  options: MaterializeTenantTelemetryDispositionJobsOptions,
): void {
  exactKeys(options, ["limit"], "materialize tenant telemetry disposition jobs options");
  positive(options.limit, "tenant telemetry disposition materialize limit");
  if (options.limit > 100) {
    throw new Error("tenant telemetry disposition materialize limit exceeds 100");
  }
}

export function validateClaimTenantTelemetryDispositionsOptions(
  options: ClaimTenantTelemetryDispositionsOptions,
): void {
  exactKeys(options, ["limit", "leaseMs", "claimToken"],
    "claim tenant telemetry dispositions options");
  positive(options.limit, "tenant telemetry disposition claim limit");
  if (options.limit > 100) {
    throw new Error("tenant telemetry disposition claim limit exceeds 100");
  }
  positive(options.leaseMs, "tenant telemetry disposition claim lease");
  tenantTelemetryDispositionClaimTokenSha256(options.claimToken);
}

export function validateRenewTenantTelemetryDispositionOptions(
  options: RenewTenantTelemetryDispositionOptions,
): void {
  exactKeys(options, ["leaseMs"], "renew tenant telemetry disposition options");
  positive(options.leaseMs, "tenant telemetry disposition renewal lease");
}

export function validateRetryTenantTelemetryDispositionOptions(
  options: RetryTenantTelemetryDispositionOptions,
): void {
  exactKeys(options, ["delayMs", "errorCode"],
    "retry tenant telemetry disposition options");
  nonNegative(options.delayMs, "tenant telemetry disposition retry delay");
  if (options.errorCode !== "temporary_failure"
    && options.errorCode !== "dependency_pending") {
    throw new Error("tenant telemetry disposition retry error code is invalid");
  }
}

export function validateTenantTelemetryDispositionClaim(
  claim: TenantTelemetryDispositionClaim,
): void {
  exactKeys(claim, [
    "tenantId",
    "requestId",
    ...DISPOSITION_EVIDENCE_KEYS,
    "phase",
    "claimAttempt",
    "claimToken",
    "leaseUntilDbMs",
    ...(claim.externalAuthorizationProof === undefined
      ? [] : ["externalAuthorizationProof"]),
  ], "tenant telemetry disposition claim");
  validateTenantTelemetryDispositionEvidence(dispositionEvidenceFromRecord(claim));
  if (!validTenantId(claim.tenantId) || !REQUEST_ID.test(claim.requestId)
    || (claim.phase !== "queued" && claim.phase !== "authorized")) {
    throw new Error("tenant telemetry disposition claim protocol or owner is invalid");
  }
  positive(claim.claimAttempt, "tenant telemetry disposition claim attempt");
  tenantTelemetryDispositionClaimTokenSha256(claim.claimToken);
  nonNegative(claim.leaseUntilDbMs, "tenant telemetry disposition claim lease");
  if (claim.phase === "queued" && claim.externalAuthorizationProof !== undefined) {
    throw new Error("queued tenant telemetry disposition claim has external authorization");
  }
  if (claim.phase === "authorized") {
    if (claim.externalAuthorizationProof === undefined) {
      throw new Error("authorized tenant telemetry disposition claim lacks external proof");
    }
    validateMatchingDispositionAuthorizationProof(claim, claim.externalAuthorizationProof);
  }
}

export type TenantTelemetryDispositionAuthorization = Pick<
  TenantTelemetryDispositionClaim,
  "tenantId" | "requestId" | "dispositionOperationSha256" | "claimAttempt" | "claimToken"
>;

export interface TenantTelemetryDispositionReceiptBody
  extends TenantTelemetryDispositionEvidence {
  scope: typeof TENANT_TELEMETRY_DISPOSITION_RECEIPT_SCOPE;
  protocol: typeof TENANT_TELEMETRY_DISPOSITION_PROTOCOL;
  tenantId: string;
  requestId: string;
  externalAuthorizationProof: TenantTelemetryExternalAuthorizationProof;
  tombstoneAck: TenantTelemetrySameKeyTombstoneAck;
  terminalProof: TenantTelemetryExternalTombstoneProof;
  storeDbTimestampMs: number;
  completedClaimAttempt: number;
  completedClaimTokenSha256: string;
  telemetryDispositionComplete: true;
  contentPurgeExecuted: false;
  allDomainsComplete: false;
}

export interface TenantTelemetryDispositionReceipt
  extends TenantTelemetryDispositionReceiptBody {
  receiptSha256: string;
}

const DISPOSITION_RECEIPT_BODY_KEYS = [
  "scope",
  "protocol",
  "tenantId",
  "requestId",
  ...DISPOSITION_EVIDENCE_KEYS,
  "externalAuthorizationProof",
  "tombstoneAck",
  "terminalProof",
  "storeDbTimestampMs",
  "completedClaimAttempt",
  "completedClaimTokenSha256",
  "telemetryDispositionComplete",
  "contentPurgeExecuted",
  "allDomainsComplete",
] as const;

export function tenantTelemetryDispositionReceiptSha256(
  receipt: TenantTelemetryDispositionReceiptBody,
): string {
  exactKeys(receipt, DISPOSITION_RECEIPT_BODY_KEYS,
    "tenant telemetry disposition receipt");
  if (receipt.scope !== TENANT_TELEMETRY_DISPOSITION_RECEIPT_SCOPE
    || receipt.protocol !== TENANT_TELEMETRY_DISPOSITION_PROTOCOL
    || receipt.telemetryDispositionComplete !== true
    || receipt.contentPurgeExecuted !== false
    || receipt.allDomainsComplete !== false) {
    throw new Error("tenant telemetry disposition receipt protocol is invalid");
  }
  if (!validTenantId(receipt.tenantId) || !REQUEST_ID.test(receipt.requestId)) {
    throw new Error("tenant telemetry disposition receipt owner is invalid");
  }
  const evidence = Object.fromEntries(DISPOSITION_EVIDENCE_KEYS.map(
    (key) => [key, receipt[key]],
  )) as unknown as TenantTelemetryDispositionEvidence;
  validateTenantTelemetryDispositionEvidence(evidence);
  validateTenantTelemetryExternalAuthorizationProof(receipt.externalAuthorizationProof);
  validateTenantTelemetrySameKeyTombstoneAck(receipt.tombstoneAck);
  validateTenantTelemetryExternalTombstoneProof(receipt.terminalProof);
  if (receipt.externalAuthorizationProof.dispositionOperationSha256
      !== receipt.dispositionOperationSha256
    || receipt.tombstoneAck.dispositionOperationSha256
      !== receipt.dispositionOperationSha256
    || receipt.terminalProof.authorization.dispositionOperationSha256
      !== receipt.dispositionOperationSha256
    || receipt.terminalProof.authorization.authorizationReceiptSha256
      !== receipt.externalAuthorizationProof.authorizationReceiptSha256
    || receipt.terminalProof.tombstoneAck.receiptSha256 !== receipt.tombstoneAck.receiptSha256) {
    throw new Error("tenant telemetry disposition receipt external evidence does not match");
  }
  nonNegative(receipt.storeDbTimestampMs,
    "tenant telemetry disposition receipt timestamp");
  positive(receipt.completedClaimAttempt,
    "tenant telemetry disposition receipt claim attempt");
  digest(receipt.completedClaimTokenSha256,
    "tenant telemetry disposition receipt claim token");
  return sha256([
    "tenant-telemetry-disposition-receipt-v1",
    ...DISPOSITION_RECEIPT_BODY_KEYS.map((key) => receipt[key]),
  ]);
}

export function validateTenantTelemetryDispositionReceipt(
  receipt: TenantTelemetryDispositionReceipt,
): void {
  exactKeys(receipt, [...DISPOSITION_RECEIPT_BODY_KEYS, "receiptSha256"],
    "tenant telemetry disposition receipt record");
  const { receiptSha256, ...body } = receipt;
  digest(receiptSha256, "tenant telemetry disposition receipt digest");
  if (receiptSha256 !== tenantTelemetryDispositionReceiptSha256(body)) {
    throw new Error("tenant telemetry disposition receipt digest does not match");
  }
}

export interface TenantTelemetryDispositionReplayFenceBody
  extends TenantTelemetryDispositionIdentity {
  scope: typeof TENANT_TELEMETRY_DISPOSITION_REPLAY_FENCE_SCOPE;
  protocol: typeof TENANT_TELEMETRY_DISPOSITION_PROTOCOL;
  dispositionOperationSha256: string;
  authorizationReceiptSha256: string;
  tombstoneReceiptSha256: string;
  terminalReceiptSha256: string;
  journalTargetSha256: string;
  terminalJournalSequence: number;
  terminalJournalEventRootSha256: string;
  sealedJournalSequence: number;
  sealedJournalEventRootSha256: string;
  restoreRunSha256: string | null;
  runtimeEpochSha256: string | null;
}

export interface TenantTelemetryDispositionReplayFence
  extends TenantTelemetryDispositionReplayFenceBody {
  receiptSha256: string;
}

const REPLAY_FENCE_BODY_KEYS = [
  "scope",
  "protocol",
  "domain",
  "targetSha256",
  "artifactIdSha256",
  "artifactGeneration",
  "dispositionOperationSha256",
  "authorizationReceiptSha256",
  "tombstoneReceiptSha256",
  "terminalReceiptSha256",
  "journalTargetSha256",
  "terminalJournalSequence",
  "terminalJournalEventRootSha256",
  "sealedJournalSequence",
  "sealedJournalEventRootSha256",
  "restoreRunSha256",
  "runtimeEpochSha256",
] as const;

export function tenantTelemetryDispositionReplayFenceSha256(
  fence: TenantTelemetryDispositionReplayFenceBody,
): string {
  exactKeys(fence, REPLAY_FENCE_BODY_KEYS,
    "tenant telemetry disposition replay fence");
  if (fence.scope !== TENANT_TELEMETRY_DISPOSITION_REPLAY_FENCE_SCOPE
    || fence.protocol !== TENANT_TELEMETRY_DISPOSITION_PROTOCOL) {
    throw new Error("tenant telemetry disposition replay fence protocol is invalid");
  }
  domain(fence.domain);
  positive(fence.artifactGeneration,
    "tenant telemetry disposition replay fence artifact generation");
  for (const [value, name] of [
    [fence.targetSha256, "target"],
    [fence.artifactIdSha256, "artifact id"],
    [fence.dispositionOperationSha256, "operation"],
    [fence.authorizationReceiptSha256, "authorization receipt"],
    [fence.tombstoneReceiptSha256, "tombstone receipt"],
    [fence.terminalReceiptSha256, "terminal receipt"],
    [fence.journalTargetSha256, "journal target"],
    [fence.terminalJournalEventRootSha256, "terminal event root"],
    [fence.sealedJournalEventRootSha256, "sealed event root"],
  ] as const) digest(value, `tenant telemetry disposition replay fence ${name}`);
  positive(fence.terminalJournalSequence,
    "tenant telemetry disposition replay fence terminal sequence");
  if (!Number.isSafeInteger(fence.sealedJournalSequence)
    || fence.sealedJournalSequence < fence.terminalJournalSequence) {
    throw new Error("tenant telemetry disposition replay fence sealed sequence is invalid");
  }
  nullableDigest(fence.restoreRunSha256,
    "tenant telemetry disposition replay fence restore run");
  nullableDigest(fence.runtimeEpochSha256,
    "tenant telemetry disposition replay fence runtime epoch");
  if ((fence.restoreRunSha256 === null) !== (fence.runtimeEpochSha256 === null)) {
    throw new Error("tenant telemetry disposition replay fence restore binding is incomplete");
  }
  return sha256([
    "tenant-telemetry-disposition-replay-fence-v1",
    ...REPLAY_FENCE_BODY_KEYS.map((key) => fence[key]),
  ]);
}

export function validateTenantTelemetryDispositionReplayFence(
  fence: TenantTelemetryDispositionReplayFence,
): void {
  exactKeys(fence, [...REPLAY_FENCE_BODY_KEYS, "receiptSha256"],
    "tenant telemetry disposition replay fence record");
  const { receiptSha256, ...body } = fence;
  digest(receiptSha256, "tenant telemetry disposition replay fence receipt");
  if (receiptSha256 !== tenantTelemetryDispositionReplayFenceSha256(body)) {
    throw new Error("tenant telemetry disposition replay fence receipt does not match");
  }
}

export function tenantTelemetryDispositionClaimTokenSha256(claimToken: string): string {
  if (!CLAIM_TOKEN.test(claimToken)) {
    throw new Error("tenant telemetry disposition claim token is invalid");
  }
  return sha256(["tenant-telemetry-disposition-claim-token-v1", claimToken]);
}

export function validateTenantTelemetryDispositionAuthorization(
  authorization: TenantTelemetryDispositionAuthorization,
): void {
  exactKeys(authorization, [
    "tenantId", "requestId", "dispositionOperationSha256", "claimAttempt", "claimToken",
  ], "tenant telemetry disposition authorization");
  if (!validTenantId(authorization.tenantId) || !REQUEST_ID.test(authorization.requestId)) {
    throw new Error("tenant telemetry disposition authorization owner is invalid");
  }
  digest(authorization.dispositionOperationSha256,
    "tenant telemetry disposition authorization operation");
  positive(authorization.claimAttempt,
    "tenant telemetry disposition authorization claim attempt");
  tenantTelemetryDispositionClaimTokenSha256(authorization.claimToken);
}

/**
 * An exact, single managed-artifact grant, never whole-domain erasure authority.
 * It can only be issued from a live store claim after revalidating the canonical
 * 0033 inventory, 0034 ACK, 0035 binding and T3c/T3d source. In particular the
 * current zero-target logs/traces T3d blocker cannot produce one.
 */
export interface TenantTelemetryDispositionAuthorizationGrantBody
  extends TenantTelemetryDispositionEvidence {
  scope: typeof TENANT_TELEMETRY_DISPOSITION_AUTHORIZATION_GRANT_SCOPE;
  protocol: typeof TENANT_TELEMETRY_DISPOSITION_PROTOCOL;
  tenantId: string;
  requestId: string;
  claimAttempt: number;
  claimTokenSha256: string;
  grantedAtDbMs: number;
  leaseUntilDbMs: number;
}

export interface TenantTelemetryDispositionAuthorizationGrant
  extends TenantTelemetryDispositionAuthorizationGrantBody {
  grantReceiptSha256: string;
}

const AUTHORIZATION_GRANT_BODY_KEYS = [
  "scope",
  "protocol",
  "tenantId",
  "requestId",
  ...DISPOSITION_EVIDENCE_KEYS,
  "claimAttempt",
  "claimTokenSha256",
  "grantedAtDbMs",
  "leaseUntilDbMs",
] as const;

export function tenantTelemetryDispositionAuthorizationGrantSha256(
  grant: TenantTelemetryDispositionAuthorizationGrantBody,
): string {
  exactKeys(grant, AUTHORIZATION_GRANT_BODY_KEYS,
    "tenant telemetry disposition authorization grant body");
  if (grant.scope !== TENANT_TELEMETRY_DISPOSITION_AUTHORIZATION_GRANT_SCOPE
    || grant.protocol !== TENANT_TELEMETRY_DISPOSITION_PROTOCOL
    || !validTenantId(grant.tenantId)
    || !REQUEST_ID.test(grant.requestId)) {
    throw new Error("tenant telemetry disposition authorization grant owner or protocol is invalid");
  }
  const evidence = Object.fromEntries(DISPOSITION_EVIDENCE_KEYS.map(
    (key) => [key, grant[key]],
  )) as unknown as TenantTelemetryDispositionEvidence;
  validateTenantTelemetryDispositionEvidence(evidence);
  if (grant.applicationCoverageEvidenceSha256 === null
    || grant.applicationWriteBindingReceiptSha256 === null) {
    throw new Error("tenant telemetry disposition authorization grant lacks bound application capture");
  }
  positive(grant.claimAttempt, "tenant telemetry disposition authorization grant claim attempt");
  digest(grant.claimTokenSha256,
    "tenant telemetry disposition authorization grant claim token hash");
  nonNegative(grant.grantedAtDbMs,
    "tenant telemetry disposition authorization grant DB time");
  if (!Number.isSafeInteger(grant.leaseUntilDbMs)
    || grant.leaseUntilDbMs <= grant.grantedAtDbMs) {
    throw new Error("tenant telemetry disposition authorization grant lease is invalid");
  }
  return sha256([
    TENANT_TELEMETRY_DISPOSITION_AUTHORIZATION_GRANT_SCOPE,
    ...AUTHORIZATION_GRANT_BODY_KEYS.map((key) => grant[key]),
  ]);
}

export function validateTenantTelemetryDispositionAuthorizationGrant(
  grant: TenantTelemetryDispositionAuthorizationGrant,
): void {
  exactKeys(grant, [...AUTHORIZATION_GRANT_BODY_KEYS, "grantReceiptSha256"],
    "tenant telemetry disposition authorization grant");
  const { grantReceiptSha256, ...body } = grant;
  digest(grantReceiptSha256,
    "tenant telemetry disposition authorization grant receipt");
  if (grantReceiptSha256 !== tenantTelemetryDispositionAuthorizationGrantSha256(body)) {
    throw new Error("tenant telemetry disposition authorization grant receipt does not match");
  }
}

export interface ScanTenantTelemetryDispositionEventsOptions {
  afterJournalSequence: number;
  afterJournalEventRootSha256: string;
  sealedHead: TenantTelemetryDispositionExternalHead;
  limit: number;
}

export interface ScanTenantTelemetryDispositionEventsResult {
  events: TenantTelemetryDispositionExternalEvent[];
  nextJournalSequence: number;
  nextJournalEventRootSha256: string;
  complete: boolean;
}

export interface TenantTelemetryDispositionExternalAdapter {
  readonly adapterProtocol: string;
  readonly journalNamespaceSha256: string;
  readonly journalTargetSha256: string;
  readonly failureDomainSha256: string;
  readonly logicalDatabaseNamespaceSha256: string;
  validateStartup(): Promise<void>;
  authorizeDeletion(
    evidence: TenantTelemetryDispositionEvidence,
  ): Promise<TenantTelemetryExternalAuthorizationProof>;
  recordTombstone(
    ack: TenantTelemetrySameKeyTombstoneAck,
  ): Promise<TenantTelemetryExternalTombstoneProof>;
  readHead(): Promise<TenantTelemetryDispositionExternalHead>;
  scanEvents(
    options: ScanTenantTelemetryDispositionEventsOptions,
  ): Promise<ScanTenantTelemetryDispositionEventsResult>;
  close(): Promise<void>;
}

export interface TenantTelemetryDispositionStore {
  getTenantTelemetryDispositionControl(
  ): Promise<TenantTelemetryDispositionControl>;
  getTenantTelemetryDispositionActivationReceipt(
  ): Promise<TenantTelemetryDispositionActivationReceipt | null>;
  /** Store-only, write-once cutover. No CLI or network activity is implied by this method. */
  activateTenantTelemetryDisposition(
    input: ActivateTenantTelemetryDispositionInput,
  ): Promise<TenantTelemetryDispositionActivationResult>;
  materializeTenantTelemetryDispositionJobs(
    options: MaterializeTenantTelemetryDispositionJobsOptions,
  ): Promise<number>;
  claimTenantTelemetryDispositions(
    options: ClaimTenantTelemetryDispositionsOptions,
  ): Promise<TenantTelemetryDispositionClaim[]>;
  renewTenantTelemetryDisposition(
    authorization: TenantTelemetryDispositionAuthorization,
    options: RenewTenantTelemetryDispositionOptions,
  ): Promise<boolean>;
  retryTenantTelemetryDisposition(
    authorization: TenantTelemetryDispositionAuthorization,
    options: RetryTenantTelemetryDispositionOptions,
  ): Promise<boolean>;
  blockTenantTelemetryDisposition(
    authorization: TenantTelemetryDispositionAuthorization,
  ): Promise<boolean>;
  issueTenantTelemetryDispositionAuthorizationGrant(
    authorization: TenantTelemetryDispositionAuthorization,
  ): Promise<TenantTelemetryDispositionAuthorizationGrant | null>;
  getTenantTelemetryDispositionAuthorizationGrant(
    tenantId: string,
    dispositionOperationSha256: string,
  ): Promise<TenantTelemetryDispositionAuthorizationGrant | null>;
  recordTenantTelemetryExternalAuthorization(
    authorization: TenantTelemetryDispositionAuthorization,
    proof: TenantTelemetryExternalAuthorizationProof,
  ): Promise<boolean>;
  completeTenantTelemetryDisposition(
    authorization: TenantTelemetryDispositionAuthorization,
    tombstoneAck: TenantTelemetrySameKeyTombstoneAck,
    terminalProof: TenantTelemetryExternalTombstoneProof,
  ): Promise<TenantTelemetryDispositionReceipt | null>;
  getTenantTelemetryDispositionJob(
    tenantId: string,
    dispositionOperationSha256: string,
  ): Promise<TenantTelemetryDispositionJobRecord | null>;
  getTenantTelemetryDispositionReceipt(
    tenantId: string,
    dispositionOperationSha256: string,
  ): Promise<TenantTelemetryDispositionReceipt | null>;
  mirrorTenantTelemetryDispositionExternalEvent(
    event: TenantTelemetryDispositionExternalEvent,
  ): Promise<void>;
  sealTenantTelemetryDispositionReplayFence(
    input: TenantTelemetryDispositionReplayFenceBody,
  ): Promise<TenantTelemetryDispositionReplayFence>;
  getTenantTelemetryDispositionReplayFence(
    targetSha256: string,
    artifactIdSha256: string,
    artifactGeneration: number,
  ): Promise<TenantTelemetryDispositionReplayFence | null>;
}

export class TenantTelemetryDispositionConflictError extends Error {
  constructor(message = "tenant telemetry disposition conflicts with immutable evidence") {
    super(message);
    this.name = "TenantTelemetryDispositionConflictError";
  }
}

export class TenantTelemetryDispositionCorruptError extends Error {
  constructor(message = "tenant telemetry disposition evidence is corrupt") {
    super(message);
    this.name = "TenantTelemetryDispositionCorruptError";
  }
}
