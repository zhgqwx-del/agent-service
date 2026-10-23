import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import {
  DEFAULT_AUTH_POLICY,
  emptyUsage,
  type Item,
  type Session,
  type Turn,
} from "@agent-service/protocol";
import {
  MysqlSessionStore,
  S3TenantBackupCatalogAdapter,
  emptyTenantBackupCatalogHead,
  type TenantBackupCatalogAdapterEvent,
  newTenantBackupId,
  newUsageId,
  type TenantBackupCatalogAdapter,
  type MysqlStoreOptions,
  type ActivateTenantRestoreJournalControlInput,
} from "../src/index.js";
import {
  createTenantBackupCatalogAdapter,
  loadTenantBackupCatalogConfig,
} from "../../../apps/agent-runner/src/tenant-backup-catalog-config.js";
import {
  createTenantRestoreJournalAdapters,
  loadTenantRestoreJournalConfig,
} from "../../../apps/agent-runner/src/tenant-restore-journal-config.js";
import {
  formatBackupCatalogCliError,
  runBackupCatalogCli,
  type BackupCatalogCliDependencies,
} from "../../../apps/agent-runner/src/backup-catalog-cli.js";
import {
  formatRestoreLedgerReconcileCliError,
  runRestoreLedgerReconcileCli,
} from "../../../apps/agent-runner/src/restore-ledger-reconcile-cli.js";
import * as artifactOperations from "../../../apps/agent-runner/src/mysql-backup-artifact.js";
import { acquireFixtureSessionAuthority } from "./fixtures/session-authority.js";
import { CaptureMysqlInspection } from "./fixtures/capture-mysql-runtime.js";
import { ArtifactFixtureAuthority, ArtifactFixtureNativeOwnership, artifactCloseAfter,
  observeArtifactOperatorAcquisition, createArtifactFixtureS3Client, type ArtifactFixtureStoreSelection } from "./mysql-backup-artifact-authority.fixture.js";
import { canonicalJson, canonicalMySqlBackupTableDefinition } from "../../../apps/agent-runner/src/mysql-backup-artifact-codec.js";

const PREFIX = "mysql-backup-artifact-tests";
const DATABASE = /^agent_service_backup_artifact_test_[0-9]+_[0-9a-f]{8}_[0-9]+$/;
// Fixture diagnostics never expose native error text/config/causes. The code must
// be one of these closed product constants, not an arbitrary provider error.code.
const ARTIFACT_ERROR_CODES = new Set([
  "deadline_invalid", "operation_deadline", "local_only_required", "fleet_stopped_required",
  "artifact_limit_invalid", "backup_id_invalid", "source_anchor_invalid", "restore_id_invalid",
  "database_address_invalid", "artifact_directory_invalid", "artifact_directory_unprotected",
  "artifact_file_unprotected", "key_file_invalid", "database_unavailable", "database_query_failed",
  "server_version_invalid", "operator_lock_lost", "target_not_empty", "operator_invalid",
  "restore_operation_conflict", "restore_operation_unavailable", "operator_busy", "target_is_source",
  "operator_identity_mismatch", "restore_operation_invalid", "source_identity_mismatch",
  "operator_cleanup_failed", "operator_unavailable", "source_schema_invalid", "source_migration_mismatch",
  "source_anchor_mismatch", "source_views_unsupported", "source_schema_nonportable", "source_schema_limit",
  "source_changed", "source_events_unsupported", "source_routines_unsupported", "tool_path_invalid",
  "tool_version_invalid", "tool_unavailable", "tool_failed", "dump_failed", "artifact_format_invalid",
  "manifest_limit", "manifest_invalid", "manifest_noncanonical", "backup_id_mismatch", "anchor_mismatch",
  "artifact_length_mismatch", "artifact_digest_mismatch", "artifact_unavailable", "dump_empty",
  "artifact_create_failed", "verified_capability_invalid", "target_identity_mismatch",
  "target_schema_mismatch", "import_unavailable", "import_failed_target_isolated", "artifact_limit",
  "evidence_invalid", "evidence_mismatch", "authentication_failed",
]);
const IMPORT_DIAGNOSTIC_PHASES = new Set([
  "native_import", "lock_recheck", "schema_inspection", "schema_digest", "import_completed_journal",
]);

function newId(prefix: string): string {
  const id = randomUUID();
  return `${prefix}_${id.slice(0, 14)}7${id.slice(15)}`;
}

export const backupArtifactIntegrationEnabled = (() => {
  const gates = [
    process.env.AGENT_SERVICE_INTEGRATION ?? "0",
    process.env.AGENT_SERVICE_MYSQL_BACKUP_ARTIFACT_INTEGRATION ?? "0",
  ];
  if (gates.some((gate) => gate !== "0" && gate !== "1")) {
    throw new Error("MySQL backup artifact integration gates must be 0 or 1");
  }
  return gates.every((gate) => gate === "1");
})();

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the real MySQL backup artifact suite`);
  return value;
}

function disposableBase(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error("MYSQL_TEST_URL must be a valid disposable MySQL test URL"); }
  const database = decodeURIComponent(url.pathname.slice(1));
  if (url.protocol !== "mysql:" || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) {
    throw new Error("MYSQL_TEST_URL must name a disposable test database");
  }
  return url;
}

function endpoint(raw: string): string {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error("S3_TEST_ENDPOINT must be a valid credential-free HTTP(S) origin"); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("S3_TEST_ENDPOINT must be a credential-free HTTP(S) origin");
  }
  return url.origin;
}

function bucket(name: string): string {
  const value = required(name);
  if (value.length < 3 || value.length > 63
    || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value)
    || value.includes("..") || value.includes(".-") || value.includes("-.")) {
    throw new Error(`${name} must be a safe test bucket`);
  }
  return value;
}

async function binary(name: "MYSQL" | "MYSQLDUMP"): Promise<string> {
  const explicit = process.env[`BACKUP_${name}_BINARY`];
  const candidates = explicit === undefined
    ? (process.env.PATH ?? "").split(":").filter(isAbsolute)
      .map((directory) => join(directory, name.toLowerCase()))
    : [explicit];
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* continue */ }
  }
  throw new Error(`An absolute executable BACKUP_${name}_BINARY is required`);
}

export interface BackupCatalogCliStackDiagnostic {
  readonly source: "backup_catalog_cli";
  readonly lines: readonly number[];
}

/** Test-only location hint, never a cause/authorization proof or a raw stack disclosure. */
export function backupCatalogCliStackDiagnostic(error: unknown): BackupCatalogCliStackDiagnostic {
  const empty = () => Object.freeze({ source: "backup_catalog_cli" as const, lines: Object.freeze([] as number[]) });
  try {
    if (!(error instanceof Error)) return empty();
    const stack: unknown = Reflect.get(error, "stack");
    if (typeof stack !== "string" || stack.length > 32_768) return empty();
    const lines: number[] = [];
    for (const row of stack.split("\n").slice(1)) {
      // Observe only V8-shaped `at` frames, not ordinary body text containing a
      // path. A forged frame can still supply a bounded number: this is not
      // stack provenance, a cause verdict, or evidence of an authorized action.
      // Never separately inspect message/cause/code; prefixes and methods stay private.
      const frame = /^[ \t]+at (?:async )?(?:[^()\r\n]+ \(([^()\r\n]+)\)|([^()\r\n]+))$/.exec(row);
      if (!frame) continue;
      const location = /^(?:file:\/\/)?\/(?:[^\r\n?#]*\/)?apps\/agent-runner\/src\/backup-catalog-cli\.ts:([1-9][0-9]{0,4}):([1-9][0-9]{0,5})$/.exec(frame[1] ?? frame[2]!);
      if (!location) continue;
      const line = Number(location[1]);
      if (!lines.includes(line)) lines.push(line);
      if (lines.length === 3) break;
    }
    return Object.freeze({ source: "backup_catalog_cli" as const, lines: Object.freeze(lines) });
  } catch { return empty(); } // A hostile getter must not mask the original command error.
}

export interface CapturedCommand {
  status: number;
  stdout: string;
  stderr: string;
  value?: Record<string, unknown>;
  cliFailureDiagnostic?: BackupCatalogCliStackDiagnostic;
  failureDiagnostic?: {
    stage: "acquire" | "create" | "verify" | "import";
    code: string;
    productPhase?: string;
    productCode?: string;
  };
}

const TRIGGER_DIAGNOSTIC_FIELDS = [
  "body", "event", "timing", "table_name", "action_order", "sql_mode", "definer",
  "charset", "collation", "database_collation",
] as const;
const SQL_DIAGNOSTIC_CLASSES = [
  "identifier", "stringLiteral", "whitespace", "charsetIntroducer", "collationKeyword",
  "numeric", "keyword", "punctuation", "comment",
] as const;
type SqlDiagnosticClass = typeof SQL_DIAGNOSTIC_CLASSES[number];
const SQL_DIAGNOSTIC_WORDS = [
  "CHARACTER", "SET", "COLLATE", "DEFAULT", "NULL", "NOT", "ON", "UPDATE",
  "CURRENT_TIMESTAMP", "INVISIBLE", "VISIBLE", "STORAGE", "COLUMN_FORMAT", "UTF8MB4",
] as const;
type SqlDiagnosticWord = typeof SQL_DIAGNOSTIC_WORDS[number];
type SqlDiagnosticToken = { value: string; kind: SqlDiagnosticClass; start: number; end: number };
function sqlDiagnosticTokens(sql: string): SqlDiagnosticToken[] {
  // Diagnostic-only lexer: quoting/comments are retained verbatim in memory.
  // Its output is never used to authorize an import or emitted as SQL/token text.
  const tokens = [...sql.matchAll(/\s+|\/\*[\s\S]*?\*\/|--[^\n]*(?:\n|$)|#[^\n]*(?:\n|$)|`(?:``|[^`])*`|'(?:\\[\s\S]|''|[^'\\])*'|"(?:\\[\s\S]|""|[^"\\])*"|_[a-zA-Z0-9_]+(?=')|0x[0-9a-fA-F]+|\d+(?:\.\d+)?|[a-zA-Z_][a-zA-Z0-9_]*|[\s\S]/g)];
  return tokens.map((match): SqlDiagnosticToken => {
    const value = match[0], start = match.index;
    return { value, start, end: start + value.length, kind:
    /^\s+$/.test(value) ? "whitespace"
      : /^(\/\*|--|#)/.test(value) ? "comment"
      : value.startsWith("`") ? "identifier"
      : /^['"]/.test(value) ? "stringLiteral"
      : /^_[a-zA-Z0-9_]+$/.test(value) ? "charsetIntroducer"
      : /^COLLATE$/i.test(value) ? "collationKeyword"
      : /^(?:0x[0-9a-f]+|\d+(?:\.\d+)?)$/i.test(value) ? "numeric"
      : /^[a-zA-Z_]/.test(value) ? "keyword" : "punctuation",
    };
  });
}
// A candidate must be a real token sequence in the complete raw DDL, not text
// inside a literal/comment (including one spanning several physical lines).
function redundantCharsetRangesOutsideQuotesAndComments(sql: string): { start: number; end: number }[] {
  const tokens = sqlDiagnosticTokens(sql);
  // An unmatched quote/backtick or block-comment opener makes classification
  // unavailable rather than letting the fallback punctuation lexer expose words.
  if (tokens.some((token, index) => /^[\x22\x27\x60]$/.test(token.value)
    || token.kind === "punctuation" && token.value === "/" && tokens[index + 1]?.value === "*")) return [];
  const ranges: { start: number; end: number }[] = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const before = tokens[index - 1], character = tokens[index], firstSpace = tokens[index + 1];
    const set = tokens[index + 2], secondSpace = tokens[index + 3], charset = tokens[index + 4];
    const after = tokens[index + 5], collate = tokens[index + 6];
    if (before?.kind !== "whitespace" || before.value !== " " || character?.kind !== "keyword" || character.value !== "CHARACTER"
      || firstSpace?.kind !== "whitespace" || firstSpace.value !== " " || set?.kind !== "keyword" || set.value !== "SET"
      || secondSpace?.kind !== "whitespace" || secondSpace.value !== " " || charset?.kind !== "keyword" || charset.value !== "utf8mb4"
      || after?.kind !== "whitespace" || after.value !== " " || collate?.kind !== "collationKeyword" || collate.value !== "COLLATE") continue;
    const range = { start: before.start, end: charset.end };
    if (sql.slice(range.start, range.end) === " CHARACTER SET utf8mb4") ranges.push(range);
  }
  return ranges;
}
function emptySqlDiagnosticCounts(): Record<SqlDiagnosticClass, number> {
  return Object.fromEntries(SQL_DIAGNOSTIC_CLASSES.map((kind) => [kind, 0])) as Record<SqlDiagnosticClass, number>;
}
function declarationClass(line: string): keyof MySqlBackupSchemaDifference["movedTableDeclarationCounts"] {
  return line.startsWith("`") ? "column"
    : /^PRIMARY KEY\b/.test(line) ? "primaryKey"
    : /^UNIQUE KEY\b/.test(line) ? "uniqueKey"
    : /^KEY\b/.test(line) ? "key"
    : /^CONSTRAINT\b.*\bFOREIGN KEY\b/.test(line) ? "foreignKey"
    : /^CONSTRAINT\b.*\bCHECK\b/.test(line) ? "check"
    : /^(FULLTEXT|SPATIAL) KEY\b/.test(line) ? "fulltextSpatialKey"
    : /^\)\s*/.test(line) ? "options" : "other";
}
const SCHEMA_METADATA_QUERIES = {
  columns: "SELECT TABLE_NAME AS table_name, ORDINAL_POSITION AS ordinal, COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS default_value, CHARACTER_SET_NAME AS charset, COLLATION_NAME AS collation, EXTRA AS extra, GENERATION_EXPRESSION AS generation_expression, COLUMN_COMMENT AS comment, DATETIME_PRECISION AS datetime_precision, NUMERIC_PRECISION AS numeric_precision, NUMERIC_SCALE AS numeric_scale, SRS_ID AS srs_id FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? ORDER BY BINARY TABLE_NAME, ORDINAL_POSITION",
  indexes: "SELECT TABLE_NAME AS table_name, INDEX_NAME AS name, SEQ_IN_INDEX AS ordinal, COLUMN_NAME AS column_name, NON_UNIQUE AS non_unique, SUB_PART AS sub_part, INDEX_TYPE AS index_type, IS_VISIBLE AS is_visible, EXPRESSION AS expression, COLLATION AS collation, NULLABLE AS nullable, INDEX_COMMENT AS comment, PACKED AS packed FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? ORDER BY BINARY TABLE_NAME, BINARY INDEX_NAME, SEQ_IN_INDEX",
  constraints: "SELECT TABLE_NAME AS table_name, CONSTRAINT_NAME AS name, CONSTRAINT_TYPE AS type, ENFORCED AS enforced FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=? ORDER BY BINARY TABLE_NAME, BINARY CONSTRAINT_NAME",
  checkClauses: "SELECT t.TABLE_NAME AS table_name, c.CONSTRAINT_NAME AS name, c.CHECK_CLAUSE AS clause FROM information_schema.CHECK_CONSTRAINTS c JOIN information_schema.TABLE_CONSTRAINTS t ON t.CONSTRAINT_SCHEMA=c.CONSTRAINT_SCHEMA AND t.CONSTRAINT_NAME=c.CONSTRAINT_NAME WHERE t.TABLE_SCHEMA=? ORDER BY BINARY t.TABLE_NAME, BINARY c.CONSTRAINT_NAME",
  foreignKeys: "SELECT TABLE_NAME AS table_name, CONSTRAINT_NAME AS name, UNIQUE_CONSTRAINT_NAME AS unique_name, MATCH_OPTION AS match_option, UPDATE_RULE AS update_rule, DELETE_RULE AS delete_rule, REFERENCED_TABLE_NAME AS referenced_table FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=? ORDER BY BINARY TABLE_NAME, BINARY CONSTRAINT_NAME",
  keyColumns: "SELECT TABLE_NAME AS table_name, CONSTRAINT_NAME AS name, COLUMN_NAME AS column_name, ORDINAL_POSITION AS ordinal, POSITION_IN_UNIQUE_CONSTRAINT AS position_in_unique_constraint, REFERENCED_TABLE_SCHEMA AS referenced_schema, REFERENCED_TABLE_NAME AS referenced_table, REFERENCED_COLUMN_NAME AS referenced_column FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=? ORDER BY BINARY TABLE_NAME, BINARY CONSTRAINT_NAME, ORDINAL_POSITION",
  tableAttributes: "SELECT TABLE_NAME AS table_name, ENGINE AS engine, ROW_FORMAT AS row_format, TABLE_COLLATION AS collation, CREATE_OPTIONS AS create_options, TABLE_COMMENT AS comment FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ORDER BY BINARY TABLE_NAME",
} as const;
type SchemaMetadataCategory = keyof typeof SCHEMA_METADATA_QUERIES;
export interface MySqlBackupSchemaSnapshot {
  schemaSha256: string;
  tables: Map<string, string>;
  triggers: Map<string, Record<string, unknown>>;
  metadata: Record<SchemaMetadataCategory, Map<string, string>>;
  connectionCollation: string;
  connectionSqlMode: string;
}
export interface MySqlBackupSchemaDifference {
  sourceTableCount: number;
  targetTableCount: number;
  missingTables: number;
  extraTables: number;
  tableSqlMismatchCount: number;
  tableSqlMismatchIgnoringAutoIncrementCount: number;
  tableSqlOnlyLineOrderMismatchCount: number;
  movedTableDeclarationCounts: Record<"column" | "primaryKey" | "uniqueKey" | "key" | "foreignKey" | "check" | "fulltextSpatialKey" | "options" | "other", number>;
  changedTableDeclarationCounts: MySqlBackupSchemaDifference["movedTableDeclarationCounts"];
  sourceChangedChunkTokenCounts: Record<SqlDiagnosticClass, number>;
  targetChangedChunkTokenCounts: Record<SqlDiagnosticClass, number>;
  tableSqlOnlyOutsideWhitespaceMismatchCount: number;
  redundantExplicitCharsetMismatchCount: number;
  tableSqlOnlyRedundantExplicitCharsetMismatchCount: number;
  addedFixedKeywordCounts: Record<SqlDiagnosticWord, number>;
  removedFixedKeywordCounts: Record<SqlDiagnosticWord, number>;
  sourceTriggerCount: number;
  targetTriggerCount: number;
  missingTriggers: number;
  extraTriggers: number;
  triggerFieldMismatchCounts: Record<typeof TRIGGER_DIAGNOSTIC_FIELDS[number], number>;
  metadataTableMismatchCounts: Record<SchemaMetadataCategory, number>;
  connectionCollationEqual: boolean;
  connectionSqlModeEqual: boolean;
}

export class MySqlBackupArtifactFixture {
  readonly runId = randomBytes(12).toString("hex");
  readonly suffix = `${process.pid}_${randomBytes(4).toString("hex")}`;
  readonly backupId = newTenantBackupId();
  readonly base = disposableBase(required("MYSQL_TEST_URL"));
  readonly catalogBucket = bucket("S3_BACKUP_CATALOG_TEST_BUCKET");
  readonly journalBucket = bucket("S3_RESTORE_JOURNAL_TEST_BUCKET");
  readonly catalogPrefix = `${PREFIX}/catalog/${this.runId}`;
  readonly journalPrefix = `${PREFIX}/journal/${this.runId}`;
  readonly primaryEpochId = `artifact-primary-${this.runId}`;
  readonly restoredEpochId = `artifact-restored-${this.runId}`;
  readonly restoreRunId = `restore_${randomUUID()}`;
  readonly tenantId = `artifact-tenant-${this.runId}`;
  readonly userId = `artifact-user-${this.runId}`;
  readonly payloadCanary = `private-session-content-${randomUUID()}`;
  readonly session: Session = {
    id: newId("sess"),
    tenantId: this.tenantId,
    userId: this.userId,
    agentId: newId("agt"),
    agentVersion: 1,
    status: { type: "idle" },
    lastSeq: 0,
    contextEpoch: "e0",
    fenceToken: 0,
    usage: emptyUsage(),
    autoApprovedTools: [],
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    metadata: { fixtureContent: this.payloadCanary },
  };
  readonly usage = { ...emptyUsage(), inputTokens: 3, outputTokens: 2, totalTokens: 5, costCNY: 0.5 };
  readonly turn: Turn = {
    id: newId("turn"), sessionId: this.session.id, status: "completed", seqStart: 2,
    steps: 1, toolCalls: 0, usage: this.usage, startedAtMs: this.session.createdAtMs,
    completedAtMs: this.session.createdAtMs + 1, stopReason: "end_turn",
  };
  readonly item: Item = {
    id: newId("item"), sessionId: this.session.id, turnId: this.turn.id, seq: 0,
    type: "userMessage", status: "completed", createdAtMs: this.session.createdAtMs,
    completedAtMs: this.session.createdAtMs + 1,
    content: [{ type: "text", text: this.payloadCanary }],
  };
  readonly usageId = newUsageId();
  private readonly s3Native = createArtifactFixtureS3Client({
    endpoint: endpoint(required("S3_TEST_ENDPOINT")),
    region: required("S3_TEST_REGION"),
    forcePathStyle: required("S3_TEST_FORCE_PATH_STYLE") === "1",
    credentials: {
      accessKeyId: required("S3_TEST_ACCESS_KEY_ID"),
      secretAccessKey: required("S3_TEST_SECRET_ACCESS_KEY"),
    },
    maxAttempts: 2,
  });
  readonly s3 = this.s3Native.client;
  admin: CaptureMysqlInspection | undefined;
  privateDirectory = "";
  artifactDirectory = "";
  keyFile = "";
  mysqlBinary = "";
  mysqldumpBinary = "";
  private databaseCounter = 0;
  private readonly databases: string[] = [];
  sourceUrl = "";
  private readonly native = new ArtifactFixtureNativeOwnership(this.base.toString());
  private authority: ArtifactFixtureAuthority | undefined;
  private readonly issuedOperators = new Map<string, artifactOperations.MySqlBackupArtifactOperator>();
  private readonly operatorSources = new WeakMap<artifactOperations.MySqlBackupArtifactOperator,string>();
  private readonly verifiedOptions = new WeakMap<artifactOperations.VerifiedMySqlBackupArtifact,artifactOperations.VerifyMySqlBackupArtifactOptions>();
  private readonly verifiedRefKeys=new Set<Buffer>();
  private cleaned: Promise<void> | undefined;
  private closing = false;
  private caseSignal:AbortSignal|undefined;
  private detachCaseSignal:(()=>void)|undefined;

  /** One original Vitest body signal; no new timeout and no claim that abort is settlement.
   * Product artifact/operator/GCM owners retain their original protected-work close order. */
  bindCaseSignal(signal:AbortSignal):void{
    if(!(signal instanceof AbortSignal)||this.caseSignal||this.closing)throw Error("artifact_fixture_case_signal_invalid");
    this.caseSignal=signal;
    const stop=()=>{this.native.stop();this.s3Native.stop();};
    signal.addEventListener("abort",stop,{once:true});this.detachCaseSignal=()=>signal.removeEventListener("abort",stop);
    if(signal.aborted)stop();
  }

  /** Adapters remain their actual class instances (including instanceof/source-observer
   * checks). This outer method view owns original promises/receivers; it grants no Store brand. */
  private ownAdapter<T extends {close():Promise<void>}>(actual:T):T {
    this.native.adopt(actual);
    return new Proxy(actual,{get:(target,key)=>{
      const value:unknown=Reflect.get(target,key,target);
      if(typeof value!=="function")return value;
      return (...args:unknown[])=>{const raw:unknown=Reflect.apply(value,target,args);return raw instanceof Promise?this.native.own(raw):raw;};
    }});
  }
  private roles(): ArtifactFixtureAuthority { if (this.closing||!this.authority) throw Error("artifact_fixture_not_prepared"); return this.authority; }
  configureRuntime(url: string, selection: ArtifactFixtureStoreSelection): void { this.roles().configure(url,selection); }
  runtimeOptions(url: string, selection?: ArtifactFixtureStoreSelection): MysqlStoreOptions { return this.roles().options(url,selection); }
  runtimeEnv(url: string): Readonly<Record<string,string>> { return this.roles().runtimeEnv(url); }
  openStore(url: string, connectionLimit=2, selection?: ArtifactFixtureStoreSelection, signal?: AbortSignal): Promise<MysqlSessionStore> {
    return this.roles().openStore(url,connectionLimit,selection,signal);
  }
  connectRuntime(options: MysqlStoreOptions): Promise<MysqlSessionStore> { return this.roles().connect(options); }
  openInspection(url: string, signal?: AbortSignal): Promise<CaptureMysqlInspection> { if(this.closing)return Promise.reject(Error("artifact_fixture_closing"));return this.native.inspect(url,signal); }
  expectUnactivatedTarget(url: string, restoreRunId: string, phase: "prepared"|"replay_sealed"): Promise<void> {
    return this.roles().expectUnactivated(url,restoreRunId,phase);
  }
  retainCorruptTarget(url: string): void { this.roles().retainCorrupt(url); }
  witnessRefusedTarget(url:string):Promise<void> {return this.roles().witnessRefusedTarget(url);}
  expectPreparedSource(url:string,restoreRunId:string):Promise<void> {return this.roles().expectPreparedSource(url,restoreRunId);}
  connectCaptureBackupSourceMaintenance(
    options: Parameters<typeof MysqlSessionStore.connectTenantTelemetryCaptureBackupSourceMaintenance>[0],
    profile: Parameters<typeof MysqlSessionStore.connectTenantTelemetryCaptureBackupSourceMaintenance>[1],
  ): ReturnType<typeof MysqlSessionStore.connectTenantTelemetryCaptureBackupSourceMaintenance> {
    if(this.closing)return Promise.reject(Error("artifact_fixture_closing"));
    return this.native.factory(signal=>MysqlSessionStore.connectTenantTelemetryCaptureBackupSourceMaintenance({...options,operationAbortSignal:signal},profile),options.operationAbortSignal);
  }
  connectCaptureRestoreMaintenance(options: Parameters<typeof MysqlSessionStore.connectTenantTelemetryCaptureRestoreMaintenance>[0],
    profile: Parameters<typeof MysqlSessionStore.connectTenantTelemetryCaptureRestoreMaintenance>[1],
  ): ReturnType<typeof MysqlSessionStore.connectTenantTelemetryCaptureRestoreMaintenance> {
    if(this.closing)return Promise.reject(Error("artifact_fixture_closing"));
    return this.native.factory(signal=>MysqlSessionStore.connectTenantTelemetryCaptureRestoreMaintenance({...options,operationAbortSignal:signal},profile),options.operationAbortSignal);
  }
  connectCaptureArtifactRestoreMaintenance(options: Parameters<typeof MysqlSessionStore.connectTenantTelemetryCaptureArtifactRestoreMaintenance>[0],
    profile: Parameters<typeof MysqlSessionStore.connectTenantTelemetryCaptureArtifactRestoreMaintenance>[1],
  ): ReturnType<typeof MysqlSessionStore.connectTenantTelemetryCaptureArtifactRestoreMaintenance> {
    if(this.closing)return Promise.reject(Error("artifact_fixture_closing"));const accepted=this.native.accepted();
    return this.native.own((async()=>{
      if(profile?.kind==="operator-maintenance"){
        const operator=this.issuedOperators.get(options.url);if(!operator)throw Error("artifact_fixture_operator_not_held");
        await this.roles().retireForSelected(options.url,profile.binding,operator,accepted);
      }
      return this.native.factory(signal=>MysqlSessionStore.connectTenantTelemetryCaptureArtifactRestoreMaintenance({...options,operationAbortSignal:signal},profile),options.operationAbortSignal);
    })());
  }

  get catalogEnv(): NodeJS.ProcessEnv {
    return {
      BACKUP_CATALOG_ADAPTER: "s3",
      BACKUP_CATALOG_DATABASE_NAMESPACE_ID: `artifact-database-${this.runId}`,
      BACKUP_CATALOG_NAMESPACE_ID: `artifact-catalog-${this.runId}`,
      BACKUP_CATALOG_FAILURE_DOMAIN_ID: `artifact-catalog-fixture-domain-${this.runId}`,
      BACKUP_CATALOG_INDEPENDENT_FAILURE_DOMAIN_ACK: "1",
      BACKUP_CATALOG_S3_ENDPOINT: endpoint(required("S3_TEST_ENDPOINT")),
      BACKUP_CATALOG_S3_REGION: required("S3_TEST_REGION"),
      BACKUP_CATALOG_S3_BUCKET: this.catalogBucket,
      BACKUP_CATALOG_S3_PREFIX: this.catalogPrefix,
      BACKUP_CATALOG_S3_FORCE_PATH_STYLE: required("S3_TEST_FORCE_PATH_STYLE"),
      BACKUP_CATALOG_S3_PRIVATE_BUCKET_ACK: "1",
      BACKUP_CATALOG_S3_ACCESS_KEY_ID: required("S3_TEST_ACCESS_KEY_ID"),
      BACKUP_CATALOG_S3_SECRET_ACCESS_KEY: required("S3_TEST_SECRET_ACCESS_KEY"),
      BACKUP_CATALOG_MINIMUM_RETENTION_MS: "0",
      BACKUP_CATALOG_MINIMUM_RECOVERABLE_BACKUPS: "1",
      RESTORE_JOURNAL_S3_BUCKET: this.journalBucket,
    };
  }

  journalEnv(epochId = this.primaryEpochId): NodeJS.ProcessEnv {
    return {
      RESTORE_JOURNAL_ADAPTER: "s3",
      RESTORE_JOURNAL_DATABASE_NAMESPACE_ID: `artifact-database-${this.runId}`,
      RESTORE_JOURNAL_RUNTIME_EPOCH_ID: epochId,
      RESTORE_JOURNAL_NAMESPACE_ID: `artifact-journal-${this.runId}`,
      RESTORE_JOURNAL_FAILURE_DOMAIN_ID: `artifact-journal-fixture-domain-${this.runId}`,
      RESTORE_JOURNAL_INDEPENDENT_FAILURE_DOMAIN_ACK: "1",
      RESTORE_JOURNAL_S3_ENDPOINT: endpoint(required("S3_TEST_ENDPOINT")),
      RESTORE_JOURNAL_S3_REGION: required("S3_TEST_REGION"),
      RESTORE_JOURNAL_S3_BUCKET: this.journalBucket,
      RESTORE_JOURNAL_S3_PREFIX: this.journalPrefix,
      RESTORE_JOURNAL_S3_FORCE_PATH_STYLE: required("S3_TEST_FORCE_PATH_STYLE"),
      RESTORE_JOURNAL_S3_PRIVATE_BUCKET_ACK: "1",
      RESTORE_JOURNAL_S3_ACCESS_KEY_ID: required("S3_TEST_ACCESS_KEY_ID"),
      RESTORE_JOURNAL_S3_SECRET_ACCESS_KEY: required("S3_TEST_SECRET_ACCESS_KEY"),
    };
  }

  env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      NODE_ENV: "test",
      MYSQL_URL: this.sourceUrl,
      ...this.catalogEnv,
      ...this.journalEnv(extra.BACKUP_RUNTIME_EPOCH_ID ?? this.primaryEpochId),
      RESTORE_FLEET_STOPPED_ACK: "1",
      BACKUP_ARTIFACT_LOCAL_ONLY_ACK: "1",
      BACKUP_ARTIFACT_DIRECTORY: this.artifactDirectory,
      BACKUP_ARTIFACT_KEY_FILE: this.keyFile,
      BACKUP_MYSQL_BINARY: this.mysqlBinary,
      BACKUP_MYSQLDUMP_BINARY: this.mysqldumpBinary,
      BACKUP_ARTIFACT_MAX_BYTES: "134217728",
      BACKUP_ARTIFACT_DEADLINE_MS: "120000",
      BACKUP_ID: this.backupId,
      ...extra,
    };
  }

  databaseUrl(database: string): string {
    const url = new URL(this.base);
    url.pathname = `/${database}`;
    return url.toString();
  }

  async newDatabase(): Promise<string> {
    const database = `agent_service_backup_artifact_test_${this.suffix}_${++this.databaseCounter}`;
    if (!DATABASE.test(database)) throw new Error("unsafe generated backup artifact database");
    const url=this.databaseUrl(database);await this.roles().witness(url);
    // Register CREATE uncertainty before the actual original SQL, never adopt a pre-existing DB.
    this.roles().beforeCreate(url);this.databases.push(database);
    await this.admin!.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    this.roles().created(url);
    return this.databaseUrl(database);
  }

  async tableNames(url: string): Promise<string[]> {
    const connection = await this.openInspection(url);
    try {
      const [rows] = await connection.query<RowDataPacket[]>("SHOW FULL TABLES");
      return rows.map((row) => String(Object.values(row)[0])).sort();
    } finally { await connection.end(); }
  }

  /** Diagnostic-only metadata stays in process memory; never output definitions or object names. */
  async schemaSnapshot(url = this.sourceUrl): Promise<MySqlBackupSchemaSnapshot> {
    const parsed = new URL(url);
    const database = decodeURIComponent(parsed.pathname.slice(1));
    if (!DATABASE.test(database)) throw new Error("fixture_schema_diagnostic_scope_invalid");
    const connection = await this.openInspection(url);
    try {
      const schema: unknown[] = [];
      const tables = new Map<string, string>();
      const triggers = new Map<string, Record<string, unknown>>();
      const [objects] = await connection.query<RowDataPacket[]>(
        "SELECT TABLE_NAME AS name, TABLE_TYPE AS kind FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ORDER BY BINARY TABLE_NAME",
        [database],
      );
      const [migrationRows] = objects.some((object) => object.name === "schema_migrations" && object.kind === "BASE TABLE")
        ? await connection.query<RowDataPacket[]>("SELECT name FROM schema_migrations ORDER BY BINARY name") : [[]];
      const actualMigrationNames = migrationRows.map((row) => String(row.name));
      for (const object of objects) {
        const name = String(object.name);
        if (object.kind !== "BASE TABLE" || !/^[a-zA-Z0-9_]{1,64}$/.test(name)) {
          throw new Error("fixture_schema_diagnostic_object_invalid");
        }
        const [definition] = await connection.query<RowDataPacket[]>(`SHOW CREATE TABLE \`${name}\``);
        const sql: unknown = definition[0]?.["Create Table"];
        if (typeof sql !== "string") throw new Error("fixture_schema_diagnostic_table_invalid");
        tables.set(name, sql);
        schema.push({ kind: "BASE TABLE", name, sql: canonicalMySqlBackupTableDefinition(sql, actualMigrationNames) });
      }
      const [triggerRows] = await connection.query<RowDataPacket[]>(
        "SELECT TRIGGER_NAME AS name, ACTION_STATEMENT AS body, EVENT_MANIPULATION AS event, ACTION_TIMING AS timing, EVENT_OBJECT_TABLE AS table_name, ACTION_ORDER AS action_order, SQL_MODE AS sql_mode, DEFINER AS definer, CHARACTER_SET_CLIENT AS charset, COLLATION_CONNECTION AS collation, DATABASE_COLLATION AS database_collation FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=? ORDER BY BINARY TRIGGER_NAME",
        [database],
      );
      for (const row of triggerRows) {
        const trigger = { ...row };
        triggers.set(String(trigger.name), trigger);
        schema.push({ kind: "TRIGGER", ...trigger });
      }
      const metadata = Object.fromEntries(Object.keys(SCHEMA_METADATA_QUERIES).map((kind) => [kind, new Map()])) as
        MySqlBackupSchemaSnapshot["metadata"];
      for (const [kind, sql] of Object.entries(SCHEMA_METADATA_QUERIES) as [SchemaMetadataCategory, string][]) {
        const [rows] = await connection.query<RowDataPacket[]>(sql, [database]);
        const grouped = new Map<string, Record<string, unknown>[]>();
        for (const row of rows) {
          const { table_name: name, ...fields } = row;
          // Diagnostic-only self-schema normalization; a genuinely cross-schema
          // reference remains different. Neither names nor values are emitted.
          if (fields.referenced_schema === database) fields.referenced_schema = "<self>";
          const entries = grouped.get(String(name)) ?? [];
          entries.push(fields);
          grouped.set(String(name), entries);
        }
        for (const [name, entries] of grouped) metadata[kind].set(name, canonicalJson(entries));
      }
      const [collation] = await connection.query<RowDataPacket[]>("SELECT @@collation_connection AS collation, @@SESSION.sql_mode AS sql_mode");
      return {
        schemaSha256: createHash("sha256").update(canonicalJson({ scope: "mysql-full-logical-schema-v2", schema })).digest("hex"),
        tables, triggers, metadata, connectionCollation: String(collation[0]?.collation),
        connectionSqlMode: String(collation[0]?.sql_mode),
      };
    } finally { await connection.end(); }
  }

  async schemaDifference(expected: MySqlBackupSchemaSnapshot, targetUrl: string): Promise<MySqlBackupSchemaDifference> {
    const actual = await this.schemaSnapshot(targetUrl);
    const mismatch = Object.fromEntries(TRIGGER_DIAGNOSTIC_FIELDS.map((field) => [field, 0])) as
      MySqlBackupSchemaDifference["triggerFieldMismatchCounts"];
    let tableSqlMismatchCount = 0;
    let tableSqlMismatchIgnoringAutoIncrementCount = 0;
    let tableSqlOnlyLineOrderMismatchCount = 0;
    const movedTableDeclarationCounts = {
      column: 0, primaryKey: 0, uniqueKey: 0, key: 0, foreignKey: 0,
      check: 0, fulltextSpatialKey: 0, options: 0, other: 0,
    };
    const changedTableDeclarationCounts = { ...movedTableDeclarationCounts };
    const sourceChangedChunkTokenCounts = emptySqlDiagnosticCounts();
    const targetChangedChunkTokenCounts = emptySqlDiagnosticCounts();
    let tableSqlOnlyOutsideWhitespaceMismatchCount = 0;
    let redundantExplicitCharsetMismatchCount = 0;
    let tableSqlOnlyRedundantExplicitCharsetMismatchCount = 0;
    const addedFixedKeywordCounts = Object.fromEntries(SQL_DIAGNOSTIC_WORDS.map((word) => [word, 0])) as Record<SqlDiagnosticWord, number>;
    const removedFixedKeywordCounts = { ...addedFixedKeywordCounts };
    for (const [name, source] of expected.tables) {
      const target = actual.tables.get(name);
      if (target === undefined) continue;
      if (source !== target) {
        tableSqlMismatchCount += 1;
        const sourceRawLines = source.split("\n"), targetRawLines = target.split("\n");
        const sourceLines = sourceRawLines.map((line) => line.trim().replace(/,$/, ""));
        const targetLines = targetRawLines.map((line) => line.trim().replace(/,$/, ""));
        const reconstructedTargetLines = [...targetRawLines];
        const charsetRanges = redundantCharsetRangesOutsideQuotesAndComments(target);
        let offset = 0;
        const targetLineStarts = targetRawLines.map((line) => { const start = offset; offset += line.length + 1; return start; });
        for (let index = 0; index < sourceLines.length; index += 1) {
          const sourceLine = sourceLines[index]!;
          const targetLine = targetLines[index];
          if (targetLine === sourceLine) continue;
          changedTableDeclarationCounts[declarationClass(sourceLine)] += 1;
          const columnName = sourceLine.match(/^`([a-zA-Z0-9_]+)`\s/)?.[1];
          if (!columnName || !targetLine || targetLine.replace(" CHARACTER SET utf8mb4", "") !== sourceLine) continue;
          const sourceColumns = JSON.parse(expected.metadata.columns.get(name) ?? "[]") as Record<string, unknown>[];
          const targetColumns = JSON.parse(actual.metadata.columns.get(name) ?? "[]") as Record<string, unknown>[];
          const sourceColumn = sourceColumns.find((row) => row.name === columnName);
          const targetColumn = targetColumns.find((row) => row.name === columnName);
          const sourceTable = JSON.parse(expected.metadata.tableAttributes.get(name) ?? "[]") as Record<string, unknown>[];
          const targetTable = JSON.parse(actual.metadata.tableAttributes.get(name) ?? "[]") as Record<string, unknown>[];
          const explicitCollation = sourceLine.match(/\bCOLLATE (utf8mb4_[a-z0-9_]+)\b/)?.[1];
          if (explicitCollation && /\bDEFAULT CHARSET=utf8mb4\b/.test(source)
            && /\bDEFAULT CHARSET=utf8mb4\b/.test(target)
            && sourceColumn?.charset === "utf8mb4" && targetColumn?.charset === "utf8mb4"
            && sourceColumn.collation === explicitCollation && targetColumn.collation === explicitCollation
            && /^(char|varchar|tinytext|text|mediumtext|longtext|enum|set)(?:\(|$)/.test(String(sourceColumn.type))
            && /^utf8mb4_/.test(String(sourceTable[0]?.collation))
            && sourceTable[0]?.collation === targetTable[0]?.collation) {
            // Keep the original per-column diagnostic count unchanged.
            redundantExplicitCharsetMismatchCount += 1;
            const rawLine = targetRawLines[index], lineStart = targetLineStarts[index];
            if (rawLine !== undefined && lineStart !== undefined) {
              const ranges = charsetRanges.filter((range) => range.start >= lineStart && range.end <= lineStart + rawLine.length);
              const range = ranges.length === 1 ? ranges[0] : undefined;
              if (range) {
                const reconstructed = rawLine.slice(0, range.start - lineStart) + rawLine.slice(range.end - lineStart);
                if (reconstructed === sourceRawLines[index]) reconstructedTargetLines[index] = reconstructed;
              }
            }
          }
        }
        // Count tables, not columns, only after every raw byte difference is
        // explained by qualified deletions and all independent metadata agrees.
        if (reconstructedTargetLines.join("\n") === source
          && (Object.keys(SCHEMA_METADATA_QUERIES) as SchemaMetadataCategory[]).every((kind) => expected.metadata[kind].get(name) === actual.metadata[kind].get(name))) {
          tableSqlOnlyRedundantExplicitCharsetMismatchCount += 1;
        }
        const sourceTokens = sqlDiagnosticTokens(source);
        const targetTokens = sqlDiagnosticTokens(target);
        for (const word of SQL_DIAGNOSTIC_WORDS) {
          const difference = targetTokens.filter((token) => token.kind === "keyword" && token.value.toUpperCase() === word).length
            - sourceTokens.filter((token) => token.kind === "keyword" && token.value.toUpperCase() === word).length;
          if (difference > 0) addedFixedKeywordCounts[word] += difference;
          else removedFixedKeywordCounts[word] -= difference;
        }
        if (canonicalJson(sourceTokens.filter((token) => token.kind !== "whitespace").map((token) => token.value))
          === canonicalJson(targetTokens.filter((token) => token.kind !== "whitespace").map((token) => token.value))) {
          tableSqlOnlyOutsideWhitespaceMismatchCount += 1;
        }
        let prefix = 0;
        while (prefix < source.length && prefix < target.length && source[prefix] === target[prefix]) prefix += 1;
        let suffix = 0;
        while (suffix < source.length - prefix && suffix < target.length - prefix
          && source[source.length - 1 - suffix] === target[target.length - 1 - suffix]) suffix += 1;
        for (const token of sqlDiagnosticTokens(source.slice(prefix, source.length - suffix))) sourceChangedChunkTokenCounts[token.kind] += 1;
        for (const token of sqlDiagnosticTokens(target.slice(prefix, target.length - suffix))) targetChangedChunkTokenCounts[token.kind] += 1;
      }
      if (source !== target && canonicalJson(source.split("\n").map((line) => line.trim().replace(/,$/, "")).sort())
        === canonicalJson(target.split("\n").map((line) => line.trim().replace(/,$/, "")).sort())) {
        tableSqlOnlyLineOrderMismatchCount += 1;
        const sourceLines = source.split("\n").map((line) => line.trim().replace(/,$/, ""));
        const targetLines = target.split("\n").map((line) => line.trim().replace(/,$/, ""));
        for (let index = 0; index < sourceLines.length; index += 1) {
          const line = sourceLines[index]!;
          if (targetLines[index] === line) continue;
          movedTableDeclarationCounts[declarationClass(line)] += 1;
        }
      }
      // Classification only, never used by the product verifier or to accept an import.
      if (source.replace(/ AUTO_INCREMENT=[0-9]+/g, "") !== target.replace(/ AUTO_INCREMENT=[0-9]+/g, "")) {
        tableSqlMismatchIgnoringAutoIncrementCount += 1;
      }
    }
    const metadataTableMismatchCounts = Object.fromEntries(Object.keys(SCHEMA_METADATA_QUERIES).map((kind) => [kind, 0])) as
      MySqlBackupSchemaDifference["metadataTableMismatchCounts"];
    for (const kind of Object.keys(SCHEMA_METADATA_QUERIES) as SchemaMetadataCategory[]) {
      for (const name of new Set([...expected.metadata[kind].keys(), ...actual.metadata[kind].keys()])) {
        if (expected.metadata[kind].get(name) !== actual.metadata[kind].get(name)) metadataTableMismatchCounts[kind] += 1;
      }
    }
    for (const [name, source] of expected.triggers) {
      const target = actual.triggers.get(name);
      if (!target) continue;
      for (const field of TRIGGER_DIAGNOSTIC_FIELDS) {
        if (canonicalJson(source[field]) !== canonicalJson(target[field])) mismatch[field] += 1;
      }
    }
    return {
      sourceTableCount: expected.tables.size, targetTableCount: actual.tables.size,
      missingTables: [...expected.tables.keys()].filter((name) => !actual.tables.has(name)).length,
      extraTables: [...actual.tables.keys()].filter((name) => !expected.tables.has(name)).length,
      tableSqlMismatchCount, tableSqlMismatchIgnoringAutoIncrementCount, tableSqlOnlyLineOrderMismatchCount,
      movedTableDeclarationCounts,
      changedTableDeclarationCounts, sourceChangedChunkTokenCounts, targetChangedChunkTokenCounts,
      tableSqlOnlyOutsideWhitespaceMismatchCount,
      redundantExplicitCharsetMismatchCount, tableSqlOnlyRedundantExplicitCharsetMismatchCount,
      addedFixedKeywordCounts, removedFixedKeywordCounts,
      sourceTriggerCount: expected.triggers.size, targetTriggerCount: actual.triggers.size,
      missingTriggers: [...expected.triggers.keys()].filter((name) => !actual.triggers.has(name)).length,
      extraTriggers: [...actual.triggers.keys()].filter((name) => !expected.triggers.has(name)).length,
      triggerFieldMismatchCounts: mismatch,
      metadataTableMismatchCounts, connectionCollationEqual: expected.connectionCollation === actual.connectionCollation,
      connectionSqlModeEqual: expected.connectionSqlMode === actual.connectionSqlMode,
    };
  }

  async setup(): Promise<void> {
    if (this.catalogBucket === this.journalBucket) throw new Error("test buckets must be distinct");
    const pathStyle = required("S3_TEST_FORCE_PATH_STYLE");
    if (pathStyle !== "0" && pathStyle !== "1") throw new Error("invalid S3 test path style");
    this.mysqlBinary = await binary("MYSQL");
    this.mysqldumpBinary = await binary("MYSQLDUMP");
    // macOS tmpdir() may start /var while its canonical path starts /private/var.
    // Keep the product's canonical protected-directory check, fix only the fixture.
    this.privateDirectory = await realpath(await mkdtemp(join(tmpdir(), "agent-service-backup-artifact-e2e-")));
    this.artifactDirectory = join(this.privateDirectory, "artifacts");
    this.keyFile = join(this.privateDirectory, "artifact-key.bin");
    await mkdir(this.artifactDirectory, { mode: 0o700 });
    await writeFile(this.keyFile, randomBytes(32), { mode: 0o600, flag: "wx" });
    this.authority = new ArtifactFixtureAuthority(this.native,this.privateDirectory,(url,run)=>this.verifyExpectedExternalPhase(url,run));
    this.admin = await this.openInspection(this.databaseUrl("mysql"));
    this.sourceUrl = await this.newDatabase();
    await this.roles().initial(this.sourceUrl);
    const store = await this.openStore(this.sourceUrl,2);
    try {
      await store.setTenantAuth(this.tenantId, DEFAULT_AUTH_POLICY);
      await store.createSession(this.session);
      const authority=await acquireFixtureSessionAuthority(store,this.session,0);
      try { await store.commit(authority.admit({
        sessionId: this.session.id, fence: 1, turn: this.turn, items: [this.item],
        usageEntries: [{
          usageId: this.usageId, turnId: this.turn.id, step: 1,
          provider: "artifact-fixture-provider", model: "artifact-fixture-model",
          usage: this.usage, createdAtMs: this.session.createdAtMs,
        }],
        events: [
          { type: "item/completed", sessionId: this.session.id,
            emittedAtMs: this.session.createdAtMs + 1, item: this.item },
          { type: "turn/completed", sessionId: this.session.id,
            emittedAtMs: this.session.createdAtMs + 1, turn: this.turn, stopReason: "end_turn" },
        ],
        sessionPatch: { usage: this.usage },
      })); } finally { await authority.release(); }
    } finally { await store.close(); }
    const activated = await this.command("activate-journal", {
      RESTORE_JOURNAL_PRIMARY_ACTIVATION_ACK: "1",
      BLOB_STORE: "filesystem",
    }, {}, true);
    if (activated.status !== 0) throw new Error("fixture_journal_activation_failed");
    const blobStore = await this.openStore(this.sourceUrl,2);
    try {
      // No Blob bytes are produced; a separate logical control enables the existing catalog.
      await blobStore.activateBlobStorageControl({
        expectedControlGeneration: 0,
        storageBackend: "s3v1-artifact-test",
        namespaceSha256: createHash("sha256").update(`artifact-blob-${this.runId}`).digest("hex"),
      });
    } finally { await blobStore.close(); }
    const catalog = await this.command("activate", { BACKUP_CATALOG_ACTIVATION_ACK: "1" });
    if (catalog.status !== 0) throw new Error("fixture_catalog_activation_failed");
  }

  acquireOperator(options:artifactOperations.MySqlBackupArtifactOperatorOptions,
    acquire:typeof artifactOperations.acquireMySqlBackupArtifactOperator=artifactOperations.acquireMySqlBackupArtifactOperator):Promise<artifactOperations.MySqlBackupArtifactOperator>{
    if(this.closing)return Promise.reject(Error("artifact_fixture_closing"));
    return this.native.factory(async()=>{
      const actual=await observeArtifactOperatorAcquisition(this.native,options,()=>acquire(options));
      this.operatorSources.set(actual,options.sourceUrl);this.issuedOperators.set(options.sourceUrl,actual);
      if(options.targetUrl)this.issuedOperators.set(options.targetUrl,actual);return actual;
    },options.operationAbortSignal);
  }
  catalogAdapter(config:Parameters<typeof createTenantBackupCatalogAdapter>[0],
    operation:Parameters<typeof createTenantBackupCatalogAdapter>[1]={},
    factory:BackupCatalogCliDependencies["createCatalogAdapter"]=createTenantBackupCatalogAdapter):TenantBackupCatalogAdapter{
    if(this.closing)throw Error("artifact_fixture_closing");
    return this.createOwnedCatalogAdapter(config,operation,factory);
  }
  private createOwnedCatalogAdapter(config:Parameters<typeof createTenantBackupCatalogAdapter>[0],
    operation:Parameters<typeof createTenantBackupCatalogAdapter>[1],
    factory:BackupCatalogCliDependencies["createCatalogAdapter"]):TenantBackupCatalogAdapter{
    if(config.options.client!==undefined)throw Error("artifact_fixture_catalog_client_unowned");
    const signal=operation?.operationAbortSignal?AbortSignal.any([this.native.signal,operation.operationAbortSignal]):this.native.signal;
    const ownedOperation={...operation,operationAbortSignal:signal};
    const scope=createArtifactFixtureS3Client({region:config.options.region,
      ...(config.options.endpoint===null?{}:{endpoint:config.options.endpoint}),forcePathStyle:config.options.forcePathStyle,
      ignoreConfiguredEndpointUrls:true,useFipsEndpoint:false,useDualstackEndpoint:false,useAccelerateEndpoint:false,
      useGlobalEndpoint:false,useArnRegion:false,disableMultiregionAccessPoints:true,followRegionRedirects:false,bucketEndpoint:false,
      maxAttempts:2,...(config.options.credentials===undefined?{}:{credentials:config.options.credentials})},signal);
    this.native.adopt(scope);return this.ownAdapter(factory({...config,options:{...config.options,client:scope.client}},ownedOperation));
  }
  journalAdapters(config:Parameters<typeof createTenantRestoreJournalAdapters>[0],
    operation:Parameters<typeof createTenantRestoreJournalAdapters>[1]={}):ReturnType<typeof createTenantRestoreJournalAdapters>{
    if(this.closing)throw Error("artifact_fixture_closing");
    const signal=operation?.operationAbortSignal?AbortSignal.any([this.native.signal,operation.operationAbortSignal]):this.native.signal;
    return createTenantRestoreJournalAdapters(config,{...operation,operationAbortSignal:signal,ownedNativeTransport:true}).map(adapter=>this.ownAdapter(adapter));
  }

  /** Success cleanup observes the actual complete external chain through a sealed GET-only
   * head. This does not create genesis, advance pending events, reserve, resolve or sign receipts. */
  private async verifyExpectedExternalPhase(url:string,restoreRunId:string):Promise<void>{
    const config=loadTenantBackupCatalogConfig(this.env(),{production:false,store:"mysql"});
    if(!config)throw Error("artifact_fixture_catalog_missing");
    const adapter=this.createOwnedCatalogAdapter(config,{operationAbortSignal:this.native.signal},createTenantBackupCatalogAdapter);
    if(!(adapter instanceof S3TenantBackupCatalogAdapter))throw Error("artifact_fixture_actual_catalog_required");
    await artifactCloseAfter(async()=>{
      const head=await adapter.readHeadForBackupSourceObservation(),events:TenantBackupCatalogAdapterEvent[]=[];
      let cursor=emptyTenantBackupCatalogHead(adapter);
      while(cursor.catalogSequence<head.catalogSequence){
        const page=await adapter.scanEvents({sealedHead:head,afterCatalogSequence:cursor.catalogSequence,
          afterCatalogEventRootSha256:cursor.catalogEventRootSha256,limit:1000});
        if(page.nextCatalogSequence<=cursor.catalogSequence||page.nextCatalogSequence>head.catalogSequence)throw Error("artifact_fixture_external_cursor_invalid");
        events.push(...page.events);cursor={...cursor,catalogSequence:page.nextCatalogSequence,catalogEventRootSha256:page.nextCatalogEventRootSha256};
      }
      if(cursor.catalogEventRootSha256!==head.catalogEventRootSha256
        ||canonicalJson(await adapter.readHeadForBackupSourceObservation())!==canonicalJson(head))throw Error("artifact_fixture_external_head_changed");
      const reserved=events.filter(event=>event.eventType==="restore_reserved"&&event.result.restoreRunId===restoreRunId);
      const reservation=reserved[0];
      if(reserved.length!==1||reservation?.eventType!=="restore_reserved")throw Error("artifact_fixture_external_reservation_missing");
      const external=reservation.result;
      const backup=events.filter(event=>event.eventType==="backup_recoverable"&&event.result.backupId===external.backupId);
      const availability=backup[0];
      if(backup.length!==1||availability?.eventType!=="backup_recoverable"||availability.result.entrySha256!==external.entrySha256)
        throw Error("artifact_fixture_external_entry_mismatch");
      const available=availability.result;
      const reader=await this.native.inspect(url);
      await artifactCloseAfter(async()=>{
        const [local]=await reader.query<RowDataPacket[]>("SELECT * FROM backup_runtime_reservations WHERE BINARY restore_run_id=BINARY ?",[restoreRunId]);
        const [bindings]=await reader.query<RowDataPacket[]>("SELECT * FROM backup_restore_source_bindings WHERE BINARY restore_run_id=BINARY ?",[restoreRunId]);
        const [runs]=await reader.query<RowDataPacket[]>("SELECT * FROM tenant_restore_replay_runs WHERE BINARY restore_run_id=BINARY ?",[restoreRunId]);
        if(local.length!==1||bindings.length!==1||runs.length!==1)throw Error("artifact_fixture_native_restore_image_missing");
        const row=local[0]!,binding=bindings[0]!,run=runs[0]!;
        const fields=[["backup_id","backupId"],["restore_run_id","restoreRunId"],["entry_sha256","entrySha256"],
          ["runtime_epoch_sha256","runtimeEpochSha256"],["reservation_operation_sha256","reservationOperationSha256"],
          ["reservation_receipt_sha256","reservationReceiptSha256"],["catalog_sequence","catalogSequence"],
          ["previous_catalog_event_root_sha256","previousCatalogEventRootSha256"],["catalog_event_root_sha256","catalogEventRootSha256"],
          ["catalog_event_sha256","catalogEventSha256"]] as const;
        for(const [column,field]of fields)if(column==="catalog_sequence"?Number(row[column])!==external[field]:row[column]!==external[field])
          throw Error("artifact_fixture_native_external_reservation_mismatch");
        if(binding.binding_sha256!==row.binding_sha256||binding.backup_id!==external.backupId
          ||binding.entry_sha256!==external.entrySha256||binding.runtime_epoch_sha256!==external.runtimeEpochSha256
          ||binding.reservation_receipt_sha256!==external.reservationReceiptSha256||run.runtime_epoch_sha256!==external.runtimeEpochSha256)
          throw Error("artifact_fixture_native_restore_binding_mismatch");
        for(const [column,field]of [["anchor_sha256","anchorSha256"],["source_snapshot_sha256","sourceSnapshotSha256"],
          ["source_backup_sha256","sourceBackupSha256"],["artifact_manifest_sha256","artifactManifestSha256"],
          ["provider_evidence_sha256","providerEvidenceSha256"]] as const)
          if(binding[column]!==available[field])throw Error("artifact_fixture_native_external_backup_mismatch");
        // A replay_sealed isolated target may retain its original reserved local image after
        // the SOURCE has explicitly aborted/resolved it. Preserve that original lifecycle.
        const resolutions=events.filter(event=>event.eventType==="restore_resolved"&&event.result.restoreRunId===restoreRunId);
        if(resolutions.length>1||resolutions.some(event=>event.eventType!=="restore_resolved"
          ||event.result.reservationReceiptSha256!==external.reservationReceiptSha256))throw Error("artifact_fixture_external_resolution_mismatch");
        if(this.authority?.phase(url)==="source-prepared"&&(row.phase!=="reserved"||resolutions.length!==0))
          throw Error("artifact_fixture_prepared_source_resolution_mismatch");
      },()=>reader.end());
    },()=>adapter.close());
  }

  private metadataEnv(url:string):Record<string,string> {
    const metadata=this.roles().metadata(url);return {MYSQL_SCHEMA_METADATA_SCHEMA:metadata.metadataSchema,
      MYSQL_SCHEMA_METADATA_DEFINER_USER:metadata.trustedDefiner.user,MYSQL_SCHEMA_METADATA_DEFINER_HOST:metadata.trustedDefiner.host};
  }
  private async commandEnv(command:string,extra:NodeJS.ProcessEnv,restoreLedger:boolean):Promise<NodeJS.ProcessEnv> {
    const env=this.env(extra),url=env.MYSQL_URL!;
    if(restoreLedger&&command==="activate-journal"){
      let binding=this.roles().staged(url);
      if(!binding){
        const config=loadTenantRestoreJournalConfig(env,{production:false,store:"mysql"});if(!config)throw Error("artifact_fixture_journal_missing");
        const adapters=this.journalAdapters(config,{operationAbortSignal:this.native.signal});
        for(const adapter of adapters)this.native.adopt(adapter);
        const input=await artifactCloseAfter(async()=>{
          const targets=config.targets.map(target=>({...target.descriptor})).sort((a,b)=>a.targetOrdinal-b.targetOrdinal);
          const observedHeads=[];
          for(const [ordinal,adapter]of adapters.entries()){
            await adapter.validateStartup();const head=await adapter.readHead(),target=targets[ordinal];if(!target)throw Error("artifact_fixture_journal_missing");
            observedHeads.push({...target,logicalDatabaseNamespaceSha256:config.logicalDatabaseNamespaceSha256,
              sealedRemoteSequence:head.remoteSequence,sealedHeadRootSha256:head.headRootSha256});
          }
          return {adapterProtocol:config.adapterProtocol,journalNamespaceSha256:config.journalNamespaceSha256,
            logicalDatabaseNamespaceSha256:config.logicalDatabaseNamespaceSha256,runtimeEpochSha256:config.runtimeEpochSha256,
            targets,observedHeads} satisfies ActivateTenantRestoreJournalControlInput;
        },async()=>{let failure:{reason:unknown}|undefined;for(const result of await Promise.allSettled(adapters.map(adapter=>adapter.close())))
          if(result.status==="rejected")failure??={reason:result.reason};if(failure)throw failure.reason;});
        binding=await this.roles().stagePrimary(url,input);
      }
      return {...env,...this.metadataEnv(url),...binding.authorityEnv,MYSQL_URL:url};
    }
    if(command==="activate-selected"){
      const target=env.BACKUP_RESTORE_TARGET_MYSQL_URL!,run=env.RESTORE_RUN_ID!;
      const binding=this.roles().staged(target)??await this.roles().stageRestore(target,run);
      return {...env,...binding.authorityEnv};
    }
    // Physical and five selected commands keep the original explicit operator endpoint.
    // Generic stopped-local prepare is a separately acknowledged actual closed source port.
    if(["create-artifact","verify-artifact","restore-selected","replay-selected","verify-selected","activate-capture-selected","resolve-selected"].includes(command)
      ||command==="prepare-restore"&&env.BACKUP_CATALOG_PREPARE_RESTORE_STOPPED_LOCAL_ACK==="1"
      ||restoreLedger&&["status","replay-fences","verify"].includes(command)&&env.RESTORE_LEDGER_REPLAY_STOPPED_LOCAL_ACK==="1")return env;
    return {...env,...this.runtimeEnv(url)};
  }

  async command(
    command: string,
    extra: NodeJS.ProcessEnv = {},
    overrides: Partial<BackupCatalogCliDependencies> = {},
    restoreLedger = false,
  ): Promise<CapturedCommand> {
    const lines: string[] = [];
    const realOperations = overrides.artifactOperations ?? artifactOperations;
    let failureDiagnostic: CapturedCommand["failureDiagnostic"];
    const observe = async <T>(stage: NonNullable<CapturedCommand["failureDiagnostic"]>["stage"],
      action: () => Promise<T>): Promise<T> => {
      try { return await action(); }
      catch (error) {
        failureDiagnostic = {
          stage,
          code: error instanceof artifactOperations.MySqlBackupArtifactError
            && ARTIFACT_ERROR_CODES.has(error.code) ? error.code : "unclassified",
        };
        if (error instanceof artifactOperations.MySqlBackupArtifactError) {
          const diagnostic: unknown = Reflect.get(error, "diagnostic");
          if (diagnostic !== null && typeof diagnostic === "object") {
            const record = diagnostic as Record<string, unknown>;
            if (typeof record.phase === "string" && IMPORT_DIAGNOSTIC_PHASES.has(record.phase)
              && typeof record.code === "string"
              && (record.code === "unclassified" || ARTIFACT_ERROR_CODES.has(record.code))) {
              failureDiagnostic.productPhase = record.phase;
              failureDiagnostic.productCode = record.code;
            }
          }
        }
        throw error;
      }
    };
    const observedOperations: NonNullable<BackupCatalogCliDependencies["artifactOperations"]> = {
      acquireMySqlBackupArtifactOperator: options=>observe("acquire",()=>this.acquireOperator(options,realOperations.acquireMySqlBackupArtifactOperator)),
      createMySqlBackupArtifact: (options) => observe("create",()=>this.native.own(realOperations.createMySqlBackupArtifact(options))),
      verifyMySqlBackupArtifact: (options) => observe("verify",()=>this.native.factory(async()=>{
        // The original actual factory receives its original options. A private key copy,
        // captured before its first await, survives the CLI zeroing a deadline-abandoned key.
        const captured={...options};if(options.tenantTelemetryRefKey){const key=Buffer.from(options.tenantTelemetryRefKey);
          this.verifiedRefKeys.add(key);captured.tenantTelemetryRefKey=key;}
        const actual=await realOperations.verifyMySqlBackupArtifact(options);this.verifiedOptions.set(actual,captured);return actual;
      },options.operationAbortSignal)),
      importVerifiedMySqlBackupArtifact: (verified,options)=>observe("import",()=>this.native.own((async()=>{
        const original=this.verifiedOptions.get(verified);if(!original)throw Error("artifact_fixture_verified_unowned");
        const expiresAt=performance.now()+options.deadlineMs;
        const result=await this.native.own(realOperations.importVerifiedMySqlBackupArtifact(verified,options));
        const remaining=Math.floor(expiresAt-performance.now());if(remaining<1)throw Error("artifact_fixture_import_deadline");
        // importer consumed/closed its original capability. Reauthenticate the SAME immutable
        // bytes/evidence under the remaining original budget, while both original locks stay held.
        const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),remaining);
        const signal=AbortSignal.any([this.native.signal,controller.signal,...(options.operationAbortSignal?[options.operationAbortSignal]:[])]);
        let fresh:artifactOperations.VerifiedMySqlBackupArtifact|undefined,failure:{reason:unknown}|undefined;
        try{
          fresh=await this.native.factory(()=>artifactOperations.verifyMySqlBackupArtifact({...original,expectedAnchor:verified.manifest.anchor,
            expectedEvidence:verified.evidence,deadlineMs:Math.max(1,Math.floor(expiresAt-performance.now())),operationAbortSignal:signal}),signal);
          if(fresh.manifest.backupId!==verified.manifest.backupId||canonicalJson(fresh.evidence)!==canonicalJson(verified.evidence))throw Error("artifact_fixture_authenticated_import_mismatch");
          await options.operator.assertHeld();await this.roles().imported(options.targetUrl,options.operator,signal);
          const sourceUrl=this.operatorSources.get(options.operator);if(!sourceUrl)throw Error("artifact_fixture_operator_source_unknown");
          this.configureRuntime(options.targetUrl,this.roles().selection(sourceUrl));
          if(original.tenantTelemetryRefKey)this.configureRuntime(options.targetUrl,{tenantTelemetryRefKey:original.tenantTelemetryRefKey});
        }catch(reason){failure={reason};}
        finally{try{await fresh?.close();}catch(reason){failure??={reason};}finally{clearTimeout(timer);}}
        if(failure)throw failure.reason;return result;
      })())),
    };
    const dependencies: BackupCatalogCliDependencies = {
      connectStore: (options) => this.connectRuntime(options),
      connectCaptureBackupSourceMaintenance: (options,profile) => this.connectCaptureBackupSourceMaintenance(options,profile),
      connectCaptureRestoreMaintenance: (options,profile) => this.connectCaptureRestoreMaintenance(options,profile),
      connectCaptureArtifactRestoreMaintenance: (options,profile) => this.connectCaptureArtifactRestoreMaintenance(options,profile),
      loadCatalogConfig: (env, context) => loadTenantBackupCatalogConfig(env, context),
      createCatalogAdapter: (config, operation) => createTenantBackupCatalogAdapter(config, operation),
      loadJournalConfig: (env, context) => loadTenantRestoreJournalConfig(env, context),
      createJournalAdapters: (config, operation) => createTenantRestoreJournalAdapters(config, operation),
      writeLine: (line) => { lines.push(line); },
      ...overrides,
      artifactOperations: observedOperations,
    };
    const catalogFactory=overrides.createCatalogAdapter??createTenantBackupCatalogAdapter;
    dependencies.createCatalogAdapter=(config,operation)=>this.catalogAdapter(config,operation,catalogFactory);
    const journalFactory=overrides.createJournalAdapters??createTenantRestoreJournalAdapters;
    dependencies.createJournalAdapters=(config,operation)=>{
      const signal=operation?.operationAbortSignal?AbortSignal.any([this.native.signal,operation.operationAbortSignal]):this.native.signal;
      const owned={...operation,operationAbortSignal:signal,ownedNativeTransport:true};return journalFactory(config,owned).map(adapter=>this.ownAdapter(adapter));
    };
    try {
      const env = await this.commandEnv(command,extra,restoreLedger);
      const status = restoreLedger
        ? await runRestoreLedgerReconcileCli([command], env, {
          connectStore: options=>this.native.factory(signal=>MysqlSessionStore.connectRestoreJournalMaintenance({url:options.url,
            connectionLimit:options.connectionLimit,operationAbortSignal:signal,
            ...(options.tenantTelemetryRefKey===undefined?{}:{tenantTelemetryRefKey:options.tenantTelemetryRefKey})},options.maintenance),options.operationAbortSignal),
          // Explicit opt-in only. Preserve the actual stopped profile and actual module facade;
          // this is not the default runtime port with a test-injected permission substitution.
          connectStoppedReplayMaintenance:(options,profile)=>this.native.factory(signal=>MysqlSessionStore.connectRestoreJournalMaintenance({
            url:options.url,connectionLimit:options.connectionLimit,operationAbortSignal:signal,
            ...(options.tenantTelemetryRefKey===undefined?{}:{tenantTelemetryRefKey:options.tenantTelemetryRefKey})},profile),options.operationAbortSignal),
          loadJournalConfig: dependencies.loadJournalConfig,
          createAdapters: dependencies.createJournalAdapters,
          writeLine: dependencies.writeLine,
        })
        : await runBackupCatalogCli([command], env, dependencies);
      if(status===0&&(command==="activate-selected"||restoreLedger&&command==="activate-journal")){
        const url=command==="activate-selected"?env.BACKUP_RESTORE_TARGET_MYSQL_URL!:extra.MYSQL_URL??this.sourceUrl;
        const binding=this.roles().staged(url);if(!binding)throw Error("artifact_fixture_confirmation_missing");await this.roles().confirmed(url,binding);
      }
      const stdout = lines.map((line) => `${line}\n`).join("");
      return { status, stdout, stderr: "", value: JSON.parse(lines.at(-1)!) as Record<string, unknown> };
    } catch (error) {
      return {
        status: 1,
        stdout: lines.map((line) => `${line}\n`).join(""),
        stderr: `${restoreLedger
          ? formatRestoreLedgerReconcileCliError(error) : formatBackupCatalogCliError(error)}\n`,
        ...(failureDiagnostic === undefined ? {} : { failureDiagnostic }),
        ...(restoreLedger ? {} : { cliFailureDiagnostic: backupCatalogCliStackDiagnostic(error) }),
      };
    }
  }

  cleanup(input:{successful:boolean}):Promise<void> {
    if(this.cleaned)return this.cleaned;
    if(!input||Object.getPrototypeOf(input)!==Object.prototype||Reflect.ownKeys(input).length!==1
      ||!Object.hasOwn(input,"successful")||typeof Object.getOwnPropertyDescriptor(input,"successful")?.value!=="boolean"
      ||!Object.getOwnPropertyDescriptor(input,"successful")?.enumerable)return Promise.reject(Error("artifact_fixture_cleanup_policy_invalid"));
    const successful=input.successful&&this.caseSignal?.aborted!==true;this.closing=true;
    return this.cleaned=(async()=>{
      let failure:{reason:unknown}|undefined,approved=false,deleted=false;
      const remember=(reason:unknown)=>{failure??={reason};};
      const failures:unknown[]=[];
      try{
        if(!this.authority)throw Error("artifact_fixture_not_prepared");
        approved=await this.authority.verifyBeforeCleanup(successful);
        if(approved){
    for (const [bucketName, prefix] of [
      [this.catalogBucket, this.catalogPrefix], [this.journalBucket, this.journalPrefix],
    ]) {
      try {
        if (!new RegExp(`^${PREFIX}/(?:catalog|journal)/[0-9a-f]{24}$`).test(prefix!)) {
          throw new Error("unsafe backup artifact cleanup prefix");
        }
        let continuationToken: string | undefined;
        do {
          const page = await this.s3.send(new ListObjectsV2Command({
            Bucket: bucketName, Prefix: `${prefix}/`, ContinuationToken: continuationToken,
          }));
          const keys = (page.Contents ?? []).map((item) => {
            if (!item.Key?.startsWith(`${prefix}/`)) throw new Error("cleanup prefix escaped");
            return { Key: item.Key };
          });
          if (keys.length) {
            const deleted = await this.s3.send(new DeleteObjectsCommand({
              Bucket: bucketName, Delete: { Objects: keys, Quiet: true },
            }));
            if (deleted.Errors?.length) throw new Error("backup artifact object cleanup failed");
          }
          continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
          if (page.IsTruncated && !continuationToken) throw new Error("missing continuation token");
        } while (continuationToken);
      } catch (error) { failures.push(error); }
    }
          if(failures.length)throw failures[0];
          // Prefix deletion's real SDK sends/bodies/sockets/DNS must settle before SQL DROP.
          await this.s3Native.close();
          await this.authority.dropKnownResources();
          const admin=await this.native.inspect(this.databaseUrl("mysql"));
          await artifactCloseAfter(async()=>{
            for(const database of this.databases){
              if(!DATABASE.test(database))throw Error("unsafe backup artifact database cleanup");
              await admin.query(`DROP DATABASE \`${database}\``);
              const [left]=await admin.query<RowDataPacket[]>("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?",[database]);
              if(left.length)throw Error("artifact_fixture_database_cleanup_incomplete");
            }
          },()=>admin.end());
          if(this.privateDirectory){
            if(!this.privateDirectory.startsWith(join(await realpath(tmpdir()),"agent-service-backup-artifact-e2e-")))throw Error("unsafe private directory cleanup");
            await rm(this.privateDirectory,{recursive:true,force:false});
          }
          deleted=true;
        }
      }catch(reason){remember(reason);}
      finally{
        for(const operation of [()=>this.s3Native.close(),()=>this.native.close(),()=>this.authority?.closeInitialHandles()])
          try{await operation();}catch(reason){remember(reason);}
        this.detachCaseSignal?.();this.detachCaseSignal=undefined;
        for(const key of this.verifiedRefKeys)key.fill(0);this.authority?.zeroKeys();
        if(!deleted)console.warn(JSON.stringify({schema:"physical-artifact-fixture-retained-v1",status:"retained_or_unknown",
          approvedBeforeCleanup:approved,roles:this.authority?.retainedLabels()??[],catalogPrefix:this.catalogPrefix,journalPrefix:this.journalPrefix,
          privateDirectory:this.privateDirectory||null}));
      }
      if(failure)throw failure.reason;
    })();
  }
}

export function loseOneCatalogResponse(
  create: BackupCatalogCliDependencies["createCatalogAdapter"],
  method: "publishAvailability" | "reserveRestore",
): BackupCatalogCliDependencies["createCatalogAdapter"] {
  let lose = true;
  return (config, operation) => {
    const real = create(config, operation);
    return new Proxy(real, {
      get(target, key) {
        if (key === method) return async (...args: unknown[]) => {
          const action = target[method] as (...input: unknown[]) => Promise<unknown>;
          const result = await action.apply(target, args);
          if (lose) { lose = false; throw new Error("fixture-private-response-loss"); }
          return result;
        };
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as TenantBackupCatalogAdapter;
  };
}

