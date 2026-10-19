import type { PoolConnection } from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";
import { buildSchemaMetadataProcedure } from "../src/mysql/schema-metadata-codec.js";
import { readSchemaTriggerMetadata, SchemaMetadataReadError, type SchemaMetadataReaderConfig } from "../src/mysql/schema-metadata.js";

// Query doubles prove the reader contract, not real MySQL privilege or JSON_TABLE behavior.
const APP = "schema_reader_fixture", META = "schema_metadata_fixture";
const CONFIG = { metadataSchema: META, trustedDefiner: { user: "metadata_reader", host: "localhost" } };
const SQL_MODE = "STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION";
const MAX_ROWS = 16_384, MAX_BYTES = 32 * 1024 * 1024;
const procedure = buildSchemaMetadataProcedure(APP, META);

function row(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { TRIGGER_SCHEMA: APP, TRIGGER_NAME: "trg_fixture_bi", EVENT_MANIPULATION: "INSERT",
    EVENT_OBJECT_TABLE: "fixture", ACTION_ORDER: 1, ACTION_CONDITION: null,
    ACTION_STATEMENT: "BEGIN\n  SET @fixture = 'literal UTF8 中';\nEND", ACTION_ORIENTATION: "ROW", ACTION_TIMING: "BEFORE", ...extra };
}
function routine(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...procedure.expectedAttributes, ROUTINE_DEFINITION: procedure.expectedDefinition,
    DEFINER: "metadata_reader@localhost", SQL_MODE, CHARACTER_SET_CLIENT: "utf8mb4",
    COLLATION_CONNECTION: "utf8mb4_0900_ai_ci", DATABASE_COLLATION: "utf8mb4_0900_ai_ci", ...extra };
}
function header(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { fieldCount: 0, affectedRows: 0, insertId: 0, info: "", serverStatus: 16386, warningStatus: 0,
    stateChanges: { systemVariables: {}, schema: APP, gtids: [], trackStateChange: null }, changedRows: 0, ...extra };
}
type Stage = "database" | "routine" | "parameters" | "call";
function fixture() {
  const trace: { stage: Stage; sql: string; values: unknown[] | undefined }[] = [];
  const visits = { database: 0, routine: 0, parameters: 0, call: 0 };
  const replies: Record<Stage, (visit: number) => unknown> = {
    database: () => [{ application_database: APP }], routine: () => [routine()],
    parameters: () => [{ parameter_count: 0 }], call: () => [[row()], header()],
  };
  let beforeReply: (stage: Stage, visit: number) => void | Promise<void> = () => {};
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    const stage: Stage = sql === "SELECT DATABASE() AS application_database" ? "database"
      : sql.includes("FROM information_schema.ROUTINES") ? "routine"
      : sql.includes("FROM information_schema.PARAMETERS") ? "parameters"
      : sql === procedure.callSql ? "call" : (() => { throw new Error("Unexpected fixture query"); })();
    trace.push({ stage, sql, values });
    const visit = ++visits[stage]; await beforeReply(stage, visit);
    return [replies[stage](visit), []];
  });
  // An honest overloaded mysql2 query double; no real connection/permission is claimed.
  const connection = { query: query as unknown as PoolConnection["query"] };
  return { connection, query, trace, replies, visits,
    onQuery(callback: typeof beforeReply) { beforeReply = callback; } };
}
async function invalid(fake: ReturnType<typeof fixture>, config: unknown = CONFIG) {
  const error: unknown = await readSchemaTriggerMetadata(fake.connection, config as SchemaMetadataReaderConfig)
    .then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(SchemaMetadataReadError);
  expect(error).toMatchObject({ name: "SchemaMetadataReadError", code: "schema_metadata_invalid", message: "Schema trigger metadata is invalid." });
  expect(Object.hasOwn(error as object, "cause")).toBe(false);
  return error;
}

describe("fresh restricted schema metadata reader (query doubles)", () => {
  it("checks the actual database and full procedure identity before and after the one CALL", async () => {
    const fake = fixture(), result = await readSchemaTriggerMetadata(fake.connection, CONFIG);
    expect(result).toEqual({ applicationDatabase: APP, rows: [row()] });
    expect(fake.trace.map(entry => entry.stage)).toEqual(["database", "routine", "parameters", "call", "database", "routine", "parameters"]);
    for (const entry of fake.trace.filter(entry => entry.stage === "routine" || entry.stage === "parameters")) {
      expect(entry.values).toEqual([META, procedure.routineName, META, procedure.routineName]);
      expect(entry.sql).toContain("BINARY");
    }
    expect(fake.trace.filter(entry => entry.stage === "call").map(entry => entry.sql)).toEqual([procedure.callSql]);
    expect(fake.trace.every(entry => /^(SELECT|CALL)\b/.test(entry.sql))).toBe(true);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.rows)).toBe(true);
    expect(Object.isFrozen(result.rows[0])).toBe(true);
  });

  it("allows an honestly empty complete trigger set and optional deprecated changedRows absence", async () => {
    const fake = fixture(), packet = header(); delete packet.changedRows; delete packet.stateChanges;
    fake.replies.call = () => [[], packet];
    expect(await readSchemaTriggerMetadata(fake.connection, CONFIG)).toEqual({ applicationDatabase: APP, rows: [] });
  });

  it("accepts native packet/row prototypes without instanceof and preserves statement bytes", async () => {
    const fake = fixture(), statement = "\nBEGIN\r\n SET @a = '  UTF8 中 \\0 '; /* untouched */\nEND ";
    fake.replies.call = () => [[Object.assign(Object.create({ nativeRow: true }), row({ ACTION_STATEMENT: statement }))],
      Object.assign(Object.create({ nativePacket: true }), header())];
    const result = await readSchemaTriggerMetadata(fake.connection, CONFIG);
    expect(result.rows[0]?.ACTION_STATEMENT).toBe(statement);
    expect(Object.getPrototypeOf(result.rows[0])).toBe(Object.prototype);
  });

  it("captures closed configuration before the first await and never caches the result", async () => {
    const fake = fixture(), config = structuredClone(CONFIG);
    fake.onQuery((stage, visit) => { if (stage === "database" && visit === 1) {
      config.metadataSchema = "changed_schema"; config.trustedDefiner.user = "changed_user";
    } });
    await readSchemaTriggerMetadata(fake.connection, config);
    expect(fake.trace.find(entry => entry.stage === "routine")?.values?.[0]).toBe(META);
    fake.onQuery(() => {}); fake.replies.routine = () => [routine({ SECURITY_TYPE: "INVOKER" })];
    await invalid(fake); expect(fake.visits.call).toBe(1);
  });

  it.each([
    null, {}, { ...CONFIG, extra: true }, { ...CONFIG, metadataSchema: "bad.schema" },
    { ...CONFIG, metadataSchema: "Upper" },
    { ...CONFIG, trustedDefiner: null }, { ...CONFIG, trustedDefiner: { ...CONFIG.trustedDefiner, password: "not-accepted" } },
    { ...CONFIG, trustedDefiner: { user: "", host: "localhost" } },
    { ...CONFIG, trustedDefiner: { user: "x".repeat(33), host: "localhost" } },
    { ...CONFIG, trustedDefiner: { user: "user@host", host: "localhost" } },
    { ...CONFIG, trustedDefiner: { user: "metadata_reader", host: "bad\nhost" } },
    { ...CONFIG, trustedDefiner: { user: "metadata_reader", host: "\ud800" } },
  ])("rejects invalid or authority-expanding configuration without querying: %j", async config => {
    const fake = fixture(); await invalid(fake, config); expect(fake.query).not.toHaveBeenCalled();
  });

  it("does not evaluate config getters, hidden keys, symbol keys, or inherited policy", async () => {
    const getter = vi.fn(() => META), config = { ...CONFIG };
    Object.defineProperty(config, "metadataSchema", { enumerable: true, get: getter });
    const hidden = { ...CONFIG }; Object.defineProperty(hidden, "skip", { value: true });
    const symbol = { ...CONFIG }; Object.defineProperty(symbol, Symbol("skip"), { value: true });
    const inherited = Object.assign(Object.create({ skip: true }), CONFIG);
    const nested = structuredClone(CONFIG); Object.defineProperty(nested.trustedDefiner, "user", { enumerable: true, get: getter });
    for (const input of [config, hidden, symbol, inherited, nested]) {
      const fake = fixture(); await invalid(fake, input); expect(fake.query).not.toHaveBeenCalled();
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([null, "", "\ud800", "x".repeat(65), "bad/name", "bad\\name"])("rejects an invalid actual database: %j", async name => {
    const fake = fixture(); fake.replies.database = () => [{ application_database: name }];
    await invalid(fake); expect(fake.visits.routine).toBe(0);
  });

  it("rejects a metadata schema equal to the actual database after reading that database", async () => {
    const fake = fixture(); await invalid(fake, { ...CONFIG, metadataSchema: APP });
    expect(fake.visits).toEqual({ database: 1, routine: 0, parameters: 0, call: 0 });
  });

  it.each(Object.keys(routine()))("requires exact fresh routine attribute %s", async key => {
    const fake = fixture(); fake.replies.routine = () => [routine({ [key]: `${String(routine()[key])} changed` })];
    await invalid(fake); expect(fake.visits.call).toBe(0);
  });

  it.each([{ rows: [] }, { rows: [routine(), routine()] }, { rows: [routine({ ROUTINE_DEFINITION: null })] }, { rows: [routine({ unknown: true })] }])
    ("rejects missing, ambiguous, hidden or unclosed routine metadata: %j", async ({ rows }) => {
      const fake = fixture(); fake.replies.routine = () => rows; await invalid(fake); expect(fake.visits.call).toBe(0);
    });

  it.each([1, "1", null, undefined, -1, 0.1, "00"])("requires the exact zero parameter count: %j", async count => {
    const fake = fixture(); fake.replies.parameters = () => [{ parameter_count: count }];
    await invalid(fake); expect(fake.visits.call).toBe(0);
  });

  it("accepts the driver's exact string zero count and rejects database or definition drift after CALL", async () => {
    const good = fixture(); good.replies.parameters = () => [{ parameter_count: "0" }];
    await readSchemaTriggerMetadata(good.connection, CONFIG);
    const changedDatabase = fixture(); changedDatabase.replies.database = visit => [{ application_database: visit === 1 ? APP : "other_database" }];
    await invalid(changedDatabase); expect(changedDatabase.visits.call).toBe(1);
    const changedDefinition = fixture(); changedDefinition.replies.routine = visit => [routine(visit === 1 ? {} : { ROUTINE_DEFINITION: "SELECT 1" })];
    await invalid(changedDefinition); expect(changedDefinition.visits.call).toBe(1);
    const changedParameters = fixture(); changedParameters.replies.parameters = visit => [{ parameter_count: visit === 1 ? 0 : 1 }];
    await invalid(changedParameters); expect(changedParameters.visits.call).toBe(1);
  });

  it.each([{ result: [] }, { result: [[row()]] }, { result: [[row()], header(), header()] }, { result: [header(), [row()]] }, { result: [[row()], null] }])
    ("requires one complete rowset and one native zero-effect terminal packet: %j", async ({ result }) => {
      const fake = fixture(); fake.replies.call = () => result; await invalid(fake);
    });

  it.each([
    { fieldCount: 1 }, { affectedRows: 1 }, { insertId: 1 }, { info: "changed" }, { warningStatus: 1 }, { changedRows: 1 },
    { serverStatus: 8 }, { serverStatus: 4096 }, { serverStatus: -1 }, { serverStatus: 65536 }, { serverStatus: 0.5 },
    { serverStatus: "2" }, { unknown: "not-a-native-field" }, { stateChanges: null },
    { stateChanges: { systemVariables: {}, schema: null, gtids: [], trackStateChange: null, unknown: true } },
    { stateChanges: { systemVariables: { sql_mode: 123 }, schema: null, gtids: [], trackStateChange: null } },
    { stateChanges: { systemVariables: {}, schema: 1, gtids: [], trackStateChange: null } },
    { stateChanges: { systemVariables: {}, schema: null, gtids: [1], trackStateChange: null } },
  ])("rejects a changed or malformed final packet: %j", async extra => {
    const fake = fixture(); fake.replies.call = () => [[row()], header(extra)]; await invalid(fake);
  });

  it("does not treat connection-local session tracking as an authority or pin transaction flags", async () => {
    const fake = fixture(); fake.replies.call = () => [[row()], header({ serverStatus: 16385,
      stateChanges: { systemVariables: { sql_mode: SQL_MODE }, schema: "previous_connection_schema", gtids: ["uuid:1"], trackStateChange: "1" } })];
    expect((await readSchemaTriggerMetadata(fake.connection, CONFIG)).applicationDatabase).toBe(APP);
  });

  it.each([
    { TRIGGER_SCHEMA: "other" }, { TRIGGER_NAME: "" }, { TRIGGER_NAME: "x".repeat(65) }, { TRIGGER_NAME: "bad\0name" },
    { EVENT_OBJECT_TABLE: "" }, { EVENT_MANIPULATION: "REPLACE" }, { ACTION_ORDER: 0 }, { ACTION_ORDER: -1 },
    { ACTION_ORDER: "1" }, { ACTION_ORDER: 1.1 }, { ACTION_ORDER: 4294967296 },
    { ACTION_CONDITION: "" }, { ACTION_CONDITION: Buffer.alloc(0) }, { ACTION_CONDITION: undefined },
    { ACTION_STATEMENT: Buffer.from("statement") }, { ACTION_STATEMENT: "\ud800" },
    { ACTION_ORIENTATION: "STATEMENT" }, { ACTION_TIMING: "INSTEAD" }, { CREATED: null },
  ])("rejects incomplete, aliased or malformed native trigger fields: %j", async extra => {
    const fake = fixture(); fake.replies.call = () => [[row(extra)], header()]; await invalid(fake);
  });

  it("rejects duplicates, missing fields and getters without reading their value", async () => {
    const duplicate = fixture(); duplicate.replies.call = () => [[row(), row()], header()]; await invalid(duplicate);
    const missing = fixture(), incomplete = row(); delete incomplete.ACTION_CONDITION;
    missing.replies.call = () => [[incomplete], header()]; await invalid(missing);
    const access = vi.fn(() => "not-read"), candidate = row();
    Object.defineProperty(candidate, "ACTION_STATEMENT", { enumerable: true, get: access });
    const getter = fixture(); getter.replies.call = () => [[candidate], header()]; await invalid(getter);
    expect(access).not.toHaveBeenCalled();
    const sparse = fixture(); sparse.replies.call = () => [new Array(1), header()]; await invalid(sparse);
  });

  it("keeps NULL distinct from empty data while allowing empty statement bytes and exact Unicode names", async () => {
    const fake = fixture(); fake.replies.call = () => [[row({ TRIGGER_NAME: "é", ACTION_STATEMENT: "" }),
      row({ TRIGGER_NAME: "e\u0301", ACTION_ORDER: 2 })], header()];
    const result = await readSchemaTriggerMetadata(fake.connection, CONFIG);
    expect(result.rows.map(item => item.TRIGGER_NAME)).toEqual(["é", "e\u0301"]);
    expect(result.rows[0]?.ACTION_CONDITION).toBeNull(); expect(result.rows[0]?.ACTION_STATEMENT).toBe("");
  });

  it("accepts the complete row bound and rejects one more row without truncating", async () => {
    const fake = fixture(); fake.replies.call = () => [Array.from({ length: MAX_ROWS }, (_, index) => row({ TRIGGER_NAME: `trg_${index}` })), header()];
    expect((await readSchemaTriggerMetadata(fake.connection, CONFIG)).rows).toHaveLength(MAX_ROWS);
    fake.replies.call = () => [Array.from({ length: MAX_ROWS + 1 }, (_, index) => row({ TRIGGER_NAME: `trg_${index}` })), header()];
    await invalid(fake);
  });

  it("bounds the exact UTF8 JSON after driver allocation, accepting the limit but never a truncated suffix", async () => {
    const empty = row({ ACTION_STATEMENT: "" });
    const remaining = MAX_BYTES - Buffer.byteLength(JSON.stringify([empty]), "utf8");
    const exact = row({ ACTION_STATEMENT: "x".repeat(remaining) }), fake = fixture();
    fake.replies.call = () => [[exact], header()];
    expect((await readSchemaTriggerMetadata(fake.connection, CONFIG)).rows[0]?.ACTION_STATEMENT.length).toBe(remaining);
    fake.replies.call = () => [[row({ ACTION_STATEMENT: "x".repeat(remaining + 1) })], header()]; await invalid(fake);
  });

  it("awaits the original query and replaces driver errors without exposing SQL, accounts, or row contents", async () => {
    const fake = fixture(); let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    fake.onQuery(async stage => { if (stage === "call") { entered(); await blocked; throw new Error("private-fixture-sql-and-secret"); } });
    let settled = false;
    const result = invalid(fake).then(error => { settled = true; return error; });
    try { await started; await Promise.resolve(); expect(settled).toBe(false); }
    finally { release(); }
    const error = await result;
    expect(String(error)).not.toContain("private-fixture"); expect(Object.keys(error as object)).toEqual(["code", "name"]);
  });
});
