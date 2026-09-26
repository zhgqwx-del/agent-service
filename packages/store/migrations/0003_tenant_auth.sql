-- Per-tenant end-user identity policy. The optional secret (HS256 key or introspection credential)
-- is encrypted with the same cipher as BYOK provider keys, never stored in the JSON.
ALTER TABLE tenants ADD COLUMN auth_policy JSON NULL;
ALTER TABLE tenants ADD COLUMN auth_secret_cipher VARBINARY(8192) NULL;
ALTER TABLE tenants ADD COLUMN auth_secret_key_id VARCHAR(128) NULL;
