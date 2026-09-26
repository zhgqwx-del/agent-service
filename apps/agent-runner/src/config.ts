import { randomUUID } from "node:crypto";
import { z } from "zod";

const Env = z.object({
  RUNNER_PORT: z.coerce.number().int().default(8787),
  RUNNER_HOST: z.string().default("127.0.0.1"),
  /** Must be unique among simultaneously running replicas. Production gets a UUID when omitted. */
  RUNNER_ID: z.string().trim().min(1).optional(),
  /** address other runners/router use to reach this runner */
  RUNNER_ADDR: z.string().trim().min(1).optional(),
  STORE: z.enum(["memory", "mysql"]).default("memory"),
  MYSQL_URL: z.string().default("mysql://root@127.0.0.1:3306/agent_service"),
  REDIS_URL: z.string().optional(),
  BLOB_DIR: z.string().default("./.data/blobs"),
  /** 32-byte hex key that encrypts BYOK secrets at rest. No default: a silent all-zero key is worse than a crash. */
  SECRETS_MASTER_KEY: z.string().regex(/^[0-9a-f]{64}$/i, "SECRETS_MASTER_KEY must be 64 hex chars (32 bytes)"),
  /** Dev convenience: seeds a tenant + api key on boot. Refused when NODE_ENV=production. */
  BOOTSTRAP_API_KEY: z.string().optional(),
  BOOTSTRAP_TENANT_ID: z.string().default("t_dev"),
  /** mint the first admin key for this tenant if it has none; subsequent boots do not mint another */
  ADMIN_BOOTSTRAP_TENANT: z.string().optional(),
  NODE_ENV: z.string().optional(),
  MAX_BODY_BYTES: z.coerce.number().int().positive().default(1_000_000),
  /** platform provider preset enabled for all tenants, keyed from API_KEY */
  PLATFORM_PROVIDER: z.string().default("dashscope"),
  API_KEY: z.string().optional(),
  API_BASE_URL: z.string().optional(),
  DEFAULT_MODEL: z.string().optional(),
  LEASE_TTL_MS: z.coerce.number().int().default(30_000),
  LEASE_HOLD_MS: z.coerce.number().int().default(60_000),
  APPROVAL_TTL_MS: z.coerce.number().int().default(10 * 60_000),
  SSE_HEARTBEAT_MS: z.coerce.number().int().default(10_000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});
type ParsedConfig = z.infer<typeof Env>;
export type RunnerConfig = Omit<ParsedConfig, "RUNNER_ID"> & { RUNNER_ID: string; runnerAddr: string };

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

function validateAdvertisedAddress(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.includes("://") ? value : `http://${value}`);
  } catch {
    throw new Error("RUNNER_ADDR must be a routable host[:port] or http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("RUNNER_ADDR must use http or https when a URL scheme is present");
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!host || WILDCARD_HOSTS.has(host)) {
    throw new Error("RUNNER_ADDR must advertise a routable host, not a wildcard bind address");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== "/")) {
    throw new Error("RUNNER_ADDR must not contain credentials, a path, query parameters, or a fragment");
  }
  return value.replace(/\/+$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const c = Env.parse(env);
  const production = c.NODE_ENV === "production";
  if (production && c.BOOTSTRAP_API_KEY) {
    throw new Error("BOOTSTRAP_API_KEY must not be set when NODE_ENV=production: seed tenants through an admin path instead");
  }
  if (production && c.STORE === "memory") throw new Error("STORE=memory loses all state on restart; set STORE=mysql in production");
  if (production && !c.REDIS_URL) throw new Error("REDIS_URL is required in production: leases and event fan-out depend on it");
  if (production && !c.RUNNER_ADDR) {
    throw new Error("RUNNER_ADDR is required in production and must be reachable by the router and peer runners");
  }
  if (!c.RUNNER_ADDR && WILDCARD_HOSTS.has(c.RUNNER_HOST)) {
    throw new Error("RUNNER_ADDR is required when RUNNER_HOST is a wildcard bind address");
  }
  const runnerAddr = validateAdvertisedAddress(c.RUNNER_ADDR ?? `${c.RUNNER_HOST}:${c.RUNNER_PORT}`);
  const runnerId = c.RUNNER_ID ?? (production ? `runner-${randomUUID()}` : `runner-${process.pid}`);
  return { ...c, RUNNER_ID: runnerId, runnerAddr };
}
