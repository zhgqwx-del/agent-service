import type { PoolConnection } from "mysql2/promise";
import {
  hasSchemaTriggerMetadataRelation, rewriteSchemaMetadataVerifierSql, SCHEMA_TRIGGER_METADATA_VARIABLE,
} from "./schema-metadata-codec.js";
import { readSchemaTriggerMetadata, type SchemaMetadataReaderConfig } from "./schema-metadata.js";

export class SchemaMetadataVerifierError extends Error {
  readonly code = "schema_metadata_invalid";
  constructor() { super("Schema trigger metadata verification failed."); this.name = "SchemaMetadataVerifierError"; }
}

type NativeResult = Awaited<ReturnType<PoolConnection["query"]>>;
const COUNT_WARNING_COLUMN = "@@session.warning_count";
const ALLOWED_WARNINGS = new Set([3719, 3778]);
// MySQL 8.0.27+ emits this parser warning for the unchanged byte-exact BINARY checks.
// Code 1287 covers other deprecated features too: only this calibrated message is allowed.
const BINARY_DEPRECATION_MESSAGE = "'BINARY expr' is deprecated and will be removed in a future release. Please use CAST instead";
function invalid(): never { throw new SchemaMetadataVerifierError(); }

function ownData(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length) invalid();
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
    copy[key] = descriptor.value;
  }
  return copy;
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

function integer(value: unknown): number {
  if (typeof value === "string" && /^(?:0|[1-9][0-9]{0,9})$/.test(value)) value = Number(value);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}

/** Only the private verifier's scalar parameter forms, not mysql2's SQL-producing object hooks. */
function parameters(value: unknown): unknown[] | undefined {
  if (value === undefined) return undefined;
  return rows(value, 16_384).map(item => {
    if (item === null || typeof item === "string" || typeof item === "boolean"
      || typeof item === "number" && Number.isFinite(item)) return item;
    if (Buffer.isBuffer(item)) return Buffer.from(item);
    invalid();
  });
}

function queryArguments(input: readonly unknown[]): { args: unknown[]; rewritten: boolean } {
  if (input.length < 1 || input.length > 2) invalid();
  const first = input[0];
  let sql: string, options: Record<string, unknown> | undefined;
  let values = parameters(input[1]);
  if (typeof first === "string") sql = first;
  else {
    if (first === null || typeof first !== "object" || Array.isArray(first)
      || Object.getPrototypeOf(first) !== Object.prototype && Object.getPrototypeOf(first) !== null) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(first);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== "string" || !["sql", "timeout", "values"].includes(key))) invalid();
    const captured = ownData(first, keys as string[]);
    if (typeof captured.sql !== "string") invalid();
    sql = captured.sql; options = { sql };
    if (Object.hasOwn(captured, "timeout")) {
      if (typeof captured.timeout !== "number" || !Number.isSafeInteger(captured.timeout)
        || captured.timeout < 0 || captured.timeout > 2_147_483_647) invalid();
      options.timeout = captured.timeout;
    }
    if (Object.hasOwn(captured, "values")) {
      if (input.length !== 1) invalid();
      values = parameters(captured.values);
      options.values = values;
    }
  }
  const rewritten = hasSchemaTriggerMetadataRelation(sql);
  if (rewritten) sql = rewriteSchemaMetadataVerifierSql(sql);
  if (options) options.sql = sql;
  const args: unknown[] = [options ?? sql];
  if (input.length === 2) args.push(values);
  return { args, rewritten };
}

/**
 * Private verifyMigrations scope only. This is not a general pool/query interceptor or an
 * authorization source. The caller exclusively owns this native connection and its cancellation
 * / socket-close barrier; this helper never releases it or patches a native method.
 */
export async function withSchemaTriggerMetadataVerifier<T>(
  conn: Pick<PoolConnection, "query" | "destroy">,
  config: SchemaMetadataReaderConfig,
  work: (facade: Pick<PoolConnection, "query">) => Promise<T>,
): Promise<T> {
  const nativeQuery = conn.query, nativeDestroy = conn.destroy;
  let closed = false, firstFailure: SchemaMetadataVerifierError | undefined;
  let tail: Promise<void> = Promise.resolve();
  const pending = new Set<Promise<NativeResult>>();

  async function native(args: readonly unknown[]): Promise<NativeResult> {
    try { return await Reflect.apply(nativeQuery, conn, args) as NativeResult; }
    catch { throw new SchemaMetadataVerifierError(); }
  }

  async function warnings(): Promise<void> {
    const [countResult] = await native(["SHOW COUNT(*) WARNINGS"]);
    const countRows = rows(countResult, 1);
    if (countRows.length !== 1) invalid();
    const count = integer(ownData(countRows[0], [COUNT_WARNING_COLUMN])[COUNT_WARNING_COLUMN]);
    if (count > 64) invalid();
    const [warningResult] = await native(["SHOW WARNINGS"]);
    const warningRows = rows(warningResult, 64);
    if (warningRows.length !== count) invalid();
    for (const candidate of warningRows) {
      const row = ownData(candidate, ["Level", "Code", "Message"]);
      const code = integer(row.Code);
      if (row.Level !== "Warning" || !(ALLOWED_WARNINGS.has(code)
        || code === 1287 && row.Message === BINARY_DEPRECATION_MESSAGE)
        || typeof row.Message !== "string" || Buffer.byteLength(row.Message, "utf8") > 65_536
        || Buffer.from(row.Message, "utf8").toString("utf8") !== row.Message) invalid();
    }
  }

  function rejected(error: SchemaMetadataVerifierError): Promise<NativeResult> {
    const promise = Promise.reject<NativeResult>(error);
    // Observe even a caller's detached late reuse, but keep the original rejection for its caller.
    void promise.catch(() => {});
    return promise;
  }

  function query(...input: unknown[]): Promise<NativeResult> {
    if (closed) return rejected(new SchemaMetadataVerifierError());
    if (firstFailure) return rejected(firstFailure);
    let prepared: ReturnType<typeof queryArguments>;
    try { prepared = queryArguments(input); }
    catch { firstFailure = new SchemaMetadataVerifierError(); return rejected(firstFailure); }
    // A logical query includes its diagnostics. Interleaving another native query before SHOW
    // WARNINGS would silently attribute its warnings to the wrong fingerprint statement.
    const task = tail.then(async () => {
      if (firstFailure) throw firstFailure;
      try {
        const result = await native(prepared.args);
        if (prepared.rewritten) await warnings();
        return result;
      } catch {
        firstFailure ??= new SchemaMetadataVerifierError();
        throw firstFailure;
      }
    });
    pending.add(task);
    tail = task.then(() => {}, () => {});
    void task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
  }

  const facade: Pick<PoolConnection, "query"> = Object.freeze({ query: query as PoolConnection["query"] });
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    const snapshot = await readSchemaTriggerMetadata(conn, config).catch(() => { throw new SchemaMetadataVerifierError(); });
    await native([`SET ${SCHEMA_TRIGGER_METADATA_VARIABLE}=?`, [JSON.stringify(snapshot.rows)]]);
    outcome = { ok: true, value: await work(facade) };
  } catch (error) { outcome = { ok: false, error }; }
  finally {
    // Closing admission precedes every await. Detached accepted work is still owned by this scope.
    closed = true;
    while (pending.size) await Promise.allSettled([...pending]);
    try { await native([`SET ${SCHEMA_TRIGGER_METADATA_VARIABLE}=NULL`]); }
    catch {
      // destroy() has a void mysql2 API. The native owner still waits its socket-close barrier;
      // never release a connection whose metadata variable could not be cleared.
      try { Reflect.apply(nativeDestroy, conn, []); } catch { /* fixed error below, no driver cause */ }
      throw new SchemaMetadataVerifierError();
    }
  }
  if (!outcome.ok) throw outcome.error;
  if (firstFailure) throw firstFailure;
  return outcome.value;
}
