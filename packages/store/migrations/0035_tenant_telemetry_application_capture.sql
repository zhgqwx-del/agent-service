-- Expand-only, default-dormant application capture cutover for the 0034 durable telemetry
-- writer.  The 0033 lifecycle control describes where telemetry belongs; it does not prove that
-- every application producer was already dual-writing.  This migration deliberately gives logs
-- and traces independent write-once cutovers and preserves the pre-cutover gap as evidence.
--
-- Applying this migration does not activate either domain, contact a sink, backfill a coverage or
-- write binding, relabel a pre-0035 job, delete telemetry, restore telemetry, or grant completion.

SET @has_telemetry_logs_capture_generation=(
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema=DATABASE() AND table_name='subject_lifecycle'
     AND column_name='telemetry_logs_capture_generation'
);
SET @migration_sql=IF(@has_telemetry_logs_capture_generation=0,
  'ALTER TABLE subject_lifecycle ADD COLUMN telemetry_logs_capture_generation BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER updated_at_ms',
  'SELECT 1');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_telemetry_traces_capture_generation=(
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema=DATABASE() AND table_name='subject_lifecycle'
     AND column_name='telemetry_traces_capture_generation'
);
SET @migration_sql=IF(@has_telemetry_traces_capture_generation=0,
  'ALTER TABLE subject_lifecycle ADD COLUMN telemetry_traces_capture_generation BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER telemetry_logs_capture_generation',
  'SELECT 1');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_subject_telemetry_capture_check=(
  SELECT COUNT(*) FROM information_schema.table_constraints
   WHERE table_schema=DATABASE() AND table_name='subject_lifecycle'
     AND constraint_type='CHECK'
     AND constraint_name='chk_subject_telemetry_capture_generation'
);
SET @migration_sql=IF(@has_subject_telemetry_capture_check=0,
  'ALTER TABLE subject_lifecycle ADD CONSTRAINT chk_subject_telemetry_capture_generation CHECK (telemetry_logs_capture_generation IN (0,1) AND telemetry_traces_capture_generation IN (0,1))',
  'SELECT 1');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

CREATE TABLE IF NOT EXISTS tenant_telemetry_application_domain_controls (
  domain                              VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  control_generation                  BIGINT UNSIGNED NOT NULL DEFAULT 0,
  state                               VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'inactive',
  scope                               VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  activated_at_db_ms                  BIGINT NULL,
  capture_protocol                    VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  producer_protocol                   VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  producer_contract_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  ref_key_id_sha256                   CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  lifecycle_control_generation        BIGINT UNSIGNED NULL,
  lifecycle_control_evidence_sha256   CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  lifecycle_target_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  lifecycle_target_receipt_sha256     CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  coverage_count                      BIGINT UNSIGNED NULL,
  coverage_root_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  pre_cutover_write_count             BIGINT UNSIGNED NULL,
  pre_cutover_write_root_sha256       CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  activation_evidence_sha256          CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  PRIMARY KEY (domain),
  UNIQUE KEY uk_tt_app_domain_generation (domain,control_generation),
  UNIQUE KEY uk_tt_app_domain_evidence (activation_evidence_sha256),
  KEY idx_tt_app_domain_target (lifecycle_target_sha256,domain),
  CONSTRAINT fk_tt_app_domain_target
    FOREIGN KEY (lifecycle_target_sha256)
    REFERENCES tenant_telemetry_lifecycle_targets (target_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tt_app_domain_control_shape CHECK (
    domain IN ('logs','traces')
      AND scope='tenant-telemetry-application-domain-control-v1'
      AND ((state='inactive' AND control_generation=0
            AND activated_at_db_ms IS NULL AND capture_protocol IS NULL
            AND producer_protocol IS NULL AND producer_contract_sha256 IS NULL
            AND ref_key_id_sha256 IS NULL AND lifecycle_control_generation IS NULL
            AND lifecycle_control_evidence_sha256 IS NULL
            AND lifecycle_target_sha256 IS NULL AND lifecycle_target_receipt_sha256 IS NULL
            AND coverage_count IS NULL AND coverage_root_sha256 IS NULL
            AND pre_cutover_write_count IS NULL AND pre_cutover_write_root_sha256 IS NULL
            AND activation_evidence_sha256 IS NULL)
        OR (state='active' AND control_generation=1 AND activated_at_db_ms>=0
            AND capture_protocol='tenant-telemetry-application-capture-v1'
            AND producer_protocol REGEXP '^[a-z0-9][a-z0-9._:-]{0,63}$'
            AND producer_contract_sha256 REGEXP '^[0-9a-f]{64}$'
            AND ref_key_id_sha256 REGEXP '^[0-9a-f]{64}$'
            AND lifecycle_control_generation=1
            AND lifecycle_control_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
            AND lifecycle_target_sha256 REGEXP '^[0-9a-f]{64}$'
            AND lifecycle_target_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
            AND coverage_count>=0 AND coverage_root_sha256 REGEXP '^[0-9a-f]{64}$'
            AND pre_cutover_write_count>=0
            AND pre_cutover_write_root_sha256 REGEXP '^[0-9a-f]{64}$'
            AND activation_evidence_sha256 REGEXP '^[0-9a-f]{64}$'))
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT domain,control_generation,state,scope,activated_at_db_ms,capture_protocol,
       producer_protocol,producer_contract_sha256,ref_key_id_sha256,
       lifecycle_control_generation,lifecycle_control_evidence_sha256,
       lifecycle_target_sha256,lifecycle_target_receipt_sha256,coverage_count,
       coverage_root_sha256,pre_cutover_write_count,pre_cutover_write_root_sha256,
       activation_evidence_sha256
  FROM tenant_telemetry_application_domain_controls FORCE INDEX (
    PRIMARY,uk_tt_app_domain_generation,uk_tt_app_domain_evidence,idx_tt_app_domain_target
  ) WHERE 1=0;

INSERT INTO tenant_telemetry_application_domain_controls
  (domain,control_generation,state,scope,activated_at_db_ms,capture_protocol,
   producer_protocol,producer_contract_sha256,ref_key_id_sha256,
   lifecycle_control_generation,lifecycle_control_evidence_sha256,
   lifecycle_target_sha256,lifecycle_target_receipt_sha256,coverage_count,
   coverage_root_sha256,pre_cutover_write_count,pre_cutover_write_root_sha256,
   activation_evidence_sha256)
SELECT 'logs',0,'inactive','tenant-telemetry-application-domain-control-v1',
       NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL
 WHERE NOT EXISTS (
   SELECT 1 FROM tenant_telemetry_application_domain_controls WHERE domain='logs'
 );

INSERT INTO tenant_telemetry_application_domain_controls
  (domain,control_generation,state,scope,activated_at_db_ms,capture_protocol,
   producer_protocol,producer_contract_sha256,ref_key_id_sha256,
   lifecycle_control_generation,lifecycle_control_evidence_sha256,
   lifecycle_target_sha256,lifecycle_target_receipt_sha256,coverage_count,
   coverage_root_sha256,pre_cutover_write_count,pre_cutover_write_root_sha256,
   activation_evidence_sha256)
SELECT 'traces',0,'inactive','tenant-telemetry-application-domain-control-v1',
       NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL
 WHERE NOT EXISTS (
   SELECT 1 FROM tenant_telemetry_application_domain_controls WHERE domain='traces'
 );

CREATE TABLE IF NOT EXISTS tenant_telemetry_application_activation_receipts (
  domain                              VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  control_generation                  BIGINT UNSIGNED NOT NULL,
  scope                               VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_sha256                      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  producer_protocol                   VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  producer_contract_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  ref_key_id_sha256                   CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  lifecycle_control_evidence_sha256   CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  lifecycle_target_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  lifecycle_target_receipt_sha256     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  coverage_count                      BIGINT UNSIGNED NOT NULL,
  coverage_root_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  pre_cutover_write_count             BIGINT UNSIGNED NOT NULL,
  pre_cutover_write_root_sha256       CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  fleet_stopped_ack                   VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  legacy_writers_drained_ack          VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  producer_ready_ack                  VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  activated_at_db_ms                  BIGINT NOT NULL,
  control_evidence_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  receipt_sha256                      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (domain),
  UNIQUE KEY uk_tt_app_activation_request (request_sha256),
  UNIQUE KEY uk_tt_app_activation_control (control_evidence_sha256),
  UNIQUE KEY uk_tt_app_activation_receipt (receipt_sha256),
  KEY idx_tt_app_activation_target (lifecycle_target_sha256,domain),
  CONSTRAINT fk_tt_app_activation_domain
    FOREIGN KEY (domain)
    REFERENCES tenant_telemetry_application_domain_controls (domain)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tt_app_activation_target
    FOREIGN KEY (lifecycle_target_sha256)
    REFERENCES tenant_telemetry_lifecycle_targets (target_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tt_app_activation_shape CHECK (
    domain IN ('logs','traces') AND control_generation=1
      AND scope='tenant-telemetry-application-activation-receipt-v1'
      AND request_sha256 REGEXP '^[0-9a-f]{64}$'
      AND producer_protocol REGEXP '^[a-z0-9][a-z0-9._:-]{0,63}$'
      AND producer_contract_sha256 REGEXP '^[0-9a-f]{64}$'
      AND ref_key_id_sha256 REGEXP '^[0-9a-f]{64}$'
      AND lifecycle_control_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND lifecycle_target_sha256 REGEXP '^[0-9a-f]{64}$'
      AND lifecycle_target_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
      AND coverage_count>=0 AND coverage_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND pre_cutover_write_count>=0
      AND pre_cutover_write_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND fleet_stopped_ack='fleet-stopped-v1'
      AND legacy_writers_drained_ack='legacy-writers-drained-v1'
      AND producer_ready_ack='producer-ready-v1'
      AND activated_at_db_ms>=0
      AND control_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND receipt_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT domain,control_generation,scope,request_sha256,producer_protocol,
       producer_contract_sha256,ref_key_id_sha256,lifecycle_control_evidence_sha256,
       lifecycle_target_sha256,lifecycle_target_receipt_sha256,coverage_count,
       coverage_root_sha256,pre_cutover_write_count,pre_cutover_write_root_sha256,
       fleet_stopped_ack,legacy_writers_drained_ack,producer_ready_ack,activated_at_db_ms,
       control_evidence_sha256,receipt_sha256
  FROM tenant_telemetry_application_activation_receipts FORCE INDEX (
    PRIMARY,uk_tt_app_activation_request,uk_tt_app_activation_control,
    uk_tt_app_activation_receipt,idx_tt_app_activation_target
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_telemetry_application_coverages (
  tenant_id                           VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  domain                              VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  control_generation                  BIGINT UNSIGNED NOT NULL,
  scope                               VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  capture_status                      VARCHAR(48) COLLATE utf8mb4_0900_as_cs NOT NULL,
  pre_cutover_history_status          VARCHAR(48) COLLATE utf8mb4_0900_as_cs NOT NULL,
  lifecycle_coverage_evidence_sha256  CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  lifecycle_history_status            VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_ref_sha256                  CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_sha256                       CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_receipt_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  producer_protocol                   VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  producer_contract_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  coverage_started_at_db_ms           BIGINT NOT NULL,
  evidence_sha256                     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (tenant_id,domain),
  UNIQUE KEY uk_tt_app_coverage_parent (tenant_id,domain,evidence_sha256),
  UNIQUE KEY uk_tt_app_coverage_evidence (evidence_sha256),
  KEY idx_tt_app_coverage_status
    (domain,capture_status,coverage_started_at_db_ms,tenant_id),
  KEY idx_tt_app_coverage_lifecycle
    (tenant_id,lifecycle_coverage_evidence_sha256,domain),
  KEY idx_tt_app_coverage_target (target_sha256,domain,tenant_id),
  CONSTRAINT fk_tt_app_coverage_domain
    FOREIGN KEY (domain)
    REFERENCES tenant_telemetry_application_domain_controls (domain)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tt_app_coverage_lifecycle
    FOREIGN KEY (tenant_id,lifecycle_coverage_evidence_sha256)
    REFERENCES tenant_telemetry_lifecycle_coverages (tenant_id,evidence_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tt_app_coverage_target
    FOREIGN KEY (target_sha256)
    REFERENCES tenant_telemetry_lifecycle_targets (target_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tt_app_coverage_shape CHECK (
    domain IN ('logs','traces') AND control_generation=1
      AND scope='tenant-telemetry-application-coverage-v1'
      AND ((capture_status='capture_since_cutover'
            AND pre_cutover_history_status='pre_cutover_history_unknown')
        OR (capture_status='capture_since_tenant_creation'
            AND pre_cutover_history_status='pre_cutover_not_applicable'))
      AND lifecycle_coverage_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND lifecycle_history_status IN ('legacy_history_unknown','complete_since_creation')
      AND subject_ref_sha256 REGEXP '^[0-9a-f]{64}$'
      AND target_sha256 REGEXP '^[0-9a-f]{64}$'
      AND target_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
      AND producer_protocol REGEXP '^[a-z0-9][a-z0-9._:-]{0,63}$'
      AND producer_contract_sha256 REGEXP '^[0-9a-f]{64}$'
      AND coverage_started_at_db_ms>=0
      AND evidence_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT tenant_id,domain,control_generation,scope,capture_status,
       pre_cutover_history_status,lifecycle_coverage_evidence_sha256,
       lifecycle_history_status,subject_ref_sha256,target_sha256,target_receipt_sha256,
       producer_protocol,producer_contract_sha256,coverage_started_at_db_ms,evidence_sha256
  FROM tenant_telemetry_application_coverages FORCE INDEX (
    PRIMARY,uk_tt_app_coverage_parent,uk_tt_app_coverage_evidence,
    idx_tt_app_coverage_status,idx_tt_app_coverage_lifecycle,idx_tt_app_coverage_target
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_telemetry_application_write_bindings (
  write_operation_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  scope                                VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  protocol                             VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                            VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  domain                               VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  control_generation                   BIGINT UNSIGNED NOT NULL,
  control_evidence_sha256              CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  coverage_evidence_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  lifecycle_coverage_evidence_sha256   CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_sha256                        CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_receipt_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  producer_protocol                    VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  producer_contract_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  inventory_sha256                     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  manifest_sha256                      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  payload_sha256                       CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  bound_at_db_ms                       BIGINT NOT NULL,
  receipt_sha256                       CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (write_operation_sha256),
  UNIQUE KEY uk_tt_app_write_binding_receipt (receipt_sha256),
  KEY idx_tt_app_write_binding_coverage
    (tenant_id,domain,coverage_evidence_sha256,write_operation_sha256),
  KEY idx_tt_app_write_binding_target
    (target_sha256,domain,bound_at_db_ms,write_operation_sha256),
  CONSTRAINT fk_tt_app_write_binding_domain
    FOREIGN KEY (domain)
    REFERENCES tenant_telemetry_application_domain_controls (domain)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tt_app_write_binding_coverage
    FOREIGN KEY (tenant_id,domain,coverage_evidence_sha256)
    REFERENCES tenant_telemetry_application_coverages (tenant_id,domain,evidence_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tt_app_write_binding_target
    FOREIGN KEY (target_sha256)
    REFERENCES tenant_telemetry_lifecycle_targets (target_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tt_app_write_binding_shape CHECK (
    write_operation_sha256 REGEXP '^[0-9a-f]{64}$'
      AND scope='tenant-telemetry-application-write-binding-v1'
      AND protocol='tenant-telemetry-application-capture-v1'
      AND domain IN ('logs','traces') AND control_generation=1
      AND control_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND coverage_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND lifecycle_coverage_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND target_sha256 REGEXP '^[0-9a-f]{64}$'
      AND target_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
      AND producer_protocol REGEXP '^[a-z0-9][a-z0-9._:-]{0,63}$'
      AND producer_contract_sha256 REGEXP '^[0-9a-f]{64}$'
      AND inventory_sha256 REGEXP '^[0-9a-f]{64}$'
      AND manifest_sha256 REGEXP '^[0-9a-f]{64}$'
      AND payload_sha256 REGEXP '^[0-9a-f]{64}$'
      AND bound_at_db_ms>=0 AND receipt_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT write_operation_sha256,scope,protocol,tenant_id,domain,control_generation,
       control_evidence_sha256,coverage_evidence_sha256,
       lifecycle_coverage_evidence_sha256,target_sha256,target_receipt_sha256,
       producer_protocol,producer_contract_sha256,inventory_sha256,manifest_sha256,
       payload_sha256,bound_at_db_ms,receipt_sha256
  FROM tenant_telemetry_application_write_bindings FORCE INDEX (
    PRIMARY,uk_tt_app_write_binding_receipt,idx_tt_app_write_binding_coverage,
    idx_tt_app_write_binding_target
  ) WHERE 1=0;

-- New tenant writers probe the finite immutable generation set without first locking a missing
-- subject gap; this trigger is the linearization guard that rejects every stale candidate.
-- Non-tenant lifecycle rows remain generation zero: application capture coverage is tenant-wide.
-- The legacy sessions AFTER INSERT trigger attempted a duplicate canonical tenant insert even
-- after the current store had already created that tenant and its coverages.  BEFORE INSERT
-- triggers run for INSERT IGNORE duplicates, so that stale default generation would incorrectly
-- reject a valid new session.  Once either application domain is active, require the canonical
-- tenant plus exact per-domain coverage to pre-exist and only retain the legacy user-row helper;
-- this also makes a pre-0035 session writer fail closed instead of creating an uncovered tenant.
-- Rotate the 0033 lifecycle-coverage insert guard at the same cutover.  Its BINARY-only tenant
-- lookup is exact but not indexable, so concurrent new tenants can scan and cross-lock each
-- other's subject rows.  The collation predicate selects the PRIMARY-key range while the BINARY
-- predicates retain raw-identity isolation.
DROP TRIGGER IF EXISTS trg_tenant_telemetry_coverages_bi;
CREATE TRIGGER trg_tenant_telemetry_coverages_bi BEFORE INSERT ON tenant_telemetry_lifecycle_coverages FOR EACH ROW BEGIN IF NOT ((NEW.history_status='legacy_history_unknown' AND EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_control c JOIN subject_lifecycle s FORCE INDEX (PRIMARY) ON s.tenant_id=NEW.tenant_id AND s.subject_kind='tenant' AND s.subject_id=NEW.tenant_id AND BINARY s.tenant_id=BINARY NEW.tenant_id AND BINARY s.subject_id=BINARY NEW.tenant_id WHERE c.singleton_id=1 AND c.control_generation=0 AND c.activated_at_db_ms IS NULL AND NEW.coverage_started_at_db_ms>=s.created_at_ms AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_activation_receipts) AND (SELECT COUNT(*) FROM tenant_telemetry_lifecycle_targets x WHERE x.singleton_id=1 AND x.control_generation=1)=2)) OR (NEW.history_status='complete_since_creation' AND EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_control c JOIN subject_lifecycle s FORCE INDEX (PRIMARY) ON s.tenant_id=NEW.tenant_id AND s.subject_kind='tenant' AND s.subject_id=NEW.tenant_id AND BINARY s.tenant_id=BINARY NEW.tenant_id AND BINARY s.subject_id=BINARY NEW.tenant_id WHERE c.singleton_id=1 AND c.control_generation=1 AND NEW.control_generation=c.control_generation AND NEW.target_count=c.target_count AND BINARY NEW.target_root_sha256=BINARY c.target_root_sha256 AND s.state='active' AND s.created_at_ms>=c.activated_at_db_ms AND NEW.coverage_started_at_db_ms>=s.created_at_ms))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry lifecycle coverage insert is not permitted'; END IF; END;

DROP TRIGGER IF EXISTS trg_sessions_subject_lifecycle_ai;
CREATE TRIGGER trg_sessions_subject_lifecycle_ai AFTER INSERT ON sessions FOR EACH ROW BEGIN IF EXISTS (SELECT 1 FROM tenant_telemetry_application_domain_controls c WHERE c.state='active' AND c.control_generation=1) THEN IF NOT EXISTS (SELECT 1 FROM subject_lifecycle s FORCE INDEX (PRIMARY) JOIN tenant_telemetry_application_domain_controls l ON l.domain='logs' JOIN tenant_telemetry_application_domain_controls t ON t.domain='traces' WHERE s.tenant_id=NEW.tenant_id AND s.subject_kind='tenant' AND s.subject_id=NEW.tenant_id AND BINARY s.tenant_id=BINARY NEW.tenant_id AND BINARY s.subject_id=BINARY NEW.tenant_id AND ((l.state='inactive' AND s.telemetry_logs_capture_generation=0) OR (l.state='active' AND EXISTS (SELECT 1 FROM tenant_telemetry_application_coverages v FORCE INDEX (PRIMARY) WHERE v.tenant_id=s.tenant_id AND BINARY v.tenant_id=BINARY s.tenant_id AND v.domain='logs' AND v.control_generation=l.control_generation AND ((v.capture_status='capture_since_cutover' AND s.telemetry_logs_capture_generation=0) OR (v.capture_status='capture_since_tenant_creation' AND s.telemetry_logs_capture_generation=1)) AND BINARY v.producer_protocol=BINARY l.producer_protocol AND BINARY v.producer_contract_sha256=BINARY l.producer_contract_sha256 AND BINARY v.target_sha256=BINARY l.lifecycle_target_sha256))) AND ((t.state='inactive' AND s.telemetry_traces_capture_generation=0) OR (t.state='active' AND EXISTS (SELECT 1 FROM tenant_telemetry_application_coverages v FORCE INDEX (PRIMARY) WHERE v.tenant_id=s.tenant_id AND BINARY v.tenant_id=BINARY s.tenant_id AND v.domain='traces' AND v.control_generation=t.control_generation AND ((v.capture_status='capture_since_cutover' AND s.telemetry_traces_capture_generation=0) OR (v.capture_status='capture_since_tenant_creation' AND s.telemetry_traces_capture_generation=1)) AND BINARY v.producer_protocol=BINARY t.producer_protocol AND BINARY v.producer_contract_sha256=BINARY t.producer_contract_sha256 AND BINARY v.target_sha256=BINARY t.lifecycle_target_sha256)))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='session tenant lacks atomic application capture coverage'; END IF; INSERT IGNORE INTO subject_lifecycle (tenant_id,subject_kind,subject_id,state,generation,active_request_id,legal_hold_at_ms,created_at_ms,updated_at_ms) VALUES (NEW.tenant_id,'user',NEW.user_id,'active',0,NULL,NULL,NEW.created_at_ms,NEW.updated_at_ms); ELSE INSERT IGNORE INTO subject_lifecycle (tenant_id,subject_kind,subject_id,state,generation,active_request_id,legal_hold_at_ms,created_at_ms,updated_at_ms) VALUES (NEW.tenant_id,'tenant',NEW.tenant_id,'active',0,NULL,NULL,NEW.created_at_ms,NEW.created_at_ms),(NEW.tenant_id,'user',NEW.user_id,'active',0,NULL,NULL,NEW.created_at_ms,NEW.updated_at_ms); END IF; END;

DROP TRIGGER IF EXISTS trg_tt_app_subject_capture_bi;
CREATE TRIGGER trg_tt_app_subject_capture_bi BEFORE INSERT ON subject_lifecycle FOR EACH ROW BEGIN IF NOT (((NEW.subject_kind='tenant' AND BINARY NEW.subject_id=BINARY NEW.tenant_id) AND EXISTS (SELECT 1 FROM tenant_telemetry_application_domain_controls l JOIN tenant_telemetry_application_domain_controls t ON t.domain='traces' WHERE l.domain='logs' AND NEW.telemetry_logs_capture_generation=l.control_generation AND NEW.telemetry_traces_capture_generation=t.control_generation)) OR ((NEW.subject_kind<>'tenant' OR BINARY NEW.subject_id<>BINARY NEW.tenant_id) AND NEW.telemetry_logs_capture_generation=0 AND NEW.telemetry_traces_capture_generation=0)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry application capture generation is stale'; END IF; END;
DROP TRIGGER IF EXISTS trg_tt_app_subject_capture_bu;
CREATE TRIGGER trg_tt_app_subject_capture_bu BEFORE UPDATE ON subject_lifecycle FOR EACH ROW BEGIN IF NOT (OLD.telemetry_logs_capture_generation=NEW.telemetry_logs_capture_generation AND OLD.telemetry_traces_capture_generation=NEW.telemetry_traces_capture_generation) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry application capture generation is immutable'; END IF; END;

DROP TRIGGER IF EXISTS trg_tt_app_domain_control_bi;
CREATE TRIGGER trg_tt_app_domain_control_bi BEFORE INSERT ON tenant_telemetry_application_domain_controls FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry application domain control already exists';
DROP TRIGGER IF EXISTS trg_tt_app_domain_control_bd;
CREATE TRIGGER trg_tt_app_domain_control_bd BEFORE DELETE ON tenant_telemetry_application_domain_controls FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry application domain control cannot be deleted';
DROP TRIGGER IF EXISTS trg_tt_app_domain_control_bu;
CREATE TRIGGER trg_tt_app_domain_control_bu BEFORE UPDATE ON tenant_telemetry_application_domain_controls FOR EACH ROW BEGIN IF NOT (BINARY OLD.domain=BINARY NEW.domain AND OLD.control_generation=0 AND OLD.state='inactive' AND NEW.control_generation=1 AND NEW.state='active' AND NEW.activated_at_db_ms IS NOT NULL AND EXISTS (SELECT 1 FROM tenant_telemetry_application_activation_receipts r WHERE BINARY r.domain=BINARY NEW.domain AND r.control_generation=NEW.control_generation AND BINARY r.producer_protocol=BINARY NEW.producer_protocol AND BINARY r.producer_contract_sha256=BINARY NEW.producer_contract_sha256 AND BINARY r.ref_key_id_sha256=BINARY NEW.ref_key_id_sha256 AND BINARY r.lifecycle_control_evidence_sha256=BINARY NEW.lifecycle_control_evidence_sha256 AND BINARY r.lifecycle_target_sha256=BINARY NEW.lifecycle_target_sha256 AND BINARY r.lifecycle_target_receipt_sha256=BINARY NEW.lifecycle_target_receipt_sha256 AND r.coverage_count=NEW.coverage_count AND BINARY r.coverage_root_sha256=BINARY NEW.coverage_root_sha256 AND r.pre_cutover_write_count=NEW.pre_cutover_write_count AND BINARY r.pre_cutover_write_root_sha256=BINARY NEW.pre_cutover_write_root_sha256 AND r.activated_at_db_ms=NEW.activated_at_db_ms AND BINARY r.control_evidence_sha256=BINARY NEW.activation_evidence_sha256)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry application domain activation is not receipt-bound'; END IF; END;

DROP TRIGGER IF EXISTS trg_tt_app_activation_bi;
CREATE TRIGGER trg_tt_app_activation_bi BEFORE INSERT ON tenant_telemetry_application_activation_receipts FOR EACH ROW BEGIN IF NOT (EXISTS (SELECT 1 FROM tenant_telemetry_application_domain_controls c WHERE BINARY c.domain=BINARY NEW.domain AND c.state='inactive' AND c.control_generation=0) AND EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_control c WHERE c.singleton_id=1 AND c.control_generation=1 AND c.activated_at_db_ms IS NOT NULL AND BINARY c.ref_key_id_sha256=BINARY NEW.ref_key_id_sha256 AND BINARY c.activation_evidence_sha256=BINARY NEW.lifecycle_control_evidence_sha256) AND EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_targets t WHERE BINARY t.domain=BINARY NEW.domain AND BINARY t.target_sha256=BINARY NEW.lifecycle_target_sha256 AND BINARY t.receipt_sha256=BINARY NEW.lifecycle_target_receipt_sha256) AND NEW.coverage_count=(SELECT COUNT(*) FROM tenant_telemetry_application_coverages v WHERE BINARY v.domain=BINARY NEW.domain AND v.capture_status='capture_since_cutover') AND NEW.pre_cutover_write_count=(SELECT COUNT(*) FROM tenant_telemetry_write_jobs j LEFT JOIN tenant_telemetry_application_write_bindings b ON BINARY b.write_operation_sha256=BINARY j.write_operation_sha256 WHERE BINARY j.domain=BINARY NEW.domain AND b.write_operation_sha256 IS NULL)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry application activation receipt is not source-bound'; END IF; END;
DROP TRIGGER IF EXISTS trg_tt_app_activation_bu;
CREATE TRIGGER trg_tt_app_activation_bu BEFORE UPDATE ON tenant_telemetry_application_activation_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry application activation receipt is immutable';
DROP TRIGGER IF EXISTS trg_tt_app_activation_bd;
CREATE TRIGGER trg_tt_app_activation_bd BEFORE DELETE ON tenant_telemetry_application_activation_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry application activation receipt is append-only';

DROP TRIGGER IF EXISTS trg_tt_app_coverage_bi;
CREATE TRIGGER trg_tt_app_coverage_bi BEFORE INSERT ON tenant_telemetry_application_coverages FOR EACH ROW BEGIN IF NOT (EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_coverages v FORCE INDEX (PRIMARY) JOIN tenant_telemetry_lifecycle_targets t FORCE INDEX (uk_tenant_telemetry_target_hash) ON t.target_sha256=NEW.target_sha256 AND BINARY t.target_sha256=BINARY NEW.target_sha256 WHERE v.tenant_id=NEW.tenant_id AND BINARY v.tenant_id=BINARY NEW.tenant_id AND BINARY v.evidence_sha256=BINARY NEW.lifecycle_coverage_evidence_sha256 AND BINARY v.history_status=BINARY NEW.lifecycle_history_status AND BINARY v.subject_ref_sha256=BINARY NEW.subject_ref_sha256 AND t.domain=NEW.domain AND BINARY t.domain=BINARY NEW.domain AND BINARY t.receipt_sha256=BINARY NEW.target_receipt_sha256 AND v.control_generation=1 AND t.control_generation=1) AND ((NEW.capture_status='capture_since_cutover' AND NEW.pre_cutover_history_status='pre_cutover_history_unknown' AND EXISTS (SELECT 1 FROM tenant_telemetry_application_domain_controls c FORCE INDEX (PRIMARY) JOIN subject_lifecycle s FORCE INDEX (PRIMARY) ON s.tenant_id=NEW.tenant_id AND s.subject_kind='tenant' AND s.subject_id=NEW.tenant_id AND BINARY s.tenant_id=BINARY NEW.tenant_id AND BINARY s.subject_id=BINARY NEW.tenant_id WHERE c.domain=NEW.domain AND BINARY c.domain=BINARY NEW.domain AND c.state='inactive' AND c.control_generation=0 AND NEW.coverage_started_at_db_ms>=s.created_at_ms AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_application_activation_receipts r FORCE INDEX (PRIMARY) WHERE r.domain=NEW.domain AND BINARY r.domain=BINARY NEW.domain))) OR (NEW.capture_status='capture_since_tenant_creation' AND NEW.pre_cutover_history_status='pre_cutover_not_applicable' AND EXISTS (SELECT 1 FROM tenant_telemetry_application_domain_controls c FORCE INDEX (PRIMARY) JOIN subject_lifecycle s FORCE INDEX (PRIMARY) ON s.tenant_id=NEW.tenant_id AND s.subject_kind='tenant' AND s.subject_id=NEW.tenant_id AND BINARY s.tenant_id=BINARY NEW.tenant_id AND BINARY s.subject_id=BINARY NEW.tenant_id WHERE c.domain=NEW.domain AND BINARY c.domain=BINARY NEW.domain AND c.state='active' AND c.control_generation=NEW.control_generation AND BINARY c.producer_protocol=BINARY NEW.producer_protocol AND BINARY c.producer_contract_sha256=BINARY NEW.producer_contract_sha256 AND BINARY c.lifecycle_target_sha256=BINARY NEW.target_sha256 AND c.activated_at_db_ms<=s.created_at_ms AND NEW.coverage_started_at_db_ms>=s.created_at_ms AND ((NEW.domain='logs' AND s.telemetry_logs_capture_generation=1) OR (NEW.domain='traces' AND s.telemetry_traces_capture_generation=1)))))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry application coverage insert is not permitted'; END IF; END;
DROP TRIGGER IF EXISTS trg_tt_app_coverage_bu;
CREATE TRIGGER trg_tt_app_coverage_bu BEFORE UPDATE ON tenant_telemetry_application_coverages FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry application coverage is immutable';
DROP TRIGGER IF EXISTS trg_tt_app_coverage_bd;
CREATE TRIGGER trg_tt_app_coverage_bd BEFORE DELETE ON tenant_telemetry_application_coverages FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry application coverage is append-only';

-- A binding is published immediately before its job in the same transaction.  Requiring the job
-- to be absent prevents an old queued/written job from being relabelled after domain activation.
DROP TRIGGER IF EXISTS trg_tt_app_write_binding_bi;
CREATE TRIGGER trg_tt_app_write_binding_bi BEFORE INSERT ON tenant_telemetry_application_write_bindings FOR EACH ROW BEGIN IF NOT (NOT EXISTS (SELECT 1 FROM tenant_telemetry_write_jobs j WHERE BINARY j.write_operation_sha256=BINARY NEW.write_operation_sha256) AND EXISTS (SELECT 1 FROM tenant_telemetry_application_domain_controls c WHERE BINARY c.domain=BINARY NEW.domain AND c.state='active' AND c.control_generation=NEW.control_generation AND BINARY c.activation_evidence_sha256=BINARY NEW.control_evidence_sha256 AND BINARY c.lifecycle_target_sha256=BINARY NEW.target_sha256 AND BINARY c.lifecycle_target_receipt_sha256=BINARY NEW.target_receipt_sha256 AND BINARY c.producer_protocol=BINARY NEW.producer_protocol AND BINARY c.producer_contract_sha256=BINARY NEW.producer_contract_sha256 AND c.activated_at_db_ms<=NEW.bound_at_db_ms) AND EXISTS (SELECT 1 FROM tenant_telemetry_application_coverages v WHERE BINARY v.tenant_id=BINARY NEW.tenant_id AND BINARY v.domain=BINARY NEW.domain AND v.control_generation=NEW.control_generation AND BINARY v.evidence_sha256=BINARY NEW.coverage_evidence_sha256 AND BINARY v.lifecycle_coverage_evidence_sha256=BINARY NEW.lifecycle_coverage_evidence_sha256 AND BINARY v.target_sha256=BINARY NEW.target_sha256 AND BINARY v.target_receipt_sha256=BINARY NEW.target_receipt_sha256 AND BINARY v.producer_protocol=BINARY NEW.producer_protocol AND BINARY v.producer_contract_sha256=BINARY NEW.producer_contract_sha256 AND v.coverage_started_at_db_ms<=NEW.bound_at_db_ms)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry application write binding is not active-source-bound'; END IF; END;
DROP TRIGGER IF EXISTS trg_tt_app_write_binding_bu;
CREATE TRIGGER trg_tt_app_write_binding_bu BEFORE UPDATE ON tenant_telemetry_application_write_bindings FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry application write binding is immutable';
DROP TRIGGER IF EXISTS trg_tt_app_write_binding_bd;
CREATE TRIGGER trg_tt_app_write_binding_bd BEFORE DELETE ON tenant_telemetry_application_write_bindings FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry application write binding is append-only';

-- Preserve every 0034 source check and add a per-domain active-cutover requirement.  Jobs already
-- present before the domain transition remain unbound and may follow the unchanged 0034 update/ACK
-- state machine; only a new INSERT after the cutover needs this immutable sidecar.
DROP TRIGGER IF EXISTS trg_managed_telemetry_write_jobs_bi;
CREATE TRIGGER trg_managed_telemetry_write_jobs_bi BEFORE INSERT ON tenant_telemetry_write_jobs FOR EACH ROW BEGIN IF (EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_control c WHERE c.singleton_id=1 AND c.control_generation=1 AND c.writer_protocol='structured-telemetry-v1' AND c.activated_at_db_ms<=NEW.created_at_ms) AND EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_targets t WHERE BINARY t.target_sha256=BINARY NEW.target_sha256 AND BINARY t.domain=BINARY NEW.domain AND t.control_generation=1) AND EXISTS (SELECT 1 FROM subject_lifecycle s FORCE INDEX (PRIMARY) WHERE s.tenant_id=NEW.tenant_id AND s.subject_kind='tenant' AND s.subject_id=NEW.tenant_id AND BINARY s.tenant_id=BINARY NEW.tenant_id AND BINARY s.subject_id=BINARY NEW.tenant_id AND s.state='active' AND s.created_at_ms<=NEW.created_at_ms) AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_artifact_inventory i WHERE BINARY i.inventory_sha256=BINARY NEW.inventory_sha256) AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.inventory_json,'$.tenantId'))=BINARY NEW.tenant_id AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.inventory_json,'$.domain'))=BINARY NEW.domain AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.inventory_json,'$.targetSha256'))=BINARY NEW.target_sha256 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.inventory_json,'$.inventorySha256'))=BINARY NEW.inventory_sha256 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.inventory_json,'$.artifactIdSha256'))=BINARY NEW.artifact_id_sha256 AND CAST(JSON_UNQUOTE(JSON_EXTRACT(NEW.inventory_json,'$.artifactGeneration')) AS UNSIGNED)=NEW.artifact_generation AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.inventory_json,'$.payloadSha256'))=BINARY NEW.payload_sha256 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.inventory_json,'$.manifestSha256'))=BINARY NEW.manifest_sha256 AND (NOT EXISTS (SELECT 1 FROM tenant_telemetry_application_domain_controls c WHERE BINARY c.domain=BINARY NEW.domain AND c.state='active' AND c.control_generation=1) OR EXISTS (SELECT 1 FROM tenant_telemetry_application_write_bindings b JOIN tenant_telemetry_application_domain_controls c ON BINARY c.domain=BINARY b.domain AND c.control_generation=b.control_generation WHERE BINARY b.write_operation_sha256=BINARY NEW.write_operation_sha256 AND BINARY b.tenant_id=BINARY NEW.tenant_id AND BINARY b.domain=BINARY NEW.domain AND BINARY b.target_sha256=BINARY NEW.target_sha256 AND BINARY b.inventory_sha256=BINARY NEW.inventory_sha256 AND BINARY b.manifest_sha256=BINARY NEW.manifest_sha256 AND BINARY b.payload_sha256=BINARY NEW.payload_sha256 AND c.state='active' AND BINARY c.activation_evidence_sha256=BINARY b.control_evidence_sha256))) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry write job is not application-capture-bound'; END IF; END;

-- The old direct inventory registration API is still needed before cutover and for exact replay of
-- an already registered object.  Once a domain is active, however, a new inventory row must be the
-- completion of either an exactly bound post-cutover job or one of the frozen unbound pre-cutover
-- jobs.  This database fence blocks a restarted pre-0035 direct writer without stranding drain.
DROP TRIGGER IF EXISTS trg_tt_app_artifact_bi;
CREATE TRIGGER trg_tt_app_artifact_bi BEFORE INSERT ON tenant_telemetry_artifact_inventory FOR EACH ROW BEGIN IF EXISTS (SELECT 1 FROM tenant_telemetry_application_domain_controls c WHERE BINARY c.domain=BINARY NEW.domain AND c.state='active' AND c.control_generation=1) AND NOT (EXISTS (SELECT 1 FROM tenant_telemetry_application_write_bindings b JOIN tenant_telemetry_write_jobs j ON BINARY j.write_operation_sha256=BINARY b.write_operation_sha256 JOIN tenant_telemetry_write_payloads p ON BINARY p.write_operation_sha256=BINARY j.write_operation_sha256 JOIN tenant_telemetry_application_domain_controls c ON BINARY c.domain=BINARY b.domain AND c.control_generation=b.control_generation WHERE j.phase='queued' AND j.claim_token IS NOT NULL AND j.lease_until_ms IS NOT NULL AND j.mutation_reservation_receipt_sha256 IS NOT NULL AND BINARY p.tenant_id=BINARY NEW.tenant_id AND BINARY p.payload_sha256=BINARY NEW.payload_sha256 AND BINARY b.tenant_id=BINARY NEW.tenant_id AND BINARY b.domain=BINARY NEW.domain AND BINARY b.target_sha256=BINARY NEW.target_sha256 AND BINARY b.inventory_sha256=BINARY NEW.inventory_sha256 AND BINARY b.manifest_sha256=BINARY NEW.manifest_sha256 AND BINARY b.payload_sha256=BINARY NEW.payload_sha256 AND BINARY j.tenant_id=BINARY NEW.tenant_id AND BINARY j.domain=BINARY NEW.domain AND BINARY j.target_sha256=BINARY NEW.target_sha256 AND BINARY j.inventory_sha256=BINARY NEW.inventory_sha256 AND BINARY j.artifact_id_sha256=BINARY NEW.artifact_id_sha256 AND j.artifact_generation=NEW.artifact_generation AND BINARY j.payload_sha256=BINARY NEW.payload_sha256 AND BINARY j.manifest_sha256=BINARY NEW.manifest_sha256 AND c.state='active' AND BINARY c.activation_evidence_sha256=BINARY b.control_evidence_sha256) OR EXISTS (SELECT 1 FROM tenant_telemetry_write_jobs j JOIN tenant_telemetry_write_payloads p ON BINARY p.write_operation_sha256=BINARY j.write_operation_sha256 JOIN tenant_telemetry_application_domain_controls c ON BINARY c.domain=BINARY j.domain LEFT JOIN tenant_telemetry_application_write_bindings b ON BINARY b.write_operation_sha256=BINARY j.write_operation_sha256 WHERE j.phase='queued' AND j.claim_token IS NOT NULL AND j.lease_until_ms IS NOT NULL AND j.mutation_reservation_receipt_sha256 IS NOT NULL AND BINARY p.tenant_id=BINARY NEW.tenant_id AND BINARY p.payload_sha256=BINARY NEW.payload_sha256 AND BINARY j.tenant_id=BINARY NEW.tenant_id AND BINARY j.domain=BINARY NEW.domain AND BINARY j.target_sha256=BINARY NEW.target_sha256 AND BINARY j.inventory_sha256=BINARY NEW.inventory_sha256 AND BINARY j.artifact_id_sha256=BINARY NEW.artifact_id_sha256 AND j.artifact_generation=NEW.artifact_generation AND BINARY j.payload_sha256=BINARY NEW.payload_sha256 AND BINARY j.manifest_sha256=BINARY NEW.manifest_sha256 AND b.write_operation_sha256 IS NULL AND c.state='active' AND j.created_at_ms<=c.activated_at_db_ms)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry artifact is not application-capture-bound'; END IF; END;

-- Strict metadata fingerprints are appended after the constants have been derived from a clean
-- real-MySQL 8 application of 0034 -> 0035.  The runtime extracts the marked statements rather
-- than trusting CREATE IF NOT EXISTS or a schema_migrations marker.

SET @tt_app_capture_previous_group_concat_max_len=@@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len=1048576;
-- agent-service-runtime-fingerprint:tenant-telemetry-application-capture-schema:start
SET @tt_app_capture_schema_ok=(
  (SELECT COUNT(*)=14
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,table_type,
             IFNULL(engine,'-'),IFNULL(table_collation,'-'))
           ORDER BY table_name SEPARATOR '|'),256)=
         'd48602d9bc1c45d043647416e6aa5656c9f7142827314545999377a6a40c2466'
     FROM information_schema.tables
    WHERE table_schema=DATABASE() AND table_name IN (
      'subject_lifecycle','tenant_telemetry_lifecycle_control',
      'tenant_telemetry_lifecycle_targets','tenant_telemetry_lifecycle_coverages',
      'tenant_telemetry_lifecycle_subjects','tenant_telemetry_activation_receipts',
      'tenant_telemetry_artifact_inventory','tenant_telemetry_write_jobs',
      'tenant_telemetry_write_payloads','tenant_telemetry_write_acks',
      'tenant_telemetry_application_domain_controls',
      'tenant_telemetry_application_activation_receipts',
      'tenant_telemetry_application_coverages',
      'tenant_telemetry_application_write_bindings'))
  AND
  (SELECT COUNT(*)=237
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,LPAD(ordinal_position,3,'0'),
             column_name,LOWER(column_type),is_nullable,
             IF(column_default IS NULL,'<NULL>',CONCAT('<',column_default,'>')),
             IFNULL(character_set_name,'-'),IFNULL(collation_name,'-'),
             IFNULL(NULLIF(LOWER(extra),''),'-'),
             IFNULL(NULLIF(LOWER(generation_expression),''),'-'))
           ORDER BY table_name,ordinal_position SEPARATOR '|'),256)=
         '0cce95eb0bdc708367786736e80bec8fc2cd91d67e138b3a77c01ad8294ec386'
     FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name IN (
      'subject_lifecycle','tenant_telemetry_lifecycle_control',
      'tenant_telemetry_lifecycle_targets','tenant_telemetry_lifecycle_coverages',
      'tenant_telemetry_lifecycle_subjects','tenant_telemetry_activation_receipts',
      'tenant_telemetry_artifact_inventory','tenant_telemetry_write_jobs',
      'tenant_telemetry_write_payloads','tenant_telemetry_write_acks',
      'tenant_telemetry_application_domain_controls',
      'tenant_telemetry_application_activation_receipts',
      'tenant_telemetry_application_coverages',
      'tenant_telemetry_application_write_bindings'))
  AND
  (SELECT COUNT(DISTINCT CONCAT(table_name,'~',index_name))=65 AND COUNT(*)=133
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,index_name,non_unique,
             seq_in_index,LOWER(index_type),LOWER(is_visible),
             IFNULL(column_name,'<expression>'),IFNULL(CAST(sub_part AS CHAR),'-'),
             LOWER(IFNULL(collation,'-')),IFNULL(expression,'-'))
           ORDER BY table_name,index_name,seq_in_index SEPARATOR '|'),256)=
         'cb6e502e887411f8e2bfcacb4f5294535b3b804e70948c80d119a046b9775027'
     FROM information_schema.statistics
    WHERE table_schema=DATABASE() AND table_name IN (
      'subject_lifecycle','tenant_telemetry_lifecycle_control',
      'tenant_telemetry_lifecycle_targets','tenant_telemetry_lifecycle_coverages',
      'tenant_telemetry_lifecycle_subjects','tenant_telemetry_activation_receipts',
      'tenant_telemetry_artifact_inventory','tenant_telemetry_write_jobs',
      'tenant_telemetry_write_payloads','tenant_telemetry_write_acks',
      'tenant_telemetry_application_domain_controls',
      'tenant_telemetry_application_activation_receipts',
      'tenant_telemetry_application_coverages',
      'tenant_telemetry_application_write_bindings'))
  AND
  (SELECT COUNT(*)=15
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',tc.table_name,tc.constraint_name,tc.enforced,
             LOWER(REPLACE(REPLACE(REGEXP_REPLACE(cc.check_clause,'[[:space:]]',''),
               CHAR(96),''),'_utf8mb4','')))
           ORDER BY tc.table_name,tc.constraint_name SEPARATOR '|'),256)=
         '8006f5659b6f7dcd0ae8e0d04e6555f9c3edbdb1f169e2c0e72d4a8b7c0e64f7'
     FROM information_schema.table_constraints tc
     JOIN information_schema.check_constraints cc
       ON cc.constraint_schema=tc.constraint_schema
      AND cc.constraint_name=tc.constraint_name
    WHERE tc.table_schema=DATABASE() AND tc.constraint_type='CHECK'
      AND tc.table_name IN (
        'subject_lifecycle','tenant_telemetry_lifecycle_control',
        'tenant_telemetry_lifecycle_targets','tenant_telemetry_lifecycle_coverages',
        'tenant_telemetry_lifecycle_subjects','tenant_telemetry_activation_receipts',
        'tenant_telemetry_artifact_inventory','tenant_telemetry_write_jobs',
        'tenant_telemetry_write_payloads','tenant_telemetry_write_acks',
        'tenant_telemetry_application_domain_controls',
        'tenant_telemetry_application_activation_receipts',
        'tenant_telemetry_application_coverages',
        'tenant_telemetry_application_write_bindings'))
  AND
  (SELECT COUNT(*)=77
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,constraint_type,enforced)
           ORDER BY table_name,constraint_name SEPARATOR '|'),256)=
         '46758b00a46f14d283da2b1ffb4f41ff565be6964518bfa8df13932f37960281'
     FROM information_schema.table_constraints
    WHERE table_schema=DATABASE() AND table_name IN (
      'subject_lifecycle','tenant_telemetry_lifecycle_control',
      'tenant_telemetry_lifecycle_targets','tenant_telemetry_lifecycle_coverages',
      'tenant_telemetry_lifecycle_subjects','tenant_telemetry_activation_receipts',
      'tenant_telemetry_artifact_inventory','tenant_telemetry_write_jobs',
      'tenant_telemetry_write_payloads','tenant_telemetry_write_acks',
      'tenant_telemetry_application_domain_controls',
      'tenant_telemetry_application_activation_receipts',
      'tenant_telemetry_application_coverages',
      'tenant_telemetry_application_write_bindings'))
  AND
  (SELECT COUNT(DISTINCT CONCAT(k.table_name,'~',k.constraint_name))=20 AND COUNT(*)=25
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',k.table_name,k.constraint_name,
             k.ordinal_position,k.column_name,k.referenced_table_name,
             k.referenced_column_name,r.update_rule,r.delete_rule)
           ORDER BY k.table_name,k.constraint_name,k.ordinal_position SEPARATOR '|'),256)=
         'e891fe7d7a8180d723f03c6db949d5bbeb1286ad69c1b4d46050ed560210b8cf'
     FROM information_schema.key_column_usage k
     JOIN information_schema.referential_constraints r
       ON r.constraint_schema=k.constraint_schema AND r.constraint_name=k.constraint_name
    WHERE k.table_schema=DATABASE() AND k.referenced_table_name IS NOT NULL
      AND k.table_name IN (
        'subject_lifecycle','tenant_telemetry_lifecycle_control',
        'tenant_telemetry_lifecycle_targets','tenant_telemetry_lifecycle_coverages',
        'tenant_telemetry_lifecycle_subjects','tenant_telemetry_activation_receipts',
        'tenant_telemetry_artifact_inventory','tenant_telemetry_write_jobs',
        'tenant_telemetry_write_payloads','tenant_telemetry_write_acks',
        'tenant_telemetry_application_domain_controls',
        'tenant_telemetry_application_activation_receipts',
        'tenant_telemetry_application_coverages',
        'tenant_telemetry_application_write_bindings'))
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.partitions
     WHERE table_schema=DATABASE() AND partition_name IS NOT NULL
       AND table_name IN (
        'subject_lifecycle','tenant_telemetry_lifecycle_control',
        'tenant_telemetry_lifecycle_targets','tenant_telemetry_lifecycle_coverages',
        'tenant_telemetry_lifecycle_subjects','tenant_telemetry_activation_receipts',
        'tenant_telemetry_artifact_inventory','tenant_telemetry_write_jobs',
        'tenant_telemetry_write_payloads','tenant_telemetry_write_acks',
        'tenant_telemetry_application_domain_controls',
        'tenant_telemetry_application_activation_receipts',
        'tenant_telemetry_application_coverages',
        'tenant_telemetry_application_write_bindings'))
);
-- agent-service-runtime-fingerprint:tenant-telemetry-application-capture-schema:end
SET @migration_sql=IF(@tt_app_capture_schema_ok=1,'SELECT 1',
  'SELECT 1 FROM __invalid_tenant_telemetry_application_capture_schema__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- agent-service-runtime-fingerprint:tenant-telemetry-application-capture-triggers:start
SET @tt_app_capture_trigger_ok=(
  SELECT COUNT(*)=54 AND COUNT(DISTINCT trigger_name)=54
     AND SHA2(GROUP_CONCAT(CONCAT_WS('~',event_object_table,trigger_name,
           action_timing,event_manipulation,action_orientation,
           IFNULL(action_condition,'<NULL>'),
           LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),
             CHAR(96),''),'_utf8mb4','')))
         ORDER BY event_object_table,trigger_name SEPARATOR '|'),256)=
       'db7ba47b75d0100c0645bed6a19e381a36a52e69a8ca7ec74c14e8b4524deaa5'
    FROM information_schema.triggers
   WHERE trigger_schema=DATABASE()
     AND (event_object_table IN (
       'sessions','subject_lifecycle','tenant_telemetry_lifecycle_control',
       'tenant_telemetry_lifecycle_targets','tenant_telemetry_lifecycle_coverages',
       'tenant_telemetry_lifecycle_subjects','tenant_telemetry_activation_receipts',
       'tenant_telemetry_artifact_inventory','tenant_telemetry_write_jobs',
       'tenant_telemetry_write_payloads','tenant_telemetry_write_acks',
       'tenant_telemetry_application_domain_controls',
       'tenant_telemetry_application_activation_receipts',
       'tenant_telemetry_application_coverages',
       'tenant_telemetry_application_write_bindings') OR
       (event_object_table='tenant_credential_revocation_jobs'
         AND action_timing='BEFORE' AND event_manipulation='INSERT'))
);
-- agent-service-runtime-fingerprint:tenant-telemetry-application-capture-triggers:end
SET @migration_sql=IF(@tt_app_capture_trigger_ok=1,'SELECT 1',
  'SELECT 1 FROM __invalid_tenant_telemetry_application_capture_triggers__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
SET SESSION group_concat_max_len=@tt_app_capture_previous_group_concat_max_len;

-- Marker-loss replay may observe an inactive fresh install or an already-active domain, but never
-- a partially committed activation/binding projection.  Exact roots are recomputed by the store's
-- startup audit; these relational checks make partial privileged DML fail before that audit.
SET @tt_app_capture_projection_ok=(
  (SELECT COUNT(*)=2 AND COUNT(DISTINCT domain)=2
     FROM tenant_telemetry_application_domain_controls)
  AND NOT EXISTS (
    SELECT 1 FROM tenant_telemetry_application_domain_controls c
     LEFT JOIN tenant_telemetry_application_activation_receipts r
       ON BINARY r.domain=BINARY c.domain
    WHERE (c.state='inactive' AND r.domain IS NOT NULL)
       OR (c.state='active' AND (r.domain IS NULL
         OR r.control_generation<>c.control_generation
         OR BINARY r.control_evidence_sha256<>BINARY c.activation_evidence_sha256
         OR r.coverage_count<>c.coverage_count
         OR BINARY r.coverage_root_sha256<>BINARY c.coverage_root_sha256
         OR r.pre_cutover_write_count<>c.pre_cutover_write_count
         OR BINARY r.pre_cutover_write_root_sha256<>BINARY c.pre_cutover_write_root_sha256))
  )
  AND NOT EXISTS (
    SELECT 1 FROM tenant_telemetry_application_coverages v
     JOIN tenant_telemetry_application_domain_controls c
       ON BINARY c.domain=BINARY v.domain
    WHERE c.state='inactive'
       OR (v.capture_status='capture_since_tenant_creation'
         AND v.coverage_started_at_db_ms<c.activated_at_db_ms)
  )
  AND NOT EXISTS (
    SELECT 1 FROM tenant_telemetry_application_write_bindings b
     LEFT JOIN tenant_telemetry_write_jobs j
       ON BINARY j.write_operation_sha256=BINARY b.write_operation_sha256
    WHERE j.write_operation_sha256 IS NULL
       OR BINARY j.tenant_id<>BINARY b.tenant_id
       OR BINARY j.domain<>BINARY b.domain
       OR BINARY j.target_sha256<>BINARY b.target_sha256
       OR BINARY j.inventory_sha256<>BINARY b.inventory_sha256
       OR BINARY j.manifest_sha256<>BINARY b.manifest_sha256
       OR BINARY j.payload_sha256<>BINARY b.payload_sha256
  )
);
SET @migration_sql=IF(@tt_app_capture_projection_ok=1,'SELECT 1',
  'SELECT 1 FROM __invalid_tenant_telemetry_application_capture_projection__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
