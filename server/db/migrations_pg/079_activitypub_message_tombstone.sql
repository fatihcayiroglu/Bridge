-- 079: ActivityPub message tombstones (P6)
--
-- Delete must leave durable evidence that an object existed. Without a
-- tombstone, a delayed/replayed Create can resurrect content after Delete.
-- `updatedAt` already stores the lifecycle ordering timestamp for ap_messages;
-- this migration adds only the deletion marker.

ALTER TABLE ap_messages
  ADD COLUMN IF NOT EXISTS "deletedAt" BIGINT;

CREATE INDEX IF NOT EXISTS idx_ap_messages_live_visibility_actor
  ON ap_messages(visibility, "actorUrl", published DESC NULLS LAST)
  WHERE "deletedAt" IS NULL;
