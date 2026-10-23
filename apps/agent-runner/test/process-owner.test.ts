import { request as httpRequest, type Server } from "node:http";
import { serve } from "@hono/node-server";
import { describe, expect, it, vi } from "vitest";
import { CloseFailures, ProcessHttpOwner } from "@agent-service/protocol";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function boundary<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void work.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => {
      signal.removeEventListener("abort", abort); reject(error);
    });
  });
}

describe("internal HTTP process ownership", () => {
  it("starts every cancellation synchronously despite a throw and joins the original pending stop", async () => {
    const failures = new CloseFailures(), release = gate(), called: string[] = [];
    const failure = new Error("synthetic first cancellation failure");
    const stopping = failures.start([
      () => { called.push("first"); throw failure; },
      () => { called.push("second"); return release.promise; },
    ]);
    expect(called).toEqual(["first", "second"]);
    let settled = false; void stopping.then(() => { settled = true; });
    try {
      await Promise.resolve(); expect(settled).toBe(false);
      expect(() => failures.throwIfAny()).toThrow(failure);
    } finally { release.resolve(); await stopping; }
    expect(() => failures.throwIfAny()).toThrow(failure);
  });

  it("fences new keep-alive work and joins the original non-stream handler after abort", async context => {
    const entered = gate(), release = gate();
    let signal: AbortSignal | undefined, calls = 0;
    const owner = new ProcessHttpOwner(async request => {
      calls++; signal = request.signal; entered.resolve(); await release.promise;
      return Response.json({ synthetic: true });
    });
    const abort = () => release.resolve(); context.signal.addEventListener("abort", abort, { once: true });
    try {
      const response = owner.fetch(new Request("http://127.0.0.1/v1/config"));
      await entered.promise;
      owner.stopAccepting(); owner.abort();
      let settled = false;
      const closing = owner.settle().then(() => { settled = true; });
      await Promise.resolve(); expect(settled).toBe(false); expect(signal?.aborted).toBe(true);
      expect((await owner.fetch(new Request("http://127.0.0.1/v1/config"))).status).toBe(503);
      expect((await owner.fetch(new Request("http://127.0.0.1/readyz"))).status).toBe(503);
      expect(calls).toBe(1);
      release.resolve(); await response; await closing;
    } finally { release.resolve(); owner.abort(); await owner.settle(); context.signal.removeEventListener("abort", abort); }
  });

  it("passes normal body bytes without buffering and joins EOF", async () => {
    const bytes = new TextEncoder();
    const owner = new ProcessHttpOwner(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes.encode("one")); controller.enqueue(bytes.encode("two")); controller.close(); },
    }), { status: 201, headers: { "x-synthetic": "yes" } }));
    const response = await owner.fetch(new Request("http://127.0.0.1/v1/synthetic"));
    expect(response.status).toBe(201); expect(response.headers.get("x-synthetic")).toBe("yes");
    expect(await response.text()).toBe("onetwo"); owner.stopAccepting(); await owner.settle();
  });

  it("retains the actual source cancellation after the response and pending read have ended", async context => {
    const cancelEntered = gate(), cancelMayEnd = gate();
    const owner = new ProcessHttpOwner(() => new Response(new ReadableStream<Uint8Array>({
      cancel() { cancelEntered.resolve(); return cancelMayEnd.promise; },
    })));
    const abort = () => cancelMayEnd.resolve(); context.signal.addEventListener("abort", abort, { once: true });
    try {
      const response = await owner.fetch(new Request("http://127.0.0.1/v1/events"));
      const read = response.body!.getReader().read(); void read.catch(() => {});
      owner.abort(); await cancelEntered.promise;
      await expect(read).rejects.toMatchObject({ name: "AbortError" });
      let settled = false; const closing = owner.settle().then(() => { settled = true; });
      await Promise.resolve(); expect(settled).toBe(false);
      cancelMayEnd.resolve(); await closing;
    } finally { cancelMayEnd.resolve(); owner.abort(); await owner.settle(); context.signal.removeEventListener("abort", abort); }
  });

  it("keeps raw-request abort propagation after fetch returns a streaming Response", async () => {
    const input = new AbortController(), cancelled = vi.fn();
    const owner = new ProcessHttpOwner(() => new Response(new ReadableStream<Uint8Array>({ cancel: cancelled })));
    const response = await owner.fetch(new Request("http://127.0.0.1/v1/events", { signal: input.signal }));
    input.abort(); await owner.settle(); expect(cancelled).toHaveBeenCalledOnce();
    await expect(response.text()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("surfaces actual cancel rejection instead of certifying shutdown success", async () => {
    const failure = new Error("synthetic private cancellation failure");
    const owner = new ProcessHttpOwner(() => new Response(new ReadableStream<Uint8Array>({
      cancel() { return Promise.reject(failure); },
    })));
    await owner.fetch(new Request("http://127.0.0.1/v1/events"));
    owner.abort(); await expect(owner.settle()).rejects.toBe(failure);
  });

  it("does not promote an already-errored business response into process close failure", async () => {
    const failure = new Error("synthetic body transport failure");
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const owner = new ProcessHttpOwner(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) { source = controller; }, cancel,
    }), { status: 502 }));
    const response = await owner.fetch(new Request("http://127.0.0.1/v1/events"));
    expect(response.status).toBe(502);
    const read = response.body!.getReader().read(); void read.catch(() => {});
    // Same tick: owner cancellation may observe the errored state before the pull's catch executes.
    source.error(failure); owner.abort();
    await read.catch(() => {}); await owner.settle(); expect(cancel).not.toHaveBeenCalled();
  });

  it("joins ordinary downstream cancellation without treating it as infrastructure failure", async () => {
    const cancel = vi.fn();
    const owner = new ProcessHttpOwner(() => new Response(new ReadableStream<Uint8Array>({ cancel })));
    const response = await owner.fetch(new Request("http://127.0.0.1/v1/events"));
    await response.body!.cancel(); owner.abort(); await owner.settle(); expect(cancel).toHaveBeenCalledOnce();
  });

  it("joins independent close actions and retains the first observed error", async () => {
    const held = gate(), failure = new Error("first"), later = vi.fn();
    const failures = new CloseFailures();
    let finished = false;
    const closing = failures.stage([() => { throw failure; }, () => held.promise, later]).then(() => { finished = true; });
    await Promise.resolve(); await Promise.resolve(); expect(later).toHaveBeenCalledOnce(); expect(finished).toBe(false);
    held.resolve(); await closing; expect(() => failures.throwIfAny()).toThrow(failure);
  });

  it("distinguishes a closed native downstream socket from an unfinished source cancel", async context => {
    const cancelEntered = gate(), cancelMayEnd = gate(), firstData = gate(), clientClosed = gate();
    const bytes = new TextEncoder();
    const owner = new ProcessHttpOwner(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes.encode("event: synthetic\ndata: {}\n\n")); },
      cancel() { cancelEntered.resolve(); return cancelMayEnd.promise; },
    }), { headers: { "Content-Type": "text/event-stream" } }));
    const server = serve({ fetch: owner.fetch, port: 0, hostname: "127.0.0.1" }) as Server;
    if (!server.listening) await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("expected native TCP listener");
    const client = httpRequest({ hostname: "127.0.0.1", port: address.port, path: "/v1/events" }, response => {
      response.on("error", () => {}); response.once("data", () => firstData.resolve());
    });
    client.on("error", () => {});
    client.once("socket", socket => { socket.once("close", () => clientClosed.resolve()); if (socket.closed) clientClosed.resolve(); });
    client.end();
    const abort = () => { cancelMayEnd.resolve(); client.destroy(); owner.abort(); server.closeAllConnections?.(); };
    context.signal.addEventListener("abort", abort, { once: true });
    let serverClosed: Promise<void> | undefined;
    try {
      await boundary(firstData.promise, context.signal); owner.stopAccepting(); owner.abort();
      serverClosed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      void serverClosed.catch(() => {});
      await boundary(cancelEntered.promise, context.signal); await boundary(clientClosed.promise, context.signal);
      let settled = false; const closing = owner.settle().then(() => { settled = true; });
      await Promise.resolve(); expect(settled).toBe(false);
      cancelMayEnd.resolve(); await closing; server.closeAllConnections?.(); await serverClosed;
    } finally {
      abort(); await owner.settle();
      serverClosed ??= new Promise<void>(resolve => server.close(() => resolve()));
      await serverClosed; await clientClosed.promise; context.signal.removeEventListener("abort", abort);
    }
  });

  it("joins a partial native POST only after actual connection close wakes the input body read", async context => {
    const entered = gate(), clientClosed = gate();
    const owner = new ProcessHttpOwner(async request => {
      entered.resolve(); await request.text(); return Response.json({ synthetic: true });
    });
    const server = serve({ fetch: owner.fetch, port: 0, hostname: "127.0.0.1" }) as Server;
    if (!server.listening) await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("expected native TCP listener");
    const client = httpRequest({ hostname: "127.0.0.1", port: address.port, method: "POST", path: "/v1/synthetic",
      headers: { "Content-Length": "32" } });
    client.on("error", () => {});
    client.once("socket", socket => { socket.once("close", () => clientClosed.resolve()); if (socket.closed) clientClosed.resolve(); });
    client.write("x"); // Deliberately no end(): handler is waiting for the remaining declared bytes.
    let serverClosed: Promise<void> | undefined;
    const abort = () => { client.destroy(); owner.abort(); server.closeAllConnections(); entered.resolve(); };
    context.signal.addEventListener("abort", abort, { once: true });
    try {
      await boundary(entered.promise, context.signal); owner.stopAccepting(); owner.abort();
      serverClosed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      void serverClosed.catch(() => {});
      let settled = false; const closing = owner.settle().then(() => { settled = true; });
      await new Promise<void>(resolve => setImmediate(resolve)); expect(settled).toBe(false);
      server.closeAllConnections(); await closing; await serverClosed; await clientClosed.promise;
    } finally {
      abort(); await owner.settle(); serverClosed ??= new Promise<void>(resolve => server.close(() => resolve()));
      await serverClosed; await clientClosed.promise; context.signal.removeEventListener("abort", abort);
    }
  });

});
