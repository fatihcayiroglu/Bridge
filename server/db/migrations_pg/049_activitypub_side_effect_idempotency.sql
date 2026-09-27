-- Migration 049: ActivityPub side-effect identity / notification contract closure.
-- Existing rows remain nullable; federation writers use deterministic primary
-- keys scoped by recipient + signed actor + activity id. Secondary indexes are
-- deliberately NON-UNIQUE: ActivityPub activity ids are remote input and the
-- same activity may legitimately be delivered to multiple local inboxes.
BEGIN;

ALTER TABLE ap_likes ADD COLUMN IF NOT EXISTS "activityId" TEXT;
ALTER TABLE ap_announces ADD COLUMN IF NOT EXISTS "activityId" TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS "activityId" TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS "dmId" TEXT;

-- Remove the pre-release globally-unique form if an earlier progress build
-- created it. Global uniqueness would allow one remote actor/recipient to
-- collide with another actor's otherwise-valid activity id.
DROP INDEX IF EXISTS idx_ap_likes_activity_id;
DROP INDEX IF EXISTS idx_ap_announces_activity_id;
CREATE INDEX IF NOT EXISTS idx_ap_likes_activity_actor_target
  ON ap_likes("actorUrl", "activityId", "targetUserId") WHERE "activityId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ap_announces_activity_actor_target
  ON ap_announces("actorUrl", "activityId", "targetUserId") WHERE "activityId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_activity
  ON notifications("activityId") WHERE "activityId" IS NOT NULL;

COMMIT;
