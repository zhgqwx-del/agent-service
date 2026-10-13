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
const MIGRATION = "0050_ordinary_session_delete_grace.sql";
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

describe("0044 -> 0050 ordinary session DELETE grace historical migration", () => {
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
    oldDir = await mkdtemp(join(tmpdir(), "agent-service-pre0050-"));
    currentDir = await mkdtemp(join(tmpdir(), "agent-service-through0050-"));
    const names = (await readdir(MIGRATIONS_DIR)).filter((name) => /^00\d\d_.*\.sql$/.test(name)).sort();
    expect(names).toContain("0044_tenant_telemetry_pregrant_intent.sql");
    expect(names).toContain(MIGRATION);
    for (const name of names) {
      if (Number(name.slice(0, 4)) <= 44) {
        await copyFile(join(MIGRATIONS_DIR, name), join(oldDir, name));
      }
      if (Number(name.slice(0, 4)) <= 50) {
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

  async function create0044() {
    const database = `agent_service_migration_test_0050_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const [existing] = await admin.query<Row[]>(
      "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", [database],
    );
    if (existing.length) throw new Error("disposable 0050 fixture database already exists");
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    databases.add(database);
    const url = databaseUrl(base, database);
    const store = await MysqlSessionStore.connect({ url, migrationsDir: oldDir });
    await store.close();
    return { database, url };
  }

  async function upgrade(url: string) {
    const store = await MysqlSessionStore.connect({ url, migrationsDir: currentDir });
    await store.close();
  }

  it("preserves old tombstones as unknown; no backfill or physical scheduling", async () => {
    const { url } = await create0044();
    const old = await MysqlSessionStore.connect({ url, migrationsDir: oldDir });
    const session = mkSession(`tenant-grace-history-${randomUUID()}`,
      `user-grace-history-${randomUUID()}`);
    try {
      await old.createSession(session);
      const atMs = Date.now();
      await old.commit({
        sessionId: session.id, fence: 1,
        lifecycle: { type: "tombstone", tenantId: session.tenantId, userId: session.userId,
          atMs, purgeAfterMs: null, deletionGeneration: 1 },
        events: [{ type: "session/deleted", sessionId: session.id,
          emittedAtMs: atMs, deletionGeneration: 1 }],
      });
    } finally {
      await old.close();
    }
    await upgrade(url);
    const current = await MysqlSessionStore.connect({ url, migrationsDir: currentDir });
    const conn = await mysql.createConnection(url);
    try {
      expect(await current.getOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id))
        .toEqual({ state: "unknown", executionReady: false, physicalPurgeEnabled: false });
      await current.sealOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id);
      const [rows] = await conn.query<Row[]>(
        `SELECT ordinary_delete_origin_sha256,ordinary_delete_seal_sha256,
                ordinary_delete_grace_floor_db_ms,purge_after_ms
           FROM sessions WHERE session_id=?`,
        [session.id],
      );
      expect(rows[0]).toMatchObject({ ordinary_delete_origin_sha256: null,
        ordinary_delete_seal_sha256: null, ordinary_delete_grace_floor_db_ms: null,
        purge_after_ms: null });
      const [outbox] = await conn.query<Row[]>(
        "SELECT available_at_ms FROM lifecycle_outbox WHERE topic='session.purge' AND aggregate_id=?",
        [session.id],
      );
      expect(outbox[0]?.available_at_ms).toBeNull();
      // A pre-0050-shaped writer can still use nullable additive columns during rollout;
      // its new-schema tombstone remains unknown, never inferred or backfilled.
      const mixed = mkSession(`tenant-grace-mixed-${randomUUID()}`,
        `user-grace-mixed-${randomUUID()}`);
      await current.createSession(mixed);
      const mixedAtMs = Date.now();
      await current.commit({
        sessionId: mixed.id, fence: 1,
        lifecycle: { type: "tombstone", tenantId: mixed.tenantId, userId: mixed.userId,
          atMs: mixedAtMs, purgeAfterMs: null, deletionGeneration: 1 },
        events: [{ type: "session/deleted", sessionId: mixed.id,
          emittedAtMs: mixedAtMs, deletionGeneration: 1 }],
      });
      expect(await current.getOrdinarySessionDeleteGrace(mixed.tenantId, mixed.userId, mixed.id))
        .toEqual({ state: "unknown", executionReady: false, physicalPurgeEnabled: false });
    } finally {
      await current.close();
      await conn.end();
    }
  });

  it("converges after an empty first-column DDL interruption and rejects malformed shape", async () => {
    const partial = await create0044();
    const conn = await mysql.createConnection(partial.url);
    try {
      await conn.query(
        "ALTER TABLE sessions ADD COLUMN ordinary_delete_origin_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL",
      );
      await upgrade(partial.url);
      const [markers] = await conn.query<Row[]>(
        "SELECT name FROM schema_migrations WHERE name=?", [MIGRATION],
      );
      expect(markers).toHaveLength(1);
    } finally {
      await conn.end();
    }
    const conflict = await create0044();
    const bad = await mysql.createConnection(conflict.url);
    try {
      await bad.query("ALTER TABLE sessions ADD COLUMN ordinary_delete_origin_sha256 VARCHAR(64) NULL");
      await expect(upgrade(conflict.url)).rejects.toThrow(/fingerprint/);
    } finally {
      await bad.end();
    }
  });

  it("rejects marker loss after durable origin instead of silently adopting it", async () => {
    const { url } = await create0044();
    await upgrade(url);
    const store = await MysqlSessionStore.connect({ url, migrationsDir: currentDir });
    const conn = await mysql.createConnection(url);
    const session = mkSession(`tenant-grace-marker-${randomUUID()}`,
      `user-grace-marker-${randomUUID()}`);
    try {
      await store.createSession(session);
      const atMs = Date.now();
      await store.commitOrdinarySessionDelete({
        sessionId: session.id, fence: 1,
        lifecycle: { type: "tombstone", tenantId: session.tenantId, userId: session.userId,
          atMs, purgeAfterMs: null, deletionGeneration: 1,
        },
        events: [{ type: "session/deleted", sessionId: session.id,
          emittedAtMs: atMs, deletionGeneration: 1 }],
      });
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION]);
      await expect(upgrade(url)).rejects.toThrow(/marker-loss.*durable ordinary DELETE/);
      const [rows] = await conn.query<Row[]>(
        "SELECT ordinary_delete_origin_sha256 FROM sessions WHERE session_id=?", [session.id],
      );
      expect(String(rows[0]?.ordinary_delete_origin_sha256)).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await conn.end();
      await store.close();
    }
  });
});
