import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MysqlSessionStore,
  tenantTelemetryDispositionClaimTokenSha256,
  type TenantTelemetryDispositionAuthorization,
} from "../src/index.js";

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

function databaseName(): string {
  return `agent_service_tt_grant_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

function databaseUrl(base: URL, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
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
    let admin: Connection;
    let base: URL;

    beforeAll(async () => {
      base = disposableBase(BASE_URL);
      const adminUrl = new URL(base);
      adminUrl.pathname = "/mysql";
      admin = await mysql.createConnection(adminUrl.toString());
    });

    afterAll(async () => {
      await admin?.end();
    });

    async function fixture(): Promise<{
      database: string;
      url: string;
      conn: Connection;
      store: MysqlSessionStore;
      close(): Promise<void>;
    }> {
      const database = databaseName();
      await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
      const url = databaseUrl(base, database);
      let conn: Connection | undefined;
      let store: MysqlSessionStore | undefined;
      try {
        store = await MysqlSessionStore.connect({
          url, connectionLimit: 12, tenantTelemetryRefKey: REF_KEY,
        });
        conn = await mysql.createConnection(url);
        return {
          database, url, conn, store,
          async close() {
            await conn!.end();
            await store!.close();
            await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
          },
        };
      } catch (error) {
        await conn?.end().catch(() => {});
        await store?.close().catch(() => {});
        await admin.query(`DROP DATABASE IF EXISTS \`${database}\``).catch(() => {});
        throw error;
      }
    }

    it("keeps concurrent claim-bound grant requests and foreign-tenant reads dormant", async () => {
      const f = await fixture();
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
      } finally {
        await f.close();
      }
    }, 120_000);

    it("rejects direct SQL grant insertion even with the exact domain-separated claim hash", async () => {
      const f = await fixture();
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
      } finally {
        await f.close();
      }
    }, 120_000);

    it("reaches explicit dormant denial only for an exact live claim, never raw hash or another tenant", async () => {
      const f = await fixture();
      try {
        // A T3d zero-target plan cannot produce this job in the product. Bypass only the job
        // INSERT source guard in this disposable DB to exercise every branch of the 0037 grant
        // trigger without creating any deletion authority or external mutation.
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
      } finally {
        await f.close();
      }
    }, 120_000);

    it("treats an injected foreign-tenant grant as global corruption, never local authority", async () => {
      const f = await fixture();
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
        await expect(MysqlSessionStore.connect({
          url: f.url, tenantTelemetryRefKey: REF_KEY,
        })).rejects.toThrow("inactive tenant telemetry disposition has durable projection");
      } finally {
        await f.close();
      }
    }, 120_000);

    it("rejects post-marker trigger body drift on startup", async () => {
      const f = await fixture();
      try {
        await f.conn.query("DROP TRIGGER trg_tt_disposition_grant_bi_v2");
        await f.conn.query(
          `CREATE TRIGGER trg_tt_disposition_grant_bi_v2 BEFORE INSERT
             ON tenant_telemetry_disposition_authorization_grants FOR EACH ROW
           BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tampered'; END`,
        );
        // The latest 0042 fingerprint covers all 119 triggers, including this 0037 guard.
        await expect(MysqlSessionStore.connect({
          url: f.url, tenantTelemetryRefKey: REF_KEY,
        })).rejects.toThrow("0042 plan artifact target fingerprint verification failed");
      } finally {
        await f.close();
      }
    }, 120_000);
  });
}
