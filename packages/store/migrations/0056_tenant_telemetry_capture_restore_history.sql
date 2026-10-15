-- 0056: append-only, local-only historical proof for an exact 0055-selected
-- restore run. No ordinary runtime startup, new capture write, recovery permit,
-- 0037 grant, external deletion or 0054 destructive eligibility is enabled.
CREATE TABLE tenant_telemetry_capture_restore_history_receipts (
  restore_run_id VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  backup_id VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  checkpoint_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  artifact_manifest_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_snapshot_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  provider_evidence_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  runtime_epoch_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  history_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  activated_at_db_ms BIGINT UNSIGNED NOT NULL,
  receipt_json JSON NOT NULL,
  PRIMARY KEY (restore_run_id),
  KEY idx_tt_capture_restore_history_backup (backup_id),
  CONSTRAINT fk_tt_capture_restore_history_binding FOREIGN KEY (restore_run_id)
    REFERENCES tenant_telemetry_capture_restore_bindings(restore_run_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tt_capture_restore_history_checkpoint FOREIGN KEY (backup_id)
    REFERENCES tenant_telemetry_capture_backup_checkpoints(backup_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tt_capture_restore_history_shape CHECK (
    restore_run_id REGEXP '^restore_[0-9a-f-]{36}$'
    AND backup_id REGEXP '^backup_[0-9a-f-]{36}$'
    AND checkpoint_sha256 REGEXP '^[0-9a-f]{64}$'
    AND artifact_manifest_sha256 REGEXP '^[0-9a-f]{64}$'
    AND source_snapshot_sha256 REGEXP '^[0-9a-f]{64}$'
    AND provider_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
    AND runtime_epoch_sha256 REGEXP '^[0-9a-f]{64}$'
    AND history_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND JSON_TYPE(receipt_json)='OBJECT'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_tt_capture_restore_history_immutable_update BEFORE UPDATE ON tenant_telemetry_capture_restore_history_receipts FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture restore history is immutable'; END;
CREATE TRIGGER trg_tt_capture_restore_history_immutable_delete BEFORE DELETE ON tenant_telemetry_capture_restore_history_receipts FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture restore history is immutable'; END;

-- This new migration is intentionally unpublishable until the release owner
-- derives the exact schema and full-trigger roots from an isolated real MySQL
-- 8.0.26 instance. Runtime source validation rejects every zero placeholder.
SET @tt_capture_restore_history_migration_previous_gcml=@@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len=1048576;
-- agent-service-runtime-fingerprint:tenant-telemetry-capture-restore-history-schema:start
SET @tt_capture_restore_history_schema_ok=(
  (SELECT COUNT(*)=1 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,table_type,IFNULL(engine,'-'),IFNULL(table_collation,'-'),IFNULL(row_format,'-'),IFNULL(create_options,'-')) ORDER BY table_name SEPARATOR '|'),256)='b5671fc968fab97d35b5a1659c876e201f72c0b25b641c9a25032e1ad9c507cc'
    FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='tenant_telemetry_capture_restore_history_receipts')
  AND (SELECT COUNT(*)=10 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,LPAD(ordinal_position,3,'0'),column_name,LOWER(column_type),is_nullable,IF(column_default IS NULL,'<NULL>',CONCAT('<',column_default,'>')),IFNULL(character_set_name,'-'),IFNULL(collation_name,'-'),IFNULL(extra,'-'),IFNULL(generation_expression,'-')) ORDER BY table_name,ordinal_position SEPARATOR '|'),256)='c22f4262fbbfae1f0c2492efecd9d7a1127e04df0fb149f403ac8408b85f362c'
    FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='tenant_telemetry_capture_restore_history_receipts')
  AND (SELECT COUNT(*)=2 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,index_name,LPAD(seq_in_index,3,'0'),column_name,non_unique,index_type,IFNULL(collation,'-'),IFNULL(sub_part,'-'),IFNULL(nullable,'-')) ORDER BY table_name,index_name,seq_in_index SEPARATOR '|'),256)='02c73fee45fcd7c47178ceca724433884e03fb3907aed9d3454c0f87b3c8002d'
    FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='tenant_telemetry_capture_restore_history_receipts')
  AND (SELECT COUNT(*)=1 AND SUM(enforced='YES')=1 FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND constraint_name='chk_tt_capture_restore_history_shape' AND constraint_type='CHECK')
  AND (SELECT COUNT(*)=1 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',constraint_name,LOWER(REPLACE(REPLACE(REGEXP_REPLACE(check_clause,'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY constraint_name SEPARATOR '|'),256)='a050cf9ffe61c28f91d4a5e7ee6bff0dcdfd312807b3e4993b1fba530ad225fc'
    FROM information_schema.check_constraints WHERE constraint_schema=DATABASE() AND constraint_name='chk_tt_capture_restore_history_shape')
  AND (SELECT COUNT(*)=4 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,constraint_type) ORDER BY table_name,constraint_name SEPARATOR '|'),256)='503a5e3aa166efc53a2caeead604343021b197d92e4aa86bb658379d0772f5e0'
    FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND table_name='tenant_telemetry_capture_restore_history_receipts')
  AND (SELECT COUNT(*)=2 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,referenced_table_name,update_rule,delete_rule) ORDER BY table_name,constraint_name SEPARATOR '|'),256)='84ad759ff747630e76c3f2de506f0dc28c0114d001896c769c4daaaa48d93d34'
    FROM information_schema.referential_constraints WHERE constraint_schema=DATABASE() AND table_name='tenant_telemetry_capture_restore_history_receipts')
  AND (SELECT COUNT(*)=2 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,LPAD(ordinal_position,3,'0'),column_name,referenced_table_name,referenced_column_name) ORDER BY table_name,constraint_name,ordinal_position SEPARATOR '|'),256)='a4a9897510eedafe8b2e4b40c1d9e9bbdd23ef0ffa5cee3591227385d7852a09'
    FROM information_schema.key_column_usage WHERE table_schema=DATABASE() AND table_name='tenant_telemetry_capture_restore_history_receipts' AND referenced_table_name IS NOT NULL)
  AND (SELECT COUNT(*)=0 FROM information_schema.partitions WHERE table_schema=DATABASE() AND table_name='tenant_telemetry_capture_restore_history_receipts' AND partition_name IS NOT NULL)
);
-- agent-service-runtime-fingerprint:tenant-telemetry-capture-restore-history-schema:end
SET @migration_sql=IF(@tt_capture_restore_history_schema_ok=1,'SELECT 1','SELECT 1 FROM __invalid_tenant_telemetry_capture_restore_history_schema__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- Full prior 718 guards plus this migration's two immutable guards.
-- agent-service-runtime-fingerprint:tenant-telemetry-capture-restore-history-triggers:start
SET @tt_capture_restore_history_triggers_ok=(
  SELECT COUNT(*)=720 AND COUNT(DISTINCT trigger_name)=720
    AND SUM(LEFT(trigger_name,31)='trg_tt_capture_restore_history_')=2
    AND SUM(OCTET_LENGTH(CONCAT_WS('~',event_object_table,trigger_name,action_timing,event_manipulation,action_orientation,IFNULL(action_condition,'<NULL>'),LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),CHAR(96),''),'_utf8mb4','')))))+COUNT(*)-1<=@@SESSION.group_concat_max_len
    AND SHA2(GROUP_CONCAT(CONCAT_WS('~',event_object_table,trigger_name,action_timing,event_manipulation,action_orientation,IFNULL(action_condition,'<NULL>'),LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY event_object_table,trigger_name SEPARATOR '|'),256)='f0106cb60435d639130445e0a094124a0dbc6875abd7996b235f3bf5c3a5d01e'
  FROM information_schema.triggers WHERE trigger_schema=DATABASE()
);
-- agent-service-runtime-fingerprint:tenant-telemetry-capture-restore-history-triggers:end
SET @migration_sql=IF(@tt_capture_restore_history_triggers_ok=1,'SELECT 1','SELECT 1 FROM __invalid_tenant_telemetry_capture_restore_history_triggers__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
SET SESSION group_concat_max_len=@tt_capture_restore_history_migration_previous_gcml;
