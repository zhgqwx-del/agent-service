import {
  TENANT_TELEMETRY_DISPOSITION_PROTOCOL,
  validateTenantTelemetryDispositionExternalEvent,
  validateTenantTelemetryDispositionJournalIdentity,
  type TenantTelemetryDispositionExternalEvent,
  type TenantTelemetryDispositionJournalIdentity,
} from "../tenant-telemetry-disposition.js";
import { canonicalJson } from "./common.js";

export const TENANT_TELEMETRY_DISPOSITION_STORED_EVENT_SCOPE =
  "tenant-telemetry-disposition-stored-event-v1" as const;

export interface TenantTelemetryDispositionStoredEvent
  extends TenantTelemetryDispositionJournalIdentity {
  scope: typeof TENANT_TELEMETRY_DISPOSITION_STORED_EVENT_SCOPE;
  protocol: typeof TENANT_TELEMETRY_DISPOSITION_PROTOCOL;
  event: TenantTelemetryDispositionExternalEvent;
}

function exactKeys(value: object, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    throw new Error("tenant telemetry disposition stored event has unknown or missing fields");
  }
}

export function validateTenantTelemetryDispositionStoredEvent(
  stored: TenantTelemetryDispositionStoredEvent,
): void {
  exactKeys(stored, [
    "scope",
    "protocol",
    "adapterProtocol",
    "journalNamespaceSha256",
    "journalTargetSha256",
    "failureDomainSha256",
    "logicalDatabaseNamespaceSha256",
    "event",
  ]);
  if (stored.scope !== TENANT_TELEMETRY_DISPOSITION_STORED_EVENT_SCOPE
    || stored.protocol !== TENANT_TELEMETRY_DISPOSITION_PROTOCOL) {
    throw new Error("tenant telemetry disposition stored event protocol is invalid");
  }
  validateTenantTelemetryDispositionJournalIdentity({
    adapterProtocol: stored.adapterProtocol,
    journalNamespaceSha256: stored.journalNamespaceSha256,
    journalTargetSha256: stored.journalTargetSha256,
    failureDomainSha256: stored.failureDomainSha256,
    logicalDatabaseNamespaceSha256: stored.logicalDatabaseNamespaceSha256,
  });
  validateTenantTelemetryDispositionExternalEvent(stored.event);
}

export function buildTenantTelemetryDispositionStoredEvent(
  identity: TenantTelemetryDispositionJournalIdentity,
  event: TenantTelemetryDispositionExternalEvent,
): TenantTelemetryDispositionStoredEvent {
  const stored: TenantTelemetryDispositionStoredEvent = {
    scope: TENANT_TELEMETRY_DISPOSITION_STORED_EVENT_SCOPE,
    protocol: TENANT_TELEMETRY_DISPOSITION_PROTOCOL,
    ...identity,
    event,
  };
  validateTenantTelemetryDispositionStoredEvent(stored);
  return stored;
}

export function canonicalTenantTelemetryDispositionStoredEvent(
  stored: TenantTelemetryDispositionStoredEvent,
): string {
  validateTenantTelemetryDispositionStoredEvent(stored);
  return canonicalJson(stored);
}

export function parseCanonicalTenantTelemetryDispositionStoredEvent(
  payload: string,
): TenantTelemetryDispositionStoredEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("invalid tenant telemetry disposition event JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid tenant telemetry disposition event JSON");
  }
  const stored = parsed as TenantTelemetryDispositionStoredEvent;
  validateTenantTelemetryDispositionStoredEvent(stored);
  if (canonicalTenantTelemetryDispositionStoredEvent(stored) !== payload) {
    throw new Error("tenant telemetry disposition event JSON is not canonical");
  }
  return stored;
}
