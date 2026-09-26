import { describe, expect, it } from "vitest";
import { DynamicToolBridge, assertPublicHost, builtinTools, currentTimeTool } from "../src/index.js";

const ctx = (over: Partial<Parameters<typeof currentTimeTool.execute>[1]> = {}) => ({
  principal: { tenantId: "t", userId: "u" },
  sessionId: "sess_1",
  turnId: "turn_1",
  toolCallId: "call_1",
  signal: new AbortController().signal,
  ...over,
});

describe("assertPublicHost (SSRF guard)", () => {
  const blocked = [
    "localhost", "LOCALHOST", "foo.localhost", "svc.internal", "printer.local",
    "127.0.0.1", "127.1.2.3", "0.0.0.0", "10.0.0.1", "192.168.1.1", "172.16.0.1", "172.31.255.255",
    "169.254.169.254", // cloud metadata
    "100.100.100.200", // aliyun metadata (CGNAT range)
    "::1", "[::1]", "::", "fe80::1", "fd00::1", "fc00::1",
    "::ffff:127.0.0.1", "[::ffff:127.0.0.1]", "::ffff:10.0.0.1",
  ];
  for (const host of blocked) {
    it(`blocks ${host}`, async () => {
      await expect(assertPublicHost(host)).rejects.toThrow();
    });
  }

  it("allows a public literal address", async () => {
    await expect(assertPublicHost("1.1.1.1")).resolves.toBeUndefined();
    await expect(assertPublicHost("2606:4700:4700::1111")).resolves.toBeUndefined();
  });

  it("rejects a host that does not resolve", async () => {
    await expect(assertPublicHost("nonexistent-host.invalid")).rejects.toThrow();
  });
});

describe("web_fetch", () => {
  const webFetch = builtinTools.find((t) => t.name === "web_fetch")!;

  it("refuses non-http schemes and private targets", async () => {
    for (const url of ["file:///etc/passwd", "gopher://x", "ftp://example.com"]) {
      const r = await webFetch.execute({ url }, ctx());
      expect(r.isError).toBe(true);
    }
    const r = await webFetch.execute({ url: "http://169.254.169.254/latest/meta-data/" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content[0]).toMatchObject({ text: expect.stringContaining("blocked") });
  });

  it("rejects an invalid url", async () => {
    const r = await webFetch.execute({ url: "not a url" }, ctx());
    expect(r.isError).toBe(true);
  });
});

describe("current_time", () => {
  it("formats in the requested zone and rejects an unknown one", async () => {
    const ok = await currentTimeTool.execute({ timeZone: "Asia/Shanghai" }, ctx());
    expect(ok.isError).toBeUndefined();
    expect(ok.content[0]).toMatchObject({ text: expect.stringContaining("Asia/Shanghai") });
    const bad = await currentTimeTool.execute({ timeZone: "Mars/Olympus" }, ctx());
    expect(bad.isError).toBe(true);
  });
});

describe("DynamicToolBridge", () => {
  it("scopes pending calls per session so identical tool call ids cannot cross sessions", async () => {
    const bridge = new DynamicToolBridge();
    const tool = bridge.asTool({ name: "ask", description: "d", parameters: {} }, 5_000);
    const a = tool.execute({}, ctx({ sessionId: "sess_a", toolCallId: "call_1" }));
    const b = tool.execute({}, ctx({ sessionId: "sess_b", toolCallId: "call_1" }));
    // a result addressed to sess_a must not settle sess_b's call
    expect(bridge.resolve("sess_a", "call_1", { content: [{ type: "text", text: "for-a" }], isError: false })).toBe(true);
    expect(await a).toMatchObject({ content: [{ type: "text", text: "for-a" }] });
    expect(bridge.resolve("sess_c", "call_1", { content: [{ type: "text", text: "x" }], isError: false })).toBe(false);
    expect(bridge.resolve("sess_b", "call_1", { content: [{ type: "text", text: "for-b" }], isError: false })).toBe(true);
    expect(await b).toMatchObject({ content: [{ type: "text", text: "for-b" }] });
  });

  it("times out when the client never answers", async () => {
    const bridge = new DynamicToolBridge();
    const tool = bridge.asTool({ name: "ask", description: "d", parameters: {} }, 30);
    const r = await tool.execute({}, ctx());
    expect(r.isError).toBe(true);
    expect(r.content[0]).toMatchObject({ text: expect.stringContaining("timed out") });
  });

  it("resolves as an error when the turn is aborted", async () => {
    const bridge = new DynamicToolBridge();
    const tool = bridge.asTool({ name: "ask", description: "d", parameters: {} }, 5_000);
    const ac = new AbortController();
    const p = tool.execute({}, ctx({ signal: ac.signal }));
    ac.abort();
    expect(await p).toMatchObject({ isError: true });
  });
});
