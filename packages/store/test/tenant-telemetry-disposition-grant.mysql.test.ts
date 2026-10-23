import { CaptureMysqlRuntimeOwner, type CaptureMysqlInspection as Connection } from "./fixtures/capture-mysql-runtime.js";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, type TestContext } from "vitest";
import {
  MysqlSessionStore,
  SkillRegistryIntegrityError,
  tenantTelemetryDispositionClaimTokenSha256,
  type TenantTelemetryDispositionAuthorization,
} from "../src/index.js";
import { readMysqlSkillRegistryFingerprintStatements } from "../src/mysql/skills-registry.js";

type Row = RowDataPacket;
const digest = (label: string) => createHash("sha256").update(label).digest("hex");
const REF_KEY = Buffer.alloc(32, 0x37);
const BASE_URL = process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";

function disposableBase(raw: string): URL {
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) {
    throw new Error("MYSQL_TEST_URL must name a disposable test database");
  }
  return url;
}

function statements(sql: string): string[] {
  return sql.replace(/^\s*--.*$/gm, "").split(/;\s*\n/)
    .map((value) => value.trim()).filter(Boolean);
}

const AUTHORIZATION: TenantTelemetryDispositionAuthorization = {
  tenantId: "tenant-grant",
  requestId: "request-grant",
  dispositionOperationSha256: digest("0037:grant:operation"),
  claimAttempt: 1,
  claimToken: "grant-claim-token",
};

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore 0037 dormant grant boundary", () => {
    let base: URL;
    type Scope = { signal: AbortSignal; failed: boolean; failure?: { reason: unknown };
      owner?: CaptureMysqlRuntimeOwner; close?: Promise<void>; work?: Promise<void>; detach?: () => void;
      cleanupValidation?: "structure-after-intentional-data-corruption-v1" };
    const cases = new Set<Scope>();
    function finish(scope: Scope): Promise<void> {
      return scope.close ??= (async () => {
        try { await scope.owner?.close({ successful: !scope.failed && !scope.signal.aborted,
          ...(scope.cleanupValidation ? { cleanupValidation: scope.cleanupValidation } : {}) }); }
        finally { scope.detach?.(); }
      })();
    }
    function runCase(body: (scope: Scope) => Promise<void>) {
      return (context: TestContext): Promise<void> => {
        const scope: Scope = { signal: context.signal, failed: false }; cases.add(scope);
        const work = Promise.resolve().then(async () => {
          try { scope.signal.throwIfAborted(); await body(scope); scope.signal.throwIfAborted(); }
          catch (reason) { scope.failed = true; scope.failure ??= { reason }; }
          try { await finish(scope); } catch (reason) { scope.failed = true; scope.failure ??= { reason }; }
          if (scope.failure) throw scope.failure.reason;
        });
        scope.work = work; return work;
      };
    }
    beforeAll(async () => { base = disposableBase(BASE_URL); });
    afterAll(async () => {
      await Promise.allSettled([...cases].map(scope => scope.work!));
      const results = await Promise.allSettled([...cases].map(scope => finish(scope)));
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    });
    function createOwner(scope: Scope, refKey: Uint8Array | null = REF_KEY): CaptureMysqlRuntimeOwner {
      const owner = new CaptureMysqlRuntimeOwner(base.toString(), { tenantTelemetryRefKey: refKey,
        tenantTelemetryPersistedProviderCaptureLocalOnly: false, tenantTelemetryCaptureRestoreLocalOnly: false });
      scope.owner = owner;
      const abort = () => { void owner.close({ successful: false }).catch(() => { /* finish joins the same original close. */ }); };
      scope.signal.addEventListener("abort", abort, { once: true });
      scope.detach = () => scope.signal.removeEventListener("abort", abort);
      scope.signal.throwIfAborted(); return owner;
    }

    async function fixture(scope: Scope): Promise<{
      database: string; url: string; conn: Connection; store: MysqlSessionStore; owner: CaptureMysqlRuntimeOwner; close(): Promise<void>;
    }> {
      const owner = createOwner(scope), database = owner.database; await owner.prepare();
      const url = owner.runtimeEnv().MYSQL_URL!;
      const store = await owner.openStore(12, scope.signal), conn = await owner.openInspection(scope.signal);
      return { database, url, conn, store, owner, async close() { await finish(scope); } };
    }

    async function savedGuard(conn: Connection, name: "trg_tt_disposition_job_bi" | "trg_tt_disposition_grant_bi_v2"): Promise<string> {
      const [rows] = await conn.query<Row[]>("SHOW CREATE TRIGGER `" + name + "`");
      const statement = rows[0]?.["SQL Original Statement"];
      if (rows.length !== 1 || typeof statement !== "string" || !/^CREATE /i.test(statement)) {
        throw new Error("Original owned grant guard was not observed");
      }
      return statement;
    }

    it("keeps concurrent claim-bound grant requests and foreign-tenant reads dormant", runCase(async scope => {
      const f = await fixture(scope);
      try {
        const outcomes = await Promise.all(Array.from({ length: 16 }, () =>
          f.store.issueTenantTelemetryDispositionAuthorizationGrant(AUTHORIZATION)));
        expect(outcomes).toEqual(Array.from({ length: 16 }, () => null));
        expect(await f.store.getTenantTelemetryDispositionAuthorizationGrant(
          AUTHORIZATION.tenantId, AUTHORIZATION.dispositionOperationSha256,
        )).toBeNull();
        expect(await f.store.getTenantTelemetryDispositionAuthorizationGrant(
          "different-tenant", AUTHORIZATION.dispositionOperationSha256,
        )).toBeNull();
        const [rows] = await f.conn.query<Row[]>(
          `SELECT (SELECT COUNT(*) FROM tenant_telemetry_disposition_authorization_grants)
                    AS grants,
                  (SELECT COUNT(*) FROM tenant_telemetry_disposition_jobs) AS jobs,
                  (SELECT COUNT(*) FROM tenant_telemetry_disposition_external_authorizations)
                    AS authorizations`,
        );
        expect(rows[0]).toMatchObject({ grants: 0, jobs: 0, authorizations: 0 });
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; } finally {
        await f.close();
      }
    }), 120_000);

    it("rejects direct SQL grant insertion even with the exact domain-separated claim hash", runCase(async scope => {
      const f = await fixture(scope);
      try {
        await expect(f.conn.query(
          `INSERT INTO tenant_telemetry_disposition_authorization_grants
             (disposition_operation_sha256,tenant_id,grant_receipt_sha256,claim_token_sha256,
              granted_at_db_ms,lease_until_db_ms,grant_json)
           VALUES (?,?,?,?,?,?,JSON_OBJECT('fixture',TRUE))`,
          [AUTHORIZATION.dispositionOperationSha256, AUTHORIZATION.tenantId,
            digest("0037:grant:receipt"),
            tenantTelemetryDispositionClaimTokenSha256(AUTHORIZATION.claimToken), 1, 2],
        )).rejects.toThrow("tenant telemetry disposition grant lacks exact live claim");
        const [rows] = await f.conn.query<Row[]>(
          "SELECT COUNT(*) AS grants FROM tenant_telemetry_disposition_authorization_grants",
        );
        expect(Number(rows[0]?.grants)).toBe(0);
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; } finally {
        await f.close();
      }
    }), 120_000);

    it("reaches explicit dormant denial only for an exact live claim, never raw hash or another tenant", runCase(async scope => {
      scope.cleanupValidation = "structure-after-intentional-data-corruption-v1";
      const f = await fixture(scope);
      const originalGuard = await savedGuard(f.conn, "trg_tt_disposition_job_bi");
      let guardMutationAttempted = false;
      try {
        // A T3d zero-target plan cannot produce this job in the product. Bypass only the job
        // INSERT source guard in this disposable DB to exercise every branch of the 0037 grant
        // trigger without creating any deletion authority or external mutation.
        guardMutationAttempted = true;
        await f.conn.query("DROP TRIGGER trg_tt_disposition_job_bi");
        const [clock] = await f.conn.query<Row[]>(
          "SELECT CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED) AS now_ms",
        );
        const now = Number(clock[0]?.now_ms);
        const operation = digest("0037:synthetic:claimed:operation");
        const tenant = "tenant-claimed";
        const claim = "claimed-token-37";
        await f.conn.query(
          `INSERT INTO tenant_telemetry_disposition_jobs
             (disposition_operation_sha256,tenant_id,request_id,scope,protocol,domain,
              target_sha256,artifact_id_sha256,artifact_generation,inventory_sha256,
              write_operation_sha256,t3c_receipt_sha256,t3d_plan_receipt_sha256,
              t3d_plan_entry_receipt_sha256,phase,attempts,available_at_db_ms,
              claim_token,lease_until_db_ms,created_at_db_ms,updated_at_db_ms,job_json)
           VALUES (?,?,?,'tenant-telemetry-disposition-job-v1',
              'tenant-telemetry-disposition-v1','logs',?,?,?,?,?,?,?,?,
              'queued',1,?,?,?,?,?,JSON_OBJECT('fixture',TRUE))`,
          [operation, tenant, "request-claimed", digest("claimed-target"),
            digest("claimed-artifact"), 1, digest("claimed-inventory"),
            digest("claimed-write"), digest("claimed-t3c"), digest("claimed-t3d"),
            digest("claimed-entry"), now, claim, now + 120_000, now, now],
        );
        async function attemptGrant(
          tenantId: string,
          claimTokenSha256: string,
        ): Promise<unknown> {
          return f.conn.query(
            `INSERT INTO tenant_telemetry_disposition_authorization_grants
               (disposition_operation_sha256,tenant_id,grant_receipt_sha256,
                claim_token_sha256,granted_at_db_ms,lease_until_db_ms,grant_json)
             VALUES (?,?,?,?,?,?,JSON_OBJECT('fixture',TRUE))`,
            [operation, tenantId, digest(`grant:${tenantId}:${claimTokenSha256}`),
              claimTokenSha256, now, now + 60_000],
          );
        }
        await expect(attemptGrant(
          tenant, tenantTelemetryDispositionClaimTokenSha256(claim),
        )).rejects.toThrow("tenant telemetry disposition grant issuance is dormant");
        await expect(attemptGrant(tenant, digest(claim))).rejects.toThrow(
          "tenant telemetry disposition grant lacks exact live claim",
        );
        await expect(attemptGrant(
          tenant, tenantTelemetryDispositionClaimTokenSha256("different-token"),
        )).rejects.toThrow("tenant telemetry disposition grant lacks exact live claim");
        await expect(attemptGrant(
          "foreign-tenant", tenantTelemetryDispositionClaimTokenSha256(claim),
        )).rejects.toThrow("tenant telemetry disposition grant lacks exact live claim");
        const [rows] = await f.conn.query<Row[]>(
          "SELECT COUNT(*) AS grants FROM tenant_telemetry_disposition_authorization_grants",
        );
        expect(Number(rows[0]?.grants)).toBe(0);
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; } finally {
        if (guardMutationAttempted) {
          await f.conn.query("DROP TRIGGER IF EXISTS trg_tt_disposition_job_bi");
          await f.conn.query(originalGuard);
        }
        await f.close();
      }
    }), 120_000);

    it("treats an injected foreign-tenant grant as global corruption, never local authority", runCase(async scope => {
      scope.cleanupValidation = "structure-after-intentional-data-corruption-v1";
      const f = await fixture(scope);
      try {
        // This is an intentionally privileged tamper in a throwaway database. The production
        // trigger refuses every INSERT; the read API must also fail closed if it was bypassed.
        await f.conn.query("DROP TRIGGER trg_tt_disposition_job_bi");
        await f.conn.query("DROP TRIGGER trg_tt_disposition_grant_bi_v2");
        const operation = digest("0037:injected:operation");
        const tenant = "foreign-tenant";
        await f.conn.query(
          `INSERT INTO tenant_telemetry_disposition_jobs
             (disposition_operation_sha256,tenant_id,request_id,scope,protocol,domain,
              target_sha256,artifact_id_sha256,artifact_generation,inventory_sha256,
              write_operation_sha256,t3c_receipt_sha256,t3d_plan_receipt_sha256,
              t3d_plan_entry_receipt_sha256,phase,attempts,blocked_at_db_ms,
              blocked_reason_code,created_at_db_ms,updated_at_db_ms,job_json)
           VALUES (?,?,?,'tenant-telemetry-disposition-job-v1',
              'tenant-telemetry-disposition-v1','logs',?,?,?,?,?,?,?,?,
              'blocked',0,1000,'integrity_conflict',1000,1000,
              JSON_OBJECT('fixture',TRUE))`,
          [operation, tenant, "request-injected", digest("target"), digest("artifact"),
            1, digest("inventory"), digest("write"), digest("t3c"), digest("t3d"),
            digest("entry")],
        );
        await f.conn.query(
          `INSERT INTO tenant_telemetry_disposition_authorization_grants
             (disposition_operation_sha256,tenant_id,grant_receipt_sha256,claim_token_sha256,
              granted_at_db_ms,lease_until_db_ms,grant_json)
           VALUES (?,?,?,?,?,?,JSON_OBJECT('fixture',TRUE))`,
          [operation, tenant, digest("injected-grant"),
            tenantTelemetryDispositionClaimTokenSha256("injected-token"), 1000, 2000],
        );
        // Restore the exact published guards so startup reaches the durable projection audit,
        // not just the expected schema-fingerprint error from the privileged test tamper.
        const oldSql = await readFile(new URL(
          "../migrations/0036_tenant_telemetry_disposition.sql", import.meta.url,
        ), "utf8");
        const jobTrigger = statements(oldSql).find((statement) =>
          statement.startsWith("CREATE TRIGGER trg_tt_disposition_job_bi "));
        const newSql = await readFile(new URL(
          "../migrations/0037_tenant_telemetry_disposition_grant_guard.sql", import.meta.url,
        ), "utf8");
        const grantTrigger = statements(newSql)[0];
        expect(jobTrigger).toBeDefined();
        expect(grantTrigger).toMatch(/^CREATE TRIGGER trg_tt_disposition_grant_bi_v2 /);
        await f.conn.query(jobTrigger!);
        await f.conn.query(grantTrigger!);
        await expect(f.store.getTenantTelemetryDispositionAuthorizationGrant(
          AUTHORIZATION.tenantId, AUTHORIZATION.dispositionOperationSha256,
        )).rejects.toThrow("0037 contains unsupported telemetry grant evidence");
        await expect(f.store.issueTenantTelemetryDispositionAuthorizationGrant(
          AUTHORIZATION,
        )).rejects.toThrow("0037 source-valid telemetry grant issuance is not enabled");
        await expect(f.owner.openStore(20, scope.signal)).rejects.toThrow("inactive tenant telemetry disposition has durable projection");
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; } finally {
        await f.close();
      }
    }), 120_000);

    it("rejects post-marker trigger body drift on startup", runCase(async scope => {
      const f = await fixture(scope);
      const originalGuard = await savedGuard(f.conn, "trg_tt_disposition_grant_bi_v2");
      let guardMutationAttempted = false;
      try {
        const { schema, triggers } = await readMysqlSkillRegistryFingerprintStatements(
          f.conn, fileURLToPath(new URL("../migrations/", import.meta.url)),
        );
        await f.conn.query("SET @grant_drift_test_gcml=@@SESSION.group_concat_max_len");
        try {
          await f.conn.query("SET SESSION group_concat_max_len=1048576");
          const fingerprint = async (triggersOk: 0 | 1) => {
            await f.conn.query(schema);
            await f.conn.query(triggers);
            const [rows] = await f.conn.query<Row[]>(
              "SELECT @skill_registry_schema_ok AS schema_ok,@skill_registry_triggers_ok AS triggers_ok",
            );
            expect(Number(rows[0]?.schema_ok)).toBe(1);
            expect(Number(rows[0]?.triggers_ok)).toBe(triggersOk);
          };
          await fingerprint(1);
          guardMutationAttempted = true;
          await f.conn.query("DROP TRIGGER trg_tt_disposition_grant_bi_v2");
          await f.conn.query(
            `CREATE TRIGGER trg_tt_disposition_grant_bi_v2 BEFORE INSERT
               ON tenant_telemetry_disposition_authorization_grants FOR EACH ROW
             BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tampered'; END`,
          );
          await fingerprint(0);
          // The applied current marker selects the combined root, including this 0037 guard.
          // Historical-schema oracles and every dormant grant assertion stay unchanged.
          const startup = f.owner.openStore(20, scope.signal)
            .then(async (unexpectedlyOpened) => { await unexpectedlyOpened.close(); });
          await expect(startup).rejects.toBeInstanceOf(SkillRegistryIntegrityError);
          await expect(startup).rejects.toMatchObject({
            name: "SkillRegistryIntegrityError", message: "skill registry evidence is invalid",
          });
        } finally {
          await f.conn.query("SET SESSION group_concat_max_len=@grant_drift_test_gcml");
        }
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; } finally {
        if (guardMutationAttempted) {
          await f.conn.query("DROP TRIGGER IF EXISTS trg_tt_disposition_grant_bi_v2");
          await f.conn.query(originalGuard);
        }
        await f.close();
      }
    }), 120_000);
  });
}
