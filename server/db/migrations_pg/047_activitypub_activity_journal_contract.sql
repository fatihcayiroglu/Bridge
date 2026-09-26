-- 047_activitypub_activity_journal_contract.sql
--
-- Align the ActivityPub activity journal with both production writers:
--   * inbound inbox rows identify a local targetUserId;
--   * outbound/C2S rows identify actorUserId and have no targetUserId.
-- Historical inline schema incorrectly required targetUserId and omitted the
-- outbound columns, so real PostgreSQL C2S persistence could fail.

BEGIN;

ALTER TABLE ap_activities
  ALTER COLUMN "targetUserId" DROP NOT NULL;

ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS "actorUserId" TEXT;
ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS type TEXT;
ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS "activityId" TEXT;
ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS "noteId" TEXT;
ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS "publishedAt" BIGINT;

CREATE INDEX IF NOT EXISTS idx_ap_activities_actor
  ON ap_activities("actorUserId");
CREATE INDEX IF NOT EXISTS idx_ap_activities_target
  ON ap_activities("targetUserId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_ap_activities_type
  ON ap_activities(type);
CREATE INDEX IF NOT EXISTS idx_ap_activities_activity_id
  ON ap_activities("activityId") WHERE "activityId" IS NOT NULL;

COMMIT;
