import { createHash } from "node:crypto";
import {
  TenantTelemetryDispositionConflictError,
  TenantTelemetryDispositionCorruptError,
  validateTenantTelemetryDispositionAuthorizationGrant,
  validateTenantTelemetryDispositionJournalIdentity,
  type TenantTelemetryDispositionAuthorizationGrant,
  type TenantTelemetryDispositionJournalIdentity,
} from "../tenant-telemetry-disposition.js";
import { canonicalJson } from "./common.js";

/**
 * A separate, fixture-only protocol. It cannot be interpreted as a 0036
 * caller-evidence authorization or as authority to delete an artifact.
 * Production mutation requires a future trusted, fresh DB-grant verifier.
 * The external receipt commits to tenant/request via the complete DB grant,
 * but deliberately omits their raw IDs. This event alone cannot reconstruct
 * a grant from an old database snapshot or prove restore/replay authority.
 */
export const TENANT_TELEMETRY_GRANT_JOURNAL_PROTOCOL_V2 =
  "tenant-telemetry-disposition-grant-journal-v2" as const;
export const TENANT_TELEMETRY_GRANT_JOURNAL_HEAD_SCOPE_V2 =
  "tenant-telemetry-disposition-grant-journal-head-v2" as const;
export const TENANT_TELEMETRY_GRANT_AUTHORIZATION_SCOPE_V2 =
  "tenant-telemetry-disposition-grant-authorization-v2" as const;

const SHA256 = /^[0-9a-f]{64}$/;

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function exactKeys(value: unknown, keys: readonly string[]): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort());
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function sameIdentity(
  left: TenantTelemetryDispositionJournalIdentity,
  right: TenantTelemetryDispositionJournalIdentity,
): boolean {
  return left.adapterProtocol === right.adapterProtocol
    && left.journalNamespaceSha256 === right.journalNamespaceSha256
    && left.journalTargetSha256 === right.journalTargetSha256
    && left.failureDomainSha256 === right.failureDomainSha256
    && left.logicalDatabaseNamespaceSha256 === right.logicalDatabaseNamespaceSha256;
}

function validateV2Identity(identity: TenantTelemetryDispositionJournalIdentity): void {
  validateTenantTelemetryDispositionJournalIdentity({
    adapterProtocol: identity.adapterProtocol,
    journalNamespaceSha256: identity.journalNamespaceSha256,
    journalTargetSha256: identity.journalTargetSha256,
    failureDomainSha256: identity.failureDomainSha256,
    logicalDatabaseNamespaceSha256: identity.logicalDatabaseNamespaceSha256,
  });
  if (!identity.adapterProtocol.endsWith("-v2")) {
    throw new TenantTelemetryDispositionCorruptError();
  }
}

function identityFields(
  identity: TenantTelemetryDispositionJournalIdentity,
): TenantTelemetryDispositionJournalIdentity {
  validateV2Identity(identity);
  return {
    adapterProtocol: identity.adapterProtocol,
    journalNamespaceSha256: identity.journalNamespaceSha256,
    journalTargetSha256: identity.journalTargetSha256,
    failureDomainSha256: identity.failureDomainSha256,
    logicalDatabaseNamespaceSha256: identity.logicalDatabaseNamespaceSha256,
  };
}

export interface TenantTelemetryGrantJournalHeadV2
  extends TenantTelemetryDispositionJournalIdentity {
  scope: typeof TENANT_TELEMETRY_GRANT_JOURNAL_HEAD_SCOPE_V2;
  protocol: typeof TENANT_TELEMETRY_GRANT_JOURNAL_PROTOCOL_V2;
  journalSequence: number;
  journalEventRootSha256: string;
}

export interface TenantTelemetryGrantAuthorizationBodyV2
  extends TenantTelemetryDispositionJournalIdentity {
  scope: typeof TENANT_TELEMETRY_GRANT_AUTHORIZATION_SCOPE_V2;
  protocol: typeof TENANT_TELEMETRY_GRANT_JOURNAL_PROTOCOL_V2;
  /** Binds the complete validated DB grant, including tenant/request and evidence. */
  grantReceiptSha256: string;
  dispositionOperationSha256: string;
  domain: "logs" | "traces";
  targetSha256: string;
  artifactIdSha256: string;
  artifactGeneration: number;
  claimAttempt: number;
  claimTokenSha256: string;
  grantedAtDbMs: number;
  leaseUntilDbMs: number;
}

export interface TenantTelemetryGrantAuthorizationEventV2
  extends TenantTelemetryGrantAuthorizationBodyV2 {
  eventType: "delete_authorized";
  authorizationReceiptSha256: string;
  journalSequence: number;
  previousJournalEventRootSha256: string;
  journalEventSha256: string;
  journalEventRootSha256: string;
}

const IDENTITY_KEYS = [
  "adapterProtocol", "journalNamespaceSha256", "journalTargetSha256",
  "failureDomainSha256", "logicalDatabaseNamespaceSha256",
] as const;
const HEAD_KEYS = [
  "scope", "protocol", ...IDENTITY_KEYS, "journalSequence", "journalEventRootSha256",
] as const;
const BODY_KEYS = [
  "scope", "protocol", ...IDENTITY_KEYS, "grantReceiptSha256",
  "dispositionOperationSha256", "domain", "targetSha256", "artifactIdSha256",
  "artifactGeneration", "claimAttempt", "claimTokenSha256", "grantedAtDbMs",
  "leaseUntilDbMs",
] as const;
const EVENT_KEYS = [
  ...BODY_KEYS, "eventType", "authorizationReceiptSha256", "journalSequence",
  "previousJournalEventRootSha256", "journalEventSha256", "journalEventRootSha256",
] as const;

export const EMPTY_TENANT_TELEMETRY_GRANT_JOURNAL_ROOT_SHA256_V2 = sha256([
  TENANT_TELEMETRY_GRANT_JOURNAL_PROTOCOL_V2, "empty",
]);

export function emptyTenantTelemetryGrantJournalHeadV2(
  identity: TenantTelemetryDispositionJournalIdentity,
): TenantTelemetryGrantJournalHeadV2 {
  validateV2Identity(identity);
  return {
    scope: TENANT_TELEMETRY_GRANT_JOURNAL_HEAD_SCOPE_V2,
    protocol: TENANT_TELEMETRY_GRANT_JOURNAL_PROTOCOL_V2,
    ...identityFields(identity),
    journalSequence: 0,
    journalEventRootSha256: EMPTY_TENANT_TELEMETRY_GRANT_JOURNAL_ROOT_SHA256_V2,
  };
}

export function validateTenantTelemetryGrantJournalHeadV2(
  head: TenantTelemetryGrantJournalHeadV2,
): void {
  if (!exactKeys(head, HEAD_KEYS)
    || head.scope !== TENANT_TELEMETRY_GRANT_JOURNAL_HEAD_SCOPE_V2
    || head.protocol !== TENANT_TELEMETRY_GRANT_JOURNAL_PROTOCOL_V2
    || !Number.isSafeInteger(head.journalSequence)
    || head.journalSequence < 0
    || !validSha256(head.journalEventRootSha256)
    || (head.journalSequence === 0
      && head.journalEventRootSha256 !== EMPTY_TENANT_TELEMETRY_GRANT_JOURNAL_ROOT_SHA256_V2)) {
    throw new TenantTelemetryDispositionCorruptError();
  }
  validateV2Identity(head);
}

function authorizationReceipt(body: TenantTelemetryGrantAuthorizationBodyV2): string {
  return sha256([TENANT_TELEMETRY_GRANT_AUTHORIZATION_SCOPE_V2, body]);
}

function eventSha256(authorizationReceiptSha256: string): string {
  return sha256([
    TENANT_TELEMETRY_GRANT_JOURNAL_PROTOCOL_V2,
    "delete_authorized",
    authorizationReceiptSha256,
  ]);
}

function nextRoot(
  previousRoot: string,
  sequence: number,
  eventDigest: string,
): string {
  return sha256([
    TENANT_TELEMETRY_GRANT_JOURNAL_PROTOCOL_V2,
    "event-root",
    previousRoot,
    sequence,
    eventDigest,
  ]);
}

function bodyFromGrant(
  identity: TenantTelemetryDispositionJournalIdentity,
  grant: TenantTelemetryDispositionAuthorizationGrant,
): TenantTelemetryGrantAuthorizationBodyV2 {
  validateTenantTelemetryDispositionAuthorizationGrant(grant);
  return {
    scope: TENANT_TELEMETRY_GRANT_AUTHORIZATION_SCOPE_V2,
    protocol: TENANT_TELEMETRY_GRANT_JOURNAL_PROTOCOL_V2,
    ...identityFields(identity),
    grantReceiptSha256: grant.grantReceiptSha256,
    dispositionOperationSha256: grant.dispositionOperationSha256,
    domain: grant.domain,
    targetSha256: grant.targetSha256,
    artifactIdSha256: grant.artifactIdSha256,
    artifactGeneration: grant.artifactGeneration,
    claimAttempt: grant.claimAttempt,
    claimTokenSha256: grant.claimTokenSha256,
    grantedAtDbMs: grant.grantedAtDbMs,
    leaseUntilDbMs: grant.leaseUntilDbMs,
  };
}

/** Pure fixture codec; a caller-supplied grant is never evidence of DB authority. */
export function buildFixtureTenantTelemetryGrantAuthorizationEventV2(
  identity: TenantTelemetryDispositionJournalIdentity,
  grant: TenantTelemetryDispositionAuthorizationGrant,
  head: TenantTelemetryGrantJournalHeadV2,
  nonProductionFixture: true,
): TenantTelemetryGrantAuthorizationEventV2 {
  if (nonProductionFixture !== true || process.env.NODE_ENV === "production") {
    throw new TenantTelemetryDispositionConflictError();
  }
  validateTenantTelemetryGrantJournalHeadV2(head);
  if (!sameIdentity(identity, head) || head.journalSequence >= Number.MAX_SAFE_INTEGER) {
    throw new TenantTelemetryDispositionConflictError();
  }
  const body = bodyFromGrant(identity, grant);
  const authorizationReceiptSha256 = authorizationReceipt(body);
  const journalSequence = head.journalSequence + 1;
  const journalEventSha256 = eventSha256(authorizationReceiptSha256);
  const event: TenantTelemetryGrantAuthorizationEventV2 = {
    ...body,
    eventType: "delete_authorized",
    authorizationReceiptSha256,
    journalSequence,
    previousJournalEventRootSha256: head.journalEventRootSha256,
    journalEventSha256,
    journalEventRootSha256: nextRoot(
      head.journalEventRootSha256,
      journalSequence,
      journalEventSha256,
    ),
  };
  validateTenantTelemetryGrantAuthorizationEventV2(event);
  return event;
}

export function validateTenantTelemetryGrantAuthorizationEventV2(
  event: TenantTelemetryGrantAuthorizationEventV2,
): void {
  if (!exactKeys(event, EVENT_KEYS)
    || event.scope !== TENANT_TELEMETRY_GRANT_AUTHORIZATION_SCOPE_V2
    || event.protocol !== TENANT_TELEMETRY_GRANT_JOURNAL_PROTOCOL_V2
    || event.eventType !== "delete_authorized"
    || !validSha256(event.grantReceiptSha256)
    || !validSha256(event.dispositionOperationSha256)
    || (event.domain !== "logs" && event.domain !== "traces")
    || !validSha256(event.targetSha256)
    || !validSha256(event.artifactIdSha256)
    || !Number.isSafeInteger(event.artifactGeneration)
    || event.artifactGeneration < 1
    || !Number.isSafeInteger(event.claimAttempt)
    || event.claimAttempt < 1
    || !validSha256(event.claimTokenSha256)
    || !Number.isSafeInteger(event.grantedAtDbMs)
    || event.grantedAtDbMs < 0
    || !Number.isSafeInteger(event.leaseUntilDbMs)
    || event.leaseUntilDbMs <= event.grantedAtDbMs
    || !validSha256(event.authorizationReceiptSha256)
    || !Number.isSafeInteger(event.journalSequence)
    || event.journalSequence < 1
    || !validSha256(event.previousJournalEventRootSha256)
    || !validSha256(event.journalEventSha256)
    || !validSha256(event.journalEventRootSha256)) {
    throw new TenantTelemetryDispositionCorruptError();
  }
  validateV2Identity(event);
  const body = Object.fromEntries(BODY_KEYS.map((key) => [key, event[key]])) as
    unknown as TenantTelemetryGrantAuthorizationBodyV2;
  if (event.authorizationReceiptSha256 !== authorizationReceipt(body)
    || event.journalEventSha256 !== eventSha256(event.authorizationReceiptSha256)
    || event.journalEventRootSha256 !== nextRoot(
      event.previousJournalEventRootSha256,
      event.journalSequence,
      event.journalEventSha256,
    )) {
    throw new TenantTelemetryDispositionCorruptError();
  }
}

/** Exact DB-grant comparison, not proof that the supplied grant came from a DB. */
export function assertTenantTelemetryGrantAuthorizationMatchesV2(
  event: TenantTelemetryGrantAuthorizationEventV2,
  grant: TenantTelemetryDispositionAuthorizationGrant,
): void {
  validateTenantTelemetryGrantAuthorizationEventV2(event);
  validateTenantTelemetryDispositionAuthorizationGrant(grant);
  const identity = Object.fromEntries(IDENTITY_KEYS.map((key) => [key, event[key]])) as
    unknown as TenantTelemetryDispositionJournalIdentity;
  if (event.authorizationReceiptSha256 !== authorizationReceipt(bodyFromGrant(identity, grant))) {
    throw new TenantTelemetryDispositionConflictError();
  }
}

export function headAfterTenantTelemetryGrantAuthorizationEventV2(
  event: TenantTelemetryGrantAuthorizationEventV2,
): TenantTelemetryGrantJournalHeadV2 {
  validateTenantTelemetryGrantAuthorizationEventV2(event);
  return {
    scope: TENANT_TELEMETRY_GRANT_JOURNAL_HEAD_SCOPE_V2,
    protocol: TENANT_TELEMETRY_GRANT_JOURNAL_PROTOCOL_V2,
    ...(Object.fromEntries(IDENTITY_KEYS.map((key) => [key, event[key]])) as
      unknown as TenantTelemetryDispositionJournalIdentity),
    journalSequence: event.journalSequence,
    journalEventRootSha256: event.journalEventRootSha256,
  };
}

/** Validates every event from genesis through the exact sealed head, never LIST. */
export function assertTenantTelemetryGrantJournalChainV2(
  identity: TenantTelemetryDispositionJournalIdentity,
  events: readonly TenantTelemetryGrantAuthorizationEventV2[],
  sealedHead: TenantTelemetryGrantJournalHeadV2,
): void {
  validateV2Identity(identity);
  validateTenantTelemetryGrantJournalHeadV2(sealedHead);
  if (!sameIdentity(identity, sealedHead)) throw new TenantTelemetryDispositionCorruptError();
  let head = emptyTenantTelemetryGrantJournalHeadV2(identity);
  const operations = new Set<string>();
  const artifactFences = new Set<string>();
  for (const event of events) {
    validateTenantTelemetryGrantAuthorizationEventV2(event);
    if (!sameIdentity(identity, event)
      || event.journalSequence !== head.journalSequence + 1
      || event.previousJournalEventRootSha256 !== head.journalEventRootSha256
      || operations.has(event.dispositionOperationSha256)) {
      throw new TenantTelemetryDispositionCorruptError();
    }
    const fence = canonicalJson([
      event.domain, event.targetSha256, event.artifactIdSha256, event.artifactGeneration,
    ]);
    if (artifactFences.has(fence)) throw new TenantTelemetryDispositionCorruptError();
    operations.add(event.dispositionOperationSha256);
    artifactFences.add(fence);
    head = headAfterTenantTelemetryGrantAuthorizationEventV2(event);
  }
  if (head.journalSequence !== sealedHead.journalSequence
    || head.journalEventRootSha256 !== sealedHead.journalEventRootSha256) {
    throw new TenantTelemetryDispositionCorruptError();
  }
}
