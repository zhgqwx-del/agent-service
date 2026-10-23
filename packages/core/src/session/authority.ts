import { randomUUID } from "node:crypto";
import { ApiError, type Principal } from "@agent-service/protocol";
import { createSessionAcquireCommand, type ErasureWriteAuthorization, type SessionAcquireResult,
  type SessionAuthority, type SessionLeaseProof } from "@agent-service/store";

/** One fixed acquisition, including response-loss confirmation; never refreshes its predecessor. */
export async function acquireSessionAuthority(authority: SessionAuthority, input: {
  sessionId: string; principal: Principal; runnerId: string; runnerAddr: string; bootId: string;
  expectedFence: number; ttlMs: number;
}, erasure?: ErasureWriteAuthorization, predecessor?: SessionLeaseProof): Promise<SessionAcquireResult> {
  const command = createSessionAcquireCommand({ ...input, acquisitionId: randomUUID() });
  try {
    return erasure ? await authority.acquireForErasure(command, erasure, predecessor) : await authority.acquire(command);
  } catch (failure) {
    // The original call has actually rejected. Only an exact read-only confirmation can resolve its
    // possibly-committed outcome. An unavailable confirmation preserves the original unknown error.
    try { return erasure ? await authority.confirmForErasure(command, erasure, predecessor) : await authority.confirm(command); }
    catch { throw failure; }
  }
}

export interface SessionAuthorityGuard {
  readonly proof: SessionLeaseProof;
  readonly ownsLease: boolean;
  readonly abort: AbortController;
  readonly loss: Promise<ApiError>;
  readonly lost: ApiError | undefined;
  wait<T>(work: Promise<T>): Promise<T>;
  assertOwned(): void;
  attach(onLost: () => void): void;
  stop(): void;
  /** Joins the original accepted operations/renewals; no observation deadline proves settlement. */
  settle(): Promise<void>;
}

export function createSessionAuthorityGuard(authority: SessionAuthority, proof: SessionLeaseProof, ttlMs: number,
  onWork?: (work: Promise<unknown>) => void): SessionAuthorityGuard {
  const abort = new AbortController(), pending = new Set<Promise<unknown>>();
  const renewEveryMs = Math.max(10, Math.floor(ttlMs / 3));
  let timer: NodeJS.Timeout | undefined, stopped = false, lost: ApiError | undefined, onLost: (() => void) | undefined;
  let resolveLoss!: (error: ApiError) => void;
  const loss = new Promise<ApiError>(resolve => { resolveLoss = resolve; });
  const closed = () => lost ?? new ApiError("session_lease_conflict", "session authority is closed");
  const own = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work); onWork?.(work);
    void work.then(() => pending.delete(work), () => pending.delete(work)); return work;
  };
  const stop = () => { stopped = true; clearTimeout(timer); timer = undefined; };
  const markLost = () => {
    if (stopped || lost) return;
    lost = new ApiError("session_lease_conflict", "session lease was lost");
    stop(); abort.abort(); resolveLoss(lost); onLost?.();
  };
  const schedule = () => {
    if (stopped || lost) return;
    timer = setTimeout(async () => {
      timer = undefined;
      if (stopped || lost) return;
      let deadline: NodeJS.Timeout | undefined;
      // Keep the native/adapter promise, not just the logical timeout wrapper.
      const renewal = own(Promise.resolve().then(() => authority.renew(proof, ttlMs)));
      const ok = await Promise.race([renewal.catch(() => false), new Promise<boolean>(resolve => {
        deadline = setTimeout(() => resolve(false), renewEveryMs);
      })]);
      clearTimeout(deadline);
      if (stopped || lost) return;
      if (!ok) markLost(); else schedule();
    }, renewEveryMs);
  };
  schedule();
  return {
    proof, ownsLease: true, abort, loss, get lost() { return lost; },
    async wait<T>(work: Promise<T>): Promise<T> {
      // Admission captures the original promise synchronously, including when already lost.
      own(work);
      if (lost || stopped) throw closed();
      const outcome = await Promise.race([
        work.then(value => ({ type: "value" as const, value }), error => ({ type: "error" as const, error })),
        loss.then(error => ({ type: "lost" as const, error })),
      ]);
      if (outcome.type === "value") { if (lost || stopped) throw closed(); return outcome.value; }
      throw outcome.error;
    },
    assertOwned() { if (lost || stopped) throw closed(); },
    attach(callback) { onLost = callback; if (lost) callback(); },
    stop,
    async settle() { stop(); while (pending.size) await Promise.allSettled([...pending]); },
  };
}
