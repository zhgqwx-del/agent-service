import type { SessionAuthority } from "@agent-service/store";
import { randomBytes } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PiEngine, PiSummariser, SessionHost, StaticToolRegistry, newId } from "@agent-service/core";
import { DEFAULT_AUTH_POLICY, Event, Turn, type AgentDefinition } from "@agent-service/protocol";
import { LocalAesGcmCipher, ProviderService } from "@agent-service/providers";
import {
  MemoryEventBus, MysqlSessionStore,
  newUserDataExportRequestId, userDataExportAuthorization,
  userDataExportIdempotencyKeySha256, userDataExportRequestHash,
} from "@agent-service/store";
import { FakeVendor } from "@agent-service/testkit";
import { CurrentMysqlRuntimeOwner, type CurrentMysqlInspection } from "../../../packages/store/test/fixtures/current-mysql-runtime.js";

const profile = process.env.AGENT_SERVICE_INTEGRATION ?? "0";
if (profile !== "0" && profile !== "1") throw new Error("Provider compaction integration profile must be 0 or 1.");
const suite = profile === "1" ? describe : describe.skip;
const MODEL = "compaction-fixture-model";
const PRIVATE_FAILURE = "private-compaction-http-503-canary";
const CIPHER_KEY = "37".repeat(32);

function suppliedDatabase(): string {
  try {
    const url = new URL(process.env.MYSQL_TEST_URL ?? ""), database = decodeURIComponent(url.pathname.slice(1));
    if (url.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || !url.username || !/^[A-Za-z0-9_]+$/.test(database) || !/(?:^|_)test(?:$|_)/i.test(database)
      || url.search || url.hash) throw new Error();
    return url.toString();
  } catch { throw new Error("Provider compaction requires an explicit loopback MYSQL_TEST_URL test schema."); }
}
function json(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : Buffer.isBuffer(value) ? JSON.parse(value.toString("utf8")) : value;
}
const owner = () => ({ tenantId: `tenant-compaction-${randomBytes(8).toString("hex")}`, userId: "compaction-owner" });
function provider(baseUrl: string) {
  return {
    id: "compaction-provider", api: "openai-completions" as const, baseUrl, headers: {}, quota: {}, fallback: [],
    models: [{ id: MODEL, contextWindow: 32_000, maxOutputTokens: 256, input: ["text" as const], reasoning: false,
      price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  };
}
async function closeOwned(actions: (() => Promise<void>)[], primaryFailed: boolean): Promise<void> {
  const failures: unknown[] = [];
  for (const action of actions) try { await action(); } catch (error) { failures.push(error); }
  if (failures.length && !primaryFailed) throw new Error("Provider compaction fixture did not close all owned resources.");
}

// The supplied URL is only a local operator safety token. The shared owned fixture witnesses
// absence before creating its own new DB, runs the real schema/authority CLI, and exposes only the
// restricted runtime profile to SessionStore. Independent SQL inspections retain operator identity.
// No existing supplied app schema, .env, Redis/S3 or paid provider is opened by this file.
suite("provider compaction and registration on real MySQL with native fixture HTTP", () => {
  let mysqlOwner: CurrentMysqlRuntimeOwner | undefined;
  beforeAll(async () => {
    mysqlOwner = new CurrentMysqlRuntimeOwner(suppliedDatabase());
    await mysqlOwner.prepare();
  });
  afterAll(async ({}, collected) => {
    type Collected = { type: string; tasks?: readonly Collected[]; result?: { state?: string } };
    const tests: Collected[] = [];
    const collect = (tasks: readonly Collected[]) => { for (const task of tasks) {
      if (task.type === "test") tests.push(task); else if (task.tasks) collect(task.tasks);
    } };
    collect(collected.tasks);
    await mysqlOwner?.close({ successful: tests.length > 0 && tests.every(test => test.result?.state === "pass") });
  });

  it("commits a dispatched compaction 503 as one failed step0 turn with SQL billing and export owner closure", async ({ signal }) => {
    const principal = owner(), key = "test-only-mysql-compaction-key";
    const vendor = new FakeVendor({ expectApiKey: key }).script(
      ...Array.from({ length: 3 }, () => ({ text: "history answer ".repeat(80), usage: { promptTokens: 2, completionTokens: 1 } })),
      { httpError: { status: 503, body: { error: { message: PRIVATE_FAILURE } } } },
    );
    const bus = new MemoryEventBus();
    let lease: SessionAuthority | undefined;
    let store: MysqlSessionStore | undefined, observer: CurrentMysqlInspection | undefined, host: SessionHost | undefined;
    let primaryFailed = false;
    const check = () => signal.throwIfAborted();
    try {
      check(); const baseUrl = await vendor.start(); check();
      store = await mysqlOwner!.openStore(3, signal); check();
      lease = store.sessionAuthority;
      observer = await mysqlOwner!.openInspection(signal, 5_000); check();
      await store.setTenantAuth(principal.tenantId, DEFAULT_AUTH_POLICY); check();
      const providers = new ProviderService({ store, cipher: new LocalAesGcmCipher(CIPHER_KEY),
        // The only allowed endpoint is this case's native loopback fixture, not a product SSRF bypass.
        assertBaseUrl: async candidate => { if (candidate !== baseUrl) throw new Error("Unexpected fixture endpoint."); },
        fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) }),
      });
      await providers.upsertTenantProvider(principal.tenantId, { ...provider(baseUrl), apiKey: key }); check();
      const agent: AgentDefinition = { id: newId("agt"), tenantId: principal.tenantId, version: 1, name: "compaction fixture",
        instructions: "Return the fixture answer.", model: { provider: "compaction-provider", model: MODEL },
        tools: [], mcpServers: [], skills: [], limits: {}, approvalPolicy: "never", busyPolicy: "reject",
        sandbox: "none", metadata: {}, createdAtMs: Date.now() };
      await store.createAgent(agent); check();
      const capture = { commit: vi.fn(async () => { throw new Error("Compaction must not create a 0053 step source."); }) };
      host = new SessionHost({ store, lease: store.sessionAuthority, bus, providers, engine: new PiEngine(providers.models),
        summariser: new PiSummariser(providers.models), tools: new StaticToolRegistry([]), persistedProviderFailureCapture: capture,
        logger: { info() {}, warn() {}, error() {} },
        config: { runnerId: "mysql-compaction-fixture", runnerAddr: "127.0.0.1:1", leaseTtlMs: 5_000, leaseHoldMs: 1 } });
      const session = await host.createSession(principal, { agentId: agent.id, metadata: {} }); check();
      for (let index = 0; index < 3; index++) {
        const begun = await host.beginTurn(principal, session.id, { input: [{ type: "text", text: `history ${index} ` + "input ".repeat(80) }], stream: false, metadata: {} });
        begun.run();
        while (host.activeTurn(session.id)) { check(); await new Promise(resolve => setTimeout(resolve, 5)); }
        check(); expect(await store.getTurn(session.id, begun.turn.id)).toMatchObject({ status: "completed", steps: 1 });
      }
      const before = (await store.getSession(principal.tenantId, session.id))!;
      const items = await store.listItems(session.id, { limit: 100 }); check();
      expect(vendor.requests).toHaveLength(3);
      await expect(host.compactSession(principal, session.id)).rejects.toMatchObject({ code: "provider_error", message: "Provider request failed." }); check();
      while (vendor.ioSnapshot.active) { check(); await new Promise(resolve => setTimeout(resolve, 5)); }
      expect(vendor.requests).toHaveLength(4); expect(vendor.ioSnapshot).toMatchObject({ active: 0, closed: 4 });
      expect(capture.commit).not.toHaveBeenCalled();
      expect(await store.listItems(session.id, { limit: 100 })).toEqual(items);
      const after = (await store.getSession(principal.tenantId, session.id))!;
      expect(after.lastCompactionSeq).toBe(before.lastCompactionSeq); expect(after.status).toEqual(before.status);
      expect(after.lastSeq).toBe(before.lastSeq + 4); expect(Object.hasOwn(after.usage, "costCNY")).toBe(false);

      // An independent connection observes only committed InnoDB facts, not Host/Memory state.
      const [ledger] = await observer.query<RowDataPacket[]>({ sql: "SELECT usage_id,tenant_id,user_id,session_id,turn_id,step,provider,model,usage_json FROM usage_ledger WHERE BINARY tenant_id=BINARY ? ORDER BY id", timeout: 5_000 }, [principal.tenantId]); check();
      const [facts] = await observer.query<RowDataPacket[]>({ sql: "SELECT * FROM billing_usage_facts WHERE BINARY tenant_id=BINARY ? ORDER BY usage_id", timeout: 5_000 }, [principal.tenantId]); check();
      expect(ledger).toHaveLength(4); expect(facts).toHaveLength(4);
      expect(new Set(ledger.map(row => row.usage_id)).size).toBe(4);
      expect(facts.map(row => row.usage_id).sort()).toEqual(ledger.map(row => row.usage_id).sort());
      for (const entry of ledger) {
        expect(entry).toMatchObject({ tenant_id: principal.tenantId, user_id: principal.userId, session_id: session.id });
        const billed = facts.find(row => row.usage_id === entry.usage_id)!, value = json(entry.usage_json) as Record<string, unknown>;
        expect(billed).toMatchObject({ tenant_id: principal.tenantId, provider: entry.provider, model: entry.model, currency: "CNY" });
        expect(Number(billed.input_tokens)).toBe(value.inputTokens); expect(Number(billed.output_tokens)).toBe(value.outputTokens);
        expect(Number(billed.total_tokens)).toBe(value.totalTokens);
        expect(await store.getTurn(session.id, String(entry.turn_id))).not.toBeNull(); check();
      }
      const failedUsage = ledger.find(row => Number(row.step) === 0)!;
      expect(failedUsage).toMatchObject({ tenant_id: principal.tenantId, user_id: principal.userId, session_id: session.id,
        provider: `${principal.tenantId}:compaction-provider`, model: MODEL });
      const usage = json(failedUsage.usage_json) as Record<string, unknown>;
      expect(usage).toMatchObject({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }); expect(Object.hasOwn(usage, "costCNY")).toBe(false);
      const fact = facts.find(row => row.usage_id === failedUsage.usage_id)!;
      expect(fact.cost_cny).toBeNull(); expect(Number(fact.total_tokens)).toBe(0);
      for (const row of facts) for (const field of ["user_id", "session_id", "turn_id", "step", "created_at_ms", "usage_json"]) expect(Object.hasOwn(row, field)).toBe(false);
      const [turnRows] = await observer.query<RowDataPacket[]>({ sql: "SELECT user_id,status,body FROM turns WHERE BINARY session_id=BINARY ? AND BINARY turn_id=BINARY ?", timeout: 5_000 }, [session.id, failedUsage.turn_id]); check();
      expect(turnRows).toHaveLength(1); expect(turnRows[0]).toMatchObject({ user_id: principal.userId, status: "failed" });
      const failed = Turn.parse(json(turnRows[0]!.body));
      expect(failed).toMatchObject({ id: failedUsage.turn_id, sessionId: session.id, status: "failed", stopReason: "error", steps: 0, toolCalls: 0,
        model: { provider: failedUsage.provider, model: MODEL }, usage, error: { code: "provider_error", message: "Provider request failed." } });
      expect((await store.listTurns(session.id, { limit: 100 })).data).toHaveLength(4);
      const [eventRows] = await observer.query<RowDataPacket[]>({ sql: "SELECT user_id,seq,body FROM events WHERE BINARY session_id=BINARY ? AND seq>? ORDER BY seq", timeout: 5_000 }, [session.id, before.lastSeq]); check();
      expect(eventRows.every(row => row.user_id === principal.userId)).toBe(true);
      const events = eventRows.map(row => { const event = Event.parse(json(row.body)); expect(event.seq).toBe(Number(row.seq)); return event; });
      expect(events.map(event => event.type)).toEqual(["turn/started", "usage/updated", "error", "turn/completed"]);
      expect(events.map(event => event.seq)).toEqual([1, 2, 3, 4].map(offset => before.lastSeq + offset));
      expect(events[0]).toMatchObject({ turn: { id: failed.id, status: "inProgress" } });
      expect(events[1]).toMatchObject({ turnId: failed.id, step: 0, stepUsage: usage, turnUsage: usage });
      expect(events[2]).toMatchObject({ turnId: failed.id, code: "provider_error", message: "Provider request failed." });
      expect(events[3]).toMatchObject({ turn: { id: failed.id, status: "failed" } });
      expect(failed.seqStart).toBe(events[0]!.seq); expect(failed.seqEnd).toBe(events[3]!.seq);
      const [captureRows] = await observer.query<RowDataPacket[]>({ sql: `SELECT
        (SELECT COUNT(*) FROM tenant_telemetry_capture_v2_failure_commit_receipts WHERE BINARY tenant_id=BINARY ?) AS receipts,
        (SELECT COUNT(*) FROM tenant_telemetry_capture_v2_source_bindings WHERE BINARY tenant_id=BINARY ?) AS bindings`, timeout: 5_000 }, [principal.tenantId, principal.tenantId]); check();
      expect(Number(captureRows[0]!.receipts)).toBe(0); expect(Number(captureRows[0]!.bindings)).toBe(0);

      await store.putRetentionPolicy({ tenantId: principal.tenantId, policyVersion: "compaction-export-v1", actorKeyId: "fixture-admin", atMs: Date.now(),
        policy: { sessionContentRetentionMs: 0, userErasureGraceMs: 0, operationalUsageRetentionMs: null,
          idempotencyReceiptRetentionMs: null, billingFactRetentionMs: null, lifecycleAuditRetentionMs: null, exportArtifactTtlMs: 60_000 } }); check();
      await store.activateRetentionPolicy({ tenantId: principal.tenantId, policyVersion: "compaction-export-v1", expectedControlGeneration: 0, actorKeyId: "fixture-admin", atMs: Date.now() }); check();
      const request = await store.requestUserDataExport({ ...principal, requestId: newUserDataExportRequestId(), requestedByKeyId: "fixture-admin",
        idempotencyKeySha256: userDataExportIdempotencyKeySha256(principal.tenantId), requestHash: userDataExportRequestHash(principal.tenantId, principal.userId) }); check();
      const [claim] = await store.claimUserDataExports({ limit: 1, leaseMs: 10_000, claimToken: "mysql-compaction-export" }); check();
      expect(claim?.requestId).toBe(request.requestId);
      const authorization = userDataExportAuthorization(claim!), snapshot = await store.captureAndSealUserDataExportSnapshot(authorization); check();
      expect(snapshot.counts.turn).toBe(4); expect(snapshot.counts.operational_usage).toBe(4);
      const exported = await store.readUserDataExportSnapshotRecords(authorization, { limit: 200 }); check();
      expect(exported.nextOrdinal).toBeNull();
      const exportedTurns = new Set(exported.data.filter(row => row.kind === "turn").map(row => (JSON.parse(row.canonicalBytes.toString("utf8")) as { value: { id: string } }).value.id));
      for (const row of exported.data.filter(row => row.kind === "operational_usage")) {
        const value = (JSON.parse(row.canonicalBytes.toString("utf8")) as { value: { turnId: string } }).value;
        expect(exportedTurns.has(value.turnId)).toBe(true);
      }
      const publicFacts = JSON.stringify([after, failed, events, ledger, facts, exported.data.map(row => row.canonicalBytes.toString("utf8"))]);
      expect(publicFacts).not.toContain(key); expect(publicFacts).not.toContain(PRIVATE_FAILURE); expect(publicFacts).not.toContain(baseUrl);
    } catch (error) { primaryFailed = true; throw error; }
    finally {
      await closeOwned([
        async () => { await host?.drain(2_000); }, async () => { await vendor.stop(); },
        async () => { await observer?.end(); }, async () => { await lease?.close(); }, () => bus.close(), async () => { await store?.close(); },
      ], primaryFailed);
    }
  });

  it("re-registers a same-millisecond SQL provider replacement before the native SDK selects its endpoint and key", async ({ signal }) => {
    const principal = owner(), oldKey = "test-only-retired-mysql-key", newKey = "test-only-replacement-mysql-key";
    const retired = new FakeVendor({ expectApiKey: oldKey }), replacement = new FakeVendor({ expectApiKey: newKey })
      .script({ text: "replacement source reached", usage: { promptTokens: 2, completionTokens: 1 } });
    let store: MysqlSessionStore | undefined, observer: CurrentMysqlInspection | undefined, restoreClock: (() => void) | undefined;
    let primaryFailed = false;
    const check = () => signal.throwIfAborted();
    try {
      const oldUrl = await retired.start(), newUrl = await replacement.start(); check();
      store = await mysqlOwner!.openStore(3, signal); check();
      observer = await mysqlOwner!.openInspection(signal, 5_000); check();
      await store.setTenantAuth(principal.tenantId, DEFAULT_AUTH_POLICY); check();
      const service = new ProviderService({ store, cipher: new LocalAesGcmCipher(CIPHER_KEY),
        assertBaseUrl: async candidate => { if (candidate !== oldUrl && candidate !== newUrl) throw new Error("Unexpected fixture endpoint."); },
        fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) }),
      });
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now()); restoreClock = () => clock.mockRestore();
      const original = await service.upsertTenantProvider(principal.tenantId, { ...provider(oldUrl), apiKey: oldKey }); check();
      const ref = { provider: original.id, model: MODEL }, old = await service.resolve(principal, ref); check();
      const previous = (await store.getProviderConfig(principal.tenantId, original.id))!;
      expect(await service.deleteTenantProvider(principal.tenantId, original.id)).toBe(true); check();
      const config = provider(newUrl), freshConfig = await service.upsertTenantProvider(principal.tenantId, { ...config, apiKey: newKey,
        headers: { "x-fixture-version": "replacement" }, models: [{ ...config.models[0]!, contextWindow: 64_000, maxOutputTokens: 512 }] }); check();
      expect(freshConfig.updatedAtMs).toBe(original.updatedAtMs);
      const actual = (await store.getProviderConfig(principal.tenantId, original.id))!;
      expect(actual.credentialSourceRevision).toBeGreaterThan(previous.credentialSourceRevision!);
      expect(actual.config.baseUrl).toBe(newUrl); expect(actual.config.models[0]!.contextWindow).toBe(64_000);
      expect(actual.secret!.ciphertext.equals(previous.secret!.ciphertext)).toBe(false);
      restoreClock(); restoreClock = undefined;
      const fresh = await service.resolve(principal, ref), request = fresh.createRequest!(); check();
      const result = await service.models.streamSimple(fresh.handle as never,
        { messages: [{ role: "user", content: "replacement registry probe", timestamp: Date.now() }] },
        { apiKey: await request.apiKey!(signal), headers: fresh.headers, fetch: request.fetch, signal, maxRetries: 0 }).result(); check();
      expect(result.stopReason).toBe("stop"); expect(result.usage).toMatchObject({ input: 2, output: 1, totalTokens: 3 });
      while (replacement.ioSnapshot.active) { check(); await new Promise(resolve => setTimeout(resolve, 5)); }
      expect(retired.requests).toHaveLength(0); expect(replacement.requests).toHaveLength(1);
      expect(replacement.requests[0]).toMatchObject({ path: "/v1/chat/completions", headers: { authorization: `Bearer ${newKey}`, "x-fixture-version": "replacement" } });
      expect(replacement.ioSnapshot).toMatchObject({ active: 0, closed: 1 });
      expect(fresh.handle).not.toBe(old.handle);
      expect(fresh.handle).toMatchObject({ baseUrl: newUrl, contextWindow: 64_000, maxTokens: 512 });
      expect(old.handle).toMatchObject({ baseUrl: oldUrl, contextWindow: 32_000, maxTokens: 256 });
      const [rows] = await observer.query<RowDataPacket[]>({ sql: "SELECT config AS config_json,credential_write_generation AS credential_source_revision FROM provider_configs WHERE BINARY tenant_id=BINARY ? AND BINARY provider_id=BINARY ?", timeout: 5_000 }, [principal.tenantId, original.id]); check();
      expect(rows).toHaveLength(1); expect(json(rows[0]!.config_json)).toMatchObject({ baseUrl: newUrl, updatedAtMs: original.updatedAtMs });
      expect(Number(rows[0]!.credential_source_revision)).toBe(actual.credentialSourceRevision);
    } catch (error) { primaryFailed = true; throw error; }
    finally {
      restoreClock?.();
      await closeOwned([() => retired.stop(), () => replacement.stop(), async () => { await observer?.end(); }, async () => { await store?.close(); }], primaryFailed);
    }
  });
});
