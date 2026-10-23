import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MysqlSessionStore, SkillRegistryIntegrityError } from "../src/index.js";
import { mkSession } from "./conformance.js";
import { buildSchemaMetadataProcedure } from "../src/mysql/schema-metadata-codec.js";
import { activateCurrentSchemaFixtureAuthority } from "./fixtures/schema-current-authority.js";

const ACK = "all-application-writers-stopped-v1" as const;
const REF_KEY = Buffer.alloc(32, 0x63); // Fixture-only; never a runtime/operator input.
const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));
const MIGRATION = "0066_mysql_live_session_authority.sql";
function fail(): never { throw new Error("Schema operation isolated MySQL fixture is not proven."); }
function base() {
  const url = new URL(process.env.MYSQL_TEST_URL ?? "mysql://invalid/");
  if (url.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.search || url.hash || !/(?:^|[_-])test(?:$|[_-])/i.test(decodeURIComponent(url.pathname.slice(1)))) fail();
  return url;
}
function at(url: URL, database: string, user?: string, password?: string) {
  const copy = new URL(url); copy.pathname = `/${database}`;
  if (user !== undefined) { copy.username = user; copy.password = password ?? ""; } return copy.toString();
}
function digest(text: string) { return createHash("sha256").update(text).digest("hex"); }

describe.skipIf(!process.env.AGENT_SERVICE_INTEGRATION)("one-shot schema operation on actual isolated MySQL", () => {
  let admin: Connection | undefined, inspect: Connection | undefined, source: URL;
  let database = "", emptyDatabase = "", uuid = "", adminId = 0, inspectId = 0, ready = false;
  const owned = new Set<string>(), ownedAccounts = new Set<string>();
  let metadataSchema = "", runtimeUser = "", definerUser = "", accountHost = "";
  const acct = (user: string) => `${mysql.escape(user)}@${mysql.escape(accountHost)}`;
  // Only the active-key business case provisions this profile. Schema-only setup remains dormant.
  async function prepareRuntimeProfile(signal: AbortSignal) {
    if (!admin || metadataSchema || ownedAccounts.size) return fail();
    const execute = async (sql: string, values: unknown[] = []) => {
      if (signal.aborted) return fail();
      // CREATE USER contains fixture secrets; never expose the native SQL/error payload.
      try { await admin!.query({ sql, timeout: 10_000 }, values); } catch { return fail(); }
      if (signal.aborted) fail();
    };
    const [identity] = await admin.query<RowDataPacket[]>("SELECT @@server_uuid AS uuid,CONNECTION_ID() AS id,DATABASE() AS db,SUBSTRING_INDEX(USER(),'@',-1) AS client_host,@@GLOBAL.partial_revokes AS partial_revokes");
    accountHost = String(identity[0]?.client_host); const grantMode: unknown = identity[0]?.partial_revokes;
    if (identity.length !== 1 || String(identity[0]?.uuid).toLowerCase() !== uuid || Number(identity[0]?.id) !== adminId
      || identity[0]?.db !== "mysql" || grantMode !== 0 && grantMode !== 1 || !accountHost || accountHost.length > 255
      || /[%_@\\/\u0000-\u0020\u007f]/.test(accountHost) || isIP(accountHost) === 0
        && !accountHost.split(".").every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) fail();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12), password = randomBytes(32).toString("hex");
    runtimeUser = `so_rt_${suffix}`; definerUser = `so_df_${suffix}`; metadataSchema = `${database}_meta`;
    const [existing] = await admin.query<RowDataPacket[]>("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", [metadataSchema]);
    if (existing.length || !/^agent_service_schema_operation_test_[0-9]+_[a-f0-9]{12}_meta$/.test(metadataSchema)) fail();
    // Record attempts before CREATE: failed/unknown bodies retain these exact identities.
    owned.add(metadataSchema); await execute(`CREATE DATABASE \`${metadataSchema}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    for (const user of [runtimeUser, definerUser]) {
      if (!/^so_(?:rt|df)_[a-f0-9]{12}$/.test(user)) fail();
      const [users] = await admin.query<RowDataPacket[]>("SELECT User FROM mysql.user WHERE BINARY User=BINARY ? AND BINARY Host=BINARY ?", [user, accountHost]);
      if (users.length) fail(); ownedAccounts.add(user);
      await execute(`CREATE USER ${acct(user)} ${user === runtimeUser ? "IDENTIFIED BY ?" : "ACCOUNT LOCK"}`, user === runtimeUser ? [password] : []);
    }
    const [tables] = await admin.query<RowDataPacket[]>("SELECT TABLE_NAME FROM information_schema.TABLES WHERE BINARY TABLE_SCHEMA=BINARY ? AND TABLE_TYPE='BASE TABLE' ORDER BY BINARY TABLE_NAME", [database]);
    if (!tables.length) fail();
    for (const table of tables) {
      const name = String(table.TABLE_NAME), readOnly = ["schema_migrations", "session_authority_control", "session_authority_bindings", "session_authority_runtime_accounts"].includes(name);
      await execute(`GRANT ${readOnly ? "SELECT" : "SELECT,INSERT,UPDATE,DELETE"} ON \`${database}\`.${mysql.escapeId(name)} TO ${acct(runtimeUser)}`);
    }
    const grantSchema = grantMode === 0 ? database.replaceAll("_", "\\_").replaceAll("%", "\\%") : database;
    await execute(`GRANT TRIGGER ON ${mysql.escapeId(grantSchema)}.* TO ${acct(definerUser)}`);
    const [mode] = await admin.query<RowDataPacket[]>("SELECT @@GLOBAL.partial_revokes AS partial_revokes");
    if (mode.length !== 1 || mode[0]?.partial_revokes !== grantMode) fail();
    await execute(`GRANT SHOW_ROUTINE ON *.* TO ${acct(runtimeUser)}`);
    const config = { metadataSchema, trustedDefiner: { user: definerUser, host: accountHost } };
    await MysqlSessionStore.runSchemaOperation({ url: at(source, database), operation: "install-metadata", schemaMetadata: config,
      operationAbortSignal: signal, fleetStoppedAck: ACK, migrationLockTimeoutSeconds: 1, migrationsDir: MIGRATIONS });
    const procedure = buildSchemaMetadataProcedure(database, metadataSchema);
    for (const user of [runtimeUser, definerUser]) await execute(`GRANT EXECUTE ON PROCEDURE \`${metadataSchema}\`.\`${procedure.routineName}\` TO ${acct(user)}`);
    await activateCurrentSchemaFixtureAuthority({ operatorUrl: at(source, database), database, serverUuid: uuid,
      schemaMetadata: config, runtimeAccount: { user: runtimeUser, host: accountHost }, signal });
    return { url: at(source, database, runtimeUser, password), migrationMode: "verify" as const, schemaMetadata: config };
  }
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
          if (name !== database && name !== emptyDatabase && name !== metadataSchema || !/^agent_service_schema_operation_test_[0-9]+_[a-f0-9]{12}(?:_empty|_meta)?$/.test(name)) fail();
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
        for (const user of ownedAccounts) {
          if (![runtimeUser, definerUser].includes(user) || !/^so_(?:rt|df)_[a-f0-9]{12}$/.test(user)) fail();
          if (Number((await query("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE BINARY USER=BINARY ?", [user]))[0]?.n) !== 0) fail();
          if ((await query("SELECT User FROM mysql.user WHERE BINARY User=BINARY ? AND BINARY Host=BINARY ?", [user, accountHost])).length !== 1) fail();
          await admin.query({ sql: `DROP USER ${acct(user)}`, timeout: Math.max(1, Math.floor(deadline - performance.now())) });
          if ((await query("SELECT User FROM mysql.user WHERE BINARY User=BINARY ? AND BINARY Host=BINARY ?", [user, accountHost])).length) fail();
          ownedAccounts.delete(user);
        }
      }
    } finally {
      const retained = [...owned].filter(name => !removed.includes(name));
      if (retained.length || ownedAccounts.size) console.warn(JSON.stringify({ schema: "schema-operation-fixture-cleanup-v1", status: "retained_or_unknown", databases: retained, accounts: [...ownedAccounts] }));
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
    const [authority] = await connection().query<RowDataPacket[]>("SELECT control_id,protocol,current_binding_id,binding_sequence FROM session_authority_control");
    expect(authority).toEqual([{ control_id: 1, protocol: "mysql-live-session-v1", current_binding_id: null, binding_sequence: 0 }]);
    for (const table of ["session_authority_bindings", "session_authority_runtime_accounts"]) {
      const [rows] = await connection().query<RowDataPacket[]>(`SELECT * FROM \`${table}\``); expect(rows).toEqual([]);
    }
  });

  it("verify of an empty existing database fails without creating schema_migrations or any other table", async () => {
    await expect(operation("verify", emptyDatabase)).rejects.toMatchObject({ code: "ER_NO_SUCH_TABLE" });
    const [tables] = await connection().query<RowDataPacket[]>("SELECT TABLE_NAME FROM information_schema.TABLES WHERE BINARY TABLE_SCHEMA=BINARY ?", [emptyDatabase]);
    expect(tables).toEqual([]);
  });

  it("omits only runtime key admission while ordinary cold connects still require the real active ref key", async ({ signal }) => {
    const profile = await prepareRuntimeProfile(signal);
    const store = await MysqlSessionStore.connect({ ...profile, tenantTelemetryRefKey: REF_KEY, connectionLimit: 1, operationAbortSignal: signal });
    const session = mkSession(`schema-operation-${randomUUID()}`, "schema-owner");
    try {
      await store.createSession(session);
      await store.activateTenantTelemetryLifecycle({ expectedControlGeneration: 0,
        targets: ["logs", "traces"].map(domain => ({ domain: domain as "logs" | "traces", backendKind: "test_sink", adapterProtocol: "telemetry-test-v1",
          namespaceSha256: digest(`${domain}:schema-namespace`), failureDomainSha256: digest(`${domain}:schema-failure-domain`) })) });
    } finally { await store.close(); }
    const image = async () => {
      const result: unknown[] = [];
      for (const table of ["tenant_telemetry_lifecycle_control", "tenant_telemetry_lifecycle_targets", "tenant_telemetry_lifecycle_coverages", "tenant_telemetry_activation_receipts",
        "session_authority_control", "session_authority_bindings", "session_authority_runtime_accounts"]) {
        const [rows] = await connection().query<RowDataPacket[]>(`SELECT * FROM \`${table}\``); result.push(rows);
      }
      for (const table of ["sessions", "events"]) { const [rows] = await connection().query<RowDataPacket[]>(`SELECT * FROM \`${table}\` WHERE session_id=?`, [session.id]); result.push(rows); }
      return result;
    };
    const before = await image();
    expect(await operation("verify")).toBeUndefined(); expect(await operation("migrate")).toBeUndefined();
    expect(await image()).toEqual(before);
    for (const migrationMode of ["verify", "apply"] as const) {
      const outcome = await MysqlSessionStore.connect({ ...profile, migrationMode, connectionLimit: 1, operationAbortSignal: signal })
        .then(async unexpected => { await unexpected.close(); return unexpected; }, (error: unknown) => error);
      expect(outcome).toBeInstanceOf(Error);
      // Runtime verify still reaches exact active-key admission. Runtime apply is now rejected
      // earlier by the explicit restricted profile; the two real operator schema calls above
      // continue to demonstrate that schema-only work omits only runtime key admission.
      expect((outcome as Error).message).toBe(migrationMode === "verify"
        ? "active tenant telemetry lifecycle requires the exact stable ref key"
        : "schema metadata bridge requires explicit verify-only mode");
      expect(await image()).toEqual(before);
    }
  });

  it("rejects a lost current marker without adding it back or changing native guards", async () => {
    const [marker] = await connection().query<RowDataPacket[]>("SELECT name,applied_at_ms FROM schema_migrations WHERE name=?", [MIGRATION]);
    expect(marker).toHaveLength(1);
    const [before] = await connection().query<RowDataPacket[]>("SELECT TRIGGER_NAME,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY BINARY TRIGGER_NAME");
    await connection().query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION]);
    try {
      await expect(operation("verify")).rejects.toThrow("database schema is missing required migrations: 0066_mysql_live_session_authority.sql");
      const [lost] = await connection().query<RowDataPacket[]>("SELECT name FROM schema_migrations WHERE name=?", [MIGRATION]); expect(lost).toEqual([]);
      const [after] = await connection().query<RowDataPacket[]>("SELECT TRIGGER_NAME,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY BINARY TRIGGER_NAME"); expect(after).toEqual(before);
    } finally { await connection().query("INSERT INTO schema_migrations(name,applied_at_ms) VALUES(?,?)", [marker[0]?.name, marker[0]?.applied_at_ms]); }
    expect(await operation("verify")).toBeUndefined();
  });

  it("rejects a genuinely missing current native guard without silently recreating it", async () => {
    const name = "trg_mcp_registry_dynamic_clients_bd";
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
