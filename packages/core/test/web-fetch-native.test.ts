import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { webFetchTool } from "../src/tools/builtin/index.js";
import { createWebFetchTool } from "../src/tools/builtin/web-fetch-tool.js";
import { PublicWebError, readPublicWeb, type PublicWebTestOptions } from "../src/tools/builtin/public-web.js";
import { createWebFetchTlsFixture, type WebFetchTlsFixture } from "./fixtures/web-fetch-tls.js";

const hostname = "web-fetch.fixture.test";
const servers: Server[] = [];
let tlsFixture: WebFetchTlsFixture;
const context = (signal = new AbortController().signal) => ({ principal: { tenantId: "tenant", userId: "user" },
  sessionId: "session", turnId: "turn", toolCallId: "call", signal });
const fixture = (extra: PublicWebTestOptions = {}): PublicWebTestOptions => ({
  allowLoopback: true, lookup: async () => [{ address: "127.0.0.1", family: 4 }], ...extra,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void, tls = false) {
  const server = tls ? createHttpsServer({ key: tlsFixture.key, cert: tlsFixture.cert }, handler) : createServer(handler);
  servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No fixture address");
  return new URL(`${tls ? "https" : "http"}://${hostname}:${address.port}/page?q=one`);
}
/** A peer may observe close after the local native close; always join its actual event. */
function socketClose(socket: Socket): Promise<void> {
  if (socket.closed) return Promise.resolve();
  socket.on("error", () => {}); // An intentional client reset still needs its actual close event.
  return new Promise<void>(resolve => socket.once("close", () => resolve()));
}
beforeAll(async () => { tlsFixture = await createWebFetchTlsFixture(); });
afterAll(async () => { if (tlsFixture) await tlsFixture.cleanup(); });
beforeEach(() => { vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("WEB_FETCH_ALLOW_LOOPBACK_FOR_TESTS", "1"); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  vi.unstubAllEnvs();
});

describe("web_fetch native public HTTP(S) and socket ownership", () => {
  it("pins the actual socket to one validated DNS answer and preserves Host/path without global fetch or proxy", async () => {
    let seen: { host?: string; path?: string; localAddress?: string; authorization?: string; cookie?: string; userAgent?: string } | undefined;
    const url = await serve((request, response) => {
      // Native close can clear socket address fields before the tool resolves.
      // Capture the actual live peer observation, not a mutable post-close socket.
      seen = { host: request.headers.host, path: request.url, localAddress: request.socket.localAddress,
        authorization: request.headers.authorization, cookie: request.headers.cookie, userAgent: request.headers["user-agent"] };
      response.end("<p>public page</p><script>hidden</script>");
    });
    const lookup = vi.fn<NonNullable<PublicWebTestOptions["lookup"]>>()
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }])
      .mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    const ambientFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Global fetch must not be used"));
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:1"); vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:1");
    const result = await createWebFetchTool(fixture({ lookup })).execute({ url: url.href }, context());
    expect(result).toEqual({ content: [{ type: "text", text: "HTTP 200\npublic page" }], isError: false });
    expect(lookup).toHaveBeenCalledExactlyOnceWith(hostname); expect(ambientFetch).not.toHaveBeenCalled();
    expect(seen?.host).toBe(url.host); expect(seen?.path).toBe("/page?q=one");
    expect(seen?.localAddress).toBe("127.0.0.1");
    expect(seen?.authorization).toBeUndefined(); expect(seen?.cookie).toBeUndefined();
    expect(seen?.userAgent).toBe("agent-runner/0.1");
  });

  it("resolves every new call freshly and rejects a changed private answer before a second connection", async () => {
    let hits = 0;
    const url = await serve((_request, response) => { hits++; response.end("first"); });
    const lookup = vi.fn<NonNullable<PublicWebTestOptions["lookup"]>>()
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }])
      .mockResolvedValueOnce([{ address: "10.0.0.1", family: 4 }]);
    const tool = createWebFetchTool(fixture({ lookup }));
    expect((await tool.execute({ url: url.href }, context())).isError).toBe(false);
    expect((await tool.execute({ url: url.href }, context())).content[0]).toMatchObject({ text: "blocked: host is not a public destination" });
    expect(hits).toBe(1); expect(lookup).toHaveBeenCalledTimes(2);
  });

  it.each<[readonly { address: string; family: 4 | 6 }[]]>([
    [[{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }]],
    [[{ address: "2606:4700:4700::1111", family: 6 }, { address: "::1", family: 6 }]],
    [[{ address: "8.8.8.8", family: 4 }, { address: "fd00::1", family: 6 }]],
    [[{ address: "8.8.8.8", family: 6 }]], [[]],
    [[{ address: "::ffff:127.0.0.1", family: 6 }]], [[{ address: "2002:7f00:1::1", family: 6 }]],
    [[{ address: "198.18.0.1", family: 4 }]], [[{ address: "224.0.0.1", family: 4 }]],
  ])("rejects every mixed/private/malformed DNS set before opening a socket: %j", async addresses => {
    await expect(readPublicWeb(new URL(`https://${hostname}/page`), context().signal, { lookup: async () => addresses }))
      .rejects.toMatchObject({ code: "address_rejected" });
  });

  it("does not enable a production loopback bypass through environment or tool parameters", async () => {
    for (const url of ["http://127.0.0.1/page", "https://[::1]/page"]) {
      const result = await webFetchTool.execute({ url, allowLoopback: true, ca: tlsFixture.ca }, context());
      expect(result.isError).toBe(true); expect(result.content[0]).toMatchObject({ text: expect.stringContaining("blocked") });
    }
    vi.stubEnv("NODE_ENV", "production");
    await expect(readPublicWeb(new URL(`https://${hostname}/page`), context().signal, fixture({ ca: tlsFixture.ca })))
      .rejects.toMatchObject({ code: "invalid_options" });
    vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("WEB_FETCH_ALLOW_LOOPBACK_FOR_TESTS", "0");
    await expect(readPublicWeb(new URL(`https://${hostname}/page`), context().signal, fixture()))
      .rejects.toMatchObject({ code: "invalid_options" });
  });

  it("refuses URL credentials before DNS so native requests cannot manufacture Authorization", async () => {
    const lookup = vi.fn<NonNullable<PublicWebTestOptions["lookup"]>>();
    const result = await createWebFetchTool(fixture({ lookup })).execute({ url: `https://user:secret@${hostname}/page` }, context());
    expect(result).toMatchObject({ isError: true, content: [{ text: "blocked: URL credentials are not allowed" }] });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("keeps hostname TLS verification and SNI while the socket uses the pinned fixture address", async () => {
    let seen: { servername: TLSSocket["servername"]; host?: string; localAddress?: string } | undefined;
    const url = await serve((request, response) => {
      seen = { servername: (request.socket as TLSSocket).servername, host: request.headers.host, localAddress: request.socket.localAddress };
      response.end("secure page");
    }, true);
    const result = await readPublicWeb(url, context().signal, fixture({ ca: tlsFixture.ca }));
    expect(result).toEqual({ status: 200, location: null, text: "secure page" });
    expect(seen?.servername).toBe(hostname); expect(seen?.host).toBe(url.host);
    expect(seen?.localAddress).toBe("127.0.0.1");
  });

  it("rejects an untrusted certificate and a trusted certificate for the wrong hostname without TLS fallback", async () => {
    let hits = 0;
    const url = await serve((_request, response) => { hits++; response.end("must not be received"); }, true);
    await expect(readPublicWeb(url, context().signal, fixture())).rejects.toMatchObject({ code: "transport_failed" });
    const wrong = new URL(url); wrong.hostname = "wrong.web-fetch.fixture.test";
    await expect(readPublicWeb(wrong, context().signal, fixture({ ca: tlsFixture.ca }))).rejects.toMatchObject({ code: "transport_failed" });
    expect(hits).toBe(0);
  });

  it.each([
    ["gzip", gzipSync], ["deflate", deflateSync], ["br", brotliCompressSync],
  ] as const)("decodes %s under the decoded-byte cap and closes an unfinished response", async (encoding, compress) => {
    let peerClosed = Promise.resolve();
    const url = await serve((request, response) => {
      peerClosed = socketClose(request.socket);
      response.writeHead(200, { "content-encoding": encoding });
      response.write(compress(Buffer.alloc(1024 * 1024, "a")));
      // No end: the decoded cap must stop the native exchange, not wait for the peer.
    });
    const result = await readPublicWeb(url, context().signal, fixture({ maxBytes: 512 }));
    expect(result.text).toBe("a".repeat(512)); await peerClosed;
  });

  it("keeps the existing raw-body and returned-text limits and HTTP error status semantics", async () => {
    let peerClosed = Promise.resolve();
    const url = await serve((request, response) => {
      peerClosed = socketClose(request.socket); response.writeHead(404);
      response.write(Buffer.alloc(512 * 1024, "a"));
    });
    const result = await createWebFetchTool(fixture()).execute({ url: url.href }, context());
    expect(result).toEqual({ content: [{ type: "text", text: `HTTP 404\n${"a".repeat(64 * 1024)}` }], isError: true });
    await peerClosed;
  });

  it("rejects unsupported or corrupt compressed bodies and joins their sockets", async () => {
    for (const encoding of ["unknown", "gzip"]) {
      let peerClosed = Promise.resolve();
      const url = await serve((request, response) => {
        peerClosed = socketClose(request.socket); response.writeHead(200, { "content-encoding": encoding }); response.end("not a compressed stream");
      });
      await expect(readPublicWeb(url, context().signal, fixture())).rejects.toBeInstanceOf(PublicWebError);
      await peerClosed;
    }
  });

  it("retains cancellation ownership until pending DNS settles and never opens a late socket", async () => {
    let hits = 0, settled = false;
    const url = await serve((_request, response) => { hits++; response.end("late"); });
    const entered = deferred<void>(), dns = deferred<readonly { address: string; family: 4 }[]>(), abort = new AbortController();
    const operation = readPublicWeb(url, abort.signal, fixture({ lookup: async () => { entered.resolve(); return dns.promise; } }));
    const outcome = operation.then(value => { settled = true; return value; }, error => { settled = true; return error as PublicWebError; });
    await entered.promise; abort.abort(); await new Promise<void>(done => setImmediate(done));
    expect(settled).toBe(false); dns.resolve([{ address: "127.0.0.1", family: 4 }]);
    expect(await outcome).toMatchObject({ code: "aborted" }); expect(hits).toBe(0);
  });

  it("includes pending DNS in the whole deadline and joins it before rejecting", async () => {
    const dns = deferred<readonly { address: string; family: 4 }[]>(); let settled = false;
    const operation = readPublicWeb(new URL(`https://${hostname}/page`), context().signal, fixture({ timeoutMs: 25, lookup: () => dns.promise }));
    const outcome = operation.then(value => { settled = true; return value; }, error => { settled = true; return error as PublicWebError; });
    await new Promise<void>(done => setTimeout(done, 50)); expect(settled).toBe(false);
    dns.resolve([{ address: "127.0.0.1", family: 4 }]); expect(await outcome).toMatchObject({ code: "deadline_exceeded" });
  });

  it("aborts an active response and waits for native body/socket close", async () => {
    const entered = deferred<void>(); let peerClosed = Promise.resolve();
    const url = await serve((request, response) => {
      peerClosed = socketClose(request.socket); response.write("partial"); entered.resolve();
    });
    const abort = new AbortController(), operation = readPublicWeb(url, abort.signal, fixture());
    const outcome = operation.catch(error => error as PublicWebError);
    await entered.promise; abort.abort(); expect(await outcome).toMatchObject({ code: "aborted" }); await peerClosed;
  });

  it("enforces a whole response deadline and does not accept partial success", async () => {
    let peerClosed = Promise.resolve();
    const url = await serve((request, response) => { peerClosed = socketClose(request.socket); response.write("partial"); });
    await expect(readPublicWeb(url, context().signal, fixture({ timeoutMs: 500 }))).rejects.toMatchObject({ code: "deadline_exceeded" });
    await peerClosed;
  });

  it("settles abrupt peer failure without returning a partial body", async () => {
    const url = await serve((_request, response) => { response.writeHead(200, { "content-length": 100 }); response.end("short"); });
    await expect(readPublicWeb(url, context().signal, fixture())).rejects.toMatchObject({ code: "transport_failed" });
  });
});
