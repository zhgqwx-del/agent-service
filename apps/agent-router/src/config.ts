import { z } from "zod";

const Env = z.object({
  ROUTER_PORT: z.coerce.number().int().default(8080),
  ROUTER_HOST: z.string().default("127.0.0.1"),
  /** comma-separated runner base urls; static for now, service discovery later */
  RUNNERS: z.string().min(1),
  /** same Redis the runners use: the router reads the ownership directory from it */
  REDIS_URL: z.string().optional(),
  HEALTH_INTERVAL_MS: z.coerce.number().int().default(5_000),
  MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(2),
  // Keep this default identical to agent-runner. If the router accepts a body the runner rejects,
  // the runner may close the upload and an ordinary client error is misreported as a 502.
  MAX_BODY_BYTES: z.coerce.number().int().positive().default(1_000_000),
  /** waiting for upstream HEADERS only; the SSE body is never subject to it */
  UPSTREAM_HEADER_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  /** enables /_router/* when set */
  ROUTER_ADMIN_TOKEN: z.string().optional(),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().nonnegative().default(10_000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});
export type RouterConfig = z.infer<typeof Env> & { runnerList: string[] };

export function loadRouterConfig(env: NodeJS.ProcessEnv = process.env): RouterConfig {
  const c = Env.parse(env);
  const runnerList = c.RUNNERS.split(",").map((s) => s.trim()).filter(Boolean);
  if (!runnerList.length) throw new Error("RUNNERS must list at least one runner base url");
  return { ...c, runnerList };
}
