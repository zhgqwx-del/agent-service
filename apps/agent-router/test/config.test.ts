import { describe, expect, it } from "vitest";
import { loadRouterConfig } from "../src/config.js";

describe("router configuration", () => {
  it("keeps tombstone off until deployment explicitly activates it", () => {
    const local = loadRouterConfig({ RUNNERS: "http://runner:8787" });
    expect(local.SESSION_TOMBSTONE_ENABLED).toBe(false);
    expect(local.BLOB_FILESYSTEM_SINGLE_RUNNER).toBe(false);
    expect(local.BLOB_ATTACHMENTS_ENABLED).toBe(false);
    expect(local.BLOB_MAX_BYTES).toBe(1_000_000);
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
    }).INTERNAL_ROUTER_TOKEN).toBe("production-internal-router-token-0001");
    expect(() => loadRouterConfig({
      RUNNERS: "http://runner:8787",
      NODE_ENV: "production",
      INTERNAL_ROUTER_TOKEN: "production-internal-router-token-0001",
      BLOB_FILESYSTEM_SINGLE_RUNNER: "1",
      BLOB_ATTACHMENTS_ENABLED: "1",
    })).toThrow(/shared object-store adapter/);
  });

  it("accepts only credential-free runner base URLs", () => {
    expect(loadRouterConfig({ RUNNERS: "http://runner-a:8787/,https://runner-b:8788" }).runnerList).toEqual([
      "http://runner-a:8787",
      "https://runner-b:8788",
    ]);
    expect(() => loadRouterConfig({ RUNNERS: "runner:8787" })).toThrow(/absolute http/);
    expect(() => loadRouterConfig({ RUNNERS: "http://user:secret@runner:8787" })).toThrow(/must not contain credentials/);
    expect(() => loadRouterConfig({ RUNNERS: "http://runner:8787/path" })).toThrow(/must not contain credentials/);
  });
});
