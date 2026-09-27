-- 048_activitypub_inbox_idempotency.sql
--
-- ActivityPub servers retry deliveries. A valid retry has a new HTTP signature
-- but the same activity.id. Previously every retry created a new random journal
-- row and could repeat Like/Announce/notification side effects.
--
-- Claim identity is scoped by local recipient + cryptographically bound actor +
-- activity id, preventing a different remote actor from suppressing another
-- actor's activity by guessing its id.

BEGIN;

ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS "actorUrl" TEXT;
ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS "processedAt" BIGINT;
ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS "claimOwner" TEXT;
ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS "claimUntil" BIGINT;
ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS "lastError" TEXT;

-- Defensive dedup for any pre-release rows already written with the new key.
DELETE FROM ap_activities older
USING ap_activities newer
WHERE older._id <> newer._id
  AND older."targetUserId" IS NOT NULL
  AND older."actorUrl" IS NOT NULL
  AND older."activityId" IS NOT NULL
  AND older."targetUserId" = newer."targetUserId"
  AND older."actorUrl" = newer."actorUrl"
  AND older."activityId" = newer."activityId"
  AND ((CASE WHEN older.processed THEN 1 ELSE 0 END) < (CASE WHEN newer.processed THEN 1 ELSE 0 END)
       OR (older.processed = newer.processed AND older."createdAt" > newer."createdAt")
       OR (older.processed = newer.processed AND older."createdAt" = newer."createdAt" AND older._id > newer._id));

CREATE UNIQUE INDEX IF NOT EXISTS idx_ap_activities_inbound_unique
  ON ap_activities("targetUserId", "actorUrl", "activityId")
  WHERE "targetUserId" IS NOT NULL AND "actorUrl" IS NOT NULL AND "activityId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ap_activities_claim
  ON ap_activities(processed, "claimUntil") WHERE processed = FALSE;

COMMIT;
