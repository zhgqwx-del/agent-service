import { randomUUID } from "node:crypto";
import { z } from "zod";

/** Transport must remain open after the Host's bounded abort window to receive its final 409/204. */
export const ERASURE_REQUEST_TIMEOUT_MARGIN_MS = 1_000;

const Env = z.object({
  RUNNER_PORT: z.coerce.number().int().default(8787),
  RUNNER_HOST: z.string().default("127.0.0.1"),
  /** Must be unique among simultaneously running replicas. Production gets a UUID when omitted. */
  RUNNER_ID: z.string().trim().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(),
  /** address other runners/router use to reach this runner */
  RUNNER_ADDR: z.string().trim().min(1).optional(),
  STORE: z.enum(["memory", "mysql"]).default("memory"),
  MYSQL_URL: z.string().default("mysql://root@127.0.0.1:3306/agent_service"),
  REDIS_URL: z.string().optional(),
  BLOB_DIR: z.string().default("./.data/blobs"),
  /**
   * Explicit acknowledgement that this process is the only runner using BLOB_DIR.
   * The filesystem adapter is not a shared multi-replica object store.
   */
  BLOB_FILESYSTEM_SINGLE_RUNNER: z.enum(["0", "1"]).default("0").transform((value) => value === "1"),
  /** Writer rollout gate. Readers remain enabled while this is off. */
  BLOB_ATTACHMENTS_ENABLED: z.enum(["0", "1"]).default("0").transform((value) => value === "1"),
  /** Local orphan cleanup gate; a future shared adapter may also use it during rollout. */
  BLOB_CLEANUP_ENABLED: z.enum(["0", "1"]).default("0").transform((value) => value === "1"),
  BLOB_MAX_BYTES: z.coerce.number().int().positive().default(1_000_000),
  BLOB_MAX_HYDRATED_BYTES: z.coerce.number().int().positive().default(4_000_000),
  BLOB_TOOL_OUTPUT_THRESHOLD_BYTES: z.coerce.number().int().nonnegative().default(64_000),
  BLOB_STAGING_TTL_MS: z.coerce.number().int().positive().default(60 * 60_000),
  BLOB_CLEANUP_POLL_MS: z.coerce.number().int().positive().default(1_000),
  BLOB_CLEANUP_LEASE_MS: z.coerce.number().int().positive().default(30_000),
  BLOB_CLEANUP_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(50),
  BLOB_CLEANUP_RETRY_BASE_MS: z.coerce.number().int().positive().default(250),
  BLOB_CLEANUP_RETRY_MAX_MS: z.coerce.number().int().positive().default(60_000),
  BLOB_CLEANUP_POISON_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  /** Durable user-erasure worker. Kept separate from request admission for drain/forward-fix. */
  ERASURE_WORKER_ENABLED: z.enum(["0", "1"]).default("0").transform((value) => value === "1"),
  /**
   * One-way historical tombstone compensation worker. Enabling it participates in the v2 fleet
   * barrier and may activate the durable cutover that rejects pre-0009 deletion writes.
   */
  LEGACY_TOMBSTONE_COMPENSATION_ENABLED: z.enum(["0", "1"])
    .default("0")
    .transform((value) => value === "1"),
  /** Base URL of the private router control plane; required only while this worker is enabled. */
  ERASURE_ROUTER_URL: z.string().trim().min(1).optional(),
  ERASURE_WORKER_POLL_MS: z.coerce.number().int().min(1).max(300_000).default(1_000),
  ERASURE_WORKER_LEASE_MS: z.coerce.number().int().min(100).max(600_000).default(30_000),
  ERASURE_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  ERASURE_WORKER_SESSION_PAGE_SIZE: z.coerce.number().int().min(1).max(200).default(100),
  ERASURE_WORKER_RETRY_BASE_MS: z.coerce.number().int().min(1).max(300_000).default(1_000),
  ERASURE_WORKER_RETRY_MAX_MS: z.coerce.number().int().min(1).max(600_000).default(60_000),
  LEGACY_TOMBSTONE_COMPENSATION_POLL_MS: z.coerce.number().int().min(1).max(300_000).default(1_000),
  LEGACY_TOMBSTONE_COMPENSATION_LEASE_MS: z.coerce.number().int().min(100).max(600_000).default(30_000),
  LEGACY_TOMBSTONE_COMPENSATION_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  LEGACY_TOMBSTONE_COMPENSATION_RETRY_BASE_MS: z.coerce.number().int().min(1).max(300_000).default(1_000),
  LEGACY_TOMBSTONE_COMPENSATION_RETRY_MAX_MS: z.coerce.number().int().min(1).max(600_000).default(60_000),
  /** Bounded wait for a local provider/tool execution to acknowledge an erasure abort. */
  ERASURE_DRAIN_TIMEOUT_MS: z.coerce.number().int().min(1).max(28_000).default(10_000),
  /** End-to-end deadline; must exceed Host drain and the router's 15s upstream-header default. */
  ERASURE_WORKER_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(20_000),
  /** Subject erasure is additive but write-blocking; keep it off until every writer understands the gate. */
  DATA_ERASURE_REQUESTS_ENABLED: z.enum(["0", "1"]).default("0").transform((value) => value === "1"),
  /** Independent platform-only tenant-erasure admission; never authenticated by a tenant key. */
  TENANT_ERASURE_REQUESTS_ENABLED: z.enum(["0", "1"])
    .default("0")
    .transform((value) => value === "1"),
  /** Local credential-store revocation worker; independent from later content-purge execution. */
  TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED: z.enum(["0", "1"])
    .default("0")
    .transform((value) => value === "1"),
  /** T3b private local fence/drain endpoint. Code awareness is advertised even while this is off. */
  TENANT_RUNTIME_DRAIN_ENABLED: z.enum(["0", "1"])
    .default("0")
    .transform((value) => value === "1"),
  /** Embedded durable T3b claimant. It is independent from T3a and content-purge execution. */
  TENANT_RUNTIME_REVOCATION_WORKER_ENABLED: z.enum(["0", "1"])
    .default("0")
    .transform((value) => value === "1"),
  TENANT_RUNTIME_DRAIN_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(10_000),
  TENANT_RUNTIME_REVOCATION_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(30_000),
  TENANT_RUNTIME_REVOCATION_WORKER_POLL_MS: z.coerce.number().int().min(1).max(300_000).default(1_000),
  TENANT_RUNTIME_REVOCATION_WORKER_LEASE_MS: z.coerce.number().int().min(100).max(600_000).default(30_000),
  TENANT_RUNTIME_REVOCATION_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(5),
  TENANT_RUNTIME_REVOCATION_MATERIALIZE_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(25),
  TENANT_RUNTIME_REVOCATION_RETRY_BASE_MS: z.coerce.number().int().min(1).max(300_000).default(1_000),
  TENANT_RUNTIME_REVOCATION_RETRY_MAX_MS: z.coerce.number().int().min(1).max(600_000).default(60_000),
  /** T3c trusted-clock structural inventory. It cannot delete or anonymize tenant data. */
  TENANT_CONTENT_INVENTORY_WORKER_ENABLED: z.enum(["0", "1"])
    .default("0")
    .transform((value) => value === "1"),
  TENANT_CONTENT_INVENTORY_WORKER_POLL_MS: z.coerce.number().int().min(1).max(300_000).default(1_000),
  TENANT_CONTENT_INVENTORY_WORKER_LEASE_MS: z.coerce.number().int().min(100).max(600_000).default(30_000),
  TENANT_CONTENT_INVENTORY_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(5),
  TENANT_CONTENT_INVENTORY_MATERIALIZE_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(25),
  TENANT_CONTENT_INVENTORY_SESSION_PAGE_SIZE: z.coerce.number().int().min(1).max(1_000).default(100),
  TENANT_CONTENT_INVENTORY_RETRY_BASE_MS: z.coerce.number().int().min(1).max(300_000).default(1_000),
  TENANT_CONTENT_INVENTORY_RETRY_MAX_MS: z.coerce.number().int().min(1).max(600_000).default(60_000),
  /** T3d full-domain planning only. It cannot delete, anonymize, revoke, or complete erasure. */
  TENANT_PURGE_PLAN_WORKER_ENABLED: z.enum(["0", "1"])
    .default("0")
    .transform((value) => value === "1"),
  TENANT_PURGE_PLAN_WORKER_POLL_MS: z.coerce.number().int().min(1).max(300_000).default(1_000),
  TENANT_PURGE_PLAN_WORKER_LEASE_MS: z.coerce.number().int().min(100).max(600_000).default(30_000),
  TENANT_PURGE_PLAN_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(5),
  TENANT_PURGE_PLAN_MATERIALIZE_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(25),
  TENANT_PURGE_PLAN_RETRY_BASE_MS: z.coerce.number().int().min(1).max(300_000).default(1_000),
  TENANT_PURGE_PLAN_RETRY_MAX_MS: z.coerce.number().int().min(1).max(600_000).default(60_000),
  /** T3e local execution/physical-ACK worker. Independent and default-off until 0023 rollout. */
  TENANT_PURGE_EXECUTION_WORKER_ENABLED: z.enum(["0", "1"])
    .default("0")
    .transform((value) => value === "1"),
  TENANT_PURGE_EXECUTION_WORKER_POLL_MS: z.coerce.number().int().min(1).max(300_000).default(1_000),
  TENANT_PURGE_EXECUTION_WORKER_LEASE_MS: z.coerce.number().int().min(100).max(600_000).default(30_000),
  TENANT_PURGE_EXECUTION_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(5),
  TENANT_PURGE_EXECUTION_MATERIALIZE_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(25),
  TENANT_PURGE_EXECUTION_RETRY_BASE_MS: z.coerce.number().int().min(1).max(300_000).default(1_000),
  TENANT_PURGE_EXECUTION_RETRY_MAX_MS: z.coerce.number().int().min(1).max(600_000).default(60_000),
  /** Bounded runner-to-router fleet check performed immediately before each tenant admission. */
  TENANT_ERASURE_BARRIER_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(2_000),
  /** Canonical policy/legal-hold admin surface. This never enables destructive purge. */
  DATA_GOVERNANCE_MANAGEMENT_ENABLED: z.enum(["0", "1"])
    .default("0")
    .transform((value) => value === "1"),
  /** Non-destructive purge-policy evaluator. Physical purge remains unavailable. */
  PURGE_POLICY_EVALUATOR_ENABLED: z.enum(["0", "1"])
    .default("0")
    .transform((value) => value === "1"),
  PURGE_POLICY_EVALUATOR_POLL_MS: z.coerce.number().int().min(1).max(300_000).default(1_000),
  PURGE_POLICY_EVALUATOR_LEASE_MS: z.coerce.number().int().min(100).max(600_000).default(30_000),
  PURGE_POLICY_EVALUATOR_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  PURGE_POLICY_EVALUATOR_TARGET_PAGE_SIZE: z.coerce.number().int().min(1).max(1_000).default(100),
  PURGE_POLICY_EVALUATOR_RETRY_BASE_MS: z.coerce.number().int().min(1).max(300_000).default(1_000),
  PURGE_POLICY_EVALUATOR_RETRY_MAX_MS: z.coerce.number().int().min(1).max(600_000).default(60_000),
  /** Asynchronous user-export admission. Workers remain independently enabled while this is off. */
  DATA_EXPORT_REQUESTS_ENABLED: z.enum(["0", "1"]).default("0").transform((value) => value === "1"),
  DATA_EXPORT_WORKER_ENABLED: z.enum(["0", "1"]).default("0").transform((value) => value === "1"),
  DATA_EXPORT_CLEANUP_ENABLED: z.enum(["0", "1"]).default("0").transform((value) => value === "1"),
  DATA_EXPORT_WORKER_POLL_MS: z.coerce.number().int().min(1).max(300_000).default(1_000),
  DATA_EXPORT_WORKER_LEASE_MS: z.coerce.number().int().min(100).max(600_000).default(30_000),
  DATA_EXPORT_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(5),
  DATA_EXPORT_SNAPSHOT_PAGE_SIZE: z.coerce.number().int().min(1).max(1_000).default(200),
  DATA_EXPORT_ARTIFACT_STAGING_TTL_MS: z.coerce.number().int().min(1_000).default(15 * 60_000),
  DATA_EXPORT_WORKER_RETRY_BASE_MS: z.coerce.number().int().min(1).max(300_000).default(1_000),
  DATA_EXPORT_WORKER_RETRY_MAX_MS: z.coerce.number().int().min(1).max(600_000).default(60_000),
  DATA_EXPORT_WORKER_POISON_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(3),
  DATA_EXPORT_CLEANUP_POLL_MS: z.coerce.number().int().min(1).max(300_000).default(1_000),
  DATA_EXPORT_CLEANUP_LEASE_MS: z.coerce.number().int().min(100).max(600_000).default(30_000),
  DATA_EXPORT_CLEANUP_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(50),
  DATA_EXPORT_CLEANUP_RETRY_BASE_MS: z.coerce.number().int().min(1).max(300_000).default(250),
  DATA_EXPORT_CLEANUP_RETRY_MAX_MS: z.coerce.number().int().min(1).max(600_000).default(60_000),
  DATA_EXPORT_CLEANUP_POISON_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(3),
  DATA_EXPORT_DOWNLOAD_LEASE_MS: z.coerce.number().int().min(1_000).max(60_000).default(30_000),
  /** 32-byte hex key that encrypts BYOK secrets at rest. No default: a silent all-zero key is worse than a crash. */
  SECRETS_MASTER_KEY: z.string().regex(/^[0-9a-f]{64}$/i, "SECRETS_MASTER_KEY must be 64 hex chars (32 bytes)"),
  /** Dev convenience: seeds a tenant + api key on boot. Refused when NODE_ENV=production. */
  BOOTSTRAP_API_KEY: z.string().optional(),
  BOOTSTRAP_TENANT_ID: z.string().default("t_dev"),
  /** mint the first admin key for this tenant if it has none; subsequent boots do not mint another */
  ADMIN_BOOTSTRAP_TENANT: z.string().optional(),
  /** Shared only with routers; protects versioned runner-internal lifecycle routes. */
  INTERNAL_ROUTER_TOKEN: z.string().regex(/^[A-Za-z0-9._~-]{32,256}$/).optional(),
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
  LIFECYCLE_OUTBOX_POLL_MS: z.coerce.number().int().positive().default(250),
  LIFECYCLE_OUTBOX_LEASE_MS: z.coerce.number().int().positive().default(10_000),
  LIFECYCLE_OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(50),
  LIFECYCLE_OUTBOX_RETRY_BASE_MS: z.coerce.number().int().positive().default(250),
  LIFECYCLE_OUTBOX_RETRY_MAX_MS: z.coerce.number().int().positive().default(60_000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});
type ParsedConfig = z.infer<typeof Env>;
export type RunnerConfig = Omit<ParsedConfig, "RUNNER_ID" | "INTERNAL_ROUTER_TOKEN"> & {
  RUNNER_ID: string;
  INTERNAL_ROUTER_TOKEN: string;
  runnerAddr: string;
  /** The bundled filesystem adapter is readable only in an explicitly single-runner local topology. */
  dataExportArtifactsReadable: boolean;
};

const LOCAL_INTERNAL_ROUTER_TOKEN = "agent-service-local-router-token-v1";

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

function validateErasureRouterUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("ERASURE_ROUTER_URL must be an http(s) base URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("ERASURE_ROUTER_URL must be an http(s) base URL");
  }
  if (
    !parsed.hostname
    || parsed.username
    || parsed.password
    || (parsed.pathname && parsed.pathname !== "/")
    || parsed.search
    || parsed.hash
    || value.includes("?")
    || value.includes("#")
  ) {
    throw new Error(
      "ERASURE_ROUTER_URL must not contain credentials, a path, query parameters, or a fragment",
    );
  }
  return parsed.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  if (
    env.TENANT_ERASURE_OPERATOR_TOKEN !== undefined
    || env.TENANT_ERASURE_OPERATOR_ID !== undefined
  ) {
    throw new Error(
      "TENANT_ERASURE_OPERATOR_TOKEN and TENANT_ERASURE_OPERATOR_ID are router-only and must not enter a runner process",
    );
  }
  const c = Env.parse(env);
  const production = c.NODE_ENV === "production";
  if (c.TENANT_RUNTIME_DRAIN_ENABLED && !c.RUNNER_ID) {
    throw new Error(
      "RUNNER_ID is required when TENANT_RUNTIME_DRAIN_ENABLED=1 so the configured fleet slot "
        + "keeps one stable logical identity across process boots",
    );
  }
  if (production && c.BOOTSTRAP_API_KEY) {
    throw new Error("BOOTSTRAP_API_KEY must not be set when NODE_ENV=production: seed tenants through an admin path instead");
  }
  if (production && c.STORE === "memory") throw new Error("STORE=memory loses all state on restart; set STORE=mysql in production");
  if (production && !c.REDIS_URL) throw new Error("REDIS_URL is required in production: leases and event fan-out depend on it");
  if (production && !c.RUNNER_ADDR) {
    throw new Error("RUNNER_ADDR is required in production and must be reachable by the router and peer runners");
  }
  if (production && !c.INTERNAL_ROUTER_TOKEN) {
    throw new Error("INTERNAL_ROUTER_TOKEN is required in production");
  }
  if (production && (c.BLOB_ATTACHMENTS_ENABLED || c.BLOB_CLEANUP_ENABLED)) {
    throw new Error(
      "filesystem Blob writes and cleanup are unsupported in production until a shared object-store adapter is configured",
    );
  }
  if (production && (
    c.DATA_EXPORT_REQUESTS_ENABLED
    || c.DATA_EXPORT_WORKER_ENABLED
    || c.DATA_EXPORT_CLEANUP_ENABLED
  )) {
    throw new Error(
      "filesystem user-export artifacts are unsupported in production until a shared object-store adapter is configured",
    );
  }
  if (!c.RUNNER_ADDR && WILDCARD_HOSTS.has(c.RUNNER_HOST)) {
    throw new Error("RUNNER_ADDR is required when RUNNER_HOST is a wildcard bind address");
  }
  if (c.BLOB_MAX_BYTES > c.MAX_BODY_BYTES) {
    throw new Error("BLOB_MAX_BYTES must not exceed MAX_BODY_BYTES");
  }
  if (c.BLOB_MAX_HYDRATED_BYTES < c.BLOB_MAX_BYTES) {
    throw new Error("BLOB_MAX_HYDRATED_BYTES must be at least BLOB_MAX_BYTES");
  }
  if (c.BLOB_TOOL_OUTPUT_THRESHOLD_BYTES > c.BLOB_MAX_BYTES) {
    throw new Error("BLOB_TOOL_OUTPUT_THRESHOLD_BYTES must not exceed BLOB_MAX_BYTES");
  }
  if (c.BLOB_CLEANUP_RETRY_MAX_MS < c.BLOB_CLEANUP_RETRY_BASE_MS) {
    throw new Error("BLOB_CLEANUP_RETRY_MAX_MS must be at least BLOB_CLEANUP_RETRY_BASE_MS");
  }
  if (c.ERASURE_WORKER_RETRY_MAX_MS < c.ERASURE_WORKER_RETRY_BASE_MS) {
    throw new Error("ERASURE_WORKER_RETRY_MAX_MS must be at least ERASURE_WORKER_RETRY_BASE_MS");
  }
  if (
    c.LEGACY_TOMBSTONE_COMPENSATION_RETRY_MAX_MS
      < c.LEGACY_TOMBSTONE_COMPENSATION_RETRY_BASE_MS
  ) {
    throw new Error(
      "LEGACY_TOMBSTONE_COMPENSATION_RETRY_MAX_MS must be at least "
        + "LEGACY_TOMBSTONE_COMPENSATION_RETRY_BASE_MS",
    );
  }
  if (c.PURGE_POLICY_EVALUATOR_RETRY_MAX_MS < c.PURGE_POLICY_EVALUATOR_RETRY_BASE_MS) {
    throw new Error(
      "PURGE_POLICY_EVALUATOR_RETRY_MAX_MS must be at least "
        + "PURGE_POLICY_EVALUATOR_RETRY_BASE_MS",
    );
  }
  if (c.DATA_EXPORT_WORKER_RETRY_MAX_MS < c.DATA_EXPORT_WORKER_RETRY_BASE_MS) {
    throw new Error("DATA_EXPORT_WORKER_RETRY_MAX_MS must be at least DATA_EXPORT_WORKER_RETRY_BASE_MS");
  }
  if (c.DATA_EXPORT_CLEANUP_RETRY_MAX_MS < c.DATA_EXPORT_CLEANUP_RETRY_BASE_MS) {
    throw new Error("DATA_EXPORT_CLEANUP_RETRY_MAX_MS must be at least DATA_EXPORT_CLEANUP_RETRY_BASE_MS");
  }
  if (c.ERASURE_WORKER_REQUEST_TIMEOUT_MS <= c.ERASURE_DRAIN_TIMEOUT_MS + ERASURE_REQUEST_TIMEOUT_MARGIN_MS) {
    throw new Error(
      `ERASURE_WORKER_REQUEST_TIMEOUT_MS must be greater than ERASURE_DRAIN_TIMEOUT_MS + ${ERASURE_REQUEST_TIMEOUT_MARGIN_MS}ms`,
    );
  }
  const erasureRouterUrl = c.ERASURE_ROUTER_URL === undefined
    ? undefined
    : validateErasureRouterUrl(c.ERASURE_ROUTER_URL);
  if (
    (
      c.ERASURE_WORKER_ENABLED
      || c.LEGACY_TOMBSTONE_COMPENSATION_ENABLED
      || c.PURGE_POLICY_EVALUATOR_ENABLED
      || c.TENANT_ERASURE_REQUESTS_ENABLED
      || c.TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED
      || c.TENANT_RUNTIME_REVOCATION_WORKER_ENABLED
      || c.TENANT_PURGE_EXECUTION_WORKER_ENABLED
    )
    && erasureRouterUrl === undefined
  ) {
    throw new Error(
      "ERASURE_ROUTER_URL is required when ERASURE_WORKER_ENABLED=1 or "
        + "LEGACY_TOMBSTONE_COMPENSATION_ENABLED=1, PURGE_POLICY_EVALUATOR_ENABLED=1, "
        + "TENANT_ERASURE_REQUESTS_ENABLED=1, or "
        + "TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED=1, or "
        + "TENANT_RUNTIME_REVOCATION_WORKER_ENABLED=1, or "
        + "TENANT_PURGE_EXECUTION_WORKER_ENABLED=1",
    );
  }
  if (c.TENANT_RUNTIME_REVOCATION_WORKER_ENABLED && !c.TENANT_RUNTIME_DRAIN_ENABLED) {
    throw new Error(
      "TENANT_RUNTIME_DRAIN_ENABLED=1 is required before "
        + "TENANT_RUNTIME_REVOCATION_WORKER_ENABLED=1",
    );
  }
  if (
    c.TENANT_RUNTIME_REVOCATION_REQUEST_TIMEOUT_MS
      <= c.TENANT_RUNTIME_DRAIN_TIMEOUT_MS + ERASURE_REQUEST_TIMEOUT_MARGIN_MS
  ) {
    throw new Error(
      "TENANT_RUNTIME_REVOCATION_REQUEST_TIMEOUT_MS must be greater than "
        + `TENANT_RUNTIME_DRAIN_TIMEOUT_MS + ${ERASURE_REQUEST_TIMEOUT_MARGIN_MS}ms`,
    );
  }
  if (
    c.TENANT_RUNTIME_REVOCATION_RETRY_MAX_MS
      < c.TENANT_RUNTIME_REVOCATION_RETRY_BASE_MS
  ) {
    throw new Error(
      "TENANT_RUNTIME_REVOCATION_RETRY_MAX_MS must be at least "
        + "TENANT_RUNTIME_REVOCATION_RETRY_BASE_MS",
    );
  }
  if (
    c.TENANT_CONTENT_INVENTORY_RETRY_MAX_MS
      < c.TENANT_CONTENT_INVENTORY_RETRY_BASE_MS
  ) {
    throw new Error(
      "TENANT_CONTENT_INVENTORY_RETRY_MAX_MS must be at least "
        + "TENANT_CONTENT_INVENTORY_RETRY_BASE_MS",
    );
  }
  if (
    c.TENANT_PURGE_PLAN_RETRY_MAX_MS
      < c.TENANT_PURGE_PLAN_RETRY_BASE_MS
  ) {
    throw new Error(
      "TENANT_PURGE_PLAN_RETRY_MAX_MS must be at least "
        + "TENANT_PURGE_PLAN_RETRY_BASE_MS",
    );
  }
  if (
    c.TENANT_PURGE_EXECUTION_RETRY_MAX_MS
      < c.TENANT_PURGE_EXECUTION_RETRY_BASE_MS
  ) {
    throw new Error(
      "TENANT_PURGE_EXECUTION_RETRY_MAX_MS must be at least "
        + "TENANT_PURGE_EXECUTION_RETRY_BASE_MS",
    );
  }
  if (c.DATA_ERASURE_REQUESTS_ENABLED && !c.ERASURE_WORKER_ENABLED) {
    throw new Error("ERASURE_WORKER_ENABLED=1 is required before DATA_ERASURE_REQUESTS_ENABLED=1");
  }
  if (c.DATA_ERASURE_REQUESTS_ENABLED && !c.LEGACY_TOMBSTONE_COMPENSATION_ENABLED) {
    throw new Error(
      "LEGACY_TOMBSTONE_COMPENSATION_ENABLED=1 is required before "
        + "DATA_ERASURE_REQUESTS_ENABLED=1",
    );
  }
  if (c.BLOB_ATTACHMENTS_ENABLED && !c.BLOB_CLEANUP_ENABLED) {
    throw new Error("BLOB_CLEANUP_ENABLED=1 is required before BLOB_ATTACHMENTS_ENABLED=1");
  }
  if (c.DATA_EXPORT_REQUESTS_ENABLED && !c.DATA_EXPORT_WORKER_ENABLED) {
    throw new Error("DATA_EXPORT_WORKER_ENABLED=1 is required before DATA_EXPORT_REQUESTS_ENABLED=1");
  }
  if (c.DATA_EXPORT_WORKER_ENABLED && !c.DATA_EXPORT_CLEANUP_ENABLED) {
    throw new Error("DATA_EXPORT_CLEANUP_ENABLED=1 is required before DATA_EXPORT_WORKER_ENABLED=1");
  }
  if ((c.BLOB_ATTACHMENTS_ENABLED || c.BLOB_CLEANUP_ENABLED) && !c.BLOB_FILESYSTEM_SINGLE_RUNNER) {
    throw new Error(
      "BLOB_FILESYSTEM_SINGLE_RUNNER=1 is required for filesystem Blob writes or cleanup",
    );
  }
  if (
    (c.DATA_EXPORT_REQUESTS_ENABLED || c.DATA_EXPORT_WORKER_ENABLED || c.DATA_EXPORT_CLEANUP_ENABLED)
    && !c.BLOB_FILESYSTEM_SINGLE_RUNNER
  ) {
    throw new Error(
      "BLOB_FILESYSTEM_SINGLE_RUNNER=1 is required for filesystem user-export artifacts",
    );
  }
  if (c.TENANT_PURGE_EXECUTION_WORKER_ENABLED && (
    !c.BLOB_CLEANUP_ENABLED
    || !c.DATA_EXPORT_CLEANUP_ENABLED
    || !c.BLOB_FILESYSTEM_SINGLE_RUNNER
  )) {
    throw new Error(
      "T3e local execution requires BLOB_CLEANUP_ENABLED=1, "
        + "DATA_EXPORT_CLEANUP_ENABLED=1, and BLOB_FILESYSTEM_SINGLE_RUNNER=1",
    );
  }
  const runnerAddr = validateAdvertisedAddress(c.RUNNER_ADDR ?? `${c.RUNNER_HOST}:${c.RUNNER_PORT}`);
  const runnerId = c.RUNNER_ID ?? (production ? `runner-${randomUUID()}` : `runner-${process.pid}`);
  return {
    ...c,
    ERASURE_ROUTER_URL: erasureRouterUrl,
    INTERNAL_ROUTER_TOKEN: c.INTERNAL_ROUTER_TOKEN ?? LOCAL_INTERNAL_ROUTER_TOKEN,
    RUNNER_ID: runnerId,
    runnerAddr,
    dataExportArtifactsReadable: !production && c.BLOB_FILESYSTEM_SINGLE_RUNNER,
  };
}
