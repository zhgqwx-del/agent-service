import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { guardRedisDatabaseSelection } from "../src/redis-selection.js";

const CANARY = "fixture-select-error-secret-must-not-be-reported";

function redisDouble() {
  const stream = Object.assign(new EventEmitter(), { destroy: vi.fn((): void => {}) });
  const client = Object.assign(new EventEmitter(), {
    stream: stream as typeof stream | undefined,
    disconnect: vi.fn((_reconnect?: boolean): void => {}),
  });
  return { client, stream };
}

// ioredis DataHandler attaches this own-data command shape to a ReplyError;
// bootstrap SELECT rejection then reaches its permanent error event channel.
function replyError(name = "select") {
  return Object.assign(new Error(CANARY), { command: { name, args: [CANARY] } });
}

function emitError(client: EventEmitter, error: unknown): boolean {
  try { client.emit("error", error); return true; } catch { return false; }
}

describe("Redis database selection failure guard (driver-shaped doubles only)", () => {
  it("returns the same client and installs exactly one permanent listener", () => {
    const { client, stream } = redisDouble();
    const existing = vi.fn(), later = vi.fn();
    client.on("error", existing);
    expect(guardRedisDatabaseSelection(client)).toBe(client);
    expect(guardRedisDatabaseSelection(client)).toBe(client);
    expect(client.listenerCount("error")).toBe(2);
    client.on("error", later);

    const first = replyError(), second = replyError();
    expect(emitError(client, first)).toBe(true);
    client.emit("ready"); client.emit("end");
    expect(client.listenerCount("error")).toBe(3);
    expect(guardRedisDatabaseSelection(client)).toBe(client);
    expect(client.listenerCount("error")).toBe(3);
    expect(emitError(client, second)).toBe(true);
    expect(client.disconnect.mock.calls).toEqual([[false], [false]]);
    expect(stream.destroy).toHaveBeenCalledTimes(2);
    expect(existing.mock.calls.length === 2 && existing.mock.calls[0]?.[0] === first
      && existing.mock.calls[1]?.[0] === second).toBe(true);
    expect(later.mock.calls.length === 2 && later.mock.calls[0]?.[0] === first
      && later.mock.calls[1]?.[0] === second).toBe(true);
  });

  it("requests native destruction after disconnect(false), without claiming a close event", () => {
    const { client, stream } = redisDouble(), order: string[] = [];
    let closeSeen = false;
    stream.once("close", () => { closeSeen = true; });
    client.disconnect.mockImplementation(() => { order.push("disconnect"); });
    stream.destroy.mockImplementation(() => { order.push("destroy"); });
    guardRedisDatabaseSelection(client);

    expect(emitError(client, replyError())).toBe(true);
    expect(client.disconnect.mock.calls).toEqual([[false]]);
    expect(order).toEqual(["disconnect", "destroy"]);
    expect(closeSeen).toBe(false);
    // A double's destroy call proves only the requested action, not socket settlement.
  });

  it("still destroys the captured native stream when disconnect clears it and throws", () => {
    const { client, stream } = redisDouble(), later = vi.fn();
    client.disconnect.mockImplementation(() => { client.stream = undefined; throw new Error(CANARY); });
    guardRedisDatabaseSelection(client); client.on("error", later);

    const error = replyError();
    expect(emitError(client, error)).toBe(true);
    expect(client.disconnect.mock.calls).toEqual([[false]]);
    expect(stream.destroy).toHaveBeenCalledTimes(1);
    expect(later.mock.calls.length === 1 && later.mock.calls[0]?.[0] === error).toBe(true);
  });

  it("does not throw from its listener when native destroy throws", () => {
    const { client, stream } = redisDouble(), later = vi.fn();
    stream.destroy.mockImplementation(() => { throw new Error(CANARY); });
    guardRedisDatabaseSelection(client); client.on("error", later);

    const error = replyError();
    expect(emitError(client, error)).toBe(true);
    expect(client.disconnect.mock.calls).toEqual([[false]]);
    expect(stream.destroy).toHaveBeenCalledTimes(1);
    expect(later.mock.calls.length === 1 && later.mock.calls[0]?.[0] === error).toBe(true);
  });

  it("leaves other driver errors unchanged, even when their message mentions SELECT", () => {
    const { client, stream } = redisDouble(), observer = vi.fn();
    guardRedisDatabaseSelection(client); client.on("error", observer);
    const first = Object.assign(new Error(`SELECT ${CANARY}`), { command: { name: "get", args: [CANARY] } });
    const errors = [first,
      new Error(`SELECT ${CANARY}`), replyError("SELECT"), Object.assign(new Error(CANARY), { command: null })];

    for (const error of errors) expect(emitError(client, error)).toBe(true);
    expect(client.disconnect).not.toHaveBeenCalled(); expect(stream.destroy).not.toHaveBeenCalled();
    expect(observer.mock.calls.length === errors.length
      && observer.mock.calls.every((call, index) => call.length === 1 && call[0] === errors[index])).toBe(true);
    expect(first.command.args[0] === CANARY).toBe(true);
  });

  it("does not invoke getters or accept inherited command identity as driver evidence", () => {
    const { client, stream } = redisDouble();
    const commandGetter = vi.fn(() => { throw new Error(CANARY); });
    const nameGetter = vi.fn(() => { throw new Error(CANARY); });
    const accessorCommand = Object.defineProperty(new Error(CANARY), "command", { get: commandGetter });
    const accessorName = Object.assign(new Error(CANARY), { command: Object.defineProperty({}, "name", { get: nameGetter }) });
    const inheritedCommand = Object.create({ command: { name: "select", args: [CANARY] } }) as object;
    const inheritedName = Object.assign(new Error(CANARY), { command: Object.create({ name: "select" }) as object });
    guardRedisDatabaseSelection(client);

    for (const error of [accessorCommand, accessorName, inheritedCommand, inheritedName]) expect(emitError(client, error)).toBe(true);
    expect(commandGetter).not.toHaveBeenCalled(); expect(nameGetter).not.toHaveBeenCalled();
    expect(client.disconnect).not.toHaveBeenCalled(); expect(stream.destroy).not.toHaveBeenCalled();
  });

  it("never reports the original error, command args, or teardown errors to console", () => {
    const writes = ["debug", "error", "info", "log", "trace", "warn"] as const;
    const spies = writes.map(method => vi.spyOn(console, method).mockImplementation(() => {}));
    try {
      const { client, stream } = redisDouble();
      client.disconnect.mockImplementation(() => { throw new Error(CANARY); });
      stream.destroy.mockImplementation(() => { throw new Error(CANARY); });
      guardRedisDatabaseSelection(client);
      expect(emitError(client, replyError())).toBe(true);
      expect(emitError(client, replyError("get"))).toBe(true);
      expect(client.disconnect.mock.calls).toEqual([[false]]); expect(stream.destroy).toHaveBeenCalledTimes(1);
      expect(spies.every(spy => spy.mock.calls.length === 0)).toBe(true);
    } finally { for (const spy of spies) spy.mockRestore(); }
  });
});
