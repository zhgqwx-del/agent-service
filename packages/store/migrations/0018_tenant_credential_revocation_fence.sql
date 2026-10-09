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
