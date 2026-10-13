import { EventEmitter } from "node:events";
import net, { type Socket } from "node:net";
import type { Pool } from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";
import { bindMysqlOperationAbort, createMysqlOperationAbortTransport } from "../src/mysql/operation-abort.js";
import { runAbortableRequest } from "../src/operation-abort.js";

describe("one-shot native maintenance cancellation", () => {
  it("aborts a native request and bounds an uncooperative pending provider", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const request = runAbortableRequest((signal) => {
      requestSignal = signal;
      return new Promise(() => {});
    }, 10_000, controller.signal);
    const result = expect(request).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    controller.abort();
    await result;
    expect(requestSignal?.aborted).toBe(true);
  });

  it("never starts a request under an already cancelled operation", async () => {
    const controller = new AbortController();
    controller.abort();
    const request = vi.fn(async () => "not allowed");
    await expect(runAbortableRequest(request, 10_000, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(request).not.toHaveBeenCalled();
  });

  it("retains per-request timeout cancellation without a shared operation", async () => {
    let requestSignal: AbortSignal | undefined;
    await expect(runAbortableRequest((signal) => {
      requestSignal = signal;
      return new Promise(() => {});
    }, 10)).rejects.toMatchObject({ name: "TimeoutError" });
    expect(requestSignal?.aborted).toBe(true);
  });

  it("detaches operation listeners after successful completion", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    expect(await runAbortableRequest(async (signal) => {
      requestSignal = signal;
      return 7;
    }, 10_000, controller.signal)).toBe(7);
    controller.abort();
    expect(requestSignal?.aborted).toBe(false);
  });

  it("destroys connected SQL clients, closes the pool once, and refuses late clients", async () => {
    const pool = Object.assign(new EventEmitter(), { end: vi.fn(async () => {}) });
    const controller = new AbortController();
    const scope = bindMysqlOperationAbort(pool as unknown as Pool, controller.signal);
    const first = { destroy: vi.fn() };
    const second = { destroy: vi.fn() };
    pool.emit("connection", first);
    pool.emit("connection", second);
    controller.abort();
    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(second.destroy).toHaveBeenCalledTimes(1);
    expect(pool.end).toHaveBeenCalledTimes(1);
    const late = { destroy: vi.fn() };
    pool.emit("connection", late);
    expect(late.destroy).toHaveBeenCalledTimes(1);
    await scope.close();
    await scope.close();
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(pool.listenerCount("connection")).toBe(0);
  });

  it("closes an already aborted SQL pool without admitting a client", async () => {
    const pool = Object.assign(new EventEmitter(), { end: vi.fn(async () => {}) });
    const controller = new AbortController();
    controller.abort();
    const scope = bindMysqlOperationAbort(pool as unknown as Pool, controller.signal);
    expect(pool.end).toHaveBeenCalledTimes(1);
    await scope.close();
  });

  it("hard-destroys the owned transport, including connections still handshaking", () => {
    const socket = Object.assign(new EventEmitter(), {
      destroy: vi.fn(), setNoDelay: vi.fn(), setKeepAlive: vi.fn(),
    });
    const connect = vi.spyOn(net, "createConnection").mockReturnValue(socket as unknown as Socket);
    const controller = new AbortController();
    const transport = createMysqlOperationAbortTransport(controller.signal);
    try {
      expect(transport.stream({ config: { host: "127.0.0.1", port: 3306,
        enableKeepAlive: true, keepAliveInitialDelay: 12 } })).toBe(socket);
      expect(connect).toHaveBeenCalledWith(3306, "127.0.0.1");
      expect(socket.setNoDelay).toHaveBeenCalledWith(true);
      socket.emit("connect");
      expect(socket.setKeepAlive).toHaveBeenCalledWith(true, 12);
      controller.abort();
      expect(socket.destroy).toHaveBeenCalledWith(expect.objectContaining({ name: "AbortError", code: "ABORT_ERR" }));
      socket.emit("close");
      transport.close();
      expect(socket.destroy).toHaveBeenCalledTimes(1);
    } finally { transport.close(); connect.mockRestore(); }
  });

  it("does not emit an already-cancelled transport error before the driver attaches handlers", async () => {
    const socket = Object.assign(new EventEmitter(), {
      destroy: vi.fn(), setNoDelay: vi.fn(), setKeepAlive: vi.fn(),
    });
    const connect = vi.spyOn(net, "createConnection").mockReturnValue(socket as unknown as Socket);
    const controller = new AbortController();
    controller.abort();
    const transport = createMysqlOperationAbortTransport(controller.signal);
    try {
      transport.stream({ config: { host: "unused", port: 3306, socketPath: "/private/tmp/fixture.sock" } });
      expect(connect).toHaveBeenCalledWith("/private/tmp/fixture.sock");
      expect(socket.destroy).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(socket.destroy).toHaveBeenCalledWith(expect.objectContaining({ code: "ABORT_ERR" }));
      expect(socket.setNoDelay).not.toHaveBeenCalled();
    } finally { transport.close(); connect.mockRestore(); }
  });
});
