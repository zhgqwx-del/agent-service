import { randomUUID } from "node:crypto";
import { MemorySessionStore, attachSessionWriteAdmission, createSessionAcquireCommand,
  type CommitBatch, type SessionAcquireCommand, type SessionAcquireResult, type SessionAuthority,
  type SessionLeaseProof, type ErasureWriteAuthorization } from "@agent-service/store";
import { captureSessionAcquireCommand } from "../../store/src/session-authority.js";

interface OwnedClock { now(): number; advanceTo(after: number): void }
const clocks = new WeakMap<MemorySessionStore, OwnedClock>();
export function memoryAuthorityStore(): MemorySessionStore;
export function memoryAuthorityStore<T extends MemorySessionStore>(Ctor: new (clock: { now(): number }) => T): T;
export function memoryAuthorityStore(Ctor: new (clock: { now(): number }) => MemorySessionStore = MemorySessionStore): MemorySessionStore {
  let offset = 0;
  const clock: OwnedClock = { now: () => Date.now() + offset, advanceTo(after) { offset += Math.max(0, after - clock.now()); } };
  const store = new Ctor(clock); clocks.set(store, clock); return store;
}

/** Test-only controller around the owning store. It has no independent lease/authority state.
 * Runtime methods still call the original backend on the same facade; faults override only those
 * methods. Recorded opaque proofs are immutable observations keyed by exact session+fence.
 */
export class MemoryAuthorityFixture {
  private store?: MemorySessionStore;
  private original?: SessionAuthority;
  private liveFacade?: SessionAuthority;
  private readonly captured = new Map<string, SessionLeaseProof>();
  private readonly bootId = randomUUID();
  bind(store: MemorySessionStore): this {
    if (this.store && this.store !== store) throw Error("fixture_authority_already_bound");
    if (this.store) return this;
    if (!clocks.has(store)) throw Error("fixture_requires_owned_store_clock");
    this.store = store;
    const source = store.sessionAuthority;
    this.liveFacade = source;
    this.original = { identity: source.identity.bind(source), acquire: source.acquire.bind(source), confirm: source.confirm.bind(source),
      acquireForErasure: source.acquireForErasure.bind(source), confirmForErasure: source.confirmForErasure.bind(source),
      renew: source.renew.bind(source), release: source.release.bind(source), getOwner: source.getOwner.bind(source), close: source.close.bind(source) };
    Object.defineProperties(source, {
      acquire: { configurable: true, writable: true, value: (command: SessionAcquireCommand) => this.acquire(command) },
      renew: { configurable: true, writable: true, value: (proof: SessionLeaseProof, ttlMs: number) => this.renew(proof, ttlMs) },
      release: { configurable: true, writable: true, value: (proof: SessionLeaseProof) => this.release(proof) },
      getOwner: { configurable: true, writable: true, value: (sessionId: string) => this.getOwner(sessionId) },
    });
    return this;
  }
  get authority(): SessionAuthority { if (!this.liveFacade) throw Error("fixture_authority_not_bound"); return this.liveFacade; }
  private backend(): SessionAuthority { if (!this.original) throw Error("fixture_authority_not_bound"); return this.original; }
  private command(sessionId: string, ownerId: string, ownerAddr: string, ttlMs: number): SessionAcquireCommand {
    const session = this.store?.sessions.get(sessionId); if (!session) throw Error("fixture_session_absent");
    return createSessionAcquireCommand({ sessionId, principal: { tenantId: session.tenantId, userId: session.userId },
      runnerId: ownerId, runnerAddr: ownerAddr, bootId: this.bootId, acquisitionId: randomUUID(), expectedFence: session.fenceToken, ttlMs });
  }
  private remember(command: SessionAcquireCommand, result: SessionAcquireResult): SessionAcquireResult {
    if (result.ok) { const value = captureSessionAcquireCommand(command); this.captured.set(JSON.stringify([value.sessionId, result.fence]), result.proof); }
    return result;
  }
  async acquire(commandOrSession: SessionAcquireCommand | string, ownerId?: string, ownerAddr?: string, ttlMs?: number): Promise<SessionAcquireResult> {
    const command = typeof commandOrSession === "string" ? this.command(commandOrSession, ownerId!, ownerAddr!, ttlMs!) : commandOrSession;
    return this.remember(command, await this.backend().acquire(command));
  }
  async acquireForErasureSession(sessionId: string, ownerId: string, ownerAddr: string, ttlMs: number, authorization: ErasureWriteAuthorization) {
    const command = this.command(sessionId, ownerId, ownerAddr, ttlMs);
    return this.remember(command, await this.backend().acquireForErasure(command, authorization));
  }
  renew(proof: SessionLeaseProof, ttlMs: number): Promise<boolean> { return this.backend().renew(proof, ttlMs); }
  release(proof: SessionLeaseProof): Promise<void> { return this.backend().release(proof); }
  close(): Promise<void> { return this.backend().close(); }
  getOwner(sessionId: string) { return this.backend().getOwner(sessionId); }
  get fences() { return { get: (sessionId: string) => this.store?.sessions.get(sessionId)?.fenceToken }; }
  async expire(sessionId: string): Promise<void> {
    const owner = await this.backend().getOwner(sessionId);
    if (owner) clocks.get(this.store!)!.advanceTo(owner.expiresAtDbMs + 1);
  }
  proof(sessionId: string, fence: number): SessionLeaseProof {
    const result = this.captured.get(JSON.stringify([sessionId, fence])); if (!result) throw Error("fixture_exact_proof_absent"); return result;
  }
  admit(batch: CommitBatch): CommitBatch { return attachSessionWriteAdmission(batch, this.proof(batch.sessionId, batch.fence)); }
  async seed(batch: CommitBatch) {
    const acquired = await this.acquire(batch.sessionId, "fixture-seeder", "127.0.0.1:1", 30000);
    if (!acquired.ok) throw Error("fixture_seed_authority_busy");
    try { return await this.store!.commit(attachSessionWriteAdmission({ ...batch, fence: acquired.fence }, acquired.proof)); }
    finally { await this.backend().release(acquired.proof); }
  }
}
