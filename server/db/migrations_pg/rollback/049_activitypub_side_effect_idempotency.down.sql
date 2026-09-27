BEGIN;
DROP INDEX IF EXISTS idx_notifications_activity;
DROP INDEX IF EXISTS idx_ap_announces_activity_actor_target;
DROP INDEX IF EXISTS idx_ap_likes_activity_actor_target;
-- Also clean the unsafe pre-release index names if present.
DROP INDEX IF EXISTS idx_ap_announces_activity_id;
DROP INDEX IF EXISTS idx_ap_likes_activity_id;
ALTER TABLE notifications DROP COLUMN IF EXISTS "dmId";
ALTER TABLE notifications DROP COLUMN IF EXISTS "activityId";
ALTER TABLE ap_announces DROP COLUMN IF EXISTS "activityId";
ALTER TABLE ap_likes DROP COLUMN IF EXISTS "activityId";
COMMIT;
