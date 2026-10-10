import { describe, expect, it } from "vitest";
import {
  S3_TENANT_RESTORE_JOURNAL_PROTOCOL,
  tenantRestoreJournalTargetRootSha256,
} from "@agent-service/store";
import {
  createTenantRestoreJournalAdapters,
  loadTenantRestoreJournalConfig,
} from "../src/tenant-restore-journal-config.js";

const base = {
  RESTORE_JOURNAL_ADAPTER: "s3",
  RESTORE_JOURNAL_DATABASE_NAMESPACE_ID: "agent-service-local-db-v1",
  RESTORE_JOURNAL_RUNTIME_EPOCH_ID: "local-primary-epoch-v1",
  RESTORE_JOURNAL_NAMESPACE_ID: "agent-service-restore-set-v1",
  RESTORE_JOURNAL_FAILURE_DOMAIN_ID: "local-minio-fixture-only",
  RESTORE_JOURNAL_INDEPENDENT_FAILURE_DOMAIN_ACK: "1",
  RESTORE_JOURNAL_S3_ENDPOINT: "http://127.0.0.1:9000",
  RESTORE_JOURNAL_S3_BUCKET: "agent-service-restore-journal-test",
  RESTORE_JOURNAL_S3_PREFIX: "journal/v1",
  RESTORE_JOURNAL_S3_FORCE_PATH_STYLE: "1",
  RESTORE_JOURNAL_S3_ACCESS_KEY_ID: "fixture-access",
  RESTORE_JOURNAL_S3_SECRET_ACCESS_KEY: "fixture-secret",
} satisfies NodeJS.ProcessEnv;

const localContext = { production: false, store: "mysql" as const };

describe("tenant restore journal runtime configuration", () => {
  it("is default-dormant and rejects stray target settings", () => {
    expect(loadTenantRestoreJournalConfig({}, localContext)).toBeUndefined();
    expect(() => loadTenantRestoreJournalConfig({
      RESTORE_JOURNAL_S3_BUCKET: "stray-bucket",
    }, localContext)).toThrow(/RESTORE_JOURNAL_ADAPTER=s3/);
  });

  it("derives only content-free fleet identities and constructs the configured adapter", async () => {
    const config = loadTenantRestoreJournalConfig(base, localContext)!;
    expect(config.adapterProtocol).toBe(S3_TENANT_RESTORE_JOURNAL_PROTOCOL);
    expect(config.journalNamespaceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(config.logicalDatabaseNamespaceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(config.runtimeEpochSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(config.targetRootSha256).toBe(tenantRestoreJournalTargetRootSha256(
      config.targets.map((target) => target.descriptor),
    ));
    expect(config.targets[0].descriptor).not.toHaveProperty("bucket");
    expect(config.targets[0].descriptor).not.toHaveProperty("endpoint");
    expect(config.targets[0].descriptor).not.toHaveProperty("credentials");
    expect(config.targets[0].options).toMatchObject({
      region: "us-east-1",
      endpoint: "http://127.0.0.1:9000",
      forcePathStyle: true,
    });
    expect(config.targets[0].options).not.toHaveProperty("clientConfig");
    const [adapter] = createTenantRestoreJournalAdapters(config);
    expect(adapter).toMatchObject({
      adapterProtocol: config.adapterProtocol,
      journalNamespaceSha256: config.journalNamespaceSha256,
      logicalDatabaseNamespaceSha256: config.logicalDatabaseNamespaceSha256,
      targetSha256: config.targets[0].descriptor.targetSha256,
      failureDomainSha256: config.targets[0].descriptor.failureDomainSha256,
    });
    await adapter!.close();
  });

  it("ignores AWS endpoint/profile settings and binds controlled region and endpoint identity", () => {
    const standard = loadTenantRestoreJournalConfig({
      ...base,
      RESTORE_JOURNAL_S3_ENDPOINT: undefined,
    }, localContext)!;
    const polluted = loadTenantRestoreJournalConfig({
      ...base,
      RESTORE_JOURNAL_S3_ENDPOINT: undefined,
      AWS_ENDPOINT_URL: "http://attacker.invalid:9000",
      AWS_ENDPOINT_URL_S3: "http://attacker-s3.invalid:9000",
      AWS_PROFILE: "endpoint-bearing-profile",
      AWS_USE_FIPS_ENDPOINT: "true",
      AWS_USE_DUALSTACK_ENDPOINT: "true",
      AWS_S3_ACCELERATE: "true",
    }, localContext)!;
    expect(polluted.targetRootSha256).toBe(standard.targetRootSha256);
    expect(polluted.targets[0].descriptor.targetSha256)
      .toBe(standard.targets[0].descriptor.targetSha256);

    const expected = loadTenantRestoreJournalConfig(base, localContext)!;
    const otherRegion = loadTenantRestoreJournalConfig({
      ...base,
      RESTORE_JOURNAL_S3_REGION: "us-west-2",
    }, localContext)!;
    const otherEndpoint = loadTenantRestoreJournalConfig({
      ...base,
      RESTORE_JOURNAL_S3_ENDPOINT: "http://127.0.0.1:9001",
    }, localContext)!;
    for (const changed of [otherRegion, otherEndpoint, standard]) {
      expect(changed.targets[0].descriptor.targetSha256)
        .not.toBe(expected.targets[0].descriptor.targetSha256);
      expect(changed.targetRootSha256).not.toBe(expected.targetRootSha256);
    }
  });

  it("requires a durable MySQL source and an explicit independent-domain acknowledgement", () => {
    expect(() => loadTenantRestoreJournalConfig(base, {
      production: false,
      store: "memory",
    })).toThrow(/STORE=mysql/);
    expect(() => loadTenantRestoreJournalConfig({
      ...base,
      RESTORE_JOURNAL_INDEPENDENT_FAILURE_DOMAIN_ACK: "0",
    }, localContext)).toThrow(/INDEPENDENT_FAILURE_DOMAIN_ACK=1/);
  });

  it("keeps the restore journal in a distinct bucket and validates static credentials", () => {
    expect(() => loadTenantRestoreJournalConfig(base, {
      ...localContext,
      blobS3Bucket: base.RESTORE_JOURNAL_S3_BUCKET,
    })).toThrow(/distinct from BLOB_S3_BUCKET/);
    expect(() => loadTenantRestoreJournalConfig({
      ...base,
      RESTORE_JOURNAL_S3_SECRET_ACCESS_KEY: undefined,
    }, localContext)).toThrow(/must be configured together/);
    expect(() => loadTenantRestoreJournalConfig({
      ...base,
      RESTORE_JOURNAL_S3_ACCESS_KEY_ID: undefined,
      RESTORE_JOURNAL_S3_SECRET_ACCESS_KEY: undefined,
      RESTORE_JOURNAL_S3_SESSION_TOKEN: "fixture-session",
    }, localContext)).toThrow(/requires static S3 credentials/);
  });

  it("requires private HTTPS production configuration and never echoes secret values", () => {
    expect(() => loadTenantRestoreJournalConfig(base, {
      production: true,
      store: "mysql",
    })).toThrow(/PRIVATE_BUCKET_ACK=1/);
    expect(() => loadTenantRestoreJournalConfig({
      ...base,
      RESTORE_JOURNAL_S3_PRIVATE_BUCKET_ACK: "1",
    }, {
      production: true,
      store: "mysql",
    })).toThrow(/must use https/);
    const privateValue = "do-not-echo-this-private-value";
    let message = "";
    try {
      loadTenantRestoreJournalConfig({
        ...base,
        RESTORE_JOURNAL_S3_ENDPOINT: `https://user:${privateValue}@objects.invalid`,
      }, localContext);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/credential-free/);
    expect(message).not.toContain(privateValue);
  });
});
