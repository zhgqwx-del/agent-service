import { createHash, randomUUID } from "node:crypto";
import mysql, { type Connection, type Pool, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MysqlSessionStore } from "../src/mysql/store.js";
import * as M from "../src/mcp-registry.js";
import { newErasureRequestId, SubjectDeletingError, tenantErasureRequestHash, userErasureRequestHash } from "../src/subject-lifecycle.js";
import { mcpFixtureAccess, mcpFixtureBegin, mcpFixtureExchange, mcpFixtureMaterial, mcpFixtureWrite } from "./fixtures/mcp-registry.js";

const baseInput = process.env.MYSQL_TEST_URL ?? "mysql://root@127.0.0.1:3306/agent_service_test";
function base() { const url = new URL(baseInput); if (url.protocol !== "mysql:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/(?:^|[_-])test(?:$|[_-])/i.test(decodeURIComponent(url.pathname.slice(1)))) throw new Error("MCP fixture requires local disposable MySQL"); return url; }
function at(url: URL, database: string) { const next = new URL(url); next.pathname = `/${database}`; return next.toString(); }
function cleanupFailure(): never { throw new Error("MCP fixture cleanup is not proven"); }
function remaining(deadline: number) { const left = Math.floor(deadline - performance.now()); if (left <= 0) cleanupFailure(); return left; }
async function dropOwned(admin: Connection, database: string, uuid: string, adminId: number, deadline: number) {
  if (!/^agent_service_mcp_registry_test_[0-9]+_[a-f0-9]{12}$/.test(database)) cleanupFailure();
  const query = async (sql: string, parameters: (string | number)[] = []) => { const [rows] = await admin.query<RowDataPacket[]>({ sql, timeout: remaining(deadline) }, parameters); remaining(deadline); return rows; };
  const identity = await query("SELECT @@server_uuid AS uuid,CONNECTION_ID() AS id,DATABASE() AS db");
  if (identity.length !== 1 || String(identity[0]?.uuid).toLowerCase() !== uuid || Number(identity[0]?.id) !== adminId || identity[0]?.db !== "mysql") cleanupFailure();
  for (;;) {
    const refs = [await query("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE BINARY DB=BINARY ?", [database]),
      await query("SELECT COUNT(*) AS n FROM information_schema.INNODB_TRX t JOIN information_schema.PROCESSLIST p ON p.ID=t.trx_mysql_thread_id WHERE BINARY p.DB=BINARY ?", [database]),
      await query("SELECT COUNT(*) AS n FROM performance_schema.metadata_locks WHERE BINARY OBJECT_SCHEMA=BINARY ? OR (OBJECT_TYPE='SCHEMA' AND BINARY OBJECT_NAME=BINARY ?)", [database, database])];
    const counts = refs.map(rows => rows.length === 1 ? Number(rows[0]?.n) : Number.NaN);
    if (counts.some(n => !Number.isSafeInteger(n) || n < 0)) cleanupFailure(); if (counts.every(n => n === 0)) break;
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(10, remaining(deadline))));
  }
  const before = await query("SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", [database]);
  if (before.length !== 1 || before[0]?.name !== database) cleanupFailure();
  await admin.query({ sql: `DROP DATABASE \`${database}\``, timeout: remaining(deadline) });
  if ((await query("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", [database])).length) cleanupFailure();
}

describe.skipIf(!process.env.AGENT_SERVICE_INTEGRATION)("MCP registry isolated actual MySQL", () => {
  let admin: Connection, inspect: Connection, store: MysqlSessionStore, second: MysqlSessionStore;
  let database = "", uuid = "", adminId = 0, setupComplete = false, created = false;
  beforeAll(async () => {
    const deadline = performance.now() + 120_000, source = base(); admin = await mysql.createConnection(at(source, "mysql"));
    const [identity] = await admin.query<RowDataPacket[]>("SELECT @@server_uuid AS uuid,CONNECTION_ID() AS id,DATABASE() AS db");
    uuid = String(identity[0]?.uuid).toLowerCase(); adminId = Number(identity[0]?.id);
    if (identity.length !== 1 || !/^[a-f0-9-]{36}$/.test(uuid) || !Number.isSafeInteger(adminId) || adminId < 1 || identity[0]?.db !== "mysql") cleanupFailure();
    database = `agent_service_mcp_registry_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const [existing] = await admin.query<RowDataPacket[]>("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", [database]); if (existing.length) cleanupFailure();
    remaining(deadline); await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`); created = true;
    const url = at(source, database); store = await MysqlSessionStore.connect({ url, connectionLimit: 4 }); second = await MysqlSessionStore.connect({ url, migrationMode: "verify", connectionLimit: 4 });
    inspect = await mysql.createConnection(url); const [target] = await inspect.query<RowDataPacket[]>("SELECT @@server_uuid AS uuid,DATABASE() AS db");
    if (target.length !== 1 || String(target[0]?.uuid).toLowerCase() !== uuid || target[0]?.db !== database) cleanupFailure(); remaining(deadline); setupComplete = true;
  }, 120_000);
  afterAll(async ({}, suite) => {
    const deadline = performance.now() + 120_000;
    const passed = setupComplete && suite.tasks.length === 12 && suite.tasks.every(t => t.type === "test" && t.mode === "run" && t.result?.state === "pass" && !t.result.errors?.length && (t.result.retryCount ?? 0) === 0 && (t.result.repeatCount ?? 0) === 0 && typeof t.result.duration === "number" && t.result.duration <= 30_000);
    let removed = false;
    try {
      const closed = await Promise.allSettled([store?.close(), second?.close(), inspect?.end()]); if (closed.some(r => r.status !== "fulfilled")) cleanupFailure();
      if (created && passed) { await dropOwned(admin, database, uuid, adminId, deadline); removed = true; }
    } finally { if (created && !removed) console.warn(JSON.stringify({ schema: "mcp-registry-fixture-cleanup-v1", status: "retained_or_unknown", database })); await admin?.end(); }
  }, 120_000);
  function fixture(scope: M.McpRegistrationOwner["scope"] = "user") {
    const subject = { tenantId: `mcp-${randomUUID()}`, userId: "user" }, owner: M.McpRegistrationOwner = { scope, tenantId: scope === "platform" ? null : subject.tenantId, userId: scope === "user" ? subject.userId : null };
    const name = `server-${randomUUID()}`, input = mcpFixtureWrite(owner, subject, 0, "install", undefined, 1, name), ref = { access: mcpFixtureAccess(owner, subject, "runtime"), owner, name };
    return { subject, owner, input, ref, name };
  }
  it.each(["platform", "tenant", "user"] as const)("publishes independent %s config and real subject exchange without shared token inheritance", async scope => {
    const f = fixture(scope), slot = await store.upsertMcpRegistration(f.input); expect(slot.version.configVersionId).toBe(slot.slot.currentVersionId); expect(await second.upsertMcpRegistration(f.input)).toEqual(slot);
    expect(await store.getMcpRuntimeAuthorization(f.ref)).toBeNull(); const grant = await mcpFixtureExchange(store, f.owner, f.subject, "authorize", f.name);
    expect((await second.getMcpRuntimeAuthorization(f.ref))?.credential?.credentialVersionId).toBe(grant.authorization.credentialVersionId);
    if (scope !== "user") expect(await second.getMcpRuntimeAuthorization({ ...f.ref, access: mcpFixtureAccess(f.owner, { ...f.subject, userId: "other" }, "runtime") })).toBeNull();
  });
  it("two real pools serialize current CAS and permanent delete/recreate revision without retry", async () => {
    const f = fixture(); const outcomes = await Promise.allSettled([store.upsertMcpRegistration(f.input), second.upsertMcpRegistration(mcpFixtureWrite(f.owner, f.subject, 0, "other", undefined, 1, f.name))]);
    expect(outcomes.map(o => o.status).sort()).toEqual(["fulfilled", "rejected"]);
    const gone = await store.setMcpRegistrationState({ access: f.input.access, owner: f.owner, name: f.name, expectedRevision: 1, idempotencyKey: "delete", state: "deleted" });
    await expect(second.upsertMcpRegistration(f.input)).rejects.toThrow(M.McpRegistryConflictError);
    const next = await second.upsertMcpRegistration(mcpFixtureWrite(f.owner, f.subject, gone.revision, "recreate", undefined, 2, f.name)); expect(next.slot.generation).toBe(2); expect(next.slot.revision).toBe(3); expect(next.version.configVersionId).toBe(next.slot.currentVersionId);
  });
  it("shared platform registration permits different actual users concurrently without global registration X", async () => {
    const f = fixture("platform"); await store.upsertMcpRegistration(f.input);
    const a = { tenantId: `中${randomUUID()}`, userId: "a" }, b = { tenantId: `文${randomUUID()}`, userId: "b" };
    const [first, last] = await Promise.all([mcpFixtureExchange(store, f.owner, a, "authorize", f.name), mcpFixtureExchange(second, f.owner, b, "authorize", f.name)]);
    expect(first.authorization.subject).toEqual(a); expect(last.authorization.subject).toEqual(b); expect(first.authorization.authorizationKey).not.toBe(last.authorization.authorizationKey);
    expect((await store.getMcpRuntimeAuthorization(first.ref))?.authorization?.subject).toEqual(a); expect((await second.getMcpRuntimeAuthorization(last.ref))?.authorization?.subject).toEqual(b);
  });
  it("single-use state and exact exchange result are durable across pools", async () => {
    const f = fixture(); await store.upsertMcpRegistration(f.input); const grant = await mcpFixtureExchange(store, f.owner, f.subject, "authorize", f.name);
    expect(await second.lookupMcpAuthorizationState(grant.pending.stateSha256)).toBeNull(); await expect(second.consumeMcpAuthorization(grant.consume)).rejects.toThrow(M.McpRegistryConflictError);
    expect(await second.finishMcpCredentialOperation(grant.finish)).toEqual(grant.authorization);
    const [replays] = await inspect.query<RowDataPacket[]>("SELECT subject_tenant_id,subject_user_id,authorization_epoch FROM mcp_registry_replays WHERE registration_id=? AND subject_tenant_id=?", [grant.authorization.registrationId, f.subject.tenantId]);
    expect(replays).toEqual([{ subject_tenant_id: f.subject.tenantId, subject_user_id: f.subject.userId, authorization_epoch: 1 }]);
    const key = M.mcpRegistryMutationReplaySelection(grant.input, M.MCP_REGISTRY_INPUT_FIELDS.begin)!.keySha256;
    const [before] = await inspect.query<RowDataPacket[]>("SELECT SHA2(CAST(record_json AS CHAR),256) AS digest FROM mcp_registry_replays WHERE key_sha256=?", [key]);
    await store.setMcpUserAuthorizationState({ ...f.ref, expectedAuthorizationEpoch: 1, state: "disconnected", idempotencyKey: "disconnect" });
    await expect(mcpFixtureBegin(second, f.owner, f.subject, "authorize", f.name)).rejects.toThrow(M.McpRegistryConflictError);
    const [after] = await inspect.query<RowDataPacket[]>("SELECT SHA2(CAST(record_json AS CHAR),256) AS digest FROM mcp_registry_replays WHERE key_sha256=?", [key]); expect(after).toEqual(before);
    expect((await mcpFixtureExchange(second, f.owner, f.subject, "new-key", f.name)).authorization.authorizationEpoch).toBe(3);
  });
  it("refresh predecessor single-flight and unknown clear the old pointer without tokenRevision rollback", async () => {
    const f = fixture(); await store.upsertMcpRegistration(f.input); const grant = await mcpFixtureExchange(store, f.owner, f.subject, "authorize", f.name);
    const input = { ...f.ref, expectedAuthorizationEpoch: 1, expectedTokenRevision: 1, expectedCredentialVersionId: grant.authorization.credentialVersionId!, operationTimeoutMs: 10000 };
    const outcomes = await Promise.allSettled([store.beginMcpRefresh(input), second.beginMcpRefresh(input)]); expect(outcomes.map(o => o.status).sort()).toEqual(["fulfilled", "rejected"]);
    const won = outcomes.find(o => o.status === "fulfilled"); if (won?.status !== "fulfilled") throw new Error("fixture winner missing");
    const unknown = await store.finishMcpCredentialOperation({ ...f.ref, operationId: won.value.operation.operationId, claimToken: won.value.claimToken, result: { kind: "outcome_unknown" } });
    expect(unknown.credentialVersionId).toBeNull(); expect(unknown.tokenRevision).toBe(1); expect(await second.getMcpRuntimeAuthorization(f.ref)).toBeNull();
    const [rows] = await inspect.query<RowDataPacket[]>("SELECT JSON_TYPE(JSON_EXTRACT(record_json,'$.envelope')) AS kind FROM mcp_registry_materials WHERE material_id=?", [grant.authorization.credentialVersionId]); expect(rows).toEqual([{ kind: "NULL" }]);
    await expect(second.beginMcpRefresh(input)).rejects.toThrow(M.McpRegistryConflictError);
  });
  it("actual writes roll back when COMMIT fails before publication", async () => {
    const f = fixture(), pool = Reflect.get(store, "pool") as Pool, conn = await pool.getConnection();
    const commit = vi.spyOn(conn, "commit").mockRejectedValueOnce(new Error("injected MCP commit failure")); const acquisition = vi.spyOn(pool, "getConnection").mockResolvedValueOnce(conn);
    try { await expect(store.upsertMcpRegistration(f.input)).rejects.toThrow("injected MCP commit failure"); } finally { acquisition.mockRestore(); commit.mockRestore(); }
    expect(await second.getMcpRegistration({ ...f.ref, access: f.input.access })).toBeNull();
  });
  it("real user erasure blocks hot reads, callback context and native active authorization writes", async () => {
    const f = fixture(); await store.upsertMcpRegistration(f.input); const grant = await mcpFixtureExchange(store, f.owner, f.subject, "authorize", f.name), pending = await mcpFixtureBegin(store, f.owner, f.subject, "next", f.name);
    await store.requestUserErasure({ requestId: newErasureRequestId(), ...f.subject, requestedByKeyId: "test", idempotencyKey: randomUUID(), requestHash: userErasureRequestHash(f.subject.tenantId, f.subject.userId), atMs: Date.now() });
    await expect(second.getMcpAuthorizationContext(f.ref)).rejects.toThrow(SubjectDeletingError); await expect(second.lookupMcpAuthorizationState(pending.pending.stateSha256)).rejects.toThrow(SubjectDeletingError);
    await expect(inspect.query("UPDATE mcp_registry_authorizations SET record_json=record_json WHERE authorization_key=?", [grant.authorization.authorizationKey])).rejects.toThrow("MCP credential subject is not active");
  });
  it("registration revision fences late callback and reauthorization remains usable after disable/enable", async () => {
    const f = fixture(); await store.upsertMcpRegistration(f.input); const begun = await mcpFixtureBegin(store, f.owner, f.subject, "authorize", f.name);
    await store.setMcpRegistrationState({ ...f.ref, access: f.input.access, expectedRevision: 1, idempotencyKey: "disable", state: "disabled" });
    await store.setMcpRegistrationState({ ...f.ref, access: f.input.access, expectedRevision: 2, idempotencyKey: "enable", state: "enabled" });
    expect(await second.lookupMcpAuthorizationState(begun.pending.stateSha256)).toBeNull();
    const grant = await mcpFixtureExchange(second, f.owner, f.subject, "new-revision", f.name); expect(grant.authorization.registrationRevision).toBe(3); expect(grant.authorization.authorizationEpoch).toBe(2);
  });
  it("a shared platform config does not globally block unrelated T3a but actual subject footprint does", async () => {
    const f = fixture("platform"); await store.upsertMcpRegistration(f.input);
    async function claim(tenantId: string) { const requestId = newErasureRequestId(); await store.requestTenantErasure({ requestId, tenantId, requestedByKeyId: "test", idempotencyKey: randomUUID(), requestHash: tenantErasureRequestHash(tenantId), atMs: Date.now() });
      const row = (await store.claimTenantCredentialRevocations({ limit: 100, leaseMs: 120000, claimToken: `mcp-${randomUUID()}` })).find(c => c.requestId === requestId); if (!row) throw new Error("MCP fixture T3a claim missing"); return { requestId: row.requestId, tenantId: row.tenantId, subjectGeneration: row.subjectGeneration, claimAttempt: row.claimAttempt, claimToken: row.claimToken }; }
    const unrelated = `unrelated-${randomUUID()}`; await store.createApiKey(unrelated, "test", createHash("sha256").update(randomUUID()).digest("hex"), ["admin"]);
    expect(await store.revokeTenantCredentialMaterial(await claim(unrelated))).not.toBeNull();
    await store.createApiKey(f.subject.tenantId, "test", createHash("sha256").update(randomUUID()).digest("hex"), ["admin"]);
    await mcpFixtureBegin(store, f.owner, f.subject, "authorize", f.name); await expect(store.revokeTenantCredentialMaterial(await claim(f.subject.tenantId))).rejects.toThrow(M.McpRegistryLifecycleBlockedError);
  });
  it("cold verify audits nonempty subject history after multiple epochs without renewing old code", async () => {
    const f = fixture(); await store.upsertMcpRegistration(f.input); const first = await mcpFixtureExchange(store, f.owner, f.subject, "authorize", f.name);
    await store.setMcpUserAuthorizationState({ ...f.ref, expectedAuthorizationEpoch: 1, idempotencyKey: "disconnect", state: "disconnected" });
    const next = await mcpFixtureExchange(store, f.owner, f.subject, "next", f.name); expect(next.authorization.authorizationEpoch).toBe(3);
    const [name] = await inspect.query<RowDataPacket[]>("SELECT DATABASE() AS db"); expect(name[0]?.db).toBe(database);
    // Use the actual startup audit in an independently owned RR transaction.
    const { assertMysqlMcpRegistryProjection } = await import("../src/mysql/mcp-registry.js");
    const conn = await (Reflect.get(second, "pool") as Pool).getConnection(); try { await conn.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"); await conn.beginTransaction(); await assertMysqlMcpRegistryProjection(conn); await conn.commit(); } finally { await conn.rollback(); conn.release(); }
    expect(await store.lookupMcpAuthorizationState(first.pending.stateSha256)).toBeNull(); expect(Boolean((await second.getMcpRuntimeAuthorization(next.ref))?.material?.envelope)).toBe(true);
  });
});
