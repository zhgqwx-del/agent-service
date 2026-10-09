import { createHash } from "node:crypto";
import { RETENTION_POLICY_SCHEMA_VERSION } from "./retention-policy.js";

export const TENANT_PURGE_PLAN_ENTRY_SCOPE = "tenant-purge-plan-entry-v1" as const;
export const TENANT_PURGE_PLAN_RECEIPT_SCOPE = "tenant-purge-plan-v1" as const;

/**
 * Closed catalog for a non-destructive tenant purge plan. A domain may not be omitted merely
 * because its adapter is unavailable: unavailable cloud, restore, log, or legacy external
 * sources are represented by an explicit blocking disposition and a content-free source hash.
 */
export const TENANT_PURGE_PLAN_DOMAINS = [
  "tenant_registry",
  "tenant_profile",
  "agent_definitions",
  "session_content",
  "idempotency_receipts",
  "operational_usage",
  "billing_facts",
  "billing_reconciliation",
  "blob_manifest",
  "blob_bytes",
  "blob_outbox",
  "lifecycle_outbox",
  "user_export_control",
  "user_export_snapshots",
  "user_export_artifacts",
  "user_export_bytes",
  "user_erasure_evidence",
  "user_purge_policy_evidence",
  "governance_policy",
  "legal_holds",
  "tenant_t1_evidence",
  "tenant_t3a_evidence",
  "tenant_t3b_evidence",
  "tenant_t3c_evidence",
  "redis_leases",
  "redis_fences",
  "redis_streams",
  "external_provider",
  "kms",
  "backup_ledger",
  "restore_ledger",
  "logs",
  "traces",
] as const;
export type TenantPurgePlanDomain = (typeof TENANT_PURGE_PLAN_DOMAINS)[number];

export function tenantPurgePlanDomainOrdinal(domain: TenantPurgePlanDomain): number {
  const ordinal = (TENANT_PURGE_PLAN_DOMAINS as readonly string[]).indexOf(domain);
  if (ordinal < 0) throw new Error("tenant purge plan domain is invalid");
  return ordinal;
}

export const TENANT_PURGE_PLAN_DISPOSITIONS = [
  "delete",
  "anonymize",
  "retain_anonymized",
  "revoke",
  "clear",
  "retain_evidence",
  "not_applicable",
  "blocked_legacy_external_source_unavailable",
  "blocked_adapter_unconfigured",
  "blocked_restore_replay_unproven",
] as const;
export type TenantPurgePlanDisposition = (typeof TENANT_PURGE_PLAN_DISPOSITIONS)[number];

export const TENANT_PURGE_PLAN_BLOCKING_DISPOSITIONS = [
  "blocked_legacy_external_source_unavailable",
  "blocked_adapter_unconfigured",
  "blocked_restore_replay_unproven",
] as const satisfies readonly TenantPurgePlanDisposition[];
export type TenantPurgePlanBlockingDisposition =
  (typeof TENANT_PURGE_PLAN_BLOCKING_DISPOSITIONS)[number];

export type TenantPurgePlanJobPhase = "queued" | "plan_sealed" | "blocked";
export type TenantPurgePlanRetryErrorCode = "temporary_failure";
export type TenantPurgePlanBlockReasonCode = "integrity_conflict";
export type TenantPurgePlanNotReadyReason =
  | "deadline_not_reached"
  | "active_legal_hold"
  | "trusted_clock_before_anchor"
  | "trusted_clock_before_source"
  | "trusted_clock_before_evidence";

export class TenantPurgePlanNotReadyError extends Error {
  constructor(public readonly reason: TenantPurgePlanNotReadyReason) {
    super(`tenant purge plan is not ready: ${reason}`);
    this.name = "TenantPurgePlanNotReadyError";
  }
}

export class TenantPurgePlanEvidenceChangedError extends Error {
  constructor() {
    super("tenant purge plan source evidence changed");
    this.name = "TenantPurgePlanEvidenceChangedError";
  }
}

const ERASURE_REQUEST_ID =
  /^erase_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLAIM_TOKEN = /^[A-Za-z0-9._:~-]{1,128}$/;
const POLICY_VERSION = /^(?!active$)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertExactKeys(value: object, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new Error(`${name} has unknown or missing fields`);
  }
}

function assertTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function assertCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function assertSha256(value: string, name: string): void {
  if (!SHA256.test(value)) throw new Error(`${name} must be a lowercase SHA-256 digest`);
}

function assertTenantId(tenantId: string): void {
  if (!tenantId || tenantId.length > 128) throw new Error("invalid tenant purge plan tenant id");
}

export interface TenantPurgePlanIdentity {
  requestId: string;
  tenantId: string;
  subjectGeneration: number;
  buildGeneration: number;
}

export function validateTenantPurgePlanIdentity(identity: TenantPurgePlanIdentity): void {
  if (!ERASURE_REQUEST_ID.test(identity.requestId)) {
    throw new Error("invalid tenant purge plan request id");
  }
  assertTenantId(identity.tenantId);
  assertPositiveSafeInteger(identity.subjectGeneration, "tenant purge plan subject generation");
  assertPositiveSafeInteger(identity.buildGeneration, "tenant purge plan build generation");
}

/** Exact immutable T1/T3a/T3b/T3c, policy, deadline, and DB-clock source binding. */
export interface TenantPurgePlanSource extends TenantPurgePlanIdentity {
  t1FenceSha256: string;
  t3aReceiptSha256: string;
  t3bReceiptSha256: string;
  t3cReceiptSha256: string;
  policyVersion: string;
  policySha256: string;
  policySchemaVersion: typeof RETENTION_POLICY_SCHEMA_VERSION;
  retentionAnchorDbMs: number;
  purgeNotBeforeDbMs: number;
  sourceEvidenceDbMs: number;
}

export function validateTenantPurgePlanSource(source: TenantPurgePlanSource): void {
  validateTenantPurgePlanIdentity(source);
  for (const [value, name] of [
    [source.t1FenceSha256, "T1 fence"],
    [source.t3aReceiptSha256, "T3a receipt"],
    [source.t3bReceiptSha256, "T3b receipt"],
    [source.t3cReceiptSha256, "T3c receipt"],
    [source.policySha256, "policy"],
  ] as const) assertSha256(value, `tenant purge plan ${name} hash`);
  if (!POLICY_VERSION.test(source.policyVersion)) {
    throw new Error("tenant purge plan policy version is invalid");
  }
  if (source.policySchemaVersion !== RETENTION_POLICY_SCHEMA_VERSION) {
    throw new Error("tenant purge plan policy schema version is invalid");
  }
  assertTimestamp(source.retentionAnchorDbMs, "tenant purge plan retention anchor");
  assertTimestamp(source.purgeNotBeforeDbMs, "tenant purge plan deadline");
  assertTimestamp(source.sourceEvidenceDbMs, "tenant purge plan source evidence time");
  if (source.purgeNotBeforeDbMs < source.retentionAnchorDbMs) {
    throw new Error("tenant purge plan deadline predates its retention anchor");
  }
  if (source.sourceEvidenceDbMs < source.purgeNotBeforeDbMs) {
    throw new Error("tenant purge plan source evidence predates its deadline");
  }
}

interface TenantPurgePlanJobBase extends TenantPurgePlanSource {
  phase: TenantPurgePlanJobPhase;
  cursorDomain?: TenantPurgePlanDomain;
  scanComplete: boolean;
  planEntryCount: number;
  planEntryRootSha256: string;
  blockerCount: number;
  blockerRootSha256: string;
  attempts: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export type TenantPurgePlanJobRecord = TenantPurgePlanJobBase & (
  | {
      phase: "queued";
      availableAtMs: number;
      claimToken?: string;
      leaseUntilMs?: number;
      lastErrorCode?: TenantPurgePlanRetryErrorCode;
      planSealedAtDbMs?: never;
      completedClaimAttempt?: never;
      completedClaimTokenSha256?: never;
      aggregateReceiptSha256?: never;
      blockedAtDbMs?: never;
      blockedReasonCode?: never;
    }
  | {
      phase: "plan_sealed";
      availableAtMs?: never;
      claimToken?: never;
      leaseUntilMs?: never;
      lastErrorCode?: never;
      planSealedAtDbMs: number;
      completedClaimAttempt: number;
      completedClaimTokenSha256: string;
      aggregateReceiptSha256: string;
      blockedAtDbMs?: never;
      blockedReasonCode?: never;
    }
  | {
      phase: "blocked";
      availableAtMs?: never;
      claimToken?: never;
      leaseUntilMs?: never;
      lastErrorCode?: never;
      planSealedAtDbMs?: never;
      completedClaimAttempt?: never;
      completedClaimTokenSha256?: never;
      aggregateReceiptSha256?: never;
      blockedAtDbMs: number;
      blockedReasonCode: TenantPurgePlanBlockReasonCode;
    }
);

export interface MaterializeTenantPurgePlanJobsOptions { limit: number }
export interface ClaimTenantPurgePlansOptions {
  limit: number;
  leaseMs: number;
  claimToken: string;
}
export interface RenewTenantPurgePlanOptions { leaseMs: number }
export interface RetryTenantPurgePlanOptions {
  delayMs: number;
  errorCode: TenantPurgePlanRetryErrorCode;
}
export interface BuildTenantPurgePlanPageOptions { limit: number }

export interface TenantPurgePlanClaim extends TenantPurgePlanSource {
  phase: "queued";
  claimAttempt: number;
  claimToken: string;
  leaseUntilMs: number;
}

export type TenantPurgePlanAuthorization = Pick<
  TenantPurgePlanClaim,
  | "requestId"
  | "tenantId"
  | "subjectGeneration"
  | "buildGeneration"
  | "claimAttempt"
  | "claimToken"
>;

export interface BuildTenantPurgePlanPageResult {
  built: number;
  done: boolean;
  cursorDomain?: TenantPurgePlanDomain;
  planEntryCount: number;
  planEntryRootSha256: string;
  blockerCount: number;
  blockerRootSha256: string;
}

export interface TenantPurgePlanEntry extends TenantPurgePlanIdentity {
  scope: typeof TENANT_PURGE_PLAN_ENTRY_SCOPE;
  domain: TenantPurgePlanDomain;
  targetCount: number;
  targetRootSha256: string;
  disposition: TenantPurgePlanDisposition;
  sourceSha256: string;
  capturedAtDbMs: number;
  receiptSha256: string;
}

export interface TenantPurgePlanReceipt extends TenantPurgePlanSource {
  scope: typeof TENANT_PURGE_PLAN_RECEIPT_SCOPE;
  planEntryCount: number;
  planEntryRootSha256: string;
  blockerCount: number;
  blockerRootSha256: string;
  storeDbTimestampMs: number;
  completedClaimAttempt: number;
  completedClaimTokenSha256: string;
  planComplete: true;
  executionReady: false;
  contentPurgeExecuted: false;
  receiptSha256: string;
}

/**
 * Planning-only surface: it can persist counts, roots, dispositions, and source hashes, but has no
 * delete/anonymize/revoke/complete operation and cannot authorize a destructive executor.
 */
export interface TenantPurgePlanStore {
  materializeTenantPurgePlanJobs(options: MaterializeTenantPurgePlanJobsOptions): Promise<number>;
  claimTenantPurgePlans(options: ClaimTenantPurgePlansOptions): Promise<TenantPurgePlanClaim[]>;
  renewTenantPurgePlan(
    authorization: TenantPurgePlanAuthorization,
    options: RenewTenantPurgePlanOptions,
  ): Promise<boolean>;
  retryTenantPurgePlan(
    authorization: TenantPurgePlanAuthorization,
    options: RetryTenantPurgePlanOptions,
  ): Promise<boolean>;
  blockTenantPurgePlan(authorization: TenantPurgePlanAuthorization): Promise<boolean>;
  /** Returns null after stale/lost authority; exact committed response-loss replay is allowed. */
  sealTenantPurgePlan(
    authorization: TenantPurgePlanAuthorization,
  ): Promise<TenantPurgePlanReceipt | null>;
  getTenantPurgePlanJob(
    tenantId: string,
    requestId: string,
  ): Promise<TenantPurgePlanJobRecord | null>;
  getTenantPurgePlanEntries(
    tenantId: string,
    requestId: string,
    buildGeneration: number,
  ): Promise<TenantPurgePlanEntry[]>;
  getTenantPurgePlanReceipt(
    tenantId: string,
    requestId: string,
  ): Promise<TenantPurgePlanReceipt | null>;
}

export function isTenantPurgePlanBlockingDisposition(
  disposition: TenantPurgePlanDisposition,
): disposition is TenantPurgePlanBlockingDisposition {
  return (TENANT_PURGE_PLAN_BLOCKING_DISPOSITIONS as readonly string[]).includes(disposition);
}

export function assertTenantPurgePlanClaimToken(claimToken: string): void {
  if (!CLAIM_TOKEN.test(claimToken)) throw new Error("tenant purge plan claim token is invalid");
}

export function tenantPurgePlanClaimTokenSha256(claimToken: string): string {
  assertTenantPurgePlanClaimToken(claimToken);
  return sha256(["tenant-purge-plan-claim-token-v1", claimToken]);
}

export function validateMaterializeTenantPurgePlanJobsOptions(
  options: MaterializeTenantPurgePlanJobsOptions,
): void {
  assertExactKeys(options, ["limit"], "tenant purge plan materialization options");
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new Error("tenant purge plan materialization limit must be between 1 and 100");
  }
}

export function validateClaimTenantPurgePlansOptions(options: ClaimTenantPurgePlansOptions): void {
  assertExactKeys(options, ["limit", "leaseMs", "claimToken"], "tenant purge plan claim options");
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new Error("tenant purge plan claim limit must be between 1 and 100");
  }
  assertPositiveSafeInteger(options.leaseMs, "tenant purge plan claim lease");
  assertTenantPurgePlanClaimToken(options.claimToken);
}

export function validateTenantPurgePlanAuthorization(
  authorization: TenantPurgePlanAuthorization,
): void {
  assertExactKeys(authorization, [
    "requestId", "tenantId", "subjectGeneration", "buildGeneration", "claimAttempt", "claimToken",
  ], "tenant purge plan authorization");
  validateTenantPurgePlanIdentity(authorization);
  assertPositiveSafeInteger(authorization.claimAttempt, "tenant purge plan claim attempt");
  assertTenantPurgePlanClaimToken(authorization.claimToken);
}

export function validateRenewTenantPurgePlanOptions(options: RenewTenantPurgePlanOptions): void {
  assertExactKeys(options, ["leaseMs"], "tenant purge plan renewal options");
  assertPositiveSafeInteger(options.leaseMs, "tenant purge plan renewal lease");
}

export function validateRetryTenantPurgePlanOptions(options: RetryTenantPurgePlanOptions): void {
  assertExactKeys(options, ["delayMs", "errorCode"], "tenant purge plan retry options");
  assertTimestamp(options.delayMs, "tenant purge plan retry delay");
  if (options.errorCode !== "temporary_failure") {
    throw new Error("tenant purge plan retry error is invalid");
  }
}

export function validateBuildTenantPurgePlanPageOptions(
  options: BuildTenantPurgePlanPageOptions,
): void {
  assertExactKeys(options, ["limit"], "tenant purge plan page options");
  if (!Number.isInteger(options.limit) || options.limit < 1
    || options.limit > TENANT_PURGE_PLAN_DOMAINS.length) {
    throw new Error(
      `tenant purge plan page limit must be between 1 and ${TENANT_PURGE_PLAN_DOMAINS.length}`,
    );
  }
}

type TenantPurgePlanEntryBody = Omit<TenantPurgePlanEntry, "receiptSha256">;

export function tenantPurgePlanEntrySha256(entry: TenantPurgePlanEntryBody): string {
  validateTenantPurgePlanIdentity(entry);
  if (entry.scope !== TENANT_PURGE_PLAN_ENTRY_SCOPE) {
    throw new Error("tenant purge plan entry scope is invalid");
  }
  if (!(TENANT_PURGE_PLAN_DOMAINS as readonly string[]).includes(entry.domain)) {
    throw new Error("tenant purge plan domain is invalid");
  }
  if (!(TENANT_PURGE_PLAN_DISPOSITIONS as readonly string[]).includes(entry.disposition)) {
    throw new Error("tenant purge plan disposition is invalid");
  }
  assertCount(entry.targetCount, "tenant purge plan target count");
  if (entry.disposition === "not_applicable"
    && (entry.targetCount !== 0
      || (entry.domain !== "external_provider" && entry.domain !== "kms"))) {
    throw new Error("tenant purge plan not-applicable disposition is invalid");
  }
  assertSha256(entry.targetRootSha256, "tenant purge plan target root");
  assertSha256(entry.sourceSha256, "tenant purge plan source hash");
  assertTimestamp(entry.capturedAtDbMs, "tenant purge plan capture time");
  return sha256([
    "tenant-purge-plan-entry-v1",
    entry.scope,
    entry.requestId,
    entry.buildGeneration,
    entry.tenantId,
    entry.subjectGeneration,
    entry.domain,
    entry.targetCount,
    entry.targetRootSha256,
    entry.disposition,
    entry.sourceSha256,
    entry.capturedAtDbMs,
  ]);
}

export function tenantPurgePlanDomainSourceSha256(
  source: TenantPurgePlanSource,
  domain: TenantPurgePlanDomain,
): string {
  validateTenantPurgePlanSource(source);
  if (!(TENANT_PURGE_PLAN_DOMAINS as readonly string[]).includes(domain)) {
    throw new Error("tenant purge plan domain is invalid");
  }
  return sha256([
    "tenant-purge-plan-domain-source-v1",
    domain,
    source.requestId,
    source.tenantId,
    source.subjectGeneration,
    source.buildGeneration,
    source.t1FenceSha256,
    source.t3aReceiptSha256,
    source.t3bReceiptSha256,
    source.t3cReceiptSha256,
    source.policyVersion,
    source.policySha256,
    source.policySchemaVersion,
    source.retentionAnchorDbMs,
    source.purgeNotBeforeDbMs,
    source.sourceEvidenceDbMs,
  ]);
}

/** Hash one canonical content-free target tuple before it enters an aggregate root. */
export function tenantPurgePlanTargetSha256(
  domain: TenantPurgePlanDomain,
  canonicalTuple: readonly (string | number | boolean | null)[],
): string {
  if (!(TENANT_PURGE_PLAN_DOMAINS as readonly string[]).includes(domain)) {
    throw new Error("tenant purge plan domain is invalid");
  }
  return sha256(["tenant-purge-plan-target-v1", domain, canonicalTuple]);
}

export function tenantPurgePlanTargetRootSha256(
  domain: TenantPurgePlanDomain,
  targetSha256s: readonly string[],
): string {
  if (!(TENANT_PURGE_PLAN_DOMAINS as readonly string[]).includes(domain)) {
    throw new Error("tenant purge plan domain is invalid");
  }
  for (const digest of targetSha256s) assertSha256(digest, "tenant purge plan target hash");
  const ordered = [...targetSha256s].sort();
  if (new Set(ordered).size !== ordered.length) {
    throw new Error("tenant purge plan target hash is duplicated");
  }
  return sha256(["tenant-purge-plan-target-root-v1", domain, ...ordered]);
}

export const EMPTY_TENANT_PURGE_PLAN_ENTRY_ROOT_SHA256 = sha256([
  "tenant-purge-plan-entry-chain-v1",
]);
export const EMPTY_TENANT_PURGE_PLAN_BLOCKER_ROOT_SHA256 = sha256([
  "tenant-purge-plan-blocker-chain-v1",
]);

export function tenantPurgePlanNextEntryRootSha256(
  previousRootSha256: string,
  domain: TenantPurgePlanDomain,
  receiptSha256: string,
): string {
  assertSha256(previousRootSha256, "tenant purge plan previous entry root");
  assertSha256(receiptSha256, "tenant purge plan entry hash");
  return sha256(["tenant-purge-plan-entry-chain-v1", previousRootSha256, domain, receiptSha256]);
}

export function tenantPurgePlanNextBlockerRootSha256(
  previousRootSha256: string,
  domain: TenantPurgePlanDomain,
  disposition: TenantPurgePlanBlockingDisposition,
  receiptSha256: string,
): string {
  assertSha256(previousRootSha256, "tenant purge plan previous blocker root");
  if (!isTenantPurgePlanBlockingDisposition(disposition)) {
    throw new Error("tenant purge plan blocker disposition is invalid");
  }
  assertSha256(receiptSha256, "tenant purge plan blocker entry hash");
  return sha256([
    "tenant-purge-plan-blocker-chain-v1",
    previousRootSha256,
    domain,
    disposition,
    receiptSha256,
  ]);
}

export function tenantPurgePlanEntryRootSha256(entries: readonly TenantPurgePlanEntry[]): string {
  const sorted = [...entries].sort((left, right) => (
    tenantPurgePlanDomainOrdinal(left.domain) - tenantPurgePlanDomainOrdinal(right.domain)
  ));
  if (new Set(sorted.map((entry) => entry.domain)).size !== sorted.length) {
    throw new Error("tenant purge plan domain is duplicated");
  }
  let root = EMPTY_TENANT_PURGE_PLAN_ENTRY_ROOT_SHA256;
  for (const entry of sorted) {
    validateTenantPurgePlanEntry(entry);
    root = tenantPurgePlanNextEntryRootSha256(root, entry.domain, entry.receiptSha256);
  }
  return root;
}

export function tenantPurgePlanBlockerRootSha256(
  entries: readonly TenantPurgePlanEntry[],
): string {
  const blockers = entries.filter((entry) => isTenantPurgePlanBlockingDisposition(
    entry.disposition,
  )).sort((left, right) => (
    tenantPurgePlanDomainOrdinal(left.domain) - tenantPurgePlanDomainOrdinal(right.domain)
  ));
  let root = EMPTY_TENANT_PURGE_PLAN_BLOCKER_ROOT_SHA256;
  for (const entry of blockers) {
    validateTenantPurgePlanEntry(entry);
    root = tenantPurgePlanNextBlockerRootSha256(
      root,
      entry.domain,
      entry.disposition as TenantPurgePlanBlockingDisposition,
      entry.receiptSha256,
    );
  }
  return root;
}

type TenantPurgePlanReceiptBody = Omit<TenantPurgePlanReceipt, "receiptSha256">;

export function tenantPurgePlanReceiptSha256(receipt: TenantPurgePlanReceiptBody): string {
  validateTenantPurgePlanSource(receipt);
  if (receipt.scope !== TENANT_PURGE_PLAN_RECEIPT_SCOPE) {
    throw new Error("tenant purge plan receipt scope is invalid");
  }
  if (receipt.planEntryCount !== TENANT_PURGE_PLAN_DOMAINS.length) {
    throw new Error("tenant purge plan receipt does not cover the fixed domain catalog");
  }
  assertSha256(receipt.planEntryRootSha256, "tenant purge plan entry root");
  assertCount(receipt.blockerCount, "tenant purge plan blocker count");
  if (receipt.blockerCount > receipt.planEntryCount) {
    throw new Error("tenant purge plan blocker count exceeds its entry count");
  }
  assertSha256(receipt.blockerRootSha256, "tenant purge plan blocker root");
  assertTimestamp(receipt.storeDbTimestampMs, "tenant purge plan store time");
  if (receipt.storeDbTimestampMs < receipt.sourceEvidenceDbMs) {
    throw new Error("tenant purge plan store time predates source evidence");
  }
  assertPositiveSafeInteger(receipt.completedClaimAttempt, "tenant purge plan claim attempt");
  assertSha256(receipt.completedClaimTokenSha256, "tenant purge plan claim-token hash");
  if (receipt.planComplete !== true || receipt.executionReady !== false
    || receipt.contentPurgeExecuted !== false) {
    throw new Error("tenant purge plan receipt cannot grant execution or claim purge");
  }
  return sha256([
    "tenant-purge-plan-receipt-v1",
    receipt.scope,
    receipt.requestId,
    receipt.tenantId,
    receipt.subjectGeneration,
    receipt.buildGeneration,
    receipt.t1FenceSha256,
    receipt.t3aReceiptSha256,
    receipt.t3bReceiptSha256,
    receipt.t3cReceiptSha256,
    receipt.policyVersion,
    receipt.policySha256,
    receipt.policySchemaVersion,
    receipt.retentionAnchorDbMs,
    receipt.purgeNotBeforeDbMs,
    receipt.sourceEvidenceDbMs,
    receipt.planEntryCount,
    receipt.planEntryRootSha256,
    receipt.blockerCount,
    receipt.blockerRootSha256,
    receipt.storeDbTimestampMs,
    receipt.completedClaimAttempt,
    receipt.completedClaimTokenSha256,
    receipt.planComplete,
    receipt.executionReady,
    receipt.contentPurgeExecuted,
  ]);
}

const PURGE_PLAN_ENTRY_KEYS = [
  "scope",
  "requestId",
  "buildGeneration",
  "tenantId",
  "subjectGeneration",
  "domain",
  "targetCount",
  "targetRootSha256",
  "disposition",
  "sourceSha256",
  "capturedAtDbMs",
  "receiptSha256",
] as const;

export function validateTenantPurgePlanEntry(entry: TenantPurgePlanEntry): void {
  assertExactKeys(entry, PURGE_PLAN_ENTRY_KEYS, "tenant purge plan entry");
  const expectedHash = tenantPurgePlanEntrySha256(entry);
  if (entry.targetCount === 0
    && entry.targetRootSha256 !== tenantPurgePlanTargetRootSha256(entry.domain, [])) {
    throw new Error("empty tenant purge plan target domain has a non-empty root");
  }
  assertSha256(entry.receiptSha256, "tenant purge plan entry receipt hash");
  if (entry.receiptSha256 !== expectedHash) {
    throw new Error("tenant purge plan entry receipt hash does not match its evidence");
  }
}

const PURGE_PLAN_RECEIPT_KEYS = [
  "scope",
  "requestId",
  "tenantId",
  "subjectGeneration",
  "buildGeneration",
  "t1FenceSha256",
  "t3aReceiptSha256",
  "t3bReceiptSha256",
  "t3cReceiptSha256",
  "policyVersion",
  "policySha256",
  "policySchemaVersion",
  "retentionAnchorDbMs",
  "purgeNotBeforeDbMs",
  "sourceEvidenceDbMs",
  "planEntryCount",
  "planEntryRootSha256",
  "blockerCount",
  "blockerRootSha256",
  "storeDbTimestampMs",
  "completedClaimAttempt",
  "completedClaimTokenSha256",
  "planComplete",
  "executionReady",
  "contentPurgeExecuted",
  "receiptSha256",
] as const;

export function validateTenantPurgePlanReceipt(receipt: TenantPurgePlanReceipt): void {
  assertExactKeys(receipt, PURGE_PLAN_RECEIPT_KEYS, "tenant purge plan receipt");
  const expectedHash = tenantPurgePlanReceiptSha256(receipt);
  assertSha256(receipt.receiptSha256, "tenant purge plan receipt hash");
  if (receipt.receiptSha256 !== expectedHash) {
    throw new Error("tenant purge plan receipt hash does not match its evidence");
  }
}

export function validateTenantPurgePlanJobRecord(job: TenantPurgePlanJobRecord): void {
  const commonKeys = [
    "requestId", "tenantId", "subjectGeneration", "buildGeneration", "t1FenceSha256",
    "t3aReceiptSha256", "t3bReceiptSha256", "t3cReceiptSha256", "policyVersion",
    "policySha256", "policySchemaVersion", "retentionAnchorDbMs", "purgeNotBeforeDbMs",
    "sourceEvidenceDbMs", "scanComplete", "planEntryCount", "planEntryRootSha256",
    "blockerCount", "blockerRootSha256", "phase", "attempts", "createdAtMs", "updatedAtMs",
    ...(job.cursorDomain === undefined ? [] : ["cursorDomain"]),
  ];
  if (job.phase === "queued") {
    assertExactKeys(job, [
      ...commonKeys,
      "availableAtMs",
      ...(job.claimToken === undefined ? [] : ["claimToken"]),
      ...(job.leaseUntilMs === undefined ? [] : ["leaseUntilMs"]),
      ...(job.lastErrorCode === undefined ? [] : ["lastErrorCode"]),
    ], "queued tenant purge plan job");
  } else if (job.phase === "plan_sealed") {
    assertExactKeys(job, [
      ...commonKeys,
      "planSealedAtDbMs",
      "completedClaimAttempt",
      "completedClaimTokenSha256",
      "aggregateReceiptSha256",
    ], "sealed tenant purge plan job");
  } else if (job.phase === "blocked") {
    assertExactKeys(job, [
      ...commonKeys,
      "blockedAtDbMs",
      "blockedReasonCode",
    ], "blocked tenant purge plan job");
  } else {
    throw new Error("tenant purge plan phase is invalid");
  }
  validateTenantPurgePlanSource(job);
  if (job.cursorDomain !== undefined
    && !(TENANT_PURGE_PLAN_DOMAINS as readonly string[]).includes(job.cursorDomain)) {
    throw new Error("tenant purge plan cursor is invalid");
  }
  if (typeof job.scanComplete !== "boolean") {
    throw new Error("tenant purge plan scan marker is invalid");
  }
  assertCount(job.planEntryCount, "tenant purge plan entry count");
  assertSha256(job.planEntryRootSha256, "tenant purge plan entry root");
  assertCount(job.blockerCount, "tenant purge plan blocker count");
  assertSha256(job.blockerRootSha256, "tenant purge plan blocker root");
  if ((job.planEntryCount === 0) !== (job.cursorDomain === undefined)) {
    throw new Error("tenant purge plan cursor does not match its entry count");
  }
  if (job.planEntryCount > TENANT_PURGE_PLAN_DOMAINS.length
    || job.blockerCount > job.planEntryCount) {
    throw new Error("tenant purge plan counts are invalid");
  }
  if (job.planEntryCount === 0
    && (job.planEntryRootSha256 !== EMPTY_TENANT_PURGE_PLAN_ENTRY_ROOT_SHA256
      || job.blockerRootSha256 !== EMPTY_TENANT_PURGE_PLAN_BLOCKER_ROOT_SHA256
      || job.blockerCount !== 0)) {
    throw new Error("empty tenant purge plan has non-empty roots");
  }
  if (job.scanComplete && job.planEntryCount !== TENANT_PURGE_PLAN_DOMAINS.length) {
    throw new Error("completed tenant purge plan does not cover the fixed domain catalog");
  }
  assertCount(job.attempts, "tenant purge plan attempts");
  assertTimestamp(job.createdAtMs, "tenant purge plan creation timestamp");
  assertTimestamp(job.updatedAtMs, "tenant purge plan update timestamp");
  if (job.updatedAtMs < job.createdAtMs) throw new Error("tenant purge plan timestamps are invalid");

  if (job.phase === "queued") {
    assertTimestamp(job.availableAtMs, "tenant purge plan availability");
    if (job.availableAtMs < job.createdAtMs) {
      throw new Error("tenant purge plan availability is invalid");
    }
    if ((job.claimToken === undefined) !== (job.leaseUntilMs === undefined)) {
      throw new Error("tenant purge plan claim is incomplete");
    }
    if (job.claimToken !== undefined) {
      assertTenantPurgePlanClaimToken(job.claimToken);
      assertTimestamp(job.leaseUntilMs!, "tenant purge plan lease");
      if (job.attempts < 1) throw new Error("tenant purge plan claim has no attempt");
      if (job.leaseUntilMs! < job.updatedAtMs) {
        throw new Error("tenant purge plan lease predates its update timestamp");
      }
    } else if (job.availableAtMs < job.updatedAtMs) {
      throw new Error("tenant purge plan availability predates its update timestamp");
    }
    if (job.lastErrorCode !== undefined && job.lastErrorCode !== "temporary_failure") {
      throw new Error("tenant purge plan retry error is invalid");
    }
    if (job.claimToken !== undefined && job.lastErrorCode !== undefined) {
      throw new Error("claimed tenant purge plan retains a retry error");
    }
    return;
  }
  if (job.phase === "plan_sealed") {
    if (!job.scanComplete) throw new Error("sealed tenant purge plan has an incomplete scan");
    assertTimestamp(job.planSealedAtDbMs, "tenant purge plan seal timestamp");
    if (job.planSealedAtDbMs < job.sourceEvidenceDbMs
      || job.planSealedAtDbMs > job.updatedAtMs) {
      throw new Error("tenant purge plan seal timestamp is invalid");
    }
    assertPositiveSafeInteger(job.completedClaimAttempt, "tenant purge plan completion attempt");
    assertSha256(job.completedClaimTokenSha256, "tenant purge plan completion token hash");
    assertSha256(job.aggregateReceiptSha256, "tenant purge plan aggregate receipt hash");
    if (job.completedClaimAttempt !== job.attempts) {
      throw new Error("tenant purge plan completion attempt does not match attempts");
    }
    return;
  }
  if (job.phase === "blocked") {
    assertTimestamp(job.blockedAtDbMs, "tenant purge plan blocked timestamp");
    if (job.blockedAtDbMs < job.createdAtMs || job.blockedAtDbMs > job.updatedAtMs) {
      throw new Error("tenant purge plan blocked timestamp is invalid");
    }
    if (job.attempts < 1) throw new Error("blocked tenant purge plan has no attempt");
    if (job.blockedReasonCode !== "integrity_conflict") {
      throw new Error("tenant purge plan blocked reason is invalid");
    }
    return;
  }
  throw new Error("tenant purge plan phase is invalid");
}

export function tenantPurgePlanClaimFromJob(
  job: TenantPurgePlanJobRecord,
): TenantPurgePlanClaim {
  validateTenantPurgePlanJobRecord(job);
  if (job.phase !== "queued" || job.claimToken === undefined || job.leaseUntilMs === undefined) {
    throw new Error("tenant purge plan job is not claimed");
  }
  return {
    requestId: job.requestId,
    tenantId: job.tenantId,
    subjectGeneration: job.subjectGeneration,
    buildGeneration: job.buildGeneration,
    t1FenceSha256: job.t1FenceSha256,
    t3aReceiptSha256: job.t3aReceiptSha256,
    t3bReceiptSha256: job.t3bReceiptSha256,
    t3cReceiptSha256: job.t3cReceiptSha256,
    policyVersion: job.policyVersion,
    policySha256: job.policySha256,
    policySchemaVersion: job.policySchemaVersion,
    retentionAnchorDbMs: job.retentionAnchorDbMs,
    purgeNotBeforeDbMs: job.purgeNotBeforeDbMs,
    sourceEvidenceDbMs: job.sourceEvidenceDbMs,
    phase: "queued",
    claimAttempt: job.attempts,
    claimToken: job.claimToken,
    leaseUntilMs: job.leaseUntilMs,
  };
}

export function tenantPurgePlanAuthorizationMatches(
  job: TenantPurgePlanJobRecord,
  authorization: TenantPurgePlanAuthorization,
  databaseNowMs: number,
): boolean {
  validateTenantPurgePlanJobRecord(job);
  validateTenantPurgePlanAuthorization(authorization);
  assertTimestamp(databaseNowMs, "tenant purge plan database timestamp");
  return job.phase === "queued"
    && job.requestId === authorization.requestId
    && job.tenantId === authorization.tenantId
    && job.subjectGeneration === authorization.subjectGeneration
    && job.buildGeneration === authorization.buildGeneration
    && job.attempts === authorization.claimAttempt
    && job.claimToken === authorization.claimToken
    && job.leaseUntilMs !== undefined
    && job.leaseUntilMs > databaseNowMs;
}

export function tenantPurgePlanReceiptMatchesAuthorization(
  receipt: TenantPurgePlanReceipt,
  authorization: TenantPurgePlanAuthorization,
): boolean {
  validateTenantPurgePlanReceipt(receipt);
  validateTenantPurgePlanAuthorization(authorization);
  return receipt.requestId === authorization.requestId
    && receipt.tenantId === authorization.tenantId
    && receipt.subjectGeneration === authorization.subjectGeneration
    && receipt.buildGeneration === authorization.buildGeneration
    && receipt.completedClaimAttempt === authorization.claimAttempt
    && receipt.completedClaimTokenSha256
      === tenantPurgePlanClaimTokenSha256(authorization.claimToken);
}

/** Validate all immutable plan rows; this proves planning only and never authorizes execution. */
export function validateTenantPurgePlanCompletionProof(
  job: TenantPurgePlanJobRecord,
  entries: readonly TenantPurgePlanEntry[],
  receipt: TenantPurgePlanReceipt,
): void {
  validateTenantPurgePlanJobRecord(job);
  validateTenantPurgePlanReceipt(receipt);
  if (job.phase !== "plan_sealed") throw new Error("tenant purge plan job is not sealed");
  const sourceFields = [
    "requestId", "tenantId", "subjectGeneration", "buildGeneration", "t1FenceSha256",
    "t3aReceiptSha256", "t3bReceiptSha256", "t3cReceiptSha256", "policyVersion",
    "policySha256", "policySchemaVersion", "retentionAnchorDbMs", "purgeNotBeforeDbMs",
    "sourceEvidenceDbMs",
  ] as const;
  if (sourceFields.some((field) => job[field] !== receipt[field])) {
    throw new Error("tenant purge plan aggregate source binding is inconsistent");
  }
  if (entries.length !== TENANT_PURGE_PLAN_DOMAINS.length) {
    throw new Error("tenant purge plan does not cover the fixed domain catalog");
  }
  const domains = new Set<TenantPurgePlanDomain>();
  for (const entry of entries) {
    validateTenantPurgePlanEntry(entry);
    if (entry.requestId !== job.requestId || entry.tenantId !== job.tenantId
      || entry.subjectGeneration !== job.subjectGeneration
      || entry.buildGeneration !== job.buildGeneration
      || entry.capturedAtDbMs < job.retentionAnchorDbMs
      || entry.capturedAtDbMs > receipt.storeDbTimestampMs
      || entry.sourceSha256 !== tenantPurgePlanDomainSourceSha256(job, entry.domain)) {
      throw new Error("tenant purge plan entry source binding is inconsistent");
    }
    domains.add(entry.domain);
  }
  if (domains.size !== entries.length) {
    throw new Error("tenant purge plan domain is duplicated");
  }
  if (TENANT_PURGE_PLAN_DOMAINS.some((domain) => !domains.has(domain))) {
    throw new Error("tenant purge plan fixed domain catalog is incomplete");
  }
  const entryRoot = tenantPurgePlanEntryRootSha256(entries);
  const blockerRoot = tenantPurgePlanBlockerRootSha256(entries);
  const blockerCount = entries.filter((entry) => (
    isTenantPurgePlanBlockingDisposition(entry.disposition)
  )).length;
  if (job.planEntryCount !== entries.length || receipt.planEntryCount !== entries.length
    || job.planEntryRootSha256 !== entryRoot || receipt.planEntryRootSha256 !== entryRoot
    || job.blockerCount !== blockerCount || receipt.blockerCount !== blockerCount
    || job.blockerRootSha256 !== blockerRoot || receipt.blockerRootSha256 !== blockerRoot
    || job.planSealedAtDbMs !== receipt.storeDbTimestampMs
    || job.completedClaimAttempt !== receipt.completedClaimAttempt
    || job.completedClaimTokenSha256 !== receipt.completedClaimTokenSha256
    || job.aggregateReceiptSha256 !== receipt.receiptSha256
    || receipt.executionReady !== false || receipt.contentPurgeExecuted !== false) {
    throw new Error("tenant purge plan completion proof is inconsistent");
  }
}
