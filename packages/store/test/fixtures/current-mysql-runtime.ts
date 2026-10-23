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
  constructor(private readonly connection: Connection, private readonly socket: Socket,
    private readonly nativeClosed: Promise<void>, private readonly signal: AbortSignal,
    private readonly detachAbort: () => void) {}

  query<T extends QueryResult = QueryResult>(sql: string | QueryOptions, values?: QueryValues): Promise<[T, FieldPacket[]]> {
    if (this.closing || this.signal.aborted) return Promise.reject(failed());
    const work = typeof sql === "string" ? this.connection.query<T>(sql, values) : this.connection.query<T>(sql, values);
    this.pending.add(work); void work.then(() => this.pending.delete(work), () => this.pending.delete(work));
    return work;
  }

  end(): Promise<void> {
    if (this.closing) return this.closing;
    return this.closing = (async () => {
      let failure: { reason: unknown } | undefined;
      try { if (!this.signal.aborted) await this.connection.end(); }
      catch (reason) { failure = { reason }; }
      finally {
        try { this.connection.destroy(); } catch (reason) { failure ??= { reason }; }
        try { this.socket.destroy(); } catch (reason) { failure ??= { reason }; }
        await this.nativeClosed;
        while (this.pending.size) await Promise.allSettled([...this.pending]);
        this.detachAbort();
      }
      if (failure) throw failure.reason;
    })();
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
    this.pending.add(work); void work.then(() => this.pending.delete(work), () => this.pending.delete(work)); return work;
  }

  private observe(socket: Socket): Socket {
    const closed = socket.closed ? Promise.resolve() : new Promise<void>(resolve => socket.once("close", () => resolve()));
    this.sockets.set(socket, closed); void closed.then(() => this.sockets.delete(socket)); return socket;
  }

  private async inspect(database: string, signal: AbortSignal, connectTimeoutMs = 10_000): Promise<CurrentMysqlInspection> {
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
      this.inspections.add(value);
      const [identity] = await value.query<RowDataPacket[]>({ sql: "SELECT @@server_uuid AS uuid,DATABASE() AS db", timeout: connectTimeoutMs });
      if (identity.length !== 1 || identity[0]?.db !== database || typeof identity[0]?.uuid !== "string"
        || !/^[a-f0-9-]{36}$/i.test(identity[0].uuid) || this.uuid && identity[0].uuid.toLowerCase() !== this.uuid) throw failed();
      if (!this.uuid) this.uuid = identity[0].uuid.toLowerCase(); return value;
    } catch (error) {
      abort();
      if (socket) await (this.sockets.get(socket) ?? Promise.resolve());
      signal.removeEventListener("abort", abort); throw error;
    }
  }

  prepare(): Promise<void> {
    if (this.preparing) return this.preparing;
    if (this.closing) return Promise.reject(failed());
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
    if (!this.ready || !this.runtime || this.closing) return Promise.reject(failed());
    const signal = operationAbortSignal ? AbortSignal.any([this.consumers.signal, operationAbortSignal]) : this.consumers.signal;
    return this.own(MysqlSessionStore.connect({ ...this.runtime.runtimeStoreOptions, connectionLimit,
      operationAbortSignal: signal }).then(store => { this.stores.add(store); return store; }));
  }

  openInspection(operationAbortSignal?: AbortSignal, connectTimeoutMs = 10_000): Promise<CurrentMysqlInspection> {
    if (!this.ready || this.closing || !Number.isSafeInteger(connectTimeoutMs)
      || connectTimeoutMs < 1 || connectTimeoutMs > 10_000) return Promise.reject(failed());
    const signal = operationAbortSignal ? AbortSignal.any([this.consumers.signal, operationAbortSignal]) : this.consumers.signal;
    return this.own(this.inspect(this.database, signal, connectTimeoutMs));
  }

  /** Explicit owned operator schema action (including current-fixture repair). No ordinary store or runtime fallback is produced. */
  migrateWithLockTimeout(seconds: number): Promise<void> {
    if (!this.ready || this.closing) return Promise.reject(failed());
    return this.own(MysqlSessionStore.runSchemaOperation({ url: at(this.base, this.database), operation: "migrate",
      fleetStoppedAck: "all-application-writers-stopped-v1", operationAbortSignal: this.consumers.signal,
      migrationLockTimeoutSeconds: seconds }));
  }

  close(input: { successful: boolean }): Promise<void> {
    if (this.closing) return this.closing;
    // A timeout's original beforeAll promise may still be running. Cancel before joining it.
    if (!this.ready) this.preparation.abort();
    this.consumers.abort();
    return this.closing = (async () => {
      const failures: unknown[] = [];
      while (this.pending.size) await Promise.allSettled([...this.pending]);
      const closed = await Promise.allSettled([
        ...[...this.stores].map(store => store.close()), ...[...this.inspections].map(observer => observer.end()),
      ]);
      for (const result of closed) if (result.status === "rejected") failures.push(result.reason);
      // inspect() and Store close own their actual native connections; do not use a deadline as done.
      while (this.sockets.size) await Promise.all([...this.sockets.values()]);
      const successful = input.successful && this.ready && this.created && !this.preparation.signal.aborted && !failures.length && !this.nativeFailures.length;
      try {
        if (this.runtime) {
          if (successful) await this.runtime.assertReusable(at(this.base, this.database));
          await this.runtime.close({ successful });
        }
        if (successful) {
          const admin = await this.inspect("mysql", this.preparation.signal);
          try {
            const [rows] = await admin.query<RowDataPacket[]>({ sql: "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", timeout: 10_000 }, [this.database]);
            if (rows.length !== 1 || rows[0]?.SCHEMA_NAME !== this.database) throw failed();
            await admin.query({ sql: `DROP DATABASE \`${this.database}\``, timeout: 10_000 });
            const [after] = await admin.query<RowDataPacket[]>({ sql: "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", timeout: 10_000 }, [this.database]);
            if (after.length !== 0) throw failed();
          } finally { await admin.end(); }
        } else if (this.createAttempted) {
          // Fixed owned labels only. A lost CREATE or failed activation is never guessed absent.
          console.warn(JSON.stringify({ schema: "mysql-redis-current-fixture-retained-v1", applicationDatabase: this.database,
            status: "retained_or_unknown" }));
        }
      } catch (error) { failures.push(error); }
      finally {
        this.preparation.abort();
        const final = await Promise.allSettled([...this.inspections].map(observer => observer.end()));
        for (const result of final) if (result.status === "rejected") failures.push(result.reason);
        while (this.sockets.size) await Promise.all([...this.sockets.values()]);
      }
      failures.push(...this.nativeFailures);
      if (failures.length) throw new AggregateError(failures, "Current MySQL fixture close failed");
    })();
  }
}
