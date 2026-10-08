import { describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import mysql, { type RowDataPacket } from "mysql2/promise";
import type { Event } from "@agent-service/protocol";
import { IdempotencyPendingError, MysqlSessionStore, RedisEventBus, RedisLeaseStore } from "../src/index.js";
import { eventBusConformance, leaseStoreConformance, mkSession, newId, sessionStoreConformance } from "./conformance.js";

const MYSQL_URL = process.env.MYSQL_TEST_URL ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const REDIS_URL = process.env.REDIS_TEST_URL ?? "redis://127.0.0.1:6379/1";

// Integration tests: require deploy/local/infra.sh start. Skipped when AGENT_SERVICE_INTEGRATION is unset.
if (process.env.AGENT_SERVICE_INTEGRATION) {
  sessionStoreConformance("mysql", async () => MysqlSessionStore.connect({ url: MYSQL_URL, connectionLimit: 5 }));
  leaseStoreConformance(
    "redis",
    async () => new RedisLeaseStore(REDIS_URL, "test"),
    async (_l, sid) => {
      const r = new Redis(REDIS_URL);
      await r.del(`test:lease:{${sid}}`);
      await r.quit();
    },
  );
  eventBusConformance("redis", async () => new RedisEventBus(REDIS_URL, { prefix: "test" }));

  describe("redis event bus atomic result handling", () => {
    it("rejects when one MULTI subcommand fails instead of acknowledging a partial publish", async () => {
      const prefix = `test-multi-${newId("prefix")}`;
      const sessionId = newId("sess");
      const redis = new Redis(REDIS_URL);
      const bus = new RedisEventBus(REDIS_URL, { prefix });
      const streamKey = `${prefix}:stream:{${sessionId}}`;
      try {
        await redis.set(streamKey, "wrong-type");
        await expect(bus.publish(sessionId, {
          type: "session/created",
          sessionId,
          seq: 1,
          emittedAtMs: 1,
        })).rejects.toThrow("Redis event publish transaction failed");
      } finally {
        await redis.del(streamKey);
        await bus.close();
        await redis.quit();
      }
    });

    it("notifies active subscribers after reconnect and retries a failed durable catch-up callback", async () => {
      const prefix = `test-reconnect-${newId("prefix")}`;
      const sessionId = newId("sess");
      const bus = new RedisEventBus(REDIS_URL, { prefix });
      let recoveries = 0;
      const unsub = await bus.subscribe(sessionId, () => {}, {
        onReconnect: async () => {
          recoveries += 1;
          if (recoveries === 1) throw new Error("temporary durable store outage");
        },
      });
      const sub = (bus as unknown as { sub: Redis }).sub;
      try {
        const ended = new Promise<void>((resolve) => sub.once("end", () => resolve()));
        sub.disconnect();
        await ended;
        await sub.connect();

        const deadline = Date.now() + 4_000;
        while (recoveries < 2 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(recoveries).toBe(2);
      } finally {
        unsub();
        await bus.close();
      }
    });

    it("queues an overlapping reconnect while the previous durable catch-up is still running", async () => {
      const bus = new RedisEventBus(REDIS_URL, { prefix: `test-overlap-${newId("prefix")}` });
      const sessionId = newId("sess");
      let recoveries = 0;
      let releaseFirst!: () => void;
      let markStarted!: () => void;
      const firstStarted = new Promise<void>((resolve) => { markStarted = resolve; });
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const unsub = await bus.subscribe(sessionId, () => {}, {
        onReconnect: async () => {
          recoveries += 1;
          if (recoveries === 1) {
            markStarted();
            await firstGate;
          }
        },
      });
      const internal = bus as unknown as { recoverSubscriptions(): Promise<void> };
      try {
        await internal.recoverSubscriptions();
        await firstStarted;
        await internal.recoverSubscriptions();
        releaseFirst();

        const deadline = Date.now() + 2_000;
        while (recoveries < 2 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(recoveries).toBe(2);
      } finally {
        releaseFirst();
        unsub();
        await bus.close();
      }
    });

    it("does not retain a phantom local channel after the first SUBSCRIBE command fails", async () => {
      const prefix = `test-subscribe-failure-${newId("prefix")}`;
      const sessionId = newId("sess");
      const bus = new RedisEventBus(REDIS_URL, { prefix });
      const internal = bus as unknown as {
        sub: { subscribe: (...channels: string[]) => Promise<number> };
        listeners: Map<string, Set<unknown>>;
      };
      const originalSubscribe = internal.sub.subscribe.bind(internal.sub);
      let failOnce = true;
      internal.sub.subscribe = async (...channels: string[]) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("injected subscribe failure");
        }
        return originalSubscribe(...channels);
      };
      const channel = `${prefix}:evt:{${sessionId}}`;
      try {
        await expect(bus.subscribe(sessionId, () => {})).rejects.toThrow("injected subscribe failure");
        expect(internal.listeners.has(channel)).toBe(false);

        const received: Event[] = [];
        const unsub = await bus.subscribe(sessionId, (event) => received.push(event));
        await bus.publish(sessionId, { type: "heartbeat", sessionId, emittedAtMs: 1 });
        const deadline = Date.now() + 1_000;
        while (received.length === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(received).toHaveLength(1);
        unsub();
      } finally {
        await bus.close();
      }
    });

    it("cleans up a subscribed listener when initial hot replay fails", async () => {
      const prefix = `test-replay-failure-${newId("prefix")}`;
      const sessionId = newId("sess");
      const bus = new RedisEventBus(REDIS_URL, { prefix });
      const internal = bus as unknown as {
        pub: { xrange: (...args: string[]) => Promise<Array<[string, string[]]>> };
        listeners: Map<string, Set<unknown>>;
      };
      const originalXrange = internal.pub.xrange.bind(internal.pub);
      let failOnce = true;
      internal.pub.xrange = async (...args: string[]) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("injected hot replay failure");
        }
        return originalXrange(...args);
      };
      const channel = `${prefix}:evt:{${sessionId}}`;
      try {
        await expect(bus.subscribe(sessionId, () => {}, { afterSeq: 0 })).rejects.toThrow("injected hot replay failure");
        expect(internal.listeners.has(channel)).toBe(false);

        const received: Event[] = [];
        const unsub = await bus.subscribe(sessionId, (event) => received.push(event), { afterSeq: 0 });
        await bus.publish(sessionId, { type: "heartbeat", sessionId, emittedAtMs: 1 });
        const deadline = Date.now() + 1_000;
        while (received.length === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(received).toHaveLength(1);
        unsub();
      } finally {
        await bus.close();
      }
    });

    it("keeps a replacement subscription active when a stale unsubscribe is called twice", async () => {
      const prefix = `test-stale-unsubscribe-${newId("prefix")}`;
      const sessionId = newId("sess");
      const bus = new RedisEventBus(REDIS_URL, { prefix });
      const firstUnsubscribe = await bus.subscribe(sessionId, () => {});
      try {
        firstUnsubscribe();
        const received: Event[] = [];
        const secondUnsubscribe = await bus.subscribe(sessionId, (event) => received.push(event));
        firstUnsubscribe();

        await bus.publish(sessionId, { type: "heartbeat", sessionId, emittedAtMs: 1 });
        const deadline = Date.now() + 1_000;
        while (received.length === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(received).toHaveLength(1);
        secondUnsubscribe();
        await bus.publish(sessionId, { type: "heartbeat", sessionId, emittedAtMs: 2 });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(received).toHaveLength(1);
      } finally {
        firstUnsubscribe();
        await bus.close();
      }
    });

    it("serializes an in-flight replacement SUBSCRIBE against the last old unsubscribe", async () => {
      const prefix = `test-overlap-subscribe-${newId("prefix")}`;
      const sessionId = newId("sess");
      const bus = new RedisEventBus(REDIS_URL, { prefix });
      const internal = bus as unknown as {
        sub: {
          subscribe: (...channels: string[]) => Promise<number>;
          unsubscribe: (...channels: string[]) => Promise<number>;
        };
      };
      const originalSubscribe = internal.sub.subscribe.bind(internal.sub);
      const originalUnsubscribe = internal.sub.unsubscribe.bind(internal.sub);
      let subscribeCalls = 0;
      let unsubscribeCalls = 0;
      let releaseSecond = () => {};
      let markSecondAcknowledged = () => {};
      const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
      const secondAcknowledged = new Promise<void>((resolve) => { markSecondAcknowledged = resolve; });
      internal.sub.subscribe = async (...channels: string[]) => {
        const result = await originalSubscribe(...channels);
        subscribeCalls += 1;
        if (subscribeCalls === 2) {
          markSecondAcknowledged();
          await secondGate;
        }
        return result;
      };
      internal.sub.unsubscribe = async (...channels: string[]) => {
        unsubscribeCalls += 1;
        return originalUnsubscribe(...channels);
      };

      let secondUnsubscribe: (() => void) | undefined;
      try {
        const firstUnsubscribe = await bus.subscribe(sessionId, () => {});
        const received: Event[] = [];
        const secondSubscription = bus.subscribe(sessionId, (event) => received.push(event));
        await secondAcknowledged;
        firstUnsubscribe();
        releaseSecond();
        secondUnsubscribe = await secondSubscription;
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(unsubscribeCalls).toBe(0);
        await bus.publish(sessionId, { type: "heartbeat", sessionId, emittedAtMs: 1 });
        const deadline = Date.now() + 1_000;
        while (received.length === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(received).toHaveLength(1);
      } finally {
        releaseSecond();
        secondUnsubscribe?.();
        await bus.close();
      }
    });

    it("drops malformed live messages without breaking delivery of the next valid event", async () => {
      const prefix = `test-malformed-live-${newId("prefix")}`;
      const sessionId = newId("sess");
      const channel = `${prefix}:evt:{${sessionId}}`;
      const bus = new RedisEventBus(REDIS_URL, { prefix });
      const publisher = new Redis(REDIS_URL);
      const received: Event[] = [];
      const unsubscribe = await bus.subscribe(sessionId, (event) => received.push(event));
      try {
        await publisher.publish(channel, "{not-json");
        await publisher.publish(channel, JSON.stringify({ type: "unknown/event", sessionId, emittedAtMs: 1 }));
        await publisher.publish(channel, JSON.stringify({ type: "heartbeat", sessionId, emittedAtMs: 2 }));
        const deadline = Date.now() + 1_000;
        while (received.length === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(received).toEqual([{ type: "heartbeat", sessionId, emittedAtMs: 2 }]);
      } finally {
        unsubscribe();
        await bus.close();
        await publisher.quit();
      }
    });
  });

  describe("mysql migrations", () => {
    it.each([
      ["unexpired", 60_000],
      ["expired", -60_000],
    ])("does not replace an %s legacy pending idempotency row", async (_label, expiryOffsetMs) => {
      const store = await MysqlSessionStore.connect({ url: MYSQL_URL, connectionLimit: 2 });
      const conn = await mysql.createConnection(MYSQL_URL);
      const session = mkSession();
      const key = `legacy-${newId("key")}`;
      const expiresAt = Date.now() + expiryOffsetMs;
      try {
        await store.createSession(session);
        await conn.query(
          "INSERT INTO idempotency_keys (tenant_id, user_id, session_id, idem_key, request_hash, value, expires_at_ms) VALUES (?,?,?,?,NULL,NULL,?)",
          [session.tenantId, session.userId, session.id, key, expiresAt],
        );
        const scope = { tenantId: session.tenantId, userId: session.userId, sessionId: session.id };

        await expect(store.commit({
          sessionId: session.id,
          fence: 1,
          events: [{ type: "session/created", sessionId: session.id, emittedAtMs: 1 }],
          sessionPatch: { title: "must not commit" },
          idempotency: {
            scope,
            key,
            requestHash: "a".repeat(64),
            value: { sessionId: session.id, turnId: newId("turn") },
            expiresAtMs: Date.now() + 60_000,
          },
        })).rejects.toBeInstanceOf(IdempotencyPendingError);

        const [pending] = await conn.query<(RowDataPacket & { value: unknown; request_hash: string | null; expires_at_ms: number })[]>(
          "SELECT value, request_hash, expires_at_ms FROM idempotency_keys WHERE tenant_id=? AND user_id=? AND session_id=? AND idem_key=?",
          [session.tenantId, session.userId, session.id, key],
        );
        expect(pending[0]).toMatchObject({ value: null, request_hash: null, expires_at_ms: expiresAt });
        expect(await store.getSession(session.tenantId, session.id)).toMatchObject({ fenceToken: 0, lastSeq: 1 });
        expect((await store.getSession(session.tenantId, session.id))?.title).toBeUndefined();
        expect(await store.readEvents(session.id, 0, 10)).toEqual([
          { type: "session/created", sessionId: session.id, emittedAtMs: session.createdAtMs, seq: 1 },
        ]);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("uses case-sensitive collations for every ownership and logical-id column", async () => {
      const store = await MysqlSessionStore.connect({ url: MYSQL_URL, connectionLimit: 2 });
      const conn = await mysql.createConnection(MYSQL_URL);
      try {
        const expected: Record<string, string[]> = {
          tenants: ["tenant_id", "auth_secret_key_id"],
          api_keys: ["key_hash", "key_id", "tenant_id"],
          agent_versions: ["tenant_id", "agent_id"],
          sessions: ["session_id", "tenant_id", "user_id", "agent_id", "parent_session_id", "context_epoch"],
          turns: ["turn_id", "session_id", "user_id", "idempotency_key"],
          items: ["item_id", "session_id", "user_id", "turn_id"],
          events: ["session_id", "user_id"],
          approvals: ["approval_id", "session_id", "user_id", "turn_id"],
          provider_configs: ["tenant_id", "provider_id", "secret_key_id"],
          idempotency_keys: ["tenant_id", "user_id", "session_id", "idem_key"],
          usage_ledger: ["tenant_id", "user_id", "session_id", "turn_id", "provider", "model"],
        };
        const [rows] = await conn.query<(RowDataPacket & { table_name: string; column_name: string; collation_name: string | null })[]>(
          `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, COLLATION_NAME AS collation_name
             FROM information_schema.columns
            WHERE table_schema = DATABASE()`,
        );
        const byColumn = new Map(rows.map((r) => [`${r.table_name}.${r.column_name}`, r.collation_name]));
        for (const [table, columns] of Object.entries(expected)) {
          for (const column of columns) expect(byColumn.get(`${table}.${column}`)).toBe("utf8mb4_0900_as_cs");
        }
        const [pk] = await conn.query<(RowDataPacket & { column_name: string })[]>(
          `SELECT COLUMN_NAME AS column_name
             FROM information_schema.statistics
            WHERE table_schema = DATABASE() AND table_name = 'idempotency_keys' AND index_name = 'PRIMARY'
            ORDER BY seq_in_index`,
        );
        expect(pk.map((r) => r.column_name)).toEqual(["tenant_id", "user_id", "session_id", "idem_key"]);
        expect(byColumn.get("idempotency_keys.request_hash")).toBe("utf8mb4_0900_as_cs");

        const [usageIdentity] = await conn.query<(RowDataPacket & { column_name: string; non_unique: number })[]>(
          `SELECT COLUMN_NAME AS column_name, NON_UNIQUE AS non_unique
             FROM information_schema.statistics
            WHERE table_schema = DATABASE() AND table_name = 'usage_ledger' AND index_name = 'uk_usage_session_turn_step'
            ORDER BY seq_in_index`,
        );
        expect(usageIdentity.map((r) => r.column_name)).toEqual(["session_id", "turn_id", "step"]);
        expect(usageIdentity.every((r) => Number(r.non_unique) === 0)).toBe(true);

        const [expiryIndex] = await conn.query<(RowDataPacket & { column_name: string })[]>(
          `SELECT COLUMN_NAME AS column_name
             FROM information_schema.statistics
            WHERE table_schema = DATABASE() AND table_name = 'idempotency_keys' AND index_name = 'idx_idempotency_expires'
            ORDER BY seq_in_index`,
        );
        expect(expiryIndex.map((r) => r.column_name)).toEqual(["expires_at_ms"]);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("fails within the configured timeout when another runner owns the migration lock", async () => {
      const blocker = await mysql.createConnection(MYSQL_URL);
      try {
        const [rows] = await blocker.query<(RowDataPacket & { acquired: number })[]>(
          "SELECT GET_LOCK(CONCAT('agent-service:migrate:', LEFT(SHA2(DATABASE(), 256), 32)), 0) AS acquired",
        );
        expect(Number(rows[0]?.acquired)).toBe(1);
        await expect(MysqlSessionStore.connect({ url: MYSQL_URL, connectionLimit: 1, migrationLockTimeoutSeconds: 0 })).rejects.toThrow(
          "timed out after 0s waiting for the MySQL schema migration lock",
        );
      } finally {
        await blocker.query("SELECT RELEASE_LOCK(CONCAT('agent-service:migrate:', LEFT(SHA2(DATABASE(), 256), 32)))").catch(() => {});
        await blocker.end();
      }
    });
  });
} else {
  describe("mysql/redis integration", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 with deploy/local/infra.sh running to enable", () => {});
  });
}
