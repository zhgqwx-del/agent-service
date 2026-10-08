import { randomUUID } from "node:crypto";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MysqlSessionStore } from "../src/index.js";
import { lifecycleOutboxStoreConformance, newId } from "./conformance.js";

const BASE_MYSQL_URL = process.env.MYSQL_TEST_URL ?? "mysql://root@127.0.0.1:3306/agent_service_test";

function assertDisposableTestTarget(rawUrl: string): URL {
  const url = new URL(rawUrl);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) {
    throw new Error(
      `refusing to create lifecycle outbox fixture database from base database "${database}": `
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

type SeededOutbox = {
  outboxId: number;
  sessionId: string;
};

type OutboxStateRow = RowDataPacket & {
  outbox_id: number;
  attempts: number;
  claim_token: string | null;
  lease_until_ms: number | null;
  available_at_ms: number | null;
  last_error: string | null;
  completed_at_ms: number | null;
  dead_lettered_at_ms: number | null;
};

/**
 * Worker tests insert only the intent they need. Random aggregate ids and per-test cleanup make a
 * failed assertion diagnosable while the file-level disposable database prevents cross-suite claims.
 */
async function seedTombstoneIntents(conn: Connection, count: number): Promise<SeededOutbox[]> {
  const seeded: SeededOutbox[] = [];
  for (let index = 0; index < count; index += 1) {
    const sessionId = newId("sess");
    await conn.query(
      `INSERT INTO lifecycle_outbox
         (topic, aggregate_id, generation, payload, available_at_ms, attempts, created_at_ms)
       VALUES ('session.tombstoned', ?, 1, ?, 0, 0, 0)`,
      [sessionId, JSON.stringify({ sessionId, deletionGeneration: 1, eventSeq: 2 })],
    );
    const [rows] = await conn.query<(RowDataPacket & { outbox_id: number })[]>(
      `SELECT outbox_id FROM lifecycle_outbox
        WHERE topic='session.tombstoned' AND aggregate_id=? AND generation=1`,
      [sessionId],
    );
    seeded.push({ outboxId: Number(rows[0]?.outbox_id), sessionId });
  }
  return seeded;
}

async function readOutboxState(conn: Connection, outboxId: number): Promise<OutboxStateRow> {
  const [rows] = await conn.query<OutboxStateRow[]>(
    `SELECT outbox_id, attempts, claim_token, lease_until_ms, available_at_ms, last_error,
            completed_at_ms, dead_lettered_at_ms
       FROM lifecycle_outbox WHERE outbox_id=?`,
    [outboxId],
  );
  const row = rows[0];
  if (!row) throw new Error(`missing lifecycle outbox fixture ${outboxId}`);
  return row;
}

async function cleanupIntents(conn: Connection, seeded: readonly SeededOutbox[]): Promise<void> {
  for (const row of seeded) {
    await conn.query("DELETE FROM lifecycle_outbox WHERE outbox_id=? AND aggregate_id=?", [row.outboxId, row.sessionId]);
  }
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore lifecycle outbox", () => {
    let admin: Connection | undefined;
    let mysqlUrl = "";
    let database = "";

    beforeAll(async () => {
      const base = assertDisposableTestTarget(BASE_MYSQL_URL);
      database = `agent_service_outbox_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
      if (!/^agent_service_outbox_test_[a-zA-Z0-9_]+$/.test(database)) {
        throw new Error("unsafe generated lifecycle outbox fixture database name");
      }
      admin = await mysql.createConnection(databaseUrl(base, "mysql"));
      await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
      mysqlUrl = databaseUrl(base, database);

      // Apply the same production migrations as a runner before any raw fixture row is inserted.
      const migrated = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 1 });
      await migrated.close();
    });

    afterAll(async () => {
      if (admin && database) await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      await admin?.end();
    });

    lifecycleOutboxStoreConformance(
      "mysql",
      async () => MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 }),
    );

    it("uses FOR UPDATE SKIP LOCKED so a locked first row does not block the next claim", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 3 });
      const blocker = await mysql.createConnection(mysqlUrl);
      const seeded = await seedTombstoneIntents(blocker, 2);
      let lockHeld = false;

      try {
        await blocker.beginTransaction();
        await blocker.query("SELECT outbox_id FROM lifecycle_outbox WHERE outbox_id=? FOR UPDATE", [seeded[0]!.outboxId]);
        lockHeld = true;

        // If SKIP LOCKED regresses, release the fixture lock quickly instead of waiting for MySQL's
        // default lock timeout. The assertion below still fails deterministically in that case.
        let hadToReleaseBlockedClaim = false;
        const releaseTimer = setTimeout(() => {
          hadToReleaseBlockedClaim = true;
          void blocker.rollback();
        }, 2_000);
        const claimed = await store.claimLifecycleOutbox({
          topics: ["session.tombstoned"],
          nowMs: 0,
          limit: 1,
          leaseMs: 100,
          claimToken: "worker-skip-locked",
        });
        clearTimeout(releaseTimer);
        if (hadToReleaseBlockedClaim) throw new Error("claim waited on a locked lifecycle outbox row");

        expect(claimed).toHaveLength(1);
        expect(claimed[0]).toMatchObject({
          outboxId: seeded[1]!.outboxId,
          aggregateId: seeded[1]!.sessionId,
          attempts: 1,
          claimToken: "worker-skip-locked",
          leaseUntilMs: 100,
        });

        await blocker.rollback();
        lockHeld = false;
        const released = await store.claimLifecycleOutbox({
          topics: ["session.tombstoned"],
          nowMs: 0,
          limit: 1,
          leaseMs: 100,
          claimToken: "worker-after-unlock",
        });
        expect(released).toHaveLength(1);
        expect(released[0]).toMatchObject({
          outboxId: seeded[0]!.outboxId,
          aggregateId: seeded[0]!.sessionId,
          attempts: 1,
          claimToken: "worker-after-unlock",
        });
      } finally {
        if (lockHeld) await blocker.rollback().catch(() => {});
        await cleanupIntents(blocker, seeded).catch(() => {});
        await blocker.end();
        await store.close();
      }
    });

    it("lets two stores claim concurrently without returning any row twice", async () => {
      const firstStore = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 2 });
      const secondStore = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 2 });
      const conn = await mysql.createConnection(mysqlUrl);
      const seeded = await seedTombstoneIntents(conn, 6);

      try {
        const [first, second] = await Promise.all([
          firstStore.claimLifecycleOutbox({
            topics: ["session.tombstoned"], nowMs: 0, limit: 3, leaseMs: 100, claimToken: "worker-a",
          }),
          secondStore.claimLifecycleOutbox({
            topics: ["session.tombstoned"], nowMs: 0, limit: 3, leaseMs: 100, claimToken: "worker-b",
          }),
        ]);

        expect(first.length).toBeLessThanOrEqual(3);
        expect(second.length).toBeLessThanOrEqual(3);
        expect(first.every((row) => row.claimToken === "worker-a")).toBe(true);
        expect(second.every((row) => row.claimToken === "worker-b")).toBe(true);
        const concurrent = [...first, ...second];
        expect(new Set(concurrent.map((row) => row.outboxId)).size).toBe(concurrent.length);

        // SKIP LOCKED is deliberately non-blocking and may return an under-filled batch while the
        // other transaction owns part of the ordered scan. A following poll must still see every
        // skipped row; no intent may be duplicated or become stranded.
        const drained = await firstStore.claimLifecycleOutbox({
          topics: ["session.tombstoned"], nowMs: 0, limit: 6, leaseMs: 100, claimToken: "worker-drain",
        });
        const all = [...concurrent, ...drained];
        const claimedIds = all.map((row) => row.outboxId);
        expect(new Set(claimedIds).size).toBe(6);
        expect(claimedIds.sort((a, b) => a - b)).toEqual(
          seeded.map((row) => row.outboxId).sort((a, b) => a - b),
        );
        expect(drained.every((row) => row.claimToken === "worker-drain")).toBe(true);
        expect(all.every((row) => row.attempts === 1 && row.leaseUntilMs === 100)).toBe(true);
      } finally {
        await cleanupIntents(conn, seeded).catch(() => {});
        await conn.end();
        await firstStore.close();
        await secondStore.close();
      }
    });

    it("quarantines a malformed payload without starving the valid intent behind it", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 2 });
      const conn = await mysql.createConnection(mysqlUrl);
      const seeded = await seedTombstoneIntents(conn, 2);
      const fixture = seeded[0]!;

      try {
        // This is the purge payload shape stored under the tombstoned topic: eventSeq is mandatory
        // for the dispatcher to republish the exact durable terminal event.
        await conn.query(
          "UPDATE lifecycle_outbox SET payload=? WHERE outbox_id=?",
          [JSON.stringify({ sessionId: fixture.sessionId, deletionGeneration: 1 }), fixture.outboxId],
        );

        await expect(
          store.getLifecycleOutbox("session.tombstoned", fixture.sessionId, 1),
        ).rejects.toThrow("eventSeq");
        expect(await store.claimLifecycleOutbox({
          topics: ["session.tombstoned"],
          nowMs: 0,
          limit: 1,
          leaseMs: 100,
          claimToken: "malformed-payload",
        })).toEqual([]);
        expect(await readOutboxState(conn, fixture.outboxId)).toMatchObject({
          attempts: 1,
          claim_token: null,
          lease_until_ms: null,
          available_at_ms: null,
          completed_at_ms: null,
          dead_lettered_at_ms: 0,
        });

        const next = await store.claimLifecycleOutbox({
          topics: ["session.tombstoned"],
          nowMs: 0,
          limit: 1,
          leaseMs: 100,
          claimToken: "after-malformed",
        });
        expect(next).toHaveLength(1);
        expect(next[0]).toMatchObject({ outboxId: seeded[1]!.outboxId, claimToken: "after-malformed" });
      } finally {
        await cleanupIntents(conn, seeded).catch(() => {});
        await conn.end();
        await store.close();
      }
    });

    it("refuses every acknowledgement operation for an old or abnormal purge claim", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 2 });
      const conn = await mysql.createConnection(mysqlUrl);
      const sessionId = newId("sess");
      let fixture: SeededOutbox | undefined;

      try {
        await conn.query(
          `INSERT INTO lifecycle_outbox
             (topic, aggregate_id, generation, payload, available_at_ms, attempts,
              claim_token, lease_until_ms, created_at_ms)
           VALUES ('session.purge', ?, 1, ?, NULL, 1, 'legacy-purge-claim', 100, 0)`,
          [sessionId, JSON.stringify({ sessionId, deletionGeneration: 1 })],
        );
        const [rows] = await conn.query<(RowDataPacket & { outbox_id: number })[]>(
          `SELECT outbox_id FROM lifecycle_outbox
            WHERE topic='session.purge' AND aggregate_id=? AND generation=1`,
          [sessionId],
        );
        fixture = { outboxId: Number(rows[0]?.outbox_id), sessionId };

        expect(await store.renewLifecycleOutboxClaim(
          fixture.outboxId,
          "legacy-purge-claim",
          { nowMs: 1, leaseMs: 200 },
        )).toBe(false);
        expect(await store.completeLifecycleOutbox(
          fixture.outboxId,
          "legacy-purge-claim",
          1,
        )).toBe(false);
        expect(await store.retryLifecycleOutbox(fixture.outboxId, "legacy-purge-claim", {
          failedAtMs: 1,
          availableAtMs: 10,
          error: "must stay dormant without an attempt bound",
        })).toBe(false);
        expect(await store.retryLifecycleOutbox(fixture.outboxId, "legacy-purge-claim", {
          failedAtMs: 1,
          availableAtMs: 10,
          error: "must stay dormant",
          maxAttempts: 2,
        })).toBe(false);
        expect(await readOutboxState(conn, fixture.outboxId)).toMatchObject({
          attempts: 1,
          claim_token: "legacy-purge-claim",
          lease_until_ms: 100,
          available_at_ms: null,
          last_error: null,
          completed_at_ms: null,
          dead_lettered_at_ms: null,
        });
      } finally {
        if (fixture) await cleanupIntents(conn, [fixture]).catch(() => {});
        await conn.end();
        await store.close();
      }
    });

    it("expires leases at the exact boundary, increments attempts on reclaim, and rejects stale tokens", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 2 });
      const conn = await mysql.createConnection(mysqlUrl);
      const seeded = await seedTombstoneIntents(conn, 1);
      const fixture = seeded[0]!;

      try {
        const first = await store.claimLifecycleOutbox({
          topics: ["session.tombstoned"], nowMs: 0, limit: 1, leaseMs: 10, claimToken: "lease-old",
        });
        expect(first[0]).toMatchObject({ outboxId: fixture.outboxId, attempts: 1, leaseUntilMs: 10 });

        expect(await store.claimLifecycleOutbox({
          topics: ["session.tombstoned"], nowMs: 9, limit: 1, leaseMs: 10, claimToken: "lease-too-early",
        })).toEqual([]);
        expect(await store.renewLifecycleOutboxClaim(
          fixture.outboxId,
          "lease-old",
          { nowMs: 10, leaseMs: 20 },
        )).toBe(false);

        const reclaimed = await store.claimLifecycleOutbox({
          topics: ["session.tombstoned"], nowMs: 10, limit: 1, leaseMs: 20, claimToken: "lease-new",
        });
        expect(reclaimed[0]).toMatchObject({
          outboxId: fixture.outboxId,
          attempts: 2,
          claimToken: "lease-new",
          leaseUntilMs: 30,
        });

        expect(await store.renewLifecycleOutboxClaim(
          fixture.outboxId,
          "lease-old",
          { nowMs: 10, leaseMs: 20 },
        )).toBe(false);
        expect(await store.completeLifecycleOutbox(fixture.outboxId, "lease-old", 11)).toBe(false);
        expect(await store.retryLifecycleOutbox(fixture.outboxId, "lease-old", {
          failedAtMs: 11,
          availableAtMs: 20,
          error: new Error("stale worker"),
          maxAttempts: 3,
        })).toBe(false);

        expect(await store.renewLifecycleOutboxClaim(
          fixture.outboxId,
          "lease-new",
          { nowMs: 11, leaseMs: 25 },
        )).toBe(true);
        expect(await readOutboxState(conn, fixture.outboxId)).toMatchObject({
          attempts: 2,
          claim_token: "lease-new",
          lease_until_ms: 36,
          completed_at_ms: null,
        });
        expect(await store.completeLifecycleOutbox(fixture.outboxId, "lease-new", 12)).toBe(true);
        expect(await store.completeLifecycleOutbox(fixture.outboxId, "lease-new", 13)).toBe(false);
        expect(await store.claimLifecycleOutbox({
          topics: ["session.tombstoned"], nowMs: 100, limit: 1, leaseMs: 10, claimToken: "lease-after-complete",
        })).toEqual([]);
      } finally {
        await cleanupIntents(conn, seeded).catch(() => {});
        await conn.end();
        await store.close();
      }
    });

    it("reschedules retryable failures and dead-letters the row at max attempts", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 2 });
      const conn = await mysql.createConnection(mysqlUrl);
      const seeded = await seedTombstoneIntents(conn, 1);
      const fixture = seeded[0]!;

      try {
        const first = await store.claimLifecycleOutbox({
          topics: ["session.tombstoned"], nowMs: 0, limit: 1, leaseMs: 10, claimToken: "retry-first",
        });
        expect(first[0]).toMatchObject({ outboxId: fixture.outboxId, attempts: 1 });
        expect(await store.retryLifecycleOutbox(fixture.outboxId, "retry-first", {
          failedAtMs: 1,
          availableAtMs: 20,
          error: new Error("transient failure"),
          maxAttempts: 2,
        })).toBe(true);
        expect(await readOutboxState(conn, fixture.outboxId)).toMatchObject({
          attempts: 1,
          claim_token: null,
          lease_until_ms: null,
          available_at_ms: 20,
          last_error: "transient failure",
          dead_lettered_at_ms: null,
        });
        expect(await store.claimLifecycleOutbox({
          topics: ["session.tombstoned"], nowMs: 19, limit: 1, leaseMs: 10, claimToken: "retry-too-early",
        })).toEqual([]);

        const second = await store.claimLifecycleOutbox({
          topics: ["session.tombstoned"], nowMs: 20, limit: 1, leaseMs: 10, claimToken: "retry-final",
        });
        expect(second[0]).toMatchObject({ outboxId: fixture.outboxId, attempts: 2, leaseUntilMs: 30 });
        expect(await store.retryLifecycleOutbox(fixture.outboxId, "retry-final", {
          failedAtMs: 21,
          availableAtMs: 40,
          error: "terminal failure",
          maxAttempts: 2,
        })).toBe(true);
        expect(await readOutboxState(conn, fixture.outboxId)).toMatchObject({
          attempts: 2,
          claim_token: null,
          lease_until_ms: null,
          available_at_ms: null,
          last_error: "terminal failure",
          completed_at_ms: null,
          dead_lettered_at_ms: 21,
        });
        expect(await store.claimLifecycleOutbox({
          topics: ["session.tombstoned"], nowMs: 100, limit: 1, leaseMs: 10, claimToken: "retry-after-dead-letter",
        })).toEqual([]);
      } finally {
        await cleanupIntents(conn, seeded).catch(() => {});
        await conn.end();
        await store.close();
      }
    });
  });
} else {
  describe("MysqlSessionStore lifecycle outbox", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 with deploy/local/infra.sh running to enable", () => {});
  });
}
