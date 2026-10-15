-- 0055: additive, dormant original-primary capture checkpoint for a stopped-fleet
-- full MySQL logical backup. This is not restore activation, external ACK, or
-- permission to execute 0037 disposal/0054 erasure. No historical row is filled.
CREATE TABLE tenant_telemetry_capture_backup_checkpoints (
  backup_id VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  anchor_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  checkpoint_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  ref_key_id_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  sealed_at_db_ms BIGINT UNSIGNED NOT NULL,
  checkpoint_json JSON NOT NULL,
  PRIMARY KEY (backup_id),
  UNIQUE KEY uk_tt_capture_checkpoint_digest (checkpoint_sha256),
  CONSTRAINT fk_tt_capture_checkpoint_anchor FOREIGN KEY (backup_id)
    REFERENCES backup_snapshot_anchors(backup_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tt_capture_checkpoint_shape CHECK (
    backup_id REGEXP '^backup_[0-9a-f-]{36}$'
    AND anchor_sha256 REGEXP '^[0-9a-f]{64}$'
    AND checkpoint_sha256 REGEXP '^[0-9a-f]{64}$'
    AND ref_key_id_sha256 REGEXP '^[0-9a-f]{64}$'
    AND JSON_TYPE(checkpoint_json)='OBJECT'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE tenant_telemetry_capture_backup_checkpoint_leaves (
  backup_id VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  family VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  identity_ref_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  record_hmac_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  knowledge VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  state VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_high_water_db_ms BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (backup_id,family,identity_ref_sha256),
  KEY idx_tt_capture_checkpoint_leaf_family (family,backup_id),
  CONSTRAINT fk_tt_capture_checkpoint_leaf_header FOREIGN KEY (backup_id)
    REFERENCES tenant_telemetry_capture_backup_checkpoints(backup_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tt_capture_checkpoint_leaf_shape CHECK (
    family REGEXP '^[a-z][a-z0-9_]{0,63}$'
    AND identity_ref_sha256 REGEXP '^[0-9a-f]{64}$'
    AND record_hmac_sha256 REGEXP '^[0-9a-f]{64}$'
    AND knowledge IN ('validated_projection','legacy_unknown')
    AND state IN ('record','inactive','active','queued','reserved','written','blocked','spooled','legacy_unknown')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- New v2 selections bind an actual checkpoint to the unchanged 0031 binding,
-- 0031 external reservation and 0030 run in the SAME prepare transaction.
-- Published v1 receipt bodies, hashes and NULL-era restore semantics are not
-- reinterpreted or backfilled. This sidecar has no activation authority.
CREATE TABLE tenant_telemetry_capture_restore_bindings (
  restore_run_id VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  backup_id VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  checkpoint_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  artifact_manifest_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_snapshot_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  provider_evidence_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_binding_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  reservation_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  reservation_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  bound_at_db_ms BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (restore_run_id),
  KEY idx_tt_capture_restore_backup (backup_id),
  CONSTRAINT fk_tt_capture_restore_run FOREIGN KEY (restore_run_id)
    REFERENCES tenant_restore_replay_runs(restore_run_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tt_capture_restore_checkpoint FOREIGN KEY (backup_id)
    REFERENCES tenant_telemetry_capture_backup_checkpoints(backup_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tt_capture_restore_binding_shape CHECK (
    restore_run_id REGEXP '^restore_[0-9a-f-]{36}$'
    AND backup_id REGEXP '^backup_[0-9a-f-]{36}$'
    AND checkpoint_sha256 REGEXP '^[0-9a-f]{64}$'
    AND artifact_manifest_sha256 REGEXP '^[0-9a-f]{64}$'
    AND source_snapshot_sha256 REGEXP '^[0-9a-f]{64}$'
    AND provider_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
    AND source_binding_sha256 REGEXP '^[0-9a-f]{64}$'
    AND reservation_sha256 REGEXP '^[0-9a-f]{64}$'
    AND reservation_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_tt_capture_checkpoint_header_immutable_update BEFORE UPDATE ON tenant_telemetry_capture_backup_checkpoints FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture checkpoint is immutable'; END;
CREATE TRIGGER trg_tt_capture_checkpoint_header_immutable_delete BEFORE DELETE ON tenant_telemetry_capture_backup_checkpoints FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture checkpoint is immutable'; END;
CREATE TRIGGER trg_tt_capture_checkpoint_leaf_immutable_update BEFORE UPDATE ON tenant_telemetry_capture_backup_checkpoint_leaves FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture checkpoint leaf is immutable'; END;
CREATE TRIGGER trg_tt_capture_checkpoint_leaf_immutable_delete BEFORE DELETE ON tenant_telemetry_capture_backup_checkpoint_leaves FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture checkpoint leaf is immutable'; END;
CREATE TRIGGER trg_tt_capture_restore_binding_immutable_update BEFORE UPDATE ON tenant_telemetry_capture_restore_bindings FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture restore binding is immutable'; END;
CREATE TRIGGER trg_tt_capture_restore_binding_immutable_delete BEFORE DELETE ON tenant_telemetry_capture_restore_bindings FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture restore binding is immutable'; END;

-- Independently derived on a fresh isolated MySQL 8.0.26 database after the
-- exact 49-marker 0054 baseline. All 718 guards and 3 new tables were observed;
-- calibration wrote no 0055 marker. Runtime rejects uncommitted zero roots.
SET @tt_capture_checkpoint_migration_previous_gcml=@@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len=1048576;
-- agent-service-runtime-fingerprint:tenant-telemetry-capture-backup-checkpoint-schema:start
SET @tt_capture_checkpoint_schema_ok=(
  (SELECT COUNT(*)=3 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,table_type,IFNULL(engine,'-'),IFNULL(table_collation,'-'),IFNULL(row_format,'-'),IFNULL(create_options,'-')) ORDER BY table_name SEPARATOR '|'),256)='a6292f2570b9b38253308b846ad49ef1808a4f70afc2616036eb112728a38547'
    FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_capture_backup_checkpoints','tenant_telemetry_capture_backup_checkpoint_leaves','tenant_telemetry_capture_restore_bindings'))
  AND (SELECT COUNT(*)=23 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,LPAD(ordinal_position,3,'0'),column_name,LOWER(column_type),is_nullable,IF(column_default IS NULL,'<NULL>',CONCAT('<',column_default,'>')),IFNULL(character_set_name,'-'),IFNULL(collation_name,'-'),IFNULL(extra,'-'),IFNULL(generation_expression,'-')) ORDER BY table_name,ordinal_position SEPARATOR '|'),256)='e0469154b187905abfbb0a652af7fd60b59ae4fb76074290d2c86aa989371fb6'
    FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_capture_backup_checkpoints','tenant_telemetry_capture_backup_checkpoint_leaves','tenant_telemetry_capture_restore_bindings'))
  AND (SELECT COUNT(*)=9 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,index_name,LPAD(seq_in_index,3,'0'),column_name,non_unique,index_type,IFNULL(collation,'-'),IFNULL(sub_part,'-'),IFNULL(nullable,'-')) ORDER BY table_name,index_name,seq_in_index SEPARATOR '|'),256)='4ad1aeb03bc8dc19a0d443e89f90cbc1b3a78905804c1052f734328ed850832b'
    FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_capture_backup_checkpoints','tenant_telemetry_capture_backup_checkpoint_leaves','tenant_telemetry_capture_restore_bindings'))
  AND (SELECT COUNT(*)=3 AND SUM(enforced='YES')=3 FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND constraint_name IN ('chk_tt_capture_checkpoint_shape','chk_tt_capture_checkpoint_leaf_shape','chk_tt_capture_restore_binding_shape') AND constraint_type='CHECK')
  AND (SELECT COUNT(*)=3 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',constraint_name,LOWER(REPLACE(REPLACE(REGEXP_REPLACE(check_clause,'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY constraint_name SEPARATOR '|'),256)='246a53157b8af023fbe4692d1ba84cb347920e25666531d53fd9d57a9736fdbd'
    FROM information_schema.check_constraints WHERE constraint_schema=DATABASE() AND constraint_name IN ('chk_tt_capture_checkpoint_shape','chk_tt_capture_checkpoint_leaf_shape','chk_tt_capture_restore_binding_shape'))
  AND (SELECT COUNT(*)=11 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,constraint_type) ORDER BY table_name,constraint_name SEPARATOR '|'),256)='f1e540de82a92479e83a82c1749084154ad27f382474bc3763277ad775ba3965'
    FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_capture_backup_checkpoints','tenant_telemetry_capture_backup_checkpoint_leaves','tenant_telemetry_capture_restore_bindings'))
  AND (SELECT COUNT(*)=4 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,referenced_table_name,update_rule,delete_rule) ORDER BY table_name,constraint_name SEPARATOR '|'),256)='5d42ee71c94a69eb52afdc93e00349ad75c2c168cb116e0520f9b584d8a62457'
    FROM information_schema.referential_constraints WHERE constraint_schema=DATABASE() AND table_name IN ('tenant_telemetry_capture_backup_checkpoints','tenant_telemetry_capture_backup_checkpoint_leaves','tenant_telemetry_capture_restore_bindings'))
  AND (SELECT COUNT(*)=4 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,LPAD(ordinal_position,3,'0'),column_name,referenced_table_name,referenced_column_name) ORDER BY table_name,constraint_name,ordinal_position SEPARATOR '|'),256)='bd50a0f0ce7e55d3141afea308556a9b94069595e35333646cc15d73a552f354'
    FROM information_schema.key_column_usage WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_capture_backup_checkpoints','tenant_telemetry_capture_backup_checkpoint_leaves','tenant_telemetry_capture_restore_bindings') AND referenced_table_name IS NOT NULL)
  AND (SELECT COUNT(*)=0 FROM information_schema.partitions WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_capture_backup_checkpoints','tenant_telemetry_capture_backup_checkpoint_leaves','tenant_telemetry_capture_restore_bindings') AND partition_name IS NOT NULL)
);
-- agent-service-runtime-fingerprint:tenant-telemetry-capture-backup-checkpoint-schema:end
SET @migration_sql=IF(@tt_capture_checkpoint_schema_ok=1,'SELECT 1','SELECT 1 FROM __invalid_tenant_telemetry_capture_backup_checkpoint_schema__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- Full trigger set includes all 712 previously published guards and six new
-- immutable guards; never fingerprint only this migration's prefix.
-- agent-service-runtime-fingerprint:tenant-telemetry-capture-backup-checkpoint-triggers:start
SET @tt_capture_checkpoint_triggers_ok=(
  SELECT COUNT(*)=718 AND COUNT(DISTINCT trigger_name)=718
    AND SUM(LEFT(trigger_name,26)='trg_tt_capture_checkpoint_')=4
    AND SUM(LEFT(trigger_name,23)='trg_tt_capture_restore_')=2
    AND SUM(OCTET_LENGTH(CONCAT_WS('~',event_object_table,trigger_name,action_timing,event_manipulation,action_orientation,IFNULL(action_condition,'<NULL>'),LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),CHAR(96),''),'_utf8mb4','')))))+COUNT(*)-1<=@@SESSION.group_concat_max_len
    AND SHA2(GROUP_CONCAT(CONCAT_WS('~',event_object_table,trigger_name,action_timing,event_manipulation,action_orientation,IFNULL(action_condition,'<NULL>'),LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY event_object_table,trigger_name SEPARATOR '|'),256)='06b85e204e9b3816f6a94ff9fcd9630210960d34c75a70816589f41b0022ea8d'
  FROM information_schema.triggers WHERE trigger_schema=DATABASE()
);
-- agent-service-runtime-fingerprint:tenant-telemetry-capture-backup-checkpoint-triggers:end
SET @migration_sql=IF(@tt_capture_checkpoint_triggers_ok=1,'SELECT 1','SELECT 1 FROM __invalid_tenant_telemetry_capture_backup_checkpoint_triggers__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
SET SESSION group_concat_max_len=@tt_capture_checkpoint_migration_previous_gcml;
