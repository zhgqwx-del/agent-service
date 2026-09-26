import { Redis } from "ioredis";
import type { LeaseAcquireResult, LeaseConflict, LeaseStore } from "../types.js";

const ACQUIRE = `
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
if redis.call('HGET', KEYS[1], 'owner') == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2]); return 1
end
return 0
`;
const RELEASE = `
if redis.call('HGET', KEYS[1], 'owner') == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

/**
 * Redis-backed single-writer lease with a monotonic fencing token per session.
 * Keys: lease:{sid} (hash owner/addr/fence, TTL) and fence:{sid} (counter, no TTL).
 * `{sid}` hash tags keep both keys in one Cluster slot.
 */
export class RedisLeaseStore implements LeaseStore {
  private readonly redis: Redis;
  constructor(url: string, private readonly prefix = "as") {
    this.redis = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 });
    this.redis.defineCommand("leaseAcquire", { numberOfKeys: 2, lua: ACQUIRE });
    this.redis.defineCommand("leaseRenew", { numberOfKeys: 1, lua: RENEW });
    this.redis.defineCommand("leaseRelease", { numberOfKeys: 1, lua: RELEASE });
  }
  private k(sid: string) {
    return { lease: `${this.prefix}:lease:{${sid}}`, fence: `${this.prefix}:fence:{${sid}}` };
  }
  async acquire(sessionId: string, ownerId: string, ownerAddr: string, ttlMs: number): Promise<LeaseAcquireResult | LeaseConflict> {
    const { lease, fence } = this.k(sessionId);
    const r = (await (this.redis as any).leaseAcquire(lease, fence, ownerId, ownerAddr, String(ttlMs))) as [number, string, string?];
    if (r[0] === 1) return { ok: true, fence: Number(r[1]) };
    return { ok: false, ownerId: r[1], ownerAddr: r[2] || undefined };
  }
  async renew(sessionId: string, ownerId: string, ttlMs: number) {
    return ((await (this.redis as any).leaseRenew(this.k(sessionId).lease, ownerId, String(ttlMs))) as number) === 1;
  }
  async release(sessionId: string, ownerId: string) {
    await (this.redis as any).leaseRelease(this.k(sessionId).lease, ownerId);
  }
  async getOwner(sessionId: string) {
    const h = await this.redis.hgetall(this.k(sessionId).lease);
    if (!h.owner) return null;
    return { ownerId: h.owner, ownerAddr: h.addr ?? "", fence: Number(h.fence) };
  }
  async close() {
    await this.redis.quit();
  }
}
