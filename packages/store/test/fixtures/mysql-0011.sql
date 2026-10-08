-- Historical MySQL fixture frozen at migration 0011.
--
-- Keep this snapshot independent from the live migrations: changing current DDL must not move the
-- baseline used to prove an already-running 0011 erasure database can safely upgrade to 0012.
-- Only the lifecycle and outbox tables exercised by the 0012 compatibility tests are included.

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
  ('0011_erasure_and_usage_separation.sql', 11);

CREATE TABLE subject_lifecycle (
  tenant_id                VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_kind             VARCHAR(16)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_id               VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  state                    VARCHAR(16)  COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'active',
  generation               BIGINT UNSIGNED NOT NULL DEFAULT 0,
  active_request_id        VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NULL,
  legal_hold_at_ms         BIGINT NULL,
  created_at_ms            BIGINT NOT NULL,
  updated_at_ms            BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, subject_kind, subject_id),
  UNIQUE KEY uk_subject_lifecycle_active_request (active_request_id),
  KEY idx_subject_lifecycle_state
    (state, updated_at_ms, tenant_id, subject_kind, subject_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE erasure_requests (
  request_id               VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  tenant_id                VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_kind             VARCHAR(16)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_id               VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  generation               BIGINT UNSIGNED NOT NULL,
  status                   VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  requested_by_key_id      VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  idempotency_key          VARCHAR(256) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_hash             CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  created_at_ms            BIGINT NOT NULL,
  gated_at_ms              BIGINT NULL,
  updated_at_ms            BIGINT NOT NULL,
  completed_at_ms          BIGINT NULL,
  counts_json              JSON NULL,
  checksum                 CHAR(64)     COLLATE utf8mb4_0900_as_cs NULL,
  UNIQUE KEY uk_erasure_requests_subject_generation
    (tenant_id, subject_kind, subject_id, generation),
  UNIQUE KEY uk_erasure_requests_idempotency
    (tenant_id, subject_kind, subject_id, idempotency_key),
  KEY idx_erasure_requests_status
    (status, updated_at_ms, request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE erasure_audit_events (
  request_id               VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  seq                      BIGINT UNSIGNED NOT NULL,
  event_type               VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  payload                  JSON NOT NULL,
  emitted_at_ms            BIGINT NOT NULL,
  PRIMARY KEY (request_id, seq),
  KEY idx_erasure_audit_events_emitted (emitted_at_ms, request_id, seq)
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
