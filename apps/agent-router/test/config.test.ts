import { describe, expect, it } from "vitest";
import { loadRouterConfig } from "../src/config.js";

describe("router configuration", () => {
  it("keeps tombstone off until deployment explicitly activates it", () => {
    const local = loadRouterConfig({ RUNNERS: "http://runner:8787" });
    expect(local.SESSION_TOMBSTONE_ENABLED).toBe(false);
    expect(local.INTERNAL_ROUTER_TOKEN.length).toBeGreaterThanOrEqual(32);
    expect(loadRouterConfig({
      RUNNERS: "http://runner:8787",
      SESSION_TOMBSTONE_ENABLED: "1",
    }).SESSION_TOMBSTONE_ENABLED).toBe(true);
    expect(() => loadRouterConfig({
      RUNNERS: "http://runner:8787",
      SESSION_TOMBSTONE_ENABLED: "true",
    })).toThrow();
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
