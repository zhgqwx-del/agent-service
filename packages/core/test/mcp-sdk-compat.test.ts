import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeMcp } from "@agent-service/testkit";
import { ConfiguredMcpToolSource } from "../src/mcp/service.js";

const owner = { tenantId: "t_mcp_sdk", userId: "u_sdk" };
const pending: (() => Promise<void>)[] = [];
beforeEach(() => { vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("MCP_ALLOW_LOOPBACK_FOR_TESTS", "1"); });
afterEach(async () => { for (const close of pending.reverse().splice(0)) await close(); vi.unstubAllEnvs(); });

describe("pinned MCP client against the independent official server", () => {
  it("validates a real structured output using the SDK's shipped runtime dependency closure", async () => {
    const server = new FakeMcp(); server.structuredOutput = true;
    pending.push(() => server.stop());
    const endpoint = await server.start();
    const source = new ConfiguredMcpToolSource({ servers: [{ id: "official", endpoint, subjects: [owner] }], allowLoopbackForTests: true });
    pending.push(() => source.close());
    const [tool] = await source.resolve(owner, ["official"], new AbortController().signal);
    expect(await tool!.execute({ text: "structured" }, { principal: owner, sessionId: "fixture", turnId: "fixture", toolCallId: "fixture", signal: new AbortController().signal }))
      .toEqual({ content: [{ type: "text", text: "echo:structured" }, { type: "text", text: '{"echo":"echo:structured"}' }] });
    expect(server.calls).toHaveLength(1);
  });
  it("discovers and calls modern HTTP exactly once without auth or legacy handshake", async () => {
    const server = new FakeMcp();
    pending.push(() => server.stop());
    const endpoint = await server.start();
    const source = new ConfiguredMcpToolSource({ servers: [{ id: "official", endpoint, subjects: [owner] }], allowLoopbackForTests: true });
    pending.push(() => source.close());
    const tools = await source.resolve(owner, ["official"], new AbortController().signal);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ kind: "mcp", mandatoryApproval: true, readOnly: false, concurrencySafe: false });
    const result = await tools[0]!.execute({ text: "official-wire" }, { principal: owner, sessionId: "fixture", turnId: "fixture", toolCallId: "fixture", signal: new AbortController().signal });
    expect(result).toEqual({ content: [{ type: "text", text: "echo:official-wire" }] });
    expect(server.calls).toEqual([{ name: "echo", arguments: { text: "official-wire" } }]);
    expect(server.methods.filter(method => method === "tools/call")).toHaveLength(1);
    expect(server.methods.every(method => ["server/discover", "tools/list", "tools/call"].includes(method))).toBe(true);
  });
  it("rejects an official server's changed catalog before invoking a previously approved tool", async () => {
    const server = new FakeMcp(); pending.push(() => server.stop());
    const endpoint = await server.start();
    const source = new ConfiguredMcpToolSource({ servers: [{ id: "official", endpoint, subjects: [owner] }], allowLoopbackForTests: true });
    pending.push(() => source.close());
    const [tool] = await source.resolve(owner, ["official"], new AbortController().signal);
    server.toolDescription = "A changed capability must not inherit the old approval.";
    const result = await tool!.execute({ text: "must-not-run" }, { principal: owner, sessionId: "fixture", turnId: "fixture", toolCallId: "fixture", signal: new AbortController().signal });
    expect(result).toMatchObject({ isError: true });
    expect(server.calls).toEqual([]);
    expect(server.methodCounts.get("tools/call") ?? 0).toBe(0);
  });
});
