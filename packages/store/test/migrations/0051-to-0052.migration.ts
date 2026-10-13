import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type Pool, type PoolConnection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MysqlSessionStore } from "../../src/index.js";
import { mkSession } from "../conformance.js";

const BASE = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), "../../migrations");
const NAME = "0052_ordinary_session_usage_retention.sql";

describe("0051 -> 0052 ordinary usage retention real historical migration", () => {
  let admin: Connection;
  let base: URL;
  let oldDir: string;
  let currentDir: string;
  const databases = new Set<string>();
  beforeAll(async () => {
    base = new URL(BASE);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
      || !/(?:^|[_-])(test|migration)(?:$|[_-])/i.test(base.pathname)) throw new Error("migration fixture requires local disposable MySQL");
    const adminUrl = new URL(base); adminUrl.pathname = "/mysql";
    admin = await mysql.createConnection(adminUrl.toString());
    oldDir = await mkdtemp(join(tmpdir(), "agent-service-through0051-"));
    currentDir = await mkdtemp(join(tmpdir(), "agent-service-through0052-"));
    const names = (await readdir(MIGRATIONS)).filter((v) => /^00\d\d_.*\.sql$/.test(v)).sort();
    expect(names).toContain(NAME);
    for (const name of names) {
      if (Number(name.slice(0, 4)) <= 51) await copyFile(join(MIGRATIONS, name), join(oldDir, name));
      if (Number(name.slice(0, 4)) <= 52) await copyFile(join(MIGRATIONS, name), join(currentDir, name));
    }
  });
  afterAll(async () => {
    if (admin) { for (const database of databases) await admin.query(`DROP DATABASE IF EXISTS \`${database}\``); await admin.end(); }
    if (oldDir) await rm(oldDir, { recursive: true, force: true });
    if (currentDir) await rm(currentDir, { recursive: true, force: true });
  });
  async function history() {
    const database = `agent_service_migration_test_0052_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const [existing] = await admin.query<RowDataPacket[]>("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", [database]);
    if (existing.length) throw new Error("0052 history fixture database already exists");
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`); databases.add(database);
    const dbUrl = new URL(base); dbUrl.pathname = `/${database}`; const url = dbUrl.toString();
    const old = await MysqlSessionStore.connect({ url, migrationsDir: oldDir });
    const session = mkSession(`tenant-history0051-${randomUUID()}`, `user-history0051-${randomUUID()}`);
    await old.createSession(session);
    const atMs = Date.now();
    await old.commitOrdinarySessionDelete({ sessionId: session.id, fence: 1,
      lifecycle: { type: "tombstone", tenantId: session.tenantId, userId: session.userId,
        atMs, purgeAfterMs: null, deletionGeneration: 1 },
      events: [{ type: "session/deleted", sessionId: session.id, emittedAtMs: atMs, deletionGeneration: 1 }],
    });
    await old.sealOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id);
    await old.close();
    return { url, session };
  }
  async function upgrade(url: string) { const s = await MysqlSessionStore.connect({ url, migrationsDir: currentDir }); await s.close(); }

  it("preserves real sealed 0051 source and never retroactively supplies policy/receipt", async () => {
    const f = await history(); const conn = await mysql.createConnection(f.url);
    try {
      const [before] = await conn.query<RowDataPacket[]>("SELECT ordinary_delete_origin_sha256 AS origin,ordinary_delete_seal_sha256 AS seal,ordinary_delete_grace_floor_db_ms AS floor FROM sessions WHERE session_id=?", [f.session.id]);
      const [beforeTriggers] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM information_schema.triggers WHERE trigger_schema=DATABASE()");
      await upgrade(f.url);
      const [after] = await conn.query<RowDataPacket[]>("SELECT ordinary_delete_origin_sha256 AS origin,ordinary_delete_seal_sha256 AS seal,ordinary_delete_grace_floor_db_ms AS floor,ordinary_usage_retention_source_json AS source,ordinary_usage_retention_receipt_json AS receipt,purge_after_ms FROM sessions WHERE session_id=?", [f.session.id]);
      expect(after[0]).toMatchObject({ ...before[0], source: null, receipt: null, purge_after_ms: null });
      const current = await MysqlSessionStore.connect({ url: f.url, migrationsDir: currentDir });
      try {
        expect(await current.listOrdinarySessionUsageRetentionCandidates({ limit: 25 })).toEqual([]);
        expect(await current.executeOrdinarySessionUsageRetention({ tenantId: f.session.tenantId, userId: f.session.userId,
          sessionId: f.session.id, deletionGeneration: 1, expectedChecksum: "a".repeat(64), enabled: true })).toBeNull();
        await current.sealOrdinarySessionDeleteGrace(f.session.tenantId, f.session.userId, f.session.id);
        const [unchanged] = await conn.query<RowDataPacket[]>("SELECT ordinary_usage_retention_source_json AS source FROM sessions WHERE session_id=?", [f.session.id]);
        expect(unchanged[0]?.source).toBeNull();
        // Exercise the exact pre-0052 fingerprint mode, not just the missing SQL file check.
        const legacyVerifier = current as unknown as { pool: Pool; assertTenantTelemetryCaptureV2Fingerprint(
          connection: PoolConnection, dir: string, with0051: boolean, with0052: boolean): Promise<void> };
        const proofConnection = await legacyVerifier.pool.getConnection();
        try { await expect(legacyVerifier.assertTenantTelemetryCaptureV2Fingerprint(proofConnection, oldDir, true, false)).rejects.toThrow(/0049.*fingerprint/); }
        finally { proofConnection.release(); }
      } finally { await current.close(); }
      // An explicitly old migration directory cannot verify the new schema. This SQL-shaped
      // history fixture does not pretend to be a frozen pre-0052 executable.
      await expect(MysqlSessionStore.connect({ url: f.url, migrationsDir: oldDir, migrationMode: "verify" })).rejects.toThrow(/0049.*fingerprint|0052|ENOENT/);
      const [triggers] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM information_schema.triggers WHERE trigger_schema=DATABASE()");
      expect(Number(triggers[0]?.n)).toBe(Number(beforeTriggers[0]?.n) + 5);
      const [newGuards] = await conn.query<RowDataPacket[]>("SELECT trigger_name AS name FROM information_schema.triggers WHERE trigger_schema=DATABASE() AND trigger_name IN ('trg_sessions_usage_retention_bi','trg_sessions_usage_retention_shape_bu','trg_sessions_usage_retention_bu','trg_t3f_prior_usage_retention_bi','trg_session_grave_usage_retention_bi') ORDER BY trigger_name");
      expect(newGuards).toHaveLength(5);
    } finally { await conn.end(); }
  });

  it("recovers exact committed 0052 DDL after marker loss, rejects drift, and never rebinds old origin", async () => {
    const f = await history(); const conn = await mysql.createConnection(f.url);
    try {
      await upgrade(f.url);
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [NAME]);
      await upgrade(f.url);
      const [markers] = await conn.query<RowDataPacket[]>("SELECT name FROM schema_migrations WHERE name=?", [NAME]); expect(markers).toHaveLength(1);
      const source = { schemaVersion: 2, originSha256: "a".repeat(64), policyVersion: null, policySha256: null };
      await expect(conn.query("UPDATE sessions SET ordinary_usage_retention_source_json=?,ordinary_usage_retention_source_sha256=? WHERE session_id=?", [JSON.stringify(source), "b".repeat(64), f.session.id])).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION" });
      await conn.query("DROP TRIGGER trg_sessions_usage_retention_shape_bu");
      await conn.query("CREATE TRIGGER trg_sessions_usage_retention_shape_bu BEFORE UPDATE ON sessions FOR EACH ROW BEGIN SET NEW.title=NEW.title; END");
      await expect(MysqlSessionStore.connect({ url: f.url, migrationsDir: currentDir, migrationMode: "verify" })).rejects.toThrow(/0052.*fingerprint/);
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [NAME]);
      await expect(upgrade(f.url)).rejects.toMatchObject({ cause: expect.objectContaining({ message: "0052 ordinary usage retention trigger is not exact" }) });
    } finally { await conn.end(); }
  });
});
