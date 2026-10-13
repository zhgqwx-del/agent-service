-- 0053: default-off, local-only persisted provider-step logs capture.
-- All pre-0053 writers must be stopped. This rotates exactly four published
-- 0049 guards; the published migration and its fingerprint remain immutable.
-- It never activates a producer, backfills legacy failures, calls a sink,
-- authorizes erasure, or changes any completion flag.
-- Partial DDL / marker loss requires controlled forward repair, not replay.

CREATE TABLE tenant_telemetry_capture_v2_activation_receipts (
  domain VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  receipt_json JSON NOT NULL,
  PRIMARY KEY (domain),
  UNIQUE KEY uk_tt_capture_v2_activation_request (request_sha256),
  UNIQUE KEY uk_tt_capture_v2_activation_receipt (receipt_sha256),
  CONSTRAINT fk_tt_capture_v2_activation_control FOREIGN KEY (domain)
    REFERENCES tenant_telemetry_capture_v2_controls (domain)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tt_capture_v2_activation_receipt CHECK ((
    domain='logs' AND request_sha256 REGEXP '^[0-9a-f]{64}$'
    AND receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND JSON_TYPE(receipt_json)='OBJECT'
    AND JSON_UNQUOTE(JSON_EXTRACT(receipt_json,'$.scope'))='tenant-telemetry-capture-activation-receipt-v2'
    AND JSON_UNQUOTE(JSON_EXTRACT(receipt_json,'$.protocol'))='tenant-telemetry-persisted-step-v2'
    AND JSON_UNQUOTE(JSON_EXTRACT(receipt_json,'$.domain'))='logs'
    AND BINARY JSON_UNQUOTE(JSON_EXTRACT(receipt_json,'$.requestSha256'))=BINARY request_sha256
    AND BINARY JSON_UNQUOTE(JSON_EXTRACT(receipt_json,'$.receiptSha256'))=BINARY receipt_sha256
  ) IS TRUE)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE tenant_telemetry_capture_v2_failure_commit_receipts (
  write_operation_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_session_ref_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_turn_ref_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_item_ref_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_step_index INT UNSIGNED NOT NULL,
  source_event_seq BIGINT UNSIGNED NOT NULL,
  fence_token BIGINT UNSIGNED NOT NULL,
  begin_last_seq BIGINT UNSIGNED NOT NULL,
  end_last_seq BIGINT UNSIGNED NOT NULL,
  event_count INT UNSIGNED NOT NULL,
  business_batch_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  receipt_json JSON NOT NULL,
  PRIMARY KEY (write_operation_sha256),
  UNIQUE KEY uk_tt_capture_v2_failure_source
    (tenant_id,source_session_ref_sha256,source_turn_ref_sha256,source_step_index),
  UNIQUE KEY uk_tt_capture_v2_failure_receipt (receipt_sha256),
  CONSTRAINT fk_tt_capture_v2_failure_binding FOREIGN KEY (write_operation_sha256)
    REFERENCES tenant_telemetry_capture_v2_source_bindings (write_operation_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tt_capture_v2_failure_receipt CHECK ((
    write_operation_sha256 REGEXP '^[0-9a-f]{64}$'
    AND source_session_ref_sha256 REGEXP '^[0-9a-f]{64}$'
    AND source_turn_ref_sha256 REGEXP '^[0-9a-f]{64}$'
    AND source_item_ref_sha256 REGEXP '^[0-9a-f]{64}$'
    AND business_batch_sha256 REGEXP '^[0-9a-f]{64}$'
    AND receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND source_step_index>0 AND source_event_seq>begin_last_seq
    AND source_event_seq<=end_last_seq AND fence_token>0
    AND event_count>0 AND end_last_seq=begin_last_seq+event_count
    AND JSON_TYPE(receipt_json)='OBJECT'
    AND JSON_UNQUOTE(JSON_EXTRACT(receipt_json,'$.scope'))='tenant-telemetry-provider-step-failure-commit-receipt-v2'
    AND BINARY JSON_UNQUOTE(JSON_EXTRACT(receipt_json,'$.writeOperationSha256'))=BINARY write_operation_sha256
    AND BINARY JSON_UNQUOTE(JSON_EXTRACT(receipt_json,'$.tenantId'))=BINARY tenant_id
    AND BINARY JSON_UNQUOTE(JSON_EXTRACT(receipt_json,'$.sourceSessionRefSha256'))=BINARY source_session_ref_sha256
    AND BINARY JSON_UNQUOTE(JSON_EXTRACT(receipt_json,'$.sourceTurnRefSha256'))=BINARY source_turn_ref_sha256
    AND BINARY JSON_UNQUOTE(JSON_EXTRACT(receipt_json,'$.sourceItemRefSha256'))=BINARY source_item_ref_sha256
    AND JSON_EXTRACT(receipt_json,'$.sourceStepIndex')=source_step_index
    AND JSON_EXTRACT(receipt_json,'$.sourceEventSeq')=source_event_seq
    AND JSON_EXTRACT(receipt_json,'$.fenceToken')=fence_token
    AND JSON_EXTRACT(receipt_json,'$.beginLastSeq')=begin_last_seq
    AND JSON_EXTRACT(receipt_json,'$.endLastSeq')=end_last_seq
    AND JSON_EXTRACT(receipt_json,'$.eventCount')=event_count
    AND BINARY JSON_UNQUOTE(JSON_EXTRACT(receipt_json,'$.businessBatchSha256'))=BINARY business_batch_sha256
    AND BINARY JSON_UNQUOTE(JSON_EXTRACT(receipt_json,'$.receiptSha256'))=BINARY receipt_sha256
  ) IS TRUE)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

ALTER TABLE items
  ADD COLUMN telemetry_failure_classification VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL,
  -- Nullable legacy/default-off provenance: no inactive writer is forced to populate it.
  ADD COLUMN telemetry_capture_v2_control_generation BIGINT UNSIGNED NULL,
  ADD COLUMN telemetry_capture_v2_operation_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  ADD COLUMN telemetry_capture_v2_session_ref_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  ADD COLUMN telemetry_capture_v2_turn_ref_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  ADD COLUMN telemetry_capture_v2_item_ref_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  ADD COLUMN telemetry_capture_v2_failure_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  ADD COLUMN telemetry_capture_v2_business_batch_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  ADD CONSTRAINT chk_items_capture_v2_private CHECK ((
    (telemetry_failure_classification IS NULL AND telemetry_capture_v2_control_generation IS NULL
      AND telemetry_capture_v2_operation_sha256 IS NULL
      AND telemetry_capture_v2_session_ref_sha256 IS NULL AND telemetry_capture_v2_turn_ref_sha256 IS NULL
      AND telemetry_capture_v2_item_ref_sha256 IS NULL AND telemetry_capture_v2_failure_receipt_sha256 IS NULL
      AND telemetry_capture_v2_business_batch_sha256 IS NULL)
    OR (type='agentMessage' AND status='failed' AND telemetry_failure_classification='runtime_unknown'
      AND telemetry_capture_v2_control_generation IN (0,1)
      AND telemetry_capture_v2_operation_sha256 IS NULL AND telemetry_capture_v2_session_ref_sha256 IS NULL
      AND telemetry_capture_v2_turn_ref_sha256 IS NULL AND telemetry_capture_v2_item_ref_sha256 IS NULL
      AND telemetry_capture_v2_failure_receipt_sha256 IS NULL AND telemetry_capture_v2_business_batch_sha256 IS NULL)
    OR (type='agentMessage' AND status='failed' AND telemetry_failure_classification='provider_step_error'
      AND telemetry_capture_v2_control_generation=1
      AND telemetry_capture_v2_operation_sha256 REGEXP '^[0-9a-f]{64}$'
      AND telemetry_capture_v2_session_ref_sha256 REGEXP '^[0-9a-f]{64}$'
      AND telemetry_capture_v2_turn_ref_sha256 REGEXP '^[0-9a-f]{64}$'
      AND telemetry_capture_v2_item_ref_sha256 REGEXP '^[0-9a-f]{64}$'
      AND telemetry_capture_v2_failure_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
      AND telemetry_capture_v2_business_batch_sha256 REGEXP '^[0-9a-f]{64}$')
  ) IS TRUE);

ALTER TABLE events
  ADD COLUMN telemetry_failure_classification VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL,
  ADD COLUMN telemetry_capture_v2_control_generation BIGINT UNSIGNED NULL,
  ADD COLUMN telemetry_capture_v2_operation_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  ADD COLUMN telemetry_capture_v2_session_ref_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  ADD COLUMN telemetry_capture_v2_turn_ref_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  ADD COLUMN telemetry_capture_v2_item_ref_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  ADD COLUMN telemetry_capture_v2_failure_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  ADD COLUMN telemetry_capture_v2_business_batch_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  ADD CONSTRAINT chk_events_capture_v2_private CHECK ((
    (telemetry_failure_classification IS NULL AND telemetry_capture_v2_control_generation IS NULL
      AND telemetry_capture_v2_operation_sha256 IS NULL
      AND telemetry_capture_v2_session_ref_sha256 IS NULL AND telemetry_capture_v2_turn_ref_sha256 IS NULL
      AND telemetry_capture_v2_item_ref_sha256 IS NULL AND telemetry_capture_v2_failure_receipt_sha256 IS NULL
      AND telemetry_capture_v2_business_batch_sha256 IS NULL)
    OR (type='item/completed' AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.item.type'))='agentMessage'
      AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.item.status'))='failed'
      AND telemetry_failure_classification='runtime_unknown'
      AND telemetry_capture_v2_control_generation IN (0,1)
      AND telemetry_capture_v2_operation_sha256 IS NULL AND telemetry_capture_v2_session_ref_sha256 IS NULL
      AND telemetry_capture_v2_turn_ref_sha256 IS NULL AND telemetry_capture_v2_item_ref_sha256 IS NULL
      AND telemetry_capture_v2_failure_receipt_sha256 IS NULL AND telemetry_capture_v2_business_batch_sha256 IS NULL)
    OR (type='item/completed' AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.item.type'))='agentMessage'
      AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.item.status'))='failed'
      AND telemetry_failure_classification='provider_step_error'
      AND telemetry_capture_v2_control_generation=1
      AND telemetry_capture_v2_operation_sha256 REGEXP '^[0-9a-f]{64}$'
      AND telemetry_capture_v2_session_ref_sha256 REGEXP '^[0-9a-f]{64}$'
      AND telemetry_capture_v2_turn_ref_sha256 REGEXP '^[0-9a-f]{64}$'
      AND telemetry_capture_v2_item_ref_sha256 REGEXP '^[0-9a-f]{64}$'
      AND telemetry_capture_v2_failure_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
      AND telemetry_capture_v2_business_batch_sha256 REGEXP '^[0-9a-f]{64}$')
  ) IS TRUE);

ALTER TABLE subject_lifecycle
  ADD COLUMN telemetry_logs_capture_v2_generation BIGINT UNSIGNED NOT NULL DEFAULT 0,
  ADD CONSTRAINT chk_subject_capture_v2_generation CHECK (
    telemetry_logs_capture_v2_generation IN (0,1)
    AND (telemetry_logs_capture_v2_generation=0
      OR (subject_kind='tenant' AND BINARY subject_id=BINARY tenant_id))
  );

ALTER TABLE tenant_telemetry_capture_v2_controls
  DROP CHECK chk_tt_capture_v2_control_shape,
  ADD CONSTRAINT chk_tt_capture_v2_control_shape CHECK ((
    domain IN ('logs','traces') AND scope='tenant-telemetry-capture-control-v2'
    AND capture_protocol='tenant-telemetry-persisted-step-v2'
    AND ((domain='logs' AND producer_protocol='provider-step-error-v2'
      AND producer_contract_sha256='aa524dc9e91dcd2092447a56c270743ac907db3ed8e20359c3c042327e084a0f'
      AND ((control_generation=0 AND state='inactive' AND activated_at_db_ms IS NULL)
        OR (control_generation=1 AND state='active' AND activated_at_db_ms>=0)))
      OR (domain='traces' AND producer_protocol IS NULL AND producer_contract_sha256 IS NULL
        AND control_generation=0 AND state='inactive' AND activated_at_db_ms IS NULL))
  ) IS TRUE);
ALTER TABLE tenant_telemetry_capture_v2_source_bindings
  DROP INDEX uk_tt_capture_v2_binding_source,
  ADD UNIQUE KEY uk_tt_capture_v2_binding_source
    (tenant_id,source_session_ref_sha256,source_turn_ref_sha256,source_step_index);

-- Exact guard rotations and strict schema/trigger fingerprints follow.
DROP TRIGGER trg_tt_capture_v2_control_bu;
DROP TRIGGER trg_tt_capture_v2_coverage_bi;
DROP TRIGGER trg_tt_capture_v2_binding_bi;
DROP TRIGGER trg_tt_capture_v2_write_job_bi;

CREATE TRIGGER trg_tt_capture_v2_control_bu BEFORE UPDATE ON tenant_telemetry_capture_v2_controls FOR EACH ROW BEGIN
  IF (OLD.domain='logs' AND NEW.domain='logs' AND OLD.control_generation=0 AND OLD.state='inactive'
    AND NEW.control_generation=1 AND NEW.state='active' AND OLD.activated_at_db_ms IS NULL
    AND NEW.activated_at_db_ms>=0 AND BINARY OLD.scope=BINARY NEW.scope
    AND BINARY OLD.capture_protocol=BINARY NEW.capture_protocol
    AND BINARY OLD.producer_protocol=BINARY NEW.producer_protocol
    AND BINARY OLD.producer_contract_sha256=BINARY NEW.producer_contract_sha256
    AND EXISTS (SELECT 1 FROM tenant_telemetry_capture_v2_activation_receipts a
      WHERE a.domain='logs' AND JSON_EXTRACT(a.receipt_json,'$.activatedAtDbMs')=NEW.activated_at_db_ms
        AND BINARY JSON_UNQUOTE(JSON_EXTRACT(a.receipt_json,'$.producerContractSha256'))=BINARY NEW.producer_contract_sha256)
  ) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture v2 control requires an exact activation receipt'; END IF; END;

CREATE TRIGGER trg_tt_capture_v2_coverage_bi BEFORE INSERT ON tenant_telemetry_capture_v2_coverages FOR EACH ROW BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_coverages l
    JOIN subject_lifecycle s ON BINARY s.tenant_id=BINARY l.tenant_id
      AND s.subject_kind='tenant' AND BINARY s.subject_id=BINARY s.tenant_id
    JOIN tenant_telemetry_capture_v2_controls c ON c.domain='logs'
    WHERE BINARY l.tenant_id=BINARY NEW.tenant_id
      AND BINARY l.evidence_sha256=BINARY NEW.lifecycle_coverage_evidence_sha256
      AND BINARY l.subject_ref_sha256=BINARY NEW.subject_ref_sha256
      AND BINARY NEW.producer_contract_sha256=BINARY c.producer_contract_sha256
      AND NEW.coverage_started_at_db_ms>=GREATEST(l.coverage_started_at_db_ms,s.created_at_ms)
      AND ((c.control_generation=0 AND c.state='inactive' AND NEW.capture_status='capture_since_cutover'
        AND NEW.pre_cutover_history_status='pre_cutover_history_unknown'
        AND s.telemetry_logs_capture_v2_generation=0
        AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_capture_v2_activation_receipts))
        OR (c.control_generation=1 AND c.state='active' AND NEW.capture_status='capture_since_tenant_creation'
          AND NEW.pre_cutover_history_status='pre_cutover_not_applicable'
          AND s.telemetry_logs_capture_v2_generation=1 AND s.state='active'
          AND s.created_at_ms>=c.activated_at_db_ms AND NEW.coverage_started_at_db_ms>=c.activated_at_db_ms)))
  ) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture v2 coverage requires a canonical lifecycle source'; END IF; END;

CREATE TRIGGER trg_tt_capture_v2_activation_bi BEFORE INSERT ON tenant_telemetry_capture_v2_activation_receipts FOR EACH ROW BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_telemetry_capture_v2_controls c WHERE c.domain='logs'
      AND c.state='inactive' AND c.control_generation=0)
    AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_application_domain_controls WHERE state<>'inactive' OR control_generation<>0)
    AND JSON_UNQUOTE(JSON_EXTRACT(NEW.receipt_json,'$.fleetStoppedAck'))='fleet-stopped-v1'
    AND JSON_UNQUOTE(JSON_EXTRACT(NEW.receipt_json,'$.legacyWritersDrainedAck'))='legacy-writers-drained-v1'
    AND JSON_UNQUOTE(JSON_EXTRACT(NEW.receipt_json,'$.producerReadyAck'))='provider-step-error-v2-ready-v1'
    AND JSON_UNQUOTE(JSON_EXTRACT(NEW.receipt_json,'$.localOnlyAck'))='local-only-v1'
    AND EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_control l
      JOIN tenant_telemetry_lifecycle_targets t ON t.singleton_id=l.singleton_id AND t.control_generation=l.control_generation AND t.domain='logs'
      JOIN tenant_restore_runtime_control r ON r.singleton_id=1 AND r.state='active' AND r.lineage_kind='primary'
      JOIN tenant_restore_journal_control j ON j.singleton_id=1 AND j.control_generation=1
      WHERE l.singleton_id=1 AND l.control_generation=1
        AND BINARY l.activation_evidence_sha256=BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.receipt_json,'$.lifecycleControlEvidenceSha256'))
        AND BINARY l.ref_key_id_sha256=BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.receipt_json,'$.refKeyIdSha256'))
        AND BINARY t.target_sha256=BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.receipt_json,'$.logsTargetSha256'))
        AND BINARY t.receipt_sha256=BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.receipt_json,'$.logsTargetReceiptSha256'))
        AND BINARY r.runtime_epoch_sha256=BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.receipt_json,'$.runtimeEpochSha256'))
        AND BINARY r.evidence_sha256=BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.receipt_json,'$.runtimeControlEvidenceSha256'))
        AND r.control_generation=JSON_EXTRACT(NEW.receipt_json,'$.runtimeControlGeneration')
        AND BINARY r.control_evidence_sha256=BINARY j.evidence_sha256
        AND BINARY r.target_root_sha256=BINARY j.target_root_sha256 AND r.target_count=j.target_count
        AND BINARY j.evidence_sha256=BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.receipt_json,'$.journalControlEvidenceSha256'))
        AND BINARY j.target_root_sha256=BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.receipt_json,'$.journalTargetRootSha256'))
        AND BINARY r.verified_head_root_sha256=BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.receipt_json,'$.journalHeadRootSha256'))
        AND JSON_EXTRACT(NEW.receipt_json,'$.activatedAtDbMs')>=GREATEST(l.activated_at_db_ms,t.created_at_db_ms,r.updated_at_db_ms))
    AND (SELECT COUNT(*) FROM tenant_telemetry_capture_v2_coverages)=JSON_EXTRACT(NEW.receipt_json,'$.coverageCount')
    AND (SELECT COUNT(*) FROM subject_lifecycle WHERE subject_kind='tenant' AND BINARY subject_id=BINARY tenant_id)=JSON_EXTRACT(NEW.receipt_json,'$.coverageCount')
    AND NOT EXISTS (SELECT 1 FROM subject_lifecycle s LEFT JOIN tenant_telemetry_capture_v2_coverages c ON BINARY c.tenant_id=BINARY s.tenant_id AND c.domain='logs'
      WHERE s.subject_kind='tenant' AND BINARY s.subject_id=BINARY s.tenant_id
        AND (c.tenant_id IS NULL OR c.capture_status<>'capture_since_cutover'
          OR c.coverage_started_at_db_ms<>JSON_EXTRACT(NEW.receipt_json,'$.activatedAtDbMs')))
    AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_capture_v2_coverages c LEFT JOIN subject_lifecycle s ON BINARY s.tenant_id=BINARY c.tenant_id AND s.subject_kind='tenant' AND BINARY s.subject_id=BINARY s.tenant_id WHERE s.tenant_id IS NULL)
  ) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture v2 activation is not complete and primary-bound'; END IF; END;
CREATE TRIGGER trg_tt_capture_v2_activation_bu BEFORE UPDATE ON tenant_telemetry_capture_v2_activation_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture v2 activation receipt is immutable';
CREATE TRIGGER trg_tt_capture_v2_activation_bd BEFORE DELETE ON tenant_telemetry_capture_v2_activation_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture v2 activation receipt is permanent';

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
        AND EXISTS (SELECT 1 FROM tenant_restore_runtime_control r JOIN tenant_telemetry_capture_v2_activation_receipts a ON a.domain='logs' WHERE r.singleton_id=1 AND r.state='active' AND r.lineage_kind='primary' AND BINARY r.runtime_epoch_sha256=BINARY JSON_UNQUOTE(JSON_EXTRACT(a.receipt_json,'$.runtimeEpochSha256')))) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='new capture v2 tenant requires the active epoch projection'; END IF; ELSEIF NEW.telemetry_logs_capture_v2_generation<>0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='inactive capture v2 tenant cannot claim coverage'; END IF; ELSEIF NEW.telemetry_logs_capture_v2_generation<>0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture v2 generation is tenant-only'; END IF; END;
CREATE TRIGGER trg_tt_capture_v2_subject_bu BEFORE UPDATE ON subject_lifecycle FOR EACH ROW BEGIN
  IF OLD.telemetry_logs_capture_v2_generation<>NEW.telemetry_logs_capture_v2_generation THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture v2 tenant creation projection is immutable'; END IF; END;

CREATE TRIGGER trg_tt_capture_v2_session_bi BEFORE INSERT ON sessions FOR EACH ROW BEGIN
  IF EXISTS (SELECT 1 FROM tenant_telemetry_capture_v2_controls WHERE domain='logs' AND state='active' AND control_generation=1)
    AND NOT EXISTS (SELECT 1 FROM subject_lifecycle s JOIN tenant_telemetry_capture_v2_coverages c ON BINARY c.tenant_id=BINARY s.tenant_id AND c.domain='logs'
      JOIN tenant_telemetry_lifecycle_coverages l ON BINARY l.tenant_id=BINARY c.tenant_id AND BINARY l.evidence_sha256=BINARY c.lifecycle_coverage_evidence_sha256
      WHERE BINARY s.tenant_id=BINARY NEW.tenant_id AND s.subject_kind='tenant' AND BINARY s.subject_id=BINARY s.tenant_id AND s.state='active'
        AND BINARY c.subject_ref_sha256=BINARY l.subject_ref_sha256
        AND ((s.telemetry_logs_capture_v2_generation=0 AND c.capture_status='capture_since_cutover')
          OR (s.telemetry_logs_capture_v2_generation=1 AND c.capture_status='capture_since_tenant_creation')))
  THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='new session requires capture v2 tenant coverage'; END IF; END;

CREATE TRIGGER trg_tt_capture_v2_items_bi BEFORE INSERT ON items FOR EACH ROW BEGIN
  IF NEW.type='agentMessage' AND NEW.status='failed'
    AND EXISTS (SELECT 1 FROM tenant_telemetry_capture_v2_controls WHERE domain='logs' AND state='active' AND control_generation=1)
    AND NEW.telemetry_failure_classification IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='new failed step requires private classification'; END IF; IF NEW.type='agentMessage' AND NEW.status='failed'
    AND EXISTS (SELECT 1 FROM tenant_telemetry_capture_v2_controls WHERE domain='logs' AND state='active' AND control_generation=1)
    AND NOT (NEW.telemetry_capture_v2_control_generation <=> 1)
  THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active failed step requires exact control generation'; END IF; IF NEW.telemetry_failure_classification='provider_step_error'
    AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_capture_v2_controls WHERE domain='logs' AND state='active' AND control_generation=1)
  THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='provider classification requires active capture v2'; END IF; END;
CREATE TRIGGER trg_tt_capture_v2_items_bu BEFORE UPDATE ON items FOR EACH ROW BEGIN
  IF (OLD.telemetry_failure_classification='provider_step_error'
    OR (OLD.type='agentMessage' AND OLD.status='failed'
      AND (OLD.telemetry_capture_v2_control_generation IS NULL OR OLD.telemetry_capture_v2_control_generation=0)
      AND EXISTS (SELECT 1 FROM tenant_telemetry_capture_v2_controls WHERE domain='logs' AND state='active' AND control_generation=1)))
    AND (NOT (BINARY CAST(OLD.body AS CHAR) <=> BINARY CAST(NEW.body AS CHAR))
      OR NOT (BINARY OLD.item_id <=> BINARY NEW.item_id)
      OR NOT (BINARY OLD.session_id <=> BINARY NEW.session_id)
      OR NOT (BINARY OLD.user_id <=> BINARY NEW.user_id)
      OR NOT (BINARY OLD.turn_id <=> BINARY NEW.turn_id)
      OR NOT (BINARY OLD.type <=> BINARY NEW.type) OR NOT (BINARY OLD.status <=> BINARY NEW.status)
      OR OLD.seq<>NEW.seq OR OLD.created_at_ms<>NEW.created_at_ms
      OR NOT (OLD.completed_at_ms <=> NEW.completed_at_ms))
  THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='provider or pre-cutover failed item snapshot is immutable'; END IF; IF (OLD.type='agentMessage' AND OLD.status='failed') OR OLD.telemetry_failure_classification IS NOT NULL THEN
    IF NOT (BINARY OLD.telemetry_failure_classification <=> BINARY NEW.telemetry_failure_classification)
      OR NOT (OLD.telemetry_capture_v2_control_generation <=> NEW.telemetry_capture_v2_control_generation)
      OR NOT (BINARY OLD.telemetry_capture_v2_operation_sha256 <=> BINARY NEW.telemetry_capture_v2_operation_sha256)
      OR NOT (BINARY OLD.telemetry_capture_v2_session_ref_sha256 <=> BINARY NEW.telemetry_capture_v2_session_ref_sha256)
      OR NOT (BINARY OLD.telemetry_capture_v2_turn_ref_sha256 <=> BINARY NEW.telemetry_capture_v2_turn_ref_sha256)
      OR NOT (BINARY OLD.telemetry_capture_v2_item_ref_sha256 <=> BINARY NEW.telemetry_capture_v2_item_ref_sha256)
      OR NOT (BINARY OLD.telemetry_capture_v2_failure_receipt_sha256 <=> BINARY NEW.telemetry_capture_v2_failure_receipt_sha256)
      OR NOT (BINARY OLD.telemetry_capture_v2_business_batch_sha256 <=> BINARY NEW.telemetry_capture_v2_business_batch_sha256)
    THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='failed step private classification is immutable'; END IF; END IF; IF NEW.type='agentMessage' AND NEW.status='failed' AND NOT (OLD.type='agentMessage' AND OLD.status='failed')
    AND EXISTS (SELECT 1 FROM tenant_telemetry_capture_v2_controls WHERE domain='logs' AND state='active' AND control_generation=1)
    AND NEW.telemetry_failure_classification IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='new failed step requires private classification'; END IF; IF NEW.type='agentMessage' AND NEW.status='failed' AND NOT (OLD.type='agentMessage' AND OLD.status='failed')
    AND EXISTS (SELECT 1 FROM tenant_telemetry_capture_v2_controls WHERE domain='logs' AND state='active' AND control_generation=1)
    AND NOT (NEW.telemetry_capture_v2_control_generation <=> 1)
  THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active failed step requires exact control generation'; END IF; IF NEW.telemetry_failure_classification='provider_step_error' AND OLD.telemetry_failure_classification IS NULL
    AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_capture_v2_controls WHERE domain='logs' AND state='active' AND control_generation=1)
  THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='provider classification requires active capture v2'; END IF; END;

CREATE TRIGGER trg_tt_capture_v2_events_bi BEFORE INSERT ON events FOR EACH ROW BEGIN
  IF NEW.type='item/completed' AND JSON_UNQUOTE(JSON_EXTRACT(NEW.body,'$.item.type'))='agentMessage'
    AND JSON_UNQUOTE(JSON_EXTRACT(NEW.body,'$.item.status'))='failed'
    AND EXISTS (SELECT 1 FROM tenant_telemetry_capture_v2_controls WHERE domain='logs' AND state='active' AND control_generation=1)
    AND (EXISTS (SELECT 1 FROM items i WHERE BINARY i.item_id=BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.body,'$.item.id'))
      AND BINARY i.session_id=BINARY NEW.session_id AND BINARY i.user_id=BINARY NEW.user_id
      AND i.type='agentMessage' AND i.status='failed'
      AND i.telemetry_failure_classification IS NOT NULL
      AND BINARY i.telemetry_failure_classification=BINARY NEW.telemetry_failure_classification
      AND i.telemetry_capture_v2_control_generation=NEW.telemetry_capture_v2_control_generation
      AND NEW.telemetry_capture_v2_control_generation=1
      AND BINARY i.telemetry_capture_v2_operation_sha256 <=> BINARY NEW.telemetry_capture_v2_operation_sha256
      AND BINARY i.telemetry_capture_v2_session_ref_sha256 <=> BINARY NEW.telemetry_capture_v2_session_ref_sha256
      AND BINARY i.telemetry_capture_v2_turn_ref_sha256 <=> BINARY NEW.telemetry_capture_v2_turn_ref_sha256
      AND BINARY i.telemetry_capture_v2_item_ref_sha256 <=> BINARY NEW.telemetry_capture_v2_item_ref_sha256
      AND BINARY i.telemetry_capture_v2_failure_receipt_sha256 <=> BINARY NEW.telemetry_capture_v2_failure_receipt_sha256
      AND BINARY i.telemetry_capture_v2_business_batch_sha256 <=> BINARY NEW.telemetry_capture_v2_business_batch_sha256)
    ) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='failed completed event requires exact private item projection'; END IF; END;
CREATE TRIGGER trg_tt_capture_v2_events_bu BEFORE UPDATE ON events FOR EACH ROW BEGIN
  IF OLD.telemetry_failure_classification IS NOT NULL
    OR NEW.telemetry_failure_classification IS NOT NULL THEN
    IF NOT (BINARY OLD.telemetry_failure_classification <=> BINARY NEW.telemetry_failure_classification)
      OR NOT (OLD.telemetry_capture_v2_control_generation <=> NEW.telemetry_capture_v2_control_generation)
      OR NOT (BINARY OLD.telemetry_capture_v2_operation_sha256 <=> BINARY NEW.telemetry_capture_v2_operation_sha256)
      OR NOT (BINARY OLD.telemetry_capture_v2_session_ref_sha256 <=> BINARY NEW.telemetry_capture_v2_session_ref_sha256)
      OR NOT (BINARY OLD.telemetry_capture_v2_turn_ref_sha256 <=> BINARY NEW.telemetry_capture_v2_turn_ref_sha256)
      OR NOT (BINARY OLD.telemetry_capture_v2_item_ref_sha256 <=> BINARY NEW.telemetry_capture_v2_item_ref_sha256)
      OR NOT (BINARY OLD.telemetry_capture_v2_failure_receipt_sha256 <=> BINARY NEW.telemetry_capture_v2_failure_receipt_sha256)
      OR NOT (BINARY OLD.telemetry_capture_v2_business_batch_sha256 <=> BINARY NEW.telemetry_capture_v2_business_batch_sha256)
      OR NOT (BINARY CAST(OLD.body AS CHAR) <=> BINARY CAST(NEW.body AS CHAR))
      OR NOT (BINARY OLD.session_id <=> BINARY NEW.session_id) OR OLD.seq<>NEW.seq
      OR NOT (BINARY OLD.user_id <=> BINARY NEW.user_id) OR NOT (BINARY OLD.type <=> BINARY NEW.type)
    THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='failed completed event projection is immutable'; END IF; END IF; END;

CREATE TRIGGER trg_tt_capture_v2_binding_bi BEFORE INSERT ON tenant_telemetry_capture_v2_source_bindings FOR EACH ROW BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_telemetry_capture_v2_controls c
      JOIN tenant_telemetry_capture_v2_coverages v ON v.domain=c.domain
      JOIN tenant_telemetry_capture_v2_activation_receipts a ON a.domain=c.domain
      JOIN tenant_restore_runtime_control r ON r.singleton_id=1 AND r.state='active' AND r.lineage_kind='primary'
      WHERE c.domain='logs' AND c.state='active' AND c.control_generation=NEW.control_generation
        AND BINARY v.tenant_id=BINARY NEW.tenant_id AND BINARY v.evidence_sha256=BINARY NEW.coverage_evidence_sha256
        AND BINARY c.producer_contract_sha256=BINARY NEW.producer_contract_sha256
        AND BINARY v.producer_contract_sha256=BINARY NEW.producer_contract_sha256
        AND BINARY r.runtime_epoch_sha256=BINARY JSON_UNQUOTE(JSON_EXTRACT(a.receipt_json,'$.runtimeEpochSha256'))
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
      JOIN tenant_restore_runtime_control r ON r.singleton_id=1 AND r.state='active' AND r.lineage_kind='primary'
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
        AND BINARY r.runtime_epoch_sha256=BINARY JSON_UNQUOTE(JSON_EXTRACT(a.receipt_json,'$.runtimeEpochSha256'))
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
  IF (EXISTS (SELECT 1 FROM tenant_telemetry_capture_v2_source_bindings b
      JOIN tenant_telemetry_artifact_memberships m ON BINARY m.write_operation_sha256=BINARY b.write_operation_sha256
      JOIN tenant_telemetry_write_jobs j ON BINARY j.write_operation_sha256=BINARY b.write_operation_sha256
      JOIN tenant_telemetry_write_payloads p ON BINARY p.write_operation_sha256=BINARY j.write_operation_sha256
      JOIN tenant_telemetry_capture_v2_activation_receipts a ON a.domain='logs'
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
        AND BINARY a.receipt_sha256=BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.receipt_json,'$.captureControlEvidenceSha256'))
        AND BINARY JSON_UNQUOTE(JSON_EXTRACT(a.receipt_json,'$.runtimeEpochSha256'))=BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.receipt_json,'$.runtimeEpochSha256'))
        AND BINARY JSON_UNQUOTE(JSON_EXTRACT(a.receipt_json,'$.runtimeBindingSha256'))=BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.receipt_json,'$.runtimeBindingSha256'))
        AND JSON_EXTRACT(NEW.receipt_json,'$.committedAtDbMs')=b.bound_at_db_ms)
    AND EXISTS (SELECT 1 FROM sessions s JOIN items i ON BINARY i.session_id=BINARY s.session_id AND BINARY i.user_id=BINARY s.user_id
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
        AND (SELECT COUNT(*) FROM events x WHERE BINARY x.session_id=BINARY s.session_id AND x.seq>NEW.begin_last_seq AND x.seq<=NEW.end_last_seq)=NEW.event_count)
  ) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture v2 failure receipt requires an exact atomic write set'; END IF; END;
CREATE TRIGGER trg_tt_capture_v2_failure_bu BEFORE UPDATE ON tenant_telemetry_capture_v2_failure_commit_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture v2 failure commit receipt is immutable';
CREATE TRIGGER trg_tt_capture_v2_failure_bd BEFORE DELETE ON tenant_telemetry_capture_v2_failure_commit_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='capture v2 failure commit receipt is permanent';

-- Keep closure evaluation in one relational query. A nested correlated anti-subquery
-- was optimizer-sensitive on real MySQL 8.0.26; no optimizer setting is required here.
CREATE TRIGGER trg_tt_capture_v2_session_bu BEFORE UPDATE ON sessions FOR EACH ROW BEGIN DECLARE capture_missing_closure BIGINT UNSIGNED DEFAULT 0; IF NEW.last_seq>OLD.last_seq AND EXISTS (SELECT 1 FROM tenant_telemetry_capture_v2_controls WHERE domain='logs' AND state='active' AND control_generation=1) THEN
    IF EXISTS (SELECT 1 FROM events e WHERE BINARY e.session_id=BINARY NEW.session_id AND e.seq>OLD.last_seq AND e.seq<=NEW.last_seq
      AND e.type='item/completed' AND JSON_UNQUOTE(JSON_EXTRACT(e.body,'$.item.type'))='agentMessage'
      AND JSON_UNQUOTE(JSON_EXTRACT(e.body,'$.item.status'))='failed' AND e.telemetry_failure_classification IS NULL)
    THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='failed step sequence requires classification'; END IF; IF EXISTS (SELECT 1 FROM events e LEFT JOIN tenant_telemetry_capture_v2_failure_commit_receipts f
        ON BINARY f.write_operation_sha256=BINARY e.telemetry_capture_v2_operation_sha256
          AND BINARY f.receipt_sha256=BINARY e.telemetry_capture_v2_failure_receipt_sha256
          AND BINARY f.tenant_id=BINARY NEW.tenant_id AND f.source_event_seq=e.seq
          AND f.begin_last_seq=OLD.last_seq AND f.end_last_seq=NEW.last_seq AND f.fence_token=NEW.fence_token
      WHERE BINARY e.session_id=BINARY NEW.session_id AND e.seq>OLD.last_seq AND e.seq<=NEW.last_seq
        AND e.telemetry_failure_classification='provider_step_error' AND f.write_operation_sha256 IS NULL)
    THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='provider failed step sequence requires an atomic commit receipt'; END IF; SELECT COUNT(*) INTO capture_missing_closure
      FROM events e
      LEFT JOIN tenant_telemetry_capture_v2_failure_commit_receipts f
        ON BINARY f.write_operation_sha256=BINARY e.telemetry_capture_v2_operation_sha256
          AND BINARY f.receipt_sha256=BINARY e.telemetry_capture_v2_failure_receipt_sha256
          AND BINARY f.business_batch_sha256=BINARY e.telemetry_capture_v2_business_batch_sha256
          AND BINARY f.source_session_ref_sha256=BINARY e.telemetry_capture_v2_session_ref_sha256
          AND BINARY f.source_turn_ref_sha256=BINARY e.telemetry_capture_v2_turn_ref_sha256
          AND BINARY f.source_item_ref_sha256=BINARY e.telemetry_capture_v2_item_ref_sha256
      LEFT JOIN tenant_telemetry_capture_v2_source_bindings b
        ON BINARY b.write_operation_sha256=BINARY f.write_operation_sha256
          AND BINARY b.receipt_sha256=BINARY JSON_UNQUOTE(JSON_EXTRACT(f.receipt_json,'$.bindingReceiptSha256'))
          AND BINARY b.tenant_id=BINARY NEW.tenant_id
      LEFT JOIN tenant_telemetry_artifact_memberships m
        ON BINARY m.write_operation_sha256=BINARY f.write_operation_sha256
          AND BINARY m.membership_sha256=BINARY JSON_UNQUOTE(JSON_EXTRACT(f.receipt_json,'$.membershipSha256'))
          AND BINARY m.tenant_id=BINARY NEW.tenant_id
      LEFT JOIN tenant_telemetry_write_jobs j
        ON BINARY j.write_operation_sha256=BINARY f.write_operation_sha256
          AND BINARY j.tenant_id=BINARY NEW.tenant_id AND j.domain='logs'
          AND BINARY b.payload_sha256=BINARY j.payload_sha256
          AND BINARY m.payload_sha256=BINARY j.payload_sha256
          AND BINARY m.inventory_sha256=BINARY j.inventory_sha256
      LEFT JOIN tenant_telemetry_write_payloads p
        ON BINARY p.write_operation_sha256=BINARY j.write_operation_sha256
          AND BINARY p.tenant_id=BINARY j.tenant_id AND BINARY p.payload_sha256=BINARY j.payload_sha256
      LEFT JOIN tenant_telemetry_write_acks a
        ON BINARY a.write_operation_sha256=BINARY j.write_operation_sha256
          AND BINARY a.tenant_id=BINARY j.tenant_id AND BINARY a.receipt_sha256=BINARY j.write_ack_receipt_sha256
      WHERE BINARY e.session_id=BINARY NEW.session_id AND e.seq>OLD.last_seq AND e.seq<=NEW.last_seq
        AND e.telemetry_failure_classification='provider_step_error'
        AND (f.write_operation_sha256 IS NOT NULL AND b.write_operation_sha256 IS NOT NULL
          AND m.write_operation_sha256 IS NOT NULL AND j.write_operation_sha256 IS NOT NULL
          AND ((j.phase='queued' AND p.write_operation_sha256 IS NOT NULL)
            OR (j.phase='written' AND a.write_operation_sha256 IS NOT NULL))) IS NOT TRUE; IF capture_missing_closure>0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='provider failure source closure is incomplete at sequence publication'; END IF; END IF; END;

-- Ordinary retention may not destroy the operational source still required by
-- an immutable v2 failure receipt. No row is affected while capture is dormant.
CREATE TRIGGER trg_tt_capture_v2_usage_bd BEFORE DELETE ON usage_ledger FOR EACH ROW BEGIN
  IF EXISTS (SELECT 1 FROM tenant_telemetry_capture_v2_failure_commit_receipts f
    WHERE BINARY f.tenant_id=BINARY OLD.tenant_id AND OLD.usage_id IS NOT NULL
      AND BINARY JSON_UNQUOTE(JSON_EXTRACT(f.receipt_json,'$.usageIdSha256'))
        =BINARY SHA2(CONCAT('tenant-telemetry-step-usage-id-v2',CHAR(0),JSON_QUOTE(OLD.usage_id)),256) FOR SHARE)
  THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='persisted provider failure usage source is retained'; END IF; END;

SET @persisted_capture_previous_group_concat_max_len=@@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len=1048576;
-- agent-service-runtime-fingerprint:persisted-provider-capture-schema:start
SET @persisted_capture_schema_ok=(
  (SELECT COUNT(*)=5 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,table_type,IFNULL(engine,'-'),IFNULL(table_collation,'-')) ORDER BY table_name SEPARATOR '|'),256)='7a79dc6f25e484dfd41a3db25bd2299ea231a9819e0c82879001176a0b6e25f6' FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_capture_v2_controls','tenant_telemetry_capture_v2_coverages','tenant_telemetry_capture_v2_source_bindings','tenant_telemetry_capture_v2_activation_receipts','tenant_telemetry_capture_v2_failure_commit_receipts'))
  AND (SELECT COUNT(*)=70 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,LPAD(ordinal_position,3,'0'),column_name,LOWER(column_type),is_nullable,IF(column_default IS NULL,'<NULL>',CONCAT('<',column_default,'>')),IFNULL(character_set_name,'-'),IFNULL(collation_name,'-'),IFNULL(extra,'-'),IFNULL(generation_expression,'-')) ORDER BY table_name,ordinal_position SEPARATOR '|'),256)='5f9febdab17e19cb5b856cbb3fab74f04e9019ada7d6a743e3928c5fd95e739d' FROM information_schema.columns WHERE table_schema=DATABASE() AND (table_name IN ('tenant_telemetry_capture_v2_controls','tenant_telemetry_capture_v2_coverages','tenant_telemetry_capture_v2_source_bindings','tenant_telemetry_capture_v2_activation_receipts','tenant_telemetry_capture_v2_failure_commit_receipts') OR (table_name IN ('items','events') AND (column_name='telemetry_failure_classification' OR column_name LIKE 'telemetry_capture_v2_%')) OR (table_name='subject_lifecycle' AND column_name='telemetry_logs_capture_v2_generation')))
  AND (SELECT COUNT(*)=31 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,index_name,LPAD(seq_in_index,3,'0'),column_name,non_unique,index_type,IFNULL(collation,'-'),IFNULL(sub_part,'-'),IFNULL(nullable,'-')) ORDER BY table_name,index_name,seq_in_index SEPARATOR '|'),256)='0eebba96421eb521511ff0d7d43af313a75bebe6872452a2e252bc0e05d23495' FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_capture_v2_controls','tenant_telemetry_capture_v2_coverages','tenant_telemetry_capture_v2_source_bindings','tenant_telemetry_capture_v2_activation_receipts','tenant_telemetry_capture_v2_failure_commit_receipts'))
  AND (SELECT COUNT(*)=8 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',constraint_name,LOWER(REPLACE(REPLACE(REGEXP_REPLACE(check_clause,'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY constraint_name SEPARATOR '|'),256)='722037c1eff08fe7c10737f34654eae819d582ebaa75c3d58aff0c2133104269' FROM information_schema.check_constraints WHERE constraint_schema=DATABASE() AND constraint_name IN ('chk_tt_capture_v2_control_shape','chk_tt_capture_v2_coverage_shape','chk_tt_capture_v2_binding_shape','chk_tt_capture_v2_activation_receipt','chk_tt_capture_v2_failure_receipt','chk_items_capture_v2_private','chk_events_capture_v2_private','chk_subject_capture_v2_generation'))
  AND (SELECT COUNT(*)=8 AND SUM(enforced='YES')=8 FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND constraint_name IN ('chk_tt_capture_v2_control_shape','chk_tt_capture_v2_coverage_shape','chk_tt_capture_v2_binding_shape','chk_tt_capture_v2_activation_receipt','chk_tt_capture_v2_failure_receipt','chk_items_capture_v2_private','chk_events_capture_v2_private','chk_subject_capture_v2_generation') AND constraint_type='CHECK')
  AND (SELECT COUNT(*)=23 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,constraint_type) ORDER BY table_name,constraint_name SEPARATOR '|'),256)='58dc2965479764f5efb3248e258dae647780b7b72af3326478bc2aa1f8e833c9' FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_capture_v2_controls','tenant_telemetry_capture_v2_coverages','tenant_telemetry_capture_v2_source_bindings','tenant_telemetry_capture_v2_activation_receipts','tenant_telemetry_capture_v2_failure_commit_receipts'))
  AND (SELECT COUNT(*)=5 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,referenced_table_name,update_rule,delete_rule) ORDER BY table_name,constraint_name SEPARATOR '|'),256)='722d47744b56a428bb8969387cdd8f15f4d4e9973bb8e248dfcd716c3b36f260' FROM information_schema.referential_constraints WHERE constraint_schema=DATABASE() AND table_name IN ('tenant_telemetry_capture_v2_controls','tenant_telemetry_capture_v2_coverages','tenant_telemetry_capture_v2_source_bindings','tenant_telemetry_capture_v2_activation_receipts','tenant_telemetry_capture_v2_failure_commit_receipts'))
  AND (SELECT COUNT(*)=8 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,LPAD(ordinal_position,3,'0'),column_name,referenced_table_name,referenced_column_name) ORDER BY table_name,constraint_name,ordinal_position SEPARATOR '|'),256)='7600eb920f46ed22ea921393c862f09ac4524c663d67dfb3109819722ef19c4b' FROM information_schema.key_column_usage WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_capture_v2_controls','tenant_telemetry_capture_v2_coverages','tenant_telemetry_capture_v2_source_bindings','tenant_telemetry_capture_v2_activation_receipts','tenant_telemetry_capture_v2_failure_commit_receipts') AND referenced_table_name IS NOT NULL)
  AND (SELECT COUNT(*)=0 FROM information_schema.partitions WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_capture_v2_controls','tenant_telemetry_capture_v2_coverages','tenant_telemetry_capture_v2_source_bindings','tenant_telemetry_capture_v2_activation_receipts','tenant_telemetry_capture_v2_failure_commit_receipts') AND partition_name IS NOT NULL)
);
-- agent-service-runtime-fingerprint:persisted-provider-capture-schema:end
SET @migration_sql=IF(@persisted_capture_schema_ok=1,'SELECT 1','SELECT 1 FROM __invalid_persisted_provider_capture_schema__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- agent-service-runtime-fingerprint:persisted-provider-capture-triggers:start
SET @persisted_capture_triggers_ok=(
  (SELECT COUNT(*)=28 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',event_object_table,trigger_name,action_timing,event_manipulation,action_orientation,IFNULL(action_condition,'<NULL>'),LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY event_object_table,trigger_name SEPARATOR '|'),256)='05f12f03eaf0cc96a33d3ce9e53c61ef5b979ae6331f0fae4711119cc1d72e59' FROM information_schema.triggers WHERE trigger_schema=DATABASE() AND trigger_name LIKE 'trg_tt_capture_v2_%')
  AND (SELECT COUNT(*)=2 FROM information_schema.triggers WHERE trigger_schema=DATABASE() AND event_object_table='events')
  AND (SELECT COUNT(*)=2 FROM information_schema.triggers WHERE trigger_schema=DATABASE() AND event_object_table='items')
  AND (SELECT COUNT(*)=12 FROM information_schema.triggers WHERE trigger_schema=DATABASE() AND event_object_table='sessions')
  AND (SELECT COUNT(*)=4 FROM information_schema.triggers WHERE trigger_schema=DATABASE() AND event_object_table='subject_lifecycle')
  AND (SELECT COUNT(*)=8 FROM information_schema.triggers WHERE trigger_schema=DATABASE() AND event_object_table='tenant_database_purge_jobs')
  AND (SELECT COUNT(*)=10 FROM information_schema.triggers WHERE trigger_schema=DATABASE() AND event_object_table='tenant_purge_plan_jobs')
  AND (SELECT COUNT(*)=3 FROM information_schema.triggers WHERE trigger_schema=DATABASE() AND event_object_table='tenant_telemetry_application_domain_controls')
  AND (SELECT COUNT(*)=3 FROM information_schema.triggers WHERE trigger_schema=DATABASE() AND event_object_table='tenant_telemetry_capture_v2_activation_receipts')
  AND (SELECT COUNT(*)=3 FROM information_schema.triggers WHERE trigger_schema=DATABASE() AND event_object_table='tenant_telemetry_capture_v2_controls')
  AND (SELECT COUNT(*)=3 FROM information_schema.triggers WHERE trigger_schema=DATABASE() AND event_object_table='tenant_telemetry_capture_v2_coverages')
  AND (SELECT COUNT(*)=3 FROM information_schema.triggers WHERE trigger_schema=DATABASE() AND event_object_table='tenant_telemetry_capture_v2_failure_commit_receipts')
  AND (SELECT COUNT(*)=3 FROM information_schema.triggers WHERE trigger_schema=DATABASE() AND event_object_table='tenant_telemetry_capture_v2_source_bindings')
  AND (SELECT COUNT(*)=10 FROM information_schema.triggers WHERE trigger_schema=DATABASE() AND event_object_table='tenant_telemetry_write_jobs')
  AND (SELECT COUNT(*)=1 FROM information_schema.triggers WHERE trigger_schema=DATABASE() AND event_object_table='usage_ledger')
);
-- agent-service-runtime-fingerprint:persisted-provider-capture-triggers:end
SET @migration_sql=IF(@persisted_capture_triggers_ok=1,'SELECT 1','SELECT 1 FROM __invalid_persisted_provider_capture_triggers__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
SET SESSION group_concat_max_len=@persisted_capture_previous_group_concat_max_len;
