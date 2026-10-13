-- 0049: default-dormant persisted provider-step failure capture v2 foundation.
-- No producer activation, v1 reinterpretation, backfill, external mutation or completion.
-- Drain all pre-0049 writers before installing these additive guards.

CREATE TABLE IF NOT EXISTS tenant_telemetry_capture_v2_controls (
  domain VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  scope VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  control_generation BIGINT UNSIGNED NOT NULL DEFAULT 0,
  state VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'inactive',
  capture_protocol VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  producer_protocol VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  producer_contract_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  activated_at_db_ms BIGINT NULL,
  PRIMARY KEY (domain),
  CONSTRAINT chk_tt_capture_v2_control_shape CHECK (
    domain IN ('logs','traces') AND scope='tenant-telemetry-capture-control-v2'
    AND control_generation=0 AND state='inactive' AND activated_at_db_ms IS NULL
    AND capture_protocol='tenant-telemetry-persisted-step-v2'
    AND ((domain='logs' AND producer_protocol='provider-step-error-v2'
          AND producer_contract_sha256 REGEXP '^[0-9a-f]{64}$')
      OR (domain='traces' AND producer_protocol IS NULL
          AND producer_contract_sha256 IS NULL))
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

INSERT INTO tenant_telemetry_capture_v2_controls
  (domain,scope,control_generation,state,capture_protocol,producer_protocol,
   producer_contract_sha256,activated_at_db_ms)
SELECT 'logs','tenant-telemetry-capture-control-v2',0,'inactive',
       'tenant-telemetry-persisted-step-v2','provider-step-error-v2',
       SHA2('provider.upstream_request_failed:durable-failed-step:v2',256),NULL
 WHERE NOT EXISTS (SELECT 1 FROM tenant_telemetry_capture_v2_controls WHERE domain='logs');
INSERT INTO tenant_telemetry_capture_v2_controls
  (domain,scope,control_generation,state,capture_protocol,producer_protocol,
   producer_contract_sha256,activated_at_db_ms)
SELECT 'traces','tenant-telemetry-capture-control-v2',0,'inactive',
       'tenant-telemetry-persisted-step-v2',NULL,NULL,NULL
 WHERE NOT EXISTS (SELECT 1 FROM tenant_telemetry_capture_v2_controls WHERE domain='traces');

CREATE TABLE IF NOT EXISTS tenant_telemetry_capture_v2_coverages (
  tenant_id VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  domain VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  scope VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  control_generation BIGINT UNSIGNED NOT NULL,
  capture_status VARCHAR(48) COLLATE utf8mb4_0900_as_cs NOT NULL,
  pre_cutover_history_status VARCHAR(48) COLLATE utf8mb4_0900_as_cs NOT NULL,
  lifecycle_coverage_evidence_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_ref_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  producer_contract_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  coverage_started_at_db_ms BIGINT NOT NULL,
  evidence_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (tenant_id,domain),
  UNIQUE KEY uk_tt_capture_v2_coverage_evidence (evidence_sha256),
  UNIQUE KEY uk_tt_capture_v2_coverage_binding (tenant_id,domain,evidence_sha256),
  KEY idx_tt_capture_v2_coverage_lifecycle
    (tenant_id,lifecycle_coverage_evidence_sha256),
  CONSTRAINT fk_tt_capture_v2_coverage_control FOREIGN KEY (domain)
    REFERENCES tenant_telemetry_capture_v2_controls (domain)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tt_capture_v2_coverage_lifecycle
    FOREIGN KEY (tenant_id,lifecycle_coverage_evidence_sha256)
    REFERENCES tenant_telemetry_lifecycle_coverages (tenant_id,evidence_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tt_capture_v2_coverage_shape CHECK (
    domain='logs' AND scope='tenant-telemetry-capture-coverage-v2'
    AND control_generation=1
    AND ((capture_status='capture_since_cutover'
          AND pre_cutover_history_status='pre_cutover_history_unknown')
      OR (capture_status='capture_since_tenant_creation'
          AND pre_cutover_history_status='pre_cutover_not_applicable'))
    AND lifecycle_coverage_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
    AND subject_ref_sha256 REGEXP '^[0-9a-f]{64}$'
    AND producer_contract_sha256 REGEXP '^[0-9a-f]{64}$'
    AND coverage_started_at_db_ms>=0
    AND evidence_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE IF NOT EXISTS tenant_telemetry_capture_v2_source_bindings (
  write_operation_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  scope VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  domain VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  control_generation BIGINT UNSIGNED NOT NULL,
  coverage_evidence_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  producer_contract_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_session_id VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_turn_id VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_item_id VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_step_index INT UNSIGNED NOT NULL,
  source_event_seq BIGINT UNSIGNED NOT NULL,
  owner_ref_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  payload_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  bound_at_db_ms BIGINT NOT NULL,
  receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (write_operation_sha256),
  UNIQUE KEY uk_tt_capture_v2_binding_source
    (source_session_id,source_turn_id,source_item_id,source_step_index),
  UNIQUE KEY uk_tt_capture_v2_binding_receipt (receipt_sha256),
  KEY idx_tt_capture_v2_binding_tenant (tenant_id,domain,write_operation_sha256),
  KEY idx_tt_capture_v2_binding_coverage
    (tenant_id,domain,coverage_evidence_sha256),
  CONSTRAINT fk_tt_capture_v2_binding_coverage
    FOREIGN KEY (tenant_id,domain,coverage_evidence_sha256)
    REFERENCES tenant_telemetry_capture_v2_coverages
      (tenant_id,domain,evidence_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tt_capture_v2_binding_shape CHECK (
    scope='tenant-telemetry-capture-source-binding-v2'
    AND domain='logs' AND control_generation=1
    AND write_operation_sha256 REGEXP '^[0-9a-f]{64}$'
    AND coverage_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
    AND producer_contract_sha256 REGEXP '^[0-9a-f]{64}$'
    AND CHAR_LENGTH(source_session_id) BETWEEN 1 AND 64
    AND CHAR_LENGTH(source_turn_id) BETWEEN 1 AND 64
    AND CHAR_LENGTH(source_item_id) BETWEEN 1 AND 64
    AND source_event_seq>0
    AND owner_ref_sha256 REGEXP '^[0-9a-f]{64}$'
    AND payload_sha256 REGEXP '^[0-9a-f]{64}$'
    AND bound_at_db_ms>=0 AND receipt_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Product and direct SQL remain hard-denied until a separately versioned
-- activation and same-transaction source/writer implementation is reviewed.
CREATE TRIGGER trg_tt_capture_v2_control_bi BEFORE INSERT ON tenant_telemetry_capture_v2_controls FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry capture v2 activation is disabled';
CREATE TRIGGER trg_tt_capture_v2_control_bu BEFORE UPDATE ON tenant_telemetry_capture_v2_controls FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry capture v2 activation is disabled';
CREATE TRIGGER trg_tt_capture_v2_control_bd BEFORE DELETE ON tenant_telemetry_capture_v2_controls FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry capture v2 control is permanent';
CREATE TRIGGER trg_tt_capture_v2_coverage_bi BEFORE INSERT ON tenant_telemetry_capture_v2_coverages FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry capture v2 coverage is disabled';
CREATE TRIGGER trg_tt_capture_v2_coverage_bu BEFORE UPDATE ON tenant_telemetry_capture_v2_coverages FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry capture v2 coverage is immutable';
CREATE TRIGGER trg_tt_capture_v2_coverage_bd BEFORE DELETE ON tenant_telemetry_capture_v2_coverages FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry capture v2 coverage is append-only';
CREATE TRIGGER trg_tt_capture_v2_binding_bi BEFORE INSERT ON tenant_telemetry_capture_v2_source_bindings FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry capture v2 source binding is disabled';
CREATE TRIGGER trg_tt_capture_v2_binding_bu BEFORE UPDATE ON tenant_telemetry_capture_v2_source_bindings FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry capture v2 source binding is immutable';
CREATE TRIGGER trg_tt_capture_v2_binding_bd BEFORE DELETE ON tenant_telemetry_capture_v2_source_bindings FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry capture v2 source binding is append-only';

-- A redundant guard on an 0044-fingerprinted table makes old binaries reject
-- the advanced trigger set at restart without changing published migrations.
CREATE TRIGGER trg_tt_capture_v2_old_writer_bu BEFORE UPDATE ON tenant_telemetry_pregrant_intents FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry pregrant intent is immutable';

-- 0040/0039 do not account for this sixth source. Fail closed even if a
-- privileged actor bypasses the dormant INSERT guards or control shape.
CREATE TRIGGER trg_tt_capture_v2_t3d_bu BEFORE UPDATE ON tenant_purge_plan_jobs FOR EACH ROW BEGIN IF OLD.phase='queued' AND NEW.phase='plan_sealed' AND (EXISTS (SELECT 1 FROM tenant_telemetry_capture_v2_controls WHERE state<>'inactive' OR control_generation<>0) OR EXISTS (SELECT 1 FROM tenant_telemetry_capture_v2_source_bindings WHERE BINARY tenant_id=BINARY NEW.tenant_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='T3d cannot account for capture v2 source'; END IF; END;
CREATE TRIGGER trg_tt_capture_v2_t3f_bu BEFORE UPDATE ON tenant_database_purge_jobs FOR EACH ROW BEGIN IF OLD.phase='queued' AND NEW.phase='database_purged' AND (EXISTS (SELECT 1 FROM tenant_telemetry_capture_v2_controls WHERE state<>'inactive' OR control_generation<>0) OR EXISTS (SELECT 1 FROM tenant_telemetry_capture_v2_source_bindings WHERE BINARY tenant_id=BINARY NEW.tenant_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='T3f cannot close capture v2 owner source'; END IF; END;
CREATE TRIGGER trg_tt_capture_v2_write_job_bi BEFORE INSERT ON tenant_telemetry_write_jobs FOR EACH ROW BEGIN IF EXISTS (SELECT 1 FROM tenant_telemetry_capture_v2_controls WHERE state<>'inactive' OR control_generation<>0) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture v2 job path is disabled'; END IF; END;

SET @tt_capture_v2_previous_group_concat_max_len=@@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len=1048576;
-- agent-service-runtime-fingerprint:tenant-telemetry-capture-v2-schema:start
SET @tt_capture_v2_schema_ok=(
  (SELECT COUNT(*)=3 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,table_type,IFNULL(engine,'-'),IFNULL(table_collation,'-')) ORDER BY table_name SEPARATOR '|'),256)='ba3e802f0546cf7a603d8b341bd8a2950b58f73b01b9580e9b246b74c63d4fd0' FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_capture_v2_controls','tenant_telemetry_capture_v2_coverages','tenant_telemetry_capture_v2_source_bindings'))
  AND (SELECT COUNT(*)=35 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,LPAD(ordinal_position,3,'0'),column_name,LOWER(column_type),is_nullable,IF(column_default IS NULL,'<NULL>',CONCAT('<',column_default,'>')),IFNULL(character_set_name,'-'),IFNULL(extra,'-'),IFNULL(generation_expression,'-')) ORDER BY table_name,ordinal_position SEPARATOR '|'),256)='9d97355b7f4cd52fc5837e615dbfe935b45852ec14350f96f76d1af07e3ac319' FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_capture_v2_controls','tenant_telemetry_capture_v2_coverages','tenant_telemetry_capture_v2_source_bindings'))
  AND (SELECT COUNT(*)=22 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,index_name,LPAD(seq_in_index,3,'0'),column_name,non_unique,index_type,IFNULL(collation,'-'),IFNULL(sub_part,'-'),IFNULL(nullable,'-')) ORDER BY table_name,index_name,seq_in_index SEPARATOR '|'),256)='1339664c326fe7016f6d7816a39678a4619f3be33a41b7c19a023584cc2ddb39' FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_capture_v2_controls','tenant_telemetry_capture_v2_coverages','tenant_telemetry_capture_v2_source_bindings'))
  AND (SELECT COUNT(*)=3 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',constraint_name,LOWER(REPLACE(REPLACE(REGEXP_REPLACE(check_clause,'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY constraint_name SEPARATOR '|'),256)='bd40c6bdd36c1a39f43d41417026ea6f596cd0ff15490d9b1c2e5577d060913b' FROM information_schema.check_constraints WHERE constraint_schema=DATABASE() AND constraint_name IN ('chk_tt_capture_v2_control_shape','chk_tt_capture_v2_coverage_shape','chk_tt_capture_v2_binding_shape'))
  AND (SELECT COUNT(*)=13 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,constraint_type) ORDER BY table_name,constraint_name SEPARATOR '|'),256)='f7ae12d9e707ba8b5061e84015391a574eeed26dfe5cee6579213009e3b06528' FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_capture_v2_controls','tenant_telemetry_capture_v2_coverages','tenant_telemetry_capture_v2_source_bindings'))
  AND (SELECT COUNT(*)=3 AND SUM(enforced='YES')=3 FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND constraint_name IN ('chk_tt_capture_v2_control_shape','chk_tt_capture_v2_coverage_shape','chk_tt_capture_v2_binding_shape') AND constraint_type='CHECK')
  AND (SELECT COUNT(*)=3 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,referenced_table_name,update_rule,delete_rule) ORDER BY table_name,constraint_name SEPARATOR '|'),256)='d28a48ed49f17d60945530d5610ef317c940fe47fece2d98ae16c8920e26c2aa' FROM information_schema.referential_constraints WHERE constraint_schema=DATABASE() AND table_name IN ('tenant_telemetry_capture_v2_controls','tenant_telemetry_capture_v2_coverages','tenant_telemetry_capture_v2_source_bindings'))
  AND (SELECT COUNT(*)=6 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,LPAD(ordinal_position,3,'0'),column_name,referenced_table_name,referenced_column_name) ORDER BY table_name,constraint_name,ordinal_position SEPARATOR '|'),256)='efdffe288bb708429499a8c8329cdcf52599253972328fcfc34e67e529b316ed' FROM information_schema.key_column_usage WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_capture_v2_controls','tenant_telemetry_capture_v2_coverages','tenant_telemetry_capture_v2_source_bindings') AND referenced_table_name IS NOT NULL)
  AND (SELECT COUNT(*)=0 FROM information_schema.partitions WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_capture_v2_controls','tenant_telemetry_capture_v2_coverages','tenant_telemetry_capture_v2_source_bindings') AND partition_name IS NOT NULL)
  AND (SELECT COUNT(*)=2 AND SUM(domain='logs' AND control_generation=0 AND state='inactive' AND capture_protocol='tenant-telemetry-persisted-step-v2' AND producer_protocol='provider-step-error-v2' AND producer_contract_sha256=SHA2('provider.upstream_request_failed:durable-failed-step:v2',256))=1 AND SUM(domain='traces' AND control_generation=0 AND state='inactive' AND capture_protocol='tenant-telemetry-persisted-step-v2' AND producer_protocol IS NULL AND producer_contract_sha256 IS NULL)=1 FROM tenant_telemetry_capture_v2_controls)
  AND (SELECT COUNT(*)=0 FROM tenant_telemetry_capture_v2_coverages)
  AND (SELECT COUNT(*)=0 FROM tenant_telemetry_capture_v2_source_bindings)
);
-- agent-service-runtime-fingerprint:tenant-telemetry-capture-v2-schema:end
SET @migration_sql=IF(@tt_capture_v2_schema_ok=1,'SELECT 1','SELECT 1 FROM __invalid_tenant_telemetry_capture_v2_schema__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- agent-service-runtime-fingerprint:tenant-telemetry-capture-v2-triggers:start
SET @tt_capture_v2_triggers_ok=(
  (SELECT COUNT(*)=13 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',event_object_table,trigger_name,action_timing,event_manipulation,action_orientation,IFNULL(action_condition,'<NULL>'),LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY event_object_table,trigger_name SEPARATOR '|'),256)='28e0df5eca009bd3826e330ea7cd75b6bc7187d055efd20eb935f14317d1f18e' FROM information_schema.triggers WHERE trigger_schema=DATABASE() AND trigger_name IN ('trg_tt_capture_v2_control_bi','trg_tt_capture_v2_control_bu','trg_tt_capture_v2_control_bd','trg_tt_capture_v2_coverage_bi','trg_tt_capture_v2_coverage_bu','trg_tt_capture_v2_coverage_bd','trg_tt_capture_v2_binding_bi','trg_tt_capture_v2_binding_bu','trg_tt_capture_v2_binding_bd','trg_tt_capture_v2_old_writer_bu','trg_tt_capture_v2_t3d_bu','trg_tt_capture_v2_t3f_bu','trg_tt_capture_v2_write_job_bi'))
  AND (SELECT COUNT(*)=9 FROM information_schema.triggers WHERE trigger_schema=DATABASE() AND event_object_table IN ('tenant_telemetry_capture_v2_controls','tenant_telemetry_capture_v2_coverages','tenant_telemetry_capture_v2_source_bindings'))
);
-- agent-service-runtime-fingerprint:tenant-telemetry-capture-v2-triggers:end
SET @migration_sql=IF(@tt_capture_v2_triggers_ok=1,'SELECT 1','SELECT 1 FROM __invalid_tenant_telemetry_capture_v2_triggers__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
SET SESSION group_concat_max_len=@tt_capture_v2_previous_group_concat_max_len;
