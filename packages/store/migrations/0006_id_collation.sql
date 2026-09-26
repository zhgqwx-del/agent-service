-- Ids must compare exactly. With the server default (utf8mb4_0900_ai_ci) MySQL treats 'sess_abc' and
-- 'SESS_ABC' as the SAME row, while Redis lease keys are byte-compared — so a request using a different
-- case found the real session but took a DIFFERENT lease, giving two writers and bypassing fencing.
ALTER TABLE sessions  MODIFY session_id        VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL;
ALTER TABLE sessions  MODIFY parent_session_id VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NULL;
ALTER TABLE sessions  MODIFY agent_id          VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL;
ALTER TABLE sessions  MODIFY tenant_id         VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL;
ALTER TABLE sessions  MODIFY user_id           VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL;
ALTER TABLE turns     MODIFY turn_id           VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL;
ALTER TABLE turns     MODIFY session_id        VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL;
ALTER TABLE items     MODIFY item_id           VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL;
ALTER TABLE items     MODIFY session_id        VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL;
ALTER TABLE items     MODIFY turn_id           VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL;
ALTER TABLE events    MODIFY session_id        VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL;
ALTER TABLE approvals MODIFY approval_id       VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL;
ALTER TABLE approvals MODIFY session_id        VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL;
ALTER TABLE approvals MODIFY turn_id           VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL;
ALTER TABLE agent_versions MODIFY agent_id     VARCHAR(64)  COLLATE utf8mb4_0900_as_cs NOT NULL;
ALTER TABLE agent_versions MODIFY tenant_id    VARCHAR(128) COLLATE utf8mb4_0900_as_cs NOT NULL;
ALTER TABLE api_keys  MODIFY key_hash          CHAR(64)     COLLATE utf8mb4_0900_as_cs NOT NULL;
