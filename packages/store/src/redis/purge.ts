import { Redis } from "ioredis";
import {
  TENANT_REDIS_PURGE_ADAPTER_PROTOCOL,
  tenantRedisPurgeMarkerSha256,
  validateTenantRedisPurgeDurableMarker,
  type TenantRedisPurgeAdapter,
  type TenantRedisPurgeAdapterResult,
  type TenantRedisPurgeDurableMarker,
} from "../tenant-redis-purge.js";
import { DEFAULT_REDIS_KEY_PREFIX, redisSessionKeys, validateRedisKeyPrefix } from "./keys.js";

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * The script performs every type/conflict check before its first write. All four keys share the
 * session hash tag, so Redis Cluster executes marker publication and deletion in one slot-atomic
 * operation. A replay returns the originally persisted existence bits, while deleting any state
 * reintroduced by a stale pre-marker writer.
 */
const PURGE_SESSION_STATE = `
local function key_type(key)
  local reply = redis.call('TYPE', key)
  return reply['ok'] or reply
end

local marker_type = key_type(KEYS[4])
local replay = 0
local lease_existed = 0
local fence_existed = 0
local stream_existed = 0

if marker_type ~= 'none' then
  if marker_type ~= 'hash' or redis.call('HLEN', KEYS[4]) ~= 6
      or redis.call('PTTL', KEYS[4]) ~= -1 then
    return {-3}
  end
  local protocol = redis.call('HGET', KEYS[4], 'protocol')
  local namespace = redis.call('HGET', KEYS[4], 'namespace_sha256')
  local operation = redis.call('HGET', KEYS[4], 'operation_sha256')
  local lease_bit = redis.call('HGET', KEYS[4], 'lease_existed')
  local fence_bit = redis.call('HGET', KEYS[4], 'fence_existed')
  local stream_bit = redis.call('HGET', KEYS[4], 'stream_existed')
  if not protocol or not namespace or not operation
      or (lease_bit ~= '0' and lease_bit ~= '1')
      or (fence_bit ~= '0' and fence_bit ~= '1')
      or (stream_bit ~= '0' and stream_bit ~= '1') then
    return {-3}
  end
  if protocol ~= ARGV[1] or namespace ~= ARGV[2] or operation ~= ARGV[3] then
    return {-2}
  end
  replay = 1
  lease_existed = tonumber(lease_bit)
  fence_existed = tonumber(fence_bit)
  stream_existed = tonumber(stream_bit)
end

local lease_type = key_type(KEYS[1])
local fence_type = key_type(KEYS[2])
local stream_type = key_type(KEYS[3])
if lease_type ~= 'none' and lease_type ~= 'hash' then return {-10} end
if fence_type ~= 'none' and fence_type ~= 'string' then return {-11} end
if stream_type ~= 'none' and stream_type ~= 'stream' then return {-12} end

if replay == 0 then
  if lease_type ~= 'none' then lease_existed = 1 end
  if fence_type ~= 'none' then fence_existed = 1 end
  if stream_type ~= 'none' then stream_existed = 1 end
  redis.call('HSET', KEYS[4],
    'protocol', ARGV[1],
    'namespace_sha256', ARGV[2],
    'operation_sha256', ARGV[3],
    'lease_existed', tostring(lease_existed),
    'fence_existed', tostring(fence_existed),
    'stream_existed', tostring(stream_existed))
end

redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
return {replay + 1, lease_existed, fence_existed, stream_existed}
`;

const INSPECT_SESSION_PURGE = `
local reply = redis.call('TYPE', KEYS[1])
local marker_type = reply['ok'] or reply
if marker_type == 'none' then return {0} end
if marker_type ~= 'hash' or redis.call('HLEN', KEYS[1]) ~= 6
    or redis.call('PTTL', KEYS[1]) ~= -1 then return {-3} end
local protocol = redis.call('HGET', KEYS[1], 'protocol')
local namespace = redis.call('HGET', KEYS[1], 'namespace_sha256')
local operation = redis.call('HGET', KEYS[1], 'operation_sha256')
local lease_bit = redis.call('HGET', KEYS[1], 'lease_existed')
local fence_bit = redis.call('HGET', KEYS[1], 'fence_existed')
local stream_bit = redis.call('HGET', KEYS[1], 'stream_existed')
if not protocol or not namespace or not operation
    or (lease_bit ~= '0' and lease_bit ~= '1')
    or (fence_bit ~= '0' and fence_bit ~= '1')
    or (stream_bit ~= '0' and stream_bit ~= '1') then
  return {-3}
end
if protocol ~= ARGV[1] or namespace ~= ARGV[2] or operation ~= ARGV[3] then return {-2} end
return {2, tonumber(lease_bit), tonumber(fence_bit), tonumber(stream_bit)}
`;

/**
 * Recovery for the marker-only saga window. Unlike PURGE_SESSION_STATE this script cannot create
 * authority: when the exact marker is absent it returns before inspecting or touching live keys.
 * When present, every validation happens before the delete so a conflict/corrupt key is fail-closed.
 */
const REPLAY_EXISTING_SESSION_PURGE = `
local function key_type(key)
  local reply = redis.call('TYPE', key)
  return reply['ok'] or reply
end

local marker_type = key_type(KEYS[4])
if marker_type == 'none' then return {0} end
if marker_type ~= 'hash' or redis.call('HLEN', KEYS[4]) ~= 6
    or redis.call('PTTL', KEYS[4]) ~= -1 then return {-3} end
local protocol = redis.call('HGET', KEYS[4], 'protocol')
local namespace = redis.call('HGET', KEYS[4], 'namespace_sha256')
local operation = redis.call('HGET', KEYS[4], 'operation_sha256')
local lease_bit = redis.call('HGET', KEYS[4], 'lease_existed')
local fence_bit = redis.call('HGET', KEYS[4], 'fence_existed')
local stream_bit = redis.call('HGET', KEYS[4], 'stream_existed')
if not protocol or not namespace or not operation
    or (lease_bit ~= '0' and lease_bit ~= '1')
    or (fence_bit ~= '0' and fence_bit ~= '1')
    or (stream_bit ~= '0' and stream_bit ~= '1') then
  return {-3}
end
if protocol ~= ARGV[1] or namespace ~= ARGV[2] or operation ~= ARGV[3] then return {-2} end

local lease_type = key_type(KEYS[1])
local fence_type = key_type(KEYS[2])
local stream_type = key_type(KEYS[3])
if lease_type ~= 'none' and lease_type ~= 'hash' then return {-10} end
if fence_type ~= 'none' and fence_type ~= 'string' then return {-11} end
if stream_type ~= 'none' and stream_type ~= 'stream' then return {-12} end

redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
return {2, tonumber(lease_bit), tonumber(fence_bit), tonumber(stream_bit)}
`;

/** Restore uses durable historical bits; it must never resample restored keys as new evidence. */
const RESTORE_SESSION_PURGE = `
local function key_type(key)
  local reply = redis.call('TYPE', key)
  return reply['ok'] or reply
end

local marker_type = key_type(KEYS[4])
local replay = 0
if marker_type ~= 'none' then
  if marker_type ~= 'hash' or redis.call('HLEN', KEYS[4]) ~= 6
      or redis.call('PTTL', KEYS[4]) ~= -1 then return {-3} end
  local protocol = redis.call('HGET', KEYS[4], 'protocol')
  local namespace = redis.call('HGET', KEYS[4], 'namespace_sha256')
  local operation = redis.call('HGET', KEYS[4], 'operation_sha256')
  local lease_bit = redis.call('HGET', KEYS[4], 'lease_existed')
  local fence_bit = redis.call('HGET', KEYS[4], 'fence_existed')
  local stream_bit = redis.call('HGET', KEYS[4], 'stream_existed')
  if not protocol or not namespace or not operation
      or (lease_bit ~= '0' and lease_bit ~= '1')
      or (fence_bit ~= '0' and fence_bit ~= '1')
      or (stream_bit ~= '0' and stream_bit ~= '1') then
    return {-3}
  end
  if protocol ~= ARGV[1] or namespace ~= ARGV[2] or operation ~= ARGV[3]
      or lease_bit ~= ARGV[4] or fence_bit ~= ARGV[5] or stream_bit ~= ARGV[6] then
    return {-2}
  end
  replay = 1
end

local lease_type = key_type(KEYS[1])
local fence_type = key_type(KEYS[2])
local stream_type = key_type(KEYS[3])
if lease_type ~= 'none' and lease_type ~= 'hash' then return {-10} end
if fence_type ~= 'none' and fence_type ~= 'string' then return {-11} end
if stream_type ~= 'none' and stream_type ~= 'stream' then return {-12} end

if replay == 0 then
  redis.call('HSET', KEYS[4],
    'protocol', ARGV[1],
    'namespace_sha256', ARGV[2],
    'operation_sha256', ARGV[3],
    'lease_existed', ARGV[4],
    'fence_existed', ARGV[5],
    'stream_existed', ARGV[6])
end
redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
return {replay + 1, tonumber(ARGV[4]), tonumber(ARGV[5]), tonumber(ARGV[6])}
`;

export class RedisSessionPurgedError extends Error {
  constructor(public readonly sessionId: string) {
    super(`Redis state for session ${sessionId} is permanently purge-fenced`);
    this.name = "RedisSessionPurgedError";
  }
}

export class RedisPurgeOperationConflictError extends Error {
  constructor(public readonly sessionId: string) {
    super(`Redis purge marker for session ${sessionId} belongs to a different operation`);
    this.name = "RedisPurgeOperationConflictError";
  }
}

export class RedisPurgeStateCorruptError extends Error {
  constructor(public readonly sessionId: string, public readonly component: string) {
    super(`Redis purge state for session ${sessionId} is corrupt (${component})`);
    this.name = "RedisPurgeStateCorruptError";
  }
}

export interface RedisSessionStatePurgeAdapterOptions {
  /** Non-secret digest of the exact logical Redis deployment/database/prefix contract. */
  namespaceSha256: string;
  prefix?: string;
}

export class RedisSessionStatePurgeAdapter implements TenantRedisPurgeAdapter {
  readonly redisNamespaceSha256: string;
  private readonly redis: Redis;
  private readonly prefix: string;
  private closed = false;

  constructor(url: string, options: RedisSessionStatePurgeAdapterOptions) {
    if (!SHA256.test(options.namespaceSha256)) {
      throw new Error("Redis purge namespace must be a lowercase SHA-256 digest");
    }
    this.redisNamespaceSha256 = options.namespaceSha256;
    this.prefix = options.prefix ?? DEFAULT_REDIS_KEY_PREFIX;
    validateRedisKeyPrefix(this.prefix);
    this.redis = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 });
    this.redis.defineCommand("purgeSessionState", {
      numberOfKeys: 4,
      lua: PURGE_SESSION_STATE,
    });
    this.redis.defineCommand("inspectSessionPurge", {
      numberOfKeys: 1,
      lua: INSPECT_SESSION_PURGE,
    });
    this.redis.defineCommand("replayExistingSessionPurge", {
      numberOfKeys: 4,
      lua: REPLAY_EXISTING_SESSION_PURGE,
    });
    this.redis.defineCommand("restoreSessionPurge", {
      numberOfKeys: 4,
      lua: RESTORE_SESSION_PURGE,
    });
  }

  async purgeSessionState(input: {
    sessionId: string;
    operationSha256: string;
  }): Promise<TenantRedisPurgeAdapterResult> {
    this.assertInput(input);
    const keys = redisSessionKeys(input.sessionId, this.prefix);
    const reply = await (this.redis as any).purgeSessionState(
      keys.lease,
      keys.fence,
      keys.stream,
      keys.purgeMarker,
      TENANT_REDIS_PURGE_ADAPTER_PROTOCOL,
      this.redisNamespaceSha256,
      input.operationSha256,
    ) as unknown;
    return this.decode(input, reply);
  }

  async inspectSessionPurge(input: {
    sessionId: string;
    operationSha256: string;
  }): Promise<TenantRedisPurgeAdapterResult | null> {
    this.assertInput(input);
    const keys = redisSessionKeys(input.sessionId, this.prefix);
    const reply = await (this.redis as any).inspectSessionPurge(
      keys.purgeMarker,
      TENANT_REDIS_PURGE_ADAPTER_PROTOCOL,
      this.redisNamespaceSha256,
      input.operationSha256,
    ) as unknown;
    if (Array.isArray(reply) && Number(reply[0]) === 0) return null;
    return this.decode(input, reply);
  }

  async replayExistingSessionPurge(input: {
    sessionId: string;
    operationSha256: string;
  }): Promise<TenantRedisPurgeAdapterResult | null> {
    this.assertInput(input);
    const keys = redisSessionKeys(input.sessionId, this.prefix);
    const reply = await (this.redis as any).replayExistingSessionPurge(
      keys.lease,
      keys.fence,
      keys.stream,
      keys.purgeMarker,
      TENANT_REDIS_PURGE_ADAPTER_PROTOCOL,
      this.redisNamespaceSha256,
      input.operationSha256,
    ) as unknown;
    if (Array.isArray(reply) && Number(reply[0]) === 0) return null;
    return this.decode(input, reply);
  }

  async restoreSessionPurgeFence(
    marker: TenantRedisPurgeDurableMarker,
  ): Promise<TenantRedisPurgeAdapterResult> {
    if (this.closed) throw new Error("Redis purge adapter is closed");
    validateTenantRedisPurgeDurableMarker(marker);
    if (marker.redisNamespaceSha256 !== this.redisNamespaceSha256) {
      throw new RedisPurgeOperationConflictError(marker.sessionId);
    }
    const keys = redisSessionKeys(marker.sessionId, this.prefix);
    const reply = await (this.redis as any).restoreSessionPurge(
      keys.lease,
      keys.fence,
      keys.stream,
      keys.purgeMarker,
      marker.adapterProtocol,
      marker.redisNamespaceSha256,
      marker.operationSha256,
      marker.leaseExisted ? "1" : "0",
      marker.fenceExisted ? "1" : "0",
      marker.streamExisted ? "1" : "0",
    ) as unknown;
    const result = this.decode(marker, reply);
    if (result.markerSha256 !== marker.markerSha256) {
      throw new RedisPurgeStateCorruptError(marker.sessionId, "restored marker digest");
    }
    return result;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.redis.quit();
  }

  private assertInput(input: { sessionId: string; operationSha256: string }): void {
    if (this.closed) throw new Error("Redis purge adapter is closed");
    redisSessionKeys(input.sessionId, this.prefix);
    if (!SHA256.test(input.operationSha256)) {
      throw new Error("Redis purge operation must be a lowercase SHA-256 digest");
    }
  }

  private decode(
    input: { sessionId: string; operationSha256: string },
    value: unknown,
  ): TenantRedisPurgeAdapterResult {
    if (!Array.isArray(value) || value.length < 1) {
      throw new RedisPurgeStateCorruptError(input.sessionId, "invalid adapter reply");
    }
    const code = Number(value[0]);
    if (code === -2) throw new RedisPurgeOperationConflictError(input.sessionId);
    if (code === -3) throw new RedisPurgeStateCorruptError(input.sessionId, "purge marker");
    if (code === -10) throw new RedisPurgeStateCorruptError(input.sessionId, "lease key type");
    if (code === -11) throw new RedisPurgeStateCorruptError(input.sessionId, "fence key type");
    if (code === -12) throw new RedisPurgeStateCorruptError(input.sessionId, "stream key type");
    if ((code !== 1 && code !== 2) || value.length !== 4) {
      throw new RedisPurgeStateCorruptError(input.sessionId, "invalid adapter reply");
    }
    const bits = value.slice(1).map(Number);
    if (bits.some((bit) => bit !== 0 && bit !== 1)) {
      throw new RedisPurgeStateCorruptError(input.sessionId, "invalid marker bits");
    }
    const evidence = {
      adapterProtocol: TENANT_REDIS_PURGE_ADAPTER_PROTOCOL,
      redisNamespaceSha256: this.redisNamespaceSha256,
      sessionId: input.sessionId,
      operationSha256: input.operationSha256,
      leaseExisted: bits[0] === 1,
      fenceExisted: bits[1] === 1,
      streamExisted: bits[2] === 1,
    };
    return {
      ...evidence,
      markerSha256: tenantRedisPurgeMarkerSha256(evidence),
      replayed: code === 2,
    };
  }
}
