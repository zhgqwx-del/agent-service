import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net, { type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MysqlSessionStore, type MysqlSchemaOperationOptions } from "../src/index.js";
import { buildSchemaMetadataProcedure } from "../src/mysql/schema-metadata-codec.js";

// Driver doubles only: real transport/query cancellation is covered by the MySQL suite.
const state = vi.hoisted(() => ({ createPool: vi.fn() }));
vi.mock("mysql2/promise", async (importOriginal) => {
  const actual = await importOriginal<typeof import("mysql2/promise")>();
  const defaultExport = "default" in actual ? actual.default : actual;
  if (defaultExport === null || typeof defaultExport !== "object" && typeof defaultExport !== "function") {
    throw new Error("MySQL fixture module shape is invalid");
  }
  return { ...actual, default: { ...defaultExport, createPool: state.createPool } };
});
const ACK = "all-application-writers-stopped-v1" as const;
const FILE = "0000_schema_operation_fixture.sql";
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function driver() {
  const trace: string[] = [], applied: string[] = [FILE];
  let destroyed = false;
  const connection = {
    query: vi.fn(async (input: string | { sql: string }, values?: unknown[]): Promise<[unknown, unknown[]]> => {
      const sql = typeof input === "string" ? input : input.sql;
      trace.push(sql);
      if (destroyed) throw Object.assign(new Error("fixture driver closed"), { code: "ABORT_ERR" });
      if (sql.includes("GET_LOCK(")) return [[{ acquired: 1 }], []];
      if (/^SELECT name FROM schema_migrations/.test(sql)) return [applied.map(name => ({ name })), []];
      if (/^INSERT INTO schema_migrations/.test(sql)) applied.push(String(values?.[0]));
      return [[], []];
    }),
    release: vi.fn(),
    destroy: vi.fn(() => { destroyed = true; }),
  };
  const pool = Object.assign(new EventEmitter(), {
    getConnection: vi.fn(async () => { pool.emit("connection", connection); return connection; }),
    end: vi.fn(async () => {}),
  });
  return { trace, applied, connection, pool };
}
const INSTALL_CONFIG = { metadataSchema: "schema_metadata_fixture", trustedDefiner: { user: "metadata_reader", host: "localhost" } };
/** Actual installer code with query replies only; this is not a native MySQL/privilege proof. */
function installationDriver(fake: ReturnType<typeof driver>, onCreate: () => Promise<void> = async () => {}) {
  const base = fake.connection.query.getMockImplementation();
  if (!base) throw new Error("Schema fixture query implementation is missing");
  const procedure = buildSchemaMetadataProcedure("schema_operation_test", INSTALL_CONFIG.metadataSchema);
  const calls: { sql: string; values: unknown[] | undefined }[] = [];
  let exists = false;
  fake.connection.query.mockImplementation(async (input, values) => {
    const sql = typeof input === "string" ? input : input.sql;
    calls.push({ sql, values });
    if (fake.connection.destroy.mock.calls.length) throw Object.assign(new Error("fixture driver closed"), { code: "ABORT_ERR" });
    let result: unknown;
    if (sql.includes("RELEASE_LOCK(")) result = [{ released: 1 }];
    else if (sql === "SELECT DATABASE() AS application_database") result = [{ application_database: "schema_operation_test" }];
    else if (sql.includes("FROM information_schema.SCHEMATA")) result = [{ SCHEMA_NAME: INSTALL_CONFIG.metadataSchema,
      DEFAULT_CHARACTER_SET_NAME: "utf8mb4", DEFAULT_COLLATION_NAME: "utf8mb4_0900_ai_ci" }];
    else if (sql.includes("FROM mysql.user")) result = [{ User: "metadata_reader", Host: "localhost", account_locked: "Y" }];
    else if (sql.startsWith("SELECT ROUTINE_NAME FROM")) result = exists ? [{ ROUTINE_NAME: procedure.routineName }] : [];
    else if (sql.startsWith("SELECT @@SESSION.sql_mode")) result = [{ sql_mode: "", character_set_client: "utf8mb4",
      character_set_results: null, character_set_connection: "utf8mb4", collation_connection: "utf8mb4_0900_ai_ci" }];
    else if (sql.startsWith("SET NAMES ") || sql.startsWith("SET SESSION ")) result = [];
    else if (sql.startsWith("CREATE DEFINER=")) { await onCreate(); exists = true; result = []; }
    else if (sql.includes("FROM information_schema.ROUTINES")) result = [{ ...procedure.expectedAttributes,
      ROUTINE_DEFINITION: procedure.expectedDefinition, DEFINER: "metadata_reader@localhost",
      SQL_MODE: "STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION",
      CHARACTER_SET_CLIENT: "utf8mb4", COLLATION_CONNECTION: "utf8mb4_0900_ai_ci", DATABASE_COLLATION: "utf8mb4_0900_ai_ci" }];
    else if (sql.includes("FROM information_schema.PARAMETERS")) result = [{ parameter_count: 0 }];
    else return base(input, values);
    fake.trace.push(sql); return [result, []];
  });
  return { calls, procedure };
}
describe("restricted one-shot MySQL schema operation (driver double)", () => {
  let directory: string, fake: ReturnType<typeof driver>;
  const url = "mysql://fixture:fake-password@127.0.0.1:3306/schema_operation_test";
  function options(extra: Partial<MysqlSchemaOperationOptions> = {}): MysqlSchemaOperationOptions {
    return { url, operation: "verify", operationAbortSignal: new AbortController().signal,
      migrationsDir: directory, ...extra };
  }
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-service-schema-operation-unit-"));
    await writeFile(join(directory, FILE), "SELECT 1;\n", { flag: "wx", mode: 0o600 });
    fake = driver(); state.createPool.mockReset().mockReturnValue(fake.pool);
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it.each([undefined, "apply", "reconcile-telemetry-subjects"] as const)
    ("rejects schema metadata with non-verify mode %j before opening a pool", async migrationMode => {
      await expect(MysqlSessionStore.connect({ url, migrationMode,
        schemaMetadata: { metadataSchema: "schema_metadata_fixture", trustedDefiner: { user: "metadata_reader", host: "localhost" } },
      })).rejects.toThrow("schema metadata bridge requires explicit verify-only mode");
      expect(state.createPool).not.toHaveBeenCalled();
    });

  it("rejects authority-expanding metadata configuration before opening a pool", async () => {
    await expect(MysqlSessionStore.connect({ url, migrationMode: "verify",
      schemaMetadata: { metadataSchema: "schema_metadata_fixture", trustedDefiner: { user: "metadata_reader", host: "localhost" }, skip: true } as never,
    })).rejects.toMatchObject({ name: "SchemaMetadataReadError", code: "schema_metadata_invalid" });
    expect(state.createPool).not.toHaveBeenCalled();
  });

  it("waits for native close on metadata startup failure without requiring a caller abort signal", async () => {
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn(), setNoDelay: vi.fn(), setKeepAlive: vi.fn() });
    const connect = vi.spyOn(net, "createConnection").mockReturnValue(socket as unknown as Socket);
    const poolEnded = deferred<void>();
    fake.pool.end.mockImplementation(async () => { poolEnded.resolve(); });
    state.createPool.mockImplementation((config: { stream(options: { config: { host: string; port: number } }): Socket }) => {
      config.stream({ config: { host: "fixture.invalid", port: 3306 } });
      return fake.pool;
    });
    let finished = false;
    const pending = MysqlSessionStore.connect({ url, migrationMode: "verify", schemaMetadata: INSTALL_CONFIG,
      migrationsDir: directory }).then(() => { finished = true; }, error => { finished = true; throw error; });
    const rejection = expect(pending).rejects.toMatchObject({ code: "schema_runtime_privileges_invalid" });
    try {
      await poolEnded.promise;
      await Promise.resolve(); await Promise.resolve();
      expect(fake.pool.end).toHaveBeenCalledOnce(); expect(socket.destroy).toHaveBeenCalledOnce();
      expect(finished).toBe(false);
      socket.emit("close");
      await rejection; expect(finished).toBe(true);
    } finally {
      socket.emit("close"); await rejection; connect.mockRestore();
    }
  });

  it.each([
    { operation: "apply" }, { operation: "" }, { operation: undefined },
    { operationAbortSignal: undefined }, { operationAbortSignal: {} },
    { migrationLockTimeoutSeconds: -1 }, { migrationLockTimeoutSeconds: 61 },
    { migrationLockTimeoutSeconds: 0.5 }, { migrationLockTimeoutSeconds: Number.NaN },
    { url: "" }, { url: "mysql://root@127.0.0.1/" }, { url: "postgres://root@127.0.0.1/test" },
    { url: "mysql://root@127.0.0.1/test?multipleStatements=true" },
    { fleetStoppedAck: true }, { skipTelemetryRuntimeAudit: true },
    { tenantTelemetryRefKey: new Uint8Array(32) },
  ])("rejects invalid or capability-expanding options before a connection: %j", async (extra) => {
    await expect(MysqlSessionStore.runSchemaOperation({ ...options(), ...extra } as never))
      .rejects.toThrow("MySQL schema operation options are invalid");
    expect(state.createPool).not.toHaveBeenCalled();
  });

  it("rejects getters and unknown nonenumerable or symbol fields rather than evaluating authority", async () => {
    const getter = vi.fn(() => "migrate"), input = options();
    Object.defineProperty(input, "operation", { enumerable: true, get: getter });
    await expect(MysqlSessionStore.runSchemaOperation(input)).rejects.toThrow("options are invalid");
    expect(getter).not.toHaveBeenCalled();
    const hidden = options(); Object.defineProperty(hidden, "skip", { value: true });
    await expect(MysqlSessionStore.runSchemaOperation(hidden)).rejects.toThrow("options are invalid");
    const symbolic = options(); Object.defineProperty(symbolic, Symbol("skip"), { value: true });
    await expect(MysqlSessionStore.runSchemaOperation(symbolic)).rejects.toThrow("options are invalid");
    expect(state.createPool).not.toHaveBeenCalled();
  });

  it("requires the exact stopped-writer acknowledgement for migrate at the Store boundary", async () => {
    await expect(MysqlSessionStore.runSchemaOperation(options({ operation: "migrate" }))).rejects.toThrow("options are invalid");
    await expect(MysqlSessionStore.runSchemaOperation(options({ operation: "migrate", fleetStoppedAck: "yes" as never })))
      .rejects.toThrow("options are invalid");
    expect(state.createPool).not.toHaveBeenCalled();
  });

  it("rejects a pre-aborted operation before pool creation", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(MysqlSessionStore.runSchemaOperation(options({ operationAbortSignal: controller.signal })))
      .rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
    expect(state.createPool).not.toHaveBeenCalled();
  });

  it("verify returns no Store and issues no migration lock, CREATE or migration INSERT", async () => {
    expect(await MysqlSessionStore.runSchemaOperation(options({ migrationLockTimeoutSeconds: 0 }))).toBeUndefined();
    expect(fake.trace).toEqual(["SELECT name FROM schema_migrations"]);
    expect(fake.connection.release).toHaveBeenCalledOnce(); expect(fake.pool.end).toHaveBeenCalledOnce();
  });

  it("migrate executes the formal fixture statement, writes its marker, verifies and releases its lock before closing", async () => {
    fake.applied.length = 0;
    expect(await MysqlSessionStore.runSchemaOperation(options({ operation: "migrate", fleetStoppedAck: ACK }))).toBeUndefined();
    expect(fake.trace.filter(sql => sql === "SELECT 1")).toHaveLength(1);
    expect(fake.applied).toEqual([FILE]);
    expect(fake.trace.filter(sql => sql === "SELECT name FROM schema_migrations")).toHaveLength(2);
    const release = fake.trace.findIndex(sql => sql.includes("RELEASE_LOCK("));
    expect(release).toBeGreaterThan(fake.trace.lastIndexOf("SELECT name FROM schema_migrations"));
    expect(fake.pool.end).toHaveBeenCalledOnce();
  });

  it("captures the original operation before filesystem awaits and cannot acquire migrate authority through later mutation", async () => {
    const input = options(), running = MysqlSessionStore.runSchemaOperation(input);
    input.operation = "migrate";
    await running;
    expect(fake.trace).toEqual(["SELECT name FROM schema_migrations"]);
    expect(fake.pool.end).toHaveBeenCalledOnce();
  });

  it("does not report cancellation before an original late driver acquisition settles", async () => {
    const controller = new AbortController(), acquiring = deferred<void>(), release = deferred<void>();
    fake.pool.getConnection.mockImplementationOnce(async () => {
      acquiring.resolve(); await release.promise; fake.pool.emit("connection", fake.connection); return fake.connection;
    });
    let settled = false;
    const running = MysqlSessionStore.runSchemaOperation(options({ operationAbortSignal: controller.signal }));
    const observed = running.then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
    try {
      await acquiring.promise; controller.abort(); await Promise.resolve();
      expect(settled).toBe(false); expect(fake.pool.end).toHaveBeenCalledOnce();
    } finally { release.resolve(); }
    expect(await observed).toHaveProperty("error");
    expect(fake.connection.destroy).toHaveBeenCalledOnce(); expect(fake.connection.release).toHaveBeenCalledOnce();
    expect(fake.pool.end).toHaveBeenCalledOnce();
  });

  it("does not return success while the owned driver close remains pending", async () => {
    const closing = deferred<void>(), release = deferred<void>();
    fake.pool.end.mockImplementationOnce(async () => { closing.resolve(); await release.promise; });
    let settled = false;
    const running = MysqlSessionStore.runSchemaOperation(options()).then(() => { settled = true; });
    try { await closing.promise; expect(settled).toBe(false); }
    finally { release.resolve(); }
    await running; expect(settled).toBe(true);
  });

  it("preserves the first schema failure and an actual close failure without returning a Store", async () => {
    const first = new Error("controlled schema failure"), second = new Error("controlled close failure");
    fake.connection.query.mockRejectedValueOnce(first); fake.pool.end.mockRejectedValueOnce(second);
    const failure = await MysqlSessionStore.runSchemaOperation(options()).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([first, second]);
    expect(fake.connection.release).toHaveBeenCalledOnce(); expect(fake.pool.end).toHaveBeenCalledOnce();
  });

  it.each([undefined, null, {}, { ...INSTALL_CONFIG, skip: true },
    { ...INSTALL_CONFIG, trustedDefiner: { ...INSTALL_CONFIG.trustedDefiner, password: "not-authority" } },
    { ...INSTALL_CONFIG, metadataSchema: "bad.schema" },
  ])("rejects install with missing or unclosed metadata before any pool: %j", async schemaMetadata => {
    await expect(MysqlSessionStore.runSchemaOperation(options({ operation: "install-metadata", fleetStoppedAck: ACK, schemaMetadata } as never)))
      .rejects.toThrow("MySQL schema operation options are invalid");
    expect(state.createPool).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "1", "all-application-writers-stopped-v2"])("requires exact install ACK before a pool: %j", async fleetStoppedAck => {
    await expect(MysqlSessionStore.runSchemaOperation(options({ operation: "install-metadata", schemaMetadata: INSTALL_CONFIG, fleetStoppedAck } as never)))
      .rejects.toThrow("MySQL schema operation options are invalid");
    expect(state.createPool).not.toHaveBeenCalled();
  });

  it.each(["migrate", "verify"] as const)("rejects metadata mixed into %s instead of silently installing", async operation => {
    await expect(MysqlSessionStore.runSchemaOperation(options({ operation, fleetStoppedAck: ACK, schemaMetadata: INSTALL_CONFIG })))
      .rejects.toThrow("MySQL schema operation options are invalid");
    expect(state.createPool).not.toHaveBeenCalled();
  });

  it("rejects nested install getters/hidden/symbol authority without evaluating getters or creating a pool", async () => {
    const getter = vi.fn(() => "metadata_reader"), accessor = structuredClone(INSTALL_CONFIG);
    Object.defineProperty(accessor.trustedDefiner, "user", { enumerable: true, get: getter });
    const hidden = structuredClone(INSTALL_CONFIG); Object.defineProperty(hidden, "skip", { value: true });
    const symbol = structuredClone(INSTALL_CONFIG); Object.defineProperty(symbol, Symbol("skip"), { value: true });
    for (const schemaMetadata of [accessor, hidden, symbol]) {
      await expect(MysqlSessionStore.runSchemaOperation(options({ operation: "install-metadata", fleetStoppedAck: ACK, schemaMetadata })))
        .rejects.toThrow("MySQL schema operation options are invalid");
    }
    expect(getter).not.toHaveBeenCalled(); expect(state.createPool).not.toHaveBeenCalled();
  });

  it("rejects a pre-aborted valid install before pool creation", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(MysqlSessionStore.runSchemaOperation(options({ operation: "install-metadata", fleetStoppedAck: ACK,
      schemaMetadata: INSTALL_CONFIG, operationAbortSignal: controller.signal }))).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
    expect(state.createPool).not.toHaveBeenCalled();
  });

  it("holds the same migration lock around original verification, the real installer, and original post-verification", async () => {
    const fixture = installationDriver(fake);
    expect(await MysqlSessionStore.runSchemaOperation(options({ operation: "install-metadata", fleetStoppedAck: ACK,
      schemaMetadata: INSTALL_CONFIG, migrationLockTimeoutSeconds: 7 }))).toBeUndefined();
    const lock = fake.trace.findIndex(sql => sql.includes("GET_LOCK(")), create = fake.trace.findIndex(sql => sql.startsWith("CREATE DEFINER="));
    const verifications = fake.trace.flatMap((sql, index) => sql === "SELECT name FROM schema_migrations" ? [index] : []);
    const unlock = fake.trace.findIndex(sql => sql.includes("RELEASE_LOCK("));
    expect(verifications).toHaveLength(2); expect(lock).toBeLessThan(verifications[0]!);
    expect(verifications[0]!).toBeLessThan(create); expect(create).toBeLessThan(verifications[1]!); expect(verifications[1]!).toBeLessThan(unlock);
    const installLock = fixture.calls.find(entry => entry.sql.includes("GET_LOCK("));
    expect(installLock?.values).toEqual([7]); expect(installLock?.sql).toBe("SELECT GET_LOCK(CONCAT('agent-service:migrate:', LEFT(SHA2(DATABASE(), 256), 32)), ?) AS acquired");
    expect(fake.applied).toEqual([FILE]); expect(fake.trace).not.toContain("SELECT 1");
    expect(fake.trace.some(sql => /^INSERT INTO schema_migrations|^CALL |CREATE (?:DATABASE|USER)|^GRANT |^DROP /.test(sql))).toBe(false);
    expect(fake.trace.filter(sql => sql.startsWith("CREATE DEFINER="))).toHaveLength(1);
    expect(fake.connection.release).toHaveBeenCalledOnce(); expect(fake.pool.end).toHaveBeenCalledOnce();
    const other = driver(); state.createPool.mockReturnValue(other.pool);
    await MysqlSessionStore.runSchemaOperation(options({ operation: "migrate", fleetStoppedAck: ACK, migrationLockTimeoutSeconds: 7 }));
    expect(other.trace.find(sql => sql.includes("GET_LOCK("))).toBe(installLock?.sql);
    expect(other.connection.release).toHaveBeenCalledOnce(); expect(other.pool.end).toHaveBeenCalledOnce();
  });

  it("does not verify or install when the shared migration lock is not acquired", async () => {
    installationDriver(fake); fake.connection.query.mockResolvedValueOnce([[{ acquired: 0 }], []]);
    await expect(MysqlSessionStore.runSchemaOperation(options({ operation: "install-metadata", fleetStoppedAck: ACK, schemaMetadata: INSTALL_CONFIG })))
      .rejects.toThrow("schema metadata installation could not acquire the migration lock");
    expect(fake.connection.query).toHaveBeenCalledOnce(); expect(fake.connection.query.mock.calls[0]?.[0]).toContain("GET_LOCK(");
    expect(fake.connection.release).toHaveBeenCalledOnce(); expect(fake.pool.end).toHaveBeenCalledOnce();
  });

  it("does not install or repair when original pre-verification finds a missing marker, but releases the owned lock", async () => {
    installationDriver(fake); fake.applied.length = 0;
    await expect(MysqlSessionStore.runSchemaOperation(options({ operation: "install-metadata", fleetStoppedAck: ACK, schemaMetadata: INSTALL_CONFIG })))
      .rejects.toThrow("database schema is missing required migrations");
    expect(fake.trace.some(sql => sql.startsWith("CREATE DEFINER=") || sql === "SELECT 1")).toBe(false);
    expect(fake.trace.filter(sql => sql.includes("RELEASE_LOCK("))).toHaveLength(1);
    expect(fake.applied).toEqual([]); expect(fake.connection.release).toHaveBeenCalledOnce(); expect(fake.pool.end).toHaveBeenCalledOnce();
  });

  it("rejects failed original post-verification without undoing or retrying the already sent procedure CREATE", async () => {
    installationDriver(fake, async () => { fake.applied.length = 0; });
    await expect(MysqlSessionStore.runSchemaOperation(options({ operation: "install-metadata", fleetStoppedAck: ACK, schemaMetadata: INSTALL_CONFIG })))
      .rejects.toThrow("database schema is missing required migrations");
    expect(fake.trace.filter(sql => sql.startsWith("CREATE DEFINER="))).toHaveLength(1);
    expect(fake.trace.filter(sql => sql === "SELECT name FROM schema_migrations")).toHaveLength(2);
    expect(fake.trace.filter(sql => sql.includes("RELEASE_LOCK("))).toHaveLength(1);
    expect(fake.trace.some(sql => /^DROP |^GRANT |^CALL /.test(sql))).toBe(false);
    expect(fake.connection.release).toHaveBeenCalledOnce(); expect(fake.pool.end).toHaveBeenCalledOnce();
  });

  it("captures install metadata before filesystem or driver awaits rather than accepting later authority changes", async () => {
    installationDriver(fake);
    const schemaMetadata = structuredClone(INSTALL_CONFIG), input = options({ operation: "install-metadata", fleetStoppedAck: ACK, schemaMetadata });
    const running = MysqlSessionStore.runSchemaOperation(input);
    schemaMetadata.metadataSchema = "changed_schema"; schemaMetadata.trustedDefiner.user = "changed_user"; input.operation = "migrate";
    await running;
    const create = fake.trace.find(sql => sql.startsWith("CREATE DEFINER="));
    expect(create).toContain("DEFINER='metadata_reader'@'localhost'"); expect(create).toContain("`schema_metadata_fixture`");
    expect(fake.trace).not.toContain("SELECT 1");
  });

  it("cannot report install success before original driver close settles", async () => {
    installationDriver(fake);
    const closing = deferred<void>(), release = deferred<void>();
    fake.pool.end.mockImplementationOnce(async () => { closing.resolve(); await release.promise; });
    let settled = false;
    const running = MysqlSessionStore.runSchemaOperation(options({ operation: "install-metadata", fleetStoppedAck: ACK, schemaMetadata: INSTALL_CONFIG }));
    const observed = running.then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
    try { await closing.promise; expect(settled).toBe(false); expect(fake.connection.release).toHaveBeenCalledOnce(); }
    finally { release.resolve(); }
    expect(await observed).toEqual({ value: undefined }); expect(settled).toBe(true);
  });

  it("does not abandon an accepted install query on cancellation or pretend driver doubles prove native MySQL settlement", async () => {
    const entered = deferred<void>(), release = deferred<void>(), controller = new AbortController();
    installationDriver(fake, async () => { entered.resolve(); await release.promise; });
    let settled = false;
    const running = MysqlSessionStore.runSchemaOperation(options({ operation: "install-metadata", fleetStoppedAck: ACK,
      schemaMetadata: INSTALL_CONFIG, operationAbortSignal: controller.signal }));
    const observed = running.then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
    try { await entered.promise; controller.abort(); await Promise.resolve(); expect(settled).toBe(false); expect(fake.connection.destroy).toHaveBeenCalledOnce(); }
    finally { release.resolve(); }
    expect(await observed).toHaveProperty("error"); expect(fake.pool.end).toHaveBeenCalledOnce(); expect(fake.connection.release).toHaveBeenCalledOnce();
  });
});
