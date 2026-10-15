-- Unpublished 0059 credential-responsibility slice. This file is deliberately unpublishable
-- until its exact schema/trigger fingerprints have been derived on a fresh isolated MySQL
-- database after 0058. It does not alter any 0026/T3a receipt or legacy physical row.
-- Stop and drain every pre-0059 writer before applying it; no rolling mixed-writer window.

CREATE TABLE IF NOT EXISTS tenant_credential_responsibility_sources (
  tenant_id                    VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  credential_version_id        CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  slot_id_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_revision              BIGINT UNSIGNED NOT NULL,
  receipt_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_json                  JSON NOT NULL,
  recorded_at_db_ms            BIGINT NOT NULL,
  PRIMARY KEY (credential_version_id),
  UNIQUE KEY uk_credential_responsibility_source_receipt (receipt_sha256),
  UNIQUE KEY uk_credential_responsibility_source_revision
    (tenant_id, slot_id_sha256, source_revision),
  KEY idx_credential_responsibility_source_version_fk
    (credential_version_id, tenant_id),
  KEY idx_credential_responsibility_source_tenant (tenant_id, credential_version_id),
  CONSTRAINT fk_credential_responsibility_source_version
    FOREIGN KEY (credential_version_id, tenant_id)
    REFERENCES tenant_credential_versions (credential_version_id, tenant_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_credential_responsibility_source_clock
    CHECK (source_revision > 0 AND recorded_at_db_ms >= 0),
  CONSTRAINT chk_credential_responsibility_source_scope
    CHECK ((JSON_UNQUOTE(JSON_EXTRACT(source_json, '$.scope')) =
      'tenant-credential-responsibility-source-v1') IS TRUE)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT tenant_id, credential_version_id, slot_id_sha256, source_revision,
       receipt_sha256, source_json, recorded_at_db_ms
  FROM tenant_credential_responsibility_sources FORCE INDEX (
    PRIMARY, uk_credential_responsibility_source_receipt,
    uk_credential_responsibility_source_revision,
    idx_credential_responsibility_source_version_fk,
    idx_credential_responsibility_source_tenant
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_credential_responsibility_entries (
  request_id                   VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                    VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  credential_version_id        CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation           BIGINT UNSIGNED NOT NULL,
  t1_fence_sha256              CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  slot_kind                    VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  slot_id_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  version_identity_sha256      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  version_evidence_sha256      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  responsibility_source_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  source_kind                  VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  captured_at_db_ms            BIGINT NOT NULL,
  receipt_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  entry_json                   JSON NOT NULL,
  PRIMARY KEY (request_id, credential_version_id),
  UNIQUE KEY uk_credential_responsibility_entry_receipt (receipt_sha256),
  KEY idx_credential_responsibility_entry_version_fk
    (credential_version_id, tenant_id),
  KEY idx_credential_responsibility_entry_tenant (tenant_id, request_id),
  CONSTRAINT fk_credential_responsibility_entry_version
    FOREIGN KEY (credential_version_id, tenant_id)
    REFERENCES tenant_credential_versions (credential_version_id, tenant_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_credential_responsibility_entry_t3a
    FOREIGN KEY (request_id)
    REFERENCES tenant_credential_revocation_jobs (request_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_credential_responsibility_entry_state CHECK (
    subject_generation > 0 AND captured_at_db_ms >= 0
    AND slot_kind IN ('provider_binding','tenant_auth_secret')
    AND ((source_kind='recorded' AND responsibility_source_sha256 IS NOT NULL)
      OR (source_kind='unknown' AND responsibility_source_sha256 IS NULL))
  ),
  CONSTRAINT chk_credential_responsibility_entry_scope
    CHECK ((JSON_UNQUOTE(JSON_EXTRACT(entry_json, '$.scope')) =
      'tenant-credential-responsibility-snapshot-entry-v1') IS TRUE)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT request_id, tenant_id, credential_version_id, subject_generation,
       t1_fence_sha256, slot_kind, slot_id_sha256, version_identity_sha256,
       version_evidence_sha256, responsibility_source_sha256, source_kind,
       captured_at_db_ms, receipt_sha256, entry_json
  FROM tenant_credential_responsibility_entries FORCE INDEX (
    PRIMARY, uk_credential_responsibility_entry_receipt,
    idx_credential_responsibility_entry_version_fk,
    idx_credential_responsibility_entry_tenant
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_credential_responsibility_receipts (
  request_id                   VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                    VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation           BIGINT UNSIGNED NOT NULL,
  t1_fence_sha256              CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  t3a_receipt_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  inventory_receipt_sha256     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  version_count                BIGINT UNSIGNED NOT NULL,
  version_root_sha256          CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  entry_count                  BIGINT UNSIGNED NOT NULL,
  entry_root_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  captured_at_db_ms            BIGINT NOT NULL,
  receipt_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  receipt_json                 JSON NOT NULL,
  PRIMARY KEY (request_id),
  UNIQUE KEY uk_credential_responsibility_receipt_sha (receipt_sha256),
  KEY idx_credential_responsibility_receipt_tenant (tenant_id, request_id),
  CONSTRAINT fk_credential_responsibility_receipt_t3a
    FOREIGN KEY (request_id)
    REFERENCES tenant_credential_revocation_receipts (request_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_credential_responsibility_receipt_inventory
    FOREIGN KEY (request_id)
    REFERENCES tenant_credential_inventory_receipts (request_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_credential_responsibility_receipt_state CHECK (
    subject_generation > 0 AND captured_at_db_ms >= 0 AND entry_count=version_count
  ),
  CONSTRAINT chk_credential_responsibility_receipt_scope
    CHECK ((JSON_UNQUOTE(JSON_EXTRACT(receipt_json, '$.scope')) =
      'tenant-credential-responsibility-snapshot-v1') IS TRUE)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT request_id, tenant_id, subject_generation, t1_fence_sha256,
       t3a_receipt_sha256, inventory_receipt_sha256, version_count,
       version_root_sha256, entry_count, entry_root_sha256, captured_at_db_ms,
       receipt_sha256, receipt_json
  FROM tenant_credential_responsibility_receipts FORCE INDEX (
    PRIMARY, uk_credential_responsibility_receipt_sha,
    idx_credential_responsibility_receipt_tenant
  ) WHERE 1=0;

-- The old 0026 guard remains installed. This independent guard only applies to a newly
-- terminal T3a under active 0026 tracking; old terminal rows remain historical unknown.
CREATE TRIGGER trg_credential_responsibility_t3a_bu BEFORE UPDATE ON tenant_credential_revocation_jobs FOR EACH ROW BEGIN IF OLD.phase='queued' AND NEW.phase='credential_store_revoked' AND EXISTS (SELECT 1 FROM tenant_credential_tracking_cutover c WHERE c.singleton_id=1 AND c.control_generation=1) AND NOT EXISTS (SELECT 1 FROM tenant_credential_responsibility_receipts s JOIN tenant_credential_inventory_receipts i ON BINARY i.request_id=BINARY s.request_id AND BINARY i.tenant_id=BINARY s.tenant_id AND i.subject_generation=s.subject_generation AND BINARY i.receipt_sha256=BINARY s.inventory_receipt_sha256 JOIN tenant_credential_revocation_receipts r ON BINARY r.request_id=BINARY s.request_id AND BINARY r.tenant_id=BINARY s.tenant_id AND r.subject_generation=s.subject_generation AND BINARY r.receipt_sha256=BINARY s.t3a_receipt_sha256 WHERE BINARY s.request_id=BINARY NEW.request_id AND BINARY s.tenant_id=BINARY NEW.tenant_id AND s.subject_generation=NEW.subject_generation AND BINARY s.t1_fence_sha256=BINARY NEW.t1_fence_sha256 AND s.captured_at_db_ms=NEW.credential_store_revoked_at_ms AND i.store_db_timestamp_ms=s.captured_at_db_ms AND r.store_db_timestamp_ms=s.captured_at_db_ms AND r.completed_claim_attempt=NEW.completed_claim_attempt AND BINARY r.completed_claim_token_sha256=BINARY NEW.completed_claim_token_sha256 AND s.entry_count=(SELECT COUNT(*) FROM tenant_credential_responsibility_entries e WHERE BINARY e.request_id=BINARY s.request_id AND BINARY e.tenant_id=BINARY s.tenant_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='new T3a requires exact responsibility snapshot'; END IF; END;

CREATE TRIGGER trg_credential_responsibility_sources_bi BEFORE INSERT ON tenant_credential_responsibility_sources FOR EACH ROW BEGIN IF NOT EXISTS (SELECT 1 FROM tenant_credential_versions v JOIN tenant_credential_target_dispositions t ON BINARY t.credential_version_id=BINARY v.credential_version_id AND BINARY t.tenant_id=BINARY v.tenant_id AND t.domain='external_credential' WHERE BINARY v.credential_version_id=BINARY NEW.credential_version_id AND BINARY v.tenant_id=BINARY NEW.tenant_id AND v.slot_kind='provider_binding' AND v.origin='managed_v1' AND v.retired_at_db_ms IS NULL AND v.retire_reason IS NULL AND BINARY v.slot_id_sha256=BINARY NEW.slot_id_sha256 AND v.created_at_db_ms=NEW.recorded_at_db_ms AND BINARY t.evidence_sha256=BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.source_json,'$.externalTargetEvidenceSha256')) AND BINARY NEW.receipt_sha256=BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.source_json,'$.receiptSha256')) AND BINARY NEW.credential_version_id=BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.source_json,'$.credentialVersionId'))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential responsibility source lacks exact version and target'; END IF; END;
CREATE TRIGGER trg_credential_responsibility_sources_bu BEFORE UPDATE ON tenant_credential_responsibility_sources FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential responsibility source is immutable';
CREATE TRIGGER trg_credential_responsibility_sources_bd BEFORE DELETE ON tenant_credential_responsibility_sources FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential responsibility source is immutable';
CREATE TRIGGER trg_credential_responsibility_entries_bu BEFORE UPDATE ON tenant_credential_responsibility_entries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential responsibility entry is immutable';
CREATE TRIGGER trg_credential_responsibility_entries_bd BEFORE DELETE ON tenant_credential_responsibility_entries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential responsibility entry is immutable';
CREATE TRIGGER trg_credential_responsibility_receipts_bu BEFORE UPDATE ON tenant_credential_responsibility_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential responsibility receipt is immutable';
CREATE TRIGGER trg_credential_responsibility_receipts_bd BEFORE DELETE ON tenant_credential_responsibility_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential responsibility receipt is immutable';

SET @credential_responsibility_prev_gcml=@@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len=1048576;
-- agent-service-runtime-fingerprint:tenant-credential-responsibility-schema:start
SET @credential_responsibility_schema_ok=(
  (SELECT COUNT(*)=3 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,table_type,IFNULL(engine,'-'),IFNULL(table_collation,'-'),IFNULL(row_format,'-'),IFNULL(create_options,'-')) ORDER BY table_name SEPARATOR '|'),256)='0000000000000000000000000000000000000000000000000000000000000000' FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('tenant_credential_responsibility_sources','tenant_credential_responsibility_entries','tenant_credential_responsibility_receipts'))
  AND (SELECT COUNT(*)=34 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,LPAD(ordinal_position,3,'0'),column_name,LOWER(column_type),is_nullable,IF(column_default IS NULL,'<NULL>',CONCAT('<',column_default,'>')),IFNULL(character_set_name,'-'),IFNULL(collation_name,'-'),IFNULL(extra,'-'),IFNULL(generation_expression,'-')) ORDER BY table_name,ordinal_position SEPARATOR '|'),256)='0000000000000000000000000000000000000000000000000000000000000000' FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name IN ('tenant_credential_responsibility_sources','tenant_credential_responsibility_entries','tenant_credential_responsibility_receipts'))
  AND (SELECT COUNT(*)=20 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,index_name,LPAD(seq_in_index,3,'0'),column_name,non_unique,index_type,IFNULL(collation,'-'),IFNULL(sub_part,'-'),IFNULL(nullable,'-')) ORDER BY table_name,index_name,seq_in_index SEPARATOR '|'),256)='0000000000000000000000000000000000000000000000000000000000000000' FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name IN ('tenant_credential_responsibility_sources','tenant_credential_responsibility_entries','tenant_credential_responsibility_receipts'))
  AND (SELECT COUNT(*)=6 AND SUM(enforced='YES')=6 FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND constraint_name IN ('chk_credential_responsibility_source_clock','chk_credential_responsibility_source_scope','chk_credential_responsibility_entry_state','chk_credential_responsibility_entry_scope','chk_credential_responsibility_receipt_state','chk_credential_responsibility_receipt_scope') AND constraint_type='CHECK')
  AND (SELECT COUNT(*)=6 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',constraint_name,LOWER(REPLACE(REPLACE(REGEXP_REPLACE(check_clause,'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY constraint_name SEPARATOR '|'),256)='0000000000000000000000000000000000000000000000000000000000000000' FROM information_schema.check_constraints WHERE constraint_schema=DATABASE() AND constraint_name IN ('chk_credential_responsibility_source_clock','chk_credential_responsibility_source_scope','chk_credential_responsibility_entry_state','chk_credential_responsibility_entry_scope','chk_credential_responsibility_receipt_state','chk_credential_responsibility_receipt_scope'))
  AND (SELECT COUNT(*)=18 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,constraint_type) ORDER BY table_name,constraint_name SEPARATOR '|'),256)='0000000000000000000000000000000000000000000000000000000000000000' FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND table_name IN ('tenant_credential_responsibility_sources','tenant_credential_responsibility_entries','tenant_credential_responsibility_receipts'))
  AND (SELECT COUNT(*)=5 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,referenced_table_name,update_rule,delete_rule) ORDER BY table_name,constraint_name SEPARATOR '|'),256)='0000000000000000000000000000000000000000000000000000000000000000' FROM information_schema.referential_constraints WHERE constraint_schema=DATABASE() AND table_name IN ('tenant_credential_responsibility_sources','tenant_credential_responsibility_entries','tenant_credential_responsibility_receipts'))
  AND (SELECT COUNT(*)=7 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,LPAD(ordinal_position,3,'0'),column_name,referenced_table_name,referenced_column_name) ORDER BY table_name,constraint_name,ordinal_position SEPARATOR '|'),256)='0000000000000000000000000000000000000000000000000000000000000000' FROM information_schema.key_column_usage WHERE table_schema=DATABASE() AND table_name IN ('tenant_credential_responsibility_sources','tenant_credential_responsibility_entries','tenant_credential_responsibility_receipts') AND referenced_table_name IS NOT NULL)
  AND (SELECT COUNT(*)=0 FROM information_schema.partitions WHERE table_schema=DATABASE() AND table_name IN ('tenant_credential_responsibility_sources','tenant_credential_responsibility_entries','tenant_credential_responsibility_receipts') AND partition_name IS NOT NULL)
);
-- agent-service-runtime-fingerprint:tenant-credential-responsibility-schema:end
SET @migration_sql=IF(@credential_responsibility_schema_ok=1,'SELECT 1','SELECT 1 FROM __invalid_tenant_credential_responsibility_schema__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
-- agent-service-runtime-fingerprint:tenant-credential-responsibility-triggers:start
SET @credential_responsibility_triggers_ok=(
  SELECT COUNT(*)=743 AND COUNT(DISTINCT trigger_name)=743
    AND SUM(trigger_name IN ('trg_credential_responsibility_t3a_bu','trg_credential_responsibility_sources_bi','trg_credential_responsibility_sources_bu','trg_credential_responsibility_sources_bd','trg_credential_responsibility_entries_bu','trg_credential_responsibility_entries_bd','trg_credential_responsibility_receipts_bu','trg_credential_responsibility_receipts_bd'))=8
    AND SUM(OCTET_LENGTH(CONCAT_WS('~',event_object_table,trigger_name,action_timing,event_manipulation,action_orientation,IFNULL(action_condition,'<NULL>'),LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),CHAR(96),''),'_utf8mb4','')))))+COUNT(*)-1<=@@SESSION.group_concat_max_len
    AND SHA2(GROUP_CONCAT(CONCAT_WS('~',event_object_table,trigger_name,action_timing,event_manipulation,action_orientation,IFNULL(action_condition,'<NULL>'),LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY event_object_table,trigger_name SEPARATOR '|'),256)='0000000000000000000000000000000000000000000000000000000000000000'
  FROM information_schema.triggers WHERE trigger_schema=DATABASE()
);
-- agent-service-runtime-fingerprint:tenant-credential-responsibility-triggers:end
SET @migration_sql=IF(@credential_responsibility_triggers_ok=1,'SELECT 1','SELECT 1 FROM __invalid_tenant_credential_responsibility_triggers__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
SET SESSION group_concat_max_len=@credential_responsibility_prev_gcml;
