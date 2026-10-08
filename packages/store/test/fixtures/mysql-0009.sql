-- Historical MySQL fixture frozen at migration 0009.
--
-- Keep this snapshot independent from the live migration files: changing 0001-0009 must not move
-- the baseline used to prove an already-running 0009 database can upgrade to 0010. Only the
-- pre-0010 tables and rows exercised by that compatibility test are included.

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
  ('0009_session_tombstone_outbox.sql', 9);

CREATE TABLE sessions (
  session_id          VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  tenant_id           VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  user_id             VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  agent_id            VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  agent_version       INT          NOT NULL,
  status              JSON         NOT NULL,
  title               VARCHAR(256) NULL,
  parent_session_id   VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NULL,
  last_seq            BIGINT       NOT NULL DEFAULT 0,
  fence_token         BIGINT       NOT NULL DEFAULT 0,
  context_epoch       VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  usage_json          JSON         NOT NULL,
  metadata            JSON         NOT NULL,
  created_at_ms       BIGINT       NOT NULL,
  updated_at_ms       BIGINT       NOT NULL,
  archived_at_ms      BIGINT       NULL,
  deleted_at_ms       BIGINT       NULL,
  purge_after_ms      BIGINT       NULL,
  deletion_generation BIGINT       NOT NULL DEFAULT 0,
  auto_approved_tools JSON         NULL,
  last_compaction_seq BIGINT       NULL,
  KEY idx_sessions_tenant_user (tenant_id, user_id, session_id),
  KEY idx_sessions_tenant (tenant_id, session_id),
  KEY idx_sessions_parent_lifecycle (parent_session_id, deleted_at_ms)
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
  KEY idx_lifecycle_outbox_claim (
    topic, completed_at_ms, dead_lettered_at_ms, available_at_ms, outbox_id, lease_until_ms
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
