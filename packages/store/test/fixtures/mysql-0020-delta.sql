-- Historical MySQL schema delta frozen at migration 0020.
--
-- Apply only after the committed mysql-0017.sql fixture. This snapshot contains the exact
-- 0018, 0019, and 0020 expand-only DDL needed to represent a real historical 0020 database.
-- Tests must not regenerate it from live migrations.

-- Expand-only tenant erasure admission and credential revocation evidence substrate.
--
-- Tenant admissions are deliberately isolated from erasure_requests. Frozen 0017 workers scan
-- that table and would interpret every gated row as user-worker authority, so a dormant tenant
-- admission must never enter the legacy claim surface. This migration does not create an
-- admission, change subject lifecycle, revoke a credential, or modify an existing request.
--
-- MySQL DDL auto-commits before schema_migrations is recorded. Each CREATE is replay-safe, and
-- its immediately following FORCE INDEX probe prevents an incompatible pre-existing table from
-- receiving a false migration marker before any append-only trigger family is rotated.

CREATE TABLE IF NOT EXISTS tenant_erasure_admissions (
  request_id             VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  tenant_id              VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation     BIGINT UNSIGNED NOT NULL,
  requested_by_key_id    VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  idempotency_key        VARCHAR(256) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_hash           CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  created_at_ms          BIGINT NOT NULL,
  gated_at_ms            BIGINT NOT NULL,
  updated_at_ms          BIGINT NOT NULL,
  policy_version         VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NULL,
  policy_hash            CHAR(64)     COLLATE utf8mb4_0900_as_cs NULL,
  control_generation     BIGINT UNSIGNED NOT NULL DEFAULT 0,
  UNIQUE KEY uk_tenant_erasure_admissions_tenant (tenant_id),
  UNIQUE KEY uk_tenant_erasure_admissions_tenant_generation
    (tenant_id, subject_generation),
  UNIQUE KEY uk_tenant_erasure_admissions_idempotency
    (tenant_id, idempotency_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT request_id, tenant_id, subject_generation, requested_by_key_id, idempotency_key,
       request_hash, created_at_ms, gated_at_ms, updated_at_ms, policy_version, policy_hash,
       control_generation
  FROM tenant_erasure_admissions FORCE INDEX (
    PRIMARY, uk_tenant_erasure_admissions_tenant,
    uk_tenant_erasure_admissions_tenant_generation,
    uk_tenant_erasure_admissions_idempotency
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_credential_revocation_fences (
  tenant_id          VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  request_id         VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation BIGINT UNSIGNED NOT NULL,
  fenced_at_ms       BIGINT NOT NULL,
  evidence_sha256    CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  UNIQUE KEY uk_tenant_credential_fences_request (request_id),
  UNIQUE KEY uk_tenant_credential_fences_generation (tenant_id, subject_generation)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT tenant_id, request_id, subject_generation, fenced_at_ms, evidence_sha256
  FROM tenant_credential_revocation_fences FORCE INDEX (
    PRIMARY, uk_tenant_credential_fences_request, uk_tenant_credential_fences_generation
  ) WHERE 1=0;

-- MySQL has no CREATE TRIGGER IF NOT EXISTS. Each immutable table keeps three equivalent
-- permanent guards per mutation and uses a fourth bootstrap guard while rotating them. After one
-- complete install every marker-loss replay prefix retains at least one permanent guard. On a
-- first install no service writer can use these tables until migrations complete.
DROP TRIGGER IF EXISTS trg_tenant_erasure_admissions_bu_bootstrap;
CREATE TRIGGER trg_tenant_erasure_admissions_bu_bootstrap
BEFORE UPDATE ON tenant_erasure_admissions
FOR EACH ROW SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'tenant erasure admission is append-only';
DROP TRIGGER IF EXISTS trg_tenant_erasure_admissions_bu;
CREATE TRIGGER trg_tenant_erasure_admissions_bu
BEFORE UPDATE ON tenant_erasure_admissions
FOR EACH ROW SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'tenant erasure admission is append-only';
DROP TRIGGER IF EXISTS trg_tenant_erasure_admissions_bu_guard_a;
CREATE TRIGGER trg_tenant_erasure_admissions_bu_guard_a
BEFORE UPDATE ON tenant_erasure_admissions
FOR EACH ROW SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'tenant erasure admission is append-only';
DROP TRIGGER IF EXISTS trg_tenant_erasure_admissions_bu_guard_b;
CREATE TRIGGER trg_tenant_erasure_admissions_bu_guard_b
BEFORE UPDATE ON tenant_erasure_admissions
FOR EACH ROW SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'tenant erasure admission is append-only';
DROP TRIGGER IF EXISTS trg_tenant_erasure_admissions_bu_bootstrap;

DROP TRIGGER IF EXISTS trg_tenant_erasure_admissions_bd_bootstrap;
CREATE TRIGGER trg_tenant_erasure_admissions_bd_bootstrap
BEFORE DELETE ON tenant_erasure_admissions
FOR EACH ROW SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'tenant erasure admission is append-only';
DROP TRIGGER IF EXISTS trg_tenant_erasure_admissions_bd;
CREATE TRIGGER trg_tenant_erasure_admissions_bd
BEFORE DELETE ON tenant_erasure_admissions
FOR EACH ROW SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'tenant erasure admission is append-only';
DROP TRIGGER IF EXISTS trg_tenant_erasure_admissions_bd_guard_a;
CREATE TRIGGER trg_tenant_erasure_admissions_bd_guard_a
BEFORE DELETE ON tenant_erasure_admissions
FOR EACH ROW SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'tenant erasure admission is append-only';
DROP TRIGGER IF EXISTS trg_tenant_erasure_admissions_bd_guard_b;
CREATE TRIGGER trg_tenant_erasure_admissions_bd_guard_b
BEFORE DELETE ON tenant_erasure_admissions
FOR EACH ROW SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'tenant erasure admission is append-only';
DROP TRIGGER IF EXISTS trg_tenant_erasure_admissions_bd_bootstrap;

DROP TRIGGER IF EXISTS trg_tenant_credential_fences_bu_bootstrap;
CREATE TRIGGER trg_tenant_credential_fences_bu_bootstrap
BEFORE UPDATE ON tenant_credential_revocation_fences
FOR EACH ROW SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'tenant credential revocation fence is append-only';
DROP TRIGGER IF EXISTS trg_tenant_credential_fences_bu;
CREATE TRIGGER trg_tenant_credential_fences_bu
BEFORE UPDATE ON tenant_credential_revocation_fences
FOR EACH ROW SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'tenant credential revocation fence is append-only';
DROP TRIGGER IF EXISTS trg_tenant_credential_fences_bu_guard_a;
CREATE TRIGGER trg_tenant_credential_fences_bu_guard_a
BEFORE UPDATE ON tenant_credential_revocation_fences
FOR EACH ROW SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'tenant credential revocation fence is append-only';
DROP TRIGGER IF EXISTS trg_tenant_credential_fences_bu_guard_b;
CREATE TRIGGER trg_tenant_credential_fences_bu_guard_b
BEFORE UPDATE ON tenant_credential_revocation_fences
FOR EACH ROW SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'tenant credential revocation fence is append-only';
DROP TRIGGER IF EXISTS trg_tenant_credential_fences_bu_bootstrap;

DROP TRIGGER IF EXISTS trg_tenant_credential_fences_bd_bootstrap;
CREATE TRIGGER trg_tenant_credential_fences_bd_bootstrap
BEFORE DELETE ON tenant_credential_revocation_fences
FOR EACH ROW SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'tenant credential revocation fence is append-only';
DROP TRIGGER IF EXISTS trg_tenant_credential_fences_bd;
CREATE TRIGGER trg_tenant_credential_fences_bd
BEFORE DELETE ON tenant_credential_revocation_fences
FOR EACH ROW SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'tenant credential revocation fence is append-only';
DROP TRIGGER IF EXISTS trg_tenant_credential_fences_bd_guard_a;
CREATE TRIGGER trg_tenant_credential_fences_bd_guard_a
BEFORE DELETE ON tenant_credential_revocation_fences
FOR EACH ROW SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'tenant credential revocation fence is append-only';
DROP TRIGGER IF EXISTS trg_tenant_credential_fences_bd_guard_b;
CREATE TRIGGER trg_tenant_credential_fences_bd_guard_b
BEFORE DELETE ON tenant_credential_revocation_fences
FOR EACH ROW SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'tenant credential revocation fence is append-only';
DROP TRIGGER IF EXISTS trg_tenant_credential_fences_bd_bootstrap;
-- Expand-only substrate for T3a local-database tenant credential revocation. This migration does
-- not materialize or claim jobs, delete API keys/provider rows, clear tenant auth configuration,
-- activate the cutover, purge tenant content, or claim runtime/external credential revocation.
-- Those changes are made later by a claim-bound store transaction using the database clock.
--
-- Jobs are intentionally separate from the frozen user-erasure queue. Receipts contain only
-- aggregate assertions and one-way proof hashes: no API-key hash/id, provider id/config/header,
-- auth policy body, ciphertext, key id, claim token, or other credential material is copied.
--
-- MySQL DDL auto-commits before schema_migrations is recorded. CREATE TABLE, exact FORCE INDEX
-- shape probes and bootstrap-first trigger rotation make marker-loss replay fail closed.

CREATE TABLE IF NOT EXISTS tenant_credential_revocation_jobs (
  request_id                       VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  tenant_id                        VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation               BIGINT UNSIGNED NOT NULL,
  t1_fence_sha256                  CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  phase                            VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  available_at_ms                  BIGINT NULL,
  attempts                         INT UNSIGNED NOT NULL DEFAULT 0,
  claim_token                      VARCHAR(128) COLLATE utf8mb4_0900_as_cs NULL,
  lease_until_ms                   BIGINT NULL,
  last_error_code                  VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL,
  created_at_ms                    BIGINT NOT NULL,
  updated_at_ms                    BIGINT NOT NULL,
  credential_store_revoked_at_ms  BIGINT NULL,
  completed_claim_attempt          INT UNSIGNED NULL,
  completed_claim_token_sha256     CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  blocked_at_ms                    BIGINT NULL,
  blocked_reason_code              VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL,
  CONSTRAINT chk_tenant_credential_revocation_job_generation
    CHECK (subject_generation > 0),
  CONSTRAINT chk_tenant_credential_revocation_job_timestamps
    CHECK (created_at_ms >= 0 AND updated_at_ms >= created_at_ms),
  CONSTRAINT chk_tenant_credential_revocation_job_phase
    CHECK (
      (phase = 'queued'
        AND available_at_ms IS NOT NULL
        AND ((claim_token IS NULL AND lease_until_ms IS NULL)
          OR (claim_token IS NOT NULL AND lease_until_ms IS NOT NULL AND attempts > 0))
        AND (last_error_code IS NULL OR last_error_code = 'temporary_failure')
        AND credential_store_revoked_at_ms IS NULL
        AND completed_claim_attempt IS NULL
        AND completed_claim_token_sha256 IS NULL
        AND blocked_at_ms IS NULL
        AND blocked_reason_code IS NULL)
      OR
      (phase = 'credential_store_revoked'
        AND available_at_ms IS NULL
        AND claim_token IS NULL
        AND lease_until_ms IS NULL
        AND last_error_code IS NULL
        AND credential_store_revoked_at_ms IS NOT NULL
        AND completed_claim_attempt IS NOT NULL
        AND completed_claim_attempt = attempts
        AND completed_claim_token_sha256 IS NOT NULL
        AND blocked_at_ms IS NULL
        AND blocked_reason_code IS NULL)
      OR
      (phase = 'blocked'
        AND available_at_ms IS NULL
        AND claim_token IS NULL
        AND lease_until_ms IS NULL
        AND last_error_code IS NULL
        AND credential_store_revoked_at_ms IS NULL
        AND completed_claim_attempt IS NULL
        AND completed_claim_token_sha256 IS NULL
        AND blocked_at_ms IS NOT NULL
        AND blocked_reason_code = 'integrity_conflict'
        AND attempts > 0)
    ),
  UNIQUE KEY uk_tenant_credential_revocation_jobs_tenant (tenant_id),
  UNIQUE KEY uk_tenant_credential_revocation_jobs_generation
    (tenant_id, subject_generation),
  KEY idx_tenant_credential_revocation_jobs_claim
    (phase, available_at_ms, lease_until_ms, request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT request_id, tenant_id, subject_generation, t1_fence_sha256, phase, available_at_ms,
       attempts, claim_token, lease_until_ms, last_error_code, created_at_ms, updated_at_ms,
       credential_store_revoked_at_ms, completed_claim_attempt, completed_claim_token_sha256,
       blocked_at_ms, blocked_reason_code
  FROM tenant_credential_revocation_jobs FORCE INDEX (
    PRIMARY, uk_tenant_credential_revocation_jobs_tenant,
    uk_tenant_credential_revocation_jobs_generation,
    idx_tenant_credential_revocation_jobs_claim
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_credential_revocation_receipts (
  request_id                          VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  tenant_id                           VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation                  BIGINT UNSIGNED NOT NULL,
  scope                               VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  t1_fence_sha256                     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  api_key_count_before                BIGINT UNSIGNED NOT NULL,
  api_key_count_after                 BIGINT UNSIGNED NOT NULL,
  provider_config_count_before        BIGINT UNSIGNED NOT NULL,
  provider_config_count_after         BIGINT UNSIGNED NOT NULL,
  auth_policy_present_before          BOOLEAN NOT NULL,
  auth_policy_present_after           BOOLEAN NOT NULL,
  auth_secret_cipher_present_before   BOOLEAN NOT NULL,
  auth_secret_cipher_present_after    BOOLEAN NOT NULL,
  auth_secret_key_id_present_before   BOOLEAN NOT NULL,
  auth_secret_key_id_present_after    BOOLEAN NOT NULL,
  store_db_timestamp_ms               BIGINT NOT NULL,
  completed_claim_attempt             INT UNSIGNED NOT NULL,
  completed_claim_token_sha256        CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  runtime_disposition                 VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  external_disposition                VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  content_purge_required              BOOLEAN NOT NULL,
  receipt_sha256                      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  CONSTRAINT chk_tenant_credential_receipt_generation
    CHECK (subject_generation > 0),
  CONSTRAINT chk_tenant_credential_receipt_scope
    CHECK (scope = 'local-db-credential-material-v1'),
  CONSTRAINT chk_tenant_credential_receipt_post_state
    CHECK (
      api_key_count_after = 0
      AND provider_config_count_after = 0
      AND auth_policy_present_after = FALSE
      AND auth_secret_cipher_present_after = FALSE
      AND auth_secret_key_id_present_after = FALSE
    ),
  CONSTRAINT chk_tenant_credential_receipt_disposition
    CHECK (
      runtime_disposition = 'not_in_scope'
      AND external_disposition = 'not_supported'
      AND content_purge_required = TRUE
    ),
  CONSTRAINT chk_tenant_credential_receipt_completion
    CHECK (store_db_timestamp_ms >= 0 AND completed_claim_attempt > 0),
  UNIQUE KEY uk_tenant_credential_revocation_receipts_tenant (tenant_id),
  UNIQUE KEY uk_tenant_credential_revocation_receipts_generation
    (tenant_id, subject_generation),
  UNIQUE KEY uk_tenant_credential_revocation_receipts_hash (receipt_sha256)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT request_id, tenant_id, subject_generation, scope, t1_fence_sha256,
       api_key_count_before, api_key_count_after,
       provider_config_count_before, provider_config_count_after,
       auth_policy_present_before, auth_policy_present_after,
       auth_secret_cipher_present_before, auth_secret_cipher_present_after,
       auth_secret_key_id_present_before, auth_secret_key_id_present_after,
       store_db_timestamp_ms, completed_claim_attempt, completed_claim_token_sha256,
       runtime_disposition, external_disposition, content_purge_required, receipt_sha256
  FROM tenant_credential_revocation_receipts FORCE INDEX (
    PRIMARY, uk_tenant_credential_revocation_receipts_tenant,
    uk_tenant_credential_revocation_receipts_generation,
    uk_tenant_credential_revocation_receipts_hash
  ) WHERE 1=0;

-- The singleton stays inactive throughout expand. The transaction writing the first receipt must
-- perform the sole generation 0 -> 1 update and bind that receipt's hash/timestamp. There is no
-- disable, generation 2, or separate public activation operation.
CREATE TABLE IF NOT EXISTS tenant_credential_revocation_cutover (
  singleton_id          TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  control_generation    BIGINT UNSIGNED NOT NULL DEFAULT 0,
  activated_at_ms       BIGINT NULL,
  first_receipt_sha256  CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  evidence_sha256       CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  CONSTRAINT chk_tenant_credential_revocation_cutover_singleton
    CHECK (singleton_id = 1),
  CONSTRAINT chk_tenant_credential_revocation_cutover_state
    CHECK (
      (control_generation = 0
        AND activated_at_ms IS NULL
        AND first_receipt_sha256 IS NULL
        AND evidence_sha256 IS NULL)
      OR
      (control_generation = 1
        AND activated_at_ms IS NOT NULL
        AND first_receipt_sha256 IS NOT NULL
        AND evidence_sha256 IS NOT NULL)
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT singleton_id, control_generation, activated_at_ms, first_receipt_sha256, evidence_sha256
  FROM tenant_credential_revocation_cutover FORCE INDEX (PRIMARY) WHERE 1=0;

INSERT INTO tenant_credential_revocation_cutover
  (singleton_id, control_generation, activated_at_ms, first_receipt_sha256, evidence_sha256)
SELECT 1, 0, NULL, NULL, NULL
 WHERE NOT EXISTS (
   SELECT 1 FROM tenant_credential_revocation_cutover WHERE singleton_id = 1
 );

-- Job owner coordinates and T1 evidence are immutable, attempts are monotonic, and terminal rows
-- are write-once. Bootstrap-first rotation retains a permanent guard on marker-loss replay.
DROP TRIGGER IF EXISTS trg_tenant_credential_jobs_bu_bootstrap;
CREATE TRIGGER trg_tenant_credential_jobs_bu_bootstrap BEFORE UPDATE ON tenant_credential_revocation_jobs FOR EACH ROW BEGIN IF NOT (OLD.request_id <=> NEW.request_id AND OLD.tenant_id <=> NEW.tenant_id AND OLD.subject_generation <=> NEW.subject_generation AND OLD.t1_fence_sha256 <=> NEW.t1_fence_sha256 AND OLD.created_at_ms <=> NEW.created_at_ms AND OLD.phase = 'queued' AND NEW.attempts >= OLD.attempts AND NEW.attempts <= OLD.attempts + 1 AND NEW.updated_at_ms >= OLD.updated_at_ms) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant credential revocation job identity or terminal state is immutable'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_credential_jobs_bu;
CREATE TRIGGER trg_tenant_credential_jobs_bu BEFORE UPDATE ON tenant_credential_revocation_jobs FOR EACH ROW BEGIN IF NOT (OLD.request_id <=> NEW.request_id AND OLD.tenant_id <=> NEW.tenant_id AND OLD.subject_generation <=> NEW.subject_generation AND OLD.t1_fence_sha256 <=> NEW.t1_fence_sha256 AND OLD.created_at_ms <=> NEW.created_at_ms AND OLD.phase = 'queued' AND NEW.attempts >= OLD.attempts AND NEW.attempts <= OLD.attempts + 1 AND NEW.updated_at_ms >= OLD.updated_at_ms) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant credential revocation job identity or terminal state is immutable'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_credential_jobs_bu_guard_a;
CREATE TRIGGER trg_tenant_credential_jobs_bu_guard_a BEFORE UPDATE ON tenant_credential_revocation_jobs FOR EACH ROW BEGIN IF NOT (OLD.request_id <=> NEW.request_id AND OLD.tenant_id <=> NEW.tenant_id AND OLD.subject_generation <=> NEW.subject_generation AND OLD.t1_fence_sha256 <=> NEW.t1_fence_sha256 AND OLD.created_at_ms <=> NEW.created_at_ms AND OLD.phase = 'queued' AND NEW.attempts >= OLD.attempts AND NEW.attempts <= OLD.attempts + 1 AND NEW.updated_at_ms >= OLD.updated_at_ms) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant credential revocation job identity or terminal state is immutable'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_credential_jobs_bu_guard_b;
CREATE TRIGGER trg_tenant_credential_jobs_bu_guard_b BEFORE UPDATE ON tenant_credential_revocation_jobs FOR EACH ROW BEGIN IF NOT (OLD.request_id <=> NEW.request_id AND OLD.tenant_id <=> NEW.tenant_id AND OLD.subject_generation <=> NEW.subject_generation AND OLD.t1_fence_sha256 <=> NEW.t1_fence_sha256 AND OLD.created_at_ms <=> NEW.created_at_ms AND OLD.phase = 'queued' AND NEW.attempts >= OLD.attempts AND NEW.attempts <= OLD.attempts + 1 AND NEW.updated_at_ms >= OLD.updated_at_ms) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant credential revocation job identity or terminal state is immutable'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_credential_jobs_bu_bootstrap;

DROP TRIGGER IF EXISTS trg_tenant_credential_jobs_bd_bootstrap;
CREATE TRIGGER trg_tenant_credential_jobs_bd_bootstrap BEFORE DELETE ON tenant_credential_revocation_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant credential revocation jobs cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_credential_jobs_bd;
CREATE TRIGGER trg_tenant_credential_jobs_bd BEFORE DELETE ON tenant_credential_revocation_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant credential revocation jobs cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_credential_jobs_bd_guard_a;
CREATE TRIGGER trg_tenant_credential_jobs_bd_guard_a BEFORE DELETE ON tenant_credential_revocation_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant credential revocation jobs cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_credential_jobs_bd_guard_b;
CREATE TRIGGER trg_tenant_credential_jobs_bd_guard_b BEFORE DELETE ON tenant_credential_revocation_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant credential revocation jobs cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_credential_jobs_bd_bootstrap;

-- Receipts are content-free, immutable proof. They never expose a pending/updateable proof state.
DROP TRIGGER IF EXISTS trg_tenant_credential_receipts_bu_bootstrap;
CREATE TRIGGER trg_tenant_credential_receipts_bu_bootstrap BEFORE UPDATE ON tenant_credential_revocation_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant credential revocation receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_credential_receipts_bu;
CREATE TRIGGER trg_tenant_credential_receipts_bu BEFORE UPDATE ON tenant_credential_revocation_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant credential revocation receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_credential_receipts_bu_guard_a;
CREATE TRIGGER trg_tenant_credential_receipts_bu_guard_a BEFORE UPDATE ON tenant_credential_revocation_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant credential revocation receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_credential_receipts_bu_guard_b;
CREATE TRIGGER trg_tenant_credential_receipts_bu_guard_b BEFORE UPDATE ON tenant_credential_revocation_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant credential revocation receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_credential_receipts_bu_bootstrap;

DROP TRIGGER IF EXISTS trg_tenant_credential_receipts_bd_bootstrap;
CREATE TRIGGER trg_tenant_credential_receipts_bd_bootstrap BEFORE DELETE ON tenant_credential_revocation_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant credential revocation receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_credential_receipts_bd;
CREATE TRIGGER trg_tenant_credential_receipts_bd BEFORE DELETE ON tenant_credential_revocation_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant credential revocation receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_credential_receipts_bd_guard_a;
CREATE TRIGGER trg_tenant_credential_receipts_bd_guard_a BEFORE DELETE ON tenant_credential_revocation_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant credential revocation receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_credential_receipts_bd_guard_b;
CREATE TRIGGER trg_tenant_credential_receipts_bd_guard_b BEFORE DELETE ON tenant_credential_revocation_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant credential revocation receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_credential_receipts_bd_bootstrap;

-- The cutover admits exactly one inactive -> active transition; after that its first-receipt proof
-- cannot be replaced. It is activated only inside the transaction committing the first receipt.
DROP TRIGGER IF EXISTS trg_tenant_credential_cutover_bu_bootstrap;
CREATE TRIGGER trg_tenant_credential_cutover_bu_bootstrap BEFORE UPDATE ON tenant_credential_revocation_cutover FOR EACH ROW BEGIN IF NOT (OLD.singleton_id = 1 AND NEW.singleton_id = 1 AND OLD.control_generation = 0 AND OLD.activated_at_ms IS NULL AND OLD.first_receipt_sha256 IS NULL AND OLD.evidence_sha256 IS NULL AND NEW.control_generation = 1 AND NEW.activated_at_ms IS NOT NULL AND NEW.first_receipt_sha256 IS NOT NULL AND NEW.evidence_sha256 IS NOT NULL) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant credential revocation cutover is write-once'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_credential_cutover_bu;
CREATE TRIGGER trg_tenant_credential_cutover_bu BEFORE UPDATE ON tenant_credential_revocation_cutover FOR EACH ROW BEGIN IF NOT (OLD.singleton_id = 1 AND NEW.singleton_id = 1 AND OLD.control_generation = 0 AND OLD.activated_at_ms IS NULL AND OLD.first_receipt_sha256 IS NULL AND OLD.evidence_sha256 IS NULL AND NEW.control_generation = 1 AND NEW.activated_at_ms IS NOT NULL AND NEW.first_receipt_sha256 IS NOT NULL AND NEW.evidence_sha256 IS NOT NULL) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant credential revocation cutover is write-once'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_credential_cutover_bu_guard_a;
CREATE TRIGGER trg_tenant_credential_cutover_bu_guard_a BEFORE UPDATE ON tenant_credential_revocation_cutover FOR EACH ROW BEGIN IF NOT (OLD.singleton_id = 1 AND NEW.singleton_id = 1 AND OLD.control_generation = 0 AND OLD.activated_at_ms IS NULL AND OLD.first_receipt_sha256 IS NULL AND OLD.evidence_sha256 IS NULL AND NEW.control_generation = 1 AND NEW.activated_at_ms IS NOT NULL AND NEW.first_receipt_sha256 IS NOT NULL AND NEW.evidence_sha256 IS NOT NULL) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant credential revocation cutover is write-once'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_credential_cutover_bu_guard_b;
CREATE TRIGGER trg_tenant_credential_cutover_bu_guard_b BEFORE UPDATE ON tenant_credential_revocation_cutover FOR EACH ROW BEGIN IF NOT (OLD.singleton_id = 1 AND NEW.singleton_id = 1 AND OLD.control_generation = 0 AND OLD.activated_at_ms IS NULL AND OLD.first_receipt_sha256 IS NULL AND OLD.evidence_sha256 IS NULL AND NEW.control_generation = 1 AND NEW.activated_at_ms IS NOT NULL AND NEW.first_receipt_sha256 IS NOT NULL AND NEW.evidence_sha256 IS NOT NULL) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant credential revocation cutover is write-once'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_credential_cutover_bu_bootstrap;

DROP TRIGGER IF EXISTS trg_tenant_credential_cutover_bd_bootstrap;
CREATE TRIGGER trg_tenant_credential_cutover_bd_bootstrap BEFORE DELETE ON tenant_credential_revocation_cutover FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant credential revocation cutover cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_credential_cutover_bd;
CREATE TRIGGER trg_tenant_credential_cutover_bd BEFORE DELETE ON tenant_credential_revocation_cutover FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant credential revocation cutover cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_credential_cutover_bd_guard_a;
CREATE TRIGGER trg_tenant_credential_cutover_bd_guard_a BEFORE DELETE ON tenant_credential_revocation_cutover FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant credential revocation cutover cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_credential_cutover_bd_guard_b;
CREATE TRIGGER trg_tenant_credential_cutover_bd_guard_b BEFORE DELETE ON tenant_credential_revocation_cutover FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant credential revocation cutover cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_credential_cutover_bd_bootstrap;
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

INSERT INTO schema_migrations (name, applied_at_ms) VALUES
  ('0018_tenant_credential_revocation_fence.sql', 18),
  ('0019_tenant_credential_physical_revocation.sql', 19),
  ('0020_tenant_runtime_revocation.sql', 20);
