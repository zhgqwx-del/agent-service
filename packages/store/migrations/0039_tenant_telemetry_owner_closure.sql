-- 0039: immutable, default-dormant T3f telemetry owner closure evidence.
-- Expand-only: no historical backfill, activation, external mutation, grant or completion.
-- Drain pre-0039 T3f writers before applying; future terminal transitions require the new
-- same-transaction receipt, while pre-0039 terminal rows without one remain unknown.

CREATE TABLE IF NOT EXISTS tenant_telemetry_owner_closure_entries (
  scope VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_id VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation BIGINT UNSIGNED NOT NULL,
  plan_build_generation BIGINT UNSIGNED NOT NULL,
  execution_generation BIGINT UNSIGNED NOT NULL,
  database_purge_generation BIGINT UNSIGNED NOT NULL,
  write_operation_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  membership_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  inventory_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  owner_kind VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  owner_ref_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  hold_subject_ref_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  ref_key_id_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  owner_binding_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  canonical_owner_proof_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  session_grave_marker_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  predelete_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  captured_at_db_ms BIGINT NOT NULL,
  receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (request_id, write_operation_sha256),
  UNIQUE KEY uk_tt_owner_closure_entry_hash (receipt_sha256),
  KEY idx_tt_owner_closure_entry_job_fk
    (request_id,tenant_id,subject_generation,plan_build_generation,
     execution_generation,database_purge_generation),
  KEY idx_tt_owner_closure_entry_membership_fk (write_operation_sha256),
  KEY idx_tt_owner_closure_entry_predelete_fk
    (request_id,predelete_receipt_sha256),
  KEY idx_tt_owner_closure_entry_grave_fk (session_grave_marker_sha256),
  CONSTRAINT fk_tt_owner_closure_entry_job FOREIGN KEY
    (request_id,tenant_id,subject_generation,plan_build_generation,
     execution_generation,database_purge_generation)
    REFERENCES tenant_database_purge_jobs
      (request_id,tenant_id,subject_generation,plan_build_generation,
       execution_generation,database_purge_generation)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tt_owner_closure_entry_membership FOREIGN KEY (write_operation_sha256)
    REFERENCES tenant_telemetry_artifact_memberships (write_operation_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tt_owner_closure_entry_predelete FOREIGN KEY
    (request_id,predelete_receipt_sha256)
    REFERENCES tenant_database_purge_predelete_receipts (request_id,receipt_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tt_owner_closure_entry_grave FOREIGN KEY (session_grave_marker_sha256)
    REFERENCES tenant_purge_session_grave_markers (marker_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tt_owner_closure_entry_shape CHECK (
    scope='tenant-telemetry-owner-closure-entry-v1'
    AND CHAR_LENGTH(tenant_id) BETWEEN 1 AND 128
    AND subject_generation>0 AND plan_build_generation>0
    AND execution_generation>0 AND database_purge_generation>0
    AND write_operation_sha256 REGEXP '^[0-9a-f]{64}$'
    AND membership_sha256 REGEXP '^[0-9a-f]{64}$'
    AND inventory_sha256 REGEXP '^[0-9a-f]{64}$'
    AND owner_kind IN ('tenant','user','session')
    AND owner_ref_sha256 REGEXP '^[0-9a-f]{64}$'
    AND hold_subject_ref_sha256 REGEXP '^[0-9a-f]{64}$'
    AND ref_key_id_sha256 REGEXP '^[0-9a-f]{64}$'
    AND owner_binding_sha256 REGEXP '^[0-9a-f]{64}$'
    AND canonical_owner_proof_sha256 REGEXP '^[0-9a-f]{64}$'
    AND ((owner_kind='session' AND session_grave_marker_sha256 IS NOT NULL
      AND session_grave_marker_sha256 REGEXP '^[0-9a-f]{64}$')
      OR (owner_kind IN ('tenant','user') AND session_grave_marker_sha256 IS NULL))
    AND predelete_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND captured_at_db_ms>=0
    AND receipt_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT scope,request_id,tenant_id,subject_generation,plan_build_generation,
       execution_generation,database_purge_generation,write_operation_sha256,
       membership_sha256,inventory_sha256,owner_kind,owner_ref_sha256,
       hold_subject_ref_sha256,ref_key_id_sha256,
       owner_binding_sha256,canonical_owner_proof_sha256,session_grave_marker_sha256,
       predelete_receipt_sha256,captured_at_db_ms,receipt_sha256
  FROM tenant_telemetry_owner_closure_entries FORCE INDEX (
    PRIMARY,uk_tt_owner_closure_entry_hash,idx_tt_owner_closure_entry_job_fk,
    idx_tt_owner_closure_entry_membership_fk,idx_tt_owner_closure_entry_predelete_fk,
    idx_tt_owner_closure_entry_grave_fk
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_telemetry_owner_closure_receipts (
  scope VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_id VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation BIGINT UNSIGNED NOT NULL,
  plan_build_generation BIGINT UNSIGNED NOT NULL,
  execution_generation BIGINT UNSIGNED NOT NULL,
  database_purge_generation BIGINT UNSIGNED NOT NULL,
  t1_fence_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  t3c_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  plan_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  local_physical_ack_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  predelete_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  grave_marker_root_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  t3f_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  entry_count BIGINT UNSIGNED NOT NULL,
  entry_root_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  store_db_timestamp_ms BIGINT NOT NULL,
  completed_claim_attempt INT UNSIGNED NOT NULL,
  completed_claim_token_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (request_id),
  UNIQUE KEY uk_tt_owner_closure_receipt_hash (receipt_sha256),
  KEY idx_tt_owner_closure_receipt_job_fk
    (request_id,tenant_id,subject_generation,plan_build_generation,
     execution_generation,database_purge_generation),
  KEY idx_tt_owner_closure_receipt_t3f_fk (request_id,t3f_receipt_sha256),
  KEY idx_tt_owner_closure_receipt_predelete_fk
    (request_id,predelete_receipt_sha256),
  CONSTRAINT fk_tt_owner_closure_receipt_job FOREIGN KEY
    (request_id,tenant_id,subject_generation,plan_build_generation,
     execution_generation,database_purge_generation)
    REFERENCES tenant_database_purge_jobs
      (request_id,tenant_id,subject_generation,plan_build_generation,
       execution_generation,database_purge_generation)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tt_owner_closure_receipt_t3f FOREIGN KEY (request_id,t3f_receipt_sha256)
    REFERENCES tenant_database_purge_receipts (request_id,receipt_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tt_owner_closure_receipt_predelete FOREIGN KEY
    (request_id,predelete_receipt_sha256)
    REFERENCES tenant_database_purge_predelete_receipts (request_id,receipt_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tt_owner_closure_receipt_shape CHECK (
    scope='tenant-telemetry-owner-closure-receipt-v1'
    AND CHAR_LENGTH(tenant_id) BETWEEN 1 AND 128
    AND subject_generation>0 AND plan_build_generation>0
    AND execution_generation>0 AND database_purge_generation>0
    AND t1_fence_sha256 REGEXP '^[0-9a-f]{64}$'
    AND t3c_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND plan_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND local_physical_ack_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND predelete_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND grave_marker_root_sha256 REGEXP '^[0-9a-f]{64}$'
    AND t3f_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND entry_root_sha256 REGEXP '^[0-9a-f]{64}$'
    AND (entry_count>0 OR entry_root_sha256=
      '37b4f588a0496c4d87d772780cd43875de7d4bc9f69479a656aa140b072e7ead')
    AND store_db_timestamp_ms>=0 AND completed_claim_attempt>0
    AND completed_claim_token_sha256 REGEXP '^[0-9a-f]{64}$'
    AND receipt_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT scope,request_id,tenant_id,subject_generation,plan_build_generation,
       execution_generation,database_purge_generation,t1_fence_sha256,
       t3c_receipt_sha256,plan_receipt_sha256,local_physical_ack_receipt_sha256,
       predelete_receipt_sha256,grave_marker_root_sha256,t3f_receipt_sha256,
       entry_count,entry_root_sha256,store_db_timestamp_ms,completed_claim_attempt,
       completed_claim_token_sha256,receipt_sha256
  FROM tenant_telemetry_owner_closure_receipts FORCE INDEX (
    PRIMARY,uk_tt_owner_closure_receipt_hash,idx_tt_owner_closure_receipt_job_fk,
    idx_tt_owner_closure_receipt_t3f_fk,idx_tt_owner_closure_receipt_predelete_fk
  ) WHERE 1=0;

CREATE TRIGGER trg_tt_owner_closure_entry_bi BEFORE INSERT ON tenant_telemetry_owner_closure_entries FOR EACH ROW BEGIN IF (
  EXISTS (SELECT 1 FROM tenant_database_purge_jobs j WHERE BINARY j.request_id=BINARY NEW.request_id AND BINARY j.tenant_id=BINARY NEW.tenant_id AND j.subject_generation=NEW.subject_generation AND j.plan_build_generation=NEW.plan_build_generation AND j.execution_generation=NEW.execution_generation AND j.database_purge_generation=NEW.database_purge_generation AND j.phase='queued' AND BINARY j.predelete_receipt_sha256 IS NULL)
  AND EXISTS (SELECT 1 FROM tenant_database_purge_predelete_receipts p WHERE BINARY p.request_id=BINARY NEW.request_id AND BINARY p.tenant_id=BINARY NEW.tenant_id AND p.subject_generation=NEW.subject_generation AND p.plan_build_generation=NEW.plan_build_generation AND p.execution_generation=NEW.execution_generation AND p.database_purge_generation=NEW.database_purge_generation AND BINARY p.receipt_sha256=BINARY NEW.predelete_receipt_sha256 AND p.store_db_timestamp_ms=NEW.captured_at_db_ms)
  AND EXISTS (SELECT 1 FROM tenant_telemetry_artifact_memberships m JOIN tenant_telemetry_write_jobs w ON BINARY w.write_operation_sha256=BINARY m.write_operation_sha256 WHERE BINARY m.write_operation_sha256=BINARY NEW.write_operation_sha256 AND BINARY m.tenant_id=BINARY NEW.tenant_id AND BINARY w.tenant_id=BINARY NEW.tenant_id AND BINARY m.membership_sha256=BINARY NEW.membership_sha256 AND BINARY m.inventory_sha256=BINARY NEW.inventory_sha256 AND BINARY w.inventory_sha256=BINARY m.inventory_sha256 AND BINARY m.owner_kind=BINARY NEW.owner_kind AND BINARY m.owner_ref_sha256=BINARY NEW.owner_ref_sha256 AND BINARY m.hold_subject_ref_sha256=BINARY NEW.hold_subject_ref_sha256 AND BINARY m.ref_key_id_sha256=BINARY NEW.ref_key_id_sha256 AND BINARY m.owner_binding_sha256=BINARY NEW.owner_binding_sha256)
  AND ((NEW.owner_kind IN ('tenant','user') AND NEW.session_grave_marker_sha256 IS NULL) OR (NEW.owner_kind='session' AND EXISTS (SELECT 1 FROM tenant_purge_session_grave_markers g WHERE BINARY g.marker_sha256=BINARY NEW.session_grave_marker_sha256 AND BINARY g.request_id=BINARY NEW.request_id AND BINARY g.tenant_id=BINARY NEW.tenant_id AND g.subject_generation=NEW.subject_generation AND g.database_purge_generation=NEW.database_purge_generation AND BINARY g.predelete_receipt_sha256=BINARY NEW.predelete_receipt_sha256)))
) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry owner closure entry lacks exact live source'; END IF; END;

CREATE TRIGGER trg_tt_owner_closure_entry_bu BEFORE UPDATE ON tenant_telemetry_owner_closure_entries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry owner closure entry is immutable';
CREATE TRIGGER trg_tt_owner_closure_entry_bd BEFORE DELETE ON tenant_telemetry_owner_closure_entries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry owner closure entry is append-only';

CREATE TRIGGER trg_tt_owner_closure_receipt_bi BEFORE INSERT ON tenant_telemetry_owner_closure_receipts FOR EACH ROW BEGIN IF (
  EXISTS (SELECT 1 FROM tenant_database_purge_jobs j WHERE BINARY j.request_id=BINARY NEW.request_id AND BINARY j.tenant_id=BINARY NEW.tenant_id AND j.subject_generation=NEW.subject_generation AND j.plan_build_generation=NEW.plan_build_generation AND j.execution_generation=NEW.execution_generation AND j.database_purge_generation=NEW.database_purge_generation AND j.phase='queued' AND BINARY j.t3c_receipt_sha256=BINARY NEW.t3c_receipt_sha256 AND BINARY j.plan_receipt_sha256=BINARY NEW.plan_receipt_sha256 AND BINARY j.local_physical_ack_receipt_sha256=BINARY NEW.local_physical_ack_receipt_sha256)
  AND EXISTS (SELECT 1 FROM tenant_database_purge_receipts r WHERE BINARY r.request_id=BINARY NEW.request_id AND BINARY r.tenant_id=BINARY NEW.tenant_id AND r.subject_generation=NEW.subject_generation AND r.plan_build_generation=NEW.plan_build_generation AND r.execution_generation=NEW.execution_generation AND r.database_purge_generation=NEW.database_purge_generation AND BINARY r.receipt_sha256=BINARY NEW.t3f_receipt_sha256 AND BINARY r.predelete_receipt_sha256=BINARY NEW.predelete_receipt_sha256 AND BINARY r.grave_marker_root_sha256=BINARY NEW.grave_marker_root_sha256 AND r.store_db_timestamp_ms=NEW.store_db_timestamp_ms AND r.completed_claim_attempt=NEW.completed_claim_attempt AND BINARY r.completed_claim_token_sha256=BINARY NEW.completed_claim_token_sha256)
  AND EXISTS (SELECT 1 FROM tenant_purge_plan_receipts p WHERE BINARY p.request_id=BINARY NEW.request_id AND BINARY p.tenant_id=BINARY NEW.tenant_id AND p.subject_generation=NEW.subject_generation AND p.build_generation=NEW.plan_build_generation AND BINARY p.receipt_sha256=BINARY NEW.plan_receipt_sha256 AND BINARY p.t1_fence_sha256=BINARY NEW.t1_fence_sha256 AND BINARY p.t3c_receipt_sha256=BINARY NEW.t3c_receipt_sha256)
  AND (SELECT COUNT(*) FROM tenant_telemetry_owner_closure_entries e WHERE BINARY e.request_id=BINARY NEW.request_id AND BINARY e.tenant_id=BINARY NEW.tenant_id)=NEW.entry_count
  AND (SELECT COUNT(*) FROM tenant_telemetry_artifact_memberships m WHERE BINARY m.tenant_id=BINARY NEW.tenant_id)=NEW.entry_count
  AND (SELECT COUNT(*) FROM tenant_telemetry_write_jobs w WHERE BINARY w.tenant_id=BINARY NEW.tenant_id)=NEW.entry_count
  AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_write_jobs w LEFT JOIN tenant_telemetry_artifact_memberships m ON BINARY m.write_operation_sha256=BINARY w.write_operation_sha256 LEFT JOIN tenant_telemetry_owner_closure_entries e ON BINARY e.write_operation_sha256=BINARY w.write_operation_sha256 AND BINARY e.request_id=BINARY NEW.request_id WHERE BINARY w.tenant_id=BINARY NEW.tenant_id AND (m.write_operation_sha256 IS NULL OR e.write_operation_sha256 IS NULL))
) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry owner closure receipt lacks complete exact source'; END IF; END;

CREATE TRIGGER trg_tt_owner_closure_receipt_bu BEFORE UPDATE ON tenant_telemetry_owner_closure_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry owner closure receipt is immutable';
CREATE TRIGGER trg_tt_owner_closure_receipt_bd BEFORE DELETE ON tenant_telemetry_owner_closure_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry owner closure receipt is append-only';

-- Additive terminal-transition guard; published 0024 guards remain in place. Historical
-- terminal jobs do not transition again and are not relabelled or backfilled.
CREATE TRIGGER trg_tt_owner_closure_t3f_terminal_bu BEFORE UPDATE ON tenant_database_purge_jobs FOR EACH ROW BEGIN IF OLD.phase='queued' AND NEW.phase='database_purged' AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_owner_closure_receipts r WHERE BINARY r.request_id=BINARY NEW.request_id AND BINARY r.tenant_id=BINARY NEW.tenant_id AND r.subject_generation=NEW.subject_generation AND r.plan_build_generation=NEW.plan_build_generation AND r.execution_generation=NEW.execution_generation AND r.database_purge_generation=NEW.database_purge_generation AND BINARY r.t3f_receipt_sha256=BINARY NEW.terminal_receipt_sha256 AND r.store_db_timestamp_ms=NEW.purged_at_db_ms AND r.completed_claim_attempt=NEW.completed_claim_attempt AND BINARY r.completed_claim_token_sha256=BINARY NEW.completed_claim_token_sha256) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='terminal T3f lacks immutable telemetry owner closure'; END IF; END;

-- An additive immutable-identity guard on the existing writer table also makes the published
-- pre-0039 87-trigger fingerprint reject this schema at startup. It does not require historical
-- pre-0038 jobs to acquire membership and permits ordinary claim/written/blocked transitions.
CREATE TRIGGER trg_tt_owner_closure_write_job_bu BEFORE UPDATE ON tenant_telemetry_write_jobs FOR EACH ROW BEGIN IF (OLD.write_operation_sha256 <=> NEW.write_operation_sha256 AND OLD.tenant_id <=> NEW.tenant_id AND OLD.domain <=> NEW.domain AND OLD.inventory_sha256 <=> NEW.inventory_sha256) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry write job identity is immutable'; END IF; END;

SET @tt_owner_closure_previous_group_concat_max_len=@@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len=1048576;
-- agent-service-runtime-fingerprint:tenant-telemetry-owner-closure-schema:start
SET @tt_owner_closure_schema_ok=(
  (SELECT COUNT(*)=2 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,table_type,IFNULL(engine,'-'),IFNULL(table_collation,'-')) ORDER BY table_name SEPARATOR '|'),256)='741a26a966acefc5169f3e938e9ea247c6f5305c69facf65dbb42d0292dc8cc3'
     FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_owner_closure_entries','tenant_telemetry_owner_closure_receipts'))
  AND (SELECT COUNT(*)=40 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,LPAD(ordinal_position,3,'0'),column_name,LOWER(column_type),is_nullable,IF(column_default IS NULL,'<NULL>',CONCAT('<',column_default,'>')),IFNULL(character_set_name,'-'),IFNULL(collation_name,'-'),IFNULL(extra,'-'),IFNULL(generation_expression,'-')) ORDER BY table_name,ordinal_position SEPARATOR '|'),256)='56eaead361a58114abe5c94e1d1ca2ebd35b1c9be4c800660583b141411d343d'
     FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_owner_closure_entries','tenant_telemetry_owner_closure_receipts'))
  AND (SELECT COUNT(*)=25 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,index_name,LPAD(seq_in_index,3,'0'),column_name,non_unique,index_type,IFNULL(collation,'-'),IFNULL(sub_part,'-'),IFNULL(nullable,'-')) ORDER BY table_name,index_name,seq_in_index SEPARATOR '|'),256)='ec233ea69c629f2994e8ef30baa67aefc6d0b24166885bae3e75233cf5449319'
     FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_owner_closure_entries','tenant_telemetry_owner_closure_receipts'))
  AND (SELECT COUNT(*)=2 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',constraint_name,LOWER(REPLACE(REPLACE(REGEXP_REPLACE(check_clause,'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY constraint_name SEPARATOR '|'),256)='970364f4878cabf5f8d9376b831f3681a0c82a02cd331aa33ce4058d6e444075'
     FROM information_schema.check_constraints WHERE constraint_schema=DATABASE() AND constraint_name IN ('chk_tt_owner_closure_entry_shape','chk_tt_owner_closure_receipt_shape'))
  AND (SELECT COUNT(*)=13 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,constraint_type) ORDER BY table_name,constraint_name SEPARATOR '|'),256)='fca70cf928a443c791bed2954634ed648a101e66841c4ae32fa580a69261fb86'
     FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_owner_closure_entries','tenant_telemetry_owner_closure_receipts'))
  AND (SELECT COUNT(*)=7 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,referenced_table_name,update_rule,delete_rule) ORDER BY table_name,constraint_name SEPARATOR '|'),256)='8a189fb8234b0e04270845c071fc2804e3edde7db4ad21d0436814c1a49e7582'
     FROM information_schema.referential_constraints WHERE constraint_schema=DATABASE() AND table_name IN ('tenant_telemetry_owner_closure_entries','tenant_telemetry_owner_closure_receipts'))
  AND (SELECT COUNT(*)=20 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,LPAD(ordinal_position,3,'0'),column_name,referenced_table_name,referenced_column_name) ORDER BY table_name,constraint_name,ordinal_position SEPARATOR '|'),256)='a01245fa5846b64249b7d8a38e464d22056a3c4913c6726d86b2da5bf2dd01b9'
     FROM information_schema.key_column_usage WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_owner_closure_entries','tenant_telemetry_owner_closure_receipts') AND referenced_table_name IS NOT NULL)
  AND (SELECT COUNT(*)=0 FROM information_schema.partitions WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_owner_closure_entries','tenant_telemetry_owner_closure_receipts') AND partition_name IS NOT NULL)
);
-- agent-service-runtime-fingerprint:tenant-telemetry-owner-closure-schema:end
SET @migration_sql=IF(@tt_owner_closure_schema_ok=1,'SELECT 1','SELECT 1 FROM __invalid_tenant_telemetry_owner_closure_schema__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- 0038 87-trigger family, six append-only owner-closure guards and two additive guards.
-- agent-service-runtime-fingerprint:tenant-telemetry-owner-closure-triggers:start
SET @tt_owner_closure_triggers_ok=(
  SELECT COUNT(*)=95 AND COUNT(DISTINCT trigger_name)=95 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',event_object_table,trigger_name,action_timing,event_manipulation,action_orientation,IFNULL(action_condition,'<NULL>'),LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY event_object_table,trigger_name SEPARATOR '|'),256)='5f5761a5006354adf4392e78149cdf6e57999e1584c976de2e7b6d0004d8d277'
  FROM information_schema.triggers WHERE trigger_schema=DATABASE()
    AND (event_object_table IN ('sessions','subject_lifecycle','tenant_telemetry_lifecycle_control','tenant_telemetry_lifecycle_targets','tenant_telemetry_lifecycle_coverages','tenant_telemetry_lifecycle_subjects','tenant_telemetry_activation_receipts','tenant_telemetry_artifact_inventory','tenant_telemetry_write_jobs','tenant_telemetry_write_payloads','tenant_telemetry_write_acks','tenant_telemetry_application_domain_controls','tenant_telemetry_application_activation_receipts','tenant_telemetry_application_coverages','tenant_telemetry_application_write_bindings','tenant_telemetry_disposition_control','tenant_telemetry_disposition_activation_receipts','tenant_telemetry_disposition_jobs','tenant_telemetry_disposition_authorization_grants','tenant_telemetry_disposition_external_authorizations','tenant_telemetry_disposition_external_events','tenant_telemetry_disposition_tombstone_acks','tenant_telemetry_disposition_receipts','tenant_telemetry_disposition_replay_fences','tenant_telemetry_artifact_memberships','tenant_telemetry_owner_closure_entries','tenant_telemetry_owner_closure_receipts') OR (event_object_table='tenant_credential_revocation_jobs' AND action_timing='BEFORE' AND event_manipulation='INSERT') OR (event_object_table='tenant_database_purge_jobs' AND BINARY trigger_name=BINARY 'trg_tt_owner_closure_t3f_terminal_bu'))
);
-- agent-service-runtime-fingerprint:tenant-telemetry-owner-closure-triggers:end
SET @migration_sql=IF(@tt_owner_closure_triggers_ok=1,'SELECT 1','SELECT 1 FROM __invalid_tenant_telemetry_owner_closure_triggers__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
SET SESSION group_concat_max_len=@tt_owner_closure_previous_group_concat_max_len;

-- Marker-loss replay must not launder an orphaned partial closure or executable disposition.
SET @tt_owner_closure_projection_ok=(
  NOT EXISTS (SELECT 1 FROM tenant_telemetry_owner_closure_entries e LEFT JOIN tenant_telemetry_artifact_memberships m ON BINARY m.write_operation_sha256=BINARY e.write_operation_sha256 WHERE m.write_operation_sha256 IS NULL)
  -- An entry can precede its aggregate only inside the same uncommitted T3f transaction.
  -- A committed entry without a matching terminal receipt is an impossible partial publish.
  AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_owner_closure_entries e
    LEFT JOIN tenant_telemetry_owner_closure_receipts r ON BINARY r.request_id=BINARY e.request_id
      AND BINARY r.tenant_id=BINARY e.tenant_id AND r.subject_generation=e.subject_generation
      AND r.plan_build_generation=e.plan_build_generation AND r.execution_generation=e.execution_generation
      AND r.database_purge_generation=e.database_purge_generation
    LEFT JOIN tenant_database_purge_jobs j ON BINARY j.request_id=BINARY e.request_id
      AND BINARY j.tenant_id=BINARY e.tenant_id AND j.subject_generation=e.subject_generation
      AND j.plan_build_generation=e.plan_build_generation AND j.execution_generation=e.execution_generation
      AND j.database_purge_generation=e.database_purge_generation
    WHERE r.request_id IS NULL OR j.request_id IS NULL OR j.phase<>'database_purged'
      OR BINARY j.terminal_receipt_sha256<>BINARY r.t3f_receipt_sha256)
  AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_owner_closure_receipts r LEFT JOIN tenant_database_purge_jobs j ON BINARY j.request_id=BINARY r.request_id WHERE j.request_id IS NULL OR j.phase<>'database_purged' OR BINARY j.terminal_receipt_sha256<>BINARY r.t3f_receipt_sha256)
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_jobs)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_authorization_grants)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_external_authorizations)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_external_events)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_tombstone_acks)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_receipts)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_replay_fences)=0
);
SET @migration_sql=IF(@tt_owner_closure_projection_ok=1,'SELECT 1','SELECT 1 FROM __invalid_tenant_telemetry_owner_closure_projection__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
