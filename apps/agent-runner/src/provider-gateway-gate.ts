import { randomBytes } from "node:crypto";
import {
  INTERNAL_ROUTER_TOKEN_HEADER, INTERNAL_PROVIDER_GATEWAY_READY_PATH,
  INTERNAL_PROVIDER_GATEWAY_ACK_HEADER, INTERNAL_PROVIDER_GATEWAY_ACK_VALUE,
  ProviderGatewayIdentity, ProviderGatewayFleetRequest, ProviderGatewayFleetResponse,
  providerGatewayIdentitiesEqual, readProviderGatewayJson,
} from "@agent-service/protocol";

const unavailable = () => new Error("Provider gateway fleet is unavailable.");
export interface RouterProviderGatewayGateOptions {
  readonly routerBaseUrl: string;
  readonly internalToken: string;
  readonly requestTimeoutMs?: number;
  readonly fetchImpl?: typeof globalThis.fetch;
}

/** No cached healthy subset: every dispatch obtains a nonce-bound configured-fleet proof. */
export class RouterProviderGatewayGate {
  private readonly origin: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  constructor(options: RouterProviderGatewayGateOptions) {
    let url: URL;
    try { url = new URL(options.routerBaseUrl); } catch { throw unavailable(); }
    if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password || url.pathname !== "/"
      || options.routerBaseUrl.includes("?") || options.routerBaseUrl.includes("#")
      || /[\u0000-\u0020\u007f]/.test(options.routerBaseUrl)
      || !/^[A-Za-z0-9._~-]{32,256}$/.test(options.internalToken)
      || /[\u0000-\u0020\u007f]/.test(options.internalToken)) throw unavailable();
    this.origin = url.origin; this.token = options.internalToken;
    this.timeoutMs = options.requestTimeoutMs ?? 2000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 5000) throw unavailable();
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }
  async requireFreshFleet(expected: ProviderGatewayIdentity, callerSignal: AbortSignal): Promise<void> {
    let identity: ProviderGatewayIdentity;
    try { identity = ProviderGatewayIdentity.parse(expected); } catch { throw unavailable(); }
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(this.timeoutMs)]);
    const nonce = randomBytes(32).toString("hex");
    let response: Response | undefined;
    try {
      signal.throwIfAborted();
      response = await this.fetchImpl(new URL(INTERNAL_PROVIDER_GATEWAY_READY_PATH, this.origin), {
        method: "POST", redirect: "manual", signal,
        headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: this.token, "content-type": "application/json" },
        body: JSON.stringify(ProviderGatewayFleetRequest.parse({ nonce, identity })),
      });
      signal.throwIfAborted();
      if (response.status !== 200 || response.headers.get(INTERNAL_PROVIDER_GATEWAY_ACK_HEADER) !== INTERNAL_PROVIDER_GATEWAY_ACK_VALUE
        || !response.headers.get("cache-control")?.split(",").some(value => value.trim().toLowerCase() === "no-store")
        || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") ?? "")) throw unavailable();
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > 2048)) throw unavailable();
      const receipt = ProviderGatewayFleetResponse.parse(await readProviderGatewayJson(response.body, signal));
      if (receipt.nonce !== nonce || !providerGatewayIdentitiesEqual(identity, receipt.identity)) throw unavailable();
      signal.throwIfAborted();
    } catch { throw unavailable(); }
    finally { if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
  }
}
