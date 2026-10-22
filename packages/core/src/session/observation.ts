/** Per-runner observation resources, independent of model/turn execution limits. */
export interface SseResourceLimits {
  maxQueuedEvents: number;
  maxQueuedBytes: number;
  maxFrameBytes: number;
  maxReplayEvents: number;
  maxReplayBytes: number;
  replayTimeoutMs: number;
  writeStallMs: number;
  maxConnections: number;
  maxConnectionsPerTenant: number;
}

export const DEFAULT_SSE_LIMITS: Readonly<SseResourceLimits> = Object.freeze({
  maxQueuedEvents: 256,
  maxQueuedBytes: 4_194_304,
  maxFrameBytes: 2_097_152,
  maxReplayEvents: 10_000,
  maxReplayBytes: 33_554_432,
  replayTimeoutMs: 30_000,
  writeStallMs: 30_000,
  maxConnections: 128,
  maxConnectionsPerTenant: 32,
});

export function resolveSseLimits(partial?: Partial<SseResourceLimits>): Readonly<SseResourceLimits> {
  const result = { ...DEFAULT_SSE_LIMITS, ...partial };
  for (const key of Object.keys(DEFAULT_SSE_LIMITS) as (keyof SseResourceLimits)[]) {
    if (!Number.isSafeInteger(result[key]) || result[key] <= 0) throw new Error(`Invalid SSE resource limit: ${key}`);
  }
  if (result.maxFrameBytes > result.maxQueuedBytes) throw new Error("SSE frame limit exceeds queued bytes");
  if (result.maxConnectionsPerTenant > result.maxConnections) throw new Error("SSE tenant connection limit exceeds total connections");
  if (result.replayTimeoutMs > 2_147_483_647 || result.writeStallMs > 2_147_483_647) {
    throw new Error("SSE observation timeout exceeds the native timer range");
  }
  return Object.freeze(result);
}
