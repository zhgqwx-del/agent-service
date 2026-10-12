-- 0041: immutable per-artifact observed target manifest at the T3d seal boundary.
-- Drain every pre-0041 T3d writer before applying this default-dormant migration.
-- No historical terminal backfill, sink operation, delete grant, or completion occurs.
-- An observed target is evidence of a prior managed write, NOT an executable T3d target.

CREATE TABLE IF NOT EXISTS tenant_telemetry_target_manifest_entries (
  scope VARCHAR(72) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_id VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation BIGINT UNSIGNED NOT NULL,
  build_generation BIGINT UNSIGNED NOT NULL,
  source_kind VARCHAR(24) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_identity_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  domain VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  artifact_group_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  inventory_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  write_operation_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  artifact_id_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  artifact_generation BIGINT UNSIGNED NULL,
  observed_target_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  owner_kind VARCHAR(16) COLLATE utf8mb4_0900_as_cs NULL,
  owner_ref_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  hold_subject_ref_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  owner_binding_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  live_owner_claim_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  classification VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  group_source_count BIGINT UNSIGNED NOT NULL,
  group_source_root_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  group_observed_target_count TINYINT UNSIGNED NOT NULL,
  group_observed_target_root_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  captured_at_db_ms BIGINT NOT NULL,
  receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (request_id,source_kind,source_identity_sha256),
  UNIQUE KEY uk_tt_target_manifest_entry_hash (receipt_sha256),
  KEY idx_tt_target_manifest_entry_tenant (tenant_id,request_id,source_kind),
  KEY idx_tt_target_manifest_entry_group (request_id,artifact_group_sha256),
  KEY idx_tt_target_manifest_entry_operation (write_operation_sha256),
  CONSTRAINT fk_tt_target_manifest_entry_job FOREIGN KEY (request_id)
    REFERENCES tenant_purge_plan_jobs (request_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tt_target_manifest_entry_source FOREIGN KEY (source_receipt_sha256)
    REFERENCES tenant_telemetry_source_accounting_entries (receipt_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tt_target_manifest_entry_shape CHECK (
    scope='tenant-telemetry-target-manifest-entry-v1'
    AND CHAR_LENGTH(tenant_id) BETWEEN 1 AND 128
    AND subject_generation>0 AND build_generation>0
    AND source_kind IN ('inventory','write_job','write_ack','membership','application_binding')
    AND source_identity_sha256 REGEXP '^[0-9a-f]{64}$'
    AND source_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND domain IN ('logs','traces')
    AND artifact_group_sha256 REGEXP '^[0-9a-f]{64}$'
    AND (inventory_sha256 IS NULL OR inventory_sha256 REGEXP '^[0-9a-f]{64}$')
    AND (write_operation_sha256 IS NULL
      OR write_operation_sha256 REGEXP '^[0-9a-f]{64}$')
    AND (artifact_id_sha256 IS NULL OR artifact_id_sha256 REGEXP '^[0-9a-f]{64}$')
    AND (artifact_generation IS NULL OR artifact_generation>0)
    AND (observed_target_sha256 IS NULL
      OR observed_target_sha256 REGEXP '^[0-9a-f]{64}$')
    AND (owner_ref_sha256 IS NULL OR owner_ref_sha256 REGEXP '^[0-9a-f]{64}$')
    AND (hold_subject_ref_sha256 IS NULL
      OR hold_subject_ref_sha256 REGEXP '^[0-9a-f]{64}$')
    AND (owner_binding_sha256 IS NULL OR owner_binding_sha256 REGEXP '^[0-9a-f]{64}$')
    AND (live_owner_claim_sha256 IS NULL
      OR live_owner_claim_sha256 REGEXP '^[0-9a-f]{64}$')
    AND classification IN ('accounted','unknown')
    AND group_source_count>0 AND group_source_root_sha256 REGEXP '^[0-9a-f]{64}$'
    AND group_observed_target_count IN (0,1)
    AND group_observed_target_root_sha256 REGEXP '^[0-9a-f]{64}$'
    AND captured_at_db_ms>=0 AND receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND ((classification='accounted' AND observed_target_sha256 IS NOT NULL
      AND group_observed_target_count=1)
      OR (classification='unknown' AND observed_target_sha256 IS NULL
        AND group_observed_target_count=0))
    AND ((inventory_sha256 IS NULL AND artifact_id_sha256 IS NULL
      AND artifact_generation IS NULL AND observed_target_sha256 IS NULL
      AND owner_kind IS NULL AND owner_ref_sha256 IS NULL
      AND hold_subject_ref_sha256 IS NULL AND owner_binding_sha256 IS NULL
      AND live_owner_claim_sha256 IS NULL)
      OR (inventory_sha256 IS NOT NULL AND artifact_id_sha256 IS NOT NULL
        AND artifact_generation IS NOT NULL))
    AND ((owner_kind IS NULL AND owner_ref_sha256 IS NULL
      AND hold_subject_ref_sha256 IS NULL AND owner_binding_sha256 IS NULL
      AND live_owner_claim_sha256 IS NULL)
      OR (owner_kind IS NOT NULL AND owner_kind IN ('tenant','user','session')
        AND owner_ref_sha256 IS NOT NULL AND hold_subject_ref_sha256 IS NOT NULL
        AND owner_binding_sha256 IS NOT NULL AND live_owner_claim_sha256 IS NOT NULL))
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT scope,request_id,tenant_id,subject_generation,build_generation,source_kind,
       source_identity_sha256,source_receipt_sha256,domain,artifact_group_sha256,
       inventory_sha256,write_operation_sha256,artifact_id_sha256,artifact_generation,
       observed_target_sha256,owner_kind,owner_ref_sha256,hold_subject_ref_sha256,
       owner_binding_sha256,live_owner_claim_sha256,classification,group_source_count,
       group_source_root_sha256,group_observed_target_count,
       group_observed_target_root_sha256,captured_at_db_ms,receipt_sha256
  FROM tenant_telemetry_target_manifest_entries FORCE INDEX (
    PRIMARY,uk_tt_target_manifest_entry_hash,idx_tt_target_manifest_entry_tenant,
    idx_tt_target_manifest_entry_group,idx_tt_target_manifest_entry_operation
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_telemetry_target_manifest_receipts (
  scope VARCHAR(72) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_id VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation BIGINT UNSIGNED NOT NULL,
  build_generation BIGINT UNSIGNED NOT NULL,
  plan_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_accounting_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  entry_count BIGINT UNSIGNED NOT NULL,
  entry_root_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  artifact_group_count BIGINT UNSIGNED NOT NULL,
  artifact_group_root_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  observed_target_count BIGINT UNSIGNED NOT NULL,
  observed_target_root_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  unknown_group_count BIGINT UNSIGNED NOT NULL,
  unknown_group_root_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  store_db_timestamp_ms BIGINT NOT NULL,
  completed_claim_attempt INT UNSIGNED NOT NULL,
  completed_claim_token_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (request_id),
  UNIQUE KEY uk_tt_target_manifest_receipt_hash (receipt_sha256),
  KEY idx_tt_target_manifest_receipt_tenant (tenant_id,request_id),
  KEY idx_tt_target_manifest_receipt_plan (plan_receipt_sha256),
  KEY idx_tt_target_manifest_receipt_source (source_accounting_receipt_sha256),
  CONSTRAINT fk_tt_target_manifest_receipt_job FOREIGN KEY (request_id)
    REFERENCES tenant_purge_plan_jobs (request_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tt_target_manifest_receipt_plan FOREIGN KEY (plan_receipt_sha256)
    REFERENCES tenant_purge_plan_receipts (receipt_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tt_target_manifest_receipt_source FOREIGN KEY (source_accounting_receipt_sha256)
    REFERENCES tenant_telemetry_source_accounting_receipts (receipt_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tt_target_manifest_receipt_shape CHECK (
    scope='tenant-telemetry-target-manifest-receipt-v1'
    AND CHAR_LENGTH(tenant_id) BETWEEN 1 AND 128
    AND subject_generation>0 AND build_generation>0
    AND plan_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND source_accounting_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND entry_root_sha256 REGEXP '^[0-9a-f]{64}$'
    AND artifact_group_root_sha256 REGEXP '^[0-9a-f]{64}$'
    AND observed_target_root_sha256 REGEXP '^[0-9a-f]{64}$'
    AND unknown_group_root_sha256 REGEXP '^[0-9a-f]{64}$'
    AND artifact_group_count<=entry_count
    AND observed_target_count+unknown_group_count=artifact_group_count
    AND store_db_timestamp_ms>=0 AND completed_claim_attempt>0
    AND completed_claim_token_sha256 REGEXP '^[0-9a-f]{64}$'
    AND receipt_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT scope,request_id,tenant_id,subject_generation,build_generation,
       plan_receipt_sha256,source_accounting_receipt_sha256,entry_count,
       entry_root_sha256,artifact_group_count,artifact_group_root_sha256,
       observed_target_count,observed_target_root_sha256,unknown_group_count,
       unknown_group_root_sha256,store_db_timestamp_ms,completed_claim_attempt,
       completed_claim_token_sha256,receipt_sha256
  FROM tenant_telemetry_target_manifest_receipts FORCE INDEX (
    PRIMARY,uk_tt_target_manifest_receipt_hash,idx_tt_target_manifest_receipt_tenant,
    idx_tt_target_manifest_receipt_plan,idx_tt_target_manifest_receipt_source
  ) WHERE 1=0;

CREATE TRIGGER trg_tt_target_manifest_entry_bi BEFORE INSERT ON tenant_telemetry_target_manifest_entries FOR EACH ROW BEGIN IF (
  EXISTS (SELECT 1 FROM tenant_purge_plan_jobs j WHERE BINARY j.request_id=BINARY NEW.request_id AND BINARY j.tenant_id=BINARY NEW.tenant_id AND j.subject_generation=NEW.subject_generation AND j.build_generation=NEW.build_generation AND j.phase='queued')
  AND EXISTS (SELECT 1 FROM tenant_purge_plan_receipts p WHERE BINARY p.request_id=BINARY NEW.request_id AND BINARY p.tenant_id=BINARY NEW.tenant_id AND p.subject_generation=NEW.subject_generation AND p.build_generation=NEW.build_generation AND p.store_db_timestamp_ms<=NEW.captured_at_db_ms)
  AND EXISTS (SELECT 1 FROM tenant_telemetry_source_accounting_entries s WHERE BINARY s.request_id=BINARY NEW.request_id AND BINARY s.tenant_id=BINARY NEW.tenant_id AND s.subject_generation=NEW.subject_generation AND s.build_generation=NEW.build_generation AND BINARY s.source_kind=BINARY NEW.source_kind AND BINARY s.source_identity_sha256=BINARY NEW.source_identity_sha256 AND BINARY s.receipt_sha256=BINARY NEW.source_receipt_sha256 AND BINARY s.domain=BINARY NEW.domain AND s.captured_at_db_ms=NEW.captured_at_db_ms AND (BINARY s.write_operation_sha256 <=> BINARY NEW.write_operation_sha256) AND (s.classification='accounted' OR NEW.classification='unknown'))
  AND (NEW.inventory_sha256 IS NULL OR EXISTS (SELECT 1 FROM tenant_telemetry_artifact_inventory i WHERE BINARY i.inventory_sha256=BINARY NEW.inventory_sha256 AND BINARY i.tenant_id=BINARY NEW.tenant_id AND BINARY i.domain=BINARY NEW.domain AND BINARY i.artifact_id_sha256=BINARY NEW.artifact_id_sha256 AND i.artifact_generation=NEW.artifact_generation AND (NEW.observed_target_sha256 IS NULL OR BINARY i.target_sha256=BINARY NEW.observed_target_sha256)))
  AND (NEW.classification='unknown' OR EXISTS (SELECT 1 FROM tenant_telemetry_artifact_memberships m WHERE BINARY m.write_operation_sha256=BINARY NEW.write_operation_sha256 AND BINARY m.tenant_id=BINARY NEW.tenant_id AND BINARY m.domain=BINARY NEW.domain AND BINARY m.inventory_sha256=BINARY NEW.inventory_sha256 AND BINARY m.target_sha256=BINARY NEW.observed_target_sha256 AND BINARY m.owner_kind=BINARY NEW.owner_kind AND BINARY m.owner_ref_sha256=BINARY NEW.owner_ref_sha256 AND BINARY m.hold_subject_ref_sha256=BINARY NEW.hold_subject_ref_sha256 AND BINARY m.owner_binding_sha256=BINARY NEW.owner_binding_sha256))
) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry target entry lacks exact T3d/0040 source'; END IF; END;

CREATE TRIGGER trg_tt_target_manifest_entry_bu BEFORE UPDATE ON tenant_telemetry_target_manifest_entries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry target entry is immutable';
CREATE TRIGGER trg_tt_target_manifest_entry_bd BEFORE DELETE ON tenant_telemetry_target_manifest_entries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry target entry is append-only';

CREATE TRIGGER trg_tt_target_manifest_receipt_bi BEFORE INSERT ON tenant_telemetry_target_manifest_receipts FOR EACH ROW BEGIN IF (
  EXISTS (SELECT 1 FROM tenant_purge_plan_jobs j WHERE BINARY j.request_id=BINARY NEW.request_id AND BINARY j.tenant_id=BINARY NEW.tenant_id AND j.subject_generation=NEW.subject_generation AND j.build_generation=NEW.build_generation AND j.phase='queued')
  AND EXISTS (SELECT 1 FROM tenant_purge_plan_receipts p WHERE BINARY p.request_id=BINARY NEW.request_id AND BINARY p.tenant_id=BINARY NEW.tenant_id AND p.subject_generation=NEW.subject_generation AND p.build_generation=NEW.build_generation AND BINARY p.receipt_sha256=BINARY NEW.plan_receipt_sha256 AND p.store_db_timestamp_ms<=NEW.store_db_timestamp_ms AND p.completed_claim_attempt=NEW.completed_claim_attempt AND BINARY p.completed_claim_token_sha256=BINARY NEW.completed_claim_token_sha256)
  AND EXISTS (SELECT 1 FROM tenant_telemetry_source_accounting_receipts s WHERE BINARY s.request_id=BINARY NEW.request_id AND BINARY s.tenant_id=BINARY NEW.tenant_id AND s.subject_generation=NEW.subject_generation AND s.build_generation=NEW.build_generation AND BINARY s.receipt_sha256=BINARY NEW.source_accounting_receipt_sha256 AND BINARY s.plan_receipt_sha256=BINARY NEW.plan_receipt_sha256 AND s.entry_count=NEW.entry_count AND s.store_db_timestamp_ms=NEW.store_db_timestamp_ms AND s.completed_claim_attempt=NEW.completed_claim_attempt AND BINARY s.completed_claim_token_sha256=BINARY NEW.completed_claim_token_sha256)
  AND (SELECT COUNT(*) FROM tenant_telemetry_target_manifest_entries e WHERE BINARY e.request_id=BINARY NEW.request_id AND BINARY e.tenant_id=BINARY NEW.tenant_id)=NEW.entry_count
  AND (SELECT COUNT(*) FROM tenant_telemetry_source_accounting_entries s WHERE BINARY s.request_id=BINARY NEW.request_id AND BINARY s.tenant_id=BINARY NEW.tenant_id)=NEW.entry_count
  AND (SELECT COUNT(DISTINCT e.artifact_group_sha256) FROM tenant_telemetry_target_manifest_entries e WHERE BINARY e.request_id=BINARY NEW.request_id AND BINARY e.tenant_id=BINARY NEW.tenant_id)=NEW.artifact_group_count
  AND (SELECT COUNT(DISTINCT CASE WHEN e.classification='accounted' THEN e.artifact_group_sha256 END) FROM tenant_telemetry_target_manifest_entries e WHERE BINARY e.request_id=BINARY NEW.request_id AND BINARY e.tenant_id=BINARY NEW.tenant_id)=NEW.observed_target_count
  AND (SELECT COUNT(DISTINCT CASE WHEN e.classification='unknown' THEN e.artifact_group_sha256 END) FROM tenant_telemetry_target_manifest_entries e WHERE BINARY e.request_id=BINARY NEW.request_id AND BINARY e.tenant_id=BINARY NEW.tenant_id)=NEW.unknown_group_count
  AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_target_manifest_entries e WHERE BINARY e.request_id=BINARY NEW.request_id AND BINARY e.tenant_id=BINARY NEW.tenant_id GROUP BY e.artifact_group_sha256 HAVING COUNT(*)<>MIN(e.group_source_count) OR COUNT(*)<>MAX(e.group_source_count) OR MIN(e.classification)<>MAX(e.classification) OR MIN(e.group_observed_target_count)<>MAX(e.group_observed_target_count) OR COUNT(DISTINCT IFNULL(e.observed_target_sha256,'<NULL>'))<>1 OR COUNT(DISTINCT e.group_source_root_sha256)<>1 OR COUNT(DISTINCT e.group_observed_target_root_sha256)<>1)
) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry target receipt lacks complete exact source'; END IF; END;

CREATE TRIGGER trg_tt_target_manifest_receipt_bu BEFORE UPDATE ON tenant_telemetry_target_manifest_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry target receipt is immutable';
CREATE TRIGGER trg_tt_target_manifest_receipt_bd BEFORE DELETE ON tenant_telemetry_target_manifest_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry target receipt is append-only';

-- Both the 0040 receipt and this manifest must be committed before a new T3d terminal.
-- Historical terminal plans do not transition again and remain unknown if missing 0041.
CREATE TRIGGER trg_tt_target_manifest_t3d_terminal_bu BEFORE UPDATE ON tenant_purge_plan_jobs FOR EACH ROW BEGIN IF OLD.phase='queued' AND NEW.phase='plan_sealed' AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_target_manifest_receipts r JOIN tenant_telemetry_source_accounting_receipts s ON BINARY s.receipt_sha256=BINARY r.source_accounting_receipt_sha256 WHERE BINARY r.request_id=BINARY NEW.request_id AND BINARY r.tenant_id=BINARY NEW.tenant_id AND r.subject_generation=NEW.subject_generation AND r.build_generation=NEW.build_generation AND BINARY r.plan_receipt_sha256=BINARY NEW.aggregate_receipt_sha256 AND BINARY s.plan_receipt_sha256=BINARY NEW.aggregate_receipt_sha256 AND r.store_db_timestamp_ms>=NEW.sealed_at_ms AND r.store_db_timestamp_ms<=NEW.updated_at_ms AND r.completed_claim_attempt=NEW.completed_claim_attempt AND BINARY r.completed_claim_token_sha256=BINARY NEW.completed_claim_token_sha256 AND (SELECT COUNT(*) FROM tenant_telemetry_target_manifest_entries e WHERE BINARY e.request_id=BINARY r.request_id AND BINARY e.tenant_id=BINARY r.tenant_id)=r.entry_count AND (SELECT COUNT(*) FROM tenant_telemetry_source_accounting_entries e WHERE BINARY e.request_id=BINARY r.request_id AND BINARY e.tenant_id=BINARY r.tenant_id)=r.entry_count) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='terminal T3d lacks immutable telemetry target manifest'; END IF; END;

-- Included in the published 0040 trigger family so pre-0041 binaries fail startup closed.
CREATE TRIGGER trg_tt_target_manifest_source_receipt_bu BEFORE UPDATE ON tenant_telemetry_source_accounting_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry source receipt is immutable';

SET @tt_target_manifest_previous_group_concat_max_len=@@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len=1048576;
-- agent-service-runtime-fingerprint:tenant-telemetry-target-manifest-schema:start
SET @tt_target_manifest_schema_ok=(
  (SELECT COUNT(*)=2 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,table_type,IFNULL(engine,'-'),IFNULL(table_collation,'-')) ORDER BY table_name SEPARATOR '|'),256)='416b7cfcc08e3ba33f4c381690b520a82cbdfc7a53210d6fe852f91ea095a993'
     FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_target_manifest_entries','tenant_telemetry_target_manifest_receipts'))
  AND (SELECT COUNT(*)=46 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,LPAD(ordinal_position,3,'0'),column_name,LOWER(column_type),is_nullable,IF(column_default IS NULL,'<NULL>',CONCAT('<',column_default,'>')),IFNULL(character_set_name,'-'),IFNULL(extra,'-'),IFNULL(generation_expression,'-')) ORDER BY table_name,ordinal_position SEPARATOR '|'),256)='3ebb7843fcb2ff993685ca73480231b26bbf1d190bc73c30198dd55c25dfeedc'
     FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_target_manifest_entries','tenant_telemetry_target_manifest_receipts'))
  AND (SELECT COUNT(*)=17 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,index_name,LPAD(seq_in_index,3,'0'),column_name,non_unique,index_type,IFNULL(collation,'-'),IFNULL(sub_part,'-'),IFNULL(nullable,'-')) ORDER BY table_name,index_name,seq_in_index SEPARATOR '|'),256)='1bd21a0d234f06067b6958ba798adfcd56df25a40c07ecff6db51f23569f254f'
     FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_target_manifest_entries','tenant_telemetry_target_manifest_receipts'))
  AND (SELECT COUNT(*)=2 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',constraint_name,LOWER(REPLACE(REPLACE(REGEXP_REPLACE(check_clause,'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY constraint_name SEPARATOR '|'),256)='9822c1d7b63163a1d4ed4d83cc89f7917e3076ed306fca7acc16617c7a44bc5d'
     FROM information_schema.check_constraints WHERE constraint_schema=DATABASE() AND constraint_name IN ('chk_tt_target_manifest_entry_shape','chk_tt_target_manifest_receipt_shape'))
  AND (SELECT COUNT(*)=11 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,constraint_type) ORDER BY table_name,constraint_name SEPARATOR '|'),256)='b407405e8534b9f860967f9dd2bf2c974468ef1d7ad6e5955ec98aed58e55e88'
     FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_target_manifest_entries','tenant_telemetry_target_manifest_receipts'))
  AND (SELECT COUNT(*)=5 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,referenced_table_name,update_rule,delete_rule) ORDER BY table_name,constraint_name SEPARATOR '|'),256)='d63d16101cd71cd485a36704c6774764bbb9a07763e836a647af5a9a70c97c99'
     FROM information_schema.referential_constraints WHERE constraint_schema=DATABASE() AND table_name IN ('tenant_telemetry_target_manifest_entries','tenant_telemetry_target_manifest_receipts'))
  AND (SELECT COUNT(*)=5 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,LPAD(ordinal_position,3,'0'),column_name,referenced_table_name,referenced_column_name) ORDER BY table_name,constraint_name,ordinal_position SEPARATOR '|'),256)='1e3d716009055569802e4d98f2b615a00e28a69be45eb2d8e0f3e535b45ff898'
     FROM information_schema.key_column_usage WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_target_manifest_entries','tenant_telemetry_target_manifest_receipts') AND referenced_table_name IS NOT NULL)
  AND (SELECT COUNT(*)=0 FROM information_schema.partitions WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_target_manifest_entries','tenant_telemetry_target_manifest_receipts') AND partition_name IS NOT NULL)
);
-- agent-service-runtime-fingerprint:tenant-telemetry-target-manifest-schema:end
SET @migration_sql=IF(@tt_target_manifest_schema_ok=1,'SELECT 1','SELECT 1 FROM __invalid_tenant_telemetry_target_manifest_schema__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- Published 0040 103-trigger family plus six append-only guards, T3d terminal guard,
-- and source-receipt startup tripwire.
-- agent-service-runtime-fingerprint:tenant-telemetry-target-manifest-triggers:start
SET @tt_target_manifest_triggers_ok=(
  SELECT COUNT(*)=111 AND COUNT(DISTINCT trigger_name)=111 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',event_object_table,trigger_name,action_timing,event_manipulation,action_orientation,IFNULL(action_condition,'<NULL>'),LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY event_object_table,trigger_name SEPARATOR '|'),256)='dd20856fcc70447e2c5bfcfa3e45eb1c0889aa841c134152eef6fadd2e6507b3'
  FROM information_schema.triggers WHERE trigger_schema=DATABASE()
    AND (event_object_table IN ('sessions','subject_lifecycle','tenant_telemetry_lifecycle_control','tenant_telemetry_lifecycle_targets','tenant_telemetry_lifecycle_coverages','tenant_telemetry_lifecycle_subjects','tenant_telemetry_activation_receipts','tenant_telemetry_artifact_inventory','tenant_telemetry_write_jobs','tenant_telemetry_write_payloads','tenant_telemetry_write_acks','tenant_telemetry_application_domain_controls','tenant_telemetry_application_activation_receipts','tenant_telemetry_application_coverages','tenant_telemetry_application_write_bindings','tenant_telemetry_disposition_control','tenant_telemetry_disposition_activation_receipts','tenant_telemetry_disposition_jobs','tenant_telemetry_disposition_authorization_grants','tenant_telemetry_disposition_external_authorizations','tenant_telemetry_disposition_external_events','tenant_telemetry_disposition_tombstone_acks','tenant_telemetry_disposition_receipts','tenant_telemetry_disposition_replay_fences','tenant_telemetry_artifact_memberships','tenant_telemetry_owner_closure_entries','tenant_telemetry_owner_closure_receipts','tenant_telemetry_source_accounting_entries','tenant_telemetry_source_accounting_receipts','tenant_telemetry_target_manifest_entries','tenant_telemetry_target_manifest_receipts') OR (event_object_table='tenant_credential_revocation_jobs' AND action_timing='BEFORE' AND event_manipulation='INSERT') OR (event_object_table='tenant_database_purge_jobs' AND BINARY trigger_name=BINARY 'trg_tt_owner_closure_t3f_terminal_bu') OR (event_object_table='tenant_purge_plan_jobs' AND BINARY trigger_name IN (BINARY 'trg_tt_source_accounting_t3d_terminal_bu',BINARY 'trg_tt_target_manifest_t3d_terminal_bu')))
);
-- agent-service-runtime-fingerprint:tenant-telemetry-target-manifest-triggers:end
SET @migration_sql=IF(@tt_target_manifest_triggers_ok=1,'SELECT 1','SELECT 1 FROM __invalid_tenant_telemetry_target_manifest_triggers__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
SET SESSION group_concat_max_len=@tt_target_manifest_previous_group_concat_max_len;

-- Marker-loss replay cannot launder a committed partial projection. Older terminal plans
-- with no 0041 sidecar remain unknown and are intentionally not synthesized.
SET @tt_target_manifest_projection_ok=(
  NOT EXISTS (SELECT 1 FROM tenant_telemetry_target_manifest_entries e
    LEFT JOIN tenant_telemetry_target_manifest_receipts r ON BINARY r.request_id=BINARY e.request_id AND BINARY r.tenant_id=BINARY e.tenant_id
    LEFT JOIN tenant_purge_plan_jobs j ON BINARY j.request_id=BINARY e.request_id AND BINARY j.tenant_id=BINARY e.tenant_id
    WHERE r.request_id IS NULL OR j.request_id IS NULL OR j.phase<>'plan_sealed'
      OR BINARY j.aggregate_receipt_sha256<>BINARY r.plan_receipt_sha256)
  AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_target_manifest_receipts r
    LEFT JOIN tenant_telemetry_source_accounting_receipts s ON BINARY s.receipt_sha256=BINARY r.source_accounting_receipt_sha256
    LEFT JOIN tenant_purge_plan_jobs j ON BINARY j.request_id=BINARY r.request_id AND BINARY j.tenant_id=BINARY r.tenant_id
    WHERE s.request_id IS NULL OR j.request_id IS NULL OR j.phase<>'plan_sealed'
      OR BINARY j.aggregate_receipt_sha256<>BINARY r.plan_receipt_sha256)
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_jobs)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_authorization_grants)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_external_authorizations)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_external_events)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_tombstone_acks)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_receipts)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_replay_fences)=0
);
SET @migration_sql=IF(@tt_target_manifest_projection_ok=1,'SELECT 1','SELECT 1 FROM __invalid_tenant_telemetry_target_manifest_projection__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
