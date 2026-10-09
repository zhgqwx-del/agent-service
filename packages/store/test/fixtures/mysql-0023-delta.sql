-- Historical MySQL schema delta frozen at migration 0023.
--
-- Apply only after the committed mysql-0017.sql, mysql-0020-delta.sql,
-- mysql-0021-delta.sql, and mysql-0022-delta.sql fixtures. This file is an
-- independent snapshot of the schema actually installed by 0023; upgrade tests
-- must never regenerate a historical database from the live 0023 migration.

CREATE TABLE `tenant_purge_execution_jobs` (
  `request_id` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `tenant_id` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `subject_generation` bigint unsigned NOT NULL,
  `plan_build_generation` bigint unsigned NOT NULL,
  `execution_generation` bigint unsigned NOT NULL,
  `t3c_receipt_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `plan_receipt_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `plan_entry_root_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `plan_blocker_count` bigint unsigned NOT NULL,
  `plan_blocker_root_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `policy_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `purge_not_before_db_ms` bigint NOT NULL,
  `source_evidence_db_ms` bigint NOT NULL,
  `phase` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `domain_count` bigint unsigned NOT NULL,
  `domain_ack_count` bigint unsigned NOT NULL,
  `domain_ack_root_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `unresolved_blocker_count` bigint unsigned NOT NULL,
  `local_cutover_receipt_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `available_at_ms` bigint DEFAULT NULL,
  `attempts` int unsigned NOT NULL DEFAULT '0',
  `claim_token` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `lease_until_ms` bigint DEFAULT NULL,
  `last_error_code` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `created_at_ms` bigint NOT NULL,
  `updated_at_ms` bigint NOT NULL,
  `local_physical_ack_receipt_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `local_physical_acks_sealed_at_ms` bigint DEFAULT NULL,
  `completed_claim_attempt` int unsigned DEFAULT NULL,
  `completed_claim_token_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `blocked_at_ms` bigint DEFAULT NULL,
  `blocked_reason_code` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  PRIMARY KEY (`request_id`),
  UNIQUE KEY `uk_tenant_purge_exec_jobs_tenant` (`tenant_id`),
  UNIQUE KEY `uk_tenant_purge_exec_jobs_generation` (`tenant_id`,`subject_generation`,`execution_generation`),
  UNIQUE KEY `uk_tenant_purge_exec_jobs_identity` (`request_id`,`tenant_id`,`subject_generation`,`plan_build_generation`,`execution_generation`),
  KEY `idx_tenant_purge_exec_jobs_claim` (`phase`,`available_at_ms`,`lease_until_ms`,`request_id`),
  CONSTRAINT `fk_tenant_purge_exec_job_inventory` FOREIGN KEY (`request_id`) REFERENCES `tenant_content_inventory_receipts` (`request_id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_tenant_purge_exec_job_plan` FOREIGN KEY (`request_id`) REFERENCES `tenant_purge_plan_receipts` (`request_id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `chk_tenant_purge_exec_job_clock` CHECK (((`purge_not_before_db_ms` >= 0) and (`source_evidence_db_ms` >= `purge_not_before_db_ms`) and (`created_at_ms` >= 0) and (`updated_at_ms` >= `created_at_ms`))),
  CONSTRAINT `chk_tenant_purge_exec_job_generations` CHECK (((`subject_generation` > 0) and (`plan_build_generation` > 0) and (`execution_generation` > 0))),
  CONSTRAINT `chk_tenant_purge_exec_job_phase` CHECK ((((`phase` = _utf8mb4'queued') and (`available_at_ms` is not null) and (`available_at_ms` >= `created_at_ms`) and (((`claim_token` is null) and (`lease_until_ms` is null) and (`available_at_ms` >= `updated_at_ms`)) or ((`claim_token` is not null) and (`lease_until_ms` is not null) and (`attempts` > 0) and (`lease_until_ms` >= `updated_at_ms`))) and (((`claim_token` is not null) and (`last_error_code` is null)) or ((`claim_token` is null) and ((`last_error_code` is null) or (`last_error_code` in (_utf8mb4'temporary_failure',_utf8mb4'physical_ack_pending'))))) and (`local_physical_ack_receipt_sha256` is null) and (`local_physical_acks_sealed_at_ms` is null) and (`completed_claim_attempt` is null) and (`completed_claim_token_sha256` is null) and (`blocked_at_ms` is null) and (`blocked_reason_code` is null)) or ((`phase` = _utf8mb4'local_physical_acks_sealed') and (`available_at_ms` is null) and (`claim_token` is null) and (`lease_until_ms` is null) and (`last_error_code` is null) and (`local_cutover_receipt_sha256` is not null) and (`local_physical_ack_receipt_sha256` is not null) and (`local_physical_acks_sealed_at_ms` is not null) and (`local_physical_acks_sealed_at_ms` >= `source_evidence_db_ms`) and (`local_physical_acks_sealed_at_ms` <= `updated_at_ms`) and (`completed_claim_attempt` is not null) and (`completed_claim_attempt` = `attempts`) and (`attempts` > 0) and (`completed_claim_token_sha256` is not null) and (`blocked_at_ms` is null) and (`blocked_reason_code` is null)) or ((`phase` = _utf8mb4'blocked') and (`available_at_ms` is null) and (`claim_token` is null) and (`lease_until_ms` is null) and (`last_error_code` is null) and (`local_physical_ack_receipt_sha256` is null) and (`local_physical_acks_sealed_at_ms` is null) and (`completed_claim_attempt` is null) and (`completed_claim_token_sha256` is null) and (`blocked_at_ms` is not null) and (`blocked_at_ms` >= `created_at_ms`) and (`blocked_at_ms` <= `updated_at_ms`) and (`attempts` > 0) and (`blocked_reason_code` in (_utf8mb4'integrity_conflict',_utf8mb4'physical_ack_dead_lettered'))))),
  CONSTRAINT `chk_tenant_purge_exec_job_progress` CHECK (((`domain_count` = 33) and (`plan_blocker_count` <= `domain_count`) and (`unresolved_blocker_count` <= `plan_blocker_count`) and (((`domain_ack_count` = 0) and (`domain_ack_root_sha256` = _utf8mb4'4037bd781598fb6d6ee2aebf00cf1096f3e0438932abd9353da8655c1e6504e0')) or (`domain_ack_count` > 0))))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE `tenant_purge_execution_domains` (
  `request_id` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `tenant_id` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `subject_generation` bigint unsigned NOT NULL,
  `plan_build_generation` bigint unsigned NOT NULL,
  `execution_generation` bigint unsigned NOT NULL,
  `domain` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `execution_ordinal` tinyint unsigned NOT NULL,
  `plan_disposition` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `plan_target_count` bigint unsigned NOT NULL,
  `plan_target_root_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `plan_source_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `plan_entry_receipt_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `phase` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `ack_count` bigint unsigned NOT NULL,
  `ack_root_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `final_ack_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `updated_at_ms` bigint NOT NULL,
  PRIMARY KEY (`request_id`,`execution_generation`,`domain`),
  UNIQUE KEY `uk_tenant_purge_exec_domains_ordinal` (`request_id`,`execution_generation`,`execution_ordinal`),
  UNIQUE KEY `uk_tenant_purge_exec_domains_identity` (`request_id`,`tenant_id`,`subject_generation`,`plan_build_generation`,`execution_generation`,`domain`),
  KEY `idx_tenant_purge_exec_domains_owner` (`tenant_id`,`subject_generation`,`request_id`,`execution_generation`,`domain`),
  KEY `fk_tenant_purge_exec_domain_plan_entry` (`request_id`,`plan_build_generation`,`domain`),
  CONSTRAINT `fk_tenant_purge_exec_domain_job` FOREIGN KEY (`request_id`, `tenant_id`, `subject_generation`, `plan_build_generation`, `execution_generation`) REFERENCES `tenant_purge_execution_jobs` (`request_id`, `tenant_id`, `subject_generation`, `plan_build_generation`, `execution_generation`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_tenant_purge_exec_domain_plan_entry` FOREIGN KEY (`request_id`, `plan_build_generation`, `domain`) REFERENCES `tenant_purge_plan_entries` (`request_id`, `build_generation`, `domain`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `chk_tenant_purge_exec_domain_disposition` CHECK ((`plan_disposition` in (_utf8mb4'delete',_utf8mb4'anonymize',_utf8mb4'retain_anonymized',_utf8mb4'revoke',_utf8mb4'clear',_utf8mb4'retain_evidence',_utf8mb4'not_applicable',_utf8mb4'blocked_legacy_external_source_unavailable',_utf8mb4'blocked_adapter_unconfigured',_utf8mb4'blocked_restore_replay_unproven'))),
  CONSTRAINT `chk_tenant_purge_exec_domain_generation` CHECK (((`subject_generation` > 0) and (`plan_build_generation` > 0) and (`execution_generation` > 0))),
  CONSTRAINT `chk_tenant_purge_exec_domain_name` CHECK ((`domain` in (_utf8mb4'tenant_registry',_utf8mb4'tenant_profile',_utf8mb4'agent_definitions',_utf8mb4'session_content',_utf8mb4'idempotency_receipts',_utf8mb4'operational_usage',_utf8mb4'billing_facts',_utf8mb4'billing_reconciliation',_utf8mb4'blob_manifest',_utf8mb4'blob_bytes',_utf8mb4'blob_outbox',_utf8mb4'lifecycle_outbox',_utf8mb4'user_export_control',_utf8mb4'user_export_snapshots',_utf8mb4'user_export_artifacts',_utf8mb4'user_export_bytes',_utf8mb4'user_erasure_evidence',_utf8mb4'user_purge_policy_evidence',_utf8mb4'governance_policy',_utf8mb4'legal_holds',_utf8mb4'tenant_t1_evidence',_utf8mb4'tenant_t3a_evidence',_utf8mb4'tenant_t3b_evidence',_utf8mb4'tenant_t3c_evidence',_utf8mb4'redis_leases',_utf8mb4'redis_fences',_utf8mb4'redis_streams',_utf8mb4'external_provider',_utf8mb4'kms',_utf8mb4'backup_ledger',_utf8mb4'restore_ledger',_utf8mb4'logs',_utf8mb4'traces'))),
  CONSTRAINT `chk_tenant_purge_exec_domain_ordinal` CHECK ((`execution_ordinal` <= 32)),
  CONSTRAINT `chk_tenant_purge_exec_domain_phase` CHECK (((`phase` in (_utf8mb4'pending',_utf8mb4'awaiting_blocker_resolution',_utf8mb4'awaiting_physical_ack',_utf8mb4'acked')) and (((`ack_count` = 0) and (`ack_root_sha256` = _utf8mb4'f9d8216d6d9b0e841128b6c2ef5c723b8c4323a05f76b22d7190165e3adde214')) or (`ack_count` > 0)) and (((`phase` = _utf8mb4'acked') and (`final_ack_sha256` is not null) and (`ack_count` > 0)) or ((`phase` <> _utf8mb4'acked') and (`final_ack_sha256` is null))) and (`updated_at_ms` >= 0)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE `tenant_purge_execution_domain_acks` (
  `scope` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `request_id` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `tenant_id` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `subject_generation` bigint unsigned NOT NULL,
  `plan_build_generation` bigint unsigned NOT NULL,
  `execution_generation` bigint unsigned NOT NULL,
  `domain` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `global_ack_seq` bigint unsigned NOT NULL,
  `domain_ack_seq` bigint unsigned NOT NULL,
  `previous_domain_ack_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `previous_global_ack_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `ack_kind` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `plan_entry_receipt_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `affected_count` bigint unsigned NOT NULL,
  `result_count` bigint unsigned NOT NULL,
  `result_root_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `adapter_protocol` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `operation_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `physical_proof_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `completed_claim_attempt` int unsigned NOT NULL,
  `completed_claim_token_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `store_db_timestamp_ms` bigint NOT NULL,
  `final` tinyint(1) NOT NULL,
  `outbox_kind` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `outbox_id` bigint unsigned DEFAULT NULL,
  `deletion_generation` bigint unsigned DEFAULT NULL,
  `target_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `scheduled_ack_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `receipt_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (`request_id`,`execution_generation`,`global_ack_seq`),
  UNIQUE KEY `uk_tenant_purge_exec_acks_domain_seq` (`request_id`,`execution_generation`,`domain`,`domain_ack_seq`),
  UNIQUE KEY `uk_tenant_purge_exec_acks_receipt` (`request_id`,`execution_generation`,`receipt_sha256`),
  UNIQUE KEY `uk_tenant_purge_exec_acks_operation` (`request_id`,`execution_generation`,`operation_sha256`,`ack_kind`),
  UNIQUE KEY `uk_tenant_purge_exec_acks_outbox` (`outbox_kind`,`outbox_id`,`deletion_generation`,`ack_kind`),
  KEY `idx_tenant_purge_exec_acks_domain_fk` (`request_id`,`tenant_id`,`subject_generation`,`plan_build_generation`,`execution_generation`,`domain`),
  KEY `idx_tenant_purge_exec_acks_scheduled_fk` (`request_id`,`execution_generation`,`scheduled_ack_sha256`),
  KEY `idx_tenant_purge_exec_acks_owner` (`tenant_id`,`subject_generation`,`request_id`,`execution_generation`,`domain`),
  CONSTRAINT `fk_tenant_purge_exec_ack_domain` FOREIGN KEY (`request_id`, `tenant_id`, `subject_generation`, `plan_build_generation`, `execution_generation`, `domain`) REFERENCES `tenant_purge_execution_domains` (`request_id`, `tenant_id`, `subject_generation`, `plan_build_generation`, `execution_generation`, `domain`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_tenant_purge_exec_ack_scheduled` FOREIGN KEY (`request_id`, `execution_generation`, `scheduled_ack_sha256`) REFERENCES `tenant_purge_execution_domain_acks` (`request_id`, `execution_generation`, `receipt_sha256`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `chk_tenant_purge_exec_ack_generation` CHECK (((`subject_generation` > 0) and (`plan_build_generation` > 0) and (`execution_generation` > 0) and (`global_ack_seq` > 0) and (`domain_ack_seq` > 0) and (`completed_claim_attempt` > 0) and (`store_db_timestamp_ms` >= 0))),
  CONSTRAINT `chk_tenant_purge_exec_ack_kind` CHECK ((`ack_kind` in (_utf8mb4'blocker_resolution',_utf8mb4'applied',_utf8mb4'anonymized',_utf8mb4'outbox_scheduled',_utf8mb4'physical_delete'))),
  CONSTRAINT `chk_tenant_purge_exec_ack_outbox` CHECK ((((`ack_kind` in (_utf8mb4'blocker_resolution',_utf8mb4'applied',_utf8mb4'anonymized')) and (`outbox_kind` is null) and (`outbox_id` is null) and (`deletion_generation` is null) and (`target_sha256` is null) and (`scheduled_ack_sha256` is null)) or ((`ack_kind` = _utf8mb4'outbox_scheduled') and (`outbox_kind` in (_utf8mb4'blob_delete',_utf8mb4'user_export_delete')) and (`outbox_id` is not null) and (`outbox_id` > 0) and (`deletion_generation` is not null) and (`deletion_generation` > 0) and (`target_sha256` is not null) and (`scheduled_ack_sha256` is null) and (`final` = false)) or ((`ack_kind` = _utf8mb4'physical_delete') and (`outbox_kind` in (_utf8mb4'blob_delete',_utf8mb4'user_export_delete')) and (`outbox_id` is not null) and (`outbox_id` > 0) and (`deletion_generation` is not null) and (`deletion_generation` > 0) and (`target_sha256` is not null) and (`scheduled_ack_sha256` is not null)))),
  CONSTRAINT `chk_tenant_purge_exec_ack_protocol` CHECK (regexp_like(`adapter_protocol`,_utf8mb4'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')),
  CONSTRAINT `chk_tenant_purge_exec_ack_scope` CHECK ((`scope` = _utf8mb4'tenant-purge-execution-domain-ack-v1'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE `tenant_purge_local_cutover_receipts` (
  `scope` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `request_id` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `tenant_id` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `subject_generation` bigint unsigned NOT NULL,
  `plan_build_generation` bigint unsigned NOT NULL,
  `execution_generation` bigint unsigned NOT NULL,
  `t3c_receipt_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `plan_receipt_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `plan_entry_root_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `plan_blocker_count` bigint unsigned NOT NULL,
  `plan_blocker_root_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `policy_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `purge_not_before_db_ms` bigint NOT NULL,
  `source_evidence_db_ms` bigint NOT NULL,
  `operational_usage_target_count` bigint unsigned NOT NULL,
  `operational_usage_target_root_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `blob_bytes_target_count` bigint unsigned NOT NULL,
  `blob_bytes_target_root_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `blob_delete_outbox_count` bigint unsigned NOT NULL,
  `blob_delete_outbox_root_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `export_bytes_target_count` bigint unsigned NOT NULL,
  `export_bytes_target_root_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `export_delete_outbox_count` bigint unsigned NOT NULL,
  `export_delete_outbox_root_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `domain_ack_count` bigint unsigned NOT NULL,
  `domain_ack_root_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `store_db_timestamp_ms` bigint NOT NULL,
  `completed_claim_attempt` int unsigned NOT NULL,
  `completed_claim_token_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `local_destructive_progress` tinyint(1) NOT NULL,
  `physical_acks_complete` tinyint(1) NOT NULL,
  `all_domains_complete` tinyint(1) NOT NULL,
  `content_purge_executed` tinyint(1) NOT NULL,
  `receipt_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (`request_id`),
  UNIQUE KEY `uk_tenant_purge_local_cutover_tenant` (`tenant_id`),
  UNIQUE KEY `uk_tenant_purge_local_cutover_generation` (`tenant_id`,`subject_generation`,`execution_generation`),
  UNIQUE KEY `uk_tenant_purge_local_cutover_hash` (`receipt_sha256`),
  UNIQUE KEY `uk_tenant_purge_local_cutover_request_hash` (`request_id`,`receipt_sha256`),
  KEY `idx_tenant_purge_local_cutover_job_fk` (`request_id`,`tenant_id`,`subject_generation`,`plan_build_generation`,`execution_generation`),
  CONSTRAINT `fk_tenant_purge_local_cutover_job` FOREIGN KEY (`request_id`, `tenant_id`, `subject_generation`, `plan_build_generation`, `execution_generation`) REFERENCES `tenant_purge_execution_jobs` (`request_id`, `tenant_id`, `subject_generation`, `plan_build_generation`, `execution_generation`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `chk_tenant_purge_local_cutover_clock` CHECK (((`purge_not_before_db_ms` >= 0) and (`source_evidence_db_ms` >= `purge_not_before_db_ms`) and (`store_db_timestamp_ms` >= `source_evidence_db_ms`) and (`completed_claim_attempt` > 0))),
  CONSTRAINT `chk_tenant_purge_local_cutover_flags` CHECK (((`local_destructive_progress` = true) and (`physical_acks_complete` = false) and (`all_domains_complete` = false) and (`content_purge_executed` = false))),
  CONSTRAINT `chk_tenant_purge_local_cutover_generation` CHECK (((`subject_generation` > 0) and (`plan_build_generation` > 0) and (`execution_generation` > 0))),
  CONSTRAINT `chk_tenant_purge_local_cutover_outbox` CHECK (((`blob_delete_outbox_count` = `blob_bytes_target_count`) and (`export_delete_outbox_count` = `export_bytes_target_count`))),
  CONSTRAINT `chk_tenant_purge_local_cutover_scope` CHECK ((`scope` = _utf8mb4'tenant-purge-local-cutover-v1'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE `tenant_purge_local_physical_ack_receipts` (
  `scope` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `request_id` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `tenant_id` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `subject_generation` bigint unsigned NOT NULL,
  `plan_build_generation` bigint unsigned NOT NULL,
  `execution_generation` bigint unsigned NOT NULL,
  `t3c_receipt_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `plan_receipt_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `plan_entry_root_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `plan_blocker_count` bigint unsigned NOT NULL,
  `plan_blocker_root_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `policy_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `purge_not_before_db_ms` bigint NOT NULL,
  `source_evidence_db_ms` bigint NOT NULL,
  `local_cutover_receipt_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `blob_physical_ack_count` bigint unsigned NOT NULL,
  `blob_physical_ack_root_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `export_physical_ack_count` bigint unsigned NOT NULL,
  `export_physical_ack_root_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `domain_ack_count` bigint unsigned NOT NULL,
  `domain_ack_root_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `unresolved_blocker_count` bigint unsigned NOT NULL,
  `store_db_timestamp_ms` bigint NOT NULL,
  `completed_claim_attempt` int unsigned NOT NULL,
  `completed_claim_token_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  `local_physical_acks_complete` tinyint(1) NOT NULL,
  `all_domains_complete` tinyint(1) NOT NULL,
  `content_purge_executed` tinyint(1) NOT NULL,
  `receipt_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (`request_id`),
  UNIQUE KEY `uk_tenant_purge_local_physical_tenant` (`tenant_id`),
  UNIQUE KEY `uk_tenant_purge_local_physical_generation` (`tenant_id`,`subject_generation`,`execution_generation`),
  UNIQUE KEY `uk_tenant_purge_local_physical_hash` (`receipt_sha256`),
  KEY `idx_tenant_purge_local_physical_job_fk` (`request_id`,`tenant_id`,`subject_generation`,`plan_build_generation`,`execution_generation`),
  KEY `idx_tenant_purge_local_physical_cutover_fk` (`request_id`,`local_cutover_receipt_sha256`),
  CONSTRAINT `fk_tenant_purge_local_physical_cutover` FOREIGN KEY (`request_id`, `local_cutover_receipt_sha256`) REFERENCES `tenant_purge_local_cutover_receipts` (`request_id`, `receipt_sha256`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_tenant_purge_local_physical_job` FOREIGN KEY (`request_id`, `tenant_id`, `subject_generation`, `plan_build_generation`, `execution_generation`) REFERENCES `tenant_purge_execution_jobs` (`request_id`, `tenant_id`, `subject_generation`, `plan_build_generation`, `execution_generation`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `chk_tenant_purge_local_physical_blocker` CHECK ((`unresolved_blocker_count` <= `plan_blocker_count`)),
  CONSTRAINT `chk_tenant_purge_local_physical_clock` CHECK (((`purge_not_before_db_ms` >= 0) and (`source_evidence_db_ms` >= `purge_not_before_db_ms`) and (`store_db_timestamp_ms` >= `source_evidence_db_ms`) and (`completed_claim_attempt` > 0))),
  CONSTRAINT `chk_tenant_purge_local_physical_flags` CHECK (((`local_physical_acks_complete` = true) and (`all_domains_complete` = false) and (`content_purge_executed` = false))),
  CONSTRAINT `chk_tenant_purge_local_physical_generation` CHECK (((`subject_generation` > 0) and (`plan_build_generation` > 0) and (`execution_generation` > 0))),
  CONSTRAINT `chk_tenant_purge_local_physical_scope` CHECK ((`scope` = _utf8mb4'tenant-purge-local-physical-ack-v1'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE `tenant_purge_execution_cutover` (
  `singleton_id` tinyint unsigned NOT NULL,
  `control_generation` bigint unsigned NOT NULL,
  `activated_at_ms` bigint DEFAULT NULL,
  `first_request_id` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `first_receipt_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  `evidence_sha256` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs DEFAULT NULL,
  PRIMARY KEY (`singleton_id`),
  KEY `idx_tenant_purge_exec_cutover_receipt_fk` (`first_request_id`,`first_receipt_sha256`),
  CONSTRAINT `fk_tenant_purge_execution_cutover_receipt` FOREIGN KEY (`first_request_id`, `first_receipt_sha256`) REFERENCES `tenant_purge_local_cutover_receipts` (`request_id`, `receipt_sha256`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `chk_tenant_purge_execution_cutover_singleton` CHECK ((`singleton_id` = 1)),
  CONSTRAINT `chk_tenant_purge_execution_cutover_state` CHECK ((((`control_generation` = 0) and (`activated_at_ms` is null) and (`first_request_id` is null) and (`first_receipt_sha256` is null) and (`evidence_sha256` is null)) or ((`control_generation` = 1) and (`activated_at_ms` is not null) and (`activated_at_ms` >= 0) and (`first_request_id` is not null) and (`first_receipt_sha256` is not null) and (`evidence_sha256` is not null))))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

INSERT INTO tenant_purge_execution_cutover
  (singleton_id, control_generation, activated_at_ms, first_request_id,
   first_receipt_sha256, evidence_sha256)
VALUES (1, 0, NULL, NULL, NULL, NULL);

CREATE TRIGGER trg_tenant_purge_exec_cutover_bd BEFORE DELETE ON tenant_purge_execution_cutover FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution cutover cannot be deleted';
CREATE TRIGGER trg_tenant_purge_exec_cutover_bd_guard_a BEFORE DELETE ON tenant_purge_execution_cutover FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution cutover cannot be deleted';
CREATE TRIGGER trg_tenant_purge_exec_cutover_bd_guard_b BEFORE DELETE ON tenant_purge_execution_cutover FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution cutover cannot be deleted';
CREATE TRIGGER trg_tenant_purge_exec_cutover_bu BEFORE UPDATE ON tenant_purge_execution_cutover FOR EACH ROW BEGIN IF NOT (OLD.singleton_id=1 AND NEW.singleton_id=1 AND OLD.control_generation=0 AND OLD.activated_at_ms IS NULL AND OLD.first_request_id IS NULL AND OLD.first_receipt_sha256 IS NULL AND OLD.evidence_sha256 IS NULL AND NEW.control_generation=1 AND NEW.activated_at_ms IS NOT NULL AND NEW.first_request_id IS NOT NULL AND NEW.first_receipt_sha256 IS NOT NULL AND NEW.evidence_sha256 IS NOT NULL) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution cutover is write-once'; END IF; END;
CREATE TRIGGER trg_tenant_purge_exec_cutover_bu_guard_a BEFORE UPDATE ON tenant_purge_execution_cutover FOR EACH ROW BEGIN IF NOT (OLD.singleton_id=1 AND NEW.singleton_id=1 AND OLD.control_generation=0 AND OLD.activated_at_ms IS NULL AND OLD.first_request_id IS NULL AND OLD.first_receipt_sha256 IS NULL AND OLD.evidence_sha256 IS NULL AND NEW.control_generation=1 AND NEW.activated_at_ms IS NOT NULL AND NEW.first_request_id IS NOT NULL AND NEW.first_receipt_sha256 IS NOT NULL AND NEW.evidence_sha256 IS NOT NULL) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution cutover is write-once'; END IF; END;
CREATE TRIGGER trg_tenant_purge_exec_cutover_bu_guard_b BEFORE UPDATE ON tenant_purge_execution_cutover FOR EACH ROW BEGIN IF NOT (OLD.singleton_id=1 AND NEW.singleton_id=1 AND OLD.control_generation=0 AND OLD.activated_at_ms IS NULL AND OLD.first_request_id IS NULL AND OLD.first_receipt_sha256 IS NULL AND OLD.evidence_sha256 IS NULL AND NEW.control_generation=1 AND NEW.activated_at_ms IS NOT NULL AND NEW.first_request_id IS NOT NULL AND NEW.first_receipt_sha256 IS NOT NULL AND NEW.evidence_sha256 IS NOT NULL) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution cutover is write-once'; END IF; END;
CREATE TRIGGER trg_tenant_purge_exec_acks_bd BEFORE DELETE ON tenant_purge_execution_domain_acks FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution domain ACKs are append-only';
CREATE TRIGGER trg_tenant_purge_exec_acks_bd_guard_a BEFORE DELETE ON tenant_purge_execution_domain_acks FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution domain ACKs are append-only';
CREATE TRIGGER trg_tenant_purge_exec_acks_bd_guard_b BEFORE DELETE ON tenant_purge_execution_domain_acks FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution domain ACKs are append-only';
CREATE TRIGGER trg_tenant_purge_exec_acks_bu BEFORE UPDATE ON tenant_purge_execution_domain_acks FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution domain ACKs are append-only';
CREATE TRIGGER trg_tenant_purge_exec_acks_bu_guard_a BEFORE UPDATE ON tenant_purge_execution_domain_acks FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution domain ACKs are append-only';
CREATE TRIGGER trg_tenant_purge_exec_acks_bu_guard_b BEFORE UPDATE ON tenant_purge_execution_domain_acks FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution domain ACKs are append-only';
CREATE TRIGGER trg_tenant_purge_exec_domains_bd BEFORE DELETE ON tenant_purge_execution_domains FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution domains cannot be deleted';
CREATE TRIGGER trg_tenant_purge_exec_domains_bd_guard_a BEFORE DELETE ON tenant_purge_execution_domains FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution domains cannot be deleted';
CREATE TRIGGER trg_tenant_purge_exec_domains_bd_guard_b BEFORE DELETE ON tenant_purge_execution_domains FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution domains cannot be deleted';
CREATE TRIGGER trg_tenant_purge_exec_domains_bu BEFORE UPDATE ON tenant_purge_execution_domains FOR EACH ROW BEGIN IF NOT (OLD.request_id <=> NEW.request_id AND OLD.tenant_id <=> NEW.tenant_id AND OLD.subject_generation <=> NEW.subject_generation AND OLD.plan_build_generation <=> NEW.plan_build_generation AND OLD.execution_generation <=> NEW.execution_generation AND OLD.domain <=> NEW.domain AND OLD.execution_ordinal <=> NEW.execution_ordinal AND OLD.plan_disposition <=> NEW.plan_disposition AND OLD.plan_target_count <=> NEW.plan_target_count AND OLD.plan_target_root_sha256 <=> NEW.plan_target_root_sha256 AND OLD.plan_source_sha256 <=> NEW.plan_source_sha256 AND OLD.plan_entry_receipt_sha256 <=> NEW.plan_entry_receipt_sha256 AND OLD.phase<>'acked' AND NEW.updated_at_ms>=OLD.updated_at_ms AND NEW.ack_count>=OLD.ack_count AND ((NEW.ack_count=OLD.ack_count AND NEW.ack_root_sha256 <=> OLD.ack_root_sha256) OR (NEW.ack_count>OLD.ack_count AND NOT (NEW.ack_root_sha256 <=> OLD.ack_root_sha256))) AND ((OLD.phase='pending' AND NEW.phase IN ('pending','awaiting_physical_ack','acked')) OR (OLD.phase='awaiting_blocker_resolution' AND NEW.phase IN ('awaiting_blocker_resolution','pending','awaiting_physical_ack','acked')) OR (OLD.phase='awaiting_physical_ack' AND NEW.phase IN ('awaiting_physical_ack','acked')))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution domain update is not permitted'; END IF; END;
CREATE TRIGGER trg_tenant_purge_exec_domains_bu_guard_a BEFORE UPDATE ON tenant_purge_execution_domains FOR EACH ROW BEGIN IF NOT (OLD.request_id <=> NEW.request_id AND OLD.tenant_id <=> NEW.tenant_id AND OLD.subject_generation <=> NEW.subject_generation AND OLD.plan_build_generation <=> NEW.plan_build_generation AND OLD.execution_generation <=> NEW.execution_generation AND OLD.domain <=> NEW.domain AND OLD.execution_ordinal <=> NEW.execution_ordinal AND OLD.plan_disposition <=> NEW.plan_disposition AND OLD.plan_target_count <=> NEW.plan_target_count AND OLD.plan_target_root_sha256 <=> NEW.plan_target_root_sha256 AND OLD.plan_source_sha256 <=> NEW.plan_source_sha256 AND OLD.plan_entry_receipt_sha256 <=> NEW.plan_entry_receipt_sha256 AND OLD.phase<>'acked' AND NEW.updated_at_ms>=OLD.updated_at_ms AND NEW.ack_count>=OLD.ack_count AND ((NEW.ack_count=OLD.ack_count AND NEW.ack_root_sha256 <=> OLD.ack_root_sha256) OR (NEW.ack_count>OLD.ack_count AND NOT (NEW.ack_root_sha256 <=> OLD.ack_root_sha256))) AND ((OLD.phase='pending' AND NEW.phase IN ('pending','awaiting_physical_ack','acked')) OR (OLD.phase='awaiting_blocker_resolution' AND NEW.phase IN ('awaiting_blocker_resolution','pending','awaiting_physical_ack','acked')) OR (OLD.phase='awaiting_physical_ack' AND NEW.phase IN ('awaiting_physical_ack','acked')))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution domain update is not permitted'; END IF; END;
CREATE TRIGGER trg_tenant_purge_exec_domains_bu_guard_b BEFORE UPDATE ON tenant_purge_execution_domains FOR EACH ROW BEGIN IF NOT (OLD.request_id <=> NEW.request_id AND OLD.tenant_id <=> NEW.tenant_id AND OLD.subject_generation <=> NEW.subject_generation AND OLD.plan_build_generation <=> NEW.plan_build_generation AND OLD.execution_generation <=> NEW.execution_generation AND OLD.domain <=> NEW.domain AND OLD.execution_ordinal <=> NEW.execution_ordinal AND OLD.plan_disposition <=> NEW.plan_disposition AND OLD.plan_target_count <=> NEW.plan_target_count AND OLD.plan_target_root_sha256 <=> NEW.plan_target_root_sha256 AND OLD.plan_source_sha256 <=> NEW.plan_source_sha256 AND OLD.plan_entry_receipt_sha256 <=> NEW.plan_entry_receipt_sha256 AND OLD.phase<>'acked' AND NEW.updated_at_ms>=OLD.updated_at_ms AND NEW.ack_count>=OLD.ack_count AND ((NEW.ack_count=OLD.ack_count AND NEW.ack_root_sha256 <=> OLD.ack_root_sha256) OR (NEW.ack_count>OLD.ack_count AND NOT (NEW.ack_root_sha256 <=> OLD.ack_root_sha256))) AND ((OLD.phase='pending' AND NEW.phase IN ('pending','awaiting_physical_ack','acked')) OR (OLD.phase='awaiting_blocker_resolution' AND NEW.phase IN ('awaiting_blocker_resolution','pending','awaiting_physical_ack','acked')) OR (OLD.phase='awaiting_physical_ack' AND NEW.phase IN ('awaiting_physical_ack','acked')))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution domain update is not permitted'; END IF; END;
CREATE TRIGGER trg_tenant_purge_exec_jobs_bd BEFORE DELETE ON tenant_purge_execution_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution jobs cannot be deleted';
CREATE TRIGGER trg_tenant_purge_exec_jobs_bd_guard_a BEFORE DELETE ON tenant_purge_execution_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution jobs cannot be deleted';
CREATE TRIGGER trg_tenant_purge_exec_jobs_bd_guard_b BEFORE DELETE ON tenant_purge_execution_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution jobs cannot be deleted';
CREATE TRIGGER trg_tenant_purge_exec_jobs_bu BEFORE UPDATE ON tenant_purge_execution_jobs FOR EACH ROW BEGIN IF NOT (OLD.request_id <=> NEW.request_id AND OLD.tenant_id <=> NEW.tenant_id AND OLD.subject_generation <=> NEW.subject_generation AND OLD.plan_build_generation <=> NEW.plan_build_generation AND OLD.execution_generation <=> NEW.execution_generation AND OLD.t3c_receipt_sha256 <=> NEW.t3c_receipt_sha256 AND OLD.plan_receipt_sha256 <=> NEW.plan_receipt_sha256 AND OLD.plan_entry_root_sha256 <=> NEW.plan_entry_root_sha256 AND OLD.plan_blocker_count <=> NEW.plan_blocker_count AND OLD.plan_blocker_root_sha256 <=> NEW.plan_blocker_root_sha256 AND OLD.policy_sha256 <=> NEW.policy_sha256 AND OLD.purge_not_before_db_ms <=> NEW.purge_not_before_db_ms AND OLD.source_evidence_db_ms <=> NEW.source_evidence_db_ms AND OLD.domain_count <=> NEW.domain_count AND OLD.created_at_ms <=> NEW.created_at_ms AND OLD.phase='queued' AND NEW.updated_at_ms>=OLD.updated_at_ms AND NEW.attempts>=OLD.attempts AND NEW.attempts<=OLD.attempts+1 AND NEW.domain_ack_count>=OLD.domain_ack_count AND ((NEW.domain_ack_count=OLD.domain_ack_count AND NEW.domain_ack_root_sha256 <=> OLD.domain_ack_root_sha256) OR (NEW.domain_ack_count>OLD.domain_ack_count AND NOT (NEW.domain_ack_root_sha256 <=> OLD.domain_ack_root_sha256))) AND NEW.unresolved_blocker_count<=OLD.unresolved_blocker_count AND (OLD.local_cutover_receipt_sha256 IS NULL OR NEW.local_cutover_receipt_sha256 <=> OLD.local_cutover_receipt_sha256) AND ((NEW.phase='queued' AND ((OLD.claim_token IS NULL AND NEW.claim_token IS NOT NULL AND NEW.attempts=OLD.attempts+1 AND NEW.available_at_ms <=> OLD.available_at_ms AND NEW.domain_ack_count=OLD.domain_ack_count AND NEW.unresolved_blocker_count=OLD.unresolved_blocker_count AND NEW.local_cutover_receipt_sha256 <=> OLD.local_cutover_receipt_sha256) OR (OLD.claim_token IS NOT NULL AND NEW.claim_token <=> OLD.claim_token AND NEW.attempts=OLD.attempts AND NEW.available_at_ms <=> OLD.available_at_ms AND NEW.lease_until_ms>=OLD.lease_until_ms) OR (OLD.claim_token IS NOT NULL AND NEW.claim_token IS NULL AND NEW.attempts=OLD.attempts AND NEW.available_at_ms>=OLD.available_at_ms AND NEW.available_at_ms>=NEW.updated_at_ms))) OR (NEW.phase IN ('local_physical_acks_sealed','blocked') AND OLD.claim_token IS NOT NULL AND NEW.attempts=OLD.attempts))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution job update is not permitted'; END IF; END;
CREATE TRIGGER trg_tenant_purge_exec_jobs_bu_guard_a BEFORE UPDATE ON tenant_purge_execution_jobs FOR EACH ROW BEGIN IF NOT (OLD.request_id <=> NEW.request_id AND OLD.tenant_id <=> NEW.tenant_id AND OLD.subject_generation <=> NEW.subject_generation AND OLD.plan_build_generation <=> NEW.plan_build_generation AND OLD.execution_generation <=> NEW.execution_generation AND OLD.t3c_receipt_sha256 <=> NEW.t3c_receipt_sha256 AND OLD.plan_receipt_sha256 <=> NEW.plan_receipt_sha256 AND OLD.plan_entry_root_sha256 <=> NEW.plan_entry_root_sha256 AND OLD.plan_blocker_count <=> NEW.plan_blocker_count AND OLD.plan_blocker_root_sha256 <=> NEW.plan_blocker_root_sha256 AND OLD.policy_sha256 <=> NEW.policy_sha256 AND OLD.purge_not_before_db_ms <=> NEW.purge_not_before_db_ms AND OLD.source_evidence_db_ms <=> NEW.source_evidence_db_ms AND OLD.domain_count <=> NEW.domain_count AND OLD.created_at_ms <=> NEW.created_at_ms AND OLD.phase='queued' AND NEW.updated_at_ms>=OLD.updated_at_ms AND NEW.attempts>=OLD.attempts AND NEW.attempts<=OLD.attempts+1 AND NEW.domain_ack_count>=OLD.domain_ack_count AND ((NEW.domain_ack_count=OLD.domain_ack_count AND NEW.domain_ack_root_sha256 <=> OLD.domain_ack_root_sha256) OR (NEW.domain_ack_count>OLD.domain_ack_count AND NOT (NEW.domain_ack_root_sha256 <=> OLD.domain_ack_root_sha256))) AND NEW.unresolved_blocker_count<=OLD.unresolved_blocker_count AND (OLD.local_cutover_receipt_sha256 IS NULL OR NEW.local_cutover_receipt_sha256 <=> OLD.local_cutover_receipt_sha256) AND ((NEW.phase='queued' AND ((OLD.claim_token IS NULL AND NEW.claim_token IS NOT NULL AND NEW.attempts=OLD.attempts+1 AND NEW.available_at_ms <=> OLD.available_at_ms AND NEW.domain_ack_count=OLD.domain_ack_count AND NEW.unresolved_blocker_count=OLD.unresolved_blocker_count AND NEW.local_cutover_receipt_sha256 <=> OLD.local_cutover_receipt_sha256) OR (OLD.claim_token IS NOT NULL AND NEW.claim_token <=> OLD.claim_token AND NEW.attempts=OLD.attempts AND NEW.available_at_ms <=> OLD.available_at_ms AND NEW.lease_until_ms>=OLD.lease_until_ms) OR (OLD.claim_token IS NOT NULL AND NEW.claim_token IS NULL AND NEW.attempts=OLD.attempts AND NEW.available_at_ms>=OLD.available_at_ms AND NEW.available_at_ms>=NEW.updated_at_ms))) OR (NEW.phase IN ('local_physical_acks_sealed','blocked') AND OLD.claim_token IS NOT NULL AND NEW.attempts=OLD.attempts))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution job update is not permitted'; END IF; END;
CREATE TRIGGER trg_tenant_purge_exec_jobs_bu_guard_b BEFORE UPDATE ON tenant_purge_execution_jobs FOR EACH ROW BEGIN IF NOT (OLD.request_id <=> NEW.request_id AND OLD.tenant_id <=> NEW.tenant_id AND OLD.subject_generation <=> NEW.subject_generation AND OLD.plan_build_generation <=> NEW.plan_build_generation AND OLD.execution_generation <=> NEW.execution_generation AND OLD.t3c_receipt_sha256 <=> NEW.t3c_receipt_sha256 AND OLD.plan_receipt_sha256 <=> NEW.plan_receipt_sha256 AND OLD.plan_entry_root_sha256 <=> NEW.plan_entry_root_sha256 AND OLD.plan_blocker_count <=> NEW.plan_blocker_count AND OLD.plan_blocker_root_sha256 <=> NEW.plan_blocker_root_sha256 AND OLD.policy_sha256 <=> NEW.policy_sha256 AND OLD.purge_not_before_db_ms <=> NEW.purge_not_before_db_ms AND OLD.source_evidence_db_ms <=> NEW.source_evidence_db_ms AND OLD.domain_count <=> NEW.domain_count AND OLD.created_at_ms <=> NEW.created_at_ms AND OLD.phase='queued' AND NEW.updated_at_ms>=OLD.updated_at_ms AND NEW.attempts>=OLD.attempts AND NEW.attempts<=OLD.attempts+1 AND NEW.domain_ack_count>=OLD.domain_ack_count AND ((NEW.domain_ack_count=OLD.domain_ack_count AND NEW.domain_ack_root_sha256 <=> OLD.domain_ack_root_sha256) OR (NEW.domain_ack_count>OLD.domain_ack_count AND NOT (NEW.domain_ack_root_sha256 <=> OLD.domain_ack_root_sha256))) AND NEW.unresolved_blocker_count<=OLD.unresolved_blocker_count AND (OLD.local_cutover_receipt_sha256 IS NULL OR NEW.local_cutover_receipt_sha256 <=> OLD.local_cutover_receipt_sha256) AND ((NEW.phase='queued' AND ((OLD.claim_token IS NULL AND NEW.claim_token IS NOT NULL AND NEW.attempts=OLD.attempts+1 AND NEW.available_at_ms <=> OLD.available_at_ms AND NEW.domain_ack_count=OLD.domain_ack_count AND NEW.unresolved_blocker_count=OLD.unresolved_blocker_count AND NEW.local_cutover_receipt_sha256 <=> OLD.local_cutover_receipt_sha256) OR (OLD.claim_token IS NOT NULL AND NEW.claim_token <=> OLD.claim_token AND NEW.attempts=OLD.attempts AND NEW.available_at_ms <=> OLD.available_at_ms AND NEW.lease_until_ms>=OLD.lease_until_ms) OR (OLD.claim_token IS NOT NULL AND NEW.claim_token IS NULL AND NEW.attempts=OLD.attempts AND NEW.available_at_ms>=OLD.available_at_ms AND NEW.available_at_ms>=NEW.updated_at_ms))) OR (NEW.phase IN ('local_physical_acks_sealed','blocked') AND OLD.claim_token IS NOT NULL AND NEW.attempts=OLD.attempts))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge execution job update is not permitted'; END IF; END;
CREATE TRIGGER trg_tenant_purge_local_cutover_bd BEFORE DELETE ON tenant_purge_local_cutover_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge local cutover receipts are append-only';
CREATE TRIGGER trg_tenant_purge_local_cutover_bd_guard_a BEFORE DELETE ON tenant_purge_local_cutover_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge local cutover receipts are append-only';
CREATE TRIGGER trg_tenant_purge_local_cutover_bd_guard_b BEFORE DELETE ON tenant_purge_local_cutover_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge local cutover receipts are append-only';
CREATE TRIGGER trg_tenant_purge_local_cutover_bu BEFORE UPDATE ON tenant_purge_local_cutover_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge local cutover receipts are append-only';
CREATE TRIGGER trg_tenant_purge_local_cutover_bu_guard_a BEFORE UPDATE ON tenant_purge_local_cutover_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge local cutover receipts are append-only';
CREATE TRIGGER trg_tenant_purge_local_cutover_bu_guard_b BEFORE UPDATE ON tenant_purge_local_cutover_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge local cutover receipts are append-only';
CREATE TRIGGER trg_tenant_purge_local_physical_bd BEFORE DELETE ON tenant_purge_local_physical_ack_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge local physical ACK receipts are append-only';
CREATE TRIGGER trg_tenant_purge_local_physical_bd_guard_a BEFORE DELETE ON tenant_purge_local_physical_ack_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge local physical ACK receipts are append-only';
CREATE TRIGGER trg_tenant_purge_local_physical_bd_guard_b BEFORE DELETE ON tenant_purge_local_physical_ack_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge local physical ACK receipts are append-only';
CREATE TRIGGER trg_tenant_purge_local_physical_bu BEFORE UPDATE ON tenant_purge_local_physical_ack_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge local physical ACK receipts are append-only';
CREATE TRIGGER trg_tenant_purge_local_physical_bu_guard_a BEFORE UPDATE ON tenant_purge_local_physical_ack_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge local physical ACK receipts are append-only';
CREATE TRIGGER trg_tenant_purge_local_physical_bu_guard_b BEFORE UPDATE ON tenant_purge_local_physical_ack_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant purge local physical ACK receipts are append-only';

INSERT INTO schema_migrations (name, applied_at_ms) VALUES
  ('0023_tenant_purge_execution_ack.sql', 23);
