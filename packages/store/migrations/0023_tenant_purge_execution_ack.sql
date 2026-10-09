-- Expand-only, default-dormant substrate for T3e local destructive execution and exact ACKs.
-- This migration never materializes a job/domain, reads or deletes tenant content, anonymizes
-- usage, schedules an outbox row, claims work, acknowledges physical deletion, resolves a plan
-- blocker, or advances tenant completion. The singleton is installed inactive; only the runtime
-- transaction committing the first local cutover receipt may activate it. T3d remains immutable
-- and non-authoritative: every execution row binds the exact 0021/0022 evidence generation.

SET @tenant_purge_execution_previous_group_concat_max_len = @@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len = 1048576;

CREATE TABLE IF NOT EXISTS tenant_purge_execution_jobs (
  request_id                              VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                               VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation                      BIGINT UNSIGNED NOT NULL,
  plan_build_generation                   BIGINT UNSIGNED NOT NULL,
  execution_generation                    BIGINT UNSIGNED NOT NULL,
  t3c_receipt_sha256                      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  plan_receipt_sha256                     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  plan_entry_root_sha256                  CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  plan_blocker_count                      BIGINT UNSIGNED NOT NULL,
  plan_blocker_root_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  policy_sha256                           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  purge_not_before_db_ms                  BIGINT NOT NULL,
  source_evidence_db_ms                   BIGINT NOT NULL,
  phase                                   VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  domain_count                            BIGINT UNSIGNED NOT NULL,
  domain_ack_count                        BIGINT UNSIGNED NOT NULL,
  domain_ack_root_sha256                  CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  unresolved_blocker_count                BIGINT UNSIGNED NOT NULL,
  local_cutover_receipt_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  available_at_ms                         BIGINT NULL,
  attempts                                INT UNSIGNED NOT NULL DEFAULT 0,
  claim_token                             VARCHAR(128) COLLATE utf8mb4_0900_as_cs NULL,
  lease_until_ms                          BIGINT NULL,
  last_error_code                         VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL,
  created_at_ms                           BIGINT NOT NULL,
  updated_at_ms                           BIGINT NOT NULL,
  local_physical_ack_receipt_sha256       CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  local_physical_acks_sealed_at_ms        BIGINT NULL,
  completed_claim_attempt                 INT UNSIGNED NULL,
  completed_claim_token_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  blocked_at_ms                           BIGINT NULL,
  blocked_reason_code                     VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL,
  PRIMARY KEY (request_id),
  UNIQUE KEY uk_tenant_purge_exec_jobs_tenant (tenant_id),
  UNIQUE KEY uk_tenant_purge_exec_jobs_generation
    (tenant_id, subject_generation, execution_generation),
  UNIQUE KEY uk_tenant_purge_exec_jobs_identity
    (request_id, tenant_id, subject_generation, plan_build_generation, execution_generation),
  KEY idx_tenant_purge_exec_jobs_claim
    (phase, available_at_ms, lease_until_ms, request_id),
  CONSTRAINT fk_tenant_purge_exec_job_plan
    FOREIGN KEY (request_id) REFERENCES tenant_purge_plan_receipts (request_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tenant_purge_exec_job_inventory
    FOREIGN KEY (request_id) REFERENCES tenant_content_inventory_receipts (request_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tenant_purge_exec_job_generations CHECK (
    subject_generation > 0 AND plan_build_generation > 0 AND execution_generation > 0
  ),
  CONSTRAINT chk_tenant_purge_exec_job_clock CHECK (
    purge_not_before_db_ms >= 0 AND source_evidence_db_ms >= purge_not_before_db_ms
    AND created_at_ms >= 0 AND updated_at_ms >= created_at_ms
  ),
  CONSTRAINT chk_tenant_purge_exec_job_progress CHECK (
    domain_count = 33
    AND plan_blocker_count <= domain_count
    AND unresolved_blocker_count <= plan_blocker_count
    AND ((domain_ack_count = 0
      AND domain_ack_root_sha256 = '4037bd781598fb6d6ee2aebf00cf1096f3e0438932abd9353da8655c1e6504e0')
      OR domain_ack_count > 0)
  ),
  CONSTRAINT chk_tenant_purge_exec_job_phase CHECK (
    (phase = 'queued'
      AND available_at_ms IS NOT NULL AND available_at_ms >= created_at_ms
      AND ((claim_token IS NULL AND lease_until_ms IS NULL
            AND available_at_ms >= updated_at_ms)
        OR (claim_token IS NOT NULL AND lease_until_ms IS NOT NULL
            AND attempts > 0 AND lease_until_ms >= updated_at_ms))
      AND ((claim_token IS NOT NULL AND last_error_code IS NULL)
        OR (claim_token IS NULL AND (last_error_code IS NULL
          OR last_error_code IN ('temporary_failure','physical_ack_pending'))))
      AND local_physical_ack_receipt_sha256 IS NULL
      AND local_physical_acks_sealed_at_ms IS NULL
      AND completed_claim_attempt IS NULL
      AND completed_claim_token_sha256 IS NULL
      AND blocked_at_ms IS NULL AND blocked_reason_code IS NULL)
    OR
    (phase = 'local_physical_acks_sealed'
      AND available_at_ms IS NULL AND claim_token IS NULL AND lease_until_ms IS NULL
      AND last_error_code IS NULL AND local_cutover_receipt_sha256 IS NOT NULL
      AND local_physical_ack_receipt_sha256 IS NOT NULL
      AND local_physical_acks_sealed_at_ms IS NOT NULL
      AND local_physical_acks_sealed_at_ms >= source_evidence_db_ms
      AND local_physical_acks_sealed_at_ms <= updated_at_ms
      AND completed_claim_attempt IS NOT NULL
      AND completed_claim_attempt = attempts AND attempts > 0
      AND completed_claim_token_sha256 IS NOT NULL
      AND blocked_at_ms IS NULL AND blocked_reason_code IS NULL)
    OR
    (phase = 'blocked'
      AND available_at_ms IS NULL AND claim_token IS NULL AND lease_until_ms IS NULL
      AND last_error_code IS NULL
      AND local_physical_ack_receipt_sha256 IS NULL
      AND local_physical_acks_sealed_at_ms IS NULL
      AND completed_claim_attempt IS NULL AND completed_claim_token_sha256 IS NULL
      AND blocked_at_ms IS NOT NULL AND blocked_at_ms >= created_at_ms
      AND blocked_at_ms <= updated_at_ms AND attempts > 0
      AND blocked_reason_code IN ('integrity_conflict','physical_ack_dead_lettered'))
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT request_id, tenant_id, subject_generation, plan_build_generation,
       execution_generation, t3c_receipt_sha256, plan_receipt_sha256,
       plan_entry_root_sha256, plan_blocker_count, plan_blocker_root_sha256,
       policy_sha256, purge_not_before_db_ms, source_evidence_db_ms, phase,
       domain_count, domain_ack_count, domain_ack_root_sha256,
       unresolved_blocker_count, local_cutover_receipt_sha256, available_at_ms,
       attempts, claim_token, lease_until_ms, last_error_code, created_at_ms,
       updated_at_ms, local_physical_ack_receipt_sha256,
       local_physical_acks_sealed_at_ms, completed_claim_attempt,
       completed_claim_token_sha256, blocked_at_ms, blocked_reason_code
  FROM tenant_purge_execution_jobs FORCE INDEX (
    PRIMARY, uk_tenant_purge_exec_jobs_tenant,
    uk_tenant_purge_exec_jobs_generation, uk_tenant_purge_exec_jobs_identity,
    idx_tenant_purge_exec_jobs_claim
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_purge_execution_domains (
  request_id                    VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                     VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation            BIGINT UNSIGNED NOT NULL,
  plan_build_generation         BIGINT UNSIGNED NOT NULL,
  execution_generation          BIGINT UNSIGNED NOT NULL,
  domain                        VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  execution_ordinal             TINYINT UNSIGNED NOT NULL,
  plan_disposition              VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  plan_target_count             BIGINT UNSIGNED NOT NULL,
  plan_target_root_sha256       CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  plan_source_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  plan_entry_receipt_sha256     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  phase                         VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  ack_count                     BIGINT UNSIGNED NOT NULL,
  ack_root_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  final_ack_sha256              CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  updated_at_ms                 BIGINT NOT NULL,
  PRIMARY KEY (request_id, execution_generation, domain),
  UNIQUE KEY uk_tenant_purge_exec_domains_ordinal
    (request_id, execution_generation, execution_ordinal),
  UNIQUE KEY uk_tenant_purge_exec_domains_identity
    (request_id, tenant_id, subject_generation, plan_build_generation,
     execution_generation, domain),
  KEY idx_tenant_purge_exec_domains_owner
    (tenant_id, subject_generation, request_id, execution_generation, domain),
  CONSTRAINT fk_tenant_purge_exec_domain_job
    FOREIGN KEY (request_id, tenant_id, subject_generation, plan_build_generation,
                 execution_generation)
    REFERENCES tenant_purge_execution_jobs
      (request_id, tenant_id, subject_generation, plan_build_generation,
       execution_generation)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tenant_purge_exec_domain_plan_entry
    FOREIGN KEY (request_id, plan_build_generation, domain)
    REFERENCES tenant_purge_plan_entries (request_id, build_generation, domain)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tenant_purge_exec_domain_generation CHECK (
    subject_generation > 0 AND plan_build_generation > 0 AND execution_generation > 0
  ),
  CONSTRAINT chk_tenant_purge_exec_domain_name CHECK (
    domain IN ('tenant_registry','tenant_profile','agent_definitions','session_content',
      'idempotency_receipts','operational_usage','billing_facts','billing_reconciliation',
      'blob_manifest','blob_bytes','blob_outbox','lifecycle_outbox','user_export_control',
      'user_export_snapshots','user_export_artifacts','user_export_bytes',
      'user_erasure_evidence','user_purge_policy_evidence','governance_policy','legal_holds',
      'tenant_t1_evidence','tenant_t3a_evidence','tenant_t3b_evidence','tenant_t3c_evidence',
      'redis_leases','redis_fences','redis_streams','external_provider','kms','backup_ledger',
      'restore_ledger','logs','traces')
  ),
  CONSTRAINT chk_tenant_purge_exec_domain_ordinal CHECK (execution_ordinal <= 32),
  CONSTRAINT chk_tenant_purge_exec_domain_disposition CHECK (
    plan_disposition IN ('delete','anonymize','retain_anonymized','revoke','clear',
      'retain_evidence','not_applicable','blocked_legacy_external_source_unavailable',
      'blocked_adapter_unconfigured','blocked_restore_replay_unproven')
  ),
  CONSTRAINT chk_tenant_purge_exec_domain_phase CHECK (
    phase IN ('pending','awaiting_blocker_resolution','awaiting_physical_ack','acked')
    AND ((ack_count = 0
      AND ack_root_sha256 = 'f9d8216d6d9b0e841128b6c2ef5c723b8c4323a05f76b22d7190165e3adde214')
      OR ack_count > 0)
    AND ((phase = 'acked' AND final_ack_sha256 IS NOT NULL AND ack_count > 0)
      OR (phase <> 'acked' AND final_ack_sha256 IS NULL))
    AND updated_at_ms >= 0
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT request_id, tenant_id, subject_generation, plan_build_generation,
       execution_generation, domain, execution_ordinal, plan_disposition,
       plan_target_count, plan_target_root_sha256, plan_source_sha256,
       plan_entry_receipt_sha256, phase, ack_count, ack_root_sha256,
       final_ack_sha256, updated_at_ms
  FROM tenant_purge_execution_domains FORCE INDEX (
    PRIMARY, uk_tenant_purge_exec_domains_ordinal,
    uk_tenant_purge_exec_domains_identity, idx_tenant_purge_exec_domains_owner
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_purge_execution_domain_acks (
  scope                          VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_id                     VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                      VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation             BIGINT UNSIGNED NOT NULL,
  plan_build_generation          BIGINT UNSIGNED NOT NULL,
  execution_generation           BIGINT UNSIGNED NOT NULL,
  domain                         VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  global_ack_seq                 BIGINT UNSIGNED NOT NULL,
  domain_ack_seq                 BIGINT UNSIGNED NOT NULL,
  previous_domain_ack_sha256     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  previous_global_ack_sha256     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  ack_kind                       VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  plan_entry_receipt_sha256      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  affected_count                 BIGINT UNSIGNED NOT NULL,
  result_count                   BIGINT UNSIGNED NOT NULL,
  result_root_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  adapter_protocol               VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  operation_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  physical_proof_sha256          CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  completed_claim_attempt        INT UNSIGNED NOT NULL,
  completed_claim_token_sha256   CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  store_db_timestamp_ms          BIGINT NOT NULL,
  final                          BOOLEAN NOT NULL,
  outbox_kind                    VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL,
  outbox_id                      BIGINT UNSIGNED NULL,
  deletion_generation            BIGINT UNSIGNED NULL,
  target_sha256                  CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  scheduled_ack_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  receipt_sha256                 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (request_id, execution_generation, global_ack_seq),
  UNIQUE KEY uk_tenant_purge_exec_acks_domain_seq
    (request_id, execution_generation, domain, domain_ack_seq),
  UNIQUE KEY uk_tenant_purge_exec_acks_receipt
    (request_id, execution_generation, receipt_sha256),
  UNIQUE KEY uk_tenant_purge_exec_acks_operation
    (request_id, execution_generation, operation_sha256, ack_kind),
  UNIQUE KEY uk_tenant_purge_exec_acks_outbox
    (outbox_kind, outbox_id, deletion_generation, ack_kind),
  KEY idx_tenant_purge_exec_acks_domain_fk
    (request_id, tenant_id, subject_generation, plan_build_generation,
     execution_generation, domain),
  KEY idx_tenant_purge_exec_acks_scheduled_fk
    (request_id, execution_generation, scheduled_ack_sha256),
  KEY idx_tenant_purge_exec_acks_owner
    (tenant_id, subject_generation, request_id, execution_generation, domain),
  CONSTRAINT fk_tenant_purge_exec_ack_domain
    FOREIGN KEY (request_id, tenant_id, subject_generation, plan_build_generation,
                 execution_generation, domain)
    REFERENCES tenant_purge_execution_domains
      (request_id, tenant_id, subject_generation, plan_build_generation,
       execution_generation, domain)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tenant_purge_exec_ack_scheduled
    FOREIGN KEY (request_id, execution_generation, scheduled_ack_sha256)
    REFERENCES tenant_purge_execution_domain_acks
      (request_id, execution_generation, receipt_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tenant_purge_exec_ack_scope CHECK (
    scope = 'tenant-purge-execution-domain-ack-v1'
  ),
  CONSTRAINT chk_tenant_purge_exec_ack_generation CHECK (
    subject_generation > 0 AND plan_build_generation > 0 AND execution_generation > 0
    AND global_ack_seq > 0 AND domain_ack_seq > 0 AND completed_claim_attempt > 0
    AND store_db_timestamp_ms >= 0
  ),
  CONSTRAINT chk_tenant_purge_exec_ack_kind CHECK (
    ack_kind IN ('blocker_resolution','applied','anonymized',
                 'outbox_scheduled','physical_delete')
  ),
  CONSTRAINT chk_tenant_purge_exec_ack_protocol CHECK (
    adapter_protocol REGEXP '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT chk_tenant_purge_exec_ack_outbox CHECK (
    (ack_kind IN ('blocker_resolution','applied','anonymized')
      AND outbox_kind IS NULL AND outbox_id IS NULL AND deletion_generation IS NULL
      AND target_sha256 IS NULL AND scheduled_ack_sha256 IS NULL)
    OR
    (ack_kind = 'outbox_scheduled'
      AND outbox_kind IN ('blob_delete','user_export_delete')
      AND outbox_id IS NOT NULL AND outbox_id > 0
      AND deletion_generation IS NOT NULL AND deletion_generation > 0
      AND target_sha256 IS NOT NULL AND scheduled_ack_sha256 IS NULL AND final = FALSE)
    OR
    (ack_kind = 'physical_delete'
      AND outbox_kind IN ('blob_delete','user_export_delete')
      AND outbox_id IS NOT NULL AND outbox_id > 0
      AND deletion_generation IS NOT NULL AND deletion_generation > 0
      AND target_sha256 IS NOT NULL AND scheduled_ack_sha256 IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT scope, request_id, tenant_id, subject_generation, plan_build_generation,
       execution_generation, domain, global_ack_seq, domain_ack_seq,
       previous_domain_ack_sha256, previous_global_ack_sha256, ack_kind,
       plan_entry_receipt_sha256, affected_count, result_count, result_root_sha256,
       adapter_protocol, operation_sha256, physical_proof_sha256,
       completed_claim_attempt, completed_claim_token_sha256, store_db_timestamp_ms,
       final, outbox_kind, outbox_id, deletion_generation, target_sha256,
       scheduled_ack_sha256, receipt_sha256
  FROM tenant_purge_execution_domain_acks FORCE INDEX (
    PRIMARY, uk_tenant_purge_exec_acks_domain_seq,
    uk_tenant_purge_exec_acks_receipt, uk_tenant_purge_exec_acks_operation,
    uk_tenant_purge_exec_acks_outbox, idx_tenant_purge_exec_acks_domain_fk,
    idx_tenant_purge_exec_acks_scheduled_fk, idx_tenant_purge_exec_acks_owner
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_purge_local_cutover_receipts (
  scope                                   VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_id                              VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                               VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation                      BIGINT UNSIGNED NOT NULL,
  plan_build_generation                   BIGINT UNSIGNED NOT NULL,
  execution_generation                    BIGINT UNSIGNED NOT NULL,
  t3c_receipt_sha256                      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  plan_receipt_sha256                     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  plan_entry_root_sha256                  CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  plan_blocker_count                      BIGINT UNSIGNED NOT NULL,
  plan_blocker_root_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  policy_sha256                           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  purge_not_before_db_ms                  BIGINT NOT NULL,
  source_evidence_db_ms                   BIGINT NOT NULL,
  operational_usage_target_count          BIGINT UNSIGNED NOT NULL,
  operational_usage_target_root_sha256    CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  blob_bytes_target_count                 BIGINT UNSIGNED NOT NULL,
  blob_bytes_target_root_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  blob_delete_outbox_count                BIGINT UNSIGNED NOT NULL,
  blob_delete_outbox_root_sha256          CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  export_bytes_target_count               BIGINT UNSIGNED NOT NULL,
  export_bytes_target_root_sha256         CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  export_delete_outbox_count              BIGINT UNSIGNED NOT NULL,
  export_delete_outbox_root_sha256        CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  domain_ack_count                        BIGINT UNSIGNED NOT NULL,
  domain_ack_root_sha256                  CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  store_db_timestamp_ms                   BIGINT NOT NULL,
  completed_claim_attempt                 INT UNSIGNED NOT NULL,
  completed_claim_token_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  local_destructive_progress              BOOLEAN NOT NULL,
  physical_acks_complete                  BOOLEAN NOT NULL,
  all_domains_complete                    BOOLEAN NOT NULL,
  content_purge_executed                  BOOLEAN NOT NULL,
  receipt_sha256                          CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (request_id),
  UNIQUE KEY uk_tenant_purge_local_cutover_tenant (tenant_id),
  UNIQUE KEY uk_tenant_purge_local_cutover_generation
    (tenant_id, subject_generation, execution_generation),
  UNIQUE KEY uk_tenant_purge_local_cutover_hash (receipt_sha256),
  UNIQUE KEY uk_tenant_purge_local_cutover_request_hash (request_id, receipt_sha256),
  KEY idx_tenant_purge_local_cutover_job_fk
    (request_id, tenant_id, subject_generation, plan_build_generation,
     execution_generation),
  CONSTRAINT fk_tenant_purge_local_cutover_job
    FOREIGN KEY (request_id, tenant_id, subject_generation, plan_build_generation,
                 execution_generation)
    REFERENCES tenant_purge_execution_jobs
      (request_id, tenant_id, subject_generation, plan_build_generation,
       execution_generation)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tenant_purge_local_cutover_scope CHECK (
    scope = 'tenant-purge-local-cutover-v1'
  ),
  CONSTRAINT chk_tenant_purge_local_cutover_generation CHECK (
    subject_generation > 0 AND plan_build_generation > 0 AND execution_generation > 0
  ),
  CONSTRAINT chk_tenant_purge_local_cutover_clock CHECK (
    purge_not_before_db_ms >= 0 AND source_evidence_db_ms >= purge_not_before_db_ms
    AND store_db_timestamp_ms >= source_evidence_db_ms
    AND completed_claim_attempt > 0
  ),
  CONSTRAINT chk_tenant_purge_local_cutover_outbox CHECK (
    blob_delete_outbox_count = blob_bytes_target_count
    AND export_delete_outbox_count = export_bytes_target_count
  ),
  CONSTRAINT chk_tenant_purge_local_cutover_flags CHECK (
    local_destructive_progress = TRUE AND physical_acks_complete = FALSE
    AND all_domains_complete = FALSE AND content_purge_executed = FALSE
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT scope, request_id, tenant_id, subject_generation, plan_build_generation,
       execution_generation, t3c_receipt_sha256, plan_receipt_sha256,
       plan_entry_root_sha256, plan_blocker_count, plan_blocker_root_sha256,
       policy_sha256, purge_not_before_db_ms, source_evidence_db_ms,
       operational_usage_target_count, operational_usage_target_root_sha256,
       blob_bytes_target_count, blob_bytes_target_root_sha256,
       blob_delete_outbox_count, blob_delete_outbox_root_sha256,
       export_bytes_target_count, export_bytes_target_root_sha256,
       export_delete_outbox_count, export_delete_outbox_root_sha256,
       domain_ack_count, domain_ack_root_sha256, store_db_timestamp_ms,
       completed_claim_attempt, completed_claim_token_sha256,
       local_destructive_progress, physical_acks_complete, all_domains_complete,
       content_purge_executed, receipt_sha256
  FROM tenant_purge_local_cutover_receipts FORCE INDEX (
    PRIMARY, uk_tenant_purge_local_cutover_tenant,
    uk_tenant_purge_local_cutover_generation,
    uk_tenant_purge_local_cutover_hash,
    uk_tenant_purge_local_cutover_request_hash,
    idx_tenant_purge_local_cutover_job_fk
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_purge_local_physical_ack_receipts (
  scope                                   VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_id                              VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                               VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation                      BIGINT UNSIGNED NOT NULL,
  plan_build_generation                   BIGINT UNSIGNED NOT NULL,
  execution_generation                    BIGINT UNSIGNED NOT NULL,
  t3c_receipt_sha256                      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  plan_receipt_sha256                     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  plan_entry_root_sha256                  CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  plan_blocker_count                      BIGINT UNSIGNED NOT NULL,
  plan_blocker_root_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  policy_sha256                           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  purge_not_before_db_ms                  BIGINT NOT NULL,
  source_evidence_db_ms                   BIGINT NOT NULL,
  local_cutover_receipt_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  blob_physical_ack_count                 BIGINT UNSIGNED NOT NULL,
  blob_physical_ack_root_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  export_physical_ack_count               BIGINT UNSIGNED NOT NULL,
  export_physical_ack_root_sha256         CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  domain_ack_count                        BIGINT UNSIGNED NOT NULL,
  domain_ack_root_sha256                  CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  unresolved_blocker_count                BIGINT UNSIGNED NOT NULL,
  store_db_timestamp_ms                   BIGINT NOT NULL,
  completed_claim_attempt                 INT UNSIGNED NOT NULL,
  completed_claim_token_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  local_physical_acks_complete            BOOLEAN NOT NULL,
  all_domains_complete                    BOOLEAN NOT NULL,
  content_purge_executed                  BOOLEAN NOT NULL,
  receipt_sha256                          CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (request_id),
  UNIQUE KEY uk_tenant_purge_local_physical_tenant (tenant_id),
  UNIQUE KEY uk_tenant_purge_local_physical_generation
    (tenant_id, subject_generation, execution_generation),
  UNIQUE KEY uk_tenant_purge_local_physical_hash (receipt_sha256),
  KEY idx_tenant_purge_local_physical_job_fk
    (request_id, tenant_id, subject_generation, plan_build_generation,
     execution_generation),
  KEY idx_tenant_purge_local_physical_cutover_fk
    (request_id, local_cutover_receipt_sha256),
  CONSTRAINT fk_tenant_purge_local_physical_job
    FOREIGN KEY (request_id, tenant_id, subject_generation, plan_build_generation,
                 execution_generation)
    REFERENCES tenant_purge_execution_jobs
      (request_id, tenant_id, subject_generation, plan_build_generation,
       execution_generation)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tenant_purge_local_physical_cutover
    FOREIGN KEY (request_id, local_cutover_receipt_sha256)
    REFERENCES tenant_purge_local_cutover_receipts (request_id, receipt_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tenant_purge_local_physical_scope CHECK (
    scope = 'tenant-purge-local-physical-ack-v1'
  ),
  CONSTRAINT chk_tenant_purge_local_physical_generation CHECK (
    subject_generation > 0 AND plan_build_generation > 0 AND execution_generation > 0
  ),
  CONSTRAINT chk_tenant_purge_local_physical_clock CHECK (
    purge_not_before_db_ms >= 0 AND source_evidence_db_ms >= purge_not_before_db_ms
    AND store_db_timestamp_ms >= source_evidence_db_ms
    AND completed_claim_attempt > 0
  ),
  CONSTRAINT chk_tenant_purge_local_physical_blocker CHECK (
    unresolved_blocker_count <= plan_blocker_count
  ),
  CONSTRAINT chk_tenant_purge_local_physical_flags CHECK (
    local_physical_acks_complete = TRUE AND all_domains_complete = FALSE
    AND content_purge_executed = FALSE
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT scope, request_id, tenant_id, subject_generation, plan_build_generation,
       execution_generation, t3c_receipt_sha256, plan_receipt_sha256,
       plan_entry_root_sha256, plan_blocker_count, plan_blocker_root_sha256,
       policy_sha256, purge_not_before_db_ms, source_evidence_db_ms,
       local_cutover_receipt_sha256, blob_physical_ack_count,
       blob_physical_ack_root_sha256, export_physical_ack_count,
       export_physical_ack_root_sha256, domain_ack_count, domain_ack_root_sha256,
       unresolved_blocker_count, store_db_timestamp_ms, completed_claim_attempt,
       completed_claim_token_sha256, local_physical_acks_complete,
       all_domains_complete, content_purge_executed, receipt_sha256
  FROM tenant_purge_local_physical_ack_receipts FORCE INDEX (
    PRIMARY, uk_tenant_purge_local_physical_tenant,
    uk_tenant_purge_local_physical_generation,
    uk_tenant_purge_local_physical_hash,
    idx_tenant_purge_local_physical_job_fk,
    idx_tenant_purge_local_physical_cutover_fk
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_purge_execution_cutover (
  singleton_id          TINYINT UNSIGNED NOT NULL,
  control_generation    BIGINT UNSIGNED NOT NULL,
  activated_at_ms       BIGINT NULL,
  first_request_id      VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  first_receipt_sha256  CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  evidence_sha256       CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  PRIMARY KEY (singleton_id),
  KEY idx_tenant_purge_exec_cutover_receipt_fk
    (first_request_id, first_receipt_sha256),
  CONSTRAINT fk_tenant_purge_execution_cutover_receipt
    FOREIGN KEY (first_request_id, first_receipt_sha256)
    REFERENCES tenant_purge_local_cutover_receipts (request_id, receipt_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tenant_purge_execution_cutover_singleton CHECK (singleton_id = 1),
  CONSTRAINT chk_tenant_purge_execution_cutover_state CHECK (
    (control_generation = 0 AND activated_at_ms IS NULL
      AND first_request_id IS NULL AND first_receipt_sha256 IS NULL
      AND evidence_sha256 IS NULL)
    OR
    (control_generation = 1 AND activated_at_ms IS NOT NULL AND activated_at_ms >= 0
      AND first_request_id IS NOT NULL AND first_receipt_sha256 IS NOT NULL
      AND evidence_sha256 IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT singleton_id, control_generation, activated_at_ms, first_request_id,
       first_receipt_sha256, evidence_sha256
  FROM tenant_purge_execution_cutover FORCE INDEX (
    PRIMARY, idx_tenant_purge_exec_cutover_receipt_fk
  ) WHERE 1=0;

-- CREATE TABLE IF NOT EXISTS is not a schema verifier. Fail closed if marker loss, a partial
-- auto-commit, or privileged drift leaves any same-name table with weaker columns, indexes,
-- CHECKs, foreign keys, metadata, or partitioning than this binary expects.
SET @tenant_purge_execution_schema_ok = (
  (SELECT COUNT(*)=6
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,table_type,
             IFNULL(engine,'-'),IFNULL(table_collation,'-'))
           ORDER BY table_name SEPARATOR '|'),256)
         = '8259cb1a57b8800df0ae7cd64a1d54458dcbc73b2210d89101ce78d65418a325'
     FROM information_schema.tables
    WHERE table_schema=DATABASE()
      AND table_name IN (
        'tenant_purge_execution_jobs','tenant_purge_execution_domains',
        'tenant_purge_execution_domain_acks','tenant_purge_local_cutover_receipts',
        'tenant_purge_local_physical_ack_receipts','tenant_purge_execution_cutover'
      ))
  AND
  (SELECT COUNT(*)=147
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,LPAD(ordinal_position,3,'0'),
             column_name,LOWER(column_type),is_nullable,
             IF(column_default IS NULL,'<NULL>',CONCAT('<',column_default,'>')),
             IFNULL(character_set_name,'-'),IFNULL(collation_name,'-'),
             IFNULL(NULLIF(LOWER(extra),''),'-'),
             IFNULL(NULLIF(LOWER(generation_expression),''),'-'))
           ORDER BY table_name,ordinal_position SEPARATOR '|'),256)
         = 'b3bcf5d43a329dbef4720e1b42907d1667c237898646f63a7fcfde199f6889de'
     FROM information_schema.columns
    WHERE table_schema=DATABASE()
      AND table_name IN (
        'tenant_purge_execution_jobs','tenant_purge_execution_domains',
        'tenant_purge_execution_domain_acks','tenant_purge_local_cutover_receipts',
        'tenant_purge_local_physical_ack_receipts','tenant_purge_execution_cutover'
      ))
  AND
  (SELECT COUNT(DISTINCT CONCAT(table_name,'~',index_name))=32 AND COUNT(*)=95
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,index_name,non_unique,
             seq_in_index,LOWER(index_type),LOWER(is_visible),
             IFNULL(column_name,'<expression>'),IFNULL(CAST(sub_part AS CHAR),'-'),
             LOWER(IFNULL(collation,'-')),IFNULL(expression,'-'))
           ORDER BY table_name,index_name,seq_in_index SEPARATOR '|'),256)
         = '26a7110f4678c928f65c201e576b2e27120e831cf7a33d98a00634f6372554ee'
     FROM information_schema.statistics
    WHERE table_schema=DATABASE()
      AND table_name IN (
        'tenant_purge_execution_jobs','tenant_purge_execution_domains',
        'tenant_purge_execution_domain_acks','tenant_purge_local_cutover_receipts',
        'tenant_purge_local_physical_ack_receipts','tenant_purge_execution_cutover'
      ))
  AND
  (SELECT COUNT(*)=26
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',tc.table_name,tc.constraint_name,tc.enforced,
             LOWER(REPLACE(REPLACE(REGEXP_REPLACE(cc.check_clause,'[[:space:]]',''),
               CHAR(96),''),'_utf8mb4','')))
           ORDER BY tc.table_name,tc.constraint_name SEPARATOR '|'),256)
         = 'd78c5ea7cb3b2d24142e5213f625e50ac87a477f2abca5d194eda4ee358bdcdb'
     FROM information_schema.table_constraints tc
     JOIN information_schema.check_constraints cc
       ON cc.constraint_schema=tc.constraint_schema
      AND cc.constraint_name=tc.constraint_name
    WHERE tc.table_schema=DATABASE() AND tc.constraint_type='CHECK'
      AND tc.table_name IN (
        'tenant_purge_execution_jobs','tenant_purge_execution_domains',
        'tenant_purge_execution_domain_acks','tenant_purge_local_cutover_receipts',
        'tenant_purge_local_physical_ack_receipts','tenant_purge_execution_cutover'
      ))
  AND
  (SELECT COUNT(*)=58
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,
             constraint_type,enforced)
           ORDER BY table_name,constraint_name SEPARATOR '|'),256)
         = 'a35f73cbee59c5bcf0a86972c4d2b5981d74a943815c98b6ae173c1251253423'
     FROM information_schema.table_constraints
    WHERE table_schema=DATABASE()
      AND table_name IN (
        'tenant_purge_execution_jobs','tenant_purge_execution_domains',
        'tenant_purge_execution_domain_acks','tenant_purge_local_cutover_receipts',
        'tenant_purge_local_physical_ack_receipts','tenant_purge_execution_cutover'
      ))
  AND
  (SELECT COUNT(*)=33
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',k.table_name,k.constraint_name,
             k.ordinal_position,k.column_name,k.referenced_table_name,
             k.referenced_column_name,r.update_rule,r.delete_rule)
           ORDER BY k.table_name,k.constraint_name,k.ordinal_position SEPARATOR '|'),256)
         = '0871c39a618ea4df69199ddb3c15e51e618670d3b9e9dcfb062b2e93d34d06b2'
     FROM information_schema.key_column_usage k
     JOIN information_schema.referential_constraints r
       ON r.constraint_schema=k.constraint_schema
      AND r.constraint_name=k.constraint_name
    WHERE k.table_schema=DATABASE() AND k.referenced_table_name IS NOT NULL
      AND k.table_name IN (
        'tenant_purge_execution_jobs','tenant_purge_execution_domains',
        'tenant_purge_execution_domain_acks','tenant_purge_local_cutover_receipts',
        'tenant_purge_local_physical_ack_receipts','tenant_purge_execution_cutover'
      ))
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.partitions
     WHERE table_schema=DATABASE() AND partition_name IS NOT NULL
       AND table_name IN (
         'tenant_purge_execution_jobs','tenant_purge_execution_domains',
         'tenant_purge_execution_domain_acks','tenant_purge_local_cutover_receipts',
         'tenant_purge_local_physical_ack_receipts','tenant_purge_execution_cutover'
       )
  )
);
SET @migration_sql = IF(@tenant_purge_execution_schema_ok=1, 'SELECT 1',
  'SELECT 1 FROM __invalid_tenant_purge_execution_schema__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

INSERT INTO tenant_purge_execution_cutover
  (singleton_id, control_generation, activated_at_ms, first_request_id,
   first_receipt_sha256, evidence_sha256)
SELECT 1, 0, NULL, NULL, NULL, NULL
 WHERE NOT EXISTS (
   SELECT 1 FROM tenant_purge_execution_cutover WHERE singleton_id = 1
 );

-- Job source identity is immutable. Only a queued claimed worker may publish monotonic ACK
-- progress, set the one-way local-cutover hash, retry, seal local physical ACKs, or block.
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_jobs_bu_bootstrap;
CREATE TRIGGER trg_tenant_purge_exec_jobs_bu_bootstrap BEFORE UPDATE ON tenant_purge_execution_jobs FOR EACH ROW BEGIN IF NOT (OLD.request_id <=> NEW.request_id AND OLD.tenant_id <=> NEW.tenant_id AND OLD.subject_generation <=> NEW.subject_generation AND OLD.plan_build_generation <=> NEW.plan_build_generation AND OLD.execution_generation <=> NEW.execution_generation AND OLD.t3c_receipt_sha256 <=> NEW.t3c_receipt_sha256 AND OLD.plan_receipt_sha256 <=> NEW.plan_receipt_sha256 AND OLD.plan_entry_root_sha256 <=> NEW.plan_entry_root_sha256 AND OLD.plan_blocker_count <=> NEW.plan_blocker_count AND OLD.plan_blocker_root_sha256 <=> NEW.plan_blocker_root_sha256 AND OLD.policy_sha256 <=> NEW.policy_sha256 AND OLD.purge_not_before_db_ms <=> NEW.purge_not_before_db_ms AND OLD.source_evidence_db_ms <=> NEW.source_evidence_db_ms AND OLD.domain_count <=> NEW.domain_count AND OLD.created_at_ms <=> NEW.created_at_ms AND OLD.phase='queued' AND NEW.updated_at_ms>=OLD.updated_at_ms AND NEW.attempts>=OLD.attempts AND NEW.attempts<=OLD.attempts+1 AND NEW.domain_ack_count>=OLD.domain_ack_count AND ((NEW.domain_ack_count=OLD.domain_ack_count AND NEW.domain_ack_root_sha256 <=> OLD.domain_ack_root_sha256) OR (NEW.domain_ack_count>OLD.domain_ack_count AND NOT (NEW.domain_ack_root_sha256 <=> OLD.domain_ack_root_sha256))) AND NEW.unresolved_blocker_count<=OLD.unresolved_blocker_count AND (OLD.local_cutover_receipt_sha256 IS NULL OR NEW.local_cutover_receipt_sha256 <=> OLD.local_cutover_receipt_sha256) AND ((NEW.phase='queued' AND ((OLD.claim_token IS NULL AND NEW.claim_token IS NOT NULL AND NEW.attempts=OLD.attempts+1 AND NEW.available_at_ms <=> OLD.available_at_ms AND NEW.domain_ack_count=OLD.domain_ack_count AND NEW.unresolved_blocker_count=OLD.unresolved_blocker_count AND NEW.local_cutover_receipt_sha256 <=> OLD.local_cutover_receipt_sha256) OR (OLD.claim_token IS NOT NULL AND NEW.claim_token <=> OLD.claim_token AND NEW.attempts=OLD.attempts AND NEW.available_at_ms <=> OLD.available_at_ms AND NEW.lease_until_ms>=OLD.lease_until_ms) OR (OLD.claim_token IS NOT NULL AND NEW.claim_token IS NULL AND NEW.attempts=OLD.attempts AND NEW.available_at_ms>=OLD.available_at_ms AND NEW.available_at_ms>=NEW.updated_at_ms))) OR (NEW.phase IN ('local_physical_acks_sealed','blocked') AND OLD.claim_token IS NOT NULL AND NEW.attempts=OLD.attempts))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution job update is not permitted'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_jobs_bu;
CREATE TRIGGER trg_tenant_purge_exec_jobs_bu BEFORE UPDATE ON tenant_purge_execution_jobs FOR EACH ROW BEGIN IF NOT (OLD.request_id <=> NEW.request_id AND OLD.tenant_id <=> NEW.tenant_id AND OLD.subject_generation <=> NEW.subject_generation AND OLD.plan_build_generation <=> NEW.plan_build_generation AND OLD.execution_generation <=> NEW.execution_generation AND OLD.t3c_receipt_sha256 <=> NEW.t3c_receipt_sha256 AND OLD.plan_receipt_sha256 <=> NEW.plan_receipt_sha256 AND OLD.plan_entry_root_sha256 <=> NEW.plan_entry_root_sha256 AND OLD.plan_blocker_count <=> NEW.plan_blocker_count AND OLD.plan_blocker_root_sha256 <=> NEW.plan_blocker_root_sha256 AND OLD.policy_sha256 <=> NEW.policy_sha256 AND OLD.purge_not_before_db_ms <=> NEW.purge_not_before_db_ms AND OLD.source_evidence_db_ms <=> NEW.source_evidence_db_ms AND OLD.domain_count <=> NEW.domain_count AND OLD.created_at_ms <=> NEW.created_at_ms AND OLD.phase='queued' AND NEW.updated_at_ms>=OLD.updated_at_ms AND NEW.attempts>=OLD.attempts AND NEW.attempts<=OLD.attempts+1 AND NEW.domain_ack_count>=OLD.domain_ack_count AND ((NEW.domain_ack_count=OLD.domain_ack_count AND NEW.domain_ack_root_sha256 <=> OLD.domain_ack_root_sha256) OR (NEW.domain_ack_count>OLD.domain_ack_count AND NOT (NEW.domain_ack_root_sha256 <=> OLD.domain_ack_root_sha256))) AND NEW.unresolved_blocker_count<=OLD.unresolved_blocker_count AND (OLD.local_cutover_receipt_sha256 IS NULL OR NEW.local_cutover_receipt_sha256 <=> OLD.local_cutover_receipt_sha256) AND ((NEW.phase='queued' AND ((OLD.claim_token IS NULL AND NEW.claim_token IS NOT NULL AND NEW.attempts=OLD.attempts+1 AND NEW.available_at_ms <=> OLD.available_at_ms AND NEW.domain_ack_count=OLD.domain_ack_count AND NEW.unresolved_blocker_count=OLD.unresolved_blocker_count AND NEW.local_cutover_receipt_sha256 <=> OLD.local_cutover_receipt_sha256) OR (OLD.claim_token IS NOT NULL AND NEW.claim_token <=> OLD.claim_token AND NEW.attempts=OLD.attempts AND NEW.available_at_ms <=> OLD.available_at_ms AND NEW.lease_until_ms>=OLD.lease_until_ms) OR (OLD.claim_token IS NOT NULL AND NEW.claim_token IS NULL AND NEW.attempts=OLD.attempts AND NEW.available_at_ms>=OLD.available_at_ms AND NEW.available_at_ms>=NEW.updated_at_ms))) OR (NEW.phase IN ('local_physical_acks_sealed','blocked') AND OLD.claim_token IS NOT NULL AND NEW.attempts=OLD.attempts))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution job update is not permitted'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_jobs_bu_guard_a;
CREATE TRIGGER trg_tenant_purge_exec_jobs_bu_guard_a BEFORE UPDATE ON tenant_purge_execution_jobs FOR EACH ROW BEGIN IF NOT (OLD.request_id <=> NEW.request_id AND OLD.tenant_id <=> NEW.tenant_id AND OLD.subject_generation <=> NEW.subject_generation AND OLD.plan_build_generation <=> NEW.plan_build_generation AND OLD.execution_generation <=> NEW.execution_generation AND OLD.t3c_receipt_sha256 <=> NEW.t3c_receipt_sha256 AND OLD.plan_receipt_sha256 <=> NEW.plan_receipt_sha256 AND OLD.plan_entry_root_sha256 <=> NEW.plan_entry_root_sha256 AND OLD.plan_blocker_count <=> NEW.plan_blocker_count AND OLD.plan_blocker_root_sha256 <=> NEW.plan_blocker_root_sha256 AND OLD.policy_sha256 <=> NEW.policy_sha256 AND OLD.purge_not_before_db_ms <=> NEW.purge_not_before_db_ms AND OLD.source_evidence_db_ms <=> NEW.source_evidence_db_ms AND OLD.domain_count <=> NEW.domain_count AND OLD.created_at_ms <=> NEW.created_at_ms AND OLD.phase='queued' AND NEW.updated_at_ms>=OLD.updated_at_ms AND NEW.attempts>=OLD.attempts AND NEW.attempts<=OLD.attempts+1 AND NEW.domain_ack_count>=OLD.domain_ack_count AND ((NEW.domain_ack_count=OLD.domain_ack_count AND NEW.domain_ack_root_sha256 <=> OLD.domain_ack_root_sha256) OR (NEW.domain_ack_count>OLD.domain_ack_count AND NOT (NEW.domain_ack_root_sha256 <=> OLD.domain_ack_root_sha256))) AND NEW.unresolved_blocker_count<=OLD.unresolved_blocker_count AND (OLD.local_cutover_receipt_sha256 IS NULL OR NEW.local_cutover_receipt_sha256 <=> OLD.local_cutover_receipt_sha256) AND ((NEW.phase='queued' AND ((OLD.claim_token IS NULL AND NEW.claim_token IS NOT NULL AND NEW.attempts=OLD.attempts+1 AND NEW.available_at_ms <=> OLD.available_at_ms AND NEW.domain_ack_count=OLD.domain_ack_count AND NEW.unresolved_blocker_count=OLD.unresolved_blocker_count AND NEW.local_cutover_receipt_sha256 <=> OLD.local_cutover_receipt_sha256) OR (OLD.claim_token IS NOT NULL AND NEW.claim_token <=> OLD.claim_token AND NEW.attempts=OLD.attempts AND NEW.available_at_ms <=> OLD.available_at_ms AND NEW.lease_until_ms>=OLD.lease_until_ms) OR (OLD.claim_token IS NOT NULL AND NEW.claim_token IS NULL AND NEW.attempts=OLD.attempts AND NEW.available_at_ms>=OLD.available_at_ms AND NEW.available_at_ms>=NEW.updated_at_ms))) OR (NEW.phase IN ('local_physical_acks_sealed','blocked') AND OLD.claim_token IS NOT NULL AND NEW.attempts=OLD.attempts))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution job update is not permitted'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_jobs_bu_guard_b;
CREATE TRIGGER trg_tenant_purge_exec_jobs_bu_guard_b BEFORE UPDATE ON tenant_purge_execution_jobs FOR EACH ROW BEGIN IF NOT (OLD.request_id <=> NEW.request_id AND OLD.tenant_id <=> NEW.tenant_id AND OLD.subject_generation <=> NEW.subject_generation AND OLD.plan_build_generation <=> NEW.plan_build_generation AND OLD.execution_generation <=> NEW.execution_generation AND OLD.t3c_receipt_sha256 <=> NEW.t3c_receipt_sha256 AND OLD.plan_receipt_sha256 <=> NEW.plan_receipt_sha256 AND OLD.plan_entry_root_sha256 <=> NEW.plan_entry_root_sha256 AND OLD.plan_blocker_count <=> NEW.plan_blocker_count AND OLD.plan_blocker_root_sha256 <=> NEW.plan_blocker_root_sha256 AND OLD.policy_sha256 <=> NEW.policy_sha256 AND OLD.purge_not_before_db_ms <=> NEW.purge_not_before_db_ms AND OLD.source_evidence_db_ms <=> NEW.source_evidence_db_ms AND OLD.domain_count <=> NEW.domain_count AND OLD.created_at_ms <=> NEW.created_at_ms AND OLD.phase='queued' AND NEW.updated_at_ms>=OLD.updated_at_ms AND NEW.attempts>=OLD.attempts AND NEW.attempts<=OLD.attempts+1 AND NEW.domain_ack_count>=OLD.domain_ack_count AND ((NEW.domain_ack_count=OLD.domain_ack_count AND NEW.domain_ack_root_sha256 <=> OLD.domain_ack_root_sha256) OR (NEW.domain_ack_count>OLD.domain_ack_count AND NOT (NEW.domain_ack_root_sha256 <=> OLD.domain_ack_root_sha256))) AND NEW.unresolved_blocker_count<=OLD.unresolved_blocker_count AND (OLD.local_cutover_receipt_sha256 IS NULL OR NEW.local_cutover_receipt_sha256 <=> OLD.local_cutover_receipt_sha256) AND ((NEW.phase='queued' AND ((OLD.claim_token IS NULL AND NEW.claim_token IS NOT NULL AND NEW.attempts=OLD.attempts+1 AND NEW.available_at_ms <=> OLD.available_at_ms AND NEW.domain_ack_count=OLD.domain_ack_count AND NEW.unresolved_blocker_count=OLD.unresolved_blocker_count AND NEW.local_cutover_receipt_sha256 <=> OLD.local_cutover_receipt_sha256) OR (OLD.claim_token IS NOT NULL AND NEW.claim_token <=> OLD.claim_token AND NEW.attempts=OLD.attempts AND NEW.available_at_ms <=> OLD.available_at_ms AND NEW.lease_until_ms>=OLD.lease_until_ms) OR (OLD.claim_token IS NOT NULL AND NEW.claim_token IS NULL AND NEW.attempts=OLD.attempts AND NEW.available_at_ms>=OLD.available_at_ms AND NEW.available_at_ms>=NEW.updated_at_ms))) OR (NEW.phase IN ('local_physical_acks_sealed','blocked') AND OLD.claim_token IS NOT NULL AND NEW.attempts=OLD.attempts))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution job update is not permitted'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_jobs_bu_bootstrap;

DROP TRIGGER IF EXISTS trg_tenant_purge_exec_jobs_bd_bootstrap;
CREATE TRIGGER trg_tenant_purge_exec_jobs_bd_bootstrap BEFORE DELETE ON tenant_purge_execution_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution jobs cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_jobs_bd;
CREATE TRIGGER trg_tenant_purge_exec_jobs_bd BEFORE DELETE ON tenant_purge_execution_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution jobs cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_jobs_bd_guard_a;
CREATE TRIGGER trg_tenant_purge_exec_jobs_bd_guard_a BEFORE DELETE ON tenant_purge_execution_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution jobs cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_jobs_bd_guard_b;
CREATE TRIGGER trg_tenant_purge_exec_jobs_bd_guard_b BEFORE DELETE ON tenant_purge_execution_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution jobs cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_jobs_bd_bootstrap;

-- Domain source coordinates never change. Progress is a monotonic exact ACK chain; acked rows are
-- terminal and may not be rewritten even if a later adapter or policy version appears.
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_domains_bu_bootstrap;
CREATE TRIGGER trg_tenant_purge_exec_domains_bu_bootstrap BEFORE UPDATE ON tenant_purge_execution_domains FOR EACH ROW BEGIN IF NOT (OLD.request_id <=> NEW.request_id AND OLD.tenant_id <=> NEW.tenant_id AND OLD.subject_generation <=> NEW.subject_generation AND OLD.plan_build_generation <=> NEW.plan_build_generation AND OLD.execution_generation <=> NEW.execution_generation AND OLD.domain <=> NEW.domain AND OLD.execution_ordinal <=> NEW.execution_ordinal AND OLD.plan_disposition <=> NEW.plan_disposition AND OLD.plan_target_count <=> NEW.plan_target_count AND OLD.plan_target_root_sha256 <=> NEW.plan_target_root_sha256 AND OLD.plan_source_sha256 <=> NEW.plan_source_sha256 AND OLD.plan_entry_receipt_sha256 <=> NEW.plan_entry_receipt_sha256 AND OLD.phase<>'acked' AND NEW.updated_at_ms>=OLD.updated_at_ms AND NEW.ack_count>=OLD.ack_count AND ((NEW.ack_count=OLD.ack_count AND NEW.ack_root_sha256 <=> OLD.ack_root_sha256) OR (NEW.ack_count>OLD.ack_count AND NOT (NEW.ack_root_sha256 <=> OLD.ack_root_sha256))) AND ((OLD.phase='pending' AND NEW.phase IN ('pending','awaiting_physical_ack','acked')) OR (OLD.phase='awaiting_blocker_resolution' AND NEW.phase IN ('awaiting_blocker_resolution','pending','awaiting_physical_ack','acked')) OR (OLD.phase='awaiting_physical_ack' AND NEW.phase IN ('awaiting_physical_ack','acked')))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution domain update is not permitted'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_domains_bu;
CREATE TRIGGER trg_tenant_purge_exec_domains_bu BEFORE UPDATE ON tenant_purge_execution_domains FOR EACH ROW BEGIN IF NOT (OLD.request_id <=> NEW.request_id AND OLD.tenant_id <=> NEW.tenant_id AND OLD.subject_generation <=> NEW.subject_generation AND OLD.plan_build_generation <=> NEW.plan_build_generation AND OLD.execution_generation <=> NEW.execution_generation AND OLD.domain <=> NEW.domain AND OLD.execution_ordinal <=> NEW.execution_ordinal AND OLD.plan_disposition <=> NEW.plan_disposition AND OLD.plan_target_count <=> NEW.plan_target_count AND OLD.plan_target_root_sha256 <=> NEW.plan_target_root_sha256 AND OLD.plan_source_sha256 <=> NEW.plan_source_sha256 AND OLD.plan_entry_receipt_sha256 <=> NEW.plan_entry_receipt_sha256 AND OLD.phase<>'acked' AND NEW.updated_at_ms>=OLD.updated_at_ms AND NEW.ack_count>=OLD.ack_count AND ((NEW.ack_count=OLD.ack_count AND NEW.ack_root_sha256 <=> OLD.ack_root_sha256) OR (NEW.ack_count>OLD.ack_count AND NOT (NEW.ack_root_sha256 <=> OLD.ack_root_sha256))) AND ((OLD.phase='pending' AND NEW.phase IN ('pending','awaiting_physical_ack','acked')) OR (OLD.phase='awaiting_blocker_resolution' AND NEW.phase IN ('awaiting_blocker_resolution','pending','awaiting_physical_ack','acked')) OR (OLD.phase='awaiting_physical_ack' AND NEW.phase IN ('awaiting_physical_ack','acked')))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution domain update is not permitted'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_domains_bu_guard_a;
CREATE TRIGGER trg_tenant_purge_exec_domains_bu_guard_a BEFORE UPDATE ON tenant_purge_execution_domains FOR EACH ROW BEGIN IF NOT (OLD.request_id <=> NEW.request_id AND OLD.tenant_id <=> NEW.tenant_id AND OLD.subject_generation <=> NEW.subject_generation AND OLD.plan_build_generation <=> NEW.plan_build_generation AND OLD.execution_generation <=> NEW.execution_generation AND OLD.domain <=> NEW.domain AND OLD.execution_ordinal <=> NEW.execution_ordinal AND OLD.plan_disposition <=> NEW.plan_disposition AND OLD.plan_target_count <=> NEW.plan_target_count AND OLD.plan_target_root_sha256 <=> NEW.plan_target_root_sha256 AND OLD.plan_source_sha256 <=> NEW.plan_source_sha256 AND OLD.plan_entry_receipt_sha256 <=> NEW.plan_entry_receipt_sha256 AND OLD.phase<>'acked' AND NEW.updated_at_ms>=OLD.updated_at_ms AND NEW.ack_count>=OLD.ack_count AND ((NEW.ack_count=OLD.ack_count AND NEW.ack_root_sha256 <=> OLD.ack_root_sha256) OR (NEW.ack_count>OLD.ack_count AND NOT (NEW.ack_root_sha256 <=> OLD.ack_root_sha256))) AND ((OLD.phase='pending' AND NEW.phase IN ('pending','awaiting_physical_ack','acked')) OR (OLD.phase='awaiting_blocker_resolution' AND NEW.phase IN ('awaiting_blocker_resolution','pending','awaiting_physical_ack','acked')) OR (OLD.phase='awaiting_physical_ack' AND NEW.phase IN ('awaiting_physical_ack','acked')))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution domain update is not permitted'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_domains_bu_guard_b;
CREATE TRIGGER trg_tenant_purge_exec_domains_bu_guard_b BEFORE UPDATE ON tenant_purge_execution_domains FOR EACH ROW BEGIN IF NOT (OLD.request_id <=> NEW.request_id AND OLD.tenant_id <=> NEW.tenant_id AND OLD.subject_generation <=> NEW.subject_generation AND OLD.plan_build_generation <=> NEW.plan_build_generation AND OLD.execution_generation <=> NEW.execution_generation AND OLD.domain <=> NEW.domain AND OLD.execution_ordinal <=> NEW.execution_ordinal AND OLD.plan_disposition <=> NEW.plan_disposition AND OLD.plan_target_count <=> NEW.plan_target_count AND OLD.plan_target_root_sha256 <=> NEW.plan_target_root_sha256 AND OLD.plan_source_sha256 <=> NEW.plan_source_sha256 AND OLD.plan_entry_receipt_sha256 <=> NEW.plan_entry_receipt_sha256 AND OLD.phase<>'acked' AND NEW.updated_at_ms>=OLD.updated_at_ms AND NEW.ack_count>=OLD.ack_count AND ((NEW.ack_count=OLD.ack_count AND NEW.ack_root_sha256 <=> OLD.ack_root_sha256) OR (NEW.ack_count>OLD.ack_count AND NOT (NEW.ack_root_sha256 <=> OLD.ack_root_sha256))) AND ((OLD.phase='pending' AND NEW.phase IN ('pending','awaiting_physical_ack','acked')) OR (OLD.phase='awaiting_blocker_resolution' AND NEW.phase IN ('awaiting_blocker_resolution','pending','awaiting_physical_ack','acked')) OR (OLD.phase='awaiting_physical_ack' AND NEW.phase IN ('awaiting_physical_ack','acked')))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution domain update is not permitted'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_domains_bu_bootstrap;

DROP TRIGGER IF EXISTS trg_tenant_purge_exec_domains_bd_bootstrap;

-- Global destructive cutover is inactive after expand and permits one transition only. Its first
-- receipt FK prevents activation with an invented or cross-request hash.
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_cutover_bu_bootstrap;
CREATE TRIGGER trg_tenant_purge_exec_cutover_bu_bootstrap BEFORE UPDATE ON tenant_purge_execution_cutover FOR EACH ROW BEGIN IF NOT (OLD.singleton_id=1 AND NEW.singleton_id=1 AND OLD.control_generation=0 AND OLD.activated_at_ms IS NULL AND OLD.first_request_id IS NULL AND OLD.first_receipt_sha256 IS NULL AND OLD.evidence_sha256 IS NULL AND NEW.control_generation=1 AND NEW.activated_at_ms IS NOT NULL AND NEW.first_request_id IS NOT NULL AND NEW.first_receipt_sha256 IS NOT NULL AND NEW.evidence_sha256 IS NOT NULL) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution cutover is write-once'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_cutover_bu;
CREATE TRIGGER trg_tenant_purge_exec_cutover_bu BEFORE UPDATE ON tenant_purge_execution_cutover FOR EACH ROW BEGIN IF NOT (OLD.singleton_id=1 AND NEW.singleton_id=1 AND OLD.control_generation=0 AND OLD.activated_at_ms IS NULL AND OLD.first_request_id IS NULL AND OLD.first_receipt_sha256 IS NULL AND OLD.evidence_sha256 IS NULL AND NEW.control_generation=1 AND NEW.activated_at_ms IS NOT NULL AND NEW.first_request_id IS NOT NULL AND NEW.first_receipt_sha256 IS NOT NULL AND NEW.evidence_sha256 IS NOT NULL) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution cutover is write-once'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_cutover_bu_guard_a;
CREATE TRIGGER trg_tenant_purge_exec_cutover_bu_guard_a BEFORE UPDATE ON tenant_purge_execution_cutover FOR EACH ROW BEGIN IF NOT (OLD.singleton_id=1 AND NEW.singleton_id=1 AND OLD.control_generation=0 AND OLD.activated_at_ms IS NULL AND OLD.first_request_id IS NULL AND OLD.first_receipt_sha256 IS NULL AND OLD.evidence_sha256 IS NULL AND NEW.control_generation=1 AND NEW.activated_at_ms IS NOT NULL AND NEW.first_request_id IS NOT NULL AND NEW.first_receipt_sha256 IS NOT NULL AND NEW.evidence_sha256 IS NOT NULL) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution cutover is write-once'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_cutover_bu_guard_b;
CREATE TRIGGER trg_tenant_purge_exec_cutover_bu_guard_b BEFORE UPDATE ON tenant_purge_execution_cutover FOR EACH ROW BEGIN IF NOT (OLD.singleton_id=1 AND NEW.singleton_id=1 AND OLD.control_generation=0 AND OLD.activated_at_ms IS NULL AND OLD.first_request_id IS NULL AND OLD.first_receipt_sha256 IS NULL AND OLD.evidence_sha256 IS NULL AND NEW.control_generation=1 AND NEW.activated_at_ms IS NOT NULL AND NEW.first_request_id IS NOT NULL AND NEW.first_receipt_sha256 IS NOT NULL AND NEW.evidence_sha256 IS NOT NULL) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution cutover is write-once'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_cutover_bu_bootstrap;

DROP TRIGGER IF EXISTS trg_tenant_purge_exec_cutover_bd_bootstrap;
CREATE TRIGGER trg_tenant_purge_exec_cutover_bd_bootstrap BEFORE DELETE ON tenant_purge_execution_cutover FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution cutover cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_cutover_bd;
CREATE TRIGGER trg_tenant_purge_exec_cutover_bd BEFORE DELETE ON tenant_purge_execution_cutover FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution cutover cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_cutover_bd_guard_a;
CREATE TRIGGER trg_tenant_purge_exec_cutover_bd_guard_a BEFORE DELETE ON tenant_purge_execution_cutover FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution cutover cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_cutover_bd_guard_b;
CREATE TRIGGER trg_tenant_purge_exec_cutover_bd_guard_b BEFORE DELETE ON tenant_purge_execution_cutover FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution cutover cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_cutover_bd_bootstrap;

-- tenant_purge_execution_domain_acks is permanent content-free evidence.
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_acks_bu_bootstrap;
CREATE TRIGGER trg_tenant_purge_exec_acks_bu_bootstrap BEFORE UPDATE ON tenant_purge_execution_domain_acks FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution domain ACKs are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_acks_bu;
CREATE TRIGGER trg_tenant_purge_exec_acks_bu BEFORE UPDATE ON tenant_purge_execution_domain_acks FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution domain ACKs are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_acks_bu_guard_a;
CREATE TRIGGER trg_tenant_purge_exec_acks_bu_guard_a BEFORE UPDATE ON tenant_purge_execution_domain_acks FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution domain ACKs are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_acks_bu_guard_b;
CREATE TRIGGER trg_tenant_purge_exec_acks_bu_guard_b BEFORE UPDATE ON tenant_purge_execution_domain_acks FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution domain ACKs are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_acks_bu_bootstrap;

DROP TRIGGER IF EXISTS trg_tenant_purge_exec_acks_bd_bootstrap;
CREATE TRIGGER trg_tenant_purge_exec_acks_bd_bootstrap BEFORE DELETE ON tenant_purge_execution_domain_acks FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution domain ACKs are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_acks_bd;
CREATE TRIGGER trg_tenant_purge_exec_acks_bd BEFORE DELETE ON tenant_purge_execution_domain_acks FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution domain ACKs are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_acks_bd_guard_a;
CREATE TRIGGER trg_tenant_purge_exec_acks_bd_guard_a BEFORE DELETE ON tenant_purge_execution_domain_acks FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution domain ACKs are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_acks_bd_guard_b;
CREATE TRIGGER trg_tenant_purge_exec_acks_bd_guard_b BEFORE DELETE ON tenant_purge_execution_domain_acks FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution domain ACKs are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_acks_bd_bootstrap;

-- tenant_purge_local_cutover_receipts is permanent content-free evidence.
DROP TRIGGER IF EXISTS trg_tenant_purge_local_cutover_bu_bootstrap;
CREATE TRIGGER trg_tenant_purge_local_cutover_bu_bootstrap BEFORE UPDATE ON tenant_purge_local_cutover_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge local cutover receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_local_cutover_bu;
CREATE TRIGGER trg_tenant_purge_local_cutover_bu BEFORE UPDATE ON tenant_purge_local_cutover_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge local cutover receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_local_cutover_bu_guard_a;
CREATE TRIGGER trg_tenant_purge_local_cutover_bu_guard_a BEFORE UPDATE ON tenant_purge_local_cutover_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge local cutover receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_local_cutover_bu_guard_b;
CREATE TRIGGER trg_tenant_purge_local_cutover_bu_guard_b BEFORE UPDATE ON tenant_purge_local_cutover_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge local cutover receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_local_cutover_bu_bootstrap;

DROP TRIGGER IF EXISTS trg_tenant_purge_local_cutover_bd_bootstrap;
CREATE TRIGGER trg_tenant_purge_local_cutover_bd_bootstrap BEFORE DELETE ON tenant_purge_local_cutover_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge local cutover receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_local_cutover_bd;
CREATE TRIGGER trg_tenant_purge_local_cutover_bd BEFORE DELETE ON tenant_purge_local_cutover_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge local cutover receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_local_cutover_bd_guard_a;
CREATE TRIGGER trg_tenant_purge_local_cutover_bd_guard_a BEFORE DELETE ON tenant_purge_local_cutover_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge local cutover receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_local_cutover_bd_guard_b;
CREATE TRIGGER trg_tenant_purge_local_cutover_bd_guard_b BEFORE DELETE ON tenant_purge_local_cutover_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge local cutover receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_local_cutover_bd_bootstrap;

-- tenant_purge_local_physical_ack_receipts is permanent content-free evidence.
DROP TRIGGER IF EXISTS trg_tenant_purge_local_physical_bu_bootstrap;
CREATE TRIGGER trg_tenant_purge_local_physical_bu_bootstrap BEFORE UPDATE ON tenant_purge_local_physical_ack_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge local physical ACK receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_local_physical_bu;
CREATE TRIGGER trg_tenant_purge_local_physical_bu BEFORE UPDATE ON tenant_purge_local_physical_ack_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge local physical ACK receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_local_physical_bu_guard_a;
CREATE TRIGGER trg_tenant_purge_local_physical_bu_guard_a BEFORE UPDATE ON tenant_purge_local_physical_ack_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge local physical ACK receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_local_physical_bu_guard_b;
CREATE TRIGGER trg_tenant_purge_local_physical_bu_guard_b BEFORE UPDATE ON tenant_purge_local_physical_ack_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge local physical ACK receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_local_physical_bu_bootstrap;

DROP TRIGGER IF EXISTS trg_tenant_purge_local_physical_bd_bootstrap;
CREATE TRIGGER trg_tenant_purge_local_physical_bd_bootstrap BEFORE DELETE ON tenant_purge_local_physical_ack_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge local physical ACK receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_local_physical_bd;
CREATE TRIGGER trg_tenant_purge_local_physical_bd BEFORE DELETE ON tenant_purge_local_physical_ack_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge local physical ACK receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_local_physical_bd_guard_a;
CREATE TRIGGER trg_tenant_purge_local_physical_bd_guard_a BEFORE DELETE ON tenant_purge_local_physical_ack_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge local physical ACK receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_local_physical_bd_guard_b;
CREATE TRIGGER trg_tenant_purge_local_physical_bd_guard_b BEFORE DELETE ON tenant_purge_local_physical_ack_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge local physical ACK receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_local_physical_bd_bootstrap;


CREATE TRIGGER trg_tenant_purge_exec_domains_bd_bootstrap BEFORE DELETE ON tenant_purge_execution_domains FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution domains cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_domains_bd;
CREATE TRIGGER trg_tenant_purge_exec_domains_bd BEFORE DELETE ON tenant_purge_execution_domains FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution domains cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_domains_bd_guard_a;
CREATE TRIGGER trg_tenant_purge_exec_domains_bd_guard_a BEFORE DELETE ON tenant_purge_execution_domains FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution domains cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_domains_bd_guard_b;
CREATE TRIGGER trg_tenant_purge_exec_domains_bd_guard_b BEFORE DELETE ON tenant_purge_execution_domains FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution domains cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_purge_exec_domains_bd_bootstrap;

-- Reject missing/extra triggers and body drift. Every expected body above is recreated before
-- this probe, so marker-loss replay repairs a same-name body before it can receive a new marker.
SET @tenant_purge_execution_trigger_set_ok = (
  SELECT COUNT(*)=36
     AND COUNT(DISTINCT trigger_name)=36
     AND COUNT(DISTINCT CONCAT(event_object_table,'~',event_manipulation,'~',trigger_name))=36
     AND SHA2(GROUP_CONCAT(CONCAT_WS('~',event_object_table,trigger_name,
           action_timing,event_manipulation,action_orientation,
           IFNULL(action_condition,'<NULL>'),
           LOWER(REGEXP_REPLACE(action_statement,'[[:space:]]','')))
         ORDER BY event_object_table,trigger_name SEPARATOR '|'),256)
       = '13266d178324cc3a32fa9ac5c2c9e8f83477a03096c2f861418d6cb2e4bd0832'
    FROM information_schema.triggers
   WHERE trigger_schema=DATABASE()
     AND event_object_table IN (
       'tenant_purge_execution_jobs','tenant_purge_execution_domains',
       'tenant_purge_execution_domain_acks','tenant_purge_local_cutover_receipts',
       'tenant_purge_local_physical_ack_receipts','tenant_purge_execution_cutover'
     )
);
SET @migration_sql = IF(@tenant_purge_execution_trigger_set_ok=1, 'SELECT 1',
  'SELECT 1 FROM __invalid_tenant_purge_execution_trigger_set__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
SET SESSION group_concat_max_len = @tenant_purge_execution_previous_group_concat_max_len;
