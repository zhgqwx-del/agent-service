import { isCanonicalId } from "@agent-service/protocol";

export const DEFAULT_REDIS_KEY_PREFIX = "as" as const;

const REDIS_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export interface RedisSessionKeys {
  lease: string;
  fence: string;
  stream: string;
  eventChannel: string;
  purgeMarker: string;
}

export function validateRedisKeyPrefix(prefix: string): void {
  if (!REDIS_PREFIX.test(prefix) || prefix.includes("{") || prefix.includes("}")) {
    throw new Error("invalid Redis key prefix");
  }
}

/**
 * Every durable key for a session deliberately shares the same Redis Cluster hash tag. This lets
 * the purge adapter fence the session and delete all of its live state in one atomic Lua script.
 */
export function redisSessionKeys(
  sessionId: string,
  prefix: string = DEFAULT_REDIS_KEY_PREFIX,
): RedisSessionKeys {
  validateRedisKeyPrefix(prefix);
  if (!isCanonicalId("sess", sessionId)) throw new Error("invalid Redis session id");
  const tag = `{${sessionId}}`;
  return {
    lease: `${prefix}:lease:${tag}`,
    fence: `${prefix}:fence:${tag}`,
    stream: `${prefix}:stream:${tag}`,
    eventChannel: `${prefix}:evt:${tag}`,
    purgeMarker: `${prefix}:purge:${tag}`,
  };
}
