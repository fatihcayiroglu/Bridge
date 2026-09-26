-- 045_notification_prefs_contract.sql
--
-- Close the runtime/PostgreSQL contract for notification preferences.
--
-- Measured source defect:
--   * routes/notificationPrefs.ts persists `muteUntil`, while canonical
--     schema.ts had no such column -> real PostgreSQL writes could fail.
--   * server-level prefs are encoded canonically as channelId=`server:<id>`;
--     no `serverId` / `isServerLevel` columns belong to this table.
--   * read-then-insert upserts had no unique (userId, channelId) owner, so two
--     concurrent nodes could create duplicate preference rows.
--
-- Existing duplicate rows are deterministically collapsed before the unique
-- index: newest updatedAt wins, then lexicographically greatest _id as tie-break.
-- Invalid historical levels are NOT rewritten because intent is unknowable.
-- The NOT VALID constraint protects all new/updated rows immediately; it is
-- validated only when historical rows are already clean.

BEGIN;

ALTER TABLE notification_prefs
  ADD COLUMN IF NOT EXISTS "muteUntil" BIGINT;

DELETE FROM notification_prefs older
USING notification_prefs newer
WHERE older."userId" = newer."userId"
  AND older."channelId" = newer."channelId"
  AND (
    older."updatedAt" < newer."updatedAt"
    OR (older."updatedAt" = newer."updatedAt" AND older._id < newer._id)
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_prefs_user_channel_unique
  ON notification_prefs("userId", "channelId");

DO $$
DECLARE
  bad_levels BIGINT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    WHERE r.relname = 'notification_prefs'
      AND c.conname = 'notification_prefs_level_check'
  ) THEN
    ALTER TABLE notification_prefs
      ADD CONSTRAINT notification_prefs_level_check
      CHECK (level IN ('all', 'mentions', 'mute', 'default')) NOT VALID;
  END IF;

  SELECT count(*) INTO bad_levels
    FROM notification_prefs
    WHERE level IS NULL OR level NOT IN ('all', 'mentions', 'mute', 'default');

  IF bad_levels = 0 THEN
    ALTER TABLE notification_prefs
      VALIDATE CONSTRAINT notification_prefs_level_check;
  ELSE
    RAISE WARNING
      '[045] notification_prefs contains % invalid level row(s); constraint left NOT VALID. Runtime reads fail closed. Inspect and repair before VALIDATE.',
      bad_levels;
  END IF;
END $$;

COMMIT;
