-- Stop/drain every pre-0060 writer, migrate independently, forward-fix only.
-- Fingerprints calibrated against fresh isolated real MySQL; no control is activated here.
-- Registry packages are not session blobs; this migration grants no erasure/external authority.
CREATE TABLE IF NOT EXISTS skill_registry_owners (
  owner_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  owner_json JSON NOT NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (owner_sha256),
  CONSTRAINT chk_skill_owner_time CHECK (created_at_ms >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
CREATE TABLE IF NOT EXISTS skill_registry_slots (
  slot_id CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  owner_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  name VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  generation BIGINT UNSIGNED NOT NULL,
  state VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  current_version_id VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  record_json JSON NOT NULL,
  PRIMARY KEY (slot_id),
  UNIQUE KEY uk_skill_slot_owner_name (owner_sha256,name),
  UNIQUE KEY uk_skill_slot_owner (slot_id,owner_sha256),
  CONSTRAINT fk_skill_slot_owner FOREIGN KEY (owner_sha256) REFERENCES skill_registry_owners(owner_sha256) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_skill_slot_state CHECK (revision>0 AND generation>0 AND created_at_ms>=0 AND updated_at_ms>=created_at_ms AND state IN ('active','deleted') AND (state='active' OR current_version_id IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
CREATE TABLE IF NOT EXISTS skill_registry_installations (
  installation_id VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  owner_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  slot_id CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  generation BIGINT UNSIGNED NOT NULL,
  state VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL,
  version_id VARCHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
  idempotency_key_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  request_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  record_json JSON NOT NULL,
  PRIMARY KEY (installation_id),
  UNIQUE KEY uk_skill_install_key (owner_sha256,idempotency_key_sha256),
  UNIQUE KEY uk_skill_install_revision (slot_id,revision),
  KEY idx_skill_install_owner (slot_id,owner_sha256),
  CONSTRAINT fk_skill_install_slot FOREIGN KEY (slot_id,owner_sha256) REFERENCES skill_registry_slots(slot_id,owner_sha256) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_skill_install_control FOREIGN KEY (owner_sha256) REFERENCES skill_registry_owners(owner_sha256) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_skill_install_state CHECK (revision>0 AND generation>0 AND ((state='staging' AND version_id IS NULL) OR (state='ready' AND version_id IS NOT NULL)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
CREATE TABLE IF NOT EXISTS skill_registry_versions (
  version_id VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  owner_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  slot_id CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  generation BIGINT UNSIGNED NOT NULL,
  installation_id VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  version_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  record_json JSON NOT NULL,
  PRIMARY KEY (version_id),
  UNIQUE KEY uk_skill_version_sha (version_sha256),
  UNIQUE KEY uk_skill_version_install (installation_id),
  KEY idx_skill_version_owner (slot_id,owner_sha256),
  KEY idx_skill_version_owner_list (owner_sha256,version_id),
  CONSTRAINT fk_skill_version_slot FOREIGN KEY (slot_id,owner_sha256) REFERENCES skill_registry_slots(slot_id,owner_sha256) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_skill_version_control FOREIGN KEY (owner_sha256) REFERENCES skill_registry_owners(owner_sha256) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_skill_version_install FOREIGN KEY (installation_id) REFERENCES skill_registry_installations(installation_id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
CREATE TABLE IF NOT EXISTS skill_registry_deletions (
  owner_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  idempotency_key_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  slot_id CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  request_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL,
  record_json JSON NOT NULL,
  PRIMARY KEY (owner_sha256,idempotency_key_sha256),
  UNIQUE KEY uk_skill_delete_revision (slot_id,revision),
  KEY idx_skill_delete_owner (slot_id,owner_sha256),
  CONSTRAINT fk_skill_delete_slot FOREIGN KEY (slot_id,owner_sha256) REFERENCES skill_registry_slots(slot_id,owner_sha256) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_skill_delete_control FOREIGN KEY (owner_sha256) REFERENCES skill_registry_owners(owner_sha256) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_skill_registry_owners_bi BEFORE INSERT ON skill_registry_owners FOR EACH ROW BEGIN IF JSON_TYPE(NEW.owner_json)<>'OBJECT' OR JSON_LENGTH(NEW.owner_json)<>3 OR (JSON_UNQUOTE(JSON_EXTRACT(NEW.owner_json,'$.scope')) IN ('platform','tenant','user')) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='skill owner is invalid'; END IF; END;
CREATE TRIGGER trg_skill_registry_owners_bu BEFORE UPDATE ON skill_registry_owners FOR EACH ROW BEGIN IF NOT (BINARY NEW.owner_sha256=BINARY OLD.owner_sha256 AND NEW.owner_json=OLD.owner_json AND NEW.created_at_ms=OLD.created_at_ms) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='skill owner is immutable'; END IF; END;
CREATE TRIGGER trg_skill_registry_owners_bd BEFORE DELETE ON skill_registry_owners FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='skill owner is permanent';
CREATE TRIGGER trg_skill_registry_slots_bi BEFORE INSERT ON skill_registry_slots FOR EACH ROW BEGIN IF (EXISTS (SELECT 1 FROM skill_registry_owners o WHERE BINARY o.owner_sha256=BINARY NEW.owner_sha256 AND JSON_EXTRACT(NEW.record_json,'$.owner')=o.owner_json) AND NEW.revision=1 AND NEW.generation=1 AND NEW.state='active' AND NEW.current_version_id IS NULL AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.record_json,'$.slotId'))=BINARY NEW.slot_id AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.record_json,'$.name'))=BINARY NEW.name AND JSON_EXTRACT(NEW.record_json,'$.revision')=NEW.revision AND JSON_EXTRACT(NEW.record_json,'$.generation')=NEW.generation) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='skill slot requires initial revision'; END IF; END;
CREATE TRIGGER trg_skill_registry_slots_bu BEFORE UPDATE ON skill_registry_slots FOR EACH ROW BEGIN IF (BINARY NEW.slot_id=BINARY OLD.slot_id AND BINARY NEW.owner_sha256=BINARY OLD.owner_sha256 AND BINARY NEW.name=BINARY OLD.name AND JSON_EXTRACT(NEW.record_json,'$.owner')=JSON_EXTRACT(OLD.record_json,'$.owner') AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.record_json,'$.name'))=BINARY NEW.name AND NEW.created_at_ms=OLD.created_at_ms AND NEW.updated_at_ms>=OLD.updated_at_ms AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.record_json,'$.slotId'))=BINARY NEW.slot_id AND JSON_EXTRACT(NEW.record_json,'$.revision')=NEW.revision AND JSON_EXTRACT(NEW.record_json,'$.generation')=NEW.generation AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.record_json,'$.state'))=BINARY NEW.state AND ((NEW.revision=OLD.revision+1 AND NEW.generation=OLD.generation AND NEW.state='deleted' AND OLD.state='active' AND NEW.current_version_id IS NULL) OR (NEW.revision=OLD.revision+1 AND NEW.state='active' AND ((OLD.state='active' AND NEW.generation=OLD.generation AND NEW.current_version_id<=>OLD.current_version_id) OR (OLD.state='deleted' AND NEW.generation=OLD.generation+1 AND NEW.current_version_id IS NULL))) OR (NEW.revision=OLD.revision AND NEW.generation=OLD.generation AND OLD.state='active' AND NEW.state='active' AND EXISTS (SELECT 1 FROM skill_registry_versions v JOIN skill_registry_installations i ON BINARY i.installation_id=BINARY v.installation_id WHERE BINARY v.version_id=BINARY NEW.current_version_id AND BINARY v.slot_id=BINARY NEW.slot_id AND BINARY v.owner_sha256=BINARY NEW.owner_sha256 AND v.revision=NEW.revision AND v.generation=NEW.generation AND i.state='ready' AND BINARY i.version_id=BINARY v.version_id)))) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='skill slot transition is invalid'; END IF; END;
CREATE TRIGGER trg_skill_registry_slots_bd BEFORE DELETE ON skill_registry_slots FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='skill slot is permanent';
CREATE TRIGGER trg_skill_registry_installations_bi BEFORE INSERT ON skill_registry_installations FOR EACH ROW BEGIN IF (EXISTS (SELECT 1 FROM skill_registry_owners o WHERE BINARY o.owner_sha256=BINARY NEW.owner_sha256 AND JSON_EXTRACT(NEW.record_json,'$.owner')=o.owner_json) AND NEW.state='staging' AND NEW.version_id IS NULL AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.record_json,'$.installationId'))=BINARY NEW.installation_id AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.record_json,'$.slotId'))=BINARY NEW.slot_id AND JSON_EXTRACT(NEW.record_json,'$.revision')=NEW.revision AND JSON_EXTRACT(NEW.record_json,'$.generation')=NEW.generation AND EXISTS (SELECT 1 FROM skill_registry_slots s WHERE BINARY s.slot_id=BINARY NEW.slot_id AND BINARY s.owner_sha256=BINARY NEW.owner_sha256 AND s.state='active' AND s.revision=NEW.revision AND s.generation=NEW.generation)) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='skill stage requires exact slot'; END IF; END;
CREATE TRIGGER trg_skill_registry_installations_bu BEFORE UPDATE ON skill_registry_installations FOR EACH ROW BEGIN IF (OLD.state='staging' AND NEW.state='ready' AND BINARY NEW.installation_id=BINARY OLD.installation_id AND BINARY NEW.owner_sha256=BINARY OLD.owner_sha256 AND BINARY NEW.slot_id=BINARY OLD.slot_id AND NEW.revision=OLD.revision AND NEW.generation=OLD.generation AND BINARY NEW.idempotency_key_sha256=BINARY OLD.idempotency_key_sha256 AND BINARY NEW.request_sha256=BINARY OLD.request_sha256 AND JSON_REMOVE(NEW.record_json,'$.state','$.versionId','$.publishedAtMs')=JSON_REMOVE(OLD.record_json,'$.state','$.versionId','$.publishedAtMs') AND EXISTS (SELECT 1 FROM skill_registry_versions v WHERE BINARY v.version_id=BINARY NEW.version_id AND BINARY v.installation_id=BINARY NEW.installation_id AND BINARY v.slot_id=BINARY NEW.slot_id AND BINARY v.owner_sha256=BINARY NEW.owner_sha256 AND v.revision=NEW.revision AND v.generation=NEW.generation)) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='skill manifest transition is invalid'; END IF; END;
CREATE TRIGGER trg_skill_registry_installations_bd BEFORE DELETE ON skill_registry_installations FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='skill manifest is retained';
CREATE TRIGGER trg_skill_registry_versions_bi BEFORE INSERT ON skill_registry_versions FOR EACH ROW BEGIN IF (BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.record_json,'$.versionId'))=BINARY NEW.version_id AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.record_json,'$.versionSha256'))=BINARY NEW.version_sha256 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.record_json,'$.installationId'))=BINARY NEW.installation_id AND JSON_EXTRACT(NEW.record_json,'$.revision')=NEW.revision AND JSON_EXTRACT(NEW.record_json,'$.generation')=NEW.generation AND EXISTS (SELECT 1 FROM skill_registry_installations i JOIN skill_registry_slots s ON BINARY s.slot_id=BINARY i.slot_id AND BINARY s.owner_sha256=BINARY i.owner_sha256 WHERE BINARY i.installation_id=BINARY NEW.installation_id AND BINARY i.slot_id=BINARY NEW.slot_id AND BINARY i.owner_sha256=BINARY NEW.owner_sha256 AND i.revision=NEW.revision AND i.generation=NEW.generation AND JSON_EXTRACT(NEW.record_json,'$.owner')=JSON_EXTRACT(i.record_json,'$.owner') AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.record_json,'$.storageNamespaceSha256'))=BINARY JSON_UNQUOTE(JSON_EXTRACT(i.record_json,'$.storageNamespaceSha256')) AND i.state='staging' AND s.state='active' AND s.revision=NEW.revision AND s.generation=NEW.generation AND JSON_EXTRACT(NEW.record_json,'$.metadata')=JSON_EXTRACT(i.record_json,'$.metadata') AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.record_json,'$.storageKey'))=BINARY JSON_UNQUOTE(JSON_EXTRACT(i.record_json,'$.storageKey')) AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.record_json,'$.backend'))=BINARY JSON_UNQUOTE(JSON_EXTRACT(i.record_json,'$.backend')) AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.record_json,'$.sha256'))=BINARY JSON_UNQUOTE(JSON_EXTRACT(i.record_json,'$.sha256')) AND JSON_EXTRACT(NEW.record_json,'$.sizeBytes')=JSON_EXTRACT(i.record_json,'$.sizeBytes'))) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='skill version requires exact staged package'; END IF; END;
CREATE TRIGGER trg_skill_registry_versions_bu BEFORE UPDATE ON skill_registry_versions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='skill version is immutable';
CREATE TRIGGER trg_skill_registry_versions_bd BEFORE DELETE ON skill_registry_versions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='skill version is retained';
CREATE TRIGGER trg_skill_registry_deletions_bi BEFORE INSERT ON skill_registry_deletions FOR EACH ROW BEGIN IF (BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.record_json,'$.idempotencyKeySha256'))=BINARY NEW.idempotency_key_sha256 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(NEW.record_json,'$.requestSha256'))=BINARY NEW.request_sha256 AND EXISTS (SELECT 1 FROM skill_registry_slots s WHERE BINARY s.slot_id=BINARY NEW.slot_id AND BINARY s.owner_sha256=BINARY NEW.owner_sha256 AND s.revision=NEW.revision AND s.state='deleted' AND JSON_EXTRACT(NEW.record_json,'$.slot')=s.record_json)) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='skill deletion requires exact tombstone'; END IF; END;
CREATE TRIGGER trg_skill_registry_deletions_bu BEFORE UPDATE ON skill_registry_deletions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='skill deletion is immutable';
CREATE TRIGGER trg_skill_registry_deletions_bd BEFORE DELETE ON skill_registry_deletions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='skill deletion is retained';
-- Additive safety gates: the old fixed-domain receipts cannot silently account for this domain.
CREATE TRIGGER trg_skill_registry_t3d_bu BEFORE UPDATE ON tenant_purge_plan_jobs FOR EACH ROW BEGIN IF OLD.phase='queued' AND NEW.phase='plan_sealed' AND EXISTS (SELECT 1 FROM skill_registry_owners o WHERE BINARY JSON_UNQUOTE(JSON_EXTRACT(o.owner_json,'$.tenantId'))=BINARY NEW.tenant_id FOR SHARE) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='skill registry lifecycle is not proven'; END IF; END;
CREATE TRIGGER trg_skill_registry_t3f_bu BEFORE UPDATE ON tenant_database_purge_jobs FOR EACH ROW BEGIN IF OLD.phase='queued' AND NEW.phase='database_purged' AND EXISTS (SELECT 1 FROM skill_registry_owners o WHERE BINARY JSON_UNQUOTE(JSON_EXTRACT(o.owner_json,'$.tenantId'))=BINARY NEW.tenant_id FOR SHARE) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='skill registry lifecycle is not proven'; END IF; END;
-- Independent active-owner gate also protects raw SQL, not only the TypeScript consumer.
CREATE TRIGGER trg_skill_registry_slots_gate_bi BEFORE INSERT ON skill_registry_slots FOR EACH ROW BEGIN IF NOT EXISTS (SELECT 1 FROM skill_registry_owners o WHERE BINARY o.owner_sha256=BINARY NEW.owner_sha256 AND (JSON_UNQUOTE(JSON_EXTRACT(o.owner_json,'$.scope'))='platform' OR (EXISTS (SELECT 1 FROM subject_lifecycle t WHERE BINARY t.tenant_id=BINARY JSON_UNQUOTE(JSON_EXTRACT(o.owner_json,'$.tenantId')) AND t.subject_kind='tenant' AND BINARY t.subject_id=BINARY t.tenant_id AND t.state='active' FOR SHARE) AND NOT EXISTS (SELECT 1 FROM tenant_erasure_admissions a WHERE BINARY a.tenant_id=BINARY JSON_UNQUOTE(JSON_EXTRACT(o.owner_json,'$.tenantId')) FOR SHARE) AND NOT EXISTS (SELECT 1 FROM tenant_credential_revocation_fences f WHERE BINARY f.tenant_id=BINARY JSON_UNQUOTE(JSON_EXTRACT(o.owner_json,'$.tenantId')) FOR SHARE) AND NOT EXISTS (SELECT 1 FROM tenant_restore_fences r WHERE BINARY r.tenant_id=BINARY JSON_UNQUOTE(JSON_EXTRACT(o.owner_json,'$.tenantId')) FOR SHARE) AND (JSON_UNQUOTE(JSON_EXTRACT(o.owner_json,'$.scope'))='tenant' OR EXISTS (SELECT 1 FROM subject_lifecycle u WHERE BINARY u.tenant_id=BINARY JSON_UNQUOTE(JSON_EXTRACT(o.owner_json,'$.tenantId')) AND u.subject_kind='user' AND BINARY u.subject_id=BINARY JSON_UNQUOTE(JSON_EXTRACT(o.owner_json,'$.userId')) AND u.state='active' FOR SHARE))))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='skill owner lifecycle is not active'; END IF; END;
CREATE TRIGGER trg_skill_registry_slots_gate_bu BEFORE UPDATE ON skill_registry_slots FOR EACH ROW BEGIN IF NOT EXISTS (SELECT 1 FROM skill_registry_owners o WHERE BINARY o.owner_sha256=BINARY NEW.owner_sha256 AND (JSON_UNQUOTE(JSON_EXTRACT(o.owner_json,'$.scope'))='platform' OR (EXISTS (SELECT 1 FROM subject_lifecycle t WHERE BINARY t.tenant_id=BINARY JSON_UNQUOTE(JSON_EXTRACT(o.owner_json,'$.tenantId')) AND t.subject_kind='tenant' AND BINARY t.subject_id=BINARY t.tenant_id AND t.state='active' FOR SHARE) AND NOT EXISTS (SELECT 1 FROM tenant_erasure_admissions a WHERE BINARY a.tenant_id=BINARY JSON_UNQUOTE(JSON_EXTRACT(o.owner_json,'$.tenantId')) FOR SHARE) AND NOT EXISTS (SELECT 1 FROM tenant_credential_revocation_fences f WHERE BINARY f.tenant_id=BINARY JSON_UNQUOTE(JSON_EXTRACT(o.owner_json,'$.tenantId')) FOR SHARE) AND NOT EXISTS (SELECT 1 FROM tenant_restore_fences r WHERE BINARY r.tenant_id=BINARY JSON_UNQUOTE(JSON_EXTRACT(o.owner_json,'$.tenantId')) FOR SHARE) AND (JSON_UNQUOTE(JSON_EXTRACT(o.owner_json,'$.scope'))='tenant' OR EXISTS (SELECT 1 FROM subject_lifecycle u WHERE BINARY u.tenant_id=BINARY JSON_UNQUOTE(JSON_EXTRACT(o.owner_json,'$.tenantId')) AND u.subject_kind='user' AND BINARY u.subject_id=BINARY JSON_UNQUOTE(JSON_EXTRACT(o.owner_json,'$.userId')) AND u.state='active' FOR SHARE))))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='skill owner lifecycle is not active'; END IF; END;
CREATE TRIGGER trg_skill_registry_versions_gate_bi BEFORE INSERT ON skill_registry_versions FOR EACH ROW BEGIN IF NOT EXISTS (SELECT 1 FROM skill_registry_owners o WHERE BINARY o.owner_sha256=BINARY NEW.owner_sha256 AND (JSON_UNQUOTE(JSON_EXTRACT(o.owner_json,'$.scope'))='platform' OR (EXISTS (SELECT 1 FROM subject_lifecycle t WHERE BINARY t.tenant_id=BINARY JSON_UNQUOTE(JSON_EXTRACT(o.owner_json,'$.tenantId')) AND t.subject_kind='tenant' AND BINARY t.subject_id=BINARY t.tenant_id AND t.state='active' FOR SHARE) AND NOT EXISTS (SELECT 1 FROM tenant_erasure_admissions a WHERE BINARY a.tenant_id=BINARY JSON_UNQUOTE(JSON_EXTRACT(o.owner_json,'$.tenantId')) FOR SHARE) AND NOT EXISTS (SELECT 1 FROM tenant_credential_revocation_fences f WHERE BINARY f.tenant_id=BINARY JSON_UNQUOTE(JSON_EXTRACT(o.owner_json,'$.tenantId')) FOR SHARE) AND NOT EXISTS (SELECT 1 FROM tenant_restore_fences r WHERE BINARY r.tenant_id=BINARY JSON_UNQUOTE(JSON_EXTRACT(o.owner_json,'$.tenantId')) FOR SHARE) AND (JSON_UNQUOTE(JSON_EXTRACT(o.owner_json,'$.scope'))='tenant' OR EXISTS (SELECT 1 FROM subject_lifecycle u WHERE BINARY u.tenant_id=BINARY JSON_UNQUOTE(JSON_EXTRACT(o.owner_json,'$.tenantId')) AND u.subject_kind='user' AND BINARY u.subject_id=BINARY JSON_UNQUOTE(JSON_EXTRACT(o.owner_json,'$.userId')) AND u.state='active' FOR SHARE))))) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='skill owner lifecycle is not active'; END IF; END;

SET @skill_registry_previous_gcml=@@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len=1048576;
-- agent-service-runtime-fingerprint:skill-registry-schema:start
SET @skill_registry_schema_ok=(
  (SELECT COUNT(*)=5 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,table_type,IFNULL(engine,'-'),IFNULL(table_collation,'-'),IFNULL(row_format,'-'),IFNULL(create_options,'-')) ORDER BY table_name SEPARATOR '|'),256)='3df182f7e930d24b8f6c23cfdfbac3df9414dbc4c095adb641942acc2fa927bb' FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name LIKE 'skill_registry_%')
  AND (SELECT COUNT(*)=37 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,LPAD(ordinal_position,3,'0'),column_name,LOWER(column_type),is_nullable,IF(column_default IS NULL,'<NULL>',CONCAT('<',column_default,'>')),IFNULL(character_set_name,'-'),IFNULL(collation_name,'-'),IFNULL(extra,'-'),IFNULL(generation_expression,'-')) ORDER BY table_name,ordinal_position SEPARATOR '|'),256)='6e55b13e87e40a71f0841a95aed05bb7237e1c11c7f80bab2c3c00b404ab4519' FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name LIKE 'skill_registry_%')
AND (SELECT COUNT(*)=26 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,index_name,LPAD(seq_in_index,3,'0'),column_name,non_unique,index_type,IFNULL(collation,'-'),IFNULL(sub_part,'-'),IFNULL(nullable,'-')) ORDER BY table_name,index_name,seq_in_index SEPARATOR '|'),256)='f61617be55b6e64de6cfc2b74cd20d47c077df1e5d531b2f65302802592cf5f4' FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name LIKE 'skill_registry_%')
  AND (SELECT COUNT(*)=3 AND SUM(enforced='YES')=3 FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND table_name LIKE 'skill_registry_%' AND constraint_type='CHECK')
  AND (SELECT COUNT(*)=3 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',constraint_name,LOWER(REPLACE(REPLACE(REGEXP_REPLACE(check_clause,'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY constraint_name SEPARATOR '|'),256)='6f3627e75f53d3218d3cf1021be44d3ee1b7b645edfe769c61749f0a6694d23d' FROM information_schema.check_constraints WHERE constraint_schema=DATABASE() AND constraint_name IN ('chk_skill_owner_time','chk_skill_slot_state','chk_skill_install_state'))
AND (SELECT COUNT(*)=23 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,constraint_type) ORDER BY table_name,constraint_name SEPARATOR '|'),256)='51fd673be6750c5926a6875727ee6567ea1fab53ee709984116dcb607665a84c' FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND table_name LIKE 'skill_registry_%')
AND (SELECT COUNT(*)=8 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,referenced_table_name,update_rule,delete_rule) ORDER BY table_name,constraint_name SEPARATOR '|'),256)='f7ae9190d7a60da862992bb471addea138da92d5b76755a5981e377541c224ee' FROM information_schema.referential_constraints WHERE constraint_schema=DATABASE() AND table_name LIKE 'skill_registry_%')
  AND (SELECT COUNT(*)=11 AND SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,LPAD(ordinal_position,3,'0'),column_name,referenced_table_name,referenced_column_name) ORDER BY table_name,constraint_name,ordinal_position SEPARATOR '|'),256)='dca1fbba6501d02620eabfdadaddb49f1550a6be0953972244073caea76b9e1e' FROM information_schema.key_column_usage WHERE table_schema=DATABASE() AND table_name LIKE 'skill_registry_%' AND referenced_table_name IS NOT NULL)
  AND (SELECT COUNT(*)=0 FROM information_schema.partitions WHERE table_schema=DATABASE() AND table_name LIKE 'skill_registry_%' AND partition_name IS NOT NULL)
);
-- agent-service-runtime-fingerprint:skill-registry-schema:end
SET @migration_sql=IF(@skill_registry_schema_ok=1,'SELECT 1','SELECT 1 FROM __invalid_skill_registry_schema__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
-- agent-service-runtime-fingerprint:skill-registry-triggers:start
SET @skill_registry_triggers_ok=(SELECT COUNT(*)=763 AND COUNT(DISTINCT trigger_name)=763 AND SUM(trigger_name LIKE 'trg_skill_registry_%')=20 AND SUM(OCTET_LENGTH(CONCAT_WS('~',event_object_table,trigger_name,action_timing,event_manipulation,action_orientation,IFNULL(action_condition,'<NULL>'),LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),CHAR(96),''),'_utf8mb4','')))))+COUNT(*)-1<=@@SESSION.group_concat_max_len AND SHA2(GROUP_CONCAT(CONCAT_WS('~',event_object_table,trigger_name,action_timing,event_manipulation,action_orientation,IFNULL(action_condition,'<NULL>'),LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY event_object_table,trigger_name SEPARATOR '|'),256)='33c0776366530be9c72a1a10b03ff98808e491f1f7bb369735b06359bef99941' FROM information_schema.triggers WHERE trigger_schema=DATABASE());
-- agent-service-runtime-fingerprint:skill-registry-triggers:end
SET @migration_sql=IF(@skill_registry_triggers_ok=1,'SELECT 1','SELECT 1 FROM __invalid_skill_registry_triggers__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
SET SESSION group_concat_max_len=@skill_registry_previous_gcml;
