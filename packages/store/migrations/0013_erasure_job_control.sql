-- Expand-only erasure job quarantine/control/terminal-incident substrate. This migration does not
-- quarantine any existing request, repair or resume any job, activate session.purge, anonymize
-- usage, delete content, or mark an erasure request completed. The 0012 claim index remains
-- available during a rolling upgrade; v2 workers use additive 0013 state only after activation.
--
-- MySQL DDL auto-commits before schema_migrations is recorded, so every ALTER is guarded and the
-- table/index/trigger setup is safe to replay after a partial migration or a lost marker.

SET @has_erasure_control_generation = (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'erasure_requests'
     AND column_name = 'control_generation'
);
SET @migration_sql = IF(
  @has_erasure_control_generation = 0,
  'ALTER TABLE erasure_requests ADD COLUMN control_generation BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER policy_hash',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_erasure_quarantined_at = (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'erasure_requests'
     AND column_name = 'quarantined_at_ms'
);
SET @migration_sql = IF(
  @has_erasure_quarantined_at = 0,
  'ALTER TABLE erasure_requests ADD COLUMN quarantined_at_ms BIGINT NULL AFTER control_generation',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_erasure_quarantine_reason = (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'erasure_requests'
     AND column_name = 'quarantine_reason_code'
);
SET @migration_sql = IF(
  @has_erasure_quarantine_reason = 0,
  'ALTER TABLE erasure_requests ADD COLUMN quarantine_reason_code VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL AFTER quarantined_at_ms',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_erasure_quarantine_evidence = (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'erasure_requests'
     AND column_name = 'quarantine_evidence_sha256'
);
SET @migration_sql = IF(
  @has_erasure_quarantine_evidence = 0,
  'ALTER TABLE erasure_requests ADD COLUMN quarantine_evidence_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL AFTER quarantine_reason_code',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

CREATE TABLE IF NOT EXISTS erasure_job_control_events (
  control_event_id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  request_id               VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  control_generation       BIGINT UNSIGNED NOT NULL,
  event_type               VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  phase                    VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  reason_code              VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  action_code              VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL,
  actor_key_id             VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  before_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  after_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  emitted_at_ms            BIGINT NOT NULL,
  UNIQUE KEY uk_erasure_job_control_event_generation
    (request_id, control_generation),
  KEY idx_erasure_job_control_events_request
    (request_id, control_event_id),
  KEY idx_erasure_job_control_events_emitted
    (event_type, emitted_at_ms, control_event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- A request whose own isolation coordinates are corrupt cannot safely use the normal quarantine
-- overlay/control chain. Preserve one content-free terminal incident instead: request_id is only a
-- stable row locator, the exact unsigned fence supports durable CAS/audit, and the hash binds every
-- raw envelope field without copying tenant/user/subject identity or payload into this table.
CREATE TABLE IF NOT EXISTS erasure_job_terminal_incidents (
  terminal_incident_id      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  request_id                VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  raw_control_generation    BIGINT UNSIGNED NOT NULL,
  reason_code               VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  evidence_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  emitted_at_ms             BIGINT NOT NULL,
  UNIQUE KEY uk_erasure_job_terminal_incident_request (request_id),
  KEY idx_erasure_job_terminal_incidents_emitted
    (reason_code, emitted_at_ms, terminal_incident_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Early 0013 development builds used event_type as a third unique-key column. That shape permits
-- two different control facts to occupy the same logical generation. Converge partial DDL and
-- marker-loss replay to one event per request/generation. Build the stronger key under a temporary
-- name before dropping the weaker key: if conflicting evidence exists, ADD UNIQUE intentionally
-- fails while the old uniqueness boundary and both evidence rows remain intact. Every subsequent
-- DDL is replay-safe across MySQL's implicit commits.
SET @erasure_control_generation_columns = (
  SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',')
    FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'erasure_job_control_events'
     AND index_name = 'uk_erasure_job_control_event_generation'
);
SET @erasure_control_generation_non_unique = (
  SELECT MAX(non_unique)
    FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'erasure_job_control_events'
     AND index_name = 'uk_erasure_job_control_event_generation'
);
SET @erasure_control_generation_v2_columns = (
  SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',')
    FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'erasure_job_control_events'
     AND index_name = 'uk_erasure_job_control_event_generation_v2'
);
SET @erasure_control_generation_v2_non_unique = (
  SELECT MAX(non_unique)
    FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'erasure_job_control_events'
     AND index_name = 'uk_erasure_job_control_event_generation_v2'
);
SET @migration_sql = IF(
  @erasure_control_generation_columns = 'request_id,control_generation'
    AND @erasure_control_generation_non_unique = 0,
  'SELECT 1',
  IF(
    @erasure_control_generation_v2_columns IS NULL,
    'ALTER TABLE erasure_job_control_events ADD UNIQUE KEY uk_erasure_job_control_event_generation_v2 (request_id, control_generation)',
    IF(
      @erasure_control_generation_v2_columns = 'request_id,control_generation'
        AND @erasure_control_generation_v2_non_unique = 0,
      'SELECT 1',
      -- Deliberately fail on a malformed temporary key without weakening the canonical key.
      'ALTER TABLE erasure_job_control_events ADD UNIQUE KEY uk_erasure_job_control_event_generation_v2 (request_id, control_generation)'
    )
  )
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @erasure_control_generation_v2_columns = (
  SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',')
    FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'erasure_job_control_events'
     AND index_name = 'uk_erasure_job_control_event_generation_v2'
);
SET @erasure_control_generation_v2_non_unique = (
  SELECT MAX(non_unique)
    FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'erasure_job_control_events'
     AND index_name = 'uk_erasure_job_control_event_generation_v2'
);
SET @migration_sql = IF(
  @erasure_control_generation_columns IS NOT NULL
    AND (@erasure_control_generation_columns <> 'request_id,control_generation'
      OR @erasure_control_generation_non_unique <> 0)
    AND @erasure_control_generation_v2_columns = 'request_id,control_generation'
    AND @erasure_control_generation_v2_non_unique = 0,
  'ALTER TABLE erasure_job_control_events DROP INDEX uk_erasure_job_control_event_generation',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_erasure_control_generation_index = (
  SELECT COUNT(DISTINCT index_name) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'erasure_job_control_events'
     AND index_name = 'uk_erasure_job_control_event_generation'
);
SET @migration_sql = IF(
  @has_erasure_control_generation_index = 0
    AND @erasure_control_generation_v2_columns = 'request_id,control_generation'
    AND @erasure_control_generation_v2_non_unique = 0,
  'ALTER TABLE erasure_job_control_events RENAME INDEX uk_erasure_job_control_event_generation_v2 TO uk_erasure_job_control_event_generation',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @erasure_control_generation_columns = (
  SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',')
    FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'erasure_job_control_events'
     AND index_name = 'uk_erasure_job_control_event_generation'
);
SET @erasure_control_generation_non_unique = (
  SELECT MAX(non_unique)
    FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'erasure_job_control_events'
     AND index_name = 'uk_erasure_job_control_event_generation'
);
SET @has_erasure_control_generation_v2_index = (
  SELECT COUNT(DISTINCT index_name) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'erasure_job_control_events'
     AND index_name = 'uk_erasure_job_control_event_generation_v2'
);
SET @migration_sql = IF(
  @erasure_control_generation_columns = 'request_id,control_generation'
    AND @erasure_control_generation_non_unique = 0
    AND @has_erasure_control_generation_v2_index > 0,
  'ALTER TABLE erasure_job_control_events DROP INDEX uk_erasure_job_control_event_generation_v2',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @erasure_claim_v2_columns = (
  SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',')
    FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'erasure_requests'
     AND index_name = 'idx_erasure_requests_claim_v2'
);
SET @erasure_claim_v2_non_unique = (
  SELECT MAX(non_unique)
    FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'erasure_requests'
     AND index_name = 'idx_erasure_requests_claim_v2'
);
SET @migration_sql = IF(
  @erasure_claim_v2_columns IS NOT NULL
    AND (@erasure_claim_v2_columns <> 'quarantined_at_ms,status,available_at_ms,lease_until_ms,request_id'
      OR @erasure_claim_v2_non_unique <> 1),
  'ALTER TABLE erasure_requests DROP INDEX idx_erasure_requests_claim_v2',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_erasure_claim_v2_index = (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'erasure_requests'
     AND index_name = 'idx_erasure_requests_claim_v2'
);
SET @migration_sql = IF(
  @has_erasure_claim_v2_index = 0,
  'ALTER TABLE erasure_requests ADD KEY idx_erasure_requests_claim_v2 (quarantined_at_ms, status, available_at_ms, lease_until_ms, request_id)',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- Control events are an append-only maintenance audit. MySQL only gained CREATE TRIGGER IF NOT
-- EXISTS in 8.0.29, while the supported local baseline includes 8.0.26. Keep three equivalent
-- permanent guards per mutation and use a fourth bootstrap guard while rotating them. Once 0013
-- has completed at least once, replay (including replay interrupted between any two statements)
-- always leaves at least one guard active. A first-ever install has no writer for this new table
-- until migration completes, and the bootstrap becomes the first guard before any permanent one is
-- replaced. Runtime credentials remain insert-only in deployed environments as a second boundary.

DROP TRIGGER IF EXISTS trg_erasure_job_control_events_bu_bootstrap;
CREATE TRIGGER trg_erasure_job_control_events_bu_bootstrap
BEFORE UPDATE ON erasure_job_control_events
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure job control events are append-only';

DROP TRIGGER IF EXISTS trg_erasure_job_control_events_bu;
CREATE TRIGGER trg_erasure_job_control_events_bu
BEFORE UPDATE ON erasure_job_control_events
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure job control events are append-only';

DROP TRIGGER IF EXISTS trg_erasure_job_control_events_bu_guard_a;
CREATE TRIGGER trg_erasure_job_control_events_bu_guard_a
BEFORE UPDATE ON erasure_job_control_events
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure job control events are append-only';

DROP TRIGGER IF EXISTS trg_erasure_job_control_events_bu_guard_b;
CREATE TRIGGER trg_erasure_job_control_events_bu_guard_b
BEFORE UPDATE ON erasure_job_control_events
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure job control events are append-only';

DROP TRIGGER IF EXISTS trg_erasure_job_control_events_bu_bootstrap;

DROP TRIGGER IF EXISTS trg_erasure_job_control_events_bd_bootstrap;
CREATE TRIGGER trg_erasure_job_control_events_bd_bootstrap
BEFORE DELETE ON erasure_job_control_events
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure job control events are append-only';

DROP TRIGGER IF EXISTS trg_erasure_job_control_events_bd;
CREATE TRIGGER trg_erasure_job_control_events_bd
BEFORE DELETE ON erasure_job_control_events
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure job control events are append-only';

DROP TRIGGER IF EXISTS trg_erasure_job_control_events_bd_guard_a;
CREATE TRIGGER trg_erasure_job_control_events_bd_guard_a
BEFORE DELETE ON erasure_job_control_events
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure job control events are append-only';

DROP TRIGGER IF EXISTS trg_erasure_job_control_events_bd_guard_b;
CREATE TRIGGER trg_erasure_job_control_events_bd_guard_b
BEFORE DELETE ON erasure_job_control_events
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure job control events are append-only';

DROP TRIGGER IF EXISTS trg_erasure_job_control_events_bd_bootstrap;

-- Terminal incidents are append-only for the same reason as ordinary control events. Keep their
-- guards independent so replay of either table cannot create a mutation window in the other.
DROP TRIGGER IF EXISTS trg_erasure_job_terminal_incidents_bu_bootstrap;
CREATE TRIGGER trg_erasure_job_terminal_incidents_bu_bootstrap
BEFORE UPDATE ON erasure_job_terminal_incidents
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure job terminal incidents are append-only';

DROP TRIGGER IF EXISTS trg_erasure_job_terminal_incidents_bu;
CREATE TRIGGER trg_erasure_job_terminal_incidents_bu
BEFORE UPDATE ON erasure_job_terminal_incidents
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure job terminal incidents are append-only';

DROP TRIGGER IF EXISTS trg_erasure_job_terminal_incidents_bu_guard_a;
CREATE TRIGGER trg_erasure_job_terminal_incidents_bu_guard_a
BEFORE UPDATE ON erasure_job_terminal_incidents
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure job terminal incidents are append-only';

DROP TRIGGER IF EXISTS trg_erasure_job_terminal_incidents_bu_guard_b;
CREATE TRIGGER trg_erasure_job_terminal_incidents_bu_guard_b
BEFORE UPDATE ON erasure_job_terminal_incidents
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure job terminal incidents are append-only';

DROP TRIGGER IF EXISTS trg_erasure_job_terminal_incidents_bu_bootstrap;

DROP TRIGGER IF EXISTS trg_erasure_job_terminal_incidents_bd_bootstrap;
CREATE TRIGGER trg_erasure_job_terminal_incidents_bd_bootstrap
BEFORE DELETE ON erasure_job_terminal_incidents
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure job terminal incidents are append-only';

DROP TRIGGER IF EXISTS trg_erasure_job_terminal_incidents_bd;
CREATE TRIGGER trg_erasure_job_terminal_incidents_bd
BEFORE DELETE ON erasure_job_terminal_incidents
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure job terminal incidents are append-only';

DROP TRIGGER IF EXISTS trg_erasure_job_terminal_incidents_bd_guard_a;
CREATE TRIGGER trg_erasure_job_terminal_incidents_bd_guard_a
BEFORE DELETE ON erasure_job_terminal_incidents
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure job terminal incidents are append-only';

DROP TRIGGER IF EXISTS trg_erasure_job_terminal_incidents_bd_guard_b;
CREATE TRIGGER trg_erasure_job_terminal_incidents_bd_guard_b
BEFORE DELETE ON erasure_job_terminal_incidents
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure job terminal incidents are append-only';

DROP TRIGGER IF EXISTS trg_erasure_job_terminal_incidents_bd_bootstrap;
