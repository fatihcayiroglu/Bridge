-- 062_thread_message_delivery_idempotency.sql
-- Retry-safe thread replies. A client retries the same nonce after an ACK/HTTP
-- response loss; the database guarantees that this cannot create a second reply.
ALTER TABLE thread_messages ADD COLUMN IF NOT EXISTS "clientNonce" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_thread_messages_delivery_nonce
  ON thread_messages("threadId", "userId", "clientNonce")
  WHERE "clientNonce" IS NOT NULL;
