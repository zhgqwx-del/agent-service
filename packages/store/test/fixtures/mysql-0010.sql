-- Historical MySQL fixture frozen at migration 0010.
--
-- Keep this snapshot independent from the live migration files: changing 0001-0010 must not move
-- the baseline used to prove an already-running 0010 database can upgrade to 0011. Only tables and
-- indexes exercised by the lifecycle/usage compatibility test are included.

CREATE TABLE schema_migrations (
  name          VARCHAR(128) NOT NULL PRIMARY KEY,
  applied_at_ms BIGINT       NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO schema_migrations (name, applied_at_ms) VALUES
  ('0001_init.sql', 1),
  ('0002_auto_approved.sql', 2),
  ('0003_tenant_auth.sql', 3),
  ('0004_compaction.sql', 4),
  ('0005_api_key_scopes.sql', 5),
  ('0006_id_collation.sql', 6),
  ('0007_strict_ids_and_idempotency_scope.sql', 7),
  ('0008_atomic_turn_writes.sql', 8),
  ('0009_session_tombstone_outbox.sql', 9),
  ('0010_blob_ownership.sql', 10);

CREATE TABLE tenants (
  tenant_id             VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  name                  VARCHAR(256) NULL,
  created_at_ms         BIGINT NOT NULL,
  auth_policy           JSON NULL,
  auth_secret_cipher    VARBINARY(8192) NULL,
  auth_secret_key_id    VARCHAR(128) COLLATE utf8mb4_0900_as_cs NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE sessions (
  session_id           VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  tenant_id            VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  user_id              VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  agent_id             VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  agent_version        INT          NOT NULL,
  status               JSON         NOT NULL,
  title                VARCHAR(256) NULL,
  parent_session_id    VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NULL,
  last_seq             BIGINT       NOT NULL DEFAULT 0,
  fence_token          BIGINT       NOT NULL DEFAULT 0,
  context_epoch        VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  usage_json           JSON         NOT NULL,
  metadata             JSON         NOT NULL,
  created_at_ms        BIGINT       NOT NULL,
  updated_at_ms        BIGINT       NOT NULL,
  archived_at_ms       BIGINT       NULL,
  deleted_at_ms        BIGINT       NULL,
  purge_after_ms       BIGINT       NULL,
  deletion_generation BIGINT       NOT NULL DEFAULT 0,
  auto_approved_tools  JSON         NULL,
  last_compaction_seq  BIGINT       NULL,
  KEY idx_sessions_tenant_user (tenant_id, user_id, session_id),
  KEY idx_sessions_tenant (tenant_id, session_id),
  KEY idx_sessions_parent_lifecycle (parent_session_id, deleted_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE turns (
  turn_id         VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  session_id      VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  user_id         VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  status          VARCHAR(16)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  stop_reason     VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NULL,
  seq_start       BIGINT      NOT NULL,
  seq_end         BIGINT      NULL,
  body            JSON        NOT NULL,
  idempotency_key VARCHAR(256) COLLATE utf8mb4_0900_as_cs NULL,
  started_at_ms   BIGINT      NOT NULL,
  completed_at_ms BIGINT      NULL,
  KEY idx_turns_session (session_id, turn_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE items (
  item_id         VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  session_id      VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  user_id         VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  turn_id         VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  seq             BIGINT      NOT NULL,
  type            VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  status          VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  body            JSON        NOT NULL,
  created_at_ms   BIGINT      NOT NULL,
  completed_at_ms BIGINT      NULL,
  UNIQUE KEY uk_items_session_seq (session_id, seq, item_id),
  KEY idx_items_turn (turn_id, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE events (
  session_id    VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  seq           BIGINT      NOT NULL,
  user_id       VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  type          VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  body          JSON        NOT NULL,
  emitted_at_ms BIGINT      NOT NULL,
  PRIMARY KEY (session_id, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE usage_ledger (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  tenant_id     VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  user_id       VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  session_id    VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  turn_id       VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  step          INT          NOT NULL,
  provider      VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  model         VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  usage_json    JSON         NOT NULL,
  created_at_ms BIGINT       NOT NULL,
  KEY idx_usage_tenant_time (tenant_id, created_at_ms),
  KEY idx_usage_user_time (tenant_id, user_id, created_at_ms),
  UNIQUE KEY uk_usage_session_turn_step (session_id, turn_id, step)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE lifecycle_outbox (
  outbox_id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  topic                 VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  aggregate_id          VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  generation            BIGINT NOT NULL,
  payload               JSON NOT NULL,
  available_at_ms       BIGINT NULL,
  attempts              INT UNSIGNED NOT NULL DEFAULT 0,
  claim_token           VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  lease_until_ms        BIGINT NULL,
  last_error            TEXT NULL,
  completed_at_ms       BIGINT NULL,
  dead_lettered_at_ms   BIGINT NULL,
  created_at_ms         BIGINT NOT NULL,
  UNIQUE KEY uk_lifecycle_outbox_identity (topic, aggregate_id, generation),
  KEY idx_lifecycle_outbox_claim
    (topic, completed_at_ms, dead_lettered_at_ms, available_at_ms, outbox_id, lease_until_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE blob_objects (
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
  deleted_at_ms          BIGINT NULL,
  deletion_generation    BIGINT NOT NULL DEFAULT 0,
  created_at_ms          BIGINT NOT NULL,
  UNIQUE KEY uk_blob_objects_storage_key (storage_key),
  KEY idx_blob_objects_staging (state, staging_expires_at_ms, blob_id),
  KEY idx_blob_objects_owner_session (tenant_id, user_id, session_id, blob_id),
  KEY idx_blob_objects_session_item_state (session_id, item_id, state, blob_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE blob_delete_outbox (
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
  KEY idx_blob_delete_outbox_claim
    (completed_at_ms, dead_lettered_at_ms, available_at_ms, outbox_id, lease_until_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
