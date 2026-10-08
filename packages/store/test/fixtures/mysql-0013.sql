-- Historical MySQL fixture frozen at migration 0013.
--
-- Keep this snapshot independent from the live migrations: changing current DDL must not move the
-- baseline used to prove an already-running 0013 database can safely expand to 0014. The fixture
-- includes only the session/resource tables needed to preserve genuine pre-0009 generation-zero
-- shapes (including a deleted active turn and pending receipt/approval) plus a native tombstone.

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
  ('0010_blob_ownership.sql', 10),
  ('0011_erasure_and_usage_separation.sql', 11),
  ('0012_erasure_job_queue.sql', 12),
  ('0013_erasure_job_control.sql', 13);

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE turns (
  turn_id         VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  session_id      VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  user_id         VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  status          VARCHAR(16)  NOT NULL,
  stop_reason     VARCHAR(32)  NULL,
  seq_start       BIGINT       NOT NULL,
  seq_end         BIGINT       NULL,
  body            JSON         NOT NULL,
  idempotency_key VARCHAR(256) COLLATE utf8mb4_0900_as_cs NULL,
  started_at_ms   BIGINT       NOT NULL,
  completed_at_ms BIGINT       NULL,
  KEY idx_turns_session (session_id, turn_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE items (
  item_id         VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  session_id      VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  user_id         VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  turn_id         VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  seq             BIGINT       NOT NULL,
  type            VARCHAR(32)  NOT NULL,
  status          VARCHAR(16)  NOT NULL,
  body            JSON         NOT NULL,
  created_at_ms   BIGINT       NOT NULL,
  completed_at_ms BIGINT       NULL,
  UNIQUE KEY uk_items_session_seq (session_id, seq, item_id),
  KEY idx_items_turn (turn_id, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE events (
  session_id    VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  seq           BIGINT       NOT NULL,
  user_id       VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  type          VARCHAR(64)  NOT NULL,
  body          JSON         NOT NULL,
  emitted_at_ms BIGINT       NOT NULL,
  PRIMARY KEY (session_id, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE approvals (
  approval_id   VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  session_id    VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  user_id       VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  turn_id       VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  status        VARCHAR(16)  NOT NULL,
  body          JSON         NOT NULL,
  created_at_ms BIGINT       NOT NULL,
  expires_at_ms BIGINT       NOT NULL,
  KEY idx_approvals_session_status (session_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE idempotency_keys (
  tenant_id     VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  user_id       VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  session_id    VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  idem_key      VARCHAR(256) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_hash  CHAR(64)     COLLATE utf8mb4_0900_as_cs NULL,
  value         JSON         NULL,
  expires_at_ms BIGINT       NOT NULL,
  PRIMARY KEY (tenant_id, user_id, session_id, idem_key),
  KEY idx_idempotency_expires (expires_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE usage_ledger (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  usage_id      VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NULL,
  tenant_id     VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  user_id       VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  session_id    VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  turn_id       VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  step          INT          NOT NULL,
  provider      VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  model         VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  usage_json    JSON         NOT NULL,
  created_at_ms BIGINT       NOT NULL,
  UNIQUE KEY uk_usage_session_turn_step (session_id, turn_id, step),
  UNIQUE KEY uk_usage_ledger_usage_id (usage_id),
  KEY idx_usage_tenant_time (tenant_id, created_at_ms),
  KEY idx_usage_user_time (tenant_id, user_id, created_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

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

INSERT INTO sessions
  (session_id, tenant_id, user_id, agent_id, agent_version, status, title, parent_session_id,
   last_seq, fence_token, context_epoch, usage_json, metadata, created_at_ms, updated_at_ms,
   archived_at_ms, deleted_at_ms, purge_after_ms, deletion_generation, auto_approved_tools,
   last_compaction_seq)
VALUES
  ('sess_live_0013', 'tenant_a', 'user_a', 'agent_a', 1, '{"type":"idle"}', NULL, NULL,
   1, 0, 'epoch_live', '{}', '{}', 10, 10, NULL, NULL, NULL, 0, '[]', NULL),
  ('sess_legacy_idle_0013', 'tenant_a', 'user_a', 'agent_a', 1, '{"type":"idle"}', NULL, NULL,
   1, 4, 'epoch_idle', '{}', '{}', 20, 40, 45, 50, NULL, 0, '["legacy-tool"]', NULL),
  ('sess_legacy_active_0013', 'tenant_a', 'user_a', 'agent_a', 1,
   '{"type":"active","turnId":"turn_legacy_active_0013","activeFlags":[]}', NULL, NULL,
   4, 7, 'epoch_active', '{}', '{}', 60, 80, NULL, 90, NULL, 0, '["danger"]', NULL),
  ('sess_native_0013', 'tenant_a', 'user_a', 'agent_a', 1, '{"type":"idle"}', NULL, NULL,
   2, 9, 'epoch_native', '{}', '{}', 100, 120, NULL, 120, NULL, 3, '[]', NULL);

INSERT INTO events (session_id, seq, user_id, type, body, emitted_at_ms) VALUES
  ('sess_live_0013', 1, 'user_a', 'session/created', '{"type":"session/created"}', 10),
  ('sess_legacy_idle_0013', 1, 'user_a', 'session/created', '{"type":"session/created"}', 20),
  ('sess_legacy_active_0013', 1, 'user_a', 'session/created', '{"type":"session/created"}', 60),
  ('sess_legacy_active_0013', 2, 'user_a', 'turn/started', '{"type":"turn/started"}', 70),
  ('sess_legacy_active_0013', 3, 'user_a', 'item/started', '{"type":"item/started"}', 75),
  ('sess_legacy_active_0013', 4, 'user_a', 'approval/requested', '{"type":"approval/requested"}', 80),
  ('sess_native_0013', 1, 'user_a', 'session/created', '{"type":"session/created"}', 100),
  ('sess_native_0013', 2, 'user_a', 'session/deleted',
   '{"type":"session/deleted","sessionId":"sess_native_0013","seq":2,"emittedAtMs":120,"deletionGeneration":3}', 120);

INSERT INTO turns
  (turn_id, session_id, user_id, status, stop_reason, seq_start, seq_end, body,
   idempotency_key, started_at_ms, completed_at_ms)
VALUES
  ('turn_legacy_active_0013', 'sess_legacy_active_0013', 'user_a', 'inProgress', NULL, 2, NULL,
   '{"id":"turn_legacy_active_0013","sessionId":"sess_legacy_active_0013","status":"inProgress"}',
   'completed-receipt', 70, NULL);

INSERT INTO items
  (item_id, session_id, user_id, turn_id, seq, type, status, body, created_at_ms, completed_at_ms)
VALUES
  ('item_legacy_approval_0013', 'sess_legacy_active_0013', 'user_a',
   'turn_legacy_active_0013', 3, 'approvalRequest', 'inProgress',
   '{"id":"item_legacy_approval_0013","type":"approvalRequest","status":"inProgress","approvalId":"approval_legacy_0013"}',
   75, NULL);

INSERT INTO approvals
  (approval_id, session_id, user_id, turn_id, status, body, created_at_ms, expires_at_ms)
VALUES
  ('approval_legacy_0013', 'sess_legacy_active_0013', 'user_a', 'turn_legacy_active_0013',
   'pending', '{"id":"approval_legacy_0013","status":"pending"}', 80, 1000);

INSERT INTO idempotency_keys
  (tenant_id, user_id, session_id, idem_key, request_hash, value, expires_at_ms)
VALUES
  ('tenant_a', 'user_a', 'sess_legacy_active_0013', 'completed-receipt',
   REPEAT('a', 64), '{"turnId":"turn_legacy_active_0013","sessionId":"sess_legacy_active_0013"}', 2000),
  ('tenant_a', 'user_a', 'sess_legacy_active_0013', 'legacy-pending',
   NULL, NULL, 5);

INSERT INTO usage_ledger
  (usage_id, tenant_id, user_id, session_id, turn_id, step, provider, model, usage_json, created_at_ms)
VALUES
  (NULL, 'tenant_a', 'user_a', 'sess_legacy_active_0013', 'turn_legacy_active_0013', 1,
   'provider', 'model', '{"inputTokens":1,"outputTokens":2,"totalTokens":3}', 85);

INSERT INTO lifecycle_outbox
  (topic, aggregate_id, generation, payload, available_at_ms, attempts, created_at_ms)
VALUES
  ('session.tombstoned', 'sess_native_0013', 3,
   '{"sessionId":"sess_native_0013","deletionGeneration":3,"eventSeq":2}', 120, 0, 120),
  ('session.purge', 'sess_native_0013', 3,
   '{"sessionId":"sess_native_0013","deletionGeneration":3}', NULL, 0, 120);

INSERT INTO blob_objects
  (blob_id, tenant_id, user_id, session_id, item_id, purpose, storage_backend, storage_format,
   storage_key, upload_token, state, sha256, size_bytes, content_type, uploaded_at_ms, ready_at_ms,
   staging_expires_at_ms, delete_after_ms, deleted_at_ms, deletion_generation, created_at_ms)
VALUES
  ('blob_legacy_0013', 'tenant_a', 'user_a', 'sess_legacy_active_0013',
   'item_legacy_approval_0013', 'tool_result', 'filesystem', 'raw-v1',
   'objects/legacy', 'upload_legacy', 'ready', UNHEX(REPEAT('ab', 32)), 3,
   'application/octet-stream', 82, 83, NULL, NULL, NULL, 0, 81);
