import type { PoolConnection } from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";
import { buildSchemaMetadataProcedure } from "../src/mysql/schema-metadata-codec.js";
import { installSchemaMetadataProcedure, SchemaMetadataInstallError } from "../src/mysql/schema-metadata-install.js";
import type { SchemaMetadataReaderConfig } from "../src/mysql/schema-metadata.js";

// Query doubles only. Real CREATE DEFINER privileges/DDL boundaries are not proved here.
const APP = "schema_install_fixture", META = "schema_metadata_fixture";
const CONFIG = { metadataSchema: META, trustedDefiner: { user: "metadata_reader", host: "localhost" } };
const SQL_MODE = "STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION";
const procedure = buildSchemaMetadataProcedure(APP, META);
function identity(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...procedure.expectedAttributes, ROUTINE_DEFINITION: procedure.expectedDefinition, DEFINER: "metadata_reader@localhost",
    SQL_MODE, CHARACTER_SET_CLIENT: "utf8mb4", COLLATION_CONNECTION: "utf8mb4_0900_ai_ci", DATABASE_COLLATION: "utf8mb4_0900_ai_ci", ...extra };
}
function initialSession() {
  return { sql_mode: "ANSI_QUOTES,NO_BACKSLASH_ESCAPES", character_set_client: "latin1", character_set_results: null as string | null,
    character_set_connection: "latin1", collation_connection: "latin1_swedish_ci" };
}
type Stage = "database" | "schema" | "account" | "exists" | "session" | "names" | "mode" | "create" | "identity" | "parameters" | "restore";
function fixture() {
  const state = { existing: false, actualDatabase: APP, schema: [{ SCHEMA_NAME: META, DEFAULT_CHARACTER_SET_NAME: "utf8mb4", DEFAULT_COLLATION_NAME: "utf8mb4_0900_ai_ci" }] as unknown,
    account: [{ User: CONFIG.trustedDefiner.user, Host: CONFIG.trustedDefiner.host, account_locked: "Y" }] as unknown,
    identity: [identity()] as unknown, parameters: [{ parameter_count: 0 }] as unknown, session: initialSession(), restored: false };
  const trace: { stage: Stage; sql: string; values: unknown[] | undefined }[] = [];
  let hook: (stage: Stage) => void | Promise<void> = () => {};
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    const stage: Stage = sql === "SELECT DATABASE() AS application_database" ? "database"
      : sql.includes("FROM information_schema.SCHEMATA") ? "schema"
      : sql.includes("FROM mysql.user") ? "account"
      : sql.startsWith("SELECT ROUTINE_NAME FROM") ? "exists"
      : sql.startsWith("SELECT @@SESSION.sql_mode") ? "session"
      : sql.startsWith("SET NAMES ") ? "names"
      : sql.startsWith("SET SESSION sql_mode=") ? "mode"
      : sql.startsWith("CREATE DEFINER=") ? "create"
      : sql.includes("FROM information_schema.ROUTINES") ? "identity"
      : sql.includes("FROM information_schema.PARAMETERS") ? "parameters"
      : sql.startsWith("SET SESSION character_set_client=") ? "restore"
      : (() => { throw new Error("Unexpected fixture query"); })();
    trace.push({ stage, sql, values }); await hook(stage);
    let result: unknown = [];
    if (stage === "database") result = [{ application_database: state.actualDatabase }];
    if (stage === "schema") result = state.schema;
    if (stage === "account") result = state.account;
    if (stage === "exists") result = state.existing ? [{ ROUTINE_NAME: procedure.routineName }] : [];
    if (stage === "session") result = [{ ...state.session }];
    if (stage === "identity") result = state.identity;
    if (stage === "parameters") result = state.parameters;
    if (stage === "restore") {
      const [client, results, connection, collation, mode] = values ?? [];
      state.session = { character_set_client: String(client), character_set_results: results === null ? null : String(results),
        character_set_connection: String(connection), collation_connection: String(collation), sql_mode: String(mode) };
      state.restored = true;
    }
    if (stage === "create") state.existing = true;
    return [result, []];
  });
  return { state, trace, query, connection: { query: query as unknown as PoolConnection["query"] },
    onQuery(callback: typeof hook) { hook = callback; } };
}
async function rejected(fake: ReturnType<typeof fixture>, config: unknown = CONFIG) {
  const error: unknown = await installSchemaMetadataProcedure(fake.connection, config as SchemaMetadataReaderConfig)
    .then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(SchemaMetadataInstallError);
  expect(error).toMatchObject({ name: "SchemaMetadataInstallError", code: "schema_metadata_install_failed", message: "Schema metadata procedure installation failed." });
  expect(Object.hasOwn(error as object, "cause")).toBe(false);
  return error;
}

describe("fixed metadata procedure installer (query doubles)", () => {
  it("creates only an absent fixed procedure for the locked definer and restores the complete session profile", async () => {
    const fake = fixture(), original = initialSession();
    expect(await installSchemaMetadataProcedure(fake.connection, CONFIG)).toBeUndefined();
    expect(fake.trace.map(entry => entry.stage)).toEqual(["database", "schema", "account", "exists", "session", "names", "mode", "create", "identity", "parameters", "database", "restore", "session"]);
    expect(fake.trace.find(entry => entry.stage === "create")?.sql)
      .toBe(`CREATE DEFINER='metadata_reader'@'localhost' ${procedure.createSql.slice("CREATE ".length)}`);
    expect(fake.trace.find(entry => entry.stage === "mode")?.sql).toBe(`SET SESSION sql_mode='${SQL_MODE}'`);
    expect(fake.state.session).toEqual(original); expect(fake.state.restored).toBe(true);
    expect(fake.trace.every(entry => !/\b(?:DROP|REPLACE|GRANT|CALL|INSERT|UPDATE|DELETE)\b/.test(entry.sql))).toBe(true);
    expect(fake.trace.some(entry => /CREATE (?:DATABASE|USER)/.test(entry.sql))).toBe(false);
    expect(fake.trace.find(entry => entry.stage === "account")?.sql).toContain("SELECT User, Host, account_locked FROM mysql.user");
    expect(fake.trace.find(entry => entry.stage === "account")?.values).toEqual([
      Buffer.from("metadata_reader"), Buffer.from("localhost"), Buffer.from("metadata_reader"), Buffer.from("localhost"),
    ]);
  });

  it("independently verifies an existing exact procedure without SET/CREATE/CALL or an EXECUTE requirement", async () => {
    const fake = fixture(); fake.state.existing = true;
    await installSchemaMetadataProcedure(fake.connection, CONFIG);
    expect(fake.trace.map(entry => entry.stage)).toEqual(["database", "schema", "account", "exists", "identity", "parameters", "database"]);
    expect(fake.state.restored).toBe(false);
  });

  it.each([null, {}, { ...CONFIG, unsafe: true }, { ...CONFIG, trustedDefiner: { ...CONFIG.trustedDefiner, password: "forbidden" } }])
    ("rejects unclosed configuration before any query: %j", async input => {
      const fake = fixture(); await rejected(fake, input); expect(fake.query).not.toHaveBeenCalled();
    });

  it("captures authority before awaits without evaluating getters", async () => {
    const fake = fixture(), config = structuredClone(CONFIG);
    fake.onQuery(stage => { if (stage === "database") { config.metadataSchema = "changed"; config.trustedDefiner.user = "changed"; } });
    await installSchemaMetadataProcedure(fake.connection, config);
    expect(fake.trace.find(entry => entry.stage === "create")?.sql).toContain("DEFINER='metadata_reader'@'localhost'");
    const getter = vi.fn(() => META), invalid = { ...CONFIG };
    Object.defineProperty(invalid, "metadataSchema", { enumerable: true, get: getter });
    const other = fixture(); await rejected(other, invalid); expect(other.query).not.toHaveBeenCalled(); expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    { schema: [] }, { schema: [{ SCHEMA_NAME: META, DEFAULT_CHARACTER_SET_NAME: "utf8", DEFAULT_COLLATION_NAME: "utf8mb4_0900_ai_ci" }] },
    { schema: [{ SCHEMA_NAME: META, DEFAULT_CHARACTER_SET_NAME: "utf8mb4", DEFAULT_COLLATION_NAME: "utf8mb4_bin" }] },
    { schema: [{ SCHEMA_NAME: "other", DEFAULT_CHARACTER_SET_NAME: "utf8mb4", DEFAULT_COLLATION_NAME: "utf8mb4_0900_ai_ci" }] },
    { account: [] }, { account: [{ User: "other", Host: "localhost", account_locked: "Y" }] },
    { account: [{ User: "metadata_reader", Host: "%", account_locked: "Y" }] },
    { account: [{ User: "metadata_reader", Host: "localhost", account_locked: "N" }] },
  ])("never repairs a missing/drifting schema or unlocked/mismatched account: %j", async extra => {
    const fake = fixture(); Object.assign(fake.state, extra); await rejected(fake);
    expect(fake.trace.some(entry => entry.stage === "create" || entry.stage === "names" || entry.stage === "mode")).toBe(false);
  });

  it.each(Object.keys(identity()))("refuses an existing procedure with changed %s, without replacing it", async key => {
    const fake = fixture(); fake.state.existing = true; fake.state.identity = [identity({ [key]: "changed" })];
    await rejected(fake); expect(fake.trace.some(entry => entry.stage === "create" || entry.stage === "names")).toBe(false);
  });

  it("rejects parameter drift and verifies creation without manufacturing EXECUTE or CALL", async () => {
    const fake = fixture(); fake.state.parameters = [{ parameter_count: 1 }]; await rejected(fake);
    expect(fake.state.existing).toBe(true); expect(fake.state.restored).toBe(true);
    expect(fake.trace.some(entry => entry.sql.startsWith("CALL "))).toBe(false);
  });

  it("quotes apostrophes and backslashes only after installing the fixed creation SQL mode", async () => {
    const fake = fixture(), config = { metadataSchema: META, trustedDefiner: { user: "u'\\x", host: "h'\\x" } };
    fake.state.account = [{ User: config.trustedDefiner.user, Host: config.trustedDefiner.host, account_locked: "Y" }];
    fake.state.identity = [identity({ DEFINER: `${config.trustedDefiner.user}@${config.trustedDefiner.host}` })];
    await installSchemaMetadataProcedure(fake.connection, config);
    const create = fake.trace.findIndex(entry => entry.stage === "create"), mode = fake.trace.findIndex(entry => entry.stage === "mode");
    expect(create).toBeGreaterThan(mode);
    expect(fake.trace[create]?.sql).toBe(`CREATE DEFINER='u''\\\\x'@'h''\\\\x' ${procedure.createSql.slice("CREATE ".length)}`);
  });

  it.each(["names", "mode", "create", "identity"] as const)("restores after a real awaited %s error, without claiming DDL rollback", async stage => {
    const fake = fixture(); fake.onQuery(current => { if (current === stage) throw new Error("private operator SQL detail"); });
    const error = await rejected(fake);
    expect(fake.state.restored).toBe(true); expect(fake.state.session).toEqual(initialSession());
    expect(String(error)).not.toContain("private operator");
    expect(fake.trace.filter(entry => entry.stage === "create").length).toBe(stage === "identity" || stage === "create" ? 1 : 0);
  });

  it("fails closed when restoration fails or its readback is not exact, without retrying CREATE", async () => {
    const failedRestore = fixture(); failedRestore.onQuery(stage => { if (stage === "restore") throw new Error("restore failed"); });
    await rejected(failedRestore); expect(failedRestore.trace.filter(entry => entry.stage === "create")).toHaveLength(1);
    const wrongReadback = fixture(); wrongReadback.onQuery(stage => {
      if (stage === "session" && wrongReadback.state.restored) wrongReadback.state.session.sql_mode = "";
    });
    await rejected(wrongReadback); expect(wrongReadback.state.existing).toBe(true);
  });

  it("rejects changed actual database after installation and restores before returning failure", async () => {
    const fake = fixture(); fake.onQuery(stage => { if (stage === "identity") fake.state.actualDatabase = "other"; });
    await rejected(fake); expect(fake.state.restored).toBe(true);
  });

  it("waits for original CREATE and restore promises to settle; it does not abandon native work", async () => {
    const fake = fixture(); let releaseCreate!: () => void, releaseRestore!: () => void, enteredCreate!: () => void, enteredRestore!: () => void;
    const create = new Promise<void>(resolve => { releaseCreate = resolve; }), restoring = new Promise<void>(resolve => { releaseRestore = resolve; });
    const started = new Promise<void>(resolve => { enteredCreate = resolve; }), closed = new Promise<void>(resolve => { enteredRestore = resolve; });
    fake.onQuery(async stage => { if (stage === "create") { enteredCreate(); await create; } if (stage === "restore") { enteredRestore(); await restoring; } });
    let settled = false;
    const operation = installSchemaMetadataProcedure(fake.connection, CONFIG).then(
      () => { settled = true; return { ok: true } as const; },
      (error: unknown) => { settled = true; return { ok: false, error } as const; },
    );
    try { await started; expect(settled).toBe(false); releaseCreate(); await closed; expect(settled).toBe(false); }
    finally { releaseCreate(); releaseRestore(); }
    expect(await operation).toEqual({ ok: true }); expect(settled).toBe(true); expect(fake.state.restored).toBe(true);
  });
});
