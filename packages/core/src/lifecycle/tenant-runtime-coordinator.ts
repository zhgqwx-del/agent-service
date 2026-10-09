import { SubjectDeletingError } from "@agent-service/store";

export interface TenantRuntimeDrainIdentity {
  requestId: string;
  tenantId: string;
  subjectGeneration: number;
  /** SHA-256 of the durable T3a receipt which authorized this local-only drain. */
  t3aReceiptSha256: string;
}

export type TenantRuntimeOperationKind = "auth" | "provider" | "turn";

export interface TenantRuntimeDetailCounts {
  policyEntries: number;
  authVerifiers: number;
  providerRegistrations: number;
  authOperations: number;
  providerOperations: number;
  activeTurns: number;
}

export interface TenantRuntimeDrainResult extends TenantRuntimeDrainIdentity {
  cacheEntryCountBefore: number;
  cacheEntryCountAfter: number;
  activeOperationCountBefore: number;
  activeOperationCountAfter: number;
  activeTurnCountBefore: number;
  activeTurnCountAfter: number;
  completedAtMs: number;
  /** Diagnostic-only breakdown. The durable proof may omit this additive field. */
  detail?: {
    before: TenantRuntimeDetailCounts;
    after: TenantRuntimeDetailCounts;
  };
}

export interface TenantRuntimeParticipant {
  readonly name: string;
  /** Must be synchronous so closing the admission gate and observing state stay linearizable. */
  snapshotTenant(tenantId: string): Partial<TenantRuntimeDetailCounts>;
  /** Stop component-local admission and abort component-owned I/O. Must be synchronous and idempotent. */
  fenceTenant(identity: TenantRuntimeDrainIdentity): void;
  /** Remove the tenant's cached/registered material after all operation leases have settled. */
  purgeTenant(identity: TenantRuntimeDrainIdentity): void | Promise<void>;
}

export interface TenantRuntimeLease {
  readonly tenantId: string;
  readonly kind: TenantRuntimeOperationKind;
  readonly signal: AbortSignal;
  assertOpen(): void;
  release(): void;
}

export class TenantRuntimeDrainTimeoutError extends Error {
  override readonly name = "TenantRuntimeDrainTimeoutError";

  constructor(
    public readonly tenantId: string,
    public readonly timeoutMs: number,
  ) {
    super(`tenant runtime drain did not settle within ${timeoutMs}ms`);
  }
}

interface OperationState {
  kind: TenantRuntimeOperationKind;
  abort: AbortController;
  done: Promise<void>;
  resolveDone: () => void;
  released: boolean;
}

interface FenceState {
  identity: TenantRuntimeDrainIdentity;
  before: TenantRuntimeDetailCounts;
  beforeCaptured: boolean;
  inFlight?: Promise<TenantRuntimeDrainResult>;
  completed?: TenantRuntimeDrainResult;
}

const ZERO_COUNTS = (): TenantRuntimeDetailCounts => ({
  policyEntries: 0,
  authVerifiers: 0,
  providerRegistrations: 0,
  authOperations: 0,
  providerOperations: 0,
  activeTurns: 0,
});

const COUNT_KEYS = Object.keys(ZERO_COUNTS()) as (keyof TenantRuntimeDetailCounts)[];

/**
 * One process-local, tenant-scoped admission fence shared by auth, providers and SessionHost.
 *
 * `enter()` and the first half of `drain()` are deliberately synchronous (before `drain()` reaches
 * its first await), so JavaScript's run-to-completion rule supplies the local linearization point.
 * A timed-out drain remains fenced and can only be retried with the exact same durable identity.
 */
export class TenantRuntimeCoordinator {
  private readonly operations = new Map<string, Set<OperationState>>();
  private readonly fences = new Map<string, FenceState>();
  private readonly participants = new Set<TenantRuntimeParticipant>();
  private participantsSealed = false;

  registerParticipant(participant: TenantRuntimeParticipant): void {
    if (this.participantsSealed) throw new Error("tenant runtime participants are sealed");
    this.participants.add(participant);
  }

  /** Freeze the proof-producing component set after runner construction and before serving traffic. */
  sealParticipants(): void {
    this.participantsSealed = true;
  }

  enter(tenantId: string, kind: TenantRuntimeOperationKind): TenantRuntimeLease {
    if (this.fences.has(tenantId)) throw new SubjectDeletingError(tenantId);
    const abort = new AbortController();
    let resolveDone!: () => void;
    const operation: OperationState = {
      kind,
      abort,
      done: new Promise<void>((resolve) => { resolveDone = resolve; }),
      resolveDone: () => {},
      released: false,
    };
    operation.resolveDone = resolveDone;
    let tenantOperations = this.operations.get(tenantId);
    if (!tenantOperations) {
      tenantOperations = new Set();
      this.operations.set(tenantId, tenantOperations);
    }
    tenantOperations.add(operation);

    const assertOpen = () => {
      if (operation.abort.signal.aborted || this.fences.has(tenantId)) throw new SubjectDeletingError(tenantId);
    };
    return {
      tenantId,
      kind,
      signal: abort.signal,
      assertOpen,
      release: () => {
        if (operation.released) return;
        operation.released = true;
        tenantOperations!.delete(operation);
        if (tenantOperations!.size === 0) this.operations.delete(tenantId);
        operation.resolveDone();
      },
    };
  }

  isFenced(tenantId: string): boolean {
    return this.fences.has(tenantId);
  }

  snapshot(tenantId: string): TenantRuntimeDetailCounts {
    const counts = ZERO_COUNTS();
    for (const operation of this.operations.get(tenantId) ?? []) {
      if (operation.kind === "auth") counts.authOperations += 1;
      else if (operation.kind === "provider") counts.providerOperations += 1;
      else counts.activeTurns += 1;
    }
    for (const participant of this.participants) {
      const contribution = participant.snapshotTenant(tenantId);
      for (const key of COUNT_KEYS) {
        const value = contribution[key];
        if (value === undefined) continue;
        if (!Number.isSafeInteger(value) || value < 0) {
          throw new Error(`tenant runtime participant ${participant.name} returned invalid ${key}`);
        }
        counts[key] += value;
      }
    }
    return counts;
  }

  drain(identity: TenantRuntimeDrainIdentity, timeoutMs = 30_000): Promise<TenantRuntimeDrainResult> {
    if (!this.participantsSealed) return Promise.reject(new Error("tenant runtime participants must be sealed before drain"));
    validateIdentity(identity);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("tenant runtime drain timeout must be a positive safe integer");

    const existing = this.fences.get(identity.tenantId);
    if (existing) {
      assertSameIdentity(existing.identity, identity);
      if (existing.completed) return Promise.resolve(existing.completed);
      if (existing.inFlight) return existing.inFlight;
      let firstError: unknown;
      if (!existing.beforeCaptured) {
        try {
          existing.before = this.snapshot(identity.tenantId);
          existing.beforeCaptured = true;
        } catch (error) {
          firstError = error;
        }
      }
      try {
        this.applyFence(existing.identity);
      } catch (error) {
        firstError ??= error;
      }
      if (firstError !== undefined) return Promise.reject(firstError);
      return this.runDrain(existing, timeoutMs);
    }

    // The fence is visible before snapshots, participant callbacks or any await. No later operation
    // can enter and escape the before/after accounting window.
    const state: FenceState = {
      identity: { ...identity },
      before: ZERO_COUNTS(),
      beforeCaptured: false,
    };
    this.fences.set(identity.tenantId, state);
    let firstError: unknown;
    try {
      state.before = this.snapshot(identity.tenantId);
      state.beforeCaptured = true;
    } catch (error) {
      firstError = error;
    }
    try {
      this.applyFence(identity);
    } catch (error) {
      firstError ??= error;
    }
    // Fail closed. The durable operation may retry the exact identity, but the tenant never reopens.
    if (firstError !== undefined) return Promise.reject(firstError);
    return this.runDrain(state, timeoutMs);
  }

  private applyFence(identity: TenantRuntimeDrainIdentity): void {
    // Participant hooks are required to be idempotent. Re-running all of them lets an exact retry
    // recover safely if a prior hook threw after only part of the fixed participant set was fenced.
    // Still invoke every hook and abort every coordinator-owned operation if one hook is faulty;
    // the admission fence is already installed, so best-effort shutdown is safer than short-circuiting.
    let firstError: unknown;
    for (const participant of this.participants) {
      try {
        participant.fenceTenant(identity);
      } catch (error) {
        firstError ??= error;
      }
    }
    for (const operation of this.operations.get(identity.tenantId) ?? []) {
      try {
        operation.abort.abort();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  private runDrain(state: FenceState, timeoutMs: number): Promise<TenantRuntimeDrainResult> {
    const work = (async () => {
      await waitForOperations(
        [...(this.operations.get(state.identity.tenantId) ?? [])].map((operation) => operation.done),
        state.identity.tenantId,
        timeoutMs,
      );
      for (const participant of this.participants) await participant.purgeTenant(state.identity);

      const after = this.snapshot(state.identity.tenantId);
      if (COUNT_KEYS.some((key) => after[key] !== 0)) {
        throw new Error(`tenant runtime drain invariant failed for ${state.identity.tenantId}: local state remains`);
      }
      const result: TenantRuntimeDrainResult = Object.freeze({
        ...state.identity,
        cacheEntryCountBefore: cacheEntries(state.before),
        cacheEntryCountAfter: cacheEntries(after),
        activeOperationCountBefore: activeOperations(state.before),
        activeOperationCountAfter: activeOperations(after),
        activeTurnCountBefore: state.before.activeTurns,
        activeTurnCountAfter: after.activeTurns,
        completedAtMs: Date.now(),
        detail: { before: { ...state.before }, after: { ...after } },
      });
      state.completed = result;
      return result;
    })();
    state.inFlight = work;
    void work.finally(() => {
      if (state.inFlight === work) state.inFlight = undefined;
    }).catch(() => {});
    return work;
  }
}

function cacheEntries(counts: TenantRuntimeDetailCounts): number {
  return counts.policyEntries + counts.authVerifiers + counts.providerRegistrations;
}

function activeOperations(counts: TenantRuntimeDetailCounts): number {
  return counts.authOperations + counts.providerOperations;
}

async function waitForOperations(done: Promise<void>[], tenantId: string, timeoutMs: number): Promise<void> {
  if (done.length === 0) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.all(done),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TenantRuntimeDrainTimeoutError(tenantId, timeoutMs)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function validateIdentity(identity: TenantRuntimeDrainIdentity): void {
  if (!identity.requestId || !identity.tenantId) throw new Error("tenant runtime drain identity is incomplete");
  if (!Number.isSafeInteger(identity.subjectGeneration) || identity.subjectGeneration <= 0) {
    throw new Error("tenant runtime drain subjectGeneration must be a positive safe integer");
  }
  if (!/^[a-f0-9]{64}$/i.test(identity.t3aReceiptSha256)) {
    throw new Error("tenant runtime drain t3aReceiptSha256 must be a SHA-256 hex digest");
  }
}

function assertSameIdentity(expected: TenantRuntimeDrainIdentity, actual: TenantRuntimeDrainIdentity): void {
  if (
    expected.requestId !== actual.requestId
    || expected.tenantId !== actual.tenantId
    || expected.subjectGeneration !== actual.subjectGeneration
    || expected.t3aReceiptSha256.toLowerCase() !== actual.t3aReceiptSha256.toLowerCase()
  ) throw new Error("tenant runtime drain identity conflicts with the existing process-local fence");
}
