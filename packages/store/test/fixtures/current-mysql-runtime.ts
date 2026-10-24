import { randomBytes } from "node:crypto";
import { createConnection as createSocket, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import mysql, { type Connection, type FieldPacket, type QueryOptions, type QueryResult, type QueryValues, type RowDataPacket } from "mysql2/promise";
import { MysqlSessionStore } from "../../src/index.js";
import { prepareMysqlRuntimeFixture, witnessAbsentMysqlFixtureDatabase } from "../../../../test/fixtures/mysql-runtime.mjs";
import { createMysqlSchemaCliExecutor } from "../../../../test/fixtures/mysql-schema-cli.mjs";
import { createMysqlAuthorityCliExecutor } from "../../../../test/fixtures/mysql-authority-cli.mjs";

const failed = () => new Error("Current MySQL test fixture ownership is not proven");
const at = (base: URL, database: string) => { const url = new URL(base); url.pathname = `/${database}`; return url.toString(); };

/** An operator SQL observer, never an ordinary store. Own query promises and the actual socket. */
export class CurrentMysqlInspection {
  private readonly pending = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;
  private admitting = true;
  private closeFailure: { reason: unknown } | undefined;
  private closeFailureReporter: ((reason: unknown) => void) | undefined;
  constructor(private readonly connection: Connection, private readonly socket: Socket,
    private readonly nativeClosed: Promise<void>, private readonly signal: AbortSignal,
    private readonly detachAbort: () => void) {}

  query<T extends QueryResult = QueryResult>(sql: string | QueryOptions, values?: QueryValues): Promise<[T, FieldPacket[]]> {
    if (!this.admitting || this.closing || this.signal.aborted) return Promise.reject(failed());
    const work = typeof sql === "string" ? this.connection.query<T>(sql, values) : this.connection.query<T>(sql, values);
    this.pending.add(work);
    void work.then(() => this.pending.delete(work), reason => {
      this.pending.delete(work);
      if (!this.admitting && !this.signal.aborted) this.failClose(reason);
    });
    return work;
  }

  /** Stop caller SQL synchronously, independently of transport cancellation. */
  sealAdmission(onFailure?: (reason: unknown) => void): void {
    this.admitting = false;
    if (onFailure && !this.closeFailureReporter) {
      this.closeFailureReporter = onFailure;
      if (this.closeFailure) onFailure(this.closeFailure.reason);
    }
  }

  private failClose(reason: unknown): void {
    if (this.closeFailure) return;
    this.closeFailure = { reason }; this.closeFailureReporter?.(reason);
  }

  end(onFailure?: (reason: unknown) => void): Promise<void> {
    if (this.closing) { this.sealAdmission(onFailure); return this.closing; }
    let resolveClose!: () => void, rejectClose!: (reason: unknown) => void;
    // Cache before driver callbacks or cancellation can reenter end().
    const closing = this.closing = new Promise<void>((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
    this.sealAdmission(onFailure);
    void (async () => {
      try {
        if (!this.signal.aborted) {
          while (this.pending.size) await Promise.allSettled([...this.pending]);
          if (!this.closeFailure && !this.signal.aborted) await this.connection.end();
        }
      } catch (reason) { this.failClose(reason); }
      finally {
        try { this.connection.destroy(); } catch (reason) { this.failClose(reason); }
        try { this.socket.destroy(); } catch (reason) { this.failClose(reason); }
        await this.nativeClosed;
        while (this.pending.size) await Promise.allSettled([...this.pending]);
        this.detachAbort();
      }
      if (this.closeFailure) throw this.closeFailure.reason;
    })().then(resolveClose, rejectClose);
    return closing;
  }
}

/** One current-schema test file's new database. No adoption of the URL's existing app schema. */
export class CurrentMysqlRuntimeOwner {
  readonly database = `agent_service_test_mysql_redis_${randomBytes(12).toString("hex")}`;
  private readonly base: URL;
  private readonly preparation = new AbortController();
  private readonly consumers = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly stores = new Set<MysqlSessionStore>();
  private readonly inspections = new Set<CurrentMysqlInspection>();
  private readonly sockets = new Map<Socket, Promise<void>>();
  private readonly nativeFailures: unknown[] = [];
  private readonly pendingCloseFailures: unknown[] = [];
  private admissionsClosed = false;
  private runtime: Awaited<ReturnType<typeof prepareMysqlRuntimeFixture>> | undefined;
  private preparing: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private uuid = "";
  private ready = false;
  private createAttempted = false;
  private created = false;

  constructor(operatorUrl: string) {
    try {
      this.base = new URL(operatorUrl);
      if (this.base.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(this.base.hostname)
        || this.base.search || this.base.hash || !/(?:^|[_-])test(?:$|[_-])/i.test(decodeURIComponent(this.base.pathname.slice(1)))) throw failed();
      // The provided path is only a caller safety token. Every actual connection uses mysql or our new DB.
      this.base.pathname = "/mysql";
    } catch { throw failed(); }
  }

  private own<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    void work.then(() => this.pending.delete(work), reason => {
      this.pending.delete(work);
      if (this.admissionsClosed) { this.pendingCloseFailures.push(reason); this.consumers.abort(); }
    });
    return work;
  }

  private observe(socket: Socket): Socket {
    const closed = socket.closed ? Promise.resolve() : new Promise<void>(resolve => socket.once("close", () => resolve()));
    this.sockets.set(socket, closed); void closed.then(() => this.sockets.delete(socket)); return socket;
  }

  private async inspect(database: string, signal: AbortSignal, connectTimeoutMs = 10_000, cleanup = false): Promise<CurrentMysqlInspection> {
    if (signal.aborted) throw failed();
    let socket: Socket | undefined, connection: Connection | undefined;
    const abort = () => {
      try { connection?.destroy(); } catch (error) { this.nativeFailures.push(error); }
      try { socket?.destroy(); } catch (error) { this.nativeFailures.push(error); }
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      connection = await mysql.createConnection({ uri: at(this.base, database), connectTimeout: connectTimeoutMs,
        stream: (options: { config: { host: string; port: number } }) => {
          if (socket) throw failed();
          socket = this.observe(createSocket({ host: options.config.host, port: options.config.port }));
          if (signal.aborted) queueMicrotask(abort); return socket;
        } });
      if (!socket || signal.aborted) throw failed();
      const value = new CurrentMysqlInspection(connection, socket, this.sockets.get(socket) ?? Promise.resolve(), signal,
        () => signal.removeEventListener("abort", abort));
      const [identity] = await value.query<RowDataPacket[]>({ sql: "SELECT @@server_uuid AS uuid,DATABASE() AS db", timeout: connectTimeoutMs });
      if (identity.length !== 1 || identity[0]?.db !== database || typeof identity[0]?.uuid !== "string"
        || !/^[a-f0-9-]{36}$/i.test(identity[0].uuid) || this.uuid && identity[0].uuid.toLowerCase() !== this.uuid) throw failed();
      if (!this.uuid) this.uuid = identity[0].uuid.toLowerCase();
      // A late factory performs its real identity read, then returns only a sealed caller admission.
      if (this.admissionsClosed && !cleanup) value.sealAdmission();
      this.inspections.add(value); return value;
    } catch (error) {
      abort();
      if (socket) await (this.sockets.get(socket) ?? Promise.resolve());
      signal.removeEventListener("abort", abort); throw error;
    }
  }

  prepare(): Promise<void> {
    if (this.preparing) return this.preparing;
    if (this.admissionsClosed) return Promise.reject(failed());
    return this.preparing = this.own((async () => {
      const admin = await this.inspect("mysql", this.preparation.signal);
      try {
        const url = at(this.base, this.database);
        const witness = await witnessAbsentMysqlFixtureDatabase({ operatorUrl: url, applicationDatabase: this.database,
          operationAbortSignal: this.preparation.signal });
        this.createAttempted = true;
        await admin.query({ sql: `CREATE DATABASE \`${this.database}\` CHARACTER SET utf8mb4`, timeout: 10_000 });
        this.created = true;
        const cwd = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
        const entrypoint = fileURLToPath(new URL("../../../../apps/agent-runner/src/main.ts", import.meta.url));
        this.runtime = await prepareMysqlRuntimeFixture(witness, {
          schemaExecutor: createMysqlSchemaCliExecutor({ entrypoint, mode: "source", cwd }),
          authorityExecutor: createMysqlAuthorityCliExecutor({ entrypoint, mode: "source", cwd }),
        });
        await this.runtime.assertReusable(url);
      } finally { await admin.end(); }
      // Readiness includes the original bootstrap observer's actual native close.
      this.ready = true;
    })());
  }

  openStore(connectionLimit: number, operationAbortSignal?: AbortSignal): Promise<MysqlSessionStore> {
    if (!this.ready || !this.runtime || this.admissionsClosed) return Promise.reject(failed());
    const signal = operationAbortSignal ? AbortSignal.any([this.consumers.signal, operationAbortSignal]) : this.consumers.signal;
    return this.own(MysqlSessionStore.connect({ ...this.runtime.runtimeStoreOptions, connectionLimit,
      operationAbortSignal: signal }).then(store => { this.stores.add(store); return store; }));
  }

  openInspection(operationAbortSignal?: AbortSignal, connectTimeoutMs = 10_000): Promise<CurrentMysqlInspection> {
    if (!this.ready || this.admissionsClosed || !Number.isSafeInteger(connectTimeoutMs)
      || connectTimeoutMs < 1 || connectTimeoutMs > 10_000) return Promise.reject(failed());
    const signal = operationAbortSignal ? AbortSignal.any([this.consumers.signal, operationAbortSignal]) : this.consumers.signal;
    return this.own(this.inspect(this.database, signal, connectTimeoutMs));
  }

  /** Explicit owned operator schema action (including current-fixture repair). No ordinary store or runtime fallback is produced. */
  migrateWithLockTimeout(seconds: number): Promise<void> {
    if (!this.ready || this.admissionsClosed) return Promise.reject(failed());
    return this.own(MysqlSessionStore.runSchemaOperation({ url: at(this.base, this.database), operation: "migrate",
      fleetStoppedAck: "all-application-writers-stopped-v1", operationAbortSignal: this.consumers.signal,
      migrationLockTimeoutSeconds: seconds }));
  }

  close(input: { successful: boolean }): Promise<void> {
    if (this.closing) {
      if (!input.successful) {
        this.admissionsClosed = true;
        for (const observer of this.inspections) observer.sealAdmission();
        this.consumers.abort();
        this.preparation.abort();
      }
      return this.closing;
    }
    let resolveClose!: () => void, rejectClose!: (reason: unknown) => void;
    const closing = this.closing = new Promise<void>((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
    const failures: unknown[] = [];
    const fail = (reason: unknown) => { failures.push(reason); this.consumers.abort(); };
    this.admissionsClosed = true;
    for (const observer of this.inspections) observer.sealAdmission(fail);
    let requestedSuccess = false;
    try {
      requestedSuccess = input.successful;
      // Failed/unknown preparation must be cancelled before its original promise is joined.
      if (!this.ready) this.preparation.abort();
      if (!requestedSuccess || !this.ready || this.preparation.signal.aborted || this.nativeFailures.length) this.consumers.abort();
    } catch (reason) {
      fail(reason);
      if (!this.ready) this.preparation.abort();
    }
    void (async () => {
      const closeConsumer = async (work: () => Promise<void>) => {
        try { await work(); } catch (reason) { fail(reason); }
      };
      while (this.pending.size) await Promise.allSettled([...this.pending]);
      // A rejection while draining an admitted operation cannot authorize successful cleanup.
      // Earlier settled negative tests (including migrateWithLockTimeout) keep their original contract.
      if (requestedSuccess && this.pendingCloseFailures.length) failures.push(...this.pendingCloseFailures);
      await Promise.allSettled([
        ...[...this.stores].map(store => closeConsumer(() => store.close())),
        ...[...this.inspections].map(observer => closeConsumer(() => observer.end(fail))),
      ]);
      // Driver end is not the actual socket close or proof of remote zero references.
      while (this.sockets.size) await Promise.all([...this.sockets.values()]);
      let successful = requestedSuccess && this.ready && this.created && !this.preparation.signal.aborted
        && !this.consumers.signal.aborted && !failures.length && !this.nativeFailures.length;
      try {
        if (this.runtime) {
          if (successful) {
            try { await this.runtime.assertReusable(at(this.base, this.database)); }
            catch (reason) { fail(reason); successful = false; }
          }
          // A cached unsuccessful close may withdraw cleanup while verification awaited.
          successful = successful && !this.consumers.signal.aborted && !this.preparation.signal.aborted;
          // Preserve/finalize the original handle even if successful verification failed.
          try { await this.runtime.close({ successful }); }
          catch (reason) { fail(reason); successful = false; }
        }
        successful = successful && !this.consumers.signal.aborted && !this.preparation.signal.aborted;
        if (successful) {
          // This private cleanup observer is not exposed through closed caller admission.
          const admin = await this.inspect("mysql", this.preparation.signal, 10_000, true);
          try {
            const [rows] = await admin.query<RowDataPacket[]>({ sql: "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", timeout: 10_000 }, [this.database]);
            if (rows.length !== 1 || rows[0]?.SCHEMA_NAME !== this.database) throw failed();
            await admin.query({ sql: `DROP DATABASE \`${this.database}\``, timeout: 10_000 });
            const [after] = await admin.query<RowDataPacket[]>({ sql: "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", timeout: 10_000 }, [this.database]);
            if (after.length !== 0) throw failed();
          } finally { await admin.end(fail); }
        } else if (this.createAttempted) {
          // Fixed owned labels only. A lost CREATE or failed activation is never guessed absent.
          console.warn(JSON.stringify({ schema: "mysql-redis-current-fixture-retained-v1", applicationDatabase: this.database,
            status: "retained_or_unknown" }));
        }
      } catch (reason) { fail(reason); }
      finally {
        this.consumers.abort();
        this.preparation.abort();
        await Promise.allSettled([...this.inspections].map(observer => closeConsumer(() => observer.end(fail))));
        while (this.sockets.size) await Promise.all([...this.sockets.values()]);
      }
      failures.push(...this.nativeFailures);
      if (failures.length) throw new AggregateError(failures, "Current MySQL fixture close failed");
    })().then(resolveClose, rejectClose);
    return closing;
  }
}
