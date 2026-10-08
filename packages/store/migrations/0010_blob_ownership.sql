-- Expand-only ownership manifest for BlobStore objects. The business layer stores only opaque
-- blob_id values; storage_backend/storage_key stay private to the runner. Physical deletion of
-- ready objects remains disabled until a later, explicitly activated lifecycle policy.
--
-- CREATE TABLE is atomic in MySQL 8, but DDL auto-commits before schema_migrations is recorded.
-- IF NOT EXISTS therefore makes both the normal restart and a crash between these two table
-- creations converge without deleting or rewriting any existing rows.

CREATE TABLE IF NOT EXISTS blob_objects (
  blob_id                VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  tenant_id              VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  user_id                VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  session_id             VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  item_id                VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NULL,
  purpose                VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  storage_backend        VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  storage_format         VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  storage_key            VARCHAR(512) COLLATE utf8mb4_0900_as_cs NOT NULL,
  upload_token           VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  state                  VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  sha256                 BINARY(32) NULL,
  size_bytes             BIGINT UNSIGNED NULL,
  content_type           VARCHAR(255) COLLATE utf8mb4_0900_as_cs NULL,
  uploaded_at_ms         BIGINT NULL,
  ready_at_ms            BIGINT NULL,
  staging_expires_at_ms  BIGINT NULL,
  delete_after_ms        BIGINT NULL,
  deleted_at_ms           BIGINT NULL,
  deletion_generation    BIGINT NOT NULL DEFAULT 0,
  created_at_ms           BIGINT NOT NULL,
  UNIQUE KEY uk_blob_objects_storage_key (storage_key),
  KEY idx_blob_objects_staging (state, staging_expires_at_ms, blob_id),
  KEY idx_blob_objects_owner_session (tenant_id, user_id, session_id, blob_id),
  KEY idx_blob_objects_session_item_state (session_id, item_id, state, blob_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Blob deletion uses a dedicated queue rather than widening the session lifecycle dispatcher.
-- A worker must re-read blob_objects after claiming: this row identifies work, but is not an
-- authority-bearing snapshot of a physical key. generation prevents a stale deletion intent from
-- deleting a newer lifecycle generation.
CREATE TABLE IF NOT EXISTS blob_delete_outbox (
  outbox_id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  blob_id               VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  generation            BIGINT NOT NULL,
  available_at_ms       BIGINT NULL,
  attempts              INT UNSIGNED NOT NULL DEFAULT 0,
  claim_token           VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  lease_until_ms        BIGINT NULL,
  last_error            TEXT NULL,
  completed_at_ms       BIGINT NULL,
  dead_lettered_at_ms   BIGINT NULL,
  created_at_ms         BIGINT NOT NULL,
  UNIQUE KEY uk_blob_delete_outbox_identity (blob_id, generation),
  KEY idx_blob_delete_outbox_claim (
    completed_at_ms, dead_lettered_at_ms, available_at_ms, outbox_id, lease_until_ms
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
