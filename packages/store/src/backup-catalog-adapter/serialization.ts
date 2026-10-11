import { TENANT_BACKUP_CATALOG_PROTOCOL } from "../backup-catalog.js";
import {
  validateTenantBackupCatalogAdapterEvent,
  validateTenantBackupCatalogAdapterIdentity,
  type TenantBackupCatalogAdapterEvent,
  type TenantBackupCatalogAdapterIdentity,
} from "./common.js";

export const TENANT_BACKUP_CATALOG_STORAGE_EVENT_SCOPE =
  "tenant-backup-catalog-storage-event-v1" as const;

export interface TenantBackupCatalogStoredEvent extends TenantBackupCatalogAdapterIdentity {
  scope: typeof TENANT_BACKUP_CATALOG_STORAGE_EVENT_SCOPE;
  protocol: typeof TENANT_BACKUP_CATALOG_PROTOCOL;
  event: TenantBackupCatalogAdapterEvent;
}

function exactKeys(value: object, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${name} has unknown or missing fields`);
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("backup catalog JSON contains an unsupported value");
  return encoded;
}

export function validateTenantBackupCatalogStoredEvent(
  stored: TenantBackupCatalogStoredEvent,
): void {
  exactKeys(stored, [
    "scope",
    "protocol",
    "adapterProtocol",
    "catalogNamespaceSha256",
    "catalogTargetSha256",
    "failureDomainSha256",
    "event",
  ], "tenant backup catalog stored event");
  if (stored.scope !== TENANT_BACKUP_CATALOG_STORAGE_EVENT_SCOPE
    || stored.protocol !== TENANT_BACKUP_CATALOG_PROTOCOL) {
    throw new Error("tenant backup catalog stored event protocol is invalid");
  }
  validateTenantBackupCatalogAdapterIdentity(stored);
  validateTenantBackupCatalogAdapterEvent(stored.event);
}

export function buildTenantBackupCatalogStoredEvent(
  identity: TenantBackupCatalogAdapterIdentity,
  event: TenantBackupCatalogAdapterEvent,
): TenantBackupCatalogStoredEvent {
  const stored: TenantBackupCatalogStoredEvent = {
    scope: TENANT_BACKUP_CATALOG_STORAGE_EVENT_SCOPE,
    protocol: TENANT_BACKUP_CATALOG_PROTOCOL,
    ...identity,
    event,
  };
  validateTenantBackupCatalogStoredEvent(stored);
  return stored;
}

export function canonicalTenantBackupCatalogStoredEvent(
  stored: TenantBackupCatalogStoredEvent,
): string {
  validateTenantBackupCatalogStoredEvent(stored);
  return canonicalJson(stored);
}

export function parseCanonicalTenantBackupCatalogStoredEvent(
  payload: string,
): TenantBackupCatalogStoredEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("invalid backup catalog event JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid backup catalog event JSON");
  }
  const stored = parsed as TenantBackupCatalogStoredEvent;
  validateTenantBackupCatalogStoredEvent(stored);
  if (canonicalTenantBackupCatalogStoredEvent(stored) !== payload) {
    throw new Error("backup catalog event JSON is not canonical");
  }
  return stored;
}
