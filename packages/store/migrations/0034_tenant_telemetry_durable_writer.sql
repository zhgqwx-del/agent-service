-- Expand-only, default-dormant durable writer spool for the 0033 tenant telemetry inventory.
--
-- This migration does not activate telemetry lifecycle tracking, contact a sink, enqueue historical
-- telemetry, or grant deletion/completion authority.  The transient payload table accepts only the
-- application protocol's closed telemetry envelope through the store API.  Sink configuration,
-- URLs, headers, credentials, raw locators and secrets are never stored in these tables.

CREATE TABLE IF NOT EXISTS tenant_telemetry_write_jobs (
  write_operation_sha256        CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                     VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  protocol                      VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  phase                         VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  domain                        VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_sha256                 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  inventory_sha256              CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  artifact_id_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  artifact_generation           BIGINT UNSIGNED NOT NULL,
  payload_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  manifest_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  inventory_json                JSON NOT NULL,
  record_count                  BIGINT UNSIGNED NOT NULL,
  payload_byte_length           BIGINT UNSIGNED NOT NULL,
  available_at_ms               BIGINT NULL,
  attempts                      BIGINT UNSIGNED NOT NULL,
  claim_token                   VARCHAR(128) COLLATE utf8mb4_0900_as_cs NULL,
  lease_until_ms                BIGINT NULL,
  last_error_code               VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL,
  mutation_adapter_protocol     VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  mutation_started_at_db_ms     BIGINT NULL,
  mutation_started_claim_attempt BIGINT UNSIGNED NULL,
  mutation_started_claim_token_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  mutation_reservation_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  write_ack_receipt_sha256      CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  written_at_db_ms              BIGINT NULL,
  completed_claim_attempt       BIGINT UNSIGNED NULL,
  completed_claim_token_sha256  CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  blocked_at_db_ms              BIGINT NULL,
  blocked_reason_code           VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL,
  created_at_ms                 BIGINT NOT NULL,
  updated_at_ms                 BIGINT NOT NULL,
  PRIMARY KEY (write_operation_sha256),
  UNIQUE KEY uk_tenant_telemetry_write_external
    (domain,artifact_id_sha256,artifact_generation),
  UNIQUE KEY uk_tenant_telemetry_write_inventory (inventory_sha256),
  KEY idx_tenant_telemetry_write_queue
    (phase,available_at_ms,lease_until_ms,write_operation_sha256),
  KEY idx_tenant_telemetry_write_tenant
    (tenant_id,phase,created_at_ms,write_operation_sha256),
  KEY idx_tenant_telemetry_write_target
    (target_sha256,domain,created_at_ms,write_operation_sha256),
  CONSTRAINT fk_tenant_telemetry_write_target
    FOREIGN KEY (target_sha256)
    REFERENCES tenant_telemetry_lifecycle_targets (target_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tenant_telemetry_write_job_shape CHECK (
    write_operation_sha256 REGEXP '^[0-9a-f]{64}$'
      AND protocol='tenant-telemetry-write-v1'
      AND phase IN ('queued','written','blocked')
      AND domain IN ('logs','traces')
      AND target_sha256 REGEXP '^[0-9a-f]{64}$'
      AND inventory_sha256 REGEXP '^[0-9a-f]{64}$'
      AND artifact_id_sha256 REGEXP '^[0-9a-f]{64}$' AND artifact_generation>0
      AND payload_sha256 REGEXP '^[0-9a-f]{64}$'
      AND manifest_sha256 REGEXP '^[0-9a-f]{64}$'
      AND record_count BETWEEN 1 AND 100
      AND payload_byte_length BETWEEN 1 AND 262144
      AND created_at_ms>=0 AND updated_at_ms>=created_at_ms
      AND ((mutation_adapter_protocol IS NULL AND mutation_started_at_db_ms IS NULL
            AND mutation_started_claim_attempt IS NULL
            AND mutation_started_claim_token_sha256 IS NULL
            AND mutation_reservation_receipt_sha256 IS NULL)
        OR (mutation_adapter_protocol REGEXP '^[a-z0-9][a-z0-9._:-]{0,63}$'
            AND mutation_started_at_db_ms>=created_at_ms
            AND mutation_started_at_db_ms<=updated_at_ms
            AND mutation_started_claim_attempt>0
            AND mutation_started_claim_attempt<=attempts
            AND mutation_started_claim_token_sha256 REGEXP '^[0-9a-f]{64}$'
            AND mutation_reservation_receipt_sha256 REGEXP '^[0-9a-f]{64}$'))
      AND (phase<>'written' OR mutation_reservation_receipt_sha256 IS NOT NULL)
      AND ((phase='queued' AND available_at_ms IS NOT NULL
            AND write_ack_receipt_sha256 IS NULL AND written_at_db_ms IS NULL
            AND completed_claim_attempt IS NULL AND completed_claim_token_sha256 IS NULL
            AND blocked_at_db_ms IS NULL AND blocked_reason_code IS NULL
            AND ((claim_token IS NULL AND lease_until_ms IS NULL
                  AND available_at_ms>=updated_at_ms)
              OR (claim_token IS NOT NULL AND lease_until_ms IS NOT NULL
                  AND attempts>0 AND lease_until_ms>=updated_at_ms
                  AND last_error_code IS NULL)))
        OR (phase='written' AND available_at_ms IS NULL AND claim_token IS NULL
            AND lease_until_ms IS NULL AND last_error_code IS NULL
            AND write_ack_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
            AND written_at_db_ms>=created_at_ms
            AND completed_claim_attempt=attempts AND completed_claim_attempt>0
            AND completed_claim_token_sha256 REGEXP '^[0-9a-f]{64}$'
            AND blocked_at_db_ms IS NULL AND blocked_reason_code IS NULL)
        OR (phase='blocked' AND available_at_ms IS NULL AND claim_token IS NULL
            AND lease_until_ms IS NULL AND last_error_code IS NULL
            AND write_ack_receipt_sha256 IS NULL AND written_at_db_ms IS NULL
            AND completed_claim_attempt IS NULL AND completed_claim_token_sha256 IS NULL
            AND blocked_at_db_ms>=created_at_ms
            AND blocked_reason_code='integrity_conflict'))
      AND (last_error_code IS NULL
        OR last_error_code IN ('temporary_failure','dependency_pending'))
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT write_operation_sha256,tenant_id,protocol,phase,domain,target_sha256,
       inventory_sha256,artifact_id_sha256,artifact_generation,payload_sha256,
       manifest_sha256,inventory_json,record_count,payload_byte_length,available_at_ms,
       attempts,claim_token,lease_until_ms,last_error_code,write_ack_receipt_sha256,
       mutation_adapter_protocol,mutation_started_at_db_ms,mutation_started_claim_attempt,
       mutation_started_claim_token_sha256,mutation_reservation_receipt_sha256,
       written_at_db_ms,completed_claim_attempt,completed_claim_token_sha256,
       blocked_at_db_ms,blocked_reason_code,created_at_ms,updated_at_ms
  FROM tenant_telemetry_write_jobs FORCE INDEX (
    PRIMARY,uk_tenant_telemetry_write_external,uk_tenant_telemetry_write_inventory,
    idx_tenant_telemetry_write_queue,idx_tenant_telemetry_write_tenant,
    idx_tenant_telemetry_write_target
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_telemetry_write_payloads (
  write_operation_sha256  CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id               VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  domain                  VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  payload_json            JSON NOT NULL,
  payload_sha256          CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  record_count            BIGINT UNSIGNED NOT NULL,
  payload_byte_length     BIGINT UNSIGNED NOT NULL,
  created_at_ms           BIGINT NOT NULL,
  PRIMARY KEY (write_operation_sha256),
  KEY idx_tenant_telemetry_payload_tenant
    (tenant_id,created_at_ms,write_operation_sha256),
  CONSTRAINT fk_tenant_telemetry_payload_job
    FOREIGN KEY (write_operation_sha256)
    REFERENCES tenant_telemetry_write_jobs (write_operation_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tenant_telemetry_payload_shape CHECK (
    write_operation_sha256 REGEXP '^[0-9a-f]{64}$'
      AND domain IN ('logs','traces')
      AND payload_sha256 REGEXP '^[0-9a-f]{64}$'
      AND record_count BETWEEN 1 AND 100
      AND payload_byte_length BETWEEN 1 AND 262144
      AND created_at_ms>=0
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT write_operation_sha256,tenant_id,domain,payload_json,payload_sha256,
       record_count,payload_byte_length,created_at_ms
  FROM tenant_telemetry_write_payloads FORCE INDEX (
    PRIMARY,idx_tenant_telemetry_payload_tenant
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_telemetry_write_acks (
  write_operation_sha256        CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                     VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  scope                         VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  protocol                      VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  domain                        VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_sha256                 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_receipt_sha256         CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  inventory_sha256              CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  inventory_receipt_sha256      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  artifact_id_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  artifact_generation           BIGINT UNSIGNED NOT NULL,
  payload_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  manifest_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  adapter_protocol              VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  outcome                       VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  replayed                      BOOLEAN NOT NULL,
  adapter_evidence_sha256       CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  reservation_receipt_sha256    CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  mutation_started_at_db_ms     BIGINT NOT NULL,
  mutation_started_claim_attempt BIGINT UNSIGNED NOT NULL,
  mutation_started_claim_token_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  completed_claim_attempt       BIGINT UNSIGNED NOT NULL,
  completed_claim_token_sha256  CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  store_db_timestamp_ms         BIGINT NOT NULL,
  receipt_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (write_operation_sha256),
  UNIQUE KEY uk_tenant_telemetry_write_ack_receipt (receipt_sha256),
  UNIQUE KEY uk_tenant_telemetry_write_ack_adapter (adapter_evidence_sha256),
  UNIQUE KEY uk_tenant_telemetry_write_ack_inventory (inventory_sha256),
  KEY idx_tenant_telemetry_write_ack_tenant
    (tenant_id,store_db_timestamp_ms,write_operation_sha256),
  CONSTRAINT fk_tenant_telemetry_write_ack_job
    FOREIGN KEY (write_operation_sha256)
    REFERENCES tenant_telemetry_write_jobs (write_operation_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tenant_telemetry_write_ack_target
    FOREIGN KEY (target_sha256)
    REFERENCES tenant_telemetry_lifecycle_targets (target_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tenant_telemetry_write_ack_inventory
    FOREIGN KEY (inventory_sha256)
    REFERENCES tenant_telemetry_artifact_inventory (inventory_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tenant_telemetry_write_ack_shape CHECK (
    write_operation_sha256 REGEXP '^[0-9a-f]{64}$'
      AND scope='tenant-telemetry-write-ack-v1'
      AND protocol='tenant-telemetry-write-v1'
      AND domain IN ('logs','traces')
      AND target_sha256 REGEXP '^[0-9a-f]{64}$'
      AND target_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
      AND inventory_sha256 REGEXP '^[0-9a-f]{64}$'
      AND inventory_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
      AND artifact_id_sha256 REGEXP '^[0-9a-f]{64}$' AND artifact_generation>0
      AND payload_sha256 REGEXP '^[0-9a-f]{64}$'
      AND manifest_sha256 REGEXP '^[0-9a-f]{64}$'
      AND adapter_protocol REGEXP '^[a-z0-9][a-z0-9._:-]{0,63}$'
      AND outcome IN ('written','already_present')
      AND replayed IN (0,1)
      AND adapter_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND reservation_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
      AND mutation_started_at_db_ms>=0
      AND mutation_started_at_db_ms<=store_db_timestamp_ms
      AND mutation_started_claim_attempt>0
      AND mutation_started_claim_attempt<=completed_claim_attempt
      AND mutation_started_claim_token_sha256 REGEXP '^[0-9a-f]{64}$'
      AND completed_claim_attempt>0
      AND completed_claim_token_sha256 REGEXP '^[0-9a-f]{64}$'
      AND store_db_timestamp_ms>=0
      AND receipt_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT write_operation_sha256,tenant_id,scope,protocol,domain,target_sha256,
       target_receipt_sha256,inventory_sha256,inventory_receipt_sha256,
       artifact_id_sha256,artifact_generation,payload_sha256,manifest_sha256,
       adapter_protocol,outcome,replayed,adapter_evidence_sha256,reservation_receipt_sha256,
       mutation_started_at_db_ms,mutation_started_claim_attempt,
       mutation_started_claim_token_sha256,completed_claim_attempt,
       completed_claim_token_sha256,store_db_timestamp_ms,receipt_sha256
  FROM tenant_telemetry_write_acks FORCE INDEX (
    PRIMARY,uk_tenant_telemetry_write_ack_receipt,uk_tenant_telemetry_write_ack_adapter,
    uk_tenant_telemetry_write_ack_inventory,idx_tenant_telemetry_write_ack_tenant
  ) WHERE 1=0;

-- A frozen 0033 writer publishes admission -> lifecycle gate -> seq-1 audit -> T1 fence ->
-- credential job, but it does not publish the telemetry lifecycle subject.  Once 0034 is present,
-- reject that stale write at the job boundary so the surrounding T1 transaction rolls back.  The
-- 0034 writer publishes and validates the exact subject immediately before this insert.  The
-- migration executor treats this one bootstrap CREATE as verify-or-create: an exact surviving
-- bootstrap is retained on replay, so a crash after dropping the primary guard cannot make the
-- next replay delete the only remaining fence before rebuilding the primary.
CREATE TRIGGER trg_tenant_telemetry_t1_job_bi_bootstrap BEFORE INSERT ON tenant_credential_revocation_jobs FOR EACH ROW BEGIN IF EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_control c WHERE c.singleton_id=1 AND c.control_generation=1 AND c.activated_at_db_ms IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_subjects s WHERE BINARY s.request_id=BINARY NEW.request_id AND BINARY s.tenant_id=BINARY NEW.tenant_id AND s.subject_generation=NEW.subject_generation AND BINARY s.t1_fence_sha256=BINARY NEW.t1_fence_sha256 AND s.control_generation=1) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry lifecycle subject must precede T1 job'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_telemetry_t1_job_bi;
CREATE TRIGGER trg_tenant_telemetry_t1_job_bi BEFORE INSERT ON tenant_credential_revocation_jobs FOR EACH ROW BEGIN IF EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_control c WHERE c.singleton_id=1 AND c.control_generation=1 AND c.activated_at_db_ms IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_subjects s WHERE BINARY s.request_id=BINARY NEW.request_id AND BINARY s.tenant_id=BINARY NEW.tenant_id AND s.subject_generation=NEW.subject_generation AND BINARY s.t1_fence_sha256=BINARY NEW.t1_fence_sha256 AND s.control_generation=1) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry lifecycle subject must precede T1 job'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_telemetry_t1_job_bi_bootstrap;

-- Keep the spool source-bound and append-only.  The only permitted content removal is deletion of
-- a payload after the same transaction has installed an exact ACK, immutable 0033 inventory and a
-- terminal job projection.
DROP TRIGGER IF EXISTS trg_managed_telemetry_write_jobs_bi;
CREATE TRIGGER trg_managed_telemetry_write_jobs_bi BEFORE INSERT ON tenant_telemetry_write_jobs FOR EACH ROW BEGIN IF (EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_control c WHERE c.singleton_id=1 AND c.control_generation=1 AND c.writer_protocol='structured-telemetry-v1' AND c.activated_at_db_ms<=NEW.created_at_ms) AND EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_targets t WHERE BINARY t.target_sha256=BINARY NEW.target_sha256 AND BINARY t.domain=BINARY NEW.domain AND t.control_generation=1) AND EXISTS (SELECT 1 FROM subject_lifecycle s WHERE BINARY s.tenant_id=BINARY NEW.tenant_id AND s.subject_kind='tenant' AND BINARY s.subject_id=BINARY NEW.tenant_id AND s.state='active' AND s.created_at_ms<=NEW.created_at_ms) AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_artifact_inventory i WHERE BINARY i.inventory_sha256=BINARY NEW.inventory_sha256) AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.inventory_json,'$.tenantId'))=BINARY NEW.tenant_id AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.inventory_json,'$.domain'))=BINARY NEW.domain AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.inventory_json,'$.targetSha256'))=BINARY NEW.target_sha256 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.inventory_json,'$.inventorySha256'))=BINARY NEW.inventory_sha256 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.inventory_json,'$.artifactIdSha256'))=BINARY NEW.artifact_id_sha256 AND CAST(JSON_UNQUOTE(JSON_EXTRACT(NEW.inventory_json,'$.artifactGeneration')) AS UNSIGNED)=NEW.artifact_generation AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.inventory_json,'$.payloadSha256'))=BINARY NEW.payload_sha256 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.inventory_json,'$.manifestSha256'))=BINARY NEW.manifest_sha256) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry write job is not active-source-bound'; END IF; END;
DROP TRIGGER IF EXISTS trg_managed_telemetry_write_jobs_bu;
CREATE TRIGGER trg_managed_telemetry_write_jobs_bu BEFORE UPDATE ON tenant_telemetry_write_jobs FOR EACH ROW BEGIN IF (BINARY OLD.write_operation_sha256=BINARY NEW.write_operation_sha256 AND BINARY OLD.tenant_id=BINARY NEW.tenant_id AND BINARY OLD.protocol=BINARY NEW.protocol AND BINARY OLD.domain=BINARY NEW.domain AND BINARY OLD.target_sha256=BINARY NEW.target_sha256 AND BINARY OLD.inventory_sha256=BINARY NEW.inventory_sha256 AND BINARY OLD.artifact_id_sha256=BINARY NEW.artifact_id_sha256 AND OLD.artifact_generation=NEW.artifact_generation AND BINARY OLD.payload_sha256=BINARY NEW.payload_sha256 AND BINARY OLD.manifest_sha256=BINARY NEW.manifest_sha256 AND OLD.inventory_json=NEW.inventory_json AND OLD.record_count=NEW.record_count AND OLD.payload_byte_length=NEW.payload_byte_length AND OLD.created_at_ms=NEW.created_at_ms AND OLD.phase='queued' AND ((NEW.phase='queued' AND NEW.attempts>=OLD.attempts AND NEW.updated_at_ms>=OLD.updated_at_ms) OR (NEW.phase='blocked' AND NEW.blocked_reason_code='integrity_conflict' AND NEW.updated_at_ms>=OLD.updated_at_ms) OR (NEW.phase='written' AND EXISTS (SELECT 1 FROM tenant_telemetry_write_acks a WHERE BINARY a.write_operation_sha256=BINARY NEW.write_operation_sha256 AND BINARY a.receipt_sha256=BINARY NEW.write_ack_receipt_sha256 AND a.completed_claim_attempt=NEW.completed_claim_attempt AND BINARY a.completed_claim_token_sha256=BINARY NEW.completed_claim_token_sha256 AND a.store_db_timestamp_ms=NEW.written_at_db_ms) AND EXISTS (SELECT 1 FROM tenant_telemetry_artifact_inventory i WHERE BINARY i.inventory_sha256=BINARY NEW.inventory_sha256 AND BINARY i.receipt_sha256=BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.inventory_json,'$.receiptSha256'))) AND NEW.updated_at_ms>=OLD.updated_at_ms))) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry write job transition is invalid'; END IF; END;
DROP TRIGGER IF EXISTS trg_managed_telemetry_write_jobs_bd;
CREATE TRIGGER trg_managed_telemetry_write_jobs_bd BEFORE DELETE ON tenant_telemetry_write_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry write job is append-only';

DROP TRIGGER IF EXISTS trg_managed_telemetry_write_jobs_reservation_bi;
CREATE TRIGGER trg_managed_telemetry_write_jobs_reservation_bi BEFORE INSERT ON tenant_telemetry_write_jobs FOR EACH ROW BEGIN IF NOT (NEW.mutation_adapter_protocol IS NULL AND NEW.mutation_started_at_db_ms IS NULL AND NEW.mutation_started_claim_attempt IS NULL AND NEW.mutation_started_claim_token_sha256 IS NULL AND NEW.mutation_reservation_receipt_sha256 IS NULL) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry mutation reservation must start empty'; END IF; END;
DROP TRIGGER IF EXISTS trg_managed_telemetry_write_jobs_reservation_bu;
CREATE TRIGGER trg_managed_telemetry_write_jobs_reservation_bu BEFORE UPDATE ON tenant_telemetry_write_jobs FOR EACH ROW BEGIN IF ((OLD.mutation_reservation_receipt_sha256 IS NULL AND ((NEW.mutation_reservation_receipt_sha256 IS NULL AND NEW.mutation_adapter_protocol IS NULL AND NEW.mutation_started_at_db_ms IS NULL AND NEW.mutation_started_claim_attempt IS NULL AND NEW.mutation_started_claim_token_sha256 IS NULL) OR (OLD.phase='queued' AND NEW.phase='queued' AND OLD.claim_token IS NOT NULL AND OLD.lease_until_ms IS NOT NULL AND NEW.mutation_adapter_protocol IS NOT NULL AND NEW.mutation_started_at_db_ms>=OLD.created_at_ms AND NEW.mutation_started_claim_attempt=OLD.attempts AND NEW.mutation_started_claim_attempt=NEW.attempts AND BINARY NEW.mutation_started_claim_token_sha256=BINARY SHA2(CONCAT('["tenant-telemetry-write-claim-token-v1","',OLD.claim_token,'"]'),256) AND NEW.mutation_reservation_receipt_sha256 IS NOT NULL AND EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_targets t WHERE BINARY t.target_sha256=BINARY OLD.target_sha256 AND BINARY t.adapter_protocol=BINARY NEW.mutation_adapter_protocol)))) OR (OLD.mutation_reservation_receipt_sha256 IS NOT NULL AND BINARY OLD.mutation_adapter_protocol=BINARY NEW.mutation_adapter_protocol AND OLD.mutation_started_at_db_ms=NEW.mutation_started_at_db_ms AND OLD.mutation_started_claim_attempt=NEW.mutation_started_claim_attempt AND BINARY OLD.mutation_started_claim_token_sha256=BINARY NEW.mutation_started_claim_token_sha256 AND BINARY OLD.mutation_reservation_receipt_sha256=BINARY NEW.mutation_reservation_receipt_sha256)) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry mutation reservation is invalid'; END IF; END;
DROP TRIGGER IF EXISTS trg_managed_telemetry_write_jobs_terminal_reservation_bu;
CREATE TRIGGER trg_managed_telemetry_write_jobs_terminal_reservation_bu BEFORE UPDATE ON tenant_telemetry_write_jobs FOR EACH ROW BEGIN IF NEW.phase='written' AND NEW.mutation_reservation_receipt_sha256 IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='written telemetry job lacks mutation reservation'; END IF; END;

DROP TRIGGER IF EXISTS trg_managed_telemetry_write_payloads_bi;
CREATE TRIGGER trg_managed_telemetry_write_payloads_bi BEFORE INSERT ON tenant_telemetry_write_payloads FOR EACH ROW BEGIN IF NOT EXISTS (SELECT 1 FROM tenant_telemetry_write_jobs j WHERE BINARY j.write_operation_sha256=BINARY NEW.write_operation_sha256 AND BINARY j.tenant_id=BINARY NEW.tenant_id AND BINARY j.domain=BINARY NEW.domain AND BINARY j.payload_sha256=BINARY NEW.payload_sha256 AND j.record_count=NEW.record_count AND j.payload_byte_length=NEW.payload_byte_length AND j.created_at_ms=NEW.created_at_ms AND j.phase='queued' AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.payload_json,'$.schema'))=BINARY 'agent-service.telemetry-artifact.v1' AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.payload_json,'$.domain'))=BINARY NEW.domain AND JSON_LENGTH(JSON_EXTRACT(NEW.payload_json,'$.records'))=NEW.record_count) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry write payload is not job-bound'; END IF; END;
DROP TRIGGER IF EXISTS trg_managed_telemetry_write_payloads_bu;
CREATE TRIGGER trg_managed_telemetry_write_payloads_bu BEFORE UPDATE ON tenant_telemetry_write_payloads FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry write payload is immutable';
DROP TRIGGER IF EXISTS trg_managed_telemetry_write_payloads_bd;
CREATE TRIGGER trg_managed_telemetry_write_payloads_bd BEFORE DELETE ON tenant_telemetry_write_payloads FOR EACH ROW BEGIN IF NOT EXISTS (SELECT 1 FROM tenant_telemetry_write_jobs j JOIN tenant_telemetry_write_acks a ON BINARY a.write_operation_sha256=BINARY j.write_operation_sha256 WHERE BINARY j.write_operation_sha256=BINARY OLD.write_operation_sha256 AND BINARY j.tenant_id=BINARY OLD.tenant_id AND j.phase='written' AND BINARY j.write_ack_receipt_sha256=BINARY a.receipt_sha256) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry write payload cannot be removed before ACK'; END IF; END;

DROP TRIGGER IF EXISTS trg_managed_telemetry_write_acks_bi;
CREATE TRIGGER trg_managed_telemetry_write_acks_bi BEFORE INSERT ON tenant_telemetry_write_acks FOR EACH ROW BEGIN IF NOT (EXISTS (SELECT 1 FROM tenant_telemetry_write_jobs j WHERE BINARY j.write_operation_sha256=BINARY NEW.write_operation_sha256 AND BINARY j.tenant_id=BINARY NEW.tenant_id AND j.phase='queued' AND j.claim_token IS NOT NULL AND j.lease_until_ms IS NOT NULL AND j.attempts=NEW.completed_claim_attempt AND BINARY j.domain=BINARY NEW.domain AND BINARY j.target_sha256=BINARY NEW.target_sha256 AND BINARY j.inventory_sha256=BINARY NEW.inventory_sha256 AND BINARY j.artifact_id_sha256=BINARY NEW.artifact_id_sha256 AND j.artifact_generation=NEW.artifact_generation AND BINARY j.payload_sha256=BINARY NEW.payload_sha256 AND BINARY j.manifest_sha256=BINARY NEW.manifest_sha256) AND EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_targets t WHERE BINARY t.target_sha256=BINARY NEW.target_sha256 AND BINARY t.receipt_sha256=BINARY NEW.target_receipt_sha256 AND BINARY t.adapter_protocol=BINARY NEW.adapter_protocol) AND EXISTS (SELECT 1 FROM tenant_telemetry_artifact_inventory i WHERE BINARY i.inventory_sha256=BINARY NEW.inventory_sha256 AND BINARY i.receipt_sha256=BINARY NEW.inventory_receipt_sha256 AND BINARY i.tenant_id=BINARY NEW.tenant_id AND BINARY i.domain=BINARY NEW.domain AND BINARY i.target_sha256=BINARY NEW.target_sha256 AND BINARY i.artifact_id_sha256=BINARY NEW.artifact_id_sha256 AND i.artifact_generation=NEW.artifact_generation AND BINARY i.payload_sha256=BINARY NEW.payload_sha256 AND BINARY i.manifest_sha256=BINARY NEW.manifest_sha256)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry write ACK is not source-bound'; END IF; END;
DROP TRIGGER IF EXISTS trg_managed_telemetry_write_acks_bu;
CREATE TRIGGER trg_managed_telemetry_write_acks_bu BEFORE UPDATE ON tenant_telemetry_write_acks FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry write ACK is immutable';
DROP TRIGGER IF EXISTS trg_managed_telemetry_write_acks_bd;
CREATE TRIGGER trg_managed_telemetry_write_acks_bd BEFORE DELETE ON tenant_telemetry_write_acks FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry write ACK is append-only';

DROP TRIGGER IF EXISTS trg_managed_telemetry_write_acks_reservation_bi;
CREATE TRIGGER trg_managed_telemetry_write_acks_reservation_bi BEFORE INSERT ON tenant_telemetry_write_acks FOR EACH ROW BEGIN IF NOT EXISTS (SELECT 1 FROM tenant_telemetry_write_jobs j WHERE BINARY j.write_operation_sha256=BINARY NEW.write_operation_sha256 AND BINARY j.tenant_id=BINARY NEW.tenant_id AND BINARY j.mutation_adapter_protocol=BINARY NEW.adapter_protocol AND BINARY j.inventory_sha256=BINARY NEW.inventory_sha256 AND BINARY j.manifest_sha256=BINARY NEW.manifest_sha256 AND BINARY j.mutation_reservation_receipt_sha256=BINARY NEW.reservation_receipt_sha256 AND j.mutation_started_at_db_ms=NEW.mutation_started_at_db_ms AND j.mutation_started_claim_attempt=NEW.mutation_started_claim_attempt AND BINARY j.mutation_started_claim_token_sha256=BINARY NEW.mutation_started_claim_token_sha256) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry write ACK reservation is not source-bound'; END IF; END;

-- A sink create can commit immediately before T1 wins the tenant gate.  The pre-0034 inventory
-- guard correctly rejects new artifacts for a gated tenant, but that rule would also strand this
-- already-external write without a durable ACK.  Preserve the ordinary 0033 source checks and add
-- one narrow escape: an exact, already-claimed 0034 job whose immutable JSON snapshot matches every
-- inventory column may finish publication.  This does not authorize a new enqueue after T1.
DROP TRIGGER IF EXISTS trg_tenant_telemetry_artifact_bi;
CREATE TRIGGER trg_tenant_telemetry_artifact_bi BEFORE INSERT ON tenant_telemetry_artifact_inventory FOR EACH ROW BEGIN IF NOT ((EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_control c WHERE c.singleton_id=1 AND c.control_generation=NEW.control_generation AND c.control_generation=1 AND c.writer_protocol=NEW.writer_protocol AND c.activated_at_db_ms<=NEW.created_at_db_ms) AND EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_targets t WHERE t.singleton_id=1 AND t.control_generation=NEW.control_generation AND BINARY t.domain=BINARY NEW.domain AND BINARY t.target_sha256=BINARY NEW.target_sha256) AND EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_coverages v WHERE BINARY v.tenant_id=BINARY NEW.tenant_id AND v.control_generation=NEW.control_generation AND BINARY v.evidence_sha256=BINARY NEW.coverage_evidence_sha256 AND BINARY v.history_status=BINARY NEW.history_status AND BINARY v.subject_ref_sha256=BINARY NEW.tenant_ref_sha256 AND v.coverage_started_at_db_ms<=NEW.created_at_db_ms) AND EXISTS (SELECT 1 FROM subject_lifecycle s WHERE BINARY s.tenant_id=BINARY NEW.tenant_id AND s.subject_kind='tenant' AND BINARY s.subject_id=BINARY NEW.tenant_id AND s.state='active' AND s.created_at_ms<=NEW.created_at_db_ms) AND (EXISTS (SELECT 1 FROM retention_policy_controls p WHERE BINARY p.tenant_id=BINARY NEW.tenant_id AND p.control_generation=NEW.retention_policy_control_generation AND p.active_policy_sha256<=>NEW.retention_policy_sha256 AND p.updated_at_ms<=NEW.created_at_db_ms) OR (NEW.retention_policy_control_generation=0 AND NEW.retention_policy_sha256 IS NULL AND NOT EXISTS (SELECT 1 FROM retention_policy_controls p WHERE BINARY p.tenant_id=BINARY NEW.tenant_id) AND NOT EXISTS (SELECT 1 FROM retention_policy_activation_events e WHERE BINARY e.tenant_id=BINARY NEW.tenant_id))) AND (EXISTS (SELECT 1 FROM legal_hold_controls h WHERE BINARY h.tenant_id=BINARY NEW.tenant_id AND h.subject_kind='tenant' AND BINARY h.subject_id=BINARY NEW.tenant_id AND h.control_generation=NEW.tenant_hold_control_generation AND BINARY h.active_projection_sha256=BINARY NEW.tenant_hold_projection_sha256 AND h.updated_at_ms<=NEW.created_at_db_ms) OR (NEW.tenant_hold_control_generation=0 AND BINARY NEW.tenant_hold_projection_sha256=BINARY 'd336a3d705ffe91a7158c28e0e39f45cbc278d4a8890c738d9da03a164fd140f' AND NOT EXISTS (SELECT 1 FROM legal_hold_controls h WHERE BINARY h.tenant_id=BINARY NEW.tenant_id AND h.subject_kind='tenant' AND BINARY h.subject_id=BINARY NEW.tenant_id) AND NOT EXISTS (SELECT 1 FROM legal_holds h WHERE BINARY h.tenant_id=BINARY NEW.tenant_id AND h.subject_kind='tenant' AND BINARY h.subject_id=BINARY NEW.tenant_id) AND NOT EXISTS (SELECT 1 FROM legal_hold_events e WHERE BINARY e.tenant_id=BINARY NEW.tenant_id AND e.subject_kind='tenant' AND BINARY e.subject_id=BINARY NEW.tenant_id))) AND (NEW.owner_kind<>'tenant' OR (NEW.owner_hold_control_generation=NEW.tenant_hold_control_generation AND BINARY NEW.owner_hold_projection_sha256=BINARY NEW.tenant_hold_projection_sha256)) AND ((NEW.restore_control_generation=0 AND NEW.restore_lineage_kind='inactive' AND NEW.restore_updated_at_db_ms=0 AND NEW.runtime_epoch_sha256 IS NULL AND EXISTS (SELECT 1 FROM tenant_restore_runtime_control r WHERE r.singleton_id=1 AND r.state='inactive' AND r.control_generation=0)) OR EXISTS (SELECT 1 FROM tenant_restore_runtime_control r WHERE r.singleton_id=1 AND r.state='active' AND r.control_generation=NEW.restore_control_generation AND BINARY r.lineage_kind=BINARY NEW.restore_lineage_kind AND r.updated_at_db_ms=NEW.restore_updated_at_db_ms AND BINARY r.runtime_epoch_sha256=BINARY NEW.runtime_epoch_sha256 AND r.updated_at_db_ms<=NEW.created_at_db_ms))) OR EXISTS (SELECT 1 FROM tenant_telemetry_write_jobs j JOIN tenant_telemetry_write_payloads p ON BINARY p.write_operation_sha256=BINARY j.write_operation_sha256 WHERE j.phase='queued' AND j.claim_token IS NOT NULL AND j.lease_until_ms IS NOT NULL AND BINARY j.tenant_id=BINARY NEW.tenant_id AND BINARY j.domain=BINARY NEW.domain AND BINARY j.target_sha256=BINARY NEW.target_sha256 AND BINARY j.inventory_sha256=BINARY NEW.inventory_sha256 AND BINARY j.artifact_id_sha256=BINARY NEW.artifact_id_sha256 AND j.artifact_generation=NEW.artifact_generation AND BINARY j.payload_sha256=BINARY NEW.payload_sha256 AND BINARY j.manifest_sha256=BINARY NEW.manifest_sha256 AND j.created_at_ms=NEW.created_at_db_ms AND BINARY p.tenant_id=BINARY NEW.tenant_id AND BINARY p.payload_sha256=BINARY NEW.payload_sha256 AND j.inventory_json=JSON_OBJECT('inventorySha256',NEW.inventory_sha256,'tenantId',NEW.tenant_id,'controlGeneration',NEW.control_generation,'scope',NEW.scope,'domain',NEW.domain,'targetSha256',NEW.target_sha256,'artifactIdSha256',NEW.artifact_id_sha256,'artifactGeneration',NEW.artifact_generation,'ownerKind',NEW.owner_kind,'tenantRefSha256',NEW.tenant_ref_sha256,'ownerRefSha256',NEW.owner_ref_sha256,'holdSubjectRefSha256',NEW.hold_subject_ref_sha256,'coverageEvidenceSha256',NEW.coverage_evidence_sha256,'historyStatus',NEW.history_status,'writerProtocol',NEW.writer_protocol,'writerGeneration',NEW.writer_generation,'sourceSchema',NEW.source_schema,'sourceGeneration',NEW.source_generation,'sourceHighWaterDbMs',NEW.source_high_water_db_ms,'payloadSha256',NEW.payload_sha256,'manifestSha256',NEW.manifest_sha256,'retentionClass',NEW.retention_class,'retentionPolicyControlGeneration',NEW.retention_policy_control_generation,'retentionPolicySha256',NEW.retention_policy_sha256,'disposeAfterDbMs',NEW.dispose_after_db_ms,'tenantHoldControlGeneration',NEW.tenant_hold_control_generation,'tenantHoldProjectionSha256',NEW.tenant_hold_projection_sha256,'ownerHoldControlGeneration',NEW.owner_hold_control_generation,'ownerHoldProjectionSha256',NEW.owner_hold_projection_sha256,'restoreControlGeneration',NEW.restore_control_generation,'restoreLineageKind',NEW.restore_lineage_kind,'restoreUpdatedAtDbMs',NEW.restore_updated_at_db_ms,'runtimeEpochSha256',NEW.runtime_epoch_sha256,'createdAtDbMs',NEW.created_at_db_ms,'receiptSha256',NEW.receipt_sha256))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry artifact inventory is not source-bound'; END IF; END;

DROP TRIGGER IF EXISTS trg_managed_telemetry_artifact_reservation_bi;
CREATE TRIGGER trg_managed_telemetry_artifact_reservation_bi BEFORE INSERT ON tenant_telemetry_artifact_inventory FOR EACH ROW BEGIN IF EXISTS (SELECT 1 FROM tenant_telemetry_write_jobs j WHERE j.phase='queued' AND j.claim_token IS NOT NULL AND BINARY j.inventory_sha256=BINARY NEW.inventory_sha256 AND BINARY j.tenant_id=BINARY NEW.tenant_id) AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_write_jobs j WHERE j.phase='queued' AND j.claim_token IS NOT NULL AND BINARY j.inventory_sha256=BINARY NEW.inventory_sha256 AND BINARY j.tenant_id=BINARY NEW.tenant_id AND j.mutation_reservation_receipt_sha256 IS NOT NULL) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry artifact lacks mutation reservation'; END IF; END;

-- The constants below come from a disposable real MySQL 8 installation.  The runtime extracts
-- these exact marked statements on every current-schema startup, so a privileged partial-DDL or
-- trigger drift fails closed even after the migration marker has been recorded.
SET @tenant_telemetry_writer_previous_group_concat_max_len=@@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len=1048576;
-- agent-service-runtime-fingerprint:tenant-telemetry-durable-writer-schema:start
SET @telemetry_durable_writer_schema_ok=(
  (SELECT COUNT(*)=3
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,table_type,
             IFNULL(engine,'-'),IFNULL(table_collation,'-'))
           ORDER BY table_name SEPARATOR '|'),256)=
         'c5efe9c95b55085cd8bdd8eb0e4b868576f7e53d8d16ae6ca18ec739e4984315'
     FROM information_schema.tables
    WHERE table_schema=DATABASE() AND table_name IN (
      'tenant_telemetry_write_jobs','tenant_telemetry_write_payloads',
      'tenant_telemetry_write_acks'))
  AND
  (SELECT COUNT(*)=65
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,LPAD(ordinal_position,3,'0'),
             column_name,LOWER(column_type),is_nullable,
             IF(column_default IS NULL,'<NULL>',CONCAT('<',column_default,'>')),
             IFNULL(character_set_name,'-'),IFNULL(collation_name,'-'),
             IFNULL(NULLIF(LOWER(extra),''),'-'),
             IFNULL(NULLIF(LOWER(generation_expression),''),'-'))
           ORDER BY table_name,ordinal_position SEPARATOR '|'),256)=
         'cd94ba77a1334726f2473db4cb4908eb466aeb5ee7dbfc7c70e38109492483c5'
     FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name IN (
      'tenant_telemetry_write_jobs','tenant_telemetry_write_payloads',
      'tenant_telemetry_write_acks'))
  AND
  (SELECT COUNT(DISTINCT CONCAT(table_name,'~',index_name))=14 AND COUNT(*)=29
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,index_name,non_unique,
             seq_in_index,LOWER(index_type),LOWER(is_visible),
             IFNULL(column_name,'<expression>'),IFNULL(CAST(sub_part AS CHAR),'-'),
             LOWER(IFNULL(collation,'-')),IFNULL(expression,'-'))
           ORDER BY table_name,index_name,seq_in_index SEPARATOR '|'),256)=
         'f6a8540a3c8fb5a282e01484bc056295378265ab2ac675000fc0a764cad74b76'
     FROM information_schema.statistics
    WHERE table_schema=DATABASE() AND table_name IN (
      'tenant_telemetry_write_jobs','tenant_telemetry_write_payloads',
      'tenant_telemetry_write_acks'))
  AND
  (SELECT COUNT(*)=3
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',tc.table_name,tc.constraint_name,tc.enforced,
             LOWER(REPLACE(REPLACE(REGEXP_REPLACE(cc.check_clause,'[[:space:]]',''),
               CHAR(96),''),'_utf8mb4','')))
           ORDER BY tc.table_name,tc.constraint_name SEPARATOR '|'),256)=
         'f13f755088b44ecb3e9b084295a858716fa522a5e57f5665b57971c218abe090'
     FROM information_schema.table_constraints tc
     JOIN information_schema.check_constraints cc
       ON cc.constraint_schema=tc.constraint_schema
      AND cc.constraint_name=tc.constraint_name
    WHERE tc.table_schema=DATABASE() AND tc.constraint_type='CHECK'
      AND tc.table_name IN (
        'tenant_telemetry_write_jobs','tenant_telemetry_write_payloads',
        'tenant_telemetry_write_acks'))
  AND
  (SELECT COUNT(*)=16
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,constraint_type,enforced)
           ORDER BY table_name,constraint_name SEPARATOR '|'),256)=
         '9394c0265e54d105e73fde730f96de5fbdaceb11eb8c8be66a2ca87933592324'
     FROM information_schema.table_constraints
    WHERE table_schema=DATABASE() AND table_name IN (
      'tenant_telemetry_write_jobs','tenant_telemetry_write_payloads',
      'tenant_telemetry_write_acks'))
  AND
  (SELECT COUNT(DISTINCT CONCAT(k.table_name,'~',k.constraint_name))=5 AND COUNT(*)=5
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',k.table_name,k.constraint_name,
             k.ordinal_position,k.column_name,k.referenced_table_name,
             k.referenced_column_name,r.update_rule,r.delete_rule)
           ORDER BY k.table_name,k.constraint_name,k.ordinal_position SEPARATOR '|'),256)=
         '2df58c8773294ac753f2038d01138ca6351a8cc0ccc146c1cae0edd5dcded05f'
     FROM information_schema.key_column_usage k
     JOIN information_schema.referential_constraints r
       ON r.constraint_schema=k.constraint_schema AND r.constraint_name=k.constraint_name
    WHERE k.table_schema=DATABASE() AND k.referenced_table_name IS NOT NULL
      AND k.table_name IN (
        'tenant_telemetry_write_jobs','tenant_telemetry_write_payloads',
        'tenant_telemetry_write_acks'))
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.partitions
     WHERE table_schema=DATABASE() AND partition_name IS NOT NULL
       AND table_name IN (
        'tenant_telemetry_write_jobs','tenant_telemetry_write_payloads',
        'tenant_telemetry_write_acks'))
);
-- agent-service-runtime-fingerprint:tenant-telemetry-durable-writer-schema:end
SET @migration_sql=IF(@telemetry_durable_writer_schema_ok=1,'SELECT 1',
  'SELECT 1 FROM __invalid_tenant_telemetry_durable_writer_schema__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
-- agent-service-runtime-fingerprint:tenant-telemetry-durable-writer-triggers:start
SET @telemetry_durable_writer_trigger_ok=(
  SELECT COUNT(*)=33 AND COUNT(DISTINCT trigger_name)=33
     AND SHA2(GROUP_CONCAT(CONCAT_WS('~',event_object_table,trigger_name,
           action_timing,event_manipulation,action_orientation,
           IFNULL(action_condition,'<NULL>'),
           LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),
             CHAR(96),''),'_utf8mb4','')))
         ORDER BY event_object_table,trigger_name SEPARATOR '|'),256)=
       'fd65d837e5d9959623d994bd50c8be3cc4ee2d3e5ec7ad2996fa0e69d9a0b7e5'
    FROM information_schema.triggers
   WHERE trigger_schema=DATABASE()
     AND (event_object_table IN (
       'tenant_telemetry_lifecycle_control','tenant_telemetry_lifecycle_targets',
       'tenant_telemetry_lifecycle_coverages','tenant_telemetry_lifecycle_subjects',
       'tenant_telemetry_activation_receipts','tenant_telemetry_artifact_inventory',
       'tenant_telemetry_write_jobs','tenant_telemetry_write_payloads',
       'tenant_telemetry_write_acks') OR
       (event_object_table='tenant_credential_revocation_jobs'
         AND action_timing='BEFORE' AND event_manipulation='INSERT'))
);
-- agent-service-runtime-fingerprint:tenant-telemetry-durable-writer-triggers:end
SET @migration_sql=IF(@telemetry_durable_writer_trigger_ok=1,'SELECT 1',
  'SELECT 1 FROM __invalid_tenant_telemetry_durable_writer_triggers__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
SET SESSION group_concat_max_len=@tenant_telemetry_writer_previous_group_concat_max_len;

-- Marker-loss replay is permitted only for an internally closed projection.  A fresh 0034 upgrade
-- has no jobs.  A retried migration may contain queued jobs with one payload each, written jobs with
-- one inventory+ACK and no payload, or blocked jobs with one retained payload for operator recovery.
SET @telemetry_durable_writer_projection_ok=(
  NOT EXISTS (
    SELECT 1 FROM tenant_telemetry_write_jobs j
     LEFT JOIN tenant_telemetry_write_payloads p
       ON BINARY p.write_operation_sha256=BINARY j.write_operation_sha256
     LEFT JOIN tenant_telemetry_write_acks a
       ON BINARY a.write_operation_sha256=BINARY j.write_operation_sha256
    WHERE (j.phase='queued' AND (p.write_operation_sha256 IS NULL OR a.write_operation_sha256 IS NOT NULL))
       OR (j.phase='written' AND (p.write_operation_sha256 IS NOT NULL OR a.write_operation_sha256 IS NULL))
       OR (j.phase='blocked' AND (p.write_operation_sha256 IS NULL OR a.write_operation_sha256 IS NOT NULL))
  )
  AND NOT EXISTS (
    SELECT 1 FROM tenant_telemetry_write_payloads p
     LEFT JOIN tenant_telemetry_write_jobs j
       ON BINARY j.write_operation_sha256=BINARY p.write_operation_sha256
    WHERE j.write_operation_sha256 IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM tenant_telemetry_write_acks a
     LEFT JOIN tenant_telemetry_write_jobs j
       ON BINARY j.write_operation_sha256=BINARY a.write_operation_sha256
    WHERE j.write_operation_sha256 IS NULL OR j.phase<>'written'
  )
);
SET @migration_sql=IF(@telemetry_durable_writer_projection_ok=1,'SELECT 1',
  'SELECT 1 FROM __invalid_tenant_telemetry_durable_writer_projection__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
