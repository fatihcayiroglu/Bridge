DROP INDEX IF EXISTS idx_gdm_messages_client_nonce;
DROP INDEX IF EXISTS idx_dm_messages_client_nonce;
ALTER TABLE group_dm_messages DROP COLUMN IF EXISTS "clientNonce";
ALTER TABLE dm_messages DROP COLUMN IF EXISTS "clientNonce";
