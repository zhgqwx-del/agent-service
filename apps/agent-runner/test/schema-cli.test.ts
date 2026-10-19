import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MysqlSchemaOperationOptions } from "@agent-service/store";
import { runSchemaCli, type SchemaCliDependencies } from "../src/schema-cli.js";

const storeOperation = vi.hoisted(() => vi.fn(async (_options: MysqlSchemaOperationOptions): Promise<void> => {}));
vi.mock("@agent-service/store", () => ({ MysqlSessionStore: { runSchemaOperation: storeOperation } }));

const URL = "mysql://schema_operator:private-schema-canary@127.0.0.1/owned_schema_test";
const ACK = "all-application-writers-stopped-v1";
const NATIVE_CANARY = "native-secret-sql-owner-canary";

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(operation: SchemaCliDependencies["runSchemaOperation"] = async () => {}) {
  const output: string[] = [], errors: string[] = [];
  const listeners = new Set<() => void>();
  const remove = vi.fn(() => { listeners.clear(); });
  const dependencies: SchemaCliDependencies = {
    runSchemaOperation: vi.fn(operation),
    writeLine: (line) => { output.push(line); },
    writeError: (line) => { errors.push(line); },
    installInterrupts: vi.fn((listener) => { listeners.add(listener); return remove; }),
  };
  const env: NodeJS.ProcessEnv = { SCHEMA_MYSQL_URL: URL, SCHEMA_FLEET_STOPPED_ACK: ACK };
  return { dependencies, output, errors, env, remove, listeners,
    interrupt: () => { for (const listener of listeners) listener(); } };
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("independent schema main.js command", () => {
  it.each(["--help", "-h"])("%s does not inspect environment or open resources", async (help) => {
    const f = fixture();
    const env = new Proxy({}, { get: () => { throw new Error(NATIVE_CANARY); } });
    expect(await runSchemaCli(["schema", help], env, f.dependencies)).toBe(0);
    expect(f.output).toHaveLength(1);
    expect(f.output[0]).toContain("Usage: agent-runner schema <command>");
    expect(f.errors).toEqual([]);
    expect(f.dependencies.runSchemaOperation).not.toHaveBeenCalled();
    expect(f.dependencies.installInterrupts).not.toHaveBeenCalled();
    expect(storeOperation).not.toHaveBeenCalled();
  });

  it.each([
    ["empty argv", []], ["missing discriminator", ["verify"]], ["missing command", ["schema"]],
    ["unknown command", ["schema", "apply"]], ["unknown main flag", ["--help"]],
    ["extra flag", ["schema", "verify", "--force"]], ["extra separator", ["schema", "--", "migrate"]],
    ["DSN argument", ["schema", "migrate", URL]], ["path argument", ["schema", "verify", "/private/config"]],
  ] as const)("rejects %s without resource access or server fallback", async (_name, argv) => {
    const f = fixture();
    expect(await runSchemaCli(argv, f.env, f.dependencies)).toBe(1);
    expect(f.errors).toEqual(['{"status":"error","code":"invalid_arguments"}']);
    expect(f.output).toEqual([]);
    expect(f.dependencies.runSchemaOperation).not.toHaveBeenCalled();
    expect(f.dependencies.installInterrupts).not.toHaveBeenCalled();
    expect(f.errors.join("\n")).not.toContain("private-schema-canary");
  });

  it.each([
    ["unset", undefined], ["empty", ""], ["ordinary MYSQL_URL only", undefined],
    ["different protocol", "postgres://localhost/owned_schema_test"], ["no database", "mysql://localhost"],
    ["empty database", "mysql://localhost/"], ["second path", "mysql://localhost/first/second"],
    ["encoded empty name", "mysql://localhost/%20"], ["encoded slash", "mysql://localhost/first%2Fsecond"],
    ["encoded backslash", "mysql://localhost/first%5Csecond"], ["encoded control", "mysql://localhost/first%00second"],
    ["long database", "mysql://localhost/" + "x".repeat(65)],
    ["long encoded database", "mysql://localhost/" + "%78".repeat(65)],
    ["URL query", "mysql://localhost/owned?database=other"], ["empty query delimiter", "mysql://localhost/owned?"],
    ["URL fragment", "mysql://localhost/owned#fragment"], ["empty fragment delimiter", "mysql://localhost/owned#"],
    ["leading whitespace", " mysql://localhost/owned"],
  ] as const)("rejects %s and never falls back to normal database configuration", async (_name, value) => {
    const f = fixture();
    f.env.MYSQL_URL = URL;
    if (value === undefined) delete f.env.SCHEMA_MYSQL_URL;
    else f.env.SCHEMA_MYSQL_URL = value;
    expect(await runSchemaCli(["schema", "verify"], f.env, f.dependencies)).toBe(1);
    expect(f.errors).toEqual(['{"status":"error","code":"invalid_configuration"}']);
    expect(f.dependencies.runSchemaOperation).not.toHaveBeenCalled();
    expect(f.dependencies.installInterrupts).not.toHaveBeenCalled();
    expect(f.output).toEqual([]);
  });

  it.each([undefined, "", "1", "all-application-writers-stopped-v2"])("migrate requires the exact stopped-fleet declaration (%s)", async (ack) => {
    const f = fixture();
    if (ack === undefined) delete f.env.SCHEMA_FLEET_STOPPED_ACK;
    else f.env.SCHEMA_FLEET_STOPPED_ACK = ack;
    expect(await runSchemaCli(["schema", "migrate"], f.env, f.dependencies)).toBe(1);
    expect(f.dependencies.runSchemaOperation).not.toHaveBeenCalled();
    expect(f.errors).toEqual(['{"status":"error","code":"invalid_configuration"}']);
  });

  it("maps only schema authority and the exact migrate ACK to the real operation contract", async () => {
    const f = fixture();
    Object.assign(f.env, { MYSQL_URL: "mysql://wrong:secret@invalid/other", AGENT_SERVICE_MIGRATIONS_DIR: "/private/not-authority",
      MCP_REGISTRY_ENABLED: "1", MCP_SERVERS_JSON: "invalid", HOOKS_CONFIG_JSON: "invalid", SUBAGENTS_ENABLED: "1",
      SECRETS_MASTER_KEY: "invalid", AWS_SECRET_ACCESS_KEY: NATIVE_CANARY, BOOTSTRAP_API_KEY: NATIVE_CANARY });
    expect(await runSchemaCli(["schema", "migrate"], f.env, f.dependencies)).toBe(0);
    expect(f.dependencies.runSchemaOperation).toHaveBeenCalledTimes(1);
    expect(f.dependencies.runSchemaOperation).toHaveBeenCalledWith({ url: URL, operation: "migrate",
      operationAbortSignal: expect.any(AbortSignal), migrationLockTimeoutSeconds: 30, fleetStoppedAck: ACK });
    expect(f.output).toEqual(['{"status":"ok","command":"migrate"}']);
    expect(f.errors).toEqual([]);
    expect(f.remove).toHaveBeenCalledTimes(1);
    expect(f.listeners.size).toBe(0);
    expect(f.output.join("\n")).not.toContain(NATIVE_CANARY);
    expect(f.output.join("\n")).not.toContain(URL);
  });

  it("verify requires no ACK and does not forward even an ambient migrate declaration", async () => {
    const f = fixture();
    expect(await runSchemaCli(["schema", "verify"], f.env, f.dependencies)).toBe(0);
    expect(f.dependencies.runSchemaOperation).toHaveBeenCalledWith({ url: URL, operation: "verify",
      operationAbortSignal: expect.any(AbortSignal), migrationLockTimeoutSeconds: 30 });
    expect(f.output).toEqual(['{"status":"ok","command":"verify"}']);
  });

  it("a configuration accessor failure remains content-free and opens no resource", async () => {
    const f = fixture();
    Object.defineProperty(f.env, "SCHEMA_MYSQL_URL", { get: () => { throw new Error(NATIVE_CANARY); } });
    expect(await runSchemaCli(["schema", "verify"], f.env, f.dependencies)).toBe(1);
    expect(f.errors).toEqual(['{"status":"error","code":"invalid_configuration"}']);
    expect(f.dependencies.runSchemaOperation).not.toHaveBeenCalled();
    expect(f.dependencies.installInterrupts).not.toHaveBeenCalled();
  });

  it.each([
    ["timeout too short", "999", "0"], ["timeout too long", "120001", "0"],
    ["timeout fractional", "1000.5", "0"], ["timeout leading zero", "01000", "0"],
    ["timeout empty", "", "0"], ["negative lock", "120000", "-1"],
    ["lock too large", "120000", "61"], ["lock fractional", "120000", "0.5"],
    ["lock above deadline", "1000", "2"], ["default lock above shorter deadline", "1000", undefined],
  ] as const)("rejects %s before resource admission", async (_name, timeout, lock) => {
    const f = fixture();
    f.env.SCHEMA_OPERATION_TIMEOUT_MS = timeout;
    if (lock !== undefined) f.env.SCHEMA_MIGRATION_LOCK_TIMEOUT_SECONDS = lock;
    expect(await runSchemaCli(["schema", "verify"], f.env, f.dependencies)).toBe(1);
    expect(f.dependencies.runSchemaOperation).not.toHaveBeenCalled();
    expect(f.dependencies.installInterrupts).not.toHaveBeenCalled();
  });

  it.each([["1000", "0"], ["1000", "1"], ["120000", "60"]] as const)("accepts bounded timeout %s and lock %s", async (timeout, lock) => {
    const f = fixture();
    f.env.SCHEMA_OPERATION_TIMEOUT_MS = timeout;
    f.env.SCHEMA_MIGRATION_LOCK_TIMEOUT_SECONDS = lock;
    expect(await runSchemaCli(["schema", "verify"], f.env, f.dependencies)).toBe(0);
    expect(f.dependencies.runSchemaOperation).toHaveBeenCalledWith(expect.objectContaining({ migrationLockTimeoutSeconds: Number(lock) }));
  });

  it("does not settle or report success on deadline until the actual operation settles", async () => {
    vi.useFakeTimers();
    const native = deferred<void>(), f = fixture(() => native.promise);
    f.env.SCHEMA_OPERATION_TIMEOUT_MS = "1000";
    f.env.SCHEMA_MIGRATION_LOCK_TIMEOUT_SECONDS = "0";
    let finished = false;
    const pending = runSchemaCli(["schema", "migrate"], f.env, f.dependencies).then(value => { finished = true; return value; });
    await vi.advanceTimersByTimeAsync(1000);
    const options = vi.mocked(f.dependencies.runSchemaOperation).mock.calls[0]?.[0];
    expect(options?.operationAbortSignal.aborted).toBe(true);
    expect(finished).toBe(false);
    expect(f.output).toEqual([]);
    expect(f.errors).toEqual([]);
    expect(f.remove).not.toHaveBeenCalled();
    native.resolve(undefined);
    expect(await pending).toBe(1);
    expect(f.errors).toEqual(['{"status":"error","code":"operation_deadline"}']);
    expect(f.dependencies.runSchemaOperation).toHaveBeenCalledTimes(1);
    expect(f.remove).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("SIGINT/SIGTERM cancellation cannot abandon late native settlement or dispatch a retry", async () => {
    const native = deferred<void>(), f = fixture(() => native.promise);
    let finished = false;
    const pending = runSchemaCli(["schema", "migrate"], f.env, f.dependencies).then(value => { finished = true; return value; });
    f.interrupt();
    await Promise.resolve();
    expect(vi.mocked(f.dependencies.runSchemaOperation).mock.calls[0]?.[0].operationAbortSignal.aborted).toBe(true);
    expect(finished).toBe(false);
    expect(f.errors).toEqual([]);
    native.reject(new Error(NATIVE_CANARY));
    expect(await pending).toBe(1);
    expect(f.errors).toEqual(['{"status":"error","code":"operation_cancelled"}']);
    expect(f.dependencies.runSchemaOperation).toHaveBeenCalledTimes(1);
    expect(f.output).toEqual([]);
    expect(f.listeners.size).toBe(0);
  });

  it("an interrupt received while installing handlers admits no database operation", async () => {
    const f = fixture();
    f.dependencies.installInterrupts = vi.fn((interrupt) => { interrupt(); return f.remove; });
    expect(await runSchemaCli(["schema", "verify"], f.env, f.dependencies)).toBe(1);
    expect(f.dependencies.runSchemaOperation).not.toHaveBeenCalled();
    expect(f.errors).toEqual(['{"status":"error","code":"operation_cancelled"}']);
    expect(f.remove).toHaveBeenCalledTimes(1);
  });

  it("uses the default 120-second deadline without a configurable extension", async () => {
    vi.useFakeTimers();
    const native = deferred<void>(), f = fixture(() => native.promise);
    const pending = runSchemaCli(["schema", "verify"], f.env, f.dependencies);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(vi.mocked(f.dependencies.runSchemaOperation).mock.calls[0]?.[0].operationAbortSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.mocked(f.dependencies.runSchemaOperation).mock.calls[0]?.[0].operationAbortSignal.aborted).toBe(true);
    native.resolve(undefined);
    expect(await pending).toBe(1);
    expect(f.errors).toEqual(['{"status":"error","code":"operation_deadline"}']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("maps native errors and causes to one fixed content-free failure without retry", async () => {
    const f = fixture(async () => { throw new Error(NATIVE_CANARY, { cause: { sql: NATIVE_CANARY, url: URL, secret: NATIVE_CANARY } }); });
    expect(await runSchemaCli(["schema", "verify"], f.env, f.dependencies)).toBe(1);
    expect(f.errors).toEqual(['{"status":"error","code":"operation_failed"}']);
    expect(f.output).toEqual([]);
    expect(f.dependencies.runSchemaOperation).toHaveBeenCalledTimes(1);
    expect(f.remove).toHaveBeenCalledTimes(1);
  });

  it("handler-install failure cleans up the deadline without dispatch or raw diagnostics", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.dependencies.installInterrupts = () => { throw new Error(NATIVE_CANARY); };
    expect(await runSchemaCli(["schema", "verify"], f.env, f.dependencies)).toBe(1);
    expect(f.dependencies.runSchemaOperation).not.toHaveBeenCalled();
    expect(f.errors).toEqual(['{"status":"error","code":"operation_failed"}']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("default dependencies call the actual Store static method, not a placeholder", async () => {
    const stdout: string[] = [], stderr: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout.push(String(chunk)); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { stderr.push(String(chunk)); return true; });
    const beforeInt = process.listenerCount("SIGINT"), beforeTerm = process.listenerCount("SIGTERM");
    expect(await runSchemaCli(["schema", "verify"], { SCHEMA_MYSQL_URL: URL })).toBe(0);
    expect(storeOperation).toHaveBeenCalledTimes(1);
    expect(storeOperation).toHaveBeenCalledWith({ url: URL, operation: "verify", operationAbortSignal: expect.any(AbortSignal), migrationLockTimeoutSeconds: 30 });
    expect(stdout).toEqual(['{"status":"ok","command":"verify"}\n']);
    expect(stderr).toEqual([]);
    expect(process.listenerCount("SIGINT")).toBe(beforeInt);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
  });
});

function metadataFixture(operation?: SchemaCliDependencies["runSchemaOperation"]) {
  const f = fixture(operation);
  Object.assign(f.env, { SCHEMA_METADATA_SCHEMA: "schema_metadata_fixture", SCHEMA_METADATA_DEFINER_USER: "metadata_reader",
    SCHEMA_METADATA_DEFINER_HOST: "localhost" });
  return f;
}

describe("explicit schema install-metadata command", () => {
  it("maps only the closed metadata config, exact ACK and existing operation budget", async () => {
    const f = metadataFixture();
    Object.assign(f.env, { MYSQL_URL: "mysql://wrong:secret@invalid/other", AGENT_SERVICE_MIGRATIONS_DIR: "/private/not-authority",
      METADATA_MYSQL_URL: "mysql://wrong:secret@invalid/other", SECRETS_MASTER_KEY: NATIVE_CANARY });
    expect(await runSchemaCli(["schema", "install-metadata"], f.env, f.dependencies)).toBe(0);
    expect(f.dependencies.runSchemaOperation).toHaveBeenCalledExactlyOnceWith({ url: URL, operation: "install-metadata",
      operationAbortSignal: expect.any(AbortSignal), migrationLockTimeoutSeconds: 30, fleetStoppedAck: ACK,
      schemaMetadata: { metadataSchema: "schema_metadata_fixture", trustedDefiner: { user: "metadata_reader", host: "localhost" } } });
    const options = vi.mocked(f.dependencies.runSchemaOperation).mock.calls[0]?.[0];
    expect(Object.isFrozen(options?.schemaMetadata)).toBe(true); expect(Object.isFrozen(options?.schemaMetadata?.trustedDefiner)).toBe(true);
    expect(f.output).toEqual(['{"status":"ok","command":"install-metadata"}']); expect(f.errors).toEqual([]);
    expect(f.remove).toHaveBeenCalledOnce(); expect(f.listeners.size).toBe(0);
    expect(f.output.join("\n")).not.toContain(URL); expect(f.output.join("\n")).not.toContain("metadata_reader");
  });

  it.each([undefined, "", "1", "all-application-writers-stopped-v2"])("requires exact stopped-writer ACK (%s)", async ack => {
    const f = metadataFixture();
    if (ack === undefined) delete f.env.SCHEMA_FLEET_STOPPED_ACK; else f.env.SCHEMA_FLEET_STOPPED_ACK = ack;
    expect(await runSchemaCli(["schema", "install-metadata"], f.env, f.dependencies)).toBe(1);
    expect(f.errors).toEqual(['{"status":"error","code":"invalid_configuration"}']);
    expect(f.dependencies.runSchemaOperation).not.toHaveBeenCalled(); expect(f.dependencies.installInterrupts).not.toHaveBeenCalled();
  });

  it.each(["SCHEMA_METADATA_SCHEMA", "SCHEMA_METADATA_DEFINER_USER", "SCHEMA_METADATA_DEFINER_HOST"] as const)
    ("requires a present nonempty %s, without falling back to runtime config", async key => {
      for (const value of [undefined, ""]) {
        const f = metadataFixture();
        if (value === undefined) delete f.env[key]; else f.env[key] = value;
        Object.assign(f.env, { MYSQL_SCHEMA_METADATA_SCHEMA: "runtime_schema", MYSQL_SCHEMA_METADATA_DEFINER_USER: "runtime_user",
          MYSQL_SCHEMA_METADATA_DEFINER_HOST: "runtime_host" });
        expect(await runSchemaCli(["schema", "install-metadata"], f.env, f.dependencies)).toBe(1);
        expect(f.errors).toEqual(['{"status":"error","code":"invalid_configuration"}']);
        expect(f.dependencies.runSchemaOperation).not.toHaveBeenCalled(); expect(f.dependencies.installInterrupts).not.toHaveBeenCalled();
      }
    });

  it.each([
    ["SCHEMA_METADATA_SCHEMA", "Upper"], ["SCHEMA_METADATA_SCHEMA", "bad.schema"], ["SCHEMA_METADATA_SCHEMA", "bad-schema"],
    ["SCHEMA_METADATA_SCHEMA", "x".repeat(65)], ["SCHEMA_METADATA_SCHEMA", "中"],
    ["SCHEMA_METADATA_DEFINER_USER", "x".repeat(33)], ["SCHEMA_METADATA_DEFINER_USER", "user@host"],
    ["SCHEMA_METADATA_DEFINER_USER", "bad\nuser"], ["SCHEMA_METADATA_DEFINER_USER", "\ud800"],
    ["SCHEMA_METADATA_DEFINER_HOST", "x".repeat(256)], ["SCHEMA_METADATA_DEFINER_HOST", "host@other"],
    ["SCHEMA_METADATA_DEFINER_HOST", "bad\u007fhost"], ["SCHEMA_METADATA_DEFINER_HOST", "\udc00"],
  ] as const)("rejects invalid metadata field %s without resource access", async (key, value) => {
    const f = metadataFixture(); f.env[key] = value;
    expect(await runSchemaCli(["schema", "install-metadata"], f.env, f.dependencies)).toBe(1);
    expect(f.errors).toEqual(['{"status":"error","code":"invalid_configuration"}']);
    expect(f.dependencies.runSchemaOperation).not.toHaveBeenCalled(); expect(f.output).toEqual([]);
  });

  it("preserves the reader's exact Unicode character/UTF8 bounds without normalizing accounts", async () => {
    const f = metadataFixture();
    f.env.SCHEMA_METADATA_SCHEMA = "s".repeat(64); f.env.SCHEMA_METADATA_DEFINER_USER = "中".repeat(32);
    f.env.SCHEMA_METADATA_DEFINER_HOST = "é".repeat(255);
    expect(await runSchemaCli(["schema", "install-metadata"], f.env, f.dependencies)).toBe(0);
    expect(vi.mocked(f.dependencies.runSchemaOperation).mock.calls[0]?.[0].schemaMetadata).toEqual({ metadataSchema: "s".repeat(64),
      trustedDefiner: { user: "中".repeat(32), host: "é".repeat(255) } });
  });

  it.each(["SCHEMA_METADATA_SCHEMA", "SCHEMA_METADATA_DEFINER_USER", "SCHEMA_METADATA_DEFINER_HOST", "SCHEMA_METADATA_FUTURE"] as const)
    ("rejects metadata authority mixed into migrate/verify even when %s is empty", async key => {
      for (const command of ["migrate", "verify"]) {
        const f = fixture(); f.env[key] = "";
        expect(await runSchemaCli(["schema", command], f.env, f.dependencies)).toBe(1);
        expect(f.errors).toEqual(['{"status":"error","code":"invalid_configuration"}']);
        expect(f.dependencies.runSchemaOperation).not.toHaveBeenCalled(); expect(f.dependencies.installInterrupts).not.toHaveBeenCalled();
      }
    });

  it("rejects unknown, hidden or accessor metadata env fields without reading an accessor", async () => {
    const unknown = metadataFixture(); unknown.env.SCHEMA_METADATA_PASSWORD = NATIVE_CANARY;
    const getter = vi.fn(() => NATIVE_CANARY), accessor = metadataFixture();
    Object.defineProperty(accessor.env, "SCHEMA_METADATA_DEFINER_USER", { enumerable: true, get: getter });
    const hidden = metadataFixture(); Object.defineProperty(hidden.env, "SCHEMA_METADATA_DEFINER_HOST", { value: "localhost", enumerable: false });
    for (const f of [unknown, accessor, hidden]) {
      expect(await runSchemaCli(["schema", "install-metadata"], f.env, f.dependencies)).toBe(1);
      expect(f.errors).toEqual(['{"status":"error","code":"invalid_configuration"}']);
      expect(f.dependencies.runSchemaOperation).not.toHaveBeenCalled();
      expect(f.errors.join("\n")).not.toContain(NATIVE_CANARY);
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it("requires the explicit schema DSN for installation and rejects extra argv without server fallback", async () => {
    const missing = metadataFixture(); delete missing.env.SCHEMA_MYSQL_URL; missing.env.MYSQL_URL = URL;
    expect(await runSchemaCli(["schema", "install-metadata"], missing.env, missing.dependencies)).toBe(1);
    expect(missing.errors).toEqual(['{"status":"error","code":"invalid_configuration"}']);
    expect(missing.dependencies.runSchemaOperation).not.toHaveBeenCalled();
    const extra = metadataFixture();
    expect(await runSchemaCli(["schema", "install-metadata", "--force"], extra.env, extra.dependencies)).toBe(1);
    expect(extra.errors).toEqual(['{"status":"error","code":"invalid_arguments"}']);
    expect(extra.dependencies.runSchemaOperation).not.toHaveBeenCalled();
  });

  it("captures metadata before operation awaits and does not expose it in native failure diagnostics", async () => {
    const native = deferred<void>(), f = metadataFixture(() => native.promise);
    const pending = runSchemaCli(["schema", "install-metadata"], f.env, f.dependencies);
    f.env.SCHEMA_METADATA_SCHEMA = "changed"; f.env.SCHEMA_METADATA_DEFINER_USER = NATIVE_CANARY;
    expect(vi.mocked(f.dependencies.runSchemaOperation).mock.calls[0]?.[0].schemaMetadata?.metadataSchema).toBe("schema_metadata_fixture");
    native.reject(new Error(NATIVE_CANARY, { cause: { sql: NATIVE_CANARY, url: URL, config: f.env } }));
    expect(await pending).toBe(1); expect(f.errors).toEqual(['{"status":"error","code":"operation_failed"}']);
    expect(f.output).toEqual([]); expect(f.errors.join("\n")).not.toContain(NATIVE_CANARY);
    expect(f.dependencies.runSchemaOperation).toHaveBeenCalledOnce();
  });

  it.each(["deadline", "interrupt"] as const)("%s waits for actual install settlement and never retries", async mode => {
    vi.useFakeTimers();
    const native = deferred<void>(), f = metadataFixture(() => native.promise);
    f.env.SCHEMA_OPERATION_TIMEOUT_MS = "1000"; f.env.SCHEMA_MIGRATION_LOCK_TIMEOUT_SECONDS = "0";
    let finished = false;
    const pending = runSchemaCli(["schema", "install-metadata"], f.env, f.dependencies).then(value => { finished = true; return value; });
    if (mode === "deadline") await vi.advanceTimersByTimeAsync(1000); else { f.interrupt(); await Promise.resolve(); }
    expect(vi.mocked(f.dependencies.runSchemaOperation).mock.calls[0]?.[0].operationAbortSignal.aborted).toBe(true);
    expect(finished).toBe(false); expect(f.errors).toEqual([]); expect(f.output).toEqual([]); expect(f.remove).not.toHaveBeenCalled();
    native.resolve(undefined);
    expect(await pending).toBe(1);
    expect(f.errors).toEqual([JSON.stringify({ status: "error", code: mode === "deadline" ? "operation_deadline" : "operation_cancelled" })]);
    expect(f.dependencies.runSchemaOperation).toHaveBeenCalledOnce(); expect(f.remove).toHaveBeenCalledOnce();
    expect(f.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("advertises installation prerequisites without loading Store or inspecting env on help", async () => {
    const f = fixture(), env = new Proxy({}, { get: () => { throw new Error(NATIVE_CANARY); }, ownKeys: () => { throw new Error(NATIVE_CANARY); } });
    expect(await runSchemaCli(["schema", "--help"], env, f.dependencies)).toBe(0);
    expect(f.output[0]).toContain("install-metadata"); expect(f.output[0]).toContain("pre-provisioned");
    expect(f.output[0]).toContain("both the definer itself and runtime");
    expect(f.dependencies.runSchemaOperation).not.toHaveBeenCalled(); expect(storeOperation).not.toHaveBeenCalled();
  });

  it("default dependencies dispatch install to the real Store static operation", async () => {
    const output: string[] = [], errors: string[] = [], f = metadataFixture();
    vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output.push(String(chunk)); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation(chunk => { errors.push(String(chunk)); return true; });
    const beforeInt = process.listenerCount("SIGINT"), beforeTerm = process.listenerCount("SIGTERM");
    expect(await runSchemaCli(["schema", "install-metadata"], f.env)).toBe(0);
    expect(storeOperation).toHaveBeenCalledExactlyOnceWith({ url: URL, operation: "install-metadata",
      operationAbortSignal: expect.any(AbortSignal), migrationLockTimeoutSeconds: 30, fleetStoppedAck: ACK,
      schemaMetadata: { metadataSchema: "schema_metadata_fixture", trustedDefiner: { user: "metadata_reader", host: "localhost" } } });
    expect(output).toEqual(['{"status":"ok","command":"install-metadata"}\n']); expect(errors).toEqual([]);
    expect(process.listenerCount("SIGINT")).toBe(beforeInt); expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
  });
});
