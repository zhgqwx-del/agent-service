import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import {
  createMcpHandler, fromJsonSchema, isInitializeRequest, McpServer,
  WebStandardStreamableHTTPServerTransport,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";

const MAX_REQUEST_BYTES = 32 * 1_024;
const MAX_RESPONSE_BYTES = 128 * 1_024;
const REQUEST_TIMEOUT_MS = 15_000;
type Method = "GET" | "POST" | "DELETE";
export interface FakeMcpProgress {
  readonly progress: number;
  readonly total?: number;
  readonly message?: string;
}
export interface FakeMcpPeerRequest {
  readonly method: Method;
  readonly rpcMethod: string | null;
  readonly sessionId: string | null;
}
interface SessionEntry { readonly server: McpServer; readonly transport: WebStandardStreamableHTTPServerTransport }
interface Exchange { readonly response: ServerResponse; readonly abort: AbortController }

/**
 * Independent official SDK peers for real transport tests. The modern peer is NOT stateful.
 * Session IDs, arguments and progress tokens remain test-only in-memory observations, never logs.
 */
class OfficialMcpPeer {
  toolDescription = "Echo the provided test text, reporting bounded progress first.";
  responsePrefix = "echo:";
  responseText: string | undefined;
  progress: readonly FakeMcpProgress[] = [{ progress: 1, total: 2, message: "Remote fixture work is in progress." }];
  /** The test owns this barrier and must release it in finally. Cancellation is observable here. */
  beforeReply: ((context: { readonly signal: AbortSignal }) => Promise<void>) | undefined;
  /** Drop the actual response after the next tool's effect, without returning its result. */
  dropNextCallResponse = false;
  deleteStatus: 200 | 405 = 200;
  readonly calls: { readonly name: "echo"; readonly arguments: Readonly<{ text: string }> }[] = [];
  readonly requests: FakeMcpPeerRequest[] = [];
  readonly progressSent: FakeMcpProgress[] = [];
  private server: Server | undefined;
  private modern: McpHttpHandler | undefined;
  private endpoint: string | undefined;
  private accepting = false;
  private stopping: Promise<void> | undefined;
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly entries = new Set<SessionEntry>();
  private readonly sockets = new Map<Socket, Promise<void>>();
  private readonly pending = new Set<Promise<void>>();
  private readonly controllers = new Set<AbortController>();
  private readonly callsInFlight = new Map<string, Exchange>();
  private lastNotify: ((value: FakeMcpProgress) => Promise<void>) | undefined;
  private rejection: { readonly method: Method; readonly status: 404 | 405; readonly rpcMethod?: string } | undefined;
  private initialized = 0;
  private terminated = 0;

  protected constructor(readonly protocolVersion: "2026-07-28" | "2025-11-25") {}

  stats() {
    return Object.freeze({ sessionsCreated: this.initialized, sessionsTerminated: this.terminated,
      activeSessions: this.sessions.size, openSockets: this.sockets.size, activeExchanges: this.pending.size,
      calls: this.calls.length, progress: this.progressSent.length });
  }
  rejectNextRequest(input: { readonly method: Method; readonly status: 404 | 405; readonly rpcMethod?: string }): void {
    if (this.rejection) throw new Error("MCP fixture already has a pending rejection.");
    this.rejection = Object.freeze({ ...input });
  }
  /** Expire only this peer's sessions. A later request must see a real HTTP 404, not a new session. */
  async expireSessions(): Promise<void> {
    const entries = [...this.entries]; this.sessions.clear();
    await Promise.all(entries.map(async entry => { await entry.server.close(); this.entries.delete(entry); }));
  }
  /** A late server notification is just untrusted wire input; it never authenticates a call. */
  async notifyLastCall(value: FakeMcpProgress): Promise<void> {
    if (!this.lastNotify) throw new Error("MCP fixture has no observed tool call.");
    await this.lastNotify(value);
  }
  async start(): Promise<string> {
    if (process.env.NODE_ENV !== "test" || this.server || this.stopping) throw new Error("MCP fixture start rejected.");
    if (this.protocolVersion === "2026-07-28") {
      this.modern = createMcpHandler(() => this.createServer(), {
        legacy: "reject", responseMode: "auto", keepAliveMs: 0,
        maxRequestBodySize: MAX_REQUEST_BYTES, onerror: () => {},
      });
    }
    const server = createServer({ maxHeaderSize: 16_384, requestTimeout: REQUEST_TIMEOUT_MS, headersTimeout: REQUEST_TIMEOUT_MS }, (request, response) => {
      const work = this.handle(request, response).catch(() => {
        if (!response.destroyed && !response.headersSent) {
          response.writeHead(500, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
          response.end('{"error":"MCP fixture request failed."}');
        } else response.destroy();
      }).finally(() => this.pending.delete(work));
      this.pending.add(work);
    });
    this.server = server;
    server.on("connection", socket => {
      const closed = new Promise<void>(resolve => socket.once("close", () => { this.sockets.delete(socket); resolve(); }));
      this.sockets.set(socket, closed);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = () => reject(new Error("MCP fixture listener failed."));
        server.once("error", failed);
        server.listen(0, "127.0.0.1", () => { server.off("error", failed); resolve(); });
      });
      this.endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
      this.accepting = true; return this.endpoint;
    } catch {
      await this.modern?.close(); this.modern = undefined; this.server = undefined;
      throw new Error("MCP fixture listener failed.");
    }
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.accepting = false;
    const server = this.server;
    this.stopping = (async () => {
      const listener = server?.listening ? new Promise<void>(resolve => server.close(() => resolve())) : Promise.resolve();
      for (const controller of this.controllers) controller.abort();
      const sockets = [...this.sockets.values()];
      for (const socket of this.sockets.keys()) socket.destroy();
      await Promise.all([listener, this.modern?.close(), this.expireSessions(), ...sockets]);
      while (this.pending.size) await Promise.all([...this.pending]);
      this.server = undefined; this.modern = undefined; this.endpoint = undefined;
    })();
    return this.stopping;
  }
  private callKey(sessionId: string | undefined, id: string | number) { return JSON.stringify([sessionId ?? null, id]); }
  private createServer(): McpServer {
    const server = new McpServer({ name: "agent-service-official-progress-peer", version: "1.0.0" }, {
      supportedProtocolVersions: [this.protocolVersion], maxToolInputElements: 16,
    });
    server.server.onerror = () => {};
    server.registerTool("echo", {
      description: this.toolDescription,
      inputSchema: fromJsonSchema<{ text: string }>({ type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ text }, context) => {
      this.calls.push(Object.freeze({ name: "echo", arguments: Object.freeze({ text }) }));
      const token = context.mcpReq._meta?.progressToken;
      const notify = async (value: FakeMcpProgress) => {
        if (typeof token !== "string" && typeof token !== "number") throw new Error("MCP fixture expected a request progress token.");
        await context.mcpReq.notify({ method: "notifications/progress", params: { progressToken: token, ...value } });
        this.progressSent.push(Object.freeze({ ...value }));
      };
      this.lastNotify = notify;
      if (typeof token === "string" || typeof token === "number") for (const value of this.progress) await notify(value);
      await this.beforeReply?.({ signal: context.mcpReq.signal });
      if (this.dropNextCallResponse) {
        this.dropNextCallResponse = false;
        const exchange = this.callsInFlight.get(this.callKey(context.sessionId, context.mcpReq.id));
        if (!exchange) throw new Error("MCP fixture call response ownership unavailable.");
        exchange.abort.abort(); exchange.response.destroy();
      }
      return { content: [{ type: "text", text: this.responseText ?? `${this.responsePrefix}${text}` }] };
    });
    return server;
  }
  private async openSession(): Promise<SessionEntry> {
    const server = this.createServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID, keepAliveMs: 0, maxRequestBodySize: MAX_REQUEST_BYTES,
      onsessioninitialized: id => { this.initialized++; this.sessions.set(id, entry); },
      onsessionclosed: id => { this.terminated++; this.sessions.delete(id); },
    });
    const entry = { server, transport }; this.entries.add(entry);
    try { await server.connect(transport); return entry; }
    catch { this.entries.delete(entry); await server.close(); throw new Error("MCP fixture session failed."); }
  }
  private reject(response: ServerResponse, status: number): void {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
    response.end('{"jsonrpc":"2.0","error":{"code":-32001,"message":"MCP fixture rejected request."},"id":null}');
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const endpoint = this.endpoint;
    response.shouldKeepAlive = false;
    if (!this.accepting || !endpoint) return this.reject(response, 503);
    if (request.url !== "/mcp") return this.reject(response, 404);
    if (!["GET", "POST", "DELETE"].includes(request.method ?? "")) return this.reject(response, 405);
    if (request.headers.host !== new URL(endpoint).host
      || request.headers.origin !== undefined && request.headers.origin !== new URL(endpoint).origin
      || request.headers.authorization !== undefined || request.headers.cookie !== undefined) return this.reject(response, 403);
    const method = request.method as Method, controller = new AbortController();
    this.controllers.add(controller);
    const aborted = () => controller.abort();
    const disconnected = () => { if (!response.writableFinished) controller.abort(); };
    request.once("aborted", aborted); request.once("error", aborted);
    response.once("close", disconnected); response.once("error", aborted);
    const timer = setTimeout(() => { controller.abort(); response.destroy(); }, REQUEST_TIMEOUT_MS);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, callKey: string | undefined;
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array); size += bytes.length;
        if (size > MAX_REQUEST_BYTES) return this.reject(response, 413);
        chunks.push(bytes);
      }
      if (controller.signal.aborted || !this.accepting) return;
      const body = Buffer.concat(chunks, size);
      let rpc: unknown;
      if (method === "POST") { try { rpc = JSON.parse(body.toString("utf8")); } catch { return this.reject(response, 400); } }
      const object = rpc && typeof rpc === "object" && !Array.isArray(rpc) ? rpc as Record<string, unknown> : undefined;
      const rpcMethod = typeof object?.method === "string" ? object.method : null;
      const rawSession = request.headers["mcp-session-id"];
      if (Array.isArray(rawSession)) return this.reject(response, 400);
      const sessionId = rawSession ?? null;
      this.requests.push(Object.freeze({ method, rpcMethod, sessionId }));
      if (this.rejection && this.rejection.method === method && (this.rejection.rpcMethod === undefined || this.rejection.rpcMethod === rpcMethod)) {
        const status = this.rejection.status; this.rejection = undefined; return this.reject(response, status);
      }
      if (this.protocolVersion === "2026-07-28" && method !== "POST") return this.reject(response, 405);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      const incoming = new Request(endpoint, { method, headers, ...(method === "POST" ? { body: new Uint8Array(body) } : {}), signal: controller.signal });
      if (rpcMethod === "tools/call" && (typeof object?.id === "string" || typeof object?.id === "number")) {
        callKey = this.callKey(sessionId ?? undefined, object.id);
        if (this.callsInFlight.has(callKey)) return this.reject(response, 409);
        this.callsInFlight.set(callKey, { response, abort: controller });
      }
      let result: Response;
      if (this.protocolVersion === "2026-07-28") result = await this.modern!.fetch(incoming);
      else {
        let entry = sessionId ? this.sessions.get(sessionId) : undefined;
        if (!entry) {
          if (sessionId) return this.reject(response, 404);
          if (method !== "POST" || !isInitializeRequest(rpc)) return this.reject(response, 400);
          entry = await this.openSession();
        }
        if (method === "DELETE" && this.deleteStatus === 405) return this.reject(response, 405);
        result = await entry.transport.handleRequest(incoming, method === "POST" ? { parsedBody: rpc } : undefined);
        if (method === "DELETE") { await entry.server.close(); this.entries.delete(entry); }
      }
      if (controller.signal.aborted || response.destroyed) { await result.body?.cancel().catch(() => {}); return; }
      const declaredSize = result.headers.get("content-length");
      if (declaredSize !== null && (!/^\d+$/.test(declaredSize) || Number(declaredSize) > MAX_RESPONSE_BYTES)) {
        await result.body?.cancel().catch(() => {}); throw new Error("MCP fixture response exceeded limit.");
      }
      for (const [name, value] of result.headers) response.setHeader(name, value);
      response.setHeader("cache-control", "no-store"); response.setHeader("connection", "close"); response.writeHead(result.status); response.flushHeaders();
      if (!result.body) { response.end(); return; }
      reader = result.body.getReader();
      const cancel = () => { void reader?.cancel().catch(() => {}); };
      controller.signal.addEventListener("abort", cancel, { once: true });
      try {
        let written = 0;
        while (!controller.signal.aborted) {
          const next = await reader.read(); if (next.done) break;
          written += next.value.byteLength;
          if (written > MAX_RESPONSE_BYTES) throw new Error("MCP fixture response exceeded limit.");
          if (!response.write(next.value)) await this.waitForDrain(response, controller.signal);
        }
        if (!controller.signal.aborted && !response.destroyed) response.end();
      } finally { controller.signal.removeEventListener("abort", cancel); }
    } finally {
      clearTimeout(timer); request.off("aborted", aborted); request.off("error", aborted);
      response.off("close", disconnected); response.off("error", aborted);
      this.controllers.delete(controller); if (callKey) this.callsInFlight.delete(callKey);
      await reader?.cancel().catch(() => {});
    }
  }
  private waitForDrain(response: ServerResponse, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      const done = () => { response.off("drain", done); response.off("close", done); signal.removeEventListener("abort", done); resolve(); };
      response.once("drain", done); response.once("close", done); signal.addEventListener("abort", done, { once: true });
      if (signal.aborted || response.destroyed) done();
    });
  }
}

/** Official initialize/session/GET/DELETE peer, strictly pinned to the legacy 2025 revision. */
export class FakeStatefulMcp extends OfficialMcpPeer { constructor() { super("2025-11-25"); } }
/** Official modern POST/SSE progress peer; deliberately has no protocol session or legacy fallback. */
export class FakeProgressMcp extends OfficialMcpPeer { constructor() { super("2026-07-28"); } }
