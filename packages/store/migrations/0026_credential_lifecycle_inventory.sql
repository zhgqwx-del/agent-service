-- Expand-only, default-dormant credential lifecycle inventory substrate.
--
-- This migration does not inspect a provider/auth value, backfill a tenant, create a credential
-- version/target, activate tracking, or change T3a execution. The only seeded row is the inactive
-- singleton. No table stores provider config JSON, plaintext/ciphertext credentials, custom header
-- values, base URLs, or endpoint parameter values. Target locator ciphertext remains NULL for the
-- current adapters; therefore current code cannot truthfully write executable_ref.
--
-- MySQL DDL auto-commits before schema_migrations is recorded. Every table/column/index/FK is
-- replay-safe, exact shape probes fail closed, and bootstrap/final/guard_a remain as three
-- equivalent guards so marker-loss replay retains protection across every DDL auto-commit boundary.

CREATE TABLE IF NOT EXISTS tenant_credential_tracking_cutover (
  singleton_id                    TINYINT UNSIGNED NOT NULL,
  control_generation              BIGINT UNSIGNED NOT NULL DEFAULT 0,
  activated_at_db_ms              BIGINT NULL,
  subject_count                   BIGINT UNSIGNED NULL,
  subject_root_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  provider_slot_count             BIGINT UNSIGNED NULL,
  provider_slot_root_sha256       CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  auth_slot_count                 BIGINT UNSIGNED NULL,
  auth_slot_root_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  version_count                   BIGINT UNSIGNED NULL,
  version_root_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  target_disposition_count        BIGINT UNSIGNED NULL,
  target_disposition_root_sha256  CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  evidence_sha256                 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  PRIMARY KEY (singleton_id),
  CONSTRAINT chk_credential_tracking_cutover_singleton CHECK (singleton_id = 1),
  CONSTRAINT chk_credential_tracking_cutover_state CHECK (
    (control_generation = 0
      AND activated_at_db_ms IS NULL
      AND subject_count IS NULL AND subject_root_sha256 IS NULL
      AND provider_slot_count IS NULL AND provider_slot_root_sha256 IS NULL
      AND auth_slot_count IS NULL AND auth_slot_root_sha256 IS NULL
      AND version_count IS NULL AND version_root_sha256 IS NULL
      AND target_disposition_count IS NULL AND target_disposition_root_sha256 IS NULL
      AND evidence_sha256 IS NULL)
    OR
    (control_generation = 1
      AND activated_at_db_ms IS NOT NULL AND activated_at_db_ms >= 0
      AND subject_count IS NOT NULL AND subject_root_sha256 IS NOT NULL
      AND provider_slot_count IS NOT NULL AND provider_slot_root_sha256 IS NOT NULL
      AND auth_slot_count = subject_count AND auth_slot_root_sha256 IS NOT NULL
      AND version_count IS NOT NULL AND version_root_sha256 IS NOT NULL
      AND target_disposition_count = version_count * 2
      AND target_disposition_root_sha256 IS NOT NULL AND evidence_sha256 IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT singleton_id, control_generation, activated_at_db_ms, subject_count,
       subject_root_sha256, provider_slot_count, provider_slot_root_sha256,
       auth_slot_count, auth_slot_root_sha256, version_count, version_root_sha256,
       target_disposition_count, target_disposition_root_sha256, evidence_sha256
  FROM tenant_credential_tracking_cutover FORCE INDEX (PRIMARY) WHERE 1=0;

INSERT INTO tenant_credential_tracking_cutover
  (singleton_id, control_generation, activated_at_db_ms, subject_count,
   subject_root_sha256, provider_slot_count, provider_slot_root_sha256,
   auth_slot_count, auth_slot_root_sha256, version_count, version_root_sha256,
   target_disposition_count, target_disposition_root_sha256, evidence_sha256)
SELECT 1, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
 WHERE NOT EXISTS (
   SELECT 1 FROM tenant_credential_tracking_cutover WHERE singleton_id = 1
 );

-- One immutable coverage/gap record exists for every tenant at activation, even if that tenant has
-- no live provider/auth source. This prevents an empty current-source scan from erasing unknown
-- pre-cutover history.
CREATE TABLE IF NOT EXISTS tenant_credential_tracking_subjects (
  tenant_id                  VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tracking_started_at_db_ms  BIGINT NOT NULL,
  history_status             VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  origin                     VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  evidence_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (tenant_id),
  UNIQUE KEY uk_credential_tracking_subject_evidence (evidence_sha256),
  CONSTRAINT chk_credential_tracking_subject_clock CHECK (tracking_started_at_db_ms >= 0),
  CONSTRAINT chk_credential_tracking_subject_origin CHECK (
    (history_status = 'complete_since_creation' AND origin = 'managed_v1')
    OR (history_status = 'legacy_history_unknown' AND origin = 'legacy_observed')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT tenant_id, tracking_started_at_db_ms, history_status, origin, evidence_sha256
  FROM tenant_credential_tracking_subjects FORCE INDEX (
    PRIMARY, uk_credential_tracking_subject_evidence
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_credential_versions (
  credential_version_id        CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                     VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  slot_kind                     VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  slot_id_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  origin                        VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  encrypted_secret_present      BOOLEAN NOT NULL,
  secret_key_id_present         BOOLEAN NOT NULL,
  custom_headers_present        BOOLEAN NOT NULL,
  endpoint_parameters_present   BOOLEAN NOT NULL,
  created_at_db_ms              BIGINT NOT NULL,
  retired_at_db_ms              BIGINT NULL,
  retire_reason                 VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL,
  evidence_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (credential_version_id),
  UNIQUE KEY uk_credential_versions_evidence (evidence_sha256),
  KEY idx_credential_versions_tenant_slot
    (tenant_id, slot_kind, slot_id_sha256, created_at_db_ms, credential_version_id),
  UNIQUE KEY uk_credential_versions_tenant_fk (credential_version_id, tenant_id),
  CONSTRAINT fk_credential_version_subject FOREIGN KEY (tenant_id)
    REFERENCES tenant_credential_tracking_subjects (tenant_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_credential_version_slot CHECK (
    slot_kind IN ('provider_binding','tenant_auth_secret')
  ),
  CONSTRAINT chk_credential_version_origin CHECK (
    origin IN ('managed_v1','legacy_observed')
  ),
  CONSTRAINT chk_credential_version_material CHECK (
    encrypted_secret_present = secret_key_id_present
    AND (encrypted_secret_present OR custom_headers_present OR endpoint_parameters_present)
    AND (slot_kind <> 'tenant_auth_secret'
      OR (encrypted_secret_present AND NOT custom_headers_present
        AND NOT endpoint_parameters_present))
  ),
  CONSTRAINT chk_credential_version_retirement CHECK (
    (retired_at_db_ms IS NULL AND retire_reason IS NULL)
    OR (retired_at_db_ms IS NOT NULL AND retired_at_db_ms >= created_at_db_ms
      AND retire_reason IS NOT NULL
      AND retire_reason IN ('replaced','deleted','cleared','tenant_erasure'))
  ),
  CONSTRAINT chk_credential_version_clock CHECK (created_at_db_ms >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT credential_version_id, tenant_id, slot_kind, slot_id_sha256, origin,
       encrypted_secret_present, secret_key_id_present, custom_headers_present,
       endpoint_parameters_present, created_at_db_ms, retired_at_db_ms,
       retire_reason, evidence_sha256
  FROM tenant_credential_versions FORCE INDEX (
    PRIMARY, uk_credential_versions_evidence, idx_credential_versions_tenant_slot,
    uk_credential_versions_tenant_fk
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_credential_target_dispositions (
  credential_version_id          CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                       VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  domain                          VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  disposition                     VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  adapter_protocol                VARCHAR(128) COLLATE utf8mb4_0900_as_cs NULL,
  target_reference_cipher         VARBINARY(8192) NULL,
  target_reference_key_id         VARCHAR(128) COLLATE utf8mb4_0900_as_cs NULL,
  target_reference_cipher_sha256  CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  target_reference_sha256         CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  captured_at_db_ms               BIGINT NOT NULL,
  evidence_sha256                 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (credential_version_id, domain),
  UNIQUE KEY uk_credential_target_evidence (evidence_sha256),
  KEY idx_credential_targets_tenant (tenant_id, credential_version_id, domain),
  CONSTRAINT fk_credential_target_version
    FOREIGN KEY (credential_version_id, tenant_id)
    REFERENCES tenant_credential_versions (credential_version_id, tenant_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_credential_target_domain CHECK (
    domain IN ('external_credential','kms_key')
  ),
  CONSTRAINT chk_credential_target_disposition CHECK (
    disposition IN ('executable_ref','not_applicable','blocked_no_locator',
      'blocked_adapter_unconfigured','blocked_shared_local_key','blocked_legacy_history')
  ),
  CONSTRAINT chk_credential_target_reference CHECK (
    (disposition IN ('executable_ref','blocked_adapter_unconfigured')
      AND adapter_protocol IS NOT NULL AND target_reference_cipher IS NOT NULL
      AND target_reference_key_id IS NOT NULL
      AND target_reference_cipher_sha256 IS NOT NULL
      AND target_reference_sha256 IS NOT NULL)
    OR
    (disposition NOT IN ('executable_ref','blocked_adapter_unconfigured')
      AND adapter_protocol IS NULL AND target_reference_cipher IS NULL
      AND target_reference_key_id IS NULL
      AND target_reference_cipher_sha256 IS NULL AND target_reference_sha256 IS NULL)
  ),
  CONSTRAINT chk_credential_target_domain_disposition CHECK (
    (disposition <> 'blocked_no_locator' OR domain = 'external_credential')
    AND (disposition <> 'blocked_shared_local_key' OR domain = 'kms_key')
  ),
  CONSTRAINT chk_credential_target_clock CHECK (captured_at_db_ms >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT credential_version_id, tenant_id, domain, disposition, adapter_protocol,
       target_reference_cipher, target_reference_key_id,
       target_reference_cipher_sha256, target_reference_sha256,
       captured_at_db_ms, evidence_sha256
  FROM tenant_credential_target_dispositions FORCE INDEX (
    PRIMARY, uk_credential_target_evidence, idx_credential_targets_tenant
  ) WHERE 1=0;

-- Provider slots are permanent ABA fences. Deleting a provider makes source_present false but does
-- not delete this row or reset write_generation. Raw provider ids are never copied here.
CREATE TABLE IF NOT EXISTS tenant_credential_provider_slots (
  tenant_id                     VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  slot_id_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  write_generation              BIGINT UNSIGNED NOT NULL,
  source_present                BOOLEAN NOT NULL,
  current_credential_version_id CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  updated_at_db_ms              BIGINT NOT NULL,
  evidence_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (tenant_id, slot_id_sha256),
  UNIQUE KEY uk_credential_provider_slot_evidence (evidence_sha256),
  KEY idx_credential_provider_slot_version (current_credential_version_id, tenant_id),
  CONSTRAINT fk_credential_provider_slot_subject FOREIGN KEY (tenant_id)
    REFERENCES tenant_credential_tracking_subjects (tenant_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_credential_provider_slot_version
    FOREIGN KEY (current_credential_version_id, tenant_id)
    REFERENCES tenant_credential_versions (credential_version_id, tenant_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_credential_provider_slot_state CHECK (
    write_generation > 0 AND updated_at_db_ms >= 0
    AND (source_present OR current_credential_version_id IS NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT tenant_id, slot_id_sha256, write_generation, source_present,
       current_credential_version_id, updated_at_db_ms, evidence_sha256
  FROM tenant_credential_provider_slots FORCE INDEX (
    PRIMARY, uk_credential_provider_slot_evidence, idx_credential_provider_slot_version
  ) WHERE 1=0;

-- Add source projections only after their immutable ledger targets exist. Exact metadata checks
-- intentionally attempt a duplicate ADD on an incompatible partial install, failing closed.
SET @credential_provider_slot_column_shape = (
  SELECT CONCAT(column_type,':',is_nullable,':',COALESCE(collation_name,''))
    FROM information_schema.columns WHERE table_schema=DATABASE()
     AND table_name='provider_configs' AND column_name='credential_slot_id_sha256'
);
SET @migration_sql = IF(
  @credential_provider_slot_column_shape IS NULL,
  'ALTER TABLE provider_configs ADD COLUMN credential_slot_id_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL AFTER provider_id',
  IF(@credential_provider_slot_column_shape='char(64):YES:utf8mb4_0900_as_cs','SELECT 1',
    'ALTER TABLE provider_configs ADD COLUMN credential_slot_id_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL AFTER provider_id')
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- Install every source column before compiling the conditional source triggers below. The later
-- exact-shape reconciliation repeats these guards intentionally so crash/replay converges.
SET @has_credential_provider_generation_early = (
  SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE()
   AND table_name='provider_configs' AND column_name='credential_write_generation'
);
SET @migration_sql = IF(@has_credential_provider_generation_early=0,
  'ALTER TABLE provider_configs ADD COLUMN credential_write_generation BIGINT UNSIGNED NULL AFTER credential_slot_id_sha256','SELECT 1');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_credential_provider_version_early = (
  SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE()
   AND table_name='provider_configs' AND column_name='credential_version_id'
);
SET @migration_sql = IF(@has_credential_provider_version_early=0,
  'ALTER TABLE provider_configs ADD COLUMN credential_version_id CHAR(64) COLLATE utf8mb4_0900_as_cs NULL AFTER credential_write_generation','SELECT 1');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_credential_auth_generation_early = (
  SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE()
   AND table_name='tenants' AND column_name='auth_write_generation'
);
SET @migration_sql = IF(@has_credential_auth_generation_early=0,
  'ALTER TABLE tenants ADD COLUMN auth_write_generation BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER auth_secret_key_id','SELECT 1');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_credential_auth_version_early = (
  SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE()
   AND table_name='tenants' AND column_name='auth_credential_version_id'
);
SET @migration_sql = IF(@has_credential_auth_version_early=0,
  'ALTER TABLE tenants ADD COLUMN auth_credential_version_id CHAR(64) COLLATE utf8mb4_0900_as_cs NULL AFTER auth_write_generation','SELECT 1');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_credential_auth_updated_early = (
  SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE()
   AND table_name='tenants' AND column_name='auth_credential_updated_at_db_ms'
);
SET @migration_sql = IF(@has_credential_auth_updated_early=0,
  'ALTER TABLE tenants ADD COLUMN auth_credential_updated_at_db_ms BIGINT NOT NULL DEFAULT 0 AFTER auth_credential_version_id','SELECT 1');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- Active-cutover source guards. Missing cutover singleton is treated as active/fail-closed.
-- Provider INSERT/UPDATE must match the permanent slot projection; DELETE must first advance that
-- slot to source_present=false. This closes delete/recreate ABA even for keyless providers.
DROP TRIGGER IF EXISTS trg_provider_credential_bi_bootstrap;
CREATE TRIGGER trg_provider_credential_bi_bootstrap BEFORE INSERT ON provider_configs FOR EACH ROW BEGIN DECLARE v_tracking BIGINT UNSIGNED DEFAULT 1; SELECT control_generation FROM tenant_credential_tracking_cutover WHERE singleton_id=1 FOR SHARE INTO v_tracking; IF v_tracking<>0 AND NOT (NEW.credential_slot_id_sha256 IS NOT NULL AND NEW.credential_write_generation IS NOT NULL AND NEW.credential_write_generation>0 AND EXISTS (SELECT 1 FROM tenant_credential_tracking_subjects s WHERE s.tenant_id=NEW.tenant_id) AND EXISTS (SELECT 1 FROM tenant_credential_provider_slots s WHERE s.tenant_id=NEW.tenant_id AND s.slot_id_sha256=NEW.credential_slot_id_sha256 AND s.write_generation=NEW.credential_write_generation AND s.source_present=TRUE AND s.current_credential_version_id<=>NEW.credential_version_id) AND (NEW.credential_version_id IS NULL OR EXISTS (SELECT 1 FROM tenant_credential_versions v WHERE v.credential_version_id=NEW.credential_version_id AND v.tenant_id=NEW.tenant_id AND v.slot_kind='provider_binding' AND v.slot_id_sha256=NEW.credential_slot_id_sha256 AND v.retired_at_db_ms IS NULL AND (SELECT COUNT(*) FROM tenant_credential_target_dispositions d WHERE d.credential_version_id=v.credential_version_id)=2))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active credential cutover rejects untracked provider insert'; END IF; END;
DROP TRIGGER IF EXISTS trg_provider_credential_bi;
CREATE TRIGGER trg_provider_credential_bi BEFORE INSERT ON provider_configs FOR EACH ROW BEGIN DECLARE v_tracking BIGINT UNSIGNED DEFAULT 1; SELECT control_generation FROM tenant_credential_tracking_cutover WHERE singleton_id=1 FOR SHARE INTO v_tracking; IF v_tracking<>0 AND NOT (NEW.credential_slot_id_sha256 IS NOT NULL AND NEW.credential_write_generation IS NOT NULL AND NEW.credential_write_generation>0 AND EXISTS (SELECT 1 FROM tenant_credential_tracking_subjects s WHERE s.tenant_id=NEW.tenant_id) AND EXISTS (SELECT 1 FROM tenant_credential_provider_slots s WHERE s.tenant_id=NEW.tenant_id AND s.slot_id_sha256=NEW.credential_slot_id_sha256 AND s.write_generation=NEW.credential_write_generation AND s.source_present=TRUE AND s.current_credential_version_id<=>NEW.credential_version_id) AND (NEW.credential_version_id IS NULL OR EXISTS (SELECT 1 FROM tenant_credential_versions v WHERE v.credential_version_id=NEW.credential_version_id AND v.tenant_id=NEW.tenant_id AND v.slot_kind='provider_binding' AND v.slot_id_sha256=NEW.credential_slot_id_sha256 AND v.retired_at_db_ms IS NULL AND (SELECT COUNT(*) FROM tenant_credential_target_dispositions d WHERE d.credential_version_id=v.credential_version_id)=2))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active credential cutover rejects untracked provider insert'; END IF; END;
DROP TRIGGER IF EXISTS trg_provider_credential_bi_guard_a;
CREATE TRIGGER trg_provider_credential_bi_guard_a BEFORE INSERT ON provider_configs FOR EACH ROW BEGIN DECLARE v_tracking BIGINT UNSIGNED DEFAULT 1; SELECT control_generation FROM tenant_credential_tracking_cutover WHERE singleton_id=1 FOR SHARE INTO v_tracking; IF v_tracking<>0 AND NOT (NEW.credential_slot_id_sha256 IS NOT NULL AND NEW.credential_write_generation IS NOT NULL AND NEW.credential_write_generation>0 AND EXISTS (SELECT 1 FROM tenant_credential_tracking_subjects s WHERE s.tenant_id=NEW.tenant_id) AND EXISTS (SELECT 1 FROM tenant_credential_provider_slots s WHERE s.tenant_id=NEW.tenant_id AND s.slot_id_sha256=NEW.credential_slot_id_sha256 AND s.write_generation=NEW.credential_write_generation AND s.source_present=TRUE AND s.current_credential_version_id<=>NEW.credential_version_id) AND (NEW.credential_version_id IS NULL OR EXISTS (SELECT 1 FROM tenant_credential_versions v WHERE v.credential_version_id=NEW.credential_version_id AND v.tenant_id=NEW.tenant_id AND v.slot_kind='provider_binding' AND v.slot_id_sha256=NEW.credential_slot_id_sha256 AND v.retired_at_db_ms IS NULL AND (SELECT COUNT(*) FROM tenant_credential_target_dispositions d WHERE d.credential_version_id=v.credential_version_id)=2))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active credential cutover rejects untracked provider insert'; END IF; END;
DROP TRIGGER IF EXISTS trg_provider_credential_bu_bootstrap;
CREATE TRIGGER trg_provider_credential_bu_bootstrap BEFORE UPDATE ON provider_configs FOR EACH ROW BEGIN DECLARE v_tracking BIGINT UNSIGNED DEFAULT 1; SELECT control_generation FROM tenant_credential_tracking_cutover WHERE singleton_id=1 FOR SHARE INTO v_tracking; IF v_tracking<>0 AND NOT (OLD.tenant_id<=>NEW.tenant_id AND OLD.provider_id<=>NEW.provider_id AND NEW.credential_slot_id_sha256 IS NOT NULL AND NEW.credential_write_generation IS NOT NULL AND EXISTS (SELECT 1 FROM tenant_credential_provider_slots s WHERE s.tenant_id=NEW.tenant_id AND s.slot_id_sha256=NEW.credential_slot_id_sha256 AND s.write_generation=NEW.credential_write_generation AND s.source_present=TRUE AND s.current_credential_version_id<=>NEW.credential_version_id) AND (NEW.credential_version_id IS NULL OR EXISTS (SELECT 1 FROM tenant_credential_versions v WHERE v.credential_version_id=NEW.credential_version_id AND v.tenant_id=NEW.tenant_id AND v.slot_kind='provider_binding' AND v.slot_id_sha256=NEW.credential_slot_id_sha256 AND v.retired_at_db_ms IS NULL AND (SELECT COUNT(*) FROM tenant_credential_target_dispositions d WHERE d.credential_version_id=v.credential_version_id)=2)) AND ((OLD.config<=>NEW.config AND OLD.secret_cipher<=>NEW.secret_cipher AND OLD.secret_key_id<=>NEW.secret_key_id AND OLD.credential_slot_id_sha256<=>NEW.credential_slot_id_sha256 AND OLD.credential_write_generation<=>NEW.credential_write_generation AND OLD.credential_version_id<=>NEW.credential_version_id) OR (NOT (OLD.config<=>NEW.config AND OLD.secret_cipher<=>NEW.secret_cipher AND OLD.secret_key_id<=>NEW.secret_key_id) AND NEW.credential_slot_id_sha256<=>OLD.credential_slot_id_sha256 AND NEW.credential_write_generation=OLD.credential_write_generation+1 AND NEW.updated_at_ms>OLD.updated_at_ms AND (OLD.credential_version_id IS NULL OR EXISTS (SELECT 1 FROM tenant_credential_versions ov WHERE ov.credential_version_id=OLD.credential_version_id AND ov.retired_at_db_ms IS NOT NULL AND ov.retire_reason='replaced'))))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active credential cutover rejects stale provider update'; END IF; END;
DROP TRIGGER IF EXISTS trg_provider_credential_bu;
CREATE TRIGGER trg_provider_credential_bu BEFORE UPDATE ON provider_configs FOR EACH ROW BEGIN DECLARE v_tracking BIGINT UNSIGNED DEFAULT 1; SELECT control_generation FROM tenant_credential_tracking_cutover WHERE singleton_id=1 FOR SHARE INTO v_tracking; IF v_tracking<>0 AND NOT (OLD.tenant_id<=>NEW.tenant_id AND OLD.provider_id<=>NEW.provider_id AND NEW.credential_slot_id_sha256 IS NOT NULL AND NEW.credential_write_generation IS NOT NULL AND EXISTS (SELECT 1 FROM tenant_credential_provider_slots s WHERE s.tenant_id=NEW.tenant_id AND s.slot_id_sha256=NEW.credential_slot_id_sha256 AND s.write_generation=NEW.credential_write_generation AND s.source_present=TRUE AND s.current_credential_version_id<=>NEW.credential_version_id) AND (NEW.credential_version_id IS NULL OR EXISTS (SELECT 1 FROM tenant_credential_versions v WHERE v.credential_version_id=NEW.credential_version_id AND v.tenant_id=NEW.tenant_id AND v.slot_kind='provider_binding' AND v.slot_id_sha256=NEW.credential_slot_id_sha256 AND v.retired_at_db_ms IS NULL AND (SELECT COUNT(*) FROM tenant_credential_target_dispositions d WHERE d.credential_version_id=v.credential_version_id)=2)) AND ((OLD.config<=>NEW.config AND OLD.secret_cipher<=>NEW.secret_cipher AND OLD.secret_key_id<=>NEW.secret_key_id AND OLD.credential_slot_id_sha256<=>NEW.credential_slot_id_sha256 AND OLD.credential_write_generation<=>NEW.credential_write_generation AND OLD.credential_version_id<=>NEW.credential_version_id) OR (NOT (OLD.config<=>NEW.config AND OLD.secret_cipher<=>NEW.secret_cipher AND OLD.secret_key_id<=>NEW.secret_key_id) AND NEW.credential_slot_id_sha256<=>OLD.credential_slot_id_sha256 AND NEW.credential_write_generation=OLD.credential_write_generation+1 AND NEW.updated_at_ms>OLD.updated_at_ms AND (OLD.credential_version_id IS NULL OR EXISTS (SELECT 1 FROM tenant_credential_versions ov WHERE ov.credential_version_id=OLD.credential_version_id AND ov.retired_at_db_ms IS NOT NULL AND ov.retire_reason='replaced'))))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active credential cutover rejects stale provider update'; END IF; END;
DROP TRIGGER IF EXISTS trg_provider_credential_bu_guard_a;
CREATE TRIGGER trg_provider_credential_bu_guard_a BEFORE UPDATE ON provider_configs FOR EACH ROW BEGIN DECLARE v_tracking BIGINT UNSIGNED DEFAULT 1; SELECT control_generation FROM tenant_credential_tracking_cutover WHERE singleton_id=1 FOR SHARE INTO v_tracking; IF v_tracking<>0 AND NOT (OLD.tenant_id<=>NEW.tenant_id AND OLD.provider_id<=>NEW.provider_id AND NEW.credential_slot_id_sha256 IS NOT NULL AND NEW.credential_write_generation IS NOT NULL AND EXISTS (SELECT 1 FROM tenant_credential_provider_slots s WHERE s.tenant_id=NEW.tenant_id AND s.slot_id_sha256=NEW.credential_slot_id_sha256 AND s.write_generation=NEW.credential_write_generation AND s.source_present=TRUE AND s.current_credential_version_id<=>NEW.credential_version_id) AND (NEW.credential_version_id IS NULL OR EXISTS (SELECT 1 FROM tenant_credential_versions v WHERE v.credential_version_id=NEW.credential_version_id AND v.tenant_id=NEW.tenant_id AND v.slot_kind='provider_binding' AND v.slot_id_sha256=NEW.credential_slot_id_sha256 AND v.retired_at_db_ms IS NULL AND (SELECT COUNT(*) FROM tenant_credential_target_dispositions d WHERE d.credential_version_id=v.credential_version_id)=2)) AND ((OLD.config<=>NEW.config AND OLD.secret_cipher<=>NEW.secret_cipher AND OLD.secret_key_id<=>NEW.secret_key_id AND OLD.credential_slot_id_sha256<=>NEW.credential_slot_id_sha256 AND OLD.credential_write_generation<=>NEW.credential_write_generation AND OLD.credential_version_id<=>NEW.credential_version_id) OR (NOT (OLD.config<=>NEW.config AND OLD.secret_cipher<=>NEW.secret_cipher AND OLD.secret_key_id<=>NEW.secret_key_id) AND NEW.credential_slot_id_sha256<=>OLD.credential_slot_id_sha256 AND NEW.credential_write_generation=OLD.credential_write_generation+1 AND NEW.updated_at_ms>OLD.updated_at_ms AND (OLD.credential_version_id IS NULL OR EXISTS (SELECT 1 FROM tenant_credential_versions ov WHERE ov.credential_version_id=OLD.credential_version_id AND ov.retired_at_db_ms IS NOT NULL AND ov.retire_reason='replaced'))))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active credential cutover rejects stale provider update'; END IF; END;
DROP TRIGGER IF EXISTS trg_provider_credential_bd_bootstrap;
CREATE TRIGGER trg_provider_credential_bd_bootstrap BEFORE DELETE ON provider_configs FOR EACH ROW BEGIN DECLARE v_tracking BIGINT UNSIGNED DEFAULT 1; SELECT control_generation FROM tenant_credential_tracking_cutover WHERE singleton_id=1 FOR SHARE INTO v_tracking; IF v_tracking<>0 AND NOT (OLD.credential_slot_id_sha256 IS NOT NULL AND OLD.credential_write_generation IS NOT NULL AND EXISTS (SELECT 1 FROM tenant_credential_provider_slots s WHERE s.tenant_id=OLD.tenant_id AND s.slot_id_sha256=OLD.credential_slot_id_sha256 AND s.write_generation=OLD.credential_write_generation+1 AND s.source_present=FALSE AND s.current_credential_version_id IS NULL) AND (OLD.credential_version_id IS NULL OR EXISTS (SELECT 1 FROM tenant_credential_versions v WHERE v.credential_version_id=OLD.credential_version_id AND v.retired_at_db_ms IS NOT NULL AND v.retire_reason IN ('deleted','tenant_erasure')))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active credential cutover rejects stale provider delete'; END IF; END;
DROP TRIGGER IF EXISTS trg_provider_credential_bd;
CREATE TRIGGER trg_provider_credential_bd BEFORE DELETE ON provider_configs FOR EACH ROW BEGIN DECLARE v_tracking BIGINT UNSIGNED DEFAULT 1; SELECT control_generation FROM tenant_credential_tracking_cutover WHERE singleton_id=1 FOR SHARE INTO v_tracking; IF v_tracking<>0 AND NOT (OLD.credential_slot_id_sha256 IS NOT NULL AND OLD.credential_write_generation IS NOT NULL AND EXISTS (SELECT 1 FROM tenant_credential_provider_slots s WHERE s.tenant_id=OLD.tenant_id AND s.slot_id_sha256=OLD.credential_slot_id_sha256 AND s.write_generation=OLD.credential_write_generation+1 AND s.source_present=FALSE AND s.current_credential_version_id IS NULL) AND (OLD.credential_version_id IS NULL OR EXISTS (SELECT 1 FROM tenant_credential_versions v WHERE v.credential_version_id=OLD.credential_version_id AND v.retired_at_db_ms IS NOT NULL AND v.retire_reason IN ('deleted','tenant_erasure')))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active credential cutover rejects stale provider delete'; END IF; END;
DROP TRIGGER IF EXISTS trg_provider_credential_bd_guard_a;
CREATE TRIGGER trg_provider_credential_bd_guard_a BEFORE DELETE ON provider_configs FOR EACH ROW BEGIN DECLARE v_tracking BIGINT UNSIGNED DEFAULT 1; SELECT control_generation FROM tenant_credential_tracking_cutover WHERE singleton_id=1 FOR SHARE INTO v_tracking; IF v_tracking<>0 AND NOT (OLD.credential_slot_id_sha256 IS NOT NULL AND OLD.credential_write_generation IS NOT NULL AND EXISTS (SELECT 1 FROM tenant_credential_provider_slots s WHERE s.tenant_id=OLD.tenant_id AND s.slot_id_sha256=OLD.credential_slot_id_sha256 AND s.write_generation=OLD.credential_write_generation+1 AND s.source_present=FALSE AND s.current_credential_version_id IS NULL) AND (OLD.credential_version_id IS NULL OR EXISTS (SELECT 1 FROM tenant_credential_versions v WHERE v.credential_version_id=OLD.credential_version_id AND v.retired_at_db_ms IS NOT NULL AND v.retire_reason IN ('deleted','tenant_erasure')))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active credential cutover rejects stale provider delete'; END IF; END;
-- Auth generation is a permanent CAS fence on the tenant row. Policy-only changes still advance
-- the generation; only an encrypted auth secret has a credential version pointer.
DROP TRIGGER IF EXISTS trg_tenant_auth_credential_bi_bootstrap;
CREATE TRIGGER trg_tenant_auth_credential_bi_bootstrap BEFORE INSERT ON tenants FOR EACH ROW BEGIN DECLARE v_tracking BIGINT UNSIGNED DEFAULT 1; SELECT control_generation FROM tenant_credential_tracking_cutover WHERE singleton_id=1 FOR SHARE INTO v_tracking; IF v_tracking<>0 AND NOT (EXISTS (SELECT 1 FROM tenant_credential_tracking_subjects s WHERE s.tenant_id=NEW.tenant_id) AND (NEW.auth_secret_cipher IS NULL)<=> (NEW.auth_secret_key_id IS NULL) AND (NEW.auth_secret_cipher IS NULL)<=> (NEW.auth_credential_version_id IS NULL) AND ((NEW.auth_policy IS NULL AND NEW.auth_secret_cipher IS NULL AND NEW.auth_write_generation=0 AND NEW.auth_credential_updated_at_db_ms=0) OR ((NEW.auth_policy IS NOT NULL OR NEW.auth_secret_cipher IS NOT NULL) AND NEW.auth_write_generation>0 AND NEW.auth_credential_updated_at_db_ms>0)) AND (NEW.auth_credential_version_id IS NULL OR EXISTS (SELECT 1 FROM tenant_credential_versions v WHERE v.credential_version_id=NEW.auth_credential_version_id AND v.tenant_id=NEW.tenant_id AND v.slot_kind='tenant_auth_secret' AND v.retired_at_db_ms IS NULL AND (SELECT COUNT(*) FROM tenant_credential_target_dispositions d WHERE d.credential_version_id=v.credential_version_id)=2))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active credential cutover rejects untracked auth insert'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_auth_credential_bi;
CREATE TRIGGER trg_tenant_auth_credential_bi BEFORE INSERT ON tenants FOR EACH ROW BEGIN DECLARE v_tracking BIGINT UNSIGNED DEFAULT 1; SELECT control_generation FROM tenant_credential_tracking_cutover WHERE singleton_id=1 FOR SHARE INTO v_tracking; IF v_tracking<>0 AND NOT (EXISTS (SELECT 1 FROM tenant_credential_tracking_subjects s WHERE s.tenant_id=NEW.tenant_id) AND (NEW.auth_secret_cipher IS NULL)<=> (NEW.auth_secret_key_id IS NULL) AND (NEW.auth_secret_cipher IS NULL)<=> (NEW.auth_credential_version_id IS NULL) AND ((NEW.auth_policy IS NULL AND NEW.auth_secret_cipher IS NULL AND NEW.auth_write_generation=0 AND NEW.auth_credential_updated_at_db_ms=0) OR ((NEW.auth_policy IS NOT NULL OR NEW.auth_secret_cipher IS NOT NULL) AND NEW.auth_write_generation>0 AND NEW.auth_credential_updated_at_db_ms>0)) AND (NEW.auth_credential_version_id IS NULL OR EXISTS (SELECT 1 FROM tenant_credential_versions v WHERE v.credential_version_id=NEW.auth_credential_version_id AND v.tenant_id=NEW.tenant_id AND v.slot_kind='tenant_auth_secret' AND v.retired_at_db_ms IS NULL AND (SELECT COUNT(*) FROM tenant_credential_target_dispositions d WHERE d.credential_version_id=v.credential_version_id)=2))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active credential cutover rejects untracked auth insert'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_auth_credential_bi_guard_a;
CREATE TRIGGER trg_tenant_auth_credential_bi_guard_a BEFORE INSERT ON tenants FOR EACH ROW BEGIN DECLARE v_tracking BIGINT UNSIGNED DEFAULT 1; SELECT control_generation FROM tenant_credential_tracking_cutover WHERE singleton_id=1 FOR SHARE INTO v_tracking; IF v_tracking<>0 AND NOT (EXISTS (SELECT 1 FROM tenant_credential_tracking_subjects s WHERE s.tenant_id=NEW.tenant_id) AND (NEW.auth_secret_cipher IS NULL)<=> (NEW.auth_secret_key_id IS NULL) AND (NEW.auth_secret_cipher IS NULL)<=> (NEW.auth_credential_version_id IS NULL) AND ((NEW.auth_policy IS NULL AND NEW.auth_secret_cipher IS NULL AND NEW.auth_write_generation=0 AND NEW.auth_credential_updated_at_db_ms=0) OR ((NEW.auth_policy IS NOT NULL OR NEW.auth_secret_cipher IS NOT NULL) AND NEW.auth_write_generation>0 AND NEW.auth_credential_updated_at_db_ms>0)) AND (NEW.auth_credential_version_id IS NULL OR EXISTS (SELECT 1 FROM tenant_credential_versions v WHERE v.credential_version_id=NEW.auth_credential_version_id AND v.tenant_id=NEW.tenant_id AND v.slot_kind='tenant_auth_secret' AND v.retired_at_db_ms IS NULL AND (SELECT COUNT(*) FROM tenant_credential_target_dispositions d WHERE d.credential_version_id=v.credential_version_id)=2))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active credential cutover rejects untracked auth insert'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_auth_credential_bu_bootstrap;
CREATE TRIGGER trg_tenant_auth_credential_bu_bootstrap BEFORE UPDATE ON tenants FOR EACH ROW BEGIN DECLARE v_tracking BIGINT UNSIGNED DEFAULT 1; SELECT control_generation FROM tenant_credential_tracking_cutover WHERE singleton_id=1 FOR SHARE INTO v_tracking; IF v_tracking<>0 AND NOT (OLD.tenant_id<=>NEW.tenant_id AND (NEW.auth_secret_cipher IS NULL)<=>(NEW.auth_secret_key_id IS NULL) AND (NEW.auth_secret_cipher IS NULL)<=>(NEW.auth_credential_version_id IS NULL) AND (NEW.auth_credential_version_id IS NULL OR EXISTS (SELECT 1 FROM tenant_credential_versions v WHERE v.credential_version_id=NEW.auth_credential_version_id AND v.tenant_id=NEW.tenant_id AND v.slot_kind='tenant_auth_secret' AND v.retired_at_db_ms IS NULL AND (SELECT COUNT(*) FROM tenant_credential_target_dispositions d WHERE d.credential_version_id=v.credential_version_id)=2)) AND ((OLD.auth_policy<=>NEW.auth_policy AND OLD.auth_secret_cipher<=>NEW.auth_secret_cipher AND OLD.auth_secret_key_id<=>NEW.auth_secret_key_id AND OLD.auth_write_generation<=>NEW.auth_write_generation AND OLD.auth_credential_version_id<=>NEW.auth_credential_version_id AND OLD.auth_credential_updated_at_db_ms<=>NEW.auth_credential_updated_at_db_ms) OR (NEW.auth_write_generation=OLD.auth_write_generation+1 AND NEW.auth_credential_updated_at_db_ms>OLD.auth_credential_updated_at_db_ms AND (OLD.auth_credential_version_id IS NULL OR EXISTS (SELECT 1 FROM tenant_credential_versions ov WHERE ov.credential_version_id=OLD.auth_credential_version_id AND ov.retired_at_db_ms IS NOT NULL AND ((NEW.auth_credential_version_id IS NULL AND ov.retire_reason IN ('cleared','tenant_erasure')) OR (NEW.auth_credential_version_id IS NOT NULL AND ov.retire_reason='replaced'))))))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active credential cutover rejects stale auth update'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_auth_credential_bu;
CREATE TRIGGER trg_tenant_auth_credential_bu BEFORE UPDATE ON tenants FOR EACH ROW BEGIN DECLARE v_tracking BIGINT UNSIGNED DEFAULT 1; SELECT control_generation FROM tenant_credential_tracking_cutover WHERE singleton_id=1 FOR SHARE INTO v_tracking; IF v_tracking<>0 AND NOT (OLD.tenant_id<=>NEW.tenant_id AND (NEW.auth_secret_cipher IS NULL)<=>(NEW.auth_secret_key_id IS NULL) AND (NEW.auth_secret_cipher IS NULL)<=>(NEW.auth_credential_version_id IS NULL) AND (NEW.auth_credential_version_id IS NULL OR EXISTS (SELECT 1 FROM tenant_credential_versions v WHERE v.credential_version_id=NEW.auth_credential_version_id AND v.tenant_id=NEW.tenant_id AND v.slot_kind='tenant_auth_secret' AND v.retired_at_db_ms IS NULL AND (SELECT COUNT(*) FROM tenant_credential_target_dispositions d WHERE d.credential_version_id=v.credential_version_id)=2)) AND ((OLD.auth_policy<=>NEW.auth_policy AND OLD.auth_secret_cipher<=>NEW.auth_secret_cipher AND OLD.auth_secret_key_id<=>NEW.auth_secret_key_id AND OLD.auth_write_generation<=>NEW.auth_write_generation AND OLD.auth_credential_version_id<=>NEW.auth_credential_version_id AND OLD.auth_credential_updated_at_db_ms<=>NEW.auth_credential_updated_at_db_ms) OR (NEW.auth_write_generation=OLD.auth_write_generation+1 AND NEW.auth_credential_updated_at_db_ms>OLD.auth_credential_updated_at_db_ms AND (OLD.auth_credential_version_id IS NULL OR EXISTS (SELECT 1 FROM tenant_credential_versions ov WHERE ov.credential_version_id=OLD.auth_credential_version_id AND ov.retired_at_db_ms IS NOT NULL AND ((NEW.auth_credential_version_id IS NULL AND ov.retire_reason IN ('cleared','tenant_erasure')) OR (NEW.auth_credential_version_id IS NOT NULL AND ov.retire_reason='replaced'))))))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active credential cutover rejects stale auth update'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_auth_credential_bu_guard_a;
CREATE TRIGGER trg_tenant_auth_credential_bu_guard_a BEFORE UPDATE ON tenants FOR EACH ROW BEGIN DECLARE v_tracking BIGINT UNSIGNED DEFAULT 1; SELECT control_generation FROM tenant_credential_tracking_cutover WHERE singleton_id=1 FOR SHARE INTO v_tracking; IF v_tracking<>0 AND NOT (OLD.tenant_id<=>NEW.tenant_id AND (NEW.auth_secret_cipher IS NULL)<=>(NEW.auth_secret_key_id IS NULL) AND (NEW.auth_secret_cipher IS NULL)<=>(NEW.auth_credential_version_id IS NULL) AND (NEW.auth_credential_version_id IS NULL OR EXISTS (SELECT 1 FROM tenant_credential_versions v WHERE v.credential_version_id=NEW.auth_credential_version_id AND v.tenant_id=NEW.tenant_id AND v.slot_kind='tenant_auth_secret' AND v.retired_at_db_ms IS NULL AND (SELECT COUNT(*) FROM tenant_credential_target_dispositions d WHERE d.credential_version_id=v.credential_version_id)=2)) AND ((OLD.auth_policy<=>NEW.auth_policy AND OLD.auth_secret_cipher<=>NEW.auth_secret_cipher AND OLD.auth_secret_key_id<=>NEW.auth_secret_key_id AND OLD.auth_write_generation<=>NEW.auth_write_generation AND OLD.auth_credential_version_id<=>NEW.auth_credential_version_id AND OLD.auth_credential_updated_at_db_ms<=>NEW.auth_credential_updated_at_db_ms) OR (NEW.auth_write_generation=OLD.auth_write_generation+1 AND NEW.auth_credential_updated_at_db_ms>OLD.auth_credential_updated_at_db_ms AND (OLD.auth_credential_version_id IS NULL OR EXISTS (SELECT 1 FROM tenant_credential_versions ov WHERE ov.credential_version_id=OLD.auth_credential_version_id AND ov.retired_at_db_ms IS NOT NULL AND ((NEW.auth_credential_version_id IS NULL AND ov.retire_reason IN ('cleared','tenant_erasure')) OR (NEW.auth_credential_version_id IS NOT NULL AND ov.retire_reason='replaced'))))))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active credential cutover rejects stale auth update'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_auth_credential_bd_bootstrap;
CREATE TRIGGER trg_tenant_auth_credential_bd_bootstrap BEFORE DELETE ON tenants FOR EACH ROW BEGIN DECLARE v_tracking BIGINT UNSIGNED DEFAULT 1; SELECT control_generation FROM tenant_credential_tracking_cutover WHERE singleton_id=1 FOR SHARE INTO v_tracking; IF v_tracking<>0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active credential cutover preserves tenant auth CAS rows'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_auth_credential_bd;
CREATE TRIGGER trg_tenant_auth_credential_bd BEFORE DELETE ON tenants FOR EACH ROW BEGIN DECLARE v_tracking BIGINT UNSIGNED DEFAULT 1; SELECT control_generation FROM tenant_credential_tracking_cutover WHERE singleton_id=1 FOR SHARE INTO v_tracking; IF v_tracking<>0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active credential cutover preserves tenant auth CAS rows'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_auth_credential_bd_guard_a;
CREATE TRIGGER trg_tenant_auth_credential_bd_guard_a BEFORE DELETE ON tenants FOR EACH ROW BEGIN DECLARE v_tracking BIGINT UNSIGNED DEFAULT 1; SELECT control_generation FROM tenant_credential_tracking_cutover WHERE singleton_id=1 FOR SHARE INTO v_tracking; IF v_tracking<>0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active credential cutover preserves tenant auth CAS rows'; END IF; END;
-- Cutover is write-once. The sole legal mutation is the complete generation 0 -> 1 transition;
-- all counts must describe the fully materialized ledger before active source guards take effect.
DROP TRIGGER IF EXISTS trg_credential_cutover_bu_bootstrap;
CREATE TRIGGER trg_credential_cutover_bu_bootstrap BEFORE UPDATE ON tenant_credential_tracking_cutover FOR EACH ROW BEGIN IF NOT (OLD.singleton_id=1 AND NEW.singleton_id=1 AND OLD.control_generation=0 AND NEW.control_generation=1 AND NEW.subject_count=(SELECT COUNT(*) FROM tenant_credential_tracking_subjects) AND NEW.provider_slot_count=(SELECT COUNT(*) FROM tenant_credential_provider_slots) AND NEW.version_count=(SELECT COUNT(*) FROM tenant_credential_versions) AND NEW.target_disposition_count=(SELECT COUNT(*) FROM tenant_credential_target_dispositions) AND NEW.auth_slot_count=NEW.subject_count AND NOT EXISTS (SELECT 1 FROM tenant_credential_versions v LEFT JOIN tenant_credential_target_dispositions d ON d.credential_version_id=v.credential_version_id GROUP BY v.credential_version_id HAVING COUNT(d.domain)<>2) AND NOT EXISTS (SELECT 1 FROM provider_configs p LEFT JOIN tenant_credential_provider_slots s ON s.tenant_id=p.tenant_id AND s.slot_id_sha256=p.credential_slot_id_sha256 WHERE p.credential_slot_id_sha256 IS NULL OR p.credential_write_generation IS NULL OR s.tenant_id IS NULL OR s.source_present=FALSE OR s.write_generation<>p.credential_write_generation OR NOT (s.current_credential_version_id<=>p.credential_version_id)) AND NOT EXISTS (SELECT 1 FROM tenants t WHERE (t.auth_secret_cipher IS NULL)<>(t.auth_credential_version_id IS NULL) OR (t.auth_secret_cipher IS NULL)<>(t.auth_secret_key_id IS NULL) OR (t.auth_secret_cipher IS NOT NULL AND (t.auth_write_generation=0 OR t.auth_credential_updated_at_db_ms=0)))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential tracking cutover is write-once or ledger is incomplete'; END IF; END;
DROP TRIGGER IF EXISTS trg_credential_cutover_bu;
CREATE TRIGGER trg_credential_cutover_bu BEFORE UPDATE ON tenant_credential_tracking_cutover FOR EACH ROW BEGIN IF NOT (OLD.singleton_id=1 AND NEW.singleton_id=1 AND OLD.control_generation=0 AND NEW.control_generation=1 AND NEW.subject_count=(SELECT COUNT(*) FROM tenant_credential_tracking_subjects) AND NEW.provider_slot_count=(SELECT COUNT(*) FROM tenant_credential_provider_slots) AND NEW.version_count=(SELECT COUNT(*) FROM tenant_credential_versions) AND NEW.target_disposition_count=(SELECT COUNT(*) FROM tenant_credential_target_dispositions) AND NEW.auth_slot_count=NEW.subject_count AND NOT EXISTS (SELECT 1 FROM tenant_credential_versions v LEFT JOIN tenant_credential_target_dispositions d ON d.credential_version_id=v.credential_version_id GROUP BY v.credential_version_id HAVING COUNT(d.domain)<>2) AND NOT EXISTS (SELECT 1 FROM provider_configs p LEFT JOIN tenant_credential_provider_slots s ON s.tenant_id=p.tenant_id AND s.slot_id_sha256=p.credential_slot_id_sha256 WHERE p.credential_slot_id_sha256 IS NULL OR p.credential_write_generation IS NULL OR s.tenant_id IS NULL OR s.source_present=FALSE OR s.write_generation<>p.credential_write_generation OR NOT (s.current_credential_version_id<=>p.credential_version_id)) AND NOT EXISTS (SELECT 1 FROM tenants t WHERE (t.auth_secret_cipher IS NULL)<>(t.auth_credential_version_id IS NULL) OR (t.auth_secret_cipher IS NULL)<>(t.auth_secret_key_id IS NULL) OR (t.auth_secret_cipher IS NOT NULL AND (t.auth_write_generation=0 OR t.auth_credential_updated_at_db_ms=0)))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential tracking cutover is write-once or ledger is incomplete'; END IF; END;
DROP TRIGGER IF EXISTS trg_credential_cutover_bu_guard_a;
CREATE TRIGGER trg_credential_cutover_bu_guard_a BEFORE UPDATE ON tenant_credential_tracking_cutover FOR EACH ROW BEGIN IF NOT (OLD.singleton_id=1 AND NEW.singleton_id=1 AND OLD.control_generation=0 AND NEW.control_generation=1 AND NEW.subject_count=(SELECT COUNT(*) FROM tenant_credential_tracking_subjects) AND NEW.provider_slot_count=(SELECT COUNT(*) FROM tenant_credential_provider_slots) AND NEW.version_count=(SELECT COUNT(*) FROM tenant_credential_versions) AND NEW.target_disposition_count=(SELECT COUNT(*) FROM tenant_credential_target_dispositions) AND NEW.auth_slot_count=NEW.subject_count AND NOT EXISTS (SELECT 1 FROM tenant_credential_versions v LEFT JOIN tenant_credential_target_dispositions d ON d.credential_version_id=v.credential_version_id GROUP BY v.credential_version_id HAVING COUNT(d.domain)<>2) AND NOT EXISTS (SELECT 1 FROM provider_configs p LEFT JOIN tenant_credential_provider_slots s ON s.tenant_id=p.tenant_id AND s.slot_id_sha256=p.credential_slot_id_sha256 WHERE p.credential_slot_id_sha256 IS NULL OR p.credential_write_generation IS NULL OR s.tenant_id IS NULL OR s.source_present=FALSE OR s.write_generation<>p.credential_write_generation OR NOT (s.current_credential_version_id<=>p.credential_version_id)) AND NOT EXISTS (SELECT 1 FROM tenants t WHERE (t.auth_secret_cipher IS NULL)<>(t.auth_credential_version_id IS NULL) OR (t.auth_secret_cipher IS NULL)<>(t.auth_secret_key_id IS NULL) OR (t.auth_secret_cipher IS NOT NULL AND (t.auth_write_generation=0 OR t.auth_credential_updated_at_db_ms=0)))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential tracking cutover is write-once or ledger is incomplete'; END IF; END;
DROP TRIGGER IF EXISTS trg_credential_cutover_bd_bootstrap;
CREATE TRIGGER trg_credential_cutover_bd_bootstrap BEFORE DELETE ON tenant_credential_tracking_cutover FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential tracking cutover cannot be deleted';
DROP TRIGGER IF EXISTS trg_credential_cutover_bd;
CREATE TRIGGER trg_credential_cutover_bd BEFORE DELETE ON tenant_credential_tracking_cutover FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential tracking cutover cannot be deleted';
DROP TRIGGER IF EXISTS trg_credential_cutover_bd_guard_a;
CREATE TRIGGER trg_credential_cutover_bd_guard_a BEFORE DELETE ON tenant_credential_tracking_cutover FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential tracking cutover cannot be deleted';
-- Coverage rows are permanent. A legacy_history_unknown gap cannot later be relabeled complete.
DROP TRIGGER IF EXISTS trg_credential_subjects_bu_bootstrap;
CREATE TRIGGER trg_credential_subjects_bu_bootstrap BEFORE UPDATE ON tenant_credential_tracking_subjects FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential tracking subjects are immutable';
DROP TRIGGER IF EXISTS trg_credential_subjects_bu;
CREATE TRIGGER trg_credential_subjects_bu BEFORE UPDATE ON tenant_credential_tracking_subjects FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential tracking subjects are immutable';
DROP TRIGGER IF EXISTS trg_credential_subjects_bu_guard_a;
CREATE TRIGGER trg_credential_subjects_bu_guard_a BEFORE UPDATE ON tenant_credential_tracking_subjects FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential tracking subjects are immutable';
DROP TRIGGER IF EXISTS trg_credential_subjects_bd_bootstrap;
CREATE TRIGGER trg_credential_subjects_bd_bootstrap BEFORE DELETE ON tenant_credential_tracking_subjects FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential tracking subjects are immutable';
DROP TRIGGER IF EXISTS trg_credential_subjects_bd;
CREATE TRIGGER trg_credential_subjects_bd BEFORE DELETE ON tenant_credential_tracking_subjects FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential tracking subjects are immutable';
DROP TRIGGER IF EXISTS trg_credential_subjects_bd_guard_a;
CREATE TRIGGER trg_credential_subjects_bd_guard_a BEFORE DELETE ON tenant_credential_tracking_subjects FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential tracking subjects are immutable';
-- Versions may perform one active -> retired transition. Identity, tenant/slot, material-presence
-- metadata, origin, and creation time are immutable; a retired version can never be reactivated.
DROP TRIGGER IF EXISTS trg_credential_versions_bu_bootstrap;
CREATE TRIGGER trg_credential_versions_bu_bootstrap BEFORE UPDATE ON tenant_credential_versions FOR EACH ROW BEGIN IF NOT (OLD.credential_version_id<=>NEW.credential_version_id AND OLD.tenant_id<=>NEW.tenant_id AND OLD.slot_kind<=>NEW.slot_kind AND OLD.slot_id_sha256<=>NEW.slot_id_sha256 AND OLD.origin<=>NEW.origin AND OLD.encrypted_secret_present<=>NEW.encrypted_secret_present AND OLD.secret_key_id_present<=>NEW.secret_key_id_present AND OLD.custom_headers_present<=>NEW.custom_headers_present AND OLD.endpoint_parameters_present<=>NEW.endpoint_parameters_present AND OLD.created_at_db_ms<=>NEW.created_at_db_ms AND OLD.retired_at_db_ms IS NULL AND OLD.retire_reason IS NULL AND NEW.retired_at_db_ms IS NOT NULL AND NEW.retire_reason IS NOT NULL AND NOT (OLD.evidence_sha256<=>NEW.evidence_sha256)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential version is immutable except one retirement'; END IF; END;
DROP TRIGGER IF EXISTS trg_credential_versions_bu;
CREATE TRIGGER trg_credential_versions_bu BEFORE UPDATE ON tenant_credential_versions FOR EACH ROW BEGIN IF NOT (OLD.credential_version_id<=>NEW.credential_version_id AND OLD.tenant_id<=>NEW.tenant_id AND OLD.slot_kind<=>NEW.slot_kind AND OLD.slot_id_sha256<=>NEW.slot_id_sha256 AND OLD.origin<=>NEW.origin AND OLD.encrypted_secret_present<=>NEW.encrypted_secret_present AND OLD.secret_key_id_present<=>NEW.secret_key_id_present AND OLD.custom_headers_present<=>NEW.custom_headers_present AND OLD.endpoint_parameters_present<=>NEW.endpoint_parameters_present AND OLD.created_at_db_ms<=>NEW.created_at_db_ms AND OLD.retired_at_db_ms IS NULL AND OLD.retire_reason IS NULL AND NEW.retired_at_db_ms IS NOT NULL AND NEW.retire_reason IS NOT NULL AND NOT (OLD.evidence_sha256<=>NEW.evidence_sha256)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential version is immutable except one retirement'; END IF; END;
DROP TRIGGER IF EXISTS trg_credential_versions_bu_guard_a;
CREATE TRIGGER trg_credential_versions_bu_guard_a BEFORE UPDATE ON tenant_credential_versions FOR EACH ROW BEGIN IF NOT (OLD.credential_version_id<=>NEW.credential_version_id AND OLD.tenant_id<=>NEW.tenant_id AND OLD.slot_kind<=>NEW.slot_kind AND OLD.slot_id_sha256<=>NEW.slot_id_sha256 AND OLD.origin<=>NEW.origin AND OLD.encrypted_secret_present<=>NEW.encrypted_secret_present AND OLD.secret_key_id_present<=>NEW.secret_key_id_present AND OLD.custom_headers_present<=>NEW.custom_headers_present AND OLD.endpoint_parameters_present<=>NEW.endpoint_parameters_present AND OLD.created_at_db_ms<=>NEW.created_at_db_ms AND OLD.retired_at_db_ms IS NULL AND OLD.retire_reason IS NULL AND NEW.retired_at_db_ms IS NOT NULL AND NEW.retire_reason IS NOT NULL AND NOT (OLD.evidence_sha256<=>NEW.evidence_sha256)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential version is immutable except one retirement'; END IF; END;
DROP TRIGGER IF EXISTS trg_credential_versions_bd_bootstrap;
CREATE TRIGGER trg_credential_versions_bd_bootstrap BEFORE DELETE ON tenant_credential_versions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential versions cannot be deleted';
DROP TRIGGER IF EXISTS trg_credential_versions_bd;
CREATE TRIGGER trg_credential_versions_bd BEFORE DELETE ON tenant_credential_versions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential versions cannot be deleted';
DROP TRIGGER IF EXISTS trg_credential_versions_bd_guard_a;
CREATE TRIGGER trg_credential_versions_bd_guard_a BEFORE DELETE ON tenant_credential_versions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential versions cannot be deleted';
DROP TRIGGER IF EXISTS trg_credential_targets_bu_bootstrap;
CREATE TRIGGER trg_credential_targets_bu_bootstrap BEFORE UPDATE ON tenant_credential_target_dispositions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential target dispositions are immutable';
DROP TRIGGER IF EXISTS trg_credential_targets_bu;
CREATE TRIGGER trg_credential_targets_bu BEFORE UPDATE ON tenant_credential_target_dispositions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential target dispositions are immutable';
DROP TRIGGER IF EXISTS trg_credential_targets_bu_guard_a;
CREATE TRIGGER trg_credential_targets_bu_guard_a BEFORE UPDATE ON tenant_credential_target_dispositions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential target dispositions are immutable';
DROP TRIGGER IF EXISTS trg_credential_targets_bd_bootstrap;
CREATE TRIGGER trg_credential_targets_bd_bootstrap BEFORE DELETE ON tenant_credential_target_dispositions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential target dispositions are immutable';
DROP TRIGGER IF EXISTS trg_credential_targets_bd;
CREATE TRIGGER trg_credential_targets_bd BEFORE DELETE ON tenant_credential_target_dispositions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential target dispositions are immutable';
DROP TRIGGER IF EXISTS trg_credential_targets_bd_guard_a;
CREATE TRIGGER trg_credential_targets_bd_guard_a BEFORE DELETE ON tenant_credential_target_dispositions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential target dispositions are immutable';
-- Permanent provider slots advance exactly one generation per source mutation and never delete.
DROP TRIGGER IF EXISTS trg_credential_provider_slots_bu_bootstrap;
CREATE TRIGGER trg_credential_provider_slots_bu_bootstrap BEFORE UPDATE ON tenant_credential_provider_slots FOR EACH ROW BEGIN IF NOT (OLD.tenant_id<=>NEW.tenant_id AND OLD.slot_id_sha256<=>NEW.slot_id_sha256 AND NEW.write_generation=OLD.write_generation+1 AND NEW.updated_at_db_ms>=OLD.updated_at_db_ms AND NOT (OLD.evidence_sha256<=>NEW.evidence_sha256) AND (NEW.current_credential_version_id IS NULL OR EXISTS (SELECT 1 FROM tenant_credential_versions v WHERE v.credential_version_id=NEW.current_credential_version_id AND v.tenant_id=NEW.tenant_id AND v.slot_kind='provider_binding' AND v.slot_id_sha256=NEW.slot_id_sha256 AND v.retired_at_db_ms IS NULL AND (SELECT COUNT(*) FROM tenant_credential_target_dispositions d WHERE d.credential_version_id=v.credential_version_id)=2))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential provider slot must advance exactly once'; END IF; END;
DROP TRIGGER IF EXISTS trg_credential_provider_slots_bu;
CREATE TRIGGER trg_credential_provider_slots_bu BEFORE UPDATE ON tenant_credential_provider_slots FOR EACH ROW BEGIN IF NOT (OLD.tenant_id<=>NEW.tenant_id AND OLD.slot_id_sha256<=>NEW.slot_id_sha256 AND NEW.write_generation=OLD.write_generation+1 AND NEW.updated_at_db_ms>=OLD.updated_at_db_ms AND NOT (OLD.evidence_sha256<=>NEW.evidence_sha256) AND (NEW.current_credential_version_id IS NULL OR EXISTS (SELECT 1 FROM tenant_credential_versions v WHERE v.credential_version_id=NEW.current_credential_version_id AND v.tenant_id=NEW.tenant_id AND v.slot_kind='provider_binding' AND v.slot_id_sha256=NEW.slot_id_sha256 AND v.retired_at_db_ms IS NULL AND (SELECT COUNT(*) FROM tenant_credential_target_dispositions d WHERE d.credential_version_id=v.credential_version_id)=2))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential provider slot must advance exactly once'; END IF; END;
DROP TRIGGER IF EXISTS trg_credential_provider_slots_bu_guard_a;
CREATE TRIGGER trg_credential_provider_slots_bu_guard_a BEFORE UPDATE ON tenant_credential_provider_slots FOR EACH ROW BEGIN IF NOT (OLD.tenant_id<=>NEW.tenant_id AND OLD.slot_id_sha256<=>NEW.slot_id_sha256 AND NEW.write_generation=OLD.write_generation+1 AND NEW.updated_at_db_ms>=OLD.updated_at_db_ms AND NOT (OLD.evidence_sha256<=>NEW.evidence_sha256) AND (NEW.current_credential_version_id IS NULL OR EXISTS (SELECT 1 FROM tenant_credential_versions v WHERE v.credential_version_id=NEW.current_credential_version_id AND v.tenant_id=NEW.tenant_id AND v.slot_kind='provider_binding' AND v.slot_id_sha256=NEW.slot_id_sha256 AND v.retired_at_db_ms IS NULL AND (SELECT COUNT(*) FROM tenant_credential_target_dispositions d WHERE d.credential_version_id=v.credential_version_id)=2))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential provider slot must advance exactly once'; END IF; END;
DROP TRIGGER IF EXISTS trg_credential_provider_slots_bd_bootstrap;
CREATE TRIGGER trg_credential_provider_slots_bd_bootstrap BEFORE DELETE ON tenant_credential_provider_slots FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential provider slots are permanent';
DROP TRIGGER IF EXISTS trg_credential_provider_slots_bd;
CREATE TRIGGER trg_credential_provider_slots_bd BEFORE DELETE ON tenant_credential_provider_slots FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential provider slots are permanent';
DROP TRIGGER IF EXISTS trg_credential_provider_slots_bd_guard_a;
CREATE TRIGGER trg_credential_provider_slots_bd_guard_a BEFORE DELETE ON tenant_credential_provider_slots FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential provider slots are permanent';
SET @credential_provider_generation_column_shape = (
  SELECT CONCAT(column_type,':',is_nullable) FROM information_schema.columns
   WHERE table_schema=DATABASE() AND table_name='provider_configs'
     AND column_name='credential_write_generation'
);
SET @migration_sql = IF(
  @credential_provider_generation_column_shape IS NULL,
  'ALTER TABLE provider_configs ADD COLUMN credential_write_generation BIGINT UNSIGNED NULL AFTER credential_slot_id_sha256',
  IF(@credential_provider_generation_column_shape='bigint unsigned:YES','SELECT 1',
    'ALTER TABLE provider_configs ADD COLUMN credential_write_generation BIGINT UNSIGNED NULL AFTER credential_slot_id_sha256')
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @credential_provider_version_column_shape = (
  SELECT CONCAT(column_type,':',is_nullable,':',COALESCE(collation_name,''))
    FROM information_schema.columns WHERE table_schema=DATABASE()
     AND table_name='provider_configs' AND column_name='credential_version_id'
);
SET @migration_sql = IF(
  @credential_provider_version_column_shape IS NULL,
  'ALTER TABLE provider_configs ADD COLUMN credential_version_id CHAR(64) COLLATE utf8mb4_0900_as_cs NULL AFTER credential_write_generation',
  IF(@credential_provider_version_column_shape='char(64):YES:utf8mb4_0900_as_cs','SELECT 1',
    'ALTER TABLE provider_configs ADD COLUMN credential_version_id CHAR(64) COLLATE utf8mb4_0900_as_cs NULL AFTER credential_write_generation')
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @credential_auth_generation_column_shape = (
  SELECT CONCAT(column_type,':',is_nullable,':',column_default) FROM information_schema.columns
   WHERE table_schema=DATABASE() AND table_name='tenants'
     AND column_name='auth_write_generation'
);
SET @migration_sql = IF(
  @credential_auth_generation_column_shape IS NULL,
  'ALTER TABLE tenants ADD COLUMN auth_write_generation BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER auth_secret_key_id',
  IF(@credential_auth_generation_column_shape='bigint unsigned:NO:0','SELECT 1',
    'ALTER TABLE tenants ADD COLUMN auth_write_generation BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER auth_secret_key_id')
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @credential_auth_version_column_shape = (
  SELECT CONCAT(column_type,':',is_nullable,':',COALESCE(collation_name,''))
    FROM information_schema.columns WHERE table_schema=DATABASE()
     AND table_name='tenants' AND column_name='auth_credential_version_id'
);
SET @migration_sql = IF(
  @credential_auth_version_column_shape IS NULL,
  'ALTER TABLE tenants ADD COLUMN auth_credential_version_id CHAR(64) COLLATE utf8mb4_0900_as_cs NULL AFTER auth_write_generation',
  IF(@credential_auth_version_column_shape='char(64):YES:utf8mb4_0900_as_cs','SELECT 1',
    'ALTER TABLE tenants ADD COLUMN auth_credential_version_id CHAR(64) COLLATE utf8mb4_0900_as_cs NULL AFTER auth_write_generation')
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @credential_auth_updated_column_shape = (
  SELECT CONCAT(column_type,':',is_nullable,':',column_default) FROM information_schema.columns
   WHERE table_schema=DATABASE() AND table_name='tenants'
     AND column_name='auth_credential_updated_at_db_ms'
);
SET @migration_sql = IF(
  @credential_auth_updated_column_shape IS NULL,
  'ALTER TABLE tenants ADD COLUMN auth_credential_updated_at_db_ms BIGINT NOT NULL DEFAULT 0 AFTER auth_credential_version_id',
  IF(@credential_auth_updated_column_shape='bigint:NO:0','SELECT 1',
    'ALTER TABLE tenants ADD COLUMN auth_credential_updated_at_db_ms BIGINT NOT NULL DEFAULT 0 AFTER auth_credential_version_id')
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @credential_provider_projection_index = (
  SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',')
    FROM information_schema.statistics WHERE table_schema=DATABASE()
     AND table_name='provider_configs' AND index_name='idx_provider_credential_projection'
);
SET @migration_sql = IF(
  @credential_provider_projection_index IS NULL,
  'ALTER TABLE provider_configs ADD KEY idx_provider_credential_projection (tenant_id, credential_slot_id_sha256, credential_write_generation, credential_version_id)',
  IF(@credential_provider_projection_index='tenant_id,credential_slot_id_sha256,credential_write_generation,credential_version_id',
    'SELECT 1',
    'ALTER TABLE provider_configs ADD KEY idx_provider_credential_projection (tenant_id, credential_slot_id_sha256, credential_write_generation, credential_version_id)')
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @credential_auth_projection_index = (
  SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',')
    FROM information_schema.statistics WHERE table_schema=DATABASE()
     AND table_name='tenants' AND index_name='idx_tenants_auth_credential_projection'
);
SET @migration_sql = IF(
  @credential_auth_projection_index IS NULL,
  'ALTER TABLE tenants ADD KEY idx_tenants_auth_credential_projection (tenant_id, auth_write_generation, auth_credential_version_id)',
  IF(@credential_auth_projection_index='tenant_id,auth_write_generation,auth_credential_version_id',
    'SELECT 1',
    'ALTER TABLE tenants ADD KEY idx_tenants_auth_credential_projection (tenant_id, auth_write_generation, auth_credential_version_id)')
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @credential_t3a_source_index = (
  SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',')
    FROM information_schema.statistics WHERE table_schema=DATABASE()
     AND table_name='tenant_credential_revocation_receipts'
     AND index_name='uk_tenant_credential_receipts_inventory_source'
);
SET @credential_t3a_source_non_unique = (
  SELECT MAX(non_unique) FROM information_schema.statistics WHERE table_schema=DATABASE()
   AND table_name='tenant_credential_revocation_receipts'
   AND index_name='uk_tenant_credential_receipts_inventory_source'
);
SET @migration_sql = IF(
  @credential_t3a_source_index IS NULL,
  'ALTER TABLE tenant_credential_revocation_receipts ADD UNIQUE KEY uk_tenant_credential_receipts_inventory_source (request_id, tenant_id, subject_generation, receipt_sha256)',
  IF(@credential_t3a_source_index='request_id,tenant_id,subject_generation,receipt_sha256'
      AND @credential_t3a_source_non_unique=0,
    'SELECT 1',
    'ALTER TABLE tenant_credential_revocation_receipts ADD UNIQUE KEY uk_tenant_credential_receipts_inventory_source (request_id, tenant_id, subject_generation, receipt_sha256)')
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

CREATE TABLE IF NOT EXISTS tenant_credential_inventory_receipts (
  request_id                            VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                             VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation                    BIGINT UNSIGNED NOT NULL,
  scope                                 VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  t3a_receipt_sha256                    CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tracking_cutover_evidence_sha256      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_count                         BIGINT UNSIGNED NOT NULL,
  subject_root_sha256                   CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  provider_slot_count                   BIGINT UNSIGNED NOT NULL,
  provider_slot_root_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  auth_slot_count                       BIGINT UNSIGNED NOT NULL,
  auth_slot_root_sha256                 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  version_count                         BIGINT UNSIGNED NOT NULL,
  version_root_sha256                   CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_disposition_count              BIGINT UNSIGNED NOT NULL,
  target_disposition_root_sha256        CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  external_credential_blocker_count     BIGINT UNSIGNED NOT NULL,
  kms_key_blocker_count                 BIGINT UNSIGNED NOT NULL,
  legacy_history_unknown_subject_count  BIGINT UNSIGNED NOT NULL,
  provider_source_count_before          BIGINT UNSIGNED NOT NULL,
  provider_source_pointer_count_before  BIGINT UNSIGNED NOT NULL,
  auth_secret_present_before            BOOLEAN NOT NULL,
  auth_source_pointer_present_before    BOOLEAN NOT NULL,
  store_db_timestamp_ms                 BIGINT NOT NULL,
  receipt_sha256                        CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (request_id),
  UNIQUE KEY uk_credential_inventory_receipt_tenant (tenant_id),
  UNIQUE KEY uk_credential_inventory_receipt_generation (tenant_id, subject_generation),
  UNIQUE KEY uk_credential_inventory_receipt_hash (receipt_sha256),
  KEY idx_credential_inventory_receipt_source
    (request_id, tenant_id, subject_generation, t3a_receipt_sha256),
  CONSTRAINT fk_credential_inventory_receipt_source
    FOREIGN KEY (request_id, tenant_id, subject_generation, t3a_receipt_sha256)
    REFERENCES tenant_credential_revocation_receipts
      (request_id, tenant_id, subject_generation, receipt_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_credential_inventory_receipt_scope CHECK (
    scope = 'tenant-credential-inventory-v1'
  ),
  CONSTRAINT chk_credential_inventory_receipt_shape CHECK (
    subject_generation > 0 AND subject_count = 1 AND auth_slot_count = 1
    AND legacy_history_unknown_subject_count <= 1
    AND target_disposition_count = version_count * 2
    AND external_credential_blocker_count <= version_count
    AND kms_key_blocker_count <= version_count
    AND provider_source_pointer_count_before = provider_source_count_before
    AND provider_source_count_before <= provider_slot_count
    AND auth_secret_present_before = auth_source_pointer_present_before
    AND store_db_timestamp_ms >= 0
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT request_id, tenant_id, subject_generation, scope, t3a_receipt_sha256,
       tracking_cutover_evidence_sha256, subject_count, subject_root_sha256,
       provider_slot_count, provider_slot_root_sha256, auth_slot_count,
       auth_slot_root_sha256, version_count, version_root_sha256,
       target_disposition_count, target_disposition_root_sha256,
       external_credential_blocker_count, kms_key_blocker_count,
       legacy_history_unknown_subject_count, provider_source_count_before,
       provider_source_pointer_count_before, auth_secret_present_before,
       auth_source_pointer_present_before, store_db_timestamp_ms, receipt_sha256
  FROM tenant_credential_inventory_receipts FORCE INDEX (
    PRIMARY, uk_credential_inventory_receipt_tenant,
    uk_credential_inventory_receipt_generation, uk_credential_inventory_receipt_hash,
    idx_credential_inventory_receipt_source
  ) WHERE 1=0;

SELECT tenant_id, provider_id, credential_slot_id_sha256, credential_write_generation,
       credential_version_id, config, secret_cipher, secret_key_id, created_at_ms, updated_at_ms
  FROM provider_configs WHERE 1=0;
SELECT tenant_id, auth_policy, auth_secret_cipher, auth_secret_key_id,
       auth_write_generation, auth_credential_version_id,
       auth_credential_updated_at_db_ms, created_at_ms
  FROM tenants WHERE 1=0;

SET @credential_provider_slot_fk = (
  SELECT COUNT(*) FROM information_schema.referential_constraints
   WHERE constraint_schema=DATABASE() AND table_name='provider_configs'
     AND constraint_name='fk_provider_config_credential_slot'
);
SET @migration_sql = IF(
  @credential_provider_slot_fk=0,
  'ALTER TABLE provider_configs ADD CONSTRAINT fk_provider_config_credential_slot FOREIGN KEY (tenant_id, credential_slot_id_sha256) REFERENCES tenant_credential_provider_slots (tenant_id, slot_id_sha256) ON UPDATE RESTRICT ON DELETE RESTRICT',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @credential_provider_version_fk = (
  SELECT COUNT(*) FROM information_schema.referential_constraints
   WHERE constraint_schema=DATABASE() AND table_name='provider_configs'
     AND constraint_name='fk_provider_config_credential_version'
);
SET @migration_sql = IF(
  @credential_provider_version_fk=0,
  'ALTER TABLE provider_configs ADD CONSTRAINT fk_provider_config_credential_version FOREIGN KEY (credential_version_id, tenant_id) REFERENCES tenant_credential_versions (credential_version_id, tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @credential_auth_version_fk = (
  SELECT COUNT(*) FROM information_schema.referential_constraints
   WHERE constraint_schema=DATABASE() AND table_name='tenants'
     AND constraint_name='fk_tenant_auth_credential_version'
);
SET @migration_sql = IF(
  @credential_auth_version_fk=0,
  'ALTER TABLE tenants ADD CONSTRAINT fk_tenant_auth_credential_version FOREIGN KEY (auth_credential_version_id, tenant_id) REFERENCES tenant_credential_versions (credential_version_id, tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- Bind the complete shape of every migration-owned table, plus every projection column, index and
-- foreign key added to historical source tables. CREATE TABLE IF NOT EXISTS and a same-name FK are
-- not proof of compatibility: without this fingerprint a partial/weak install could still receive
-- the migration marker and later make the active-cutover locking guards unsound.
SET @credential_lifecycle_previous_group_concat_max_len = @@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len = 1048576;
SET @credential_lifecycle_schema_ok = (
  (SELECT COUNT(*) = 6
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,table_type,
             IFNULL(engine,'-'),IFNULL(table_collation,'-'))
           ORDER BY table_name SEPARATOR '|'),256)
         = '5bde763690eb32e19af28ec9a46cf7213f809229a03246ad0e973e08dfb22cc4'
     FROM information_schema.tables
    WHERE table_schema=DATABASE() AND table_name IN (
      'tenant_credential_tracking_cutover','tenant_credential_tracking_subjects',
      'tenant_credential_versions','tenant_credential_target_dispositions',
      'tenant_credential_provider_slots','tenant_credential_inventory_receipts'))
  AND
  (SELECT COUNT(*) = 75
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,LPAD(ordinal_position,3,'0'),
             column_name,LOWER(column_type),is_nullable,
             IF(column_default IS NULL,'<NULL>',CONCAT('<',column_default,'>')),
             IFNULL(character_set_name,'-'),IFNULL(collation_name,'-'),
             IFNULL(NULLIF(LOWER(extra),''),'-'),
             IFNULL(NULLIF(LOWER(generation_expression),''),'-'))
           ORDER BY table_name,ordinal_position SEPARATOR '|'),256)
         = '3b56c39659280b8feae9cc8592abad84c89eb16f4a9fd916dcdef2acf50b63ec'
     FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name IN (
      'tenant_credential_tracking_cutover','tenant_credential_tracking_subjects',
      'tenant_credential_versions','tenant_credential_target_dispositions',
      'tenant_credential_provider_slots','tenant_credential_inventory_receipts'))
  AND
  (SELECT COUNT(DISTINCT CONCAT(table_name,'~',index_name)) = 19 AND COUNT(*) = 34
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,index_name,non_unique,
             seq_in_index,LOWER(index_type),LOWER(is_visible),
             IFNULL(column_name,'<expression>'),IFNULL(CAST(sub_part AS CHAR),'-'),
             LOWER(IFNULL(collation,'-')),IFNULL(expression,'-'))
           ORDER BY table_name,index_name,seq_in_index SEPARATOR '|'),256)
         = 'ade503df2bd188e51173e676df2e3c5df5c6970fca0356b6c06e81d44402bb01'
     FROM information_schema.statistics
    WHERE table_schema=DATABASE() AND table_name IN (
      'tenant_credential_tracking_cutover','tenant_credential_tracking_subjects',
      'tenant_credential_versions','tenant_credential_target_dispositions',
      'tenant_credential_provider_slots','tenant_credential_inventory_receipts'))
  AND
  (SELECT COUNT(*) = 17
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',tc.table_name,tc.constraint_name,tc.enforced,
             LOWER(REPLACE(REPLACE(REGEXP_REPLACE(cc.check_clause,'[[:space:]]',''),
               CHAR(96),''),'_utf8mb4','')))
           ORDER BY tc.table_name,tc.constraint_name SEPARATOR '|'),256)
         = 'bd697ef11b9f2cc46f80a775866cec7a09fe95d86a2004f5ad3ab55909c55ea4'
     FROM information_schema.table_constraints tc
     JOIN information_schema.check_constraints cc
       ON cc.constraint_schema=tc.constraint_schema
      AND cc.constraint_name=tc.constraint_name
    WHERE tc.table_schema=DATABASE() AND tc.constraint_type='CHECK'
      AND tc.table_name IN (
        'tenant_credential_tracking_cutover','tenant_credential_tracking_subjects',
        'tenant_credential_versions','tenant_credential_target_dispositions',
        'tenant_credential_provider_slots','tenant_credential_inventory_receipts'))
  AND
  (SELECT COUNT(*) = 36
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,
             constraint_type,enforced)
           ORDER BY table_name,constraint_name SEPARATOR '|'),256)
         = '6bcb27ae6aedbe88909b8e163a881ce4b6819e13a5e95ebe6573910f81c00a61'
     FROM information_schema.table_constraints
    WHERE table_schema=DATABASE() AND table_name IN (
      'tenant_credential_tracking_cutover','tenant_credential_tracking_subjects',
      'tenant_credential_versions','tenant_credential_target_dispositions',
      'tenant_credential_provider_slots','tenant_credential_inventory_receipts'))
  AND
  (SELECT COUNT(DISTINCT CONCAT(k.table_name,'~',k.constraint_name)) = 5
       AND COUNT(*) = 10
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',k.table_name,k.constraint_name,
             k.ordinal_position,k.column_name,k.referenced_table_name,
             k.referenced_column_name,r.update_rule,r.delete_rule)
           ORDER BY k.table_name,k.constraint_name,k.ordinal_position SEPARATOR '|'),256)
         = '56e9561356c87058fe6323e35a7e2c5006721664a22730e0ca376d8c1bea0e3a'
     FROM information_schema.key_column_usage k
     JOIN information_schema.referential_constraints r
       ON r.constraint_schema=k.constraint_schema
      AND r.constraint_name=k.constraint_name
    WHERE k.table_schema=DATABASE() AND k.referenced_table_name IS NOT NULL
      AND k.table_name IN (
        'tenant_credential_tracking_cutover','tenant_credential_tracking_subjects',
        'tenant_credential_versions','tenant_credential_target_dispositions',
        'tenant_credential_provider_slots','tenant_credential_inventory_receipts'))
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.partitions
     WHERE table_schema=DATABASE() AND partition_name IS NOT NULL
       AND table_name IN (
         'tenant_credential_tracking_cutover','tenant_credential_tracking_subjects',
         'tenant_credential_versions','tenant_credential_target_dispositions',
         'tenant_credential_provider_slots','tenant_credential_inventory_receipts'))
  AND
  (SELECT COUNT(*) = 6
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,ordinal_position,column_name,
             LOWER(column_type),is_nullable,
             IF(column_default IS NULL,'<NULL>',CONCAT('<',column_default,'>')),
             IFNULL(character_set_name,'-'),IFNULL(collation_name,'-'),
             IFNULL(NULLIF(LOWER(extra),''),'-'),
             IFNULL(NULLIF(LOWER(generation_expression),''),'-'))
           ORDER BY table_name,column_name SEPARATOR '|'),256)
         = '81f6a70e3bed20861cfc1bf4f0d8a4c2356998e1c175944a683b2286bc980bca'
     FROM information_schema.columns
    WHERE table_schema=DATABASE() AND (
      (table_name='provider_configs' AND column_name IN (
        'credential_slot_id_sha256','credential_write_generation','credential_version_id'))
      OR (table_name='tenants' AND column_name IN (
        'auth_write_generation','auth_credential_version_id',
        'auth_credential_updated_at_db_ms'))))
  AND
  (SELECT COUNT(DISTINCT CONCAT(table_name,'~',index_name)) = 5 AND COUNT(*) = 15
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,index_name,non_unique,
             seq_in_index,LOWER(index_type),LOWER(is_visible),
             IFNULL(column_name,'<expression>'),IFNULL(CAST(sub_part AS CHAR),'-'),
             LOWER(IFNULL(collation,'-')),IFNULL(expression,'-'))
           ORDER BY table_name,index_name,seq_in_index SEPARATOR '|'),256)
         = 'd85e35abe0535089aab8e9629f2a775a9f22b933b8a7c289d956d2e04c7b5086'
     FROM information_schema.statistics
    WHERE table_schema=DATABASE() AND (
      (table_name='provider_configs' AND index_name IN (
        'idx_provider_credential_projection','fk_provider_config_credential_version'))
      OR (table_name='tenants' AND index_name IN (
        'idx_tenants_auth_credential_projection','fk_tenant_auth_credential_version'))
      OR (table_name='tenant_credential_revocation_receipts'
        AND index_name='uk_tenant_credential_receipts_inventory_source')))
  AND
  (SELECT COUNT(DISTINCT CONCAT(k.table_name,'~',k.constraint_name)) = 3
       AND COUNT(*) = 6
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',k.table_name,k.constraint_name,
             k.ordinal_position,k.column_name,k.referenced_table_name,
             k.referenced_column_name,r.update_rule,r.delete_rule)
           ORDER BY k.table_name,k.constraint_name,k.ordinal_position SEPARATOR '|'),256)
         = '8571717b0df43e27ae358af9114a2e1dce42bb5445d1ac7e26a6e037a2eadde8'
     FROM information_schema.key_column_usage k
     JOIN information_schema.referential_constraints r
       ON r.constraint_schema=k.constraint_schema
      AND r.constraint_name=k.constraint_name
    WHERE k.table_schema=DATABASE() AND k.referenced_table_name IS NOT NULL
      AND k.constraint_name IN (
        'fk_provider_config_credential_slot','fk_provider_config_credential_version',
        'fk_tenant_auth_credential_version'))
);
SET @migration_sql = IF(@credential_lifecycle_schema_ok=1, 'SELECT 1',
  'SELECT 1 FROM __invalid_credential_lifecycle_schema__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

DROP TRIGGER IF EXISTS trg_credential_inventory_receipts_bu_bootstrap;
CREATE TRIGGER trg_credential_inventory_receipts_bu_bootstrap BEFORE UPDATE ON tenant_credential_inventory_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential inventory receipts are immutable';
DROP TRIGGER IF EXISTS trg_credential_inventory_receipts_bu;
CREATE TRIGGER trg_credential_inventory_receipts_bu BEFORE UPDATE ON tenant_credential_inventory_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential inventory receipts are immutable';
DROP TRIGGER IF EXISTS trg_credential_inventory_receipts_bu_guard_a;
CREATE TRIGGER trg_credential_inventory_receipts_bu_guard_a BEFORE UPDATE ON tenant_credential_inventory_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential inventory receipts are immutable';
DROP TRIGGER IF EXISTS trg_credential_inventory_receipts_bd_bootstrap;
CREATE TRIGGER trg_credential_inventory_receipts_bd_bootstrap BEFORE DELETE ON tenant_credential_inventory_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential inventory receipts are immutable';
DROP TRIGGER IF EXISTS trg_credential_inventory_receipts_bd;
CREATE TRIGGER trg_credential_inventory_receipts_bd BEFORE DELETE ON tenant_credential_inventory_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential inventory receipts are immutable';
DROP TRIGGER IF EXISTS trg_credential_inventory_receipts_bd_guard_a;
CREATE TRIGGER trg_credential_inventory_receipts_bd_guard_a BEFORE DELETE ON tenant_credential_inventory_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential inventory receipts are immutable';
-- Once tracking is active, a T3a job cannot become terminal unless the old revocation receipt and
-- the new inventory sidecar have already been published in the same transaction. The locking read
-- is essential for rolling upgrades: an old REPEATABLE READ transaction that began before
-- activation must wait and observe the current generation instead of its stale snapshot.
DROP TRIGGER IF EXISTS trg_credential_tracking_t3a_bu_bootstrap;
CREATE TRIGGER trg_credential_tracking_t3a_bu_bootstrap BEFORE UPDATE ON tenant_credential_revocation_jobs FOR EACH ROW BEGIN DECLARE v_tracking BIGINT UNSIGNED DEFAULT 1; DECLARE v_cutover_evidence CHAR(64) DEFAULT NULL; SELECT control_generation, evidence_sha256 FROM tenant_credential_tracking_cutover WHERE singleton_id=1 FOR SHARE INTO v_tracking, v_cutover_evidence; IF v_tracking<>0 AND OLD.phase='queued' AND NEW.phase='credential_store_revoked' THEN IF NOT EXISTS (SELECT 1 FROM tenant_credential_inventory_receipts i JOIN tenant_credential_revocation_receipts r ON BINARY r.request_id=BINARY i.request_id AND BINARY r.tenant_id=BINARY i.tenant_id AND r.subject_generation=i.subject_generation AND BINARY r.receipt_sha256=BINARY i.t3a_receipt_sha256 WHERE BINARY i.request_id=BINARY NEW.request_id AND BINARY i.tenant_id=BINARY NEW.tenant_id AND i.subject_generation=NEW.subject_generation AND BINARY i.tracking_cutover_evidence_sha256=BINARY v_cutover_evidence AND i.store_db_timestamp_ms=NEW.credential_store_revoked_at_ms AND r.store_db_timestamp_ms=NEW.credential_store_revoked_at_ms AND r.completed_claim_attempt=NEW.completed_claim_attempt AND BINARY r.completed_claim_token_sha256=BINARY NEW.completed_claim_token_sha256) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active credential tracking requires atomic T3a inventory receipt'; END IF; END IF; END;
DROP TRIGGER IF EXISTS trg_credential_tracking_t3a_bu;
CREATE TRIGGER trg_credential_tracking_t3a_bu BEFORE UPDATE ON tenant_credential_revocation_jobs FOR EACH ROW BEGIN DECLARE v_tracking BIGINT UNSIGNED DEFAULT 1; DECLARE v_cutover_evidence CHAR(64) DEFAULT NULL; SELECT control_generation, evidence_sha256 FROM tenant_credential_tracking_cutover WHERE singleton_id=1 FOR SHARE INTO v_tracking, v_cutover_evidence; IF v_tracking<>0 AND OLD.phase='queued' AND NEW.phase='credential_store_revoked' THEN IF NOT EXISTS (SELECT 1 FROM tenant_credential_inventory_receipts i JOIN tenant_credential_revocation_receipts r ON BINARY r.request_id=BINARY i.request_id AND BINARY r.tenant_id=BINARY i.tenant_id AND r.subject_generation=i.subject_generation AND BINARY r.receipt_sha256=BINARY i.t3a_receipt_sha256 WHERE BINARY i.request_id=BINARY NEW.request_id AND BINARY i.tenant_id=BINARY NEW.tenant_id AND i.subject_generation=NEW.subject_generation AND BINARY i.tracking_cutover_evidence_sha256=BINARY v_cutover_evidence AND i.store_db_timestamp_ms=NEW.credential_store_revoked_at_ms AND r.store_db_timestamp_ms=NEW.credential_store_revoked_at_ms AND r.completed_claim_attempt=NEW.completed_claim_attempt AND BINARY r.completed_claim_token_sha256=BINARY NEW.completed_claim_token_sha256) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active credential tracking requires atomic T3a inventory receipt'; END IF; END IF; END;
DROP TRIGGER IF EXISTS trg_credential_tracking_t3a_bu_guard_a;
CREATE TRIGGER trg_credential_tracking_t3a_bu_guard_a BEFORE UPDATE ON tenant_credential_revocation_jobs FOR EACH ROW BEGIN DECLARE v_tracking BIGINT UNSIGNED DEFAULT 1; DECLARE v_cutover_evidence CHAR(64) DEFAULT NULL; SELECT control_generation, evidence_sha256 FROM tenant_credential_tracking_cutover WHERE singleton_id=1 FOR SHARE INTO v_tracking, v_cutover_evidence; IF v_tracking<>0 AND OLD.phase='queued' AND NEW.phase='credential_store_revoked' THEN IF NOT EXISTS (SELECT 1 FROM tenant_credential_inventory_receipts i JOIN tenant_credential_revocation_receipts r ON BINARY r.request_id=BINARY i.request_id AND BINARY r.tenant_id=BINARY i.tenant_id AND r.subject_generation=i.subject_generation AND BINARY r.receipt_sha256=BINARY i.t3a_receipt_sha256 WHERE BINARY i.request_id=BINARY NEW.request_id AND BINARY i.tenant_id=BINARY NEW.tenant_id AND i.subject_generation=NEW.subject_generation AND BINARY i.tracking_cutover_evidence_sha256=BINARY v_cutover_evidence AND i.store_db_timestamp_ms=NEW.credential_store_revoked_at_ms AND r.store_db_timestamp_ms=NEW.credential_store_revoked_at_ms AND r.completed_claim_attempt=NEW.completed_claim_attempt AND BINARY r.completed_claim_token_sha256=BINARY NEW.completed_claim_token_sha256) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active credential tracking requires atomic T3a inventory receipt'; END IF; END IF; END;

SET @credential_lifecycle_trigger_set_ok = (
  SELECT COUNT(*)=57 AND COUNT(DISTINCT trigger_name)=57
     AND SHA2(GROUP_CONCAT(CONCAT_WS('~',event_object_table,trigger_name,
           action_timing,event_manipulation,action_orientation,
           LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),
             CHAR(96),''),'_utf8mb4','')))
         ORDER BY event_object_table,trigger_name SEPARATOR '|'),256)
       = '943b7244736895bc09c6c7f693d41ee8c00514c9d510215e944a6668092ac9d0'
    FROM information_schema.triggers
   WHERE trigger_schema=DATABASE() AND (
     trigger_name LIKE 'trg_credential_%'
     OR trigger_name LIKE 'trg_provider_credential_%'
     OR trigger_name LIKE 'trg_tenant_auth_credential_%')
);
SET @migration_sql = IF(@credential_lifecycle_trigger_set_ok=1, 'SELECT 1',
  'SELECT 1 FROM __invalid_credential_lifecycle_trigger_set__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
SET SESSION group_concat_max_len = @credential_lifecycle_previous_group_concat_max_len;
