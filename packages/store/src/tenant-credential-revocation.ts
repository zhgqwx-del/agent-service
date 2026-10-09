import { createHash } from "node:crypto";

export const TENANT_CREDENTIAL_REVOCATION_RECEIPT_SCOPE =
  "local-db-credential-material-v1" as const;
export const TENANT_CREDENTIAL_REVOCATION_RUNTIME_DISPOSITION = "not_in_scope" as const;
export const TENANT_CREDENTIAL_REVOCATION_EXTERNAL_DISPOSITION = "not_supported" as const;

export type TenantCredentialRevocationJobPhase =
  | "queued"
  | "credential_store_revoked"
  | "blocked";

export type TenantCredentialRevocationRetryErrorCode = "temporary_failure";
export type TenantCredentialRevocationBlockReasonCode = "integrity_conflict";

const ERASURE_REQUEST_ID =
  /^erase_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLAIM_TOKEN = /^[A-Za-z0-9._:~-]{1,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;

interface TenantCredentialRevocationJobBase {
  requestId: string;
  tenantId: string;
  subjectGeneration: number;
  /** Exact append-only T1 fence evidence consumed while materializing this job. */
  t1FenceSha256: string;
  phase: TenantCredentialRevocationJobPhase;
  attempts: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export type TenantCredentialRevocationJobRecord = TenantCredentialRevocationJobBase & (
  | {
      phase: "queued";
      availableAtMs: number;
      claimToken?: string;
      leaseUntilMs?: number;
      lastErrorCode?: TenantCredentialRevocationRetryErrorCode;
      credentialStoreRevokedAtMs?: never;
      completedClaimAttempt?: never;
      completedClaimTokenSha256?: never;
      blockedAtMs?: never;
      blockedReasonCode?: never;
    }
  | {
      phase: "credential_store_revoked";
      availableAtMs?: never;
      claimToken?: never;
      leaseUntilMs?: never;
      lastErrorCode?: never;
      credentialStoreRevokedAtMs: number;
      /** Response-loss replay is authorized only by this exact completed claim identity. */
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
      credentialStoreRevokedAtMs?: never;
      completedClaimAttempt?: never;
      completedClaimTokenSha256?: never;
      blockedAtMs: number;
      blockedReasonCode: TenantCredentialRevocationBlockReasonCode;
    }
);

/** Bounded scanner options. Materialization derives identity exclusively from durable T1 proof. */
export interface MaterializeTenantCredentialRevocationJobsOptions {
  limit: number;
}

/**
 * Claim deadlines are calculated from the database clock in the same transaction as the claim.
 * A runner wall clock is deliberately not accepted as queue authority.
 */
export interface ClaimTenantCredentialRevocationsOptions {
  limit: number;
  leaseMs: number;
  claimToken: string;
}

export interface TenantCredentialRevocationClaim {
  requestId: string;
  tenantId: string;
  subjectGeneration: number;
  t1FenceSha256: string;
  phase: "queued";
  claimAttempt: number;
  claimToken: string;
  leaseUntilMs: number;
}

export type TenantCredentialRevocationAuthorization = Pick<
  TenantCredentialRevocationClaim,
  | "requestId"
  | "tenantId"
  | "subjectGeneration"
  | "claimAttempt"
  | "claimToken"
>;

/** Renewal also uses the database clock; only the duration crosses the store boundary. */
export interface RenewTenantCredentialRevocationOptions {
  leaseMs: number;
}

/** Retry availability is `database_now + delayMs`, never a caller-supplied timestamp. */
export interface RetryTenantCredentialRevocationOptions {
  delayMs: number;
  errorCode: TenantCredentialRevocationRetryErrorCode;
}

export interface TenantCredentialRevocationReceipt {
  scope: typeof TENANT_CREDENTIAL_REVOCATION_RECEIPT_SCOPE;
  requestId: string;
  tenantId: string;
  subjectGeneration: number;
  t1FenceSha256: string;
  apiKeyCountBefore: number;
  apiKeyCountAfter: 0;
  providerConfigCountBefore: number;
  providerConfigCountAfter: 0;
  authPolicyPresentBefore: boolean;
  authPolicyPresentAfter: false;
  authSecretCipherPresentBefore: boolean;
  authSecretCipherPresentAfter: false;
  authSecretKeyIdPresentBefore: boolean;
  authSecretKeyIdPresentAfter: false;
  /** Commit timestamp read from MySQL in the revocation transaction. */
  storeDbTimestampMs: number;
  completedClaimAttempt: number;
  /** One-way hash only. The worker claim token is never copied into durable evidence. */
  completedClaimTokenSha256: string;
  runtimeDisposition: typeof TENANT_CREDENTIAL_REVOCATION_RUNTIME_DISPOSITION;
  externalDisposition: typeof TENANT_CREDENTIAL_REVOCATION_EXTERNAL_DISPOSITION;
  contentPurgeRequired: true;
  receiptSha256: string;
}

export type TenantCredentialRevocationCutoverRecord =
  | {
      singletonId: 1;
      controlGeneration: 0;
      activatedAtMs?: never;
      firstReceiptSha256?: never;
      evidenceSha256?: never;
    }
  | {
      singletonId: 1;
      controlGeneration: 1;
      activatedAtMs: number;
      firstReceiptSha256: string;
      evidenceSha256: string;
    };

/**
 * Least-privilege T3a store surface. Implementations must atomically delete all API-key and
 * provider-config rows, clear tenant auth policy/secret columns, insert the immutable receipt,
 * finish the job and (for the first receipt) activate the global cutover. No operation here may
 * claim runtime-cache revocation, external-provider revocation, content purge, or completion of
 * tenant erasure.
 */
export interface TenantCredentialRevocationStore {
  materializeTenantCredentialRevocationJobs(
    options: MaterializeTenantCredentialRevocationJobsOptions,
  ): Promise<number>;
  claimTenantCredentialRevocations(
    options: ClaimTenantCredentialRevocationsOptions,
  ): Promise<TenantCredentialRevocationClaim[]>;
  renewTenantCredentialRevocation(
    authorization: TenantCredentialRevocationAuthorization,
    options: RenewTenantCredentialRevocationOptions,
  ): Promise<boolean>;
  retryTenantCredentialRevocation(
    authorization: TenantCredentialRevocationAuthorization,
    options: RetryTenantCredentialRevocationOptions,
  ): Promise<boolean>;
  blockTenantCredentialRevocation(
    authorization: TenantCredentialRevocationAuthorization,
  ): Promise<boolean>;
  /**
   * Returns null for stale/lost authority. An already-written receipt may be replayed only when
   * its request/tenant/generation and completed attempt/token hash match this authorization.
   */
  revokeTenantCredentialMaterial(
    authorization: TenantCredentialRevocationAuthorization,
  ): Promise<TenantCredentialRevocationReceipt | null>;
  getTenantCredentialRevocationJob(
    tenantId: string,
    requestId: string,
  ): Promise<TenantCredentialRevocationJobRecord | null>;
  getTenantCredentialRevocationReceipt(
    tenantId: string,
    requestId: string,
  ): Promise<TenantCredentialRevocationReceipt | null>;
  getTenantCredentialRevocationCutover(): Promise<TenantCredentialRevocationCutoverRecord>;
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

export function assertTenantCredentialRevocationIdentity(input: {
  requestId: string;
  tenantId: string;
  subjectGeneration: number;
}): void {
  if (!ERASURE_REQUEST_ID.test(input.requestId)) {
    throw new Error("invalid tenant credential revocation request id");
  }
  if (!input.tenantId || input.tenantId.length > 128) {
    throw new Error("invalid tenant credential revocation tenant id");
  }
  assertPositiveSafeInteger(
    input.subjectGeneration,
    "tenant credential revocation subject generation",
  );
}

export function assertTenantCredentialRevocationClaimToken(claimToken: string): void {
  if (!CLAIM_TOKEN.test(claimToken)) {
    throw new Error("tenant credential revocation claimToken must contain 1 to 128 safe characters");
  }
}

export function tenantCredentialRevocationClaimTokenSha256(claimToken: string): string {
  assertTenantCredentialRevocationClaimToken(claimToken);
  return createHash("sha256").update(JSON.stringify([
    "tenant-credential-revocation-claim-token-v1",
    claimToken,
  ])).digest("hex");
}

export function validateMaterializeTenantCredentialRevocationJobsOptions(
  options: MaterializeTenantCredentialRevocationJobsOptions,
): void {
  if (!Number.isInteger(options.limit) || options.limit <= 0 || options.limit > 100) {
    throw new Error("tenant credential revocation materialization limit must be between 1 and 100");
  }
}

export function validateClaimTenantCredentialRevocationsOptions(
  options: ClaimTenantCredentialRevocationsOptions,
): void {
  if (!Number.isInteger(options.limit) || options.limit <= 0 || options.limit > 100) {
    throw new Error("tenant credential revocation claim limit must be between 1 and 100");
  }
  if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs <= 0) {
    throw new Error("tenant credential revocation leaseMs must be a positive safe integer");
  }
  assertTenantCredentialRevocationClaimToken(options.claimToken);
}

export function validateTenantCredentialRevocationAuthorization(
  authorization: TenantCredentialRevocationAuthorization,
): void {
  assertTenantCredentialRevocationIdentity(authorization);
  assertPositiveSafeInteger(
    authorization.claimAttempt,
    "tenant credential revocation claim attempt",
  );
  assertTenantCredentialRevocationClaimToken(authorization.claimToken);
}

export function validateRenewTenantCredentialRevocationOptions(
  options: RenewTenantCredentialRevocationOptions,
): void {
  if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs <= 0) {
    throw new Error("tenant credential revocation renewal leaseMs must be a positive safe integer");
  }
}

export function validateRetryTenantCredentialRevocationOptions(
  options: RetryTenantCredentialRevocationOptions,
): void {
  if (!Number.isSafeInteger(options.delayMs) || options.delayMs < 0) {
    throw new Error("tenant credential revocation retry delayMs must be a non-negative safe integer");
  }
  if (options.errorCode !== "temporary_failure") {
    throw new Error("invalid tenant credential revocation retry error code");
  }
}

export function validateTenantCredentialRevocationJobRecord(
  record: TenantCredentialRevocationJobRecord,
): void {
  assertTenantCredentialRevocationIdentity(record);
  if (!SHA256.test(record.t1FenceSha256)) {
    throw new Error("stored tenant credential revocation T1 fence hash is invalid");
  }
  assertCount(record.attempts, "stored tenant credential revocation attempts");
  assertTimestamp(record.createdAtMs, "stored tenant credential revocation creation timestamp");
  assertTimestamp(record.updatedAtMs, "stored tenant credential revocation update timestamp");
  if (record.updatedAtMs < record.createdAtMs) {
    throw new Error("stored tenant credential revocation timestamps are invalid");
  }

  if (record.phase === "queued") {
    assertTimestamp(record.availableAtMs, "stored tenant credential revocation availability");
    if (record.availableAtMs < record.createdAtMs) {
      throw new Error("stored tenant credential revocation availability is invalid");
    }
    if ((record.claimToken === undefined) !== (record.leaseUntilMs === undefined)) {
      throw new Error("stored tenant credential revocation claim is incomplete");
    }
    if (record.claimToken !== undefined) {
      assertTenantCredentialRevocationClaimToken(record.claimToken);
      assertTimestamp(record.leaseUntilMs!, "stored tenant credential revocation lease");
      if (record.attempts <= 0) {
        throw new Error("stored tenant credential revocation claim has no attempt");
      }
    }
    if (record.lastErrorCode !== undefined && record.lastErrorCode !== "temporary_failure") {
      throw new Error("stored tenant credential revocation retry error is invalid");
    }
    return;
  }

  if (record.phase === "credential_store_revoked") {
    assertTimestamp(
      record.credentialStoreRevokedAtMs,
      "stored tenant credential revocation completion timestamp",
    );
    if (record.credentialStoreRevokedAtMs < record.createdAtMs) {
      throw new Error("stored tenant credential revocation completion timestamp is invalid");
    }
    assertPositiveSafeInteger(
      record.completedClaimAttempt,
      "stored tenant credential revocation completion attempt",
    );
    if (!SHA256.test(record.completedClaimTokenSha256)) {
      throw new Error("stored tenant credential revocation completion token hash is invalid");
    }
    if (record.completedClaimAttempt !== record.attempts) {
      throw new Error("stored tenant credential revocation completion attempt does not match attempts");
    }
    return;
  }

  if (record.phase === "blocked") {
    assertTimestamp(record.blockedAtMs, "stored tenant credential revocation blocked timestamp");
    if (record.blockedAtMs < record.createdAtMs) {
      throw new Error("stored tenant credential revocation blocked timestamp is invalid");
    }
    if (record.blockedReasonCode !== "integrity_conflict") {
      throw new Error("stored tenant credential revocation blocked reason is invalid");
    }
    return;
  }

  throw new Error("stored tenant credential revocation phase is invalid");
}

export function validateTenantCredentialRevocationClaim(
  claim: TenantCredentialRevocationClaim,
): void {
  assertTenantCredentialRevocationIdentity(claim);
  if (!SHA256.test(claim.t1FenceSha256)) {
    throw new Error("tenant credential revocation claim T1 fence hash is invalid");
  }
  if (claim.phase !== "queued") throw new Error("tenant credential revocation claim phase is invalid");
  assertPositiveSafeInteger(claim.claimAttempt, "tenant credential revocation claim attempt");
  assertTenantCredentialRevocationClaimToken(claim.claimToken);
  assertTimestamp(claim.leaseUntilMs, "tenant credential revocation claim lease");
}

export function tenantCredentialRevocationClaimFromJob(
  record: TenantCredentialRevocationJobRecord,
): TenantCredentialRevocationClaim {
  validateTenantCredentialRevocationJobRecord(record);
  if (
    record.phase !== "queued"
    || record.claimToken === undefined
    || record.leaseUntilMs === undefined
  ) throw new Error("tenant credential revocation job is not an active worker claim");
  return {
    requestId: record.requestId,
    tenantId: record.tenantId,
    subjectGeneration: record.subjectGeneration,
    t1FenceSha256: record.t1FenceSha256,
    phase: record.phase,
    claimAttempt: record.attempts,
    claimToken: record.claimToken,
    leaseUntilMs: record.leaseUntilMs,
  };
}

export function tenantCredentialRevocationAuthorizationMatches(
  record: TenantCredentialRevocationJobRecord,
  authorization: TenantCredentialRevocationAuthorization,
  databaseNowMs: number,
): boolean {
  validateTenantCredentialRevocationJobRecord(record);
  validateTenantCredentialRevocationAuthorization(authorization);
  assertTimestamp(databaseNowMs, "tenant credential revocation database timestamp");
  return record.phase === "queued"
    && record.requestId === authorization.requestId
    && record.tenantId === authorization.tenantId
    && record.subjectGeneration === authorization.subjectGeneration
    && record.attempts === authorization.claimAttempt
    && record.claimToken === authorization.claimToken
    && record.leaseUntilMs !== undefined
    && record.leaseUntilMs > databaseNowMs;
}

type TenantCredentialRevocationReceiptBody = Omit<
  TenantCredentialRevocationReceipt,
  "receiptSha256"
>;

function validateTenantCredentialRevocationReceiptBody(
  receipt: TenantCredentialRevocationReceiptBody,
): void {
  if (receipt.scope !== TENANT_CREDENTIAL_REVOCATION_RECEIPT_SCOPE) {
    throw new Error("tenant credential revocation receipt scope is invalid");
  }
  assertTenantCredentialRevocationIdentity(receipt);
  if (!SHA256.test(receipt.t1FenceSha256)) {
    throw new Error("tenant credential revocation receipt T1 fence hash is invalid");
  }
  assertCount(receipt.apiKeyCountBefore, "tenant credential revocation API-key count");
  assertCount(receipt.providerConfigCountBefore, "tenant credential revocation provider count");
  if (receipt.apiKeyCountAfter !== 0 || receipt.providerConfigCountAfter !== 0) {
    throw new Error("tenant credential revocation receipt has remaining credential rows");
  }
  if (
    typeof receipt.authPolicyPresentBefore !== "boolean"
    || typeof receipt.authSecretCipherPresentBefore !== "boolean"
    || typeof receipt.authSecretKeyIdPresentBefore !== "boolean"
    || receipt.authPolicyPresentAfter !== false
    || receipt.authSecretCipherPresentAfter !== false
    || receipt.authSecretKeyIdPresentAfter !== false
  ) throw new Error("tenant credential revocation receipt auth assertions are invalid");
  assertTimestamp(receipt.storeDbTimestampMs, "tenant credential revocation store timestamp");
  assertPositiveSafeInteger(
    receipt.completedClaimAttempt,
    "tenant credential revocation receipt completion attempt",
  );
  if (!SHA256.test(receipt.completedClaimTokenSha256)) {
    throw new Error("tenant credential revocation receipt completion token hash is invalid");
  }
  if (
    receipt.runtimeDisposition !== TENANT_CREDENTIAL_REVOCATION_RUNTIME_DISPOSITION
    || receipt.externalDisposition !== TENANT_CREDENTIAL_REVOCATION_EXTERNAL_DISPOSITION
    || receipt.contentPurgeRequired !== true
  ) throw new Error("tenant credential revocation receipt disposition is invalid");
}

export function tenantCredentialRevocationReceiptSha256(
  receipt: TenantCredentialRevocationReceiptBody,
): string {
  validateTenantCredentialRevocationReceiptBody(receipt);
  return createHash("sha256").update(JSON.stringify([
    "tenant-credential-revocation-receipt-v1",
    receipt.scope,
    receipt.requestId,
    receipt.tenantId,
    receipt.subjectGeneration,
    receipt.t1FenceSha256,
    receipt.apiKeyCountBefore,
    receipt.apiKeyCountAfter,
    receipt.providerConfigCountBefore,
    receipt.providerConfigCountAfter,
    receipt.authPolicyPresentBefore,
    receipt.authPolicyPresentAfter,
    receipt.authSecretCipherPresentBefore,
    receipt.authSecretCipherPresentAfter,
    receipt.authSecretKeyIdPresentBefore,
    receipt.authSecretKeyIdPresentAfter,
    receipt.storeDbTimestampMs,
    receipt.completedClaimAttempt,
    receipt.completedClaimTokenSha256,
    receipt.runtimeDisposition,
    receipt.externalDisposition,
    receipt.contentPurgeRequired,
  ])).digest("hex");
}

export function validateTenantCredentialRevocationReceipt(
  receipt: TenantCredentialRevocationReceipt,
): void {
  validateTenantCredentialRevocationReceiptBody(receipt);
  if (!SHA256.test(receipt.receiptSha256)) {
    throw new Error("tenant credential revocation receipt hash is invalid");
  }
  if (receipt.receiptSha256 !== tenantCredentialRevocationReceiptSha256(receipt)) {
    throw new Error("tenant credential revocation receipt hash does not match its evidence");
  }
}

/** Exact response-loss replay predicate; deleted credential rows are never recounted. */
export function tenantCredentialRevocationReceiptMatchesAuthorization(
  receipt: TenantCredentialRevocationReceipt,
  authorization: TenantCredentialRevocationAuthorization,
): boolean {
  validateTenantCredentialRevocationReceipt(receipt);
  validateTenantCredentialRevocationAuthorization(authorization);
  return receipt.requestId === authorization.requestId
    && receipt.tenantId === authorization.tenantId
    && receipt.subjectGeneration === authorization.subjectGeneration
    && receipt.completedClaimAttempt === authorization.claimAttempt
    && receipt.completedClaimTokenSha256
      === tenantCredentialRevocationClaimTokenSha256(authorization.claimToken);
}

export function tenantCredentialRevocationCompletionMatchesAuthorization(
  record: TenantCredentialRevocationJobRecord,
  authorization: TenantCredentialRevocationAuthorization,
): boolean {
  validateTenantCredentialRevocationJobRecord(record);
  validateTenantCredentialRevocationAuthorization(authorization);
  return record.phase === "credential_store_revoked"
    && record.requestId === authorization.requestId
    && record.tenantId === authorization.tenantId
    && record.subjectGeneration === authorization.subjectGeneration
    && record.completedClaimAttempt === authorization.claimAttempt
    && record.completedClaimTokenSha256
      === tenantCredentialRevocationClaimTokenSha256(authorization.claimToken);
}

/** Validate the immutable job/receipt pair before exposing or replaying successful completion. */
export function validateTenantCredentialRevocationCompletionProof(
  record: TenantCredentialRevocationJobRecord,
  receipt: TenantCredentialRevocationReceipt,
): void {
  validateTenantCredentialRevocationJobRecord(record);
  validateTenantCredentialRevocationReceipt(receipt);
  if (
    record.phase !== "credential_store_revoked"
    || record.requestId !== receipt.requestId
    || record.tenantId !== receipt.tenantId
    || record.subjectGeneration !== receipt.subjectGeneration
    || record.t1FenceSha256 !== receipt.t1FenceSha256
    || record.credentialStoreRevokedAtMs !== receipt.storeDbTimestampMs
    || record.completedClaimAttempt !== receipt.completedClaimAttempt
    || record.completedClaimTokenSha256 !== receipt.completedClaimTokenSha256
  ) throw new Error("tenant credential revocation completion proof is inconsistent");
}

export function tenantCredentialRevocationCutoverEvidenceSha256(input: {
  singletonId: 1;
  controlGeneration: 1;
  activatedAtMs: number;
  firstReceiptSha256: string;
}): string {
  if (input.singletonId !== 1 || input.controlGeneration !== 1) {
    throw new Error("tenant credential revocation cutover identity is invalid");
  }
  assertTimestamp(input.activatedAtMs, "tenant credential revocation cutover timestamp");
  if (!SHA256.test(input.firstReceiptSha256)) {
    throw new Error("tenant credential revocation cutover first receipt hash is invalid");
  }
  return createHash("sha256").update(JSON.stringify([
    "tenant-credential-revocation-cutover-v1",
    input.singletonId,
    input.controlGeneration,
    input.activatedAtMs,
    input.firstReceiptSha256,
  ])).digest("hex");
}

export function validateTenantCredentialRevocationCutoverRecord(
  record: TenantCredentialRevocationCutoverRecord,
): void {
  if (record.singletonId !== 1) {
    throw new Error("tenant credential revocation cutover singleton is invalid");
  }
  if (record.controlGeneration === 0) {
    if (
      record.activatedAtMs !== undefined
      || record.firstReceiptSha256 !== undefined
      || record.evidenceSha256 !== undefined
    ) throw new Error("inactive tenant credential revocation cutover has activation evidence");
    return;
  }
  if (record.controlGeneration !== 1) {
    throw new Error("tenant credential revocation cutover generation is invalid");
  }
  assertTimestamp(record.activatedAtMs, "tenant credential revocation cutover timestamp");
  if (!SHA256.test(record.firstReceiptSha256) || !SHA256.test(record.evidenceSha256)) {
    throw new Error("tenant credential revocation cutover evidence is invalid");
  }
  if (record.evidenceSha256 !== tenantCredentialRevocationCutoverEvidenceSha256(record)) {
    throw new Error("tenant credential revocation cutover evidence does not match its state");
  }
}
