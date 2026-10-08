-- Deliberately conflicted partial-0013 fixture layered on top of mysql-0012.sql.
--
-- An early development shape made (request_id, control_generation, event_type) unique, which still
-- allowed two different control facts to claim the same logical generation. The final 0013
-- migration must refuse to collapse either append-only fact when it converges to one event per
-- request/generation.

ALTER TABLE erasure_requests
  ADD COLUMN control_generation BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER policy_hash,
  ADD COLUMN quarantined_at_ms BIGINT NULL AFTER control_generation,
  ADD COLUMN quarantine_reason_code VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL AFTER quarantined_at_ms,
  ADD COLUMN quarantine_evidence_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL AFTER quarantine_reason_code;

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
  UNIQUE KEY uk_erasure_job_control_event_generation
    (request_id, control_generation, event_type),
  KEY idx_erasure_job_control_events_request
    (request_id, control_event_id),
  KEY idx_erasure_job_control_events_emitted
    (event_type, emitted_at_ms, control_event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

INSERT INTO subject_lifecycle
  (tenant_id, subject_kind, subject_id, state, generation, active_request_id,
   legal_hold_at_ms, created_at_ms, updated_at_ms)
VALUES
  ('tenant_0013_conflict', 'tenant', 'tenant_0013_conflict', 'active', 0, NULL,
   NULL, 700, 700),
  ('tenant_0013_conflict', 'user', 'user_0013_conflict', 'deleting', 1,
   'erase_0013_conflict', NULL, 700, 700);

INSERT INTO erasure_requests
  (request_id, tenant_id, subject_kind, subject_id, generation, status,
   requested_by_key_id, idempotency_key, request_hash, created_at_ms, gated_at_ms,
   updated_at_ms, completed_at_ms, counts_json, checksum, available_at_ms, attempts,
   claim_token, lease_until_ms, last_error_code, policy_version, policy_hash,
   control_generation, quarantined_at_ms, quarantine_reason_code,
   quarantine_evidence_sha256)
VALUES
  ('erase_0013_conflict', 'tenant_0013_conflict', 'user', 'user_0013_conflict', 1,
   'gated', 'historical-admin', 'idem-0013-conflict',
   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
   700, 700, 700, NULL, NULL, NULL, 700, 0, NULL, NULL, NULL, NULL, NULL,
   0, NULL, NULL, NULL);

INSERT INTO erasure_audit_events
  (request_id, seq, event_type, payload, emitted_at_ms)
VALUES
  ('erase_0013_conflict', 1, 'erasure/gated',
   '{"status":"gated","subjectKind":"user","generation":1}', 700);

INSERT INTO erasure_job_control_events
  (request_id, control_generation, event_type, phase, reason_code, action_code,
   actor_key_id, before_sha256, after_sha256, emitted_at_ms)
VALUES
  ('erase_0013_conflict', 1, 'erasure_job/quarantined', 'gated',
   'queue_control_invalid', NULL, NULL,
   '1111111111111111111111111111111111111111111111111111111111111111', NULL, 701),
  ('erase_0013_conflict', 1, 'erasure_job/quarantine_repaired', 'gated',
   'queue_control_invalid', 'normalize_queue_control', 'maintenance-key',
   '1111111111111111111111111111111111111111111111111111111111111111',
   '2222222222222222222222222222222222222222222222222222222222222222', 702);
