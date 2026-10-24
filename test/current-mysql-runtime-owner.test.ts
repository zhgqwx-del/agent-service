import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentMysqlRuntimeOwner } from "../packages/store/test/fixtures/current-mysql-runtime.js";

type Gate<T> = { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void; release(): void };
type Failure = { reason: unknown };
type Wire = { socket: Socket; close: Promise<void>; hold: boolean; destroyed: boolean; closeNow(): void };
type Observer = { db: string; wire: Wire; endCalls: number; endGate?: Gate<void>; queryGate?: Gate<unknown[]>; onEnd?: () => void };
type Store = { signal: AbortSignal; entered: Gate<void>; gate?: Gate<void>; failure?: Failure; closeCalls: number; onClose?: () => void };
const state = vi.hoisted(() => ({
  uuid: "12345678-1234-1234-1234-123456789abc", schemas: new Set<string>(), wires: [] as Wire[],
  observers: [] as Observer[], stores: [] as Store[], gates: [] as { release(): void }[],
  owners: [] as CurrentMysqlRuntimeOwner[], pending: new Set<Promise<unknown>>(),
  preparationSignal: undefined as AbortSignal | undefined, prepareEntered: undefined as Gate<void> | undefined,
  prepareGate: undefined as Gate<void> | undefined, connectEntered: undefined as Gate<Observer> | undefined,
  connectGate: undefined as Gate<void> | undefined, reuseEntered: undefined as Gate<void> | undefined,
  reuseGate: undefined as Gate<void> | undefined, formalEntered: undefined as Gate<void> | undefined,
  formalGate: undefined as Gate<void> | undefined, formalFailure: undefined as Failure | undefined,
  cleanupEntered: undefined as Gate<void> | undefined, cleanupGate: undefined as Gate<void> | undefined,
  schemaFailure: undefined as Failure | undefined, runtimeCloses: [] as boolean[], drops: [] as string[],
}));
function gate<T>(): Gate<T> {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  const value = { promise, resolve, reject, release: () => resolve(undefined as T) };
  state.gates.push(value); return value;
}
function own<T>(promise: Promise<T>): Promise<T> {
  state.pending.add(promise); void promise.then(() => state.pending.delete(promise), () => state.pending.delete(promise)); return promise;
}
vi.mock("node:net", async importOriginal => {
  const actual = await importOriginal<typeof import("node:net")>();
  return { ...actual, createConnection: vi.fn(() => {
    // An unconnected native Socket and controlled close event: no TCP/DNS/service is used.
    const socket = new actual.Socket(), closeNow = socket.destroy.bind(socket);
    const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
    const wire: Wire = { socket, close: closed, hold: false, destroyed: false, closeNow: () => { closeNow(); } };
    vi.spyOn(socket, "destroy").mockImplementation(() => { wire.destroyed = true; if (!wire.hold) closeNow(); return socket; });
    state.wires.push(wire); return socket;
  }) };
});
vi.mock("mysql2/promise", () => ({ default: { createConnection: vi.fn(async (options: {
  uri: string; stream(options: { config: { host: string; port: number } }): Socket;
}) => {
  const url = new URL(options.uri), socket = options.stream({ config: { host: url.hostname, port: Number(url.port || 3306) } });
  const wire = state.wires.find(value => value.socket === socket)!;
  const observer: Observer = { db: url.pathname.slice(1), wire, endCalls: 0 }; state.observers.push(observer);
  if (observer.db !== "mysql" && state.connectGate) {
    const pending = state.connectGate; state.connectGate = undefined;
    state.connectEntered?.resolve(observer); await pending.promise;
  }
  return {
    async query(input: string | { sql: string }, values: unknown[] = []) {
      const sql = typeof input === "string" ? input : input.sql;
      if (wire.destroyed) throw new Error("contract_connection_cancelled");
      if (sql.startsWith("SELECT @@server_uuid")) return [[{ uuid: state.uuid, db: observer.db }], []];
      if (sql.startsWith("CREATE DATABASE ")) { state.schemas.add(sql.split(String.fromCharCode(96))[1]!); return [{}, []]; }
      if (sql.startsWith("DROP DATABASE ")) { const name = sql.split(String.fromCharCode(96))[1]!; state.drops.push(name); state.schemas.delete(name); return [{}, []]; }
      if (sql.startsWith("SELECT SCHEMA_NAME")) {
        if (state.cleanupGate) { const pending = state.cleanupGate; state.cleanupGate = undefined; state.cleanupEntered?.resolve(); await pending.promise; }
        if (wire.destroyed) throw new Error("contract_connection_cancelled");
        return [state.schemas.has(String(values[0])) ? [{ SCHEMA_NAME: values[0] }] : [], []];
      }
      if (sql === "SELECT contract") return [observer.queryGate ? await observer.queryGate.promise : [], []];
      throw new Error("unexpected_owner_contract_sql");
    },
    async end() { observer.endCalls++; observer.onEnd?.(); if (observer.endGate) await observer.endGate.promise; socket.destroy(); },
    destroy() { socket.destroy(); },
  };
}) } }));
vi.mock("./fixtures/mysql-schema-cli.mjs", () => ({ createMysqlSchemaCliExecutor: vi.fn(() => async () => {}) }));
vi.mock("./fixtures/mysql-authority-cli.mjs", () => ({ createMysqlAuthorityCliExecutor: vi.fn(() => async () => {}) }));
vi.mock("./fixtures/mysql-runtime.mjs", () => ({
  witnessAbsentMysqlFixtureDatabase: vi.fn(async (input: { applicationDatabase: string; operationAbortSignal: AbortSignal }) => {
    state.preparationSignal = input.operationAbortSignal; return Object.freeze({ ...input });
  }),
  prepareMysqlRuntimeFixture: vi.fn(async (witness: { applicationDatabase: string; operationAbortSignal: AbortSignal }) => {
    state.prepareEntered?.resolve(); if (state.prepareGate) await state.prepareGate.promise;
    if (witness.operationAbortSignal.aborted) throw new Error("contract_preparation_cancelled");
    let closing: Promise<void> | undefined;
    return {
      runtimeEnv: { MYSQL_URL: "mysql://runtime@127.0.0.1:3306/" + witness.applicationDatabase },
      runtimeStoreOptions: { url: "mysql://runtime@127.0.0.1:3306/" + witness.applicationDatabase, migrationMode: "verify" },
      async assertReusable() { state.reuseEntered?.resolve(); if (state.reuseGate) await state.reuseGate.promise;
        if (witness.operationAbortSignal.aborted) throw new Error("contract_verification_cancelled"); },
      close(input: { successful: boolean }) {
        if (closing) return closing;
        state.runtimeCloses.push(input.successful);
        return closing = (async () => {
          state.formalEntered?.resolve(); if (state.formalGate) await state.formalGate.promise;
          if (input.successful && witness.operationAbortSignal.aborted) throw new Error("contract_formal_cleanup_cancelled");
          if (state.formalFailure) throw state.formalFailure.reason;
        })();
      },
    };
  }),
}));
vi.mock("../packages/store/src/index.js", () => ({ MysqlSessionStore: {
  connect: vi.fn(async (options: { operationAbortSignal: AbortSignal }) => {
    const value: Store = { signal: options.operationAbortSignal, entered: gate<void>(), closeCalls: 0 }; state.stores.push(value);
    return { async close() { value.closeCalls++; value.onClose?.(); value.entered.resolve(); if (value.gate) await value.gate.promise; if (value.failure) throw value.failure.reason; } };
  }),
  runSchemaOperation: vi.fn(async () => { if (state.schemaFailure) throw state.schemaFailure.reason; }),
} }));
function owner() {
  const value = new CurrentMysqlRuntimeOwner("mysql://root@127.0.0.1:3306/owner_contract_test"); state.owners.push(value); return value;
}
async function prepared() { const value = owner(); await own(value.prepare()); return value; }
function remainsPending(promise: Promise<unknown>) { const result = { settled: false }; void promise.then(() => { result.settled = true; }, () => { result.settled = true; }); return result; }
beforeEach(() => {
  state.schemas.clear(); state.wires.length = 0; state.observers.length = 0; state.stores.length = 0;
  state.gates.length = 0; state.owners.length = 0; state.pending.clear(); state.runtimeCloses.length = 0; state.drops.length = 0;
  Object.assign(state, { preparationSignal: undefined, prepareEntered: gate<void>(), prepareGate: undefined,
    connectEntered: undefined, connectGate: undefined, reuseEntered: undefined, reuseGate: undefined,
    formalEntered: undefined, formalGate: undefined, formalFailure: undefined, cleanupEntered: undefined,
    cleanupGate: undefined, schemaFailure: undefined });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  // Cleanup never replaces an earlier assertion failure. Every held original promise/close event is released and joined.
  const closing = state.owners.map(value => value.close({ successful: false }));
  for (const pending of state.gates) pending.release();
  for (const wire of state.wires) { wire.hold = false; wire.closeNow(); }
  await Promise.allSettled(closing);
  while (state.pending.size) await Promise.allSettled([...state.pending]);
  await Promise.all(state.wires.map(wire => wire.close));
  vi.restoreAllMocks();
});

// These are lifecycle/dispatch contracts at mocked ports, not schema/authority/ACL or remote-MDL proofs.
describe("CurrentMysqlRuntimeOwner close ownership (native/CLI doubles)", () => {
  it("seals public admission, joins late observers and uses graceful close without misclassifying a settled schema negative", async () => {
    const value = await prepared(); await own(value.openStore(1)); const observer = await own(value.openInspection());
    const original = state.observers.find(item => item.db === value.database)!;
    const expected = new Error("expected_migration_lock_rejection"); state.schemaFailure = { reason: expected };
    await expect(value.migrateWithLockTimeout(0)).rejects.toBe(expected); state.schemaFailure = undefined;
    expect(state.stores[0]!.signal.aborted).toBe(false);
    const connect = gate<void>(); state.connectGate = connect; state.connectEntered = gate<Observer>();
    const late = own(value.openInspection()), native = await state.connectEntered.promise; native.wire.hold = true;
    const storeGate = gate<void>(); state.stores[0]!.gate = storeGate;
    let reentered: Promise<void> | undefined, inspectionReentered: Promise<void> | undefined;
    state.stores[0]!.onClose = () => { reentered = value.close({ successful: true }); };
    original.onEnd = () => { inspectionReentered = observer.end(); };
    const closing = own(value.close({ successful: true })), completion = remainsPending(closing);
    expect(value.close({ successful: true })).toBe(closing);
    await expect(observer.query("SELECT contract")).rejects.toThrow("ownership is not proven");
    await expect(value.openStore(1)).rejects.toThrow("ownership is not proven");
    await expect(value.openInspection()).rejects.toThrow("ownership is not proven");
    expect(state.stores[0]!.signal.aborted).toBe(false); expect(state.preparationSignal!.aborted).toBe(false);
    connect.resolve(); const lateObserver = await late;
    await expect(lateObserver.query("SELECT contract")).rejects.toThrow("ownership is not proven");
    await state.stores[0]!.entered.promise;
    expect(reentered).toBe(closing); expect(inspectionReentered).toBe(observer.end());
    expect(original.endCalls).toBe(1); expect(native.endCalls).toBe(1);
    expect(completion.settled).toBe(false); expect(state.runtimeCloses).toEqual([]);
    storeGate.resolve(); await Promise.resolve(); expect(completion.settled).toBe(false);
    native.wire.closeNow(); await closing;
    expect(state.runtimeCloses).toEqual([true]); expect(state.drops).toEqual([value.database]);
    expect(state.wires.every(wire => wire.socket.closed)).toBe(true);
  });

  it("cancels an unready preparation synchronously and joins the original late result before retaining", async () => {
    const value = owner(), pending = gate<void>(); state.prepareGate = pending;
    const preparing = own(value.prepare()); await state.prepareEntered!.promise;
    const closing = own(value.close({ successful: false })), completion = remainsPending(closing);
    expect(state.preparationSignal!.aborted).toBe(true);
    expect(value.close({ successful: false })).toBe(closing); expect(completion.settled).toBe(false);
    pending.resolve(); await expect(preparing).rejects.toThrow("contract_preparation_cancelled"); await closing;
    expect(state.drops).toEqual([]); expect(state.schemas.has(value.database)).toBe(true);
    expect(state.wires.every(wire => wire.socket.closed)).toBe(true);
  });

  it("withdraws a cached successful close synchronously while an accepted observer factory is still held", async () => {
    const value = await prepared(); await own(value.openStore(1));
    const pending = gate<void>(); state.connectGate = pending; state.connectEntered = gate<Observer>();
    const late = own(value.openInspection()), native = await state.connectEntered.promise;
    const closing = own(value.close({ successful: true })), completion = remainsPending(closing);
    expect(state.stores[0]!.signal.aborted).toBe(false);
    expect(value.close({ successful: false })).toBe(closing);
    expect(state.stores[0]!.signal.aborted).toBe(true); expect(state.preparationSignal!.aborted).toBe(true);
    expect(native.wire.destroyed).toBe(true); expect(completion.settled).toBe(false);
    pending.resolve(); await expect(late).rejects.toThrow("ownership is not proven");
    await expect(closing).rejects.toBeInstanceOf(AggregateError);
    expect(state.runtimeCloses).toEqual([false]); expect(state.drops).toEqual([]);
  });

  it("withdraws a cached successful close while an accepted query is held and joins its cancelled native work", async () => {
    const value = await prepared(); await own(value.openStore(1));
    const observer = await own(value.openInspection()), native = state.observers.find(item => item.db === value.database)!;
    native.queryGate = gate<unknown[]>(); native.wire.hold = true;
    const query = own(observer.query("SELECT contract"));
    const closing = own(value.close({ successful: true })), completion = remainsPending(closing);
    await state.stores[0]!.entered.promise;
    expect(value.close({ successful: false })).toBe(closing);
    expect(state.stores[0]!.signal.aborted).toBe(true); expect(state.preparationSignal!.aborted).toBe(true);
    expect(native.wire.destroyed).toBe(true); expect(completion.settled).toBe(false);
    const cancelled = new Error("contract_query_cancelled"); native.queryGate.reject(cancelled);
    await expect(query).rejects.toBe(cancelled); expect(completion.settled).toBe(false);
    native.wire.closeNow(); await closing;
    expect(state.runtimeCloses).toEqual([false]); expect(state.drops).toEqual([]);
  });

  it.each(["store", "query"] as const)("aborts remaining consumers on a graceful %s rejection and joins all original work before exposing undefined", async kind => {
    const value = await prepared(); await own(value.openStore(1));
    const observer = await own(value.openInspection()), native = state.observers.find(item => item.db === value.database)!;
    native.wire.hold = true;
    let query: Promise<unknown> | undefined;
    if (kind === "store") {
      state.stores[0]!.failure = { reason: undefined }; await own(value.openStore(1));
    } else {
      native.queryGate = gate<unknown[]>(); query = own(observer.query("SELECT contract"));
    }
    const held = state.stores.at(-1)!, storeGate = gate<void>(); held.gate = storeGate;
    const aborted = gate<void>(); held.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    const closing = own(value.close({ successful: true })), completion = remainsPending(closing);
    if (kind === "query") { native.queryGate!.reject(undefined); await expect(query).rejects.toBeUndefined(); }
    await aborted.promise;
    expect(held.signal.aborted).toBe(true); expect(completion.settled).toBe(false); expect(state.runtimeCloses).toEqual([]);
    storeGate.resolve(); native.wire.closeNow();
    const failure: unknown = await closing.then(() => undefined, reason => reason);
    expect(failure).toBeInstanceOf(AggregateError); expect((failure as AggregateError).errors[0]).toBeUndefined();
    expect(state.runtimeCloses).toEqual([false]); expect(state.drops).toEqual([]);
  });

  it("does not promote graceful consumer completion past a rejected formal zero-reference boundary", async () => {
    const value = await prepared(); await own(value.openStore(1)); await own(value.openInspection());
    const zero = new Error("contract_nonzero_references"); state.formalFailure = { reason: zero };
    const failure: unknown = await own(value.close({ successful: true })).then(() => undefined, reason => reason);
    expect(failure).toBeInstanceOf(AggregateError); expect((failure as AggregateError).errors).toContain(zero);
    expect(state.runtimeCloses).toEqual([true]); expect(state.drops).toEqual([]); expect(state.schemas.has(value.database)).toBe(true);
  });

  it.each(["verification", "formal", "cleanup-query"] as const)("keeps the same close promise and stops unissued cleanup after withdrawal during %s", async phase => {
    const value = await prepared(); await own(value.openStore(1));
    const pending = gate<void>(), entered = gate<void>();
    if (phase === "verification") { state.reuseGate = pending; state.reuseEntered = entered; }
    else if (phase === "formal") { state.formalGate = pending; state.formalEntered = entered; }
    else { state.cleanupGate = pending; state.cleanupEntered = entered; }
    const closing = own(value.close({ successful: true })), completion = remainsPending(closing);
    await entered.promise;
    expect(value.close({ successful: false })).toBe(closing);
    expect(state.preparationSignal!.aborted).toBe(true); expect(state.stores[0]!.signal.aborted).toBe(true);
    expect(completion.settled).toBe(false); pending.resolve();
    await expect(closing).rejects.toBeInstanceOf(AggregateError);
    expect(state.drops).toEqual([]); expect(state.schemas.has(value.database)).toBe(true);
    expect(state.runtimeCloses).toEqual([phase === "verification" ? false : true]);
  });
});
