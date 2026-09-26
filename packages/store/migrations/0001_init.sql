-- agent-service initial schema (MySQL 8.0). All timestamps are epoch milliseconds (BIGINT).
-- `user_id` is present on every session-scoped table as the future shard key.

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id     VARCHAR(128) NOT NULL PRIMARY KEY,
  name          VARCHAR(256) NULL,
  created_at_ms BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS api_keys (
  key_hash      CHAR(64) NOT NULL PRIMARY KEY,
  key_id        VARCHAR(64) NOT NULL,
  tenant_id     VARCHAR(128) NOT NULL,
  created_at_ms BIGINT NOT NULL,
  revoked_at_ms BIGINT NULL,
  KEY idx_api_keys_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_versions (
  tenant_id     VARCHAR(128) NOT NULL,
  agent_id      VARCHAR(64)  NOT NULL,
  version       INT          NOT NULL,
  definition    JSON         NOT NULL,
  created_at_ms BIGINT       NOT NULL,
  PRIMARY KEY (tenant_id, agent_id, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sessions (
  session_id          VARCHAR(64)  NOT NULL PRIMARY KEY,
  tenant_id           VARCHAR(128) NOT NULL,
  user_id             VARCHAR(128) NOT NULL,
  agent_id            VARCHAR(64)  NOT NULL,
  agent_version       INT          NOT NULL,
  status              JSON         NOT NULL,
  title               VARCHAR(256) NULL,
  parent_session_id   VARCHAR(64)  NULL,
  last_seq            BIGINT       NOT NULL DEFAULT 0,
  fence_token         BIGINT       NOT NULL DEFAULT 0,
  context_epoch       VARCHAR(64)  NOT NULL,
  usage_json          JSON         NOT NULL,
  metadata            JSON         NOT NULL,
  created_at_ms       BIGINT       NOT NULL,
  updated_at_ms       BIGINT       NOT NULL,
  archived_at_ms      BIGINT       NULL,
  deleted_at_ms       BIGINT       NULL,
  KEY idx_sessions_tenant_user (tenant_id, user_id, session_id),
  KEY idx_sessions_tenant (tenant_id, session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS turns (
  turn_id         VARCHAR(64) NOT NULL PRIMARY KEY,
  session_id      VARCHAR(64) NOT NULL,
  user_id         VARCHAR(128) NOT NULL,
  status          VARCHAR(16) NOT NULL,
  stop_reason     VARCHAR(32) NULL,
  seq_start       BIGINT      NOT NULL,
  seq_end         BIGINT      NULL,
  body            JSON        NOT NULL,
  idempotency_key VARCHAR(256) NULL,
  started_at_ms   BIGINT      NOT NULL,
  completed_at_ms BIGINT      NULL,
  KEY idx_turns_session (session_id, turn_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS items (
  item_id         VARCHAR(64) NOT NULL PRIMARY KEY,
  session_id      VARCHAR(64) NOT NULL,
  user_id         VARCHAR(128) NOT NULL,
  turn_id         VARCHAR(64) NOT NULL,
  seq             BIGINT      NOT NULL,
  type            VARCHAR(32) NOT NULL,
  status          VARCHAR(16) NOT NULL,
  body            JSON        NOT NULL,
  created_at_ms   BIGINT      NOT NULL,
  completed_at_ms BIGINT      NULL,
  UNIQUE KEY uk_items_session_seq (session_id, seq, item_id),
  KEY idx_items_turn (turn_id, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- milestone events only; deltas never land here
CREATE TABLE IF NOT EXISTS events (
  session_id    VARCHAR(64) NOT NULL,
  seq           BIGINT      NOT NULL,
  user_id       VARCHAR(128) NOT NULL,
  type          VARCHAR(64) NOT NULL,
  body          JSON        NOT NULL,
  emitted_at_ms BIGINT      NOT NULL,
  PRIMARY KEY (session_id, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS approvals (
  approval_id   VARCHAR(64) NOT NULL PRIMARY KEY,
  session_id    VARCHAR(64) NOT NULL,
  user_id       VARCHAR(128) NOT NULL,
  turn_id       VARCHAR(64) NOT NULL,
  status        VARCHAR(16) NOT NULL,
  body          JSON        NOT NULL,
  created_at_ms BIGINT      NOT NULL,
  expires_at_ms BIGINT      NOT NULL,
  KEY idx_approvals_session_status (session_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS provider_configs (
  tenant_id       VARCHAR(128) NOT NULL,
  provider_id     VARCHAR(128) NOT NULL,
  config          JSON         NOT NULL,
  secret_cipher   VARBINARY(8192) NULL,
  secret_key_id   VARCHAR(128) NULL,
  created_at_ms   BIGINT       NOT NULL,
  updated_at_ms   BIGINT       NOT NULL,
  PRIMARY KEY (tenant_id, provider_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  tenant_id     VARCHAR(128) NOT NULL,
  idem_key      VARCHAR(256) NOT NULL,
  value         JSON         NULL,
  expires_at_ms BIGINT       NOT NULL,
  PRIMARY KEY (tenant_id, idem_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS usage_ledger (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  tenant_id     VARCHAR(128) NOT NULL,
  user_id       VARCHAR(128) NOT NULL,
  session_id    VARCHAR(64)  NOT NULL,
  turn_id       VARCHAR(64)  NOT NULL,
  step          INT          NOT NULL,
  provider      VARCHAR(128) NOT NULL,
  model         VARCHAR(128) NOT NULL,
  usage_json    JSON         NOT NULL,
  created_at_ms BIGINT       NOT NULL,
  KEY idx_usage_tenant_time (tenant_id, created_at_ms),
  KEY idx_usage_user_time (tenant_id, user_id, created_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
