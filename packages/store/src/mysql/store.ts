import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import mysql, { type Pool, type PoolConnection, type RowDataPacket } from "mysql2/promise";
import type { AgentDefinition, ApiKeyScope, Approval, Item, PersistedEvent, ProviderConfig, Session, TenantAuthPolicy, Turn, UsageQuery } from "@agent-service/protocol";
import { DEFAULT_AUTH_POLICY, DEFAULT_SCOPES } from "@agent-service/protocol";
import { FenceError, SessionGoneError, assignItemSeqs, type CommitBatch, type CommitResult, type Page, type ApiKeyRecord, type IdempotencyScope, type SessionStore, type TenantRecord, type UsageLedgerEntry } from "../types.js";

type Row = RowDataPacket;
const json = (v: unknown) => JSON.stringify(v);
const parse = <T>(v: unknown): T => (typeof v === "string" ? JSON.parse(v) : (v as T));

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

export interface MysqlStoreOptions {
  url: string;
  connectionLimit?: number;
  /** overrides migration discovery; useful in tests and unusual deployments */
  migrationsDir?: string;
  /** maximum time to wait for another runner to finish schema migration */
  migrationLockTimeoutSeconds?: number;
}

export class MysqlSessionStore implements SessionStore {
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
  async createSession(s: Session) {
    await this.pool.query(
      `INSERT INTO sessions (session_id, tenant_id, user_id, agent_id, agent_version, status, title, parent_session_id,
         last_seq, fence_token, context_epoch, usage_json, auto_approved_tools, metadata, created_at_ms, updated_at_ms, archived_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        s.id, s.tenantId, s.userId, s.agentId, s.agentVersion, json(s.status), s.title ?? null, s.parentSessionId ?? null,
        s.lastSeq, s.fenceToken, s.contextEpoch, json(s.usage), json(s.autoApprovedTools), json(s.metadata), s.createdAtMs, s.updatedAtMs, s.archivedAtMs ?? null,
      ],
    );
  }
  async getSession(tenantId: string, sessionId: string) {
    const [rows] = await this.pool.query<Row[]>(
      "SELECT * FROM sessions WHERE session_id=? AND tenant_id=? AND deleted_at_ms IS NULL",
      [sessionId, tenantId],
    );
    return rows[0] ? rowToSession(rows[0]) : null;
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
  async deleteSession(tenantId: string, sessionId: string) {
    // soft delete: data lifecycle job purges later (docs/design §14 #6)
    const [res] = await this.pool.query<mysql.ResultSetHeader>(
      "UPDATE sessions SET deleted_at_ms=? WHERE session_id=? AND tenant_id=? AND deleted_at_ms IS NULL",
      [Date.now(), sessionId, tenantId],
    );
    return res.affectedRows > 0;
  }

  // ---------- fenced commit ----------
  async commit(batch: CommitBatch): Promise<CommitResult> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query<Row[]>(
        "SELECT user_id, last_seq, fence_token, deleted_at_ms FROM sessions WHERE session_id=? FOR UPDATE",
        [batch.sessionId],
      );
      const head = rows[0];
      if (!head || head.deleted_at_ms != null) throw new SessionGoneError(batch.sessionId);
      const currentFence = Number(head.fence_token);
      if (batch.fence < currentFence) throw new FenceError(batch.sessionId, batch.fence, currentFence);
      const userId = head.user_id as string;
      let seq = Number(head.last_seq);
      const events: PersistedEvent[] = [];
      for (const e of batch.events ?? []) {
        seq += 1;
        events.push({ ...e, seq } as PersistedEvent);
      }
      assignItemSeqs(batch.items, events, seq);
      if (events.length) {
        await conn.query(
          "INSERT INTO events (session_id, seq, user_id, type, body, emitted_at_ms) VALUES ?",
          [events.map((e) => [batch.sessionId, e.seq, userId, e.type, json(e), e.emittedAtMs])],
        );
      }
      for (const it of batch.items ?? []) await upsertItem(conn, it, userId);
      if (batch.turn) await upsertTurn(conn, batch.turn, userId);
      for (const a of batch.approvals ?? []) await upsertApproval(conn, a, userId);

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
        if (p.archivedAtMs !== undefined) { sets.push("archived_at_ms=?"); params.push(p.archivedAtMs); }
      }
      params.push(batch.sessionId);
      await conn.query(`UPDATE sessions SET ${sets.join(", ")} WHERE session_id=?`, params);
      await conn.commit();
      return { events, lastSeq: seq };
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }

  // ---------- reads ----------
  async readEvents(sessionId: string, afterSeq: number, limit: number) {
    const [rows] = await this.pool.query<Row[]>(
      "SELECT body FROM events WHERE session_id=? AND seq>? ORDER BY seq ASC LIMIT ?",
      [sessionId, afterSeq, limit],
    );
    return rows.map((r) => parse<PersistedEvent>(r.body));
  }
  async getTurn(sessionId: string, turnId: string) {
    const [rows] = await this.pool.query<Row[]>("SELECT body FROM turns WHERE turn_id=? AND session_id=?", [turnId, sessionId]);
    return rows[0] ? parse<Turn>(rows[0].body) : null;
  }
  async listTurns(sessionId: string, opts: { cursor?: string; limit: number; sortDirection?: "asc" | "desc" }): Promise<Page<Turn>> {
    const desc = (opts.sortDirection ?? "desc") === "desc";
    const [rows] = await this.pool.query<Row[]>(
      `SELECT body FROM turns WHERE session_id=? ${opts.cursor ? `AND turn_id ${desc ? "<" : ">"} ?` : ""} ORDER BY turn_id ${desc ? "DESC" : "ASC"} LIMIT ?`,
      opts.cursor ? [sessionId, opts.cursor, opts.limit + 1] : [sessionId, opts.limit + 1],
    );
    const data = rows.slice(0, opts.limit).map((r) => parse<Turn>(r.body));
    return { data, nextCursor: rows.length > opts.limit ? (data.at(-1)?.id ?? null) : null };
  }
  async listItems(sessionId: string, opts: { turnId?: string; afterSeq?: number; limit: number; newestFirst?: boolean }) {
    const where = ["session_id=?"];
    const params: unknown[] = [sessionId];
    if (opts.turnId) { where.push("turn_id=?"); params.push(opts.turnId); }
    if (opts.afterSeq !== undefined) { where.push("seq>?"); params.push(opts.afterSeq); }
    params.push(opts.limit);
    // Take the newest rows when asked, then flip back to seq-ascending for the caller.
    const order = opts.newestFirst ? "DESC" : "ASC";
    const [rows] = await this.pool.query<Row[]>(
      `SELECT body FROM items WHERE ${where.join(" AND ")} ORDER BY seq ${order}, item_id ${order} LIMIT ?`,
      params,
    );
    const items = rows.map((r) => parse<Item>(r.body));
    return opts.newestFirst ? items.reverse() : items;
  }
  async getItem(sessionId: string, itemId: string) {
    const [rows] = await this.pool.query<Row[]>("SELECT body FROM items WHERE item_id=? AND session_id=?", [itemId, sessionId]);
    return rows[0] ? parse<Item>(rows[0].body) : null;
  }
  async listApprovals(sessionId: string, opts: { pendingOnly?: boolean }) {
    const [rows] = await this.pool.query<Row[]>(
      `SELECT body FROM approvals WHERE session_id=? ${opts.pendingOnly ? "AND status='pending'" : ""} ORDER BY created_at_ms ASC`,
      [sessionId],
    );
    return rows.map((r) => parse<Approval>(r.body));
  }
  async getApproval(sessionId: string, approvalId: string) {
    const [rows] = await this.pool.query<Row[]>("SELECT body FROM approvals WHERE approval_id=? AND session_id=?", [approvalId, sessionId]);
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
  async appendUsage(e: UsageLedgerEntry) {
    await this.pool.query(
      "INSERT INTO usage_ledger (tenant_id, user_id, session_id, turn_id, step, provider, model, usage_json, created_at_ms) VALUES (?,?,?,?,?,?,?,?,?)",
      [e.tenantId, e.userId, e.sessionId, e.turnId, e.step, e.provider, e.model, json(e.usage), e.createdAtMs],
    );
  }

  async queryUsage(tenantId: string, q: UsageQuery) {
    // Grouping keys are chosen from a fixed set, never interpolated from input.
    const keyExpr =
      q.groupBy === "user" ? "user_id"
      : q.groupBy === "session" ? "session_id"
      : q.groupBy === "model" ? "CONCAT(provider, '/', model)"
      : q.groupBy === "day" ? "DATE_FORMAT(FROM_UNIXTIME(created_at_ms/1000), '%Y-%m-%d')"
      : "'total'";
    const where = ["tenant_id=?"];
    const params: unknown[] = [tenantId];
    if (q.userId) { where.push("user_id=?"); params.push(q.userId); }
    if (q.sessionId) { where.push("session_id=?"); params.push(q.sessionId); }
    if (q.from !== undefined) { where.push("created_at_ms>=?"); params.push(q.from); }
    if (q.to !== undefined) { where.push("created_at_ms<?"); params.push(q.to); }
    params.push(q.limit);
    const [rows] = await this.pool.query<Row[]>(
      `SELECT ${keyExpr} AS k,
              COUNT(DISTINCT turn_id) AS turns,
              COUNT(*) AS steps,
              COALESCE(SUM(CAST(JSON_EXTRACT(usage_json,'$.inputTokens') AS UNSIGNED)),0) AS input_tokens,
              COALESCE(SUM(CAST(JSON_EXTRACT(usage_json,'$.outputTokens') AS UNSIGNED)),0) AS output_tokens,
              COALESCE(SUM(CAST(JSON_EXTRACT(usage_json,'$.cacheReadTokens') AS UNSIGNED)),0) AS cache_read_tokens,
              COALESCE(SUM(CAST(JSON_EXTRACT(usage_json,'$.cacheWriteTokens') AS UNSIGNED)),0) AS cache_write_tokens,
              COALESCE(SUM(CAST(JSON_EXTRACT(usage_json,'$.reasoningTokens') AS UNSIGNED)),0) AS reasoning_tokens,
              COALESCE(SUM(CAST(JSON_EXTRACT(usage_json,'$.totalTokens') AS UNSIGNED)),0) AS total_tokens,
              COALESCE(SUM(JSON_EXTRACT(usage_json,'$.costCNY')),0) AS cost
         FROM usage_ledger
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
  async reserveIdempotencyKey(scope: IdempotencyScope, key: string, ttlMs: number) {
    const now = Date.now();
    const params = [scope.tenantId, scope.userId, scope.sessionId, key];
    try {
      await this.pool.query(
        "INSERT INTO idempotency_keys (tenant_id, user_id, session_id, idem_key, value, expires_at_ms) VALUES (?,?,?,?,NULL,?)",
        [...params, now + ttlMs],
      );
      return { existing: null };
    } catch (err) {
      if ((err as { code?: string }).code !== "ER_DUP_ENTRY") throw err;
      const [rows] = await this.pool.query<Row[]>(
        "SELECT value, expires_at_ms FROM idempotency_keys WHERE tenant_id=? AND user_id=? AND session_id=? AND idem_key=?",
        params,
      );
      const r = rows[0];
      if (!r || Number(r.expires_at_ms) < now) {
        await this.pool.query(
          "REPLACE INTO idempotency_keys (tenant_id, user_id, session_id, idem_key, value, expires_at_ms) VALUES (?,?,?,?,NULL,?)",
          [...params, now + ttlMs],
        );
        return { existing: null };
      }
      return { existing: r.value ? parse<{ turnId: string; sessionId: string }>(r.value) : { turnId: "", sessionId: "" } };
    }
  }
  async releaseIdempotencyKey(scope: IdempotencyScope, key: string) {
    await this.pool.query(
      "DELETE FROM idempotency_keys WHERE tenant_id=? AND user_id=? AND session_id=? AND idem_key=? AND value IS NULL",
      [scope.tenantId, scope.userId, scope.sessionId, key],
    );
  }

  async completeIdempotencyKey(scope: IdempotencyScope, key: string, value: { turnId: string; sessionId: string }) {
    await this.pool.query(
      "UPDATE idempotency_keys SET value=? WHERE tenant_id=? AND user_id=? AND session_id=? AND idem_key=?",
      [json(value), scope.tenantId, scope.userId, scope.sessionId, key],
    );
  }

  async close() {
    await this.pool.end();
  }
}

async function upsertItem(conn: PoolConnection, it: Item, userId: string) {
  await conn.query(
    `INSERT INTO items (item_id, session_id, user_id, turn_id, seq, type, status, body, created_at_ms, completed_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE status=VALUES(status), body=VALUES(body), completed_at_ms=VALUES(completed_at_ms)`,
    [it.id, it.sessionId, userId, it.turnId, it.seq, it.type, it.status, json(it), it.createdAtMs, it.completedAtMs ?? null],
  );
}
async function upsertTurn(conn: PoolConnection, t: Turn, userId: string) {
  await conn.query(
    `INSERT INTO turns (turn_id, session_id, user_id, status, stop_reason, seq_start, seq_end, body, idempotency_key, started_at_ms, completed_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE status=VALUES(status), stop_reason=VALUES(stop_reason), seq_end=VALUES(seq_end), body=VALUES(body), completed_at_ms=VALUES(completed_at_ms)`,
    [t.id, t.sessionId, userId, t.status, t.stopReason ?? null, t.seqStart, t.seqEnd ?? null, json(t), t.idempotencyKey ?? null, t.startedAtMs, t.completedAtMs ?? null],
  );
}
async function upsertApproval(conn: PoolConnection, a: Approval, userId: string) {
  await conn.query(
    `INSERT INTO approvals (approval_id, session_id, user_id, turn_id, status, body, created_at_ms, expires_at_ms)
     VALUES (?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE status=VALUES(status), body=VALUES(body)`,
    [a.id, a.sessionId, userId, a.turnId, a.status, json(a), a.createdAtMs, a.expiresAtMs],
  );
}
