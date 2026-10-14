import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql, { type RowDataPacket } from "mysql2/promise";
import {
  TENANT_TELEMETRY_RETAINED_SOURCE_T1_ENTRY_SCOPE,
  buildTenantTelemetryRetainedSourceT1CohortEntry,
  tenantTelemetryRetainedSourceCanonicalJson,
  tenantTelemetryRetainedSourceManagedOperationIdentitySha256,
  type TenantTelemetryRetainedSourceT1CohortEntry,
} from "../../src/tenant-telemetry-retained-source.js";
import { createMysqlOperationAbortTransport } from "../../src/mysql/operation-abort.js";

// Test-only, SELECT-only byte diagnostic. No application table or metadata row
// is read, no migration/store connection is made, and no DDL/DML is issued.
// Synthetic codec validity is not proof of DB provenance or any delete grant.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SOURCE = join(ROOT, "packages/store/migrations/0054_tenant_telemetry_retained_source.sql");
const TRIGGER = "trg_tt_retained_t1_entries_json_bi";
const BEGIN = `CREATE TRIGGER ${TRIGGER} BEFORE INSERT ON tenant_telemetry_retained_source_t1_entries FOR EACH ROW BEGIN IF (`;
const END = ") IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='retained-source JSON projection is invalid'; END IF; END;";
const LIMIT_BYTES = 1_048_576;
const EPOCH_MS = 1_791_950_984_100;
type Mode = "bound_parameters" | "actual_ddl_types" | "varchar96_probe";
const MODES: readonly Mode[] = ["bound_parameters", "actual_ddl_types", "varchar96_probe"];
export const DIAGNOSE_0054_NUMERIC_INPUTS = Object.freeze([
  { index: 1, json: "1", expectedAccepted: true },
  { index: 2, json: "1000", expectedAccepted: true },
  { index: 3, json: "2147483648", expectedAccepted: true },
  { index: 4, json: "1791950984100", expectedAccepted: true },
  { index: 5, json: "9007199254740991", expectedAccepted: true },
  { index: 6, json: "-1", expectedAccepted: false },
  { index: 7, json: "1.5", expectedAccepted: false },
  { index: 8, json: '"1000"', expectedAccepted: false },
  { index: 9, json: "null", expectedAccepted: false },
  { index: 10, json: "9007199254740992", expectedAccepted: false },
  { index: 11, json: "true", expectedAccepted: false },
  { index: 12, json: "[]", expectedAccepted: false },
  { index: 13, json: "1.0", expectedAccepted: false },
].map((value) => Object.freeze(value)));
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function invalid(): never { throw new Error("0054 read-only JSON diagnostic input or source is invalid"); }

export function parseDiagnose0054Arguments(args: readonly string[]): "diagnose" | "help" {
  if (args.length !== 1) invalid();
  if (args[0] === "--help") return "help";
  if (args[0] !== "--diagnose-readonly-0054-json") invalid();
  return "diagnose";
}
export function parseDiagnose0054BaseUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { return invalid(); }
  let database: string;
  try { database = decodeURIComponent(url.pathname.slice(1)); } catch { return invalid(); }
  if (url.protocol !== "mysql:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || url.search !== "" || url.hash !== "" || !/^agent_service_(?:migration_)?test(?:_[a-z0-9]+)*$/.test(database)
    || (url.port !== "" && (!/^[0-9]+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535))) invalid();
  return url;
}
async function boundedSqlSource(): Promise<string> {
  const file = await open(SOURCE, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > LIMIT_BYTES) invalid();
    const bytes = await file.readFile();
    const text = bytes.toString("utf8");
    if (bytes.length !== stat.size || !Buffer.from(text).equals(bytes)) invalid();
    return text;
  } finally { await file.close(); }
}
function splitTopAnd(value: string): string[] {
  let depth = 0, quote = "", begin = 0;
  const parts: string[] = [];
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
    else if (depth === 0 && value.startsWith(" AND ", index)) {
      parts.push(value.slice(begin, index).trim()); index += 4; begin = index + 1;
    }
  }
  if (depth !== 0 || quote) invalid();
  parts.push(value.slice(begin).trim());
  return parts;
}
interface Scalar { column: string; key: keyof TenantTelemetryRetainedSourceT1CohortEntry; type: string }
export interface Diagnose0054GuardPlan {
  predicates: string[]; preimage: string; scalars: Scalar[]; actionSha256: string;
  dynamicCounterInvalidCondition: string;
}
function parenthesizedSourceExpression(source: string, start: number): string {
  if (source[start] !== "(") invalid();
  let depth = 0, quote = "";
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote) {
      if (char === "\\") { index += 1; continue; }
      if (char === quote) {
        if (source[index + 1] === quote) { index += 1; continue; }
        quote = "";
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") { quote = char; continue; }
    if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0) return source.slice(start + 1, index);
  }
  return invalid();
}
export function diagnose0054DynamicCounterCondition(sql: string): string {
  const prefix = "CREATE TRIGGER trg_tt_retained_t1_receipts_source_bi ";
  const lines = sql.split("\n").filter((line) => line.startsWith(prefix));
  const group = "OR ((RIGHT(v.k,4)='DbMs' OR v.k='runtimeControlGeneration') AND (";
  if (lines.length !== 1) invalid();
  const source = lines[0]!;
  const start = source.indexOf(group);
  if (start < 0 || source.indexOf(group, start + group.length) >= 0) invalid();
  const expression = parenthesizedSourceExpression(source, start + group.length - 1);
  if (expression.length < 1 || expression.length > 4096 || expression.includes(";")
    || /\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|CALL|SET|PREPARE|EXECUTE|INTO)\b/i.test(
      expression.replace(/'(?:[^'\\]|\\.|'')*'/g, "''"))) invalid();
  for (const match of expression.matchAll(/\bNEW\.([a-z_0-9]+)/g)) if (match[1] !== "receipt_json") invalid();
  // Extract the actual source expression, including its original negative/range
  // tests. Do not rebuild a supposedly equivalent positive-IN predicate: every
  // numeric vector below is evaluated by MySQL against these exact bytes.
  return expression;
}
export function diagnose0054JsonGuardSourcePlan(sql: string): Diagnose0054GuardPlan {
  const lines = sql.split("\n").filter((line) => line.startsWith(`CREATE TRIGGER ${TRIGGER} `));
  if (lines.length !== 1 || !lines[0]!.startsWith(BEGIN) || !lines[0]!.endsWith(END)) invalid();
  const action = lines[0]!;
  const predicates = splitTopAnd(action.slice(BEGIN.length, -END.length).trim());
  if (predicates.length !== 24) invalid();
  const hash = /^BINARY NEW\.receipt_sha256=BINARY SHA2\(([\s\S]+),256\)$/.exec(predicates.at(-1)!);
  if (!hash) invalid();
  const table = /^CREATE TABLE IF NOT EXISTS tenant_telemetry_retained_source_t1_entries \(([\s\S]+?)\n\) ENGINE=/m.exec(sql);
  if (!table) invalid();
  const scalars: Scalar[] = [];
  for (const match of table[1]!.matchAll(/^  ([a-z_0-9]+) (VARCHAR\([0-9]+\)|CHAR\([0-9]+\)|BIGINT UNSIGNED|JSON)(?: COLLATE utf8mb4_0900_as_cs)? (?:NOT NULL|NULL),$/gm)) {
    if (match[1] === "receipt_json") continue;
    const key = match[1]!.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()) as Scalar["key"];
    scalars.push({ column: match[1]!, key, type: match[2]! });
  }
  if (scalars.length !== 21 || new Set(scalars.map((scalar) => scalar.key)).size !== 21) invalid();
  const allowed = new Set([...scalars.map((scalar) => scalar.column), "receipt_json"]);
  for (const predicate of predicates) {
    if (/\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|CALL|SET|PREPARE|EXECUTE|INTO)\b/i.test(
      predicate.replace(/'(?:[^'\\]|\\.|'')*'/g, "''"))) invalid();
    for (const match of predicate.matchAll(/\bNEW\.([a-z_0-9]+)/g)) if (!allowed.has(match[1]!)) invalid();
  }
  return { predicates, preimage: hash[1]!, scalars,
    actionSha256: sha(action.replaceAll(/\s/g, "").replaceAll("`", "").replaceAll("_utf8mb4", "").toLowerCase()),
    dynamicCounterInvalidCondition: diagnose0054DynamicCounterCondition(sql) };
}
export function buildDiagnose0054T1Entry(input: {
  epoch: boolean; state: "written_ack" | "pending";
}): TenantTelemetryRetainedSourceT1CohortEntry {
  if (typeof input.epoch !== "boolean" || !["written_ack", "pending"].includes(input.state)) invalid();
  const digest = (letter: string) => letter.repeat(64);
  const tenantId = "synthetic-json-guard-fixture";
  const operation = digest("a");
  return buildTenantTelemetryRetainedSourceT1CohortEntry({
    scope: TENANT_TELEMETRY_RETAINED_SOURCE_T1_ENTRY_SCOPE,
    requestId: "erase_00000000-0000-4000-8000-000000000001", tenantId, subjectGeneration: 1,
    t1ProfileSha256: digest("1"), t1FenceSha256: digest("2"),
    sourceIdentitySha256: tenantTelemetryRetainedSourceManagedOperationIdentitySha256(tenantId, operation),
    state: input.state, writeOperationSha256: operation,
    failureCommitReceiptSha256: digest("3"), sourceBindingReceiptSha256: digest("4"),
    membershipSha256: digest("5"), writeJobEvidenceSha256: digest("6"),
    reservationSha256: input.state === "pending" ? null : digest("7"),
    writeAckReceiptSha256: input.state === "pending" ? null : digest("8"),
    inventorySha256: input.state === "pending" ? null : digest("9"),
    inventoryReceiptSha256: input.state === "pending" ? null : digest("b"), payloadSha256: digest("c"),
    sourceHighWaterDbMs: input.epoch ? EPOCH_MS : 1000,
    capturedAtDbMs: input.epoch ? EPOCH_MS + 1 : 1001,
  });
}
function rowExpression(expression: string): string {
  return expression.replace(/\bNEW\.([a-z_0-9]+)/g, (_, column: string) => column === "receipt_json"
    ? "diag_json.receipt_json" : `diag_scalar.${column}`);
}
function queryFor(plan: Diagnose0054GuardPlan, entry: TenantTelemetryRetainedSourceT1CohortEntry, mode: Mode) {
  let row: string;
  let parameters: unknown[];
  if (mode === "bound_parameters") {
    row = `(SELECT ${plan.scalars.map((scalar) => `? AS ${scalar.column}`).join(",")}) AS diag_scalar`;
    parameters = plan.scalars.map((scalar) => entry[scalar.key]);
  } else {
    const columns = plan.scalars.map((scalar) => {
      const type = mode === "varchar96_probe" && scalar.type.startsWith("VARCHAR(") ? "VARCHAR(96)" : scalar.type;
      return `${scalar.column} ${type} PATH '$.${scalar.key}' ERROR ON EMPTY ERROR ON ERROR`;
    });
    row = `JSON_TABLE(CAST(? AS JSON),'$' COLUMNS(${columns.join(",")})) AS diag_scalar`;
    parameters = [JSON.stringify(entry)];
  }
  const preimage = rowExpression(plan.preimage);
  const query = `SELECT ${plan.predicates.map((predicate, index) => `(${rowExpression(predicate)}) AS c${index + 1}`).join(",")},`
    + `SHA2(${preimage},256) AS actual_hash,OCTET_LENGTH(${preimage}) AS actual_len`
    + ",JSON_TYPE(JSON_EXTRACT(diag_json.receipt_json,'$.sourceHighWaterDbMs')) AS high_water_json_type"
    + ",JSON_TYPE(JSON_EXTRACT(diag_json.receipt_json,'$.capturedAtDbMs')) AS captured_json_type"
    + ",JSON_TYPE(JSON_EXTRACT(diag_json.receipt_json,'$.subjectGeneration')) AS generation_json_type"
    + ",(JSON_TYPE(JSON_EXTRACT(diag_json.receipt_json,'$.capturedAtDbMs'))='INTEGER') AS integer_only_type"
    + ",(JSON_TYPE(JSON_EXTRACT(diag_json.receipt_json,'$.capturedAtDbMs')) IN ('INTEGER','UNSIGNED INTEGER')) AS compatible_integer_type"
    + ` FROM ${row} CROSS JOIN (SELECT CAST(? AS JSON) AS receipt_json) AS diag_json`;
  parameters.push(JSON.stringify(entry));
  if (!query.startsWith("SELECT ") || query.includes(";") || query.length > 32_768) invalid();
  return { query, parameters };
}
function bit(value: unknown): 0 | 1 | null {
  if (value === null) return null;
  if (value === 0 || value === "0") return 0;
  if (value === 1 || value === "1") return 1;
  return invalid();
}
function length(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" && !(typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value))) invalid();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 16_384) invalid();
  return number;
}
function digest(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) invalid();
  return value;
}
function jsonType(value: unknown): string {
  if (typeof value !== "string" || !["INTEGER", "UNSIGNED INTEGER", "DOUBLE", "STRING", "NULL", "BOOLEAN", "ARRAY", "OBJECT", "DECIMAL"].includes(value)) invalid();
  return value;
}
export async function diagnose0054JsonGuardFixture(rawUrl: string): Promise<Record<string, unknown>> {
  const base = parseDiagnose0054BaseUrl(rawUrl);
  const sql = await boundedSqlSource();
  const plan = diagnose0054JsonGuardSourcePlan(sql);
  const controller = new AbortController();
  const transport = createMysqlOperationAbortTransport(controller.signal);
  const timer = setTimeout(() => controller.abort(), 60_000);
  let stage = "connect-readonly", caseIndex = 0;
  const results: Record<string, unknown>[] = [];
  const numericInputs: Record<string, unknown>[] = [];
  try {
    const conn = await mysql.createConnection({ uri: base.toString(), stream: transport.stream,
      multipleStatements: false, connectTimeout: 10_000, supportBigNumbers: true, bigNumberStrings: false, timezone: "Z" });
    stage = "select-synthetic-json-matrix";
    for (const epoch of [false, true]) for (const state of ["written_ack", "pending"] as const) {
      const entry = buildDiagnose0054T1Entry({ epoch, state });
      const { receiptSha256: ignored, ...body } = entry; void ignored;
      const expectedPreimage = `${entry.scope}\0${tenantTelemetryRetainedSourceCanonicalJson(body)}`;
      for (const mode of MODES) {
        caseIndex += 1;
        const request = queryFor(plan, entry, mode);
        const [rows] = await conn.query<RowDataPacket[]>(request.query, request.parameters);
        if (rows.length !== 1) invalid();
        const checks = plan.predicates.map((predicate, index) => ({ index: index + 1,
          expressionSha256: sha(predicate), value: bit(rows[0]![`c${index + 1}`]) }));
        const actualHash = digest(rows[0]!.actual_hash), actualLength = length(rows[0]!.actual_len);
        results.push({ index: caseIndex, epoch, nullable: state === "pending", scalarMode: mode,
          checks, allConjunctsTrue: checks.every((check) => check.value === 1),
          expectedHash: entry.receiptSha256, actualHash, expectedPreimageHash: sha(expectedPreimage),
          expectedPreimageLength: Buffer.byteLength(expectedPreimage), actualPreimageLength: actualLength,
          hashMatches: actualHash === entry.receiptSha256,
          numericJsonTypes: { sourceHighWater: jsonType(rows[0]!.high_water_json_type),
            capturedAt: jsonType(rows[0]!.captured_json_type), subjectGeneration: jsonType(rows[0]!.generation_json_type) },
          capturedTypePassesIntegerOnly: bit(rows[0]!.integer_only_type),
          capturedTypePassesCompatibleInteger: bit(rows[0]!.compatible_integer_type) });
      }
    }
    stage = "select-synthetic-numeric-types";
    for (const input of DIAGNOSE_0054_NUMERIC_INPUTS) {
      caseIndex = input.index;
      const [rows] = await conn.query<RowDataPacket[]>("SELECT JSON_TYPE(diag_json.value) AS json_type,(JSON_TYPE(diag_json.value)='INTEGER') AS integer_only_type,(JSON_TYPE(diag_json.value) IN ('INTEGER','UNSIGNED INTEGER') AND JSON_EXTRACT(diag_json.value,'$') BETWEEN 0 AND 9007199254740991) AS bounded_counter FROM (SELECT CAST(? AS JSON) AS value) AS diag_json", [input.json]);
      if (rows.length !== 1) invalid();
      // Preserve raw JSON number encoding (not JSON.parse/stringify): 1.0 must
      // remain DOUBLE rather than being silently normalized into INTEGER 1.
      const nestedJson = `{"profile":{"primaryBinding":{"capturedAtDbMs":${input.json}}}}`;
      const dynamicExpression = plan.dynamicCounterInvalidCondition.replaceAll("NEW.receipt_json", "diag_json.receipt_json");
      const [dynamicRows] = await conn.query<RowDataPacket[]>(`SELECT (${dynamicExpression}) AS dynamic_invalid FROM (SELECT CAST(? AS JSON) AS receipt_json) AS diag_json CROSS JOIN (SELECT ? AS k) AS v`, [nestedJson, "capturedAtDbMs"]);
      if (dynamicRows.length !== 1) invalid();
      numericInputs.push({ index: input.index, inputSha256: sha(input.json), inputLength: Buffer.byteLength(input.json),
        jsonType: jsonType(rows[0]!.json_type), integerOnly: bit(rows[0]!.integer_only_type),
        boundedCounter: bit(rows[0]!.bounded_counter), expectedAccepted: input.expectedAccepted,
        dynamicInvalid: bit(dynamicRows[0]!.dynamic_invalid), expectedDynamicInvalid: input.expectedAccepted ? 0 : 1,
        dynamicConditionSha256: sha(plan.dynamicCounterInvalidCondition) });
    }
    return { schema: "agent-service-diagnose0054-json-guard-fixture-v1", readOnly: true, fixtureOnly: true,
      sourceSha256: sha(sql), guardActionSha256: plan.actionSha256, conjunctionCount: plan.predicates.length,
      dynamicConditionSha256: sha(plan.dynamicCounterInvalidCondition),
      matrixCaseCount: results.length, results, numericInputCount: numericInputs.length, numericInputs,
      databaseMutated: false, businessTablesRead: false,
      productionAccepted: false, success: true };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    const allowed = new Set(["ER_PARSE_ERROR", "ER_BAD_FIELD_ERROR", "ER_JSON_TABLE_ERROR_ON_FIELD"]);
    return { schema: "agent-service-diagnose0054-json-guard-fixture-v1", readOnly: true, fixtureOnly: true,
      sourceSha256: sha(sql), guardActionSha256: plan.actionSha256, success: false,
      dynamicConditionSha256: sha(plan.dynamicCounterInvalidCondition),
      failedStage: stage, failedCaseIndex: caseIndex, results, numericInputs,
      errorCode: controller.signal.aborted ? "operation_deadline"
        : typeof code === "string" && allowed.has(code) ? code : "operation_failed",
      databaseMutated: false, businessTablesRead: false, productionAccepted: false };
  } finally { clearTimeout(timer); transport.close(); }
}
async function main() {
  try {
    const command = parseDiagnose0054Arguments(process.argv.slice(2));
    if (Number(process.versions.node.split(".")[0]) !== 24) invalid();
    if (command === "help") {
      process.stdout.write("Test fixture only: diagnose0054-json-guard --diagnose-readonly-0054-json\nSELECT-only synthetic JSON matrix using a localhost MYSQL_MIGRATION_TEST_URL or MYSQL_TEST_URL test database. No business-table read, DDL, DML, store migration or control activation.\n");
      return;
    }
    const url = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL;
    if (!url) invalid();
    const proof = await diagnose0054JsonGuardFixture(url);
    process.stdout.write(`${JSON.stringify(proof)}\n`);
    if (proof.success !== true) process.exitCode = 1;
  } catch {
    process.stdout.write('{"schema":"agent-service-diagnose0054-json-guard-fixture-v1","readOnly":true,"fixtureOnly":true,"success":false,"failedStage":"input-or-source-preflight","errorCode":"operation_failed"}\n');
    process.exitCode = 1;
  }
}
const entry = process.argv[1];
if (entry && await realpath(entry).catch(() => "") === await realpath(fileURLToPath(import.meta.url))) await main();
