-- 0042: default-dormant, immutable per-artifact T3d telemetry target catalog.
-- Drain every pre-0042 T3d writer before migrating. The catalog is evidence, not an
-- executable T3d target, disposition grant, external mutation, or completion proof.
-- Historical sealed plans are not backfilled and remain unknown without a 0042 receipt.

CREATE TABLE IF NOT EXISTS tenant_telemetry_plan_artifact_targets (
  scope VARCHAR(72) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_id VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation BIGINT UNSIGNED NOT NULL,
  build_generation BIGINT UNSIGNED NOT NULL,
  domain VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  artifact_id_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  artifact_generation BIGINT UNSIGNED NOT NULL,
  inventory_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  inventory_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  write_operation_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  write_ack_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  membership_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  application_binding_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  payload_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  manifest_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  lifecycle_coverage_evidence_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  application_coverage_evidence_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  owner_kind VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  owner_ref_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  hold_subject_ref_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  owner_binding_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  live_owner_claim_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  artifact_group_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_group_root_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  captured_at_db_ms BIGINT NOT NULL,
  receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (request_id,artifact_group_sha256),
  UNIQUE KEY uk_tt_plan_artifact_target_receipt (receipt_sha256),
  UNIQUE KEY uk_tt_plan_artifact_target_operation (request_id,write_operation_sha256),
  UNIQUE KEY uk_tt_plan_artifact_target_inventory (request_id,inventory_sha256),
  KEY idx_tt_plan_artifact_target_tenant (tenant_id,request_id,domain),
  KEY idx_tt_plan_artifact_target_domain (request_id,domain,target_sha256),
  CONSTRAINT fk_tt_plan_artifact_target_job FOREIGN KEY (request_id)
    REFERENCES tenant_purge_plan_jobs (request_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tt_plan_artifact_target_target FOREIGN KEY (target_sha256)
    REFERENCES tenant_telemetry_lifecycle_targets (target_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tt_plan_artifact_target_inventory FOREIGN KEY (inventory_sha256)
    REFERENCES tenant_telemetry_artifact_inventory (inventory_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tt_plan_artifact_target_ack FOREIGN KEY (write_operation_sha256)
    REFERENCES tenant_telemetry_write_acks (write_operation_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tt_plan_artifact_target_membership FOREIGN KEY (membership_sha256)
    REFERENCES tenant_telemetry_artifact_memberships (membership_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tt_plan_artifact_target_binding FOREIGN KEY (application_binding_receipt_sha256)
    REFERENCES tenant_telemetry_application_write_bindings (receipt_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tt_plan_artifact_target_shape CHECK (
    scope='tenant-telemetry-plan-artifact-target-v1'
    AND CHAR_LENGTH(tenant_id) BETWEEN 1 AND 128
    AND subject_generation>0 AND build_generation>0
    AND domain IN ('logs','traces') AND artifact_generation>0
    AND owner_kind IN ('tenant','user','session')
    AND target_sha256 REGEXP '^[0-9a-f]{64}$'
    AND target_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND artifact_id_sha256 REGEXP '^[0-9a-f]{64}$'
    AND inventory_sha256 REGEXP '^[0-9a-f]{64}$'
    AND inventory_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND write_operation_sha256 REGEXP '^[0-9a-f]{64}$'
    AND write_ack_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND membership_sha256 REGEXP '^[0-9a-f]{64}$'
    AND application_binding_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND payload_sha256 REGEXP '^[0-9a-f]{64}$'
    AND manifest_sha256 REGEXP '^[0-9a-f]{64}$'
    AND lifecycle_coverage_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
    AND application_coverage_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
    AND owner_ref_sha256 REGEXP '^[0-9a-f]{64}$'
    AND hold_subject_ref_sha256 REGEXP '^[0-9a-f]{64}$'
    AND owner_binding_sha256 REGEXP '^[0-9a-f]{64}$'
    AND live_owner_claim_sha256 REGEXP '^[0-9a-f]{64}$'
    AND artifact_group_sha256 REGEXP '^[0-9a-f]{64}$'
    AND source_group_root_sha256 REGEXP '^[0-9a-f]{64}$'
    AND captured_at_db_ms>=0
    AND receipt_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT scope,request_id,tenant_id,subject_generation,build_generation,domain,
       target_sha256,target_receipt_sha256,artifact_id_sha256,artifact_generation,
       inventory_sha256,inventory_receipt_sha256,write_operation_sha256,
       write_ack_receipt_sha256,membership_sha256,application_binding_receipt_sha256,
       payload_sha256,manifest_sha256,lifecycle_coverage_evidence_sha256,
       application_coverage_evidence_sha256,owner_kind,owner_ref_sha256,
       hold_subject_ref_sha256,owner_binding_sha256,live_owner_claim_sha256,
       artifact_group_sha256,source_group_root_sha256,captured_at_db_ms,receipt_sha256
  FROM tenant_telemetry_plan_artifact_targets FORCE INDEX (
    PRIMARY,uk_tt_plan_artifact_target_receipt,uk_tt_plan_artifact_target_operation,
    uk_tt_plan_artifact_target_inventory,idx_tt_plan_artifact_target_tenant,
    idx_tt_plan_artifact_target_domain
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_telemetry_plan_artifact_target_receipts (
  scope VARCHAR(72) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_id VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation BIGINT UNSIGNED NOT NULL,
  build_generation BIGINT UNSIGNED NOT NULL,
  plan_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_accounting_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_manifest_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_count BIGINT UNSIGNED NOT NULL,
  target_root_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  logs_target_count BIGINT UNSIGNED NOT NULL,
  logs_target_root_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  traces_target_count BIGINT UNSIGNED NOT NULL,
  traces_target_root_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  unknown_group_count BIGINT UNSIGNED NOT NULL,
  unknown_group_root_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  store_db_timestamp_ms BIGINT NOT NULL,
  completed_claim_attempt INT UNSIGNED NOT NULL,
  completed_claim_token_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  execution_ready BOOLEAN NOT NULL,
  receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (request_id),
  UNIQUE KEY uk_tt_plan_artifact_target_receipt_hash (receipt_sha256),
  KEY idx_tt_plan_artifact_target_receipt_tenant (tenant_id,request_id),
  KEY idx_tt_plan_artifact_target_receipt_plan (plan_receipt_sha256),
  KEY idx_tt_plan_artifact_target_receipt_source (source_accounting_receipt_sha256),
  KEY idx_tt_plan_artifact_target_receipt_manifest (target_manifest_receipt_sha256),
  CONSTRAINT fk_tt_plan_artifact_target_receipt_job FOREIGN KEY (request_id)
    REFERENCES tenant_purge_plan_jobs (request_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tt_plan_artifact_target_receipt_plan FOREIGN KEY (plan_receipt_sha256)
    REFERENCES tenant_purge_plan_receipts (receipt_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tt_plan_artifact_target_receipt_source FOREIGN KEY (source_accounting_receipt_sha256)
    REFERENCES tenant_telemetry_source_accounting_receipts (receipt_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tt_plan_artifact_target_receipt_manifest FOREIGN KEY (target_manifest_receipt_sha256)
    REFERENCES tenant_telemetry_target_manifest_receipts (receipt_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tt_plan_artifact_target_receipt_shape CHECK (
    scope='tenant-telemetry-plan-artifact-target-receipt-v1'
    AND CHAR_LENGTH(tenant_id) BETWEEN 1 AND 128
    AND subject_generation>0 AND build_generation>0
    AND plan_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND source_accounting_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND target_manifest_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND target_root_sha256 REGEXP '^[0-9a-f]{64}$'
    AND logs_target_root_sha256 REGEXP '^[0-9a-f]{64}$'
    AND traces_target_root_sha256 REGEXP '^[0-9a-f]{64}$'
    AND unknown_group_root_sha256 REGEXP '^[0-9a-f]{64}$'
    AND target_count=logs_target_count+traces_target_count
    AND store_db_timestamp_ms>=0 AND completed_claim_attempt>0
    AND completed_claim_token_sha256 REGEXP '^[0-9a-f]{64}$'
    AND execution_ready=0
    AND receipt_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT scope,request_id,tenant_id,subject_generation,build_generation,
       plan_receipt_sha256,source_accounting_receipt_sha256,
       target_manifest_receipt_sha256,target_count,target_root_sha256,
       logs_target_count,logs_target_root_sha256,traces_target_count,
       traces_target_root_sha256,unknown_group_count,unknown_group_root_sha256,
       store_db_timestamp_ms,completed_claim_attempt,completed_claim_token_sha256,
       execution_ready,receipt_sha256
  FROM tenant_telemetry_plan_artifact_target_receipts FORCE INDEX (
    PRIMARY,uk_tt_plan_artifact_target_receipt_hash,
    idx_tt_plan_artifact_target_receipt_tenant,
    idx_tt_plan_artifact_target_receipt_plan,
    idx_tt_plan_artifact_target_receipt_source,
    idx_tt_plan_artifact_target_receipt_manifest
  ) WHERE 1=0;

-- The catalog tuple is selected from the locked raw five-source projection and
-- live canonical owner before the plan receipt. 0040/0041 are only cross-checks
-- at physical insertion; their manifest must never be used to choose a target.
CREATE TRIGGER trg_tt_plan_artifact_target_bi BEFORE INSERT ON tenant_telemetry_plan_artifact_targets FOR EACH ROW BEGIN IF (
  EXISTS (SELECT 1 FROM tenant_purge_plan_jobs j WHERE BINARY j.request_id=BINARY NEW.request_id AND BINARY j.tenant_id=BINARY NEW.tenant_id AND j.subject_generation=NEW.subject_generation AND j.build_generation=NEW.build_generation AND j.phase='queued')
  AND EXISTS (SELECT 1 FROM tenant_purge_plan_receipts p WHERE BINARY p.request_id=BINARY NEW.request_id AND BINARY p.tenant_id=BINARY NEW.tenant_id AND p.subject_generation=NEW.subject_generation AND p.build_generation=NEW.build_generation AND p.store_db_timestamp_ms<=NEW.captured_at_db_ms)
  AND EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_targets t WHERE BINARY t.target_sha256=BINARY NEW.target_sha256 AND BINARY t.domain=BINARY NEW.domain AND BINARY t.receipt_sha256=BINARY NEW.target_receipt_sha256)
  AND EXISTS (SELECT 1 FROM tenant_telemetry_artifact_inventory i JOIN tenant_telemetry_write_jobs j ON BINARY j.inventory_sha256=BINARY i.inventory_sha256 JOIN tenant_telemetry_write_acks a ON BINARY a.write_operation_sha256=BINARY j.write_operation_sha256 JOIN tenant_telemetry_artifact_memberships m ON BINARY m.write_operation_sha256=BINARY j.write_operation_sha256 JOIN tenant_telemetry_application_write_bindings b ON BINARY b.write_operation_sha256=BINARY j.write_operation_sha256 WHERE BINARY i.inventory_sha256=BINARY NEW.inventory_sha256 AND BINARY i.tenant_id=BINARY NEW.tenant_id AND BINARY i.domain=BINARY NEW.domain AND BINARY i.target_sha256=BINARY NEW.target_sha256 AND BINARY i.artifact_id_sha256=BINARY NEW.artifact_id_sha256 AND i.artifact_generation=NEW.artifact_generation AND BINARY i.receipt_sha256=BINARY NEW.inventory_receipt_sha256 AND BINARY i.payload_sha256=BINARY NEW.payload_sha256 AND BINARY i.manifest_sha256=BINARY NEW.manifest_sha256 AND BINARY i.coverage_evidence_sha256=BINARY NEW.lifecycle_coverage_evidence_sha256 AND BINARY i.owner_kind=BINARY NEW.owner_kind AND BINARY i.owner_ref_sha256=BINARY NEW.owner_ref_sha256 AND BINARY i.hold_subject_ref_sha256=BINARY NEW.hold_subject_ref_sha256 AND BINARY j.write_operation_sha256=BINARY NEW.write_operation_sha256 AND BINARY j.tenant_id=BINARY NEW.tenant_id AND BINARY j.domain=BINARY NEW.domain AND BINARY j.target_sha256=BINARY NEW.target_sha256 AND BINARY j.artifact_id_sha256=BINARY NEW.artifact_id_sha256 AND j.artifact_generation=NEW.artifact_generation AND BINARY j.payload_sha256=BINARY NEW.payload_sha256 AND BINARY j.manifest_sha256=BINARY NEW.manifest_sha256 AND j.phase='written' AND BINARY j.write_ack_receipt_sha256=BINARY NEW.write_ack_receipt_sha256 AND BINARY a.tenant_id=BINARY NEW.tenant_id AND BINARY a.domain=BINARY NEW.domain AND BINARY a.target_sha256=BINARY NEW.target_sha256 AND BINARY a.target_receipt_sha256=BINARY NEW.target_receipt_sha256 AND BINARY a.inventory_sha256=BINARY NEW.inventory_sha256 AND BINARY a.inventory_receipt_sha256=BINARY NEW.inventory_receipt_sha256 AND BINARY a.artifact_id_sha256=BINARY NEW.artifact_id_sha256 AND a.artifact_generation=NEW.artifact_generation AND BINARY a.payload_sha256=BINARY NEW.payload_sha256 AND BINARY a.manifest_sha256=BINARY NEW.manifest_sha256 AND BINARY a.receipt_sha256=BINARY NEW.write_ack_receipt_sha256 AND BINARY m.tenant_id=BINARY NEW.tenant_id AND BINARY m.domain=BINARY NEW.domain AND BINARY m.target_sha256=BINARY NEW.target_sha256 AND BINARY m.inventory_sha256=BINARY NEW.inventory_sha256 AND BINARY m.artifact_id_sha256=BINARY NEW.artifact_id_sha256 AND m.artifact_generation=NEW.artifact_generation AND BINARY m.membership_sha256=BINARY NEW.membership_sha256 AND BINARY m.payload_sha256=BINARY NEW.payload_sha256 AND BINARY m.manifest_sha256=BINARY NEW.manifest_sha256 AND BINARY m.lifecycle_coverage_evidence_sha256=BINARY NEW.lifecycle_coverage_evidence_sha256 AND BINARY m.application_binding_receipt_sha256=BINARY NEW.application_binding_receipt_sha256 AND BINARY m.owner_kind=BINARY NEW.owner_kind AND BINARY m.owner_ref_sha256=BINARY NEW.owner_ref_sha256 AND BINARY m.hold_subject_ref_sha256=BINARY NEW.hold_subject_ref_sha256 AND BINARY m.owner_binding_sha256=BINARY NEW.owner_binding_sha256 AND BINARY b.tenant_id=BINARY NEW.tenant_id AND BINARY b.domain=BINARY NEW.domain AND BINARY b.target_sha256=BINARY NEW.target_sha256 AND BINARY b.target_receipt_sha256=BINARY NEW.target_receipt_sha256 AND BINARY b.inventory_sha256=BINARY NEW.inventory_sha256 AND BINARY b.receipt_sha256=BINARY NEW.application_binding_receipt_sha256 AND BINARY b.payload_sha256=BINARY NEW.payload_sha256 AND BINARY b.manifest_sha256=BINARY NEW.manifest_sha256 AND BINARY b.lifecycle_coverage_evidence_sha256=BINARY NEW.lifecycle_coverage_evidence_sha256 AND BINARY b.coverage_evidence_sha256=BINARY NEW.application_coverage_evidence_sha256)
  AND (SELECT COUNT(*) FROM tenant_telemetry_source_accounting_entries s WHERE BINARY s.request_id=BINARY NEW.request_id AND BINARY s.tenant_id=BINARY NEW.tenant_id AND s.subject_generation=NEW.subject_generation AND s.build_generation=NEW.build_generation AND BINARY s.domain=BINARY NEW.domain AND s.classification='accounted' AND ((s.source_kind='inventory' AND BINARY s.source_identity_sha256=BINARY NEW.inventory_sha256 AND BINARY s.source_evidence_sha256=BINARY NEW.inventory_receipt_sha256) OR (s.source_kind='write_job' AND BINARY s.source_identity_sha256=BINARY NEW.write_operation_sha256 AND BINARY s.write_operation_sha256=BINARY NEW.write_operation_sha256) OR (s.source_kind='write_ack' AND BINARY s.source_identity_sha256=BINARY NEW.write_operation_sha256 AND BINARY s.source_evidence_sha256=BINARY NEW.write_ack_receipt_sha256) OR (s.source_kind='membership' AND BINARY s.source_identity_sha256=BINARY NEW.write_operation_sha256 AND BINARY s.source_evidence_sha256=BINARY NEW.membership_sha256) OR (s.source_kind='application_binding' AND BINARY s.source_identity_sha256=BINARY NEW.write_operation_sha256 AND BINARY s.source_evidence_sha256=BINARY NEW.application_binding_receipt_sha256)))=5
  AND (SELECT COUNT(*) FROM tenant_telemetry_target_manifest_entries m WHERE BINARY m.request_id=BINARY NEW.request_id AND BINARY m.tenant_id=BINARY NEW.tenant_id AND m.subject_generation=NEW.subject_generation AND m.build_generation=NEW.build_generation AND BINARY m.artifact_group_sha256=BINARY NEW.artifact_group_sha256 AND BINARY m.domain=BINARY NEW.domain AND BINARY m.inventory_sha256=BINARY NEW.inventory_sha256 AND BINARY m.write_operation_sha256=BINARY NEW.write_operation_sha256 AND BINARY m.artifact_id_sha256=BINARY NEW.artifact_id_sha256 AND m.artifact_generation=NEW.artifact_generation AND BINARY m.observed_target_sha256=BINARY NEW.target_sha256 AND BINARY m.owner_kind=BINARY NEW.owner_kind AND BINARY m.owner_ref_sha256=BINARY NEW.owner_ref_sha256 AND BINARY m.hold_subject_ref_sha256=BINARY NEW.hold_subject_ref_sha256 AND BINARY m.owner_binding_sha256=BINARY NEW.owner_binding_sha256 AND BINARY m.live_owner_claim_sha256=BINARY NEW.live_owner_claim_sha256 AND BINARY m.group_source_root_sha256=BINARY NEW.source_group_root_sha256 AND m.classification='accounted')=5
) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry plan artifact target lacks exact source and owner'; END IF; END;

CREATE TRIGGER trg_tt_plan_artifact_target_bu BEFORE UPDATE ON tenant_telemetry_plan_artifact_targets FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry plan artifact target is immutable';
CREATE TRIGGER trg_tt_plan_artifact_target_bd BEFORE DELETE ON tenant_telemetry_plan_artifact_targets FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry plan artifact target is append-only';

CREATE TRIGGER trg_tt_plan_artifact_target_receipt_bi BEFORE INSERT ON tenant_telemetry_plan_artifact_target_receipts FOR EACH ROW BEGIN IF (
  EXISTS (SELECT 1 FROM tenant_purge_plan_jobs j WHERE BINARY j.request_id=BINARY NEW.request_id AND BINARY j.tenant_id=BINARY NEW.tenant_id AND j.subject_generation=NEW.subject_generation AND j.build_generation=NEW.build_generation AND j.phase='queued')
  AND EXISTS (SELECT 1 FROM tenant_purge_plan_receipts p WHERE BINARY p.request_id=BINARY NEW.request_id AND BINARY p.tenant_id=BINARY NEW.tenant_id AND p.subject_generation=NEW.subject_generation AND p.build_generation=NEW.build_generation AND BINARY p.receipt_sha256=BINARY NEW.plan_receipt_sha256 AND p.store_db_timestamp_ms<=NEW.store_db_timestamp_ms AND p.completed_claim_attempt=NEW.completed_claim_attempt AND BINARY p.completed_claim_token_sha256=BINARY NEW.completed_claim_token_sha256)
  AND EXISTS (SELECT 1 FROM tenant_telemetry_source_accounting_receipts s WHERE BINARY s.request_id=BINARY NEW.request_id AND BINARY s.tenant_id=BINARY NEW.tenant_id AND s.subject_generation=NEW.subject_generation AND s.build_generation=NEW.build_generation AND BINARY s.receipt_sha256=BINARY NEW.source_accounting_receipt_sha256 AND BINARY s.plan_receipt_sha256=BINARY NEW.plan_receipt_sha256 AND s.store_db_timestamp_ms=NEW.store_db_timestamp_ms AND s.completed_claim_attempt=NEW.completed_claim_attempt AND BINARY s.completed_claim_token_sha256=BINARY NEW.completed_claim_token_sha256)
  AND EXISTS (SELECT 1 FROM tenant_telemetry_target_manifest_receipts m WHERE BINARY m.request_id=BINARY NEW.request_id AND BINARY m.tenant_id=BINARY NEW.tenant_id AND m.subject_generation=NEW.subject_generation AND m.build_generation=NEW.build_generation AND BINARY m.receipt_sha256=BINARY NEW.target_manifest_receipt_sha256 AND BINARY m.plan_receipt_sha256=BINARY NEW.plan_receipt_sha256 AND BINARY m.source_accounting_receipt_sha256=BINARY NEW.source_accounting_receipt_sha256 AND m.observed_target_count=NEW.target_count AND m.unknown_group_count=NEW.unknown_group_count AND BINARY m.unknown_group_root_sha256=BINARY NEW.unknown_group_root_sha256 AND m.store_db_timestamp_ms=NEW.store_db_timestamp_ms AND m.completed_claim_attempt=NEW.completed_claim_attempt AND BINARY m.completed_claim_token_sha256=BINARY NEW.completed_claim_token_sha256)
  AND (SELECT COUNT(*) FROM tenant_telemetry_plan_artifact_targets e WHERE BINARY e.request_id=BINARY NEW.request_id AND BINARY e.tenant_id=BINARY NEW.tenant_id)=NEW.target_count
  AND (SELECT COUNT(*) FROM tenant_telemetry_plan_artifact_targets e WHERE BINARY e.request_id=BINARY NEW.request_id AND BINARY e.tenant_id=BINARY NEW.tenant_id AND e.domain='logs')=NEW.logs_target_count
  AND (SELECT COUNT(*) FROM tenant_telemetry_plan_artifact_targets e WHERE BINARY e.request_id=BINARY NEW.request_id AND BINARY e.tenant_id=BINARY NEW.tenant_id AND e.domain='traces')=NEW.traces_target_count
  AND EXISTS (SELECT 1 FROM tenant_purge_plan_entries p WHERE BINARY p.request_id=BINARY NEW.request_id AND BINARY p.tenant_id=BINARY NEW.tenant_id AND p.subject_generation=NEW.subject_generation AND p.build_generation=NEW.build_generation AND p.domain='logs' AND p.disposition='blocked_adapter_unconfigured' AND p.target_count=NEW.logs_target_count AND BINARY p.target_root_sha256=BINARY NEW.logs_target_root_sha256)
  AND EXISTS (SELECT 1 FROM tenant_purge_plan_entries p WHERE BINARY p.request_id=BINARY NEW.request_id AND BINARY p.tenant_id=BINARY NEW.tenant_id AND p.subject_generation=NEW.subject_generation AND p.build_generation=NEW.build_generation AND p.domain='traces' AND p.disposition='blocked_adapter_unconfigured' AND p.target_count=NEW.traces_target_count AND BINARY p.target_root_sha256=BINARY NEW.traces_target_root_sha256)
  AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_target_manifest_entries m LEFT JOIN tenant_telemetry_plan_artifact_targets e ON BINARY e.request_id=BINARY m.request_id AND BINARY e.artifact_group_sha256=BINARY m.artifact_group_sha256 WHERE BINARY m.request_id=BINARY NEW.request_id AND BINARY m.tenant_id=BINARY NEW.tenant_id AND m.classification='accounted' AND e.request_id IS NULL)
) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry plan artifact receipt lacks complete target catalog'; END IF; END;

CREATE TRIGGER trg_tt_plan_artifact_target_receipt_bu BEFORE UPDATE ON tenant_telemetry_plan_artifact_target_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry plan artifact receipt is immutable';
CREATE TRIGGER trg_tt_plan_artifact_target_receipt_bd BEFORE DELETE ON tenant_telemetry_plan_artifact_target_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry plan artifact receipt is append-only';

CREATE TRIGGER trg_tt_plan_artifact_target_t3d_terminal_bu BEFORE UPDATE ON tenant_purge_plan_jobs FOR EACH ROW BEGIN IF OLD.phase='queued' AND NEW.phase='plan_sealed' AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_plan_artifact_target_receipts r JOIN tenant_telemetry_source_accounting_receipts s ON BINARY s.receipt_sha256=BINARY r.source_accounting_receipt_sha256 JOIN tenant_telemetry_target_manifest_receipts m ON BINARY m.receipt_sha256=BINARY r.target_manifest_receipt_sha256 WHERE BINARY r.request_id=BINARY NEW.request_id AND BINARY r.tenant_id=BINARY NEW.tenant_id AND r.subject_generation=NEW.subject_generation AND r.build_generation=NEW.build_generation AND BINARY r.plan_receipt_sha256=BINARY NEW.aggregate_receipt_sha256 AND BINARY s.plan_receipt_sha256=BINARY NEW.aggregate_receipt_sha256 AND BINARY m.plan_receipt_sha256=BINARY NEW.aggregate_receipt_sha256 AND BINARY m.source_accounting_receipt_sha256=BINARY s.receipt_sha256 AND r.execution_ready=0 AND r.store_db_timestamp_ms>=NEW.sealed_at_ms AND r.store_db_timestamp_ms<=NEW.updated_at_ms AND r.completed_claim_attempt=NEW.completed_claim_attempt AND BINARY r.completed_claim_token_sha256=BINARY NEW.completed_claim_token_sha256 AND (SELECT COUNT(*) FROM tenant_telemetry_plan_artifact_targets e WHERE BINARY e.request_id=BINARY r.request_id AND BINARY e.tenant_id=BINARY r.tenant_id)=r.target_count AND r.target_count=m.observed_target_count AND r.unknown_group_count=m.unknown_group_count) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='terminal T3d lacks immutable telemetry plan artifact target catalog'; END IF; END;

-- This table belongs to the published 0041 fingerprint, so a pre-0042 binary fails startup.
CREATE TRIGGER trg_tt_plan_artifact_target_manifest_receipt_bu BEFORE UPDATE ON tenant_telemetry_target_manifest_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry target manifest receipt is immutable';

SET @tt_plan_artifact_target_previous_group_concat_max_len=@@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len=1048576;
-- agent-service-runtime-fingerprint:tenant-telemetry-plan-artifact-target-schema:start
SET @tt_plan_artifact_target_schema_ok=(
  (SELECT COUNT(*)=2 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,table_type,IFNULL(engine,'-'),IFNULL(table_collation,'-')) ORDER BY table_name SEPARATOR '|'),256)='3569df625c7b199cd0098d9f4b6a29e04ce4cdaacbb9a42c47e2f37c9d4cb67e'
     FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_plan_artifact_targets','tenant_telemetry_plan_artifact_target_receipts'))
  AND (SELECT COUNT(*)=50 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,LPAD(ordinal_position,3,'0'),column_name,LOWER(column_type),is_nullable,IF(column_default IS NULL,'<NULL>',CONCAT('<',column_default,'>')),IFNULL(character_set_name,'-'),IFNULL(extra,'-'),IFNULL(generation_expression,'-')) ORDER BY table_name,ordinal_position SEPARATOR '|'),256)='94f06a387fe6ad1ef00bfc8d2df3c3477c0c792c7ff9e67e2f4f8fd465452868'
     FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_plan_artifact_targets','tenant_telemetry_plan_artifact_target_receipts'))
  AND (SELECT COUNT(*)=25 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,index_name,LPAD(seq_in_index,3,'0'),column_name,non_unique,index_type,IFNULL(collation,'-'),IFNULL(sub_part,'-'),IFNULL(nullable,'-')) ORDER BY table_name,index_name,seq_in_index SEPARATOR '|'),256)='ca4e188d18e3fb8584646a2010290a863078f133e20c00095bb345768829ffd3'
     FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_plan_artifact_targets','tenant_telemetry_plan_artifact_target_receipts'))
  AND (SELECT COUNT(*)=2 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',constraint_name,LOWER(REPLACE(REPLACE(REGEXP_REPLACE(check_clause,'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY constraint_name SEPARATOR '|'),256)='1d046059879185e57d0fb9599431feb8e692477ff9ed5f9fda40003868417eb3'
     FROM information_schema.check_constraints WHERE constraint_schema=DATABASE() AND constraint_name IN ('chk_tt_plan_artifact_target_shape','chk_tt_plan_artifact_target_receipt_shape'))
  AND (SELECT COUNT(*)=18 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,constraint_type) ORDER BY table_name,constraint_name SEPARATOR '|'),256)='320aaa220d323b41b635bae04f45991cf3d9410459bb346b26079ebc9f291087'
     FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_plan_artifact_targets','tenant_telemetry_plan_artifact_target_receipts'))
  AND (SELECT COUNT(*)=10 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,referenced_table_name,update_rule,delete_rule) ORDER BY table_name,constraint_name SEPARATOR '|'),256)='99339cb815f41edbc0ec7d113a8b53d58707e98bdcedb99ef93509823d78333f'
     FROM information_schema.referential_constraints WHERE constraint_schema=DATABASE() AND table_name IN ('tenant_telemetry_plan_artifact_targets','tenant_telemetry_plan_artifact_target_receipts'))
  AND (SELECT COUNT(*)=10 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,LPAD(ordinal_position,3,'0'),column_name,referenced_table_name,referenced_column_name) ORDER BY table_name,constraint_name,ordinal_position SEPARATOR '|'),256)='f5d0711da7df93ac57bd9d6315dbfe3cea5806f5435f800509df5ddb63d1df19'
     FROM information_schema.key_column_usage WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_plan_artifact_targets','tenant_telemetry_plan_artifact_target_receipts') AND referenced_table_name IS NOT NULL)
  AND (SELECT COUNT(*)=0 FROM information_schema.partitions WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_plan_artifact_targets','tenant_telemetry_plan_artifact_target_receipts') AND partition_name IS NOT NULL)
);
-- agent-service-runtime-fingerprint:tenant-telemetry-plan-artifact-target-schema:end
SET @migration_sql=IF(@tt_plan_artifact_target_schema_ok=1,'SELECT 1','SELECT 1 FROM __invalid_tenant_telemetry_plan_artifact_target_schema__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- Published 0041 111-trigger family plus six append-only guards, terminal guard, and tripwire.
-- agent-service-runtime-fingerprint:tenant-telemetry-plan-artifact-target-triggers:start
SET @tt_plan_artifact_target_triggers_ok=(
  SELECT COUNT(*)=119 AND COUNT(DISTINCT trigger_name)=119 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',event_object_table,trigger_name,action_timing,event_manipulation,action_orientation,IFNULL(action_condition,'<NULL>'),LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY event_object_table,trigger_name SEPARATOR '|'),256)='aa9aa1a647153b80546d5143b08d45b62db607cc64cbcc0fc165d7f6788ae12d'
  FROM information_schema.triggers WHERE trigger_schema=DATABASE()
    AND (event_object_table IN ('sessions','subject_lifecycle','tenant_telemetry_lifecycle_control','tenant_telemetry_lifecycle_targets','tenant_telemetry_lifecycle_coverages','tenant_telemetry_lifecycle_subjects','tenant_telemetry_activation_receipts','tenant_telemetry_artifact_inventory','tenant_telemetry_write_jobs','tenant_telemetry_write_payloads','tenant_telemetry_write_acks','tenant_telemetry_application_domain_controls','tenant_telemetry_application_activation_receipts','tenant_telemetry_application_coverages','tenant_telemetry_application_write_bindings','tenant_telemetry_disposition_control','tenant_telemetry_disposition_activation_receipts','tenant_telemetry_disposition_jobs','tenant_telemetry_disposition_authorization_grants','tenant_telemetry_disposition_external_authorizations','tenant_telemetry_disposition_external_events','tenant_telemetry_disposition_tombstone_acks','tenant_telemetry_disposition_receipts','tenant_telemetry_disposition_replay_fences','tenant_telemetry_artifact_memberships','tenant_telemetry_owner_closure_entries','tenant_telemetry_owner_closure_receipts','tenant_telemetry_source_accounting_entries','tenant_telemetry_source_accounting_receipts','tenant_telemetry_target_manifest_entries','tenant_telemetry_target_manifest_receipts','tenant_telemetry_plan_artifact_targets','tenant_telemetry_plan_artifact_target_receipts') OR (event_object_table='tenant_credential_revocation_jobs' AND action_timing='BEFORE' AND event_manipulation='INSERT') OR (event_object_table='tenant_database_purge_jobs' AND BINARY trigger_name=BINARY 'trg_tt_owner_closure_t3f_terminal_bu') OR (event_object_table='tenant_purge_plan_jobs' AND BINARY trigger_name IN (BINARY 'trg_tt_source_accounting_t3d_terminal_bu',BINARY 'trg_tt_target_manifest_t3d_terminal_bu',BINARY 'trg_tt_plan_artifact_target_t3d_terminal_bu')))
);
-- agent-service-runtime-fingerprint:tenant-telemetry-plan-artifact-target-triggers:end
SET @migration_sql=IF(@tt_plan_artifact_target_triggers_ok=1,'SELECT 1','SELECT 1 FROM __invalid_tenant_telemetry_plan_artifact_target_triggers__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
SET SESSION group_concat_max_len=@tt_plan_artifact_target_previous_group_concat_max_len;

SET @tt_plan_artifact_target_projection_ok=(
  NOT EXISTS (SELECT 1 FROM tenant_telemetry_plan_artifact_targets e
    LEFT JOIN tenant_telemetry_plan_artifact_target_receipts r ON BINARY r.request_id=BINARY e.request_id AND BINARY r.tenant_id=BINARY e.tenant_id
    LEFT JOIN tenant_purge_plan_jobs j ON BINARY j.request_id=BINARY e.request_id AND BINARY j.tenant_id=BINARY e.tenant_id
    WHERE r.request_id IS NULL OR j.request_id IS NULL OR j.phase<>'plan_sealed'
      OR BINARY j.aggregate_receipt_sha256<>BINARY r.plan_receipt_sha256)
  AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_plan_artifact_target_receipts r
    LEFT JOIN tenant_telemetry_source_accounting_receipts s ON BINARY s.receipt_sha256=BINARY r.source_accounting_receipt_sha256
    LEFT JOIN tenant_telemetry_target_manifest_receipts m ON BINARY m.receipt_sha256=BINARY r.target_manifest_receipt_sha256
    LEFT JOIN tenant_purge_plan_jobs j ON BINARY j.request_id=BINARY r.request_id AND BINARY j.tenant_id=BINARY r.tenant_id
    WHERE s.request_id IS NULL OR m.request_id IS NULL OR j.request_id IS NULL
      OR j.phase<>'plan_sealed' OR r.execution_ready<>0
      OR BINARY j.aggregate_receipt_sha256<>BINARY r.plan_receipt_sha256)
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_jobs)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_authorization_grants)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_external_authorizations)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_external_events)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_tombstone_acks)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_receipts)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_replay_fences)=0
);
SET @migration_sql=IF(@tt_plan_artifact_target_projection_ok=1,'SELECT 1','SELECT 1 FROM __invalid_tenant_telemetry_plan_artifact_target_projection__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
