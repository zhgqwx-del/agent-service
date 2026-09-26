import { z } from "zod";

/** ids are `<prefix>_<uuidv7>`; time-ordered so they double as pagination cursors and shard-friendly keys. */
export const IdPrefix = {
  tenant: "t",
  user: "u",
  agent: "agt",
  session: "sess",
  turn: "turn",
  item: "item",
  approval: "apr",
  provider: "prov",
  mcpServer: "mcp",
  skill: "skl",
  apiKey: "key",
} as const;
export type IdPrefix = (typeof IdPrefix)[keyof typeof IdPrefix];

/**
 * Ids are compared byte-for-byte by Redis but were compared case-insensitively by MySQL's default
 * collation. Any id arriving from a client is therefore checked against the canonical form before it
 * reaches either store: a case variant must not be able to find a row while taking a different lease.
 */
export const isCanonicalId = (prefix: IdPrefix, value: string): boolean =>
  new RegExp(`^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).test(value);

export const idSchema = (prefix: IdPrefix) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`), {
    message: `expected ${prefix}_<uuidv7>`,
  });

/** Free-form ids supplied by the caller (tenant ids, user ids, tool names). */
export const externalId = z.string().min(1).max(128);

export const Principal = z.object({
  tenantId: externalId,
  userId: externalId,
});
export type Principal = z.infer<typeof Principal>;

export const Usage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  cacheWriteTokens: z.number().int().nonnegative().default(0),
  reasoningTokens: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative(),
  /** Cost in CNY according to the provider config's price table; undefined when unknown. */
  costCNY: z.number().nonnegative().optional(),
});
export type Usage = z.infer<typeof Usage>;

export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
});

export const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  totalTokens: a.totalTokens + b.totalTokens,
  costCNY: a.costCNY === undefined && b.costCNY === undefined ? undefined : (a.costCNY ?? 0) + (b.costCNY ?? 0),
});

/** Kernel safety valves. Effective value = min(config, agent, request): policy can only tighten. */
export const Limits = z.object({
  maxSteps: z.number().int().positive().optional(),
  maxToolCalls: z.number().int().positive().optional(),
  maxWallClockMs: z.number().int().positive().optional(),
  maxCostCNY: z.number().positive().optional(),
  maxOutputTokensPerStep: z.number().int().positive().optional(),
});
export type Limits = z.infer<typeof Limits>;

export const mergeLimits = (...layers: (Limits | undefined)[]): Required<Limits> => {
  const min = (k: keyof Limits, fallback: number) => {
    const vals = layers.map((l) => l?.[k]).filter((v): v is number => typeof v === "number");
    return vals.length ? Math.min(...vals) : fallback;
  };
  return {
    maxSteps: min("maxSteps", 20),
    maxToolCalls: min("maxToolCalls", 50),
    maxWallClockMs: min("maxWallClockMs", 5 * 60_000),
    maxCostCNY: min("maxCostCNY", 10),
    maxOutputTokensPerStep: min("maxOutputTokensPerStep", 8192),
  };
};

export const StopReason = z.enum([
  "end_turn",
  "max_steps",
  "max_tool_calls",
  "max_cost",
  "max_wall_clock",
  "max_output_tokens",
  "interrupted",
  "error",
]);
export type StopReason = z.infer<typeof StopReason>;

export const Pagination = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  sortDirection: z.enum(["asc", "desc"]).default("desc"),
});
export type Pagination = z.infer<typeof Pagination>;

export const page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ data: z.array(item), nextCursor: z.string().nullable() });

export const UsageQuery = z.object({
  userId: externalId.optional(),
  sessionId: z.string().optional(),
  /** epoch ms, inclusive */
  from: z.coerce.number().int().optional(),
  /** epoch ms, exclusive */
  to: z.coerce.number().int().optional(),
  groupBy: z.enum(["total", "user", "session", "model", "day"]).default("total"),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});
export type UsageQuery = z.infer<typeof UsageQuery>;

export const UsageRollup = z.object({
  key: z.string(),
  turns: z.number().int(),
  steps: z.number().int(),
  usage: Usage,
});
export type UsageRollup = z.infer<typeof UsageRollup>;
