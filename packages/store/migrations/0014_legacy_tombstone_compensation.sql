-- Expand-only substrate for compensating sessions deleted by pre-0009 writers. This migration
-- does not activate the cutover, enqueue work, change any session, synthesize lifecycle evidence,
-- make session.purge available, or delete content. Runtime activation and compensation are separate,
-- explicitly gated maintenance operations.
--
-- The singleton starts inactive so mixed-version writers keep working during expand. At activation,
-- every sessions INSERT/UPDATE takes a shared lock on the singleton while the activating transaction
-- takes its exclusive row lock. The linearization point therefore drains writes which observed the
-- inactive state and makes later legacy `deleted_at_ms != NULL, deletion_generation = 0` writes fail.
-- Activation is irreversible; after it commits, pre-0014 session writers must not be restored.
--
-- MySQL DDL auto-commits before schema_migrations is recorded. CREATE TABLE, guarded index repair,
-- and bootstrap trigger rotation make replay safe after partial DDL or a lost migration marker.

CREATE TABLE IF NOT EXISTS legacy_tombstone_cutover (
  singleton_id              TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  control_generation        BIGINT UNSIGNED NOT NULL DEFAULT 0,
  activated_at_ms           BIGINT NULL,
  actor_key_id              VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  evidence_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  CONSTRAINT chk_legacy_tombstone_cutover_singleton
    CHECK (singleton_id = 1),
  CONSTRAINT chk_legacy_tombstone_cutover_state
    CHECK (
      (control_generation = 0 AND activated_at_ms IS NULL
        AND actor_key_id IS NULL AND evidence_sha256 IS NULL)
      OR
      (control_generation = 1 AND activated_at_ms IS NOT NULL
        AND actor_key_id IS NOT NULL AND evidence_sha256 IS NOT NULL)
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- INSERT ... SELECT avoids ON DUPLICATE KEY UPDATE: after activation even a no-op UPDATE is
-- deliberately rejected by the write-once guards installed below.
INSERT INTO legacy_tombstone_cutover
  (singleton_id, control_generation, activated_at_ms, actor_key_id, evidence_sha256)
SELECT 1, 0, NULL, NULL, NULL
 WHERE NOT EXISTS (
   SELECT 1 FROM legacy_tombstone_cutover WHERE singleton_id = 1
 );

-- One durable job per session lets a bounded maintenance worker survive process crashes, isolate a
-- deterministic poison candidate, and resume without treating an operator's in-memory cursor as
-- completion evidence. A global `maintenance` scan binds the enqueue actor but has no erasure
-- request; an `erasure_claim` source binds request/generation/attempt and only a one-way token hash.
-- Plain upstream or job claim tokens are never copied into audit fields.
CREATE TABLE IF NOT EXISTS legacy_tombstone_compensation_jobs (
  job_id                    VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  session_id                VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                 VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  user_id                   VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_kind               VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_request_id         VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  source_subject_generation BIGINT UNSIGNED NULL,
  source_claim_attempt      INT UNSIGNED NULL,
  source_claim_token_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  maintenance_actor_key_id  VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  source_deleted_at_ms      BIGINT NOT NULL,
  source_last_seq           BIGINT NOT NULL,
  candidate_sha256          CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  status                    VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  control_generation        BIGINT UNSIGNED NOT NULL,
  available_at_ms           BIGINT NULL,
  attempts                  INT UNSIGNED NOT NULL DEFAULT 0,
  claim_token               VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  lease_until_ms            BIGINT NULL,
  last_error_code           VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL,
  created_at_ms             BIGINT NOT NULL,
  updated_at_ms             BIGINT NOT NULL,
  completed_at_ms           BIGINT NULL,
  completed_event_seq       BIGINT NULL,
  completed_claim_attempt   INT UNSIGNED NULL,
  completed_claim_token_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  terminal_at_ms            BIGINT NULL,
  terminal_reason_code      VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL,
  terminal_evidence_sha256  CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  CONSTRAINT chk_legacy_tombstone_compensation_job_source
    CHECK (
      (source_kind = 'erasure_claim'
        AND source_request_id IS NOT NULL
        AND source_subject_generation IS NOT NULL
        AND source_claim_attempt IS NOT NULL
        AND source_claim_token_sha256 IS NOT NULL
        AND maintenance_actor_key_id IS NULL)
      OR
      (source_kind = 'maintenance'
        AND source_request_id IS NULL
        AND source_subject_generation IS NULL
        AND source_claim_attempt IS NULL
        AND source_claim_token_sha256 IS NULL
        AND maintenance_actor_key_id IS NOT NULL)
    ),
  CONSTRAINT chk_legacy_tombstone_compensation_job_cutover
    CHECK (control_generation = 1),
  UNIQUE KEY uk_legacy_tombstone_compensation_job_session (session_id),
  KEY idx_legacy_tombstone_compensation_jobs_claim
    (status, available_at_ms, lease_until_ms, job_id),
  KEY idx_legacy_tombstone_compensation_jobs_owner
    (tenant_id, user_id, session_id),
  KEY idx_legacy_tombstone_compensation_jobs_source
    (source_request_id, session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Content-free, append-only results bind each maintenance decision to exact before/after evidence.
-- Successful evidence is written in the same future transaction as the terminal event, both
-- lifecycle intents, the generation transition and job completion. There is intentionally no FK:
-- the audit must survive eventual session/job content contraction.
CREATE TABLE IF NOT EXISTS legacy_tombstone_compensation_events (
  result_event_id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  job_id                    VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  session_id                VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  control_generation        BIGINT UNSIGNED NOT NULL,
  event_type                VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  reason_code               VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL,
  actor_key_id              VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  claim_attempt             INT UNSIGNED NULL,
  source_deleted_at_ms      BIGINT NOT NULL,
  target_deletion_generation BIGINT UNSIGNED NULL,
  terminal_event_seq        BIGINT NULL,
  before_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  after_sha256              CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  emitted_at_ms             BIGINT NOT NULL,
  UNIQUE KEY uk_legacy_tombstone_compensation_event_generation
    (job_id, control_generation),
  KEY idx_legacy_tombstone_compensation_events_session
    (session_id, result_event_id),
  KEY idx_legacy_tombstone_compensation_events_emitted
    (event_type, emitted_at_ms, result_event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- The candidate index deliberately starts with the exact legacy marker. Runtime scans use
-- (deleted_at_ms, session_id) as the stable cursor once deletion_generation = 0 is fixed.
SET @legacy_tombstone_candidate_columns = (
  SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',')
    FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'sessions'
     AND index_name = 'idx_sessions_legacy_tombstone_candidate'
);
SET @legacy_tombstone_candidate_non_unique = (
  SELECT MAX(non_unique)
    FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'sessions'
     AND index_name = 'idx_sessions_legacy_tombstone_candidate'
);
SET @migration_sql = IF(
  @legacy_tombstone_candidate_columns IS NOT NULL
    AND (@legacy_tombstone_candidate_columns <> 'deletion_generation,deleted_at_ms,session_id'
      OR @legacy_tombstone_candidate_non_unique <> 1),
  'ALTER TABLE sessions DROP INDEX idx_sessions_legacy_tombstone_candidate',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_legacy_tombstone_candidate_index = (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'sessions'
     AND index_name = 'idx_sessions_legacy_tombstone_candidate'
);
SET @migration_sql = IF(
  @has_legacy_tombstone_candidate_index = 0,
  'ALTER TABLE sessions ADD KEY idx_sessions_legacy_tombstone_candidate (deletion_generation, deleted_at_ms, session_id)',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- Repair non-authority indexes by exact shape. These tables are new and remain unused until an
-- explicit post-cutover maintenance activation, so a partially installed index cannot be claimed.
SET @legacy_tombstone_job_claim_columns = (
  SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',')
    FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'legacy_tombstone_compensation_jobs'
     AND index_name = 'idx_legacy_tombstone_compensation_jobs_claim'
);
SET @legacy_tombstone_job_claim_non_unique = (
  SELECT MAX(non_unique)
    FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'legacy_tombstone_compensation_jobs'
     AND index_name = 'idx_legacy_tombstone_compensation_jobs_claim'
);
SET @migration_sql = IF(
  @legacy_tombstone_job_claim_columns IS NOT NULL
    AND (@legacy_tombstone_job_claim_columns <> 'status,available_at_ms,lease_until_ms,job_id'
      OR @legacy_tombstone_job_claim_non_unique <> 1),
  'ALTER TABLE legacy_tombstone_compensation_jobs DROP INDEX idx_legacy_tombstone_compensation_jobs_claim',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_legacy_tombstone_job_claim_index = (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'legacy_tombstone_compensation_jobs'
     AND index_name = 'idx_legacy_tombstone_compensation_jobs_claim'
);
SET @migration_sql = IF(
  @has_legacy_tombstone_job_claim_index = 0,
  'ALTER TABLE legacy_tombstone_compensation_jobs ADD KEY idx_legacy_tombstone_compensation_jobs_claim (status, available_at_ms, lease_until_ms, job_id)',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- The cutover row is mutable exactly once: inactive generation 0 -> activated generation 1 with
-- complete evidence. A bootstrap guard is installed before rotating permanent guards, so marker-loss
-- replay after activation never opens a deactivation or evidence-rewrite window.
DROP TRIGGER IF EXISTS trg_legacy_tombstone_cutover_bu_bootstrap;
CREATE TRIGGER trg_legacy_tombstone_cutover_bu_bootstrap
BEFORE UPDATE ON legacy_tombstone_cutover
FOR EACH ROW
BEGIN IF NOT (OLD.singleton_id = 1 AND NEW.singleton_id = 1 AND OLD.control_generation = 0 AND OLD.activated_at_ms IS NULL AND OLD.actor_key_id IS NULL AND OLD.evidence_sha256 IS NULL AND NEW.control_generation = 1 AND NEW.activated_at_ms IS NOT NULL AND NEW.actor_key_id IS NOT NULL AND NEW.evidence_sha256 IS NOT NULL) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legacy tombstone cutover is write-once'; END IF; END;

DROP TRIGGER IF EXISTS trg_legacy_tombstone_cutover_bu;
CREATE TRIGGER trg_legacy_tombstone_cutover_bu
BEFORE UPDATE ON legacy_tombstone_cutover
FOR EACH ROW
BEGIN IF NOT (OLD.singleton_id = 1 AND NEW.singleton_id = 1 AND OLD.control_generation = 0 AND OLD.activated_at_ms IS NULL AND OLD.actor_key_id IS NULL AND OLD.evidence_sha256 IS NULL AND NEW.control_generation = 1 AND NEW.activated_at_ms IS NOT NULL AND NEW.actor_key_id IS NOT NULL AND NEW.evidence_sha256 IS NOT NULL) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legacy tombstone cutover is write-once'; END IF; END;

DROP TRIGGER IF EXISTS trg_legacy_tombstone_cutover_bu_guard_a;
CREATE TRIGGER trg_legacy_tombstone_cutover_bu_guard_a
BEFORE UPDATE ON legacy_tombstone_cutover
FOR EACH ROW
BEGIN IF NOT (OLD.singleton_id = 1 AND NEW.singleton_id = 1 AND OLD.control_generation = 0 AND OLD.activated_at_ms IS NULL AND OLD.actor_key_id IS NULL AND OLD.evidence_sha256 IS NULL AND NEW.control_generation = 1 AND NEW.activated_at_ms IS NOT NULL AND NEW.actor_key_id IS NOT NULL AND NEW.evidence_sha256 IS NOT NULL) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legacy tombstone cutover is write-once'; END IF; END;

DROP TRIGGER IF EXISTS trg_legacy_tombstone_cutover_bu_guard_b;
CREATE TRIGGER trg_legacy_tombstone_cutover_bu_guard_b
BEFORE UPDATE ON legacy_tombstone_cutover
FOR EACH ROW
BEGIN IF NOT (OLD.singleton_id = 1 AND NEW.singleton_id = 1 AND OLD.control_generation = 0 AND OLD.activated_at_ms IS NULL AND OLD.actor_key_id IS NULL AND OLD.evidence_sha256 IS NULL AND NEW.control_generation = 1 AND NEW.activated_at_ms IS NOT NULL AND NEW.actor_key_id IS NOT NULL AND NEW.evidence_sha256 IS NOT NULL) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legacy tombstone cutover is write-once'; END IF; END;

DROP TRIGGER IF EXISTS trg_legacy_tombstone_cutover_bu_bootstrap;

DROP TRIGGER IF EXISTS trg_legacy_tombstone_cutover_bd_bootstrap;
CREATE TRIGGER trg_legacy_tombstone_cutover_bd_bootstrap
BEFORE DELETE ON legacy_tombstone_cutover
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legacy tombstone cutover cannot be deleted';

DROP TRIGGER IF EXISTS trg_legacy_tombstone_cutover_bd;
CREATE TRIGGER trg_legacy_tombstone_cutover_bd
BEFORE DELETE ON legacy_tombstone_cutover
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legacy tombstone cutover cannot be deleted';

DROP TRIGGER IF EXISTS trg_legacy_tombstone_cutover_bd_guard_a;
CREATE TRIGGER trg_legacy_tombstone_cutover_bd_guard_a
BEFORE DELETE ON legacy_tombstone_cutover
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legacy tombstone cutover cannot be deleted';

DROP TRIGGER IF EXISTS trg_legacy_tombstone_cutover_bd_guard_b;
CREATE TRIGGER trg_legacy_tombstone_cutover_bd_guard_b
BEFORE DELETE ON legacy_tombstone_cutover
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legacy tombstone cutover cannot be deleted';

DROP TRIGGER IF EXISTS trg_legacy_tombstone_cutover_bd_bootstrap;

-- Compensation results are immutable maintenance evidence. Keep redundant permanent guards so an
-- accidentally missing trigger remains fail-closed, and bootstrap each replay before rotation.
DROP TRIGGER IF EXISTS trg_legacy_tombstone_compensation_events_bu_bootstrap;
CREATE TRIGGER trg_legacy_tombstone_compensation_events_bu_bootstrap
BEFORE UPDATE ON legacy_tombstone_compensation_events
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legacy tombstone compensation events are append-only';

DROP TRIGGER IF EXISTS trg_legacy_tombstone_compensation_events_bu;
CREATE TRIGGER trg_legacy_tombstone_compensation_events_bu
BEFORE UPDATE ON legacy_tombstone_compensation_events
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legacy tombstone compensation events are append-only';

DROP TRIGGER IF EXISTS trg_legacy_tombstone_compensation_events_bu_guard_a;
CREATE TRIGGER trg_legacy_tombstone_compensation_events_bu_guard_a
BEFORE UPDATE ON legacy_tombstone_compensation_events
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legacy tombstone compensation events are append-only';

DROP TRIGGER IF EXISTS trg_legacy_tombstone_compensation_events_bu_guard_b;
CREATE TRIGGER trg_legacy_tombstone_compensation_events_bu_guard_b
BEFORE UPDATE ON legacy_tombstone_compensation_events
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legacy tombstone compensation events are append-only';

DROP TRIGGER IF EXISTS trg_legacy_tombstone_compensation_events_bu_bootstrap;

DROP TRIGGER IF EXISTS trg_legacy_tombstone_compensation_events_bd_bootstrap;
CREATE TRIGGER trg_legacy_tombstone_compensation_events_bd_bootstrap
BEFORE DELETE ON legacy_tombstone_compensation_events
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legacy tombstone compensation events are append-only';

DROP TRIGGER IF EXISTS trg_legacy_tombstone_compensation_events_bd;
CREATE TRIGGER trg_legacy_tombstone_compensation_events_bd
BEFORE DELETE ON legacy_tombstone_compensation_events
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legacy tombstone compensation events are append-only';

DROP TRIGGER IF EXISTS trg_legacy_tombstone_compensation_events_bd_guard_a;
CREATE TRIGGER trg_legacy_tombstone_compensation_events_bd_guard_a
BEFORE DELETE ON legacy_tombstone_compensation_events
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legacy tombstone compensation events are append-only';

DROP TRIGGER IF EXISTS trg_legacy_tombstone_compensation_events_bd_guard_b;
CREATE TRIGGER trg_legacy_tombstone_compensation_events_bd_guard_b
BEFORE DELETE ON legacy_tombstone_compensation_events
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legacy tombstone compensation events are append-only';

DROP TRIGGER IF EXISTS trg_legacy_tombstone_compensation_events_bd_bootstrap;

-- Install the dormant row-state guards last. The locking read is essential: a non-locking snapshot
-- could miss a concurrent activation and let a legacy deletion commit after the cutover. On replay,
-- bootstrap-first rotation guarantees an already-active database never loses this protection.
DROP TRIGGER IF EXISTS trg_sessions_legacy_tombstone_guard_bi_bootstrap;
CREATE TRIGGER trg_sessions_legacy_tombstone_guard_bi_bootstrap
BEFORE INSERT ON sessions
FOR EACH ROW
BEGIN DECLARE cutover_at BIGINT DEFAULT NULL; SELECT activated_at_ms INTO cutover_at FROM legacy_tombstone_cutover WHERE singleton_id = 1 FOR SHARE; IF cutover_at IS NOT NULL AND ((NEW.deleted_at_ms IS NOT NULL AND NEW.deletion_generation = 0) OR (NEW.deleted_at_ms IS NULL AND (NEW.deletion_generation <> 0 OR NEW.purge_after_ms IS NOT NULL))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legacy session tombstone write rejected after cutover'; END IF; END;

DROP TRIGGER IF EXISTS trg_sessions_legacy_tombstone_guard_bi;
CREATE TRIGGER trg_sessions_legacy_tombstone_guard_bi
BEFORE INSERT ON sessions
FOR EACH ROW
BEGIN DECLARE cutover_at BIGINT DEFAULT NULL; SELECT activated_at_ms INTO cutover_at FROM legacy_tombstone_cutover WHERE singleton_id = 1 FOR SHARE; IF cutover_at IS NOT NULL AND ((NEW.deleted_at_ms IS NOT NULL AND NEW.deletion_generation = 0) OR (NEW.deleted_at_ms IS NULL AND (NEW.deletion_generation <> 0 OR NEW.purge_after_ms IS NOT NULL))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legacy session tombstone write rejected after cutover'; END IF; END;

DROP TRIGGER IF EXISTS trg_sessions_legacy_tombstone_guard_bi_bootstrap;

DROP TRIGGER IF EXISTS trg_sessions_legacy_tombstone_guard_bu_bootstrap;
CREATE TRIGGER trg_sessions_legacy_tombstone_guard_bu_bootstrap
BEFORE UPDATE ON sessions
FOR EACH ROW
BEGIN DECLARE cutover_at BIGINT DEFAULT NULL; SELECT activated_at_ms INTO cutover_at FROM legacy_tombstone_cutover WHERE singleton_id = 1 FOR SHARE; IF cutover_at IS NOT NULL AND ((NEW.deleted_at_ms IS NOT NULL AND NEW.deletion_generation = 0) OR (NEW.deleted_at_ms IS NULL AND (NEW.deletion_generation <> 0 OR NEW.purge_after_ms IS NOT NULL))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legacy session tombstone write rejected after cutover'; END IF; END;

DROP TRIGGER IF EXISTS trg_sessions_legacy_tombstone_guard_bu;
CREATE TRIGGER trg_sessions_legacy_tombstone_guard_bu
BEFORE UPDATE ON sessions
FOR EACH ROW
BEGIN DECLARE cutover_at BIGINT DEFAULT NULL; SELECT activated_at_ms INTO cutover_at FROM legacy_tombstone_cutover WHERE singleton_id = 1 FOR SHARE; IF cutover_at IS NOT NULL AND ((NEW.deleted_at_ms IS NOT NULL AND NEW.deletion_generation = 0) OR (NEW.deleted_at_ms IS NULL AND (NEW.deletion_generation <> 0 OR NEW.purge_after_ms IS NOT NULL))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legacy session tombstone write rejected after cutover'; END IF; END;

DROP TRIGGER IF EXISTS trg_sessions_legacy_tombstone_guard_bu_bootstrap;
