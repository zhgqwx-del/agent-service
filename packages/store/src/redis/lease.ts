import { Redis } from "ioredis";
import type { LeaseAcquireResult, LeaseConflict, LeaseStore } from "../types.js";
import { RedisSessionPurgedError } from "./purge.js";
import { DEFAULT_REDIS_KEY_PREFIX, redisSessionKeys, validateRedisKeyPrefix } from "./keys.js";

const ACQUIRE = `
if redis.call('EXISTS', KEYS[3]) == 1 then return {-1} end
local owner = redis.call('HGET', KEYS[1], 'owner')
if owner and owner ~= ARGV[1] then
  return {0, owner, redis.call('HGET', KEYS[1], 'addr') or ''}
end
if owner == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
  return {1, redis.call('HGET', KEYS[1], 'fence')}
end
local fence = redis.call('INCR', KEYS[2])
redis.call('HSET', KEYS[1], 'owner', ARGV[1], 'addr', ARGV[2], 'fence', fence)
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return {1, tostring(fence)}
`;
const RENEW = `
if redis.call('EXISTS', KEYS[2]) == 1 then return -1 end
if redis.call('HGET', KEYS[1], 'owner') == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2]); return 1
end
return 0
`;
const RELEASE = `
if redis.call('HGET', KEYS[1], 'owner') == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;
const GET_OWNER = `
if redis.call('EXISTS', KEYS[2]) == 1 then return {-1} end
local owner = redis.call('HGET', KEYS[1], 'owner')
if not owner then return {0} end
return {1, owner, redis.call('HGET', KEYS[1], 'addr') or '', redis.call('HGET', KEYS[1], 'fence') or ''}
`;

/**
 * Redis-backed single-writer lease with a monotonic fencing token per session.
 * Keys: lease:{sid} (hash owner/addr/fence, TTL) and fence:{sid} (counter, no TTL).
 * `{sid}` hash tags keep both keys and the permanent purge marker in one Cluster slot. Once that
 * marker exists, acquire is rejected and renew/owner lookup fail closed so deleting the counter can
 * never reset fencing authority.
 */
export class RedisLeaseStore implements LeaseStore {
  private readonly redis: Redis;
  constructor(url: string, private readonly prefix: string = DEFAULT_REDIS_KEY_PREFIX) {
    validateRedisKeyPrefix(prefix);
    this.redis = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 });
    this.redis.defineCommand("leaseAcquire", { numberOfKeys: 3, lua: ACQUIRE });
    this.redis.defineCommand("leaseRenew", { numberOfKeys: 2, lua: RENEW });
    this.redis.defineCommand("leaseRelease", { numberOfKeys: 1, lua: RELEASE });
    this.redis.defineCommand("leaseGetOwner", { numberOfKeys: 2, lua: GET_OWNER });
  }
  async acquire(sessionId: string, ownerId: string, ownerAddr: string, ttlMs: number): Promise<LeaseAcquireResult | LeaseConflict> {
    const { lease, fence, purgeMarker } = redisSessionKeys(sessionId, this.prefix);
    const r = (await (this.redis as any).leaseAcquire(
      lease,
      fence,
      purgeMarker,
      ownerId,
      ownerAddr,
      String(ttlMs),
    )) as [number, string?, string?];
    if (Number(r[0]) === -1) throw new RedisSessionPurgedError(sessionId);
    if (r[0] === 1) return { ok: true, fence: Number(r[1]) };
    return { ok: false, ownerId: r[1]!, ownerAddr: r[2] || undefined };
  }
  async renew(sessionId: string, ownerId: string, ttlMs: number) {
    const { lease, purgeMarker } = redisSessionKeys(sessionId, this.prefix);
    return ((await (this.redis as any).leaseRenew(
      lease,
      purgeMarker,
      ownerId,
      String(ttlMs),
    )) as number) === 1;
  }
  async release(sessionId: string, ownerId: string) {
    await (this.redis as any).leaseRelease(redisSessionKeys(sessionId, this.prefix).lease, ownerId);
  }
  async getOwner(sessionId: string) {
    const { lease, purgeMarker } = redisSessionKeys(sessionId, this.prefix);
    const result = await (this.redis as any).leaseGetOwner(lease, purgeMarker) as unknown;
    if (!Array.isArray(result) || Number(result[0]) !== 1) return null;
    const fence = Number(result[3]);
    if (!Number.isSafeInteger(fence) || fence < 1) return null;
    return { ownerId: String(result[1]), ownerAddr: String(result[2]), fence };
  }
  async close() {
    await this.redis.quit();
  }
}
