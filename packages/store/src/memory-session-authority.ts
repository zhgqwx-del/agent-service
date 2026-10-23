import { createHash, randomUUID } from "node:crypto";
import type { Principal, Session } from "@agent-service/protocol";
import type { ErasureWriteAuthorization } from "./subject-lifecycle.js";
import { MEMORY_SESSION_AUTHORITY_PROTOCOL, SessionAuthorityError, SessionAuthorityConflictError,
  captureSessionAcquireCommand, bindSessionAcquireSource, captureSessionErasureAuthorization, captureSessionLeaseProof, captureSessionWriteAdmission, issueSessionLeaseProof,
  sessionAuthorityNatural, sessionAuthorityTtl,
  type SessionAuthority, type SessionAcquireCommand, type SessionAcquireResult, type SessionLeaseProof,
  type SessionLeaseIdentity, type SessionOwnerObservation, type SessionAuthorityIdentity,
} from "./session-authority.js";
interface Tuple { readonly identity: Readonly<SessionLeaseIdentity>; readonly expiresAtDbMs: number }
interface MemorySessionAuthorityPort {
  now(): number; session(id: string): Session | undefined; deleted(id: string): boolean;
  gate(principal: Principal): void; erasureGate(authorization: ErasureWriteAuthorization): void;
  managed(sessionId: string, rootSessionId?: string): boolean;
  handoff(sessionId: string, newFence: number, writeLease: () => void): void;
  atomic<T>(sessionIds: readonly string[], work: () => T): T;
}
function fail(): never { throw new SessionAuthorityError(); }
function conflict(): never { throw new SessionAuthorityConflictError(); }
function same(a: Readonly<SessionLeaseIdentity>, b: Readonly<SessionLeaseIdentity>): boolean {
  return a.protocol === b.protocol && a.bindingId === b.bindingId && a.rootSessionId === b.rootSessionId
    && a.principal.tenantId === b.principal.tenantId && a.principal.userId === b.principal.userId
    && a.runnerId === b.runnerId && a.runnerAddr === b.runnerAddr && a.bootId === b.bootId
    && a.acquisitionId === b.acquisitionId && a.fence === b.fence && a.sourceSha256 === b.sourceSha256;
}
/** Synchronous state changes share the owning store's canonical session and rollback boundary. */
export class MemorySessionAuthority implements SessionAuthority {
  private bindingId: string = randomUUID();
  private tuples = new Map<string, Tuple>();
  private closed = false;
  constructor(private readonly port: MemorySessionAuthorityPort) {}
  snapshot(): { bindingId: string; tuples: Map<string, Tuple> } { return { bindingId: this.bindingId, tuples: new Map(this.tuples) }; }
  restore(before: { bindingId: string; tuples: Map<string, Tuple> }) { this.bindingId = before.bindingId; this.tuples = new Map(before.tuples); }
  /** Memory reference equivalent of the original atomic restore-epoch successor. */
  rotateEpochBinding(): void { this.open(); this.bindingId = randomUUID(); }
  private open() { if (this.closed) fail(); }
  private now() { const now = this.port.now(); sessionAuthorityNatural(now); return now; }
  async identity(): Promise<SessionAuthorityIdentity> { this.open(); return Object.freeze({ protocol: MEMORY_SESSION_AUTHORITY_PROTOCOL, backend: "memory",
    namespaceSha256: createHash("sha256").update(this.bindingId).digest("hex") }); }
  async acquire(command: SessionAcquireCommand) { return this.acquireInner(command, false); }
  async confirm(command: SessionAcquireCommand) { return this.acquireInner(command, true); }
  async acquireForErasure(command: SessionAcquireCommand, authorization: ErasureWriteAuthorization, predecessor?: SessionLeaseProof) {
    return this.acquireInner(command, false, captureSessionErasureAuthorization(authorization), predecessor);
  }
  async confirmForErasure(command: SessionAcquireCommand, authorization: ErasureWriteAuthorization, predecessor?: SessionLeaseProof) {
    return this.acquireInner(command, true, captureSessionErasureAuthorization(authorization), predecessor);
  }
  private async acquireInner(command: SessionAcquireCommand, confirmOnly: boolean, erasure?: ErasureWriteAuthorization, predecessor?: SessionLeaseProof): Promise<SessionAcquireResult> {
    this.open(); const input = captureSessionAcquireCommand(command), sourceSha256 = bindSessionAcquireSource(command, erasure), previous = predecessor === undefined ? undefined : captureSessionLeaseProof(predecessor);
    return this.port.atomic([input.sessionId], () => {
      const session = this.port.session(input.sessionId);
      if (!session || this.port.deleted(session.id) || session.tenantId !== input.principal.tenantId || session.userId !== input.principal.userId
        || this.port.managed(session.id)) return conflict();
      if (erasure) {
        if (erasure.tenantId !== input.principal.tenantId || erasure.userId !== input.principal.userId) return conflict();
        this.port.erasureGate(erasure);
      } else this.port.gate(input.principal);
      const now = this.now(), current = this.tuples.get(session.id), wanted: SessionLeaseIdentity = {
        protocol: MEMORY_SESSION_AUTHORITY_PROTOCOL, bindingId: this.bindingId, rootSessionId: session.id, principal: input.principal,
        runnerId: input.runnerId, runnerAddr: input.runnerAddr, bootId: input.bootId, acquisitionId: input.acquisitionId, sourceSha256, fence: input.expectedFence + 1,
        ...(erasure ? { erasureAuthorization: Object.freeze({ ...erasure }) } : {}),
      };
      if (current && same(current.identity, wanted)) {
        if (session.fenceToken !== wanted.fence || current.expiresAtDbMs <= now) return { ok: false, reason: "lost" };
        return { ok: true, fence: wanted.fence, proof: issueSessionLeaseProof(wanted) };
      }
      const owner = current && current.identity.bindingId === this.bindingId && current.expiresAtDbMs > now ? { ownerId: current.identity.runnerId, ownerAddr: current.identity.runnerAddr } : {};
      if (confirmOnly) return { ok: false, reason: "lost", ...owner };
      if (session.fenceToken !== input.expectedFence) return { ok: false, reason: "stale", ...owner };
      if (current && current.identity.bindingId === this.bindingId && current.expiresAtDbMs > now) {
        const localHandoff = erasure && previous && same(current.identity, previous) && previous.rootSessionId === input.sessionId
          && previous.fence === session.fenceToken && previous.runnerId === input.runnerId && previous.bootId === input.bootId
          && previous.principal.tenantId === input.principal.tenantId && previous.principal.userId === input.principal.userId;
        if (!localHandoff) return { ok: false, reason: "busy", ...owner };
      }
      sessionAuthorityNatural(wanted.fence, true); const expiry = now + input.ttlMs; sessionAuthorityNatural(expiry, true);
      this.port.handoff(session.id, wanted.fence, () => {
        this.tuples.set(session.id, { identity: Object.freeze(wanted), expiresAtDbMs: expiry }); session.fenceToken = wanted.fence;
      });
      return { ok: true, fence: wanted.fence, proof: issueSessionLeaseProof(wanted) };
    });
  }
  async renew(proof: SessionLeaseProof, ttlMs: number): Promise<boolean> {
    this.open(); const identity = captureSessionLeaseProof(proof); sessionAuthorityTtl(ttlMs);
    const session = this.port.session(identity.rootSessionId), current = this.tuples.get(identity.rootSessionId), now = this.now();
    if (identity.bindingId !== this.bindingId || !session || this.port.deleted(session.id) || session.fenceToken !== identity.fence || !current || !same(current.identity, identity) || current.expiresAtDbMs <= now) return false;
    try { if (identity.erasureAuthorization) this.port.erasureGate(identity.erasureAuthorization); else this.port.gate(identity.principal); } catch { return false; }
    const expiry = now + ttlMs; sessionAuthorityNatural(expiry, true); this.tuples.set(session.id, { identity: current.identity, expiresAtDbMs: expiry }); return true;
  }
  async release(proof: SessionLeaseProof): Promise<void> {
    this.open(); const identity = captureSessionLeaseProof(proof), current = this.tuples.get(identity.rootSessionId), session = this.port.session(identity.rootSessionId);
    if (identity.bindingId === this.bindingId && session?.fenceToken === identity.fence && current && same(current.identity, identity)) this.tuples.set(identity.rootSessionId, { identity: current.identity, expiresAtDbMs: 0 });
  }
  async getOwner(sessionId: string): Promise<SessionOwnerObservation | null> {
    this.open(); const current = this.tuples.get(sessionId), session = this.port.session(sessionId), now = this.now();
    if (!session || this.port.deleted(sessionId) || !current || current.identity.bindingId !== this.bindingId || current.expiresAtDbMs <= now || current.identity.fence !== session.fenceToken) return null;
    return Object.freeze({ ownerId: current.identity.runnerId, ownerAddr: current.identity.runnerAddr, fence: current.identity.fence,
      expiresAtDbMs: current.expiresAtDbMs, observedAtDbMs: now, authority: MEMORY_SESSION_AUTHORITY_PROTOCOL });
  }
  assertWrite(target: object, scope: { sessionId: string; fence: number }, explicitProof?: SessionLeaseProof): Readonly<SessionLeaseIdentity> {
    this.open(); const attached = captureSessionWriteAdmission(target);
    if (!attached || explicitProof !== undefined && attached !== explicitProof) return fail();
    const proof = explicitProof ?? attached, identity = captureSessionLeaseProof(proof);
    const session = this.port.session(identity.rootSessionId), current = this.tuples.get(identity.rootSessionId);
    if (identity.bindingId !== this.bindingId || !session || this.port.deleted(session.id) || !current || current.expiresAtDbMs <= this.now() || !same(current.identity, identity)
      || session.fenceToken !== identity.fence || scope.fence !== identity.fence || scope.sessionId !== identity.rootSessionId && !this.port.managed(scope.sessionId, identity.rootSessionId)) return conflict();
    this.port.gate(identity.principal); return identity;
  }
  assertErasureWrite(target: object, scope: { sessionId: string; fence: number }, authorization: ErasureWriteAuthorization): void {
    this.open(); const proof = captureSessionWriteAdmission(target); if (!proof) return fail(); const identity = captureSessionLeaseProof(proof), current = this.tuples.get(scope.sessionId), session = this.port.session(scope.sessionId);
    if (identity.bindingId !== this.bindingId || !identity.erasureAuthorization || (["tenantId", "userId", "requestId", "subjectGeneration", "claimToken", "claimAttempt"] as const).some(k => identity.erasureAuthorization![k] !== authorization[k])
      || identity.rootSessionId !== scope.sessionId || identity.fence !== scope.fence || session?.fenceToken !== identity.fence
      || !current || !same(current.identity, identity) || current.expiresAtDbMs <= this.now()) return conflict();
    this.port.erasureGate(authorization);
  }
  retire(sessionId: string) { const current = this.tuples.get(sessionId); if (current) this.tuples.set(sessionId, { identity: current.identity, expiresAtDbMs: 0 }); }
  async close(): Promise<void> { this.closed = true; }
}
