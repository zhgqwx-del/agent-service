-- Expand-only, default-dormant ownership substrate for tenant-correlated logs and traces.
--
-- Applying this migration does not configure a telemetry sink, derive an opaque tenant ref,
-- scan or delete telemetry, activate writers, materialize purge work, or advance erasure.  The
-- generation-0 singleton is intentionally unusable until a later, explicitly gated activation
-- binds exactly one logs target and one traces target.  Existing tenants are not backfilled: an
-- activation must explicitly publish legacy coverage gaps before any writer can claim coverage.

CREATE TABLE IF NOT EXISTS tenant_telemetry_lifecycle_control (
  singleton_id                 TINYINT UNSIGNED NOT NULL,
  control_generation           BIGINT UNSIGNED NOT NULL DEFAULT 0,
  activated_at_db_ms           BIGINT NULL,
  lifecycle_protocol           VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  writer_protocol              VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  ref_key_id_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  target_count                 BIGINT UNSIGNED NULL,
  target_root_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  activation_evidence_sha256   CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  PRIMARY KEY (singleton_id),
  CONSTRAINT chk_tenant_telemetry_control_singleton CHECK (singleton_id=1),
  CONSTRAINT chk_tenant_telemetry_control_state CHECK (
    (control_generation=0 AND activated_at_db_ms IS NULL
      AND lifecycle_protocol IS NULL AND writer_protocol IS NULL
      AND ref_key_id_sha256 IS NULL AND target_count IS NULL
      AND target_root_sha256 IS NULL AND activation_evidence_sha256 IS NULL)
    OR
    (control_generation=1 AND activated_at_db_ms>=0
      AND lifecycle_protocol='tenant-telemetry-lifecycle-v1'
      AND writer_protocol='structured-telemetry-v1'
      AND ref_key_id_sha256 REGEXP '^[0-9a-f]{64}$'
      AND target_count=2 AND target_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND activation_evidence_sha256 REGEXP '^[0-9a-f]{64}$')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT singleton_id, control_generation, activated_at_db_ms, lifecycle_protocol,
       writer_protocol, ref_key_id_sha256, target_count, target_root_sha256,
       activation_evidence_sha256
  FROM tenant_telemetry_lifecycle_control FORCE INDEX (PRIMARY) WHERE 1=0;

INSERT INTO tenant_telemetry_lifecycle_control
  (singleton_id,control_generation,activated_at_db_ms,lifecycle_protocol,writer_protocol,
   ref_key_id_sha256,target_count,target_root_sha256,activation_evidence_sha256)
SELECT 1,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL
 WHERE NOT EXISTS (
   SELECT 1 FROM tenant_telemetry_lifecycle_control WHERE singleton_id=1
 );

CREATE TABLE IF NOT EXISTS tenant_telemetry_lifecycle_targets (
  singleton_id                 TINYINT UNSIGNED NOT NULL,
  control_generation           BIGINT UNSIGNED NOT NULL,
  domain                       VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_ordinal               TINYINT UNSIGNED NOT NULL,
  scope                        VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  backend_kind                 VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  adapter_protocol             VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  namespace_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  failure_domain_sha256        CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  created_at_db_ms             BIGINT NOT NULL,
  receipt_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (singleton_id,domain),
  UNIQUE KEY uk_tenant_telemetry_target_ordinal (singleton_id,target_ordinal),
  UNIQUE KEY uk_tenant_telemetry_target_hash (target_sha256),
  UNIQUE KEY uk_tenant_telemetry_target_receipt (receipt_sha256),
  KEY idx_tenant_telemetry_target_namespace
    (backend_kind,adapter_protocol,namespace_sha256,domain),
  CONSTRAINT fk_tenant_telemetry_target_control
    FOREIGN KEY (singleton_id)
    REFERENCES tenant_telemetry_lifecycle_control (singleton_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tenant_telemetry_target_shape CHECK (
    singleton_id=1 AND control_generation=1
      AND domain IN ('logs','traces')
      AND ((domain='logs' AND target_ordinal=0)
        OR (domain='traces' AND target_ordinal=1))
      AND scope='tenant-telemetry-lifecycle-target-v1'
      AND backend_kind REGEXP '^[a-z0-9][a-z0-9._-]{0,31}$'
      AND adapter_protocol REGEXP '^[a-z0-9][a-z0-9._:-]{0,63}$'
      AND namespace_sha256 REGEXP '^[0-9a-f]{64}$'
      AND failure_domain_sha256 REGEXP '^[0-9a-f]{64}$'
      AND target_sha256 REGEXP '^[0-9a-f]{64}$'
      AND created_at_db_ms>=0 AND receipt_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT singleton_id, control_generation, domain, target_ordinal, scope, backend_kind,
       adapter_protocol, namespace_sha256, failure_domain_sha256, target_sha256,
       created_at_db_ms, receipt_sha256
  FROM tenant_telemetry_lifecycle_targets FORCE INDEX (
    PRIMARY, uk_tenant_telemetry_target_ordinal, uk_tenant_telemetry_target_hash,
    uk_tenant_telemetry_target_receipt, idx_tenant_telemetry_target_namespace
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_telemetry_lifecycle_coverages (
  tenant_id                    VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  control_generation           BIGINT UNSIGNED NOT NULL,
  scope                        VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  history_status               VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_ref_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_count                 BIGINT UNSIGNED NOT NULL,
  target_root_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  coverage_started_at_db_ms    BIGINT NOT NULL,
  evidence_sha256              CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (tenant_id),
  UNIQUE KEY uk_tenant_telemetry_coverage_parent (tenant_id,evidence_sha256),
  UNIQUE KEY uk_tenant_telemetry_coverage_ref (subject_ref_sha256),
  UNIQUE KEY uk_tenant_telemetry_coverage_evidence (evidence_sha256),
  KEY idx_tenant_telemetry_coverage_status
    (history_status,coverage_started_at_db_ms,tenant_id),
  CONSTRAINT chk_tenant_telemetry_coverage_shape CHECK (
    control_generation=1
      AND scope='tenant-telemetry-lifecycle-coverage-v1'
      AND history_status IN ('legacy_history_unknown','complete_since_creation')
      AND subject_ref_sha256 REGEXP '^[0-9a-f]{64}$'
      AND target_count=2 AND target_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND coverage_started_at_db_ms>=0
      AND evidence_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT tenant_id, control_generation, scope, history_status, subject_ref_sha256,
       target_count, target_root_sha256, coverage_started_at_db_ms, evidence_sha256
  FROM tenant_telemetry_lifecycle_coverages FORCE INDEX (
    PRIMARY, uk_tenant_telemetry_coverage_parent, uk_tenant_telemetry_coverage_ref,
    uk_tenant_telemetry_coverage_evidence,
    idx_tenant_telemetry_coverage_status
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_telemetry_lifecycle_subjects (
  request_id                    VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                     VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation            BIGINT UNSIGNED NOT NULL,
  control_generation            BIGINT UNSIGNED NOT NULL,
  scope                         VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  t1_fence_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  coverage_evidence_sha256      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  history_status                VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_ref_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_count                  BIGINT UNSIGNED NOT NULL,
  target_root_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  bound_at_db_ms                BIGINT NOT NULL,
  receipt_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (request_id),
  UNIQUE KEY uk_tenant_telemetry_subject_owner (tenant_id,subject_generation),
  UNIQUE KEY uk_tenant_telemetry_subject_ref
    (tenant_id,subject_generation,subject_ref_sha256),
  UNIQUE KEY uk_tenant_telemetry_subject_receipt (receipt_sha256),
  KEY idx_tenant_telemetry_subject_control
    (control_generation,tenant_id,subject_generation),
  CONSTRAINT fk_tenant_telemetry_subject_admission
    FOREIGN KEY (request_id)
    REFERENCES tenant_erasure_admissions (request_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tenant_telemetry_subject_coverage
    FOREIGN KEY (tenant_id,coverage_evidence_sha256)
    REFERENCES tenant_telemetry_lifecycle_coverages (tenant_id,evidence_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tenant_telemetry_subject_shape CHECK (
    subject_generation>0 AND control_generation=1
      AND scope='tenant-telemetry-lifecycle-subject-v1'
      AND t1_fence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND coverage_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND history_status IN ('legacy_history_unknown','complete_since_creation')
      AND subject_ref_sha256 REGEXP '^[0-9a-f]{64}$'
      AND target_count=2 AND target_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND bound_at_db_ms>=0 AND receipt_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT request_id, tenant_id, subject_generation, control_generation, scope,
       t1_fence_sha256, coverage_evidence_sha256, history_status, subject_ref_sha256,
       target_count, target_root_sha256, bound_at_db_ms, receipt_sha256
  FROM tenant_telemetry_lifecycle_subjects FORCE INDEX (
    PRIMARY, uk_tenant_telemetry_subject_owner, uk_tenant_telemetry_subject_ref,
    uk_tenant_telemetry_subject_receipt, idx_tenant_telemetry_subject_control
  ) WHERE 1=0;

-- Marker-loss replay must not bless a weaker engine, collation, column/index/CHECK/FK set, an
-- extra migration-owned object, or a partitioned table.  The digest constants are patched from a
-- disposable real-MySQL installation and intentionally bind metadata rather than table contents.
SET @tenant_telemetry_previous_group_concat_max_len = @@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len = 1048576;
SET @tenant_telemetry_schema_ok = (
  (SELECT COUNT(*)=4
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,table_type,
             IFNULL(engine,'-'),IFNULL(table_collation,'-'))
           ORDER BY table_name SEPARATOR '|'),256)
         = '809e6454c34980d2f77df68b6c35d860e86087d68abf9b83804ab43341a74e86'
     FROM information_schema.tables
    WHERE table_schema=DATABASE() AND table_name LIKE 'tenant\_telemetry\_lifecycle\_%')
  AND
  (SELECT COUNT(*)=43
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,LPAD(ordinal_position,3,'0'),
             column_name,LOWER(column_type),is_nullable,
             IF(column_default IS NULL,'<NULL>',CONCAT('<',column_default,'>')),
             IFNULL(character_set_name,'-'),IFNULL(collation_name,'-'),
             IFNULL(NULLIF(LOWER(extra),''),'-'),
             IFNULL(NULLIF(LOWER(generation_expression),''),'-'))
           ORDER BY table_name,ordinal_position SEPARATOR '|'),256)
         = '69c3c21047fb563495175503d578f4069c3202976b06e4a864e5214cbedd3f3a'
     FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name LIKE 'tenant\_telemetry\_lifecycle\_%')
  AND
  (SELECT COUNT(DISTINCT CONCAT(table_name,'~',index_name))=17 AND COUNT(*)=31
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,index_name,non_unique,
             seq_in_index,LOWER(index_type),LOWER(is_visible),
             IFNULL(column_name,'<expression>'),IFNULL(CAST(sub_part AS CHAR),'-'),
             LOWER(IFNULL(collation,'-')),IFNULL(expression,'-'))
           ORDER BY table_name,index_name,seq_in_index SEPARATOR '|'),256)
         = '90e7105793779fa9f2af1c92d397d06a1d8eeb4b3ae8e9d7dad3f90164051789'
     FROM information_schema.statistics
    WHERE table_schema=DATABASE() AND table_name LIKE 'tenant\_telemetry\_lifecycle\_%')
  AND
  (SELECT COUNT(*)=5
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',tc.table_name,tc.constraint_name,tc.enforced,
             LOWER(REPLACE(REPLACE(REGEXP_REPLACE(cc.check_clause,'[[:space:]]',''),
               CHAR(96),''),'_utf8mb4','')))
           ORDER BY tc.table_name,tc.constraint_name SEPARATOR '|'),256)
         = '345fdf5a8d5f66dbd3dfec327e5767b2a024c5a6de0d8c8b1bd05ee6bdbe545c'
     FROM information_schema.table_constraints tc
     JOIN information_schema.check_constraints cc
       ON cc.constraint_schema=tc.constraint_schema
      AND cc.constraint_name=tc.constraint_name
    WHERE tc.table_schema=DATABASE() AND tc.constraint_type='CHECK'
      AND tc.table_name LIKE 'tenant\_telemetry\_lifecycle\_%')
  AND
  (SELECT COUNT(DISTINCT CONCAT(k.table_name,'~',k.constraint_name))=3
       AND COUNT(*)=4
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',k.table_name,k.constraint_name,
             k.ordinal_position,k.column_name,k.referenced_table_name,
             k.referenced_column_name,r.update_rule,r.delete_rule)
           ORDER BY k.table_name,k.constraint_name,k.ordinal_position SEPARATOR '|'),256)
         = '193fb9d64232584782661a8f4b77faf829fa6919b7edf6a8cd77418acb7e1d14'
     FROM information_schema.key_column_usage k
     JOIN information_schema.referential_constraints r
       ON r.constraint_schema=k.constraint_schema AND r.constraint_name=k.constraint_name
    WHERE k.table_schema=DATABASE() AND k.referenced_table_name IS NOT NULL
      AND k.table_name LIKE 'tenant\_telemetry\_lifecycle\_%')
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.partitions
     WHERE table_schema=DATABASE() AND partition_name IS NOT NULL
       AND table_name LIKE 'tenant\_telemetry\_lifecycle\_%')
);
SET @migration_sql = IF(@tenant_telemetry_schema_ok=1,'SELECT 1',
  'SELECT 1 FROM __invalid_tenant_telemetry_lifecycle_schema__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- The control is write-once; target, coverage, and subject facts are immutable append-only
-- evidence.  Runtime activation must insert exact target/coverage rows before the singleton CAS.
DROP TRIGGER IF EXISTS trg_tenant_telemetry_control_bi;
CREATE TRIGGER trg_tenant_telemetry_control_bi BEFORE INSERT ON tenant_telemetry_lifecycle_control FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry lifecycle control already exists';
DROP TRIGGER IF EXISTS trg_tenant_telemetry_control_bd;
CREATE TRIGGER trg_tenant_telemetry_control_bd BEFORE DELETE ON tenant_telemetry_lifecycle_control FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry lifecycle control cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_telemetry_control_bu;
CREATE TRIGGER trg_tenant_telemetry_control_bu BEFORE UPDATE ON tenant_telemetry_lifecycle_control FOR EACH ROW BEGIN IF NOT (OLD.singleton_id=1 AND NEW.singleton_id=1 AND OLD.control_generation=0 AND NEW.control_generation=1 AND OLD.activated_at_db_ms IS NULL AND NEW.activated_at_db_ms IS NOT NULL AND NEW.lifecycle_protocol='tenant-telemetry-lifecycle-v1' AND NEW.writer_protocol='structured-telemetry-v1' AND NEW.ref_key_id_sha256 IS NOT NULL AND NEW.target_count=2 AND NEW.target_root_sha256 IS NOT NULL AND NEW.activation_evidence_sha256 IS NOT NULL AND (SELECT COUNT(*) FROM tenant_telemetry_lifecycle_targets t WHERE t.singleton_id=1 AND t.control_generation=1)=2 AND (SELECT COUNT(DISTINCT t.domain) FROM tenant_telemetry_lifecycle_targets t WHERE t.singleton_id=1 AND t.control_generation=1)=2) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry lifecycle control transition is not permitted'; END IF; END;

DROP TRIGGER IF EXISTS trg_tenant_telemetry_targets_bu;
CREATE TRIGGER trg_tenant_telemetry_targets_bu BEFORE UPDATE ON tenant_telemetry_lifecycle_targets FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry lifecycle target is immutable';
DROP TRIGGER IF EXISTS trg_tenant_telemetry_targets_bd;
CREATE TRIGGER trg_tenant_telemetry_targets_bd BEFORE DELETE ON tenant_telemetry_lifecycle_targets FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry lifecycle target is append-only';
DROP TRIGGER IF EXISTS trg_tenant_telemetry_coverages_bu;
CREATE TRIGGER trg_tenant_telemetry_coverages_bu BEFORE UPDATE ON tenant_telemetry_lifecycle_coverages FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry lifecycle coverage is immutable';
DROP TRIGGER IF EXISTS trg_tenant_telemetry_coverages_bd;
CREATE TRIGGER trg_tenant_telemetry_coverages_bd BEFORE DELETE ON tenant_telemetry_lifecycle_coverages FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry lifecycle coverage is append-only';
DROP TRIGGER IF EXISTS trg_tenant_telemetry_subjects_bi;
CREATE TRIGGER trg_tenant_telemetry_subjects_bi BEFORE INSERT ON tenant_telemetry_lifecycle_subjects FOR EACH ROW BEGIN IF NOT EXISTS (SELECT 1 FROM tenant_erasure_admissions a JOIN tenant_credential_revocation_fences f ON BINARY f.request_id=BINARY NEW.request_id AND BINARY f.tenant_id=BINARY NEW.tenant_id AND f.subject_generation=NEW.subject_generation JOIN tenant_telemetry_lifecycle_coverages v ON BINARY v.tenant_id=BINARY NEW.tenant_id AND BINARY v.evidence_sha256=BINARY NEW.coverage_evidence_sha256 JOIN tenant_telemetry_lifecycle_control c ON c.singleton_id=1 WHERE BINARY a.request_id=BINARY NEW.request_id AND BINARY a.tenant_id=BINARY NEW.tenant_id AND a.subject_generation=NEW.subject_generation AND a.control_generation=0 AND f.fenced_at_ms=a.gated_at_ms AND BINARY f.evidence_sha256=BINARY NEW.t1_fence_sha256 AND v.control_generation=NEW.control_generation AND BINARY v.history_status=BINARY NEW.history_status AND BINARY v.subject_ref_sha256=BINARY NEW.subject_ref_sha256 AND v.target_count=NEW.target_count AND BINARY v.target_root_sha256=BINARY NEW.target_root_sha256 AND c.control_generation=NEW.control_generation AND c.activated_at_db_ms IS NOT NULL AND c.target_count=NEW.target_count AND BINARY c.target_root_sha256=BINARY NEW.target_root_sha256 AND NEW.bound_at_db_ms>=GREATEST(a.gated_at_ms,f.fenced_at_ms,v.coverage_started_at_db_ms,c.activated_at_db_ms)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry lifecycle subject is not active-source-bound'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_telemetry_subjects_bu;
CREATE TRIGGER trg_tenant_telemetry_subjects_bu BEFORE UPDATE ON tenant_telemetry_lifecycle_subjects FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry lifecycle subject is immutable';
DROP TRIGGER IF EXISTS trg_tenant_telemetry_subjects_bd;
CREATE TRIGGER trg_tenant_telemetry_subjects_bd BEFORE DELETE ON tenant_telemetry_lifecycle_subjects FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry lifecycle subject is append-only';

SET @tenant_telemetry_trigger_ok = (
  SELECT COUNT(*)=10 AND COUNT(DISTINCT trigger_name)=10
    FROM information_schema.triggers
   WHERE trigger_schema=DATABASE() AND trigger_name LIKE 'trg\_tenant\_telemetry\_%'
);
SET @migration_sql = IF(@tenant_telemetry_trigger_ok=1,'SELECT 1',
  'SELECT 1 FROM __invalid_tenant_telemetry_lifecycle_trigger_inventory__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
SET SESSION group_concat_max_len = @tenant_telemetry_previous_group_concat_max_len;
