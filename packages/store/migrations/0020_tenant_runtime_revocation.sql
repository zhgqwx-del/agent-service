-- Expand-only, execution-dormant substrate for T3b configured-fleet runtime quiescence.
-- This migration never scans 0018/0019 evidence, materializes or claims work, contacts a runner,
-- clears a cache, aborts I/O, changes tenant lifecycle, purges content, or rewrites a T3a receipt.
-- Historical terminal T3a evidence is consumed only by the explicit proof-checking materializer.

CREATE TABLE IF NOT EXISTS tenant_runtime_revocation_jobs (
  request_id                       VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  tenant_id                        VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation               BIGINT UNSIGNED NOT NULL,
  t1_fence_sha256                  CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  t3a_receipt_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  phase                            VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  available_at_ms                  BIGINT NULL,
  attempts                         INT UNSIGNED NOT NULL DEFAULT 0,
  claim_token                      VARCHAR(128) COLLATE utf8mb4_0900_as_cs NULL,
  lease_until_ms                   BIGINT NULL,
  last_error_code                  VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL,
  created_at_ms                    BIGINT NOT NULL,
  updated_at_ms                    BIGINT NOT NULL,
  configured_fleet_quiesced_at_ms BIGINT NULL,
  completed_claim_attempt          INT UNSIGNED NULL,
  completed_claim_token_sha256     CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  blocked_at_ms                    BIGINT NULL,
  blocked_reason_code              VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL,
  CONSTRAINT chk_tenant_runtime_job_generation CHECK (subject_generation > 0),
  CONSTRAINT chk_tenant_runtime_job_timestamps
    CHECK (created_at_ms >= 0 AND updated_at_ms >= created_at_ms),
  CONSTRAINT chk_tenant_runtime_job_phase CHECK (
    (phase = 'queued'
      AND available_at_ms IS NOT NULL AND available_at_ms >= created_at_ms
      AND ((claim_token IS NULL AND lease_until_ms IS NULL)
        OR (claim_token IS NOT NULL AND lease_until_ms IS NOT NULL AND attempts > 0))
      AND (last_error_code IS NULL OR last_error_code = 'temporary_failure')
      AND configured_fleet_quiesced_at_ms IS NULL
      AND completed_claim_attempt IS NULL
      AND completed_claim_token_sha256 IS NULL
      AND blocked_at_ms IS NULL AND blocked_reason_code IS NULL)
    OR
    (phase = 'configured_fleet_quiesced'
      AND available_at_ms IS NULL AND claim_token IS NULL AND lease_until_ms IS NULL
      AND last_error_code IS NULL
      AND configured_fleet_quiesced_at_ms IS NOT NULL
      AND configured_fleet_quiesced_at_ms >= created_at_ms
      AND configured_fleet_quiesced_at_ms <= updated_at_ms
      AND completed_claim_attempt IS NOT NULL AND completed_claim_attempt = attempts
      AND completed_claim_token_sha256 IS NOT NULL
      AND blocked_at_ms IS NULL AND blocked_reason_code IS NULL)
    OR
    (phase = 'blocked'
      AND available_at_ms IS NULL AND claim_token IS NULL AND lease_until_ms IS NULL
      AND last_error_code IS NULL AND configured_fleet_quiesced_at_ms IS NULL
      AND completed_claim_attempt IS NULL AND completed_claim_token_sha256 IS NULL
      AND blocked_at_ms IS NOT NULL AND blocked_at_ms >= created_at_ms
      AND blocked_at_ms <= updated_at_ms
      AND blocked_reason_code = 'integrity_conflict'
      AND attempts > 0)
  ),
  UNIQUE KEY uk_tenant_runtime_jobs_tenant (tenant_id),
  UNIQUE KEY uk_tenant_runtime_jobs_generation (tenant_id, subject_generation),
  KEY idx_tenant_runtime_jobs_claim (phase, available_at_ms, lease_until_ms, request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT request_id, tenant_id, subject_generation, t1_fence_sha256, t3a_receipt_sha256,
       phase, available_at_ms, attempts, claim_token, lease_until_ms, last_error_code,
       created_at_ms, updated_at_ms, configured_fleet_quiesced_at_ms,
       completed_claim_attempt, completed_claim_token_sha256, blocked_at_ms,
       blocked_reason_code
  FROM tenant_runtime_revocation_jobs FORCE INDEX (
    PRIMARY, uk_tenant_runtime_jobs_tenant, uk_tenant_runtime_jobs_generation,
    idx_tenant_runtime_jobs_claim
  ) WHERE 1=0;

-- One immutable row per router-configured stable target. Raw runner/boot labels and URLs are not
-- retained; their domain-separated hashes are enough to reject aliases and bind aggregate proof.
CREATE TABLE IF NOT EXISTS tenant_runtime_revocation_target_receipts (
  request_id                       VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_sha256                    CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                        VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation               BIGINT UNSIGNED NOT NULL,
  scope                            VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  runner_id_sha256                 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  boot_id_sha256                   CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  t1_fence_sha256                  CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  t3a_receipt_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  fleet_sha256                     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  cache_entry_count_before         BIGINT UNSIGNED NOT NULL,
  cache_entry_count_after          BIGINT UNSIGNED NOT NULL,
  active_operation_count_before    BIGINT UNSIGNED NOT NULL,
  active_operation_count_after     BIGINT UNSIGNED NOT NULL,
  active_turn_count_before         BIGINT UNSIGNED NOT NULL,
  active_turn_count_after          BIGINT UNSIGNED NOT NULL,
  runner_completed_at_ms           BIGINT NOT NULL,
  local_receipt_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  completed_claim_attempt          INT UNSIGNED NOT NULL,
  completed_claim_token_sha256     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  evidence_sha256                  CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  CONSTRAINT chk_tenant_runtime_target_scope
    CHECK (scope = 'configured-runner-runtime-v1'),
  CONSTRAINT chk_tenant_runtime_target_generation CHECK (subject_generation > 0),
  CONSTRAINT chk_tenant_runtime_target_quiesced CHECK (
    cache_entry_count_after = 0
    AND active_operation_count_after = 0
    AND active_turn_count_after = 0
  ),
  CONSTRAINT chk_tenant_runtime_target_completion
    CHECK (runner_completed_at_ms >= 0 AND completed_claim_attempt > 0),
  PRIMARY KEY (request_id, target_sha256),
  UNIQUE KEY uk_tenant_runtime_target_runner (request_id, runner_id_sha256),
  UNIQUE KEY uk_tenant_runtime_target_boot (request_id, boot_id_sha256),
  UNIQUE KEY uk_tenant_runtime_target_evidence (request_id, evidence_sha256),
  KEY idx_tenant_runtime_target_owner
    (tenant_id, subject_generation, request_id, target_sha256)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT request_id, target_sha256, tenant_id, subject_generation, scope, runner_id_sha256,
       boot_id_sha256, t1_fence_sha256, t3a_receipt_sha256, fleet_sha256,
       cache_entry_count_before, cache_entry_count_after,
       active_operation_count_before, active_operation_count_after,
       active_turn_count_before, active_turn_count_after, runner_completed_at_ms,
       local_receipt_sha256, completed_claim_attempt, completed_claim_token_sha256,
       evidence_sha256
  FROM tenant_runtime_revocation_target_receipts FORCE INDEX (
    PRIMARY, uk_tenant_runtime_target_runner, uk_tenant_runtime_target_boot,
    uk_tenant_runtime_target_evidence, idx_tenant_runtime_target_owner
  ) WHERE 1=0;

-- Aggregate proof is inserted only beside the complete target set and terminal job transition.
CREATE TABLE IF NOT EXISTS tenant_runtime_revocation_receipts (
  request_id                       VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  tenant_id                        VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation               BIGINT UNSIGNED NOT NULL,
  scope                            VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  t1_fence_sha256                  CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  t3a_receipt_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  fleet_sha256                     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_count                     BIGINT UNSIGNED NOT NULL,
  target_receipts_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  store_db_timestamp_ms            BIGINT NOT NULL,
  completed_claim_attempt          INT UNSIGNED NOT NULL,
  completed_claim_token_sha256     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  memory_disposition               VARCHAR(48) COLLATE utf8mb4_0900_as_cs NOT NULL,
  external_disposition             VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  content_purge_required           BOOLEAN NOT NULL,
  receipt_sha256                   CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  CONSTRAINT chk_tenant_runtime_receipt_scope
    CHECK (scope = 'configured-fleet-runtime-v1'),
  CONSTRAINT chk_tenant_runtime_receipt_generation CHECK (subject_generation > 0),
  CONSTRAINT chk_tenant_runtime_receipt_targets CHECK (
    target_count > 0 AND target_count <= 100
  ),
  CONSTRAINT chk_tenant_runtime_receipt_completion
    CHECK (store_db_timestamp_ms >= 0 AND completed_claim_attempt > 0),
  CONSTRAINT chk_tenant_runtime_receipt_disposition CHECK (
    memory_disposition = 'references_dropped_not_zeroized'
    AND external_disposition = 'not_supported'
    AND content_purge_required = TRUE
  ),
  UNIQUE KEY uk_tenant_runtime_receipts_tenant (tenant_id),
  UNIQUE KEY uk_tenant_runtime_receipts_generation (tenant_id, subject_generation),
  UNIQUE KEY uk_tenant_runtime_receipts_hash (receipt_sha256)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT request_id, tenant_id, subject_generation, scope, t1_fence_sha256,
       t3a_receipt_sha256, fleet_sha256, target_count, target_receipts_sha256,
       store_db_timestamp_ms, completed_claim_attempt, completed_claim_token_sha256,
       memory_disposition, external_disposition, content_purge_required, receipt_sha256
  FROM tenant_runtime_revocation_receipts FORCE INDEX (
    PRIMARY, uk_tenant_runtime_receipts_tenant,
    uk_tenant_runtime_receipts_generation, uk_tenant_runtime_receipts_hash
  ) WHERE 1=0;

-- Identity/source coordinates are immutable, attempts are monotonic, and terminal jobs cannot be
-- changed or deleted. Bootstrap-first trigger rotation preserves a guard on marker-loss replay.
DROP TRIGGER IF EXISTS trg_tenant_runtime_jobs_bu_bootstrap;
CREATE TRIGGER trg_tenant_runtime_jobs_bu_bootstrap BEFORE UPDATE ON tenant_runtime_revocation_jobs FOR EACH ROW BEGIN IF NOT (OLD.request_id <=> NEW.request_id AND OLD.tenant_id <=> NEW.tenant_id AND OLD.subject_generation <=> NEW.subject_generation AND OLD.t1_fence_sha256 <=> NEW.t1_fence_sha256 AND OLD.t3a_receipt_sha256 <=> NEW.t3a_receipt_sha256 AND OLD.created_at_ms <=> NEW.created_at_ms AND OLD.phase = 'queued' AND NEW.attempts >= OLD.attempts AND NEW.attempts <= OLD.attempts + 1 AND NEW.updated_at_ms >= OLD.updated_at_ms) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant runtime revocation job identity or terminal state is immutable'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_runtime_jobs_bu;
CREATE TRIGGER trg_tenant_runtime_jobs_bu BEFORE UPDATE ON tenant_runtime_revocation_jobs FOR EACH ROW BEGIN IF NOT (OLD.request_id <=> NEW.request_id AND OLD.tenant_id <=> NEW.tenant_id AND OLD.subject_generation <=> NEW.subject_generation AND OLD.t1_fence_sha256 <=> NEW.t1_fence_sha256 AND OLD.t3a_receipt_sha256 <=> NEW.t3a_receipt_sha256 AND OLD.created_at_ms <=> NEW.created_at_ms AND OLD.phase = 'queued' AND NEW.attempts >= OLD.attempts AND NEW.attempts <= OLD.attempts + 1 AND NEW.updated_at_ms >= OLD.updated_at_ms) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant runtime revocation job identity or terminal state is immutable'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_runtime_jobs_bu_guard_a;
CREATE TRIGGER trg_tenant_runtime_jobs_bu_guard_a BEFORE UPDATE ON tenant_runtime_revocation_jobs FOR EACH ROW BEGIN IF NOT (OLD.request_id <=> NEW.request_id AND OLD.tenant_id <=> NEW.tenant_id AND OLD.subject_generation <=> NEW.subject_generation AND OLD.t1_fence_sha256 <=> NEW.t1_fence_sha256 AND OLD.t3a_receipt_sha256 <=> NEW.t3a_receipt_sha256 AND OLD.created_at_ms <=> NEW.created_at_ms AND OLD.phase = 'queued' AND NEW.attempts >= OLD.attempts AND NEW.attempts <= OLD.attempts + 1 AND NEW.updated_at_ms >= OLD.updated_at_ms) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant runtime revocation job identity or terminal state is immutable'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_runtime_jobs_bu_guard_b;
CREATE TRIGGER trg_tenant_runtime_jobs_bu_guard_b BEFORE UPDATE ON tenant_runtime_revocation_jobs FOR EACH ROW BEGIN IF NOT (OLD.request_id <=> NEW.request_id AND OLD.tenant_id <=> NEW.tenant_id AND OLD.subject_generation <=> NEW.subject_generation AND OLD.t1_fence_sha256 <=> NEW.t1_fence_sha256 AND OLD.t3a_receipt_sha256 <=> NEW.t3a_receipt_sha256 AND OLD.created_at_ms <=> NEW.created_at_ms AND OLD.phase = 'queued' AND NEW.attempts >= OLD.attempts AND NEW.attempts <= OLD.attempts + 1 AND NEW.updated_at_ms >= OLD.updated_at_ms) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant runtime revocation job identity or terminal state is immutable'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_runtime_jobs_bu_bootstrap;

DROP TRIGGER IF EXISTS trg_tenant_runtime_jobs_bd_bootstrap;
CREATE TRIGGER trg_tenant_runtime_jobs_bd_bootstrap BEFORE DELETE ON tenant_runtime_revocation_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant runtime revocation jobs cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_runtime_jobs_bd;
CREATE TRIGGER trg_tenant_runtime_jobs_bd BEFORE DELETE ON tenant_runtime_revocation_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant runtime revocation jobs cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_runtime_jobs_bd_guard_a;
CREATE TRIGGER trg_tenant_runtime_jobs_bd_guard_a BEFORE DELETE ON tenant_runtime_revocation_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant runtime revocation jobs cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_runtime_jobs_bd_guard_b;
CREATE TRIGGER trg_tenant_runtime_jobs_bd_guard_b BEFORE DELETE ON tenant_runtime_revocation_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant runtime revocation jobs cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_runtime_jobs_bd_bootstrap;

DROP TRIGGER IF EXISTS trg_tenant_runtime_targets_bu_bootstrap;
CREATE TRIGGER trg_tenant_runtime_targets_bu_bootstrap BEFORE UPDATE ON tenant_runtime_revocation_target_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant runtime target receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_runtime_targets_bu;
CREATE TRIGGER trg_tenant_runtime_targets_bu BEFORE UPDATE ON tenant_runtime_revocation_target_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant runtime target receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_runtime_targets_bu_guard_a;
CREATE TRIGGER trg_tenant_runtime_targets_bu_guard_a BEFORE UPDATE ON tenant_runtime_revocation_target_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant runtime target receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_runtime_targets_bu_guard_b;
CREATE TRIGGER trg_tenant_runtime_targets_bu_guard_b BEFORE UPDATE ON tenant_runtime_revocation_target_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant runtime target receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_runtime_targets_bu_bootstrap;

DROP TRIGGER IF EXISTS trg_tenant_runtime_targets_bd_bootstrap;
CREATE TRIGGER trg_tenant_runtime_targets_bd_bootstrap BEFORE DELETE ON tenant_runtime_revocation_target_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant runtime target receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_runtime_targets_bd;
CREATE TRIGGER trg_tenant_runtime_targets_bd BEFORE DELETE ON tenant_runtime_revocation_target_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant runtime target receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_runtime_targets_bd_guard_a;
CREATE TRIGGER trg_tenant_runtime_targets_bd_guard_a BEFORE DELETE ON tenant_runtime_revocation_target_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant runtime target receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_runtime_targets_bd_guard_b;
CREATE TRIGGER trg_tenant_runtime_targets_bd_guard_b BEFORE DELETE ON tenant_runtime_revocation_target_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant runtime target receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_runtime_targets_bd_bootstrap;

DROP TRIGGER IF EXISTS trg_tenant_runtime_receipts_bu_bootstrap;
CREATE TRIGGER trg_tenant_runtime_receipts_bu_bootstrap BEFORE UPDATE ON tenant_runtime_revocation_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant runtime receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_runtime_receipts_bu;
CREATE TRIGGER trg_tenant_runtime_receipts_bu BEFORE UPDATE ON tenant_runtime_revocation_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant runtime receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_runtime_receipts_bu_guard_a;
CREATE TRIGGER trg_tenant_runtime_receipts_bu_guard_a BEFORE UPDATE ON tenant_runtime_revocation_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant runtime receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_runtime_receipts_bu_guard_b;
CREATE TRIGGER trg_tenant_runtime_receipts_bu_guard_b BEFORE UPDATE ON tenant_runtime_revocation_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant runtime receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_runtime_receipts_bu_bootstrap;

DROP TRIGGER IF EXISTS trg_tenant_runtime_receipts_bd_bootstrap;
CREATE TRIGGER trg_tenant_runtime_receipts_bd_bootstrap BEFORE DELETE ON tenant_runtime_revocation_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant runtime receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_runtime_receipts_bd;
CREATE TRIGGER trg_tenant_runtime_receipts_bd BEFORE DELETE ON tenant_runtime_revocation_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant runtime receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_runtime_receipts_bd_guard_a;
CREATE TRIGGER trg_tenant_runtime_receipts_bd_guard_a BEFORE DELETE ON tenant_runtime_revocation_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant runtime receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_runtime_receipts_bd_guard_b;
CREATE TRIGGER trg_tenant_runtime_receipts_bd_guard_b BEFORE DELETE ON tenant_runtime_revocation_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant runtime receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_runtime_receipts_bd_bootstrap;
