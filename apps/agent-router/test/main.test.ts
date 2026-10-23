import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  serverClosed: false,
  registryClosed: false,
  registryStopped: false,
  registryFailure: undefined as Error | undefined,
  nativeClose: undefined as Promise<void> | undefined,
  fetch: undefined as undefined | ((request: Request) => Promise<Response>),
}));

vi.mock("@hono/node-server", () => ({
  serve: (options: { fetch: (request: Request) => Promise<Response> }) => {
    state.fetch = options.fetch;
    return { close: (callback?: () => void) => {
      state.serverClosed = true;
      if (state.nativeClose) void state.nativeClose.then(() => callback?.());
      else callback?.();
    } };
  },
}));

vi.mock("../src/registry.js", () => ({
  RunnerRegistry: class {
    start() {}
    async waitForFirstProbe() {}
    stop() { state.registryStopped = true; }
    async close() {
      state.registryClosed = true;
      if (state.registryFailure) throw state.registryFailure;
    }
  },
}));

import { startRouter } from "../src/main.js";

describe("router bootstrap telemetry", () => {
  it("observes a signal-triggered close failure once, emits only a fixed code and sets nonzero status", async () => {
    const originalOn = process.on;
    const signals = new Map<string, () => void>();
    const on = vi.spyOn(process, "on").mockImplementation(((event: string, listener: () => void) => {
      if (event === "SIGTERM" || event === "SIGINT") { signals.set(event, listener); return process; }
      return originalOn.call(process, event, listener);
    }) as typeof process.on);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const previousExitCode = process.exitCode;
    const failure = new Error("synthetic-secret-private-close-failure");
    state.registryFailure = failure;
    let router: Awaited<ReturnType<typeof startRouter>> | undefined;
    try {
      router = await startRouter({ NODE_ENV: "test", RUNNERS: "http://synthetic-runner.invalid:8787",
        ROUTER_HOST: "127.0.0.1", ROUTER_PORT: "0", SHUTDOWN_GRACE_MS: "0" });
      signals.get("SIGTERM")!(); signals.get("SIGINT")!();
      await expect(router.close()).rejects.toBe(failure); await Promise.resolve();
      expect(process.exitCode).toBe(1); expect(exit).not.toHaveBeenCalled();
      const output = error.mock.calls.flat().join("\n");
      expect(output).toContain('"code":"router.process.shutdown_failed"');
      expect(error).toHaveBeenCalledOnce(); expect(output).not.toContain(failure.message);
      router = undefined;
    } finally {
      await router?.close().catch(() => {}); process.exitCode = previousExitCode; state.registryFailure = undefined;
      on.mockRestore(); log.mockRestore(); error.mockRestore(); exit.mockRestore();
    }
  });

  it("shares one close promise and waits for the actual native callback without exiting its caller", async context => {
    let release!: () => void;
    state.serverClosed = false; state.registryClosed = false;
    state.nativeClose = new Promise<void>(done => { release = done; });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const abort = () => release(); context.signal.addEventListener("abort", abort, { once: true });
    let router: Awaited<ReturnType<typeof startRouter>> | undefined;
    try {
      router = await startRouter({ NODE_ENV: "test", RUNNERS: "http://synthetic-runner.invalid:8787",
        ROUTER_HOST: "127.0.0.1", ROUTER_PORT: "0", SHUTDOWN_GRACE_MS: "0" });
      const closing = router.close(); expect(router.close()).toBe(closing);
      expect((await state.fetch!(new Request("http://127.0.0.1/readyz"))).status).toBe(503);
      expect((await state.fetch!(new Request("http://127.0.0.1/v1/agents"))).status).toBe(503);
      let settled = false; void closing.then(() => { settled = true; });
      await vi.waitFor(() => expect(state.registryClosed).toBe(true)); expect(settled).toBe(false);
      release(); await closing; expect(exit).not.toHaveBeenCalled(); router = undefined;
    } finally {
      release(); await router?.close().catch(() => {}); state.nativeClose = undefined;
      context.signal.removeEventListener("abort", abort); log.mockRestore(); exit.mockRestore();
    }
  });

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
      expect(state.registryStopped).toBe(true);
      expect(state.registryClosed).toBe(true);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      once.mockRestore();
      error.mockRestore();
      log.mockRestore();
    }
  });
});
