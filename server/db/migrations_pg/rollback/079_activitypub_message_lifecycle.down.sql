-- 079_activitypub_message_lifecycle.down.sql
--
-- Restores the pre-079 schema shape. Data consequence: tombstone state is
-- forgotten if an operator deliberately rolls back P6; a late remote Create
-- could therefore be accepted again until 079 is re-applied.

DROP INDEX IF EXISTS idx_ap_messages_direct_target_live;
DROP INDEX IF EXISTS idx_ap_messages_live_actor_published;

ALTER TABLE ap_messages
  ALTER COLUMN "updatedAt" DROP NOT NULL;

ALTER TABLE ap_messages
  ALTER COLUMN "updatedAt" DROP DEFAULT;

ALTER TABLE ap_messages
  DROP COLUMN IF EXISTS "deletedAt";
