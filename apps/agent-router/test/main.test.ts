import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  serverClosed: false,
  registryClosed: false,
}));

vi.mock("@hono/node-server", () => ({
  serve: () => ({
    close: () => {
      state.serverClosed = true;
    },
  }),
}));

vi.mock("../src/registry.js", () => ({
  RunnerRegistry: class {
    start() {}
    async waitForFirstProbe() {}
    async close() {
      state.registryClosed = true;
    }
  },
}));

import { startRouter } from "../src/main.js";

describe("router bootstrap telemetry", () => {
  it("emits fixed structured events without runner URLs or the configured list", async () => {
    state.serverClosed = false;
    state.registryClosed = false;
    const firstRunner = "http://runner-sensitive-a.internal:8787";
    const secondRunner = "https://runner-sensitive-b.internal:8788";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const once = vi.spyOn(process, "once")
      .mockImplementation((() => process) as typeof process.once);
    const exit = vi.spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    try {
      const router = await startRouter({
        NODE_ENV: "test",
        RUNNERS: `${firstRunner},${secondRunner}`,
        ROUTER_HOST: "router-sensitive.internal",
        ROUTER_PORT: "0",
        SHUTDOWN_GRACE_MS: "0",
      });
      const started = log.mock.calls.flat().join("\n");
      expect(started).toContain('"schema":"agent-service.telemetry.v1"');
      expect(started).toContain('"code":"router.lifecycle.started"');
      expect(started).toContain('"runnerCount":2');
      expect(started).not.toContain(firstRunner);
      expect(started).not.toContain(secondRunner);
      expect(started).not.toContain("runner-sensitive-a.internal");
      expect(started).not.toContain("runner-sensitive-b.internal");
      expect(started).not.toContain("router-sensitive.internal");
      expect(error).not.toHaveBeenCalled();

      await router.close();
      const allOutput = log.mock.calls.flat().join("\n");
      expect(allOutput).toContain('"code":"router.lifecycle.draining"');
      expect(state.serverClosed).toBe(true);
      expect(state.registryClosed).toBe(true);
    } finally {
      exit.mockRestore();
      once.mockRestore();
      error.mockRestore();
      log.mockRestore();
    }
  });
});
