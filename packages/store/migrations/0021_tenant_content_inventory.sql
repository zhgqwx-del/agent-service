-- Expand-only, execution-dormant substrate for T3c tenant content inventory evidence.
-- This migration never reads tenant/session rows into evidence, backfills or materializes a
-- job/receipt, advances a lifecycle, deletes or anonymizes data, or enables physical purge.
-- Historical T1/T3a/T3b evidence is consumed only by the explicit proof-checking materializer.

-- CREATE TABLE IF NOT EXISTS is restart-safe but, by itself, would accept an incompatible table
-- created by an interrupted/manual rollout. The fingerprints below cover the exact column order,
-- type/unsignedness, nullability, default, charset/collation, EXTRA and generation expression, as
-- normalized by the supported MySQL 8.0 floor. CHECK fingerprints remove only insignificant
-- whitespace/backticks/charset introducers and also bind ENFORCED=YES. Keep the buffer explicit so
-- GROUP_CONCAT cannot truncate a fingerprint under a deployment-specific session default.
SET @tenant_content_previous_group_concat_max_len = @@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len = 1048576;

-- Owner scans need a byte-exact, stable approval walk. Adding the index is restart-safe; an index
-- with the expected name but a different shape is deliberately not repaired and fails migration.
SET @tenant_content_approval_index_shape = (
  SELECT CONCAT(MIN(non_unique), ':', GROUP_CONCAT(CONCAT(
           LOWER(index_type), ':', LOWER(is_visible), ':',
           IFNULL(column_name, '<expression>'), ':',
           IFNULL(CAST(sub_part AS CHAR), '-'), ':',
           LOWER(IFNULL(collation, '-')), ':', IFNULL(expression, '-'))
         ORDER BY seq_in_index SEPARATOR ','))
    FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'approvals'
     AND index_name = 'idx_approvals_session_identity'
);
SET @migration_sql = IF(
  @tenant_content_approval_index_shape IS NULL,
  'ALTER TABLE approvals ADD KEY idx_approvals_session_identity (session_id, approval_id)',
  IF(
    @tenant_content_approval_index_shape =
      '1:btree:yes:session_id:-:a:-,btree:yes:approval_id:-:a:-',
    'SELECT 1',
    'ALTER TABLE approvals ADD KEY idx_approvals_session_identity (session_id, approval_id)'
  )
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SELECT session_id, approval_id
  FROM approvals FORCE INDEX (idx_approvals_session_identity)
 WHERE 1=0;

CREATE TABLE IF NOT EXISTS tenant_content_inventory_jobs (
  request_id                         VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  tenant_id                          VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation                 BIGINT UNSIGNED NOT NULL,
  t1_fence_sha256                    CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  t3a_receipt_sha256                 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  t3b_receipt_sha256                 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  policy_version                     VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  policy_sha256                      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  policy_schema_version              INT UNSIGNED NOT NULL,
  build_generation                   BIGINT UNSIGNED NOT NULL,
  retention_anchor_db_ms             BIGINT NOT NULL,
  content_not_before_db_ms           BIGINT NOT NULL,
  cursor_session_id                  VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  scan_complete                      BOOLEAN NOT NULL,
  session_receipt_count              BIGINT UNSIGNED NOT NULL,
  session_receipt_root_sha256        CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  phase                              VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  available_at_ms                    BIGINT NULL,
  attempts                           INT UNSIGNED NOT NULL DEFAULT 0,
  claim_token                        VARCHAR(128) COLLATE utf8mb4_0900_as_cs NULL,
  lease_until_ms                     BIGINT NULL,
  last_error_code                    VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL,
  created_at_ms                      BIGINT NOT NULL,
  updated_at_ms                      BIGINT NOT NULL,
  sealed_at_ms                       BIGINT NULL,
  completed_claim_attempt            INT UNSIGNED NULL,
  completed_claim_token_sha256       CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  aggregate_receipt_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  blocked_at_ms                      BIGINT NULL,
  blocked_reason_code                VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL,
  CONSTRAINT chk_tenant_content_job_generations CHECK (
    subject_generation > 0 AND build_generation > 0 AND policy_schema_version > 0
  ),
  CONSTRAINT chk_tenant_content_job_anchor CHECK (
    retention_anchor_db_ms >= 0
    AND content_not_before_db_ms >= retention_anchor_db_ms
  ),
  CONSTRAINT chk_tenant_content_job_timestamps CHECK (
    created_at_ms >= 0 AND updated_at_ms >= created_at_ms
  ),
  CONSTRAINT chk_tenant_content_job_cursor CHECK (
    (session_receipt_count = 0 AND cursor_session_id IS NULL)
    OR (session_receipt_count > 0 AND cursor_session_id IS NOT NULL)
  ),
  CONSTRAINT chk_tenant_content_job_scan_complete
    CHECK (scan_complete IN (FALSE, TRUE)),
  CONSTRAINT chk_tenant_content_job_phase CHECK (
    (phase = 'queued'
      AND available_at_ms IS NOT NULL
      AND available_at_ms >= created_at_ms
      AND ((claim_token IS NULL AND lease_until_ms IS NULL
          AND available_at_ms >= updated_at_ms)
        OR (claim_token IS NOT NULL AND lease_until_ms IS NOT NULL
          AND lease_until_ms >= updated_at_ms AND attempts > 0))
      AND ((claim_token IS NOT NULL AND last_error_code IS NULL)
        OR (claim_token IS NULL
          AND (last_error_code IS NULL OR last_error_code = 'temporary_failure')))
      AND sealed_at_ms IS NULL
      AND completed_claim_attempt IS NULL
      AND completed_claim_token_sha256 IS NULL
      AND aggregate_receipt_sha256 IS NULL
      AND blocked_at_ms IS NULL AND blocked_reason_code IS NULL)
    OR
    (phase = 'inventory_sealed'
      AND scan_complete = TRUE
      AND available_at_ms IS NULL AND claim_token IS NULL AND lease_until_ms IS NULL
      AND last_error_code IS NULL
      AND sealed_at_ms IS NOT NULL
      AND sealed_at_ms >= content_not_before_db_ms
      AND sealed_at_ms <= updated_at_ms
      AND completed_claim_attempt IS NOT NULL
      AND completed_claim_attempt = attempts AND attempts > 0
      AND completed_claim_token_sha256 IS NOT NULL
      AND aggregate_receipt_sha256 IS NOT NULL
      AND blocked_at_ms IS NULL AND blocked_reason_code IS NULL)
    OR
    (phase = 'blocked'
      AND available_at_ms IS NULL AND claim_token IS NULL AND lease_until_ms IS NULL
      AND last_error_code IS NULL
      AND sealed_at_ms IS NULL
      AND completed_claim_attempt IS NULL
      AND completed_claim_token_sha256 IS NULL
      AND aggregate_receipt_sha256 IS NULL
      AND blocked_at_ms IS NOT NULL
      AND blocked_at_ms >= created_at_ms AND blocked_at_ms <= updated_at_ms
      AND blocked_reason_code = 'integrity_conflict'
      AND attempts > 0)
  ),
  UNIQUE KEY uk_tenant_content_jobs_tenant (tenant_id),
  UNIQUE KEY uk_tenant_content_jobs_generation (tenant_id, subject_generation),
  KEY idx_tenant_content_jobs_claim (phase, available_at_ms, lease_until_ms, request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Explicit columns and required index names make a pre-created incompatible table fail closed.
SELECT request_id, tenant_id, subject_generation, t1_fence_sha256, t3a_receipt_sha256,
       t3b_receipt_sha256, policy_version, policy_sha256, policy_schema_version,
       build_generation, retention_anchor_db_ms, content_not_before_db_ms,
       cursor_session_id, scan_complete, session_receipt_count, session_receipt_root_sha256,
       phase, available_at_ms, attempts, claim_token, lease_until_ms, last_error_code,
       created_at_ms, updated_at_ms, sealed_at_ms, completed_claim_attempt,
       completed_claim_token_sha256, aggregate_receipt_sha256, blocked_at_ms,
       blocked_reason_code
  FROM tenant_content_inventory_jobs FORCE INDEX (
    PRIMARY, uk_tenant_content_jobs_tenant, uk_tenant_content_jobs_generation,
    idx_tenant_content_jobs_claim
  ) WHERE 1=0;

SET @tenant_content_job_index_shape_ok = (
  SELECT COUNT(*) FROM (
    SELECT index_name, MIN(non_unique) AS non_unique,
           GROUP_CONCAT(CONCAT(
             LOWER(index_type), ':', LOWER(is_visible), ':',
             IFNULL(column_name, '<expression>'), ':',
             IFNULL(CAST(sub_part AS CHAR), '-'), ':',
             LOWER(IFNULL(collation, '-')), ':', IFNULL(expression, '-'))
             ORDER BY seq_in_index SEPARATOR ',') AS columns_fingerprint
      FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'tenant_content_inventory_jobs'
       AND index_name IN ('PRIMARY', 'uk_tenant_content_jobs_tenant',
                          'uk_tenant_content_jobs_generation', 'idx_tenant_content_jobs_claim')
     GROUP BY index_name
  ) AS job_indexes
  WHERE (index_name = 'PRIMARY' AND non_unique = 0
       AND columns_fingerprint = 'btree:yes:request_id:-:a:-')
     OR (index_name = 'uk_tenant_content_jobs_tenant'
       AND non_unique = 0
       AND columns_fingerprint = 'btree:yes:tenant_id:-:a:-')
     OR (index_name = 'uk_tenant_content_jobs_generation'
       AND non_unique = 0
       AND columns_fingerprint =
         'btree:yes:tenant_id:-:a:-,btree:yes:subject_generation:-:a:-')
     OR (index_name = 'idx_tenant_content_jobs_claim'
       AND non_unique = 1
       AND columns_fingerprint =
         'btree:yes:phase:-:a:-,btree:yes:available_at_ms:-:a:-,btree:yes:lease_until_ms:-:a:-,btree:yes:request_id:-:a:-')
);
SET @migration_sql = IF(
  @tenant_content_job_index_shape_ok = 4,
  'SELECT 1',
  'SELECT 1 FROM __invalid_tenant_content_inventory_jobs_index_shape__'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @tenant_content_job_schema_ok = (
  SELECT table_type = 'BASE TABLE'
     AND engine = 'InnoDB'
     AND table_collation = 'utf8mb4_0900_as_cs'
     AND (SELECT COUNT(DISTINCT index_name) FROM information_schema.statistics
           WHERE table_schema = DATABASE()
             AND table_name = 'tenant_content_inventory_jobs') = 4
     AND (SELECT COUNT(*) FROM information_schema.table_constraints
           WHERE table_schema = DATABASE()
             AND table_name = 'tenant_content_inventory_jobs') = 9
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.partitions
        WHERE table_schema = DATABASE()
          AND table_name = 'tenant_content_inventory_jobs'
          AND partition_name IS NOT NULL
     )
     AND (
       SELECT COUNT(*) = 30 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',
                LPAD(ordinal_position, 3, '0'), column_name, LOWER(column_type),
                is_nullable,
                IF(column_default IS NULL, '<NULL>', CONCAT('<', column_default, '>')),
                IFNULL(character_set_name, '-'), IFNULL(collation_name, '-'),
                IFNULL(NULLIF(LOWER(extra), ''), '-'),
                IFNULL(NULLIF(LOWER(generation_expression), ''), '-'))
              ORDER BY ordinal_position SEPARATOR '|'), 256)
              = 'c26db662947a80ad3c33a856392e41bd978be4c4f41e67a4a4b754b3e369b7a5'
         FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'tenant_content_inventory_jobs'
     )
     AND (
       SELECT COUNT(*) = 6 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',
                tc.constraint_name, tc.enforced,
                LOWER(REPLACE(REPLACE(REGEXP_REPLACE(
                  cc.check_clause, '[[:space:]]', ''), CHAR(96), ''), '_utf8mb4', '')))
              ORDER BY tc.constraint_name SEPARATOR '|'), 256)
              = 'ee2f8b624cdc4c26f9bdef269a4185cbc15b0ea20e7e7c95c5d6a7cb5e38a679'
         FROM information_schema.table_constraints tc
         JOIN information_schema.check_constraints cc
           ON cc.constraint_schema = tc.constraint_schema
          AND cc.constraint_name = tc.constraint_name
        WHERE tc.table_schema = DATABASE()
          AND tc.table_name = 'tenant_content_inventory_jobs'
          AND tc.constraint_type = 'CHECK'
     )
    FROM information_schema.tables
   WHERE table_schema = DATABASE()
     AND table_name = 'tenant_content_inventory_jobs'
);
SET @migration_sql = IF(
  @tenant_content_job_schema_ok = 1,
  'SELECT 1',
  'SELECT 1 FROM __invalid_tenant_content_inventory_jobs_schema__'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- One immutable, content-free receipt per exact session identity. Roots bind structural row
-- identities, lifecycle state and relationship topology; raw bodies, storage locators, request
-- payloads, and claim tokens are excluded.
CREATE TABLE IF NOT EXISTS session_content_receipts (
  scope                         VARCHAR(48) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_id                    VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  build_generation              BIGINT UNSIGNED NOT NULL,
  tenant_id                     VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation            BIGINT UNSIGNED NOT NULL,
  session_id                    VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  session_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  turn_count                    BIGINT UNSIGNED NOT NULL,
  turn_root_sha256              CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  item_count                    BIGINT UNSIGNED NOT NULL,
  item_root_sha256              CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  event_count                   BIGINT UNSIGNED NOT NULL,
  event_root_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  approval_count                BIGINT UNSIGNED NOT NULL,
  approval_root_sha256          CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  content_record_count          BIGINT UNSIGNED NOT NULL,
  content_root_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  captured_at_db_ms             BIGINT NOT NULL,
  receipt_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  CONSTRAINT chk_session_content_receipt_scope
    CHECK (scope = 'tenant-session-content-v1'),
  CONSTRAINT chk_session_content_receipt_generation
    CHECK (subject_generation > 0 AND build_generation > 0),
  CONSTRAINT chk_session_content_receipt_count CHECK (
    content_record_count = 1 + turn_count + item_count + event_count + approval_count
  ),
  CONSTRAINT chk_session_content_receipt_time CHECK (captured_at_db_ms >= 0),
  PRIMARY KEY (request_id, build_generation, session_id),
  UNIQUE KEY uk_session_content_receipt_hash
    (request_id, build_generation, receipt_sha256),
  KEY idx_session_content_receipt_owner
    (tenant_id, subject_generation, request_id, build_generation, session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT scope, request_id, build_generation, tenant_id, subject_generation, session_id,
       session_sha256, turn_count, turn_root_sha256, item_count, item_root_sha256,
       event_count, event_root_sha256, approval_count, approval_root_sha256,
       content_record_count, content_root_sha256, captured_at_db_ms, receipt_sha256
  FROM session_content_receipts FORCE INDEX (
    PRIMARY, uk_session_content_receipt_hash, idx_session_content_receipt_owner
  ) WHERE 1=0;

SET @session_content_receipt_index_shape_ok = (
  SELECT COUNT(*) FROM (
    SELECT index_name, MIN(non_unique) AS non_unique,
           GROUP_CONCAT(CONCAT(
             LOWER(index_type), ':', LOWER(is_visible), ':',
             IFNULL(column_name, '<expression>'), ':',
             IFNULL(CAST(sub_part AS CHAR), '-'), ':',
             LOWER(IFNULL(collation, '-')), ':', IFNULL(expression, '-'))
             ORDER BY seq_in_index SEPARATOR ',') AS columns_fingerprint
      FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'session_content_receipts'
       AND index_name IN ('PRIMARY', 'uk_session_content_receipt_hash',
                          'idx_session_content_receipt_owner')
     GROUP BY index_name
  ) AS receipt_indexes
  WHERE (index_name = 'PRIMARY' AND non_unique = 0
       AND columns_fingerprint =
         'btree:yes:request_id:-:a:-,btree:yes:build_generation:-:a:-,btree:yes:session_id:-:a:-')
     OR (index_name = 'uk_session_content_receipt_hash' AND non_unique = 0
       AND columns_fingerprint =
         'btree:yes:request_id:-:a:-,btree:yes:build_generation:-:a:-,btree:yes:receipt_sha256:-:a:-')
     OR (index_name = 'idx_session_content_receipt_owner' AND non_unique = 1
       AND columns_fingerprint =
         'btree:yes:tenant_id:-:a:-,btree:yes:subject_generation:-:a:-,btree:yes:request_id:-:a:-,btree:yes:build_generation:-:a:-,btree:yes:session_id:-:a:-')
);
SET @migration_sql = IF(
  @session_content_receipt_index_shape_ok = 3,
  'SELECT 1',
  'SELECT 1 FROM __invalid_session_content_receipts_index_shape__'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @session_content_receipt_schema_ok = (
  SELECT table_type = 'BASE TABLE'
     AND engine = 'InnoDB'
     AND table_collation = 'utf8mb4_0900_as_cs'
     AND (SELECT COUNT(DISTINCT index_name) FROM information_schema.statistics
           WHERE table_schema = DATABASE()
             AND table_name = 'session_content_receipts') = 3
     AND (SELECT COUNT(*) FROM information_schema.table_constraints
           WHERE table_schema = DATABASE()
             AND table_name = 'session_content_receipts') = 6
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.partitions
        WHERE table_schema = DATABASE()
          AND table_name = 'session_content_receipts'
          AND partition_name IS NOT NULL
     )
     AND (
       SELECT COUNT(*) = 19 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',
                LPAD(ordinal_position, 3, '0'), column_name, LOWER(column_type),
                is_nullable,
                IF(column_default IS NULL, '<NULL>', CONCAT('<', column_default, '>')),
                IFNULL(character_set_name, '-'), IFNULL(collation_name, '-'),
                IFNULL(NULLIF(LOWER(extra), ''), '-'),
                IFNULL(NULLIF(LOWER(generation_expression), ''), '-'))
              ORDER BY ordinal_position SEPARATOR '|'), 256)
              = '17c8b69ba7d44ecde732a4a37647737702b39bf506b45d1f4788b9259e85486c'
         FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'session_content_receipts'
     )
     AND (
       SELECT COUNT(*) = 4 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',
                tc.constraint_name, tc.enforced,
                LOWER(REPLACE(REPLACE(REGEXP_REPLACE(
                  cc.check_clause, '[[:space:]]', ''), CHAR(96), ''), '_utf8mb4', '')))
              ORDER BY tc.constraint_name SEPARATOR '|'), 256)
              = '3d077747ee9dd5d840a2339e78a45ab901fed24a790ccd9cfbc4ea6544edd56a'
         FROM information_schema.table_constraints tc
         JOIN information_schema.check_constraints cc
           ON cc.constraint_schema = tc.constraint_schema
          AND cc.constraint_name = tc.constraint_name
        WHERE tc.table_schema = DATABASE()
          AND tc.table_name = 'session_content_receipts'
          AND tc.constraint_type = 'CHECK'
     )
    FROM information_schema.tables
   WHERE table_schema = DATABASE()
     AND table_name = 'session_content_receipts'
);
SET @migration_sql = IF(
  @session_content_receipt_schema_ok = 1,
  'SELECT 1',
  'SELECT 1 FROM __invalid_session_content_receipts_schema__'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- Aggregate proof seals the complete receipt root, current hold projection, and a global orphan
-- check. It explicitly proves inventory only; destructive content purge remains disabled.
CREATE TABLE IF NOT EXISTS tenant_content_inventory_receipts (
  scope                            VARCHAR(48) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_id                       VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  tenant_id                        VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation               BIGINT UNSIGNED NOT NULL,
  build_generation                 BIGINT UNSIGNED NOT NULL,
  t1_fence_sha256                  CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  t3a_receipt_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  t3b_receipt_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  policy_version                   VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  policy_sha256                    CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  policy_schema_version            INT UNSIGNED NOT NULL,
  retention_anchor_db_ms           BIGINT NOT NULL,
  content_not_before_db_ms         BIGINT NOT NULL,
  session_receipt_count            BIGINT UNSIGNED NOT NULL,
  session_receipt_root_sha256      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  content_record_count             BIGINT UNSIGNED NOT NULL,
  hold_control_count               BIGINT UNSIGNED NOT NULL,
  hold_root_sha256                 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  global_orphan_check              VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  store_db_timestamp_ms            BIGINT NOT NULL,
  completed_claim_attempt          INT UNSIGNED NOT NULL,
  completed_claim_token_sha256     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  content_inventory_complete       BOOLEAN NOT NULL,
  content_purge_executed           BOOLEAN NOT NULL,
  receipt_sha256                   CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  CONSTRAINT chk_tenant_content_receipt_scope
    CHECK (scope = 'tenant-content-inventory-v1'),
  CONSTRAINT chk_tenant_content_receipt_generations CHECK (
    subject_generation > 0 AND build_generation > 0 AND policy_schema_version > 0
  ),
  CONSTRAINT chk_tenant_content_receipt_anchor CHECK (
    retention_anchor_db_ms >= 0
    AND content_not_before_db_ms >= retention_anchor_db_ms
    AND store_db_timestamp_ms >= content_not_before_db_ms
  ),
  CONSTRAINT chk_tenant_content_receipt_counts CHECK (
    (session_receipt_count = 0 AND content_record_count = 0)
    OR (session_receipt_count > 0 AND content_record_count >= session_receipt_count)
  ),
  CONSTRAINT chk_tenant_content_receipt_completion CHECK (
    completed_claim_attempt > 0
    AND global_orphan_check = 'passed'
    AND content_inventory_complete = TRUE
    AND content_purge_executed = FALSE
  ),
  UNIQUE KEY uk_tenant_content_receipts_tenant (tenant_id),
  UNIQUE KEY uk_tenant_content_receipts_generation (tenant_id, subject_generation),
  UNIQUE KEY uk_tenant_content_receipts_hash (receipt_sha256)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT scope, request_id, tenant_id, subject_generation, build_generation,
       t1_fence_sha256, t3a_receipt_sha256, t3b_receipt_sha256, policy_version,
       policy_sha256, policy_schema_version, retention_anchor_db_ms,
       content_not_before_db_ms, session_receipt_count, session_receipt_root_sha256,
       content_record_count, hold_control_count, hold_root_sha256, global_orphan_check,
       store_db_timestamp_ms, completed_claim_attempt, completed_claim_token_sha256,
       content_inventory_complete, content_purge_executed, receipt_sha256
  FROM tenant_content_inventory_receipts FORCE INDEX (
    PRIMARY, uk_tenant_content_receipts_tenant,
    uk_tenant_content_receipts_generation, uk_tenant_content_receipts_hash
  ) WHERE 1=0;

SET @tenant_content_receipt_index_shape_ok = (
  SELECT COUNT(*) FROM (
    SELECT index_name, MIN(non_unique) AS non_unique,
           GROUP_CONCAT(CONCAT(
             LOWER(index_type), ':', LOWER(is_visible), ':',
             IFNULL(column_name, '<expression>'), ':',
             IFNULL(CAST(sub_part AS CHAR), '-'), ':',
             LOWER(IFNULL(collation, '-')), ':', IFNULL(expression, '-'))
             ORDER BY seq_in_index SEPARATOR ',') AS columns_fingerprint
      FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'tenant_content_inventory_receipts'
       AND index_name IN ('PRIMARY', 'uk_tenant_content_receipts_tenant',
                          'uk_tenant_content_receipts_generation',
                          'uk_tenant_content_receipts_hash')
     GROUP BY index_name
  ) AS aggregate_indexes
  WHERE (index_name = 'PRIMARY' AND non_unique = 0
       AND columns_fingerprint = 'btree:yes:request_id:-:a:-')
     OR (index_name = 'uk_tenant_content_receipts_tenant'
       AND non_unique = 0
       AND columns_fingerprint = 'btree:yes:tenant_id:-:a:-')
     OR (index_name = 'uk_tenant_content_receipts_generation'
       AND non_unique = 0
       AND columns_fingerprint =
         'btree:yes:tenant_id:-:a:-,btree:yes:subject_generation:-:a:-')
     OR (index_name = 'uk_tenant_content_receipts_hash'
       AND non_unique = 0
       AND columns_fingerprint = 'btree:yes:receipt_sha256:-:a:-')
);
SET @migration_sql = IF(
  @tenant_content_receipt_index_shape_ok = 4,
  'SELECT 1',
  'SELECT 1 FROM __invalid_tenant_content_inventory_receipts_index_shape__'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @tenant_content_receipt_schema_ok = (
  SELECT table_type = 'BASE TABLE'
     AND engine = 'InnoDB'
     AND table_collation = 'utf8mb4_0900_as_cs'
     AND (SELECT COUNT(DISTINCT index_name) FROM information_schema.statistics
           WHERE table_schema = DATABASE()
             AND table_name = 'tenant_content_inventory_receipts') = 4
     AND (SELECT COUNT(*) FROM information_schema.table_constraints
           WHERE table_schema = DATABASE()
             AND table_name = 'tenant_content_inventory_receipts') = 9
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.partitions
        WHERE table_schema = DATABASE()
          AND table_name = 'tenant_content_inventory_receipts'
          AND partition_name IS NOT NULL
     )
     AND (
       SELECT COUNT(*) = 25 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',
                LPAD(ordinal_position, 3, '0'), column_name, LOWER(column_type),
                is_nullable,
                IF(column_default IS NULL, '<NULL>', CONCAT('<', column_default, '>')),
                IFNULL(character_set_name, '-'), IFNULL(collation_name, '-'),
                IFNULL(NULLIF(LOWER(extra), ''), '-'),
                IFNULL(NULLIF(LOWER(generation_expression), ''), '-'))
              ORDER BY ordinal_position SEPARATOR '|'), 256)
              = '091db256503d0f04f84827161b4596cadd1a79237f108d25f2204332f45f991b'
         FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'tenant_content_inventory_receipts'
     )
     AND (
       SELECT COUNT(*) = 5 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',
                tc.constraint_name, tc.enforced,
                LOWER(REPLACE(REPLACE(REGEXP_REPLACE(
                  cc.check_clause, '[[:space:]]', ''), CHAR(96), ''), '_utf8mb4', '')))
              ORDER BY tc.constraint_name SEPARATOR '|'), 256)
              = '2cc57f79e374600a68dfb5c0bca15ae4103ba1d2b4ceb94b07a33d5123ead11d'
         FROM information_schema.table_constraints tc
         JOIN information_schema.check_constraints cc
           ON cc.constraint_schema = tc.constraint_schema
          AND cc.constraint_name = tc.constraint_name
        WHERE tc.table_schema = DATABASE()
          AND tc.table_name = 'tenant_content_inventory_receipts'
          AND tc.constraint_type = 'CHECK'
     )
    FROM information_schema.tables
   WHERE table_schema = DATABASE()
     AND table_name = 'tenant_content_inventory_receipts'
);
SET @migration_sql = IF(
  @tenant_content_receipt_schema_ok = 1,
  'SELECT 1',
  'SELECT 1 FROM __invalid_tenant_content_inventory_receipts_schema__'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- Job identity, source proofs, policy binding, database anchor/deadline, and build generation are
-- immutable. Terminal rows are immutable. A queued row may only be claimed, renewed/paged,
-- retried, sealed, or blocked; every other UPDATE fails closed.
DROP TRIGGER IF EXISTS trg_tenant_content_jobs_bu_bootstrap;
CREATE TRIGGER trg_tenant_content_jobs_bu_bootstrap BEFORE UPDATE ON tenant_content_inventory_jobs FOR EACH ROW BEGIN IF NOT (
  OLD.request_id <=> NEW.request_id AND OLD.tenant_id <=> NEW.tenant_id
  AND OLD.subject_generation <=> NEW.subject_generation
  AND OLD.t1_fence_sha256 <=> NEW.t1_fence_sha256
  AND OLD.t3a_receipt_sha256 <=> NEW.t3a_receipt_sha256
  AND OLD.t3b_receipt_sha256 <=> NEW.t3b_receipt_sha256
  AND OLD.policy_version <=> NEW.policy_version AND OLD.policy_sha256 <=> NEW.policy_sha256
  AND OLD.policy_schema_version <=> NEW.policy_schema_version
  AND OLD.build_generation <=> NEW.build_generation
  AND OLD.retention_anchor_db_ms <=> NEW.retention_anchor_db_ms
  AND OLD.content_not_before_db_ms <=> NEW.content_not_before_db_ms
  AND OLD.created_at_ms <=> NEW.created_at_ms AND NEW.updated_at_ms >= OLD.updated_at_ms
  AND OLD.phase = 'queued'
  AND (
    (NEW.phase = 'queued' AND NEW.attempts = OLD.attempts + 1
      AND NEW.claim_token IS NOT NULL AND NEW.lease_until_ms IS NOT NULL
      AND NEW.last_error_code IS NULL
      AND NEW.available_at_ms <=> OLD.available_at_ms
      AND NEW.cursor_session_id <=> OLD.cursor_session_id
      AND NEW.scan_complete <=> OLD.scan_complete
      AND NEW.session_receipt_count <=> OLD.session_receipt_count
      AND NEW.session_receipt_root_sha256 <=> OLD.session_receipt_root_sha256)
    OR
    (NEW.phase = 'queued' AND NEW.attempts = OLD.attempts
      AND OLD.claim_token IS NOT NULL AND NEW.claim_token <=> OLD.claim_token
      AND OLD.lease_until_ms IS NOT NULL AND NEW.lease_until_ms >= OLD.lease_until_ms
      AND NEW.last_error_code IS NULL
      AND NEW.available_at_ms <=> OLD.available_at_ms
      AND (
        (NEW.cursor_session_id <=> OLD.cursor_session_id
          AND NEW.scan_complete <=> OLD.scan_complete
          AND NEW.session_receipt_count <=> OLD.session_receipt_count
          AND NEW.session_receipt_root_sha256 <=> OLD.session_receipt_root_sha256)
        OR
        (OLD.scan_complete = FALSE
          AND NEW.session_receipt_count > OLD.session_receipt_count
          AND NEW.cursor_session_id IS NOT NULL
          AND (OLD.cursor_session_id IS NULL OR NEW.cursor_session_id > OLD.cursor_session_id)
          AND NOT (NEW.session_receipt_root_sha256 <=> OLD.session_receipt_root_sha256))
        OR
        (OLD.scan_complete = FALSE AND NEW.scan_complete = TRUE
          AND NEW.cursor_session_id <=> OLD.cursor_session_id
          AND NEW.session_receipt_count <=> OLD.session_receipt_count
          AND NEW.session_receipt_root_sha256 <=> OLD.session_receipt_root_sha256)
      ))
    OR
    (NEW.phase = 'queued' AND NEW.attempts = OLD.attempts
      AND OLD.claim_token IS NOT NULL
      AND NEW.claim_token IS NULL AND NEW.lease_until_ms IS NULL
      AND NEW.last_error_code = 'temporary_failure'
      AND NEW.available_at_ms >= OLD.available_at_ms
      AND NEW.available_at_ms >= NEW.updated_at_ms
      AND NEW.cursor_session_id <=> OLD.cursor_session_id
      AND NEW.scan_complete <=> OLD.scan_complete
      AND NEW.session_receipt_count <=> OLD.session_receipt_count
      AND NEW.session_receipt_root_sha256 <=> OLD.session_receipt_root_sha256)
    OR
    (NEW.phase = 'inventory_sealed' AND OLD.claim_token IS NOT NULL
      AND OLD.scan_complete = TRUE AND NEW.scan_complete = TRUE
      AND NEW.attempts = OLD.attempts
      AND NEW.cursor_session_id <=> OLD.cursor_session_id
      AND NEW.session_receipt_count <=> OLD.session_receipt_count
      AND NEW.session_receipt_root_sha256 <=> OLD.session_receipt_root_sha256
      AND NEW.completed_claim_attempt = OLD.attempts)
    OR
    (NEW.phase = 'blocked' AND OLD.claim_token IS NOT NULL
      AND NEW.attempts = OLD.attempts
      AND NEW.cursor_session_id <=> OLD.cursor_session_id
      AND NEW.scan_complete <=> OLD.scan_complete
      AND NEW.session_receipt_count <=> OLD.session_receipt_count
      AND NEW.session_receipt_root_sha256 <=> OLD.session_receipt_root_sha256)
  )
) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant content inventory job update is not permitted'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_content_jobs_bu;
CREATE TRIGGER trg_tenant_content_jobs_bu BEFORE UPDATE ON tenant_content_inventory_jobs FOR EACH ROW BEGIN IF NOT (
  OLD.request_id <=> NEW.request_id AND OLD.tenant_id <=> NEW.tenant_id AND OLD.subject_generation <=> NEW.subject_generation AND OLD.t1_fence_sha256 <=> NEW.t1_fence_sha256 AND OLD.t3a_receipt_sha256 <=> NEW.t3a_receipt_sha256 AND OLD.t3b_receipt_sha256 <=> NEW.t3b_receipt_sha256 AND OLD.policy_version <=> NEW.policy_version AND OLD.policy_sha256 <=> NEW.policy_sha256 AND OLD.policy_schema_version <=> NEW.policy_schema_version AND OLD.build_generation <=> NEW.build_generation AND OLD.retention_anchor_db_ms <=> NEW.retention_anchor_db_ms AND OLD.content_not_before_db_ms <=> NEW.content_not_before_db_ms AND OLD.created_at_ms <=> NEW.created_at_ms AND NEW.updated_at_ms >= OLD.updated_at_ms AND OLD.phase = 'queued' AND ((NEW.phase = 'queued' AND NEW.attempts = OLD.attempts + 1 AND NEW.claim_token IS NOT NULL AND NEW.lease_until_ms IS NOT NULL AND NEW.last_error_code IS NULL AND NEW.available_at_ms <=> OLD.available_at_ms AND NEW.cursor_session_id <=> OLD.cursor_session_id AND NEW.scan_complete <=> OLD.scan_complete AND NEW.session_receipt_count <=> OLD.session_receipt_count AND NEW.session_receipt_root_sha256 <=> OLD.session_receipt_root_sha256) OR (NEW.phase = 'queued' AND NEW.attempts = OLD.attempts AND OLD.claim_token IS NOT NULL AND NEW.claim_token <=> OLD.claim_token AND OLD.lease_until_ms IS NOT NULL AND NEW.lease_until_ms >= OLD.lease_until_ms AND NEW.last_error_code IS NULL AND NEW.available_at_ms <=> OLD.available_at_ms AND ((NEW.cursor_session_id <=> OLD.cursor_session_id AND NEW.scan_complete <=> OLD.scan_complete AND NEW.session_receipt_count <=> OLD.session_receipt_count AND NEW.session_receipt_root_sha256 <=> OLD.session_receipt_root_sha256) OR (OLD.scan_complete = FALSE AND NEW.session_receipt_count > OLD.session_receipt_count AND NEW.cursor_session_id IS NOT NULL AND (OLD.cursor_session_id IS NULL OR NEW.cursor_session_id > OLD.cursor_session_id) AND NOT (NEW.session_receipt_root_sha256 <=> OLD.session_receipt_root_sha256)) OR (OLD.scan_complete = FALSE AND NEW.scan_complete = TRUE AND NEW.cursor_session_id <=> OLD.cursor_session_id AND NEW.session_receipt_count <=> OLD.session_receipt_count AND NEW.session_receipt_root_sha256 <=> OLD.session_receipt_root_sha256))) OR (NEW.phase = 'queued' AND NEW.attempts = OLD.attempts AND OLD.claim_token IS NOT NULL AND NEW.claim_token IS NULL AND NEW.lease_until_ms IS NULL AND NEW.last_error_code = 'temporary_failure' AND NEW.available_at_ms >= OLD.available_at_ms AND NEW.available_at_ms >= NEW.updated_at_ms AND NEW.cursor_session_id <=> OLD.cursor_session_id AND NEW.scan_complete <=> OLD.scan_complete AND NEW.session_receipt_count <=> OLD.session_receipt_count AND NEW.session_receipt_root_sha256 <=> OLD.session_receipt_root_sha256) OR (NEW.phase = 'inventory_sealed' AND OLD.claim_token IS NOT NULL AND OLD.scan_complete = TRUE AND NEW.scan_complete = TRUE AND NEW.attempts = OLD.attempts AND NEW.cursor_session_id <=> OLD.cursor_session_id AND NEW.session_receipt_count <=> OLD.session_receipt_count AND NEW.session_receipt_root_sha256 <=> OLD.session_receipt_root_sha256 AND NEW.completed_claim_attempt = OLD.attempts) OR (NEW.phase = 'blocked' AND OLD.claim_token IS NOT NULL AND NEW.attempts = OLD.attempts AND NEW.cursor_session_id <=> OLD.cursor_session_id AND NEW.scan_complete <=> OLD.scan_complete AND NEW.session_receipt_count <=> OLD.session_receipt_count AND NEW.session_receipt_root_sha256 <=> OLD.session_receipt_root_sha256))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant content inventory job update is not permitted'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_content_jobs_bu_guard_a;
CREATE TRIGGER trg_tenant_content_jobs_bu_guard_a BEFORE UPDATE ON tenant_content_inventory_jobs FOR EACH ROW BEGIN IF NOT (
  OLD.request_id <=> NEW.request_id AND OLD.tenant_id <=> NEW.tenant_id AND OLD.subject_generation <=> NEW.subject_generation AND OLD.t1_fence_sha256 <=> NEW.t1_fence_sha256 AND OLD.t3a_receipt_sha256 <=> NEW.t3a_receipt_sha256 AND OLD.t3b_receipt_sha256 <=> NEW.t3b_receipt_sha256 AND OLD.policy_version <=> NEW.policy_version AND OLD.policy_sha256 <=> NEW.policy_sha256 AND OLD.policy_schema_version <=> NEW.policy_schema_version AND OLD.build_generation <=> NEW.build_generation AND OLD.retention_anchor_db_ms <=> NEW.retention_anchor_db_ms AND OLD.content_not_before_db_ms <=> NEW.content_not_before_db_ms AND OLD.created_at_ms <=> NEW.created_at_ms AND NEW.updated_at_ms >= OLD.updated_at_ms AND OLD.phase = 'queued' AND ((NEW.phase = 'queued' AND NEW.attempts = OLD.attempts + 1 AND NEW.claim_token IS NOT NULL AND NEW.lease_until_ms IS NOT NULL AND NEW.last_error_code IS NULL AND NEW.available_at_ms <=> OLD.available_at_ms AND NEW.cursor_session_id <=> OLD.cursor_session_id AND NEW.scan_complete <=> OLD.scan_complete AND NEW.session_receipt_count <=> OLD.session_receipt_count AND NEW.session_receipt_root_sha256 <=> OLD.session_receipt_root_sha256) OR (NEW.phase = 'queued' AND NEW.attempts = OLD.attempts AND OLD.claim_token IS NOT NULL AND NEW.claim_token <=> OLD.claim_token AND OLD.lease_until_ms IS NOT NULL AND NEW.lease_until_ms >= OLD.lease_until_ms AND NEW.last_error_code IS NULL AND NEW.available_at_ms <=> OLD.available_at_ms AND ((NEW.cursor_session_id <=> OLD.cursor_session_id AND NEW.scan_complete <=> OLD.scan_complete AND NEW.session_receipt_count <=> OLD.session_receipt_count AND NEW.session_receipt_root_sha256 <=> OLD.session_receipt_root_sha256) OR (OLD.scan_complete = FALSE AND NEW.session_receipt_count > OLD.session_receipt_count AND NEW.cursor_session_id IS NOT NULL AND (OLD.cursor_session_id IS NULL OR NEW.cursor_session_id > OLD.cursor_session_id) AND NOT (NEW.session_receipt_root_sha256 <=> OLD.session_receipt_root_sha256)) OR (OLD.scan_complete = FALSE AND NEW.scan_complete = TRUE AND NEW.cursor_session_id <=> OLD.cursor_session_id AND NEW.session_receipt_count <=> OLD.session_receipt_count AND NEW.session_receipt_root_sha256 <=> OLD.session_receipt_root_sha256))) OR (NEW.phase = 'queued' AND NEW.attempts = OLD.attempts AND OLD.claim_token IS NOT NULL AND NEW.claim_token IS NULL AND NEW.lease_until_ms IS NULL AND NEW.last_error_code = 'temporary_failure' AND NEW.available_at_ms >= OLD.available_at_ms AND NEW.available_at_ms >= NEW.updated_at_ms AND NEW.cursor_session_id <=> OLD.cursor_session_id AND NEW.scan_complete <=> OLD.scan_complete AND NEW.session_receipt_count <=> OLD.session_receipt_count AND NEW.session_receipt_root_sha256 <=> OLD.session_receipt_root_sha256) OR (NEW.phase = 'inventory_sealed' AND OLD.claim_token IS NOT NULL AND OLD.scan_complete = TRUE AND NEW.scan_complete = TRUE AND NEW.attempts = OLD.attempts AND NEW.cursor_session_id <=> OLD.cursor_session_id AND NEW.session_receipt_count <=> OLD.session_receipt_count AND NEW.session_receipt_root_sha256 <=> OLD.session_receipt_root_sha256 AND NEW.completed_claim_attempt = OLD.attempts) OR (NEW.phase = 'blocked' AND OLD.claim_token IS NOT NULL AND NEW.attempts = OLD.attempts AND NEW.cursor_session_id <=> OLD.cursor_session_id AND NEW.scan_complete <=> OLD.scan_complete AND NEW.session_receipt_count <=> OLD.session_receipt_count AND NEW.session_receipt_root_sha256 <=> OLD.session_receipt_root_sha256))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant content inventory job update is not permitted'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_content_jobs_bu_guard_b;
CREATE TRIGGER trg_tenant_content_jobs_bu_guard_b BEFORE UPDATE ON tenant_content_inventory_jobs FOR EACH ROW BEGIN IF NOT (
  OLD.request_id <=> NEW.request_id AND OLD.tenant_id <=> NEW.tenant_id AND OLD.subject_generation <=> NEW.subject_generation AND OLD.t1_fence_sha256 <=> NEW.t1_fence_sha256 AND OLD.t3a_receipt_sha256 <=> NEW.t3a_receipt_sha256 AND OLD.t3b_receipt_sha256 <=> NEW.t3b_receipt_sha256 AND OLD.policy_version <=> NEW.policy_version AND OLD.policy_sha256 <=> NEW.policy_sha256 AND OLD.policy_schema_version <=> NEW.policy_schema_version AND OLD.build_generation <=> NEW.build_generation AND OLD.retention_anchor_db_ms <=> NEW.retention_anchor_db_ms AND OLD.content_not_before_db_ms <=> NEW.content_not_before_db_ms AND OLD.created_at_ms <=> NEW.created_at_ms AND NEW.updated_at_ms >= OLD.updated_at_ms AND OLD.phase = 'queued' AND ((NEW.phase = 'queued' AND NEW.attempts = OLD.attempts + 1 AND NEW.claim_token IS NOT NULL AND NEW.lease_until_ms IS NOT NULL AND NEW.last_error_code IS NULL AND NEW.available_at_ms <=> OLD.available_at_ms AND NEW.cursor_session_id <=> OLD.cursor_session_id AND NEW.scan_complete <=> OLD.scan_complete AND NEW.session_receipt_count <=> OLD.session_receipt_count AND NEW.session_receipt_root_sha256 <=> OLD.session_receipt_root_sha256) OR (NEW.phase = 'queued' AND NEW.attempts = OLD.attempts AND OLD.claim_token IS NOT NULL AND NEW.claim_token <=> OLD.claim_token AND OLD.lease_until_ms IS NOT NULL AND NEW.lease_until_ms >= OLD.lease_until_ms AND NEW.last_error_code IS NULL AND NEW.available_at_ms <=> OLD.available_at_ms AND ((NEW.cursor_session_id <=> OLD.cursor_session_id AND NEW.scan_complete <=> OLD.scan_complete AND NEW.session_receipt_count <=> OLD.session_receipt_count AND NEW.session_receipt_root_sha256 <=> OLD.session_receipt_root_sha256) OR (OLD.scan_complete = FALSE AND NEW.session_receipt_count > OLD.session_receipt_count AND NEW.cursor_session_id IS NOT NULL AND (OLD.cursor_session_id IS NULL OR NEW.cursor_session_id > OLD.cursor_session_id) AND NOT (NEW.session_receipt_root_sha256 <=> OLD.session_receipt_root_sha256)) OR (OLD.scan_complete = FALSE AND NEW.scan_complete = TRUE AND NEW.cursor_session_id <=> OLD.cursor_session_id AND NEW.session_receipt_count <=> OLD.session_receipt_count AND NEW.session_receipt_root_sha256 <=> OLD.session_receipt_root_sha256))) OR (NEW.phase = 'queued' AND NEW.attempts = OLD.attempts AND OLD.claim_token IS NOT NULL AND NEW.claim_token IS NULL AND NEW.lease_until_ms IS NULL AND NEW.last_error_code = 'temporary_failure' AND NEW.available_at_ms >= OLD.available_at_ms AND NEW.available_at_ms >= NEW.updated_at_ms AND NEW.cursor_session_id <=> OLD.cursor_session_id AND NEW.scan_complete <=> OLD.scan_complete AND NEW.session_receipt_count <=> OLD.session_receipt_count AND NEW.session_receipt_root_sha256 <=> OLD.session_receipt_root_sha256) OR (NEW.phase = 'inventory_sealed' AND OLD.claim_token IS NOT NULL AND OLD.scan_complete = TRUE AND NEW.scan_complete = TRUE AND NEW.attempts = OLD.attempts AND NEW.cursor_session_id <=> OLD.cursor_session_id AND NEW.session_receipt_count <=> OLD.session_receipt_count AND NEW.session_receipt_root_sha256 <=> OLD.session_receipt_root_sha256 AND NEW.completed_claim_attempt = OLD.attempts) OR (NEW.phase = 'blocked' AND OLD.claim_token IS NOT NULL AND NEW.attempts = OLD.attempts AND NEW.cursor_session_id <=> OLD.cursor_session_id AND NEW.scan_complete <=> OLD.scan_complete AND NEW.session_receipt_count <=> OLD.session_receipt_count AND NEW.session_receipt_root_sha256 <=> OLD.session_receipt_root_sha256))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant content inventory job update is not permitted'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_content_jobs_bu_bootstrap;

DROP TRIGGER IF EXISTS trg_tenant_content_jobs_bd_bootstrap;
CREATE TRIGGER trg_tenant_content_jobs_bd_bootstrap BEFORE DELETE ON tenant_content_inventory_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant content inventory jobs cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_content_jobs_bd;
CREATE TRIGGER trg_tenant_content_jobs_bd BEFORE DELETE ON tenant_content_inventory_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant content inventory jobs cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_content_jobs_bd_guard_a;
CREATE TRIGGER trg_tenant_content_jobs_bd_guard_a BEFORE DELETE ON tenant_content_inventory_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant content inventory jobs cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_content_jobs_bd_guard_b;
CREATE TRIGGER trg_tenant_content_jobs_bd_guard_b BEFORE DELETE ON tenant_content_inventory_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant content inventory jobs cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_content_jobs_bd_bootstrap;

-- Per-session and aggregate evidence are permanently append-only. Bootstrap-first rotation means
-- every marker-loss replay prefix retains at least one permanent guard after the initial install.
DROP TRIGGER IF EXISTS trg_session_content_receipts_bu_bootstrap;
CREATE TRIGGER trg_session_content_receipts_bu_bootstrap BEFORE UPDATE ON session_content_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'session content receipts are append-only';
DROP TRIGGER IF EXISTS trg_session_content_receipts_bu;
CREATE TRIGGER trg_session_content_receipts_bu BEFORE UPDATE ON session_content_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'session content receipts are append-only';
DROP TRIGGER IF EXISTS trg_session_content_receipts_bu_guard_a;
CREATE TRIGGER trg_session_content_receipts_bu_guard_a BEFORE UPDATE ON session_content_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'session content receipts are append-only';
DROP TRIGGER IF EXISTS trg_session_content_receipts_bu_guard_b;
CREATE TRIGGER trg_session_content_receipts_bu_guard_b BEFORE UPDATE ON session_content_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'session content receipts are append-only';
DROP TRIGGER IF EXISTS trg_session_content_receipts_bu_bootstrap;

DROP TRIGGER IF EXISTS trg_session_content_receipts_bd_bootstrap;
CREATE TRIGGER trg_session_content_receipts_bd_bootstrap BEFORE DELETE ON session_content_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'session content receipts are append-only';
DROP TRIGGER IF EXISTS trg_session_content_receipts_bd;
CREATE TRIGGER trg_session_content_receipts_bd BEFORE DELETE ON session_content_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'session content receipts are append-only';
DROP TRIGGER IF EXISTS trg_session_content_receipts_bd_guard_a;
CREATE TRIGGER trg_session_content_receipts_bd_guard_a BEFORE DELETE ON session_content_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'session content receipts are append-only';
DROP TRIGGER IF EXISTS trg_session_content_receipts_bd_guard_b;
CREATE TRIGGER trg_session_content_receipts_bd_guard_b BEFORE DELETE ON session_content_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'session content receipts are append-only';
DROP TRIGGER IF EXISTS trg_session_content_receipts_bd_bootstrap;

DROP TRIGGER IF EXISTS trg_tenant_content_receipts_bu_bootstrap;
CREATE TRIGGER trg_tenant_content_receipts_bu_bootstrap BEFORE UPDATE ON tenant_content_inventory_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant content inventory receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_content_receipts_bu;
CREATE TRIGGER trg_tenant_content_receipts_bu BEFORE UPDATE ON tenant_content_inventory_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant content inventory receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_content_receipts_bu_guard_a;
CREATE TRIGGER trg_tenant_content_receipts_bu_guard_a BEFORE UPDATE ON tenant_content_inventory_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant content inventory receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_content_receipts_bu_guard_b;
CREATE TRIGGER trg_tenant_content_receipts_bu_guard_b BEFORE UPDATE ON tenant_content_inventory_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant content inventory receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_content_receipts_bu_bootstrap;

DROP TRIGGER IF EXISTS trg_tenant_content_receipts_bd_bootstrap;
CREATE TRIGGER trg_tenant_content_receipts_bd_bootstrap BEFORE DELETE ON tenant_content_inventory_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant content inventory receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_content_receipts_bd;
CREATE TRIGGER trg_tenant_content_receipts_bd BEFORE DELETE ON tenant_content_inventory_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant content inventory receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_content_receipts_bd_guard_a;
CREATE TRIGGER trg_tenant_content_receipts_bd_guard_a BEFORE DELETE ON tenant_content_inventory_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant content inventory receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_content_receipts_bd_guard_b;
CREATE TRIGGER trg_tenant_content_receipts_bd_guard_b BEFORE DELETE ON tenant_content_inventory_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'tenant content inventory receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_content_receipts_bd_bootstrap;

-- Reject unknown INSERT/UPDATE/DELETE triggers instead of silently inheriting semantics from a
-- manually pre-created table. Every expected trigger above was just dropped and recreated, so its
-- body is migration-owned; this final exact-set fingerprint proves that no additional trigger can
-- rewrite or suppress evidence mutations before the migration marker is committed.
SET @tenant_content_trigger_set_ok = (
  SELECT COUNT(*) = 18
     AND SHA2(GROUP_CONCAT(CONCAT_WS('~', event_object_table, trigger_name,
              action_timing, event_manipulation, action_orientation,
              IFNULL(action_condition, '<NULL>'))
            ORDER BY event_object_table, trigger_name SEPARATOR '|'), 256)
         = 'fb3c579a0e0d0eedbe0c32e971d453b443f8edb61b61d4d4dfa559b764b1e9c1'
    FROM information_schema.triggers
   WHERE trigger_schema = DATABASE()
     AND event_object_table IN ('tenant_content_inventory_jobs',
                                'session_content_receipts',
                                'tenant_content_inventory_receipts')
);
SET @migration_sql = IF(
  @tenant_content_trigger_set_ok = 1,
  'SELECT 1',
  'SELECT 1 FROM __invalid_tenant_content_inventory_trigger_set__'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
SET SESSION group_concat_max_len = @tenant_content_previous_group_concat_max_len;
