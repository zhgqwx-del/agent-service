-- Historical MySQL fixture frozen at migration 0008 with rows produced by the pre-0009 DELETE
-- contract. It is intentionally independent from live 0001-0008 migrations. The deleted active
-- session proves that the old one-column soft delete could race after a turn became active and leave
-- an in-progress turn, pending approval/item, grants, usage and both receipt shapes behind.

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
  ('0008_atomic_turn_writes.sql', 8);

CREATE TABLE tenants (
  tenant_id             VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  name                  VARCHAR(256) NULL,
  created_at_ms         BIGINT NOT NULL,
  auth_policy           JSON NULL,
  auth_secret_cipher    VARBINARY(8192) NULL,
  auth_secret_key_id    VARCHAR(128) COLLATE utf8mb4_0900_as_cs NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
  auto_approved_tools JSON         NULL,
  last_compaction_seq BIGINT       NULL,
  KEY idx_sessions_tenant_user (tenant_id, user_id, session_id),
  KEY idx_sessions_tenant (tenant_id, session_id)
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
  KEY idx_usage_tenant_time (tenant_id, created_at_ms),
  KEY idx_usage_user_time (tenant_id, user_id, created_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

INSERT INTO tenants (tenant_id, name, created_at_ms) VALUES ('tenant_a', 'historical', 1);

INSERT INTO sessions
  (session_id, tenant_id, user_id, agent_id, agent_version, status, title, parent_session_id,
   last_seq, fence_token, context_epoch, usage_json, metadata, created_at_ms, updated_at_ms,
   archived_at_ms, deleted_at_ms, auto_approved_tools, last_compaction_seq)
VALUES
  ('sess_0008_live', 'tenant_a', 'user_a', 'agent_a', 1, '{"type":"idle"}', NULL, NULL,
   1, 0, 'epoch_live', '{}', '{}', 10, 10, NULL, NULL, '[]', NULL),
  ('sess_0008_deleted_idle', 'tenant_a', 'user_a', 'agent_a', 1, '{"type":"idle"}', NULL, NULL,
   1, 3, 'epoch_idle', '{}', '{}', 20, 40, 45, 50, '["legacy-tool"]', NULL),
  ('sess_0008_deleted_active', 'tenant_a', 'user_a', 'agent_a', 1,
   '{"type":"active","turnId":"turn_0008_active","activeFlags":[]}', NULL, NULL,
   4, 7, 'epoch_active', '{}', '{}', 60, 80, NULL, 90, '["danger"]', NULL);

INSERT INTO events (session_id, seq, user_id, type, body, emitted_at_ms) VALUES
  ('sess_0008_live', 1, 'user_a', 'session/created', '{"type":"session/created"}', 10),
  ('sess_0008_deleted_idle', 1, 'user_a', 'session/created', '{"type":"session/created"}', 20),
  ('sess_0008_deleted_active', 1, 'user_a', 'session/created', '{"type":"session/created"}', 60),
  ('sess_0008_deleted_active', 2, 'user_a', 'turn/started', '{"type":"turn/started"}', 70),
  ('sess_0008_deleted_active', 3, 'user_a', 'item/started', '{"type":"item/started"}', 75),
  ('sess_0008_deleted_active', 4, 'user_a', 'approval/requested', '{"type":"approval/requested"}', 80);

INSERT INTO turns
  (turn_id, session_id, user_id, status, stop_reason, seq_start, seq_end, body,
   idempotency_key, started_at_ms, completed_at_ms)
VALUES
  ('turn_0008_active', 'sess_0008_deleted_active', 'user_a', 'inProgress', NULL, 2, NULL,
   '{"id":"turn_0008_active","sessionId":"sess_0008_deleted_active","status":"inProgress"}',
   'completed-receipt', 70, NULL);

INSERT INTO items
  (item_id, session_id, user_id, turn_id, seq, type, status, body, created_at_ms, completed_at_ms)
VALUES
  ('item_0008_approval', 'sess_0008_deleted_active', 'user_a', 'turn_0008_active', 3,
   'approvalRequest', 'inProgress',
   '{"id":"item_0008_approval","type":"approvalRequest","status":"inProgress","approvalId":"approval_0008"}',
   75, NULL);

INSERT INTO approvals
  (approval_id, session_id, user_id, turn_id, status, body, created_at_ms, expires_at_ms)
VALUES
  ('approval_0008', 'sess_0008_deleted_active', 'user_a', 'turn_0008_active', 'pending',
   '{"id":"approval_0008","status":"pending"}', 80, 1000);

INSERT INTO idempotency_keys
  (tenant_id, user_id, session_id, idem_key, request_hash, value, expires_at_ms)
VALUES
  ('tenant_a', 'user_a', 'sess_0008_deleted_active', 'completed-receipt', REPEAT('a', 64),
   '{"turnId":"turn_0008_active","sessionId":"sess_0008_deleted_active"}', 2000),
  ('tenant_a', 'user_a', 'sess_0008_deleted_active', 'legacy-pending', NULL, NULL, 5);

INSERT INTO usage_ledger
  (tenant_id, user_id, session_id, turn_id, step, provider, model, usage_json, created_at_ms)
VALUES
  ('tenant_a', 'user_a', 'sess_0008_deleted_active', 'turn_0008_active', 1,
   'provider', 'model', '{"inputTokens":1,"outputTokens":2,"totalTokens":3}', 85);
