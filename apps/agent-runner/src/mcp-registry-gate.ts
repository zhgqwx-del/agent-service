import { randomBytes } from "node:crypto";
import {
  INTERNAL_ROUTER_TOKEN_HEADER, INTERNAL_MCP_REGISTRY_READY_PATH,
  INTERNAL_MCP_REGISTRY_FLEET_ACK_HEADER, INTERNAL_MCP_REGISTRY_FLEET_ACK_VALUE,
  McpRegistryIdentityCapability, McpRegistryFleetRequest, McpRegistryFleetResponse,
  mcpRegistryIdentitiesEqual,
} from "@agent-service/protocol";

export interface RouterMcpRegistryGateOptions {
  readonly routerBaseUrl: string;
  readonly internalToken: string;
  readonly requestTimeoutMs?: number;
  readonly fetchImpl?: typeof globalThis.fetch;
}
function unavailable(): Error { return new Error("Managed MCP configured fleet is unavailable"); }

/** One private, nonce-bound, uncached observation for one immediately following boundary.
 * This internal control-plane RPC carries no user credential or tenant/session identity. */
export class RouterMcpRegistryGate {
  private readonly origin: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly internalToken: string;
  constructor(options: RouterMcpRegistryGateOptions) {
    let url: URL;
    try { url = new URL(options.routerBaseUrl); } catch { throw unavailable(); }
    if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password
      || url.pathname !== "/" || options.routerBaseUrl.includes("?") || options.routerBaseUrl.includes("#")
      || /[\u0000-\u0020\u007f]/.test(options.routerBaseUrl)
      || !/^[A-Za-z0-9._~-]{32,256}$/.test(options.internalToken)) throw unavailable();
    this.origin = url.origin;
    this.internalToken = options.internalToken;
    this.timeoutMs = options.requestTimeoutMs ?? 2_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 5_000) throw unavailable();
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async requireFreshFleet(expected: McpRegistryIdentityCapability, callerSignal: AbortSignal): Promise<void> {
    let identity: McpRegistryIdentityCapability;
    try { identity = McpRegistryIdentityCapability.parse(expected); } catch { throw unavailable(); }
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(this.timeoutMs)]);
    if (signal.aborted) throw unavailable();
    const nonce = randomBytes(32).toString("hex");
    const request = McpRegistryFleetRequest.parse({ nonce, identity });
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let cancellation: Promise<void> | undefined;
    const cancelReader = () => {
      if (reader && !cancellation) cancellation = reader.cancel().catch(() => {});
    };
    try {
      // Await the actual fetch rather than detaching a promise on cancellation. An injected
      // uncooperative transport must settle before the enclosing operation can release its lease.
      response = await this.fetchImpl(new URL(INTERNAL_MCP_REGISTRY_READY_PATH, this.origin), {
        method: "POST", redirect: "manual", signal,
        headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: this.internalToken, "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      signal.throwIfAborted();
      const noStore = response.headers.get("cache-control")?.split(",")
        .some(value => value.trim().toLowerCase() === "no-store");
      if (response.status !== 200 || !noStore
        || response.headers.get(INTERNAL_MCP_REGISTRY_FLEET_ACK_HEADER) !== INTERNAL_MCP_REGISTRY_FLEET_ACK_VALUE
        || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") ?? "")
        || !response.body) throw unavailable();
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > 2048)) throw unavailable();
      reader = response.body.getReader();
      // A transport may return headers before its body responds to the request signal. Initiate
      // real stream cancellation on abort so a pending read cannot prevent the finally block.
      signal.addEventListener("abort", cancelReader, { once: true });
      if (signal.aborted) cancelReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 2048) throw unavailable();
        chunks.push(chunk.value);
      }
      const parsed = McpRegistryFleetResponse.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true })
        .decode(Buffer.concat(chunks))));
      if (parsed.nonce !== nonce || !mcpRegistryIdentitiesEqual(identity, parsed.identity)) throw unavailable();
      signal.throwIfAborted();
    } catch {
      throw unavailable();
    } finally {
      signal.removeEventListener("abort", cancelReader);
      // No floating body cancellation, including a response arriving after caller cancellation.
      if (reader) {
        cancelReader();
        try { await cancellation; } catch { /* Fixed error policy; no remote diagnostics. */ }
        finally { reader.releaseLock(); }
      } else if (response) {
        try { await response.body?.cancel(); } catch { /* The body never grants authority. */ }
      }
    }
  }
}
