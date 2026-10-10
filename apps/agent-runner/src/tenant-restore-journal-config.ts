import {
  S3_TENANT_RESTORE_JOURNAL_PROTOCOL,
  S3TenantRestoreJournalAdapter,
  s3TenantRestoreJournalFailureDomainSha256,
  s3TenantRestoreJournalNamespaceSha256,
  s3TenantRestoreJournalTargetSha256,
  tenantRestoreJournalTargetRootSha256,
  tenantRestoreLogicalDatabaseNamespaceSha256,
  tenantRestoreRuntimeEpochSha256,
  type S3TenantRestoreJournalAdapterOptions,
  type TenantRestoreJournalTargetDescriptor,
} from "@agent-service/store";
import { z } from "zod";

const DEFAULT_PREFIX = "tenant-restore-journal";

const RestoreJournalEnv = z.object({
  RESTORE_JOURNAL_ADAPTER: z.enum(["s3"]).optional(),
  /** Stable, non-secret identity of one logical database lineage. */
  RESTORE_JOURNAL_DATABASE_NAMESPACE_ID:
    z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/).optional(),
  /** Stable for one live lineage; must change before a restored database is activated. */
  RESTORE_JOURNAL_RUNTIME_EPOCH_ID:
    z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/).optional(),
  /** Shared, non-secret identity of the external journal set. */
  RESTORE_JOURNAL_NAMESPACE_ID:
    z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/).optional(),
  /** Non-secret provider/account/region identity used in evidence, never a credential or URL. */
  RESTORE_JOURNAL_FAILURE_DOMAIN_ID:
    z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/).optional(),
  /** Explicit operator acknowledgement; the application cannot prove physical independence. */
  RESTORE_JOURNAL_INDEPENDENT_FAILURE_DOMAIN_ACK:
    z.enum(["0", "1"]).default("0").transform((value) => value === "1"),
  RESTORE_JOURNAL_S3_ENDPOINT: z.string().trim().min(1).optional(),
  RESTORE_JOURNAL_S3_REGION:
    z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).default("us-east-1"),
  RESTORE_JOURNAL_S3_BUCKET: z.string().min(3).max(63).optional(),
  RESTORE_JOURNAL_S3_PREFIX: z.string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,127}(?:\/[a-z0-9][a-z0-9._-]{0,127})*$/)
    .max(512)
    .default(DEFAULT_PREFIX),
  RESTORE_JOURNAL_S3_FORCE_PATH_STYLE:
    z.enum(["0", "1"]).default("0").transform((value) => value === "1"),
  RESTORE_JOURNAL_S3_PRIVATE_BUCKET_ACK:
    z.enum(["0", "1"]).default("0").transform((value) => value === "1"),
  RESTORE_JOURNAL_S3_REQUEST_TIMEOUT_MS:
    z.coerce.number().int().min(100).max(30_000).default(5_000),
  RESTORE_JOURNAL_S3_ACCESS_KEY_ID: z.string().min(1).max(128).optional(),
  RESTORE_JOURNAL_S3_SECRET_ACCESS_KEY: z.string().min(1).max(512).optional(),
  RESTORE_JOURNAL_S3_SESSION_TOKEN: z.string().min(1).max(4_096).optional(),
});

type ParsedRestoreJournalEnv = z.infer<typeof RestoreJournalEnv>;

const TARGET_ENV_KEYS = [
  "RESTORE_JOURNAL_DATABASE_NAMESPACE_ID",
  "RESTORE_JOURNAL_RUNTIME_EPOCH_ID",
  "RESTORE_JOURNAL_NAMESPACE_ID",
  "RESTORE_JOURNAL_FAILURE_DOMAIN_ID",
  "RESTORE_JOURNAL_INDEPENDENT_FAILURE_DOMAIN_ACK",
  "RESTORE_JOURNAL_S3_ENDPOINT",
  "RESTORE_JOURNAL_S3_REGION",
  "RESTORE_JOURNAL_S3_BUCKET",
  "RESTORE_JOURNAL_S3_PREFIX",
  "RESTORE_JOURNAL_S3_FORCE_PATH_STYLE",
  "RESTORE_JOURNAL_S3_PRIVATE_BUCKET_ACK",
  "RESTORE_JOURNAL_S3_REQUEST_TIMEOUT_MS",
  "RESTORE_JOURNAL_S3_ACCESS_KEY_ID",
  "RESTORE_JOURNAL_S3_SECRET_ACCESS_KEY",
  "RESTORE_JOURNAL_S3_SESSION_TOKEN",
] as const;

const DISABLED_ZERO_TARGET_KEYS = new Set<string>([
  "RESTORE_JOURNAL_INDEPENDENT_FAILURE_DOMAIN_ACK",
  "RESTORE_JOURNAL_S3_FORCE_PATH_STYLE",
  "RESTORE_JOURNAL_S3_PRIVATE_BUCKET_ACK",
]);

export interface TenantRestoreJournalRuntimeConfig {
  adapterProtocol: typeof S3_TENANT_RESTORE_JOURNAL_PROTOCOL;
  journalNamespaceSha256: string;
  logicalDatabaseNamespaceSha256: string;
  runtimeEpochSha256: string;
  targetRootSha256: string;
  targets: readonly [{
    descriptor: TenantRestoreJournalTargetDescriptor;
    options: S3TenantRestoreJournalAdapterOptions;
  }];
}

export interface LoadTenantRestoreJournalConfigOptions {
  production: boolean;
  store: "memory" | "mysql";
  blobS3Bucket?: string;
}

function validateBucket(value: string): string {
  if (
    value.length < 3
    || value.length > 63
    || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value)
    || value.includes("..")
    || value.includes(".-")
    || value.includes("-.")
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)
  ) throw new Error("RESTORE_JOURNAL_S3_BUCKET must be a safe DNS-style bucket name");
  return value;
}

function validateEndpoint(value: string, production: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("RESTORE_JOURNAL_S3_ENDPOINT must be an absolute http(s) origin");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || (parsed.pathname && parsed.pathname !== "/")
    || parsed.search
    || parsed.hash
  ) throw new Error("RESTORE_JOURNAL_S3_ENDPOINT must be a credential-free http(s) origin");
  if (production && parsed.protocol !== "https:") {
    throw new Error("RESTORE_JOURNAL_S3_ENDPOINT must use https in production");
  }
  return parsed.origin;
}

function hasDisabledTargetSetting(env: NodeJS.ProcessEnv): boolean {
  return TARGET_ENV_KEYS.some((key) => {
    const value = env[key];
    return value !== undefined
      && value !== ""
      && !(value === "0" && DISABLED_ZERO_TARGET_KEYS.has(key));
  });
}

/**
 * Parse the independent journal without loading the rest of the runner configuration. The same
 * narrow parser is used by the long-running runner and the offline restore command.
 */
export function loadTenantRestoreJournalConfig(
  env: NodeJS.ProcessEnv,
  context: LoadTenantRestoreJournalConfigOptions,
): TenantRestoreJournalRuntimeConfig | undefined {
  const parsed: ParsedRestoreJournalEnv = RestoreJournalEnv.parse(env);
  if (parsed.RESTORE_JOURNAL_ADAPTER === undefined) {
    if (hasDisabledTargetSetting(env)) {
      throw new Error(
        "RESTORE_JOURNAL_ADAPTER=s3 is required when restore-journal target settings are present",
      );
    }
    return undefined;
  }
  if (context.store !== "mysql") {
    throw new Error("STORE=mysql is required when RESTORE_JOURNAL_ADAPTER=s3");
  }
  if (!parsed.RESTORE_JOURNAL_INDEPENDENT_FAILURE_DOMAIN_ACK) {
    throw new Error(
      "RESTORE_JOURNAL_INDEPENDENT_FAILURE_DOMAIN_ACK=1 is required after independently "
        + "verifying that the journal is outside the primary database failure domain",
    );
  }
  const databaseNamespaceId = parsed.RESTORE_JOURNAL_DATABASE_NAMESPACE_ID;
  const runtimeEpochId = parsed.RESTORE_JOURNAL_RUNTIME_EPOCH_ID;
  const namespaceId = parsed.RESTORE_JOURNAL_NAMESPACE_ID;
  const failureDomainId = parsed.RESTORE_JOURNAL_FAILURE_DOMAIN_ID;
  const rawBucket = parsed.RESTORE_JOURNAL_S3_BUCKET;
  if (!databaseNamespaceId || !runtimeEpochId || !namespaceId || !failureDomainId || !rawBucket) {
    throw new Error(
      "RESTORE_JOURNAL_DATABASE_NAMESPACE_ID, RESTORE_JOURNAL_RUNTIME_EPOCH_ID, "
        + "RESTORE_JOURNAL_NAMESPACE_ID, RESTORE_JOURNAL_FAILURE_DOMAIN_ID, and "
        + "RESTORE_JOURNAL_S3_BUCKET are required",
    );
  }
  const bucket = validateBucket(rawBucket);
  if (context.blobS3Bucket !== undefined && bucket === context.blobS3Bucket) {
    throw new Error("the restore journal must use a bucket distinct from BLOB_S3_BUCKET");
  }
  if ((parsed.RESTORE_JOURNAL_S3_ACCESS_KEY_ID === undefined)
    !== (parsed.RESTORE_JOURNAL_S3_SECRET_ACCESS_KEY === undefined)) {
    throw new Error(
      "RESTORE_JOURNAL_S3_ACCESS_KEY_ID and RESTORE_JOURNAL_S3_SECRET_ACCESS_KEY "
        + "must be configured together",
    );
  }
  if (parsed.RESTORE_JOURNAL_S3_SESSION_TOKEN !== undefined
    && parsed.RESTORE_JOURNAL_S3_ACCESS_KEY_ID === undefined) {
    throw new Error("RESTORE_JOURNAL_S3_SESSION_TOKEN requires static S3 credentials");
  }
  if (context.production && !parsed.RESTORE_JOURNAL_S3_PRIVATE_BUCKET_ACK) {
    throw new Error(
      "RESTORE_JOURNAL_S3_PRIVATE_BUCKET_ACK=1 is required in production after verifying "
        + "that anonymous/public access is denied",
    );
  }
  const endpoint = parsed.RESTORE_JOURNAL_S3_ENDPOINT === undefined
    ? undefined
    : validateEndpoint(parsed.RESTORE_JOURNAL_S3_ENDPOINT, context.production);
  const logicalDatabaseNamespaceSha256 = tenantRestoreLogicalDatabaseNamespaceSha256(
    databaseNamespaceId,
  );
  const runtimeEpochSha256 = tenantRestoreRuntimeEpochSha256(runtimeEpochId);
  const journalNamespaceSha256 = s3TenantRestoreJournalNamespaceSha256(namespaceId);
  const failureDomainSha256 = s3TenantRestoreJournalFailureDomainSha256(failureDomainId);
  const targetSha256 = s3TenantRestoreJournalTargetSha256({
    journalNamespaceSha256,
    failureDomainSha256,
    logicalDatabaseNamespaceSha256,
    bucket,
    prefix: parsed.RESTORE_JOURNAL_S3_PREFIX,
    region: parsed.RESTORE_JOURNAL_S3_REGION,
    endpoint: endpoint ?? null,
  });
  const descriptor: TenantRestoreJournalTargetDescriptor = {
    targetOrdinal: 0,
    targetSha256,
    failureDomainSha256,
    adapterProtocol: S3_TENANT_RESTORE_JOURNAL_PROTOCOL,
    journalNamespaceSha256,
  };
  const options: S3TenantRestoreJournalAdapterOptions = {
    independentFailureDomain: true,
    bucket,
    namespaceId,
    failureDomainId,
    prefix: parsed.RESTORE_JOURNAL_S3_PREFIX,
    logicalDatabaseNamespaceSha256,
    region: parsed.RESTORE_JOURNAL_S3_REGION,
    endpoint: endpoint ?? null,
    forcePathStyle: parsed.RESTORE_JOURNAL_S3_FORCE_PATH_STYLE,
    requestTimeoutMs: parsed.RESTORE_JOURNAL_S3_REQUEST_TIMEOUT_MS,
    ...(parsed.RESTORE_JOURNAL_S3_ACCESS_KEY_ID === undefined
      ? {}
      : {
          credentials: {
            accessKeyId: parsed.RESTORE_JOURNAL_S3_ACCESS_KEY_ID,
            secretAccessKey: parsed.RESTORE_JOURNAL_S3_SECRET_ACCESS_KEY!,
            ...(parsed.RESTORE_JOURNAL_S3_SESSION_TOKEN === undefined
              ? {}
              : { sessionToken: parsed.RESTORE_JOURNAL_S3_SESSION_TOKEN }),
          },
        }),
  };
  return {
    adapterProtocol: S3_TENANT_RESTORE_JOURNAL_PROTOCOL,
    journalNamespaceSha256,
    logicalDatabaseNamespaceSha256,
    runtimeEpochSha256,
    targetRootSha256: tenantRestoreJournalTargetRootSha256([descriptor]),
    targets: [{ descriptor, options }],
  };
}

export function createTenantRestoreJournalAdapters(
  config: TenantRestoreJournalRuntimeConfig,
): readonly S3TenantRestoreJournalAdapter[] {
  return config.targets.map((target) => new S3TenantRestoreJournalAdapter(target.options));
}
