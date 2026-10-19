import type { PoolConnection } from "mysql2/promise";
import { buildSchemaMetadataProcedure } from "./schema-metadata-codec.js";
import { captureSchemaMetadataReaderConfig, type SchemaMetadataReaderConfig } from "./schema-metadata.js";

export class SchemaRuntimePrivilegesError extends Error {
  readonly code = "schema_runtime_privileges_invalid";
  constructor() { super("Schema runtime privileges are invalid."); this.name = "SchemaRuntimePrivilegesError"; }
}
function invalid(): never { throw new SchemaRuntimePrivilegesError(); }

interface GrantToken { readonly kind: "word" | "identifier" | "symbol"; readonly value: string }
interface Account { readonly user: string; readonly host: string }
interface Grant {
  readonly privileges: readonly string[];
  readonly account: Account;
  readonly target: { readonly kind: "global" }
    | { readonly kind: "table" | "procedure"; readonly schema: string; readonly name: string };
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= maximum
    && Buffer.from(value, "utf8").toString("utf8") === value && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Canonical SHOW GRANTS SQL only: comments, string literals and SQL-mode escapes are unknown. */
function tokens(sql: string): GrantToken[] {
  if (!text(sql, 65_536) || sql.length === 0) invalid();
  const result: GrantToken[] = [];
  for (let i = 0; i < sql.length;) {
    const c = sql[i]!;
    if (c === " ") { i++; continue; }
    if (c === "`") {
      i++; let value = "", closed = false;
      while (i < sql.length) {
        if (sql[i] === "`") {
          if (sql[i + 1] === "`") { value += "`"; i += 2; continue; }
          i++; closed = true; break;
        }
        // Do not reinterpret pattern/SQL-mode backslash escapes as literal identifiers.
        if (sql[i] === "\\") invalid();
        value += sql[i++]!;
      }
      if (!closed || value.length === 0) invalid();
      result.push({ kind: "identifier", value }); continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const start = i++;
      while (i < sql.length && /[A-Za-z0-9_]/.test(sql[i]!)) i++;
      result.push({ kind: "word", value: sql.slice(start, i).toUpperCase() }); continue;
    }
    if (["*", ".", ",", "@"].includes(c)) { result.push({ kind: "symbol", value: c }); i++; continue; }
    invalid();
  }
  return result;
}

function account(user: string, host: string): Account {
  if (!text(user, 128) || [...user].length < 1 || [...user].length > 32 || user.includes("@")
    || !text(host, 1020) || [...host].length < 1 || [...host].length > 255 || host.includes("@")) invalid();
  return { user, host };
}

function parseGrant(sql: string): Grant {
  const input = tokens(sql); let index = 0;
  function keyword(value: string): void {
    const token = input[index++]; if (token?.kind !== "word" || token.value !== value) invalid();
  }
  function symbol(value: string): void {
    const token = input[index++]; if (token?.kind !== "symbol" || token.value !== value) invalid();
  }
  function identifier(): string {
    const token = input[index++]; if (token?.kind !== "identifier") invalid(); return token.value;
  }
  keyword("GRANT");
  const privileges: string[] = [];
  while (true) {
    const parts: string[] = [];
    while (input[index]?.kind === "word" && input[index]?.value !== "ON") parts.push(input[index++]!.value);
    if (parts.length === 0) invalid();
    const privilege = parts.join(" ");
    if (!["USAGE", "SHOW_ROUTINE", "SELECT", "INSERT", "UPDATE", "DELETE", "EXECUTE"].includes(privilege)
      || privileges.includes(privilege)) invalid();
    privileges.push(privilege);
    if (input[index]?.value !== ",") break;
    index++;
  }
  keyword("ON");
  let target: Grant["target"];
  if (input[index]?.value === "*") { symbol("*"); symbol("."); symbol("*"); target = { kind: "global" }; }
  else {
    const procedure = input[index]?.kind === "word" && input[index]?.value === "PROCEDURE";
    if (procedure) index++;
    const schema = identifier(); symbol(".");
    // Reject every schema-wide grant, even quoted underscore/percent app names. Their pattern
    // interpretation depends on partial_revokes; this profile grants each actual BASE TABLE.
    const name = identifier();
    target = { kind: procedure ? "procedure" : "table", schema, name };
  }
  keyword("TO");
  const user = identifier(); symbol("@"); const host = identifier();
  if (index !== input.length) invalid(); // Includes GRANT OPTION, role ADMIN OPTION and proxy forms.
  return { privileges, account: account(user, host), target };
}

export interface SchemaRuntimeGrantEvidence {
  readonly applicationDatabase: string;
  readonly currentUser: string;
  readonly baseTables: readonly string[];
  readonly grants: readonly string[];
}

/**
 * Pure closure check, not authentication: the startup adapter must obtain every evidence field
 * using this connection's native queries, never a DEFINER routine or caller-provided evidence.
 * I_S table visibility is privilege-filtered: the complete formal schema fingerprint must also
 * pass. This helper alone cannot establish the absence of an inaccessible table.
 * This startup snapshot does not protect against a privileged DBA changing grants afterwards.
 */
export function assertSchemaRuntimeGrantSet(evidence: SchemaRuntimeGrantEvidence, input: SchemaMetadataReaderConfig): void {
  try {
    const config = captureSchemaMetadataReaderConfig(input);
    const procedure = buildSchemaMetadataProcedure(evidence.applicationDatabase, config.metadataSchema);
    if (!text(evidence.currentUser, 1150) || evidence.currentUser === `${config.trustedDefiner.user}@${config.trustedDefiner.host}`
      || !Array.isArray(evidence.baseTables) || evidence.baseTables.length > 16_384
      || !Array.isArray(evidence.grants) || evidence.grants.length === 0 || evidence.grants.length > 16_384) invalid();
    const required = new Map<string, Set<string>>();
    for (const name of evidence.baseTables) {
      if (!text(name, 256) || [...name].length < 1 || [...name].length > 64 || required.has(name)) invalid();
      required.set(name, new Set());
    }
    if (!required.has("schema_migrations")) invalid();
    let showRoutine = false, execute = false;
    const seen = new Set<string>();
    for (const sql of evidence.grants) {
      if (seen.has(sql)) invalid(); seen.add(sql);
      const grant = parseGrant(sql);
      if (`${grant.account.user}@${grant.account.host}` !== evidence.currentUser) invalid();
      if (grant.target.kind === "global") {
        for (const privilege of grant.privileges) {
          if (privilege !== "USAGE" && privilege !== "SHOW_ROUTINE") invalid();
          if (privilege === "SHOW_ROUTINE") showRoutine = true;
        }
      } else if (grant.target.kind === "procedure") {
        if (grant.target.schema !== config.metadataSchema || grant.target.name !== procedure.routineName
          || grant.privileges.length !== 1 || grant.privileges[0] !== "EXECUTE") invalid();
        execute = true;
      } else {
        const rights = required.get(grant.target.name);
        if (grant.target.schema !== evidence.applicationDatabase || !rights) invalid();
        for (const privilege of grant.privileges) {
          if (!["SELECT", "INSERT", "UPDATE", "DELETE"].includes(privilege)
            || grant.target.name === "schema_migrations" && privilege !== "SELECT") invalid();
          rights.add(privilege);
        }
      }
    }
    if (!showRoutine || !execute) invalid();
    for (const [name, rights] of required) {
      if (!rights.has("SELECT") || name !== "schema_migrations"
        && (!["INSERT", "UPDATE", "DELETE"].every(privilege => rights.has(privilege)))) invalid();
    }
  } catch { throw new SchemaRuntimePrivilegesError(); }
}

const IDENTITY_SQL = "SELECT DATABASE() AS application_database, CURRENT_USER() AS effective_account, USER() AS login_account, "
  + "CURRENT_ROLE() AS active_roles, @@GLOBAL.mandatory_roles AS mandatory_roles, @@SESSION.proxy_user AS proxy_account";
const TABLES_SQL = "SELECT TABLE_NAME AS base_table_name FROM information_schema.TABLES "
  + "WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY BINARY TABLE_NAME";
const IDENTITY_KEYS = ["application_database", "effective_account", "login_account", "active_roles", "mandatory_roles", "proxy_account"] as const;

function ownData(value: unknown, keys: readonly string[]): Record<string, unknown> {
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

function rows(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) invalid();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
    return descriptor.value;
  });
}

interface Identity { readonly database: string; readonly effectiveAccount: string; readonly loginAccount: string }
function identity(value: unknown, config: SchemaMetadataReaderConfig): Identity {
  const input = rows(value, 1); if (input.length !== 1) invalid();
  const row = ownData(input[0], IDENTITY_KEYS);
  if (!text(row.application_database, 256) || !text(row.effective_account, 1150) || !text(row.login_account, 1150)
    || row.active_roles !== "NONE" || row.mandatory_roles !== "" || row.proxy_account !== null) invalid();
  const effective = row.effective_account.split("@"), login = row.login_account.split("@");
  if (effective.length !== 2 || login.length !== 2) invalid();
  const [effectiveUser, effectiveHost] = effective, [loginUser, loginHost] = login;
  if (effectiveUser === undefined || effectiveHost === undefined || loginUser === undefined || loginHost === undefined) invalid();
  const authenticated = account(effectiveUser, effectiveHost), presented = account(loginUser, loginHost);
  if (authenticated.user !== presented.user || row.effective_account === `${config.trustedDefiner.user}@${config.trustedDefiner.host}`) invalid();
  // USER() reports the connecting host, not the authenticated account's host pattern. The two
  // hosts may legitimately differ; proxy_user must independently be the native SQL NULL.
  buildSchemaMetadataProcedure(row.application_database, config.metadataSchema);
  return Object.freeze({ database: row.application_database, effectiveAccount: row.effective_account, loginAccount: row.login_account });
}

function tableNames(value: unknown): readonly string[] {
  const result: string[] = [];
  for (const row of rows(value, 16_384)) {
    const name = ownData(row, ["base_table_name"]).base_table_name;
    if (!text(name, 256) || [...name].length < 1 || [...name].length > 64) invalid();
    result.push(name);
  }
  return Object.freeze(result);
}

function grants(value: unknown, effectiveAccount: string): readonly string[] {
  const key = `Grants for ${effectiveAccount}`, result: string[] = [];
  let bytes = 0;
  for (const row of rows(value, 16_384)) {
    const sql = ownData(row, [key])[key];
    if (!text(sql, 65_536)) invalid();
    bytes += Buffer.byteLength(sql, "utf8"); if (bytes > 32 * 1024 * 1024) invalid();
    result.push(sql);
  }
  return Object.freeze(result);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const values = new Set(left);
  return values.size === left.length && right.every(value => values.has(value)) && new Set(right).size === right.length;
}

/**
 * Startup-only evidence from native queries on this connection, never SHOW GRANTS USING/FOR or
 * a DEFINER. Requires the original full schema verifier as a separate gate. Before/after checks
 * detect ordinary drift, not a privileged change-and-restore or later DBA permission changes.
 */
export async function assertSchemaRuntimePrivileges(conn: Pick<PoolConnection, "query">,
  input: SchemaMetadataReaderConfig): Promise<void> {
  try {
    const config = captureSchemaMetadataReaderConfig(input);
    const [identityBefore] = await conn.query(IDENTITY_SQL), before = identity(identityBefore, config);
    const [tablesBefore] = await conn.query(TABLES_SQL), tables = tableNames(tablesBefore);
    const [grantsBefore] = await conn.query("SHOW GRANTS"), beforeGrants = grants(grantsBefore, before.effectiveAccount);
    assertSchemaRuntimeGrantSet({ applicationDatabase: before.database, currentUser: before.effectiveAccount, baseTables: tables, grants: beforeGrants }, config);
    const [grantsAfter] = await conn.query("SHOW GRANTS"), afterGrants = grants(grantsAfter, before.effectiveAccount);
    const [tablesAfter] = await conn.query(TABLES_SQL), afterTables = tableNames(tablesAfter);
    const [identityAfter] = await conn.query(IDENTITY_SQL), after = identity(identityAfter, config);
    if (before.database !== after.database || before.effectiveAccount !== after.effectiveAccount || before.loginAccount !== after.loginAccount
      || !sameSet(beforeGrants, afterGrants) || !sameSet(tables, afterTables)) invalid();
    assertSchemaRuntimeGrantSet({ applicationDatabase: after.database, currentUser: after.effectiveAccount, baseTables: afterTables, grants: afterGrants }, config);
  } catch { throw new SchemaRuntimePrivilegesError(); }
}
