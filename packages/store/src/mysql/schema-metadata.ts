import type { PoolConnection } from "mysql2/promise";
import { buildSchemaMetadataProcedure, type SchemaMetadataProcedure } from "./schema-metadata-codec.js";

export interface SchemaMetadataReaderConfig {
  readonly metadataSchema: string;
  readonly trustedDefiner: Readonly<{ user: string; host: string }>;
}

export interface SchemaTriggerMetadataRow {
  readonly TRIGGER_SCHEMA: string;
  readonly TRIGGER_NAME: string;
  readonly EVENT_MANIPULATION: "INSERT" | "UPDATE" | "DELETE";
  readonly EVENT_OBJECT_TABLE: string;
  readonly ACTION_ORDER: number;
  readonly ACTION_CONDITION: null;
  readonly ACTION_STATEMENT: string;
  readonly ACTION_ORIENTATION: "ROW";
  readonly ACTION_TIMING: "BEFORE" | "AFTER";
}

export interface SchemaTriggerMetadataSnapshot {
  readonly applicationDatabase: string;
  readonly rows: readonly SchemaTriggerMetadataRow[];
}

export class SchemaMetadataReadError extends Error {
  readonly code = "schema_metadata_invalid";
  constructor() { super("Schema trigger metadata is invalid."); this.name = "SchemaMetadataReadError"; }
}

const MAX_ROWS = 16_384;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const SQL_MODE = "STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION";
const ROUTINE_FIELDS = ["ROUTINE_SCHEMA", "ROUTINE_NAME", "ROUTINE_TYPE", "ROUTINE_BODY", "IS_DETERMINISTIC",
  "SQL_DATA_ACCESS", "SECURITY_TYPE", "ROUTINE_COMMENT", "ROUTINE_DEFINITION", "DEFINER", "SQL_MODE",
  "CHARACTER_SET_CLIENT", "COLLATION_CONNECTION", "DATABASE_COLLATION"] as const;
const ROW_FIELDS = ["TRIGGER_SCHEMA", "TRIGGER_NAME", "EVENT_MANIPULATION", "EVENT_OBJECT_TABLE", "ACTION_ORDER",
  "ACTION_CONDITION", "ACTION_STATEMENT", "ACTION_ORIENTATION", "ACTION_TIMING"] as const;
const ROUTINE_SQL = `SELECT ${ROUTINE_FIELDS.join(", ")} FROM information_schema.ROUTINES
WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ? AND BINARY ROUTINE_SCHEMA = BINARY ? AND BINARY ROUTINE_NAME = BINARY ?`;
const PARAMETERS_SQL = `SELECT COUNT(*) AS parameter_count FROM information_schema.PARAMETERS
WHERE SPECIFIC_SCHEMA = ? AND SPECIFIC_NAME = ? AND BINARY SPECIFIC_SCHEMA = BINARY ? AND BINARY SPECIFIC_NAME = BINARY ?`;

function invalid(): never { throw new SchemaMetadataReadError(); }

/** Read own data descriptors, never an accessor (native mysql2 packet prototypes are allowed). */
function data(value: unknown, required: readonly string[], optional: readonly string[] = [], plain = false): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  if (plain && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value), allowed = new Set([...required, ...optional]);
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !allowed.has(key)) invalid();
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
    result[key] = descriptor.value;
  }
  for (const key of required) if (!Object.hasOwn(result, key)) invalid();
  return result;
}

function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) invalid();
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
    result.push(descriptor.value);
  }
  return result;
}

function text(value: unknown, maxBytes = MAX_JSON_BYTES): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= maxBytes
    && Buffer.from(value, "utf8").toString("utf8") === value;
}

function identifier(value: unknown): value is string {
  return text(value, 256) && value.length > 0 && [...value].length <= 64 && !value.includes("\0");
}

export function captureSchemaMetadataReaderConfig(input: SchemaMetadataReaderConfig): SchemaMetadataReaderConfig {
  const config = data(input, ["metadataSchema", "trustedDefiner"], [], true);
  const definer = data(config.trustedDefiner, ["user", "host"], [], true);
  if (typeof config.metadataSchema !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(config.metadataSchema)
    || !text(definer.user, 128) || [...definer.user].length < 1 || [...definer.user].length > 32
    || !text(definer.host, 1020) || [...definer.host].length < 1 || [...definer.host].length > 255
    || /[\u0000-\u001f\u007f@]/.test(definer.user) || /[\u0000-\u001f\u007f@]/.test(definer.host)) invalid();
  return Object.freeze({ metadataSchema: config.metadataSchema,
    trustedDefiner: Object.freeze({ user: definer.user, host: definer.host }) });
}

async function database(conn: Pick<PoolConnection, "query">): Promise<string> {
  const [result] = await conn.query("SELECT DATABASE() AS application_database");
  const rows = array(result, 1);
  if (rows.length !== 1) invalid();
  const row = data(rows[0], ["application_database"]);
  if (!text(row.application_database, 256)) invalid();
  return row.application_database;
}

async function verifyProcedure(conn: Pick<PoolConnection, "query">, procedure: SchemaMetadataProcedure,
  config: SchemaMetadataReaderConfig): Promise<void> {
  const parameters = [procedure.metadataSchema, procedure.routineName, procedure.metadataSchema, procedure.routineName];
  const [result] = await conn.query(ROUTINE_SQL, parameters);
  const rows = array(result, 1);
  if (rows.length !== 1) invalid();
  const actual = data(rows[0], ROUTINE_FIELDS);
  const expected = { ...procedure.expectedAttributes, ROUTINE_DEFINITION: procedure.expectedDefinition,
    DEFINER: `${config.trustedDefiner.user}@${config.trustedDefiner.host}`, SQL_MODE,
    CHARACTER_SET_CLIENT: "utf8mb4", COLLATION_CONNECTION: "utf8mb4_0900_ai_ci", DATABASE_COLLATION: "utf8mb4_0900_ai_ci" };
  for (const [key, value] of Object.entries(expected)) if (actual[key] !== value) invalid();
  const [parameterResult] = await conn.query(PARAMETERS_SQL, parameters);
  const parameterRows = array(parameterResult, 1);
  if (parameterRows.length !== 1) invalid();
  const count = data(parameterRows[0], ["parameter_count"]).parameter_count;
  if (count !== 0 && count !== "0") invalid();
}

/** Internal installer seam: actualApplicationDatabase must come from this connection's SELECT DATABASE(). No CALL. */
export async function verifySchemaMetadataProcedureIdentity(conn: Pick<PoolConnection, "query">,
  actualApplicationDatabase: string, input: SchemaMetadataReaderConfig): Promise<void> {
  try {
    const config = captureSchemaMetadataReaderConfig(input);
    await verifyProcedure(conn, buildSchemaMetadataProcedure(actualApplicationDatabase, config.metadataSchema), config);
  } catch {
    throw new SchemaMetadataReadError();
  }
}

function sessionChanges(value: unknown): void {
  const changes = data(value, ["systemVariables", "schema", "gtids", "trackStateChange"]);
  const variables = changes.systemVariables;
  if (variables === null || typeof variables !== "object" || Array.isArray(variables)) invalid();
  const keys = Reflect.ownKeys(variables);
  if (keys.some(key => typeof key !== "string")) invalid();
  const entries = data(variables, keys as string[]);
  for (const [key, item] of Object.entries(entries)) if (!text(key) || !text(item)) invalid();
  if (changes.schema !== null && !text(changes.schema) || changes.trackStateChange !== null && !text(changes.trackStateChange)) invalid();
  const gtids = array(changes.gtids, MAX_ROWS);
  for (const gtid of gtids) if (!text(gtid)) invalid();
  const copy = { systemVariables: entries, schema: changes.schema, gtids, trackStateChange: changes.trackStateChange };
  if (Buffer.byteLength(JSON.stringify(copy), "utf8") > MAX_JSON_BYTES) invalid();
}

/** No instanceof: the native packet may come from another compatible mysql2 version. */
function terminalHeader(value: unknown): void {
  const header = data(value, ["fieldCount", "affectedRows", "insertId", "info", "serverStatus", "warningStatus"],
    ["changedRows", "stateChanges"]);
  if (header.fieldCount !== 0 || header.affectedRows !== 0 || header.insertId !== 0 || header.info !== ""
    || header.warningStatus !== 0 || Object.hasOwn(header, "changedRows") && header.changedRows !== 0
    || typeof header.serverStatus !== "number" || !Number.isSafeInteger(header.serverStatus)
    || header.serverStatus < 0 || header.serverStatus > 65_535 || (header.serverStatus & (8 | 4096)) !== 0) invalid();
  // Session tracking is connection-local protocol metadata, never an authorization input.
  if (Object.hasOwn(header, "stateChanges")) sessionChanges(header.stateChanges);
}

function triggerRows(value: unknown, actualDatabase: string): readonly SchemaTriggerMetadataRow[] {
  const input = array(value, MAX_ROWS), rows: SchemaTriggerMetadataRow[] = [], names = new Set<string>();
  let jsonBytes = 2;
  for (const candidate of input) {
    const row = data(candidate, ROW_FIELDS);
    if (row.TRIGGER_SCHEMA !== actualDatabase || !identifier(row.TRIGGER_NAME) || names.has(row.TRIGGER_NAME)
      || !identifier(row.EVENT_OBJECT_TABLE) || row.EVENT_MANIPULATION !== "INSERT" && row.EVENT_MANIPULATION !== "UPDATE" && row.EVENT_MANIPULATION !== "DELETE"
      || typeof row.ACTION_ORDER !== "number" || !Number.isInteger(row.ACTION_ORDER) || row.ACTION_ORDER < 1 || row.ACTION_ORDER > 4_294_967_295
      || row.ACTION_CONDITION !== null || !text(row.ACTION_STATEMENT) || row.ACTION_ORIENTATION !== "ROW"
      || row.ACTION_TIMING !== "BEFORE" && row.ACTION_TIMING !== "AFTER") invalid();
    const copy: SchemaTriggerMetadataRow = Object.freeze({ TRIGGER_SCHEMA: actualDatabase, TRIGGER_NAME: row.TRIGGER_NAME,
      EVENT_MANIPULATION: row.EVENT_MANIPULATION, EVENT_OBJECT_TABLE: row.EVENT_OBJECT_TABLE, ACTION_ORDER: row.ACTION_ORDER,
      ACTION_CONDITION: null, ACTION_STATEMENT: row.ACTION_STATEMENT, ACTION_ORIENTATION: "ROW", ACTION_TIMING: row.ACTION_TIMING });
    jsonBytes += Buffer.byteLength(JSON.stringify(copy), "utf8") + (rows.length ? 1 : 0);
    if (jsonBytes > MAX_JSON_BYTES) invalid();
    names.add(copy.TRIGGER_NAME); rows.push(copy);
  }
  return Object.freeze(rows);
}

/**
 * A fresh, read-only view through a separately installed, exactly pinned DEFINER procedure.
 * The caller owns the connection and native cancellation/settlement; no pool/cache or DDL is created.
 * Bounds apply after mysql2 has allocated the result, not as a wire/preallocation guarantee.
 * Before/after checks detect ordinary drift, not privileged change-and-restore (ABA) attacks.
 */
export async function readSchemaTriggerMetadata(conn: Pick<PoolConnection, "query">,
  input: SchemaMetadataReaderConfig): Promise<SchemaTriggerMetadataSnapshot> {
  try {
    const config = captureSchemaMetadataReaderConfig(input), actualDatabase = await database(conn);
    const procedure = buildSchemaMetadataProcedure(actualDatabase, config.metadataSchema);
    await verifyProcedure(conn, procedure, config);
    const [result] = await conn.query(procedure.callSql);
    const sets = array(result, 2);
    if (sets.length !== 2) invalid();
    terminalHeader(sets[1]);
    const rows = triggerRows(sets[0], actualDatabase);
    if (await database(conn) !== actualDatabase) invalid();
    await verifyProcedure(conn, procedure, config);
    return Object.freeze({ applicationDatabase: actualDatabase, rows });
  } catch {
    // No SQL, driver cause, account, path, definition, or row contents leave this boundary.
    throw new SchemaMetadataReadError();
  }
}
