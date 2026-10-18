import { createHash } from "node:crypto";
import { z } from "zod";

const Allowed = new Set([
  "SUBAGENTS_ENABLED", "SUBAGENTS_MAX_DEPTH", "SUBAGENTS_MAX_CONCURRENT", "SUBAGENTS_MAX_TASKS",
]);
const Config = z.object({
  SUBAGENTS_ENABLED: z.enum(["0", "1"]).default("0"),
  SUBAGENTS_MAX_DEPTH: z.string().regex(/^[1-9][0-9]*$/).default("3"),
  SUBAGENTS_MAX_CONCURRENT: z.string().regex(/^[1-9][0-9]*$/).default("2"),
  SUBAGENTS_MAX_TASKS: z.string().regex(/^[1-9][0-9]*$/).default("8"),
});

export interface SubagentsRuntimeConfig {
  readonly enabled: boolean;
  readonly maxDepth: number;
  readonly maxConcurrent: number;
  readonly maxTasks: number;
  /** Public immutable configuration identity, not an execution capability or a credential. */
  readonly configSha256: string;
}

/** Pure explicit-env parser. It neither loads .env nor constructs stores, model clients or tasks. */
export function loadSubagentsConfig(env: NodeJS.ProcessEnv): Readonly<SubagentsRuntimeConfig> {
  try {
    if (Object.keys(env).some(key => key.startsWith("SUBAGENTS_") && !Allowed.has(key))) throw new Error();
    const parsed = Config.parse(env);
    const maxDepth = Number(parsed.SUBAGENTS_MAX_DEPTH);
    const maxConcurrent = Number(parsed.SUBAGENTS_MAX_CONCURRENT);
    const maxTasks = Number(parsed.SUBAGENTS_MAX_TASKS);
    if (!Number.isSafeInteger(maxDepth) || maxDepth > 8
      || !Number.isSafeInteger(maxConcurrent) || maxConcurrent > 8
      || !Number.isSafeInteger(maxTasks) || maxTasks > 64) throw new Error();
    const value = { enabled: parsed.SUBAGENTS_ENABLED === "1", maxDepth, maxConcurrent, maxTasks };
    const configSha256 = createHash("sha256").update("root-lease-subagents-config-v1\0")
      .update(JSON.stringify(value)).digest("hex");
    return Object.freeze({ ...value, configSha256 });
  } catch {
    throw new Error("Invalid subagents runtime configuration");
  }
}
