import { describe, expect, it } from "vitest";
import { loadRouterConfig } from "../src/config.js";

describe("router configuration", () => {
  it("keeps tombstone off until deployment explicitly activates it", () => {
    const local = loadRouterConfig({ RUNNERS: "http://runner:8787" });
    expect(local.SESSION_TOMBSTONE_ENABLED).toBe(false);
    expect(local.BLOB_FILESYSTEM_SINGLE_RUNNER).toBe(false);
    expect(local.BLOB_ATTACHMENTS_ENABLED).toBe(false);
    expect(local.DATA_ERASURE_REQUESTS_ENABLED).toBe(false);
    expect(local.TENANT_ERASURE_REQUESTS_ENABLED).toBe(false);
    expect(local.TENANT_ERASURE_OPERATOR_TOKEN).toBeUndefined();
    expect(local.TENANT_ERASURE_OPERATOR_ID).toBe("platform-lifecycle-admin");
    expect(local.DATA_GOVERNANCE_MANAGEMENT_ENABLED).toBe(false);
    expect(local.PURGE_POLICY_EVALUATOR_ENABLED).toBe(false);
    expect(local.TENANT_CREDENTIAL_REVOCATION_EXECUTION_ENABLED).toBe(false);
    expect(local.CREDENTIAL_LIFECYCLE_TRACKING_ENABLED).toBe(false);
    expect(local.TENANT_PURGE_EXECUTION_ENABLED).toBe(false);
    expect(local.TENANT_DATABASE_PURGE_ENABLED).toBe(false);
    expect(local.TENANT_REDIS_PURGE_ENABLED).toBe(false);
    expect(local.REDIS_PREFIX).toBe("as");
    expect(local.REDIS_NAMESPACE_ID).toBeUndefined();
    expect(local.TENANT_RUNTIME_DRAIN_EXECUTION_ENABLED).toBe(false);
    expect(local.DATA_EXPORT_REQUESTS_ENABLED).toBe(false);
    expect(local.dataExportArtifactsReadable).toBe(false);
    expect(local.BLOB_MAX_BYTES).toBe(1_000_000);
    expect(local.UPSTREAM_HEADER_TIMEOUT_MS).toBe(15_000);
    expect(local.INTERNAL_ROUTER_TOKEN.length).toBeGreaterThanOrEqual(32);
    expect(loadRouterConfig({
      RUNNERS: "http://runner:8787",
      SESSION_TOMBSTONE_ENABLED: "1",
    }).SESSION_TOMBSTONE_ENABLED).toBe(true);
    expect(() => loadRouterConfig({
      RUNNERS: "http://runner:8787",
      SESSION_TOMBSTONE_ENABLED: "true",
    })).toThrow();
    expect(loadRouterConfig({
      RUNNERS: "http://runner:8787",
      DATA_ERASURE_REQUESTS_ENABLED: "1",
    }).DATA_ERASURE_REQUESTS_ENABLED).toBe(true);
    expect(() => loadRouterConfig({
      RUNNERS: "http://runner:8787",
      DATA_ERASURE_REQUESTS_ENABLED: "true",
    })).toThrow();
    expect(loadRouterConfig({
      RUNNERS: "http://runner:8787",
      TENANT_ERASURE_REQUESTS_ENABLED: "1",
      TENANT_ERASURE_OPERATOR_TOKEN: "tenant-erasure-operator-token-0001",
    }).TENANT_ERASURE_REQUESTS_ENABLED).toBe(true);
    expect(() => loadRouterConfig({
      RUNNERS: "http://runner:8787",
      TENANT_ERASURE_REQUESTS_ENABLED: "true",
    })).toThrow();
    expect(loadRouterConfig({
      RUNNERS: "http://runner:8787",
      DATA_GOVERNANCE_MANAGEMENT_ENABLED: "1",
    }).DATA_GOVERNANCE_MANAGEMENT_ENABLED).toBe(true);
    expect(() => loadRouterConfig({
      RUNNERS: "http://runner:8787",
      DATA_GOVERNANCE_MANAGEMENT_ENABLED: "true",
    })).toThrow();
    expect(loadRouterConfig({
      RUNNERS: "http://runner:8787",
      PURGE_POLICY_EVALUATOR_ENABLED: "1",
    }).PURGE_POLICY_EVALUATOR_ENABLED).toBe(true);
    expect(() => loadRouterConfig({
      RUNNERS: "http://runner:8787",
      PURGE_POLICY_EVALUATOR_ENABLED: "true",
    })).toThrow();
    expect(() => loadRouterConfig({
      RUNNERS: "http://runner:8787",
      TENANT_CREDENTIAL_REVOCATION_EXECUTION_ENABLED: "1",
    })).toThrow(/CREDENTIAL_LIFECYCLE_TRACKING_ENABLED=1/);
    expect(loadRouterConfig({
      RUNNERS: "http://runner:8787",
      TENANT_CREDENTIAL_REVOCATION_EXECUTION_ENABLED: "1",
      CREDENTIAL_LIFECYCLE_TRACKING_ENABLED: "1",
    })).toMatchObject({
      TENANT_CREDENTIAL_REVOCATION_EXECUTION_ENABLED: true,
      CREDENTIAL_LIFECYCLE_TRACKING_ENABLED: true,
    });
    expect(() => loadRouterConfig({
      RUNNERS: "http://runner:8787",
      TENANT_CREDENTIAL_REVOCATION_EXECUTION_ENABLED: "true",
    })).toThrow();
    expect(loadRouterConfig({
      RUNNERS: "http://runner:8787",
      TENANT_PURGE_EXECUTION_ENABLED: "1",
    }).TENANT_PURGE_EXECUTION_ENABLED).toBe(true);
    expect(() => loadRouterConfig({
      RUNNERS: "http://runner:8787",
      TENANT_PURGE_EXECUTION_ENABLED: "true",
    })).toThrow();
    expect(loadRouterConfig({
      RUNNERS: "http://runner:8787",
      TENANT_DATABASE_PURGE_ENABLED: "1",
    }).TENANT_DATABASE_PURGE_ENABLED).toBe(true);
    expect(() => loadRouterConfig({
      RUNNERS: "http://runner:8787",
      TENANT_DATABASE_PURGE_ENABLED: "true",
    })).toThrow();
    expect(() => loadRouterConfig({
      RUNNERS: "http://runner:8787",
      TENANT_REDIS_PURGE_ENABLED: "1",
    })).toThrow(/REDIS_URL/);
    expect(() => loadRouterConfig({
      RUNNERS: "http://runner:8787",
      TENANT_REDIS_PURGE_ENABLED: "1",
      REDIS_URL: "redis://redis:6379",
    })).toThrow(/REDIS_NAMESPACE_ID/);
    expect(loadRouterConfig({
      RUNNERS: "http://runner:8787",
      TENANT_REDIS_PURGE_ENABLED: "1",
      REDIS_URL: "redis://redis:6379",
      REDIS_PREFIX: "service-a",
      REDIS_NAMESPACE_ID: "local-compose-db0",
    })).toMatchObject({
      TENANT_REDIS_PURGE_ENABLED: true,
      REDIS_PREFIX: "service-a",
      REDIS_NAMESPACE_ID: "local-compose-db0",
    });
    expect(() => loadRouterConfig({
      RUNNERS: "http://runner:8787",
      TENANT_REDIS_PURGE_ENABLED: "true",
    })).toThrow();
    expect(loadRouterConfig({
      RUNNERS: "http://runner:8787",
      TENANT_RUNTIME_DRAIN_EXECUTION_ENABLED: "1",
    }).TENANT_RUNTIME_DRAIN_EXECUTION_ENABLED).toBe(true);
    expect(() => loadRouterConfig({
      RUNNERS: "http://runner:8787",
      TENANT_RUNTIME_DRAIN_EXECUTION_ENABLED: "true",
    })).toThrow();
    expect(loadRouterConfig({
      RUNNERS: "http://runner:8787",
      DATA_EXPORT_REQUESTS_ENABLED: "1",
      BLOB_FILESYSTEM_SINGLE_RUNNER: "1",
    })).toMatchObject({
      DATA_EXPORT_REQUESTS_ENABLED: true,
      dataExportArtifactsReadable: true,
    });
    expect(() => loadRouterConfig({
      RUNNERS: "http://runner:8787",
      DATA_EXPORT_REQUESTS_ENABLED: "true",
    })).toThrow();
    expect(loadRouterConfig({
      RUNNERS: "http://runner:8787",
      BLOB_ATTACHMENTS_ENABLED: "1",
      BLOB_FILESYSTEM_SINGLE_RUNNER: "1",
      BLOB_MAX_BYTES: "2048",
    })).toMatchObject({
      BLOB_ATTACHMENTS_ENABLED: true,
      BLOB_FILESYSTEM_SINGLE_RUNNER: true,
      BLOB_MAX_BYTES: 2048,
    });
  });

  it("requires an explicit single-runner filesystem acknowledgement for Blob writes", () => {
    expect(() => loadRouterConfig({
      RUNNERS: "http://runner:8787",
      BLOB_ATTACHMENTS_ENABLED: "1",
    })).toThrow(/BLOB_FILESYSTEM_SINGLE_RUNNER=1 is required/);
    expect(() => loadRouterConfig({
      RUNNERS: "http://runner-a:8787,http://runner-b:8787",
      BLOB_FILESYSTEM_SINGLE_RUNNER: "1",
      BLOB_ATTACHMENTS_ENABLED: "1",
    })).toThrow(/exactly one runner/);
  });

  it("requires exactly one acknowledged filesystem runner before export admission", () => {
    expect(() => loadRouterConfig({
      RUNNERS: "http://runner:8787",
      DATA_EXPORT_REQUESTS_ENABLED: "1",
    })).toThrow(/BLOB_FILESYSTEM_SINGLE_RUNNER=1 is required/);
    expect(() => loadRouterConfig({
      RUNNERS: "http://runner-a:8787,http://runner-b:8787",
      BLOB_FILESYSTEM_SINGLE_RUNNER: "1",
      DATA_EXPORT_REQUESTS_ENABLED: "1",
    })).toThrow(/exactly one runner/);
  });

  it("rejects a Blob ceiling above the router request-body ceiling", () => {
    expect(() => loadRouterConfig({
      RUNNERS: "http://runner:8787",
      MAX_BODY_BYTES: "99",
      BLOB_MAX_BYTES: "100",
    })).toThrow(/BLOB_MAX_BYTES must not exceed MAX_BODY_BYTES/);
  });

  it("requires the shared runner credential in production", () => {
    expect(() => loadRouterConfig({ RUNNERS: "http://runner:8787", NODE_ENV: "production" })).toThrow(
      /INTERNAL_ROUTER_TOKEN is required in production/,
    );
    expect(loadRouterConfig({
      RUNNERS: "http://runner:8787",
      NODE_ENV: "production",
      INTERNAL_ROUTER_TOKEN: "production-internal-router-token-0001",
    })).toMatchObject({
      INTERNAL_ROUTER_TOKEN: "production-internal-router-token-0001",
      dataExportArtifactsReadable: false,
    });
    expect(loadRouterConfig({
      RUNNERS: "http://runner:8787",
      NODE_ENV: "production",
      INTERNAL_ROUTER_TOKEN: "production-internal-router-token-0001",
      BLOB_FILESYSTEM_SINGLE_RUNNER: "1",
    }).dataExportArtifactsReadable).toBe(false);
    expect(() => loadRouterConfig({
      RUNNERS: "http://runner:8787",
      NODE_ENV: "production",
      INTERNAL_ROUTER_TOKEN: "production-internal-router-token-0001",
      BLOB_FILESYSTEM_SINGLE_RUNNER: "1",
      BLOB_ATTACHMENTS_ENABLED: "1",
    })).toThrow(/shared object-store adapter/);
    expect(() => loadRouterConfig({
      RUNNERS: "http://runner:8787",
      NODE_ENV: "production",
      INTERNAL_ROUTER_TOKEN: "production-internal-router-token-0001",
      BLOB_FILESYSTEM_SINGLE_RUNNER: "1",
      DATA_EXPORT_REQUESTS_ENABLED: "1",
    })).toThrow(/shared object-store adapter/);
  });

  it("keeps tenant-erasure platform authority independent from router credentials", () => {
    expect(loadRouterConfig({
      RUNNERS: "http://runner:8787",
      TENANT_ERASURE_OPERATOR_TOKEN: "tenant-erasure-operator-token-0001",
      TENANT_ERASURE_OPERATOR_ID: "lifecycle-operator-1",
    })).toMatchObject({
      TENANT_ERASURE_REQUESTS_ENABLED: false,
      TENANT_ERASURE_OPERATOR_TOKEN: "tenant-erasure-operator-token-0001",
      TENANT_ERASURE_OPERATOR_ID: "lifecycle-operator-1",
    });
    expect(() => loadRouterConfig({
      RUNNERS: "http://runner:8787",
      TENANT_ERASURE_REQUESTS_ENABLED: "1",
    })).toThrow(/TENANT_ERASURE_OPERATOR_TOKEN is required/);
    expect(() => loadRouterConfig({
      RUNNERS: "http://runner:8787",
      TENANT_ERASURE_OPERATOR_TOKEN: "too-short",
    })).toThrow();
    expect(() => loadRouterConfig({
      RUNNERS: "http://runner:8787",
      TENANT_ERASURE_OPERATOR_TOKEN: "agent-service-local-router-token-v1",
    })).toThrow(/must differ from INTERNAL_ROUTER_TOKEN/);
    expect(() => loadRouterConfig({
      RUNNERS: "http://runner:8787",
      ROUTER_ADMIN_TOKEN: "tenant-erasure-operator-token-0001",
      TENANT_ERASURE_OPERATOR_TOKEN: "tenant-erasure-operator-token-0001",
    })).toThrow(/must differ from ROUTER_ADMIN_TOKEN/);
    expect(() => loadRouterConfig({
      RUNNERS: "http://runner:8787",
      TENANT_ERASURE_OPERATOR_ID: "contains whitespace",
    })).toThrow();
  });

  it("accepts only credential-free runner base URLs", () => {
    expect(loadRouterConfig({ RUNNERS: "http://runner-a:8787/,https://runner-b:8788" }).runnerList).toEqual([
      "http://runner-a:8787",
      "https://runner-b:8788",
    ]);
    expect(() => loadRouterConfig({ RUNNERS: "runner:8787" })).toThrow(/absolute http/);
    expect(() => loadRouterConfig({ RUNNERS: "http://user:secret@runner:8787" })).toThrow(/must not contain credentials/);
    expect(() => loadRouterConfig({ RUNNERS: "http://runner:8787/path" })).toThrow(/must not contain credentials/);
    expect(loadRouterConfig({
      RUNNERS: "HTTP://RUNNER-A:80/,http://runner-a",
    }).runnerList).toEqual(["http://runner-a"]);
    expect(() => loadRouterConfig({
      RUNNERS: Array.from({ length: 101 }, (_, index) => `http://runner-${index}`).join(","),
    })).toThrow(/at most 100/);
  });
});
