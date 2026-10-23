import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { lookup } from "node:dns";
import type { LookupFunction, Socket } from "node:net";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type TestContext } from "vitest";
import {
  BLOB_STORAGE_FORMAT,
  BLOB_STORAGE_MIGRATION_SOURCE_BACKEND,
  BlobStorageMigrationConflictError,
  BlobTooLargeError,
  FsBlobStore,
  MysqlBlobStorageMigrationCoordinator,
  MysqlSessionStore,
  S3BlobStore,
  USER_DATA_EXPORT_CONTENT_TYPE,
  appendBlobStorageMigrationRoot,
  blobStorageKey,
  blobStorageMigrationTargetOwnerSha256,
  emptyBlobStorageMigrationRoot,
  newUserDataExportArtifactId,
  newUserDataExportRequestId,
  userDataExportAuthorization,
  userDataExportIdempotencyKeySha256,
  userDataExportRequestHash,
  userDataExportStorageKey,
  type BeginBlobStorageMigrationInput,
  type BlobDescriptor,
  type UserDataExportAuthorization,
} from "../src/index.js";
import { mkSession, newId } from "./conformance.js";
import { CurrentMysqlInspection } from "./fixtures/current-mysql-runtime.js";
import { acquireFixtureSessionAuthority } from "./fixtures/session-authority.js";
import { createMysqlOperationAbortTransport } from "../src/mysql/operation-abort.js";
import { prepareMysqlRuntimeFixture, witnessAbsentMysqlFixtureDatabase } from "../../../test/fixtures/mysql-runtime.mjs";
import { createMysqlSchemaCliExecutor } from "../../../test/fixtures/mysql-schema-cli.mjs";
import { createMysqlAuthorityCliExecutor } from "../../../test/fixtures/mysql-authority-cli.mjs";

type Row = RowDataPacket;
type RootScope = "inventory" | "object-acks" | "target-cleanup" | "source-cleanup";

const MAX_BYTES = 1024 * 1024;
const FLEET_DRAINED_EVIDENCE = "a".repeat(64);
const TEST_PREFIX_ROOT = "blob-migration-tests";
const mysqlGate = process.env.AGENT_SERVICE_INTEGRATION ?? "0";
const s3Gate = process.env.AGENT_SERVICE_S3_INTEGRATION ?? "0";
if (!["0", "1"].includes(mysqlGate) || !["0", "1"].includes(s3Gate)) {
  throw new Error("integration gates must be 0 or 1");
}
const integrationEnabled = mysqlGate === "1" && s3Gate === "1";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the real MySQL + MinIO migration suite`);
  return value;
}

function disposableBase(raw: string): URL {
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) {
    throw new Error(`MYSQL_TEST_URL must name a disposable test database, got ${database}`);
  }
  return url;
}

function databaseUrl(base: URL, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function testEndpoint(raw: string): URL {
  const endpoint = new URL(raw);
  if (
    !["http:", "https:"].includes(endpoint.protocol)
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash
    || (endpoint.pathname && endpoint.pathname !== "/")
  ) {
    throw new Error("S3_TEST_ENDPOINT must be an absolute http(s) origin without credentials");
  }
  return endpoint;
}

const base = integrationEnabled
  ? disposableBase(required("MYSQL_TEST_URL"))
  : new URL("mysql://root@127.0.0.1:3306/agent_service_test");
const endpoint = integrationEnabled
  ? testEndpoint(required("S3_TEST_ENDPOINT"))
  : new URL("http://127.0.0.1:9000");
const region = integrationEnabled ? required("S3_TEST_REGION") : "us-east-1";
const bucket = integrationEnabled ? required("S3_TEST_BUCKET") : "disabled-s3-integration";
const accessKeyId = integrationEnabled ? required("S3_TEST_ACCESS_KEY_ID") : "disabled";
const secretAccessKey = integrationEnabled ? required("S3_TEST_SECRET_ACCESS_KEY") : "disabled";
const forcePathStyleRaw = integrationEnabled ? required("S3_TEST_FORCE_PATH_STYLE") : "1";
if (forcePathStyleRaw !== "0" && forcePathStyleRaw !== "1") {
  throw new Error("S3_TEST_FORCE_PATH_STYLE must be 0 or 1");
}
const s3ClientConfig: S3ClientConfig = {
  endpoint: endpoint.origin,
  region,
  forcePathStyle: forcePathStyleRaw === "1",
  credentials: { accessKeyId, secretAccessKey },
  maxAttempts: 2,
};

function assertGeneratedDatabaseName(database: string): void {
  if (!/^agent_service_blob_migration_test_[0-9]+_[0-9a-f]{12}$/.test(database)) {
    throw new Error("refusing to operate on a non-generated migration test database");
  }
}

function assertGeneratedPrefix(prefix: string): void {
  if (!/^blob-migration-tests\/[0-9a-f]{24}$/.test(prefix)) {
    throw new Error("refusing to clean a non-generated migration test prefix");
  }
}

async function listPrefix(prefix: string, client: S3Client): Promise<string[]> {
  assertGeneratedPrefix(prefix);
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: `${prefix}/`,
      ContinuationToken: continuationToken,
    }));
    for (const object of page.Contents ?? []) {
      if (!object.Key?.startsWith(`${prefix}/`)) {
        throw new Error("S3 migration-test cleanup escaped its generated prefix");
      }
      keys.push(object.Key);
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && !continuationToken) {
      throw new Error("S3 migration-test cleanup listing omitted its continuation token");
    }
  } while (continuationToken);
  return keys;
}

async function cleanupPrefix(prefix: string, client: S3Client): Promise<void> {
  assertGeneratedPrefix(prefix);
  while (true) {
    const keys = await listPrefix(prefix, client);
    if (keys.length === 0) return;
    for (let offset = 0; offset < keys.length; offset += 1_000) {
      const batch = keys.slice(offset, offset + 1_000);
      const result = await client.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Quiet: true, Objects: batch.map((Key) => ({ Key })) },
      }));
      if ((result.Errors?.length ?? 0) > 0) {
        throw new Error("S3 migration-test cleanup reported an object error");
      }
    }
  }
}

async function deleteOutOfContractTargetObject(
  prefix: string,
  storageKey: string,
  client: S3Client,
): Promise<void> {
  assertGeneratedPrefix(prefix);
  if (
    storageKey.length === 0
    || storageKey.length > 512
    || !storageKey.split("/").every((segment) => (
      segment.length > 0
      && segment.length <= 128
      && /^[a-z0-9_-]+$/.test(segment)
    ))
  ) {
    throw new Error("refusing to delete an invalid migration-test storage key");
  }
  const key = `${prefix}/${storageKey}`;
  if (!key.startsWith(`${TEST_PREFIX_ROOT}/`) || !key.startsWith(`${prefix}/`)) {
    throw new Error("refusing to delete outside the generated migration-test prefix");
  }
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

const fixtureFailure = () => new Error("Blob migration fixture ownership is not proven");
const sourceCwd = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const sourceMain = fileURLToPath(new URL("../../../apps/agent-runner/src/main.ts", import.meta.url));
const schemaExecutor = createMysqlSchemaCliExecutor({ entrypoint: sourceMain, mode: "source", cwd: sourceCwd });
const authorityExecutor = createMysqlAuthorityCliExecutor({ entrypoint: sourceMain, mode: "source", cwd: sourceCwd });

async function preserveFirst<T>(body: () => Promise<T>, cleanup: (bodyFailed: boolean) => Promise<unknown>): Promise<T> {
  let failed = false, first: unknown, value: T | undefined;
  try { value = await body(); } catch (error) { failed = true; first = error; }
  try { await cleanup(failed); } catch (error) { if (!failed) { failed = true; first = error; } }
  if (failed) throw first;
  return value as T;
}
async function closeAll(operations: (() => unknown | Promise<unknown>)[]): Promise<void> {
  let failed = false, first: unknown;
  for (const operation of operations) try { await operation(); }
  catch (error) { if (!failed) { failed = true; first = error; } }
  if (failed) throw first;
}
function own<T>(pending: Set<Promise<unknown>>, task: Promise<T>): Promise<T> {
  pending.add(task); void task.then(() => pending.delete(task), () => pending.delete(task)); return task;
}
async function drain(pending: Set<Promise<unknown>>): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}

/** Same SDK-default agents: keepAlive=true, maxSockets=50, all other Agent options unchanged.
 * The actual SDK send Promise is returned unchanged; late native bodies and sockets are joined. */
function ownedS3Client(signal: AbortSignal) {
  let stopped = false, closing: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>(), closes = new Set<Promise<unknown>>();
  const sockets = new Set<Readable>(), bodies = new Set<Readable>();
  let failure: { error: unknown } | undefined;
  const remember = (error: unknown) => { failure ??= { error }; };
  const nativeLookup: LookupFunction = (hostname, options, callback) => {
    if (stopped) throw fixtureFailure();
    let done!: () => void;
    const task = new Promise<void>(resolve => { done = resolve; }); closes.add(task);
    const finish = () => { closes.delete(task); done(); };
    try { lookup(hostname, options, (error, address, family) => {
      try { callback(error, address, family); } finally { finish(); }
    }); } catch (error) { finish(); throw error; }
  };
  const httpAgent = new HttpAgent({ keepAlive: true, maxSockets: 50, lookup: nativeLookup });
  const httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 50, lookup: nativeLookup });
  const observe = (value: Readable, accepted: Set<Readable>) => {
    if (value.closed) return;
    if (sockets.has(value) || bodies.has(value)) return;
    accepted.add(value);
    const error = () => {};
    value.on("error", error);
    const task = new Promise<void>(resolve => value.once("close", () => {
      accepted.delete(value); value.off("error", error); resolve();
    }));
    closes.add(task); void task.then(() => closes.delete(task));
    if (stopped) try { value.destroy(); } catch (error) { remember(error); }
  };
  const observeAgent = (agent: HttpAgent) => {
    const original = agent.createConnection;
    agent.createConnection = function (this: HttpAgent, ...args: Parameters<typeof original>) {
      if (stopped) throw fixtureFailure();
      const socket = Reflect.apply(original, this, args) as ReturnType<typeof original>;
      if (!socket) throw fixtureFailure();
      observe(socket, sockets); return socket;
    };
  };
  observeAgent(httpAgent); observeAgent(httpsAgent);
  const client = new S3Client({ ...s3ClientConfig, requestHandler: { httpAgent, httpsAgent } });
  const originalSend = client.send;
  const observedSend = function (this: S3Client, ...args: unknown[]) {
    if (this !== client || stopped) throw fixtureFailure();
    const task = Reflect.apply(originalSend, this, args) as unknown;
    if (!(task instanceof Promise)) throw fixtureFailure();
    own(pending, task);
    // Observe before the caller can consume a successful response. Never replace its Promise.
    void task.then(output => {
      if (!output || typeof output !== "object" || !("Body" in output)) return;
      const body: unknown = output.Body;
      if (body === undefined || body instanceof Uint8Array) return;
      if (!(body instanceof Readable)) { remember(fixtureFailure()); return; }
      observe(body, bodies);
    }, () => {}).catch(remember);
    return task;
  };
  Object.defineProperty(client, "send", { configurable: true, writable: true, value: observedSend });
  const stop = () => {
    stopped = true;
    for (const operation of [() => client.destroy(), () => httpAgent.destroy(), () => httpsAgent.destroy(),
      ...[...sockets].map(socket => () => socket.destroy()), ...[...bodies].map(body => () => body.destroy())]) {
      try { operation(); } catch (error) { remember(error); }
    }
  };
  signal.addEventListener("abort", stop, { once: true }); if (signal.aborted) stop();
  return { client, stop, close(): Promise<void> {
    return closing ??= (async () => {
      stop();
      try { while (pending.size || closes.size) await Promise.allSettled([...pending, ...closes]); }
      finally { signal.removeEventListener("abort", stop); }
      if (failure) throw failure.error;
    })();
  } };
}

type NativeInspection = CurrentMysqlInspection;
/** Operator SQL only. No ordinary writer or Connection-shaped object is manufactured. */
function nativeInspection(url: string, signal: AbortSignal, pending: Set<Promise<unknown>>,
  accepted: Set<NativeInspection>, nativeFailures: unknown[], expected?: { database: string; serverUuid: string }): Promise<NativeInspection> {
  const transport = createMysqlOperationAbortTransport(signal);
  let socket: Socket | undefined, connection: Connection | undefined;
  const abort = () => {
    try { connection?.destroy(); } catch (error) { nativeFailures.push(error); }
    try { transport.close(); } catch (error) { nativeFailures.push(error); }
  };
  signal.addEventListener("abort", abort, { once: true });
  const task = preserveFirst(async () => {
    signal.throwIfAborted();
    connection = await mysql.createConnection({ uri: url, stream(options: Parameters<ReturnType<typeof createMysqlOperationAbortTransport>["stream"]>[0]) {
      if (socket) throw fixtureFailure(); socket = transport.stream(options); return socket;
    } });
    signal.throwIfAborted(); if (!socket) throw fixtureFailure();
    const nativeClosed = transport.settled();
    const value = new CurrentMysqlInspection(connection, socket, nativeClosed, signal,
      () => { signal.removeEventListener("abort", abort); transport.close(); });
    accepted.add(value);
    const [rows] = await value.query<Row[]>("SELECT @@server_uuid AS uuid,DATABASE() AS db");
    const actual = rows[0];
    if (rows.length !== 1 || !actual || typeof actual.uuid !== "string" || typeof actual.db !== "string"
      || actual.db !== decodeURIComponent(new URL(url).pathname.slice(1))
      || expected && (actual.db !== expected.database || actual.uuid.toLowerCase() !== expected.serverUuid.toLowerCase())) throw fixtureFailure();
    return value;
  }, async failed => {
    if (!failed) return;
    let cleanupError: { error: unknown } | undefined;
    try { connection?.destroy(); } catch (error) { cleanupError = { error }; }
    try { transport.close(); } catch (error) { cleanupError ??= { error }; }
    await transport.settled(); signal.removeEventListener("abort", abort);
    if (cleanupError) throw cleanupError.error;
  });
  return own(pending, task);
}

const suiteCancellation = new AbortController();
const suitePending = new Set<Promise<unknown>>(), suiteInspections = new Set<NativeInspection>();
const suiteNativeFailures: unknown[] = [];
let admin: NativeInspection | undefined;
const acceptedFixtures = new Set<MigrationFixtureSlot>(), acceptedCases = new Set<Promise<unknown>>();

interface MigrationFixture {
  database: string;
  url: string;
  root: string;
  prefix: string;
  namespaceId: string;
  source: FsBlobStore;
  target: S3BlobStore;
  conn: NativeInspection;
  cleanupClient: S3Client;
  connect(exclusive?: boolean): Promise<MysqlBlobStorageMigrationCoordinator>;
  connectAttempt(): Promise<MysqlBlobStorageMigrationCoordinator>;
  openStore(connectionLimit: number): Promise<MysqlSessionStore>;
  openInspection(): Promise<NativeInspection>;
  ownOperation<T>(task: Promise<T>): Promise<T>;
  onCancel(unblock: () => void): void;
  waitForEntry(entered: Promise<void>, operation: Promise<unknown>): Promise<void>;
  cancel(): void;
  newTarget(overrides?: { namespaceId?: string; prefix?: string }): S3BlobStore;
  close(): Promise<void>;
}
interface MigrationFixtureSlot {
  prepare(): Promise<MigrationFixture>;
  finish(successful: boolean): Promise<void>;
  cancel(): void;
}

/** One original generated DB and prefix per case; this is not a reusable generic owner. */
function migrationFixtureSlot(caseSignal: AbortSignal): MigrationFixtureSlot {
  const id = randomUUID().replaceAll("-", "").slice(0, 24);
  const database = `agent_service_blob_migration_test_${process.pid}_${id.slice(0, 12)}`;
  const prefix = `${TEST_PREFIX_ROOT}/${id}`, namespaceId = `blob-migration-${id}`;
  assertGeneratedDatabaseName(database); assertGeneratedPrefix(prefix);
  const url = databaseUrl(base, database);
  const preparation = new AbortController(), consumers = new AbortController();
  const preparationSignal = AbortSignal.any([caseSignal, preparation.signal]);
  const signal = AbortSignal.any([caseSignal, consumers.signal]);
  const pending = new Set<Promise<unknown>>(), operations = new Set<Promise<unknown>>();
  const inspections = new Set<NativeInspection>(), stores = new Set<MysqlSessionStore>();
  const nativeFailures: unknown[] = [];
  let cleanup: ReturnType<typeof ownedS3Client> | undefined;
  const coordinators = new Set<MysqlBlobStorageMigrationCoordinator>(), poolClosers = new Set<() => Promise<void>>();
  const targets = new Set<S3BlobStore>(), clients = new Set<ReturnType<typeof ownedS3Client>>();
  const unblocks = new Set<() => void>();
  let runtime: Awaited<ReturnType<typeof prepareMysqlRuntimeFixture>> | undefined;
  let preparing: Promise<MigrationFixture> | undefined, closing: Promise<void> | undefined, finishing: Promise<void> | undefined;
  let root: string | undefined, ready = false, createAttempted = false, created = false;
  const active = () => { if (closing || signal.aborted) throw fixtureFailure(); };
  const unblock = () => { for (const action of unblocks) action(); };
  signal.addEventListener("abort", unblock, { once: true });
  const cancel = () => { unblock(); consumers.abort(); preparation.abort(); };
  const coordinatorFactory = (exclusive?: boolean): Promise<MysqlBlobStorageMigrationCoordinator> => {
    active();
    const transport = createMysqlOperationAbortTransport(signal);
    let seen = 0, captured: ReturnType<typeof mysql.createPool> | undefined;
    let ending: Promise<void> | undefined;
    const originalFactory = mysql.createPool;
    const spy = vi.spyOn(mysql, "createPool").mockImplementation(function (this: typeof mysql, options) {
      seen += 1;
      if (this !== mysql || seen !== 1 || typeof options !== "object" || options === null
        || Object.keys(options).sort().join(",") !== "bigNumberStrings,connectionLimit,supportBigNumbers,uri"
        || options.uri !== url || options.connectionLimit !== 3
        || options.supportBigNumbers !== true || options.bigNumberStrings !== false) throw fixtureFailure();
      // Only add the same-endpoint socket owner. All original native options are retained.
      const pool = Reflect.apply(originalFactory, this, [{ ...options, stream: transport.stream }]) as ReturnType<typeof mysql.createPool>;
      captured = pool;
      const originalEnd = pool.end;
      pool.end = function () {
        if (this !== pool) throw fixtureFailure();
        return ending ??= Reflect.apply(originalEnd, this, []) as Promise<void>;
      };
      return pool;
    });
    poolClosers.add(async () => {
      await preserveFirst(async () => { if (captured) await captured.end(); }, async () => {
        transport.close(); await transport.settled();
      });
    });
    let task: Promise<MysqlBlobStorageMigrationCoordinator>;
    try {
      task = exclusive === undefined
        ? MysqlBlobStorageMigrationCoordinator.connect({ url, connectionLimit: 3 })
        : MysqlBlobStorageMigrationCoordinator.connect({ url, connectionLimit: 3, exclusive });
      own(pending, task);
    } finally { spy.mockRestore(); }
    if (seen !== 1) { void task!.catch(() => {}); throw fixtureFailure(); }
    void task!.then(value => { coordinators.add(value); }, () => {});
    return task!;
  };
  const newTarget = (overrides: { namespaceId?: string; prefix?: string } = {}) => {
    active();
    const client = ownedS3Client(signal); clients.add(client);
    const target = new S3BlobStore({ bucket, prefix: overrides.prefix ?? prefix,
      namespaceId: overrides.namespaceId ?? namespaceId, requestTimeoutMs: 5_000, client: client.client });
    targets.add(target); return target;
  };
  const closeConsumers = (): Promise<void> => {
    if (closing) return closing;
    // Fence new factories synchronously; unblock the one original held-put latch before joining.
    closing = (async () => {
      unblock(); await drain(pending);
      await closeAll([
        ...[...coordinators].map(value => () => value.close()),
        ...[...stores].map(value => () => value.close()),
        ...[...targets].map(value => () => value.close()),
        ...[...clients].map(value => () => value.close()),
        ...[...inspections].map(value => () => value.end()),
        ...poolClosers,
        () => drain(operations),
        () => { if (nativeFailures.length) throw nativeFailures[0]; },
      ]);
    })();
    return closing;
  };
  const slot: MigrationFixtureSlot = {
    cancel,
    prepare() {
      if (preparing) return preparing;
      if (finishing || caseSignal.aborted) return Promise.reject(fixtureFailure());
      return preparing = (async () => {
        cleanup = ownedS3Client(preparationSignal);
        const controlUrl = new URL(base); controlUrl.pathname = "/mysql";
        const creator = await nativeInspection(controlUrl.toString(), preparationSignal, pending, inspections, nativeFailures);
        const witness = await witnessAbsentMysqlFixtureDatabase({ operatorUrl: url, applicationDatabase: database,
          operationAbortSignal: preparationSignal });
        preparationSignal.throwIfAborted(); createAttempted = true;
        await creator.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`); created = true;
        await creator.end();
        runtime = await prepareMysqlRuntimeFixture(witness, { schemaExecutor, authorityExecutor });
        await runtime.assertReusable(url); preparationSignal.throwIfAborted();
        const conn = await nativeInspection(url, signal, pending, inspections, nativeFailures,
          { database, serverUuid: runtime.serverUuid });
        root = await mkdtemp(join(tmpdir(), "agent-service-blob-migration-")); active();
        const source = new FsBlobStore(root), target = newTarget();
        await target.validateStartup(); active(); ready = true;
        return { database, url, root, prefix, namespaceId, source, target, conn, cleanupClient: cleanup.client,
          connect: (exclusive = true) => coordinatorFactory(exclusive),
          connectAttempt: () => coordinatorFactory(),
          openStore(connectionLimit) {
            active();
            if (!runtime) return Promise.reject(fixtureFailure());
            const task = MysqlSessionStore.connect({ ...runtime.runtimeStoreOptions, connectionLimit, operationAbortSignal: signal });
            void task.then(value => { stores.add(value); }, () => {}); return own(pending, task);
          },
          openInspection() { active(); if (!runtime) return Promise.reject(fixtureFailure());
            return nativeInspection(url, signal, pending, inspections, nativeFailures, { database, serverUuid: runtime.serverUuid }); },
          ownOperation: task => own(operations, task),
          onCancel(action) { unblocks.add(action); if (signal.aborted) action(); },
          async waitForEntry(entered, operation) {
            signal.throwIfAborted(); let abort!: () => void;
            const cancelled = new Promise<never>((_resolve, reject) => {
              abort = () => reject(fixtureFailure()); signal.addEventListener("abort", abort, { once: true });
            });
            try { await Promise.race([entered, cancelled, operation.then(() => { throw fixtureFailure(); })]); }
            finally { signal.removeEventListener("abort", abort); }
          },
          cancel, newTarget, close: closeConsumers,
        };
      })();
    },
    finish(successful) {
      if (finishing) return finishing;
      return finishing = (async () => {
        if (!successful || caseSignal.aborted) cancel();
        await preparing?.catch(() => {});
        let failure: { error: unknown } | undefined;
        try { await closeConsumers(); } catch (error) { failure = { error }; }
        const clean = successful && ready && created && !caseSignal.aborted && !failure;
        try {
          if (runtime) {
            if (clean) {
              // All original consumers are already closed. This is a new actual restricted
              // full startup, not the weaker fixture existence/account-state check.
              const freshFactory = own(pending, MysqlSessionStore.connect({ ...runtime.runtimeStoreOptions,
                connectionLimit: 4, operationAbortSignal: preparationSignal }));
              await preserveFirst(async () => {
                const fresh = await freshFactory;
                await fresh.sessionAuthority.identity();
              }, async () => {
                // Join the original accepted factory even on failure/cancellation; a late
                // fulfilled Store must complete its actual native close before any removal.
                const [result] = await Promise.allSettled([freshFactory]);
                if (result!.status === "fulfilled") await result!.value.close();
              });
              await runtime.assertReusable(url);
            }
            await runtime.close({ successful: clean });
          }
          if (clean) {
            // Every owned ordinary/operator pool and S3 task/socket is closed before removal.
            if (!runtime || !cleanup) throw fixtureFailure();
            await cleanupPrefix(prefix, cleanup.client);
            const controlUrl = new URL(base); controlUrl.pathname = "/mysql";
            const cleaner = await nativeInspection(controlUrl.toString(), preparationSignal, pending, inspections, nativeFailures,
              { database: "mysql", serverUuid: runtime.serverUuid });
            await preserveFirst(async () => {
              const [rows] = await cleaner.query<Row[]>("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", [database]);
              if (rows.length !== 1 || rows[0]?.SCHEMA_NAME !== database) throw fixtureFailure();
              assertGeneratedDatabaseName(database); await cleaner.query(`DROP DATABASE \`${database}\``);
              const [after] = await cleaner.query<Row[]>("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", [database]);
              if (after.length !== 0) throw fixtureFailure();
            }, () => cleaner.end());
            if (root) await rm(root, { recursive: true, force: true });
          } else if (createAttempted) {
            console.warn(JSON.stringify({ schema: "blob-migration-authority-fixture-retained-v1", database, prefix,
              ...(root ? { root } : {}), state: "retained_or_unknown" }));
          }
        } catch (error) { failure ??= { error }; }
        finally {
          cancel();
          try { await closeAll([
            // On a cold-start/assertReusable failure retain the original fixture handle.
            // If close(true) already ran, its cached original Promise is only re-read.
            () => runtime?.close({ successful: false }),
            ...[...inspections].map(value => () => value.end()), () => cleanup?.close(),
          ]); }
          catch (error) { failure ??= { error }; }
          await drain(pending); await drain(operations);
          signal.removeEventListener("abort", unblock);
        }
        if (failure) throw failure.error;
      })();
    },
  };
  // Admission is synchronous, before prepare() can create a directory, socket, DB or child.
  acceptedFixtures.add(slot); return slot;
}
function migrationCase(context: TestContext, body: (fixture: MigrationFixture) => Promise<void>): Promise<void> {
  const slot = migrationFixtureSlot(context.signal);
  let successful = false;
  const task = preserveFirst(async () => { const fixture = await slot.prepare(); await body(fixture); successful = true; },
    () => slot.finish(successful));
  return own(acceptedCases, task);
}

function migrationInput(
  fixture: MigrationFixture,
  migrationId: string,
): BeginBlobStorageMigrationInput {
  return {
    migrationId,
    expectedControlGeneration: 0,
    sourceBackend: BLOB_STORAGE_MIGRATION_SOURCE_BACKEND,
    sourceNamespaceSha256: fixture.source.namespaceSha256,
    targetBackend: fixture.target.backend,
    targetNamespaceSha256: fixture.target.namespaceSha256,
    rollbackWindowMs: 0,
    sourceCleanupDelayMs: 0,
    fleetDrainedEvidenceSha256: FLEET_DRAINED_EVIDENCE,
  };
}

function migrationOperatorLockName(database: string): string {
  const databaseSha256 = createHash("sha256").update(database).digest("hex");
  return `agent-service:blob-mover:${databaseSha256.slice(0, 32)}`;
}

async function waitForMigrationControlLockWait(fixture: MigrationFixture): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [rows] = await fixture.conn.query<Row[]>(
      `SELECT COUNT(*) AS wait_count
         FROM performance_schema.data_lock_waits w
         JOIN performance_schema.data_locks requested
           ON requested.engine_lock_id=w.requesting_engine_lock_id
        WHERE BINARY requested.object_schema=BINARY ?
          AND BINARY requested.object_name=BINARY 'blob_storage_migration_control'`,
      [fixture.database],
    );
    if (Number(rows[0]?.wait_count) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("replacement operator did not wait for the migration control mutation fence");
}

async function insertBlobManifest(
  fixture: MigrationFixture,
  input: {
    blobId: string;
    storageKey: string;
    uploadToken: string;
    state: "ready" | "delete_pending" | "staging";
    descriptor?: BlobDescriptor;
  },
): Promise<void> {
  const nowMs = Date.now();
  await fixture.conn.query(
    `INSERT INTO blob_objects
       (blob_id,tenant_id,user_id,session_id,item_id,purpose,storage_backend,storage_format,
        storage_key,upload_token,state,sha256,size_bytes,content_type,uploaded_at_ms,ready_at_ms,
        staging_expires_at_ms,delete_after_ms,deleted_at_ms,deletion_generation,created_at_ms)
     VALUES (?,?,?,?,NULL,'tool_output', ?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?)`,
    [
      input.blobId,
      `tenant-${input.blobId}`,
      `user-${input.blobId}`,
      `session-${input.blobId}`,
      fixture.source.backend,
      BLOB_STORAGE_FORMAT,
      input.storageKey,
      input.uploadToken,
      input.state,
      input.descriptor ? Buffer.from(input.descriptor.sha256, "hex") : null,
      input.descriptor?.sizeBytes ?? null,
      input.descriptor?.contentType ?? null,
      input.state === "ready" ? nowMs : null,
      input.state === "ready" ? nowMs : null,
      input.state === "staging" ? nowMs + 60_000 : null,
      input.state === "delete_pending" ? nowMs : null,
      null,
      0,
      nowMs,
    ],
  );
}

async function seedReadyBlob(
  fixture: MigrationFixture,
  blobId: string,
  storageKey: string,
  uploadToken: string,
  data: Buffer | string,
): Promise<BlobDescriptor> {
  const descriptor = await fixture.source.putIfAbsent(storageKey, data, {
    uploadToken,
    maxBytes: MAX_BYTES,
    contentType: "application/octet-stream",
  });
  await insertBlobManifest(fixture, {
    blobId,
    storageKey,
    uploadToken,
    state: "ready",
    descriptor,
  });
  return descriptor;
}

async function seedLegacyReadyBlob(
  fixture: MigrationFixture,
  blobId: string,
  storageKey: string,
  uploadToken: string,
  data: Buffer,
  contentType: string,
): Promise<BlobDescriptor> {
  const path = join(fixture.root, ...storageKey.split("/"));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, data, { flag: "wx", mode: 0o600 });
  await writeFile(`${path}.meta`, JSON.stringify({ contentType }), { flag: "wx", mode: 0o600 });
  const descriptor: BlobDescriptor = {
    storageKey,
    sha256: createHash("sha256").update(data).digest("hex"),
    sizeBytes: data.length,
    contentType,
  };
  await insertBlobManifest(fixture, {
    blobId,
    storageKey,
    uploadToken,
    state: "ready",
    descriptor,
  });
  return descriptor;
}

async function seedTombstone(
  fixture: MigrationFixture,
  blobId: string,
  storageKey: string,
  uploadToken: string,
): Promise<void> {
  await fixture.source.delete(storageKey, { uploadToken });
  await insertBlobManifest(fixture, {
    blobId,
    storageKey,
    uploadToken,
    state: "delete_pending",
  });
}

async function seedStagingTemp(
  fixture: MigrationFixture,
  blobId: string,
  storageKey: string,
  uploadToken: string,
): Promise<string> {
  const targetPath = join(fixture.root, ...storageKey.split("/"));
  await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
  const nameSha256 = createHash("sha256").update(basename(targetPath)).digest("hex");
  const tempPath = join(dirname(targetPath), `.asblob-${nameSha256}-${uploadToken}.writing`);
  await writeFile(tempPath, Buffer.from("staging-temp-must-be-cleaned"), {
    flag: "wx",
    mode: 0o600,
  });
  await insertBlobManifest(fixture, {
    blobId,
    storageKey,
    uploadToken,
    state: "staging",
  });
  return tempPath;
}

async function activateExportPolicy(
  store: MysqlSessionStore,
  tenantId: string,
): Promise<void> {
  const atMs = Date.now() - 60_000;
  const policyVersion = `migration-export-${randomUUID()}`;
  await store.putRetentionPolicy({
    tenantId,
    policyVersion,
    policy: {
      sessionContentRetentionMs: null,
      userErasureGraceMs: null,
      operationalUsageRetentionMs: null,
      idempotencyReceiptRetentionMs: null,
      billingFactRetentionMs: null,
      lifecycleAuditRetentionMs: null,
      exportArtifactTtlMs: 10 * 60_000,
    },
    actorKeyId: "migration-export-test",
    atMs,
  });
  await store.activateRetentionPolicy({
    tenantId,
    policyVersion,
    expectedControlGeneration: 0,
    actorKeyId: "migration-export-test",
    atMs: atMs + 1,
  });
}

async function claimExportRequest(
  store: MysqlSessionStore,
  requestId: string,
): Promise<UserDataExportAuthorization> {
  const claims = await store.claimUserDataExports({
    limit: 100,
    leaseMs: 10 * 60_000,
    claimToken: `migration-export-${randomUUID()}`,
  });
  const claim = claims.find((candidate) => candidate.requestId === requestId);
  if (!claim) throw new Error(`expected data export claim for ${requestId}`);
  return userDataExportAuthorization(claim);
}

const rootQueries: Record<RootScope, string> = {
  inventory: `SELECT entry_sha256 AS digest FROM blob_storage_migration_inventory
    WHERE migration_id=? ORDER BY entry_ordinal`,
  "object-acks": `SELECT ack_sha256 AS digest FROM blob_storage_migration_object_acks
    WHERE migration_id=? ORDER BY storage_key`,
  "target-cleanup": `SELECT ack_sha256 AS digest FROM blob_storage_migration_target_cleanup_acks
    WHERE migration_id=? ORDER BY storage_key`,
  "source-cleanup": `SELECT ack_sha256 AS digest FROM blob_storage_migration_source_cleanup_acks
    WHERE migration_id=? ORDER BY storage_key`,
};

async function persistedRoot(
  conn: NativeInspection,
  migrationId: string,
  scope: RootScope,
): Promise<string> {
  const [rows] = await conn.query<Row[]>(rootQueries[scope], [migrationId]);
  let root = emptyBlobStorageMigrationRoot(scope);
  rows.forEach((row, index) => {
    root = appendBlobStorageMigrationRoot(scope, root, index + 1, String(row.digest));
  });
  return root;
}

const describeIntegration = integrationEnabled ? describe : describe.skip;

describeIntegration("Blob storage migration with real MySQL and MinIO", () => {
  beforeAll(async () => {
    // Registration precedes the first await; no suite-hook fixture/signal is requested.
    const adminUrl = new URL(base); adminUrl.pathname = "/mysql";
    admin = await nativeInspection(adminUrl.toString(), suiteCancellation.signal, suitePending, suiteInspections, suiteNativeFailures);
  }, 30_000);

  afterEach(async () => {
    // Vitest timeout does not join the original body. Cancel, then join those actual Promises.
    await preserveFirst(async () => { await closeAll([...acceptedFixtures].map(slot => () => slot.finish(false))); },
      async () => { await drain(acceptedCases); });
  });

  afterAll(async () => {
    await closeAll([
      ...[...acceptedFixtures].map(slot => () => slot.finish(false)),
      () => drain(acceptedCases),
      () => { suiteCancellation.abort(); },
      () => drain(suitePending),
      ...[...suiteInspections].map(value => () => value.end()),
      () => admin?.end(),
      () => { if (suiteNativeFailures.length) throw suiteNativeFailures[0]; },
    ]);
  });

  it("migrates an empty filesystem namespace through cutover and source cleanup", async context => migrationCase(context, async fixture => {
    await preserveFirst(async () => {
      const migrationId = `empty-${randomUUID()}`;
      const coordinator = await fixture.connect();
      const prepared = await coordinator.prepare(
        fixture.source,
        fixture.target,
        migrationInput(fixture, migrationId),
        MAX_BYTES,
      );
      expect(prepared).toMatchObject({
        phase: "inventory_sealed",
        inventoryEntryCount: 0,
        inventoryRootSha256: emptyBlobStorageMigrationRoot("inventory"),
      });
      await expect(coordinator.copy(fixture.source, fixture.target, MAX_BYTES))
        .resolves.toMatchObject({ phase: "copying" });
      await expect(coordinator.verify(fixture.source, fixture.target, MAX_BYTES))
        .resolves.toMatchObject({
          phase: "verified",
          objectAckCount: 0,
          objectAckRootSha256: emptyBlobStorageMigrationRoot("object-acks"),
        });
      await expect(coordinator.cutover(fixture.source, fixture.target, MAX_BYTES))
        .resolves.toMatchObject({ phase: "committed" });
      const cleaned = await coordinator.cleanupSource(
        fixture.source,
        fixture.target,
        MAX_BYTES,
      );
      expect(cleaned).toMatchObject({
        phase: "source_cleaned",
        sourceCleanupAckCount: 0,
        sourceCleanupAckRootSha256: emptyBlobStorageMigrationRoot("source-cleanup"),
      });

      await coordinator.close();
      const restarted = await fixture.connect(false);
      await expect(restarted.getControl()).resolves.toEqual(cleaned);
      const [receipts] = await fixture.conn.query<Row[]>(
        `SELECT receipt_kind,receipt_sha256 FROM blob_storage_migration_receipts
          WHERE migration_id=? ORDER BY receipt_kind`,
        [migrationId],
      );
      expect(receipts.map((row) => String(row.receipt_kind)).sort())
        .toEqual(["committed", "source_cleaned"]);
      expect(await listPrefix(fixture.prefix, fixture.cleanupClient)).toEqual([]);
    }, async failed => {
      if (failed) fixture.cancel();
      await closeAll([
        () => fixture.close(),
      ]);
    });
  }), 60_000);

  it("moves data, tombstones and a staging temp, then re-reads durable evidence after restart", async context => migrationCase(context, async fixture => {
    await preserveFirst(async () => {
      const migrationId = `full-${randomUUID()}`;
      const dataKey = "objects/data";
      const tombstoneKey = "objects/tombstone";
      const stagingKey = "objects/staging";
      const data = Buffer.from("filesystem-data-to-migrate");
      const dataTargetOwner = blobStorageMigrationTargetOwnerSha256(
        migrationId,
        fixture.target.namespaceSha256,
        dataKey,
      );
      const tombstoneTargetOwner = blobStorageMigrationTargetOwnerSha256(
        migrationId,
        fixture.target.namespaceSha256,
        tombstoneKey,
      );
      const descriptor = await seedReadyBlob(
        fixture,
        "data",
        dataKey,
        "upload-data",
        data,
      );
      await seedTombstone(fixture, "tombstone", tombstoneKey, "upload-tombstone");
      const stagingTemp = await seedStagingTemp(
        fixture,
        "staging",
        stagingKey,
        "upload-staging",
      );

      const coordinator = await fixture.connect();
      const input = migrationInput(fixture, migrationId);
      const prepared = await coordinator.prepare(
        fixture.source,
        fixture.target,
        input,
        MAX_BYTES,
      );
      expect(prepared).toMatchObject({ phase: "inventory_sealed", inventoryEntryCount: 3 });
      const preparedReplayInput = {
        ...input,
        expectedControlGeneration: prepared.controlGeneration,
      };
      await expect(coordinator.prepare(
        fixture.source,
        fixture.target,
        preparedReplayInput,
        MAX_BYTES,
      )).resolves.toEqual(prepared);
      await expect(coordinator.prepare(
        fixture.source,
        fixture.target,
        { ...preparedReplayInput, rollbackWindowMs: preparedReplayInput.rollbackWindowMs + 1 },
        MAX_BYTES,
      )).rejects.toBeInstanceOf(BlobStorageMigrationConflictError);
      await expect(coordinator.prepare(
        fixture.source,
        fixture.target,
        {
          ...preparedReplayInput,
          sourceCleanupDelayMs: preparedReplayInput.sourceCleanupDelayMs + 1,
        },
        MAX_BYTES,
      )).rejects.toBeInstanceOf(BlobStorageMigrationConflictError);
      await expect(coordinator.prepare(
        fixture.source,
        fixture.target,
        { ...preparedReplayInput, fleetDrainedEvidenceSha256: "b".repeat(64) },
        MAX_BYTES,
      )).rejects.toBeInstanceOf(BlobStorageMigrationConflictError);
      const mismatchedSource = new FsBlobStore(join(fixture.root, "wrong-source-namespace"));
      await expect(coordinator.sealInventory(mismatchedSource, MAX_BYTES))
        .rejects.toBeInstanceOf(BlobStorageMigrationConflictError);
      await expect(coordinator.getControl()).resolves.toEqual(prepared);
      const [inventory] = await fixture.conn.query<Row[]>(
        `SELECT storage_key,object_disposition FROM blob_storage_migration_inventory
          WHERE migration_id=? ORDER BY storage_key`,
        [migrationId],
      );
      expect(inventory.map((row) => [String(row.storage_key), String(row.object_disposition)]))
        .toEqual([
          [dataKey, "data"],
          [stagingKey, "absent"],
          [tombstoneKey, "tombstone"],
        ]);

      await coordinator.copy(fixture.source, fixture.target, MAX_BYTES);
      expect(await fixture.target.inspectExact(dataKey, { maxBytes: MAX_BYTES }))
        .toEqual({ kind: "data", descriptor, migrationOwnerSha256: dataTargetOwner });
      expect(await fixture.target.inspectExact(tombstoneKey, { maxBytes: MAX_BYTES }))
        .toEqual({ kind: "tombstone", migrationOwnerSha256: tombstoneTargetOwner });
      expect(await fixture.target.inspectExact(stagingKey, { maxBytes: MAX_BYTES }))
        .toEqual({ kind: "missing" });
      const verified = await coordinator.verify(fixture.source, fixture.target, MAX_BYTES);
      expect(verified).toMatchObject({ phase: "verified", objectAckCount: 3 });
      await expect(coordinator.copy(fixture.source, fixture.target, MAX_BYTES))
        .resolves.toEqual(verified);
      await expect(coordinator.verify(fixture.source, fixture.target, MAX_BYTES))
        .resolves.toEqual(verified);
      const committed = await coordinator.cutover(fixture.source, fixture.target, MAX_BYTES);
      expect(committed).toMatchObject({ phase: "committed" });
      const committedReplayInput = {
        ...input,
        expectedControlGeneration: committed.controlGeneration,
      };
      await expect(coordinator.prepare(
        fixture.source,
        fixture.target,
        committedReplayInput,
        MAX_BYTES,
      )).resolves.toEqual(committed);
      await expect(coordinator.copy(fixture.source, fixture.target, MAX_BYTES))
        .resolves.toEqual(committed);
      await expect(coordinator.verify(fixture.source, fixture.target, MAX_BYTES))
        .resolves.toEqual(committed);
      await expect(coordinator.cutover(fixture.source, fixture.target, MAX_BYTES))
        .resolves.toEqual(committed);

      // Reproduce the crash window where the cancellation fence was durable but unlinking the
      // final envelope was not. inspectExact intentionally reports the fence as a tombstone, so
      // cleanup must replay the token-bound delete instead of trusting that masked observation.
      const sourceDataPath = join(fixture.root, ...dataKey.split("/"));
      const sourceEnvelope = await readFile(sourceDataPath);
      await fixture.source.delete(dataKey, { uploadToken: "upload-data" });
      await expect(access(sourceDataPath)).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(sourceDataPath, sourceEnvelope, { flag: "wx", mode: 0o600 });
      await expect(access(sourceDataPath)).resolves.toBeUndefined();
      await expect(fixture.source.inspectExact(dataKey, { maxBytes: MAX_BYTES }))
        .resolves.toMatchObject({ kind: "tombstone" });

      const cleaned = await coordinator.cleanupSource(
        fixture.source,
        fixture.target,
        MAX_BYTES,
      );
      expect(cleaned).toMatchObject({ phase: "source_cleaned", sourceCleanupAckCount: 3 });
      await expect(access(sourceDataPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(stagingTemp)).rejects.toThrow();
      for (const key of [dataKey, tombstoneKey, stagingKey]) {
        await expect(fixture.source.inspectExact(key, { maxBytes: MAX_BYTES }))
          .resolves.toMatchObject({ kind: "tombstone" });
      }

      await coordinator.close();
      await fixture.target.close();
      const restartedCoordinator = await fixture.connect(false);
      const restartedTarget = fixture.newTarget();
      await expect(restartedCoordinator.getControl()).resolves.toEqual(cleaned);
      await expect(restartedTarget.get(dataKey, { maxBytes: MAX_BYTES })).resolves.toEqual({
        ...descriptor,
        data,
      });
      await expect(restartedTarget.inspectExact(dataKey, { maxBytes: MAX_BYTES }))
        .resolves.toEqual({
          kind: "data",
          descriptor,
          migrationOwnerSha256: dataTargetOwner,
        });
      await expect(restartedTarget.inspectExact(tombstoneKey, { maxBytes: MAX_BYTES }))
        .resolves.toEqual({
          kind: "tombstone",
          migrationOwnerSha256: tombstoneTargetOwner,
        });
      await expect(restartedTarget.inspectExact(stagingKey, { maxBytes: MAX_BYTES }))
        .resolves.toEqual({ kind: "missing" });

      const restartedConn = await fixture.openInspection();
      await preserveFirst(async () => {
        const [controlRows] = await restartedConn.query<Row[]>(
          `SELECT control_generation,phase,inventory_root_sha256,object_ack_root_sha256,
                  source_cleanup_ack_root_sha256,terminal_receipt_sha256
             FROM blob_storage_migration_control WHERE singleton_id=1`,
        );
        expect(controlRows[0]).toMatchObject({
          control_generation: 1,
          phase: "source_cleaned",
          inventory_root_sha256: cleaned.inventoryRootSha256,
          object_ack_root_sha256: cleaned.objectAckRootSha256,
          source_cleanup_ack_root_sha256: cleaned.sourceCleanupAckRootSha256,
          terminal_receipt_sha256: cleaned.terminalReceiptSha256,
        });
        expect(await persistedRoot(restartedConn, migrationId, "inventory"))
          .toBe(cleaned.inventoryRootSha256);
        expect(await persistedRoot(restartedConn, migrationId, "object-acks"))
          .toBe(cleaned.objectAckRootSha256);
        expect(await persistedRoot(restartedConn, migrationId, "source-cleanup"))
          .toBe(cleaned.sourceCleanupAckRootSha256);

        const [pointers] = await restartedConn.query<Row[]>(
          "SELECT blob_id,storage_backend FROM blob_objects ORDER BY blob_id",
        );
        expect(pointers.map((row) => [String(row.blob_id), String(row.storage_backend)]))
          .toEqual([
            ["data", fixture.target.backend],
            ["staging", fixture.target.backend],
            ["tombstone", fixture.target.backend],
          ]);
        const [blobControl] = await restartedConn.query<Row[]>(
          `SELECT control_generation,storage_backend,namespace_sha256,evidence_sha256
             FROM blob_storage_control WHERE singleton_id=1`,
        );
        expect(blobControl[0]).toMatchObject({
          control_generation: 1,
          storage_backend: fixture.target.backend,
          namespace_sha256: fixture.target.namespaceSha256,
          evidence_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        });
        const [receipts] = await restartedConn.query<Row[]>(
          `SELECT receipt_kind,inventory_root_sha256,object_ack_root_sha256,
                  source_cleanup_ack_root_sha256,receipt_sha256
             FROM blob_storage_migration_receipts WHERE migration_id=? ORDER BY receipt_kind`,
          [migrationId],
        );
        expect(receipts).toHaveLength(2);
        expect(receipts.find((row) => row.receipt_kind === "committed")).toMatchObject({
          inventory_root_sha256: cleaned.inventoryRootSha256,
          object_ack_root_sha256: cleaned.objectAckRootSha256,
        });
        expect(receipts.find((row) => row.receipt_kind === "source_cleaned")).toMatchObject({
          inventory_root_sha256: cleaned.inventoryRootSha256,
          object_ack_root_sha256: cleaned.objectAckRootSha256,
          source_cleanup_ack_root_sha256: cleaned.sourceCleanupAckRootSha256,
          receipt_sha256: cleaned.terminalReceiptSha256,
        });
      }, () => restartedConn.end());
    }, async failed => {
      if (failed) fixture.cancel();
      await closeAll([
        () => fixture.close(),
      ]);
    });
  }), 60_000);

  it("moves an audited legacy raw filesystem object and removes its sidecar after cutover", async context => migrationCase(context, async fixture => {
    await preserveFirst(async () => {
      const migrationId = `legacy-${randomUUID()}`;
      const key = "legacy/raw-object";
      const uploadToken = "upload-legacy-raw";
      const data = Buffer.from("pre-envelope filesystem bytes");
      const contentType = "application/x-agent-service-legacy";
      const descriptor = await seedLegacyReadyBlob(
        fixture,
        "legacy-raw",
        key,
        uploadToken,
        data,
        contentType,
      );
      const sourcePath = join(fixture.root, ...key.split("/"));
      await expect(fixture.source.getExact(key, { maxBytes: MAX_BYTES })).resolves.toEqual({
        ...descriptor,
        data,
      });
      await expect(fixture.source.get(key, { maxBytes: MAX_BYTES }))
        .rejects.toThrow("invalid blob envelope");

      const coordinator = await fixture.connect();
      await expect(coordinator.prepare(
        fixture.source,
        fixture.target,
        migrationInput(fixture, migrationId),
        MAX_BYTES,
      )).resolves.toMatchObject({ phase: "inventory_sealed", inventoryEntryCount: 1 });
      await expect(coordinator.copy(fixture.source, fixture.target, MAX_BYTES))
        .resolves.toMatchObject({ phase: "copying" });
      await expect(fixture.target.get(key, { maxBytes: MAX_BYTES })).resolves.toEqual({
        ...descriptor,
        data,
      });
      await expect(coordinator.verify(fixture.source, fixture.target, MAX_BYTES))
        .resolves.toMatchObject({ phase: "verified", objectAckCount: 1 });
      await expect(coordinator.cutover(fixture.source, fixture.target, MAX_BYTES))
        .resolves.toMatchObject({ phase: "committed" });
      const cleaned = await coordinator.cleanupSource(
        fixture.source,
        fixture.target,
        MAX_BYTES,
      );
      expect(cleaned).toMatchObject({ phase: "source_cleaned", sourceCleanupAckCount: 1 });
      await expect(access(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(`${sourcePath}.meta`)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fixture.target.get(key, { maxBytes: MAX_BYTES })).resolves.toEqual({
        ...descriptor,
        data,
      });
    }, async failed => {
      if (failed) fixture.cancel();
      await closeAll([
        () => fixture.close(),
      ]);
    });
  }), 60_000);

  it("resumes an ordinary staging upload after migration without stripping target provenance", async context => migrationCase(context, async fixture => {
    let runtime: MysqlSessionStore | undefined;
    let authority: Awaited<ReturnType<typeof acquireFixtureSessionAuthority>> | undefined;
    await preserveFirst(async () => {
      const migrationId = `staging-resume-${randomUUID()}`;
      const session = mkSession(
        `tenant_staging_resume_${randomUUID()}`,
        `user_staging_resume_${randomUUID()}`,
      );
      const owner = { tenantId: session.tenantId, userId: session.userId };
      const blobId = newId("blob");
      const storageKey = blobStorageKey(blobId);
      const uploadToken = `staging-resume-${randomUUID()}`;
      const bytes = Buffer.from("published-before-durable-upload-ack");
      const createdAtMs = Date.now();

      runtime = await fixture.openStore(4);
      await runtime.createSession(session);
      authority = await acquireFixtureSessionAuthority(runtime, session, 0);
      await runtime.stageBlob(authority.admit({
        owner,
        sessionId: session.id,
        fence: 1,
        blobId,
        purpose: "tool_output",
        storageBackend: fixture.source.backend,
        storageFormat: BLOB_STORAGE_FORMAT,
        storageKey,
        uploadToken,
        createdAtMs,
        stagingExpiresAtMs: createdAtMs + 10 * 60_000,
      }));
      const descriptor = await fixture.source.putIfAbsent(storageKey, bytes, {
        uploadToken,
        maxBytes: MAX_BYTES,
        contentType: "application/octet-stream",
      });
      const stagedManifest = await runtime.getBlobManifest(blobId);
      expect(stagedManifest).toMatchObject({
        state: "staging",
        storageBackend: fixture.source.backend,
      });
      expect(stagedManifest).not.toHaveProperty("uploadedAtMs");

      await authority.release(); authority = undefined;

      // Model the fleet drain after the physical create committed but before markBlobUploaded.
      await runtime.close();
      runtime = undefined;

      const coordinator = await fixture.connect();
      await coordinator.prepare(
        fixture.source,
        fixture.target,
        migrationInput(fixture, migrationId),
        MAX_BYTES,
      );
      await coordinator.copy(fixture.source, fixture.target, MAX_BYTES);
      await coordinator.verify(fixture.source, fixture.target, MAX_BYTES);
      await coordinator.cutover(fixture.source, fixture.target, MAX_BYTES);
      await coordinator.cleanupSource(fixture.source, fixture.target, MAX_BYTES);

      const migrationOwnerSha256 = blobStorageMigrationTargetOwnerSha256(
        migrationId,
        fixture.target.namespaceSha256,
        storageKey,
      );
      expect(await fixture.target.inspectExact(storageKey, { maxBytes: MAX_BYTES })).toEqual({
        kind: "data",
        descriptor,
        migrationOwnerSha256,
      });

      // This is the ordinary runtime replay: it does not know or supply the mover-only owner
      // marker. Exact bytes remain idempotent, while the durable provenance stays on the object.
      await expect(fixture.target.putIfAbsent(storageKey, bytes, {
        uploadToken,
        maxBytes: MAX_BYTES,
        contentType: descriptor.contentType,
      })).resolves.toEqual(descriptor);
      expect(await fixture.target.inspectExact(storageKey, { maxBytes: MAX_BYTES })).toEqual({
        kind: "data",
        descriptor,
        migrationOwnerSha256,
      });

      runtime = await fixture.openStore(4);
      authority = await acquireFixtureSessionAuthority(runtime, session, 1);
      await runtime.markBlobUploaded(authority.admit({
        owner,
        sessionId: session.id,
        fence: 2,
        blobId,
        uploadToken,
        sha256: descriptor.sha256,
        sizeBytes: descriptor.sizeBytes,
        contentType: descriptor.contentType,
        uploadedAtMs: Date.now(),
      }));
      expect(await runtime.getBlobManifest(blobId)).toMatchObject({
        state: "staging",
        storageBackend: fixture.target.backend,
        sha256: descriptor.sha256,
        sizeBytes: descriptor.sizeBytes,
        contentType: descriptor.contentType,
        uploadedAtMs: expect.any(Number),
      });
    }, async failed => {
      if (failed) fixture.cancel();
      await closeAll([
        () => authority?.release(),
        () => runtime?.close(),
        () => fixture.close(),
      ]);
    });
  }), 60_000);

  it("resumes an export-part staging upload after migration without stripping target provenance", async context => migrationCase(context, async fixture => {
    let runtime: MysqlSessionStore | undefined;
    await preserveFirst(async () => {
      const migrationId = `export-staging-resume-${randomUUID()}`;
      const session = mkSession(
        `tenant_export_staging_resume_${randomUUID()}`,
        `user_export_staging_resume_${randomUUID()}`,
      );
      const requestId = newUserDataExportRequestId();
      const artifactId = newUserDataExportArtifactId();
      const uploadToken = `export-staging-${randomUUID()}`;
      const bytes = Buffer.from("export-part-published-before-durable-upload-ack");

      runtime = await fixture.openStore(4);
      await activateExportPolicy(runtime, session.tenantId);
      await runtime.createSession(session);
      await runtime.requestUserDataExport({
        requestId,
        tenantId: session.tenantId,
        userId: session.userId,
        requestedByKeyId: "migration-export-test",
        idempotencyKeySha256: userDataExportIdempotencyKeySha256(
          `migration-export-${randomUUID()}`,
        ),
        requestHash: userDataExportRequestHash(session.tenantId, session.userId),
      });
      const authorization = await claimExportRequest(runtime, requestId);
      await runtime.captureAndSealUserDataExportSnapshot(authorization);
      await runtime.startUserDataExportArtifact(authorization, {
        artifactId,
        storageBackend: fixture.source.backend,
        storageFormat: BLOB_STORAGE_FORMAT,
        stagingTtlMs: 10 * 60_000,
      });
      const storageKey = userDataExportStorageKey(
        { tenantId: session.tenantId, userId: session.userId },
        requestId,
        artifactId,
        0,
      );
      await runtime.stageUserDataExportPart(authorization, {
        artifactId,
        partNumber: 0,
        storageBackend: fixture.source.backend,
        storageFormat: BLOB_STORAGE_FORMAT,
        storageKey,
        uploadToken,
      });
      const descriptor = await fixture.source.putIfAbsent(storageKey, bytes, {
        uploadToken,
        maxBytes: MAX_BYTES,
        contentType: USER_DATA_EXPORT_CONTENT_TYPE,
      });
      expect(await runtime.getUserDataExportArtifactBuild(authorization)).toMatchObject({
        artifact: { state: "staging", storageBackend: fixture.source.backend },
        parts: [{ state: "staging", storageBackend: fixture.source.backend }],
      });

      // Model fleet drain after the final envelope is published but before the part ACK commits.
      await runtime.close();
      runtime = undefined;

      const coordinator = await fixture.connect();
      await expect(coordinator.prepare(
        fixture.source,
        fixture.target,
        migrationInput(fixture, migrationId),
        MAX_BYTES,
      )).resolves.toMatchObject({ phase: "inventory_sealed", inventoryEntryCount: 2 });
      await coordinator.copy(fixture.source, fixture.target, MAX_BYTES);
      await coordinator.verify(fixture.source, fixture.target, MAX_BYTES);
      await coordinator.cutover(fixture.source, fixture.target, MAX_BYTES);
      await coordinator.cleanupSource(fixture.source, fixture.target, MAX_BYTES);

      const migrationOwnerSha256 = blobStorageMigrationTargetOwnerSha256(
        migrationId,
        fixture.target.namespaceSha256,
        storageKey,
      );
      expect(await fixture.target.inspectExact(storageKey, { maxBytes: MAX_BYTES })).toEqual({
        kind: "data",
        descriptor,
        migrationOwnerSha256,
      });

      await expect(fixture.target.putIfAbsent(storageKey, bytes, {
        uploadToken,
        maxBytes: MAX_BYTES,
        contentType: USER_DATA_EXPORT_CONTENT_TYPE,
      })).resolves.toEqual(descriptor);
      expect(await fixture.target.inspectExact(storageKey, { maxBytes: MAX_BYTES })).toEqual({
        kind: "data",
        descriptor,
        migrationOwnerSha256,
      });

      runtime = await fixture.openStore(4);
      await runtime.markUserDataExportPartUploaded(authorization, {
        artifactId,
        partNumber: 0,
        descriptor,
      });
      expect(await runtime.getUserDataExportArtifactBuild(authorization)).toMatchObject({
        artifact: { state: "staging", storageBackend: fixture.target.backend },
        parts: [{
          state: "uploaded",
          storageBackend: fixture.target.backend,
          sha256: descriptor.sha256,
          sizeBytes: descriptor.sizeBytes,
          contentType: descriptor.contentType,
          uploadedAtMs: expect.any(Number),
        }],
      });
    }, async failed => {
      if (failed) fixture.cancel();
      await closeAll([
        () => runtime?.close(),
        () => fixture.close(),
      ]);
    });
  }), 60_000);

  it("migrates a pending export delete intent with the owning part content type", async context => migrationCase(context, async fixture => {
    let runtime: MysqlSessionStore | undefined;
    await preserveFirst(async () => {
      const migrationId = `export-delete-${randomUUID()}`;
      const session = mkSession(
        `tenant_export_delete_${randomUUID()}`,
        `user_export_delete_${randomUUID()}`,
      );
      const requestId = newUserDataExportRequestId();
      const artifactId = newUserDataExportArtifactId();
      const uploadToken = `export-delete-${randomUUID()}`;
      const bytes = Buffer.from("pending-export-delete-with-content-type");

      runtime = await fixture.openStore(4);
      await activateExportPolicy(runtime, session.tenantId);
      await runtime.createSession(session);
      await runtime.requestUserDataExport({
        requestId,
        tenantId: session.tenantId,
        userId: session.userId,
        requestedByKeyId: "migration-export-test",
        idempotencyKeySha256: userDataExportIdempotencyKeySha256(
          `migration-export-delete-${randomUUID()}`,
        ),
        requestHash: userDataExportRequestHash(session.tenantId, session.userId),
      });
      const authorization = await claimExportRequest(runtime, requestId);
      await runtime.captureAndSealUserDataExportSnapshot(authorization);
      await runtime.startUserDataExportArtifact(authorization, {
        artifactId,
        storageBackend: fixture.source.backend,
        storageFormat: BLOB_STORAGE_FORMAT,
        stagingTtlMs: 10 * 60_000,
      });
      const storageKey = userDataExportStorageKey(
        { tenantId: session.tenantId, userId: session.userId },
        requestId,
        artifactId,
        0,
      );
      await runtime.stageUserDataExportPart(authorization, {
        artifactId,
        partNumber: 0,
        storageBackend: fixture.source.backend,
        storageFormat: BLOB_STORAGE_FORMAT,
        storageKey,
        uploadToken,
      });
      const descriptor = await fixture.source.putIfAbsent(storageKey, bytes, {
        uploadToken,
        maxBytes: MAX_BYTES,
        contentType: USER_DATA_EXPORT_CONTENT_TYPE,
      });
      await runtime.markUserDataExportPartUploaded(authorization, {
        artifactId,
        partNumber: 0,
        descriptor,
      });
      await expect(runtime.retryUserDataExport(authorization, {
        delayMs: 0,
        errorCode: "artifact_invalid",
        maxAttempts: 1,
      })).resolves.toBe(true);
      const [pendingRows] = await fixture.conn.query<Row[]>(
        `SELECT a.state AS artifact_state,a.storage_backend AS artifact_backend,
                p.state AS part_state,p.storage_backend AS part_backend,p.content_type,
                o.completed_at_ms
           FROM user_export_artifacts a
           JOIN user_export_artifact_parts p ON BINARY p.artifact_id=BINARY a.artifact_id
           JOIN user_export_artifact_delete_outbox o
             ON BINARY o.artifact_id=BINARY p.artifact_id AND o.part_number=p.part_number
          WHERE BINARY a.artifact_id=BINARY ? AND p.part_number=0`,
        [artifactId],
      );
      expect(pendingRows).toHaveLength(1);
      expect(pendingRows[0]).toMatchObject({
        artifact_state: "delete_pending",
        artifact_backend: fixture.source.backend,
        part_state: "delete_pending",
        part_backend: fixture.source.backend,
        content_type: USER_DATA_EXPORT_CONTENT_TYPE,
        completed_at_ms: null,
      });

      await runtime.close();
      runtime = undefined;

      const coordinator = await fixture.connect();
      await expect(coordinator.prepare(
        fixture.source,
        fixture.target,
        migrationInput(fixture, migrationId),
        MAX_BYTES,
      )).resolves.toMatchObject({ phase: "inventory_sealed", inventoryEntryCount: 3 });
      const [inventoryRows] = await fixture.conn.query<Row[]>(
        `SELECT record_kind,object_disposition,expected_sha256,expected_size_bytes,
                expected_content_type
           FROM blob_storage_migration_inventory
          WHERE migration_id=? AND record_kind IN ('export_part','export_delete_intent')
          ORDER BY record_kind`,
        [migrationId],
      );
      expect(inventoryRows.map((row) => ({
        recordKind: String(row.record_kind),
        disposition: String(row.object_disposition),
        sha256: String(row.expected_sha256),
        sizeBytes: Number(row.expected_size_bytes),
        contentType: String(row.expected_content_type),
      }))).toEqual([
        {
          recordKind: "export_delete_intent",
          disposition: "tombstone",
          sha256: descriptor.sha256,
          sizeBytes: descriptor.sizeBytes,
          contentType: USER_DATA_EXPORT_CONTENT_TYPE,
        },
        {
          recordKind: "export_part",
          disposition: "tombstone",
          sha256: descriptor.sha256,
          sizeBytes: descriptor.sizeBytes,
          contentType: USER_DATA_EXPORT_CONTENT_TYPE,
        },
      ]);

      await coordinator.copy(fixture.source, fixture.target, MAX_BYTES);
      await coordinator.verify(fixture.source, fixture.target, MAX_BYTES);
      await coordinator.cutover(fixture.source, fixture.target, MAX_BYTES);
      await coordinator.cleanupSource(fixture.source, fixture.target, MAX_BYTES);

      expect(await fixture.target.inspectExact(storageKey, { maxBytes: MAX_BYTES })).toEqual({
        kind: "tombstone",
        migrationOwnerSha256: blobStorageMigrationTargetOwnerSha256(
          migrationId,
          fixture.target.namespaceSha256,
          storageKey,
        ),
      });
      const [backendRows] = await fixture.conn.query<Row[]>(
        `SELECT p.storage_backend AS part_backend,o.storage_backend AS outbox_backend
           FROM user_export_artifact_parts p
           JOIN user_export_artifact_delete_outbox o
             ON BINARY o.artifact_id=BINARY p.artifact_id AND o.part_number=p.part_number
          WHERE BINARY p.artifact_id=BINARY ? AND p.part_number=0`,
        [artifactId],
      );
      expect(backendRows).toHaveLength(1);
      expect(String(backendRows[0]!.part_backend)).toBe(fixture.target.backend);
      expect(String(backendRows[0]!.outbox_backend)).toBe(fixture.target.backend);
    }, async failed => {
      if (failed) fixture.cancel();
      await closeAll([
        () => runtime?.close(),
        () => fixture.close(),
      ]);
    });
  }), 60_000);

  it("keeps the source and receipt uncommitted when a cut-over target disappears", async context => migrationCase(context, async fixture => {
    await preserveFirst(async () => {
      const migrationId = `target-loss-${randomUUID()}`;
      const key = "objects/target-loss";
      const uploadToken = "upload-target-loss";
      const data = Buffer.from("source-must-survive-target-loss");
      const descriptor = await seedReadyBlob(
        fixture,
        "target-loss",
        key,
        uploadToken,
        data,
      );
      const targetOwner = blobStorageMigrationTargetOwnerSha256(
        migrationId,
        fixture.target.namespaceSha256,
        key,
      );
      const coordinator = await fixture.connect();
      const prepared = await coordinator.prepare(
        fixture.source,
        fixture.target,
        migrationInput(fixture, migrationId),
        MAX_BYTES,
      );
      const mismatchedTarget = fixture.newTarget({
        namespaceId: `mismatched-${randomUUID()}`,
      });
      await expect(coordinator.copy(fixture.source, mismatchedTarget, MAX_BYTES))
        .rejects.toBeInstanceOf(BlobStorageMigrationConflictError);
      await expect(coordinator.getControl()).resolves.toEqual(prepared);
      await coordinator.copy(fixture.source, fixture.target, MAX_BYTES);
      const verified = await coordinator.verify(fixture.source, fixture.target, MAX_BYTES);
      await expect(coordinator.abort(mismatchedTarget, MAX_BYTES))
        .rejects.toBeInstanceOf(BlobStorageMigrationConflictError);
      await expect(coordinator.getControl()).resolves.toEqual(verified);
      const committed = await coordinator.cutover(
        fixture.source,
        fixture.target,
        MAX_BYTES,
      );
      expect(committed.phase).toBe("committed");

      await deleteOutOfContractTargetObject(fixture.prefix, key, fixture.cleanupClient);
      await expect(fixture.target.inspectExact(key, { maxBytes: MAX_BYTES }))
        .resolves.toEqual({ kind: "missing" });

      await expect(coordinator.cleanupSource(
        fixture.source,
        fixture.target,
        MAX_BYTES,
      )).rejects.toBeInstanceOf(BlobStorageMigrationConflictError);

      const foreignOwner = targetOwner === "d".repeat(64) ? "e".repeat(64) : "d".repeat(64);
      await fixture.target.putIfAbsent(key, data, {
        uploadToken,
        maxBytes: MAX_BYTES,
        contentType: descriptor.contentType,
        migrationOwnerSha256: foreignOwner,
      });
      await expect(coordinator.cleanupSource(
        fixture.source,
        fixture.target,
        MAX_BYTES,
      )).rejects.toBeInstanceOf(BlobStorageMigrationConflictError);
      await deleteOutOfContractTargetObject(fixture.prefix, key, fixture.cleanupClient);

      const tamperedData = Buffer.from("tampered-target-content");
      const tamperedDescriptor = await fixture.target.putIfAbsent(key, tamperedData, {
        uploadToken,
        maxBytes: MAX_BYTES,
        contentType: descriptor.contentType,
        migrationOwnerSha256: targetOwner,
      });
      expect(tamperedDescriptor.sha256).not.toBe(descriptor.sha256);
      await expect(coordinator.cleanupSource(
        fixture.source,
        fixture.target,
        MAX_BYTES,
      )).rejects.toBeInstanceOf(BlobStorageMigrationConflictError);
      await deleteOutOfContractTargetObject(fixture.prefix, key, fixture.cleanupClient);

      await expect(fixture.source.get(key, { maxBytes: MAX_BYTES })).resolves.toEqual({
        ...descriptor,
        data,
      });
      const sourcePath = join(fixture.root, ...key.split("/"));
      await expect(access(sourcePath)).resolves.toBeUndefined();
      await expect(coordinator.getControl()).resolves.toEqual(committed);
      const [failedEvidence] = await fixture.conn.query<Row[]>(
        `SELECT
           (SELECT COUNT(*) FROM blob_storage_migration_source_cleanup_acks
             WHERE migration_id=?) AS cleanup_ack_count,
           (SELECT COUNT(*) FROM blob_storage_migration_receipts
             WHERE migration_id=? AND receipt_kind='source_cleaned') AS cleanup_receipt_count`,
        [migrationId, migrationId],
      );
      expect(Number(failedEvidence[0]?.cleanup_ack_count)).toBe(0);
      expect(Number(failedEvidence[0]?.cleanup_receipt_count)).toBe(0);

      await expect(fixture.target.putIfAbsent(key, data, {
        uploadToken,
        maxBytes: MAX_BYTES,
        contentType: descriptor.contentType,
        migrationOwnerSha256: targetOwner,
      })).resolves.toEqual(descriptor);
      const cleaned = await coordinator.cleanupSource(
        fixture.source,
        fixture.target,
        MAX_BYTES,
      );
      expect(cleaned).toMatchObject({
        phase: "source_cleaned",
        sourceCleanupAckCount: 1,
      });
      await expect(access(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
      const [restoredEvidence] = await fixture.conn.query<Row[]>(
        `SELECT COUNT(*) AS cleanup_receipt_count
           FROM blob_storage_migration_receipts
          WHERE migration_id=? AND receipt_kind='source_cleaned'`,
        [migrationId],
      );
      expect(Number(restoredEvidence[0]?.cleanup_receipt_count)).toBe(1);
    }, async failed => {
      if (failed) fixture.cancel();
      await closeAll([
        () => fixture.close(),
      ]);
    });
  }), 60_000);

  it("fences only attempt-owned target objects on abort and preserves unmarked or foreign objects", async context => migrationCase(context, async fixture => {
    await preserveFirst(async () => {
      const migrationId = `abort-${randomUUID()}`;
      const ownedKey = "objects/owned";
      const unmarkedKey = "objects/unmarked";
      const foreignKey = "objects/foreign";
      const ownedData = Buffer.from("owned-by-this-attempt");
      const unmarkedData = Buffer.from("preexisting-without-marker");
      const foreignData = Buffer.from("preexisting-with-foreign-marker");
      await seedReadyBlob(fixture, "owned", ownedKey, "upload-owned", ownedData);
      await seedReadyBlob(fixture, "unmarked", unmarkedKey, "upload-unmarked", unmarkedData);
      await seedReadyBlob(fixture, "foreign", foreignKey, "upload-foreign", foreignData);

      const coordinator = await fixture.connect();
      const mismatchedTarget = fixture.newTarget({
        namespaceId: `abort-mismatch-${randomUUID()}`,
      });
      await coordinator.prepare(
        fixture.source,
        fixture.target,
        migrationInput(fixture, migrationId),
        MAX_BYTES,
      );
      await coordinator.copy(fixture.source, fixture.target, MAX_BYTES);
      await coordinator.verify(fixture.source, fixture.target, MAX_BYTES);

      // Simulate an out-of-contract external writer after verification. Abort must never erase a
      // same-content object once the exact migration provenance marker is absent or foreign.
      const unmarkedCopied = await fixture.target.inspectExact(unmarkedKey, {
        maxBytes: MAX_BYTES,
      });
      if (unmarkedCopied.kind !== "data") throw new Error("unmarked copy was not materialized");
      await deleteOutOfContractTargetObject(fixture.prefix, unmarkedKey, fixture.cleanupClient);
      await fixture.target.putIfAbsent(unmarkedKey, unmarkedData, {
        uploadToken: "replacement-unmarked",
        maxBytes: MAX_BYTES,
        contentType: "application/octet-stream",
      });

      const foreignCopied = await fixture.target.inspectExact(foreignKey, {
        maxBytes: MAX_BYTES,
      });
      if (foreignCopied.kind !== "data") throw new Error("foreign copy was not materialized");
      const attemptOwner = blobStorageMigrationTargetOwnerSha256(
        migrationId,
        fixture.target.namespaceSha256,
        foreignKey,
      );
      const foreignOwner = attemptOwner === "d".repeat(64) ? "e".repeat(64) : "d".repeat(64);
      await deleteOutOfContractTargetObject(fixture.prefix, foreignKey, fixture.cleanupClient);
      await fixture.target.putIfAbsent(foreignKey, foreignData, {
        uploadToken: "replacement-foreign",
        maxBytes: MAX_BYTES,
        contentType: "application/octet-stream",
        migrationOwnerSha256: foreignOwner,
      });
      const ownedAttemptOwner = blobStorageMigrationTargetOwnerSha256(
        migrationId,
        fixture.target.namespaceSha256,
        ownedKey,
      );
      const aborted = await coordinator.abort(fixture.target, MAX_BYTES);
      expect(aborted).toMatchObject({
        phase: "aborted",
        objectAckCount: 3,
        targetCleanupAckCount: 3,
        targetCleanupAckRootSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });

      expect(await fixture.target.inspectExact(ownedKey, { maxBytes: MAX_BYTES }))
        .toEqual({ kind: "tombstone", migrationOwnerSha256: ownedAttemptOwner });
      const preservedUnmarked = await fixture.target.inspectExact(unmarkedKey, {
        maxBytes: MAX_BYTES,
      });
      expect(preservedUnmarked).toMatchObject({ kind: "data" });
      expect(preservedUnmarked).not.toHaveProperty("migrationOwnerSha256");
      expect(await fixture.target.inspectExact(foreignKey, { maxBytes: MAX_BYTES }))
        .toMatchObject({ kind: "data", migrationOwnerSha256: foreignOwner });
      const [cleanupAcks] = await fixture.conn.query<Row[]>(
        `SELECT storage_key,cleanup_result,target_observed_kind
           FROM blob_storage_migration_target_cleanup_acks
          WHERE migration_id=? ORDER BY storage_key`,
        [migrationId],
      );
      expect(cleanupAcks.map((row) => [
        String(row.storage_key),
        String(row.cleanup_result),
        String(row.target_observed_kind),
      ])).toEqual([
        [foreignKey, "preserved_conflict", "data"],
        [ownedKey, "fenced_tombstone", "tombstone"],
        [unmarkedKey, "preserved_conflict", "data"],
      ]);
      expect(await persistedRoot(fixture.conn, migrationId, "target-cleanup"))
        .toBe(aborted.targetCleanupAckRootSha256);
      const [blobControl] = await fixture.conn.query<Row[]>(
        "SELECT control_generation FROM blob_storage_control WHERE singleton_id=1",
      );
      expect(Number(blobControl[0]?.control_generation)).toBe(0);
      const [pointers] = await fixture.conn.query<Row[]>(
        "SELECT DISTINCT storage_backend FROM blob_objects",
      );
      expect(pointers.map((row) => String(row.storage_backend)))
        .toEqual([BLOB_STORAGE_MIGRATION_SOURCE_BACKEND]);

      await expect(coordinator.abort(mismatchedTarget, MAX_BYTES))
        .rejects.toBeInstanceOf(BlobStorageMigrationConflictError);
      await expect(coordinator.getControl()).resolves.toEqual(aborted);

      await coordinator.close();
      await fixture.target.close();
      const restartedCoordinator = await fixture.connect(false);
      const restartedTarget = fixture.newTarget();
      await expect(restartedCoordinator.getControl()).resolves.toEqual(aborted);
      await expect(restartedTarget.inspectExact(ownedKey, { maxBytes: MAX_BYTES }))
        .resolves.toEqual({ kind: "tombstone", migrationOwnerSha256: ownedAttemptOwner });
      const restartedUnmarked = await restartedTarget.inspectExact(unmarkedKey, {
        maxBytes: MAX_BYTES,
      });
      expect(restartedUnmarked).toMatchObject({ kind: "data" });
      expect(restartedUnmarked).not.toHaveProperty("migrationOwnerSha256");
      await expect(restartedTarget.inspectExact(foreignKey, { maxBytes: MAX_BYTES }))
        .resolves.toMatchObject({ kind: "data", migrationOwnerSha256: foreignOwner });
    }, async failed => {
      if (failed) fixture.cancel();
      await closeAll([
        () => fixture.close(),
      ]);
    });
  }), 60_000);

  it("rejects a second exclusive coordinator while allowing an independent status reader", async context => migrationCase(context, async fixture => {
    await preserveFirst(async () => {
      const operator = await fixture.connect();
      const secondAttempt = await fixture.connectAttempt().then(
        async (unexpected) => {
          // Close an unexpectedly admitted operator before failing the assertion so even a
          // lock-regression cannot leak a pool or hold the generated database open.
          await unexpected.close();
          return undefined;
        },
        (error: unknown) => error,
      );
      expect(secondAttempt).toBeInstanceOf(BlobStorageMigrationConflictError);

      const status = await fixture.connect(false);
      const [operatorControl, statusControl] = await Promise.all([
        operator.getControl(),
        status.getControl(),
      ]);
      expect(statusControl).toEqual(operatorControl);
      expect(statusControl.phase).toBe("inactive");
      await expect(status.freeze(migrationInput(fixture, `reader-${randomUUID()}`)))
        .rejects.toBeInstanceOf(BlobStorageMigrationConflictError);
      await expect(status.getControl()).resolves.toEqual(operatorControl);
      await status.close();
      await operator.close();

      const nextOperator = await fixture.connect();
      await expect(nextOperator.getControl()).resolves.toEqual(operatorControl);
    }, async failed => {
      if (failed) fixture.cancel();
      await closeAll([
        () => fixture.close(),
      ]);
    });
  }), 60_000);

  it("fences an in-flight target write when the named-lock connection is lost", async context => migrationCase(context, async fixture => {
    let killedOperator: MysqlBlobStorageMigrationCoordinator | undefined;
    let copyPromise: Promise<unknown> | undefined;
    let abortPromise: Promise<unknown> | undefined;
    let releasePut: () => void = () => undefined;
    fixture.onCancel(() => releasePut());
    await preserveFirst(async () => {
      const migrationId = `lock-loss-${randomUUID()}`;
      const storageKey = "objects/lock-loss";
      await seedReadyBlob(
        fixture,
        "lock-loss",
        storageKey,
        "upload-lock-loss",
        Buffer.from("lock-loss-payload"),
      );
      killedOperator = await fixture.connect();
      await killedOperator.prepare(
        fixture.source,
        fixture.target,
        migrationInput(fixture, migrationId),
        MAX_BYTES,
      );

      let signalPutEntered!: () => void;
      const putEntered = new Promise<void>((resolve) => {
        signalPutEntered = resolve;
      });
      const putRelease = new Promise<void>((resolve) => {
        releasePut = resolve;
      });
      let intercept = true;
      const blockedTarget = new Proxy(fixture.target, {
        get(target, property) {
          if (property === "putIfAbsent") {
            return async (...args: Parameters<S3BlobStore["putIfAbsent"]>) => {
              if (intercept) {
                intercept = false;
                signalPutEntered();
                await putRelease;
              }
              return target.putIfAbsent(...args);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      copyPromise = fixture.ownOperation(killedOperator.copy(fixture.source, blockedTarget, MAX_BYTES));
      await fixture.waitForEntry(putEntered, copyPromise);

      const lockName = migrationOperatorLockName(fixture.database);
      const [lockRows] = await fixture.conn.query<Row[]>(
        "SELECT IS_USED_LOCK(?) AS owner_id",
        [lockName],
      );
      const ownerId = Number(lockRows[0]?.owner_id);
      if (!Number.isSafeInteger(ownerId) || ownerId <= 0) {
        throw new Error("blob migration operator lock owner is unavailable");
      }
      await fixture.conn.query(`KILL CONNECTION ${ownerId}`);

      const replacement = await fixture.connect();
      abortPromise = fixture.ownOperation(replacement.abort(fixture.target, MAX_BYTES));
      await waitForMigrationControlLockWait(fixture);
      const [beforeAckRows] = await fixture.conn.query<Row[]>(
        "SELECT COUNT(*) AS ack_count FROM blob_storage_migration_object_acks WHERE migration_id=?",
        [migrationId],
      );
      expect(Number(beforeAckRows[0]?.ack_count)).toBe(0);

      releasePut();
      await expect(copyPromise).rejects.toBeInstanceOf(BlobStorageMigrationConflictError);
      const [afterAckRows] = await fixture.conn.query<Row[]>(
        "SELECT COUNT(*) AS ack_count FROM blob_storage_migration_object_acks WHERE migration_id=?",
        [migrationId],
      );
      expect(Number(afterAckRows[0]?.ack_count)).toBe(0);

      const aborted = await abortPromise;
      expect(aborted).toMatchObject({ migrationId, phase: "aborted", objectAckCount: 0 });
      await expect(fixture.target.inspectExact(storageKey, { maxBytes: MAX_BYTES })).resolves.toEqual({
        kind: "tombstone",
        migrationOwnerSha256: blobStorageMigrationTargetOwnerSha256(
          migrationId,
          fixture.target.namespaceSha256,
          storageKey,
        ),
      });
    }, async failed => {
      if (failed) fixture.cancel();
      await closeAll([
        () => releasePut(),
        () => copyPromise?.catch(() => undefined),
        () => abortPromise?.catch(() => undefined),
        () => killedOperator?.close().catch(() => undefined),
        () => fixture.close(),
      ]);
    });
  }), 60_000);

  it("fails closed before inventory publication when an object exceeds MAX_OBJECT_BYTES", async context => migrationCase(context, async fixture => {
    await preserveFirst(async () => {
      const migrationId = `limit-${randomUUID()}`;
      const key = "objects/oversized";
      await seedReadyBlob(
        fixture,
        "oversized",
        key,
        "upload-oversized",
        Buffer.alloc(64, 0x5a),
      );
      const coordinator = await fixture.connect();
      await expect(coordinator.prepare(
        fixture.source,
        fixture.target,
        migrationInput(fixture, migrationId),
        8,
      )).rejects.toBeInstanceOf(BlobTooLargeError);

      const frozen = await coordinator.getControl();
      expect(frozen).toMatchObject({
        migrationId,
        phase: "frozen",
        inventoryEntryCount: 0,
      });
      expect(frozen).not.toHaveProperty("inventoryRootSha256");
      expect(await fixture.target.inspectExact(key, { maxBytes: MAX_BYTES }))
        .toEqual({ kind: "missing" });
      const [counts] = await fixture.conn.query<Row[]>(
        `SELECT
           (SELECT COUNT(*) FROM blob_storage_migration_inventory WHERE migration_id=?) AS inventory_count,
           (SELECT COUNT(*) FROM blob_storage_migration_receipts WHERE migration_id=?) AS receipt_count,
           (SELECT control_generation FROM blob_storage_control WHERE singleton_id=1) AS blob_generation`,
        [migrationId, migrationId],
      );
      expect(Number(counts[0]?.inventory_count)).toBe(0);
      expect(Number(counts[0]?.receipt_count)).toBe(0);
      expect(Number(counts[0]?.blob_generation)).toBe(0);
      const [pointers] = await fixture.conn.query<Row[]>(
        "SELECT storage_backend FROM blob_objects WHERE blob_id='oversized'",
      );
      expect(String(pointers[0]?.storage_backend)).toBe(BLOB_STORAGE_MIGRATION_SOURCE_BACKEND);

      await coordinator.close();
      const restartedStatus = await fixture.connect(false);
      await expect(restartedStatus.getControl()).resolves.toMatchObject({
        migrationId,
        phase: "frozen",
        inventoryEntryCount: 0,
      });
    }, async failed => {
      if (failed) fixture.cancel();
      await closeAll([
        () => fixture.close(),
      ]);
    });
  }), 60_000);
});
