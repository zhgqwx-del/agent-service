import { createServer, get, IncomingMessage } from "node:http";
import { GetObjectCommand, type GetObjectCommandOutput, type S3Client } from "@aws-sdk/client-s3";
import type { RequestListener, ClientRequest } from "node:http";
import type { LookupFunction } from "node:net";
import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { RestoreJournalOwnedNativeHttp } from "../src/restore-journal/owned-native-http.js";
import { S3TenantRestoreJournalAdapter } from "../src/restore-journal/s3.js";

const nativeLookup = vi.hoisted(() => vi.fn<LookupFunction>());
vi.mock("node:dns", async importOriginal => {
  const original = await importOriginal<typeof import("node:dns")>();
  nativeLookup.mockImplementation((hostname, options, callback) =>
    original.lookup(hostname, options, (error, address, family) => callback(error, address, family)));
  return { ...original, lookup: nativeLookup };
});

async function localServer(handler: RequestListener) {
  const server = createServer(handler), sockets = new Set<Socket>(), closed = new Set<Promise<void>>();
  server.on("connection", socket => { sockets.add(socket); const task = new Promise<void>(yes => socket.once("close", () => { sockets.delete(socket); yes(); })); closed.add(task); void task.then(() => closed.delete(task)); });
  await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
  const address = server.address(); if (!address || typeof address === "string") throw Error("missing_local_address");
  return { origin: `http://127.0.0.1:${address.port}`, async close() { const stopped = new Promise<void>((yes, no) => server.close(error => error ? no(error) : yes())); for (const socket of sockets) socket.destroy(); await stopped; while (closed.size) await Promise.all([...closed]); } };
}

/** Do not strand the server in a timeout if the request rejects before reaching the handler. */
async function waitForEntry(entered: Promise<void>, request: Promise<unknown>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_yes, no) => {
    abort = () => no(signal.reason ?? Error("test cancelled"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    await Promise.race([entered, cancelled, request.then(() => { throw Error("request settled before handler entry"); })]);
  } finally { signal.removeEventListener("abort", abort); }
}

describe("restore journal per-instance real native ownership candidate", () => {
  it("joins actual response-body and socket close without touching another agent", async context => {
    let seen!: () => void; const responseStarted = new Promise<void>(yes => { seen = yes; });
    const server = await localServer((_request, response) => { response.writeHead(200); response.write("partial"); seen(); });
    const owned = new RestoreJournalOwnedNativeHttp(), other = new RestoreJournalOwnedNativeHttp(), controller = new AbortController();
    const stop = () => controller.abort(context.signal.reason);
    context.signal.addEventListener("abort", stop, { once: true }); if (context.signal.aborted) stop();
    let read: Promise<unknown> = Promise.resolve();
    try {
      const target = new URL(server.origin); target.hostname = "localhost";
      read = owned.run(() => new Promise<void>((yes, no) => { const request = get(target, { agent: owned.httpAgent, family: 4, signal: controller.signal }, response => { void (async () => { for await (const chunk of response) void chunk; yes(); })().catch(no); }); request.on("error", no); }));
      void read.catch(() => {});
      await waitForEntry(responseStarted, read, context.signal); expect(owned.snapshot().opened).toBe(1);
      const close = owned.close(); expect(owned.close()).toBe(close); await close; await Promise.allSettled([read]);
      expect(owned.snapshot()).toEqual({ opened: 1, nativeClosed: 1, pending: 0, activeSockets: 0, stopped: true, lookupStarted: 1, lookupSettled: 1, activeLookups: 0, activeBodies: 0 });
      expect(other.snapshot().stopped).toBe(false);
    } finally {
      context.signal.removeEventListener("abort", stop); controller.abort();
      try { await owned.close(); await Promise.allSettled([read]); }
      finally { try { await other.close(); } finally { await server.close(); } }
    }
  });

  it("the real SDK uses the owned socket and settles request cancellation before close resolves", async context => {
    let entered!: () => void; const received = new Promise<void>(yes => { entered = yes; });
    const server = await localServer(() => { entered(); }), controller = new AbortController();
    const stop = () => controller.abort(context.signal.reason);
    context.signal.addEventListener("abort", stop, { once: true }); if (context.signal.aborted) stop();
    let adapter: S3TenantRestoreJournalAdapter | undefined, request: Promise<unknown> = Promise.resolve();
    try {
      adapter = new S3TenantRestoreJournalAdapter({ independentFailureDomain: true, bucket: "local-owned-probe", namespaceId: "local-owned-probe", failureDomainId: "same-host-fixture-only", logicalDatabaseNamespaceSha256: "a".repeat(64), region: "us-east-1", endpoint: server.origin, forcePathStyle: true, credentials: { accessKeyId: "public-fixture", secretAccessKey: "public-fixture" }, operationAbortSignal: controller.signal, ownedNativeTransport: true });
      const owned = (adapter as unknown as { ownedNative: RestoreJournalOwnedNativeHttp }).ownedNative;
      request = adapter.readHead(); void request.catch(() => {});
      await waitForEntry(received, request, context.signal); expect(owned.snapshot().opened).toBeGreaterThan(0); controller.abort(); await adapter.close(); await Promise.allSettled([request]);
      const state = owned.snapshot(); expect(state.nativeClosed).toBe(state.opened); expect(state.activeSockets).toBe(0); expect(state.pending).toBe(0);
    } finally { context.signal.removeEventListener("abort", stop); controller.abort(); try { await adapter?.close(); await Promise.allSettled([request]); } finally { await server.close(); } }
  });


  it("waits for the original lookup callback after its actual socket has closed", async context => {
    const original = await vi.importActual<typeof import("node:dns")>("node:dns");
    let entered!: () => void, release!: () => void;
    const lookupEntered = new Promise<void>(yes => { entered = yes; });
    const released = new Promise<void>(yes => { release = yes; });
    // Real system lookup is delegated. Only returning its original callback is held:
    // this is a controlled ownership latch, not a proof that getaddrinfo can be aborted.
    nativeLookup.mockImplementationOnce((hostname, options, callback) => {
      original.lookup(hostname, options, (error, address, family) => {
        entered(); void released.then(() => callback(error, address, family));
      });
    });
    const server = await localServer((_request, response) => { response.end("unused"); });
    const owned = new RestoreJournalOwnedNativeHttp();
    let request: ClientRequest | undefined, socketClosed!: () => void, socketSeen = false;
    const nativeClose = new Promise<void>(yes => { socketClosed = yes; });
    let work: Promise<unknown> = Promise.resolve(), closing: Promise<void> | undefined, finished = false;
    const stop = () => { release(); owned.stop(); };
    context.signal.addEventListener("abort", stop, { once: true });
    try {
      context.signal.throwIfAborted();
      const target = new URL(server.origin); target.hostname = "localhost";
      work = owned.run(() => new Promise<void>((yes, no) => {
        request = get(target, { agent: owned.httpAgent, family: 4 }, response => {
          response.resume(); response.on("end", yes); response.on("error", no);
        });
        request.once("socket", socket => {
          socketSeen = true;
          if (socket.closed) socketClosed(); else socket.once("close", socketClosed);
        });
        request.on("error", no);
      }));
      void work.catch(() => {});
      await waitForEntry(lookupEntered, work, context.signal);
      closing = owned.close(); void closing.then(() => { finished = true; }, () => { finished = true; });
      await nativeClose;
      expect(socketSeen).toBe(true); expect(owned.snapshot().activeSockets).toBe(0);
      expect(owned.snapshot().activeLookups).toBe(1); expect(finished).toBe(false);
      release(); await closing; await Promise.allSettled([work]);
      expect(owned.snapshot()).toMatchObject({ lookupStarted: 1, lookupSettled: 1, activeLookups: 0,
        activeSockets: 0, opened: 1, nativeClosed: 1, pending: 0, stopped: true });
    } finally {
      context.signal.removeEventListener("abort", stop); stop();
      try { await owned.close(); await Promise.allSettled([work]); if (request && socketSeen) await nativeClose; }
      finally {
        await server.close(); nativeLookup.mockReset();
        nativeLookup.mockImplementation((hostname, options, callback) =>
          original.lookup(hostname, options, (error, address, family) => callback(error, address, family)));
      }
    }
  });

  it("preserves a native stop rejection of undefined before a later SDK destroy failure and still joins sockets", async context => {
    let entered!: () => void; const received = new Promise<void>(yes => { entered = yes; });
    const server = await localServer(() => { entered(); }), controller = new AbortController();
    const stop = () => controller.abort(context.signal.reason);
    context.signal.addEventListener("abort", stop, { once: true });
    let adapter: S3TenantRestoreJournalAdapter | undefined, request: Promise<unknown> = Promise.resolve();
    let restoreAgent = () => {}, restoreClient = () => {}, failed = false, first: unknown, expectedFailure = false;
    try {
      context.signal.throwIfAborted();
      adapter = new S3TenantRestoreJournalAdapter({ independentFailureDomain: true, bucket: "local-owned-probe", namespaceId: "local-owned-probe", failureDomainId: "same-host-fixture-only", logicalDatabaseNamespaceSha256: "a".repeat(64), region: "us-east-1", endpoint: server.origin, forcePathStyle: true, credentials: { accessKeyId: "public-fixture", secretAccessKey: "public-fixture" }, operationAbortSignal: controller.signal, ownedNativeTransport: true });
      const owned = (adapter as unknown as { ownedNative: RestoreJournalOwnedNativeHttp }).ownedNative;
      const client = (adapter as unknown as { client: S3Client }).client;
      request = adapter.readHead(); void request.catch(() => {}); await waitForEntry(received, request, context.signal);
      const originalAgent = owned.httpAgent.destroy.bind(owned.httpAgent), originalClient = client.destroy.bind(client);
      const later = new Error("later controlled SDK destroy failure");
      const agentSpy = vi.spyOn(owned.httpAgent, "destroy"); restoreAgent = () => agentSpy.mockRestore();
      agentSpy.mockImplementationOnce(() => { originalAgent(); throw undefined; });
      const clientSpy = vi.spyOn(client, "destroy"); restoreClient = () => clientSpy.mockRestore();
      clientSpy.mockImplementationOnce(() => { originalClient(); throw later; });
      await expect(adapter.close()).rejects.toBeUndefined(); expectedFailure = true;
      expect(clientSpy).toHaveBeenCalledOnce(); await Promise.allSettled([request]);
      expect(owned.snapshot()).toMatchObject({ stopped: true, activeSockets: 0, pending: 0, activeBodies: 0, activeLookups: 0 });
      expect(owned.snapshot().nativeClosed).toBe(owned.snapshot().opened); expect(owned.snapshot().opened).toBeGreaterThan(0);
    } catch (error) { failed = true; first = error; }
    finally {
      context.signal.removeEventListener("abort", stop); controller.abort();
      try { await adapter?.close(); } catch (error) { if ((!expectedFailure || error !== undefined) && !failed) { failed = true; first = error; } }
      await Promise.allSettled([request]); restoreClient(); restoreAgent();
      try { await server.close(); } catch (error) { if (!failed) { failed = true; first = error; } }
    }
    if (failed) throw first;
  });

  it("joins a late real SDK Body and its held original destroy callback after the actual socket closes", async context => {
    const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; };
    const produced = deferred(), late = deferred(), destroyEntered = deferred(), releaseBody = deferred(), observed = deferred();
    const server = await localServer((_request, response) => { response.writeHead(200, { "content-type": "application/octet-stream", "content-length": "1024" }); response.write("partial"); });
    const controller = new AbortController();
    let adapter: S3TenantRestoreJournalAdapter | undefined, body: IncomingMessage | undefined;
    let request: Promise<unknown> = Promise.resolve(), closing: Promise<void> | undefined, clientClosed: Promise<void> | undefined;
    let bodyClosed: Promise<void> | undefined, finished = false, failed = false, first: unknown;
    let restoreDestroy = () => {}, restoreObserve = () => {};
    const stop = () => { late.resolve(); releaseBody.resolve(); controller.abort(context.signal.reason); };
    context.signal.addEventListener("abort", stop, { once: true });
    try {
      context.signal.throwIfAborted();
      adapter = new S3TenantRestoreJournalAdapter({ independentFailureDomain: true, bucket: "local-owned-probe", namespaceId: "local-owned-probe", failureDomainId: "same-host-fixture-only", logicalDatabaseNamespaceSha256: "a".repeat(64), region: "us-east-1", endpoint: server.origin, forcePathStyle: true, credentials: { accessKeyId: "public-fixture", secretAccessKey: "public-fixture" }, operationAbortSignal: controller.signal, ownedNativeTransport: true });
      const owned = (adapter as unknown as { ownedNative: RestoreJournalOwnedNativeHttp }).ownedNative;
      const client = (adapter as unknown as { client: S3Client }).client;
      const originalObserve = owned.observeBody.bind(owned), observeSpy = vi.spyOn(owned, "observeBody"); restoreObserve = () => observeSpy.mockRestore();
      observeSpy.mockImplementation(value => { originalObserve(value); observed.resolve(); });
      const send = (adapter as unknown as { send(run: (signal: AbortSignal) => Promise<GetObjectCommandOutput>): Promise<GetObjectCommandOutput> }).send.bind(adapter);
      // Real client/Node transport and native GET. Hold only returning its real SDK result to the
      // adapter; this is a response-loss latch, not a fake SDK client or synthetic success.
      request = send(async signal => {
        const output = await client.send(new GetObjectCommand({ Bucket: "local-owned-probe", Key: "late-fixture" }), { abortSignal: signal });
        if (!(output.Body instanceof IncomingMessage)) throw Error("expected_real_node_body");
        body = output.Body; body.on("error", () => {});
        const socket = body.socket;
        clientClosed = socket.closed ? Promise.resolve() : new Promise<void>(yes => socket.once("close", () => yes()));
        bodyClosed = body.closed ? Promise.resolve() : new Promise<void>(yes => body!.once("close", () => yes()));
        const originalDestroy = body._destroy.bind(body), destroySpy = vi.spyOn(body, "_destroy"); restoreDestroy = () => destroySpy.mockRestore();
        destroySpy.mockImplementation((error, callback) => originalDestroy(error, actualError => {
          destroyEntered.resolve(); void releaseBody.promise.then(() => callback(actualError));
        }));
        produced.resolve(); await late.promise; return output;
      });
      void request.catch(() => {}); await waitForEntry(produced.promise, request, context.signal);
      controller.abort(); closing = adapter.close(); void closing.then(() => { finished = true; }, () => { finished = true; });
      await clientClosed; expect(owned.snapshot().activeSockets).toBe(0); expect(finished).toBe(false);
      expect(body?.closed).toBe(false); late.resolve();
      await waitForEntry(observed.promise, closing, context.signal); await waitForEntry(destroyEntered.promise, closing, context.signal);
      expect(owned.snapshot().activeBodies).toBe(1); expect(body?.closed).toBe(false); expect(finished).toBe(false);
      releaseBody.resolve(); await bodyClosed; await closing; await Promise.allSettled([request]);
      expect(body?.closed).toBe(true); expect(finished).toBe(true);
      expect(owned.snapshot()).toMatchObject({ stopped: true, activeSockets: 0, pending: 0, activeBodies: 0, activeLookups: 0 });
      expect(owned.snapshot().nativeClosed).toBe(owned.snapshot().opened);
    } catch (error) { failed = true; first = error; }
    finally {
      context.signal.removeEventListener("abort", stop); stop();
      try { await adapter?.close(); } catch (error) { if (!failed) { failed = true; first = error; } }
      await Promise.allSettled([request]); if (bodyClosed) await bodyClosed; if (clientClosed) await clientClosed;
      restoreObserve(); restoreDestroy();
      try { await server.close(); } catch (error) { if (!failed) { failed = true; first = error; } }
    }
    if (failed) throw first;
  });

  it("cannot claim default native ownership for an injected fake client", () => {
    expect(() => new S3TenantRestoreJournalAdapter({ independentFailureDomain: true, bucket: "local-owned-probe", namespaceId: "local-owned-probe", failureDomainId: "same-host-fixture-only", logicalDatabaseNamespaceSha256: "a".repeat(64), region: "us-east-1", endpoint: "http://127.0.0.1:1", forcePathStyle: true, ownedNativeTransport: true, client: {} as never })).toThrow("forbids an injected client");
  });
});
