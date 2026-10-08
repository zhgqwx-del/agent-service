-- Expand-only, destructive-dormant policy evaluation substrate. This migration creates a queue
-- for content-free evaluation work, immutable target/decision evidence, and immutable authority
-- attestations. It deliberately does not expose an execution queue, set sessions.purge_after_ms,
-- make lifecycle/session.purge or ready-blob deletion rows claimable, anonymize/delete data, or
-- advance an erasure request to purging/completed. Historical awaiting rows are not backfilled:
-- the maintenance-facing store scan must schedule them explicitly after the new reader is live.

CREATE TABLE IF NOT EXISTS erasure_policy_evaluation_jobs (
  request_id                 VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  tenant_id                  VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_kind               VARCHAR(16)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_id                 VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation         BIGINT UNSIGNED NOT NULL,
  build_generation           BIGINT UNSIGNED NOT NULL,
  cursor_session_id          VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NULL,
  target_count               BIGINT UNSIGNED NOT NULL,
  target_root_sha256         CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  available_at_ms            BIGINT NULL,
  attempts                   INT UNSIGNED NOT NULL DEFAULT 0,
  claim_token                VARCHAR(128) COLLATE utf8mb4_0900_as_cs NULL,
  lease_until_ms             BIGINT NULL,
  last_error_code            VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NULL,
  sealed_at_ms               BIGINT NULL,
  created_at_ms              BIGINT NOT NULL,
  updated_at_ms              BIGINT NOT NULL,
  UNIQUE KEY uk_erasure_policy_job_subject_generation
    (tenant_id, subject_kind, subject_id, subject_generation),
  KEY idx_erasure_policy_job_claim
    (sealed_at_ms, available_at_ms, lease_until_ms, request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Staging evidence is immutable within one build generation. A later reevaluation must use a new
-- generation; it may never overwrite evidence observed by a previous decision.
CREATE TABLE IF NOT EXISTS erasure_purge_targets (
  request_id                           VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  build_generation                     BIGINT UNSIGNED NOT NULL,
  tenant_id                            VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  user_id                              VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  session_id                           VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  deletion_generation                  BIGINT UNSIGNED NOT NULL,
  deleted_at_ms                        BIGINT NOT NULL,
  session_content_deadline_ms          BIGINT NULL,
  ready_blob_count                     BIGINT UNSIGNED NOT NULL,
  ready_blob_root_sha256               CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  ready_blob_deadline_ms               BIGINT NULL,
  operational_usage_status             VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  operational_usage_verified_at_ms     BIGINT NOT NULL,
  operational_usage_checksum           CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  operational_usage_deadline_ms        BIGINT NULL,
  idempotency_receipt_count             BIGINT UNSIGNED NOT NULL,
  idempotency_receipt_deadline_ms       BIGINT NULL,
  export_artifact_disposition           VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  billing_fact_disposition              VARCHAR(16)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  lifecycle_audit_disposition           VARCHAR(16)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  issue_codes                           JSON NOT NULL,
  evidence_sha256                       CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (request_id, build_generation, session_id),
  UNIQUE KEY uk_erasure_purge_target_evidence
    (request_id, build_generation, evidence_sha256),
  KEY idx_erasure_purge_targets_owner
    (tenant_id, user_id, request_id, build_generation, session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Every outcome, including a hold or malformed/unconfigured policy, is retained in a rooted
-- append-only chain. A denial/defer event does not consume an authority generation.
CREATE TABLE IF NOT EXISTS erasure_policy_evaluation_decisions (
  request_id                       VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  decision_seq                     BIGINT UNSIGNED NOT NULL,
  build_generation                 BIGINT UNSIGNED NOT NULL,
  decision                         VARCHAR(48) COLLATE utf8mb4_0900_as_cs NOT NULL,
  policy_version                   VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  policy_sha256                    CHAR(64)    COLLATE utf8mb4_0900_as_cs NULL,
  user_grace_deadline_ms           BIGINT NULL,
  eligibility_deadline_ms          BIGINT NULL,
  target_count                     BIGINT UNSIGNED NOT NULL,
  target_root_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_hold_control_generation   BIGINT UNSIGNED NOT NULL,
  tenant_hold_projection_sha256    CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  user_hold_control_generation     BIGINT UNSIGNED NOT NULL,
  user_hold_projection_sha256      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  before_sha256                    CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  after_sha256                     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  decided_at_ms                    BIGINT NOT NULL,
  PRIMARY KEY (request_id, decision_seq),
  UNIQUE KEY uk_erasure_policy_decision_after (request_id, after_sha256)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Mutable CAS projection only. The absence of availability, attempts, claim token and lease
-- columns is intentional: possessing or reading this row cannot confer purge execution authority.
CREATE TABLE IF NOT EXISTS erasure_purge_authority_controls (
  request_id                   VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  authority_generation         BIGINT UNSIGNED NOT NULL,
  active_authority_sha256      CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  updated_at_ms                BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE IF NOT EXISTS erasure_purge_authorities (
  request_id                       VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  authority_generation             BIGINT UNSIGNED NOT NULL,
  tenant_id                        VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_kind                     VARCHAR(16)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_id                       VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation               BIGINT UNSIGNED NOT NULL,
  build_generation                 BIGINT UNSIGNED NOT NULL,
  policy_version                   VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  policy_sha256                    CHAR(64)    COLLATE utf8mb4_0900_as_cs NOT NULL,
  policy_schema_version            INT UNSIGNED NOT NULL,
  user_grace_deadline_ms           BIGINT NOT NULL,
  eligibility_deadline_ms          BIGINT NOT NULL,
  target_count                     BIGINT UNSIGNED NOT NULL,
  target_root_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_hold_control_generation   BIGINT UNSIGNED NOT NULL,
  tenant_hold_projection_sha256    CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  user_hold_control_generation     BIGINT UNSIGNED NOT NULL,
  user_hold_projection_sha256      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  decision_sha256                  CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  authority_sha256                 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  created_at_ms                    BIGINT NOT NULL,
  PRIMARY KEY (request_id, authority_generation),
  UNIQUE KEY uk_erasure_purge_authority_hash (request_id, authority_sha256),
  KEY idx_erasure_purge_authority_owner
    (tenant_id, subject_kind, subject_id, subject_generation, request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- MySQL has no CREATE TRIGGER IF NOT EXISTS. Keep three equivalent permanent guards per
-- mutation and use a fourth bootstrap guard while rotating them. After one complete install,
-- every replay prefix leaves at least one permanent guard active. A first install has no writer
-- for these new tables until the migration completes, and the bootstrap guard is installed before
-- any permanent guard is replaced.
DROP TRIGGER IF EXISTS trg_erasure_purge_targets_bu_bootstrap;
CREATE TRIGGER trg_erasure_purge_targets_bu_bootstrap BEFORE UPDATE ON erasure_purge_targets
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure purge target evidence is append-only';
DROP TRIGGER IF EXISTS trg_erasure_purge_targets_bu;
CREATE TRIGGER trg_erasure_purge_targets_bu BEFORE UPDATE ON erasure_purge_targets
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure purge target evidence is append-only';
DROP TRIGGER IF EXISTS trg_erasure_purge_targets_bu_guard_a;
CREATE TRIGGER trg_erasure_purge_targets_bu_guard_a BEFORE UPDATE ON erasure_purge_targets
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure purge target evidence is append-only';
DROP TRIGGER IF EXISTS trg_erasure_purge_targets_bu_guard_b;
CREATE TRIGGER trg_erasure_purge_targets_bu_guard_b BEFORE UPDATE ON erasure_purge_targets
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure purge target evidence is append-only';
DROP TRIGGER IF EXISTS trg_erasure_purge_targets_bu_bootstrap;

DROP TRIGGER IF EXISTS trg_erasure_purge_targets_bd_bootstrap;
CREATE TRIGGER trg_erasure_purge_targets_bd_bootstrap BEFORE DELETE ON erasure_purge_targets
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure purge target evidence is append-only';
DROP TRIGGER IF EXISTS trg_erasure_purge_targets_bd;
CREATE TRIGGER trg_erasure_purge_targets_bd BEFORE DELETE ON erasure_purge_targets
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure purge target evidence is append-only';
DROP TRIGGER IF EXISTS trg_erasure_purge_targets_bd_guard_a;
CREATE TRIGGER trg_erasure_purge_targets_bd_guard_a BEFORE DELETE ON erasure_purge_targets
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure purge target evidence is append-only';
DROP TRIGGER IF EXISTS trg_erasure_purge_targets_bd_guard_b;
CREATE TRIGGER trg_erasure_purge_targets_bd_guard_b BEFORE DELETE ON erasure_purge_targets
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure purge target evidence is append-only';
DROP TRIGGER IF EXISTS trg_erasure_purge_targets_bd_bootstrap;

DROP TRIGGER IF EXISTS trg_erasure_policy_decisions_bu_bootstrap;
CREATE TRIGGER trg_erasure_policy_decisions_bu_bootstrap BEFORE UPDATE ON erasure_policy_evaluation_decisions
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure policy decision evidence is append-only';
DROP TRIGGER IF EXISTS trg_erasure_policy_decisions_bu;
CREATE TRIGGER trg_erasure_policy_decisions_bu BEFORE UPDATE ON erasure_policy_evaluation_decisions
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure policy decision evidence is append-only';
DROP TRIGGER IF EXISTS trg_erasure_policy_decisions_bu_guard_a;
CREATE TRIGGER trg_erasure_policy_decisions_bu_guard_a BEFORE UPDATE ON erasure_policy_evaluation_decisions
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure policy decision evidence is append-only';
DROP TRIGGER IF EXISTS trg_erasure_policy_decisions_bu_guard_b;
CREATE TRIGGER trg_erasure_policy_decisions_bu_guard_b BEFORE UPDATE ON erasure_policy_evaluation_decisions
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure policy decision evidence is append-only';
DROP TRIGGER IF EXISTS trg_erasure_policy_decisions_bu_bootstrap;

DROP TRIGGER IF EXISTS trg_erasure_policy_decisions_bd_bootstrap;
CREATE TRIGGER trg_erasure_policy_decisions_bd_bootstrap BEFORE DELETE ON erasure_policy_evaluation_decisions
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure policy decision evidence is append-only';
DROP TRIGGER IF EXISTS trg_erasure_policy_decisions_bd;
CREATE TRIGGER trg_erasure_policy_decisions_bd BEFORE DELETE ON erasure_policy_evaluation_decisions
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure policy decision evidence is append-only';
DROP TRIGGER IF EXISTS trg_erasure_policy_decisions_bd_guard_a;
CREATE TRIGGER trg_erasure_policy_decisions_bd_guard_a BEFORE DELETE ON erasure_policy_evaluation_decisions
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure policy decision evidence is append-only';
DROP TRIGGER IF EXISTS trg_erasure_policy_decisions_bd_guard_b;
CREATE TRIGGER trg_erasure_policy_decisions_bd_guard_b BEFORE DELETE ON erasure_policy_evaluation_decisions
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure policy decision evidence is append-only';
DROP TRIGGER IF EXISTS trg_erasure_policy_decisions_bd_bootstrap;

DROP TRIGGER IF EXISTS trg_erasure_purge_authorities_bu_bootstrap;
CREATE TRIGGER trg_erasure_purge_authorities_bu_bootstrap BEFORE UPDATE ON erasure_purge_authorities
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure purge authority evidence is append-only';
DROP TRIGGER IF EXISTS trg_erasure_purge_authorities_bu;
CREATE TRIGGER trg_erasure_purge_authorities_bu BEFORE UPDATE ON erasure_purge_authorities
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure purge authority evidence is append-only';
DROP TRIGGER IF EXISTS trg_erasure_purge_authorities_bu_guard_a;
CREATE TRIGGER trg_erasure_purge_authorities_bu_guard_a BEFORE UPDATE ON erasure_purge_authorities
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure purge authority evidence is append-only';
DROP TRIGGER IF EXISTS trg_erasure_purge_authorities_bu_guard_b;
CREATE TRIGGER trg_erasure_purge_authorities_bu_guard_b BEFORE UPDATE ON erasure_purge_authorities
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure purge authority evidence is append-only';
DROP TRIGGER IF EXISTS trg_erasure_purge_authorities_bu_bootstrap;

DROP TRIGGER IF EXISTS trg_erasure_purge_authorities_bd_bootstrap;
CREATE TRIGGER trg_erasure_purge_authorities_bd_bootstrap BEFORE DELETE ON erasure_purge_authorities
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure purge authority evidence is append-only';
DROP TRIGGER IF EXISTS trg_erasure_purge_authorities_bd;
CREATE TRIGGER trg_erasure_purge_authorities_bd BEFORE DELETE ON erasure_purge_authorities
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure purge authority evidence is append-only';
DROP TRIGGER IF EXISTS trg_erasure_purge_authorities_bd_guard_a;
CREATE TRIGGER trg_erasure_purge_authorities_bd_guard_a BEFORE DELETE ON erasure_purge_authorities
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure purge authority evidence is append-only';
DROP TRIGGER IF EXISTS trg_erasure_purge_authorities_bd_guard_b;
CREATE TRIGGER trg_erasure_purge_authorities_bd_guard_b BEFORE DELETE ON erasure_purge_authorities
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure purge authority evidence is append-only';
DROP TRIGGER IF EXISTS trg_erasure_purge_authorities_bd_bootstrap;
