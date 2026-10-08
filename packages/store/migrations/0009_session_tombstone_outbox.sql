-- Expand-only persistence for fenced session tombstones. Physical purge remains disabled: a NULL
-- purge_after_ms and NULL outbox available_at_ms are deliberately not claimable by future workers.
-- Every ALTER is restart-safe because MySQL DDL auto-commits before schema_migrations is recorded.

SET @has_purge_after = (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'sessions' AND column_name = 'purge_after_ms'
);
SET @migration_sql = IF(
  @has_purge_after = 0,
  'ALTER TABLE sessions ADD COLUMN purge_after_ms BIGINT NULL AFTER deleted_at_ms',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_deletion_generation = (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'sessions' AND column_name = 'deletion_generation'
);
SET @migration_sql = IF(
  @has_deletion_generation = 0,
  'ALTER TABLE sessions ADD COLUMN deletion_generation BIGINT NOT NULL DEFAULT 0 AFTER purge_after_ms',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_parent_lifecycle_index = (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'sessions' AND index_name = 'idx_sessions_parent_lifecycle'
);
SET @migration_sql = IF(
  @has_parent_lifecycle_index = 0,
  'ALTER TABLE sessions ADD KEY idx_sessions_parent_lifecycle (parent_session_id, deleted_at_ms)',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

CREATE TABLE IF NOT EXISTS lifecycle_outbox (
  outbox_id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  topic                 VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  aggregate_id          VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  generation            BIGINT NOT NULL,
  payload               JSON NOT NULL,
  available_at_ms       BIGINT NULL,
  attempts              INT UNSIGNED NOT NULL DEFAULT 0,
  claim_token           VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  lease_until_ms        BIGINT NULL,
  last_error            TEXT NULL,
  completed_at_ms       BIGINT NULL,
  dead_lettered_at_ms   BIGINT NULL,
  created_at_ms         BIGINT NOT NULL,
  UNIQUE KEY uk_lifecycle_outbox_identity (topic, aggregate_id, generation),
  KEY idx_lifecycle_outbox_claim (
    topic, completed_at_ms, dead_lettered_at_ms, available_at_ms, outbox_id, lease_until_ms
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A process may have stopped after CREATE TABLE auto-committed but before the migration marker was
-- recorded. Reconcile the claim index as well as the table so replay converges to the exact shape.
SET @claim_index_columns = (
  SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',')
    FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'lifecycle_outbox'
     AND index_name = 'idx_lifecycle_outbox_claim'
);
SET @migration_sql = IF(
  @claim_index_columns IS NOT NULL
    AND @claim_index_columns <> 'topic,completed_at_ms,dead_lettered_at_ms,available_at_ms,outbox_id,lease_until_ms',
  'ALTER TABLE lifecycle_outbox DROP INDEX idx_lifecycle_outbox_claim',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_claim_index = (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'lifecycle_outbox'
     AND index_name = 'idx_lifecycle_outbox_claim'
);
SET @migration_sql = IF(
  @has_claim_index = 0,
  'ALTER TABLE lifecycle_outbox ADD KEY idx_lifecycle_outbox_claim (topic, completed_at_ms, dead_lettered_at_ms, available_at_ms, outbox_id, lease_until_ms)',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
