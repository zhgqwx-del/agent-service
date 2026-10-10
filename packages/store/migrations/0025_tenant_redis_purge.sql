-- Expand-only, default-dormant substrate for T3g Redis session-state purge evidence.
--
-- The migration never contacts Redis and creates no job, target, ACK, receipt, or restore fence.
-- Runtime execution remains independently gated and can only start from a terminal 0024 receipt.

SET @tenant_redis_purge_previous_group_concat_max_len = @@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len = 1048576;

CREATE TABLE IF NOT EXISTS tenant_redis_purge_jobs (
  request_id                        VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                         VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation                BIGINT UNSIGNED NOT NULL,
  plan_build_generation             BIGINT UNSIGNED NOT NULL,
  execution_generation              BIGINT UNSIGNED NOT NULL,
  database_purge_generation         BIGINT UNSIGNED NOT NULL,
  redis_purge_generation            BIGINT UNSIGNED NOT NULL,
  t3c_receipt_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  plan_receipt_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  redis_plan_entry_count            BIGINT UNSIGNED NOT NULL,
  redis_plan_entry_root_sha256      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  database_purge_receipt_sha256     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  grave_marker_count                BIGINT UNSIGNED NOT NULL,
  grave_marker_root_sha256          CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  redis_namespace_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  policy_sha256                     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  purge_not_before_db_ms            BIGINT NOT NULL,
  source_evidence_db_ms             BIGINT NOT NULL,
  source_unresolved_blocker_count   BIGINT UNSIGNED NOT NULL,
  phase                             VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_count                      BIGINT UNSIGNED NOT NULL,
  target_root_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_ack_count                  BIGINT UNSIGNED NOT NULL,
  target_ack_root_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  domain_ack_count                  BIGINT UNSIGNED NOT NULL,
  domain_ack_root_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  marker_count                      BIGINT UNSIGNED NOT NULL,
  marker_root_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  unresolved_blocker_count          BIGINT UNSIGNED NOT NULL,
  terminal_receipt_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  available_at_ms                   BIGINT NULL,
  attempts                          INT UNSIGNED NOT NULL DEFAULT 0,
  claim_token                       VARCHAR(128) COLLATE utf8mb4_0900_as_cs NULL,
  lease_until_ms                    BIGINT NULL,
  last_error_code                   VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL,
  created_at_ms                     BIGINT NOT NULL,
  updated_at_ms                     BIGINT NOT NULL,
  sealed_at_db_ms                   BIGINT NULL,
  completed_claim_attempt           INT UNSIGNED NULL,
  completed_claim_token_sha256      CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  blocked_at_db_ms                  BIGINT NULL,
  blocked_reason_code               VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL,
  PRIMARY KEY (request_id),
  UNIQUE KEY uk_tenant_redis_purge_jobs_tenant (tenant_id),
  UNIQUE KEY uk_tenant_redis_purge_jobs_generation
    (tenant_id, subject_generation, redis_purge_generation),
  UNIQUE KEY uk_tenant_redis_purge_jobs_identity
    (request_id, tenant_id, subject_generation, plan_build_generation,
     execution_generation, database_purge_generation, redis_purge_generation),
  KEY idx_tenant_redis_purge_jobs_claim
    (phase, available_at_ms, lease_until_ms, request_id),
  KEY idx_tenant_redis_purge_jobs_source
    (request_id, database_purge_receipt_sha256),
  CONSTRAINT fk_tenant_redis_purge_job_source
    FOREIGN KEY (request_id, database_purge_receipt_sha256)
    REFERENCES tenant_database_purge_receipts (request_id, receipt_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tenant_redis_purge_job_generations CHECK (
    subject_generation > 0 AND plan_build_generation > 0
    AND execution_generation > 0 AND database_purge_generation > 0
    AND redis_purge_generation > 0
  ),
  CONSTRAINT chk_tenant_redis_purge_job_clock CHECK (
    purge_not_before_db_ms >= 0 AND source_evidence_db_ms >= purge_not_before_db_ms
    AND created_at_ms >= source_evidence_db_ms AND updated_at_ms >= created_at_ms
  ),
  CONSTRAINT chk_tenant_redis_purge_job_progress CHECK (
    redis_plan_entry_count = 3
    AND source_unresolved_blocker_count BETWEEN 3 AND 33
    AND target_count = grave_marker_count
    AND target_ack_count <= target_count AND marker_count = target_ack_count
    AND unresolved_blocker_count <= source_unresolved_blocker_count
  ),
  CONSTRAINT chk_tenant_redis_purge_job_phase CHECK (
    (phase = 'queued'
      AND available_at_ms IS NOT NULL
      AND ((claim_token IS NULL AND lease_until_ms IS NULL
            AND available_at_ms >= updated_at_ms)
        OR (claim_token IS NOT NULL AND lease_until_ms IS NOT NULL
            AND attempts > 0 AND lease_until_ms >= updated_at_ms))
      AND ((claim_token IS NOT NULL AND last_error_code IS NULL)
        OR (claim_token IS NULL AND (last_error_code IS NULL
          OR last_error_code IN ('temporary_failure','dependency_pending'))))
      AND domain_ack_count = 0
      AND domain_ack_root_sha256 =
        'f9b65703a98690e9f2f1cef6a235df40d5b34eb155b63005345353ff2c047f84'
      AND unresolved_blocker_count = source_unresolved_blocker_count
      AND terminal_receipt_sha256 IS NULL AND sealed_at_db_ms IS NULL
      AND completed_claim_attempt IS NULL AND completed_claim_token_sha256 IS NULL
      AND blocked_at_db_ms IS NULL AND blocked_reason_code IS NULL)
    OR
    (phase = 'redis_purge_sealed'
      AND available_at_ms IS NULL AND claim_token IS NULL AND lease_until_ms IS NULL
      AND last_error_code IS NULL AND target_ack_count = target_count
      AND marker_count = target_count AND domain_ack_count = 3
      AND unresolved_blocker_count = source_unresolved_blocker_count - 3
      AND terminal_receipt_sha256 IS NOT NULL AND sealed_at_db_ms IS NOT NULL
      AND sealed_at_db_ms >= source_evidence_db_ms AND sealed_at_db_ms <= updated_at_ms
      AND completed_claim_attempt IS NOT NULL
      AND completed_claim_attempt = attempts AND attempts > 0
      AND completed_claim_token_sha256 IS NOT NULL
      AND blocked_at_db_ms IS NULL AND blocked_reason_code IS NULL)
    OR
    (phase = 'blocked'
      AND available_at_ms IS NULL AND claim_token IS NULL AND lease_until_ms IS NULL
      AND last_error_code IS NULL AND domain_ack_count = 0
      AND domain_ack_root_sha256 =
        'f9b65703a98690e9f2f1cef6a235df40d5b34eb155b63005345353ff2c047f84'
      AND unresolved_blocker_count = source_unresolved_blocker_count
      AND terminal_receipt_sha256 IS NULL AND sealed_at_db_ms IS NULL
      AND completed_claim_attempt IS NULL AND completed_claim_token_sha256 IS NULL
      AND blocked_at_db_ms IS NOT NULL AND blocked_at_db_ms >= created_at_ms
      AND blocked_at_db_ms <= updated_at_ms AND attempts > 0
      AND blocked_reason_code = 'integrity_conflict')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT request_id, tenant_id, subject_generation, plan_build_generation,
       execution_generation, database_purge_generation, redis_purge_generation,
       t3c_receipt_sha256, plan_receipt_sha256, redis_plan_entry_count,
       redis_plan_entry_root_sha256, database_purge_receipt_sha256,
       grave_marker_count, grave_marker_root_sha256, redis_namespace_sha256,
       policy_sha256, purge_not_before_db_ms, source_evidence_db_ms,
       source_unresolved_blocker_count, phase, target_count, target_root_sha256,
       target_ack_count, target_ack_root_sha256, domain_ack_count,
       domain_ack_root_sha256, marker_count, marker_root_sha256,
       unresolved_blocker_count, terminal_receipt_sha256, available_at_ms,
       attempts, claim_token, lease_until_ms, last_error_code, created_at_ms,
       updated_at_ms, sealed_at_db_ms, completed_claim_attempt,
       completed_claim_token_sha256, blocked_at_db_ms, blocked_reason_code
  FROM tenant_redis_purge_jobs FORCE INDEX (
    PRIMARY, uk_tenant_redis_purge_jobs_tenant,
    uk_tenant_redis_purge_jobs_generation, uk_tenant_redis_purge_jobs_identity,
    idx_tenant_redis_purge_jobs_claim, idx_tenant_redis_purge_jobs_source
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_redis_purge_targets (
  scope                         VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_id                    VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                     VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation            BIGINT UNSIGNED NOT NULL,
  plan_build_generation         BIGINT UNSIGNED NOT NULL,
  execution_generation          BIGINT UNSIGNED NOT NULL,
  database_purge_generation     BIGINT UNSIGNED NOT NULL,
  redis_purge_generation        BIGINT UNSIGNED NOT NULL,
  target_ordinal                BIGINT UNSIGNED NOT NULL,
  session_id                    VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  grave_marker_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  redis_namespace_sha256        CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  lease_plan_target_sha256      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  fence_plan_target_sha256      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  stream_plan_target_sha256     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  operation_sha256              CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  captured_at_db_ms             BIGINT NOT NULL,
  receipt_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (request_id, redis_purge_generation, target_ordinal),
  UNIQUE KEY uk_tenant_redis_purge_targets_session
    (request_id, redis_purge_generation, session_id),
  UNIQUE KEY uk_tenant_redis_purge_targets_operation
    (request_id, redis_purge_generation, operation_sha256),
  UNIQUE KEY uk_tenant_redis_purge_targets_receipt
    (request_id, redis_purge_generation, receipt_sha256),
  UNIQUE KEY uk_tenant_redis_purge_targets_ack_fk
    (request_id, tenant_id, subject_generation, plan_build_generation,
     execution_generation, database_purge_generation, redis_purge_generation,
     target_ordinal, session_id, receipt_sha256, operation_sha256),
  KEY idx_tenant_redis_purge_targets_grave (session_id),
  CONSTRAINT fk_tenant_redis_purge_target_job
    FOREIGN KEY (request_id, tenant_id, subject_generation, plan_build_generation,
                 execution_generation, database_purge_generation,
                 redis_purge_generation)
    REFERENCES tenant_redis_purge_jobs
      (request_id, tenant_id, subject_generation, plan_build_generation,
       execution_generation, database_purge_generation, redis_purge_generation)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tenant_redis_purge_target_grave
    FOREIGN KEY (session_id) REFERENCES tenant_purge_session_grave_markers (session_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tenant_redis_purge_target_scope CHECK (
    scope = 'tenant-redis-purge-target-v1'
  ),
  CONSTRAINT chk_tenant_redis_purge_target_generation CHECK (
    subject_generation > 0 AND plan_build_generation > 0
    AND execution_generation > 0 AND database_purge_generation > 0
    AND redis_purge_generation > 0 AND captured_at_db_ms >= 0
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT scope, request_id, tenant_id, subject_generation, plan_build_generation,
       execution_generation, database_purge_generation, redis_purge_generation,
       target_ordinal, session_id, grave_marker_sha256, redis_namespace_sha256,
       lease_plan_target_sha256, fence_plan_target_sha256,
       stream_plan_target_sha256, operation_sha256, captured_at_db_ms,
       receipt_sha256
  FROM tenant_redis_purge_targets FORCE INDEX (
    PRIMARY, uk_tenant_redis_purge_targets_session,
    uk_tenant_redis_purge_targets_operation, uk_tenant_redis_purge_targets_receipt,
    uk_tenant_redis_purge_targets_ack_fk, idx_tenant_redis_purge_targets_grave
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_redis_purge_restore_sequence (
  singleton_id       TINYINT UNSIGNED NOT NULL,
  next_restore_seq   BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (singleton_id),
  CONSTRAINT chk_tenant_redis_purge_restore_sequence CHECK (
    singleton_id = 1 AND next_restore_seq > 0
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT singleton_id, next_restore_seq
  FROM tenant_redis_purge_restore_sequence FORCE INDEX (PRIMARY)
 WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_redis_purge_target_acks (
  restore_seq                   BIGINT UNSIGNED NOT NULL DEFAULT 0,
  scope                         VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_id                    VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                     VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation            BIGINT UNSIGNED NOT NULL,
  plan_build_generation         BIGINT UNSIGNED NOT NULL,
  execution_generation          BIGINT UNSIGNED NOT NULL,
  database_purge_generation     BIGINT UNSIGNED NOT NULL,
  redis_purge_generation        BIGINT UNSIGNED NOT NULL,
  target_ordinal                BIGINT UNSIGNED NOT NULL,
  session_id                    VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_receipt_sha256         CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  operation_sha256              CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  adapter_protocol              VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  redis_namespace_sha256        CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  lease_existed                 BOOLEAN NOT NULL,
  fence_existed                 BOOLEAN NOT NULL,
  stream_existed                BOOLEAN NOT NULL,
  marker_sha256                 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  completed_claim_attempt       INT UNSIGNED NOT NULL,
  completed_claim_token_sha256  CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  store_db_timestamp_ms         BIGINT NOT NULL,
  receipt_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (request_id, redis_purge_generation, target_ordinal),
  UNIQUE KEY uk_tenant_redis_purge_target_acks_restore_seq (restore_seq),
  UNIQUE KEY uk_tenant_redis_purge_target_acks_session
    (request_id, redis_purge_generation, session_id),
  UNIQUE KEY uk_tenant_redis_purge_target_acks_operation
    (request_id, redis_purge_generation, operation_sha256),
  UNIQUE KEY uk_tenant_redis_purge_target_acks_marker (marker_sha256),
  UNIQUE KEY uk_tenant_redis_purge_target_acks_receipt (receipt_sha256),
  KEY idx_tenant_redis_purge_target_acks_target
    (request_id, tenant_id, subject_generation, plan_build_generation,
     execution_generation, database_purge_generation, redis_purge_generation,
     target_ordinal, session_id, target_receipt_sha256, operation_sha256),
  CONSTRAINT fk_tenant_redis_purge_target_ack_target
    FOREIGN KEY (request_id, tenant_id, subject_generation, plan_build_generation,
                 execution_generation, database_purge_generation,
                 redis_purge_generation, target_ordinal, session_id,
                 target_receipt_sha256, operation_sha256)
    REFERENCES tenant_redis_purge_targets
      (request_id, tenant_id, subject_generation, plan_build_generation,
       execution_generation, database_purge_generation, redis_purge_generation,
       target_ordinal, session_id, receipt_sha256, operation_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tenant_redis_purge_target_ack_scope CHECK (
    scope = 'tenant-redis-purge-target-ack-v1'
  ),
  CONSTRAINT chk_tenant_redis_purge_target_ack_generation CHECK (
    restore_seq > 0 AND subject_generation > 0 AND plan_build_generation > 0
    AND execution_generation > 0 AND database_purge_generation > 0
    AND redis_purge_generation > 0 AND completed_claim_attempt > 0
    AND store_db_timestamp_ms >= 0
  ),
  CONSTRAINT chk_tenant_redis_purge_target_ack_protocol CHECK (
    adapter_protocol = 'redis-session-state-delete-v1'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT restore_seq, scope, request_id, tenant_id, subject_generation, plan_build_generation,
       execution_generation, database_purge_generation, redis_purge_generation,
       target_ordinal, session_id, target_receipt_sha256, operation_sha256,
       adapter_protocol, redis_namespace_sha256, lease_existed, fence_existed,
       stream_existed, marker_sha256, completed_claim_attempt,
       completed_claim_token_sha256, store_db_timestamp_ms, receipt_sha256
  FROM tenant_redis_purge_target_acks FORCE INDEX (
    PRIMARY, uk_tenant_redis_purge_target_acks_session,
    uk_tenant_redis_purge_target_acks_operation,
    uk_tenant_redis_purge_target_acks_marker,
    uk_tenant_redis_purge_target_acks_receipt,
    uk_tenant_redis_purge_target_acks_restore_seq,
    idx_tenant_redis_purge_target_acks_target
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_redis_purge_domain_acks (
  scope                         VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_id                    VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                     VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation            BIGINT UNSIGNED NOT NULL,
  plan_build_generation         BIGINT UNSIGNED NOT NULL,
  execution_generation          BIGINT UNSIGNED NOT NULL,
  database_purge_generation     BIGINT UNSIGNED NOT NULL,
  redis_purge_generation        BIGINT UNSIGNED NOT NULL,
  domain                        VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  domain_ordinal                TINYINT UNSIGNED NOT NULL,
  global_ack_seq                TINYINT UNSIGNED NOT NULL,
  previous_global_ack_sha256    CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  plan_entry_receipt_sha256     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  plan_target_count             BIGINT UNSIGNED NOT NULL,
  plan_target_root_sha256       CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  affected_count                BIGINT UNSIGNED NOT NULL,
  target_ack_count              BIGINT UNSIGNED NOT NULL,
  target_ack_root_sha256        CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  marker_count                  BIGINT UNSIGNED NOT NULL,
  marker_root_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  adapter_protocol              VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  redis_namespace_sha256        CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  completed_claim_attempt       INT UNSIGNED NOT NULL,
  completed_claim_token_sha256  CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  store_db_timestamp_ms         BIGINT NOT NULL,
  receipt_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (request_id, redis_purge_generation, global_ack_seq),
  UNIQUE KEY uk_tenant_redis_purge_domain_acks_domain
    (request_id, redis_purge_generation, domain),
  UNIQUE KEY uk_tenant_redis_purge_domain_acks_ordinal
    (request_id, redis_purge_generation, domain_ordinal),
  UNIQUE KEY uk_tenant_redis_purge_domain_acks_receipt (receipt_sha256),
  KEY idx_tenant_redis_purge_domain_acks_plan
    (request_id, plan_build_generation, plan_entry_receipt_sha256),
  KEY idx_tenant_redis_purge_domain_acks_job
    (request_id, tenant_id, subject_generation, plan_build_generation,
     execution_generation, database_purge_generation, redis_purge_generation),
  CONSTRAINT fk_tenant_redis_purge_domain_ack_job
    FOREIGN KEY (request_id, tenant_id, subject_generation, plan_build_generation,
                 execution_generation, database_purge_generation,
                 redis_purge_generation)
    REFERENCES tenant_redis_purge_jobs
      (request_id, tenant_id, subject_generation, plan_build_generation,
       execution_generation, database_purge_generation, redis_purge_generation)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_tenant_redis_purge_domain_ack_plan
    FOREIGN KEY (request_id, plan_build_generation, plan_entry_receipt_sha256)
    REFERENCES tenant_purge_plan_entries
      (request_id, build_generation, receipt_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tenant_redis_purge_domain_ack_scope CHECK (
    scope = 'tenant-redis-purge-domain-ack-v1'
  ),
  CONSTRAINT chk_tenant_redis_purge_domain_ack_identity CHECK (
    subject_generation > 0 AND plan_build_generation > 0
    AND execution_generation > 0 AND database_purge_generation > 0
    AND redis_purge_generation > 0 AND completed_claim_attempt > 0
    AND store_db_timestamp_ms >= 0
  ),
  CONSTRAINT chk_tenant_redis_purge_domain_ack_domain CHECK (
    domain IN ('redis_leases','redis_fences','redis_streams')
    AND domain_ordinal <= 2 AND global_ack_seq = domain_ordinal + 1
  ),
  CONSTRAINT chk_tenant_redis_purge_domain_ack_counts CHECK (
    plan_target_count = affected_count
    AND plan_target_count = target_ack_count
    AND plan_target_count = marker_count
  ),
  CONSTRAINT chk_tenant_redis_purge_domain_ack_protocol CHECK (
    adapter_protocol = 'redis-session-state-delete-v1'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT scope, request_id, tenant_id, subject_generation, plan_build_generation,
       execution_generation, database_purge_generation, redis_purge_generation,
       domain, domain_ordinal, global_ack_seq, previous_global_ack_sha256,
       plan_entry_receipt_sha256, plan_target_count, plan_target_root_sha256,
       affected_count, target_ack_count, target_ack_root_sha256, marker_count,
       marker_root_sha256, adapter_protocol, redis_namespace_sha256,
       completed_claim_attempt, completed_claim_token_sha256,
       store_db_timestamp_ms, receipt_sha256
  FROM tenant_redis_purge_domain_acks FORCE INDEX (
    PRIMARY, uk_tenant_redis_purge_domain_acks_domain,
    uk_tenant_redis_purge_domain_acks_ordinal,
    uk_tenant_redis_purge_domain_acks_receipt,
    idx_tenant_redis_purge_domain_acks_plan,
    idx_tenant_redis_purge_domain_acks_job
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_redis_purge_receipts (
  scope                         VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_id                    VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                     VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation            BIGINT UNSIGNED NOT NULL,
  plan_build_generation         BIGINT UNSIGNED NOT NULL,
  execution_generation          BIGINT UNSIGNED NOT NULL,
  database_purge_generation     BIGINT UNSIGNED NOT NULL,
  redis_purge_generation        BIGINT UNSIGNED NOT NULL,
  t3c_receipt_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  plan_receipt_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  redis_plan_entry_count        BIGINT UNSIGNED NOT NULL,
  redis_plan_entry_root_sha256  CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  database_purge_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  grave_marker_count            BIGINT UNSIGNED NOT NULL,
  grave_marker_root_sha256      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  redis_namespace_sha256        CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  policy_sha256                 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  purge_not_before_db_ms        BIGINT NOT NULL,
  source_evidence_db_ms         BIGINT NOT NULL,
  source_unresolved_blocker_count BIGINT UNSIGNED NOT NULL,
  target_count                  BIGINT UNSIGNED NOT NULL,
  target_root_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  target_ack_count              BIGINT UNSIGNED NOT NULL,
  target_ack_root_sha256        CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  domain_ack_count              BIGINT UNSIGNED NOT NULL,
  domain_ack_root_sha256        CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  marker_count                  BIGINT UNSIGNED NOT NULL,
  marker_root_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  unresolved_blocker_count      BIGINT UNSIGNED NOT NULL,
  store_db_timestamp_ms         BIGINT NOT NULL,
  completed_claim_attempt       INT UNSIGNED NOT NULL,
  completed_claim_token_sha256  CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  redis_purge_complete          BOOLEAN NOT NULL,
  all_domains_complete          BOOLEAN NOT NULL,
  content_purge_executed        BOOLEAN NOT NULL,
  receipt_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (request_id),
  UNIQUE KEY uk_tenant_redis_purge_receipts_tenant (tenant_id),
  UNIQUE KEY uk_tenant_redis_purge_receipts_generation
    (tenant_id, subject_generation, redis_purge_generation),
  UNIQUE KEY uk_tenant_redis_purge_receipts_hash (receipt_sha256),
  UNIQUE KEY uk_tenant_redis_purge_receipts_request_hash
    (request_id, receipt_sha256),
  KEY idx_tenant_redis_purge_receipts_job
    (request_id, tenant_id, subject_generation, plan_build_generation,
     execution_generation, database_purge_generation, redis_purge_generation),
  CONSTRAINT fk_tenant_redis_purge_receipt_job
    FOREIGN KEY (request_id, tenant_id, subject_generation, plan_build_generation,
                 execution_generation, database_purge_generation,
                 redis_purge_generation)
    REFERENCES tenant_redis_purge_jobs
      (request_id, tenant_id, subject_generation, plan_build_generation,
       execution_generation, database_purge_generation, redis_purge_generation)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tenant_redis_purge_receipt_scope CHECK (
    scope = 'tenant-redis-purge-v1'
  ),
  CONSTRAINT chk_tenant_redis_purge_receipt_identity CHECK (
    subject_generation > 0 AND plan_build_generation > 0
    AND execution_generation > 0 AND database_purge_generation > 0
    AND redis_purge_generation > 0 AND redis_plan_entry_count = 3
    AND source_unresolved_blocker_count BETWEEN 3 AND 33
  ),
  CONSTRAINT chk_tenant_redis_purge_receipt_counts CHECK (
    target_count = grave_marker_count AND target_ack_count = target_count
    AND marker_count = target_count AND domain_ack_count = 3
    AND unresolved_blocker_count = source_unresolved_blocker_count - 3
  ),
  CONSTRAINT chk_tenant_redis_purge_receipt_flags CHECK (
    purge_not_before_db_ms >= 0 AND source_evidence_db_ms >= purge_not_before_db_ms
    AND store_db_timestamp_ms >= source_evidence_db_ms
    AND completed_claim_attempt > 0 AND redis_purge_complete = TRUE
    AND all_domains_complete = FALSE AND content_purge_executed = FALSE
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT scope, request_id, tenant_id, subject_generation, plan_build_generation,
       execution_generation, database_purge_generation, redis_purge_generation,
       t3c_receipt_sha256, plan_receipt_sha256, redis_plan_entry_count,
       redis_plan_entry_root_sha256, database_purge_receipt_sha256,
       grave_marker_count, grave_marker_root_sha256, redis_namespace_sha256,
       policy_sha256, purge_not_before_db_ms, source_evidence_db_ms,
       source_unresolved_blocker_count, target_count, target_root_sha256,
       target_ack_count, target_ack_root_sha256, domain_ack_count,
       domain_ack_root_sha256, marker_count, marker_root_sha256,
       unresolved_blocker_count, store_db_timestamp_ms, completed_claim_attempt,
       completed_claim_token_sha256, redis_purge_complete, all_domains_complete,
       content_purge_executed, receipt_sha256
  FROM tenant_redis_purge_receipts FORCE INDEX (
    PRIMARY, uk_tenant_redis_purge_receipts_tenant,
    uk_tenant_redis_purge_receipts_generation,
    uk_tenant_redis_purge_receipts_hash,
    uk_tenant_redis_purge_receipts_request_hash,
    idx_tenant_redis_purge_receipts_job
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_redis_purge_cutover (
  singleton_id            TINYINT UNSIGNED NOT NULL,
  control_generation      BIGINT UNSIGNED NOT NULL,
  activated_at_db_ms      BIGINT NULL,
  first_request_id        VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  first_receipt_sha256    CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  redis_namespace_sha256  CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  evidence_sha256         CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  PRIMARY KEY (singleton_id),
  KEY idx_tenant_redis_purge_cutover_receipt
    (first_request_id, first_receipt_sha256),
  CONSTRAINT fk_tenant_redis_purge_cutover_receipt
    FOREIGN KEY (first_request_id, first_receipt_sha256)
    REFERENCES tenant_redis_purge_receipts (request_id, receipt_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_tenant_redis_purge_cutover_singleton CHECK (singleton_id = 1),
  CONSTRAINT chk_tenant_redis_purge_cutover_state CHECK (
    (control_generation = 0 AND activated_at_db_ms IS NULL
      AND first_request_id IS NULL AND first_receipt_sha256 IS NULL
      AND redis_namespace_sha256 IS NULL AND evidence_sha256 IS NULL)
    OR
    (control_generation = 1 AND activated_at_db_ms IS NOT NULL
      AND activated_at_db_ms >= 0 AND first_request_id IS NOT NULL
      AND first_receipt_sha256 IS NOT NULL
      AND redis_namespace_sha256 IS NOT NULL AND evidence_sha256 IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT singleton_id, control_generation, activated_at_db_ms, first_request_id,
       first_receipt_sha256, redis_namespace_sha256, evidence_sha256
  FROM tenant_redis_purge_cutover FORCE INDEX (
    PRIMARY, idx_tenant_redis_purge_cutover_receipt
  ) WHERE 1=0;

-- IF NOT EXISTS must not accept a partial auto-commit or a same-name weak schema. The FORCE INDEX
-- probes above bind every expected index; these exact cardinalities bind all migration-owned tables,
-- columns, indexes, constraints, and foreign-key columns before the migration marker is committed.
SET @tenant_redis_purge_schema_ok = (
  (SELECT COUNT(*) = 7
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,table_type,
             IFNULL(engine,'-'),IFNULL(table_collation,'-'))
           ORDER BY table_name SEPARATOR '|'),256)
         = '96a95980926d7ecba8a3f0a41daa3d778ebdcd17769ff794e7b2fe6949679268'
     FROM information_schema.tables
    WHERE table_schema=DATABASE() AND table_name IN (
      'tenant_redis_purge_jobs','tenant_redis_purge_targets',
      'tenant_redis_purge_restore_sequence',
      'tenant_redis_purge_target_acks','tenant_redis_purge_domain_acks',
      'tenant_redis_purge_receipts','tenant_redis_purge_cutover'))
  AND
  (SELECT COUNT(*) = 154
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,LPAD(ordinal_position,3,'0'),
             column_name,LOWER(column_type),is_nullable,
             IF(column_default IS NULL,'<NULL>',CONCAT('<',column_default,'>')),
             IFNULL(character_set_name,'-'),IFNULL(collation_name,'-'),
             IFNULL(NULLIF(LOWER(extra),''),'-'),
             IFNULL(NULLIF(LOWER(generation_expression),''),'-'))
           ORDER BY table_name,ordinal_position SEPARATOR '|'),256)
         = '018b2d3d522e610951005d39d660bbbc78db33a7d20677085b197f0f35eb122b'
     FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name IN (
      'tenant_redis_purge_jobs','tenant_redis_purge_targets',
      'tenant_redis_purge_restore_sequence',
      'tenant_redis_purge_target_acks','tenant_redis_purge_domain_acks',
      'tenant_redis_purge_receipts','tenant_redis_purge_cutover'))
  AND
  (SELECT COUNT(DISTINCT CONCAT(table_name,'~',index_name)) = 34
       AND COUNT(*) = 104
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,index_name,non_unique,
             seq_in_index,LOWER(index_type),LOWER(is_visible),
             IFNULL(column_name,'<expression>'),IFNULL(CAST(sub_part AS CHAR),'-'),
             LOWER(IFNULL(collation,'-')),IFNULL(expression,'-'))
           ORDER BY table_name,index_name,seq_in_index SEPARATOR '|'),256)
         = 'e3c0e6510b50792f57bf3f10f8c625d170035455126e272ac0de7f4ba6d1bd27'
     FROM information_schema.statistics
    WHERE table_schema=DATABASE() AND table_name IN (
      'tenant_redis_purge_jobs','tenant_redis_purge_targets',
      'tenant_redis_purge_restore_sequence',
      'tenant_redis_purge_target_acks','tenant_redis_purge_domain_acks',
      'tenant_redis_purge_receipts','tenant_redis_purge_cutover'))
  AND
  (SELECT COUNT(*) = 21
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',tc.table_name,tc.constraint_name,tc.enforced,
             LOWER(REPLACE(REPLACE(REGEXP_REPLACE(cc.check_clause,'[[:space:]]',''),
               CHAR(96),''),'_utf8mb4','')))
           ORDER BY tc.table_name,tc.constraint_name SEPARATOR '|'),256)
         = 'f381de6528106d253cb20d0cd6779bf9b35816b8c02d0a5580a65a12321549cf'
     FROM information_schema.table_constraints tc
     JOIN information_schema.check_constraints cc
       ON cc.constraint_schema=tc.constraint_schema
      AND cc.constraint_name=tc.constraint_name
    WHERE tc.table_schema=DATABASE() AND tc.constraint_type='CHECK'
      AND tc.table_name IN (
        'tenant_redis_purge_jobs','tenant_redis_purge_targets',
        'tenant_redis_purge_restore_sequence',
        'tenant_redis_purge_target_acks','tenant_redis_purge_domain_acks',
        'tenant_redis_purge_receipts','tenant_redis_purge_cutover'))
  AND
  (SELECT COUNT(*) = 55
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,
             constraint_type,enforced)
           ORDER BY table_name,constraint_name SEPARATOR '|'),256)
         = '5b00d3a7ce7f4b8c640875f09bb6d2efb1265c25f7b7a74a2a0b858e1ed74c34'
     FROM information_schema.table_constraints
    WHERE table_schema=DATABASE() AND table_name IN (
        'tenant_redis_purge_jobs','tenant_redis_purge_targets',
        'tenant_redis_purge_restore_sequence',
        'tenant_redis_purge_target_acks','tenant_redis_purge_domain_acks',
        'tenant_redis_purge_receipts','tenant_redis_purge_cutover'))
  AND
  (SELECT COUNT(*) = 40
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',k.table_name,k.constraint_name,
             k.ordinal_position,k.column_name,k.referenced_table_name,
             k.referenced_column_name,r.update_rule,r.delete_rule)
           ORDER BY k.table_name,k.constraint_name,k.ordinal_position SEPARATOR '|'),256)
         = '2cfab0437943357c7a5b131044063cca3847c514e6ae702f1fb81bd70fed5220'
     FROM information_schema.key_column_usage k
     JOIN information_schema.referential_constraints r
       ON r.constraint_schema=k.constraint_schema
      AND r.constraint_name=k.constraint_name
    WHERE k.table_schema=DATABASE() AND k.referenced_table_name IS NOT NULL
      AND k.table_name IN (
        'tenant_redis_purge_jobs','tenant_redis_purge_targets',
        'tenant_redis_purge_restore_sequence',
        'tenant_redis_purge_target_acks','tenant_redis_purge_domain_acks',
        'tenant_redis_purge_receipts','tenant_redis_purge_cutover'))
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.partitions
     WHERE table_schema=DATABASE() AND partition_name IS NOT NULL
       AND table_name IN (
         'tenant_redis_purge_jobs','tenant_redis_purge_targets',
         'tenant_redis_purge_restore_sequence',
         'tenant_redis_purge_target_acks','tenant_redis_purge_domain_acks',
         'tenant_redis_purge_receipts','tenant_redis_purge_cutover'))
);
SET @migration_sql = IF(@tenant_redis_purge_schema_ok=1, 'SELECT 1',
  'SELECT 1 FROM __invalid_tenant_redis_purge_schema__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

INSERT INTO tenant_redis_purge_restore_sequence (singleton_id, next_restore_seq)
SELECT 1, 1
 WHERE NOT EXISTS (
   SELECT 1 FROM tenant_redis_purge_restore_sequence WHERE singleton_id=1
 );

INSERT INTO tenant_redis_purge_cutover
  (singleton_id, control_generation, activated_at_db_ms, first_request_id,
   first_receipt_sha256, redis_namespace_sha256, evidence_sha256)
SELECT 1, 0, NULL, NULL, NULL, NULL, NULL
 WHERE NOT EXISTS (SELECT 1 FROM tenant_redis_purge_cutover WHERE singleton_id=1);

-- The job identity/source and target catalog are immutable. Queued updates are limited to claim,
-- renewal, retry, monotonic ACK progress, terminal seal, or deterministic integrity blocking.
DROP TRIGGER IF EXISTS trg_tenant_redis_purge_jobs_bu;
CREATE TRIGGER trg_tenant_redis_purge_jobs_bu BEFORE UPDATE ON tenant_redis_purge_jobs FOR EACH ROW BEGIN IF NOT (OLD.request_id <=> NEW.request_id AND OLD.tenant_id <=> NEW.tenant_id AND OLD.subject_generation <=> NEW.subject_generation AND OLD.plan_build_generation <=> NEW.plan_build_generation AND OLD.execution_generation <=> NEW.execution_generation AND OLD.database_purge_generation <=> NEW.database_purge_generation AND OLD.redis_purge_generation <=> NEW.redis_purge_generation AND OLD.t3c_receipt_sha256 <=> NEW.t3c_receipt_sha256 AND OLD.plan_receipt_sha256 <=> NEW.plan_receipt_sha256 AND OLD.redis_plan_entry_count <=> NEW.redis_plan_entry_count AND OLD.redis_plan_entry_root_sha256 <=> NEW.redis_plan_entry_root_sha256 AND OLD.database_purge_receipt_sha256 <=> NEW.database_purge_receipt_sha256 AND OLD.grave_marker_count <=> NEW.grave_marker_count AND OLD.grave_marker_root_sha256 <=> NEW.grave_marker_root_sha256 AND OLD.redis_namespace_sha256 <=> NEW.redis_namespace_sha256 AND OLD.policy_sha256 <=> NEW.policy_sha256 AND OLD.purge_not_before_db_ms <=> NEW.purge_not_before_db_ms AND OLD.source_evidence_db_ms <=> NEW.source_evidence_db_ms AND OLD.source_unresolved_blocker_count <=> NEW.source_unresolved_blocker_count AND OLD.target_count <=> NEW.target_count AND OLD.target_root_sha256 <=> NEW.target_root_sha256 AND OLD.created_at_ms <=> NEW.created_at_ms AND OLD.phase='queued' AND NEW.updated_at_ms>=OLD.updated_at_ms AND ((NEW.phase='queued' AND NEW.domain_ack_count=OLD.domain_ack_count AND NEW.domain_ack_root_sha256 <=> OLD.domain_ack_root_sha256 AND NEW.unresolved_blocker_count=OLD.unresolved_blocker_count AND NEW.terminal_receipt_sha256 <=> OLD.terminal_receipt_sha256 AND ((OLD.claim_token IS NULL AND NEW.claim_token IS NOT NULL AND NEW.attempts=OLD.attempts+1 AND NEW.available_at_ms <=> OLD.available_at_ms AND NEW.target_ack_count=OLD.target_ack_count AND NEW.target_ack_root_sha256 <=> OLD.target_ack_root_sha256 AND NEW.marker_count=OLD.marker_count AND NEW.marker_root_sha256 <=> OLD.marker_root_sha256) OR (OLD.claim_token IS NOT NULL AND OLD.lease_until_ms<=NEW.updated_at_ms AND NEW.claim_token IS NOT NULL AND NOT (NEW.claim_token <=> OLD.claim_token) AND NEW.lease_until_ms>NEW.updated_at_ms AND NEW.attempts=OLD.attempts+1 AND NEW.available_at_ms <=> OLD.available_at_ms AND NEW.target_ack_count=OLD.target_ack_count AND NEW.target_ack_root_sha256 <=> OLD.target_ack_root_sha256 AND NEW.marker_count=OLD.marker_count AND NEW.marker_root_sha256 <=> OLD.marker_root_sha256) OR (OLD.claim_token IS NOT NULL AND NEW.claim_token <=> OLD.claim_token AND NEW.attempts=OLD.attempts AND NEW.available_at_ms <=> OLD.available_at_ms AND NEW.lease_until_ms>=OLD.lease_until_ms AND NEW.target_ack_count=OLD.target_ack_count AND NEW.target_ack_root_sha256 <=> OLD.target_ack_root_sha256 AND NEW.marker_count=OLD.marker_count AND NEW.marker_root_sha256 <=> OLD.marker_root_sha256) OR (OLD.claim_token IS NOT NULL AND NEW.claim_token IS NULL AND NEW.attempts=OLD.attempts AND NEW.available_at_ms>=OLD.available_at_ms AND NEW.available_at_ms>=NEW.updated_at_ms AND NEW.target_ack_count=OLD.target_ack_count AND NEW.target_ack_root_sha256 <=> OLD.target_ack_root_sha256 AND NEW.marker_count=OLD.marker_count AND NEW.marker_root_sha256 <=> OLD.marker_root_sha256) OR (OLD.claim_token IS NOT NULL AND NEW.claim_token <=> OLD.claim_token AND NEW.attempts=OLD.attempts AND NEW.available_at_ms <=> OLD.available_at_ms AND NEW.lease_until_ms <=> OLD.lease_until_ms AND NEW.target_ack_count=OLD.target_ack_count+1 AND NOT (NEW.target_ack_root_sha256 <=> OLD.target_ack_root_sha256) AND NEW.marker_count=OLD.marker_count+1 AND NOT (NEW.marker_root_sha256 <=> OLD.marker_root_sha256)))) OR (NEW.phase='redis_purge_sealed' AND OLD.claim_token IS NOT NULL AND NEW.attempts=OLD.attempts AND NEW.target_ack_count=OLD.target_ack_count AND NEW.target_ack_root_sha256 <=> OLD.target_ack_root_sha256 AND NEW.marker_count=OLD.marker_count AND NEW.marker_root_sha256 <=> OLD.marker_root_sha256 AND NEW.domain_ack_count=3 AND NOT (NEW.domain_ack_root_sha256 <=> OLD.domain_ack_root_sha256) AND NEW.unresolved_blocker_count=OLD.unresolved_blocker_count-3) OR (NEW.phase='blocked' AND ((OLD.claim_token IS NOT NULL AND NEW.attempts=OLD.attempts) OR (OLD.available_at_ms<=NEW.updated_at_ms AND ((OLD.claim_token IS NULL AND OLD.lease_until_ms IS NULL) OR (OLD.claim_token IS NOT NULL AND OLD.lease_until_ms<=NEW.updated_at_ms)) AND NEW.attempts=OLD.attempts+1)) AND NEW.target_ack_count=OLD.target_ack_count AND NEW.target_ack_root_sha256 <=> OLD.target_ack_root_sha256 AND NEW.marker_count=OLD.marker_count AND NEW.marker_root_sha256 <=> OLD.marker_root_sha256 AND NEW.domain_ack_count=OLD.domain_ack_count AND NEW.domain_ack_root_sha256 <=> OLD.domain_ack_root_sha256 AND NEW.unresolved_blocker_count=OLD.unresolved_blocker_count))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant Redis purge job update is not permitted'; END IF; END;

DROP TRIGGER IF EXISTS trg_tenant_redis_purge_jobs_bd;
CREATE TRIGGER trg_tenant_redis_purge_jobs_bd BEFORE DELETE ON tenant_redis_purge_jobs
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant Redis purge jobs cannot be deleted';

DROP TRIGGER IF EXISTS trg_tenant_redis_purge_targets_bu;
CREATE TRIGGER trg_tenant_redis_purge_targets_bu BEFORE UPDATE ON tenant_redis_purge_targets
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant Redis purge targets are append-only';
DROP TRIGGER IF EXISTS trg_tenant_redis_purge_targets_bd;
CREATE TRIGGER trg_tenant_redis_purge_targets_bd BEFORE DELETE ON tenant_redis_purge_targets
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant Redis purge targets are append-only';

DROP TRIGGER IF EXISTS trg_tenant_redis_purge_restore_sequence_bu;
CREATE TRIGGER trg_tenant_redis_purge_restore_sequence_bu BEFORE UPDATE ON tenant_redis_purge_restore_sequence
FOR EACH ROW BEGIN IF NOT (OLD.singleton_id=1 AND NEW.singleton_id=1 AND NEW.next_restore_seq=OLD.next_restore_seq+1) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant Redis purge restore sequence must advance exactly once'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_redis_purge_restore_sequence_bd;
CREATE TRIGGER trg_tenant_redis_purge_restore_sequence_bd BEFORE DELETE ON tenant_redis_purge_restore_sequence
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant Redis purge restore sequence cannot be deleted';

DROP TRIGGER IF EXISTS trg_tenant_redis_purge_target_acks_bi;
CREATE TRIGGER trg_tenant_redis_purge_target_acks_bi BEFORE INSERT ON tenant_redis_purge_target_acks
FOR EACH ROW BEGIN DECLARE allocated_restore_seq BIGINT UNSIGNED DEFAULT NULL; SELECT next_restore_seq INTO allocated_restore_seq FROM tenant_redis_purge_restore_sequence WHERE singleton_id=1 FOR UPDATE; IF allocated_restore_seq IS NULL OR allocated_restore_seq>=9007199254740991 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant Redis purge restore sequence is unavailable'; END IF; SET NEW.restore_seq=allocated_restore_seq; UPDATE tenant_redis_purge_restore_sequence SET next_restore_seq=next_restore_seq+1 WHERE singleton_id=1; END;

DROP TRIGGER IF EXISTS trg_tenant_redis_purge_target_acks_bu;
CREATE TRIGGER trg_tenant_redis_purge_target_acks_bu BEFORE UPDATE ON tenant_redis_purge_target_acks
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant Redis purge target ACKs are append-only';
DROP TRIGGER IF EXISTS trg_tenant_redis_purge_target_acks_bd;
CREATE TRIGGER trg_tenant_redis_purge_target_acks_bd BEFORE DELETE ON tenant_redis_purge_target_acks
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant Redis purge target ACKs are append-only';

DROP TRIGGER IF EXISTS trg_tenant_redis_purge_domain_acks_bu;
CREATE TRIGGER trg_tenant_redis_purge_domain_acks_bu BEFORE UPDATE ON tenant_redis_purge_domain_acks
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant Redis purge domain ACKs are append-only';
DROP TRIGGER IF EXISTS trg_tenant_redis_purge_domain_acks_bd;
CREATE TRIGGER trg_tenant_redis_purge_domain_acks_bd BEFORE DELETE ON tenant_redis_purge_domain_acks
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant Redis purge domain ACKs are append-only';

DROP TRIGGER IF EXISTS trg_tenant_redis_purge_receipts_bu;
CREATE TRIGGER trg_tenant_redis_purge_receipts_bu BEFORE UPDATE ON tenant_redis_purge_receipts
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant Redis purge receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_redis_purge_receipts_bd;
CREATE TRIGGER trg_tenant_redis_purge_receipts_bd BEFORE DELETE ON tenant_redis_purge_receipts
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant Redis purge receipts are append-only';

DROP TRIGGER IF EXISTS trg_tenant_redis_purge_cutover_bu;
CREATE TRIGGER trg_tenant_redis_purge_cutover_bu BEFORE UPDATE ON tenant_redis_purge_cutover FOR EACH ROW BEGIN IF NOT (OLD.singleton_id=1 AND NEW.singleton_id=1 AND OLD.control_generation=0 AND OLD.activated_at_db_ms IS NULL AND OLD.first_request_id IS NULL AND OLD.first_receipt_sha256 IS NULL AND OLD.redis_namespace_sha256 IS NULL AND OLD.evidence_sha256 IS NULL AND NEW.control_generation=1 AND NEW.activated_at_db_ms IS NOT NULL AND NEW.first_request_id IS NOT NULL AND NEW.first_receipt_sha256 IS NOT NULL AND NEW.redis_namespace_sha256 IS NOT NULL AND NEW.evidence_sha256 IS NOT NULL) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant Redis purge cutover is write-once'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_redis_purge_cutover_bd;
CREATE TRIGGER trg_tenant_redis_purge_cutover_bd BEFORE DELETE ON tenant_redis_purge_cutover
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant Redis purge cutover cannot be deleted';

SET @tenant_redis_purge_trigger_set_ok = (
  SELECT COUNT(*)=15 AND COUNT(DISTINCT trigger_name)=15
     AND SHA2(GROUP_CONCAT(CONCAT_WS('~',event_object_table,trigger_name,
           action_timing,event_manipulation,action_orientation,
           LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),
             CHAR(96),''),'_utf8mb4','')))
         ORDER BY event_object_table,trigger_name SEPARATOR '|'),256)
       = 'b5583499602941d04bcc2aff9f5fa488be87e97ce07e1d1089f0ecc6eab1a772'
    FROM information_schema.triggers
   WHERE trigger_schema=DATABASE() AND trigger_name LIKE 'trg_tenant_redis_purge_%'
);
SET @migration_sql = IF(@tenant_redis_purge_trigger_set_ok=1, 'SELECT 1',
  'SELECT 1 FROM __invalid_tenant_redis_purge_trigger_set__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
SET SESSION group_concat_max_len = @tenant_redis_purge_previous_group_concat_max_len;
