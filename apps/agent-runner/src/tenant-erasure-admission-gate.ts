import {
  INTERNAL_ROUTER_TOKEN_HEADER,
  INTERNAL_TENANT_ERASURE_ADMISSION_ACK_HEADER,
  INTERNAL_TENANT_ERASURE_ADMISSION_ACK_VALUE,
  INTERNAL_TENANT_ERASURE_ADMISSION_READY_PATH,
} from "@agent-service/protocol";

export interface RouterTenantErasureAdmissionGateOptions {
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
    // The fixed ACK is carried only by status and header. Body cancellation is best effort.
  }
}

/**
 * A successful probe authorizes exactly one tenant-admission attempt. The runner performs it after
 * platform authentication and immediately before entering the store transaction, so a direct
 * runner call cannot turn a stale capability observation into a durable mixed-fleet gate.
 */
export class RouterTenantErasureAdmissionGate {
  private readonly routerBaseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: RouterTenantErasureAdmissionGateOptions) {
    this.routerBaseUrl = safeRouterBaseUrl(options.routerBaseUrl);
    if (!/^[A-Za-z0-9._~-]{32,256}$/.test(options.internalToken)) {
      throw new Error("internalToken must be a valid private router token");
    }
    if (
      !Number.isSafeInteger(options.requestTimeoutMs)
      || options.requestTimeoutMs < 100
      || options.requestTimeoutMs > 10_000
    ) throw new Error("requestTimeoutMs must be between 100 and 10000");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async canAdmit(): Promise<boolean> {
    const url = new URL(INTERNAL_TENANT_ERASURE_ADMISSION_READY_PATH, this.routerBaseUrl);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        redirect: "manual",
        headers: {
          [INTERNAL_ROUTER_TOKEN_HEADER]: this.options.internalToken,
        },
        signal: AbortSignal.timeout(this.options.requestTimeoutMs),
      });
    } catch {
      return false;
    }

    let ready = false;
    try {
      ready = response.status === 204
        && response.headers.get(INTERNAL_TENANT_ERASURE_ADMISSION_ACK_HEADER)
          === INTERNAL_TENANT_ERASURE_ADMISSION_ACK_VALUE;
    } catch {
      ready = false;
    }
    await cancelResponseBody(response);
    return ready;
  }
}
