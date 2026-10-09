-- Historical MySQL preservation fixture frozen at migration 0018.
--
-- This deliberately small but real preset database isolates the 0018 -> 0019 compatibility
-- boundary. Credential-bearing rows and an already-admitted tenant prove that the expand-only
-- migration neither performs physical erasure nor silently grants the dormant admission worker
-- authority. Do not regenerate this fixture from live migrations during a test.

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
  ('0015_retention_policy_and_legal_holds.sql', 15),
  ('0016_erasure_purge_policy_authority.sql', 16),
  ('0017_user_export_jobs_and_artifacts.sql', 17),
  ('0018_tenant_credential_revocation_fence.sql', 18);

CREATE TABLE tenants (
  tenant_id             VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  name                  VARCHAR(256) NULL,
  created_at_ms         BIGINT NOT NULL,
  auth_policy           JSON NULL,
  auth_secret_cipher    VARBINARY(8192) NULL,
  auth_secret_key_id    VARCHAR(128) COLLATE utf8mb4_0900_as_cs NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE api_keys (
  key_hash      CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  key_id        VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  tenant_id     VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  created_at_ms BIGINT NOT NULL,
  revoked_at_ms BIGINT NULL,
  scopes        JSON NULL,
  KEY idx_api_keys_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE provider_configs (
  tenant_id       VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  provider_id     VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  config          JSON NOT NULL,
  secret_cipher   VARBINARY(8192) NULL,
  secret_key_id   VARCHAR(128) COLLATE utf8mb4_0900_as_cs NULL,
  created_at_ms   BIGINT NOT NULL,
  updated_at_ms   BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, provider_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE tenant_erasure_admissions (
  request_id             VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  tenant_id              VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation     BIGINT UNSIGNED NOT NULL,
  requested_by_key_id    VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  idempotency_key        VARCHAR(256) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_hash           CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  created_at_ms          BIGINT NOT NULL,
  gated_at_ms            BIGINT NOT NULL,
  updated_at_ms          BIGINT NOT NULL,
  policy_version         VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NULL,
  policy_hash            CHAR(64)     COLLATE utf8mb4_0900_as_cs NULL,
  control_generation     BIGINT UNSIGNED NOT NULL DEFAULT 0,
  UNIQUE KEY uk_tenant_erasure_admissions_tenant (tenant_id),
  UNIQUE KEY uk_tenant_erasure_admissions_tenant_generation
    (tenant_id, subject_generation),
  UNIQUE KEY uk_tenant_erasure_admissions_idempotency
    (tenant_id, idempotency_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE tenant_credential_revocation_fences (
  tenant_id          VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  request_id         VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL,
  subject_generation BIGINT UNSIGNED NOT NULL,
  fenced_at_ms       BIGINT NOT NULL,
  evidence_sha256    CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL,
  UNIQUE KEY uk_tenant_credential_fences_request (request_id),
  UNIQUE KEY uk_tenant_credential_fences_generation (tenant_id, subject_generation)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_tenant_erasure_admissions_bu
BEFORE UPDATE ON tenant_erasure_admissions
FOR EACH ROW SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'tenant erasure admission is append-only';
CREATE TRIGGER trg_tenant_erasure_admissions_bu_guard_a
BEFORE UPDATE ON tenant_erasure_admissions
FOR EACH ROW SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'tenant erasure admission is append-only';
CREATE TRIGGER trg_tenant_erasure_admissions_bu_guard_b
BEFORE UPDATE ON tenant_erasure_admissions
FOR EACH ROW SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'tenant erasure admission is append-only';
CREATE TRIGGER trg_tenant_erasure_admissions_bd
BEFORE DELETE ON tenant_erasure_admissions
FOR EACH ROW SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'tenant erasure admission is append-only';
CREATE TRIGGER trg_tenant_erasure_admissions_bd_guard_a
BEFORE DELETE ON tenant_erasure_admissions
FOR EACH ROW SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'tenant erasure admission is append-only';
CREATE TRIGGER trg_tenant_erasure_admissions_bd_guard_b
BEFORE DELETE ON tenant_erasure_admissions
FOR EACH ROW SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'tenant erasure admission is append-only';

CREATE TRIGGER trg_tenant_credential_fences_bu
BEFORE UPDATE ON tenant_credential_revocation_fences
FOR EACH ROW SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'tenant credential revocation fence is append-only';
CREATE TRIGGER trg_tenant_credential_fences_bu_guard_a
BEFORE UPDATE ON tenant_credential_revocation_fences
FOR EACH ROW SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'tenant credential revocation fence is append-only';
CREATE TRIGGER trg_tenant_credential_fences_bu_guard_b
BEFORE UPDATE ON tenant_credential_revocation_fences
FOR EACH ROW SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'tenant credential revocation fence is append-only';
CREATE TRIGGER trg_tenant_credential_fences_bd
BEFORE DELETE ON tenant_credential_revocation_fences
FOR EACH ROW SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'tenant credential revocation fence is append-only';
CREATE TRIGGER trg_tenant_credential_fences_bd_guard_a
BEFORE DELETE ON tenant_credential_revocation_fences
FOR EACH ROW SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'tenant credential revocation fence is append-only';
CREATE TRIGGER trg_tenant_credential_fences_bd_guard_b
BEFORE DELETE ON tenant_credential_revocation_fences
FOR EACH ROW SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT = 'tenant credential revocation fence is append-only';

INSERT INTO tenants
  (tenant_id, name, created_at_ms, auth_policy, auth_secret_cipher, auth_secret_key_id)
VALUES
  ('tenant_preserved', 'historical tenant with credentials', 10,
   '{"mode":"end_user_token","tokenHeader":"X-End-User-Token","verifier":{"kind":"jwt","algorithms":["HS256"],"subjectClaim":"sub","clockToleranceSec":0,"hs256":true}}',
   UNHEX('0102030405060708'), 'fixture-auth-key-0018'),
  ('tenant_neighbor', 'unrelated historical tenant', 11,
   '{"mode":"trusted_caller"}', NULL, NULL);

INSERT INTO api_keys
  (key_hash, key_id, tenant_id, created_at_ms, revoked_at_ms, scopes)
VALUES
  (REPEAT('1',64), 'active_preserved', 'tenant_preserved', 20, NULL,
   JSON_ARRAY('runtime','admin')),
  (REPEAT('2',64), 'revoked_preserved', 'tenant_preserved', 21, 22,
   JSON_ARRAY('runtime')),
  (REPEAT('3',64), 'neighbor_key', 'tenant_neighbor', 23, NULL,
   JSON_ARRAY('admin'));

INSERT INTO provider_configs
  (tenant_id, provider_id, config, secret_cipher, secret_key_id, created_at_ms, updated_at_ms)
VALUES
  ('tenant_preserved', 'provider_preserved',
   '{"baseUrl":"https://fixture.invalid","headers":{"X-Fixture":"preserved"}}',
   UNHEX('1112131415161718'), 'fixture-provider-key-0018', 30, 31),
  ('tenant_neighbor', 'provider_neighbor',
   '{"baseUrl":"https://neighbor.invalid","headers":{}}', NULL, NULL, 32, 33);

INSERT INTO tenant_erasure_admissions
  (request_id, tenant_id, subject_generation, requested_by_key_id, idempotency_key,
   request_hash, created_at_ms, gated_at_ms, updated_at_ms, policy_version, policy_hash,
   control_generation)
VALUES
  ('erase_00000000-0000-4000-8000-000000000018', 'tenant_preserved', 1,
   'platform-lifecycle-admin', 'fixture-tenant-erasure-0018', REPEAT('a',64),
   1000, 1000, 1000, 'policy-v1', REPEAT('b',64), 0);

INSERT INTO tenant_credential_revocation_fences
  (tenant_id, request_id, subject_generation, fenced_at_ms, evidence_sha256)
VALUES
  ('tenant_preserved', 'erase_00000000-0000-4000-8000-000000000018', 1, 1000,
   REPEAT('c',64));
