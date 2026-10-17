import { describe, expect, it } from "vitest";
import { loadMcpConfig } from "../src/mcp-config.js";

const server = { id: "docs", endpoint: "https://mcp.example/mcp", subjects: [{ tenantId: "tenant-a", userId: "alice" }] };
const configured = { MCP_ENABLED: "1", MCP_SERVERS_JSON: JSON.stringify([server]) };

describe("operator MCP configuration", () => {
  it("defaults off without servers, credentials or ambient configuration", () => {
    expect(loadMcpConfig({})).toEqual({ enabled: false, servers: [], timeoutMs: 15_000, maxConcurrentPerUser: 2, allowLoopbackForTests: false });
  });
  it("accepts exact subjects and normalizes a fixed anonymous HTTPS endpoint", () => {
    expect(loadMcpConfig(configured)).toMatchObject({ enabled: true, servers: [server] });
    expect(loadMcpConfig({ MCP_ENABLED: "0", MCP_SERVERS_JSON: configured.MCP_SERVERS_JSON }).enabled).toBe(false);
  });
  it.each(["", "true", "2"])("does not coerce an invalid activation flag %j", (flag) => {
    expect(() => loadMcpConfig({ ...configured, MCP_ENABLED: flag })).toThrow("Invalid MCP operator configuration");
  });
  it.each([
    [], [server, server], [{ ...server, subjects: [] }], [{ ...server, subjects: [...server.subjects, ...server.subjects] }],
    [{ ...server, id: "docs/../escape" }], [{ ...server, subjects: [{ tenantId: "tenant-a", userId: "*" }] }],
    [{ ...server, headers: { authorization: "private-fixture-value" } }],
    [{ ...server, command: "forbidden" }],
  ].map((servers) => ({ servers })))("rejects malformed, duplicate or widened operator configuration", ({ servers }) => {
    const raw = JSON.stringify(servers);
    try { loadMcpConfig({ ...configured, MCP_SERVERS_JSON: raw }); throw new Error("unexpected success"); }
    catch (error) { expect(error).toBeInstanceOf(Error); expect((error as Error).message).toBe("Invalid MCP operator configuration"); }
  });
  it.each([
    "http://mcp.example/mcp", "https://user:private-fixture-value@mcp.example/mcp",
    "https://mcp.example/mcp?", "https://mcp.example/mcp?key=private-fixture-value",
    "https://mcp.example/mcp#", "https://mcp.example/mcp#private-fixture-value", "file:///tmp/mcp",
  ])("rejects insecure or credential-bearing endpoint without echoing it: %s", (endpoint) => {
    expect(() => loadMcpConfig({ ...configured, MCP_SERVERS_JSON: JSON.stringify([{ ...server, endpoint }]) }))
      .toThrow("Invalid MCP operator configuration");
  });
  it("allows loopback only with an explicit test-only switch", () => {
    const env = { ...configured, NODE_ENV: "test", MCP_ALLOW_LOOPBACK_FOR_TESTS: "1", MCP_SERVERS_JSON: JSON.stringify([{ ...server, endpoint: "http://127.0.0.1:8765/mcp" }]) };
    expect(loadMcpConfig(env).allowLoopbackForTests).toBe(true);
    for (const NODE_ENV of ["production", "development", undefined]) expect(() => loadMcpConfig({ ...env, NODE_ENV })).toThrow("Invalid MCP operator configuration");
    expect(() => loadMcpConfig({ ...env, MCP_ALLOW_LOOPBACK_FOR_TESTS: "0" })).toThrow("Invalid MCP operator configuration");
  });
  it("bounds JSON size, time and per-user concurrency even while disabled", () => {
    expect(() => loadMcpConfig({ MCP_SERVERS_JSON: " ".repeat(65_537) })).toThrow("Invalid MCP operator configuration");
    expect(() => loadMcpConfig({ MCP_SERVERS_JSON: "{invalid" })).toThrow("Invalid MCP operator configuration");
    for (const value of ["0", "01", "NaN", "-1", "30001"]) expect(() => loadMcpConfig({ MCP_TIMEOUT_MS: value })).toThrow("Invalid MCP operator configuration");
    for (const value of ["0", "9", "1.5"]) expect(() => loadMcpConfig({ MCP_MAX_CONCURRENT_PER_USER: value })).toThrow("Invalid MCP operator configuration");
  });
});
