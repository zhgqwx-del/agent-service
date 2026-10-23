-- Native-root-calibrated 0066 managed-expiry correction; formal acceptance remains pending.
SET @session_authority_previous_gcml=@@SESSION.group_concat_max_len;
SET SESSION group_concat_max_len=1048576;

-- Exact published 0065 predecessor: 18 physical tables and all 853 triggers.
SET @skill_registry_triggers_ok=(
  (SELECT COUNT(*)=18 FROM information_schema.tables WHERE table_schema=DATABASE() AND (table_name LIKE 'mcp_registry_%' OR table_name LIKE 'tenant_webhook_%' OR table_name LIKE 'subagent_%'))
  AND (SELECT COUNT(*)=0 FROM information_schema.partitions WHERE table_schema=DATABASE() AND (table_name LIKE 'mcp_registry_%' OR table_name LIKE 'tenant_webhook_%' OR table_name LIKE 'subagent_%') AND partition_name IS NOT NULL)
  AND (SELECT COUNT(*)=853 AND SUM(trigger_name LIKE 'trg_tenant_webhook%')=23 AND SUM(trigger_name LIKE 'trg_subagent%')=24 AND SUM(OCTET_LENGTH(CONCAT_WS('~',event_object_table,trigger_name,action_timing,event_manipulation,action_orientation,IFNULL(action_condition,'<NULL>'),LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),CHAR(96),''),'_utf8mb4','')))))+COUNT(*)-1<=@@SESSION.group_concat_max_len FROM information_schema.triggers WHERE trigger_schema=DATABASE())
  AND SHA2(CONCAT_WS('::',
    (SELECT SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,engine,table_collation,row_format,create_options) ORDER BY table_name SEPARATOR '|'),256) FROM information_schema.tables WHERE table_schema=DATABASE() AND (table_name LIKE 'mcp_registry_%' OR table_name LIKE 'tenant_webhook_%' OR table_name LIKE 'subagent_%')),
    (SELECT SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,LPAD(ordinal_position,3,'0'),column_name,column_type,is_nullable,IFNULL(column_default,'<NULL>'),extra,IFNULL(character_set_name,'-'),IFNULL(collation_name,'-'),LOWER(REPLACE(REPLACE(REGEXP_REPLACE(IFNULL(generation_expression,''),'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY table_name,ordinal_position SEPARATOR '|'),256) FROM information_schema.columns WHERE table_schema=DATABASE() AND (table_name LIKE 'mcp_registry_%' OR table_name LIKE 'tenant_webhook_%' OR table_name LIKE 'subagent_%')),
    (SELECT SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,index_name,LPAD(seq_in_index,3,'0'),column_name,non_unique,index_type,IFNULL(collation,'-'),IFNULL(sub_part,'-'),IFNULL(nullable,'-')) ORDER BY table_name,index_name,seq_in_index SEPARATOR '|'),256) FROM information_schema.statistics WHERE table_schema=DATABASE() AND (table_name LIKE 'mcp_registry_%' OR table_name LIKE 'tenant_webhook_%' OR table_name LIKE 'subagent_%')),
    (SELECT SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,constraint_type,IFNULL(enforced,'-')) ORDER BY table_name,constraint_name SEPARATOR '|'),256) FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND (table_name LIKE 'mcp_registry_%' OR table_name LIKE 'tenant_webhook_%' OR table_name LIKE 'subagent_%')),
    (SELECT SHA2(GROUP_CONCAT(CONCAT_WS('~',constraint_name,LOWER(REPLACE(REPLACE(REGEXP_REPLACE(check_clause,'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY constraint_name SEPARATOR '|'),256) FROM information_schema.check_constraints WHERE constraint_schema=DATABASE() AND (constraint_name='chk_mcp_owner' OR constraint_name LIKE 'chk_mcp_dcr_%' OR constraint_name='chk_tenant_webhook_slot_state' OR constraint_name LIKE 'chk_subagent_%')),
    (SELECT SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,referenced_table_name,update_rule,delete_rule) ORDER BY table_name,constraint_name SEPARATOR '|'),256) FROM information_schema.referential_constraints WHERE constraint_schema=DATABASE() AND (table_name LIKE 'mcp_registry_%' OR table_name LIKE 'tenant_webhook_%' OR table_name LIKE 'subagent_%')),
    (SELECT SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,LPAD(ordinal_position,3,'0'),column_name,referenced_table_name,referenced_column_name) ORDER BY table_name,constraint_name,ordinal_position SEPARATOR '|'),256) FROM information_schema.key_column_usage WHERE table_schema=DATABASE() AND (table_name LIKE 'mcp_registry_%' OR table_name LIKE 'tenant_webhook_%' OR table_name LIKE 'subagent_%') AND referenced_table_name IS NOT NULL),
    (SELECT SHA2(GROUP_CONCAT(CONCAT_WS('~',event_object_table,trigger_name,action_timing,event_manipulation,action_orientation,IFNULL(action_condition,'<NULL>'),LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY event_object_table,trigger_name SEPARATOR '|'),256) FROM information_schema.triggers WHERE trigger_schema=DATABASE())
  ),256)='a20e7b93367a13ff601a1d1e749ace263d4a385a8c839b64ecbc6bc7f24373c1'
);
SET @migration_sql=IF(@skill_registry_triggers_ok=1 AND (SELECT COUNT(*)=1 FROM schema_migrations WHERE name='0065_mcp_dcr.sql') AND (SELECT COUNT(*)=0 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name LIKE 'session_authority_%') AND (SELECT COUNT(*)=0 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='sessions' AND column_name LIKE 'authority_%'),'SELECT 1','SELECT 1 FROM __invalid_session_authority_predecessor__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;


-- Native calibration additionally binds full pre-0066 sessions metadata; old 0065 root alone did not.
SET @skill_registry_triggers_ok=(
  (SELECT COUNT(*)=19 FROM information_schema.tables WHERE table_schema=DATABASE() AND (table_name='sessions' OR table_name LIKE 'mcp_registry_%' OR table_name LIKE 'tenant_webhook_%' OR table_name LIKE 'subagent_%'))
  AND (SELECT COUNT(*)=0 FROM information_schema.partitions WHERE table_schema=DATABASE() AND (table_name='sessions' OR table_name LIKE 'mcp_registry_%' OR table_name LIKE 'tenant_webhook_%' OR table_name LIKE 'subagent_%') AND partition_name IS NOT NULL)
  AND (SELECT COUNT(*)=853 AND SUM(trigger_name LIKE 'trg_tenant_webhook%')=23 AND SUM(trigger_name LIKE 'trg_subagent%')=24 AND SUM(OCTET_LENGTH(CONCAT_WS('~',event_object_table,trigger_name,action_timing,event_manipulation,action_orientation,IFNULL(action_condition,'<NULL>'),LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),CHAR(96),''),'_utf8mb4','')))))+COUNT(*)-1<=@@SESSION.group_concat_max_len FROM information_schema.triggers WHERE trigger_schema=DATABASE())
  AND SHA2(CONCAT_WS('::',
    (SELECT SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,engine,table_collation,row_format,create_options) ORDER BY table_name SEPARATOR '|'),256) FROM information_schema.tables WHERE table_schema=DATABASE() AND (table_name='sessions' OR table_name LIKE 'mcp_registry_%' OR table_name LIKE 'tenant_webhook_%' OR table_name LIKE 'subagent_%')),
    (SELECT SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,LPAD(ordinal_position,3,'0'),column_name,column_type,is_nullable,IFNULL(column_default,'<NULL>'),extra,IFNULL(character_set_name,'-'),IFNULL(collation_name,'-'),LOWER(REPLACE(REPLACE(REGEXP_REPLACE(IFNULL(generation_expression,''),'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY table_name,ordinal_position SEPARATOR '|'),256) FROM information_schema.columns WHERE table_schema=DATABASE() AND (table_name='sessions' OR table_name LIKE 'mcp_registry_%' OR table_name LIKE 'tenant_webhook_%' OR table_name LIKE 'subagent_%')),
    (SELECT SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,index_name,LPAD(seq_in_index,3,'0'),column_name,non_unique,index_type,IFNULL(collation,'-'),IFNULL(sub_part,'-'),IFNULL(nullable,'-')) ORDER BY table_name,index_name,seq_in_index SEPARATOR '|'),256) FROM information_schema.statistics WHERE table_schema=DATABASE() AND (table_name='sessions' OR table_name LIKE 'mcp_registry_%' OR table_name LIKE 'tenant_webhook_%' OR table_name LIKE 'subagent_%')),
    (SELECT SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,constraint_type,IFNULL(enforced,'-')) ORDER BY table_name,constraint_name SEPARATOR '|'),256) FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND (table_name='sessions' OR table_name LIKE 'mcp_registry_%' OR table_name LIKE 'tenant_webhook_%' OR table_name LIKE 'subagent_%')),
    (SELECT SHA2(GROUP_CONCAT(CONCAT_WS('~',constraint_name,LOWER(REPLACE(REPLACE(REGEXP_REPLACE(check_clause,'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY constraint_name SEPARATOR '|'),256) FROM information_schema.check_constraints WHERE constraint_schema=DATABASE() AND (constraint_name='chk_mcp_owner' OR constraint_name LIKE 'chk_mcp_dcr_%' OR constraint_name LIKE 'chk_sessions_%' OR constraint_name LIKE 'chk_session_authority_%' OR constraint_name='chk_tenant_webhook_slot_state' OR constraint_name LIKE 'chk_subagent_%')),
    (SELECT SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,referenced_table_name,update_rule,delete_rule) ORDER BY table_name,constraint_name SEPARATOR '|'),256) FROM information_schema.referential_constraints WHERE constraint_schema=DATABASE() AND (table_name='sessions' OR table_name LIKE 'mcp_registry_%' OR table_name LIKE 'tenant_webhook_%' OR table_name LIKE 'subagent_%')),
    (SELECT SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,LPAD(ordinal_position,3,'0'),column_name,referenced_table_name,referenced_column_name) ORDER BY table_name,constraint_name,ordinal_position SEPARATOR '|'),256) FROM information_schema.key_column_usage WHERE table_schema=DATABASE() AND (table_name='sessions' OR table_name LIKE 'mcp_registry_%' OR table_name LIKE 'tenant_webhook_%' OR table_name LIKE 'subagent_%') AND referenced_table_name IS NOT NULL),
    (SELECT SHA2(GROUP_CONCAT(CONCAT_WS('~',event_object_table,trigger_name,action_timing,event_manipulation,action_orientation,IFNULL(action_condition,'<NULL>'),LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY event_object_table,trigger_name SEPARATOR '|'),256) FROM information_schema.triggers WHERE trigger_schema=DATABASE())
  ),256)='95f6761fb8f3e570c4d00d5ad82261bed1c7f588e6389a2cfd31344cd2b75dc3'
);
SET @migration_sql=IF(@skill_registry_triggers_ok=1,'SELECT 1','SELECT 1 FROM __invalid_session_authority_sessions_predecessor__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- Forward schema changes only: no activation, GRANT/KILL, old receipt rewrite or session fence rewrite.
CREATE TABLE session_authority_control (
 control_id TINYINT UNSIGNED NOT NULL,
 protocol VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL,
 current_binding_id CHAR(36) COLLATE utf8mb4_0900_bin NULL,
 binding_sequence BIGINT UNSIGNED NOT NULL DEFAULT 0,
 PRIMARY KEY(control_id),
 CONSTRAINT chk_session_authority_control CHECK(control_id=1 AND protocol='mysql-live-session-v1'
   AND binding_sequence<=9007199254740991
   AND ((current_binding_id IS NULL AND binding_sequence=0) OR (current_binding_id IS NOT NULL AND binding_sequence>0)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE session_authority_bindings (
 binding_id CHAR(36) COLLATE utf8mb4_0900_bin NOT NULL,
 binding_sequence BIGINT UNSIGNED NOT NULL,
 predecessor_binding_id CHAR(36) COLLATE utf8mb4_0900_bin NULL,
 activation_id CHAR(36) COLLATE utf8mb4_0900_bin NOT NULL,
 server_uuid CHAR(36) COLLATE utf8mb4_0900_bin NOT NULL,
 application_database VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL,
 accounts_sha256 CHAR(64) COLLATE utf8mb4_0900_bin NOT NULL,
 activation_evidence_sha256 CHAR(64) COLLATE utf8mb4_0900_bin NOT NULL,
 command_sha256 CHAR(64) COLLATE utf8mb4_0900_bin NOT NULL,
 expected_source_kind VARCHAR(32) COLLATE utf8mb4_0900_bin NOT NULL,
 expected_source_runtime_control_generation BIGINT UNSIGNED NOT NULL,
 expected_source_runtime_control_evidence_sha256 CHAR(64) COLLATE utf8mb4_0900_bin NULL,
 expected_source_runtime_epoch_sha256 CHAR(64) COLLATE utf8mb4_0900_bin NULL,
 expected_source_restore_run_id VARCHAR(64) COLLATE utf8mb4_0900_bin NULL,
 expected_source_replay_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_bin NULL,
 next_epoch_kind VARCHAR(32) COLLATE utf8mb4_0900_bin NULL,
 next_epoch_sha256 CHAR(64) COLLATE utf8mb4_0900_bin NULL,
 next_restore_run_id VARCHAR(64) COLLATE utf8mb4_0900_bin NULL,
 activation_request_sha256 CHAR(64) COLLATE utf8mb4_0900_bin NULL,
 sealed_replay_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_bin NULL,
 transition_predecessor_control_generation BIGINT UNSIGNED NULL,
 transition_predecessor_control_evidence_sha256 CHAR(64) COLLATE utf8mb4_0900_bin NULL,
 source_kind VARCHAR(32) COLLATE utf8mb4_0900_bin NOT NULL,
 source_runtime_control_generation BIGINT UNSIGNED NOT NULL,
 source_runtime_control_evidence_sha256 CHAR(64) COLLATE utf8mb4_0900_bin NULL,
 source_runtime_epoch_sha256 CHAR(64) COLLATE utf8mb4_0900_bin NULL,
 source_restore_run_id VARCHAR(64) COLLATE utf8mb4_0900_bin NULL,
 source_replay_receipt_sha256 CHAR(64) COLLATE utf8mb4_0900_bin NULL,
 activated_at_db_ms BIGINT UNSIGNED NOT NULL,
 PRIMARY KEY(binding_id), UNIQUE KEY uk_session_authority_sequence(binding_sequence),
 UNIQUE KEY uk_session_authority_activation(activation_id),
 UNIQUE KEY uk_session_authority_epoch(source_runtime_epoch_sha256),
 CONSTRAINT fk_session_authority_predecessor FOREIGN KEY(predecessor_binding_id) REFERENCES session_authority_bindings(binding_id),
 CONSTRAINT chk_session_authority_binding CHECK(
   binding_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
   AND activation_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
   AND server_uuid REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
   AND binding_sequence BETWEEN 1 AND 9007199254740991 AND CHAR_LENGTH(application_database)>0
   AND accounts_sha256 REGEXP '^[0-9a-f]{64}$' AND activation_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
   AND command_sha256 REGEXP '^[0-9a-f]{64}$'
   AND activated_at_db_ms<=9007199254740991
   AND ((binding_sequence=1 AND predecessor_binding_id IS NULL) OR (binding_sequence>1 AND predecessor_binding_id IS NOT NULL))
   AND ((source_kind='inactive' AND source_runtime_control_generation=0 AND source_runtime_control_evidence_sha256 IS NULL
     AND source_runtime_epoch_sha256 IS NULL AND source_restore_run_id IS NULL AND source_replay_receipt_sha256 IS NULL)
   OR (source_kind IN ('primary_activation','restore_activation')
     AND source_runtime_control_generation BETWEEN 1 AND 9007199254740991
     AND source_runtime_control_evidence_sha256 IS NOT NULL AND source_runtime_control_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
     AND source_runtime_epoch_sha256 IS NOT NULL AND source_runtime_epoch_sha256 REGEXP '^[0-9a-f]{64}$'
     AND ((source_kind='primary_activation' AND source_restore_run_id IS NULL AND source_replay_receipt_sha256 IS NULL)
       OR (source_kind='restore_activation' AND source_restore_run_id IS NOT NULL AND source_replay_receipt_sha256 IS NOT NULL AND source_replay_receipt_sha256 REGEXP '^[0-9a-f]{64}$'))))
   AND ((expected_source_kind='inactive' AND expected_source_runtime_control_generation=0
     AND expected_source_runtime_control_evidence_sha256 IS NULL AND expected_source_runtime_epoch_sha256 IS NULL
     AND expected_source_restore_run_id IS NULL AND expected_source_replay_receipt_sha256 IS NULL)
   OR (expected_source_kind IN ('primary_activation','restore_activation')
     AND expected_source_runtime_control_generation BETWEEN 1 AND 9007199254740991
     AND expected_source_runtime_control_evidence_sha256 IS NOT NULL AND expected_source_runtime_control_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
     AND expected_source_runtime_epoch_sha256 IS NOT NULL AND expected_source_runtime_epoch_sha256 REGEXP '^[0-9a-f]{64}$'
     AND ((expected_source_kind='primary_activation' AND expected_source_restore_run_id IS NULL AND expected_source_replay_receipt_sha256 IS NULL)
       OR (expected_source_kind='restore_activation' AND expected_source_restore_run_id IS NOT NULL
         AND expected_source_replay_receipt_sha256 IS NOT NULL AND expected_source_replay_receipt_sha256 REGEXP '^[0-9a-f]{64}$'))))
   AND ((next_epoch_kind IS NULL AND next_epoch_sha256 IS NULL AND next_restore_run_id IS NULL AND activation_request_sha256 IS NULL
     AND sealed_replay_receipt_sha256 IS NULL AND transition_predecessor_control_generation IS NULL
     AND transition_predecessor_control_evidence_sha256 IS NULL AND binding_sequence=1 AND (expected_source_kind <=> source_kind) AND (expected_source_runtime_control_generation <=> source_runtime_control_generation) AND (expected_source_runtime_control_evidence_sha256 <=> source_runtime_control_evidence_sha256) AND (expected_source_runtime_epoch_sha256 <=> source_runtime_epoch_sha256) AND (expected_source_restore_run_id <=> source_restore_run_id) AND (expected_source_replay_receipt_sha256 <=> source_replay_receipt_sha256))
   OR (next_epoch_kind IS NOT NULL AND next_epoch_kind IN ('primary_activation','restore_activation') AND binding_sequence>1
     AND next_epoch_sha256 IS NOT NULL AND next_epoch_sha256 REGEXP '^[0-9a-f]{64}$'
     AND activation_request_sha256 IS NOT NULL AND activation_request_sha256 REGEXP '^[0-9a-f]{64}$'
     AND transition_predecessor_control_generation IS NOT NULL AND transition_predecessor_control_generation<9007199254740991
     AND transition_predecessor_control_evidence_sha256 IS NOT NULL AND transition_predecessor_control_evidence_sha256 REGEXP '^[0-9a-f]{64}$'
     AND source_runtime_control_generation=transition_predecessor_control_generation+1
     AND BINARY source_kind=BINARY next_epoch_kind AND BINARY source_runtime_epoch_sha256=BINARY next_epoch_sha256
     AND NOT(expected_source_runtime_epoch_sha256 <=> next_epoch_sha256)
     AND (source_restore_run_id <=> next_restore_run_id) AND (source_replay_receipt_sha256 <=> sealed_replay_receipt_sha256)
     AND ((next_epoch_kind='primary_activation' AND expected_source_kind='inactive' AND next_restore_run_id IS NULL AND sealed_replay_receipt_sha256 IS NULL)
       OR (next_epoch_kind='restore_activation' AND expected_source_kind IN ('primary_activation','restore_activation')
         AND next_restore_run_id IS NOT NULL AND sealed_replay_receipt_sha256 IS NOT NULL AND sealed_replay_receipt_sha256 REGEXP '^[0-9a-f]{64}$')))))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE session_authority_runtime_accounts (
 binding_id CHAR(36) COLLATE utf8mb4_0900_bin NOT NULL,
 account_user VARCHAR(32) COLLATE utf8mb4_0900_bin NOT NULL,
 account_host VARCHAR(255) COLLATE utf8mb4_0900_bin NOT NULL,
 PRIMARY KEY(binding_id,account_user,account_host),
 CONSTRAINT fk_session_authority_account_binding FOREIGN KEY(binding_id) REFERENCES session_authority_bindings(binding_id),
 CONSTRAINT chk_session_authority_account CHECK(CHAR_LENGTH(account_user)>0 AND CHAR_LENGTH(account_host)>0
   AND account_user NOT REGEXP '[[:cntrl:]@]' AND account_host NOT REGEXP '[[:cntrl:]@]')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

ALTER TABLE session_authority_control ADD CONSTRAINT fk_session_authority_current
 FOREIGN KEY(current_binding_id) REFERENCES session_authority_bindings(binding_id);

INSERT INTO session_authority_control(control_id,protocol,current_binding_id,binding_sequence)
 VALUES(1,'mysql-live-session-v1',NULL,0);

ALTER TABLE sessions
 ADD COLUMN authority_binding_id CHAR(36) COLLATE utf8mb4_0900_bin NULL,
 ADD COLUMN authority_runner_id VARCHAR(128) COLLATE utf8mb4_0900_as_cs NULL,
 ADD COLUMN authority_runner_addr VARCHAR(2048) COLLATE utf8mb4_0900_as_cs NULL,
 ADD COLUMN authority_boot_id CHAR(36) COLLATE utf8mb4_0900_bin NULL,
 ADD COLUMN authority_acquisition_sha256 CHAR(64) COLLATE utf8mb4_0900_bin NULL,
 ADD COLUMN authority_source_sha256 CHAR(64) COLLATE utf8mb4_0900_bin NULL,
 ADD COLUMN authority_expires_at_db_ms BIGINT UNSIGNED NULL,
 ADD CONSTRAINT fk_session_authority_session_binding FOREIGN KEY(authority_binding_id) REFERENCES session_authority_bindings(binding_id),
 ADD CONSTRAINT chk_session_authority_session_tuple CHECK(
  (authority_binding_id IS NULL AND authority_runner_id IS NULL AND authority_runner_addr IS NULL
   AND authority_boot_id IS NULL AND authority_acquisition_sha256 IS NULL AND authority_source_sha256 IS NULL AND authority_expires_at_db_ms IS NULL)
  OR (authority_binding_id IS NOT NULL AND authority_runner_id IS NOT NULL AND authority_runner_addr IS NOT NULL
   AND authority_boot_id IS NOT NULL AND authority_acquisition_sha256 IS NOT NULL AND authority_source_sha256 IS NOT NULL AND authority_expires_at_db_ms IS NOT NULL
   AND fence_token BETWEEN 1 AND 9007199254740991 AND authority_expires_at_db_ms<=9007199254740991
   AND OCTET_LENGTH(authority_runner_id) BETWEEN 1 AND 128 AND OCTET_LENGTH(authority_runner_addr) BETWEEN 1 AND 2048
   AND authority_boot_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
   AND authority_acquisition_sha256 REGEXP '^[0-9a-f]{64}$'
   AND authority_source_sha256 REGEXP '^[0-9a-f]{64}$'));

CREATE TRIGGER trg_session_authority_control_bi BEFORE INSERT ON session_authority_control FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Session authority protocol is immutable'; END;
CREATE TRIGGER trg_session_authority_control_bd BEFORE DELETE ON session_authority_control FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Session authority protocol is immutable'; END;
CREATE TRIGGER trg_session_authority_bindings_bu BEFORE UPDATE ON session_authority_bindings FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Session authority binding is immutable'; END;
CREATE TRIGGER trg_session_authority_bindings_bd BEFORE DELETE ON session_authority_bindings FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Session authority binding is immutable'; END;
CREATE TRIGGER trg_session_authority_accounts_bu BEFORE UPDATE ON session_authority_runtime_accounts FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Session authority account binding is immutable'; END;
CREATE TRIGGER trg_session_authority_accounts_bd BEFORE DELETE ON session_authority_runtime_accounts FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Session authority account binding is immutable'; END;

CREATE TRIGGER trg_session_authority_bindings_bi BEFORE INSERT ON session_authority_bindings FOR EACH ROW BEGIN IF (BINARY NEW.server_uuid=BINARY @@GLOBAL.server_uuid AND BINARY NEW.application_database=BINARY DATABASE() AND EXISTS(SELECT 1 FROM session_authority_control c WHERE c.control_id=1 AND NEW.binding_sequence=c.binding_sequence+1 AND (NEW.predecessor_binding_id <=> c.current_binding_id) FOR SHARE)) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Session authority predecessor is not exact'; END IF; END;

CREATE TRIGGER trg_session_authority_accounts_bi BEFORE INSERT ON session_authority_runtime_accounts FOR EACH ROW BEGIN IF EXISTS(SELECT 1 FROM session_authority_bindings b JOIN session_authority_control c ON c.control_id=1 WHERE BINARY b.binding_id=BINARY NEW.binding_id AND b.binding_sequence=c.binding_sequence+1 AND (b.predecessor_binding_id <=> c.current_binding_id) FOR SHARE) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Session authority account binding is sealed'; END IF; END;

CREATE TRIGGER trg_session_authority_control_bu BEFORE UPDATE ON session_authority_control FOR EACH ROW BEGIN IF (NEW.control_id=OLD.control_id AND BINARY NEW.protocol=BINARY OLD.protocol AND NEW.binding_sequence=OLD.binding_sequence+1 AND NEW.current_binding_id IS NOT NULL AND EXISTS(SELECT 1 FROM session_authority_bindings b WHERE BINARY b.binding_id=BINARY NEW.current_binding_id AND b.binding_sequence=NEW.binding_sequence AND (b.predecessor_binding_id <=> OLD.current_binding_id) AND BINARY b.server_uuid=BINARY @@GLOBAL.server_uuid AND BINARY b.application_database=BINARY DATABASE() AND (SELECT COUNT(*) FROM session_authority_runtime_accounts a WHERE BINARY a.binding_id=BINARY b.binding_id) BETWEEN 1 AND 64 AND (SELECT SUM(OCTET_LENGTH(CONCAT(OCTET_LENGTH(a.account_user),':',a.account_user,':',OCTET_LENGTH(a.account_host),':',a.account_host)))+COUNT(*)-1 FROM session_authority_runtime_accounts a WHERE BINARY a.binding_id=BINARY b.binding_id)<=@@SESSION.group_concat_max_len AND BINARY b.accounts_sha256=BINARY (SELECT SHA2(CONCAT('session-authority-accounts-v1|',GROUP_CONCAT(CONCAT(OCTET_LENGTH(a.account_user),':',a.account_user,':',OCTET_LENGTH(a.account_host),':',a.account_host) ORDER BY BINARY a.account_user,BINARY a.account_host SEPARATOR '|')),256) FROM session_authority_runtime_accounts a WHERE BINARY a.binding_id=BINARY b.binding_id) AND ((b.next_epoch_kind IS NULL AND OLD.current_binding_id IS NULL AND (b.expected_source_kind <=> b.source_kind) AND (b.expected_source_runtime_control_generation <=> b.source_runtime_control_generation) AND (b.expected_source_runtime_control_evidence_sha256 <=> b.source_runtime_control_evidence_sha256) AND (b.expected_source_runtime_epoch_sha256 <=> b.source_runtime_epoch_sha256) AND (b.expected_source_restore_run_id <=> b.source_restore_run_id) AND (b.expected_source_replay_receipt_sha256 <=> b.source_replay_receipt_sha256)) OR (b.next_epoch_kind IS NOT NULL AND OLD.current_binding_id IS NOT NULL AND EXISTS(SELECT 1 FROM session_authority_bindings p WHERE BINARY p.binding_id=BINARY OLD.current_binding_id AND (b.expected_source_kind <=> p.source_kind) AND (b.expected_source_runtime_control_generation <=> p.source_runtime_control_generation) AND (b.expected_source_runtime_control_evidence_sha256 <=> p.source_runtime_control_evidence_sha256) AND (b.expected_source_runtime_epoch_sha256 <=> p.source_runtime_epoch_sha256) AND (b.expected_source_restore_run_id <=> p.source_restore_run_id) AND (b.expected_source_replay_receipt_sha256 <=> p.source_replay_receipt_sha256) FOR SHARE) AND ((b.expected_source_kind='inactive' AND b.transition_predecessor_control_generation=0 AND BINARY b.transition_predecessor_control_evidence_sha256=BINARY '44bf64ec269083713f602ff9de0c936f48e8515f97335290eefd9dd2c61c9590') OR EXISTS(SELECT 1 FROM tenant_restore_runtime_events h WHERE h.singleton_id=1 AND h.control_generation=b.transition_predecessor_control_generation AND BINARY h.runtime_epoch_sha256=BINARY b.expected_source_runtime_epoch_sha256 AND BINARY h.evidence_sha256=BINARY b.transition_predecessor_control_evidence_sha256 FOR SHARE)) AND EXISTS(SELECT 1 FROM tenant_restore_runtime_events n WHERE n.singleton_id=1 AND n.control_generation=b.source_runtime_control_generation AND BINARY n.previous_control_evidence_sha256=BINARY b.transition_predecessor_control_evidence_sha256 FOR SHARE))) AND ((b.source_kind='inactive' AND OLD.current_binding_id IS NULL AND EXISTS(SELECT 1 FROM tenant_restore_runtime_control r WHERE r.singleton_id=1 AND r.state='inactive' AND r.control_generation=0 FOR SHARE)) OR (b.source_kind IN ('primary_activation','restore_activation') AND EXISTS(SELECT 1 FROM tenant_restore_runtime_control r JOIN tenant_restore_runtime_events e ON e.singleton_id=r.singleton_id WHERE r.singleton_id=1 AND r.state='active' AND BINARY r.runtime_epoch_sha256=BINARY b.source_runtime_epoch_sha256 AND e.control_generation=b.source_runtime_control_generation AND e.update_kind=b.source_kind AND BINARY e.activation_epoch_sha256=BINARY b.source_runtime_epoch_sha256 AND BINARY e.runtime_epoch_sha256=BINARY b.source_runtime_epoch_sha256 AND BINARY e.evidence_sha256=BINARY b.source_runtime_control_evidence_sha256 AND (e.restore_run_id <=> b.source_restore_run_id) AND (e.replay_receipt_sha256 <=> b.source_replay_receipt_sha256) AND (b.source_kind='primary_activation' OR EXISTS(SELECT 1 FROM tenant_restore_replay_runs x WHERE BINARY x.restore_run_id=BINARY b.source_restore_run_id AND x.phase='active' AND BINARY x.runtime_epoch_sha256=BINARY b.source_runtime_epoch_sha256 AND BINARY x.terminal_receipt_sha256=BINARY b.source_replay_receipt_sha256 FOR SHARE)) FOR SHARE) AND (OLD.current_binding_id IS NULL OR EXISTS(SELECT 1 FROM session_authority_bindings p WHERE BINARY p.binding_id=BINARY OLD.current_binding_id AND NOT(p.source_runtime_epoch_sha256 <=> b.source_runtime_epoch_sha256) AND p.source_runtime_control_generation<b.source_runtime_control_generation FOR SHARE)))) FOR SHARE)) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Session authority successor source is not exact'; END IF; END;

-- Keep the tuple/child guards. Recreate the published0064 sessions guard byte-for-byte.
-- Lease expiry writes use its original same-transaction writer admission, not trigger CURRENT_USER().

CREATE TRIGGER trg_session_authority_sessions_bi BEFORE INSERT ON sessions FOR EACH ROW BEGIN IF NEW.authority_binding_id IS NOT NULL AND EXISTS(SELECT 1 FROM subagent_tasks t WHERE BINARY t.child_session_id=BINARY NEW.session_id FOR SHARE) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Child authority must be projected from its root'; END IF; END;

CREATE TRIGGER trg_session_authority_sessions_bu BEFORE UPDATE ON sessions FOR EACH ROW BEGIN IF NEW.authority_binding_id IS NOT NULL AND EXISTS(SELECT 1 FROM subagent_tasks t WHERE BINARY t.child_session_id=BINARY NEW.session_id FOR SHARE) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Child authority must be projected from its root'; END IF; END;

CREATE TRIGGER trg_session_authority_subagent_tasks_bi BEFORE INSERT ON subagent_tasks FOR EACH ROW BEGIN IF EXISTS(SELECT 1 FROM sessions s WHERE BINARY s.session_id=BINARY NEW.child_session_id AND (s.authority_binding_id IS NOT NULL OR s.authority_runner_id IS NOT NULL OR s.authority_runner_addr IS NOT NULL OR s.authority_boot_id IS NOT NULL OR s.authority_acquisition_sha256 IS NOT NULL OR s.authority_source_sha256 IS NOT NULL OR s.authority_expires_at_db_ms IS NOT NULL) FOR SHARE) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Child authority must be projected from its root'; END IF; END;

DROP TRIGGER trg_subagent_sessions_bu;

CREATE TRIGGER trg_subagent_sessions_bu BEFORE UPDATE ON sessions FOR EACH ROW BEGIN IF (NOT((EXISTS(SELECT 1 FROM subagent_tasks t WHERE t.child_session_id=NEW.session_id AND BINARY t.child_session_id=BINARY NEW.session_id FOR SHARE) OR EXISTS(SELECT 1 FROM subagent_root_turns r WHERE r.root_session_id=NEW.session_id AND BINARY r.root_session_id=BINARY NEW.session_id AND r.state IN ('active','closing') FOR SHARE))) OR EXISTS(SELECT 1 FROM subagent_root_turns r JOIN sessions s ON s.session_id=r.root_session_id AND BINARY s.session_id=BINARY r.root_session_id WHERE r.writer_connection_id=CONNECTION_ID() AND BINARY r.writer_session_id=BINARY NEW.session_id AND s.deleted_at_ms IS NULL AND (s.fence_token=r.writer_fence AND (r.writer_mode IN ('repair','delete') OR s.fence_token=r.root_fence AND r.writer_fence=r.root_fence) OR r.writer_mode='repair' AND BINARY r.writer_session_id=BINARY r.root_session_id AND BINARY NEW.session_id=BINARY r.root_session_id AND r.writer_fence=NEW.fence_token AND NEW.fence_token>OLD.fence_token AND NEW.last_seq=OLD.last_seq AND NEW.status=OLD.status AND NEW.usage_json=OLD.usage_json AND NEW.updated_at_ms=OLD.updated_at_ms) FOR SHARE)) IS NOT TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Subagent root writer admission is required'; END IF; END;

-- agent-service-runtime-fingerprint:session-authority:start

SET @skill_registry_triggers_ok=(
  (SELECT COUNT(*)=22 FROM information_schema.tables WHERE table_schema=DATABASE() AND (table_name='sessions' OR table_name LIKE 'session_authority_%' OR table_name LIKE 'mcp_registry_%' OR table_name LIKE 'tenant_webhook_%' OR table_name LIKE 'subagent_%'))
  AND (SELECT COUNT(*)=0 FROM information_schema.partitions WHERE table_schema=DATABASE() AND (table_name='sessions' OR table_name LIKE 'session_authority_%' OR table_name LIKE 'mcp_registry_%' OR table_name LIKE 'tenant_webhook_%' OR table_name LIKE 'subagent_%') AND partition_name IS NOT NULL)
  AND (SELECT COUNT(*)=865 AND SUM(trigger_name LIKE 'trg_tenant_webhook%')=23 AND SUM(trigger_name LIKE 'trg_subagent%')=24 AND SUM(OCTET_LENGTH(CONCAT_WS('~',event_object_table,trigger_name,action_timing,event_manipulation,action_orientation,IFNULL(action_condition,'<NULL>'),LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),CHAR(96),''),'_utf8mb4','')))))+COUNT(*)-1<=@@SESSION.group_concat_max_len FROM information_schema.triggers WHERE trigger_schema=DATABASE())
  AND SHA2(CONCAT_WS('::',
    (SELECT SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,engine,table_collation,row_format,create_options) ORDER BY table_name SEPARATOR '|'),256) FROM information_schema.tables WHERE table_schema=DATABASE() AND (table_name='sessions' OR table_name LIKE 'session_authority_%' OR table_name LIKE 'mcp_registry_%' OR table_name LIKE 'tenant_webhook_%' OR table_name LIKE 'subagent_%')),
    (SELECT SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,LPAD(ordinal_position,3,'0'),column_name,column_type,is_nullable,IFNULL(column_default,'<NULL>'),extra,IFNULL(character_set_name,'-'),IFNULL(collation_name,'-'),LOWER(REPLACE(REPLACE(REGEXP_REPLACE(IFNULL(generation_expression,''),'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY table_name,ordinal_position SEPARATOR '|'),256) FROM information_schema.columns WHERE table_schema=DATABASE() AND (table_name='sessions' OR table_name LIKE 'session_authority_%' OR table_name LIKE 'mcp_registry_%' OR table_name LIKE 'tenant_webhook_%' OR table_name LIKE 'subagent_%')),
    (SELECT SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,index_name,LPAD(seq_in_index,3,'0'),column_name,non_unique,index_type,IFNULL(collation,'-'),IFNULL(sub_part,'-'),IFNULL(nullable,'-')) ORDER BY table_name,index_name,seq_in_index SEPARATOR '|'),256) FROM information_schema.statistics WHERE table_schema=DATABASE() AND (table_name='sessions' OR table_name LIKE 'session_authority_%' OR table_name LIKE 'mcp_registry_%' OR table_name LIKE 'tenant_webhook_%' OR table_name LIKE 'subagent_%')),
    (SELECT SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,constraint_type,IFNULL(enforced,'-')) ORDER BY table_name,constraint_name SEPARATOR '|'),256) FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND (table_name='sessions' OR table_name LIKE 'session_authority_%' OR table_name LIKE 'mcp_registry_%' OR table_name LIKE 'tenant_webhook_%' OR table_name LIKE 'subagent_%')),
    (SELECT SHA2(GROUP_CONCAT(CONCAT_WS('~',constraint_name,LOWER(REPLACE(REPLACE(REGEXP_REPLACE(check_clause,'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY constraint_name SEPARATOR '|'),256) FROM information_schema.check_constraints WHERE constraint_schema=DATABASE() AND (constraint_name='chk_mcp_owner' OR constraint_name LIKE 'chk_mcp_dcr_%' OR constraint_name LIKE 'chk_sessions_%' OR constraint_name LIKE 'chk_session_authority_%' OR constraint_name='chk_tenant_webhook_slot_state' OR constraint_name LIKE 'chk_subagent_%')),
    (SELECT SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,referenced_table_name,update_rule,delete_rule) ORDER BY table_name,constraint_name SEPARATOR '|'),256) FROM information_schema.referential_constraints WHERE constraint_schema=DATABASE() AND (table_name='sessions' OR table_name LIKE 'session_authority_%' OR table_name LIKE 'mcp_registry_%' OR table_name LIKE 'tenant_webhook_%' OR table_name LIKE 'subagent_%')),
    (SELECT SHA2(GROUP_CONCAT(CONCAT_WS('~',table_name,constraint_name,LPAD(ordinal_position,3,'0'),column_name,referenced_table_name,referenced_column_name) ORDER BY table_name,constraint_name,ordinal_position SEPARATOR '|'),256) FROM information_schema.key_column_usage WHERE table_schema=DATABASE() AND (table_name='sessions' OR table_name LIKE 'session_authority_%' OR table_name LIKE 'mcp_registry_%' OR table_name LIKE 'tenant_webhook_%' OR table_name LIKE 'subagent_%') AND referenced_table_name IS NOT NULL),
    (SELECT SHA2(GROUP_CONCAT(CONCAT_WS('~',event_object_table,trigger_name,action_timing,event_manipulation,action_orientation,IFNULL(action_condition,'<NULL>'),LOWER(REPLACE(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),CHAR(96),''),'_utf8mb4',''))) ORDER BY event_object_table,trigger_name SEPARATOR '|'),256) FROM information_schema.triggers WHERE trigger_schema=DATABASE())
  ),256)='5fb0f89b628dc0841ce83bb3a0edb03a37db233c97380d66b2e5646e14bdad4e'
);

-- agent-service-runtime-fingerprint:session-authority:end

SET @migration_sql=IF(@skill_registry_triggers_ok=1,'SELECT 1','SELECT 1 FROM __invalid_session_authority_fingerprint__');
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
SET SESSION group_concat_max_len=@session_authority_previous_gcml;
