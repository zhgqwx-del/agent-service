-- Historical MySQL fixture frozen at migration 0014.
--
-- Keep this snapshot independent from live migrations. It contains the 0011 subject gate and
-- erasure queue state consumed or preserved by 0015, an unavailable session.purge intent, and the
-- 0014 compensation substrate. In particular, it deliberately has no 0015 policy/hold tables.

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
  ('0014_legacy_tombstone_compensation.sql', 14);

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
  request_id                  VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  tenant_id                   VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_kind                VARCHAR(16)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_id                  VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  generation                  BIGINT UNSIGNED NOT NULL,
  status                      VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  requested_by_key_id         VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  idempotency_key             VARCHAR(256) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_hash                CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  created_at_ms               BIGINT NOT NULL,
  gated_at_ms                 BIGINT NULL,
  updated_at_ms               BIGINT NOT NULL,
  completed_at_ms             BIGINT NULL,
  counts_json                 JSON NULL,
  checksum                    CHAR(64)     COLLATE utf8mb4_0900_as_cs NULL,
  available_at_ms             BIGINT NULL,
  attempts                    INT UNSIGNED NOT NULL DEFAULT 0,
  claim_token                 VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NULL,
  lease_until_ms              BIGINT NULL,
  last_error_code             VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NULL,
  policy_version              VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NULL,
  policy_hash                 CHAR(64)     COLLATE utf8mb4_0900_as_cs NULL,
  control_generation          BIGINT UNSIGNED NOT NULL DEFAULT 0,
  quarantined_at_ms           BIGINT NULL,
  quarantine_reason_code      VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NULL,
  quarantine_evidence_sha256  CHAR(64)     COLLATE utf8mb4_0900_as_cs NULL,
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

-- Installed by 0012 and still present at the 0014 boundary. 0015 must coexist with this writer
-- normalization trigger without depending on trigger execution order.
CREATE TRIGGER trg_erasure_requests_job_bi
BEFORE INSERT ON erasure_requests
FOR EACH ROW
SET NEW.available_at_ms = CASE
  WHEN NEW.status IN ('gated','draining','tombstoning','reconciling_usage','purging')
    THEN COALESCE(NEW.available_at_ms, NEW.updated_at_ms)
  ELSE NULL
END;

CREATE TABLE erasure_audit_events (
  request_id       VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  seq              BIGINT UNSIGNED NOT NULL,
  event_type       VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  payload          JSON NOT NULL,
  emitted_at_ms    BIGINT NOT NULL,
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE legacy_tombstone_cutover (
  singleton_id              TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  control_generation        BIGINT UNSIGNED NOT NULL DEFAULT 0,
  activated_at_ms           BIGINT NULL,
  actor_key_id              VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  evidence_sha256           CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  CONSTRAINT chk_legacy_tombstone_cutover_singleton CHECK (singleton_id = 1),
  CONSTRAINT chk_legacy_tombstone_cutover_state CHECK (
    (control_generation = 0 AND activated_at_ms IS NULL
      AND actor_key_id IS NULL AND evidence_sha256 IS NULL)
    OR
    (control_generation = 1 AND activated_at_ms IS NOT NULL
      AND actor_key_id IS NOT NULL AND evidence_sha256 IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE legacy_tombstone_compensation_jobs (
  job_id                    VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  session_id                VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id                 VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  user_id                   VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_kind               VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_request_id         VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  source_subject_generation BIGINT UNSIGNED NULL,
  source_claim_attempt      INT UNSIGNED NULL,
  source_claim_token_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  maintenance_actor_key_id  VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  source_deleted_at_ms      BIGINT NOT NULL,
  source_last_seq           BIGINT NOT NULL,
  candidate_sha256          CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  status                    VARCHAR(32) COLLATE utf8mb4_0900_as_cs NOT NULL,
  control_generation        BIGINT UNSIGNED NOT NULL,
  available_at_ms           BIGINT NULL,
  attempts                  INT UNSIGNED NOT NULL DEFAULT 0,
  claim_token               VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  lease_until_ms            BIGINT NULL,
  last_error_code           VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL,
  created_at_ms             BIGINT NOT NULL,
  updated_at_ms             BIGINT NOT NULL,
  completed_at_ms           BIGINT NULL,
  completed_event_seq       BIGINT NULL,
  completed_claim_attempt   INT UNSIGNED NULL,
  completed_claim_token_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  terminal_at_ms            BIGINT NULL,
  terminal_reason_code      VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL,
  terminal_evidence_sha256  CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  UNIQUE KEY uk_legacy_tombstone_compensation_job_session (session_id),
  KEY idx_legacy_tombstone_compensation_jobs_claim
    (status, available_at_ms, lease_until_ms, job_id),
  KEY idx_legacy_tombstone_compensation_jobs_owner (tenant_id, user_id, session_id),
  KEY idx_legacy_tombstone_compensation_jobs_source (source_request_id, session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE legacy_tombstone_compensation_events (
  result_event_id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  job_id                       VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  session_id                   VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  control_generation           BIGINT UNSIGNED NOT NULL,
  event_type                   VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  reason_code                  VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL,
  actor_key_id                 VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  claim_attempt                INT UNSIGNED NULL,
  source_deleted_at_ms         BIGINT NOT NULL,
  target_deletion_generation   BIGINT UNSIGNED NULL,
  terminal_event_seq           BIGINT NULL,
  before_sha256                CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  after_sha256                 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  emitted_at_ms                BIGINT NOT NULL,
  UNIQUE KEY uk_legacy_tombstone_compensation_event_generation
    (job_id, control_generation),
  KEY idx_legacy_tombstone_compensation_events_session (session_id, result_event_id),
  KEY idx_legacy_tombstone_compensation_events_emitted
    (event_type, emitted_at_ms, result_event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

INSERT INTO subject_lifecycle
  (tenant_id, subject_kind, subject_id, state, generation, active_request_id,
   legal_hold_at_ms, created_at_ms, updated_at_ms)
VALUES
  ('tenant_a', 'tenant', 'tenant_a', 'active', 0, NULL, NULL, 100, 300),
  ('tenant_a', 'user', 'user_a', 'deleting', 1,
   'erase_11111111-1111-4111-8111-111111111111', 220, 110, 220),
  ('tenant_a', 'user', 'user_clear', 'active', 0, NULL, NULL, 120, 121),
  ('tenant_b', 'tenant', 'tenant_b', 'active', 0, NULL, 250, 200, 250),
  ('tenant_b', 'user', 'user_b', 'active', 0, NULL, NULL, 210, 211);

INSERT INTO erasure_requests
  (request_id, tenant_id, subject_kind, subject_id, generation, status,
   requested_by_key_id, idempotency_key, request_hash, created_at_ms, gated_at_ms, updated_at_ms,
   completed_at_ms, counts_json, checksum, available_at_ms, attempts, claim_token, lease_until_ms,
   last_error_code, policy_version, policy_hash, control_generation, quarantined_at_ms,
   quarantine_reason_code, quarantine_evidence_sha256)
VALUES
  ('erase_11111111-1111-4111-8111-111111111111', 'tenant_a', 'user', 'user_a', 1,
   'awaiting_purge_policy', 'migration-fixture', 'fixture-idempotency', REPEAT('1', 64),
   210, 210, 219, NULL, NULL, NULL, NULL, 4, NULL, NULL, NULL,
   'legacy-policy-v1', REPEAT('a', 64), 0, NULL, NULL, NULL);

INSERT INTO erasure_audit_events
  (request_id, seq, event_type, payload, emitted_at_ms)
VALUES
  ('erase_11111111-1111-4111-8111-111111111111', 1, 'erasure/gated',
   '{"status":"gated","subjectKind":"user","generation":1}', 210),
  ('erase_11111111-1111-4111-8111-111111111111', 2, 'erasure/status_changed',
   '{"fromStatus":"reconciling_usage","status":"awaiting_purge_policy","generation":1,"policyVersion":"legacy-policy-v1","policyHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}', 219);

INSERT INTO lifecycle_outbox
  (topic, aggregate_id, generation, payload, available_at_ms, attempts, claim_token,
   lease_until_ms, last_error, completed_at_ms, dead_lettered_at_ms, created_at_ms)
VALUES
  ('session.purge', 'sess_native_0014', 3,
   '{"sessionId":"sess_native_0014","deletionGeneration":3}',
   NULL, 0, NULL, NULL, NULL, NULL, NULL, 260);

INSERT INTO legacy_tombstone_cutover
  (singleton_id, control_generation, activated_at_ms, actor_key_id, evidence_sha256)
VALUES (1, 1, 270, 'migration-admin', REPEAT('c', 64));

INSERT INTO legacy_tombstone_compensation_jobs
  (job_id, session_id, tenant_id, user_id, source_kind, source_request_id,
   source_subject_generation, source_claim_attempt, source_claim_token_sha256,
   maintenance_actor_key_id, source_deleted_at_ms, source_last_seq, candidate_sha256,
   status, control_generation, available_at_ms, attempts, claim_token, lease_until_ms,
   last_error_code, created_at_ms, updated_at_ms, completed_at_ms, completed_event_seq,
   completed_claim_attempt, completed_claim_token_sha256, terminal_at_ms,
   terminal_reason_code, terminal_evidence_sha256)
VALUES
  ('legacyjob_0014_fixture', 'sess_legacy_0014', 'tenant_a', 'user_a', 'maintenance',
   NULL, NULL, NULL, NULL, 'migration-admin', 90, 4, REPEAT('d', 64),
   'completed', 1, NULL, 1, NULL, NULL, NULL, 271, 280, 280, 5,
   1, REPEAT('e', 64), NULL, NULL, NULL);

INSERT INTO legacy_tombstone_compensation_events
  (job_id, session_id, control_generation, event_type, reason_code, actor_key_id,
   claim_attempt, source_deleted_at_ms, target_deletion_generation, terminal_event_seq,
   before_sha256, after_sha256, emitted_at_ms)
VALUES
  ('legacyjob_0014_fixture', 'sess_legacy_0014', 1,
   'legacy_tombstone/compensated', NULL, 'migration-admin', 1, 90, 1, 5,
   REPEAT('f', 64), REPEAT('0', 64), 280);
