-- Every identifier used for ownership, lookup, fencing, or attribution must use the same
-- case-and-accent-sensitive semantics as the in-memory/Redis stores. Moving from *_ai_ci to
-- *_as_cs only makes formerly-equal values distinct, so it cannot create a uniqueness collision.
ALTER TABLE tenants
  MODIFY tenant_id          VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  MODIFY auth_secret_key_id VARCHAR(128) COLLATE utf8mb4_0900_as_cs NULL;

ALTER TABLE api_keys
  MODIFY key_hash  CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  MODIFY key_id    VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  MODIFY tenant_id VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL;

ALTER TABLE agent_versions
  MODIFY tenant_id VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  MODIFY agent_id  VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL;

ALTER TABLE sessions
  MODIFY session_id        VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  MODIFY tenant_id         VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  MODIFY user_id           VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  MODIFY agent_id          VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  MODIFY parent_session_id VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NULL,
  MODIFY context_epoch     VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL;

ALTER TABLE turns
  MODIFY turn_id         VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  MODIFY session_id      VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  MODIFY user_id         VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  MODIFY idempotency_key VARCHAR(256) COLLATE utf8mb4_0900_as_cs NULL;

ALTER TABLE items
  MODIFY item_id    VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  MODIFY session_id VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  MODIFY user_id    VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  MODIFY turn_id    VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL;

ALTER TABLE events
  MODIFY session_id VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  MODIFY user_id    VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL;

ALTER TABLE approvals
  MODIFY approval_id VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  MODIFY session_id  VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  MODIFY user_id     VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  MODIFY turn_id     VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL;

ALTER TABLE provider_configs
  MODIFY tenant_id     VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  MODIFY provider_id   VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  MODIFY secret_key_id VARCHAR(128) COLLATE utf8mb4_0900_as_cs NULL;

ALTER TABLE idempotency_keys
  MODIFY tenant_id VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  MODIFY idem_key  VARCHAR(256) COLLATE utf8mb4_0900_as_cs NOT NULL;

ALTER TABLE usage_ledger
  MODIFY tenant_id  VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  MODIFY user_id    VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  MODIFY session_id VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  MODIFY turn_id    VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  MODIFY provider   VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  MODIFY model      VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL;

-- Scope turn idempotency by tenant + user + session. The information_schema guards make this
-- migration restart-safe if MySQL committed a DDL statement but the process died before recording
-- the migration in schema_migrations.
SET @has_idem_user = (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'idempotency_keys' AND column_name = 'user_id'
);
SET @migration_sql = IF(
  @has_idem_user = 0,
  'ALTER TABLE idempotency_keys ADD COLUMN user_id VARCHAR(128) COLLATE utf8mb4_0900_as_cs NULL AFTER tenant_id',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @has_idem_session = (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'idempotency_keys' AND column_name = 'session_id'
);
SET @migration_sql = IF(
  @has_idem_session = 0,
  'ALTER TABLE idempotency_keys ADD COLUMN session_id VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL AFTER user_id',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- Completed legacy records carry their session in the JSON value, which lets us recover the owner.
-- An unresolved reservation has no trustworthy user/session attribution; discard it so it cannot be
-- replayed across users after the upgrade. Such reservations were temporary (24h) by design.
UPDATE idempotency_keys ik
  JOIN sessions s
    ON BINARY s.session_id = BINARY JSON_UNQUOTE(JSON_EXTRACT(ik.value, '$.sessionId'))
   AND BINARY s.tenant_id = BINARY ik.tenant_id
   SET ik.user_id = s.user_id, ik.session_id = s.session_id
 WHERE ik.value IS NOT NULL AND (ik.user_id IS NULL OR ik.session_id IS NULL);

DELETE FROM idempotency_keys WHERE user_id IS NULL OR session_id IS NULL;

SET @idem_primary_columns = (
  SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',')
    FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'idempotency_keys' AND index_name = 'PRIMARY'
);
SET @migration_sql = IF(
  @idem_primary_columns = 'tenant_id,user_id,session_id,idem_key',
  'SELECT 1',
  'ALTER TABLE idempotency_keys DROP PRIMARY KEY, MODIFY user_id VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL, MODIFY session_id VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL, ADD PRIMARY KEY (tenant_id, user_id, session_id, idem_key)'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
