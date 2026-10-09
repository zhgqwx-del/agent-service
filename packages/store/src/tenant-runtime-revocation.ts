import { createHash } from "node:crypto";
import {
  TenantRuntimeRevocationFleetProof as TenantRuntimeRevocationFleetProofSchema,
  TenantRuntimeRevocationLocalReceipt as TenantRuntimeRevocationLocalReceiptSchema,
  tenantRuntimeFleetSha256 as protocolTenantRuntimeFleetSha256,
  tenantRuntimeLocalReceiptSha256,
  tenantRuntimeTargetReceiptsSha256 as protocolTenantRuntimeTargetReceiptsSha256,
  type TenantRuntimeRevocationFleetProof,
  type TenantRuntimeRevocationLocalReceipt,
} from "@agent-service/protocol";

export type {
  TenantRuntimeRevocationFleetProof,
  TenantRuntimeRevocationLocalReceipt,
} from "@agent-service/protocol";

export const TENANT_RUNTIME_REVOCATION_TARGET_SCOPE =
  "configured-runner-runtime-v1" as const;
export const TENANT_RUNTIME_REVOCATION_RECEIPT_SCOPE =
  "configured-fleet-runtime-v1" as const;
export const TENANT_RUNTIME_REVOCATION_MEMORY_DISPOSITION =
  "references_dropped_not_zeroized" as const;
export const TENANT_RUNTIME_REVOCATION_EXTERNAL_DISPOSITION = "not_supported" as const;

export type TenantRuntimeRevocationJobPhase =
  | "queued"
  | "configured_fleet_quiesced"
  | "blocked";
export type TenantRuntimeRevocationRetryErrorCode = "temporary_failure";
export type TenantRuntimeRevocationBlockReasonCode = "integrity_conflict";

const ERASURE_REQUEST_ID =
  /^erase_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLAIM_TOKEN = /^[A-Za-z0-9._:~-]{1,128}$/;
const INSTANCE_ID = /^[A-Za-z0-9._:~-]{1,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_TARGETS = 100;

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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

export interface TenantRuntimeRevocationIdentity {
  requestId: string;
  tenantId: string;
  subjectGeneration: number;
}

export function validateTenantRuntimeRevocationIdentity(
  input: TenantRuntimeRevocationIdentity,
): void {
  if (!ERASURE_REQUEST_ID.test(input.requestId)) {
    throw new Error("invalid tenant runtime revocation request id");
  }
  if (!input.tenantId || input.tenantId.length > 128) {
    throw new Error("invalid tenant runtime revocation tenant id");
  }
  assertPositiveSafeInteger(
    input.subjectGeneration,
    "tenant runtime revocation subject generation",
  );
}

export interface TenantRuntimeRevocationJobBase extends TenantRuntimeRevocationIdentity {
  t1FenceSha256: string;
  t3aReceiptSha256: string;
  phase: TenantRuntimeRevocationJobPhase;
  attempts: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export type TenantRuntimeRevocationJobRecord = TenantRuntimeRevocationJobBase & (
  | {
      phase: "queued";
      availableAtMs: number;
      claimToken?: string;
      leaseUntilMs?: number;
      lastErrorCode?: TenantRuntimeRevocationRetryErrorCode;
      configuredFleetQuiescedAtMs?: never;
      completedClaimAttempt?: never;
      completedClaimTokenSha256?: never;
      blockedAtMs?: never;
      blockedReasonCode?: never;
    }
  | {
      phase: "configured_fleet_quiesced";
      availableAtMs?: never;
      claimToken?: never;
      leaseUntilMs?: never;
      lastErrorCode?: never;
      configuredFleetQuiescedAtMs: number;
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
      configuredFleetQuiescedAtMs?: never;
      completedClaimAttempt?: never;
      completedClaimTokenSha256?: never;
      blockedAtMs: number;
      blockedReasonCode: TenantRuntimeRevocationBlockReasonCode;
    }
);

export interface MaterializeTenantRuntimeRevocationJobsOptions { limit: number }
export interface ClaimTenantRuntimeRevocationsOptions {
  limit: number;
  leaseMs: number;
  claimToken: string;
}
export interface RenewTenantRuntimeRevocationOptions { leaseMs: number }
export interface RetryTenantRuntimeRevocationOptions {
  delayMs: number;
  errorCode: TenantRuntimeRevocationRetryErrorCode;
}

export interface TenantRuntimeRevocationClaim extends TenantRuntimeRevocationIdentity {
  t1FenceSha256: string;
  t3aReceiptSha256: string;
  phase: "queued";
  claimAttempt: number;
  claimToken: string;
  leaseUntilMs: number;
}

export type TenantRuntimeRevocationAuthorization = Pick<
  TenantRuntimeRevocationClaim,
  "requestId" | "tenantId" | "subjectGeneration" | "claimAttempt" | "claimToken"
>;

/** Durable target evidence stores hashes of process identities, never raw topology labels. */
export interface TenantRuntimeRevocationTargetReceipt extends TenantRuntimeRevocationIdentity {
  scope: typeof TENANT_RUNTIME_REVOCATION_TARGET_SCOPE;
  targetSha256: string;
  runnerIdSha256: string;
  bootIdSha256: string;
  t1FenceSha256: string;
  t3aReceiptSha256: string;
  fleetSha256: string;
  cacheEntryCountBefore: number;
  cacheEntryCountAfter: 0;
  activeOperationCountBefore: number;
  activeOperationCountAfter: 0;
  activeTurnCountBefore: number;
  activeTurnCountAfter: 0;
  runnerCompletedAtMs: number;
  localReceiptSha256: string;
  completedClaimAttempt: number;
  completedClaimTokenSha256: string;
  evidenceSha256: string;
}

export interface TenantRuntimeRevocationReceipt extends TenantRuntimeRevocationIdentity {
  scope: typeof TENANT_RUNTIME_REVOCATION_RECEIPT_SCOPE;
  t1FenceSha256: string;
  t3aReceiptSha256: string;
  fleetSha256: string;
  targetCount: number;
  targetReceiptsSha256: string;
  storeDbTimestampMs: number;
  completedClaimAttempt: number;
  completedClaimTokenSha256: string;
  memoryDisposition: typeof TENANT_RUNTIME_REVOCATION_MEMORY_DISPOSITION;
  externalDisposition: typeof TENANT_RUNTIME_REVOCATION_EXTERNAL_DISPOSITION;
  contentPurgeRequired: true;
  receiptSha256: string;
}

export interface TenantRuntimeRevocationStore {
  materializeTenantRuntimeRevocationJobs(
    options: MaterializeTenantRuntimeRevocationJobsOptions,
  ): Promise<number>;
  claimTenantRuntimeRevocations(
    options: ClaimTenantRuntimeRevocationsOptions,
  ): Promise<TenantRuntimeRevocationClaim[]>;
  renewTenantRuntimeRevocation(
    authorization: TenantRuntimeRevocationAuthorization,
    options: RenewTenantRuntimeRevocationOptions,
  ): Promise<boolean>;
  retryTenantRuntimeRevocation(
    authorization: TenantRuntimeRevocationAuthorization,
    options: RetryTenantRuntimeRevocationOptions,
  ): Promise<boolean>;
  blockTenantRuntimeRevocation(
    authorization: TenantRuntimeRevocationAuthorization,
  ): Promise<boolean>;
  completeTenantRuntimeRevocation(
    authorization: TenantRuntimeRevocationAuthorization,
    proof: TenantRuntimeRevocationFleetProof,
  ): Promise<TenantRuntimeRevocationReceipt | null>;
  getTenantRuntimeRevocationJob(
    tenantId: string,
    requestId: string,
  ): Promise<TenantRuntimeRevocationJobRecord | null>;
  getTenantRuntimeRevocationTargetReceipts(
    tenantId: string,
    requestId: string,
  ): Promise<TenantRuntimeRevocationTargetReceipt[]>;
  getTenantRuntimeRevocationReceipt(
    tenantId: string,
    requestId: string,
  ): Promise<TenantRuntimeRevocationReceipt | null>;
}

export function validateMaterializeTenantRuntimeRevocationJobsOptions(
  options: MaterializeTenantRuntimeRevocationJobsOptions,
): void {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new Error("tenant runtime revocation materialization limit must be between 1 and 100");
  }
}

export function assertTenantRuntimeRevocationClaimToken(claimToken: string): void {
  if (!CLAIM_TOKEN.test(claimToken)) {
    throw new Error("tenant runtime revocation claim token is invalid");
  }
}

export function tenantRuntimeRevocationClaimTokenSha256(claimToken: string): string {
  assertTenantRuntimeRevocationClaimToken(claimToken);
  return sha256(["tenant-runtime-revocation-claim-token-v1", claimToken]);
}

export function validateClaimTenantRuntimeRevocationsOptions(
  options: ClaimTenantRuntimeRevocationsOptions,
): void {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new Error("tenant runtime revocation claim limit must be between 1 and 100");
  }
  if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs <= 0) {
    throw new Error("tenant runtime revocation lease must be a positive safe integer");
  }
  assertTenantRuntimeRevocationClaimToken(options.claimToken);
}

export function validateTenantRuntimeRevocationAuthorization(
  authorization: TenantRuntimeRevocationAuthorization,
): void {
  validateTenantRuntimeRevocationIdentity(authorization);
  assertPositiveSafeInteger(authorization.claimAttempt, "tenant runtime revocation claim attempt");
  assertTenantRuntimeRevocationClaimToken(authorization.claimToken);
}

export function validateRenewTenantRuntimeRevocationOptions(
  options: RenewTenantRuntimeRevocationOptions,
): void {
  if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs <= 0) {
    throw new Error("tenant runtime revocation renewal lease must be a positive safe integer");
  }
}

export function validateRetryTenantRuntimeRevocationOptions(
  options: RetryTenantRuntimeRevocationOptions,
): void {
  if (!Number.isSafeInteger(options.delayMs) || options.delayMs < 0) {
    throw new Error("tenant runtime revocation retry delay must be a non-negative safe integer");
  }
  if (options.errorCode !== "temporary_failure") {
    throw new Error("tenant runtime revocation retry error is invalid");
  }
}

export function validateTenantRuntimeRevocationJobRecord(
  record: TenantRuntimeRevocationJobRecord,
): void {
  validateTenantRuntimeRevocationIdentity(record);
  assertSha256(record.t1FenceSha256, "tenant runtime revocation T1 fence hash");
  assertSha256(record.t3aReceiptSha256, "tenant runtime revocation T3a receipt hash");
  assertCount(record.attempts, "tenant runtime revocation attempts");
  assertTimestamp(record.createdAtMs, "tenant runtime revocation creation timestamp");
  assertTimestamp(record.updatedAtMs, "tenant runtime revocation update timestamp");
  if (record.updatedAtMs < record.createdAtMs) throw new Error("tenant runtime revocation timestamps are invalid");
  if (record.phase === "queued") {
    assertTimestamp(record.availableAtMs, "tenant runtime revocation availability");
    if (record.availableAtMs < record.createdAtMs) throw new Error("tenant runtime revocation availability is invalid");
    if ((record.claimToken === undefined) !== (record.leaseUntilMs === undefined)) {
      throw new Error("tenant runtime revocation claim is incomplete");
    }
    if (record.claimToken !== undefined) {
      assertTenantRuntimeRevocationClaimToken(record.claimToken);
      assertTimestamp(record.leaseUntilMs!, "tenant runtime revocation lease");
      if (record.attempts < 1) throw new Error("tenant runtime revocation claim has no attempt");
    }
    if (record.lastErrorCode !== undefined && record.lastErrorCode !== "temporary_failure") {
      throw new Error("tenant runtime revocation retry error is invalid");
    }
    return;
  }
  if (record.phase === "configured_fleet_quiesced") {
    assertTimestamp(record.configuredFleetQuiescedAtMs, "tenant runtime revocation completion timestamp");
    if (
      record.configuredFleetQuiescedAtMs < record.createdAtMs
      || record.configuredFleetQuiescedAtMs > record.updatedAtMs
    ) {
      throw new Error("tenant runtime revocation completion timestamp is invalid");
    }
    assertPositiveSafeInteger(record.completedClaimAttempt, "tenant runtime revocation completion attempt");
    assertSha256(record.completedClaimTokenSha256, "tenant runtime revocation completion token hash");
    if (record.completedClaimAttempt !== record.attempts) {
      throw new Error("tenant runtime revocation completion attempt does not match attempts");
    }
    return;
  }
  if (record.phase === "blocked") {
    assertTimestamp(record.blockedAtMs, "tenant runtime revocation blocked timestamp");
    if (
      record.blockedAtMs < record.createdAtMs
      || record.blockedAtMs > record.updatedAtMs
      || record.attempts < 1
    ) {
      throw new Error("tenant runtime revocation blocked state is invalid");
    }
    if (record.blockedReasonCode !== "integrity_conflict") {
      throw new Error("tenant runtime revocation blocked reason is invalid");
    }
    return;
  }
  throw new Error("tenant runtime revocation phase is invalid");
}

export function tenantRuntimeRevocationClaimFromJob(
  record: TenantRuntimeRevocationJobRecord,
): TenantRuntimeRevocationClaim {
  validateTenantRuntimeRevocationJobRecord(record);
  if (record.phase !== "queued" || record.claimToken === undefined || record.leaseUntilMs === undefined) {
    throw new Error("tenant runtime revocation job is not claimed");
  }
  return {
    requestId: record.requestId,
    tenantId: record.tenantId,
    subjectGeneration: record.subjectGeneration,
    t1FenceSha256: record.t1FenceSha256,
    t3aReceiptSha256: record.t3aReceiptSha256,
    phase: "queued",
    claimAttempt: record.attempts,
    claimToken: record.claimToken,
    leaseUntilMs: record.leaseUntilMs,
  };
}

export function tenantRuntimeRevocationAuthorizationMatches(
  record: TenantRuntimeRevocationJobRecord,
  authorization: TenantRuntimeRevocationAuthorization,
  databaseNowMs: number,
): boolean {
  validateTenantRuntimeRevocationJobRecord(record);
  validateTenantRuntimeRevocationAuthorization(authorization);
  assertTimestamp(databaseNowMs, "tenant runtime revocation database timestamp");
  return record.phase === "queued"
    && record.requestId === authorization.requestId
    && record.tenantId === authorization.tenantId
    && record.subjectGeneration === authorization.subjectGeneration
    && record.attempts === authorization.claimAttempt
    && record.claimToken === authorization.claimToken
    && record.leaseUntilMs !== undefined
    && record.leaseUntilMs > databaseNowMs;
}

function validateInstanceId(value: string, name: string): void {
  if (!INSTANCE_ID.test(value)) throw new Error(`${name} is invalid`);
}

export function tenantRuntimeRevocationRunnerIdSha256(runnerId: string): string {
  validateInstanceId(runnerId, "tenant runtime runner id");
  return sha256(["tenant-runtime-runner-id-v1", runnerId]);
}

export function tenantRuntimeRevocationBootIdSha256(bootId: string): string {
  validateInstanceId(bootId, "tenant runtime boot id");
  return sha256(["tenant-runtime-boot-id-v1", bootId]);
}

export function tenantRuntimeRevocationLocalReceiptSha256(
  receipt: Omit<TenantRuntimeRevocationLocalReceipt, "receiptSha256">,
): string {
  return tenantRuntimeLocalReceiptSha256(receipt);
}

export function validateTenantRuntimeRevocationLocalReceipt(
  receipt: TenantRuntimeRevocationLocalReceipt,
): void {
  TenantRuntimeRevocationLocalReceiptSchema.parse(receipt);
}

export function tenantRuntimeRevocationFleetSha256(targetSha256s: readonly string[]): string {
  if (targetSha256s.length < 1 || targetSha256s.length > MAX_TARGETS) {
    throw new Error("tenant runtime fleet target count is invalid");
  }
  const targets = targetSha256s.map((targetSha256) => ({ targetSha256 }));
  const unique = new Set(targetSha256s);
  if (unique.size !== targetSha256s.length) {
    throw new Error("tenant runtime fleet target is duplicated");
  }
  return protocolTenantRuntimeFleetSha256(targets);
}

export function tenantRuntimeRevocationTargetReceiptsSha256(
  receipts: readonly Pick<TenantRuntimeRevocationLocalReceipt, "targetSha256" | "receiptSha256">[],
): string {
  if (receipts.length < 1 || receipts.length > MAX_TARGETS) {
    throw new Error("tenant runtime target receipt count is invalid");
  }
  if (new Set(receipts.map((value) => value.targetSha256)).size !== receipts.length) {
    throw new Error("tenant runtime target receipt is duplicated");
  }
  return protocolTenantRuntimeTargetReceiptsSha256(receipts);
}

export function validateTenantRuntimeRevocationFleetProof(
  proof: TenantRuntimeRevocationFleetProof,
  expected: TenantRuntimeRevocationJobRecord,
): void {
  validateTenantRuntimeRevocationJobRecord(expected);
  const parsed = TenantRuntimeRevocationFleetProofSchema.parse(proof);
  for (const receipt of parsed.targets) {
    if (
      receipt.requestId !== expected.requestId
      || receipt.tenantId !== expected.tenantId
      || receipt.subjectGeneration !== expected.subjectGeneration
      || receipt.t3aReceiptSha256 !== expected.t3aReceiptSha256
    ) throw new Error("tenant runtime local receipt source binding is invalid");
  }
}

type TargetReceiptBody = Omit<TenantRuntimeRevocationTargetReceipt, "evidenceSha256">;

export function tenantRuntimeRevocationTargetEvidenceSha256(
  receipt: TargetReceiptBody,
): string {
  validateTenantRuntimeRevocationIdentity(receipt);
  return sha256([
    "tenant-runtime-target-evidence-v1",
    receipt.scope,
    receipt.requestId,
    receipt.tenantId,
    receipt.subjectGeneration,
    receipt.targetSha256,
    receipt.runnerIdSha256,
    receipt.bootIdSha256,
    receipt.t1FenceSha256,
    receipt.t3aReceiptSha256,
    receipt.fleetSha256,
    receipt.cacheEntryCountBefore,
    receipt.cacheEntryCountAfter,
    receipt.activeOperationCountBefore,
    receipt.activeOperationCountAfter,
    receipt.activeTurnCountBefore,
    receipt.activeTurnCountAfter,
    receipt.runnerCompletedAtMs,
    receipt.localReceiptSha256,
    receipt.completedClaimAttempt,
    receipt.completedClaimTokenSha256,
  ]);
}

export function validateTenantRuntimeRevocationTargetReceipt(
  receipt: TenantRuntimeRevocationTargetReceipt,
): void {
  validateTenantRuntimeRevocationIdentity(receipt);
  if (receipt.scope !== TENANT_RUNTIME_REVOCATION_TARGET_SCOPE) throw new Error("tenant runtime target scope is invalid");
  for (const [value, name] of [
    [receipt.targetSha256, "target"],
    [receipt.runnerIdSha256, "runner id"],
    [receipt.bootIdSha256, "boot id"],
    [receipt.t1FenceSha256, "T1 fence"],
    [receipt.t3aReceiptSha256, "T3a receipt"],
    [receipt.fleetSha256, "fleet"],
    [receipt.localReceiptSha256, "local receipt"],
    [receipt.completedClaimTokenSha256, "completion token"],
    [receipt.evidenceSha256, "evidence"],
  ] as const) assertSha256(value, `tenant runtime ${name} hash`);
  assertCount(receipt.cacheEntryCountBefore, "tenant runtime cache before count");
  assertCount(receipt.activeOperationCountBefore, "tenant runtime operation before count");
  assertCount(receipt.activeTurnCountBefore, "tenant runtime turn before count");
  if (receipt.cacheEntryCountAfter !== 0 || receipt.activeOperationCountAfter !== 0 || receipt.activeTurnCountAfter !== 0) {
    throw new Error("tenant runtime target receipt is not quiesced");
  }
  assertTimestamp(receipt.runnerCompletedAtMs, "tenant runtime runner completion timestamp");
  assertPositiveSafeInteger(receipt.completedClaimAttempt, "tenant runtime target completion attempt");
  if (receipt.evidenceSha256 !== tenantRuntimeRevocationTargetEvidenceSha256(receipt)) {
    throw new Error("tenant runtime target evidence hash does not match");
  }
}

type RuntimeReceiptBody = Omit<TenantRuntimeRevocationReceipt, "receiptSha256">;

export function tenantRuntimeRevocationReceiptSha256(receipt: RuntimeReceiptBody): string {
  validateTenantRuntimeRevocationIdentity(receipt);
  return sha256([
    "tenant-runtime-revocation-receipt-v1",
    receipt.scope,
    receipt.requestId,
    receipt.tenantId,
    receipt.subjectGeneration,
    receipt.t1FenceSha256,
    receipt.t3aReceiptSha256,
    receipt.fleetSha256,
    receipt.targetCount,
    receipt.targetReceiptsSha256,
    receipt.storeDbTimestampMs,
    receipt.completedClaimAttempt,
    receipt.completedClaimTokenSha256,
    receipt.memoryDisposition,
    receipt.externalDisposition,
    receipt.contentPurgeRequired,
  ]);
}

export function validateTenantRuntimeRevocationReceipt(
  receipt: TenantRuntimeRevocationReceipt,
): void {
  validateTenantRuntimeRevocationIdentity(receipt);
  if (receipt.scope !== TENANT_RUNTIME_REVOCATION_RECEIPT_SCOPE) throw new Error("tenant runtime receipt scope is invalid");
  for (const [value, name] of [
    [receipt.t1FenceSha256, "T1 fence"],
    [receipt.t3aReceiptSha256, "T3a receipt"],
    [receipt.fleetSha256, "fleet"],
    [receipt.targetReceiptsSha256, "target receipts"],
    [receipt.completedClaimTokenSha256, "completion token"],
    [receipt.receiptSha256, "receipt"],
  ] as const) assertSha256(value, `tenant runtime ${name} hash`);
  assertPositiveSafeInteger(receipt.targetCount, "tenant runtime target count");
  if (receipt.targetCount > MAX_TARGETS) throw new Error("tenant runtime target count is invalid");
  assertTimestamp(receipt.storeDbTimestampMs, "tenant runtime store timestamp");
  assertPositiveSafeInteger(receipt.completedClaimAttempt, "tenant runtime completion attempt");
  if (
    receipt.memoryDisposition !== TENANT_RUNTIME_REVOCATION_MEMORY_DISPOSITION
    || receipt.externalDisposition !== TENANT_RUNTIME_REVOCATION_EXTERNAL_DISPOSITION
    || receipt.contentPurgeRequired !== true
  ) throw new Error("tenant runtime receipt disposition is invalid");
  if (receipt.receiptSha256 !== tenantRuntimeRevocationReceiptSha256(receipt)) {
    throw new Error("tenant runtime receipt hash does not match its evidence");
  }
}

export function tenantRuntimeRevocationTargetReceiptFromLocal(
  local: TenantRuntimeRevocationLocalReceipt,
  job: TenantRuntimeRevocationJobRecord,
  authorization: TenantRuntimeRevocationAuthorization,
  fleetSha256: string,
): TenantRuntimeRevocationTargetReceipt {
  validateTenantRuntimeRevocationLocalReceipt(local);
  validateTenantRuntimeRevocationJobRecord(job);
  validateTenantRuntimeRevocationAuthorization(authorization);
  assertSha256(fleetSha256, "tenant runtime fleet hash");
  if (
    local.requestId !== job.requestId
    || local.tenantId !== job.tenantId
    || local.subjectGeneration !== job.subjectGeneration
    || local.t3aReceiptSha256 !== job.t3aReceiptSha256
    || authorization.requestId !== job.requestId
    || authorization.tenantId !== job.tenantId
    || authorization.subjectGeneration !== job.subjectGeneration
  ) throw new Error("tenant runtime target source binding is invalid");
  const body: TargetReceiptBody = {
    scope: TENANT_RUNTIME_REVOCATION_TARGET_SCOPE,
    requestId: job.requestId,
    tenantId: job.tenantId,
    subjectGeneration: job.subjectGeneration,
    targetSha256: local.targetSha256,
    runnerIdSha256: tenantRuntimeRevocationRunnerIdSha256(local.runnerId),
    bootIdSha256: tenantRuntimeRevocationBootIdSha256(local.bootId),
    t1FenceSha256: job.t1FenceSha256,
    t3aReceiptSha256: job.t3aReceiptSha256,
    fleetSha256,
    cacheEntryCountBefore: local.cacheEntryCountBefore,
    cacheEntryCountAfter: 0,
    activeOperationCountBefore: local.activeOperationCountBefore,
    activeOperationCountAfter: 0,
    activeTurnCountBefore: local.activeTurnCountBefore,
    activeTurnCountAfter: 0,
    runnerCompletedAtMs: local.completedAtMs,
    localReceiptSha256: local.receiptSha256,
    completedClaimAttempt: authorization.claimAttempt,
    completedClaimTokenSha256: tenantRuntimeRevocationClaimTokenSha256(authorization.claimToken),
  };
  const receipt = { ...body, evidenceSha256: tenantRuntimeRevocationTargetEvidenceSha256(body) };
  validateTenantRuntimeRevocationTargetReceipt(receipt);
  return receipt;
}

export function tenantRuntimeRevocationCompletionMatchesAuthorization(
  job: TenantRuntimeRevocationJobRecord,
  authorization: TenantRuntimeRevocationAuthorization,
): boolean {
  validateTenantRuntimeRevocationJobRecord(job);
  validateTenantRuntimeRevocationAuthorization(authorization);
  return job.phase === "configured_fleet_quiesced"
    && job.requestId === authorization.requestId
    && job.tenantId === authorization.tenantId
    && job.subjectGeneration === authorization.subjectGeneration
    && job.completedClaimAttempt === authorization.claimAttempt
    && job.completedClaimTokenSha256 === tenantRuntimeRevocationClaimTokenSha256(authorization.claimToken);
}

export function validateTenantRuntimeRevocationCompletionProof(
  job: TenantRuntimeRevocationJobRecord,
  targets: readonly TenantRuntimeRevocationTargetReceipt[],
  receipt: TenantRuntimeRevocationReceipt,
): void {
  validateTenantRuntimeRevocationJobRecord(job);
  validateTenantRuntimeRevocationReceipt(receipt);
  if (job.phase !== "configured_fleet_quiesced") throw new Error("tenant runtime job is not terminal");
  if (
    receipt.requestId !== job.requestId
    || receipt.tenantId !== job.tenantId
    || receipt.subjectGeneration !== job.subjectGeneration
    || receipt.t1FenceSha256 !== job.t1FenceSha256
    || receipt.t3aReceiptSha256 !== job.t3aReceiptSha256
    || receipt.completedClaimAttempt !== job.completedClaimAttempt
    || receipt.completedClaimTokenSha256 !== job.completedClaimTokenSha256
    || receipt.storeDbTimestampMs !== job.configuredFleetQuiescedAtMs
  ) throw new Error("tenant runtime aggregate receipt does not match terminal job");
  const sorted = [...targets].sort((left, right) => left.targetSha256.localeCompare(right.targetSha256));
  if (sorted.length !== receipt.targetCount) throw new Error("tenant runtime target count is incomplete");
  const targetIds = new Set<string>();
  const runnerIds = new Set<string>();
  const bootIds = new Set<string>();
  for (const target of sorted) {
    validateTenantRuntimeRevocationTargetReceipt(target);
    if (
      target.requestId !== job.requestId
      || target.tenantId !== job.tenantId
      || target.subjectGeneration !== job.subjectGeneration
      || target.t1FenceSha256 !== job.t1FenceSha256
      || target.t3aReceiptSha256 !== job.t3aReceiptSha256
      || target.fleetSha256 !== receipt.fleetSha256
      || target.completedClaimAttempt !== job.completedClaimAttempt
      || target.completedClaimTokenSha256 !== job.completedClaimTokenSha256
      || targetIds.has(target.targetSha256)
      || runnerIds.has(target.runnerIdSha256)
      || bootIds.has(target.bootIdSha256)
    ) throw new Error("tenant runtime target receipt set is invalid");
    targetIds.add(target.targetSha256);
    runnerIds.add(target.runnerIdSha256);
    bootIds.add(target.bootIdSha256);
  }
  if (tenantRuntimeRevocationFleetSha256([...targetIds]) !== receipt.fleetSha256) {
    throw new Error("tenant runtime fleet hash does not match targets");
  }
  const rooted = tenantRuntimeRevocationTargetReceiptsSha256(sorted.map((target) => ({
    targetSha256: target.targetSha256,
    receiptSha256: target.localReceiptSha256,
  })));
  if (rooted !== receipt.targetReceiptsSha256) {
    throw new Error("tenant runtime target receipt root does not match targets");
  }
}

/**
 * Validate a response-loss retry against both immutable durable evidence and the proof submitted by
 * this call. Claim authority alone is insufficient: accepting a different fleet proof would hide a
 * caller/router proof mix-up even though the already-committed rows themselves remain intact.
 */
export function validateTenantRuntimeRevocationCompletionReplayProof(
  job: TenantRuntimeRevocationJobRecord,
  targets: readonly TenantRuntimeRevocationTargetReceipt[],
  receipt: TenantRuntimeRevocationReceipt,
  authorization: TenantRuntimeRevocationAuthorization,
  proof: TenantRuntimeRevocationFleetProof,
): void {
  validateTenantRuntimeRevocationCompletionProof(job, targets, receipt);
  if (!tenantRuntimeRevocationCompletionMatchesAuthorization(job, authorization)) {
    throw new Error("tenant runtime completion authorization does not match");
  }
  validateTenantRuntimeRevocationFleetProof(proof, job);
  if (
    proof.fleetSha256 !== receipt.fleetSha256
    || proof.targetReceiptsSha256 !== receipt.targetReceiptsSha256
    || proof.targets.length !== receipt.targetCount
  ) throw new Error("tenant runtime replay aggregate proof does not match");

  const durable = [...targets]
    .sort((left, right) => left.targetSha256.localeCompare(right.targetSha256));
  const submitted = proof.targets
    .map((local) => tenantRuntimeRevocationTargetReceiptFromLocal(
      local,
      job,
      authorization,
      proof.fleetSha256,
    ))
    .sort((left, right) => left.targetSha256.localeCompare(right.targetSha256));
  if (submitted.length !== durable.length) {
    throw new Error("tenant runtime replay target proof is incomplete");
  }
  for (let index = 0; index < durable.length; index += 1) {
    if (
      submitted[index]!.targetSha256 !== durable[index]!.targetSha256
      || submitted[index]!.evidenceSha256 !== durable[index]!.evidenceSha256
    ) throw new Error("tenant runtime replay target proof does not match");
  }
}
