/** Non-secret operator inventory; matching labels do not prove matching credential material. */
export interface ProviderPoolInventory {
  readonly version: "provider-key-pool-v1";
  readonly providerId: string;
  readonly slots: readonly Readonly<{ id: string; version: string }>[];
}

export interface ProviderPoolPolicy {
  /** Consecutive eligible failures inside the window. Default 5. */
  readonly threshold?: number;
  /** Default 60,000 ms. */
  readonly windowMs?: number;
  /** Default 30,000 ms. */
  readonly cooldownMs?: number;
  /** Default 30,000 ms. */
  readonly rateLimitCooldownMs?: number;
}

export type ProviderPoolOutcome = Readonly<
  | { kind: "success" | "failure" | "cancelled" | "credential_rejected" | "neutral" }
  | { kind: "rate_limited"; retryDelayMs?: number; retryAtMs?: number }
>;

/** Original process-local capability. A clone or an equal literal cannot acquire a permit. */
export interface ProviderPoolSelection { readonly slot: Readonly<{ id: string; version: string }> }

export class ProviderPoolError extends Error {
  constructor(readonly reason: "unavailable" | "open" | "disabled", readonly retryAfterMs?: number) {
    super("Provider pool is unavailable."); this.name = "ProviderPoolError";
  }
}

export interface ProviderPoolLease {
  readonly signal: AbortSignal;
  assertOpen(): Promise<void>;
  /** Call only after actual fetch/body I/O settles. Same outcome is idempotent; conflicts reject. */
  release(outcome: ProviderPoolOutcome): Promise<void>;
}

export interface ProviderPoolCoordinator {
  readonly namespaceSha256: string;
  assertReady(): Promise<void>;
  /** Selection advances only a cursor. It never grants quota or a half-open probe. */
  select(inventory: ProviderPoolInventory, policy: ProviderPoolPolicy, signal: AbortSignal): Promise<ProviderPoolSelection>;
  /** Obtain only after quota, before root-family/T1/fleet's final dispatch boundary. */
  acquire(selection: ProviderPoolSelection, signal: AbortSignal): Promise<ProviderPoolLease>;
  /** Abort consumers and await their actual release/native transports, without fabricating one. */
  close(): Promise<void>;
}
