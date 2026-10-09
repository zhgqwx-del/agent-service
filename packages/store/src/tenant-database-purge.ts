import { createHash } from "node:crypto";
import { isCanonicalId } from "@agent-service/protocol";

export const TENANT_DATABASE_PURGE_PREDELETE_ENTRY_SCOPE =
  "tenant-database-purge-predelete-entry-v1" as const;
export const TENANT_DATABASE_PURGE_PREDELETE_RECEIPT_SCOPE =
  "tenant-database-purge-predelete-v1" as const;
export const TENANT_DATABASE_PURGE_DOMAIN_ACK_SCOPE =
  "tenant-database-purge-domain-ack-v1" as const;
export const TENANT_DATABASE_PURGE_RECEIPT_SCOPE = "tenant-database-purge-v1" as const;
export const TENANT_PURGE_SESSION_GRAVE_MARKER_SCOPE =
  "tenant-purge-session-grave-marker-v1" as const;
export const TENANT_DATABASE_PURGE_CUTOVER_SINGLETON_ID = 1 as const;
export const TENANT_DATABASE_PURGE_ADAPTER_PROTOCOL = "local-database-v1" as const;

/**
 * Closed catalog for the local database content/control cut. This deliberately excludes Redis,
 * external provider/KMS, backup/restore, logs/traces, and the evidence ledgers needed to prove the
 * larger tenant-erasure saga. Adding or removing a domain is therefore a protocol change.
 */
export const TENANT_DATABASE_PURGE_DOMAINS = [
  "tenant_profile",
  "agent_definitions",
  "session_content",
  "idempotency_receipts",
  "billing_reconciliation",
  "blob_manifest",
  "blob_outbox",
  "lifecycle_outbox",
  "user_export_control",
  "user_export_snapshots",
  "user_export_artifacts",
] as const;
export type TenantDatabasePurgeDomain = (typeof TENANT_DATABASE_PURGE_DOMAINS)[number];

export const TENANT_DATABASE_PURGE_ACTIONS = [
  "clear",
  "delete",
  "delete_with_grave_markers",
  "retain_anonymized",
] as const;
export type TenantDatabasePurgeAction = (typeof TENANT_DATABASE_PURGE_ACTIONS)[number];

export const TENANT_DATABASE_PURGE_ACTION_BY_DOMAIN = {
  tenant_profile: "clear",
  agent_definitions: "delete",
  session_content: "delete_with_grave_markers",
  idempotency_receipts: "delete",
  billing_reconciliation: "retain_anonymized",
  blob_manifest: "delete",
  blob_outbox: "delete",
  lifecycle_outbox: "delete",
  user_export_control: "delete",
  user_export_snapshots: "delete",
  user_export_artifacts: "delete",
} as const satisfies Record<TenantDatabasePurgeDomain, TenantDatabasePurgeAction>;

export const TENANT_DATABASE_PURGE_BRIDGE_KINDS = ["direct_plan", "t3e_successor"] as const;
export type TenantDatabasePurgeBridgeKind =
  (typeof TENANT_DATABASE_PURGE_BRIDGE_KINDS)[number];
export const TENANT_DATABASE_PURGE_T3E_SUCCESSOR_DOMAINS = [
  "blob_manifest",
  "blob_outbox",
  "user_export_control",
  "user_export_snapshots",
  "user_export_artifacts",
] as const satisfies readonly TenantDatabasePurgeDomain[];

export type TenantDatabasePurgeJobPhase = "queued" | "database_purged" | "blocked";
export type TenantDatabasePurgeRetryErrorCode = "temporary_failure" | "dependency_pending";
export type TenantDatabasePurgeBlockReasonCode = "integrity_conflict";
export type TenantDatabasePurgeNotReadyReason =
  | "active_legal_hold"
  | "lifecycle_outbox_pending"
  | "physical_projection_pending";

export class TenantDatabasePurgeNotReadyError extends Error {
  constructor(public readonly reason: TenantDatabasePurgeNotReadyReason) {
    super(`tenant database purge is not ready: ${reason}`);
    this.name = "TenantDatabasePurgeNotReadyError";
  }
}

export class TenantDatabasePurgeEvidenceChangedError extends Error {
  constructor() {
    super("tenant database purge source evidence changed");
    this.name = "TenantDatabasePurgeEvidenceChangedError";
  }
}

const REQUEST_ID =
  /^erase_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLAIM_TOKEN = /^[A-Za-z0-9._:~-]{1,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;

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
  if (!value || value.length > 128) throw new Error("invalid tenant database purge tenant id");
}

function userId(value: string): void {
  if (!value || value.length > 128) throw new Error("invalid tenant database purge user id");
}

function claimToken(value: string): void {
  if (!CLAIM_TOKEN.test(value)) throw new Error("invalid tenant database purge claim token");
}

function safeCountSum(values: readonly number[], name: string): number {
  let result = 0;
  for (const value of values) {
    count(value, name);
    result += value;
    if (!Number.isSafeInteger(result)) throw new Error(`${name} exceeds the safe integer range`);
  }
  return result;
}

function validateCanonicalTuple(
  tuple: readonly (string | number | boolean | null)[],
  name: string,
): void {
  for (const value of tuple) {
    if (value === null || typeof value === "string" || typeof value === "boolean") continue;
    if (typeof value === "number" && Number.isSafeInteger(value)) continue;
    if (typeof value === "number") {
      throw new Error(`${name} contains an unsafe integer`);
    }
    throw new Error(`${name} contains a non-canonical value`);
  }
}

export function tenantDatabasePurgeDomainOrdinal(domain: TenantDatabasePurgeDomain): number {
  const ordinal = (TENANT_DATABASE_PURGE_DOMAINS as readonly string[]).indexOf(domain);
  if (ordinal < 0) throw new Error("tenant database purge domain is invalid");
  return ordinal;
}

export function tenantDatabasePurgeBridgeKind(
  domain: TenantDatabasePurgeDomain,
): TenantDatabasePurgeBridgeKind {
  tenantDatabasePurgeDomainOrdinal(domain);
  return (TENANT_DATABASE_PURGE_T3E_SUCCESSOR_DOMAINS as readonly string[]).includes(domain)
    ? "t3e_successor"
    : "direct_plan";
}

export interface TenantDatabasePurgeIdentity {
  requestId: string;
  tenantId: string;
  subjectGeneration: number;
  planBuildGeneration: number;
  executionGeneration: number;
  databasePurgeGeneration: number;
}

/** Exact T3c, T3d, and terminal T3e physical-receipt source binding. */
export interface TenantDatabasePurgeSource extends TenantDatabasePurgeIdentity {
  t3cReceiptSha256: string;
  planReceiptSha256: string;
  localPhysicalAckReceiptSha256: string;
  policySha256: string;
  purgeNotBeforeDbMs: number;
  sourceEvidenceDbMs: number;
}

export function validateTenantDatabasePurgeIdentity(identity: TenantDatabasePurgeIdentity): void {
  if (!REQUEST_ID.test(identity.requestId)) {
    throw new Error("invalid tenant database purge request id");
  }
  tenantId(identity.tenantId);
  positive(identity.subjectGeneration, "tenant database purge subject generation");
  positive(identity.planBuildGeneration, "tenant database purge plan generation");
  positive(identity.executionGeneration, "tenant database purge execution generation");
  positive(identity.databasePurgeGeneration, "tenant database purge generation");
}

export function validateTenantDatabasePurgeSource(source: TenantDatabasePurgeSource): void {
  validateTenantDatabasePurgeIdentity(source);
  for (const [value, name] of [
    [source.t3cReceiptSha256, "T3c receipt"],
    [source.planReceiptSha256, "T3d plan receipt"],
    [source.localPhysicalAckReceiptSha256, "T3e physical ACK receipt"],
    [source.policySha256, "policy"],
  ] as const) digest(value, `tenant database purge ${name}`);
  timestamp(source.purgeNotBeforeDbMs, "tenant database purge deadline");
  timestamp(source.sourceEvidenceDbMs, "tenant database purge source evidence time");
  if (source.sourceEvidenceDbMs < source.purgeNotBeforeDbMs) {
    throw new Error("tenant database purge source evidence predates its deadline");
  }
}

const IDENTITY_KEYS = [
  "requestId",
  "tenantId",
  "subjectGeneration",
  "planBuildGeneration",
  "executionGeneration",
  "databasePurgeGeneration",
] as const;

const SOURCE_KEYS = [
  ...IDENTITY_KEYS,
  "t3cReceiptSha256",
  "planReceiptSha256",
  "localPhysicalAckReceiptSha256",
  "policySha256",
  "purgeNotBeforeDbMs",
  "sourceEvidenceDbMs",
] as const;

function sameTenantDatabasePurgeIdentity(
  left: TenantDatabasePurgeIdentity,
  right: TenantDatabasePurgeIdentity,
): boolean {
  return IDENTITY_KEYS.every((key) => left[key] === right[key]);
}

export interface MaterializeTenantDatabasePurgeJobsOptions { limit: number }
export interface ClaimTenantDatabasePurgesOptions {
  limit: number;
  leaseMs: number;
  claimToken: string;
}
export interface RenewTenantDatabasePurgeOptions { leaseMs: number }
export interface RetryTenantDatabasePurgeOptions {
  delayMs: number;
  errorCode: TenantDatabasePurgeRetryErrorCode;
}

interface TenantDatabasePurgeJobBase extends TenantDatabasePurgeSource {
  phase: TenantDatabasePurgeJobPhase;
  domainCount: number;
  preDeleteEntryCount: number;
  preDeleteEntryRootSha256: string;
  domainAckCount: number;
  domainAckRootSha256: string;
  unresolvedBlockerCount: number;
  attempts: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export type TenantDatabasePurgeJobRecord = TenantDatabasePurgeJobBase & (
  | {
      phase: "queued";
      availableAtMs: number;
      claimToken?: string;
      leaseUntilMs?: number;
      lastErrorCode?: TenantDatabasePurgeRetryErrorCode;
      preDeleteReceiptSha256?: never;
      terminalReceiptSha256?: never;
      purgedAtDbMs?: never;
      completedClaimAttempt?: never;
      completedClaimTokenSha256?: never;
      blockedAtMs?: never;
      blockedReasonCode?: never;
    }
  | {
      phase: "database_purged";
      availableAtMs?: never;
      claimToken?: never;
      leaseUntilMs?: never;
      lastErrorCode?: never;
      preDeleteReceiptSha256: string;
      terminalReceiptSha256: string;
      purgedAtDbMs: number;
      completedClaimAttempt: number;
      completedClaimTokenSha256: string;
      blockedAtMs?: never;
      blockedReasonCode?: never;
    }
  | {
      phase: "blocked";
      availableAtMs?: never;
      claimToken?: never;
      leaseUntilMs?: never;
      lastErrorCode?: never;
      preDeleteReceiptSha256?: never;
      terminalReceiptSha256?: never;
      purgedAtDbMs?: never;
      completedClaimAttempt?: never;
      completedClaimTokenSha256?: never;
      blockedAtMs: number;
      blockedReasonCode: TenantDatabasePurgeBlockReasonCode;
    }
);

export interface TenantDatabasePurgeClaim extends TenantDatabasePurgeSource {
  phase: "queued";
  claimAttempt: number;
  claimToken: string;
  leaseUntilMs: number;
}

export type TenantDatabasePurgeAuthorization = Pick<
  TenantDatabasePurgeClaim,
  | "requestId"
  | "tenantId"
  | "subjectGeneration"
  | "planBuildGeneration"
  | "executionGeneration"
  | "databasePurgeGeneration"
  | "claimAttempt"
  | "claimToken"
>;

export interface TenantDatabasePurgePreDeleteEntry extends TenantDatabasePurgeIdentity {
  scope: typeof TENANT_DATABASE_PURGE_PREDELETE_ENTRY_SCOPE;
  domain: TenantDatabasePurgeDomain;
  domainOrdinal: number;
  action: TenantDatabasePurgeAction;
  planEntryReceiptSha256: string;
  planTargetCount: number;
  planTargetRootSha256: string;
  bridgeKind: TenantDatabasePurgeBridgeKind;
  bridgeSha256: string;
  preDeleteTargetCount: number;
  preDeleteTargetRootSha256: string;
  capturedAtDbMs: number;
  receiptSha256: string;
}

export interface TenantDatabasePurgePreDeleteReceipt extends TenantDatabasePurgeSource {
  scope: typeof TENANT_DATABASE_PURGE_PREDELETE_RECEIPT_SCOPE;
  entryCount: number;
  entryRootSha256: string;
  sessionTargetCount: number;
  sessionTargetRootSha256: string;
  retainedBillingFactCount: number;
  retainedBillingFactRootSha256: string;
  billingReconciliationTargetCount: number;
  billingReconciliationTargetRootSha256: string;
  storeDbTimestampMs: number;
  completedClaimAttempt: number;
  completedClaimTokenSha256: string;
  preDeleteComplete: true;
  destructiveProgress: false;
  contentPurgeExecuted: false;
  receiptSha256: string;
}

export interface TenantDatabasePurgeDomainAck extends TenantDatabasePurgeIdentity {
  scope: typeof TENANT_DATABASE_PURGE_DOMAIN_ACK_SCOPE;
  domain: TenantDatabasePurgeDomain;
  domainOrdinal: number;
  globalAckSeq: number;
  previousGlobalAckSha256: string;
  preDeleteEntryReceiptSha256: string;
  action: TenantDatabasePurgeAction;
  preDeleteTargetCount: number;
  preDeleteTargetRootSha256: string;
  affectedCount: number;
  resultTargetCount: number;
  resultTargetRootSha256: string;
  retainedEvidenceCount: number;
  retainedEvidenceRootSha256: string;
  adapterProtocol: typeof TENANT_DATABASE_PURGE_ADAPTER_PROTOCOL;
  operationSha256: string;
  physicalProofSha256: string;
  completedClaimAttempt: number;
  completedClaimTokenSha256: string;
  storeDbTimestampMs: number;
  receiptSha256: string;
}

export interface TenantDatabasePurgeReceipt extends TenantDatabasePurgeSource {
  scope: typeof TENANT_DATABASE_PURGE_RECEIPT_SCOPE;
  preDeleteReceiptSha256: string;
  preDeleteEntryCount: number;
  preDeleteEntryRootSha256: string;
  domainAckCount: number;
  domainAckRootSha256: string;
  graveMarkerCount: number;
  graveMarkerRootSha256: string;
  retainedBillingFactCount: number;
  retainedBillingFactRootSha256: string;
  billingReconciliationEvidenceCount: number;
  billingReconciliationEvidenceRootSha256: string;
  unresolvedBlockerCount: number;
  storeDbTimestampMs: number;
  completedClaimAttempt: number;
  completedClaimTokenSha256: string;
  localDatabasePurgeComplete: true;
  sessionContentDeleted: true;
  allDomainsComplete: false;
  contentPurgeExecuted: false;
  receiptSha256: string;
}

export interface TenantDatabasePurgeEvidenceBundle {
  preDeleteEntries: readonly TenantDatabasePurgePreDeleteEntry[];
  preDeleteReceipt: TenantDatabasePurgePreDeleteReceipt;
  domainAcks: readonly TenantDatabasePurgeDomainAck[];
  graveMarkers: readonly TenantPurgeSessionGraveMarker[];
  receipt: TenantDatabasePurgeReceipt;
}

export interface TenantPurgeSessionGraveOwner {
  tenantId: string;
  userId: string;
  sessionId: string;
}

export interface TenantPurgeSessionGraveMarker extends TenantDatabasePurgeIdentity {
  scope: typeof TENANT_PURGE_SESSION_GRAVE_MARKER_SCOPE;
  sessionId: string;
  deletionGeneration: number;
  deletedAtDbMs: number;
  ownerSha256: string;
  t3cSessionReceiptSha256: string;
  preDeleteReceiptSha256: string;
  markedAtDbMs: number;
  markerSha256: string;
}

export type TenantDatabasePurgeCutoverRecord =
  | {
      singletonId: typeof TENANT_DATABASE_PURGE_CUTOVER_SINGLETON_ID;
      controlGeneration: 0;
    }
  | {
      singletonId: typeof TENANT_DATABASE_PURGE_CUTOVER_SINGLETON_ID;
      controlGeneration: 1;
      activatedAtDbMs: number;
      firstRequestId: string;
      firstReceiptSha256: string;
      evidenceSha256: string;
    };

export const EMPTY_TENANT_DATABASE_PURGE_TARGET_ROOT_SHA256 = sha256([
  "tenant-database-purge-target-root-v1",
]);
export const EMPTY_TENANT_DATABASE_PURGE_PREDELETE_ENTRY_ROOT_SHA256 = sha256([
  "tenant-database-purge-predelete-entry-chain-v1",
]);
export const EMPTY_TENANT_DATABASE_PURGE_DOMAIN_ACK_ROOT_SHA256 = sha256([
  "tenant-database-purge-domain-ack-chain-v1",
]);
export const EMPTY_TENANT_PURGE_SESSION_GRAVE_MARKER_ROOT_SHA256 = sha256([
  "tenant-purge-session-grave-marker-root-v1",
]);

export function tenantDatabasePurgeClaimTokenSha256(value: string): string {
  claimToken(value);
  return sha256(["tenant-database-purge-claim-token-v1", value]);
}

/** Hash one content-free canonical target tuple before aggregate publication. */
export function tenantDatabasePurgeTargetSha256(
  domain: TenantDatabasePurgeDomain,
  canonicalTuple: readonly (string | number | boolean | null)[],
): string {
  tenantDatabasePurgeDomainOrdinal(domain);
  validateCanonicalTuple(canonicalTuple, "tenant database purge target");
  return sha256(["tenant-database-purge-target-v1", domain, canonicalTuple]);
}

export function tenantDatabasePurgeTargetRootSha256(
  domain: TenantDatabasePurgeDomain,
  targetSha256s: readonly string[],
): string {
  tenantDatabasePurgeDomainOrdinal(domain);
  for (const value of targetSha256s) digest(value, "tenant database purge target hash");
  const ordered = [...targetSha256s].sort();
  if (new Set(ordered).size !== ordered.length) {
    throw new Error("tenant database purge target hash is duplicated");
  }
  return sha256(["tenant-database-purge-target-root-v1", domain, ...ordered]);
}

export type TenantDatabasePurgeBridgeInput =
  | {
      bridgeKind: "direct_plan";
      domain: TenantDatabasePurgeDomain;
      planEntryReceiptSha256: string;
      planTargetCount: number;
      planTargetRootSha256: string;
      preDeleteTargetCount: number;
      preDeleteTargetRootSha256: string;
    }
  | {
      bridgeKind: "t3e_successor";
      domain: TenantDatabasePurgeDomain;
      planEntryReceiptSha256: string;
      planTargetCount: number;
      planTargetRootSha256: string;
      localPhysicalAckReceiptSha256: string;
      preDeleteTargetCount: number;
      preDeleteTargetRootSha256: string;
    };

export function tenantDatabasePurgeBridgeSha256(
  input: TenantDatabasePurgeBridgeInput,
): string {
  exactKeys(input, [
    "bridgeKind",
    "domain",
    "planEntryReceiptSha256",
    "planTargetCount",
    "planTargetRootSha256",
    "preDeleteTargetCount",
    "preDeleteTargetRootSha256",
    ...(input.bridgeKind === "t3e_successor" ? [
      "localPhysicalAckReceiptSha256",
    ] : []),
  ], "tenant database purge bridge input");
  if (input.bridgeKind !== tenantDatabasePurgeBridgeKind(input.domain)) {
    throw new Error("tenant database purge bridge kind does not match its domain");
  }
  digest(input.planEntryReceiptSha256, "tenant database purge bridge plan entry receipt");
  count(input.planTargetCount, "tenant database purge bridge plan target count");
  digest(input.planTargetRootSha256, "tenant database purge bridge plan target root");
  count(input.preDeleteTargetCount, "tenant database purge bridge pre-delete target count");
  digest(input.preDeleteTargetRootSha256, "tenant database purge bridge pre-delete target root");
  if (input.bridgeKind === "direct_plan") {
    return sha256([
      "tenant-database-purge-direct-plan-bridge-v1",
      input.domain,
      input.planEntryReceiptSha256,
      input.planTargetCount,
      input.planTargetRootSha256,
      input.preDeleteTargetCount,
      input.preDeleteTargetRootSha256,
    ]);
  }
  digest(
    input.localPhysicalAckReceiptSha256,
    "tenant database purge bridge local physical ACK receipt",
  );
  return sha256([
    "tenant-database-purge-t3e-successor-bridge-v1",
    input.domain,
    input.planEntryReceiptSha256,
    input.planTargetCount,
    input.planTargetRootSha256,
    input.localPhysicalAckReceiptSha256,
    input.preDeleteTargetCount,
    input.preDeleteTargetRootSha256,
  ]);
}

export function tenantDatabasePurgeRetainedEvidenceRootSha256(
  domain: TenantDatabasePurgeDomain,
  evidenceSha256s: readonly string[],
): string {
  tenantDatabasePurgeDomainOrdinal(domain);
  for (const value of evidenceSha256s) {
    digest(value, "tenant database purge retained evidence hash");
  }
  const ordered = [...evidenceSha256s].sort();
  if (new Set(ordered).size !== ordered.length) {
    throw new Error("tenant database purge retained evidence hash is duplicated");
  }
  return sha256(["tenant-database-purge-retained-evidence-root-v1", domain, ...ordered]);
}

export function tenantDatabasePurgeBillingFactRootSha256(
  factSha256s: readonly string[],
): string {
  for (const value of factSha256s) digest(value, "tenant database purge billing fact hash");
  const ordered = [...factSha256s].sort();
  if (new Set(ordered).size !== ordered.length) {
    throw new Error("tenant database purge billing fact hash is duplicated");
  }
  return sha256(["tenant-database-purge-billing-fact-root-v1", ...ordered]);
}

export function tenantDatabasePurgeOperationSha256(input: {
  identity: TenantDatabasePurgeIdentity;
  domain: TenantDatabasePurgeDomain;
  action: TenantDatabasePurgeAction;
  preDeleteTargetCount: number;
  preDeleteTargetRootSha256: string;
  affectedCount: number;
  resultTargetCount: number;
  resultTargetRootSha256: string;
  retainedEvidenceCount: number;
  retainedEvidenceRootSha256: string;
}): string {
  validateTenantDatabasePurgeIdentity(input.identity);
  tenantDatabasePurgeDomainOrdinal(input.domain);
  if (input.action !== TENANT_DATABASE_PURGE_ACTION_BY_DOMAIN[input.domain]) {
    throw new Error("tenant database purge operation action is invalid");
  }
  count(input.preDeleteTargetCount, "tenant database purge operation pre-delete count");
  digest(input.preDeleteTargetRootSha256, "tenant database purge operation pre-delete root");
  count(input.affectedCount, "tenant database purge operation affected count");
  count(input.resultTargetCount, "tenant database purge operation result count");
  digest(input.resultTargetRootSha256, "tenant database purge operation result root");
  count(input.retainedEvidenceCount, "tenant database purge operation retained evidence count");
  digest(input.retainedEvidenceRootSha256, "tenant database purge operation retained evidence root");
  return sha256([
    "tenant-database-purge-operation-v1",
    ...IDENTITY_KEYS.map((key) => input.identity[key]),
    input.domain,
    input.action,
    input.preDeleteTargetCount,
    input.preDeleteTargetRootSha256,
    input.affectedCount,
    input.resultTargetCount,
    input.resultTargetRootSha256,
    input.retainedEvidenceCount,
    input.retainedEvidenceRootSha256,
  ]);
}

export function tenantDatabasePurgePhysicalProofSha256(input: {
  identity: TenantDatabasePurgeIdentity;
  domain: TenantDatabasePurgeDomain;
  action: TenantDatabasePurgeAction;
  adapterProtocol: typeof TENANT_DATABASE_PURGE_ADAPTER_PROTOCOL;
  previousGlobalAckSha256: string;
  preDeleteEntryReceiptSha256: string;
  operationSha256: string;
  storeDbTimestampMs: number;
  completedClaimAttempt: number;
  completedClaimTokenSha256: string;
}): string {
  validateTenantDatabasePurgeIdentity(input.identity);
  tenantDatabasePurgeDomainOrdinal(input.domain);
  if (input.action !== TENANT_DATABASE_PURGE_ACTION_BY_DOMAIN[input.domain]) {
    throw new Error("tenant database purge physical proof action is invalid");
  }
  if (input.adapterProtocol !== TENANT_DATABASE_PURGE_ADAPTER_PROTOCOL) {
    throw new Error("tenant database purge physical proof adapter protocol is invalid");
  }
  digest(input.previousGlobalAckSha256, "tenant database purge physical proof previous ACK");
  digest(
    input.preDeleteEntryReceiptSha256,
    "tenant database purge physical proof pre-delete entry receipt",
  );
  digest(input.operationSha256, "tenant database purge physical proof operation");
  timestamp(input.storeDbTimestampMs, "tenant database purge physical proof timestamp");
  positive(input.completedClaimAttempt, "tenant database purge physical proof claim attempt");
  digest(
    input.completedClaimTokenSha256,
    "tenant database purge physical proof claim token",
  );
  return sha256([
    "tenant-database-purge-physical-proof-v1",
    ...IDENTITY_KEYS.map((key) => input.identity[key]),
    input.domain,
    input.action,
    input.adapterProtocol,
    input.previousGlobalAckSha256,
    input.preDeleteEntryReceiptSha256,
    input.operationSha256,
    input.storeDbTimestampMs,
    input.completedClaimAttempt,
    input.completedClaimTokenSha256,
  ]);
}

type PreDeleteEntryBody = Omit<TenantDatabasePurgePreDeleteEntry, "receiptSha256">;

export function tenantDatabasePurgePreDeleteEntrySha256(entry: PreDeleteEntryBody): string {
  validateTenantDatabasePurgeIdentity(entry);
  if (entry.scope !== TENANT_DATABASE_PURGE_PREDELETE_ENTRY_SCOPE) {
    throw new Error("tenant database purge pre-delete entry scope is invalid");
  }
  const ordinal = tenantDatabasePurgeDomainOrdinal(entry.domain);
  if (entry.domainOrdinal !== ordinal) {
    throw new Error("tenant database purge pre-delete entry ordinal is invalid");
  }
  if (entry.action !== TENANT_DATABASE_PURGE_ACTION_BY_DOMAIN[entry.domain]) {
    throw new Error("tenant database purge pre-delete entry action is invalid");
  }
  digest(entry.planEntryReceiptSha256, "tenant database purge plan entry receipt");
  count(entry.planTargetCount, "tenant database purge plan target count");
  digest(entry.planTargetRootSha256, "tenant database purge plan target root");
  if (!(TENANT_DATABASE_PURGE_BRIDGE_KINDS as readonly string[]).includes(entry.bridgeKind)) {
    throw new Error("tenant database purge pre-delete bridge kind is invalid");
  }
  if (entry.bridgeKind !== tenantDatabasePurgeBridgeKind(entry.domain)) {
    throw new Error("tenant database purge pre-delete bridge kind does not match its domain");
  }
  digest(entry.bridgeSha256, "tenant database purge pre-delete bridge");
  count(entry.preDeleteTargetCount, "tenant database purge pre-delete target count");
  digest(entry.preDeleteTargetRootSha256, "tenant database purge pre-delete target root");
  if (entry.preDeleteTargetCount === 0
    && entry.preDeleteTargetRootSha256 !== tenantDatabasePurgeTargetRootSha256(entry.domain, [])) {
    throw new Error("empty tenant database purge pre-delete entry has a non-empty target root");
  }
  if (entry.bridgeKind === "direct_plan") {
    const expectedBridgeSha256 = tenantDatabasePurgeBridgeSha256({
      bridgeKind: entry.bridgeKind,
      domain: entry.domain,
      planEntryReceiptSha256: entry.planEntryReceiptSha256,
      planTargetCount: entry.planTargetCount,
      planTargetRootSha256: entry.planTargetRootSha256,
      preDeleteTargetCount: entry.preDeleteTargetCount,
      preDeleteTargetRootSha256: entry.preDeleteTargetRootSha256,
    });
    if (entry.bridgeSha256 !== expectedBridgeSha256) {
      throw new Error("tenant database purge pre-delete bridge hash does not match");
    }
  }
  timestamp(entry.capturedAtDbMs, "tenant database purge pre-delete capture time");
  return sha256([
    "tenant-database-purge-predelete-entry-v1",
    entry.scope,
    ...IDENTITY_KEYS.map((key) => entry[key]),
    entry.domain,
    entry.domainOrdinal,
    entry.action,
    entry.planEntryReceiptSha256,
    entry.planTargetCount,
    entry.planTargetRootSha256,
    entry.bridgeKind,
    entry.bridgeSha256,
    entry.preDeleteTargetCount,
    entry.preDeleteTargetRootSha256,
    entry.capturedAtDbMs,
  ]);
}

export function validateTenantDatabasePurgePreDeleteEntry(
  entry: TenantDatabasePurgePreDeleteEntry,
): void {
  exactKeys(entry, [
    ...IDENTITY_KEYS,
    "scope",
    "domain",
    "domainOrdinal",
    "action",
    "planEntryReceiptSha256",
    "planTargetCount",
    "planTargetRootSha256",
    "bridgeKind",
    "bridgeSha256",
    "preDeleteTargetCount",
    "preDeleteTargetRootSha256",
    "capturedAtDbMs",
    "receiptSha256",
  ], "tenant database purge pre-delete entry");
  const expected = tenantDatabasePurgePreDeleteEntrySha256(entry);
  digest(entry.receiptSha256, "tenant database purge pre-delete entry receipt");
  if (entry.receiptSha256 !== expected) {
    throw new Error("tenant database purge pre-delete entry receipt does not match");
  }
}

export function validateTenantDatabasePurgePreDeleteEntryAgainstSource(
  entry: TenantDatabasePurgePreDeleteEntry,
  source: TenantDatabasePurgeSource,
): void {
  validateTenantDatabasePurgePreDeleteEntry(entry);
  validateTenantDatabasePurgeSource(source);
  if (!IDENTITY_KEYS.every((key) => entry[key] === source[key])) {
    throw new Error("tenant database purge pre-delete entry source identity does not match");
  }
  if (entry.capturedAtDbMs < source.sourceEvidenceDbMs) {
    throw new Error("tenant database purge pre-delete entry predates source evidence");
  }
  const expectedBridgeSha256 = tenantDatabasePurgeBridgeSha256(
    entry.bridgeKind === "direct_plan"
      ? {
          bridgeKind: entry.bridgeKind,
          domain: entry.domain,
          planEntryReceiptSha256: entry.planEntryReceiptSha256,
          planTargetCount: entry.planTargetCount,
          planTargetRootSha256: entry.planTargetRootSha256,
          preDeleteTargetCount: entry.preDeleteTargetCount,
          preDeleteTargetRootSha256: entry.preDeleteTargetRootSha256,
        }
      : {
          bridgeKind: entry.bridgeKind,
          domain: entry.domain,
          planEntryReceiptSha256: entry.planEntryReceiptSha256,
          planTargetCount: entry.planTargetCount,
          planTargetRootSha256: entry.planTargetRootSha256,
          localPhysicalAckReceiptSha256: source.localPhysicalAckReceiptSha256,
          preDeleteTargetCount: entry.preDeleteTargetCount,
          preDeleteTargetRootSha256: entry.preDeleteTargetRootSha256,
        },
  );
  if (entry.bridgeSha256 !== expectedBridgeSha256) {
    throw new Error("tenant database purge pre-delete bridge hash does not match its source");
  }
}

export function tenantDatabasePurgeNextPreDeleteEntryRootSha256(
  previousRootSha256: string,
  domain: TenantDatabasePurgeDomain,
  receiptSha256: string,
): string {
  digest(previousRootSha256, "tenant database purge previous pre-delete entry root");
  tenantDatabasePurgeDomainOrdinal(domain);
  digest(receiptSha256, "tenant database purge pre-delete entry receipt");
  return sha256([
    "tenant-database-purge-predelete-entry-chain-v1",
    previousRootSha256,
    domain,
    receiptSha256,
  ]);
}

export function tenantDatabasePurgePreDeleteEntryRootSha256(
  entries: readonly TenantDatabasePurgePreDeleteEntry[],
): string {
  const ordered = [...entries].sort((left, right) => left.domainOrdinal - right.domainOrdinal);
  const domains = new Set<TenantDatabasePurgeDomain>();
  const first = ordered[0];
  let root = EMPTY_TENANT_DATABASE_PURGE_PREDELETE_ENTRY_ROOT_SHA256;
  for (const entry of ordered) {
    validateTenantDatabasePurgePreDeleteEntry(entry);
    if (first !== undefined && (!sameTenantDatabasePurgeIdentity(first, entry)
      || entry.capturedAtDbMs !== first.capturedAtDbMs)) {
      throw new Error("tenant database purge pre-delete entries do not share one atomic source");
    }
    if (domains.has(entry.domain)) throw new Error("tenant database purge pre-delete domain is duplicated");
    domains.add(entry.domain);
    root = tenantDatabasePurgeNextPreDeleteEntryRootSha256(root, entry.domain, entry.receiptSha256);
  }
  return root;
}

type PreDeleteReceiptBody = Omit<TenantDatabasePurgePreDeleteReceipt, "receiptSha256">;

export function tenantDatabasePurgePreDeleteReceiptSha256(
  receipt: PreDeleteReceiptBody,
): string {
  validateTenantDatabasePurgeSource(receipt);
  if (receipt.scope !== TENANT_DATABASE_PURGE_PREDELETE_RECEIPT_SCOPE) {
    throw new Error("tenant database purge pre-delete receipt scope is invalid");
  }
  count(receipt.entryCount, "tenant database purge pre-delete entry count");
  if (receipt.entryCount !== TENANT_DATABASE_PURGE_DOMAINS.length) {
    throw new Error("tenant database purge pre-delete receipt does not cover the fixed catalog");
  }
  digest(receipt.entryRootSha256, "tenant database purge pre-delete entry root");
  count(receipt.sessionTargetCount, "tenant database purge pre-delete session target count");
  digest(receipt.sessionTargetRootSha256, "tenant database purge session target root");
  if (receipt.sessionTargetCount === 0
    && receipt.sessionTargetRootSha256
      !== tenantDatabasePurgeTargetRootSha256("session_content", [])) {
    throw new Error("empty tenant database purge session target set has a non-empty root");
  }
  count(receipt.retainedBillingFactCount, "tenant database purge retained billing fact count");
  digest(receipt.retainedBillingFactRootSha256, "tenant database purge retained billing fact root");
  if (receipt.retainedBillingFactCount === 0
    && receipt.retainedBillingFactRootSha256 !== tenantDatabasePurgeBillingFactRootSha256([])) {
    throw new Error("empty tenant database purge billing fact set has a non-empty root");
  }
  count(
    receipt.billingReconciliationTargetCount,
    "tenant database purge billing reconciliation target count",
  );
  digest(
    receipt.billingReconciliationTargetRootSha256,
    "tenant database purge billing reconciliation target root",
  );
  if (receipt.billingReconciliationTargetCount === 0
    && receipt.billingReconciliationTargetRootSha256
      !== tenantDatabasePurgeTargetRootSha256("billing_reconciliation", [])) {
    throw new Error("empty billing reconciliation target set has a non-empty root");
  }
  timestamp(receipt.storeDbTimestampMs, "tenant database purge pre-delete timestamp");
  if (receipt.storeDbTimestampMs < receipt.sourceEvidenceDbMs) {
    throw new Error("tenant database purge pre-delete capture predates source evidence");
  }
  positive(receipt.completedClaimAttempt, "tenant database purge pre-delete claim attempt");
  digest(receipt.completedClaimTokenSha256, "tenant database purge pre-delete claim token");
  if (receipt.preDeleteComplete !== true || receipt.destructiveProgress !== false
    || receipt.contentPurgeExecuted !== false) {
    throw new Error("tenant database purge pre-delete receipt flags are invalid");
  }
  return sha256([
    "tenant-database-purge-predelete-v1",
    receipt.scope,
    ...SOURCE_KEYS.map((key) => receipt[key]),
    receipt.entryCount,
    receipt.entryRootSha256,
    receipt.sessionTargetCount,
    receipt.sessionTargetRootSha256,
    receipt.retainedBillingFactCount,
    receipt.retainedBillingFactRootSha256,
    receipt.billingReconciliationTargetCount,
    receipt.billingReconciliationTargetRootSha256,
    receipt.storeDbTimestampMs,
    receipt.completedClaimAttempt,
    receipt.completedClaimTokenSha256,
    receipt.preDeleteComplete,
    receipt.destructiveProgress,
    receipt.contentPurgeExecuted,
  ]);
}

export function validateTenantDatabasePurgePreDeleteReceipt(
  receipt: TenantDatabasePurgePreDeleteReceipt,
): void {
  exactKeys(receipt, [
    ...SOURCE_KEYS,
    "scope",
    "entryCount",
    "entryRootSha256",
    "sessionTargetCount",
    "sessionTargetRootSha256",
    "retainedBillingFactCount",
    "retainedBillingFactRootSha256",
    "billingReconciliationTargetCount",
    "billingReconciliationTargetRootSha256",
    "storeDbTimestampMs",
    "completedClaimAttempt",
    "completedClaimTokenSha256",
    "preDeleteComplete",
    "destructiveProgress",
    "contentPurgeExecuted",
    "receiptSha256",
  ], "tenant database purge pre-delete receipt");
  const expected = tenantDatabasePurgePreDeleteReceiptSha256(receipt);
  digest(receipt.receiptSha256, "tenant database purge pre-delete receipt");
  if (receipt.receiptSha256 !== expected) {
    throw new Error("tenant database purge pre-delete receipt does not match");
  }
}

type DomainAckBody = Omit<TenantDatabasePurgeDomainAck, "receiptSha256">;

export function tenantDatabasePurgeDomainAckSha256(ack: DomainAckBody): string {
  validateTenantDatabasePurgeIdentity(ack);
  if (ack.scope !== TENANT_DATABASE_PURGE_DOMAIN_ACK_SCOPE) {
    throw new Error("tenant database purge domain ACK scope is invalid");
  }
  const ordinal = tenantDatabasePurgeDomainOrdinal(ack.domain);
  if (ack.domainOrdinal !== ordinal || ack.globalAckSeq !== ordinal + 1) {
    throw new Error("tenant database purge domain ACK order is invalid");
  }
  if (ack.action !== TENANT_DATABASE_PURGE_ACTION_BY_DOMAIN[ack.domain]) {
    throw new Error("tenant database purge domain ACK action is invalid");
  }
  digest(ack.previousGlobalAckSha256, "tenant database purge previous ACK root");
  digest(ack.preDeleteEntryReceiptSha256, "tenant database purge pre-delete entry receipt");
  count(ack.preDeleteTargetCount, "tenant database purge pre-delete target count");
  digest(ack.preDeleteTargetRootSha256, "tenant database purge pre-delete target root");
  count(ack.affectedCount, "tenant database purge affected count");
  if (ack.affectedCount !== ack.preDeleteTargetCount) {
    throw new Error("tenant database purge affected count does not match pre-delete evidence");
  }
  count(ack.resultTargetCount, "tenant database purge result target count");
  digest(ack.resultTargetRootSha256, "tenant database purge result target root");
  if (ack.resultTargetCount === 0
    && ack.resultTargetRootSha256 !== tenantDatabasePurgeTargetRootSha256(ack.domain, [])) {
    throw new Error("empty tenant database purge result has a non-empty target root");
  }
  count(ack.retainedEvidenceCount, "tenant database purge retained evidence count");
  digest(ack.retainedEvidenceRootSha256, "tenant database purge retained evidence root");
  if (ack.action !== "delete_with_grave_markers" && ack.retainedEvidenceCount === 0
    && ack.retainedEvidenceRootSha256
      !== tenantDatabasePurgeRetainedEvidenceRootSha256(ack.domain, [])) {
    throw new Error("empty tenant database purge retained evidence has a non-empty root");
  }
  if (ack.action === "clear") {
    if (ack.resultTargetCount !== 1 || ack.retainedEvidenceCount !== 0) {
      throw new Error("tenant database purge clear ACK result is invalid");
    }
  } else if (ack.action === "retain_anonymized") {
    const expectedEvidenceCount = ack.preDeleteTargetCount === 0 ? 0 : 1;
    if (ack.resultTargetCount !== 0 || ack.retainedEvidenceCount !== expectedEvidenceCount) {
      throw new Error("tenant database purge anonymized ACK result is invalid");
    }
  } else if (ack.action === "delete_with_grave_markers") {
    if (ack.resultTargetCount !== 0
      || ack.retainedEvidenceCount !== ack.preDeleteTargetCount) {
      throw new Error("tenant database purge session-delete ACK result is invalid");
    }
  } else if (ack.resultTargetCount !== 0 || ack.retainedEvidenceCount !== 0) {
    throw new Error("tenant database purge delete ACK result is invalid");
  }
  if (ack.adapterProtocol !== TENANT_DATABASE_PURGE_ADAPTER_PROTOCOL) {
    throw new Error("tenant database purge adapter protocol is invalid");
  }
  digest(ack.operationSha256, "tenant database purge operation");
  const expectedOperationSha256 = tenantDatabasePurgeOperationSha256({
    identity: ack,
    domain: ack.domain,
    action: ack.action,
    preDeleteTargetCount: ack.preDeleteTargetCount,
    preDeleteTargetRootSha256: ack.preDeleteTargetRootSha256,
    affectedCount: ack.affectedCount,
    resultTargetCount: ack.resultTargetCount,
    resultTargetRootSha256: ack.resultTargetRootSha256,
    retainedEvidenceCount: ack.retainedEvidenceCount,
    retainedEvidenceRootSha256: ack.retainedEvidenceRootSha256,
  });
  if (ack.operationSha256 !== expectedOperationSha256) {
    throw new Error("tenant database purge operation hash does not match");
  }
  digest(ack.physicalProofSha256, "tenant database purge physical proof");
  positive(ack.completedClaimAttempt, "tenant database purge ACK claim attempt");
  digest(ack.completedClaimTokenSha256, "tenant database purge ACK claim token");
  timestamp(ack.storeDbTimestampMs, "tenant database purge ACK timestamp");
  const expectedPhysicalProofSha256 = tenantDatabasePurgePhysicalProofSha256({
    identity: ack,
    domain: ack.domain,
    action: ack.action,
    adapterProtocol: ack.adapterProtocol,
    previousGlobalAckSha256: ack.previousGlobalAckSha256,
    preDeleteEntryReceiptSha256: ack.preDeleteEntryReceiptSha256,
    operationSha256: ack.operationSha256,
    storeDbTimestampMs: ack.storeDbTimestampMs,
    completedClaimAttempt: ack.completedClaimAttempt,
    completedClaimTokenSha256: ack.completedClaimTokenSha256,
  });
  if (ack.physicalProofSha256 !== expectedPhysicalProofSha256) {
    throw new Error("tenant database purge physical proof hash does not match");
  }
  return sha256([
    "tenant-database-purge-domain-ack-v1",
    ack.scope,
    ...IDENTITY_KEYS.map((key) => ack[key]),
    ack.domain,
    ack.domainOrdinal,
    ack.globalAckSeq,
    ack.previousGlobalAckSha256,
    ack.preDeleteEntryReceiptSha256,
    ack.action,
    ack.preDeleteTargetCount,
    ack.preDeleteTargetRootSha256,
    ack.affectedCount,
    ack.resultTargetCount,
    ack.resultTargetRootSha256,
    ack.retainedEvidenceCount,
    ack.retainedEvidenceRootSha256,
    ack.adapterProtocol,
    ack.operationSha256,
    ack.physicalProofSha256,
    ack.completedClaimAttempt,
    ack.completedClaimTokenSha256,
    ack.storeDbTimestampMs,
  ]);
}

export function validateTenantDatabasePurgeDomainAck(ack: TenantDatabasePurgeDomainAck): void {
  exactKeys(ack, [
    ...IDENTITY_KEYS,
    "scope",
    "domain",
    "domainOrdinal",
    "globalAckSeq",
    "previousGlobalAckSha256",
    "preDeleteEntryReceiptSha256",
    "action",
    "preDeleteTargetCount",
    "preDeleteTargetRootSha256",
    "affectedCount",
    "resultTargetCount",
    "resultTargetRootSha256",
    "retainedEvidenceCount",
    "retainedEvidenceRootSha256",
    "adapterProtocol",
    "operationSha256",
    "physicalProofSha256",
    "completedClaimAttempt",
    "completedClaimTokenSha256",
    "storeDbTimestampMs",
    "receiptSha256",
  ], "tenant database purge domain ACK");
  const expected = tenantDatabasePurgeDomainAckSha256(ack);
  digest(ack.receiptSha256, "tenant database purge domain ACK receipt");
  if (ack.receiptSha256 !== expected) {
    throw new Error("tenant database purge domain ACK receipt does not match");
  }
}

export function tenantDatabasePurgeNextDomainAckRootSha256(
  previousRootSha256: string,
  globalAckSeq: number,
  domain: TenantDatabasePurgeDomain,
  receiptSha256: string,
): string {
  digest(previousRootSha256, "tenant database purge previous ACK root");
  positive(globalAckSeq, "tenant database purge ACK sequence");
  tenantDatabasePurgeDomainOrdinal(domain);
  digest(receiptSha256, "tenant database purge ACK receipt");
  return sha256([
    "tenant-database-purge-domain-ack-chain-v1",
    previousRootSha256,
    globalAckSeq,
    domain,
    receiptSha256,
  ]);
}

export function tenantDatabasePurgeDomainAckRootSha256(
  acks: readonly TenantDatabasePurgeDomainAck[],
): string {
  const ordered = [...acks].sort((left, right) => left.globalAckSeq - right.globalAckSeq);
  const domains = new Set<TenantDatabasePurgeDomain>();
  const first = ordered[0];
  let root = EMPTY_TENANT_DATABASE_PURGE_DOMAIN_ACK_ROOT_SHA256;
  for (const ack of ordered) {
    validateTenantDatabasePurgeDomainAck(ack);
    if (first !== undefined && (!sameTenantDatabasePurgeIdentity(first, ack)
      || ack.completedClaimAttempt !== first.completedClaimAttempt
      || ack.completedClaimTokenSha256 !== first.completedClaimTokenSha256
      || ack.storeDbTimestampMs !== first.storeDbTimestampMs)) {
      throw new Error("tenant database purge ACKs do not share one atomic authorization");
    }
    if (domains.has(ack.domain)) throw new Error("tenant database purge ACK domain is duplicated");
    if (ack.globalAckSeq !== domains.size + 1) {
      throw new Error("tenant database purge ACK sequence is discontinuous");
    }
    domains.add(ack.domain);
    if (ack.previousGlobalAckSha256 !== root) {
      throw new Error("tenant database purge ACK chain is discontinuous");
    }
    root = tenantDatabasePurgeNextDomainAckRootSha256(
      root,
      ack.globalAckSeq,
      ack.domain,
      ack.receiptSha256,
    );
  }
  return root;
}

export function tenantDatabasePurgeSessionGraveOwnerSha256(
  owner: TenantPurgeSessionGraveOwner,
): string {
  exactKeys(owner, ["tenantId", "userId", "sessionId"], "tenant purge session grave owner");
  tenantId(owner.tenantId);
  userId(owner.userId);
  if (!isCanonicalId("sess", owner.sessionId)) {
    throw new Error("invalid tenant purge grave marker session id");
  }
  return sha256([
    "tenant-purge-session-grave-owner-v1",
    owner.tenantId,
    owner.userId,
    owner.sessionId,
  ]);
}

type GraveMarkerBody = Omit<TenantPurgeSessionGraveMarker, "markerSha256">;

export function tenantDatabasePurgeSessionGraveMarkerSha256(marker: GraveMarkerBody): string {
  validateTenantDatabasePurgeIdentity(marker);
  if (marker.scope !== TENANT_PURGE_SESSION_GRAVE_MARKER_SCOPE) {
    throw new Error("tenant purge session grave marker scope is invalid");
  }
  if (!isCanonicalId("sess", marker.sessionId)) {
    throw new Error("invalid tenant purge grave marker session id");
  }
  positive(marker.deletionGeneration, "tenant purge grave marker deletion generation");
  timestamp(marker.deletedAtDbMs, "tenant purge grave marker deletion time");
  digest(marker.ownerSha256, "tenant purge grave marker owner");
  digest(marker.t3cSessionReceiptSha256, "tenant purge grave marker T3c receipt");
  digest(marker.preDeleteReceiptSha256, "tenant purge grave marker pre-delete receipt");
  timestamp(marker.markedAtDbMs, "tenant purge grave marker publication time");
  if (marker.markedAtDbMs < marker.deletedAtDbMs) {
    throw new Error("tenant purge grave marker predates the session deletion");
  }
  return sha256([
    "tenant-purge-session-grave-marker-v1",
    marker.scope,
    ...IDENTITY_KEYS.map((key) => marker[key]),
    marker.sessionId,
    marker.deletionGeneration,
    marker.deletedAtDbMs,
    marker.ownerSha256,
    marker.t3cSessionReceiptSha256,
    marker.preDeleteReceiptSha256,
    marker.markedAtDbMs,
  ]);
}

export function validateTenantDatabasePurgeSessionGraveMarker(
  marker: TenantPurgeSessionGraveMarker,
): void {
  exactKeys(marker, [
    ...IDENTITY_KEYS,
    "scope",
    "sessionId",
    "deletionGeneration",
    "deletedAtDbMs",
    "ownerSha256",
    "t3cSessionReceiptSha256",
    "preDeleteReceiptSha256",
    "markedAtDbMs",
    "markerSha256",
  ], "tenant purge session grave marker");
  const expected = tenantDatabasePurgeSessionGraveMarkerSha256(marker);
  digest(marker.markerSha256, "tenant purge session grave marker");
  if (marker.markerSha256 !== expected) {
    throw new Error("tenant purge session grave marker does not match");
  }
}

export function tenantDatabasePurgeSessionGraveMarkerRootSha256(
  markers: readonly TenantPurgeSessionGraveMarker[],
): string {
  const first = markers[0];
  const sessionIds = new Set<string>();
  for (const marker of markers) {
    validateTenantDatabasePurgeSessionGraveMarker(marker);
    if (first !== undefined && (!sameTenantDatabasePurgeIdentity(first, marker)
      || marker.preDeleteReceiptSha256 !== first.preDeleteReceiptSha256
      || marker.markedAtDbMs !== first.markedAtDbMs)) {
      throw new Error("tenant purge session grave markers do not share one atomic source");
    }
    if (sessionIds.has(marker.sessionId)) {
      throw new Error("tenant purge session grave marker session is duplicated");
    }
    sessionIds.add(marker.sessionId);
  }
  const hashes = markers.map((marker) => marker.markerSha256).sort();
  if (new Set(hashes).size !== hashes.length) {
    throw new Error("tenant purge session grave marker is duplicated");
  }
  return sha256(["tenant-purge-session-grave-marker-root-v1", ...hashes]);
}

type ReceiptBody = Omit<TenantDatabasePurgeReceipt, "receiptSha256">;

export function tenantDatabasePurgeReceiptSha256(receipt: ReceiptBody): string {
  validateTenantDatabasePurgeSource(receipt);
  if (receipt.scope !== TENANT_DATABASE_PURGE_RECEIPT_SCOPE) {
    throw new Error("tenant database purge receipt scope is invalid");
  }
  digest(receipt.preDeleteReceiptSha256, "tenant database purge pre-delete receipt");
  count(receipt.preDeleteEntryCount, "tenant database purge pre-delete entry count");
  if (receipt.preDeleteEntryCount !== TENANT_DATABASE_PURGE_DOMAINS.length) {
    throw new Error("tenant database purge receipt does not cover the fixed pre-delete catalog");
  }
  digest(receipt.preDeleteEntryRootSha256, "tenant database purge pre-delete entry root");
  count(receipt.domainAckCount, "tenant database purge domain ACK count");
  if (receipt.domainAckCount !== TENANT_DATABASE_PURGE_DOMAINS.length) {
    throw new Error("tenant database purge receipt does not cover the fixed ACK catalog");
  }
  digest(receipt.domainAckRootSha256, "tenant database purge domain ACK root");
  count(receipt.graveMarkerCount, "tenant database purge grave marker count");
  digest(receipt.graveMarkerRootSha256, "tenant database purge grave marker root");
  if (receipt.graveMarkerCount === 0
    && receipt.graveMarkerRootSha256 !== EMPTY_TENANT_PURGE_SESSION_GRAVE_MARKER_ROOT_SHA256) {
    throw new Error("empty tenant database purge grave marker set has a non-empty root");
  }
  count(receipt.retainedBillingFactCount, "tenant database purge retained billing fact count");
  digest(receipt.retainedBillingFactRootSha256, "tenant database purge retained billing fact root");
  if (receipt.retainedBillingFactCount === 0
    && receipt.retainedBillingFactRootSha256 !== tenantDatabasePurgeBillingFactRootSha256([])) {
    throw new Error("empty tenant database purge billing fact set has a non-empty root");
  }
  count(
    receipt.billingReconciliationEvidenceCount,
    "tenant database purge billing reconciliation evidence count",
  );
  if (receipt.billingReconciliationEvidenceCount > 1) {
    throw new Error("tenant database purge billing reconciliation evidence count is invalid");
  }
  digest(
    receipt.billingReconciliationEvidenceRootSha256,
    "tenant database purge billing reconciliation evidence root",
  );
  if (receipt.billingReconciliationEvidenceCount === 0
    && receipt.billingReconciliationEvidenceRootSha256
      !== tenantDatabasePurgeRetainedEvidenceRootSha256("billing_reconciliation", [])) {
    throw new Error("empty billing reconciliation evidence has a non-empty root");
  }
  count(receipt.unresolvedBlockerCount, "tenant database purge unresolved blocker count");
  if (receipt.unresolvedBlockerCount > 33) {
    throw new Error("tenant database purge unresolved blocker count is invalid");
  }
  timestamp(receipt.storeDbTimestampMs, "tenant database purge receipt timestamp");
  if (receipt.storeDbTimestampMs < receipt.sourceEvidenceDbMs) {
    throw new Error("tenant database purge receipt predates source evidence");
  }
  positive(receipt.completedClaimAttempt, "tenant database purge receipt claim attempt");
  digest(receipt.completedClaimTokenSha256, "tenant database purge receipt claim token");
  if (receipt.localDatabasePurgeComplete !== true || receipt.sessionContentDeleted !== true
    || receipt.allDomainsComplete !== false || receipt.contentPurgeExecuted !== false) {
    throw new Error("tenant database purge receipt flags are invalid");
  }
  return sha256([
    "tenant-database-purge-v1",
    receipt.scope,
    ...SOURCE_KEYS.map((key) => receipt[key]),
    receipt.preDeleteReceiptSha256,
    receipt.preDeleteEntryCount,
    receipt.preDeleteEntryRootSha256,
    receipt.domainAckCount,
    receipt.domainAckRootSha256,
    receipt.graveMarkerCount,
    receipt.graveMarkerRootSha256,
    receipt.retainedBillingFactCount,
    receipt.retainedBillingFactRootSha256,
    receipt.billingReconciliationEvidenceCount,
    receipt.billingReconciliationEvidenceRootSha256,
    receipt.unresolvedBlockerCount,
    receipt.storeDbTimestampMs,
    receipt.completedClaimAttempt,
    receipt.completedClaimTokenSha256,
    receipt.localDatabasePurgeComplete,
    receipt.sessionContentDeleted,
    receipt.allDomainsComplete,
    receipt.contentPurgeExecuted,
  ]);
}

export function validateTenantDatabasePurgeReceipt(receipt: TenantDatabasePurgeReceipt): void {
  exactKeys(receipt, [
    ...SOURCE_KEYS,
    "scope",
    "preDeleteReceiptSha256",
    "preDeleteEntryCount",
    "preDeleteEntryRootSha256",
    "domainAckCount",
    "domainAckRootSha256",
    "graveMarkerCount",
    "graveMarkerRootSha256",
    "retainedBillingFactCount",
    "retainedBillingFactRootSha256",
    "billingReconciliationEvidenceCount",
    "billingReconciliationEvidenceRootSha256",
    "unresolvedBlockerCount",
    "storeDbTimestampMs",
    "completedClaimAttempt",
    "completedClaimTokenSha256",
    "localDatabasePurgeComplete",
    "sessionContentDeleted",
    "allDomainsComplete",
    "contentPurgeExecuted",
    "receiptSha256",
  ], "tenant database purge receipt");
  const expected = tenantDatabasePurgeReceiptSha256(receipt);
  digest(receipt.receiptSha256, "tenant database purge receipt");
  if (receipt.receiptSha256 !== expected) {
    throw new Error("tenant database purge receipt does not match");
  }
}

/**
 * Validate the complete evidence graph emitted by one atomic execute call. Individual validators
 * establish envelope integrity; this closes the cross-record links so no valid row can be spliced
 * into a different request, claim, source generation, or evidence catalog.
 */
export function validateTenantDatabasePurgeEvidenceBundle(
  bundle: TenantDatabasePurgeEvidenceBundle,
): void {
  exactKeys(bundle, [
    "preDeleteEntries",
    "preDeleteReceipt",
    "domainAcks",
    "graveMarkers",
    "receipt",
  ], "tenant database purge evidence bundle");
  const {
    preDeleteEntries,
    preDeleteReceipt,
    domainAcks,
    graveMarkers,
    receipt,
  } = bundle;
  validateTenantDatabasePurgePreDeleteReceipt(preDeleteReceipt);
  validateTenantDatabasePurgeReceipt(receipt);
  if (!SOURCE_KEYS.every((key) => preDeleteReceipt[key] === receipt[key])) {
    throw new Error("tenant database purge receipt source does not match pre-delete evidence");
  }
  if (receipt.preDeleteReceiptSha256 !== preDeleteReceipt.receiptSha256) {
    throw new Error("tenant database purge receipt does not bind its pre-delete receipt");
  }
  if (preDeleteReceipt.completedClaimAttempt !== receipt.completedClaimAttempt
    || preDeleteReceipt.completedClaimTokenSha256 !== receipt.completedClaimTokenSha256
    || preDeleteReceipt.storeDbTimestampMs !== receipt.storeDbTimestampMs) {
    throw new Error("tenant database purge receipts do not share one atomic authorization");
  }
  if (preDeleteEntries.length !== TENANT_DATABASE_PURGE_DOMAINS.length) {
    throw new Error("tenant database purge pre-delete evidence does not cover the fixed catalog");
  }
  for (const entry of preDeleteEntries) {
    validateTenantDatabasePurgePreDeleteEntryAgainstSource(entry, receipt);
    if (entry.capturedAtDbMs !== receipt.storeDbTimestampMs) {
      throw new Error("tenant database purge pre-delete evidence is not from the execute boundary");
    }
  }
  const preDeleteEntryRootSha256 = tenantDatabasePurgePreDeleteEntryRootSha256(preDeleteEntries);
  if (preDeleteReceipt.entryCount !== preDeleteEntries.length
    || preDeleteReceipt.entryRootSha256 !== preDeleteEntryRootSha256
    || receipt.preDeleteEntryCount !== preDeleteEntries.length
    || receipt.preDeleteEntryRootSha256 !== preDeleteEntryRootSha256) {
    throw new Error("tenant database purge pre-delete catalog root does not match");
  }
  const entryByDomain = new Map(preDeleteEntries.map((entry) => [entry.domain, entry]));
  const sessionEntry = entryByDomain.get("session_content");
  const billingEntry = entryByDomain.get("billing_reconciliation");
  if (sessionEntry === undefined || billingEntry === undefined
    || preDeleteReceipt.sessionTargetCount !== sessionEntry.preDeleteTargetCount
    || preDeleteReceipt.sessionTargetRootSha256 !== sessionEntry.preDeleteTargetRootSha256
    || preDeleteReceipt.billingReconciliationTargetCount
      !== billingEntry.preDeleteTargetCount
    || preDeleteReceipt.billingReconciliationTargetRootSha256
      !== billingEntry.preDeleteTargetRootSha256) {
    throw new Error("tenant database purge pre-delete domain summary does not match");
  }
  if (receipt.retainedBillingFactCount !== preDeleteReceipt.retainedBillingFactCount
    || receipt.retainedBillingFactRootSha256
      !== preDeleteReceipt.retainedBillingFactRootSha256) {
    throw new Error("tenant database purge changed retained billing facts");
  }

  if (domainAcks.length !== TENANT_DATABASE_PURGE_DOMAINS.length
    || receipt.domainAckCount !== domainAcks.length
    || receipt.domainAckRootSha256 !== tenantDatabasePurgeDomainAckRootSha256(domainAcks)) {
    throw new Error("tenant database purge domain ACK catalog does not match");
  }
  for (const ack of domainAcks) {
    const entry = entryByDomain.get(ack.domain);
    if (entry === undefined || !sameTenantDatabasePurgeIdentity(ack, receipt)
      || ack.preDeleteEntryReceiptSha256 !== entry.receiptSha256
      || ack.action !== entry.action
      || ack.preDeleteTargetCount !== entry.preDeleteTargetCount
      || ack.preDeleteTargetRootSha256 !== entry.preDeleteTargetRootSha256
      || ack.completedClaimAttempt !== receipt.completedClaimAttempt
      || ack.completedClaimTokenSha256 !== receipt.completedClaimTokenSha256
      || ack.storeDbTimestampMs !== receipt.storeDbTimestampMs) {
      throw new Error("tenant database purge domain ACK does not match its atomic source");
    }
  }
  const billingAck = domainAcks.find((ack) => ack.domain === "billing_reconciliation");
  if (billingAck === undefined
    || receipt.billingReconciliationEvidenceCount !== billingAck.retainedEvidenceCount
    || receipt.billingReconciliationEvidenceRootSha256
      !== billingAck.retainedEvidenceRootSha256) {
    throw new Error("tenant database purge billing reconciliation evidence does not match");
  }

  if (graveMarkers.length !== preDeleteReceipt.sessionTargetCount
    || receipt.graveMarkerCount !== graveMarkers.length
    || receipt.graveMarkerRootSha256
      !== tenantDatabasePurgeSessionGraveMarkerRootSha256(graveMarkers)) {
    throw new Error("tenant database purge grave marker catalog does not match");
  }
  const sessionTargetRootSha256 = tenantDatabasePurgeTargetRootSha256(
    "session_content",
    graveMarkers.map((marker) => tenantDatabasePurgeTargetSha256(
      "session_content",
      [marker.sessionId, marker.t3cSessionReceiptSha256],
    )),
  );
  if (preDeleteReceipt.sessionTargetRootSha256 !== sessionTargetRootSha256) {
    throw new Error("tenant database purge session target does not match its grave markers");
  }
  const sessionAck = domainAcks.find((ack) => ack.domain === "session_content");
  if (sessionAck === undefined
    || sessionAck.retainedEvidenceCount !== receipt.graveMarkerCount
    || sessionAck.retainedEvidenceRootSha256 !== receipt.graveMarkerRootSha256) {
    throw new Error("tenant database purge session ACK does not bind its grave marker evidence");
  }
  for (const marker of graveMarkers) {
    if (!sameTenantDatabasePurgeIdentity(marker, receipt)
      || marker.preDeleteReceiptSha256 !== preDeleteReceipt.receiptSha256
      || marker.markedAtDbMs !== receipt.storeDbTimestampMs) {
      throw new Error("tenant purge session grave marker does not match its atomic source");
    }
  }
}

export function validateTenantDatabasePurgeAuthorization(
  authorization: TenantDatabasePurgeAuthorization,
): void {
  exactKeys(authorization, [
    ...IDENTITY_KEYS,
    "claimAttempt",
    "claimToken",
  ], "tenant database purge authorization");
  validateTenantDatabasePurgeIdentity(authorization);
  positive(authorization.claimAttempt, "tenant database purge claim attempt");
  claimToken(authorization.claimToken);
}

export function validateTenantDatabasePurgeClaim(claim: TenantDatabasePurgeClaim): void {
  exactKeys(claim, [
    ...SOURCE_KEYS,
    "phase",
    "claimAttempt",
    "claimToken",
    "leaseUntilMs",
  ], "tenant database purge claim");
  validateTenantDatabasePurgeSource(claim);
  if (claim.phase !== "queued") throw new Error("tenant database purge claim phase is invalid");
  positive(claim.claimAttempt, "tenant database purge claim attempt");
  claimToken(claim.claimToken);
  timestamp(claim.leaseUntilMs, "tenant database purge claim lease");
  if (claim.leaseUntilMs < claim.sourceEvidenceDbMs) {
    throw new Error("tenant database purge claim lease predates source evidence");
  }
}

export function tenantDatabasePurgeAuthorizationMatches(
  job: TenantDatabasePurgeJobRecord,
  authorization: TenantDatabasePurgeAuthorization,
  databaseNowMs: number,
): boolean {
  validateTenantDatabasePurgeJobRecord(job);
  validateTenantDatabasePurgeAuthorization(authorization);
  timestamp(databaseNowMs, "tenant database purge database timestamp");
  return job.phase === "queued"
    && IDENTITY_KEYS.every((key) => job[key] === authorization[key])
    && job.attempts === authorization.claimAttempt
    && job.claimToken === authorization.claimToken
    && job.leaseUntilMs !== undefined
    && job.leaseUntilMs > databaseNowMs;
}

export function tenantDatabasePurgeClaimFromJob(
  job: TenantDatabasePurgeJobRecord,
): TenantDatabasePurgeClaim {
  validateTenantDatabasePurgeJobRecord(job);
  if (job.phase !== "queued" || job.claimToken === undefined || job.leaseUntilMs === undefined) {
    throw new Error("tenant database purge job is not claimed");
  }
  return {
    requestId: job.requestId,
    tenantId: job.tenantId,
    subjectGeneration: job.subjectGeneration,
    planBuildGeneration: job.planBuildGeneration,
    executionGeneration: job.executionGeneration,
    databasePurgeGeneration: job.databasePurgeGeneration,
    t3cReceiptSha256: job.t3cReceiptSha256,
    planReceiptSha256: job.planReceiptSha256,
    localPhysicalAckReceiptSha256: job.localPhysicalAckReceiptSha256,
    policySha256: job.policySha256,
    purgeNotBeforeDbMs: job.purgeNotBeforeDbMs,
    sourceEvidenceDbMs: job.sourceEvidenceDbMs,
    phase: "queued",
    claimAttempt: job.attempts,
    claimToken: job.claimToken,
    leaseUntilMs: job.leaseUntilMs,
  };
}

export function tenantDatabasePurgeReceiptMatchesAuthorization(
  receipt: TenantDatabasePurgeReceipt,
  authorization: TenantDatabasePurgeAuthorization,
): boolean {
  validateTenantDatabasePurgeReceipt(receipt);
  validateTenantDatabasePurgeAuthorization(authorization);
  return IDENTITY_KEYS.every((key) => receipt[key] === authorization[key])
    && receipt.completedClaimAttempt === authorization.claimAttempt
    && receipt.completedClaimTokenSha256
      === tenantDatabasePurgeClaimTokenSha256(authorization.claimToken);
}

/**
 * Close the exact-replay boundary between the mutable job row and the immutable evidence graph.
 * A receipt that matches a claim is not sufficient on its own: every frozen upstream source and
 * every atomic publication root must still be identical to the completed job record.
 */
export function validateTenantDatabasePurgeCompletionProof(
  job: TenantDatabasePurgeJobRecord,
  bundle: TenantDatabasePurgeEvidenceBundle,
): void {
  validateTenantDatabasePurgeJobRecord(job);
  if (job.phase !== "database_purged") {
    throw new Error("tenant database purge completion proof requires a completed job");
  }
  validateTenantDatabasePurgeEvidenceBundle(bundle);
  const { receipt } = bundle;
  if (!SOURCE_KEYS.every((key) => job[key] === receipt[key])) {
    throw new Error("tenant database purge completed job source does not match its receipt");
  }
  if (job.preDeleteReceiptSha256 !== receipt.preDeleteReceiptSha256
    || job.preDeleteEntryCount !== receipt.preDeleteEntryCount
    || job.preDeleteEntryRootSha256 !== receipt.preDeleteEntryRootSha256
    || job.domainAckCount !== receipt.domainAckCount
    || job.domainAckRootSha256 !== receipt.domainAckRootSha256
    || job.unresolvedBlockerCount !== receipt.unresolvedBlockerCount
    || job.terminalReceiptSha256 !== receipt.receiptSha256
    || job.purgedAtDbMs !== receipt.storeDbTimestampMs
    || job.completedClaimAttempt !== receipt.completedClaimAttempt
    || job.completedClaimTokenSha256 !== receipt.completedClaimTokenSha256) {
    throw new Error("tenant database purge completed job evidence does not match its receipt");
  }
}

export function validateTenantDatabasePurgeJobRecord(job: TenantDatabasePurgeJobRecord): void {
  const common = [
    ...SOURCE_KEYS,
    "phase",
    "domainCount",
    "preDeleteEntryCount",
    "preDeleteEntryRootSha256",
    "domainAckCount",
    "domainAckRootSha256",
    "unresolvedBlockerCount",
    "attempts",
    "createdAtMs",
    "updatedAtMs",
  ];
  if (job.phase === "queued") {
    exactKeys(job, [
      ...common,
      "availableAtMs",
      ...(job.claimToken === undefined ? [] : ["claimToken"]),
      ...(job.leaseUntilMs === undefined ? [] : ["leaseUntilMs"]),
      ...(job.lastErrorCode === undefined ? [] : ["lastErrorCode"]),
    ], "queued tenant database purge job");
  } else if (job.phase === "database_purged") {
    exactKeys(job, [
      ...common,
      "preDeleteReceiptSha256",
      "terminalReceiptSha256",
      "purgedAtDbMs",
      "completedClaimAttempt",
      "completedClaimTokenSha256",
    ], "completed tenant database purge job");
  } else if (job.phase === "blocked") {
    exactKeys(job, [
      ...common,
      "blockedAtMs",
      "blockedReasonCode",
    ], "blocked tenant database purge job");
  } else {
    throw new Error("tenant database purge job phase is invalid");
  }
  validateTenantDatabasePurgeSource(job);
  if (job.domainCount !== TENANT_DATABASE_PURGE_DOMAINS.length) {
    throw new Error("tenant database purge job does not cover the fixed domain catalog");
  }
  count(job.preDeleteEntryCount, "tenant database purge job pre-delete entry count");
  digest(job.preDeleteEntryRootSha256, "tenant database purge job pre-delete entry root");
  count(job.domainAckCount, "tenant database purge job domain ACK count");
  digest(job.domainAckRootSha256, "tenant database purge job domain ACK root");
  count(job.unresolvedBlockerCount, "tenant database purge job unresolved blocker count");
  if (job.unresolvedBlockerCount > 33) {
    throw new Error("tenant database purge job unresolved blocker count is invalid");
  }
  count(job.attempts, "tenant database purge job attempts");
  timestamp(job.createdAtMs, "tenant database purge job creation time");
  timestamp(job.updatedAtMs, "tenant database purge job update time");
  if (job.createdAtMs < job.sourceEvidenceDbMs || job.updatedAtMs < job.createdAtMs) {
    throw new Error("tenant database purge job timestamps are invalid");
  }
  if (job.phase === "queued") {
    if (job.preDeleteEntryCount !== 0
      || job.preDeleteEntryRootSha256 !== EMPTY_TENANT_DATABASE_PURGE_PREDELETE_ENTRY_ROOT_SHA256
      || job.domainAckCount !== 0
      || job.domainAckRootSha256 !== EMPTY_TENANT_DATABASE_PURGE_DOMAIN_ACK_ROOT_SHA256) {
      throw new Error("queued tenant database purge job has published destructive evidence");
    }
    timestamp(job.availableAtMs, "tenant database purge job availability");
    if ((job.claimToken === undefined) !== (job.leaseUntilMs === undefined)) {
      throw new Error("tenant database purge job claim is incomplete");
    }
    if (job.claimToken !== undefined) {
      claimToken(job.claimToken);
      timestamp(job.leaseUntilMs!, "tenant database purge job lease");
      if (job.attempts < 1 || job.leaseUntilMs! < job.updatedAtMs) {
        throw new Error("tenant database purge job claim is invalid");
      }
      if (job.lastErrorCode !== undefined) {
        throw new Error("claimed tenant database purge job retains a retry error");
      }
    } else if (job.availableAtMs < job.updatedAtMs) {
      throw new Error("tenant database purge job availability predates its update");
    }
    if (job.lastErrorCode !== undefined
      && job.lastErrorCode !== "temporary_failure"
      && job.lastErrorCode !== "dependency_pending") {
      throw new Error("tenant database purge retry error is invalid");
    }
    return;
  }
  if (job.phase === "database_purged") {
    if (job.preDeleteEntryCount !== TENANT_DATABASE_PURGE_DOMAINS.length
      || job.domainAckCount !== TENANT_DATABASE_PURGE_DOMAINS.length) {
      throw new Error("completed tenant database purge job lacks fixed-catalog evidence");
    }
    digest(job.preDeleteReceiptSha256, "tenant database purge job pre-delete receipt");
    digest(job.terminalReceiptSha256, "tenant database purge job terminal receipt");
    timestamp(job.purgedAtDbMs, "tenant database purge completion time");
    positive(job.completedClaimAttempt, "tenant database purge completion attempt");
    digest(job.completedClaimTokenSha256, "tenant database purge completion token");
    if (job.completedClaimAttempt !== job.attempts
      || job.purgedAtDbMs < job.sourceEvidenceDbMs
      || job.updatedAtMs < job.purgedAtDbMs) {
      throw new Error("tenant database purge terminal proof is invalid");
    }
    return;
  }
  if (job.preDeleteEntryCount !== 0
    || job.preDeleteEntryRootSha256 !== EMPTY_TENANT_DATABASE_PURGE_PREDELETE_ENTRY_ROOT_SHA256
    || job.domainAckCount !== 0
    || job.domainAckRootSha256 !== EMPTY_TENANT_DATABASE_PURGE_DOMAIN_ACK_ROOT_SHA256) {
    throw new Error("blocked tenant database purge job has partial destructive evidence");
  }
  timestamp(job.blockedAtMs, "tenant database purge blocked time");
  if (job.blockedAtMs < job.createdAtMs || job.blockedAtMs > job.updatedAtMs || job.attempts < 1
    || job.blockedReasonCode !== "integrity_conflict") {
    throw new Error("tenant database purge blocked state is invalid");
  }
}

export function validateMaterializeTenantDatabasePurgeJobsOptions(
  options: MaterializeTenantDatabasePurgeJobsOptions,
): void {
  exactKeys(options, ["limit"], "tenant database purge materialization options");
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new Error("tenant database purge materialization limit must be between 1 and 100");
  }
}

export function validateClaimTenantDatabasePurgesOptions(
  options: ClaimTenantDatabasePurgesOptions,
): void {
  exactKeys(options, ["limit", "leaseMs", "claimToken"], "tenant database purge claim options");
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new Error("tenant database purge claim limit must be between 1 and 100");
  }
  positive(options.leaseMs, "tenant database purge claim lease");
  claimToken(options.claimToken);
}

export function validateRenewTenantDatabasePurgeOptions(
  options: RenewTenantDatabasePurgeOptions,
): void {
  exactKeys(options, ["leaseMs"], "tenant database purge renewal options");
  positive(options.leaseMs, "tenant database purge renewal lease");
}

export function validateRetryTenantDatabasePurgeOptions(
  options: RetryTenantDatabasePurgeOptions,
): void {
  exactKeys(options, ["delayMs", "errorCode"], "tenant database purge retry options");
  timestamp(options.delayMs, "tenant database purge retry delay");
  if (options.errorCode !== "temporary_failure" && options.errorCode !== "dependency_pending") {
    throw new Error("tenant database purge retry error is invalid");
  }
}

export function tenantDatabasePurgeCutoverEvidenceSha256(
  input: Omit<Extract<TenantDatabasePurgeCutoverRecord, { controlGeneration: 1 }>, "evidenceSha256">,
): string {
  validateTenantDatabasePurgeCutoverRecord({ ...input, evidenceSha256: "0".repeat(64) }, true);
  return sha256([
    "tenant-database-purge-cutover-v1",
    input.singletonId,
    input.controlGeneration,
    input.activatedAtDbMs,
    input.firstRequestId,
    input.firstReceiptSha256,
  ]);
}

export function validateTenantDatabasePurgeCutoverRecord(
  record: TenantDatabasePurgeCutoverRecord,
  skipEvidence = false,
): void {
  if (record.controlGeneration === 0) {
    exactKeys(record, ["singletonId", "controlGeneration"], "inactive tenant database purge cutover");
    if (record.singletonId !== TENANT_DATABASE_PURGE_CUTOVER_SINGLETON_ID) {
      throw new Error("tenant database purge cutover singleton is invalid");
    }
    return;
  }
  exactKeys(record, [
    "singletonId",
    "controlGeneration",
    "activatedAtDbMs",
    "firstRequestId",
    "firstReceiptSha256",
    "evidenceSha256",
  ], "active tenant database purge cutover");
  if (record.singletonId !== TENANT_DATABASE_PURGE_CUTOVER_SINGLETON_ID
    || record.controlGeneration !== 1
    || !REQUEST_ID.test(record.firstRequestId)) {
    throw new Error("tenant database purge cutover identity is invalid");
  }
  timestamp(record.activatedAtDbMs, "tenant database purge cutover timestamp");
  digest(record.firstReceiptSha256, "tenant database purge cutover first receipt");
  digest(record.evidenceSha256, "tenant database purge cutover evidence");
  if (!skipEvidence
    && tenantDatabasePurgeCutoverEvidenceSha256(record) !== record.evidenceSha256) {
    throw new Error("tenant database purge cutover evidence does not match");
  }
}

export interface TenantDatabasePurgeStore {
  materializeTenantDatabasePurgeJobs(
    options: MaterializeTenantDatabasePurgeJobsOptions,
  ): Promise<number>;
  claimTenantDatabasePurges(
    options: ClaimTenantDatabasePurgesOptions,
  ): Promise<TenantDatabasePurgeClaim[]>;
  renewTenantDatabasePurge(
    authorization: TenantDatabasePurgeAuthorization,
    options: RenewTenantDatabasePurgeOptions,
  ): Promise<boolean>;
  retryTenantDatabasePurge(
    authorization: TenantDatabasePurgeAuthorization,
    options: RetryTenantDatabasePurgeOptions,
  ): Promise<boolean>;
  blockTenantDatabasePurge(
    authorization: TenantDatabasePurgeAuthorization,
    reason?: TenantDatabasePurgeBlockReasonCode,
  ): Promise<boolean>;
  executeTenantDatabasePurge(
    authorization: TenantDatabasePurgeAuthorization,
  ): Promise<TenantDatabasePurgeReceipt | null>;
  getTenantDatabasePurgeJob(
    tenantId: string,
    requestId: string,
  ): Promise<TenantDatabasePurgeJobRecord | null>;
  getTenantDatabasePurgePreDeleteEntries(
    tenantId: string,
    requestId: string,
    databasePurgeGeneration: number,
  ): Promise<TenantDatabasePurgePreDeleteEntry[]>;
  getTenantDatabasePurgePreDeleteReceipt(
    tenantId: string,
    requestId: string,
  ): Promise<TenantDatabasePurgePreDeleteReceipt | null>;
  getTenantDatabasePurgeDomainAcks(
    tenantId: string,
    requestId: string,
    databasePurgeGeneration: number,
  ): Promise<TenantDatabasePurgeDomainAck[]>;
  getTenantDatabasePurgeReceipt(
    tenantId: string,
    requestId: string,
  ): Promise<TenantDatabasePurgeReceipt | null>;
  getTenantDatabasePurgeCutover(): Promise<TenantDatabasePurgeCutoverRecord>;
  getTenantPurgeSessionGraveMarker(
    tenantId: string,
    sessionId: string,
  ): Promise<TenantPurgeSessionGraveMarker | null>;
}

/** Sum entry targets with safe-integer protection for aggregate receipt construction. */
export function tenantDatabasePurgeTotalTargetCount(
  entries: readonly TenantDatabasePurgePreDeleteEntry[],
): number {
  return safeCountSum(
    entries.map((entry) => entry.preDeleteTargetCount),
    "tenant database purge target count",
  );
}
