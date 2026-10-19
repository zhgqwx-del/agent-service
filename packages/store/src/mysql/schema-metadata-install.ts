import type { PoolConnection } from "mysql2/promise";
import { buildSchemaMetadataProcedure } from "./schema-metadata-codec.js";
import { captureSchemaMetadataReaderConfig, verifySchemaMetadataProcedureIdentity, type SchemaMetadataReaderConfig } from "./schema-metadata.js";

export class SchemaMetadataInstallError extends Error {
  readonly code = "schema_metadata_install_failed";
  constructor() { super("Schema metadata procedure installation failed."); this.name = "SchemaMetadataInstallError"; }
}

const SQL_MODE = "STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION";
const SESSION_SQL = `SELECT @@SESSION.sql_mode AS sql_mode, @@SESSION.character_set_client AS character_set_client,
@@SESSION.character_set_results AS character_set_results, @@SESSION.character_set_connection AS character_set_connection,
@@SESSION.collation_connection AS collation_connection`;
const SESSION_FIELDS = ["sql_mode", "character_set_client", "character_set_results", "character_set_connection", "collation_connection"] as const;
interface SessionProfile {
  readonly sql_mode: string;
  readonly character_set_client: string;
  readonly character_set_results: string | null;
  readonly character_set_connection: string;
  readonly collation_connection: string;
}

function invalid(): never { throw new SchemaMetadataInstallError(); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length) invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
    result[key] = descriptor.value;
  }
  return result;
}
function rows(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) invalid();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
    return descriptor.value;
  });
}
function one(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const result = rows(value, 1);
  if (result.length !== 1) invalid();
  return record(result[0], keys);
}
async function database(conn: Pick<PoolConnection, "query">): Promise<string> {
  const [result] = await conn.query("SELECT DATABASE() AS application_database");
  const value = one(result, ["application_database"]).application_database;
  if (typeof value !== "string" || Buffer.from(value, "utf8").toString("utf8") !== value) invalid();
  return value;
}
async function session(conn: Pick<PoolConnection, "query">): Promise<SessionProfile> {
  const [result] = await conn.query(SESSION_SQL), value = one(result, SESSION_FIELDS);
  if (typeof value.sql_mode !== "string" || value.sql_mode.length > 8192 || !/^(?:[A-Z0-9_]+(?:,[A-Z0-9_]+)*)?$/.test(value.sql_mode)) invalid();
  for (const field of SESSION_FIELDS.slice(1)) {
    if (field === "character_set_results" && value[field] === null) continue;
    if (typeof value[field] !== "string" || !/^[A-Za-z0-9_]{1,64}$/.test(value[field])) invalid();
  }
  return Object.freeze({ sql_mode: value.sql_mode, character_set_client: value.character_set_client as string,
    character_set_results: value.character_set_results as string | null, character_set_connection: value.character_set_connection as string,
    collation_connection: value.collation_connection as string });
}
async function restore(conn: Pick<PoolConnection, "query">, original: SessionProfile): Promise<void> {
  await conn.query(`SET SESSION character_set_client=?, character_set_results=?, character_set_connection=?, collation_connection=?, sql_mode=?`,
    [original.character_set_client, original.character_set_results, original.character_set_connection, original.collation_connection, original.sql_mode]);
  const actual = await session(conn);
  for (const field of SESSION_FIELDS) if (actual[field] !== original[field]) invalid();
}
/** Used only after the fixed SQL_MODE has been installed: no ambient backslash/quote interpretation. */
function accountPart(value: string): string { return "'" + value.replace(/\\/g, "\\\\").replace(/'/g, "''") + "'"; }

/**
 * Installs only the fixed procedure into an existing metadata schema for a pre-provisioned locked
 * account. The owning Store operation must hold its migration lock, verify the full application
 * schema, and enforce stopped writers. No DB/user/grant creation, DROP/replace, CALL, retry, pool,
 * lock or business DML occurs here. CREATE PROCEDURE may commit: failure is not a rollback claim.
 * The caller owns the connection and native cancellation/close settlement.
 */
export async function installSchemaMetadataProcedure(conn: Pick<PoolConnection, "query">,
  input: SchemaMetadataReaderConfig): Promise<void> {
  let original: SessionProfile | undefined, mutated = false, failed = false;
  try {
    const config = captureSchemaMetadataReaderConfig(input), actualDatabase = await database(conn);
    const procedure = buildSchemaMetadataProcedure(actualDatabase, config.metadataSchema);
    const schemaName = Buffer.from(config.metadataSchema, "utf8");
    const [schemaResult] = await conn.query(`SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME
FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=? AND BINARY SCHEMA_NAME=BINARY ?`, [schemaName, schemaName]);
    const schema = one(schemaResult, ["SCHEMA_NAME", "DEFAULT_CHARACTER_SET_NAME", "DEFAULT_COLLATION_NAME"]);
    if (schema.SCHEMA_NAME !== config.metadataSchema || schema.DEFAULT_CHARACTER_SET_NAME !== "utf8mb4"
      || schema.DEFAULT_COLLATION_NAME !== "utf8mb4_0900_ai_ci") invalid();
    const user = Buffer.from(config.trustedDefiner.user, "utf8"), host = Buffer.from(config.trustedDefiner.host, "utf8");
    const [accountResult] = await conn.query(`SELECT User, Host, account_locked FROM mysql.user
WHERE User=? AND Host=? AND BINARY User=BINARY ? AND BINARY Host=BINARY ?`, [user, host, user, host]);
    const account = one(accountResult, ["User", "Host", "account_locked"]);
    if (account.User !== config.trustedDefiner.user || account.Host !== config.trustedDefiner.host || account.account_locked !== "Y") invalid();
    const routineName = Buffer.from(procedure.routineName, "utf8");
    const [existingResult] = await conn.query(`SELECT ROUTINE_NAME FROM information_schema.ROUTINES
WHERE ROUTINE_SCHEMA=? AND ROUTINE_NAME=? AND BINARY ROUTINE_SCHEMA=BINARY ? AND BINARY ROUTINE_NAME=BINARY ?`,
      [schemaName, routineName, schemaName, routineName]);
    const existing = rows(existingResult, 1);
    if (existing.length === 0) {
      original = await session(conn);
      // Mark before awaiting: a lost response is not proof that SET made no change.
      mutated = true;
      await conn.query("SET NAMES utf8mb4 COLLATE utf8mb4_0900_ai_ci");
      await conn.query(`SET SESSION sql_mode='${SQL_MODE}'`);
      if (!procedure.createSql.startsWith("CREATE PROCEDURE ")) invalid();
      await conn.query(`CREATE DEFINER=${accountPart(config.trustedDefiner.user)}@${accountPart(config.trustedDefiner.host)} ${procedure.createSql.slice("CREATE ".length)}`);
    } else if (record(existing[0], ["ROUTINE_NAME"]).ROUTINE_NAME !== procedure.routineName) invalid();
    // Metadata-only verification deliberately does not require EXECUTE on this newly created proc.
    await verifySchemaMetadataProcedureIdentity(conn, actualDatabase, config);
    if (await database(conn) !== actualDatabase) invalid();
  } catch {
    failed = true;
  } finally {
    if (mutated && original !== undefined) {
      try { await restore(conn, original); } catch { failed = true; }
    }
  }
  if (failed) throw new SchemaMetadataInstallError();
}
