-- 0058: dormant, stopped-fleet second capture backup/restore. Published
-- 0055-0057 bytes and v1 receipts are immutable. The 27-family capsule is
-- additive; old or partial migration must not be used by a running writer.
CREATE TABLE tenant_telemetry_capture_checkpoint_lineage_leaves (
  backup_id VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  family VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  identity_ref_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  record_hmac_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_high_water_db_ms BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (backup_id,family,identity_ref_sha256),
  KEY idx_tt_capture_lineage_family (family,backup_id),
  CONSTRAINT fk_tt_capture_lineage_header FOREIGN KEY (backup_id)
    REFERENCES tenant_telemetry_capture_backup_checkpoints(backup_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tt_capture_lineage_shape CHECK ((
    family IN ('checkpoint','checkpoint_leaf','checkpoint_lineage_leaf',
      'restore_binding','restore_history','epoch_cutover','recovery_permit',
      'recovery_permit_v2','journal_control','journal_job','journal_target',
      'journal_ack','journal_receipt','replay_run','restore_fence',
      'replay_entry','runtime_control','runtime_head','runtime_known_entry',
      'runtime_event','catalog_control','catalog_event','catalog_anchor',
      'catalog_entry','catalog_source_binding','catalog_reservation','catalog_eviction')
    AND identity_ref_sha256 REGEXP '^[0-9a-f]{64}$'
    AND record_hmac_sha256 REGEXP '^[0-9a-f]{64}$'
  ) IS TRUE)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;


-- The published v1 header remains byte-identical. A v2 header can only be
-- born under the actual restored runtime/cutover; lineage leaves are added
-- after the header in the same RR publication transaction.
CREATE TRIGGER trg_tt_capture_checkpoint_header_bi BEFORE INSERT ON tenant_telemetry_capture_backup_checkpoints FOR EACH ROW BEGIN IF ((BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.checkpoint_json,'$.scope'))=BINARY 'tenant-telemetry-capture-backup-checkpoint-v1' AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.checkpoint_json,'$.protocol'))=BINARY 'tenant-telemetry-capture-restore-v1') OR (BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.checkpoint_json,'$.scope'))=BINARY 'tenant-telemetry-capture-backup-checkpoint-v2' AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.checkpoint_json,'$.protocol'))=BINARY 'tenant-telemetry-capture-restore-v2' AND EXISTS (SELECT 1 FROM tenant_restore_runtime_control r JOIN tenant_telemetry_capture_epoch_cutovers x ON BINARY x.restore_run_id=BINARY r.restore_run_id AND BINARY x.runtime_epoch_sha256=BINARY r.runtime_epoch_sha256 WHERE r.singleton_id=1 AND r.state='active' AND r.lineage_kind='restore' AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.checkpoint_json,'$.lineage.sourceRestoreRunId'))=BINARY x.restore_run_id AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.checkpoint_json,'$.lineage.sourceCaptureCutoverReceiptSha256'))=BINARY x.cutover_receipt_sha256 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.checkpoint_json,'$.lineage.sourceRuntimeEpochSha256'))=BINARY x.runtime_epoch_sha256 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.checkpoint_json,'$.lineage.sourceRuntimeBindingSha256'))=BINARY JSON_UNQUOTE(JSON_EXTRACT(x.receipt_json,'$.runtimeBindingSha256'))))) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture checkpoint requires exact source epoch'; END IF; END;
CREATE TRIGGER trg_tt_capture_checkpoint_lineage_bi BEFORE INSERT ON tenant_telemetry_capture_checkpoint_lineage_leaves FOR EACH ROW BEGIN IF (EXISTS (SELECT 1 FROM tenant_telemetry_capture_backup_checkpoints h WHERE BINARY h.backup_id=BINARY NEW.backup_id AND BINARY JSON_UNQUOTE(JSON_EXTRACT(h.checkpoint_json,'$.scope'))=BINARY 'tenant-telemetry-capture-backup-checkpoint-v2' AND BINARY JSON_UNQUOTE(JSON_EXTRACT(h.checkpoint_json,'$.protocol'))=BINARY 'tenant-telemetry-capture-restore-v2')) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture lineage requires v2 checkpoint'; END IF; END;
CREATE TRIGGER trg_tt_capture_checkpoint_lineage_bu BEFORE UPDATE ON tenant_telemetry_capture_checkpoint_lineage_leaves FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture lineage leaf is immutable';
CREATE TRIGGER trg_tt_capture_checkpoint_lineage_bd BEFORE DELETE ON tenant_telemetry_capture_checkpoint_lineage_leaves FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture lineage leaf is immutable';

CREATE TABLE tenant_telemetry_capture_recovery_permits_v2 (
  write_operation_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  new_claim_attempt BIGINT UNSIGNED NOT NULL,
  restore_run_id VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  cutover_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  checkpoint_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  previous_permit_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  predecessor_key_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  previous_claim_attempt BIGINT UNSIGNED NOT NULL,
  new_claim_token_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  new_claim_lease_until_ms BIGINT UNSIGNED NOT NULL,
  claim_lease_ceiling_ms BIGINT UNSIGNED NOT NULL,
  issued_at_db_ms BIGINT UNSIGNED NOT NULL,
  genesis_checkpoint_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  snapshot_job_state VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  snapshot_job_evidence_hmac_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  snapshot_reservation_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  snapshot_reservation_evidence_hmac_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  predecessor_lineage_evidence_hmac_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  reservation_authorizer_lineage_evidence_hmac_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  permit_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  receipt_json JSON NOT NULL,
  PRIMARY KEY (write_operation_sha256,new_claim_attempt),
  UNIQUE KEY uk_tt_capture_recovery_v2_receipt (permit_receipt_sha256),
  UNIQUE KEY uk_tt_capture_recovery_v2_predecessor (write_operation_sha256,predecessor_key_sha256),
  KEY idx_tt_capture_recovery_v2_run (restore_run_id,write_operation_sha256,new_claim_attempt),
  CONSTRAINT fk_tt_capture_recovery_v2_job FOREIGN KEY (write_operation_sha256)
    REFERENCES tenant_telemetry_write_jobs(write_operation_sha256) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tt_capture_recovery_v2_cutover FOREIGN KEY (restore_run_id)
    REFERENCES tenant_telemetry_capture_epoch_cutovers(restore_run_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tt_capture_recovery_v2_shape CHECK ((
    write_operation_sha256 REGEXP '^[0-9a-f]{64}$'
    AND restore_run_id REGEXP '^restore_[0-9a-f-]{36}$'
    AND cutover_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND checkpoint_sha256 REGEXP '^[0-9a-f]{64}$'
    AND genesis_checkpoint_sha256 REGEXP '^[0-9a-f]{64}$'
    AND (previous_permit_receipt_sha256 IS NULL OR previous_permit_receipt_sha256 REGEXP '^[0-9a-f]{64}$')
    AND predecessor_key_sha256 REGEXP '^[0-9a-f]{64}$'
    AND previous_claim_attempt<new_claim_attempt AND new_claim_attempt=previous_claim_attempt+1
    AND new_claim_token_sha256 REGEXP '^[0-9a-f]{64}$'
    AND permit_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND snapshot_job_state IN ('queued','reserved')
    AND snapshot_job_evidence_hmac_sha256 REGEXP '^[0-9a-f]{64}$'
    AND (snapshot_reservation_receipt_sha256 IS NULL)=(snapshot_reservation_evidence_hmac_sha256 IS NULL)
    AND (snapshot_job_state='reserved')=(snapshot_reservation_receipt_sha256 IS NOT NULL)
    AND (snapshot_reservation_receipt_sha256 IS NULL OR snapshot_reservation_receipt_sha256 REGEXP '^[0-9a-f]{64}$')
    AND (snapshot_reservation_evidence_hmac_sha256 IS NULL OR snapshot_reservation_evidence_hmac_sha256 REGEXP '^[0-9a-f]{64}$')
    AND (predecessor_lineage_evidence_hmac_sha256 IS NULL OR predecessor_lineage_evidence_hmac_sha256 REGEXP '^[0-9a-f]{64}$')
    AND (reservation_authorizer_lineage_evidence_hmac_sha256 IS NULL OR reservation_authorizer_lineage_evidence_hmac_sha256 REGEXP '^[0-9a-f]{64}$')
    AND issued_at_db_ms<new_claim_lease_until_ms
    AND new_claim_lease_until_ms<=claim_lease_ceiling_ms
    AND claim_lease_ceiling_ms<=issued_at_db_ms+300000
    AND JSON_TYPE(receipt_json)='OBJECT'
    AND BINARY JSON_UNQUOTE(JSON_EXTRACT(receipt_json,'$.scope'))=BINARY 'tenant-telemetry-capture-operation-recovery-v2'
    AND BINARY JSON_UNQUOTE(JSON_EXTRACT(receipt_json,'$.writeOperationSha256'))=BINARY write_operation_sha256
    AND BINARY JSON_UNQUOTE(JSON_EXTRACT(receipt_json,'$.restoreRunId'))=BINARY restore_run_id
    AND BINARY JSON_UNQUOTE(JSON_EXTRACT(receipt_json,'$.cutoverReceiptSha256'))=BINARY cutover_receipt_sha256
    AND BINARY JSON_UNQUOTE(JSON_EXTRACT(receipt_json,'$.checkpointSha256'))=BINARY checkpoint_sha256
    AND BINARY JSON_UNQUOTE(JSON_EXTRACT(receipt_json,'$.genesisCheckpointSha256'))=BINARY genesis_checkpoint_sha256
    AND BINARY JSON_UNQUOTE(JSON_EXTRACT(receipt_json,'$.snapshotJobState'))=BINARY snapshot_job_state
    AND BINARY JSON_UNQUOTE(JSON_EXTRACT(receipt_json,'$.snapshotJobEvidenceHmacSha256'))=BINARY snapshot_job_evidence_hmac_sha256
    AND BINARY JSON_UNQUOTE(JSON_EXTRACT(receipt_json,'$.receiptSha256'))=BINARY permit_receipt_sha256
    AND JSON_EXTRACT(receipt_json,'$.previousClaimAttempt')=previous_claim_attempt
    AND JSON_EXTRACT(receipt_json,'$.newClaimAttempt')=new_claim_attempt
    AND JSON_EXTRACT(receipt_json,'$.newClaimLeaseUntilMs')=new_claim_lease_until_ms
    AND JSON_EXTRACT(receipt_json,'$.claimLeaseCeilingMs')=claim_lease_ceiling_ms
    AND JSON_EXTRACT(receipt_json,'$.issuedAtDbMs')=issued_at_db_ms
  ) IS TRUE)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
-- A v2 permit is a successor in the union of the published v1 and new v2
-- ledgers. The job row is subsequently CAS-updated in the SAME RR transaction;
-- this trigger never converts a receipt into write authority by itself.
CREATE TRIGGER trg_tt_capture_recovery_permit_v2_bi BEFORE INSERT ON tenant_telemetry_capture_recovery_permits_v2 FOR EACH ROW BEGIN IF (EXISTS (SELECT 1 FROM tenant_restore_runtime_control r JOIN tenant_telemetry_capture_epoch_cutovers c ON BINARY c.restore_run_id=BINARY r.restore_run_id AND BINARY c.runtime_epoch_sha256=BINARY r.runtime_epoch_sha256 JOIN tenant_telemetry_capture_backup_checkpoints h ON BINARY h.checkpoint_sha256=BINARY c.checkpoint_sha256 JOIN tenant_telemetry_write_jobs j ON BINARY j.write_operation_sha256=BINARY NEW.write_operation_sha256 WHERE r.singleton_id=1 AND r.state='active' AND r.lineage_kind='restore' AND BINARY c.restore_run_id=BINARY NEW.restore_run_id AND BINARY c.cutover_receipt_sha256=BINARY NEW.cutover_receipt_sha256 AND BINARY c.checkpoint_sha256=BINARY NEW.checkpoint_sha256 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(h.checkpoint_json,'$.scope'))=BINARY 'tenant-telemetry-capture-backup-checkpoint-v2' AND j.phase='queued' AND j.attempts=NEW.previous_claim_attempt AND ((j.claim_token IS NULL AND j.lease_until_ms IS NULL) OR (j.claim_token IS NOT NULL AND j.lease_until_ms<=NEW.issued_at_db_ms)) AND NEW.new_claim_attempt=j.attempts+1 AND NEW.issued_at_db_ms>=c.activated_at_db_ms AND BINARY NEW.predecessor_key_sha256=BINARY COALESCE(NEW.previous_permit_receipt_sha256,REPEAT('0',64)) AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_capture_recovery_permits p WHERE BINARY p.write_operation_sha256=BINARY NEW.write_operation_sha256 AND (p.new_claim_attempt=NEW.new_claim_attempt OR BINARY p.permit_receipt_sha256=BINARY NEW.permit_receipt_sha256)) AND ((NEW.previous_permit_receipt_sha256 IS NULL AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_capture_recovery_permits p WHERE BINARY p.write_operation_sha256=BINARY NEW.write_operation_sha256) AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_capture_recovery_permits_v2 p WHERE BINARY p.write_operation_sha256=BINARY NEW.write_operation_sha256)) OR (EXISTS (SELECT 1 FROM tenant_telemetry_capture_recovery_permits p WHERE BINARY p.write_operation_sha256=BINARY NEW.write_operation_sha256 AND BINARY p.permit_receipt_sha256=BINARY NEW.previous_permit_receipt_sha256 AND p.new_claim_attempt=NEW.previous_claim_attempt) OR EXISTS (SELECT 1 FROM tenant_telemetry_capture_recovery_permits_v2 p WHERE BINARY p.write_operation_sha256=BINARY NEW.write_operation_sha256 AND BINARY p.permit_receipt_sha256=BINARY NEW.previous_permit_receipt_sha256 AND p.new_claim_attempt=NEW.previous_claim_attempt)) AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_capture_recovery_permits p WHERE BINARY p.write_operation_sha256=BINARY NEW.write_operation_sha256 AND p.new_claim_attempt>NEW.previous_claim_attempt) AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_capture_recovery_permits_v2 p WHERE BINARY p.write_operation_sha256=BINARY NEW.write_operation_sha256 AND p.new_claim_attempt>NEW.previous_claim_attempt)) AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.receipt_json,'$.newClaimTokenSha256'))=BINARY NEW.new_claim_token_sha256)) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture v2 recovery permit requires exact predecessor'; END IF; END;
CREATE TRIGGER trg_tt_capture_recovery_permit_v2_bu BEFORE UPDATE ON tenant_telemetry_capture_recovery_permits_v2 FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture v2 recovery permit is immutable';
CREATE TRIGGER trg_tt_capture_recovery_permit_v2_bd BEFORE DELETE ON tenant_telemetry_capture_recovery_permits_v2 FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture v2 recovery permit is immutable';

-- Temporary hard-deny guards are installed before each published guard is
-- rotated. Every intermediate DDL state rejects old/new recovery writes;
-- operators must stop and drain all pre-0058 writers before applying this.
CREATE TRIGGER trg_tt_capture_repeat_bootstrap_permit_bi BEFORE INSERT ON tenant_telemetry_capture_recovery_permits FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture repeat migration is incomplete';
CREATE TRIGGER trg_tt_capture_repeat_bootstrap_job_bu BEFORE UPDATE ON tenant_telemetry_write_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture repeat migration is incomplete';
CREATE TRIGGER trg_tt_capture_repeat_bootstrap_ack_bi BEFORE INSERT ON tenant_telemetry_write_acks FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture repeat migration is incomplete';

DROP TRIGGER trg_tt_capture_recovery_permit_bi;
CREATE TRIGGER trg_tt_capture_recovery_permit_bi BEFORE INSERT ON tenant_telemetry_capture_recovery_permits FOR EACH ROW BEGIN IF (EXISTS (SELECT 1 FROM tenant_telemetry_capture_epoch_cutovers c JOIN tenant_telemetry_write_jobs j ON BINARY j.write_operation_sha256=BINARY NEW.write_operation_sha256 WHERE BINARY c.restore_run_id=BINARY NEW.restore_run_id AND BINARY c.cutover_receipt_sha256=BINARY NEW.cutover_receipt_sha256 AND BINARY c.checkpoint_sha256=BINARY NEW.checkpoint_sha256 AND j.phase='queued' AND j.attempts=NEW.previous_claim_attempt AND ((j.claim_token IS NULL AND j.lease_until_ms IS NULL) OR (j.claim_token IS NOT NULL AND j.lease_until_ms<=NEW.issued_at_db_ms)) AND NEW.new_claim_attempt=j.attempts+1 AND NEW.issued_at_db_ms>=c.activated_at_db_ms AND NEW.predecessor_key_sha256=COALESCE(NEW.previous_permit_receipt_sha256,REPEAT('0',64)) AND ((NEW.previous_permit_receipt_sha256 IS NULL AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_capture_recovery_permits p WHERE BINARY p.write_operation_sha256=BINARY NEW.write_operation_sha256)) OR EXISTS (SELECT 1 FROM tenant_telemetry_capture_recovery_permits p WHERE BINARY p.write_operation_sha256=BINARY NEW.write_operation_sha256 AND BINARY p.permit_receipt_sha256=BINARY NEW.previous_permit_receipt_sha256 AND p.new_claim_attempt=NEW.previous_claim_attempt AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_capture_recovery_permits q WHERE BINARY q.write_operation_sha256=BINARY p.write_operation_sha256 AND q.new_claim_attempt>p.new_claim_attempt))) AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.receipt_json,'$.newClaimTokenSha256'))=BINARY NEW.new_claim_token_sha256)) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture recovery permit requires exact expired predecessor'; END IF; IF (EXISTS (SELECT 1 FROM tenant_telemetry_capture_epoch_cutovers c JOIN tenant_restore_runtime_control r ON r.singleton_id=1 AND r.state='active' AND r.lineage_kind='restore' AND BINARY r.restore_run_id=BINARY c.restore_run_id AND BINARY r.runtime_epoch_sha256=BINARY c.runtime_epoch_sha256 JOIN tenant_telemetry_capture_backup_checkpoints h ON BINARY h.checkpoint_sha256=BINARY c.checkpoint_sha256 WHERE BINARY c.restore_run_id=BINARY NEW.restore_run_id AND BINARY JSON_UNQUOTE(JSON_EXTRACT(h.checkpoint_json,'$.scope'))=BINARY 'tenant-telemetry-capture-backup-checkpoint-v1') AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_capture_recovery_permits_v2 p WHERE BINARY p.write_operation_sha256=BINARY NEW.write_operation_sha256 AND (p.new_claim_attempt=NEW.new_claim_attempt OR BINARY p.permit_receipt_sha256=BINARY NEW.permit_receipt_sha256))) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture v1 recovery permit cannot cross repeat restore'; END IF; END;
DROP TRIGGER trg_tt_capture_recovery_write_job_bu;
CREATE TRIGGER trg_tt_capture_recovery_write_job_bu BEFORE UPDATE ON tenant_telemetry_write_jobs FOR EACH ROW BEGIN IF JSON_UNQUOTE(JSON_EXTRACT(OLD.inventory_json,'$.sourceSchema'))='provider-step-error-v2' AND EXISTS (SELECT 1 FROM tenant_restore_runtime_control r WHERE r.singleton_id=1 AND r.state='active' AND r.lineage_kind='restore' AND BINARY r.runtime_epoch_sha256<>BINARY JSON_UNQUOTE(JSON_EXTRACT(OLD.inventory_json,'$.runtimeEpochSha256'))) THEN IF (EXISTS (SELECT 1 FROM tenant_telemetry_capture_epoch_cutovers c JOIN (SELECT write_operation_sha256,new_claim_attempt,restore_run_id,cutover_receipt_sha256,checkpoint_sha256,new_claim_token_sha256,claim_lease_ceiling_ms,receipt_json,1 AS permit_version FROM tenant_telemetry_capture_recovery_permits UNION ALL SELECT write_operation_sha256,new_claim_attempt,restore_run_id,cutover_receipt_sha256,checkpoint_sha256,new_claim_token_sha256,claim_lease_ceiling_ms,receipt_json,2 AS permit_version FROM tenant_telemetry_capture_recovery_permits_v2) p ON BINARY p.restore_run_id=BINARY c.restore_run_id AND BINARY p.cutover_receipt_sha256=BINARY c.cutover_receipt_sha256 JOIN tenant_telemetry_capture_backup_checkpoints h ON BINARY h.checkpoint_sha256=BINARY c.checkpoint_sha256 JOIN tenant_restore_runtime_control r ON r.singleton_id=1 AND r.state='active' AND r.lineage_kind='restore' WHERE ((p.permit_version=1 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(h.checkpoint_json,'$.scope'))=BINARY 'tenant-telemetry-capture-backup-checkpoint-v1') OR (p.permit_version=2 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(h.checkpoint_json,'$.scope'))=BINARY 'tenant-telemetry-capture-backup-checkpoint-v2')) AND BINARY c.restore_run_id=BINARY r.restore_run_id AND BINARY c.runtime_epoch_sha256=BINARY r.runtime_epoch_sha256 AND BINARY p.write_operation_sha256=BINARY OLD.write_operation_sha256 AND p.new_claim_attempt=NEW.attempts AND NEW.attempts>=OLD.attempts AND BINARY p.checkpoint_sha256=BINARY c.checkpoint_sha256 AND (NEW.claim_token IS NULL OR (NEW.lease_until_ms IS NOT NULL AND NEW.lease_until_ms<=p.claim_lease_ceiling_ms AND BINARY p.new_claim_token_sha256=BINARY SHA2(CONCAT('["tenant-telemetry-write-claim-token-v1","',NEW.claim_token,'"]'),256))) AND (OLD.mutation_reservation_receipt_sha256 IS NOT NULL OR NEW.mutation_reservation_receipt_sha256 IS NULL OR (JSON_UNQUOTE(JSON_EXTRACT(p.receipt_json,'$.newReservationAuthorized'))='true' AND JSON_UNQUOTE(JSON_EXTRACT(p.receipt_json,'$.recoveryMode'))='resume_queued' AND NEW.mutation_started_claim_attempt=p.new_claim_attempt AND BINARY NEW.mutation_started_claim_token_sha256=BINARY p.new_claim_token_sha256)) AND (NEW.phase<>'written' OR (NEW.completed_claim_attempt=p.new_claim_attempt AND BINARY NEW.completed_claim_token_sha256=BINARY p.new_claim_token_sha256 AND NEW.written_at_db_ms<=p.claim_lease_ceiling_ms)))) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restored capture job transition lacks exact recovery permit'; END IF; END IF; END;
DROP TRIGGER trg_tt_capture_recovery_write_ack_bi;
CREATE TRIGGER trg_tt_capture_recovery_write_ack_bi BEFORE INSERT ON tenant_telemetry_write_acks FOR EACH ROW BEGIN IF EXISTS (SELECT 1 FROM tenant_telemetry_write_jobs j JOIN tenant_restore_runtime_control r ON r.singleton_id=1 AND r.state='active' AND r.lineage_kind='restore' WHERE BINARY j.write_operation_sha256=BINARY NEW.write_operation_sha256 AND JSON_UNQUOTE(JSON_EXTRACT(j.inventory_json,'$.sourceSchema'))='provider-step-error-v2' AND BINARY r.runtime_epoch_sha256<>BINARY JSON_UNQUOTE(JSON_EXTRACT(j.inventory_json,'$.runtimeEpochSha256'))) THEN IF (EXISTS (SELECT 1 FROM tenant_telemetry_write_jobs j JOIN (SELECT write_operation_sha256,new_claim_attempt,restore_run_id,cutover_receipt_sha256,checkpoint_sha256,new_claim_token_sha256,claim_lease_ceiling_ms,receipt_json,1 AS permit_version FROM tenant_telemetry_capture_recovery_permits UNION ALL SELECT write_operation_sha256,new_claim_attempt,restore_run_id,cutover_receipt_sha256,checkpoint_sha256,new_claim_token_sha256,claim_lease_ceiling_ms,receipt_json,2 AS permit_version FROM tenant_telemetry_capture_recovery_permits_v2) p ON BINARY p.write_operation_sha256=BINARY j.write_operation_sha256 AND p.new_claim_attempt=j.attempts JOIN tenant_telemetry_capture_epoch_cutovers c ON BINARY c.restore_run_id=BINARY p.restore_run_id AND BINARY c.cutover_receipt_sha256=BINARY p.cutover_receipt_sha256 JOIN tenant_telemetry_capture_backup_checkpoints h ON BINARY h.checkpoint_sha256=BINARY c.checkpoint_sha256 JOIN tenant_restore_runtime_control r ON r.singleton_id=1 AND r.state='active' AND r.lineage_kind='restore' WHERE BINARY j.write_operation_sha256=BINARY NEW.write_operation_sha256 AND ((p.permit_version=1 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(h.checkpoint_json,'$.scope'))=BINARY 'tenant-telemetry-capture-backup-checkpoint-v1') OR (p.permit_version=2 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(h.checkpoint_json,'$.scope'))=BINARY 'tenant-telemetry-capture-backup-checkpoint-v2')) AND BINARY c.restore_run_id=BINARY r.restore_run_id AND BINARY c.runtime_epoch_sha256=BINARY r.runtime_epoch_sha256 AND j.phase='queued' AND j.claim_token IS NOT NULL AND j.lease_until_ms IS NOT NULL AND j.lease_until_ms<=p.claim_lease_ceiling_ms AND p.new_claim_attempt=NEW.completed_claim_attempt AND BINARY p.new_claim_token_sha256=BINARY NEW.completed_claim_token_sha256 AND BINARY j.mutation_reservation_receipt_sha256=BINARY NEW.reservation_receipt_sha256 AND NEW.store_db_timestamp_ms<=p.claim_lease_ceiling_ms)) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restored capture ACK lacks exact recovery permit'; END IF; END IF; END;

DROP TRIGGER trg_tt_capture_repeat_bootstrap_permit_bi;
DROP TRIGGER trg_tt_capture_repeat_bootstrap_job_bu;
DROP TRIGGER trg_tt_capture_repeat_bootstrap_ack_bi;

-- DERIVE ONLY ON A NEW, ISOLATED MySQL 8.0.26 test database. The eight zero
-- roots deliberately make this unpublished migration fail before any DDL in
-- the runtime preflight. The complete final trigger set includes all 735
-- guards; the temporary deny triggers above must be absent at this point.
SET @tt_capture_repeat_previous_gcml=@@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len=1048576;
-- agent-service-runtime-fingerprint:tenant-telemetry-capture-repeat-restore-schema:start
SET @tt_capture_repeat_schema_ok=(
  (SELECT COUNT(*)=2 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,table_type,IFNULL(engine,'-'),IFNULL(table_collation,'-'),IFNULL(row_format,'-'),IFNULL(create_options,'-')) ORDER BY table_name SEPARATOR '|'),256)='f0a8e5cfae6602f1cfda6d67117446a3befc63a7a94efb603ef264805b67c059'
    FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_capture_checkpoint_lineage_leaves','tenant_telemetry_capture_recovery_permits_v2'))
  AND (SELECT COUNT(*)=26 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,LPAD(ordinal_position,3,'0'),column_name,LOWER(column_type),is_nullable,IF(column_default IS NULL,'<NULL>',CONCAT('<',column_default,'>')),IFNULL(character_set_name,'-'),IFNULL(collation_name,'-'),IFNULL(extra,'-'),IFNULL(generation_expression,'-')) ORDER BY table_name,ordinal_position SEPARATOR '|'),256)='ad0a09c149a23cc42dbc4c097333477ab40ec777874802c4467611fd261cb96d'
    FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_capture_checkpoint_lineage_leaves','tenant_telemetry_capture_recovery_permits_v2'))
  AND (SELECT COUNT(*)=13 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,index_name,LPAD(seq_in_index,3,'0'),column_name,non_unique,index_type,IFNULL(collation,'-'),IFNULL(sub_part,'-'),IFNULL(nullable,'-')) ORDER BY table_name,index_name,seq_in_index SEPARATOR '|'),256)='4211c8f8460c36d96833d509fae0d73a0c5738a3bec69cb105013a44167cb0a1'
    FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_capture_checkpoint_lineage_leaves','tenant_telemetry_capture_recovery_permits_v2'))
  AND (SELECT COUNT(*)=2 AND SUM(enforced='YES')=2 FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND constraint_name IN ('chk_tt_capture_lineage_shape','chk_tt_capture_recovery_v2_shape') AND constraint_type='CHECK')
  AND (SELECT COUNT(*)=2 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',constraint_name,LOWER(REPLACE(REPLACE(REGEXP_REPLACE(check_clause,'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY constraint_name SEPARATOR '|'),256)='cd0bbc38f93c3708b8bb772c5d40dcdc43fd63a3e4fe47d671d66f52d5b2317a'
    FROM information_schema.check_constraints WHERE constraint_schema=DATABASE() AND constraint_name IN ('chk_tt_capture_lineage_shape','chk_tt_capture_recovery_v2_shape'))
  AND (SELECT COUNT(*)=9 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,constraint_type) ORDER BY table_name,constraint_name SEPARATOR '|'),256)='79e4ae5c0f77a28c80358c42da608da754f51a6c1b612205f1fcf4488bb8ac4b'
    FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_capture_checkpoint_lineage_leaves','tenant_telemetry_capture_recovery_permits_v2'))
  AND (SELECT COUNT(*)=3 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,referenced_table_name,update_rule,delete_rule) ORDER BY table_name,constraint_name SEPARATOR '|'),256)='e2741c9dc956a27d5423ef86d1dd794cd1135b98c18349f0758118512b964c0d'
    FROM information_schema.referential_constraints WHERE constraint_schema=DATABASE() AND table_name IN ('tenant_telemetry_capture_checkpoint_lineage_leaves','tenant_telemetry_capture_recovery_permits_v2'))
  AND (SELECT COUNT(*)=3 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,LPAD(ordinal_position,3,'0'),column_name,referenced_table_name,referenced_column_name) ORDER BY table_name,constraint_name,ordinal_position SEPARATOR '|'),256)='404f96586aeadf5b9dbb4cf36e404e7fce90182006455a32b818947261083c47'
    FROM information_schema.key_column_usage WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_capture_checkpoint_lineage_leaves','tenant_telemetry_capture_recovery_permits_v2') AND referenced_table_name IS NOT NULL)
  AND (SELECT COUNT(*)=0 FROM information_schema.partitions WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_capture_checkpoint_lineage_leaves','tenant_telemetry_capture_recovery_permits_v2') AND partition_name IS NOT NULL)
);
-- agent-service-runtime-fingerprint:tenant-telemetry-capture-repeat-restore-schema:end
SET @migration_sql=IF(@tt_capture_repeat_schema_ok=1,'SELECT 1','SELECT 1 FROM __invalid_tenant_telemetry_capture_repeat_schema__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- agent-service-runtime-fingerprint:tenant-telemetry-capture-repeat-restore-triggers:start
SET @tt_capture_repeat_triggers_ok=(
  SELECT COUNT(*)=735 AND COUNT(DISTINCT trigger_name)=735
    AND SUM(trigger_name IN ('trg_tt_capture_repeat_bootstrap_permit_bi','trg_tt_capture_repeat_bootstrap_job_bu','trg_tt_capture_repeat_bootstrap_ack_bi'))=0
    AND SUM(trigger_name IN ('trg_tt_capture_checkpoint_header_bi','trg_tt_capture_checkpoint_lineage_bi','trg_tt_capture_checkpoint_lineage_bu','trg_tt_capture_checkpoint_lineage_bd','trg_tt_capture_recovery_permit_v2_bi','trg_tt_capture_recovery_permit_v2_bu','trg_tt_capture_recovery_permit_v2_bd'))=7
    AND SUM(OCTET_LENGTH(CONCAT_WS('~',event_object_table,trigger_name,action_timing,event_manipulation,action_orientation,IFNULL(action_condition,'<NULL>'),LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),CHAR(96),''),'_utf8mb4','')))))+COUNT(*)-1<=@@SESSION.group_concat_max_len
    AND SHA2(GROUP_CONCAT(CONCAT_WS('~',event_object_table,trigger_name,action_timing,event_manipulation,action_orientation,IFNULL(action_condition,'<NULL>'),LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY event_object_table,trigger_name SEPARATOR '|'),256)='42492cfab9a7bde49c08b018955fbc3ec0a7a93048c527bf551433a89c0ec011'
  FROM information_schema.triggers WHERE trigger_schema=DATABASE()
);
-- agent-service-runtime-fingerprint:tenant-telemetry-capture-repeat-restore-triggers:end
SET @migration_sql=IF(@tt_capture_repeat_triggers_ok=1,'SELECT 1','SELECT 1 FROM __invalid_tenant_telemetry_capture_repeat_triggers__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
SET SESSION group_concat_max_len=@tt_capture_repeat_previous_gcml;
