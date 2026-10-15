-- 0057: local-only, exact 0055/0056 restore epoch cutover and per-operation
-- recovery. No old receipt is rewritten; no 0037 grant, external deletion,
-- destructive restored-epoch eligibility or production activation is granted.
-- All pre-0057 writers must be stopped and drained before this migration.
CREATE TABLE tenant_telemetry_capture_epoch_cutovers (
  restore_run_id VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  runtime_epoch_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  history_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  checkpoint_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  configured_fleet_root_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  cutover_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  activated_at_db_ms BIGINT UNSIGNED NOT NULL,
  receipt_json JSON NOT NULL,
  PRIMARY KEY (restore_run_id),
  UNIQUE KEY uk_tt_capture_epoch_cutover_receipt (cutover_receipt_sha256),
  CONSTRAINT fk_tt_capture_epoch_cutover_history FOREIGN KEY (restore_run_id)
    REFERENCES tenant_telemetry_capture_restore_history_receipts(restore_run_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tt_capture_epoch_cutover_shape CHECK ((
    restore_run_id REGEXP '^restore_[0-9a-f-]{36}$'
    AND runtime_epoch_sha256 REGEXP '^[0-9a-f]{64}$'
    AND history_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND checkpoint_sha256 REGEXP '^[0-9a-f]{64}$'
    AND configured_fleet_root_sha256 REGEXP '^[0-9a-f]{64}$'
    AND cutover_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND JSON_TYPE(receipt_json)='OBJECT'
    AND BINARY JSON_UNQUOTE(JSON_EXTRACT(receipt_json,'$.restoreRunId'))=BINARY restore_run_id
    AND BINARY JSON_UNQUOTE(JSON_EXTRACT(receipt_json,'$.runtimeEpochSha256'))=BINARY runtime_epoch_sha256
    AND BINARY JSON_UNQUOTE(JSON_EXTRACT(receipt_json,'$.historyReceiptSha256'))=BINARY history_receipt_sha256
    AND BINARY JSON_UNQUOTE(JSON_EXTRACT(receipt_json,'$.checkpointSha256'))=BINARY checkpoint_sha256
    AND BINARY JSON_UNQUOTE(JSON_EXTRACT(receipt_json,'$.configuredFleetRootSha256'))=BINARY configured_fleet_root_sha256
    AND BINARY JSON_UNQUOTE(JSON_EXTRACT(receipt_json,'$.receiptSha256'))=BINARY cutover_receipt_sha256
    AND JSON_EXTRACT(receipt_json,'$.activatedAtDbMs')=activated_at_db_ms
    AND JSON_UNQUOTE(JSON_EXTRACT(receipt_json,'$.newCaptureWritesAuthorized'))='true'
    AND JSON_UNQUOTE(JSON_EXTRACT(receipt_json,'$.historicalOperationRecoveryAuthorized'))='false'
  ) IS TRUE)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE tenant_telemetry_capture_recovery_permits (
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
  permit_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  receipt_json JSON NOT NULL,
  PRIMARY KEY (write_operation_sha256,new_claim_attempt),
  UNIQUE KEY uk_tt_capture_recovery_receipt (permit_receipt_sha256),
  UNIQUE KEY uk_tt_capture_recovery_predecessor (write_operation_sha256,predecessor_key_sha256),
  KEY idx_tt_capture_recovery_run (restore_run_id,write_operation_sha256,new_claim_attempt),
  CONSTRAINT fk_tt_capture_recovery_job FOREIGN KEY (write_operation_sha256)
    REFERENCES tenant_telemetry_write_jobs(write_operation_sha256) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tt_capture_recovery_cutover FOREIGN KEY (restore_run_id)
    REFERENCES tenant_telemetry_capture_epoch_cutovers(restore_run_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tt_capture_recovery_shape CHECK ((
    write_operation_sha256 REGEXP '^[0-9a-f]{64}$'
    AND restore_run_id REGEXP '^restore_[0-9a-f-]{36}$'
    AND cutover_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND checkpoint_sha256 REGEXP '^[0-9a-f]{64}$'
    AND (previous_permit_receipt_sha256 IS NULL OR previous_permit_receipt_sha256 REGEXP '^[0-9a-f]{64}$')
    AND predecessor_key_sha256 REGEXP '^[0-9a-f]{64}$'
    AND previous_claim_attempt<new_claim_attempt AND new_claim_attempt=previous_claim_attempt+1
    AND new_claim_token_sha256 REGEXP '^[0-9a-f]{64}$'
    AND permit_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND issued_at_db_ms<new_claim_lease_until_ms
    AND new_claim_lease_until_ms<=claim_lease_ceiling_ms
    AND claim_lease_ceiling_ms<=issued_at_db_ms+300000
    AND JSON_TYPE(receipt_json)='OBJECT'
    AND BINARY JSON_UNQUOTE(JSON_EXTRACT(receipt_json,'$.writeOperationSha256'))=BINARY write_operation_sha256
    AND BINARY JSON_UNQUOTE(JSON_EXTRACT(receipt_json,'$.restoreRunId'))=BINARY restore_run_id
    AND BINARY JSON_UNQUOTE(JSON_EXTRACT(receipt_json,'$.cutoverReceiptSha256'))=BINARY cutover_receipt_sha256
    AND BINARY JSON_UNQUOTE(JSON_EXTRACT(receipt_json,'$.checkpointSha256'))=BINARY checkpoint_sha256
    AND BINARY JSON_UNQUOTE(JSON_EXTRACT(receipt_json,'$.receiptSha256'))=BINARY permit_receipt_sha256
    AND JSON_EXTRACT(receipt_json,'$.previousClaimAttempt')=previous_claim_attempt
    AND JSON_EXTRACT(receipt_json,'$.newClaimAttempt')=new_claim_attempt
    AND JSON_EXTRACT(receipt_json,'$.newClaimLeaseUntilMs')=new_claim_lease_until_ms
    AND JSON_EXTRACT(receipt_json,'$.claimLeaseCeilingMs')=claim_lease_ceiling_ms
    AND JSON_EXTRACT(receipt_json,'$.issuedAtDbMs')=issued_at_db_ms
  ) IS TRUE)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_tt_capture_epoch_cutover_bi BEFORE INSERT ON tenant_telemetry_capture_epoch_cutovers FOR EACH ROW BEGIN IF (EXISTS (SELECT 1 FROM tenant_telemetry_capture_restore_history_receipts h JOIN tenant_restore_replay_runs r ON BINARY r.restore_run_id=BINARY h.restore_run_id JOIN tenant_restore_runtime_control c ON c.singleton_id=1 AND c.state='active' AND c.lineage_kind='restore' WHERE BINARY h.restore_run_id=BINARY NEW.restore_run_id AND BINARY h.history_receipt_sha256=BINARY NEW.history_receipt_sha256 AND BINARY h.checkpoint_sha256=BINARY NEW.checkpoint_sha256 AND r.phase='active' AND BINARY c.restore_run_id=BINARY NEW.restore_run_id AND BINARY c.runtime_epoch_sha256=BINARY NEW.runtime_epoch_sha256 AND BINARY h.runtime_epoch_sha256=BINARY NEW.runtime_epoch_sha256 AND NEW.activated_at_db_ms>=h.activated_at_db_ms AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.receipt_json,'$.fleetStoppedAck'))=BINARY 'fleet-stopped-v1' AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.receipt_json,'$.legacyWritersDrainedAck'))=BINARY 'legacy-writers-drained-v1' AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.receipt_json,'$.producerReadyAck'))=BINARY 'provider-step-error-v2-ready-v1' AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.receipt_json,'$.localOnlyAck'))=BINARY 'local-only-v1')) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture epoch cutover requires exact active restore history'; END IF; END;
CREATE TRIGGER trg_tt_capture_epoch_cutover_bu BEFORE UPDATE ON tenant_telemetry_capture_epoch_cutovers FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture epoch cutover is immutable';
CREATE TRIGGER trg_tt_capture_epoch_cutover_bd BEFORE DELETE ON tenant_telemetry_capture_epoch_cutovers FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture epoch cutover is immutable';
CREATE TRIGGER trg_tt_capture_recovery_permit_bi BEFORE INSERT ON tenant_telemetry_capture_recovery_permits FOR EACH ROW BEGIN IF (EXISTS (SELECT 1 FROM tenant_telemetry_capture_epoch_cutovers c JOIN tenant_telemetry_write_jobs j ON BINARY j.write_operation_sha256=BINARY NEW.write_operation_sha256 WHERE BINARY c.restore_run_id=BINARY NEW.restore_run_id AND BINARY c.cutover_receipt_sha256=BINARY NEW.cutover_receipt_sha256 AND BINARY c.checkpoint_sha256=BINARY NEW.checkpoint_sha256 AND j.phase='queued' AND j.attempts=NEW.previous_claim_attempt AND ((j.claim_token IS NULL AND j.lease_until_ms IS NULL) OR (j.claim_token IS NOT NULL AND j.lease_until_ms<=NEW.issued_at_db_ms)) AND NEW.new_claim_attempt=j.attempts+1 AND NEW.issued_at_db_ms>=c.activated_at_db_ms AND NEW.predecessor_key_sha256=COALESCE(NEW.previous_permit_receipt_sha256,REPEAT('0',64)) AND ((NEW.previous_permit_receipt_sha256 IS NULL AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_capture_recovery_permits p WHERE BINARY p.write_operation_sha256=BINARY NEW.write_operation_sha256)) OR EXISTS (SELECT 1 FROM tenant_telemetry_capture_recovery_permits p WHERE BINARY p.write_operation_sha256=BINARY NEW.write_operation_sha256 AND BINARY p.permit_receipt_sha256=BINARY NEW.previous_permit_receipt_sha256 AND p.new_claim_attempt=NEW.previous_claim_attempt AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_capture_recovery_permits q WHERE BINARY q.write_operation_sha256=BINARY p.write_operation_sha256 AND q.new_claim_attempt>p.new_claim_attempt))) AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.receipt_json,'$.newClaimTokenSha256'))=BINARY NEW.new_claim_token_sha256)) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture recovery permit requires exact expired predecessor'; END IF; END;
CREATE TRIGGER trg_tt_capture_recovery_permit_bu BEFORE UPDATE ON tenant_telemetry_capture_recovery_permits FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture recovery permit is immutable';
CREATE TRIGGER trg_tt_capture_recovery_permit_bd BEFORE DELETE ON tenant_telemetry_capture_recovery_permits FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture recovery permit is immutable';

-- These guards are additive. They only affect an original-primary v2 operation
-- when the current runtime is a restore epoch; new-epoch jobs retain every
-- published 0034/0053 guard. A permit is inserted before its job CAS update in
-- the same RR transaction, so a failed update cannot leave a usable permit.
CREATE TRIGGER trg_tt_capture_recovery_write_job_bu BEFORE UPDATE ON tenant_telemetry_write_jobs FOR EACH ROW BEGIN IF JSON_UNQUOTE(JSON_EXTRACT(OLD.inventory_json,'$.sourceSchema'))='provider-step-error-v2' AND EXISTS (SELECT 1 FROM tenant_restore_runtime_control r WHERE r.singleton_id=1 AND r.state='active' AND r.lineage_kind='restore' AND BINARY r.runtime_epoch_sha256<>BINARY JSON_UNQUOTE(JSON_EXTRACT(OLD.inventory_json,'$.runtimeEpochSha256'))) THEN IF (EXISTS (SELECT 1 FROM tenant_telemetry_capture_epoch_cutovers c JOIN tenant_telemetry_capture_recovery_permits p ON BINARY p.restore_run_id=BINARY c.restore_run_id AND BINARY p.cutover_receipt_sha256=BINARY c.cutover_receipt_sha256 JOIN tenant_restore_runtime_control r ON r.singleton_id=1 AND r.state='active' AND r.lineage_kind='restore' WHERE BINARY c.restore_run_id=BINARY r.restore_run_id AND BINARY c.runtime_epoch_sha256=BINARY r.runtime_epoch_sha256 AND BINARY p.write_operation_sha256=BINARY OLD.write_operation_sha256 AND p.new_claim_attempt=NEW.attempts AND NEW.attempts>=OLD.attempts AND BINARY p.checkpoint_sha256=BINARY c.checkpoint_sha256 AND (NEW.claim_token IS NULL OR (NEW.lease_until_ms IS NOT NULL AND NEW.lease_until_ms<=p.claim_lease_ceiling_ms AND BINARY p.new_claim_token_sha256=BINARY SHA2(CONCAT('["tenant-telemetry-write-claim-token-v1","',NEW.claim_token,'"]'),256))) AND (OLD.mutation_reservation_receipt_sha256 IS NOT NULL OR NEW.mutation_reservation_receipt_sha256 IS NULL OR (JSON_UNQUOTE(JSON_EXTRACT(p.receipt_json,'$.newReservationAuthorized'))='true' AND JSON_UNQUOTE(JSON_EXTRACT(p.receipt_json,'$.recoveryMode'))='resume_queued' AND NEW.mutation_started_claim_attempt=p.new_claim_attempt AND BINARY NEW.mutation_started_claim_token_sha256=BINARY p.new_claim_token_sha256)) AND (NEW.phase<>'written' OR (NEW.completed_claim_attempt=p.new_claim_attempt AND BINARY NEW.completed_claim_token_sha256=BINARY p.new_claim_token_sha256 AND NEW.written_at_db_ms<=p.claim_lease_ceiling_ms)))) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restored capture job transition lacks exact recovery permit'; END IF; END IF; END;
CREATE TRIGGER trg_tt_capture_recovery_write_ack_bi BEFORE INSERT ON tenant_telemetry_write_acks FOR EACH ROW BEGIN IF EXISTS (SELECT 1 FROM tenant_telemetry_write_jobs j JOIN tenant_restore_runtime_control r ON r.singleton_id=1 AND r.state='active' AND r.lineage_kind='restore' WHERE BINARY j.write_operation_sha256=BINARY NEW.write_operation_sha256 AND JSON_UNQUOTE(JSON_EXTRACT(j.inventory_json,'$.sourceSchema'))='provider-step-error-v2' AND BINARY r.runtime_epoch_sha256<>BINARY JSON_UNQUOTE(JSON_EXTRACT(j.inventory_json,'$.runtimeEpochSha256'))) THEN IF (EXISTS (SELECT 1 FROM tenant_telemetry_write_jobs j JOIN tenant_telemetry_capture_recovery_permits p ON BINARY p.write_operation_sha256=BINARY j.write_operation_sha256 AND p.new_claim_attempt=j.attempts JOIN tenant_telemetry_capture_epoch_cutovers c ON BINARY c.restore_run_id=BINARY p.restore_run_id AND BINARY c.cutover_receipt_sha256=BINARY p.cutover_receipt_sha256 JOIN tenant_restore_runtime_control r ON r.singleton_id=1 AND r.state='active' AND r.lineage_kind='restore' WHERE BINARY j.write_operation_sha256=BINARY NEW.write_operation_sha256 AND BINARY c.restore_run_id=BINARY r.restore_run_id AND BINARY c.runtime_epoch_sha256=BINARY r.runtime_epoch_sha256 AND j.phase='queued' AND j.claim_token IS NOT NULL AND j.lease_until_ms IS NOT NULL AND j.lease_until_ms<=p.claim_lease_ceiling_ms AND p.new_claim_attempt=NEW.completed_claim_attempt AND BINARY p.new_claim_token_sha256=BINARY NEW.completed_claim_token_sha256 AND BINARY j.mutation_reservation_receipt_sha256=BINARY NEW.reservation_receipt_sha256 AND NEW.store_db_timestamp_ms<=p.claim_lease_ceiling_ms)) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restored capture ACK lacks exact recovery permit'; END IF; END IF; END;

DROP TRIGGER trg_tt_capture_v2_subject_bi;
DROP TRIGGER trg_tt_capture_v2_binding_bi;
DROP TRIGGER trg_tt_capture_v2_write_job_bi;
DROP TRIGGER trg_tt_capture_v2_failure_bi;

CREATE TRIGGER trg_tt_capture_v2_subject_bi BEFORE INSERT ON subject_lifecycle FOR EACH ROW BEGIN
  IF NEW.subject_kind='tenant' AND BINARY NEW.subject_id=BINARY NEW.tenant_id THEN
    IF EXISTS (SELECT 1 FROM tenant_telemetry_capture_v2_controls WHERE domain='logs' AND state='active' AND control_generation=1) THEN
      -- Published session AFTER INSERT uses INSERT IGNORE for the canonical tenant.
      -- BEFORE INSERT still fires for that duplicate. Accept only an already
      -- existing exact covered tenant; a genuinely new default-0 tenant is denied.
      IF ((NEW.telemetry_logs_capture_v2_generation=1
        OR (NEW.telemetry_logs_capture_v2_generation=0 AND EXISTS (
          SELECT 1 FROM subject_lifecycle s JOIN tenant_telemetry_capture_v2_coverages c
            ON BINARY c.tenant_id=BINARY s.tenant_id AND c.domain='logs' AND c.control_generation=1
          JOIN tenant_telemetry_lifecycle_coverages l ON BINARY l.tenant_id=BINARY c.tenant_id
            AND BINARY l.evidence_sha256=BINARY c.lifecycle_coverage_evidence_sha256
          WHERE s.subject_kind='tenant' AND BINARY s.subject_id=BINARY s.tenant_id
            AND BINARY s.tenant_id=BINARY NEW.tenant_id AND s.state='active'
            AND BINARY c.subject_ref_sha256=BINARY l.subject_ref_sha256
            AND ((s.telemetry_logs_capture_v2_generation=0 AND c.capture_status='capture_since_cutover')
              OR (s.telemetry_logs_capture_v2_generation=1 AND c.capture_status='capture_since_tenant_creation')))))
        AND EXISTS (SELECT 1 FROM tenant_restore_runtime_control r JOIN tenant_telemetry_capture_v2_activation_receipts a ON a.domain='logs' WHERE r.singleton_id=1 AND r.state='active' AND ((r.lineage_kind='primary' AND BINARY r.runtime_epoch_sha256=BINARY JSON_UNQUOTE(JSON_EXTRACT(a.receipt_json,'$.runtimeEpochSha256'))) OR (r.lineage_kind='restore' AND EXISTS (SELECT 1 FROM tenant_telemetry_capture_epoch_cutovers x WHERE BINARY x.restore_run_id=BINARY r.restore_run_id AND BINARY x.runtime_epoch_sha256=BINARY r.runtime_epoch_sha256 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(x.receipt_json,'$.originalCaptureActivationReceiptSha256'))=BINARY a.receipt_sha256))))) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='new capture v2 tenant requires the active epoch projection'; END IF; ELSEIF NEW.telemetry_logs_capture_v2_generation<>0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='inactive capture v2 tenant cannot claim coverage'; END IF; ELSEIF NEW.telemetry_logs_capture_v2_generation<>0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture v2 generation is tenant-only'; END IF; END;
CREATE TRIGGER trg_tt_capture_v2_binding_bi BEFORE INSERT ON tenant_telemetry_capture_v2_source_bindings FOR EACH ROW BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_telemetry_capture_v2_controls c
      JOIN tenant_telemetry_capture_v2_coverages v ON v.domain=c.domain
      JOIN tenant_telemetry_capture_v2_activation_receipts a ON a.domain=c.domain
      JOIN tenant_restore_runtime_control r ON r.singleton_id=1 AND r.state='active' AND r.lineage_kind IN ('primary','restore')
      WHERE c.domain='logs' AND c.state='active' AND c.control_generation=NEW.control_generation
        AND BINARY v.tenant_id=BINARY NEW.tenant_id AND BINARY v.evidence_sha256=BINARY NEW.coverage_evidence_sha256
        AND BINARY c.producer_contract_sha256=BINARY NEW.producer_contract_sha256
        AND BINARY v.producer_contract_sha256=BINARY NEW.producer_contract_sha256
        AND ((r.lineage_kind='primary' AND BINARY r.runtime_epoch_sha256=BINARY JSON_UNQUOTE(JSON_EXTRACT(a.receipt_json,'$.runtimeEpochSha256'))) OR (r.lineage_kind='restore' AND EXISTS (SELECT 1 FROM tenant_telemetry_capture_epoch_cutovers x WHERE BINARY x.restore_run_id=BINARY r.restore_run_id AND BINARY x.runtime_epoch_sha256=BINARY r.runtime_epoch_sha256 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(x.receipt_json,'$.originalCaptureActivationReceiptSha256'))=BINARY a.receipt_sha256)))
        AND NEW.bound_at_db_ms>=GREATEST(c.activated_at_db_ms,v.coverage_started_at_db_ms,r.updated_at_db_ms))
    AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_write_jobs WHERE BINARY write_operation_sha256=BINARY NEW.write_operation_sha256)
    AND EXISTS (SELECT 1 FROM sessions s JOIN items i ON BINARY i.session_id=BINARY s.session_id AND BINARY i.user_id=BINARY s.user_id
      JOIN turns t ON BINARY t.turn_id=BINARY i.turn_id AND BINARY t.session_id=BINARY s.session_id AND BINARY t.user_id=BINARY s.user_id
      JOIN events e ON BINARY e.session_id=BINARY s.session_id AND BINARY e.user_id=BINARY s.user_id AND e.seq=NEW.source_event_seq
      WHERE BINARY s.tenant_id=BINARY NEW.tenant_id AND s.deleted_at_ms IS NULL
        AND t.status='inProgress' AND i.type='agentMessage' AND i.status='failed'
        AND i.telemetry_failure_classification='provider_step_error'
        AND i.telemetry_capture_v2_control_generation=1
        AND BINARY i.telemetry_capture_v2_operation_sha256=BINARY NEW.write_operation_sha256
        AND BINARY i.telemetry_capture_v2_session_ref_sha256=BINARY NEW.source_session_ref_sha256
        AND BINARY i.telemetry_capture_v2_turn_ref_sha256=BINARY NEW.source_turn_ref_sha256
        AND BINARY i.telemetry_capture_v2_item_ref_sha256=BINARY NEW.source_item_ref_sha256
        AND JSON_EXTRACT(i.body,'$.step')=NEW.source_step_index
        AND e.type='item/completed' AND e.telemetry_failure_classification='provider_step_error'
        AND e.telemetry_capture_v2_control_generation=1
        AND BINARY JSON_UNQUOTE(JSON_EXTRACT(e.body,'$.item.id'))=BINARY i.item_id
        AND BINARY e.telemetry_capture_v2_operation_sha256=BINARY NEW.write_operation_sha256
        AND BINARY e.telemetry_capture_v2_session_ref_sha256=BINARY NEW.source_session_ref_sha256
        AND BINARY e.telemetry_capture_v2_turn_ref_sha256=BINARY NEW.source_turn_ref_sha256
        AND BINARY e.telemetry_capture_v2_item_ref_sha256=BINARY NEW.source_item_ref_sha256
        AND BINARY e.telemetry_capture_v2_failure_receipt_sha256=BINARY i.telemetry_capture_v2_failure_receipt_sha256
        AND BINARY e.telemetry_capture_v2_business_batch_sha256=BINARY i.telemetry_capture_v2_business_batch_sha256)
  ) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture v2 source requires the exact durable failed step'; END IF; END;
CREATE TRIGGER trg_tt_capture_v2_write_job_bi BEFORE INSERT ON tenant_telemetry_write_jobs FOR EACH ROW BEGIN
  IF EXISTS (SELECT 1 FROM tenant_telemetry_capture_v2_controls WHERE domain='logs' AND state='active' AND control_generation=1) THEN
    IF NEW.domain='logs' AND (EXISTS (SELECT 1 FROM tenant_telemetry_capture_v2_source_bindings b
      JOIN tenant_telemetry_artifact_memberships m ON BINARY m.write_operation_sha256=BINARY b.write_operation_sha256
      JOIN tenant_telemetry_capture_v2_activation_receipts a ON a.domain='logs'
      JOIN tenant_restore_runtime_control r ON r.singleton_id=1 AND r.state='active' AND r.lineage_kind IN ('primary','restore')
      WHERE BINARY b.write_operation_sha256=BINARY NEW.write_operation_sha256
        AND BINARY b.tenant_id=BINARY NEW.tenant_id AND b.domain='logs'
        AND BINARY b.payload_sha256=BINARY NEW.payload_sha256
        AND BINARY m.tenant_id=BINARY NEW.tenant_id AND m.domain='logs'
        AND m.source_schema='provider-step-error-v2' AND m.source_generation=1
        AND m.application_binding_receipt_sha256 IS NULL AND m.owner_kind='session'
        AND BINARY m.owner_ref_sha256=BINARY b.owner_ref_sha256
        AND BINARY m.inventory_sha256=BINARY NEW.inventory_sha256
        AND BINARY m.payload_sha256=BINARY NEW.payload_sha256
        AND BINARY m.manifest_sha256=BINARY NEW.manifest_sha256
        AND BINARY m.target_sha256=BINARY NEW.target_sha256
        AND BINARY m.target_sha256=BINARY JSON_UNQUOTE(JSON_EXTRACT(a.receipt_json,'$.logsTargetSha256'))
        AND ((r.lineage_kind='primary' AND BINARY r.runtime_epoch_sha256=BINARY JSON_UNQUOTE(JSON_EXTRACT(a.receipt_json,'$.runtimeEpochSha256'))) OR (r.lineage_kind='restore' AND EXISTS (SELECT 1 FROM tenant_telemetry_capture_epoch_cutovers x WHERE BINARY x.restore_run_id=BINARY r.restore_run_id AND BINARY x.runtime_epoch_sha256=BINARY r.runtime_epoch_sha256 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(x.receipt_json,'$.originalCaptureActivationReceiptSha256'))=BINARY a.receipt_sha256)))
        AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.inventory_json,'$.sourceSchema'))=BINARY 'provider-step-error-v2'
        AND JSON_EXTRACT(NEW.inventory_json,'$.sourceGeneration')=1
        AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.inventory_json,'$.runtimeEpochSha256'))=BINARY r.runtime_epoch_sha256)
    ) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture v2 logs job requires exact source and membership'; END IF; IF NEW.domain='traces' AND (EXISTS (SELECT 1 FROM tenant_telemetry_capture_v2_source_bindings WHERE BINARY write_operation_sha256=BINARY NEW.write_operation_sha256)
      OR JSON_UNQUOTE(JSON_EXTRACT(NEW.inventory_json,'$.sourceSchema'))='provider-step-error-v2')
    THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='provider capture v2 cannot produce traces'; END IF; ELSEIF JSON_UNQUOTE(JSON_EXTRACT(NEW.inventory_json,'$.sourceSchema'))='provider-step-error-v2'
    OR EXISTS (SELECT 1 FROM tenant_telemetry_capture_v2_coverages WHERE BINARY tenant_id=BINARY NEW.tenant_id)
    OR EXISTS (SELECT 1 FROM tenant_telemetry_capture_v2_source_bindings WHERE BINARY tenant_id=BINARY NEW.tenant_id)
  THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='inactive capture v2 has unexpected write evidence'; END IF; END;
CREATE TRIGGER trg_tt_capture_v2_failure_bi BEFORE INSERT ON tenant_telemetry_capture_v2_failure_commit_receipts FOR EACH ROW BEGIN
  DECLARE source_match_count BIGINT UNSIGNED; DECLARE business_match_count BIGINT UNSIGNED; SELECT COUNT(*) INTO source_match_count FROM tenant_telemetry_capture_v2_source_bindings b
      JOIN tenant_telemetry_artifact_memberships m ON BINARY m.write_operation_sha256=BINARY b.write_operation_sha256
      JOIN tenant_telemetry_write_jobs j ON BINARY j.write_operation_sha256=BINARY b.write_operation_sha256
      JOIN tenant_telemetry_write_payloads p ON BINARY p.write_operation_sha256=BINARY j.write_operation_sha256
      JOIN tenant_telemetry_capture_v2_activation_receipts a ON a.domain='logs' JOIN tenant_restore_runtime_control r ON r.singleton_id=1 AND r.state='active' LEFT JOIN tenant_telemetry_capture_epoch_cutovers x ON BINARY x.restore_run_id=BINARY r.restore_run_id
      WHERE BINARY b.write_operation_sha256=BINARY NEW.write_operation_sha256 AND BINARY b.tenant_id=BINARY NEW.tenant_id
        AND BINARY b.source_session_ref_sha256=BINARY NEW.source_session_ref_sha256
        AND BINARY b.source_turn_ref_sha256=BINARY NEW.source_turn_ref_sha256
        AND BINARY b.source_item_ref_sha256=BINARY NEW.source_item_ref_sha256
        AND b.source_step_index=NEW.source_step_index AND b.source_event_seq=NEW.source_event_seq
        AND BINARY b.receipt_sha256=BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.receipt_json,'$.bindingReceiptSha256'))
        AND BINARY m.membership_sha256=BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.receipt_json,'$.membershipSha256'))
        AND BINARY j.tenant_id=BINARY NEW.tenant_id AND j.domain='logs' AND j.phase='queued'
        AND BINARY m.tenant_id=BINARY NEW.tenant_id AND m.source_schema='provider-step-error-v2'
        AND BINARY p.tenant_id=BINARY NEW.tenant_id AND p.domain='logs'
        AND BINARY p.payload_sha256=BINARY j.payload_sha256 AND BINARY j.payload_sha256=BINARY b.payload_sha256
        AND BINARY b.payload_sha256=BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.receipt_json,'$.payloadSha256'))
        AND ((r.lineage_kind='primary' AND BINARY r.runtime_epoch_sha256=BINARY JSON_UNQUOTE(JSON_EXTRACT(a.receipt_json,'$.runtimeEpochSha256'))
          AND BINARY a.receipt_sha256=BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.receipt_json,'$.captureControlEvidenceSha256'))
          AND BINARY JSON_UNQUOTE(JSON_EXTRACT(a.receipt_json,'$.runtimeEpochSha256'))=BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.receipt_json,'$.runtimeEpochSha256'))
          AND BINARY JSON_UNQUOTE(JSON_EXTRACT(a.receipt_json,'$.runtimeBindingSha256'))=BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.receipt_json,'$.runtimeBindingSha256')))
        OR (r.lineage_kind='restore' AND x.restore_run_id IS NOT NULL
          AND BINARY x.cutover_receipt_sha256=BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.receipt_json,'$.captureControlEvidenceSha256'))
          AND BINARY x.runtime_epoch_sha256=BINARY r.runtime_epoch_sha256
          AND BINARY x.runtime_epoch_sha256=BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.receipt_json,'$.runtimeEpochSha256'))
          AND BINARY JSON_UNQUOTE(JSON_EXTRACT(x.receipt_json,'$.runtimeBindingSha256'))=BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.receipt_json,'$.runtimeBindingSha256'))
          AND BINARY JSON_UNQUOTE(JSON_EXTRACT(x.receipt_json,'$.originalCaptureActivationReceiptSha256'))=BINARY a.receipt_sha256))
        AND JSON_EXTRACT(NEW.receipt_json,'$.committedAtDbMs')=b.bound_at_db_ms; SELECT COUNT(*) INTO business_match_count FROM sessions s JOIN items i ON BINARY i.session_id=BINARY s.session_id AND BINARY i.user_id=BINARY s.user_id
      JOIN events e ON BINARY e.session_id=BINARY s.session_id AND BINARY e.user_id=BINARY s.user_id AND e.seq=NEW.source_event_seq
      WHERE BINARY s.tenant_id=BINARY NEW.tenant_id AND s.last_seq=NEW.begin_last_seq AND s.fence_token<=NEW.fence_token
        AND i.telemetry_failure_classification='provider_step_error' AND e.telemetry_failure_classification='provider_step_error'
        AND BINARY i.telemetry_capture_v2_operation_sha256=BINARY NEW.write_operation_sha256
        AND BINARY e.telemetry_capture_v2_operation_sha256=BINARY NEW.write_operation_sha256
        AND BINARY i.telemetry_capture_v2_failure_receipt_sha256=BINARY NEW.receipt_sha256
        AND BINARY e.telemetry_capture_v2_failure_receipt_sha256=BINARY NEW.receipt_sha256
        AND BINARY i.telemetry_capture_v2_business_batch_sha256=BINARY NEW.business_batch_sha256
        AND BINARY e.telemetry_capture_v2_business_batch_sha256=BINARY NEW.business_batch_sha256
        AND EXISTS (SELECT 1 FROM usage_ledger u JOIN billing_usage_facts f
          ON BINARY f.usage_id=BINARY u.usage_id AND BINARY f.tenant_id=BINARY u.tenant_id
          WHERE BINARY u.tenant_id=BINARY s.tenant_id AND BINARY u.user_id=BINARY s.user_id
            AND BINARY u.session_id=BINARY s.session_id AND BINARY u.turn_id=BINARY i.turn_id
            AND u.step=NEW.source_step_index AND u.usage_id IS NOT NULL
            AND BINARY SHA2(CONCAT('tenant-telemetry-step-usage-id-v2',CHAR(0),JSON_QUOTE(u.usage_id)),256)
              =BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.receipt_json,'$.usageIdSha256'))
            AND BINARY f.provider=BINARY u.provider AND BINARY f.model=BINARY u.model
            AND f.input_tokens=JSON_EXTRACT(u.usage_json,'$.inputTokens')
            AND f.output_tokens=JSON_EXTRACT(u.usage_json,'$.outputTokens')
            AND f.cache_read_tokens=JSON_EXTRACT(u.usage_json,'$.cacheReadTokens')
            AND f.cache_write_tokens=JSON_EXTRACT(u.usage_json,'$.cacheWriteTokens')
            AND f.reasoning_tokens=JSON_EXTRACT(u.usage_json,'$.reasoningTokens')
            AND f.total_tokens=JSON_EXTRACT(u.usage_json,'$.totalTokens')
            AND EXISTS (SELECT 1 FROM events v WHERE BINARY v.session_id=BINARY s.session_id
              AND BINARY v.user_id=BINARY s.user_id AND v.type='usage/updated'
              AND v.seq>NEW.begin_last_seq AND v.seq<=NEW.end_last_seq
              AND BINARY JSON_UNQUOTE(JSON_EXTRACT(v.body,'$.turnId'))=BINARY i.turn_id
              AND JSON_EXTRACT(v.body,'$.step')=NEW.source_step_index
              AND JSON_EXTRACT(v.body,'$.stepUsage')=u.usage_json))
        AND (SELECT COUNT(*) FROM events x WHERE BINARY x.session_id=BINARY s.session_id AND x.seq>NEW.begin_last_seq AND x.seq<=NEW.end_last_seq)=NEW.event_count; IF (source_match_count>0 AND business_match_count>0) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture v2 failure receipt requires an exact atomic write set'; END IF; END;

-- Pin the complete two-table and whole-trigger shapes independently derived
-- on real MySQL; a later guard edit requires a new isolated derivation.
SET @tt_capture_epoch_cutover_previous_gcml=@@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len=1048576;
-- agent-service-runtime-fingerprint:tenant-telemetry-capture-epoch-cutover-schema:start
SET @tt_capture_epoch_cutover_schema_ok=(
  (SELECT COUNT(*)=2 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,table_type,IFNULL(engine,'-'),IFNULL(table_collation,'-'),IFNULL(row_format,'-'),IFNULL(create_options,'-')) ORDER BY table_name SEPARATOR '|'),256)='d2ea72ac287f3e6d8bb8b4580ef3489d9a0bf9d0ccf52bc81ddd9aa051ac058b' FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_capture_epoch_cutovers','tenant_telemetry_capture_recovery_permits'))
  AND (SELECT COUNT(*)=22 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,LPAD(ordinal_position,3,'0'),column_name,LOWER(column_type),is_nullable,IF(column_default IS NULL,'<NULL>',CONCAT('<',column_default,'>')),IFNULL(character_set_name,'-'),IFNULL(collation_name,'-'),IFNULL(extra,'-'),IFNULL(generation_expression,'-')) ORDER BY table_name,ordinal_position SEPARATOR '|'),256)='64e19d5480bb50b653fb5348405d25adb3c2c10203d09a87b33368117ead0e57' FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_capture_epoch_cutovers','tenant_telemetry_capture_recovery_permits'))
  AND (SELECT COUNT(*)=10 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,index_name,LPAD(seq_in_index,3,'0'),column_name,non_unique,index_type,IFNULL(collation,'-'),IFNULL(sub_part,'-'),IFNULL(nullable,'-')) ORDER BY table_name,index_name,seq_in_index SEPARATOR '|'),256)='61b1dbad22d78a377cb2e98f081e3ec7b01a0902579c5abad0653e121969bafb' FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_capture_epoch_cutovers','tenant_telemetry_capture_recovery_permits'))
  AND (SELECT COUNT(*)=2 AND SUM(enforced='YES')=2 FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND constraint_name IN ('chk_tt_capture_epoch_cutover_shape','chk_tt_capture_recovery_shape') AND constraint_type='CHECK')
  AND (SELECT COUNT(*)=2 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',constraint_name,LOWER(REPLACE(REPLACE(REGEXP_REPLACE(check_clause,'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY constraint_name SEPARATOR '|'),256)='1a36cad51323659fd7a61564fedb38600aa66fc205cd26222c9283e8b3fe0508' FROM information_schema.check_constraints WHERE constraint_schema=DATABASE() AND constraint_name IN ('chk_tt_capture_epoch_cutover_shape','chk_tt_capture_recovery_shape'))
  AND (SELECT COUNT(*)=10 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,constraint_type) ORDER BY table_name,constraint_name SEPARATOR '|'),256)='1aff522220f3ea53b402d5adad35dff688850e7681192698d525165b9a176e56' FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_capture_epoch_cutovers','tenant_telemetry_capture_recovery_permits'))
  AND (SELECT COUNT(*)=3 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,referenced_table_name,update_rule,delete_rule) ORDER BY table_name,constraint_name SEPARATOR '|'),256)='d0e8ae749b72dfd49b6030c734269834311d4504bd90b854c74c2253d497ced7' FROM information_schema.referential_constraints WHERE constraint_schema=DATABASE() AND table_name IN ('tenant_telemetry_capture_epoch_cutovers','tenant_telemetry_capture_recovery_permits'))
  AND (SELECT COUNT(*)=3 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,LPAD(ordinal_position,3,'0'),column_name,referenced_table_name,referenced_column_name) ORDER BY table_name,constraint_name,ordinal_position SEPARATOR '|'),256)='7bfef5e85437b444d305abdb5bba95a18fefdf8dbf1ad518c3ed33f8466f72d2' FROM information_schema.key_column_usage WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_capture_epoch_cutovers','tenant_telemetry_capture_recovery_permits') AND referenced_table_name IS NOT NULL)
  AND (SELECT COUNT(*)=0 FROM information_schema.partitions WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_capture_epoch_cutovers','tenant_telemetry_capture_recovery_permits') AND partition_name IS NOT NULL)
);
-- agent-service-runtime-fingerprint:tenant-telemetry-capture-epoch-cutover-schema:end
SET @migration_sql=IF(@tt_capture_epoch_cutover_schema_ok=1,'SELECT 1','SELECT 1 FROM __invalid_tenant_telemetry_capture_epoch_cutover_schema__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
-- agent-service-runtime-fingerprint:tenant-telemetry-capture-epoch-cutover-triggers:start
SET @tt_capture_epoch_cutover_triggers_ok=(
  SELECT COUNT(*)=728 AND COUNT(DISTINCT trigger_name)=728
    AND SUM(trigger_name IN ('trg_tt_capture_epoch_cutover_bi','trg_tt_capture_epoch_cutover_bu','trg_tt_capture_epoch_cutover_bd','trg_tt_capture_recovery_permit_bi','trg_tt_capture_recovery_permit_bu','trg_tt_capture_recovery_permit_bd','trg_tt_capture_recovery_write_job_bu','trg_tt_capture_recovery_write_ack_bi'))=8
    AND SUM(OCTET_LENGTH(CONCAT_WS('~',event_object_table,trigger_name,action_timing,event_manipulation,action_orientation,IFNULL(action_condition,'<NULL>'),LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),CHAR(96),''),'_utf8mb4','')))))+COUNT(*)-1<=@@SESSION.group_concat_max_len
    AND SHA2(GROUP_CONCAT(CONCAT_WS('~',event_object_table,trigger_name,action_timing,event_manipulation,action_orientation,IFNULL(action_condition,'<NULL>'),LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY event_object_table,trigger_name SEPARATOR '|'),256)='d6d52a52ed47c0ffbee162506530e2025304c384360f278cc530c9847d91b44e'
  FROM information_schema.triggers WHERE trigger_schema=DATABASE()
);
-- agent-service-runtime-fingerprint:tenant-telemetry-capture-epoch-cutover-triggers:end
SET @migration_sql=IF(@tt_capture_epoch_cutover_triggers_ok=1,'SELECT 1','SELECT 1 FROM __invalid_tenant_telemetry_capture_epoch_cutover_triggers__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
SET SESSION group_concat_max_len=@tt_capture_epoch_cutover_previous_gcml;
