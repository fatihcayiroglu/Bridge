-- Durable optimistic-send idempotency for direct and group DMs.
-- The client reuses clientNonce on retry; a lost realtime confirmation must
-- never turn into a duplicate persisted message.

ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS "clientNonce" TEXT;
ALTER TABLE group_dm_messages ADD COLUMN IF NOT EXISTS "clientNonce" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_messages_client_nonce
  ON dm_messages("userId", "clientNonce") WHERE "clientNonce" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_gdm_messages_client_nonce
  ON group_dm_messages("userId", "clientNonce") WHERE "clientNonce" IS NOT NULL;
