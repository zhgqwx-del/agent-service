import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MysqlSessionStore, SkillRegistryIntegrityError } from "../src/index.js";
import { mkSession } from "./conformance.js";

const ACK = "all-application-writers-stopped-v1" as const;
const REF_KEY = Buffer.alloc(32, 0x63); // Fixture-only; never a runtime/operator input.
const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));
const MIGRATION = "0064_subagents.sql";
function fail(): never { throw new Error("Schema operation isolated MySQL fixture is not proven."); }
function base() {
  const url = new URL(process.env.MYSQL_TEST_URL ?? "mysql://invalid/");
  if (url.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.search || url.hash || !/(?:^|[_-])test(?:$|[_-])/i.test(decodeURIComponent(url.pathname.slice(1)))) fail();
  return url;
}
function at(url: URL, database: string) { const copy = new URL(url); copy.pathname = `/${database}`; return copy.toString(); }
function digest(text: string) { return createHash("sha256").update(text).digest("hex"); }

describe.skipIf(!process.env.AGENT_SERVICE_INTEGRATION)("one-shot schema operation on actual isolated MySQL", () => {
  let admin: Connection | undefined, inspect: Connection | undefined, source: URL;
  let database = "", emptyDatabase = "", uuid = "", adminId = 0, inspectId = 0, ready = false;
  const owned = new Set<string>();
  function connection() { if (!inspect) return fail(); return inspect; }
  async function operation(kind: "migrate" | "verify", target = database, timeoutMs = 20_000) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try { return await MysqlSessionStore.runSchemaOperation({ url: at(source, target), operation: kind,
      operationAbortSignal: controller.signal, ...(kind === "migrate" ? { fleetStoppedAck: ACK } : {}),
      migrationLockTimeoutSeconds: 1 }); }
    finally { clearTimeout(timer); }
  }
  beforeAll(async () => {
    source = base(); admin = await mysql.createConnection(at(source, "mysql"));
    const [identity] = await admin.query<RowDataPacket[]>("SELECT @@server_uuid AS uuid,CONNECTION_ID() AS id,DATABASE() AS db");
    uuid = String(identity[0]?.uuid).toLowerCase(); adminId = Number(identity[0]?.id);
    if (identity.length !== 1 || !/^[a-f0-9-]{36}$/.test(uuid) || !Number.isSafeInteger(adminId) || adminId < 1 || identity[0]?.db !== "mysql") fail();
    database = `agent_service_schema_operation_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    emptyDatabase = `${database}_empty`;
    for (const name of [database, emptyDatabase]) {
      if (!/^agent_service_schema_operation_test_[0-9]+_[a-f0-9]{12}(?:_empty)?$/.test(name)) fail();
      const [existing] = await admin.query<RowDataPacket[]>("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", [name]);
      if (existing.length) fail();
      await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`); owned.add(name);
    }
    expect(await operation("migrate", database, 110_000)).toBeUndefined();
    inspect = await mysql.createConnection(at(source, database));
    const [actual] = await inspect.query<RowDataPacket[]>("SELECT @@server_uuid AS uuid,CONNECTION_ID() AS id,DATABASE() AS db");
    inspectId = Number(actual[0]?.id);
    if (actual.length !== 1 || String(actual[0]?.uuid).toLowerCase() !== uuid || actual[0]?.db !== database
      || !Number.isSafeInteger(inspectId) || inspectId < 1) fail();
    ready = true;
  }, 120_000);
  afterAll(async ({}, suite) => {
    const deadline = performance.now() + 120_000;
    const passed = ready && suite.tasks.length === 6 && suite.tasks.every(task => task.type === "test" && task.mode === "run"
      && task.result?.state === "pass" && !task.result.errors?.length && (task.result.retryCount ?? 0) === 0
      && (task.result.repeatCount ?? 0) === 0 && typeof task.result.duration === "number" && task.result.duration <= 30_000);
    const removed: string[] = [];
    try {
      await inspect?.end(); inspect = undefined;
      if (passed) {
        if (!admin) fail();
        const query = async (sql: string, values: string[] = []) => {
          const timeout = Math.floor(deadline - performance.now()); if (timeout <= 0 || !admin) return fail();
          const [rows] = await admin.query<RowDataPacket[]>({ sql, timeout }, values);
          if (performance.now() >= deadline) fail(); return rows;
        };
        for (const name of owned) {
          if (name !== database && name !== emptyDatabase || !/^agent_service_schema_operation_test_[0-9]+_[a-f0-9]{12}(?:_empty)?$/.test(name)) fail();
          const identity = await query("SELECT @@server_uuid AS uuid,CONNECTION_ID() AS id,DATABASE() AS db");
          if (identity.length !== 1 || String(identity[0]?.uuid).toLowerCase() !== uuid || Number(identity[0]?.id) !== adminId || identity[0]?.db !== "mysql") fail();
          for (;;) {
            const refs = [await query("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE BINARY DB=BINARY ?", [name]),
              await query("SELECT COUNT(*) AS n FROM information_schema.INNODB_TRX t JOIN information_schema.PROCESSLIST p ON p.ID=t.trx_mysql_thread_id WHERE BINARY p.DB=BINARY ?", [name]),
              await query("SELECT COUNT(*) AS n FROM performance_schema.metadata_locks WHERE BINARY OBJECT_SCHEMA=BINARY ? OR (OBJECT_TYPE='SCHEMA' AND BINARY OBJECT_NAME=BINARY ?)", [name, name])];
            const counts = refs.map(rows => rows.length === 1 ? Number(rows[0]?.n) : Number.NaN);
            if (counts.some(n => !Number.isSafeInteger(n) || n < 0)) fail(); if (counts.every(n => n === 0)) break;
            if (performance.now() >= deadline) fail(); await new Promise(resolve => setTimeout(resolve, 10));
          }
          if ((await query("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", [name])).length !== 1) fail();
          await admin.query({ sql: `DROP DATABASE \`${name}\``, timeout: Math.max(1, Math.floor(deadline - performance.now())) });
          if ((await query("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", [name])).length) fail();
          removed.push(name);
        }
      }
    } finally {
      const retained = [...owned].filter(name => !removed.includes(name));
      if (retained.length) console.warn(JSON.stringify({ schema: "schema-operation-fixture-cleanup-v1", status: "retained_or_unknown", databases: retained }));
      await admin?.end();
    }
  }, 120_000);

  it("applies the actual complete migration set, then verifies without exposing a Store or activating controls", async () => {
    expect(await operation("verify")).toBeUndefined();
    const files = (await readdir(MIGRATIONS)).filter(name => name.endsWith(".sql")).sort();
    const [markers] = await connection().query<RowDataPacket[]>("SELECT name FROM schema_migrations ORDER BY BINARY name");
    expect(markers.map(row => row.name)).toEqual(files);
    const [controls] = await connection().query<RowDataPacket[]>(`SELECT singleton_id,control_generation,activated_at_db_ms,
      lifecycle_protocol,writer_protocol,ref_key_id_sha256,target_count,target_root_sha256,activation_evidence_sha256
      FROM tenant_telemetry_lifecycle_control`);
    expect(controls).toEqual([{ singleton_id: 1, control_generation: 0, activated_at_db_ms: null,
      lifecycle_protocol: null, writer_protocol: null, ref_key_id_sha256: null,
      target_count: null, target_root_sha256: null, activation_evidence_sha256: null }]);
  });

  it("verify of an empty existing database fails without creating schema_migrations or any other table", async () => {
    await expect(operation("verify", emptyDatabase)).rejects.toMatchObject({ code: "ER_NO_SUCH_TABLE" });
    const [tables] = await connection().query<RowDataPacket[]>("SELECT TABLE_NAME FROM information_schema.TABLES WHERE BINARY TABLE_SCHEMA=BINARY ?", [emptyDatabase]);
    expect(tables).toEqual([]);
  });

  it("omits only runtime key admission while ordinary cold connects still require the real active ref key", async () => {
    const store = await MysqlSessionStore.connect({ url: at(source, database), migrationMode: "verify", tenantTelemetryRefKey: REF_KEY, connectionLimit: 1 });
    const session = mkSession(`schema-operation-${randomUUID()}`, "schema-owner");
    try {
      await store.createSession(session);
      await store.activateTenantTelemetryLifecycle({ expectedControlGeneration: 0,
        targets: ["logs", "traces"].map(domain => ({ domain: domain as "logs" | "traces", backendKind: "test_sink", adapterProtocol: "telemetry-test-v1",
          namespaceSha256: digest(`${domain}:schema-namespace`), failureDomainSha256: digest(`${domain}:schema-failure-domain`) })) });
    } finally { await store.close(); }
    const image = async () => {
      const result: unknown[] = [];
      for (const table of ["tenant_telemetry_lifecycle_control", "tenant_telemetry_lifecycle_targets", "tenant_telemetry_lifecycle_coverages", "tenant_telemetry_activation_receipts"]) {
        const [rows] = await connection().query<RowDataPacket[]>(`SELECT * FROM \`${table}\``); result.push(rows);
      }
      for (const table of ["sessions", "events"]) { const [rows] = await connection().query<RowDataPacket[]>(`SELECT * FROM \`${table}\` WHERE session_id=?`, [session.id]); result.push(rows); }
      return result;
    };
    const before = await image();
    expect(await operation("verify")).toBeUndefined(); expect(await operation("migrate")).toBeUndefined();
    expect(await image()).toEqual(before);
    for (const migrationMode of ["verify", "apply"] as const) {
      const outcome = await MysqlSessionStore.connect({ url: at(source, database), migrationMode, connectionLimit: 1 })
        .then(async unexpected => { await unexpected.close(); return unexpected; }, (error: unknown) => error);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe("active tenant telemetry lifecycle requires the exact stable ref key");
      expect(await image()).toEqual(before);
    }
  });

  it("rejects a lost current marker without adding it back or changing native guards", async () => {
    const [marker] = await connection().query<RowDataPacket[]>("SELECT name,applied_at_ms FROM schema_migrations WHERE name=?", [MIGRATION]);
    expect(marker).toHaveLength(1);
    const [before] = await connection().query<RowDataPacket[]>("SELECT TRIGGER_NAME,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY BINARY TRIGGER_NAME");
    await connection().query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION]);
    try {
      await expect(operation("verify")).rejects.toThrow("database schema is missing required migrations: 0064_subagents.sql");
      const [lost] = await connection().query<RowDataPacket[]>("SELECT name FROM schema_migrations WHERE name=?", [MIGRATION]); expect(lost).toEqual([]);
      const [after] = await connection().query<RowDataPacket[]>("SELECT TRIGGER_NAME,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY BINARY TRIGGER_NAME"); expect(after).toEqual(before);
    } finally { await connection().query("INSERT INTO schema_migrations(name,applied_at_ms) VALUES(?,?)", [marker[0]?.name, marker[0]?.applied_at_ms]); }
    expect(await operation("verify")).toBeUndefined();
  });

  it("rejects a genuinely missing current native guard without silently recreating it", async () => {
    const name = "trg_subagent_root_turns_bd";
    const [definitions] = await connection().query<RowDataPacket[]>(`SHOW CREATE TRIGGER \`${name}\``);
    const definition: unknown = definitions[0]?.["SQL Original Statement"];
    expect(typeof definition).toBe("string"); if (typeof definition !== "string") return fail();
    await connection().query(`DROP TRIGGER \`${name}\``);
    try {
      await expect(operation("verify")).rejects.toBeInstanceOf(SkillRegistryIntegrityError);
      const [missing] = await connection().query<RowDataPacket[]>("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND BINARY TRIGGER_NAME=BINARY ?", [name]); expect(missing).toEqual([]);
    } finally { await connection().query(definition); }
    expect(await operation("verify")).toBeUndefined();
  });

  it("cancels a real pending migration named-lock query and closes its native connection before settling", async () => {
    const [held] = await connection().query<RowDataPacket[]>("SELECT GET_LOCK(CONCAT('agent-service:migrate:',LEFT(SHA2(DATABASE(),256),32)),0) AS acquired");
    expect(Number(held[0]?.acquired)).toBe(1);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10_000);
    const running = MysqlSessionStore.runSchemaOperation({ url: at(source, database), operation: "migrate", fleetStoppedAck: ACK,
      operationAbortSignal: controller.signal, migrationLockTimeoutSeconds: 60 });
    const settled = Promise.allSettled([running]);
    try {
      const deadline = performance.now() + 5_000;
      for (;;) {
        const [waiting] = await connection().query<RowDataPacket[]>("SELECT ID FROM information_schema.PROCESSLIST WHERE BINARY DB=BINARY ? AND ID<>? AND INFO LIKE 'SELECT GET_LOCK(%'", [database, inspectId]);
        if (waiting.length === 1) break;
        if (performance.now() >= deadline) fail(); await new Promise(resolve => setTimeout(resolve, 5));
      }
      controller.abort(); const [outcome] = await settled; expect(outcome?.status).toBe("rejected");
      const closeDeadline = performance.now() + 2_000;
      for (;;) {
        const [live] = await connection().query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE BINARY DB=BINARY ? AND ID<>?", [database, inspectId]);
        if (Number(live[0]?.n) === 0) break;
        if (performance.now() >= closeDeadline) fail(); await new Promise(resolve => setTimeout(resolve, 5));
      }
    } finally {
      controller.abort(); clearTimeout(timer);
      await connection().query("SELECT RELEASE_LOCK(CONCAT('agent-service:migrate:',LEFT(SHA2(DATABASE(),256),32)))");
      await settled;
    }
    expect(await operation("verify")).toBeUndefined();
  });
});
