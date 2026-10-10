-- Expand-only, default-dormant independent restore journal and replay substrate.
--
-- Applying this migration does not scan tenant erasure evidence, enqueue or claim work, contact
-- an external journal, append a remote record, activate either singleton, replay a fence, or
-- authorize any destructive operation. Runtime activation is forward-only. Once active, a T3a
-- terminal publication is accepted only when the exact tenant/request/generation has already
-- produced a complete independent-journal publication receipt. Activation itself rejects any
-- historical T3a receipt that lacks that proof; migration-time backfill is deliberately absent.

CREATE TABLE IF NOT EXISTS tenant_restore_journal_control (
  singleton_id                       TINYINT UNSIGNED NOT NULL,
  control_generation                 BIGINT UNSIGNED NOT NULL DEFAULT 0,
  activated_at_db_ms                 BIGINT NULL,
  protocol                           VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  adapter_protocol                   VARCHAR(128) COLLATE utf8mb4_0900_as_cs NULL,
  journal_namespace_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  logical_database_namespace_sha256  CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  target_count                       BIGINT UNSIGNED NOT NULL DEFAULT 0,
  target_root_sha256                 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  target_catalog_json                JSON NULL,
  evidence_sha256                    CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  PRIMARY KEY (singleton_id),
  CONSTRAINT chk_restore_journal_control_singleton CHECK (singleton_id=1),
  CONSTRAINT chk_restore_journal_control_state CHECK (
    (control_generation=0 AND activated_at_db_ms IS NULL AND protocol IS NULL
      AND adapter_protocol IS NULL AND journal_namespace_sha256 IS NULL
      AND logical_database_namespace_sha256 IS NULL AND target_count=0
      AND target_root_sha256 IS NULL AND target_catalog_json IS NULL
      AND evidence_sha256 IS NULL)
    OR
    (control_generation=1 AND activated_at_db_ms>=0
      AND protocol='tenant-restore-journal-v1'
      AND CHAR_LENGTH(adapter_protocol)>0 AND CHAR_LENGTH(adapter_protocol)<=128
      AND journal_namespace_sha256 REGEXP '^[0-9a-f]{64}$'
      AND logical_database_namespace_sha256 REGEXP '^[0-9a-f]{64}$'
      AND target_count BETWEEN 1 AND 32
      AND target_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND JSON_TYPE(target_catalog_json)='ARRAY'
      AND JSON_LENGTH(target_catalog_json)=target_count
      AND evidence_sha256 REGEXP '^[0-9a-f]{64}$')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT singleton_id,control_generation,activated_at_db_ms,protocol,adapter_protocol,
       journal_namespace_sha256,logical_database_namespace_sha256,target_count,
       target_root_sha256,target_catalog_json,evidence_sha256
  FROM tenant_restore_journal_control FORCE INDEX (PRIMARY) WHERE 1=0;

INSERT INTO tenant_restore_journal_control
  (singleton_id,control_generation,activated_at_db_ms,protocol,adapter_protocol,
   journal_namespace_sha256,logical_database_namespace_sha256,target_count,
   target_root_sha256,target_catalog_json,evidence_sha256)
SELECT 1,0,NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL
 WHERE NOT EXISTS (SELECT 1 FROM tenant_restore_journal_control WHERE singleton_id=1);

CREATE TABLE IF NOT EXISTS tenant_restore_journal_jobs (
  request_id                         VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                          VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation                 BIGINT UNSIGNED NOT NULL,
  publication_generation             BIGINT UNSIGNED NOT NULL,
  t1_fence_sha256                    CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  control_evidence_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  adapter_protocol                   VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  journal_namespace_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  logical_database_namespace_sha256  CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_count                       BIGINT UNSIGNED NOT NULL,
  target_root_sha256                 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_evidence_db_ms              BIGINT NOT NULL,
  phase                              VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_ack_count                   BIGINT UNSIGNED NOT NULL,
  target_ack_root_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  remote_commit_count                BIGINT UNSIGNED NOT NULL,
  remote_commit_root_sha256          CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  available_at_ms                  BIGINT NULL,
  attempts                         INT UNSIGNED NOT NULL DEFAULT 0,
  claim_token                      VARCHAR(128) COLLATE utf8mb4_0900_as_cs NULL,
  lease_until_ms                   BIGINT NULL,
  last_error_code                  VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL,
  created_at_ms                    BIGINT NOT NULL,
  updated_at_ms                    BIGINT NOT NULL,
  terminal_receipt_sha256          CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  sealed_at_db_ms                  BIGINT NULL,
  completed_claim_attempt          INT UNSIGNED NULL,
  completed_claim_token_sha256     CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  blocked_at_db_ms                 BIGINT NULL,
  blocked_reason_code              VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL,
  PRIMARY KEY (request_id),
  UNIQUE KEY uk_restore_journal_job_owner
    (request_id,tenant_id,subject_generation,publication_generation),
  UNIQUE KEY uk_restore_journal_job_tenant (tenant_id,subject_generation),
  KEY idx_restore_journal_job_claim (phase,available_at_ms,lease_until_ms,request_id),
  CONSTRAINT fk_restore_journal_job_admission FOREIGN KEY (request_id)
    REFERENCES tenant_erasure_admissions (request_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_restore_journal_job_fence FOREIGN KEY (tenant_id,subject_generation)
    REFERENCES tenant_credential_revocation_fences (tenant_id,subject_generation)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_restore_journal_job_source CHECK (
    subject_generation>0 AND publication_generation=1
      AND t1_fence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND control_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND CHAR_LENGTH(adapter_protocol)>0 AND CHAR_LENGTH(adapter_protocol)<=128
      AND journal_namespace_sha256 REGEXP '^[0-9a-f]{64}$'
      AND logical_database_namespace_sha256 REGEXP '^[0-9a-f]{64}$'
      AND target_count BETWEEN 1 AND 32
      AND target_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND source_evidence_db_ms>=0
  ),
  CONSTRAINT chk_restore_journal_job_counts CHECK (
    target_ack_count<=target_count AND remote_commit_count=target_ack_count
      AND target_ack_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND remote_commit_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND created_at_ms>=0 AND updated_at_ms>=created_at_ms
  ),
  CONSTRAINT chk_restore_journal_job_phase CHECK (
    (phase='queued' AND available_at_ms IS NOT NULL
      AND ((claim_token IS NULL AND lease_until_ms IS NULL
              AND available_at_ms>=updated_at_ms)
        OR (claim_token IS NOT NULL AND lease_until_ms IS NOT NULL
              AND lease_until_ms>=updated_at_ms AND attempts>0))
      AND (last_error_code IS NULL OR
        (claim_token IS NULL AND last_error_code IN ('temporary_failure','dependency_pending')))
      AND terminal_receipt_sha256 IS NULL AND sealed_at_db_ms IS NULL
      AND completed_claim_attempt IS NULL AND completed_claim_token_sha256 IS NULL
      AND blocked_at_db_ms IS NULL AND blocked_reason_code IS NULL)
    OR
    (phase='published' AND available_at_ms IS NULL AND claim_token IS NULL
      AND lease_until_ms IS NULL AND last_error_code IS NULL
      AND target_ack_count=target_count AND remote_commit_count=target_count
      AND terminal_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
      AND sealed_at_db_ms>=source_evidence_db_ms AND sealed_at_db_ms<=updated_at_ms
      AND completed_claim_attempt=attempts AND attempts>0
      AND completed_claim_token_sha256 REGEXP '^[0-9a-f]{64}$'
      AND blocked_at_db_ms IS NULL AND blocked_reason_code IS NULL)
    OR
    (phase='blocked' AND available_at_ms IS NULL AND claim_token IS NULL
      AND lease_until_ms IS NULL AND last_error_code IS NULL
      AND terminal_receipt_sha256 IS NULL AND sealed_at_db_ms IS NULL
      AND completed_claim_attempt IS NULL AND completed_claim_token_sha256 IS NULL
      AND blocked_at_db_ms>=source_evidence_db_ms AND blocked_at_db_ms<=updated_at_ms
      AND blocked_reason_code IN ('source_conflict','remote_conflict'))
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT request_id,tenant_id,subject_generation,publication_generation,
       t1_fence_sha256,control_evidence_sha256,adapter_protocol,journal_namespace_sha256,
       logical_database_namespace_sha256,target_count,target_root_sha256,source_evidence_db_ms,
       phase,target_ack_count,target_ack_root_sha256,remote_commit_count,
       remote_commit_root_sha256,available_at_ms,attempts,claim_token,lease_until_ms,
       last_error_code,created_at_ms,updated_at_ms,terminal_receipt_sha256,
       sealed_at_db_ms,completed_claim_attempt,completed_claim_token_sha256,
       blocked_at_db_ms,blocked_reason_code
  FROM tenant_restore_journal_jobs FORCE INDEX (
    PRIMARY,uk_restore_journal_job_owner,uk_restore_journal_job_tenant,
    idx_restore_journal_job_claim
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_restore_journal_targets (
  request_id                VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                 VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation        BIGINT UNSIGNED NOT NULL,
  publication_generation    BIGINT UNSIGNED NOT NULL,
  target_ordinal            BIGINT UNSIGNED NOT NULL,
  scope                     VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  failure_domain_sha256     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  adapter_protocol          VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  journal_namespace_sha256  CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  logical_database_namespace_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  t1_fence_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  operation_sha256          CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  record_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  captured_at_db_ms         BIGINT NOT NULL,
  receipt_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (request_id,target_ordinal),
  UNIQUE KEY uk_restore_journal_target_identity (request_id,target_sha256),
  UNIQUE KEY uk_restore_journal_target_receipt (receipt_sha256),
  UNIQUE KEY uk_restore_journal_target_ack_parent
    (request_id,target_ordinal,target_sha256,failure_domain_sha256,
     operation_sha256,record_sha256,receipt_sha256),
  KEY idx_restore_journal_target_owner
    (tenant_id,subject_generation,publication_generation,request_id,target_ordinal),
  CONSTRAINT fk_restore_journal_target_job FOREIGN KEY
    (request_id,tenant_id,subject_generation,publication_generation)
    REFERENCES tenant_restore_journal_jobs
      (request_id,tenant_id,subject_generation,publication_generation)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_restore_journal_target_shape CHECK (
    subject_generation>0 AND publication_generation=1
      AND scope='tenant-restore-journal-publication-target-v1'
      AND target_sha256 REGEXP '^[0-9a-f]{64}$'
      AND failure_domain_sha256 REGEXP '^[0-9a-f]{64}$'
      AND CHAR_LENGTH(adapter_protocol)>0 AND CHAR_LENGTH(adapter_protocol)<=128
      AND journal_namespace_sha256 REGEXP '^[0-9a-f]{64}$'
      AND logical_database_namespace_sha256 REGEXP '^[0-9a-f]{64}$'
      AND t1_fence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND operation_sha256 REGEXP '^[0-9a-f]{64}$'
      AND record_sha256 REGEXP '^[0-9a-f]{64}$'
      AND captured_at_db_ms>=0 AND receipt_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT request_id,tenant_id,subject_generation,publication_generation,target_ordinal,scope,
       target_sha256,failure_domain_sha256,adapter_protocol,journal_namespace_sha256,
       logical_database_namespace_sha256,t1_fence_sha256,operation_sha256,
       record_sha256,captured_at_db_ms,receipt_sha256
  FROM tenant_restore_journal_targets FORCE INDEX (
    PRIMARY,uk_restore_journal_target_identity,
    uk_restore_journal_target_receipt,uk_restore_journal_target_ack_parent,
    idx_restore_journal_target_owner
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_restore_journal_target_acks (
  request_id                 VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                  VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation         BIGINT UNSIGNED NOT NULL,
  publication_generation     BIGINT UNSIGNED NOT NULL,
  target_ordinal             BIGINT UNSIGNED NOT NULL,
  scope                      VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_sha256              CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  failure_domain_sha256      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  adapter_protocol           VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  journal_namespace_sha256   CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  logical_database_namespace_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_receipt_sha256      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  operation_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  record_sha256              CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  remote_sequence            BIGINT UNSIGNED NOT NULL,
  previous_head_root_sha256  CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  head_root_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  completed_claim_attempt    INT UNSIGNED NOT NULL,
  completed_claim_token_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  store_db_timestamp_ms      BIGINT NOT NULL,
  receipt_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (request_id,target_ordinal),
  UNIQUE KEY uk_restore_journal_ack_remote
    (target_sha256,journal_namespace_sha256,remote_sequence),
  UNIQUE KEY uk_restore_journal_ack_receipt (receipt_sha256),
  KEY idx_restore_journal_ack_owner
    (tenant_id,subject_generation,publication_generation,request_id,target_ordinal),
  CONSTRAINT fk_restore_journal_ack_target FOREIGN KEY
    (request_id,target_ordinal,target_sha256,failure_domain_sha256,
     operation_sha256,record_sha256,
     target_receipt_sha256)
    REFERENCES tenant_restore_journal_targets
      (request_id,target_ordinal,target_sha256,failure_domain_sha256,
       operation_sha256,record_sha256,receipt_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_restore_journal_ack_job FOREIGN KEY
    (request_id,tenant_id,subject_generation,publication_generation)
    REFERENCES tenant_restore_journal_jobs
      (request_id,tenant_id,subject_generation,publication_generation)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_restore_journal_ack_shape CHECK (
    subject_generation>0 AND publication_generation=1
      AND scope='tenant-restore-journal-publication-target-ack-v1'
      AND target_sha256 REGEXP '^[0-9a-f]{64}$'
      AND failure_domain_sha256 REGEXP '^[0-9a-f]{64}$'
      AND CHAR_LENGTH(adapter_protocol)>0 AND CHAR_LENGTH(adapter_protocol)<=128
      AND journal_namespace_sha256 REGEXP '^[0-9a-f]{64}$'
      AND logical_database_namespace_sha256 REGEXP '^[0-9a-f]{64}$'
      AND target_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
      AND operation_sha256 REGEXP '^[0-9a-f]{64}$'
      AND record_sha256 REGEXP '^[0-9a-f]{64}$'
      AND remote_sequence>0
      AND previous_head_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND head_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND completed_claim_attempt>0
      AND completed_claim_token_sha256 REGEXP '^[0-9a-f]{64}$'
      AND store_db_timestamp_ms>=0 AND receipt_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT request_id,tenant_id,subject_generation,publication_generation,target_ordinal,scope,
       target_sha256,failure_domain_sha256,adapter_protocol,journal_namespace_sha256,
       logical_database_namespace_sha256,target_receipt_sha256,operation_sha256,
       record_sha256,remote_sequence,previous_head_root_sha256,head_root_sha256,
       completed_claim_attempt,
       completed_claim_token_sha256,store_db_timestamp_ms,receipt_sha256
  FROM tenant_restore_journal_target_acks FORCE INDEX (
    PRIMARY,uk_restore_journal_ack_remote,uk_restore_journal_ack_receipt,
    idx_restore_journal_ack_owner
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_restore_journal_receipts (
  request_id                       VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                        VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation               BIGINT UNSIGNED NOT NULL,
  publication_generation           BIGINT UNSIGNED NOT NULL,
  t1_fence_sha256                  CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  control_evidence_sha256          CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  adapter_protocol                 VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  journal_namespace_sha256         CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  logical_database_namespace_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_count                     BIGINT UNSIGNED NOT NULL,
  target_root_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_evidence_db_ms            BIGINT NOT NULL,
  scope                            VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_ack_count                 BIGINT UNSIGNED NOT NULL,
  target_ack_root_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  remote_commit_count              BIGINT UNSIGNED NOT NULL,
  remote_commit_root_sha256        CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  restore_fence_publication_complete BOOLEAN NOT NULL,
  restore_fence_replay_complete    BOOLEAN NOT NULL,
  physical_replay_complete         BOOLEAN NOT NULL,
  all_domains_complete             BOOLEAN NOT NULL,
  content_purge_executed           BOOLEAN NOT NULL,
  completed_claim_attempt          INT UNSIGNED NOT NULL,
  completed_claim_token_sha256     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  store_db_timestamp_ms            BIGINT NOT NULL,
  receipt_sha256                   CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (request_id),
  UNIQUE KEY uk_restore_journal_receipt_owner (tenant_id,subject_generation),
  UNIQUE KEY uk_restore_journal_receipt_hash (receipt_sha256),
  CONSTRAINT fk_restore_journal_receipt_job FOREIGN KEY
    (request_id,tenant_id,subject_generation,publication_generation)
    REFERENCES tenant_restore_journal_jobs
      (request_id,tenant_id,subject_generation,publication_generation)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_restore_journal_receipt_shape CHECK (
    subject_generation>0 AND publication_generation=1
      AND t1_fence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND control_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND CHAR_LENGTH(adapter_protocol)>0 AND CHAR_LENGTH(adapter_protocol)<=128
      AND journal_namespace_sha256 REGEXP '^[0-9a-f]{64}$'
      AND logical_database_namespace_sha256 REGEXP '^[0-9a-f]{64}$'
      AND source_evidence_db_ms>=0
      AND scope='tenant-restore-journal-publication-v1'
      AND target_count>0 AND target_ack_count=target_count
      AND remote_commit_count=target_count
      AND target_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND target_ack_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND remote_commit_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND restore_fence_publication_complete=TRUE
      AND restore_fence_replay_complete=FALSE
      AND physical_replay_complete=FALSE
      AND all_domains_complete=FALSE AND content_purge_executed=FALSE
      AND completed_claim_attempt>0
      AND completed_claim_token_sha256 REGEXP '^[0-9a-f]{64}$'
      AND store_db_timestamp_ms>=source_evidence_db_ms
      AND receipt_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT request_id,tenant_id,subject_generation,publication_generation,
       t1_fence_sha256,control_evidence_sha256,adapter_protocol,journal_namespace_sha256,
       logical_database_namespace_sha256,target_count,target_root_sha256,source_evidence_db_ms,
       scope,target_ack_count,target_ack_root_sha256,remote_commit_count,
       remote_commit_root_sha256,restore_fence_publication_complete,
       restore_fence_replay_complete,physical_replay_complete,all_domains_complete,content_purge_executed,
       completed_claim_attempt,completed_claim_token_sha256,store_db_timestamp_ms,receipt_sha256
  FROM tenant_restore_journal_receipts FORCE INDEX (
    PRIMARY,uk_restore_journal_receipt_owner,uk_restore_journal_receipt_hash
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_restore_replay_runs (
  restore_run_id                       VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_backup_sha256                 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  runtime_epoch_sha256                 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  protocol                             VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  control_evidence_sha256              CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  adapter_protocol                     VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  journal_namespace_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  logical_database_namespace_sha256    CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_count                         BIGINT UNSIGNED NOT NULL,
  target_root_sha256                   CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  sealed_target_catalog_json           JSON NOT NULL,
  sealed_target_root_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  expected_entry_count                 BIGINT UNSIGNED NOT NULL,
  entry_count                          BIGINT UNSIGNED NOT NULL,
  entry_root_sha256                    CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  fence_count                          BIGINT UNSIGNED NOT NULL,
  fence_root_sha256                    CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  phase                                VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  created_at_db_ms                     BIGINT NOT NULL,
  updated_at_db_ms                     BIGINT NOT NULL,
  terminal_receipt_sha256              CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  sealed_at_db_ms                      BIGINT NULL,
  activated_at_db_ms                   BIGINT NULL,
  aborted_at_db_ms                     BIGINT NULL,
  PRIMARY KEY (restore_run_id),
  UNIQUE KEY uk_restore_replay_run_epoch
    (logical_database_namespace_sha256,runtime_epoch_sha256),
  KEY idx_restore_replay_run_phase (phase,created_at_db_ms,restore_run_id),
  CONSTRAINT chk_restore_replay_run_shape CHECK (
    source_backup_sha256 REGEXP '^[0-9a-f]{64}$'
      AND runtime_epoch_sha256 REGEXP '^[0-9a-f]{64}$'
      AND protocol='tenant-restore-journal-v1'
      AND control_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND CHAR_LENGTH(adapter_protocol)>0 AND CHAR_LENGTH(adapter_protocol)<=128
      AND journal_namespace_sha256 REGEXP '^[0-9a-f]{64}$'
      AND logical_database_namespace_sha256 REGEXP '^[0-9a-f]{64}$'
      AND target_count BETWEEN 1 AND 32
      AND target_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND JSON_TYPE(sealed_target_catalog_json)='ARRAY'
      AND JSON_LENGTH(sealed_target_catalog_json)=target_count
      AND sealed_target_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND entry_count<=expected_entry_count AND fence_count<=entry_count
      AND entry_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND fence_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND created_at_db_ms>=0 AND updated_at_db_ms>=created_at_db_ms
  ),
  CONSTRAINT chk_restore_replay_run_phase CHECK (
    (phase='prepared' AND terminal_receipt_sha256 IS NULL AND sealed_at_db_ms IS NULL
      AND activated_at_db_ms IS NULL AND aborted_at_db_ms IS NULL)
    OR
    (phase='replay_sealed' AND entry_count=expected_entry_count
      AND terminal_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
      AND sealed_at_db_ms>=created_at_db_ms AND sealed_at_db_ms<=updated_at_db_ms
      AND activated_at_db_ms IS NULL AND aborted_at_db_ms IS NULL)
    OR
    (phase='active' AND entry_count=expected_entry_count
      AND terminal_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
      AND sealed_at_db_ms>=created_at_db_ms AND activated_at_db_ms>=sealed_at_db_ms
      AND activated_at_db_ms<=updated_at_db_ms AND aborted_at_db_ms IS NULL)
    OR
    (phase='aborted' AND terminal_receipt_sha256 IS NULL AND sealed_at_db_ms IS NULL
      AND activated_at_db_ms IS NULL AND aborted_at_db_ms>=created_at_db_ms
      AND aborted_at_db_ms<=updated_at_db_ms)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT restore_run_id,source_backup_sha256,runtime_epoch_sha256,protocol,
       control_evidence_sha256,adapter_protocol,journal_namespace_sha256,
       logical_database_namespace_sha256,target_count,target_root_sha256,
       sealed_target_catalog_json,sealed_target_root_sha256,expected_entry_count,
       entry_count,entry_root_sha256,fence_count,fence_root_sha256,phase,
       created_at_db_ms,updated_at_db_ms,terminal_receipt_sha256,sealed_at_db_ms,
       activated_at_db_ms,aborted_at_db_ms
  FROM tenant_restore_replay_runs FORCE INDEX (
    PRIMARY,uk_restore_replay_run_epoch,idx_restore_replay_run_phase
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_restore_fences (
  tenant_id                          VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  scope                              VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  logical_database_namespace_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_id                         VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation                 BIGINT UNSIGNED NOT NULL,
  t1_fence_sha256                    CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  operation_sha256                   CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  record_sha256                      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  restore_run_id                     VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_target_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_remote_sequence             BIGINT UNSIGNED NOT NULL,
  source_head_root_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  installed_at_db_ms                 BIGINT NOT NULL,
  fence_sha256                       CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (tenant_id),
  UNIQUE KEY uk_restore_fence_request (request_id),
  UNIQUE KEY uk_restore_fence_generation (tenant_id,subject_generation),
  UNIQUE KEY uk_restore_fence_hash (fence_sha256),
  UNIQUE KEY uk_restore_fence_entry_parent
    (tenant_id,request_id,subject_generation,fence_sha256),
  KEY idx_restore_fence_run (restore_run_id,tenant_id),
  CONSTRAINT fk_restore_fence_run FOREIGN KEY (restore_run_id)
    REFERENCES tenant_restore_replay_runs (restore_run_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_restore_fence_shape CHECK (
    scope='tenant-restore-fence-v1'
      AND logical_database_namespace_sha256 REGEXP '^[0-9a-f]{64}$'
      AND subject_generation>0 AND t1_fence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND operation_sha256 REGEXP '^[0-9a-f]{64}$'
      AND record_sha256 REGEXP '^[0-9a-f]{64}$'
      AND source_target_sha256 REGEXP '^[0-9a-f]{64}$'
      AND source_remote_sequence>0
      AND source_head_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND installed_at_db_ms>=0 AND fence_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT tenant_id,scope,logical_database_namespace_sha256,request_id,subject_generation,
       t1_fence_sha256,operation_sha256,record_sha256,restore_run_id,
       source_target_sha256,source_remote_sequence,source_head_root_sha256,
       installed_at_db_ms,fence_sha256
  FROM tenant_restore_fences FORCE INDEX (
    PRIMARY,uk_restore_fence_request,uk_restore_fence_generation,
    uk_restore_fence_hash,uk_restore_fence_entry_parent,idx_restore_fence_run
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_restore_replay_entries (
  restore_run_id                       VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  replay_ordinal                       BIGINT UNSIGNED NOT NULL,
  scope                                VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_ordinal                       BIGINT UNSIGNED NOT NULL,
  target_sha256                       CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  remote_sequence                      BIGINT UNSIGNED NOT NULL,
  previous_head_root_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  head_root_sha256                     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  logical_database_namespace_sha256   CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_id                           VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                            VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation                   BIGINT UNSIGNED NOT NULL,
  t1_fence_sha256                      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  operation_sha256                     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  record_sha256                        CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  fence_disposition                    VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  fence_sha256                         CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  previous_entry_root_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  store_db_timestamp_ms                BIGINT NOT NULL,
  entry_sha256                         CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (restore_run_id,replay_ordinal),
  UNIQUE KEY uk_restore_replay_entry_remote
    (restore_run_id,target_sha256,remote_sequence),
  UNIQUE KEY uk_restore_replay_entry_hash (restore_run_id,entry_sha256),
  KEY idx_restore_replay_entry_owner
    (tenant_id,subject_generation,request_id,restore_run_id,replay_ordinal),
  CONSTRAINT fk_restore_replay_entry_run FOREIGN KEY (restore_run_id)
    REFERENCES tenant_restore_replay_runs (restore_run_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_restore_replay_entry_fence FOREIGN KEY
    (tenant_id,request_id,subject_generation,fence_sha256)
    REFERENCES tenant_restore_fences
      (tenant_id,request_id,subject_generation,fence_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_restore_replay_entry_shape CHECK (
    replay_ordinal>0 AND scope='tenant-restore-replay-entry-v1'
      AND target_sha256 REGEXP '^[0-9a-f]{64}$' AND remote_sequence>0
      AND previous_head_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND head_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND logical_database_namespace_sha256 REGEXP '^[0-9a-f]{64}$'
      AND subject_generation>0 AND t1_fence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND operation_sha256 REGEXP '^[0-9a-f]{64}$'
      AND record_sha256 REGEXP '^[0-9a-f]{64}$'
      AND fence_disposition IN ('installed','exact_replay')
      AND fence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND previous_entry_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND store_db_timestamp_ms>=0 AND entry_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT restore_run_id,replay_ordinal,scope,target_ordinal,target_sha256,remote_sequence,
       previous_head_root_sha256,head_root_sha256,logical_database_namespace_sha256,
       request_id,tenant_id,subject_generation,t1_fence_sha256,operation_sha256,
       record_sha256,fence_disposition,fence_sha256,previous_entry_root_sha256,
       store_db_timestamp_ms,entry_sha256
  FROM tenant_restore_replay_entries FORCE INDEX (
    PRIMARY,uk_restore_replay_entry_remote,uk_restore_replay_entry_hash,
    idx_restore_replay_entry_owner
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_restore_runtime_control (
  singleton_id                       TINYINT UNSIGNED NOT NULL,
  state                              VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  control_generation                 BIGINT UNSIGNED NOT NULL DEFAULT 0,
  update_kind                        VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL,
  lineage_kind                       VARCHAR(16) COLLATE utf8mb4_0900_as_cs NULL,
  activated_at_db_ms                 BIGINT NULL,
  updated_at_db_ms                   BIGINT NULL,
  restore_run_id                     VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  replay_receipt_sha256              CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  runtime_epoch_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  control_evidence_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  logical_database_namespace_sha256  CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  target_count                       BIGINT UNSIGNED NOT NULL DEFAULT 0,
  target_root_sha256                 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  verified_head_root_sha256          CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  previous_control_evidence_sha256   CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  evidence_sha256                    CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  PRIMARY KEY (singleton_id),
  KEY idx_restore_runtime_run (restore_run_id),
  CONSTRAINT fk_restore_runtime_run FOREIGN KEY (restore_run_id)
    REFERENCES tenant_restore_replay_runs (restore_run_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_restore_runtime_singleton CHECK (singleton_id=1),
  CONSTRAINT chk_restore_runtime_state CHECK (
    (state='inactive' AND control_generation=0 AND update_kind IS NULL
      AND lineage_kind IS NULL
      AND activated_at_db_ms IS NULL AND updated_at_db_ms IS NULL AND restore_run_id IS NULL
      AND replay_receipt_sha256 IS NULL AND runtime_epoch_sha256 IS NULL
      AND control_evidence_sha256 IS NULL
      AND logical_database_namespace_sha256 IS NULL
      AND target_count=0 AND target_root_sha256 IS NULL
      AND verified_head_root_sha256 IS NULL
      AND previous_control_evidence_sha256 IS NULL AND evidence_sha256 IS NULL)
    OR
    (state='active' AND control_generation>0
      AND update_kind IN ('primary_activation','restore_activation','journal_head_advance')
      AND ((lineage_kind='primary' AND restore_run_id IS NULL
              AND replay_receipt_sha256 IS NULL
              AND update_kind IN ('primary_activation','journal_head_advance'))
        OR (lineage_kind='restore' AND restore_run_id IS NOT NULL
              AND replay_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
              AND update_kind IN ('restore_activation','journal_head_advance')))
      AND activated_at_db_ms>=0 AND updated_at_db_ms>=activated_at_db_ms
      AND runtime_epoch_sha256 REGEXP '^[0-9a-f]{64}$'
      AND control_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND logical_database_namespace_sha256 REGEXP '^[0-9a-f]{64}$'
      AND target_count BETWEEN 1 AND 32
      AND target_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND verified_head_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND previous_control_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND evidence_sha256 REGEXP '^[0-9a-f]{64}$')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT singleton_id,state,control_generation,update_kind,lineage_kind,
       activated_at_db_ms,updated_at_db_ms,
       restore_run_id,
       replay_receipt_sha256,runtime_epoch_sha256,control_evidence_sha256,
       logical_database_namespace_sha256,target_count,target_root_sha256,
       verified_head_root_sha256,previous_control_evidence_sha256,evidence_sha256
  FROM tenant_restore_runtime_control FORCE INDEX (PRIMARY,idx_restore_runtime_run) WHERE 1=0;

INSERT INTO tenant_restore_runtime_control
  (singleton_id,state,control_generation,update_kind,lineage_kind,
   activated_at_db_ms,updated_at_db_ms,
   restore_run_id,
   replay_receipt_sha256,runtime_epoch_sha256,control_evidence_sha256,
   logical_database_namespace_sha256,target_count,target_root_sha256,
   verified_head_root_sha256,previous_control_evidence_sha256,evidence_sha256)
SELECT 1,'inactive',0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL
 WHERE NOT EXISTS (SELECT 1 FROM tenant_restore_runtime_control WHERE singleton_id=1);

-- Normalized per-target runtime checkpoints are the only durable startup cursor. A primary
-- activation inserts an all-empty catalog at generation 1. A restore activation replaces every
-- checkpoint with the sealed replay baseline at the next control generation. Normal catch-up
-- advances exactly one target and records the generation that authorized that checkpoint; older
-- untouched targets therefore retain their last checkpoint generation while sharing the active
-- runtime epoch. The store changes checkpoints and runtime_control in one transaction.
CREATE TABLE IF NOT EXISTS tenant_restore_runtime_heads (
  singleton_id                       TINYINT UNSIGNED NOT NULL,
  target_ordinal                     BIGINT UNSIGNED NOT NULL,
  target_sha256                      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  failure_domain_sha256              CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  adapter_protocol                   VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  journal_namespace_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  logical_database_namespace_sha256  CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  remote_sequence                    BIGINT UNSIGNED NOT NULL,
  head_root_sha256                   CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  checkpoint_control_generation      BIGINT UNSIGNED NOT NULL,
  runtime_epoch_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  updated_at_db_ms                   BIGINT NOT NULL,
  PRIMARY KEY (singleton_id,target_ordinal),
  UNIQUE KEY uk_restore_runtime_head_target (singleton_id,target_sha256),
  UNIQUE KEY uk_restore_runtime_head_identity
    (singleton_id,target_ordinal,target_sha256),
  KEY idx_restore_runtime_head_checkpoint
    (singleton_id,runtime_epoch_sha256,checkpoint_control_generation,target_ordinal),
  CONSTRAINT fk_restore_runtime_head_control FOREIGN KEY (singleton_id)
    REFERENCES tenant_restore_runtime_control (singleton_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_restore_runtime_head_shape CHECK (
    singleton_id=1 AND target_ordinal<32
      AND target_sha256 REGEXP '^[0-9a-f]{64}$'
      AND failure_domain_sha256 REGEXP '^[0-9a-f]{64}$'
      AND CHAR_LENGTH(adapter_protocol)>0 AND CHAR_LENGTH(adapter_protocol)<=128
      AND journal_namespace_sha256 REGEXP '^[0-9a-f]{64}$'
      AND logical_database_namespace_sha256 REGEXP '^[0-9a-f]{64}$'
      AND head_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND (remote_sequence>0 OR
        (remote_sequence=0 AND
          head_root_sha256='43d0d8350fb8afc557d4454447f3d630440769dc17b6a955454c563f0dbd3056'))
      AND checkpoint_control_generation>0
      AND runtime_epoch_sha256 REGEXP '^[0-9a-f]{64}$'
      AND updated_at_db_ms>=0
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT singleton_id,target_ordinal,target_sha256,failure_domain_sha256,
       adapter_protocol,journal_namespace_sha256,logical_database_namespace_sha256,
       remote_sequence,head_root_sha256,checkpoint_control_generation,
       runtime_epoch_sha256,updated_at_db_ms
  FROM tenant_restore_runtime_heads FORCE INDEX (
    PRIMARY,uk_restore_runtime_head_target,uk_restore_runtime_head_identity,
    idx_restore_runtime_head_checkpoint
  ) WHERE 1=0;

-- Every accepted post-baseline remote link is retained permanently. This is distinct from the
-- current-head projection: after links N and N+1 commit, an exact retry of N is proven against
-- this immutable row rather than guessed from sequence<=head. A conflicting old link therefore
-- fails closed even after the current head has moved on.
CREATE TABLE IF NOT EXISTS tenant_restore_runtime_known_entries (
  singleton_id                       TINYINT UNSIGNED NOT NULL,
  runtime_epoch_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_ordinal                     BIGINT UNSIGNED NOT NULL,
  target_sha256                      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  remote_sequence                    BIGINT UNSIGNED NOT NULL,
  previous_head_root_sha256          CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  head_root_sha256                   CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  record_scope                       VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  record_protocol                    VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  logical_database_namespace_sha256  CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_id                         VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                          VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation                 BIGINT UNSIGNED NOT NULL,
  t1_fence_sha256                    CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  operation_sha256                   CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  record_sha256                      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  control_generation                 BIGINT UNSIGNED NOT NULL,
  recorded_at_db_ms                  BIGINT NOT NULL,
  PRIMARY KEY (runtime_epoch_sha256,target_sha256,remote_sequence),
  UNIQUE KEY uk_restore_runtime_known_target_sequence
    (runtime_epoch_sha256,target_ordinal,remote_sequence),
  UNIQUE KEY uk_restore_runtime_known_generation (singleton_id,control_generation),
  KEY idx_restore_runtime_known_owner
    (tenant_id,subject_generation,request_id,runtime_epoch_sha256,target_ordinal,remote_sequence),
  CONSTRAINT fk_restore_runtime_known_head FOREIGN KEY
    (singleton_id,target_ordinal,target_sha256)
    REFERENCES tenant_restore_runtime_heads
      (singleton_id,target_ordinal,target_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_restore_runtime_known_shape CHECK (
    singleton_id=1 AND runtime_epoch_sha256 REGEXP '^[0-9a-f]{64}$'
      AND target_ordinal<32 AND target_sha256 REGEXP '^[0-9a-f]{64}$'
      AND remote_sequence>0
      AND previous_head_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND head_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND record_scope='tenant-restore-journal-record-v1'
      AND record_protocol='tenant-restore-journal-v1'
      AND logical_database_namespace_sha256 REGEXP '^[0-9a-f]{64}$'
      AND subject_generation>0 AND t1_fence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND operation_sha256 REGEXP '^[0-9a-f]{64}$'
      AND record_sha256 REGEXP '^[0-9a-f]{64}$'
      AND control_generation>1 AND recorded_at_db_ms>=0
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT singleton_id,runtime_epoch_sha256,target_ordinal,target_sha256,remote_sequence,
       previous_head_root_sha256,head_root_sha256,record_scope,record_protocol,
       logical_database_namespace_sha256,request_id,tenant_id,subject_generation,
       t1_fence_sha256,operation_sha256,record_sha256,control_generation,recorded_at_db_ms
  FROM tenant_restore_runtime_known_entries FORCE INDEX (
    PRIMARY,uk_restore_runtime_known_target_sequence,
    uk_restore_runtime_known_generation,idx_restore_runtime_known_owner
  ) WHERE 1=0;

-- The mutable singleton is backed by an immutable event chain. activation_epoch_sha256 is NULL
-- for head advances and unique for primary/restore activations, so an epoch from any prior
-- lineage (including the original primary epoch) can never be reused after a restore cutover.
CREATE TABLE IF NOT EXISTS tenant_restore_runtime_events (
  singleton_id                       TINYINT UNSIGNED NOT NULL,
  control_generation                 BIGINT UNSIGNED NOT NULL,
  update_kind                        VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  lineage_kind                       VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  activated_at_db_ms                 BIGINT NOT NULL,
  updated_at_db_ms                   BIGINT NOT NULL,
  restore_run_id                     VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  replay_receipt_sha256              CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  runtime_epoch_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  activation_epoch_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  control_evidence_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  logical_database_namespace_sha256  CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_count                       BIGINT UNSIGNED NOT NULL,
  target_root_sha256                 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  verified_head_root_sha256          CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  previous_control_evidence_sha256   CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  evidence_sha256                    CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (singleton_id,control_generation),
  UNIQUE KEY uk_restore_runtime_event_evidence (evidence_sha256),
  UNIQUE KEY uk_restore_runtime_event_epoch (activation_epoch_sha256),
  KEY idx_restore_runtime_event_run (restore_run_id,control_generation),
  CONSTRAINT fk_restore_runtime_event_control FOREIGN KEY (singleton_id)
    REFERENCES tenant_restore_runtime_control (singleton_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_restore_runtime_event_run FOREIGN KEY (restore_run_id)
    REFERENCES tenant_restore_replay_runs (restore_run_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_restore_runtime_event_shape CHECK (
    singleton_id=1 AND control_generation>0
      AND update_kind IN ('primary_activation','restore_activation','journal_head_advance')
      AND ((lineage_kind='primary' AND restore_run_id IS NULL
              AND replay_receipt_sha256 IS NULL
              AND update_kind IN ('primary_activation','journal_head_advance'))
        OR (lineage_kind='restore' AND restore_run_id IS NOT NULL
              AND replay_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
              AND update_kind IN ('restore_activation','journal_head_advance')))
      AND activated_at_db_ms>=0 AND updated_at_db_ms>=activated_at_db_ms
      AND runtime_epoch_sha256 REGEXP '^[0-9a-f]{64}$'
      AND ((update_kind IN ('primary_activation','restore_activation')
              AND activation_epoch_sha256=runtime_epoch_sha256)
        OR (update_kind='journal_head_advance' AND activation_epoch_sha256 IS NULL))
      AND control_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND logical_database_namespace_sha256 REGEXP '^[0-9a-f]{64}$'
      AND target_count BETWEEN 1 AND 32
      AND target_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND verified_head_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND previous_control_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND evidence_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT singleton_id,control_generation,update_kind,lineage_kind,
       activated_at_db_ms,updated_at_db_ms,restore_run_id,replay_receipt_sha256,
       runtime_epoch_sha256,activation_epoch_sha256,control_evidence_sha256,
       logical_database_namespace_sha256,target_count,target_root_sha256,
       verified_head_root_sha256,previous_control_evidence_sha256,evidence_sha256
  FROM tenant_restore_runtime_events FORCE INDEX (
    PRIMARY,uk_restore_runtime_event_evidence,uk_restore_runtime_event_epoch,
    idx_restore_runtime_event_run
  ) WHERE 1=0;

-- Exact table fingerprints are filled from a clean MySQL 8 application of this migration. They
-- intentionally bind engine/collation, every column/default, complete index shape, ENFORCED CHECK,
-- foreign-key graph, absence of extra constraints, and absence of partitioning.
SET @restore_journal_previous_group_concat_max_len=@@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len=1048576;
-- agent-service-runtime-fingerprint:tenant-restore-journal-schema:start
SET @restore_journal_schema_ok=(
  (SELECT COUNT(*)=12
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,table_type,
             IFNULL(engine,'-'),IFNULL(table_collation,'-'))
           ORDER BY table_name SEPARATOR '|'),256)=
         'e8ce847d19fd8a10d59f65646e1aee94d39e6f530776c9f9b8729703a2048bcd'
     FROM information_schema.tables
    WHERE table_schema=DATABASE() AND table_name IN (
      'tenant_restore_journal_control','tenant_restore_journal_jobs',
      'tenant_restore_journal_targets','tenant_restore_journal_target_acks',
      'tenant_restore_journal_receipts','tenant_restore_fences',
      'tenant_restore_replay_runs','tenant_restore_replay_entries',
      'tenant_restore_runtime_control','tenant_restore_runtime_heads',
      'tenant_restore_runtime_known_entries','tenant_restore_runtime_events'))
  AND
  (SELECT COUNT(*)=226
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,LPAD(ordinal_position,3,'0'),
             column_name,LOWER(column_type),is_nullable,
             IF(column_default IS NULL,'<NULL>',CONCAT('<',column_default,'>')),
             IFNULL(character_set_name,'-'),IFNULL(collation_name,'-'),
             IFNULL(NULLIF(LOWER(extra),''),'-'),
             IFNULL(NULLIF(LOWER(generation_expression),''),'-'))
           ORDER BY table_name,ordinal_position SEPARATOR '|'),256)=
         '376847f34340f9e492b2f00cdcec0fdf2a943256fc03db994f86b03bb0fb1b25'
     FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name IN (
      'tenant_restore_journal_control','tenant_restore_journal_jobs',
      'tenant_restore_journal_targets','tenant_restore_journal_target_acks',
      'tenant_restore_journal_receipts','tenant_restore_fences',
      'tenant_restore_replay_runs','tenant_restore_replay_entries',
      'tenant_restore_runtime_control','tenant_restore_runtime_heads',
      'tenant_restore_runtime_known_entries','tenant_restore_runtime_events'))
  AND
  (SELECT COUNT(DISTINCT CONCAT(table_name,'~',index_name))=50 AND COUNT(*)=132
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,index_name,non_unique,
             seq_in_index,LOWER(index_type),LOWER(is_visible),
             IFNULL(column_name,'<expression>'),IFNULL(CAST(sub_part AS CHAR),'-'),
             LOWER(IFNULL(collation,'-')),IFNULL(expression,'-'))
           ORDER BY table_name,index_name,seq_in_index SEPARATOR '|'),256)=
         '3ef931796554fdc2e6b5b39ac29a5e2b4347e0fc81e95cd96991cec80c853a81'
     FROM information_schema.statistics
    WHERE table_schema=DATABASE() AND table_name IN (
      'tenant_restore_journal_control','tenant_restore_journal_jobs',
      'tenant_restore_journal_targets','tenant_restore_journal_target_acks',
      'tenant_restore_journal_receipts','tenant_restore_fences',
      'tenant_restore_replay_runs','tenant_restore_replay_entries',
      'tenant_restore_runtime_control','tenant_restore_runtime_heads',
      'tenant_restore_runtime_known_entries','tenant_restore_runtime_events'))
  AND
  (SELECT COUNT(*)=17
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',tc.table_name,tc.constraint_name,tc.enforced,
             LOWER(REPLACE(REPLACE(REGEXP_REPLACE(cc.check_clause,'[[:space:]]',''),
               CHAR(96),''),'_utf8mb4','')))
           ORDER BY tc.table_name,tc.constraint_name SEPARATOR '|'),256)=
         '0f601a8245cd954aa2b8d84fd4de834386094daf1a1dae979b2d357496a350e5'
     FROM information_schema.table_constraints tc
     JOIN information_schema.check_constraints cc
       ON cc.constraint_schema=tc.constraint_schema
      AND cc.constraint_name=tc.constraint_name
    WHERE tc.table_schema=DATABASE() AND tc.constraint_type='CHECK'
      AND tc.table_name IN (
        'tenant_restore_journal_control','tenant_restore_journal_jobs',
        'tenant_restore_journal_targets','tenant_restore_journal_target_acks',
        'tenant_restore_journal_receipts','tenant_restore_fences',
        'tenant_restore_replay_runs','tenant_restore_replay_entries',
        'tenant_restore_runtime_control','tenant_restore_runtime_heads',
        'tenant_restore_runtime_known_entries','tenant_restore_runtime_events'))
  AND
  (SELECT COUNT(*)=65
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,constraint_type,enforced)
           ORDER BY table_name,constraint_name SEPARATOR '|'),256)=
         '39be53389e06a185549487a3cddb5f864a4eec28dbd37288a1e2412f6c137118'
     FROM information_schema.table_constraints
    WHERE table_schema=DATABASE() AND table_name IN (
      'tenant_restore_journal_control','tenant_restore_journal_jobs',
      'tenant_restore_journal_targets','tenant_restore_journal_target_acks',
      'tenant_restore_journal_receipts','tenant_restore_fences',
      'tenant_restore_replay_runs','tenant_restore_replay_entries',
      'tenant_restore_runtime_control','tenant_restore_runtime_heads',
      'tenant_restore_runtime_known_entries','tenant_restore_runtime_events'))
  AND
  (SELECT COUNT(DISTINCT CONCAT(k.table_name,'~',k.constraint_name))=14
       AND COUNT(*)=35
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',k.table_name,k.constraint_name,
             k.ordinal_position,k.column_name,k.referenced_table_name,
             k.referenced_column_name,r.update_rule,r.delete_rule)
           ORDER BY k.table_name,k.constraint_name,k.ordinal_position SEPARATOR '|'),256)=
         '1a2fb1fe6f1502c2a67b5bd2d7c5055e47772673c49aa457e8c9b836000d7033'
     FROM information_schema.key_column_usage k
     JOIN information_schema.referential_constraints r
       ON r.constraint_schema=k.constraint_schema
      AND r.constraint_name=k.constraint_name
    WHERE k.table_schema=DATABASE() AND k.referenced_table_name IS NOT NULL
      AND k.table_name IN (
        'tenant_restore_journal_control','tenant_restore_journal_jobs',
        'tenant_restore_journal_targets','tenant_restore_journal_target_acks',
        'tenant_restore_journal_receipts','tenant_restore_fences',
        'tenant_restore_replay_runs','tenant_restore_replay_entries',
        'tenant_restore_runtime_control','tenant_restore_runtime_heads',
        'tenant_restore_runtime_known_entries','tenant_restore_runtime_events'))
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.partitions
     WHERE table_schema=DATABASE() AND partition_name IS NOT NULL
       AND table_name IN (
        'tenant_restore_journal_control','tenant_restore_journal_jobs',
        'tenant_restore_journal_targets','tenant_restore_journal_target_acks',
        'tenant_restore_journal_receipts','tenant_restore_fences',
        'tenant_restore_replay_runs','tenant_restore_replay_entries',
        'tenant_restore_runtime_control','tenant_restore_runtime_heads',
        'tenant_restore_runtime_known_entries','tenant_restore_runtime_events'))
);
-- agent-service-runtime-fingerprint:tenant-restore-journal-schema:end
SET @migration_sql=IF(@restore_journal_schema_ok=1,'SELECT 1',
  'SELECT 1 FROM __invalid_tenant_restore_journal_schema__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- Evidence tables are append-only. Mutable queue/run projections only permit monotonic, narrowly
-- defined transitions. These guards are recreated on marker-loss replay; the final exact trigger
-- inventory rejects an unknown same-prefix trigger rather than silently blessing privileged DDL.
DROP TRIGGER IF EXISTS trg_restore_journal_control_bi;
CREATE TRIGGER trg_restore_journal_control_bi BEFORE INSERT ON tenant_restore_journal_control FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore journal control already exists';
DROP TRIGGER IF EXISTS trg_restore_journal_control_bd;
CREATE TRIGGER trg_restore_journal_control_bd BEFORE DELETE ON tenant_restore_journal_control FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore journal control cannot be deleted';
DROP TRIGGER IF EXISTS trg_restore_journal_control_bu;
CREATE TRIGGER trg_restore_journal_control_bu BEFORE UPDATE ON tenant_restore_journal_control FOR EACH ROW BEGIN IF NOT (OLD.singleton_id=1 AND NEW.singleton_id=1 AND OLD.control_generation=0 AND NEW.control_generation=1 AND OLD.activated_at_db_ms IS NULL AND NEW.activated_at_db_ms IS NOT NULL AND NEW.protocol='tenant-restore-journal-v1' AND NEW.adapter_protocol IS NOT NULL AND NEW.journal_namespace_sha256 IS NOT NULL AND NEW.logical_database_namespace_sha256 IS NOT NULL AND NEW.target_count BETWEEN 1 AND 32 AND NEW.target_root_sha256 IS NOT NULL AND NEW.target_catalog_json IS NOT NULL AND NEW.evidence_sha256 IS NOT NULL AND EXISTS (SELECT 1 FROM tenant_restore_runtime_control c WHERE c.singleton_id=1 AND c.state='active' AND c.control_generation=1 AND c.update_kind='primary_activation' AND c.lineage_kind='primary' AND c.restore_run_id IS NULL AND c.replay_receipt_sha256 IS NULL AND c.activated_at_db_ms=NEW.activated_at_db_ms AND c.updated_at_db_ms=NEW.activated_at_db_ms AND BINARY c.control_evidence_sha256=BINARY NEW.evidence_sha256 AND BINARY c.logical_database_namespace_sha256=BINARY NEW.logical_database_namespace_sha256 AND c.target_count=NEW.target_count AND BINARY c.target_root_sha256=BINARY NEW.target_root_sha256 AND (SELECT COUNT(*) FROM tenant_restore_runtime_heads h WHERE h.singleton_id=1)=NEW.target_count AND NOT EXISTS (SELECT 1 FROM tenant_restore_runtime_heads h WHERE h.singleton_id=1 AND (h.target_ordinal>=NEW.target_count OR h.checkpoint_control_generation<>1 OR BINARY h.runtime_epoch_sha256<>BINARY c.runtime_epoch_sha256 OR BINARY h.logical_database_namespace_sha256<>BINARY NEW.logical_database_namespace_sha256 OR h.remote_sequence<>0 OR BINARY h.head_root_sha256<>BINARY '43d0d8350fb8afc557d4454447f3d630440769dc17b6a955454c563f0dbd3056' OR NOT (CAST(JSON_UNQUOTE(JSON_EXTRACT(NEW.target_catalog_json,CONCAT('$[',h.target_ordinal,'].targetOrdinal'))) AS UNSIGNED)<=>h.target_ordinal) OR NOT (BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.target_catalog_json,CONCAT('$[',h.target_ordinal,'].targetSha256'))) <=> BINARY h.target_sha256) OR NOT (BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.target_catalog_json,CONCAT('$[',h.target_ordinal,'].failureDomainSha256'))) <=> BINARY h.failure_domain_sha256) OR NOT (BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.target_catalog_json,CONCAT('$[',h.target_ordinal,'].adapterProtocol'))) <=> BINARY h.adapter_protocol) OR NOT (BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.target_catalog_json,CONCAT('$[',h.target_ordinal,'].journalNamespaceSha256'))) <=> BINARY h.journal_namespace_sha256)))) AND NOT EXISTS (SELECT 1 FROM tenant_credential_revocation_receipts r WHERE NOT EXISTS (SELECT 1 FROM tenant_restore_journal_receipts j WHERE BINARY j.request_id=BINARY r.request_id AND BINARY j.tenant_id=BINARY r.tenant_id AND j.subject_generation=r.subject_generation AND BINARY j.t1_fence_sha256=BINARY r.t1_fence_sha256 AND j.restore_fence_publication_complete=TRUE AND j.restore_fence_replay_complete=FALSE AND j.physical_replay_complete=FALSE AND j.all_domains_complete=FALSE AND j.content_purge_executed=FALSE AND j.store_db_timestamp_ms<=r.store_db_timestamp_ms))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore journal activation is not permitted'; END IF; END;

DROP TRIGGER IF EXISTS trg_restore_journal_jobs_bi;
CREATE TRIGGER trg_restore_journal_jobs_bi BEFORE INSERT ON tenant_restore_journal_jobs FOR EACH ROW BEGIN IF NOT EXISTS (SELECT 1 FROM tenant_restore_journal_control c JOIN tenant_erasure_admissions a ON BINARY a.request_id=BINARY NEW.request_id AND BINARY a.tenant_id=BINARY NEW.tenant_id AND a.subject_generation=NEW.subject_generation JOIN tenant_credential_revocation_fences f ON BINARY f.request_id=BINARY NEW.request_id AND BINARY f.tenant_id=BINARY NEW.tenant_id AND f.subject_generation=NEW.subject_generation WHERE c.singleton_id=1 AND c.control_generation=1 AND NEW.publication_generation=1 AND BINARY c.adapter_protocol=BINARY NEW.adapter_protocol AND BINARY c.journal_namespace_sha256=BINARY NEW.journal_namespace_sha256 AND BINARY c.logical_database_namespace_sha256=BINARY NEW.logical_database_namespace_sha256 AND c.target_count=NEW.target_count AND BINARY c.target_root_sha256=BINARY NEW.target_root_sha256 AND BINARY c.evidence_sha256=BINARY NEW.control_evidence_sha256 AND BINARY f.evidence_sha256=BINARY NEW.t1_fence_sha256 AND NEW.source_evidence_db_ms>=GREATEST(a.gated_at_ms,f.fenced_at_ms)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore journal job is not active-source-bound'; END IF; END;
DROP TRIGGER IF EXISTS trg_restore_journal_jobs_bd;
CREATE TRIGGER trg_restore_journal_jobs_bd BEFORE DELETE ON tenant_restore_journal_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore journal job is append-only';
DROP TRIGGER IF EXISTS trg_restore_journal_jobs_bu;
CREATE TRIGGER trg_restore_journal_jobs_bu BEFORE UPDATE ON tenant_restore_journal_jobs FOR EACH ROW BEGIN IF NOT (OLD.request_id<=>NEW.request_id AND OLD.tenant_id<=>NEW.tenant_id AND OLD.subject_generation<=>NEW.subject_generation AND OLD.publication_generation<=>NEW.publication_generation AND OLD.t1_fence_sha256<=>NEW.t1_fence_sha256 AND OLD.control_evidence_sha256<=>NEW.control_evidence_sha256 AND OLD.adapter_protocol<=>NEW.adapter_protocol AND OLD.journal_namespace_sha256<=>NEW.journal_namespace_sha256 AND OLD.logical_database_namespace_sha256<=>NEW.logical_database_namespace_sha256 AND OLD.target_count<=>NEW.target_count AND OLD.target_root_sha256<=>NEW.target_root_sha256 AND OLD.source_evidence_db_ms<=>NEW.source_evidence_db_ms AND OLD.created_at_ms<=>NEW.created_at_ms AND OLD.phase='queued' AND NEW.attempts>=OLD.attempts AND NEW.attempts<=OLD.attempts+1 AND NEW.target_ack_count>=OLD.target_ack_count AND NEW.target_ack_count<=OLD.target_ack_count+1 AND NEW.remote_commit_count=NEW.target_ack_count AND NEW.updated_at_ms>=OLD.updated_at_ms AND ((NEW.target_ack_count=OLD.target_ack_count AND NEW.target_ack_root_sha256<=>OLD.target_ack_root_sha256 AND NEW.remote_commit_root_sha256<=>OLD.remote_commit_root_sha256) OR (NEW.phase='queued' AND NEW.attempts=OLD.attempts AND OLD.claim_token IS NOT NULL AND NEW.claim_token<=>OLD.claim_token AND NEW.target_ack_count=OLD.target_ack_count+1 AND NOT (NEW.target_ack_root_sha256<=>OLD.target_ack_root_sha256) AND NOT (NEW.remote_commit_root_sha256<=>OLD.remote_commit_root_sha256) AND EXISTS (SELECT 1 FROM tenant_restore_journal_target_acks a WHERE BINARY a.request_id=BINARY OLD.request_id AND BINARY a.tenant_id=BINARY OLD.tenant_id AND a.subject_generation=OLD.subject_generation AND a.publication_generation=OLD.publication_generation AND a.target_ordinal=OLD.target_ack_count AND a.completed_claim_attempt=OLD.attempts AND a.store_db_timestamp_ms<=NEW.updated_at_ms))) AND ((NEW.phase='queued' AND ((NEW.attempts=OLD.attempts+1 AND NEW.claim_token IS NOT NULL) OR (NEW.attempts=OLD.attempts AND OLD.claim_token IS NOT NULL AND ((NEW.claim_token<=>OLD.claim_token AND NEW.claim_token IS NOT NULL) OR (NEW.claim_token IS NULL AND NEW.last_error_code IS NOT NULL))))) OR (NEW.phase='published' AND OLD.claim_token IS NOT NULL AND NEW.attempts=OLD.attempts AND NEW.claim_token IS NULL AND NEW.target_ack_count=NEW.target_count AND NEW.completed_claim_attempt=OLD.attempts AND EXISTS (SELECT 1 FROM tenant_restore_journal_receipts r WHERE BINARY r.request_id=BINARY OLD.request_id AND BINARY r.tenant_id=BINARY OLD.tenant_id AND r.subject_generation=OLD.subject_generation AND r.publication_generation=OLD.publication_generation AND BINARY r.receipt_sha256=BINARY NEW.terminal_receipt_sha256 AND r.completed_claim_attempt=OLD.attempts AND BINARY r.completed_claim_token_sha256=BINARY NEW.completed_claim_token_sha256 AND r.store_db_timestamp_ms=NEW.sealed_at_db_ms)) OR (NEW.phase='blocked' AND NEW.claim_token IS NULL AND ((OLD.claim_token IS NOT NULL AND NEW.attempts=OLD.attempts) OR (NEW.blocked_reason_code='source_conflict' AND NEW.attempts=OLD.attempts+1))))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore journal job update is not permitted'; END IF; END;

DROP TRIGGER IF EXISTS trg_restore_journal_targets_bu;
CREATE TRIGGER trg_restore_journal_targets_bu BEFORE UPDATE ON tenant_restore_journal_targets FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore journal target is immutable';
DROP TRIGGER IF EXISTS trg_restore_journal_targets_bd;
CREATE TRIGGER trg_restore_journal_targets_bd BEFORE DELETE ON tenant_restore_journal_targets FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore journal target is append-only';
DROP TRIGGER IF EXISTS trg_restore_journal_targets_bi;
CREATE TRIGGER trg_restore_journal_targets_bi BEFORE INSERT ON tenant_restore_journal_targets FOR EACH ROW BEGIN IF NOT EXISTS (SELECT 1 FROM tenant_restore_journal_jobs j WHERE BINARY j.request_id=BINARY NEW.request_id AND BINARY j.tenant_id=BINARY NEW.tenant_id AND j.subject_generation=NEW.subject_generation AND j.publication_generation=NEW.publication_generation AND j.phase='queued' AND NEW.target_ordinal<j.target_count AND BINARY j.adapter_protocol=BINARY NEW.adapter_protocol AND BINARY j.journal_namespace_sha256=BINARY NEW.journal_namespace_sha256 AND BINARY j.logical_database_namespace_sha256=BINARY NEW.logical_database_namespace_sha256 AND BINARY j.t1_fence_sha256=BINARY NEW.t1_fence_sha256 AND NEW.captured_at_db_ms>=j.source_evidence_db_ms) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore journal target is not source-bound'; END IF; END;
DROP TRIGGER IF EXISTS trg_restore_journal_acks_bu;
CREATE TRIGGER trg_restore_journal_acks_bu BEFORE UPDATE ON tenant_restore_journal_target_acks FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore journal target ACK is immutable';
DROP TRIGGER IF EXISTS trg_restore_journal_acks_bd;
CREATE TRIGGER trg_restore_journal_acks_bd BEFORE DELETE ON tenant_restore_journal_target_acks FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore journal target ACK is append-only';
DROP TRIGGER IF EXISTS trg_restore_journal_acks_bi;
CREATE TRIGGER trg_restore_journal_acks_bi BEFORE INSERT ON tenant_restore_journal_target_acks FOR EACH ROW BEGIN IF NOT EXISTS (SELECT 1 FROM tenant_restore_journal_targets t JOIN tenant_restore_journal_jobs j ON BINARY j.request_id=BINARY t.request_id AND BINARY j.tenant_id=BINARY t.tenant_id AND j.subject_generation=t.subject_generation AND j.publication_generation=t.publication_generation WHERE BINARY t.request_id=BINARY NEW.request_id AND BINARY t.tenant_id=BINARY NEW.tenant_id AND t.subject_generation=NEW.subject_generation AND t.publication_generation=NEW.publication_generation AND t.target_ordinal=NEW.target_ordinal AND BINARY t.target_sha256=BINARY NEW.target_sha256 AND BINARY t.failure_domain_sha256=BINARY NEW.failure_domain_sha256 AND BINARY t.adapter_protocol=BINARY NEW.adapter_protocol AND BINARY t.journal_namespace_sha256=BINARY NEW.journal_namespace_sha256 AND BINARY t.logical_database_namespace_sha256=BINARY NEW.logical_database_namespace_sha256 AND BINARY t.operation_sha256=BINARY NEW.operation_sha256 AND BINARY t.record_sha256=BINARY NEW.record_sha256 AND BINARY t.receipt_sha256=BINARY NEW.target_receipt_sha256 AND j.phase='queued' AND j.claim_token IS NOT NULL AND j.attempts=NEW.completed_claim_attempt AND NEW.store_db_timestamp_ms>=t.captured_at_db_ms AND NEW.store_db_timestamp_ms<=j.lease_until_ms) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore journal target ACK is not claim-bound'; END IF; END;
DROP TRIGGER IF EXISTS trg_restore_journal_receipts_bu;
CREATE TRIGGER trg_restore_journal_receipts_bu BEFORE UPDATE ON tenant_restore_journal_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore journal receipt is immutable';
DROP TRIGGER IF EXISTS trg_restore_journal_receipts_bd;
CREATE TRIGGER trg_restore_journal_receipts_bd BEFORE DELETE ON tenant_restore_journal_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore journal receipt is append-only';
DROP TRIGGER IF EXISTS trg_restore_journal_receipts_bi;
CREATE TRIGGER trg_restore_journal_receipts_bi BEFORE INSERT ON tenant_restore_journal_receipts FOR EACH ROW BEGIN IF NOT EXISTS (SELECT 1 FROM tenant_restore_journal_jobs j WHERE BINARY j.request_id=BINARY NEW.request_id AND BINARY j.tenant_id=BINARY NEW.tenant_id AND j.subject_generation=NEW.subject_generation AND j.publication_generation=NEW.publication_generation AND j.phase='queued' AND j.claim_token IS NOT NULL AND j.attempts=NEW.completed_claim_attempt AND BINARY j.t1_fence_sha256=BINARY NEW.t1_fence_sha256 AND BINARY j.control_evidence_sha256=BINARY NEW.control_evidence_sha256 AND BINARY j.adapter_protocol=BINARY NEW.adapter_protocol AND BINARY j.journal_namespace_sha256=BINARY NEW.journal_namespace_sha256 AND BINARY j.logical_database_namespace_sha256=BINARY NEW.logical_database_namespace_sha256 AND j.target_count=NEW.target_count AND BINARY j.target_root_sha256=BINARY NEW.target_root_sha256 AND j.source_evidence_db_ms=NEW.source_evidence_db_ms AND j.target_ack_count=NEW.target_ack_count AND BINARY j.target_ack_root_sha256=BINARY NEW.target_ack_root_sha256 AND j.remote_commit_count=NEW.remote_commit_count AND BINARY j.remote_commit_root_sha256=BINARY NEW.remote_commit_root_sha256 AND NEW.store_db_timestamp_ms<=j.lease_until_ms) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore journal receipt is not claim-bound'; END IF; END;

DROP TRIGGER IF EXISTS trg_restore_journal_fences_bu;
CREATE TRIGGER trg_restore_journal_fences_bu BEFORE UPDATE ON tenant_restore_fences FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore fence is immutable';
DROP TRIGGER IF EXISTS trg_restore_journal_fences_bd;
CREATE TRIGGER trg_restore_journal_fences_bd BEFORE DELETE ON tenant_restore_fences FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore fence is permanent';
DROP TRIGGER IF EXISTS trg_restore_journal_fences_bi;
CREATE TRIGGER trg_restore_journal_fences_bi BEFORE INSERT ON tenant_restore_fences FOR EACH ROW BEGIN IF NOT EXISTS (SELECT 1 FROM tenant_restore_replay_runs r WHERE BINARY r.restore_run_id=BINARY NEW.restore_run_id AND r.phase='prepared' AND BINARY r.logical_database_namespace_sha256=BINARY NEW.logical_database_namespace_sha256 AND NEW.installed_at_db_ms>=r.created_at_db_ms) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore fence is not bound to a prepared replay'; END IF; END;

DROP TRIGGER IF EXISTS trg_restore_journal_runs_bd;
CREATE TRIGGER trg_restore_journal_runs_bd BEFORE DELETE ON tenant_restore_replay_runs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore replay run is append-only';
DROP TRIGGER IF EXISTS trg_restore_journal_runs_bi;
CREATE TRIGGER trg_restore_journal_runs_bi BEFORE INSERT ON tenant_restore_replay_runs FOR EACH ROW BEGIN IF NOT EXISTS (SELECT 1 FROM tenant_restore_journal_control c WHERE c.singleton_id=1 AND c.control_generation=1 AND NEW.phase='prepared' AND BINARY c.protocol=BINARY NEW.protocol AND BINARY c.evidence_sha256=BINARY NEW.control_evidence_sha256 AND BINARY c.adapter_protocol=BINARY NEW.adapter_protocol AND BINARY c.journal_namespace_sha256=BINARY NEW.journal_namespace_sha256 AND BINARY c.logical_database_namespace_sha256=BINARY NEW.logical_database_namespace_sha256 AND c.target_count=NEW.target_count AND BINARY c.target_root_sha256=BINARY NEW.target_root_sha256) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore replay run is not control-bound'; END IF; END;
DROP TRIGGER IF EXISTS trg_restore_journal_runs_bu;
CREATE TRIGGER trg_restore_journal_runs_bu BEFORE UPDATE ON tenant_restore_replay_runs FOR EACH ROW BEGIN IF NOT (OLD.restore_run_id<=>NEW.restore_run_id AND OLD.source_backup_sha256<=>NEW.source_backup_sha256 AND OLD.runtime_epoch_sha256<=>NEW.runtime_epoch_sha256 AND OLD.protocol<=>NEW.protocol AND OLD.control_evidence_sha256<=>NEW.control_evidence_sha256 AND OLD.adapter_protocol<=>NEW.adapter_protocol AND OLD.journal_namespace_sha256<=>NEW.journal_namespace_sha256 AND OLD.logical_database_namespace_sha256<=>NEW.logical_database_namespace_sha256 AND OLD.target_count<=>NEW.target_count AND OLD.target_root_sha256<=>NEW.target_root_sha256 AND OLD.sealed_target_catalog_json<=>NEW.sealed_target_catalog_json AND OLD.sealed_target_root_sha256<=>NEW.sealed_target_root_sha256 AND OLD.expected_entry_count<=>NEW.expected_entry_count AND OLD.created_at_db_ms<=>NEW.created_at_db_ms AND NEW.updated_at_db_ms>=OLD.updated_at_db_ms AND ((OLD.phase='prepared' AND NEW.phase='prepared' AND NEW.entry_count=OLD.entry_count+1 AND NEW.fence_count BETWEEN OLD.fence_count AND OLD.fence_count+1 AND NOT (NEW.entry_root_sha256<=>OLD.entry_root_sha256) AND ((NEW.fence_count=OLD.fence_count AND NEW.fence_root_sha256<=>OLD.fence_root_sha256) OR (NEW.fence_count=OLD.fence_count+1 AND NOT (NEW.fence_root_sha256<=>OLD.fence_root_sha256))) AND EXISTS (SELECT 1 FROM tenant_restore_replay_entries e WHERE BINARY e.restore_run_id=BINARY OLD.restore_run_id AND e.replay_ordinal=NEW.entry_count AND BINARY e.previous_entry_root_sha256=BINARY OLD.entry_root_sha256 AND BINARY e.entry_sha256<>BINARY OLD.entry_root_sha256)) OR (OLD.phase='prepared' AND NEW.phase='replay_sealed' AND NEW.entry_count=OLD.entry_count AND NEW.entry_root_sha256<=>OLD.entry_root_sha256 AND NEW.fence_count=OLD.fence_count AND NEW.fence_root_sha256<=>OLD.fence_root_sha256 AND NEW.entry_count=NEW.expected_entry_count AND NEW.terminal_receipt_sha256 IS NOT NULL AND NEW.sealed_at_db_ms IS NOT NULL) OR (OLD.phase='prepared' AND NEW.phase='aborted' AND NEW.entry_count=OLD.entry_count AND NEW.entry_root_sha256<=>OLD.entry_root_sha256 AND NEW.fence_count=OLD.fence_count AND NEW.fence_root_sha256<=>OLD.fence_root_sha256 AND NEW.aborted_at_db_ms IS NOT NULL) OR (OLD.phase='replay_sealed' AND NEW.phase='active' AND NEW.entry_count=OLD.entry_count AND NEW.entry_root_sha256<=>OLD.entry_root_sha256 AND NEW.fence_count=OLD.fence_count AND NEW.fence_root_sha256<=>OLD.fence_root_sha256 AND NEW.terminal_receipt_sha256<=>OLD.terminal_receipt_sha256 AND NEW.sealed_at_db_ms<=>OLD.sealed_at_db_ms AND EXISTS (SELECT 1 FROM tenant_restore_runtime_control c WHERE c.singleton_id=1 AND c.state='active' AND c.control_generation>1 AND c.update_kind='restore_activation' AND c.lineage_kind='restore' AND BINARY c.restore_run_id=BINARY OLD.restore_run_id AND BINARY c.replay_receipt_sha256=BINARY OLD.terminal_receipt_sha256 AND c.activated_at_db_ms=NEW.activated_at_db_ms)))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore replay run update is not permitted'; END IF; END;
DROP TRIGGER IF EXISTS trg_restore_journal_entries_bd;
CREATE TRIGGER trg_restore_journal_entries_bd BEFORE DELETE ON tenant_restore_replay_entries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore replay entry is append-only';
DROP TRIGGER IF EXISTS trg_restore_journal_entries_bu;
CREATE TRIGGER trg_restore_journal_entries_bu BEFORE UPDATE ON tenant_restore_replay_entries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore replay entry is immutable';
DROP TRIGGER IF EXISTS trg_restore_journal_entries_bi;
CREATE TRIGGER trg_restore_journal_entries_bi BEFORE INSERT ON tenant_restore_replay_entries FOR EACH ROW BEGIN IF NOT EXISTS (SELECT 1 FROM tenant_restore_replay_runs r JOIN tenant_restore_fences f ON BINARY f.tenant_id=BINARY NEW.tenant_id AND BINARY f.request_id=BINARY NEW.request_id AND f.subject_generation=NEW.subject_generation AND BINARY f.fence_sha256=BINARY NEW.fence_sha256 WHERE BINARY r.restore_run_id=BINARY NEW.restore_run_id AND r.phase='prepared' AND NEW.replay_ordinal=r.entry_count+1 AND NEW.target_ordinal<r.target_count AND BINARY NEW.previous_entry_root_sha256=BINARY r.entry_root_sha256 AND BINARY NEW.logical_database_namespace_sha256=BINARY r.logical_database_namespace_sha256 AND BINARY NEW.t1_fence_sha256=BINARY f.t1_fence_sha256 AND BINARY NEW.operation_sha256=BINARY f.operation_sha256 AND BINARY NEW.record_sha256=BINARY f.record_sha256 AND NEW.store_db_timestamp_ms>=f.installed_at_db_ms AND (NEW.fence_disposition='exact_replay' OR (NEW.fence_disposition='installed' AND BINARY f.restore_run_id=BINARY NEW.restore_run_id))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore replay entry is not source-bound'; END IF; END;

DROP TRIGGER IF EXISTS trg_restore_journal_runtime_heads_bi;
CREATE TRIGGER trg_restore_journal_runtime_heads_bi BEFORE INSERT ON tenant_restore_runtime_heads FOR EACH ROW BEGIN IF NOT (NEW.singleton_id=1 AND NEW.checkpoint_control_generation=1 AND NEW.remote_sequence=0 AND BINARY NEW.head_root_sha256=BINARY '43d0d8350fb8afc557d4454447f3d630440769dc17b6a955454c563f0dbd3056' AND EXISTS (SELECT 1 FROM tenant_restore_runtime_control c WHERE c.singleton_id=1 AND c.state='inactive' AND c.control_generation=0) AND EXISTS (SELECT 1 FROM tenant_restore_journal_control c WHERE c.singleton_id=1 AND c.control_generation=0)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore runtime head insert is not a primary baseline'; END IF; END;
DROP TRIGGER IF EXISTS trg_restore_journal_runtime_heads_bd;
CREATE TRIGGER trg_restore_journal_runtime_heads_bd BEFORE DELETE ON tenant_restore_runtime_heads FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore runtime head cannot be deleted';
DROP TRIGGER IF EXISTS trg_restore_journal_runtime_heads_bu;
CREATE TRIGGER trg_restore_journal_runtime_heads_bu BEFORE UPDATE ON tenant_restore_runtime_heads FOR EACH ROW BEGIN IF NOT (OLD.singleton_id<=>NEW.singleton_id AND OLD.target_ordinal<=>NEW.target_ordinal AND OLD.target_sha256<=>NEW.target_sha256 AND OLD.failure_domain_sha256<=>NEW.failure_domain_sha256 AND OLD.adapter_protocol<=>NEW.adapter_protocol AND OLD.journal_namespace_sha256<=>NEW.journal_namespace_sha256 AND OLD.logical_database_namespace_sha256<=>NEW.logical_database_namespace_sha256 AND NEW.updated_at_db_ms>=OLD.updated_at_db_ms AND EXISTS (SELECT 1 FROM tenant_restore_runtime_control c WHERE c.singleton_id=1 AND c.state='active' AND BINARY c.logical_database_namespace_sha256=BINARY NEW.logical_database_namespace_sha256 AND NEW.checkpoint_control_generation=c.control_generation+1 AND OLD.checkpoint_control_generation<=c.control_generation AND ((BINARY NEW.runtime_epoch_sha256=BINARY c.runtime_epoch_sha256 AND NEW.remote_sequence=OLD.remote_sequence+1 AND BINARY NEW.head_root_sha256<>BINARY OLD.head_root_sha256) OR (BINARY NEW.runtime_epoch_sha256<>BINARY c.runtime_epoch_sha256 AND EXISTS (SELECT 1 FROM tenant_restore_replay_runs r WHERE r.phase='replay_sealed' AND BINARY r.runtime_epoch_sha256=BINARY NEW.runtime_epoch_sha256 AND BINARY r.logical_database_namespace_sha256=BINARY NEW.logical_database_namespace_sha256 AND NEW.target_ordinal<r.target_count AND CAST(JSON_UNQUOTE(JSON_EXTRACT(r.sealed_target_catalog_json,CONCAT('$[',NEW.target_ordinal,'].targetOrdinal'))) AS UNSIGNED)=NEW.target_ordinal AND BINARY JSON_UNQUOTE(JSON_EXTRACT(r.sealed_target_catalog_json,CONCAT('$[',NEW.target_ordinal,'].targetSha256'))) = BINARY NEW.target_sha256 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(r.sealed_target_catalog_json,CONCAT('$[',NEW.target_ordinal,'].failureDomainSha256'))) = BINARY NEW.failure_domain_sha256 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(r.sealed_target_catalog_json,CONCAT('$[',NEW.target_ordinal,'].adapterProtocol'))) = BINARY NEW.adapter_protocol AND BINARY JSON_UNQUOTE(JSON_EXTRACT(r.sealed_target_catalog_json,CONCAT('$[',NEW.target_ordinal,'].journalNamespaceSha256'))) = BINARY NEW.journal_namespace_sha256 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(r.sealed_target_catalog_json,CONCAT('$[',NEW.target_ordinal,'].logicalDatabaseNamespaceSha256'))) = BINARY NEW.logical_database_namespace_sha256 AND CAST(JSON_UNQUOTE(JSON_EXTRACT(r.sealed_target_catalog_json,CONCAT('$[',NEW.target_ordinal,'].sealedRemoteSequence'))) AS UNSIGNED)=NEW.remote_sequence AND BINARY JSON_UNQUOTE(JSON_EXTRACT(r.sealed_target_catalog_json,CONCAT('$[',NEW.target_ordinal,'].sealedHeadRootSha256'))) = BINARY NEW.head_root_sha256 AND NEW.updated_at_db_ms>=r.sealed_at_db_ms))))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore runtime head update is not permitted'; END IF; END;

DROP TRIGGER IF EXISTS trg_restore_journal_runtime_known_bu;
CREATE TRIGGER trg_restore_journal_runtime_known_bu BEFORE UPDATE ON tenant_restore_runtime_known_entries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore runtime known entry is immutable';
DROP TRIGGER IF EXISTS trg_restore_journal_runtime_known_bd;
CREATE TRIGGER trg_restore_journal_runtime_known_bd BEFORE DELETE ON tenant_restore_runtime_known_entries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore runtime known entry is append-only';
DROP TRIGGER IF EXISTS trg_restore_journal_runtime_known_bi;
CREATE TRIGGER trg_restore_journal_runtime_known_bi BEFORE INSERT ON tenant_restore_runtime_known_entries FOR EACH ROW BEGIN IF NOT (EXISTS (SELECT 1 FROM tenant_restore_runtime_control c JOIN tenant_restore_runtime_heads h ON h.singleton_id=c.singleton_id AND h.target_ordinal=NEW.target_ordinal AND BINARY h.target_sha256=BINARY NEW.target_sha256 WHERE c.singleton_id=1 AND c.state='active' AND BINARY c.runtime_epoch_sha256=BINARY NEW.runtime_epoch_sha256 AND BINARY c.logical_database_namespace_sha256=BINARY NEW.logical_database_namespace_sha256 AND NEW.control_generation=c.control_generation+1 AND NEW.remote_sequence=h.remote_sequence+1 AND BINARY NEW.previous_head_root_sha256=BINARY h.head_root_sha256 AND NEW.recorded_at_db_ms>=c.updated_at_db_ms) AND (EXISTS (SELECT 1 FROM tenant_restore_fences f WHERE BINARY f.request_id=BINARY NEW.request_id AND BINARY f.tenant_id=BINARY NEW.tenant_id AND f.subject_generation=NEW.subject_generation AND BINARY f.logical_database_namespace_sha256=BINARY NEW.logical_database_namespace_sha256 AND BINARY f.t1_fence_sha256=BINARY NEW.t1_fence_sha256 AND BINARY f.operation_sha256=BINARY NEW.operation_sha256 AND BINARY f.record_sha256=BINARY NEW.record_sha256) OR EXISTS (SELECT 1 FROM tenant_restore_journal_targets t JOIN tenant_restore_journal_jobs j ON BINARY j.request_id=BINARY t.request_id AND BINARY j.tenant_id=BINARY t.tenant_id AND j.subject_generation=t.subject_generation AND j.publication_generation=t.publication_generation WHERE BINARY t.request_id=BINARY NEW.request_id AND BINARY t.tenant_id=BINARY NEW.tenant_id AND t.subject_generation=NEW.subject_generation AND t.target_ordinal=NEW.target_ordinal AND BINARY t.target_sha256=BINARY NEW.target_sha256 AND BINARY t.logical_database_namespace_sha256=BINARY NEW.logical_database_namespace_sha256 AND BINARY t.t1_fence_sha256=BINARY NEW.t1_fence_sha256 AND BINARY t.operation_sha256=BINARY NEW.operation_sha256 AND BINARY t.record_sha256=BINARY NEW.record_sha256 AND BINARY j.control_evidence_sha256=(SELECT BINARY control_evidence_sha256 FROM tenant_restore_runtime_control WHERE singleton_id=1)))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore runtime known entry is not source-bound'; END IF; END;

DROP TRIGGER IF EXISTS trg_restore_journal_runtime_events_bu;
CREATE TRIGGER trg_restore_journal_runtime_events_bu BEFORE UPDATE ON tenant_restore_runtime_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore runtime event is immutable';
DROP TRIGGER IF EXISTS trg_restore_journal_runtime_events_bd;
CREATE TRIGGER trg_restore_journal_runtime_events_bd BEFORE DELETE ON tenant_restore_runtime_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore runtime event is append-only';
DROP TRIGGER IF EXISTS trg_restore_journal_runtime_events_bi;
CREATE TRIGGER trg_restore_journal_runtime_events_bi BEFORE INSERT ON tenant_restore_runtime_events FOR EACH ROW BEGIN IF NOT EXISTS (SELECT 1 FROM tenant_restore_runtime_control c WHERE c.singleton_id=NEW.singleton_id AND NEW.control_generation=c.control_generation+1 AND ((c.control_generation=0 AND BINARY NEW.previous_control_evidence_sha256=BINARY '44bf64ec269083713f602ff9de0c936f48e8515f97335290eefd9dd2c61c9590') OR (c.control_generation>0 AND BINARY NEW.previous_control_evidence_sha256=BINARY c.evidence_sha256)) AND ((NEW.update_kind='primary_activation' AND c.state='inactive' AND c.control_generation=0 AND NEW.control_generation=1 AND NEW.lineage_kind='primary' AND BINARY NEW.activation_epoch_sha256=BINARY NEW.runtime_epoch_sha256) OR (NEW.update_kind='restore_activation' AND c.state='active' AND c.control_generation>0 AND NEW.lineage_kind='restore' AND BINARY NEW.runtime_epoch_sha256<>BINARY c.runtime_epoch_sha256 AND BINARY NEW.activation_epoch_sha256=BINARY NEW.runtime_epoch_sha256 AND EXISTS (SELECT 1 FROM tenant_restore_replay_runs r WHERE BINARY r.restore_run_id=BINARY NEW.restore_run_id AND r.phase='replay_sealed' AND BINARY r.terminal_receipt_sha256=BINARY NEW.replay_receipt_sha256 AND BINARY r.runtime_epoch_sha256=BINARY NEW.runtime_epoch_sha256 AND BINARY r.sealed_target_root_sha256=BINARY NEW.verified_head_root_sha256)) OR (NEW.update_kind='journal_head_advance' AND c.state='active' AND NEW.activation_epoch_sha256 IS NULL AND NEW.lineage_kind<=>c.lineage_kind AND NEW.activated_at_db_ms<=>c.activated_at_db_ms AND NEW.restore_run_id<=>c.restore_run_id AND NEW.replay_receipt_sha256<=>c.replay_receipt_sha256 AND NEW.runtime_epoch_sha256<=>c.runtime_epoch_sha256 AND NEW.control_evidence_sha256<=>c.control_evidence_sha256 AND NEW.logical_database_namespace_sha256<=>c.logical_database_namespace_sha256 AND NEW.target_count<=>c.target_count AND NEW.target_root_sha256<=>c.target_root_sha256 AND EXISTS (SELECT 1 FROM tenant_restore_runtime_known_entries k WHERE k.singleton_id=1 AND k.control_generation=NEW.control_generation AND BINARY k.runtime_epoch_sha256=BINARY NEW.runtime_epoch_sha256 AND k.recorded_at_db_ms<=NEW.updated_at_db_ms)))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore runtime event is not control-bound'; END IF; END;

DROP TRIGGER IF EXISTS trg_restore_journal_runtime_bi;
CREATE TRIGGER trg_restore_journal_runtime_bi BEFORE INSERT ON tenant_restore_runtime_control FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore runtime control already exists';
DROP TRIGGER IF EXISTS trg_restore_journal_runtime_bd;
CREATE TRIGGER trg_restore_journal_runtime_bd BEFORE DELETE ON tenant_restore_runtime_control FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore runtime control cannot be deleted';
DROP TRIGGER IF EXISTS trg_restore_journal_runtime_bu;
CREATE TRIGGER trg_restore_journal_runtime_bu BEFORE UPDATE ON tenant_restore_runtime_control FOR EACH ROW BEGIN IF NOT (OLD.singleton_id=1 AND NEW.singleton_id=1 AND NEW.state='active' AND NEW.control_generation=OLD.control_generation+1 AND NEW.updated_at_db_ms IS NOT NULL AND NEW.evidence_sha256 IS NOT NULL AND ((OLD.control_generation=0 AND BINARY NEW.previous_control_evidence_sha256=BINARY '44bf64ec269083713f602ff9de0c936f48e8515f97335290eefd9dd2c61c9590') OR (OLD.control_generation>0 AND BINARY NEW.previous_control_evidence_sha256=BINARY OLD.evidence_sha256)) AND ((NEW.update_kind='primary_activation' AND OLD.state='inactive' AND OLD.control_generation=0 AND NEW.control_generation=1 AND NEW.lineage_kind='primary' AND NEW.restore_run_id IS NULL AND NEW.replay_receipt_sha256 IS NULL AND NEW.activated_at_db_ms=NEW.updated_at_db_ms AND NEW.runtime_epoch_sha256 IS NOT NULL AND NEW.control_evidence_sha256 IS NOT NULL AND NEW.logical_database_namespace_sha256 IS NOT NULL AND NEW.target_count BETWEEN 1 AND 32 AND NEW.target_root_sha256 IS NOT NULL AND NEW.verified_head_root_sha256 IS NOT NULL AND (SELECT COUNT(*) FROM tenant_restore_runtime_heads h WHERE h.singleton_id=1)=NEW.target_count AND NOT EXISTS (SELECT 1 FROM tenant_restore_runtime_heads h WHERE h.singleton_id=1 AND (h.target_ordinal>=NEW.target_count OR h.checkpoint_control_generation<>1 OR BINARY h.runtime_epoch_sha256<>BINARY NEW.runtime_epoch_sha256 OR BINARY h.logical_database_namespace_sha256<>BINARY NEW.logical_database_namespace_sha256 OR h.remote_sequence<>0 OR BINARY h.head_root_sha256<>BINARY '43d0d8350fb8afc557d4454447f3d630440769dc17b6a955454c563f0dbd3056' OR h.updated_at_db_ms<>NEW.updated_at_db_ms))) OR (NEW.update_kind='restore_activation' AND OLD.state='active' AND OLD.control_generation>0 AND NEW.lineage_kind='restore' AND NEW.activated_at_db_ms=NEW.updated_at_db_ms AND NEW.activated_at_db_ms>=OLD.updated_at_db_ms AND NEW.restore_run_id IS NOT NULL AND NEW.replay_receipt_sha256 IS NOT NULL AND NEW.runtime_epoch_sha256 IS NOT NULL AND NEW.control_evidence_sha256 IS NOT NULL AND NEW.logical_database_namespace_sha256 IS NOT NULL AND NEW.target_count BETWEEN 1 AND 32 AND NEW.target_root_sha256 IS NOT NULL AND NEW.verified_head_root_sha256 IS NOT NULL AND (SELECT COUNT(*) FROM tenant_restore_runtime_heads h WHERE h.singleton_id=1)=NEW.target_count AND NOT EXISTS (SELECT 1 FROM tenant_restore_runtime_heads h WHERE h.singleton_id=1 AND (h.target_ordinal>=NEW.target_count OR h.checkpoint_control_generation<>NEW.control_generation OR BINARY h.runtime_epoch_sha256<>BINARY NEW.runtime_epoch_sha256 OR BINARY h.logical_database_namespace_sha256<>BINARY NEW.logical_database_namespace_sha256 OR h.updated_at_db_ms<>NEW.updated_at_db_ms)) AND EXISTS (SELECT 1 FROM tenant_restore_replay_runs r WHERE BINARY r.restore_run_id=BINARY NEW.restore_run_id AND r.phase='replay_sealed' AND BINARY r.terminal_receipt_sha256=BINARY NEW.replay_receipt_sha256 AND BINARY r.runtime_epoch_sha256=BINARY NEW.runtime_epoch_sha256 AND BINARY r.control_evidence_sha256=BINARY NEW.control_evidence_sha256 AND BINARY r.logical_database_namespace_sha256=BINARY NEW.logical_database_namespace_sha256 AND r.target_count=NEW.target_count AND BINARY r.target_root_sha256=BINARY NEW.target_root_sha256 AND BINARY r.sealed_target_root_sha256=BINARY NEW.verified_head_root_sha256 AND NEW.activated_at_db_ms>=r.sealed_at_db_ms)) OR (NEW.update_kind='journal_head_advance' AND OLD.state='active' AND OLD.control_generation>0 AND NEW.lineage_kind<=>OLD.lineage_kind AND NEW.activated_at_db_ms<=>OLD.activated_at_db_ms AND NEW.restore_run_id<=>OLD.restore_run_id AND NEW.replay_receipt_sha256<=>OLD.replay_receipt_sha256 AND NEW.runtime_epoch_sha256<=>OLD.runtime_epoch_sha256 AND NEW.control_evidence_sha256<=>OLD.control_evidence_sha256 AND NEW.logical_database_namespace_sha256<=>OLD.logical_database_namespace_sha256 AND NEW.target_count<=>OLD.target_count AND NEW.target_root_sha256<=>OLD.target_root_sha256 AND NEW.updated_at_db_ms>=OLD.updated_at_db_ms AND NOT (NEW.verified_head_root_sha256<=>OLD.verified_head_root_sha256) AND (SELECT COUNT(*) FROM tenant_restore_runtime_heads h WHERE h.singleton_id=1)=NEW.target_count AND (SELECT COUNT(*) FROM tenant_restore_runtime_heads h WHERE h.singleton_id=1 AND h.checkpoint_control_generation=NEW.control_generation AND h.updated_at_db_ms=NEW.updated_at_db_ms)=1 AND NOT EXISTS (SELECT 1 FROM tenant_restore_runtime_heads h WHERE h.singleton_id=1 AND (h.target_ordinal>=NEW.target_count OR h.checkpoint_control_generation>NEW.control_generation OR BINARY h.runtime_epoch_sha256<>BINARY NEW.runtime_epoch_sha256 OR BINARY h.logical_database_namespace_sha256<>BINARY NEW.logical_database_namespace_sha256))))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore runtime control transition is not permitted'; END IF; END;
DROP TRIGGER IF EXISTS trg_restore_journal_runtime_au;
CREATE TRIGGER trg_restore_journal_runtime_au AFTER UPDATE ON tenant_restore_runtime_control FOR EACH ROW BEGIN IF NOT EXISTS (SELECT 1 FROM tenant_restore_runtime_events e WHERE e.singleton_id=NEW.singleton_id AND e.control_generation=NEW.control_generation AND e.update_kind<=>NEW.update_kind AND e.lineage_kind<=>NEW.lineage_kind AND e.activated_at_db_ms<=>NEW.activated_at_db_ms AND e.updated_at_db_ms<=>NEW.updated_at_db_ms AND e.restore_run_id<=>NEW.restore_run_id AND e.replay_receipt_sha256<=>NEW.replay_receipt_sha256 AND e.runtime_epoch_sha256<=>NEW.runtime_epoch_sha256 AND e.control_evidence_sha256<=>NEW.control_evidence_sha256 AND e.logical_database_namespace_sha256<=>NEW.logical_database_namespace_sha256 AND e.target_count<=>NEW.target_count AND e.target_root_sha256<=>NEW.target_root_sha256 AND e.verified_head_root_sha256<=>NEW.verified_head_root_sha256 AND e.previous_control_evidence_sha256<=>NEW.previous_control_evidence_sha256 AND e.evidence_sha256<=>NEW.evidence_sha256) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore runtime control lacks exact immutable event'; END IF; END;

-- T3a is the first destructive tenant-erasure boundary. Publication must be externally ACKed
-- before either the immutable T3a receipt or the terminal job projection can be published.
DROP TRIGGER IF EXISTS trg_restore_journal_t3a_receipt_bi;
CREATE TRIGGER trg_restore_journal_t3a_receipt_bi BEFORE INSERT ON tenant_credential_revocation_receipts FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 0; SELECT control_generation INTO v_generation FROM tenant_restore_journal_control WHERE singleton_id=1 FOR SHARE; IF v_generation<>0 AND NOT EXISTS (SELECT 1 FROM tenant_restore_journal_receipts j WHERE BINARY j.request_id=BINARY NEW.request_id AND BINARY j.tenant_id=BINARY NEW.tenant_id AND j.subject_generation=NEW.subject_generation AND BINARY j.t1_fence_sha256=BINARY NEW.t1_fence_sha256 AND j.restore_fence_publication_complete=TRUE AND j.restore_fence_replay_complete=FALSE AND j.physical_replay_complete=FALSE AND j.all_domains_complete=FALSE AND j.content_purge_executed=FALSE AND j.store_db_timestamp_ms<=NEW.store_db_timestamp_ms) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active restore journal requires exact publication before T3a receipt'; END IF; END;
DROP TRIGGER IF EXISTS trg_restore_journal_t3a_job_bu;
CREATE TRIGGER trg_restore_journal_t3a_job_bu BEFORE UPDATE ON tenant_credential_revocation_jobs FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 0; SELECT control_generation INTO v_generation FROM tenant_restore_journal_control WHERE singleton_id=1 FOR SHARE; IF v_generation<>0 AND OLD.phase='queued' AND NEW.phase='credential_store_revoked' AND NOT EXISTS (SELECT 1 FROM tenant_restore_journal_receipts j JOIN tenant_credential_revocation_receipts r ON BINARY r.request_id=BINARY j.request_id AND BINARY r.tenant_id=BINARY j.tenant_id AND r.subject_generation=j.subject_generation WHERE BINARY j.request_id=BINARY NEW.request_id AND BINARY j.tenant_id=BINARY NEW.tenant_id AND j.subject_generation=NEW.subject_generation AND BINARY j.t1_fence_sha256=BINARY NEW.t1_fence_sha256 AND j.restore_fence_publication_complete=TRUE AND j.restore_fence_replay_complete=FALSE AND j.physical_replay_complete=FALSE AND j.all_domains_complete=FALSE AND j.content_purge_executed=FALSE AND j.store_db_timestamp_ms<=NEW.credential_store_revoked_at_ms AND r.store_db_timestamp_ms=NEW.credential_store_revoked_at_ms AND r.completed_claim_attempt=NEW.completed_claim_attempt AND BINARY r.completed_claim_token_sha256=BINARY NEW.completed_claim_token_sha256) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active restore journal requires exact publication before terminal T3a job'; END IF; END;

-- agent-service-runtime-fingerprint:tenant-restore-journal-triggers:start
SET @restore_journal_trigger_ok=(
  SELECT COUNT(*)=39 AND COUNT(DISTINCT trigger_name)=39
     AND SHA2(GROUP_CONCAT(CONCAT_WS('~',event_object_table,trigger_name,
           action_timing,event_manipulation,action_orientation,
           IFNULL(action_condition,'<NULL>'),
           LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),
             CHAR(96),''),'_utf8mb4','')))
         ORDER BY event_object_table,trigger_name SEPARATOR '|'),256)=
       '14e62c1a512ca4536696dba5e9d1433dc96db760d9f6c9c56d1f9d994c9dbc49'
    FROM information_schema.triggers
   WHERE trigger_schema=DATABASE()
     AND trigger_name LIKE 'trg\_restore\_journal\_%'
);
-- agent-service-runtime-fingerprint:tenant-restore-journal-triggers:end
SET @migration_sql=IF(@restore_journal_trigger_ok=1,'SELECT 1',
  'SELECT 1 FROM __invalid_tenant_restore_journal_trigger_inventory__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
SET SESSION group_concat_max_len=@restore_journal_previous_group_concat_max_len;
