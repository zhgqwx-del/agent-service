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
    const capabilities = (
      protocolVersion: string,
      sessionLifecycle = ["archive", "unarchive", "tombstone"],
      blobAttachments = true,
      dataErasureRequests = true,
    ) => ({
      protocolVersion,
      service: "agent-runner",
      features: {
        streaming: true,
        replay: { persistedEvents: true, hotWindowMs: 1 },
        approvals: true,
        sessionLifecycle,
        blobAttachments,
        dataErasureRequests,
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
      if (url.startsWith("http://current-basic/")) {
        return Response.json(capabilities(PROTOCOL_VERSION, ["archive", "unarchive"], false, false));
      }
      if (url.startsWith("http://old/")) return Response.json(capabilities("2026-09-22"));
      return new Response("not found", { status: 404 });
    }));

    const registry = new RunnerRegistry({
      runners: ["http://current", "http://current-basic", "http://old"],
      healthIntervalMs: 60_000,
    });
    registry.start();
    await registry.waitForFirstProbe();

    expect(registry.list().map(({ url, healthy }) => ({ url, healthy }))).toEqual([
      { url: "http://current", healthy: true },
      { url: "http://current-basic", healthy: true },
      { url: "http://old", healthy: false },
    ]);
    expect(registry.allHealthySupportLifecycle("tombstone")).toBe(false);
    expect(registry.supportsLifecycle("http://current", "tombstone")).toBe(true);
    expect(registry.supportsLifecycle("http://current-basic", "tombstone")).toBe(false);
    expect(registry.supportsLifecycle("http://old", "tombstone")).toBe(false);
    expect(registry.allHealthySupportBlobAttachments()).toBe(false);
    expect(registry.supportsBlobAttachments("http://current")).toBe(true);
    expect(registry.supportsBlobAttachments("http://current-basic")).toBe(false);
    expect(registry.allHealthySupportDataErasureRequests()).toBe(false);
    expect(registry.allConfiguredSupportDataErasureRequests()).toBe(false);
    expect(registry.supportsDataErasureRequests("http://current")).toBe(true);
    expect(registry.supportsDataErasureRequests("http://current-basic")).toBe(false);
    expect(registry.anyHealthy()).toBe("http://current");
    expect(registry.routeableUrl("current")).toBe("http://current");
    expect(registry.routeableUrl("old")).toBeUndefined();
    await registry.close();
  });

  it("does not ignore an unavailable configured legacy writer when activating erasure", async () => {
    let legacyState: "down" | "legacy" | "upgraded" = "down";
    const capabilities = (dataErasureRequests: boolean) => ({
      protocolVersion: PROTOCOL_VERSION,
      service: "agent-runner",
      features: {
        streaming: true,
        replay: { persistedEvents: true, hotWindowMs: 1 },
        approvals: true,
        sessionLifecycle: ["archive", "unarchive", "tombstone"],
        blobAttachments: true,
        dataErasureRequests,
        dynamicTools: true,
        mcp: [],
        skills: false,
        sandbox: ["none"],
        byok: true,
      },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("http://current/readyz")) return new Response("ready");
      if (url.startsWith("http://current/v1/capabilities")) return Response.json(capabilities(true));
      if (url.startsWith("http://legacy/readyz")) {
        return legacyState === "down" ? new Response("down", { status: 503 }) : new Response("ready");
      }
      if (url.startsWith("http://legacy/v1/capabilities")) {
        return Response.json(capabilities(legacyState === "upgraded"));
      }
      return new Response("not found", { status: 404 });
    }));

    const registry = new RunnerRegistry({
      runners: ["http://current", "http://legacy"],
      healthIntervalMs: 60_000,
    });
    registry.start();
    await registry.waitForFirstProbe();

    // Status reads retain their healthy-subset rule, but an irreversible POST cannot pretend that
    // the configured, currently unavailable writer has already been drained or upgraded.
    expect(registry.allHealthySupportDataErasureRequests()).toBe(true);
    expect(registry.allConfiguredSupportDataErasureRequests()).toBe(false);

    legacyState = "legacy";
    await (registry as unknown as { checkAll(): Promise<void> }).checkAll();
    expect(registry.list().find((target) => target.url === "http://legacy")?.healthy).toBe(true);
    expect(registry.allHealthySupportDataErasureRequests()).toBe(false);
    expect(registry.allConfiguredSupportDataErasureRequests()).toBe(false);

    legacyState = "upgraded";
    await (registry as unknown as { checkAll(): Promise<void> }).checkAll();
    expect(registry.allHealthySupportDataErasureRequests()).toBe(true);
    expect(registry.allConfiguredSupportDataErasureRequests()).toBe(true);
    await registry.close();
  });
});
