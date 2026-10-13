import {
  INTERNAL_ROUTER_TOKEN_HEADER,
  INTERNAL_SESSION_USAGE_RETENTION_ACK_HEADER,
  INTERNAL_SESSION_USAGE_RETENTION_ACK_VALUE,
  INTERNAL_SESSION_USAGE_RETENTION_READY_PATH,
} from "@agent-service/protocol";

export interface RouterOrdinarySessionUsageRetentionGateOptions {
  routerBaseUrl: string;
  internalToken: string;
  requestTimeoutMs: number;
  fetchImpl?: typeof globalThis.fetch;
}

/** One non-sticky response authorizes only the immediately following bounded worker boundary. */
export class RouterOrdinarySessionUsageRetentionGate {
  private readonly routerBaseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: RouterOrdinarySessionUsageRetentionGateOptions) {
    let parsed: URL;
    try {
      parsed = new URL(options.routerBaseUrl);
    } catch {
      throw new Error("routerBaseUrl must be an http(s) origin");
    }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname
      || parsed.username || parsed.password || (parsed.pathname && parsed.pathname !== "/")
      || parsed.search || parsed.hash || options.routerBaseUrl.includes("?")
      || options.routerBaseUrl.includes("#")) {
      throw new Error("routerBaseUrl must be a credential-free http(s) origin");
    }
    this.routerBaseUrl = parsed.origin;
    if (!/^[A-Za-z0-9._~-]{32,256}$/.test(options.internalToken)) {
      throw new Error("internalToken must be a valid private router token");
    }
    if (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 100
      || options.requestTimeoutMs > 30_000) {
      throw new Error("requestTimeoutMs must be between 100 and 30000");
    }
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async canExecute(): Promise<boolean> {
    let response: Response;
    const signal = AbortSignal.timeout(this.options.requestTimeoutMs);
    let onAbort: (() => void) | undefined;
    try {
      const request = this.fetchImpl(new URL(INTERNAL_SESSION_USAGE_RETENTION_READY_PATH, this.routerBaseUrl), {
        method: "GET",
        redirect: "manual",
        headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: this.options.internalToken },
        signal,
      });
      response = await Promise.race([request, new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      })]);
    } catch {
      return false;
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
    let ready = false;
    try {
      ready = !signal.aborted && response.status === 204
        && response.headers.get(INTERNAL_SESSION_USAGE_RETENTION_ACK_HEADER) === INTERNAL_SESSION_USAGE_RETENTION_ACK_VALUE
        && response.headers.get("cache-control")?.trim().toLowerCase() === "no-store";
    } catch {
      ready = false;
    }
    try {
      void response.body?.cancel().catch(() => {});
    } catch {
      // Response content cannot prove authorization; cancellation is best effort only.
    }
    return ready && !signal.aborted;
  }
}
