import { createHash } from "node:crypto";
import { isCanonicalId } from "@agent-service/protocol";
import {
  tenantPurgePlanTargetRootSha256,
  tenantPurgePlanTargetSha256,
} from "./tenant-purge-plan.js";

export const TENANT_REDIS_PURGE_TARGET_SCOPE = "tenant-redis-purge-target-v1" as const;
export const TENANT_REDIS_PURGE_TARGET_ACK_SCOPE =
  "tenant-redis-purge-target-ack-v1" as const;
export const TENANT_REDIS_PURGE_DOMAIN_ACK_SCOPE =
  "tenant-redis-purge-domain-ack-v1" as const;
export const TENANT_REDIS_PURGE_RECEIPT_SCOPE = "tenant-redis-purge-v1" as const;
export const TENANT_REDIS_PURGE_ADAPTER_PROTOCOL =
  "redis-session-state-delete-v1" as const;
export const TENANT_REDIS_PURGE_CUTOVER_SINGLETON_ID = 1 as const;

/** The exact three live Redis domains from the immutable T3d 33-domain catalog. */
export const TENANT_REDIS_PURGE_DOMAINS = [
  "redis_leases",
  "redis_fences",
  "redis_streams",
] as const;
export type TenantRedisPurgeDomain = (typeof TENANT_REDIS_PURGE_DOMAINS)[number];

export type TenantRedisPurgeJobPhase = "queued" | "redis_purge_sealed" | "blocked";
export type TenantRedisPurgeRetryErrorCode = "temporary_failure" | "dependency_pending";
export type TenantRedisPurgeBlockReasonCode = "integrity_conflict";

export class TenantRedisPurgeNotReadyError extends Error {
  constructor(public readonly reason: "active_legal_hold" | "dependency_pending") {
    super(`tenant Redis purge is not ready: ${reason}`);
    this.name = "TenantRedisPurgeNotReadyError";
  }
}

export class TenantRedisPurgeEvidenceChangedError extends Error {
  constructor() {
    super("tenant Redis purge source evidence changed");
    this.name = "TenantRedisPurgeEvidenceChangedError";
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
  if (!value || value.length > 128) throw new Error("invalid tenant Redis purge tenant id");
}

function sessionId(value: string): void {
  if (!isCanonicalId("sess", value)) throw new Error("invalid tenant Redis purge session id");
}

function claimToken(value: string): void {
  if (!CLAIM_TOKEN.test(value)) throw new Error("invalid tenant Redis purge claim token");
}

export interface TenantRedisPurgeIdentity {
  requestId: string;
  tenantId: string;
  subjectGeneration: number;
  planBuildGeneration: number;
  executionGeneration: number;
  databasePurgeGeneration: number;
  redisPurgeGeneration: number;
}

/** Exact T3c/T3d/T3f source plus the configured Redis namespace identity. */
export interface TenantRedisPurgeSource extends TenantRedisPurgeIdentity {
  t3cReceiptSha256: string;
  planReceiptSha256: string;
  redisPlanEntryCount: number;
  redisPlanEntryRootSha256: string;
  databasePurgeReceiptSha256: string;
  graveMarkerCount: number;
  graveMarkerRootSha256: string;
  redisNamespaceSha256: string;
  policySha256: string;
  purgeNotBeforeDbMs: number;
  sourceEvidenceDbMs: number;
  sourceUnresolvedBlockerCount: number;
}

const IDENTITY_KEYS = [
  "requestId",
  "tenantId",
  "subjectGeneration",
  "planBuildGeneration",
  "executionGeneration",
  "databasePurgeGeneration",
  "redisPurgeGeneration",
] as const;

const SOURCE_KEYS = [
  ...IDENTITY_KEYS,
  "t3cReceiptSha256",
  "planReceiptSha256",
  "redisPlanEntryCount",
  "redisPlanEntryRootSha256",
  "databasePurgeReceiptSha256",
  "graveMarkerCount",
  "graveMarkerRootSha256",
  "redisNamespaceSha256",
  "policySha256",
  "purgeNotBeforeDbMs",
  "sourceEvidenceDbMs",
  "sourceUnresolvedBlockerCount",
] as const;

export function validateTenantRedisPurgeIdentity(identity: TenantRedisPurgeIdentity): void {
  if (!REQUEST_ID.test(identity.requestId)) throw new Error("invalid tenant Redis purge request id");
  tenantId(identity.tenantId);
  positive(identity.subjectGeneration, "tenant Redis purge subject generation");
  positive(identity.planBuildGeneration, "tenant Redis purge plan generation");
  positive(identity.executionGeneration, "tenant Redis purge execution generation");
  positive(identity.databasePurgeGeneration, "tenant Redis database purge generation");
  positive(identity.redisPurgeGeneration, "tenant Redis purge generation");
}

export function validateTenantRedisPurgeSource(source: TenantRedisPurgeSource): void {
  validateTenantRedisPurgeIdentity(source);
  for (const [value, name] of [
    [source.t3cReceiptSha256, "T3c receipt"],
    [source.planReceiptSha256, "T3d plan receipt"],
    [source.redisPlanEntryRootSha256, "T3d Redis plan-entry root"],
    [source.databasePurgeReceiptSha256, "T3f receipt"],
    [source.graveMarkerRootSha256, "grave-marker root"],
    [source.redisNamespaceSha256, "Redis namespace"],
    [source.policySha256, "policy"],
  ] as const) digest(value, `tenant Redis purge ${name}`);
  if (source.redisPlanEntryCount !== TENANT_REDIS_PURGE_DOMAINS.length) {
    throw new Error("tenant Redis purge source does not cover the fixed Redis plan catalog");
  }
  count(source.graveMarkerCount, "tenant Redis purge grave-marker count");
  if (source.graveMarkerCount === 0
    && source.graveMarkerRootSha256 !== tenantRedisPurgeGraveMarkerRootSha256([])) {
    throw new Error("empty tenant Redis purge grave catalog has a non-empty root");
  }
  timestamp(source.purgeNotBeforeDbMs, "tenant Redis purge deadline");
  timestamp(source.sourceEvidenceDbMs, "tenant Redis purge source evidence time");
  if (source.sourceEvidenceDbMs < source.purgeNotBeforeDbMs) {
    throw new Error("tenant Redis purge source evidence predates its deadline");
  }
  count(source.sourceUnresolvedBlockerCount, "tenant Redis purge source blocker count");
  if (source.sourceUnresolvedBlockerCount < TENANT_REDIS_PURGE_DOMAINS.length
    || source.sourceUnresolvedBlockerCount > 33) {
    throw new Error("tenant Redis purge source blocker count is invalid");
  }
}

function sameIdentity(left: TenantRedisPurgeIdentity, right: TenantRedisPurgeIdentity): boolean {
  return IDENTITY_KEYS.every((key) => left[key] === right[key]);
}

function sameSource(left: TenantRedisPurgeSource, right: TenantRedisPurgeSource): boolean {
  return SOURCE_KEYS.every((key) => left[key] === right[key]);
}

export function tenantRedisPurgeDomainOrdinal(domain: TenantRedisPurgeDomain): number {
  const ordinal = (TENANT_REDIS_PURGE_DOMAINS as readonly string[]).indexOf(domain);
  if (ordinal < 0) throw new Error("tenant Redis purge domain is invalid");
  return ordinal;
}

export function tenantRedisPurgeClaimTokenSha256(value: string): string {
  claimToken(value);
  return sha256(["tenant-redis-purge-claim-token-v1", value]);
}

export interface TenantRedisPurgePlanEntryReference {
  domain: TenantRedisPurgeDomain;
  planEntryReceiptSha256: string;
}

export function tenantRedisPurgePlanEntryRootSha256(
  entries: readonly TenantRedisPurgePlanEntryReference[],
): string {
  if (entries.length !== TENANT_REDIS_PURGE_DOMAINS.length) {
    throw new Error("tenant Redis purge plan-entry references do not cover the fixed catalog");
  }
  const ordered = [...entries].sort(
    (left, right) => tenantRedisPurgeDomainOrdinal(left.domain)
      - tenantRedisPurgeDomainOrdinal(right.domain),
  );
  for (const [ordinal, entry] of ordered.entries()) {
    exactKeys(entry, ["domain", "planEntryReceiptSha256"], "tenant Redis purge plan entry");
    if (tenantRedisPurgeDomainOrdinal(entry.domain) !== ordinal) {
      throw new Error("tenant Redis purge plan-entry domain is duplicated or missing");
    }
    digest(entry.planEntryReceiptSha256, "tenant Redis purge plan-entry receipt");
  }
  return sha256([
    "tenant-redis-purge-plan-entry-root-v1",
    ...ordered.flatMap((entry) => [entry.domain, entry.planEntryReceiptSha256]),
  ]);
}

/** Reproduce the exact T3d target identity; no Redis key or runtime value enters this hash. */
export function tenantRedisPurgePlanTargetSha256(
  domain: TenantRedisPurgeDomain,
  targetSessionId: string,
): string {
  tenantRedisPurgeDomainOrdinal(domain);
  sessionId(targetSessionId);
  return tenantPurgePlanTargetSha256(domain, [targetSessionId]);
}

export function tenantRedisPurgePlanTargetRootSha256(
  domain: TenantRedisPurgeDomain,
  targetSessionIds: readonly string[],
): string {
  const hashes = targetSessionIds.map((value) => tenantRedisPurgePlanTargetSha256(domain, value));
  return tenantPurgePlanTargetRootSha256(domain, hashes);
}

/** Reproduce the retained T3f grave-marker root without reintroducing deleted owner fields. */
export function tenantRedisPurgeGraveMarkerRootSha256(
  markerSha256s: readonly string[],
): string {
  for (const value of markerSha256s) digest(value, "tenant Redis purge grave marker");
  const ordered = [...markerSha256s].sort();
  if (new Set(ordered).size !== ordered.length) {
    throw new Error("tenant Redis purge grave marker is duplicated");
  }
  return sha256(["tenant-purge-session-grave-marker-root-v1", ...ordered]);
}

export interface TenantRedisPurgeOperationInput {
  identity: TenantRedisPurgeIdentity;
  sessionId: string;
  graveMarkerSha256: string;
  redisNamespaceSha256: string;
  leasePlanTargetSha256: string;
  fencePlanTargetSha256: string;
  streamPlanTargetSha256: string;
}

export function tenantRedisPurgeOperationSha256(input: TenantRedisPurgeOperationInput): string {
  exactKeys(input, [
    "identity",
    "sessionId",
    "graveMarkerSha256",
    "redisNamespaceSha256",
    "leasePlanTargetSha256",
    "fencePlanTargetSha256",
    "streamPlanTargetSha256",
  ], "tenant Redis purge operation");
  validateTenantRedisPurgeIdentity(input.identity);
  sessionId(input.sessionId);
  for (const [value, name] of [
    [input.graveMarkerSha256, "grave marker"],
    [input.redisNamespaceSha256, "namespace"],
    [input.leasePlanTargetSha256, "lease plan target"],
    [input.fencePlanTargetSha256, "fence plan target"],
    [input.streamPlanTargetSha256, "stream plan target"],
  ] as const) digest(value, `tenant Redis purge operation ${name}`);
  if (input.leasePlanTargetSha256
      !== tenantRedisPurgePlanTargetSha256("redis_leases", input.sessionId)
    || input.fencePlanTargetSha256
      !== tenantRedisPurgePlanTargetSha256("redis_fences", input.sessionId)
    || input.streamPlanTargetSha256
      !== tenantRedisPurgePlanTargetSha256("redis_streams", input.sessionId)) {
    throw new Error("tenant Redis purge operation plan target does not match its session");
  }
  return sha256([
    "tenant-redis-purge-operation-v1",
    ...IDENTITY_KEYS.map((key) => input.identity[key]),
    input.sessionId,
    input.graveMarkerSha256,
    input.redisNamespaceSha256,
    input.leasePlanTargetSha256,
    input.fencePlanTargetSha256,
    input.streamPlanTargetSha256,
  ]);
}

export interface TenantRedisPurgeTarget extends TenantRedisPurgeIdentity {
  scope: typeof TENANT_REDIS_PURGE_TARGET_SCOPE;
  targetOrdinal: number;
  sessionId: string;
  graveMarkerSha256: string;
  redisNamespaceSha256: string;
  leasePlanTargetSha256: string;
  fencePlanTargetSha256: string;
  streamPlanTargetSha256: string;
  operationSha256: string;
  capturedAtDbMs: number;
  receiptSha256: string;
}

type TargetBody = Omit<TenantRedisPurgeTarget, "receiptSha256">;

export function tenantRedisPurgeTargetSha256(target: TargetBody): string {
  validateTenantRedisPurgeIdentity(target);
  if (target.scope !== TENANT_REDIS_PURGE_TARGET_SCOPE) {
    throw new Error("tenant Redis purge target scope is invalid");
  }
  count(target.targetOrdinal, "tenant Redis purge target ordinal");
  sessionId(target.sessionId);
  const operationSha256 = tenantRedisPurgeOperationSha256({
    identity: target,
    sessionId: target.sessionId,
    graveMarkerSha256: target.graveMarkerSha256,
    redisNamespaceSha256: target.redisNamespaceSha256,
    leasePlanTargetSha256: target.leasePlanTargetSha256,
    fencePlanTargetSha256: target.fencePlanTargetSha256,
    streamPlanTargetSha256: target.streamPlanTargetSha256,
  });
  digest(target.operationSha256, "tenant Redis purge target operation");
  if (target.operationSha256 !== operationSha256) {
    throw new Error("tenant Redis purge target operation does not match");
  }
  timestamp(target.capturedAtDbMs, "tenant Redis purge target capture time");
  return sha256([
    "tenant-redis-purge-target-v1",
    target.scope,
    ...IDENTITY_KEYS.map((key) => target[key]),
    target.targetOrdinal,
    target.sessionId,
    target.graveMarkerSha256,
    target.redisNamespaceSha256,
    target.leasePlanTargetSha256,
    target.fencePlanTargetSha256,
    target.streamPlanTargetSha256,
    target.operationSha256,
    target.capturedAtDbMs,
  ]);
}

export function validateTenantRedisPurgeTarget(target: TenantRedisPurgeTarget): void {
  exactKeys(target, [
    ...IDENTITY_KEYS,
    "scope",
    "targetOrdinal",
    "sessionId",
    "graveMarkerSha256",
    "redisNamespaceSha256",
    "leasePlanTargetSha256",
    "fencePlanTargetSha256",
    "streamPlanTargetSha256",
    "operationSha256",
    "capturedAtDbMs",
    "receiptSha256",
  ], "tenant Redis purge target");
  const expected = tenantRedisPurgeTargetSha256(target);
  digest(target.receiptSha256, "tenant Redis purge target receipt");
  if (target.receiptSha256 !== expected) {
    throw new Error("tenant Redis purge target receipt does not match");
  }
}

export const EMPTY_TENANT_REDIS_PURGE_TARGET_ROOT_SHA256 = sha256([
  "tenant-redis-purge-target-root-v1",
]);
export const EMPTY_TENANT_REDIS_PURGE_TARGET_ACK_ROOT_SHA256 = sha256([
  "tenant-redis-purge-target-ack-root-v1",
]);
export const EMPTY_TENANT_REDIS_PURGE_DOMAIN_ACK_ROOT_SHA256 = sha256([
  "tenant-redis-purge-domain-ack-root-v1",
]);
export const EMPTY_TENANT_REDIS_PURGE_MARKER_ROOT_SHA256 = sha256([
  "tenant-redis-purge-marker-root-v1",
]);

export function tenantRedisPurgeTargetRootSha256(
  targets: readonly TenantRedisPurgeTarget[],
): string {
  const ordered = [...targets].sort((left, right) => left.targetOrdinal - right.targetOrdinal);
  const sessions = new Set<string>();
  for (const [ordinal, target] of ordered.entries()) {
    validateTenantRedisPurgeTarget(target);
    if (target.targetOrdinal !== ordinal) {
      throw new Error("tenant Redis purge target ordinals are not contiguous");
    }
    if (sessions.has(target.sessionId)) throw new Error("tenant Redis purge session is duplicated");
    sessions.add(target.sessionId);
    if (ordinal > 0 && ordered[ordinal - 1]!.sessionId >= target.sessionId) {
      throw new Error("tenant Redis purge targets are not ordered by session id");
    }
    if (ordered[0] !== undefined && (!sameIdentity(ordered[0]!, target)
      || ordered[0]!.capturedAtDbMs !== target.capturedAtDbMs
      || ordered[0]!.redisNamespaceSha256 !== target.redisNamespaceSha256)) {
      throw new Error("tenant Redis purge targets do not share one atomic source");
    }
  }
  return sha256([
    "tenant-redis-purge-target-root-v1",
    ...ordered.map((target) => target.receiptSha256),
  ]);
}

export interface TenantRedisPurgeMarkerEvidence {
  adapterProtocol: typeof TENANT_REDIS_PURGE_ADAPTER_PROTOCOL;
  redisNamespaceSha256: string;
  sessionId: string;
  operationSha256: string;
  leaseExisted: boolean;
  fenceExisted: boolean;
  streamExisted: boolean;
}

export function tenantRedisPurgeMarkerSha256(evidence: TenantRedisPurgeMarkerEvidence): string {
  exactKeys(evidence, [
    "adapterProtocol",
    "redisNamespaceSha256",
    "sessionId",
    "operationSha256",
    "leaseExisted",
    "fenceExisted",
    "streamExisted",
  ], "tenant Redis purge marker evidence");
  if (evidence.adapterProtocol !== TENANT_REDIS_PURGE_ADAPTER_PROTOCOL) {
    throw new Error("tenant Redis purge marker adapter protocol is invalid");
  }
  digest(evidence.redisNamespaceSha256, "tenant Redis purge marker namespace");
  sessionId(evidence.sessionId);
  digest(evidence.operationSha256, "tenant Redis purge marker operation");
  for (const [value, name] of [
    [evidence.leaseExisted, "lease"],
    [evidence.fenceExisted, "fence"],
    [evidence.streamExisted, "stream"],
  ] as const) {
    if (typeof value !== "boolean") throw new Error(`tenant Redis purge marker ${name} bit is invalid`);
  }
  return sha256([
    "tenant-redis-purge-marker-v1",
    evidence.adapterProtocol,
    evidence.redisNamespaceSha256,
    evidence.sessionId,
    evidence.operationSha256,
    evidence.leaseExisted,
    evidence.fenceExisted,
    evidence.streamExisted,
  ]);
}

export interface TenantRedisPurgeDurableMarker extends TenantRedisPurgeMarkerEvidence {
  markerSha256: string;
}

export function validateTenantRedisPurgeDurableMarker(
  marker: TenantRedisPurgeDurableMarker,
): void {
  exactKeys(marker, [
    "adapterProtocol",
    "redisNamespaceSha256",
    "sessionId",
    "operationSha256",
    "leaseExisted",
    "fenceExisted",
    "streamExisted",
    "markerSha256",
  ], "tenant Redis purge durable marker");
  const expected = tenantRedisPurgeMarkerSha256({
    adapterProtocol: marker.adapterProtocol,
    redisNamespaceSha256: marker.redisNamespaceSha256,
    sessionId: marker.sessionId,
    operationSha256: marker.operationSha256,
    leaseExisted: marker.leaseExisted,
    fenceExisted: marker.fenceExisted,
    streamExisted: marker.streamExisted,
  });
  digest(marker.markerSha256, "tenant Redis purge durable marker");
  if (marker.markerSha256 !== expected) {
    throw new Error("tenant Redis purge durable marker does not match");
  }
}

export interface TenantRedisPurgeAdapterResult extends TenantRedisPurgeDurableMarker {
  replayed: boolean;
}

export function validateTenantRedisPurgeAdapterResult(
  result: TenantRedisPurgeAdapterResult,
): void {
  exactKeys(result, [
    "adapterProtocol",
    "redisNamespaceSha256",
    "sessionId",
    "operationSha256",
    "leaseExisted",
    "fenceExisted",
    "streamExisted",
    "markerSha256",
    "replayed",
  ], "tenant Redis purge adapter result");
  const expected = tenantRedisPurgeMarkerSha256({
    adapterProtocol: result.adapterProtocol,
    redisNamespaceSha256: result.redisNamespaceSha256,
    sessionId: result.sessionId,
    operationSha256: result.operationSha256,
    leaseExisted: result.leaseExisted,
    fenceExisted: result.fenceExisted,
    streamExisted: result.streamExisted,
  });
  digest(result.markerSha256, "tenant Redis purge marker");
  if (result.markerSha256 !== expected) {
    throw new Error("tenant Redis purge adapter marker does not match");
  }
  if (typeof result.replayed !== "boolean") {
    throw new Error("tenant Redis purge adapter replay flag is invalid");
  }
}

export interface TenantRedisPurgeAdapter {
  readonly redisNamespaceSha256: string;
  purgeSessionState(input: {
    sessionId: string;
    operationSha256: string;
  }): Promise<TenantRedisPurgeAdapterResult>;
  inspectSessionPurge(input: {
    sessionId: string;
    operationSha256: string;
  }): Promise<TenantRedisPurgeAdapterResult | null>;
  /**
   * Re-delete live state only when the exact immutable marker already exists. A missing marker
   * returns null without deleting state or creating authority; conflicts and corruption fail.
   */
  replayExistingSessionPurge(input: {
    sessionId: string;
    operationSha256: string;
  }): Promise<TenantRedisPurgeAdapterResult | null>;
  /** Reapply the exact historical marker after Redis loss/restore; never resample existence bits. */
  restoreSessionPurgeFence(
    marker: TenantRedisPurgeDurableMarker,
  ): Promise<TenantRedisPurgeAdapterResult>;
  close(): Promise<void>;
}

export interface TenantRedisPurgeTargetAck extends TenantRedisPurgeIdentity {
  scope: typeof TENANT_REDIS_PURGE_TARGET_ACK_SCOPE;
  targetOrdinal: number;
  sessionId: string;
  targetReceiptSha256: string;
  operationSha256: string;
  adapterProtocol: typeof TENANT_REDIS_PURGE_ADAPTER_PROTOCOL;
  redisNamespaceSha256: string;
  leaseExisted: boolean;
  fenceExisted: boolean;
  streamExisted: boolean;
  markerSha256: string;
  completedClaimAttempt: number;
  completedClaimTokenSha256: string;
  storeDbTimestampMs: number;
  receiptSha256: string;
}

type TargetAckBody = Omit<TenantRedisPurgeTargetAck, "receiptSha256">;

export function tenantRedisPurgeTargetAckSha256(ack: TargetAckBody): string {
  validateTenantRedisPurgeIdentity(ack);
  if (ack.scope !== TENANT_REDIS_PURGE_TARGET_ACK_SCOPE) {
    throw new Error("tenant Redis purge target ACK scope is invalid");
  }
  count(ack.targetOrdinal, "tenant Redis purge target ACK ordinal");
  sessionId(ack.sessionId);
  digest(ack.targetReceiptSha256, "tenant Redis purge target receipt");
  const expectedMarker = tenantRedisPurgeMarkerSha256({
    adapterProtocol: ack.adapterProtocol,
    redisNamespaceSha256: ack.redisNamespaceSha256,
    sessionId: ack.sessionId,
    operationSha256: ack.operationSha256,
    leaseExisted: ack.leaseExisted,
    fenceExisted: ack.fenceExisted,
    streamExisted: ack.streamExisted,
  });
  digest(ack.markerSha256, "tenant Redis purge target ACK marker");
  if (ack.markerSha256 !== expectedMarker) {
    throw new Error("tenant Redis purge target ACK marker does not match");
  }
  positive(ack.completedClaimAttempt, "tenant Redis purge target ACK claim attempt");
  digest(ack.completedClaimTokenSha256, "tenant Redis purge target ACK claim token");
  timestamp(ack.storeDbTimestampMs, "tenant Redis purge target ACK timestamp");
  return sha256([
    "tenant-redis-purge-target-ack-v1",
    ack.scope,
    ...IDENTITY_KEYS.map((key) => ack[key]),
    ack.targetOrdinal,
    ack.sessionId,
    ack.targetReceiptSha256,
    ack.operationSha256,
    ack.adapterProtocol,
    ack.redisNamespaceSha256,
    ack.leaseExisted,
    ack.fenceExisted,
    ack.streamExisted,
    ack.markerSha256,
    ack.completedClaimAttempt,
    ack.completedClaimTokenSha256,
    ack.storeDbTimestampMs,
  ]);
}

export function validateTenantRedisPurgeTargetAck(ack: TenantRedisPurgeTargetAck): void {
  exactKeys(ack, [
    ...IDENTITY_KEYS,
    "scope",
    "targetOrdinal",
    "sessionId",
    "targetReceiptSha256",
    "operationSha256",
    "adapterProtocol",
    "redisNamespaceSha256",
    "leaseExisted",
    "fenceExisted",
    "streamExisted",
    "markerSha256",
    "completedClaimAttempt",
    "completedClaimTokenSha256",
    "storeDbTimestampMs",
    "receiptSha256",
  ], "tenant Redis purge target ACK");
  const expected = tenantRedisPurgeTargetAckSha256(ack);
  digest(ack.receiptSha256, "tenant Redis purge target ACK receipt");
  if (ack.receiptSha256 !== expected) {
    throw new Error("tenant Redis purge target ACK receipt does not match");
  }
}

export function tenantRedisPurgeTargetAckRootSha256(
  acks: readonly TenantRedisPurgeTargetAck[],
): string {
  const ordered = [...acks].sort((left, right) => left.targetOrdinal - right.targetOrdinal);
  const ordinals = new Set<number>();
  const sessions = new Set<string>();
  for (const ack of ordered) {
    validateTenantRedisPurgeTargetAck(ack);
    if (ordinals.has(ack.targetOrdinal) || sessions.has(ack.sessionId)) {
      throw new Error("tenant Redis purge target ACK is duplicated");
    }
    ordinals.add(ack.targetOrdinal);
    sessions.add(ack.sessionId);
    if (ordered[0] !== undefined && !sameIdentity(ordered[0]!, ack)) {
      throw new Error("tenant Redis purge target ACKs do not share one identity");
    }
  }
  return sha256([
    "tenant-redis-purge-target-ack-root-v1",
    ...ordered.map((ack) => ack.receiptSha256),
  ]);
}

export function tenantRedisPurgeMarkerRootSha256(
  acks: readonly TenantRedisPurgeTargetAck[],
): string {
  const hashes = acks.map((ack) => {
    validateTenantRedisPurgeTargetAck(ack);
    return ack.markerSha256;
  }).sort();
  if (new Set(hashes).size !== hashes.length) {
    throw new Error("tenant Redis purge marker is duplicated");
  }
  return sha256(["tenant-redis-purge-marker-root-v1", ...hashes]);
}

export interface TenantRedisPurgeDomainAck extends TenantRedisPurgeIdentity {
  scope: typeof TENANT_REDIS_PURGE_DOMAIN_ACK_SCOPE;
  domain: TenantRedisPurgeDomain;
  domainOrdinal: number;
  globalAckSeq: number;
  previousGlobalAckSha256: string;
  planEntryReceiptSha256: string;
  planTargetCount: number;
  planTargetRootSha256: string;
  affectedCount: number;
  targetAckCount: number;
  targetAckRootSha256: string;
  markerCount: number;
  markerRootSha256: string;
  adapterProtocol: typeof TENANT_REDIS_PURGE_ADAPTER_PROTOCOL;
  redisNamespaceSha256: string;
  completedClaimAttempt: number;
  completedClaimTokenSha256: string;
  storeDbTimestampMs: number;
  receiptSha256: string;
}

type DomainAckBody = Omit<TenantRedisPurgeDomainAck, "receiptSha256">;

export function tenantRedisPurgeDomainAckSha256(ack: DomainAckBody): string {
  validateTenantRedisPurgeIdentity(ack);
  if (ack.scope !== TENANT_REDIS_PURGE_DOMAIN_ACK_SCOPE) {
    throw new Error("tenant Redis purge domain ACK scope is invalid");
  }
  const ordinal = tenantRedisPurgeDomainOrdinal(ack.domain);
  if (ack.domainOrdinal !== ordinal || ack.globalAckSeq !== ordinal + 1) {
    throw new Error("tenant Redis purge domain ACK order is invalid");
  }
  digest(ack.previousGlobalAckSha256, "tenant Redis purge previous domain ACK root");
  digest(ack.planEntryReceiptSha256, "tenant Redis purge plan-entry receipt");
  count(ack.planTargetCount, "tenant Redis purge plan target count");
  digest(ack.planTargetRootSha256, "tenant Redis purge plan target root");
  count(ack.affectedCount, "tenant Redis purge affected count");
  count(ack.targetAckCount, "tenant Redis purge target ACK count");
  digest(ack.targetAckRootSha256, "tenant Redis purge target ACK root");
  count(ack.markerCount, "tenant Redis purge marker count");
  digest(ack.markerRootSha256, "tenant Redis purge marker root");
  if (ack.planTargetCount !== ack.affectedCount
    || ack.planTargetCount !== ack.targetAckCount
    || ack.planTargetCount !== ack.markerCount) {
    throw new Error("tenant Redis purge domain ACK does not cover every planned target");
  }
  if (ack.planTargetCount === 0
    && (ack.planTargetRootSha256 !== tenantRedisPurgePlanTargetRootSha256(ack.domain, [])
      || ack.targetAckRootSha256 !== EMPTY_TENANT_REDIS_PURGE_TARGET_ACK_ROOT_SHA256
      || ack.markerRootSha256 !== EMPTY_TENANT_REDIS_PURGE_MARKER_ROOT_SHA256)) {
    throw new Error("empty tenant Redis purge domain ACK has non-empty evidence roots");
  }
  if (ack.adapterProtocol !== TENANT_REDIS_PURGE_ADAPTER_PROTOCOL) {
    throw new Error("tenant Redis purge domain ACK adapter protocol is invalid");
  }
  digest(ack.redisNamespaceSha256, "tenant Redis purge domain ACK namespace");
  positive(ack.completedClaimAttempt, "tenant Redis purge domain ACK claim attempt");
  digest(ack.completedClaimTokenSha256, "tenant Redis purge domain ACK claim token");
  timestamp(ack.storeDbTimestampMs, "tenant Redis purge domain ACK timestamp");
  return sha256([
    "tenant-redis-purge-domain-ack-v1",
    ack.scope,
    ...IDENTITY_KEYS.map((key) => ack[key]),
    ack.domain,
    ack.domainOrdinal,
    ack.globalAckSeq,
    ack.previousGlobalAckSha256,
    ack.planEntryReceiptSha256,
    ack.planTargetCount,
    ack.planTargetRootSha256,
    ack.affectedCount,
    ack.targetAckCount,
    ack.targetAckRootSha256,
    ack.markerCount,
    ack.markerRootSha256,
    ack.adapterProtocol,
    ack.redisNamespaceSha256,
    ack.completedClaimAttempt,
    ack.completedClaimTokenSha256,
    ack.storeDbTimestampMs,
  ]);
}

export function validateTenantRedisPurgeDomainAck(ack: TenantRedisPurgeDomainAck): void {
  exactKeys(ack, [
    ...IDENTITY_KEYS,
    "scope",
    "domain",
    "domainOrdinal",
    "globalAckSeq",
    "previousGlobalAckSha256",
    "planEntryReceiptSha256",
    "planTargetCount",
    "planTargetRootSha256",
    "affectedCount",
    "targetAckCount",
    "targetAckRootSha256",
    "markerCount",
    "markerRootSha256",
    "adapterProtocol",
    "redisNamespaceSha256",
    "completedClaimAttempt",
    "completedClaimTokenSha256",
    "storeDbTimestampMs",
    "receiptSha256",
  ], "tenant Redis purge domain ACK");
  const expected = tenantRedisPurgeDomainAckSha256(ack);
  digest(ack.receiptSha256, "tenant Redis purge domain ACK receipt");
  if (ack.receiptSha256 !== expected) {
    throw new Error("tenant Redis purge domain ACK receipt does not match");
  }
}

export function tenantRedisPurgeNextDomainAckRootSha256(
  previousRootSha256: string,
  domain: TenantRedisPurgeDomain,
  receiptSha256: string,
): string {
  digest(previousRootSha256, "tenant Redis purge previous domain ACK root");
  tenantRedisPurgeDomainOrdinal(domain);
  digest(receiptSha256, "tenant Redis purge domain ACK receipt");
  return sha256([
    "tenant-redis-purge-domain-ack-chain-v1",
    previousRootSha256,
    domain,
    receiptSha256,
  ]);
}

export function tenantRedisPurgeDomainAckRootSha256(
  acks: readonly TenantRedisPurgeDomainAck[],
): string {
  const ordered = [...acks].sort((left, right) => left.domainOrdinal - right.domainOrdinal);
  let root = EMPTY_TENANT_REDIS_PURGE_DOMAIN_ACK_ROOT_SHA256;
  for (const [ordinal, ack] of ordered.entries()) {
    validateTenantRedisPurgeDomainAck(ack);
    if (ack.domainOrdinal !== ordinal || ack.globalAckSeq !== ordinal + 1) {
      throw new Error("tenant Redis purge domain ACK catalog is incomplete or duplicated");
    }
    if (ack.previousGlobalAckSha256 !== root) {
      throw new Error("tenant Redis purge domain ACK chain is broken");
    }
    if (ordered[0] !== undefined && !sameIdentity(ordered[0]!, ack)) {
      throw new Error("tenant Redis purge domain ACKs do not share one identity");
    }
    root = tenantRedisPurgeNextDomainAckRootSha256(root, ack.domain, ack.receiptSha256);
  }
  return root;
}

export interface TenantRedisPurgeReceipt extends TenantRedisPurgeSource {
  scope: typeof TENANT_REDIS_PURGE_RECEIPT_SCOPE;
  targetCount: number;
  targetRootSha256: string;
  targetAckCount: number;
  targetAckRootSha256: string;
  domainAckCount: number;
  domainAckRootSha256: string;
  markerCount: number;
  markerRootSha256: string;
  unresolvedBlockerCount: number;
  storeDbTimestampMs: number;
  completedClaimAttempt: number;
  completedClaimTokenSha256: string;
  redisPurgeComplete: true;
  allDomainsComplete: false;
  contentPurgeExecuted: false;
  receiptSha256: string;
}

type ReceiptBody = Omit<TenantRedisPurgeReceipt, "receiptSha256">;

export function tenantRedisPurgeReceiptSha256(receipt: ReceiptBody): string {
  validateTenantRedisPurgeSource(receipt);
  if (receipt.scope !== TENANT_REDIS_PURGE_RECEIPT_SCOPE) {
    throw new Error("tenant Redis purge receipt scope is invalid");
  }
  count(receipt.targetCount, "tenant Redis purge receipt target count");
  digest(receipt.targetRootSha256, "tenant Redis purge receipt target root");
  count(receipt.targetAckCount, "tenant Redis purge receipt target ACK count");
  digest(receipt.targetAckRootSha256, "tenant Redis purge receipt target ACK root");
  count(receipt.domainAckCount, "tenant Redis purge receipt domain ACK count");
  digest(receipt.domainAckRootSha256, "tenant Redis purge receipt domain ACK root");
  count(receipt.markerCount, "tenant Redis purge receipt marker count");
  digest(receipt.markerRootSha256, "tenant Redis purge receipt marker root");
  if (receipt.targetCount !== receipt.graveMarkerCount
    || receipt.targetAckCount !== receipt.targetCount
    || receipt.markerCount !== receipt.targetCount) {
    throw new Error("tenant Redis purge receipt does not cover every grave marker");
  }
  if (receipt.targetCount === 0
    && (receipt.targetRootSha256 !== EMPTY_TENANT_REDIS_PURGE_TARGET_ROOT_SHA256
      || receipt.targetAckRootSha256 !== EMPTY_TENANT_REDIS_PURGE_TARGET_ACK_ROOT_SHA256
      || receipt.markerRootSha256 !== EMPTY_TENANT_REDIS_PURGE_MARKER_ROOT_SHA256)) {
    throw new Error("empty tenant Redis purge receipt has non-empty evidence roots");
  }
  if (receipt.domainAckCount !== TENANT_REDIS_PURGE_DOMAINS.length) {
    throw new Error("tenant Redis purge receipt does not cover the fixed domain catalog");
  }
  const expectedBlockers = receipt.sourceUnresolvedBlockerCount
    - TENANT_REDIS_PURGE_DOMAINS.length;
  if (receipt.unresolvedBlockerCount !== expectedBlockers) {
    throw new Error("tenant Redis purge receipt blocker count is invalid");
  }
  timestamp(receipt.storeDbTimestampMs, "tenant Redis purge receipt timestamp");
  if (receipt.storeDbTimestampMs < receipt.sourceEvidenceDbMs) {
    throw new Error("tenant Redis purge receipt predates source evidence");
  }
  positive(receipt.completedClaimAttempt, "tenant Redis purge receipt claim attempt");
  digest(receipt.completedClaimTokenSha256, "tenant Redis purge receipt claim token");
  if (receipt.redisPurgeComplete !== true || receipt.allDomainsComplete !== false
    || receipt.contentPurgeExecuted !== false) {
    throw new Error("tenant Redis purge receipt flags are invalid");
  }
  return sha256([
    "tenant-redis-purge-v1",
    receipt.scope,
    ...SOURCE_KEYS.map((key) => receipt[key]),
    receipt.targetCount,
    receipt.targetRootSha256,
    receipt.targetAckCount,
    receipt.targetAckRootSha256,
    receipt.domainAckCount,
    receipt.domainAckRootSha256,
    receipt.markerCount,
    receipt.markerRootSha256,
    receipt.unresolvedBlockerCount,
    receipt.storeDbTimestampMs,
    receipt.completedClaimAttempt,
    receipt.completedClaimTokenSha256,
    receipt.redisPurgeComplete,
    receipt.allDomainsComplete,
    receipt.contentPurgeExecuted,
  ]);
}

export function validateTenantRedisPurgeReceipt(receipt: TenantRedisPurgeReceipt): void {
  exactKeys(receipt, [
    ...SOURCE_KEYS,
    "scope",
    "targetCount",
    "targetRootSha256",
    "targetAckCount",
    "targetAckRootSha256",
    "domainAckCount",
    "domainAckRootSha256",
    "markerCount",
    "markerRootSha256",
    "unresolvedBlockerCount",
    "storeDbTimestampMs",
    "completedClaimAttempt",
    "completedClaimTokenSha256",
    "redisPurgeComplete",
    "allDomainsComplete",
    "contentPurgeExecuted",
    "receiptSha256",
  ], "tenant Redis purge receipt");
  const expected = tenantRedisPurgeReceiptSha256(receipt);
  digest(receipt.receiptSha256, "tenant Redis purge receipt");
  if (receipt.receiptSha256 !== expected) {
    throw new Error("tenant Redis purge receipt does not match");
  }
}

export interface TenantRedisPurgeEvidenceBundle {
  targets: readonly TenantRedisPurgeTarget[];
  targetAcks: readonly TenantRedisPurgeTargetAck[];
  domainAcks: readonly TenantRedisPurgeDomainAck[];
  receipt: TenantRedisPurgeReceipt;
}

export function validateTenantRedisPurgeEvidenceBundle(
  bundle: TenantRedisPurgeEvidenceBundle,
): void {
  exactKeys(bundle, ["targets", "targetAcks", "domainAcks", "receipt"],
    "tenant Redis purge evidence bundle");
  validateTenantRedisPurgeReceipt(bundle.receipt);
  if (bundle.targets.length !== bundle.receipt.targetCount
    || tenantRedisPurgeTargetRootSha256(bundle.targets) !== bundle.receipt.targetRootSha256
    || bundle.targetAcks.length !== bundle.receipt.targetAckCount
    || tenantRedisPurgeTargetAckRootSha256(bundle.targetAcks)
      !== bundle.receipt.targetAckRootSha256
    || tenantRedisPurgeMarkerRootSha256(bundle.targetAcks) !== bundle.receipt.markerRootSha256
    || bundle.domainAcks.length !== bundle.receipt.domainAckCount
    || tenantRedisPurgeDomainAckRootSha256(bundle.domainAcks)
      !== bundle.receipt.domainAckRootSha256) {
    throw new Error("tenant Redis purge evidence roots do not match the terminal receipt");
  }
  if (tenantRedisPurgeGraveMarkerRootSha256(
    bundle.targets.map((target) => target.graveMarkerSha256),
  ) !== bundle.receipt.graveMarkerRootSha256) {
    throw new Error("tenant Redis purge target catalog does not match the T3f grave root");
  }
  const targetByOrdinal = new Map(bundle.targets.map((target) => [target.targetOrdinal, target]));
  for (const ack of bundle.targetAcks) {
    const target = targetByOrdinal.get(ack.targetOrdinal);
    if (!target || !sameIdentity(target, ack) || ack.sessionId !== target.sessionId
      || ack.targetReceiptSha256 !== target.receiptSha256
      || ack.operationSha256 !== target.operationSha256
      || ack.redisNamespaceSha256 !== target.redisNamespaceSha256) {
      throw new Error("tenant Redis purge target ACK does not match its target");
    }
  }
  const authorizationSha256 = bundle.receipt.completedClaimTokenSha256;
  const expectedTargetAckRoot = tenantRedisPurgeTargetAckRootSha256(bundle.targetAcks);
  const expectedMarkerRoot = tenantRedisPurgeMarkerRootSha256(bundle.targetAcks);
  if (tenantRedisPurgePlanEntryRootSha256(bundle.domainAcks.map((ack) => ({
    domain: ack.domain,
    planEntryReceiptSha256: ack.planEntryReceiptSha256,
  }))) !== bundle.receipt.redisPlanEntryRootSha256) {
    throw new Error("tenant Redis purge domain ACKs do not match the T3d plan-entry root");
  }
  for (const ack of bundle.domainAcks) {
    if (!sameIdentity(ack, bundle.receipt)
      || ack.planTargetCount !== bundle.targets.length
      || ack.affectedCount !== bundle.targets.length
      || ack.targetAckCount !== bundle.targetAcks.length
      || ack.targetAckRootSha256 !== expectedTargetAckRoot
      || ack.markerCount !== bundle.targetAcks.length
      || ack.markerRootSha256 !== expectedMarkerRoot
      || ack.redisNamespaceSha256 !== bundle.receipt.redisNamespaceSha256
      || ack.completedClaimAttempt !== bundle.receipt.completedClaimAttempt
      || ack.completedClaimTokenSha256 !== authorizationSha256) {
      throw new Error("tenant Redis purge domain ACK does not match its evidence bundle");
    }
    const expectedPlanRoot = tenantPurgePlanTargetRootSha256(
      ack.domain,
      bundle.targets.map((target) => {
        if (ack.domain === "redis_leases") return target.leasePlanTargetSha256;
        if (ack.domain === "redis_fences") return target.fencePlanTargetSha256;
        return target.streamPlanTargetSha256;
      }),
    );
    if (ack.planTargetRootSha256 !== expectedPlanRoot) {
      throw new Error("tenant Redis purge domain ACK plan root does not match its target catalog");
    }
  }
  const firstTarget = bundle.targets[0];
  if (firstTarget !== undefined && (!sameIdentity(firstTarget, bundle.receipt)
    || firstTarget.redisNamespaceSha256 !== bundle.receipt.redisNamespaceSha256
    || firstTarget.capturedAtDbMs < bundle.receipt.sourceEvidenceDbMs)) {
    throw new Error("tenant Redis purge target catalog does not match its source");
  }
}

export const TENANT_REDIS_PURGE_RESTORE_FENCE_SCOPE =
  "tenant-redis-purge-restore-fence-v1" as const;

/**
 * Content-free projection of any durable target/ACK pair. Startup replay includes partial queued or
 * blocked work because publishing a Redis marker is already irreversible. The store revalidates the
 * job and current roots (plus the full terminal bundle when sealed) before projection. The first
 * writer's claim remains in the target ACK for audit, but is intentionally not part of this replay
 * identity: an exact operation survives lease loss and can be restored by a later process.
 */
export interface TenantRedisPurgeRestoreFence extends TenantRedisPurgeIdentity {
  scope: typeof TENANT_REDIS_PURGE_RESTORE_FENCE_SCOPE;
  jobPhase: TenantRedisPurgeJobPhase;
  targetOrdinal: number;
  sessionId: string;
  targetReceiptSha256: string;
  targetAckReceiptSha256: string;
  /** Present only after seal; partial queued/blocked ACKs are already irreversible fences. */
  terminalReceiptSha256: string | null;
  operationSha256: string;
  adapterProtocol: typeof TENANT_REDIS_PURGE_ADAPTER_PROTOCOL;
  redisNamespaceSha256: string;
  leaseExisted: boolean;
  fenceExisted: boolean;
  streamExisted: boolean;
  markerSha256: string;
  fenceSha256: string;
}

type RestoreFenceBody = Omit<TenantRedisPurgeRestoreFence, "fenceSha256">;

export function tenantRedisPurgeRestoreFenceSha256(fence: RestoreFenceBody): string {
  validateTenantRedisPurgeIdentity(fence);
  if (fence.scope !== TENANT_REDIS_PURGE_RESTORE_FENCE_SCOPE) {
    throw new Error("tenant Redis purge restore fence scope is invalid");
  }
  if (!(fence.jobPhase === "queued" || fence.jobPhase === "redis_purge_sealed"
    || fence.jobPhase === "blocked")) {
    throw new Error("tenant Redis purge restore fence job phase is invalid");
  }
  count(fence.targetOrdinal, "tenant Redis purge restore fence ordinal");
  sessionId(fence.sessionId);
  for (const [value, name] of [
    [fence.targetReceiptSha256, "target receipt"],
    [fence.targetAckReceiptSha256, "target ACK receipt"],
  ] as const) digest(value, `tenant Redis purge restore fence ${name}`);
  if (fence.jobPhase === "redis_purge_sealed") {
    if (fence.terminalReceiptSha256 === null) {
      throw new Error("sealed tenant Redis purge restore fence lacks its terminal receipt");
    }
    digest(fence.terminalReceiptSha256, "tenant Redis purge restore fence terminal receipt");
  } else if (fence.terminalReceiptSha256 !== null) {
    throw new Error("partial tenant Redis purge restore fence has a terminal receipt");
  }
  const expectedMarker = tenantRedisPurgeMarkerSha256({
    adapterProtocol: fence.adapterProtocol,
    redisNamespaceSha256: fence.redisNamespaceSha256,
    sessionId: fence.sessionId,
    operationSha256: fence.operationSha256,
    leaseExisted: fence.leaseExisted,
    fenceExisted: fence.fenceExisted,
    streamExisted: fence.streamExisted,
  });
  digest(fence.markerSha256, "tenant Redis purge restore fence marker");
  if (fence.markerSha256 !== expectedMarker) {
    throw new Error("tenant Redis purge restore fence marker does not match");
  }
  return sha256([
    "tenant-redis-purge-restore-fence-v1",
    fence.scope,
    ...IDENTITY_KEYS.map((key) => fence[key]),
    fence.jobPhase,
    fence.targetOrdinal,
    fence.sessionId,
    fence.targetReceiptSha256,
    fence.targetAckReceiptSha256,
    fence.terminalReceiptSha256,
    fence.operationSha256,
    fence.adapterProtocol,
    fence.redisNamespaceSha256,
    fence.leaseExisted,
    fence.fenceExisted,
    fence.streamExisted,
    fence.markerSha256,
  ]);
}

export function validateTenantRedisPurgeRestoreFence(
  fence: TenantRedisPurgeRestoreFence,
): void {
  exactKeys(fence, [
    ...IDENTITY_KEYS,
    "scope",
    "jobPhase",
    "targetOrdinal",
    "sessionId",
    "targetReceiptSha256",
    "targetAckReceiptSha256",
    "terminalReceiptSha256",
    "operationSha256",
    "adapterProtocol",
    "redisNamespaceSha256",
    "leaseExisted",
    "fenceExisted",
    "streamExisted",
    "markerSha256",
    "fenceSha256",
  ], "tenant Redis purge restore fence");
  const expected = tenantRedisPurgeRestoreFenceSha256(fence);
  digest(fence.fenceSha256, "tenant Redis purge restore fence");
  if (fence.fenceSha256 !== expected) {
    throw new Error("tenant Redis purge restore fence does not match");
  }
}

export interface ListTenantRedisPurgeRestoreFencesOptions {
  limit: number;
  cursor?: string;
}

export interface ListTenantRedisPurgeRestoreFencesResult {
  fences: TenantRedisPurgeRestoreFence[];
  nextCursor?: string;
}

export function validateListTenantRedisPurgeRestoreFencesOptions(
  options: ListTenantRedisPurgeRestoreFencesOptions,
): void {
  exactKeys(options, ["limit", ...(options.cursor === undefined ? [] : ["cursor"])],
    "list tenant Redis purge restore fences options");
  positive(options.limit, "tenant Redis purge restore fence limit");
  if (options.cursor !== undefined
    && (!/^[A-Za-z0-9_-]{1,512}$/.test(options.cursor))) {
    throw new Error("tenant Redis purge restore fence cursor is invalid");
  }
}

export function validateListTenantRedisPurgeRestoreFencesResult(
  result: ListTenantRedisPurgeRestoreFencesResult,
): void {
  exactKeys(result, ["fences", ...(result.nextCursor === undefined ? [] : ["nextCursor"])],
    "list tenant Redis purge restore fences result");
  for (const fence of result.fences) validateTenantRedisPurgeRestoreFence(fence);
  if (result.nextCursor !== undefined
    && !/^[A-Za-z0-9_-]{1,512}$/.test(result.nextCursor)) {
    throw new Error("tenant Redis purge restore fence next cursor is invalid");
  }
}

export interface MaterializeTenantRedisPurgeJobsOptions { limit: number }
export interface ClaimTenantRedisPurgesOptions {
  limit: number;
  leaseMs: number;
  claimToken: string;
}
export interface RenewTenantRedisPurgeOptions { leaseMs: number }
export interface RetryTenantRedisPurgeOptions {
  delayMs: number;
  errorCode: TenantRedisPurgeRetryErrorCode;
}

interface TenantRedisPurgeJobBase extends TenantRedisPurgeSource {
  phase: TenantRedisPurgeJobPhase;
  targetCount: number;
  targetRootSha256: string;
  targetAckCount: number;
  targetAckRootSha256: string;
  domainAckCount: number;
  domainAckRootSha256: string;
  markerCount: number;
  markerRootSha256: string;
  unresolvedBlockerCount: number;
  attempts: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export type TenantRedisPurgeJobRecord = TenantRedisPurgeJobBase & (
  | {
      phase: "queued";
      availableAtMs: number;
      claimToken?: string;
      leaseUntilMs?: number;
      lastErrorCode?: TenantRedisPurgeRetryErrorCode;
      terminalReceiptSha256?: never;
      sealedAtDbMs?: never;
      completedClaimAttempt?: never;
      completedClaimTokenSha256?: never;
      blockedAtDbMs?: never;
      blockedReasonCode?: never;
    }
  | {
      phase: "redis_purge_sealed";
      availableAtMs?: never;
      claimToken?: never;
      leaseUntilMs?: never;
      lastErrorCode?: never;
      terminalReceiptSha256: string;
      sealedAtDbMs: number;
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
      terminalReceiptSha256?: never;
      sealedAtDbMs?: never;
      completedClaimAttempt?: never;
      completedClaimTokenSha256?: never;
      blockedAtDbMs: number;
      blockedReasonCode: TenantRedisPurgeBlockReasonCode;
    }
);

export interface TenantRedisPurgeClaim extends TenantRedisPurgeSource {
  phase: "queued";
  claimAttempt: number;
  claimToken: string;
  leaseUntilMs: number;
  targetCount: number;
  targetRootSha256: string;
}

export type TenantRedisPurgeAuthorization = Pick<
  TenantRedisPurgeClaim,
  | "requestId"
  | "tenantId"
  | "subjectGeneration"
  | "planBuildGeneration"
  | "executionGeneration"
  | "databasePurgeGeneration"
  | "redisPurgeGeneration"
  | "claimAttempt"
  | "claimToken"
>;

export function validateTenantRedisPurgeAuthorization(
  authorization: TenantRedisPurgeAuthorization,
): void {
  exactKeys(authorization, [...IDENTITY_KEYS, "claimAttempt", "claimToken"],
    "tenant Redis purge authorization");
  validateTenantRedisPurgeIdentity(authorization);
  positive(authorization.claimAttempt, "tenant Redis purge claim attempt");
  claimToken(authorization.claimToken);
}

export function validateTenantRedisPurgeClaim(claim: TenantRedisPurgeClaim): void {
  exactKeys(claim, [
    ...SOURCE_KEYS,
    "phase",
    "claimAttempt",
    "claimToken",
    "leaseUntilMs",
    "targetCount",
    "targetRootSha256",
  ], "tenant Redis purge claim");
  validateTenantRedisPurgeSource(claim);
  if (claim.phase !== "queued") throw new Error("tenant Redis purge claim phase is invalid");
  positive(claim.claimAttempt, "tenant Redis purge claim attempt");
  claimToken(claim.claimToken);
  timestamp(claim.leaseUntilMs, "tenant Redis purge claim lease");
  count(claim.targetCount, "tenant Redis purge claim target count");
  digest(claim.targetRootSha256, "tenant Redis purge claim target root");
  if (claim.targetCount !== claim.graveMarkerCount) {
    throw new Error("tenant Redis purge claim target count does not match its grave catalog");
  }
}

export function tenantRedisPurgeAuthorizationMatches(
  authorization: TenantRedisPurgeAuthorization,
  job: TenantRedisPurgeJobRecord,
): boolean {
  validateTenantRedisPurgeAuthorization(authorization);
  validateTenantRedisPurgeJobRecord(job);
  return job.phase === "queued"
    && sameIdentity(authorization, job)
    && job.attempts === authorization.claimAttempt
    && job.claimToken === authorization.claimToken;
}

export function tenantRedisPurgeClaimFromJob(
  job: TenantRedisPurgeJobRecord,
): TenantRedisPurgeClaim | null {
  validateTenantRedisPurgeJobRecord(job);
  if (job.phase !== "queued" || job.claimToken === undefined || job.leaseUntilMs === undefined) {
    return null;
  }
  const claim: TenantRedisPurgeClaim = {
    ...Object.fromEntries(SOURCE_KEYS.map((key) => [key, job[key]])) as unknown as TenantRedisPurgeSource,
    phase: "queued",
    claimAttempt: job.attempts,
    claimToken: job.claimToken,
    leaseUntilMs: job.leaseUntilMs,
    targetCount: job.targetCount,
    targetRootSha256: job.targetRootSha256,
  };
  validateTenantRedisPurgeClaim(claim);
  return claim;
}

export function validateTenantRedisPurgeJobRecord(job: TenantRedisPurgeJobRecord): void {
  validateTenantRedisPurgeSource(job);
  count(job.targetCount, "tenant Redis purge job target count");
  digest(job.targetRootSha256, "tenant Redis purge job target root");
  count(job.targetAckCount, "tenant Redis purge job target ACK count");
  digest(job.targetAckRootSha256, "tenant Redis purge job target ACK root");
  count(job.domainAckCount, "tenant Redis purge job domain ACK count");
  digest(job.domainAckRootSha256, "tenant Redis purge job domain ACK root");
  count(job.markerCount, "tenant Redis purge job marker count");
  digest(job.markerRootSha256, "tenant Redis purge job marker root");
  count(job.unresolvedBlockerCount, "tenant Redis purge job blocker count");
  count(job.attempts, "tenant Redis purge job attempts");
  timestamp(job.createdAtMs, "tenant Redis purge job creation time");
  timestamp(job.updatedAtMs, "tenant Redis purge job update time");
  if (job.updatedAtMs < job.createdAtMs || job.targetCount !== job.graveMarkerCount
    || job.targetAckCount > job.targetCount || job.markerCount !== job.targetAckCount
    || job.domainAckCount > TENANT_REDIS_PURGE_DOMAINS.length
    || job.unresolvedBlockerCount > job.sourceUnresolvedBlockerCount) {
    throw new Error("tenant Redis purge job counters are invalid");
  }
  if (job.targetCount === 0 && job.targetRootSha256 !== EMPTY_TENANT_REDIS_PURGE_TARGET_ROOT_SHA256) {
    throw new Error("empty tenant Redis purge job has a non-empty target root");
  }
  if (job.targetAckCount === 0
    && job.targetAckRootSha256 !== EMPTY_TENANT_REDIS_PURGE_TARGET_ACK_ROOT_SHA256) {
    throw new Error("empty tenant Redis purge job has a non-empty target ACK root");
  }
  if (job.markerCount === 0
    && job.markerRootSha256 !== EMPTY_TENANT_REDIS_PURGE_MARKER_ROOT_SHA256) {
    throw new Error("empty tenant Redis purge job has a non-empty marker root");
  }
  const baseKeys = [
    ...SOURCE_KEYS,
    "phase",
    "targetCount",
    "targetRootSha256",
    "targetAckCount",
    "targetAckRootSha256",
    "domainAckCount",
    "domainAckRootSha256",
    "markerCount",
    "markerRootSha256",
    "unresolvedBlockerCount",
    "attempts",
    "createdAtMs",
    "updatedAtMs",
  ];
  if (job.phase === "queued") {
    exactKeys(job, [
      ...baseKeys,
      "availableAtMs",
      ...(job.claimToken === undefined ? [] : ["claimToken"]),
      ...(job.leaseUntilMs === undefined ? [] : ["leaseUntilMs"]),
      ...(job.lastErrorCode === undefined ? [] : ["lastErrorCode"]),
    ], "queued tenant Redis purge job");
    timestamp(job.availableAtMs, "tenant Redis purge job availability");
    if ((job.claimToken === undefined) !== (job.leaseUntilMs === undefined)) {
      throw new Error("tenant Redis purge job claim is incomplete");
    }
    if (job.claimToken === undefined) {
      if (job.availableAtMs < job.updatedAtMs) {
        throw new Error("tenant Redis purge job availability predates its update");
      }
    } else {
      claimToken(job.claimToken);
      timestamp(job.leaseUntilMs!, "tenant Redis purge job lease");
      if (job.attempts < 1 || job.leaseUntilMs! < job.updatedAtMs) {
        throw new Error("tenant Redis purge job active claim is invalid");
      }
    }
    if (job.lastErrorCode !== undefined
      && !(["temporary_failure", "dependency_pending"] as const).includes(job.lastErrorCode)) {
      throw new Error("tenant Redis purge job retry code is invalid");
    }
    if (job.domainAckCount !== 0
      || job.domainAckRootSha256 !== EMPTY_TENANT_REDIS_PURGE_DOMAIN_ACK_ROOT_SHA256
      || job.unresolvedBlockerCount !== job.sourceUnresolvedBlockerCount) {
      throw new Error("queued tenant Redis purge job contains terminal evidence");
    }
    return;
  }
  if (job.phase === "redis_purge_sealed") {
    exactKeys(job, [
      ...baseKeys,
      "terminalReceiptSha256",
      "sealedAtDbMs",
      "completedClaimAttempt",
      "completedClaimTokenSha256",
    ], "sealed tenant Redis purge job");
    digest(job.terminalReceiptSha256, "tenant Redis purge job terminal receipt");
    timestamp(job.sealedAtDbMs, "tenant Redis purge job seal time");
    positive(job.completedClaimAttempt, "tenant Redis purge job completion attempt");
    digest(job.completedClaimTokenSha256, "tenant Redis purge job completion claim token");
    if (job.sealedAtDbMs < job.sourceEvidenceDbMs
      || job.completedClaimAttempt !== job.attempts
      || job.targetAckCount !== job.targetCount || job.markerCount !== job.targetCount
      || job.domainAckCount !== TENANT_REDIS_PURGE_DOMAINS.length
      || job.unresolvedBlockerCount
        !== job.sourceUnresolvedBlockerCount - TENANT_REDIS_PURGE_DOMAINS.length) {
      throw new Error("sealed tenant Redis purge job evidence is incomplete");
    }
    return;
  }
  if (job.phase === "blocked") {
    exactKeys(job, [...baseKeys, "blockedAtDbMs", "blockedReasonCode"],
      "blocked tenant Redis purge job");
    timestamp(job.blockedAtDbMs, "tenant Redis purge job blocked time");
    if (job.blockedReasonCode !== "integrity_conflict") {
      throw new Error("tenant Redis purge job block reason is invalid");
    }
    if (job.domainAckCount !== 0 || job.unresolvedBlockerCount !== job.sourceUnresolvedBlockerCount) {
      throw new Error("blocked tenant Redis purge job contains terminal domain evidence");
    }
    return;
  }
  throw new Error("tenant Redis purge job phase is invalid");
}

export function validateMaterializeTenantRedisPurgeJobsOptions(
  options: MaterializeTenantRedisPurgeJobsOptions,
): void {
  exactKeys(options, ["limit"], "materialize tenant Redis purge jobs options");
  positive(options.limit, "tenant Redis purge materialize limit");
}

export function validateClaimTenantRedisPurgesOptions(
  options: ClaimTenantRedisPurgesOptions,
): void {
  exactKeys(options, ["limit", "leaseMs", "claimToken"], "claim tenant Redis purges options");
  positive(options.limit, "tenant Redis purge claim limit");
  positive(options.leaseMs, "tenant Redis purge claim lease");
  claimToken(options.claimToken);
}

export function validateRenewTenantRedisPurgeOptions(
  options: RenewTenantRedisPurgeOptions,
): void {
  exactKeys(options, ["leaseMs"], "renew tenant Redis purge options");
  positive(options.leaseMs, "tenant Redis purge renewal lease");
}

export function validateRetryTenantRedisPurgeOptions(
  options: RetryTenantRedisPurgeOptions,
): void {
  exactKeys(options, ["delayMs", "errorCode"], "retry tenant Redis purge options");
  timestamp(options.delayMs, "tenant Redis purge retry delay");
  if (!(["temporary_failure", "dependency_pending"] as const).includes(options.errorCode)) {
    throw new Error("tenant Redis purge retry code is invalid");
  }
}

export type TenantRedisPurgeCutoverRecord =
  | {
      singletonId: typeof TENANT_REDIS_PURGE_CUTOVER_SINGLETON_ID;
      controlGeneration: 0;
    }
  | {
      singletonId: typeof TENANT_REDIS_PURGE_CUTOVER_SINGLETON_ID;
      controlGeneration: 1;
      activatedAtDbMs: number;
      firstRequestId: string;
      firstReceiptSha256: string;
      redisNamespaceSha256: string;
      evidenceSha256: string;
    };

export function tenantRedisPurgeCutoverEvidenceSha256(
  input: Omit<Extract<TenantRedisPurgeCutoverRecord, { controlGeneration: 1 }>, "evidenceSha256">,
): string {
  exactKeys(input, [
    "singletonId",
    "controlGeneration",
    "activatedAtDbMs",
    "firstRequestId",
    "firstReceiptSha256",
    "redisNamespaceSha256",
  ], "tenant Redis purge cutover evidence");
  if (input.singletonId !== TENANT_REDIS_PURGE_CUTOVER_SINGLETON_ID
    || input.controlGeneration !== 1 || !REQUEST_ID.test(input.firstRequestId)) {
    throw new Error("tenant Redis purge cutover identity is invalid");
  }
  timestamp(input.activatedAtDbMs, "tenant Redis purge cutover activation time");
  digest(input.firstReceiptSha256, "tenant Redis purge cutover first receipt");
  digest(input.redisNamespaceSha256, "tenant Redis purge cutover namespace");
  return sha256([
    "tenant-redis-purge-cutover-v1",
    input.singletonId,
    input.controlGeneration,
    input.activatedAtDbMs,
    input.firstRequestId,
    input.firstReceiptSha256,
    input.redisNamespaceSha256,
  ]);
}

export function validateTenantRedisPurgeCutoverRecord(
  record: TenantRedisPurgeCutoverRecord,
): void {
  if (record.controlGeneration === 0) {
    exactKeys(record, ["singletonId", "controlGeneration"], "inactive tenant Redis purge cutover");
    if (record.singletonId !== TENANT_REDIS_PURGE_CUTOVER_SINGLETON_ID) {
      throw new Error("tenant Redis purge cutover singleton is invalid");
    }
    return;
  }
  exactKeys(record, [
    "singletonId",
    "controlGeneration",
    "activatedAtDbMs",
    "firstRequestId",
    "firstReceiptSha256",
    "redisNamespaceSha256",
    "evidenceSha256",
  ], "active tenant Redis purge cutover");
  const expected = tenantRedisPurgeCutoverEvidenceSha256({
    singletonId: record.singletonId,
    controlGeneration: record.controlGeneration,
    activatedAtDbMs: record.activatedAtDbMs,
    firstRequestId: record.firstRequestId,
    firstReceiptSha256: record.firstReceiptSha256,
    redisNamespaceSha256: record.redisNamespaceSha256,
  });
  digest(record.evidenceSha256, "tenant Redis purge cutover evidence");
  if (record.evidenceSha256 !== expected) {
    throw new Error("tenant Redis purge cutover evidence does not match");
  }
}

export interface TenantRedisPurgeStore {
  materializeTenantRedisPurgeJobs(options: MaterializeTenantRedisPurgeJobsOptions): Promise<number>;
  claimTenantRedisPurges(options: ClaimTenantRedisPurgesOptions): Promise<TenantRedisPurgeClaim[]>;
  renewTenantRedisPurge(
    authorization: TenantRedisPurgeAuthorization,
    options: RenewTenantRedisPurgeOptions,
  ): Promise<boolean>;
  retryTenantRedisPurge(
    authorization: TenantRedisPurgeAuthorization,
    options: RetryTenantRedisPurgeOptions,
  ): Promise<boolean>;
  blockTenantRedisPurge(
    authorization: TenantRedisPurgeAuthorization,
    reason?: TenantRedisPurgeBlockReasonCode,
  ): Promise<boolean>;
  recordTenantRedisPurgeTargetAck(
    authorization: TenantRedisPurgeAuthorization,
    result: TenantRedisPurgeAdapterResult,
  ): Promise<TenantRedisPurgeTargetAck | null>;
  sealTenantRedisPurge(
    authorization: TenantRedisPurgeAuthorization,
  ): Promise<TenantRedisPurgeReceipt | null>;
  getTenantRedisPurgeJob(
    tenantId: string,
    requestId: string,
  ): Promise<TenantRedisPurgeJobRecord | null>;
  getTenantRedisPurgeTargets(
    tenantId: string,
    requestId: string,
    redisPurgeGeneration: number,
  ): Promise<TenantRedisPurgeTarget[]>;
  getTenantRedisPurgeTargetAcks(
    tenantId: string,
    requestId: string,
    redisPurgeGeneration: number,
  ): Promise<TenantRedisPurgeTargetAck[]>;
  getTenantRedisPurgeDomainAcks(
    tenantId: string,
    requestId: string,
    redisPurgeGeneration: number,
  ): Promise<TenantRedisPurgeDomainAck[]>;
  getTenantRedisPurgeReceipt(
    tenantId: string,
    requestId: string,
  ): Promise<TenantRedisPurgeReceipt | null>;
  getTenantRedisPurgeCutover(): Promise<TenantRedisPurgeCutoverRecord>;
  /**
   * True once any T3g job has been durably materialized. Job existence is forward-only evidence:
   * startup must not disable the worker merely because no target ACK or cutover exists yet.
   */
  hasTenantRedisPurgeJobs(): Promise<boolean>;
  /**
   * Stable global scan of every durable target ACK for startup restore, including partially applied
   * queued/blocked jobs. Implementations must revalidate the job's complete target root, its current
   * ACK/marker roots and (when sealed) the terminal bundle before returning; corruption must throw.
   */
  listTenantRedisPurgeRestoreFences(
    options: ListTenantRedisPurgeRestoreFencesOptions,
  ): Promise<ListTenantRedisPurgeRestoreFencesResult>;
}
