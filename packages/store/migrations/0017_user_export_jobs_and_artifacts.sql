-- Expand-only user export request, durable snapshot, build, artifact, deletion, and download
-- lease substrate.
--
-- This migration deliberately does not backfill historical users, admit export requests, start
-- workers, expose download locators, reinterpret 0016 purge evidence, or delete any object. Every
-- durable artifact is bound to one subject generation and one immutable policy/TTL observation.
-- The public export format is fixed to ndjson-v1. Physical storage descriptors remain private.
--
-- MySQL DDL auto-commits before schema_migrations is recorded. Each table creation is therefore
-- independently replay-safe. The read-only probes after each CREATE prevent an incompatible
-- pre-existing table from being hidden by IF NOT EXISTS and receiving a false migration marker.

CREATE TABLE IF NOT EXISTS user_export_requests (
  request_id                 VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  tenant_id                  VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  user_id                    VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation         BIGINT UNSIGNED NOT NULL,
  requested_by_key_id        VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  idempotency_key_sha256     CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_sha256             CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  export_format              VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  export_schema_version      INT UNSIGNED NOT NULL,
  policy_version             VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  policy_sha256              CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  artifact_ttl_ms            BIGINT UNSIGNED NOT NULL,
  status                     VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  active_build_generation    BIGINT UNSIGNED NOT NULL DEFAULT 0,
  active_artifact_id         VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NULL,
  last_error_code            VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NULL,
  created_at_ms              BIGINT NOT NULL,
  updated_at_ms              BIGINT NOT NULL,
  snapshot_at_ms             BIGINT NULL,
  ready_at_ms                BIGINT NULL,
  expires_at_ms              BIGINT NULL,
  revoked_at_ms              BIGINT NULL,
  UNIQUE KEY uk_user_export_requests_idempotency
    (tenant_id, user_id, idempotency_key_sha256),
  UNIQUE KEY uk_user_export_requests_active_artifact (active_artifact_id),
  KEY idx_user_export_requests_owner (tenant_id, user_id, created_at_ms, request_id),
  KEY idx_user_export_requests_status (status, updated_at_ms, request_id),
  CONSTRAINT chk_user_export_requests_format CHECK (
    export_format = 'ndjson-v1' AND export_schema_version = 1
  ),
  CONSTRAINT chk_user_export_requests_status CHECK (
    status IN ('queued','building','ready','failed','expired','revoked')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT request_id, tenant_id, user_id, subject_generation, requested_by_key_id,
       idempotency_key_sha256, request_sha256, export_format, export_schema_version,
       policy_version, policy_sha256, artifact_ttl_ms, status, active_build_generation,
       active_artifact_id, last_error_code, created_at_ms, updated_at_ms, ready_at_ms,
       snapshot_at_ms, expires_at_ms, revoked_at_ms
  FROM user_export_requests FORCE INDEX (
    PRIMARY, uk_user_export_requests_idempotency, uk_user_export_requests_active_artifact,
    idx_user_export_requests_owner, idx_user_export_requests_status
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS user_export_jobs (
  request_id                 VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  tenant_id                  VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  user_id                    VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation         BIGINT UNSIGNED NOT NULL,
  build_generation           BIGINT UNSIGNED NOT NULL DEFAULT 0,
  status                     VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  active_artifact_id         VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NULL,
  available_at_ms            BIGINT NULL,
  attempts                   INT UNSIGNED NOT NULL DEFAULT 0,
  claim_token                VARCHAR(128) COLLATE utf8mb4_0900_as_cs NULL,
  lease_until_ms             BIGINT NULL,
  last_error_code            VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NULL,
  snapshot_at_ms             BIGINT NULL,
  snapshot_record_count      BIGINT UNSIGNED NOT NULL DEFAULT 0,
  snapshot_blob_count        BIGINT UNSIGNED NOT NULL DEFAULT 0,
  snapshot_root_sha256       CHAR(64)     COLLATE utf8mb4_0900_as_cs NULL,
  snapshot_sealed_at_ms      BIGINT NULL,
  created_at_ms              BIGINT NOT NULL,
  updated_at_ms              BIGINT NOT NULL,
  completed_at_ms            BIGINT NULL,
  UNIQUE KEY uk_user_export_jobs_active_artifact (active_artifact_id),
  KEY idx_user_export_jobs_claim
    (status, available_at_ms, lease_until_ms, request_id),
  KEY idx_user_export_jobs_owner (tenant_id, user_id, request_id),
  CONSTRAINT chk_user_export_jobs_status CHECK (
    status IN ('queued','building','completed','failed','revoked')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT request_id, tenant_id, user_id, subject_generation, build_generation, status,
       active_artifact_id, available_at_ms, attempts, claim_token, lease_until_ms,
       last_error_code, snapshot_at_ms, snapshot_record_count, snapshot_blob_count,
       snapshot_root_sha256, snapshot_sealed_at_ms, created_at_ms, updated_at_ms,
       completed_at_ms
  FROM user_export_jobs FORCE INDEX (
    PRIMARY, uk_user_export_jobs_active_artifact, idx_user_export_jobs_claim,
    idx_user_export_jobs_owner
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS user_export_artifacts (
  artifact_id                VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  request_id                 VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                  VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  user_id                    VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation         BIGINT UNSIGNED NOT NULL,
  build_generation           BIGINT UNSIGNED NOT NULL,
  export_format              VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  export_schema_version      INT UNSIGNED NOT NULL,
  content_type               VARCHAR(255) COLLATE utf8mb4_0900_as_cs NOT NULL,
  content_encoding           VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  storage_backend            VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  storage_format             VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  state                      VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  part_count                 INT UNSIGNED NOT NULL DEFAULT 0,
  record_count               BIGINT UNSIGNED NOT NULL DEFAULT 0,
  total_size_bytes           BIGINT UNSIGNED NOT NULL DEFAULT 0,
  manifest_sha256            CHAR(64)     COLLATE utf8mb4_0900_as_cs NULL,
  content_sha256             CHAR(64)     COLLATE utf8mb4_0900_as_cs NULL,
  snapshot_root_sha256       CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  policy_version             VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  policy_sha256              CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  artifact_ttl_ms            BIGINT UNSIGNED NOT NULL,
  snapshot_at_ms             BIGINT NULL,
  staging_expires_at_ms      BIGINT NOT NULL,
  ready_at_ms                BIGINT NULL,
  expires_at_ms              BIGINT NULL,
  delete_after_ms            BIGINT NULL,
  deleted_at_ms              BIGINT NULL,
  deletion_generation        BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at_ms              BIGINT NOT NULL,
  updated_at_ms              BIGINT NOT NULL,
  UNIQUE KEY uk_user_export_artifacts_build (request_id, build_generation),
  KEY idx_user_export_artifacts_owner (tenant_id, user_id, state, artifact_id),
  KEY idx_user_export_artifacts_staging
    (state, staging_expires_at_ms, artifact_id),
  KEY idx_user_export_artifacts_expiry (state, expires_at_ms, artifact_id),
  CONSTRAINT chk_user_export_artifacts_format CHECK (
    export_format = 'ndjson-v1' AND export_schema_version = 1
  ),
  CONSTRAINT chk_user_export_artifacts_state CHECK (
    state IN ('staging','ready','delete_pending','deleted')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT artifact_id, request_id, tenant_id, user_id, subject_generation, build_generation,
       export_format, export_schema_version, content_type, content_encoding, storage_backend,
       storage_format, state, part_count,
       record_count, total_size_bytes, manifest_sha256, content_sha256, policy_version,
       snapshot_root_sha256, policy_sha256, artifact_ttl_ms, snapshot_at_ms,
       staging_expires_at_ms, ready_at_ms, expires_at_ms,
       delete_after_ms, deleted_at_ms, deletion_generation, created_at_ms, updated_at_ms
  FROM user_export_artifacts FORCE INDEX (
    PRIMARY, uk_user_export_artifacts_build, idx_user_export_artifacts_owner,
    idx_user_export_artifacts_staging, idx_user_export_artifacts_expiry
  ) WHERE 1=0;

-- Canonical records are sealed in the same database snapshot transaction as the job snapshot
-- root. Later artifact workers read only this immutable build generation, so object upload can be
-- retried after a crash without holding a long-lived source-data transaction.
CREATE TABLE IF NOT EXISTS user_export_snapshot_records (
  request_id                 VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  build_generation           BIGINT UNSIGNED NOT NULL,
  ordinal                    BIGINT UNSIGNED NOT NULL,
  tenant_id                  VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  user_id                    VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation         BIGINT UNSIGNED NOT NULL,
  record_kind                VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  logical_key                VARCHAR(512) COLLATE utf8mb4_0900_as_cs NOT NULL,
  canonical_utf8_bytes       LONGBLOB NOT NULL,
  record_sha256              CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  size_bytes                 BIGINT UNSIGNED NOT NULL,
  captured_at_ms             BIGINT NOT NULL,
  PRIMARY KEY (request_id, build_generation, ordinal),
  UNIQUE KEY uk_user_export_snapshot_record_key
    (request_id, build_generation, record_kind, logical_key),
  KEY idx_user_export_snapshot_records_owner
    (tenant_id, user_id, request_id, build_generation, ordinal),
  CONSTRAINT chk_user_export_snapshot_record_ordinal CHECK (ordinal >= 0),
  CONSTRAINT chk_user_export_snapshot_record_size CHECK (
    size_bytes = OCTET_LENGTH(canonical_utf8_bytes)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT request_id, build_generation, ordinal, tenant_id, user_id, subject_generation,
       record_kind, logical_key, canonical_utf8_bytes, record_sha256, size_bytes,
       captured_at_ms
  FROM user_export_snapshot_records FORCE INDEX (
    PRIMARY, uk_user_export_snapshot_record_key, idx_user_export_snapshot_records_owner
  ) WHERE 1=0;

-- Source Blob descriptors are pinned with the snapshot. They remain private and are fenced by
-- source_deletion_generation plus pin_token. The source cleanup path must honor unreleased pins.
CREATE TABLE IF NOT EXISTS user_export_snapshot_blobs (
  request_id                 VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  build_generation           BIGINT UNSIGNED NOT NULL,
  ordinal                    BIGINT UNSIGNED NOT NULL,
  blob_id                    VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                  VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  user_id                    VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation         BIGINT UNSIGNED NOT NULL,
  session_id                 VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  item_id                    VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NULL,
  purpose                    VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  storage_backend            VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  storage_format             VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  storage_key                VARCHAR(512) COLLATE utf8mb4_0900_as_cs NOT NULL,
  upload_token               VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_deletion_generation BIGINT UNSIGNED NOT NULL,
  source_sha256              CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_size_bytes          BIGINT UNSIGNED NOT NULL,
  source_content_type        VARCHAR(255) COLLATE utf8mb4_0900_as_cs NULL,
  pin_token                  VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  pinned_at_ms               BIGINT NOT NULL,
  released_at_ms             BIGINT NULL,
  PRIMARY KEY (request_id, build_generation, ordinal),
  UNIQUE KEY uk_user_export_snapshot_blob_id
    (request_id, build_generation, blob_id),
  KEY idx_user_export_snapshot_blobs_owner
    (tenant_id, user_id, request_id, build_generation, ordinal),
  KEY idx_user_export_snapshot_blobs_source
    (blob_id, source_deletion_generation, request_id, build_generation),
  KEY idx_user_export_snapshot_blobs_release
    (released_at_ms, request_id, build_generation, ordinal),
  CONSTRAINT chk_user_export_snapshot_blob_ordinal CHECK (ordinal >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT request_id, build_generation, ordinal, blob_id, tenant_id, user_id, subject_generation,
       session_id, item_id, purpose, storage_backend, storage_format, storage_key,
       upload_token, source_deletion_generation, source_sha256, source_size_bytes,
       source_content_type, pin_token, pinned_at_ms, released_at_ms
  FROM user_export_snapshot_blobs FORCE INDEX (
    PRIMARY, uk_user_export_snapshot_blob_id, idx_user_export_snapshot_blobs_owner,
    idx_user_export_snapshot_blobs_source, idx_user_export_snapshot_blobs_release
  ) WHERE 1=0;

-- Download leases are owner-scoped and tied to the exact artifact deletion generation. Artifact
-- expiry scheduling must lock the artifact row and exclude every lease with lease_until_ms>now.
CREATE TABLE IF NOT EXISTS user_export_download_leases (
  artifact_id                VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  lease_token                VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                  VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  user_id                    VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_id                 VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  build_generation           BIGINT UNSIGNED NOT NULL,
  artifact_deletion_generation BIGINT UNSIGNED NOT NULL,
  lease_until_ms             BIGINT NOT NULL,
  created_at_ms              BIGINT NOT NULL,
  updated_at_ms              BIGINT NOT NULL,
  PRIMARY KEY (artifact_id, lease_token),
  KEY idx_user_export_download_leases_artifact
    (artifact_id, lease_until_ms, lease_token),
  KEY idx_user_export_download_leases_expiry
    (lease_until_ms, artifact_id, lease_token),
  KEY idx_user_export_download_leases_owner
    (tenant_id, user_id, request_id, artifact_id),
  CONSTRAINT chk_user_export_download_lease_time CHECK (lease_until_ms >= created_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT artifact_id, lease_token, tenant_id, user_id, request_id, build_generation,
       artifact_deletion_generation, lease_until_ms, created_at_ms, updated_at_ms
  FROM user_export_download_leases FORCE INDEX (
    PRIMARY, idx_user_export_download_leases_artifact, idx_user_export_download_leases_expiry,
    idx_user_export_download_leases_owner
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS user_export_artifact_parts (
  artifact_id                VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  part_number                INT UNSIGNED NOT NULL,
  request_id                 VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  build_generation           BIGINT UNSIGNED NOT NULL,
  tenant_id                  VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  user_id                    VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation         BIGINT UNSIGNED NOT NULL,
  state                      VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  storage_backend            VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  storage_format             VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  storage_key                VARCHAR(512) COLLATE utf8mb4_0900_as_cs NOT NULL,
  upload_token               VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  content_type               VARCHAR(255) COLLATE utf8mb4_0900_as_cs NULL,
  content_encoding           VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  sha256                     CHAR(64)     COLLATE utf8mb4_0900_as_cs NULL,
  size_bytes                 BIGINT UNSIGNED NULL,
  record_count               BIGINT UNSIGNED NULL,
  staging_expires_at_ms      BIGINT NOT NULL,
  uploaded_at_ms             BIGINT NULL,
  delete_after_ms            BIGINT NULL,
  deleted_at_ms              BIGINT NULL,
  deletion_generation        BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at_ms              BIGINT NOT NULL,
  updated_at_ms              BIGINT NOT NULL,
  PRIMARY KEY (artifact_id, part_number),
  UNIQUE KEY uk_user_export_parts_build
    (request_id, build_generation, part_number),
  UNIQUE KEY uk_user_export_parts_storage_key (storage_key),
  KEY idx_user_export_parts_owner
    (tenant_id, user_id, artifact_id, part_number),
  KEY idx_user_export_parts_staging
    (state, staging_expires_at_ms, artifact_id, part_number),
  KEY idx_user_export_parts_delete
    (state, delete_after_ms, artifact_id, part_number),
  CONSTRAINT chk_user_export_parts_number CHECK (part_number >= 0),
  CONSTRAINT chk_user_export_parts_state CHECK (
    state IN ('staging','uploaded','delete_pending','deleted')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT artifact_id, part_number, request_id, build_generation, tenant_id, user_id,
       subject_generation, state, storage_backend, storage_format, storage_key, upload_token,
       content_type, content_encoding, sha256, size_bytes, record_count, staging_expires_at_ms,
       uploaded_at_ms, delete_after_ms, deleted_at_ms, deletion_generation, created_at_ms,
       updated_at_ms
  FROM user_export_artifact_parts FORCE INDEX (
    PRIMARY, uk_user_export_parts_build, uk_user_export_parts_storage_key,
    idx_user_export_parts_owner, idx_user_export_parts_staging, idx_user_export_parts_delete
  ) WHERE 1=0;

CREATE TABLE IF NOT EXISTS user_export_artifact_delete_outbox (
  outbox_id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  artifact_id                VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  part_number                INT UNSIGNED NOT NULL,
  request_id                 VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  build_generation           BIGINT UNSIGNED NOT NULL,
  deletion_generation        BIGINT UNSIGNED NOT NULL,
  storage_backend            VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  storage_format             VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  storage_key                VARCHAR(512) COLLATE utf8mb4_0900_as_cs NOT NULL,
  upload_token               VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  expected_sha256            CHAR(64)     COLLATE utf8mb4_0900_as_cs NULL,
  expected_size_bytes        BIGINT UNSIGNED NULL,
  available_at_ms            BIGINT NOT NULL,
  attempts                   INT UNSIGNED NOT NULL DEFAULT 0,
  claim_token                VARCHAR(128) COLLATE utf8mb4_0900_as_cs NULL,
  lease_until_ms             BIGINT NULL,
  last_error                 TEXT NULL,
  completed_at_ms            BIGINT NULL,
  dead_lettered_at_ms        BIGINT NULL,
  created_at_ms              BIGINT NOT NULL,
  UNIQUE KEY uk_user_export_delete_identity
    (artifact_id, part_number, deletion_generation),
  KEY idx_user_export_delete_claim
    (completed_at_ms, dead_lettered_at_ms, available_at_ms, outbox_id, lease_until_ms),
  KEY idx_user_export_delete_request
    (request_id, build_generation, artifact_id, part_number),
  CONSTRAINT chk_user_export_delete_part_number CHECK (part_number >= 0),
  CONSTRAINT chk_user_export_delete_generation CHECK (deletion_generation > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT outbox_id, artifact_id, part_number, request_id, build_generation,
       deletion_generation, storage_backend, storage_format, storage_key, upload_token,
       expected_sha256, expected_size_bytes, available_at_ms, attempts, claim_token,
       lease_until_ms, last_error, completed_at_ms, dead_lettered_at_ms, created_at_ms
  FROM user_export_artifact_delete_outbox FORCE INDEX (
    PRIMARY, uk_user_export_delete_identity, idx_user_export_delete_claim,
    idx_user_export_delete_request
  ) WHERE 1=0;
