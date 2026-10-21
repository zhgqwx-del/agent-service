export { providerQuotaNamespaceSha256 } from "@agent-service/protocol";

/** Content-free, bounded admission policy. Provider identity is server-selected, never a key. */
export interface ProviderQuotaLimit {
  readonly rpm?: number;
  readonly concurrency?: number;
}

export interface ProviderQuotaRequest {
  readonly tenantId: string;
  readonly userId: string;
  /** Stable provider identity; platform providers share their quota across all tenants. */
  readonly provider: { readonly scope: "platform" | "tenant"; readonly id: string };
  readonly tenant: ProviderQuotaLimit;
  readonly user: ProviderQuotaLimit;
  readonly providerLimit: ProviderQuotaLimit;
}

export class ProviderQuotaError extends Error {
  constructor(readonly reason: "rpm" | "concurrency" | "unavailable", readonly retryAfterMs?: number) {
    super("Provider admission is unavailable.");
    this.name = "ProviderQuotaError";
  }
}

export interface ProviderQuotaLease {
  /** Abort the real request on lost authority; not evidence that its I/O has stopped. */
  readonly signal: AbortSignal;
  assertOpen(): Promise<void>;
  /** Release only after actual fetch/body cancellation settles. Idempotent. */
  release(): Promise<void>;
}

export interface ProviderQuotaCoordinator {
  readonly namespaceSha256: string;
  /** A fresh transport check, never an admission or grant of request capacity. */
  assertReady(): Promise<void>;
  enter(request: ProviderQuotaRequest, signal: AbortSignal): Promise<ProviderQuotaLease>;
  /** Fence admissions and abort consumers, then wait for their actual I/O and release. */
  close(): Promise<void>;
}
