import type { SessionAuthority } from "@agent-service/store";
import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { describe, expect, it } from "vitest";
import { PiEngine, RegisteredSkillService, SessionHost, StaticToolRegistry } from "@agent-service/core";
import { AgentDefinition, Event, Item, ResolvedSkillContext, Session, SkillExportResponse, SkillVersionResponse, Turn,
  INTERNAL_ROUTER_TOKEN_HEADER, INTERNAL_SKILL_REGISTRY_PLATFORM_PREFIX } from "@agent-service/protocol";
import { LocalAesGcmCipher, ProviderService } from "@agent-service/providers";
import { createSkillRegistryAccess, FsBlobStore, MemoryEventBus, MysqlSessionStore } from "@agent-service/store";
import { FakeVendor } from "@agent-service/testkit";
import { createApp } from "../src/app.js";
import { hashApiKey } from "../src/auth.js";
import { prepareMysqlRuntimeFixture, witnessAbsentMysqlFixtureDatabase } from "../../../test/fixtures/mysql-runtime.mjs";
import { createSourceAuthorityExecutor } from "./fixtures/mysql-authority.js";

// Production Hono handlers/Host/Pi and real MySQL/filesystem package storage. Hono Request dispatch
// is not an independent listener or OS process; the model boundary is real loopback FakeVendor HTTP.
// No supplied base schema, Redis, shared bucket, .env, paid provider or external package is touched.
const OWNED = /^agent_service_skill_registry_test_[0-9a-f]{24}$/;
const owner = { tenantId: "tenant_skill_registry_vertical", userId: "alice" };
const userOwner = { scope: "user" as const, tenantId: owner.tenantId, userId: owner.userId };
const body = "REGISTRY_VERTICAL_EXACT_BODY\nUse only the existing tools.\n";
const document = `---\nname: release-guide\ndescription: A registered release guide\n---\n${body}`;
const callId = "call_registry_vertical", finalText = "The registered skill reached the second model step.";
function baseUrl(): URL {
  try {
    const url = new URL(process.env.MYSQL_TEST_URL ?? ""), db = decodeURIComponent(url.pathname.slice(1));
    if (url.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !url.username
      || !/^[A-Za-z0-9_]+$/.test(db) || !/(?:^|_)test(?:$|_)/i.test(db) || url.search || url.hash) throw new Error();
    return url;
  } catch { throw new Error("Registry vertical requires a loopback MYSQL_TEST_URL naming a test schema without options."); }
}
function urlFor(base: URL, db: string) { const url = new URL(base); url.pathname = `/${db}`; return url.toString(); }
function json(value: unknown): unknown { return Buffer.isBuffer(value) ? JSON.parse(value.toString("utf8")) : typeof value === "string" ? JSON.parse(value) : value; }
const suite = process.env.AGENT_SERVICE_INTEGRATION === "1" ? describe : describe.skip;
suite("managed skill registry production HTTP/Pi with fresh MySQL and filesystem", () => {
  it("commits authorized packages and snapshots before model step two, exports logical deletes, and cold-verifies without DDL", async () => {
    const base = baseUrl(), database = `agent_service_skill_registry_test_${randomBytes(12).toString("hex")}`;
    if (!OWNED.test(database) || database === decodeURIComponent(base.pathname.slice(1))) throw new Error("Registry fixture ownership invalid.");
    const deadline = performance.now() + 60_000, lifetime = new AbortController();
    let expired = false, stage = "preflight", failureStage: string | undefined;
    const timer = setTimeout(() => { expired = true; failureStage ??= stage; lifetime.abort(); }, 60_000);
    const check = () => { if (expired || performance.now() >= deadline) { expired = true; throw new Error("Registry fixture deadline expired."); } };
    const mysqlUrl = urlFor(base, database), adminUrl = urlFor(base, "mysql"), namespaceSha256 = "9".repeat(64);
    let lease: SessionAuthority | undefined;
    let admin: Connection | undefined, observer: Connection | undefined, store: MysqlSessionStore | undefined, cold: MysqlSessionStore | undefined;
    let runtime: Awaited<ReturnType<typeof prepareMysqlRuntimeFixture>> | undefined, runtimeReleased = false;
    let host: SessionHost | undefined, registry: RegisteredSkillService | undefined, scratch: string | undefined;
    const bus = new MemoryEventBus(), vendor = new FakeVendor({ cacheDialect: "deepseek", expectApiKey: "registry-local-fake-model-key" });
    let createAttempted = false, created = false, dropped = false, bodyPassed = false, resourcesClosed = false, uncertain = false;
    let serverIdentity: string | undefined, sessionId: string | undefined, turnId: string | undefined, modelRequests = 0, committedObservations = 0;
    let version: SkillVersionResponse | undefined, exactContext: ResolvedSkillContext | undefined, toolResultText: string | undefined, finalSeq = 0;
    async function endAdmin() { if (admin) { const c = admin; uncertain = true; await c.end(); admin = undefined; uncertain = false; } }
    async function inspectCommittedBeforeSecond() {
      stage = "independent_commit_observer"; check();
      if (!sessionId || !version || observer) throw new Error("Registry fixture observer boundary missing.");
      observer = await mysql.createConnection({ uri: mysqlUrl, connectTimeout: 5000 });
      try {
        const [rows] = await observer.query<RowDataPacket[]>({ sql: "SELECT body FROM items WHERE BINARY session_id=BINARY ? ORDER BY seq,item_id", timeout: 5000 }, [sessionId]);
        const items = rows.map(row => Item.parse(json(row.body)));
        const message = items.find(i => i.type === "userMessage"), call = items.find(i => i.type === "toolCall"), result = items.find(i => i.type === "toolResult");
        expect(message?.type).toBe("userMessage");
        if (message?.type !== "userMessage" || call?.type !== "toolCall" || result?.type !== "toolResult") throw new Error("Registry fixture committed items absent.");
        const observedTurnId = result.turnId;
        if (!observedTurnId || turnId !== undefined && turnId !== observedTurnId) throw new Error("Registry fixture committed turn mismatch.");
        expect(message.skillContexts).toHaveLength(1);
        const context = ResolvedSkillContext.parse(message.skillContexts![0]);
        expect(context).toMatchObject({ name: "release-guide", contentSha256: version.sha256, versionSha256: version.versionSha256, body });
        expect(call).toMatchObject({ toolCallId: callId, kind: "skill", name: "skill", status: "completed", startedAtMs: expect.any(Number) });
        expect(result).toMatchObject({ toolCallId: callId, name: "skill", isError: false, status: "completed", details: { skillContext: context } });
        expect(result.content).toHaveLength(1); const content = result.content[0];
        if (content?.type !== "text") throw new Error("Registry fixture committed result text absent.");
        expect(content.text).toContain(body); toolResultText = content.text;
        const [turnRows] = await observer.query<RowDataPacket[]>({ sql: "SELECT body FROM turns WHERE BINARY session_id=BINARY ? AND BINARY turn_id=BINARY ?", timeout: 5000 }, [sessionId, observedTurnId]);
        expect(turnRows).toHaveLength(1); expect(Turn.parse(json(turnRows[0]!.body)).status).toBe("inProgress");
        const [eventRows] = await observer.query<RowDataPacket[]>({ sql: "SELECT body FROM events WHERE BINARY session_id=BINARY ? ORDER BY seq", timeout: 5000 }, [sessionId]);
        const events = eventRows.map(row => Event.parse(json(row.body)));
        expect(events.some(e => e.type === "item/completed" && e.item.id === result.id)).toBe(true);
        expect(events.some(e => e.type === "turn/completed")).toBe(false);
        expect(vendor.requests).toHaveLength(1); exactContext = context; committedObservations++;
      } finally { const c = observer; uncertain = true; await c.end(); observer = undefined; uncertain = false; }
      check(); stage = "runtime";
    }
    try {
      admin = await mysql.createConnection({ uri: adminUrl, connectTimeout: 5000 }); check();
      const [identity] = await admin.query<RowDataPacket[]>({ sql: "SELECT @@server_uuid AS identity", timeout: 5000 });
      serverIdentity = String(identity[0]?.identity); expect(serverIdentity).toMatch(/^[a-f0-9-]{36}$/i);
      const [prior] = await admin.query<RowDataPacket[]>({ sql: "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", timeout: 5000 }, [database]);
      expect(prior).toHaveLength(0); check();
      const witness = await witnessAbsentMysqlFixtureDatabase({ operatorUrl: mysqlUrl, applicationDatabase: database,
        operationAbortSignal: lifetime.signal });
      createAttempted = true;
      await admin.query({ sql: `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`, timeout: 5000 }); created = true; await endAdmin();
      runtime = await prepareMysqlRuntimeFixture(witness, {
        schemaExecutor: options => MysqlSessionStore.runSchemaOperation(options),
        authorityExecutor: createSourceAuthorityExecutor(),
      });
      check(); await runtime.assertReusable(mysqlUrl);
      stage = "runtime"; scratch = await realpath(await mkdtemp(join(tmpdir(), "agent-service-skill-registry-vertical-")));
      store = await MysqlSessionStore.connect({ ...runtime.runtimeStoreOptions, connectionLimit: 4, operationAbortSignal: lifetime.signal }); check();
      lease = store.sessionAuthority;
      const key = "registry-runtime-private-key", adminKey = "registry-admin-private-key", otherKey = "registry-other-private-key";
      await store.createApiKey(owner.tenantId, "runtime", hashApiKey(key), ["runtime"]);
      await store.createApiKey(owner.tenantId, "admin", hashApiKey(adminKey), ["runtime", "admin"]);
      await store.createApiKey("tenant_other_registry", "other", hashApiKey(otherKey), ["runtime"]);
      const blobs = new FsBlobStore(join(scratch, "packages")), cipher = new LocalAesGcmCipher("54".repeat(32));
      registry = new RegisteredSkillService({ store, blobs, namespaceSha256 });
      const vendorUrl = await vendor.start(), preset = ProviderService.preset("deepseek", "registry-local-fake-model-key");
      vendor.script({ toolCalls: [{ id: callId, name: "skill", args: JSON.stringify({ name: "release-guide" }), argChunks: 3 }] }, { text: finalText });
      const providers = new ProviderService({ store, cipher, platform: [{ ...preset, config: { ...preset.config, baseUrl: vendorUrl } }],
        fetch: async (input, init) => { modelRequests++; if (modelRequests === 2) await inspectCommittedBeforeSecond(); check(); return fetch(input, init); } });
      const tools = new StaticToolRegistry([]);
      host = new SessionHost({ store, lease: store.sessionAuthority, bus, providers, tools, skills: registry, engine: new PiEngine(providers.models),
        config: { runnerId: "registry-mysql-vertical", runnerAddr: "127.0.0.1:8787", leaseHoldMs: 1, leaseTtlMs: 10_000 },
        logger: { info() {}, warn() {}, error() {} } });
      const internal = "registry-mysql-vertical-private-router-token";
      const app = createApp({ store, host, providers, tools, runnerId: "registry-mysql-vertical", internalRouterToken: internal,
        skillRegistryEnabled: true, skillRegistry: registry, skillRegistryStorage: { backend: blobs.backend, shared: false, namespaceSha256 },
        heartbeatMs: 60_000, maxBodyBytes: 400_000, ready: () => true,
        encryptSecret: async value => ({ ciphertext: await cipher.encrypt(value), keyId: cipher.keyId }), decryptSecret: value => cipher.decrypt(value.ciphertext, value.keyId) });
      const request = (path: string, method = "GET", value?: unknown, auth: { key?: string; user?: string | null; idem?: string } = {}) => app.request(path, {
        method, signal: lifetime.signal, headers: { authorization: `Bearer ${auth.key ?? key}`, ...(auth.user === null ? {} : { "x-user-id": auth.user ?? owner.userId }),
          ...(value === undefined ? {} : { "content-type": "application/json" }), ...(auth.idem ? { "idempotency-key": auth.idem } : {}) },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
      const installed = await request("/v1/skills", "POST", { scope: "user", document, expectedRevision: 0 }, { idem: "user-package" });
      expect(installed.status).toBe(201); version = SkillVersionResponse.parse(await installed.json());
      expect((await request("/v1/skills/release-guide?scope=user", "GET", undefined, { user: "bob" })).status).toBe(404);
      expect((await request("/v1/skills/release-guide?scope=user", "GET", undefined, { key: otherKey })).status).toBe(404);
      expect((await request("/v1/skills", "POST", { scope: "tenant", document, expectedRevision: 0 }, { idem: "not-admin" })).status).toBe(403);
      expect((await request("/v1/skills", "POST", { scope: "tenant", document, expectedRevision: 0 }, { key: adminKey, user: null, idem: "tenant-package" })).status).toBe(201);
      expect((await request("/v1/skills", "POST", { scope: "platform", document, expectedRevision: 0 }, { key: adminKey, idem: "forged-platform" })).status).toBe(400);
      expect((await request(INTERNAL_SKILL_REGISTRY_PLATFORM_PREFIX)).status).toBe(404);
      const platform = await app.request(INTERNAL_SKILL_REGISTRY_PLATFORM_PREFIX, { method: "POST", signal: lifetime.signal,
        headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: internal, "content-type": "application/json", "idempotency-key": "platform-package" }, body: JSON.stringify({ document, expectedRevision: 0 }) });
      expect(platform.status).toBe(201); expect(SkillVersionResponse.parse(await platform.json()).scope).toBe("platform");
      const defined = await request("/v1/agents", "POST", { name: "Registered skills SQL vertical", model: { provider: "deepseek", model: "deepseek-chat" },
        tools: [], skills: ["registry:release-guide"], approvalPolicy: "never", limits: { maxSteps: 4, maxToolCalls: 2, maxWallClockMs: 20_000 } }, { key: adminKey });
      expect(defined.status).toBe(201); const agent = AgentDefinition.parse(await defined.json());
      const createdSession = await request("/v1/sessions", "POST", { agentId: agent.id, userId: owner.userId }, { user: "trusted-caller" });
      expect(createdSession.status).toBe(201); sessionId = Session.parse(await createdSession.json()).id;
      const accepted = await request(`/v1/sessions/${sessionId}/turns`, "POST", { input: [{ type: "skill", name: "release-guide", args: "literal arguments" },
        { type: "text", text: "Load the guide tool and use its result." }], skillOverrides: [{ name: "release-guide", versionId: version.versionId }], stream: false }, { idem: "registry-turn" });
      expect(accepted.status).toBe(202); const acceptedBody = await accepted.json() as { turn: { id: string } }; turnId = acceptedBody.turn.id;
      const until = performance.now() + 10_000;
      let turn: Turn | null = null;
      while (performance.now() < until && !lifetime.signal.aborted) { turn = await store.getTurn(sessionId, turnId); if (turn?.status !== "inProgress") break; await new Promise(resolve => setTimeout(resolve, 10)); }
      expect(turn).toMatchObject({ status: "completed", stopReason: "end_turn", steps: 2, toolCalls: 1 }); check();
      expect(modelRequests).toBe(2); expect(vendor.requests).toHaveLength(2); expect(committedObservations).toBe(1); expect(exactContext).toBeDefined();
      const modelResults = (vendor.requests[1]!.body.messages as Record<string, unknown>[]).filter(message => message.role === "tool" && message.tool_call_id === callId);
      expect(modelResults).toHaveLength(1); expect(modelResults[0]!.content).toBe(toolResultText);
      const session = await store.getSession(owner.tenantId, sessionId); expect(session).toMatchObject({ userId: owner.userId, status: { type: "idle" } }); finalSeq = session!.lastSeq;
      const events = await store.readEvents(sessionId, 0, 200); expect(events.map(e => e.seq)).toEqual(Array.from({ length: finalSeq }, (_, i) => i + 1));
      expect(events.some(e => e.type === "item/completed" && e.item.type === "agentMessage" && e.item.text === finalText)).toBe(true);
      const exported = await request("/v1/skills/export"); expect(exported.status).toBe(200);
      expect(SkillExportResponse.parse(await exported.json()).versions).toEqual([{ ...version, document }]);
      expect((await request("/v1/skills/release-guide", "DELETE", { scope: "user", expectedRevision: 1 }, { idem: "delete-user-package" })).status).toBe(200);
      expect((await request(`/v1/skills/release-guide/versions/${version.versionId}?scope=user`)).status).toBe(404);
      const afterDelete = await request("/v1/skills/export");
      expect(SkillExportResponse.parse(await afterDelete.json())).toMatchObject({ slots: [{ state: "deleted", revision: 2 }], versions: [{ ...version, document }], physicalErasureComplete: false });
      const denied = await request(`/v1/sessions/${sessionId}/turns`, "POST", { input: [{ type: "text", text: "old version" }],
        skillOverrides: [{ name: "release-guide", versionId: version.versionId }], stream: false }, { idem: "deleted-version" });
      expect(denied.status).toBe(404); expect((await store.getSession(owner.tenantId, sessionId))?.lastSeq).toBe(finalSeq);
      stage = "close_primary"; await host.drain(1000); host = undefined; await registry.close(); registry = undefined;
      await store.close(); store = undefined; await vendor.stop(); await bus.close(); await lease?.close(); check();
      stage = "cold_verify"; await runtime.assertReusable(mysqlUrl); check();
      cold = await MysqlSessionStore.connect({ ...runtime.runtimeStoreOptions, connectionLimit: 2, operationAbortSignal: lifetime.signal }); check();
      const access = createSkillRegistryAccess({ principal: owner, owner: userOwner, authority: "user_self", access: "read" });
      expect(await cold.getSkillSlot({ access, owner: userOwner, name: "release-guide" })).toMatchObject({ state: "deleted", revision: 2 });
      expect(await cold.getReadableSkillVersion({ access, owner: userOwner, name: "release-guide", versionId: version.versionId })).toBeNull();
      expect(await cold.getSession(owner.tenantId, sessionId)).toMatchObject({ lastSeq: finalSeq, userId: owner.userId, status: { type: "idle" } });
      const coldItems = await cold.listItems(sessionId, { limit: 200 });
      expect(coldItems.filter(i => i.type === "toolResult")).toEqual([expect.objectContaining({ toolCallId: callId, isError: false, details: { skillContext: exactContext } })]);
      expect((await cold.readEvents(sessionId, 0, 200)).map(e => e.seq)).toEqual(events.map(e => e.seq));
      await cold.close(); cold = undefined; check(); bodyPassed = true;
    } catch { failureStage ??= stage; }
    finally {
      stage = "close";
      try { if (host) await host.drain(1000); await registry?.close(); await store?.close(); await cold?.close();
        if (observer) { await observer.end(); observer = undefined; } await vendor.stop(); await bus.close(); await lease?.close(); await endAdmin(); resourcesClosed = !uncertain; }
      catch { failureStage ??= stage; }
      if (runtime) {
        const successful = bodyPassed && !failureStage && resourcesClosed && !expired && performance.now() < deadline;
        try { await runtime.close({ successful }); runtimeReleased = successful; }
        catch { failureStage ??= stage; }
      }
      stage = "cleanup";
      if (created && bodyPassed && !failureStage && resourcesClosed && runtimeReleased && !expired && performance.now() < deadline) {
        try {
          admin = await mysql.createConnection({ uri: adminUrl, connectTimeout: 5000 }); check();
          const [identity] = await admin.query<RowDataPacket[]>({ sql: "SELECT @@server_uuid AS identity", timeout: 5000 }); expect(String(identity[0]?.identity)).toBe(serverIdentity);
          const [connections] = await admin.query<RowDataPacket[]>({ sql: "SELECT ID FROM information_schema.PROCESSLIST WHERE ID<>CONNECTION_ID() AND (BINARY DB=BINARY ? OR LOCATE(?,COALESCE(INFO,''))>0)", timeout: 5000 }, [database, database]);
          expect(connections).toHaveLength(0);
          const [transactions] = await admin.query<RowDataPacket[]>({ sql: "SELECT t.trx_id FROM information_schema.innodb_trx t JOIN information_schema.PROCESSLIST p ON p.ID=t.trx_mysql_thread_id WHERE BINARY p.DB=BINARY ? OR LOCATE(?,COALESCE(t.trx_query,''))>0", timeout: 5000 }, [database, database]);
          expect(transactions).toHaveLength(0);
          const [locks] = await admin.query<RowDataPacket[]>({ sql: "SELECT OBJECT_NAME FROM performance_schema.metadata_locks WHERE BINARY OBJECT_SCHEMA=BINARY ?", timeout: 5000 }, [database]); expect(locks).toHaveLength(0);
          if (!OWNED.test(database) || database === decodeURIComponent(base.pathname.slice(1))) throw new Error("Registry fixture DROP ownership invalid."); check();
          await admin.query({ sql: `DROP DATABASE \`${database}\``, timeout: 5000 }); dropped = true;
          await endAdmin(); check(); if (scratch) await rm(scratch, { recursive: true, force: false });
        } catch { failureStage ??= stage; }
        finally { try { await endAdmin(); } catch { failureStage ??= stage; } }
      }
      clearTimeout(timer);
    }
    if (!bodyPassed || !resourcesClosed || !dropped || failureStage || expired || performance.now() >= deadline || createAttempted && !created) {
      throw new Error(`Registry MySQL vertical failed at ${failureStage ?? stage}; owned fixture ${dropped ? "dropped" : "retained if present"}: ${database}`);
    }
  }, 60_000);
});
