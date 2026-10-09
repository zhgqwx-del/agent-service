-- Expand-only, execution-dormant substrate for a complete tenant purge plan.
-- This migration creates no job/entry/receipt, scans no owner data, invokes no adapter, performs
-- no delete/anonymize/revoke, and cannot mark execution ready or content purge complete.
-- Missing external/cloud/restore/log capability is an explicit blocker, never an inferred empty
-- target domain. Runtime materialization separately binds exact T1/T3a/T3b/T3c/policy/deadline.

SET @tenant_purge_plan_previous_group_concat_max_len = @@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len = 1048576;

CREATE TABLE IF NOT EXISTS `tenant_purge_plan_jobs` (
  `request_id` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `tenant_id` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `subject_generation` bigint unsigned NOT NULL,
  `t1_fence_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `t3a_receipt_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `t3b_receipt_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `t3c_receipt_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `policy_version` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `policy_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `policy_schema_version` int unsigned NOT NULL,
  `build_generation` bigint unsigned NOT NULL,
  `retention_anchor_db_ms` bigint NOT NULL,
  `purge_not_before_db_ms` bigint NOT NULL,
  `source_evidence_db_ms` bigint NOT NULL,
  `cursor_domain` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `scan_complete` tinyint(1) NOT NULL,
  `plan_entry_count` bigint unsigned NOT NULL,
  `plan_entry_root_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `blocker_count` bigint unsigned NOT NULL,
  `blocker_root_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `phase` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `available_at_ms` bigint DEFAULT NULL,
  `attempts` int unsigned NOT NULL DEFAULT '0',
  `claim_token` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `lease_until_ms` bigint DEFAULT NULL,
  `last_error_code` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `created_at_ms` bigint NOT NULL,
  `updated_at_ms` bigint NOT NULL,
  `sealed_at_ms` bigint DEFAULT NULL,
  `completed_claim_attempt` int unsigned DEFAULT NULL,
  `completed_claim_token_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `aggregate_receipt_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `blocked_at_ms` bigint DEFAULT NULL,
  `blocked_reason_code` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  PRIMARY KEY (`request_id`),
  UNIQUE KEY `uk_tenant_purge_plan_jobs_tenant` (`tenant_id`),
  UNIQUE KEY `uk_tenant_purge_plan_jobs_generation` (`tenant_id`,`subject_generation`),
  KEY `idx_tenant_purge_plan_jobs_claim` (`phase`,`available_at_ms`,`lease_until_ms`,`request_id`),
  CONSTRAINT `chk_tenant_purge_plan_job_clock` CHECK (((`retention_anchor_db_ms` >= 0) and (`purge_not_before_db_ms` >= `retention_anchor_db_ms`) and (`source_evidence_db_ms` >= `purge_not_before_db_ms`))),
  CONSTRAINT `chk_tenant_purge_plan_job_cursor` CHECK (((`plan_entry_count` <= 33) and (`blocker_count` <= `plan_entry_count`) and (((`plan_entry_count` = 0) and (`cursor_domain` is null)) or ((`plan_entry_count` > 0) and (`cursor_domain` is not null))))),
  CONSTRAINT `chk_tenant_purge_plan_job_domain` CHECK (((`cursor_domain` is null) or (`cursor_domain` in (_utf8mb4'tenant_registry',_utf8mb4'tenant_profile',_utf8mb4'agent_definitions',_utf8mb4'session_content',_utf8mb4'idempotency_receipts',_utf8mb4'operational_usage',_utf8mb4'billing_facts',_utf8mb4'billing_reconciliation',_utf8mb4'blob_manifest',_utf8mb4'blob_bytes',_utf8mb4'blob_outbox',_utf8mb4'lifecycle_outbox',_utf8mb4'user_export_control',_utf8mb4'user_export_snapshots',_utf8mb4'user_export_artifacts',_utf8mb4'user_export_bytes',_utf8mb4'user_erasure_evidence',_utf8mb4'user_purge_policy_evidence',_utf8mb4'governance_policy',_utf8mb4'legal_holds',_utf8mb4'tenant_t1_evidence',_utf8mb4'tenant_t3a_evidence',_utf8mb4'tenant_t3b_evidence',_utf8mb4'tenant_t3c_evidence',_utf8mb4'redis_leases',_utf8mb4'redis_fences',_utf8mb4'redis_streams',_utf8mb4'external_provider',_utf8mb4'kms',_utf8mb4'backup_ledger',_utf8mb4'restore_ledger',_utf8mb4'logs',_utf8mb4'traces')))),
  CONSTRAINT `chk_tenant_purge_plan_job_generations` CHECK (((`subject_generation` > 0) and (`build_generation` > 0) and (`policy_schema_version` > 0))),
  CONSTRAINT `chk_tenant_purge_plan_job_phase` CHECK ((((`phase` = _utf8mb4'queued') and (`available_at_ms` is not null) and (`available_at_ms` >= `created_at_ms`) and (((`claim_token` is null) and (`lease_until_ms` is null) and (`available_at_ms` >= `updated_at_ms`)) or ((`claim_token` is not null) and (`lease_until_ms` is not null) and (`lease_until_ms` >= `updated_at_ms`) and (`attempts` > 0))) and (((`claim_token` is not null) and (`last_error_code` is null)) or ((`claim_token` is null) and ((`last_error_code` is null) or (`last_error_code` = _utf8mb4'temporary_failure')))) and (`sealed_at_ms` is null) and (`completed_claim_attempt` is null) and (`completed_claim_token_sha256` is null) and (`aggregate_receipt_sha256` is null) and (`blocked_at_ms` is null) and (`blocked_reason_code` is null)) or ((`phase` = _utf8mb4'plan_sealed') and (`scan_complete` = true) and (`plan_entry_count` = 33) and (`available_at_ms` is null) and (`claim_token` is null) and (`lease_until_ms` is null) and (`last_error_code` is null) and (`sealed_at_ms` is not null) and (`sealed_at_ms` >= `source_evidence_db_ms`) and (`sealed_at_ms` <= `updated_at_ms`) and (`completed_claim_attempt` is not null) and (`completed_claim_attempt` = `attempts`) and (`attempts` > 0) and (`completed_claim_token_sha256` is not null) and (`aggregate_receipt_sha256` is not null) and (`blocked_at_ms` is null) and (`blocked_reason_code` is null)) or ((`phase` = _utf8mb4'blocked') and (`available_at_ms` is null) and (`claim_token` is null) and (`lease_until_ms` is null) and (`last_error_code` is null) and (`sealed_at_ms` is null) and (`completed_claim_attempt` is null) and (`completed_claim_token_sha256` is null) and (`aggregate_receipt_sha256` is null) and (`blocked_at_ms` is not null) and (`blocked_at_ms` >= `created_at_ms`) and (`blocked_at_ms` <= `updated_at_ms`) and (`blocked_reason_code` = _utf8mb4'integrity_conflict') and (`attempts` > 0)))),
  CONSTRAINT `chk_tenant_purge_plan_job_scan` CHECK (((`scan_complete` in (false,true)) and ((`scan_complete` = false) or (`plan_entry_count` = 33)))),
  CONSTRAINT `chk_tenant_purge_plan_job_timestamps` CHECK (((`created_at_ms` >= 0) and (`updated_at_ms` >= `created_at_ms`)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT request_id, tenant_id, subject_generation, t1_fence_sha256, t3a_receipt_sha256, t3b_receipt_sha256, t3c_receipt_sha256, policy_version, policy_sha256, policy_schema_version, build_generation, retention_anchor_db_ms, purge_not_before_db_ms, source_evidence_db_ms, cursor_domain, scan_complete, plan_entry_count, plan_entry_root_sha256, blocker_count, blocker_root_sha256, phase, available_at_ms, attempts, claim_token, lease_until_ms, last_error_code, created_at_ms, updated_at_ms, sealed_at_ms, completed_claim_attempt, completed_claim_token_sha256, aggregate_receipt_sha256, blocked_at_ms, blocked_reason_code
  FROM tenant_purge_plan_jobs FORCE INDEX (PRIMARY, uk_tenant_purge_plan_jobs_tenant, uk_tenant_purge_plan_jobs_generation, idx_tenant_purge_plan_jobs_claim) WHERE 1=0;

SET @tenant_purge_plan_job_index_ok = (
  SELECT COUNT(DISTINCT index_name)=4 AND COUNT(*)=8
     AND SHA2(GROUP_CONCAT(CONCAT_WS('~',index_name,non_unique,seq_in_index,
           LOWER(index_type),LOWER(is_visible),IFNULL(column_name,'<expression>'),
           IFNULL(CAST(sub_part AS CHAR),'-'),LOWER(IFNULL(collation,'-')),
           IFNULL(expression,'-')) ORDER BY index_name,seq_in_index SEPARATOR '|'),256)
         = 'e464d4b374de6728a1eca17a123ac87a2d2b6aa4c4788a53e03d6dbc5b7e82e2'
    FROM information_schema.statistics
   WHERE table_schema=DATABASE() AND table_name='tenant_purge_plan_jobs'
);
SET @migration_sql = IF(@tenant_purge_plan_job_index_ok=1, 'SELECT 1',
  'SELECT 1 FROM __invalid_tenant_purge_plan_jobs_index_shape__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @tenant_purge_plan_job_schema_ok = (
  SELECT table_type='BASE TABLE' AND engine='InnoDB' AND table_collation='utf8mb4_0900_as_cs'
     AND (SELECT COUNT(*) FROM information_schema.table_constraints
           WHERE table_schema=DATABASE() AND table_name='tenant_purge_plan_jobs')=10
     AND NOT EXISTS (SELECT 1 FROM information_schema.partitions
           WHERE table_schema=DATABASE() AND table_name='tenant_purge_plan_jobs' AND partition_name IS NOT NULL)
     AND (SELECT COUNT(*)=34 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',
            LPAD(ordinal_position,3,'0'),column_name,LOWER(column_type),is_nullable,
            IF(column_default IS NULL,'<NULL>',CONCAT('<',column_default,'>')),
            IFNULL(character_set_name,'-'),IFNULL(collation_name,'-'),
            IFNULL(NULLIF(LOWER(extra),''),'-'),
            IFNULL(NULLIF(LOWER(generation_expression),''),'-'))
            ORDER BY ordinal_position SEPARATOR '|'),256)='65d7e952e23f46e82b54a787fab3b031f1203942564938946f1b0370e3993a40'
          FROM information_schema.columns
         WHERE table_schema=DATABASE() AND table_name='tenant_purge_plan_jobs')
     AND (SELECT COUNT(*)=7 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',
            tc.constraint_name,tc.enforced,LOWER(REPLACE(REPLACE(REGEXP_REPLACE(
              cc.check_clause,'[[:space:]]',''),CHAR(96),''),'_utf8mb4','')))
            ORDER BY tc.constraint_name SEPARATOR '|'),256)='ec5bb90301e100c666b8243503f30c000ff9b3a003cff72642237fdfa6385292'
          FROM information_schema.table_constraints tc
          JOIN information_schema.check_constraints cc
            ON cc.constraint_schema=tc.constraint_schema
           AND cc.constraint_name=tc.constraint_name
         WHERE tc.table_schema=DATABASE() AND tc.table_name='tenant_purge_plan_jobs'
           AND tc.constraint_type='CHECK')
    FROM information_schema.tables
   WHERE table_schema=DATABASE() AND table_name='tenant_purge_plan_jobs'
);
SET @migration_sql = IF(@tenant_purge_plan_job_schema_ok=1, 'SELECT 1',
  'SELECT 1 FROM __invalid_tenant_purge_plan_jobs_schema__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- Exactly one content-free row per fixed catalog domain.
-- Entries contain only aggregate count/root, fixed disposition and immutable source hash.
CREATE TABLE IF NOT EXISTS `tenant_purge_plan_entries` (
  `scope` varchar(48) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `request_id` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `build_generation` bigint unsigned NOT NULL,
  `tenant_id` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `subject_generation` bigint unsigned NOT NULL,
  `domain` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `target_count` bigint unsigned NOT NULL,
  `target_root_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `disposition` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `source_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `captured_at_db_ms` bigint NOT NULL,
  `receipt_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (`request_id`,`build_generation`,`domain`),
  UNIQUE KEY `uk_tenant_purge_plan_entries_hash` (`request_id`,`build_generation`,`receipt_sha256`),
  KEY `idx_tenant_purge_plan_entries_owner` (`tenant_id`,`subject_generation`,`request_id`,`build_generation`,`domain`),
  CONSTRAINT `chk_tenant_purge_plan_entry_count` CHECK ((`target_count` >= 0)),
  CONSTRAINT `chk_tenant_purge_plan_entry_disposition` CHECK (((`disposition` in (_utf8mb4'delete',_utf8mb4'anonymize',_utf8mb4'retain_anonymized',_utf8mb4'revoke',_utf8mb4'clear',_utf8mb4'retain_evidence',_utf8mb4'not_applicable',_utf8mb4'blocked_legacy_external_source_unavailable',_utf8mb4'blocked_adapter_unconfigured',_utf8mb4'blocked_restore_replay_unproven')) and ((`disposition` <> _utf8mb4'not_applicable') or ((`target_count` = 0) and (`domain` in (_utf8mb4'external_provider',_utf8mb4'kms')))))),
  CONSTRAINT `chk_tenant_purge_plan_entry_domain` CHECK ((`domain` in (_utf8mb4'tenant_registry',_utf8mb4'tenant_profile',_utf8mb4'agent_definitions',_utf8mb4'session_content',_utf8mb4'idempotency_receipts',_utf8mb4'operational_usage',_utf8mb4'billing_facts',_utf8mb4'billing_reconciliation',_utf8mb4'blob_manifest',_utf8mb4'blob_bytes',_utf8mb4'blob_outbox',_utf8mb4'lifecycle_outbox',_utf8mb4'user_export_control',_utf8mb4'user_export_snapshots',_utf8mb4'user_export_artifacts',_utf8mb4'user_export_bytes',_utf8mb4'user_erasure_evidence',_utf8mb4'user_purge_policy_evidence',_utf8mb4'governance_policy',_utf8mb4'legal_holds',_utf8mb4'tenant_t1_evidence',_utf8mb4'tenant_t3a_evidence',_utf8mb4'tenant_t3b_evidence',_utf8mb4'tenant_t3c_evidence',_utf8mb4'redis_leases',_utf8mb4'redis_fences',_utf8mb4'redis_streams',_utf8mb4'external_provider',_utf8mb4'kms',_utf8mb4'backup_ledger',_utf8mb4'restore_ledger',_utf8mb4'logs',_utf8mb4'traces'))),
  CONSTRAINT `chk_tenant_purge_plan_entry_generation` CHECK (((`subject_generation` > 0) and (`build_generation` > 0))),
  CONSTRAINT `chk_tenant_purge_plan_entry_scope` CHECK ((`scope` = _utf8mb4'tenant-purge-plan-entry-v1')),
  CONSTRAINT `chk_tenant_purge_plan_entry_time` CHECK ((`captured_at_db_ms` >= 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT scope, request_id, build_generation, tenant_id, subject_generation, domain, target_count, target_root_sha256, disposition, source_sha256, captured_at_db_ms, receipt_sha256
  FROM tenant_purge_plan_entries FORCE INDEX (PRIMARY, uk_tenant_purge_plan_entries_hash, idx_tenant_purge_plan_entries_owner) WHERE 1=0;

SET @tenant_purge_plan_entry_index_ok = (
  SELECT COUNT(DISTINCT index_name)=3 AND COUNT(*)=11
     AND SHA2(GROUP_CONCAT(CONCAT_WS('~',index_name,non_unique,seq_in_index,
           LOWER(index_type),LOWER(is_visible),IFNULL(column_name,'<expression>'),
           IFNULL(CAST(sub_part AS CHAR),'-'),LOWER(IFNULL(collation,'-')),
           IFNULL(expression,'-')) ORDER BY index_name,seq_in_index SEPARATOR '|'),256)
         = '073886974e272a11fdaf1bcf7c85e1945e41e5460207f88ae8d49a88d587b142'
    FROM information_schema.statistics
   WHERE table_schema=DATABASE() AND table_name='tenant_purge_plan_entries'
);
SET @migration_sql = IF(@tenant_purge_plan_entry_index_ok=1, 'SELECT 1',
  'SELECT 1 FROM __invalid_tenant_purge_plan_entries_index_shape__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @tenant_purge_plan_entry_schema_ok = (
  SELECT table_type='BASE TABLE' AND engine='InnoDB' AND table_collation='utf8mb4_0900_as_cs'
     AND (SELECT COUNT(*) FROM information_schema.table_constraints
           WHERE table_schema=DATABASE() AND table_name='tenant_purge_plan_entries')=8
     AND NOT EXISTS (SELECT 1 FROM information_schema.partitions
           WHERE table_schema=DATABASE() AND table_name='tenant_purge_plan_entries' AND partition_name IS NOT NULL)
     AND (SELECT COUNT(*)=12 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',
            LPAD(ordinal_position,3,'0'),column_name,LOWER(column_type),is_nullable,
            IF(column_default IS NULL,'<NULL>',CONCAT('<',column_default,'>')),
            IFNULL(character_set_name,'-'),IFNULL(collation_name,'-'),
            IFNULL(NULLIF(LOWER(extra),''),'-'),
            IFNULL(NULLIF(LOWER(generation_expression),''),'-'))
            ORDER BY ordinal_position SEPARATOR '|'),256)='e73b5936ecefb15c2c4b9410fed269d83f86add98c7870b5b28e6111dd302322'
          FROM information_schema.columns
         WHERE table_schema=DATABASE() AND table_name='tenant_purge_plan_entries')
     AND (SELECT COUNT(*)=6 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',
            tc.constraint_name,tc.enforced,LOWER(REPLACE(REPLACE(REGEXP_REPLACE(
              cc.check_clause,'[[:space:]]',''),CHAR(96),''),'_utf8mb4','')))
            ORDER BY tc.constraint_name SEPARATOR '|'),256)='75b33e865894718bf80a5d3fb61db3a15180d62cb53faff3a04eab06960e47df'
          FROM information_schema.table_constraints tc
          JOIN information_schema.check_constraints cc
            ON cc.constraint_schema=tc.constraint_schema
           AND cc.constraint_name=tc.constraint_name
         WHERE tc.table_schema=DATABASE() AND tc.table_name='tenant_purge_plan_entries'
           AND tc.constraint_type='CHECK')
    FROM information_schema.tables
   WHERE table_schema=DATABASE() AND table_name='tenant_purge_plan_entries'
);
SET @migration_sql = IF(@tenant_purge_plan_entry_schema_ok=1, 'SELECT 1',
  'SELECT 1 FROM __invalid_tenant_purge_plan_entries_schema__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

CREATE TABLE IF NOT EXISTS `tenant_purge_plan_receipts` (
  `scope` varchar(48) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `request_id` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `tenant_id` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `subject_generation` bigint unsigned NOT NULL,
  `build_generation` bigint unsigned NOT NULL,
  `t1_fence_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `t3a_receipt_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `t3b_receipt_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `t3c_receipt_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `policy_version` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `policy_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `policy_schema_version` int unsigned NOT NULL,
  `retention_anchor_db_ms` bigint NOT NULL,
  `purge_not_before_db_ms` bigint NOT NULL,
  `source_evidence_db_ms` bigint NOT NULL,
  `plan_entry_count` bigint unsigned NOT NULL,
  `plan_entry_root_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `blocker_count` bigint unsigned NOT NULL,
  `blocker_root_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `store_db_timestamp_ms` bigint NOT NULL,
  `completed_claim_attempt` int unsigned NOT NULL,
  `completed_claim_token_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `plan_complete` tinyint(1) NOT NULL,
  `execution_ready` tinyint(1) NOT NULL,
  `content_purge_executed` tinyint(1) NOT NULL,
  `receipt_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (`request_id`),
  UNIQUE KEY `uk_tenant_purge_plan_receipts_tenant` (`tenant_id`),
  UNIQUE KEY `uk_tenant_purge_plan_receipts_generation` (`tenant_id`,`subject_generation`),
  UNIQUE KEY `uk_tenant_purge_plan_receipts_hash` (`receipt_sha256`),
  CONSTRAINT `chk_tenant_purge_plan_receipt_clock` CHECK (((`retention_anchor_db_ms` >= 0) and (`purge_not_before_db_ms` >= `retention_anchor_db_ms`) and (`source_evidence_db_ms` >= `purge_not_before_db_ms`) and (`store_db_timestamp_ms` >= `source_evidence_db_ms`))),
  CONSTRAINT `chk_tenant_purge_plan_receipt_completion` CHECK (((`completed_claim_attempt` > 0) and (`plan_complete` = true) and (`execution_ready` = false) and (`content_purge_executed` = false))),
  CONSTRAINT `chk_tenant_purge_plan_receipt_counts` CHECK (((`plan_entry_count` = 33) and (`blocker_count` <= `plan_entry_count`))),
  CONSTRAINT `chk_tenant_purge_plan_receipt_generations` CHECK (((`subject_generation` > 0) and (`build_generation` > 0) and (`policy_schema_version` > 0))),
  CONSTRAINT `chk_tenant_purge_plan_receipt_scope` CHECK ((`scope` = _utf8mb4'tenant-purge-plan-v1'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT scope, request_id, tenant_id, subject_generation, build_generation, t1_fence_sha256, t3a_receipt_sha256, t3b_receipt_sha256, t3c_receipt_sha256, policy_version, policy_sha256, policy_schema_version, retention_anchor_db_ms, purge_not_before_db_ms, source_evidence_db_ms, plan_entry_count, plan_entry_root_sha256, blocker_count, blocker_root_sha256, store_db_timestamp_ms, completed_claim_attempt, completed_claim_token_sha256, plan_complete, execution_ready, content_purge_executed, receipt_sha256
  FROM tenant_purge_plan_receipts FORCE INDEX (PRIMARY, uk_tenant_purge_plan_receipts_tenant, uk_tenant_purge_plan_receipts_generation, uk_tenant_purge_plan_receipts_hash) WHERE 1=0;

SET @tenant_purge_plan_receipt_index_ok = (
  SELECT COUNT(DISTINCT index_name)=4 AND COUNT(*)=5
     AND SHA2(GROUP_CONCAT(CONCAT_WS('~',index_name,non_unique,seq_in_index,
           LOWER(index_type),LOWER(is_visible),IFNULL(column_name,'<expression>'),
           IFNULL(CAST(sub_part AS CHAR),'-'),LOWER(IFNULL(collation,'-')),
           IFNULL(expression,'-')) ORDER BY index_name,seq_in_index SEPARATOR '|'),256)
         = 'f1613e0c4b3c0ccf7c661c3db1fbfb7a2dfb82298c7d52bc44c6c55dbefb9884'
    FROM information_schema.statistics
   WHERE table_schema=DATABASE() AND table_name='tenant_purge_plan_receipts'
);
SET @migration_sql = IF(@tenant_purge_plan_receipt_index_ok=1, 'SELECT 1',
  'SELECT 1 FROM __invalid_tenant_purge_plan_receipts_index_shape__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @tenant_purge_plan_receipt_schema_ok = (
  SELECT table_type='BASE TABLE' AND engine='InnoDB' AND table_collation='utf8mb4_0900_as_cs'
     AND (SELECT COUNT(*) FROM information_schema.table_constraints
           WHERE table_schema=DATABASE() AND table_name='tenant_purge_plan_receipts')=9
     AND NOT EXISTS (SELECT 1 FROM information_schema.partitions
           WHERE table_schema=DATABASE() AND table_name='tenant_purge_plan_receipts' AND partition_name IS NOT NULL)
     AND (SELECT COUNT(*)=26 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',
            LPAD(ordinal_position,3,'0'),column_name,LOWER(column_type),is_nullable,
            IF(column_default IS NULL,'<NULL>',CONCAT('<',column_default,'>')),
            IFNULL(character_set_name,'-'),IFNULL(collation_name,'-'),
            IFNULL(NULLIF(LOWER(extra),''),'-'),
            IFNULL(NULLIF(LOWER(generation_expression),''),'-'))
            ORDER BY ordinal_position SEPARATOR '|'),256)='7d777383954bc70a17681aac8b185835099c499338c5f541583cbdf268c533b2'
          FROM information_schema.columns
         WHERE table_schema=DATABASE() AND table_name='tenant_purge_plan_receipts')
     AND (SELECT COUNT(*)=5 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',
            tc.constraint_name,tc.enforced,LOWER(REPLACE(REPLACE(REGEXP_REPLACE(
              cc.check_clause,'[[:space:]]',''),CHAR(96),''),'_utf8mb4','')))
            ORDER BY tc.constraint_name SEPARATOR '|'),256)='a823ba7d22edd30e113fd1495b08e52943c8e1fe805e4e3a59af2a231018f5c8'
          FROM information_schema.table_constraints tc
          JOIN information_schema.check_constraints cc
            ON cc.constraint_schema=tc.constraint_schema
           AND cc.constraint_name=tc.constraint_name
         WHERE tc.table_schema=DATABASE() AND tc.table_name='tenant_purge_plan_receipts'
           AND tc.constraint_type='CHECK')
    FROM information_schema.tables
   WHERE table_schema=DATABASE() AND table_name='tenant_purge_plan_receipts'
);
SET @migration_sql = IF(@tenant_purge_plan_receipt_schema_ok=1, 'SELECT 1',
  'SELECT 1 FROM __invalid_tenant_purge_plan_receipts_schema__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- Job source identity is immutable; terminal jobs are immutable. Bootstrap-first rotation keeps
-- every marker-loss replay prefix protected despite MySQL DDL auto-commit.
DROP TRIGGER IF EXISTS trg_tenant_purge_plan_jobs_bu_bootstrap;
CREATE TRIGGER trg_tenant_purge_plan_jobs_bu_bootstrap BEFORE UPDATE ON tenant_purge_plan_jobs FOR EACH ROW BEGIN IF NOT ( OLD.request_id <=> NEW.request_id AND OLD.tenant_id <=> NEW.tenant_id AND OLD.subject_generation <=> NEW.subject_generation AND OLD.t1_fence_sha256 <=> NEW.t1_fence_sha256 AND OLD.t3a_receipt_sha256 <=> NEW.t3a_receipt_sha256 AND OLD.t3b_receipt_sha256 <=> NEW.t3b_receipt_sha256 AND OLD.t3c_receipt_sha256 <=> NEW.t3c_receipt_sha256 AND OLD.policy_version <=> NEW.policy_version AND OLD.policy_sha256 <=> NEW.policy_sha256 AND OLD.policy_schema_version <=> NEW.policy_schema_version AND OLD.build_generation <=> NEW.build_generation AND OLD.retention_anchor_db_ms <=> NEW.retention_anchor_db_ms AND OLD.purge_not_before_db_ms <=> NEW.purge_not_before_db_ms AND OLD.source_evidence_db_ms <=> NEW.source_evidence_db_ms AND OLD.created_at_ms <=> NEW.created_at_ms AND NEW.updated_at_ms >= OLD.updated_at_ms AND OLD.phase='queued' AND ((NEW.phase='queued' AND NEW.attempts=OLD.attempts+1 AND NEW.claim_token IS NOT NULL AND NEW.lease_until_ms IS NOT NULL AND NEW.last_error_code IS NULL AND NEW.available_at_ms <=> OLD.available_at_ms AND NEW.cursor_domain <=> OLD.cursor_domain AND NEW.scan_complete <=> OLD.scan_complete AND NEW.plan_entry_count <=> OLD.plan_entry_count AND NEW.plan_entry_root_sha256 <=> OLD.plan_entry_root_sha256 AND NEW.blocker_count <=> OLD.blocker_count AND NEW.blocker_root_sha256 <=> OLD.blocker_root_sha256) OR (NEW.phase='queued' AND NEW.attempts=OLD.attempts AND OLD.claim_token IS NOT NULL AND NEW.claim_token <=> OLD.claim_token AND OLD.lease_until_ms IS NOT NULL AND NEW.lease_until_ms >= OLD.lease_until_ms AND NEW.last_error_code IS NULL AND NEW.available_at_ms <=> OLD.available_at_ms AND ((NEW.cursor_domain <=> OLD.cursor_domain AND NEW.scan_complete <=> OLD.scan_complete AND NEW.plan_entry_count <=> OLD.plan_entry_count AND NEW.plan_entry_root_sha256 <=> OLD.plan_entry_root_sha256 AND NEW.blocker_count <=> OLD.blocker_count AND NEW.blocker_root_sha256 <=> OLD.blocker_root_sha256) OR (OLD.scan_complete=FALSE AND NEW.scan_complete=FALSE AND NEW.plan_entry_count>OLD.plan_entry_count AND NEW.cursor_domain IS NOT NULL AND NOT (NEW.cursor_domain <=> OLD.cursor_domain) AND NOT (NEW.plan_entry_root_sha256 <=> OLD.plan_entry_root_sha256) AND NEW.blocker_count>=OLD.blocker_count AND ((NEW.blocker_count=OLD.blocker_count AND NEW.blocker_root_sha256 <=> OLD.blocker_root_sha256) OR (NEW.blocker_count>OLD.blocker_count AND NOT (NEW.blocker_root_sha256 <=> OLD.blocker_root_sha256)))) OR (OLD.scan_complete=FALSE AND NEW.scan_complete=TRUE AND NEW.cursor_domain <=> OLD.cursor_domain AND NEW.plan_entry_count <=> OLD.plan_entry_count AND NEW.plan_entry_root_sha256 <=> OLD.plan_entry_root_sha256 AND NEW.blocker_count <=> OLD.blocker_count AND NEW.blocker_root_sha256 <=> OLD.blocker_root_sha256))) OR (NEW.phase='queued' AND NEW.attempts=OLD.attempts AND OLD.claim_token IS NOT NULL AND NEW.claim_token IS NULL AND NEW.lease_until_ms IS NULL AND NEW.last_error_code='temporary_failure' AND NEW.available_at_ms>=OLD.available_at_ms AND NEW.available_at_ms>=NEW.updated_at_ms AND NEW.cursor_domain <=> OLD.cursor_domain AND NEW.scan_complete <=> OLD.scan_complete AND NEW.plan_entry_count <=> OLD.plan_entry_count AND NEW.plan_entry_root_sha256 <=> OLD.plan_entry_root_sha256 AND NEW.blocker_count <=> OLD.blocker_count AND NEW.blocker_root_sha256 <=> OLD.blocker_root_sha256) OR (NEW.phase='plan_sealed' AND OLD.claim_token IS NOT NULL AND OLD.scan_complete=TRUE AND NEW.scan_complete=TRUE AND NEW.attempts=OLD.attempts AND NEW.cursor_domain <=> OLD.cursor_domain AND NEW.plan_entry_count <=> OLD.plan_entry_count AND NEW.plan_entry_root_sha256 <=> OLD.plan_entry_root_sha256 AND NEW.blocker_count <=> OLD.blocker_count AND NEW.blocker_root_sha256 <=> OLD.blocker_root_sha256 AND NEW.completed_claim_attempt=OLD.attempts) OR (NEW.phase='blocked' AND OLD.claim_token IS NOT NULL AND NEW.attempts=OLD.attempts AND NEW.cursor_domain <=> OLD.cursor_domain AND NEW.scan_complete <=> OLD.scan_complete AND NEW.plan_entry_count <=> OLD.plan_entry_count AND NEW.plan_entry_root_sha256 <=> OLD.plan_entry_root_sha256 AND NEW.blocker_count <=> OLD.blocker_count AND NEW.blocker_root_sha256 <=> OLD.blocker_root_sha256))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge plan job update is not permitted'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_purge_plan_jobs_bu;
CREATE TRIGGER trg_tenant_purge_plan_jobs_bu BEFORE UPDATE ON tenant_purge_plan_jobs FOR EACH ROW BEGIN IF NOT ( OLD.request_id <=> NEW.request_id AND OLD.tenant_id <=> NEW.tenant_id AND OLD.subject_generation <=> NEW.subject_generation AND OLD.t1_fence_sha256 <=> NEW.t1_fence_sha256 AND OLD.t3a_receipt_sha256 <=> NEW.t3a_receipt_sha256 AND OLD.t3b_receipt_sha256 <=> NEW.t3b_receipt_sha256 AND OLD.t3c_receipt_sha256 <=> NEW.t3c_receipt_sha256 AND OLD.policy_version <=> NEW.policy_version AND OLD.policy_sha256 <=> NEW.policy_sha256 AND OLD.policy_schema_version <=> NEW.policy_schema_version AND OLD.build_generation <=> NEW.build_generation AND OLD.retention_anchor_db_ms <=> NEW.retention_anchor_db_ms AND OLD.purge_not_before_db_ms <=> NEW.purge_not_before_db_ms AND OLD.source_evidence_db_ms <=> NEW.source_evidence_db_ms AND OLD.created_at_ms <=> NEW.created_at_ms AND NEW.updated_at_ms >= OLD.updated_at_ms AND OLD.phase='queued' AND ((NEW.phase='queued' AND NEW.attempts=OLD.attempts+1 AND NEW.claim_token IS NOT NULL AND NEW.lease_until_ms IS NOT NULL AND NEW.last_error_code IS NULL AND NEW.available_at_ms <=> OLD.available_at_ms AND NEW.cursor_domain <=> OLD.cursor_domain AND NEW.scan_complete <=> OLD.scan_complete AND NEW.plan_entry_count <=> OLD.plan_entry_count AND NEW.plan_entry_root_sha256 <=> OLD.plan_entry_root_sha256 AND NEW.blocker_count <=> OLD.blocker_count AND NEW.blocker_root_sha256 <=> OLD.blocker_root_sha256) OR (NEW.phase='queued' AND NEW.attempts=OLD.attempts AND OLD.claim_token IS NOT NULL AND NEW.claim_token <=> OLD.claim_token AND OLD.lease_until_ms IS NOT NULL AND NEW.lease_until_ms >= OLD.lease_until_ms AND NEW.last_error_code IS NULL AND NEW.available_at_ms <=> OLD.available_at_ms AND ((NEW.cursor_domain <=> OLD.cursor_domain AND NEW.scan_complete <=> OLD.scan_complete AND NEW.plan_entry_count <=> OLD.plan_entry_count AND NEW.plan_entry_root_sha256 <=> OLD.plan_entry_root_sha256 AND NEW.blocker_count <=> OLD.blocker_count AND NEW.blocker_root_sha256 <=> OLD.blocker_root_sha256) OR (OLD.scan_complete=FALSE AND NEW.scan_complete=FALSE AND NEW.plan_entry_count>OLD.plan_entry_count AND NEW.cursor_domain IS NOT NULL AND NOT (NEW.cursor_domain <=> OLD.cursor_domain) AND NOT (NEW.plan_entry_root_sha256 <=> OLD.plan_entry_root_sha256) AND NEW.blocker_count>=OLD.blocker_count AND ((NEW.blocker_count=OLD.blocker_count AND NEW.blocker_root_sha256 <=> OLD.blocker_root_sha256) OR (NEW.blocker_count>OLD.blocker_count AND NOT (NEW.blocker_root_sha256 <=> OLD.blocker_root_sha256)))) OR (OLD.scan_complete=FALSE AND NEW.scan_complete=TRUE AND NEW.cursor_domain <=> OLD.cursor_domain AND NEW.plan_entry_count <=> OLD.plan_entry_count AND NEW.plan_entry_root_sha256 <=> OLD.plan_entry_root_sha256 AND NEW.blocker_count <=> OLD.blocker_count AND NEW.blocker_root_sha256 <=> OLD.blocker_root_sha256))) OR (NEW.phase='queued' AND NEW.attempts=OLD.attempts AND OLD.claim_token IS NOT NULL AND NEW.claim_token IS NULL AND NEW.lease_until_ms IS NULL AND NEW.last_error_code='temporary_failure' AND NEW.available_at_ms>=OLD.available_at_ms AND NEW.available_at_ms>=NEW.updated_at_ms AND NEW.cursor_domain <=> OLD.cursor_domain AND NEW.scan_complete <=> OLD.scan_complete AND NEW.plan_entry_count <=> OLD.plan_entry_count AND NEW.plan_entry_root_sha256 <=> OLD.plan_entry_root_sha256 AND NEW.blocker_count <=> OLD.blocker_count AND NEW.blocker_root_sha256 <=> OLD.blocker_root_sha256) OR (NEW.phase='plan_sealed' AND OLD.claim_token IS NOT NULL AND OLD.scan_complete=TRUE AND NEW.scan_complete=TRUE AND NEW.attempts=OLD.attempts AND NEW.cursor_domain <=> OLD.cursor_domain AND NEW.plan_entry_count <=> OLD.plan_entry_count AND NEW.plan_entry_root_sha256 <=> OLD.plan_entry_root_sha256 AND NEW.blocker_count <=> OLD.blocker_count AND NEW.blocker_root_sha256 <=> OLD.blocker_root_sha256 AND NEW.completed_claim_attempt=OLD.attempts) OR (NEW.phase='blocked' AND OLD.claim_token IS NOT NULL AND NEW.attempts=OLD.attempts AND NEW.cursor_domain <=> OLD.cursor_domain AND NEW.scan_complete <=> OLD.scan_complete AND NEW.plan_entry_count <=> OLD.plan_entry_count AND NEW.plan_entry_root_sha256 <=> OLD.plan_entry_root_sha256 AND NEW.blocker_count <=> OLD.blocker_count AND NEW.blocker_root_sha256 <=> OLD.blocker_root_sha256))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge plan job update is not permitted'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_purge_plan_jobs_bu_guard_a;
CREATE TRIGGER trg_tenant_purge_plan_jobs_bu_guard_a BEFORE UPDATE ON tenant_purge_plan_jobs FOR EACH ROW BEGIN IF NOT ( OLD.request_id <=> NEW.request_id AND OLD.tenant_id <=> NEW.tenant_id AND OLD.subject_generation <=> NEW.subject_generation AND OLD.t1_fence_sha256 <=> NEW.t1_fence_sha256 AND OLD.t3a_receipt_sha256 <=> NEW.t3a_receipt_sha256 AND OLD.t3b_receipt_sha256 <=> NEW.t3b_receipt_sha256 AND OLD.t3c_receipt_sha256 <=> NEW.t3c_receipt_sha256 AND OLD.policy_version <=> NEW.policy_version AND OLD.policy_sha256 <=> NEW.policy_sha256 AND OLD.policy_schema_version <=> NEW.policy_schema_version AND OLD.build_generation <=> NEW.build_generation AND OLD.retention_anchor_db_ms <=> NEW.retention_anchor_db_ms AND OLD.purge_not_before_db_ms <=> NEW.purge_not_before_db_ms AND OLD.source_evidence_db_ms <=> NEW.source_evidence_db_ms AND OLD.created_at_ms <=> NEW.created_at_ms AND NEW.updated_at_ms >= OLD.updated_at_ms AND OLD.phase='queued' AND ((NEW.phase='queued' AND NEW.attempts=OLD.attempts+1 AND NEW.claim_token IS NOT NULL AND NEW.lease_until_ms IS NOT NULL AND NEW.last_error_code IS NULL AND NEW.available_at_ms <=> OLD.available_at_ms AND NEW.cursor_domain <=> OLD.cursor_domain AND NEW.scan_complete <=> OLD.scan_complete AND NEW.plan_entry_count <=> OLD.plan_entry_count AND NEW.plan_entry_root_sha256 <=> OLD.plan_entry_root_sha256 AND NEW.blocker_count <=> OLD.blocker_count AND NEW.blocker_root_sha256 <=> OLD.blocker_root_sha256) OR (NEW.phase='queued' AND NEW.attempts=OLD.attempts AND OLD.claim_token IS NOT NULL AND NEW.claim_token <=> OLD.claim_token AND OLD.lease_until_ms IS NOT NULL AND NEW.lease_until_ms >= OLD.lease_until_ms AND NEW.last_error_code IS NULL AND NEW.available_at_ms <=> OLD.available_at_ms AND ((NEW.cursor_domain <=> OLD.cursor_domain AND NEW.scan_complete <=> OLD.scan_complete AND NEW.plan_entry_count <=> OLD.plan_entry_count AND NEW.plan_entry_root_sha256 <=> OLD.plan_entry_root_sha256 AND NEW.blocker_count <=> OLD.blocker_count AND NEW.blocker_root_sha256 <=> OLD.blocker_root_sha256) OR (OLD.scan_complete=FALSE AND NEW.scan_complete=FALSE AND NEW.plan_entry_count>OLD.plan_entry_count AND NEW.cursor_domain IS NOT NULL AND NOT (NEW.cursor_domain <=> OLD.cursor_domain) AND NOT (NEW.plan_entry_root_sha256 <=> OLD.plan_entry_root_sha256) AND NEW.blocker_count>=OLD.blocker_count AND ((NEW.blocker_count=OLD.blocker_count AND NEW.blocker_root_sha256 <=> OLD.blocker_root_sha256) OR (NEW.blocker_count>OLD.blocker_count AND NOT (NEW.blocker_root_sha256 <=> OLD.blocker_root_sha256)))) OR (OLD.scan_complete=FALSE AND NEW.scan_complete=TRUE AND NEW.cursor_domain <=> OLD.cursor_domain AND NEW.plan_entry_count <=> OLD.plan_entry_count AND NEW.plan_entry_root_sha256 <=> OLD.plan_entry_root_sha256 AND NEW.blocker_count <=> OLD.blocker_count AND NEW.blocker_root_sha256 <=> OLD.blocker_root_sha256))) OR (NEW.phase='queued' AND NEW.attempts=OLD.attempts AND OLD.claim_token IS NOT NULL AND NEW.claim_token IS NULL AND NEW.lease_until_ms IS NULL AND NEW.last_error_code='temporary_failure' AND NEW.available_at_ms>=OLD.available_at_ms AND NEW.available_at_ms>=NEW.updated_at_ms AND NEW.cursor_domain <=> OLD.cursor_domain AND NEW.scan_complete <=> OLD.scan_complete AND NEW.plan_entry_count <=> OLD.plan_entry_count AND NEW.plan_entry_root_sha256 <=> OLD.plan_entry_root_sha256 AND NEW.blocker_count <=> OLD.blocker_count AND NEW.blocker_root_sha256 <=> OLD.blocker_root_sha256) OR (NEW.phase='plan_sealed' AND OLD.claim_token IS NOT NULL AND OLD.scan_complete=TRUE AND NEW.scan_complete=TRUE AND NEW.attempts=OLD.attempts AND NEW.cursor_domain <=> OLD.cursor_domain AND NEW.plan_entry_count <=> OLD.plan_entry_count AND NEW.plan_entry_root_sha256 <=> OLD.plan_entry_root_sha256 AND NEW.blocker_count <=> OLD.blocker_count AND NEW.blocker_root_sha256 <=> OLD.blocker_root_sha256 AND NEW.completed_claim_attempt=OLD.attempts) OR (NEW.phase='blocked' AND OLD.claim_token IS NOT NULL AND NEW.attempts=OLD.attempts AND NEW.cursor_domain <=> OLD.cursor_domain AND NEW.scan_complete <=> OLD.scan_complete AND NEW.plan_entry_count <=> OLD.plan_entry_count AND NEW.plan_entry_root_sha256 <=> OLD.plan_entry_root_sha256 AND NEW.blocker_count <=> OLD.blocker_count AND NEW.blocker_root_sha256 <=> OLD.blocker_root_sha256))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge plan job update is not permitted'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_purge_plan_jobs_bu_guard_b;
CREATE TRIGGER trg_tenant_purge_plan_jobs_bu_guard_b BEFORE UPDATE ON tenant_purge_plan_jobs FOR EACH ROW BEGIN IF NOT ( OLD.request_id <=> NEW.request_id AND OLD.tenant_id <=> NEW.tenant_id AND OLD.subject_generation <=> NEW.subject_generation AND OLD.t1_fence_sha256 <=> NEW.t1_fence_sha256 AND OLD.t3a_receipt_sha256 <=> NEW.t3a_receipt_sha256 AND OLD.t3b_receipt_sha256 <=> NEW.t3b_receipt_sha256 AND OLD.t3c_receipt_sha256 <=> NEW.t3c_receipt_sha256 AND OLD.policy_version <=> NEW.policy_version AND OLD.policy_sha256 <=> NEW.policy_sha256 AND OLD.policy_schema_version <=> NEW.policy_schema_version AND OLD.build_generation <=> NEW.build_generation AND OLD.retention_anchor_db_ms <=> NEW.retention_anchor_db_ms AND OLD.purge_not_before_db_ms <=> NEW.purge_not_before_db_ms AND OLD.source_evidence_db_ms <=> NEW.source_evidence_db_ms AND OLD.created_at_ms <=> NEW.created_at_ms AND NEW.updated_at_ms >= OLD.updated_at_ms AND OLD.phase='queued' AND ((NEW.phase='queued' AND NEW.attempts=OLD.attempts+1 AND NEW.claim_token IS NOT NULL AND NEW.lease_until_ms IS NOT NULL AND NEW.last_error_code IS NULL AND NEW.available_at_ms <=> OLD.available_at_ms AND NEW.cursor_domain <=> OLD.cursor_domain AND NEW.scan_complete <=> OLD.scan_complete AND NEW.plan_entry_count <=> OLD.plan_entry_count AND NEW.plan_entry_root_sha256 <=> OLD.plan_entry_root_sha256 AND NEW.blocker_count <=> OLD.blocker_count AND NEW.blocker_root_sha256 <=> OLD.blocker_root_sha256) OR (NEW.phase='queued' AND NEW.attempts=OLD.attempts AND OLD.claim_token IS NOT NULL AND NEW.claim_token <=> OLD.claim_token AND OLD.lease_until_ms IS NOT NULL AND NEW.lease_until_ms >= OLD.lease_until_ms AND NEW.last_error_code IS NULL AND NEW.available_at_ms <=> OLD.available_at_ms AND ((NEW.cursor_domain <=> OLD.cursor_domain AND NEW.scan_complete <=> OLD.scan_complete AND NEW.plan_entry_count <=> OLD.plan_entry_count AND NEW.plan_entry_root_sha256 <=> OLD.plan_entry_root_sha256 AND NEW.blocker_count <=> OLD.blocker_count AND NEW.blocker_root_sha256 <=> OLD.blocker_root_sha256) OR (OLD.scan_complete=FALSE AND NEW.scan_complete=FALSE AND NEW.plan_entry_count>OLD.plan_entry_count AND NEW.cursor_domain IS NOT NULL AND NOT (NEW.cursor_domain <=> OLD.cursor_domain) AND NOT (NEW.plan_entry_root_sha256 <=> OLD.plan_entry_root_sha256) AND NEW.blocker_count>=OLD.blocker_count AND ((NEW.blocker_count=OLD.blocker_count AND NEW.blocker_root_sha256 <=> OLD.blocker_root_sha256) OR (NEW.blocker_count>OLD.blocker_count AND NOT (NEW.blocker_root_sha256 <=> OLD.blocker_root_sha256)))) OR (OLD.scan_complete=FALSE AND NEW.scan_complete=TRUE AND NEW.cursor_domain <=> OLD.cursor_domain AND NEW.plan_entry_count <=> OLD.plan_entry_count AND NEW.plan_entry_root_sha256 <=> OLD.plan_entry_root_sha256 AND NEW.blocker_count <=> OLD.blocker_count AND NEW.blocker_root_sha256 <=> OLD.blocker_root_sha256))) OR (NEW.phase='queued' AND NEW.attempts=OLD.attempts AND OLD.claim_token IS NOT NULL AND NEW.claim_token IS NULL AND NEW.lease_until_ms IS NULL AND NEW.last_error_code='temporary_failure' AND NEW.available_at_ms>=OLD.available_at_ms AND NEW.available_at_ms>=NEW.updated_at_ms AND NEW.cursor_domain <=> OLD.cursor_domain AND NEW.scan_complete <=> OLD.scan_complete AND NEW.plan_entry_count <=> OLD.plan_entry_count AND NEW.plan_entry_root_sha256 <=> OLD.plan_entry_root_sha256 AND NEW.blocker_count <=> OLD.blocker_count AND NEW.blocker_root_sha256 <=> OLD.blocker_root_sha256) OR (NEW.phase='plan_sealed' AND OLD.claim_token IS NOT NULL AND OLD.scan_complete=TRUE AND NEW.scan_complete=TRUE AND NEW.attempts=OLD.attempts AND NEW.cursor_domain <=> OLD.cursor_domain AND NEW.plan_entry_count <=> OLD.plan_entry_count AND NEW.plan_entry_root_sha256 <=> OLD.plan_entry_root_sha256 AND NEW.blocker_count <=> OLD.blocker_count AND NEW.blocker_root_sha256 <=> OLD.blocker_root_sha256 AND NEW.completed_claim_attempt=OLD.attempts) OR (NEW.phase='blocked' AND OLD.claim_token IS NOT NULL AND NEW.attempts=OLD.attempts AND NEW.cursor_domain <=> OLD.cursor_domain AND NEW.scan_complete <=> OLD.scan_complete AND NEW.plan_entry_count <=> OLD.plan_entry_count AND NEW.plan_entry_root_sha256 <=> OLD.plan_entry_root_sha256 AND NEW.blocker_count <=> OLD.blocker_count AND NEW.blocker_root_sha256 <=> OLD.blocker_root_sha256))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge plan job update is not permitted'; END IF; END;
DROP TRIGGER IF EXISTS trg_tenant_purge_plan_jobs_bu_bootstrap;

DROP TRIGGER IF EXISTS trg_tenant_purge_plan_jobs_bd_bootstrap;
CREATE TRIGGER trg_tenant_purge_plan_jobs_bd_bootstrap BEFORE DELETE ON tenant_purge_plan_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge plan jobs cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_purge_plan_jobs_bd;
CREATE TRIGGER trg_tenant_purge_plan_jobs_bd BEFORE DELETE ON tenant_purge_plan_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge plan jobs cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_purge_plan_jobs_bd_guard_a;
CREATE TRIGGER trg_tenant_purge_plan_jobs_bd_guard_a BEFORE DELETE ON tenant_purge_plan_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge plan jobs cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_purge_plan_jobs_bd_guard_b;
CREATE TRIGGER trg_tenant_purge_plan_jobs_bd_guard_b BEFORE DELETE ON tenant_purge_plan_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge plan jobs cannot be deleted';
DROP TRIGGER IF EXISTS trg_tenant_purge_plan_jobs_bd_bootstrap;

-- Entries and aggregate receipts are permanently append-only.
DROP TRIGGER IF EXISTS trg_tenant_purge_plan_entries_bu_bootstrap;
CREATE TRIGGER trg_tenant_purge_plan_entries_bu_bootstrap BEFORE UPDATE ON tenant_purge_plan_entries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge plan entries are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_plan_entries_bu;
CREATE TRIGGER trg_tenant_purge_plan_entries_bu BEFORE UPDATE ON tenant_purge_plan_entries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge plan entries are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_plan_entries_bu_guard_a;
CREATE TRIGGER trg_tenant_purge_plan_entries_bu_guard_a BEFORE UPDATE ON tenant_purge_plan_entries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge plan entries are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_plan_entries_bu_guard_b;
CREATE TRIGGER trg_tenant_purge_plan_entries_bu_guard_b BEFORE UPDATE ON tenant_purge_plan_entries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge plan entries are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_plan_entries_bu_bootstrap;

DROP TRIGGER IF EXISTS trg_tenant_purge_plan_entries_bd_bootstrap;
CREATE TRIGGER trg_tenant_purge_plan_entries_bd_bootstrap BEFORE DELETE ON tenant_purge_plan_entries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge plan entries are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_plan_entries_bd;
CREATE TRIGGER trg_tenant_purge_plan_entries_bd BEFORE DELETE ON tenant_purge_plan_entries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge plan entries are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_plan_entries_bd_guard_a;
CREATE TRIGGER trg_tenant_purge_plan_entries_bd_guard_a BEFORE DELETE ON tenant_purge_plan_entries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge plan entries are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_plan_entries_bd_guard_b;
CREATE TRIGGER trg_tenant_purge_plan_entries_bd_guard_b BEFORE DELETE ON tenant_purge_plan_entries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge plan entries are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_plan_entries_bd_bootstrap;

DROP TRIGGER IF EXISTS trg_tenant_purge_plan_receipts_bu_bootstrap;
CREATE TRIGGER trg_tenant_purge_plan_receipts_bu_bootstrap BEFORE UPDATE ON tenant_purge_plan_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge plan receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_plan_receipts_bu;
CREATE TRIGGER trg_tenant_purge_plan_receipts_bu BEFORE UPDATE ON tenant_purge_plan_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge plan receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_plan_receipts_bu_guard_a;
CREATE TRIGGER trg_tenant_purge_plan_receipts_bu_guard_a BEFORE UPDATE ON tenant_purge_plan_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge plan receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_plan_receipts_bu_guard_b;
CREATE TRIGGER trg_tenant_purge_plan_receipts_bu_guard_b BEFORE UPDATE ON tenant_purge_plan_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge plan receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_plan_receipts_bu_bootstrap;

DROP TRIGGER IF EXISTS trg_tenant_purge_plan_receipts_bd_bootstrap;
CREATE TRIGGER trg_tenant_purge_plan_receipts_bd_bootstrap BEFORE DELETE ON tenant_purge_plan_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge plan receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_plan_receipts_bd;
CREATE TRIGGER trg_tenant_purge_plan_receipts_bd BEFORE DELETE ON tenant_purge_plan_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge plan receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_plan_receipts_bd_guard_a;
CREATE TRIGGER trg_tenant_purge_plan_receipts_bd_guard_a BEFORE DELETE ON tenant_purge_plan_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge plan receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_plan_receipts_bd_guard_b;
CREATE TRIGGER trg_tenant_purge_plan_receipts_bd_guard_b BEFORE DELETE ON tenant_purge_plan_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge plan receipts are append-only';
DROP TRIGGER IF EXISTS trg_tenant_purge_plan_receipts_bd_bootstrap;

SET @tenant_purge_plan_trigger_set_ok = (
  SELECT COUNT(*)=18 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',event_object_table,trigger_name,
           action_timing,event_manipulation,action_orientation,
           IFNULL(action_condition,'<NULL>'))
         ORDER BY event_object_table,trigger_name SEPARATOR '|'),256)
       = '82046f3dd69b4418aea12cbce035ebb7451e436575901520a4ce199a9c091fc6'
    FROM information_schema.triggers
   WHERE trigger_schema=DATABASE()
     AND event_object_table IN ('tenant_purge_plan_jobs','tenant_purge_plan_entries',
                                'tenant_purge_plan_receipts')
);
SET @migration_sql = IF(@tenant_purge_plan_trigger_set_ok=1, 'SELECT 1',
  'SELECT 1 FROM __invalid_tenant_purge_plan_trigger_set__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
SET SESSION group_concat_max_len = @tenant_purge_plan_previous_group_concat_max_len;
