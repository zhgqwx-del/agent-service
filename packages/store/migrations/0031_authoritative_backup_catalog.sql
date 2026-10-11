-- Expand-only, default-dormant authoritative backup catalog and restore-source binding.
--
-- Applying this migration does not discover, create, select, retain, restore, or evict a backup.
-- It stores only content-free identities and digests; database/object-store credentials, endpoints,
-- provider locators, headers, and backup bytes remain outside MySQL. Activation is a one-way CAS
-- and refuses any prepared or replay-sealed 0030 restore run that lacks an exact 0031 binding.

CREATE TABLE IF NOT EXISTS backup_catalog_control (
  singleton_id                         TINYINT UNSIGNED NOT NULL,
  state                                VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  control_generation                   BIGINT UNSIGNED NOT NULL DEFAULT 0,
  protocol                             VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  adapter_protocol                     VARCHAR(128) COLLATE utf8mb4_0900_as_cs NULL,
  catalog_namespace_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  catalog_target_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  failure_domain_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  logical_database_namespace_sha256    CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  journal_control_evidence_sha256      CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  retention_policy_sha256              CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  minimum_retention_ms                 BIGINT UNSIGNED NULL,
  minimum_recoverable_backups          BIGINT UNSIGNED NULL,
  activated_at_db_ms                   BIGINT NULL,
  evidence_sha256                      CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  PRIMARY KEY (singleton_id),
  CONSTRAINT chk_backup_catalog_control_singleton CHECK (singleton_id=1),
  CONSTRAINT chk_backup_catalog_control_state CHECK (
    (state='inactive' AND control_generation=0 AND protocol IS NULL
      AND adapter_protocol IS NULL AND catalog_namespace_sha256 IS NULL
      AND catalog_target_sha256 IS NULL AND failure_domain_sha256 IS NULL
      AND logical_database_namespace_sha256 IS NULL
      AND journal_control_evidence_sha256 IS NULL AND retention_policy_sha256 IS NULL
      AND minimum_retention_ms IS NULL AND minimum_recoverable_backups IS NULL
      AND activated_at_db_ms IS NULL AND evidence_sha256 IS NULL)
    OR
    (state='active' AND control_generation=1
      AND protocol='tenant-backup-catalog-v1'
      AND CHAR_LENGTH(adapter_protocol)>0 AND CHAR_LENGTH(adapter_protocol)<=128
      AND catalog_namespace_sha256 REGEXP '^[0-9a-f]{64}$'
      AND catalog_target_sha256 REGEXP '^[0-9a-f]{64}$'
      AND failure_domain_sha256 REGEXP '^[0-9a-f]{64}$'
      AND logical_database_namespace_sha256 REGEXP '^[0-9a-f]{64}$'
      AND journal_control_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND retention_policy_sha256 REGEXP '^[0-9a-f]{64}$'
      AND minimum_retention_ms IS NOT NULL
      AND minimum_recoverable_backups>0
      AND activated_at_db_ms>=0 AND evidence_sha256 REGEXP '^[0-9a-f]{64}$')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT singleton_id,state,control_generation,protocol,adapter_protocol,
       catalog_namespace_sha256,catalog_target_sha256,failure_domain_sha256,
       logical_database_namespace_sha256,journal_control_evidence_sha256,
       retention_policy_sha256,minimum_retention_ms,minimum_recoverable_backups,
       activated_at_db_ms,evidence_sha256
  FROM backup_catalog_control FORCE INDEX (PRIMARY) WHERE 1=0;

INSERT INTO backup_catalog_control
  (singleton_id,state,control_generation,protocol,adapter_protocol,
   catalog_namespace_sha256,catalog_target_sha256,failure_domain_sha256,
   logical_database_namespace_sha256,journal_control_evidence_sha256,
   retention_policy_sha256,minimum_retention_ms,minimum_recoverable_backups,
   activated_at_db_ms,evidence_sha256)
SELECT 1,'inactive',0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL
 WHERE NOT EXISTS (SELECT 1 FROM backup_catalog_control WHERE singleton_id=1);

-- Complete, content-free mirror of the independently durable external catalog. This is the sole
-- local authority for catalog sequence and hash-chain position; the tables below are projections
-- that may be reconstructed after restoring an older physical database snapshot.
CREATE TABLE IF NOT EXISTS backup_catalog_external_events (
  catalog_sequence                   BIGINT UNSIGNED NOT NULL,
  singleton_id                       TINYINT UNSIGNED NOT NULL DEFAULT 1,
  scope                              VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  protocol                           VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  adapter_protocol                   VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  catalog_namespace_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  catalog_target_sha256              CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  failure_domain_sha256              CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  event_type                         VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  operation_sha256                   CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  receipt_sha256                     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  previous_catalog_event_root_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  catalog_event_root_sha256          CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  catalog_event_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  event_payload_json                 JSON NOT NULL,
  event_payload_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (catalog_sequence),
  UNIQUE KEY uk_backup_catalog_external_operation (operation_sha256),
  UNIQUE KEY uk_backup_catalog_external_receipt (receipt_sha256),
  UNIQUE KEY uk_backup_catalog_external_event (catalog_event_sha256),
  UNIQUE KEY uk_backup_catalog_external_root (catalog_event_root_sha256),
  CONSTRAINT fk_backup_catalog_external_control FOREIGN KEY (singleton_id)
    REFERENCES backup_catalog_control (singleton_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_backup_catalog_external_shape CHECK (
    singleton_id=1 AND catalog_sequence>0
      AND scope='tenant-backup-catalog-external-event-v1'
      AND protocol='tenant-backup-catalog-v1'
      AND CHAR_LENGTH(adapter_protocol)>0 AND CHAR_LENGTH(adapter_protocol)<=128
      AND catalog_namespace_sha256 REGEXP '^[0-9a-f]{64}$'
      AND catalog_target_sha256 REGEXP '^[0-9a-f]{64}$'
      AND failure_domain_sha256 REGEXP '^[0-9a-f]{64}$'
      AND event_type IN ('backup_recoverable','restore_reserved','restore_resolved','backup_evicted')
      AND operation_sha256 REGEXP '^[0-9a-f]{64}$'
      AND receipt_sha256 REGEXP '^[0-9a-f]{64}$'
      AND previous_catalog_event_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND catalog_event_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND catalog_event_sha256 REGEXP '^[0-9a-f]{64}$'
      AND JSON_TYPE(event_payload_json)='OBJECT'
      AND event_payload_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT catalog_sequence,singleton_id,scope,protocol,adapter_protocol,
       catalog_namespace_sha256,catalog_target_sha256,failure_domain_sha256,event_type,
       operation_sha256,receipt_sha256,previous_catalog_event_root_sha256,
       catalog_event_root_sha256,catalog_event_sha256,event_payload_json,event_payload_sha256
  FROM backup_catalog_external_events FORCE INDEX (
    PRIMARY,uk_backup_catalog_external_operation,uk_backup_catalog_external_receipt,
    uk_backup_catalog_external_event,uk_backup_catalog_external_root
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS backup_snapshot_anchors (
  backup_id                              VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  singleton_id                           TINYINT UNSIGNED NOT NULL DEFAULT 1,
  scope                                  VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  protocol                               VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  backup_kind                            VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  control_evidence_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  logical_database_namespace_sha256      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  journal_control_evidence_sha256        CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_runtime_epoch_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_runtime_control_generation      BIGINT UNSIGNED NOT NULL,
  source_runtime_control_evidence_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_runtime_target_count            BIGINT UNSIGNED NOT NULL,
  source_runtime_head_catalog_json       JSON NOT NULL,
  source_runtime_head_root_sha256        CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  schema_migration_root_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  blob_storage_control_evidence_sha256   CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_catalog_sequence                BIGINT UNSIGNED NOT NULL,
  source_catalog_event_root_sha256       CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  retention_until_db_ms                  BIGINT NOT NULL,
  created_at_db_ms                       BIGINT NOT NULL,
  anchor_sha256                          CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (backup_id),
  UNIQUE KEY uk_backup_snapshot_anchor_hash (anchor_sha256),
  UNIQUE KEY uk_backup_snapshot_anchor_exact
    (backup_id,anchor_sha256,retention_until_db_ms),
  KEY idx_backup_snapshot_anchor_retention
    (retention_until_db_ms,created_at_db_ms,backup_id),
  CONSTRAINT fk_backup_snapshot_anchor_control FOREIGN KEY (singleton_id)
    REFERENCES backup_catalog_control (singleton_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_backup_snapshot_anchor_shape CHECK (
    singleton_id=1 AND backup_id REGEXP '^backup_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND scope='tenant-backup-snapshot-anchor-v1'
      AND protocol='tenant-backup-catalog-v1' AND backup_kind='full'
      AND control_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND logical_database_namespace_sha256 REGEXP '^[0-9a-f]{64}$'
      AND journal_control_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND source_runtime_epoch_sha256 REGEXP '^[0-9a-f]{64}$'
      AND source_runtime_control_generation>0
      AND source_runtime_control_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND source_runtime_target_count BETWEEN 1 AND 32
      AND JSON_TYPE(source_runtime_head_catalog_json)='ARRAY'
      AND JSON_LENGTH(source_runtime_head_catalog_json)=source_runtime_target_count
      AND source_runtime_head_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND schema_migration_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND blob_storage_control_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND source_catalog_event_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND (source_catalog_sequence>0 OR source_catalog_event_root_sha256='bab7b17930d82572302c510c686e061ae9bd0de44ff19c83c483f45524b24e81')
      AND created_at_db_ms>=0 AND retention_until_db_ms>=created_at_db_ms
      AND anchor_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT backup_id,singleton_id,scope,protocol,backup_kind,control_evidence_sha256,
       logical_database_namespace_sha256,
       journal_control_evidence_sha256,source_runtime_epoch_sha256,
       source_runtime_control_generation,source_runtime_control_evidence_sha256,
       source_runtime_target_count,source_runtime_head_catalog_json,
       source_runtime_head_root_sha256,schema_migration_root_sha256,
       blob_storage_control_evidence_sha256,source_catalog_sequence,
       source_catalog_event_root_sha256,retention_until_db_ms,
       created_at_db_ms,anchor_sha256
  FROM backup_snapshot_anchors FORCE INDEX (
    PRIMARY,uk_backup_snapshot_anchor_hash,uk_backup_snapshot_anchor_exact,
    idx_backup_snapshot_anchor_retention
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS backup_catalog_entries (
  backup_id                         VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  scope                             VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  protocol                          VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  control_evidence_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  logical_database_namespace_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  retention_policy_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  adapter_protocol                  VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  anchor_sha256                     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_snapshot_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_backup_sha256              CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  artifact_manifest_sha256          CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  provider_evidence_sha256          CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  catalog_namespace_sha256          CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  catalog_target_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  failure_domain_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  availability_operation_sha256     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  availability_receipt_sha256       CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  catalog_sequence                  BIGINT UNSIGNED NOT NULL,
  previous_catalog_event_root_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  catalog_event_root_sha256         CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  catalog_event_sha256              CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  retention_until_db_ms             BIGINT NOT NULL,
  registered_at_db_ms               BIGINT NOT NULL,
  entry_sha256                      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (backup_id),
  UNIQUE KEY uk_backup_catalog_entry_hash (entry_sha256),
  UNIQUE KEY uk_backup_catalog_entry_exact (backup_id,entry_sha256),
  UNIQUE KEY uk_backup_catalog_entry_snapshot
    (catalog_namespace_sha256,source_snapshot_sha256),
  UNIQUE KEY uk_backup_catalog_entry_source_backup
    (catalog_namespace_sha256,source_backup_sha256),
  UNIQUE KEY uk_backup_catalog_entry_operation (availability_operation_sha256),
  UNIQUE KEY uk_backup_catalog_entry_receipt (availability_receipt_sha256),
  UNIQUE KEY uk_backup_catalog_entry_sequence (catalog_namespace_sha256,catalog_sequence),
  UNIQUE KEY uk_backup_catalog_entry_event (catalog_event_sha256),
  KEY idx_backup_catalog_entry_retention
    (retention_until_db_ms,registered_at_db_ms,backup_id),
  CONSTRAINT chk_backup_catalog_entry_shape CHECK (
    backup_id REGEXP '^backup_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND scope='tenant-backup-catalog-entry-v1'
      AND protocol='tenant-backup-catalog-v1'
      AND control_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND logical_database_namespace_sha256 REGEXP '^[0-9a-f]{64}$'
      AND retention_policy_sha256 REGEXP '^[0-9a-f]{64}$'
      AND CHAR_LENGTH(adapter_protocol)>0 AND CHAR_LENGTH(adapter_protocol)<=128
      AND anchor_sha256 REGEXP '^[0-9a-f]{64}$'
      AND source_snapshot_sha256 REGEXP '^[0-9a-f]{64}$'
      AND source_backup_sha256 REGEXP '^[0-9a-f]{64}$'
      AND artifact_manifest_sha256 REGEXP '^[0-9a-f]{64}$'
      AND provider_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND catalog_namespace_sha256 REGEXP '^[0-9a-f]{64}$'
      AND catalog_target_sha256 REGEXP '^[0-9a-f]{64}$'
      AND failure_domain_sha256 REGEXP '^[0-9a-f]{64}$'
      AND availability_operation_sha256 REGEXP '^[0-9a-f]{64}$'
      AND availability_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
      AND catalog_sequence>0
      AND previous_catalog_event_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND catalog_event_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND catalog_event_sha256 REGEXP '^[0-9a-f]{64}$'
      AND registered_at_db_ms>=0 AND retention_until_db_ms>=registered_at_db_ms
      AND entry_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT backup_id,scope,protocol,control_evidence_sha256,
       logical_database_namespace_sha256,retention_policy_sha256,adapter_protocol,
       anchor_sha256,source_snapshot_sha256,source_backup_sha256,
       artifact_manifest_sha256,provider_evidence_sha256,
       catalog_namespace_sha256,catalog_target_sha256,failure_domain_sha256,
       availability_operation_sha256,availability_receipt_sha256,
       catalog_sequence,previous_catalog_event_root_sha256,
       catalog_event_root_sha256,catalog_event_sha256,
       retention_until_db_ms,registered_at_db_ms,entry_sha256
  FROM backup_catalog_entries FORCE INDEX (
    PRIMARY,uk_backup_catalog_entry_hash,uk_backup_catalog_entry_exact,
    uk_backup_catalog_entry_snapshot,uk_backup_catalog_entry_source_backup,
    uk_backup_catalog_entry_operation,
    uk_backup_catalog_entry_receipt,uk_backup_catalog_entry_sequence,
    uk_backup_catalog_entry_event,idx_backup_catalog_entry_retention
  ) WHERE 1=0;

-- Deliberately no FK to tenant_restore_replay_runs: prepare must insert this binding first and then
-- create the 0030 replay run in the same transaction. A rejected replay insert must roll both back.
CREATE TABLE IF NOT EXISTS backup_restore_source_bindings (
  restore_run_id                   VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  backup_id                        VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  scope                            VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  protocol                         VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  anchor_sha256                    CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  entry_sha256                     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_snapshot_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_backup_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  artifact_manifest_sha256         CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  provider_evidence_sha256         CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  control_evidence_sha256          CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  journal_control_evidence_sha256  CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  sealed_target_root_sha256        CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  runtime_epoch_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  reservation_receipt_sha256       CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  selected_catalog_sequence        BIGINT UNSIGNED NOT NULL,
  selected_catalog_event_root_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  bound_at_db_ms                   BIGINT NOT NULL,
  binding_sha256                   CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (restore_run_id),
  UNIQUE KEY uk_backup_restore_binding_hash (binding_sha256),
  UNIQUE KEY uk_backup_restore_binding_exact (restore_run_id,binding_sha256),
  KEY idx_backup_restore_binding_backup (backup_id,bound_at_db_ms,restore_run_id),
  CONSTRAINT fk_backup_restore_binding_entry
    FOREIGN KEY (backup_id,entry_sha256)
    REFERENCES backup_catalog_entries (backup_id,entry_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_backup_restore_binding_shape CHECK (
    restore_run_id REGEXP '^restore_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND backup_id REGEXP '^backup_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND scope='tenant-backup-restore-binding-v1'
      AND protocol='tenant-backup-catalog-v1'
      AND anchor_sha256 REGEXP '^[0-9a-f]{64}$'
      AND entry_sha256 REGEXP '^[0-9a-f]{64}$'
      AND source_snapshot_sha256 REGEXP '^[0-9a-f]{64}$'
      AND source_backup_sha256 REGEXP '^[0-9a-f]{64}$'
      AND artifact_manifest_sha256 REGEXP '^[0-9a-f]{64}$'
      AND provider_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND control_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND journal_control_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND sealed_target_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND runtime_epoch_sha256 REGEXP '^[0-9a-f]{64}$'
      AND reservation_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
      AND selected_catalog_sequence>0
      AND selected_catalog_event_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND bound_at_db_ms>=0 AND binding_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT restore_run_id,backup_id,scope,protocol,anchor_sha256,entry_sha256,
       source_snapshot_sha256,source_backup_sha256,artifact_manifest_sha256,
       provider_evidence_sha256,control_evidence_sha256,
       journal_control_evidence_sha256,sealed_target_root_sha256,
       runtime_epoch_sha256,reservation_receipt_sha256,
       selected_catalog_sequence,selected_catalog_event_root_sha256,
       bound_at_db_ms,binding_sha256
  FROM backup_restore_source_bindings FORCE INDEX (
    PRIMARY,uk_backup_restore_binding_hash,uk_backup_restore_binding_exact,
    idx_backup_restore_binding_backup
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS backup_runtime_reservations (
  runtime_epoch_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  restore_run_id                   VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  backup_id                        VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  scope                            VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  protocol                         VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  entry_sha256                     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  binding_sha256                   CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  reservation_operation_sha256     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  reservation_receipt_sha256       CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  catalog_sequence                 BIGINT UNSIGNED NOT NULL,
  previous_catalog_event_root_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  catalog_event_root_sha256        CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  catalog_event_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  phase                            VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  reserved_at_db_ms                BIGINT NOT NULL,
  resolution_operation_sha256      CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  resolution_receipt_sha256        CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  resolution_catalog_sequence      BIGINT UNSIGNED NULL,
  resolution_previous_catalog_event_root_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  resolution_catalog_event_root_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  resolution_catalog_event_sha256  CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  resolved_at_db_ms                BIGINT NULL,
  reservation_sha256               CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (runtime_epoch_sha256),
  UNIQUE KEY uk_backup_runtime_reservation_run (restore_run_id),
  UNIQUE KEY uk_backup_runtime_reservation_operation (reservation_operation_sha256),
  UNIQUE KEY uk_backup_runtime_reservation_receipt (reservation_receipt_sha256),
  UNIQUE KEY uk_backup_runtime_reservation_sequence (catalog_sequence),
  UNIQUE KEY uk_backup_runtime_reservation_event (catalog_event_sha256),
  UNIQUE KEY uk_backup_runtime_resolution_operation (resolution_operation_sha256),
  UNIQUE KEY uk_backup_runtime_resolution_receipt (resolution_receipt_sha256),
  UNIQUE KEY uk_backup_runtime_resolution_sequence (resolution_catalog_sequence),
  UNIQUE KEY uk_backup_runtime_resolution_event (resolution_catalog_event_sha256),
  UNIQUE KEY uk_backup_runtime_reservation_hash (reservation_sha256),
  KEY idx_backup_runtime_reservation_backup (backup_id,phase,reserved_at_db_ms),
  CONSTRAINT fk_backup_runtime_reservation_binding
    FOREIGN KEY (restore_run_id,binding_sha256)
    REFERENCES backup_restore_source_bindings (restore_run_id,binding_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_backup_runtime_reservation_shape CHECK (
    runtime_epoch_sha256 REGEXP '^[0-9a-f]{64}$'
      AND restore_run_id REGEXP '^restore_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND backup_id REGEXP '^backup_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND scope='tenant-backup-runtime-reservation-v1'
      AND protocol='tenant-backup-catalog-v1'
      AND entry_sha256 REGEXP '^[0-9a-f]{64}$'
      AND binding_sha256 REGEXP '^[0-9a-f]{64}$'
      AND reservation_operation_sha256 REGEXP '^[0-9a-f]{64}$'
      AND reservation_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
      AND catalog_sequence>0
      AND previous_catalog_event_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND catalog_event_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND catalog_event_sha256 REGEXP '^[0-9a-f]{64}$'
      AND reserved_at_db_ms>=0 AND reservation_sha256 REGEXP '^[0-9a-f]{64}$'
      AND ((phase='reserved' AND resolution_operation_sha256 IS NULL
              AND resolution_receipt_sha256 IS NULL
              AND resolution_catalog_sequence IS NULL
              AND resolution_previous_catalog_event_root_sha256 IS NULL
              AND resolution_catalog_event_root_sha256 IS NULL
              AND resolution_catalog_event_sha256 IS NULL AND resolved_at_db_ms IS NULL)
        OR (phase IN ('activated','aborted')
              AND resolution_operation_sha256 REGEXP '^[0-9a-f]{64}$'
              AND resolution_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
              AND resolution_catalog_sequence>catalog_sequence
              AND resolution_previous_catalog_event_root_sha256 REGEXP '^[0-9a-f]{64}$'
              AND resolution_catalog_event_root_sha256 REGEXP '^[0-9a-f]{64}$'
              AND resolution_catalog_event_sha256 REGEXP '^[0-9a-f]{64}$'
              AND resolved_at_db_ms>=reserved_at_db_ms))
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT runtime_epoch_sha256,restore_run_id,backup_id,scope,protocol,entry_sha256,
       binding_sha256,reservation_operation_sha256,reservation_receipt_sha256,
       catalog_sequence,previous_catalog_event_root_sha256,
       catalog_event_root_sha256,catalog_event_sha256,phase,reserved_at_db_ms,
       resolution_operation_sha256,resolution_receipt_sha256,
       resolution_catalog_sequence,resolution_previous_catalog_event_root_sha256,
       resolution_catalog_event_root_sha256,resolution_catalog_event_sha256,
       resolved_at_db_ms,reservation_sha256
  FROM backup_runtime_reservations FORCE INDEX (
    PRIMARY,uk_backup_runtime_reservation_run,
    uk_backup_runtime_reservation_operation,uk_backup_runtime_reservation_receipt,
    uk_backup_runtime_reservation_sequence,uk_backup_runtime_reservation_event,
    uk_backup_runtime_resolution_operation,uk_backup_runtime_resolution_receipt,
    uk_backup_runtime_resolution_sequence,uk_backup_runtime_resolution_event,
    uk_backup_runtime_reservation_hash,idx_backup_runtime_reservation_backup
  ) WHERE 1=0;

-- One immutable terminal record freezes the locally derived plan, the exact external ACK, and the
-- permanent external tombstone. Selection-versus-eviction and last-restorable-backup exclusion are
-- serialized by the store under locks; a trigger-only unlocked existence test would be racy.
CREATE TABLE IF NOT EXISTS backup_catalog_evictions (
  backup_id                         VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  eviction_id                       VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  scope                             VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  protocol                          VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  entry_sha256                      CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  anchor_sha256                     CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_snapshot_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_backup_sha256              CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  artifact_manifest_sha256          CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  provider_evidence_sha256          CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  control_evidence_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  retention_policy_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  retention_until_db_ms             BIGINT NOT NULL,
  expected_catalog_sequence         BIGINT UNSIGNED NOT NULL,
  expected_catalog_event_root_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  eviction_operation_sha256         CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  plan_sha256                       CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  adapter_protocol                  VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  catalog_namespace_sha256          CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  catalog_target_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  acknowledgement_receipt_sha256    CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  external_tombstone_sha256         CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  observed_absent                   BOOLEAN NOT NULL,
  catalog_sequence                  BIGINT UNSIGNED NOT NULL,
  previous_catalog_event_root_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  catalog_event_root_sha256         CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  catalog_event_sha256              CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  evicted_at_db_ms                  BIGINT NOT NULL,
  eviction_sha256                   CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  PRIMARY KEY (backup_id),
  UNIQUE KEY uk_backup_catalog_eviction_id (eviction_id),
  UNIQUE KEY uk_backup_catalog_eviction_operation (eviction_operation_sha256),
  UNIQUE KEY uk_backup_catalog_eviction_plan (plan_sha256),
  UNIQUE KEY uk_backup_catalog_eviction_ack (acknowledgement_receipt_sha256),
  UNIQUE KEY uk_backup_catalog_eviction_tombstone (external_tombstone_sha256),
  UNIQUE KEY uk_backup_catalog_eviction_sequence (catalog_namespace_sha256,catalog_sequence),
  UNIQUE KEY uk_backup_catalog_eviction_event (catalog_event_sha256),
  UNIQUE KEY uk_backup_catalog_eviction_hash (eviction_sha256),
  KEY idx_backup_catalog_eviction_time (evicted_at_db_ms,backup_id),
  CONSTRAINT fk_backup_catalog_eviction_entry
    FOREIGN KEY (backup_id,entry_sha256)
    REFERENCES backup_catalog_entries (backup_id,entry_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_backup_catalog_eviction_shape CHECK (
    backup_id REGEXP '^backup_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND eviction_id REGEXP '^backup_evict_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND scope='tenant-backup-catalog-eviction-v1'
      AND protocol='tenant-backup-catalog-v1'
      AND entry_sha256 REGEXP '^[0-9a-f]{64}$'
      AND anchor_sha256 REGEXP '^[0-9a-f]{64}$'
      AND source_snapshot_sha256 REGEXP '^[0-9a-f]{64}$'
      AND source_backup_sha256 REGEXP '^[0-9a-f]{64}$'
      AND artifact_manifest_sha256 REGEXP '^[0-9a-f]{64}$'
      AND provider_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND control_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
      AND retention_policy_sha256 REGEXP '^[0-9a-f]{64}$'
      AND retention_until_db_ms>=0 AND expected_catalog_sequence>0
      AND expected_catalog_event_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND eviction_operation_sha256 REGEXP '^[0-9a-f]{64}$'
      AND plan_sha256 REGEXP '^[0-9a-f]{64}$'
      AND CHAR_LENGTH(adapter_protocol)>0 AND CHAR_LENGTH(adapter_protocol)<=128
      AND catalog_namespace_sha256 REGEXP '^[0-9a-f]{64}$'
      AND catalog_target_sha256 REGEXP '^[0-9a-f]{64}$'
      AND acknowledgement_receipt_sha256 REGEXP '^[0-9a-f]{64}$'
      AND external_tombstone_sha256 REGEXP '^[0-9a-f]{64}$'
      AND observed_absent=TRUE AND catalog_sequence>expected_catalog_sequence
      AND previous_catalog_event_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND catalog_event_root_sha256 REGEXP '^[0-9a-f]{64}$'
      AND catalog_event_sha256 REGEXP '^[0-9a-f]{64}$'
      AND evicted_at_db_ms>=0 AND eviction_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT backup_id,eviction_id,scope,protocol,entry_sha256,anchor_sha256,
       source_snapshot_sha256,source_backup_sha256,artifact_manifest_sha256,
       provider_evidence_sha256,control_evidence_sha256,retention_policy_sha256,
       retention_until_db_ms,expected_catalog_sequence,
       expected_catalog_event_root_sha256,eviction_operation_sha256,plan_sha256,
       adapter_protocol,catalog_namespace_sha256,catalog_target_sha256,
       acknowledgement_receipt_sha256,external_tombstone_sha256,observed_absent,
       catalog_sequence,previous_catalog_event_root_sha256,
       catalog_event_root_sha256,catalog_event_sha256,
       evicted_at_db_ms,eviction_sha256
  FROM backup_catalog_evictions FORCE INDEX (
    PRIMARY,uk_backup_catalog_eviction_id,uk_backup_catalog_eviction_operation,
    uk_backup_catalog_eviction_plan,uk_backup_catalog_eviction_ack,
    uk_backup_catalog_eviction_tombstone,uk_backup_catalog_eviction_sequence,
    uk_backup_catalog_eviction_event,uk_backup_catalog_eviction_hash,
    idx_backup_catalog_eviction_time
  ) WHERE 1=0;

-- Exact table fingerprints are filled from a clean MySQL 8 application of this migration. They
-- bind engine/collation, every column/default, complete index shape, enforced CHECK/FK inventory,
-- absence of extra constraints, and absence of partitioning. This is also the marker-loss guard.
SET @backup_catalog_previous_group_concat_max_len=@@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len=1048576;
-- agent-service-runtime-fingerprint:authoritative-backup-catalog-schema:start
SET @backup_catalog_schema_ok=(
  (SELECT COUNT(*)=7
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,table_type,
             IFNULL(engine,'-'),IFNULL(table_collation,'-'))
           ORDER BY table_name SEPARATOR '|'),256)=
         '012361662a41a91da89b352c9bc359c62250f30a6fbd4b3a5a01e59f17f551a0'
     FROM information_schema.tables
    WHERE table_schema=DATABASE() AND table_name IN (
      'backup_catalog_control','backup_catalog_external_events','backup_snapshot_anchors','backup_catalog_entries',
      'backup_restore_source_bindings','backup_runtime_reservations',
      'backup_catalog_evictions'))
  AND
  (SELECT COUNT(*)=147
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,LPAD(ordinal_position,3,'0'),
             column_name,LOWER(column_type),is_nullable,
             IF(column_default IS NULL,'<NULL>',CONCAT('<',column_default,'>')),
             IFNULL(character_set_name,'-'),IFNULL(collation_name,'-'),
             IFNULL(NULLIF(LOWER(extra),''),'-'),
             IFNULL(NULLIF(LOWER(generation_expression),''),'-'))
           ORDER BY table_name,ordinal_position SEPARATOR '|'),256)=
         'c85e31db238b6efb6e1d7bf6963ddb2acc87d1e5a586e2840a0dd0098f28a55e'
     FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name IN (
      'backup_catalog_control','backup_catalog_external_events','backup_snapshot_anchors','backup_catalog_entries',
      'backup_restore_source_bindings','backup_runtime_reservations',
      'backup_catalog_evictions'))
  AND
  (SELECT COUNT(DISTINCT CONCAT(table_name,'~',index_name))=51 AND COUNT(*)=71
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,index_name,non_unique,
             seq_in_index,LOWER(index_type),LOWER(is_visible),
             IFNULL(column_name,'<expression>'),IFNULL(CAST(sub_part AS CHAR),'-'),
             LOWER(IFNULL(collation,'-')),IFNULL(expression,'-'))
           ORDER BY table_name,index_name,seq_in_index SEPARATOR '|'),256)=
         'b02bb0503f02effa6259cac49eecb7ec05e1c78cbff9c46545d03811b10e8ba5'
     FROM information_schema.statistics
    WHERE table_schema=DATABASE() AND table_name IN (
      'backup_catalog_control','backup_catalog_external_events','backup_snapshot_anchors','backup_catalog_entries',
      'backup_restore_source_bindings','backup_runtime_reservations',
      'backup_catalog_evictions'))
  AND
  (SELECT COUNT(*)=8
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',tc.table_name,tc.constraint_name,tc.enforced,
             LOWER(REPLACE(REPLACE(REGEXP_REPLACE(cc.check_clause,'[[:space:]]',''),
               CHAR(96),''),'_utf8mb4','')))
           ORDER BY tc.table_name,tc.constraint_name SEPARATOR '|'),256)=
         '83b91df5414680d60a7ed7c54665a5917280782a065a10614492c037b2814f01'
     FROM information_schema.table_constraints tc
     JOIN information_schema.check_constraints cc
       ON cc.constraint_schema=tc.constraint_schema
      AND cc.constraint_name=tc.constraint_name
    WHERE tc.table_schema=DATABASE() AND tc.constraint_type='CHECK'
      AND tc.table_name IN (
        'backup_catalog_control','backup_catalog_external_events','backup_snapshot_anchors','backup_catalog_entries',
        'backup_restore_source_bindings','backup_runtime_reservations',
        'backup_catalog_evictions'))
  AND
  (SELECT COUNT(*)=54
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,constraint_type,enforced)
           ORDER BY table_name,constraint_name SEPARATOR '|'),256)=
         'b33963728bfec6964ba4300c3d5441a86b1272281b24de90ad7d16468c139908'
     FROM information_schema.table_constraints
    WHERE table_schema=DATABASE() AND table_name IN (
      'backup_catalog_control','backup_catalog_external_events','backup_snapshot_anchors','backup_catalog_entries',
      'backup_restore_source_bindings','backup_runtime_reservations',
      'backup_catalog_evictions'))
  AND
  (SELECT COUNT(DISTINCT CONCAT(k.table_name,'~',k.constraint_name))=5
       AND COUNT(*)=8
       AND SHA2(GROUP_CONCAT(CONCAT_WS('~',k.table_name,k.constraint_name,
             k.ordinal_position,k.column_name,k.referenced_table_name,
             k.referenced_column_name,r.update_rule,r.delete_rule)
           ORDER BY k.table_name,k.constraint_name,k.ordinal_position SEPARATOR '|'),256)=
         '58fcdb9e08cdb79834d169637fb3488fdedd68d237ea755096406a59174d900b'
     FROM information_schema.key_column_usage k
     JOIN information_schema.referential_constraints r
       ON r.constraint_schema=k.constraint_schema
      AND r.constraint_name=k.constraint_name
    WHERE k.table_schema=DATABASE() AND k.referenced_table_name IS NOT NULL
      AND k.table_name IN (
        'backup_catalog_control','backup_catalog_external_events','backup_snapshot_anchors','backup_catalog_entries',
        'backup_restore_source_bindings','backup_runtime_reservations',
        'backup_catalog_evictions'))
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.partitions
     WHERE table_schema=DATABASE() AND partition_name IS NOT NULL
       AND table_name IN (
        'backup_catalog_control','backup_catalog_external_events','backup_snapshot_anchors','backup_catalog_entries',
        'backup_restore_source_bindings','backup_runtime_reservations',
        'backup_catalog_evictions'))
);
-- agent-service-runtime-fingerprint:authoritative-backup-catalog-schema:end
SET @migration_sql=IF(@backup_catalog_schema_ok=1,'SELECT 1',
  'SELECT 1 FROM __invalid_backup_catalog_schema__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- All immutable evidence rejects UPDATE/DELETE. The only mutable row families are the one-way
-- control CAS and a reservation's reserved -> activated|aborted resolution. Source INSERT guards
-- deliberately re-read the active control/runtime projections at the mutation boundary.
DROP TRIGGER IF EXISTS trg_backup_catalog_control_bi;
CREATE TRIGGER trg_backup_catalog_control_bi BEFORE INSERT ON backup_catalog_control FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='backup catalog control already exists';
DROP TRIGGER IF EXISTS trg_backup_catalog_control_bd;
CREATE TRIGGER trg_backup_catalog_control_bd BEFORE DELETE ON backup_catalog_control FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='backup catalog control cannot be deleted';
DROP TRIGGER IF EXISTS trg_backup_catalog_control_bu;
CREATE TRIGGER trg_backup_catalog_control_bu BEFORE UPDATE ON backup_catalog_control FOR EACH ROW BEGIN IF (OLD.singleton_id=1 AND NEW.singleton_id=1 AND OLD.state='inactive' AND NEW.state='active' AND OLD.control_generation=0 AND NEW.control_generation=1 AND NEW.protocol='tenant-backup-catalog-v1' AND NEW.adapter_protocol IS NOT NULL AND NEW.catalog_namespace_sha256 IS NOT NULL AND NEW.catalog_target_sha256 IS NOT NULL AND NEW.failure_domain_sha256 IS NOT NULL AND NEW.logical_database_namespace_sha256 IS NOT NULL AND NEW.journal_control_evidence_sha256 IS NOT NULL AND NEW.retention_policy_sha256 IS NOT NULL AND NEW.minimum_retention_ms IS NOT NULL AND NEW.minimum_recoverable_backups IS NOT NULL AND NEW.activated_at_db_ms IS NOT NULL AND NEW.evidence_sha256 IS NOT NULL AND EXISTS (SELECT 1 FROM tenant_restore_journal_control j JOIN tenant_restore_runtime_control c ON c.singleton_id=j.singleton_id WHERE j.singleton_id=1 AND j.control_generation=1 AND c.state='active' AND c.control_generation>0 AND BINARY j.logical_database_namespace_sha256=BINARY NEW.logical_database_namespace_sha256 AND BINARY j.evidence_sha256=BINARY NEW.journal_control_evidence_sha256 AND BINARY c.logical_database_namespace_sha256=BINARY NEW.logical_database_namespace_sha256 AND BINARY c.control_evidence_sha256=BINARY NEW.journal_control_evidence_sha256 AND NEW.activated_at_db_ms>=c.updated_at_db_ms) AND EXISTS (SELECT 1 FROM blob_storage_control s WHERE s.singleton_id=1 AND s.control_generation=1) AND NOT EXISTS (SELECT 1 FROM tenant_restore_replay_runs r WHERE r.phase IN ('prepared','replay_sealed') AND NOT EXISTS (SELECT 1 FROM backup_restore_source_bindings b JOIN backup_runtime_reservations q ON BINARY q.restore_run_id=BINARY b.restore_run_id AND BINARY q.backup_id=BINARY b.backup_id AND BINARY q.entry_sha256=BINARY b.entry_sha256 AND BINARY q.binding_sha256=BINARY b.binding_sha256 WHERE BINARY b.restore_run_id=BINARY r.restore_run_id AND BINARY b.source_backup_sha256=BINARY r.source_backup_sha256 AND BINARY b.control_evidence_sha256=BINARY NEW.evidence_sha256 AND BINARY b.journal_control_evidence_sha256=BINARY r.control_evidence_sha256 AND BINARY b.sealed_target_root_sha256=BINARY r.sealed_target_root_sha256 AND BINARY b.runtime_epoch_sha256=BINARY r.runtime_epoch_sha256 AND BINARY q.runtime_epoch_sha256=BINARY r.runtime_epoch_sha256 AND BINARY q.reservation_receipt_sha256=BINARY b.reservation_receipt_sha256 AND q.phase='reserved'))) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='backup catalog activation is not permitted'; END IF; END;

DROP TRIGGER IF EXISTS trg_backup_catalog_external_events_bi;
CREATE TRIGGER trg_backup_catalog_external_events_bi BEFORE INSERT ON backup_catalog_external_events FOR EACH ROW BEGIN DECLARE v_sequence BIGINT UNSIGNED DEFAULT 0; DECLARE v_root CHAR(64) DEFAULT 'bab7b17930d82572302c510c686e061ae9bd0de44ff19c83c483f45524b24e81'; SELECT COALESCE(MAX(catalog_sequence),0) INTO v_sequence FROM backup_catalog_external_events; IF v_sequence>0 THEN SELECT catalog_event_root_sha256 INTO v_root FROM backup_catalog_external_events WHERE catalog_sequence=v_sequence; END IF; IF (NEW.catalog_sequence=v_sequence+1 AND BINARY NEW.previous_catalog_event_root_sha256=BINARY v_root AND EXISTS (SELECT 1 FROM backup_catalog_control c WHERE c.singleton_id=1 AND c.state='active' AND BINARY c.protocol=BINARY NEW.protocol AND BINARY c.adapter_protocol=BINARY NEW.adapter_protocol AND BINARY c.catalog_namespace_sha256=BINARY NEW.catalog_namespace_sha256 AND BINARY c.catalog_target_sha256=BINARY NEW.catalog_target_sha256 AND BINARY c.failure_domain_sha256=BINARY NEW.failure_domain_sha256) AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.event_payload_json,'$.eventType'))=BINARY NEW.event_type AND CAST(JSON_UNQUOTE(JSON_EXTRACT(NEW.event_payload_json,'$.result.catalogSequence')) AS UNSIGNED)=NEW.catalog_sequence AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.event_payload_json,'$.result.previousCatalogEventRootSha256'))=BINARY NEW.previous_catalog_event_root_sha256 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.event_payload_json,'$.result.catalogEventRootSha256'))=BINARY NEW.catalog_event_root_sha256 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.event_payload_json,'$.result.catalogEventSha256'))=BINARY NEW.catalog_event_sha256 AND BINARY CASE NEW.event_type WHEN 'backup_recoverable' THEN JSON_UNQUOTE(JSON_EXTRACT(NEW.event_payload_json,'$.result.availabilityOperationSha256')) WHEN 'restore_reserved' THEN JSON_UNQUOTE(JSON_EXTRACT(NEW.event_payload_json,'$.result.reservationOperationSha256')) WHEN 'restore_resolved' THEN JSON_UNQUOTE(JSON_EXTRACT(NEW.event_payload_json,'$.result.resolutionOperationSha256')) ELSE JSON_UNQUOTE(JSON_EXTRACT(NEW.event_payload_json,'$.result.evictionOperationSha256')) END=BINARY NEW.operation_sha256 AND BINARY CASE NEW.event_type WHEN 'backup_recoverable' THEN JSON_UNQUOTE(JSON_EXTRACT(NEW.event_payload_json,'$.result.availabilityReceiptSha256')) WHEN 'restore_reserved' THEN JSON_UNQUOTE(JSON_EXTRACT(NEW.event_payload_json,'$.result.reservationReceiptSha256')) WHEN 'restore_resolved' THEN JSON_UNQUOTE(JSON_EXTRACT(NEW.event_payload_json,'$.result.resolutionReceiptSha256')) ELSE JSON_UNQUOTE(JSON_EXTRACT(NEW.event_payload_json,'$.result.acknowledgementReceiptSha256')) END=BINARY NEW.receipt_sha256) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='backup catalog external event does not extend the active chain'; END IF; END;
DROP TRIGGER IF EXISTS trg_backup_catalog_external_events_bu;
CREATE TRIGGER trg_backup_catalog_external_events_bu BEFORE UPDATE ON backup_catalog_external_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='backup catalog external event is immutable';
DROP TRIGGER IF EXISTS trg_backup_catalog_external_events_bd;
CREATE TRIGGER trg_backup_catalog_external_events_bd BEFORE DELETE ON backup_catalog_external_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='backup catalog external event is append-only';

DROP TRIGGER IF EXISTS trg_backup_catalog_anchors_bi;
CREATE TRIGGER trg_backup_catalog_anchors_bi BEFORE INSERT ON backup_snapshot_anchors FOR EACH ROW BEGIN DECLARE v_schema_root CHAR(64); DECLARE v_schema_name VARCHAR(128); DECLARE v_schema_done BOOLEAN DEFAULT FALSE; DECLARE schema_cursor CURSOR FOR SELECT name FROM schema_migrations ORDER BY BINARY name; DECLARE CONTINUE HANDLER FOR NOT FOUND SET v_schema_done=TRUE; SET v_schema_root=LOWER(SHA2('agent-service-schema-migrations-v1',256)); OPEN schema_cursor; schema_loop: LOOP FETCH schema_cursor INTO v_schema_name; IF v_schema_done THEN LEAVE schema_loop; END IF; SET v_schema_root=LOWER(SHA2(CONCAT('agent-service-schema-migration-v1|',v_schema_root,'|',LPAD(OCTET_LENGTH(v_schema_name),10,'0'),'|',v_schema_name),256)); END LOOP; CLOSE schema_cursor; IF NOT (BINARY NEW.schema_migration_root_sha256=BINARY v_schema_root AND EXISTS (SELECT 1 FROM blob_storage_control s WHERE s.singleton_id=1 AND s.control_generation=1 AND BINARY s.evidence_sha256=BINARY NEW.blob_storage_control_evidence_sha256)) OR NOT EXISTS (SELECT 1 FROM backup_catalog_control b JOIN tenant_restore_journal_control j ON j.singleton_id=b.singleton_id JOIN tenant_restore_runtime_control c ON c.singleton_id=b.singleton_id WHERE b.singleton_id=1 AND b.state='active' AND b.control_generation=1 AND NEW.singleton_id=1 AND BINARY b.evidence_sha256=BINARY NEW.control_evidence_sha256 AND BINARY b.logical_database_namespace_sha256=BINARY NEW.logical_database_namespace_sha256 AND BINARY b.journal_control_evidence_sha256=BINARY NEW.journal_control_evidence_sha256 AND BINARY j.evidence_sha256=BINARY NEW.journal_control_evidence_sha256 AND c.state='active' AND c.control_generation=NEW.source_runtime_control_generation AND BINARY c.runtime_epoch_sha256=BINARY NEW.source_runtime_epoch_sha256 AND BINARY c.evidence_sha256=BINARY NEW.source_runtime_control_evidence_sha256 AND BINARY c.logical_database_namespace_sha256=BINARY NEW.logical_database_namespace_sha256 AND c.target_count=NEW.source_runtime_target_count AND BINARY c.verified_head_root_sha256=BINARY NEW.source_runtime_head_root_sha256 AND NEW.created_at_db_ms>=c.updated_at_db_ms AND NEW.retention_until_db_ms-NEW.created_at_db_ms>=b.minimum_retention_ms AND (SELECT COUNT(*) FROM tenant_restore_runtime_heads h WHERE h.singleton_id=1)=NEW.source_runtime_target_count AND NOT EXISTS (SELECT 1 FROM tenant_restore_runtime_heads h WHERE h.singleton_id=1 AND (h.target_ordinal>=NEW.source_runtime_target_count OR JSON_TYPE(JSON_EXTRACT(NEW.source_runtime_head_catalog_json,CONCAT('$[',h.target_ordinal,']')))<>'OBJECT' OR JSON_LENGTH(JSON_EXTRACT(NEW.source_runtime_head_catalog_json,CONCAT('$[',h.target_ordinal,']')))<>8 OR NOT (CAST(JSON_UNQUOTE(JSON_EXTRACT(NEW.source_runtime_head_catalog_json,CONCAT('$[',h.target_ordinal,'].targetOrdinal'))) AS UNSIGNED)<=>h.target_ordinal) OR NOT (BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.source_runtime_head_catalog_json,CONCAT('$[',h.target_ordinal,'].targetSha256'))) <=> BINARY h.target_sha256) OR NOT (BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.source_runtime_head_catalog_json,CONCAT('$[',h.target_ordinal,'].failureDomainSha256'))) <=> BINARY h.failure_domain_sha256) OR NOT (BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.source_runtime_head_catalog_json,CONCAT('$[',h.target_ordinal,'].adapterProtocol'))) <=> BINARY h.adapter_protocol) OR NOT (BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.source_runtime_head_catalog_json,CONCAT('$[',h.target_ordinal,'].journalNamespaceSha256'))) <=> BINARY h.journal_namespace_sha256) OR NOT (BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.source_runtime_head_catalog_json,CONCAT('$[',h.target_ordinal,'].logicalDatabaseNamespaceSha256'))) <=> BINARY h.logical_database_namespace_sha256) OR NOT (CAST(JSON_UNQUOTE(JSON_EXTRACT(NEW.source_runtime_head_catalog_json,CONCAT('$[',h.target_ordinal,'].sealedRemoteSequence'))) AS UNSIGNED)<=>h.remote_sequence) OR NOT (BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.source_runtime_head_catalog_json,CONCAT('$[',h.target_ordinal,'].sealedHeadRootSha256'))) <=> BINARY h.head_root_sha256)))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='backup snapshot anchor is not active-source-bound'; END IF; END;
DROP TRIGGER IF EXISTS trg_backup_catalog_anchors_bu;
CREATE TRIGGER trg_backup_catalog_anchors_bu BEFORE UPDATE ON backup_snapshot_anchors FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='backup snapshot anchor is immutable';
DROP TRIGGER IF EXISTS trg_backup_catalog_anchors_bd;
CREATE TRIGGER trg_backup_catalog_anchors_bd BEFORE DELETE ON backup_snapshot_anchors FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='backup snapshot anchor is append-only';
DROP TRIGGER IF EXISTS trg_backup_catalog_anchors_pending_bi;
CREATE TRIGGER trg_backup_catalog_anchors_pending_bi BEFORE INSERT ON backup_snapshot_anchors FOR EACH ROW BEGIN IF EXISTS (SELECT 1 FROM tenant_restore_replay_runs r WHERE r.phase IN ('prepared','replay_sealed')) OR EXISTS (SELECT 1 FROM backup_catalog_external_events r WHERE r.event_type='restore_reserved' AND NOT EXISTS (SELECT 1 FROM backup_catalog_external_events q WHERE q.event_type='restore_resolved' AND BINARY JSON_UNQUOTE(JSON_EXTRACT(q.event_payload_json,'$.result.restoreRunId'))=BINARY JSON_UNQUOTE(JSON_EXTRACT(r.event_payload_json,'$.result.restoreRunId')))) OR NEW.source_catalog_sequence<>(SELECT COALESCE(MAX(catalog_sequence),0) FROM backup_catalog_external_events) OR BINARY NEW.source_catalog_event_root_sha256<>BINARY COALESCE((SELECT catalog_event_root_sha256 FROM backup_catalog_external_events ORDER BY catalog_sequence DESC LIMIT 1),'bab7b17930d82572302c510c686e061ae9bd0de44ff19c83c483f45524b24e81') THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='backup snapshot anchor requires quiescent exact catalog head'; END IF; END;

DROP TRIGGER IF EXISTS trg_backup_catalog_entries_bi;
CREATE TRIGGER trg_backup_catalog_entries_bi BEFORE INSERT ON backup_catalog_entries FOR EACH ROW BEGIN IF NOT EXISTS (SELECT 1 FROM backup_catalog_control c JOIN backup_catalog_external_events x ON x.catalog_sequence=NEW.catalog_sequence AND x.event_type='backup_recoverable' AND BINARY x.operation_sha256=BINARY NEW.availability_operation_sha256 AND BINARY x.receipt_sha256=BINARY NEW.availability_receipt_sha256 AND BINARY x.previous_catalog_event_root_sha256=BINARY NEW.previous_catalog_event_root_sha256 AND BINARY x.catalog_event_root_sha256=BINARY NEW.catalog_event_root_sha256 AND BINARY x.catalog_event_sha256=BINARY NEW.catalog_event_sha256 WHERE c.singleton_id=1 AND c.state='active' AND c.control_generation=1 AND BINARY c.evidence_sha256=BINARY NEW.control_evidence_sha256 AND BINARY c.catalog_namespace_sha256=BINARY NEW.catalog_namespace_sha256 AND BINARY c.catalog_target_sha256=BINARY NEW.catalog_target_sha256 AND BINARY c.failure_domain_sha256=BINARY NEW.failure_domain_sha256 AND BINARY c.adapter_protocol=BINARY NEW.adapter_protocol AND BINARY c.logical_database_namespace_sha256=BINARY NEW.logical_database_namespace_sha256 AND BINARY c.retention_policy_sha256=BINARY NEW.retention_policy_sha256 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(x.event_payload_json,'$.result.backupId'))=BINARY NEW.backup_id AND BINARY JSON_UNQUOTE(JSON_EXTRACT(x.event_payload_json,'$.result.anchorSha256'))=BINARY NEW.anchor_sha256 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(x.event_payload_json,'$.result.entrySha256'))=BINARY NEW.entry_sha256 AND (NOT EXISTS (SELECT 1 FROM backup_snapshot_anchors a0 WHERE BINARY a0.backup_id=BINARY NEW.backup_id) OR EXISTS (SELECT 1 FROM backup_snapshot_anchors a WHERE BINARY a.backup_id=BINARY NEW.backup_id AND BINARY a.anchor_sha256=BINARY NEW.anchor_sha256 AND BINARY a.control_evidence_sha256=BINARY NEW.control_evidence_sha256 AND BINARY a.logical_database_namespace_sha256=BINARY NEW.logical_database_namespace_sha256 AND a.retention_until_db_ms=NEW.retention_until_db_ms AND a.created_at_db_ms=NEW.registered_at_db_ms))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='backup catalog entry is not external-event-bound'; END IF; END;
DROP TRIGGER IF EXISTS trg_backup_catalog_entries_bu;
CREATE TRIGGER trg_backup_catalog_entries_bu BEFORE UPDATE ON backup_catalog_entries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='backup catalog entry is immutable';
DROP TRIGGER IF EXISTS trg_backup_catalog_entries_bd;
CREATE TRIGGER trg_backup_catalog_entries_bd BEFORE DELETE ON backup_catalog_entries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='backup catalog entry is append-only';

DROP TRIGGER IF EXISTS trg_backup_catalog_bindings_bi;
CREATE TRIGGER trg_backup_catalog_bindings_bi BEFORE INSERT ON backup_restore_source_bindings FOR EACH ROW BEGIN IF NOT EXISTS (SELECT 1 FROM backup_catalog_control c JOIN backup_catalog_entries e ON BINARY e.backup_id=BINARY NEW.backup_id AND BINARY e.entry_sha256=BINARY NEW.entry_sha256 JOIN backup_snapshot_anchors a ON BINARY a.backup_id=BINARY e.backup_id AND BINARY a.anchor_sha256=BINARY e.anchor_sha256 WHERE c.singleton_id=1 AND c.state='active' AND c.control_generation=1 AND BINARY c.evidence_sha256=BINARY NEW.control_evidence_sha256 AND BINARY e.control_evidence_sha256=BINARY NEW.control_evidence_sha256 AND BINARY e.anchor_sha256=BINARY NEW.anchor_sha256 AND BINARY e.source_snapshot_sha256=BINARY NEW.source_snapshot_sha256 AND BINARY e.source_backup_sha256=BINARY NEW.source_backup_sha256 AND BINARY e.artifact_manifest_sha256=BINARY NEW.artifact_manifest_sha256 AND BINARY e.provider_evidence_sha256=BINARY NEW.provider_evidence_sha256 AND e.catalog_sequence=NEW.selected_catalog_sequence AND BINARY e.catalog_event_root_sha256=BINARY NEW.selected_catalog_event_root_sha256 AND BINARY a.journal_control_evidence_sha256=BINARY NEW.journal_control_evidence_sha256 AND BINARY c.journal_control_evidence_sha256=BINARY NEW.journal_control_evidence_sha256 AND NEW.bound_at_db_ms>=e.registered_at_db_ms AND NOT EXISTS (SELECT 1 FROM backup_catalog_external_events x WHERE x.event_type='backup_evicted' AND BINARY JSON_UNQUOTE(JSON_EXTRACT(x.event_payload_json,'$.result.backupId'))=BINARY e.backup_id)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='backup restore binding is not recoverable-source-bound'; END IF; END;
DROP TRIGGER IF EXISTS trg_backup_catalog_bindings_bu;
CREATE TRIGGER trg_backup_catalog_bindings_bu BEFORE UPDATE ON backup_restore_source_bindings FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='backup restore binding is immutable';
DROP TRIGGER IF EXISTS trg_backup_catalog_bindings_bd;
CREATE TRIGGER trg_backup_catalog_bindings_bd BEFORE DELETE ON backup_restore_source_bindings FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='backup restore binding is append-only';

DROP TRIGGER IF EXISTS trg_backup_catalog_reservations_bi;
CREATE TRIGGER trg_backup_catalog_reservations_bi BEFORE INSERT ON backup_runtime_reservations FOR EACH ROW BEGIN IF NOT (NEW.phase='reserved' AND NEW.resolution_operation_sha256 IS NULL AND NEW.resolution_receipt_sha256 IS NULL AND NEW.resolution_catalog_sequence IS NULL AND NEW.resolution_previous_catalog_event_root_sha256 IS NULL AND NEW.resolution_catalog_event_root_sha256 IS NULL AND NEW.resolution_catalog_event_sha256 IS NULL AND NEW.resolved_at_db_ms IS NULL AND EXISTS (SELECT 1 FROM backup_restore_source_bindings b JOIN backup_catalog_external_events x ON x.catalog_sequence=NEW.catalog_sequence AND x.event_type='restore_reserved' AND BINARY x.operation_sha256=BINARY NEW.reservation_operation_sha256 AND BINARY x.receipt_sha256=BINARY NEW.reservation_receipt_sha256 AND BINARY x.previous_catalog_event_root_sha256=BINARY NEW.previous_catalog_event_root_sha256 AND BINARY x.catalog_event_root_sha256=BINARY NEW.catalog_event_root_sha256 AND BINARY x.catalog_event_sha256=BINARY NEW.catalog_event_sha256 WHERE BINARY b.restore_run_id=BINARY NEW.restore_run_id AND BINARY b.backup_id=BINARY NEW.backup_id AND BINARY b.entry_sha256=BINARY NEW.entry_sha256 AND BINARY b.binding_sha256=BINARY NEW.binding_sha256 AND BINARY b.runtime_epoch_sha256=BINARY NEW.runtime_epoch_sha256 AND BINARY b.reservation_receipt_sha256=BINARY NEW.reservation_receipt_sha256 AND NEW.catalog_sequence>b.selected_catalog_sequence AND NEW.reserved_at_db_ms>=b.bound_at_db_ms AND BINARY JSON_UNQUOTE(JSON_EXTRACT(x.event_payload_json,'$.result.restoreRunId'))=BINARY NEW.restore_run_id AND BINARY JSON_UNQUOTE(JSON_EXTRACT(x.event_payload_json,'$.result.backupId'))=BINARY NEW.backup_id AND BINARY JSON_UNQUOTE(JSON_EXTRACT(x.event_payload_json,'$.result.entrySha256'))=BINARY NEW.entry_sha256 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(x.event_payload_json,'$.result.runtimeEpochSha256'))=BINARY NEW.runtime_epoch_sha256 AND NOT EXISTS (SELECT 1 FROM backup_catalog_external_events e WHERE e.event_type='backup_evicted' AND BINARY JSON_UNQUOTE(JSON_EXTRACT(e.event_payload_json,'$.result.backupId'))=BINARY b.backup_id)) AND NOT EXISTS (SELECT 1 FROM tenant_restore_replay_runs r WHERE BINARY r.restore_run_id=BINARY NEW.restore_run_id OR BINARY r.runtime_epoch_sha256=BINARY NEW.runtime_epoch_sha256) AND NOT EXISTS (SELECT 1 FROM tenant_restore_runtime_events e WHERE BINARY e.activation_epoch_sha256=BINARY NEW.runtime_epoch_sha256) AND NOT EXISTS (SELECT 1 FROM tenant_restore_runtime_control c WHERE c.state='active' AND BINARY c.runtime_epoch_sha256=BINARY NEW.runtime_epoch_sha256)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='backup runtime reservation is not source-bound'; END IF; END;
DROP TRIGGER IF EXISTS trg_backup_catalog_reservations_bu;
CREATE TRIGGER trg_backup_catalog_reservations_bu BEFORE UPDATE ON backup_runtime_reservations FOR EACH ROW BEGIN IF NOT (OLD.runtime_epoch_sha256<=>NEW.runtime_epoch_sha256 AND OLD.restore_run_id<=>NEW.restore_run_id AND OLD.backup_id<=>NEW.backup_id AND OLD.scope<=>NEW.scope AND OLD.protocol<=>NEW.protocol AND OLD.entry_sha256<=>NEW.entry_sha256 AND OLD.binding_sha256<=>NEW.binding_sha256 AND OLD.reservation_operation_sha256<=>NEW.reservation_operation_sha256 AND OLD.reservation_receipt_sha256<=>NEW.reservation_receipt_sha256 AND OLD.catalog_sequence<=>NEW.catalog_sequence AND OLD.previous_catalog_event_root_sha256<=>NEW.previous_catalog_event_root_sha256 AND OLD.catalog_event_root_sha256<=>NEW.catalog_event_root_sha256 AND OLD.catalog_event_sha256<=>NEW.catalog_event_sha256 AND OLD.reserved_at_db_ms<=>NEW.reserved_at_db_ms AND OLD.reservation_sha256<=>NEW.reservation_sha256 AND OLD.phase='reserved' AND NEW.phase IN ('activated','aborted') AND NEW.resolution_operation_sha256 IS NOT NULL AND NEW.resolution_receipt_sha256 IS NOT NULL AND NEW.resolution_catalog_sequence>OLD.catalog_sequence AND NEW.resolution_previous_catalog_event_root_sha256 IS NOT NULL AND NEW.resolution_catalog_event_root_sha256 IS NOT NULL AND NEW.resolution_catalog_event_sha256 IS NOT NULL AND NEW.resolved_at_db_ms>=OLD.reserved_at_db_ms AND EXISTS (SELECT 1 FROM backup_catalog_external_events x WHERE x.catalog_sequence=NEW.resolution_catalog_sequence AND x.event_type='restore_resolved' AND BINARY x.operation_sha256=BINARY NEW.resolution_operation_sha256 AND BINARY x.receipt_sha256=BINARY NEW.resolution_receipt_sha256 AND BINARY x.previous_catalog_event_root_sha256=BINARY NEW.resolution_previous_catalog_event_root_sha256 AND BINARY x.catalog_event_root_sha256=BINARY NEW.resolution_catalog_event_root_sha256 AND BINARY x.catalog_event_sha256=BINARY NEW.resolution_catalog_event_sha256 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(x.event_payload_json,'$.result.restoreRunId'))=BINARY NEW.restore_run_id AND BINARY JSON_UNQUOTE(JSON_EXTRACT(x.event_payload_json,'$.result.reservationReceiptSha256'))=BINARY NEW.reservation_receipt_sha256 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(x.event_payload_json,'$.result.phase'))=BINARY NEW.phase) AND EXISTS (SELECT 1 FROM tenant_restore_replay_runs r WHERE BINARY r.restore_run_id=BINARY NEW.restore_run_id AND BINARY r.runtime_epoch_sha256=BINARY NEW.runtime_epoch_sha256 AND ((NEW.phase='activated' AND r.phase='active') OR (NEW.phase='aborted' AND r.phase='aborted')))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='backup runtime reservation transition is not permitted'; END IF; END;
DROP TRIGGER IF EXISTS trg_backup_catalog_reservations_bd;
CREATE TRIGGER trg_backup_catalog_reservations_bd BEFORE DELETE ON backup_runtime_reservations FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='backup runtime reservation is permanent';

DROP TRIGGER IF EXISTS trg_backup_catalog_evictions_bi;
CREATE TRIGGER trg_backup_catalog_evictions_bi BEFORE INSERT ON backup_catalog_evictions FOR EACH ROW BEGIN IF NOT EXISTS (SELECT 1 FROM backup_catalog_control c JOIN backup_catalog_entries e ON BINARY e.backup_id=BINARY NEW.backup_id AND BINARY e.entry_sha256=BINARY NEW.entry_sha256 JOIN backup_catalog_external_events x ON x.catalog_sequence=NEW.catalog_sequence AND x.event_type='backup_evicted' AND BINARY x.operation_sha256=BINARY NEW.eviction_operation_sha256 AND BINARY x.receipt_sha256=BINARY NEW.acknowledgement_receipt_sha256 AND BINARY x.previous_catalog_event_root_sha256=BINARY NEW.previous_catalog_event_root_sha256 AND BINARY x.catalog_event_root_sha256=BINARY NEW.catalog_event_root_sha256 AND BINARY x.catalog_event_sha256=BINARY NEW.catalog_event_sha256 WHERE c.singleton_id=1 AND c.state='active' AND BINARY c.evidence_sha256=BINARY NEW.control_evidence_sha256 AND BINARY c.retention_policy_sha256=BINARY NEW.retention_policy_sha256 AND BINARY c.adapter_protocol=BINARY NEW.adapter_protocol AND BINARY c.catalog_namespace_sha256=BINARY NEW.catalog_namespace_sha256 AND BINARY c.catalog_target_sha256=BINARY NEW.catalog_target_sha256 AND BINARY e.anchor_sha256=BINARY NEW.anchor_sha256 AND BINARY e.source_snapshot_sha256=BINARY NEW.source_snapshot_sha256 AND BINARY e.source_backup_sha256=BINARY NEW.source_backup_sha256 AND BINARY e.artifact_manifest_sha256=BINARY NEW.artifact_manifest_sha256 AND BINARY e.provider_evidence_sha256=BINARY NEW.provider_evidence_sha256 AND e.retention_until_db_ms=NEW.retention_until_db_ms AND NEW.expected_catalog_sequence>=e.catalog_sequence AND NEW.catalog_sequence=NEW.expected_catalog_sequence+1 AND BINARY NEW.previous_catalog_event_root_sha256=BINARY NEW.expected_catalog_event_root_sha256 AND NEW.evicted_at_db_ms>=e.retention_until_db_ms AND BINARY JSON_UNQUOTE(JSON_EXTRACT(x.event_payload_json,'$.result.backupId'))=BINARY NEW.backup_id AND BINARY JSON_UNQUOTE(JSON_EXTRACT(x.event_payload_json,'$.result.evictionId'))=BINARY NEW.eviction_id AND BINARY JSON_UNQUOTE(JSON_EXTRACT(x.event_payload_json,'$.result.planSha256'))=BINARY NEW.plan_sha256 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(x.event_payload_json,'$.result.externalTombstoneSha256'))=BINARY NEW.external_tombstone_sha256) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='backup catalog eviction is not external-event-bound'; END IF; END;
DROP TRIGGER IF EXISTS trg_backup_catalog_evictions_bu;
CREATE TRIGGER trg_backup_catalog_evictions_bu BEFORE UPDATE ON backup_catalog_evictions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='backup catalog eviction is immutable';
DROP TRIGGER IF EXISTS trg_backup_catalog_evictions_bd;
CREATE TRIGGER trg_backup_catalog_evictions_bd BEFORE DELETE ON backup_catalog_evictions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='backup catalog eviction is permanent';

-- Once active, a 0030-only writer cannot create or advance a restore run. The source binding and
-- runtime reservation are written first in the same transaction; neither has an FK to the 0030 run,
-- so any subsequent run rejection rolls those preparatory writes back atomically.
DROP TRIGGER IF EXISTS trg_backup_catalog_restore_runs_bi;
CREATE TRIGGER trg_backup_catalog_restore_runs_bi BEFORE INSERT ON tenant_restore_replay_runs FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 0; SELECT control_generation INTO v_generation FROM backup_catalog_control WHERE singleton_id=1 FOR SHARE; IF v_generation<>0 AND NOT EXISTS (SELECT 1 FROM backup_restore_source_bindings b JOIN backup_runtime_reservations q ON BINARY q.restore_run_id=BINARY b.restore_run_id AND BINARY q.backup_id=BINARY b.backup_id AND BINARY q.entry_sha256=BINARY b.entry_sha256 AND BINARY q.binding_sha256=BINARY b.binding_sha256 WHERE BINARY b.restore_run_id=BINARY NEW.restore_run_id AND BINARY b.source_backup_sha256=BINARY NEW.source_backup_sha256 AND BINARY b.journal_control_evidence_sha256=BINARY NEW.control_evidence_sha256 AND BINARY b.sealed_target_root_sha256=BINARY NEW.sealed_target_root_sha256 AND BINARY b.runtime_epoch_sha256=BINARY NEW.runtime_epoch_sha256 AND BINARY q.runtime_epoch_sha256=BINARY NEW.runtime_epoch_sha256 AND BINARY q.reservation_receipt_sha256=BINARY b.reservation_receipt_sha256 AND q.phase='reserved') THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active backup catalog requires exact restore source binding'; END IF; END;
DROP TRIGGER IF EXISTS trg_backup_catalog_restore_runs_bu;
CREATE TRIGGER trg_backup_catalog_restore_runs_bu BEFORE UPDATE ON tenant_restore_replay_runs FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 0; SELECT control_generation INTO v_generation FROM backup_catalog_control WHERE singleton_id=1 FOR SHARE; IF v_generation<>0 AND NOT EXISTS (SELECT 1 FROM backup_restore_source_bindings b JOIN backup_runtime_reservations q ON BINARY q.restore_run_id=BINARY b.restore_run_id AND BINARY q.backup_id=BINARY b.backup_id AND BINARY q.entry_sha256=BINARY b.entry_sha256 AND BINARY q.binding_sha256=BINARY b.binding_sha256 WHERE BINARY b.restore_run_id=BINARY NEW.restore_run_id AND BINARY b.source_backup_sha256=BINARY NEW.source_backup_sha256 AND BINARY b.journal_control_evidence_sha256=BINARY NEW.control_evidence_sha256 AND BINARY b.sealed_target_root_sha256=BINARY NEW.sealed_target_root_sha256 AND BINARY b.runtime_epoch_sha256=BINARY NEW.runtime_epoch_sha256 AND BINARY q.runtime_epoch_sha256=BINARY NEW.runtime_epoch_sha256 AND BINARY q.reservation_receipt_sha256=BINARY b.reservation_receipt_sha256 AND ((NEW.phase IN ('prepared','replay_sealed') AND q.phase='reserved') OR (NEW.phase='active' AND q.phase IN ('reserved','activated')) OR (NEW.phase='aborted' AND q.phase IN ('reserved','aborted')))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active backup catalog requires exact restore source binding'; END IF; END;
DROP TRIGGER IF EXISTS trg_backup_catalog_runtime_events_bi;
CREATE TRIGGER trg_backup_catalog_runtime_events_bi BEFORE INSERT ON tenant_restore_runtime_events FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 0; SELECT control_generation INTO v_generation FROM backup_catalog_control WHERE singleton_id=1 FOR SHARE; IF v_generation<>0 AND NEW.update_kind='restore_activation' AND NOT EXISTS (SELECT 1 FROM backup_restore_source_bindings b JOIN backup_runtime_reservations q ON BINARY q.restore_run_id=BINARY b.restore_run_id AND BINARY q.backup_id=BINARY b.backup_id AND BINARY q.entry_sha256=BINARY b.entry_sha256 AND BINARY q.binding_sha256=BINARY b.binding_sha256 WHERE BINARY b.restore_run_id=BINARY NEW.restore_run_id AND BINARY b.journal_control_evidence_sha256=BINARY NEW.control_evidence_sha256 AND BINARY b.sealed_target_root_sha256=BINARY NEW.verified_head_root_sha256 AND BINARY b.runtime_epoch_sha256=BINARY NEW.runtime_epoch_sha256 AND BINARY q.runtime_epoch_sha256=BINARY NEW.runtime_epoch_sha256 AND BINARY q.reservation_receipt_sha256=BINARY b.reservation_receipt_sha256 AND q.phase IN ('reserved','activated')) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active backup catalog requires reserved restore activation'; END IF; END;
DROP TRIGGER IF EXISTS trg_backup_catalog_runtime_control_bu;
CREATE TRIGGER trg_backup_catalog_runtime_control_bu BEFORE UPDATE ON tenant_restore_runtime_control FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 0; SELECT control_generation INTO v_generation FROM backup_catalog_control WHERE singleton_id=1 FOR SHARE; IF v_generation<>0 AND NEW.update_kind='restore_activation' AND NOT EXISTS (SELECT 1 FROM backup_restore_source_bindings b JOIN backup_runtime_reservations q ON BINARY q.restore_run_id=BINARY b.restore_run_id AND BINARY q.backup_id=BINARY b.backup_id AND BINARY q.entry_sha256=BINARY b.entry_sha256 AND BINARY q.binding_sha256=BINARY b.binding_sha256 WHERE BINARY b.restore_run_id=BINARY NEW.restore_run_id AND BINARY b.journal_control_evidence_sha256=BINARY NEW.control_evidence_sha256 AND BINARY b.sealed_target_root_sha256=BINARY NEW.verified_head_root_sha256 AND BINARY b.runtime_epoch_sha256=BINARY NEW.runtime_epoch_sha256 AND BINARY q.runtime_epoch_sha256=BINARY NEW.runtime_epoch_sha256 AND BINARY q.reservation_receipt_sha256=BINARY b.reservation_receipt_sha256 AND q.phase IN ('reserved','activated')) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active backup catalog requires reserved restore activation'; END IF; END;

-- An exact trigger fingerprint rejects same-prefix privileged additions on marker-loss replay.
-- agent-service-runtime-fingerprint:authoritative-backup-catalog-triggers:start
SET @backup_catalog_trigger_ok=(
  SELECT COUNT(*)=26 AND COUNT(DISTINCT trigger_name)=26
     AND SHA2(GROUP_CONCAT(CONCAT_WS('~',event_object_table,trigger_name,
           action_timing,event_manipulation,action_orientation,
           IFNULL(action_condition,'<NULL>'),
           LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),
             CHAR(96),''),'_utf8mb4','')))
         ORDER BY event_object_table,trigger_name SEPARATOR '|'),256)=
       '9a6598ea252b99a4a9f8aa1c6327ac0402af1f7639346b2ad9e10aac97467962'
    FROM information_schema.triggers
   WHERE trigger_schema=DATABASE()
     AND trigger_name LIKE 'trg\_backup\_catalog\_%'
);
-- agent-service-runtime-fingerprint:authoritative-backup-catalog-triggers:end
SET @migration_sql=IF(@backup_catalog_trigger_ok=1,'SELECT 1',
  'SELECT 1 FROM __invalid_backup_catalog_trigger_inventory__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
SET SESSION group_concat_max_len=@backup_catalog_previous_group_concat_max_len;
