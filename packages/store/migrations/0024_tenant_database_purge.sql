-- Expand-only, default-dormant substrate for T3f local database purge evidence.
--
-- This migration creates no job, pre-delete evidence, ACK, receipt, or grave marker; it does not
-- inspect or delete tenant data and leaves the write-once cutover inactive. Runtime execution is
-- separately gated and must bind a terminal 0023 physical ACK before deleting any database row.

SET @tenant_database_purge_previous_group_concat_max_len = @@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len = 1048576;

CREATE TABLE IF NOT EXISTS tenant_database_purge_jobs (
  request_id                              VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                               VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation                      BIGINT UNSIGNED NOT NULL,
  plan_build_generation                   BIGINT UNSIGNED NOT NULL,
  execution_generation                    BIGINT UNSIGNED NOT NULL,
  database_purge_generation               BIGINT UNSIGNED NOT NULL,
  t3c_receipt_sha256                      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  plan_receipt_sha256                     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  local_physical_ack_receipt_sha256       CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  policy_sha256                           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  purge_not_before_db_ms                  BIGINT NOT NULL,
  source_evidence_db_ms                   BIGINT NOT NULL,
  phase                                   VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  domain_count                            BIGINT UNSIGNED NOT NULL,
  predelete_entry_count                   BIGINT UNSIGNED NOT NULL,
  predelete_entry_root_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  domain_ack_count                        BIGINT UNSIGNED NOT NULL,
  domain_ack_root_sha256                  CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  unresolved_blocker_count                BIGINT UNSIGNED NOT NULL,
  predelete_receipt_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  terminal_receipt_sha256                 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  available_at_ms                         BIGINT NULL,
  attempts                                INT UNSIGNED NOT NULL DEFAULT 0,
  claim_token                             VARCHAR(128) COLLATE utf8mb4_0900_as_cs NULL,
  lease_until_ms                          BIGINT NULL,
  last_error_code                         VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL,
  created_at_ms                           BIGINT NOT NULL,
  updated_at_ms                           BIGINT NOT NULL,
  purged_at_db_ms                         BIGINT NULL,
  completed_claim_attempt                 INT UNSIGNED NULL,
  completed_claim_token_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  blocked_at_ms                           BIGINT NULL,
  blocked_reason_code                     VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL,
  PRIMARY KEY (request_id),
  UNIQUE KEY uk_tenant_db_purge_jobs_tenant (tenant_id),
  UNIQUE KEY uk_tenant_db_purge_jobs_generation
    (tenant_id, subject_generation, database_purge_generation),
  UNIQUE KEY uk_tenant_db_purge_jobs_identity
    (request_id, tenant_id, subject_generation, plan_build_generation,
     execution_generation, database_purge_generation),
  KEY idx_tenant_db_purge_jobs_claim
    (phase, available_at_ms, lease_until_ms, request_id),
  CONSTRAINT fk_tenant_db_purge_job_physical
    FOREIGN KEY (request_id) REFERENCES tenant_purge_local_physical_ack_receipts (request_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tenant_db_purge_job_generations CHECK (
    subject_generation > 0 AND plan_build_generation > 0
    AND execution_generation > 0 AND database_purge_generation > 0
  ),
  CONSTRAINT chk_tenant_db_purge_job_clock CHECK (
    purge_not_before_db_ms >= 0 AND source_evidence_db_ms >= purge_not_before_db_ms
    AND created_at_ms >= source_evidence_db_ms AND updated_at_ms >= created_at_ms
  ),
  CONSTRAINT chk_tenant_db_purge_job_progress CHECK (
    domain_count = 11 AND unresolved_blocker_count <= 33
    AND ((predelete_entry_count = 0
      AND predelete_entry_root_sha256 =
        '863bda0e079e55aa4c751d6a4c18860cac791985c34a27572c9294cf9f7a4396'
      AND domain_ack_count = 0
      AND domain_ack_root_sha256 =
        '776cd8a7449522e7b71b04cc502881af1ebc11600627bc15606f90c29fdfe552')
      OR (predelete_entry_count = domain_count AND domain_ack_count = domain_count))
  ),
  CONSTRAINT chk_tenant_db_purge_job_phase CHECK (
    (phase = 'queued'
      AND available_at_ms IS NOT NULL AND available_at_ms >= created_at_ms
      AND ((claim_token IS NULL AND lease_until_ms IS NULL
            AND available_at_ms >= updated_at_ms)
        OR (claim_token IS NOT NULL AND lease_until_ms IS NOT NULL
            AND attempts > 0 AND lease_until_ms >= updated_at_ms))
      AND ((claim_token IS NOT NULL AND last_error_code IS NULL)
        OR (claim_token IS NULL AND (last_error_code IS NULL
          OR last_error_code IN ('temporary_failure','dependency_pending'))))
      AND predelete_entry_count = 0 AND domain_ack_count = 0
      AND predelete_receipt_sha256 IS NULL
      AND terminal_receipt_sha256 IS NULL AND purged_at_db_ms IS NULL
      AND completed_claim_attempt IS NULL AND completed_claim_token_sha256 IS NULL
      AND blocked_at_ms IS NULL AND blocked_reason_code IS NULL)
    OR
    (phase = 'database_purged'
      AND available_at_ms IS NULL AND claim_token IS NULL AND lease_until_ms IS NULL
      AND last_error_code IS NULL AND domain_ack_count = domain_count
      AND predelete_entry_count = domain_count
      AND predelete_receipt_sha256 IS NOT NULL AND terminal_receipt_sha256 IS NOT NULL
      AND purged_at_db_ms IS NOT NULL AND purged_at_db_ms >= source_evidence_db_ms
      AND purged_at_db_ms <= updated_at_ms AND completed_claim_attempt IS NOT NULL
      AND completed_claim_attempt = attempts AND attempts > 0
      AND completed_claim_token_sha256 IS NOT NULL
      AND blocked_at_ms IS NULL AND blocked_reason_code IS NULL)
    OR
    (phase = 'blocked'
      AND available_at_ms IS NULL AND claim_token IS NULL AND lease_until_ms IS NULL
      AND last_error_code IS NULL AND predelete_entry_count = 0 AND domain_ack_count = 0
      AND predelete_receipt_sha256 IS NULL AND terminal_receipt_sha256 IS NULL
      AND purged_at_db_ms IS NULL AND completed_claim_attempt IS NULL
      AND completed_claim_token_sha256 IS NULL AND blocked_at_ms IS NOT NULL
      AND blocked_at_ms >= created_at_ms AND blocked_at_ms <= updated_at_ms
      AND attempts > 0 AND blocked_reason_code = 'integrity_conflict')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT request_id, tenant_id, subject_generation, plan_build_generation,
       execution_generation, database_purge_generation, t3c_receipt_sha256,
       plan_receipt_sha256, local_physical_ack_receipt_sha256, policy_sha256,
       purge_not_before_db_ms, source_evidence_db_ms, phase, domain_count,
       predelete_entry_count, predelete_entry_root_sha256, domain_ack_count,
       domain_ack_root_sha256, unresolved_blocker_count,
       predelete_receipt_sha256, terminal_receipt_sha256, available_at_ms,
       attempts, claim_token, lease_until_ms, last_error_code, created_at_ms,
       updated_at_ms, purged_at_db_ms, completed_claim_attempt,
       completed_claim_token_sha256, blocked_at_ms, blocked_reason_code
  FROM tenant_database_purge_jobs FORCE INDEX (
    PRIMARY, uk_tenant_db_purge_jobs_tenant, uk_tenant_db_purge_jobs_generation,
    uk_tenant_db_purge_jobs_identity, idx_tenant_db_purge_jobs_claim
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_database_purge_predelete_entries (
  scope                                   VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_id                              VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                               VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation                      BIGINT UNSIGNED NOT NULL,
  plan_build_generation                   BIGINT UNSIGNED NOT NULL,
  execution_generation                    BIGINT UNSIGNED NOT NULL,
  database_purge_generation               BIGINT UNSIGNED NOT NULL,
  domain                                  VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  domain_ordinal                          TINYINT UNSIGNED NOT NULL,
  action                                  VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  plan_entry_receipt_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  plan_target_count                       BIGINT UNSIGNED NOT NULL,
  plan_target_root_sha256                 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  bridge_kind                             VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  bridge_sha256                           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  predelete_target_count                  BIGINT UNSIGNED NOT NULL,
  predelete_target_root_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  captured_at_db_ms                       BIGINT NOT NULL,
  receipt_sha256                          CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (request_id, database_purge_generation, domain),
  UNIQUE KEY uk_tenant_db_predelete_entries_ordinal
    (request_id, database_purge_generation, domain_ordinal),
  UNIQUE KEY uk_tenant_db_predelete_entries_hash
    (request_id, database_purge_generation, receipt_sha256),
  UNIQUE KEY uk_tenant_db_predelete_entries_ack_fk
    (request_id, tenant_id, subject_generation, plan_build_generation,
     execution_generation, database_purge_generation, domain, receipt_sha256),
  KEY idx_tenant_db_predelete_entries_plan_fk
    (request_id, plan_build_generation, domain),
  KEY idx_tenant_db_predelete_entries_owner
    (tenant_id, subject_generation, request_id, database_purge_generation, domain),
  CONSTRAINT fk_tenant_db_predelete_entry_job
    FOREIGN KEY (request_id, tenant_id, subject_generation, plan_build_generation,
                 execution_generation, database_purge_generation)
    REFERENCES tenant_database_purge_jobs
      (request_id, tenant_id, subject_generation, plan_build_generation,
       execution_generation, database_purge_generation)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tenant_db_predelete_entry_plan
    FOREIGN KEY (request_id, plan_build_generation, domain)
    REFERENCES tenant_purge_plan_entries (request_id, build_generation, domain)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tenant_db_predelete_entry_scope CHECK (
    scope = 'tenant-database-purge-predelete-entry-v1'
  ),
  CONSTRAINT chk_tenant_db_predelete_entry_generation CHECK (
    subject_generation > 0 AND plan_build_generation > 0
    AND execution_generation > 0 AND database_purge_generation > 0
  ),
  CONSTRAINT chk_tenant_db_predelete_entry_domain CHECK (
    domain IN ('tenant_profile','agent_definitions','session_content',
      'idempotency_receipts','billing_reconciliation','blob_manifest','blob_outbox',
      'lifecycle_outbox','user_export_control','user_export_snapshots',
      'user_export_artifacts')
  ),
  CONSTRAINT chk_tenant_db_predelete_entry_ordinal CHECK (domain_ordinal <= 10),
  CONSTRAINT chk_tenant_db_predelete_entry_action CHECK (
    (domain = 'tenant_profile' AND action = 'clear')
    OR (domain = 'billing_reconciliation' AND action = 'retain_anonymized')
    OR (domain = 'session_content' AND action = 'delete_with_grave_markers')
    OR (domain NOT IN ('tenant_profile','billing_reconciliation','session_content')
      AND action = 'delete')
  ),
  CONSTRAINT chk_tenant_db_predelete_entry_bridge CHECK (
    captured_at_db_ms >= 0
    AND ((domain IN ('blob_manifest','blob_outbox','user_export_control',
          'user_export_snapshots','user_export_artifacts')
        AND bridge_kind = 't3e_successor')
      OR (domain NOT IN ('blob_manifest','blob_outbox','user_export_control',
          'user_export_snapshots','user_export_artifacts')
        AND bridge_kind = 'direct_plan'))
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT scope, request_id, tenant_id, subject_generation, plan_build_generation,
       execution_generation, database_purge_generation, domain, domain_ordinal,
       action, plan_entry_receipt_sha256, plan_target_count,
       plan_target_root_sha256, bridge_kind, bridge_sha256,
       predelete_target_count, predelete_target_root_sha256, captured_at_db_ms,
       receipt_sha256
  FROM tenant_database_purge_predelete_entries FORCE INDEX (
    PRIMARY, uk_tenant_db_predelete_entries_ordinal,
    uk_tenant_db_predelete_entries_hash, uk_tenant_db_predelete_entries_ack_fk,
    idx_tenant_db_predelete_entries_plan_fk, idx_tenant_db_predelete_entries_owner
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_database_purge_predelete_receipts (
  scope                                   VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_id                              VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                               VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation                      BIGINT UNSIGNED NOT NULL,
  plan_build_generation                   BIGINT UNSIGNED NOT NULL,
  execution_generation                    BIGINT UNSIGNED NOT NULL,
  database_purge_generation               BIGINT UNSIGNED NOT NULL,
  t3c_receipt_sha256                      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  plan_receipt_sha256                     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  local_physical_ack_receipt_sha256       CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  policy_sha256                           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  purge_not_before_db_ms                  BIGINT NOT NULL,
  source_evidence_db_ms                   BIGINT NOT NULL,
  entry_count                             BIGINT UNSIGNED NOT NULL,
  entry_root_sha256                       CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  session_target_count                    BIGINT UNSIGNED NOT NULL,
  session_target_root_sha256              CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  retained_billing_fact_count             BIGINT UNSIGNED NOT NULL,
  retained_billing_fact_root_sha256       CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  billing_reconciliation_target_count     BIGINT UNSIGNED NOT NULL,
  billing_reconciliation_target_root_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  store_db_timestamp_ms                   BIGINT NOT NULL,
  completed_claim_attempt                 INT UNSIGNED NOT NULL,
  completed_claim_token_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  predelete_complete                      BOOLEAN NOT NULL,
  destructive_progress                    BOOLEAN NOT NULL,
  content_purge_executed                  BOOLEAN NOT NULL,
  receipt_sha256                          CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (request_id),
  UNIQUE KEY uk_tenant_db_predelete_receipts_tenant (tenant_id),
  UNIQUE KEY uk_tenant_db_predelete_receipts_generation
    (tenant_id, subject_generation, database_purge_generation),
  UNIQUE KEY uk_tenant_db_predelete_receipts_hash (receipt_sha256),
  UNIQUE KEY uk_tenant_db_predelete_receipts_request_hash (request_id, receipt_sha256),
  KEY idx_tenant_db_predelete_receipts_job_fk
    (request_id, tenant_id, subject_generation, plan_build_generation,
     execution_generation, database_purge_generation),
  CONSTRAINT fk_tenant_db_predelete_receipt_job
    FOREIGN KEY (request_id, tenant_id, subject_generation, plan_build_generation,
                 execution_generation, database_purge_generation)
    REFERENCES tenant_database_purge_jobs
      (request_id, tenant_id, subject_generation, plan_build_generation,
       execution_generation, database_purge_generation)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tenant_db_predelete_receipt_scope CHECK (
    scope = 'tenant-database-purge-predelete-v1'
  ),
  CONSTRAINT chk_tenant_db_predelete_receipt_generation CHECK (
    subject_generation > 0 AND plan_build_generation > 0
    AND execution_generation > 0 AND database_purge_generation > 0
  ),
  CONSTRAINT chk_tenant_db_predelete_receipt_counts CHECK (
    entry_count = 11
    AND (session_target_count > 0 OR session_target_root_sha256 =
      'dd81e7e406988e57aada0e7d119e4a685b1d289d7ff1ead9731a41b49372807e')
    AND (retained_billing_fact_count > 0 OR retained_billing_fact_root_sha256 =
      '486c74f49d51cd39028a367ed6b8e7083999927e9fc7270c88a529a249a30b9f')
    AND (billing_reconciliation_target_count > 0
      OR billing_reconciliation_target_root_sha256 =
        'd521b8dcdbce4a56fa16dfa646449f1bc1b4f089ea4e1a02de49db5cc4472cfe')
  ),
  CONSTRAINT chk_tenant_db_predelete_receipt_flags CHECK (
    purge_not_before_db_ms >= 0 AND source_evidence_db_ms >= 0
    AND store_db_timestamp_ms >= source_evidence_db_ms AND completed_claim_attempt > 0
    AND predelete_complete = TRUE AND destructive_progress = FALSE
    AND content_purge_executed = FALSE
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT scope, request_id, tenant_id, subject_generation, plan_build_generation,
       execution_generation, database_purge_generation, t3c_receipt_sha256,
       plan_receipt_sha256, local_physical_ack_receipt_sha256, policy_sha256,
       purge_not_before_db_ms, source_evidence_db_ms, entry_count,
       entry_root_sha256, session_target_count, session_target_root_sha256,
       retained_billing_fact_count, retained_billing_fact_root_sha256,
       billing_reconciliation_target_count,
       billing_reconciliation_target_root_sha256, store_db_timestamp_ms,
       completed_claim_attempt, completed_claim_token_sha256, predelete_complete,
       destructive_progress, content_purge_executed, receipt_sha256
  FROM tenant_database_purge_predelete_receipts FORCE INDEX (
    PRIMARY, uk_tenant_db_predelete_receipts_tenant,
    uk_tenant_db_predelete_receipts_generation, uk_tenant_db_predelete_receipts_hash,
    uk_tenant_db_predelete_receipts_request_hash, idx_tenant_db_predelete_receipts_job_fk
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_database_purge_domain_acks (
  scope                                   VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_id                              VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                               VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation                      BIGINT UNSIGNED NOT NULL,
  plan_build_generation                   BIGINT UNSIGNED NOT NULL,
  execution_generation                    BIGINT UNSIGNED NOT NULL,
  database_purge_generation               BIGINT UNSIGNED NOT NULL,
  domain                                  VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  domain_ordinal                          TINYINT UNSIGNED NOT NULL,
  global_ack_seq                          BIGINT UNSIGNED NOT NULL,
  previous_global_ack_sha256              CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  action                                  VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  predelete_entry_receipt_sha256          CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  predelete_target_count                  BIGINT UNSIGNED NOT NULL,
  predelete_target_root_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  affected_count                         BIGINT UNSIGNED NOT NULL,
  result_target_count                     BIGINT UNSIGNED NOT NULL,
  result_target_root_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  retained_evidence_count                 BIGINT UNSIGNED NOT NULL,
  retained_evidence_root_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  adapter_protocol                        VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  operation_sha256                        CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  physical_proof_sha256                   CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  store_db_timestamp_ms                   BIGINT NOT NULL,
  completed_claim_attempt                 INT UNSIGNED NOT NULL,
  completed_claim_token_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  receipt_sha256                          CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (request_id, database_purge_generation, global_ack_seq),
  UNIQUE KEY uk_tenant_db_purge_acks_domain
    (request_id, database_purge_generation, domain),
  UNIQUE KEY uk_tenant_db_purge_acks_ordinal
    (request_id, database_purge_generation, domain_ordinal),
  UNIQUE KEY uk_tenant_db_purge_acks_receipt
    (request_id, database_purge_generation, receipt_sha256),
  UNIQUE KEY uk_tenant_db_purge_acks_operation
    (request_id, database_purge_generation, operation_sha256),
  KEY idx_tenant_db_purge_acks_entry_fk
    (request_id, tenant_id, subject_generation, plan_build_generation,
     execution_generation, database_purge_generation, domain,
     predelete_entry_receipt_sha256),
  KEY idx_tenant_db_purge_acks_owner
    (tenant_id, subject_generation, request_id, database_purge_generation, domain),
  CONSTRAINT fk_tenant_db_purge_ack_entry
    FOREIGN KEY (request_id, tenant_id, subject_generation, plan_build_generation,
                 execution_generation, database_purge_generation, domain,
                 predelete_entry_receipt_sha256)
    REFERENCES tenant_database_purge_predelete_entries
      (request_id, tenant_id, subject_generation, plan_build_generation,
       execution_generation, database_purge_generation, domain, receipt_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tenant_db_purge_ack_scope CHECK (
    scope = 'tenant-database-purge-domain-ack-v1'
  ),
  CONSTRAINT chk_tenant_db_purge_ack_generation CHECK (
    subject_generation > 0 AND plan_build_generation > 0
    AND execution_generation > 0 AND database_purge_generation > 0
    AND global_ack_seq > 0 AND completed_claim_attempt > 0
    AND store_db_timestamp_ms >= 0
  ),
  CONSTRAINT chk_tenant_db_purge_ack_domain CHECK (
    domain IN ('tenant_profile','agent_definitions','session_content',
      'idempotency_receipts','billing_reconciliation','blob_manifest','blob_outbox',
      'lifecycle_outbox','user_export_control','user_export_snapshots',
      'user_export_artifacts') AND domain_ordinal <= 10
    AND global_ack_seq = domain_ordinal + 1
  ),
  CONSTRAINT chk_tenant_db_purge_ack_action CHECK (
    (domain = 'tenant_profile' AND action = 'clear')
    OR (domain = 'billing_reconciliation' AND action = 'retain_anonymized')
    OR (domain = 'session_content' AND action = 'delete_with_grave_markers')
    OR (domain NOT IN ('tenant_profile','billing_reconciliation','session_content')
      AND action = 'delete')
  ),
  CONSTRAINT chk_tenant_db_purge_ack_result CHECK (
    affected_count = predelete_target_count
    AND ((action = 'clear' AND result_target_count = 1 AND retained_evidence_count = 0)
      OR (action = 'delete' AND result_target_count = 0 AND retained_evidence_count = 0)
      OR (action = 'delete_with_grave_markers' AND result_target_count = 0
        AND retained_evidence_count = predelete_target_count)
      OR (action = 'retain_anonymized' AND result_target_count = 0
        AND ((predelete_target_count = 0 AND retained_evidence_count = 0)
          OR (predelete_target_count > 0 AND retained_evidence_count = 1))))
  ),
  CONSTRAINT chk_tenant_db_purge_ack_protocol CHECK (
    adapter_protocol = 'local-database-v1'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT scope, request_id, tenant_id, subject_generation, plan_build_generation,
       execution_generation, database_purge_generation, domain, domain_ordinal,
       global_ack_seq, previous_global_ack_sha256, action,
       predelete_entry_receipt_sha256, predelete_target_count,
       predelete_target_root_sha256, affected_count, result_target_count,
       result_target_root_sha256, retained_evidence_count,
       retained_evidence_root_sha256, adapter_protocol, operation_sha256,
       physical_proof_sha256,
       store_db_timestamp_ms, completed_claim_attempt,
       completed_claim_token_sha256, receipt_sha256
  FROM tenant_database_purge_domain_acks FORCE INDEX (
    PRIMARY, uk_tenant_db_purge_acks_domain, uk_tenant_db_purge_acks_ordinal,
    uk_tenant_db_purge_acks_receipt, uk_tenant_db_purge_acks_operation,
    idx_tenant_db_purge_acks_entry_fk, idx_tenant_db_purge_acks_owner
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_database_purge_receipts (
  scope                                   VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_id                              VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                               VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation                      BIGINT UNSIGNED NOT NULL,
  plan_build_generation                   BIGINT UNSIGNED NOT NULL,
  execution_generation                    BIGINT UNSIGNED NOT NULL,
  database_purge_generation               BIGINT UNSIGNED NOT NULL,
  t3c_receipt_sha256                      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  plan_receipt_sha256                     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  local_physical_ack_receipt_sha256       CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  policy_sha256                           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  purge_not_before_db_ms                  BIGINT NOT NULL,
  source_evidence_db_ms                   BIGINT NOT NULL,
  predelete_receipt_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  predelete_entry_count                   BIGINT UNSIGNED NOT NULL,
  predelete_entry_root_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  domain_ack_count                        BIGINT UNSIGNED NOT NULL,
  domain_ack_root_sha256                  CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  grave_marker_count                      BIGINT UNSIGNED NOT NULL,
  grave_marker_root_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  retained_billing_fact_count             BIGINT UNSIGNED NOT NULL,
  retained_billing_fact_root_sha256       CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  billing_reconciliation_evidence_count   BIGINT UNSIGNED NOT NULL,
  billing_reconciliation_evidence_root_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  unresolved_blocker_count                BIGINT UNSIGNED NOT NULL,
  store_db_timestamp_ms                   BIGINT NOT NULL,
  completed_claim_attempt                 INT UNSIGNED NOT NULL,
  completed_claim_token_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  local_database_purge_complete           BOOLEAN NOT NULL,
  session_content_deleted                 BOOLEAN NOT NULL,
  all_domains_complete                    BOOLEAN NOT NULL,
  content_purge_executed                  BOOLEAN NOT NULL,
  receipt_sha256                          CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (request_id),
  UNIQUE KEY uk_tenant_db_purge_receipts_tenant (tenant_id),
  UNIQUE KEY uk_tenant_db_purge_receipts_generation
    (tenant_id, subject_generation, database_purge_generation),
  UNIQUE KEY uk_tenant_db_purge_receipts_hash (receipt_sha256),
  UNIQUE KEY uk_tenant_db_purge_receipts_request_hash (request_id, receipt_sha256),
  KEY idx_tenant_db_purge_receipts_job_fk
    (request_id, tenant_id, subject_generation, plan_build_generation,
     execution_generation, database_purge_generation),
  KEY idx_tenant_db_purge_receipts_predelete_fk (request_id, predelete_receipt_sha256),
  CONSTRAINT fk_tenant_db_purge_receipt_job
    FOREIGN KEY (request_id, tenant_id, subject_generation, plan_build_generation,
                 execution_generation, database_purge_generation)
    REFERENCES tenant_database_purge_jobs
      (request_id, tenant_id, subject_generation, plan_build_generation,
       execution_generation, database_purge_generation)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tenant_db_purge_receipt_predelete
    FOREIGN KEY (request_id, predelete_receipt_sha256)
    REFERENCES tenant_database_purge_predelete_receipts (request_id, receipt_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tenant_db_purge_receipt_scope CHECK (
    scope = 'tenant-database-purge-v1'
  ),
  CONSTRAINT chk_tenant_db_purge_receipt_generation CHECK (
    subject_generation > 0 AND plan_build_generation > 0
    AND execution_generation > 0 AND database_purge_generation > 0
  ),
  CONSTRAINT chk_tenant_db_purge_receipt_counts CHECK (
    predelete_entry_count = 11 AND domain_ack_count = 11
    AND billing_reconciliation_evidence_count <= 1
    AND unresolved_blocker_count <= 33
    AND (grave_marker_count > 0 OR grave_marker_root_sha256 =
      'edb32b49a743069c2a83426d30b4f0f0d54f3cd6b4bf4368acd4c5ae3c514da9')
    AND (retained_billing_fact_count > 0 OR retained_billing_fact_root_sha256 =
      '486c74f49d51cd39028a367ed6b8e7083999927e9fc7270c88a529a249a30b9f')
    AND (billing_reconciliation_evidence_count > 0
      OR billing_reconciliation_evidence_root_sha256 =
        'fa562f73fca2da93ad39bb09a67ad99dfe9cdb6f67063e7b3b1d6ba398e008eb')
  ),
  CONSTRAINT chk_tenant_db_purge_receipt_flags CHECK (
    purge_not_before_db_ms >= 0 AND source_evidence_db_ms >= 0
    AND store_db_timestamp_ms >= source_evidence_db_ms AND completed_claim_attempt > 0
    AND local_database_purge_complete = TRUE AND session_content_deleted = TRUE
    AND all_domains_complete = FALSE AND content_purge_executed = FALSE
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT scope, request_id, tenant_id, subject_generation, plan_build_generation,
       execution_generation, database_purge_generation, t3c_receipt_sha256,
       plan_receipt_sha256, local_physical_ack_receipt_sha256, policy_sha256,
       purge_not_before_db_ms, source_evidence_db_ms,
       predelete_receipt_sha256, predelete_entry_count,
       predelete_entry_root_sha256, domain_ack_count, domain_ack_root_sha256,
       grave_marker_count, grave_marker_root_sha256, retained_billing_fact_count,
       retained_billing_fact_root_sha256,
       billing_reconciliation_evidence_count,
       billing_reconciliation_evidence_root_sha256, unresolved_blocker_count,
       store_db_timestamp_ms, completed_claim_attempt,
       completed_claim_token_sha256, local_database_purge_complete,
       session_content_deleted, all_domains_complete, content_purge_executed,
       receipt_sha256
  FROM tenant_database_purge_receipts FORCE INDEX (
    PRIMARY, uk_tenant_db_purge_receipts_tenant,
    uk_tenant_db_purge_receipts_generation, uk_tenant_db_purge_receipts_hash,
    uk_tenant_db_purge_receipts_request_hash, idx_tenant_db_purge_receipts_job_fk,
    idx_tenant_db_purge_receipts_predelete_fk
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_purge_session_grave_markers (
  scope                                   VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  session_id                              VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                               VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_id                              VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation                      BIGINT UNSIGNED NOT NULL,
  plan_build_generation                   BIGINT UNSIGNED NOT NULL,
  execution_generation                    BIGINT UNSIGNED NOT NULL,
  database_purge_generation               BIGINT UNSIGNED NOT NULL,
  deletion_generation                     BIGINT UNSIGNED NOT NULL,
  deleted_at_db_ms                        BIGINT NOT NULL,
  owner_sha256                            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  t3c_session_receipt_sha256              CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  predelete_receipt_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  marked_at_db_ms                         BIGINT NOT NULL,
  marker_sha256                           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (session_id),
  UNIQUE KEY uk_tenant_purge_grave_marker_hash (marker_sha256),
  UNIQUE KEY uk_tenant_purge_grave_marker_session_receipt
    (request_id, plan_build_generation, t3c_session_receipt_sha256),
  KEY idx_tenant_purge_grave_marker_owner
    (tenant_id, request_id, database_purge_generation, session_id),
  KEY idx_tenant_purge_grave_marker_job_fk
    (request_id, tenant_id, subject_generation, plan_build_generation,
     execution_generation, database_purge_generation),
  KEY idx_tenant_purge_grave_marker_predelete_fk
    (request_id, predelete_receipt_sha256),
  CONSTRAINT fk_tenant_purge_grave_marker_job
    FOREIGN KEY (request_id, tenant_id, subject_generation, plan_build_generation,
                 execution_generation, database_purge_generation)
    REFERENCES tenant_database_purge_jobs
      (request_id, tenant_id, subject_generation, plan_build_generation,
       execution_generation, database_purge_generation)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tenant_purge_grave_marker_predelete
    FOREIGN KEY (request_id, predelete_receipt_sha256)
    REFERENCES tenant_database_purge_predelete_receipts (request_id, receipt_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tenant_purge_grave_marker_session
    FOREIGN KEY (request_id, plan_build_generation, session_id)
    REFERENCES session_content_receipts (request_id, build_generation, session_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tenant_purge_grave_marker_session_receipt
    FOREIGN KEY (request_id, plan_build_generation, t3c_session_receipt_sha256)
    REFERENCES session_content_receipts (request_id, build_generation, receipt_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tenant_purge_grave_marker_scope CHECK (
    scope = 'tenant-purge-session-grave-marker-v1'
  ),
  CONSTRAINT chk_tenant_purge_grave_marker_generation CHECK (
    subject_generation > 0 AND plan_build_generation > 0
    AND execution_generation > 0 AND database_purge_generation > 0
    AND deletion_generation > 0
  ),
  CONSTRAINT chk_tenant_purge_grave_marker_clock CHECK (
    deleted_at_db_ms >= 0 AND marked_at_db_ms >= deleted_at_db_ms
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT scope, session_id, tenant_id, request_id, subject_generation, plan_build_generation,
       execution_generation, database_purge_generation, deletion_generation,
       deleted_at_db_ms, owner_sha256, t3c_session_receipt_sha256,
       predelete_receipt_sha256, marked_at_db_ms, marker_sha256
  FROM tenant_purge_session_grave_markers FORCE INDEX (
    PRIMARY, uk_tenant_purge_grave_marker_hash,
    uk_tenant_purge_grave_marker_session_receipt,
    idx_tenant_purge_grave_marker_owner, idx_tenant_purge_grave_marker_job_fk,
    idx_tenant_purge_grave_marker_predelete_fk
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_database_purge_cutover (
  singleton_id          TINYINT UNSIGNED NOT NULL,
  control_generation    BIGINT UNSIGNED NOT NULL,
  activated_at_db_ms    BIGINT NULL,
  first_request_id      VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  first_receipt_sha256  CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  evidence_sha256       CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  PRIMARY KEY (singleton_id),
  KEY idx_tenant_db_purge_cutover_receipt_fk (first_request_id, first_receipt_sha256),
  CONSTRAINT fk_tenant_db_purge_cutover_receipt
    FOREIGN KEY (first_request_id, first_receipt_sha256)
    REFERENCES tenant_database_purge_receipts (request_id, receipt_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tenant_db_purge_cutover_singleton CHECK (singleton_id = 1),
  CONSTRAINT chk_tenant_db_purge_cutover_state CHECK (
    (control_generation = 0 AND activated_at_db_ms IS NULL
      AND first_request_id IS NULL AND first_receipt_sha256 IS NULL
      AND evidence_sha256 IS NULL)
    OR
    (control_generation = 1 AND activated_at_db_ms IS NOT NULL
      AND activated_at_db_ms >= 0 AND first_request_id IS NOT NULL
      AND first_receipt_sha256 IS NOT NULL AND evidence_sha256 IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT singleton_id, control_generation, activated_at_db_ms, first_request_id,
       first_receipt_sha256, evidence_sha256
  FROM tenant_database_purge_cutover FORCE INDEX (
    PRIMARY, idx_tenant_db_purge_cutover_receipt_fk
  ) WHERE 1=0;

-- IF NOT EXISTS must not turn a partial auto-commit or same-name weaker schema into a successful
-- migration marker. The exact metadata fingerprints are filled from supported MySQL 8.0 output.
SET @tenant_database_purge_schema_ok = (
  (SELECT COUNT(*)=7
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,table_type,
             IFNULL(engine,'-'),IFNULL(table_collation,'-'))
           ORDER BY table_name SEPARATOR '|'),256)
         = 'ab20ebc89a7b9295c268cd8af7797a813528960911fb1b81b90d463930f03abf'
     FROM information_schema.tables
    WHERE table_schema=DATABASE()
      AND table_name IN (
        'tenant_database_purge_jobs','tenant_database_purge_predelete_entries',
        'tenant_database_purge_predelete_receipts','tenant_database_purge_domain_acks',
        'tenant_database_purge_receipts','tenant_purge_session_grave_markers',
        'tenant_database_purge_cutover'
      ))
  AND
  (SELECT COUNT(*)=161
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,LPAD(ordinal_position,3,'0'),
             column_name,LOWER(column_type),is_nullable,
             IF(column_default IS NULL,'<NULL>',CONCAT('<',column_default,'>')),
             IFNULL(character_set_name,'-'),IFNULL(collation_name,'-'),
             IFNULL(NULLIF(LOWER(extra),''),'-'),
             IFNULL(NULLIF(LOWER(generation_expression),''),'-'))
           ORDER BY table_name,ordinal_position SEPARATOR '|'),256)
         = '4b7c684f49fd6f3e1b4523537b6f7fe51b8388d0c6abf884c4c93ab869625914'
     FROM information_schema.columns
    WHERE table_schema=DATABASE()
      AND table_name IN (
        'tenant_database_purge_jobs','tenant_database_purge_predelete_entries',
        'tenant_database_purge_predelete_receipts','tenant_database_purge_domain_acks',
        'tenant_database_purge_receipts','tenant_purge_session_grave_markers',
        'tenant_database_purge_cutover'
      ))
  AND
  (SELECT COUNT(DISTINCT CONCAT(table_name,'~',index_name))=40 AND COUNT(*)=121
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,index_name,non_unique,
             seq_in_index,LOWER(index_type),LOWER(is_visible),
             IFNULL(column_name,'<expression>'),IFNULL(CAST(sub_part AS CHAR),'-'),
             LOWER(IFNULL(collation,'-')),IFNULL(expression,'-'))
           ORDER BY table_name,index_name,seq_in_index SEPARATOR '|'),256)
         = 'c2113189572aba438e33277b597e52ed472c0cce41f844cd4a2ec03f141357dc'
     FROM information_schema.statistics
    WHERE table_schema=DATABASE()
      AND table_name IN (
        'tenant_database_purge_jobs','tenant_database_purge_predelete_entries',
        'tenant_database_purge_predelete_receipts','tenant_database_purge_domain_acks',
        'tenant_database_purge_receipts','tenant_purge_session_grave_markers',
        'tenant_database_purge_cutover'
      ))
  AND
  (SELECT COUNT(*)=29
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',tc.table_name,tc.constraint_name,tc.enforced,
             LOWER(REPLACE(REPLACE(REGEXP_REPLACE(cc.check_clause,'[[:space:]]',''),
               CHAR(96),''),'_utf8mb4','')))
           ORDER BY tc.table_name,tc.constraint_name SEPARATOR '|'),256)
         = '1449b5bcd20e6ad27a00f6666d8e066ca6f778c5370e0e468e4e06a2250f822c'
     FROM information_schema.table_constraints tc
     JOIN information_schema.check_constraints cc
       ON cc.constraint_schema=tc.constraint_schema
      AND cc.constraint_name=tc.constraint_name
    WHERE tc.table_schema=DATABASE() AND tc.constraint_type='CHECK'
      AND tc.table_name IN (
        'tenant_database_purge_jobs','tenant_database_purge_predelete_entries',
        'tenant_database_purge_predelete_receipts','tenant_database_purge_domain_acks',
        'tenant_database_purge_receipts','tenant_purge_session_grave_markers',
        'tenant_database_purge_cutover'
      ))
  AND
  (SELECT COUNT(*)=68
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,
             constraint_type,enforced)
           ORDER BY table_name,constraint_name SEPARATOR '|'),256)
         = '50293a798013013472cd5e329d206a2cc58546e754af831024cceb3ab235df35'
     FROM information_schema.table_constraints
    WHERE table_schema=DATABASE()
      AND table_name IN (
        'tenant_database_purge_jobs','tenant_database_purge_predelete_entries',
        'tenant_database_purge_predelete_receipts','tenant_database_purge_domain_acks',
        'tenant_database_purge_receipts','tenant_purge_session_grave_markers',
        'tenant_database_purge_cutover'
      ))
  AND
  (SELECT COUNT(*)=48
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',k.table_name,k.constraint_name,
             k.ordinal_position,k.column_name,k.referenced_table_name,
             k.referenced_column_name,r.update_rule,r.delete_rule)
           ORDER BY k.table_name,k.constraint_name,k.ordinal_position SEPARATOR '|'),256)
         = '362d1d8645c1c9f4a4e4270b0d605561a581f7fa6d6614f385bf74cf5b409dba'
     FROM information_schema.key_column_usage k
     JOIN information_schema.referential_constraints r
       ON r.constraint_schema=k.constraint_schema
      AND r.constraint_name=k.constraint_name
    WHERE k.table_schema=DATABASE() AND k.referenced_table_name IS NOT NULL
      AND k.table_name IN (
        'tenant_database_purge_jobs','tenant_database_purge_predelete_entries',
        'tenant_database_purge_predelete_receipts','tenant_database_purge_domain_acks',
        'tenant_database_purge_receipts','tenant_purge_session_grave_markers',
        'tenant_database_purge_cutover'
      ))
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.partitions
     WHERE table_schema=DATABASE() AND partition_name IS NOT NULL
       AND table_name IN (
         'tenant_database_purge_jobs','tenant_database_purge_predelete_entries',
         'tenant_database_purge_predelete_receipts','tenant_database_purge_domain_acks',
         'tenant_database_purge_receipts','tenant_purge_session_grave_markers',
         'tenant_database_purge_cutover'
       )
  )
);
SET @migration_sql = IF(@tenant_database_purge_schema_ok=1, 'SELECT 1',
  'SELECT 1 FROM __invalid_tenant_database_purge_schema__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

INSERT INTO tenant_database_purge_cutover
  (singleton_id, control_generation, activated_at_db_ms, first_request_id,
   first_receipt_sha256, evidence_sha256)
SELECT 1, 0, NULL, NULL, NULL, NULL
 WHERE NOT EXISTS (
   SELECT 1 FROM tenant_database_purge_cutover WHERE singleton_id = 1
 );

-- Job source identity is immutable. A queued claimed worker may only claim, renew, retry, commit
-- the complete atomic database purge, or block on deterministic integrity failure.
DROP TRIGGER IF EXISTS trg_tenant_db_purge_jobs_bu_bootstrap;
CREATE TRIGGER trg_tenant_db_purge_jobs_bu_bootstrap BEFORE UPDATE ON tenant_database_purge_jobs FOR EACH ROW BEGIN IF NOT (OLD.request_id <=> NEW.request_id AND OLD.tenant_id <=> NEW.tenant_id AND OLD.subject_generation <=> NEW.subject_generation AND OLD.plan_build_generation <=> NEW.plan_build_generation AND OLD.execution_generation <=> NEW.execution_generation AND OLD.database_purge_generation <=> NEW.database_purge_generation AND OLD.t3c_receipt_sha256 <=> NEW.t3c_receipt_sha256 AND OLD.plan_receipt_sha256 <=> NEW.plan_receipt_sha256 AND OLD.local_physical_ack_receipt_sha256 <=> NEW.local_physical_ack_receipt_sha256 AND OLD.policy_sha256 <=> NEW.policy_sha256 AND OLD.purge_not_before_db_ms <=> NEW.purge_not_before_db_ms AND OLD.source_evidence_db_ms <=> NEW.source_evidence_db_ms AND OLD.domain_count <=> NEW.domain_count AND OLD.unresolved_blocker_count <=> NEW.unresolved_blocker_count AND OLD.created_at_ms <=> NEW.created_at_ms AND OLD.phase='queued' AND NEW.updated_at_ms>=OLD.updated_at_ms AND ((NEW.phase='queued' AND NEW.predelete_entry_count=OLD.predelete_entry_count AND NEW.predelete_entry_root_sha256 <=> OLD.predelete_entry_root_sha256 AND NEW.domain_ack_count=OLD.domain_ack_count AND NEW.domain_ack_root_sha256 <=> OLD.domain_ack_root_sha256 AND NEW.predelete_receipt_sha256 <=> OLD.predelete_receipt_sha256 AND NEW.terminal_receipt_sha256 <=> OLD.terminal_receipt_sha256 AND ((OLD.claim_token IS NULL AND NEW.claim_token IS NOT NULL AND NEW.attempts=OLD.attempts+1 AND NEW.available_at_ms <=> OLD.available_at_ms) OR (OLD.claim_token IS NOT NULL AND NEW.claim_token <=> OLD.claim_token AND NEW.attempts=OLD.attempts AND NEW.available_at_ms <=> OLD.available_at_ms AND NEW.lease_until_ms>=OLD.lease_until_ms) OR (OLD.claim_token IS NOT NULL AND NEW.claim_token IS NULL AND NEW.attempts=OLD.attempts AND NEW.available_at_ms>=OLD.available_at_ms AND NEW.available_at_ms>=NEW.updated_at_ms))) OR (NEW.phase IN ('database_purged','blocked') AND OLD.claim_token IS NOT NULL AND NEW.attempts=OLD.attempts))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge job update is not permitted'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_db_purge_jobs_bu;
CREATE TRIGGER trg_tenant_db_purge_jobs_bu BEFORE UPDATE ON tenant_database_purge_jobs FOR EACH ROW BEGIN IF NOT (OLD.request_id <=> NEW.request_id AND OLD.tenant_id <=> NEW.tenant_id AND OLD.subject_generation <=> NEW.subject_generation AND OLD.plan_build_generation <=> NEW.plan_build_generation AND OLD.execution_generation <=> NEW.execution_generation AND OLD.database_purge_generation <=> NEW.database_purge_generation AND OLD.t3c_receipt_sha256 <=> NEW.t3c_receipt_sha256 AND OLD.plan_receipt_sha256 <=> NEW.plan_receipt_sha256 AND OLD.local_physical_ack_receipt_sha256 <=> NEW.local_physical_ack_receipt_sha256 AND OLD.policy_sha256 <=> NEW.policy_sha256 AND OLD.purge_not_before_db_ms <=> NEW.purge_not_before_db_ms AND OLD.source_evidence_db_ms <=> NEW.source_evidence_db_ms AND OLD.domain_count <=> NEW.domain_count AND OLD.unresolved_blocker_count <=> NEW.unresolved_blocker_count AND OLD.created_at_ms <=> NEW.created_at_ms AND OLD.phase='queued' AND NEW.updated_at_ms>=OLD.updated_at_ms AND ((NEW.phase='queued' AND NEW.predelete_entry_count=OLD.predelete_entry_count AND NEW.predelete_entry_root_sha256 <=> OLD.predelete_entry_root_sha256 AND NEW.domain_ack_count=OLD.domain_ack_count AND NEW.domain_ack_root_sha256 <=> OLD.domain_ack_root_sha256 AND NEW.predelete_receipt_sha256 <=> OLD.predelete_receipt_sha256 AND NEW.terminal_receipt_sha256 <=> OLD.terminal_receipt_sha256 AND ((OLD.claim_token IS NULL AND NEW.claim_token IS NOT NULL AND NEW.attempts=OLD.attempts+1 AND NEW.available_at_ms <=> OLD.available_at_ms) OR (OLD.claim_token IS NOT NULL AND NEW.claim_token <=> OLD.claim_token AND NEW.attempts=OLD.attempts AND NEW.available_at_ms <=> OLD.available_at_ms AND NEW.lease_until_ms>=OLD.lease_until_ms) OR (OLD.claim_token IS NOT NULL AND NEW.claim_token IS NULL AND NEW.attempts=OLD.attempts AND NEW.available_at_ms>=OLD.available_at_ms AND NEW.available_at_ms>=NEW.updated_at_ms))) OR (NEW.phase IN ('database_purged','blocked') AND OLD.claim_token IS NOT NULL AND NEW.attempts=OLD.attempts))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge job update is not permitted'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_db_purge_jobs_bu_guard_a;
CREATE TRIGGER trg_tenant_db_purge_jobs_bu_guard_a BEFORE UPDATE ON tenant_database_purge_jobs FOR EACH ROW BEGIN IF NOT (OLD.request_id <=> NEW.request_id AND OLD.tenant_id <=> NEW.tenant_id AND OLD.subject_generation <=> NEW.subject_generation AND OLD.plan_build_generation <=> NEW.plan_build_generation AND OLD.execution_generation <=> NEW.execution_generation AND OLD.database_purge_generation <=> NEW.database_purge_generation AND OLD.t3c_receipt_sha256 <=> NEW.t3c_receipt_sha256 AND OLD.plan_receipt_sha256 <=> NEW.plan_receipt_sha256 AND OLD.local_physical_ack_receipt_sha256 <=> NEW.local_physical_ack_receipt_sha256 AND OLD.policy_sha256 <=> NEW.policy_sha256 AND OLD.purge_not_before_db_ms <=> NEW.purge_not_before_db_ms AND OLD.source_evidence_db_ms <=> NEW.source_evidence_db_ms AND OLD.domain_count <=> NEW.domain_count AND OLD.unresolved_blocker_count <=> NEW.unresolved_blocker_count AND OLD.created_at_ms <=> NEW.created_at_ms AND OLD.phase='queued' AND NEW.updated_at_ms>=OLD.updated_at_ms AND ((NEW.phase='queued' AND NEW.predelete_entry_count=OLD.predelete_entry_count AND NEW.predelete_entry_root_sha256 <=> OLD.predelete_entry_root_sha256 AND NEW.domain_ack_count=OLD.domain_ack_count AND NEW.domain_ack_root_sha256 <=> OLD.domain_ack_root_sha256 AND NEW.predelete_receipt_sha256 <=> OLD.predelete_receipt_sha256 AND NEW.terminal_receipt_sha256 <=> OLD.terminal_receipt_sha256 AND ((OLD.claim_token IS NULL AND NEW.claim_token IS NOT NULL AND NEW.attempts=OLD.attempts+1 AND NEW.available_at_ms <=> OLD.available_at_ms) OR (OLD.claim_token IS NOT NULL AND NEW.claim_token <=> OLD.claim_token AND NEW.attempts=OLD.attempts AND NEW.available_at_ms <=> OLD.available_at_ms AND NEW.lease_until_ms>=OLD.lease_until_ms) OR (OLD.claim_token IS NOT NULL AND NEW.claim_token IS NULL AND NEW.attempts=OLD.attempts AND NEW.available_at_ms>=OLD.available_at_ms AND NEW.available_at_ms>=NEW.updated_at_ms))) OR (NEW.phase IN ('database_purged','blocked') AND OLD.claim_token IS NOT NULL AND NEW.attempts=OLD.attempts))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge job update is not permitted'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_db_purge_jobs_bu_guard_b;
CREATE TRIGGER trg_tenant_db_purge_jobs_bu_guard_b BEFORE UPDATE ON tenant_database_purge_jobs FOR EACH ROW BEGIN IF NOT (OLD.request_id <=> NEW.request_id AND OLD.tenant_id <=> NEW.tenant_id AND OLD.subject_generation <=> NEW.subject_generation AND OLD.plan_build_generation <=> NEW.plan_build_generation AND OLD.execution_generation <=> NEW.execution_generation AND OLD.database_purge_generation <=> NEW.database_purge_generation AND OLD.t3c_receipt_sha256 <=> NEW.t3c_receipt_sha256 AND OLD.plan_receipt_sha256 <=> NEW.plan_receipt_sha256 AND OLD.local_physical_ack_receipt_sha256 <=> NEW.local_physical_ack_receipt_sha256 AND OLD.policy_sha256 <=> NEW.policy_sha256 AND OLD.purge_not_before_db_ms <=> NEW.purge_not_before_db_ms AND OLD.source_evidence_db_ms <=> NEW.source_evidence_db_ms AND OLD.domain_count <=> NEW.domain_count AND OLD.unresolved_blocker_count <=> NEW.unresolved_blocker_count AND OLD.created_at_ms <=> NEW.created_at_ms AND OLD.phase='queued' AND NEW.updated_at_ms>=OLD.updated_at_ms AND ((NEW.phase='queued' AND NEW.predelete_entry_count=OLD.predelete_entry_count AND NEW.predelete_entry_root_sha256 <=> OLD.predelete_entry_root_sha256 AND NEW.domain_ack_count=OLD.domain_ack_count AND NEW.domain_ack_root_sha256 <=> OLD.domain_ack_root_sha256 AND NEW.predelete_receipt_sha256 <=> OLD.predelete_receipt_sha256 AND NEW.terminal_receipt_sha256 <=> OLD.terminal_receipt_sha256 AND ((OLD.claim_token IS NULL AND NEW.claim_token IS NOT NULL AND NEW.attempts=OLD.attempts+1 AND NEW.available_at_ms <=> OLD.available_at_ms) OR (OLD.claim_token IS NOT NULL AND NEW.claim_token <=> OLD.claim_token AND NEW.attempts=OLD.attempts AND NEW.available_at_ms <=> OLD.available_at_ms AND NEW.lease_until_ms>=OLD.lease_until_ms) OR (OLD.claim_token IS NOT NULL AND NEW.claim_token IS NULL AND NEW.attempts=OLD.attempts AND NEW.available_at_ms>=OLD.available_at_ms AND NEW.available_at_ms>=NEW.updated_at_ms))) OR (NEW.phase IN ('database_purged','blocked') AND OLD.claim_token IS NOT NULL AND NEW.attempts=OLD.attempts))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge job update is not permitted'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_db_purge_jobs_bu_bootstrap;

DROP TRIGGER IF EXISTS trg_tenant_db_purge_jobs_bd_bootstrap;
CREATE TRIGGER trg_tenant_db_purge_jobs_bd_bootstrap BEFORE DELETE ON tenant_database_purge_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge jobs cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_db_purge_jobs_bd;
CREATE TRIGGER trg_tenant_db_purge_jobs_bd BEFORE DELETE ON tenant_database_purge_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge jobs cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_db_purge_jobs_bd_guard_a;
CREATE TRIGGER trg_tenant_db_purge_jobs_bd_guard_a BEFORE DELETE ON tenant_database_purge_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge jobs cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_db_purge_jobs_bd_guard_b;
CREATE TRIGGER trg_tenant_db_purge_jobs_bd_guard_b BEFORE DELETE ON tenant_database_purge_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge jobs cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_db_purge_jobs_bd_bootstrap;

-- Permanent content-free evidence is append-only. Redundant same-action guards make accidental
-- removal of one known trigger insufficient to weaken a marker-loss replay.
DROP TRIGGER IF EXISTS trg_tenant_db_predelete_entries_bu_bootstrap;
CREATE TRIGGER trg_tenant_db_predelete_entries_bu_bootstrap BEFORE UPDATE ON tenant_database_purge_predelete_entries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge predelete entries are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_predelete_entries_bu;
CREATE TRIGGER trg_tenant_db_predelete_entries_bu BEFORE UPDATE ON tenant_database_purge_predelete_entries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge predelete entries are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_predelete_entries_bu_guard_a;
CREATE TRIGGER trg_tenant_db_predelete_entries_bu_guard_a BEFORE UPDATE ON tenant_database_purge_predelete_entries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge predelete entries are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_predelete_entries_bu_guard_b;
CREATE TRIGGER trg_tenant_db_predelete_entries_bu_guard_b BEFORE UPDATE ON tenant_database_purge_predelete_entries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge predelete entries are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_predelete_entries_bu_bootstrap;
DROP TRIGGER IF EXISTS trg_tenant_db_predelete_entries_bd_bootstrap;
CREATE TRIGGER trg_tenant_db_predelete_entries_bd_bootstrap BEFORE DELETE ON tenant_database_purge_predelete_entries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge predelete entries are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_predelete_entries_bd;
CREATE TRIGGER trg_tenant_db_predelete_entries_bd BEFORE DELETE ON tenant_database_purge_predelete_entries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge predelete entries are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_predelete_entries_bd_guard_a;
CREATE TRIGGER trg_tenant_db_predelete_entries_bd_guard_a BEFORE DELETE ON tenant_database_purge_predelete_entries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge predelete entries are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_predelete_entries_bd_guard_b;
CREATE TRIGGER trg_tenant_db_predelete_entries_bd_guard_b BEFORE DELETE ON tenant_database_purge_predelete_entries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge predelete entries are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_predelete_entries_bd_bootstrap;

DROP TRIGGER IF EXISTS trg_tenant_db_predelete_receipts_bu_bootstrap;
CREATE TRIGGER trg_tenant_db_predelete_receipts_bu_bootstrap BEFORE UPDATE ON tenant_database_purge_predelete_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge predelete receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_predelete_receipts_bu;
CREATE TRIGGER trg_tenant_db_predelete_receipts_bu BEFORE UPDATE ON tenant_database_purge_predelete_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge predelete receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_predelete_receipts_bu_guard_a;
CREATE TRIGGER trg_tenant_db_predelete_receipts_bu_guard_a BEFORE UPDATE ON tenant_database_purge_predelete_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge predelete receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_predelete_receipts_bu_guard_b;
CREATE TRIGGER trg_tenant_db_predelete_receipts_bu_guard_b BEFORE UPDATE ON tenant_database_purge_predelete_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge predelete receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_predelete_receipts_bu_bootstrap;
DROP TRIGGER IF EXISTS trg_tenant_db_predelete_receipts_bd_bootstrap;
CREATE TRIGGER trg_tenant_db_predelete_receipts_bd_bootstrap BEFORE DELETE ON tenant_database_purge_predelete_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge predelete receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_predelete_receipts_bd;
CREATE TRIGGER trg_tenant_db_predelete_receipts_bd BEFORE DELETE ON tenant_database_purge_predelete_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge predelete receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_predelete_receipts_bd_guard_a;
CREATE TRIGGER trg_tenant_db_predelete_receipts_bd_guard_a BEFORE DELETE ON tenant_database_purge_predelete_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge predelete receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_predelete_receipts_bd_guard_b;
CREATE TRIGGER trg_tenant_db_predelete_receipts_bd_guard_b BEFORE DELETE ON tenant_database_purge_predelete_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge predelete receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_predelete_receipts_bd_bootstrap;

DROP TRIGGER IF EXISTS trg_tenant_db_purge_acks_bu_bootstrap;
CREATE TRIGGER trg_tenant_db_purge_acks_bu_bootstrap BEFORE UPDATE ON tenant_database_purge_domain_acks FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge domain ACKs are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_purge_acks_bu;
CREATE TRIGGER trg_tenant_db_purge_acks_bu BEFORE UPDATE ON tenant_database_purge_domain_acks FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge domain ACKs are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_purge_acks_bu_guard_a;
CREATE TRIGGER trg_tenant_db_purge_acks_bu_guard_a BEFORE UPDATE ON tenant_database_purge_domain_acks FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge domain ACKs are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_purge_acks_bu_guard_b;
CREATE TRIGGER trg_tenant_db_purge_acks_bu_guard_b BEFORE UPDATE ON tenant_database_purge_domain_acks FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge domain ACKs are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_purge_acks_bu_bootstrap;
DROP TRIGGER IF EXISTS trg_tenant_db_purge_acks_bd_bootstrap;
CREATE TRIGGER trg_tenant_db_purge_acks_bd_bootstrap BEFORE DELETE ON tenant_database_purge_domain_acks FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge domain ACKs are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_purge_acks_bd;
CREATE TRIGGER trg_tenant_db_purge_acks_bd BEFORE DELETE ON tenant_database_purge_domain_acks FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge domain ACKs are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_purge_acks_bd_guard_a;
CREATE TRIGGER trg_tenant_db_purge_acks_bd_guard_a BEFORE DELETE ON tenant_database_purge_domain_acks FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge domain ACKs are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_purge_acks_bd_guard_b;
CREATE TRIGGER trg_tenant_db_purge_acks_bd_guard_b BEFORE DELETE ON tenant_database_purge_domain_acks FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge domain ACKs are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_purge_acks_bd_bootstrap;

DROP TRIGGER IF EXISTS trg_tenant_db_purge_receipts_bu_bootstrap;
CREATE TRIGGER trg_tenant_db_purge_receipts_bu_bootstrap BEFORE UPDATE ON tenant_database_purge_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_purge_receipts_bu;
CREATE TRIGGER trg_tenant_db_purge_receipts_bu BEFORE UPDATE ON tenant_database_purge_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_purge_receipts_bu_guard_a;
CREATE TRIGGER trg_tenant_db_purge_receipts_bu_guard_a BEFORE UPDATE ON tenant_database_purge_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_purge_receipts_bu_guard_b;
CREATE TRIGGER trg_tenant_db_purge_receipts_bu_guard_b BEFORE UPDATE ON tenant_database_purge_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_purge_receipts_bu_bootstrap;
DROP TRIGGER IF EXISTS trg_tenant_db_purge_receipts_bd_bootstrap;
CREATE TRIGGER trg_tenant_db_purge_receipts_bd_bootstrap BEFORE DELETE ON tenant_database_purge_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_purge_receipts_bd;
CREATE TRIGGER trg_tenant_db_purge_receipts_bd BEFORE DELETE ON tenant_database_purge_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_purge_receipts_bd_guard_a;
CREATE TRIGGER trg_tenant_db_purge_receipts_bd_guard_a BEFORE DELETE ON tenant_database_purge_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_purge_receipts_bd_guard_b;
CREATE TRIGGER trg_tenant_db_purge_receipts_bd_guard_b BEFORE DELETE ON tenant_database_purge_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_purge_receipts_bd_bootstrap;

DROP TRIGGER IF EXISTS trg_tenant_db_graves_bu_bootstrap;
CREATE TRIGGER trg_tenant_db_graves_bu_bootstrap BEFORE UPDATE ON tenant_purge_session_grave_markers FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge session grave markers are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_graves_bu;
CREATE TRIGGER trg_tenant_db_graves_bu BEFORE UPDATE ON tenant_purge_session_grave_markers FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge session grave markers are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_graves_bu_guard_a;
CREATE TRIGGER trg_tenant_db_graves_bu_guard_a BEFORE UPDATE ON tenant_purge_session_grave_markers FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge session grave markers are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_graves_bu_guard_b;
CREATE TRIGGER trg_tenant_db_graves_bu_guard_b BEFORE UPDATE ON tenant_purge_session_grave_markers FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge session grave markers are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_graves_bu_bootstrap;
DROP TRIGGER IF EXISTS trg_tenant_db_graves_bd_bootstrap;
CREATE TRIGGER trg_tenant_db_graves_bd_bootstrap BEFORE DELETE ON tenant_purge_session_grave_markers FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge session grave markers are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_graves_bd;
CREATE TRIGGER trg_tenant_db_graves_bd BEFORE DELETE ON tenant_purge_session_grave_markers FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge session grave markers are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_graves_bd_guard_a;
CREATE TRIGGER trg_tenant_db_graves_bd_guard_a BEFORE DELETE ON tenant_purge_session_grave_markers FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge session grave markers are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_graves_bd_guard_b;
CREATE TRIGGER trg_tenant_db_graves_bd_guard_b BEFORE DELETE ON tenant_purge_session_grave_markers FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge session grave markers are append-only';
DROP TRIGGER IF EXISTS trg_tenant_db_graves_bd_bootstrap;

-- The global cutover may move from inactive to active exactly once and is otherwise immutable.
DROP TRIGGER IF EXISTS trg_tenant_db_purge_cutover_bu_bootstrap;
CREATE TRIGGER trg_tenant_db_purge_cutover_bu_bootstrap BEFORE UPDATE ON tenant_database_purge_cutover FOR EACH ROW BEGIN IF NOT (OLD.singleton_id=1 AND NEW.singleton_id=1 AND OLD.control_generation=0 AND OLD.activated_at_db_ms IS NULL AND OLD.first_request_id IS NULL AND OLD.first_receipt_sha256 IS NULL AND OLD.evidence_sha256 IS NULL AND NEW.control_generation=1 AND NEW.activated_at_db_ms IS NOT NULL AND NEW.first_request_id IS NOT NULL AND NEW.first_receipt_sha256 IS NOT NULL AND NEW.evidence_sha256 IS NOT NULL) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge cutover is write-once'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_db_purge_cutover_bu;
CREATE TRIGGER trg_tenant_db_purge_cutover_bu BEFORE UPDATE ON tenant_database_purge_cutover FOR EACH ROW BEGIN IF NOT (OLD.singleton_id=1 AND NEW.singleton_id=1 AND OLD.control_generation=0 AND OLD.activated_at_db_ms IS NULL AND OLD.first_request_id IS NULL AND OLD.first_receipt_sha256 IS NULL AND OLD.evidence_sha256 IS NULL AND NEW.control_generation=1 AND NEW.activated_at_db_ms IS NOT NULL AND NEW.first_request_id IS NOT NULL AND NEW.first_receipt_sha256 IS NOT NULL AND NEW.evidence_sha256 IS NOT NULL) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge cutover is write-once'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_db_purge_cutover_bu_guard_a;
CREATE TRIGGER trg_tenant_db_purge_cutover_bu_guard_a BEFORE UPDATE ON tenant_database_purge_cutover FOR EACH ROW BEGIN IF NOT (OLD.singleton_id=1 AND NEW.singleton_id=1 AND OLD.control_generation=0 AND OLD.activated_at_db_ms IS NULL AND OLD.first_request_id IS NULL AND OLD.first_receipt_sha256 IS NULL AND OLD.evidence_sha256 IS NULL AND NEW.control_generation=1 AND NEW.activated_at_db_ms IS NOT NULL AND NEW.first_request_id IS NOT NULL AND NEW.first_receipt_sha256 IS NOT NULL AND NEW.evidence_sha256 IS NOT NULL) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge cutover is write-once'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_db_purge_cutover_bu_guard_b;
CREATE TRIGGER trg_tenant_db_purge_cutover_bu_guard_b BEFORE UPDATE ON tenant_database_purge_cutover FOR EACH ROW BEGIN IF NOT (OLD.singleton_id=1 AND NEW.singleton_id=1 AND OLD.control_generation=0 AND OLD.activated_at_db_ms IS NULL AND OLD.first_request_id IS NULL AND OLD.first_receipt_sha256 IS NULL AND OLD.evidence_sha256 IS NULL AND NEW.control_generation=1 AND NEW.activated_at_db_ms IS NOT NULL AND NEW.first_request_id IS NOT NULL AND NEW.first_receipt_sha256 IS NOT NULL AND NEW.evidence_sha256 IS NOT NULL) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge cutover is write-once'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_db_purge_cutover_bu_bootstrap;
DROP TRIGGER IF EXISTS trg_tenant_db_purge_cutover_bd_bootstrap;
CREATE TRIGGER trg_tenant_db_purge_cutover_bd_bootstrap BEFORE DELETE ON tenant_database_purge_cutover FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge cutover cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_db_purge_cutover_bd;
CREATE TRIGGER trg_tenant_db_purge_cutover_bd BEFORE DELETE ON tenant_database_purge_cutover FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge cutover cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_db_purge_cutover_bd_guard_a;
CREATE TRIGGER trg_tenant_db_purge_cutover_bd_guard_a BEFORE DELETE ON tenant_database_purge_cutover FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge cutover cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_db_purge_cutover_bd_guard_b;
CREATE TRIGGER trg_tenant_db_purge_cutover_bd_guard_b BEFORE DELETE ON tenant_database_purge_cutover FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant database purge cutover cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_db_purge_cutover_bd_bootstrap;

-- Once a session has been physically removed, its globally unique id can never be reused. This
-- guard is dormant until runtime writes the first source-bound grave marker.
DROP TRIGGER IF EXISTS trg_sessions_bi_tenant_purge_grave_bootstrap;
CREATE TRIGGER trg_sessions_bi_tenant_purge_grave_bootstrap BEFORE INSERT ON sessions FOR EACH ROW BEGIN IF EXISTS (SELECT 1 FROM tenant_purge_session_grave_markers WHERE session_id=NEW.session_id) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='purged session id cannot be reused'; END IF; END;
DROP TRIGGER IF EXISTS trg_sessions_bi_tenant_purge_grave;
CREATE TRIGGER trg_sessions_bi_tenant_purge_grave BEFORE INSERT ON sessions FOR EACH ROW BEGIN IF EXISTS (SELECT 1 FROM tenant_purge_session_grave_markers WHERE session_id=NEW.session_id) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='purged session id cannot be reused'; END IF; END;
DROP TRIGGER IF EXISTS trg_sessions_bi_tenant_purge_grave_guard_a;
CREATE TRIGGER trg_sessions_bi_tenant_purge_grave_guard_a BEFORE INSERT ON sessions FOR EACH ROW BEGIN IF EXISTS (SELECT 1 FROM tenant_purge_session_grave_markers WHERE session_id=NEW.session_id) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='purged session id cannot be reused'; END IF; END;
DROP TRIGGER IF EXISTS trg_sessions_bi_tenant_purge_grave_guard_b;
CREATE TRIGGER trg_sessions_bi_tenant_purge_grave_guard_b BEFORE INSERT ON sessions FOR EACH ROW BEGIN IF EXISTS (SELECT 1 FROM tenant_purge_session_grave_markers WHERE session_id=NEW.session_id) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='purged session id cannot be reused'; END IF; END;
DROP TRIGGER IF EXISTS trg_sessions_bi_tenant_purge_grave_bootstrap;

-- Reject missing/extra migration-owned triggers and body drift. Marker-loss replay recreates every
-- known trigger before this exact body fingerprint is checked.
SET @tenant_database_purge_trigger_set_ok = (
  SELECT COUNT(*)=45
     AND COUNT(DISTINCT trigger_name)=45
     AND COUNT(DISTINCT CONCAT(event_object_table,'~',event_manipulation,'~',trigger_name))=45
     AND SHA2(GROUP_CONCAT(CONCAT_WS('~',event_object_table,trigger_name,
           action_timing,event_manipulation,action_orientation,
           IFNULL(action_condition,'<NULL>'),
           LOWER(REGEXP_REPLACE(action_statement,'[[:space:]]','')))
         ORDER BY event_object_table,trigger_name SEPARATOR '|'),256)
       = 'f9053cbfb72a87035477c2457e91bc1968bbc319904089f0d655498180ee4766'
    FROM information_schema.triggers
   WHERE trigger_schema=DATABASE()
     AND (trigger_name LIKE 'trg_tenant_db_%'
       OR trigger_name LIKE 'trg_sessions_bi_tenant_purge_grave%')
);
SET @migration_sql = IF(@tenant_database_purge_trigger_set_ok=1, 'SELECT 1',
  'SELECT 1 FROM __invalid_tenant_database_purge_trigger_set__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
SET SESSION group_concat_max_len = @tenant_database_purge_previous_group_concat_max_len;
