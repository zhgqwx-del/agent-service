import {
  blobS3Backend,
  blobS3NamespaceSha256,
  type BlobStorageCapability,
} from "@agent-service/protocol";
import { z } from "zod";

const Env = z.object({
  ROUTER_PORT: z.coerce.number().int().default(8080),
  ROUTER_HOST: z.string().default("127.0.0.1"),
  /** comma-separated runner base urls; static for now, service discovery later */
  RUNNERS: z.string().min(1),
  /** same Redis the runners use: the router reads the ownership directory from it */
  REDIS_URL: z.string().optional(),
  REDIS_PREFIX: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/).default("as"),
  /** Non-secret logical identity shared by every process targeting this Redis namespace. */
  REDIS_NAMESPACE_ID: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(),
  HEALTH_INTERVAL_MS: z.coerce.number().int().default(5_000),
  MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(2),
  // Keep this default identical to agent-runner. If the router accepts a body the runner rejects,
  // the runner may close the upload and an ordinary client error is misreported as a 502.
  MAX_BODY_BYTES: z.coerce.number().int().positive().default(1_000_000),
  /** Must match the runner's raw blob ceiling; applies only to the binary upload route. */
  BLOB_MAX_BYTES: z.coerce.number().int().positive().default(1_000_000),
  BLOB_STORE: z.enum(["filesystem", "s3"]).default("filesystem"),
  /** Non-secret namespace inputs only; the router never receives S3 credentials or an endpoint. */
  BLOB_NAMESPACE_ID: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(),
  BLOB_S3_BUCKET: z.string().min(3).max(63).optional(),
  BLOB_S3_PREFIX: z.string()
    .regex(/^[a-z0-9_-]{1,128}(?:\/[a-z0-9_-]{1,128})*$/)
    .max(256)
    .default("agent-service-v1"),
  /** Fleet acknowledgement that the database is pinned to this exact shared namespace. */
  BLOB_STORAGE_CONTROL_ENABLED: z.enum(["0", "1"]).default("0").transform((value) => value === "1"),
  /** Explicit acknowledgement that the current Blob fleet is exactly one filesystem-backed runner. */
  BLOB_FILESYSTEM_SINGLE_RUNNER: z.enum(["0", "1"]).default("0").transform((value) => value === "1"),
  /** Explicit expand→activate gate for blob writes across the whole healthy fleet. */
  BLOB_ATTACHMENTS_ENABLED: z.enum(["0", "1"]).default("0").transform((value) => value === "1"),
  /**
   * Waiting for upstream HEADERS only; the SSE body is never subject to it. Deployment invariant:
   * Host erasure drain bound < this timeout < runner worker-to-router request timeout.
   */
  UPSTREAM_HEADER_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  /** enables /_router/* when set */
  ROUTER_ADMIN_TOKEN: z.string().optional(),
  /** Must match every runner; never forwarded from an external request. */
  INTERNAL_ROUTER_TOKEN: z.string().regex(/^[A-Za-z0-9._~-]{32,256}$/).optional(),
  /** Explicit expand→activate gate. Keep 0 while any legacy router/runner can receive DELETE. */
  SESSION_TOMBSTONE_ENABLED: z.enum(["0", "1"]).default("0").transform((value) => value === "1"),
  /** Explicit expand→activate gate for subject write barriers. */
  DATA_ERASURE_REQUESTS_ENABLED: z.enum(["0", "1"]).default("0").transform((value) => value === "1"),
  /** Independent platform admission gate for tenant-wide erasure. */
  TENANT_ERASURE_REQUESTS_ENABLED: z.enum(["0", "1"])
    .default("0")
    .transform((value) => value === "1"),
  /** Router-only platform authority for tenant-erasure admission, replay and status. */
  TENANT_ERASURE_OPERATOR_TOKEN: z.string().regex(/^[A-Za-z0-9._~-]{32,256}$/).optional(),
  /** Stable non-secret audit principal injected only on the authenticated runner-internal route. */
  TENANT_ERASURE_OPERATOR_ID: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/)
    .default("platform-lifecycle-admin"),
  /** Canonical retention-policy/legal-hold management. Physical purge remains a separate gate. */
  DATA_GOVERNANCE_MANAGEMENT_ENABLED: z.enum(["0", "1"])
    .default("0")
    .transform((value) => value === "1"),
  /** Non-destructive purge-policy evaluator barrier; physical purge has no activation flag. */
  PURGE_POLICY_EVALUATOR_ENABLED: z.enum(["0", "1"])
    .default("0")
    .transform((value) => value === "1"),
  /** Independent execution gate for local tenant credential-store revocation. */
  TENANT_CREDENTIAL_REVOCATION_EXECUTION_ENABLED: z.enum(["0", "1"])
    .default("0")
    .transform((value) => value === "1"),
  /**
   * Fleet acknowledgement for the write-once credential-lifecycle tracking cutover. The runner
   * owns activation; the router uses this independent gate before issuing destructive T3a ACKs.
   */
  CREDENTIAL_LIFECYCLE_TRACKING_ENABLED: z.enum(["0", "1"])
    .default("0")
    .transform((value) => value === "1"),
  /** Independent fleet gate for external credential target execution. */
  TENANT_CREDENTIAL_TARGET_EXECUTION_ENABLED: z.enum(["0", "1"])
    .default("0")
    .transform((value) => value === "1"),
  /** Independent execution barrier for the T3e local execution/physical-ACK worker. */
  TENANT_PURGE_EXECUTION_ENABLED: z.enum(["0", "1"])
    .default("0")
    .transform((value) => value === "1"),
  /** Independent T3f database-content deletion barrier; never implied by T3e activation. */
  TENANT_DATABASE_PURGE_ENABLED: z.enum(["0", "1"])
    .default("0")
    .transform((value) => value === "1"),
  /** Independent T3g Redis session-state deletion barrier. */
  TENANT_REDIS_PURGE_ENABLED: z.enum(["0", "1"])
    .default("0")
    .transform((value) => value === "1"),
  /** Broadcast T3b runtime drain. Keep closed until every configured stable runner endpoint is active. */
  TENANT_RUNTIME_DRAIN_EXECUTION_ENABLED: z.enum(["0", "1"])
    .default("0")
    .transform((value) => value === "1"),
  /** User-export admission; status/download remain capability-gated when this is off. */
  DATA_EXPORT_REQUESTS_ENABLED: z.enum(["0", "1"])
    .default("0")
    .transform((value) => value === "1"),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().nonnegative().default(10_000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  NODE_ENV: z.string().optional(),
});
export type RouterConfig = Omit<z.infer<typeof Env>, "INTERNAL_ROUTER_TOKEN"> & {
  runnerList: string[];
  INTERNAL_ROUTER_TOKEN: string;
  /** The bundled filesystem artifact path is readable only in a single-runner local topology. */
  dataExportArtifactsReadable: boolean;
  /** Expected full namespace identity; used to reject split-brain runner configurations. */
  blobStorage?: BlobStorageCapability;
};

const LOCAL_INTERNAL_ROUTER_TOKEN = "agent-service-local-router-token-v1";
const ROUTER_ALLOWED_BLOB_S3_ENV = new Set(["BLOB_S3_BUCKET", "BLOB_S3_PREFIX"]);
const ROUTER_FORBIDDEN_CREDENTIAL_ENV = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONFIG_FILE",
  "AWS_CREDENTIAL_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
]);

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
  return parsed.origin;
}

function validateS3Bucket(value: string): string {
  if (
    !/^[a-z0-9][a-z0-9.-]+[a-z0-9]$/.test(value)
    || value.includes("..")
    || value.includes(".-")
    || value.includes("-.")
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)
  ) throw new Error("BLOB_S3_BUCKET must be a safe DNS-style bucket name");
  return value;
}

export function loadRouterConfig(env: NodeJS.ProcessEnv = process.env): RouterConfig {
  const runnerOnlyKey = Object.keys(env).find((key) => (
    (key.startsWith("BLOB_S3_") && !ROUTER_ALLOWED_BLOB_S3_ENV.has(key))
    || key.startsWith("MINIO_ROOT_")
    || key.startsWith("AWS_SSO_")
    || ROUTER_FORBIDDEN_CREDENTIAL_ENV.has(key)
  ) && env[key] !== undefined);
  if (runnerOnlyKey) {
    throw new Error(`${runnerOnlyKey} is runner-only object-store authority and must not enter the router process`);
  }
  const c = Env.parse(env);
  const runnerList = [...new Set(c.RUNNERS.split(",").map((s) => s.trim()).filter(Boolean).map(validateRunnerUrl))];
  const internalRouterToken = c.INTERNAL_ROUTER_TOKEN ?? LOCAL_INTERNAL_ROUTER_TOKEN;
  let blobStorage: BlobStorageCapability | undefined;
  if (c.BLOB_STORE === "s3") {
    if (!c.BLOB_NAMESPACE_ID) throw new Error("BLOB_NAMESPACE_ID is required when BLOB_STORE=s3");
    if (!c.BLOB_S3_BUCKET) throw new Error("BLOB_S3_BUCKET is required when BLOB_STORE=s3");
    const namespaceSha256 = blobS3NamespaceSha256(
      c.BLOB_NAMESPACE_ID,
      validateS3Bucket(c.BLOB_S3_BUCKET),
      c.BLOB_S3_PREFIX,
    );
    blobStorage = {
      backend: blobS3Backend(namespaceSha256),
      shared: true,
      namespaceSha256,
      controlGeneration: 1,
    };
    if (c.BLOB_FILESYSTEM_SINGLE_RUNNER) {
      throw new Error("BLOB_FILESYSTEM_SINGLE_RUNNER must be 0 when BLOB_STORE=s3");
    }
  }
  if (c.BLOB_STORE === "s3" && !c.BLOB_STORAGE_CONTROL_ENABLED) {
    throw new Error("BLOB_STORAGE_CONTROL_ENABLED=1 is required when BLOB_STORE=s3");
  }
  if (c.BLOB_STORE === "filesystem" && c.BLOB_STORAGE_CONTROL_ENABLED) {
    throw new Error("BLOB_STORAGE_CONTROL_ENABLED must be 0 when BLOB_STORE=filesystem");
  }
  if (!runnerList.length) throw new Error("RUNNERS must list at least one runner base url");
  if (runnerList.length > 100) throw new Error("RUNNERS must list at most 100 runner base urls");
  if (c.NODE_ENV === "production" && !c.INTERNAL_ROUTER_TOKEN) {
    throw new Error("INTERNAL_ROUTER_TOKEN is required in production");
  }
  if (c.BLOB_MAX_BYTES > c.MAX_BODY_BYTES) {
    throw new Error("BLOB_MAX_BYTES must not exceed MAX_BODY_BYTES");
  }
  if (c.BLOB_STORE === "filesystem" && c.BLOB_FILESYSTEM_SINGLE_RUNNER && runnerList.length !== 1) {
    throw new Error("BLOB_FILESYSTEM_SINGLE_RUNNER=1 requires RUNNERS to contain exactly one runner");
  }
  if (c.BLOB_STORE === "filesystem" && c.BLOB_ATTACHMENTS_ENABLED && !c.BLOB_FILESYSTEM_SINGLE_RUNNER) {
    throw new Error("BLOB_FILESYSTEM_SINGLE_RUNNER=1 is required before BLOB_ATTACHMENTS_ENABLED=1");
  }
  if (c.NODE_ENV === "production" && c.BLOB_STORE === "filesystem" && c.BLOB_ATTACHMENTS_ENABLED) {
    throw new Error(
      "filesystem Blob writes are unsupported in production until a shared object-store adapter is configured",
    );
  }
  if (c.BLOB_STORE === "filesystem" && c.DATA_EXPORT_REQUESTS_ENABLED && !c.BLOB_FILESYSTEM_SINGLE_RUNNER) {
    throw new Error(
      "BLOB_FILESYSTEM_SINGLE_RUNNER=1 is required before DATA_EXPORT_REQUESTS_ENABLED=1",
    );
  }
  if (c.NODE_ENV === "production" && c.BLOB_STORE === "filesystem" && c.DATA_EXPORT_REQUESTS_ENABLED) {
    throw new Error(
      "filesystem user-export artifacts are unsupported in production until a shared object-store adapter is configured",
    );
  }
  if (c.TENANT_ERASURE_REQUESTS_ENABLED && !c.TENANT_ERASURE_OPERATOR_TOKEN) {
    throw new Error(
      "TENANT_ERASURE_OPERATOR_TOKEN is required before TENANT_ERASURE_REQUESTS_ENABLED=1",
    );
  }
  if (c.TENANT_ERASURE_OPERATOR_TOKEN === internalRouterToken) {
    throw new Error(
      "TENANT_ERASURE_OPERATOR_TOKEN must differ from INTERNAL_ROUTER_TOKEN",
    );
  }
  if (c.TENANT_REDIS_PURGE_ENABLED && !c.REDIS_URL) {
    throw new Error("REDIS_URL is required before TENANT_REDIS_PURGE_ENABLED=1");
  }
  if (
    c.TENANT_CREDENTIAL_REVOCATION_EXECUTION_ENABLED
    && !c.CREDENTIAL_LIFECYCLE_TRACKING_ENABLED
  ) {
    throw new Error(
      "CREDENTIAL_LIFECYCLE_TRACKING_ENABLED=1 is required before "
        + "TENANT_CREDENTIAL_REVOCATION_EXECUTION_ENABLED=1",
    );
  }
  if (c.TENANT_CREDENTIAL_TARGET_EXECUTION_ENABLED
    && !c.CREDENTIAL_LIFECYCLE_TRACKING_ENABLED) {
    throw new Error(
      "CREDENTIAL_LIFECYCLE_TRACKING_ENABLED=1 is required before "
        + "TENANT_CREDENTIAL_TARGET_EXECUTION_ENABLED=1",
    );
  }
  if (c.TENANT_REDIS_PURGE_ENABLED && !c.REDIS_NAMESPACE_ID) {
    throw new Error("REDIS_NAMESPACE_ID is required before TENANT_REDIS_PURGE_ENABLED=1");
  }
  if (
    c.TENANT_ERASURE_OPERATOR_TOKEN !== undefined
    && c.TENANT_ERASURE_OPERATOR_TOKEN === c.ROUTER_ADMIN_TOKEN
  ) {
    throw new Error(
      "TENANT_ERASURE_OPERATOR_TOKEN must differ from ROUTER_ADMIN_TOKEN",
    );
  }
  return {
    ...c,
    INTERNAL_ROUTER_TOKEN: internalRouterToken,
    runnerList,
    dataExportArtifactsReadable:
      c.BLOB_STORE === "s3"
      || (c.NODE_ENV !== "production" && c.BLOB_FILESYSTEM_SINGLE_RUNNER),
    ...(blobStorage === undefined ? {} : { blobStorage }),
  };
}
