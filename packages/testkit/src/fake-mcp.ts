import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { createMcpHandler, fromJsonSchema, McpServer, type McpHttpHandler } from "@modelcontextprotocol/server";

const MAX_REQUEST_BYTES = 32 * 1_024;
const MAX_RESPONSE_BYTES = 128 * 1_024;
const REQUEST_TIMEOUT_MS = 5_000;
const KNOWN_METHODS = new Set([
  "server/discover", "tools/list", "tools/call", "ping", "notifications/cancelled",
] as const);

export type FakeMcpMethod =
  | "server/discover" | "tools/list" | "tools/call" | "ping" | "notifications/cancelled" | "other";

export interface FakeMcpCall {
  readonly name: "echo";
  /** Test-only, in-memory arguments; never emitted to a log or durable store. */
  readonly arguments: Readonly<{ text: string }>;
}

/**
 * Real loopback HTTP backed by the official, modern-only MCP server implementation. It has no
 * credentials, remote dependencies, manually emulated handshake, or production configuration path.
 */
export class FakeMcp {
  toolDescription = "Echo the provided test text.";
  responsePrefix = "echo:";
  /** An explicit override for bounded-result and catalog-change tests. */
  responseText: string | undefined;
  /** Exercises the SDK's bundled structured-output validator without any external validator. */
  structuredOutput = false;
  /** Test-only barrier after receiving a call and before replying; callers must release in finally. */
  beforeReply: (() => Promise<void>) | undefined;
  readonly calls: FakeMcpCall[] = [];
  readonly methods: FakeMcpMethod[] = [];
  readonly methodCounts = new Map<FakeMcpMethod, number>();

  private server: Server | undefined;
  private handler: McpHttpHandler | undefined;
  private endpoint: string | undefined;
  private accepting = false;
  private stopping: Promise<void> | undefined;
  private readonly sockets = new Map<Socket, Promise<void>>();
  private readonly exchanges = new Set<Promise<void>>();
  private readonly controllers = new Set<AbortController>();

  async start(): Promise<string> {
    if (process.env.NODE_ENV !== "test" || this.server || this.stopping) throw new Error("MCP fixture start rejected.");
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: "agent-service-fake-mcp", version: "1.0.0" }, { maxToolInputElements: 16 });
      server.registerTool("echo", {
        description: this.toolDescription,
        inputSchema: fromJsonSchema<{ text: string }>({
          type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false,
        }),
        ...(this.structuredOutput ? { outputSchema: fromJsonSchema<{ echo: string }>({
          type: "object", properties: { echo: { type: "string" } }, required: ["echo"], additionalProperties: false,
        }) } : {}),
        // This is deliberately untrusted metadata: clients must not use it to bypass approval.
        annotations: { readOnlyHint: true, destructiveHint: false },
      }, async ({ text }) => {
        this.calls.push(Object.freeze({ name: "echo", arguments: Object.freeze({ text }) }));
        await this.beforeReply?.();
        const value = this.responseText ?? `${this.responsePrefix}${text}`;
        return {
          content: [{ type: "text", text: value }],
          ...(this.structuredOutput ? { structuredContent: { echo: value } } : {}),
        };
      });
      return server;
    }, {
      legacy: "reject",
      // auto returns JSON for echo and does not emit the SDK's responseMode=json warning.
      responseMode: "auto",
      keepAliveMs: 0,
      maxRequestBodySize: MAX_REQUEST_BYTES,
      onerror: () => {},
    });
    this.handler = handler;
    const server = createServer({ maxHeaderSize: 16_384, requestTimeout: REQUEST_TIMEOUT_MS, headersTimeout: REQUEST_TIMEOUT_MS }, (request, response) => {
      const exchange = this.handle(request, response).catch(() => {
        if (!response.destroyed && !response.headersSent) {
          response.writeHead(500, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
          response.end('{"error":"MCP fixture request failed."}');
        } else response.destroy();
      }).finally(() => this.exchanges.delete(exchange));
      this.exchanges.add(exchange);
    });
    this.server = server;
    server.on("connection", (socket) => {
      const closed = new Promise<void>((resolve) => socket.once("close", () => {
        this.sockets.delete(socket);
        resolve();
      }));
      this.sockets.set(socket, closed);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = () => reject(new Error("MCP fixture listener failed."));
        server.once("error", failed);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", failed);
          resolve();
        });
      });
      const { port } = server.address() as AddressInfo;
      this.endpoint = `http://127.0.0.1:${port}/mcp`;
      this.accepting = true;
      return this.endpoint;
    } catch {
      await handler.close();
      this.server = undefined;
      this.handler = undefined;
      throw new Error("MCP fixture listener failed.");
    }
  }

  /** Fences admission, cancels only this fixture's exchanges, and awaits real native close. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.accepting = false;
    const server = this.server;
    const handler = this.handler;
    this.stopping = (async () => {
      const listenerClosed = server?.listening
        ? new Promise<void>((resolve) => server.close(() => resolve()))
        : Promise.resolve();
      for (const controller of this.controllers) controller.abort();
      const closedSockets = [...this.sockets.values()];
      for (const socket of this.sockets.keys()) socket.destroy();
      await Promise.all([listenerClosed, handler?.close(), ...closedSockets]);
      while (this.exchanges.size) await Promise.all([...this.exchanges]);
      this.server = undefined;
      this.handler = undefined;
      this.endpoint = undefined;
    })();
    return this.stopping;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const endpoint = this.endpoint;
    const handler = this.handler;
    response.shouldKeepAlive = false;
    if (!this.accepting || !endpoint || !handler) {
      response.writeHead(503, { connection: "close" });
      response.end();
      return;
    }
    if (request.url !== "/mcp") {
      response.writeHead(404, { connection: "close" });
      response.end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST", connection: "close" });
      response.end();
      return;
    }
    const expectedOrigin = new URL(endpoint).origin;
    if (request.headers.host !== new URL(endpoint).host
      || (request.headers.origin !== undefined && request.headers.origin !== expectedOrigin)
      || request.headers.authorization !== undefined || request.headers.cookie !== undefined) {
      response.writeHead(403, { connection: "close" });
      response.end();
      return;
    }
    const controller = new AbortController();
    this.controllers.add(controller);
    const abort = () => controller.abort();
    const disconnected = () => { if (!response.writableFinished) controller.abort(); };
    request.once("aborted", abort);
    request.once("error", abort);
    response.once("close", disconnected);
    response.once("error", abort);
    const timeout = setTimeout(() => { controller.abort(); response.destroy(); }, REQUEST_TIMEOUT_MS);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        if (controller.signal.aborted) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        size += bytes.byteLength;
        if (size > MAX_REQUEST_BYTES) {
          response.writeHead(413, { connection: "close" });
          response.end();
          return;
        }
        chunks.push(bytes);
      }
      if (controller.signal.aborted || !this.accepting) return;
      const body = Buffer.concat(chunks, size);
      let method: FakeMcpMethod = "other";
      try {
        const parsed = JSON.parse(body.toString("utf8")) as { method?: unknown } | null;
        if (parsed && typeof parsed.method === "string" && KNOWN_METHODS.has(parsed.method as Exclude<FakeMcpMethod, "other">)) {
          method = parsed.method as FakeMcpMethod;
        }
      } catch { /* Official MCP parsing, not fixture classification, decides the wire error. */ }
      this.methods.push(method);
      this.methodCounts.set(method, (this.methodCounts.get(method) ?? 0) + 1);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const result = await handler.fetch(new Request(endpoint, {
        method: "POST", headers, body: new Uint8Array(body), signal: controller.signal,
      }));
      if (controller.signal.aborted || response.destroyed) {
        await result.body?.cancel().catch(() => {});
        return;
      }
      const declaredSize = result.headers.get("content-length");
      if (declaredSize !== null && (!/^\d+$/.test(declaredSize) || Number(declaredSize) > MAX_RESPONSE_BYTES)) {
        await result.body?.cancel().catch(() => {});
        throw new Error("MCP fixture response exceeded limit.");
      }
      for (const [name, value] of result.headers) response.setHeader(name, value);
      response.setHeader("cache-control", "no-store");
      response.setHeader("connection", "close");
      response.writeHead(result.status);
      if (!result.body) { response.end(); return; }
      reader = result.body.getReader();
      const cancel = () => { void reader?.cancel().catch(() => {}); };
      controller.signal.addEventListener("abort", cancel, { once: true });
      try {
        let written = 0;
        while (!controller.signal.aborted) {
          const next = await reader.read();
          if (next.done) break;
          written += next.value.byteLength;
          if (written > MAX_RESPONSE_BYTES) throw new Error("MCP fixture response exceeded limit.");
          if (!response.write(next.value)) await this.waitForDrain(response, controller.signal);
        }
        if (!controller.signal.aborted && !response.destroyed) response.end();
      } finally {
        controller.signal.removeEventListener("abort", cancel);
      }
    } finally {
      clearTimeout(timeout);
      request.removeListener("aborted", abort);
      request.removeListener("error", abort);
      response.removeListener("close", disconnected);
      response.removeListener("error", abort);
      this.controllers.delete(controller);
      await reader?.cancel().catch(() => {});
    }
  }

  private waitForDrain(response: ServerResponse, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        response.removeListener("drain", done);
        response.removeListener("close", done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      response.once("drain", done);
      response.once("close", done);
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted || response.destroyed) done();
    });
  }
}
