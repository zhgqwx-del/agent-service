-- Expand-only canonical retention-policy and legal-hold substrate. This migration deliberately
-- does not authorize or schedule purge, set sessions.purge_after_ms, make session.purge outbox rows
-- available, anonymize usage, delete content, or advance an erasure request beyond its current
-- state. NULL retention durations are the fail-closed "not authorized to expire" value.
--
-- MySQL DDL auto-commits before schema_migrations is recorded. Each table creation and every
-- insert-only backfill is therefore replayable. Immutable legacy rows are inserted only when their
-- exact expected content is absent: a same-key/different-content row reaches a unique constraint
-- and aborts the migration instead of being hidden by INSERT IGNORE or an upsert.

CREATE TABLE IF NOT EXISTS retention_policy_versions (
  tenant_id                           VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  policy_version                      VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  schema_version                      INT UNSIGNED NOT NULL,
  session_content_retention_ms        BIGINT UNSIGNED NULL,
  user_erasure_grace_ms               BIGINT UNSIGNED NULL,
  operational_usage_retention_ms      BIGINT UNSIGNED NULL,
  idempotency_receipt_retention_ms    BIGINT UNSIGNED NULL,
  billing_fact_retention_ms           BIGINT UNSIGNED NULL,
  lifecycle_audit_retention_ms        BIGINT UNSIGNED NULL,
  export_artifact_ttl_ms              BIGINT UNSIGNED NULL,
  policy_sha256                       CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  created_by_key_id                   VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  created_at_ms                       BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, policy_version),
  UNIQUE KEY uk_retention_policy_versions_hash (tenant_id, policy_sha256)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- One mutable, generation-fenced projection per tenant. An initial generation-zero row has all
-- active markers NULL; it is not a default policy and cannot authorize any irreversible work.
CREATE TABLE IF NOT EXISTS retention_policy_controls (
  tenant_id                 VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  control_generation        BIGINT UNSIGNED NOT NULL DEFAULT 0,
  active_policy_version     VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NULL,
  active_policy_sha256      CHAR(64)     COLLATE utf8mb4_0900_as_cs NULL,
  effective_at_ms           BIGINT NULL,
  updated_at_ms             BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE IF NOT EXISTS retention_policy_activation_events (
  event_id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id                 VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  control_generation        BIGINT UNSIGNED NOT NULL,
  policy_version            VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  policy_sha256             CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  effective_at_ms           BIGINT NOT NULL,
  actor_key_id              VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  before_sha256             CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  after_sha256              CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  emitted_at_ms             BIGINT NOT NULL,
  UNIQUE KEY uk_retention_policy_activation_generation (tenant_id, control_generation),
  KEY idx_retention_policy_activation_emitted (tenant_id, emitted_at_ms, event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE IF NOT EXISTS legal_hold_controls (
  tenant_id                 VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_kind              VARCHAR(16)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_id                VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  control_generation        BIGINT UNSIGNED NOT NULL DEFAULT 0,
  active_hold_count         INT UNSIGNED NOT NULL DEFAULT 0,
  active_projection_sha256  CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  updated_at_ms             BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, subject_kind, subject_id),
  KEY idx_legal_hold_controls_active
    (tenant_id, active_hold_count, subject_kind, subject_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE IF NOT EXISTS legal_holds (
  tenant_id                     VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  hold_id                       VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_kind                  VARCHAR(16)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_id                    VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  state                         VARCHAR(16)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  reason_code                   VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  external_reference_sha256     CHAR(64)     COLLATE utf8mb4_0900_as_cs NULL,
  created_control_generation    BIGINT UNSIGNED NOT NULL,
  created_by_key_id             VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  created_at_ms                 BIGINT NOT NULL,
  released_control_generation   BIGINT UNSIGNED NULL,
  released_by_key_id            VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NULL,
  released_at_ms                BIGINT NULL,
  release_reason_code           VARCHAR(32)  COLLATE utf8mb4_0900_as_cs NULL,
  PRIMARY KEY (tenant_id, hold_id),
  UNIQUE KEY uk_legal_holds_subject_generation
    (tenant_id, subject_kind, subject_id, created_control_generation),
  KEY idx_legal_holds_active
    (tenant_id, subject_kind, subject_id, state, hold_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE IF NOT EXISTS legal_hold_events (
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

-- Existing tenants get an explicitly dormant policy control. Marker-loss replay never rewrites a
-- control which a newer writer has already activated.
INSERT INTO retention_policy_controls
  (tenant_id, control_generation, active_policy_version, active_policy_sha256,
   effective_at_ms, updated_at_ms)
SELECT lifecycle.tenant_id, 0, NULL, NULL, NULL, 0
  FROM subject_lifecycle lifecycle
 WHERE lifecycle.subject_kind = 'tenant'
   AND lifecycle.subject_id = lifecycle.tenant_id
   AND NOT EXISTS (
     SELECT 1 FROM retention_policy_controls controls
      WHERE controls.tenant_id = lifecycle.tenant_id
   );

-- This is SHA-256(JSON.stringify(["agent-service/legal-hold-active-projection/v1"])).
-- Keeping the literal here makes initial controls identical to the TypeScript canonicalizer.
SET @empty_legal_hold_projection_sha256 =
  _utf8mb4'd336a3d705ffe91a7158c28e0e39f45cbc278d4a8890c738d9da03a164fd140f'
    COLLATE utf8mb4_0900_as_cs;

-- Every known subject receives an empty, generation-zero control. legal_hold_at_ms remains the
-- compatibility shadow used by older readers; 0015 does not add or clear a hold on its own.
INSERT INTO legal_hold_controls
  (tenant_id, subject_kind, subject_id, control_generation, active_hold_count,
   active_projection_sha256, updated_at_ms)
SELECT lifecycle.tenant_id, lifecycle.subject_kind, lifecycle.subject_id, 0, 0,
       @empty_legal_hold_projection_sha256, 0
  FROM subject_lifecycle lifecycle
 WHERE NOT EXISTS (
   SELECT 1 FROM legal_hold_controls controls
    WHERE controls.tenant_id = lifecycle.tenant_id
      AND controls.subject_kind = lifecycle.subject_kind
      AND controls.subject_id = lifecycle.subject_id
 );

-- Materialize an honest migration-owned hold for every pre-0015 legal_hold_at_ms. The deterministic
-- id is stable across replay and remains within the public hold-id grammar. The exact-match
-- anti-join is deliberate: a row with the same primary key and different content is selected again
-- and fails on the unique constraint instead of being silently accepted.
INSERT INTO legal_holds
  (tenant_id, hold_id, subject_kind, subject_id, state, reason_code,
   external_reference_sha256, created_control_generation, created_by_key_id, created_at_ms,
   released_control_generation, released_by_key_id, released_at_ms, release_reason_code)
SELECT lifecycle.tenant_id,
       CONCAT('hold_legacy_', LEFT(SHA2(CONCAT(
         '["agent-service/legal-hold-legacy/v1",',
         JSON_QUOTE(lifecycle.tenant_id), ',', JSON_QUOTE(lifecycle.subject_kind), ',',
         JSON_QUOTE(lifecycle.subject_id), ',', CAST(lifecycle.legal_hold_at_ms AS CHAR), ']'
       ), 256), 48)),
       lifecycle.subject_kind, lifecycle.subject_id, 'active', 'legacy_unattributed',
       NULL, 1, 'migration-0015', lifecycle.legal_hold_at_ms,
       NULL, NULL, NULL, NULL
  FROM subject_lifecycle lifecycle
 WHERE lifecycle.legal_hold_at_ms IS NOT NULL
   -- After a completed 0015 migration, later legitimate hold operations can change the
   -- compatibility shadow (for example: set generation 2, then release the imported generation-1
   -- hold at generation 3). A lost migration marker must recognize the immutable import proof
   -- instead of treating that newer shadow as another pre-0015 hold. The full rooted set event is
   -- checked here so a superficial or conflicting same-generation row cannot suppress the import.
   AND NOT EXISTS (
     SELECT 1
       FROM legal_holds imported_hold
       JOIN legal_hold_events imported_event
         ON imported_event.tenant_id = imported_hold.tenant_id
        AND imported_event.subject_kind = imported_hold.subject_kind
        AND imported_event.subject_id = imported_hold.subject_id
        AND imported_event.control_generation = 1
        AND imported_event.hold_id = imported_hold.hold_id
      WHERE imported_hold.tenant_id = lifecycle.tenant_id
        AND imported_hold.subject_kind = lifecycle.subject_kind
        AND imported_hold.subject_id = lifecycle.subject_id
        AND imported_hold.state IN ('active', 'released')
        AND imported_hold.reason_code = 'legacy_unattributed'
        AND imported_hold.external_reference_sha256 IS NULL
        AND imported_hold.created_control_generation = 1
        AND imported_hold.created_by_key_id = 'migration-0015'
        AND imported_hold.hold_id = CONCAT('hold_legacy_', LEFT(SHA2(CONCAT(
          '["agent-service/legal-hold-legacy/v1",',
          JSON_QUOTE(imported_hold.tenant_id), ',', JSON_QUOTE(imported_hold.subject_kind), ',',
          JSON_QUOTE(imported_hold.subject_id), ',',
          CAST(imported_hold.created_at_ms AS CHAR), ']'
        ), 256), 48))
        AND (
          (imported_hold.state = 'active'
            AND imported_hold.released_control_generation IS NULL
            AND imported_hold.released_by_key_id IS NULL
            AND imported_hold.released_at_ms IS NULL
            AND imported_hold.release_reason_code IS NULL)
          OR
          (imported_hold.state = 'released'
            AND imported_hold.released_control_generation > 1
            AND imported_hold.released_by_key_id IS NOT NULL
            AND imported_hold.released_at_ms >= imported_hold.created_at_ms
            AND imported_hold.release_reason_code IN ('matter_closed', 'issued_in_error', 'superseded'))
        )
        AND imported_event.event_type = 'legal_hold/set'
        AND imported_event.reason_code = 'legacy_unattributed'
        AND imported_event.external_reference_sha256 IS NULL
        AND imported_event.actor_key_id = 'migration-0015'
        AND imported_event.emitted_at_ms = imported_hold.created_at_ms
        AND imported_event.before_sha256 = SHA2(CONCAT(
          '["agent-service/legal-hold-control/v1",',
          JSON_QUOTE(imported_hold.tenant_id), ',', JSON_QUOTE(imported_hold.subject_kind), ',',
          JSON_QUOTE(imported_hold.subject_id), ',0,0,',
          JSON_QUOTE(@empty_legal_hold_projection_sha256), ',0]'
        ), 256)
        AND imported_event.after_sha256 = SHA2(CONCAT(
          '["agent-service/legal-hold-control/v1",',
          JSON_QUOTE(imported_hold.tenant_id), ',', JSON_QUOTE(imported_hold.subject_kind), ',',
          JSON_QUOTE(imported_hold.subject_id), ',1,1,',
          JSON_QUOTE(SHA2(CONCAT(
            '["agent-service/legal-hold-active-projection/v1",[',
            JSON_QUOTE(imported_hold.tenant_id), ',',
            JSON_QUOTE(imported_hold.subject_kind), ',',
            JSON_QUOTE(imported_hold.subject_id), ',', JSON_QUOTE(imported_hold.hold_id), ',',
            JSON_QUOTE(imported_hold.reason_code), ',null,1,',
            CAST(imported_hold.created_at_ms AS CHAR), ']]'
          ), 256)), ',', CAST(imported_hold.created_at_ms AS CHAR), ']'
        ), 256)
   )
   AND NOT EXISTS (
     SELECT 1 FROM legal_holds hold_row
      WHERE hold_row.tenant_id = lifecycle.tenant_id
        AND hold_row.hold_id = CONCAT('hold_legacy_', LEFT(SHA2(CONCAT(
          '["agent-service/legal-hold-legacy/v1",',
          JSON_QUOTE(lifecycle.tenant_id), ',', JSON_QUOTE(lifecycle.subject_kind), ',',
          JSON_QUOTE(lifecycle.subject_id), ',', CAST(lifecycle.legal_hold_at_ms AS CHAR), ']'
        ), 256), 48))
        AND hold_row.subject_kind = lifecycle.subject_kind
        AND hold_row.subject_id = lifecycle.subject_id
        AND hold_row.state = 'active'
        AND hold_row.reason_code = 'legacy_unattributed'
        AND hold_row.external_reference_sha256 IS NULL
        AND hold_row.created_control_generation = 1
        AND hold_row.created_by_key_id = 'migration-0015'
        AND hold_row.created_at_ms = lifecycle.legal_hold_at_ms
        AND hold_row.released_control_generation IS NULL
        AND hold_row.released_by_key_id IS NULL
        AND hold_row.released_at_ms IS NULL
        AND hold_row.release_reason_code IS NULL
   );

-- Advance only the exact generation-zero projection created above. A replay after later legitimate
-- control generations preserves those generations; a first-run conflicting generation is rejected
-- by the exact event/backfill proof below.
UPDATE legal_hold_controls controls
JOIN subject_lifecycle lifecycle
  ON lifecycle.tenant_id = controls.tenant_id
 AND lifecycle.subject_kind = controls.subject_kind
 AND lifecycle.subject_id = controls.subject_id
JOIN legal_holds hold_row
  ON hold_row.tenant_id = lifecycle.tenant_id
 AND hold_row.hold_id = CONCAT('hold_legacy_', LEFT(SHA2(CONCAT(
      '["agent-service/legal-hold-legacy/v1",',
      JSON_QUOTE(lifecycle.tenant_id), ',', JSON_QUOTE(lifecycle.subject_kind), ',',
      JSON_QUOTE(lifecycle.subject_id), ',', CAST(lifecycle.legal_hold_at_ms AS CHAR), ']'
    ), 256), 48))
   SET controls.control_generation = 1,
       controls.active_hold_count = 1,
       controls.active_projection_sha256 = SHA2(CONCAT(
         '["agent-service/legal-hold-active-projection/v1",[',
         JSON_QUOTE(hold_row.tenant_id), ',', JSON_QUOTE(hold_row.subject_kind), ',',
         JSON_QUOTE(hold_row.subject_id), ',', JSON_QUOTE(hold_row.hold_id), ',',
         JSON_QUOTE(hold_row.reason_code), ',null,',
         CAST(hold_row.created_control_generation AS CHAR), ',',
         CAST(hold_row.created_at_ms AS CHAR), ']]'
       ), 256),
       controls.updated_at_ms = lifecycle.legal_hold_at_ms
 WHERE lifecycle.legal_hold_at_ms IS NOT NULL
   AND controls.control_generation = 0
   AND controls.active_hold_count = 0
   AND controls.active_projection_sha256 = @empty_legal_hold_projection_sha256;

-- A partial or manually pre-created generation-one control is authoritative only when every field
-- is the deterministic projection of the imported hold. Attempting to insert the expected row at
-- the same primary key turns any mismatch into an explicit duplicate-key failure. In particular,
-- the event backfill below must never hash a corrupt control into apparently self-consistent audit
-- evidence. Controls above generation one are handled by the exact generation-one event proof on
-- replay, so legitimate writes after a completed migration are not rewound.
INSERT INTO legal_hold_controls
  (tenant_id, subject_kind, subject_id, control_generation, active_hold_count,
   active_projection_sha256, updated_at_ms)
SELECT lifecycle.tenant_id, lifecycle.subject_kind, lifecycle.subject_id, 1, 1,
       SHA2(CONCAT(
         '["agent-service/legal-hold-active-projection/v1",[',
         JSON_QUOTE(hold_row.tenant_id), ',', JSON_QUOTE(hold_row.subject_kind), ',',
         JSON_QUOTE(hold_row.subject_id), ',', JSON_QUOTE(hold_row.hold_id), ',',
         JSON_QUOTE(hold_row.reason_code), ',null,',
         CAST(hold_row.created_control_generation AS CHAR), ',',
         CAST(hold_row.created_at_ms AS CHAR), ']]'
       ), 256),
       lifecycle.legal_hold_at_ms
  FROM subject_lifecycle lifecycle
  JOIN legal_holds hold_row
    ON hold_row.tenant_id = lifecycle.tenant_id
   AND hold_row.hold_id = CONCAT('hold_legacy_', LEFT(SHA2(CONCAT(
        '["agent-service/legal-hold-legacy/v1",',
        JSON_QUOTE(lifecycle.tenant_id), ',', JSON_QUOTE(lifecycle.subject_kind), ',',
        JSON_QUOTE(lifecycle.subject_id), ',', CAST(lifecycle.legal_hold_at_ms AS CHAR), ']'
      ), 256), 48))
  JOIN legal_hold_controls controls
    ON controls.tenant_id = lifecycle.tenant_id
   AND controls.subject_kind = lifecycle.subject_kind
   AND controls.subject_id = lifecycle.subject_id
 WHERE lifecycle.legal_hold_at_ms IS NOT NULL
   AND controls.control_generation = 1
   AND NOT (
     controls.active_hold_count = 1
     AND controls.active_projection_sha256 = SHA2(CONCAT(
       '["agent-service/legal-hold-active-projection/v1",[',
       JSON_QUOTE(hold_row.tenant_id), ',', JSON_QUOTE(hold_row.subject_kind), ',',
       JSON_QUOTE(hold_row.subject_id), ',', JSON_QUOTE(hold_row.hold_id), ',',
       JSON_QUOTE(hold_row.reason_code), ',null,',
       CAST(hold_row.created_control_generation AS CHAR), ',',
       CAST(hold_row.created_at_ms AS CHAR), ']]'
     ), 256)
     AND controls.updated_at_ms = lifecycle.legal_hold_at_ms
   );

-- Publish the imported hold event only after its exact control projection exists. before/after
-- hashes use the same ordered arrays as retention-policy.ts.
INSERT INTO legal_hold_events
  (tenant_id, subject_kind, subject_id, control_generation, hold_id, event_type, reason_code,
   external_reference_sha256, actor_key_id, before_sha256, after_sha256, emitted_at_ms)
SELECT lifecycle.tenant_id, lifecycle.subject_kind, lifecycle.subject_id, 1,
       hold_row.hold_id, 'legal_hold/set', 'legacy_unattributed', NULL, 'migration-0015',
       SHA2(CONCAT(
         '["agent-service/legal-hold-control/v1",',
         JSON_QUOTE(lifecycle.tenant_id), ',', JSON_QUOTE(lifecycle.subject_kind), ',',
         JSON_QUOTE(lifecycle.subject_id), ',0,0,',
         JSON_QUOTE(@empty_legal_hold_projection_sha256), ',',
         '0]'
       ), 256),
       SHA2(CONCAT(
         '["agent-service/legal-hold-control/v1",',
         JSON_QUOTE(controls.tenant_id), ',', JSON_QUOTE(controls.subject_kind), ',',
         JSON_QUOTE(controls.subject_id), ',', CAST(controls.control_generation AS CHAR), ',',
         CAST(controls.active_hold_count AS CHAR), ',',
         JSON_QUOTE(controls.active_projection_sha256), ',',
         CAST(controls.updated_at_ms AS CHAR), ']'
       ), 256),
       controls.updated_at_ms
  FROM subject_lifecycle lifecycle
  JOIN legal_holds hold_row
    ON hold_row.tenant_id = lifecycle.tenant_id
   AND hold_row.hold_id = CONCAT('hold_legacy_', LEFT(SHA2(CONCAT(
        '["agent-service/legal-hold-legacy/v1",',
        JSON_QUOTE(lifecycle.tenant_id), ',', JSON_QUOTE(lifecycle.subject_kind), ',',
        JSON_QUOTE(lifecycle.subject_id), ',', CAST(lifecycle.legal_hold_at_ms AS CHAR), ']'
      ), 256), 48))
  JOIN legal_hold_controls controls
    ON controls.tenant_id = lifecycle.tenant_id
   AND controls.subject_kind = lifecycle.subject_kind
   AND controls.subject_id = lifecycle.subject_id
 WHERE lifecycle.legal_hold_at_ms IS NOT NULL
   AND controls.control_generation = 1
   AND controls.active_hold_count = 1
   AND NOT EXISTS (
     SELECT 1 FROM legal_hold_events event_row
      WHERE event_row.tenant_id = lifecycle.tenant_id
        AND event_row.subject_kind = lifecycle.subject_kind
        AND event_row.subject_id = lifecycle.subject_id
        AND event_row.control_generation = 1
        AND event_row.hold_id = hold_row.hold_id
        AND event_row.event_type = 'legal_hold/set'
        AND event_row.reason_code = 'legacy_unattributed'
        AND event_row.external_reference_sha256 IS NULL
        AND event_row.actor_key_id = 'migration-0015'
        AND event_row.before_sha256 = SHA2(CONCAT(
          '["agent-service/legal-hold-control/v1",',
          JSON_QUOTE(lifecycle.tenant_id), ',', JSON_QUOTE(lifecycle.subject_kind), ',',
          JSON_QUOTE(lifecycle.subject_id), ',0,0,',
          JSON_QUOTE(@empty_legal_hold_projection_sha256), ',',
          '0]'
        ), 256)
        AND event_row.after_sha256 = SHA2(CONCAT(
          '["agent-service/legal-hold-control/v1",',
          JSON_QUOTE(controls.tenant_id), ',', JSON_QUOTE(controls.subject_kind), ',',
          JSON_QUOTE(controls.subject_id), ',', CAST(controls.control_generation AS CHAR), ',',
          CAST(controls.active_hold_count AS CHAR), ',',
          JSON_QUOTE(controls.active_projection_sha256), ',',
          CAST(controls.updated_at_ms AS CHAR), ']'
        ), 256)
        AND event_row.emitted_at_ms = controls.updated_at_ms
   );

-- Force an explicit duplicate-key failure if any legacy shadow lacks its exact immutable hold/event
-- proof. This final assertion is itself replay-safe: a complete source produces zero rows. It avoids
-- an INSERT IGNORE that could otherwise turn a conflicting same-key record into a false success.
INSERT INTO legal_holds
  (tenant_id, hold_id, subject_kind, subject_id, state, reason_code,
   external_reference_sha256, created_control_generation, created_by_key_id, created_at_ms,
   released_control_generation, released_by_key_id, released_at_ms, release_reason_code)
SELECT lifecycle.tenant_id, hold_row.hold_id, lifecycle.subject_kind, lifecycle.subject_id,
       'active', 'legacy_unattributed', NULL, 1, 'migration-0015', lifecycle.legal_hold_at_ms,
       NULL, NULL, NULL, NULL
  FROM subject_lifecycle lifecycle
  JOIN legal_holds hold_row
    ON hold_row.tenant_id = lifecycle.tenant_id
   AND hold_row.hold_id = CONCAT('hold_legacy_', LEFT(SHA2(CONCAT(
        '["agent-service/legal-hold-legacy/v1",',
        JSON_QUOTE(lifecycle.tenant_id), ',', JSON_QUOTE(lifecycle.subject_kind), ',',
        JSON_QUOTE(lifecycle.subject_id), ',', CAST(lifecycle.legal_hold_at_ms AS CHAR), ']'
      ), 256), 48))
 WHERE lifecycle.legal_hold_at_ms IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
       FROM legal_hold_controls controls
       JOIN legal_hold_events event_row
         ON event_row.tenant_id = controls.tenant_id
        AND event_row.subject_kind = controls.subject_kind
        AND event_row.subject_id = controls.subject_id
        AND event_row.control_generation = 1
      WHERE controls.tenant_id = lifecycle.tenant_id
        AND controls.subject_kind = lifecycle.subject_kind
        AND controls.subject_id = lifecycle.subject_id
        AND controls.control_generation >= 1
        AND event_row.hold_id = hold_row.hold_id
        AND event_row.event_type = 'legal_hold/set'
        AND event_row.reason_code = 'legacy_unattributed'
        AND event_row.external_reference_sha256 IS NULL
        AND event_row.actor_key_id = 'migration-0015'
   );

-- Bind every newly admitted erasure request to the tenant policy observed at the same linearization
-- point as activation. A pre-0015 writer may still insert a NULL/NULL pair while the control is
-- absent or dormant; once activation commits, the exact active immutable identity is mandatory.
-- This is deliberately INSERT-only: activation must not strand or rewrite an older NULL backlog.
-- Three permanent guards plus a bootstrap guard make marker-loss replay safe while old writers are
-- still connected. Each guard takes a shared lock on the same tenant control activation locks for
-- update, so either the legacy insert commits first or it observes the newly active policy.

DROP TRIGGER IF EXISTS trg_erasure_requests_policy_bi_bootstrap;
CREATE TRIGGER trg_erasure_requests_policy_bi_bootstrap BEFORE INSERT ON erasure_requests FOR EACH ROW BEGIN DECLARE policy_generation BIGINT UNSIGNED DEFAULT NULL; DECLARE active_version VARCHAR(64) DEFAULT NULL; DECLARE active_hash CHAR(64) DEFAULT NULL; DECLARE active_effective_at BIGINT DEFAULT NULL; DECLARE control_found BOOLEAN DEFAULT TRUE; DECLARE CONTINUE HANDLER FOR NOT FOUND SET control_found = FALSE; SELECT control_generation, active_policy_version, active_policy_sha256, effective_at_ms INTO policy_generation, active_version, active_hash, active_effective_at FROM retention_policy_controls WHERE tenant_id = NEW.tenant_id FOR SHARE; IF NOT control_found THEN IF NEW.policy_version IS NOT NULL OR NEW.policy_hash IS NOT NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure request policy binding rejected'; END IF; ELSEIF policy_generation = 0 THEN IF active_version IS NOT NULL OR active_hash IS NOT NULL OR active_effective_at IS NOT NULL OR NEW.policy_version IS NOT NULL OR NEW.policy_hash IS NOT NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure request policy binding rejected'; END IF; ELSEIF active_version IS NULL OR active_hash IS NULL OR active_effective_at IS NULL OR BINARY active_hash NOT REGEXP BINARY '^[0-9a-f]{64}$' OR NEW.policy_version IS NULL OR NEW.policy_hash IS NULL OR NOT (BINARY NEW.policy_version <=> BINARY active_version) OR NOT (BINARY NEW.policy_hash <=> BINARY active_hash) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure request policy binding rejected'; END IF; END;
DROP TRIGGER IF EXISTS trg_erasure_requests_policy_bi;
CREATE TRIGGER trg_erasure_requests_policy_bi BEFORE INSERT ON erasure_requests FOR EACH ROW BEGIN DECLARE policy_generation BIGINT UNSIGNED DEFAULT NULL; DECLARE active_version VARCHAR(64) DEFAULT NULL; DECLARE active_hash CHAR(64) DEFAULT NULL; DECLARE active_effective_at BIGINT DEFAULT NULL; DECLARE control_found BOOLEAN DEFAULT TRUE; DECLARE CONTINUE HANDLER FOR NOT FOUND SET control_found = FALSE; SELECT control_generation, active_policy_version, active_policy_sha256, effective_at_ms INTO policy_generation, active_version, active_hash, active_effective_at FROM retention_policy_controls WHERE tenant_id = NEW.tenant_id FOR SHARE; IF NOT control_found THEN IF NEW.policy_version IS NOT NULL OR NEW.policy_hash IS NOT NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure request policy binding rejected'; END IF; ELSEIF policy_generation = 0 THEN IF active_version IS NOT NULL OR active_hash IS NOT NULL OR active_effective_at IS NOT NULL OR NEW.policy_version IS NOT NULL OR NEW.policy_hash IS NOT NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure request policy binding rejected'; END IF; ELSEIF active_version IS NULL OR active_hash IS NULL OR active_effective_at IS NULL OR BINARY active_hash NOT REGEXP BINARY '^[0-9a-f]{64}$' OR NEW.policy_version IS NULL OR NEW.policy_hash IS NULL OR NOT (BINARY NEW.policy_version <=> BINARY active_version) OR NOT (BINARY NEW.policy_hash <=> BINARY active_hash) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure request policy binding rejected'; END IF; END;
DROP TRIGGER IF EXISTS trg_erasure_requests_policy_bi_guard_a;
CREATE TRIGGER trg_erasure_requests_policy_bi_guard_a BEFORE INSERT ON erasure_requests FOR EACH ROW BEGIN DECLARE policy_generation BIGINT UNSIGNED DEFAULT NULL; DECLARE active_version VARCHAR(64) DEFAULT NULL; DECLARE active_hash CHAR(64) DEFAULT NULL; DECLARE active_effective_at BIGINT DEFAULT NULL; DECLARE control_found BOOLEAN DEFAULT TRUE; DECLARE CONTINUE HANDLER FOR NOT FOUND SET control_found = FALSE; SELECT control_generation, active_policy_version, active_policy_sha256, effective_at_ms INTO policy_generation, active_version, active_hash, active_effective_at FROM retention_policy_controls WHERE tenant_id = NEW.tenant_id FOR SHARE; IF NOT control_found THEN IF NEW.policy_version IS NOT NULL OR NEW.policy_hash IS NOT NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure request policy binding rejected'; END IF; ELSEIF policy_generation = 0 THEN IF active_version IS NOT NULL OR active_hash IS NOT NULL OR active_effective_at IS NOT NULL OR NEW.policy_version IS NOT NULL OR NEW.policy_hash IS NOT NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure request policy binding rejected'; END IF; ELSEIF active_version IS NULL OR active_hash IS NULL OR active_effective_at IS NULL OR BINARY active_hash NOT REGEXP BINARY '^[0-9a-f]{64}$' OR NEW.policy_version IS NULL OR NEW.policy_hash IS NULL OR NOT (BINARY NEW.policy_version <=> BINARY active_version) OR NOT (BINARY NEW.policy_hash <=> BINARY active_hash) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure request policy binding rejected'; END IF; END;
DROP TRIGGER IF EXISTS trg_erasure_requests_policy_bi_guard_b;
CREATE TRIGGER trg_erasure_requests_policy_bi_guard_b BEFORE INSERT ON erasure_requests FOR EACH ROW BEGIN DECLARE policy_generation BIGINT UNSIGNED DEFAULT NULL; DECLARE active_version VARCHAR(64) DEFAULT NULL; DECLARE active_hash CHAR(64) DEFAULT NULL; DECLARE active_effective_at BIGINT DEFAULT NULL; DECLARE control_found BOOLEAN DEFAULT TRUE; DECLARE CONTINUE HANDLER FOR NOT FOUND SET control_found = FALSE; SELECT control_generation, active_policy_version, active_policy_sha256, effective_at_ms INTO policy_generation, active_version, active_hash, active_effective_at FROM retention_policy_controls WHERE tenant_id = NEW.tenant_id FOR SHARE; IF NOT control_found THEN IF NEW.policy_version IS NOT NULL OR NEW.policy_hash IS NOT NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure request policy binding rejected'; END IF; ELSEIF policy_generation = 0 THEN IF active_version IS NOT NULL OR active_hash IS NOT NULL OR active_effective_at IS NOT NULL OR NEW.policy_version IS NOT NULL OR NEW.policy_hash IS NOT NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure request policy binding rejected'; END IF; ELSEIF active_version IS NULL OR active_hash IS NULL OR active_effective_at IS NULL OR BINARY active_hash NOT REGEXP BINARY '^[0-9a-f]{64}$' OR NEW.policy_version IS NULL OR NEW.policy_hash IS NULL OR NOT (BINARY NEW.policy_version <=> BINARY active_version) OR NOT (BINARY NEW.policy_hash <=> BINARY active_hash) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'erasure request policy binding rejected'; END IF; END;
DROP TRIGGER IF EXISTS trg_erasure_requests_policy_bi_bootstrap;

-- Immutable policy definitions and audit events use the same redundant guard rotation as 0013 and
-- 0014. A bootstrap guard is installed before any permanent guard is replaced; after the migration
-- has completed once, interruption at any later statement always leaves at least one guard active.

DROP TRIGGER IF EXISTS trg_retention_policy_versions_bu_bootstrap;
CREATE TRIGGER trg_retention_policy_versions_bu_bootstrap BEFORE UPDATE ON retention_policy_versions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'retention policy versions are append-only';
DROP TRIGGER IF EXISTS trg_retention_policy_versions_bu;
CREATE TRIGGER trg_retention_policy_versions_bu BEFORE UPDATE ON retention_policy_versions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'retention policy versions are append-only';
DROP TRIGGER IF EXISTS trg_retention_policy_versions_bu_guard_a;
CREATE TRIGGER trg_retention_policy_versions_bu_guard_a BEFORE UPDATE ON retention_policy_versions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'retention policy versions are append-only';
DROP TRIGGER IF EXISTS trg_retention_policy_versions_bu_guard_b;
CREATE TRIGGER trg_retention_policy_versions_bu_guard_b BEFORE UPDATE ON retention_policy_versions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'retention policy versions are append-only';
DROP TRIGGER IF EXISTS trg_retention_policy_versions_bu_bootstrap;

DROP TRIGGER IF EXISTS trg_retention_policy_versions_bd_bootstrap;
CREATE TRIGGER trg_retention_policy_versions_bd_bootstrap BEFORE DELETE ON retention_policy_versions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'retention policy versions are append-only';
DROP TRIGGER IF EXISTS trg_retention_policy_versions_bd;
CREATE TRIGGER trg_retention_policy_versions_bd BEFORE DELETE ON retention_policy_versions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'retention policy versions are append-only';
DROP TRIGGER IF EXISTS trg_retention_policy_versions_bd_guard_a;
CREATE TRIGGER trg_retention_policy_versions_bd_guard_a BEFORE DELETE ON retention_policy_versions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'retention policy versions are append-only';
DROP TRIGGER IF EXISTS trg_retention_policy_versions_bd_guard_b;
CREATE TRIGGER trg_retention_policy_versions_bd_guard_b BEFORE DELETE ON retention_policy_versions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'retention policy versions are append-only';
DROP TRIGGER IF EXISTS trg_retention_policy_versions_bd_bootstrap;

DROP TRIGGER IF EXISTS trg_retention_policy_activation_events_bu_bootstrap;
CREATE TRIGGER trg_retention_policy_activation_events_bu_bootstrap BEFORE UPDATE ON retention_policy_activation_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'retention policy activation events are append-only';
DROP TRIGGER IF EXISTS trg_retention_policy_activation_events_bu;
CREATE TRIGGER trg_retention_policy_activation_events_bu BEFORE UPDATE ON retention_policy_activation_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'retention policy activation events are append-only';
DROP TRIGGER IF EXISTS trg_retention_policy_activation_events_bu_guard_a;
CREATE TRIGGER trg_retention_policy_activation_events_bu_guard_a BEFORE UPDATE ON retention_policy_activation_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'retention policy activation events are append-only';
DROP TRIGGER IF EXISTS trg_retention_policy_activation_events_bu_guard_b;
CREATE TRIGGER trg_retention_policy_activation_events_bu_guard_b BEFORE UPDATE ON retention_policy_activation_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'retention policy activation events are append-only';
DROP TRIGGER IF EXISTS trg_retention_policy_activation_events_bu_bootstrap;

DROP TRIGGER IF EXISTS trg_retention_policy_activation_events_bd_bootstrap;
CREATE TRIGGER trg_retention_policy_activation_events_bd_bootstrap BEFORE DELETE ON retention_policy_activation_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'retention policy activation events are append-only';
DROP TRIGGER IF EXISTS trg_retention_policy_activation_events_bd;
CREATE TRIGGER trg_retention_policy_activation_events_bd BEFORE DELETE ON retention_policy_activation_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'retention policy activation events are append-only';
DROP TRIGGER IF EXISTS trg_retention_policy_activation_events_bd_guard_a;
CREATE TRIGGER trg_retention_policy_activation_events_bd_guard_a BEFORE DELETE ON retention_policy_activation_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'retention policy activation events are append-only';
DROP TRIGGER IF EXISTS trg_retention_policy_activation_events_bd_guard_b;
CREATE TRIGGER trg_retention_policy_activation_events_bd_guard_b BEFORE DELETE ON retention_policy_activation_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'retention policy activation events are append-only';
DROP TRIGGER IF EXISTS trg_retention_policy_activation_events_bd_bootstrap;

DROP TRIGGER IF EXISTS trg_legal_hold_events_bu_bootstrap;
CREATE TRIGGER trg_legal_hold_events_bu_bootstrap BEFORE UPDATE ON legal_hold_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legal hold events are append-only';
DROP TRIGGER IF EXISTS trg_legal_hold_events_bu;
CREATE TRIGGER trg_legal_hold_events_bu BEFORE UPDATE ON legal_hold_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legal hold events are append-only';
DROP TRIGGER IF EXISTS trg_legal_hold_events_bu_guard_a;
CREATE TRIGGER trg_legal_hold_events_bu_guard_a BEFORE UPDATE ON legal_hold_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legal hold events are append-only';
DROP TRIGGER IF EXISTS trg_legal_hold_events_bu_guard_b;
CREATE TRIGGER trg_legal_hold_events_bu_guard_b BEFORE UPDATE ON legal_hold_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legal hold events are append-only';
DROP TRIGGER IF EXISTS trg_legal_hold_events_bu_bootstrap;

DROP TRIGGER IF EXISTS trg_legal_hold_events_bd_bootstrap;
CREATE TRIGGER trg_legal_hold_events_bd_bootstrap BEFORE DELETE ON legal_hold_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legal hold events are append-only';
DROP TRIGGER IF EXISTS trg_legal_hold_events_bd;
CREATE TRIGGER trg_legal_hold_events_bd BEFORE DELETE ON legal_hold_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legal hold events are append-only';
DROP TRIGGER IF EXISTS trg_legal_hold_events_bd_guard_a;
CREATE TRIGGER trg_legal_hold_events_bd_guard_a BEFORE DELETE ON legal_hold_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legal hold events are append-only';
DROP TRIGGER IF EXISTS trg_legal_hold_events_bd_guard_b;
CREATE TRIGGER trg_legal_hold_events_bd_guard_b BEFORE DELETE ON legal_hold_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legal hold events are append-only';
DROP TRIGGER IF EXISTS trg_legal_hold_events_bd_bootstrap;

-- A legal-hold row is immutable except for its one-way active -> released settlement. Three
-- equivalent guards plus a bootstrap guard make this restriction replay-safe as well.
DROP TRIGGER IF EXISTS trg_legal_holds_bu_bootstrap;
CREATE TRIGGER trg_legal_holds_bu_bootstrap BEFORE UPDATE ON legal_holds FOR EACH ROW BEGIN IF NOT (OLD.tenant_id <=> NEW.tenant_id AND OLD.hold_id <=> NEW.hold_id AND OLD.subject_kind <=> NEW.subject_kind AND OLD.subject_id <=> NEW.subject_id AND OLD.reason_code <=> NEW.reason_code AND OLD.external_reference_sha256 <=> NEW.external_reference_sha256 AND OLD.created_control_generation <=> NEW.created_control_generation AND OLD.created_by_key_id <=> NEW.created_by_key_id AND OLD.created_at_ms <=> NEW.created_at_ms AND OLD.state = 'active' AND NEW.state = 'released' AND OLD.released_control_generation IS NULL AND OLD.released_by_key_id IS NULL AND OLD.released_at_ms IS NULL AND OLD.release_reason_code IS NULL AND NEW.released_control_generation IS NOT NULL AND NEW.released_control_generation > OLD.created_control_generation AND NEW.released_by_key_id IS NOT NULL AND NEW.released_at_ms IS NOT NULL AND NEW.released_at_ms >= OLD.created_at_ms AND NEW.release_reason_code IS NOT NULL) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legal hold update is not an active-to-released settlement'; END IF; END;
DROP TRIGGER IF EXISTS trg_legal_holds_bu;
CREATE TRIGGER trg_legal_holds_bu BEFORE UPDATE ON legal_holds FOR EACH ROW BEGIN IF NOT (OLD.tenant_id <=> NEW.tenant_id AND OLD.hold_id <=> NEW.hold_id AND OLD.subject_kind <=> NEW.subject_kind AND OLD.subject_id <=> NEW.subject_id AND OLD.reason_code <=> NEW.reason_code AND OLD.external_reference_sha256 <=> NEW.external_reference_sha256 AND OLD.created_control_generation <=> NEW.created_control_generation AND OLD.created_by_key_id <=> NEW.created_by_key_id AND OLD.created_at_ms <=> NEW.created_at_ms AND OLD.state = 'active' AND NEW.state = 'released' AND OLD.released_control_generation IS NULL AND OLD.released_by_key_id IS NULL AND OLD.released_at_ms IS NULL AND OLD.release_reason_code IS NULL AND NEW.released_control_generation IS NOT NULL AND NEW.released_control_generation > OLD.created_control_generation AND NEW.released_by_key_id IS NOT NULL AND NEW.released_at_ms IS NOT NULL AND NEW.released_at_ms >= OLD.created_at_ms AND NEW.release_reason_code IS NOT NULL) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legal hold update is not an active-to-released settlement'; END IF; END;
DROP TRIGGER IF EXISTS trg_legal_holds_bu_guard_a;
CREATE TRIGGER trg_legal_holds_bu_guard_a BEFORE UPDATE ON legal_holds FOR EACH ROW BEGIN IF NOT (OLD.tenant_id <=> NEW.tenant_id AND OLD.hold_id <=> NEW.hold_id AND OLD.subject_kind <=> NEW.subject_kind AND OLD.subject_id <=> NEW.subject_id AND OLD.reason_code <=> NEW.reason_code AND OLD.external_reference_sha256 <=> NEW.external_reference_sha256 AND OLD.created_control_generation <=> NEW.created_control_generation AND OLD.created_by_key_id <=> NEW.created_by_key_id AND OLD.created_at_ms <=> NEW.created_at_ms AND OLD.state = 'active' AND NEW.state = 'released' AND OLD.released_control_generation IS NULL AND OLD.released_by_key_id IS NULL AND OLD.released_at_ms IS NULL AND OLD.release_reason_code IS NULL AND NEW.released_control_generation IS NOT NULL AND NEW.released_control_generation > OLD.created_control_generation AND NEW.released_by_key_id IS NOT NULL AND NEW.released_at_ms IS NOT NULL AND NEW.released_at_ms >= OLD.created_at_ms AND NEW.release_reason_code IS NOT NULL) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legal hold update is not an active-to-released settlement'; END IF; END;
DROP TRIGGER IF EXISTS trg_legal_holds_bu_guard_b;
CREATE TRIGGER trg_legal_holds_bu_guard_b BEFORE UPDATE ON legal_holds FOR EACH ROW BEGIN IF NOT (OLD.tenant_id <=> NEW.tenant_id AND OLD.hold_id <=> NEW.hold_id AND OLD.subject_kind <=> NEW.subject_kind AND OLD.subject_id <=> NEW.subject_id AND OLD.reason_code <=> NEW.reason_code AND OLD.external_reference_sha256 <=> NEW.external_reference_sha256 AND OLD.created_control_generation <=> NEW.created_control_generation AND OLD.created_by_key_id <=> NEW.created_by_key_id AND OLD.created_at_ms <=> NEW.created_at_ms AND OLD.state = 'active' AND NEW.state = 'released' AND OLD.released_control_generation IS NULL AND OLD.released_by_key_id IS NULL AND OLD.released_at_ms IS NULL AND OLD.release_reason_code IS NULL AND NEW.released_control_generation IS NOT NULL AND NEW.released_control_generation > OLD.created_control_generation AND NEW.released_by_key_id IS NOT NULL AND NEW.released_at_ms IS NOT NULL AND NEW.released_at_ms >= OLD.created_at_ms AND NEW.release_reason_code IS NOT NULL) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legal hold update is not an active-to-released settlement'; END IF; END;
DROP TRIGGER IF EXISTS trg_legal_holds_bu_bootstrap;

DROP TRIGGER IF EXISTS trg_legal_holds_bd_bootstrap;
CREATE TRIGGER trg_legal_holds_bd_bootstrap BEFORE DELETE ON legal_holds FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legal holds cannot be deleted';
DROP TRIGGER IF EXISTS trg_legal_holds_bd;
CREATE TRIGGER trg_legal_holds_bd BEFORE DELETE ON legal_holds FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legal holds cannot be deleted';
DROP TRIGGER IF EXISTS trg_legal_holds_bd_guard_a;
CREATE TRIGGER trg_legal_holds_bd_guard_a BEFORE DELETE ON legal_holds FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legal holds cannot be deleted';
DROP TRIGGER IF EXISTS trg_legal_holds_bd_guard_b;
CREATE TRIGGER trg_legal_holds_bd_guard_b BEFORE DELETE ON legal_holds FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'legal holds cannot be deleted';
DROP TRIGGER IF EXISTS trg_legal_holds_bd_bootstrap;
