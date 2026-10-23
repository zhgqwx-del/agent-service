import type { PoolConnection } from "mysql2/promise";
import { captureSchemaMetadataReaderConfig, type SchemaMetadataReaderConfig } from "./schema-metadata.js";
import { assertSchemaRuntimeGrantSet } from "./schema-runtime-privileges.js";
import type { AssertSessionAuthorityActivationAdmission, CapturedSessionAuthorityBindingCommand,
  SessionAuthorityRuntimeAccount } from "./session-authority-binding-types.js";

// UNAPPLIED: root-authored native operator admission. No grants, account mutation, DDL or KILL.
const MAX_ACCOUNTS = 256, MAX_ROWS = 4096;
type Reason = "invalid_command" | "operator_identity" | "operator_visibility" | "namespace_changed"
  | "retired_account_active" | "retired_account_grants" | "role_or_proxy_path"
  | "retired_connection" | "new_account_invalid" | "native_evidence_changed";
export class SessionAuthorityActivationAdmissionError extends Error {
  readonly code = "session_authority_activation_admission_failed";
  constructor(readonly reason: Reason) { super("Session authority activation admission failed."); }
}
function invalid(reason: Reason): never { throw new SessionAuthorityActivationAdmissionError(reason); }
function data(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("invalid_command");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length) invalid("invalid_command");
  const captured: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const d = descriptors[key];
    if (!d || !("value" in d) || !d.enumerable) invalid("invalid_command");
    captured[key] = d.value;
  }
  return captured;
}
function rows(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalid("invalid_command");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) invalid("invalid_command");
  return Array.from({ length: value.length }, (_, i) => {
    const d = descriptors[String(i)];
    if (!d || !("value" in d) || !d.enumerable) invalid("invalid_command");
    return d.value;
  });
}
function one(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const selected = rows(value, 1); if (selected.length !== 1) invalid("invalid_command");
  return data(selected[0], keys);
}
function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= maximum
    && Buffer.from(value, "utf8").toString("utf8") === value && !/[\u0000-\u001f\u007f]/.test(value);
}
function account(value: unknown): Readonly<SessionAuthorityRuntimeAccount> {
  const d = data(value, ["user", "host"]);
  if (!text(d.user, 128) || [...d.user].length > 32 || d.user.includes("@")
    || !text(d.host, 1020) || [...d.host].length > 255 || d.host.includes("@")) invalid("invalid_command");
  return Object.freeze({ user: d.user, host: d.host });
}
function quoteId(value: string): string { return "`" + value.replaceAll("`", "``") + "`"; }
function principal(a: SessionAuthorityRuntimeAccount): string { return a.user + "@" + a.host; }
function showAccount(a: SessionAuthorityRuntimeAccount): string { return quoteId(a.user) + "@" + quoteId(a.host); }
function exactSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && new Set(a).size === a.length && new Set(b).size === b.length
    && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

interface Selection {
  readonly serverUuid: string; readonly database: string;
  readonly oldNames: readonly string[]; readonly newAccounts: readonly Readonly<SessionAuthorityRuntimeAccount>[];
}
function selection(command: Readonly<CapturedSessionAuthorityBindingCommand>): Selection {
  // The binding module supplies a captured command; this module still snapshots its own inputs.
  const ds = Object.getOwnPropertyDescriptors(command);
  const own = (key: string) => { const d = ds[key]; if (!d || !("value" in d) || !d.enumerable) invalid("invalid_command"); return d.value as unknown; };
  const serverUuid = own("serverUuid"), database = own("applicationDatabase");
  if (!text(serverUuid, 36) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(serverUuid)
    || !text(database, 256) || [...database].length > 64 || database.includes("\0")) invalid("invalid_command");
  const oldNames = rows(own("oldAccountNames"), MAX_ACCOUNTS).map(value => {
    if (!text(value, 128) || [...value].length > 32 || value.includes("@")) invalid("invalid_command"); return value;
  });
  const newAccounts = rows(own("newAccounts"), 64).map(account);
  if (!newAccounts.length || new Set(oldNames).size !== oldNames.length
    || new Set(newAccounts.map(principal)).size !== newAccounts.length
    || newAccounts.some(a => oldNames.includes(a.user))) invalid("invalid_command");
  return Object.freeze({ serverUuid, database, oldNames: Object.freeze(oldNames), newAccounts: Object.freeze(newAccounts) });
}

interface NativeIdentity { readonly database: string; readonly uuid: string; readonly user: string; readonly host: string }
async function nativeIdentity(conn: PoolConnection, wanted: Selection, config: SchemaMetadataReaderConfig): Promise<NativeIdentity> {
  const [result] = await conn.query("SELECT DATABASE() AS application_database, @@server_uuid AS server_uuid, "
    + "CURRENT_USER() AS current_account, USER() AS login_account, CURRENT_ROLE() AS active_roles, "
    + "@@GLOBAL.mandatory_roles AS mandatory_roles, @@SESSION.proxy_user AS proxy_account");
  const r = one(result, ["application_database", "server_uuid", "current_account", "login_account", "active_roles", "mandatory_roles", "proxy_account"]);
  if (r.application_database !== wanted.database || r.server_uuid !== wanted.serverUuid) invalid("namespace_changed");
  if (!text(r.current_account, 1150) || !text(r.login_account, 1150) || r.active_roles !== "NONE"
    || r.mandatory_roles !== "" || r.proxy_account !== null) invalid("operator_identity");
  const effective = r.current_account.split("@"), login = r.login_account.split("@");
  if (effective.length !== 2 || login.length !== 2 || effective[0] !== login[0]) invalid("operator_identity");
  const operator = account({ user: effective[0], host: effective[1] });
  if (wanted.oldNames.includes(operator.user) || wanted.newAccounts.some(a => a.user === operator.user)
    || principal(operator) === principal(config.trustedDefiner)) invalid("operator_identity");
  // Require direct PROCESS. We refuse role/proxy-derived visibility instead of trusting a zero.
  const [capability] = await conn.query("SELECT User, Host, account_locked, Process_priv FROM mysql.user "
    + "WHERE BINARY User=BINARY ? AND BINARY Host=BINARY ? FOR SHARE", [operator.user, operator.host]);
  const c = one(capability, ["User", "Host", "account_locked", "Process_priv"]);
  if (c.User !== operator.user || c.Host !== operator.host || c.account_locked !== "N" || c.Process_priv !== "Y") invalid("operator_visibility");
  return Object.freeze({ database: wanted.database, uuid: wanted.serverUuid, ...operator });
}
async function grants(conn: PoolConnection, a: SessionAuthorityRuntimeAccount): Promise<readonly string[]> {
  const [result] = await conn.query("SHOW GRANTS FOR " + showAccount(a));
  const key = "Grants for " + principal(a), values: string[] = []; let bytes = 0;
  for (const value of rows(result, 16_384)) {
    const sql = data(value, [key])[key]; if (!text(sql, 65_536)) invalid("invalid_command");
    bytes += Buffer.byteLength(sql); if (bytes > 32 * 1024 * 1024) invalid("invalid_command"); values.push(sql);
  }
  if (!values.length || new Set(values).size !== values.length) invalid("invalid_command");
  return Object.freeze(values);
}
async function noIndirectPaths(conn: PoolConnection, names: readonly string[]): Promise<void> {
  if (!names.length) return;
  const marks = names.map(() => "?").join(",");
  // Do not infer authenticated host patterns from a network peer host. Retire each username fully.
  for (const sql of [
    "SELECT FROM_USER, FROM_HOST, TO_USER, TO_HOST FROM mysql.role_edges WHERE BINARY TO_USER IN (" + marks + ") OR BINARY FROM_USER IN (" + marks + ") FOR SHARE",
    "SELECT USER, HOST, DEFAULT_ROLE_USER, DEFAULT_ROLE_HOST FROM mysql.default_roles WHERE BINARY USER IN (" + marks + ") OR BINARY DEFAULT_ROLE_USER IN (" + marks + ") FOR SHARE",
    "SELECT User, Host, Proxied_user, Proxied_host FROM mysql.proxies_priv WHERE BINARY User IN (" + marks + ") OR BINARY Proxied_user IN (" + marks + ") FOR SHARE",
  ]) {
    const [result] = await conn.query(sql, [...names, ...names]); if (rows(result, MAX_ROWS).length !== 0) invalid("role_or_proxy_path");
  }
}
async function retired(conn: PoolConnection, wanted: Selection): Promise<readonly string[]> {
  if (!wanted.oldNames.length) return Object.freeze([]);
  const marks = wanted.oldNames.map(() => "?").join(",");
  const [result] = await conn.query("SELECT User, Host, account_locked FROM mysql.user WHERE BINARY User IN (" + marks
    + ") ORDER BY BINARY User, BINARY Host FOR SHARE", [...wanted.oldNames]);
  const identities: string[] = [];
  for (const value of rows(result, MAX_ROWS)) {
    const row = data(value, ["User", "Host", "account_locked"]), a = account({ user: row.User, host: row.Host });
    if (!wanted.oldNames.includes(a.user) || row.account_locked !== "Y") invalid("retired_account_active");
    const actual = await grants(conn, a), onlyUsage = "GRANT USAGE ON *.* TO " + showAccount(a);
    if (actual.length !== 1 || actual[0] !== onlyUsage) invalid("retired_account_grants");
    identities.push(principal(a));
  }
  if (new Set(identities).size !== identities.length) invalid("invalid_command");
  await noIndirectPaths(conn, wanted.oldNames);
  const [threads] = await conn.query("SELECT PROCESSLIST_ID, PROCESSLIST_USER FROM performance_schema.threads "
    + "WHERE TYPE='FOREGROUND' AND BINARY PROCESSLIST_USER IN (" + marks + ")", [...wanted.oldNames]);
  if (rows(threads, MAX_ROWS).length !== 0) invalid("retired_connection");
  const [transactions] = await conn.query("SELECT t.trx_id, t.trx_mysql_thread_id FROM information_schema.INNODB_TRX t "
    + "LEFT JOIN performance_schema.threads p ON p.PROCESSLIST_ID=t.trx_mysql_thread_id "
    + "WHERE p.PROCESSLIST_ID IS NULL OR BINARY p.PROCESSLIST_USER IN (" + marks + ")", [...wanted.oldNames]);
  // An un-attributable transaction is unknown, never proof that old writers have drained.
  if (rows(transactions, MAX_ROWS).length !== 0) invalid("retired_connection");
  return Object.freeze(identities);
}
async function newGrants(conn: PoolConnection, wanted: Selection, config: SchemaMetadataReaderConfig): Promise<readonly string[]> {
  const [tablesRaw] = await conn.query("SELECT TABLE_NAME AS base_table_name FROM information_schema.TABLES "
    + "WHERE BINARY TABLE_SCHEMA=BINARY DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY BINARY TABLE_NAME");
  const tables = rows(tablesRaw, 16_384).map(value => {
    const v = data(value, ["base_table_name"]).base_table_name;
    if (!text(v, 256) || [...v].length > 64) invalid("invalid_command"); return v;
  });
  if (!tables.length || new Set(tables).size !== tables.length) invalid("invalid_command");
  const snapshots: string[] = [];
  for (const a of wanted.newAccounts) {
    const [accountRows] = await conn.query("SELECT User, Host, account_locked, password_expired FROM mysql.user "
      + "WHERE BINARY User=BINARY ? AND BINARY Host=BINARY ? FOR SHARE", [a.user, a.host]);
    const row = one(accountRows, ["User", "Host", "account_locked", "password_expired"]);
    if (row.User !== a.user || row.Host !== a.host || row.account_locked !== "N" || row.password_expired !== "N") invalid("new_account_invalid");
    const actual = await grants(conn, a);
    // Full strict schema verification is a separate, same-operation prerequisite. SHOW GRANTS FOR
    // here is operator evidence, not a replacement for each actual runtime connection identity.
    assertSchemaRuntimeGrantSet({ applicationDatabase: wanted.database, currentUser: principal(a), baseTables: tables, grants: actual }, config);
    snapshots.push(JSON.stringify({ account: principal(a), grants: [...actual].sort(), tables }));
  }
  await noIndirectPaths(conn, [...new Set(wanted.newAccounts.map(a => a.user))]);
  return Object.freeze(snapshots);
}

/**
 * Called by the binding helper inside its original activation transaction, before any mutation.
 * Reads current native evidence twice; never begins/commits/rolls back or installs privileges.
 * Locks/account reads are not an atomic replacement for the exclusive administrative window.
 * Absent retired usernames prove absence only on this selected target, not remote source fencing.
 */
export const assertSessionAuthorityActivationAdmission: AssertSessionAuthorityActivationAdmission = async (
  conn: PoolConnection, command: Readonly<CapturedSessionAuthorityBindingCommand>, schemaMetadata: SchemaMetadataReaderConfig,
): Promise<void> => {
  const wanted = selection(command), config = captureSchemaMetadataReaderConfig(schemaMetadata);
  const before = await nativeIdentity(conn, wanted, config), oldBefore = await retired(conn, wanted), newBefore = await newGrants(conn, wanted, config);
  const oldAfter = await retired(conn, wanted), newAfter = await newGrants(conn, wanted, config), after = await nativeIdentity(conn, wanted, config);
  if (JSON.stringify(before) !== JSON.stringify(after) || !exactSet(oldBefore, oldAfter) || !exactSet(newBefore, newAfter)) invalid("native_evidence_changed");
};
