import { createHash } from "node:crypto";
import { isCanonicalId, type PersistedEvent } from "@agent-service/protocol";
import { RETENTION_POLICY_SCHEMA_VERSION } from "./retention-policy.js";

export const TENANT_SESSION_CONTENT_RECEIPT_SCOPE = "tenant-session-content-v1" as const;
export const TENANT_CONTENT_INVENTORY_RECEIPT_SCOPE = "tenant-content-inventory-v1" as const;
export const TENANT_CONTENT_INVENTORY_GLOBAL_ORPHAN_CHECK = "passed" as const;

export const TENANT_CONTENT_IDENTITY_DOMAINS = [
  "turn",
  "item",
  "event",
  "approval",
] as const;
export type TenantContentIdentityDomain = (typeof TENANT_CONTENT_IDENTITY_DOMAINS)[number];

/**
 * Only primary identities, lifecycle state, and content-free relationship metadata are admitted
 * here. In particular these tuples cannot carry message/tool bodies, usage/model data, a user id,
 * idempotency key, Blob locator, secret, or worker claim token.
 */
export interface TenantContentIdentityRows {
  turn: readonly [
    turnId: string,
    seqStart: number,
    seqEnd: number | null,
    status: string,
  ];
  item: readonly [
    itemId: string,
    turnId: string,
    seq: number,
    type: string,
    status: string,
    approvalId: string | null,
  ];
  event: readonly [
    seq: number,
    type: string,
    emittedAtMs: number,
    turnId: string | null,
    itemId: string | null,
    approvalId: string | null,
    relationState: string | null,
    relationSeqStart: number | null,
    relationSeqEnd: number | null,
    deletionGeneration: number | null,
  ];
  approval: readonly [
    approvalId: string,
    turnId: string,
    itemId: string,
    status: string,
  ];
}

export type TenantContentInventoryJobPhase = "queued" | "inventory_sealed" | "blocked";
export type TenantContentInventoryRetryErrorCode = "temporary_failure";
export type TenantContentInventoryBlockReasonCode = "integrity_conflict";
export type TenantContentInventoryNotReadyReason =
  | "deadline_not_reached"
  | "active_legal_hold"
  | "trusted_clock_before_anchor"
  | "trusted_clock_before_source"
  | "trusted_clock_before_evidence";

/** A valid proof cannot be sealed yet; this is retryable and must never quarantine the job. */
export class TenantContentInventoryNotReadyError extends Error {
  constructor(public readonly reason: TenantContentInventoryNotReadyReason) {
    super(`tenant content inventory is not ready: ${reason}`);
    this.name = "TenantContentInventoryNotReadyError";
  }
}

/** Live owner/source evidence changed during a build; fail closed for operator review. */
export class TenantContentInventoryEvidenceChangedError extends Error {
  constructor() {
    super("tenant content inventory evidence changed");
    this.name = "TenantContentInventoryEvidenceChangedError";
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
  if (!tenantId || tenantId.length > 128) throw new Error("invalid tenant content inventory tenant id");
}

function safeCountSum(values: readonly number[], name: string): number {
  let total = 0;
  for (const value of values) {
    assertCount(value, name);
    total += value;
    if (!Number.isSafeInteger(total)) throw new Error(`${name} exceeds the safe integer range`);
  }
  return total;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface TenantContentInventoryIdentity {
  requestId: string;
  tenantId: string;
  subjectGeneration: number;
  buildGeneration: number;
}

export function validateTenantContentInventoryIdentity(
  identity: TenantContentInventoryIdentity,
): void {
  if (!ERASURE_REQUEST_ID.test(identity.requestId)) {
    throw new Error("invalid tenant content inventory request id");
  }
  assertTenantId(identity.tenantId);
  assertPositiveSafeInteger(
    identity.subjectGeneration,
    "tenant content inventory subject generation",
  );
  assertPositiveSafeInteger(identity.buildGeneration, "tenant content inventory build generation");
}

export interface TenantContentInventorySource extends TenantContentInventoryIdentity {
  t1FenceSha256: string;
  t3aReceiptSha256: string;
  t3bReceiptSha256: string;
  policyVersion: string;
  policySha256: string;
  policySchemaVersion: typeof RETENTION_POLICY_SCHEMA_VERSION;
  retentionAnchorDbMs: number;
  contentNotBeforeDbMs: number;
}

export function validateTenantContentInventorySource(
  source: TenantContentInventorySource,
): void {
  validateTenantContentInventoryIdentity(source);
  assertSha256(source.t1FenceSha256, "tenant content inventory T1 fence hash");
  assertSha256(source.t3aReceiptSha256, "tenant content inventory T3a receipt hash");
  assertSha256(source.t3bReceiptSha256, "tenant content inventory T3b receipt hash");
  if (!POLICY_VERSION.test(source.policyVersion)) {
    throw new Error("tenant content inventory policy version is invalid");
  }
  assertSha256(source.policySha256, "tenant content inventory policy hash");
  if (source.policySchemaVersion !== RETENTION_POLICY_SCHEMA_VERSION) {
    throw new Error("tenant content inventory policy schema version is invalid");
  }
  assertTimestamp(source.retentionAnchorDbMs, "tenant content inventory retention anchor");
  assertTimestamp(source.contentNotBeforeDbMs, "tenant content inventory content deadline");
  if (source.contentNotBeforeDbMs < source.retentionAnchorDbMs) {
    throw new Error("tenant content inventory deadline predates its retention anchor");
  }
}

interface TenantContentInventoryJobBase extends TenantContentInventorySource {
  phase: TenantContentInventoryJobPhase;
  cursorSessionId?: string;
  scanComplete: boolean;
  sessionReceiptCount: number;
  sessionReceiptRootSha256: string;
  attempts: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export type TenantContentInventoryJobRecord = TenantContentInventoryJobBase & (
  | {
      phase: "queued";
      availableAtMs: number;
      claimToken?: string;
      leaseUntilMs?: number;
      lastErrorCode?: TenantContentInventoryRetryErrorCode;
      inventorySealedAtDbMs?: never;
      completedClaimAttempt?: never;
      completedClaimTokenSha256?: never;
      aggregateReceiptSha256?: never;
      blockedAtDbMs?: never;
      blockedReasonCode?: never;
    }
  | {
      phase: "inventory_sealed";
      availableAtMs?: never;
      claimToken?: never;
      leaseUntilMs?: never;
      lastErrorCode?: never;
      inventorySealedAtDbMs: number;
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
      inventorySealedAtDbMs?: never;
      completedClaimAttempt?: never;
      completedClaimTokenSha256?: never;
      aggregateReceiptSha256?: never;
      blockedAtDbMs: number;
      blockedReasonCode: TenantContentInventoryBlockReasonCode;
    }
);

export interface MaterializeTenantContentInventoryJobsOptions { limit: number }
export interface ClaimTenantContentInventoriesOptions {
  limit: number;
  leaseMs: number;
  claimToken: string;
}
export interface RenewTenantContentInventoryOptions { leaseMs: number }
export interface RetryTenantContentInventoryOptions {
  delayMs: number;
  errorCode: TenantContentInventoryRetryErrorCode;
}
export interface BuildTenantContentInventoryPageOptions { limit: number }

export interface TenantContentInventoryClaim extends TenantContentInventorySource {
  phase: "queued";
  claimAttempt: number;
  claimToken: string;
  leaseUntilMs: number;
}

export type TenantContentInventoryAuthorization = Pick<
  TenantContentInventoryClaim,
  | "requestId"
  | "tenantId"
  | "subjectGeneration"
  | "buildGeneration"
  | "claimAttempt"
  | "claimToken"
>;

export interface BuildTenantContentInventoryPageResult {
  built: number;
  done: boolean;
  cursorSessionId?: string;
  sessionReceiptCount: number;
  sessionReceiptRootSha256: string;
  contentRecordCount: number;
}

export interface TenantSessionContentReceipt extends TenantContentInventoryIdentity {
  scope: typeof TENANT_SESSION_CONTENT_RECEIPT_SCOPE;
  sessionId: string;
  sessionSha256: string;
  turnCount: number;
  turnRootSha256: string;
  itemCount: number;
  itemRootSha256: string;
  eventCount: number;
  eventRootSha256: string;
  approvalCount: number;
  approvalRootSha256: string;
  contentRecordCount: number;
  contentRootSha256: string;
  capturedAtDbMs: number;
  receiptSha256: string;
}

export interface TenantContentInventoryReceipt extends TenantContentInventorySource {
  scope: typeof TENANT_CONTENT_INVENTORY_RECEIPT_SCOPE;
  sessionReceiptCount: number;
  sessionReceiptRootSha256: string;
  contentRecordCount: number;
  holdControlCount: number;
  holdControlRootSha256: string;
  globalOrphanCheck: typeof TENANT_CONTENT_INVENTORY_GLOBAL_ORPHAN_CHECK;
  storeDbTimestampMs: number;
  completedClaimAttempt: number;
  completedClaimTokenSha256: string;
  contentInventoryComplete: true;
  contentPurgeExecuted: false;
  receiptSha256: string;
}

/**
 * Least-privilege T3c surface. It can persist only content-free structural evidence and cannot
 * mutate session content, Blob objects, usage, idempotency receipts, Redis, or erasure status.
 * All queue, capture, and seal timestamps are chosen by the store's trusted database clock.
 */
export interface TenantContentInventoryStore {
  materializeTenantContentInventoryJobs(
    options: MaterializeTenantContentInventoryJobsOptions,
  ): Promise<number>;
  claimTenantContentInventories(
    options: ClaimTenantContentInventoriesOptions,
  ): Promise<TenantContentInventoryClaim[]>;
  renewTenantContentInventory(
    authorization: TenantContentInventoryAuthorization,
    options: RenewTenantContentInventoryOptions,
  ): Promise<boolean>;
  retryTenantContentInventory(
    authorization: TenantContentInventoryAuthorization,
    options: RetryTenantContentInventoryOptions,
  ): Promise<boolean>;
  blockTenantContentInventory(
    authorization: TenantContentInventoryAuthorization,
  ): Promise<boolean>;
  buildTenantContentInventoryPage(
    authorization: TenantContentInventoryAuthorization,
    options: BuildTenantContentInventoryPageOptions,
  ): Promise<BuildTenantContentInventoryPageResult>;
  /** Returns null after stale/lost authority; exact committed response-loss replay is allowed. */
  sealTenantContentInventory(
    authorization: TenantContentInventoryAuthorization,
  ): Promise<TenantContentInventoryReceipt | null>;
  getTenantContentInventoryJob(
    tenantId: string,
    requestId: string,
  ): Promise<TenantContentInventoryJobRecord | null>;
  getTenantSessionContentReceipts(
    tenantId: string,
    requestId: string,
    buildGeneration: number,
  ): Promise<TenantSessionContentReceipt[]>;
  getTenantContentInventoryReceipt(
    tenantId: string,
    requestId: string,
  ): Promise<TenantContentInventoryReceipt | null>;
}

export function assertTenantContentInventoryClaimToken(claimToken: string): void {
  if (!CLAIM_TOKEN.test(claimToken)) {
    throw new Error("tenant content inventory claim token is invalid");
  }
}

export function tenantContentInventoryClaimTokenSha256(claimToken: string): string {
  assertTenantContentInventoryClaimToken(claimToken);
  return sha256(["tenant-content-inventory-claim-token-v1", claimToken]);
}

export function validateMaterializeTenantContentInventoryJobsOptions(
  options: MaterializeTenantContentInventoryJobsOptions,
): void {
  assertExactKeys(options, ["limit"], "tenant content inventory materialization options");
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new Error("tenant content inventory materialization limit must be between 1 and 100");
  }
}

export function validateClaimTenantContentInventoriesOptions(
  options: ClaimTenantContentInventoriesOptions,
): void {
  assertExactKeys(
    options,
    ["limit", "leaseMs", "claimToken"],
    "tenant content inventory claim options",
  );
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new Error("tenant content inventory claim limit must be between 1 and 100");
  }
  assertPositiveSafeInteger(options.leaseMs, "tenant content inventory claim lease");
  assertTenantContentInventoryClaimToken(options.claimToken);
}

export function validateTenantContentInventoryAuthorization(
  authorization: TenantContentInventoryAuthorization,
): void {
  assertExactKeys(authorization, [
    "requestId",
    "tenantId",
    "subjectGeneration",
    "buildGeneration",
    "claimAttempt",
    "claimToken",
  ], "tenant content inventory authorization");
  validateTenantContentInventoryIdentity(authorization);
  assertPositiveSafeInteger(
    authorization.claimAttempt,
    "tenant content inventory claim attempt",
  );
  assertTenantContentInventoryClaimToken(authorization.claimToken);
}

export function validateRenewTenantContentInventoryOptions(
  options: RenewTenantContentInventoryOptions,
): void {
  assertExactKeys(options, ["leaseMs"], "tenant content inventory renewal options");
  assertPositiveSafeInteger(options.leaseMs, "tenant content inventory renewal lease");
}

export function validateRetryTenantContentInventoryOptions(
  options: RetryTenantContentInventoryOptions,
): void {
  assertExactKeys(options, ["delayMs", "errorCode"], "tenant content inventory retry options");
  assertTimestamp(options.delayMs, "tenant content inventory retry delay");
  if (options.errorCode !== "temporary_failure") {
    throw new Error("tenant content inventory retry error is invalid");
  }
}

export function validateBuildTenantContentInventoryPageOptions(
  options: BuildTenantContentInventoryPageOptions,
): void {
  assertExactKeys(options, ["limit"], "tenant content inventory page options");
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1_000) {
    throw new Error("tenant content inventory page limit must be between 1 and 1000");
  }
}

export type TenantSessionLifecycleDisposition = "live" | "archived" | "tombstoned";

export function tenantSessionStructuralSha256(
  sessionId: string,
  parentSessionId: string | undefined,
  lastSeq: number,
  deletionGeneration: number,
  lifecycleDisposition: TenantSessionLifecycleDisposition,
): string {
  if (!isCanonicalId("sess", sessionId)) throw new Error("invalid inventory session id");
  if (parentSessionId !== undefined && !isCanonicalId("sess", parentSessionId)) {
    throw new Error("invalid inventory parent session id");
  }
  assertCount(lastSeq, "inventory session last sequence");
  assertCount(deletionGeneration, "inventory session deletion generation");
  if (
    lifecycleDisposition !== "live"
    && lifecycleDisposition !== "archived"
    && lifecycleDisposition !== "tombstoned"
  ) throw new Error("invalid inventory session lifecycle disposition");
  if (lifecycleDisposition === "tombstoned" && deletionGeneration < 1) {
    throw new Error("tombstoned inventory session has no deletion generation");
  }
  if (lifecycleDisposition !== "tombstoned" && deletionGeneration !== 0) {
    throw new Error("live inventory session has a deletion generation");
  }
  return sha256([
    "tenant-session-structural-identity-v1",
    sessionId,
    parentSessionId ?? null,
    lastSeq,
    deletionGeneration,
    lifecycleDisposition,
  ]);
}

const TENANT_CONTENT_TURN_STATUSES = new Set([
  "inProgress",
  "completed",
  "interrupted",
  "failed",
]);
const TENANT_CONTENT_ITEM_TYPES = new Set([
  "userMessage",
  "agentMessage",
  "reasoning",
  "toolCall",
  "toolResult",
  "approvalRequest",
  "contextCompaction",
  "systemNotice",
]);
const TENANT_CONTENT_ITEM_STATUSES = new Set([
  "inProgress",
  "completed",
  "failed",
  "declined",
]);
const TENANT_CONTENT_APPROVAL_STATUSES = new Set(["pending", "resolved", "expired"]);
const TENANT_CONTENT_EVENT_TYPES = new Set([
  "session/created",
  "session/status/changed",
  "session/compacted",
  "session/archived",
  "session/unarchived",
  "session/deleted",
  "turn/started",
  "turn/steered",
  "turn/completed",
  "item/started",
  "item/completed",
  "approval/requested",
  "approval/resolved",
  "usage/updated",
  "warning",
  "error",
]);
const TENANT_CONTENT_EVENT_RELATION_STATES = new Set([
  ...TENANT_CONTENT_TURN_STATUSES,
  ...TENANT_CONTENT_ITEM_STATUSES,
  ...TENANT_CONTENT_APPROVAL_STATUSES,
  "idle",
  "active",
  "error",
  ...[...TENANT_CONTENT_ITEM_TYPES].flatMap((type) => (
    [...TENANT_CONTENT_ITEM_STATUSES].map((status) => `${type}:${status}`)
  )),
]);

/** Content-free event topology committed into a session receipt; no event payload is retained. */
export function tenantContentEventIdentityRow(
  event: PersistedEvent,
): TenantContentIdentityRows["event"] {
  let turnId: string | null = null;
  let itemId: string | null = null;
  let approvalId: string | null = null;
  let relationState: string | null = null;
  let relationSeqStart: number | null = null;
  let relationSeqEnd: number | null = null;
  let deletionGeneration: number | null = null;
  if ("turn" in event) {
    turnId = event.turn.id;
    relationState = event.turn.status;
    relationSeqStart = event.turn.seqStart;
    relationSeqEnd = event.turn.seqEnd ?? null;
  }
  if ("item" in event) {
    turnId = event.item.turnId;
    itemId = event.item.id;
    if (event.item.type === "approvalRequest") approvalId = event.item.approvalId;
    relationState = `${event.item.type}:${event.item.status}`;
    relationSeqStart = event.item.seq;
  }
  if ("approval" in event) {
    turnId = event.approval.turnId;
    itemId = event.approval.itemId;
    approvalId = event.approval.id;
    relationState = event.approval.status;
  }
  if ("turnId" in event && event.turnId !== undefined) turnId = event.turnId;
  if (event.type === "turn/steered" || event.type === "session/compacted") {
    itemId = event.itemId;
  }
  if (event.type === "session/status/changed") {
    relationState = event.status.type;
    if (event.status.type === "active") turnId = event.status.turnId;
  }
  if (event.type === "session/deleted") deletionGeneration = event.deletionGeneration;
  return [
    event.seq,
    event.type,
    event.emittedAtMs,
    turnId,
    itemId,
    approvalId,
    relationState,
    relationSeqStart,
    relationSeqEnd,
    deletionGeneration,
  ];
}

function validateIdentityRow<D extends TenantContentIdentityDomain>(
  domain: D,
  row: TenantContentIdentityRows[D],
): void {
  if (!Array.isArray(row)) throw new Error(`tenant ${domain} identity row is invalid`);
  if (domain === "turn") {
    if (
      row.length !== 4
      || !isCanonicalId("turn", String(row[0]))
      || !Number.isSafeInteger(row[1])
      || Number(row[1]) < 1
      || (row[2] !== null && (
        !Number.isSafeInteger(row[2]) || Number(row[2]) < Number(row[1])
      ))
      || !TENANT_CONTENT_TURN_STATUSES.has(String(row[3]))
    ) {
      throw new Error("tenant turn identity row is invalid");
    }
    return;
  }
  if (domain === "item") {
    if (
      row.length !== 6
      || !isCanonicalId("item", String(row[0]))
      || !isCanonicalId("turn", String(row[1]))
      || !Number.isSafeInteger(row[2])
      || Number(row[2]) < 1
      || !TENANT_CONTENT_ITEM_TYPES.has(String(row[3]))
      || !TENANT_CONTENT_ITEM_STATUSES.has(String(row[4]))
      || (String(row[3]) === "approvalRequest"
        ? !isCanonicalId("apr", String(row[5]))
        : row[5] !== null)
    ) throw new Error("tenant item identity row is invalid");
    return;
  }
  if (domain === "event") {
    if (
      row.length !== 10
      || !Number.isSafeInteger(row[0])
      || Number(row[0]) < 1
      || !TENANT_CONTENT_EVENT_TYPES.has(String(row[1]))
      || !Number.isSafeInteger(row[2])
      || Number(row[2]) < 0
      || (row[3] !== null && !isCanonicalId("turn", String(row[3])))
      || (row[4] !== null && !isCanonicalId("item", String(row[4])))
      || (row[5] !== null && !isCanonicalId("apr", String(row[5])))
      || (row[6] !== null && !TENANT_CONTENT_EVENT_RELATION_STATES.has(String(row[6])))
      || (row[7] !== null && (
        !Number.isSafeInteger(row[7]) || Number(row[7]) < 0
      ))
      || (row[8] !== null && (
        row[7] === null
        || !Number.isSafeInteger(row[8])
        || Number(row[8]) < Number(row[7])
      ))
      || (row[9] !== null && (
        !Number.isSafeInteger(row[9]) || Number(row[9]) < 1
      ))
    ) {
      throw new Error("tenant event identity row is invalid");
    }
    return;
  }
  if (
    row.length !== 4
    || !isCanonicalId("apr", String(row[0]))
    || !isCanonicalId("turn", String(row[1]))
    || !isCanonicalId("item", String(row[2]))
    || !TENANT_CONTENT_APPROVAL_STATUSES.has(String(row[3]))
  ) throw new Error("tenant approval identity row is invalid");
}

/** Deterministic, domain-separated root over structural identity tuples only. */
export function tenantContentIdentityRootSha256<D extends TenantContentIdentityDomain>(
  domain: D,
  rows: readonly TenantContentIdentityRows[D][],
): string {
  if (!TENANT_CONTENT_IDENTITY_DOMAINS.includes(domain)) {
    throw new Error("tenant content identity domain is invalid");
  }
  const normalized = rows.map((row) => {
    validateIdentityRow(domain, row);
    return JSON.stringify(row);
  }).sort(compareStrings);
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`tenant ${domain} identity row is duplicated`);
  }
  return sha256([
    `tenant-content-${domain}-identity-root-v2`,
    ...normalized.map((row) => JSON.parse(row) as unknown),
  ]);
}

export function tenantSessionContentRootSha256(
  input: Pick<
    TenantSessionContentReceipt,
    | "sessionSha256"
    | "turnCount"
    | "turnRootSha256"
    | "itemCount"
    | "itemRootSha256"
    | "eventCount"
    | "eventRootSha256"
    | "approvalCount"
    | "approvalRootSha256"
    | "contentRecordCount"
  >,
): string {
  assertSha256(input.sessionSha256, "tenant session structural hash");
  for (const [count, root, name] of [
    [input.turnCount, input.turnRootSha256, "turn"],
    [input.itemCount, input.itemRootSha256, "item"],
    [input.eventCount, input.eventRootSha256, "event"],
    [input.approvalCount, input.approvalRootSha256, "approval"],
  ] as const) {
    assertCount(count, `tenant session ${name} count`);
    assertSha256(root, `tenant session ${name} root`);
  }
  const expectedCount = safeCountSum([
    1,
    input.turnCount,
    input.itemCount,
    input.eventCount,
    input.approvalCount,
  ], "tenant session content count");
  if (input.contentRecordCount !== expectedCount) {
    throw new Error("tenant session content count does not match its domain counts");
  }
  return sha256([
    "tenant-session-content-root-v1",
    input.sessionSha256,
    input.turnCount,
    input.turnRootSha256,
    input.itemCount,
    input.itemRootSha256,
    input.eventCount,
    input.eventRootSha256,
    input.approvalCount,
    input.approvalRootSha256,
    input.contentRecordCount,
  ]);
}

type TenantSessionContentReceiptBody = Omit<TenantSessionContentReceipt, "receiptSha256">;

export function tenantSessionContentReceiptSha256(
  receipt: TenantSessionContentReceiptBody,
): string {
  validateTenantContentInventoryIdentity(receipt);
  return sha256([
    "tenant-session-content-receipt-v1",
    receipt.scope,
    receipt.requestId,
    receipt.buildGeneration,
    receipt.tenantId,
    receipt.subjectGeneration,
    receipt.sessionId,
    receipt.sessionSha256,
    receipt.turnCount,
    receipt.turnRootSha256,
    receipt.itemCount,
    receipt.itemRootSha256,
    receipt.eventCount,
    receipt.eventRootSha256,
    receipt.approvalCount,
    receipt.approvalRootSha256,
    receipt.contentRecordCount,
    receipt.contentRootSha256,
    receipt.capturedAtDbMs,
  ]);
}

const SESSION_RECEIPT_KEYS = [
  "scope",
  "requestId",
  "buildGeneration",
  "tenantId",
  "subjectGeneration",
  "sessionId",
  "sessionSha256",
  "turnCount",
  "turnRootSha256",
  "itemCount",
  "itemRootSha256",
  "eventCount",
  "eventRootSha256",
  "approvalCount",
  "approvalRootSha256",
  "contentRecordCount",
  "contentRootSha256",
  "capturedAtDbMs",
  "receiptSha256",
] as const;

export function validateTenantSessionContentReceipt(
  receipt: TenantSessionContentReceipt,
): void {
  assertExactKeys(receipt, SESSION_RECEIPT_KEYS, "tenant session content receipt");
  validateTenantContentInventoryIdentity(receipt);
  if (receipt.scope !== TENANT_SESSION_CONTENT_RECEIPT_SCOPE) {
    throw new Error("tenant session content receipt scope is invalid");
  }
  if (!isCanonicalId("sess", receipt.sessionId)) {
    throw new Error("tenant session content receipt session id is invalid");
  }
  for (const [domain, count, root] of [
    ["turn", receipt.turnCount, receipt.turnRootSha256],
    ["item", receipt.itemCount, receipt.itemRootSha256],
    ["event", receipt.eventCount, receipt.eventRootSha256],
    ["approval", receipt.approvalCount, receipt.approvalRootSha256],
  ] as const) {
    if (count === 0 && root !== tenantContentIdentityRootSha256(domain, [])) {
      throw new Error(`empty tenant session ${domain} inventory has a non-empty root`);
    }
  }
  const expectedContentRoot = tenantSessionContentRootSha256(receipt);
  if (receipt.contentRootSha256 !== expectedContentRoot) {
    throw new Error("tenant session content root does not match its evidence");
  }
  assertTimestamp(receipt.capturedAtDbMs, "tenant session content capture timestamp");
  assertSha256(receipt.receiptSha256, "tenant session content receipt hash");
  if (receipt.receiptSha256 !== tenantSessionContentReceiptSha256(receipt)) {
    throw new Error("tenant session content receipt hash does not match its evidence");
  }
}

export const EMPTY_TENANT_SESSION_RECEIPT_ROOT_SHA256 = sha256([
  "tenant-session-content-receipt-chain-v1",
]);

export function tenantContentInventoryNextSessionReceiptRootSha256(
  previousRootSha256: string,
  receiptSha256: string,
): string {
  assertSha256(previousRootSha256, "tenant session receipt previous root");
  assertSha256(receiptSha256, "tenant session receipt hash");
  return sha256([
    "tenant-session-content-receipt-chain-v1",
    previousRootSha256,
    receiptSha256,
  ]);
}

export function tenantContentInventorySessionReceiptRootSha256(
  receipts: readonly TenantSessionContentReceipt[],
): string {
  const ordered = [...receipts].sort((left, right) => compareStrings(left.sessionId, right.sessionId));
  let previousSessionId: string | undefined;
  let root = EMPTY_TENANT_SESSION_RECEIPT_ROOT_SHA256;
  for (const receipt of ordered) {
    validateTenantSessionContentReceipt(receipt);
    if (receipt.sessionId === previousSessionId) {
      throw new Error("tenant session content receipt is duplicated");
    }
    root = tenantContentInventoryNextSessionReceiptRootSha256(root, receipt.receiptSha256);
    previousSessionId = receipt.sessionId;
  }
  return root;
}

/**
 * Remove the raw tenant/user subject from a legal-hold control while retaining its stable scan
 * position, subject kind, generation and projection. The ordinal is assigned by byte-ordered
 * owner scan, so two controls with identical projections remain distinct without storing user id.
 */
export function tenantContentInventoryHoldControlSha256(
  ordinal: number,
  subjectKind: "tenant" | "user",
  controlGeneration: number,
  activeProjectionSha256: string,
): string {
  assertCount(ordinal, "tenant content inventory hold control ordinal");
  if (subjectKind !== "tenant" && subjectKind !== "user") {
    throw new Error("tenant content inventory hold control subject kind is invalid");
  }
  assertCount(controlGeneration, "tenant content inventory hold control generation");
  assertSha256(
    activeProjectionSha256,
    "tenant content inventory hold control projection hash",
  );
  return sha256([
    "tenant-content-inventory-hold-control-v1",
    ordinal,
    subjectKind,
    controlGeneration,
    activeProjectionSha256,
  ]);
}

/** Root over already content-free legal-hold control hashes. */
export function tenantContentInventoryHoldControlRootSha256(
  controlSha256s: readonly string[],
): string {
  for (const digest of controlSha256s) {
    assertSha256(digest, "tenant content inventory hold control hash");
  }
  const ordered = [...controlSha256s].sort(compareStrings);
  if (new Set(ordered).size !== ordered.length) {
    throw new Error("tenant content inventory hold control is duplicated");
  }
  return sha256(["tenant-content-inventory-hold-control-root-v1", ...ordered]);
}

type TenantContentInventoryReceiptBody = Omit<TenantContentInventoryReceipt, "receiptSha256">;

export function tenantContentInventoryReceiptSha256(
  receipt: TenantContentInventoryReceiptBody,
): string {
  validateTenantContentInventorySource(receipt);
  return sha256([
    "tenant-content-inventory-receipt-v1",
    receipt.scope,
    receipt.requestId,
    receipt.tenantId,
    receipt.subjectGeneration,
    receipt.buildGeneration,
    receipt.t1FenceSha256,
    receipt.t3aReceiptSha256,
    receipt.t3bReceiptSha256,
    receipt.policyVersion,
    receipt.policySha256,
    receipt.policySchemaVersion,
    receipt.retentionAnchorDbMs,
    receipt.contentNotBeforeDbMs,
    receipt.sessionReceiptCount,
    receipt.sessionReceiptRootSha256,
    receipt.contentRecordCount,
    receipt.holdControlCount,
    receipt.holdControlRootSha256,
    receipt.globalOrphanCheck,
    receipt.storeDbTimestampMs,
    receipt.completedClaimAttempt,
    receipt.completedClaimTokenSha256,
    receipt.contentInventoryComplete,
    receipt.contentPurgeExecuted,
  ]);
}

const INVENTORY_RECEIPT_KEYS = [
  "scope",
  "requestId",
  "tenantId",
  "subjectGeneration",
  "buildGeneration",
  "t1FenceSha256",
  "t3aReceiptSha256",
  "t3bReceiptSha256",
  "policyVersion",
  "policySha256",
  "policySchemaVersion",
  "retentionAnchorDbMs",
  "contentNotBeforeDbMs",
  "sessionReceiptCount",
  "sessionReceiptRootSha256",
  "contentRecordCount",
  "holdControlCount",
  "holdControlRootSha256",
  "globalOrphanCheck",
  "storeDbTimestampMs",
  "completedClaimAttempt",
  "completedClaimTokenSha256",
  "contentInventoryComplete",
  "contentPurgeExecuted",
  "receiptSha256",
] as const;

export function validateTenantContentInventoryReceipt(
  receipt: TenantContentInventoryReceipt,
): void {
  assertExactKeys(receipt, INVENTORY_RECEIPT_KEYS, "tenant content inventory receipt");
  validateTenantContentInventorySource(receipt);
  if (receipt.scope !== TENANT_CONTENT_INVENTORY_RECEIPT_SCOPE) {
    throw new Error("tenant content inventory receipt scope is invalid");
  }
  assertCount(receipt.sessionReceiptCount, "tenant content inventory session receipt count");
  assertSha256(receipt.sessionReceiptRootSha256, "tenant content inventory session receipt root");
  assertCount(receipt.contentRecordCount, "tenant content inventory content record count");
  if (
    (receipt.sessionReceiptCount === 0 && receipt.contentRecordCount !== 0)
    || (receipt.sessionReceiptCount > 0
      && receipt.contentRecordCount < receipt.sessionReceiptCount)
  ) {
    throw new Error("tenant content inventory content count is smaller than its session count");
  }
  if (
    receipt.sessionReceiptCount === 0
    && receipt.sessionReceiptRootSha256 !== EMPTY_TENANT_SESSION_RECEIPT_ROOT_SHA256
  ) throw new Error("empty tenant content inventory has a non-empty session receipt root");
  assertCount(receipt.holdControlCount, "tenant content inventory hold control count");
  assertSha256(receipt.holdControlRootSha256, "tenant content inventory hold control root");
  if (
    receipt.holdControlCount === 0
    && receipt.holdControlRootSha256 !== tenantContentInventoryHoldControlRootSha256([])
  ) throw new Error("empty tenant content inventory has a non-empty hold control root");
  if (receipt.globalOrphanCheck !== TENANT_CONTENT_INVENTORY_GLOBAL_ORPHAN_CHECK) {
    throw new Error("tenant content inventory global orphan check is invalid");
  }
  assertTimestamp(receipt.storeDbTimestampMs, "tenant content inventory store timestamp");
  if (receipt.storeDbTimestampMs < receipt.contentNotBeforeDbMs) {
    throw new Error("tenant content inventory was sealed before its trusted database deadline");
  }
  assertPositiveSafeInteger(
    receipt.completedClaimAttempt,
    "tenant content inventory completion attempt",
  );
  assertSha256(
    receipt.completedClaimTokenSha256,
    "tenant content inventory completion token hash",
  );
  if (receipt.contentInventoryComplete !== true || receipt.contentPurgeExecuted !== false) {
    throw new Error("tenant content inventory completion disposition is invalid");
  }
  assertSha256(receipt.receiptSha256, "tenant content inventory receipt hash");
  if (receipt.receiptSha256 !== tenantContentInventoryReceiptSha256(receipt)) {
    throw new Error("tenant content inventory receipt hash does not match its evidence");
  }
}

export function validateTenantContentInventoryJobRecord(
  job: TenantContentInventoryJobRecord,
): void {
  validateTenantContentInventorySource(job);
  if (job.cursorSessionId !== undefined && !isCanonicalId("sess", job.cursorSessionId)) {
    throw new Error("tenant content inventory cursor is invalid");
  }
  if (typeof job.scanComplete !== "boolean") {
    throw new Error("tenant content inventory scan marker is invalid");
  }
  assertCount(job.sessionReceiptCount, "tenant content inventory session receipt count");
  assertSha256(job.sessionReceiptRootSha256, "tenant content inventory session receipt root");
  if ((job.sessionReceiptCount === 0) !== (job.cursorSessionId === undefined)) {
    throw new Error("tenant content inventory cursor does not match its receipt count");
  }
  if (job.sessionReceiptCount === 0
    && job.sessionReceiptRootSha256 !== EMPTY_TENANT_SESSION_RECEIPT_ROOT_SHA256) {
    throw new Error("empty tenant content inventory has a non-empty receipt root");
  }
  assertCount(job.attempts, "tenant content inventory attempts");
  assertTimestamp(job.createdAtMs, "tenant content inventory creation timestamp");
  assertTimestamp(job.updatedAtMs, "tenant content inventory update timestamp");
  if (job.updatedAtMs < job.createdAtMs) {
    throw new Error("tenant content inventory timestamps are invalid");
  }
  if (job.phase === "queued") {
    assertTimestamp(job.availableAtMs, "tenant content inventory availability");
    if (job.availableAtMs < job.createdAtMs) {
      throw new Error("tenant content inventory availability is invalid");
    }
    if ((job.claimToken === undefined) !== (job.leaseUntilMs === undefined)) {
      throw new Error("tenant content inventory claim is incomplete");
    }
    if (job.claimToken !== undefined) {
      assertTenantContentInventoryClaimToken(job.claimToken);
      assertTimestamp(job.leaseUntilMs!, "tenant content inventory lease");
      if (job.attempts < 1) throw new Error("tenant content inventory claim has no attempt");
      if (job.leaseUntilMs! < job.updatedAtMs) {
        throw new Error("tenant content inventory lease predates its update timestamp");
      }
    } else if (job.availableAtMs < job.updatedAtMs) {
      throw new Error("tenant content inventory availability predates its update timestamp");
    }
    if (job.lastErrorCode !== undefined && job.lastErrorCode !== "temporary_failure") {
      throw new Error("tenant content inventory retry error is invalid");
    }
    if (job.claimToken !== undefined && job.lastErrorCode !== undefined) {
      throw new Error("claimed tenant content inventory retains a retry error");
    }
    return;
  }
  if (job.phase === "inventory_sealed") {
    if (!job.scanComplete) throw new Error("sealed tenant content inventory has an incomplete scan");
    assertTimestamp(job.inventorySealedAtDbMs, "tenant content inventory seal timestamp");
    if (
      job.inventorySealedAtDbMs < job.contentNotBeforeDbMs
      || job.inventorySealedAtDbMs > job.updatedAtMs
    ) throw new Error("tenant content inventory seal timestamp is invalid");
    assertPositiveSafeInteger(
      job.completedClaimAttempt,
      "tenant content inventory completion attempt",
    );
    assertSha256(
      job.completedClaimTokenSha256,
      "tenant content inventory completion token hash",
    );
    assertSha256(job.aggregateReceiptSha256, "tenant content inventory aggregate receipt hash");
    if (job.completedClaimAttempt !== job.attempts) {
      throw new Error("tenant content inventory completion attempt does not match attempts");
    }
    return;
  }
  if (job.phase === "blocked") {
    assertTimestamp(job.blockedAtDbMs, "tenant content inventory blocked timestamp");
    if (job.blockedAtDbMs < job.createdAtMs || job.blockedAtDbMs > job.updatedAtMs) {
      throw new Error("tenant content inventory blocked timestamp is invalid");
    }
    if (job.attempts < 1) throw new Error("blocked tenant content inventory has no attempt");
    if (job.blockedReasonCode !== "integrity_conflict") {
      throw new Error("tenant content inventory blocked reason is invalid");
    }
    return;
  }
  throw new Error("tenant content inventory phase is invalid");
}

export function tenantContentInventoryClaimFromJob(
  job: TenantContentInventoryJobRecord,
): TenantContentInventoryClaim {
  validateTenantContentInventoryJobRecord(job);
  if (job.phase !== "queued" || job.claimToken === undefined || job.leaseUntilMs === undefined) {
    throw new Error("tenant content inventory job is not claimed");
  }
  return {
    requestId: job.requestId,
    tenantId: job.tenantId,
    subjectGeneration: job.subjectGeneration,
    buildGeneration: job.buildGeneration,
    t1FenceSha256: job.t1FenceSha256,
    t3aReceiptSha256: job.t3aReceiptSha256,
    t3bReceiptSha256: job.t3bReceiptSha256,
    policyVersion: job.policyVersion,
    policySha256: job.policySha256,
    policySchemaVersion: job.policySchemaVersion,
    retentionAnchorDbMs: job.retentionAnchorDbMs,
    contentNotBeforeDbMs: job.contentNotBeforeDbMs,
    phase: "queued",
    claimAttempt: job.attempts,
    claimToken: job.claimToken,
    leaseUntilMs: job.leaseUntilMs,
  };
}

export function tenantContentInventoryAuthorizationMatches(
  job: TenantContentInventoryJobRecord,
  authorization: TenantContentInventoryAuthorization,
  databaseNowMs: number,
): boolean {
  validateTenantContentInventoryJobRecord(job);
  validateTenantContentInventoryAuthorization(authorization);
  assertTimestamp(databaseNowMs, "tenant content inventory database timestamp");
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

export function tenantContentInventoryReceiptMatchesAuthorization(
  receipt: TenantContentInventoryReceipt,
  authorization: TenantContentInventoryAuthorization,
): boolean {
  validateTenantContentInventoryReceipt(receipt);
  validateTenantContentInventoryAuthorization(authorization);
  return receipt.requestId === authorization.requestId
    && receipt.tenantId === authorization.tenantId
    && receipt.subjectGeneration === authorization.subjectGeneration
    && receipt.buildGeneration === authorization.buildGeneration
    && receipt.completedClaimAttempt === authorization.claimAttempt
    && receipt.completedClaimTokenSha256
      === tenantContentInventoryClaimTokenSha256(authorization.claimToken);
}

/** Validate every immutable T3c row before exposing or replaying the aggregate proof. */
export function validateTenantContentInventoryCompletionProof(
  job: TenantContentInventoryJobRecord,
  sessionReceipts: readonly TenantSessionContentReceipt[],
  receipt: TenantContentInventoryReceipt,
): void {
  validateTenantContentInventoryJobRecord(job);
  validateTenantContentInventoryReceipt(receipt);
  if (job.phase !== "inventory_sealed") {
    throw new Error("tenant content inventory job is not sealed");
  }
  const sourceFields = [
    "requestId",
    "tenantId",
    "subjectGeneration",
    "buildGeneration",
    "t1FenceSha256",
    "t3aReceiptSha256",
    "t3bReceiptSha256",
    "policyVersion",
    "policySha256",
    "policySchemaVersion",
    "retentionAnchorDbMs",
    "contentNotBeforeDbMs",
  ] as const;
  if (sourceFields.some((field) => job[field] !== receipt[field])) {
    throw new Error("tenant content inventory aggregate source binding is inconsistent");
  }
  let contentRecordCount = 0;
  for (const sessionReceipt of sessionReceipts) {
    validateTenantSessionContentReceipt(sessionReceipt);
    if (
      sessionReceipt.requestId !== job.requestId
      || sessionReceipt.tenantId !== job.tenantId
      || sessionReceipt.subjectGeneration !== job.subjectGeneration
      || sessionReceipt.buildGeneration !== job.buildGeneration
      || sessionReceipt.capturedAtDbMs < job.retentionAnchorDbMs
      || sessionReceipt.capturedAtDbMs > receipt.storeDbTimestampMs
    ) throw new Error("tenant session content receipt source binding is inconsistent");
    contentRecordCount = safeCountSum(
      [contentRecordCount, sessionReceipt.contentRecordCount],
      "tenant content inventory aggregate content count",
    );
  }
  const sessionRoot = tenantContentInventorySessionReceiptRootSha256(sessionReceipts);
  if (
    sessionReceipts.length !== job.sessionReceiptCount
    || sessionReceipts.length !== receipt.sessionReceiptCount
    || sessionRoot !== job.sessionReceiptRootSha256
    || sessionRoot !== receipt.sessionReceiptRootSha256
    || contentRecordCount !== receipt.contentRecordCount
    || job.inventorySealedAtDbMs !== receipt.storeDbTimestampMs
    || job.completedClaimAttempt !== receipt.completedClaimAttempt
    || job.completedClaimTokenSha256 !== receipt.completedClaimTokenSha256
    || job.aggregateReceiptSha256 !== receipt.receiptSha256
  ) throw new Error("tenant content inventory completion proof is inconsistent");
}
