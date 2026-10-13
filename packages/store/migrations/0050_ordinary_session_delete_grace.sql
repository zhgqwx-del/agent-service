-- Expand-only, default-dormant ordinary DELETE retention evidence. The origin and seal live on
-- sessions itself, so T3f removes them with the canonical owner row in its existing transaction.
-- No historical tombstone is backfilled; this never schedules or performs physical purge.

SET @has_col = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE()
  AND table_name='sessions' AND column_name='ordinary_delete_origin_sha256');
SET @migration_sql = IF(@has_col=0,
  'ALTER TABLE sessions ADD COLUMN ordinary_delete_origin_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL',
  'SELECT 1');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_col = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE()
  AND table_name='sessions' AND column_name='ordinary_delete_origin_observed_db_ms');
SET @migration_sql = IF(@has_col=0,
  'ALTER TABLE sessions ADD COLUMN ordinary_delete_origin_observed_db_ms BIGINT NULL',
  'SELECT 1');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_col = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE()
  AND table_name='sessions' AND column_name='ordinary_delete_seal_observed_db_ms');
SET @migration_sql = IF(@has_col=0,
  'ALTER TABLE sessions ADD COLUMN ordinary_delete_seal_observed_db_ms BIGINT NULL',
  'SELECT 1');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_col = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE()
  AND table_name='sessions' AND column_name='ordinary_delete_grace_floor_db_ms');
SET @migration_sql = IF(@has_col=0,
  'ALTER TABLE sessions ADD COLUMN ordinary_delete_grace_floor_db_ms BIGINT NULL',
  'SELECT 1');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_col = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE()
  AND table_name='sessions' AND column_name='ordinary_delete_seal_sha256');
SET @migration_sql = IF(@has_col=0,
  'ALTER TABLE sessions ADD COLUMN ordinary_delete_seal_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL',
  'SELECT 1');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_check = (SELECT COUNT(*) FROM information_schema.table_constraints
  WHERE table_schema=DATABASE() AND table_name='sessions'
    AND constraint_name='chk_sessions_ordinary_delete_grace_shape' AND constraint_type='CHECK');
SET @migration_sql = IF(@has_check=0,
  'ALTER TABLE sessions ADD CONSTRAINT chk_sessions_ordinary_delete_grace_shape CHECK ((ordinary_delete_origin_sha256 IS NULL AND ordinary_delete_origin_observed_db_ms IS NULL AND ordinary_delete_seal_observed_db_ms IS NULL AND ordinary_delete_grace_floor_db_ms IS NULL AND ordinary_delete_seal_sha256 IS NULL) OR (ordinary_delete_origin_sha256 IS NOT NULL AND ordinary_delete_origin_observed_db_ms IS NOT NULL AND ordinary_delete_origin_observed_db_ms >= 0 AND deleted_at_ms IS NOT NULL AND purge_after_ms IS NULL AND ((ordinary_delete_seal_observed_db_ms IS NULL AND ordinary_delete_grace_floor_db_ms IS NULL AND ordinary_delete_seal_sha256 IS NULL) OR (ordinary_delete_seal_observed_db_ms IS NOT NULL AND ordinary_delete_grace_floor_db_ms IS NOT NULL AND ordinary_delete_seal_sha256 IS NOT NULL AND ordinary_delete_seal_observed_db_ms >= ordinary_delete_origin_observed_db_ms AND ordinary_delete_grace_floor_db_ms = ordinary_delete_seal_observed_db_ms + 2592000001))))',
  'SELECT 1');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
