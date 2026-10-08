import {
  ErasureSessionExecutionError,
  type ErasureSessionExecutor,
} from "@agent-service/core";
import {
  INTERNAL_ERASURE_DRAIN_ACK_HEADER,
  INTERNAL_ERASURE_DRAIN_ACK_VALUE,
  INTERNAL_ERASURE_DRAIN_ROUTER_PATH_PREFIX,
  INTERNAL_ROUTER_TOKEN_HEADER,
  UserErasureDrainRequest,
  isCanonicalId,
} from "@agent-service/protocol";
import type { ErasureWriteAuthorization } from "@agent-service/store";

export interface RouterErasureSessionExecutorOptions {
  routerBaseUrl: string;
  internalToken: string;
  requestTimeoutMs: number;
  fetchImpl?: typeof globalThis.fetch;
}

function safeRouterBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("routerBaseUrl must be an http(s) base URL");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || (parsed.pathname && parsed.pathname !== "/")
    || parsed.search
    || parsed.hash
    || value.includes("?")
    || value.includes("#")
  ) throw new Error("routerBaseUrl must be a credential-free http(s) origin");
  return parsed.origin;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response body is deliberately never inspected. Cancellation is best effort only.
  }
}

/**
 * Minimal runner-worker client for the router's private erasure coordination endpoint. It carries
 * claim identity only, never session content, and collapses every transport detail into a bounded
 * worker error before it can reach durable retry state or logs.
 */
export class RouterErasureSessionExecutor implements ErasureSessionExecutor {
  private readonly routerBaseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: RouterErasureSessionExecutorOptions) {
    this.routerBaseUrl = safeRouterBaseUrl(options.routerBaseUrl);
    if (!/^[A-Za-z0-9._~-]{32,256}$/.test(options.internalToken)) {
      throw new Error("internalToken must be a valid private router token");
    }
    if (
      !Number.isSafeInteger(options.requestTimeoutMs)
      || options.requestTimeoutMs < 100
      || options.requestTimeoutMs > 30_000
    ) throw new Error("requestTimeoutMs must be between 100 and 30000");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async drainSessionForErasure(
    authority: ErasureWriteAuthorization,
    sessionId: string,
  ): Promise<void> {
    await this.execute(authority, sessionId);
  }

  async eraseSessionForErasure(
    authority: ErasureWriteAuthorization,
    sessionId: string,
  ): Promise<void> {
    await this.execute(authority, sessionId);
  }

  private async execute(
    authority: ErasureWriteAuthorization,
    sessionId: string,
  ): Promise<void> {
    let body: string;
    try {
      if (!isCanonicalId("sess", sessionId)) throw new Error("invalid session id");
      // Strict parsing strips nothing: unexpected fields make the request fail locally instead of
      // widening the private wire envelope.
      body = JSON.stringify(UserErasureDrainRequest.parse(authority));
    } catch {
      throw new ErasureSessionExecutionError("temporary_failure");
    }

    const url = new URL(
      `${INTERNAL_ERASURE_DRAIN_ROUTER_PATH_PREFIX}/${sessionId}`,
      this.routerBaseUrl,
    );
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          [INTERNAL_ROUTER_TOKEN_HEADER]: this.options.internalToken,
        },
        body,
        signal: AbortSignal.timeout(this.options.requestTimeoutMs),
      });
    } catch {
      throw new ErasureSessionExecutionError("owner_unavailable");
    }

    const status = response.status;
    const acknowledged = response.headers.get(INTERNAL_ERASURE_DRAIN_ACK_HEADER)
      === INTERNAL_ERASURE_DRAIN_ACK_VALUE;
    await cancelResponseBody(response);
    if (status === 204 && acknowledged) return;
    if (status === 409 || status === 502 || status === 503) {
      throw new ErasureSessionExecutionError("owner_unavailable");
    }
    throw new ErasureSessionExecutionError("temporary_failure");
  }
}
