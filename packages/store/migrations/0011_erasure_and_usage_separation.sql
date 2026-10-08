-- Expand-only foundations for subject erasure/export and usage reconciliation. This migration does
-- not activate physical purge, anonymize any operational row, or copy historical usage into the
-- billing ledger. Old runners may continue to omit usage_id during the mixed-version window.
--
-- MySQL DDL auto-commits before schema_migrations is recorded. The guarded ALTER statements and
-- CREATE TABLE IF NOT EXISTS statements therefore make replay after any committed DDL safe. The
-- subject backfill is insert-only and must never reset a subject that a newer writer already gated.

SET @has_usage_id = (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'usage_ledger' AND column_name = 'usage_id'
);
SET @migration_sql = IF(
  @has_usage_id = 0,
  'ALTER TABLE usage_ledger ADD COLUMN usage_id VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL AFTER id',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- A nullable unique identity supports dual-write rollout: new writers get stable, byte-sensitive
-- idempotency while any number of legacy rows/writers may still have NULL.
SET @usage_identity_columns = (
  SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',')
    FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'usage_ledger'
     AND index_name = 'uk_usage_ledger_usage_id'
);
SET @usage_identity_non_unique = (
  SELECT MAX(non_unique)
    FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'usage_ledger'
     AND index_name = 'uk_usage_ledger_usage_id'
);
SET @migration_sql = IF(
  @usage_identity_columns IS NOT NULL
    AND (@usage_identity_columns <> 'usage_id' OR @usage_identity_non_unique <> 0),
  'ALTER TABLE usage_ledger DROP INDEX uk_usage_ledger_usage_id',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_usage_identity = (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'usage_ledger'
     AND index_name = 'uk_usage_ledger_usage_id'
);
SET @migration_sql = IF(
  @has_usage_identity = 0,
  'ALTER TABLE usage_ledger ADD UNIQUE KEY uk_usage_ledger_usage_id (usage_id)',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- Long-lived billing facts deliberately contain only an opaque usage identity, tenant/accounting
-- dimensions, normalized counters and integrity metadata. In particular there is no user/session/
-- turn/step identity and no raw usage JSON, prompt, item or idempotency key.
CREATE TABLE IF NOT EXISTS billing_usage_facts (
  usage_id                 VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  tenant_id                VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  accounting_period        CHAR(7)      COLLATE utf8mb4_0900_as_cs NOT NULL,
  provider                 VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  model                    VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  input_tokens             BIGINT UNSIGNED NOT NULL,
  output_tokens            BIGINT UNSIGNED NOT NULL,
  cache_read_tokens        BIGINT UNSIGNED NOT NULL,
  cache_write_tokens       BIGINT UNSIGNED NOT NULL,
  reasoning_tokens         BIGINT UNSIGNED NOT NULL,
  total_tokens             BIGINT UNSIGNED NOT NULL,
  cost_cny                 DECIMAL(24,9) NULL,
  currency                 CHAR(3)      COLLATE utf8mb4_0900_as_cs NOT NULL,
  fact_sha256              CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  KEY idx_billing_usage_tenant_period
    (tenant_id, accounting_period, provider, model, usage_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Reconciliation remains operational data until anonymization completes. It is owner-scoped and
-- records only counts/totals/checksums, never content or raw usage JSON. A NULL cost distinguishes
-- "no priced rows" from a known zero cost.
CREATE TABLE IF NOT EXISTS usage_reconciliations (
  tenant_id                VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  user_id                  VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  session_id               VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  deletion_generation      BIGINT UNSIGNED NOT NULL,
  status                   VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  row_count                BIGINT UNSIGNED NOT NULL,
  input_tokens             BIGINT UNSIGNED NOT NULL,
  output_tokens            BIGINT UNSIGNED NOT NULL,
  cache_read_tokens        BIGINT UNSIGNED NOT NULL,
  cache_write_tokens       BIGINT UNSIGNED NOT NULL,
  reasoning_tokens         BIGINT UNSIGNED NOT NULL,
  total_tokens             BIGINT UNSIGNED NOT NULL,
  known_cost_rows          BIGINT UNSIGNED NOT NULL,
  cost_cny                 DECIMAL(24,9) NULL,
  checksum                 CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  verified_at_ms           BIGINT NOT NULL,
  anonymized_at_ms         BIGINT NULL,
  created_at_ms            BIGINT NOT NULL,
  updated_at_ms            BIGINT NOT NULL,
  PRIMARY KEY (session_id, deletion_generation),
  KEY idx_usage_reconciliations_owner
    (tenant_id, user_id, session_id, deletion_generation),
  KEY idx_usage_reconciliations_status
    (status, updated_at_ms, session_id, deletion_generation)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- This row is the transaction gate checked by create/turn paths. generation starts at zero and is
-- advanced by a successful erasure gate; legal hold may pause irreversible work but never restore
-- normal API visibility. active_request_id is unique so one request cannot gate two subjects.
CREATE TABLE IF NOT EXISTS subject_lifecycle (
  tenant_id                VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_kind             VARCHAR(16)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_id               VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  state                    VARCHAR(16)  COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'active',
  generation               BIGINT UNSIGNED NOT NULL DEFAULT 0,
  active_request_id        VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NULL,
  legal_hold_at_ms         BIGINT NULL,
  created_at_ms            BIGINT NOT NULL,
  updated_at_ms            BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, subject_kind, subject_id),
  UNIQUE KEY uk_subject_lifecycle_active_request (active_request_id),
  KEY idx_subject_lifecycle_state
    (state, updated_at_ms, tenant_id, subject_kind, subject_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE IF NOT EXISTS erasure_requests (
  request_id               VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  tenant_id                VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_kind             VARCHAR(16)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_id               VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  generation               BIGINT UNSIGNED NOT NULL,
  status                   VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  requested_by_key_id      VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  idempotency_key          VARCHAR(256) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_hash             CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  created_at_ms            BIGINT NOT NULL,
  gated_at_ms              BIGINT NULL,
  updated_at_ms            BIGINT NOT NULL,
  completed_at_ms          BIGINT NULL,
  counts_json              JSON NULL,
  checksum                 CHAR(64)     COLLATE utf8mb4_0900_as_cs NULL,
  UNIQUE KEY uk_erasure_requests_subject_generation
    (tenant_id, subject_kind, subject_id, generation),
  UNIQUE KEY uk_erasure_requests_idempotency
    (tenant_id, subject_kind, subject_id, idempotency_key),
  KEY idx_erasure_requests_status
    (status, updated_at_ms, request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- The application restricts payload to audit metadata/counts/checksums. Content snapshots, prompts,
-- tool arguments and raw identifiers beyond the request ownership must never be written here.
CREATE TABLE IF NOT EXISTS erasure_audit_events (
  request_id               VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  seq                      BIGINT UNSIGNED NOT NULL,
  event_type               VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  payload                  JSON NOT NULL,
  emitted_at_ms            BIGINT NOT NULL,
  PRIMARY KEY (request_id, seq),
  KEY idx_erasure_audit_events_emitted (emitted_at_ms, request_id, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Keep legacy 0010 session writers compatible during expand -> activate. The trigger body is one
-- INSERT statement (rather than BEGIN/END with internal delimiters), so the application's simple
-- migration splitter can execute it unchanged. INSERT IGNORE is intentionally insert-only: a
-- legacy writer can materialize missing active rows, but can never reset deleting/erased state,
-- generation, active_request_id or legal_hold_at_ms.
--
-- MySQL 8.0.26 has no portable CREATE TRIGGER IF NOT EXISTS. Replays therefore replace this
-- deterministic trigger, then run the insert-only backfill below. If a process dies after DROP or a
-- legacy insert lands in the small DROP/CREATE window, the next replay's backfill repairs that gap
-- without changing any lifecycle row that already exists.
DROP TRIGGER IF EXISTS trg_sessions_subject_lifecycle_ai;
CREATE TRIGGER trg_sessions_subject_lifecycle_ai
AFTER INSERT ON sessions
FOR EACH ROW
INSERT IGNORE INTO subject_lifecycle
  (tenant_id, subject_kind, subject_id, state, generation, active_request_id,
   legal_hold_at_ms, created_at_ms, updated_at_ms)
VALUES
  (NEW.tenant_id, 'tenant', NEW.tenant_id, 'active', 0, NULL, NULL,
   NEW.created_at_ms, NEW.created_at_ms),
  (NEW.tenant_id, 'user', NEW.user_id, 'active', 0, NULL, NULL,
   NEW.created_at_ms, NEW.updated_at_ms);

-- Freeze an initial gate row for every known tenant and every subject represented by a session.
-- ON DUPLICATE is intentionally a no-op: replay must preserve deleting/erased state, generation,
-- legal hold and the active request written after a partially applied migration. These statements
-- also close the DROP/CREATE recovery window described above.
INSERT INTO subject_lifecycle
  (tenant_id, subject_kind, subject_id, state, generation, active_request_id,
   legal_hold_at_ms, created_at_ms, updated_at_ms)
SELECT tenant_id, 'tenant', tenant_id, 'active', 0, NULL, NULL, created_at_ms, created_at_ms
  FROM tenants
ON DUPLICATE KEY UPDATE subject_id = subject_lifecycle.subject_id;

-- Historical/local rows may predate an explicit tenant record, so sessions are also an ownership
-- source for the tenant gate. Existing rows from the authoritative tenants table remain untouched.
INSERT INTO subject_lifecycle
  (tenant_id, subject_kind, subject_id, state, generation, active_request_id,
   legal_hold_at_ms, created_at_ms, updated_at_ms)
SELECT tenant_id, 'tenant', tenant_id, 'active', 0, NULL, NULL,
       MIN(created_at_ms), MAX(updated_at_ms)
  FROM sessions
 GROUP BY tenant_id
ON DUPLICATE KEY UPDATE subject_id = subject_lifecycle.subject_id;

INSERT INTO subject_lifecycle
  (tenant_id, subject_kind, subject_id, state, generation, active_request_id,
   legal_hold_at_ms, created_at_ms, updated_at_ms)
SELECT tenant_id, 'user', user_id, 'active', 0, NULL, NULL,
       MIN(created_at_ms), MAX(updated_at_ms)
  FROM sessions
 GROUP BY tenant_id, user_id
ON DUPLICATE KEY UPDATE subject_id = subject_lifecycle.subject_id;
