-- 0040: default-dormant, immutable T3d telemetry source-accounting snapshot.
-- Drain pre-0040 T3d writers before this migration. No historical backfill, external mutation,
-- activation, deletion authorization, or completion is performed. Older terminal T3d plans
-- without this receipt remain unknown. A queued/unfinished/legacy/orphan source is recorded as
-- unknown, never silently omitted or promoted to an executable logs/traces target.

CREATE TABLE IF NOT EXISTS tenant_telemetry_source_accounting_entries (
  scope VARCHAR(72) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_id VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation BIGINT UNSIGNED NOT NULL,
  build_generation BIGINT UNSIGNED NOT NULL,
  source_kind VARCHAR(24) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_identity_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  write_operation_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  domain VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_evidence_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  classification VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  reason VARCHAR(40) COLLATE utf8mb4_0900_as_cs NOT NULL,
  captured_at_db_ms BIGINT NOT NULL,
  receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (request_id,source_kind,source_identity_sha256),
  UNIQUE KEY uk_tt_source_accounting_entry_hash (receipt_sha256),
  KEY idx_tt_source_accounting_entry_tenant (tenant_id,request_id,source_kind),
  KEY idx_tt_source_accounting_entry_operation (write_operation_sha256),
  CONSTRAINT fk_tt_source_accounting_entry_plan FOREIGN KEY (request_id)
    REFERENCES tenant_purge_plan_jobs (request_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tt_source_accounting_entry_shape CHECK (
    scope='tenant-telemetry-source-accounting-entry-v1'
    AND CHAR_LENGTH(tenant_id) BETWEEN 1 AND 128
    AND subject_generation>0 AND build_generation>0
    AND source_kind IN ('inventory','write_job','write_ack','membership','application_binding')
    AND source_identity_sha256 REGEXP '^[0-9a-f]{64}$'
    AND (write_operation_sha256 IS NULL
      OR write_operation_sha256 REGEXP '^[0-9a-f]{64}$')
    AND (source_kind='inventory' OR write_operation_sha256 IS NOT NULL)
    AND domain IN ('logs','traces')
    AND source_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
    AND classification IN ('accounted','unknown')
    AND reason IN ('complete','legacy_missing_membership','incomplete_write',
      'missing_inventory','missing_ack','unbound_application','orphan_source')
    AND ((classification='accounted' AND reason='complete')
      OR (classification='unknown' AND reason<>'complete'))
    AND captured_at_db_ms>=0 AND receipt_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT scope,request_id,tenant_id,subject_generation,build_generation,source_kind,
       source_identity_sha256,write_operation_sha256,domain,source_evidence_sha256,
       classification,reason,captured_at_db_ms,receipt_sha256
  FROM tenant_telemetry_source_accounting_entries FORCE INDEX (
    PRIMARY,uk_tt_source_accounting_entry_hash,idx_tt_source_accounting_entry_tenant,
    idx_tt_source_accounting_entry_operation
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_telemetry_source_accounting_receipts (
  scope VARCHAR(72) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_id VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation BIGINT UNSIGNED NOT NULL,
  build_generation BIGINT UNSIGNED NOT NULL,
  t1_fence_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  t3c_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  plan_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  inventory_count BIGINT UNSIGNED NOT NULL,
  write_job_count BIGINT UNSIGNED NOT NULL,
  write_ack_count BIGINT UNSIGNED NOT NULL,
  membership_count BIGINT UNSIGNED NOT NULL,
  application_binding_count BIGINT UNSIGNED NOT NULL,
  entry_count BIGINT UNSIGNED NOT NULL,
  entry_root_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  unknown_count BIGINT UNSIGNED NOT NULL,
  unknown_root_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  store_db_timestamp_ms BIGINT NOT NULL,
  completed_claim_attempt INT UNSIGNED NOT NULL,
  completed_claim_token_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (request_id),
  UNIQUE KEY uk_tt_source_accounting_receipt_hash (receipt_sha256),
  KEY idx_tt_source_accounting_receipt_tenant (tenant_id,request_id),
  KEY idx_tt_source_accounting_receipt_plan (plan_receipt_sha256),
  CONSTRAINT fk_tt_source_accounting_receipt_job FOREIGN KEY (request_id)
    REFERENCES tenant_purge_plan_jobs (request_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tt_source_accounting_receipt_plan FOREIGN KEY (plan_receipt_sha256)
    REFERENCES tenant_purge_plan_receipts (receipt_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tt_source_accounting_receipt_shape CHECK (
    scope='tenant-telemetry-source-accounting-receipt-v1'
    AND CHAR_LENGTH(tenant_id) BETWEEN 1 AND 128
    AND subject_generation>0 AND build_generation>0
    AND t1_fence_sha256 REGEXP '^[0-9a-f]{64}$'
    AND t3c_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND plan_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND entry_root_sha256 REGEXP '^[0-9a-f]{64}$'
    AND unknown_root_sha256 REGEXP '^[0-9a-f]{64}$'
    AND entry_count=inventory_count+write_job_count+write_ack_count
      +membership_count+application_binding_count
    AND unknown_count<=entry_count
    AND store_db_timestamp_ms>=0 AND completed_claim_attempt>0
    AND completed_claim_token_sha256 REGEXP '^[0-9a-f]{64}$'
    AND receipt_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT scope,request_id,tenant_id,subject_generation,build_generation,
       t1_fence_sha256,t3c_receipt_sha256,plan_receipt_sha256,inventory_count,
       write_job_count,write_ack_count,membership_count,application_binding_count,
       entry_count,entry_root_sha256,unknown_count,unknown_root_sha256,
       store_db_timestamp_ms,completed_claim_attempt,completed_claim_token_sha256,
       receipt_sha256
  FROM tenant_telemetry_source_accounting_receipts FORCE INDEX (
    PRIMARY,uk_tt_source_accounting_receipt_hash,idx_tt_source_accounting_receipt_tenant,
    idx_tt_source_accounting_receipt_plan
  ) WHERE 1=0;

CREATE TRIGGER trg_tt_source_accounting_entry_bi BEFORE INSERT ON tenant_telemetry_source_accounting_entries FOR EACH ROW BEGIN IF (
  EXISTS (SELECT 1 FROM tenant_purge_plan_jobs j WHERE BINARY j.request_id=BINARY NEW.request_id AND BINARY j.tenant_id=BINARY NEW.tenant_id AND j.subject_generation=NEW.subject_generation AND j.build_generation=NEW.build_generation AND j.phase='queued')
  AND EXISTS (SELECT 1 FROM tenant_purge_plan_receipts p WHERE BINARY p.request_id=BINARY NEW.request_id AND BINARY p.tenant_id=BINARY NEW.tenant_id AND p.subject_generation=NEW.subject_generation AND p.build_generation=NEW.build_generation AND p.store_db_timestamp_ms<=NEW.captured_at_db_ms)
  AND ((NEW.source_kind='inventory' AND EXISTS (SELECT 1 FROM tenant_telemetry_artifact_inventory s WHERE BINARY s.inventory_sha256=BINARY NEW.source_identity_sha256 AND BINARY s.tenant_id=BINARY NEW.tenant_id AND BINARY s.domain=BINARY NEW.domain AND BINARY s.receipt_sha256=BINARY NEW.source_evidence_sha256))
    OR (NEW.source_kind='write_job' AND BINARY NEW.source_identity_sha256=BINARY NEW.write_operation_sha256 AND EXISTS (SELECT 1 FROM tenant_telemetry_write_jobs s WHERE BINARY s.write_operation_sha256=BINARY NEW.source_identity_sha256 AND BINARY s.tenant_id=BINARY NEW.tenant_id AND BINARY s.domain=BINARY NEW.domain))
    OR (NEW.source_kind='write_ack' AND BINARY NEW.source_identity_sha256=BINARY NEW.write_operation_sha256 AND EXISTS (SELECT 1 FROM tenant_telemetry_write_acks s WHERE BINARY s.write_operation_sha256=BINARY NEW.source_identity_sha256 AND BINARY s.tenant_id=BINARY NEW.tenant_id AND BINARY s.domain=BINARY NEW.domain AND BINARY s.receipt_sha256=BINARY NEW.source_evidence_sha256))
    OR (NEW.source_kind='membership' AND BINARY NEW.source_identity_sha256=BINARY NEW.write_operation_sha256 AND EXISTS (SELECT 1 FROM tenant_telemetry_artifact_memberships s WHERE BINARY s.write_operation_sha256=BINARY NEW.source_identity_sha256 AND BINARY s.tenant_id=BINARY NEW.tenant_id AND BINARY s.domain=BINARY NEW.domain AND BINARY s.membership_sha256=BINARY NEW.source_evidence_sha256))
    OR (NEW.source_kind='application_binding' AND BINARY NEW.source_identity_sha256=BINARY NEW.write_operation_sha256 AND EXISTS (SELECT 1 FROM tenant_telemetry_application_write_bindings s WHERE BINARY s.write_operation_sha256=BINARY NEW.source_identity_sha256 AND BINARY s.tenant_id=BINARY NEW.tenant_id AND BINARY s.domain=BINARY NEW.domain AND BINARY s.receipt_sha256=BINARY NEW.source_evidence_sha256)))
) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry source entry lacks exact T3d source'; END IF; END;

CREATE TRIGGER trg_tt_source_accounting_entry_bu BEFORE UPDATE ON tenant_telemetry_source_accounting_entries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry source entry is immutable';
CREATE TRIGGER trg_tt_source_accounting_entry_bd BEFORE DELETE ON tenant_telemetry_source_accounting_entries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry source entry is append-only';

CREATE TRIGGER trg_tt_source_accounting_receipt_bi BEFORE INSERT ON tenant_telemetry_source_accounting_receipts FOR EACH ROW BEGIN IF (
  EXISTS (SELECT 1 FROM tenant_purge_plan_jobs j WHERE BINARY j.request_id=BINARY NEW.request_id AND BINARY j.tenant_id=BINARY NEW.tenant_id AND j.subject_generation=NEW.subject_generation AND j.build_generation=NEW.build_generation AND j.phase='queued' AND BINARY j.t1_fence_sha256=BINARY NEW.t1_fence_sha256 AND BINARY j.t3c_receipt_sha256=BINARY NEW.t3c_receipt_sha256)
  AND EXISTS (SELECT 1 FROM tenant_purge_plan_receipts p WHERE BINARY p.request_id=BINARY NEW.request_id AND BINARY p.tenant_id=BINARY NEW.tenant_id AND p.subject_generation=NEW.subject_generation AND p.build_generation=NEW.build_generation AND BINARY p.receipt_sha256=BINARY NEW.plan_receipt_sha256 AND p.store_db_timestamp_ms<=NEW.store_db_timestamp_ms AND p.completed_claim_attempt=NEW.completed_claim_attempt AND BINARY p.completed_claim_token_sha256=BINARY NEW.completed_claim_token_sha256)
  AND (SELECT COUNT(*) FROM tenant_telemetry_source_accounting_entries e WHERE BINARY e.request_id=BINARY NEW.request_id AND BINARY e.tenant_id=BINARY NEW.tenant_id)=NEW.entry_count
  AND (SELECT COUNT(*) FROM tenant_telemetry_source_accounting_entries e WHERE BINARY e.request_id=BINARY NEW.request_id AND BINARY e.tenant_id=BINARY NEW.tenant_id AND e.source_kind='inventory')=NEW.inventory_count
  AND (SELECT COUNT(*) FROM tenant_telemetry_source_accounting_entries e WHERE BINARY e.request_id=BINARY NEW.request_id AND BINARY e.tenant_id=BINARY NEW.tenant_id AND e.source_kind='write_job')=NEW.write_job_count
  AND (SELECT COUNT(*) FROM tenant_telemetry_source_accounting_entries e WHERE BINARY e.request_id=BINARY NEW.request_id AND BINARY e.tenant_id=BINARY NEW.tenant_id AND e.source_kind='write_ack')=NEW.write_ack_count
  AND (SELECT COUNT(*) FROM tenant_telemetry_source_accounting_entries e WHERE BINARY e.request_id=BINARY NEW.request_id AND BINARY e.tenant_id=BINARY NEW.tenant_id AND e.source_kind='membership')=NEW.membership_count
  AND (SELECT COUNT(*) FROM tenant_telemetry_source_accounting_entries e WHERE BINARY e.request_id=BINARY NEW.request_id AND BINARY e.tenant_id=BINARY NEW.tenant_id AND e.source_kind='application_binding')=NEW.application_binding_count
  AND (SELECT COUNT(*) FROM tenant_telemetry_source_accounting_entries e WHERE BINARY e.request_id=BINARY NEW.request_id AND BINARY e.tenant_id=BINARY NEW.tenant_id AND e.classification='unknown')=NEW.unknown_count
  AND (SELECT COUNT(*) FROM tenant_telemetry_artifact_inventory s WHERE BINARY s.tenant_id=BINARY NEW.tenant_id)=NEW.inventory_count
  AND (SELECT COUNT(*) FROM tenant_telemetry_write_jobs s WHERE BINARY s.tenant_id=BINARY NEW.tenant_id)=NEW.write_job_count
  AND (SELECT COUNT(*) FROM tenant_telemetry_write_acks s WHERE BINARY s.tenant_id=BINARY NEW.tenant_id)=NEW.write_ack_count
  AND (SELECT COUNT(*) FROM tenant_telemetry_artifact_memberships s WHERE BINARY s.tenant_id=BINARY NEW.tenant_id)=NEW.membership_count
  AND (SELECT COUNT(*) FROM tenant_telemetry_application_write_bindings s WHERE BINARY s.tenant_id=BINARY NEW.tenant_id)=NEW.application_binding_count
) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry source receipt lacks complete exact source'; END IF; END;

CREATE TRIGGER trg_tt_source_accounting_receipt_bu BEFORE UPDATE ON tenant_telemetry_source_accounting_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry source receipt is immutable';
CREATE TRIGGER trg_tt_source_accounting_receipt_bd BEFORE DELETE ON tenant_telemetry_source_accounting_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry source receipt is append-only';

-- An additive terminal guard prevents the diagnostic buildPage path or an old T3d writer from
-- sealing without an exact same-transaction source receipt. Historical terminal jobs do not
-- transition again and are intentionally not relabelled.
CREATE TRIGGER trg_tt_source_accounting_t3d_terminal_bu BEFORE UPDATE ON tenant_purge_plan_jobs FOR EACH ROW BEGIN IF OLD.phase='queued' AND NEW.phase='plan_sealed' AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_source_accounting_receipts r WHERE BINARY r.request_id=BINARY NEW.request_id AND BINARY r.tenant_id=BINARY NEW.tenant_id AND r.subject_generation=NEW.subject_generation AND r.build_generation=NEW.build_generation AND BINARY r.plan_receipt_sha256=BINARY NEW.aggregate_receipt_sha256 AND r.store_db_timestamp_ms>=NEW.sealed_at_ms AND r.store_db_timestamp_ms<=NEW.updated_at_ms AND r.completed_claim_attempt=NEW.completed_claim_attempt AND BINARY r.completed_claim_token_sha256=BINARY NEW.completed_claim_token_sha256) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='terminal T3d lacks immutable telemetry source accounting'; END IF; END;

-- This redundant immutable guard is on a table INCLUDED in the published 0039 95-trigger
-- fingerprint, so an old binary rejects the upgraded schema at startup rather than silently
-- running until it attempts a T3d seal.
CREATE TRIGGER trg_tt_source_accounting_owner_closure_receipt_bu BEFORE UPDATE ON tenant_telemetry_owner_closure_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry owner closure receipt is immutable';

SET @tt_source_accounting_previous_group_concat_max_len=@@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len=1048576;
-- agent-service-runtime-fingerprint:tenant-telemetry-source-accounting-schema:start
SET @tt_source_accounting_schema_ok=(
  (SELECT COUNT(*)=2 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,table_type,IFNULL(engine,'-'),IFNULL(table_collation,'-')) ORDER BY table_name SEPARATOR '|'),256)='e07a1a611b6fedd0b74f55508a665188131c4cfd6f7d87d247bf089539db1058'
     FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_source_accounting_entries','tenant_telemetry_source_accounting_receipts'))
  AND (SELECT COUNT(*)=35 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,LPAD(ordinal_position,3,'0'),column_name,LOWER(column_type),is_nullable,IF(column_default IS NULL,'<NULL>',CONCAT('<',column_default,'>')),IFNULL(character_set_name,'-'),IFNULL(extra,'-'),IFNULL(generation_expression,'-')) ORDER BY table_name,ordinal_position SEPARATOR '|'),256)='b0d104c5f148300920a72e828aa3153dec78ea4c675c0691f10b9ffc08b2ce00'
     FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_source_accounting_entries','tenant_telemetry_source_accounting_receipts'))
  AND (SELECT COUNT(*)=13 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,index_name,LPAD(seq_in_index,3,'0'),column_name,non_unique,index_type,IFNULL(collation,'-'),IFNULL(sub_part,'-'),IFNULL(nullable,'-')) ORDER BY table_name,index_name,seq_in_index SEPARATOR '|'),256)='65be6abd0ca29bb9bc294b0acdaa3c295ab83112f259d82c467063ac10383eb5'
     FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_source_accounting_entries','tenant_telemetry_source_accounting_receipts'))
  AND (SELECT COUNT(*)=2 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',constraint_name,LOWER(REPLACE(REPLACE(REGEXP_REPLACE(check_clause,'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY constraint_name SEPARATOR '|'),256)='8dec74f4b49a66651c97b001492a785f863f0b3e461a2135396de8cc7da25ef0'
     FROM information_schema.check_constraints WHERE constraint_schema=DATABASE() AND constraint_name IN ('chk_tt_source_accounting_entry_shape','chk_tt_source_accounting_receipt_shape'))
  AND (SELECT COUNT(*)=9 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,constraint_type) ORDER BY table_name,constraint_name SEPARATOR '|'),256)='5c099fa8d53ea19added6b911e6b11c0e1fec2b2f85af5e099f8f8666ea3e4ef'
     FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_source_accounting_entries','tenant_telemetry_source_accounting_receipts'))
  AND (SELECT COUNT(*)=3 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,referenced_table_name,update_rule,delete_rule) ORDER BY table_name,constraint_name SEPARATOR '|'),256)='76e94654859d75f88117a234e04cf8b64bd05f6acb02798e35f0fac321dfee2b'
     FROM information_schema.referential_constraints WHERE constraint_schema=DATABASE() AND table_name IN ('tenant_telemetry_source_accounting_entries','tenant_telemetry_source_accounting_receipts'))
  AND (SELECT COUNT(*)=3 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,LPAD(ordinal_position,3,'0'),column_name,referenced_table_name,referenced_column_name) ORDER BY table_name,constraint_name,ordinal_position SEPARATOR '|'),256)='7a09d9d552f857c51567a036b4ce3c732ee12fca606c0331914d5f3ae2f696ca'
     FROM information_schema.key_column_usage WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_source_accounting_entries','tenant_telemetry_source_accounting_receipts') AND referenced_table_name IS NOT NULL)
  AND (SELECT COUNT(*)=0 FROM information_schema.partitions WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_source_accounting_entries','tenant_telemetry_source_accounting_receipts') AND partition_name IS NOT NULL)
);
-- agent-service-runtime-fingerprint:tenant-telemetry-source-accounting-schema:end
SET @migration_sql=IF(@tt_source_accounting_schema_ok=1,'SELECT 1','SELECT 1 FROM __invalid_tenant_telemetry_source_accounting_schema__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- 0039 95-trigger family plus six append-only source guards and two additive T3d guards.
-- agent-service-runtime-fingerprint:tenant-telemetry-source-accounting-triggers:start
SET @tt_source_accounting_triggers_ok=(
  SELECT COUNT(*)=103 AND COUNT(DISTINCT trigger_name)=103 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',event_object_table,trigger_name,action_timing,event_manipulation,action_orientation,IFNULL(action_condition,'<NULL>'),LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY event_object_table,trigger_name SEPARATOR '|'),256)='316ee5ab7837d820c3d415839ad87571c80eeb9ea765db593f7a7787412fe79c'
  FROM information_schema.triggers WHERE trigger_schema=DATABASE()
    AND (event_object_table IN ('sessions','subject_lifecycle','tenant_telemetry_lifecycle_control','tenant_telemetry_lifecycle_targets','tenant_telemetry_lifecycle_coverages','tenant_telemetry_lifecycle_subjects','tenant_telemetry_activation_receipts','tenant_telemetry_artifact_inventory','tenant_telemetry_write_jobs','tenant_telemetry_write_payloads','tenant_telemetry_write_acks','tenant_telemetry_application_domain_controls','tenant_telemetry_application_activation_receipts','tenant_telemetry_application_coverages','tenant_telemetry_application_write_bindings','tenant_telemetry_disposition_control','tenant_telemetry_disposition_activation_receipts','tenant_telemetry_disposition_jobs','tenant_telemetry_disposition_authorization_grants','tenant_telemetry_disposition_external_authorizations','tenant_telemetry_disposition_external_events','tenant_telemetry_disposition_tombstone_acks','tenant_telemetry_disposition_receipts','tenant_telemetry_disposition_replay_fences','tenant_telemetry_artifact_memberships','tenant_telemetry_owner_closure_entries','tenant_telemetry_owner_closure_receipts','tenant_telemetry_source_accounting_entries','tenant_telemetry_source_accounting_receipts') OR (event_object_table='tenant_credential_revocation_jobs' AND action_timing='BEFORE' AND event_manipulation='INSERT') OR (event_object_table='tenant_database_purge_jobs' AND BINARY trigger_name=BINARY 'trg_tt_owner_closure_t3f_terminal_bu') OR (event_object_table='tenant_purge_plan_jobs' AND BINARY trigger_name=BINARY 'trg_tt_source_accounting_t3d_terminal_bu'))
);
-- agent-service-runtime-fingerprint:tenant-telemetry-source-accounting-triggers:end
SET @migration_sql=IF(@tt_source_accounting_triggers_ok=1,'SELECT 1','SELECT 1 FROM __invalid_tenant_telemetry_source_accounting_triggers__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
SET SESSION group_concat_max_len=@tt_source_accounting_previous_group_concat_max_len;

-- Marker-loss replay cannot launder a committed partial source projection. A transaction may
-- temporarily contain entries before its aggregate, but no such state may be committed.
SET @tt_source_accounting_projection_ok=(
  NOT EXISTS (SELECT 1 FROM tenant_telemetry_source_accounting_entries e
    LEFT JOIN tenant_telemetry_source_accounting_receipts r ON BINARY r.request_id=BINARY e.request_id AND BINARY r.tenant_id=BINARY e.tenant_id
    LEFT JOIN tenant_purge_plan_jobs j ON BINARY j.request_id=BINARY e.request_id AND BINARY j.tenant_id=BINARY e.tenant_id
    WHERE r.request_id IS NULL OR j.request_id IS NULL OR j.phase<>'plan_sealed'
      OR BINARY j.aggregate_receipt_sha256<>BINARY r.plan_receipt_sha256)
  AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_source_accounting_receipts r
    LEFT JOIN tenant_purge_plan_jobs j ON BINARY j.request_id=BINARY r.request_id AND BINARY j.tenant_id=BINARY r.tenant_id
    WHERE j.request_id IS NULL OR j.phase<>'plan_sealed'
      OR BINARY j.aggregate_receipt_sha256<>BINARY r.plan_receipt_sha256)
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_jobs)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_authorization_grants)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_external_authorizations)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_external_events)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_tombstone_acks)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_receipts)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_replay_fences)=0
);
SET @migration_sql=IF(@tt_source_accounting_projection_ok=1,'SELECT 1','SELECT 1 FROM __invalid_tenant_telemetry_source_accounting_projection__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
