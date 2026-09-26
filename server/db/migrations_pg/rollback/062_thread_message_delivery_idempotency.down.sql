DROP INDEX IF EXISTS uq_thread_messages_delivery_nonce;
ALTER TABLE thread_messages DROP COLUMN IF EXISTS "clientNonce";
