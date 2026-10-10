import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const SECRET = "11".repeat(32);
const journal = {
  SECRETS_MASTER_KEY: SECRET,
  STORE: "mysql",
  RESTORE_JOURNAL_ADAPTER: "s3",
  RESTORE_JOURNAL_DATABASE_NAMESPACE_ID: "agent-service-local-db-v1",
  RESTORE_JOURNAL_RUNTIME_EPOCH_ID: "local-primary-epoch-v1",
  RESTORE_JOURNAL_NAMESPACE_ID: "agent-service-restore-set-v1",
  RESTORE_JOURNAL_FAILURE_DOMAIN_ID: "local-minio-fixture-only",
  RESTORE_JOURNAL_INDEPENDENT_FAILURE_DOMAIN_ACK: "1",
  RESTORE_JOURNAL_S3_ENDPOINT: "http://127.0.0.1:9000",
  RESTORE_JOURNAL_S3_BUCKET: "agent-service-restore-journal-test",
  RESTORE_JOURNAL_S3_FORCE_PATH_STYLE: "1",
} satisfies NodeJS.ProcessEnv;

describe("runner restore journal gates", () => {
  it("keeps the feature dormant by default", () => {
    const config = loadConfig({ SECRETS_MASTER_KEY: SECRET });
    expect(config.tenantRestoreJournal).toBeUndefined();
    expect(config.TENANT_RESTORE_JOURNAL_WORKER_ENABLED).toBe(false);
    expect(config.TENANT_RESTORE_JOURNAL_WORKER_POLL_MS).toBe(1_000);
    expect(config.TENANT_RESTORE_JOURNAL_WORKER_LEASE_MS).toBe(30_000);
    expect(config.TENANT_RESTORE_JOURNAL_WORKER_BATCH_SIZE).toBe(5);
    expect(config.TENANT_RESTORE_JOURNAL_MATERIALIZE_BATCH_SIZE).toBe(25);
  });

  it("advertises configured content-free identities independently from worker activation", () => {
    const config = loadConfig(journal);
    expect(config.TENANT_RESTORE_JOURNAL_WORKER_ENABLED).toBe(false);
    expect(config.tenantRestoreJournal).toMatchObject({
      journalNamespaceSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      logicalDatabaseNamespaceSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      runtimeEpochSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      targetRootSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("requires a fresh router boundary and a lease longer than gate plus S3 deadline", () => {
    expect(() => loadConfig({
      ...journal,
      TENANT_RESTORE_JOURNAL_WORKER_ENABLED: "1",
    })).toThrow(/ERASURE_ROUTER_URL/);
    expect(() => loadConfig({
      ...journal,
      TENANT_RESTORE_JOURNAL_WORKER_ENABLED: "1",
      ERASURE_ROUTER_URL: "http://127.0.0.1:8080",
      TENANT_RESTORE_JOURNAL_WORKER_LEASE_MS: "7999",
    })).toThrow(/must cover/);
    const enabled = loadConfig({
      ...journal,
      TENANT_RESTORE_JOURNAL_WORKER_ENABLED: "1",
      ERASURE_ROUTER_URL: "http://127.0.0.1:8080",
      TENANT_RESTORE_JOURNAL_WORKER_LEASE_MS: "8000",
      TENANT_RESTORE_JOURNAL_WORKER_POLL_MS: "17",
      TENANT_RESTORE_JOURNAL_WORKER_BATCH_SIZE: "7",
      TENANT_RESTORE_JOURNAL_MATERIALIZE_BATCH_SIZE: "11",
      TENANT_RESTORE_JOURNAL_RETRY_BASE_MS: "23",
      TENANT_RESTORE_JOURNAL_RETRY_MAX_MS: "29",
    });
    expect(enabled).toMatchObject({
      TENANT_RESTORE_JOURNAL_WORKER_ENABLED: true,
      TENANT_RESTORE_JOURNAL_WORKER_LEASE_MS: 8_000,
      TENANT_RESTORE_JOURNAL_WORKER_POLL_MS: 17,
      TENANT_RESTORE_JOURNAL_WORKER_BATCH_SIZE: 7,
      TENANT_RESTORE_JOURNAL_MATERIALIZE_BATCH_SIZE: 11,
      TENANT_RESTORE_JOURNAL_RETRY_BASE_MS: 23,
      TENANT_RESTORE_JOURNAL_RETRY_MAX_MS: 29,
    });
  });

  it("never permits the restore journal to share the Blob bucket", () => {
    expect(() => loadConfig({
      ...journal,
      BLOB_STORE: "s3",
      BLOB_NAMESPACE_ID: "blob-v1",
      BLOB_S3_BUCKET: journal.RESTORE_JOURNAL_S3_BUCKET,
      BLOB_STORAGE_CONTROL_ENABLED: "1",
    })).toThrow(/distinct from BLOB_S3_BUCKET/);
  });
});
