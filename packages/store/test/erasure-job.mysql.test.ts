import { randomUUID } from "node:crypto";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ErasureJobIntegrityFault,
  ErasureJobTransitionError,
  MysqlSessionStore,
  erasureJobControlOutcomeSha256,
  erasureJobInterventionEvidenceSha256,
  erasureJobTerminalInterventionEvidenceSha256,
  erasureJobUnsafeQuarantineEnvelopeEvidenceSha256,
  newErasureRequestId,
  publicErasureRequestStatus,
  userErasureRequestHash,
  validateErasureAuditChain,
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
        const boundPolicy = await store.putRetentionPolicy({
          tenantId: input.tenantId,
          policyVersion: "policy-v1",
          policy: {
            sessionContentRetentionMs: null,
            userErasureGraceMs: null,
            operationalUsageRetentionMs: null,
            idempotencyReceiptRetentionMs: null,
            billingFactRetentionMs: null,
            lifecycleAuditRetentionMs: null,
            exportArtifactTtlMs: null,
          },
          actorKeyId: "admin-key",
          atMs: 90,
        });
        await store.activateRetentionPolicy({
          tenantId: input.tenantId,
          policyVersion: "policy-v1",
          expectedControlGeneration: 0,
          actorKeyId: "admin-key",
          atMs: 95,
        });
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
          policyHash: boundPolicy.policySha256,
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
          policyHash: boundPolicy.policySha256,
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
          status: "draining", policyVersion: "policy-v1", policyHash: boundPolicy.policySha256,
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

    it("rejects retroactive policy adoption for a request admitted without a policy", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const input = requestInput(`tenant_policy_backlog_${randomUUID()}`, `user_${randomUUID()}`);
      try {
        const created = await store.requestUserErasure(input);
        expect(created).not.toHaveProperty("policyVersion");
        const claim = (await store.claimErasureJobs({
          nowMs: 100,
          limit: 1,
          leaseMs: 100,
          claimToken: "worker-policy-backlog",
        }))[0]!;
        await expect(store.transitionErasureJob(authorization(claim), {
          fromStatus: "gated",
          toStatus: "draining",
          atMs: 101,
          availableAtMs: 101,
          policyVersion: "later-policy",
          policyHash: "c".repeat(64),
        })).rejects.toThrow("cannot be assigned after admission");
        expect(await store.getUserErasureRequest(
          input.tenantId,
          input.userId,
          input.requestId,
        )).toMatchObject({
          status: "gated",
          claimToken: "worker-policy-backlog",
        });
        expect(await store.transitionErasureJob(authorization(claim), {
          fromStatus: "gated",
          toStatus: "blocked",
          atMs: 102,
          errorCode: "policy_unavailable",
        })).toBe(true);
        expect(await store.getUserErasureRequest(
          input.tenantId,
          input.userId,
          input.requestId,
        )).toMatchObject({ status: "blocked" });
      } finally {
        await store.close();
      }
    });

    it("does not let the non-destructive worker claim purging and leaves blocked subjects gated", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const completedInput = requestInput(`tenant_complete_${randomUUID()}`, `user_${randomUUID()}`);
      const blockedInput = requestInput(`tenant_blocked_${randomUUID()}`, `user_${randomUUID()}`, 200);
      try {
        await store.requestUserErasure(completedInput);
        const purgingAtMs = await seedPolicyApprovedPurging(conn, completedInput.requestId, 101);
        const purgingRecord = await store.getUserErasureRequest(
          completedInput.tenantId,
          completedInput.userId,
          completedInput.requestId,
        );
        const purgingAudits = await store.listErasureAuditEvents(completedInput.requestId);
        expect(() => validateErasureAuditChain(purgingRecord!, purgingAudits)).not.toThrow();
        expect(await store.claimErasureJobs({
          nowMs: purgingAtMs, limit: 1, leaseMs: 100, claimToken: "worker-complete",
        })).toEqual([]);
        expect(await store.getSubjectLifecycle(completedInput.tenantId, "user", completedInput.userId))
          .toMatchObject({ state: "deleting", generation: 1, activeRequestId: completedInput.requestId });
        expect(await store.getUserErasureRequest(
          completedInput.tenantId, completedInput.userId, completedInput.requestId,
        )).toMatchObject({
          status: "purging",
          attempts: 0,
          availableAtMs: purgingAtMs,
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

    it("durably quarantines owner binding corruption without granting worker authority", async () => {
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
        expect(await store.claimErasureJobs({
          nowMs: 100, limit: 1, leaseMs: 20, claimToken: "worker-corrupt",
        })).toEqual([]);
        const [rows] = await conn.query<Row[]>(
          `SELECT attempts, claim_token, lease_until_ms, available_at_ms, control_generation,
                  quarantine_reason_code
             FROM erasure_requests WHERE request_id=?`,
          [input.requestId],
        );
        expect(rows[0]).toMatchObject({
          attempts: 0,
          claim_token: null,
          lease_until_ms: null,
          available_at_ms: null,
          control_generation: 1,
          quarantine_reason_code: "subject_binding_invalid",
        });
      } finally {
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
        })).rejects.toMatchObject({
          name: "ErasureJobIntegrityFault",
          reasonCode: "audit_chain_invalid",
        } satisfies Partial<ErasureJobIntegrityFault>);
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

    it("quarantines every deterministic poison class without starving a valid neighbour", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const reasons = [
        "request_invalid",
        "subject_binding_invalid",
        "audit_chain_invalid",
        "idempotency_binding_invalid",
        "queue_control_invalid",
        "policy_identity_invalid",
        "control_audit_invalid",
      ] as const;
      const inputs = new Map<(typeof reasons)[number], ReturnType<typeof requestInput>>();
      try {
        for (const [index, reason] of reasons.entries()) {
          const input = requestInput(
            `tenant_control_${index}_${randomUUID()}`,
            `user_${randomUUID()}`,
            400,
          );
          inputs.set(reason, input);
          await store.requestUserErasure(input);
          switch (reason) {
            case "request_invalid":
              await conn.query(
                "UPDATE erasure_requests SET requested_by_key_id=? WHERE request_id=?",
                ["secret value must never reach control audit", input.requestId],
              );
              break;
            case "subject_binding_invalid":
              await conn.query(
                `UPDATE subject_lifecycle SET state='active', active_request_id=NULL
                  WHERE tenant_id=? AND subject_kind='user' AND subject_id=?`,
                [input.tenantId, input.userId],
              );
              break;
            case "audit_chain_invalid":
              await conn.query("DELETE FROM erasure_audit_events WHERE request_id=?", [input.requestId]);
              break;
            case "idempotency_binding_invalid":
              await conn.query(
                "UPDATE erasure_requests SET request_hash=? WHERE request_id=?",
                ["f".repeat(64), input.requestId],
              );
              break;
            case "queue_control_invalid":
              await conn.query(
                `UPDATE erasure_requests
                    SET quarantined_at_ms=400,
                        quarantine_reason_code=NULL,
                        quarantine_evidence_sha256=NULL
                  WHERE request_id=?`,
                [input.requestId],
              );
              break;
            case "policy_identity_invalid":
              await conn.query(
                "UPDATE erasure_requests SET policy_version='policy-v1', policy_hash=NULL WHERE request_id=?",
                [input.requestId],
              );
              break;
            case "control_audit_invalid": {
              await conn.query(
                "UPDATE erasure_requests SET requested_by_key_id=? WHERE request_id=?",
                ["private multi-poison actor must not leak", input.requestId],
              );
              const evidence = erasureJobInterventionEvidenceSha256({
                requestId: input.requestId,
                controlGeneration: 1,
                phase: "gated",
                kind: "quarantine",
                reasonCode: "queue_control_invalid",
              });
              await conn.query(
                `INSERT INTO erasure_job_control_events
                   (request_id, control_generation, event_type, phase, reason_code, action_code,
                    actor_key_id, before_sha256, after_sha256, emitted_at_ms)
                 VALUES (?,1,'erasure_job/quarantined','gated','queue_control_invalid',NULL,NULL,?,NULL,400)`,
                [input.requestId, evidence],
              );
              break;
            }
          }
        }
        const valid = requestInput(`tenant_control_valid_${randomUUID()}`, `user_${randomUUID()}`, 400);
        await store.requestUserErasure(valid);

        const claims = await store.claimErasureJobs({
          nowMs: 400,
          limit: reasons.length + 1,
          leaseMs: 100,
          claimToken: "worker-control-matrix",
        });
        expect(claims).toHaveLength(1);
        expect(claims[0]).toMatchObject({ requestId: valid.requestId, attempts: 1, status: "gated" });
        expect(await store.transitionErasureJob(authorization(claims[0]!), {
          fromStatus: "gated",
          toStatus: "blocked",
          atMs: 401,
          errorCode: "temporary_failure",
        })).toBe(true);

        for (const reason of reasons) {
          const input = inputs.get(reason)!;
          const [rows] = await conn.query<Row[]>(
            `SELECT status, attempts, available_at_ms, claim_token, lease_until_ms,
                    control_generation, quarantined_at_ms, quarantine_reason_code,
                    quarantine_evidence_sha256, policy_version, policy_hash
               FROM erasure_requests WHERE request_id=?`,
            [input.requestId],
          );
          expect(rows[0]).toMatchObject({
            status: "gated",
            attempts: 0,
            available_at_ms: null,
            claim_token: null,
            lease_until_ms: null,
            control_generation: reason === "control_audit_invalid" ? 2 : 1,
            quarantine_reason_code: reason,
          });
          expect(String(rows[0]!.quarantine_evidence_sha256)).toMatch(/^[0-9a-f]{64}$/);
          if (reason === "policy_identity_invalid") {
            expect(rows[0]).toMatchObject({ policy_version: "policy-v1", policy_hash: null });
          }

          const [events] = await conn.query<Row[]>(
            `SELECT event_type, phase, reason_code, action_code, actor_key_id,
                    before_sha256, after_sha256
              FROM erasure_job_control_events
              WHERE request_id=? ORDER BY control_generation DESC, control_event_id DESC LIMIT 1`,
            [input.requestId],
          );
          expect(events[0]).toMatchObject({
            event_type: "erasure_job/quarantined",
            phase: "gated",
            reason_code: reason,
            action_code: null,
            actor_key_id: null,
            after_sha256: null,
          });
          expect(JSON.stringify(events[0])).not.toContain("secret value must never reach control audit");
        }

        const requestPoison = inputs.get("request_invalid")!;
        const ownerRead = await store.getUserErasureRequest(
          requestPoison.tenantId,
          requestPoison.userId,
          requestPoison.requestId,
        );
        expect(ownerRead && publicErasureRequestStatus(ownerRead)).toBe("blocked");
        expect(await store.getUserErasureRequest(
          requestPoison.tenantId,
          `user_${randomUUID()}`,
          requestPoison.requestId,
        )).toBeNull();
        const controlPoison = inputs.get("control_audit_invalid")!;
        const controlInspection = await store.inspectErasureJobIntervention({
          tenantId: controlPoison.tenantId,
          subjectKind: "user",
          subjectId: controlPoison.userId,
          requestId: controlPoison.requestId,
          subjectGeneration: 1,
        });
        expect(controlInspection).toMatchObject({
          kind: "quarantine",
          reasonCode: "control_audit_invalid",
          allowedActions: [],
        });
        expect(await store.repairAndResumeErasureJob({
          tenantId: controlPoison.tenantId,
          subjectKind: "user",
          subjectId: controlPoison.userId,
          requestId: controlPoison.requestId,
          subjectGeneration: 1,
          expectedControlGeneration: controlInspection!.controlGeneration,
          expectedEvidenceSha256: controlInspection!.evidenceSha256,
          actorKeyId: "maintenance-key",
          actionCode: "resume_verified",
          atMs: 401,
        })).toBe(false);
        const [collisionRows] = await conn.query<Row[]>(
          `SELECT control_generation, event_type, reason_code
             FROM erasure_job_control_events
            WHERE request_id=? AND event_type='erasure_job/quarantined'
            ORDER BY control_event_id`,
          [controlPoison.requestId],
        );
        expect(collisionRows).toEqual([
          expect.objectContaining({
            control_generation: 1,
            event_type: "erasure_job/quarantined",
            reason_code: "queue_control_invalid",
          }),
          expect.objectContaining({
            control_generation: 2,
            event_type: "erasure_job/quarantined",
            reason_code: "control_audit_invalid",
          }),
        ]);

        const [beforeRestart] = await conn.query<Row[]>(
          `SELECT COUNT(*) total FROM erasure_job_control_events
            WHERE request_id=? AND event_type='erasure_job/quarantined'`,
          [requestPoison.requestId],
        );
        const restarted = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
        try {
          expect(await restarted.claimErasureJobs({
            nowMs: 450,
            limit: 20,
            leaseMs: 20,
            claimToken: "worker-after-restart",
          })).toEqual([]);
        } finally {
          await restarted.close();
        }
        const [afterRestart] = await conn.query<Row[]>(
          `SELECT COUNT(*) total FROM erasure_job_control_events
            WHERE request_id=? AND event_type='erasure_job/quarantined'`,
          [requestPoison.requestId],
        );
        expect(Number(afterRestart[0]?.total)).toBe(Number(beforeRestart[0]?.total));
      } finally {
        await conn.end();
        await store.close();
      }
    }, 30_000);

    it("rejects a forged repaired control history that predates the durable gate", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const input = requestInput(`tenant_control_before_gate_${randomUUID()}`, `user_${randomUUID()}`, 470);
      try {
        await store.requestUserErasure(input);
        const evidenceSha256 = erasureJobInterventionEvidenceSha256({
          requestId: input.requestId,
          controlGeneration: 1,
          phase: "gated",
          kind: "quarantine",
          reasonCode: "audit_chain_invalid",
        });
        const repairedOutcome = {
          requestId: input.requestId,
          controlGeneration: 2,
          eventType: "erasure_job/quarantine_repaired" as const,
          phase: "gated" as const,
          reasonCode: "audit_chain_invalid" as const,
          actionCode: "restore_initial_gate_audit" as const,
          actorKeyId: "admin-forged-history",
          beforeSha256: evidenceSha256,
          emittedAtMs: 469,
        };
        await conn.query(
          "UPDATE erasure_requests SET control_generation=2 WHERE request_id=?",
          [input.requestId],
        );
        await conn.query(
          `INSERT INTO erasure_job_control_events
             (request_id, control_generation, event_type, phase, reason_code, action_code,
              actor_key_id, before_sha256, after_sha256, emitted_at_ms)
           VALUES (?,1,'erasure_job/quarantined','gated','audit_chain_invalid',
                   NULL,NULL,?,NULL,469),
                  (?,2,'erasure_job/quarantine_repaired','gated','audit_chain_invalid',
                   'restore_initial_gate_audit',?,?,?,469)`,
          [
            input.requestId,
            evidenceSha256,
            input.requestId,
            repairedOutcome.actorKeyId,
            evidenceSha256,
            erasureJobControlOutcomeSha256(repairedOutcome),
          ],
        );

        expect(await store.claimErasureJobs({
          nowMs: 470,
          limit: 1,
          leaseMs: 50,
          claimToken: "worker-forged-history",
        })).toEqual([]);
        const [rows] = await conn.query<Row[]>(
          `SELECT attempts, control_generation, available_at_ms, claim_token, lease_until_ms,
                  quarantine_reason_code
             FROM erasure_requests WHERE request_id=?`,
          [input.requestId],
        );
        expect(rows[0]).toMatchObject({
          attempts: 0,
          control_generation: 3,
          available_at_ms: null,
          claim_token: null,
          lease_until_ms: null,
          quarantine_reason_code: "control_audit_invalid",
        });
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("quarantines an unsafe stored control generation without starving its neighbour", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const input = requestInput(`a_tenant_control_overflow_${randomUUID()}`, `user_${randomUUID()}`, 475);
      const neighbour = requestInput(`z_tenant_control_overflow_${randomUUID()}`, `user_${randomUUID()}`, 475);
      try {
        await store.requestUserErasure(input);
        await store.requestUserErasure(neighbour);
        await conn.query(
          `INSERT INTO erasure_job_control_events
             (request_id, control_generation, event_type, phase, reason_code, action_code,
              actor_key_id, before_sha256, after_sha256, emitted_at_ms)
           VALUES (?,9007199254740992,'erasure_job/quarantined','gated',
                   'queue_control_invalid',NULL,NULL,?,NULL,475)`,
          [input.requestId, "f".repeat(64)],
        );
        expect(await store.claimErasureJobs({
          nowMs: 475,
          limit: 1,
          leaseMs: 50,
          claimToken: "worker-control-overflow",
        })).toEqual([]);
        const [rows] = await conn.query<Row[]>(
          `SELECT attempts, control_generation, available_at_ms, quarantined_at_ms,
                  quarantine_reason_code, quarantine_evidence_sha256
             FROM erasure_requests WHERE request_id=?`,
          [input.requestId],
        );
        expect(rows[0]).toMatchObject({
          attempts: 0,
          control_generation: 1,
          available_at_ms: null,
          quarantined_at_ms: 475,
          quarantine_reason_code: "control_audit_invalid",
        });
        expect(String(rows[0]!.quarantine_evidence_sha256)).toMatch(/^[0-9a-f]{64}$/);

        const claimed = await store.claimErasureJobs({
          nowMs: 475,
          limit: 1,
          leaseMs: 50,
          claimToken: "worker-after-control-overflow",
        });
        expect(claimed).toEqual([expect.objectContaining({ requestId: neighbour.requestId })]);
        expect(await store.transitionErasureJob(authorization(claimed[0]!), {
          fromStatus: "gated",
          toStatus: "blocked",
          atMs: 476,
          errorCode: "temporary_failure",
        })).toBe(true);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it.each([
      {
        name: "reversed request timestamps",
        corrupt: async (conn: Connection, requestId: string) => {
          await conn.query(
            "UPDATE erasure_requests SET updated_at_ms=gated_at_ms-1 WHERE request_id=?",
            [requestId],
          );
        },
        assertPreserved: (row: Row, atMs: number) => {
          expect(Number(row.updated_at_ms)).toBe(atMs - 1);
        },
      },
      {
        name: "an unsafe request timestamp",
        corrupt: async (conn: Connection, requestId: string) => {
          await conn.query(
            "UPDATE erasure_requests SET updated_at_ms=9007199254740993 WHERE request_id=?",
            [requestId],
          );
        },
        assertPreserved: (row: Row) => {
          expect(String(row.updated_at_ms)).toBe("9007199254740993");
        },
      },
      {
        name: "an invalid subject identity",
        corrupt: async (conn: Connection, requestId: string) => {
          await conn.query(
            "UPDATE erasure_requests SET subject_id='unsafe subject identity' WHERE request_id=?",
            [requestId],
          );
        },
        assertPreserved: (row: Row) => {
          expect(String(row.subject_id)).toBe("unsafe subject identity");
        },
      },
      {
        name: "an unsafe subject generation",
        corrupt: async (conn: Connection, requestId: string) => {
          await conn.query(
            "UPDATE erasure_requests SET generation=9007199254740992 WHERE request_id=?",
            [requestId],
          );
        },
        assertPreserved: (row: Row) => {
          expect(String(row.generation)).toBe("9007199254740992");
        },
      },
    ])(
      "terminally isolates $name without rewriting the corrupt envelope or starving its neighbour",
      async ({ corrupt, assertPreserved }) => {
        const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 6 });
        const conn = await mysql.createConnection(mysqlUrl);
        const atMs = 478;
        const tenantId = `000_terminal_envelope_${randomUUID()}`;
        const poison = requestInput(tenantId, `a_poison_${randomUUID()}`, atMs);
        const neighbour = requestInput(tenantId, `z_neighbour_${randomUUID()}`, atMs + 1);
        try {
          await store.requestUserErasure(poison);
          await store.requestUserErasure(neighbour);
          await corrupt(conn, poison.requestId);

          const claimed = await store.claimErasureJobs({
            nowMs: atMs + 1,
            limit: 2,
            leaseMs: 50,
            claimToken: "worker-terminal-envelope",
          });
          expect(claimed).toEqual([
            expect.objectContaining({ requestId: neighbour.requestId, attempts: 1 }),
          ]);

          const [incidents] = await conn.query<Row[]>(
            `SELECT terminal_incident_id, request_id, raw_control_generation, reason_code,
                    evidence_sha256, emitted_at_ms
               FROM erasure_job_terminal_incidents WHERE request_id=?`,
            [poison.requestId],
          );
          expect(incidents).toHaveLength(1);
          expect(Number(incidents[0]!.terminal_incident_id)).toBeGreaterThan(0);
          expect(String(incidents[0]!.raw_control_generation)).toBe("0");
          expect(incidents[0]).toMatchObject({
            request_id: poison.requestId,
            reason_code: "unsafe_quarantine_envelope",
            emitted_at_ms: atMs + 1,
          });
          expect(String(incidents[0]!.evidence_sha256)).toMatch(/^[0-9a-f]{64}$/);

          const [rows] = await conn.query<Row[]>(
            `SELECT tenant_id, subject_id, generation, created_at_ms, gated_at_ms,
                    CAST(updated_at_ms AS CHAR) updated_at_ms,
                    control_generation, available_at_ms, claim_token, lease_until_ms,
                    quarantined_at_ms, quarantine_reason_code, quarantine_evidence_sha256
               FROM erasure_requests WHERE request_id=?`,
            [poison.requestId],
          );
          assertPreserved(rows[0]!, atMs);
          expect(String(rows[0]!.control_generation)).toBe("0");
          expect(rows[0]).toMatchObject({
            available_at_ms: null,
            claim_token: null,
            lease_until_ms: null,
            quarantined_at_ms: atMs + 1,
            quarantine_reason_code: "control_audit_invalid",
            quarantine_evidence_sha256: incidents[0]!.evidence_sha256,
          });
          const [controls] = await conn.query<Row[]>(
            "SELECT control_event_id FROM erasure_job_control_events WHERE request_id=?",
            [poison.requestId],
          );
          expect(controls).toEqual([]);

          expect(await store.transitionErasureJob(authorization(claimed[0]!), {
            fromStatus: "gated",
            toStatus: "blocked",
            atMs: atMs + 2,
            errorCode: "temporary_failure",
          })).toBe(true);
          expect(await store.claimErasureJobs({
            nowMs: atMs + 2,
            limit: 2,
            leaseMs: 50,
            claimToken: "worker-terminal-envelope-repeat",
          })).toEqual([]);
          const [afterRepeat] = await conn.query<Row[]>(
            "SELECT terminal_incident_id, evidence_sha256 FROM erasure_job_terminal_incidents WHERE request_id=?",
            [poison.requestId],
          );
          expect(afterRepeat).toEqual([{
            terminal_incident_id: incidents[0]!.terminal_incident_id,
            evidence_sha256: incidents[0]!.evidence_sha256,
          }]);
        } finally {
          await conn.end();
          await store.close();
        }
      },
      30_000,
    );

    it("treats a NULL gate timestamp at epoch zero as an unsafe terminal envelope", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 6 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `000_terminal_null_gate_${randomUUID()}`;
      const poison = requestInput(tenantId, `a_poison_${randomUUID()}`, 0);
      const neighbour = requestInput(tenantId, `z_neighbour_${randomUUID()}`, 1);
      try {
        await store.requestUserErasure(poison);
        await store.requestUserErasure(neighbour);
        await conn.query(
          "UPDATE erasure_requests SET gated_at_ms=NULL WHERE request_id=?",
          [poison.requestId],
        );

        const claimed = await store.claimErasureJobs({
          nowMs: 1,
          limit: 2,
          leaseMs: 50,
          claimToken: "worker-terminal-null-gate",
        });
        expect(claimed).toEqual([
          expect.objectContaining({ requestId: neighbour.requestId, attempts: 1 }),
        ]);

        const [rows] = await conn.query<Row[]>(
          `SELECT request_id, tenant_id, subject_kind, subject_id,
                  CAST(generation AS CHAR) generation_text, status,
                  CAST(created_at_ms AS CHAR) created_at_ms_text,
                  gated_at_ms,
                  CAST(updated_at_ms AS CHAR) updated_at_ms_text,
                  CAST(control_generation AS CHAR) control_generation_text,
                  available_at_ms, claim_token, lease_until_ms,
                  quarantined_at_ms, quarantine_reason_code, quarantine_evidence_sha256
             FROM erasure_requests WHERE request_id=?`,
          [poison.requestId],
        );
        const isolated = rows[0]!;
        expect(isolated).toMatchObject({
          request_id: poison.requestId,
          tenant_id: tenantId,
          subject_kind: "user",
          subject_id: poison.userId,
          status: "gated",
          gated_at_ms: null,
          available_at_ms: null,
          claim_token: null,
          lease_until_ms: null,
          quarantined_at_ms: 1,
          quarantine_reason_code: "control_audit_invalid",
        });
        expect(String(isolated.created_at_ms_text)).toBe("0");
        expect(String(isolated.updated_at_ms_text)).toBe("0");

        const expectedEvidenceSha256 = erasureJobUnsafeQuarantineEnvelopeEvidenceSha256({
          locatorRequestId: poison.requestId,
          requestId: String(isolated.request_id),
          tenantId: String(isolated.tenant_id),
          subjectKind: String(isolated.subject_kind),
          subjectId: String(isolated.subject_id),
          rawGeneration: String(isolated.generation_text),
          status: String(isolated.status),
          rawCreatedAtMs: String(isolated.created_at_ms_text),
          rawGatedAtMs: null,
          rawUpdatedAtMs: String(isolated.updated_at_ms_text),
          rawControlGeneration: String(isolated.control_generation_text),
        });
        expect(String(isolated.quarantine_evidence_sha256)).toBe(expectedEvidenceSha256);

        const [incidents] = await conn.query<Row[]>(
          `SELECT request_id, CAST(raw_control_generation AS CHAR) raw_control_generation_text,
                  reason_code, evidence_sha256, emitted_at_ms
             FROM erasure_job_terminal_incidents WHERE request_id=?`,
          [poison.requestId],
        );
        expect(incidents).toEqual([{
          request_id: poison.requestId,
          raw_control_generation_text: "0",
          reason_code: "unsafe_quarantine_envelope",
          evidence_sha256: expectedEvidenceSha256,
          emitted_at_ms: 1,
        }]);
        expect(await store.transitionErasureJob(authorization(claimed[0]!), {
          fromStatus: "gated",
          toStatus: "blocked",
          atMs: 2,
          errorCode: "temporary_failure",
        })).toBe(true);
      } finally {
        await conn.end();
        await store.close();
      }
    }, 30_000);

    it("records one unsafe-envelope incident across competing stores and claims its neighbour once", async () => {
      const firstStore = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 6 });
      const secondStore = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 6 });
      const conn = await mysql.createConnection(mysqlUrl);
      const atMs = 479;
      const tenantId = `000_terminal_concurrent_${randomUUID()}`;
      const poison = requestInput(tenantId, `a_poison_${randomUUID()}`, atMs);
      const neighbour = requestInput(tenantId, `z_neighbour_${randomUUID()}`, atMs + 1);
      try {
        await firstStore.requestUserErasure(poison);
        await firstStore.requestUserErasure(neighbour);
        await conn.query(
          "UPDATE erasure_requests SET updated_at_ms=gated_at_ms-1 WHERE request_id=?",
          [poison.requestId],
        );

        const results = await Promise.all([
          firstStore.claimErasureJobs({
            nowMs: atMs + 1,
            limit: 1,
            leaseMs: 50,
            claimToken: "worker-terminal-concurrent-a",
          }),
          secondStore.claimErasureJobs({
            nowMs: atMs + 1,
            limit: 1,
            leaseMs: 50,
            claimToken: "worker-terminal-concurrent-b",
          }),
        ]);
        const claims = results.flat();
        expect(claims).toEqual([
          expect.objectContaining({ requestId: neighbour.requestId, attempts: 1 }),
        ]);

        const [incidents] = await conn.query<Row[]>(
          `SELECT terminal_incident_id, request_id, reason_code, evidence_sha256
             FROM erasure_job_terminal_incidents WHERE request_id=?`,
          [poison.requestId],
        );
        expect(incidents).toHaveLength(1);
        expect(incidents[0]).toMatchObject({
          request_id: poison.requestId,
          reason_code: "unsafe_quarantine_envelope",
        });
        expect(await firstStore.transitionErasureJob(authorization(claims[0]!), {
          fromStatus: "gated",
          toStatus: "blocked",
          atMs: atMs + 2,
          errorCode: "temporary_failure",
        })).toBe(true);

        expect((await Promise.all([
          firstStore.claimErasureJobs({
            nowMs: atMs + 2,
            limit: 2,
            leaseMs: 50,
            claimToken: "worker-terminal-repeat-a",
          }),
          secondStore.claimErasureJobs({
            nowMs: atMs + 2,
            limit: 2,
            leaseMs: 50,
            claimToken: "worker-terminal-repeat-b",
          }),
        ])).flat()).toEqual([]);
        const [afterRepeat] = await conn.query<Row[]>(
          "SELECT COUNT(*) total FROM erasure_job_terminal_incidents WHERE request_id=?",
          [poison.requestId],
        );
        expect(Number(afterRepeat[0]!.total)).toBe(1);
        const [neighbourRows] = await conn.query<Row[]>(
          "SELECT attempts FROM erasure_requests WHERE request_id=?",
          [neighbour.requestId],
        );
        expect(Number(neighbourRows[0]!.attempts)).toBe(1);
      } finally {
        await conn.end();
        await secondStore.close();
        await firstStore.close();
      }
    }, 30_000);

    it("rolls an unsafe-envelope incident insert back and isolates it on retry before reaching the neighbour", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 6 });
      const conn = await mysql.createConnection(mysqlUrl);
      const trigger = "fail_terminal_incident_insert";
      const atMs = 481;
      const rawControlGeneration = "9007199254740993";
      const tenantId = `000_terminal_rollback_${randomUUID()}`;
      const poison = requestInput(tenantId, `a_poison_${randomUUID()}`, atMs);
      const neighbour = requestInput(tenantId, `z_neighbour_${randomUUID()}`, atMs + 1);
      try {
        await store.requestUserErasure(poison);
        await store.requestUserErasure(neighbour);
        await conn.query(
          `UPDATE erasure_requests
              SET generation=9007199254740992, control_generation=?
            WHERE request_id=?`,
          [rawControlGeneration, poison.requestId],
        );
        await conn.query(
          `CREATE TRIGGER ${trigger} BEFORE INSERT ON erasure_job_terminal_incidents
           FOR EACH ROW SIGNAL SQLSTATE '45000'
             SET MESSAGE_TEXT='injected terminal incident insert failure'`,
        );

        await expect(store.claimErasureJobs({
          nowMs: atMs + 1,
          limit: 2,
          leaseMs: 50,
          claimToken: "worker-terminal-incident-failure",
        })).rejects.toThrow("injected terminal incident insert failure");
        const [rolledBack] = await conn.query<Row[]>(
          `SELECT CAST(generation AS CHAR) generation_text,
                  CAST(control_generation AS CHAR) control_generation_text,
                  available_at_ms, claim_token, lease_until_ms,
                  quarantined_at_ms, quarantine_reason_code, quarantine_evidence_sha256
             FROM erasure_requests WHERE request_id=?`,
          [poison.requestId],
        );
        expect(String(rolledBack[0]!.generation_text)).toBe("9007199254740992");
        expect(String(rolledBack[0]!.control_generation_text)).toBe(rawControlGeneration);
        expect(rolledBack[0]).toMatchObject({
          available_at_ms: atMs,
          claim_token: null,
          lease_until_ms: null,
          quarantined_at_ms: null,
          quarantine_reason_code: null,
          quarantine_evidence_sha256: null,
        });
        const [beforeRetry] = await conn.query<Row[]>(
          "SELECT terminal_incident_id FROM erasure_job_terminal_incidents WHERE request_id=?",
          [poison.requestId],
        );
        expect(beforeRetry).toEqual([]);

        await conn.query(`DROP TRIGGER ${trigger}`);
        const claimed = await store.claimErasureJobs({
          nowMs: atMs + 1,
          limit: 2,
          leaseMs: 50,
          claimToken: "worker-terminal-incident-retry",
        });
        expect(claimed).toEqual([
          expect.objectContaining({ requestId: neighbour.requestId, attempts: 1 }),
        ]);
        const [incidents] = await conn.query<Row[]>(
          `SELECT CAST(raw_control_generation AS CHAR) raw_control_generation_text,
                  reason_code, evidence_sha256
             FROM erasure_job_terminal_incidents WHERE request_id=?`,
          [poison.requestId],
        );
        expect(incidents).toHaveLength(1);
        expect(String(incidents[0]!.raw_control_generation_text)).toBe(rawControlGeneration);
        expect(incidents[0]!.reason_code).toBe("unsafe_quarantine_envelope");
        const [isolated] = await conn.query<Row[]>(
          `SELECT request_id, tenant_id, subject_kind, subject_id,
                  CAST(generation AS CHAR) generation_text, status,
                  CAST(created_at_ms AS CHAR) created_at_ms_text,
                  CAST(gated_at_ms AS CHAR) gated_at_ms_text,
                  CAST(updated_at_ms AS CHAR) updated_at_ms_text,
                  CAST(control_generation AS CHAR) control_generation_text,
                  available_at_ms, claim_token, lease_until_ms,
                  quarantine_reason_code, quarantine_evidence_sha256
             FROM erasure_requests WHERE request_id=?`,
          [poison.requestId],
        );
        expect(String(isolated[0]!.generation_text)).toBe("9007199254740992");
        expect(String(isolated[0]!.control_generation_text)).toBe(rawControlGeneration);
        const expectedEvidenceSha256 = erasureJobUnsafeQuarantineEnvelopeEvidenceSha256({
          locatorRequestId: poison.requestId,
          requestId: String(isolated[0]!.request_id),
          tenantId: String(isolated[0]!.tenant_id),
          subjectKind: String(isolated[0]!.subject_kind),
          subjectId: String(isolated[0]!.subject_id),
          rawGeneration: String(isolated[0]!.generation_text),
          status: String(isolated[0]!.status),
          rawCreatedAtMs: String(isolated[0]!.created_at_ms_text),
          rawGatedAtMs: String(isolated[0]!.gated_at_ms_text),
          rawUpdatedAtMs: String(isolated[0]!.updated_at_ms_text),
          rawControlGeneration: String(isolated[0]!.control_generation_text),
        });
        expect(String(incidents[0]!.evidence_sha256)).toBe(expectedEvidenceSha256);
        expect(isolated[0]).toMatchObject({
          available_at_ms: null,
          claim_token: null,
          lease_until_ms: null,
          quarantine_reason_code: "control_audit_invalid",
          quarantine_evidence_sha256: expectedEvidenceSha256,
        });
        expect(await store.transitionErasureJob(authorization(claimed[0]!), {
          fromStatus: "gated",
          toStatus: "blocked",
          atMs: atMs + 2,
          errorCode: "temporary_failure",
        })).toBe(true);
      } finally {
        await conn.query(`DROP TRIGGER IF EXISTS ${trigger}`).catch(() => {});
        await conn.end();
        await store.close();
      }
    }, 30_000);

    it("terminally quarantines saturated request fences exactly once without a control event", async () => {
      const firstStore = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 6 });
      const secondStore = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 6 });
      const conn = await mysql.createConnection(mysqlUrl);
      const observationTable = "terminal_quarantine_observations";
      const observationTrigger = "observe_terminal_quarantine";
      const controlTrigger = "fail_terminal_control_insert";
      try {
        await conn.query(
          `CREATE TABLE ${observationTable} (
             request_id VARCHAR(64) PRIMARY KEY,
             updates INT NOT NULL
           ) ENGINE=InnoDB`,
        );
        await conn.query(
          `CREATE TRIGGER ${observationTrigger} AFTER UPDATE ON erasure_requests
           FOR EACH ROW BEGIN
             IF OLD.quarantine_reason_code IS NULL
                AND NEW.quarantine_reason_code = 'control_audit_invalid' THEN
               INSERT INTO ${observationTable} (request_id, updates) VALUES (NEW.request_id, 1)
               ON DUPLICATE KEY UPDATE updates=updates+1;
             END IF;
           END`,
        );
        // The terminal path has no collision-free generation, so it must not attempt this insert.
        await conn.query(
          `CREATE TRIGGER ${controlTrigger} BEFORE INSERT ON erasure_job_control_events
           FOR EACH ROW SIGNAL SQLSTATE '45000'
             SET MESSAGE_TEXT='terminal quarantine must not insert a control event'`,
        );

        for (const [index, rawControlGeneration] of [
          String(Number.MAX_SAFE_INTEGER),
          (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString(),
        ].entries()) {
          const atMs = 480 + index * 10;
          const poison = requestInput(
            `a_tenant_terminal_${index}_${randomUUID()}`,
            `user_${randomUUID()}`,
            atMs,
          );
          const neighbour = requestInput(
            `z_tenant_terminal_${index}_${randomUUID()}`,
            `user_${randomUUID()}`,
            atMs,
          );
          await firstStore.requestUserErasure(poison);
          const staleClaim = (await firstStore.claimErasureJobs({
            nowMs: atMs,
            limit: 1,
            leaseMs: 50,
            claimToken: `worker-before-terminal-${index}`,
          }))[0]!;
          expect(staleClaim.requestId).toBe(poison.requestId);
          await firstStore.requestUserErasure(neighbour);
          await conn.query(
            `UPDATE erasure_requests
                SET control_generation=?, available_at_ms=20000
              WHERE request_id=?`,
            [rawControlGeneration, poison.requestId],
          );

          const results = await Promise.all([
            firstStore.claimErasureJobs({
              nowMs: atMs,
              limit: 1,
              leaseMs: 50,
              claimToken: `worker-terminal-a-${index}`,
            }),
            secondStore.claimErasureJobs({
              nowMs: atMs,
              limit: 1,
              leaseMs: 50,
              claimToken: `worker-terminal-b-${index}`,
            }),
          ]);
          expect(results.flat()).toEqual([
            expect.objectContaining({ requestId: neighbour.requestId }),
          ]);

          const expectedEvidence = erasureJobTerminalInterventionEvidenceSha256({
            requestId: poison.requestId,
            rawControlGeneration,
            phase: "gated",
            reasonCode: "control_audit_invalid",
          });
          const [rows] = await conn.query<Row[]>(
            `SELECT attempts, control_generation, available_at_ms, claim_token, lease_until_ms,
                    quarantined_at_ms, quarantine_reason_code, quarantine_evidence_sha256
               FROM erasure_requests WHERE request_id=?`,
            [poison.requestId],
          );
          expect(String(rows[0]!.control_generation)).toBe(rawControlGeneration);
          expect(rows[0]).toMatchObject({
            attempts: 1,
            available_at_ms: null,
            claim_token: null,
            lease_until_ms: null,
            quarantined_at_ms: atMs,
            quarantine_reason_code: "control_audit_invalid",
            quarantine_evidence_sha256: expectedEvidence,
          });
          const [controls] = await conn.query<Row[]>(
            "SELECT control_event_id FROM erasure_job_control_events WHERE request_id=?",
            [poison.requestId],
          );
          expect(controls).toEqual([]);
          const [observations] = await conn.query<Row[]>(
            `SELECT updates FROM ${observationTable} WHERE request_id=?`,
            [poison.requestId],
          );
          expect(Number(observations[0]?.updates)).toBe(1);

          const ownerRead = await firstStore.getUserErasureRequest(
            poison.tenantId,
            poison.userId,
            poison.requestId,
          );
          expect(ownerRead).toMatchObject({
            controlGeneration: Number.MAX_SAFE_INTEGER,
            quarantineReasonCode: "control_audit_invalid",
          });
          expect(ownerRead).not.toHaveProperty("rawControlGeneration");
          expect(ownerRead).not.toHaveProperty("controlGenerationSaturated");
          expect(publicErasureRequestStatus(ownerRead!)).toBe("blocked");

          const identity = {
            tenantId: poison.tenantId,
            subjectKind: "user" as const,
            subjectId: poison.userId,
            requestId: poison.requestId,
            subjectGeneration: 1,
          };
          const inspection = (await firstStore.inspectErasureJobIntervention(identity))!;
          expect(inspection).toMatchObject({
            controlGeneration: Number.MAX_SAFE_INTEGER,
            phase: "gated",
            kind: "quarantine",
            reasonCode: "control_audit_invalid",
            evidenceSha256: expectedEvidence,
            allowedActions: [],
          });
          expect(await firstStore.repairAndResumeErasureJob({
            ...identity,
            expectedControlGeneration: inspection.controlGeneration,
            expectedEvidenceSha256: inspection.evidenceSha256,
            actorKeyId: `admin-terminal-${index}`,
            actionCode: "resume_verified",
            atMs: atMs + 1,
          })).toBe(false);
          if (BigInt(rawControlGeneration) > BigInt(Number.MAX_SAFE_INTEGER)) {
            const projectedEvidence = erasureJobInterventionEvidenceSha256({
              requestId: poison.requestId,
              controlGeneration: Number.MAX_SAFE_INTEGER,
              phase: "gated",
              kind: "quarantine",
              reasonCode: "control_audit_invalid",
            });
            await conn.query(
              "UPDATE erasure_requests SET quarantine_evidence_sha256=? WHERE request_id=?",
              [projectedEvidence, poison.requestId],
            );
            await expect(firstStore.inspectErasureJobIntervention(identity))
              .rejects.toThrow("erasure quarantine evidence is corrupt");
            await conn.query(
              "UPDATE erasure_requests SET quarantine_evidence_sha256=? WHERE request_id=?",
              [expectedEvidence, poison.requestId],
            );
          }
          await expect(firstStore.transitionErasureJob(authorization(staleClaim), {
            fromStatus: "gated",
            toStatus: "draining",
            atMs: atMs + 1,
            availableAtMs: atMs + 1,
          })).rejects.toMatchObject({
            name: "ErasureJobIntegrityFault",
            reasonCode: "control_audit_invalid",
          });

          const neighbourClaim = results.flat()[0]!;
          expect(await firstStore.transitionErasureJob(authorization(neighbourClaim), {
            fromStatus: "gated",
            toStatus: "blocked",
            atMs: atMs + 1,
            errorCode: "temporary_failure",
          })).toBe(true);
        }
      } finally {
        await conn.query(`DROP TRIGGER IF EXISTS ${controlTrigger}`).catch(() => {});
        await conn.query(`DROP TRIGGER IF EXISTS ${observationTrigger}`).catch(() => {});
        await conn.query(`DROP TABLE IF EXISTS ${observationTable}`).catch(() => {});
        await conn.end();
        await secondStore.close();
        await firstStore.close();
      }
    }, 30_000);

    it("rolls back a failed terminal quarantine update and later reaches the neighbour", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 6 });
      const conn = await mysql.createConnection(mysqlUrl);
      const trigger = "fail_terminal_quarantine_update";
      const rawControlGeneration = (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString();
      const poison = requestInput(`a_tenant_terminal_rollback_${randomUUID()}`, `user_${randomUUID()}`, 495);
      const neighbour = requestInput(`z_tenant_terminal_rollback_${randomUUID()}`, `user_${randomUUID()}`, 495);
      try {
        await store.requestUserErasure(poison);
        await store.requestUserErasure(neighbour);
        await conn.query(
          `UPDATE erasure_requests
              SET control_generation=?, available_at_ms=30000
            WHERE request_id=?`,
          [rawControlGeneration, poison.requestId],
        );
        await conn.query(
          `CREATE TRIGGER ${trigger} BEFORE UPDATE ON erasure_requests
           FOR EACH ROW BEGIN
             IF NEW.request_id = '${poison.requestId}'
                AND OLD.quarantine_reason_code IS NULL
                AND NEW.quarantine_reason_code = 'control_audit_invalid' THEN
               SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected terminal quarantine update failure';
             END IF;
           END`,
        );

        await expect(store.claimErasureJobs({
          nowMs: 495,
          limit: 1,
          leaseMs: 50,
          claimToken: "worker-terminal-update-failure",
        })).rejects.toThrow("injected terminal quarantine update failure");
        const [rolledBack] = await conn.query<Row[]>(
          `SELECT attempts, control_generation, available_at_ms, claim_token, lease_until_ms,
                  quarantined_at_ms, quarantine_reason_code, quarantine_evidence_sha256
             FROM erasure_requests WHERE request_id=?`,
          [poison.requestId],
        );
        expect(String(rolledBack[0]!.control_generation)).toBe(rawControlGeneration);
        expect(rolledBack[0]).toMatchObject({
          attempts: 0,
          available_at_ms: 30000,
          claim_token: null,
          lease_until_ms: null,
          quarantined_at_ms: null,
          quarantine_reason_code: null,
          quarantine_evidence_sha256: null,
        });
        const [controls] = await conn.query<Row[]>(
          "SELECT control_event_id FROM erasure_job_control_events WHERE request_id=?",
          [poison.requestId],
        );
        expect(controls).toEqual([]);

        await conn.query(`DROP TRIGGER ${trigger}`);
        const claims = await store.claimErasureJobs({
          nowMs: 495,
          limit: 2,
          leaseMs: 50,
          claimToken: "worker-after-terminal-update-failure",
        });
        expect(claims).toEqual([expect.objectContaining({ requestId: neighbour.requestId })]);
        const [afterRetry] = await conn.query<Row[]>(
          "SELECT control_generation, quarantine_reason_code FROM erasure_requests WHERE request_id=?",
          [poison.requestId],
        );
        expect(String(afterRetry[0]!.control_generation)).toBe(rawControlGeneration);
        expect(afterRetry[0]!.quarantine_reason_code).toBe("control_audit_invalid");
        expect(await store.transitionErasureJob(authorization(claims[0]!), {
          fromStatus: "gated",
          toStatus: "blocked",
          atMs: 496,
          errorCode: "temporary_failure",
        })).toBe(true);
      } finally {
        await conn.query(`DROP TRIGGER IF EXISTS ${trigger}`).catch(() => {});
        await conn.end();
        await store.close();
      }
    }, 30_000);

    it("phase-one isolates complete invalid queue fields even when they are not normally due", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const badLease = requestInput(`a_tenant_queue_poison_${randomUUID()}`, `user_${randomUUID()}`, 490);
      const badAvailability = requestInput(`b_tenant_queue_poison_${randomUUID()}`, `user_${randomUUID()}`, 490);
      const neighbour = requestInput(`z_tenant_queue_poison_${randomUUID()}`, `user_${randomUUID()}`, 490);
      try {
        await store.requestUserErasure(badLease);
        await store.requestUserErasure(badAvailability);
        await store.requestUserErasure(neighbour);
        await conn.query(
          `UPDATE erasure_requests
              SET claim_token='invalid token', lease_until_ms=9223372036854775807
            WHERE request_id=?`,
          [badLease.requestId],
        );
        await conn.query(
          "UPDATE erasure_requests SET available_at_ms=9007199254740992 WHERE request_id=?",
          [badAvailability.requestId],
        );

        const claims = await store.claimErasureJobs({
          nowMs: 490,
          limit: 3,
          leaseMs: 50,
          claimToken: "worker-after-queue-poison",
        });
        expect(claims).toEqual([expect.objectContaining({ requestId: neighbour.requestId })]);

        const [rows] = await conn.query<Row[]>(
          `SELECT request_id, attempts, control_generation, available_at_ms, claim_token,
                  lease_until_ms, quarantine_reason_code
             FROM erasure_requests
            WHERE request_id IN (?,?) ORDER BY request_id`,
          [badLease.requestId, badAvailability.requestId],
        );
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(row).toMatchObject({
            attempts: 0,
            control_generation: 1,
            available_at_ms: null,
            claim_token: null,
            lease_until_ms: null,
            quarantine_reason_code: "queue_control_invalid",
          });
        }
        expect(await store.transitionErasureJob(authorization(claims[0]!), {
          fromStatus: "gated",
          toStatus: "blocked",
          atMs: 491,
          errorCode: "temporary_failure",
        })).toBe(true);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("rolls back a failed control audit atomically and preserves an earlier candidate quarantine", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 6 });
      const conn = await mysql.createConnection(mysqlUrl);
      const first = requestInput(`a_tenant_candidate_${randomUUID()}`, `user_${randomUUID()}`, 500);
      const later = requestInput(`z_tenant_candidate_${randomUUID()}`, `user_${randomUUID()}`, 500);
      try {
        await store.requestUserErasure(first);
        await store.requestUserErasure(later);
        await conn.query("DELETE FROM erasure_audit_events WHERE request_id IN (?,?)", [first.requestId, later.requestId]);
        await conn.query(
          `CREATE TRIGGER fail_selected_erasure_control BEFORE INSERT ON erasure_job_control_events
           FOR EACH ROW BEGIN
             IF NEW.request_id = '${later.requestId}' THEN
               SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected selected control audit failure';
             END IF;
           END`,
        );
        await expect(store.claimErasureJobs({
          nowMs: 500,
          limit: 2,
          leaseMs: 50,
          claimToken: "worker-isolated-control",
        })).rejects.toThrow("injected selected control audit failure");
        const [rows] = await conn.query<Row[]>(
          `SELECT request_id, control_generation, quarantine_reason_code, available_at_ms, attempts
             FROM erasure_requests WHERE request_id IN (?,?) ORDER BY request_id`,
          [first.requestId, later.requestId],
        );
        const firstRow = rows.find((row) => row.request_id === first.requestId)!;
        const laterRow = rows.find((row) => row.request_id === later.requestId)!;
        expect(firstRow).toMatchObject({
          control_generation: 1,
          quarantine_reason_code: "audit_chain_invalid",
          available_at_ms: null,
          attempts: 0,
        });
        expect(laterRow).toMatchObject({
          control_generation: 0,
          quarantine_reason_code: null,
          available_at_ms: 500,
          attempts: 0,
        });
        await conn.query("DROP TRIGGER fail_selected_erasure_control");
        expect(await store.claimErasureJobs({
          nowMs: 500,
          limit: 2,
          leaseMs: 50,
          claimToken: "worker-control-retry",
        })).toEqual([]);
        const [laterAfter] = await conn.query<Row[]>(
          "SELECT control_generation, quarantine_reason_code FROM erasure_requests WHERE request_id=?",
          [later.requestId],
        );
        expect(laterAfter[0]).toMatchObject({
          control_generation: 1,
          quarantine_reason_code: "audit_chain_invalid",
        });
      } finally {
        await conn.query("DROP TRIGGER IF EXISTS fail_selected_erasure_control").catch(() => {});
        await conn.end();
        await store.close();
      }
    });

    it("returns an already committed claim before surfacing a later candidate SQL failure", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 6 });
      const conn = await mysql.createConnection(mysqlUrl);
      const valid = requestInput(`a_tenant_claim_${randomUUID()}`, `user_${randomUUID()}`, 550);
      const later = requestInput(`z_tenant_claim_${randomUUID()}`, `user_${randomUUID()}`, 550);
      const trigger = "fail_later_erasure_control";
      try {
        await store.requestUserErasure(valid);
        await store.requestUserErasure(later);
        await conn.query("DELETE FROM erasure_audit_events WHERE request_id=?", [later.requestId]);
        await conn.query(
          `CREATE TRIGGER ${trigger} BEFORE INSERT ON erasure_job_control_events
           FOR EACH ROW BEGIN
             IF NEW.request_id = '${later.requestId}' THEN
               SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected later candidate failure';
             END IF;
           END`,
        );

        const claims = await store.claimErasureJobs({
          nowMs: 550,
          limit: 2,
          leaseMs: 50,
          claimToken: "worker-partial-success",
        });
        expect(claims).toEqual([expect.objectContaining({
          requestId: valid.requestId,
          attempts: 1,
          claimToken: "worker-partial-success",
        })]);
        const [laterRows] = await conn.query<Row[]>(
          `SELECT attempts, control_generation, available_at_ms, quarantined_at_ms,
                  quarantine_reason_code
             FROM erasure_requests WHERE request_id=?`,
          [later.requestId],
        );
        expect(laterRows[0]).toMatchObject({
          attempts: 0,
          control_generation: 0,
          available_at_ms: 550,
          quarantined_at_ms: null,
          quarantine_reason_code: null,
        });
        expect(await store.transitionErasureJob(authorization(claims[0]!), {
          fromStatus: "gated",
          toStatus: "blocked",
          atMs: 551,
          errorCode: "temporary_failure",
        })).toBe(true);

        await expect(store.claimErasureJobs({
          nowMs: 550,
          limit: 1,
          leaseMs: 50,
          claimToken: "worker-surface-later",
        })).rejects.toThrow("injected later candidate failure");
        await conn.query(`DROP TRIGGER ${trigger}`);
        expect(await store.claimErasureJobs({
          nowMs: 550,
          limit: 1,
          leaseMs: 50,
          claimToken: "worker-quarantine-later",
        })).toEqual([]);
        const [quarantined] = await conn.query<Row[]>(
          "SELECT control_generation, quarantine_reason_code FROM erasure_requests WHERE request_id=?",
          [later.requestId],
        );
        expect(quarantined[0]).toMatchObject({
          control_generation: 1,
          quarantine_reason_code: "audit_chain_invalid",
        });
      } finally {
        await conn.query(`DROP TRIGGER IF EXISTS ${trigger}`).catch(() => {});
        await conn.end();
        await store.close();
      }
    });

    it("does not let a locked scan head consume a limit-one claim budget", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 6 });
      const locker = await mysql.createConnection(mysqlUrl);
      const locked = requestInput(`a_tenant_locked_${randomUUID()}`, `user_${randomUUID()}`, 575);
      const available = requestInput(`b_tenant_available_${randomUUID()}`, `user_${randomUUID()}`, 575);
      try {
        await store.requestUserErasure(locked);
        await store.requestUserErasure(available);
        await locker.beginTransaction();
        await locker.query("SELECT request_id FROM erasure_requests WHERE request_id=? FOR UPDATE", [locked.requestId]);

        const claims = await store.claimErasureJobs({
          nowMs: 575,
          limit: 1,
          leaseMs: 50,
          claimToken: "worker-skip-locked-head",
        });
        expect(claims).toEqual([expect.objectContaining({ requestId: available.requestId, attempts: 1 })]);
        expect(await store.transitionErasureJob(authorization(claims[0]!), {
          fromStatus: "gated",
          toStatus: "blocked",
          atMs: 576,
          errorCode: "temporary_failure",
        })).toBe(true);

        await locker.rollback();
        const released = (await store.claimErasureJobs({
          nowMs: 575,
          limit: 1,
          leaseMs: 50,
          claimToken: "worker-after-unlock",
        }))[0]!;
        expect(released).toMatchObject({ requestId: locked.requestId, attempts: 1 });
        expect(await store.transitionErasureJob(authorization(released), {
          fromStatus: "gated",
          toStatus: "blocked",
          atMs: 576,
          errorCode: "temporary_failure",
        })).toBe(true);
      } finally {
        await locker.rollback().catch(() => {});
        await locker.end();
        await store.close();
      }
    });

    it("rejects stale user claim authority after the parent tenant stops being active", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const input = requestInput(`tenant_parent_gate_${randomUUID()}`, `user_${randomUUID()}`, 590);
      try {
        await store.requestUserErasure(input);
        const claim = (await store.claimErasureJobs({
          nowMs: 590,
          limit: 1,
          leaseMs: 50,
          claimToken: "worker-parent-gate",
        }))[0]!;
        const auth = authorization(claim);
        await conn.query(
          `UPDATE subject_lifecycle
              SET state='deleting', generation=1, active_request_id=?, updated_at_ms=591
            WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=?`,
          [newErasureRequestId(), input.tenantId, input.tenantId],
        );
        expect(await store.renewErasureJobClaim(auth, { nowMs: 591, leaseMs: 50 })).toBe(false);

        await conn.query(
          `UPDATE subject_lifecycle
              SET state='erased', active_request_id=NULL, updated_at_ms=592
            WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=?`,
          [input.tenantId, input.tenantId],
        );
        expect(await store.transitionErasureJob(auth, {
          fromStatus: "gated",
          toStatus: "draining",
          atMs: 592,
          availableAtMs: 592,
        })).toBe(false);
        expect(await store.retryErasureJob(auth, {
          failedAtMs: 592,
          availableAtMs: 600,
          errorCode: "temporary_failure",
        })).toBe(false);
        const [unchanged] = await conn.query<Row[]>(
          "SELECT status, attempts, claim_token, lease_until_ms FROM erasure_requests WHERE request_id=?",
          [input.requestId],
        );
        expect(unchanged[0]).toMatchObject({
          status: "gated",
          attempts: 1,
          claim_token: "worker-parent-gate",
          lease_until_ms: 640,
        });

        await conn.query(
          `UPDATE subject_lifecycle
              SET state='active', active_request_id=NULL, updated_at_ms=593
            WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=?`,
          [input.tenantId, input.tenantId],
        );
        expect(await store.transitionErasureJob(auth, {
          fromStatus: "gated",
          toStatus: "blocked",
          atMs: 593,
          errorCode: "temporary_failure",
        })).toBe(true);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("repairs queue and empty-audit quarantines with owner/evidence/generation CAS", async () => {
      const firstStore = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const secondStore = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const auditInput = requestInput(`tenant_repair_audit_${randomUUID()}`, `user_${randomUUID()}`, 600);
      const queueInput = requestInput(`tenant_repair_queue_${randomUUID()}`, `user_${randomUUID()}`, 600);
      try {
        await firstStore.requestUserErasure(auditInput);
        await conn.query("DELETE FROM erasure_audit_events WHERE request_id=?", [auditInput.requestId]);
        expect(await firstStore.claimErasureJobs({
          nowMs: 600, limit: 1, leaseMs: 50, claimToken: "worker-repair-audit",
        })).toEqual([]);
        const auditIdentity = {
          tenantId: auditInput.tenantId,
          subjectKind: "user" as const,
          subjectId: auditInput.userId,
          requestId: auditInput.requestId,
          subjectGeneration: 1,
        };
        const auditInspection = await firstStore.inspectErasureJobIntervention(auditIdentity);
        expect(auditInspection).toMatchObject({
          kind: "quarantine",
          phase: "gated",
          controlGeneration: 1,
          reasonCode: "audit_chain_invalid",
          allowedActions: ["restore_initial_gate_audit"],
        });
        expect(await firstStore.inspectErasureJobIntervention({
          ...auditIdentity,
          tenantId: `tenant_other_${randomUUID()}`,
        })).toBeNull();
        const otherUser = `user_${randomUUID()}`;
        expect(await firstStore.inspectErasureJobIntervention({
          ...auditIdentity,
          subjectId: otherUser,
        })).toBeNull();
        expect(await firstStore.repairAndResumeErasureJob({
          ...auditIdentity,
          subjectId: otherUser,
          expectedControlGeneration: auditInspection!.controlGeneration,
          expectedEvidenceSha256: auditInspection!.evidenceSha256,
          actorKeyId: "maintenance-key",
          actionCode: "restore_initial_gate_audit",
          atMs: 610,
        })).toBe(false);
        expect(await firstStore.repairAndResumeErasureJob({
          ...auditIdentity,
          expectedControlGeneration: 1,
          expectedEvidenceSha256: "0".repeat(64),
          actorKeyId: "maintenance-key",
          actionCode: "restore_initial_gate_audit",
          atMs: 610,
        })).toBe(false);
        const repairInput = {
          ...auditIdentity,
          expectedControlGeneration: auditInspection!.controlGeneration,
          expectedEvidenceSha256: auditInspection!.evidenceSha256,
          actorKeyId: "maintenance-key",
          actionCode: "restore_initial_gate_audit" as const,
          atMs: 610,
        };
        const repaired = await Promise.all([
          firstStore.repairAndResumeErasureJob(repairInput),
          secondStore.repairAndResumeErasureJob(repairInput),
        ]);
        expect(repaired.sort()).toEqual([false, true]);
        expect(await firstStore.repairAndResumeErasureJob(repairInput)).toBe(false);
        const auditClaimResults = await Promise.all([
          firstStore.claimErasureJobs({ nowMs: 610, limit: 1, leaseMs: 50, claimToken: "repair-a" }),
          secondStore.claimErasureJobs({ nowMs: 610, limit: 1, leaseMs: 50, claimToken: "repair-b" }),
        ]);
        expect(auditClaimResults.flat()).toHaveLength(1);
        expect(auditClaimResults.flat()[0]).toMatchObject({ requestId: auditInput.requestId, attempts: 1 });
        const [auditRows] = await conn.query<Row[]>(
          "SELECT event_type FROM erasure_audit_events WHERE request_id=? ORDER BY seq",
          [auditInput.requestId],
        );
        expect(auditRows).toEqual([{ event_type: "erasure/gated" }]);
        expect(await firstStore.transitionErasureJob(authorization(auditClaimResults.flat()[0]!), {
          fromStatus: "gated",
          toStatus: "blocked",
          atMs: 611,
          errorCode: "policy_unavailable",
        })).toBe(true);
        const [auditControl] = await conn.query<Row[]>(
          `SELECT control_generation, event_type, action_code, actor_key_id
             FROM erasure_job_control_events
            WHERE request_id=? ORDER BY control_generation, control_event_id`,
          [auditInput.requestId],
        );
        expect(auditControl).toEqual([
          expect.objectContaining({ control_generation: 1, event_type: "erasure_job/quarantined" }),
          expect.objectContaining({
            control_generation: 2,
            event_type: "erasure_job/quarantine_repaired",
            action_code: "restore_initial_gate_audit",
            actor_key_id: "maintenance-key",
          }),
        ]);

        await firstStore.requestUserErasure(queueInput);
        await conn.query(
          "UPDATE erasure_requests SET available_at_ms=NULL, claim_token='partial', lease_until_ms=NULL WHERE request_id=?",
          [queueInput.requestId],
        );
        expect(await firstStore.claimErasureJobs({
          nowMs: 600, limit: 1, leaseMs: 50, claimToken: "worker-repair-queue",
        })).toEqual([]);
        const queueIdentity = {
          tenantId: queueInput.tenantId,
          subjectKind: "user" as const,
          subjectId: queueInput.userId,
          requestId: queueInput.requestId,
          subjectGeneration: 1,
        };
        const queueInspection = await firstStore.inspectErasureJobIntervention(queueIdentity);
        expect(queueInspection).toMatchObject({
          reasonCode: "queue_control_invalid",
          allowedActions: ["normalize_queue_control"],
        });
        expect(await firstStore.repairAndResumeErasureJob({
          ...queueIdentity,
          expectedControlGeneration: queueInspection!.controlGeneration,
          expectedEvidenceSha256: queueInspection!.evidenceSha256,
          actorKeyId: "maintenance-key",
          actionCode: "resume_verified",
          atMs: 620,
        })).toBe(false);
        expect(await firstStore.repairAndResumeErasureJob({
          ...queueIdentity,
          expectedControlGeneration: queueInspection!.controlGeneration,
          expectedEvidenceSha256: queueInspection!.evidenceSha256,
          actorKeyId: "maintenance-key",
          actionCode: "normalize_queue_control",
          atMs: 620,
        })).toBe(true);
        const normalized = (await firstStore.claimErasureJobs({
          nowMs: 620, limit: 1, leaseMs: 50, claimToken: "worker-normalized",
        }))[0]!;
        expect(normalized).toMatchObject({ requestId: queueInput.requestId, attempts: 1 });
        expect(await firstStore.transitionErasureJob(authorization(normalized), {
          fromStatus: "gated",
          toStatus: "blocked",
          atMs: 621,
          errorCode: "policy_unavailable",
        })).toBe(true);
      } finally {
        await conn.end();
        await secondStore.close();
        await firstStore.close();
      }
    }, 30_000);

    it("recomputes quarantine evidence inside the mutating repair transaction", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const input = requestInput(`tenant_repair_evidence_${randomUUID()}`, `user_${randomUUID()}`, 650);
      const forgedEvidence = "f".repeat(64);
      try {
        await store.requestUserErasure(input);
        const canonicalEvidence = erasureJobInterventionEvidenceSha256({
          requestId: input.requestId,
          controlGeneration: 1,
          phase: "gated",
          kind: "quarantine",
          reasonCode: "queue_control_invalid",
        });
        expect(forgedEvidence).not.toBe(canonicalEvidence);
        await conn.query(
          `UPDATE erasure_requests
              SET control_generation=1, quarantined_at_ms=650,
                  quarantine_reason_code='queue_control_invalid',
                  quarantine_evidence_sha256=?, available_at_ms=NULL,
                  claim_token=NULL, lease_until_ms=NULL, updated_at_ms=650
            WHERE request_id=?`,
          [forgedEvidence, input.requestId],
        );
        await conn.query(
          `INSERT INTO erasure_job_control_events
             (request_id, control_generation, event_type, phase, reason_code, action_code,
              actor_key_id, before_sha256, after_sha256, emitted_at_ms)
           VALUES (?,1,'erasure_job/quarantined','gated','queue_control_invalid',
                   NULL,NULL,?,NULL,650)`,
          [input.requestId, forgedEvidence],
        );
        const identity = {
          tenantId: input.tenantId,
          subjectKind: "user" as const,
          subjectId: input.userId,
          requestId: input.requestId,
          subjectGeneration: 1,
        };

        await expect(store.inspectErasureJobIntervention(identity))
          .rejects.toThrow("erasure quarantine control evidence is not canonical");
        expect(await store.repairAndResumeErasureJob({
          ...identity,
          expectedControlGeneration: 1,
          expectedEvidenceSha256: forgedEvidence,
          actorKeyId: "maintenance-key",
          actionCode: "normalize_queue_control",
          atMs: 651,
        })).toBe(false);

        const [rows] = await conn.query<Row[]>(
          `SELECT control_generation, quarantine_reason_code, quarantine_evidence_sha256,
                  available_at_ms
             FROM erasure_requests WHERE request_id=?`,
          [input.requestId],
        );
        expect(rows[0]).toMatchObject({
          control_generation: 1,
          quarantine_reason_code: "queue_control_invalid",
          quarantine_evidence_sha256: forgedEvidence,
          available_at_ms: null,
        });
        const [controls] = await conn.query<Row[]>(
          "SELECT event_type FROM erasure_job_control_events WHERE request_id=?",
          [input.requestId],
        );
        expect(controls).toEqual([{ event_type: "erasure_job/quarantined" }]);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("quarantines a replayable blocked-resume control event with no matching main audit pair", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const input = requestInput(`tenant_resume_pair_${randomUUID()}`, `user_${randomUUID()}`, 660);
      try {
        await store.requestUserErasure(input);
        const beforeSha256 = erasureJobInterventionEvidenceSha256({
          requestId: input.requestId,
          controlGeneration: 0,
          phase: "blocked",
          kind: "blocked",
          reasonCode: "integrity_conflict",
        });
        const outcome = {
          requestId: input.requestId,
          controlGeneration: 1,
          eventType: "erasure_job/blocked_resumed" as const,
          phase: "gated" as const,
          reasonCode: "integrity_conflict" as const,
          actionCode: "resume_blocked" as const,
          actorKeyId: "maintenance-forged-pair",
          beforeSha256,
          emittedAtMs: 660,
        };
        const afterSha256 = erasureJobControlOutcomeSha256(outcome);
        await conn.query(
          "UPDATE erasure_requests SET control_generation=1 WHERE request_id=?",
          [input.requestId],
        );
        await conn.query(
          `INSERT INTO erasure_job_control_events
             (request_id, control_generation, event_type, phase, reason_code, action_code,
              actor_key_id, before_sha256, after_sha256, emitted_at_ms)
           VALUES (?,1,'erasure_job/blocked_resumed','gated','integrity_conflict',
                   'resume_blocked',?,?,?,660)`,
          [input.requestId, outcome.actorKeyId, beforeSha256, afterSha256],
        );

        // The row and the gated main audit agree; only the forged cross-audit control fact is bad.
        expect(await store.claimErasureJobs({
          nowMs: 660,
          limit: 1,
          leaseMs: 50,
          claimToken: "worker-forged-resume-pair",
        })).toEqual([]);
        const [rows] = await conn.query<Row[]>(
          `SELECT attempts, control_generation, available_at_ms, claim_token, lease_until_ms,
                  quarantine_reason_code
             FROM erasure_requests WHERE request_id=?`,
          [input.requestId],
        );
        expect(rows[0]).toMatchObject({
          attempts: 0,
          control_generation: 2,
          available_at_ms: null,
          claim_token: null,
          lease_until_ms: null,
          quarantine_reason_code: "control_audit_invalid",
        });
        const inspection = await store.inspectErasureJobIntervention({
          tenantId: input.tenantId,
          subjectKind: "user",
          subjectId: input.userId,
          requestId: input.requestId,
          subjectGeneration: 1,
        });
        expect(inspection).toMatchObject({
          kind: "quarantine",
          reasonCode: "control_audit_invalid",
          allowedActions: [],
        });
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("rolls back repair state and main audit when final control publication fails", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const gateInput = requestInput(`tenant_repair_rollback_${randomUUID()}`, `user_${randomUUID()}`, 680);
      const blockedInput = requestInput(`tenant_resume_rollback_${randomUUID()}`, `user_${randomUUID()}`, 680);
      const trigger = "fail_erasure_maintenance_control";
      try {
        await store.requestUserErasure(gateInput);
        await conn.query("DELETE FROM erasure_audit_events WHERE request_id=?", [gateInput.requestId]);
        expect(await store.claimErasureJobs({
          nowMs: 680, limit: 1, leaseMs: 50, claimToken: "worker-repair-rollback",
        })).toEqual([]);
        const gateIdentity = {
          tenantId: gateInput.tenantId,
          subjectKind: "user" as const,
          subjectId: gateInput.userId,
          requestId: gateInput.requestId,
          subjectGeneration: 1,
        };
        const gateInspection = (await store.inspectErasureJobIntervention(gateIdentity))!;
        expect(gateInspection.allowedActions).toContain("restore_initial_gate_audit");

        await store.requestUserErasure(blockedInput);
        const blockedClaim = (await store.claimErasureJobs({
          nowMs: 680, limit: 1, leaseMs: 50, claimToken: "worker-resume-rollback",
        }))[0]!;
        expect(blockedClaim.requestId).toBe(blockedInput.requestId);
        expect(await store.transitionErasureJob(authorization(blockedClaim), {
          fromStatus: "gated",
          toStatus: "blocked",
          atMs: 681,
          errorCode: "integrity_conflict",
        })).toBe(true);
        const blockedIdentity = {
          tenantId: blockedInput.tenantId,
          subjectKind: "user" as const,
          subjectId: blockedInput.userId,
          requestId: blockedInput.requestId,
          subjectGeneration: 1,
        };
        const blockedInspection = (await store.inspectErasureJobIntervention(blockedIdentity))!;
        expect(blockedInspection.allowedActions).toEqual(["resume_blocked"]);

        await conn.query(
          `CREATE TRIGGER ${trigger} BEFORE INSERT ON erasure_job_control_events
           FOR EACH ROW BEGIN
             IF NEW.request_id IN ('${gateInput.requestId}', '${blockedInput.requestId}')
                AND NEW.event_type IN ('erasure_job/quarantine_repaired', 'erasure_job/blocked_resumed') THEN
               SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected maintenance control audit failure';
             END IF;
           END`,
        );

        await expect(store.repairAndResumeErasureJob({
          ...gateIdentity,
          expectedControlGeneration: gateInspection.controlGeneration,
          expectedEvidenceSha256: gateInspection.evidenceSha256,
          actorKeyId: "maintenance-key",
          actionCode: "restore_initial_gate_audit",
          atMs: 682,
        })).rejects.toThrow("injected maintenance control audit failure");
        const [gateRows] = await conn.query<Row[]>(
          `SELECT status, control_generation, available_at_ms, quarantine_reason_code
             FROM erasure_requests WHERE request_id=?`,
          [gateInput.requestId],
        );
        expect(gateRows[0]).toMatchObject({
          status: "gated",
          control_generation: 1,
          available_at_ms: null,
          quarantine_reason_code: "audit_chain_invalid",
        });
        const [gateAudits] = await conn.query<Row[]>(
          "SELECT event_type FROM erasure_audit_events WHERE request_id=? ORDER BY seq",
          [gateInput.requestId],
        );
        expect(gateAudits).toEqual([]);
        const [gateControls] = await conn.query<Row[]>(
          "SELECT event_type FROM erasure_job_control_events WHERE request_id=? ORDER BY control_event_id",
          [gateInput.requestId],
        );
        expect(gateControls).toEqual([{ event_type: "erasure_job/quarantined" }]);

        await expect(store.repairAndResumeErasureJob({
          ...blockedIdentity,
          expectedControlGeneration: blockedInspection.controlGeneration,
          expectedEvidenceSha256: blockedInspection.evidenceSha256,
          actorKeyId: "maintenance-key",
          actionCode: "resume_blocked",
          atMs: 682,
        })).rejects.toThrow("injected maintenance control audit failure");
        const [blockedRows] = await conn.query<Row[]>(
          `SELECT status, control_generation, available_at_ms, last_error_code
             FROM erasure_requests WHERE request_id=?`,
          [blockedInput.requestId],
        );
        expect(blockedRows[0]).toMatchObject({
          status: "blocked",
          control_generation: 0,
          available_at_ms: null,
          last_error_code: "integrity_conflict",
        });
        const [blockedAudits] = await conn.query<Row[]>(
          "SELECT event_type FROM erasure_audit_events WHERE request_id=? ORDER BY seq",
          [blockedInput.requestId],
        );
        expect(blockedAudits).toEqual([
          { event_type: "erasure/gated" },
          { event_type: "erasure/blocked" },
        ]);
        const [blockedControls] = await conn.query<Row[]>(
          "SELECT event_type FROM erasure_job_control_events WHERE request_id=?",
          [blockedInput.requestId],
        );
        expect(blockedControls).toEqual([]);
      } finally {
        await conn.query(`DROP TRIGGER IF EXISTS ${trigger}`).catch(() => {});
        await conn.end();
        await store.close();
      }
    }, 30_000);

    it("resumes blocked jobs only from the audit-derived safe phase", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const safeInput = requestInput(`tenant_resume_safe_${randomUUID()}`, `user_${randomUUID()}`, 700);
      const heldInput = requestInput(`tenant_resume_hold_${randomUUID()}`, `user_${randomUUID()}`, 700);
      try {
        await store.requestUserErasure(safeInput);
        const safeClaim = (await store.claimErasureJobs({
          nowMs: 700, limit: 1, leaseMs: 50, claimToken: "worker-block-safe",
        }))[0]!;
        expect(await store.transitionErasureJob(authorization(safeClaim), {
          fromStatus: "gated", toStatus: "blocked", atMs: 701, errorCode: "integrity_conflict",
        })).toBe(true);
        const safeIdentity = {
          tenantId: safeInput.tenantId,
          subjectKind: "user" as const,
          subjectId: safeInput.userId,
          requestId: safeInput.requestId,
          subjectGeneration: 1,
        };
        const safeInspection = await store.inspectErasureJobIntervention(safeIdentity);
        expect(safeInspection).toMatchObject({
          kind: "blocked",
          phase: "blocked",
          reasonCode: "integrity_conflict",
          resumePhase: "gated",
          allowedActions: ["resume_blocked"],
        });
        expect(await store.repairAndResumeErasureJob({
          ...safeIdentity,
          expectedControlGeneration: safeInspection!.controlGeneration,
          expectedEvidenceSha256: safeInspection!.evidenceSha256,
          actorKeyId: "maintenance-key",
          actionCode: "resume_blocked",
          atMs: 702,
        })).toBe(true);
        const resumedClaim = (await store.claimErasureJobs({
          nowMs: 702, limit: 1, leaseMs: 50, claimToken: "worker-resumed",
        }))[0]!;
        expect(resumedClaim).toMatchObject({ requestId: safeInput.requestId, status: "gated", attempts: 2 });
        expect((await store.listErasureAuditEvents(safeInput.requestId)).at(-1)).toMatchObject({
          type: "erasure/resumed",
          payload: { fromStatus: "blocked", status: "gated", generation: 1 },
        });
        expect(await store.transitionErasureJob(authorization(resumedClaim), {
          fromStatus: "gated",
          toStatus: "blocked",
          atMs: 703,
          errorCode: "policy_unavailable",
        })).toBe(true);

        await store.requestUserErasure(heldInput);
        const heldClaim = (await store.claimErasureJobs({
          nowMs: 700, limit: 1, leaseMs: 50, claimToken: "worker-block-held",
        }))[0]!;
        expect(await store.transitionErasureJob(authorization(heldClaim), {
          fromStatus: "gated", toStatus: "blocked", atMs: 701, errorCode: "legal_hold",
        })).toBe(true);
        const heldIdentity = {
          tenantId: heldInput.tenantId,
          subjectKind: "user" as const,
          subjectId: heldInput.userId,
          requestId: heldInput.requestId,
          subjectGeneration: 1,
        };
        const heldInspection = await store.inspectErasureJobIntervention(heldIdentity);
        expect(heldInspection).toMatchObject({ allowedActions: [] });
        expect(await store.repairAndResumeErasureJob({
          ...heldIdentity,
          expectedControlGeneration: heldInspection!.controlGeneration,
          expectedEvidenceSha256: heldInspection!.evidenceSha256,
          actorKeyId: "maintenance-key",
          actionCode: "resume_blocked",
          atMs: 702,
        })).toBe(false);
      } finally {
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
