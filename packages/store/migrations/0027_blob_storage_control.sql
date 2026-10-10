-- Default-dormant, write-once Blob storage namespace cutover.
--
-- The singleton is deliberately seeded at generation 0. Applying this migration neither chooses a
-- backend nor moves bytes. Activation is allowed only when every live Blob/export manifest and
-- every uncompleted physical-delete intent already names the requested backend (dead-letter is not
-- physical completion). Once active, locking
-- INSERT/UPDATE guards make an old writer observe the current generation even from a stale
-- REPEATABLE READ transaction and reject cross-namespace manifests.
--
-- DDL auto-commits before schema_migrations is recorded. Three equivalent trigger generations are
-- retained; replay replaces one at a time so an already-running old writer is never left without a
-- guard after any individual DDL boundary.

CREATE TABLE IF NOT EXISTS blob_storage_control (
  singleton_id         TINYINT UNSIGNED NOT NULL,
  control_generation   BIGINT UNSIGNED NOT NULL DEFAULT 0,
  storage_backend      VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL,
  namespace_sha256     CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  activated_at_db_ms   BIGINT NULL,
  evidence_sha256      CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  PRIMARY KEY (singleton_id),
  CONSTRAINT chk_blob_storage_control_singleton CHECK (singleton_id = 1),
  CONSTRAINT chk_blob_storage_control_state CHECK (
    (control_generation = 0
      AND storage_backend IS NULL AND namespace_sha256 IS NULL
      AND activated_at_db_ms IS NULL AND evidence_sha256 IS NULL)
    OR
    (control_generation = 1
      AND storage_backend REGEXP '^[a-z0-9][a-z0-9._-]{0,31}$'
      AND namespace_sha256 REGEXP '^[0-9a-f]{64}$'
      AND activated_at_db_ms IS NOT NULL AND activated_at_db_ms >= 0
      AND evidence_sha256 REGEXP '^[0-9a-f]{64}$')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

SELECT singleton_id, control_generation, storage_backend, namespace_sha256,
       activated_at_db_ms, evidence_sha256
  FROM blob_storage_control FORCE INDEX (PRIMARY) WHERE 1=0;

INSERT INTO blob_storage_control
  (singleton_id,control_generation,storage_backend,namespace_sha256,
   activated_at_db_ms,evidence_sha256)
SELECT 1,0,NULL,NULL,NULL,NULL
 WHERE NOT EXISTS (SELECT 1 FROM blob_storage_control WHERE singleton_id=1);

-- A snapshot pin may outlive its source manifest. Preserve the full non-secret namespace digest so
-- a short backend identity alone can never make a cross-namespace source look current. Legacy pins
-- remain NULL and therefore block activation until released or explicitly migrated.
SET @blob_snapshot_namespace_shape = (
  SELECT CONCAT(LOWER(column_type),':',is_nullable,':',COALESCE(collation_name,''))
    FROM information_schema.columns
   WHERE table_schema=DATABASE() AND table_name='user_export_snapshot_blobs'
     AND column_name='storage_namespace_sha256'
);
SET @migration_sql = IF(
  @blob_snapshot_namespace_shape IS NULL,
  'ALTER TABLE user_export_snapshot_blobs ADD COLUMN storage_namespace_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL AFTER storage_backend',
  IF(@blob_snapshot_namespace_shape='char(64):YES:utf8mb4_0900_as_cs','SELECT 1',
    'ALTER TABLE user_export_snapshot_blobs ADD COLUMN storage_namespace_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL AFTER storage_backend')
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SELECT request_id,build_generation,ordinal,storage_backend,storage_namespace_sha256,
       released_at_ms
  FROM user_export_snapshot_blobs FORCE INDEX (PRIMARY) WHERE 1=0;

-- Reject a same-name but weaker partial table before installing guards or recording the marker.
SET @blob_storage_control_schema_ok = (
  (SELECT COUNT(*)=1 AND MAX(engine='InnoDB')=1
       AND MAX(table_collation='utf8mb4_0900_as_cs')=1
     FROM information_schema.tables
    WHERE table_schema=DATABASE() AND table_name='blob_storage_control')
  AND
  (SELECT COUNT(*)=6
       AND SUM(column_name='singleton_id' AND LOWER(column_type)='tinyint unsigned'
         AND is_nullable='NO')=1
       AND SUM(column_name='control_generation' AND LOWER(column_type)='bigint unsigned'
         AND is_nullable='NO' AND column_default='0')=1
       AND SUM(column_name='storage_backend' AND LOWER(column_type)='varchar(32)'
         AND is_nullable='YES' AND collation_name='utf8mb4_0900_as_cs')=1
       AND SUM(column_name='namespace_sha256' AND LOWER(column_type)='char(64)'
         AND is_nullable='YES' AND collation_name='utf8mb4_0900_as_cs')=1
       AND SUM(column_name='activated_at_db_ms' AND LOWER(column_type)='bigint'
         AND is_nullable='YES')=1
       AND SUM(column_name='evidence_sha256' AND LOWER(column_type)='char(64)'
         AND is_nullable='YES' AND collation_name='utf8mb4_0900_as_cs')=1
     FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name='blob_storage_control')
  AND
  (SELECT COUNT(*)=1 AND MAX(index_name='PRIMARY' AND non_unique=0
         AND seq_in_index=1 AND column_name='singleton_id')=1
     FROM information_schema.statistics
    WHERE table_schema=DATABASE() AND table_name='blob_storage_control')
  AND
  (SELECT COUNT(*)=2 AND SUM(constraint_name='chk_blob_storage_control_singleton')=1
       AND SUM(constraint_name='chk_blob_storage_control_state')=1
       AND MIN(enforced='YES')=1
     FROM information_schema.table_constraints
    WHERE table_schema=DATABASE() AND table_name='blob_storage_control'
      AND constraint_type='CHECK')
  AND
  (SELECT COUNT(*)=1 AND MAX(LOWER(column_type)='char(64)')=1
       AND MAX(is_nullable='YES')=1 AND MAX(collation_name='utf8mb4_0900_as_cs')=1
     FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name='user_export_snapshot_blobs'
      AND column_name='storage_namespace_sha256')
);
SET @migration_sql = IF(@blob_storage_control_schema_ok=1,'SELECT 1',
  'SELECT 1 FROM __invalid_blob_storage_control_schema__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- The control row itself is permanent and accepts exactly one inactive -> active transition. The
-- inventory predicates also protect direct SQL activation; the store repeats them with locking
-- reads to return a stable domain error before attempting the UPDATE.
DROP TRIGGER IF EXISTS trg_blob_storage_control_bi_bootstrap;
CREATE TRIGGER trg_blob_storage_control_bi_bootstrap BEFORE INSERT ON blob_storage_control FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='blob storage control singleton already exists';
DROP TRIGGER IF EXISTS trg_blob_storage_control_bi;
CREATE TRIGGER trg_blob_storage_control_bi BEFORE INSERT ON blob_storage_control FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='blob storage control singleton already exists';
DROP TRIGGER IF EXISTS trg_blob_storage_control_bi_guard_a;
CREATE TRIGGER trg_blob_storage_control_bi_guard_a BEFORE INSERT ON blob_storage_control FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='blob storage control singleton already exists';

DROP TRIGGER IF EXISTS trg_blob_storage_control_bu_bootstrap;
CREATE TRIGGER trg_blob_storage_control_bu_bootstrap BEFORE UPDATE ON blob_storage_control FOR EACH ROW BEGIN IF NOT (OLD.singleton_id=1 AND NEW.singleton_id=1 AND OLD.control_generation=0 AND OLD.storage_backend IS NULL AND OLD.namespace_sha256 IS NULL AND OLD.activated_at_db_ms IS NULL AND OLD.evidence_sha256 IS NULL AND NEW.control_generation=1 AND NEW.storage_backend REGEXP '^[a-z0-9][a-z0-9._-]{0,31}$' AND NEW.namespace_sha256 REGEXP '^[0-9a-f]{64}$' AND NEW.activated_at_db_ms IS NOT NULL AND NEW.activated_at_db_ms>=0 AND NEW.evidence_sha256 REGEXP '^[0-9a-f]{64}$' AND NOT EXISTS (SELECT 1 FROM blob_objects b WHERE b.state<>'deleted' AND NOT (BINARY b.storage_backend=BINARY NEW.storage_backend)) AND NOT EXISTS (SELECT 1 FROM user_export_artifacts a WHERE a.state<>'deleted' AND NOT (BINARY a.storage_backend=BINARY NEW.storage_backend)) AND NOT EXISTS (SELECT 1 FROM user_export_artifact_parts p WHERE p.state<>'deleted' AND NOT (BINARY p.storage_backend=BINARY NEW.storage_backend)) AND NOT EXISTS (SELECT 1 FROM blob_delete_outbox o LEFT JOIN blob_objects b ON b.blob_id=o.blob_id WHERE o.completed_at_ms IS NULL AND o.dead_lettered_at_ms IS NULL AND (b.blob_id IS NULL OR NOT (BINARY b.storage_backend=BINARY NEW.storage_backend))) AND NOT EXISTS (SELECT 1 FROM user_export_artifact_delete_outbox o WHERE o.completed_at_ms IS NULL AND o.dead_lettered_at_ms IS NULL AND NOT (BINARY o.storage_backend=BINARY NEW.storage_backend))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='blob storage control is write-once or inventory conflicts'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_control_bu;
CREATE TRIGGER trg_blob_storage_control_bu BEFORE UPDATE ON blob_storage_control FOR EACH ROW BEGIN IF NOT (OLD.singleton_id=1 AND NEW.singleton_id=1 AND OLD.control_generation=0 AND OLD.storage_backend IS NULL AND OLD.namespace_sha256 IS NULL AND OLD.activated_at_db_ms IS NULL AND OLD.evidence_sha256 IS NULL AND NEW.control_generation=1 AND NEW.storage_backend REGEXP '^[a-z0-9][a-z0-9._-]{0,31}$' AND NEW.namespace_sha256 REGEXP '^[0-9a-f]{64}$' AND NEW.activated_at_db_ms IS NOT NULL AND NEW.activated_at_db_ms>=0 AND NEW.evidence_sha256 REGEXP '^[0-9a-f]{64}$' AND NOT EXISTS (SELECT 1 FROM blob_objects b WHERE b.state<>'deleted' AND NOT (BINARY b.storage_backend=BINARY NEW.storage_backend)) AND NOT EXISTS (SELECT 1 FROM user_export_artifacts a WHERE a.state<>'deleted' AND NOT (BINARY a.storage_backend=BINARY NEW.storage_backend)) AND NOT EXISTS (SELECT 1 FROM user_export_artifact_parts p WHERE p.state<>'deleted' AND NOT (BINARY p.storage_backend=BINARY NEW.storage_backend)) AND NOT EXISTS (SELECT 1 FROM blob_delete_outbox o LEFT JOIN blob_objects b ON b.blob_id=o.blob_id WHERE o.completed_at_ms IS NULL AND o.dead_lettered_at_ms IS NULL AND (b.blob_id IS NULL OR NOT (BINARY b.storage_backend=BINARY NEW.storage_backend))) AND NOT EXISTS (SELECT 1 FROM user_export_artifact_delete_outbox o WHERE o.completed_at_ms IS NULL AND o.dead_lettered_at_ms IS NULL AND NOT (BINARY o.storage_backend=BINARY NEW.storage_backend))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='blob storage control is write-once or inventory conflicts'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_control_bu_guard_a;
CREATE TRIGGER trg_blob_storage_control_bu_guard_a BEFORE UPDATE ON blob_storage_control FOR EACH ROW BEGIN IF NOT (OLD.singleton_id=1 AND NEW.singleton_id=1 AND OLD.control_generation=0 AND OLD.storage_backend IS NULL AND OLD.namespace_sha256 IS NULL AND OLD.activated_at_db_ms IS NULL AND OLD.evidence_sha256 IS NULL AND NEW.control_generation=1 AND NEW.storage_backend REGEXP '^[a-z0-9][a-z0-9._-]{0,31}$' AND NEW.namespace_sha256 REGEXP '^[0-9a-f]{64}$' AND NEW.activated_at_db_ms IS NOT NULL AND NEW.activated_at_db_ms>=0 AND NEW.evidence_sha256 REGEXP '^[0-9a-f]{64}$' AND NOT EXISTS (SELECT 1 FROM blob_objects b WHERE b.state<>'deleted' AND NOT (BINARY b.storage_backend=BINARY NEW.storage_backend)) AND NOT EXISTS (SELECT 1 FROM user_export_artifacts a WHERE a.state<>'deleted' AND NOT (BINARY a.storage_backend=BINARY NEW.storage_backend)) AND NOT EXISTS (SELECT 1 FROM user_export_artifact_parts p WHERE p.state<>'deleted' AND NOT (BINARY p.storage_backend=BINARY NEW.storage_backend)) AND NOT EXISTS (SELECT 1 FROM blob_delete_outbox o LEFT JOIN blob_objects b ON b.blob_id=o.blob_id WHERE o.completed_at_ms IS NULL AND o.dead_lettered_at_ms IS NULL AND (b.blob_id IS NULL OR NOT (BINARY b.storage_backend=BINARY NEW.storage_backend))) AND NOT EXISTS (SELECT 1 FROM user_export_artifact_delete_outbox o WHERE o.completed_at_ms IS NULL AND o.dead_lettered_at_ms IS NULL AND NOT (BINARY o.storage_backend=BINARY NEW.storage_backend))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='blob storage control is write-once or inventory conflicts'; END IF; END;

DROP TRIGGER IF EXISTS trg_blob_storage_snapshot_cutover_bu_bootstrap;
CREATE TRIGGER trg_blob_storage_snapshot_cutover_bu_bootstrap BEFORE UPDATE ON blob_storage_control FOR EACH ROW BEGIN IF NEW.control_generation=1 AND EXISTS (SELECT 1 FROM user_export_snapshot_blobs s WHERE s.released_at_ms IS NULL AND (NOT (BINARY s.storage_backend=BINARY NEW.storage_backend) OR s.storage_namespace_sha256 IS NULL OR NOT (BINARY s.storage_namespace_sha256=BINARY NEW.namespace_sha256))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='unreleased export snapshot conflicts with blob storage cutover'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_snapshot_cutover_bu;
CREATE TRIGGER trg_blob_storage_snapshot_cutover_bu BEFORE UPDATE ON blob_storage_control FOR EACH ROW BEGIN IF NEW.control_generation=1 AND EXISTS (SELECT 1 FROM user_export_snapshot_blobs s WHERE s.released_at_ms IS NULL AND (NOT (BINARY s.storage_backend=BINARY NEW.storage_backend) OR s.storage_namespace_sha256 IS NULL OR NOT (BINARY s.storage_namespace_sha256=BINARY NEW.namespace_sha256))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='unreleased export snapshot conflicts with blob storage cutover'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_snapshot_cutover_bu_guard_a;
CREATE TRIGGER trg_blob_storage_snapshot_cutover_bu_guard_a BEFORE UPDATE ON blob_storage_control FOR EACH ROW BEGIN IF NEW.control_generation=1 AND EXISTS (SELECT 1 FROM user_export_snapshot_blobs s WHERE s.released_at_ms IS NULL AND (NOT (BINARY s.storage_backend=BINARY NEW.storage_backend) OR s.storage_namespace_sha256 IS NULL OR NOT (BINARY s.storage_namespace_sha256=BINARY NEW.namespace_sha256))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='unreleased export snapshot conflicts with blob storage cutover'; END IF; END;

-- Dead-letter is an operator-visible retry stop, not proof that bytes were physically deleted. The
-- original guards cover claimable rows; this independently rotated family closes the dead-letter
-- gap for direct SQL activation while preserving completed history.
DROP TRIGGER IF EXISTS trg_blob_storage_dead_letter_cutover_bu_bootstrap;
CREATE TRIGGER trg_blob_storage_dead_letter_cutover_bu_bootstrap BEFORE UPDATE ON blob_storage_control FOR EACH ROW BEGIN IF NEW.control_generation=1 AND (EXISTS (SELECT 1 FROM blob_delete_outbox o LEFT JOIN blob_objects b ON b.blob_id=o.blob_id WHERE o.completed_at_ms IS NULL AND o.dead_lettered_at_ms IS NOT NULL AND (b.blob_id IS NULL OR NOT (BINARY b.storage_backend=BINARY NEW.storage_backend))) OR EXISTS (SELECT 1 FROM user_export_artifact_delete_outbox o WHERE o.completed_at_ms IS NULL AND o.dead_lettered_at_ms IS NOT NULL AND NOT (BINARY o.storage_backend=BINARY NEW.storage_backend))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='dead-letter delete intent conflicts with blob storage cutover'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_dead_letter_cutover_bu;
CREATE TRIGGER trg_blob_storage_dead_letter_cutover_bu BEFORE UPDATE ON blob_storage_control FOR EACH ROW BEGIN IF NEW.control_generation=1 AND (EXISTS (SELECT 1 FROM blob_delete_outbox o LEFT JOIN blob_objects b ON b.blob_id=o.blob_id WHERE o.completed_at_ms IS NULL AND o.dead_lettered_at_ms IS NOT NULL AND (b.blob_id IS NULL OR NOT (BINARY b.storage_backend=BINARY NEW.storage_backend))) OR EXISTS (SELECT 1 FROM user_export_artifact_delete_outbox o WHERE o.completed_at_ms IS NULL AND o.dead_lettered_at_ms IS NOT NULL AND NOT (BINARY o.storage_backend=BINARY NEW.storage_backend))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='dead-letter delete intent conflicts with blob storage cutover'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_dead_letter_cutover_bu_guard_a;
CREATE TRIGGER trg_blob_storage_dead_letter_cutover_bu_guard_a BEFORE UPDATE ON blob_storage_control FOR EACH ROW BEGIN IF NEW.control_generation=1 AND (EXISTS (SELECT 1 FROM blob_delete_outbox o LEFT JOIN blob_objects b ON b.blob_id=o.blob_id WHERE o.completed_at_ms IS NULL AND o.dead_lettered_at_ms IS NOT NULL AND (b.blob_id IS NULL OR NOT (BINARY b.storage_backend=BINARY NEW.storage_backend))) OR EXISTS (SELECT 1 FROM user_export_artifact_delete_outbox o WHERE o.completed_at_ms IS NULL AND o.dead_lettered_at_ms IS NOT NULL AND NOT (BINARY o.storage_backend=BINARY NEW.storage_backend))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='dead-letter delete intent conflicts with blob storage cutover'; END IF; END;

DROP TRIGGER IF EXISTS trg_blob_storage_control_bd_bootstrap;
CREATE TRIGGER trg_blob_storage_control_bd_bootstrap BEFORE DELETE ON blob_storage_control FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='blob storage control cannot be deleted';
DROP TRIGGER IF EXISTS trg_blob_storage_control_bd;
CREATE TRIGGER trg_blob_storage_control_bd BEFORE DELETE ON blob_storage_control FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='blob storage control cannot be deleted';
DROP TRIGGER IF EXISTS trg_blob_storage_control_bd_guard_a;
CREATE TRIGGER trg_blob_storage_control_bd_guard_a BEFORE DELETE ON blob_storage_control FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='blob storage control cannot be deleted';

-- Each old-writer guard takes a current locking read. Defaults are fail-closed if the singleton is
-- missing. Backend identity is immutable even before activation; moving bytes requires a separate,
-- audited migration rather than rewriting a locator underneath pending cleanup work.
DROP TRIGGER IF EXISTS trg_blob_storage_object_bi_bootstrap;
CREATE TRIGGER trg_blob_storage_object_bi_bootstrap BEFORE INSERT ON blob_objects FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; SELECT control_generation,storage_backend FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend; IF v_generation<>0 AND (v_backend IS NULL OR NOT (BINARY NEW.storage_backend=BINARY v_backend)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active blob storage control rejects backend'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_object_bi;
CREATE TRIGGER trg_blob_storage_object_bi BEFORE INSERT ON blob_objects FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; SELECT control_generation,storage_backend FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend; IF v_generation<>0 AND (v_backend IS NULL OR NOT (BINARY NEW.storage_backend=BINARY v_backend)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active blob storage control rejects backend'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_object_bi_guard_a;
CREATE TRIGGER trg_blob_storage_object_bi_guard_a BEFORE INSERT ON blob_objects FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; SELECT control_generation,storage_backend FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend; IF v_generation<>0 AND (v_backend IS NULL OR NOT (BINARY NEW.storage_backend=BINARY v_backend)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active blob storage control rejects backend'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_object_bu_bootstrap;
CREATE TRIGGER trg_blob_storage_object_bu_bootstrap BEFORE UPDATE ON blob_objects FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; SELECT control_generation,storage_backend FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend; IF NOT (BINARY OLD.storage_backend=BINARY NEW.storage_backend) OR (v_generation<>0 AND (v_backend IS NULL OR NOT (BINARY NEW.storage_backend=BINARY v_backend))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='blob storage backend is immutable or inactive'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_object_bu;
CREATE TRIGGER trg_blob_storage_object_bu BEFORE UPDATE ON blob_objects FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; SELECT control_generation,storage_backend FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend; IF NOT (BINARY OLD.storage_backend=BINARY NEW.storage_backend) OR (v_generation<>0 AND (v_backend IS NULL OR NOT (BINARY NEW.storage_backend=BINARY v_backend))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='blob storage backend is immutable or inactive'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_object_bu_guard_a;
CREATE TRIGGER trg_blob_storage_object_bu_guard_a BEFORE UPDATE ON blob_objects FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; SELECT control_generation,storage_backend FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend; IF NOT (BINARY OLD.storage_backend=BINARY NEW.storage_backend) OR (v_generation<>0 AND (v_backend IS NULL OR NOT (BINARY NEW.storage_backend=BINARY v_backend))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='blob storage backend is immutable or inactive'; END IF; END;

DROP TRIGGER IF EXISTS trg_blob_storage_export_artifact_bi_bootstrap;
CREATE TRIGGER trg_blob_storage_export_artifact_bi_bootstrap BEFORE INSERT ON user_export_artifacts FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; SELECT control_generation,storage_backend FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend; IF v_generation<>0 AND (v_backend IS NULL OR NOT (BINARY NEW.storage_backend=BINARY v_backend)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active blob storage control rejects export backend'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_export_artifact_bi;
CREATE TRIGGER trg_blob_storage_export_artifact_bi BEFORE INSERT ON user_export_artifacts FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; SELECT control_generation,storage_backend FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend; IF v_generation<>0 AND (v_backend IS NULL OR NOT (BINARY NEW.storage_backend=BINARY v_backend)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active blob storage control rejects export backend'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_export_artifact_bi_guard_a;
CREATE TRIGGER trg_blob_storage_export_artifact_bi_guard_a BEFORE INSERT ON user_export_artifacts FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; SELECT control_generation,storage_backend FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend; IF v_generation<>0 AND (v_backend IS NULL OR NOT (BINARY NEW.storage_backend=BINARY v_backend)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active blob storage control rejects export backend'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_export_artifact_bu_bootstrap;
CREATE TRIGGER trg_blob_storage_export_artifact_bu_bootstrap BEFORE UPDATE ON user_export_artifacts FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; SELECT control_generation,storage_backend FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend; IF NOT (BINARY OLD.storage_backend=BINARY NEW.storage_backend) OR (v_generation<>0 AND (v_backend IS NULL OR NOT (BINARY NEW.storage_backend=BINARY v_backend))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='export storage backend is immutable or inactive'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_export_artifact_bu;
CREATE TRIGGER trg_blob_storage_export_artifact_bu BEFORE UPDATE ON user_export_artifacts FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; SELECT control_generation,storage_backend FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend; IF NOT (BINARY OLD.storage_backend=BINARY NEW.storage_backend) OR (v_generation<>0 AND (v_backend IS NULL OR NOT (BINARY NEW.storage_backend=BINARY v_backend))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='export storage backend is immutable or inactive'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_export_artifact_bu_guard_a;
CREATE TRIGGER trg_blob_storage_export_artifact_bu_guard_a BEFORE UPDATE ON user_export_artifacts FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; SELECT control_generation,storage_backend FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend; IF NOT (BINARY OLD.storage_backend=BINARY NEW.storage_backend) OR (v_generation<>0 AND (v_backend IS NULL OR NOT (BINARY NEW.storage_backend=BINARY v_backend))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='export storage backend is immutable or inactive'; END IF; END;

DROP TRIGGER IF EXISTS trg_blob_storage_export_part_bi_bootstrap;
CREATE TRIGGER trg_blob_storage_export_part_bi_bootstrap BEFORE INSERT ON user_export_artifact_parts FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; SELECT control_generation,storage_backend FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend; IF v_generation<>0 AND (v_backend IS NULL OR NOT (BINARY NEW.storage_backend=BINARY v_backend)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active blob storage control rejects export part backend'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_export_part_bi;
CREATE TRIGGER trg_blob_storage_export_part_bi BEFORE INSERT ON user_export_artifact_parts FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; SELECT control_generation,storage_backend FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend; IF v_generation<>0 AND (v_backend IS NULL OR NOT (BINARY NEW.storage_backend=BINARY v_backend)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active blob storage control rejects export part backend'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_export_part_bi_guard_a;
CREATE TRIGGER trg_blob_storage_export_part_bi_guard_a BEFORE INSERT ON user_export_artifact_parts FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; SELECT control_generation,storage_backend FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend; IF v_generation<>0 AND (v_backend IS NULL OR NOT (BINARY NEW.storage_backend=BINARY v_backend)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active blob storage control rejects export part backend'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_export_part_bu_bootstrap;
CREATE TRIGGER trg_blob_storage_export_part_bu_bootstrap BEFORE UPDATE ON user_export_artifact_parts FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; SELECT control_generation,storage_backend FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend; IF NOT (BINARY OLD.storage_backend=BINARY NEW.storage_backend) OR (v_generation<>0 AND (v_backend IS NULL OR NOT (BINARY NEW.storage_backend=BINARY v_backend))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='export part storage backend is immutable or inactive'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_export_part_bu;
CREATE TRIGGER trg_blob_storage_export_part_bu BEFORE UPDATE ON user_export_artifact_parts FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; SELECT control_generation,storage_backend FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend; IF NOT (BINARY OLD.storage_backend=BINARY NEW.storage_backend) OR (v_generation<>0 AND (v_backend IS NULL OR NOT (BINARY NEW.storage_backend=BINARY v_backend))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='export part storage backend is immutable or inactive'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_export_part_bu_guard_a;
CREATE TRIGGER trg_blob_storage_export_part_bu_guard_a BEFORE UPDATE ON user_export_artifact_parts FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; SELECT control_generation,storage_backend FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend; IF NOT (BINARY OLD.storage_backend=BINARY NEW.storage_backend) OR (v_generation<>0 AND (v_backend IS NULL OR NOT (BINARY NEW.storage_backend=BINARY v_backend))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='export part storage backend is immutable or inactive'; END IF; END;

DROP TRIGGER IF EXISTS trg_blob_storage_snapshot_bi_bootstrap;
CREATE TRIGGER trg_blob_storage_snapshot_bi_bootstrap BEFORE INSERT ON user_export_snapshot_blobs FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; DECLARE v_namespace CHAR(64) DEFAULT NULL; SELECT control_generation,storage_backend,namespace_sha256 FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend,v_namespace; IF v_generation<>0 AND (v_backend IS NULL OR v_namespace IS NULL OR NOT (BINARY NEW.storage_backend=BINARY v_backend) OR NEW.storage_namespace_sha256 IS NULL OR NOT (BINARY NEW.storage_namespace_sha256=BINARY v_namespace)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active blob storage control rejects snapshot namespace'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_snapshot_bi;
CREATE TRIGGER trg_blob_storage_snapshot_bi BEFORE INSERT ON user_export_snapshot_blobs FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; DECLARE v_namespace CHAR(64) DEFAULT NULL; SELECT control_generation,storage_backend,namespace_sha256 FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend,v_namespace; IF v_generation<>0 AND (v_backend IS NULL OR v_namespace IS NULL OR NOT (BINARY NEW.storage_backend=BINARY v_backend) OR NEW.storage_namespace_sha256 IS NULL OR NOT (BINARY NEW.storage_namespace_sha256=BINARY v_namespace)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active blob storage control rejects snapshot namespace'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_snapshot_bi_guard_a;
CREATE TRIGGER trg_blob_storage_snapshot_bi_guard_a BEFORE INSERT ON user_export_snapshot_blobs FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; DECLARE v_namespace CHAR(64) DEFAULT NULL; SELECT control_generation,storage_backend,namespace_sha256 FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend,v_namespace; IF v_generation<>0 AND (v_backend IS NULL OR v_namespace IS NULL OR NOT (BINARY NEW.storage_backend=BINARY v_backend) OR NEW.storage_namespace_sha256 IS NULL OR NOT (BINARY NEW.storage_namespace_sha256=BINARY v_namespace)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active blob storage control rejects snapshot namespace'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_snapshot_bu_bootstrap;
CREATE TRIGGER trg_blob_storage_snapshot_bu_bootstrap BEFORE UPDATE ON user_export_snapshot_blobs FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; DECLARE v_namespace CHAR(64) DEFAULT NULL; SELECT control_generation,storage_backend,namespace_sha256 FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend,v_namespace; IF NOT (BINARY OLD.storage_backend=BINARY NEW.storage_backend) OR NOT (OLD.storage_namespace_sha256<=>NEW.storage_namespace_sha256) OR (v_generation<>0 AND NEW.released_at_ms IS NULL AND (v_backend IS NULL OR v_namespace IS NULL OR NOT (BINARY NEW.storage_backend=BINARY v_backend) OR NEW.storage_namespace_sha256 IS NULL OR NOT (BINARY NEW.storage_namespace_sha256=BINARY v_namespace))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='snapshot storage namespace is immutable or inactive'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_snapshot_bu;
CREATE TRIGGER trg_blob_storage_snapshot_bu BEFORE UPDATE ON user_export_snapshot_blobs FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; DECLARE v_namespace CHAR(64) DEFAULT NULL; SELECT control_generation,storage_backend,namespace_sha256 FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend,v_namespace; IF NOT (BINARY OLD.storage_backend=BINARY NEW.storage_backend) OR NOT (OLD.storage_namespace_sha256<=>NEW.storage_namespace_sha256) OR (v_generation<>0 AND NEW.released_at_ms IS NULL AND (v_backend IS NULL OR v_namespace IS NULL OR NOT (BINARY NEW.storage_backend=BINARY v_backend) OR NEW.storage_namespace_sha256 IS NULL OR NOT (BINARY NEW.storage_namespace_sha256=BINARY v_namespace))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='snapshot storage namespace is immutable or inactive'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_snapshot_bu_guard_a;
CREATE TRIGGER trg_blob_storage_snapshot_bu_guard_a BEFORE UPDATE ON user_export_snapshot_blobs FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; DECLARE v_namespace CHAR(64) DEFAULT NULL; SELECT control_generation,storage_backend,namespace_sha256 FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend,v_namespace; IF NOT (BINARY OLD.storage_backend=BINARY NEW.storage_backend) OR NOT (OLD.storage_namespace_sha256<=>NEW.storage_namespace_sha256) OR (v_generation<>0 AND NEW.released_at_ms IS NULL AND (v_backend IS NULL OR v_namespace IS NULL OR NOT (BINARY NEW.storage_backend=BINARY v_backend) OR NEW.storage_namespace_sha256 IS NULL OR NOT (BINARY NEW.storage_namespace_sha256=BINARY v_namespace))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='snapshot storage namespace is immutable or inactive'; END IF; END;

-- Delete intents are part of the cutover inventory too. Protect their direct SQL paths so a
-- post-cutover old worker cannot introduce pending work for an absent/foreign manifest or a
-- foreign export namespace after the activation transaction has proved the inventory.
DROP TRIGGER IF EXISTS trg_blob_storage_blob_outbox_bi_bootstrap;
CREATE TRIGGER trg_blob_storage_blob_outbox_bi_bootstrap BEFORE INSERT ON blob_delete_outbox FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; SELECT control_generation,storage_backend FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend; IF v_generation<>0 AND (v_backend IS NULL OR NOT EXISTS (SELECT 1 FROM blob_objects b WHERE b.blob_id=NEW.blob_id AND BINARY b.storage_backend=BINARY v_backend)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active blob storage control rejects blob delete intent'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_blob_outbox_bi;
CREATE TRIGGER trg_blob_storage_blob_outbox_bi BEFORE INSERT ON blob_delete_outbox FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; SELECT control_generation,storage_backend FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend; IF v_generation<>0 AND (v_backend IS NULL OR NOT EXISTS (SELECT 1 FROM blob_objects b WHERE b.blob_id=NEW.blob_id AND BINARY b.storage_backend=BINARY v_backend)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active blob storage control rejects blob delete intent'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_blob_outbox_bi_guard_a;
CREATE TRIGGER trg_blob_storage_blob_outbox_bi_guard_a BEFORE INSERT ON blob_delete_outbox FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; SELECT control_generation,storage_backend FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend; IF v_generation<>0 AND (v_backend IS NULL OR NOT EXISTS (SELECT 1 FROM blob_objects b WHERE b.blob_id=NEW.blob_id AND BINARY b.storage_backend=BINARY v_backend)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active blob storage control rejects blob delete intent'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_blob_outbox_bu_bootstrap;
CREATE TRIGGER trg_blob_storage_blob_outbox_bu_bootstrap BEFORE UPDATE ON blob_delete_outbox FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; SELECT control_generation,storage_backend FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend; IF v_generation<>0 AND (v_backend IS NULL OR NOT EXISTS (SELECT 1 FROM blob_objects b WHERE b.blob_id=NEW.blob_id AND BINARY b.storage_backend=BINARY v_backend)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active blob storage control rejects blob delete intent'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_blob_outbox_bu;
CREATE TRIGGER trg_blob_storage_blob_outbox_bu BEFORE UPDATE ON blob_delete_outbox FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; SELECT control_generation,storage_backend FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend; IF v_generation<>0 AND (v_backend IS NULL OR NOT EXISTS (SELECT 1 FROM blob_objects b WHERE b.blob_id=NEW.blob_id AND BINARY b.storage_backend=BINARY v_backend)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active blob storage control rejects blob delete intent'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_blob_outbox_bu_guard_a;
CREATE TRIGGER trg_blob_storage_blob_outbox_bu_guard_a BEFORE UPDATE ON blob_delete_outbox FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; SELECT control_generation,storage_backend FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend; IF v_generation<>0 AND (v_backend IS NULL OR NOT EXISTS (SELECT 1 FROM blob_objects b WHERE b.blob_id=NEW.blob_id AND BINARY b.storage_backend=BINARY v_backend)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active blob storage control rejects blob delete intent'; END IF; END;

DROP TRIGGER IF EXISTS trg_blob_storage_export_outbox_bi_bootstrap;
CREATE TRIGGER trg_blob_storage_export_outbox_bi_bootstrap BEFORE INSERT ON user_export_artifact_delete_outbox FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; SELECT control_generation,storage_backend FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend; IF v_generation<>0 AND (v_backend IS NULL OR NOT (BINARY NEW.storage_backend=BINARY v_backend)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active blob storage control rejects export delete intent'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_export_outbox_bi;
CREATE TRIGGER trg_blob_storage_export_outbox_bi BEFORE INSERT ON user_export_artifact_delete_outbox FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; SELECT control_generation,storage_backend FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend; IF v_generation<>0 AND (v_backend IS NULL OR NOT (BINARY NEW.storage_backend=BINARY v_backend)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active blob storage control rejects export delete intent'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_export_outbox_bi_guard_a;
CREATE TRIGGER trg_blob_storage_export_outbox_bi_guard_a BEFORE INSERT ON user_export_artifact_delete_outbox FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; SELECT control_generation,storage_backend FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend; IF v_generation<>0 AND (v_backend IS NULL OR NOT (BINARY NEW.storage_backend=BINARY v_backend)) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='active blob storage control rejects export delete intent'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_export_outbox_bu_bootstrap;
CREATE TRIGGER trg_blob_storage_export_outbox_bu_bootstrap BEFORE UPDATE ON user_export_artifact_delete_outbox FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; SELECT control_generation,storage_backend FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend; IF NOT (BINARY OLD.storage_backend=BINARY NEW.storage_backend) OR (v_generation<>0 AND (v_backend IS NULL OR NOT (BINARY NEW.storage_backend=BINARY v_backend))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='export delete intent backend is immutable or inactive'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_export_outbox_bu;
CREATE TRIGGER trg_blob_storage_export_outbox_bu BEFORE UPDATE ON user_export_artifact_delete_outbox FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; SELECT control_generation,storage_backend FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend; IF NOT (BINARY OLD.storage_backend=BINARY NEW.storage_backend) OR (v_generation<>0 AND (v_backend IS NULL OR NOT (BINARY NEW.storage_backend=BINARY v_backend))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='export delete intent backend is immutable or inactive'; END IF; END;
DROP TRIGGER IF EXISTS trg_blob_storage_export_outbox_bu_guard_a;
CREATE TRIGGER trg_blob_storage_export_outbox_bu_guard_a BEFORE UPDATE ON user_export_artifact_delete_outbox FOR EACH ROW BEGIN DECLARE v_generation BIGINT UNSIGNED DEFAULT 1; DECLARE v_backend VARCHAR(32) DEFAULT NULL; SELECT control_generation,storage_backend FROM blob_storage_control WHERE singleton_id=1 FOR SHARE INTO v_generation,v_backend; IF NOT (BINARY OLD.storage_backend=BINARY NEW.storage_backend) OR (v_generation<>0 AND (v_backend IS NULL OR NOT (BINARY NEW.storage_backend=BINARY v_backend))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='export delete intent backend is immutable or inactive'; END IF; END;

SET @blob_storage_control_trigger_set_ok = (
  SELECT COUNT(*)=51 AND COUNT(DISTINCT trigger_name)=51
    FROM information_schema.triggers
   WHERE trigger_schema=DATABASE() AND trigger_name LIKE 'trg_blob_storage_%'
);
SET @migration_sql = IF(@blob_storage_control_trigger_set_ok=1,'SELECT 1',
  'SELECT 1 FROM __invalid_blob_storage_control_trigger_set__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
