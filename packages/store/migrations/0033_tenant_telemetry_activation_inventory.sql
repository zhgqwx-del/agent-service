-- Expand-only, default-dormant activation receipt and immutable artifact inventory for the
-- content-free tenant telemetry lifecycle introduced by 0032.
--
-- Applying this migration does not activate telemetry tracking, configure or contact a sink,
-- export application logs/traces, delete an artifact, acknowledge physical deletion, or advance
-- erasure/completion.  It only makes an explicit all-tenants activation transaction and later
-- content-free inventory registration representable.  Raw owner ids (other than the tenant
-- partition key), payloads, locators, URLs, headers, credentials, and secrets are forbidden.

CREATE TABLE IF NOT EXISTS tenant_telemetry_activation_receipts (
  singleton_id                 TINYINT UNSIGNED NOT NULL,
  control_generation           BIGINT UNSIGNED NOT NULL,
  scope                        VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  ref_key_id_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_count                 BIGINT UNSIGNED NOT NULL,
  target_root_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  coverage_count               BIGINT UNSIGNED NOT NULL,
  coverage_root_sha256         CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  control_evidence_sha256      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  activated_at_db_ms           BIGINT NOT NULL,
  receipt_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (singleton_id),
  UNIQUE KEY uk_tenant_telemetry_activation_request (request_sha256),
  UNIQUE KEY uk_tenant_telemetry_activation_control (control_evidence_sha256),
  UNIQUE KEY uk_tenant_telemetry_activation_receipt (receipt_sha256),
  CONSTRAINT fk_tenant_telemetry_activation_control
    FOREIGN KEY (singleton_id)
    REFERENCES tenant_telemetry_lifecycle_control (singleton_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tenant_telemetry_activation_shape CHECK (
    singleton_id=1 AND control_generation=1
      AND scope='tenant-telemetry-lifecycle-activation-v1'
      AND request_sha256 REGEXP '^[0-9a-f]{64}$'
      AND ref_key_id_sha256 REGEXP '^[0-9a-f]{64}$'
      AND target_count=2 AND target_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND coverage_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND control_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND activated_at_db_ms>=0 AND receipt_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT singleton_id,control_generation,scope,request_sha256,ref_key_id_sha256,
       target_count,target_root_sha256,coverage_count,coverage_root_sha256,
       control_evidence_sha256,activated_at_db_ms,receipt_sha256
  FROM tenant_telemetry_activation_receipts FORCE INDEX (
    PRIMARY,uk_tenant_telemetry_activation_request,
    uk_tenant_telemetry_activation_control,uk_tenant_telemetry_activation_receipt
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_telemetry_artifact_inventory (
  inventory_sha256                    CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                           VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  control_generation                  BIGINT UNSIGNED NOT NULL,
  scope                               VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  domain                              VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_sha256                       CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  artifact_id_sha256                  CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  artifact_generation                 BIGINT UNSIGNED NOT NULL,
  owner_kind                          VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_ref_sha256                   CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  owner_ref_sha256                    CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  hold_subject_ref_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  coverage_evidence_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  history_status                      VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  writer_protocol                     VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  writer_generation                   BIGINT UNSIGNED NOT NULL,
  source_schema                       VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_generation                   BIGINT UNSIGNED NOT NULL,
  source_high_water_db_ms             BIGINT NOT NULL,
  payload_sha256                      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  manifest_sha256                     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  retention_class                     VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  retention_policy_control_generation BIGINT UNSIGNED NOT NULL,
  retention_policy_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  dispose_after_db_ms                 BIGINT NULL,
  tenant_hold_control_generation      BIGINT UNSIGNED NOT NULL,
  tenant_hold_projection_sha256       CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  owner_hold_control_generation       BIGINT UNSIGNED NOT NULL,
  owner_hold_projection_sha256        CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  restore_control_generation          BIGINT UNSIGNED NOT NULL,
  restore_lineage_kind                VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  restore_updated_at_db_ms            BIGINT NOT NULL,
  runtime_epoch_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  created_at_db_ms                    BIGINT NOT NULL,
  receipt_sha256                      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (inventory_sha256),
  UNIQUE KEY uk_tenant_telemetry_artifact_external
    (domain,artifact_id_sha256,artifact_generation),
  UNIQUE KEY uk_tenant_telemetry_artifact_receipt (receipt_sha256),
  KEY idx_tenant_telemetry_artifact_owner
    (tenant_id,owner_kind,owner_ref_sha256,created_at_db_ms,inventory_sha256),
  KEY idx_tenant_telemetry_artifact_hold
    (tenant_id,hold_subject_ref_sha256,created_at_db_ms,inventory_sha256),
  KEY idx_tenant_telemetry_artifact_target
    (target_sha256,domain,created_at_db_ms,inventory_sha256),
  KEY idx_tenant_telemetry_artifact_coverage
    (tenant_id,coverage_evidence_sha256,history_status),
  CONSTRAINT fk_tenant_telemetry_artifact_target
    FOREIGN KEY (target_sha256)
    REFERENCES tenant_telemetry_lifecycle_targets (target_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tenant_telemetry_artifact_coverage
    FOREIGN KEY (tenant_id,coverage_evidence_sha256)
    REFERENCES tenant_telemetry_lifecycle_coverages (tenant_id,evidence_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tenant_telemetry_artifact_shape CHECK (
    control_generation=1 AND scope='tenant-telemetry-artifact-inventory-v1'
      AND domain IN ('logs','traces')
      AND target_sha256 REGEXP '^[0-9a-f]{64}$'
      AND artifact_id_sha256 REGEXP '^[0-9a-f]{64}$' AND artifact_generation>0
      AND owner_kind IN ('tenant','user','session')
      AND tenant_ref_sha256 REGEXP '^[0-9a-f]{64}$'
      AND owner_ref_sha256 REGEXP '^[0-9a-f]{64}$'
      AND hold_subject_ref_sha256 REGEXP '^[0-9a-f]{64}$'
      AND coverage_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND history_status IN ('legacy_history_unknown','complete_since_creation')
      AND writer_protocol='structured-telemetry-v1' AND writer_generation=1
      AND source_schema REGEXP '^[a-z0-9][a-z0-9._:-]{0,127}$'
      AND source_high_water_db_ms>=0
      AND payload_sha256 REGEXP '^[0-9a-f]{64}$'
      AND manifest_sha256 REGEXP '^[0-9a-f]{64}$'
      AND retention_class='telemetry_policy_unconfigured'
      AND ((retention_policy_control_generation=0 AND retention_policy_sha256 IS NULL)
        OR (retention_policy_control_generation>0
          AND retention_policy_sha256 REGEXP '^[0-9a-f]{64}$'))
      AND dispose_after_db_ms IS NULL
      AND tenant_hold_projection_sha256 REGEXP '^[0-9a-f]{64}$'
      AND owner_hold_projection_sha256 REGEXP '^[0-9a-f]{64}$'
      AND ((restore_control_generation=0 AND restore_lineage_kind='inactive'
            AND restore_updated_at_db_ms=0 AND runtime_epoch_sha256 IS NULL)
        OR (restore_control_generation>0 AND restore_lineage_kind IN ('primary','restore')
            AND restore_updated_at_db_ms>=0
            AND runtime_epoch_sha256 REGEXP '^[0-9a-f]{64}$'))
      AND created_at_db_ms>=source_high_water_db_ms
      AND created_at_db_ms>=restore_updated_at_db_ms
      AND receipt_sha256 REGEXP '^[0-9a-f]{64}$'
      AND ((owner_kind='tenant' AND owner_ref_sha256=tenant_ref_sha256
            AND hold_subject_ref_sha256=tenant_ref_sha256
            AND owner_hold_control_generation=tenant_hold_control_generation
            AND owner_hold_projection_sha256=tenant_hold_projection_sha256)
        OR (owner_kind='user' AND owner_ref_sha256=hold_subject_ref_sha256)
        OR owner_kind='session')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT inventory_sha256,tenant_id,control_generation,scope,domain,target_sha256,
       artifact_id_sha256,artifact_generation,owner_kind,tenant_ref_sha256,owner_ref_sha256,
       hold_subject_ref_sha256,coverage_evidence_sha256,history_status,writer_protocol,
       writer_generation,source_schema,source_generation,source_high_water_db_ms,payload_sha256,
       manifest_sha256,retention_class,retention_policy_control_generation,
       retention_policy_sha256,dispose_after_db_ms,tenant_hold_control_generation,
       tenant_hold_projection_sha256,owner_hold_control_generation,owner_hold_projection_sha256,
       restore_control_generation,restore_lineage_kind,restore_updated_at_db_ms,
       runtime_epoch_sha256,created_at_db_ms,receipt_sha256
  FROM tenant_telemetry_artifact_inventory FORCE INDEX (
    PRIMARY,uk_tenant_telemetry_artifact_external,uk_tenant_telemetry_artifact_receipt,
    idx_tenant_telemetry_artifact_owner,idx_tenant_telemetry_artifact_hold,
    idx_tenant_telemetry_artifact_target,idx_tenant_telemetry_artifact_coverage
  ) WHERE 1=0;

-- The 0033 fingerprint binds all four 0032 tables plus both new tables.  Its constants come from
-- a disposable real MySQL 8 installation; the runtime extracts these exact marked statements on
-- every current-schema startup.
SET @tenant_telemetry_activation_previous_group_concat_max_len=@@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len=1048576;
-- agent-service-runtime-fingerprint:tenant-telemetry-activation-inventory-schema:start
SET @telemetry_activation_inventory_schema_ok=(
  (SELECT COUNT(*)=6
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,table_type,
             IFNULL(engine,'-'),IFNULL(table_collation,'-'))
           ORDER BY table_name SEPARATOR '|'),256)=
         '4cf795ada63f7b9ab7cccdb755f7f21bb410a2a897ac9da01a3bc6956f1e12f6'
     FROM information_schema.tables
    WHERE table_schema=DATABASE() AND table_name IN (
      'tenant_telemetry_lifecycle_control','tenant_telemetry_lifecycle_targets',
      'tenant_telemetry_lifecycle_coverages','tenant_telemetry_lifecycle_subjects',
      'tenant_telemetry_activation_receipts','tenant_telemetry_artifact_inventory'))
  AND
  (SELECT COUNT(*)=90
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,LPAD(ordinal_position,3,'0'),
             column_name,LOWER(column_type),is_nullable,
             IF(column_default IS NULL,'<NULL>',CONCAT('<',column_default,'>')),
             IFNULL(character_set_name,'-'),IFNULL(collation_name,'-'),
             IFNULL(NULLIF(LOWER(extra),''),'-'),
             IFNULL(NULLIF(LOWER(generation_expression),''),'-'))
           ORDER BY table_name,ordinal_position SEPARATOR '|'),256)=
         'd51cc54aad4256b23608bd0d2598cc2c8c4bc40e000ea9dde5d8d3743497c448'
     FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name IN (
      'tenant_telemetry_lifecycle_control','tenant_telemetry_lifecycle_targets',
      'tenant_telemetry_lifecycle_coverages','tenant_telemetry_lifecycle_subjects',
      'tenant_telemetry_activation_receipts','tenant_telemetry_artifact_inventory'))
  AND
  (SELECT COUNT(DISTINCT CONCAT(table_name,'~',index_name))=28 AND COUNT(*)=56
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,index_name,non_unique,
             seq_in_index,LOWER(index_type),LOWER(is_visible),
             IFNULL(column_name,'<expression>'),IFNULL(CAST(sub_part AS CHAR),'-'),
             LOWER(IFNULL(collation,'-')),IFNULL(expression,'-'))
           ORDER BY table_name,index_name,seq_in_index SEPARATOR '|'),256)=
         '0a596c283bbb9c9d724f660d7d8d824d66d0117561494d05386a0a0fc9e24f67'
     FROM information_schema.statistics
    WHERE table_schema=DATABASE() AND table_name IN (
      'tenant_telemetry_lifecycle_control','tenant_telemetry_lifecycle_targets',
      'tenant_telemetry_lifecycle_coverages','tenant_telemetry_lifecycle_subjects',
      'tenant_telemetry_activation_receipts','tenant_telemetry_artifact_inventory'))
  AND
  (SELECT COUNT(*)=7
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',tc.table_name,tc.constraint_name,tc.enforced,
             LOWER(REPLACE(REPLACE(REGEXP_REPLACE(cc.check_clause,'[[:space:]]',''),
               CHAR(96),''),'_utf8mb4','')))
           ORDER BY tc.table_name,tc.constraint_name SEPARATOR '|'),256)=
         'b8ba623173d97b281fb2006d8b2aa82d071fc063063e9b3fad93cea1e588f4fb'
     FROM information_schema.table_constraints tc
     JOIN information_schema.check_constraints cc
       ON cc.constraint_schema=tc.constraint_schema
      AND cc.constraint_name=tc.constraint_name
    WHERE tc.table_schema=DATABASE() AND tc.constraint_type='CHECK'
      AND tc.table_name IN (
        'tenant_telemetry_lifecycle_control','tenant_telemetry_lifecycle_targets',
        'tenant_telemetry_lifecycle_coverages','tenant_telemetry_lifecycle_subjects',
        'tenant_telemetry_activation_receipts','tenant_telemetry_artifact_inventory'))
  AND
  (SELECT COUNT(*)=33
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,constraint_type,enforced)
           ORDER BY table_name,constraint_name SEPARATOR '|'),256)=
         '6234e3a3298e8783933e0693d8cb303a971c2a5fd599ec5ae8643b841e4f115a'
     FROM information_schema.table_constraints
    WHERE table_schema=DATABASE() AND table_name IN (
      'tenant_telemetry_lifecycle_control','tenant_telemetry_lifecycle_targets',
      'tenant_telemetry_lifecycle_coverages','tenant_telemetry_lifecycle_subjects',
      'tenant_telemetry_activation_receipts','tenant_telemetry_artifact_inventory'))
  AND
  (SELECT COUNT(DISTINCT CONCAT(k.table_name,'~',k.constraint_name))=6 AND COUNT(*)=8
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',k.table_name,k.constraint_name,
             k.ordinal_position,k.column_name,k.referenced_table_name,
             k.referenced_column_name,r.update_rule,r.delete_rule)
           ORDER BY k.table_name,k.constraint_name,k.ordinal_position SEPARATOR '|'),256)=
         '359b3aa0ac42b8bef956f1bfd84bea35991807afd6cd7082a897d3c8b27a02c8'
     FROM information_schema.key_column_usage k
     JOIN information_schema.referential_constraints r
       ON r.constraint_schema=k.constraint_schema AND r.constraint_name=k.constraint_name
    WHERE k.table_schema=DATABASE() AND k.referenced_table_name IS NOT NULL
      AND k.table_name IN (
        'tenant_telemetry_lifecycle_control','tenant_telemetry_lifecycle_targets',
        'tenant_telemetry_lifecycle_coverages','tenant_telemetry_lifecycle_subjects',
        'tenant_telemetry_activation_receipts','tenant_telemetry_artifact_inventory'))
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.partitions
     WHERE table_schema=DATABASE() AND partition_name IS NOT NULL
       AND table_name IN (
        'tenant_telemetry_lifecycle_control','tenant_telemetry_lifecycle_targets',
        'tenant_telemetry_lifecycle_coverages','tenant_telemetry_lifecycle_subjects',
        'tenant_telemetry_activation_receipts','tenant_telemetry_artifact_inventory'))
);
-- agent-service-runtime-fingerprint:tenant-telemetry-activation-inventory-schema:end
SET @migration_sql=IF(@telemetry_activation_inventory_schema_ok=1,'SELECT 1',
  'SELECT 1 FROM __invalid_tenant_telemetry_activation_inventory_schema__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- Replace the permissive 0032 activation boundary with exact receipt-backed guards.  Targets and
-- legacy coverages may be staged only while the singleton is dormant; post-cutover coverage is
-- limited to tenants created at/after cutover.  Every artifact is immutable and must bind the
-- current target, exact tenant coverage, policy/hold snapshots, and restore runtime projection.
DROP TRIGGER IF EXISTS trg_tenant_telemetry_control_bi;
CREATE TRIGGER trg_tenant_telemetry_control_bi BEFORE INSERT ON tenant_telemetry_lifecycle_control FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry lifecycle control already exists';
DROP TRIGGER IF EXISTS trg_tenant_telemetry_control_bd;
CREATE TRIGGER trg_tenant_telemetry_control_bd BEFORE DELETE ON tenant_telemetry_lifecycle_control FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry lifecycle control cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_telemetry_control_bu;
CREATE TRIGGER trg_tenant_telemetry_control_bu BEFORE UPDATE ON tenant_telemetry_lifecycle_control FOR EACH ROW BEGIN IF NOT (OLD.singleton_id=1 AND NEW.singleton_id=1 AND OLD.control_generation=0 AND NEW.control_generation=1 AND OLD.activated_at_db_ms IS NULL AND NEW.activated_at_db_ms IS NOT NULL AND NEW.lifecycle_protocol='tenant-telemetry-lifecycle-v1' AND NEW.writer_protocol='structured-telemetry-v1' AND NEW.ref_key_id_sha256 IS NOT NULL AND NEW.target_count=2 AND NEW.target_root_sha256 IS NOT NULL AND NEW.activation_evidence_sha256 IS NOT NULL AND EXISTS (SELECT 1 FROM tenant_telemetry_activation_receipts r WHERE r.singleton_id=1 AND r.control_generation=NEW.control_generation AND BINARY r.ref_key_id_sha256=BINARY NEW.ref_key_id_sha256 AND r.target_count=NEW.target_count AND BINARY r.target_root_sha256=BINARY NEW.target_root_sha256 AND BINARY r.control_evidence_sha256=BINARY NEW.activation_evidence_sha256 AND r.activated_at_db_ms=NEW.activated_at_db_ms) AND (SELECT COUNT(*) FROM tenant_telemetry_lifecycle_targets t WHERE t.singleton_id=1 AND t.control_generation=1)=2 AND (SELECT COUNT(DISTINCT t.domain) FROM tenant_telemetry_lifecycle_targets t WHERE t.singleton_id=1 AND t.control_generation=1)=2) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry lifecycle control transition is not receipt-bound'; END IF; END;

DROP TRIGGER IF EXISTS trg_tenant_telemetry_targets_bi;
CREATE TRIGGER trg_tenant_telemetry_targets_bi BEFORE INSERT ON tenant_telemetry_lifecycle_targets FOR EACH ROW BEGIN IF NOT EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_control c WHERE c.singleton_id=1 AND c.control_generation=0 AND c.activated_at_db_ms IS NULL AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_activation_receipts)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry lifecycle target insert is not dormant'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_telemetry_targets_bu;
CREATE TRIGGER trg_tenant_telemetry_targets_bu BEFORE UPDATE ON tenant_telemetry_lifecycle_targets FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry lifecycle target is immutable';
DROP TRIGGER IF EXISTS trg_tenant_telemetry_targets_bd;
CREATE TRIGGER trg_tenant_telemetry_targets_bd BEFORE DELETE ON tenant_telemetry_lifecycle_targets FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry lifecycle target is append-only';

DROP TRIGGER IF EXISTS trg_tenant_telemetry_coverages_bi;
CREATE TRIGGER trg_tenant_telemetry_coverages_bi BEFORE INSERT ON tenant_telemetry_lifecycle_coverages FOR EACH ROW BEGIN IF NOT ((NEW.history_status='legacy_history_unknown' AND EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_control c JOIN subject_lifecycle s ON BINARY s.tenant_id=BINARY NEW.tenant_id AND s.subject_kind='tenant' AND BINARY s.subject_id=BINARY s.tenant_id WHERE c.singleton_id=1 AND c.control_generation=0 AND c.activated_at_db_ms IS NULL AND NEW.coverage_started_at_db_ms>=s.created_at_ms AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_activation_receipts) AND (SELECT COUNT(*) FROM tenant_telemetry_lifecycle_targets x WHERE x.singleton_id=1 AND x.control_generation=1)=2)) OR (NEW.history_status='complete_since_creation' AND EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_control c JOIN subject_lifecycle s ON BINARY s.tenant_id=BINARY NEW.tenant_id AND s.subject_kind='tenant' AND BINARY s.subject_id=BINARY s.tenant_id AND s.state='active' WHERE c.singleton_id=1 AND c.control_generation=1 AND NEW.control_generation=c.control_generation AND NEW.target_count=c.target_count AND BINARY NEW.target_root_sha256=BINARY c.target_root_sha256 AND s.created_at_ms>=c.activated_at_db_ms AND NEW.coverage_started_at_db_ms>=s.created_at_ms))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry lifecycle coverage insert is not permitted'; END IF; END;
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

DROP TRIGGER IF EXISTS trg_tenant_telemetry_activation_bi;
CREATE TRIGGER trg_tenant_telemetry_activation_bi BEFORE INSERT ON tenant_telemetry_activation_receipts FOR EACH ROW BEGIN IF NOT (EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_control c WHERE c.singleton_id=1 AND c.control_generation=0 AND c.activated_at_db_ms IS NULL) AND (SELECT COUNT(*) FROM tenant_telemetry_lifecycle_targets t WHERE t.singleton_id=1 AND t.control_generation=1 AND t.created_at_db_ms=NEW.activated_at_db_ms)=2 AND (SELECT COUNT(DISTINCT t.domain) FROM tenant_telemetry_lifecycle_targets t WHERE t.singleton_id=1 AND t.control_generation=1)=2 AND (SELECT COUNT(*) FROM tenant_telemetry_lifecycle_coverages v)=NEW.coverage_count AND (SELECT COUNT(*) FROM subject_lifecycle s WHERE s.subject_kind='tenant' AND BINARY s.subject_id=BINARY s.tenant_id)=NEW.coverage_count AND NOT EXISTS (SELECT 1 FROM subject_lifecycle s LEFT JOIN tenant_telemetry_lifecycle_coverages v ON BINARY v.tenant_id=BINARY s.tenant_id WHERE s.subject_kind='tenant' AND BINARY s.subject_id=BINARY s.tenant_id AND (v.tenant_id IS NULL OR v.control_generation<>1 OR v.history_status<>'legacy_history_unknown' OR v.target_count<>NEW.target_count OR BINARY v.target_root_sha256<>BINARY NEW.target_root_sha256 OR v.coverage_started_at_db_ms<>NEW.activated_at_db_ms)) AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_coverages v LEFT JOIN subject_lifecycle s ON BINARY s.tenant_id=BINARY v.tenant_id AND s.subject_kind='tenant' AND BINARY s.subject_id=BINARY s.tenant_id WHERE s.tenant_id IS NULL)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry activation receipt is not complete'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_telemetry_activation_bu;
CREATE TRIGGER trg_tenant_telemetry_activation_bu BEFORE UPDATE ON tenant_telemetry_activation_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry activation receipt is immutable';
DROP TRIGGER IF EXISTS trg_tenant_telemetry_activation_bd;
CREATE TRIGGER trg_tenant_telemetry_activation_bd BEFORE DELETE ON tenant_telemetry_activation_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry activation receipt is append-only';

DROP TRIGGER IF EXISTS trg_tenant_telemetry_artifact_bi;
CREATE TRIGGER trg_tenant_telemetry_artifact_bi BEFORE INSERT ON tenant_telemetry_artifact_inventory FOR EACH ROW BEGIN IF NOT (EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_control c WHERE c.singleton_id=1 AND c.control_generation=NEW.control_generation AND c.control_generation=1 AND c.writer_protocol=NEW.writer_protocol AND c.activated_at_db_ms<=NEW.created_at_db_ms) AND EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_targets t WHERE t.singleton_id=1 AND t.control_generation=NEW.control_generation AND BINARY t.domain=BINARY NEW.domain AND BINARY t.target_sha256=BINARY NEW.target_sha256) AND EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_coverages v WHERE BINARY v.tenant_id=BINARY NEW.tenant_id AND v.control_generation=NEW.control_generation AND BINARY v.evidence_sha256=BINARY NEW.coverage_evidence_sha256 AND BINARY v.history_status=BINARY NEW.history_status AND BINARY v.subject_ref_sha256=BINARY NEW.tenant_ref_sha256 AND v.coverage_started_at_db_ms<=NEW.created_at_db_ms) AND EXISTS (SELECT 1 FROM subject_lifecycle s WHERE BINARY s.tenant_id=BINARY NEW.tenant_id AND s.subject_kind='tenant' AND BINARY s.subject_id=BINARY NEW.tenant_id AND s.state='active' AND s.created_at_ms<=NEW.created_at_db_ms) AND (EXISTS (SELECT 1 FROM retention_policy_controls p WHERE BINARY p.tenant_id=BINARY NEW.tenant_id AND p.control_generation=NEW.retention_policy_control_generation AND p.active_policy_sha256<=>NEW.retention_policy_sha256 AND p.updated_at_ms<=NEW.created_at_db_ms) OR (NEW.retention_policy_control_generation=0 AND NEW.retention_policy_sha256 IS NULL AND NOT EXISTS (SELECT 1 FROM retention_policy_controls p WHERE BINARY p.tenant_id=BINARY NEW.tenant_id) AND NOT EXISTS (SELECT 1 FROM retention_policy_activation_events e WHERE BINARY e.tenant_id=BINARY NEW.tenant_id))) AND (EXISTS (SELECT 1 FROM legal_hold_controls h WHERE BINARY h.tenant_id=BINARY NEW.tenant_id AND h.subject_kind='tenant' AND BINARY h.subject_id=BINARY NEW.tenant_id AND h.control_generation=NEW.tenant_hold_control_generation AND BINARY h.active_projection_sha256=BINARY NEW.tenant_hold_projection_sha256 AND h.updated_at_ms<=NEW.created_at_db_ms) OR (NEW.tenant_hold_control_generation=0 AND BINARY NEW.tenant_hold_projection_sha256=BINARY 'd336a3d705ffe91a7158c28e0e39f45cbc278d4a8890c738d9da03a164fd140f' AND NOT EXISTS (SELECT 1 FROM legal_hold_controls h WHERE BINARY h.tenant_id=BINARY NEW.tenant_id AND h.subject_kind='tenant' AND BINARY h.subject_id=BINARY NEW.tenant_id) AND NOT EXISTS (SELECT 1 FROM legal_holds h WHERE BINARY h.tenant_id=BINARY NEW.tenant_id AND h.subject_kind='tenant' AND BINARY h.subject_id=BINARY NEW.tenant_id) AND NOT EXISTS (SELECT 1 FROM legal_hold_events e WHERE BINARY e.tenant_id=BINARY NEW.tenant_id AND e.subject_kind='tenant' AND BINARY e.subject_id=BINARY NEW.tenant_id))) AND (NEW.owner_kind<>'tenant' OR (NEW.owner_hold_control_generation=NEW.tenant_hold_control_generation AND BINARY NEW.owner_hold_projection_sha256=BINARY NEW.tenant_hold_projection_sha256)) AND ((NEW.restore_control_generation=0 AND NEW.restore_lineage_kind='inactive' AND NEW.restore_updated_at_db_ms=0 AND NEW.runtime_epoch_sha256 IS NULL AND EXISTS (SELECT 1 FROM tenant_restore_runtime_control r WHERE r.singleton_id=1 AND r.state='inactive' AND r.control_generation=0)) OR EXISTS (SELECT 1 FROM tenant_restore_runtime_control r WHERE r.singleton_id=1 AND r.state='active' AND r.control_generation=NEW.restore_control_generation AND BINARY r.lineage_kind=BINARY NEW.restore_lineage_kind AND r.updated_at_db_ms=NEW.restore_updated_at_db_ms AND BINARY r.runtime_epoch_sha256=BINARY NEW.runtime_epoch_sha256 AND r.updated_at_db_ms<=NEW.created_at_db_ms))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry artifact inventory is not source-bound'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_telemetry_artifact_bu;
CREATE TRIGGER trg_tenant_telemetry_artifact_bu BEFORE UPDATE ON tenant_telemetry_artifact_inventory FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry artifact inventory is immutable';
DROP TRIGGER IF EXISTS trg_tenant_telemetry_artifact_bd;
CREATE TRIGGER trg_tenant_telemetry_artifact_bd BEFORE DELETE ON tenant_telemetry_artifact_inventory FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry artifact inventory is append-only';

-- agent-service-runtime-fingerprint:tenant-telemetry-activation-inventory-triggers:start
SET @telemetry_activation_inventory_trigger_ok=(
  SELECT COUNT(*)=18 AND COUNT(DISTINCT trigger_name)=18
     AND SHA2(GROUP_CONCAT(CONCAT_WS('~',event_object_table,trigger_name,
           action_timing,event_manipulation,action_orientation,
           IFNULL(action_condition,'<NULL>'),
           LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),
             CHAR(96),''),'_utf8mb4','')))
         ORDER BY event_object_table,trigger_name SEPARATOR '|'),256)=
       '0cdb3b5c945a681eb6a581d98dbf9243767b73812b2bd7d4212b5f5d9aa282bb'
    FROM information_schema.triggers
   WHERE trigger_schema=DATABASE()
     AND trigger_name LIKE 'trg\_tenant\_telemetry\_%'
);
-- agent-service-runtime-fingerprint:tenant-telemetry-activation-inventory-triggers:end
SET @migration_sql=IF(@telemetry_activation_inventory_trigger_ok=1,'SELECT 1',
  'SELECT 1 FROM __invalid_tenant_telemetry_0033_triggers__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
SET SESSION group_concat_max_len=@tenant_telemetry_activation_previous_group_concat_max_len;

-- A pre-0033 process had no supported activation transaction or stable ref-key contract.  An
-- active 0032 singleton without the exact new receipt is therefore unprovable and must block the
-- upgrade.  This check intentionally runs after installing the insert guards: if the DDL
-- auto-commits but the migration marker does not, an unsupported active database cannot forge a
-- receipt through the newly created table before retry.  The second branch permits exact
-- marker-loss replay after a legitimate 0033 activation.
SET @telemetry_activation_inventory_provenance_ok=(
  EXISTS (
    SELECT 1 FROM tenant_telemetry_lifecycle_control c
     WHERE c.singleton_id=1 AND c.control_generation=0
       AND c.activated_at_db_ms IS NULL AND c.lifecycle_protocol IS NULL
       AND c.writer_protocol IS NULL AND c.ref_key_id_sha256 IS NULL
       AND c.target_count IS NULL AND c.target_root_sha256 IS NULL
       AND c.activation_evidence_sha256 IS NULL
       AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_targets)
       AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_coverages)
       AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_subjects)
       AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_activation_receipts)
       AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_artifact_inventory)
  )
  OR EXISTS (
    SELECT 1
      FROM tenant_telemetry_lifecycle_control c
      JOIN tenant_telemetry_activation_receipts r ON r.singleton_id=c.singleton_id
     WHERE c.singleton_id=1 AND c.control_generation=1
       AND r.control_generation=c.control_generation
       AND BINARY r.ref_key_id_sha256=BINARY c.ref_key_id_sha256
       AND r.target_count=c.target_count
       AND BINARY r.target_root_sha256=BINARY c.target_root_sha256
       AND BINARY r.control_evidence_sha256=BINARY c.activation_evidence_sha256
       AND r.activated_at_db_ms=c.activated_at_db_ms
  )
);
SET @migration_sql=IF(@telemetry_activation_inventory_provenance_ok=1,'SELECT 1',
  'SELECT 1 FROM __unsupported_pre0033_tenant_telemetry_activation__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
