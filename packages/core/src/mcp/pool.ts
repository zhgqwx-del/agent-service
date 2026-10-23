import { Client, StreamableHTTPClientTransport, type Transport } from "@modelcontextprotocol/client";
import { CloseFailures, type McpToolProgress, type Principal } from "@agent-service/protocol";
import type { TenantRuntimeCoordinator, TenantRuntimeLease } from "../lifecycle/tenant-runtime-coordinator.js";
import { createMcpResourceFetch, type McpProtocolVersion } from "./network.js";
import type { McpHttpFetch } from "./http.js";
import { array, cacheMetadata, json, keys, plain, snapshot, text, toolProgress, toolResult, type Server, type Snapshot } from "./wire.js";

export type McpRemoteProgress = McpToolProgress;
export interface McpPoolBinding {
  readonly key: string;
  readonly principal: Readonly<Principal>;
  readonly server: Server;
  readonly protocolVersion: McpProtocolVersion;
  /** Current DB authorization, not a cache/Redis decision. Also used immediately before actual send. */
  authorize(signal: AbortSignal): Promise<void>;
  accessToken(signal: AbortSignal): Promise<string | undefined>;
  /** Shutdown-only capabilities still perform exact current SQL/subject/fleet authorization. */
  authorizeTermination?(signal: AbortSignal): Promise<void>;
  terminationAccessToken?(signal: AbortSignal): Promise<string | undefined>;
}
export interface McpPoolOperation {
  readonly signal: AbortSignal;
  readonly onDispatched?: () => void;
  readonly onProgress?: (progress: McpRemoteProgress) => void;
}
export interface McpPoolSession {
  catalog(force?: boolean): Promise<readonly Snapshot[]>;
  call(tool: Snapshot, args: Record<string, unknown>): Promise<ReturnType<typeof toolResult>>;
}
interface Entry {
  readonly binding: McpPoolBinding; readonly abort: AbortController; readonly fetch: McpHttpFetch;
  readonly client: Client; readonly lease?: TenantRuntimeLease; readonly expires: number;
  readonly close: (normal?: boolean) => Promise<void>; readonly ready: Promise<void>;
  readonly pending: Set<Promise<unknown>>;
  busy: boolean; closing: boolean; current?: McpPoolOperation;
  calls: number; requests: number; progressCount: number; lastProgress: number; progressValue: number;
  progressToken?: string | number;
  progressEnded: boolean;
  sessionId?: string; getStarted: boolean; terminating: boolean; terminationSignal?: AbortSignal;
  notifications: Promise<void>;
  catalog?: readonly Snapshot[]; catalogExpires: number;
}
function bad(): never { throw new Error("MCP request failed."); }

/** Connections are local; every checkout/send/result still depends on a fresh DB gate. */
export class McpConnectionPool {
  private readonly entries = new Set<Entry>();
  private readonly fenced = new Set<string>();
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly options: {
    readonly timeoutMs: number; readonly ttlMs: number; readonly maxEntries: number;
    readonly allowLoopbackForTests?: boolean; readonly tenantRuntime?: TenantRuntimeCoordinator;
  }) {
    for (const [n, max] of [[options.timeoutMs, 30_000], [options.ttlMs, 300_000], [options.maxEntries, 128]]) if (!Number.isSafeInteger(n) || n! < 1 || n! > max!) bad();
    options.tenantRuntime?.registerParticipant({
      name: "mcp-registered-pool-v1",
      snapshotTenant: tenantId => ({ providerRegistrations: [...this.entries].filter(e => e.binding.principal.tenantId === tenantId).length }),
      fenceTenant: identity => { this.fenced.add(identity.tenantId); for (const entry of this.entries) if (entry.binding.principal.tenantId === identity.tenantId) void entry.close(); },
      purgeTenant: async identity => { await Promise.all([...this.entries].filter(e => e.binding.principal.tenantId === identity.tenantId).map(e => e.close())); },
    });
  }
  async use<T>(binding: McpPoolBinding, operation: McpPoolOperation, work: (session: McpPoolSession) => Promise<T>): Promise<T> {
    if (this.closed || this.fenced.has(binding.principal.tenantId) || operation.signal.aborted) bad();
    await binding.authorize(operation.signal);
    if (this.closed || this.fenced.has(binding.principal.tenantId) || operation.signal.aborted) bad();
    for (const e of [...this.entries]) if (e.expires <= performance.now()) await e.close(true);
    // Expired entries can be waiting for real I/O cleanup. Admission may have
    // been revoked while that wait yielded; do not create another entry then.
    if (this.closed || this.fenced.has(binding.principal.tenantId) || operation.signal.aborted) bad();
    let entry = [...this.entries].find(e => !e.busy && !e.closing && e.binding.key === binding.key
      && e.binding.principal.tenantId === binding.principal.tenantId && e.binding.principal.userId === binding.principal.userId
      && e.binding.protocolVersion === binding.protocolVersion && e.binding.server.id === binding.server.id && e.binding.server.endpoint === binding.server.endpoint);
    if (!entry) {
      if (this.entries.size >= this.options.maxEntries) bad();
      entry = this.create(binding);
    }
    entry.busy = true; entry.current = operation; entry.calls = 0; entry.requests = 0; entry.progressCount = 0; entry.lastProgress = -Infinity; entry.progressValue = -Infinity; entry.progressToken = undefined; entry.progressEnded = false;
    const owned = entry;
    const abort = () => { void owned.close(); };
    operation.signal.addEventListener("abort", abort, { once: true });
    try {
      if (operation.signal.aborted) bad(); await owned.ready;
      const check = async () => { if (owned.closing || operation.signal.aborted || this.closed) bad(); owned.lease?.assertOpen(); await binding.authorize(operation.signal); if (owned.closing || operation.signal.aborted) bad(); };
      const requestOptions = () => ({ signal: AbortSignal.any([operation.signal, owned.abort.signal]), timeout: this.options.timeoutMs });
      const catalog = async (force = false): Promise<readonly Snapshot[]> => {
        await check();
        if (!force && owned.catalog && owned.catalogExpires > performance.now()) return owned.catalog;
        const result: Snapshot[] = [], cursors = new Set<string>(), names = new Set<string>(); let cursor: string | undefined;
        for (let page = 0; page < 4; page++) {
          const raw = plain(await owned.client.request({ method: "tools/list", params: cursor === undefined ? {} : { cursor } }, requestOptions()));
          keys(raw, ["tools", "nextCursor", "_meta", "ttlMs", "cacheScope", "resultType"], ["tools"]);
          cacheMetadata(raw, binding.protocolVersion === "2026-07-28");
          if (!Array.isArray(raw.tools) || raw.tools.length > 64) bad();
          for (const value of raw.tools) { const tool = snapshot(binding.server, value); if (names.has(tool.name)) bad(); names.add(tool.name); result.push(tool); }
          if (result.length > 64) bad();
          if (raw.nextCursor === undefined) {
            await check(); owned.catalog = Object.freeze(result);
            owned.catalogExpires = performance.now() + Math.min(this.options.ttlMs, typeof raw.ttlMs === "number" ? raw.ttlMs : 1000);
            return owned.catalog;
          }
          cursor = text(raw.nextCursor, 512, false); if (cursors.has(cursor)) bad(); cursors.add(cursor);
        }
        return bad();
      };
      const result = await work({ catalog, call: async (tool, args) => {
        // A new validated catalog binds the approval identity at actual dispatch.
        const current = (await catalog(true)).find(value => value.name === tool.name);
        if (!current || current.identity !== tool.identity) bad(); await check();
        const value = await owned.client.callTool({ name: tool.name, arguments: args }, { ...requestOptions(), toolDefinition: current.wire,
          ...(operation.onProgress ? { onprogress: () => {} } : {}) });
        await check(); return toolResult(value);
      } });
      await owned.notifications; await check(); return result;
    } catch { await owned.close(); return bad(); }
    finally {
      operation.signal.removeEventListener("abort", abort); owned.current = undefined; owned.busy = false;
      if (owned.closing || this.closed || operation.signal.aborted) await owned.close();
    }
  }
  private create(binding: McpPoolBinding): Entry {
    const abort = new AbortController(), getAbort = new AbortController(), lease = this.options.tenantRuntime?.enter(binding.principal.tenantId, "provider");
    let entry!: Entry;
    let fetch: McpHttpFetch | undefined;
    try {
    const nativeFetch = createMcpResourceFetch({ endpoint: binding.server.endpoint, maxRequestBytes: 32_768, maxResponseBytes: 131_072,
      timeoutMs: this.options.timeoutMs, allowLoopbackForTests: this.options.allowLoopbackForTests }, {
      protocolVersion: binding.protocolVersion,
      ...(binding.protocolVersion === "2025-11-25" ? { getStream: { idleTimeoutMs: this.options.timeoutMs, maxDurationMs: this.options.ttlMs } } : {}),
      accessToken: async () => {
        const signal = entry.terminationSignal ?? AbortSignal.any([abort.signal, ...(lease ? [lease.signal] : [])]);
        lease?.assertOpen();
        await (entry.terminating ? binding.authorizeTermination ?? binding.authorize : binding.authorize)(signal);
        return (entry.terminating ? binding.terminationAccessToken ?? binding.accessToken : binding.accessToken)(signal);
      },
    });
    fetch = nativeFetch;
    const tracked = <T>(work: () => Promise<T>): Promise<T> => {
      const actual = Promise.resolve().then(work); entry.pending.add(actual);
      void actual.then(() => entry.pending.delete(actual), () => entry.pending.delete(actual)); return actual;
    };
    const safeFetch: typeof globalThis.fetch = (input, init) => tracked(async () => {
      const request = new Request(input, init);
      const termination = request.method === "DELETE" && entry.terminating;
      if (abort.signal.aborted || entry.closing && !termination) bad();
      const signal = entry.terminationSignal ?? AbortSignal.any([abort.signal, ...(lease ? [lease.signal] : []), request.signal,
        ...(request.method === "GET" ? [getAbort.signal] : entry.current ? [entry.current.signal] : [])]);
      lease?.assertOpen(); await (termination ? binding.authorizeTermination ?? binding.authorize : binding.authorize)(signal);
      if (signal.aborted || abort.signal.aborted || entry.closing && !termination) bad();
      let handshake = false;
      if (request.method === "POST") {
        const raw = await request.clone().text(); if (Buffer.byteLength(raw) > 32_768) bad(); const rpc = plain(JSON.parse(raw));
        if (!["initialize", "server/discover", "notifications/initialized", "tools/list", "tools/call", "notifications/cancelled"].includes(String(rpc.method)) || ++entry.requests > 16) bad();
        handshake = rpc.method === "initialize";
        if (rpc.method === "tools/call") { if (!entry.current || entry.calls++) bad(); entry.current.onDispatched?.(); }
      }
      if (request.method === "DELETE" && !termination) bad();
      if (request.method === "GET") { if (entry.getStarted) bad(); entry.getStarted = true; }
      const sid = request.headers.get("mcp-session-id");
      if (handshake ? sid !== null : sid !== (entry.sessionId ?? null)) bad();
      const response = await nativeFetch(request, { signal });
      try {
        const received = response.headers.get("mcp-session-id");
        if (received !== null && (!/^[\x21-\x7e]{1,256}$/.test(received) || binding.protocolVersion !== "2025-11-25")) bad();
        if (handshake && response.ok) entry.sessionId = received ?? undefined;
        else if (received !== null && received !== entry.sessionId) bad();
        return response;
      } catch { await response.body?.cancel().catch(() => {}); return bad(); }
    });
    const client = new Client({ name: "agent-service", version: "mcp-registry-v1" }, {
      capabilities: {}, supportedProtocolVersions: [binding.protocolVersion], enforceStrictCapabilities: true,
      // SDK {pin} is modern-only. Its legacy handshake is constrained by the
      // single supported version above, then checked again after connect.
      versionNegotiation: binding.protocolVersion === "2025-11-25" ? { mode: "legacy" }
        : { mode: { pin: binding.protocolVersion }, probe: { timeoutMs: this.options.timeoutMs, maxRetries: 0 } },
      inputRequired: { autoFulfill: false }, defaultCacheTtlMs: 0, listMaxPages: 4,
    });
    client.onerror = () => {};
    const transport = new StreamableHTTPClientTransport(new URL(binding.server.endpoint), {
      fetch: safeFetch, protocolVersion: binding.protocolVersion, requestInit: { redirect: "error" }, onInsufficientScope: "throw", maxStepUpRetries: 0,
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    });
    const expected = new Map<string, string>();
    const guarded: Transport = { hasPerRequestStream: true, start: () => transport.start(), close: () => transport.close(), setProtocolVersion: v => transport.setProtocolVersion(v),
      send: async (message, opts) => { const rpc = plain(message); if (rpc.id !== undefined) {
        if ((typeof rpc.id !== "string" && typeof rpc.id !== "number") || !["initialize", "server/discover", "tools/list", "tools/call"].includes(String(rpc.method))) bad();
        const id = JSON.stringify(rpc.id); if (expected.has(id)) bad(); expected.set(id, String(rpc.method));
        if (rpc.method === "tools/call" && entry.current?.onProgress) {
          const params = plain(rpc.params), meta = plain(params._meta), token = meta.progressToken;
          if (typeof token !== "string" && typeof token !== "number") bad(); entry.progressToken = token;
        }
      } return transport.send(message, opts); },
    };
    transport.onclose = () => { guarded.onclose?.(); if (entry && !entry.closing) void entry.close(); };
    transport.onerror = () => { guarded.onerror?.(new Error("MCP request failed.")); if (entry && !entry.closing) void entry.close(); };
    const notification = (work: () => Promise<void>) => {
      const previous = entry.notifications;
      const actual = tracked(async () => { await previous; if (entry.closing || abort.signal.aborted) return; await work(); });
      entry.notifications = actual.catch(() => { abort.abort(); if (!entry.closing) void entry.close(); });
    };
    transport.onmessage = message => {
      try {
        const rpc = plain(message);
        if (rpc.id === undefined) {
          keys(rpc, ["jsonrpc", "method", "params"], ["jsonrpc", "method"]); if (rpc.jsonrpc !== "2.0") bad();
          if (rpc.method === "notifications/tools/list_changed") {
            entry.catalogExpires = 0;
            notification(async () => { await binding.authorize(abort.signal); if (!entry.closing && !abort.signal.aborted) guarded.onmessage?.(message); }); return;
          }
          if (rpc.method !== "notifications/progress" || !entry.current || !entry.calls || entry.progressEnded || ++entry.progressCount > 64 || performance.now() - entry.lastProgress < 25) bad();
          const p = plain(rpc.params); keys(p, ["progressToken", "progress", "total", "message"], ["progressToken", "progress"]);
          if (entry.progressToken === undefined || p.progressToken !== entry.progressToken) bad();
          const { progressToken: _token, ...payload } = p, progress = toolProgress(payload), operation = entry.current;
          if (progress.progress <= entry.progressValue) bad();
          entry.lastProgress = performance.now(); entry.progressValue = progress.progress;
          notification(async () => {
            await binding.authorize(AbortSignal.any([abort.signal, operation.signal]));
            if (entry.current !== operation || entry.progressToken !== p.progressToken || entry.closing || operation.signal.aborted || abort.signal.aborted) return;
            // A product observer is not remote protocol authority. Its exception
            // must not convert a successful possible-effect tool into a retry.
            try { operation.onProgress?.(progress); } catch { /* live-only observer */ }
            guarded.onmessage?.(message);
          }); return;
        }
        keys(rpc, ["jsonrpc", "id", "result", "error"], ["jsonrpc", "id"]);
        if (rpc.jsonrpc !== "2.0" || Object.hasOwn(rpc, "result") === Object.hasOwn(rpc, "error")) bad();
        const id = JSON.stringify(rpc.id), method = expected.get(id); if (!method) bad(); expected.delete(id);
         if (method === "tools/call") entry.progressEnded = true;
        if (Object.hasOwn(rpc, "error")) { const e = plain(rpc.error); keys(e, ["code", "message", "data"], ["code", "message"]); if (!Number.isSafeInteger(e.code)) bad(); text(e.message, 4096); json(e, 16_384); }
         else if (method === "tools/call") toolResult(rpc.result);
        else if (method === "tools/list") { const p = plain(rpc.result); keys(p, ["tools", "nextCursor", "_meta", "ttlMs", "cacheScope", "resultType"], ["tools"]); cacheMetadata(p, binding.protocolVersion === "2026-07-28"); if (array(p.tools).length > 64) bad(); for (const tool of array(p.tools)) snapshot(binding.server, tool); json(p, 131_072); }
        else {
          const p = plain(rpc.result); keys(p, method === "initialize" ? ["protocolVersion", "capabilities", "serverInfo", "instructions", "_meta"] : ["supportedVersions", "capabilities", "instructions", "_meta", "ttlMs", "cacheScope", "resultType"], ["capabilities"]);
          const cap = plain(p.capabilities); keys(cap, ["tools"], ["tools"]); const tools = plain(cap.tools); keys(tools, ["listChanged"]); if (tools.listChanged !== undefined && typeof tools.listChanged !== "boolean") bad();
          if (method === "initialize" && p.protocolVersion !== binding.protocolVersion || method === "server/discover" && !array(p.supportedVersions).includes(binding.protocolVersion)) bad(); json(p, 16_384);
        }
         if (method === "tools/call") {
           // Progress received before the terminal frame must be authorized and
           // observed before resolving the call; later frames cannot reuse its token.
           notification(async () => { entry.progressToken = undefined; guarded.onmessage?.(message); });
         } else guarded.onmessage?.(message);
      } catch { abort.abort(); guarded.onerror?.(new Error("MCP request failed.")); void transport.close().catch(() => {}); }
    };
    let closePromise: Promise<void> | undefined;
    const timer = setTimeout(() => { void entry.close(true); }, this.options.ttlMs);
    const close = (normal = false) => {
      if (closePromise) return closePromise; entry.closing = true; getAbort.abort(); clearTimeout(timer);
      // A revoked/fenced/busy connection must never use old authority to DELETE a
      // remote session. Only an idle, normally expiring entry may make one fresh,
      // bounded authorization attempt. There is no DELETE or tool-call retry.
      const terminate = normal && !entry.busy && binding.protocolVersion === "2025-11-25" && entry.sessionId !== undefined;
      if (!terminate) abort.abort();
      return closePromise = (async () => { const failures = new CloseFailures(); try {
          if (terminate) {
            const cleanup = new AbortController(), deadline = setTimeout(() => cleanup.abort(), this.options.timeoutMs);
            entry.terminating = true; entry.terminationSignal = AbortSignal.any([cleanup.signal, abort.signal, ...(lease ? [lease.signal] : [])]);
            try { await (binding.authorizeTermination ?? binding.authorize)(entry.terminationSignal); if (!entry.terminationSignal.aborted) await transport.terminateSession(); }
            catch { /* Authorization/termination failure never grants retry or stops local drain. */ }
            finally { clearTimeout(deadline); entry.terminating = false; entry.terminationSignal = undefined; }
          }
          abort.abort();
          // Native cancellation must start before awaiting SDK transport close; either owner may
          // otherwise wait for the other's cancellation. Keep the original raw promises joined.
          await failures.start([() => nativeFetch.close(), () => client.close().catch(() => {})]);
          while (entry.pending.size) await Promise.allSettled([...entry.pending]);
          failures.throwIfAny(); }
        finally { abort.abort(); lease?.release(); this.entries.delete(entry); } })();
    };
    entry = { binding, abort, client, fetch: nativeFetch, pending: new Set(), ...(lease ? { lease } : {}), expires: performance.now() + this.options.ttlMs,
      close, ready: Promise.resolve(), busy: false, closing: false, calls: 0, requests: 0, progressCount: 0, lastProgress: -Infinity, progressValue: -Infinity,
      progressEnded: false, getStarted: false, terminating: false, notifications: Promise.resolve(), catalogExpires: 0 };
    this.entries.add(entry);
    // Start only after entry has been published to the lifetime tracker.
    const ready = Promise.resolve().then(async () => {
      await tracked(() => binding.authorize(abort.signal)); if (abort.signal.aborted) bad(); await client.connect(guarded, { signal: abort.signal, timeout: this.options.timeoutMs });
      if (client.getNegotiatedProtocolVersion() !== binding.protocolVersion) bad(); await tracked(() => binding.authorize(abort.signal));
    });
    // Keep the original rejecting promise for use()'s error propagation, while
    // also owning rejection if a cancellation path closes before awaiting it.
    void ready.catch(() => {});
    Object.defineProperty(entry, "ready", { value: ready });
    return entry;
    } catch { void fetch?.close(); lease?.release(); return bad(); }
  }
  async invalidate(predicate: (binding: McpPoolBinding) => boolean): Promise<void> {
    await Promise.all([...this.entries].filter(e => predicate(e.binding)).map(e => e.close()));
  }
  close(): Promise<void> {
    this.closed = true;
    if (this.closing) return this.closing;
    return this.closing = (async () => {
      const failures = new CloseFailures();
      // Join every original entry close even if another one rejects. Do not wait ready here:
      // ready can be waiting for SDK connect cancellation driven by entry.close itself.
      await failures.start([...this.entries].map(entry => () => entry.close(true)));
      failures.throwIfAny();
    })();
  }
}
