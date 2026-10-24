import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, open, lstat, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { request as httpRequest, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MysqlSessionStore, createMcpRegistryAccess } from "@agent-service/store";
import { AgentDefinition, Approval, Capabilities, CreateApiKeyResponse, Item, MANAGED_MCP_DCR_V1,
  McpAuthorizationBeginResponse, McpAuthorizationStatusResponse, McpDynamicClientStatusResponse,
  McpRegistrationResponse, Session, ToolListResponse, Turn } from "@agent-service/protocol";
import { FakeVendor } from "@agent-service/testkit";
import { startRouter } from "../../agent-router/src/main.js";
import { startRunner } from "../src/main.js";
import { McpDcrPeer } from "./fixtures/mcp-dcr-peer.js";
import { prepareMysqlRuntimeFixture, witnessAbsentMysqlFixtureDatabase } from "../../../test/fixtures/mysql-runtime.mjs";
import { createSourceAuthorityExecutor } from "./fixtures/mysql-authority.js";

const alice = { tenantId: "t_mcp_dcr_main", userId: "alice" }, bob = { ...alice, userId: "bob" };
const signals = ["SIGTERM", "SIGINT"] as const;
function listeners() { return new Map(signals.map(signal => [signal, process.listeners(signal)])); }
function bases(): { mysql: URL; redis: URL } {
  const sqlRaw = process.env.MYSQL_TEST_URL, redisRaw = process.env.REDIS_TEST_URL;
  if (!sqlRaw || !redisRaw) throw new Error("DCR main fixture needs explicit MYSQL_TEST_URL and REDIS_TEST_URL");
  let sql: URL, redis: URL, database: string;
  try { sql = new URL(sqlRaw); redis = new URL(redisRaw); database = decodeURIComponent(sql.pathname.slice(1)); }
  catch { throw new Error("DCR main fixture URLs invalid"); }
  const local = (url: URL) => ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && !url.search && !url.hash;
  if (sql.protocol !== "mysql:" || !local(sql) || !sql.username || !/^[A-Za-z0-9_]+$/.test(database) || !/(?:^|_)test(?:$|_)/i.test(database)
    || redis.protocol !== "redis:" || !local(redis) || !/^\/(?:[0-9]|1[0-5])$/.test(redis.pathname)) throw new Error("DCR main fixture requires explicit loopback test namespaces");
  return { mysql: sql, redis };
}
function databaseUrl(base: URL, database: string): string { const url = new URL(base); url.pathname = `/${database}`; return url.toString(); }
async function keys(redis: Redis, prefix: string): Promise<string[]> {
  const found = new Set<string>(); let cursor = "0", rounds = 0;
  do { const page = await redis.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 100); cursor = page[0];
    for (const key of page[1]) { if (!key.startsWith(`${prefix}:`)) throw new Error("DCR Redis ownership rejected"); found.add(key); }
    if (++rounds > 100 || found.size > 2000) throw new Error("DCR Redis scan bound exceeded");
  } while (cursor !== "0"); return [...found];
}
async function port(): Promise<number> {
  const server = createServer(); await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("DCR port ownership unavailable");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); return address.port;
}
async function listeningUrl(server: HttpServer): Promise<string> {
  if (!server.listening) await new Promise<void>((resolve, reject) => {
    const ready = () => { server.off("error", failed); resolve(); }, failed = () => { server.off("listening", ready); reject(new Error("DCR listener unavailable")); };
    server.once("listening", ready); server.once("error", failed);
  });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("DCR listener unavailable"); return `http://127.0.0.1:${address.port}`;
}
async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, label: string, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const deadline = performance.now() + 10_000;
  do {
    signal?.throwIfAborted();
    const result = await read(); signal?.throwIfAborted();
    if (result !== undefined) return result;
    await new Promise(resolve => setTimeout(resolve, 10)); signal?.throwIfAborted();
  } while (performance.now() < deadline);
  throw new Error(`DCR vertical fixed observation expired: ${label}`);
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("DCR explicit three-scope real router/two-main-runner/restricted MySQL/Redis vertical", () => {
    const suffix = randomBytes(12).toString("hex"), database = `agent_service_mcp_dcr_main_test_${suffix}`, prefix = `agent_service_mcp_dcr_main_test_${suffix}`;
    const initial = listeners(), startupTasks: Promise<unknown>[] = [], nativeTasks = new Set<Promise<unknown>>();
    let approvalCaseWork: Promise<void> | undefined;
    type ApprovalDiagnosticEvent = "phase" | "signal-observed" | "body-fulfilled" | "body-rejected" | "join-started" | "join-settled";
    let approvalCaseDiagnostic: ((event: ApprovalDiagnosticEvent) => void) | undefined;
    let routerListeners: ReturnType<typeof listeners> = new Map(), failed = false, startupUncertain = false, created = false, createAttempted = false;
    let namespaceOwned = false, mysqlUrl = "", serverUuid = "", scratch: string | undefined;
    let admin: Connection | undefined, redis: Redis | undefined, cold: MysqlSessionStore | undefined;
    let runtime: Awaited<ReturnType<typeof prepareMysqlRuntimeFixture>> | undefined;
    let first: Awaited<ReturnType<typeof startRunner>> | undefined, second: Awaited<ReturnType<typeof startRunner>> | undefined;
    let router: Awaited<ReturnType<typeof startRouter>> | undefined, peer: McpDcrPeer | undefined, vendor: FakeVendor | undefined;
    let exit: { mockRestore(): void } | undefined;
    let firstUrl = "", secondUrl = "", routerUrl = "", bootstrapKey = "", runtimeKey = "", operator = "", unknownVersion = "";
    const installed = new Map<string, ReturnType<typeof McpRegistrationResponse.parse>>();
    const authorizationStates = new Map<string, string>();
    const owner = { scope: "tenant" as const, tenantId: alice.tenantId, userId: null };
    const manage = () => createMcpRegistryAccess({ owner, principal: alice, authority: "tenant_admin", access: "manage" });
    const owned = <T>(task: Promise<T>): Promise<T> => { nativeTasks.add(task); void task.then(() => nativeTasks.delete(task), () => nativeTasks.delete(task)); return task; };
    const json = async (path: string, options: { method?: string; body?: unknown; key?: string; user?: string; idempotency?: string; base?: string; signal?: AbortSignal } = {}) => {
      options.signal?.throwIfAborted();
      const response = await owned(fetch(`${options.base ?? routerUrl}${path}`, { method: options.method ?? "GET", headers: {
        authorization: `Bearer ${options.key ?? bootstrapKey}`, "x-user-id": options.user ?? alice.userId, "content-type": "application/json",
        ...(options.idempotency ? { "idempotency-key": options.idempotency } : {}),
      }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) }));
      const wire = await owned(response.text());
      options.signal?.throwIfAborted(); expect(peer!.containsSensitive(wire)).toBe(false);
      return { status: response.status, body: JSON.parse(wire) as unknown, wire };
    };
    // A caller-side rejection alone is insufficient: separately join ClientRequest
    // close, its actual socket close, the AS socket and its held handler.
    const observeNative = async <T>(task: Promise<T>, label: string, signal: AbortSignal): Promise<T> => {
      signal.throwIfAborted(); let timer: ReturnType<typeof setTimeout> | undefined, aborted: (() => void) | undefined;
      try {
        return await Promise.race([task, new Promise<never>((_resolve, reject) => {
          aborted = () => reject(new Error(`DCR native observation cancelled: ${label}`));
          signal.addEventListener("abort", aborted, { once: true });
          timer = setTimeout(() => reject(new Error(`DCR native fixed observation expired: ${label}`)), 10_000);
          if (signal.aborted) aborted();
        })]);
      } finally { if (timer) clearTimeout(timer); if (aborted) signal.removeEventListener("abort", aborted); }
    };
    type NativeRegistrationResult = { kind: "response"; status: number }
      | { kind: "error"; name: string; code: string | null };
    const nativeRegistration = (name: string, value: ReturnType<typeof McpRegistrationResponse.parse>, idempotency: string, signal: AbortSignal) => {
      let complete!: (value: NativeRegistrationResult) => void, reject!: (error: Error) => void;
      const result = new Promise<NativeRegistrationResult>((yes, no) => { complete = yes; reject = no; });
      const body = Buffer.from(JSON.stringify({ scope: "tenant", configVersionId: value.version!.configVersionId, expectedRevision: value.registration.revision }));
      const request = httpRequest(`${routerUrl}/v1/mcp-servers/${name}/oauth/client/register`, { method: "POST", agent: false, signal,
        headers: { authorization: `Bearer ${bootstrapKey}`, "x-user-id": alice.userId, "content-type": "application/json",
          "content-length": body.length, "idempotency-key": idempotency } }, incoming => {
        const chunks: Buffer[] = []; let bytes = 0;
        incoming.on("data", part => { const chunk = Buffer.from(part); bytes += chunk.length;
          if (bytes > 65_536) { reject(new Error("DCR native caller response bound exceeded")); incoming.destroy(); request.destroy(); }
          else chunks.push(chunk);
        });
        incoming.once("error", () => reject(new Error("DCR native caller response interrupted")));
        incoming.once("end", () => {
          try { const wire = Buffer.concat(chunks).toString("utf8");
            if (peer!.containsSensitive(wire)) throw new Error("DCR native caller received sensitive content");
            JSON.parse(wire); complete({ kind: "response", status: incoming.statusCode ?? 0 });
          } catch { reject(new Error("DCR native caller response invalid")); }
        });
      });
      let sawSocket = false, socketDone!: () => void;
      const socketClosed = owned(new Promise<void>(resolve => { socketDone = resolve; }));
      const requestClosed = owned(new Promise<void>(resolve => { request.once("close", () => { if (!sawSocket) socketDone(); resolve(); }); }));
      request.once("socket", socket => { sawSocket = true; socket.once("close", socketDone); if (socket.closed) socketDone(); });
      request.once("error", error => { const value = error as Error & { code?: unknown };
        complete({ kind: "error", name: value.name, code: typeof value.code === "string" ? value.code : null }); });
      // Keep the socket limit within the existing ten-second observation limit.
      request.setTimeout(10_000, () => request.destroy(new Error("DCR native caller deadline"))); request.end(body);
      return { result: owned(result), requestClosed, socketClosed, destroy: () => request.destroy() };
    };
    // A new restricted pool runs the ordinary verify-only strict startup and reads
    // typed/JSON SQL projection. Only content-free fields and a full-record digest escape.
    const coldReceipt = (name: string, configVersionId: string) => owned((async () => {
      if (!runtime) throw new Error("DCR cold runtime unavailable");
      const store = await MysqlSessionStore.connect({ ...runtime.runtimeStoreOptions, connectionLimit: 2 });
      try {
        const operation = await store.getMcpDynamicClient({ owner, access: manage(), name, configVersionId });
        if (!operation) throw new Error("DCR cold operation missing");
        return { operationId: operation.operationId, state: operation.state, configVersionId: operation.configVersionId,
          registrationRevision: operation.registrationRevision, sent: operation.sentAtMs !== null, completed: operation.completedAtMs !== null,
          hasClientId: operation.clientId !== null, hasResponse: operation.responseSha256 !== null,
          hasSecretCommitment: operation.clientSecretCommitmentSha256 !== null, hasSecretExpiry: operation.clientSecretExpiresAtMs !== null,
          hasMaterial: operation.clientMaterial !== null,
          recordSha256: createHash("sha256").update(JSON.stringify(operation)).digest("hex") };
      } finally { await store.close(); }
    })());
    const install = async (scope: "platform" | "tenant" | "user", name: string, method: "none" | "client_secret_basic", expectedRevision = 0) => {
      const platform = scope === "platform", result = await json(platform ? "/v1/platform/mcp-servers" : "/v1/mcp-servers", { method: "POST",
        key: platform ? operator : scope === "user" ? runtimeKey : bootstrapKey, idempotency: `install-${scope}-${name}-${expectedRevision}`,
        body: { ...(platform ? {} : { scope }), name, expectedRevision, config: { endpoint: peer!.endpoint, description: "Local explicit DCR fixture", protocolVersion: "2026-07-28",
          authentication: { kind: "oauth_dynamic", issuer: peer!.issuer, clientAuthentication: method, scopes: ["echo"] } } } });
      expect(result.status).toBe(201); const value = McpRegistrationResponse.parse(result.body); installed.set(`${scope}:${name}`, value); return value;
    };
    const register = (scope: "platform" | "tenant" | "user", name: string, value: ReturnType<typeof McpRegistrationResponse.parse>, base?: string, idempotency = `register-${scope}-${name}-${value.registration.revision}`) =>
      json(`/v1/${scope === "platform" ? "platform/" : ""}mcp-servers/${name}/oauth/client/register`, { method: "POST", base,
        key: scope === "platform" ? operator : scope === "user" ? runtimeKey : bootstrapKey, idempotency,
        body: { ...(scope === "platform" ? {} : { scope }), configVersionId: value.version!.configVersionId, expectedRevision: value.registration.revision } });
    const authorize = async (scope: "platform" | "tenant" | "user", name: string, user: string) => {
      const pending = await json(`/v1/mcp-servers/${name}/oauth/begin`, { key: runtimeKey, user, method: "POST", idempotency: `begin-${scope}-${name}-${user}`, body: { scope } });
      expect(pending.status).toBe(200); const begin = McpAuthorizationBeginResponse.parse(pending.body);
      authorizationStates.set(`${scope}:${name}:${user}`, new URL(begin.authorizationUrl).searchParams.get("state")!);
      const browser = await owned(fetch(begin.authorizationUrl, { redirect: "manual", signal: AbortSignal.timeout(10_000) }));
      expect(browser.status).toBe(302); const callback = browser.headers.get("location")!; await browser.body?.cancel();
      const completed = await owned(fetch(callback, { headers: { "x-user-id": user === alice.userId ? bob.userId : alice.userId }, redirect: "manual", signal: AbortSignal.timeout(10_000) }));
      const wire = await owned(completed.text()); expect(completed.status).toBe(200); expect(completed.headers.get("cache-control")).toBe("no-store");
      expect(peer!.containsSensitive(wire)).toBe(false); expect(wire).toBe("<!doctype html><title>MCP authorization</title><p>Authorization completed. You can close this page.</p>"); return begin;
    };
    beforeAll(async () => {
      try {
        const base = bases(); mysqlUrl = databaseUrl(base.mysql, database);
        vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("MCP_ALLOW_LOOPBACK_FOR_TESTS", "1");
        exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
        admin = await mysql.createConnection({ uri: databaseUrl(base.mysql, "mysql"), connectTimeout: 5000 });
        const [identity] = await admin.query<RowDataPacket[]>({ sql: "SELECT @@server_uuid AS server_uuid", timeout: 5000 }); serverUuid = String(identity[0]?.server_uuid);
        if (!/^[0-9a-f-]{36}$/i.test(serverUuid)) throw new Error("DCR MySQL identity unavailable");
        redis = new Redis(base.redis.toString(), { lazyConnect: true, enableOfflineQueue: false, connectTimeout: 2000, commandTimeout: 2000, maxRetriesPerRequest: 1 });
        redis.on("error", () => {}); await redis.connect(); expect(await redis.ping()).toBe("PONG");
        if ((await keys(redis, prefix)).length) throw new Error("DCR namespace already exists"); namespaceOwned = true;
        const operation = new AbortController(), timer = setTimeout(() => operation.abort(), 110_000);
        try {
          const witness = await witnessAbsentMysqlFixtureDatabase({ operatorUrl: mysqlUrl, applicationDatabase: database, operationAbortSignal: operation.signal });
          createAttempted = true; await admin.query({ sql: `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`, timeout: 5000 }); created = true;
          runtime = await prepareMysqlRuntimeFixture(witness, {
            schemaExecutor: options => MysqlSessionStore.runSchemaOperation(options),
            authorityExecutor: createSourceAuthorityExecutor(),
          });
          await runtime.assertReusable(mysqlUrl);
        } finally { clearTimeout(timer); }
        scratch = await mkdtemp(join(tmpdir(), "agent-service-mcp-dcr-main-"));
        const ports = new Set<number>(); while (ports.size < 3) ports.add(await port()); const [a, b, r] = [...ports] as [number, number, number];
        const callback = `http://127.0.0.1:${r}/v1/mcp/oauth/callback`; peer = new McpDcrPeer(callback); await peer.start();
        const providerKey = "local-dcr-provider-key"; vendor = new FakeVendor({ cacheDialect: "deepseek", expectApiKey: providerKey }); const vendorUrl = await vendor.start();
        const keyFile = join(scratch, "mcp-credential-key"), key = randomBytes(32); let file: Awaited<ReturnType<typeof open>> | undefined;
        try { file = await open(keyFile, "wx", 0o600); await file.writeFile(key); await file.sync(); } finally { key.fill(0); await file?.close(); }
        const internal = randomBytes(24).toString("base64url"); bootstrapKey = randomBytes(24).toString("base64url"); operator = randomBytes(32).toString("base64url");
        const environment: NodeJS.ProcessEnv = { NODE_ENV: "test", STORE: "mysql", ...runtime!.runtimeEnv, SECRETS_MASTER_KEY: randomBytes(32).toString("hex"), INTERNAL_ROUTER_TOKEN: internal,
          PLATFORM_PROVIDER: "deepseek", API_KEY: providerKey, API_BASE_URL: vendorUrl, DEFAULT_MODEL: "deepseek-chat", BLOB_STORE: "filesystem", BLOB_FILESYSTEM_SINGLE_RUNNER: "1",
          MCP_REGISTRY_ENABLED: "1", MCP_ALLOW_LOOPBACK_FOR_TESTS: "1", MCP_TIMEOUT_MS: "15000", MCP_REGISTRY_CREDENTIAL_KEY_FILE: keyFile,
          MCP_REGISTRY_CREDENTIAL_KEY_ID: "dcr-main-key-v1", MCP_REGISTRY_OAUTH_CALLBACK_URL: callback, REDIS_URL: base.redis.toString(), REDIS_PREFIX: prefix,
          REDIS_NAMESPACE_ID: `mcp_dcr_main_${suffix}`, ERASURE_ROUTER_URL: `http://127.0.0.1:${r}`, LEASE_TTL_MS: "10000", LEASE_HOLD_MS: "20", APPROVAL_TTL_MS: "15000", SSE_HEARTBEAT_MS: "60000" };
        startupUncertain = true;
        const firstStart = startRunner({ ...environment, RUNNER_HOST: "127.0.0.1", RUNNER_PORT: String(a), RUNNER_ADDR: `127.0.0.1:${a}`, RUNNER_ID: `dcr-first-${suffix}`,
          BLOB_DIR: join(scratch, "first-blobs"), BOOTSTRAP_API_KEY: bootstrapKey, BOOTSTRAP_TENANT_ID: alice.tenantId }); startupTasks.push(firstStart); first = await firstStart; startupUncertain = false;
        firstUrl = await listeningUrl(first.server as HttpServer); startupUncertain = true;
        const secondStart = startRunner({ ...environment, RUNNER_HOST: "127.0.0.1", RUNNER_PORT: String(b), RUNNER_ADDR: `127.0.0.1:${b}`, RUNNER_ID: `dcr-second-${suffix}`, BLOB_DIR: join(scratch, "second-blobs") });
        startupTasks.push(secondStart); second = await secondStart; startupUncertain = false; secondUrl = await listeningUrl(second.server as HttpServer);
        const before = listeners(); startupUncertain = true;
        const routerStart = startRouter({ NODE_ENV: "test", ROUTER_HOST: "127.0.0.1", ROUTER_PORT: String(r), RUNNERS: `${firstUrl},${secondUrl}`, INTERNAL_ROUTER_TOKEN: internal,
          HEALTH_INTERVAL_MS: "1000", SHUTDOWN_GRACE_MS: "0", MCP_REGISTRY_ENABLED: "1", MCP_REGISTRY_OPERATOR_TOKEN: operator, MCP_ALLOW_LOOPBACK_FOR_TESTS: "1",
          MCP_REGISTRY_CREDENTIAL_KEY_ID: "dcr-main-key-v1", MCP_REGISTRY_OAUTH_CALLBACK_URL: callback, REDIS_URL: base.redis.toString(), REDIS_PREFIX: prefix, REDIS_NAMESPACE_ID: `mcp_dcr_main_${suffix}` });
        startupTasks.push(routerStart); router = await routerStart; startupUncertain = false; routerUrl = await listeningUrl(router.server as HttpServer);
        routerListeners = new Map(signals.map(signal => [signal, process.listeners(signal).filter(listener => !before.get(signal)!.includes(listener))]));
        expect(router.registry.list()).toEqual([expect.objectContaining({ url: firstUrl, healthy: true }), expect.objectContaining({ url: secondUrl, healthy: true })]);
        for (const runner of [first, second]) for (const enabled of [runner.cfg.BLOB_CLEANUP_ENABLED, runner.cfg.ERASURE_WORKER_ENABLED,
          runner.cfg.TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED, runner.cfg.TENANT_PURGE_EXECUTION_WORKER_ENABLED, runner.cfg.TENANT_DATABASE_PURGE_WORKER_ENABLED,
          runner.cfg.TENANT_REDIS_PURGE_WORKER_ENABLED, runner.cfg.SESSION_USAGE_RETENTION_WORKER_ENABLED, runner.cfg.DATA_EXPORT_WORKER_ENABLED]) expect(enabled).toBe(false);
        const capabilities = await json("/v1/capabilities"); expect(capabilities.status).toBe(200); expect(Capabilities.parse(capabilities.body).features.mcpDynamicRegistration).toEqual([MANAGED_MCP_DCR_V1]);
        const reply = await json("/v1/tenant/api-keys", { method: "POST", body: { keyId: "dcr-main-runtime", scopes: ["runtime"] } });
        expect(reply.status).toBe(201); runtimeKey = CreateApiKeyResponse.parse(reply.body).key;
      } catch (error) { failed = true; throw error; }
    }, 120_000);
    afterEach(async ({ task }) => {
      const alreadyFailed = task.result?.state === "fail";
      if (alreadyFailed) failed = true;
      const work = approvalCaseWork;
      if (!work) return;
      const diagnostic = approvalCaseDiagnostic;
      try { diagnostic?.("join-started"); } catch { /* Diagnostic failure cannot replace the original result. */ }
      try { await work; }
      catch (error) { failed = true; if (!alreadyFailed) throw error; }
      finally {
        try { diagnostic?.("join-settled"); } catch { /* Diagnostic failure cannot replace the original result. */ }
        if (approvalCaseWork === work) { approvalCaseWork = undefined; approvalCaseDiagnostic = undefined; }
      }
    });

    it("uses operator, tenant admin and user self management to create independent public/basic config clients", async () => {
      for (const [scope, method] of [["platform", "none"], ["tenant", "client_secret_basic"], ["user", "none"]] as const) {
        const value = await install(scope, "shared", method), before = peer!.counts().registrations;
        const status = await json(`/v1/${scope === "platform" ? "platform/" : ""}mcp-servers/shared/oauth/client/status?${scope === "platform" ? "" : `scope=${scope}&`}configVersionId=${value.version!.configVersionId}`,
          { key: scope === "platform" ? operator : scope === "user" ? runtimeKey : bootstrapKey });
        expect(status.status).toBe(200); expect(McpDynamicClientStatusResponse.parse(status.body).registration.state).toBe("unregistered");
        const result = await register(scope, "shared", value); expect(result.status).toBe(200); expect(McpDynamicClientStatusResponse.parse(result.body).registration.state).toBe("ready");
        expect(peer!.counts().registrations).toBe(before + 1);
      }
      expect(peer!.counts().clients).toBe(3);
      const denied = await json("/v1/mcp-servers", { key: runtimeKey, method: "POST", idempotency: "tenant-as-runtime", body: { scope: "tenant", name: "forbidden", expectedRevision: 0,
        config: { endpoint: peer!.endpoint, description: "Denied", protocolVersion: "2026-07-28", authentication: { kind: "oauth_dynamic", issuer: peer!.issuer, clientAuthentication: "none", scopes: ["echo"] } } } });
      expect(denied.status).toBe(403); expect((await json("/v1/mcp-servers/shared?scope=user", { key: runtimeKey, user: bob.userId })).status).toBe(404); peer!.assertHealthy();
    });
    it("isolates two actual users' S256 states and bearer tokens and refreshes only the connected user", async () => {
      peer!.setNextTokenLifetimeSeconds(1); const a = await authorize("tenant", "shared", alice.userId);
      const bobBefore = await json("/v1/mcp-servers/shared/oauth/status?scope=tenant", { key: runtimeKey, user: bob.userId });
      expect(McpAuthorizationStatusResponse.parse(bobBefore.body).authorization).toBeNull();
      const beforeDenied = peer!.resourceTokenIdentities().length;
      expect((await json("/v1/mcp-servers/shared/tools?scope=tenant", { key: runtimeKey, user: bob.userId })).status).toBe(503);
      expect(peer!.resourceTokenIdentities()).toHaveLength(beforeDenied);
      const beforeAlice = peer!.resourceTokenIdentities().length;
      const tools = await json("/v1/mcp-servers/shared/tools?scope=tenant", { key: runtimeKey }); expect(tools.status).toBe(200);
      expect(ToolListResponse.parse(tools.body).data).toEqual([expect.objectContaining({ kind: "mcp", needsApproval: true })]); expect(peer!.counts().refreshes).toBe(1);
      const aliceIdentity = peer!.tokenIdentityForState(new URL(a.authorizationUrl).searchParams.get("state")!);
      expect(aliceIdentity.tokens.map(value => value.ordinal)).toEqual([1, 2]);
      const aliceWire = peer!.resourceTokenIdentities().slice(beforeAlice); expect(aliceWire.length).toBeGreaterThan(0);
      expect(aliceWire.every(value => value.authorizationFingerprint === aliceIdentity.authorizationFingerprint && value.tokenFingerprint === aliceIdentity.tokens.at(-1)!.tokenFingerprint)).toBe(true);
      peer!.setNextTokenLifetimeSeconds(1);
      const b = await authorize("tenant", "shared", bob.userId); expect(a.authorizationId).not.toBe(b.authorizationId);
      expect(new URL(a.authorizationUrl).searchParams.get("state") === new URL(b.authorizationUrl).searchParams.get("state")).toBe(false);
      const beforeBob = peer!.resourceTokenIdentities().length;
      expect((await json("/v1/mcp-servers/shared/tools?scope=tenant", { key: runtimeKey, user: bob.userId })).status).toBe(200);
      const bobIdentity = peer!.tokenIdentityForState(new URL(b.authorizationUrl).searchParams.get("state")!);
      expect(bobIdentity.tokens.map(value => value.ordinal)).toEqual([1, 2]); expect(bobIdentity.authorizationFingerprint).not.toBe(aliceIdentity.authorizationFingerprint);
      const bobWire = peer!.resourceTokenIdentities().slice(beforeBob); expect(bobWire.length).toBeGreaterThan(0);
      expect(bobWire.every(value => value.authorizationFingerprint === bobIdentity.authorizationFingerprint && value.tokenFingerprint === bobIdentity.tokens.at(-1)!.tokenFingerprint)).toBe(true);
      expect(peer!.counts()).toMatchObject({ exchanges: 2, refreshes: 2, rejected: 0 }); peer!.assertHealthy();
    });
    it("holds a real runtime tool behind mandatory approval even when the agent policy says never", async ({ signal }) => {
      const requestJson = json, observe = waitFor;
      type ApprovalPhase = "descriptor" | "agent" | "session" | "turn-start" | "approval-wait" | "approval-ready" | "approval-submit" | "approval-granted" | "completion-wait" | "complete";
      let phase: ApprovalPhase = "descriptor", userOrdinal: 0 | 1 | 2 = 0, signalObserved = false, startedAt: number | undefined;
      try { const now = performance.now(); if (Number.isFinite(now)) startedAt = now; } catch { /* Best-effort diagnostic only. */ }
      const diagnostic = (event: ApprovalDiagnosticEvent): void => {
        try {
          const now = performance.now();
          const elapsed = startedAt === undefined ? NaN : Math.floor(now - startedAt);
          const elapsedMs = Number.isSafeInteger(elapsed) && elapsed >= 0 ? elapsed : null;
          console.warn(JSON.stringify({ schema: "dcr-approval-case-phase-v1", event, phase, userOrdinal, elapsedMs, signalObserved, signalAborted: signal.aborted }));
        } catch { /* Clock, serialization and logger failure cannot alter the test. */ }
      };
      const mark = (next: ApprovalPhase): void => { try { phase = next; diagnostic("phase"); } catch { /* Best-effort diagnostic only. */ } };
      const onAbort = (): void => { try { if (!signalObserved) { signalObserved = true; diagnostic("signal-observed"); } } catch { /* Best-effort diagnostic only. */ } };
      approvalCaseDiagnostic = diagnostic;
      try { signal.addEventListener("abort", onAbort, { once: true }); if (signal.aborted) onAbort(); } catch { /* Best-effort diagnostic only. */ }
      const work = (async () => {
        const json = (path: Parameters<typeof requestJson>[0], options: Parameters<typeof requestJson>[1] = {}) => requestJson(path, { ...options, signal });
        const waitFor = <T>(read: () => T | undefined | Promise<T | undefined>, label: string): Promise<T> => observe(read, label, signal);
        mark("descriptor");
        const descriptors = await json("/v1/mcp-servers/shared/tools?scope=tenant", { key: runtimeKey }); const toolName = ToolListResponse.parse(descriptors.body).data[0]!.name;
        mark("agent");
        const agentReply = await json("/v1/agents", { method: "POST", body: { name: "DCR approval fixture", instructions: "Use the mounted MCP tool and answer from its result.",
          model: { provider: "deepseek", model: "deepseek-chat" }, tools: [], mcpRegistrations: [{ scope: "tenant", name: "shared" }], approvalPolicy: "never",
          limits: { maxSteps: 4, maxToolCalls: 2, maxWallClockMs: 15000 } } });
        expect(agentReply.status).toBe(201); const agent = AgentDefinition.parse(agentReply.body);
        for (const user of [alice.userId, bob.userId]) {
        const priorCalls = peer!.mcp.calls.length, priorModelRequests = vendor!.requests.length, priorResources = peer!.resourceTokenIdentities().length;
        vendor!.script({ toolCalls: [{ id: `dcr-real-approved-call-${user}`, name: toolName, args: JSON.stringify({ text: "dcr-approved" }), argChunks: 3 }] }, { text: "The DCR MCP result reached the model." });
        userOrdinal = userOrdinal === 0 ? 1 : 2; mark("session");
        const created = await json("/v1/sessions", { key: runtimeKey, user, method: "POST", body: { agentId: agent.id } }); expect(created.status).toBe(201); const session = Session.parse(created.body);
        expect(session.userId).toBe(user);
        mark("turn-start");
        const begun = await json(`/v1/sessions/${session.id}/turns`, { key: runtimeKey, user, method: "POST", idempotency: `dcr-approved-turn-${user}`, body: { input: [{ type: "text", text: "Call the MCP echo tool." }], stream: false } });
        expect(begun.status).toBe(202); const turnId = Turn.parse((begun.body as { turn: unknown }).turn).id;
        mark("approval-wait");
        const approvalId = await waitFor(async () => {
          const result = await json(`/v1/sessions/${session.id}/resume`, { key: runtimeKey, user, method: "POST" }); expect(result.status).toBe(200);
          return (result.body as { pendingApprovalIds: string[] }).pendingApprovalIds[0];
        }, "mandatory approval");
        expect(peer!.mcp.calls).toHaveLength(priorCalls); expect(vendor!.requests).toHaveLength(priorModelRequests + 1);
        mark("approval-ready");
        const before = await json(`/v1/sessions/${session.id}/items`, { key: runtimeKey, user });
        const call = (before.body as { data: unknown[] }).data.map(value => Item.parse(value)).find(value => value.type === "toolCall");
        expect(call).toMatchObject({ kind: "mcp", name: toolName, status: "inProgress" }); expect(call?.startedAtMs).toBeUndefined();
        mark("approval-submit");
        const approved = await json(`/v1/sessions/${session.id}/approvals/${approvalId}`, { key: runtimeKey, user, method: "POST", body: { decision: "accept" } });
        expect(approved.status).toBe(200); expect(Approval.parse(approved.body)).toMatchObject({ status: "resolved", decision: "accept" });
        mark("approval-granted"); mark("completion-wait");
        const turn = await waitFor(async () => { const result = await json(`/v1/sessions/${session.id}/turns/${turnId}`, { key: runtimeKey, user });
          expect(result.status).toBe(200); const value = Turn.parse(result.body); return value.status === "inProgress" ? undefined : value; }, "completed approved turn");
        expect(turn).toMatchObject({ status: "completed", steps: 2, toolCalls: 1 }); expect(peer!.mcp.calls).toHaveLength(priorCalls + 1); expect(vendor!.requests).toHaveLength(priorModelRequests + 2);
        expect(JSON.stringify(vendor!.requests.at(-1)!.body.messages)).toContain("echo:dcr-approved");
        const identity = peer!.tokenIdentityForState(authorizationStates.get(`tenant:shared:${user}`)!);
        const observed = peer!.resourceTokenIdentities().slice(priorResources); expect(observed.length).toBeGreaterThan(0);
        expect(observed.every(value => value.authorizationFingerprint === identity.authorizationFingerprint && value.tokenFingerprint === identity.tokens.at(-1)!.tokenFingerprint)).toBe(true);
        peer!.assertHealthy();
        mark("complete");
        }
      })();
      approvalCaseWork = work;
      try { await work; diagnostic("body-fulfilled"); }
      catch (error) { diagnostic("body-rejected"); throw error; }
      finally { try { signal.removeEventListener("abort", onAbort); } catch { /* Preserve the original outcome, including undefined. */ } }
    });
    it("single-flights one native DCR across both actual main runners and replays the exact operation", async () => {
      const value = await install("tenant", "single", "none"), hold = peer!.holdNextRegistration(), before = peer!.counts().registrations;
      const firstRequest = register("tenant", "single", value, firstUrl);
      try {
        await Promise.race([hold.entered, firstRequest.then(() => { throw new Error("DCR first runner did not reach held registration"); })]);
        const other = await register("tenant", "single", value, secondUrl); expect(other.status).toBe(200);
        expect(McpDynamicClientStatusResponse.parse(other.body).registration.state).toBe("sending"); expect(peer!.counts().registrations).toBe(before + 1);
      } finally { hold.release(); }
      const result = await firstRequest; expect(result.status).toBe(200); expect(McpDynamicClientStatusResponse.parse(result.body).registration.state).toBe("ready");
      expect((await register("tenant", "single", value, secondUrl)).body).toEqual(result.body); expect(peer!.counts().registrations).toBe(before + 1);
    });
    it("creates a new client for a new immutable config and retains unknown without native retry or fake remote revocation", async () => {
      const prior = installed.get("tenant:single")!, before = peer!.counts().registrations, next = await install("tenant", "single", "none", 1);
      expect(next.version!.configVersionId).not.toBe(prior.version!.configVersionId); expect((await register("tenant", "single", next)).status).toBe(200);
      expect(peer!.counts().registrations).toBe(before + 1); expect((await register("tenant", "single", prior)).status).toBe(409);
      const unknown = await install("tenant", "unknown", "client_secret_basic"); unknownVersion = unknown.version!.configVersionId; peer!.loseNextRegistrationResponse();
      const result = await register("tenant", "unknown", unknown); expect(result.status).toBe(200);
      expect(McpDynamicClientStatusResponse.parse(result.body).registration).toMatchObject({ state: "outcome_unknown", manualReviewRequired: true, remoteRevocationSupported: false });
      const nativeCount = peer!.counts().registrations; expect((await register("tenant", "unknown", unknown, secondUrl)).body).toEqual(result.body);
      expect((await register("tenant", "unknown", unknown, secondUrl, "unknown-new-key")).status).toBe(409); expect(peer!.counts().registrations).toBe(nativeCount);
      const read = await first!.store.getMcpDynamicClient({ owner, access: manage(), name: "unknown", configVersionId: unknownVersion });
      expect(read).toMatchObject({ state: "outcome_unknown", clientId: null, clientMaterial: null }); peer!.assertHealthy();
    });
    it("cancels a real router caller after native AS creation, joins both sockets and cold-verifies permanent unknown", async context => {
      const name = "caller-cancel", value = await install("tenant", name, "client_secret_basic"), before = peer!.counts();
      const hold = peer!.holdNextRegistration(), caller = new AbortController();
      const request = nativeRegistration(name, value, "caller-cancel-register", AbortSignal.any([caller.signal, context.signal]));
      const abort = () => { caller.abort(); request.destroy(); hold.release(); };
      context.signal.addEventListener("abort", abort, { once: true });
      try {
        await observeNative(Promise.race([hold.entered, request.result.then(() => { throw new Error("DCR cancelled caller ended before AS receipt"); })]), "cancel AS receipt", context.signal);
        expect(peer!.counts().registrations).toBe(before.registrations + 1); expect(peer!.counts().clients).toBe(before.clients + 1);
        caller.abort();
        expect(await observeNative(request.result, "caller AbortSignal result", context.signal)).toEqual({ kind: "error", name: "AbortError", code: "ABORT_ERR" });
        await observeNative(Promise.all([request.requestClosed, request.socketClosed, owned(hold.nativeClosed), owned(hold.responseSettled)]), "caller and AS native close before release", context.signal);
        // This must be true BEFORE release: a timeout or AS response cannot be
        // mistaken for caller cancellation reaching the registration socket.
        expect(hold.responseTerminal()).toBe("close"); expect(hold.response201WasFinished()).toBe(false);
        hold.release(); await observeNative(owned(hold.handlerSettled), "cancelled AS handler joined", context.signal);
        const original = await waitFor(async () => { const receipt = await coldReceipt(name, value.version!.configVersionId);
          return receipt.state === "outcome_unknown" ? receipt : undefined; }, "cancel cold unknown");
        expect(original).toMatchObject({ state: "outcome_unknown", sent: true, completed: true,
          hasClientId: false, hasResponse: false, hasSecretCommitment: false, hasSecretExpiry: false, hasMaterial: false });
        const exact = await register("tenant", name, value, secondUrl, "caller-cancel-register"); expect(exact.status).toBe(200);
        expect(McpDynamicClientStatusResponse.parse(exact.body).registration).toMatchObject({ state: "outcome_unknown", manualReviewRequired: true, remoteRevocationSupported: false });
        expect((await register("tenant", name, value, firstUrl, "caller-cancel-new-key")).status).toBe(409);
        expect(await coldReceipt(name, value.version!.configVersionId)).toEqual(original);
        expect(peer!.counts().registrations).toBe(before.registrations + 1); expect(peer!.counts().clients).toBe(before.clients + 1); peer!.assertHealthy();
      } finally {
        context.signal.removeEventListener("abort", abort); caller.abort(); request.destroy(); hold.release();
        // Discard only a gate which never acquired a native request. Do not
        // fabricate close events for a consumed gate or leave it for the next case.
        const unused = hold.discardUnentered();
        await Promise.allSettled([request.result, request.requestClosed, request.socketClosed, owned(hold.responseSettled),
          ...(unused ? [] : [owned(hold.nativeClosed), owned(hold.handlerSettled)])]);
      }
    });
    it("disables after native AS receipt and rejects a late valid success without publishing SQL client material or upgrading history", async context => {
      const name = "late-disable", value = await install("tenant", name, "client_secret_basic"), before = peer!.counts();
      const hold = peer!.holdNextRegistration(), firstRequest = register("tenant", name, value, firstUrl, "late-disable-register");
      const release = () => hold.release(); context.signal.addEventListener("abort", release, { once: true });
      try {
        await observeNative(Promise.race([hold.entered, firstRequest.then(() => { throw new Error("DCR late result ended before AS receipt"); })]), "late AS receipt", context.signal);
        expect(peer!.counts().registrations).toBe(before.registrations + 1); expect(peer!.counts().clients).toBe(before.clients + 1);
        // A distinct actual main runner performs the real management CAS while
        // the first runner owns an already-dispatched create at the native AS.
        const disabled = await json(`/v1/mcp-servers/${name}/state`, { base: secondUrl, method: "POST", idempotency: "late-disable-state",
          body: { scope: "tenant", state: "disabled", expectedRevision: value.registration.revision } });
        expect(disabled.status).toBe(200);
        const fenced = await coldReceipt(name, value.version!.configVersionId);
        expect(fenced).toMatchObject({ state: "outcome_unknown", sent: true, completed: true,
          hasClientId: false, hasResponse: false, hasSecretCommitment: false, hasSecretExpiry: false, hasMaterial: false });
        hold.release();
        // Keep the strong late-result oracle: the AS's valid basic-client 201
        // must finish on its real response, rather than merely be constructed
        // after a disconnected socket. A prior safe native abort needs its own
        // evidence and does not prove this late successful-response case.
        await observeNative(owned(hold.responseSettled), "late AS response terminal", context.signal);
        // A closed response settles cleanup, but cannot satisfy the success oracle.
        expect(hold.responseTerminal()).toBe("finish"); expect(hold.response201WasFinished()).toBe(true);
        const result = await firstRequest; expect(result.status).toBe(200);
        expect(McpDynamicClientStatusResponse.parse(result.body).registration).toMatchObject({ state: "outcome_unknown", manualReviewRequired: true, remoteRevocationSupported: false });
        await observeNative(Promise.all([owned(hold.nativeClosed), owned(hold.handlerSettled)]), "late AS socket and handler joined", context.signal);
        expect(hold.response201WasFinished()).toBe(true);
        expect(await coldReceipt(name, value.version!.configVersionId)).toEqual(fenced);
        const history = await json(`/v1/mcp-servers/${name}/oauth/client/status?scope=tenant&configVersionId=${value.version!.configVersionId}`);
        expect(history.status).toBe(200); expect(McpDynamicClientStatusResponse.parse(history.body).registration.state).toBe("outcome_unknown");
        const enabled = await json(`/v1/mcp-servers/${name}/state`, { method: "POST", idempotency: "late-enable-state",
          body: { scope: "tenant", state: "enabled", expectedRevision: value.registration.revision + 1 } });
        expect(enabled.status).toBe(200);
        const freshRevision = await json(`/v1/mcp-servers/${name}/oauth/client/register`, { base: secondUrl, method: "POST", idempotency: "late-after-enable-new-key",
          body: { scope: "tenant", configVersionId: value.version!.configVersionId, expectedRevision: value.registration.revision + 2 } });
        expect(freshRevision.status).toBe(409);
        expect((await register("tenant", name, value, firstUrl, "late-disable-register")).status).toBe(409);
        expect(await coldReceipt(name, value.version!.configVersionId)).toEqual(fenced);
        expect(peer!.counts().registrations).toBe(before.registrations + 1); expect(peer!.counts().clients).toBe(before.clients + 1); peer!.assertHealthy();
      } finally {
        context.signal.removeEventListener("abort", release); hold.release(); const unused = hold.discardUnentered();
        await Promise.allSettled([firstRequest, owned(hold.responseSettled),
          ...(unused ? [] : [owned(hold.nativeClosed), owned(hold.handlerSettled)])]);
      }
    });
    afterAll(async () => {
      const failures: unknown[] = [], clean = async (work: () => Promise<unknown>) => { try { await work(); } catch (error) { failures.push(error); } };
      await Promise.allSettled(startupTasks);
      if (router) { const closed = (router.server as HttpServer).listening ? new Promise<void>(resolve => router!.server.once("close", () => resolve())) : Promise.resolve(); await clean(() => router!.close()); await clean(() => closed); }
      if (first) await clean(() => first!.close()); if (second) await clean(() => second!.close());
      await Promise.allSettled([...nativeTasks]); if (peer) await clean(() => peer!.stop()); if (vendor) await clean(() => vendor!.stop());
      for (const signal of signals) for (const listener of routerListeners.get(signal) ?? []) process.off(signal, listener);
      try { for (const service of [first, second, router]) if (service) expect((service.server as HttpServer).listening).toBe(false);
        for (const signal of signals) expect(process.listeners(signal)).toEqual(initial.get(signal)); if (startupUncertain) throw new Error("DCR startup ownership uncertain"); }
      catch (error) { failures.push(error); }
      exit?.mockRestore();
      if (!failed && failures.length === 0 && runtime && unknownVersion) {
        await clean(async () => {
          await runtime!.assertReusable(mysqlUrl); cold = await MysqlSessionStore.connect({ ...runtime!.runtimeStoreOptions, connectionLimit: 2 });
          const unknown = await cold.getMcpDynamicClient({ owner, access: manage(), name: "unknown", configVersionId: unknownVersion });
          expect(unknown).toMatchObject({ state: "outcome_unknown", clientId: null, clientMaterial: null });
          const ready = installed.get("tenant:shared")!, basic = await cold.getMcpDynamicClient({ owner, access: manage(), name: "shared", configVersionId: ready.version!.configVersionId });
          expect(basic).toMatchObject({ state: "succeeded", clientMaterial: { aad: { purpose: "as_dynamic_client", subject: null, authorizationEpoch: 0 } } });
          expect(peer!.containsSensitive(JSON.stringify(basic))).toBe(false);
        });
      }
      if (cold) { await clean(() => cold!.close()); cold = undefined; }
      const successful = !failed && failures.length === 0 && !startupUncertain && !!unknownVersion;
      if (redis) { if (successful && namespaceOwned) await clean(async () => { const found = await keys(redis!, prefix);
        for (let offset = 0; offset < found.length; offset += 100) await redis!.unlink(...found.slice(offset, offset + 100)); expect(await keys(redis!, prefix)).toEqual([]); });
        await clean(() => redis!.quit()); redis.disconnect(); }
      let runtimeReleased = false;
      if (runtime) await clean(async () => { const release = successful && failures.length === 0; await runtime!.close({ successful: release }); runtimeReleased = release; });
      if (admin) {
        await clean(async () => {
          if (created) {
            if (!successful || failures.length || !runtimeReleased) throw new Error(`DCR fixture evidence retained: ${database}; ${prefix}; scratch=${scratch ?? "not-created"}`);
            const [same] = await admin!.query<RowDataPacket[]>({ sql: "SELECT @@server_uuid AS server_uuid", timeout: 5000 }); if (String(same[0]?.server_uuid) !== serverUuid) throw new Error("DCR MySQL identity changed");
            const [connections] = await admin!.query<RowDataPacket[]>({ sql: "SELECT ID FROM information_schema.PROCESSLIST WHERE DB=?", timeout: 5000 }, [database]);
            const [transactions] = await admin!.query<RowDataPacket[]>({ sql: "SELECT t.TRX_ID FROM information_schema.INNODB_TRX t JOIN information_schema.PROCESSLIST p ON p.ID=t.TRX_MYSQL_THREAD_ID WHERE p.DB=?", timeout: 5000 }, [database]);
            const [locks] = await admin!.query<RowDataPacket[]>({ sql: "SELECT OWNER_THREAD_ID FROM performance_schema.metadata_locks WHERE OBJECT_SCHEMA=?", timeout: 5000 }, [database]);
            if (connections.length || transactions.length || locks.length || !/^agent_service_mcp_dcr_main_test_[0-9a-f]{24}$/.test(database)) throw new Error("DCR owned database still referenced");
            if (!scratch || !/^agent-service-mcp-dcr-main-[A-Za-z0-9]+$/.test(basename(scratch))) throw new Error("DCR scratch ownership unproven");
            const metadata = await lstat(scratch); if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(dirname(scratch)) !== await realpath(tmpdir())) throw new Error("DCR scratch identity changed");
            await rm(scratch, { recursive: true, force: true }); scratch = undefined;
            await admin!.query({ sql: `DROP DATABASE \`${database}\``, timeout: 5000 }); created = false;
          } else if (createAttempted) throw new Error(`DCR CREATE outcome uncertain; retain if present: ${database}`);
        }); await clean(() => admin!.end());
      }
      vi.unstubAllEnvs();
      if (failures.length === 1) throw failures[0]; if (failures.length > 1) throw new AggregateError(failures, "DCR main vertical/owned-resource close failed");
    }, 60_000);
  });
} else {
  describe("DCR explicit three-scope real router/two-main-runner/restricted MySQL/Redis vertical", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 with explicit loopback MYSQL_TEST_URL and REDIS_TEST_URL", () => {});
  });
}
