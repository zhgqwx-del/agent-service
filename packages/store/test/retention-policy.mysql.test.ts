import { randomUUID } from "node:crypto";
import { emptyUsage } from "@agent-service/protocol";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LegalHoldGenerationConflictError,
  LegalHoldIntegrityError,
  MysqlSessionStore,
  RetentionPolicyGenerationConflictError,
  RetentionPolicyVersionConflictError,
  UsageLegalHoldError,
  newErasureRequestId,
  newLegalHoldId,
  newUsageId,
  userErasureRequestHash,
  type RetentionPolicyDocumentV1,
} from "../src/index.js";
import { mkSession, newId } from "./conformance.js";

const BASE_MYSQL_URL = process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";

function assertDisposableTestTarget(rawUrl: string): URL {
  const url = new URL(rawUrl);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) {
    throw new Error(
      `refusing to create retention fixture database from base database "${database}": `
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

function policy(seed = 0): RetentionPolicyDocumentV1 {
  return {
    sessionContentRetentionMs: 10_000 + seed,
    userErasureGraceMs: 20_000 + seed,
    operationalUsageRetentionMs: 30_000 + seed,
    idempotencyReceiptRetentionMs: 40_000 + seed,
    billingFactRetentionMs: null,
    lifecycleAuditRetentionMs: null,
    exportArtifactTtlMs: 50_000 + seed,
  };
}

function requestInput(tenantId: string, userId: string, key: string, atMs: number) {
  return {
    requestId: newErasureRequestId(),
    tenantId,
    userId,
    requestedByKeyId: "retention-test",
    idempotencyKey: key,
    requestHash: userErasureRequestHash(tenantId, userId),
    atMs,
  };
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore retention policy and legal hold", () => {
    let admin: Connection | undefined;
    let mysqlUrl = "";
    let database = "";

    beforeAll(async () => {
      const base = assertDisposableTestTarget(BASE_MYSQL_URL);
      database = `agent_service_retention_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
      if (!/^agent_service_retention_test_[a-zA-Z0-9_]+$/.test(database)) {
        throw new Error("unsafe generated retention fixture database name");
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

    it("keeps policy versions immutable and linearizes concurrent activation CAS without ABA replay", async () => {
      const first = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const second = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const tenantId = `tenant_policy_${randomUUID()}`;
      const baseAtMs = Date.now() + 10_000;
      try {
        const one = await first.putRetentionPolicy({
          tenantId,
          policyVersion: "policy-1",
          policy: policy(1),
          actorKeyId: "writer-a",
          atMs: baseAtMs,
        });
        expect(await second.putRetentionPolicy({
          tenantId,
          policyVersion: "policy-1",
          policy: policy(1),
          actorKeyId: "retry-on-other-runner",
          atMs: baseAtMs + 1,
        })).toEqual(one);
        await expect(first.putRetentionPolicy({
          tenantId,
          policyVersion: "policy-1",
          policy: policy(99),
          actorKeyId: "writer-a",
          atMs: baseAtMs + 2,
        })).rejects.toBeInstanceOf(RetentionPolicyVersionConflictError);
        expect(await first.getRetentionPolicy(`${tenantId}_other`, "policy-1")).toBeNull();

        await first.putRetentionPolicy({
          tenantId,
          policyVersion: "policy-2",
          policy: policy(2),
          actorKeyId: "writer-a",
          atMs: baseAtMs + 3,
        });
        const candidates = [
          {
            tenantId,
            policyVersion: "policy-1",
            expectedControlGeneration: 0,
            actorKeyId: "activator-a",
            atMs: baseAtMs + 10,
          },
          {
            tenantId,
            policyVersion: "policy-2",
            expectedControlGeneration: 0,
            actorKeyId: "activator-b",
            atMs: baseAtMs + 11,
          },
        ] as const;
        const raced = await Promise.allSettled([
          first.activateRetentionPolicy(candidates[0]),
          second.activateRetentionPolicy(candidates[1]),
        ]);
        expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(raced.filter((result) => result.status === "rejected")[0]).toMatchObject({
          reason: expect.any(RetentionPolicyGenerationConflictError),
        });
        const winnerIndex = raced.findIndex((result) => result.status === "fulfilled");
        const winner = candidates[winnerIndex]!;
        const loser = candidates[1 - winnerIndex]!;
        const active = await first.getActiveRetentionPolicy(tenantId);
        expect(active).toMatchObject({
          control: { controlGeneration: 1, activePolicyVersion: winner.policyVersion },
          policy: { policyVersion: winner.policyVersion },
        });
        expect(await second.activateRetentionPolicy({
          ...winner,
          actorKeyId: "transport-retry",
          atMs: winner.atMs + 500,
        })).toEqual(active?.control);

        await first.activateRetentionPolicy({
          tenantId,
          policyVersion: loser.policyVersion,
          expectedControlGeneration: 1,
          actorKeyId: "activator-c",
          atMs: baseAtMs + 20,
        });
        await first.activateRetentionPolicy({
          tenantId,
          policyVersion: winner.policyVersion,
          expectedControlGeneration: 2,
          actorKeyId: "activator-d",
          atMs: baseAtMs + 30,
        });
        await expect(second.activateRetentionPolicy(winner))
          .rejects.toBeInstanceOf(RetentionPolicyGenerationConflictError);
        expect(await first.listRetentionPolicyActivationEvents(tenantId)).toHaveLength(3);
      } finally {
        await second.close();
        await first.close();
      }
    });

    it("clamps policy and legal-hold audit time across runners with skewed clocks", async () => {
      const first = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const second = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const tenantId = `tenant_clock_skew_${randomUUID()}`;
      const userId = `user_${randomUUID()}`;
      const baseAtMs = Date.now() + 15_000;
      const firstHoldId = newLegalHoldId();
      try {
        await first.putRetentionPolicy({
          tenantId,
          policyVersion: "policy-1",
          policy: policy(10),
          actorKeyId: "writer-a",
          atMs: baseAtMs,
        });
        await first.putRetentionPolicy({
          tenantId,
          policyVersion: "policy-2",
          policy: policy(11),
          actorKeyId: "writer-a",
          atMs: baseAtMs + 1,
        });
        await first.activateRetentionPolicy({
          tenantId,
          policyVersion: "policy-1",
          expectedControlGeneration: 0,
          actorKeyId: "runner-a",
          atMs: baseAtMs + 100,
        });
        const clockBehindPolicy = await second.activateRetentionPolicy({
          tenantId,
          policyVersion: "policy-2",
          expectedControlGeneration: 1,
          actorKeyId: "runner-b",
          atMs: baseAtMs + 50,
        });
        expect(clockBehindPolicy).toMatchObject({
          controlGeneration: 2,
          effectiveAtMs: baseAtMs + 100,
          updatedAtMs: baseAtMs + 100,
        });
        expect((await first.listRetentionPolicyActivationEvents(tenantId)).map((event) => ({
          generation: event.controlGeneration,
          effectiveAtMs: event.effectiveAtMs,
          emittedAtMs: event.emittedAtMs,
        }))).toEqual([
          { generation: 1, effectiveAtMs: baseAtMs + 100, emittedAtMs: baseAtMs + 100 },
          { generation: 2, effectiveAtMs: baseAtMs + 100, emittedAtMs: baseAtMs + 100 },
        ]);

        const firstHold = await first.setLegalHold({
          tenantId,
          holdId: firstHoldId,
          subjectKind: "user",
          subjectId: userId,
          reasonCode: "litigation",
          expectedControlGeneration: 0,
          actorKeyId: "runner-a",
          atMs: baseAtMs + 200,
        });
        const clockBehindHold = await second.setLegalHold({
          tenantId,
          holdId: newLegalHoldId(),
          subjectKind: "user",
          subjectId: userId,
          reasonCode: "regulatory",
          expectedControlGeneration: 1,
          actorKeyId: "runner-b",
          atMs: baseAtMs + 150,
        });
        const clockBehindRelease = await first.releaseLegalHold({
          tenantId,
          holdId: firstHold.holdId,
          expectedControlGeneration: 2,
          reasonCode: "matter_closed",
          actorKeyId: "runner-c",
          atMs: baseAtMs + 140,
        });
        expect(firstHold.createdAtMs).toBe(baseAtMs + 200);
        expect(clockBehindHold.createdAtMs).toBe(baseAtMs + 200);
        expect(clockBehindRelease.releasedAtMs).toBe(baseAtMs + 200);
        expect(await second.getLegalHoldControl(tenantId, "user", userId)).toMatchObject({
          controlGeneration: 3,
          updatedAtMs: baseAtMs + 200,
        });
        expect((await second.listLegalHoldEvents(tenantId, "user", userId)).map((event) => ({
          generation: event.controlGeneration,
          emittedAtMs: event.emittedAtMs,
        }))).toEqual([
          { generation: 1, emittedAtMs: baseAtMs + 200 },
          { generation: 2, emittedAtMs: baseAtMs + 200 },
          { generation: 3, emittedAtMs: baseAtMs + 200 },
        ]);
      } finally {
        await second.close();
        await first.close();
      }
    });

    it("rolls back policy control when activation audit publication fails", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant_policy_rollback_${randomUUID()}`;
      const atMs = Date.now() + 20_000;
      const trigger = `fail_policy_audit_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      try {
        await store.putRetentionPolicy({
          tenantId,
          policyVersion: "rollback-v1",
          policy: policy(3),
          actorKeyId: "writer",
          atMs,
        });
        await conn.query(
          `CREATE TRIGGER \`${trigger}\` BEFORE INSERT ON retention_policy_activation_events
           FOR EACH ROW BEGIN
             IF NEW.tenant_id = ? THEN
               SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected policy audit failure';
             END IF;
           END`,
          [tenantId],
        );
        await expect(store.activateRetentionPolicy({
          tenantId,
          policyVersion: "rollback-v1",
          expectedControlGeneration: 0,
          actorKeyId: "activator",
          atMs: atMs + 1,
        })).rejects.toThrow("injected policy audit failure");
        expect(await store.getActiveRetentionPolicy(tenantId)).toBeNull();
        expect(await store.listRetentionPolicyActivationEvents(tenantId)).toEqual([]);
        const [rows] = await conn.query<(RowDataPacket & { control_generation: number })[]>(
          "SELECT control_generation FROM retention_policy_controls WHERE tenant_id=?",
          [tenantId],
        );
        expect(Number(rows[0]?.control_generation)).toBe(0);
      } finally {
        await conn.query(`DROP TRIGGER IF EXISTS \`${trigger}\``).catch(() => {});
        await conn.end();
        await store.close();
      }
    });

    it("binds the policy observed at admission despite runner clock skew and preserves backlog", async () => {
      const first = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const second = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const tenantId = `tenant_policy_request_${randomUUID()}`;
      const baseAtMs = Date.now() + 30_000;
      const before = mkSession(tenantId, `user_${randomUUID()}`);
      const raced = mkSession(tenantId, `user_${randomUUID()}`);
      const clockBehind = mkSession(tenantId, `user_${randomUUID()}`);
      const clockAhead = mkSession(tenantId, `user_${randomUUID()}`);
      try {
        await first.createSession(before);
        await first.createSession(raced);
        await first.createSession(clockBehind);
        await first.createSession(clockAhead);
        const backlogInput = requestInput(tenantId, before.userId, "before-policy", baseAtMs + 1);
        const backlog = await first.requestUserErasure(backlogInput);
        expect(backlog).not.toHaveProperty("policyVersion");

        const version = await first.putRetentionPolicy({
          tenantId,
          policyVersion: "request-v1",
          policy: policy(4),
          actorKeyId: "writer",
          atMs: baseAtMs + 2,
        });
        const activation = {
          tenantId,
          policyVersion: version.policyVersion,
          expectedControlGeneration: 0,
          actorKeyId: "activator",
          atMs: baseAtMs + 3,
        } as const;
        const request = requestInput(tenantId, raced.userId, "activation-race", baseAtMs + 4);
        const [activationResult, requestResult] = await Promise.allSettled([
          first.activateRetentionPolicy(activation),
          second.requestUserErasure(request),
        ]);
        expect(activationResult.status).toBe("fulfilled");
        expect(requestResult.status).toBe("fulfilled");
        if (requestResult.status !== "fulfilled") throw requestResult.reason;
        const bound = requestResult.value;
        expect(
          bound.policyVersion === undefined
          || (bound.policyVersion === version.policyVersion && bound.policyHash === version.policySha256),
        ).toBe(true);
        const audits = await first.listErasureAuditEvents(bound.requestId);
        expect(audits).toHaveLength(1);
        expect(audits[0]?.payload).toEqual({
          status: "gated",
          subjectKind: "user",
          generation: 1,
          ...(bound.policyVersion === undefined
            ? {}
            : { policyVersion: bound.policyVersion, policyHash: bound.policyHash }),
        });

        const clockBehindResult = await first.requestUserErasure(requestInput(
          tenantId,
          clockBehind.userId,
          "clock-behind-request",
          activation.atMs - 1,
        ));
        expect(clockBehindResult).toMatchObject({
          policyVersion: version.policyVersion,
          policyHash: version.policySha256,
        });
        const clockAheadResult = await first.requestUserErasure(requestInput(
          tenantId,
          clockAhead.userId,
          "clock-ahead-request",
          activation.atMs + 1,
        ));
        expect(clockAheadResult).toMatchObject({
          policyVersion: version.policyVersion,
          policyHash: version.policySha256,
        });

        expect(await second.requestUserErasure({
          ...backlogInput,
          requestId: newErasureRequestId(),
          atMs: baseAtMs + 50,
        })).toEqual(backlog);
      } finally {
        await second.close();
        await first.close();
      }
    });

    it("supports multiple legal holds, lost-response replay, CAS isolation, and monotonic shadow", async () => {
      const first = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const second = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant_hold_${randomUUID()}`;
      const userId = `user_${randomUUID()}`;
      const firstHoldId = newLegalHoldId();
      const baseAtMs = Date.now() + 40_000;
      try {
        const firstHold = await first.setLegalHold({
          tenantId,
          holdId: firstHoldId,
          subjectKind: "user",
          subjectId: userId,
          reasonCode: "litigation",
          expectedControlGeneration: 0,
          actorKeyId: "hold-admin-a",
          atMs: baseAtMs,
        });
        expect(await second.setLegalHold({
          tenantId,
          holdId: firstHoldId,
          subjectKind: "user",
          subjectId: userId,
          reasonCode: "litigation",
          expectedControlGeneration: 0,
          actorKeyId: "retry-on-other-runner",
          atMs: baseAtMs + 100,
        })).toEqual(firstHold);
        await first.createSession(mkSession(tenantId, userId));

        const candidates = [
          {
            tenantId,
            holdId: newLegalHoldId(),
            subjectKind: "user" as const,
            subjectId: userId,
            reasonCode: "regulatory" as const,
            expectedControlGeneration: 1,
            actorKeyId: "hold-admin-b",
            atMs: baseAtMs + 10,
          },
          {
            tenantId,
            holdId: newLegalHoldId(),
            subjectKind: "user" as const,
            subjectId: userId,
            reasonCode: "security_incident" as const,
            expectedControlGeneration: 1,
            actorKeyId: "hold-admin-c",
            atMs: baseAtMs + 11,
          },
        ];
        const raced = await Promise.allSettled([
          first.setLegalHold(candidates[0]!),
          second.setLegalHold(candidates[1]!),
        ]);
        expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(raced.filter((result) => result.status === "rejected")[0]).toMatchObject({
          reason: expect.any(LegalHoldGenerationConflictError),
        });
        const winnerIndex = raced.findIndex((result) => result.status === "fulfilled");
        const secondHold = candidates[winnerIndex]!;
        const state = await first.getActiveLegalHoldState(tenantId, "user", userId);
        expect(state.control).toMatchObject({ controlGeneration: 2, activeHoldCount: 2 });
        expect(state.holds.map((hold) => hold.holdId).sort()).toEqual(
          [firstHoldId, secondHold.holdId].sort(),
        );
        const [shadowRows] = await conn.query<(RowDataPacket & { legal_hold_at_ms: number })[]>(
          `SELECT legal_hold_at_ms FROM subject_lifecycle
            WHERE tenant_id=? AND subject_kind='user' AND subject_id=?`,
          [tenantId, userId],
        );
        expect(Number(shadowRows[0]?.legal_hold_at_ms)).toBe(baseAtMs);

        const released = await first.releaseLegalHold({
          tenantId,
          holdId: firstHoldId,
          expectedControlGeneration: 2,
          reasonCode: "matter_closed",
          actorKeyId: "hold-admin-a",
          atMs: baseAtMs + 20,
        });
        expect(await second.releaseLegalHold({
          tenantId,
          holdId: firstHoldId,
          expectedControlGeneration: 2,
          reasonCode: "matter_closed",
          actorKeyId: "transport-retry",
          atMs: baseAtMs + 200,
        })).toEqual(released);
        expect(await first.getLegalHoldControl(tenantId, "user", userId)).toMatchObject({
          controlGeneration: 3,
          activeHoldCount: 1,
        });
        const [afterRelease] = await conn.query<(RowDataPacket & { legal_hold_at_ms: number })[]>(
          `SELECT legal_hold_at_ms FROM subject_lifecycle
            WHERE tenant_id=? AND subject_kind='user' AND subject_id=?`,
          [tenantId, userId],
        );
        expect(Number(afterRelease[0]?.legal_hold_at_ms)).toBe(secondHold.atMs);
        await expect(first.setLegalHold({
          ...candidates[1 - winnerIndex]!,
          holdId: newLegalHoldId(),
        })).rejects.toBeInstanceOf(LegalHoldGenerationConflictError);
        expect(await first.getLegalHold(`${tenantId}_other`, firstHoldId)).toBeNull();
      } finally {
        await conn.end();
        await second.close();
        await first.close();
      }
    });

    it("rolls back a hold when audit publication fails and rejects an unproven shadow", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant_hold_rollback_${randomUUID()}`;
      const userId = `user_${randomUUID()}`;
      const holdId = newLegalHoldId();
      const atMs = Date.now() + 50_000;
      const trigger = `fail_hold_audit_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      try {
        await conn.query(
          `CREATE TRIGGER \`${trigger}\` BEFORE INSERT ON legal_hold_events
           FOR EACH ROW BEGIN
             IF NEW.tenant_id = ? THEN
               SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected legal hold audit failure';
             END IF;
           END`,
          [tenantId],
        );
        await expect(store.setLegalHold({
          tenantId,
          holdId,
          subjectKind: "user",
          subjectId: userId,
          reasonCode: "billing_dispute",
          expectedControlGeneration: 0,
          actorKeyId: "hold-admin",
          atMs,
        })).rejects.toThrow("injected legal hold audit failure");
        expect(await store.getLegalHold(tenantId, holdId)).toBeNull();
        expect(await store.getActiveLegalHoldState(tenantId, "user", userId)).toMatchObject({
          control: { controlGeneration: 0, activeHoldCount: 0 },
          holds: [],
        });

        await conn.query(
          `INSERT INTO subject_lifecycle
             (tenant_id, subject_kind, subject_id, state, generation, active_request_id,
              legal_hold_at_ms, created_at_ms, updated_at_ms)
           VALUES (?, 'user', ?, 'active', 0, NULL, ?, ?, ?)`,
          [`${tenantId}_corrupt`, userId, atMs, atMs, atMs],
        );
        await expect(store.getActiveLegalHoldState(`${tenantId}_corrupt`, "user", userId))
          .rejects.toBeInstanceOf(LegalHoldIntegrityError);

        const provenTenant = `${tenantId}_proven`;
        const provenHold = await store.setLegalHold({
          tenantId: provenTenant,
          holdId: newLegalHoldId(),
          subjectKind: "user",
          subjectId: userId,
          reasonCode: "regulatory",
          expectedControlGeneration: 0,
          actorKeyId: "hold-admin",
          atMs: atMs + 10,
        });
        await conn.query(
          `UPDATE subject_lifecycle SET legal_hold_at_ms=legal_hold_at_ms+1
            WHERE tenant_id=? AND subject_kind='user' AND subject_id=?`,
          [provenTenant, userId],
        );
        await expect(store.getActiveLegalHoldState(provenTenant, "user", userId))
          .rejects.toBeInstanceOf(LegalHoldIntegrityError);
        await conn.query(
          `UPDATE subject_lifecycle SET legal_hold_at_ms=?
            WHERE tenant_id=? AND subject_kind='user' AND subject_id=?`,
          [provenHold.createdAtMs, provenTenant, userId],
        );
        await conn.query(
          `UPDATE legal_hold_controls SET active_hold_count=0
            WHERE tenant_id=? AND subject_kind='user' AND subject_id=?`,
          [provenTenant, userId],
        );
        await expect(store.getActiveLegalHoldState(provenTenant, "user", userId))
          .rejects.toBeInstanceOf(LegalHoldIntegrityError);
      } finally {
        await conn.query(`DROP TRIGGER IF EXISTS \`${trigger}\``).catch(() => {});
        await conn.end();
        await store.close();
      }
    });

    it("linearizes a legal hold against destructive usage anonymization across two stores", async () => {
      const first = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const second = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const session = mkSession(
        `tenant_hold_usage_${randomUUID()}`,
        `user_${randomUUID()}`,
      );
      const baseAtMs = Math.max(Date.now(), session.createdAtMs) + 60_000;
      try {
        await first.createSession(session);
        await first.commit({
          sessionId: session.id,
          fence: 1,
          usageEntries: [{
            usageId: newUsageId(),
            turnId: newId("turn"),
            step: 1,
            provider: "retention-test",
            model: "retention-test",
            usage: { ...emptyUsage(), inputTokens: 1, totalTokens: 1, costCNY: 0 },
            createdAtMs: baseAtMs,
          }],
          lifecycle: {
            type: "tombstone",
            tenantId: session.tenantId,
            userId: session.userId,
            deletionGeneration: 1,
            atMs: baseAtMs + 1,
          },
          events: [{
            type: "session/deleted",
            sessionId: session.id,
            deletionGeneration: 1,
            emittedAtMs: baseAtMs + 1,
          }],
        });
        const verified = await first.reconcileSessionUsage({
          tenantId: session.tenantId,
          userId: session.userId,
          sessionId: session.id,
          deletionGeneration: 1,
          nowMs: baseAtMs + 2,
        });
        const raced = await Promise.allSettled([
          first.setLegalHold({
            tenantId: session.tenantId,
            holdId: newLegalHoldId(),
            subjectKind: "user",
            subjectId: session.userId,
            reasonCode: "litigation",
            expectedControlGeneration: 0,
            actorKeyId: "hold-admin",
            atMs: baseAtMs + 3,
          }),
          second.anonymizeSessionUsage({
            tenantId: session.tenantId,
            userId: session.userId,
            sessionId: session.id,
            deletionGeneration: 1,
            expectedChecksum: verified.checksum,
            nowMs: baseAtMs + 3,
            enabled: true,
          }),
        ]);
        expect(raced[0]?.status).toBe("fulfilled");
        if (raced[1]?.status === "rejected") {
          expect(raced[1].reason).toBeInstanceOf(UsageLegalHoldError);
          expect((await first.reconcileSessionUsage({
            tenantId: session.tenantId,
            userId: session.userId,
            sessionId: session.id,
            deletionGeneration: 1,
            nowMs: baseAtMs + 4,
          })).status).toBe("verified");
        } else {
          expect(raced[1]?.value).toMatchObject({ status: "anonymized" });
        }
      } finally {
        await second.close();
        await first.close();
      }
    });
  });
} else {
  describe("MysqlSessionStore retention policy and legal hold", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 with deploy/local/infra.sh running to enable", () => {});
  });
}
