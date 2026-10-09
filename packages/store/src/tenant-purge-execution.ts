import { createHash } from "node:crypto";
import {
  TENANT_PURGE_PLAN_DOMAINS,
  tenantPurgePlanDomainOrdinal,
  type TenantPurgePlanDisposition,
  type TenantPurgePlanDomain,
} from "./tenant-purge-plan.js";

export const TENANT_PURGE_EXECUTION_DOMAIN_ACK_SCOPE =
  "tenant-purge-execution-domain-ack-v1" as const;
export const TENANT_PURGE_LOCAL_CUTOVER_SCOPE = "tenant-purge-local-cutover-v1" as const;
export const TENANT_PURGE_LOCAL_PHYSICAL_ACK_SCOPE =
  "tenant-purge-local-physical-ack-v1" as const;
export const TENANT_PURGE_EXECUTION_CUTOVER_SINGLETON_ID = 1 as const;

export const TENANT_PURGE_EXECUTION_ACK_KINDS = [
  "blocker_resolution",
  "applied",
  "anonymized",
  "outbox_scheduled",
  "physical_delete",
] as const;
export type TenantPurgeExecutionAckKind =
  (typeof TENANT_PURGE_EXECUTION_ACK_KINDS)[number];
export type TenantPurgeExecutionOutboxKind = "blob_delete" | "user_export_delete";
export type TenantPurgeExecutionDomainPhase =
  | "pending"
  | "awaiting_blocker_resolution"
  | "awaiting_physical_ack"
  | "acked";
export type TenantPurgeExecutionJobPhase =
  | "queued"
  | "local_physical_acks_sealed"
  | "blocked";

export type TenantPurgeExecutionRetryErrorCode = "temporary_failure" | "physical_ack_pending";
export type TenantPurgeExecutionBlockReasonCode = "integrity_conflict" | "physical_ack_dead_lettered";

export class TenantPurgeExecutionNotReadyError extends Error {
  constructor(public readonly reason: "physical_ack_pending" | "active_legal_hold") {
    super(`tenant purge execution is not ready: ${reason}`);
    this.name = "TenantPurgeExecutionNotReadyError";
  }
}

export class TenantPurgeExecutionEvidenceChangedError extends Error {
  constructor() {
    super("tenant purge execution source evidence changed");
    this.name = "TenantPurgeExecutionEvidenceChangedError";
  }
}

/** The exact scheduled physical-delete intent reached a terminal dead letter. */
export class TenantPurgeExecutionPhysicalAckDeadLetterError extends Error {
  constructor() {
    super("tenant purge execution physical delete was dead-lettered");
    this.name = "TenantPurgeExecutionPhysicalAckDeadLetterError";
  }
}

const REQUEST_ID = /^erase_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLAIM_TOKEN = /^[A-Za-z0-9._:~-]{1,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ADAPTER_PROTOCOL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROOF_ACTION = /^[a-z][a-z0-9._:-]{0,127}$/;

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function exactKeys(value: object, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new Error(`${name} has unknown or missing fields`);
  }
}

function timestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function count(value: number, name: string): void {
  timestamp(value, name);
}

function positive(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function digest(value: string, name: string): void {
  if (!SHA256.test(value)) throw new Error(`${name} must be a lowercase SHA-256 digest`);
}

function tenantId(value: string): void {
  if (!value || value.length > 128) throw new Error("invalid tenant purge execution tenant id");
}

function claimToken(value: string): void {
  if (!CLAIM_TOKEN.test(value)) throw new Error("invalid tenant purge execution claim token");
}

export interface TenantPurgeExecutionIdentity {
  requestId: string;
  tenantId: string;
  subjectGeneration: number;
  planBuildGeneration: number;
  executionGeneration: number;
}

export interface TenantPurgeExecutionSource extends TenantPurgeExecutionIdentity {
  t3cReceiptSha256: string;
  planReceiptSha256: string;
  planEntryRootSha256: string;
  planBlockerCount: number;
  planBlockerRootSha256: string;
  policySha256: string;
  purgeNotBeforeDbMs: number;
  sourceEvidenceDbMs: number;
}

export function validateTenantPurgeExecutionIdentity(identity: TenantPurgeExecutionIdentity): void {
  if (!REQUEST_ID.test(identity.requestId)) throw new Error("invalid tenant purge execution request id");
  tenantId(identity.tenantId);
  positive(identity.subjectGeneration, "tenant purge execution subject generation");
  positive(identity.planBuildGeneration, "tenant purge execution plan generation");
  positive(identity.executionGeneration, "tenant purge execution generation");
}

export function validateTenantPurgeExecutionSource(source: TenantPurgeExecutionSource): void {
  validateTenantPurgeExecutionIdentity(source);
  for (const [value, name] of [
    [source.t3cReceiptSha256, "T3c receipt"],
    [source.planReceiptSha256, "plan receipt"],
    [source.planEntryRootSha256, "plan entry root"],
    [source.planBlockerRootSha256, "plan blocker root"],
    [source.policySha256, "policy"],
  ] as const) digest(value, `tenant purge execution ${name}`);
  count(source.planBlockerCount, "tenant purge execution plan blocker count");
  if (source.planBlockerCount > TENANT_PURGE_PLAN_DOMAINS.length) {
    throw new Error("tenant purge execution plan blocker count is invalid");
  }
  timestamp(source.purgeNotBeforeDbMs, "tenant purge execution deadline");
  timestamp(source.sourceEvidenceDbMs, "tenant purge execution source evidence time");
  if (source.sourceEvidenceDbMs < source.purgeNotBeforeDbMs) {
    throw new Error("tenant purge execution source evidence predates its deadline");
  }
}

export interface MaterializeTenantPurgeExecutionJobsOptions { limit: number }
export interface ClaimTenantPurgeExecutionsOptions {
  limit: number;
  leaseMs: number;
  claimToken: string;
}
export interface RenewTenantPurgeExecutionOptions { leaseMs: number }
export interface RetryTenantPurgeExecutionOptions {
  delayMs: number;
  errorCode: TenantPurgeExecutionRetryErrorCode;
}

interface TenantPurgeExecutionJobBase extends TenantPurgeExecutionSource {
  phase: TenantPurgeExecutionJobPhase;
  domainCount: number;
  domainAckCount: number;
  domainAckRootSha256: string;
  unresolvedBlockerCount: number;
  localCutoverReceiptSha256?: string;
  attempts: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export type TenantPurgeExecutionJobRecord = TenantPurgeExecutionJobBase & (
  | {
      phase: "queued";
      availableAtMs: number;
      claimToken?: string;
      leaseUntilMs?: number;
      lastErrorCode?: TenantPurgeExecutionRetryErrorCode;
      localPhysicalAckReceiptSha256?: never;
      localPhysicalAcksSealedAtDbMs?: never;
      completedClaimAttempt?: never;
      completedClaimTokenSha256?: never;
      blockedAtDbMs?: never;
      blockedReasonCode?: never;
    }
  | {
      phase: "local_physical_acks_sealed";
      availableAtMs?: never;
      claimToken?: never;
      leaseUntilMs?: never;
      lastErrorCode?: never;
      localCutoverReceiptSha256: string;
      localPhysicalAckReceiptSha256: string;
      localPhysicalAcksSealedAtDbMs: number;
      completedClaimAttempt: number;
      completedClaimTokenSha256: string;
      blockedAtDbMs?: never;
      blockedReasonCode?: never;
    }
  | {
      phase: "blocked";
      availableAtMs?: never;
      claimToken?: never;
      leaseUntilMs?: never;
      lastErrorCode?: never;
      localPhysicalAckReceiptSha256?: never;
      localPhysicalAcksSealedAtDbMs?: never;
      completedClaimAttempt?: never;
      completedClaimTokenSha256?: never;
      blockedAtDbMs: number;
      blockedReasonCode: TenantPurgeExecutionBlockReasonCode;
    }
);

export interface TenantPurgeExecutionClaim extends TenantPurgeExecutionSource {
  phase: "queued";
  claimAttempt: number;
  claimToken: string;
  leaseUntilMs: number;
  localCutoverCommitted: boolean;
}

export type TenantPurgeExecutionAuthorization = Pick<
  TenantPurgeExecutionClaim,
  | "requestId"
  | "tenantId"
  | "subjectGeneration"
  | "planBuildGeneration"
  | "executionGeneration"
  | "claimAttempt"
  | "claimToken"
>;

export interface TenantPurgeExecutionDomainRecord extends TenantPurgeExecutionIdentity {
  domain: TenantPurgePlanDomain;
  executionOrdinal: number;
  planDisposition: TenantPurgePlanDisposition;
  planTargetCount: number;
  planTargetRootSha256: string;
  planSourceSha256: string;
  planEntryReceiptSha256: string;
  phase: TenantPurgeExecutionDomainPhase;
  ackCount: number;
  ackRootSha256: string;
  finalAckSha256?: string;
  updatedAtMs: number;
}

export interface TenantPurgeExecutionOutboxReference {
  outboxKind: TenantPurgeExecutionOutboxKind;
  outboxId: number;
  deletionGeneration: number;
  targetSha256: string;
}

export interface TenantPurgeExecutionDomainAck extends TenantPurgeExecutionIdentity {
  scope: typeof TENANT_PURGE_EXECUTION_DOMAIN_ACK_SCOPE;
  domain: TenantPurgePlanDomain;
  globalAckSeq: number;
  domainAckSeq: number;
  previousDomainAckSha256: string;
  previousGlobalAckSha256: string;
  ackKind: TenantPurgeExecutionAckKind;
  planEntryReceiptSha256: string;
  affectedCount: number;
  resultCount: number;
  resultRootSha256: string;
  adapterProtocol: string;
  operationSha256: string;
  physicalProofSha256: string;
  completedClaimAttempt: number;
  completedClaimTokenSha256: string;
  storeDbTimestampMs: number;
  final: boolean;
  outboxKind?: TenantPurgeExecutionOutboxKind;
  outboxId?: number;
  deletionGeneration?: number;
  targetSha256?: string;
  scheduledAckSha256?: string;
  receiptSha256: string;
}

export interface TenantPurgeLocalCutoverReceipt extends TenantPurgeExecutionSource {
  scope: typeof TENANT_PURGE_LOCAL_CUTOVER_SCOPE;
  operationalUsageTargetCount: number;
  operationalUsageTargetRootSha256: string;
  blobBytesTargetCount: number;
  blobBytesTargetRootSha256: string;
  blobDeleteOutboxCount: number;
  blobDeleteOutboxRootSha256: string;
  exportBytesTargetCount: number;
  exportBytesTargetRootSha256: string;
  exportDeleteOutboxCount: number;
  exportDeleteOutboxRootSha256: string;
  domainAckCount: number;
  domainAckRootSha256: string;
  storeDbTimestampMs: number;
  completedClaimAttempt: number;
  completedClaimTokenSha256: string;
  localDestructiveProgress: true;
  physicalAcksComplete: false;
  allDomainsComplete: false;
  contentPurgeExecuted: false;
  receiptSha256: string;
}

export interface TenantPurgeLocalPhysicalAckReceipt extends TenantPurgeExecutionSource {
  scope: typeof TENANT_PURGE_LOCAL_PHYSICAL_ACK_SCOPE;
  localCutoverReceiptSha256: string;
  blobPhysicalAckCount: number;
  blobPhysicalAckRootSha256: string;
  exportPhysicalAckCount: number;
  exportPhysicalAckRootSha256: string;
  domainAckCount: number;
  domainAckRootSha256: string;
  unresolvedBlockerCount: number;
  storeDbTimestampMs: number;
  completedClaimAttempt: number;
  completedClaimTokenSha256: string;
  localPhysicalAcksComplete: true;
  allDomainsComplete: false;
  contentPurgeExecuted: false;
  receiptSha256: string;
}

export type TenantPurgeExecutionCutoverRecord =
  | {
      singletonId: typeof TENANT_PURGE_EXECUTION_CUTOVER_SINGLETON_ID;
      controlGeneration: 0;
    }
  | {
      singletonId: typeof TENANT_PURGE_EXECUTION_CUTOVER_SINGLETON_ID;
      controlGeneration: 1;
      activatedAtDbMs: number;
      firstRequestId: string;
      firstReceiptSha256: string;
      evidenceSha256: string;
    };

export const EMPTY_TENANT_PURGE_EXECUTION_DOMAIN_ACK_ROOT_SHA256 = sha256([
  "tenant-purge-execution-domain-ack-chain-v1",
]);
export const EMPTY_TENANT_PURGE_EXECUTION_GLOBAL_ACK_ROOT_SHA256 = sha256([
  "tenant-purge-execution-global-ack-chain-v1",
]);
export const EMPTY_TENANT_PURGE_EXECUTION_OUTBOX_ROOT_SHA256 = sha256([
  "tenant-purge-execution-outbox-root-v1",
]);

export function tenantPurgeExecutionClaimTokenSha256(value: string): string {
  claimToken(value);
  return sha256(["tenant-purge-execution-claim-token-v1", value]);
}

export function tenantPurgeExecutionCutoverEvidenceSha256(
  input: Omit<Extract<TenantPurgeExecutionCutoverRecord, { controlGeneration: 1 }>, "evidenceSha256">,
): string {
  validateTenantPurgeExecutionCutoverRecord({ ...input, evidenceSha256: "0".repeat(64) }, true);
  return sha256([
    "tenant-purge-execution-cutover-v1",
    input.singletonId,
    input.controlGeneration,
    input.activatedAtDbMs,
    input.firstRequestId,
    input.firstReceiptSha256,
  ]);
}

export function validateTenantPurgeExecutionCutoverRecord(
  record: TenantPurgeExecutionCutoverRecord,
  skipEvidence = false,
): void {
  if (record.controlGeneration === 0) {
    exactKeys(record, ["singletonId", "controlGeneration"], "inactive tenant purge execution cutover");
    if (record.singletonId !== TENANT_PURGE_EXECUTION_CUTOVER_SINGLETON_ID) {
      throw new Error("tenant purge execution cutover singleton is invalid");
    }
    return;
  }
  exactKeys(record, [
    "singletonId", "controlGeneration", "activatedAtDbMs", "firstRequestId",
    "firstReceiptSha256", "evidenceSha256",
  ], "active tenant purge execution cutover");
  if (record.singletonId !== TENANT_PURGE_EXECUTION_CUTOVER_SINGLETON_ID
    || record.controlGeneration !== 1 || !REQUEST_ID.test(record.firstRequestId)) {
    throw new Error("tenant purge execution cutover identity is invalid");
  }
  timestamp(record.activatedAtDbMs, "tenant purge execution cutover timestamp");
  digest(record.firstReceiptSha256, "tenant purge execution cutover first receipt");
  digest(record.evidenceSha256, "tenant purge execution cutover evidence");
  if (!skipEvidence && tenantPurgeExecutionCutoverEvidenceSha256(record) !== record.evidenceSha256) {
    throw new Error("tenant purge execution cutover evidence does not match");
  }
}

export function tenantPurgeExecutionOutboxTargetSha256(
  reference: TenantPurgeExecutionOutboxReference,
): string {
  if (reference.outboxKind !== "blob_delete" && reference.outboxKind !== "user_export_delete") {
    throw new Error("tenant purge execution outbox kind is invalid");
  }
  positive(reference.outboxId, "tenant purge execution outbox id");
  positive(reference.deletionGeneration, "tenant purge execution deletion generation");
  digest(reference.targetSha256, "tenant purge execution target hash");
  return sha256([
    "tenant-purge-execution-outbox-target-v1",
    reference.outboxKind,
    reference.outboxId,
    reference.deletionGeneration,
    reference.targetSha256,
  ]);
}

export function tenantPurgeExecutionOutboxRootSha256(
  references: readonly TenantPurgeExecutionOutboxReference[],
): string {
  const hashes = references.map(tenantPurgeExecutionOutboxTargetSha256).sort();
  if (new Set(hashes).size !== hashes.length) {
    throw new Error("tenant purge execution outbox target is duplicated");
  }
  return sha256(["tenant-purge-execution-outbox-root-v1", ...hashes]);
}

export function tenantPurgeExecutionResultRootSha256(
  domain: TenantPurgePlanDomain,
  action: string,
  resultSha256s: readonly string[],
): string {
  tenantPurgePlanDomainOrdinal(domain);
  if (!PROOF_ACTION.test(action)) throw new Error("tenant purge execution proof action is invalid");
  for (const value of resultSha256s) digest(value, "tenant purge execution result hash");
  const ordered = [...resultSha256s].sort();
  if (new Set(ordered).size !== ordered.length) {
    throw new Error("tenant purge execution result hash is duplicated");
  }
  return sha256(["tenant-purge-execution-result-root-v1", domain, action, ...ordered]);
}

export function tenantPurgeExecutionOperationSha256(input: {
  identity: TenantPurgeExecutionIdentity;
  domain: TenantPurgePlanDomain;
  action: string;
  affectedCount: number;
  resultCount: number;
  resultRootSha256: string;
}): string {
  validateTenantPurgeExecutionIdentity(input.identity);
  tenantPurgePlanDomainOrdinal(input.domain);
  if (!PROOF_ACTION.test(input.action)) {
    throw new Error("tenant purge execution proof action is invalid");
  }
  count(input.affectedCount, "tenant purge execution operation affected count");
  count(input.resultCount, "tenant purge execution operation result count");
  digest(input.resultRootSha256, "tenant purge execution operation result root");
  return sha256([
    "tenant-purge-execution-operation-v1",
    input.identity.requestId,
    input.identity.tenantId,
    input.identity.subjectGeneration,
    input.identity.planBuildGeneration,
    input.identity.executionGeneration,
    input.domain,
    input.action,
    input.affectedCount,
    input.resultCount,
    input.resultRootSha256,
  ]);
}

export function tenantPurgeExecutionPhysicalProofSha256(input: {
  identity: TenantPurgeExecutionIdentity;
  domain: TenantPurgePlanDomain;
  action: string;
  proofFields: readonly (string | number | boolean | null)[];
}): string {
  validateTenantPurgeExecutionIdentity(input.identity);
  tenantPurgePlanDomainOrdinal(input.domain);
  if (!PROOF_ACTION.test(input.action)) {
    throw new Error("tenant purge execution proof action is invalid");
  }
  for (const field of input.proofFields) {
    if (typeof field === "number" && !Number.isSafeInteger(field)) {
      throw new Error("tenant purge execution physical proof integer is unsafe");
    }
  }
  return sha256([
    "tenant-purge-execution-physical-proof-v1",
    input.identity.requestId,
    input.identity.executionGeneration,
    input.domain,
    input.action,
    ...input.proofFields,
  ]);
}

export function tenantPurgeExecutionNextDomainAckRootSha256(
  previous: string,
  domain: TenantPurgePlanDomain,
  ackSha256: string,
): string {
  digest(previous, "tenant purge execution previous domain ACK root");
  digest(ackSha256, "tenant purge execution domain ACK hash");
  tenantPurgePlanDomainOrdinal(domain);
  return sha256(["tenant-purge-execution-domain-ack-chain-v1", previous, domain, ackSha256]);
}

export function tenantPurgeExecutionNextGlobalAckRootSha256(
  previous: string,
  globalAckSeq: number,
  ackSha256: string,
): string {
  digest(previous, "tenant purge execution previous global ACK root");
  positive(globalAckSeq, "tenant purge execution global ACK sequence");
  digest(ackSha256, "tenant purge execution ACK hash");
  return sha256(["tenant-purge-execution-global-ack-chain-v1", previous, globalAckSeq, ackSha256]);
}

type DomainAckBody = Omit<TenantPurgeExecutionDomainAck, "receiptSha256">;

export function tenantPurgeExecutionDomainAckSha256(ack: DomainAckBody): string {
  validateTenantPurgeExecutionIdentity(ack);
  if (ack.scope !== TENANT_PURGE_EXECUTION_DOMAIN_ACK_SCOPE) {
    throw new Error("tenant purge execution ACK scope is invalid");
  }
  tenantPurgePlanDomainOrdinal(ack.domain);
  positive(ack.globalAckSeq, "tenant purge execution global ACK sequence");
  positive(ack.domainAckSeq, "tenant purge execution domain ACK sequence");
  digest(ack.previousDomainAckSha256, "tenant purge execution previous domain ACK");
  digest(ack.previousGlobalAckSha256, "tenant purge execution previous global ACK");
  if (!(TENANT_PURGE_EXECUTION_ACK_KINDS as readonly string[]).includes(ack.ackKind)) {
    throw new Error("tenant purge execution ACK kind is invalid");
  }
  digest(ack.planEntryReceiptSha256, "tenant purge execution plan entry receipt");
  count(ack.affectedCount, "tenant purge execution affected count");
  count(ack.resultCount, "tenant purge execution result count");
  digest(ack.resultRootSha256, "tenant purge execution result root");
  if (!ADAPTER_PROTOCOL.test(ack.adapterProtocol)) {
    throw new Error("tenant purge execution adapter protocol is invalid");
  }
  digest(ack.operationSha256, "tenant purge execution operation");
  digest(ack.physicalProofSha256, "tenant purge execution physical proof");
  positive(ack.completedClaimAttempt, "tenant purge execution ACK claim attempt");
  digest(ack.completedClaimTokenSha256, "tenant purge execution ACK claim token");
  timestamp(ack.storeDbTimestampMs, "tenant purge execution ACK timestamp");
  if (typeof ack.final !== "boolean") throw new Error("tenant purge execution ACK final flag is invalid");

  const outboxFields = [ack.outboxKind, ack.outboxId, ack.deletionGeneration, ack.targetSha256];
  const hasOutbox = outboxFields.some((value) => value !== undefined);
  if (hasOutbox && outboxFields.some((value) => value === undefined)) {
    throw new Error("tenant purge execution outbox reference is incomplete");
  }
  if (ack.ackKind === "outbox_scheduled" || ack.ackKind === "physical_delete") {
    if (!hasOutbox) throw new Error("tenant purge execution physical ACK lacks an outbox reference");
  } else if (hasOutbox) {
    throw new Error("tenant purge execution non-outbox ACK has an outbox reference");
  }
  if (hasOutbox) {
    tenantPurgeExecutionOutboxTargetSha256({
      outboxKind: ack.outboxKind!,
      outboxId: ack.outboxId!,
      deletionGeneration: ack.deletionGeneration!,
      targetSha256: ack.targetSha256!,
    });
  }
  if (ack.ackKind === "physical_delete") {
    if (ack.scheduledAckSha256 === undefined) {
      throw new Error("tenant purge execution physical ACK lacks its scheduled ACK");
    }
    digest(ack.scheduledAckSha256, "tenant purge execution scheduled ACK");
  } else if (ack.scheduledAckSha256 !== undefined) {
    throw new Error("tenant purge execution non-physical ACK references a scheduled ACK");
  }
  return sha256([
    "tenant-purge-execution-domain-ack-v1",
    ack.scope,
    ack.requestId,
    ack.tenantId,
    ack.subjectGeneration,
    ack.planBuildGeneration,
    ack.executionGeneration,
    ack.domain,
    ack.globalAckSeq,
    ack.domainAckSeq,
    ack.previousDomainAckSha256,
    ack.previousGlobalAckSha256,
    ack.ackKind,
    ack.planEntryReceiptSha256,
    ack.affectedCount,
    ack.resultCount,
    ack.resultRootSha256,
    ack.adapterProtocol,
    ack.operationSha256,
    ack.physicalProofSha256,
    ack.completedClaimAttempt,
    ack.completedClaimTokenSha256,
    ack.storeDbTimestampMs,
    ack.final,
    ack.outboxKind ?? null,
    ack.outboxId ?? null,
    ack.deletionGeneration ?? null,
    ack.targetSha256 ?? null,
    ack.scheduledAckSha256 ?? null,
  ]);
}

export function validateTenantPurgeExecutionDomainAck(ack: TenantPurgeExecutionDomainAck): void {
  exactKeys(ack, [
    "scope", "requestId", "tenantId", "subjectGeneration", "planBuildGeneration",
    "executionGeneration", "domain", "globalAckSeq", "domainAckSeq",
    "previousDomainAckSha256", "previousGlobalAckSha256", "ackKind",
    "planEntryReceiptSha256", "affectedCount", "resultCount", "resultRootSha256",
    "adapterProtocol", "operationSha256", "physicalProofSha256", "completedClaimAttempt",
    "completedClaimTokenSha256", "storeDbTimestampMs", "final",
    ...(ack.outboxKind === undefined ? [] : ["outboxKind"]),
    ...(ack.outboxId === undefined ? [] : ["outboxId"]),
    ...(ack.deletionGeneration === undefined ? [] : ["deletionGeneration"]),
    ...(ack.targetSha256 === undefined ? [] : ["targetSha256"]),
    ...(ack.scheduledAckSha256 === undefined ? [] : ["scheduledAckSha256"]),
    "receiptSha256",
  ], "tenant purge execution domain ACK");
  const expected = tenantPurgeExecutionDomainAckSha256(ack);
  digest(ack.receiptSha256, "tenant purge execution ACK receipt");
  if (ack.receiptSha256 !== expected) throw new Error("tenant purge execution ACK receipt does not match");
}

export function validateTenantPurgeExecutionDomainRecord(
  record: TenantPurgeExecutionDomainRecord,
): void {
  exactKeys(record, [
    "requestId", "tenantId", "subjectGeneration", "planBuildGeneration",
    "executionGeneration", "domain", "executionOrdinal", "planDisposition",
    "planTargetCount", "planTargetRootSha256", "planSourceSha256",
    "planEntryReceiptSha256", "phase", "ackCount", "ackRootSha256",
    ...(record.finalAckSha256 === undefined ? [] : ["finalAckSha256"]), "updatedAtMs",
  ], "tenant purge execution domain");
  validateTenantPurgeExecutionIdentity(record);
  if (record.executionOrdinal !== tenantPurgePlanDomainOrdinal(record.domain)) {
    throw new Error("tenant purge execution domain ordinal is invalid");
  }
  count(record.planTargetCount, "tenant purge execution plan target count");
  digest(record.planTargetRootSha256, "tenant purge execution plan target root");
  digest(record.planSourceSha256, "tenant purge execution plan source");
  digest(record.planEntryReceiptSha256, "tenant purge execution plan entry receipt");
  if (!["pending", "awaiting_blocker_resolution", "awaiting_physical_ack", "acked"].includes(record.phase)) {
    throw new Error("tenant purge execution domain phase is invalid");
  }
  count(record.ackCount, "tenant purge execution domain ACK count");
  digest(record.ackRootSha256, "tenant purge execution domain ACK root");
  timestamp(record.updatedAtMs, "tenant purge execution domain update timestamp");
  if (record.ackCount === 0 && record.ackRootSha256 !== EMPTY_TENANT_PURGE_EXECUTION_DOMAIN_ACK_ROOT_SHA256) {
    throw new Error("empty tenant purge execution domain has a non-empty ACK root");
  }
  if ((record.phase === "acked") !== (record.finalAckSha256 !== undefined)) {
    throw new Error("tenant purge execution final ACK does not match its phase");
  }
  if (record.finalAckSha256 !== undefined) digest(record.finalAckSha256, "tenant purge execution final ACK");
}

const SOURCE_KEYS = [
  "requestId", "tenantId", "subjectGeneration", "planBuildGeneration", "executionGeneration",
  "t3cReceiptSha256", "planReceiptSha256", "planEntryRootSha256", "planBlockerCount",
  "planBlockerRootSha256", "policySha256", "purgeNotBeforeDbMs", "sourceEvidenceDbMs",
] as const;

export function validateTenantPurgeExecutionJobRecord(job: TenantPurgeExecutionJobRecord): void {
  const common = [
    ...SOURCE_KEYS, "phase", "domainCount", "domainAckCount", "domainAckRootSha256",
    "unresolvedBlockerCount", ...(job.localCutoverReceiptSha256 === undefined
      ? [] : ["localCutoverReceiptSha256"]), "attempts", "createdAtMs", "updatedAtMs",
  ];
  if (job.phase === "queued") {
    exactKeys(job, [
      ...common, "availableAtMs", ...(job.claimToken === undefined ? [] : ["claimToken"]),
      ...(job.leaseUntilMs === undefined ? [] : ["leaseUntilMs"]),
      ...(job.lastErrorCode === undefined ? [] : ["lastErrorCode"]),
    ], "queued tenant purge execution job");
  } else if (job.phase === "local_physical_acks_sealed") {
    exactKeys(job, [
      ...common, "localPhysicalAckReceiptSha256", "localPhysicalAcksSealedAtDbMs",
      "completedClaimAttempt", "completedClaimTokenSha256",
    ], "sealed tenant purge execution job");
  } else if (job.phase === "blocked") {
    exactKeys(job, [...common, "blockedAtDbMs", "blockedReasonCode"], "blocked tenant purge execution job");
  } else {
    throw new Error("tenant purge execution job phase is invalid");
  }
  validateTenantPurgeExecutionSource(job);
  if (job.domainCount !== TENANT_PURGE_PLAN_DOMAINS.length) {
    throw new Error("tenant purge execution job does not cover the fixed domain catalog");
  }
  count(job.domainAckCount, "tenant purge execution domain ACK count");
  digest(job.domainAckRootSha256, "tenant purge execution global ACK root");
  count(job.unresolvedBlockerCount, "tenant purge execution unresolved blocker count");
  if (job.unresolvedBlockerCount > job.planBlockerCount) {
    throw new Error("tenant purge execution unresolved blocker count is invalid");
  }
  if (job.localCutoverReceiptSha256 !== undefined) {
    digest(job.localCutoverReceiptSha256, "tenant purge execution local cutover receipt");
  }
  count(job.attempts, "tenant purge execution attempts");
  timestamp(job.createdAtMs, "tenant purge execution creation timestamp");
  timestamp(job.updatedAtMs, "tenant purge execution update timestamp");
  if (job.updatedAtMs < job.createdAtMs) throw new Error("tenant purge execution timestamps are invalid");
  if (job.phase === "queued") {
    timestamp(job.availableAtMs, "tenant purge execution availability");
    if ((job.claimToken === undefined) !== (job.leaseUntilMs === undefined)) {
      throw new Error("tenant purge execution claim is incomplete");
    }
    if (job.claimToken !== undefined) {
      claimToken(job.claimToken);
      timestamp(job.leaseUntilMs!, "tenant purge execution lease");
      if (job.attempts < 1 || job.leaseUntilMs! < job.updatedAtMs) {
        throw new Error("tenant purge execution claim is invalid");
      }
      if (job.lastErrorCode !== undefined) throw new Error("claimed execution retains a retry error");
    } else if (job.availableAtMs < job.updatedAtMs) {
      throw new Error("tenant purge execution availability predates its update");
    }
    if (job.lastErrorCode !== undefined
      && job.lastErrorCode !== "temporary_failure"
      && job.lastErrorCode !== "physical_ack_pending") {
      throw new Error("tenant purge execution retry error is invalid");
    }
    return;
  }
  if (job.phase === "local_physical_acks_sealed") {
    digest(job.localPhysicalAckReceiptSha256, "tenant purge execution local physical receipt");
    timestamp(job.localPhysicalAcksSealedAtDbMs, "tenant purge execution local physical seal time");
    positive(job.completedClaimAttempt, "tenant purge execution completion attempt");
    digest(job.completedClaimTokenSha256, "tenant purge execution completion token");
    if (job.completedClaimAttempt !== job.attempts || job.localCutoverReceiptSha256 === undefined) {
      throw new Error("tenant purge execution terminal proof is invalid");
    }
    return;
  }
  timestamp(job.blockedAtDbMs, "tenant purge execution blocked timestamp");
  if (job.blockedAtDbMs > job.updatedAtMs || job.attempts < 1) {
    throw new Error("tenant purge execution blocked state is invalid");
  }
  if (job.blockedReasonCode !== "integrity_conflict"
    && job.blockedReasonCode !== "physical_ack_dead_lettered") {
    throw new Error("tenant purge execution block reason is invalid");
  }
}

export function validateTenantPurgeExecutionAuthorization(
  authorization: TenantPurgeExecutionAuthorization,
): void {
  exactKeys(authorization, [
    "requestId", "tenantId", "subjectGeneration", "planBuildGeneration",
    "executionGeneration", "claimAttempt", "claimToken",
  ], "tenant purge execution authorization");
  validateTenantPurgeExecutionIdentity(authorization);
  positive(authorization.claimAttempt, "tenant purge execution claim attempt");
  claimToken(authorization.claimToken);
}

export function tenantPurgeExecutionAuthorizationMatches(
  job: TenantPurgeExecutionJobRecord,
  authorization: TenantPurgeExecutionAuthorization,
  databaseNowMs: number,
): boolean {
  validateTenantPurgeExecutionJobRecord(job);
  validateTenantPurgeExecutionAuthorization(authorization);
  timestamp(databaseNowMs, "tenant purge execution database timestamp");
  return job.phase === "queued"
    && job.requestId === authorization.requestId
    && job.tenantId === authorization.tenantId
    && job.subjectGeneration === authorization.subjectGeneration
    && job.planBuildGeneration === authorization.planBuildGeneration
    && job.executionGeneration === authorization.executionGeneration
    && job.attempts === authorization.claimAttempt
    && job.claimToken === authorization.claimToken
    && job.leaseUntilMs !== undefined
    && job.leaseUntilMs > databaseNowMs;
}

export function tenantPurgeExecutionClaimFromJob(
  job: TenantPurgeExecutionJobRecord,
): TenantPurgeExecutionClaim {
  validateTenantPurgeExecutionJobRecord(job);
  if (job.phase !== "queued" || job.claimToken === undefined || job.leaseUntilMs === undefined) {
    throw new Error("tenant purge execution job is not claimed");
  }
  return {
    requestId: job.requestId,
    tenantId: job.tenantId,
    subjectGeneration: job.subjectGeneration,
    planBuildGeneration: job.planBuildGeneration,
    executionGeneration: job.executionGeneration,
    t3cReceiptSha256: job.t3cReceiptSha256,
    planReceiptSha256: job.planReceiptSha256,
    planEntryRootSha256: job.planEntryRootSha256,
    planBlockerCount: job.planBlockerCount,
    planBlockerRootSha256: job.planBlockerRootSha256,
    policySha256: job.policySha256,
    purgeNotBeforeDbMs: job.purgeNotBeforeDbMs,
    sourceEvidenceDbMs: job.sourceEvidenceDbMs,
    phase: "queued",
    claimAttempt: job.attempts,
    claimToken: job.claimToken,
    leaseUntilMs: job.leaseUntilMs,
    localCutoverCommitted: job.localCutoverReceiptSha256 !== undefined,
  };
}

export function validateMaterializeTenantPurgeExecutionJobsOptions(
  options: MaterializeTenantPurgeExecutionJobsOptions,
): void {
  exactKeys(options, ["limit"], "tenant purge execution materialization options");
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new Error("tenant purge execution materialization limit must be between 1 and 100");
  }
}

export function validateClaimTenantPurgeExecutionsOptions(
  options: ClaimTenantPurgeExecutionsOptions,
): void {
  exactKeys(options, ["limit", "leaseMs", "claimToken"], "tenant purge execution claim options");
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new Error("tenant purge execution claim limit must be between 1 and 100");
  }
  positive(options.leaseMs, "tenant purge execution claim lease");
  claimToken(options.claimToken);
}

export function validateRenewTenantPurgeExecutionOptions(
  options: RenewTenantPurgeExecutionOptions,
): void {
  exactKeys(options, ["leaseMs"], "tenant purge execution renewal options");
  positive(options.leaseMs, "tenant purge execution renewal lease");
}

export function validateRetryTenantPurgeExecutionOptions(
  options: RetryTenantPurgeExecutionOptions,
): void {
  exactKeys(options, ["delayMs", "errorCode"], "tenant purge execution retry options");
  timestamp(options.delayMs, "tenant purge execution retry delay");
  if (options.errorCode !== "temporary_failure" && options.errorCode !== "physical_ack_pending") {
    throw new Error("tenant purge execution retry error is invalid");
  }
}

type LocalCutoverBody = Omit<TenantPurgeLocalCutoverReceipt, "receiptSha256">;

export function tenantPurgeLocalCutoverReceiptSha256(receipt: LocalCutoverBody): string {
  validateTenantPurgeExecutionSource(receipt);
  if (receipt.scope !== TENANT_PURGE_LOCAL_CUTOVER_SCOPE) {
    throw new Error("tenant purge local cutover scope is invalid");
  }
  for (const [value, name] of [
    [receipt.operationalUsageTargetCount, "usage target count"],
    [receipt.blobBytesTargetCount, "blob target count"],
    [receipt.blobDeleteOutboxCount, "blob outbox count"],
    [receipt.exportBytesTargetCount, "export target count"],
    [receipt.exportDeleteOutboxCount, "export outbox count"],
    [receipt.domainAckCount, "domain ACK count"],
  ] as const) count(value, `tenant purge local cutover ${name}`);
  for (const [value, name] of [
    [receipt.operationalUsageTargetRootSha256, "usage target root"],
    [receipt.blobBytesTargetRootSha256, "blob target root"],
    [receipt.blobDeleteOutboxRootSha256, "blob outbox root"],
    [receipt.exportBytesTargetRootSha256, "export target root"],
    [receipt.exportDeleteOutboxRootSha256, "export outbox root"],
    [receipt.domainAckRootSha256, "domain ACK root"],
    [receipt.completedClaimTokenSha256, "claim token"],
  ] as const) digest(value, `tenant purge local cutover ${name}`);
  if (receipt.blobDeleteOutboxCount !== receipt.blobBytesTargetCount
    || receipt.exportDeleteOutboxCount !== receipt.exportBytesTargetCount) {
    throw new Error("tenant purge local cutover outbox count does not cover its byte targets");
  }
  timestamp(receipt.storeDbTimestampMs, "tenant purge local cutover timestamp");
  positive(receipt.completedClaimAttempt, "tenant purge local cutover claim attempt");
  if (receipt.localDestructiveProgress !== true || receipt.physicalAcksComplete !== false
    || receipt.allDomainsComplete !== false || receipt.contentPurgeExecuted !== false) {
    throw new Error("tenant purge local cutover flags are invalid");
  }
  return sha256([
    "tenant-purge-local-cutover-v1",
    ...SOURCE_KEYS.map((key) => receipt[key]),
    receipt.operationalUsageTargetCount,
    receipt.operationalUsageTargetRootSha256,
    receipt.blobBytesTargetCount,
    receipt.blobBytesTargetRootSha256,
    receipt.blobDeleteOutboxCount,
    receipt.blobDeleteOutboxRootSha256,
    receipt.exportBytesTargetCount,
    receipt.exportBytesTargetRootSha256,
    receipt.exportDeleteOutboxCount,
    receipt.exportDeleteOutboxRootSha256,
    receipt.domainAckCount,
    receipt.domainAckRootSha256,
    receipt.storeDbTimestampMs,
    receipt.completedClaimAttempt,
    receipt.completedClaimTokenSha256,
    receipt.localDestructiveProgress,
    receipt.physicalAcksComplete,
    receipt.allDomainsComplete,
    receipt.contentPurgeExecuted,
  ]);
}

export function validateTenantPurgeLocalCutoverReceipt(receipt: TenantPurgeLocalCutoverReceipt): void {
  exactKeys(receipt, [
    ...SOURCE_KEYS, "scope", "operationalUsageTargetCount", "operationalUsageTargetRootSha256",
    "blobBytesTargetCount", "blobBytesTargetRootSha256", "blobDeleteOutboxCount",
    "blobDeleteOutboxRootSha256", "exportBytesTargetCount", "exportBytesTargetRootSha256",
    "exportDeleteOutboxCount", "exportDeleteOutboxRootSha256", "domainAckCount",
    "domainAckRootSha256", "storeDbTimestampMs", "completedClaimAttempt",
    "completedClaimTokenSha256", "localDestructiveProgress", "physicalAcksComplete",
    "allDomainsComplete", "contentPurgeExecuted", "receiptSha256",
  ], "tenant purge local cutover receipt");
  const expected = tenantPurgeLocalCutoverReceiptSha256(receipt);
  digest(receipt.receiptSha256, "tenant purge local cutover receipt");
  if (expected !== receipt.receiptSha256) throw new Error("tenant purge local cutover receipt does not match");
}

type LocalPhysicalBody = Omit<TenantPurgeLocalPhysicalAckReceipt, "receiptSha256">;

export function tenantPurgeLocalPhysicalAckReceiptSha256(receipt: LocalPhysicalBody): string {
  validateTenantPurgeExecutionSource(receipt);
  if (receipt.scope !== TENANT_PURGE_LOCAL_PHYSICAL_ACK_SCOPE) {
    throw new Error("tenant purge local physical ACK scope is invalid");
  }
  digest(receipt.localCutoverReceiptSha256, "tenant purge local physical cutover receipt");
  for (const [value, name] of [
    [receipt.blobPhysicalAckCount, "blob ACK count"],
    [receipt.exportPhysicalAckCount, "export ACK count"],
    [receipt.domainAckCount, "domain ACK count"],
    [receipt.unresolvedBlockerCount, "unresolved blocker count"],
  ] as const) count(value, `tenant purge local physical ${name}`);
  for (const [value, name] of [
    [receipt.blobPhysicalAckRootSha256, "blob ACK root"],
    [receipt.exportPhysicalAckRootSha256, "export ACK root"],
    [receipt.domainAckRootSha256, "domain ACK root"],
    [receipt.completedClaimTokenSha256, "claim token"],
  ] as const) digest(value, `tenant purge local physical ${name}`);
  timestamp(receipt.storeDbTimestampMs, "tenant purge local physical timestamp");
  positive(receipt.completedClaimAttempt, "tenant purge local physical claim attempt");
  if (receipt.localPhysicalAcksComplete !== true || receipt.allDomainsComplete !== false
    || receipt.contentPurgeExecuted !== false) {
    throw new Error("tenant purge local physical flags are invalid");
  }
  return sha256([
    "tenant-purge-local-physical-ack-v1",
    ...SOURCE_KEYS.map((key) => receipt[key]),
    receipt.localCutoverReceiptSha256,
    receipt.blobPhysicalAckCount,
    receipt.blobPhysicalAckRootSha256,
    receipt.exportPhysicalAckCount,
    receipt.exportPhysicalAckRootSha256,
    receipt.domainAckCount,
    receipt.domainAckRootSha256,
    receipt.unresolvedBlockerCount,
    receipt.storeDbTimestampMs,
    receipt.completedClaimAttempt,
    receipt.completedClaimTokenSha256,
    receipt.localPhysicalAcksComplete,
    receipt.allDomainsComplete,
    receipt.contentPurgeExecuted,
  ]);
}

export function validateTenantPurgeLocalPhysicalAckReceipt(
  receipt: TenantPurgeLocalPhysicalAckReceipt,
): void {
  exactKeys(receipt, [
    ...SOURCE_KEYS, "scope", "localCutoverReceiptSha256", "blobPhysicalAckCount",
    "blobPhysicalAckRootSha256", "exportPhysicalAckCount", "exportPhysicalAckRootSha256",
    "domainAckCount", "domainAckRootSha256", "unresolvedBlockerCount", "storeDbTimestampMs",
    "completedClaimAttempt", "completedClaimTokenSha256", "localPhysicalAcksComplete",
    "allDomainsComplete", "contentPurgeExecuted", "receiptSha256",
  ], "tenant purge local physical ACK receipt");
  const expected = tenantPurgeLocalPhysicalAckReceiptSha256(receipt);
  digest(receipt.receiptSha256, "tenant purge local physical ACK receipt");
  if (expected !== receipt.receiptSha256) {
    throw new Error("tenant purge local physical ACK receipt does not match");
  }
}

export interface TenantPurgeExecutionStore {
  materializeTenantPurgeExecutionJobs(
    options: MaterializeTenantPurgeExecutionJobsOptions,
  ): Promise<number>;
  claimTenantPurgeExecutions(
    options: ClaimTenantPurgeExecutionsOptions,
  ): Promise<TenantPurgeExecutionClaim[]>;
  renewTenantPurgeExecution(
    authorization: TenantPurgeExecutionAuthorization,
    options: RenewTenantPurgeExecutionOptions,
  ): Promise<boolean>;
  retryTenantPurgeExecution(
    authorization: TenantPurgeExecutionAuthorization,
    options: RetryTenantPurgeExecutionOptions,
  ): Promise<boolean>;
  blockTenantPurgeExecution(
    authorization: TenantPurgeExecutionAuthorization,
    reason?: TenantPurgeExecutionBlockReasonCode,
  ): Promise<boolean>;
  executeTenantPurgeLocalCutover(
    authorization: TenantPurgeExecutionAuthorization,
  ): Promise<TenantPurgeLocalCutoverReceipt | null>;
  sealTenantPurgeLocalPhysicalAcks(
    authorization: TenantPurgeExecutionAuthorization,
  ): Promise<TenantPurgeLocalPhysicalAckReceipt | null>;
  getTenantPurgeExecutionJob(
    tenantId: string,
    requestId: string,
  ): Promise<TenantPurgeExecutionJobRecord | null>;
  getTenantPurgeExecutionDomains(
    tenantId: string,
    requestId: string,
    executionGeneration: number,
  ): Promise<TenantPurgeExecutionDomainRecord[]>;
  getTenantPurgeExecutionDomainAcks(
    tenantId: string,
    requestId: string,
    executionGeneration: number,
  ): Promise<TenantPurgeExecutionDomainAck[]>;
  getTenantPurgeLocalCutoverReceipt(
    tenantId: string,
    requestId: string,
  ): Promise<TenantPurgeLocalCutoverReceipt | null>;
  getTenantPurgeLocalPhysicalAckReceipt(
    tenantId: string,
    requestId: string,
  ): Promise<TenantPurgeLocalPhysicalAckReceipt | null>;
  getTenantPurgeExecutionCutover(): Promise<TenantPurgeExecutionCutoverRecord>;
}
