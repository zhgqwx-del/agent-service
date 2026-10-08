import { randomUUID } from "node:crypto";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ErasureJobTransitionError,
  MysqlSessionStore,
  newErasureRequestId,
  userErasureRequestHash,
  type ErasureJobAuthorization,
  type ErasureJobClaim,
} from "../src/index.js";

const BASE_MYSQL_URL = process.env.MYSQL_TEST_URL ?? "mysql://root@127.0.0.1:3306/agent_service_test";
type Row = RowDataPacket;

function assertDisposableTestTarget(rawUrl: string): URL {
  const url = new URL(rawUrl);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) {
    throw new Error(
      `refusing to create erasure job fixture database from base database "${database}": `
      + "MYSQL_TEST_URL must name a test database",
    );
  }
  return url;
}

function databaseUrl(base: URL, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function requestInput(tenantId: string, userId: string, atMs = 100) {
  return {
    requestId: newErasureRequestId(),
    tenantId,
    userId,
    requestedByKeyId: "admin-key",
    idempotencyKey: `erase-${userId}`,
    requestHash: userErasureRequestHash(tenantId, userId),
    atMs,
  };
}

function authorization(claim: ErasureJobClaim): ErasureJobAuthorization {
  return {
    tenantId: claim.tenantId,
    subjectKind: claim.subjectKind,
    subjectId: claim.subjectId,
    requestId: claim.requestId,
    subjectGeneration: claim.subjectGeneration,
    claimToken: claim.claimToken,
    claimAttempt: claim.attempts,
  };
}

async function seedPolicyApprovedPurging(
  conn: Connection,
  requestId: string,
  firstTransitionAtMs: number,
): Promise<number> {
  const policyVersion = "policy-v1";
  const policyHash = "d".repeat(64);
  const transitions = [
    ["gated", "draining"],
    ["draining", "tombstoning"],
    ["tombstoning", "reconciling_usage"],
    ["reconciling_usage", "awaiting_purge_policy"],
    ["awaiting_purge_policy", "purging"],
  ] as const;
  for (const [index, [fromStatus, status]] of transitions.entries()) {
    await conn.query(
      `INSERT INTO erasure_audit_events (request_id, seq, event_type, payload, emitted_at_ms)
       VALUES (?,?,'erasure/status_changed',?,?)`,
      [
        requestId,
        index + 2,
        JSON.stringify({ fromStatus, status, generation: 1, policyVersion, policyHash }),
        firstTransitionAtMs + index,
      ],
    );
  }
  const purgingAtMs = firstTransitionAtMs + transitions.length - 1;
  await conn.query(
    `UPDATE erasure_requests
        SET status='purging', available_at_ms=?, updated_at_ms=?, policy_version=?, policy_hash=?
      WHERE request_id=?`,
    [purgingAtMs, purgingAtMs, policyVersion, policyHash, requestId],
  );
  return purgingAtMs;
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore durable erasure job queue", () => {
    let admin: Connection | undefined;
    let mysqlUrl = "";
    let database = "";

    beforeAll(async () => {
      const base = assertDisposableTestTarget(BASE_MYSQL_URL);
      database = `agent_service_erasure_job_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
      if (!/^agent_service_erasure_job_test_[a-zA-Z0-9_]+$/.test(database)) {
        throw new Error("unsafe generated erasure job fixture database name");
      }
      admin = await mysql.createConnection(databaseUrl(base, "mysql"));
      await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
      mysqlUrl = databaseUrl(base, database);
      const migrated = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 1 });
      await migrated.close();
    });

    afterAll(async () => {
      if (admin && database) await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      await admin?.end();
    });

    it("lets one competing worker claim and returns no request credentials", async () => {
      const firstStore = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const secondStore = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const input = requestInput(`tenant_job_${randomUUID()}`, `user_${randomUUID()}`);
      try {
        expect(await firstStore.requestUserErasure(input)).toMatchObject({
          status: "gated", availableAtMs: 100, attempts: 0,
        });
        const results = await Promise.all([
          firstStore.claimErasureJobs({ nowMs: 100, limit: 1, leaseMs: 20, claimToken: "worker-a" }),
          secondStore.claimErasureJobs({ nowMs: 100, limit: 1, leaseMs: 20, claimToken: "worker-b" }),
        ]);
        expect(results.map((rows) => rows.length).sort()).toEqual([0, 1]);
        const claim = results.flat()[0]!;
        expect(claim).toMatchObject({
          requestId: input.requestId,
          tenantId: input.tenantId,
          subjectId: input.userId,
          subjectGeneration: 1,
          status: "gated",
          attempts: 1,
          leaseUntilMs: 120,
        });
        expect(Object.keys(claim)).not.toContain("idempotencyKey");
        expect(Object.keys(claim)).not.toContain("requestedByKeyId");
        expect(Object.keys(claim)).not.toContain("requestHash");
        expect(await firstStore.transitionErasureJob(authorization(claim), {
          fromStatus: "gated", toStatus: "blocked", atMs: 101, errorCode: "temporary_failure",
        })).toBe(true);
      } finally {
        await secondStore.close();
        await firstStore.close();
      }
    });

    it("takes over exactly at lease expiry, rejects stale authority, and retries durably", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const input = requestInput(`tenant_lease_${randomUUID()}`, `user_${randomUUID()}`);
      try {
        await store.requestUserErasure(input);
        const first = (await store.claimErasureJobs({
          nowMs: 100, limit: 1, leaseMs: 10, claimToken: "worker-reused",
        }))[0]!;
        expect(await store.claimErasureJobs({
          nowMs: 109, limit: 1, leaseMs: 10, claimToken: "worker-early",
        })).toEqual([]);
        const taken = (await store.claimErasureJobs({
          nowMs: 110, limit: 1, leaseMs: 20, claimToken: "worker-reused",
        }))[0]!;
        expect(taken).toMatchObject({ attempts: 2, claimToken: "worker-reused", leaseUntilMs: 130 });
        expect(await store.renewErasureJobClaim(authorization(first), { nowMs: 110, leaseMs: 40 })).toBe(false);
        expect(await store.transitionErasureJob(authorization(first), {
          fromStatus: "gated", toStatus: "draining", atMs: 110, availableAtMs: 110,
        })).toBe(false);
        expect(await store.retryErasureJob(authorization(first), {
          failedAtMs: 110, availableAtMs: 140, errorCode: "temporary_failure",
        })).toBe(false);

        expect(await store.renewErasureJobClaim(authorization(taken), { nowMs: 111, leaseMs: 1 })).toBe(true);
        expect((await store.getUserErasureRequest(input.tenantId, input.userId, input.requestId))?.leaseUntilMs)
          .toBe(130);
        expect(await store.retryErasureJob(authorization(taken), {
          failedAtMs: 112, availableAtMs: 150, errorCode: "owner_unavailable",
        })).toBe(true);
        expect(await store.claimErasureJobs({
          nowMs: 149, limit: 1, leaseMs: 10, claimToken: "worker-too-soon",
        })).toEqual([]);
        const retried = (await store.claimErasureJobs({
          nowMs: 150, limit: 1, leaseMs: 10, claimToken: "worker-retry",
        }))[0]!;
        expect(retried).toMatchObject({ attempts: 3, claimToken: "worker-retry" });
        expect(await store.getUserErasureRequest(input.tenantId, input.userId, input.requestId)).toMatchObject({
          attempts: 3,
          lastErrorCode: "owner_unavailable",
        });
        expect(await store.transitionErasureJob(authorization(retried), {
          fromStatus: "gated", toStatus: "blocked", atMs: 151, errorCode: "temporary_failure",
        })).toBe(true);
      } finally {
        await store.close();
      }
    });

    it("validates transitions and rolls request changes back when audit insertion fails", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const input = requestInput(`tenant_audit_${randomUUID()}`, `user_${randomUUID()}`);
      try {
        await store.requestUserErasure(input);
        const claim = (await store.claimErasureJobs({
          nowMs: 100, limit: 1, leaseMs: 100, claimToken: "worker-audit",
        }))[0]!;
        await expect(store.transitionErasureJob(authorization(claim), {
          fromStatus: "gated", toStatus: "tombstoning", atMs: 101, availableAtMs: 101,
        })).rejects.toBeInstanceOf(ErasureJobTransitionError);

        await conn.query(
          `CREATE TRIGGER fail_erasure_job_audit BEFORE INSERT ON erasure_audit_events
           FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected job audit failure'`,
        );
        await expect(store.transitionErasureJob(authorization(claim), {
          fromStatus: "gated",
          toStatus: "draining",
          atMs: 101,
          availableAtMs: 101,
          policyVersion: "policy-v1",
          policyHash: "a".repeat(64),
        })).rejects.toThrow("injected job audit failure");
        expect(await store.getUserErasureRequest(input.tenantId, input.userId, input.requestId)).toMatchObject({
          status: "gated", claimToken: "worker-audit", leaseUntilMs: 200,
        });
        expect(await store.listErasureAuditEvents(input.requestId)).toHaveLength(1);

        await conn.query("DROP TRIGGER fail_erasure_job_audit");
        expect(await store.transitionErasureJob(authorization(claim), {
          fromStatus: "gated",
          toStatus: "draining",
          atMs: 102,
          availableAtMs: 102,
          policyVersion: "policy-v1",
          policyHash: "a".repeat(64),
        })).toBe(true);
        const next = (await store.claimErasureJobs({
          nowMs: 102, limit: 1, leaseMs: 100, claimToken: "worker-next",
        }))[0]!;
        await expect(store.transitionErasureJob(authorization(next), {
          fromStatus: "draining",
          toStatus: "tombstoning",
          atMs: 103,
          availableAtMs: 103,
          policyVersion: "policy-v2",
          policyHash: "b".repeat(64),
        })).rejects.toThrow("policy identity is immutable");
        expect(await store.getUserErasureRequest(input.tenantId, input.userId, input.requestId)).toMatchObject({
          status: "draining", policyVersion: "policy-v1", policyHash: "a".repeat(64),
        });
        expect(await store.transitionErasureJob(authorization(next), {
          fromStatus: "draining", toStatus: "blocked", atMs: 104, errorCode: "policy_unavailable",
        })).toBe(true);
      } finally {
        await conn.query("DROP TRIGGER IF EXISTS fail_erasure_job_audit").catch(() => {});
        await conn.end();
        await store.close();
      }
    });

    it("moves only completed subjects to erased and leaves blocked subjects gated", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const completedInput = requestInput(`tenant_complete_${randomUUID()}`, `user_${randomUUID()}`);
      const blockedInput = requestInput(`tenant_blocked_${randomUUID()}`, `user_${randomUUID()}`, 200);
      try {
        await store.requestUserErasure(completedInput);
        const purgingAtMs = await seedPolicyApprovedPurging(conn, completedInput.requestId, 101);
        const purging = (await store.claimErasureJobs({
          nowMs: purgingAtMs, limit: 1, leaseMs: 100, claimToken: "worker-complete",
        }))[0]!;
        expect(await store.transitionErasureJob(authorization(purging), {
          fromStatus: "purging",
          toStatus: "completed",
          atMs: purgingAtMs + 1,
          counts: { sessions: 4, blobs: 2 },
          checksum: "c".repeat(64),
        })).toBe(true);
        expect(await store.getSubjectLifecycle(completedInput.tenantId, "user", completedInput.userId))
          .toMatchObject({ state: "erased", generation: 1 });
        expect(await store.getSubjectLifecycle(completedInput.tenantId, "user", completedInput.userId))
          .not.toHaveProperty("activeRequestId");
        expect(await store.getUserErasureRequest(
          completedInput.tenantId, completedInput.userId, completedInput.requestId,
        )).toMatchObject({
          status: "completed",
          completedAtMs: purgingAtMs + 1,
          counts: { sessions: 4, blobs: 2 },
          checksum: "c".repeat(64),
        });

        await store.requestUserErasure(blockedInput);
        const blocked = (await store.claimErasureJobs({
          nowMs: 200, limit: 1, leaseMs: 100, claimToken: "worker-blocked",
        }))[0]!;
        expect(await store.transitionErasureJob(authorization(blocked), {
          fromStatus: "gated",
          toStatus: "blocked",
          atMs: 201,
          errorCode: "integrity_conflict",
        })).toBe(true);
        expect(await store.getSubjectLifecycle(blockedInput.tenantId, "user", blockedInput.userId))
          .toMatchObject({ state: "deleting", activeRequestId: blockedInput.requestId });
        expect(await store.claimErasureJobs({
          nowMs: 1_000, limit: 10, leaseMs: 10, claimToken: "worker-terminal",
        })).toEqual([]);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("fails closed on owner/generation/audit corruption without mutating queue state", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const input = requestInput(`tenant_corrupt_${randomUUID()}`, `user_${randomUUID()}`);
      try {
        await store.requestUserErasure(input);
        await conn.query(
          `UPDATE subject_lifecycle SET active_request_id=?
            WHERE tenant_id=? AND subject_kind='user' AND subject_id=?`,
          [newErasureRequestId(), input.tenantId, input.userId],
        );
        await expect(store.claimErasureJobs({
          nowMs: 100, limit: 1, leaseMs: 20, claimToken: "worker-corrupt",
        })).rejects.toThrow("does not match its active subject lifecycle");
        const [rows] = await conn.query<Row[]>(
          "SELECT attempts, claim_token, lease_until_ms FROM erasure_requests WHERE request_id=?",
          [input.requestId],
        );
        expect(rows[0]).toMatchObject({ attempts: 0, claim_token: null, lease_until_ms: null });

        await conn.query(
          `UPDATE subject_lifecycle SET active_request_id=?
            WHERE tenant_id=? AND subject_kind='user' AND subject_id=?`,
          [input.requestId, input.tenantId, input.userId],
        );
        await conn.query("DELETE FROM erasure_audit_events WHERE request_id=?", [input.requestId]);
        await expect(store.claimErasureJobs({
          nowMs: 100, limit: 1, leaseMs: 20, claimToken: "worker-no-audit",
        })).rejects.toThrow("audit chain is corrupt");
        const [afterAudit] = await conn.query<Row[]>(
          "SELECT attempts, claim_token FROM erasure_requests WHERE request_id=?",
          [input.requestId],
        );
        expect(afterAudit[0]).toMatchObject({ attempts: 0, claim_token: null });
      } finally {
        await conn.query(
          `UPDATE erasure_requests
              SET status='blocked', available_at_ms=NULL, claim_token=NULL, lease_until_ms=NULL,
                  last_error_code='integrity_conflict'
            WHERE request_id=?`,
          [input.requestId],
        ).catch(() => {});
        await conn.end();
        await store.close();
      }
    });

    it("rejects an audit payload with content fields and rolls a transition back", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const input = requestInput(`tenant_audit_content_${randomUUID()}`, `user_${randomUUID()}`, 300);
      try {
        await store.requestUserErasure(input);
        const claim = (await store.claimErasureJobs({
          nowMs: 300, limit: 1, leaseMs: 100, claimToken: "worker-audit-content",
        }))[0]!;
        await conn.query(
          "UPDATE erasure_audit_events SET payload=JSON_SET(payload, '$.prompt', 'secret') WHERE request_id=? AND seq=1",
          [input.requestId],
        );
        await expect(store.transitionErasureJob(authorization(claim), {
          fromStatus: "gated", toStatus: "draining", atMs: 301, availableAtMs: 301,
        })).rejects.toThrow("unexpected fields");
        const [rows] = await conn.query<Row[]>(
          "SELECT status, attempts, claim_token, lease_until_ms FROM erasure_requests WHERE request_id=?",
          [input.requestId],
        );
        expect(rows[0]).toMatchObject({
          status: "gated", attempts: 1, claim_token: "worker-audit-content", lease_until_ms: 400,
        });
      } finally {
        await conn.query(
          `UPDATE erasure_requests
              SET status='blocked', available_at_ms=NULL, claim_token=NULL, lease_until_ms=NULL,
                  last_error_code='integrity_conflict'
            WHERE request_id=?`,
          [input.requestId],
        ).catch(() => {});
        await conn.end();
        await store.close();
      }
    });

    it("does not deadlock an exact-boundary reclaim against a stale transition", async () => {
      const firstStore = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 6 });
      const secondStore = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 6 });
      try {
        for (let index = 0; index < 8; index += 1) {
          const atMs = 1_000 + index * 10;
          const input = requestInput(`tenant_lock_${randomUUID()}`, `user_${randomUUID()}`, atMs);
          await firstStore.requestUserErasure(input);
          const old = (await firstStore.claimErasureJobs({
            nowMs: atMs, limit: 1, leaseMs: 5, claimToken: `old-${index}`,
          }))[0]!;
          const settled = await Promise.allSettled([
            firstStore.claimErasureJobs({
              nowMs: atMs + 5, limit: 1, leaseMs: 20, claimToken: `new-${index}`,
            }),
            secondStore.transitionErasureJob(authorization(old), {
              fromStatus: "gated",
              toStatus: "draining",
              atMs: atMs + 5,
              availableAtMs: atMs + 5,
            }),
          ]);
          expect(settled.every((result) => result.status === "fulfilled")).toBe(true);
          expect(settled[1]).toMatchObject({ status: "fulfilled", value: false });
          expect(settled[0]).toMatchObject({ status: "fulfilled", value: [expect.objectContaining({
            requestId: input.requestId,
            claimToken: `new-${index}`,
          })] });
          if (settled[0]?.status !== "fulfilled" || !settled[0].value[0]) {
            throw new Error("boundary reclaim did not return its claim");
          }
          expect(await firstStore.transitionErasureJob(authorization(settled[0].value[0]), {
            fromStatus: "gated",
            toStatus: "blocked",
            atMs: atMs + 6,
            errorCode: "temporary_failure",
          })).toBe(true);
        }
      } finally {
        await secondStore.close();
        await firstStore.close();
      }
    }, 20_000);
  });
} else {
  describe("MysqlSessionStore durable erasure job queue", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 with a disposable MySQL test database to enable", () => {});
  });
}
