import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MysqlSessionStore } from "../../src/index.js";
import { mkSession } from "../conformance.js";

const BASE_URL = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../migrations");
const MIGRATION = "0051_ordinary_session_delete_origin_guard.sql";
const TRIGGER = "trg_sessions_ordinary_delete_grace_bu";
type Row = RowDataPacket;

function disposableBase(raw: string): URL {
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:"
    || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || !/(?:^|[_-])(test|migration)(?:$|[_-])/i.test(database)) {
    throw new Error("MYSQL_MIGRATION_TEST_URL must target local disposable MySQL");
  }
  return url;
}

function databaseUrl(base: URL, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

describe("0050 -> 0051 ordinary DELETE origin write-once historical migration", () => {
  let admin: Connection;
  let base: URL;
  let oldDir: string;
  let currentDir: string;
  const databases = new Set<string>();

  beforeAll(async () => {
    base = disposableBase(BASE_URL);
    const adminUrl = new URL(base);
    adminUrl.pathname = "/";
    admin = await mysql.createConnection(adminUrl.toString());
    oldDir = await mkdtemp(join(tmpdir(), "agent-service-pre0051-"));
    currentDir = await mkdtemp(join(tmpdir(), "agent-service-through0051-"));
    const names = (await readdir(MIGRATIONS_DIR))
      .filter((name) => /^00\d\d_.*\.sql$/.test(name)).sort();
    expect(names).toContain("0050_ordinary_session_delete_grace.sql");
    expect(names).toContain(MIGRATION);
    for (const name of names) {
      if (Number(name.slice(0, 4)) <= 50) {
        await copyFile(join(MIGRATIONS_DIR, name), join(oldDir, name));
      }
      if (Number(name.slice(0, 4)) <= 51) {
        await copyFile(join(MIGRATIONS_DIR, name), join(currentDir, name));
      }
    }
  });

  afterAll(async () => {
    if (admin) {
      for (const database of databases) await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      await admin.end();
    }
    if (oldDir) await rm(oldDir, { recursive: true, force: true });
    if (currentDir) await rm(currentDir, { recursive: true, force: true });
  });

  async function create0050() {
    const database = `agent_service_migration_test_0051_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const [existing] = await admin.query<Row[]>(
      "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", [database],
    );
    if (existing.length) throw new Error("disposable 0051 fixture database already exists");
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    databases.add(database);
    const url = databaseUrl(base, database);
    const store = await MysqlSessionStore.connect({ url, migrationsDir: oldDir });
    await store.close();
    return url;
  }

  async function upgrade(url: string) {
    const store = await MysqlSessionStore.connect({ url, migrationsDir: currentDir });
    await store.close();
  }

  it("preserves sealed 0050 evidence and unknown tombstones without enabling purge", async () => {
    const url = await create0050();
    const old = await MysqlSessionStore.connect({ url, migrationsDir: oldDir, migrationMode: "verify" });
    const ordinary = mkSession(`tenant-origin-history-${randomUUID()}`,
      `user-origin-history-${randomUUID()}`);
    const unknown = mkSession(`tenant-origin-unknown-${randomUUID()}`,
      `user-origin-unknown-${randomUUID()}`);
    try {
      await old.createSession(ordinary);
      const ordinaryAtMs = Date.now();
      await old.commitOrdinarySessionDelete({
        sessionId: ordinary.id, fence: 1,
        lifecycle: { type: "tombstone", tenantId: ordinary.tenantId, userId: ordinary.userId,
          atMs: ordinaryAtMs, purgeAfterMs: null, deletionGeneration: 1 },
        events: [{ type: "session/deleted", sessionId: ordinary.id,
          emittedAtMs: ordinaryAtMs, deletionGeneration: 1 }],
      });
      await old.sealOrdinarySessionDeleteGrace(ordinary.tenantId, ordinary.userId, ordinary.id);
      await old.createSession(unknown);
      const unknownAtMs = Date.now();
      await old.commit({
        sessionId: unknown.id, fence: 1,
        lifecycle: { type: "tombstone", tenantId: unknown.tenantId, userId: unknown.userId,
          atMs: unknownAtMs, purgeAfterMs: null, deletionGeneration: 1 },
        events: [{ type: "session/deleted", sessionId: unknown.id,
          emittedAtMs: unknownAtMs, deletionGeneration: 1 }],
      });
    } finally {
      await old.close();
    }
    const conn = await mysql.createConnection(url);
    try {
      const [before] = await conn.query<Row[]>(
        `SELECT ordinary_delete_origin_sha256 AS origin_sha,
                ordinary_delete_seal_sha256 AS seal_sha,
                ordinary_delete_grace_floor_db_ms AS floor_ms
           FROM sessions WHERE session_id=?`, [ordinary.id],
      );
      await upgrade(url);
      const current = await MysqlSessionStore.connect({ url, migrationsDir: currentDir, migrationMode: "verify" });
      try {
        const [after] = await conn.query<Row[]>(
          `SELECT ordinary_delete_origin_sha256 AS origin_sha,
                  ordinary_delete_seal_sha256 AS seal_sha,
                  ordinary_delete_grace_floor_db_ms AS floor_ms,
                  purge_after_ms
             FROM sessions WHERE session_id=?`, [ordinary.id],
        );
        expect(after[0]).toMatchObject({ ...before[0], purge_after_ms: null });
        expect(await current.getOrdinarySessionDeleteGrace(ordinary.tenantId, ordinary.userId, ordinary.id))
          .toMatchObject({ state: "sealed", physicalPurgeEnabled: false, executionReady: false });
        expect(await current.getOrdinarySessionDeleteGrace(unknown.tenantId, unknown.userId, unknown.id))
          .toEqual({ state: "unknown", physicalPurgeEnabled: false, executionReady: false });
        await expect(conn.query(
          "UPDATE sessions SET ordinary_delete_seal_sha256=REPEAT('f',64) WHERE session_id=?",
          [ordinary.id],
        )).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION" });
        await expect(conn.query(
          `UPDATE sessions SET ordinary_delete_origin_sha256=REPEAT('e',64),
                  ordinary_delete_origin_observed_db_ms=? WHERE session_id=?`,
          [Date.now(), unknown.id],
        )).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION" });
        const [markers] = await conn.query<Row[]>(
          "SELECT name FROM schema_migrations WHERE name=?", [MIGRATION],
        );
        expect(markers).toHaveLength(1);
      } finally {
        await current.close();
      }
    } finally {
      await conn.end();
    }
  });

  it("replays exact committed trigger DDL after marker loss, but rejects a changed action", async () => {
    const url = await create0050();
    await upgrade(url);
    const conn = await mysql.createConnection(url);
    try {
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION]);
      await upgrade(url);
      const [markers] = await conn.query<Row[]>(
        "SELECT name FROM schema_migrations WHERE name=?", [MIGRATION],
      );
      expect(markers).toHaveLength(1);

      await conn.query(`DROP TRIGGER \`${TRIGGER}\``);
      await conn.query(`CREATE TRIGGER \`${TRIGGER}\` BEFORE UPDATE ON sessions FOR EACH ROW
        BEGIN SET NEW.title=NEW.title; END`);
      await expect(MysqlSessionStore.connect({ url, migrationsDir: currentDir,
        migrationMode: "verify" })).rejects.toThrow(/0051 ordinary DELETE origin guard fingerprint/);
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION]);
      await expect(upgrade(url)).rejects.toMatchObject({
        message: `migration ${MIGRATION} failed at statement 1/1`,
        cause: expect.objectContaining({ message: "0051 ordinary DELETE origin guard is not exact" }),
      });
      const [stillMissing] = await conn.query<Row[]>(
        "SELECT name FROM schema_migrations WHERE name=?", [MIGRATION],
      );
      expect(stillMissing).toHaveLength(0);
    } finally {
      await conn.end();
    }
  });
});
