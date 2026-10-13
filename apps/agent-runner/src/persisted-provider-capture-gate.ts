import { randomBytes } from "node:crypto";
import {
  INTERNAL_ROUTER_TOKEN_HEADER,
  INTERNAL_PERSISTED_PROVIDER_CAPTURE_FLEET_PATH,
  INTERNAL_PERSISTED_PROVIDER_CAPTURE_ACK_HEADER,
  INTERNAL_PERSISTED_PROVIDER_CAPTURE_ACK_VALUE,
  PersistedProviderCaptureBinding,
  PersistedProviderCaptureFleetProof,
  PersistedProviderCaptureFleetRequest,
  PersistedProviderCaptureFleetResponse,
  awaitPersistedProviderCaptureResponse,
  persistedProviderCaptureBindingsEqual,
  readPersistedProviderCaptureJson,
} from "@agent-service/protocol";

export interface RouterPersistedProviderCaptureGateOptions {
  routerBaseUrl: string;
  internalToken: string;
  runnerId: string;
  bootId: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
}

/** No latch/cache: one new nonce-bound response authorizes one immediate bounded boundary. */
export class RouterPersistedProviderCaptureGate {
  private readonly routerBaseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  constructor(private readonly options: RouterPersistedProviderCaptureGateOptions) {
    const url = new URL(options.routerBaseUrl);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.pathname !== "/"
      || url.search || url.hash || options.routerBaseUrl.includes("?") || options.routerBaseUrl.includes("#")) {
      throw new Error("capture router URL must be a credential-free http(s) origin");
    }
    if (!/^[A-Za-z0-9._~-]{32,256}$/.test(options.internalToken)) throw new Error("capture internal token is invalid");
    PersistedProviderCaptureFleetRequest.shape.runnerId.parse(options.runnerId);
    PersistedProviderCaptureFleetRequest.shape.bootId.parse(options.bootId);
    this.routerBaseUrl = url.origin;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.requestTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 30_000) throw new Error("capture timeout is invalid");
  }

  async requireFreshFleet(expected: PersistedProviderCaptureFleetProof, boundary: PersistedProviderCaptureFleetRequest["boundary"]): Promise<PersistedProviderCaptureFleetProof> {
    const expectedProof = PersistedProviderCaptureFleetProof.parse(expected);
    const binding = PersistedProviderCaptureBinding.parse(Object.fromEntries(
      Object.keys(PersistedProviderCaptureBinding.shape).map((key) => [key, expectedProof[key as keyof typeof expectedProof]]),
    ));
    const nonce = randomBytes(32).toString("hex");
    const signal = AbortSignal.timeout(this.timeoutMs);
    const request: PersistedProviderCaptureFleetRequest = {
      runnerId: this.options.runnerId, bootId: this.options.bootId, nonce, boundary,
      binding, configuredFleetRootSha256: expectedProof.configuredFleetRootSha256,
    };
    const response = await awaitPersistedProviderCaptureResponse(this.fetchImpl(
      new URL(INTERNAL_PERSISTED_PROVIDER_CAPTURE_FLEET_PATH, this.routerBaseUrl), {
        method: "POST", redirect: "manual", signal,
        headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: this.options.internalToken, "content-type": "application/json" },
        body: JSON.stringify(request),
      },
    ), signal);
    if (response.status !== 200
      || response.headers.get(INTERNAL_PERSISTED_PROVIDER_CAPTURE_ACK_HEADER) !== INTERNAL_PERSISTED_PROVIDER_CAPTURE_ACK_VALUE
      || !response.headers.get("cache-control")?.split(",").some((value) => value.trim().toLowerCase() === "no-store")) {
      void response.body?.cancel().catch(() => {});
      throw new Error("capture configured fleet is unavailable");
    }
    const result = PersistedProviderCaptureFleetResponse.parse(await readPersistedProviderCaptureJson(response, signal));
    if (result.nonce !== nonce || result.runnerId !== request.runnerId || result.bootId !== request.bootId
      || result.boundary !== boundary || result.proof.configuredFleetRootSha256 !== expectedProof.configuredFleetRootSha256
      || !persistedProviderCaptureBindingsEqual(result.proof, binding)) {
      throw new Error("capture configured fleet proof is unbound");
    }
    signal.throwIfAborted();
    return result.proof;
  }
}
