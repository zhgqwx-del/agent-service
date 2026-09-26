-- New builds write only completed receipts. Do not bulk-delete or replace legacy pending rows here:
-- an older runner may still issue its unconditional completion UPDATE during a rolling upgrade.
-- Drain every legacy runner first; only then may operations clean expired pending rows.

SET @has_request_hash = (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'idempotency_keys' AND column_name = 'request_hash'
);
SET @migration_sql = IF(
  @has_request_hash = 0,
  'ALTER TABLE idempotency_keys ADD COLUMN request_hash CHAR(64) COLLATE utf8mb4_0900_as_cs NULL AFTER idem_key',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_idempotency_expiry_index = (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'idempotency_keys' AND index_name = 'idx_idempotency_expires'
);
SET @migration_sql = IF(
  @has_idempotency_expiry_index = 0,
  'ALTER TABLE idempotency_keys ADD KEY idx_idempotency_expires (expires_at_ms)',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- Old code never retried ledger writes, so duplicates should not normally exist. Remove only byte-for-
-- byte equivalent duplicates; conflicting accounting rows deliberately make the unique-index DDL fail
-- so an operator can audit them instead of silently discarding billable usage.
DELETE newer FROM usage_ledger newer
JOIN usage_ledger older
  ON BINARY newer.session_id = BINARY older.session_id
 AND BINARY newer.turn_id = BINARY older.turn_id
 AND newer.step = older.step
 AND BINARY newer.tenant_id = BINARY older.tenant_id
 AND BINARY newer.user_id = BINARY older.user_id
 AND BINARY newer.provider = BINARY older.provider
 AND BINARY newer.model = BINARY older.model
 AND newer.usage_json = older.usage_json
 AND newer.created_at_ms = older.created_at_ms
 AND newer.id > older.id;

SET @has_usage_identity = (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'usage_ledger' AND index_name = 'uk_usage_session_turn_step'
);
SET @migration_sql = IF(
  @has_usage_identity = 0,
  'ALTER TABLE usage_ledger ADD UNIQUE KEY uk_usage_session_turn_step (session_id, turn_id, step)',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
