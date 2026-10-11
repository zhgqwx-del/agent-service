import {
  S3_TENANT_BACKUP_CATALOG_PROTOCOL,
  S3TenantBackupCatalogAdapter,
  backupCatalogAdapterSha256,
  s3TenantBackupCatalogFailureDomainSha256,
  s3TenantBackupCatalogNamespaceSha256,
  s3TenantBackupCatalogTargetSha256,
  tenantRestoreLogicalDatabaseNamespaceSha256,
  type S3TenantBackupCatalogAdapterOptions,
} from "@agent-service/store";
import { z } from "zod";

const DEFAULT_PREFIX = "tenant-backup-catalog";

const BackupCatalogEnv = z.object({
  BACKUP_CATALOG_ADAPTER: z.enum(["s3"]).optional(),
  BACKUP_CATALOG_DATABASE_NAMESPACE_ID:
    z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/).optional(),
  BACKUP_CATALOG_NAMESPACE_ID:
    z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/).optional(),
  BACKUP_CATALOG_FAILURE_DOMAIN_ID:
    z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/).optional(),
  BACKUP_CATALOG_INDEPENDENT_FAILURE_DOMAIN_ACK:
    z.enum(["0", "1"]).default("0").transform((value) => value === "1"),
  BACKUP_CATALOG_S3_ENDPOINT: z.string().trim().min(1).optional(),
  BACKUP_CATALOG_S3_REGION:
    z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).default("us-east-1"),
  BACKUP_CATALOG_S3_BUCKET: z.string().min(3).max(63).optional(),
  BACKUP_CATALOG_S3_PREFIX: z.string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,127}(?:\/[a-z0-9][a-z0-9._-]{0,127})*$/)
    .max(512)
    .default(DEFAULT_PREFIX),
  BACKUP_CATALOG_S3_FORCE_PATH_STYLE:
    z.enum(["0", "1"]).default("0").transform((value) => value === "1"),
  BACKUP_CATALOG_S3_PRIVATE_BUCKET_ACK:
    z.enum(["0", "1"]).default("0").transform((value) => value === "1"),
  BACKUP_CATALOG_S3_REQUEST_TIMEOUT_MS:
    z.coerce.number().int().min(100).max(30_000).default(5_000),
  BACKUP_CATALOG_S3_ACCESS_KEY_ID: z.string().min(1).max(128).optional(),
  BACKUP_CATALOG_S3_SECRET_ACCESS_KEY: z.string().min(1).max(512).optional(),
  BACKUP_CATALOG_S3_SESSION_TOKEN: z.string().min(1).max(4_096).optional(),
  BACKUP_CATALOG_MINIMUM_RETENTION_MS:
    z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  BACKUP_CATALOG_MINIMUM_RECOVERABLE_BACKUPS:
    z.coerce.number().int().min(1).max(1_000_000).optional(),
});

const TARGET_ENV_KEYS = [
  "BACKUP_CATALOG_DATABASE_NAMESPACE_ID",
  "BACKUP_CATALOG_NAMESPACE_ID",
  "BACKUP_CATALOG_FAILURE_DOMAIN_ID",
  "BACKUP_CATALOG_INDEPENDENT_FAILURE_DOMAIN_ACK",
  "BACKUP_CATALOG_S3_ENDPOINT",
  "BACKUP_CATALOG_S3_REGION",
  "BACKUP_CATALOG_S3_BUCKET",
  "BACKUP_CATALOG_S3_PREFIX",
  "BACKUP_CATALOG_S3_FORCE_PATH_STYLE",
  "BACKUP_CATALOG_S3_PRIVATE_BUCKET_ACK",
  "BACKUP_CATALOG_S3_REQUEST_TIMEOUT_MS",
  "BACKUP_CATALOG_S3_ACCESS_KEY_ID",
  "BACKUP_CATALOG_S3_SECRET_ACCESS_KEY",
  "BACKUP_CATALOG_S3_SESSION_TOKEN",
  "BACKUP_CATALOG_MINIMUM_RETENTION_MS",
  "BACKUP_CATALOG_MINIMUM_RECOVERABLE_BACKUPS",
] as const;

const DISABLED_ZERO_TARGET_KEYS = new Set<string>([
  "BACKUP_CATALOG_INDEPENDENT_FAILURE_DOMAIN_ACK",
  "BACKUP_CATALOG_S3_FORCE_PATH_STYLE",
  "BACKUP_CATALOG_S3_PRIVATE_BUCKET_ACK",
]);

export interface TenantBackupCatalogRuntimeConfig {
  adapterProtocol: typeof S3_TENANT_BACKUP_CATALOG_PROTOCOL;
  catalogNamespaceSha256: string;
  catalogTargetSha256: string;
  failureDomainSha256: string;
  logicalDatabaseNamespaceSha256: string;
  retentionPolicySha256?: string;
  minimumRetentionMs?: number;
  minimumRecoverableBackups?: number;
  options: S3TenantBackupCatalogAdapterOptions;
}

export interface LoadTenantBackupCatalogConfigOptions {
  production: boolean;
  store: "memory" | "mysql";
  blobS3Bucket?: string;
  restoreJournalS3Bucket?: string;
  requireRetentionPolicy?: boolean;
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
  ) throw new Error("BACKUP_CATALOG_S3_BUCKET must be a safe DNS-style bucket name");
  return value;
}

function validateEndpoint(value: string, production: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("BACKUP_CATALOG_S3_ENDPOINT must be an absolute http(s) origin");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || (parsed.pathname && parsed.pathname !== "/")
    || parsed.search
    || parsed.hash
  ) throw new Error("BACKUP_CATALOG_S3_ENDPOINT must be a credential-free http(s) origin");
  if (production && parsed.protocol !== "https:") {
    throw new Error("BACKUP_CATALOG_S3_ENDPOINT must use https in production");
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

/** Parse the independent catalog only for the offline backup-catalog command. */
export function loadTenantBackupCatalogConfig(
  env: NodeJS.ProcessEnv,
  context: LoadTenantBackupCatalogConfigOptions,
): TenantBackupCatalogRuntimeConfig | undefined {
  const parsed = BackupCatalogEnv.parse(env);
  if (parsed.BACKUP_CATALOG_ADAPTER === undefined) {
    if (hasDisabledTargetSetting(env)) {
      throw new Error(
        "BACKUP_CATALOG_ADAPTER=s3 is required when backup-catalog target settings are present",
      );
    }
    return undefined;
  }
  if (context.store !== "mysql") {
    throw new Error("STORE=mysql is required when BACKUP_CATALOG_ADAPTER=s3");
  }
  if (!parsed.BACKUP_CATALOG_INDEPENDENT_FAILURE_DOMAIN_ACK) {
    throw new Error(
      "BACKUP_CATALOG_INDEPENDENT_FAILURE_DOMAIN_ACK=1 is required after independently "
        + "verifying that the catalog is outside the primary database failure domain",
    );
  }
  const databaseNamespaceId = parsed.BACKUP_CATALOG_DATABASE_NAMESPACE_ID;
  const namespaceId = parsed.BACKUP_CATALOG_NAMESPACE_ID;
  const failureDomainId = parsed.BACKUP_CATALOG_FAILURE_DOMAIN_ID;
  const rawBucket = parsed.BACKUP_CATALOG_S3_BUCKET;
  if (!databaseNamespaceId || !namespaceId || !failureDomainId || !rawBucket) {
    throw new Error(
      "BACKUP_CATALOG_DATABASE_NAMESPACE_ID, BACKUP_CATALOG_NAMESPACE_ID, "
        + "BACKUP_CATALOG_FAILURE_DOMAIN_ID, and BACKUP_CATALOG_S3_BUCKET are required",
    );
  }
  const bucket = validateBucket(rawBucket);
  for (const [other, name] of [
    [context.blobS3Bucket, "BLOB_S3_BUCKET"],
    [context.restoreJournalS3Bucket, "RESTORE_JOURNAL_S3_BUCKET"],
  ] as const) {
    if (other !== undefined && bucket === other) {
      throw new Error(`the backup catalog must use a bucket distinct from ${name}`);
    }
  }
  if ((parsed.BACKUP_CATALOG_S3_ACCESS_KEY_ID === undefined)
    !== (parsed.BACKUP_CATALOG_S3_SECRET_ACCESS_KEY === undefined)) {
    throw new Error(
      "BACKUP_CATALOG_S3_ACCESS_KEY_ID and BACKUP_CATALOG_S3_SECRET_ACCESS_KEY "
        + "must be configured together",
    );
  }
  if (parsed.BACKUP_CATALOG_S3_SESSION_TOKEN !== undefined
    && parsed.BACKUP_CATALOG_S3_ACCESS_KEY_ID === undefined) {
    throw new Error("BACKUP_CATALOG_S3_SESSION_TOKEN requires static S3 credentials");
  }
  if (context.production && !parsed.BACKUP_CATALOG_S3_PRIVATE_BUCKET_ACK) {
    throw new Error(
      "BACKUP_CATALOG_S3_PRIVATE_BUCKET_ACK=1 is required in production after verifying "
        + "that anonymous/public access is denied",
    );
  }
  if (context.requireRetentionPolicy
    && (parsed.BACKUP_CATALOG_MINIMUM_RETENTION_MS === undefined
      || parsed.BACKUP_CATALOG_MINIMUM_RECOVERABLE_BACKUPS === undefined)) {
    throw new Error(
      "BACKUP_CATALOG_MINIMUM_RETENTION_MS and "
        + "BACKUP_CATALOG_MINIMUM_RECOVERABLE_BACKUPS are required for activation",
    );
  }
  const endpoint = parsed.BACKUP_CATALOG_S3_ENDPOINT === undefined
    ? undefined
    : validateEndpoint(parsed.BACKUP_CATALOG_S3_ENDPOINT, context.production);
  const logicalDatabaseNamespaceSha256 = tenantRestoreLogicalDatabaseNamespaceSha256(
    databaseNamespaceId,
  );
  const catalogNamespaceSha256 = s3TenantBackupCatalogNamespaceSha256(namespaceId);
  const failureDomainSha256 = s3TenantBackupCatalogFailureDomainSha256(failureDomainId);
  const catalogTargetSha256 = s3TenantBackupCatalogTargetSha256({
    catalogNamespaceSha256,
    failureDomainSha256,
    logicalDatabaseNamespaceSha256,
    bucket,
    prefix: parsed.BACKUP_CATALOG_S3_PREFIX,
    region: parsed.BACKUP_CATALOG_S3_REGION,
    endpoint: endpoint ?? null,
    forcePathStyle: parsed.BACKUP_CATALOG_S3_FORCE_PATH_STYLE,
  });
  const options: S3TenantBackupCatalogAdapterOptions = {
    independentFailureDomain: true,
    bucket,
    namespaceId,
    failureDomainId,
    prefix: parsed.BACKUP_CATALOG_S3_PREFIX,
    logicalDatabaseNamespaceSha256,
    region: parsed.BACKUP_CATALOG_S3_REGION,
    endpoint: endpoint ?? null,
    forcePathStyle: parsed.BACKUP_CATALOG_S3_FORCE_PATH_STYLE,
    requestTimeoutMs: parsed.BACKUP_CATALOG_S3_REQUEST_TIMEOUT_MS,
    ...(parsed.BACKUP_CATALOG_S3_ACCESS_KEY_ID === undefined
      ? {}
      : {
          credentials: {
            accessKeyId: parsed.BACKUP_CATALOG_S3_ACCESS_KEY_ID,
            secretAccessKey: parsed.BACKUP_CATALOG_S3_SECRET_ACCESS_KEY!,
            ...(parsed.BACKUP_CATALOG_S3_SESSION_TOKEN === undefined
              ? {}
              : { sessionToken: parsed.BACKUP_CATALOG_S3_SESSION_TOKEN }),
          },
        }),
  };
  const minimumRetentionMs = parsed.BACKUP_CATALOG_MINIMUM_RETENTION_MS;
  const minimumRecoverableBackups = parsed.BACKUP_CATALOG_MINIMUM_RECOVERABLE_BACKUPS;
  const retentionPolicySha256 = minimumRetentionMs === undefined
    || minimumRecoverableBackups === undefined
    ? undefined
    : backupCatalogAdapterSha256([
        "tenant-backup-catalog-retention-policy-v1",
        minimumRetentionMs,
        minimumRecoverableBackups,
      ]);
  return {
    adapterProtocol: S3_TENANT_BACKUP_CATALOG_PROTOCOL,
    catalogNamespaceSha256,
    catalogTargetSha256,
    failureDomainSha256,
    logicalDatabaseNamespaceSha256,
    ...(retentionPolicySha256 === undefined
      ? {}
      : { retentionPolicySha256, minimumRetentionMs, minimumRecoverableBackups }),
    options,
  };
}

export function createTenantBackupCatalogAdapter(
  config: TenantBackupCatalogRuntimeConfig,
): S3TenantBackupCatalogAdapter {
  return new S3TenantBackupCatalogAdapter(config.options);
}
