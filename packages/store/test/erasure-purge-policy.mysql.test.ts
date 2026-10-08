import { randomUUID } from "node:crypto";
import { emptyUsage, type Session } from "@agent-service/protocol";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BLOB_STORAGE_FORMAT,
  ErasurePurgeEvidenceChangedError,
  MysqlSessionStore,
  erasurePolicyDecisionSha256,
  erasurePurgeAuthoritySha256,
  newErasureRequestId,
  newUsageId,
  userErasureRequestHash,
  type ErasureJobClaim,
  type ErasurePolicyEvaluationAuthorization,
  type RetentionPolicyDocumentV1,
  type UsageLedgerEntry,
} from "../src/index.js";
import { mkSession, newId } from "./conformance.js";

const BASE_MYSQL_URL = process.env.MYSQL_TEST_URL ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const BASE = 10_000;
type Row = RowDataPacket;

function assertDisposableTestTarget(rawUrl: string): URL {
  const url = new URL(rawUrl);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) {
    throw new Error(
      `refusing to create purge-policy fixture database from base database "${database}": `
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

function policy(overrides: Partial<RetentionPolicyDocumentV1> = {}): RetentionPolicyDocumentV1 {
  return {
    sessionContentRetentionMs: 0,
    userErasureGraceMs: 0,
    operationalUsageRetentionMs: 0,
    idempotencyReceiptRetentionMs: 0,
    billingFactRetentionMs: null,
    lifecycleAuditRetentionMs: null,
    exportArtifactTtlMs: null,
    ...overrides,
  };
}

function jobAuthorization(claim: ErasureJobClaim) {
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

function evaluationAuthorization(
  claim: Awaited<ReturnType<MysqlSessionStore["claimErasurePolicyEvaluations"]>>[number],
): ErasurePolicyEvaluationAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectKind: claim.subjectKind,
    subjectId: claim.subjectId,
    subjectGeneration: claim.subjectGeneration,
    buildGeneration: claim.buildGeneration,
    claimToken: claim.claimToken,
    claimAttempt: claim.claimAttempt,
  };
}

function noDeadlock(result: PromiseSettledResult<unknown>): void {
  if (result.status === "fulfilled") return;
  const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
  expect(message).not.toMatch(/deadlock|lock wait timeout/i);
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore purge-policy evaluation", () => {
    let admin: Connection | undefined;
    let mysqlUrl = "";
    let database = "";

    beforeAll(async () => {
      const base = assertDisposableTestTarget(BASE_MYSQL_URL);
      database = `agent_service_purge_policy_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
      if (!/^agent_service_purge_policy_test_[a-zA-Z0-9_]+$/.test(database)) {
        throw new Error("unsafe generated purge-policy fixture database name");
      }
      admin = await mysql.createConnection(databaseUrl(base, "mysql"));
      await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
      mysqlUrl = databaseUrl(base, database);
      const migrated = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 2 });
      await migrated.close();
    });

    afterAll(async () => {
      if (admin && database) await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      await admin?.end();
    });

    async function tombstoneAndReconcile(
      store: MysqlSessionStore,
      tenantId: string,
      userId: string,
      options: { stageExpiredBlob?: boolean } = {},
    ): Promise<{
      session: Session;
      reconciliation: Awaited<ReturnType<MysqlSessionStore["reconcileSessionUsage"]>>;
      blobId?: string;
    }> {
      const session: Session = {
        ...mkSession(tenantId, userId),
        createdAtMs: BASE,
        updatedAtMs: BASE,
      };
      await store.createSession(session);
      let blobId: string | undefined;
      if (options.stageExpiredBlob) {
        blobId = newId("blob");
        await store.stageBlob({
          owner: { tenantId, userId },
          sessionId: session.id,
          fence: 1,
          blobId,
          purpose: "tool_output",
          storageBackend: "mysql-v1",
          storageFormat: BLOB_STORAGE_FORMAT,
          storageKey: `objects/${blobId.slice(5)}`,
          uploadToken: `upload-${blobId.slice(5)}`,
          createdAtMs: BASE,
          stagingExpiresAtMs: BASE + 50,
        });
      }
      const usage: UsageLedgerEntry & { usageId: string } = {
        usageId: newUsageId(),
        tenantId,
        userId,
        sessionId: session.id,
        turnId: newId("turn"),
        step: 1,
        provider: "provider-a",
        model: "model-a",
        usage: { ...emptyUsage(), inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        createdAtMs: BASE + 10,
      };
      await store.commit({
        sessionId: session.id,
        fence: 1,
        lifecycle: {
          type: "tombstone",
          tenantId,
          userId,
          deletionGeneration: 1,
          atMs: BASE + 100,
        },
        events: [{
          type: "session/deleted",
          sessionId: session.id,
          deletionGeneration: 1,
          emittedAtMs: BASE + 100,
        }],
        usageEntries: [usage],
      });
      const reconciliation = await store.reconcileSessionUsage({
        tenantId,
        userId,
        sessionId: session.id,
        deletionGeneration: 1,
        nowMs: BASE + 200,
      });
      return { session, reconciliation, ...(blobId === undefined ? {} : { blobId }) };
    }

    async function awaitingRequest(
      store: MysqlSessionStore,
      options: {
        tenantId: string;
        userId: string;
        policy?: RetentionPolicyDocumentV1;
        policyAtMs?: number;
        requestAtMs?: number;
      },
    ) {
      const requestAtMs = options.requestAtMs ?? BASE + 300;
      if (options.policy) {
        const record = await store.putRetentionPolicy({
          tenantId: options.tenantId,
          policyVersion: "policy-v1",
          policy: options.policy,
          actorKeyId: "policy-admin",
          atMs: options.policyAtMs ?? BASE + 1,
        });
        await store.activateRetentionPolicy({
          tenantId: options.tenantId,
          policyVersion: record.policyVersion,
          expectedControlGeneration: 0,
          actorKeyId: "policy-admin",
          atMs: options.policyAtMs ?? BASE + 2,
        });
      }
      const input = {
        requestId: newErasureRequestId(),
        tenantId: options.tenantId,
        userId: options.userId,
        requestedByKeyId: "erasure-admin",
        idempotencyKey: `erase-${options.userId}`,
        requestHash: userErasureRequestHash(options.tenantId, options.userId),
        atMs: requestAtMs,
      };
      await store.requestUserErasure(input);
      const transitions = [
        ["gated", "draining"],
        ["draining", "tombstoning"],
        ["tombstoning", "reconciling_usage"],
        ["reconciling_usage", "awaiting_purge_policy"],
      ] as const;
      for (const [index, [fromStatus, toStatus]] of transitions.entries()) {
        const atMs = requestAtMs + index + 1;
        const claim = (await store.claimErasureJobs({
          nowMs: atMs,
          limit: 1,
          leaseMs: 50,
          claimToken: `erasure-worker-${index}`,
        }))[0]!;
        expect(claim.status).toBe(fromStatus);
        expect(await store.transitionErasureJob(jobAuthorization(claim), {
          fromStatus,
          toStatus,
          atMs,
          ...(toStatus === "awaiting_purge_policy" ? {} : { availableAtMs: atMs }),
        })).toBe(true);
      }
      return input;
    }

    async function claimEvaluation(store: MysqlSessionStore, nowMs: number, requestId: string) {
      const claims = await store.claimErasurePolicyEvaluations({
        nowMs,
        limit: 100,
        leaseMs: 100,
        claimToken: "evaluation-worker-0001",
      });
      const claim = claims.find((candidate) => candidate.requestId === requestId);
      if (!claim) throw new Error(`expected evaluation claim for ${requestId}`);
      return { claim, authorization: evaluationAuthorization(claim) };
    }

    it("atomically schedules awaiting work and fences claim ABA", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const tenantId = `tenant_eval_queue_${randomUUID()}`;
      const userId = `user_${randomUUID()}`;
      try {
        await tombstoneAndReconcile(store, tenantId, userId);
        const input = await awaitingRequest(store, { tenantId, userId, policy: policy() });
        expect(await store.getErasurePolicyEvaluationJob(input.requestId)).toMatchObject({
          buildGeneration: 1,
          targetCount: 0,
          attempts: 0,
          availableAtMs: BASE + 304,
        });
        const first = (await store.claimErasurePolicyEvaluations({
          nowMs: BASE + 304,
          limit: 1,
          leaseMs: 10,
          claimToken: "evaluation-reused-token",
        }))[0]!;
        const taken = (await store.claimErasurePolicyEvaluations({
          nowMs: BASE + 314,
          limit: 1,
          leaseMs: 20,
          claimToken: "evaluation-reused-token",
        }))[0]!;
        expect(taken.claimAttempt).toBe(2);
        expect(await store.renewErasurePolicyEvaluation(evaluationAuthorization(first), {
          nowMs: BASE + 314,
          leaseMs: 50,
        })).toBe(false);
        expect(await store.retryErasurePolicyEvaluation(evaluationAuthorization(taken), {
          failedAtMs: BASE + 315,
          availableAtMs: BASE + 320,
          errorCode: "temporary_failure",
        })).toBe(true);
      } finally {
        await store.close();
      }
    });

    it("serializes two schedulers when a legacy awaiting row has no evaluation job", async () => {
      const setup = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 2 });
      const direct = await mysql.createConnection(mysqlUrl);
      const left = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 1 });
      const right = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 1 });
      const tenantId = `tenant_eval_dual_${randomUUID()}`;
      const userId = `user_${randomUUID()}`;
      try {
        await tombstoneAndReconcile(setup, tenantId, userId);
        const input = await awaitingRequest(setup, { tenantId, userId, policy: policy() });
        await direct.query(
          "DELETE FROM erasure_policy_evaluation_jobs WHERE request_id=?",
          [input.requestId],
        );
        const scheduled = await Promise.all([
          left.scheduleAwaitingErasurePolicyEvaluations({ nowMs: BASE + 305, limit: 100 }),
          right.scheduleAwaitingErasurePolicyEvaluations({ nowMs: BASE + 305, limit: 100 }),
        ]);
        expect(scheduled[0]! + scheduled[1]!).toBe(1);
        const [rows] = await direct.query<Row[]>(
          `SELECT COUNT(*) AS row_count, MIN(build_generation) AS min_generation,
                  MAX(build_generation) AS max_generation
             FROM erasure_policy_evaluation_jobs WHERE request_id=?`,
          [input.requestId],
        );
        expect(rows[0]).toMatchObject({ row_count: 1, min_generation: 1, max_generation: 1 });
      } finally {
        await right.close();
        await left.close();
        await direct.end();
        await setup.close();
      }
    });

    it("rolls back reconciling to awaiting together with the first evaluation job", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 2 });
      const direct = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant_eval_transition_${randomUUID()}`;
      const userId = `user_${randomUUID()}`;
      const requestId = newErasureRequestId();
      try {
        await store.requestUserErasure({
          requestId,
          tenantId,
          userId,
          requestedByKeyId: "erasure-admin",
          idempotencyKey: `erase-${userId}`,
          requestHash: userErasureRequestHash(tenantId, userId),
          atMs: BASE + 300,
        });
        for (const [index, [fromStatus, toStatus]] of ([
          ["gated", "draining"],
          ["draining", "tombstoning"],
          ["tombstoning", "reconciling_usage"],
        ] as const).entries()) {
          const atMs = BASE + 301 + index;
          const claim = (await store.claimErasureJobs({
            nowMs: atMs,
            limit: 1,
            leaseMs: 50,
            claimToken: `transition-worker-${index}`,
          })).find((candidate) => candidate.requestId === requestId)!;
          expect(await store.transitionErasureJob(jobAuthorization(claim), {
            fromStatus,
            toStatus,
            atMs,
            availableAtMs: atMs,
          })).toBe(true);
        }
        const claim = (await store.claimErasureJobs({
          nowMs: BASE + 304,
          limit: 100,
          leaseMs: 50,
          claimToken: "transition-worker-final",
        })).find((candidate) => candidate.requestId === requestId)!;
        await direct.query("DROP TRIGGER IF EXISTS test_fail_evaluation_job_insert");
        await direct.query(
          `CREATE TRIGGER test_fail_evaluation_job_insert
             BEFORE INSERT ON erasure_policy_evaluation_jobs
             FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected evaluation job insert failure'`,
        );
        await expect(store.transitionErasureJob(jobAuthorization(claim), {
          fromStatus: "reconciling_usage",
          toStatus: "awaiting_purge_policy",
          atMs: BASE + 304,
        })).rejects.toThrow("injected evaluation job insert failure");
        await direct.query("DROP TRIGGER test_fail_evaluation_job_insert");
        const [rows] = await direct.query<Row[]>(
          `SELECT r.status, r.claim_token, r.attempts,
                  (SELECT COUNT(*) FROM erasure_audit_events a WHERE a.request_id=r.request_id) audit_count,
                  (SELECT COUNT(*) FROM erasure_policy_evaluation_jobs j
                    WHERE j.request_id=r.request_id) job_count
             FROM erasure_requests r WHERE r.request_id=?`,
          [requestId],
        );
        expect(rows[0]).toMatchObject({
          status: "reconciling_usage",
          claim_token: claim.claimToken,
          attempts: claim.attempts,
          audit_count: 4,
          job_count: 0,
        });
      } finally {
        await direct.query("DROP TRIGGER IF EXISTS test_fail_evaluation_job_insert").catch(() => {});
        await direct.end();
        await store.close();
      }
    });

    it("builds live-root evidence, requeues waiting at deadline, and never reports completion", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const tenantId = `tenant_eval_wait_${randomUUID()}`;
      const userId = `user_${randomUUID()}`;
      try {
        const { session } = await tombstoneAndReconcile(store, tenantId, userId);
        const input = await awaitingRequest(store, {
          tenantId,
          userId,
          policy: policy({ userErasureGraceMs: 100 }),
          requestAtMs: BASE + 300,
        });
        let claimed = await claimEvaluation(store, BASE + 304, input.requestId);
        expect(await store.buildErasurePurgeTargetPage(claimed.authorization, {
          nowMs: BASE + 305,
          limit: 10,
        })).toMatchObject({ built: 1, done: true, targetCount: 1 });
        expect((await store.listErasurePurgeTargetEvidence(input.requestId, 1))[0]).toMatchObject({
          sessionId: session.id,
          sessionContentDeadlineMs: BASE + 100,
          operationalUsageDeadlineMs: BASE + 200,
          issueCodes: [],
        });
        expect((await store.sealErasurePurgeAuthority(claimed.authorization, {
          nowMs: BASE + 305,
        })).decision).toMatchObject({ decision: "waiting", eligibilityDeadlineMs: BASE + 400 });
        expect(await store.scheduleAwaitingErasurePolicyEvaluations({
          nowMs: BASE + 399,
          limit: 10,
        })).toBe(0);
        expect(await store.scheduleAwaitingErasurePolicyEvaluations({
          nowMs: BASE + 400,
          limit: 10,
        })).toBe(1);
        claimed = await claimEvaluation(store, BASE + 400, input.requestId);
        await store.buildErasurePurgeTargetPage(claimed.authorization, {
          nowMs: BASE + 400,
          limit: 10,
        });
        const sealed = await store.sealErasurePurgeAuthority(claimed.authorization, {
          nowMs: BASE + 400,
        });
        expect(sealed.authority).toMatchObject({ authorityGeneration: 1, targetCount: 1 });
        expect(await store.getValidatedErasurePurgeAuthority(input.requestId)).toEqual(sealed.authority);
        expect(await store.getErasureCompletionReadiness(input.requestId)).toMatchObject({
          complete: false,
          missing: expect.arrayContaining(["purge_execution_disabled", "restore_ledger_ack"]),
        });
      } finally {
        await store.close();
      }
    });

    it("clamps sealed decision and authority timestamps to a future-skewed policy record", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const tenantId = `tenant_eval_policy_clock_${randomUUID()}`;
      const userId = `user_${randomUUID()}`;
      try {
        await tombstoneAndReconcile(store, tenantId, userId);
        const policyAtMs = BASE + 500;
        const input = await awaitingRequest(store, {
          tenantId,
          userId,
          policy: policy(),
          policyAtMs,
        });
        const claimed = await claimEvaluation(store, BASE + 304, input.requestId);
        await store.buildErasurePurgeTargetPage(claimed.authorization, {
          nowMs: BASE + 305,
          limit: 10,
        });
        const sealed = await store.sealErasurePurgeAuthority(claimed.authorization, {
          nowMs: BASE + 306,
        });
        expect(sealed.decision.decidedAtMs).toBe(policyAtMs);
        expect(sealed.authority?.createdAtMs).toBe(policyAtMs);
        expect(await store.getErasurePolicyEvaluationJob(input.requestId)).toMatchObject({
          sealedAtMs: policyAtMs,
          updatedAtMs: policyAtMs,
        });
      } finally {
        await store.close();
      }
    });

    it("rejects hash-consistent SQL authority rows with policy-inconsistent deadlines", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 2 });
      const direct = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant_eval_forged_${randomUUID()}`;
      const userId = `user_${randomUUID()}`;
      try {
        await tombstoneAndReconcile(store, tenantId, userId);
        const input = await awaitingRequest(store, { tenantId, userId, policy: policy() });
        const claimed = await claimEvaluation(store, BASE + 304, input.requestId);
        await store.buildErasurePurgeTargetPage(claimed.authorization, { nowMs: BASE + 305, limit: 10 });
        const sealed = await store.sealErasurePurgeAuthority(claimed.authorization, {
          nowMs: BASE + 306,
        });
        const decisionWithoutHash = { ...sealed.decision };
        delete (decisionWithoutHash as Partial<typeof decisionWithoutHash>).afterSha256;
        const forgedDecisionWithoutHash = {
          ...decisionWithoutHash,
          userGraceDeadlineMs: 0,
          eligibilityDeadlineMs: 0,
        };
        const forgedDecisionHash = erasurePolicyDecisionSha256(forgedDecisionWithoutHash);
        const authorityWithoutHash = { ...sealed.authority! };
        delete (authorityWithoutHash as Partial<typeof authorityWithoutHash>).authoritySha256;
        const forgedAuthorityWithoutHash = {
          ...authorityWithoutHash,
          userGraceDeadlineMs: 0,
          eligibilityDeadlineMs: 0,
          decisionSha256: forgedDecisionHash,
        };
        const forgedAuthorityHash = erasurePurgeAuthoritySha256(forgedAuthorityWithoutHash);
        for (const trigger of [
          "trg_erasure_policy_decisions_bu",
          "trg_erasure_policy_decisions_bu_guard_a",
          "trg_erasure_policy_decisions_bu_guard_b",
          "trg_erasure_purge_authorities_bu",
          "trg_erasure_purge_authorities_bu_guard_a",
          "trg_erasure_purge_authorities_bu_guard_b",
        ]) await direct.query(`DROP TRIGGER ${trigger}`);
        await direct.query(
          `UPDATE erasure_policy_evaluation_decisions
              SET user_grace_deadline_ms=0, eligibility_deadline_ms=0, after_sha256=?
            WHERE request_id=? AND decision_seq=1`,
          [forgedDecisionHash, input.requestId],
        );
        await direct.query(
          `UPDATE erasure_purge_authorities
              SET user_grace_deadline_ms=0, eligibility_deadline_ms=0,
                  decision_sha256=?, authority_sha256=?
            WHERE request_id=? AND authority_generation=1`,
          [forgedDecisionHash, forgedAuthorityHash, input.requestId],
        );
        await direct.query(
          `UPDATE erasure_purge_authority_controls SET active_authority_sha256=?
            WHERE request_id=?`,
          [forgedAuthorityHash, input.requestId],
        );
        await direct.query(
          "DELETE FROM schema_migrations WHERE name='0016_erasure_purge_policy_authority.sql'",
        );
        const repaired = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 1 });
        await repaired.close();
        await expect(store.getValidatedErasurePurgeAuthority(input.requestId))
          .rejects.toThrow("deadline chain is corrupt");
      } finally {
        await direct.query(
          "DELETE FROM schema_migrations WHERE name='0016_erasure_purge_policy_authority.sql'",
        ).catch(() => {});
        await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 1 })
          .then((repair) => repair.close())
          .catch(() => {});
        await direct.end();
        await store.close();
      }
    });

    it("invalidates hold ABA, rebuilds a new generation, and does not deadlock with anonymization", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const direct = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant_eval_aba_${randomUUID()}`;
      const userId = `user_${randomUUID()}`;
      try {
        const { reconciliation } = await tombstoneAndReconcile(store, tenantId, userId);
        const input = await awaitingRequest(store, { tenantId, userId, policy: policy() });
        let claimed = await claimEvaluation(store, BASE + 304, input.requestId);
        await store.buildErasurePurgeTargetPage(claimed.authorization, { nowMs: BASE + 305, limit: 10 });
        const first = await store.sealErasurePurgeAuthority(claimed.authorization, {
          nowMs: BASE + 305,
        });
        expect(first.authority?.authorityGeneration).toBe(1);
        await store.setLegalHold({
          tenantId,
          holdId: "hold_mysql_eval_aba",
          subjectKind: "user",
          subjectId: userId,
          reasonCode: "litigation",
          expectedControlGeneration: 0,
          actorKeyId: "legal-admin",
          atMs: BASE + 310,
        });
        expect(await store.getValidatedErasurePurgeAuthority(input.requestId)).toBeNull();
        await store.releaseLegalHold({
          tenantId,
          holdId: "hold_mysql_eval_aba",
          expectedControlGeneration: 1,
          reasonCode: "matter_closed",
          actorKeyId: "legal-admin",
          atMs: BASE + 320,
        });
        expect(await store.scheduleAwaitingErasurePolicyEvaluations({
          nowMs: BASE + 321,
          limit: 10,
        })).toBe(1);
        const [invalidatedRows] = await direct.query<Row[]>(
          `SELECT authority_generation, active_authority_sha256, updated_at_ms
             FROM erasure_purge_authority_controls WHERE request_id=?`,
          [input.requestId],
        );
        expect(invalidatedRows[0]).toMatchObject({
          authority_generation: 1,
          active_authority_sha256: null,
          updated_at_ms: BASE + 321,
        });
        expect(await store.getValidatedErasurePurgeAuthority(input.requestId)).toBeNull();
        claimed = await claimEvaluation(store, BASE + 321, input.requestId);
        await store.buildErasurePurgeTargetPage(claimed.authorization, { nowMs: BASE + 322, limit: 10 });
        const resealed = await store.sealErasurePurgeAuthority(claimed.authorization, {
          nowMs: BASE + 322,
        });
        expect(resealed.authority?.authorityGeneration).toBe(2);

        // Anonymization now follows tenant -> user -> session, matching evaluator inventory order.
        const results = await Promise.allSettled([
          store.getValidatedErasurePurgeAuthority(input.requestId),
          store.anonymizeSessionUsage({
            tenantId,
            userId,
            sessionId: (await store.listErasurePurgeTargetEvidence(input.requestId, 2))[0]!.sessionId,
            deletionGeneration: 1,
            expectedChecksum: reconciliation.checksum,
            nowMs: BASE + 330,
            enabled: true,
          }),
        ]);
        results.forEach(noDeadlock);
        expect(results[1]?.status).toBe("fulfilled");
        expect(await store.getValidatedErasurePurgeAuthority(input.requestId)).toBeNull();
      } finally {
        await direct.end();
        await store.close();
      }
    });

    it("serializes evaluator, hold and anonymize without a lock cycle", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const tenantId = `tenant_eval_concurrent_${randomUUID()}`;
      const userId = `user_${randomUUID()}`;
      try {
        const { session, reconciliation } = await tombstoneAndReconcile(store, tenantId, userId);
        const input = await awaitingRequest(store, { tenantId, userId, policy: policy() });
        const claimed = await claimEvaluation(store, BASE + 304, input.requestId);
        await store.buildErasurePurgeTargetPage(claimed.authorization, { nowMs: BASE + 305, limit: 10 });
        const results = await Promise.allSettled([
          store.sealErasurePurgeAuthority(claimed.authorization, { nowMs: BASE + 306 }),
          store.setLegalHold({
            tenantId,
            holdId: "hold_mysql_concurrent",
            subjectKind: "user",
            subjectId: userId,
            reasonCode: "regulatory",
            expectedControlGeneration: 0,
            actorKeyId: "legal-admin",
            atMs: BASE + 306,
          }),
          store.anonymizeSessionUsage({
            tenantId,
            userId,
            sessionId: session.id,
            deletionGeneration: 1,
            expectedChecksum: reconciliation.checksum,
            nowMs: BASE + 306,
            enabled: true,
          }),
        ]);
        results.forEach(noDeadlock);
        expect(results[1]?.status).toBe("fulfilled");
        expect(await store.getValidatedErasurePurgeAuthority(input.requestId)).toBeNull();
      } finally {
        await store.close();
      }
    });

    it("rebuilds new generations when live usage and receipt evidence drifts", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const direct = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant_eval_drift_${randomUUID()}`;
      const userId = `user_${randomUUID()}`;
      try {
        const { session, reconciliation } = await tombstoneAndReconcile(store, tenantId, userId);
        const input = await awaitingRequest(store, { tenantId, userId, policy: policy() });
        let claimed = await claimEvaluation(store, BASE + 304, input.requestId);
        await store.buildErasurePurgeTargetPage(claimed.authorization, { nowMs: BASE + 305, limit: 10 });
        await store.anonymizeSessionUsage({
          tenantId,
          userId,
          sessionId: session.id,
          deletionGeneration: 1,
          expectedChecksum: reconciliation.checksum,
          nowMs: BASE + 306,
          enabled: true,
        });
        await expect(store.sealErasurePurgeAuthority(claimed.authorization, {
          nowMs: BASE + 307,
        })).rejects.toBeInstanceOf(ErasurePurgeEvidenceChangedError);
        expect(await store.retryErasurePolicyEvaluation(claimed.authorization, {
          failedAtMs: BASE + 307,
          availableAtMs: BASE + 308,
          errorCode: "evidence_changed",
        })).toBe(true);
        claimed = await claimEvaluation(store, BASE + 308, input.requestId);
        expect(claimed.claim.buildGeneration).toBe(2);
        await store.buildErasurePurgeTargetPage(claimed.authorization, { nowMs: BASE + 309, limit: 10 });
        const first = await store.sealErasurePurgeAuthority(claimed.authorization, {
          nowMs: BASE + 310,
        });
        expect(first.authority).toMatchObject({ authorityGeneration: 1, buildGeneration: 2 });

        await direct.query(
          `INSERT INTO idempotency_keys
             (tenant_id, user_id, session_id, idem_key, request_hash, value, expires_at_ms)
           VALUES (?,?,?,?,NULL,NULL,?)`,
          [tenantId, userId, session.id, "late-receipt", BASE + 312],
        );
        expect(await store.getValidatedErasurePurgeAuthority(input.requestId)).toBeNull();
        expect(await store.scheduleAwaitingErasurePolicyEvaluations({
          nowMs: BASE + 311,
          limit: 100,
        })).toBeGreaterThanOrEqual(1);
        const [controlRows] = await direct.query<Row[]>(
          `SELECT authority_generation, active_authority_sha256
             FROM erasure_purge_authority_controls WHERE request_id=?`,
          [input.requestId],
        );
        expect(controlRows[0]).toMatchObject({
          authority_generation: 1,
          active_authority_sha256: null,
        });
        claimed = await claimEvaluation(store, BASE + 311, input.requestId);
        expect(claimed.claim.buildGeneration).toBe(3);
        await store.buildErasurePurgeTargetPage(claimed.authorization, { nowMs: BASE + 312, limit: 10 });
        const resealed = await store.sealErasurePurgeAuthority(claimed.authorization, {
          nowMs: BASE + 313,
        });
        expect(resealed.authority).toMatchObject({ authorityGeneration: 2, buildGeneration: 3 });
      } finally {
        await direct.end();
        await store.close();
      }
    });

    it("fails closed on foreign receipts and malformed ready blob manifests", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const direct = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant_eval_owner_${randomUUID()}`;
      const userId = `user_${randomUUID()}`;
      try {
        const { session } = await tombstoneAndReconcile(store, tenantId, userId);
        const malformedBlobId = newId("blob");
        const foreignBlobId = newId("blob");
        await direct.query(
          `INSERT INTO blob_objects
             (blob_id, tenant_id, user_id, session_id, item_id, purpose, storage_backend,
              storage_format, storage_key, upload_token, state, sha256, size_bytes,
              uploaded_at_ms, ready_at_ms, deletion_generation, created_at_ms)
           VALUES (?,?,?,?,NULL,'tool_output','mysql-v1',?,?,?,'ready',NULL,1,?,?,0,?),
                  (?,?,?,?,?,'tool_output','mysql-v1',?,?,?,'ready',UNHEX(?),1,?,?,0,?)`,
          [
            malformedBlobId,
            tenantId,
            userId,
            session.id,
            BLOB_STORAGE_FORMAT,
            `objects/${malformedBlobId.slice(5)}`,
            `upload-${malformedBlobId.slice(5)}`,
            BASE + 10,
            BASE + 20,
            BASE,
            foreignBlobId,
            "foreign-tenant",
            "foreign-user",
            session.id,
            newId("item"),
            BLOB_STORAGE_FORMAT,
            `objects/${foreignBlobId.slice(5)}`,
            `upload-${foreignBlobId.slice(5)}`,
            "a".repeat(64),
            BASE + 10,
            BASE + 20,
            BASE,
          ],
        );
        await direct.query(
          `INSERT INTO idempotency_keys
             (tenant_id, user_id, session_id, idem_key, request_hash, value, expires_at_ms)
           VALUES ('foreign-tenant','foreign-user',?,'foreign-receipt',NULL,NULL,?)`,
          [session.id, BASE + 900],
        );
        const input = await awaitingRequest(store, { tenantId, userId, policy: policy() });
        const claimed = await claimEvaluation(store, BASE + 304, input.requestId);
        await store.buildErasurePurgeTargetPage(claimed.authorization, { nowMs: BASE + 305, limit: 10 });
        expect((await store.listErasurePurgeTargetEvidence(input.requestId, 1))[0]).toMatchObject({
          readyBlobCount: 1,
          idempotencyReceiptCount: 0,
          issueCodes: expect.arrayContaining(["blob_invalid", "receipt_invalid"]),
        });
        const sealed = await store.sealErasurePurgeAuthority(claimed.authorization, {
          nowMs: BASE + 306,
        });
        expect(sealed.decision.decision).toBe("invalid");
        expect(sealed.authority).toBeUndefined();
      } finally {
        await direct.end();
        await store.close();
      }
    });

    it("does not copy foreign reconciliation timestamps or checksums into target evidence", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const direct = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant_eval_reconciliation_owner_${randomUUID()}`;
      const userId = `user_${randomUUID()}`;
      try {
        const { session } = await tombstoneAndReconcile(store, tenantId, userId);
        const foreignVerifiedAtMs = BASE + 900;
        const foreignChecksum = "f".repeat(64);
        await direct.query(
          `UPDATE usage_reconciliations
              SET tenant_id='foreign-tenant', user_id='foreign-user',
                  verified_at_ms=?, checksum=?
            WHERE session_id=? AND deletion_generation=1`,
          [foreignVerifiedAtMs, foreignChecksum, session.id],
        );
        const input = await awaitingRequest(store, { tenantId, userId, policy: policy() });
        const claimed = await claimEvaluation(store, BASE + 304, input.requestId);
        await store.buildErasurePurgeTargetPage(claimed.authorization, {
          nowMs: BASE + 305,
          limit: 10,
        });
        expect((await store.listErasurePurgeTargetEvidence(input.requestId, 1))[0]).toMatchObject({
          operationalUsageStatus: "missing_or_invalid",
          operationalUsageVerifiedAtMs: BASE + 100,
          operationalUsageChecksum: "0".repeat(64),
          operationalUsageDeadlineMs: BASE + 100,
          issueCodes: expect.arrayContaining(["usage_reconciliation_invalid"]),
        });
      } finally {
        await direct.end();
        await store.close();
      }
    });

    it("re-evaluates invalid staging evidence after the orphan delete is acknowledged", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const tenantId = `tenant_eval_staging_${randomUUID()}`;
      const userId = `user_${randomUUID()}`;
      try {
        const { blobId } = await tombstoneAndReconcile(
          store,
          tenantId,
          userId,
          { stageExpiredBlob: true },
        );
        const input = await awaitingRequest(store, { tenantId, userId, policy: policy() });
        let claimed = await claimEvaluation(store, BASE + 304, input.requestId);
        await store.buildErasurePurgeTargetPage(claimed.authorization, { nowMs: BASE + 305, limit: 10 });
        expect((await store.sealErasurePurgeAuthority(claimed.authorization, {
          nowMs: BASE + 305,
        })).decision.decision).toBe("invalid");
        expect(await store.scheduleAwaitingErasurePolicyEvaluations({
          nowMs: BASE + 306,
          limit: 100,
        })).toBe(0);
        expect(await store.scheduleStaleBlobDeletes({ nowMs: BASE + 306, limit: 10 })).toBe(1);
        const [deleteClaim] = await store.claimBlobDeletes({
          nowMs: BASE + 306,
          limit: 10,
          leaseMs: 100,
          claimToken: "blob-delete-worker-0001",
        });
        expect(deleteClaim?.blobId).toBe(blobId);
        expect(await store.completeBlobDelete(
          deleteClaim!.outboxId,
          deleteClaim!.claimToken!,
          BASE + 307,
        )).toBe(true);
        expect(await store.scheduleAwaitingErasurePolicyEvaluations({
          nowMs: BASE + 308,
          limit: 100,
        })).toBe(1);
        claimed = await claimEvaluation(store, BASE + 308, input.requestId);
        expect(claimed.claim.buildGeneration).toBe(2);
        await store.buildErasurePurgeTargetPage(claimed.authorization, { nowMs: BASE + 309, limit: 10 });
        expect((await store.sealErasurePurgeAuthority(claimed.authorization, {
          nowMs: BASE + 310,
        })).authority).toMatchObject({ buildGeneration: 2 });
      } finally {
        await store.close();
      }
    });

    it("isolates poisoned scheduler and claim rows without starving healthy work", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const direct = await mysql.createConnection(mysqlUrl);
      const requestIds: string[] = [];
      try {
        for (const suffix of ["a", "b"]) {
          const tenantId = `tenant_eval_poison_${suffix}_${randomUUID()}`;
          const userId = `user_${randomUUID()}`;
          await tombstoneAndReconcile(store, tenantId, userId);
          const input = await awaitingRequest(store, {
            tenantId,
            userId,
            policy: policy({ userErasureGraceMs: 100 }),
          });
          requestIds.push(input.requestId);
          const claimed = await claimEvaluation(store, BASE + 304, input.requestId);
          await store.buildErasurePurgeTargetPage(claimed.authorization, {
            nowMs: BASE + 305,
            limit: 10,
          });
          expect((await store.sealErasurePurgeAuthority(claimed.authorization, {
            nowMs: BASE + 305,
          })).decision.decision).toBe("waiting");
        }
        const [poisonRequestId, healthyRequestId] = [...requestIds].sort() as [string, string];
        await direct.query(
          "UPDATE erasure_policy_evaluation_jobs SET target_root_sha256='not-a-sha256' WHERE request_id=?",
          [poisonRequestId],
        );
        await expect(store.scheduleAwaitingErasurePolicyEvaluations({
          nowMs: BASE + 400,
          limit: 100,
        })).rejects.toThrow("stored erasure policy evaluation job is invalid");
        expect(await store.getErasurePolicyEvaluationJob(healthyRequestId)).toMatchObject({
          buildGeneration: 2,
        });
        await direct.query(
          "UPDATE erasure_policy_evaluation_jobs SET available_at_ms=1, updated_at_ms=GREATEST(updated_at_ms,1) WHERE request_id=?",
          [healthyRequestId],
        );

        const thirdTenant = `tenant_eval_claim_poison_${randomUUID()}`;
        const thirdUser = `user_${randomUUID()}`;
        await tombstoneAndReconcile(store, thirdTenant, thirdUser);
        const third = await awaitingRequest(store, {
          tenantId: thirdTenant,
          userId: thirdUser,
          policy: policy(),
        });
        await direct.query(
          `UPDATE erasure_policy_evaluation_jobs
              SET target_root_sha256='not-a-sha256', available_at_ms=0
            WHERE request_id=?`,
          [third.requestId],
        );
        const [healthyClaim] = await store.claimErasurePolicyEvaluations({
          nowMs: BASE + 400,
          limit: 1,
          leaseMs: 100,
          claimToken: "evaluation-healthy-after-poison",
        });
        expect(healthyClaim?.requestId).toBe(healthyRequestId);
      } finally {
        await direct.end();
        await store.close();
      }
    });

    it("rolls back a failed seal and treats zero-session null destructive durations as unconfigured", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const rollbackTenant = `tenant_eval_rollback_${randomUUID()}`;
      const rollbackUser = `user_${randomUUID()}`;
      const direct = await mysql.createConnection(mysqlUrl);
      try {
        await tombstoneAndReconcile(store, rollbackTenant, rollbackUser);
        const input = await awaitingRequest(store, {
          tenantId: rollbackTenant,
          userId: rollbackUser,
          policy: policy(),
        });
        const claimed = await claimEvaluation(store, BASE + 304, input.requestId);
        await store.buildErasurePurgeTargetPage(claimed.authorization, { nowMs: BASE + 305, limit: 10 });
        await direct.query("DROP TRIGGER IF EXISTS test_fail_policy_decision_insert");
        await direct.query(
          `CREATE TRIGGER test_fail_policy_decision_insert
             BEFORE INSERT ON erasure_policy_evaluation_decisions
             FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected decision insert failure'`,
        );
        await expect(store.sealErasurePurgeAuthority(claimed.authorization, {
          nowMs: BASE + 306,
        })).rejects.toThrow("injected decision insert failure");
        await direct.query("DROP TRIGGER test_fail_policy_decision_insert");
        const [counts] = await direct.query<Row[]>(
          `SELECT
             (SELECT COUNT(*) FROM erasure_policy_evaluation_decisions WHERE request_id=?) decisions,
             (SELECT COUNT(*) FROM erasure_purge_authority_controls WHERE request_id=?) controls,
             (SELECT COUNT(*) FROM erasure_purge_authorities WHERE request_id=?) authorities`,
          [input.requestId, input.requestId, input.requestId],
        );
        expect(counts[0]).toMatchObject({ decisions: 0, controls: 0, authorities: 0 });
        expect(await store.getErasurePolicyEvaluationJob(input.requestId)).not.toHaveProperty("sealedAtMs");

        const missingTenant = `tenant_eval_missing_${randomUUID()}`;
        const missingUser = `user_${randomUUID()}`;
        const { session: missingSession } = await tombstoneAndReconcile(
          store,
          missingTenant,
          missingUser,
        );
        await direct.query(
          "DELETE FROM usage_reconciliations WHERE session_id=? AND deletion_generation=1",
          [missingSession.id],
        );
        const missingInput = await awaitingRequest(store, {
          tenantId: missingTenant,
          userId: missingUser,
          policy: policy(),
        });
        const missingClaim = await claimEvaluation(store, BASE + 304, missingInput.requestId);
        await store.buildErasurePurgeTargetPage(missingClaim.authorization, {
          nowMs: BASE + 305,
          limit: 10,
        });
        expect((await store.listErasurePurgeTargetEvidence(missingInput.requestId, 1))[0])
          .toMatchObject({
            operationalUsageStatus: "missing_or_invalid",
            issueCodes: expect.arrayContaining(["usage_reconciliation_invalid"]),
          });
        expect((await store.sealErasurePurgeAuthority(missingClaim.authorization, {
          nowMs: BASE + 306,
        })).decision.decision).toBe("invalid");

        const emptyTenant = `tenant_eval_empty_${randomUUID()}`;
        const emptyUser = `user_${randomUUID()}`;
        const emptyInput = await awaitingRequest(store, {
          tenantId: emptyTenant,
          userId: emptyUser,
          policy: policy({
            sessionContentRetentionMs: null,
            operationalUsageRetentionMs: null,
            idempotencyReceiptRetentionMs: null,
          }),
        });
        const emptyClaim = await claimEvaluation(store, BASE + 304, emptyInput.requestId);
        expect(await store.buildErasurePurgeTargetPage(emptyClaim.authorization, {
          nowMs: BASE + 305,
          limit: 10,
        })).toMatchObject({ built: 0, done: true, targetCount: 0 });
        expect((await store.sealErasurePurgeAuthority(emptyClaim.authorization, {
          nowMs: BASE + 306,
        })).decision.decision).toBe("unconfigured");
      } finally {
        await direct.query("DROP TRIGGER IF EXISTS test_fail_policy_decision_insert").catch(() => {});
        await direct.end();
        await store.close();
      }
    });
  });
}
