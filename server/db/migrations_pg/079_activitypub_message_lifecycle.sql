-- 079: ActivityPub message lifecycle ordering + tombstones (P6)
--
-- ap_messages.updatedAt existed but was nullable and inbound Update used local
-- receive time unconditionally. Delete physically removed the row, so a late
-- redelivered Create could resurrect an object that had already been deleted.
--
-- P6 gives every persisted AP message a lifecycle clock and keeps Delete as a
-- tombstone in the same row. The production handler only applies a mutation
-- when its AP timestamp is newer than the stored lifecycle timestamp.

ALTER TABLE ap_messages
  ADD COLUMN IF NOT EXISTS "deletedAt" BIGINT;

UPDATE ap_messages
SET "updatedAt" = COALESCE("updatedAt", published, "createdAt", 0)
WHERE "updatedAt" IS NULL;

ALTER TABLE ap_messages
  ALTER COLUMN "updatedAt" SET DEFAULT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT;

ALTER TABLE ap_messages
  ALTER COLUMN "updatedAt" SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ap_messages_live_actor_published
  ON ap_messages("actorUrl", published DESC NULLS LAST)
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS idx_ap_messages_direct_target_live
  ON ap_messages("targetUserId", published DESC NULLS LAST)
  WHERE visibility = 'direct' AND "deletedAt" IS NULL;
