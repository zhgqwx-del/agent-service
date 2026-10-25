import { createHash } from "node:crypto";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { isCanonicalId, type Principal } from "@agent-service/protocol";
import { bindMysqlOperationAbort } from "./operation-abort.js";
import type { ErasureWriteAuthorization } from "../subject-lifecycle.js";
import { MYSQL_SESSION_AUTHORITY_PROTOCOL, SessionAuthorityError, SessionAuthorityConflictError,
  captureSessionAcquireCommand, bindSessionAcquireSource, captureSessionErasureAuthorization, captureSessionLeaseProof, captureSessionWriteAdmission, issueSessionLeaseProof,
  sessionAcquisitionSha256, sessionAuthorityNatural, sessionAuthorityTtl,
  type SessionAuthority, type SessionAuthorityIdentity, type SessionAcquireCommand, type SessionAcquireInput,
  type SessionAcquireResult, type SessionLeaseProof, type SessionLeaseIdentity, type SessionOwnerObservation,
} from "../session-authority.js";

type Row = RowDataPacket & Record<string, unknown>;
export interface ActiveSessionAuthorityBinding {
  readonly bindingId: string; readonly serverUuid: string; readonly applicationDatabase: string;
  readonly accountsSha256: string;
}
export interface MysqlSessionAuthorityPort {
  /** Same transaction, current locking read; requires active control and actual DB identity. */
  binding(conn: PoolConnection, lock: boolean): Promise<ActiveSessionAuthorityBinding>;
  gate(conn: PoolConnection, principal: Principal, sessionId: string): Promise<void>;
  erasureGate(conn: PoolConnection, authorization: ErasureWriteAuthorization): Promise<void>;
  /** Preserve root->family repair context while the callback advances the canonical row once. */
  handoff(conn: PoolConnection, sessionId: string, newFence: number, writeLease: () => Promise<void>): Promise<void>;
  /** Existing managed-root writer context, same TX. Only the caller's fixed expiry UPDATE is run. */
  expiryMutation(conn: PoolConnection, sessionId: string, fence: number, updateExpiry: () => Promise<void>): Promise<void>;
}
const COLUMNS = "session_id,tenant_id,user_id,fence_token,deleted_at_ms,authority_binding_id,authority_runner_id,authority_runner_addr,authority_boot_id,authority_acquisition_sha256,authority_source_sha256,authority_expires_at_db_ms";
const TUPLE = ["authority_binding_id", "authority_runner_id", "authority_runner_addr", "authority_boot_id", "authority_acquisition_sha256", "authority_source_sha256", "authority_expires_at_db_ms"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function unavailable(): never { throw new SessionAuthorityError(); }
function conflict(): never { throw new SessionAuthorityConflictError(); }
function safe(value: unknown): number { const number = Number(value); sessionAuthorityNatural(number); return number; }
interface LeaseTuple { readonly bindingId: string; readonly runnerId: string; readonly runnerAddr: string; readonly bootId: string; readonly acquisitionSha256: string; readonly sourceSha256: string; readonly expiresAtDbMs: number }
function tuple(row: Row): LeaseTuple | undefined {
  const values = TUPLE.map(k => row[k]);
  if (values.every(v => v === null)) return undefined;
  if (values.some(v => v === null || v === undefined)) return unavailable();
  const bindingId = row.authority_binding_id, runnerId = row.authority_runner_id, runnerAddr = row.authority_runner_addr,
    bootId = row.authority_boot_id, acquisitionSha256 = row.authority_acquisition_sha256, sourceSha256 = row.authority_source_sha256;
  if (typeof bindingId !== "string" || !UUID.test(bindingId) || typeof bootId !== "string" || !UUID.test(bootId)
    || typeof runnerId !== "string" || !runnerId || Buffer.byteLength(runnerId) > 128
    || typeof runnerAddr !== "string" || !runnerAddr || Buffer.byteLength(runnerAddr) > 2048
    || typeof acquisitionSha256 !== "string" || !/^[a-f0-9]{64}$/.test(acquisitionSha256)
    || typeof sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(sourceSha256)) return unavailable();
  return { bindingId, runnerId, runnerAddr, bootId, acquisitionSha256, sourceSha256, expiresAtDbMs: safe(row.authority_expires_at_db_ms) };
}
/** Every call follows the relevant row locks. SET timestamp is reset on every actual checkout. */
export async function sessionAuthorityDatabaseNow(conn: Pick<PoolConnection, "query">): Promise<number> {
  const [rows] = await conn.query<Row[]>("SELECT CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED) AS now_ms");
  if (rows.length !== 1) return unavailable(); return safe(rows[0]!.now_ms);
}
function sameCommand(current: LeaseTuple, input: Readonly<SessionAcquireInput>, binding: ActiveSessionAuthorityBinding, sourceSha256: string): boolean {
  return current.sourceSha256 === sourceSha256 && current.bindingId === binding.bindingId && current.runnerId === input.runnerId && current.runnerAddr === input.runnerAddr
    && current.bootId === input.bootId && current.acquisitionSha256 === sessionAcquisitionSha256(input.acquisitionId);
}
function sameProof(current: LeaseTuple, proof: Readonly<SessionLeaseIdentity>, binding: ActiveSessionAuthorityBinding): boolean {
  return proof.protocol === MYSQL_SESSION_AUTHORITY_PROTOCOL && proof.sourceSha256 === current.sourceSha256 && current.bindingId === binding.bindingId && proof.bindingId === binding.bindingId
    && current.runnerId === proof.runnerId && current.runnerAddr === proof.runnerAddr && current.bootId === proof.bootId
    && current.acquisitionSha256 === sessionAcquisitionSha256(proof.acquisitionId);
}
function foundOwner(current: LeaseTuple | undefined, now: number, binding: ActiveSessionAuthorityBinding): { ownerId?: string; ownerAddr?: string } {
  return current && current.bindingId === binding.bindingId && current.expiresAtDbMs > now ? { ownerId: current.runnerId, ownerAddr: current.runnerAddr } : {};
}

/** Default ownership needs no permanently retained abort-connection registry. */
export function ownSessionAuthorityMysqlTransport(pool: Pool, transport: { close(): void }, signal?: AbortSignal): { close(): Promise<void> } {
  if (signal !== undefined) return bindMysqlOperationAbort(pool, signal, transport);
  let closing: Promise<void> | undefined;
  return { close: () => closing ??= (async () => {
    let failed = false, firstError: unknown;
    try { await pool.end(); } catch (error) { failed = true; firstError = error; }
    try { transport.close(); } catch (error) { if (!failed) { failed = true; firstError = error; } }
    if (failed) throw firstError;
    // The Store owns transport.settled() after this scope. close(void) is not join.
  })() };
}

/** A rejected rollback is not evidence that this native transaction is clean. */
export async function rollbackSessionAuthorityTransaction(conn: PoolConnection): Promise<boolean> {
  try { await conn.rollback(); return true; }
  catch {
    // mysql2 destroy is synchronous and is NOT a native-close promise. The Store's
    // transport owner must still join the actual socket at its final close barrier.
    try { conn.destroy(); } catch { /* the original operation remains the first error */ }
    return false;
  }
}
export function releaseSessionAuthorityConnection(conn: PoolConnection, reusable: boolean, operationFailed: boolean): void {
  if (!reusable) return;
  try { conn.release(); }
  catch (error) {
    try { conn.destroy(); } catch { /* preserve the first error, including undefined */ }
    if (!operationFailed) throw error;
  }
}

export class MysqlSessionAuthority implements SessionAuthority {
  private closed = false;
  private closing?: Promise<void>;
  private readonly owned = new Set<Promise<unknown>>();
  private own<T>(task: Promise<T>): Promise<T> {
    this.owned.add(task); void task.then(() => this.owned.delete(task), () => this.owned.delete(task)); return task;
  }
  constructor(private readonly pool: Pool, private readonly port: MysqlSessionAuthorityPort) {}
  private assertOpen() { if (this.closed) unavailable(); }
  private transaction<T>(work: (conn: PoolConnection) => Promise<T>): Promise<T> {
    this.assertOpen(); return this.own((async () => {
      const conn = await this.pool.getConnection(); let reusable = true, operationFailed = false;
      try { this.assertOpen(); await conn.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"); await conn.beginTransaction();
        this.assertOpen(); const result = await work(conn); this.assertOpen(); await conn.commit(); this.assertOpen(); return result;
      } catch (error) { operationFailed = true; reusable = await rollbackSessionAuthorityTransaction(conn); throw error; }
      finally { releaseSessionAuthorityConnection(conn, reusable, operationFailed); }
    })());
  }
  private async lock(conn: PoolConnection, sessionId: string, principal?: Principal): Promise<Row> {
    const [rows] = await conn.query<Row[]>(`SELECT ${COLUMNS} FROM sessions WHERE session_id=? AND BINARY session_id=BINARY ? FOR UPDATE`, [sessionId, sessionId]);
    const row = rows[0]; if (rows.length !== 1 || !row || principal && (row.tenant_id !== principal.tenantId || row.user_id !== principal.userId)) return conflict();
    safe(row.fence_token); tuple(row); return row;
  }
  async identity(): Promise<SessionAuthorityIdentity> {
    this.assertOpen(); return this.own((async () => {
      const conn = await this.pool.getConnection(); let operationFailed = false;
      try { this.assertOpen(); const binding = await this.port.binding(conn, false); this.assertOpen();
        return Object.freeze({ protocol: MYSQL_SESSION_AUTHORITY_PROTOCOL, backend: "mysql" as const,
          namespaceSha256: createHash("sha256").update(JSON.stringify([MYSQL_SESSION_AUTHORITY_PROTOCOL, binding.serverUuid, binding.applicationDatabase, binding.bindingId, binding.accountsSha256])).digest("hex") });
      } catch (error) { operationFailed = true; throw error; }
      finally { releaseSessionAuthorityConnection(conn, true, operationFailed); }
    })());
  }
  async acquire(command: SessionAcquireCommand) { return this.acquireInner(command, false); }
  async confirm(command: SessionAcquireCommand) { return this.acquireInner(command, true); }
  async acquireForErasure(command: SessionAcquireCommand, authorization: ErasureWriteAuthorization, predecessor?: SessionLeaseProof) {
    return this.acquireInner(command, false, captureSessionErasureAuthorization(authorization), predecessor);
  }
  async confirmForErasure(command: SessionAcquireCommand, authorization: ErasureWriteAuthorization, predecessor?: SessionLeaseProof) {
    return this.acquireInner(command, true, captureSessionErasureAuthorization(authorization), predecessor);
  }
  private acquireInner(command: SessionAcquireCommand, confirmOnly: boolean, erasure?: ErasureWriteAuthorization, predecessor?: SessionLeaseProof): Promise<SessionAcquireResult> {
    // Capture the original pre-fixed command synchronously; do not refresh its predecessor/nonce.
    const input = captureSessionAcquireCommand(command), sourceSha256 = bindSessionAcquireSource(command, erasure), previous = predecessor === undefined ? undefined : captureSessionLeaseProof(predecessor);
    if (erasure && (erasure.tenantId !== input.principal.tenantId || erasure.userId !== input.principal.userId)) return Promise.reject(new SessionAuthorityConflictError());
    return this.transaction<SessionAcquireResult>(async conn => {
      const row = await this.lock(conn, input.sessionId, input.principal);
      const [members] = await conn.query<Row[]>("SELECT task_id FROM subagent_tasks WHERE child_session_id=? AND BINARY child_session_id=BINARY ? FOR SHARE", [input.sessionId, input.sessionId]);
      if (members.length) return conflict(); // A managed child never owns an independent lease.
      if (row.deleted_at_ms !== null) return conflict();
      if (erasure) await this.port.erasureGate(conn, erasure);
      else await this.port.gate(conn, input.principal, input.sessionId);
      const binding = await this.port.binding(conn, true), now = await sessionAuthorityDatabaseNow(conn), current = tuple(row), fence = safe(row.fence_token);
      if (current && sameCommand(current, input, binding, sourceSha256)) {
        if (fence !== input.expectedFence + 1 || current.expiresAtDbMs <= now) return { ok: false, reason: "lost" };
        return { ok: true, fence, proof: issueSessionLeaseProof({ protocol: MYSQL_SESSION_AUTHORITY_PROTOCOL, bindingId: binding.bindingId,
          rootSessionId: input.sessionId, principal: input.principal, runnerId: input.runnerId, runnerAddr: input.runnerAddr,
          bootId: input.bootId, acquisitionId: input.acquisitionId, sourceSha256, fence, ...(erasure ? { erasureAuthorization: erasure } : {}) }) };
      }
      if (confirmOnly) return { ok: false, reason: "lost", ...foundOwner(current, now, binding) };
      if (fence !== input.expectedFence) return { ok: false, reason: "stale", ...foundOwner(current, now, binding) };
      if (current && current.bindingId === binding.bindingId && current.expiresAtDbMs > now) {
        const localHandoff = erasure && previous && sameProof(current, previous, binding) && previous.rootSessionId === input.sessionId
          && previous.fence === fence && previous.runnerId === input.runnerId && previous.bootId === input.bootId
          && previous.principal.tenantId === input.principal.tenantId && previous.principal.userId === input.principal.userId;
        if (!localHandoff) return { ok: false, reason: "busy", ...foundOwner(current, now, binding) };
      }
      const next = fence + 1; sessionAuthorityNatural(next, true);
      await this.port.handoff(conn, input.sessionId, next, async () => {
        const finalNow = await sessionAuthorityDatabaseNow(conn), expiry = finalNow + input.ttlMs;
        sessionAuthorityNatural(expiry, true);
        await conn.query(`UPDATE sessions SET fence_token=?,authority_binding_id=?,authority_runner_id=?,authority_runner_addr=?,authority_boot_id=?,authority_acquisition_sha256=?,authority_source_sha256=?,authority_expires_at_db_ms=? WHERE session_id=? AND fence_token=?`,
          [next, binding.bindingId, input.runnerId, input.runnerAddr, input.bootId, sessionAcquisitionSha256(input.acquisitionId), sourceSha256, expiry, input.sessionId, fence]);
      });
      // transaction() must really COMMIT before the caller sees this proof.
      return { ok: true, fence: next, proof: issueSessionLeaseProof({ protocol: MYSQL_SESSION_AUTHORITY_PROTOCOL, bindingId: binding.bindingId,
        rootSessionId: input.sessionId, principal: input.principal, runnerId: input.runnerId, runnerAddr: input.runnerAddr,
        bootId: input.bootId, acquisitionId: input.acquisitionId, sourceSha256, fence: next, ...(erasure ? { erasureAuthorization: erasure } : {}) }) };
    });
  }
  async renew(proof: SessionLeaseProof, ttlMs: number): Promise<boolean> {
    const identity = captureSessionLeaseProof(proof); sessionAuthorityTtl(ttlMs);
    return this.transaction(async conn => {
      const row = await this.lock(conn, identity.rootSessionId, identity.principal), binding = await this.port.binding(conn, true), now = await sessionAuthorityDatabaseNow(conn), current = tuple(row);
      if (row.deleted_at_ms !== null || !current || !sameProof(current, identity, binding) || safe(row.fence_token) !== identity.fence || current.expiresAtDbMs <= now) return false;
      // Subject/T1 may close renewal too. An already-lost local guard never revives from this result.
      try {
        if (identity.erasureAuthorization) await this.port.erasureGate(conn, identity.erasureAuthorization);
        else await this.port.gate(conn, identity.principal, identity.rootSessionId);
      } catch { return false; }
      let renewed = false;
      await this.port.expiryMutation(conn, identity.rootSessionId, identity.fence, async () => {
        // Context acquisition may itself wait. Recheck time after every required root/family lock.
        const finalNow = await sessionAuthorityDatabaseNow(conn); if (current.expiresAtDbMs <= finalNow) return;
        const expiry = finalNow + ttlMs; sessionAuthorityNatural(expiry, true);
        await conn.query("UPDATE sessions SET authority_expires_at_db_ms=? WHERE session_id=?", [expiry, identity.rootSessionId]); renewed = true;
      });
      return renewed;
    });
  }
  async release(proof: SessionLeaseProof): Promise<void> {
    const identity = captureSessionLeaseProof(proof);
    return this.transaction(async conn => {
      const row = await this.lock(conn, identity.rootSessionId, identity.principal), binding = await this.port.binding(conn, true), current = tuple(row);
      if (!current || !sameProof(current, identity, binding) || safe(row.fence_token) !== identity.fence) return;
      await this.port.expiryMutation(conn, identity.rootSessionId, identity.fence, async () => {
        await conn.query("UPDATE sessions SET authority_expires_at_db_ms=0 WHERE session_id=?", [identity.rootSessionId]);
      });
    });
  }
  async getOwner(sessionId: string): Promise<SessionOwnerObservation | null> {
    if (!isCanonicalId("sess", sessionId)) return unavailable();
    return this.transaction(async conn => {
      const [rows] = await conn.query<Row[]>(`SELECT ${COLUMNS} FROM sessions WHERE session_id=? AND BINARY session_id=BINARY ? FOR SHARE`, [sessionId, sessionId]);
      const binding = await this.port.binding(conn, true), now = await sessionAuthorityDatabaseNow(conn), row = rows[0];
      if (!row || row.deleted_at_ms !== null) return null; const current = tuple(row);
      if (!current || current.bindingId !== binding.bindingId || current.expiresAtDbMs <= now) return null;
      return Object.freeze({ ownerId: current.runnerId, ownerAddr: current.runnerAddr, fence: safe(row.fence_token), expiresAtDbMs: current.expiresAtDbMs,
        observedAtDbMs: now, authority: MYSQL_SESSION_AUTHORITY_PROTOCOL });
    });
  }
  /** Called in the existing transaction BEFORE a child/Blob/webhook row can be locked or changed. */
  async assertWrite(conn: PoolConnection, target: object, scope: { sessionId: string; fence: number }, explicitProof?: SessionLeaseProof): Promise<SessionLeaseProof> {
    this.assertOpen(); const attached = captureSessionWriteAdmission(target);
    if (!attached || explicitProof !== undefined && attached !== explicitProof) return unavailable();
    const proof = explicitProof ?? attached;
    const identity = captureSessionLeaseProof(proof), row = await this.lock(conn, identity.rootSessionId, identity.principal);
    const binding = await this.port.binding(conn, true), current = tuple(row);
    if (!current || row.deleted_at_ms !== null || identity.fence !== scope.fence || safe(row.fence_token) !== identity.fence || !sameProof(current, identity, binding)) return conflict();
    await this.port.gate(conn, identity.principal, identity.rootSessionId);
    if (scope.sessionId !== identity.rootSessionId) {
      const [members] = await conn.query<Row[]>(`SELECT t.task_id FROM subagent_tasks t JOIN subagent_root_turns r ON r.root_key=t.root_key AND BINARY r.root_key=BINARY t.root_key
        WHERE t.child_session_id=? AND BINARY t.child_session_id=BINARY ? AND r.root_session_id=? AND BINARY r.root_session_id=BINARY ?
          AND r.tenant_id=? AND r.user_id=? FOR SHARE`, [scope.sessionId, scope.sessionId, identity.rootSessionId, identity.rootSessionId, identity.principal.tenantId, identity.principal.userId]);
      if (members.length !== 1) return conflict();
    }
    const now = await sessionAuthorityDatabaseNow(conn); if (current.expiresAtDbMs <= now) return conflict();
    return proof;
  }
  /** Erasure does not reopen the ordinary subject gate; the exact independent claim is mandatory. */
  async assertErasureWrite(conn: PoolConnection, target: object, scope: { sessionId: string; fence: number }, authorization: ErasureWriteAuthorization): Promise<void> {
    this.assertOpen(); const proof = captureSessionWriteAdmission(target); if (!proof) return unavailable();
    const identity = captureSessionLeaseProof(proof); if (!identity.erasureAuthorization
      || (["tenantId", "userId", "requestId", "subjectGeneration", "claimToken", "claimAttempt"] as const)
        .some(key => identity.erasureAuthorization![key] !== authorization[key])
      || identity.rootSessionId !== scope.sessionId || identity.fence !== scope.fence
      || identity.principal.tenantId !== authorization.tenantId || identity.principal.userId !== authorization.userId) return conflict();
    const row = await this.lock(conn, scope.sessionId, identity.principal); await this.port.erasureGate(conn, authorization);
    const binding = await this.port.binding(conn, true), current = tuple(row), now = await sessionAuthorityDatabaseNow(conn);
    if (!current || !sameProof(current, identity, binding) || safe(row.fence_token) !== identity.fence || current.expiresAtDbMs <= now) return conflict();
  }
  /** Runtime tuple retirement is part of the caller's already-authorized tombstone transaction. */
  async retireForTombstone(conn: PoolConnection, sessionId: string): Promise<void> {
    await conn.query("UPDATE sessions SET authority_expires_at_db_ms=IF(authority_expires_at_db_ms IS NULL,NULL,0) WHERE session_id=?", [sessionId]);
  }
  close(): Promise<void> {
    this.closed = true;
    return this.closing ??= (async () => { while (this.owned.size) await Promise.allSettled([...this.owned]); })();
  }
}

/** Every actual checkout is admitted, including Pool.query/execute shortcuts. No shared pool end. */
export function installSessionAuthorityPoolGuard(pool: Pool, check: (connection: PoolConnection) => Promise<void>): void {
  const get = pool.getConnection.bind(pool);
  pool.getConnection = async () => {
    const conn = await get();
    try {
      // MySQL timestamp DEFAULT means current time on each access, NOT literal zero.
      await conn.query("SET SESSION timestamp=DEFAULT"); await check(conn); return conn;
    } catch (error) { try { conn.destroy(); } catch { /* preserve native admission failure */ } throw error; }
  };
  pool.query = (async (sql: unknown, values?: unknown) => {
    const conn = await pool.getConnection(); let operationFailed = false;
    try { return await (conn.query as (sql: unknown, values?: unknown) => Promise<unknown>)(sql, values); }
    catch (error) { operationFailed = true; throw error; }
    finally { releaseSessionAuthorityConnection(conn, true, operationFailed); }
  }) as typeof pool.query;
  pool.execute = (async (sql: unknown, values?: unknown) => {
    const conn = await pool.getConnection(); let operationFailed = false;
    try { return await (conn.execute as (sql: unknown, values?: unknown) => Promise<unknown>)(sql, values); }
    catch (error) { operationFailed = true; throw error; }
    finally { releaseSessionAuthorityConnection(conn, true, operationFailed); }
  }) as typeof pool.execute;
}
