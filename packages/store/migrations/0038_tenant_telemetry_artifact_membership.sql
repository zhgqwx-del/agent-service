-- 0038: immutable source membership for each new managed telemetry artifact write.
-- Expand-only and default-dormant: no activation, historical backfill, sink access, deletion grant,
-- or execution. Drain all pre-0038 writers before this DDL; the new job trigger is an additive
-- guard and never drops the existing 0035 guard. Historical jobs remain honestly unbound.

CREATE TABLE IF NOT EXISTS tenant_telemetry_artifact_memberships (
  write_operation_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  scope VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  domain VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  inventory_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  artifact_id_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  artifact_generation BIGINT UNSIGNED NOT NULL,
  manifest_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  payload_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  owner_kind VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_ref_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  owner_ref_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  hold_subject_ref_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  ref_key_id_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  owner_binding_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  lifecycle_coverage_evidence_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  lifecycle_history_status VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  application_binding_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  source_schema VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_generation BIGINT UNSIGNED NOT NULL,
  source_high_water_db_ms BIGINT NOT NULL,
  inventory_created_at_db_ms BIGINT NOT NULL,
  membership_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (write_operation_sha256),
  UNIQUE KEY uk_tt_membership_inventory (inventory_sha256),
  UNIQUE KEY uk_tt_membership_receipt (membership_sha256),
  KEY idx_tt_membership_tenant_owner
    (tenant_id,owner_kind,owner_ref_sha256,write_operation_sha256),
  KEY idx_tt_membership_coverage
    (tenant_id,lifecycle_coverage_evidence_sha256,write_operation_sha256),
  KEY idx_tt_membership_target
    (target_sha256,domain,write_operation_sha256),
  CONSTRAINT fk_tt_membership_target FOREIGN KEY (target_sha256)
    REFERENCES tenant_telemetry_lifecycle_targets (target_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tt_membership_coverage
    FOREIGN KEY (tenant_id,lifecycle_coverage_evidence_sha256)
    REFERENCES tenant_telemetry_lifecycle_coverages (tenant_id,evidence_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tt_membership_app_receipt
    FOREIGN KEY (application_binding_receipt_sha256)
    REFERENCES tenant_telemetry_application_write_bindings (receipt_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tt_membership_shape CHECK (
    write_operation_sha256 REGEXP '^[0-9a-f]{64}$'
    AND scope='tenant-telemetry-artifact-membership-v1'
    AND CHAR_LENGTH(tenant_id) BETWEEN 1 AND 128
    AND domain IN ('logs','traces')
    AND target_sha256 REGEXP '^[0-9a-f]{64}$'
    AND inventory_sha256 REGEXP '^[0-9a-f]{64}$'
    AND artifact_id_sha256 REGEXP '^[0-9a-f]{64}$'
    AND artifact_generation>0
    AND manifest_sha256 REGEXP '^[0-9a-f]{64}$'
    AND payload_sha256 REGEXP '^[0-9a-f]{64}$'
    AND owner_kind IN ('tenant','user','session')
    AND tenant_ref_sha256 REGEXP '^[0-9a-f]{64}$'
    AND owner_ref_sha256 REGEXP '^[0-9a-f]{64}$'
    AND hold_subject_ref_sha256 REGEXP '^[0-9a-f]{64}$'
    AND ref_key_id_sha256 REGEXP '^[0-9a-f]{64}$'
    AND owner_binding_sha256 REGEXP '^[0-9a-f]{64}$'
    AND lifecycle_coverage_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
    AND lifecycle_history_status IN ('legacy_history_unknown','complete_since_creation')
    AND (application_binding_receipt_sha256 IS NULL
      OR application_binding_receipt_sha256 REGEXP '^[0-9a-f]{64}$')
    AND source_schema REGEXP '^[a-z0-9][a-z0-9._:-]{0,127}$'
    AND source_high_water_db_ms>=0
    AND inventory_created_at_db_ms>=source_high_water_db_ms
    AND membership_sha256 REGEXP '^[0-9a-f]{64}$'
    AND ((owner_kind='tenant' AND owner_ref_sha256=tenant_ref_sha256
      AND hold_subject_ref_sha256=tenant_ref_sha256)
      OR (owner_kind='user' AND owner_ref_sha256=hold_subject_ref_sha256)
      OR owner_kind='session')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT write_operation_sha256,scope,tenant_id,domain,target_sha256,inventory_sha256,
       artifact_id_sha256,artifact_generation,manifest_sha256,payload_sha256,owner_kind,
       tenant_ref_sha256,owner_ref_sha256,hold_subject_ref_sha256,ref_key_id_sha256,
       owner_binding_sha256,lifecycle_coverage_evidence_sha256,lifecycle_history_status,
       application_binding_receipt_sha256,source_schema,source_generation,
       source_high_water_db_ms,inventory_created_at_db_ms,membership_sha256
  FROM tenant_telemetry_artifact_memberships FORCE INDEX (
    PRIMARY,uk_tt_membership_inventory,uk_tt_membership_receipt,
    idx_tt_membership_tenant_owner,idx_tt_membership_coverage,idx_tt_membership_target
  ) WHERE 1=0;

-- New sidecars cannot relabel a historical job. Every relation is exact and tenant-isolated;
-- cryptographic HMAC/digest verification is additionally performed by the runtime.
CREATE TRIGGER trg_tt_membership_bi BEFORE INSERT ON tenant_telemetry_artifact_memberships FOR EACH ROW BEGIN IF (NOT EXISTS (SELECT 1 FROM tenant_telemetry_write_jobs j WHERE BINARY j.write_operation_sha256=BINARY NEW.write_operation_sha256) AND EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_control c WHERE c.singleton_id=1 AND c.control_generation=1 AND c.writer_protocol='structured-telemetry-v1' AND BINARY c.ref_key_id_sha256=BINARY NEW.ref_key_id_sha256 AND c.activated_at_db_ms<=NEW.inventory_created_at_db_ms) AND EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_targets t WHERE BINARY t.target_sha256=BINARY NEW.target_sha256 AND BINARY t.domain=BINARY NEW.domain AND t.control_generation=1) AND EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_coverages v WHERE BINARY v.tenant_id=BINARY NEW.tenant_id AND BINARY v.evidence_sha256=BINARY NEW.lifecycle_coverage_evidence_sha256 AND BINARY v.history_status=BINARY NEW.lifecycle_history_status AND BINARY v.subject_ref_sha256=BINARY NEW.tenant_ref_sha256 AND v.control_generation=1) AND EXISTS (SELECT 1 FROM subject_lifecycle s FORCE INDEX (PRIMARY) WHERE BINARY s.tenant_id=BINARY NEW.tenant_id AND s.subject_kind='tenant' AND BINARY s.subject_id=BINARY NEW.tenant_id AND s.state='active' AND s.created_at_ms<=NEW.inventory_created_at_db_ms) AND ((NEW.application_binding_receipt_sha256 IS NULL AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_application_domain_controls c WHERE BINARY c.domain=BINARY NEW.domain AND c.state='active' AND c.control_generation=1)) OR (NEW.application_binding_receipt_sha256 IS NOT NULL AND EXISTS (SELECT 1 FROM tenant_telemetry_application_domain_controls c JOIN tenant_telemetry_application_write_bindings b ON BINARY b.domain=BINARY c.domain WHERE BINARY c.domain=BINARY NEW.domain AND c.state='active' AND c.control_generation=1 AND BINARY b.write_operation_sha256=BINARY NEW.write_operation_sha256 AND BINARY b.receipt_sha256=BINARY NEW.application_binding_receipt_sha256 AND BINARY b.tenant_id=BINARY NEW.tenant_id AND BINARY b.domain=BINARY NEW.domain AND BINARY b.target_sha256=BINARY NEW.target_sha256 AND BINARY b.inventory_sha256=BINARY NEW.inventory_sha256 AND BINARY b.manifest_sha256=BINARY NEW.manifest_sha256 AND BINARY b.payload_sha256=BINARY NEW.payload_sha256 AND BINARY b.lifecycle_coverage_evidence_sha256=BINARY NEW.lifecycle_coverage_evidence_sha256 AND BINARY b.control_evidence_sha256=BINARY c.activation_evidence_sha256)))) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry membership is not exact active-source-bound'; END IF; END;

CREATE TRIGGER trg_tt_membership_bu BEFORE UPDATE ON tenant_telemetry_artifact_memberships FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry membership is immutable';
CREATE TRIGGER trg_tt_membership_bd BEFORE DELETE ON tenant_telemetry_artifact_memberships FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry membership is append-only';

-- Additive twin: never rotate/drop the published 0035 job guard. New jobs must have a same-
-- transaction immutable membership whose exact source tuple also matches the job inventory JSON.
CREATE TRIGGER trg_tt_membership_write_job_bi BEFORE INSERT ON tenant_telemetry_write_jobs FOR EACH ROW BEGIN IF NOT EXISTS (SELECT 1 FROM tenant_telemetry_artifact_memberships m WHERE BINARY m.write_operation_sha256=BINARY NEW.write_operation_sha256 AND BINARY m.tenant_id=BINARY NEW.tenant_id AND BINARY m.domain=BINARY NEW.domain AND BINARY m.target_sha256=BINARY NEW.target_sha256 AND BINARY m.inventory_sha256=BINARY NEW.inventory_sha256 AND BINARY m.artifact_id_sha256=BINARY NEW.artifact_id_sha256 AND m.artifact_generation=NEW.artifact_generation AND BINARY m.manifest_sha256=BINARY NEW.manifest_sha256 AND BINARY m.payload_sha256=BINARY NEW.payload_sha256 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.inventory_json,'$.ownerKind'))=BINARY m.owner_kind AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.inventory_json,'$.tenantRefSha256'))=BINARY m.tenant_ref_sha256 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.inventory_json,'$.ownerRefSha256'))=BINARY m.owner_ref_sha256 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.inventory_json,'$.holdSubjectRefSha256'))=BINARY m.hold_subject_ref_sha256 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.inventory_json,'$.coverageEvidenceSha256'))=BINARY m.lifecycle_coverage_evidence_sha256 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.inventory_json,'$.historyStatus'))=BINARY m.lifecycle_history_status AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.inventory_json,'$.sourceSchema'))=BINARY m.source_schema AND CAST(JSON_UNQUOTE(JSON_EXTRACT(NEW.inventory_json,'$.sourceGeneration')) AS UNSIGNED)=m.source_generation AND CAST(JSON_UNQUOTE(JSON_EXTRACT(NEW.inventory_json,'$.sourceHighWaterDbMs')) AS UNSIGNED)=m.source_high_water_db_ms AND CAST(JSON_UNQUOTE(JSON_EXTRACT(NEW.inventory_json,'$.createdAtDbMs')) AS UNSIGNED)=m.inventory_created_at_db_ms AND NEW.created_at_ms=m.inventory_created_at_db_ms) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry write job lacks exact immutable membership'; END IF; END;

SET @tt_membership_previous_group_concat_max_len=@@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len=1048576;
-- agent-service-runtime-fingerprint:tenant-telemetry-artifact-membership-schema:start
SET @tt_membership_schema_ok=(
  (SELECT COUNT(*)=1 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,table_type,IFNULL(engine,'-'),IFNULL(table_collation,'-')) ORDER BY table_name SEPARATOR '|'),256)='2bf1629df8fd0b0fdea2d2fecb1ecbc201fb4e0c94af4ff387f70e83b4cf24b8'
     FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='tenant_telemetry_artifact_memberships')
  AND (SELECT COUNT(*)=24 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,LPAD(ordinal_position,3,'0'),column_name,LOWER(column_type),is_nullable,IF(column_default IS NULL,'<NULL>',CONCAT('<',column_default,'>')),IFNULL(character_set_name,'-'),IFNULL(collation_name,'-'),IFNULL(extra,'-'),IFNULL(generation_expression,'-')) ORDER BY table_name,ordinal_position SEPARATOR '|'),256)='ade4bb4ed0199a2fe9d0792ba3c458ca1b9bcdaa30b791fba9391580cf1a9522'
     FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='tenant_telemetry_artifact_memberships')
  AND (SELECT COUNT(*)=14 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,index_name,LPAD(seq_in_index,3,'0'),column_name,non_unique,index_type,IFNULL(collation,'-'),IFNULL(sub_part,'-'),IFNULL(nullable,'-')) ORDER BY table_name,index_name,seq_in_index SEPARATOR '|'),256)='3341ace39d32911b52768a7f9d08a309d157cc637609028e7c66ab82b1930237'
     FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='tenant_telemetry_artifact_memberships')
  AND (SELECT COUNT(*)=1 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',constraint_name,LOWER(REPLACE(REPLACE(REGEXP_REPLACE(check_clause,'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY constraint_name SEPARATOR '|'),256)='e649d05b2099ffcddd6ba7839cbf50dd8c8fce16c734dfb9769042e8465436ee'
     FROM information_schema.check_constraints WHERE constraint_schema=DATABASE() AND constraint_name='chk_tt_membership_shape')
  AND (SELECT COUNT(*)=7 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',constraint_name,constraint_type) ORDER BY constraint_name SEPARATOR '|'),256)='105910a388a062bbca3140aeb008ef3eeff5d2a7c273bcb205b85083bf0e871c'
     FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND table_name='tenant_telemetry_artifact_memberships')
  AND (SELECT COUNT(*)=3 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',constraint_name,referenced_table_name,update_rule,delete_rule) ORDER BY constraint_name SEPARATOR '|'),256)='b04a8ea8b2c1a5e9caf62fba27fa0be9cad8440fc4973ddbcf49d23eef7bc48f'
     FROM information_schema.referential_constraints WHERE constraint_schema=DATABASE() AND table_name='tenant_telemetry_artifact_memberships')
  AND (SELECT COUNT(*)=0 FROM information_schema.partitions WHERE table_schema=DATABASE() AND table_name='tenant_telemetry_artifact_memberships' AND partition_name IS NOT NULL)
);
-- agent-service-runtime-fingerprint:tenant-telemetry-artifact-membership-schema:end
SET @migration_sql=IF(@tt_membership_schema_ok=1,'SELECT 1','SELECT 1 FROM __invalid_tenant_telemetry_artifact_membership_schema__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- Full 0037 trigger family plus four immutable membership guards. A pre-0038 binary still
-- expects 83 triggers and therefore fails closed after the 0038 marker is installed.
-- agent-service-runtime-fingerprint:tenant-telemetry-artifact-membership-triggers:start
SET @tt_membership_triggers_ok=(
  SELECT COUNT(*)=87 AND COUNT(DISTINCT trigger_name)=87 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',event_object_table,trigger_name,action_timing,event_manipulation,action_orientation,IFNULL(action_condition,'<NULL>'),LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY event_object_table,trigger_name SEPARATOR '|'),256)='a56b7dd8abc74f1f2112bd73853c07a65c518e2c4d875c0993fafd8d8619cc93'
  FROM information_schema.triggers
  WHERE trigger_schema=DATABASE()
    AND (event_object_table IN ('sessions','subject_lifecycle','tenant_telemetry_lifecycle_control','tenant_telemetry_lifecycle_targets','tenant_telemetry_lifecycle_coverages','tenant_telemetry_lifecycle_subjects','tenant_telemetry_activation_receipts','tenant_telemetry_artifact_inventory','tenant_telemetry_write_jobs','tenant_telemetry_write_payloads','tenant_telemetry_write_acks','tenant_telemetry_application_domain_controls','tenant_telemetry_application_activation_receipts','tenant_telemetry_application_coverages','tenant_telemetry_application_write_bindings','tenant_telemetry_disposition_control','tenant_telemetry_disposition_activation_receipts','tenant_telemetry_disposition_jobs','tenant_telemetry_disposition_authorization_grants','tenant_telemetry_disposition_external_authorizations','tenant_telemetry_disposition_external_events','tenant_telemetry_disposition_tombstone_acks','tenant_telemetry_disposition_receipts','tenant_telemetry_disposition_replay_fences','tenant_telemetry_artifact_memberships') OR (event_object_table='tenant_credential_revocation_jobs' AND action_timing='BEFORE' AND event_manipulation='INSERT'))
);
-- agent-service-runtime-fingerprint:tenant-telemetry-artifact-membership-triggers:end
SET @migration_sql=IF(@tt_membership_triggers_ok=1,'SELECT 1','SELECT 1 FROM __invalid_tenant_telemetry_artifact_membership_triggers__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
SET SESSION group_concat_max_len=@tt_membership_previous_group_concat_max_len;

-- Marker-loss replay cannot launder a partially installed sidecar or executable 0036 evidence.
SET @tt_membership_projection_ok=(
  NOT EXISTS (SELECT 1 FROM tenant_telemetry_artifact_memberships m LEFT JOIN tenant_telemetry_write_jobs j ON BINARY j.write_operation_sha256=BINARY m.write_operation_sha256 WHERE j.write_operation_sha256 IS NULL)
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_jobs)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_authorization_grants)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_external_authorizations)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_external_events)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_tombstone_acks)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_receipts)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_replay_fences)=0
);
SET @migration_sql=IF(@tt_membership_projection_ok=1,'SELECT 1','SELECT 1 FROM __invalid_tenant_telemetry_artifact_membership_projection__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
