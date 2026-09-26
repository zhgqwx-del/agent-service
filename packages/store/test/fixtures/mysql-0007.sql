-- Historical MySQL fixture frozen at migration 0007.
--
-- Only the tables touched by 0008 are included. Keeping their old shape as a fixture (instead of
-- rebuilding it from today's 0001-0007 files) makes this a compatibility test for an already-running
-- database. In particular, request_hash and both 0008 indexes must not appear here.

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
  ('0007_strict_ids_and_idempotency_scope.sql', 7);

CREATE TABLE idempotency_keys (
  tenant_id     VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  user_id       VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  session_id    VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  idem_key      VARCHAR(256) COLLATE utf8mb4_0900_as_cs NOT NULL,
  value         JSON         NULL,
  expires_at_ms BIGINT       NOT NULL,
  PRIMARY KEY (tenant_id, user_id, session_id, idem_key)
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
  KEY idx_usage_user_time (tenant_id, user_id, created_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
