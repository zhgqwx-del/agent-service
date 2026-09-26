import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "@agent-service/protocol";
import { RunnerRegistry } from "../src/registry.js";

afterEach(() => vi.unstubAllGlobals());

describe("RunnerRegistry owner address mapping", () => {
  it("maps an exact advertised address when runners share the same port", async () => {
    const registry = new RunnerRegistry({ runners: ["http://runner-a:8787", "http://runner-b:8787/"] });
    expect(registry.toUrl("runner-a:8787")).toBe("http://runner-a:8787");
    expect(registry.toUrl("http://runner-b:8787/")).toBe("http://runner-b:8787");
    await registry.close();
  });

  it("uses the port fallback only when it identifies exactly one runner", async () => {
    const unique = new RunnerRegistry({ runners: ["http://runner-a:8787", "http://runner-b:8788"] });
    expect(unique.toUrl("legacy-name:8787")).toBe("http://runner-a:8787");
    await unique.close();

    const ambiguous = new RunnerRegistry({ runners: ["http://runner-a:8787", "http://runner-b:8787"] });
    expect(ambiguous.toUrl("0.0.0.0:8787")).toBeUndefined();
    await ambiguous.close();
  });

  it("admits only ready runners on the current protocol into routing", async () => {
    const capabilities = (protocolVersion: string) => ({
      protocolVersion,
      service: "agent-runner",
      features: {
        streaming: true,
        replay: { persistedEvents: true, hotWindowMs: 1 },
        approvals: true,
        dynamicTools: true,
        mcp: [],
        skills: false,
        sandbox: ["none"],
        byok: true,
      },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/readyz")) return new Response("ready");
      if (url.startsWith("http://current/")) return Response.json(capabilities(PROTOCOL_VERSION));
      if (url.startsWith("http://old/")) return Response.json(capabilities("2026-09-22"));
      return new Response("not found", { status: 404 });
    }));

    const registry = new RunnerRegistry({
      runners: ["http://current", "http://old"],
      healthIntervalMs: 60_000,
    });
    registry.start();
    await registry.waitForFirstProbe();

    expect(registry.list().map(({ url, healthy }) => ({ url, healthy }))).toEqual([
      { url: "http://current", healthy: true },
      { url: "http://old", healthy: false },
    ]);
    expect(registry.anyHealthy()).toBe("http://current");
    expect(registry.routeableUrl("current")).toBe("http://current");
    expect(registry.routeableUrl("old")).toBeUndefined();
    await registry.close();
  });
});
