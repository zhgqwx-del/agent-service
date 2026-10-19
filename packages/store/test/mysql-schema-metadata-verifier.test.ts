import type { PoolConnection } from "mysql2/promise";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_TRIGGER_METADATA_VARIABLE } from "../src/mysql/schema-metadata-codec.js";
import type { SchemaMetadataReaderConfig, SchemaTriggerMetadataSnapshot } from "../src/mysql/schema-metadata.js";
import { SchemaMetadataVerifierError, withSchemaTriggerMetadataVerifier } from "../src/mysql/schema-metadata-verifier.js";

const reader = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../src/mysql/schema-metadata.js", () => ({ readSchemaTriggerMetadata: reader.read }));

const config: SchemaMetadataReaderConfig = { metadataSchema: "fixture_metadata", trustedDefiner: { user: "fixture_reader", host: "localhost" } };
const SQL = "SELECT COUNT(*) AS trigger_count FROM information_schema.triggers WHERE trigger_schema=DATABASE()";
const SET = `SET ${SCHEMA_TRIGGER_METADATA_VARIABLE}=?`;
const CLEAR = `SET ${SCHEMA_TRIGGER_METADATA_VARIABLE}=NULL`;
const EXACT_BINARY_1287_MESSAGE = "'BINARY expr' is deprecated and will be removed in a future release. Please use CAST instead";
type Result = [unknown, unknown[]];
type Facade = Pick<PoolConnection, "query">;
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function snapshot(name = "trg_fixture"): SchemaTriggerMetadataSnapshot {
  return Object.freeze({ applicationDatabase: "fixture_app", rows: Object.freeze([Object.freeze({
    TRIGGER_SCHEMA: "fixture_app", TRIGGER_NAME: name, EVENT_MANIPULATION: "INSERT" as const,
    EVENT_OBJECT_TABLE: "fixture_table", ACTION_ORDER: 1, ACTION_CONDITION: null,
    ACTION_STATEMENT: "BEGIN SET @ordinary_fixture=1; END", ACTION_ORIENTATION: "ROW" as const, ACTION_TIMING: "BEFORE" as const,
  })]) });
}
function driver() {
  const trace: { sql: string; args: unknown[] }[] = [];
  const result: Result = [[{ trigger_count: 842 }], [{ name: "trigger_count" }]];
  const state: {
    metadata: unknown; countRows: unknown; warningRows: unknown; clearError: boolean; setError: boolean;
    native?: (sql: string) => Promise<Result>; showError?: string;
  } = { metadata: "previous-connection-value", countRows: [{ "@@session.warning_count": 0 }], warningRows: [], clearError: false, setError: false };
  const query = vi.fn(async (...args: unknown[]): Promise<Result> => {
    const input = args[0];
    const sql = typeof input === "string" ? input : (input as { sql: string }).sql;
    trace.push({ sql, args });
    if (sql === SET) {
      if (state.setError) throw new Error("secret-driver-setup-canary");
      state.metadata = JSON.parse(String((args[1] as unknown[])[0])); return [{ affectedRows: 0 }, []];
    }
    if (sql === CLEAR) {
      if (state.clearError) throw new Error("secret-driver-cleanup-canary");
      state.metadata = null; return [{ affectedRows: 0 }, []];
    }
    if (sql === state.showError) throw new Error("secret-driver-warning-canary");
    if (sql === "SHOW COUNT(*) WARNINGS") return [state.countRows, []];
    if (sql === "SHOW WARNINGS") return [state.warningRows, []];
    return state.native ? await state.native(sql) : result;
  });
  const destroy = vi.fn();
  const conn: Pick<PoolConnection, "query" | "destroy"> = { query: query as PoolConnection["query"], destroy };
  return { conn, query, destroy, trace, state, result };
}

describe("private schema trigger metadata verifier facade (driver doubles only)", () => {
  beforeEach(() => { reader.read.mockReset(); reader.read.mockResolvedValue(snapshot()); });

  it("installs fresh JSON on the exact reader connection, preserves native result identity and clears before returning", async () => {
    const fake = driver(), nativeQuery = fake.conn.query;
    const result = await withSchemaTriggerMetadataVerifier(fake.conn, config, async facade => {
      expect(Object.keys(facade)).toEqual(["query"]); expect(Object.isFrozen(facade)).toBe(true);
      expect(fake.state.metadata).toEqual(snapshot().rows);
      return await facade.query(SQL);
    });
    expect(result).toBe(fake.result);
    expect(reader.read).toHaveBeenCalledExactlyOnceWith(fake.conn, config);
    expect(fake.conn.query).toBe(nativeQuery); expect(fake.destroy).not.toHaveBeenCalled();
    expect(fake.state.metadata).toBeNull();
    expect(fake.trace.map(entry => entry.sql)).toEqual([SET, expect.stringContaining("JSON_TABLE("), "SHOW COUNT(*) WARNINGS", "SHOW WARNINGS", CLEAR]);
    expect(fake.trace[1]?.sql).not.toContain("FROM information_schema.triggers");
  });

  it("requires an explicit lexical no-relation result for passthrough and does not add warning queries to it", async () => {
    const fake = driver(); fake.state.countRows = [{ "@@session.warning_count": 999 }];
    const ordinary = "SELECT 'FROM information_schema.triggers' AS sample /* JOIN information_schema.triggers */";
    expect(await withSchemaTriggerMetadataVerifier(fake.conn, config, async facade => await facade.query(ordinary))).toBe(fake.result);
    expect(fake.trace.map(entry => entry.sql)).toEqual([SET, ordinary, CLEAR]);
  });

  it.each([
    "SELECT CREATED FROM information_schema.triggers",
    "SELECT information_schema.triggers.trigger_name FROM information_schema.tables",
    "SELECT @agent_service_schema_trigger_metadata_v1 FROM information_schema.triggers",
  ])("never falls back to original SQL after a real but unsupported reference: %s", async sql => {
    const fake = driver();
    await expect(withSchemaTriggerMetadataVerifier(fake.conn, config, async facade => { await facade.query(sql); }))
      .rejects.toBeInstanceOf(SchemaMetadataVerifierError);
    expect(fake.trace.map(entry => entry.sql)).toEqual([SET, CLEAR]);
  });

  it("fences a swallowed codec failure instead of publishing a successful callback result", async () => {
    const fake = driver();
    await expect(withSchemaTriggerMetadataVerifier(fake.conn, config, async facade => {
      await facade.query("SELECT CREATED FROM information_schema.triggers").catch(() => {});
      await facade.query("SELECT 1").catch(() => {});
      return "not-authoritative";
    })).rejects.toBeInstanceOf(SchemaMetadataVerifierError);
    expect(fake.trace.map(entry => entry.sql)).toEqual([SET, CLEAR]);
  });

  it("clears JSON between connection reuses and reads a fresh snapshot for every new scope", async () => {
    const fake = driver();
    await withSchemaTriggerMetadataVerifier(fake.conn, config, async () => {});
    expect(fake.state.metadata).toBeNull(); reader.read.mockResolvedValueOnce(snapshot("trg_new"));
    await withSchemaTriggerMetadataVerifier(fake.conn, config, async () => { expect(fake.state.metadata).toEqual(snapshot("trg_new").rows); });
    expect(fake.trace.map(entry => entry.sql)).toEqual([SET, CLEAR, SET, CLEAR]);
    expect(reader.read).toHaveBeenCalledTimes(2);
  });

  it("rejects a retained facade after its callback scope closes without any new native I/O", async () => {
    const fake = driver(); let saved: Facade | undefined;
    await withSchemaTriggerMetadataVerifier(fake.conn, config, async facade => { saved = facade; });
    if (!saved) throw new Error("fixture facade was not captured");
    await expect(saved.query(SQL)).rejects.toBeInstanceOf(SchemaMetadataVerifierError);
    expect(fake.trace.map(entry => entry.sql)).toEqual([SET, CLEAR]);
  });

  it("serializes query plus diagnostics as a unit rather than mixing concurrent warning windows", async () => {
    const fake = driver();
    const result = await withSchemaTriggerMetadataVerifier(fake.conn, config, async facade => await Promise.all([facade.query(SQL), facade.query(SQL)]));
    expect(result[0]).toBe(fake.result); expect(result[1]).toBe(fake.result);
    expect(fake.trace.map(entry => entry.sql)).toEqual([SET, expect.stringContaining("JSON_TABLE("), "SHOW COUNT(*) WARNINGS", "SHOW WARNINGS",
      expect.stringContaining("JSON_TABLE("), "SHOW COUNT(*) WARNINGS", "SHOW WARNINGS", CLEAR]);
  });

  it("waits for a detached accepted native query and its warnings before clearing or resolving", async () => {
    const fake = driver(), entered = deferred<void>(), release = deferred<Result>();
    fake.state.native = async () => { entered.resolve(); return await release.promise; };
    let settled = false;
    const running = withSchemaTriggerMetadataVerifier(fake.conn, config, async facade => { void facade.query(SQL); return "done"; });
    const observed = running.then(value => { settled = true; return value; });
    try {
      await entered.promise; await Promise.resolve();
      expect(settled).toBe(false); expect(fake.trace.some(entry => entry.sql === CLEAR)).toBe(false);
    } finally { release.resolve(fake.result); }
    expect(await observed).toBe("done"); expect(fake.state.metadata).toBeNull();
    expect(fake.trace.at(-2)?.sql).toBe("SHOW WARNINGS"); expect(fake.trace.at(-1)?.sql).toBe(CLEAR);
  });

  it("does not hide failure from a detached native query, even when the callback already returned", async () => {
    const fake = driver(), entered = deferred<void>(), release = deferred<void>();
    fake.state.native = async () => { entered.resolve(); await release.promise; throw new Error("secret-driver-native-canary"); };
    const running = withSchemaTriggerMetadataVerifier(fake.conn, config, async facade => { void facade.query(SQL); return "not-success"; });
    const observed = running.then(value => ({ value }), error => ({ error }));
    await entered.promise; expect(fake.trace.some(entry => entry.sql === CLEAR)).toBe(false); release.resolve();
    expect(await observed).toMatchObject({ error: { name: "SchemaMetadataVerifierError", code: "schema_metadata_invalid" } });
    expect(fake.state.metadata).toBeNull();
  });

  it("retains the original callback fingerprint error but still drains a held native query first", async () => {
    const fake = driver(), entered = deferred<void>(), release = deferred<Result>(), fingerprint = new Error("controlled fingerprint mismatch");
    fake.state.native = async () => { entered.resolve(); return await release.promise; };
    let settled = false;
    const running = withSchemaTriggerMetadataVerifier(fake.conn, config, async facade => { void facade.query(SQL); throw fingerprint; });
    const observed = running.then(value => ({ value }), error => { settled = true; return { error }; });
    try { await entered.promise; await Promise.resolve(); expect(settled).toBe(false); }
    finally { release.resolve(fake.result); }
    expect(await observed).toEqual({ error: fingerprint }); expect(fake.state.metadata).toBeNull();
  });

  it("destroys the exact native connection and replaces cleanup/driver details with a fixed bridge error", async () => {
    const fake = driver(); fake.state.clearError = true;
    let error: unknown;
    try { await withSchemaTriggerMetadataVerifier(fake.conn, config, async () => { throw new Error("original-fingerprint-canary"); }); }
    catch (caught) { error = caught; }
    expect(fake.destroy).toHaveBeenCalledOnce(); expect(fake.destroy.mock.contexts[0]).toBe(fake.conn);
    expect(error).toMatchObject({ name: "SchemaMetadataVerifierError", code: "schema_metadata_invalid", message: "Schema trigger metadata verification failed." });
    expect(String(error)).not.toMatch(/secret-driver|original-fingerprint/);
  });

  it("does not destroy or report cleanup failure before an already accepted native request settles", async () => {
    const fake = driver(), entered = deferred<void>(), release = deferred<Result>(); fake.state.clearError = true;
    fake.state.native = async () => { entered.resolve(); return await release.promise; };
    let settled = false;
    const running = withSchemaTriggerMetadataVerifier(fake.conn, config, async facade => { void facade.query(SQL); });
    const observed = running.then(value => ({ value }), error => { settled = true; return { error }; });
    try {
      await entered.promise; await Promise.resolve();
      expect(settled).toBe(false); expect(fake.destroy).not.toHaveBeenCalled();
      expect(fake.trace.some(entry => entry.sql === CLEAR)).toBe(false);
    } finally { release.resolve(fake.result); }
    expect(await observed).toMatchObject({ error: { name: "SchemaMetadataVerifierError", code: "schema_metadata_invalid" } });
    expect(fake.destroy).toHaveBeenCalledOnce(); expect(fake.trace.at(-1)?.sql).toBe(CLEAR);
  });

  it.each(["reader", "setup"])("never invokes work after %s failure, and still attempts connection-local clear", async failure => {
    const fake = driver(), work = vi.fn(async () => {});
    if (failure === "reader") reader.read.mockRejectedValueOnce(new Error("secret-reader-canary")); else fake.state.setError = true;
    await expect(withSchemaTriggerMetadataVerifier(fake.conn, config, work)).rejects.toBeInstanceOf(SchemaMetadataVerifierError);
    expect(work).not.toHaveBeenCalled(); expect(fake.trace.at(-1)?.sql).toBe(CLEAR); expect(fake.destroy).not.toHaveBeenCalled();
  });

  it("captures query options/scalar parameters before a queue await and rejects mysql SQL-producing hooks", async () => {
    const fake = driver();
    await withSchemaTriggerMetadataVerifier(fake.conn, config, async facade => {
      const options = { sql: SQL + " AND trigger_name=?", timeout: 1000 }, values = ["original_name"];
      const pending = facade.query(options, values); options.sql = "DELETE FROM private_canary"; values[0] = "changed_name";
      await pending;
    });
    expect(fake.trace[1]?.args).toEqual([{ sql: expect.stringContaining("JSON_TABLE("), timeout: 1000 }, ["original_name"]]);
    const fakeUnsafe = driver();
    await expect(withSchemaTriggerMetadataVerifier(fakeUnsafe.conn, config, async facade => {
      await facade.query("SELECT ? FROM information_schema.triggers", [{ toSqlString: () => "untrusted_sql_canary" }]);
    })).rejects.toBeInstanceOf(SchemaMetadataVerifierError);
    expect(fakeUnsafe.trace.map(entry => entry.sql)).toEqual([SET, CLEAR]);
  });

  it.each([3719, 3778])("accepts only the calibrated Level Warning deprecation code %d and preserves original flag rows", async code => {
    const fake = driver(); fake.state.countRows = [{ "@@session.warning_count": "1" }];
    fake.state.warningRows = [{ Level: "Warning", Code: code, Message: "server diagnostic is not an output" }];
    expect(await withSchemaTriggerMetadataVerifier(fake.conn, config, async facade => await facade.query(SQL))).toBe(fake.result);
  });

  it("accepts the calibrated complete fourteen-warning result and all sixty-four bounded rows", async () => {
    for (const count of [14, 64]) {
      const fake = driver(); fake.state.countRows = [{ "@@session.warning_count": count }];
      fake.state.warningRows = Array.from({ length: count }, (_, i) => ({ Level: "Warning", Code: i % 2 ? 3719 : 3778, Message: "diagnostic" }));
      expect(await withSchemaTriggerMetadataVerifier(fake.conn, config, async facade => await facade.query(SQL))).toBe(fake.result);
    }
  });

  it("accepts only the exact calibrated BINARY 1287 warning without changing the native flag/result object", async () => {
    const fake = driver(), originalResult = structuredClone(fake.result);
    fake.state.countRows = [{ "@@session.warning_count": 1 }];
    fake.state.warningRows = [{ Level: "Warning", Code: 1287, Message: EXACT_BINARY_1287_MESSAGE }];
    const result = await withSchemaTriggerMetadataVerifier(fake.conn, config, async facade => await facade.query(SQL));
    expect(result).toBe(fake.result); expect(result[0]).toBe(fake.result[0]); expect(result).toEqual(originalResult);
    expect(fake.state.metadata).toBeNull(); expect(fake.trace.at(-1)?.sql).toBe(CLEAR);
  });

  it.each([14, 64])("accepts a complete mixed 3719/3778/exact-BINARY-1287 diagnostic window of %d rows", async count => {
    const fake = driver(), originalResult = structuredClone(fake.result);
    fake.state.countRows = [{ "@@session.warning_count": count }];
    fake.state.warningRows = Array.from({ length: count }, (_, i) => {
      const code = [3719, 3778, 1287][i % 3];
      return { Level: "Warning", Code: code, Message: code === 1287 ? EXACT_BINARY_1287_MESSAGE : "diagnostic" };
    });
    const result = await withSchemaTriggerMetadataVerifier(fake.conn, config, async facade => await facade.query(SQL));
    expect(result).toBe(fake.result); expect(result[0]).toBe(fake.result[0]); expect(result).toEqual(originalResult);
    expect(fake.state.metadata).toBeNull();
  });

  it.each([
    ["another deprecated feature", "'VALUES function' is deprecated and will be removed in a future release. Please use an alias instead"],
    ["empty message", ""],
    ["lowercase BINARY", EXACT_BINARY_1287_MESSAGE.replace("BINARY", "binary")],
    ["uppercase deprecation prose", EXACT_BINARY_1287_MESSAGE.replace("deprecated", "DEPRECATED")],
    ["missing internal punctuation", EXACT_BINARY_1287_MESSAGE.replace("release.", "release")],
    ["extra terminal punctuation", EXACT_BINARY_1287_MESSAGE + "."],
    ["prefix", "prefix " + EXACT_BINARY_1287_MESSAGE],
    ["suffix", EXACT_BINARY_1287_MESSAGE + " suffix"],
    ["leading space", " " + EXACT_BINARY_1287_MESSAGE],
    ["trailing space", EXACT_BINARY_1287_MESSAGE + " "],
    ["doubled internal space", EXACT_BINARY_1287_MESSAGE.replace("is deprecated", "is  deprecated")],
    ["leading newline", "\n" + EXACT_BINARY_1287_MESSAGE],
    ["trailing newline", EXACT_BINARY_1287_MESSAGE + "\n"],
  ])("rejects code 1287 with a non-exact BINARY diagnostic: %s", async (_label, message) => {
    const fake = driver(); fake.state.countRows = [{ "@@session.warning_count": 1 }];
    fake.state.warningRows = [{ Level: "Warning", Code: 1287, Message: message }];
    await expect(withSchemaTriggerMetadataVerifier(fake.conn, config, async facade => await facade.query(SQL)))
      .rejects.toBeInstanceOf(SchemaMetadataVerifierError);
    expect(fake.state.metadata).toBeNull(); expect(fake.trace.at(-1)?.sql).toBe(CLEAR);
  });

  it.each([
    ["Warning", 0],
    ["Warning", 1286],
    ["Warning", 1288],
    ["Note", 1287],
    ["Error", 1287],
  ])("rejects the exact BINARY message with unapproved level/code %s/%d", async (level, code) => {
    const fake = driver(); fake.state.countRows = [{ "@@session.warning_count": 1 }];
    fake.state.warningRows = [{ Level: level, Code: code, Message: EXACT_BINARY_1287_MESSAGE }];
    await expect(withSchemaTriggerMetadataVerifier(fake.conn, config, async facade => await facade.query(SQL)))
      .rejects.toBeInstanceOf(SchemaMetadataVerifierError);
    expect(fake.state.metadata).toBeNull(); expect(fake.trace.at(-1)?.sql).toBe(CLEAR);
  });

  it.each([
    { count: [], warnings: [] },
    { count: [{ warning_count: 0 }], warnings: [] },
    { count: [{ "@@session.warning_count": 0 }, { "@@session.warning_count": 0 }], warnings: [] },
    { count: [{ "@@session.warning_count": "01" }], warnings: [] },
    { count: [{ "@@session.warning_count": -1 }], warnings: [] },
    { count: [{ "@@session.warning_count": 65 }], warnings: [] },
    { count: [{ "@@session.warning_count": 1 }], warnings: [] },
    { count: [{ "@@session.warning_count": 0 }], warnings: [{ Level: "Warning", Code: 3719, Message: "unexpected extra row" }] },
    { count: [{ "@@session.warning_count": 1 }], warnings: [{ Level: "Warning", Code: 1265, Message: "Data truncated" }] },
    { count: [{ "@@session.warning_count": 1 }], warnings: [{ Level: "Warning", Code: 1366, Message: "Conversion failed" }] },
    { count: [{ "@@session.warning_count": 1 }], warnings: [{ Level: "Note", Code: 3719, Message: "wrong level" }] },
    { count: [{ "@@session.warning_count": 1 }], warnings: [{ Level: "Error", Code: 3778, Message: "wrong level" }] },
    { count: [{ "@@session.warning_count": 1 }], warnings: [{ Level: "Warning", Code: 3719 }] },
    { count: [{ "@@session.warning_count": 1 }], warnings: [{ Level: "Warning", Code: 3719, Message: "text", extra: "hidden" }] },
  ])("rejects incomplete, unbounded, conversion or unapproved warning diagnostics %#", async diagnostic => {
    const fake = driver(); fake.state.countRows = diagnostic.count; fake.state.warningRows = diagnostic.warnings;
    await expect(withSchemaTriggerMetadataVerifier(fake.conn, config, async facade => await facade.query(SQL)))
      .rejects.toBeInstanceOf(SchemaMetadataVerifierError);
    expect(fake.state.metadata).toBeNull();
  });

  it("allows native packet prototypes but never evaluates warning field getters", async () => {
    const fake = driver(); fake.state.countRows = [Object.assign(Object.create({ packet: true }), { "@@session.warning_count": 1 })];
    fake.state.warningRows = [Object.assign(Object.create({ packet: true }), { Level: "Warning", Code: 3719, Message: "diagnostic" })];
    await withSchemaTriggerMetadataVerifier(fake.conn, config, async facade => { await facade.query(SQL); });
    const getter = vi.fn(() => "secret-getter-canary"), candidate = { Level: "Warning", Code: 3719 };
    Object.defineProperty(candidate, "Message", { enumerable: true, get: getter });
    const unsafe = driver(); unsafe.state.countRows = [{ "@@session.warning_count": 1 }]; unsafe.state.warningRows = [candidate];
    await expect(withSchemaTriggerMetadataVerifier(unsafe.conn, config, async facade => await facade.query(SQL))).rejects.toBeInstanceOf(SchemaMetadataVerifierError);
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(["SHOW COUNT(*) WARNINGS", "SHOW WARNINGS"])("does not hide a native %s failure", async sql => {
    const fake = driver(); fake.state.showError = sql;
    await expect(withSchemaTriggerMetadataVerifier(fake.conn, config, async facade => await facade.query(SQL))).rejects.toBeInstanceOf(SchemaMetadataVerifierError);
    expect(fake.state.metadata).toBeNull(); expect(fake.trace.at(-1)?.sql).toBe(CLEAR);
  });
});
