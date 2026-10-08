-- Historical MySQL preservation fixture frozen at migration 0015.
--
-- Keep this snapshot independent from live migrations. It contains the 0015 lifecycle states that
-- 0016 must not reinterpret (bound and unbound awaiting requests plus a legacy purging request),
-- canonical policy/hold evidence, ordinary session content, usage reconciliation, ready Blob
-- ownership, and unavailable session.purge intents. It deliberately has none of the five 0016
-- policy-evaluation/authority tables.

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
  ('0013_erasure_job_control.sql', 13),
  ('0014_legacy_tombstone_compensation.sql', 14),
  ('0015_retention_policy_and_legal_holds.sql', 15);

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

CREATE TABLE billing_usage_facts (
  usage_id          VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  tenant_id         VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  accounting_period CHAR(7)      COLLATE utf8mb4_0900_as_cs NOT NULL,
  provider          VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  model             VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  input_tokens      BIGINT UNSIGNED NOT NULL,
  output_tokens     BIGINT UNSIGNED NOT NULL,
  cache_read_tokens BIGINT UNSIGNED NOT NULL,
  cache_write_tokens BIGINT UNSIGNED NOT NULL,
  reasoning_tokens  BIGINT UNSIGNED NOT NULL,
  total_tokens      BIGINT UNSIGNED NOT NULL,
  cost_cny          DECIMAL(24,9) NULL,
  currency          CHAR(3)      COLLATE utf8mb4_0900_as_cs NOT NULL,
  fact_sha256       CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  KEY idx_billing_usage_tenant_period
    (tenant_id, accounting_period, provider, model, usage_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE usage_reconciliations (
  tenant_id           VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  user_id             VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  session_id          VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  deletion_generation BIGINT UNSIGNED NOT NULL,
  status              VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  row_count           BIGINT UNSIGNED NOT NULL,
  input_tokens        BIGINT UNSIGNED NOT NULL,
  output_tokens       BIGINT UNSIGNED NOT NULL,
  cache_read_tokens   BIGINT UNSIGNED NOT NULL,
  cache_write_tokens  BIGINT UNSIGNED NOT NULL,
  reasoning_tokens    BIGINT UNSIGNED NOT NULL,
  total_tokens        BIGINT UNSIGNED NOT NULL,
  known_cost_rows     BIGINT UNSIGNED NOT NULL,
  cost_cny            DECIMAL(24,9) NULL,
  checksum            CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  verified_at_ms      BIGINT NOT NULL,
  anonymized_at_ms    BIGINT NULL,
  created_at_ms       BIGINT NOT NULL,
  updated_at_ms       BIGINT NOT NULL,
  PRIMARY KEY (session_id, deletion_generation),
  KEY idx_usage_reconciliations_owner
    (tenant_id, user_id, session_id, deletion_generation),
  KEY idx_usage_reconciliations_status
    (status, updated_at_ms, session_id, deletion_generation)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE lifecycle_outbox (
  outbox_id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  topic               VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  aggregate_id        VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  generation          BIGINT NOT NULL,
  payload             JSON NOT NULL,
  available_at_ms     BIGINT NULL,
  attempts            INT UNSIGNED NOT NULL DEFAULT 0,
  claim_token         VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  lease_until_ms      BIGINT NULL,
  last_error          TEXT NULL,
  completed_at_ms     BIGINT NULL,
  dead_lettered_at_ms BIGINT NULL,
  created_at_ms       BIGINT NOT NULL,
  UNIQUE KEY uk_lifecycle_outbox_identity (topic, aggregate_id, generation),
  KEY idx_lifecycle_outbox_claim
    (topic, completed_at_ms, dead_lettered_at_ms, available_at_ms, outbox_id, lease_until_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE blob_objects (
  blob_id               VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  tenant_id             VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  user_id               VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  session_id            VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  item_id               VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NULL,
  purpose               VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  storage_backend       VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  storage_format        VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  storage_key           VARCHAR(512) COLLATE utf8mb4_0900_as_cs NOT NULL,
  upload_token          VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  state                 VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  sha256                BINARY(32) NULL,
  size_bytes            BIGINT UNSIGNED NULL,
  content_type          VARCHAR(255) COLLATE utf8mb4_0900_as_cs NULL,
  uploaded_at_ms        BIGINT NULL,
  ready_at_ms           BIGINT NULL,
  staging_expires_at_ms BIGINT NULL,
  delete_after_ms       BIGINT NULL,
  deleted_at_ms         BIGINT NULL,
  deletion_generation   BIGINT NOT NULL DEFAULT 0,
  created_at_ms         BIGINT NOT NULL,
  UNIQUE KEY uk_blob_objects_storage_key (storage_key),
  KEY idx_blob_objects_staging (state, staging_expires_at_ms, blob_id),
  KEY idx_blob_objects_owner_session (tenant_id, user_id, session_id, blob_id),
  KEY idx_blob_objects_session_item_state (session_id, item_id, state, blob_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE subject_lifecycle (
  tenant_id         VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_kind      VARCHAR(16)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_id        VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  state             VARCHAR(16)  COLLATE utf8mb4_0900_as_cs NOT NULL DEFAULT 'active',
  generation        BIGINT UNSIGNED NOT NULL DEFAULT 0,
  active_request_id VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NULL,
  legal_hold_at_ms  BIGINT NULL,
  created_at_ms     BIGINT NOT NULL,
  updated_at_ms     BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, subject_kind, subject_id),
  UNIQUE KEY uk_subject_lifecycle_active_request (active_request_id),
  KEY idx_subject_lifecycle_state
    (state, updated_at_ms, tenant_id, subject_kind, subject_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE erasure_requests (
  request_id                 VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  tenant_id                  VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_kind               VARCHAR(16)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_id                 VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  generation                 BIGINT UNSIGNED NOT NULL,
  status                     VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  requested_by_key_id        VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  idempotency_key            VARCHAR(256) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_hash               CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  created_at_ms              BIGINT NOT NULL,
  gated_at_ms                BIGINT NULL,
  updated_at_ms              BIGINT NOT NULL,
  completed_at_ms            BIGINT NULL,
  counts_json                JSON NULL,
  checksum                   CHAR(64)     COLLATE utf8mb4_0900_as_cs NULL,
  available_at_ms            BIGINT NULL,
  attempts                   INT UNSIGNED NOT NULL DEFAULT 0,
  claim_token                VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NULL,
  lease_until_ms             BIGINT NULL,
  last_error_code            VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NULL,
  policy_version             VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NULL,
  policy_hash                CHAR(64)     COLLATE utf8mb4_0900_as_cs NULL,
  control_generation         BIGINT UNSIGNED NOT NULL DEFAULT 0,
  quarantined_at_ms          BIGINT NULL,
  quarantine_reason_code     VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NULL,
  quarantine_evidence_sha256 CHAR(64)     COLLATE utf8mb4_0900_as_cs NULL,
  UNIQUE KEY uk_erasure_requests_subject_generation
    (tenant_id, subject_kind, subject_id, generation),
  UNIQUE KEY uk_erasure_requests_idempotency
    (tenant_id, subject_kind, subject_id, idempotency_key),
  KEY idx_erasure_requests_status (status, updated_at_ms, request_id),
  KEY idx_erasure_requests_claim
    (status, available_at_ms, lease_until_ms, request_id),
  KEY idx_erasure_requests_claim_v2
    (quarantined_at_ms, status, available_at_ms, lease_until_ms, request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE erasure_audit_events (
  request_id    VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  seq           BIGINT UNSIGNED NOT NULL,
  event_type    VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  payload       JSON NOT NULL,
  emitted_at_ms BIGINT NOT NULL,
  PRIMARY KEY (request_id, seq),
  KEY idx_erasure_audit_events_emitted (emitted_at_ms, request_id, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE erasure_job_control_events (
  control_event_id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  request_id               VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  control_generation       BIGINT UNSIGNED NOT NULL,
  event_type               VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  phase                    VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  reason_code              VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  action_code              VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL,
  actor_key_id             VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  before_sha256            CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  after_sha256             CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  emitted_at_ms            BIGINT NOT NULL,
  UNIQUE KEY uk_erasure_job_control_event_generation (request_id, control_generation),
  KEY idx_erasure_job_control_events_request (request_id, control_event_id),
  KEY idx_erasure_job_control_events_emitted (event_type, emitted_at_ms, control_event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE erasure_job_terminal_incidents (
  terminal_incident_id      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  request_id               VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  raw_control_generation    BIGINT UNSIGNED NOT NULL,
  reason_code               VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  evidence_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  emitted_at_ms             BIGINT NOT NULL,
  UNIQUE KEY uk_erasure_job_terminal_incident_request (request_id),
  KEY idx_erasure_job_terminal_incidents_emitted
    (reason_code, emitted_at_ms, terminal_incident_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE retention_policy_versions (
  tenant_id                        VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  policy_version                   VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  schema_version                   INT UNSIGNED NOT NULL,
  session_content_retention_ms     BIGINT UNSIGNED NULL,
  user_erasure_grace_ms            BIGINT UNSIGNED NULL,
  operational_usage_retention_ms   BIGINT UNSIGNED NULL,
  idempotency_receipt_retention_ms BIGINT UNSIGNED NULL,
  billing_fact_retention_ms        BIGINT UNSIGNED NULL,
  lifecycle_audit_retention_ms     BIGINT UNSIGNED NULL,
  export_artifact_ttl_ms           BIGINT UNSIGNED NULL,
  policy_sha256                    CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  created_by_key_id                VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  created_at_ms                    BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, policy_version),
  UNIQUE KEY uk_retention_policy_versions_hash (tenant_id, policy_sha256)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE retention_policy_controls (
  tenant_id             VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  control_generation    BIGINT UNSIGNED NOT NULL DEFAULT 0,
  active_policy_version VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NULL,
  active_policy_sha256  CHAR(64)     COLLATE utf8mb4_0900_as_cs NULL,
  effective_at_ms       BIGINT NULL,
  updated_at_ms         BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE retention_policy_activation_events (
  event_id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id          VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  control_generation BIGINT UNSIGNED NOT NULL,
  policy_version     VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  policy_sha256      CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  effective_at_ms    BIGINT NOT NULL,
  actor_key_id       VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  before_sha256      CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  after_sha256       CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  emitted_at_ms      BIGINT NOT NULL,
  UNIQUE KEY uk_retention_policy_activation_generation (tenant_id, control_generation),
  KEY idx_retention_policy_activation_emitted (tenant_id, emitted_at_ms, event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE legal_hold_controls (
  tenant_id                VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_kind             VARCHAR(16)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_id               VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  control_generation       BIGINT UNSIGNED NOT NULL DEFAULT 0,
  active_hold_count        INT UNSIGNED NOT NULL DEFAULT 0,
  active_projection_sha256 CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  updated_at_ms            BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, subject_kind, subject_id),
  KEY idx_legal_hold_controls_active
    (tenant_id, active_hold_count, subject_kind, subject_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE legal_holds (
  tenant_id                   VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  hold_id                     VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_kind                VARCHAR(16)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_id                  VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  state                       VARCHAR(16)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  reason_code                 VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  external_reference_sha256   CHAR(64)     COLLATE utf8mb4_0900_as_cs NULL,
  created_control_generation  BIGINT UNSIGNED NOT NULL,
  created_by_key_id           VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  created_at_ms               BIGINT NOT NULL,
  released_control_generation BIGINT UNSIGNED NULL,
  released_by_key_id          VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NULL,
  released_at_ms              BIGINT NULL,
  release_reason_code         VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NULL,
  PRIMARY KEY (tenant_id, hold_id),
  UNIQUE KEY uk_legal_holds_subject_generation
    (tenant_id, subject_kind, subject_id, created_control_generation),
  KEY idx_legal_holds_active (tenant_id, subject_kind, subject_id, state, hold_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE legal_hold_events (
  event_id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id                 VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_kind              VARCHAR(16)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_id                VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  control_generation        BIGINT UNSIGNED NOT NULL,
  hold_id                   VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  event_type                VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  reason_code               VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  external_reference_sha256 CHAR(64)     COLLATE utf8mb4_0900_as_cs NULL,
  actor_key_id              VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  before_sha256             CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  after_sha256              CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  emitted_at_ms             BIGINT NOT NULL,
  UNIQUE KEY uk_legal_hold_events_subject_generation
    (tenant_id, subject_kind, subject_id, control_generation),
  KEY idx_legal_hold_events_subject
    (tenant_id, subject_kind, subject_id, event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

INSERT INTO sessions
  (session_id, tenant_id, user_id, agent_id, agent_version, status, title, parent_session_id,
   last_seq, fence_token, context_epoch, usage_json, metadata, created_at_ms, updated_at_ms,
   archived_at_ms, deleted_at_ms, purge_after_ms, deletion_generation, auto_approved_tools,
   last_compaction_seq)
VALUES
  ('sess_0199aabb-ccdd-7001-8000-000000000015', 'tenant_a', 'user_bound', 'agent_a', 1, '{"type":"idle"}',
   'bound content', NULL, 3, 2, 'epoch_bound', '{"totalTokens":3}', '{"fixture":true}',
   100, 900, NULL, 900, NULL, 1, '["safe-tool"]', NULL),
  ('sess_0199aabb-ccdd-7002-8000-000000000015', 'tenant_a', 'user_unbound', 'agent_a', 1, '{"type":"idle"}',
   'unbound content', NULL, 2, 3, 'epoch_unbound', '{}', '{}',
   110, 910, NULL, 910, NULL, 1, '[]', NULL),
  ('sess_0199aabb-ccdd-7003-8000-000000000015', 'tenant_a', 'user_purging', 'agent_a', 1, '{"type":"idle"}',
   'legacy purging content', NULL, 2, 4, 'epoch_purging', '{}', '{}',
   120, 920, NULL, 920, NULL, 1, '[]', NULL);

INSERT INTO turns
  (turn_id, session_id, user_id, status, stop_reason, seq_start, seq_end, body,
   idempotency_key, started_at_ms, completed_at_ms)
VALUES
  ('turn_0199aabb-ccdd-7011-8000-000000000015', 'sess_0199aabb-ccdd-7001-8000-000000000015', 'user_bound', 'completed', 'stop', 2, 2,
   '{"id":"turn_0199aabb-ccdd-7011-8000-000000000015","status":"completed"}', 'receipt-bound', 150, 160);

INSERT INTO items
  (item_id, session_id, user_id, turn_id, seq, type, status, body, created_at_ms, completed_at_ms)
VALUES
  ('item_0199aabb-ccdd-7012-8000-000000000015', 'sess_0199aabb-ccdd-7001-8000-000000000015', 'user_bound', 'turn_0199aabb-ccdd-7011-8000-000000000015', 2,
   'message', 'completed', '{"id":"item_0199aabb-ccdd-7012-8000-000000000015","text":"preserve me"}', 150, 160);

INSERT INTO events (session_id, seq, user_id, type, body, emitted_at_ms) VALUES
  ('sess_0199aabb-ccdd-7001-8000-000000000015', 1, 'user_bound', 'session/created', '{"type":"session/created"}', 100),
  ('sess_0199aabb-ccdd-7001-8000-000000000015', 2, 'user_bound', 'turn/completed', '{"type":"turn/completed"}', 160),
  ('sess_0199aabb-ccdd-7001-8000-000000000015', 3, 'user_bound', 'session/deleted',
   '{"type":"session/deleted","sessionId":"sess_0199aabb-ccdd-7001-8000-000000000015","seq":3,"emittedAtMs":900,"deletionGeneration":1}', 900),
  ('sess_0199aabb-ccdd-7002-8000-000000000015', 1, 'user_unbound', 'session/created', '{"type":"session/created"}', 110),
  ('sess_0199aabb-ccdd-7002-8000-000000000015', 2, 'user_unbound', 'session/deleted',
   '{"type":"session/deleted","sessionId":"sess_0199aabb-ccdd-7002-8000-000000000015","seq":2,"emittedAtMs":910,"deletionGeneration":1}', 910),
  ('sess_0199aabb-ccdd-7003-8000-000000000015', 1, 'user_purging', 'session/created', '{"type":"session/created"}', 120),
  ('sess_0199aabb-ccdd-7003-8000-000000000015', 2, 'user_purging', 'session/deleted',
   '{"type":"session/deleted","sessionId":"sess_0199aabb-ccdd-7003-8000-000000000015","seq":2,"emittedAtMs":920,"deletionGeneration":1}', 920);

INSERT INTO approvals
  (approval_id, session_id, user_id, turn_id, status, body, created_at_ms, expires_at_ms)
VALUES
  ('approval_bound_0015', 'sess_0199aabb-ccdd-7001-8000-000000000015', 'user_bound', 'turn_0199aabb-ccdd-7011-8000-000000000015', 'pending',
   '{"id":"approval_bound_0015","status":"pending"}', 155, 5000);

INSERT INTO idempotency_keys
  (tenant_id, user_id, session_id, idem_key, request_hash, value, expires_at_ms)
VALUES
  ('tenant_a', 'user_bound', 'sess_0199aabb-ccdd-7001-8000-000000000015', 'receipt-bound', REPEAT('1', 64),
   '{"turnId":"turn_0199aabb-ccdd-7011-8000-000000000015"}', 6000),
  ('tenant_a', 'user_bound', 'sess_0199aabb-ccdd-7001-8000-000000000015', 'legacy-pending', NULL, NULL, 10);

INSERT INTO usage_ledger
  (usage_id, tenant_id, user_id, session_id, turn_id, step, provider, model, usage_json, created_at_ms)
VALUES
  ('usg_00000000-0000-4000-8000-000000000015', 'tenant_a', 'user_bound', 'sess_0199aabb-ccdd-7001-8000-000000000015', 'turn_0199aabb-ccdd-7011-8000-000000000015', 1,
   'fixture-provider', 'fixture-model',
   '{"inputTokens":1,"outputTokens":2,"totalTokens":3,"costCNY":0.001}', 159);

INSERT INTO billing_usage_facts
  (usage_id, tenant_id, accounting_period, provider, model, input_tokens, output_tokens,
   cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, cost_cny, currency,
   fact_sha256)
VALUES
  ('usg_00000000-0000-4000-8000-000000000015', 'tenant_a', '1970-01', 'fixture-provider', 'fixture-model',
   1, 2, 0, 0, 0, 3, 0.001000000, 'CNY',
   'a2d5c0f5e2578df46daa7c5787270ea8f77417c2ba513b509528226bd60715c2');

INSERT INTO usage_reconciliations
  (tenant_id, user_id, session_id, deletion_generation, status, row_count, input_tokens,
   output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens,
   known_cost_rows, cost_cny, checksum, verified_at_ms, anonymized_at_ms, created_at_ms,
   updated_at_ms)
VALUES
  ('tenant_a', 'user_bound', 'sess_0199aabb-ccdd-7001-8000-000000000015', 1, 'verified', 1, 1, 2, 0, 0, 0, 3,
   1, 0.001000000, '08861c7ed024dfc34f31802952c56ccc6d14f53a1a0841ed371315258673c49a',
   905, NULL, 905, 905);

INSERT INTO lifecycle_outbox
  (topic, aggregate_id, generation, payload, available_at_ms, attempts, claim_token,
   lease_until_ms, last_error, completed_at_ms, dead_lettered_at_ms, created_at_ms)
VALUES
  ('session.tombstoned', 'sess_0199aabb-ccdd-7001-8000-000000000015', 1,
   '{"sessionId":"sess_0199aabb-ccdd-7001-8000-000000000015","deletionGeneration":1,"eventSeq":3}',
   900, 0, NULL, NULL, NULL, 901, NULL, 900),
  ('session.purge', 'sess_0199aabb-ccdd-7001-8000-000000000015', 1,
   '{"sessionId":"sess_0199aabb-ccdd-7001-8000-000000000015","deletionGeneration":1}',
   NULL, 0, NULL, NULL, NULL, NULL, NULL, 900),
  ('session.purge', 'sess_0199aabb-ccdd-7002-8000-000000000015', 1,
   '{"sessionId":"sess_0199aabb-ccdd-7002-8000-000000000015","deletionGeneration":1}',
   NULL, 0, NULL, NULL, NULL, NULL, NULL, 910),
  ('session.purge', 'sess_0199aabb-ccdd-7003-8000-000000000015', 1,
   '{"sessionId":"sess_0199aabb-ccdd-7003-8000-000000000015","deletionGeneration":1}',
   NULL, 0, NULL, NULL, NULL, NULL, NULL, 920);

INSERT INTO blob_objects
  (blob_id, tenant_id, user_id, session_id, item_id, purpose, storage_backend, storage_format,
   storage_key, upload_token, state, sha256, size_bytes, content_type, uploaded_at_ms, ready_at_ms,
   staging_expires_at_ms, delete_after_ms, deleted_at_ms, deletion_generation, created_at_ms)
VALUES
  ('blob_0199aabb-ccdd-7013-8000-000000000015', 'tenant_a', 'user_bound', 'sess_0199aabb-ccdd-7001-8000-000000000015', 'item_0199aabb-ccdd-7012-8000-000000000015',
   'tool_output', 'filesystem', 'asblob2-envelope', 'objects/0015/bound', 'upload-bound-0015',
   'ready', UNHEX(REPEAT('ab', 32)), 12, 'application/octet-stream', 151, 152,
   NULL, NULL, NULL, 0, 150);

INSERT INTO subject_lifecycle
  (tenant_id, subject_kind, subject_id, state, generation, active_request_id,
   legal_hold_at_ms, created_at_ms, updated_at_ms)
VALUES
  ('tenant_a', 'tenant', 'tenant_a', 'active', 0, NULL, NULL, 90, 90),
  ('tenant_a', 'user', 'user_bound', 'deleting', 1,
   'erase_00000000-0000-4000-8000-000000000015', 700, 100, 900),
  ('tenant_a', 'user', 'user_unbound', 'deleting', 1,
   'erase_00000000-0000-4000-8000-000000000016', NULL, 110, 910),
  ('tenant_a', 'user', 'user_purging', 'deleting', 1,
   'erase_00000000-0000-4000-8000-000000000017', NULL, 120, 920);

INSERT INTO erasure_requests
  (request_id, tenant_id, subject_kind, subject_id, generation, status,
   requested_by_key_id, idempotency_key, request_hash, created_at_ms, gated_at_ms, updated_at_ms,
   completed_at_ms, counts_json, checksum, available_at_ms, attempts, claim_token, lease_until_ms,
   last_error_code, policy_version, policy_hash, control_generation, quarantined_at_ms,
   quarantine_reason_code, quarantine_evidence_sha256)
VALUES
  ('erase_00000000-0000-4000-8000-000000000015', 'tenant_a', 'user', 'user_bound', 1, 'awaiting_purge_policy',
   'fixture-admin', 'erase-bound',
   '66b7623180a506172e92ed05d67ef856b04bc7739fe9e2dd1525aa4e70edfa26', 800, 800, 930,
   NULL, NULL, NULL, NULL, 1, NULL, NULL, NULL,
   'policy-v1', 'da82935fcc53d70d1f7b98e6cb985bdb53b0d54be64689a7648f1a596b986dc4',
   0, NULL, NULL, NULL),
  ('erase_00000000-0000-4000-8000-000000000016', 'tenant_a', 'user', 'user_unbound', 1, 'awaiting_purge_policy',
   'fixture-admin', 'erase-unbound',
   'd7bd9b7eb12da42757f7c2eb44a6eb16afb66ab9e983132485ffc4dca11a6369', 400, 400, 931,
   NULL, NULL, NULL, NULL, 1, NULL, NULL, NULL,
   NULL, NULL, 0, NULL, NULL, NULL),
  ('erase_00000000-0000-4000-8000-000000000017', 'tenant_a', 'user', 'user_purging', 1, 'purging',
   'fixture-admin', 'erase-purging',
   '54c10ab91b1bb3fea3e4000b4eb96186f1ec2d31fdbf23c999a3a3e1e14ef2bd', 820, 820, 932,
   NULL, NULL, NULL, 932, 2, 'legacy-claim-token-0015', 5000, NULL,
   'policy-v1', 'da82935fcc53d70d1f7b98e6cb985bdb53b0d54be64689a7648f1a596b986dc4',
   0, NULL, NULL, NULL);

INSERT INTO erasure_audit_events (request_id, seq, event_type, payload, emitted_at_ms) VALUES
  ('erase_00000000-0000-4000-8000-000000000015', 1, 'erasure/gated',
   '{"status":"gated","subjectKind":"user","generation":1,"policyVersion":"policy-v1","policyHash":"da82935fcc53d70d1f7b98e6cb985bdb53b0d54be64689a7648f1a596b986dc4"}', 800),
  ('erase_00000000-0000-4000-8000-000000000015', 2, 'erasure/status_changed',
   '{"fromStatus":"gated","status":"draining","generation":1,"policyVersion":"policy-v1","policyHash":"da82935fcc53d70d1f7b98e6cb985bdb53b0d54be64689a7648f1a596b986dc4"}', 850),
  ('erase_00000000-0000-4000-8000-000000000015', 3, 'erasure/status_changed',
   '{"fromStatus":"draining","status":"tombstoning","generation":1,"policyVersion":"policy-v1","policyHash":"da82935fcc53d70d1f7b98e6cb985bdb53b0d54be64689a7648f1a596b986dc4"}', 880),
  ('erase_00000000-0000-4000-8000-000000000015', 4, 'erasure/status_changed',
   '{"fromStatus":"tombstoning","status":"reconciling_usage","generation":1,"policyVersion":"policy-v1","policyHash":"da82935fcc53d70d1f7b98e6cb985bdb53b0d54be64689a7648f1a596b986dc4"}', 920),
  ('erase_00000000-0000-4000-8000-000000000015', 5, 'erasure/status_changed',
   '{"fromStatus":"reconciling_usage","status":"awaiting_purge_policy","generation":1,"policyVersion":"policy-v1","policyHash":"da82935fcc53d70d1f7b98e6cb985bdb53b0d54be64689a7648f1a596b986dc4"}', 930),
  ('erase_00000000-0000-4000-8000-000000000016', 1, 'erasure/gated',
   '{"status":"gated","subjectKind":"user","generation":1}', 400),
  ('erase_00000000-0000-4000-8000-000000000016', 2, 'erasure/status_changed',
   '{"fromStatus":"gated","status":"draining","generation":1}', 850),
  ('erase_00000000-0000-4000-8000-000000000016', 3, 'erasure/status_changed',
   '{"fromStatus":"draining","status":"tombstoning","generation":1}', 880),
  ('erase_00000000-0000-4000-8000-000000000016', 4, 'erasure/status_changed',
   '{"fromStatus":"tombstoning","status":"reconciling_usage","generation":1}', 920),
  ('erase_00000000-0000-4000-8000-000000000016', 5, 'erasure/status_changed',
   '{"fromStatus":"reconciling_usage","status":"awaiting_purge_policy","generation":1}', 931),
  ('erase_00000000-0000-4000-8000-000000000017', 1, 'erasure/gated',
   '{"status":"gated","subjectKind":"user","generation":1,"policyVersion":"policy-v1","policyHash":"da82935fcc53d70d1f7b98e6cb985bdb53b0d54be64689a7648f1a596b986dc4"}', 820),
  ('erase_00000000-0000-4000-8000-000000000017', 2, 'erasure/status_changed',
   '{"fromStatus":"gated","status":"draining","generation":1,"policyVersion":"policy-v1","policyHash":"da82935fcc53d70d1f7b98e6cb985bdb53b0d54be64689a7648f1a596b986dc4"}', 850),
  ('erase_00000000-0000-4000-8000-000000000017', 3, 'erasure/status_changed',
   '{"fromStatus":"draining","status":"tombstoning","generation":1,"policyVersion":"policy-v1","policyHash":"da82935fcc53d70d1f7b98e6cb985bdb53b0d54be64689a7648f1a596b986dc4"}', 880),
  ('erase_00000000-0000-4000-8000-000000000017', 4, 'erasure/status_changed',
   '{"fromStatus":"tombstoning","status":"reconciling_usage","generation":1,"policyVersion":"policy-v1","policyHash":"da82935fcc53d70d1f7b98e6cb985bdb53b0d54be64689a7648f1a596b986dc4"}', 900),
  ('erase_00000000-0000-4000-8000-000000000017', 5, 'erasure/status_changed',
   '{"fromStatus":"reconciling_usage","status":"awaiting_purge_policy","generation":1,"policyVersion":"policy-v1","policyHash":"da82935fcc53d70d1f7b98e6cb985bdb53b0d54be64689a7648f1a596b986dc4"}', 920),
  ('erase_00000000-0000-4000-8000-000000000017', 6, 'erasure/status_changed',
   '{"fromStatus":"awaiting_purge_policy","status":"purging","generation":1,"policyVersion":"policy-v1","policyHash":"da82935fcc53d70d1f7b98e6cb985bdb53b0d54be64689a7648f1a596b986dc4"}', 932);

INSERT INTO retention_policy_versions
  (tenant_id, policy_version, schema_version, session_content_retention_ms,
   user_erasure_grace_ms, operational_usage_retention_ms, idempotency_receipt_retention_ms,
   billing_fact_retention_ms, lifecycle_audit_retention_ms, export_artifact_ttl_ms,
   policy_sha256, created_by_key_id, created_at_ms)
VALUES
  ('tenant_a', 'policy-v1', 1, 1000, 500, 2000, 3000, NULL, NULL, NULL,
   'da82935fcc53d70d1f7b98e6cb985bdb53b0d54be64689a7648f1a596b986dc4',
   'fixture-admin', 500);

INSERT INTO retention_policy_controls
  (tenant_id, control_generation, active_policy_version, active_policy_sha256,
   effective_at_ms, updated_at_ms)
VALUES ('tenant_a', 1, 'policy-v1',
  'da82935fcc53d70d1f7b98e6cb985bdb53b0d54be64689a7648f1a596b986dc4', 600, 600);

INSERT INTO retention_policy_activation_events
  (tenant_id, control_generation, policy_version, policy_sha256, effective_at_ms,
   actor_key_id, before_sha256, after_sha256, emitted_at_ms)
VALUES
  ('tenant_a', 1, 'policy-v1',
   'da82935fcc53d70d1f7b98e6cb985bdb53b0d54be64689a7648f1a596b986dc4', 600,
   'fixture-admin',
   'd4f5559bb3d95dae192dfa24ff619cce95147026d469905bde501d379218fe63',
   'b7a288b8c63e1abd094ba8ff83aab1f85c8060df735639d788d9b5e5fd7f5a92', 600);

INSERT INTO legal_hold_controls
  (tenant_id, subject_kind, subject_id, control_generation, active_hold_count,
   active_projection_sha256, updated_at_ms)
VALUES
  ('tenant_a', 'tenant', 'tenant_a', 0, 0,
   'd336a3d705ffe91a7158c28e0e39f45cbc278d4a8890c738d9da03a164fd140f', 0),
  ('tenant_a', 'user', 'user_bound', 1, 1,
   '8856c3d5a0a47c35dfb5c26880c1e8f19b9ec091c816d00a90e5dd36422d3fd7', 700),
  ('tenant_a', 'user', 'user_unbound', 0, 0,
   'd336a3d705ffe91a7158c28e0e39f45cbc278d4a8890c738d9da03a164fd140f', 0),
  ('tenant_a', 'user', 'user_purging', 0, 0,
   'd336a3d705ffe91a7158c28e0e39f45cbc278d4a8890c738d9da03a164fd140f', 0);

INSERT INTO legal_holds
  (tenant_id, hold_id, subject_kind, subject_id, state, reason_code,
   external_reference_sha256, created_control_generation, created_by_key_id, created_at_ms,
   released_control_generation, released_by_key_id, released_at_ms, release_reason_code)
VALUES
  ('tenant_a', 'hold_bound_0015', 'user', 'user_bound', 'active', 'litigation',
   REPEAT('e', 64), 1, 'fixture-admin', 700, NULL, NULL, NULL, NULL);

INSERT INTO legal_hold_events
  (tenant_id, subject_kind, subject_id, control_generation, hold_id, event_type, reason_code,
   external_reference_sha256, actor_key_id, before_sha256, after_sha256, emitted_at_ms)
VALUES
  ('tenant_a', 'user', 'user_bound', 1, 'hold_bound_0015', 'legal_hold/set', 'litigation',
   REPEAT('e', 64), 'fixture-admin',
   '15ceaf413976920a9d17f8fe6de0e03a896736c3dde8186341839bfa3dad9916',
   'b92acc03db6fe395162996baf37dd92e5dc62cc2e5f1f4e67167079edb5dd761', 700);
