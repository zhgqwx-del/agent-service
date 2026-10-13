import { createHash } from "node:crypto";
import { TenantTelemetryDispositionCorruptError } from "../tenant-telemetry-disposition.js";
import { canonicalJson } from "./common.js";

/** A new, deliberately disjoint wire family. None of these records attest to a DB grant. */
export const TENANT_TELEMETRY_DISPOSITION_JOURNAL_PROTOCOL_V3 =
  "tenant-telemetry-disposition-journal-v3" as const;
export const S3_TENANT_TELEMETRY_DISPOSITION_JOURNAL_ADAPTER_V3 =
  "s3-cas-head-tenant-telemetry-disposition-journal-v3" as const;
const HEAD_SCOPE = "tenant-telemetry-disposition-journal-head-v3" as const;
const EVENT_SCOPE = "tenant-telemetry-disposition-journal-event-v3" as const;
const SHA256 = /^[0-9a-f]{64}$/;

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function fail(): never { throw new TenantTelemetryDispositionCorruptError(); }

function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) fail();
}

function digest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) fail();
}

function positive(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail();
}

function nonnegative(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail();
}

export interface TenantTelemetryDispositionJournalIdentityV3 {
  adapterProtocol: typeof S3_TENANT_TELEMETRY_DISPOSITION_JOURNAL_ADAPTER_V3;
  journalNamespaceSha256: string;
  journalTargetSha256: string;
  failureDomainSha256: string;
  logicalDatabaseNamespaceSha256: string;
}

const IDENTITY_KEYS = ["adapterProtocol", "journalNamespaceSha256", "journalTargetSha256",
  "failureDomainSha256", "logicalDatabaseNamespaceSha256"] as const;

export function validateTenantTelemetryDispositionJournalIdentityV3(
  identity: TenantTelemetryDispositionJournalIdentityV3,
): void {
  exact(identity, IDENTITY_KEYS);
  if (identity.adapterProtocol !== S3_TENANT_TELEMETRY_DISPOSITION_JOURNAL_ADAPTER_V3) fail();
  for (const key of IDENTITY_KEYS.slice(1)) digest(identity[key]);
}

export interface TenantTelemetryDispositionSourceV3 {
  tenantRefSha256: string;
  domain: "logs" | "traces";
  targetSha256: string;
  artifactIdSha256: string;
  artifactGeneration: number;
  dispositionOperationSha256: string;
  subjectGeneration: number;
  buildGeneration: number;
  artifactGroupSha256: string;
  catalogEntryReceiptSha256: string;
  catalogReceiptSha256: string;
  sourceAccountingReceiptSha256: string;
  targetManifestReceiptSha256: string;
  ownerClosureReceiptSha256: string;
  databasePurgeReceiptSha256: string;
  pregrantIntentSha256: string;
  pregrantClaimSha256: string;
}

const SOURCE_KEYS = ["tenantRefSha256", "domain", "targetSha256", "artifactIdSha256",
  "artifactGeneration", "dispositionOperationSha256", "subjectGeneration", "buildGeneration",
  "artifactGroupSha256", "catalogEntryReceiptSha256", "catalogReceiptSha256",
  "sourceAccountingReceiptSha256", "targetManifestReceiptSha256", "ownerClosureReceiptSha256",
  "databasePurgeReceiptSha256", "pregrantIntentSha256", "pregrantClaimSha256"] as const;

export function validateTenantTelemetryDispositionSourceV3(source: TenantTelemetryDispositionSourceV3): void {
  exact(source, SOURCE_KEYS);
  if (source.domain !== "logs" && source.domain !== "traces") fail();
  for (const key of SOURCE_KEYS) {
    if (key === "domain") continue;
    if (key === "artifactGeneration" || key === "subjectGeneration" || key === "buildGeneration") {
      positive(source[key]);
    } else digest(source[key]);
  }
}

export interface TenantTelemetryDispositionRestoreLineageV3 {
  runtimeEpochSha256: string;
  runtimeControlEvidenceSha256: string;
  backupCatalogControlEvidenceSha256: string;
  restoreRunSha256: string | null;
  restoreReplayReceiptSha256: string | null;
  backupReservationReceiptSha256: string | null;
}

const RESTORE_KEYS = ["runtimeEpochSha256", "runtimeControlEvidenceSha256",
  "backupCatalogControlEvidenceSha256", "restoreRunSha256", "restoreReplayReceiptSha256",
  "backupReservationReceiptSha256"] as const;

export function validateTenantTelemetryDispositionRestoreLineageV3(
  lineage: TenantTelemetryDispositionRestoreLineageV3,
): void {
  exact(lineage, RESTORE_KEYS);
  digest(lineage.runtimeEpochSha256);
  digest(lineage.runtimeControlEvidenceSha256);
  digest(lineage.backupCatalogControlEvidenceSha256);
  const bound = [lineage.restoreRunSha256, lineage.restoreReplayReceiptSha256,
    lineage.backupReservationReceiptSha256];
  if (bound.some((value) => value === null) && bound.some((value) => value !== null)) fail();
  for (const value of bound) if (value !== null) digest(value);
}

export interface TenantTelemetryDispositionAuthorizationV3 {
  grantReceiptSha256: string;
  claimAttempt: number;
  claimTokenSha256: string;
  grantedAtDbMs: number;
  leaseUntilDbMs: number;
  authorizationReceiptSha256: string;
}

const AUTH_KEYS = ["grantReceiptSha256", "claimAttempt", "claimTokenSha256", "grantedAtDbMs",
  "leaseUntilDbMs", "authorizationReceiptSha256"] as const;

export interface TenantTelemetryDispositionTerminalMarkerV3 {
  authorizationReceiptSha256: string;
  sameKeyTombstoneReceiptSha256: string;
  tombstoneMarkerSha256: string;
  originalObjectEtagSha256: string;
  terminalReceiptSha256: string;
}

const TERMINAL_KEYS = ["authorizationReceiptSha256", "sameKeyTombstoneReceiptSha256",
  "tombstoneMarkerSha256", "originalObjectEtagSha256", "terminalReceiptSha256"] as const;

export interface TenantTelemetryDispositionEventV3 {
  scope: typeof EVENT_SCOPE;
  protocol: typeof TENANT_TELEMETRY_DISPOSITION_JOURNAL_PROTOCOL_V3;
  identity: TenantTelemetryDispositionJournalIdentityV3;
  eventType: "delete_authorized" | "delete_tombstoned";
  source: TenantTelemetryDispositionSourceV3;
  restore: TenantTelemetryDispositionRestoreLineageV3;
  authorization: TenantTelemetryDispositionAuthorizationV3;
  terminal: TenantTelemetryDispositionTerminalMarkerV3 | null;
  journalSequence: number;
  previousJournalEventRootSha256: string;
  journalEventSha256: string;
  journalEventRootSha256: string;
}

const EVENT_KEYS = ["scope", "protocol", "identity", "eventType", "source", "restore",
  "authorization", "terminal", "journalSequence", "previousJournalEventRootSha256",
  "journalEventSha256", "journalEventRootSha256"] as const;

export interface TenantTelemetryDispositionHeadV3 {
  scope: typeof HEAD_SCOPE;
  protocol: typeof TENANT_TELEMETRY_DISPOSITION_JOURNAL_PROTOCOL_V3;
  identity: TenantTelemetryDispositionJournalIdentityV3;
  journalSequence: number;
  journalEventRootSha256: string;
}

const HEAD_KEYS = ["scope", "protocol", "identity", "journalSequence",
  "journalEventRootSha256"] as const;
export const EMPTY_TENANT_TELEMETRY_DISPOSITION_JOURNAL_ROOT_V3 =
  sha256([TENANT_TELEMETRY_DISPOSITION_JOURNAL_PROTOCOL_V3, "empty"]);

export function emptyTenantTelemetryDispositionHeadV3(
  identity: TenantTelemetryDispositionJournalIdentityV3,
): TenantTelemetryDispositionHeadV3 {
  validateTenantTelemetryDispositionJournalIdentityV3(identity);
  return { scope: HEAD_SCOPE, protocol: TENANT_TELEMETRY_DISPOSITION_JOURNAL_PROTOCOL_V3,
    identity: structuredClone(identity), journalSequence: 0,
    journalEventRootSha256: EMPTY_TENANT_TELEMETRY_DISPOSITION_JOURNAL_ROOT_V3 };
}

export function validateTenantTelemetryDispositionHeadV3(head: TenantTelemetryDispositionHeadV3): void {
  exact(head, HEAD_KEYS);
  if (head.scope !== HEAD_SCOPE || head.protocol !== TENANT_TELEMETRY_DISPOSITION_JOURNAL_PROTOCOL_V3) fail();
  validateTenantTelemetryDispositionJournalIdentityV3(head.identity);
  nonnegative(head.journalSequence);
  digest(head.journalEventRootSha256);
  if (head.journalSequence === 0
    && head.journalEventRootSha256 !== EMPTY_TENANT_TELEMETRY_DISPOSITION_JOURNAL_ROOT_V3) fail();
}

function authReceipt(identity: TenantTelemetryDispositionJournalIdentityV3,
  source: TenantTelemetryDispositionSourceV3,
  restore: TenantTelemetryDispositionRestoreLineageV3,
  authorization: Omit<TenantTelemetryDispositionAuthorizationV3, "authorizationReceiptSha256">): string {
  return sha256([TENANT_TELEMETRY_DISPOSITION_JOURNAL_PROTOCOL_V3, "authorization",
    identity, source, restore, authorization]);
}

function terminalReceipt(auth: TenantTelemetryDispositionAuthorizationV3,
  terminal: Omit<TenantTelemetryDispositionTerminalMarkerV3, "terminalReceiptSha256">): string {
  return sha256([TENANT_TELEMETRY_DISPOSITION_JOURNAL_PROTOCOL_V3, "terminal",
    auth.authorizationReceiptSha256, terminal]);
}

function eventDigest(event: Omit<TenantTelemetryDispositionEventV3,
  "journalSequence" | "previousJournalEventRootSha256" | "journalEventSha256" | "journalEventRootSha256">): string {
  return sha256([TENANT_TELEMETRY_DISPOSITION_JOURNAL_PROTOCOL_V3, "event", event]);
}

function nextRoot(previous: string, sequence: number, eventSha256: string): string {
  return sha256([TENANT_TELEMETRY_DISPOSITION_JOURNAL_PROTOCOL_V3, "root",
    previous, sequence, eventSha256]);
}

export function buildFixtureTenantTelemetryDispositionEventV3(input: {
  identity: TenantTelemetryDispositionJournalIdentityV3;
  source: TenantTelemetryDispositionSourceV3;
  restore: TenantTelemetryDispositionRestoreLineageV3;
  grantReceiptSha256: string;
  claimAttempt: number;
  claimTokenSha256: string;
  grantedAtDbMs: number;
  leaseUntilDbMs: number;
  terminal: Omit<TenantTelemetryDispositionTerminalMarkerV3, "terminalReceiptSha256"> | null;
  head: TenantTelemetryDispositionHeadV3;
  nonProductionFixture: true;
}): TenantTelemetryDispositionEventV3 {
  if (input.nonProductionFixture !== true || process.env.NODE_ENV === "production") fail();
  validateTenantTelemetryDispositionJournalIdentityV3(input.identity);
  validateTenantTelemetryDispositionSourceV3(input.source);
  validateTenantTelemetryDispositionRestoreLineageV3(input.restore);
  validateTenantTelemetryDispositionHeadV3(input.head);
  if (!same(input.identity, input.head.identity)
    || input.head.journalSequence >= Number.MAX_SAFE_INTEGER) fail();
  digest(input.grantReceiptSha256);
  positive(input.claimAttempt);
  digest(input.claimTokenSha256);
  nonnegative(input.grantedAtDbMs);
  positive(input.leaseUntilDbMs);
  if (input.leaseUntilDbMs <= input.grantedAtDbMs) fail();
  const authorizationBody = { grantReceiptSha256: input.grantReceiptSha256,
    claimAttempt: input.claimAttempt, claimTokenSha256: input.claimTokenSha256,
    grantedAtDbMs: input.grantedAtDbMs, leaseUntilDbMs: input.leaseUntilDbMs };
  const authorization: TenantTelemetryDispositionAuthorizationV3 = {
    ...authorizationBody,
    authorizationReceiptSha256: authReceipt(input.identity, input.source, input.restore,
      authorizationBody),
  };
  let terminal: TenantTelemetryDispositionTerminalMarkerV3 | null = null;
  if (input.terminal !== null) {
    exact(input.terminal, TERMINAL_KEYS.filter((key) => key !== "terminalReceiptSha256"));
    for (const value of Object.values(input.terminal)) digest(value);
    if (input.terminal.authorizationReceiptSha256 !== authorization.authorizationReceiptSha256) fail();
    terminal = { ...input.terminal,
      terminalReceiptSha256: terminalReceipt(authorization, input.terminal) };
  }
  const core = { scope: EVENT_SCOPE, protocol: TENANT_TELEMETRY_DISPOSITION_JOURNAL_PROTOCOL_V3,
    identity: structuredClone(input.identity),
    eventType: terminal === null ? "delete_authorized" as const : "delete_tombstoned" as const,
    source: structuredClone(input.source), restore: structuredClone(input.restore),
    authorization, terminal };
  const journalSequence = input.head.journalSequence + 1;
  const journalEventSha256 = eventDigest(core);
  const event: TenantTelemetryDispositionEventV3 = { ...core, journalSequence,
    previousJournalEventRootSha256: input.head.journalEventRootSha256,
    journalEventSha256,
    journalEventRootSha256: nextRoot(input.head.journalEventRootSha256, journalSequence,
      journalEventSha256) };
  validateTenantTelemetryDispositionEventV3(event);
  return event;
}

export function validateTenantTelemetryDispositionEventV3(event: TenantTelemetryDispositionEventV3): void {
  exact(event, EVENT_KEYS);
  if (event.scope !== EVENT_SCOPE || event.protocol !== TENANT_TELEMETRY_DISPOSITION_JOURNAL_PROTOCOL_V3
    || (event.eventType !== "delete_authorized" && event.eventType !== "delete_tombstoned")) fail();
  validateTenantTelemetryDispositionJournalIdentityV3(event.identity);
  validateTenantTelemetryDispositionSourceV3(event.source);
  validateTenantTelemetryDispositionRestoreLineageV3(event.restore);
  exact(event.authorization, AUTH_KEYS);
  const auth = event.authorization;
  digest(auth.grantReceiptSha256); positive(auth.claimAttempt); digest(auth.claimTokenSha256);
  nonnegative(auth.grantedAtDbMs); positive(auth.leaseUntilDbMs);
  if (auth.leaseUntilDbMs <= auth.grantedAtDbMs) fail();
  digest(auth.authorizationReceiptSha256);
  const { authorizationReceiptSha256: _receipt, ...authBody } = auth;
  if (auth.authorizationReceiptSha256 !== authReceipt(event.identity, event.source, event.restore,
    authBody)) fail();
  if (event.eventType === "delete_authorized") {
    if (event.terminal !== null) fail();
  } else {
    if (event.terminal === null) fail();
    exact(event.terminal, TERMINAL_KEYS);
    for (const value of Object.values(event.terminal)) digest(value);
    if (event.terminal.authorizationReceiptSha256 !== auth.authorizationReceiptSha256) fail();
    const { terminalReceiptSha256: _terminalReceipt, ...terminalBody } = event.terminal;
    if (event.terminal.terminalReceiptSha256 !== terminalReceipt(auth, terminalBody)) fail();
  }
  positive(event.journalSequence);
  digest(event.previousJournalEventRootSha256);
  digest(event.journalEventSha256);
  digest(event.journalEventRootSha256);
  const { journalSequence: _sequence, previousJournalEventRootSha256: _previous,
    journalEventSha256: _eventSha, journalEventRootSha256: _root, ...core } = event;
  if (event.journalEventSha256 !== eventDigest(core)
    || event.journalEventRootSha256 !== nextRoot(event.previousJournalEventRootSha256,
      event.journalSequence, event.journalEventSha256)) fail();
}

export function headAfterTenantTelemetryDispositionEventV3(
  event: TenantTelemetryDispositionEventV3,
): TenantTelemetryDispositionHeadV3 {
  validateTenantTelemetryDispositionEventV3(event);
  return { scope: HEAD_SCOPE, protocol: TENANT_TELEMETRY_DISPOSITION_JOURNAL_PROTOCOL_V3,
    identity: structuredClone(event.identity), journalSequence: event.journalSequence,
    journalEventRootSha256: event.journalEventRootSha256 };
}

export function assertTenantTelemetryDispositionChainV3(
  identity: TenantTelemetryDispositionJournalIdentityV3,
  events: readonly TenantTelemetryDispositionEventV3[],
  sealedHead: TenantTelemetryDispositionHeadV3,
): void {
  validateTenantTelemetryDispositionJournalIdentityV3(identity);
  validateTenantTelemetryDispositionHeadV3(sealedHead);
  if (!same(identity, sealedHead.identity)) fail();
  let head = emptyTenantTelemetryDispositionHeadV3(identity);
  const authorized = new Map<string, TenantTelemetryDispositionEventV3>();
  const terminal = new Set<string>();
  const artifact = new Set<string>();
  for (const event of events) {
    validateTenantTelemetryDispositionEventV3(event);
    if (!same(event.identity, identity)
      || event.journalSequence !== head.journalSequence + 1
      || event.previousJournalEventRootSha256 !== head.journalEventRootSha256) fail();
    const operation = event.source.dispositionOperationSha256;
    const slot = JSON.stringify([event.source.domain, event.source.targetSha256,
      event.source.artifactIdSha256, event.source.artifactGeneration]);
    if (event.eventType === "delete_authorized") {
      if (authorized.has(operation) || artifact.has(slot)) fail();
      authorized.set(operation, event);
      artifact.add(slot);
    } else {
      const prior = authorized.get(operation);
      if (!prior || terminal.has(operation)
        || !same(prior.source, event.source)
        || !same(prior.restore, event.restore)
        || !same(prior.authorization, event.authorization)
        || prior.authorization.authorizationReceiptSha256
          !== event.terminal?.authorizationReceiptSha256) fail();
      terminal.add(operation);
    }
    head = headAfterTenantTelemetryDispositionEventV3(event);
  }
  if (head.journalSequence !== sealedHead.journalSequence
    || head.journalEventRootSha256 !== sealedHead.journalEventRootSha256) fail();
}
