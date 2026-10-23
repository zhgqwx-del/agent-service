import { createHash } from "node:crypto";
import { Principal, isCanonicalId } from "@agent-service/protocol";
import { validateErasureWriteAuthorization, type ErasureWriteAuthorization } from "./subject-lifecycle.js";

export const MYSQL_SESSION_AUTHORITY_PROTOCOL = "mysql-live-session-v1" as const;
export const MEMORY_SESSION_AUTHORITY_PROTOCOL = "memory-live-session-v1" as const;
export type SessionAuthorityProtocol = typeof MYSQL_SESSION_AUTHORITY_PROTOCOL | typeof MEMORY_SESSION_AUTHORITY_PROTOCOL;
export class SessionAuthorityError extends Error {
  readonly code = "session_authority_unavailable";
  constructor() { super("Session authority is unavailable."); this.name = "SessionAuthorityError"; }
}
export class SessionAuthorityConflictError extends Error {
  readonly code = "session_lease_conflict";
  constructor() { super("Session authority changed."); this.name = "SessionAuthorityConflictError"; }
}
declare const commandBrand: unique symbol, proofBrand: unique symbol;
export interface SessionAcquireCommand { readonly [commandBrand]: true }
export interface SessionLeaseProof { readonly [proofBrand]: true }
export interface SessionAcquireInput {
  readonly sessionId: string; readonly principal: Principal;
  readonly runnerId: string; readonly runnerAddr: string; readonly bootId: string;
  readonly acquisitionId: string; readonly expectedFence: number; readonly ttlMs: number;
}
export interface SessionLeaseIdentity {
  readonly protocol: SessionAuthorityProtocol; readonly bindingId: string; readonly rootSessionId: string; readonly principal: Principal;
  readonly runnerId: string; readonly runnerAddr: string; readonly bootId: string;
  readonly acquisitionId: string; readonly fence: number; readonly sourceSha256: string;
  readonly erasureAuthorization?: Readonly<ErasureWriteAuthorization>;
}
export interface SessionAuthorityIdentity { readonly protocol: SessionAuthorityProtocol; readonly backend: "mysql" | "memory"; readonly namespaceSha256: string }
export interface SessionOwnerObservation {
  readonly ownerId: string; readonly ownerAddr: string; readonly fence: number;
  readonly expiresAtDbMs: number; readonly observedAtDbMs: number; readonly authority: SessionAuthorityProtocol;
}
export type SessionAcquireResult = { readonly ok: true; readonly fence: number; readonly proof: SessionLeaseProof }
  | { readonly ok: false; readonly reason: "busy" | "stale" | "lost"; readonly ownerId?: string; readonly ownerAddr?: string };
export interface SessionAuthority {
  identity(): Promise<SessionAuthorityIdentity>;
  acquire(command: SessionAcquireCommand): Promise<SessionAcquireResult>;
  /** Confirm the original fixed command only; never advances a fence or extends its expiry. */
  confirm(command: SessionAcquireCommand): Promise<SessionAcquireResult>;
  /** Existing erasure claim and the lease handoff linearize together, before local interruption. */
  acquireForErasure(command: SessionAcquireCommand, authorization: ErasureWriteAuthorization, predecessor?: SessionLeaseProof): Promise<SessionAcquireResult>;
  confirmForErasure(command: SessionAcquireCommand, authorization: ErasureWriteAuthorization, predecessor?: SessionLeaseProof): Promise<SessionAcquireResult>;
  renew(proof: SessionLeaseProof, ttlMs: number): Promise<boolean>;
  release(proof: SessionLeaseProof): Promise<void>;
  getOwner(sessionId: string): Promise<SessionOwnerObservation | null>;
  /** Stops only this facade; the owning SessionStore closes its shared native pool. */
  close(): Promise<void>;
}
const commands = new WeakMap<object, Readonly<SessionAcquireInput>>();
const sources = new WeakMap<object, string>();
const proofs = new WeakMap<object, Readonly<SessionLeaseIdentity>>();
const admissions = new WeakMap<object, { proof: SessionLeaseProof; digest: string }>();
function fail(): never { throw new SessionAuthorityError(); }
export function sessionAuthorityNatural(value: unknown, positive = false): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (positive ? 1 : 0)) fail();
}
export function sessionAuthorityTtl(value: unknown): asserts value is number {
  sessionAuthorityNatural(value, true); if (value > 2_147_483_647) fail();
}
function text(value: unknown, maximum: number): asserts value is string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > maximum
    || Buffer.from(value, "utf8").toString("utf8") !== value || /[\u0000-\u001f\u007f]/.test(value)) fail();
}
function uuid(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) fail();
}
function closed(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value), captured: Record<string, unknown> = {};
  if (Reflect.ownKeys(descriptors).length !== keys.length || Reflect.ownKeys(descriptors).some(k => typeof k !== "string" || !keys.includes(k))
    || Object.values(descriptors).some(d => !("value" in d) || !d.enumerable)) fail();
  for (const key of keys) captured[key] = descriptors[key]!.value;
  return Object.freeze(captured);
}
export function captureSessionErasureAuthorization(input: ErasureWriteAuthorization): Readonly<ErasureWriteAuthorization> {
  const value = closed(input, ["tenantId", "userId", "requestId", "subjectGeneration", "claimToken", "claimAttempt"]) as unknown as ErasureWriteAuthorization;
  validateErasureWriteAuthorization(value); return Object.freeze({ ...value });
}
/** The caller fixes this tuple before its first native mutation. It confers no write permission. */
export function createSessionAcquireCommand(input: SessionAcquireInput): SessionAcquireCommand {
  input = closed(input, ["sessionId", "principal", "runnerId", "runnerAddr", "bootId", "acquisitionId", "expectedFence", "ttlMs"]) as unknown as SessionAcquireInput;
  if (!isCanonicalId("sess", input.sessionId)) fail();
  const principal = Principal.parse(closed(input.principal, ["tenantId", "userId"]));
  text(input.runnerId, 128); text(input.runnerAddr, 2048); uuid(input.bootId); uuid(input.acquisitionId);
  sessionAuthorityNatural(input.expectedFence); sessionAuthorityTtl(input.ttlMs);
  const value = Object.freeze({ ...input, principal: Object.freeze({ ...principal }) });
  const command = Object.freeze({}) as SessionAcquireCommand; commands.set(command, value); return command;
}
/** Internal stores only; not re-exported by the public package entry. */
export function captureSessionAcquireCommand(command: SessionAcquireCommand): Readonly<SessionAcquireInput> {
  const result = command && typeof command === "object" ? commands.get(command) : undefined; return result ?? fail();
}
/** Bind the original command's authority source before any await; only its exact source retries. */
export function bindSessionAcquireSource(command: SessionAcquireCommand, erasure?: ErasureWriteAuthorization): string {
  const input = captureSessionAcquireCommand(command);
  if (erasure) validateErasureWriteAuthorization(erasure);
  const body = erasure ? ["session-acquire-source-v1", "erasure", erasure.tenantId, erasure.userId, erasure.requestId,
    erasure.subjectGeneration, createHash("sha256").update(erasure.claimToken, "utf8").digest("hex"), erasure.claimAttempt]
    : ["session-acquire-source-v1", "ordinary"];
  // Persisted commitment includes every fixed command field, not just claim/mode. Reconstructing
  // the same nonce with a changed TTL/predecessor/body cannot confirm an earlier command.
  const commandSource = ["session-acquire-command-source-v1", input.sessionId, input.principal.tenantId, input.principal.userId,
    input.runnerId, input.runnerAddr, input.bootId, input.acquisitionId, input.expectedFence, input.ttlMs, body];
  const hash = createHash("sha256").update(JSON.stringify(commandSource), "utf8").digest("hex"), previous = sources.get(command);
  if (previous !== undefined && previous !== hash) return fail(); sources.set(command, hash); return hash;
}
/** Internal issuer. The owning backend must not expose its result before a real COMMIT/confirmation. */
export function issueSessionLeaseProof(input: SessionLeaseIdentity): SessionLeaseProof {
  uuid(input.bindingId);
  if (!/^[a-f0-9]{64}$/.test(input.sourceSha256)) fail();
  const command = createSessionAcquireCommand({ sessionId: input.rootSessionId, principal: input.principal,
    runnerId: input.runnerId, runnerAddr: input.runnerAddr, bootId: input.bootId, acquisitionId: input.acquisitionId,
    expectedFence: input.fence - 1, ttlMs: 1 });
  captureSessionAcquireCommand(command); sessionAuthorityNatural(input.fence, true);
  if (input.protocol !== MYSQL_SESSION_AUTHORITY_PROTOCOL && input.protocol !== MEMORY_SESSION_AUTHORITY_PROTOCOL) fail();
  const value = Object.freeze({ ...input, principal: Object.freeze({ ...input.principal }),
    ...(input.erasureAuthorization ? { erasureAuthorization: Object.freeze({ ...input.erasureAuthorization }) } : {}) });
  const proof = Object.freeze({}) as SessionLeaseProof; proofs.set(proof, value); return proof;
}
/** Internal transaction validator, never a public JSON decoder. */
export function captureSessionLeaseProof(proof: SessionLeaseProof): Readonly<SessionLeaseIdentity> {
  const result = proof && typeof proof === "object" ? proofs.get(proof) : undefined; return result ?? fail();
}
export function sessionAcquisitionSha256(id: string): string { uuid(id); return createHash("sha256").update(id, "utf8").digest("hex"); }
function digest(value: unknown): string {
  const seen = new Set<object>();
  const normalize = (raw: unknown, arrayElement = false): unknown => {
    if (raw === undefined) return arrayElement ? null : undefined;
    if (raw === null || typeof raw === "string" || typeof raw === "boolean") return raw;
    if (typeof raw === "number") { if (!Number.isFinite(raw)) return fail(); return raw; }
    if (typeof raw !== "object" || seen.has(raw)) return fail();
    const isArray = Array.isArray(raw), descriptors = Object.getOwnPropertyDescriptors(raw);
    if (Object.getPrototypeOf(raw) !== (isArray ? Array.prototype : Object.prototype)
      || Reflect.ownKeys(descriptors).some(k => typeof k !== "string")
      || Object.values(descriptors).some(d => !("value" in d))) return fail();
    seen.add(raw);
    let result: unknown;
    if (isArray) {
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0
        || Object.keys(descriptors).some(k => k !== "length" && (!/^(0|[1-9][0-9]*)$/.test(k) || Number(k) >= length || !descriptors[k]!.enumerable))) return fail();
      const values: unknown[] = [];
      for (let i = 0; i < length; i++) values.push(normalize(descriptors[String(i)]?.value, true));
      result = values;
    } else result = Object.fromEntries(Object.keys(descriptors).filter(k => descriptors[k]!.enumerable).sort()
      .map(k => [k, normalize(descriptors[k]!.value)]).filter(([,v]) => v !== undefined));
    seen.delete(raw); return result;
  };
  const result = JSON.stringify(normalize(value)); if (result === undefined) return fail();
  return createHash("sha256").update(result).digest("hex");
}
/** Private metadata only: no added enumerable field, DTO, persisted hash, log or SSE identity. */
export function attachSessionWriteAdmission<T extends object>(target: T, proof: SessionLeaseProof): T {
  captureSessionLeaseProof(proof); const bodyDigest = digest(target), existing = admissions.get(target);
  if (existing) {
    if (existing.proof !== proof || existing.digest !== bodyDigest) fail();
    return target;
  }
  admissions.set(target, { proof, digest: bodyDigest }); return target;
}
/** Capture before the first await/clone; rejects later mutation of the original admission body. */
export function captureSessionWriteAdmission(target: object): SessionLeaseProof | undefined {
  const found = admissions.get(target); if (!found) return undefined;
  if (found.digest !== digest(target)) fail(); captureSessionLeaseProof(found.proof); return found.proof;
}
/** Backend/factory transfer only after independently validating the original source/body. */
export function transferSessionWriteAdmission(original: object, target: object): void {
  const proof = captureSessionWriteAdmission(original); if (proof) attachSessionWriteAdmission(target, proof);
}
