import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import mysql, { type Pool, type PoolConnection, type RowDataPacket } from "mysql2/promise";
import type { AgentDefinition, ApiKeyScope, Approval, Item, PersistedEvent, ProviderConfig, Session, TenantAuthPolicy, Turn, UsageQuery } from "@agent-service/protocol";
import { DEFAULT_AUTH_POLICY, DEFAULT_SCOPES, isCanonicalId } from "@agent-service/protocol";
import {
  FenceError,
  IdempotencyMismatchError,
  IdempotencyPendingError,
  IdempotencyReplayError,
  SessionArchivedError,
  SessionExistsError,
  SessionGoneError,
  SessionHasChildrenError,
  SessionLifecycleBusyError,
  SessionVersionError,
  assertPureFenceClaim,
  assertCommitResourceOwnership,
  assertTombstoneEvent,
  assignItemSeqs,
  assignTurnSeqEnd,
  backfillAssignedSequences,
  type ApiKeyRecord,
  type CommitBatch,
  type CommitResult,
  type IdempotencyReceipt,
  type IdempotencyScope,
  type LifecycleOutboxRecord,
  type LifecycleOutboxStore,
  type Page,
  type SessionStore,
  type SessionLifecycleRecord,
  type TenantRecord,
} from "../types.js";
import {
  BLOB_STORAGE_FORMAT,
  BlobStateError,
  assertBlobBindingsMatch,
  isUnexpiredStagingBlob,
  sanitizeBlobDeleteError,
  validateBlobDeleteAck,
  validateBlobDeleteClaim,
  type BlobCleanupStore,
  type BlobBinding,
  type BindableBlobLookup,
  type BlobDeleteOutboxRecord,
  type BlobManifest,
  type BlobManifestStore,
  type ClaimBlobDeletesOptions,
  type MarkBlobUploadedInput,
  type ReadyBlobLookup,
  type RetryBlobDeleteOptions,
  type ScheduleStaleBlobsOptions,
  type StageBlobInput,
} from "../blob-lifecycle.js";
import { validateBlobKey } from "../blob/key.js";
import {
  assertLifecycleOutboxId,
  parseLifecycleOutboxEnvelope,
  sanitizeLifecycleOutboxError,
  validateClaimLifecycleOutboxOptions,
  validateLifecycleOutboxAck,
  validateRenewLifecycleOutboxClaim,
  validateRetryLifecycleOutboxOptions,
} from "../lifecycle-outbox.js";

type Row = RowDataPacket;
const json = (v: unknown) => JSON.stringify(v);
const parse = <T>(v: unknown): T => (typeof v === "string" ? JSON.parse(v) : (v as T));
const BLOB_COLUMNS = `blob_id, tenant_id, user_id, session_id, item_id, purpose, storage_backend,
  storage_format, storage_key, upload_token, state, sha256, size_bytes, content_type,
  uploaded_at_ms, ready_at_ms, staging_expires_at_ms, delete_after_ms, deleted_at_ms,
  deletion_generation, created_at_ms`;
const QUALIFIED_BLOB_COLUMNS = `b.blob_id, b.tenant_id, b.user_id, b.session_id, b.item_id, b.purpose,
  b.storage_backend, b.storage_format, b.storage_key, b.upload_token, b.state, b.sha256, b.size_bytes,
  b.content_type, b.uploaded_at_ms, b.ready_at_ms, b.staging_expires_at_ms, b.delete_after_ms,
  b.deleted_at_ms, b.deletion_generation, b.created_at_ms`;
const BLOB_DELETE_COLUMNS = `o.outbox_id, o.blob_id, o.generation, o.available_at_ms, o.attempts,
  o.claim_token, o.lease_until_ms, o.last_error, o.completed_at_ms, o.dead_lettered_at_ms, o.created_at_ms,
  b.storage_backend, b.storage_format, b.storage_key, b.upload_token, b.state, b.deletion_generation`;

interface ExistingCommitResources {
  itemIds: Set<string>;
  turnIds: Set<string>;
  approvalIds: Set<string>;
}

/** Serialize a Session row. The projection columns are the source for filtering; `body` holds the rest. */
function rowToSession(r: Row): Session {
  return {
    id: r.session_id,
    tenantId: r.tenant_id,
    userId: r.user_id,
    agentId: r.agent_id,
    agentVersion: r.agent_version,
    status: parse(r.status),
    title: r.title ?? undefined,
    parentSessionId: r.parent_session_id ?? undefined,
    lastSeq: Number(r.last_seq),
    fenceToken: Number(r.fence_token),
    contextEpoch: r.context_epoch,
    usage: parse(r.usage_json),
    autoApprovedTools: r.auto_approved_tools == null ? [] : parse(r.auto_approved_tools),
    lastCompactionSeq: r.last_compaction_seq == null ? undefined : Number(r.last_compaction_seq),
    metadata: parse(r.metadata),
    createdAtMs: Number(r.created_at_ms),
    updatedAtMs: Number(r.updated_at_ms),
    archivedAtMs: r.archived_at_ms == null ? undefined : Number(r.archived_at_ms),
  };
}

function rowToLifecycleOutbox(row: Row): LifecycleOutboxRecord {
  const outboxId = Number(row.outbox_id);
  assertLifecycleOutboxId(outboxId);
  const generation = Number(row.generation);
  const aggregateId = String(row.aggregate_id);
  const envelope = parseLifecycleOutboxEnvelope(row.topic, parse(row.payload));
  if (envelope.payload.sessionId !== aggregateId || envelope.payload.deletionGeneration !== generation) {
    throw new Error(`lifecycle outbox ${outboxId} payload does not match its durable identity`);
  }
  return {
    outboxId,
    aggregateId,
    generation,
    ...envelope,
    ...(row.available_at_ms == null ? {} : { availableAtMs: Number(row.available_at_ms) }),
    attempts: Number(row.attempts),
    ...(row.claim_token == null ? {} : { claimToken: String(row.claim_token) }),
    ...(row.lease_until_ms == null ? {} : { leaseUntilMs: Number(row.lease_until_ms) }),
    ...(row.last_error == null ? {} : { lastError: String(row.last_error) }),
    ...(row.completed_at_ms == null ? {} : { completedAtMs: Number(row.completed_at_ms) }),
    ...(row.dead_lettered_at_ms == null ? {} : { deadLetteredAtMs: Number(row.dead_lettered_at_ms) }),
    createdAtMs: Number(row.created_at_ms),
  } as LifecycleOutboxRecord;
}

function rowToBlobManifest(row: Row): BlobManifest {
  const sha = row.sha256 == null ? undefined : Buffer.from(row.sha256).toString("hex");
  return {
    blobId: String(row.blob_id),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    sessionId: String(row.session_id),
    ...(row.item_id == null ? {} : { itemId: String(row.item_id) }),
    purpose: row.purpose,
    storageBackend: String(row.storage_backend),
    storageFormat: String(row.storage_format),
    storageKey: String(row.storage_key),
    uploadToken: String(row.upload_token),
    state: row.state,
    ...(sha === undefined ? {} : { sha256: sha }),
    ...(row.size_bytes == null ? {} : { sizeBytes: Number(row.size_bytes) }),
    ...(row.content_type == null ? {} : { contentType: String(row.content_type) }),
    ...(row.uploaded_at_ms == null ? {} : { uploadedAtMs: Number(row.uploaded_at_ms) }),
    ...(row.ready_at_ms == null ? {} : { readyAtMs: Number(row.ready_at_ms) }),
    ...(row.staging_expires_at_ms == null ? {} : { stagingExpiresAtMs: Number(row.staging_expires_at_ms) }),
    ...(row.delete_after_ms == null ? {} : { deleteAfterMs: Number(row.delete_after_ms) }),
    ...(row.deleted_at_ms == null ? {} : { deletedAtMs: Number(row.deleted_at_ms) }),
    deletionGeneration: Number(row.deletion_generation),
    createdAtMs: Number(row.created_at_ms),
  } as BlobManifest;
}

function validateStageBlobInput(input: StageBlobInput): void {
  if (!isCanonicalId("sess", input.sessionId) || !isCanonicalId("blob", input.blobId)) {
    throw new Error("invalid blob manifest identity");
  }
  validateBlobKey(input.storageKey);
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(input.storageBackend)) throw new Error("invalid blob storage backend");
  if (input.storageFormat !== BLOB_STORAGE_FORMAT) throw new Error("unsupported blob storage format");
  if (!/^[a-z0-9-]{16,64}$/.test(input.uploadToken)) throw new Error("invalid blob upload token");
  if (!Number.isSafeInteger(input.fence) || input.fence < 0) throw new Error("invalid blob fence");
  if (!Number.isSafeInteger(input.createdAtMs) || input.createdAtMs < 0) throw new Error("invalid blob creation timestamp");
  if (!Number.isSafeInteger(input.stagingExpiresAtMs) || input.stagingExpiresAtMs <= input.createdAtMs) {
    throw new Error("blob staging expiry must be after creation");
  }
}

function validateUploadedBlobInput(input: MarkBlobUploadedInput): void {
  if (!isCanonicalId("sess", input.sessionId) || !isCanonicalId("blob", input.blobId)) {
    throw new Error("invalid blob manifest identity");
  }
  if (!/^[a-z0-9-]{16,64}$/.test(input.uploadToken)) throw new Error("invalid blob upload token");
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) throw new Error("invalid blob sha256");
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) throw new Error("invalid blob size");
  if (!Number.isSafeInteger(input.uploadedAtMs) || input.uploadedAtMs < 0) throw new Error("invalid blob upload timestamp");
  if (!Number.isSafeInteger(input.fence) || input.fence < 0) throw new Error("invalid blob fence");
}

function rowToBlobDeleteOutbox(row: Row, requirePending = true): BlobDeleteOutboxRecord {
  const outboxId = Number(row.outbox_id);
  const generation = Number(row.generation);
  if (!Number.isSafeInteger(outboxId) || outboxId < 1) throw new Error("invalid blob delete outbox id");
  if (
    Number(row.deletion_generation) !== generation
    || (requirePending ? row.state !== "delete_pending" : row.state !== "delete_pending" && row.state !== "deleted")
  ) {
    throw new Error(`blob delete outbox ${outboxId} does not match its manifest state`);
  }
  const uploadToken = String(row.upload_token);
  if (!uploadToken) throw new Error(`blob delete outbox ${outboxId} has no upload token`);
  return {
    outboxId,
    blobId: String(row.blob_id),
    generation,
    storageBackend: String(row.storage_backend),
    storageFormat: String(row.storage_format),
    storageKey: String(row.storage_key),
    uploadToken,
    availableAtMs: Number(row.available_at_ms),
    attempts: Number(row.attempts),
    ...(row.claim_token == null ? {} : { claimToken: String(row.claim_token) }),
    ...(row.lease_until_ms == null ? {} : { leaseUntilMs: Number(row.lease_until_ms) }),
    ...(row.last_error == null ? {} : { lastError: String(row.last_error) }),
    ...(row.completed_at_ms == null ? {} : { completedAtMs: Number(row.completed_at_ms) }),
    ...(row.dead_lettered_at_ms == null ? {} : { deadLetteredAtMs: Number(row.dead_lettered_at_ms) }),
    createdAtMs: Number(row.created_at_ms),
  };
}

export interface MysqlStoreOptions {
  url: string;
  connectionLimit?: number;
  /** overrides migration discovery; useful in tests and unusual deployments */
  migrationsDir?: string;
  /** maximum time to wait for another runner to finish schema migration */
  migrationLockTimeoutSeconds?: number;
}

export class MysqlSessionStore implements SessionStore, LifecycleOutboxStore, BlobManifestStore, BlobCleanupStore {
  private constructor(private readonly pool: Pool) {}

  /**
   * Find the .sql migrations. The layout differs between running from source (package root) and from a
   * bundle (copied next to main.js), so try both plus an explicit override.
   */
  private static async resolveMigrationsDir(explicit?: string): Promise<string> {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      explicit,
      process.env.AGENT_SERVICE_MIGRATIONS_DIR,
      join(here, "migrations"), // bundled: dist/main.js + dist/migrations
      join(here, "..", "..", "migrations"), // source: packages/store/src/mysql -> packages/store/migrations
    ].filter((v): v is string => !!v);
    for (const dir of candidates) {
      try {
        const files = await readdir(dir);
        if (files.some((f) => f.endsWith(".sql"))) return dir;
      } catch {
        /* try the next candidate */
      }
    }
    throw new Error(`could not locate migrations; tried: ${candidates.join(", ")}`);
  }

  static async connect(opts: MysqlStoreOptions): Promise<MysqlSessionStore> {
    const pool = mysql.createPool({
      uri: opts.url,
      connectionLimit: opts.connectionLimit ?? 20,
      supportBigNumbers: true,
      bigNumberStrings: false,
      namedPlaceholders: false,
      timezone: "Z",
    });
    const store = new MysqlSessionStore(pool);
    try {
      await store.migrate(await MysqlSessionStore.resolveMigrationsDir(opts.migrationsDir), opts.migrationLockTimeoutSeconds ?? 60);
      return store;
    } catch (err) {
      // A failed startup must not strand a pool (and its advisory-lock connection) in the process.
      await pool.end().catch(() => {});
      throw err;
    }
  }

  async migrate(migrationsDir?: string, lockTimeoutSeconds = 60): Promise<void> {
    const dir = migrationsDir ?? (await MysqlSessionStore.resolveMigrationsDir());
    if (!Number.isInteger(lockTimeoutSeconds) || lockTimeoutSeconds < 0) throw new Error("migrationLockTimeoutSeconds must be a non-negative integer");
    // MySQL DDL auto-commits, so a transaction cannot serialize migrations. A named lock held by one
    // dedicated connection prevents two cold-starting runners from both observing a migration as
    // pending and racing the same ALTER TABLE. The database hash keeps independent schemas separate.
    const conn = await this.pool.getConnection();
    let locked = false;
    try {
      const [lockRows] = await conn.query<Row[]>(
        "SELECT GET_LOCK(CONCAT('agent-service:migrate:', LEFT(SHA2(DATABASE(), 256), 32)), ?) AS acquired",
        [lockTimeoutSeconds],
      );
      locked = Number(lockRows[0]?.acquired) === 1;
      if (!locked) throw new Error(`timed out after ${lockTimeoutSeconds}s waiting for the MySQL schema migration lock`);

      await conn.query(
        "CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(128) PRIMARY KEY, applied_at_ms BIGINT NOT NULL)",
      );
      const [applied] = await conn.query<Row[]>("SELECT name FROM schema_migrations");
      const done = new Set(applied.map((r) => r.name as string));
      const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
      for (const f of files) {
        if (done.has(f)) continue;
        const sql = await readFile(join(dir, f), "utf8");
        const stripped = sql.replace(/^\s*--.*$/gm, "");
        const statements = stripped.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
        for (const [i, stmt] of statements.entries()) {
          try {
            await conn.query(stmt);
          } catch (cause) {
            throw new Error(`migration ${f} failed at statement ${i + 1}/${statements.length}`, { cause });
          }
        }
        await conn.query("INSERT INTO schema_migrations (name, applied_at_ms) VALUES (?, ?)", [f, Date.now()]);
      }
    } finally {
      if (locked) {
        await conn.query("SELECT RELEASE_LOCK(CONCAT('agent-service:migrate:', LEFT(SHA2(DATABASE(), 256), 32)))").catch(() => {});
      }
      conn.release();
    }
  }

  // ---------- agents ----------
  async createAgent(def: AgentDefinition) {
    await this.pool.query(
      "INSERT INTO agent_versions (tenant_id, agent_id, version, definition, created_at_ms) VALUES (?,?,?,?,?)",
      [def.tenantId, def.id, def.version, json(def), def.createdAtMs],
    );
  }
  async getAgent(tenantId: string, agentId: string, version?: number) {
    const [rows] = await this.pool.query<Row[]>(
      version === undefined
        ? "SELECT definition FROM agent_versions WHERE tenant_id=? AND agent_id=? ORDER BY version DESC LIMIT 1"
        : "SELECT definition FROM agent_versions WHERE tenant_id=? AND agent_id=? AND version=?",
      version === undefined ? [tenantId, agentId] : [tenantId, agentId, version],
    );
    return rows[0] ? parse<AgentDefinition>(rows[0].definition) : null;
  }
  async listAgents(tenantId: string, opts: { cursor?: string; limit: number }): Promise<Page<AgentDefinition>> {
    const [rows] = await this.pool.query<Row[]>(
      `SELECT a.definition, a.agent_id FROM agent_versions a
         JOIN (SELECT agent_id, MAX(version) v FROM agent_versions WHERE tenant_id=? GROUP BY agent_id) m
           ON a.agent_id=m.agent_id AND a.version=m.v
        WHERE a.tenant_id=? ${opts.cursor ? "AND a.agent_id < ?" : ""}
        ORDER BY a.agent_id DESC LIMIT ?`,
      opts.cursor ? [tenantId, tenantId, opts.cursor, opts.limit + 1] : [tenantId, tenantId, opts.limit + 1],
    );
    const data = rows.slice(0, opts.limit).map((r) => parse<AgentDefinition>(r.definition));
    return { data, nextCursor: rows.length > opts.limit ? (data.at(-1)?.id ?? null) : null };
  }

  // ---------- sessions ----------
  async createSession(s: Session): Promise<CommitResult> {
    if (s.lastSeq !== 0) throw new Error("a new session must start at lastSeq 0");
    if (s.fenceToken !== 0) throw new Error("a new session must start at fenceToken 0");
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      if (s.parentSessionId) {
        // Serialize child creation with parent tombstoning. Host preflight is only an early error;
        // this locked re-check is the authority that prevents a dangling child under a deleted row.
        const [parentRows] = await conn.query<Row[]>(
          `SELECT tenant_id, user_id, deleted_at_ms
             FROM sessions WHERE session_id=? FOR UPDATE`,
          [s.parentSessionId],
        );
        const parent = parentRows[0];
        if (
          !parent
          || parent.deleted_at_ms != null
          || parent.tenant_id !== s.tenantId
          || parent.user_id !== s.userId
        ) {
          throw new SessionGoneError(s.parentSessionId);
        }
      }
      try {
        await conn.query(
          `INSERT INTO sessions (session_id, tenant_id, user_id, agent_id, agent_version, status, title, parent_session_id,
             last_seq, fence_token, context_epoch, usage_json, auto_approved_tools, metadata, created_at_ms, updated_at_ms, archived_at_ms)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            s.id, s.tenantId, s.userId, s.agentId, s.agentVersion, json(s.status), s.title ?? null, s.parentSessionId ?? null,
            1, s.fenceToken, s.contextEpoch, json(s.usage), json(s.autoApprovedTools), json(s.metadata), s.createdAtMs, s.updatedAtMs, s.archivedAtMs ?? null,
          ],
        );
      } catch (err) {
        // Only a collision on the session row has SessionExists semantics. A later duplicate/error
        // while inserting the event must retain its database identity for diagnosis after rollback.
        if ((err as { code?: string }).code === "ER_DUP_ENTRY") throw new SessionExistsError(s.id);
        throw err;
      }
      const event: PersistedEvent = {
        type: "session/created",
        sessionId: s.id,
        emittedAtMs: s.createdAtMs,
        seq: 1,
      };
      await conn.query(
        "INSERT INTO events (session_id, seq, user_id, type, body, emitted_at_ms) VALUES (?,?,?,?,?,?)",
        [s.id, event.seq, s.userId, event.type, json(event), event.emittedAtMs],
      );
      await conn.commit();
      return { events: [event], lastSeq: 1 };
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }
  async getSession(tenantId: string, sessionId: string) {
    const [rows] = await this.pool.query<Row[]>(
      "SELECT * FROM sessions WHERE session_id=? AND tenant_id=? AND deleted_at_ms IS NULL",
      [sessionId, tenantId],
    );
    return rows[0] ? rowToSession(rows[0]) : null;
  }
  async getSessionLifecycle(tenantId: string, userId: string, sessionId: string): Promise<SessionLifecycleRecord | null> {
    const [rows] = await this.pool.query<Row[]>(
      `SELECT * FROM sessions
        WHERE session_id=? AND tenant_id=? AND user_id=?`,
      [sessionId, tenantId, userId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      session: rowToSession(row),
      deletedAtMs: row.deleted_at_ms == null ? undefined : Number(row.deleted_at_ms),
      purgeAfterMs: row.purge_after_ms == null ? undefined : Number(row.purge_after_ms),
      deletionGeneration: Number(row.deletion_generation),
    };
  }
  async listSessions(tenantId: string, opts: { userId?: string; cursor?: string; limit: number; includeArchived?: boolean }): Promise<Page<Session>> {
    const where = ["tenant_id=?", "deleted_at_ms IS NULL"];
    const params: unknown[] = [tenantId];
    if (opts.userId) { where.push("user_id=?"); params.push(opts.userId); }
    if (!opts.includeArchived) where.push("archived_at_ms IS NULL");
    if (opts.cursor) { where.push("session_id < ?"); params.push(opts.cursor); }
    params.push(opts.limit + 1);
    const [rows] = await this.pool.query<Row[]>(
      `SELECT * FROM sessions WHERE ${where.join(" AND ")} ORDER BY session_id DESC LIMIT ?`,
      params,
    );
    const data = rows.slice(0, opts.limit).map(rowToSession);
    return { data, nextCursor: rows.length > opts.limit ? (data.at(-1)?.id ?? null) : null };
  }

  // ---------- blob ownership manifest ----------
  async stageBlob(input: StageBlobInput): Promise<void> {
    validateStageBlobInput(input);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [sessions] = await conn.query<Row[]>(
        `SELECT tenant_id, user_id, fence_token, archived_at_ms, deleted_at_ms
           FROM sessions WHERE session_id=? FOR UPDATE`,
        [input.sessionId],
      );
      const session = sessions[0];
      if (
        !session
        || session.deleted_at_ms != null
        || session.tenant_id !== input.owner.tenantId
        || session.user_id !== input.owner.userId
      ) throw new SessionGoneError(input.sessionId);
      if (session.archived_at_ms != null) throw new SessionArchivedError(input.sessionId);
      const currentFence = Number(session.fence_token);
      if (input.fence < currentFence) throw new FenceError(input.sessionId, input.fence, currentFence);

      const [existingRows] = await conn.query<Row[]>(
        `SELECT ${BLOB_COLUMNS} FROM blob_objects WHERE blob_id=? FOR UPDATE`,
        [input.blobId],
      );
      const existing = existingRows[0] ? rowToBlobManifest(existingRows[0]) : undefined;
      if (existing) {
        if (
          existing.state !== "staging"
          || existing.tenantId !== input.owner.tenantId
          || existing.userId !== input.owner.userId
          || existing.sessionId !== input.sessionId
          || existing.purpose !== input.purpose
          || existing.storageBackend !== input.storageBackend
          || existing.storageFormat !== input.storageFormat
          || existing.storageKey !== input.storageKey
          || existing.uploadToken !== input.uploadToken
          || existing.createdAtMs !== input.createdAtMs
          || existing.stagingExpiresAtMs !== input.stagingExpiresAtMs
        ) throw new BlobStateError(input.blobId);
      } else {
        await conn.query(
          `INSERT INTO blob_objects
             (blob_id, tenant_id, user_id, session_id, item_id, purpose, storage_backend, storage_format,
              storage_key, upload_token, state, created_at_ms, staging_expires_at_ms, deletion_generation)
           VALUES (?,?,?,?,NULL,?,?,?,?,?,'staging',?,?,0)`,
          [
            input.blobId,
            input.owner.tenantId,
            input.owner.userId,
            input.sessionId,
            input.purpose,
            input.storageBackend,
            input.storageFormat,
            input.storageKey,
            input.uploadToken,
            input.createdAtMs,
            input.stagingExpiresAtMs,
          ],
        );
      }
      if (input.fence > currentFence) {
        await conn.query("UPDATE sessions SET fence_token=? WHERE session_id=?", [input.fence, input.sessionId]);
      }
      await conn.commit();
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async markBlobUploaded(input: MarkBlobUploadedInput): Promise<void> {
    validateUploadedBlobInput(input);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [sessions] = await conn.query<Row[]>(
        `SELECT tenant_id, user_id, fence_token, archived_at_ms, deleted_at_ms
           FROM sessions WHERE session_id=? FOR UPDATE`,
        [input.sessionId],
      );
      const session = sessions[0];
      if (
        !session
        || session.deleted_at_ms != null
        || session.tenant_id !== input.owner.tenantId
        || session.user_id !== input.owner.userId
      ) throw new SessionGoneError(input.sessionId);
      if (session.archived_at_ms != null) throw new SessionArchivedError(input.sessionId);
      const currentFence = Number(session.fence_token);
      if (input.fence < currentFence) throw new FenceError(input.sessionId, input.fence, currentFence);
      const [rows] = await conn.query<Row[]>(
        `SELECT ${BLOB_COLUMNS} FROM blob_objects WHERE blob_id=? FOR UPDATE`,
        [input.blobId],
      );
      const manifest = rows[0] ? rowToBlobManifest(rows[0]) : undefined;
      if (
        !manifest
        || manifest.state !== "staging"
        || manifest.tenantId !== input.owner.tenantId
        || manifest.userId !== input.owner.userId
        || manifest.sessionId !== input.sessionId
        || manifest.uploadToken !== input.uploadToken
      ) throw new BlobStateError(input.blobId);
      if (manifest.uploadedAtMs !== undefined) {
        if (
          manifest.sha256 !== input.sha256
          || manifest.sizeBytes !== input.sizeBytes
          || manifest.contentType !== input.contentType
        ) throw new BlobStateError(input.blobId, "uploaded blob descriptor does not match");
      } else {
        await conn.query(
          `UPDATE blob_objects
              SET sha256=UNHEX(?), size_bytes=?, content_type=?, uploaded_at_ms=?
            WHERE blob_id=? AND state='staging' AND upload_token=?`,
          [input.sha256, input.sizeBytes, input.contentType ?? null, input.uploadedAtMs, input.blobId, input.uploadToken],
        );
      }
      if (input.fence > currentFence) {
        await conn.query("UPDATE sessions SET fence_token=? WHERE session_id=?", [input.fence, input.sessionId]);
      }
      await conn.commit();
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async getBlobManifest(blobId: string): Promise<BlobManifest | null> {
    const [rows] = await this.pool.query<Row[]>(`SELECT ${BLOB_COLUMNS} FROM blob_objects WHERE blob_id=?`, [blobId]);
    return rows[0] ? rowToBlobManifest(rows[0]) : null;
  }

  async getBindableBlob(input: BindableBlobLookup): Promise<BlobManifest | null> {
    const [rows] = await this.pool.query<Row[]>(
      `SELECT ${QUALIFIED_BLOB_COLUMNS}
         FROM blob_objects b
         JOIN sessions s ON s.session_id=b.session_id AND s.tenant_id=b.tenant_id AND s.user_id=b.user_id
        WHERE b.blob_id=? AND b.tenant_id=? AND b.user_id=? AND b.session_id=? AND b.purpose=?
          AND b.state='staging' AND b.item_id IS NULL AND b.uploaded_at_ms IS NOT NULL
          AND b.sha256 IS NOT NULL AND b.size_bytes IS NOT NULL
          AND s.deleted_at_ms IS NULL AND s.archived_at_ms IS NULL`,
      [input.blobId, input.owner.tenantId, input.owner.userId, input.sessionId, input.purpose],
    );
    const manifest = rows[0] ? rowToBlobManifest(rows[0]) : null;
    return manifest && isUnexpiredStagingBlob(manifest, Date.now()) ? manifest : null;
  }

  async getReadyBlob(input: ReadyBlobLookup): Promise<BlobManifest | null> {
    const where = [
      "b.blob_id=?",
      "b.tenant_id=?",
      "b.user_id=?",
      "b.session_id=?",
      "b.state='ready'",
      "s.deleted_at_ms IS NULL",
      "i.item_id=b.item_id",
      "i.session_id=b.session_id",
      "i.user_id=b.user_id",
    ];
    const params: unknown[] = [input.blobId, input.owner.tenantId, input.owner.userId, input.sessionId];
    if (input.itemId) { where.push("b.item_id=?"); params.push(input.itemId); }
    if (input.purpose) { where.push("b.purpose=?"); params.push(input.purpose); }
    const [rows] = await this.pool.query<Row[]>(
      `SELECT ${QUALIFIED_BLOB_COLUMNS}
         FROM blob_objects b
         JOIN sessions s ON s.session_id=b.session_id AND s.tenant_id=b.tenant_id AND s.user_id=b.user_id
         JOIN items i ON i.item_id=b.item_id
        WHERE ${where.join(" AND ")}`,
      params,
    );
    return rows[0] ? rowToBlobManifest(rows[0]) : null;
  }

  private async lockBlobBindings(
    conn: PoolConnection,
    bindings: readonly BlobBinding[],
    owner: { tenantId: string; userId: string },
    sessionId: string,
  ): Promise<{ blobIds: string[]; readyAtMs: number }> {
    if (bindings.length === 0) return { blobIds: [], readyAtMs: Date.now() };
    const sorted = [...bindings].sort((left, right) => left.blobId.localeCompare(right.blobId));
    const placeholders = sorted.map(() => "?").join(",");
    const [rows] = await conn.query<Row[]>(
      `SELECT ${BLOB_COLUMNS} FROM blob_objects
        WHERE blob_id IN (${placeholders}) ORDER BY blob_id FOR UPDATE`,
      sorted.map((binding) => binding.blobId),
    );
    const manifests = new Map(rows.map((row) => {
      const manifest = rowToBlobManifest(row);
      return [manifest.blobId, manifest] as const;
    }));
    // Evaluate the hard staging deadline only after all selected manifest rows are locked. A
    // transaction that waited behind the sweeper (or another binder) cannot use a stale timestamp
    // captured before lock acquisition to resurrect an expired object.
    const readyAtMs = Date.now();
    const toReady: string[] = [];
    for (const binding of sorted) {
      const manifest = manifests.get(binding.blobId);
      if (
        !manifest
        || manifest.tenantId !== owner.tenantId
        || manifest.userId !== owner.userId
        || manifest.sessionId !== sessionId
        || manifest.purpose !== binding.purpose
        || manifest.uploadedAtMs === undefined
        || manifest.sha256 === undefined
        || manifest.sizeBytes === undefined
      ) throw new BlobStateError(binding.blobId);
      if (manifest.state === "ready" && manifest.itemId === binding.itemId) continue;
      if (!isUnexpiredStagingBlob(manifest, readyAtMs) || manifest.itemId !== undefined) {
        throw new BlobStateError(binding.blobId);
      }
      toReady.push(binding.blobId);
    }
    return { blobIds: toReady, readyAtMs };
  }

  /**
   * Item/turn/approval primary keys are global while their API ownership is session-scoped. Lock
   * every existing identity before any event or blob state is written, and reject both direct
   * collisions and references to a resource owned by another session. The returned sets also let
   * persistence use an explicit INSERT or UPDATE; ON DUPLICATE KEY UPDATE would let a concurrent
   * first writer from another session overwrite the globally keyed row after this preflight.
   */
  private async preflightCommitResources(
    conn: PoolConnection,
    batch: CommitBatch,
    owner: { tenantId: string; userId: string },
  ): Promise<ExistingCommitResources> {
    const observedItems = new Map<string, Item>();
    const observedTurns = new Map<string, Turn>();
    const observedApprovals = new Map<string, Approval>();
    const observeItem = (item: Item) => {
      const previous = observedItems.get(item.id);
      if (previous && (previous.sessionId !== item.sessionId || previous.turnId !== item.turnId || previous.type !== item.type)) {
        throw new Error("item identity conflicts with another resource");
      }
      observedItems.set(item.id, item);
    };
    const observeTurn = (turn: Turn) => {
      const previous = observedTurns.get(turn.id);
      if (previous && previous.sessionId !== turn.sessionId) throw new Error("turn identity conflicts with another resource");
      observedTurns.set(turn.id, turn);
    };
    const observeApproval = (approval: Approval) => {
      const previous = observedApprovals.get(approval.id);
      if (
        previous
        && (
          previous.sessionId !== approval.sessionId
          || previous.turnId !== approval.turnId
          || previous.itemId !== approval.itemId
          || previous.toolCallId !== approval.toolCallId
        )
      ) throw new Error("approval identity conflicts with another resource");
      observedApprovals.set(approval.id, approval);
    };

    for (const item of batch.items ?? []) observeItem(item);
    if (batch.turn) observeTurn(batch.turn);
    for (const approval of batch.approvals ?? []) {
      if (observedApprovals.has(approval.id)) throw new Error("commit contains the same approval more than once");
      observeApproval(approval);
    }
    for (const event of batch.events ?? []) {
      if ("item" in event) observeItem(event.item);
      if ("turn" in event) observeTurn(event.turn);
      if ("approval" in event) observeApproval(event.approval);
    }

    const turnReferences = new Set<string>();
    for (const id of observedTurns.keys()) turnReferences.add(id);
    for (const item of batch.items ?? []) turnReferences.add(item.turnId);
    for (const approval of batch.approvals ?? []) turnReferences.add(approval.turnId);
    for (const usage of batch.usageEntries ?? []) turnReferences.add(usage.turnId);
    if (batch.idempotency) turnReferences.add(batch.idempotency.value.turnId);

    const itemReferences = new Set<string>(observedItems.keys());
    for (const approval of batch.approvals ?? []) itemReferences.add(approval.itemId);

    const existing: ExistingCommitResources = {
      itemIds: new Set<string>(),
      turnIds: new Set<string>(),
      approvalIds: new Set<string>(),
    };

    const turnIds = [...turnReferences].sort();
    if (turnIds.length) {
      const placeholders = turnIds.map(() => "?").join(",");
      const [rows] = await conn.query<Row[]>(
        `SELECT turn_id, session_id, user_id
           FROM turns WHERE turn_id IN (${placeholders})
          ORDER BY turn_id FOR UPDATE`,
        turnIds,
      );
      for (const row of rows) {
        if (row.session_id !== batch.sessionId || row.user_id !== owner.userId) {
          throw new Error("turn identity conflicts with another session owner");
        }
        if (batch.turn?.id === row.turn_id) existing.turnIds.add(String(row.turn_id));
      }
    }

    const itemIds = [...itemReferences].sort();
    if (itemIds.length) {
      const placeholders = itemIds.map(() => "?").join(",");
      const [rows] = await conn.query<Row[]>(
        `SELECT item_id, session_id, user_id, turn_id, type
           FROM items WHERE item_id IN (${placeholders})
          ORDER BY item_id FOR UPDATE`,
        itemIds,
      );
      for (const row of rows) {
        if (row.session_id !== batch.sessionId || row.user_id !== owner.userId) {
          throw new Error("item identity conflicts with another session owner");
        }
        const incoming = observedItems.get(String(row.item_id));
        if (incoming) {
          if (row.turn_id !== incoming.turnId || row.type !== incoming.type) {
            throw new Error("item identity cannot change its turn or type");
          }
          existing.itemIds.add(String(row.item_id));
        }
      }
    }

    const approvalIds = [...observedApprovals.keys()].sort();
    if (approvalIds.length) {
      const placeholders = approvalIds.map(() => "?").join(",");
      const [rows] = await conn.query<Row[]>(
        `SELECT approval_id, session_id, user_id, turn_id, body
           FROM approvals WHERE approval_id IN (${placeholders})
          ORDER BY approval_id FOR UPDATE`,
        approvalIds,
      );
      for (const row of rows) {
        if (row.session_id !== batch.sessionId || row.user_id !== owner.userId) {
          throw new Error("approval identity conflicts with another session owner");
        }
        const incoming = observedApprovals.get(String(row.approval_id));
        const stored = parse<Approval>(row.body);
        if (
          !incoming
          || row.turn_id !== incoming.turnId
          || stored.itemId !== incoming.itemId
          || stored.toolCallId !== incoming.toolCallId
        ) {
          throw new Error("approval identity cannot change its turn, item or tool call");
        }
        if (batch.approvals?.some((approval) => approval.id === row.approval_id)) {
          existing.approvalIds.add(String(row.approval_id));
        }
      }
    }

    return existing;
  }

  // ---------- fenced commit ----------
  async commit(batch: CommitBatch): Promise<CommitResult> {
    assertPureFenceClaim(batch);
    assertTombstoneEvent(batch);
    assertCommitResourceOwnership(batch);
    assertBlobBindingsMatch(batch.items, batch.blobBindings);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query<Row[]>(
        `SELECT tenant_id, user_id, status, last_seq, fence_token, archived_at_ms,
                deleted_at_ms, purge_after_ms, deletion_generation
           FROM sessions WHERE session_id=? FOR UPDATE`,
        [batch.sessionId],
      );
      const head = rows[0];
      if (!head || head.deleted_at_ms != null) throw new SessionGoneError(batch.sessionId);
      const tenantId = head.tenant_id as string;
      const userId = head.user_id as string;
      const expectedOwner = batch.lifecycle ?? batch.fenceClaim;
      if (expectedOwner && (expectedOwner.tenantId !== tenantId || expectedOwner.userId !== userId)) {
        throw new SessionGoneError(batch.sessionId);
      }
      const currentFence = Number(head.fence_token);
      if (batch.fence < currentFence) throw new FenceError(batch.sessionId, batch.fence, currentFence);
      const currentLastSeq = Number(head.last_seq);
      if (batch.expectedLastSeq !== undefined && batch.expectedLastSeq !== currentLastSeq) {
        throw new SessionVersionError(batch.sessionId, batch.expectedLastSeq, currentLastSeq);
      }
      if (batch.lifecycle) {
        if (
          (batch.lifecycle.type === "archive" || batch.lifecycle.type === "tombstone")
          && parse<Session["status"]>(head.status).type === "active"
          && batch.sessionPatch?.status?.type !== "idle"
        ) {
          throw new SessionLifecycleBusyError(batch.sessionId);
        }
      } else if (!batch.fenceClaim && head.archived_at_ms != null) {
        throw new SessionArchivedError(batch.sessionId);
      }

      if (batch.fenceClaim) {
        // Ownership hand-off is intentionally invisible to clients: do not change updated_at_ms or
        // last_seq, and do not emit an event. The row lock makes this the linearization point.
        await conn.query("UPDATE sessions SET fence_token=? WHERE session_id=?", [batch.fence, batch.sessionId]);
        await conn.commit();
        return { events: [], lastSeq: currentLastSeq };
      }

      if (batch.lifecycle?.type === "tombstone") {
        const currentGeneration = Number(head.deletion_generation);
        if (batch.lifecycle.deletionGeneration !== currentGeneration + 1) {
          throw new Error(`deletion generation must advance from ${currentGeneration} to ${currentGeneration + 1}`);
        }
        const [children] = await conn.query<Row[]>(
          "SELECT session_id FROM sessions WHERE parent_session_id=? AND deleted_at_ms IS NULL LIMIT 1",
          [batch.sessionId],
        );
        if (children.length) throw new SessionHasChildrenError(batch.sessionId);
      }

      // A completed idempotency receipt and the first turn write share this transaction. There is no
      // pending reservation: a process that dies during preflight therefore leaves nothing to poison
      // retries. The locked session row serialises all conforming writers for this scope.
      if (batch.idempotency) {
        const receipt = batch.idempotency;
        if (receipt.scope.tenantId !== tenantId || receipt.scope.userId !== userId || receipt.scope.sessionId !== batch.sessionId) {
          throw new Error("idempotency scope does not match the locked session");
        }
        const keyParams = [tenantId, userId, batch.sessionId, receipt.key];
        const [idemRows] = await conn.query<Row[]>(
          "SELECT value, request_hash, expires_at_ms FROM idempotency_keys WHERE tenant_id=? AND user_id=? AND session_id=? AND idem_key=? FOR UPDATE",
          keyParams,
        );
        const existing = idemRows[0];
        const now = Date.now();
        // A legacy runner completes a reservation with an unconditional UPDATE by primary key. Do
        // not replace even an expired pending row: that delayed UPDATE could otherwise overwrite the
        // new completed receipt. Operations may delete pending rows after all legacy runners exit.
        if (existing && existing.value == null) {
          throw new IdempotencyPendingError(Number(existing.expires_at_ms));
        }
        if (existing && Number(existing.expires_at_ms) >= now && existing.value != null) {
          const stored: IdempotencyReceipt = {
            requestHash: existing.request_hash == null ? undefined : String(existing.request_hash),
            value: parse(existing.value),
            expiresAtMs: Number(existing.expires_at_ms),
          };
          if (!stored.requestHash || stored.requestHash === receipt.requestHash) throw new IdempotencyReplayError(stored);
          throw new IdempotencyMismatchError(stored);
        }
        // New code never creates pending rows. An expired completed receipt is safe to replace.
        if (existing) {
          await conn.query(
            "DELETE FROM idempotency_keys WHERE tenant_id=? AND user_id=? AND session_id=? AND idem_key=?",
            keyParams,
          );
        }
      }

      const existingResources = await this.preflightCommitResources(
        conn,
        batch,
        { tenantId, userId },
      );

      // Lock every referenced manifest only after the session and globally keyed resource rows, in
      // bytewise blob-id order. The
      // staging sweeper locks only blob rows, so it either wins this state transition or observes the
      // committed ready state; it can never delete an object that this transaction just attached.
      const bindings = batch.blobBindings ?? [];
      const { blobIds: blobsToReady, readyAtMs } = await this.lockBlobBindings(
        conn,
        bindings,
        { tenantId, userId },
        batch.sessionId,
      );

      let seq = currentLastSeq;
      const events: PersistedEvent[] = [];
      for (const e of batch.events ?? []) {
        seq += 1;
        const event = { ...e, seq } as PersistedEvent;
        // Only sequence-bearing nested resources are mutated below. Copy those resource objects so
        // a later SQL/serialization failure cannot leak an assigned seq into the caller's batch.
        if (event.type === "item/started" || event.type === "item/completed") event.item = { ...event.item };
        if (event.type === "turn/completed") event.turn = { ...event.turn };
        events.push(event);
      }
      const items = batch.items?.map((item) => ({ ...item }));
      const turn = batch.turn ? { ...batch.turn } : undefined;
      assignItemSeqs(items, events, seq);
      assignTurnSeqEnd(turn, events, seq);
      if (events.length) {
        await conn.query(
          "INSERT INTO events (session_id, seq, user_id, type, body, emitted_at_ms) VALUES ?",
          [events.map((e) => [batch.sessionId, e.seq, userId, e.type, json(e), e.emittedAtMs])],
        );
      }
      for (const it of items ?? []) await upsertItem(conn, it, userId, existingResources.itemIds.has(it.id));
      for (const blobId of blobsToReady) {
        const binding = bindings.find((candidate) => candidate.blobId === blobId)!;
        const [updated] = await conn.query<mysql.ResultSetHeader>(
          `UPDATE blob_objects
            SET state='ready', item_id=?, ready_at_ms=?, staging_expires_at_ms=NULL
            WHERE blob_id=? AND state='staging' AND item_id IS NULL AND staging_expires_at_ms>?`,
          [binding.itemId, readyAtMs, blobId, readyAtMs],
        );
        if (updated.affectedRows !== 1) throw new BlobStateError(blobId);
      }
      if (turn) await upsertTurn(conn, turn, userId, existingResources.turnIds.has(turn.id));
      for (const a of batch.approvals ?? []) {
        await upsertApproval(conn, a, userId, existingResources.approvalIds.has(a.id));
      }
      if (batch.usageEntries?.length) {
        await conn.query(
          "INSERT INTO usage_ledger (tenant_id, user_id, session_id, turn_id, step, provider, model, usage_json, created_at_ms) VALUES ?",
          [batch.usageEntries.map((e) => [tenantId, userId, batch.sessionId, e.turnId, e.step, e.provider, e.model, json(e.usage), e.createdAtMs])],
        );
      }
      if (batch.idempotency) {
        const receipt = batch.idempotency;
        await conn.query(
          "INSERT INTO idempotency_keys (tenant_id, user_id, session_id, idem_key, request_hash, value, expires_at_ms) VALUES (?,?,?,?,?,?,?)",
          [tenantId, userId, batch.sessionId, receipt.key, receipt.requestHash, json(receipt.value), receipt.expiresAtMs],
        );
      }
      if (batch.lifecycle?.type === "tombstone") {
        const generation = batch.lifecycle.deletionGeneration;
        const deletedEvent = events.at(-1);
        if (deletedEvent?.type !== "session/deleted") throw new Error("tombstone event was not assigned a sequence");
        await conn.query(
          `INSERT INTO lifecycle_outbox
             (topic, aggregate_id, generation, payload, available_at_ms, attempts, created_at_ms)
           VALUES ?`,
          [[
            [
              "session.tombstoned",
              batch.sessionId,
              generation,
              json({ sessionId: batch.sessionId, deletionGeneration: generation, eventSeq: deletedEvent.seq }),
              batch.lifecycle.atMs,
              0,
              batch.lifecycle.atMs,
            ],
            [
              "session.purge",
              batch.sessionId,
              generation,
              json({ sessionId: batch.sessionId, deletionGeneration: generation }),
              null,
              0,
              batch.lifecycle.atMs,
            ],
          ]],
        );
      }

      const sets = ["last_seq=?", "fence_token=?", "updated_at_ms=?"];
      const params: unknown[] = [seq, batch.fence, Date.now()];
      const p = batch.sessionPatch;
      if (p) {
        if (p.status !== undefined) { sets.push("status=?"); params.push(json(p.status)); }
        if (p.title !== undefined) { sets.push("title=?"); params.push(p.title); }
        if (p.usage !== undefined) { sets.push("usage_json=?"); params.push(json(p.usage)); }
        if (p.contextEpoch !== undefined) { sets.push("context_epoch=?"); params.push(p.contextEpoch); }
        if (p.metadata !== undefined) { sets.push("metadata=?"); params.push(json(p.metadata)); }
        if (p.autoApprovedTools !== undefined) { sets.push("auto_approved_tools=?"); params.push(json(p.autoApprovedTools)); }
        if (p.lastCompactionSeq !== undefined) { sets.push("last_compaction_seq=?"); params.push(p.lastCompactionSeq); }
      }
      if (batch.lifecycle) {
        if (batch.lifecycle.type === "tombstone") {
          sets.push("deleted_at_ms=?", "purge_after_ms=?", "deletion_generation=?");
          params.push(batch.lifecycle.atMs, batch.lifecycle.purgeAfterMs ?? null, batch.lifecycle.deletionGeneration);
        } else {
          sets.push("archived_at_ms=?");
          params.push(batch.lifecycle.type === "archive" ? batch.lifecycle.atMs : null);
        }
      }
      params.push(batch.sessionId);
      await conn.query(`UPDATE sessions SET ${sets.join(", ")} WHERE session_id=?`, params);
      await conn.commit();
      backfillAssignedSequences(batch, { items, turn, events });
      return {
        events,
        lastSeq: seq,
        lifecycleGeneration: batch.lifecycle?.type === "tombstone" ? batch.lifecycle.deletionGeneration : undefined,
      };
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }

  // ---------- reads ----------
  async readEvents(sessionId: string, afterSeq: number, limit: number) {
    // Deliberately raw: an established SSE stream must be able to observe session/deleted. Public
    // subscription setup performs an owner-aware live-session check before calling this method.
    const [rows] = await this.pool.query<Row[]>(
      "SELECT body FROM events WHERE session_id=? AND seq>? ORDER BY seq ASC LIMIT ?",
      [sessionId, afterSeq, limit],
    );
    return rows.map((r) => parse<PersistedEvent>(r.body));
  }
  async getTurn(sessionId: string, turnId: string) {
    const [rows] = await this.pool.query<Row[]>(
      `SELECT t.body FROM turns t
         JOIN sessions s ON s.session_id=t.session_id AND s.deleted_at_ms IS NULL
        WHERE t.turn_id=? AND t.session_id=?`,
      [turnId, sessionId],
    );
    return rows[0] ? parse<Turn>(rows[0].body) : null;
  }
  async listTurns(sessionId: string, opts: { cursor?: string; limit: number; sortDirection?: "asc" | "desc" }): Promise<Page<Turn>> {
    const desc = (opts.sortDirection ?? "desc") === "desc";
    const [rows] = await this.pool.query<Row[]>(
      `SELECT t.body FROM turns t
         JOIN sessions s ON s.session_id=t.session_id AND s.deleted_at_ms IS NULL
        WHERE t.session_id=? ${opts.cursor ? `AND t.turn_id ${desc ? "<" : ">"} ?` : ""}
        ORDER BY t.turn_id ${desc ? "DESC" : "ASC"} LIMIT ?`,
      opts.cursor ? [sessionId, opts.cursor, opts.limit + 1] : [sessionId, opts.limit + 1],
    );
    const data = rows.slice(0, opts.limit).map((r) => parse<Turn>(r.body));
    return { data, nextCursor: rows.length > opts.limit ? (data.at(-1)?.id ?? null) : null };
  }
  async listItems(sessionId: string, opts: { turnId?: string; afterSeq?: number; limit: number; newestFirst?: boolean }) {
    const where = ["i.session_id=?", "s.deleted_at_ms IS NULL"];
    const params: unknown[] = [sessionId];
    if (opts.turnId) { where.push("i.turn_id=?"); params.push(opts.turnId); }
    if (opts.afterSeq !== undefined) { where.push("i.seq>?"); params.push(opts.afterSeq); }
    params.push(opts.limit);
    // Take the newest rows when asked, then flip back to seq-ascending for the caller.
    const order = opts.newestFirst ? "DESC" : "ASC";
    const [rows] = await this.pool.query<Row[]>(
      `SELECT i.body FROM items i
         JOIN sessions s ON s.session_id=i.session_id
        WHERE ${where.join(" AND ")} ORDER BY i.seq ${order}, i.item_id ${order} LIMIT ?`,
      params,
    );
    const items = rows.map((r) => parse<Item>(r.body));
    return opts.newestFirst ? items.reverse() : items;
  }
  async getItem(sessionId: string, itemId: string) {
    const [rows] = await this.pool.query<Row[]>(
      `SELECT i.body FROM items i
         JOIN sessions s ON s.session_id=i.session_id AND s.deleted_at_ms IS NULL
        WHERE i.item_id=? AND i.session_id=?`,
      [itemId, sessionId],
    );
    return rows[0] ? parse<Item>(rows[0].body) : null;
  }
  async listApprovals(sessionId: string, opts: { pendingOnly?: boolean }) {
    const [rows] = await this.pool.query<Row[]>(
      `SELECT a.body FROM approvals a
         JOIN sessions s ON s.session_id=a.session_id AND s.deleted_at_ms IS NULL
        WHERE a.session_id=? ${opts.pendingOnly ? "AND a.status='pending'" : ""}
        ORDER BY a.created_at_ms ASC`,
      [sessionId],
    );
    return rows.map((r) => parse<Approval>(r.body));
  }
  async getApproval(sessionId: string, approvalId: string) {
    const [rows] = await this.pool.query<Row[]>(
      `SELECT a.body FROM approvals a
         JOIN sessions s ON s.session_id=a.session_id AND s.deleted_at_ms IS NULL
        WHERE a.approval_id=? AND a.session_id=?`,
      [approvalId, sessionId],
    );
    return rows[0] ? parse<Approval>(rows[0].body) : null;
  }

  // ---------- provider configs ----------
  async upsertProviderConfig(cfg: ProviderConfig, secret?: { ciphertext: Buffer; keyId: string }) {
    await this.pool.query(
      `INSERT INTO provider_configs (tenant_id, provider_id, config, secret_cipher, secret_key_id, created_at_ms, updated_at_ms)
       VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE config=VALUES(config), updated_at_ms=VALUES(updated_at_ms),
         secret_cipher=COALESCE(VALUES(secret_cipher), secret_cipher), secret_key_id=COALESCE(VALUES(secret_key_id), secret_key_id)`,
      [cfg.tenantId, cfg.id, json(cfg), secret?.ciphertext ?? null, secret?.keyId ?? null, cfg.createdAtMs, cfg.updatedAtMs],
    );
  }
  async getProviderConfig(tenantId: string, providerId: string) {
    const [rows] = await this.pool.query<Row[]>("SELECT config, secret_cipher, secret_key_id FROM provider_configs WHERE tenant_id=? AND provider_id=?", [tenantId, providerId]);
    const r = rows[0];
    if (!r) return null;
    return {
      config: parse<ProviderConfig>(r.config),
      secret: r.secret_cipher ? { ciphertext: Buffer.from(r.secret_cipher), keyId: r.secret_key_id as string } : undefined,
    };
  }
  async listProviderConfigs(tenantId: string) {
    const [rows] = await this.pool.query<Row[]>("SELECT config FROM provider_configs WHERE tenant_id=? ORDER BY provider_id", [tenantId]);
    return rows.map((r) => parse<ProviderConfig>(r.config));
  }
  async deleteProviderConfig(tenantId: string, providerId: string) {
    const [res] = await this.pool.query<mysql.ResultSetHeader>("DELETE FROM provider_configs WHERE tenant_id=? AND provider_id=?", [tenantId, providerId]);
    return res.affectedRows > 0;
  }

  // ---------- api keys ----------
  async resolveApiKey(hashedKey: string) {
    const [rows] = await this.pool.query<Row[]>("SELECT tenant_id, key_id, scopes FROM api_keys WHERE key_hash=? AND revoked_at_ms IS NULL", [hashedKey]);
    const r = rows[0];
    if (!r) return null;
    return { tenantId: r.tenant_id as string, keyId: r.key_id as string, scopes: r.scopes == null ? DEFAULT_SCOPES : parse<ApiKeyScope[]>(r.scopes) };
  }
  async createApiKey(tenantId: string, keyId: string, hashedKey: string, scopes: ApiKeyScope[] = DEFAULT_SCOPES) {
    await this.pool.query("INSERT IGNORE INTO tenants (tenant_id, created_at_ms) VALUES (?,?)", [tenantId, Date.now()]);
    await this.pool.query("INSERT IGNORE INTO api_keys (key_hash, key_id, tenant_id, scopes, created_at_ms) VALUES (?,?,?,?,?)", [hashedKey, keyId, tenantId, json(scopes), Date.now()]);
  }
  async listApiKeys(tenantId: string): Promise<ApiKeyRecord[]> {
    const [rows] = await this.pool.query<Row[]>("SELECT key_id, tenant_id, scopes, created_at_ms, revoked_at_ms FROM api_keys WHERE tenant_id=? ORDER BY created_at_ms", [tenantId]);
    return rows.map((r) => ({
      keyId: r.key_id as string,
      tenantId: r.tenant_id as string,
      scopes: r.scopes == null ? DEFAULT_SCOPES : parse<ApiKeyScope[]>(r.scopes),
      createdAtMs: Number(r.created_at_ms),
      revokedAtMs: r.revoked_at_ms == null ? undefined : Number(r.revoked_at_ms),
    }));
  }
  async revokeApiKey(tenantId: string, keyId: string) {
    const [res] = await this.pool.query<mysql.ResultSetHeader>(
      "UPDATE api_keys SET revoked_at_ms=? WHERE tenant_id=? AND key_id=? AND revoked_at_ms IS NULL",
      [Date.now(), tenantId, keyId],
    );
    return res.affectedRows > 0;
  }

  async getTenant(tenantId: string): Promise<TenantRecord | null> {
    const [rows] = await this.pool.query<Row[]>(
      "SELECT tenant_id, name, auth_policy, auth_secret_cipher, auth_secret_key_id, created_at_ms FROM tenants WHERE tenant_id=?",
      [tenantId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      tenantId: r.tenant_id,
      name: r.name ?? undefined,
      authPolicy: r.auth_policy == null ? DEFAULT_AUTH_POLICY : parse<TenantAuthPolicy>(r.auth_policy),
      authSecret: r.auth_secret_cipher ? { ciphertext: Buffer.from(r.auth_secret_cipher), keyId: r.auth_secret_key_id as string } : undefined,
      createdAtMs: Number(r.created_at_ms),
    };
  }
  async setTenantAuth(tenantId: string, policy: TenantAuthPolicy, secret?: { ciphertext: Buffer; keyId: string } | null) {
    // `undefined` keeps the stored secret; `null` clears it, so switching verifier kind cannot leave a
    // stale key behind that would then be used to verify tokens for the new configuration.
    const keep = secret === undefined;
    await this.pool.query(
      `INSERT INTO tenants (tenant_id, auth_policy, auth_secret_cipher, auth_secret_key_id, created_at_ms)
       VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE auth_policy=VALUES(auth_policy),
         auth_secret_cipher=${keep ? "auth_secret_cipher" : "VALUES(auth_secret_cipher)"},
         auth_secret_key_id=${keep ? "auth_secret_key_id" : "VALUES(auth_secret_key_id)"}`,
      [tenantId, json(policy), secret?.ciphertext ?? null, secret?.keyId ?? null, Date.now()],
    );
  }

  // ---------- usage ledger ----------
  async queryUsage(tenantId: string, q: UsageQuery) {
    // Grouping keys are chosen from a fixed set, never interpolated from input.
    const keyExpr =
      q.groupBy === "user" ? "u.user_id"
      : q.groupBy === "session" ? "u.session_id"
      : q.groupBy === "model" ? "CONCAT(u.provider, '/', u.model)"
      : q.groupBy === "day" ? "DATE_FORMAT(FROM_UNIXTIME(u.created_at_ms/1000), '%Y-%m-%d')"
      : "'total'";
    const where = ["u.tenant_id=?", "s.deleted_at_ms IS NULL"];
    const params: unknown[] = [tenantId];
    if (q.userId) { where.push("u.user_id=?"); params.push(q.userId); }
    if (q.sessionId) { where.push("u.session_id=?"); params.push(q.sessionId); }
    if (q.from !== undefined) { where.push("u.created_at_ms>=?"); params.push(q.from); }
    if (q.to !== undefined) { where.push("u.created_at_ms<?"); params.push(q.to); }
    params.push(q.limit);
    const [rows] = await this.pool.query<Row[]>(
      `SELECT ${keyExpr} AS k,
              COUNT(DISTINCT u.turn_id) AS turns,
              COUNT(*) AS steps,
              COALESCE(SUM(CAST(JSON_EXTRACT(u.usage_json,'$.inputTokens') AS UNSIGNED)),0) AS input_tokens,
              COALESCE(SUM(CAST(JSON_EXTRACT(u.usage_json,'$.outputTokens') AS UNSIGNED)),0) AS output_tokens,
              COALESCE(SUM(CAST(JSON_EXTRACT(u.usage_json,'$.cacheReadTokens') AS UNSIGNED)),0) AS cache_read_tokens,
              COALESCE(SUM(CAST(JSON_EXTRACT(u.usage_json,'$.cacheWriteTokens') AS UNSIGNED)),0) AS cache_write_tokens,
              COALESCE(SUM(CAST(JSON_EXTRACT(u.usage_json,'$.reasoningTokens') AS UNSIGNED)),0) AS reasoning_tokens,
              COALESCE(SUM(CAST(JSON_EXTRACT(u.usage_json,'$.totalTokens') AS UNSIGNED)),0) AS total_tokens,
              COALESCE(SUM(JSON_EXTRACT(u.usage_json,'$.costCNY')),0) AS cost
         FROM usage_ledger u
         JOIN sessions s ON s.session_id=u.session_id
        WHERE ${where.join(" AND ")}
        GROUP BY k
        ORDER BY total_tokens DESC, k ASC
        LIMIT ?`,
      params,
    );
    return {
      data: rows.map((r) => ({
        key: String(r.k),
        turns: Number(r.turns),
        steps: Number(r.steps),
        usage: {
          inputTokens: Number(r.input_tokens),
          outputTokens: Number(r.output_tokens),
          cacheReadTokens: Number(r.cache_read_tokens),
          cacheWriteTokens: Number(r.cache_write_tokens),
          reasoningTokens: Number(r.reasoning_tokens),
          totalTokens: Number(r.total_tokens),
          costCNY: Number(r.cost),
        },
      })),
    };
  }

  // ---------- idempotency ----------
  async getIdempotencyKey(scope: IdempotencyScope, key: string): Promise<IdempotencyReceipt | null> {
    const [rows] = await this.pool.query<Row[]>(
      `SELECT i.value, i.request_hash, i.expires_at_ms
         FROM idempotency_keys i
         JOIN sessions s
           ON s.session_id=i.session_id AND s.tenant_id=i.tenant_id AND s.user_id=i.user_id
          AND s.deleted_at_ms IS NULL
        WHERE i.tenant_id=? AND i.user_id=? AND i.session_id=? AND i.idem_key=?`,
      [scope.tenantId, scope.userId, scope.sessionId, key],
    );
    const row = rows[0];
    if (!row || row.value == null || Number(row.expires_at_ms) < Date.now()) return null;
    return {
      requestHash: row.request_hash == null ? undefined : String(row.request_hash),
      value: parse(row.value),
      expiresAtMs: Number(row.expires_at_ms),
    };
  }

  async getLifecycleOutbox(
    topic: LifecycleOutboxRecord["topic"],
    aggregateId: string,
    generation: number,
  ): Promise<LifecycleOutboxRecord | null> {
    const [rows] = await this.pool.query<Row[]>(
      `SELECT outbox_id, topic, aggregate_id, generation, payload, available_at_ms, attempts, claim_token,
              lease_until_ms, last_error, completed_at_ms, dead_lettered_at_ms, created_at_ms
         FROM lifecycle_outbox
        WHERE topic=? AND aggregate_id=? AND generation=?`,
      [topic, aggregateId, generation],
    );
    const row = rows[0];
    return row ? rowToLifecycleOutbox(row) : null;
  }

  async claimLifecycleOutbox(options: import("../types.js").ClaimLifecycleOutboxOptions) {
    const { topics, leaseUntilMs } = validateClaimLifecycleOutboxOptions(options);
    if (topics.length === 0) return [];
    const conn = await this.pool.getConnection();
    try {
      // READ COMMITTED reduces next-key/gap-lock contention around this worker queue. SKIP LOCKED
      // remains deliberately non-blocking and may under-fill a concurrent batch; the next poll
      // drains any eligible row skipped inside another transaction's LIMIT scan window.
      await conn.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      await conn.beginTransaction();
      const topicPlaceholders = topics.map(() => "?").join(",");
      const [locked] = await conn.query<Row[]>(
        `SELECT outbox_id, topic, aggregate_id, generation, payload, available_at_ms, attempts,
                claim_token, lease_until_ms, last_error, completed_at_ms, dead_lettered_at_ms, created_at_ms
           FROM lifecycle_outbox
          WHERE topic IN (${topicPlaceholders})
            AND available_at_ms IS NOT NULL
            AND available_at_ms<=?
            AND completed_at_ms IS NULL
            AND dead_lettered_at_ms IS NULL
            AND (claim_token IS NULL OR lease_until_ms<=?)
          ORDER BY available_at_ms ASC, outbox_id ASC
          LIMIT ?
          FOR UPDATE SKIP LOCKED`,
        [...topics, options.nowMs, options.nowMs, options.limit],
      );
      if (locked.length === 0) {
        await conn.commit();
        return [];
      }
      const ids: number[] = [];
      const poisonIds: number[] = [];
      for (const row of locked) {
        const id = Number(row.outbox_id);
        assertLifecycleOutboxId(id);
        try {
          rowToLifecycleOutbox(row);
          ids.push(id);
        } catch {
          poisonIds.push(id);
        }
      }
      if (poisonIds.length) {
        const poisonPlaceholders = poisonIds.map(() => "?").join(",");
        // Corrupt envelopes are deterministic poison. Quarantine them in the same locked
        // transaction so they cannot starve every valid intent behind the first queue position.
        await conn.query(
          `UPDATE lifecycle_outbox
              SET attempts=attempts+1, claim_token=NULL, lease_until_ms=NULL, available_at_ms=NULL,
                  last_error='invalid lifecycle outbox envelope', dead_lettered_at_ms=?
            WHERE outbox_id IN (${poisonPlaceholders})`,
          [options.nowMs, ...poisonIds],
        );
      }
      if (ids.length === 0) {
        await conn.commit();
        return [];
      }
      const idPlaceholders = ids.map(() => "?").join(",");
      await conn.query(
        `UPDATE lifecycle_outbox
            SET attempts=attempts+1, claim_token=?, lease_until_ms=?
          WHERE outbox_id IN (${idPlaceholders})`,
        [options.claimToken, leaseUntilMs, ...ids],
      );
      const [rows] = await conn.query<Row[]>(
        `SELECT outbox_id, topic, aggregate_id, generation, payload, available_at_ms, attempts,
                claim_token, lease_until_ms, last_error, completed_at_ms, dead_lettered_at_ms, created_at_ms
           FROM lifecycle_outbox
          WHERE outbox_id IN (${idPlaceholders})`,
        ids,
      );
      const byId = new Map(rows.map((row) => [Number(row.outbox_id), rowToLifecycleOutbox(row)]));
      const claimed = ids.map((id) => {
        const row = byId.get(id);
        if (!row) throw new Error(`claimed lifecycle outbox ${id} disappeared inside its transaction`);
        return row;
      });
      await conn.commit();
      return claimed;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async renewLifecycleOutboxClaim(
    outboxId: number,
    claimToken: string,
    options: import("../types.js").RenewLifecycleOutboxClaimOptions,
  ) {
    const leaseUntilMs = validateRenewLifecycleOutboxClaim(outboxId, claimToken, options.nowMs, options.leaseMs);
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE lifecycle_outbox
          SET lease_until_ms=GREATEST(lease_until_ms, ?)
        WHERE outbox_id=? AND claim_token=? AND lease_until_ms>?
          AND completed_at_ms IS NULL AND dead_lettered_at_ms IS NULL`,
      [leaseUntilMs, outboxId, claimToken, options.nowMs],
    );
    return result.affectedRows === 1;
  }

  async completeLifecycleOutbox(outboxId: number, claimToken: string, completedAtMs: number) {
    validateLifecycleOutboxAck(outboxId, claimToken, completedAtMs);
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE lifecycle_outbox
          SET completed_at_ms=?, claim_token=NULL, lease_until_ms=NULL, last_error=NULL
        WHERE outbox_id=? AND claim_token=? AND lease_until_ms>?
          AND completed_at_ms IS NULL AND dead_lettered_at_ms IS NULL`,
      [completedAtMs, outboxId, claimToken, completedAtMs],
    );
    return result.affectedRows === 1;
  }

  async retryLifecycleOutbox(
    outboxId: number,
    claimToken: string,
    options: import("../types.js").RetryLifecycleOutboxOptions,
  ) {
    validateLifecycleOutboxAck(outboxId, claimToken, options.failedAtMs);
    validateRetryLifecycleOutboxOptions(options);
    const lastError = sanitizeLifecycleOutboxError(options.error);
    if (options.maxAttempts === undefined) {
      const [result] = await this.pool.query<mysql.ResultSetHeader>(
        `UPDATE lifecycle_outbox
            SET claim_token=NULL, lease_until_ms=NULL, last_error=?, available_at_ms=?
          WHERE outbox_id=? AND claim_token=? AND lease_until_ms>?
            AND completed_at_ms IS NULL AND dead_lettered_at_ms IS NULL`,
        [lastError, options.availableAtMs, outboxId, claimToken, options.failedAtMs],
      );
      return result.affectedRows === 1;
    }
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE lifecycle_outbox
          SET claim_token=NULL,
              lease_until_ms=NULL,
              last_error=?,
              available_at_ms=CASE WHEN attempts>=? THEN NULL ELSE ? END,
              dead_lettered_at_ms=CASE WHEN attempts>=? THEN ? ELSE NULL END
        WHERE outbox_id=? AND claim_token=? AND lease_until_ms>?
          AND completed_at_ms IS NULL AND dead_lettered_at_ms IS NULL`,
      [
        lastError,
        options.maxAttempts,
        options.availableAtMs,
        options.maxAttempts,
        options.failedAtMs,
        outboxId,
        claimToken,
        options.failedAtMs,
      ],
    );
    return result.affectedRows === 1;
  }

  // ---------- blob staging sweeper + delete outbox ----------
  async scheduleStaleBlobDeletes(options: ScheduleStaleBlobsOptions): Promise<number> {
    if (!Number.isSafeInteger(options.nowMs) || options.nowMs < 0) throw new Error("invalid blob sweep timestamp");
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new Error("blob sweep limit must be between 1 and 100");
    const conn = await this.pool.getConnection();
    try {
      await conn.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      await conn.beginTransaction();
      const [rows] = await conn.query<Row[]>(
        `SELECT ${BLOB_COLUMNS} FROM blob_objects
          WHERE state='staging' AND staging_expires_at_ms IS NOT NULL AND staging_expires_at_ms<=?
          ORDER BY staging_expires_at_ms, blob_id
          LIMIT ? FOR UPDATE SKIP LOCKED`,
        [options.nowMs, options.limit],
      );
      for (const row of rows) {
        const manifest = rowToBlobManifest(row);
        const generation = manifest.deletionGeneration + 1;
        await conn.query(
          `UPDATE blob_objects
              SET state='delete_pending', staging_expires_at_ms=NULL, delete_after_ms=?, deletion_generation=?
            WHERE blob_id=? AND state='staging'`,
          [options.nowMs, generation, manifest.blobId],
        );
        await conn.query(
          `INSERT INTO blob_delete_outbox
             (blob_id, generation, available_at_ms, attempts, created_at_ms)
           VALUES (?,?,?,0,?)`,
          [manifest.blobId, generation, options.nowMs, options.nowMs],
        );
      }
      await conn.commit();
      return rows.length;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async claimBlobDeletes(options: ClaimBlobDeletesOptions): Promise<BlobDeleteOutboxRecord[]> {
    const leaseUntilMs = validateBlobDeleteClaim(options);
    const conn = await this.pool.getConnection();
    try {
      await conn.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      await conn.beginTransaction();
      const [locked] = await conn.query<Row[]>(
        `SELECT outbox_id FROM blob_delete_outbox
          WHERE available_at_ms<=?
            AND completed_at_ms IS NULL
            AND dead_lettered_at_ms IS NULL
            AND (claim_token IS NULL OR lease_until_ms<=?)
          ORDER BY available_at_ms, outbox_id
          LIMIT ? FOR UPDATE SKIP LOCKED`,
        [options.nowMs, options.nowMs, options.limit],
      );
      if (locked.length === 0) {
        await conn.commit();
        return [];
      }
      const ids = locked.map((row) => Number(row.outbox_id));
      const placeholders = ids.map(() => "?").join(",");
      const [joined] = await conn.query<Row[]>(
        `SELECT ${BLOB_DELETE_COLUMNS}
           FROM blob_delete_outbox o
           LEFT JOIN blob_objects b ON b.blob_id=o.blob_id
          WHERE o.outbox_id IN (${placeholders})`,
        ids,
      );
      const validIds: number[] = [];
      const poisonIds: number[] = [];
      for (const row of joined) {
        try {
          rowToBlobDeleteOutbox(row);
          validIds.push(Number(row.outbox_id));
        } catch {
          poisonIds.push(Number(row.outbox_id));
        }
      }
      if (poisonIds.length) {
        const poison = poisonIds.map(() => "?").join(",");
        await conn.query(
          `UPDATE blob_delete_outbox
              SET attempts=attempts+1, claim_token=NULL, lease_until_ms=NULL,
                  last_error='invalid blob delete outbox identity', dead_lettered_at_ms=?
            WHERE outbox_id IN (${poison})`,
          [options.nowMs, ...poisonIds],
        );
      }
      if (validIds.length === 0) {
        await conn.commit();
        return [];
      }
      const valid = validIds.map(() => "?").join(",");
      await conn.query(
        `UPDATE blob_delete_outbox SET attempts=attempts+1, claim_token=?, lease_until_ms=?
          WHERE outbox_id IN (${valid})`,
        [options.claimToken, leaseUntilMs, ...validIds],
      );
      const [claimedRows] = await conn.query<Row[]>(
        `SELECT ${BLOB_DELETE_COLUMNS}
           FROM blob_delete_outbox o
           JOIN blob_objects b ON b.blob_id=o.blob_id
          WHERE o.outbox_id IN (${valid})`,
        validIds,
      );
      const byId = new Map(claimedRows.map((row) => {
        const record = rowToBlobDeleteOutbox(row);
        return [record.outboxId, record] as const;
      }));
      const claimed = validIds.map((id) => {
        const record = byId.get(id);
        if (!record) throw new Error(`claimed blob delete outbox ${id} disappeared inside its transaction`);
        return record;
      });
      await conn.commit();
      return claimed;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async renewBlobDeleteClaim(
    outboxId: number,
    claimToken: string,
    options: import("../blob-lifecycle.js").RenewBlobDeleteClaimOptions,
  ): Promise<boolean> {
    validateBlobDeleteAck(outboxId, claimToken, options.nowMs);
    if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs < 1) throw new Error("invalid blob delete lease duration");
    const leaseUntilMs = options.nowMs + options.leaseMs;
    if (!Number.isSafeInteger(leaseUntilMs)) throw new Error("invalid blob delete lease expiry");
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE blob_delete_outbox SET lease_until_ms=GREATEST(lease_until_ms, ?)
        WHERE outbox_id=? AND claim_token=? AND lease_until_ms>?
          AND completed_at_ms IS NULL AND dead_lettered_at_ms IS NULL`,
      [leaseUntilMs, outboxId, claimToken, options.nowMs],
    );
    return result.affectedRows === 1;
  }

  async completeBlobDelete(outboxId: number, claimToken: string, completedAtMs: number): Promise<boolean> {
    validateBlobDeleteAck(outboxId, claimToken, completedAtMs);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [outboxes] = await conn.query<Row[]>(
        `SELECT blob_id, generation, claim_token, lease_until_ms, completed_at_ms, dead_lettered_at_ms
           FROM blob_delete_outbox WHERE outbox_id=? FOR UPDATE`,
        [outboxId],
      );
      const outbox = outboxes[0];
      if (
        !outbox
        || outbox.completed_at_ms != null
        || outbox.dead_lettered_at_ms != null
        || outbox.claim_token !== claimToken
        || outbox.lease_until_ms == null
        || Number(outbox.lease_until_ms) <= completedAtMs
      ) {
        await conn.rollback();
        return false;
      }
      const [blobs] = await conn.query<Row[]>(
        "SELECT state, deletion_generation FROM blob_objects WHERE blob_id=? FOR UPDATE",
        [outbox.blob_id],
      );
      const blob = blobs[0];
      if (!blob || blob.state !== "delete_pending" || Number(blob.deletion_generation) !== Number(outbox.generation)) {
        throw new BlobStateError(String(outbox.blob_id));
      }
      await conn.query(
        `UPDATE blob_objects
            SET state='deleted', sha256=NULL, size_bytes=NULL, content_type=NULL, uploaded_at_ms=NULL,
                ready_at_ms=NULL, delete_after_ms=NULL, deleted_at_ms=?
          WHERE blob_id=? AND state='delete_pending' AND deletion_generation=?`,
        [completedAtMs, outbox.blob_id, outbox.generation],
      );
      await conn.query(
        `UPDATE blob_delete_outbox
            SET completed_at_ms=?, claim_token=NULL, lease_until_ms=NULL, last_error=NULL
          WHERE outbox_id=?`,
        [completedAtMs, outboxId],
      );
      await conn.commit();
      return true;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async retryBlobDelete(outboxId: number, claimToken: string, options: RetryBlobDeleteOptions): Promise<boolean> {
    validateBlobDeleteAck(outboxId, claimToken, options.failedAtMs);
    if (!Number.isSafeInteger(options.availableAtMs) || options.availableAtMs < options.failedAtMs) {
      throw new Error("blob delete retry must not move backwards");
    }
    if (options.maxAttempts !== undefined && (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1)) {
      throw new Error("blob delete maxAttempts must be positive");
    }
    const error = sanitizeBlobDeleteError(options.error);
    if (options.maxAttempts === undefined) {
      const [result] = await this.pool.query<mysql.ResultSetHeader>(
        `UPDATE blob_delete_outbox
            SET claim_token=NULL, lease_until_ms=NULL, last_error=?, available_at_ms=?
          WHERE outbox_id=? AND claim_token=? AND lease_until_ms>?
            AND completed_at_ms IS NULL AND dead_lettered_at_ms IS NULL`,
        [error, options.availableAtMs, outboxId, claimToken, options.failedAtMs],
      );
      return result.affectedRows === 1;
    }
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE blob_delete_outbox
          SET claim_token=NULL, lease_until_ms=NULL, last_error=?,
              available_at_ms=CASE WHEN attempts>=? THEN available_at_ms ELSE ? END,
              dead_lettered_at_ms=CASE WHEN attempts>=? THEN ? ELSE NULL END
        WHERE outbox_id=? AND claim_token=? AND lease_until_ms>?
          AND completed_at_ms IS NULL AND dead_lettered_at_ms IS NULL`,
      [
        error,
        options.maxAttempts,
        options.availableAtMs,
        options.maxAttempts,
        options.failedAtMs,
        outboxId,
        claimToken,
        options.failedAtMs,
      ],
    );
    return result.affectedRows === 1;
  }

  async getBlobDeleteOutbox(blobId: string, generation: number): Promise<BlobDeleteOutboxRecord | null> {
    const [rows] = await this.pool.query<Row[]>(
      `SELECT ${BLOB_DELETE_COLUMNS}
         FROM blob_delete_outbox o
         JOIN blob_objects b ON b.blob_id=o.blob_id
        WHERE o.blob_id=? AND o.generation=?`,
      [blobId, generation],
    );
    return rows[0] ? rowToBlobDeleteOutbox(rows[0], false) : null;
  }

  async close() {
    await this.pool.end();
  }
}

async function upsertItem(conn: PoolConnection, it: Item, userId: string, exists: boolean) {
  if (exists) {
    await conn.query(
      `UPDATE items SET status=?, body=?, completed_at_ms=?
        WHERE item_id=? AND session_id=? AND user_id=?`,
      [it.status, json(it), it.completedAtMs ?? null, it.id, it.sessionId, userId],
    );
    return;
  }
  await conn.query(
    `INSERT INTO items
       (item_id, session_id, user_id, turn_id, seq, type, status, body, created_at_ms, completed_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [it.id, it.sessionId, userId, it.turnId, it.seq, it.type, it.status, json(it), it.createdAtMs, it.completedAtMs ?? null],
  );
}
async function upsertTurn(conn: PoolConnection, t: Turn, userId: string, exists: boolean) {
  if (exists) {
    await conn.query(
      `UPDATE turns SET status=?, stop_reason=?, seq_end=?, body=?, completed_at_ms=?
        WHERE turn_id=? AND session_id=? AND user_id=?`,
      [t.status, t.stopReason ?? null, t.seqEnd ?? null, json(t), t.completedAtMs ?? null, t.id, t.sessionId, userId],
    );
    return;
  }
  await conn.query(
    `INSERT INTO turns
       (turn_id, session_id, user_id, status, stop_reason, seq_start, seq_end, body,
        idempotency_key, started_at_ms, completed_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [t.id, t.sessionId, userId, t.status, t.stopReason ?? null, t.seqStart, t.seqEnd ?? null, json(t), t.idempotencyKey ?? null, t.startedAtMs, t.completedAtMs ?? null],
  );
}
async function upsertApproval(conn: PoolConnection, a: Approval, userId: string, exists: boolean) {
  if (exists) {
    await conn.query(
      `UPDATE approvals SET status=?, body=?
        WHERE approval_id=? AND session_id=? AND user_id=?`,
      [a.status, json(a), a.id, a.sessionId, userId],
    );
    return;
  }
  await conn.query(
    `INSERT INTO approvals
       (approval_id, session_id, user_id, turn_id, status, body, created_at_ms, expires_at_ms)
     VALUES (?,?,?,?,?,?,?,?)`,
    [a.id, a.sessionId, userId, a.turnId, a.status, json(a), a.createdAtMs, a.expiresAtMs],
  );
}
