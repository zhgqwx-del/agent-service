-- Approval grants are server state, never client-writable metadata.
ALTER TABLE sessions ADD COLUMN auto_approved_tools JSON NULL;
