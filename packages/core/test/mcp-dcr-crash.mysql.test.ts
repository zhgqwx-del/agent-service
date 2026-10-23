import { randomBytes } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MysqlSessionStore, createMcpRegistryAccess,
  type McpCoordination, type McpRegistrationOwner } from "@agent-service/store";
import { prepareMysqlRuntimeFixture, witnessAbsentMysqlFixtureDatabase } from "../../../test/fixtures/mysql-runtime.mjs";
import { createMysqlAuthorityCliExecutor } from "../../../test/fixtures/mysql-authority-cli.mjs";
import { McpCredentialCipher } from "../src/mcp/cipher.js";
import { RegisteredMcpService } from "../src/mcp/registered.js";

const ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const owner: McpRegistrationOwner = { scope: "tenant", tenantId: "dcr-crash-tenant", userId: null };
const principal = { tenantId: owner.tenantId!, userId: "dcr-crash-admin" };
function fail(): never { throw new Error("DCR native crash fixture is not proven; retain its owned evidence"); }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); void promise.catch(() => {}); return { promise, resolve, reject }; }
function base(): URL {
  const url = new URL(process.env.MYSQL_TEST_URL ?? "mysql://invalid/");
  if (url.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.search || url.hash
    || !/(?:^|[_-])test(?:$|[_-])/i.test(decodeURIComponent(url.pathname.slice(1)))) return fail();
  return url;
}
function at(url: URL, database: string) { const copy = new URL(url); copy.pathname = `/${database}`; return copy.toString(); }
const coordination = (): McpCoordination => ({ namespaceSha256: "9".repeat(64),
  async enter(_input, signal) { return { signal, async assertOpen() { signal.throwIfAborted(); }, async release() {} }; },
  async publishInvalidation() {}, onInvalidation() { return () => {}; }, async close() {} });

describe.skipIf(!process.env.AGENT_SERVICE_INTEGRATION)("DCR actual native POST / SIGKILL / restricted-runtime cold recovery", () => {
  let admin: Connection | undefined, inspect: Connection | undefined, runtime: Awaited<ReturnType<typeof prepareMysqlRuntimeFixture>> | undefined;
  let child: ChildProcess | undefined, childDone: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let childExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let store: MysqlSessionStore | undefined, service: RegisteredMcpService | undefined, peer: Server | undefined;
  let database = "", mysqlUrl = "", serverUuid = "", directory = "", origin = "", passed = false, nativeChildJoined = false;
  const sockets = new Set<Socket>(), requests: string[] = [], nativeTasks = new Set<Promise<void>>();
  const received = deferred<void>(), remoteClosed = deferred<void>();
  let peerFailure = false;
  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("MCP_ALLOW_LOOPBACK_FOR_TESTS", "1");
    const source = base(), lifetime = new AbortController(), timer = setTimeout(() => lifetime.abort(), 115_000);
    try {
      database = `agent_service_dcr_crash_test_${randomBytes(12).toString("hex")}`; mysqlUrl = at(source, database);
      directory = await mkdtemp(join(tmpdir(), "agent-service-dcr-crash-"));
      admin = await mysql.createConnection({ uri: at(source, "mysql"), connectTimeout: 5_000 });
      const [identity] = await admin.query<RowDataPacket[]>({ sql: "SELECT @@server_uuid AS uuid,DATABASE() AS db", timeout: 5_000 });
      serverUuid = String(identity[0]?.uuid).toLowerCase();
      if (identity.length !== 1 || identity[0]?.db !== "mysql" || !/^[a-f0-9-]{36}$/.test(serverUuid)) fail();
      const witness = await witnessAbsentMysqlFixtureDatabase({ operatorUrl: mysqlUrl, applicationDatabase: database, operationAbortSignal: lifetime.signal });
      await admin.query({ sql: `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`, timeout: 5_000 });
      runtime = await prepareMysqlRuntimeFixture(witness, { schemaExecutor: input => MysqlSessionStore.runSchemaOperation(input),
        authorityExecutor: createMysqlAuthorityCliExecutor({
          entrypoint: join(ROOT, "apps/agent-runner/src/main.ts"), mode: "source", cwd: ROOT,
        }) });
      await runtime.assertReusable(mysqlUrl); lifetime.signal.throwIfAborted();
      inspect = await mysql.createConnection({ uri: mysqlUrl, connectTimeout: 5_000 });
      peer = createServer((request, response) => {
        const task = (async () => {
          try {
            const url = new URL(request.url ?? "/", origin);
            if (request.method === "GET" && url.pathname.startsWith("/.well-known/")) {
              response.setHeader("content-type", "application/json");
              response.end(JSON.stringify(url.pathname.includes("oauth-protected-resource")
                ? { resource: `${origin}/mcp`, authorization_servers: [`${origin}/oauth`] }
                : { issuer: `${origin}/oauth`, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
                  registration_endpoint: `${origin}/register`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
                  token_endpoint_auth_methods_supported: ["none"] })); return;
            }
            if (request.method !== "POST" || url.pathname !== "/register") { response.writeHead(404); response.end(); return; }
            let bytes = 0; const chunks: Buffer[] = [];
            for await (const part of request) { const chunk = Buffer.from(part); bytes += chunk.length; if (bytes > 32_768) fail(); chunks.push(chunk); }
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
            if (request.headers.authorization !== undefined || body.token_endpoint_auth_method !== "none"
              || JSON.stringify(body.redirect_uris) !== JSON.stringify([`${origin}/v1/mcp/oauth/callback`])) fail();
            requests.push(JSON.stringify(body));
            const closed = new Promise<void>(resolve => response.once("close", resolve));
            received.resolve();
            // A real AS has accepted one create request. Withhold its response so
            // the child can only retain durable sending when SIGKILL closes TCP.
            await closed; remoteClosed.resolve();
          } catch { peerFailure = true; received.reject(new Error("DCR native peer failed")); response.destroy(); }
        })(); nativeTasks.add(task); void task.finally(() => nativeTasks.delete(task));
      });
      peer.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
      await new Promise<void>((resolve, reject) => { peer!.once("error", reject); peer!.listen(0, "127.0.0.1", resolve); });
      const address = peer.address(); if (address === null || typeof address === "string") return fail();
      origin = `http://127.0.0.1:${address.port}`;
    } finally { clearTimeout(timer); }
  }, 120_000);
  afterAll(async () => {
    const errors: unknown[] = [];
    try {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (childDone) await childDone.catch(error => { errors.push(error); });
      await service?.close().catch(error => { errors.push(error); }); service = undefined;
      await store?.close().catch(error => { errors.push(error); }); store = undefined;
      if (peer) {
        const closing = new Promise<void>((resolve, reject) => peer!.close(error => error ? reject(error) : resolve()));
        for (const socket of sockets) socket.destroy();
        await Promise.all([closing, ...nativeTasks]).catch(error => { errors.push(error); }); peer = undefined;
      }
      await inspect?.end().catch(error => { errors.push(error); }); inspect = undefined;
      const successful = passed && errors.length === 0 && !peerFailure;
      await runtime?.close({ successful }).catch(error => { errors.push(error); });
      if (successful && errors.length === 0 && admin) {
        const [identity] = await admin.query<RowDataPacket[]>({ sql: "SELECT @@server_uuid AS uuid,DATABASE() AS db", timeout: 5_000 });
        const [refs] = await admin.query<RowDataPacket[]>({ sql: "SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE BINARY DB=BINARY ?", timeout: 5_000 }, [database]);
        const [transactions] = await admin.query<RowDataPacket[]>({ sql: "SELECT COUNT(*) AS n FROM information_schema.INNODB_TRX t JOIN information_schema.PROCESSLIST p ON p.ID=t.trx_mysql_thread_id WHERE BINARY p.DB=BINARY ?", timeout: 5_000 }, [database]);
        const [metadata] = await admin.query<RowDataPacket[]>({ sql: "SELECT COUNT(*) AS n FROM performance_schema.metadata_locks WHERE BINARY OBJECT_SCHEMA=BINARY ? OR (OBJECT_TYPE='SCHEMA' AND BINARY OBJECT_NAME=BINARY ?)", timeout: 5_000 }, [database, database]);
        if (identity.length !== 1 || identity[0]?.db !== "mysql" || String(identity[0]?.uuid).toLowerCase() !== serverUuid
          || Number(refs[0]?.n) !== 0 || Number(transactions[0]?.n) !== 0 || Number(metadata[0]?.n) !== 0
          || !/^agent_service_dcr_crash_test_[a-f0-9]{24}$/.test(database)) fail();
        await admin.query({ sql: `DROP DATABASE \`${database}\``, timeout: 5_000 });
        const [absent] = await admin.query<RowDataPacket[]>({ sql: "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", timeout: 5_000 }, [database]);
        if (absent.length) fail();
      }
      if (directory) await writeFile(join(directory, "terminal.json"), JSON.stringify({ schema: "dcr-native-crash-evidence-v1", database,
        nativeRequests: requests.length, childJoined: nativeChildJoined, nativeHttpJoined: nativeTasks.size === 0,
        passed, peerFailure, cleanupFailures: errors.length }), { mode: 0o600 });
    } finally { await admin?.end().catch(error => { errors.push(error); }); vi.unstubAllEnvs(); }
    if (!passed || errors.length) console.warn(JSON.stringify({ schema: "dcr-native-crash-retained-v1", database, directory }));
    if (errors.length) fail();
  });

  it("retains the real dispatched operation as unknown after SIGKILL and never registers again", async context => {
    const activeRuntime = runtime, observer = inspect;
    if (!activeRuntime || !observer) return fail();
    const intent = deferred<{ configVersionId: string; revision: number }>(), started = deferred<void>();
    let outputSeen = false, failed = false, assertionsPassed = false;
    child = fork(new URL("./fixtures/mcp-dcr-crash-child.ts", import.meta.url), [], { execPath: process.execPath,
      execArgv: ["--import", "tsx"], env: { PATH: process.env.PATH ?? "", HOME: directory, TMPDIR: directory,
        CI: "1", NO_COLOR: "1", NODE_ENV: "test", MCP_ALLOW_LOOPBACK_FOR_TESTS: "1" }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    child.stdout?.on("data", () => { outputSeen = true; }); child.stderr?.on("data", () => { outputSeen = true; });
    childExit = new Promise((resolve, reject) => { child!.once("exit", (code, signal) => resolve({ code, signal })); child!.once("error", reject); });
    childDone = new Promise((resolve, reject) => { child!.once("close", (code, signal) => { nativeChildJoined = true; resolve({ code, signal }); }); child!.once("error", reject); });
    void childExit.catch(() => {}); void childDone.catch(() => {});
    const prematureExit = () => { started.reject(new Error("DCR child ended")); intent.reject(new Error("DCR child ended")); received.reject(new Error("DCR child ended")); };
    child.once("error", prematureExit); child.once("exit", prematureExit);
    child.on("message", value => {
      const message = value as { phase?: string; configVersionId?: string; revision?: number };
      if (message.phase === "ready") child!.send({ protocol: "mcp-dcr-native-crash-v1", storeOptions: activeRuntime.runtimeStoreOptions, origin }, error => error ? started.reject(new Error("DCR child IPC failed")) : started.resolve());
      else if (message.phase === "intent" && typeof message.configVersionId === "string" && message.revision === 1) intent.resolve({ configVersionId: message.configVersionId, revision: message.revision });
      else if (message.phase === "failed") { failed = true; prematureExit(); }
    });
    const abort = () => { child?.kill("SIGKILL"); started.reject(new Error("DCR case cancelled")); intent.reject(new Error("DCR case cancelled")); received.reject(new Error("DCR case cancelled")); remoteClosed.reject(new Error("DCR case cancelled")); };
    context.signal.addEventListener("abort", abort, { once: true });
    try {
      await started.promise;
      const configured = await intent.promise;
      await received.promise;
      expect(requests).toHaveLength(1); expect(failed).toBe(false); expect(child.kill("SIGKILL")).toBe(true);
      expect(await childExit).toEqual({ code: null, signal: "SIGKILL" });
      expect(await childDone).toEqual({ code: null, signal: "SIGKILL" }); await remoteClosed.promise;
      expect(outputSeen).toBe(false);
      const [before] = await observer.query<RowDataPacket[]>({ sql: "SELECT record_json,CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED) AS now_ms FROM mcp_registry_dynamic_clients", timeout: 5_000 });
      expect(before).toHaveLength(1);
      const original = (typeof before[0]?.record_json === "string" ? JSON.parse(before[0].record_json) : before[0]?.record_json) as { operationId: string; state: string; deadlineAtMs: number; sentAtMs: number | null; clientId: string | null };
      expect(original.state).toBe("sending"); expect(original.sentAtMs).not.toBeNull(); expect(original.clientId).toBeNull();
      const delay = Math.max(0, original.deadlineAtMs - Number(before[0]?.now_ms) + 1); expect(delay).toBeLessThanOrEqual(1_001);
      if (delay) await new Promise<void>((resolve, reject) => {
        const aborted = () => { clearTimeout(timer); reject(new Error("DCR expiry wait cancelled")); };
        const timer = setTimeout(() => { context.signal.removeEventListener("abort", aborted); resolve(); }, delay);
        context.signal.addEventListener("abort", aborted, { once: true }); if (context.signal.aborted) aborted();
      });
      store = await MysqlSessionStore.connect(activeRuntime.runtimeStoreOptions);
      service = new RegisteredMcpService({ store, coordination: coordination(),
        cipher: new McpCredentialCipher({ keyId: "dcr-crash-fixture-v1", key: new Uint8Array(32).fill(9) }),
        callbackUrl: `${origin}/v1/mcp/oauth/callback`, timeoutMs: 1_000, allowLoopbackForTests: true,
        authorizeFleet: async () => {}, authorizeDcrFleet: async () => {} });
      const access = createMcpRegistryAccess({ principal, owner, authority: "tenant_admin", access: "manage" });
      const status = await service.getDynamicClientStatus(owner, "crash", { access, configVersionId: configured.configVersionId }, context.signal);
      expect(status.registration).toMatchObject({ state: "outcome_unknown", operationId: original.operationId, manualReviewRequired: true, remoteRevocationSupported: false });
      const [sealed] = await observer.query<RowDataPacket[]>({ sql: "SELECT record_json FROM mcp_registry_dynamic_clients", timeout: 5_000 });
      expect((await service.registerDynamicClient(owner, "crash", { access, configVersionId: configured.configVersionId, expectedRevision: configured.revision,
        idempotencyKey: "crash-registration" }, context.signal)).registration).toEqual(status.registration);
      await expect(service.registerDynamicClient(owner, "crash", { access, configVersionId: configured.configVersionId,
        expectedRevision: configured.revision, idempotencyKey: "replacement-must-not-register" }, context.signal)).rejects.toMatchObject({ code: "idempotency_conflict" });
      const [after] = await observer.query<RowDataPacket[]>({ sql: "SELECT record_json FROM mcp_registry_dynamic_clients", timeout: 5_000 });
      expect(after).toEqual(sealed); expect(requests).toHaveLength(1); expect(peerFailure).toBe(false);
      await service.close(); service = undefined; await store.close(); store = undefined; assertionsPassed = true;
    } finally {
      context.signal.removeEventListener("abort", abort);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      const joined = await Promise.allSettled([childExit, childDone, service?.close()]); service = undefined;
      await store?.close(); store = undefined;
      if (joined.some(result => result.status !== "fulfilled")) fail();
    }
    passed = assertionsPassed;
  });
});
