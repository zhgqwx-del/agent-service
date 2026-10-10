import {
  INTERNAL_ROUTER_TOKEN_HEADER,
  INTERNAL_TENANT_REDIS_PURGE_ACK_HEADER,
  INTERNAL_TENANT_REDIS_PURGE_ACK_VALUE,
  INTERNAL_TENANT_REDIS_PURGE_READY_PATH,
} from "@agent-service/protocol";

export interface RouterTenantRedisPurgeGateOptions {
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
    // The body is never execution proof. Cancellation is best effort only.
  }
}

/** One exact, no-store T3g fleet acknowledgement authorizes one bounded worker boundary. */
export class RouterTenantRedisPurgeGate {
  private readonly routerBaseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: RouterTenantRedisPurgeGateOptions) {
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

  async canExecute(): Promise<boolean> {
    const url = new URL(INTERNAL_TENANT_REDIS_PURGE_READY_PATH, this.routerBaseUrl);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        redirect: "manual",
        headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: this.options.internalToken },
        signal: AbortSignal.timeout(this.options.requestTimeoutMs),
      });
    } catch {
      return false;
    }
    let ready = false;
    try {
      ready = response.status === 204
        && response.headers.get(INTERNAL_TENANT_REDIS_PURGE_ACK_HEADER)
          === INTERNAL_TENANT_REDIS_PURGE_ACK_VALUE
        && response.headers.get("cache-control")?.trim().toLowerCase() === "no-store";
    } catch {
      ready = false;
    }
    await cancelResponseBody(response);
    return ready;
  }
}
