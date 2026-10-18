import { randomBytes } from "node:crypto";
import {
  INTERNAL_ROUTER_TOKEN_HEADER, INTERNAL_RUNTIME_EXTENSIONS_READY_PATH,
  INTERNAL_RUNTIME_EXTENSIONS_ACK_HEADER, INTERNAL_RUNTIME_EXTENSIONS_ACK_VALUE,
  RuntimeExtensionsIdentity, RuntimeExtensionsFleetRequest, RuntimeExtensionsFleetResponse,
  runtimeExtensionsIdentitiesEqual,
} from "@agent-service/protocol";

export interface RouterRuntimeExtensionsGateOptions {
  readonly routerBaseUrl: string;
  readonly internalToken: string;
  readonly requestTimeoutMs?: number;
  readonly fetchImpl?: typeof globalThis.fetch;
}
const unavailable = () => new Error("Runtime extensions configured fleet is unavailable");

/** Fresh nonce-bound control-plane proof; actual transport settlement retains the caller's lease. */
export class RouterRuntimeExtensionsGate {
  private readonly origin: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly token: string;
  constructor(options: RouterRuntimeExtensionsGateOptions) {
    let url: URL;
    try { url = new URL(options.routerBaseUrl); } catch { throw unavailable(); }
    if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password || url.pathname !== "/"
      || options.routerBaseUrl.includes("?") || options.routerBaseUrl.includes("#")
      || /[\u0000-\u0020\u007f]/.test(options.routerBaseUrl)
      || !/^[A-Za-z0-9._~-]{32,256}$/.test(options.internalToken)) throw unavailable();
    this.origin = url.origin; this.token = options.internalToken;
    this.timeoutMs = options.requestTimeoutMs ?? 2000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 5000) throw unavailable();
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }
  async requireFreshFleet(expected: RuntimeExtensionsIdentity, callerSignal: AbortSignal): Promise<void> {
    let identity: RuntimeExtensionsIdentity;
    try { identity = RuntimeExtensionsIdentity.parse(expected); } catch { throw unavailable(); }
    if (identity.lifecycleHooksSha256 === null && identity.subagentsSha256 === null) throw unavailable();
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(this.timeoutMs)]);
    const nonce = randomBytes(32).toString("hex");
    const request = RuntimeExtensionsFleetRequest.parse({ nonce, identity });
    let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let cancellation: Promise<void> | undefined;
    const cancel = () => { if (reader && !cancellation) cancellation = reader.cancel().catch(() => {}); };
    try {
      signal.throwIfAborted();
      response = await this.fetchImpl(new URL(INTERNAL_RUNTIME_EXTENSIONS_READY_PATH, this.origin), {
        method: "POST", redirect: "manual", signal,
        headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: this.token, "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      signal.throwIfAborted();
      if (response.status !== 200 || !response.headers.get("cache-control")?.split(",").some(x => x.trim().toLowerCase() === "no-store")
        || response.headers.get(INTERNAL_RUNTIME_EXTENSIONS_ACK_HEADER) !== INTERNAL_RUNTIME_EXTENSIONS_ACK_VALUE
        || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") ?? "") || !response.body) throw unavailable();
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > 2048)) throw unavailable();
      reader = response.body.getReader(); signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) {
        signal.throwIfAborted(); const chunk = await reader.read(); signal.throwIfAborted();
        if (chunk.done) break;
        size += chunk.value.byteLength; if (size > 2048) throw unavailable(); chunks.push(chunk.value);
      }
      const receipt = RuntimeExtensionsFleetResponse.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
      if (receipt.nonce !== nonce || !runtimeExtensionsIdentitiesEqual(receipt.identity, identity)) throw unavailable();
      signal.throwIfAborted();
    } catch { throw unavailable(); }
    finally {
      signal.removeEventListener("abort", cancel);
      if (reader) { cancel(); try { await cancellation; } finally { reader.releaseLock(); } }
      else if (response) { try { await response.body?.cancel(); } catch { /* No response can grant authority after failure. */ } }
    }
  }
}
