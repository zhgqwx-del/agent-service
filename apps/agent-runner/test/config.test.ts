import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const SECRET = "11".repeat(32);
const productionEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  STORE: "mysql",
  REDIS_URL: "redis://redis:6379",
  SECRETS_MASTER_KEY: SECRET,
  RUNNER_ADDR: "runner-a.internal:8787",
  INTERNAL_ROUTER_TOKEN: "production-internal-router-token-0001",
};

describe("runner configuration", () => {
  it("keeps the process-based development default on a locally routable bind host", () => {
    const cfg = loadConfig({ SECRETS_MASTER_KEY: SECRET });
    expect(cfg.RUNNER_ID).toBe(`runner-${process.pid}`);
    expect(cfg.runnerAddr).toBe("127.0.0.1:8787");
    expect(cfg.LIFECYCLE_OUTBOX_BATCH_SIZE).toBe(50);
    expect(cfg.LIFECYCLE_OUTBOX_LEASE_MS).toBe(10_000);
    expect(cfg.BLOB_FILESYSTEM_SINGLE_RUNNER).toBe(false);
    expect(cfg.BLOB_ATTACHMENTS_ENABLED).toBe(false);
    expect(cfg.BLOB_CLEANUP_ENABLED).toBe(false);
    expect(cfg.DATA_ERASURE_REQUESTS_ENABLED).toBe(false);
    expect(cfg.TENANT_ERASURE_REQUESTS_ENABLED).toBe(false);
    expect(cfg.TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED).toBe(false);
    expect(cfg.TENANT_RUNTIME_DRAIN_ENABLED).toBe(false);
    expect(cfg.TENANT_RUNTIME_REVOCATION_WORKER_ENABLED).toBe(false);
    expect(cfg.TENANT_RUNTIME_DRAIN_TIMEOUT_MS).toBe(10_000);
    expect(cfg.TENANT_RUNTIME_REVOCATION_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(cfg.TENANT_RUNTIME_REVOCATION_WORKER_BATCH_SIZE).toBe(5);
    expect(cfg.TENANT_RUNTIME_REVOCATION_MATERIALIZE_BATCH_SIZE).toBe(25);
    expect(cfg.TENANT_CONTENT_INVENTORY_WORKER_ENABLED).toBe(false);
    expect(cfg.TENANT_CONTENT_INVENTORY_WORKER_POLL_MS).toBe(1_000);
    expect(cfg.TENANT_CONTENT_INVENTORY_WORKER_LEASE_MS).toBe(30_000);
    expect(cfg.TENANT_CONTENT_INVENTORY_WORKER_BATCH_SIZE).toBe(5);
    expect(cfg.TENANT_CONTENT_INVENTORY_MATERIALIZE_BATCH_SIZE).toBe(25);
    expect(cfg.TENANT_CONTENT_INVENTORY_SESSION_PAGE_SIZE).toBe(100);
    expect(cfg.TENANT_ERASURE_BARRIER_TIMEOUT_MS).toBe(2_000);
    expect(cfg.DATA_GOVERNANCE_MANAGEMENT_ENABLED).toBe(false);
    expect(cfg.ERASURE_WORKER_ENABLED).toBe(false);
    expect(cfg.LEGACY_TOMBSTONE_COMPENSATION_ENABLED).toBe(false);
    expect(cfg.PURGE_POLICY_EVALUATOR_ENABLED).toBe(false);
    expect(cfg.DATA_EXPORT_REQUESTS_ENABLED).toBe(false);
    expect(cfg.DATA_EXPORT_WORKER_ENABLED).toBe(false);
    expect(cfg.DATA_EXPORT_CLEANUP_ENABLED).toBe(false);
    expect(cfg.dataExportArtifactsReadable).toBe(false);
    expect(cfg.DATA_EXPORT_WORKER_POLL_MS).toBe(1_000);
    expect(cfg.DATA_EXPORT_WORKER_LEASE_MS).toBe(30_000);
    expect(cfg.DATA_EXPORT_WORKER_BATCH_SIZE).toBe(5);
    expect(cfg.DATA_EXPORT_SNAPSHOT_PAGE_SIZE).toBe(200);
    expect(cfg.DATA_EXPORT_ARTIFACT_STAGING_TTL_MS).toBe(15 * 60_000);
    expect(cfg.DATA_EXPORT_CLEANUP_POLL_MS).toBe(1_000);
    expect(cfg.DATA_EXPORT_CLEANUP_LEASE_MS).toBe(30_000);
    expect(cfg.DATA_EXPORT_CLEANUP_BATCH_SIZE).toBe(50);
    expect(cfg.DATA_EXPORT_DOWNLOAD_LEASE_MS).toBe(30_000);
    expect(cfg.ERASURE_ROUTER_URL).toBeUndefined();
    expect(cfg.ERASURE_WORKER_POLL_MS).toBe(1_000);
    expect(cfg.ERASURE_WORKER_LEASE_MS).toBe(30_000);
    expect(cfg.ERASURE_WORKER_BATCH_SIZE).toBe(10);
    expect(cfg.ERASURE_WORKER_SESSION_PAGE_SIZE).toBe(100);
    expect(cfg.ERASURE_WORKER_RETRY_BASE_MS).toBe(1_000);
    expect(cfg.ERASURE_WORKER_RETRY_MAX_MS).toBe(60_000);
    expect(cfg.LEGACY_TOMBSTONE_COMPENSATION_POLL_MS).toBe(1_000);
    expect(cfg.LEGACY_TOMBSTONE_COMPENSATION_LEASE_MS).toBe(30_000);
    expect(cfg.LEGACY_TOMBSTONE_COMPENSATION_BATCH_SIZE).toBe(10);
    expect(cfg.LEGACY_TOMBSTONE_COMPENSATION_RETRY_BASE_MS).toBe(1_000);
    expect(cfg.LEGACY_TOMBSTONE_COMPENSATION_RETRY_MAX_MS).toBe(60_000);
    expect(cfg.PURGE_POLICY_EVALUATOR_POLL_MS).toBe(1_000);
    expect(cfg.PURGE_POLICY_EVALUATOR_LEASE_MS).toBe(30_000);
    expect(cfg.PURGE_POLICY_EVALUATOR_BATCH_SIZE).toBe(10);
    expect(cfg.PURGE_POLICY_EVALUATOR_TARGET_PAGE_SIZE).toBe(100);
    expect(cfg.PURGE_POLICY_EVALUATOR_RETRY_BASE_MS).toBe(1_000);
    expect(cfg.PURGE_POLICY_EVALUATOR_RETRY_MAX_MS).toBe(60_000);
    expect(cfg.ERASURE_DRAIN_TIMEOUT_MS).toBe(10_000);
    expect(cfg.ERASURE_WORKER_REQUEST_TIMEOUT_MS).toBe(20_000);
    expect(cfg.BLOB_MAX_BYTES).toBe(1_000_000);
    expect(cfg.BLOB_MAX_HYDRATED_BYTES).toBe(4_000_000);
  });

  it("keeps subject erasure requests behind an explicit boolean gate", () => {
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      DATA_ERASURE_REQUESTS_ENABLED: "1",
    })).toThrow(/ERASURE_WORKER_ENABLED=1 is required/);
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      ERASURE_WORKER_ENABLED: "1",
    })).toThrow(/ERASURE_ROUTER_URL is required/);
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      LEGACY_TOMBSTONE_COMPENSATION_ENABLED: "1",
    })).toThrow(/ERASURE_ROUTER_URL is required/);
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      DATA_ERASURE_REQUESTS_ENABLED: "1",
      ERASURE_WORKER_ENABLED: "1",
      ERASURE_ROUTER_URL: "http://127.0.0.1:8080/",
    })).toThrow(/LEGACY_TOMBSTONE_COMPENSATION_ENABLED=1 is required/);
    const enabled = loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      DATA_ERASURE_REQUESTS_ENABLED: "1",
      ERASURE_WORKER_ENABLED: "1",
      LEGACY_TOMBSTONE_COMPENSATION_ENABLED: "1",
      ERASURE_ROUTER_URL: "http://127.0.0.1:8080/",
    });
    expect(enabled.DATA_ERASURE_REQUESTS_ENABLED).toBe(true);
    expect(enabled.ERASURE_WORKER_ENABLED).toBe(true);
    expect(enabled.LEGACY_TOMBSTONE_COMPENSATION_ENABLED).toBe(true);
    expect(enabled.ERASURE_ROUTER_URL).toBe("http://127.0.0.1:8080");
    expect(() => loadConfig({ SECRETS_MASTER_KEY: SECRET, DATA_ERASURE_REQUESTS_ENABLED: "true" })).toThrow();
    expect(loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      DATA_GOVERNANCE_MANAGEMENT_ENABLED: "1",
    }).DATA_GOVERNANCE_MANAGEMENT_ENABLED).toBe(true);
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      DATA_GOVERNANCE_MANAGEMENT_ENABLED: "true",
    })).toThrow();
    expect(() => loadConfig({ SECRETS_MASTER_KEY: SECRET, ERASURE_WORKER_ENABLED: "true" })).toThrow();
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      LEGACY_TOMBSTONE_COMPENSATION_ENABLED: "true",
    })).toThrow();
  });

  it("accepts only a credential-free http(s) router origin", () => {
    for (const value of [
      "router.internal:8080",
      "file:///tmp/router",
      "https://user:secret@router.internal",
      "https://router.internal/private",
      "https://router.internal?target=private",
      "https://router.internal#private",
    ]) {
      expect(() => loadConfig({
        SECRETS_MASTER_KEY: SECRET,
        ERASURE_WORKER_ENABLED: "1",
        ERASURE_ROUTER_URL: value,
      })).toThrow(/ERASURE_ROUTER_URL/);
    }
    expect(loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      ERASURE_WORKER_ENABLED: "1",
      ERASURE_ROUTER_URL: "https://router.internal:8443/",
    }).ERASURE_ROUTER_URL).toBe("https://router.internal:8443");
  });

  it("keeps tenant erasure behind an independent runner gate and bounded fresh barrier", () => {
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      TENANT_ERASURE_OPERATOR_TOKEN: "tenant-erasure-operator-token-0001",
    })).toThrow(/router-only/);
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      TENANT_ERASURE_OPERATOR_ID: "platform-lifecycle-admin",
    })).toThrow(/router-only/);
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      TENANT_ERASURE_REQUESTS_ENABLED: "1",
    })).toThrow(/ERASURE_ROUTER_URL is required/);
    const enabled = loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      TENANT_ERASURE_REQUESTS_ENABLED: "1",
      TENANT_ERASURE_BARRIER_TIMEOUT_MS: "2500",
      ERASURE_ROUTER_URL: "https://router.internal:8443/",
    });
    expect(enabled.TENANT_ERASURE_REQUESTS_ENABLED).toBe(true);
    expect(enabled.TENANT_ERASURE_BARRIER_TIMEOUT_MS).toBe(2_500);
    expect(enabled.ERASURE_ROUTER_URL).toBe("https://router.internal:8443");
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      TENANT_ERASURE_REQUESTS_ENABLED: "true",
    })).toThrow();
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      TENANT_ERASURE_BARRIER_TIMEOUT_MS: "99",
    })).toThrow();
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      TENANT_ERASURE_BARRIER_TIMEOUT_MS: "10001",
    })).toThrow();
  });

  it("keeps tenant credential revocation behind an independent default-off worker gate", () => {
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED: "1",
    })).toThrow(/ERASURE_ROUTER_URL is required/);
    const enabled = loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED: "1",
      ERASURE_ROUTER_URL: "https://router.internal:8443/",
    });
    expect(enabled.TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED).toBe(true);
    expect(enabled.TENANT_ERASURE_REQUESTS_ENABLED).toBe(false);
    expect(enabled.PURGE_POLICY_EVALUATOR_ENABLED).toBe(false);
    expect(enabled.ERASURE_ROUTER_URL).toBe("https://router.internal:8443");
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED: "true",
    })).toThrow();
  });

  it("separates the T3b local endpoint from its embedded claimant and validates their bounds", () => {
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      TENANT_RUNTIME_DRAIN_ENABLED: "1",
    })).toThrow(/RUNNER_ID is required/);
    const endpointOnly = loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      TENANT_RUNTIME_DRAIN_ENABLED: "1",
      RUNNER_ID: "runner-local-a",
    });
    expect(endpointOnly.TENANT_RUNTIME_DRAIN_ENABLED).toBe(true);
    expect(endpointOnly.TENANT_RUNTIME_REVOCATION_WORKER_ENABLED).toBe(false);
    expect(endpointOnly.ERASURE_ROUTER_URL).toBeUndefined();

    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      TENANT_RUNTIME_REVOCATION_WORKER_ENABLED: "1",
      ERASURE_ROUTER_URL: "https://router.internal:8443",
    })).toThrow(/TENANT_RUNTIME_DRAIN_ENABLED=1 is required/);
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      TENANT_RUNTIME_DRAIN_ENABLED: "1",
      TENANT_RUNTIME_REVOCATION_WORKER_ENABLED: "1",
      RUNNER_ID: "runner-local-a",
    })).toThrow(/ERASURE_ROUTER_URL is required/);

    const enabled = loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      TENANT_RUNTIME_DRAIN_ENABLED: "1",
      RUNNER_ID: "runner-local-a",
      TENANT_RUNTIME_REVOCATION_WORKER_ENABLED: "1",
      TENANT_RUNTIME_DRAIN_TIMEOUT_MS: "1000",
      TENANT_RUNTIME_REVOCATION_REQUEST_TIMEOUT_MS: "2500",
      TENANT_RUNTIME_REVOCATION_WORKER_BATCH_SIZE: "7",
      TENANT_RUNTIME_REVOCATION_MATERIALIZE_BATCH_SIZE: "11",
      ERASURE_ROUTER_URL: "https://router.internal:8443/",
    });
    expect(enabled.TENANT_RUNTIME_REVOCATION_WORKER_ENABLED).toBe(true);
    expect(enabled.TENANT_RUNTIME_REVOCATION_WORKER_BATCH_SIZE).toBe(7);
    expect(enabled.TENANT_RUNTIME_REVOCATION_MATERIALIZE_BATCH_SIZE).toBe(11);
    expect(enabled.ERASURE_ROUTER_URL).toBe("https://router.internal:8443");

    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      TENANT_RUNTIME_DRAIN_TIMEOUT_MS: "1000",
      TENANT_RUNTIME_REVOCATION_REQUEST_TIMEOUT_MS: "2000",
    })).toThrow(/TENANT_RUNTIME_REVOCATION_REQUEST_TIMEOUT_MS/);
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      TENANT_RUNTIME_REVOCATION_RETRY_BASE_MS: "2",
      TENANT_RUNTIME_REVOCATION_RETRY_MAX_MS: "1",
    })).toThrow(/TENANT_RUNTIME_REVOCATION_RETRY_MAX_MS/);
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      TENANT_RUNTIME_DRAIN_ENABLED: "true",
      RUNNER_ID: "runner-local-a",
    })).toThrow();
  });

  it("keeps the non-destructive T3c inventory worker independently default-off", () => {
    const enabled = loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      TENANT_CONTENT_INVENTORY_WORKER_ENABLED: "1",
      TENANT_CONTENT_INVENTORY_WORKER_BATCH_SIZE: "7",
      TENANT_CONTENT_INVENTORY_MATERIALIZE_BATCH_SIZE: "11",
      TENANT_CONTENT_INVENTORY_SESSION_PAGE_SIZE: "13",
    });
    expect(enabled.TENANT_CONTENT_INVENTORY_WORKER_ENABLED).toBe(true);
    expect(enabled.TENANT_CONTENT_INVENTORY_WORKER_BATCH_SIZE).toBe(7);
    expect(enabled.TENANT_CONTENT_INVENTORY_MATERIALIZE_BATCH_SIZE).toBe(11);
    expect(enabled.TENANT_CONTENT_INVENTORY_SESSION_PAGE_SIZE).toBe(13);
    expect(enabled.ERASURE_ROUTER_URL).toBeUndefined();
    expect(enabled.TENANT_RUNTIME_REVOCATION_WORKER_ENABLED).toBe(false);
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      TENANT_CONTENT_INVENTORY_RETRY_BASE_MS: "2",
      TENANT_CONTENT_INVENTORY_RETRY_MAX_MS: "1",
    })).toThrow(/TENANT_CONTENT_INVENTORY_RETRY_MAX_MS/);
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      TENANT_CONTENT_INVENTORY_WORKER_ENABLED: "true",
    })).toThrow();
  });

  it("validates erasure worker bounds and retry ordering", () => {
    const base = {
      SECRETS_MASTER_KEY: SECRET,
      ERASURE_WORKER_ENABLED: "1",
      ERASURE_ROUTER_URL: "http://router.internal:8080",
    };
    expect(() => loadConfig({ ...base, ERASURE_WORKER_POLL_MS: "0" })).toThrow();
    expect(() => loadConfig({ ...base, ERASURE_WORKER_LEASE_MS: "99" })).toThrow();
    expect(() => loadConfig({ ...base, ERASURE_WORKER_BATCH_SIZE: "101" })).toThrow();
    expect(() => loadConfig({ ...base, ERASURE_WORKER_SESSION_PAGE_SIZE: "201" })).toThrow();
    expect(() => loadConfig({ ...base, ERASURE_WORKER_REQUEST_TIMEOUT_MS: "99" })).toThrow();
    expect(() => loadConfig({ ...base, ERASURE_WORKER_REQUEST_TIMEOUT_MS: "30001" })).toThrow();
    expect(() => loadConfig({
      ...base,
      ERASURE_DRAIN_TIMEOUT_MS: "1000",
      ERASURE_WORKER_REQUEST_TIMEOUT_MS: "2000",
    })).toThrow(/must be greater than ERASURE_DRAIN_TIMEOUT_MS/);
    expect(loadConfig({
      ...base,
      ERASURE_DRAIN_TIMEOUT_MS: "1000",
      ERASURE_WORKER_REQUEST_TIMEOUT_MS: "2001",
    }).ERASURE_WORKER_REQUEST_TIMEOUT_MS).toBe(2001);
    expect(() => loadConfig({
      ...base,
      ERASURE_WORKER_RETRY_BASE_MS: "2",
      ERASURE_WORKER_RETRY_MAX_MS: "1",
    })).toThrow(/ERASURE_WORKER_RETRY_MAX_MS/);
  });

  it("validates legacy tombstone compensation worker bounds and retry ordering", () => {
    const base = {
      SECRETS_MASTER_KEY: SECRET,
      LEGACY_TOMBSTONE_COMPENSATION_ENABLED: "1",
      ERASURE_ROUTER_URL: "http://router.internal:8080",
    };
    expect(() => loadConfig({ ...base, LEGACY_TOMBSTONE_COMPENSATION_POLL_MS: "0" })).toThrow();
    expect(() => loadConfig({ ...base, LEGACY_TOMBSTONE_COMPENSATION_LEASE_MS: "99" })).toThrow();
    expect(() => loadConfig({ ...base, LEGACY_TOMBSTONE_COMPENSATION_BATCH_SIZE: "101" })).toThrow();
    expect(() => loadConfig({
      ...base,
      LEGACY_TOMBSTONE_COMPENSATION_RETRY_BASE_MS: "2",
      LEGACY_TOMBSTONE_COMPENSATION_RETRY_MAX_MS: "1",
    })).toThrow(/LEGACY_TOMBSTONE_COMPENSATION_RETRY_MAX_MS/);
  });

  it("keeps purge-policy evaluation behind an independent default-off gate", () => {
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      PURGE_POLICY_EVALUATOR_ENABLED: "1",
    })).toThrow(/ERASURE_ROUTER_URL is required/);
    const enabled = loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      PURGE_POLICY_EVALUATOR_ENABLED: "1",
      ERASURE_ROUTER_URL: "http://router.internal:8080/",
    });
    expect(enabled.PURGE_POLICY_EVALUATOR_ENABLED).toBe(true);
    expect(enabled.ERASURE_WORKER_ENABLED).toBe(false);
    expect(enabled.DATA_ERASURE_REQUESTS_ENABLED).toBe(false);
    expect(enabled.DATA_GOVERNANCE_MANAGEMENT_ENABLED).toBe(false);
    expect(enabled.ERASURE_ROUTER_URL).toBe("http://router.internal:8080");
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      PURGE_POLICY_EVALUATOR_ENABLED: "true",
    })).toThrow();
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      PURGE_POLICY_EVALUATOR_POLL_MS: "0",
    })).toThrow();
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      PURGE_POLICY_EVALUATOR_LEASE_MS: "99",
    })).toThrow();
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      PURGE_POLICY_EVALUATOR_BATCH_SIZE: "101",
    })).toThrow();
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      PURGE_POLICY_EVALUATOR_TARGET_PAGE_SIZE: "1001",
    })).toThrow();
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      PURGE_POLICY_EVALUATOR_RETRY_BASE_MS: "2",
      PURGE_POLICY_EVALUATOR_RETRY_MAX_MS: "1",
    })).toThrow(/PURGE_POLICY_EVALUATOR_RETRY_MAX_MS/);
  });

  it("keeps export admission separate from draining accepted jobs and enforces local filesystem ownership", () => {
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      DATA_EXPORT_REQUESTS_ENABLED: "1",
    })).toThrow(/DATA_EXPORT_WORKER_ENABLED=1 is required/);
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      DATA_EXPORT_WORKER_ENABLED: "1",
    })).toThrow(/DATA_EXPORT_CLEANUP_ENABLED=1 is required/);
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      DATA_EXPORT_CLEANUP_ENABLED: "1",
    })).toThrow(/BLOB_FILESYSTEM_SINGLE_RUNNER=1 is required/);

    const drainOnly = loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      BLOB_FILESYSTEM_SINGLE_RUNNER: "1",
      DATA_EXPORT_WORKER_ENABLED: "1",
      DATA_EXPORT_CLEANUP_ENABLED: "1",
    });
    expect(drainOnly.DATA_EXPORT_REQUESTS_ENABLED).toBe(false);
    expect(drainOnly.DATA_EXPORT_WORKER_ENABLED).toBe(true);
    expect(drainOnly.DATA_EXPORT_CLEANUP_ENABLED).toBe(true);
    expect(drainOnly.dataExportArtifactsReadable).toBe(true);

    const admitted = loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      BLOB_FILESYSTEM_SINGLE_RUNNER: "1",
      DATA_EXPORT_REQUESTS_ENABLED: "1",
      DATA_EXPORT_WORKER_ENABLED: "1",
      DATA_EXPORT_CLEANUP_ENABLED: "1",
    });
    expect(admitted.DATA_EXPORT_REQUESTS_ENABLED).toBe(true);
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      BLOB_FILESYSTEM_SINGLE_RUNNER: "1",
      DATA_EXPORT_REQUESTS_ENABLED: "true",
    })).toThrow();
  });

  it("validates export worker, cleanup and download bounds", () => {
    expect(() => loadConfig({ SECRETS_MASTER_KEY: SECRET, DATA_EXPORT_WORKER_POLL_MS: "0" })).toThrow();
    expect(() => loadConfig({ SECRETS_MASTER_KEY: SECRET, DATA_EXPORT_WORKER_LEASE_MS: "99" })).toThrow();
    expect(() => loadConfig({ SECRETS_MASTER_KEY: SECRET, DATA_EXPORT_WORKER_BATCH_SIZE: "101" })).toThrow();
    expect(() => loadConfig({ SECRETS_MASTER_KEY: SECRET, DATA_EXPORT_SNAPSHOT_PAGE_SIZE: "1001" })).toThrow();
    expect(() => loadConfig({ SECRETS_MASTER_KEY: SECRET, DATA_EXPORT_ARTIFACT_STAGING_TTL_MS: "999" })).toThrow();
    expect(() => loadConfig({ SECRETS_MASTER_KEY: SECRET, DATA_EXPORT_CLEANUP_LEASE_MS: "99" })).toThrow();
    expect(() => loadConfig({ SECRETS_MASTER_KEY: SECRET, DATA_EXPORT_CLEANUP_BATCH_SIZE: "101" })).toThrow();
    expect(() => loadConfig({ SECRETS_MASTER_KEY: SECRET, DATA_EXPORT_DOWNLOAD_LEASE_MS: "999" })).toThrow();
    expect(() => loadConfig({ SECRETS_MASTER_KEY: SECRET, DATA_EXPORT_DOWNLOAD_LEASE_MS: "60001" })).toThrow();
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      DATA_EXPORT_WORKER_RETRY_BASE_MS: "2",
      DATA_EXPORT_WORKER_RETRY_MAX_MS: "1",
    })).toThrow(/DATA_EXPORT_WORKER_RETRY_MAX_MS/);
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      DATA_EXPORT_CLEANUP_RETRY_BASE_MS: "2",
      DATA_EXPORT_CLEANUP_RETRY_MAX_MS: "1",
    })).toThrow(/DATA_EXPORT_CLEANUP_RETRY_MAX_MS/);
  });

  it("validates lifecycle outbox worker bounds", () => {
    expect(() => loadConfig({ SECRETS_MASTER_KEY: SECRET, LIFECYCLE_OUTBOX_BATCH_SIZE: "101" })).toThrow();
    expect(() => loadConfig({ SECRETS_MASTER_KEY: SECRET, LIFECYCLE_OUTBOX_LEASE_MS: "0" })).toThrow();
  });

  it("uses explicit default-off blob gates and requires cleanup before accepting writes", () => {
    expect(() => loadConfig({ SECRETS_MASTER_KEY: SECRET, BLOB_ATTACHMENTS_ENABLED: "true" })).toThrow();
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      BLOB_ATTACHMENTS_ENABLED: "1",
      BLOB_FILESYSTEM_SINGLE_RUNNER: "1",
    })).toThrow(
      /BLOB_CLEANUP_ENABLED=1 is required/,
    );
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      BLOB_CLEANUP_ENABLED: "1",
    })).toThrow(/BLOB_FILESYSTEM_SINGLE_RUNNER=1 is required/);
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      BLOB_CLEANUP_ENABLED: "1",
      BLOB_ATTACHMENTS_ENABLED: "1",
    })).toThrow(/BLOB_FILESYSTEM_SINGLE_RUNNER=1 is required/);
    const cfg = loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      BLOB_FILESYSTEM_SINGLE_RUNNER: "1",
      BLOB_CLEANUP_ENABLED: "1",
      BLOB_ATTACHMENTS_ENABLED: "1",
    });
    expect(cfg.BLOB_FILESYSTEM_SINGLE_RUNNER).toBe(true);
    expect(cfg.BLOB_CLEANUP_ENABLED).toBe(true);
    expect(cfg.BLOB_ATTACHMENTS_ENABLED).toBe(true);
  });

  it("validates blob allocation and cleanup worker bounds", () => {
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      MAX_BODY_BYTES: "99",
      BLOB_MAX_BYTES: "100",
      BLOB_TOOL_OUTPUT_THRESHOLD_BYTES: "1",
    })).toThrow(/BLOB_MAX_BYTES must not exceed MAX_BODY_BYTES/);
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      BLOB_MAX_BYTES: "100",
      BLOB_MAX_HYDRATED_BYTES: "99",
      BLOB_TOOL_OUTPUT_THRESHOLD_BYTES: "1",
    })).toThrow(/BLOB_MAX_HYDRATED_BYTES/);
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      BLOB_MAX_BYTES: "100",
      BLOB_TOOL_OUTPUT_THRESHOLD_BYTES: "101",
    })).toThrow(/BLOB_TOOL_OUTPUT_THRESHOLD_BYTES/);
    expect(() => loadConfig({ SECRETS_MASTER_KEY: SECRET, BLOB_CLEANUP_BATCH_SIZE: "101" })).toThrow();
    expect(() => loadConfig({
      SECRETS_MASTER_KEY: SECRET,
      BLOB_CLEANUP_RETRY_BASE_MS: "2",
      BLOB_CLEANUP_RETRY_MAX_MS: "1",
    })).toThrow(/BLOB_CLEANUP_RETRY_MAX_MS/);
  });

  it("generates a globally unique process identity in production", () => {
    const first = loadConfig(productionEnv);
    const second = loadConfig(productionEnv);
    expect(first.RUNNER_ID).toMatch(/^runner-[0-9a-f-]{36}$/);
    expect(second.RUNNER_ID).not.toBe(first.RUNNER_ID);
    expect(first.runnerAddr).toBe("runner-a.internal:8787");
  });

  it("preserves an explicitly assigned production identity", () => {
    expect(loadConfig({ ...productionEnv, RUNNER_ID: "runner-a" }).RUNNER_ID).toBe("runner-a");
    expect(() => loadConfig({ ...productionEnv, RUNNER_ID: "runner a" })).toThrow();
  });

  it("requires an explicit advertised address in production", () => {
    expect(() => loadConfig({ ...productionEnv, RUNNER_ADDR: undefined })).toThrow(/RUNNER_ADDR is required in production/);
  });

  it("requires an explicit internal router credential in production", () => {
    expect(() => loadConfig({ ...productionEnv, INTERNAL_ROUTER_TOKEN: undefined })).toThrow(
      /INTERNAL_ROUTER_TOKEN is required in production/,
    );
  });

  it("fails closed when production blob writes or cleanup would use the local filesystem adapter", () => {
    expect(() => loadConfig({
      ...productionEnv,
      BLOB_FILESYSTEM_SINGLE_RUNNER: "1",
      BLOB_CLEANUP_ENABLED: "1",
      BLOB_ATTACHMENTS_ENABLED: "1",
    })).toThrow(/shared object-store adapter/);
    expect(() => loadConfig({
      ...productionEnv,
      BLOB_FILESYSTEM_SINGLE_RUNNER: "1",
      BLOB_CLEANUP_ENABLED: "1",
    })).toThrow(/shared object-store adapter/);
  });

  it("fails closed when production export would use the local filesystem adapter", () => {
    expect(loadConfig(productionEnv).dataExportArtifactsReadable).toBe(false);
    expect(loadConfig({
      ...productionEnv,
      BLOB_FILESYSTEM_SINGLE_RUNNER: "1",
    }).dataExportArtifactsReadable).toBe(false);
    for (const flag of [
      "DATA_EXPORT_REQUESTS_ENABLED",
      "DATA_EXPORT_WORKER_ENABLED",
      "DATA_EXPORT_CLEANUP_ENABLED",
    ] as const) {
      expect(() => loadConfig({
        ...productionEnv,
        BLOB_FILESYSTEM_SINGLE_RUNNER: "1",
        [flag]: "1",
      })).toThrow(/shared object-store adapter/);
    }
  });

  it("never advertises a wildcard bind address", () => {
    expect(() => loadConfig({ SECRETS_MASTER_KEY: SECRET, RUNNER_HOST: "0.0.0.0" })).toThrow(/RUNNER_ADDR is required/);
    expect(() => loadConfig({ ...productionEnv, RUNNER_ADDR: "0.0.0.0:8787" })).toThrow(/not a wildcard/);
    expect(() => loadConfig({ ...productionEnv, RUNNER_ADDR: "file:///tmp/runner" })).toThrow(/must use http or https/);
  });

  it("rejects the development bootstrap key in production", () => {
    expect(() => loadConfig({ ...productionEnv, BOOTSTRAP_API_KEY: "must-not-work" })).toThrow(/BOOTSTRAP_API_KEY must not be set/);
  });
});
