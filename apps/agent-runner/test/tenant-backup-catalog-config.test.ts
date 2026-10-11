import { describe, expect, it } from "vitest";
import {
  S3_TENANT_BACKUP_CATALOG_PROTOCOL,
  backupCatalogAdapterSha256,
  s3TenantBackupCatalogFailureDomainSha256,
  s3TenantBackupCatalogNamespaceSha256,
  s3TenantBackupCatalogTargetSha256,
  tenantRestoreLogicalDatabaseNamespaceSha256,
} from "@agent-service/store";
import {
  loadTenantBackupCatalogConfig,
} from "../src/tenant-backup-catalog-config.js";

const base = {
  BACKUP_CATALOG_ADAPTER: "s3",
  BACKUP_CATALOG_DATABASE_NAMESPACE_ID: "agent-service-local-db-v1",
  BACKUP_CATALOG_NAMESPACE_ID: "agent-service-backup-catalog-v1",
  BACKUP_CATALOG_FAILURE_DOMAIN_ID: "local-catalog-fixture-only",
  BACKUP_CATALOG_INDEPENDENT_FAILURE_DOMAIN_ACK: "1",
  BACKUP_CATALOG_S3_ENDPOINT: "http://127.0.0.1:9000",
  BACKUP_CATALOG_S3_REGION: "us-east-1",
  BACKUP_CATALOG_S3_BUCKET: "agent-service-backup-catalog-test",
  BACKUP_CATALOG_S3_PREFIX: "catalog/v1",
  BACKUP_CATALOG_S3_FORCE_PATH_STYLE: "1",
  BACKUP_CATALOG_S3_ACCESS_KEY_ID: "fixture-access-id",
  BACKUP_CATALOG_S3_SECRET_ACCESS_KEY: "fixture-secret-material",
  BACKUP_CATALOG_MINIMUM_RETENTION_MS: "60000",
  BACKUP_CATALOG_MINIMUM_RECOVERABLE_BACKUPS: "2",
} satisfies NodeJS.ProcessEnv;

const localContext = { production: false, store: "mysql" as const };

describe("tenant backup catalog runtime configuration", () => {
  it("is default-dormant, permits explicit disabled booleans, and rejects stray settings", () => {
    expect(loadTenantBackupCatalogConfig({}, localContext)).toBeUndefined();
    expect(loadTenantBackupCatalogConfig({
      BACKUP_CATALOG_INDEPENDENT_FAILURE_DOMAIN_ACK: "0",
      BACKUP_CATALOG_S3_FORCE_PATH_STYLE: "0",
      BACKUP_CATALOG_S3_PRIVATE_BUCKET_ACK: "0",
    }, localContext)).toBeUndefined();
    expect(() => loadTenantBackupCatalogConfig({
      BACKUP_CATALOG_S3_BUCKET: "stray-catalog-bucket",
    }, localContext)).toThrow(/BACKUP_CATALOG_ADAPTER=s3/);
  });

  it("derives stable content-free identities from every controlled target dimension", () => {
    const config = loadTenantBackupCatalogConfig(base, localContext)!;
    const logicalDatabaseNamespaceSha256 = tenantRestoreLogicalDatabaseNamespaceSha256(
      base.BACKUP_CATALOG_DATABASE_NAMESPACE_ID,
    );
    const catalogNamespaceSha256 = s3TenantBackupCatalogNamespaceSha256(
      base.BACKUP_CATALOG_NAMESPACE_ID,
    );
    const failureDomainSha256 = s3TenantBackupCatalogFailureDomainSha256(
      base.BACKUP_CATALOG_FAILURE_DOMAIN_ID,
    );

    expect(config).toMatchObject({
      adapterProtocol: S3_TENANT_BACKUP_CATALOG_PROTOCOL,
      logicalDatabaseNamespaceSha256,
      catalogNamespaceSha256,
      failureDomainSha256,
      minimumRetentionMs: 60_000,
      minimumRecoverableBackups: 2,
      retentionPolicySha256: backupCatalogAdapterSha256([
        "tenant-backup-catalog-retention-policy-v1",
        60_000,
        2,
      ]),
    });
    expect(config.catalogTargetSha256).toBe(s3TenantBackupCatalogTargetSha256({
      catalogNamespaceSha256,
      failureDomainSha256,
      logicalDatabaseNamespaceSha256,
      bucket: base.BACKUP_CATALOG_S3_BUCKET,
      prefix: base.BACKUP_CATALOG_S3_PREFIX,
      region: base.BACKUP_CATALOG_S3_REGION,
      endpoint: base.BACKUP_CATALOG_S3_ENDPOINT,
      forcePathStyle: true,
    }));
    expect(config.options).toMatchObject({
      bucket: base.BACKUP_CATALOG_S3_BUCKET,
      namespaceId: base.BACKUP_CATALOG_NAMESPACE_ID,
      failureDomainId: base.BACKUP_CATALOG_FAILURE_DOMAIN_ID,
      endpoint: base.BACKUP_CATALOG_S3_ENDPOINT,
      forcePathStyle: true,
      credentials: {
        accessKeyId: base.BACKUP_CATALOG_S3_ACCESS_KEY_ID,
        secretAccessKey: base.BACKUP_CATALOG_S3_SECRET_ACCESS_KEY,
      },
    });
    expect(config.catalogTargetSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(config.catalogTargetSha256).not.toContain(base.BACKUP_CATALOG_S3_BUCKET);

    for (const changed of [
      { BACKUP_CATALOG_S3_REGION: "us-west-2" },
      { BACKUP_CATALOG_S3_ENDPOINT: "http://127.0.0.1:9001" },
      { BACKUP_CATALOG_S3_PREFIX: "catalog/v2" },
      { BACKUP_CATALOG_S3_FORCE_PATH_STYLE: "0" },
    ]) {
      expect(loadTenantBackupCatalogConfig({ ...base, ...changed }, localContext)!
        .catalogTargetSha256).not.toBe(config.catalogTargetSha256);
    }
  });

  it("requires MySQL, an independent-domain acknowledgement, and a distinct bucket", () => {
    expect(() => loadTenantBackupCatalogConfig(base, {
      production: false,
      store: "memory",
    })).toThrow(/STORE=mysql/);
    expect(() => loadTenantBackupCatalogConfig({
      ...base,
      BACKUP_CATALOG_INDEPENDENT_FAILURE_DOMAIN_ACK: "0",
    }, localContext)).toThrow(/INDEPENDENT_FAILURE_DOMAIN_ACK=1/);
    expect(() => loadTenantBackupCatalogConfig(base, {
      ...localContext,
      blobS3Bucket: base.BACKUP_CATALOG_S3_BUCKET,
    })).toThrow(/distinct from BLOB_S3_BUCKET/);
    expect(() => loadTenantBackupCatalogConfig(base, {
      ...localContext,
      restoreJournalS3Bucket: base.BACKUP_CATALOG_S3_BUCKET,
    })).toThrow(/distinct from RESTORE_JOURNAL_S3_BUCKET/);
  });

  it("requires private HTTPS production configuration without reflecting endpoint credentials", () => {
    expect(() => loadTenantBackupCatalogConfig(base, {
      production: true,
      store: "mysql",
    })).toThrow(/PRIVATE_BUCKET_ACK=1/);
    expect(() => loadTenantBackupCatalogConfig({
      ...base,
      BACKUP_CATALOG_S3_PRIVATE_BUCKET_ACK: "1",
    }, {
      production: true,
      store: "mysql",
    })).toThrow(/must use https/);
    expect(() => loadTenantBackupCatalogConfig({
      ...base,
      BACKUP_CATALOG_S3_ENDPOINT: "https://objects.example.invalid",
      BACKUP_CATALOG_S3_PRIVATE_BUCKET_ACK: "1",
    }, {
      production: true,
      store: "mysql",
    })).not.toThrow();

    const privateValue = "private-fixture-marker";
    let message = "";
    try {
      loadTenantBackupCatalogConfig({
        ...base,
        BACKUP_CATALOG_S3_ENDPOINT: `https://user:${privateValue}@objects.invalid`,
      }, localContext);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/credential-free/);
    expect(message).not.toContain(privateValue);
  });

  it("requires paired static credentials and rejects a session token without them", () => {
    expect(() => loadTenantBackupCatalogConfig({
      ...base,
      BACKUP_CATALOG_S3_SECRET_ACCESS_KEY: undefined,
    }, localContext)).toThrow(/must be configured together/);
    expect(() => loadTenantBackupCatalogConfig({
      ...base,
      BACKUP_CATALOG_S3_ACCESS_KEY_ID: undefined,
      BACKUP_CATALOG_S3_SECRET_ACCESS_KEY: undefined,
      BACKUP_CATALOG_S3_SESSION_TOKEN: "fixture-session-token",
    }, localContext)).toThrow(/requires static S3 credentials/);
  });

  it("requires both retention controls only at activation", () => {
    const withoutRetention = {
      ...base,
      BACKUP_CATALOG_MINIMUM_RETENTION_MS: undefined,
      BACKUP_CATALOG_MINIMUM_RECOVERABLE_BACKUPS: undefined,
    };
    expect(loadTenantBackupCatalogConfig(withoutRetention, localContext))
      .not.toHaveProperty("retentionPolicySha256");
    expect(() => loadTenantBackupCatalogConfig(withoutRetention, {
      ...localContext,
      requireRetentionPolicy: true,
    })).toThrow(/required for activation/);
    expect(() => loadTenantBackupCatalogConfig({
      ...withoutRetention,
      BACKUP_CATALOG_MINIMUM_RETENTION_MS: "60000",
    }, {
      ...localContext,
      requireRetentionPolicy: true,
    })).toThrow(/required for activation/);
    expect(() => loadTenantBackupCatalogConfig(base, {
      ...localContext,
      requireRetentionPolicy: true,
    })).not.toThrow();
  });
});
