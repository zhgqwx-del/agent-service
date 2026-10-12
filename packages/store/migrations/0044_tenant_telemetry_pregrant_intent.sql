-- 0044: default-dormant, versioned, content-free local source intent and claim.
-- These rows are not disposition grants, external mutations, physical ACKs,
-- restore proofs, or completion. Drain every pre-0044 writer before migrating.
-- No historical plan/terminal is backfilled and no remote storage is touched.

CREATE TABLE IF NOT EXISTS tenant_telemetry_pregrant_intents (
  scope VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_id VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation BIGINT UNSIGNED NOT NULL,
  build_generation BIGINT UNSIGNED NOT NULL,
  artifact_group_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  catalog_entry_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  catalog_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_accounting_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_manifest_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  owner_closure_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  database_purge_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  created_at_db_ms BIGINT NOT NULL,
  intent_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  grant_ready BOOLEAN NOT NULL,
  PRIMARY KEY (request_id,artifact_group_sha256),
  UNIQUE KEY uk_tt_pregrant_intent_hash (intent_sha256),
  KEY idx_tt_pregrant_intent_tenant (tenant_id,request_id),
  KEY idx_tt_pregrant_intent_catalog (request_id,catalog_receipt_sha256),
  KEY idx_tt_pregrant_intent_source (source_accounting_receipt_sha256),
  KEY idx_tt_pregrant_intent_manifest (target_manifest_receipt_sha256),
  KEY idx_tt_pregrant_intent_closure (owner_closure_receipt_sha256),
  KEY idx_tt_pregrant_intent_t3f (database_purge_receipt_sha256),
  CONSTRAINT fk_tt_pregrant_intent_catalog_entry FOREIGN KEY (request_id,artifact_group_sha256)
    REFERENCES tenant_telemetry_plan_artifact_targets (request_id,artifact_group_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tt_pregrant_intent_catalog_receipt FOREIGN KEY (catalog_receipt_sha256)
    REFERENCES tenant_telemetry_plan_artifact_target_receipts (receipt_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tt_pregrant_intent_source FOREIGN KEY (source_accounting_receipt_sha256)
    REFERENCES tenant_telemetry_source_accounting_receipts (receipt_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tt_pregrant_intent_manifest FOREIGN KEY (target_manifest_receipt_sha256)
    REFERENCES tenant_telemetry_target_manifest_receipts (receipt_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tt_pregrant_intent_closure FOREIGN KEY (owner_closure_receipt_sha256)
    REFERENCES tenant_telemetry_owner_closure_receipts (receipt_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tt_pregrant_intent_t3f FOREIGN KEY (database_purge_receipt_sha256)
    REFERENCES tenant_database_purge_receipts (receipt_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tt_pregrant_intent_shape CHECK (
    scope='tenant-telemetry-pregrant-intent-v1'
    AND CHAR_LENGTH(tenant_id) BETWEEN 1 AND 128
    AND subject_generation>0 AND build_generation>0
    AND artifact_group_sha256 REGEXP '^[0-9a-f]{64}$'
    AND catalog_entry_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND catalog_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND source_accounting_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND target_manifest_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND owner_closure_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND database_purge_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND created_at_db_ms>=0
    AND intent_sha256 REGEXP '^[0-9a-f]{64}$'
    AND grant_ready=0
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT scope,tenant_id,request_id,subject_generation,build_generation,
       artifact_group_sha256,catalog_entry_receipt_sha256,catalog_receipt_sha256,
       source_accounting_receipt_sha256,target_manifest_receipt_sha256,
       owner_closure_receipt_sha256,database_purge_receipt_sha256,
       created_at_db_ms,intent_sha256,grant_ready
  FROM tenant_telemetry_pregrant_intents FORCE INDEX (
    PRIMARY,uk_tt_pregrant_intent_hash,idx_tt_pregrant_intent_tenant,
    idx_tt_pregrant_intent_catalog,idx_tt_pregrant_intent_source,
    idx_tt_pregrant_intent_manifest,idx_tt_pregrant_intent_closure,
    idx_tt_pregrant_intent_t3f
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_telemetry_pregrant_claims (
  scope VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_id VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  intent_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  attempt INT UNSIGNED NOT NULL,
  claim_token_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  claimed_at_db_ms BIGINT NOT NULL,
  lease_until_db_ms BIGINT NOT NULL,
  claim_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  grant_ready BOOLEAN NOT NULL,
  PRIMARY KEY (intent_sha256,attempt),
  UNIQUE KEY uk_tt_pregrant_claim_token (intent_sha256,claim_token_sha256),
  UNIQUE KEY uk_tt_pregrant_claim_hash (claim_sha256),
  KEY idx_tt_pregrant_claim_tenant (tenant_id,request_id),
  CONSTRAINT fk_tt_pregrant_claim_intent FOREIGN KEY (intent_sha256)
    REFERENCES tenant_telemetry_pregrant_intents (intent_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tt_pregrant_claim_shape CHECK (
    scope='tenant-telemetry-pregrant-claim-v1'
    AND CHAR_LENGTH(tenant_id) BETWEEN 1 AND 128
    AND intent_sha256 REGEXP '^[0-9a-f]{64}$'
    AND attempt>0
    AND claim_token_sha256 REGEXP '^[0-9a-f]{64}$'
    AND claimed_at_db_ms>=0
    AND lease_until_db_ms>claimed_at_db_ms
    AND claim_sha256 REGEXP '^[0-9a-f]{64}$'
    AND grant_ready=0
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT scope,tenant_id,request_id,intent_sha256,attempt,claim_token_sha256,
       claimed_at_db_ms,lease_until_db_ms,claim_sha256,grant_ready
  FROM tenant_telemetry_pregrant_claims FORCE INDEX (
    PRIMARY,uk_tt_pregrant_claim_token,uk_tt_pregrant_claim_hash,
    idx_tt_pregrant_claim_tenant
  ) WHERE 1=0;

CREATE TRIGGER trg_tt_pregrant_intent_bi BEFORE INSERT ON tenant_telemetry_pregrant_intents FOR EACH ROW BEGIN IF NOT (
  EXISTS (SELECT 1 FROM tenant_telemetry_plan_artifact_targets e WHERE BINARY e.request_id=BINARY NEW.request_id AND BINARY e.tenant_id=BINARY NEW.tenant_id AND e.subject_generation=NEW.subject_generation AND e.build_generation=NEW.build_generation AND BINARY e.artifact_group_sha256=BINARY NEW.artifact_group_sha256 AND BINARY e.receipt_sha256=BINARY NEW.catalog_entry_receipt_sha256)
  AND EXISTS (SELECT 1 FROM tenant_telemetry_plan_artifact_target_receipts c WHERE BINARY c.request_id=BINARY NEW.request_id AND BINARY c.tenant_id=BINARY NEW.tenant_id AND c.subject_generation=NEW.subject_generation AND c.build_generation=NEW.build_generation AND BINARY c.receipt_sha256=BINARY NEW.catalog_receipt_sha256 AND BINARY c.source_accounting_receipt_sha256=BINARY NEW.source_accounting_receipt_sha256 AND BINARY c.target_manifest_receipt_sha256=BINARY NEW.target_manifest_receipt_sha256 AND c.execution_ready=0)
  AND EXISTS (SELECT 1 FROM tenant_telemetry_source_accounting_receipts s WHERE BINARY s.request_id=BINARY NEW.request_id AND BINARY s.tenant_id=BINARY NEW.tenant_id AND s.subject_generation=NEW.subject_generation AND s.build_generation=NEW.build_generation AND BINARY s.receipt_sha256=BINARY NEW.source_accounting_receipt_sha256)
  AND EXISTS (SELECT 1 FROM tenant_telemetry_target_manifest_receipts m WHERE BINARY m.request_id=BINARY NEW.request_id AND BINARY m.tenant_id=BINARY NEW.tenant_id AND m.subject_generation=NEW.subject_generation AND m.build_generation=NEW.build_generation AND BINARY m.receipt_sha256=BINARY NEW.target_manifest_receipt_sha256)
  AND EXISTS (SELECT 1 FROM tenant_telemetry_owner_closure_receipts o WHERE BINARY o.request_id=BINARY NEW.request_id AND BINARY o.tenant_id=BINARY NEW.tenant_id AND o.subject_generation=NEW.subject_generation AND o.plan_build_generation=NEW.build_generation AND BINARY o.receipt_sha256=BINARY NEW.owner_closure_receipt_sha256 AND BINARY o.t3f_receipt_sha256=BINARY NEW.database_purge_receipt_sha256)
  AND EXISTS (SELECT 1 FROM tenant_database_purge_receipts r JOIN tenant_database_purge_jobs j ON BINARY j.request_id=BINARY r.request_id WHERE BINARY r.request_id=BINARY NEW.request_id AND BINARY r.tenant_id=BINARY NEW.tenant_id AND r.subject_generation=NEW.subject_generation AND r.plan_build_generation=NEW.build_generation AND BINARY r.receipt_sha256=BINARY NEW.database_purge_receipt_sha256 AND r.local_database_purge_complete=1 AND r.session_content_deleted=1 AND r.all_domains_complete=0 AND r.content_purge_executed=0 AND j.phase='database_purged' AND BINARY j.tenant_id=BINARY NEW.tenant_id AND BINARY j.terminal_receipt_sha256=BINARY NEW.database_purge_receipt_sha256 AND r.store_db_timestamp_ms<=NEW.created_at_db_ms)
) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry pregrant intent lacks exact terminal local source'; END IF; END;

CREATE TRIGGER trg_tt_pregrant_intent_bu BEFORE UPDATE ON tenant_telemetry_pregrant_intents FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry pregrant intent is immutable';
CREATE TRIGGER trg_tt_pregrant_intent_bd BEFORE DELETE ON tenant_telemetry_pregrant_intents FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry pregrant intent is append-only';
CREATE TRIGGER trg_tt_pregrant_claim_bi BEFORE INSERT ON tenant_telemetry_pregrant_claims FOR EACH ROW BEGIN IF NOT EXISTS (SELECT 1 FROM tenant_telemetry_pregrant_intents i WHERE BINARY i.intent_sha256=BINARY NEW.intent_sha256 AND BINARY i.tenant_id=BINARY NEW.tenant_id AND BINARY i.request_id=BINARY NEW.request_id AND i.grant_ready=0 AND i.created_at_db_ms<=NEW.claimed_at_db_ms) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry pregrant claim lacks exact intent'; END IF; END;
CREATE TRIGGER trg_tt_pregrant_claim_bu BEFORE UPDATE ON tenant_telemetry_pregrant_claims FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry pregrant claim is immutable';
CREATE TRIGGER trg_tt_pregrant_claim_bd BEFORE DELETE ON tenant_telemetry_pregrant_claims FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry pregrant claim is append-only';

-- Deliberate redundant 0042-table guard: old binaries' published 119-trigger
-- fingerprint must fail after this incompatible schema advance.
CREATE TRIGGER trg_tt_pregrant_catalog_receipt_bu BEFORE UPDATE ON tenant_telemetry_plan_artifact_target_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry target catalog receipt is immutable';

SET @tt_pregrant_previous_group_concat_max_len=@@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len=1048576;
-- agent-service-runtime-fingerprint:tenant-telemetry-pregrant-intent-schema:start
SET @tt_pregrant_schema_ok=(
  (SELECT COUNT(*)=2 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,table_type,IFNULL(engine,'-'),IFNULL(table_collation,'-')) ORDER BY table_name SEPARATOR '|'),256)='3b8f446997bb06ae5baf4ecb799a4994c03125788cb8ac3ced458670d7554ab9' FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_pregrant_intents','tenant_telemetry_pregrant_claims'))
  AND (SELECT COUNT(*)=25 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,LPAD(ordinal_position,3,'0'),column_name,LOWER(column_type),is_nullable,IF(column_default IS NULL,'<NULL>',CONCAT('<',column_default,'>')),IFNULL(character_set_name,'-'),IFNULL(extra,'-'),IFNULL(generation_expression,'-')) ORDER BY table_name,ordinal_position SEPARATOR '|'),256)='b1f97cd1e0c9eb9c2b5b4641e79328627c002444cd9680a9697264c21014928e' FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_pregrant_intents','tenant_telemetry_pregrant_claims'))
  AND (SELECT COUNT(*)=19 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,index_name,LPAD(seq_in_index,3,'0'),column_name,non_unique,index_type,IFNULL(collation,'-'),IFNULL(sub_part,'-'),IFNULL(nullable,'-')) ORDER BY table_name,index_name,seq_in_index SEPARATOR '|'),256)='b660baa98225a61257225f49576aee303dcab276b4e493e8f7a347f6a08b78cc' FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_pregrant_intents','tenant_telemetry_pregrant_claims'))
  AND (SELECT COUNT(*)=2 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',constraint_name,LOWER(REPLACE(REPLACE(REGEXP_REPLACE(check_clause,'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY constraint_name SEPARATOR '|'),256)='86f991041cec2723ff1972713c253aaff91feb016d6171664d208affd946f0c7' FROM information_schema.check_constraints WHERE constraint_schema=DATABASE() AND constraint_name IN ('chk_tt_pregrant_intent_shape','chk_tt_pregrant_claim_shape'))
  AND (SELECT COUNT(*)=14 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,constraint_type) ORDER BY table_name,constraint_name SEPARATOR '|'),256)='48b5461e94e688b36f4bd661d99bc726264a5c7a32c8335dcde8e888d4b1f385' FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_pregrant_intents','tenant_telemetry_pregrant_claims'))
  AND (SELECT COUNT(*)=7 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,referenced_table_name,update_rule,delete_rule) ORDER BY table_name,constraint_name SEPARATOR '|'),256)='0ea8cacbdbbea9798f5375613158d5241c8ae96ecf9ff4ceb1ad9dcd95d089b8' FROM information_schema.referential_constraints WHERE constraint_schema=DATABASE() AND table_name IN ('tenant_telemetry_pregrant_intents','tenant_telemetry_pregrant_claims'))
  AND (SELECT COUNT(*)=8 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,LPAD(ordinal_position,3,'0'),column_name,referenced_table_name,referenced_column_name) ORDER BY table_name,constraint_name,ordinal_position SEPARATOR '|'),256)='ff03fa0ddda9214796947cc0413b81863c63d0508c4913ac7af56d603f5eed3c' FROM information_schema.key_column_usage WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_pregrant_intents','tenant_telemetry_pregrant_claims') AND referenced_table_name IS NOT NULL)
  AND (SELECT COUNT(*)=0 FROM information_schema.partitions WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_pregrant_intents','tenant_telemetry_pregrant_claims') AND partition_name IS NOT NULL)
);
-- agent-service-runtime-fingerprint:tenant-telemetry-pregrant-intent-schema:end
SET @migration_sql=IF(@tt_pregrant_schema_ok=1,'SELECT 1','SELECT 1 FROM __invalid_tenant_telemetry_pregrant_schema__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- Published 0042 119-trigger family plus seven new guards/tripwire.
-- agent-service-runtime-fingerprint:tenant-telemetry-pregrant-intent-triggers:start
SET @tt_pregrant_triggers_ok=(
  SELECT COUNT(*)=126 AND COUNT(DISTINCT trigger_name)=126 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',event_object_table,trigger_name,action_timing,event_manipulation,action_orientation,IFNULL(action_condition,'<NULL>'),LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY event_object_table,trigger_name SEPARATOR '|'),256)='6ddddb33d04982d5c2ade37d9f4a180e262475bb3a82c3da385603c97c785530'
  FROM information_schema.triggers WHERE trigger_schema=DATABASE()
    AND (event_object_table IN ('sessions','subject_lifecycle','tenant_telemetry_lifecycle_control','tenant_telemetry_lifecycle_targets','tenant_telemetry_lifecycle_coverages','tenant_telemetry_lifecycle_subjects','tenant_telemetry_activation_receipts','tenant_telemetry_artifact_inventory','tenant_telemetry_write_jobs','tenant_telemetry_write_payloads','tenant_telemetry_write_acks','tenant_telemetry_application_domain_controls','tenant_telemetry_application_activation_receipts','tenant_telemetry_application_coverages','tenant_telemetry_application_write_bindings','tenant_telemetry_disposition_control','tenant_telemetry_disposition_activation_receipts','tenant_telemetry_disposition_jobs','tenant_telemetry_disposition_authorization_grants','tenant_telemetry_disposition_external_authorizations','tenant_telemetry_disposition_external_events','tenant_telemetry_disposition_tombstone_acks','tenant_telemetry_disposition_receipts','tenant_telemetry_disposition_replay_fences','tenant_telemetry_artifact_memberships','tenant_telemetry_owner_closure_entries','tenant_telemetry_owner_closure_receipts','tenant_telemetry_source_accounting_entries','tenant_telemetry_source_accounting_receipts','tenant_telemetry_target_manifest_entries','tenant_telemetry_target_manifest_receipts','tenant_telemetry_plan_artifact_targets','tenant_telemetry_plan_artifact_target_receipts','tenant_telemetry_pregrant_intents','tenant_telemetry_pregrant_claims') OR (event_object_table='tenant_credential_revocation_jobs' AND action_timing='BEFORE' AND event_manipulation='INSERT') OR (event_object_table='tenant_database_purge_jobs' AND BINARY trigger_name=BINARY 'trg_tt_owner_closure_t3f_terminal_bu') OR (event_object_table='tenant_purge_plan_jobs' AND BINARY trigger_name IN (BINARY 'trg_tt_source_accounting_t3d_terminal_bu',BINARY 'trg_tt_target_manifest_t3d_terminal_bu',BINARY 'trg_tt_plan_artifact_target_t3d_terminal_bu')))
);
-- agent-service-runtime-fingerprint:tenant-telemetry-pregrant-intent-triggers:end
SET @migration_sql=IF(@tt_pregrant_triggers_ok=1,'SELECT 1','SELECT 1 FROM __invalid_tenant_telemetry_pregrant_triggers__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
SET SESSION group_concat_max_len=@tt_pregrant_previous_group_concat_max_len;

-- Marker-loss replay is allowed only when no new 0044 evidence has been written.
-- Existing evidence requires controlled restoration of the exact migration marker.
SET @tt_pregrant_projection_ok=(
  (SELECT COUNT(*) FROM tenant_telemetry_pregrant_intents)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_pregrant_claims)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_authorization_grants)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_external_events)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_tombstone_acks)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_receipts)=0
);
SET @migration_sql=IF(@tt_pregrant_projection_ok=1,'SELECT 1','SELECT 1 FROM __invalid_tenant_telemetry_pregrant_projection__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
