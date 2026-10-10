import { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import {
  RedisEventBus,
  RedisLeaseStore,
  RedisPurgeOperationConflictError,
  RedisPurgeStateCorruptError,
  RedisSessionPurgedError,
  RedisSessionStatePurgeAdapter,
  redisSessionKeys,
  tenantRedisPurgeMarkerSha256,
} from "../src/index.js";
import { newId } from "./conformance.js";

const REDIS_URL = process.env.REDIS_TEST_URL ?? "redis://127.0.0.1:6379/1";
const integration = Boolean(process.env.AGENT_SERVICE_INTEGRATION);

describe.skipIf(!integration)("Redis tenant purge adapter", () => {
  it("atomically deletes one slot, persists the first proof, and replays it exactly", async () => {
    const prefix = `test-purge-${newId("prefix")}`;
    const sessionId = newId("sess");
    const namespaceSha256 = "a".repeat(64);
    const operationSha256 = "b".repeat(64);
    const keys = redisSessionKeys(sessionId, prefix);
    const redis = new Redis(REDIS_URL);
    const adapter = new RedisSessionStatePurgeAdapter(REDIS_URL, {
      prefix,
      namespaceSha256,
    });
    try {
      expect(Object.values(keys).every((key) => key.includes(`{${sessionId}}`))).toBe(true);
      await redis.hset(keys.lease, "owner", "runner-a", "addr", "http://runner-a", "fence", "7");
      await redis.set(keys.fence, "7");
      await redis.xadd(keys.stream, "*", "seq", "1", "e", "content-free-test-event");

      const first = await adapter.purgeSessionState({ sessionId, operationSha256 });
      expect(first).toMatchObject({
        redisNamespaceSha256: namespaceSha256,
        operationSha256,
        leaseExisted: true,
        fenceExisted: true,
        streamExisted: true,
        replayed: false,
      });
      expect(await redis.exists(keys.lease, keys.fence, keys.stream)).toBe(0);
      expect(await redis.type(keys.purgeMarker)).toBe("hash");
      expect(await redis.pttl(keys.purgeMarker)).toBe(-1);

      // Simulate restored/stale live state after the marker. Existing-only replay must clean all
      // three domains atomically without changing the first proof or requiring new authority.
      await redis.hset(keys.lease, "owner", "stale", "addr", "stale", "fence", "1");
      await redis.set(keys.fence, "1");
      await redis.xadd(keys.stream, "*", "seq", "2", "e", "stale");
      const replay = await adapter.replayExistingSessionPurge({ sessionId, operationSha256 });
      expect(replay).toEqual({ ...first, replayed: true });
      expect(await redis.exists(keys.lease, keys.fence, keys.stream)).toBe(0);
      expect(await adapter.inspectSessionPurge({ sessionId, operationSha256 })).toEqual(replay);

      await redis.set(keys.fence, "must-survive-conflicting-replay");
      await expect(adapter.replayExistingSessionPurge({
        sessionId,
        operationSha256: "c".repeat(64),
      })).rejects.toBeInstanceOf(RedisPurgeOperationConflictError);
      expect(await redis.get(keys.fence)).toBe("must-survive-conflicting-replay");

      // A Redis restore can lose the marker and resurrect a different subset of keys. Reapply the
      // durable proof verbatim; current key existence must not replace the historical first bits.
      await redis.del(keys.purgeMarker);
      await redis.set(keys.fence, "99");
      await expect(adapter.replayExistingSessionPurge({ sessionId, operationSha256 }))
        .resolves.toBeNull();
      expect(await redis.get(keys.fence)).toBe("99");
      expect(await redis.exists(keys.purgeMarker)).toBe(0);
      const { replayed: _replayed, ...durableMarker } = first;
      const restored = await adapter.restoreSessionPurgeFence(durableMarker);
      expect(restored).toEqual(first);
      expect(await redis.exists(keys.lease, keys.fence, keys.stream)).toBe(0);
      await expect(adapter.inspectSessionPurge({ sessionId, operationSha256 }))
        .resolves.toEqual({ ...first, replayed: true });

      const { markerSha256: _markerSha256, ...originalEvidence } = durableMarker;
      const conflictingBits = {
        ...originalEvidence,
        streamExisted: false,
      };
      const conflictingEvidence = {
        ...conflictingBits,
        markerSha256: tenantRedisPurgeMarkerSha256(conflictingBits),
      };
      await expect(adapter.restoreSessionPurgeFence(conflictingEvidence))
        .rejects.toBeInstanceOf(RedisPurgeOperationConflictError);

      await redis.pexpire(keys.purgeMarker, 60_000);
      await expect(adapter.replayExistingSessionPurge({ sessionId, operationSha256 }))
        .rejects.toBeInstanceOf(RedisPurgeStateCorruptError);
      await expect(adapter.inspectSessionPurge({ sessionId, operationSha256 }))
        .rejects.toBeInstanceOf(RedisPurgeStateCorruptError);
      await redis.persist(keys.purgeMarker);

      await expect(adapter.purgeSessionState({
        sessionId,
        operationSha256: "c".repeat(64),
      })).rejects.toBeInstanceOf(RedisPurgeOperationConflictError);
    } finally {
      await redis.del(keys.lease, keys.fence, keys.stream, keys.purgeMarker);
      await adapter.close();
      await redis.quit();
    }
  });

  it("binds the marker to its namespace and rejects malformed or wrong-type state before writing", async () => {
    const prefix = `test-purge-preflight-${newId("prefix")}`;
    const firstSessionId = newId("sess");
    const secondSessionId = newId("sess");
    const firstKeys = redisSessionKeys(firstSessionId, prefix);
    const secondKeys = redisSessionKeys(secondSessionId, prefix);
    const operationSha256 = "d".repeat(64);
    const redis = new Redis(REDIS_URL);
    const first = new RedisSessionStatePurgeAdapter(REDIS_URL, {
      prefix,
      namespaceSha256: "e".repeat(64),
    });
    const otherNamespace = new RedisSessionStatePurgeAdapter(REDIS_URL, {
      prefix,
      namespaceSha256: "f".repeat(64),
    });
    try {
      const firstResult = await first.purgeSessionState({
        sessionId: firstSessionId,
        operationSha256,
      });
      await expect(otherNamespace.purgeSessionState({
        sessionId: firstSessionId,
        operationSha256,
      })).rejects.toBeInstanceOf(RedisPurgeOperationConflictError);

      const { replayed: _replayed, ...durableMarker } = firstResult;
      await redis.del(firstKeys.purgeMarker);
      await redis.set(firstKeys.lease, "restored-wrong-type");
      await expect(first.restoreSessionPurgeFence(durableMarker))
        .rejects.toBeInstanceOf(RedisPurgeStateCorruptError);
      expect(await redis.get(firstKeys.lease)).toBe("restored-wrong-type");
      expect(await redis.exists(firstKeys.purgeMarker)).toBe(0);

      await redis.set(secondKeys.lease, "wrong-type-but-must-survive");
      await redis.set(secondKeys.fence, "9");
      await expect(first.purgeSessionState({
        sessionId: secondSessionId,
        operationSha256,
      })).rejects.toBeInstanceOf(RedisPurgeStateCorruptError);
      expect(await redis.get(secondKeys.lease)).toBe("wrong-type-but-must-survive");
      expect(await redis.get(secondKeys.fence)).toBe("9");
      expect(await redis.exists(secondKeys.purgeMarker)).toBe(0);

      await redis.del(secondKeys.lease);
      await redis.set(secondKeys.purgeMarker, "wrong-marker-type");
      await expect(first.purgeSessionState({
        sessionId: secondSessionId,
        operationSha256,
      })).rejects.toBeInstanceOf(RedisPurgeStateCorruptError);
      expect(await redis.get(secondKeys.fence)).toBe("9");

      await redis.del(secondKeys.purgeMarker);
      await redis.hset(secondKeys.purgeMarker, "operation_sha256", operationSha256);
      await expect(first.purgeSessionState({
        sessionId: secondSessionId,
        operationSha256,
      })).rejects.toBeInstanceOf(RedisPurgeStateCorruptError);
      expect(await redis.get(secondKeys.fence)).toBe("9");
    } finally {
      await redis.del(...Object.values(firstKeys), ...Object.values(secondKeys));
      await first.close();
      await otherNamespace.close();
      await redis.quit();
    }
  });

  it("serializes competing operations and isolates the same session id across prefixes", async () => {
    const prefixA = `race-a-${newId("p")}`;
    const prefixB = `race-b-${newId("p")}`;
    const sessionId = newId("sess");
    const conflictSessionId = newId("sess");
    const racingSessionId = newId("sess");
    const keysA = redisSessionKeys(sessionId, prefixA);
    const conflictKeysA = redisSessionKeys(conflictSessionId, prefixA);
    const racingKeysA = redisSessionKeys(racingSessionId, prefixA);
    const keysB = redisSessionKeys(sessionId, prefixB);
    const redis = new Redis(REDIS_URL);
    const adapter = new RedisSessionStatePurgeAdapter(REDIS_URL, {
      prefix: prefixA,
      namespaceSha256: "3".repeat(64),
    });
    const leaseA = new RedisLeaseStore(REDIS_URL, prefixA);
    const leaseB = new RedisLeaseStore(REDIS_URL, prefixB);
    try {
      await redis.hset(keysA.lease, "owner", "runner-a", "addr", "a", "fence", "4");
      await redis.set(keysA.fence, "4");
      const operationSha256 = "4".repeat(64);
      const sameOperation = await Promise.all([
        adapter.purgeSessionState({ sessionId, operationSha256 }),
        adapter.purgeSessionState({ sessionId, operationSha256 }),
      ]);
      expect(sameOperation.map((result) => result.replayed).sort()).toEqual([false, true]);
      expect({ ...sameOperation[0], replayed: false })
        .toEqual({ ...sameOperation[1], replayed: false });

      const conflict = await Promise.allSettled([
        adapter.purgeSessionState({
          sessionId: conflictSessionId,
          operationSha256: "5".repeat(64),
        }),
        adapter.purgeSessionState({
          sessionId: conflictSessionId,
          operationSha256: "6".repeat(64),
        }),
      ]);
      expect(conflict.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(conflict.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(conflict.find((result) => result.status === "rejected")!.reason)
        .toBeInstanceOf(RedisPurgeOperationConflictError);
      expect(await redis.exists(conflictKeysA.purgeMarker)).toBe(1);

      // A different controlled prefix is a different key namespace; A's marker cannot suppress B.
      await expect(leaseB.acquire(sessionId, "runner-b", "b", 60_000))
        .resolves.toMatchObject({ ok: true });
      expect(await redis.exists(keysB.lease, keysB.fence)).toBe(2);
      expect(await redis.exists(keysA.lease, keysA.fence, keysA.stream)).toBe(0);

      // Purge and acquire are both one-slot scripts. Whichever wins first, no live lease survives.
      const race = await Promise.allSettled([
        adapter.purgeSessionState({
          sessionId: racingSessionId,
          operationSha256: "7".repeat(64),
        }),
        leaseA.acquire(racingSessionId, "runner-race", "race", 60_000),
      ]);
      expect(race[0]!.status).toBe("fulfilled");
      if (race[1]!.status === "rejected") {
        expect(race[1]!.reason).toBeInstanceOf(RedisSessionPurgedError);
      }
      expect(await redis.exists(
        racingKeysA.lease,
        racingKeysA.fence,
        racingKeysA.stream,
      )).toBe(0);
      expect(await redis.exists(racingKeysA.purgeMarker)).toBe(1);
    } finally {
      await redis.del(
        ...Object.values(keysA),
        ...Object.values(conflictKeysA),
        ...Object.values(racingKeysA),
        ...Object.values(keysB),
      );
      await adapter.close();
      await leaseA.close();
      await leaseB.close();
      await redis.quit();
    }
  });

  it("prevents lease and persisted or live event resurrection after the marker is installed", async () => {
    const prefix = `test-purge-runtime-${newId("prefix")}`;
    const sessionId = newId("sess");
    const keys = redisSessionKeys(sessionId, prefix);
    const redis = new Redis(REDIS_URL);
    const lease = new RedisLeaseStore(REDIS_URL, prefix);
    const bus = new RedisEventBus(REDIS_URL, { prefix });
    const adapter = new RedisSessionStatePurgeAdapter(REDIS_URL, {
      prefix,
      namespaceSha256: "1".repeat(64),
    });
    try {
      await expect(lease.acquire(sessionId, "runner-a", "http://runner-a", 60_000))
        .resolves.toMatchObject({ ok: true });
      await bus.publish(sessionId, {
        type: "session/created",
        sessionId,
        seq: 1,
        emittedAtMs: 1,
      });
      const result = await adapter.purgeSessionState({
        sessionId,
        operationSha256: "2".repeat(64),
      });
      expect(result).toMatchObject({ leaseExisted: true, fenceExisted: true, streamExisted: true });

      await expect(lease.acquire(sessionId, "runner-b", "http://runner-b", 60_000))
        .rejects.toBeInstanceOf(RedisSessionPurgedError);
      await expect(lease.renew(sessionId, "runner-a", 60_000)).resolves.toBe(false);
      await expect(lease.getOwner(sessionId)).resolves.toBeNull();
      await expect(bus.publish(sessionId, {
        type: "session/created",
        sessionId,
        seq: 2,
        emittedAtMs: 2,
      })).rejects.toBeInstanceOf(RedisSessionPurgedError);
      await expect(bus.publish(sessionId, {
        type: "heartbeat",
        sessionId,
        emittedAtMs: 3,
      })).rejects.toBeInstanceOf(RedisSessionPurgedError);
      expect(await redis.exists(keys.lease, keys.fence, keys.stream)).toBe(0);
    } finally {
      await redis.del(...Object.values(keys));
      await adapter.close();
      await bus.close();
      await lease.close();
      await redis.quit();
    }
  });
});
