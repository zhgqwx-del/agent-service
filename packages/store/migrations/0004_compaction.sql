-- Server-owned compaction watermark. It was previously read from the client-writable `metadata` JSON,
-- which let a caller truncate its own history by setting a field.
ALTER TABLE sessions ADD COLUMN last_compaction_seq BIGINT NULL;
