import type { PoolConnection } from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";
import { buildSchemaMetadataProcedure } from "../src/mysql/schema-metadata-codec.js";
import type { SchemaMetadataReaderConfig } from "../src/mysql/schema-metadata.js";
import { assertSchemaRuntimeGrantSet, assertSchemaRuntimePrivileges, SchemaRuntimePrivilegesError, type SchemaRuntimeGrantEvidence } from "../src/mysql/schema-runtime-privileges.js";

// Synthetic canonical grant evidence only. These cases are not real MySQL/ACL acceptance proof.
const config: SchemaMetadataReaderConfig = { metadataSchema: "fixture_metadata", trustedDefiner: { user: "fixture_definer", host: "localhost" } };
const quote = (value: string) => "`" + value.replaceAll("`", "``") + "`";
const account = `${quote("fixture_runtime")}@${quote("localhost")}`;
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(database = "fixture_app", tables = ["schema_migrations", "sessions", "items", "usage_ledger"]): SchemaRuntimeGrantEvidence {
  const procedure = buildSchemaMetadataProcedure(database, config.metadataSchema);
  return { applicationDatabase: database, currentUser: "fixture_runtime@localhost", baseTables: tables,
    grants: [
      `GRANT USAGE ON *.* TO ${account}`,
      `GRANT SHOW_ROUTINE ON *.* TO ${account}`,
      `GRANT EXECUTE ON PROCEDURE ${quote(config.metadataSchema)}.${quote(procedure.routineName)} TO ${account}`,
      ...tables.map(table => `GRANT ${table === "schema_migrations" ? "SELECT" : "SELECT, INSERT, UPDATE, DELETE"} ON ${quote(database)}.${quote(table)} TO ${account}`),
    ] };
}
function extra(sql: string): SchemaRuntimeGrantEvidence { const value = fixture(); return { ...value, grants: [...value.grants, sql] }; }

describe("schema runtime table-only grant closure (pure synthetic evidence)", () => {
  it("requires each actual BASE TABLE, a SELECT-only marker and the exact hashed metadata procedure", () => {
    expect(() => assertSchemaRuntimeGrantSet(fixture(), config)).not.toThrow();
    const value = fixture();
    expect(() => assertSchemaRuntimeGrantSet({ ...value, grants: value.grants.filter(sql => !sql.startsWith("GRANT USAGE")) }, config)).not.toThrow();
  });

  it("accepts harmless privilege order and separately granted subsets only when their complete union is present", () => {
    const value = fixture(), grants = value.grants.filter(sql => !sql.includes(".`sessions`"));
    grants.push(`GRANT DELETE, SELECT ON \`fixture_app\`.\`sessions\` TO ${account}`,
      `GRANT UPDATE, INSERT ON \`fixture_app\`.\`sessions\` TO ${account}`);
    expect(() => assertSchemaRuntimeGrantSet({ ...value, grants }, config)).not.toThrow();
  });

  it("decodes doubled backticks without treating quoted identifier text as privilege keywords", () => {
    const value = fixture("app`name", ["schema_migrations", "CREATE TRIGGER", "tool`name"]);
    expect(() => assertSchemaRuntimeGrantSet(value, config)).not.toThrow();
    const runtimeUser = "run`time", quotedAccount = `${quote(runtimeUser)}@${quote("localhost")}`;
    const renamed = { ...value, currentUser: `${runtimeUser}@localhost`, grants: value.grants.map(sql => sql.replace(account, quotedAccount)) };
    expect(() => assertSchemaRuntimeGrantSet(renamed, config)).not.toThrow();
  });

  it.each(["SELECT", "INSERT", "UPDATE", "DELETE"])("rejects a missing %s right on a normal table", privilege => {
    const value = fixture();
    const grants = value.grants.map(sql => sql.includes(".`sessions`")
      ? `GRANT ${["SELECT", "INSERT", "UPDATE", "DELETE"].filter(right => right !== privilege).join(", ")} ON \`fixture_app\`.\`sessions\` TO ${account}` : sql);
    expect(() => assertSchemaRuntimeGrantSet({ ...value, grants }, config)).toThrow(SchemaRuntimePrivilegesError);
  });

  it.each(["SHOW_ROUTINE", "EXECUTE", "marker"])("rejects missing required %s proof", missing => {
    const value = fixture();
    const grants = value.grants.filter(sql => missing === "marker" ? !sql.includes(".`schema_migrations`") : !sql.startsWith(`GRANT ${missing}`));
    expect(() => assertSchemaRuntimeGrantSet({ ...value, grants }, config)).toThrow(SchemaRuntimePrivilegesError);
  });

  it.each(["INSERT", "UPDATE", "DELETE"])("rejects %s on the migration marker even if all required rights also exist", privilege => {
    expect(() => assertSchemaRuntimeGrantSet(extra(`GRANT ${privilege} ON \`fixture_app\`.\`schema_migrations\` TO ${account}`), config)).toThrow(SchemaRuntimePrivilegesError);
  });

  it.each([
    `GRANT SELECT ON \`fixture_app\`.* TO ${account}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON \`fixture_app\`.* TO ${account}`,
    `GRANT SELECT ON \`fixture\\_app\`.* TO ${account}`,
    `GRANT SELECT ON \`fixture%\`.* TO ${account}`,
    `GRANT SELECT ON *.* TO ${account}`,
    `GRANT ALL PRIVILEGES ON *.* TO ${account}`,
  ])("rejects schema/global data wildcard grants regardless of quoted/pattern spelling: %s", sql => {
    expect(() => assertSchemaRuntimeGrantSet(extra(sql), config)).toThrow(SchemaRuntimePrivilegesError);
  });

  it.each([
    "CREATE", "ALTER", "DROP", "TRIGGER", "INDEX", "REFERENCES", "CREATE VIEW", "SHOW VIEW", "CREATE ROUTINE", "ALTER ROUTINE",
    "CREATE TEMPORARY TABLES", "EVENT", "LOCK TABLES", "FILE", "PROCESS", "RELOAD", "SHUTDOWN", "SUPER", "SYSTEM_USER", "ROLE_ADMIN",
    "BACKUP_ADMIN", "SYSTEM_VARIABLES_ADMIN", "PERSIST_RO_VARIABLES_ADMIN", "GRANT OPTION",
  ])("rejects unapproved static/dynamic right %s using parsed privilege tokens", privilege => {
    expect(() => assertSchemaRuntimeGrantSet(extra(`GRANT ${privilege} ON *.* TO ${account}`), config)).toThrow(SchemaRuntimePrivilegesError);
  });

  it.each([
    `GRANT \`inactive_role\`@\`%\` TO ${account}`,
    `GRANT \`inactive_role\`@\`%\` TO ${account} WITH ADMIN OPTION`,
    `GRANT PROXY ON \`another_user\`@\`localhost\` TO ${account}`,
    `GRANT SELECT (\`private_column\`) ON \`fixture_app\`.\`sessions\` TO ${account}`,
    `GRANT SELECT ON \`fixture_app\`.\`sessions\` TO ${account} WITH GRANT OPTION`,
    `GRANT SELECT ON \`lookalike_app\`.\`sessions\` TO ${account}`,
    `GRANT SELECT ON \`fixture_app\`.\`unknown_or_view\` TO ${account}`,
    `GRANT EXECUTE ON FUNCTION \`fixture_metadata\`.\`other\` TO ${account}`,
    `GRANT EXECUTE ON PROCEDURE \`fixture_metadata\`.\`another_hash\` TO ${account}`,
    `GRANT EXECUTE ON PROCEDURE \`other_metadata\`.\`another_hash\` TO ${account}`,
    `REVOKE SELECT ON \`fixture_app\`.* FROM ${account}`,
  ])("rejects roles/proxy/columns/grant-option/cross-owner or unknown shapes: %s", sql => {
    expect(() => assertSchemaRuntimeGrantSet(extra(sql), config)).toThrow(SchemaRuntimePrivilegesError);
  });

  it("binds every TO account and object identity byte-for-byte rather than case-folding", () => {
    const value = fixture();
    expect(() => assertSchemaRuntimeGrantSet({ ...value, currentUser: "Fixture_Runtime@localhost" }, config)).toThrow(SchemaRuntimePrivilegesError);
    expect(() => assertSchemaRuntimeGrantSet(extra(`GRANT SELECT ON \`Fixture_App\`.\`sessions\` TO ${account}`), config)).toThrow(SchemaRuntimePrivilegesError);
    expect(() => assertSchemaRuntimeGrantSet(extra(`GRANT SELECT ON \`fixture_app\`.\`Sessions\` TO ${account}`), config)).toThrow(SchemaRuntimePrivilegesError);
    expect(() => assertSchemaRuntimeGrantSet(extra("GRANT USAGE ON *.* TO `other`@`localhost`"), config)).toThrow(SchemaRuntimePrivilegesError);
  });

  it("does not allow the locked trusted DEFINER account to become the runtime account", () => {
    const value = fixture(), definerAccount = `${quote(config.trustedDefiner.user)}@${quote(config.trustedDefiner.host)}`;
    const changed = { ...value, currentUser: `${config.trustedDefiner.user}@${config.trustedDefiner.host}`,
      grants: value.grants.map(sql => sql.replace(account, definerAccount)) };
    expect(() => assertSchemaRuntimeGrantSet(changed, config)).toThrow(SchemaRuntimePrivilegesError);
  });

  it("derives required rights from the actual table list rather than a copied app table allowlist", () => {
    const value = fixture();
    expect(() => assertSchemaRuntimeGrantSet({ ...value, baseTables: [...value.baseTables, "new_actual_table"] }, config)).toThrow(SchemaRuntimePrivilegesError);
    const complete = fixture("fixture_app", [...value.baseTables, "new_actual_table"]);
    expect(() => assertSchemaRuntimeGrantSet(complete, config)).not.toThrow();
    expect(() => assertSchemaRuntimeGrantSet({ ...value, baseTables: ["sessions"] }, config)).toThrow(SchemaRuntimePrivilegesError);
    expect(() => assertSchemaRuntimeGrantSet({ ...value, baseTables: [...value.baseTables, "sessions"] }, config)).toThrow(SchemaRuntimePrivilegesError);
    const repeated = value.grants[0]; if (repeated === undefined) throw new Error("fixture grant missing");
    expect(() => assertSchemaRuntimeGrantSet({ ...value, grants: [...value.grants, repeated] }, config)).toThrow(SchemaRuntimePrivilegesError);
  });

  it.each([
    `GRANT SELECT ON \`fixture_app\`.\`sessions\` TO ${account};`,
    `GRANT SELECT ON \`fixture_app\`.\`sessions\` TO ${account} /* hidden */`,
    `GRANT SELECT ON \`fixture_app\`.\`sessions\` TO 'fixture_runtime'@'localhost'`,
    `GRANT SELECT ON \`fixture_app\`.\`unterminated TO ${account}`,
    `GRANT SELECT, SELECT ON \`fixture_app\`.\`sessions\` TO ${account}`,
    `GRANT SELECT ON fixture_app.sessions TO ${account}`,
    `GRANT SELECT ON \`fixture_app\`.\`sessions\` TO \`\`@\`localhost\``,
  ])("rejects noncanonical or incomplete SQL without substring normalization: %s", sql => {
    expect(() => assertSchemaRuntimeGrantSet(extra(sql), config)).toThrow(SchemaRuntimePrivilegesError);
  });

  it("never includes the submitted grant/account/SQL in its fixed diagnostic", () => {
    const canary = "private-grant-canary"; let error: unknown;
    try { assertSchemaRuntimeGrantSet(extra(`GRANT ${canary} ON *.* TO ${account}`), config); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ name: "SchemaRuntimePrivilegesError", code: "schema_runtime_privileges_invalid", message: "Schema runtime privileges are invalid." });
    expect(String(error)).not.toContain(canary); expect(JSON.stringify(error)).not.toContain(canary);
    expect(String(error)).not.toContain("fixture_runtime");
  });
});

function nativeFixture() {
  const evidence = fixture();
  const normalIdentity = { application_database: evidence.applicationDatabase, effective_account: evidence.currentUser,
    login_account: "fixture_runtime@127.0.0.1", active_roles: "NONE", mandatory_roles: "", proxy_account: null };
  const normalTables = evidence.baseTables.map(name => ({ base_table_name: name }));
  const normalGrants = evidence.grants.map(sql => ({ [`Grants for ${evidence.currentUser}`]: sql }));
  const state: { beforeIdentity: unknown; afterIdentity: unknown; beforeTables: unknown; afterTables: unknown;
    beforeGrants: unknown; afterGrants: unknown; firstIdentityWait?: () => Promise<void> } = {
    beforeIdentity: [{ ...normalIdentity }], afterIdentity: [{ ...normalIdentity }],
    beforeTables: normalTables, afterTables: normalTables, beforeGrants: normalGrants, afterGrants: normalGrants,
  };
  let identities = 0, tables = 0, grants = 0;
  const query = vi.fn(async (...args: unknown[]): Promise<[unknown, never[]]> => {
    const sql = args[0];
    if (typeof sql !== "string") throw new Error("unexpected native fixture query shape");
    if (sql.startsWith("SELECT DATABASE()")) {
      if (identities === 0) await state.firstIdentityWait?.();
      return [identities++ === 0 ? state.beforeIdentity : state.afterIdentity, []];
    }
    if (sql.startsWith("SELECT TABLE_NAME AS base_table_name")) return [tables++ === 0 ? state.beforeTables : state.afterTables, []];
    if (sql === "SHOW GRANTS") return [grants++ === 0 ? state.beforeGrants : state.afterGrants, []];
    throw new Error("unexpected native fixture query");
  });
  const conn: Pick<PoolConnection, "query"> = { query: query as PoolConnection["query"] };
  return { conn, query, state, evidence, normalIdentity, normalTables, normalGrants };
}

describe("native startup privilege evidence adapter (driver doubles only)", () => {
  it("reads native identity, proxy, mandatory roles, complete table grants and repeats the closed evidence", async () => {
    const fake = nativeFixture();
    await expect(assertSchemaRuntimePrivileges(fake.conn, config)).resolves.toBeUndefined();
    const sql = fake.query.mock.calls.map(call => {
      const value = call[0];
      if (typeof value !== "string") throw new Error("unexpected native fixture query shape");
      return value;
    });
    expect(sql).toHaveLength(6); expect(sql.filter(value => value === "SHOW GRANTS")).toHaveLength(2);
    expect(sql[0]).toContain("CURRENT_USER() AS effective_account"); expect(sql[0]).toContain("USER() AS login_account");
    expect(sql[0]).toContain("CURRENT_ROLE() AS active_roles"); expect(sql[0]).toContain("@@GLOBAL.mandatory_roles AS mandatory_roles");
    expect(sql[0]).toContain("@@SESSION.proxy_user AS proxy_account");
    expect(sql[1]).toContain("TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY BINARY TABLE_NAME");
    expect(sql.every(value => !/\bCALL\b|SHOW GRANTS\s+(?:FOR|USING)\b|mysql\.user|\bGRANT\s|\bCREATE\b/i.test(value))).toBe(true);
  });

  it.each([
    { active_roles: "`inactive_role`@`%`" }, { active_roles: "" }, { active_roles: null },
    { mandatory_roles: "'inactive_role'@'%'" }, { mandatory_roles: "NONE" }, { mandatory_roles: " " },
    { proxy_account: "'proxy_user'@'localhost'" }, { proxy_account: "NULL" }, { proxy_account: "" },
    { effective_account: "anonymous" }, { effective_account: "@localhost" },
    { login_account: "another_user@localhost" }, { login_account: "fixture_runtime@" },
    { effective_account: "fixture_definer@localhost", login_account: "fixture_definer@localhost" },
  ])("rejects nonzero/unknown role, proxy or account identity before grant use: %j", async change => {
    const fake = nativeFixture(); fake.state.beforeIdentity = [{ ...fake.normalIdentity, ...change }];
    await expect(assertSchemaRuntimePrivileges(fake.conn, config)).rejects.toBeInstanceOf(SchemaRuntimePrivilegesError);
    expect(fake.query).toHaveBeenCalledTimes(1);
  });

  it("rejects an inactive role grant even when CURRENT_ROLE is exactly NONE", async () => {
    const fake = nativeFixture(); fake.state.beforeGrants = [...fake.normalGrants,
      { [`Grants for ${fake.evidence.currentUser}`]: `GRANT \`inactive_role\`@\`%\` TO ${account}` }];
    await expect(assertSchemaRuntimePrivileges(fake.conn, config)).rejects.toBeInstanceOf(SchemaRuntimePrivilegesError);
  });

  it.each(["database", "account", "login", "roles", "mandatory", "proxy", "grants", "tables"])("rejects %s drift across the same native scope", async changed => {
    const fake = nativeFixture();
    if (changed === "database") fake.state.afterIdentity = [{ ...fake.normalIdentity, application_database: "another_database" }];
    if (changed === "account") fake.state.afterIdentity = [{ ...fake.normalIdentity, effective_account: "fixture_runtime@%" }];
    if (changed === "login") fake.state.afterIdentity = [{ ...fake.normalIdentity, login_account: "fixture_runtime@another_host" }];
    if (changed === "roles") fake.state.afterIdentity = [{ ...fake.normalIdentity, active_roles: "`role`@`%`" }];
    if (changed === "mandatory") fake.state.afterIdentity = [{ ...fake.normalIdentity, mandatory_roles: "'role'@'%'" }];
    if (changed === "proxy") fake.state.afterIdentity = [{ ...fake.normalIdentity, proxy_account: "'proxy'@'host'" }];
    if (changed === "grants") fake.state.afterGrants = fake.normalGrants.slice(1);
    if (changed === "tables") fake.state.afterTables = [...fake.normalTables, { base_table_name: "new_table" }];
    await expect(assertSchemaRuntimePrivileges(fake.conn, config)).rejects.toBeInstanceOf(SchemaRuntimePrivilegesError);
  });

  it("does not confuse native grant row order with a permission change", async () => {
    const fake = nativeFixture(); fake.state.afterGrants = [...fake.normalGrants].reverse();
    await expect(assertSchemaRuntimePrivileges(fake.conn, config)).resolves.toBeUndefined();
  });

  it("requires the exact native SHOW GRANTS account column and rejects missing required table visibility/rights", async () => {
    const wrongHeader = nativeFixture(); wrongHeader.state.beforeGrants = [{ "Grants for another@localhost": "GRANT USAGE ON *.* TO `another`@`localhost`" }];
    await expect(assertSchemaRuntimePrivileges(wrongHeader.conn, config)).rejects.toBeInstanceOf(SchemaRuntimePrivilegesError);
    const missingMarker = nativeFixture(); missingMarker.state.beforeTables = [{ base_table_name: "sessions" }];
    await expect(assertSchemaRuntimePrivileges(missingMarker.conn, config)).rejects.toBeInstanceOf(SchemaRuntimePrivilegesError);
    const newTable = nativeFixture(); newTable.state.beforeTables = [...newTable.normalTables, { base_table_name: "new_table" }];
    await expect(assertSchemaRuntimePrivileges(newTable.conn, config)).rejects.toBeInstanceOf(SchemaRuntimePrivilegesError);
  });

  it("does not evaluate row accessors and allows ordinary native packet prototypes", async () => {
    const getter = vi.fn(() => "secret-account-canary"), unsafe = nativeFixture();
    const row = { ...unsafe.normalIdentity }; Object.defineProperty(row, "effective_account", { enumerable: true, get: getter });
    unsafe.state.beforeIdentity = [row];
    await expect(assertSchemaRuntimePrivileges(unsafe.conn, config)).rejects.toBeInstanceOf(SchemaRuntimePrivilegesError);
    expect(getter).not.toHaveBeenCalled();
    const safe = nativeFixture(); safe.state.beforeIdentity = [Object.assign(Object.create({ packet: true }), safe.normalIdentity)];
    await expect(assertSchemaRuntimePrivileges(safe.conn, config)).resolves.toBeUndefined();
  });

  it("captures the closed metadata config before the first native await and never consumes later changes", async () => {
    const fake = nativeFixture(), entered = deferred<void>(), release = deferred<void>();
    fake.state.firstIdentityWait = async () => { entered.resolve(); await release.promise; };
    const mutable = { metadataSchema: config.metadataSchema, trustedDefiner: { ...config.trustedDefiner } };
    const running = assertSchemaRuntimePrivileges(fake.conn, mutable);
    try { await entered.promise; mutable.metadataSchema = "another_metadata"; mutable.trustedDefiner.user = "another_definer"; }
    finally { release.resolve(); }
    await expect(running).resolves.toBeUndefined();
  });

  it("uses fixed content-free errors for driver failures without forwarding SQL, account or cause", async () => {
    const fake = nativeFixture(); fake.query.mockRejectedValueOnce(new Error("private-driver-sql-account-canary"));
    let error: unknown; try { await assertSchemaRuntimePrivileges(fake.conn, config); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "schema_runtime_privileges_invalid", message: "Schema runtime privileges are invalid." });
    expect(String(error)).not.toMatch(/canary|fixture_app|fixture_runtime/); expect(error).not.toHaveProperty("cause");
  });
});
