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
    expect(cfg.BLOB_MAX_BYTES).toBe(1_000_000);
    expect(cfg.BLOB_MAX_HYDRATED_BYTES).toBe(4_000_000);
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

  it("never advertises a wildcard bind address", () => {
    expect(() => loadConfig({ SECRETS_MASTER_KEY: SECRET, RUNNER_HOST: "0.0.0.0" })).toThrow(/RUNNER_ADDR is required/);
    expect(() => loadConfig({ ...productionEnv, RUNNER_ADDR: "0.0.0.0:8787" })).toThrow(/not a wildcard/);
    expect(() => loadConfig({ ...productionEnv, RUNNER_ADDR: "file:///tmp/runner" })).toThrow(/must use http or https/);
  });

  it("rejects the development bootstrap key in production", () => {
    expect(() => loadConfig({ ...productionEnv, BOOTSTRAP_API_KEY: "must-not-work" })).toThrow(/BOOTSTRAP_API_KEY must not be set/);
  });
});
