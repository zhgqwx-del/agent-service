import {
  INTERNAL_ROUTER_TOKEN_HEADER,
  INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER,
  INTERNAL_TENANT_RUNTIME_DRAIN_ACK_VALUE,
  INTERNAL_TENANT_RUNTIME_DRAIN_ROUTER_PATH,
  TenantRuntimeDrainRequest,
  TenantRuntimeRevocationFleetProof,
} from "@agent-service/protocol";

const MAX_FLEET_PROOF_BYTES = 128 * 1024;

export interface RouterTenantRuntimeDrainClientOptions {
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
  ) throw new Error("routerBaseUrl must be a credential-free http(s) origin");
  return parsed.origin;
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const value = Number(declared);
    if (!Number.isSafeInteger(value) || value < 0 || value > maxBytes) {
      await cancelResponseBody(response);
      return undefined;
    }
  }
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(next.value);
    }
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/**
 * Least-privilege runner-to-router T3b client. It accepts only a fully validated fleet proof whose
 * every local receipt is bound to the exact T3a authority sent in this request.
 */
export class RouterTenantRuntimeDrainClient {
  private readonly routerBaseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: RouterTenantRuntimeDrainClientOptions) {
    this.routerBaseUrl = safeRouterBaseUrl(options.routerBaseUrl);
    if (!/^[A-Za-z0-9._~-]{32,256}$/.test(options.internalToken)) {
      throw new Error("internalToken must be a valid private router token");
    }
    if (
      !Number.isSafeInteger(options.requestTimeoutMs)
      || options.requestTimeoutMs < 100
      || options.requestTimeoutMs > 120_000
    ) throw new Error("requestTimeoutMs must be between 100 and 120000");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async drain(
    input: TenantRuntimeDrainRequest,
  ): Promise<TenantRuntimeRevocationFleetProof | null> {
    const authority = TenantRuntimeDrainRequest.parse(input);
    let response: Response;
    try {
      response = await this.fetchImpl(
        new URL(INTERNAL_TENANT_RUNTIME_DRAIN_ROUTER_PATH, this.routerBaseUrl),
        {
          method: "POST",
          redirect: "manual",
          headers: {
            "content-type": "application/json",
            [INTERNAL_ROUTER_TOKEN_HEADER]: this.options.internalToken,
          },
          body: JSON.stringify(authority),
          signal: AbortSignal.timeout(this.options.requestTimeoutMs),
        },
      );
    } catch {
      return null;
    }

    if (
      response.status !== 200
      || response.headers.get(INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER)
        !== INTERNAL_TENANT_RUNTIME_DRAIN_ACK_VALUE
      || !response.headers.get("cache-control")?.split(",").some((value) => (
        value.trim().toLowerCase() === "no-store"
      ))
    ) {
      await cancelResponseBody(response);
      return null;
    }
    const bytes = await readCapped(response, MAX_FLEET_PROOF_BYTES);
    if (!bytes) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return null;
    }
    const proof = TenantRuntimeRevocationFleetProof.safeParse(raw);
    if (
      !proof.success
      || proof.data.targets.some((receipt) => (
        receipt.requestId !== authority.requestId
        || receipt.tenantId !== authority.tenantId
        || receipt.subjectGeneration !== authority.subjectGeneration
        || receipt.t3aReceiptSha256 !== authority.t3aReceiptSha256
      ))
    ) return null;
    return proof.data;
  }
}
