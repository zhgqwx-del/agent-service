import { constants } from "node:fs";
import { mkdtemp, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { MysqlSessionStore } from "../../src/index.js";
import { createMysqlOperationAbortTransport } from "../../src/mysql/operation-abort.js";

// FIXTURE ONLY. This is not a migration/repair CLI or runtime authorization.
// It installs no business source, activates nothing, performs no content/object
// DELETE, and never writes the 0054 marker. Only a fresh, self-created local test
// database can receive the reviewed draft DDL. Runtime still rejects zero hashes.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const MIGRATIONS = join(ROOT, "packages/store/migrations");
const NAME = "0054_tenant_telemetry_retained_source.sql";
const DATABASE_PATTERN = /^agent_service_derive0054_test_[0-9]+_[0-9a-f]{20}$/;
const SOURCE_BYTES_LIMIT = 4 * 1024 * 1024;
const OPERATION_MS = 180_000;
const CLEANUP_MS = 15_000;
const FP_BUDGET = 1_048_576;
const PREFIX = "agent-service-runtime-fingerprint:tenant-telemetry-retained-source";
const NEW_TABLES = ["t1_entries", "t1_receipts", "catalog_sources", "catalog_targets", "catalog_receipts",
  "usage_entries", "usage_receipts", "canonical_entries", "canonical_receipts"]
  .map((suffix) => `tenant_telemetry_retained_source_${suffix}`);
const ROTATIONS = ["trg_tt_plan_artifact_target_t3d_terminal_bu", "trg_tt_capture_v2_t3d_bu",
  "trg_tt_capture_v2_t3f_bu", "trg_tt_capture_v2_usage_bd"];
const BOOTSTRAPS = ["t3d_catalog", "t3d_capture", "t3f_capture", "usage_delete"]
  .flatMap((kind) => ["a", "b"].map((suffix) => `trg_tt_retained_${kind}_bootstrap_${suffix}`));

const SPLITTER_SOURCE = `function mysqlMigrationStatements(sql: string): string[] {
  return sql.replace(/^\\s*--.*$/gm, "")
    .split(/;\\s*\\n/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}`;
// Intentionally byte-equivalent to the formal executor above. The source check
// fails closed if that contract changes; no eval/private production export.
function mysqlMigrationStatements(sql: string): string[] {
  return sql.replace(/^\s*--.*$/gm, "")
    .split(/;\s*\n/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}
function invalid(): never { throw new Error("derive0054 fixture input or source is invalid"); }
export function derive0054DatabaseName(pid: number, randomHex: string): string {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2_147_483_647 || !/^[0-9a-f]{32}$/.test(randomHex)) invalid();
  // MySQL identifiers are limited to 64 characters. Keep 80 random bits even
  // with the largest supported PID, and retain an exact cleanup allowlist.
  const name = `agent_service_derive0054_test_${pid}_${randomHex.slice(0, 20)}`;
  if (name.length > 64 || !DATABASE_PATTERN.test(name)) invalid();
  return name;
}
export function parseDerive0054Arguments(args: readonly string[]): "derive" | "help" {
  if (args.length !== 1) invalid();
  if (args[0] === "--help") return "help";
  if (args[0] !== "--derive-isolated-0054") invalid();
  return "derive";
}
export function parseDerive0054BaseUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { return invalid(); }
  let database: string;
  try { database = decodeURIComponent(url.pathname.slice(1)); } catch { return invalid(); }
  if (url.protocol !== "mysql:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || url.search !== "" || url.hash !== "" || !/^agent_service_(?:migration_)?test(?:_[a-z0-9]+)*$/.test(database)
    || (url.port !== "" && (!/^[0-9]+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535))) invalid();
  return url;
}
function databaseUrl(base: URL, database: string): string {
  if (database !== "mysql" && !DATABASE_PATTERN.test(database)) invalid();
  const url = new URL(base); url.pathname = `/${database}`; return url.toString();
}
async function boundedSource(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > SOURCE_BYTES_LIMIT) invalid();
    const value = await file.readFile();
    if (value.length !== stat.size || value.length > SOURCE_BYTES_LIMIT) invalid();
    return value;
  } finally { await file.close(); }
}
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
function safeCount(value: unknown): number {
  if (typeof value !== "number" && !(typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value))) invalid();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) invalid();
  return number;
}
function normalizedAction(value: string): string {
  return value.replaceAll(/\s/g, "").replaceAll("`", "").replaceAll("_utf8mb4", "").toLowerCase();
}

// Small bounded scanner for the reviewed fingerprint grammar only. It does not
// parse arbitrary SQL or alter the actual installation statements.
function topLevelParts(value: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0, quote = "", begin = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quote) {
      if (char === "\\") { index += 1; continue; }
      if (char === quote) {
        if (value[index + 1] === quote) { index += 1; continue; }
        quote = "";
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") { quote = char; continue; }
    if (char === "(") depth += 1;
    else if (char === ")") { depth -= 1; if (depth < 0) invalid(); }
    else if (depth === 0 && value.startsWith(separator, index)) {
      parts.push(value.slice(begin, index).trim());
      index += separator.length - 1; begin = index + 1;
    }
  }
  if (depth !== 0 || quote) invalid();
  parts.push(value.slice(begin).trim());
  return parts;
}
interface Metric { expression: string; comparator: "=" | "<="; expected: number; hash: boolean }
interface QueryProjection { query: string; metrics: Metric[] }
function metadataQuery(select: string): QueryProjection {
  const from = topLevelParts(select, " FROM ");
  if (from.length !== 2 || !from[0]!.startsWith("SELECT ")
    || !/^information_schema\.(?:tables|columns|statistics|check_constraints|table_constraints|referential_constraints|key_column_usage|partitions|triggers) WHERE /i.test(from[1]!)) invalid();
  const projections = topLevelParts(from[0]!.slice(7), " AND ");
  const metrics = projections.map((projection): Metric => {
    const hash = /^(SHA2\([\s\S]+\))='[0-9a-f]{64}'$/.exec(projection);
    if (hash) return { expression: hash[1]!, comparator: "=", expected: 0, hash: true };
    const numeric = /^([\s\S]+?)(<=|=)([0-9]+|@@SESSION\.group_concat_max_len)$/.exec(projection);
    if (!numeric || !/^(?:COUNT\(|SUM\()/i.test(numeric[1]!)) invalid();
    return { expression: numeric[1]!, comparator: numeric[2] as "=" | "<=",
      expected: numeric[3] === "@@SESSION.group_concat_max_len" ? FP_BUDGET : safeCount(numeric[3]), hash: false };
  });
  if (metrics.length < 1 || metrics.filter((metric) => metric.hash).length > 1) invalid();
  return { query: `SELECT ${metrics.map((metric, index) => `${metric.expression} AS v${index}`).join(",")} FROM ${from[1]}`, metrics };
}
function fingerprintBlock(sql: string, kind: "schema" | "triggers"): { begin: number; end: number; statement: string } {
  const startMarker = `-- ${PREFIX}-${kind}:start`, endMarker = `-- ${PREFIX}-${kind}:end`;
  const begin = sql.indexOf(startMarker), end = sql.indexOf(endMarker);
  if (begin < 0 || end <= begin || sql.indexOf(startMarker, begin + startMarker.length) >= 0
    || sql.indexOf(endMarker, end + endMarker.length) >= 0) invalid();
  const statements = mysqlMigrationStatements(sql.slice(begin + startMarker.length, end));
  if (statements.length !== 1 || !statements[0]!.startsWith(`SET @tt_retained_source_${kind}_ok=(`)
    || !statements[0]!.endsWith(")")) invalid();
  return { begin, end: end + endMarker.length, statement: statements[0]! };
}
export function derive0054SourcePlan(sql: string): {
  install: string[]; schema: QueryProjection[]; triggers: QueryProjection;
} {
  const schema = fingerprintBlock(sql, "schema"), triggers = fingerprintBlock(sql, "triggers");
  if (schema.end >= triggers.begin) invalid();
  const sessionStart = sql.lastIndexOf("SET @tt_retained_source_previous_group_concat_max_len=@@SESSION.group_concat_max_len;", schema.begin);
  if (sessionStart < 0) invalid();
  const install = mysqlMigrationStatements(sql.slice(0, sessionStart));
  if (install.length < 1 || install.length > 200) invalid();
  const creates = new Set<string>();
  const tables = new Set<string>();
  let alters = 0, probes = 0;
  for (const statement of install) {
    if (/^ALTER TABLE (?:tenant_erasure_admissions|tenant_purge_plan_jobs) ADD COLUMN telemetry_retained_source_protocol\n/.test(statement)) { alters += 1; continue; }
    const table = /^CREATE TABLE IF NOT EXISTS (\w+) \(/.exec(statement);
    if (table) { if (!NEW_TABLES.includes(table[1]!) || tables.has(table[1]!)) invalid(); tables.add(table[1]!); continue; }
    if (/^SELECT [a-z0-9_,]+ FROM tenant_telemetry_retained_source_\w+\n\s+FORCE INDEX \([a-zA-Z0-9_,]+\) WHERE 1=0$/.test(statement)) { probes += 1; continue; }
    const trigger = /^CREATE TRIGGER (\w+) BEFORE (INSERT|UPDATE|DELETE) ON (\w+) FOR EACH ROW [\s\S]+$/.exec(statement);
    if (trigger) {
      if ((!trigger[1]!.startsWith("trg_tt_retained_") && !ROTATIONS.includes(trigger[1]!)) || creates.has(trigger[1]!)) invalid();
      creates.add(trigger[1]!); continue;
    }
    const drop = /^DROP TRIGGER (?:IF EXISTS )?(\w+)$/.exec(statement);
    if (!drop || (!drop[1]!.startsWith("trg_tt_retained_") && !ROTATIONS.includes(drop[1]!))) invalid();
  }
  if (alters !== 2 || tables.size !== 9 || probes !== 9 || creates.size !== 62
    || ROTATIONS.some((name) => !creates.has(name)) || BOOTSTRAPS.some((name) => !creates.has(name))) invalid();
  const schemaExpression = schema.statement.slice("SET @tt_retained_source_schema_ok=(".length, -1).trim();
  const schemaSelects = topLevelParts(schemaExpression.replaceAll(/\s+AND\s+/g, " AND "), " AND ");
  const schemaQueries = schemaSelects.map((expression) => {
    if (!expression.startsWith("(SELECT ") || !expression.endsWith(")")) invalid();
    return metadataQuery(expression.slice(1, -1).replaceAll(/\s+FROM\s+/g, " FROM ").replaceAll(/\s+AND\s+/g, " AND "));
  });
  const triggerQuery = metadataQuery(triggers.statement.slice("SET @tt_retained_source_triggers_ok=(".length, -1)
    .trim().replaceAll(/\s+FROM\s+/g, " FROM ").replaceAll(/\s+AND\s+/g, " AND "));
  if (schemaQueries.length !== 9 || schemaQueries.filter((query) => query.metrics.some((metric) => metric.hash)).length !== 7
    || triggerQuery.metrics.length !== 6 || !triggerQuery.metrics.at(-1)?.hash) invalid();
  return { install, schema: schemaQueries, triggers: triggerQuery };
}

async function directConnection(base: URL, database: string, signal: AbortSignal) {
  const transport = createMysqlOperationAbortTransport(signal);
  try {
    const connection = await mysql.createConnection({ uri: databaseUrl(base, database), stream: transport.stream,
      connectTimeout: 10_000, supportBigNumbers: true, bigNumberStrings: false,
      multipleStatements: false, timezone: "Z" });
    return { connection, close: () => transport.close() };
  } catch (error) { transport.close(); throw error; }
}
interface Observation { counts: number[]; expectedCounts: number[]; shapeMatched: boolean; sha256: string | null }
async function observe(conn: Connection, projection: QueryProjection): Promise<Observation> {
  const [rows] = await conn.query<RowDataPacket[]>(projection.query);
  // Warnings belong to the immediately preceding statement. A final check after
  // all projections would miss an earlier GROUP_CONCAT truncation once the next
  // successful query replaces its diagnostics.
  const [warnings] = await conn.query<RowDataPacket[]>("SHOW WARNINGS");
  if (warnings.length !== 0) invalid();
  if (rows.length !== 1) invalid();
  const counts: number[] = [], expectedCounts: number[] = [];
  let shapeMatched = true, digest: string | null = null;
  for (const [index, metric] of projection.metrics.entries()) {
    const value: unknown = rows[0]![`v${index}`];
    if (metric.hash) { if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value) || /^0{64}$/.test(value)) invalid(); digest = value; }
    else {
      const count = safeCount(value); counts.push(count); expectedCounts.push(metric.expected);
      shapeMatched &&= metric.comparator === "=" ? count === metric.expected : count <= metric.expected;
    }
  }
  return { counts, expectedCounts, shapeMatched, sha256: digest };
}
async function assertEmptyInactive(conn: Connection) {
  for (const table of ["sessions", "turns", "items", "events", "usage_ledger", "billing_usage_facts", "tenants",
    "tenant_erasure_admissions", "tenant_telemetry_write_jobs", "tenant_telemetry_capture_v2_source_bindings",
    "tenant_telemetry_capture_v2_failure_commit_receipts"]) {
    const [rows] = await conn.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${table}`);
    if (safeCount(rows[0]?.n) !== 0) invalid();
  }
  for (const table of ["tenant_telemetry_capture_v2_controls", "tenant_telemetry_application_domain_controls"]) {
    const [rows] = await conn.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${table} WHERE state<>'inactive' OR control_generation<>0`);
    if (safeCount(rows[0]?.n) !== 0) invalid();
  }
  const [controls] = await conn.query<RowDataPacket[]>("SELECT (SELECT COUNT(*) FROM tenant_telemetry_lifecycle_control WHERE control_generation<>0)+(SELECT COUNT(*) FROM tenant_restore_journal_control WHERE control_generation<>0)+(SELECT COUNT(*) FROM tenant_restore_runtime_control WHERE state<>'inactive' OR control_generation<>0)+(SELECT COUNT(*) FROM tenant_telemetry_disposition_control WHERE state<>'inactive' OR control_generation<>0) AS n");
  if (safeCount(controls[0]?.n) !== 0) invalid();
}
async function baselineMarkers(conn: Connection, names: readonly string[]) {
  const [markers] = await conn.query<RowDataPacket[]>("SELECT name FROM schema_migrations ORDER BY name");
  if (JSON.stringify(markers.map((row) => row.name)) !== JSON.stringify(names)) invalid();
}
async function executeInstall(conn: Connection, statement: string) {
  const trigger = /^CREATE TRIGGER (\w+) BEFORE (INSERT|UPDATE|DELETE) ON (\w+) FOR EACH ROW ([\s\S]+)$/.exec(statement);
  if (trigger && BOOTSTRAPS.includes(trigger[1]!)) {
    const [rows] = await conn.query<RowDataPacket[]>("SELECT event_object_table,action_timing,event_manipulation,action_orientation,action_condition,action_statement FROM information_schema.triggers WHERE trigger_schema=DATABASE() AND BINARY trigger_name=BINARY ?", [trigger[1]]);
    if (rows.length) {
      if (rows.length !== 1 || rows[0]?.event_object_table !== trigger[3] || rows[0]?.action_timing !== "BEFORE"
        || rows[0]?.event_manipulation !== trigger[2] || rows[0]?.action_orientation !== "ROW" || rows[0]?.action_condition !== null
        || normalizedAction(String(rows[0]?.action_statement)) !== normalizedAction(trigger[4]!)) invalid();
      return;
    }
  }
  await conn.query(statement);
}
function closedDatabaseCode(error: unknown): string {
  const allowed = new Set(["ER_PARSE_ERROR", "ER_BAD_FIELD_ERROR", "ER_NO_SUCH_TABLE", "ER_TRG_ALREADY_EXISTS", "ER_TOO_LONG_IDENT",
    "ER_SIGNAL_EXCEPTION", "ER_CANT_UPDATE_USED_TABLE", "ER_CHECK_CONSTRAINT_VIOLATED", "ER_LOCK_WAIT_TIMEOUT", "ER_LOCK_DEADLOCK"]);
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  return typeof code === "string" && allowed.has(code) ? code : "operation_failed";
}
export async function derive0054FingerprintFixture(rawUrl: string): Promise<Record<string, unknown>> {
  const base = parseDerive0054BaseUrl(rawUrl);
  let stage = "source-preflight", ordinal = 0;
  let owned = false, dropped = false, temp: string | undefined;
  let cleanupDatabaseFailed = false, cleanupDirectoryFailed = false;
  let admin: Awaited<ReturnType<typeof directConnection>> | undefined;
  let target: Awaited<ReturnType<typeof directConnection>> | undefined;
  let store: MysqlSessionStore | undefined;
  let proof: Record<string, unknown> | undefined;
  let failure: unknown;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPERATION_MS);
  const database = derive0054DatabaseName(process.pid, randomUUID().replaceAll("-", ""));
  try {
    if (!DATABASE_PATTERN.test(database)) invalid();
    const sqlBytes = await boundedSource(join(MIGRATIONS, NAME));
    const sql = sqlBytes.toString("utf8");
    if (!Buffer.from(sql).equals(sqlBytes)) invalid();
    const plan = derive0054SourcePlan(sql);
    const executor = (await boundedSource(join(ROOT, "packages/store/src/mysql/store.ts"))).toString("utf8");
    if (executor.indexOf(SPLITTER_SOURCE) < 0 || executor.indexOf(SPLITTER_SOURCE) !== executor.lastIndexOf(SPLITTER_SOURCE)) invalid();
    const names = (await readdir(MIGRATIONS)).filter((name) => /^00\d\d_[a-z0-9_]+\.sql$/.test(name) && Number(name.slice(0, 4)) <= 53).sort();
    if (names.at(-1) !== "0053_persisted_provider_failure_capture.sql") invalid();
    const sources = await Promise.all(names.map(async (name) => ({ name, bytes: await boundedSource(join(MIGRATIONS, name)) })));
    temp = await mkdtemp(join(tmpdir(), "agent-service-derive0054-"));
    for (const source of sources) await writeFile(join(temp, source.name), source.bytes, { flag: "wx", mode: 0o600 });
    stage = "create-isolated-database";
    admin = await directConnection(base, "mysql", controller.signal);
    const [existing] = await admin.connection.query<RowDataPacket[]>("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", [database]);
    if (existing.length !== 0) invalid();
    await admin.connection.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    owned = true; // Only a successfully acknowledged CREATE is eligible for cleanup.
    stage = "baseline-0053-apply";
    const url = databaseUrl(base, database);
    store = await MysqlSessionStore.connect({ url, migrationsDir: temp, operationAbortSignal: controller.signal });
    await store.close(); store = undefined;
    stage = "baseline-0053-verify";
    store = await MysqlSessionStore.connect({ url, migrationsDir: temp, migrationMode: "verify", operationAbortSignal: controller.signal });
    await store.close(); store = undefined;
    target = await directConnection(base, database, controller.signal);
    await baselineMarkers(target.connection, names); await assertEmptyInactive(target.connection);
    const [oldTriggers] = await target.connection.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM information_schema.triggers WHERE trigger_schema=DATABASE()");
    if (safeCount(oldTriggers[0]?.n) !== 662) invalid();
    stage = "install-reviewed-0054-ddl";
    await target.connection.query("SET SESSION group_concat_max_len=1048576");
    for (const [index, statement] of plan.install.entries()) {
      ordinal = index + 1;
      if (controller.signal.aborted) throw new Error("fixture operation aborted");
      await executeInstall(target.connection, statement);
    }
    ordinal = 0; stage = "observe-actual-metadata";
    const schema = [];
    for (const projection of plan.schema) schema.push(await observe(target.connection, projection));
    const triggers = await observe(target.connection, plan.triggers);
    const [warnings] = await target.connection.query<RowDataPacket[]>("SHOW WARNINGS");
    if (warnings.length !== 0) invalid();
    stage = "verify-no-marker-or-activation";
    await baselineMarkers(target.connection, names); await assertEmptyInactive(target.connection);
    for (const table of NEW_TABLES) {
      const [rows] = await target.connection.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${table}`);
      if (safeCount(rows[0]?.n) !== 0) invalid();
    }
    proof = { schema: "agent-service-derive0054-fingerprint-fixture-v1", fixtureOnly: true,
      migration: NAME, migrationSourceSha256: sha(sqlBytes),
      predecessorMigrationRootSha256: sha(JSON.stringify(sources.map((source) => [source.name, sha(source.bytes)]))),
      predecessorMarkerCount: names.length, predecessorTriggerCount: 662, installedStatementCount: plan.install.length,
      schemaComponents: schema, fullTriggers: triggers,
      shapeMatched: schema.every((component) => component.shapeMatched) && triggers.shapeMatched,
      migrationMarkerCreated: false, businessSourceCreated: false, controlsActivated: false,
      contentDeleteExecuted: false, externalDispositionExecuted: false, productionAccepted: false };
    if (proof.shapeMatched !== true) { stage = "metadata-shape-mismatch"; failure = new Error("metadata shape differs"); }
  } catch (error) { failure = error; }
  finally {
    await store?.close().catch(() => {});
    target?.close(); admin?.close(); clearTimeout(timer);
    if (owned) {
      const cleanup = new AbortController(); const cleanupTimer = setTimeout(() => cleanup.abort(), CLEANUP_MS);
      let cleanupConnection: Awaited<ReturnType<typeof directConnection>> | undefined;
      try {
        if (!DATABASE_PATTERN.test(database)) invalid();
        cleanupConnection = await directConnection(base, "mysql", cleanup.signal);
        await cleanupConnection.connection.query(`DROP DATABASE \`${database}\``); dropped = true;
      } catch (error) {
        cleanupDatabaseFailed = true;
        if (failure === undefined) { failure = error; stage = "cleanup-self-created-database"; }
      }
      finally { clearTimeout(cleanupTimer); cleanupConnection?.close(); }
    }
    if (temp) {
      try { await rm(temp, { recursive: true, force: true }); }
      catch (error) {
        cleanupDirectoryFailed = true;
        if (failure === undefined) { failure = error; stage = "cleanup-self-created-directory"; }
      }
    }
  }
  return { ...(proof ?? { schema: "agent-service-derive0054-fingerprint-fixture-v1", fixtureOnly: true }),
    success: failure === undefined && dropped, selfCreatedDatabaseAcknowledged: owned, selfCreatedDatabaseDropped: dropped,
    cleanupDatabaseFailed, cleanupDirectoryFailed,
    ...(failure === undefined ? {} : { failedStage: stage, failedStatementOrdinal: ordinal,
      errorCode: controller.signal.aborted ? "operation_deadline" : closedDatabaseCode(failure) }) };
}
async function main() {
  try {
    const command = parseDerive0054Arguments(process.argv.slice(2));
    if (Number(process.versions.node.split(".")[0]) !== 24) invalid();
    if (command === "help") {
      process.stdout.write("Fixture only: derive0054-fingerprint --derive-isolated-0054\nUses only a local MYSQL_MIGRATION_TEST_URL or MYSQL_TEST_URL test base. Creates and removes its own random isolated database; never writes the 0054 marker or activates controls.\n");
      return;
    }
    const rawUrl = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL;
    if (!rawUrl) invalid();
    const proof = await derive0054FingerprintFixture(rawUrl);
    process.stdout.write(`${JSON.stringify(proof)}\n`);
    if (proof.success !== true) process.exitCode = 1;
  } catch {
    process.stdout.write('{"schema":"agent-service-derive0054-fingerprint-fixture-v1","fixtureOnly":true,"success":false,"failedStage":"input-or-source-preflight","errorCode":"operation_failed"}\n');
    process.exitCode = 1;
  }
}
const entry = process.argv[1];
if (entry && await realpath(entry).catch(() => "") === await realpath(fileURLToPath(import.meta.url))) await main();
