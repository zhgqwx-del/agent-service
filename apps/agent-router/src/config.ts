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
  /** Must match every runner; never forwarded from an external request. */
  INTERNAL_ROUTER_TOKEN: z.string().regex(/^[A-Za-z0-9._~-]{32,256}$/).optional(),
  /** Explicit expand→activate gate. Keep 0 while any legacy router/runner can receive DELETE. */
  SESSION_TOMBSTONE_ENABLED: z.enum(["0", "1"]).default("0").transform((value) => value === "1"),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().nonnegative().default(10_000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  NODE_ENV: z.string().optional(),
});
export type RouterConfig = Omit<z.infer<typeof Env>, "INTERNAL_ROUTER_TOKEN"> & { runnerList: string[]; INTERNAL_ROUTER_TOKEN: string };

const LOCAL_INTERNAL_ROUTER_TOKEN = "agent-service-local-router-token-v1";

function validateRunnerUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("RUNNERS entries must be absolute http(s) base URLs");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("RUNNERS entries must be absolute http(s) base URLs");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== "/")) {
    throw new Error("RUNNERS entries must not contain credentials, a path, query parameters, or a fragment");
  }
  return value.replace(/\/+$/, "");
}

export function loadRouterConfig(env: NodeJS.ProcessEnv = process.env): RouterConfig {
  const c = Env.parse(env);
  const runnerList = [...new Set(c.RUNNERS.split(",").map((s) => s.trim()).filter(Boolean).map(validateRunnerUrl))];
  if (!runnerList.length) throw new Error("RUNNERS must list at least one runner base url");
  if (c.NODE_ENV === "production" && !c.INTERNAL_ROUTER_TOKEN) {
    throw new Error("INTERNAL_ROUTER_TOKEN is required in production");
  }
  return { ...c, INTERNAL_ROUTER_TOKEN: c.INTERNAL_ROUTER_TOKEN ?? LOCAL_INTERNAL_ROUTER_TOKEN, runnerList };
}
