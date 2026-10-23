import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type Pool, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prepareMysqlRuntimeFixture, witnessAbsentMysqlFixtureDatabase } from "../../../test/fixtures/mysql-runtime.mjs";
import { createMysqlAuthorityCliExecutor } from "../../../test/fixtures/mysql-authority-cli.mjs";
import { MysqlSessionStore } from "../src/mysql/store.js";
import * as M from "../src/mcp-registry.js";
import { newErasureRequestId, SubjectDeletingError, userErasureRequestHash } from "../src/subject-lifecycle.js";
import { assertMysqlMcpRegistryProjection } from "../src/mysql/mcp-registry.js";
import { mcpFixtureAccess, mcpFixtureBegin, mcpFixtureExchange } from "./fixtures/mcp-registry.js";
import { mcpDcrReady, mcpDcrSuccess, mcpDcrWrite } from "./fixtures/mcp-dcr.js";

function base() {
  const url = new URL(process.env.MYSQL_TEST_URL ?? "mysql://invalid/");
  if (url.protocol !== "mysql:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.search || url.hash
    || !/(?:^|[_-])test(?:$|[_-])/i.test(decodeURIComponent(url.pathname.slice(1)))) throw new Error("DCR requires a local owned MySQL test fixture");
  return url;
}
function at(url: URL, database: string) { const result = new URL(url); result.pathname = `/${database}`; return result.toString(); }
function fail(): never { throw new Error("DCR owned MySQL fixture identity is not proven"); }
describe.skipIf(!process.env.AGENT_SERVICE_INTEGRATION)("dynamic AS client on isolated actual MySQL", () => {
  let admin: Connection | undefined, inspect: Connection | undefined, first: MysqlSessionStore, second: MysqlSessionStore;
  let runtime: Awaited<ReturnType<typeof prepareMysqlRuntimeFixture>> | undefined, database = "", uuid = "", ready = false;
  const lifetime = new AbortController();
  beforeAll(async () => {
    const source = base(), timer = setTimeout(() => lifetime.abort(), 115000);
    try {
      admin = await mysql.createConnection({ uri: at(source, "mysql"), connectTimeout: 5000 });
      const [identity] = await admin.query<RowDataPacket[]>({ sql: "SELECT @@server_uuid AS uuid,DATABASE() AS db", timeout: 5000 });
      uuid = String(identity[0]?.uuid).toLowerCase(); if (identity.length !== 1 || !/^[a-f0-9-]{36}$/.test(uuid) || identity[0]?.db !== "mysql") fail();
      database = `agent_service_mcp_dcr_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const url = at(source, database), witness = await witnessAbsentMysqlFixtureDatabase({ operatorUrl: url, applicationDatabase: database, operationAbortSignal: lifetime.signal });
      await admin.query({ sql: `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`, timeout: 5000 });
      runtime = await prepareMysqlRuntimeFixture(witness, { schemaExecutor: async options => {
        try { await MysqlSessionStore.runSchemaOperation(options); }
        catch (error) {
          const causes: { name: string; code: string | null; message: string }[] = []; let current: unknown = error;
          for (let depth = 0; depth < 6 && current instanceof Error; depth++) {
            const code = Object.getOwnPropertyDescriptor(current, "code")?.value as unknown;
            causes.push({ name: current.name.slice(0, 80), code: typeof code === "string" ? code.slice(0, 80) : null, message: current.message.slice(0, 512) });
            current = Object.getOwnPropertyDescriptor(current, "cause")?.value as unknown;
          }
          console.warn(JSON.stringify({ schema: "mcp-dcr-schema-diagnostic-v1", operation: options.operation, causes })); throw error;
        }
      }, authorityExecutor: createMysqlAuthorityCliExecutor({
        entrypoint: fileURLToPath(new URL("../../../apps/agent-runner/src/main.ts", import.meta.url)),
        mode: "source",
        cwd: resolve(fileURLToPath(new URL("../../../", import.meta.url))),
      }) });
      await runtime.assertReusable(url);
      first = await MysqlSessionStore.connect({ ...runtime.runtimeStoreOptions, connectionLimit: 4 });
      second = await MysqlSessionStore.connect({ ...runtime.runtimeStoreOptions, connectionLimit: 4 });
      inspect = await mysql.createConnection({ uri: url, connectTimeout: 5000 });
      const [target] = await inspect.query<RowDataPacket[]>({ sql: "SELECT @@server_uuid AS uuid,DATABASE() AS db", timeout: 5000 });
      if (target.length !== 1 || String(target[0]?.uuid).toLowerCase() !== uuid || target[0]?.db !== database) fail(); ready = true;
    } finally { clearTimeout(timer); }
  }, 120000);
  afterAll(async () => {
    const closed = await Promise.allSettled([first?.close(), second?.close(), inspect?.end()]);
    try {
      // Keep this package's exact SQL evidence; failed/unknown fixtures are never guessed absent.
      if (runtime) await runtime.close({ successful: false });
      if (closed.some(r => r.status !== "fulfilled")) fail();
    } finally { await admin?.end(); lifetime.abort(); }
  }, 120000);
  function fixture(authentication: "none" | "client_secret_basic" = "none", scope: M.McpRegistrationOwner["scope"] = "user") {
    if (!ready) fail(); const subject = { tenantId: `dcr-${randomUUID()}`, userId: "alice" };
    const owner: M.McpRegistrationOwner = { scope, tenantId: scope === "platform" ? null : subject.tenantId, userId: scope === "user" ? subject.userId : null };
    const name = `server-${randomUUID()}`, input = mcpDcrWrite(owner, subject, 0, "install", authentication, 1, name);
    return { subject, owner, name, input, ref: { access: input.access, owner, name } };
  }
  async function prepare(f: ReturnType<typeof fixture>, operationTimeoutMs = 30000) {
    const view = await first.upsertMcpRegistration(f.input), request = { ...f.ref, configVersionId: view.version.configVersionId, expectedRevision: 1, idempotencyKey: "register", operationTimeoutMs };
    const claim = await first.prepareMcpDynamicClient(request); if (!claim.claimToken) fail();
    return { view, request, claim, op: { ...f.ref, operationId: claim.operation.operationId, claimToken: claim.claimToken } };
  }
  it.each(["platform", "tenant", "user"] as const)("publishes distinct %s client identity and isolated actual-user OAuth after ready", async scope => {
    const f = fixture("none", scope), r = await mcpDcrReady(first, f.input);
    expect((await second.getMcpRegistration(f.ref))?.version).toEqual(r.view.version);
    expect((await second.getMcpDynamicClient({ ...f.ref, configVersionId: r.view.version.configVersionId }))?.clientId).toBe("dynamic-fixture-client");
    const grant = await mcpFixtureExchange(first, f.owner, f.subject, "auth", f.name);
    expect((await second.getMcpRuntimeAuthorization(grant.ref))?.authorization?.subject).toEqual(f.subject);
    if (scope !== "user") {
      const other = { ...f.subject, userId: "bob" }, next = await mcpFixtureExchange(second, f.owner, other, "auth", f.name);
      expect(next.authorization.authorizationKey).not.toBe(grant.authorization.authorizationKey);
      expect(next.claim.clientMaterial).toBeNull();
    } else expect(() => mcpFixtureAccess(f.owner, { ...f.subject, userId: "bob" }, "manage")).toThrow(M.McpRegistryIntegrityError);
  });
  it("two independent pools issue only one registration claim and one durable sending transition", async () => {
    const f = fixture(), view = await first.upsertMcpRegistration(f.input), request = { ...f.ref, configVersionId: view.version.configVersionId, expectedRevision: 1, idempotencyKey: "register", operationTimeoutMs: 30000 };
    const claims = await Promise.all([first.prepareMcpDynamicClient(request), second.prepareMcpDynamicClient({ ...request, operationTimeoutMs: 29000 })]);
    expect(claims.filter(c => c.claimToken !== null)).toHaveLength(1); expect(new Set(claims.map(c => c.operation.operationId)).size).toBe(1);
    const winner = claims.find(c => c.claimToken !== null)!;
    const op = { ...f.ref, operationId: winner.operation.operationId, claimToken: winner.claimToken! };
    const sends = await Promise.allSettled([first.markMcpDynamicClientSending(op), second.markMcpDynamicClientSending(op)]);
    expect(sends.map(r => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const done = await first.finishMcpDynamicClient({ ...op, result: mcpDcrSuccess(winner) });
    expect(await second.finishMcpDynamicClient({ ...op, result: mcpDcrSuccess(winner) })).toEqual(done);
    await expect(second.prepareMcpDynamicClient({ ...request, idempotencyKey: "new-key" })).rejects.toThrow(M.McpRegistryConflictError);
  });
  it("native unready user OAuth insertion is rejected without advancing a user projection", async () => {
    const f = fixture(), p = await prepare(f), registrationId = p.view.slot.registrationId;
    const subject = f.subject, record: M.McpUserAuthorization = { authorizationKey: M.mcpAuthorizationKey(registrationId, subject), registrationId, subject,
      configVersionId: p.view.version.configVersionId, registrationGeneration: 1, registrationRevision: 1, authorizationEpoch: 1, tokenRevision: 0,
      state: "pending", credentialVersionId: null, updatedAtMs: Date.now() };
    await expect(inspect!.query("INSERT INTO mcp_registry_authorizations (authorization_key,registration_id,subject_tenant_id,subject_user_id,record_json) VALUES (?,?,?,?,?)",
      [record.authorizationKey, registrationId, subject.tenantId, subject.userId, JSON.stringify(record)])).rejects.toThrow("MCP dynamic OAuth client is not ready");
    const [rows] = await inspect!.query<RowDataPacket[]>("SELECT authorization_key FROM mcp_registry_authorizations WHERE registration_id=?", [registrationId]); expect(rows).toEqual([]);
    await expect(second.getMcpAuthorizationContext({ ...f.ref, access: mcpFixtureAccess(f.owner, subject, "runtime") })).rejects.toThrow(M.McpRegistryConflictError);
  });
  it("a response-loss unknown is permanent and neither native nor store writes can upgrade it", async () => {
    const f = fixture(), p = await prepare(f); await first.markMcpDynamicClientSending(p.op);
    const unknown = await first.finishMcpDynamicClient({ ...p.op, result: { kind: "outcome_unknown" } });
    expect((await second.prepareMcpDynamicClient(p.request)).claimToken).toBeNull();
    expect(await second.finishMcpDynamicClient({ ...p.op, result: { kind: "outcome_unknown" } })).toEqual(unknown);
    await expect(second.finishMcpDynamicClient({ ...p.op, result: mcpDcrSuccess(p.claim) })).rejects.toThrow(M.McpRegistryConflictError);
    await expect(inspect!.query("UPDATE mcp_registry_dynamic_clients SET record_json=JSON_SET(record_json,'$.state','sending') WHERE operation_id=?", [unknown.operationId])).rejects.toThrow("MCP DCR transition or immutable identity is invalid");
  });
  it("register-result COMMIT failure rolls back ready and secret together on a real transaction", async () => {
    const f = fixture("client_secret_basic"), p = await prepare(f); await first.markMcpDynamicClientSending(p.op);
    const pool = Reflect.get(first, "pool") as Pool, conn = await pool.getConnection();
    const commit = vi.spyOn(conn, "commit").mockRejectedValueOnce(new Error("injected DCR COMMIT failure")), acquire = vi.spyOn(pool, "getConnection").mockResolvedValueOnce(conn);
    try { await expect(first.finishMcpDynamicClient({ ...p.op, result: mcpDcrSuccess(p.claim) })).rejects.toThrow("injected DCR COMMIT failure"); }
    finally { acquire.mockRestore(); commit.mockRestore(); }
    const row = await second.getMcpDynamicClient({ ...f.ref, configVersionId: p.view.version.configVersionId });
    expect(row?.state).toBe("sending"); expect(row?.clientMaterial).toBeNull();
    expect((await first.finishMcpDynamicClient({ ...p.op, result: { kind: "outcome_unknown" } })).state).toBe("outcome_unknown");
  });
  it("basic ready then disable then delete clears the old ciphertext without claiming remote revocation", async () => {
    const f = fixture("client_secret_basic"), r = await mcpDcrReady(first, f.input);
    await first.setMcpRegistrationState({ ...f.ref, expectedRevision: 1, state: "disabled", idempotencyKey: "disable" });
    await second.setMcpRegistrationState({ ...f.ref, expectedRevision: 2, state: "deleted", idempotencyKey: "delete" });
    const old = await first.getMcpDynamicClient({ ...f.ref, configVersionId: r.view.version.configVersionId });
    expect(old?.state).toBe("succeeded"); expect(old?.clientMaterial?.envelope).toBeNull(); expect(old?.clientId).toBe(r.operation.clientId);
  });
  it("basic disable-enable then explicit config replacement preserves old receipt and destroys only obsolete secret", async () => {
    const f = fixture("client_secret_basic"), r = await mcpDcrReady(first, f.input); await mcpFixtureExchange(first, f.owner, f.subject, "auth", f.name);
    await first.setMcpRegistrationState({ ...f.ref, expectedRevision: 1, state: "disabled", idempotencyKey: "disable" });
    await second.setMcpRegistrationState({ ...f.ref, expectedRevision: 2, state: "enabled", idempotencyKey: "enable" });
    const next = await first.upsertMcpRegistration(mcpDcrWrite(f.owner, f.subject, 3, "replace", "client_secret_basic", 1, f.name));
    expect(next.version.configVersionId).not.toBe(r.view.version.configVersionId);
    const old = await second.getMcpDynamicClient({ ...f.ref, configVersionId: r.view.version.configVersionId });
    expect(old?.resultSha256).toBe(r.operation.resultSha256); expect(old?.clientMaterial?.envelope).toBeNull();
    const conn = await (Reflect.get(second, "pool") as Pool).getConnection();
    try { await conn.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"); await conn.beginTransaction(); await assertMysqlMcpRegistryProjection(conn); await conn.commit(); }
    finally { await conn.rollback(); conn.release(); }
  });
  it("first-registers a re-enabled immutable basic intent at live revision and reuses its client after another disable-enable", async () => {
    const f = fixture("client_secret_basic"), view = await first.upsertMcpRegistration(f.input);
    await first.setMcpRegistrationState({ ...f.ref, expectedRevision: 1, state: "disabled", idempotencyKey: "disable" });
    await second.setMcpRegistrationState({ ...f.ref, expectedRevision: 2, state: "enabled", idempotencyKey: "enable" });
    const claim = await first.prepareMcpDynamicClient({ ...f.ref, configVersionId: view.version.configVersionId, expectedRevision: 3, idempotencyKey: "first-register", operationTimeoutMs: 30000 });
    expect(claim.operation.registrationRevision).toBe(3); expect(claim.registration).toEqual(view.version);
    const op = { ...f.ref, operationId: claim.operation.operationId, claimToken: claim.claimToken! }; await second.markMcpDynamicClientSending(op);
    const ready = await first.finishMcpDynamicClient({ ...op, result: mcpDcrSuccess(claim) }); expect(ready.clientMaterial?.aad.registrationRevision).toBe(3);
    expect((await mcpFixtureExchange(second, f.owner, f.subject, "auth", f.name)).authorization.registrationRevision).toBe(3);
    await first.setMcpRegistrationState({ ...f.ref, expectedRevision: 3, state: "disabled", idempotencyKey: "disable-ready" });
    await second.setMcpRegistrationState({ ...f.ref, expectedRevision: 4, state: "enabled", idempotencyKey: "enable-ready" });
    expect((await first.getMcpDynamicClient({ ...f.ref, configVersionId: view.version.configVersionId }))?.operationId).toBe(ready.operationId);
    expect((await mcpFixtureExchange(second, f.owner, f.subject, "later-auth", f.name)).authorization.registrationRevision).toBe(5);
    expect((await first.getMcpRegistration(f.ref))?.version).toEqual(view.version);
  });
  it("T1 user erasure fences both durable sending and native owner admission while preserving intent", async () => {
    const f = fixture(), p = await prepare(f);
    await first.requestUserErasure({ requestId: newErasureRequestId(), ...f.subject, requestedByKeyId: "fixture", idempotencyKey: randomUUID(), requestHash: userErasureRequestHash(f.subject.tenantId, f.subject.userId), atMs: Date.now() });
    await expect(second.markMcpDynamicClientSending(p.op)).rejects.toThrow(SubjectDeletingError);
    await expect(inspect!.query("UPDATE mcp_registry_dynamic_clients SET record_json=JSON_SET(record_json,'$.state','sending','$.sentAtMs',?) WHERE operation_id=?", [Date.now(), p.claim.operation.operationId])).rejects.toThrow("MCP owner is not active");
    const [rows] = await inspect!.query<RowDataPacket[]>("SELECT operation_state FROM mcp_registry_dynamic_clients WHERE operation_id=?", [p.claim.operation.operationId]); expect(rows).toEqual([{ operation_state: "prepared" }]);
  });
  it("owned dynamic client footprint blocks T3a but a platform-only intent does not block unrelated tenants", async () => {
    const { tenantErasureRequestHash } = await import("../src/subject-lifecycle.js");
    async function claim(tenantId: string) {
      const requestId = newErasureRequestId(); await first.requestTenantErasure({ requestId, tenantId, requestedByKeyId: "fixture", idempotencyKey: randomUUID(), requestHash: tenantErasureRequestHash(tenantId), atMs: Date.now() });
      const row = (await first.claimTenantCredentialRevocations({ limit: 100, leaseMs: 120000, claimToken: `dcr-${randomUUID()}` })).find(c => c.requestId === requestId); if (!row) fail();
      return { requestId: row.requestId, tenantId: row.tenantId, subjectGeneration: row.subjectGeneration, claimAttempt: row.claimAttempt, claimToken: row.claimToken };
    }
    const shared = fixture("none", "platform"); await prepare(shared);
    const unrelated = `unrelated-${randomUUID()}`; await first.createApiKey(unrelated, "fixture", createHash("sha256").update(randomUUID()).digest("hex"), ["admin"]);
    expect(await first.revokeTenantCredentialMaterial(await claim(unrelated))).not.toBeNull();
    const owned = fixture("none", "tenant"); await prepare(owned); await first.createApiKey(owned.subject.tenantId, "fixture", createHash("sha256").update(randomUUID()).digest("hex"), ["admin"]);
    await expect(first.revokeTenantCredentialMaterial(await claim(owned.subject.tenantId))).rejects.toThrow(M.McpRegistryLifecycleBlockedError);
  });
});
