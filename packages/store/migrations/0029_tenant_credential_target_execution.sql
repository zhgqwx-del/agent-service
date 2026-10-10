-- Expand-only, default-dormant substrate for replay-safe external credential disposition.
--
-- Applying this migration does not scan credential references, materialize a job, decrypt a
-- target, call an adapter, revoke anything, activate the cutover, or advance tenant erasure.
-- Jobs bind the terminal T3a receipt and its immutable 0026 inventory. KMS execution is reserved:
-- this schema can record KMS blockers but cannot create a KMS target or claim KMS completion.

CREATE TABLE IF NOT EXISTS tenant_credential_target_execution_cutover (
  singleton_id                           TINYINT UNSIGNED NOT NULL,
  control_generation                     BIGINT UNSIGNED NOT NULL DEFAULT 0,
  activated_at_db_ms                     BIGINT NULL,
  first_request_id                       VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  first_receipt_sha256                   CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  execution_protocol                     VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  external_credential_execution_enabled  BOOLEAN NULL,
  kms_key_execution_enabled              BOOLEAN NULL,
  evidence_sha256                        CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  PRIMARY KEY (singleton_id),
  CONSTRAINT chk_credential_target_exec_cutover_singleton CHECK (singleton_id = 1),
  CONSTRAINT chk_credential_target_exec_cutover_state CHECK (
    (control_generation = 0 AND activated_at_db_ms IS NULL AND first_request_id IS NULL
      AND first_receipt_sha256 IS NULL AND execution_protocol IS NULL
      AND external_credential_execution_enabled IS NULL
      AND kms_key_execution_enabled IS NULL AND evidence_sha256 IS NULL)
    OR
    (control_generation = 1 AND activated_at_db_ms >= 0 AND first_request_id IS NOT NULL
      AND first_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
      AND execution_protocol = 'tenant-credential-target-execution-v1'
      AND external_credential_execution_enabled = TRUE
      AND kms_key_execution_enabled = FALSE
      AND evidence_sha256 REGEXP '^[0-9a-f]{64}$')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT singleton_id, control_generation, activated_at_db_ms, first_request_id,
       first_receipt_sha256, execution_protocol, external_credential_execution_enabled,
       kms_key_execution_enabled, evidence_sha256
  FROM tenant_credential_target_execution_cutover FORCE INDEX (PRIMARY) WHERE 1=0;

INSERT INTO tenant_credential_target_execution_cutover
  (singleton_id, control_generation, activated_at_db_ms, first_request_id,
   first_receipt_sha256, execution_protocol, external_credential_execution_enabled,
   kms_key_execution_enabled, evidence_sha256)
SELECT 1,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL
 WHERE NOT EXISTS (
   SELECT 1 FROM tenant_credential_target_execution_cutover WHERE singleton_id=1
 );

CREATE TABLE IF NOT EXISTS tenant_credential_target_execution_jobs (
  request_id                             VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                              VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation                     BIGINT UNSIGNED NOT NULL,
  target_execution_generation            BIGINT UNSIGNED NOT NULL,
  t3a_receipt_sha256                      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  inventory_receipt_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tracking_cutover_evidence_sha256        CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  version_count                          BIGINT UNSIGNED NOT NULL,
  version_root_sha256                     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_disposition_count               BIGINT UNSIGNED NOT NULL,
  target_disposition_root_sha256          CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  external_credential_target_count       BIGINT UNSIGNED NOT NULL,
  external_credential_target_root_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  external_credential_blocker_count      BIGINT UNSIGNED NOT NULL,
  kms_key_blocker_count                  BIGINT UNSIGNED NOT NULL,
  kms_key_executable_target_count        BIGINT UNSIGNED NOT NULL,
  source_evidence_db_ms                  BIGINT NOT NULL,
  phase                                  VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_count                           BIGINT UNSIGNED NOT NULL,
  target_root_sha256                     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_ack_count                       BIGINT UNSIGNED NOT NULL,
  target_ack_root_sha256                 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  adapter_evidence_count                 BIGINT UNSIGNED NOT NULL,
  adapter_evidence_root_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  unresolved_blocker_count               BIGINT UNSIGNED NOT NULL,
  available_at_ms                        BIGINT NULL,
  attempts                               INT UNSIGNED NOT NULL DEFAULT 0,
  claim_token                            VARCHAR(128) COLLATE utf8mb4_0900_as_cs NULL,
  lease_until_ms                         BIGINT NULL,
  last_error_code                        VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL,
  created_at_ms                          BIGINT NOT NULL,
  updated_at_ms                          BIGINT NOT NULL,
  terminal_receipt_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  sealed_at_db_ms                        BIGINT NULL,
  completed_claim_attempt                INT UNSIGNED NULL,
  completed_claim_token_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  blocked_at_db_ms                       BIGINT NULL,
  blocked_reason_code                    VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL,
  PRIMARY KEY (request_id),
  UNIQUE KEY uk_credential_target_exec_job_owner
    (request_id, tenant_id, subject_generation, target_execution_generation),
  UNIQUE KEY uk_credential_target_exec_job_tenant (tenant_id, subject_generation),
  UNIQUE KEY uk_credential_target_exec_job_generation
    (tenant_id, subject_generation, target_execution_generation),
  KEY idx_credential_target_exec_job_claim
    (phase, available_at_ms, lease_until_ms, request_id),
  CONSTRAINT fk_credential_target_exec_job_inventory
    FOREIGN KEY (request_id, tenant_id, subject_generation, t3a_receipt_sha256)
    REFERENCES tenant_credential_inventory_receipts
      (request_id, tenant_id, subject_generation, t3a_receipt_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_credential_target_exec_job_source CHECK (
    subject_generation > 0 AND target_execution_generation > 0
      AND target_disposition_count = version_count * 2
      AND external_credential_target_count + external_credential_blocker_count <= version_count
      AND kms_key_blocker_count <= version_count
      AND kms_key_executable_target_count = 0
      AND source_evidence_db_ms >= 0
  ),
  CONSTRAINT chk_credential_target_exec_job_counts CHECK (
    target_count = external_credential_target_count
      AND target_ack_count <= target_count
      AND adapter_evidence_count = target_ack_count
      AND unresolved_blocker_count <= external_credential_blocker_count + kms_key_blocker_count
      AND created_at_ms >= 0 AND updated_at_ms >= created_at_ms
  ),
  CONSTRAINT chk_credential_target_exec_job_digests CHECK (
    t3a_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
      AND inventory_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
      AND tracking_cutover_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND version_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND target_disposition_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND external_credential_target_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND target_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND target_ack_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND adapter_evidence_root_sha256 REGEXP '^[0-9a-f]{64}$'
  ),
  CONSTRAINT chk_credential_target_exec_job_phase CHECK (
    (phase='queued' AND external_credential_blocker_count=0
      AND available_at_ms IS NOT NULL
      AND ((claim_token IS NULL AND lease_until_ms IS NULL
              AND available_at_ms >= updated_at_ms)
        OR (claim_token IS NOT NULL AND lease_until_ms IS NOT NULL
              AND lease_until_ms >= updated_at_ms AND attempts > 0))
      AND (last_error_code IS NULL OR
        (claim_token IS NULL AND last_error_code IN ('temporary_failure','dependency_pending')))
      AND terminal_receipt_sha256 IS NULL AND sealed_at_db_ms IS NULL
      AND completed_claim_attempt IS NULL AND completed_claim_token_sha256 IS NULL
      AND blocked_at_db_ms IS NULL AND blocked_reason_code IS NULL)
    OR
    (phase='external_credential_sealed' AND external_credential_blocker_count=0
      AND available_at_ms IS NULL AND claim_token IS NULL AND lease_until_ms IS NULL
      AND last_error_code IS NULL AND terminal_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
      AND sealed_at_db_ms >= source_evidence_db_ms AND sealed_at_db_ms <= updated_at_ms
      AND completed_claim_attempt=attempts AND attempts > 0
      AND completed_claim_token_sha256 REGEXP '^[0-9a-f]{64}$'
      AND target_ack_count=target_count AND adapter_evidence_count=target_count
      AND unresolved_blocker_count=kms_key_blocker_count
      AND blocked_at_db_ms IS NULL AND blocked_reason_code IS NULL)
    OR
    (phase='blocked' AND available_at_ms IS NULL AND claim_token IS NULL
      AND lease_until_ms IS NULL AND last_error_code IS NULL
      AND terminal_receipt_sha256 IS NULL AND sealed_at_db_ms IS NULL
      AND completed_claim_attempt IS NULL AND completed_claim_token_sha256 IS NULL
      AND blocked_at_db_ms >= source_evidence_db_ms AND blocked_at_db_ms <= updated_at_ms
      AND blocked_reason_code IN ('source_blocked','integrity_conflict')
      AND (blocked_reason_code <> 'source_blocked' OR external_credential_blocker_count > 0))
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT request_id, tenant_id, subject_generation, target_execution_generation,
       t3a_receipt_sha256, inventory_receipt_sha256, tracking_cutover_evidence_sha256,
       version_count, version_root_sha256, target_disposition_count,
       target_disposition_root_sha256, external_credential_target_count,
       external_credential_target_root_sha256, external_credential_blocker_count,
       kms_key_blocker_count, kms_key_executable_target_count, source_evidence_db_ms,
       phase, target_count, target_root_sha256, target_ack_count, target_ack_root_sha256,
       adapter_evidence_count, adapter_evidence_root_sha256, unresolved_blocker_count,
       available_at_ms, attempts, claim_token, lease_until_ms, last_error_code,
       created_at_ms, updated_at_ms, terminal_receipt_sha256, sealed_at_db_ms,
       completed_claim_attempt, completed_claim_token_sha256,
       blocked_at_db_ms, blocked_reason_code
  FROM tenant_credential_target_execution_jobs FORCE INDEX (
    PRIMARY, uk_credential_target_exec_job_owner, uk_credential_target_exec_job_tenant,
    uk_credential_target_exec_job_generation, idx_credential_target_exec_job_claim
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_credential_target_execution_targets (
  request_id                          VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                           VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation                  BIGINT UNSIGNED NOT NULL,
  target_execution_generation         BIGINT UNSIGNED NOT NULL,
  scope                               VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_ordinal                      BIGINT UNSIGNED NOT NULL,
  credential_version_id               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  domain                              VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_disposition                  VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_disposition_evidence_sha256  CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  adapter_protocol                    VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_reference_cipher_sha256      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_reference_key_id             VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_reference_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  operation_id_sha256                 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  captured_at_db_ms                   BIGINT NOT NULL,
  receipt_sha256                      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (request_id, target_ordinal),
  UNIQUE KEY uk_credential_target_exec_target_identity
    (request_id, credential_version_id, domain),
  UNIQUE KEY uk_credential_target_exec_target_ack_parent
    (request_id, tenant_id, subject_generation, target_execution_generation,
     target_ordinal, credential_version_id, domain, receipt_sha256,
     operation_id_sha256, adapter_protocol, target_reference_sha256),
  UNIQUE KEY uk_credential_target_exec_operation (operation_id_sha256),
  UNIQUE KEY uk_credential_target_exec_target_receipt (receipt_sha256),
  KEY idx_credential_target_exec_target_owner
    (tenant_id, subject_generation, target_execution_generation, request_id, target_ordinal),
  CONSTRAINT fk_credential_target_exec_target_job
    FOREIGN KEY (request_id, tenant_id, subject_generation, target_execution_generation)
    REFERENCES tenant_credential_target_execution_jobs
      (request_id, tenant_id, subject_generation, target_execution_generation)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_credential_target_exec_target_source
    FOREIGN KEY (tenant_id, credential_version_id, domain)
    REFERENCES tenant_credential_target_dispositions
      (tenant_id, credential_version_id, domain)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_credential_target_exec_target_shape CHECK (
    subject_generation > 0 AND target_execution_generation > 0
      AND scope='tenant-credential-target-execution-target-v1'
      AND domain='external_credential' AND source_disposition='executable_ref'
      AND credential_version_id REGEXP '^[0-9a-f]{64}$'
      AND target_disposition_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND CHAR_LENGTH(adapter_protocol)>0 AND CHAR_LENGTH(target_reference_key_id)>0
      AND target_reference_cipher_sha256 REGEXP '^[0-9a-f]{64}$'
      AND target_reference_sha256 REGEXP '^[0-9a-f]{64}$'
      AND operation_id_sha256 REGEXP '^[0-9a-f]{64}$'
      AND captured_at_db_ms >= 0 AND receipt_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT request_id, tenant_id, subject_generation, target_execution_generation, scope,
       target_ordinal, credential_version_id, domain, source_disposition,
       target_disposition_evidence_sha256, adapter_protocol,
       target_reference_cipher_sha256, target_reference_key_id,
       target_reference_sha256, operation_id_sha256, captured_at_db_ms, receipt_sha256
  FROM tenant_credential_target_execution_targets FORCE INDEX (
    PRIMARY, uk_credential_target_exec_target_identity,
    uk_credential_target_exec_target_ack_parent, uk_credential_target_exec_operation,
    uk_credential_target_exec_target_receipt, idx_credential_target_exec_target_owner
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_credential_target_execution_acks (
  request_id                          VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                           VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation                  BIGINT UNSIGNED NOT NULL,
  target_execution_generation         BIGINT UNSIGNED NOT NULL,
  scope                               VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_ordinal                      BIGINT UNSIGNED NOT NULL,
  credential_version_id               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  domain                              VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_receipt_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  operation_id_sha256                 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  adapter_protocol                    VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_reference_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  outcome                             VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  adapter_evidence_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  completed_claim_attempt             INT UNSIGNED NOT NULL,
  completed_claim_token_sha256        CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  store_db_timestamp_ms               BIGINT NOT NULL,
  receipt_sha256                      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (request_id, target_ordinal),
  UNIQUE KEY uk_credential_target_exec_ack_operation (operation_id_sha256),
  UNIQUE KEY uk_credential_target_exec_ack_receipt (receipt_sha256),
  UNIQUE KEY uk_credential_target_exec_ack_evidence (adapter_evidence_sha256),
  KEY idx_credential_target_exec_ack_owner
    (tenant_id, subject_generation, target_execution_generation, request_id, target_ordinal),
  CONSTRAINT fk_credential_target_exec_ack_target
    FOREIGN KEY (request_id, tenant_id, subject_generation, target_execution_generation,
                 target_ordinal, credential_version_id, domain, target_receipt_sha256,
                 operation_id_sha256, adapter_protocol, target_reference_sha256)
    REFERENCES tenant_credential_target_execution_targets
      (request_id, tenant_id, subject_generation, target_execution_generation,
       target_ordinal, credential_version_id, domain, receipt_sha256,
       operation_id_sha256, adapter_protocol, target_reference_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_credential_target_exec_ack_shape CHECK (
    subject_generation > 0 AND target_execution_generation > 0
      AND scope='tenant-credential-target-execution-target-ack-v1'
      AND domain='external_credential' AND outcome IN ('revoked','already_absent')
      AND credential_version_id REGEXP '^[0-9a-f]{64}$'
      AND target_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
      AND operation_id_sha256 REGEXP '^[0-9a-f]{64}$'
      AND target_reference_sha256 REGEXP '^[0-9a-f]{64}$'
      AND adapter_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND completed_claim_attempt > 0
      AND completed_claim_token_sha256 REGEXP '^[0-9a-f]{64}$'
      AND store_db_timestamp_ms >= 0 AND receipt_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT request_id, tenant_id, subject_generation, target_execution_generation, scope,
       target_ordinal, credential_version_id, domain, target_receipt_sha256,
       operation_id_sha256, adapter_protocol, target_reference_sha256, outcome,
       adapter_evidence_sha256, completed_claim_attempt, completed_claim_token_sha256,
       store_db_timestamp_ms, receipt_sha256
  FROM tenant_credential_target_execution_acks FORCE INDEX (
    PRIMARY, uk_credential_target_exec_ack_operation, uk_credential_target_exec_ack_receipt,
    uk_credential_target_exec_ack_evidence, idx_credential_target_exec_ack_owner
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_credential_target_execution_receipts (
  request_id                             VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                              VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation                     BIGINT UNSIGNED NOT NULL,
  target_execution_generation            BIGINT UNSIGNED NOT NULL,
  t3a_receipt_sha256                      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  inventory_receipt_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tracking_cutover_evidence_sha256        CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  version_count                          BIGINT UNSIGNED NOT NULL,
  version_root_sha256                     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_disposition_count               BIGINT UNSIGNED NOT NULL,
  target_disposition_root_sha256          CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  external_credential_target_count       BIGINT UNSIGNED NOT NULL,
  external_credential_target_root_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  external_credential_blocker_count      BIGINT UNSIGNED NOT NULL,
  kms_key_blocker_count                  BIGINT UNSIGNED NOT NULL,
  kms_key_executable_target_count        BIGINT UNSIGNED NOT NULL,
  source_evidence_db_ms                  BIGINT NOT NULL,
  scope                                  VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_count                           BIGINT UNSIGNED NOT NULL,
  target_root_sha256                     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_ack_count                       BIGINT UNSIGNED NOT NULL,
  target_ack_root_sha256                 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  adapter_evidence_count                 BIGINT UNSIGNED NOT NULL,
  adapter_evidence_root_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  external_credential_execution_complete BOOLEAN NOT NULL,
  kms_key_execution_complete             BOOLEAN NOT NULL,
  all_domains_complete                   BOOLEAN NOT NULL,
  content_purge_executed                 BOOLEAN NOT NULL,
  unresolved_blocker_count               BIGINT UNSIGNED NOT NULL,
  completed_claim_attempt                INT UNSIGNED NOT NULL,
  completed_claim_token_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  store_db_timestamp_ms                  BIGINT NOT NULL,
  receipt_sha256                         CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (request_id),
  UNIQUE KEY uk_credential_target_exec_receipt_owner (tenant_id, subject_generation),
  UNIQUE KEY uk_credential_target_exec_receipt_hash (receipt_sha256),
  CONSTRAINT fk_credential_target_exec_receipt_job
    FOREIGN KEY (request_id, tenant_id, subject_generation, target_execution_generation)
    REFERENCES tenant_credential_target_execution_jobs
      (request_id, tenant_id, subject_generation, target_execution_generation)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_credential_target_exec_receipt_shape CHECK (
    subject_generation > 0 AND target_execution_generation > 0
      AND target_disposition_count=version_count*2
      AND external_credential_target_count+external_credential_blocker_count<=version_count
      AND kms_key_blocker_count<=version_count AND kms_key_executable_target_count=0
      AND source_evidence_db_ms>=0
      AND scope='tenant-credential-target-execution-v1'
      AND target_count=external_credential_target_count
      AND target_ack_count=target_count AND adapter_evidence_count=target_count
      AND external_credential_blocker_count=0
      AND external_credential_execution_complete=TRUE
      AND kms_key_execution_complete=FALSE
      AND all_domains_complete=FALSE AND content_purge_executed=FALSE
      AND unresolved_blocker_count=kms_key_blocker_count
      AND completed_claim_attempt>0
      AND completed_claim_token_sha256 REGEXP '^[0-9a-f]{64}$'
      AND store_db_timestamp_ms>=source_evidence_db_ms
      AND receipt_sha256 REGEXP '^[0-9a-f]{64}$'
  ),
  CONSTRAINT chk_credential_target_exec_receipt_digests CHECK (
    t3a_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
      AND inventory_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
      AND tracking_cutover_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND version_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND target_disposition_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND external_credential_target_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND target_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND target_ack_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND adapter_evidence_root_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT request_id, tenant_id, subject_generation, target_execution_generation,
       t3a_receipt_sha256, inventory_receipt_sha256, tracking_cutover_evidence_sha256,
       version_count, version_root_sha256, target_disposition_count,
       target_disposition_root_sha256, external_credential_target_count,
       external_credential_target_root_sha256, external_credential_blocker_count,
       kms_key_blocker_count, kms_key_executable_target_count, source_evidence_db_ms,
       scope, target_count, target_root_sha256, target_ack_count, target_ack_root_sha256,
       adapter_evidence_count, adapter_evidence_root_sha256,
       external_credential_execution_complete, kms_key_execution_complete,
       all_domains_complete, content_purge_executed, unresolved_blocker_count,
       completed_claim_attempt, completed_claim_token_sha256,
       store_db_timestamp_ms, receipt_sha256
  FROM tenant_credential_target_execution_receipts FORCE INDEX (
    PRIMARY, uk_credential_target_exec_receipt_owner,
    uk_credential_target_exec_receipt_hash
  ) WHERE 1=0;

-- CREATE TABLE IF NOT EXISTS and FORCE INDEX only prove that selected names exist. Bind the exact
-- migration-owned table shape so marker-loss replay cannot bless a weaker engine, collation, column,
-- index, CHECK, foreign-key graph, extra object, or partition layout.
SET @credential_target_exec_previous_group_concat_max_len = @@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len = 1048576;
SET @credential_target_exec_schema_ok = (
  (SELECT COUNT(*) = 5
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,table_type,
             IFNULL(engine,'-'),IFNULL(table_collation,'-'))
           ORDER BY table_name SEPARATOR '|'),256)
         = '8486074105a6d95b37379f914fd5f9cd6db56c41d2d579c570fceddaeef7ad92'
     FROM information_schema.tables
    WHERE table_schema=DATABASE() AND table_name IN (
      'tenant_credential_target_execution_cutover',
      'tenant_credential_target_execution_jobs',
      'tenant_credential_target_execution_targets',
      'tenant_credential_target_execution_acks',
      'tenant_credential_target_execution_receipts'))
  AND
  (SELECT COUNT(*) = 115
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,LPAD(ordinal_position,3,'0'),
             column_name,LOWER(column_type),is_nullable,
             IF(column_default IS NULL,'<NULL>',CONCAT('<',column_default,'>')),
             IFNULL(character_set_name,'-'),IFNULL(collation_name,'-'),
             IFNULL(NULLIF(LOWER(extra),''),'-'),
             IFNULL(NULLIF(LOWER(generation_expression),''),'-'))
           ORDER BY table_name,ordinal_position SEPARATOR '|'),256)
         = '1b6944bb7c69723d1c0f78f178dade93bb64f67ed3762a02ae9cd06b46da8aba'
     FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name IN (
      'tenant_credential_target_execution_cutover',
      'tenant_credential_target_execution_jobs',
      'tenant_credential_target_execution_targets',
      'tenant_credential_target_execution_acks',
      'tenant_credential_target_execution_receipts'))
  AND
  (SELECT COUNT(DISTINCT CONCAT(table_name,'~',index_name)) = 24 AND COUNT(*) = 74
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,index_name,non_unique,
             seq_in_index,LOWER(index_type),LOWER(is_visible),
             IFNULL(column_name,'<expression>'),IFNULL(CAST(sub_part AS CHAR),'-'),
             LOWER(IFNULL(collation,'-')),IFNULL(expression,'-'))
           ORDER BY table_name,index_name,seq_in_index SEPARATOR '|'),256)
         = '0e5c1be5b8d078109eebb105d1d9fbca351cc1996813de58cbc190e92a7f8f06'
     FROM information_schema.statistics
    WHERE table_schema=DATABASE() AND table_name IN (
      'tenant_credential_target_execution_cutover',
      'tenant_credential_target_execution_jobs',
      'tenant_credential_target_execution_targets',
      'tenant_credential_target_execution_acks',
      'tenant_credential_target_execution_receipts'))
  AND
  (SELECT COUNT(*) = 10
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',tc.table_name,tc.constraint_name,tc.enforced,
             LOWER(REPLACE(REPLACE(REGEXP_REPLACE(cc.check_clause,'[[:space:]]',''),
               CHAR(96),''),'_utf8mb4','')))
           ORDER BY tc.table_name,tc.constraint_name SEPARATOR '|'),256)
         = '9668044e8d241a609a963d27facc025a6b8609a408af18e2ffe5e2a1f1e4ef47'
     FROM information_schema.table_constraints tc
     JOIN information_schema.check_constraints cc
       ON cc.constraint_schema=tc.constraint_schema
      AND cc.constraint_name=tc.constraint_name
    WHERE tc.table_schema=DATABASE() AND tc.constraint_type='CHECK'
      AND tc.table_name IN (
        'tenant_credential_target_execution_cutover',
        'tenant_credential_target_execution_jobs',
        'tenant_credential_target_execution_targets',
        'tenant_credential_target_execution_acks',
        'tenant_credential_target_execution_receipts'))
  AND
  (SELECT COUNT(*) = 32
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,
             constraint_type,enforced)
           ORDER BY table_name,constraint_name SEPARATOR '|'),256)
         = '29603d4f316e5d97ebf9726f6c1e9fd94886a513e29653e85062422cbf555cc5'
     FROM information_schema.table_constraints
    WHERE table_schema=DATABASE() AND table_name IN (
      'tenant_credential_target_execution_cutover',
      'tenant_credential_target_execution_jobs',
      'tenant_credential_target_execution_targets',
      'tenant_credential_target_execution_acks',
      'tenant_credential_target_execution_receipts'))
  AND
  (SELECT COUNT(DISTINCT CONCAT(k.table_name,'~',k.constraint_name)) = 5
       AND COUNT(*) = 26
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',k.table_name,k.constraint_name,
             k.ordinal_position,k.column_name,k.referenced_table_name,
             k.referenced_column_name,r.update_rule,r.delete_rule)
           ORDER BY k.table_name,k.constraint_name,k.ordinal_position SEPARATOR '|'),256)
         = 'f256fed39fbbb5960400284723682a14051a8f0f7ee74d85403eb0596c82c804'
     FROM information_schema.key_column_usage k
     JOIN information_schema.referential_constraints r
       ON r.constraint_schema=k.constraint_schema
      AND r.constraint_name=k.constraint_name
    WHERE k.table_schema=DATABASE() AND k.referenced_table_name IS NOT NULL
      AND k.table_name IN (
        'tenant_credential_target_execution_cutover',
        'tenant_credential_target_execution_jobs',
        'tenant_credential_target_execution_targets',
        'tenant_credential_target_execution_acks',
        'tenant_credential_target_execution_receipts'))
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.partitions
     WHERE table_schema=DATABASE() AND partition_name IS NOT NULL
       AND table_name IN (
         'tenant_credential_target_execution_cutover',
         'tenant_credential_target_execution_jobs',
         'tenant_credential_target_execution_targets',
         'tenant_credential_target_execution_acks',
         'tenant_credential_target_execution_receipts'))
);
SET @migration_sql = IF(@credential_target_exec_schema_ok=1,'SELECT 1',
  'SELECT 1 FROM __invalid_credential_target_execution_schema__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- Append-only ledgers and write-once cutover. Runtime transactions still perform exact source,
-- operation and claim revalidation; these guards prevent older or generic writers from rewriting
-- evidence. Trigger names intentionally use a prefix disjoint from 0026's owned inventory.
DROP TRIGGER IF EXISTS trg_target_exec_cutover_bi;
CREATE TRIGGER trg_target_exec_cutover_bi BEFORE INSERT ON tenant_credential_target_execution_cutover FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential target execution cutover already exists';
DROP TRIGGER IF EXISTS trg_target_exec_cutover_bd;
CREATE TRIGGER trg_target_exec_cutover_bd BEFORE DELETE ON tenant_credential_target_execution_cutover FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential target execution cutover cannot be deleted';
DROP TRIGGER IF EXISTS trg_target_exec_cutover_bu;
CREATE TRIGGER trg_target_exec_cutover_bu BEFORE UPDATE ON tenant_credential_target_execution_cutover FOR EACH ROW BEGIN IF NOT (OLD.singleton_id=1 AND NEW.singleton_id=1 AND OLD.control_generation=0 AND NEW.control_generation=1 AND OLD.activated_at_db_ms IS NULL AND NEW.activated_at_db_ms IS NOT NULL AND NEW.first_request_id IS NOT NULL AND NEW.first_receipt_sha256 IS NOT NULL AND NEW.execution_protocol='tenant-credential-target-execution-v1' AND NEW.external_credential_execution_enabled=TRUE AND NEW.kms_key_execution_enabled=FALSE AND NEW.evidence_sha256 IS NOT NULL AND EXISTS (SELECT 1 FROM tenant_credential_target_execution_receipts r WHERE BINARY r.request_id=BINARY NEW.first_request_id AND BINARY r.receipt_sha256=BINARY NEW.first_receipt_sha256 AND r.external_credential_execution_complete=TRUE AND r.kms_key_execution_complete=FALSE)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential target execution cutover transition is not permitted'; END IF; END;

DROP TRIGGER IF EXISTS trg_target_exec_targets_bu;
CREATE TRIGGER trg_target_exec_targets_bu BEFORE UPDATE ON tenant_credential_target_execution_targets FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential target execution target is immutable';
DROP TRIGGER IF EXISTS trg_target_exec_targets_bd;
CREATE TRIGGER trg_target_exec_targets_bd BEFORE DELETE ON tenant_credential_target_execution_targets FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential target execution target is append-only';
DROP TRIGGER IF EXISTS trg_target_exec_acks_bu;
CREATE TRIGGER trg_target_exec_acks_bu BEFORE UPDATE ON tenant_credential_target_execution_acks FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential target execution ACK is immutable';
DROP TRIGGER IF EXISTS trg_target_exec_acks_bd;
CREATE TRIGGER trg_target_exec_acks_bd BEFORE DELETE ON tenant_credential_target_execution_acks FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential target execution ACK is append-only';
DROP TRIGGER IF EXISTS trg_target_exec_receipts_bu;
CREATE TRIGGER trg_target_exec_receipts_bu BEFORE UPDATE ON tenant_credential_target_execution_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential target execution receipt is immutable';
DROP TRIGGER IF EXISTS trg_target_exec_receipts_bd;
CREATE TRIGGER trg_target_exec_receipts_bd BEFORE DELETE ON tenant_credential_target_execution_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential target execution receipt is append-only';

DROP TRIGGER IF EXISTS trg_target_exec_jobs_bd;
CREATE TRIGGER trg_target_exec_jobs_bd BEFORE DELETE ON tenant_credential_target_execution_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential target execution job is append-only';
DROP TRIGGER IF EXISTS trg_target_exec_jobs_bu;
CREATE TRIGGER trg_target_exec_jobs_bu BEFORE UPDATE ON tenant_credential_target_execution_jobs FOR EACH ROW BEGIN IF NOT (OLD.request_id<=>NEW.request_id AND OLD.tenant_id<=>NEW.tenant_id AND OLD.subject_generation<=>NEW.subject_generation AND OLD.target_execution_generation<=>NEW.target_execution_generation AND OLD.t3a_receipt_sha256<=>NEW.t3a_receipt_sha256 AND OLD.inventory_receipt_sha256<=>NEW.inventory_receipt_sha256 AND OLD.tracking_cutover_evidence_sha256<=>NEW.tracking_cutover_evidence_sha256 AND OLD.version_count<=>NEW.version_count AND OLD.version_root_sha256<=>NEW.version_root_sha256 AND OLD.target_disposition_count<=>NEW.target_disposition_count AND OLD.target_disposition_root_sha256<=>NEW.target_disposition_root_sha256 AND OLD.external_credential_target_count<=>NEW.external_credential_target_count AND OLD.external_credential_target_root_sha256<=>NEW.external_credential_target_root_sha256 AND OLD.external_credential_blocker_count<=>NEW.external_credential_blocker_count AND OLD.kms_key_blocker_count<=>NEW.kms_key_blocker_count AND OLD.kms_key_executable_target_count<=>NEW.kms_key_executable_target_count AND OLD.source_evidence_db_ms<=>NEW.source_evidence_db_ms AND OLD.target_count<=>NEW.target_count AND OLD.target_root_sha256<=>NEW.target_root_sha256 AND OLD.unresolved_blocker_count<=>NEW.unresolved_blocker_count AND OLD.created_at_ms<=>NEW.created_at_ms AND NEW.updated_at_ms>=OLD.updated_at_ms AND OLD.phase='queued' AND NEW.attempts>=OLD.attempts AND NEW.attempts<=OLD.attempts+1 AND ((NEW.target_ack_count=OLD.target_ack_count AND NEW.adapter_evidence_count=OLD.adapter_evidence_count AND NEW.target_ack_root_sha256<=>OLD.target_ack_root_sha256 AND NEW.adapter_evidence_root_sha256<=>OLD.adapter_evidence_root_sha256) OR (NEW.phase='queued' AND NEW.attempts=OLD.attempts AND OLD.claim_token IS NOT NULL AND NEW.claim_token<=>OLD.claim_token AND NEW.target_ack_count=OLD.target_ack_count+1 AND NEW.adapter_evidence_count=OLD.adapter_evidence_count+1 AND NOT (NEW.target_ack_root_sha256<=>OLD.target_ack_root_sha256) AND NOT (NEW.adapter_evidence_root_sha256<=>OLD.adapter_evidence_root_sha256) AND EXISTS (SELECT 1 FROM tenant_credential_target_execution_acks a WHERE BINARY a.request_id=BINARY OLD.request_id AND BINARY a.tenant_id=BINARY OLD.tenant_id AND a.subject_generation=OLD.subject_generation AND a.target_execution_generation=OLD.target_execution_generation AND a.target_ordinal=OLD.target_ack_count AND a.completed_claim_attempt=OLD.attempts AND a.store_db_timestamp_ms<=NEW.updated_at_ms))) AND ((NEW.phase='queued' AND ((NEW.attempts=OLD.attempts+1 AND NEW.claim_token IS NOT NULL) OR (NEW.attempts=OLD.attempts AND OLD.claim_token IS NOT NULL AND ((NEW.claim_token<=>OLD.claim_token AND NEW.claim_token IS NOT NULL) OR (NEW.claim_token IS NULL AND NEW.last_error_code IS NOT NULL))))) OR (NEW.phase='external_credential_sealed' AND OLD.claim_token IS NOT NULL AND NEW.attempts=OLD.attempts AND NEW.claim_token IS NULL AND NEW.completed_claim_attempt=OLD.attempts AND EXISTS (SELECT 1 FROM tenant_credential_target_execution_receipts r WHERE BINARY r.request_id=BINARY OLD.request_id AND BINARY r.tenant_id=BINARY OLD.tenant_id AND r.subject_generation=OLD.subject_generation AND r.target_execution_generation=OLD.target_execution_generation AND BINARY r.receipt_sha256=BINARY NEW.terminal_receipt_sha256)) OR (NEW.phase='blocked' AND NEW.claim_token IS NULL AND ((OLD.claim_token IS NOT NULL AND NEW.attempts=OLD.attempts) OR (NEW.blocked_reason_code='integrity_conflict' AND NEW.attempts=OLD.attempts+1))))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credential target execution job update is not permitted'; END IF; END;

-- Exact owned-trigger inventory: marker-loss replay repairs missing bodies above, while an unknown
-- same-prefix trigger is a privileged schema-tamper signal and fails closed.
SET @credential_target_exec_trigger_ok = (
  SELECT COUNT(*)=11 AND COUNT(DISTINCT trigger_name)=11
     AND SHA2(GROUP_CONCAT(CONCAT_WS('~',event_object_table,trigger_name,
           LPAD(action_order,3,'0'),action_timing,event_manipulation,action_orientation,
           IFNULL(action_condition,'<NULL>'),
           LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),
             CHAR(96),''),'_utf8mb4','')))
         ORDER BY event_object_table,trigger_name SEPARATOR '|'),256)
       = '01582e452a525282b8d4d51561c37f8ffa3222260a11847293ea5c66b44597d8'
    FROM information_schema.triggers
   WHERE trigger_schema=DATABASE()
     AND trigger_name LIKE 'trg\_target\_exec\_%'
);
SET @migration_sql = IF(@credential_target_exec_trigger_ok=1,'SELECT 1',
  'SELECT 1 FROM __invalid_credential_target_execution_trigger_inventory__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
SET SESSION group_concat_max_len = @credential_target_exec_previous_group_concat_max_len;
