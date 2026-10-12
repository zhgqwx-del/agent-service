-- 0037: default-dormant grant guard rotation. 0036 is immutable after publication.
-- The published 0036 guard compares raw SHA2(claim_token) with a TypeScript domain-separated
-- claim hash. Install this exact replacement BEFORE dropping the old trigger: a MySQL DDL
-- auto-commit or process crash can temporarily leave both guards, but never a guard-free slot.
-- A valid hash is deliberately insufficient to issue a grant. Current T3d logs/traces entries
-- are zero-target blockers, and the full owner/source/hold/restore proof is not yet implemented.
-- A future immutable migration must explicitly replace this fail-closed trigger before any
-- production grant, journal authorization, or physical mutation is permitted.
CREATE TRIGGER trg_tt_disposition_grant_bi_v2 BEFORE INSERT ON tenant_telemetry_disposition_authorization_grants FOR EACH ROW BEGIN IF NOT EXISTS (SELECT 1 FROM tenant_telemetry_disposition_jobs j WHERE BINARY j.disposition_operation_sha256=BINARY NEW.disposition_operation_sha256 AND BINARY j.tenant_id=BINARY NEW.tenant_id AND j.phase='queued' AND j.claim_token REGEXP '^[A-Za-z0-9._:~-]{1,128}$' AND BINARY SHA2(CONCAT('["tenant-telemetry-disposition-claim-token-v1","',j.claim_token,'"]'),256)=BINARY NEW.claim_token_sha256 AND j.lease_until_db_ms>CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED) AND NEW.granted_at_db_ms>=j.updated_at_db_ms AND NEW.lease_until_db_ms<=j.lease_until_db_ms) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry disposition grant lacks exact live claim'; END IF; SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tenant telemetry disposition grant issuance is dormant'; END;
DROP TRIGGER IF EXISTS trg_tt_disposition_grant_bi;

SET @tt_grant_guard_previous_group_concat_max_len=@@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len=1048576;
-- agent-service-runtime-fingerprint:tenant-telemetry-grant-guard-triggers:start
SET @tt_grant_guard_triggers_ok=(
  SELECT COUNT(*)=83 AND COUNT(DISTINCT trigger_name)=83
     AND SHA2(GROUP_CONCAT(CONCAT_WS('~',event_object_table,trigger_name,
           action_timing,event_manipulation,action_orientation,
           IFNULL(action_condition,'<NULL>'),
           LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),
             CHAR(96),''),'_utf8mb4','')))
         ORDER BY event_object_table,trigger_name SEPARATOR '|'),256)=
       '6e2127412318d779b70db25e0024345e101ad9f20dffcf0652a2d65901f7a45c'
    FROM information_schema.triggers
   WHERE trigger_schema=DATABASE()
     AND (event_object_table IN (
       'sessions','subject_lifecycle','tenant_telemetry_lifecycle_control',
       'tenant_telemetry_lifecycle_targets','tenant_telemetry_lifecycle_coverages',
       'tenant_telemetry_lifecycle_subjects','tenant_telemetry_activation_receipts',
       'tenant_telemetry_artifact_inventory','tenant_telemetry_write_jobs',
       'tenant_telemetry_write_payloads','tenant_telemetry_write_acks',
       'tenant_telemetry_application_domain_controls',
       'tenant_telemetry_application_activation_receipts',
       'tenant_telemetry_application_coverages',
       'tenant_telemetry_application_write_bindings',
       'tenant_telemetry_disposition_control',
       'tenant_telemetry_disposition_activation_receipts',
       'tenant_telemetry_disposition_jobs',
       'tenant_telemetry_disposition_authorization_grants',
       'tenant_telemetry_disposition_external_authorizations',
       'tenant_telemetry_disposition_external_events',
       'tenant_telemetry_disposition_tombstone_acks',
       'tenant_telemetry_disposition_receipts',
       'tenant_telemetry_disposition_replay_fences') OR
       (event_object_table='tenant_credential_revocation_jobs'
         AND action_timing='BEFORE' AND event_manipulation='INSERT'))
);
-- agent-service-runtime-fingerprint:tenant-telemetry-grant-guard-triggers:end
SET @migration_sql=IF(@tt_grant_guard_triggers_ok=1,'SELECT 1',
  'SELECT 1 FROM __invalid_tenant_telemetry_grant_guard_triggers__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
SET SESSION group_concat_max_len=@tt_grant_guard_previous_group_concat_max_len;

-- Historical/marker-loss replay must not convert a dormant substrate into execution authority.
SET @tt_grant_guard_projection_ok=(
  (SELECT COUNT(*) FROM tenant_telemetry_disposition_jobs)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_authorization_grants)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_external_authorizations)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_external_events)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_tombstone_acks)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_receipts)=0
  AND (SELECT COUNT(*) FROM tenant_telemetry_disposition_replay_fences)=0
);
SET @migration_sql=IF(@tt_grant_guard_projection_ok=1,'SELECT 1',
  'SELECT 1 FROM __invalid_tenant_telemetry_grant_guard_projection__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
