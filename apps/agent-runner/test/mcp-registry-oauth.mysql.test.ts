import { randomBytes } from "node:crypto";
import { mkdtemp, open, lstat, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { Redis } from "ioredis";
import { describe, expect, it, vi } from "vitest";
import { MysqlSessionStore, createMcpRegistryAccess } from "@agent-service/store";
import {
  Capabilities, CreateApiKeyResponse, MANAGED_MCP_REGISTRY_V1, McpAuthorizationBeginResponse,
  McpAuthorizationStatusResponse, McpRegistrationResponse, ToolListResponse,
} from "@agent-service/protocol";
import { startRouter } from "../../agent-router/src/main.js";
import { startRunner } from "../src/main.js";
import { McpOAuthPeer } from "./fixtures/mcp-oauth-peer.js";

const alice = { tenantId: "t_mcp_oauth_main", userId: "alice" }, bob = { ...alice, userId: "bob" };
const signals = ["SIGTERM", "SIGINT"] as const;
function listeners() { return new Map(signals.map(signal => [signal, process.listeners(signal)])); }
function bases(): { mysql: URL; redis: URL } {
  const sqlRaw = process.env.MYSQL_TEST_URL, redisRaw = process.env.REDIS_TEST_URL;
  if (!sqlRaw || !redisRaw) throw new Error("OAuth main fixture requires explicit MYSQL_TEST_URL and REDIS_TEST_URL");
  let sql: URL, redis: URL, database: string;
  try { sql = new URL(sqlRaw); redis = new URL(redisRaw); database = decodeURIComponent(sql.pathname.slice(1)); }
  catch { throw new Error("OAuth main fixture URLs are invalid"); }
  const local = (url: URL) => ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && !url.search && !url.hash;
  if (sql.protocol !== "mysql:" || !local(sql) || !sql.username || !/^[A-Za-z0-9_]+$/.test(database) || !/(?:^|_)test(?:$|_)/i.test(database)
    || redis.protocol !== "redis:" || !local(redis) || !/^\/(?:[0-9]|1[0-5])$/.test(redis.pathname)) {
    throw new Error("OAuth main fixture requires loopback MySQL test DB and explicit Redis DB 0..15 without URL options");
  }
  return { mysql: sql, redis };
}
function databaseUrl(base: URL, database: string): string { const url = new URL(base); url.pathname = `/${database}`; return url.toString(); }
async function scopedKeys(redis: Redis, prefix: string): Promise<string[]> {
  const keys = new Set<string>(); let cursor = "0", rounds = 0;
  do {
    const page = await redis.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 100); cursor = page[0];
    for (const key of page[1]) { if (!key.startsWith(`${prefix}:`)) throw new Error("OAuth Redis namespace ownership rejected"); keys.add(key); }
    if (++rounds > 100 || keys.size > 2_000) throw new Error("OAuth Redis namespace scan exceeded bound");
  } while (cursor !== "0");
  return [...keys];
}
async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", () => reject(new Error("OAuth fixture port unavailable"))); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("OAuth fixture port unavailable");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(new Error("OAuth fixture port close failed")) : resolve()));
  return address.port;
}
async function listeningUrl(server: HttpServer): Promise<string> {
  if (!server.listening) await new Promise<void>((resolve, reject) => {
    const ready = () => { server.off("error", failed); resolve(); }, failed = () => { server.off("listening", ready); reject(new Error("OAuth fixture listener unavailable")); };
    server.once("listening", ready); server.once("error", failed);
  });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("OAuth fixture listener unavailable");
  return `http://127.0.0.1:${address.port}`;
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("registered OAuth real router/two-runner/MySQL/Redis callback", () => {
    it("binds anonymous callback to its durable user, exchanges once, isolates credentials and cold-verifies disconnect", async () => {
      const base = bases(), suffix = randomBytes(12).toString("hex");
      const database = `agent_service_mcp_oauth_test_${suffix}`, prefix = `agent_service_mcp_oauth_test_${suffix}`;
      const mysqlUrl = databaseUrl(base.mysql, database), namespaceId = `mcp_oauth_test_${suffix}`;
      const deadline = performance.now() + 60_000, lifetime = new AbortController();
      const operationTimer = setTimeout(() => lifetime.abort(), 45_000);
      const checkDeadline = () => { if (performance.now() >= deadline) throw new Error("OAuth main fixture deadline expired; retain owned evidence"); };
      const checkOperation = () => { checkDeadline(); if (lifetime.signal.aborted) throw new Error("OAuth main fixture operation deadline expired"); };
      const initialListeners = listeners(); let routerListeners: ReturnType<typeof listeners> = new Map();
      const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("MCP_ALLOW_LOOPBACK_FOR_TESTS", "1");
      let admin: Connection | undefined, redis: Redis | undefined, cold: MysqlSessionStore | undefined;
      let first: Awaited<ReturnType<typeof startRunner>> | undefined, second: Awaited<ReturnType<typeof startRunner>> | undefined;
      let router: Awaited<ReturnType<typeof startRouter>> | undefined, peer: McpOAuthPeer | undefined;
      let created = false, createAttempted = false, namespaceOwned = false, servicesClosed = false, startupUncertain = false;
      let coldUncertain = false, bodyPassed = false, serverUuid: string | undefined, scratch: string | undefined;
      let versionId: string | undefined, connectedEpoch = 0, disconnectedEpoch = 0;
      const failures: unknown[] = [];
      try {
        admin = await mysql.createConnection({ uri: databaseUrl(base.mysql, "mysql"), connectTimeout: 5_000 });
        const [identity] = await admin.query<RowDataPacket[]>({ sql: "SELECT @@server_uuid AS server_uuid", timeout: 5_000 });
        serverUuid = String(identity[0]?.server_uuid); if (!/^[0-9a-f-]{36}$/i.test(serverUuid)) throw new Error("OAuth MySQL identity unavailable");
        const [exists] = await admin.query<RowDataPacket[]>({ sql: "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", timeout: 5_000 }, [database]);
        if (exists.length) throw new Error("OAuth fixture database already exists; ownership rejected");
        redis = new Redis(base.redis.toString(), { lazyConnect: true, enableOfflineQueue: false, connectTimeout: 2_000, commandTimeout: 2_000, maxRetriesPerRequest: 1 });
        redis.on("error", () => {}); await redis.connect(); expect(await redis.ping()).toBe("PONG");
        if ((await scopedKeys(redis, prefix)).length) throw new Error("OAuth fixture Redis namespace already exists");
        namespaceOwned = true; checkOperation(); createAttempted = true;
        await admin.query({ sql: `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`, timeout: 5_000 }); created = true;
        scratch = await mkdtemp(join(tmpdir(), "agent-service-mcp-oauth-"));
        const ports = new Set<number>(); while (ports.size < 3) ports.add(await unusedPort());
        const [firstPort, secondPort, routerPort] = [...ports] as [number, number, number];
        const callbackUrl = `http://127.0.0.1:${routerPort}/v1/mcp/oauth/callback`;
        peer = new McpOAuthPeer(callbackUrl); await peer.start();
        const keyFile = join(scratch, "credential-key"), key = randomBytes(32); let keyHandle: Awaited<ReturnType<typeof open>> | undefined;
        try { keyHandle = await open(keyFile, "wx", 0o600); await keyHandle.writeFile(key); await keyHandle.sync(); }
        finally { key.fill(0); await keyHandle?.close(); }
        const internalToken = randomBytes(24).toString("base64url"), bootstrapKey = randomBytes(24).toString("base64url");
        const environment: NodeJS.ProcessEnv = {
          NODE_ENV: "test", STORE: "mysql", MYSQL_URL: mysqlUrl, SECRETS_MASTER_KEY: randomBytes(32).toString("hex"), INTERNAL_ROUTER_TOKEN: internalToken,
          PLATFORM_PROVIDER: "deepseek", API_KEY: "local-unused-oauth-provider", API_BASE_URL: `${peer.issuer}/unused-provider`, DEFAULT_MODEL: "deepseek-chat",
          BLOB_STORE: "filesystem", BLOB_FILESYSTEM_SINGLE_RUNNER: "1", MCP_REGISTRY_ENABLED: "1", MCP_ALLOW_LOOPBACK_FOR_TESTS: "1", MCP_TIMEOUT_MS: "15000",
          MCP_REGISTRY_CREDENTIAL_KEY_FILE: keyFile, MCP_REGISTRY_CREDENTIAL_KEY_ID: "oauth-main-key-v1", MCP_REGISTRY_OAUTH_CALLBACK_URL: callbackUrl,
          REDIS_URL: base.redis.toString(), REDIS_PREFIX: prefix, REDIS_NAMESPACE_ID: namespaceId, ERASURE_ROUTER_URL: `http://127.0.0.1:${routerPort}`,
          LEASE_TTL_MS: "10000", LEASE_HOLD_MS: "20", SSE_HEARTBEAT_MS: "60000",
        };
        startupUncertain = true;
        first = await startRunner({ ...environment, RUNNER_HOST: "127.0.0.1", RUNNER_PORT: String(firstPort), RUNNER_ADDR: `127.0.0.1:${firstPort}`,
          RUNNER_ID: `oauth-first-${suffix}`, BLOB_DIR: join(scratch, "first-blobs"), BOOTSTRAP_API_KEY: bootstrapKey, BOOTSTRAP_TENANT_ID: alice.tenantId });
        startupUncertain = false; const firstUrl = await listeningUrl(first.server as HttpServer);
        startupUncertain = true;
        second = await startRunner({ ...environment, RUNNER_HOST: "127.0.0.1", RUNNER_PORT: String(secondPort), RUNNER_ADDR: `127.0.0.1:${secondPort}`,
          RUNNER_ID: `oauth-second-${suffix}`, BLOB_DIR: join(scratch, "second-blobs") });
        startupUncertain = false; const secondUrl = await listeningUrl(second.server as HttpServer);
        for (const runner of [first, second]) for (const enabled of [runner.cfg.BLOB_CLEANUP_ENABLED, runner.cfg.ERASURE_WORKER_ENABLED,
          runner.cfg.TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED, runner.cfg.TENANT_PURGE_EXECUTION_WORKER_ENABLED, runner.cfg.TENANT_DATABASE_PURGE_WORKER_ENABLED,
          runner.cfg.TENANT_REDIS_PURGE_WORKER_ENABLED, runner.cfg.SESSION_USAGE_RETENTION_WORKER_ENABLED, runner.cfg.DATA_EXPORT_WORKER_ENABLED]) expect(enabled).toBe(false);
        const beforeRouter = listeners(); startupUncertain = true;
        router = await startRouter({ NODE_ENV: "test", ROUTER_HOST: "127.0.0.1", ROUTER_PORT: String(routerPort), RUNNERS: `${firstUrl},${secondUrl}`,
          INTERNAL_ROUTER_TOKEN: internalToken, HEALTH_INTERVAL_MS: "1000", SHUTDOWN_GRACE_MS: "0", MCP_REGISTRY_ENABLED: "1", MCP_ALLOW_LOOPBACK_FOR_TESTS: "1",
          MCP_REGISTRY_CREDENTIAL_KEY_ID: "oauth-main-key-v1", MCP_REGISTRY_OAUTH_CALLBACK_URL: callbackUrl,
          REDIS_URL: base.redis.toString(), REDIS_PREFIX: prefix, REDIS_NAMESPACE_ID: namespaceId });
        startupUncertain = false;
        routerListeners = new Map(signals.map(signal => [signal, process.listeners(signal).filter(listener => !beforeRouter.get(signal)!.includes(listener))]));
        const routerUrl = await listeningUrl(router.server as HttpServer); expect(routerUrl).toBe(`http://127.0.0.1:${routerPort}`);
        expect(router.registry.list()).toEqual([expect.objectContaining({ url: firstUrl, healthy: true }), expect.objectContaining({ url: secondUrl, healthy: true })]);
        const json = async (path: string, options: { method?: string; body?: unknown; key?: string; user?: string; idempotency?: string } = {}) => {
          checkOperation();
          const response = await fetch(`${routerUrl}${path}`, { method: options.method ?? "GET", headers: {
            authorization: `Bearer ${options.key ?? bootstrapKey}`, "x-user-id": options.user ?? alice.userId, "content-type": "application/json",
            ...(options.idempotency ? { "idempotency-key": options.idempotency } : {}),
          }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }), signal: lifetime.signal });
          const wire = await response.text();
          expect(peer!.containsSensitive(wire)).toBe(false);
          return { status: response.status, wire, body: JSON.parse(wire) as unknown };
        };
        const capabilities = await json("/v1/capabilities"); expect(capabilities.status).toBe(200);
        expect(Capabilities.parse(capabilities.body).features.mcpRegistry).toEqual([MANAGED_MCP_REGISTRY_V1]);
        expect(first.mcpRegistry!.identity).toEqual(second.mcpRegistry!.identity);
        const keyReply = await json("/v1/tenant/api-keys", { method: "POST", body: { keyId: "oauth-runtime", scopes: ["runtime"] } });
        expect(keyReply.status).toBe(201); const runtimeKey = CreateApiKeyResponse.parse(keyReply.body); expect(runtimeKey.scopes).toEqual(["runtime"]);
        const registration = await json("/v1/mcp-servers", { method: "POST", idempotency: "oauth-register-alpha", body: {
          scope: "tenant", name: "alpha", expectedRevision: 0, config: { endpoint: peer.endpoint, description: "Local OAuth MCP fixture", protocolVersion: "2026-07-28",
            authentication: { kind: "oauth", issuer: peer.issuer, clientId: peer.clientId, clientAuthentication: "client_secret_basic", clientSecret: peer.clientSecret, scopes: ["echo"] } },
        } });
        expect(registration.status).toBe(201); const installed = McpRegistrationResponse.parse(registration.body);
        expect(installed.registration).toMatchObject({ scope: "tenant", name: "alpha", state: "enabled", revision: 1 }); versionId = installed.version!.configVersionId;
        expect(installed.version!.config.authentication).toEqual({ kind: "oauth", issuer: peer.issuer, clientId: peer.clientId, clientAuthentication: "client_secret_basic", scopes: ["echo"] });
        const runtime = { key: runtimeKey.key };
        const pending = await json("/v1/mcp-servers/alpha/oauth/begin", { ...runtime, method: "POST", idempotency: "oauth-alice-begin", body: { scope: "tenant" } });
        expect(pending.status).toBe(200); const begin = McpAuthorizationBeginResponse.parse(pending.body);
        expect(new URL(begin.authorizationUrl).origin).toBe(peer.issuer);
        const browser = await fetch(begin.authorizationUrl, { redirect: "manual", signal: lifetime.signal })
          .catch(() => { throw new Error("OAuth fixture authorization browser request failed"); });
        expect(browser.status).toBe(302); const callback = browser.headers.get("location"); await browser.body?.cancel();
        expect(typeof callback).toBe("string"); const callbackAddress = new URL(callback!);
        expect(callbackAddress.origin + callbackAddress.pathname).toBe(callbackUrl);
        expect(callbackAddress.searchParams.get("iss")).toBe(peer.issuer); expect(peer.counts().exchanges).toBe(0);
        const callbackReply = async () => {
          // Deliberately no API key. This wrong user header must not replace the durable state subject.
          checkOperation();
          const response = await fetch(callback!, { headers: { "x-user-id": bob.userId, "x-forwarded-host": "not-the-callback.invalid" }, redirect: "manual", signal: lifetime.signal })
            .catch(() => { throw new Error("OAuth fixture public callback request failed"); });
          const wire = await response.text(), headers = JSON.stringify([...response.headers]);
          expect(peer!.containsSensitive(wire + headers)).toBe(false);
          expect(response.headers.get("cache-control")).toBe("no-store"); expect(response.headers.get("referrer-policy")).toBe("no-referrer");
          expect(response.headers.get("x-content-type-options")).toBe("nosniff"); expect(response.headers.get("location") === null).toBe(true); expect(response.headers.get("set-cookie") === null).toBe(true);
          expect(response.headers.get("content-type")?.startsWith("text/html")).toBe(true);
          return { status: response.status, wire };
        };
        const completed = await callbackReply(); expect(completed.status).toBe(200);
        expect(completed.wire === "<!doctype html><title>MCP authorization</title><p>Authorization completed. You can close this page.</p>").toBe(true);
        expect(peer.counts().exchanges).toBe(1);
        const replay = await callbackReply(); expect(replay.status).toBe(400); expect(peer.counts().exchanges).toBe(1);
        expect(replay.wire === "<!doctype html><title>MCP authorization</title><p>Authorization was not completed. Start authorization again from the application.</p>").toBe(true);
        const status = await json("/v1/mcp-servers/alpha/oauth/status?scope=tenant", runtime); expect(status.status).toBe(200);
        const connected = McpAuthorizationStatusResponse.parse(status.body); expect(connected.authorization?.state).toBe("connected");
        connectedEpoch = connected.authorization!.authorizationEpoch; expect(connected.authorization!.tokenRevision).toBe(1);
        const tools = await json("/v1/mcp-servers/alpha/tools?scope=tenant", runtime); expect(tools.status).toBe(200);
        const discovered = ToolListResponse.parse(tools.body); expect(discovered.data).toHaveLength(1); expect(discovered.data[0]!.kind).toBe("mcp");
        expect(peer.counts().accepted).toBeGreaterThan(0); const accepted = peer.counts().accepted;
        const bobStatus = await json("/v1/mcp-servers/alpha/oauth/status?scope=tenant", { ...runtime, user: bob.userId });
        expect(bobStatus.status).toBe(200); expect(McpAuthorizationStatusResponse.parse(bobStatus.body).authorization).toBeNull();
        const bobTools = await json("/v1/mcp-servers/alpha/tools?scope=tenant", { ...runtime, user: bob.userId });
        expect(bobTools.status).toBe(503); expect((bobTools.body as { error: { code: string } }).error.code).toBe("draining");
        expect(peer.counts().accepted).toBe(accepted); expect(peer.counts().rejected).toBe(0); expect(peer.counts().exchanges).toBe(1);
        const disconnected = await json("/v1/mcp-servers/alpha/oauth/disconnect", { ...runtime, method: "POST", idempotency: "oauth-alice-disconnect", body: { scope: "tenant", expectedAuthorizationEpoch: connectedEpoch } });
        expect(disconnected.status).toBe(200); const stopped = McpAuthorizationStatusResponse.parse(disconnected.body);
        expect(stopped.authorization?.state).toBe("disconnected"); disconnectedEpoch = stopped.authorization!.authorizationEpoch; expect(disconnectedEpoch).toBe(connectedEpoch + 1);
        const afterDisconnect = await json("/v1/mcp-servers/alpha/tools?scope=tenant", runtime);
        expect(afterDisconnect.status).toBe(503); expect((afterDisconnect.body as { error: { code: string } }).error.code).toBe("draining");
        expect(peer.counts().accepted).toBe(accepted); expect(peer.counts().exchanges).toBe(1); expect(peer.mcp.calls).toEqual([]);
        peer.assertHealthy(); checkOperation();
      } catch (error) { failures.push(error); }
      finally {
        clearTimeout(operationTimer); lifetime.abort();
        const clean = async (work: () => Promise<unknown>) => { try { await work(); } catch (error) { failures.push(error); } };
        if (router) { const closed = (router.server as HttpServer).listening ? new Promise<void>(resolve => router!.server.once("close", () => resolve())) : Promise.resolve(); await clean(() => router!.close()); await clean(() => closed); }
        if (first) await clean(() => first!.close()); if (second) await clean(() => second!.close()); if (peer) await clean(() => peer!.stop());
        for (const signal of signals) for (const listener of routerListeners.get(signal) ?? []) process.off(signal, listener);
        try {
          for (const service of [first, second, router]) if (service) expect((service.server as HttpServer).listening).toBe(false);
          for (const signal of signals) expect(process.listeners(signal)).toEqual(initialListeners.get(signal));
          if (router) expect(exit).toHaveBeenCalledWith(0);
          if (startupUncertain) throw new Error("OAuth startup ownership uncertain; retain owned database and key evidence");
          servicesClosed = failures.length === 0; checkDeadline();
        } catch (error) { failures.push(error); }
        exit.mockRestore();
      }
      try {
        if (failures.length === 0 && servicesClosed) {
          checkDeadline(); coldUncertain = true; cold = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 2, migrationMode: "verify" }); coldUncertain = false; checkDeadline();
          const owner = { scope: "tenant" as const, tenantId: alice.tenantId, userId: null };
          const access = createMcpRegistryAccess({ principal: alice, owner, authority: "user_self", access: "runtime" });
          const authorization = await cold.getMcpUserAuthorization({ owner, name: "alpha", access });
          expect(authorization).toMatchObject({ subject: alice, state: "disconnected", configVersionId: versionId, authorizationEpoch: disconnectedEpoch, tokenRevision: 1, credentialVersionId: null });
          expect(await cold.getMcpRuntimeAuthorization({ owner, name: "alpha", access })).toBeNull();
          const bobAccess = createMcpRegistryAccess({ principal: bob, owner, authority: "user_self", access: "runtime" });
          expect(await cold.getMcpUserAuthorization({ owner, name: "alpha", access: bobAccess })).toBeNull();
          expect(await cold.getMcpRuntimeAuthorization({ owner, name: "alpha", access: bobAccess })).toBeNull();
          const manage = createMcpRegistryAccess({ principal: alice, owner, authority: "tenant_admin", access: "manage" });
          const registration = await cold.getMcpRegistration({ owner, name: "alpha", access: manage });
          expect(registration?.slot).toMatchObject({ owner, state: "enabled", currentVersionId: versionId, revision: 1 });
          expect(registration?.version?.clientSecretCommitmentSha256).toMatch(/^[0-9a-f]{64}$/);
          peer!.assertHealthy(); checkDeadline(); bodyPassed = true;
        }
      } catch (error) { failures.push(error); }
      finally {
        if (cold) { coldUncertain = true; try { await cold.close(); cold = undefined; coldUncertain = false; } catch (error) { failures.push(error); } }
        vi.unstubAllEnvs();
        if (redis) {
          try {
            if (bodyPassed && failures.length === 0 && servicesClosed && !coldUncertain && namespaceOwned) {
              checkDeadline(); const keys = await scopedKeys(redis, prefix);
              for (let index = 0; index < keys.length; index += 100) await redis.unlink(...keys.slice(index, index + 100));
              if ((await scopedKeys(redis, prefix)).length) throw new Error("OAuth owned Redis namespace not cleared");
            }
          } catch (error) { failures.push(error); }
          try { await redis.quit(); } catch (error) { redis.disconnect(); failures.push(error); }
        }
        if (admin) {
          try {
            if (created) {
              if (!bodyPassed || failures.length || !servicesClosed || coldUncertain || cold) throw new Error(`OAuth owned evidence retained: ${database}; ${prefix}; scratch=${scratch ?? "not-created"}`);
              checkDeadline();
              const [same] = await admin.query<RowDataPacket[]>({ sql: "SELECT @@server_uuid AS server_uuid", timeout: 5_000 });
              if (String(same[0]?.server_uuid) !== serverUuid) throw new Error("OAuth fixture database server identity changed");
              const [connections] = await admin.query<RowDataPacket[]>({ sql: "SELECT ID FROM information_schema.PROCESSLIST WHERE DB=?", timeout: 5_000 }, [database]);
              const [transactions] = await admin.query<RowDataPacket[]>({ sql: "SELECT t.TRX_ID FROM information_schema.INNODB_TRX t JOIN information_schema.PROCESSLIST p ON p.ID=t.TRX_MYSQL_THREAD_ID WHERE p.DB=?", timeout: 5_000 }, [database]);
              const [locks] = await admin.query<RowDataPacket[]>({ sql: "SELECT OWNER_THREAD_ID FROM performance_schema.metadata_locks WHERE OBJECT_SCHEMA=?", timeout: 5_000 }, [database]);
              if (connections.length || transactions.length || locks.length || !/^agent_service_mcp_oauth_test_[0-9a-f]{24}$/.test(database)) throw new Error("OAuth owned database remains referenced; retain evidence");
              if (!scratch || !/^agent-service-mcp-oauth-[A-Za-z0-9]+$/.test(basename(scratch))) throw new Error("OAuth scratch ownership unproven");
              const metadata = await lstat(scratch);
              if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(dirname(scratch)) !== await realpath(tmpdir())) throw new Error("OAuth scratch is not an exact owned local directory");
              checkDeadline(); await rm(scratch, { recursive: true, force: true }); scratch = undefined;
              checkDeadline(); await admin.query({ sql: `DROP DATABASE \`${database}\``, timeout: 5_000 }); created = false;
            } else if (createAttempted) throw new Error(`OAuth CREATE outcome uncertain; retain if present: ${database}`);
          } catch (error) { failures.push(error); }
          try { await admin.end(); } catch (error) { failures.push(error); }
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "OAuth main vertical or owned-resource cleanup failed");
    }, 60_000);
  });
} else {
  describe("registered OAuth real router/two-runner/MySQL/Redis callback", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 with loopback MYSQL_TEST_URL and REDIS_TEST_URL", () => {});
  });
}
