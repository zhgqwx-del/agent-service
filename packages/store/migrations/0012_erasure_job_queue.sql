-- Expand-only durable erasure job queue. This migration does not run an erasure worker, activate
-- session.purge, anonymize usage, or delete content. It only makes already-active request states
-- leaseable while policy-waiting and terminal states remain unavailable.
--
-- Every ALTER is guarded because MySQL DDL auto-commits before schema_migrations is recorded. The
-- INSERT trigger keeps a drained-but-not-yet-exited 0011 writer safe: its legacy gated INSERT omits
-- queue columns, so the database derives initial availability from updated_at_ms. Replaying after a
-- DROP/CREATE interruption backfills anything inserted in that small window without overwriting a
-- newer writer's retry time or live claim.

SET @has_erasure_available_at = (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'erasure_requests'
     AND column_name = 'available_at_ms'
);
SET @migration_sql = IF(
  @has_erasure_available_at = 0,
  'ALTER TABLE erasure_requests ADD COLUMN available_at_ms BIGINT NULL AFTER checksum',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_erasure_attempts = (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'erasure_requests'
     AND column_name = 'attempts'
);
SET @migration_sql = IF(
  @has_erasure_attempts = 0,
  'ALTER TABLE erasure_requests ADD COLUMN attempts INT UNSIGNED NOT NULL DEFAULT 0 AFTER available_at_ms',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_erasure_claim_token = (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'erasure_requests'
     AND column_name = 'claim_token'
);
SET @migration_sql = IF(
  @has_erasure_claim_token = 0,
  'ALTER TABLE erasure_requests ADD COLUMN claim_token VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL AFTER attempts',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_erasure_lease_until = (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'erasure_requests'
     AND column_name = 'lease_until_ms'
);
SET @migration_sql = IF(
  @has_erasure_lease_until = 0,
  'ALTER TABLE erasure_requests ADD COLUMN lease_until_ms BIGINT NULL AFTER claim_token',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_erasure_last_error_code = (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'erasure_requests'
     AND column_name = 'last_error_code'
);
SET @migration_sql = IF(
  @has_erasure_last_error_code = 0,
  'ALTER TABLE erasure_requests ADD COLUMN last_error_code VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL AFTER lease_until_ms',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_erasure_policy_version = (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'erasure_requests'
     AND column_name = 'policy_version'
);
SET @migration_sql = IF(
  @has_erasure_policy_version = 0,
  'ALTER TABLE erasure_requests ADD COLUMN policy_version VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL AFTER last_error_code',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_erasure_policy_hash = (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'erasure_requests'
     AND column_name = 'policy_hash'
);
SET @migration_sql = IF(
  @has_erasure_policy_hash = 0,
  'ALTER TABLE erasure_requests ADD COLUMN policy_hash CHAR(64) COLLATE utf8mb4_0900_as_cs NULL AFTER policy_version',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @erasure_claim_columns = (
  SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',')
    FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'erasure_requests'
     AND index_name = 'idx_erasure_requests_claim'
);
SET @erasure_claim_non_unique = (
  SELECT MAX(non_unique)
    FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'erasure_requests'
     AND index_name = 'idx_erasure_requests_claim'
);
SET @migration_sql = IF(
  @erasure_claim_columns IS NOT NULL
    AND (@erasure_claim_columns <> 'status,available_at_ms,lease_until_ms,request_id'
      OR @erasure_claim_non_unique <> 1),
  'ALTER TABLE erasure_requests DROP INDEX idx_erasure_requests_claim',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_erasure_claim_index = (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'erasure_requests'
     AND index_name = 'idx_erasure_requests_claim'
);
SET @migration_sql = IF(
  @has_erasure_claim_index = 0,
  'ALTER TABLE erasure_requests ADD KEY idx_erasure_requests_claim (status, available_at_ms, lease_until_ms, request_id)',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

DROP TRIGGER IF EXISTS trg_erasure_requests_job_bi;
CREATE TRIGGER trg_erasure_requests_job_bi
BEFORE INSERT ON erasure_requests
FOR EACH ROW
SET NEW.available_at_ms = CASE
  WHEN NEW.status IN ('gated','draining','tombstoning','reconciling_usage','purging')
    THEN COALESCE(NEW.available_at_ms, NEW.updated_at_ms)
  ELSE NULL
END;

-- A partial/corrupt claim pair must never become authority merely because one half survived.
UPDATE erasure_requests
   SET claim_token = NULL, lease_until_ms = NULL
 WHERE (claim_token IS NULL AND lease_until_ms IS NOT NULL)
    OR (claim_token IS NOT NULL AND lease_until_ms IS NULL);

-- 0011 had no bounded error column. Preserve an already-blocked row as a valid terminal record
-- without inventing an unbounded/raw failure string.
UPDATE erasure_requests
   SET last_error_code = 'legacy_blocked'
 WHERE status = 'blocked' AND last_error_code IS NULL;

-- Preserve a worker's future retry time and active claim on replay. Policy-waiting and terminal
-- states are always unavailable, even if a partially upgraded process wrote an unsafe value.
UPDATE erasure_requests
   SET available_at_ms = CASE
     WHEN status IN ('gated','draining','tombstoning','reconciling_usage','purging')
       THEN COALESCE(available_at_ms, updated_at_ms)
     ELSE NULL
   END,
       claim_token = CASE
         WHEN status IN ('gated','draining','tombstoning','reconciling_usage','purging')
           THEN claim_token
         ELSE NULL
       END,
       lease_until_ms = CASE
         WHEN status IN ('gated','draining','tombstoning','reconciling_usage','purging')
           THEN lease_until_ms
         ELSE NULL
       END
 WHERE (status IN ('gated','draining','tombstoning','reconciling_usage','purging')
          AND available_at_ms IS NULL)
    OR (status IN ('awaiting_purge_policy','blocked','completed')
          AND (available_at_ms IS NOT NULL OR claim_token IS NOT NULL OR lease_until_ms IS NOT NULL));
