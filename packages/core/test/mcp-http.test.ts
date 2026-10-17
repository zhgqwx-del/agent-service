import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpHttpFetch, McpHttpError, type McpHttpAddress, type McpHttpFetch, type McpHttpOptions } from "../src/mcp/http.js";

const servers: Server[] = [];
const fixtureHost = "mcp.fixture.test";
const defaults = { maxRequestBytes: 1_024, maxResponseBytes: 1_024, timeoutMs: 2_000 };
const jsonHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const post: RequestInit = {
  method: "POST",
  headers: jsonHeaders,
  body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
};

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("MCP_ALLOW_LOOPBACK_FOR_TESTS", "1");
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  vi.unstubAllEnvs();
});

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ endpoint: string; server: Server }> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not listen.");
  return { server, endpoint: `http://${fixtureHost}:${address.port}/mcp` };
}

function fixtureFetch(endpoint: string, overrides: Partial<McpHttpOptions> = {}): McpHttpFetch {
  return createMcpHttpFetch({
    ...defaults,
    endpoint,
    allowLoopbackForTests: true,
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    ...overrides,
  });
}

async function rejection(promise: Promise<unknown>, code: McpHttpError["code"]): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "McpHttpError", code, message: `MCP HTTP ${code}.` });
}

function observeSocketClose(socket: IncomingMessage["socket"]): Promise<void> {
  if (socket.closed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let unexpected: Error | undefined;
    const onError = (error: NodeJS.ErrnoException) => {
      // Client-side destroy can intentionally reset an unread fixture connection. Unlike
      // events.once(socket, "close"), this still waits for the real close after that reset.
      if (error.code !== "ECONNRESET") unexpected = error;
    };
    socket.on("error", onError);
    socket.once("close", () => {
      socket.removeListener("error", onError);
      if (!socket.closed) reject(new Error("Fixture socket close did not settle."));
      else if (unexpected) reject(unexpected);
      else resolve();
    });
  });
}

describe("MCP bounded, pinned HTTP fetch", () => {
  it("pins the actual socket once, preserves Host/path and returns correct Response metadata", async () => {
    let seen: IncomingMessage | undefined;
    let receivedBody = "";
    const { endpoint } = await serve((request, response) => {
      seen = request;
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { receivedBody += chunk; });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json", "mcp-protocol-version": "2026-07-28" });
        response.end('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}');
      });
    });
    const lookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 as const }]);
    // A proxy environment must never become an extra route or receive the MCP payload.
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:1");
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:1");
    const result = await fixtureFetch(endpoint, { lookup })(new URL(endpoint), {
      ...post,
      headers: { ...jsonHeaders, "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list", "mcp-name": "list_tools" },
      redirect: "error",
    });
    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(200);
    expect(result.statusText).toBe("OK");
    expect(result.url).toBe(endpoint);
    expect(result.type).toBe("basic");
    expect(result.redirected).toBe(false);
    expect(result.headers.get("mcp-protocol-version")).toBe("2026-07-28");
    await expect(result.json()).resolves.toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    expect(lookup).toHaveBeenCalledExactlyOnceWith(fixtureHost);
    expect(seen?.headers.host).toBe(new URL(endpoint).host);
    expect(seen?.headers["accept-encoding"]).toBe("identity");
    expect(seen?.headers.authorization).toBeUndefined();
    expect(seen?.headers.cookie).toBeUndefined();
    expect(seen?.url).toBe("/mcp");
    expect(receivedBody).toBe(post.body);
  });

  it("accepts a Request input with finite SSE and does not manufacture replay cursors", async () => {
    const { endpoint } = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('event: message\ndata: {"result":');
      response.end('{"tools":[]}}\n\n');
    });
    const response = await fixtureFetch(endpoint)(new Request(endpoint, post));
    expect(await response.text()).toBe('event: message\ndata: {"result":{"tools":[]}}\n\n');
    expect(response.headers.get("last-event-id")).toBeNull();
  });

  it("freshly validates DNS for every exchange, rejecting a rebound address before its second connection", async () => {
    let hits = 0;
    const { endpoint } = await serve((_request, response) => { hits++; response.end("{}"); });
    const lookup = vi.fn<NonNullable<McpHttpOptions["lookup"]>>()
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }])
      .mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    const fetch = fixtureFetch(endpoint, { lookup });
    await (await fetch(endpoint, post)).text();
    await rejection(fetch(endpoint, post), "address_rejected");
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(hits).toBe(1);
  });

  it.each<McpHttpAddress[][]>([
    [[{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }]],
    [[{ address: "2606:4700:4700::1111", family: 6 }, { address: "::1", family: 6 }]],
    [[{ address: "8.8.8.8", family: 6 }]],
    [[]],
  ])("rejects the complete mixed or malformed DNS answer set %j", async (answers) => {
    const endpoint = "https://mcp.fixture.test/rpc";
    const fetch = createMcpHttpFetch({ ...defaults, endpoint, lookup: async () => answers });
    await rejection(fetch(endpoint, post), "address_rejected");
  });

  it.each([
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "100.127.255.254", "127.0.0.1", "169.254.169.254",
    "172.16.0.1", "172.31.255.254", "192.0.0.9", "192.0.2.1", "192.31.196.1", "192.52.193.1",
    "192.88.99.1", "192.168.0.1", "192.175.48.1", "198.18.0.1", "198.19.255.254", "198.51.100.1",
    "203.0.113.1", "224.0.0.1", "239.255.255.254", "240.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "100::1", "fc00::1", "fdff::1",
    "fe80::1", "ff02::1", "2001::1", "2001:2::1", "2001:20::1", "2001:db8::1", "2002:7f00:1::1",
    "2620:4f:8000::1", "3ffe::1", "3fff::1", "5f00::1", "2001:4860::1%zone", "not-an-ip",
  ])("rejects special-purpose or malformed address %s without opening a socket", async (address) => {
    const endpoint = "https://mcp.fixture.test/rpc";
    const family = address.includes(":") ? 6 : 4;
    const fetch = createMcpHttpFetch({ ...defaults, endpoint, lookup: async () => [{ address, family }] });
    await rejection(fetch(endpoint, post), "address_rejected");
  });

  it("allows HTTP only when every answer is the explicitly enabled fixture loopback", async () => {
    const fetch = fixtureFetch("http://mcp.fixture.test/rpc", { lookup: async () => [{ address: "8.8.8.8", family: 4 }] });
    await rejection(fetch("http://mcp.fixture.test/rpc", post), "address_rejected");
  });

  it.each(["production", "development"])("never permits the loopback or lookup escape in NODE_ENV=%s", (environment) => {
    vi.stubEnv("NODE_ENV", environment);
    expect(() => fixtureFetch("http://127.0.0.1/mcp")).toThrow(expect.objectContaining({ code: "invalid_options" }));
    expect(() => createMcpHttpFetch({ ...defaults, endpoint: "https://mcp.fixture.test/rpc", lookup: async () => [] }))
      .toThrow(expect.objectContaining({ code: "invalid_options" }));
  });

  it("requires the explicit fixture switch and rechecks it on every request", async () => {
    vi.stubEnv("MCP_ALLOW_LOOPBACK_FOR_TESTS", "0");
    expect(() => fixtureFetch("http://127.0.0.1/mcp")).toThrow(expect.objectContaining({ code: "invalid_options" }));
    vi.stubEnv("MCP_ALLOW_LOOPBACK_FOR_TESTS", "1");
    const fetch = fixtureFetch("http://127.0.0.1/mcp");
    vi.stubEnv("NODE_ENV", "production");
    await rejection(fetch("http://127.0.0.1/mcp", post), "invalid_options");
  });

  it.each([
    "http://public.example/rpc", "https://user:password@public.example/rpc", "https://public.example/rpc#fragment",
    "https://public.example/rpc#", "https://public.example/rpc?", "https://public.example/rpc?credential=fixture-only",
    "ftp://public.example/rpc", "https://localhost/rpc", "https://host.internal/rpc", "https://host.local/rpc",
    "https://host.localhost/rpc", "https://hidden.onion/rpc", "not a url",
  ])("rejects unsafe endpoint %s", (endpoint) => {
    expect(() => createMcpHttpFetch({ ...defaults, endpoint })).toThrow(expect.objectContaining({ code: "invalid_options" }));
  });

  it.each([0, -1, NaN, Infinity, 0.5, 2_147_483_648])("rejects invalid whole-operation budgets %s", (budget) => {
    for (const key of ["timeoutMs", "maxRequestBytes", "maxResponseBytes"] as const) {
      expect(() => createMcpHttpFetch({ ...defaults, endpoint: "https://public.example/rpc", [key]: budget }))
        .toThrow(expect.objectContaining({ code: "invalid_options" }));
    }
  });

  it.each(["GET", "DELETE", "PUT", "PATCH", "HEAD"])("rejects the unsupported %s path before DNS", async (method) => {
    const lookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 as const }]);
    const endpoint = "http://mcp.fixture.test/rpc";
    await rejection(fixtureFetch(endpoint, { lookup })(endpoint, { method }), "method_rejected");
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(["https://other.example/rpc", "https://public.example/other", "https://public.example/rpc?redirect=1", "https://public.example:444/rpc"])
    ("rejects endpoint switching to %s", async (target) => {
      await rejection(createMcpHttpFetch({ ...defaults, endpoint: "https://public.example/rpc" })(target, post), "endpoint_mismatch");
    });

  it.each([
    ["authorization", "Bearer fixture-only"], ["cookie", "fixture=1"], ["host", "other.example"],
    ["x-internal-token", "fixture-only"], ["proxy-authorization", "fixture-only"], ["mcp-session-id", "legacy"],
    ["last-event-id", "legacy"], ["user-agent", "ambient"], ["content-length", "1"], ["accept-encoding", "gzip"],
    ["content-type", "text/plain"], ["accept", "*/*"], ["mcp-protocol-version", "arbitrary"],
    ["mcp-method", "tools/list, unrelated"], ["mcp-name", "name with spaces"], ["mcp-name", "x".repeat(1_025)],
  ])("rejects non-contract or invalid header %s", async (name, value) => {
    const endpoint = "http://mcp.fixture.test/rpc";
    await rejection(fixtureFetch(endpoint)(endpoint, { ...post, headers: { ...jsonHeaders, [name]: value } }), "header_rejected");
  });

  it.each(["agent", "dispatcher", "proxy"])("rejects caller transport override %s", async (name) => {
    const endpoint = "http://mcp.fixture.test/rpc";
    await rejection(fixtureFetch(endpoint)(endpoint, { ...post, [name]: {} } as RequestInit), "invalid_request");
  });

  it("rejects caller ambient credentials, integrity and keepalive", async () => {
    const endpoint = "http://mcp.fixture.test/rpc";
    for (const option of [{ credentials: "include" }, { integrity: "sha256-fixture" }, { keepalive: true }] as RequestInit[]) {
      await rejection(fixtureFetch(endpoint)(endpoint, { ...post, ...option }), "invalid_request");
    }
  });

  it("refuses redirects rather than exposing a followable Location", async () => {
    let hits = 0;
    const { endpoint } = await serve((_request, response) => {
      hits++;
      response.writeHead(307, { location: "http://169.254.169.254/fixture", "content-type": "text/plain" });
      response.end("do not forward");
    });
    await rejection(fixtureFetch(endpoint)(endpoint, { ...post, redirect: "follow" }), "redirect_rejected");
    expect(hits).toBe(1);
  });

  it("rejects a request byte overflow before DNS or any network side effect", async () => {
    const endpoint = "http://mcp.fixture.test/rpc";
    const lookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 as const }]);
    await rejection(fixtureFetch(endpoint, { lookup, maxRequestBytes: 5 })(endpoint, post), "request_too_large");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("uses UTF-8 bytes rather than JS string length for the request limit", async () => {
    const endpoint = "http://mcp.fixture.test/rpc";
    await rejection(fixtureFetch(endpoint, { maxRequestBytes: 5 })(endpoint, { ...post, body: "你好" }), "request_too_large");
  });

  it("rejects an oversized declared response before exposing it", async () => {
    const { endpoint } = await serve((_request, response) => {
      response.writeHead(200, { "content-length": "2048" });
      response.flushHeaders();
    });
    await rejection(fixtureFetch(endpoint)(endpoint, post), "response_too_large");
  });

  it("bounds chunked response bytes and destroys the socket before the read rejection settles", async () => {
    let closed: Promise<void> | undefined;
    const { endpoint } = await serve((request, response) => {
      closed = observeSocketClose(request.socket);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("1234");
      response.write("5678");
    });
    const response = await fixtureFetch(endpoint, { maxResponseBytes: 6 })(endpoint, post);
    await rejection(response.text(), "response_too_large");
    expect(closed).toBeDefined();
    await closed;
  });

  it("rejects compressed data rather than bypassing the decoded-size budget", async () => {
    const { endpoint } = await serve((_request, response) => {
      response.writeHead(200, { "content-encoding": "gzip" });
      response.end("not actually compressed");
    });
    await rejection(fixtureFetch(endpoint)(endpoint, post), "response_rejected");
  });

  it("applies the deadline to DNS without issuing a late connection", async () => {
    let finishLookup: ((answers: readonly McpHttpAddress[]) => void) | undefined;
    let hits = 0;
    const { endpoint } = await serve((_request, response) => { hits++; response.end("{}"); });
    const lookup = () => new Promise<readonly McpHttpAddress[]>((resolve) => { finishLookup = resolve; });
    const fetch = fixtureFetch(endpoint, { lookup, timeoutMs: 50 });
    await rejection(fetch(endpoint, post), "deadline_exceeded");
    finishLookup?.([{ address: "127.0.0.1", family: 4 }]);
    await fetch.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(hits).toBe(0);
  });

  it("sanitizes DNS errors without preserving their URL or secret-bearing cause", async () => {
    const endpoint = "https://mcp.fixture.test/rpc";
    const fetch = createMcpHttpFetch({ ...defaults, endpoint, lookup: async () => { throw new Error("secret-looking DNS detail"); } });
    await rejection(fetch(endpoint, post), "dns_failed");
    try { await fetch(endpoint, post); } catch (error) {
      expect(error).toBeInstanceOf(McpHttpError);
      expect((error as Error).cause).toBeUndefined();
      expect(String(error)).not.toContain("secret-looking");
      expect(String(error)).not.toContain(fixtureHost);
    }
  });

  it("applies the deadline while waiting for response headers and closes the socket", async () => {
    let closed: Promise<void> | undefined;
    const { endpoint } = await serve((request) => { closed = observeSocketClose(request.socket); });
    await rejection(fixtureFetch(endpoint, { timeoutMs: 100 })(endpoint, post), "deadline_exceeded");
    expect(closed).toBeDefined();
    await closed;
  });

  it("keeps the whole deadline active through a stalled SSE body", async () => {
    let closed: Promise<void> | undefined;
    const { endpoint } = await serve((request, response) => {
      closed = observeSocketClose(request.socket);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: partial\n");
    });
    const response = await fixtureFetch(endpoint, { timeoutMs: 100 })(endpoint, post);
    await rejection(response.text(), "deadline_exceeded");
    expect(closed).toBeDefined();
    await closed;
  });

  it("honors an already aborted signal before DNS", async () => {
    const endpoint = "http://mcp.fixture.test/rpc";
    const controller = new AbortController();
    controller.abort(new Error("private abort reason"));
    const lookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 as const }]);
    await rejection(fixtureFetch(endpoint, { lookup })(endpoint, { ...post, signal: controller.signal }), "aborted");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("honors abort while DNS is pending and never starts its later answer", async () => {
    const endpoint = "http://mcp.fixture.test/rpc";
    const controller = new AbortController();
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    let finishLookup!: (answers: readonly McpHttpAddress[]) => void;
    const lookup = async (): Promise<readonly McpHttpAddress[]> => { started(); return new Promise(resolve => { finishLookup = resolve; }); };
    const fetch = fixtureFetch(endpoint, { lookup });
    const operation = fetch(endpoint, { ...post, signal: controller.signal });
    await entered;
    controller.abort();
    await rejection(operation, "aborted");
    finishLookup([{ address: "127.0.0.1", family: 4 }]);
    await fetch.close();
  });

  it("honors an abort during response consumption and closes its actual socket", async () => {
    const controller = new AbortController();
    let closed: Promise<void> | undefined;
    const { endpoint } = await serve((request, response) => {
      closed = observeSocketClose(request.socket);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: pending\n");
    });
    const response = await fixtureFetch(endpoint)(endpoint, { ...post, signal: controller.signal });
    const reading = response.text();
    controller.abort(new Error("private abort reason"));
    await rejection(reading, "aborted");
    expect(closed).toBeDefined();
    await closed;
  });

  it("cancels the response reader by destroying the underlying exchange", async () => {
    let closed: Promise<void> | undefined;
    const { endpoint } = await serve((request, response) => {
      closed = observeSocketClose(request.socket);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: pending\n");
    });
    const response = await fixtureFetch(endpoint)(endpoint, post);
    await response.body!.cancel();
    expect(closed).toBeDefined();
    await closed;
  });

  it("includes a stalled request-body stream in the whole-operation deadline", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const endpoint = "http://mcp.fixture.test/rpc";
    const init = { ...post, body, duplex: "half" } as RequestInit;
    await rejection(fixtureFetch(endpoint, { timeoutMs: 50 })(endpoint, init), "deadline_exceeded");
    expect(cancelled).toBe(true);
  });

  it.each(["close", "deadline"] as const)("waits for actual request-body cancellation cleanup after %s without delaying the caller rejection", async mode => {
    let readStarted!: () => void, cancelStarted!: () => void, releaseCancel!: () => void;
    const reading = new Promise<void>(resolve => { readStarted = resolve; });
    const cancelling = new Promise<void>(resolve => { cancelStarted = resolve; });
    const cleanup = new Promise<void>(resolve => { releaseCancel = resolve; });
    let cancellationSettled = false, drained = false;
    const body = new ReadableStream<Uint8Array>({
      pull() { readStarted(); },
      cancel() { cancelStarted(); return cleanup.then(() => { cancellationSettled = true; }); },
    });
    const lookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 as const }]);
    const endpoint = "http://mcp.fixture.test/rpc", fetch = fixtureFetch(endpoint, { timeoutMs: 50, lookup });
    const operation = rejection(fetch(endpoint, { ...post, body, duplex: "half" } as RequestInit), mode === "close" ? "aborted" : "deadline_exceeded");
    let closing: Promise<void> | undefined;
    try {
      await reading;
      if (mode === "deadline") await operation;
      closing = fetch.close().then(() => { drained = true; });
      await cancelling; await operation;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(cancellationSettled).toBe(false); expect(drained).toBe(false);
      expect(lookup).not.toHaveBeenCalled();
    } finally { releaseCancel(); await closing; await operation; await fetch.close(); }
    expect(cancellationSettled).toBe(true); expect(drained).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("supports empty 204 responses without constructing an illegal body", async () => {
    const { endpoint } = await serve((_request, response) => { response.writeHead(204); response.end(); });
    const response = await fixtureFetch(endpoint)(endpoint, post);
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(await response.text()).toBe("");
  });

  it("close synchronously fences future requests and drains every concurrent owned socket", async () => {
    const sockets = new Map<IncomingMessage["socket"], Promise<void>>();
    let allEntered!: () => void;
    const entered = new Promise<void>((resolve) => { allEntered = resolve; });
    const { endpoint } = await serve((request, response) => {
      sockets.set(request.socket, observeSocketClose(request.socket));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: pending\n");
      if (sockets.size === 3) allEntered();
    });
    const fetch = fixtureFetch(endpoint);
    const operations = Array.from({ length: 3 }, async () => {
      const response = await fetch(endpoint, post);
      return response.text();
    });
    const rejections = operations.map((operation) => rejection(operation, "aborted"));
    await entered;
    const closing = fetch.close();
    await rejection(fetch(endpoint, post), "aborted");
    await closing;
    await Promise.all(rejections);
    // The remote close event can be scheduled after our owned socket's close event.
    await Promise.all(sockets.values());
    expect([...sockets.keys()].every((socket) => socket.closed)).toBe(true);
    await fetch.close();
  });

  it("close fences a pending DNS exchange without allowing its later connection", async () => {
    let finishLookup!: (answers: readonly McpHttpAddress[]) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let hits = 0;
    const { endpoint } = await serve((_request, response) => { hits++; response.end("{}"); });
    const fetch = fixtureFetch(endpoint, {
      lookup: async () => { entered(); return new Promise((resolve) => { finishLookup = resolve; }); },
    });
    const operation = rejection(fetch(endpoint, post), "aborted");
    await started;
    let drained = false;
    const close = fetch.close().then(() => { drained = true; });
    await operation;
    await Promise.resolve(); expect(drained).toBe(false);
    finishLookup([{ address: "127.0.0.1", family: 4 }]);
    await close; expect(drained).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(hits).toBe(0);
  });
});
