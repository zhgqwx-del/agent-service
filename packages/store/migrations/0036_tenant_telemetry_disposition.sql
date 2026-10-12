-- Expand-only, default-dormant telemetry disposition/delete/restore substrate.
-- No DDL in this migration activates execution, contacts a sink or journal, scans historical
-- artifacts, deletes objects, relabels pre-cutover capture, or changes T3d blockers/completion.
-- Content-free external authority is mirrored independently from local jobs so that a restored
-- old database snapshot can replay a permanent same-key tombstone fence without inventing work.

-- Marker-loss replay while active must not momentarily drop the legacy-writer cutover guards.
-- An activated control can be repaired only under an explicit offline, independently fenced
-- operator procedure; this migration itself fails before any DDL in that state.
SET @tt_disposition_replay_state=NULL;
SET @migration_sql=IF(
  EXISTS (SELECT 1 FROM information_schema.tables
           WHERE table_schema=DATABASE()
             AND table_name='tenant_telemetry_disposition_control'),
  'SELECT state INTO @tt_disposition_replay_state FROM tenant_telemetry_disposition_control WHERE singleton_id=1',
  'SELECT NULL INTO @tt_disposition_replay_state');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
SET @migration_sql=IF(@tt_disposition_replay_state='active',
  'SELECT 1 FROM __invalid_active_tenant_telemetry_disposition_migration_replay__','SELECT 1');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

CREATE TABLE IF NOT EXISTS tenant_telemetry_disposition_control (
  singleton_id                         TINYINT UNSIGNED NOT NULL,
  state                                VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  control_generation                   BIGINT UNSIGNED NOT NULL,
  scope                                VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  protocol                             VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  lifecycle_control_generation         BIGINT UNSIGNED NULL,
  lifecycle_target_root_sha256         CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  adapter_protocol                     VARCHAR(128) COLLATE utf8mb4_0900_as_cs NULL,
  journal_namespace_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  journal_target_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  failure_domain_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  logical_database_namespace_sha256   CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  activated_at_db_ms                   BIGINT NULL,
  activation_evidence_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  PRIMARY KEY (singleton_id),
  UNIQUE KEY uk_tt_disposition_control_activation (activation_evidence_sha256),
  CONSTRAINT chk_tt_disposition_control CHECK ((
    singleton_id=1 AND scope='tenant-telemetry-disposition-control-v1'
    AND ((state='inactive' AND control_generation=0 AND protocol IS NULL
          AND lifecycle_control_generation IS NULL AND lifecycle_target_root_sha256 IS NULL
          AND adapter_protocol IS NULL AND journal_namespace_sha256 IS NULL
          AND journal_target_sha256 IS NULL AND failure_domain_sha256 IS NULL
          AND logical_database_namespace_sha256 IS NULL AND activated_at_db_ms IS NULL
          AND activation_evidence_sha256 IS NULL)
      OR (state='active' AND control_generation=1
          AND protocol='tenant-telemetry-disposition-v1'
          AND lifecycle_control_generation=1
          AND lifecycle_target_root_sha256 REGEXP '^[0-9a-f]{64}$'
          AND adapter_protocol REGEXP '^[A-Za-z0-9][A-Za-z0-9._:~/-]{0,127}$'
          AND journal_namespace_sha256 REGEXP '^[0-9a-f]{64}$'
          AND journal_target_sha256 REGEXP '^[0-9a-f]{64}$'
          AND failure_domain_sha256 REGEXP '^[0-9a-f]{64}$'
          AND logical_database_namespace_sha256 REGEXP '^[0-9a-f]{64}$'
          AND activated_at_db_ms>=0
          AND activation_evidence_sha256 REGEXP '^[0-9a-f]{64}$'))
  ) IS TRUE)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT singleton_id,state,control_generation,scope,protocol,lifecycle_control_generation,
       lifecycle_target_root_sha256,adapter_protocol,journal_namespace_sha256,
       journal_target_sha256,failure_domain_sha256,logical_database_namespace_sha256,
       activated_at_db_ms,activation_evidence_sha256
  FROM tenant_telemetry_disposition_control FORCE INDEX (
    PRIMARY,uk_tt_disposition_control_activation
  ) WHERE 1=0;

INSERT INTO tenant_telemetry_disposition_control
  (singleton_id,state,control_generation,scope)
SELECT 1,'inactive',0,'tenant-telemetry-disposition-control-v1'
 WHERE NOT EXISTS (SELECT 1 FROM tenant_telemetry_disposition_control);

CREATE TABLE IF NOT EXISTS tenant_telemetry_disposition_activation_receipts (
  singleton_id                         TINYINT UNSIGNED NOT NULL,
  scope                                VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  protocol                             VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  control_generation                   BIGINT UNSIGNED NOT NULL,
  activation_evidence_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  lifecycle_target_root_sha256         CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  journal_namespace_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  journal_target_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  failure_domain_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  logical_database_namespace_sha256   CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  activated_at_db_ms                   BIGINT NOT NULL,
  receipt_sha256                       CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  receipt_json                         JSON NOT NULL,
  PRIMARY KEY (singleton_id),
  UNIQUE KEY uk_tt_disposition_activation_receipt (receipt_sha256),
  CONSTRAINT fk_tt_disposition_activation_control FOREIGN KEY (singleton_id)
    REFERENCES tenant_telemetry_disposition_control (singleton_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tt_disposition_activation_receipt CHECK (
    singleton_id=1 AND scope='tenant-telemetry-disposition-activation-receipt-v1'
    AND protocol='tenant-telemetry-disposition-v1' AND control_generation=1
    AND activation_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
    AND lifecycle_target_root_sha256 REGEXP '^[0-9a-f]{64}$'
    AND journal_namespace_sha256 REGEXP '^[0-9a-f]{64}$'
    AND journal_target_sha256 REGEXP '^[0-9a-f]{64}$'
    AND failure_domain_sha256 REGEXP '^[0-9a-f]{64}$'
    AND logical_database_namespace_sha256 REGEXP '^[0-9a-f]{64}$'
    AND activated_at_db_ms>=0 AND receipt_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT singleton_id,scope,protocol,control_generation,activation_evidence_sha256,
       lifecycle_target_root_sha256,journal_namespace_sha256,journal_target_sha256,
       failure_domain_sha256,logical_database_namespace_sha256,activated_at_db_ms,
       receipt_sha256,receipt_json
  FROM tenant_telemetry_disposition_activation_receipts FORCE INDEX (
    PRIMARY,uk_tt_disposition_activation_receipt
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_telemetry_disposition_jobs (
  disposition_operation_sha256         CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                            VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_id                           VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  scope                                VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  protocol                             VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  domain                               VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_sha256                        CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  artifact_id_sha256                   CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  artifact_generation                  BIGINT UNSIGNED NOT NULL,
  inventory_sha256                     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  write_operation_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  t3c_receipt_sha256                   CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  t3d_plan_receipt_sha256              CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  t3d_plan_entry_receipt_sha256        CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  phase                                VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  attempts                             BIGINT UNSIGNED NOT NULL,
  available_at_db_ms                   BIGINT NULL,
  claim_token                          VARCHAR(128) COLLATE utf8mb4_0900_as_cs NULL,
  lease_until_db_ms                    BIGINT NULL,
  last_error_code                      VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL,
  authorization_receipt_sha256         CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  terminal_receipt_sha256              CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  tombstoned_at_db_ms                  BIGINT NULL,
  blocked_at_db_ms                     BIGINT NULL,
  blocked_reason_code                  VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL,
  created_at_db_ms                     BIGINT NOT NULL,
  updated_at_db_ms                     BIGINT NOT NULL,
  job_json                             JSON NOT NULL,
  PRIMARY KEY (disposition_operation_sha256),
  UNIQUE KEY uk_tt_disposition_job_artifact
    (target_sha256,artifact_id_sha256,artifact_generation),
  UNIQUE KEY uk_tt_disposition_job_inventory (inventory_sha256),
  KEY idx_tt_disposition_job_queue
    (phase,available_at_db_ms,lease_until_db_ms,disposition_operation_sha256),
  KEY idx_tt_disposition_job_tenant
    (tenant_id,request_id,phase,disposition_operation_sha256),
  KEY idx_tt_disposition_job_plan
    (request_id,domain,t3d_plan_entry_receipt_sha256),
  CONSTRAINT chk_tt_disposition_job CHECK ((
    disposition_operation_sha256 REGEXP '^[0-9a-f]{64}$'
    AND OCTET_LENGTH(CONVERT(tenant_id USING utf16)) BETWEEN 2 AND 256
    AND request_id REGEXP '^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$'
    AND scope='tenant-telemetry-disposition-job-v1'
    AND protocol='tenant-telemetry-disposition-v1'
    AND domain IN ('logs','traces')
    AND target_sha256 REGEXP '^[0-9a-f]{64}$'
    AND artifact_id_sha256 REGEXP '^[0-9a-f]{64}$'
    AND artifact_generation>0
    AND inventory_sha256 REGEXP '^[0-9a-f]{64}$'
    AND write_operation_sha256 REGEXP '^[0-9a-f]{64}$'
    AND t3c_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND t3d_plan_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND t3d_plan_entry_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND phase IN ('queued','authorized','tombstoned','blocked')
    AND created_at_db_ms>=0 AND updated_at_db_ms>=created_at_db_ms
    AND (last_error_code IS NULL
      OR last_error_code IN ('temporary_failure','dependency_pending'))
    AND ((phase IN ('queued','authorized')
          AND available_at_db_ms IS NOT NULL
          AND terminal_receipt_sha256 IS NULL AND tombstoned_at_db_ms IS NULL
          AND blocked_at_db_ms IS NULL AND blocked_reason_code IS NULL
          AND ((claim_token IS NULL AND lease_until_db_ms IS NULL
                AND available_at_db_ms>=updated_at_db_ms)
            OR (claim_token IS NOT NULL AND lease_until_db_ms IS NOT NULL
                AND attempts>0 AND lease_until_db_ms>=updated_at_db_ms
                AND last_error_code IS NULL))
          AND ((phase='queued' AND authorization_receipt_sha256 IS NULL)
            OR (phase='authorized'
                AND authorization_receipt_sha256 REGEXP '^[0-9a-f]{64}$')))
      OR (phase='tombstoned' AND available_at_db_ms IS NULL
          AND claim_token IS NULL AND lease_until_db_ms IS NULL AND last_error_code IS NULL
          AND authorization_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
          AND terminal_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
          AND tombstoned_at_db_ms>=created_at_db_ms
          AND blocked_at_db_ms IS NULL AND blocked_reason_code IS NULL)
      OR (phase='blocked' AND available_at_db_ms IS NULL
          AND claim_token IS NULL AND lease_until_db_ms IS NULL AND last_error_code IS NULL
          AND terminal_receipt_sha256 IS NULL AND tombstoned_at_db_ms IS NULL
          AND blocked_at_db_ms>=created_at_db_ms
          AND blocked_reason_code='integrity_conflict'))
  ) IS TRUE)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT disposition_operation_sha256,tenant_id,request_id,scope,protocol,domain,
       target_sha256,artifact_id_sha256,artifact_generation,inventory_sha256,
       write_operation_sha256,t3c_receipt_sha256,t3d_plan_receipt_sha256,
       t3d_plan_entry_receipt_sha256,phase,attempts,available_at_db_ms,
       claim_token,lease_until_db_ms,last_error_code,authorization_receipt_sha256,
       terminal_receipt_sha256,tombstoned_at_db_ms,blocked_at_db_ms,
       blocked_reason_code,created_at_db_ms,updated_at_db_ms,job_json
  FROM tenant_telemetry_disposition_jobs FORCE INDEX (
    PRIMARY,uk_tt_disposition_job_artifact,uk_tt_disposition_job_inventory,
    idx_tt_disposition_job_queue,idx_tt_disposition_job_tenant,idx_tt_disposition_job_plan
  ) WHERE 1=0;

-- A local authorization grant is issued only after a source-validated, claimed, DB-time-live
-- transaction.  External journal hashes by themselves are never a deletion capability.
CREATE TABLE IF NOT EXISTS tenant_telemetry_disposition_authorization_grants (
  disposition_operation_sha256         CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                            VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  grant_receipt_sha256                 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  claim_token_sha256                   CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  granted_at_db_ms                     BIGINT NOT NULL,
  lease_until_db_ms                    BIGINT NOT NULL,
  grant_json                           JSON NOT NULL,
  PRIMARY KEY (disposition_operation_sha256),
  UNIQUE KEY uk_tt_disposition_grant_receipt (grant_receipt_sha256),
  KEY idx_tt_disposition_grant_tenant (tenant_id,lease_until_db_ms),
  CONSTRAINT fk_tt_disposition_grant_job FOREIGN KEY (disposition_operation_sha256)
    REFERENCES tenant_telemetry_disposition_jobs (disposition_operation_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tt_disposition_grant CHECK (
    disposition_operation_sha256 REGEXP '^[0-9a-f]{64}$'
    AND OCTET_LENGTH(CONVERT(tenant_id USING utf16)) BETWEEN 2 AND 256
    AND grant_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND claim_token_sha256 REGEXP '^[0-9a-f]{64}$'
    AND granted_at_db_ms>=0 AND lease_until_db_ms>granted_at_db_ms
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT disposition_operation_sha256,tenant_id,grant_receipt_sha256,
       claim_token_sha256,granted_at_db_ms,lease_until_db_ms,grant_json
  FROM tenant_telemetry_disposition_authorization_grants FORCE INDEX (
    PRIMARY,uk_tt_disposition_grant_receipt,idx_tt_disposition_grant_tenant
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_telemetry_disposition_external_authorizations (
  disposition_operation_sha256         CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                            VARCHAR(128) COLLATE utf8mb4_0900_as_cs NULL,
  authorization_receipt_sha256         CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  journal_sequence                     BIGINT UNSIGNED NOT NULL,
  journal_event_root_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  authorization_json                   JSON NOT NULL,
  PRIMARY KEY (disposition_operation_sha256),
  UNIQUE KEY uk_tt_disposition_authorization_receipt (authorization_receipt_sha256),
  UNIQUE KEY uk_tt_disposition_authorization_sequence (journal_sequence),
  CONSTRAINT chk_tt_disposition_external_authorization CHECK (
    disposition_operation_sha256 REGEXP '^[0-9a-f]{64}$'
    AND (tenant_id IS NULL OR OCTET_LENGTH(CONVERT(tenant_id USING utf16)) BETWEEN 2 AND 256)
    AND authorization_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND journal_sequence>0
    AND journal_event_root_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT disposition_operation_sha256,tenant_id,authorization_receipt_sha256,
       journal_sequence,journal_event_root_sha256,authorization_json
  FROM tenant_telemetry_disposition_external_authorizations FORCE INDEX (
    PRIMARY,uk_tt_disposition_authorization_receipt,
    uk_tt_disposition_authorization_sequence
  ) WHERE 1=0;

-- This mirror has no FK to jobs or inventory: a selected physical backup may predate both.
CREATE TABLE IF NOT EXISTS tenant_telemetry_disposition_external_events (
  journal_sequence                     BIGINT UNSIGNED NOT NULL,
  event_type                           VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  disposition_operation_sha256         CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  previous_journal_event_root_sha256   CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  journal_event_sha256                 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  journal_event_root_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  event_json                           JSON NOT NULL,
  PRIMARY KEY (journal_sequence),
  UNIQUE KEY uk_tt_disposition_event_root (journal_event_root_sha256),
  UNIQUE KEY uk_tt_disposition_event_operation_type
    (disposition_operation_sha256,event_type),
  CONSTRAINT chk_tt_disposition_external_event CHECK (
    journal_sequence>0
    AND event_type IN ('delete_authorized','delete_tombstoned')
    AND disposition_operation_sha256 REGEXP '^[0-9a-f]{64}$'
    AND previous_journal_event_root_sha256 REGEXP '^[0-9a-f]{64}$'
    AND journal_event_sha256 REGEXP '^[0-9a-f]{64}$'
    AND journal_event_root_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT journal_sequence,event_type,disposition_operation_sha256,
       previous_journal_event_root_sha256,journal_event_sha256,
       journal_event_root_sha256,event_json
  FROM tenant_telemetry_disposition_external_events FORCE INDEX (
    PRIMARY,uk_tt_disposition_event_root,uk_tt_disposition_event_operation_type
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_telemetry_disposition_tombstone_acks (
  disposition_operation_sha256         CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                            VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  receipt_sha256                       CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tombstone_sha256                     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  ack_json                             JSON NOT NULL,
  PRIMARY KEY (disposition_operation_sha256),
  UNIQUE KEY uk_tt_disposition_tombstone_receipt (receipt_sha256),
  CONSTRAINT chk_tt_disposition_tombstone_ack CHECK (
    disposition_operation_sha256 REGEXP '^[0-9a-f]{64}$'
    AND OCTET_LENGTH(CONVERT(tenant_id USING utf16)) BETWEEN 2 AND 256
    AND receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND tombstone_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT disposition_operation_sha256,tenant_id,receipt_sha256,tombstone_sha256,ack_json
  FROM tenant_telemetry_disposition_tombstone_acks FORCE INDEX (
    PRIMARY,uk_tt_disposition_tombstone_receipt
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_telemetry_disposition_receipts (
  disposition_operation_sha256         CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                            VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_id                           VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  receipt_sha256                       CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  store_db_timestamp_ms                BIGINT NOT NULL,
  receipt_json                         JSON NOT NULL,
  PRIMARY KEY (disposition_operation_sha256),
  UNIQUE KEY uk_tt_disposition_receipt_hash (receipt_sha256),
  KEY idx_tt_disposition_receipt_owner (tenant_id,request_id,store_db_timestamp_ms),
  CONSTRAINT fk_tt_disposition_receipt_job
    FOREIGN KEY (disposition_operation_sha256)
    REFERENCES tenant_telemetry_disposition_jobs (disposition_operation_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tt_disposition_receipt CHECK (
    disposition_operation_sha256 REGEXP '^[0-9a-f]{64}$'
    AND OCTET_LENGTH(CONVERT(tenant_id USING utf16)) BETWEEN 2 AND 256
    AND request_id REGEXP '^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$'
    AND receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND store_db_timestamp_ms>=0
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT disposition_operation_sha256,tenant_id,request_id,receipt_sha256,
       store_db_timestamp_ms,receipt_json
  FROM tenant_telemetry_disposition_receipts FORCE INDEX (
    PRIMARY,uk_tt_disposition_receipt_hash,idx_tt_disposition_receipt_owner
  ) WHERE 1=0;

-- A replay fence is external-authority projection, not proof that a local job existed.  It must
-- survive old-snapshot restore where inventory, write ACK, job and local terminal receipt vanish.
CREATE TABLE IF NOT EXISTS tenant_telemetry_disposition_replay_fences (
  target_sha256                        CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  artifact_id_sha256                   CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  artifact_generation                  BIGINT UNSIGNED NOT NULL,
  domain                               VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  disposition_operation_sha256         CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  authorization_receipt_sha256         CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tombstone_receipt_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  terminal_receipt_sha256              CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  journal_target_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  terminal_journal_sequence            BIGINT UNSIGNED NOT NULL,
  terminal_journal_event_root_sha256   CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  sealed_journal_sequence              BIGINT UNSIGNED NOT NULL,
  sealed_journal_event_root_sha256     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  restore_run_sha256                   CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  runtime_epoch_sha256                 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  receipt_sha256                       CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  fence_json                           JSON NOT NULL,
  PRIMARY KEY (target_sha256,artifact_id_sha256,artifact_generation),
  UNIQUE KEY uk_tt_disposition_replay_operation (disposition_operation_sha256),
  UNIQUE KEY uk_tt_disposition_replay_receipt (receipt_sha256),
  KEY idx_tt_disposition_replay_restore (restore_run_sha256,runtime_epoch_sha256),
  CONSTRAINT chk_tt_disposition_replay_fence CHECK ((
    target_sha256 REGEXP '^[0-9a-f]{64}$'
    AND artifact_id_sha256 REGEXP '^[0-9a-f]{64}$' AND artifact_generation>0
    AND domain IN ('logs','traces')
    AND disposition_operation_sha256 REGEXP '^[0-9a-f]{64}$'
    AND authorization_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND tombstone_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND terminal_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
    AND journal_target_sha256 REGEXP '^[0-9a-f]{64}$'
    AND terminal_journal_sequence>0
    AND terminal_journal_event_root_sha256 REGEXP '^[0-9a-f]{64}$'
    AND sealed_journal_sequence>=terminal_journal_sequence
    AND sealed_journal_event_root_sha256 REGEXP '^[0-9a-f]{64}$'
    AND ((restore_run_sha256 IS NULL AND runtime_epoch_sha256 IS NULL)
      OR (restore_run_sha256 REGEXP '^[0-9a-f]{64}$'
          AND runtime_epoch_sha256 REGEXP '^[0-9a-f]{64}$'))
    AND receipt_sha256 REGEXP '^[0-9a-f]{64}$'
  ) IS TRUE)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT target_sha256,artifact_id_sha256,artifact_generation,domain,
       disposition_operation_sha256,authorization_receipt_sha256,
       tombstone_receipt_sha256,terminal_receipt_sha256,journal_target_sha256,
       terminal_journal_sequence,terminal_journal_event_root_sha256,
       sealed_journal_sequence,sealed_journal_event_root_sha256,
       restore_run_sha256,runtime_epoch_sha256,receipt_sha256,fence_json
  FROM tenant_telemetry_disposition_replay_fences FORCE INDEX (
    PRIMARY,uk_tt_disposition_replay_operation,uk_tt_disposition_replay_receipt,
    idx_tt_disposition_replay_restore
  ) WHERE 1=0;

-- Guards are installed only after the dormant singleton has been seeded.  Activation must first
-- publish its immutable receipt, then atomically advance this row 0 -> 1 in the same transaction.
DROP TRIGGER IF EXISTS trg_tt_disposition_control_bi;
CREATE TRIGGER trg_tt_disposition_control_bi BEFORE INSERT ON tenant_telemetry_disposition_control FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry disposition control already exists';
DROP TRIGGER IF EXISTS trg_tt_disposition_control_bd;
CREATE TRIGGER trg_tt_disposition_control_bd BEFORE DELETE ON tenant_telemetry_disposition_control FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry disposition control cannot be deleted';
DROP TRIGGER IF EXISTS trg_tt_disposition_control_bu;
CREATE TRIGGER trg_tt_disposition_control_bu BEFORE UPDATE ON tenant_telemetry_disposition_control FOR EACH ROW BEGIN IF NOT (OLD.singleton_id=1 AND NEW.singleton_id=1 AND OLD.state='inactive' AND OLD.control_generation=0 AND NEW.state='active' AND NEW.control_generation=1 AND EXISTS (SELECT 1 FROM tenant_telemetry_disposition_activation_receipts r WHERE r.singleton_id=1 AND r.control_generation=1 AND BINARY r.activation_evidence_sha256=BINARY NEW.activation_evidence_sha256 AND BINARY r.lifecycle_target_root_sha256=BINARY NEW.lifecycle_target_root_sha256 AND BINARY r.journal_namespace_sha256=BINARY NEW.journal_namespace_sha256 AND BINARY r.journal_target_sha256=BINARY NEW.journal_target_sha256 AND BINARY r.failure_domain_sha256=BINARY NEW.failure_domain_sha256 AND BINARY r.logical_database_namespace_sha256=BINARY NEW.logical_database_namespace_sha256 AND r.activated_at_db_ms=NEW.activated_at_db_ms)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry disposition control is not receipt-bound'; END IF; END;

DROP TRIGGER IF EXISTS trg_tt_disposition_activation_bi;
CREATE TRIGGER trg_tt_disposition_activation_bi BEFORE INSERT ON tenant_telemetry_disposition_activation_receipts FOR EACH ROW BEGIN DECLARE disposition_state VARCHAR(16); DECLARE disposition_generation BIGINT UNSIGNED; SELECT c.state,c.control_generation INTO disposition_state,disposition_generation FROM tenant_telemetry_disposition_control c WHERE c.singleton_id=1 FOR UPDATE; IF disposition_state IS NULL OR disposition_state<>'inactive' OR disposition_generation<>0 OR NOT (EXISTS (SELECT 1 FROM tenant_telemetry_lifecycle_control c WHERE c.singleton_id=1 AND c.control_generation=1 AND BINARY c.target_root_sha256=BINARY NEW.lifecycle_target_root_sha256 AND c.activated_at_db_ms<=NEW.activated_at_db_ms) AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_write_jobs j WHERE j.phase<>'written' OR j.write_ack_receipt_sha256 IS NULL) AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_write_payloads) AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_disposition_jobs) AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_disposition_external_events) AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_disposition_replay_fences)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry disposition activation is not source-bound'; END IF; END;
DROP TRIGGER IF EXISTS trg_tt_disposition_activation_bu;
CREATE TRIGGER trg_tt_disposition_activation_bu BEFORE UPDATE ON tenant_telemetry_disposition_activation_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry disposition activation receipt is immutable';
DROP TRIGGER IF EXISTS trg_tt_disposition_activation_bd;
CREATE TRIGGER trg_tt_disposition_activation_bd BEFORE DELETE ON tenant_telemetry_disposition_activation_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry disposition activation receipt is append-only';

-- A queued job cannot confer authority when T3d still says blocked_adapter_unconfigured.  A
-- blocked job is a diagnostic record only.  The local store performs the stronger full-root,
-- owner/hold and DB-time validation in the same transaction before writing either state.
DROP TRIGGER IF EXISTS trg_tt_disposition_job_bi;
CREATE TRIGGER trg_tt_disposition_job_bi BEFORE INSERT ON tenant_telemetry_disposition_jobs FOR EACH ROW BEGIN IF (EXISTS (SELECT 1 FROM tenant_telemetry_disposition_control c WHERE c.singleton_id=1 AND c.state='active' AND c.control_generation=1) AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.job_json,'$.dispositionOperationSha256'))=BINARY NEW.disposition_operation_sha256 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.job_json,'$.tenantId'))=BINARY NEW.tenant_id AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.job_json,'$.requestId'))=BINARY NEW.request_id AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.job_json,'$.domain'))=BINARY NEW.domain AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.job_json,'$.targetSha256'))=BINARY NEW.target_sha256 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.job_json,'$.artifactIdSha256'))=BINARY NEW.artifact_id_sha256 AND CAST(JSON_UNQUOTE(JSON_EXTRACT(NEW.job_json,'$.artifactGeneration')) AS UNSIGNED)=NEW.artifact_generation AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.job_json,'$.phase'))=BINARY NEW.phase AND (NEW.phase='blocked' OR (NEW.phase='queued' AND EXISTS (SELECT 1 FROM tenant_telemetry_artifact_inventory i WHERE BINARY i.inventory_sha256=BINARY NEW.inventory_sha256 AND BINARY i.tenant_id=BINARY NEW.tenant_id AND BINARY i.domain=BINARY NEW.domain AND BINARY i.target_sha256=BINARY NEW.target_sha256 AND BINARY i.artifact_id_sha256=BINARY NEW.artifact_id_sha256 AND i.artifact_generation=NEW.artifact_generation) AND EXISTS (SELECT 1 FROM tenant_telemetry_write_acks a WHERE BINARY a.write_operation_sha256=BINARY NEW.write_operation_sha256 AND BINARY a.inventory_sha256=BINARY NEW.inventory_sha256 AND BINARY a.tenant_id=BINARY NEW.tenant_id AND BINARY a.domain=BINARY NEW.domain AND BINARY a.target_sha256=BINARY NEW.target_sha256) AND EXISTS (SELECT 1 FROM tenant_purge_plan_entries p WHERE BINARY p.request_id=BINARY NEW.request_id AND BINARY p.tenant_id=BINARY NEW.tenant_id AND BINARY p.domain=BINARY NEW.domain AND BINARY p.receipt_sha256=BINARY NEW.t3d_plan_entry_receipt_sha256 AND p.disposition='delete' AND p.target_count>0)))) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry disposition job is not executable-source-bound'; END IF; END;
DROP TRIGGER IF EXISTS trg_tt_disposition_job_bu;
CREATE TRIGGER trg_tt_disposition_job_bu BEFORE UPDATE ON tenant_telemetry_disposition_jobs FOR EACH ROW BEGIN IF (BINARY OLD.disposition_operation_sha256=BINARY NEW.disposition_operation_sha256 AND BINARY OLD.tenant_id=BINARY NEW.tenant_id AND BINARY OLD.request_id=BINARY NEW.request_id AND BINARY OLD.domain=BINARY NEW.domain AND BINARY OLD.target_sha256=BINARY NEW.target_sha256 AND BINARY OLD.artifact_id_sha256=BINARY NEW.artifact_id_sha256 AND OLD.artifact_generation=NEW.artifact_generation AND BINARY OLD.inventory_sha256=BINARY NEW.inventory_sha256 AND BINARY OLD.write_operation_sha256=BINARY NEW.write_operation_sha256 AND BINARY OLD.t3c_receipt_sha256=BINARY NEW.t3c_receipt_sha256 AND BINARY OLD.t3d_plan_receipt_sha256=BINARY NEW.t3d_plan_receipt_sha256 AND BINARY OLD.t3d_plan_entry_receipt_sha256=BINARY NEW.t3d_plan_entry_receipt_sha256 AND OLD.created_at_db_ms=NEW.created_at_db_ms AND NEW.updated_at_db_ms>=OLD.updated_at_db_ms AND NEW.attempts>=OLD.attempts AND OLD.phase IN ('queued','authorized') AND NEW.phase IN ('queued','authorized','tombstoned','blocked') AND (OLD.phase<>'authorized' OR NEW.phase<>'queued') AND (OLD.authorization_receipt_sha256 IS NULL OR BINARY OLD.authorization_receipt_sha256=BINARY NEW.authorization_receipt_sha256)) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry disposition job transition is invalid'; END IF; END;
DROP TRIGGER IF EXISTS trg_tt_disposition_job_bd;
CREATE TRIGGER trg_tt_disposition_job_bd BEFORE DELETE ON tenant_telemetry_disposition_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry disposition job is append-only';

DROP TRIGGER IF EXISTS trg_tt_disposition_grant_bi;
CREATE TRIGGER trg_tt_disposition_grant_bi BEFORE INSERT ON tenant_telemetry_disposition_authorization_grants FOR EACH ROW BEGIN IF NOT EXISTS (SELECT 1 FROM tenant_telemetry_disposition_jobs j JOIN tenant_purge_plan_entries p ON BINARY p.request_id=BINARY j.request_id AND BINARY p.tenant_id=BINARY j.tenant_id AND BINARY p.domain=BINARY j.domain AND BINARY p.receipt_sha256=BINARY j.t3d_plan_entry_receipt_sha256 WHERE BINARY j.disposition_operation_sha256=BINARY NEW.disposition_operation_sha256 AND BINARY j.tenant_id=BINARY NEW.tenant_id AND j.phase='queued' AND j.claim_token IS NOT NULL AND BINARY SHA2(j.claim_token,256)=BINARY NEW.claim_token_sha256 AND j.lease_until_db_ms>CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED) AND NEW.granted_at_db_ms>=j.updated_at_db_ms AND NEW.lease_until_db_ms<=j.lease_until_db_ms AND p.disposition='delete' AND p.target_count>0) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry disposition grant lacks live executable source'; END IF; END;
DROP TRIGGER IF EXISTS trg_tt_disposition_grant_bu;
CREATE TRIGGER trg_tt_disposition_grant_bu BEFORE UPDATE ON tenant_telemetry_disposition_authorization_grants FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry disposition authorization grant is immutable';
DROP TRIGGER IF EXISTS trg_tt_disposition_grant_bd;
CREATE TRIGGER trg_tt_disposition_grant_bd BEFORE DELETE ON tenant_telemetry_disposition_authorization_grants FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry disposition authorization grant is append-only';

-- Local authorization remains subordinate to a fresh executable T3d plan.  An external mirror
-- event is deliberately not subordinate to this local job, since restore may lose the latter.
DROP TRIGGER IF EXISTS trg_tt_disposition_authorization_bi;
CREATE TRIGGER trg_tt_disposition_authorization_bi BEFORE INSERT ON tenant_telemetry_disposition_external_authorizations FOR EACH ROW BEGIN IF NOT (EXISTS (SELECT 1 FROM tenant_telemetry_disposition_external_events e WHERE e.journal_sequence=NEW.journal_sequence AND e.event_type='delete_authorized' AND BINARY e.disposition_operation_sha256=BINARY NEW.disposition_operation_sha256 AND BINARY e.journal_event_root_sha256=BINARY NEW.journal_event_root_sha256) AND ((NEW.tenant_id IS NULL AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_disposition_jobs j WHERE BINARY j.disposition_operation_sha256=BINARY NEW.disposition_operation_sha256)) OR EXISTS (SELECT 1 FROM tenant_telemetry_disposition_jobs j JOIN tenant_purge_plan_entries p ON BINARY p.request_id=BINARY j.request_id AND BINARY p.tenant_id=BINARY j.tenant_id AND BINARY p.domain=BINARY j.domain AND BINARY p.receipt_sha256=BINARY j.t3d_plan_entry_receipt_sha256 JOIN tenant_telemetry_disposition_authorization_grants g ON BINARY g.disposition_operation_sha256=BINARY j.disposition_operation_sha256 AND BINARY g.tenant_id=BINARY j.tenant_id WHERE BINARY j.disposition_operation_sha256=BINARY NEW.disposition_operation_sha256 AND BINARY j.tenant_id=BINARY NEW.tenant_id AND j.phase IN ('queued','authorized') AND p.disposition='delete' AND p.target_count>0))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry external authorization is not source-bound'; END IF; END;
DROP TRIGGER IF EXISTS trg_tt_disposition_authorization_bu;
CREATE TRIGGER trg_tt_disposition_authorization_bu BEFORE UPDATE ON tenant_telemetry_disposition_external_authorizations FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry external authorization is immutable';
DROP TRIGGER IF EXISTS trg_tt_disposition_authorization_bd;
CREATE TRIGGER trg_tt_disposition_authorization_bd BEFORE DELETE ON tenant_telemetry_disposition_external_authorizations FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry external authorization is append-only';

DROP TRIGGER IF EXISTS trg_tt_disposition_event_bi;
CREATE TRIGGER trg_tt_disposition_event_bi BEFORE INSERT ON tenant_telemetry_disposition_external_events FOR EACH ROW BEGIN IF NOT ((NEW.journal_sequence=1 AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_disposition_external_events)) OR (NEW.journal_sequence>1 AND EXISTS (SELECT 1 FROM tenant_telemetry_disposition_external_events p WHERE p.journal_sequence=NEW.journal_sequence-1 AND BINARY p.journal_event_root_sha256=BINARY NEW.previous_journal_event_root_sha256) AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_disposition_external_events n WHERE n.journal_sequence>=NEW.journal_sequence))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry disposition external event chain is not contiguous'; END IF; IF NEW.event_type='delete_tombstoned' AND NOT EXISTS (SELECT 1 FROM tenant_telemetry_disposition_external_events a WHERE BINARY a.disposition_operation_sha256=BINARY NEW.disposition_operation_sha256 AND a.event_type='delete_authorized' AND a.journal_sequence<NEW.journal_sequence) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry disposition tombstone lacks authorization event'; END IF; END;
DROP TRIGGER IF EXISTS trg_tt_disposition_event_bu;
CREATE TRIGGER trg_tt_disposition_event_bu BEFORE UPDATE ON tenant_telemetry_disposition_external_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry disposition external event is immutable';
DROP TRIGGER IF EXISTS trg_tt_disposition_event_bd;
CREATE TRIGGER trg_tt_disposition_event_bd BEFORE DELETE ON tenant_telemetry_disposition_external_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry disposition external event is append-only';

DROP TRIGGER IF EXISTS trg_tt_disposition_tombstone_bi;
CREATE TRIGGER trg_tt_disposition_tombstone_bi BEFORE INSERT ON tenant_telemetry_disposition_tombstone_acks FOR EACH ROW BEGIN IF NOT EXISTS (SELECT 1 FROM tenant_telemetry_disposition_external_authorizations a WHERE BINARY a.disposition_operation_sha256=BINARY NEW.disposition_operation_sha256 AND BINARY a.tenant_id=BINARY NEW.tenant_id) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry tombstone ACK lacks authorization'; END IF; END;
DROP TRIGGER IF EXISTS trg_tt_disposition_tombstone_bu;
CREATE TRIGGER trg_tt_disposition_tombstone_bu BEFORE UPDATE ON tenant_telemetry_disposition_tombstone_acks FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry tombstone ACK is immutable';
DROP TRIGGER IF EXISTS trg_tt_disposition_tombstone_bd;
CREATE TRIGGER trg_tt_disposition_tombstone_bd BEFORE DELETE ON tenant_telemetry_disposition_tombstone_acks FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry tombstone ACK is append-only';

DROP TRIGGER IF EXISTS trg_tt_disposition_receipt_bi;
CREATE TRIGGER trg_tt_disposition_receipt_bi BEFORE INSERT ON tenant_telemetry_disposition_receipts FOR EACH ROW BEGIN IF NOT (EXISTS (SELECT 1 FROM tenant_telemetry_disposition_jobs j WHERE BINARY j.disposition_operation_sha256=BINARY NEW.disposition_operation_sha256 AND BINARY j.tenant_id=BINARY NEW.tenant_id AND BINARY j.request_id=BINARY NEW.request_id AND j.phase='authorized') AND EXISTS (SELECT 1 FROM tenant_telemetry_disposition_tombstone_acks a WHERE BINARY a.disposition_operation_sha256=BINARY NEW.disposition_operation_sha256 AND BINARY a.tenant_id=BINARY NEW.tenant_id) AND EXISTS (SELECT 1 FROM tenant_telemetry_disposition_external_events e WHERE BINARY e.disposition_operation_sha256=BINARY NEW.disposition_operation_sha256 AND e.event_type='delete_tombstoned')) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry disposition receipt lacks terminal proof'; END IF; END;
DROP TRIGGER IF EXISTS trg_tt_disposition_receipt_bu;
CREATE TRIGGER trg_tt_disposition_receipt_bu BEFORE UPDATE ON tenant_telemetry_disposition_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry disposition receipt is immutable';
DROP TRIGGER IF EXISTS trg_tt_disposition_receipt_bd;
CREATE TRIGGER trg_tt_disposition_receipt_bd BEFORE DELETE ON tenant_telemetry_disposition_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry disposition receipt is append-only';

DROP TRIGGER IF EXISTS trg_tt_disposition_replay_bi;
CREATE TRIGGER trg_tt_disposition_replay_bi BEFORE INSERT ON tenant_telemetry_disposition_replay_fences FOR EACH ROW BEGIN IF NOT EXISTS (SELECT 1 FROM tenant_telemetry_disposition_external_events e WHERE e.journal_sequence=NEW.terminal_journal_sequence AND e.event_type='delete_tombstoned' AND BINARY e.disposition_operation_sha256=BINARY NEW.disposition_operation_sha256 AND BINARY e.journal_event_root_sha256=BINARY NEW.terminal_journal_event_root_sha256) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry disposition replay fence lacks external terminal event'; END IF; END;
DROP TRIGGER IF EXISTS trg_tt_disposition_replay_bu;
CREATE TRIGGER trg_tt_disposition_replay_bu BEFORE UPDATE ON tenant_telemetry_disposition_replay_fences FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry disposition replay fence is immutable';
DROP TRIGGER IF EXISTS trg_tt_disposition_replay_bd;
CREATE TRIGGER trg_tt_disposition_replay_bd BEFORE DELETE ON tenant_telemetry_disposition_replay_fences FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry disposition replay fence is append-only';

-- No 0036-aware live writer generation exists yet.  Once this maintenance-only control is
-- explicitly activated, the database stops every new legacy writer/job/direct inventory insert,
-- not just requests that happen to pass through a new binary.  A later expand migration must
-- introduce a generation-bound dual-write contract before continuous capture can resume.
DROP TRIGGER IF EXISTS trg_tt_disposition_legacy_write_bi;
CREATE TRIGGER trg_tt_disposition_legacy_write_bi BEFORE INSERT ON tenant_telemetry_write_jobs FOR EACH ROW BEGIN DECLARE disposition_state VARCHAR(16); SELECT c.state INTO disposition_state FROM tenant_telemetry_disposition_control c WHERE c.singleton_id=1 FOR SHARE; IF disposition_state IS NULL OR disposition_state<>'inactive' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry disposition cutover blocks legacy writer'; END IF; END;
DROP TRIGGER IF EXISTS trg_tt_disposition_legacy_inventory_bi;
CREATE TRIGGER trg_tt_disposition_legacy_inventory_bi BEFORE INSERT ON tenant_telemetry_artifact_inventory FOR EACH ROW BEGIN DECLARE disposition_state VARCHAR(16); SELECT c.state INTO disposition_state FROM tenant_telemetry_disposition_control c WHERE c.singleton_id=1 FOR SHARE; IF disposition_state IS NULL OR disposition_state<>'inactive' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry disposition cutover blocks legacy inventory'; END IF; END;

SET @tt_disposition_previous_group_concat_max_len=@@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len=1048576;
-- agent-service-runtime-fingerprint:tenant-telemetry-disposition-schema:start
SET @tt_disposition_schema_ok=(
  (SELECT COUNT(*)=9
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,table_type,
             IFNULL(engine,'-'),IFNULL(table_collation,'-'))
           ORDER BY table_name SEPARATOR '|'),256)=
         '910aabce80d962fb52db8e85d34c037cf3763fd4fa723c04df3c3bb4a35abd61'
     FROM information_schema.tables
    WHERE table_schema=DATABASE() AND table_name IN (
      'tenant_telemetry_disposition_control',
      'tenant_telemetry_disposition_activation_receipts',
      'tenant_telemetry_disposition_jobs',
      'tenant_telemetry_disposition_authorization_grants',
      'tenant_telemetry_disposition_external_authorizations',
      'tenant_telemetry_disposition_external_events',
      'tenant_telemetry_disposition_tombstone_acks',
      'tenant_telemetry_disposition_receipts',
      'tenant_telemetry_disposition_replay_fences'))
  AND
  (SELECT COUNT(*)=103
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,LPAD(ordinal_position,3,'0'),
             column_name,LOWER(column_type),is_nullable,
             IF(column_default IS NULL,'<NULL>',CONCAT('<',column_default,'>')),
             IFNULL(character_set_name,'-'),IFNULL(collation_name,'-'),
             IFNULL(NULLIF(LOWER(extra),''),'-'),
             IFNULL(NULLIF(LOWER(generation_expression),''),'-'))
           ORDER BY table_name,ordinal_position SEPARATOR '|'),256)=
         '8f920b46b2731d2e4bd3082767d79229bdcb80ae5e6eebc557dd04c5807fac98'
     FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name IN (
      'tenant_telemetry_disposition_control',
      'tenant_telemetry_disposition_activation_receipts',
      'tenant_telemetry_disposition_jobs',
      'tenant_telemetry_disposition_authorization_grants',
      'tenant_telemetry_disposition_external_authorizations',
      'tenant_telemetry_disposition_external_events',
      'tenant_telemetry_disposition_tombstone_acks',
      'tenant_telemetry_disposition_receipts',
      'tenant_telemetry_disposition_replay_fences'))
  AND
  (SELECT COUNT(DISTINCT CONCAT(table_name,'~',index_name))=28 AND COUNT(*)=45
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,index_name,non_unique,
             seq_in_index,LOWER(index_type),LOWER(is_visible),
             IFNULL(column_name,'<expression>'),IFNULL(CAST(sub_part AS CHAR),'-'),
             LOWER(IFNULL(collation,'-')),IFNULL(expression,'-'))
           ORDER BY table_name,index_name,seq_in_index SEPARATOR '|'),256)=
         'a83af8df6c6e33f652331c4e9e68b0a8c3b63bb8b2fc2a8e5908f41229736d2c'
     FROM information_schema.statistics
    WHERE table_schema=DATABASE() AND table_name IN (
      'tenant_telemetry_disposition_control',
      'tenant_telemetry_disposition_activation_receipts',
      'tenant_telemetry_disposition_jobs',
      'tenant_telemetry_disposition_authorization_grants',
      'tenant_telemetry_disposition_external_authorizations',
      'tenant_telemetry_disposition_external_events',
      'tenant_telemetry_disposition_tombstone_acks',
      'tenant_telemetry_disposition_receipts',
      'tenant_telemetry_disposition_replay_fences'))
  AND
  (SELECT COUNT(*)=9
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',tc.table_name,tc.constraint_name,tc.enforced,
             LOWER(REPLACE(REPLACE(REGEXP_REPLACE(cc.check_clause,'[[:space:]]',''),
               CHAR(96),''),'_utf8mb4','')))
           ORDER BY tc.table_name,tc.constraint_name SEPARATOR '|'),256)=
         'f06767b8c605e91a0e335a1093751c8db96857cddc79265578bf836dd824f8c3'
     FROM information_schema.table_constraints tc
     JOIN information_schema.check_constraints cc
       ON cc.constraint_schema=tc.constraint_schema
      AND cc.constraint_name=tc.constraint_name
    WHERE tc.table_schema=DATABASE() AND tc.constraint_type='CHECK'
      AND tc.table_name IN (
        'tenant_telemetry_disposition_control',
        'tenant_telemetry_disposition_activation_receipts',
        'tenant_telemetry_disposition_jobs',
        'tenant_telemetry_disposition_authorization_grants',
        'tenant_telemetry_disposition_external_authorizations',
        'tenant_telemetry_disposition_external_events',
        'tenant_telemetry_disposition_tombstone_acks',
        'tenant_telemetry_disposition_receipts',
        'tenant_telemetry_disposition_replay_fences'))
  AND
  (SELECT COUNT(*)=34
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,constraint_type,enforced)
           ORDER BY table_name,constraint_name SEPARATOR '|'),256)=
         '3a24a1e2c81e8885d1bbcebd1c99b8026b0c01dc35c0d2b3ac7ef38cfde78cbd'
     FROM information_schema.table_constraints
    WHERE table_schema=DATABASE() AND table_name IN (
      'tenant_telemetry_disposition_control',
      'tenant_telemetry_disposition_activation_receipts',
      'tenant_telemetry_disposition_jobs',
      'tenant_telemetry_disposition_authorization_grants',
      'tenant_telemetry_disposition_external_authorizations',
      'tenant_telemetry_disposition_external_events',
      'tenant_telemetry_disposition_tombstone_acks',
      'tenant_telemetry_disposition_receipts',
      'tenant_telemetry_disposition_replay_fences'))
  AND
  (SELECT COUNT(DISTINCT CONCAT(k.table_name,'~',k.constraint_name))=3 AND COUNT(*)=3
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',k.table_name,k.constraint_name,
             k.ordinal_position,k.column_name,k.referenced_table_name,
             k.referenced_column_name,r.update_rule,r.delete_rule)
           ORDER BY k.table_name,k.constraint_name,k.ordinal_position SEPARATOR '|'),256)=
         '3d59c75106af06a8f99ddf5a1e85162a86c95bbf4c2214fbe5ec43cd3663c1ca'
     FROM information_schema.key_column_usage k
     JOIN information_schema.referential_constraints r
       ON r.constraint_schema=k.constraint_schema AND r.constraint_name=k.constraint_name
    WHERE k.table_schema=DATABASE() AND k.referenced_table_name IS NOT NULL
      AND k.table_name IN (
        'tenant_telemetry_disposition_control',
        'tenant_telemetry_disposition_activation_receipts',
        'tenant_telemetry_disposition_jobs',
        'tenant_telemetry_disposition_authorization_grants',
        'tenant_telemetry_disposition_external_authorizations',
        'tenant_telemetry_disposition_external_events',
        'tenant_telemetry_disposition_tombstone_acks',
        'tenant_telemetry_disposition_receipts',
        'tenant_telemetry_disposition_replay_fences'))
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.partitions
     WHERE table_schema=DATABASE() AND partition_name IS NOT NULL
       AND table_name IN (
        'tenant_telemetry_disposition_control',
        'tenant_telemetry_disposition_activation_receipts',
        'tenant_telemetry_disposition_jobs',
        'tenant_telemetry_disposition_authorization_grants',
        'tenant_telemetry_disposition_external_authorizations',
        'tenant_telemetry_disposition_external_events',
        'tenant_telemetry_disposition_tombstone_acks',
        'tenant_telemetry_disposition_receipts',
        'tenant_telemetry_disposition_replay_fences'))
);
-- agent-service-runtime-fingerprint:tenant-telemetry-disposition-schema:end
SET @migration_sql=IF(@tt_disposition_schema_ok=1,'SELECT 1',
  'SELECT 1 FROM __invalid_tenant_telemetry_disposition_schema__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- Includes the full 0035 trigger family plus the 0036 cutover guards on old telemetry tables.
-- agent-service-runtime-fingerprint:tenant-telemetry-disposition-triggers:start
SET @tt_disposition_trigger_ok=(
  SELECT COUNT(*)=83 AND COUNT(DISTINCT trigger_name)=83
     AND SHA2(GROUP_CONCAT(CONCAT_WS('~',event_object_table,trigger_name,
           action_timing,event_manipulation,action_orientation,
           IFNULL(action_condition,'<NULL>'),
           LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),
             CHAR(96),''),'_utf8mb4','')))
         ORDER BY event_object_table,trigger_name SEPARATOR '|'),256)=
       '4f7a12eb3dd4f1dd37bb18cc8513336fbecfd142d740ada9aa4afe08db4d9475'
    FROM information_schema.triggers
   WHERE trigger_schema=DATABASE()
     AND (event_object_table IN (
       'sessions','subject_lifecycle','tenant_telemetry_lifecycle_control',
       'tenant_telemetry_lifecycle_targets','tenant_telemetry_lifecycle_coverages',
       'tenant_telemetry_lifecycle_subjects','tenant_telemetry_activation_receipts',
       'tenant_telemetry_artifact_inventory','tenant_telemetry_write_jobs',
       'tenant_telemetry_write_payloads','tenant_telemetry_write_acks',
       'tenant_telemetry_application_domain_controls',
       'tenant_telemetry_application_activation_receipts',
       'tenant_telemetry_application_coverages',
       'tenant_telemetry_application_write_bindings',
       'tenant_telemetry_disposition_control',
       'tenant_telemetry_disposition_activation_receipts',
       'tenant_telemetry_disposition_jobs',
       'tenant_telemetry_disposition_authorization_grants',
       'tenant_telemetry_disposition_external_authorizations',
       'tenant_telemetry_disposition_external_events',
       'tenant_telemetry_disposition_tombstone_acks',
       'tenant_telemetry_disposition_receipts',
       'tenant_telemetry_disposition_replay_fences') OR
       (event_object_table='tenant_credential_revocation_jobs'
         AND action_timing='BEFORE' AND event_manipulation='INSERT'))
);
-- agent-service-runtime-fingerprint:tenant-telemetry-disposition-triggers:end
SET @migration_sql=IF(@tt_disposition_trigger_ok=1,'SELECT 1',
  'SELECT 1 FROM __invalid_tenant_telemetry_disposition_triggers__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
SET SESSION group_concat_max_len=@tt_disposition_previous_group_concat_max_len;

-- Marker-loss replay may encounter a fresh install or an activated ledger, but never a half
-- activation.  The store independently validates every JSON digest and the complete external
-- chain before accepting authority; SQL guards reject incomplete relational projections.
SET @tt_disposition_projection_ok=(
  (SELECT COUNT(*)=1 FROM tenant_telemetry_disposition_control WHERE singleton_id=1)
  AND NOT EXISTS (
    SELECT 1 FROM tenant_telemetry_disposition_control c
    LEFT JOIN tenant_telemetry_disposition_activation_receipts r ON r.singleton_id=c.singleton_id
    WHERE (c.state='inactive' AND r.singleton_id IS NOT NULL)
       OR (c.state='active' AND (r.singleton_id IS NULL
         OR BINARY r.activation_evidence_sha256<>BINARY c.activation_evidence_sha256
         OR BINARY r.journal_target_sha256<>BINARY c.journal_target_sha256))
  )
  AND NOT EXISTS (
    SELECT 1 FROM tenant_telemetry_disposition_jobs j
    LEFT JOIN tenant_telemetry_disposition_external_authorizations a
      ON BINARY a.disposition_operation_sha256=BINARY j.disposition_operation_sha256
    LEFT JOIN tenant_telemetry_disposition_receipts r
      ON BINARY r.disposition_operation_sha256=BINARY j.disposition_operation_sha256
    WHERE (j.phase='authorized' AND a.disposition_operation_sha256 IS NULL)
       OR (j.phase='tombstoned' AND (a.disposition_operation_sha256 IS NULL
         OR r.disposition_operation_sha256 IS NULL))
       OR (j.phase<>'tombstoned' AND r.disposition_operation_sha256 IS NOT NULL)
  )
);
SET @migration_sql=IF(@tt_disposition_projection_ok=1,'SELECT 1',
  'SELECT 1 FROM __invalid_tenant_telemetry_disposition_projection__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
