import { createHash } from "node:crypto";
import {
  validateTenantBackupSnapshotAnchor,
  validateTenantTelemetryCaptureBackupCheckpoint,
  tenantRestoreJournalTargetRootSha256,
  TENANT_TELEMETRY_CAPTURE_RESTORE_MAX_BYTES,
  TENANT_TELEMETRY_CAPTURE_CHECKPOINT_SCOPE,
  TENANT_TELEMETRY_CAPTURE_CHECKPOINT_V2_SCOPE,
  type TenantBackupSnapshotAnchor,
  type TenantTelemetryCaptureBackupCheckpoint,
  type TenantTelemetryCaptureBackupCheckpointV1,
  type TenantTelemetryCaptureBackupCheckpointV2,
} from "@agent-service/store";

export const MYSQL_BACKUP_ARTIFACT_SCOPE = "mysql-logical-full-artifact-v1" as const;
export const MYSQL_BACKUP_ARTIFACT_MAGIC = Buffer.from("ASMYSQL1", "ascii");
export const MYSQL_BACKUP_ARTIFACT_MANIFEST_LIMIT = 64 * 1024;
export const MYSQL_BACKUP_ARTIFACT_PRODUCER_VERSION = "agent-service-mysql-backup-artifact/1";
export const MYSQL_BACKUP_ARTIFACT_V2_SCOPE = "mysql-logical-full-artifact-v2" as const;
export const MYSQL_BACKUP_ARTIFACT_V2_MAGIC = Buffer.from("ASMYSQL2", "ascii");
export const MYSQL_BACKUP_ARTIFACT_V2_PRODUCER_VERSION = "agent-service-mysql-backup-artifact/2";
// v1 remains byte-compatible at 64 KiB. v2 has an explicit checkpoint budget;
// all 49 family summaries are embedded, never a truncated selection of leaves.
export const MYSQL_BACKUP_ARTIFACT_V2_MANIFEST_LIMIT = MYSQL_BACKUP_ARTIFACT_MANIFEST_LIMIT + TENANT_TELEMETRY_CAPTURE_RESTORE_MAX_BYTES;
export const MYSQL_BACKUP_ARTIFACT_V3_SCOPE = "mysql-logical-full-artifact-v3" as const;
export const MYSQL_BACKUP_ARTIFACT_V3_MAGIC = Buffer.from("ASMYSQL3", "ascii");
export const MYSQL_BACKUP_ARTIFACT_V3_PRODUCER_VERSION = "agent-service-mysql-backup-artifact/3";
// CP2 embeds the complete 49 summaries plus the separate fixed ancestry
// capsule, not their leaves. The shared closed checkpoint still has its 1 MiB
// bound; no ancestor may be silently dropped to fit the envelope.
export const MYSQL_BACKUP_ARTIFACT_V3_MANIFEST_LIMIT = MYSQL_BACKUP_ARTIFACT_MANIFEST_LIMIT + TENANT_TELEMETRY_CAPTURE_RESTORE_MAX_BYTES;
// Separate schema-root contract, unchanged for all artifact envelope versions.
export const MYSQL_BACKUP_ARTIFACT_SCHEMA_SCOPE = "mysql-full-logical-schema-v2";

export interface ArtifactEvidence {
  sourceSnapshotSha256: string;
  sourceBackupSha256: string;
  artifactManifestSha256: string;
  providerEvidenceSha256: string;
}

export interface MySqlBackupArtifactManifestV1 {
  scope: typeof MYSQL_BACKUP_ARTIFACT_SCOPE;
  version: 1;
  backupId: string;
  anchor: TenantBackupSnapshotAnchor;
  schemaMigrationRootSha256: string;
  sourceIdentitySha256: string;
  schemaSha256: string;
  producerVersion: typeof MYSQL_BACKUP_ARTIFACT_PRODUCER_VERSION;
  mysqlVersion: string;
  mysqldumpVersion: string;
  serverVersion: string;
  plaintextBytes: number;
  plaintextSha256: string;
  ciphertextBytes: number;
  ciphertextSha256: string;
  encryption: { algorithm: "aes-256-gcm"; nonceHex: string; authTagHex: string };
}
export interface MySqlBackupArtifactManifestV2 extends Omit<MySqlBackupArtifactManifestV1, "scope" | "version" | "producerVersion"> {
  scope: typeof MYSQL_BACKUP_ARTIFACT_V2_SCOPE;
  version: 2;
  producerVersion: typeof MYSQL_BACKUP_ARTIFACT_V2_PRODUCER_VERSION;
  captureCheckpoint: TenantTelemetryCaptureBackupCheckpointV1;
}
export interface MySqlBackupArtifactManifestV3 extends Omit<MySqlBackupArtifactManifestV1, "scope" | "version" | "producerVersion"> {
  scope: typeof MYSQL_BACKUP_ARTIFACT_V3_SCOPE;
  version: 3;
  producerVersion: typeof MYSQL_BACKUP_ARTIFACT_V3_PRODUCER_VERSION;
  captureCheckpoint: TenantTelemetryCaptureBackupCheckpointV2;
}
export type MySqlBackupArtifactManifest = MySqlBackupArtifactManifestV1 | MySqlBackupArtifactManifestV2 | MySqlBackupArtifactManifestV3;

export interface MySqlBackupArtifactImportDiagnostic {
  readonly phase: "native_import" | "lock_recheck" | "schema_inspection" | "schema_digest" | "import_completed_journal";
  readonly code: "tool_failed" | "tool_unavailable" | "operation_deadline" | "operator_lock_lost"
    | "database_query_failed" | "server_version_invalid" | "source_identity_mismatch"
    | "source_migration_mismatch" | "source_anchor_invalid" | "source_anchor_mismatch" | "source_changed"
    | "source_schema_invalid" | "source_schema_limit" | "source_schema_nonportable" | "source_views_unsupported"
    | "source_routines_unsupported" | "source_events_unsupported" | "target_schema_mismatch" | "manifest_invalid"
    | "artifact_file_unprotected" | "restore_operation_conflict" | "operator_invalid" | "unclassified";
}

export class MySqlBackupArtifactError extends Error {
  constructor(public readonly code: string, public readonly targetMayContainPartialImport = false,
    public readonly diagnostic?: MySqlBackupArtifactImportDiagnostic) {
    super(`MySQL backup artifact operation failed (${code}).`);
    this.name = "MySqlBackupArtifactError";
  }
}

export function artifactFailure(code: string): never { throw new MySqlBackupArtifactError(code); }
export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Deterministic JSON, including nested anchor objects; byte order is part of wire v1. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  return artifactFailure("manifest_invalid");
}

interface TableDefinitionToken {
  kind: "word" | "identifier" | "literal" | "comment" | "space" | "symbol";
  start: number;
  end: number;
  value: string;
}

/** Unknown lexical forms retain the strict original definition, never a best-effort rewrite. */
function tableDefinitionTokens(sql: string): TableDefinitionToken[] | undefined {
  // SHOW CREATE quoting depends on NO_BACKSLASH_ESCAPES. Do not guess the session
  // mode: any backslash-bearing definition stays raw, even outside a literal.
  if (sql.includes("\\")) return;
  const tokens: TableDefinitionToken[] = [];
  for (let position = 0; position < sql.length;) {
    const start = position;
    const first = sql[position]!;
    let kind: TableDefinitionToken["kind"];
    if (/\s/.test(first)) {
      kind = "space";
      while (position < sql.length && /\s/.test(sql[position]!)) position += 1;
    } else if (first === "'" || first === '"' || first === "`") {
      kind = first === "`" ? "identifier" : "literal";
      position += 1;
      let closed = false;
      while (position < sql.length) {
        if (sql[position++] !== first) continue;
        if (sql[position] === first) { position += 1; continue; }
        closed = true; break;
      }
      if (!closed) return;
    } else if (sql.startsWith("/*", position)) {
      kind = "comment";
      const end = sql.indexOf("*/", position + 2);
      if (end < 0) return;
      position = end + 2;
    } else if (first === "#" || (sql.startsWith("--", position)
      && (position + 2 === sql.length || /\s/.test(sql[position + 2]!)))) {
      kind = "comment";
      const end = sql.indexOf("\n", position);
      position = end < 0 ? sql.length : end + 1;
    } else if (/[a-zA-Z0-9_$]/.test(first)) {
      kind = "word";
      while (position < sql.length && /[a-zA-Z0-9_$]/.test(sql[position]!)) position += 1;
    } else { kind = "symbol"; position += 1; }
    tokens.push({ kind, start, end: position, value: sql.slice(start, position) });
  }
  return tokens;
}

/**
 * Preserve full SHOW CREATE bytes except one proven redundant display form.
 * MySQL 8 can add CHARACTER SET utf8mb4 on logical reload of an existing column.
 * It is redundant only for a real string column with an explicit utf8mb4_*
 * COLLATE under the table's actual DEFAULT CHARSET=utf8mb4. Without COLLATE,
 * removing it could change the effective collation and is strictly forbidden.
 * Generated columns keep legacy bytes unless the actual migration names include
 * 0064. The artifact inspector must bind that complete set to the authenticated
 * anchor before supplying it; no alternate digest is tried on import.
 */
export function canonicalMySqlBackupTableDefinition(sql: string, actualMigrationNames: readonly string[] = []): string {
  const normalizeGeneratedColumns = actualMigrationNames.includes("0064_subagents.sql");
  const tokens = tableDefinitionTokens(sql);
  if (!tokens) return sql;
  const significant = tokens.filter((token) => token.kind !== "space");
  const opening = significant.findIndex((token) => token.kind === "symbol" && token.value === "(");
  if (opening !== 3 || significant[0]?.value !== "CREATE" || significant[1]?.value !== "TABLE"
    || !["identifier", "word"].includes(significant[2]?.kind ?? "")) return sql;
  let depth = 0;
  let closing = -1;
  const declarations: TableDefinitionToken[][] = [];
  let declaration: TableDefinitionToken[] = [];
  for (let index = opening; index < significant.length; index += 1) {
    const token = significant[index]!;
    if (token.kind === "symbol" && token.value === "(") depth += 1;
    if (token.kind === "symbol" && token.value === ")") depth -= 1;
    if (depth < 0) return sql;
    if (depth === 0) { closing = index; declarations.push(declaration); break; }
    if (index === opening) continue;
    if (depth === 1 && token.kind === "symbol" && token.value === ",") {
      declarations.push(declaration); declaration = [];
    } else declaration.push(token);
  }
  if (closing < 0 || declarations.some((entry) => !entry.length)) return sql;
  const tail: TableDefinitionToken[] = [];
  depth = 0;
  for (const token of significant.slice(closing + 1)) {
    if (token.kind === "symbol" && token.value === "(") depth += 1;
    if (depth === 0) tail.push(token);
    if (token.kind === "symbol" && token.value === ")") depth -= 1;
    if (depth < 0) return sql;
  }
  if (depth !== 0) return sql;
  const isWord = (token: TableDefinitionToken | undefined, value: string) => token?.kind === "word"
    && token.value.toLowerCase() === value;
  const tableCharsets = tail.flatMap((token, index) => isWord(token, "default") && isWord(tail[index + 1], "charset")
    && tail[index + 2]?.value === "=" && tail[index + 3]?.kind === "word" ? [tail[index + 3]!.value.toLowerCase()] : []);
  if (tableCharsets.length !== 1 || tableCharsets[0] !== "utf8mb4"
    || tail.filter((token) => isWord(token, "charset")).length !== 1
    || tail.some((token, index) => isWord(token, "character") && isWord(tail[index + 1], "set"))) return sql;
  const removals: Array<{ start: number; end: number }> = [];
  for (const entry of declarations) {
    if (entry[0]?.kind !== "identifier" || entry[1]?.kind !== "word"
      || !/^(?:char|varchar|tinytext|text|mediumtext|longtext|enum|set)$/i.test(entry[1].value)
      || entry.some((token) => token.kind === "comment")) continue;
    const top: TableDefinitionToken[] = [];
    depth = 0;
    for (const token of entry) {
      if (token.kind === "symbol" && token.value === "(") depth += 1;
      if (depth === 0) top.push(token);
      if (token.kind === "symbol" && token.value === ")") depth -= 1;
    }
    if (depth !== 0 || top.some((token) => token.kind === "word"
      && (/^(?:check|binary|ascii|unicode)$/i.test(token.value)
        || !normalizeGeneratedColumns && /^(?:generated|as)$/i.test(token.value)))) continue;
    const charsets = top.flatMap((token, index) => isWord(token, "character") && isWord(top[index + 1], "set")
      && top[index + 2]?.kind === "word" ? [{ index, charset: top[index + 2]! }] : []);
    const collations = top.flatMap((token, index) => isWord(token, "collate") ? [index] : []);
    if (charsets.length !== 1 || top.filter((token) => isWord(token, "character")).length !== 1
      || collations.length !== 1 || charsets[0]!.index !== 2 || collations[0] !== 5
      || top[6]?.kind !== "word" || !/^utf8mb4_[a-z0-9_]+$/i.test(top[6].value)
      || charsets[0]!.charset.value.toLowerCase() !== "utf8mb4") continue;
    const character = top[charsets[0]!.index]!;
    const set = top[charsets[0]!.index + 1]!;
    const charset = charsets[0]!.charset;
    // Remove only this exact attribute and its single preceding display space.
    if (sql.slice(character.start - 1, character.start) !== " "
      || sql.slice(character.end, set.start) !== " " || sql.slice(set.end, charset.start) !== " ") continue;
    removals.push({ start: character.start - 1, end: charset.end });
  }
  let result = sql;
  for (const range of removals.reverse()) result = result.slice(0, range.start) + result.slice(range.end);
  return result;
}

function exactKeys(obj: unknown, keys: string[]): asserts obj is Record<string, unknown> {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)
    || Object.getPrototypeOf(obj) !== Object.prototype
    || Object.keys(obj).sort().join("\0") !== keys.sort().join("\0")) artifactFailure("manifest_invalid");
}

/** Checkpoint digests authenticate a closed wire contract, not database truth. */
export function assertArtifactCaptureCheckpoint(checkpoint: TenantTelemetryCaptureBackupCheckpoint,
  anchor: TenantBackupSnapshotAnchor, refKey: Uint8Array | undefined): void {
  if (!(refKey instanceof Uint8Array) || refKey.length !== 32) artifactFailure("capture_ref_key_required");
  try { validateTenantTelemetryCaptureBackupCheckpoint(checkpoint, refKey); }
  catch { artifactFailure("capture_checkpoint_invalid"); }
  if (checkpoint.backupId !== anchor.backupId || checkpoint.anchorSha256 !== anchor.anchorSha256
    || checkpoint.anchorCreatedAtDbMs !== anchor.createdAtDbMs
    || checkpoint.schemaMigrationRootSha256 !== anchor.schemaMigrationRootSha256
    || checkpoint.logicalDatabaseNamespaceSha256 !== anchor.logicalDatabaseNamespaceSha256
    || checkpoint.sourceRuntimeEpochSha256 !== anchor.sourceRuntimeEpochSha256
    || checkpoint.sourceRuntimeControlGeneration !== anchor.sourceRuntimeControlGeneration
    || checkpoint.sourceRuntimeControlEvidenceSha256 !== anchor.sourceRuntimeControlEvidenceSha256
    || checkpoint.journalControlEvidenceSha256 !== anchor.journalControlEvidenceSha256
    || checkpoint.journalTargetRootSha256 !== tenantRestoreJournalTargetRootSha256(anchor.sourceRuntimeHeads.map((head) => ({
      targetOrdinal: head.targetOrdinal, targetSha256: head.targetSha256, failureDomainSha256: head.failureDomainSha256,
      adapterProtocol: head.adapterProtocol, journalNamespaceSha256: head.journalNamespaceSha256,
    })))
    || checkpoint.journalHeadRootSha256 !== anchor.sourceRuntimeHeadRootSha256
    || checkpoint.catalogControlEvidenceSha256 !== anchor.controlEvidenceSha256
    || checkpoint.catalogHeadSequence !== anchor.sourceCatalogSequence
    || checkpoint.catalogHeadRootSha256 !== anchor.sourceCatalogEventRootSha256
    || checkpoint.blobStorageControlEvidenceSha256 !== anchor.blobStorageControlEvidenceSha256) artifactFailure("capture_checkpoint_anchor_mismatch");
}

export function validateMySqlBackupArtifactManifest(value: unknown, maxBytes: number,
  tenantTelemetryRefKey?: Uint8Array): asserts value is MySqlBackupArtifactManifest {
  const v2 = !!value && typeof value === "object" && (value as { version?: unknown }).version === 2;
  const v3 = !!value && typeof value === "object" && (value as { version?: unknown }).version === 3;
  exactKeys(value, ["scope", "version", "backupId", "anchor", "schemaMigrationRootSha256",
    "sourceIdentitySha256", "schemaSha256", "producerVersion", "mysqlVersion", "mysqldumpVersion",
    "serverVersion", "plaintextBytes", "plaintextSha256", "ciphertextBytes", "ciphertextSha256", "encryption",
    ...(v2 || v3 ? ["captureCheckpoint"] : [])]);
  if (v3 ? value.scope !== MYSQL_BACKUP_ARTIFACT_V3_SCOPE || value.producerVersion !== MYSQL_BACKUP_ARTIFACT_V3_PRODUCER_VERSION
    : v2 ? value.scope !== MYSQL_BACKUP_ARTIFACT_V2_SCOPE || value.producerVersion !== MYSQL_BACKUP_ARTIFACT_V2_PRODUCER_VERSION
    : value.scope !== MYSQL_BACKUP_ARTIFACT_SCOPE || value.version !== 1
      || value.producerVersion !== MYSQL_BACKUP_ARTIFACT_PRODUCER_VERSION) artifactFailure("manifest_invalid");
  try { validateTenantBackupSnapshotAnchor(value.anchor as TenantBackupSnapshotAnchor); }
  catch { artifactFailure("manifest_invalid"); }
  const anchor = value.anchor as TenantBackupSnapshotAnchor;
  if (v2 || v3) {
    const checkpoint = value.captureCheckpoint as TenantTelemetryCaptureBackupCheckpoint;
    assertArtifactCaptureCheckpoint(checkpoint, anchor, tenantTelemetryRefKey);
    // The old v2 wire contract must never acquire new ancestry semantics merely
    // because the shared reader now accepts a discriminated checkpoint union.
    if (checkpoint.scope !== (v3 ? TENANT_TELEMETRY_CAPTURE_CHECKPOINT_V2_SCOPE : TENANT_TELEMETRY_CAPTURE_CHECKPOINT_SCOPE)) {
      artifactFailure("capture_checkpoint_version_mismatch");
    }
  }
  if (value.backupId !== anchor.backupId || value.schemaMigrationRootSha256 !== anchor.schemaMigrationRootSha256) {
    artifactFailure("manifest_invalid");
  }
  for (const field of ["schemaMigrationRootSha256", "sourceIdentitySha256", "schemaSha256", "plaintextSha256", "ciphertextSha256"]) {
    if (typeof value[field] !== "string" || !/^[0-9a-f]{64}$/.test(value[field])) artifactFailure("manifest_invalid");
  }
  for (const field of ["plaintextBytes", "ciphertextBytes"]) {
    if (!Number.isSafeInteger(value[field]) || Number(value[field]) < 1 || Number(value[field]) > maxBytes) artifactFailure("artifact_limit");
  }
  if (value.plaintextBytes !== value.ciphertextBytes) artifactFailure("manifest_invalid");
  for (const field of ["mysqlVersion", "mysqldumpVersion"]) {
    if (typeof value[field] !== "string" || !/^[\x20-\x7e]{1,512}$/.test(value[field])
      || !/\b(?:Ver|Distrib) 8\.\d+\.\d+\b/.test(value[field])) artifactFailure("tool_version_invalid");
  }
  if (typeof value.serverVersion !== "string" || !/^8\.\d+\.\d+[a-zA-Z0-9.+_-]*$/.test(value.serverVersion)) artifactFailure("server_version_invalid");
  exactKeys(value.encryption, ["algorithm", "nonceHex", "authTagHex"]);
  if (value.encryption.algorithm !== "aes-256-gcm"
    || typeof value.encryption.nonceHex !== "string" || !/^[0-9a-f]{24}$/.test(value.encryption.nonceHex)
    || typeof value.encryption.authTagHex !== "string" || !/^[0-9a-f]{32}$/.test(value.encryption.authTagHex)) artifactFailure("manifest_invalid");
}

/** Ciphertext hash/tag are checked separately after authentication, avoiding a circular AAD. */
export function artifactAad(manifest: MySqlBackupArtifactManifest): Buffer {
  const { ciphertextBytes: _length, ciphertextSha256: _hash, encryption, ...body } = manifest;
  return Buffer.from(canonicalJson({ ...body, encryption: { algorithm: encryption.algorithm, nonceHex: encryption.nonceHex } }));
}

export function encodeArtifactManifest(manifest: MySqlBackupArtifactManifest, maxBytes: number, tenantTelemetryRefKey?: Uint8Array): Buffer {
  validateMySqlBackupArtifactManifest(manifest, maxBytes, tenantTelemetryRefKey);
  const bytes = Buffer.from(canonicalJson(manifest));
  if (bytes.length > manifestLimit(manifest.version)) artifactFailure("manifest_limit");
  return bytes;
}

export function decodeArtifactManifest(bytes: Buffer, maxBytes: number, tenantTelemetryRefKey?: Uint8Array): MySqlBackupArtifactManifest {
  if (!bytes.length || bytes.length > Math.max(MYSQL_BACKUP_ARTIFACT_V2_MANIFEST_LIMIT, MYSQL_BACKUP_ARTIFACT_V3_MANIFEST_LIMIT)) artifactFailure("manifest_limit");
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { return artifactFailure("manifest_invalid"); }
  validateMySqlBackupArtifactManifest(value, maxBytes, tenantTelemetryRefKey);
  if (bytes.length > manifestLimit(value.version)) artifactFailure("manifest_limit");
  if (!Buffer.from(canonicalJson(value)).equals(bytes)) artifactFailure("manifest_noncanonical");
  return value;
}

export function artifactEvidence(manifest: MySqlBackupArtifactManifest, sourceBackupSha256: string): ArtifactEvidence {
  if (!/^[0-9a-f]{64}$/.test(sourceBackupSha256)) artifactFailure("evidence_invalid");
  const artifactManifestSha256 = sha256(canonicalJson(manifest));
  return {
    sourceSnapshotSha256: manifest.plaintextSha256,
    sourceBackupSha256,
    artifactManifestSha256,
    providerEvidenceSha256: sha256(canonicalJson({
      scope: manifest.version === 3 ? "mysql-logical-full-artifact-provider-evidence-v3"
        : manifest.version === 2 ? "mysql-logical-full-artifact-provider-evidence-v2" : "mysql-logical-full-artifact-provider-evidence-v1", backupId: manifest.backupId,
      anchorSha256: manifest.anchor.anchorSha256, sourceIdentitySha256: manifest.sourceIdentitySha256,
      schemaMigrationRootSha256: manifest.schemaMigrationRootSha256, schemaSha256: manifest.schemaSha256,
      sourceSnapshotSha256: manifest.plaintextSha256, sourceBackupSha256, artifactManifestSha256,
      ...(manifest.version !== 1 ? { captureCheckpointSha256: manifest.captureCheckpoint.checkpointSha256 } : {}),
      ...(manifest.version === 3 ? { captureLineageCapsuleSha256: manifest.captureCheckpoint.lineage.capsuleSha256 } : {}),
    })),
  };
}

function manifestLimit(version: MySqlBackupArtifactManifest["version"]): number {
  return version === 3 ? MYSQL_BACKUP_ARTIFACT_V3_MANIFEST_LIMIT
    : version === 2 ? MYSQL_BACKUP_ARTIFACT_V2_MANIFEST_LIMIT : MYSQL_BACKUP_ARTIFACT_MANIFEST_LIMIT;
}

export function assertArtifactEvidence(actual: ArtifactEvidence, expected: ArtifactEvidence): void {
  exactKeys(expected, ["sourceSnapshotSha256", "sourceBackupSha256", "artifactManifestSha256", "providerEvidenceSha256"]);
  if (canonicalJson(actual) !== canonicalJson(expected)) artifactFailure("evidence_mismatch");
}
