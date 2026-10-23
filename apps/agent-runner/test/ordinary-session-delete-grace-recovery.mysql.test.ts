import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OrdinarySessionDeleteGraceRecovery } from "@agent-service/core";
import { MysqlSessionStore, ORDINARY_SESSION_DELETE_GRACE_MS } from "@agent-service/store";
import { mkSession } from "../../../packages/store/test/conformance.js";
import { CurrentMysqlRuntimeOwner } from "../../../packages/store/test/fixtures/current-mysql-runtime.js";
import { acquireFixedFixtureAuthority } from "./fixtures/session-authority.js";

const BASE_MYSQL_URL = process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";

function disposableBase(raw: string): URL {
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:"
    || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) {
    throw new Error("MYSQL_TEST_URL must target local disposable MySQL");
  }
  return url;
}

async function ordinaryDelete(store: MysqlSessionStore, session: ReturnType<typeof mkSession>) {
  const atMs = Date.now();
  const held = await acquireFixedFixtureAuthority(store, session, 0, { label: "ordinary-grace-delete", ttlMs: 30_000 });
  try { return await store.commitOrdinarySessionDelete(held.admit({
    sessionId: session.id,
    fence: 1,
    lifecycle: { type: "tombstone", tenantId: session.tenantId, userId: session.userId,
      atMs, purgeAfterMs: null, deletionGeneration: 1 },
    events: [{ type: "session/deleted", sessionId: session.id,
      emittedAtMs: atMs, deletionGeneration: 1 }],
  })); } finally { await held.release(); }
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("runner ordinary DELETE grace recovery on real MySQL", () => {
    let mysqlOwner: CurrentMysqlRuntimeOwner | undefined;

    beforeAll(async () => {
      mysqlOwner = new CurrentMysqlRuntimeOwner(disposableBase(BASE_MYSQL_URL).toString());
      await mysqlOwner.prepare(); // Fresh witness/schema/source authority CLI; original global hook budget.
    });

    afterAll(async ({}, suite) => {
      type Collected = { type: string; tasks?: readonly Collected[]; result?: { state?: string } };
      const tests: Collected[] = [];
      const collect = (tasks: readonly Collected[]) => { for (const task of tasks) {
        if (task.type === "test") tests.push(task); else if (task.tasks) collect(task.tasks);
      } };
      collect(suite.tasks);
      await mysqlOwner?.close({ successful: tests.length > 0 && tests.every(test => test.result?.state === "pass") });
    });

    it("recovers a committed unsealed origin and keeps purge unclaimable", async () => {
      const first = await mysqlOwner!.openStore(3);
      const second = await mysqlOwner!.openStore(3);
      const conn = await mysqlOwner!.openInspection();
      const session = mkSession(`tenant-grace-recovery-${randomUUID()}`,
        `user-grace-recovery-${randomUUID()}`);
      try {
        await first.createSession(session);
        await ordinaryDelete(first, session);
        expect(await first.getOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id))
          .toEqual({ state: "unknown", executionReady: false, physicalPurgeEnabled: false });
        const firstRecovery = new OrdinarySessionDeleteGraceRecovery({ store: first }, { batchSize: 1 });
        const secondRecovery = new OrdinarySessionDeleteGraceRecovery({ store: second }, { batchSize: 1 });
        const counts = await Promise.all([firstRecovery.recoverOnce(), secondRecovery.recoverOnce()]);
        expect(counts.every((count) => count <= 1)).toBe(true);
        const sealed = await first.getOrdinarySessionDeleteGrace(
          session.tenantId, session.userId, session.id,
        );
        expect(sealed).toMatchObject({ state: "sealed", executionReady: false,
          physicalPurgeEnabled: false });
        const [sealRows] = await conn.query<RowDataPacket[]>(
          `SELECT ordinary_delete_seal_observed_db_ms AS seal_ms,purge_after_ms
             FROM sessions WHERE session_id=?`, [session.id],
        );
        expect(sealed?.graceFloorDbMs).toBe(Number(sealRows[0]?.seal_ms)
          + 1 + ORDINARY_SESSION_DELETE_GRACE_MS);
        expect(sealRows[0]?.purge_after_ms).toBeNull();
        expect(await firstRecovery.recoverOnce()).toBe(0);
        expect(await first.getOrdinarySessionDeleteGrace(
          session.tenantId, "other-user", session.id,
        )).toBeNull();
        const purge = await first.getLifecycleOutbox("session.purge", session.id, 1);
        expect(purge?.availableAtMs).toBeUndefined();
        expect(purge?.claimToken).toBeUndefined();
      } finally {
        await conn.end();
        await first.close();
        await second.close();
      }
    });

    it("does not backfill a legacy-shaped tombstone with no trusted ordinary origin", async () => {
      const store = await mysqlOwner!.openStore(2);
      const session = mkSession(`tenant-grace-legacy-${randomUUID()}`,
        `user-grace-legacy-${randomUUID()}`);
      try {
        await store.createSession(session);
        const atMs = Date.now();
        const held = await acquireFixedFixtureAuthority(store, session, 0, { label: "legacy-shaped-tombstone", ttlMs: 30_000 });
        try { await store.commit(held.admit({
          sessionId: session.id, fence: 1,
          lifecycle: { type: "tombstone", tenantId: session.tenantId, userId: session.userId,
            atMs, purgeAfterMs: null, deletionGeneration: 1 },
          events: [{ type: "session/deleted", sessionId: session.id,
            emittedAtMs: atMs, deletionGeneration: 1 }],
        })); } finally { await held.release(); }
        const recovery = new OrdinarySessionDeleteGraceRecovery({ store }, { batchSize: 100 });
        expect(await recovery.recoverOnce()).toBe(0);
        expect(await store.getOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id))
          .toEqual({ state: "unknown", executionReady: false, physicalPurgeEnabled: false });
      } finally {
        await store.close();
      }
    });
  });
} else {
  describe("runner ordinary DELETE grace recovery on real MySQL", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 to exercise real InnoDB", () => {});
  });
}
