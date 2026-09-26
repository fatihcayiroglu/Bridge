-- 046_activitypub_message_visibility.sql
--
-- Close a privacy boundary in ActivityPub message persistence.
--
-- Historical behavior stored direct/private AP Create(Note) objects in the
-- same ap_messages table used by the public federated timeline, but did not
-- persist the audience classification. Timeline lookup filtered only actorUrl,
-- so a private note delivered to one local user's inbox could be returned to
-- another local follower of the same remote actor.
--
-- Fail-closed historical rule: rows that predate explicit visibility and have
-- targetUserId are classified as direct. This can hide old public inbox
-- deliveries, but it cannot expose a private note. Rows with no target are
-- classified public. New writes persist visibility explicitly.

BEGIN;

ALTER TABLE ap_messages
  ADD COLUMN IF NOT EXISTS visibility TEXT;

UPDATE ap_messages
SET visibility = CASE
  WHEN "targetUserId" IS NULL THEN 'public'
  ELSE 'direct'
END
WHERE visibility IS NULL;

ALTER TABLE ap_messages
  ALTER COLUMN visibility SET DEFAULT 'public';

ALTER TABLE ap_messages
  ALTER COLUMN visibility SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    WHERE r.relname = 'ap_messages'
      AND c.conname = 'ap_messages_visibility_check'
  ) THEN
    ALTER TABLE ap_messages
      ADD CONSTRAINT ap_messages_visibility_check
      CHECK (visibility IN ('public', 'direct')) NOT VALID;
  END IF;
END $$;

ALTER TABLE ap_messages
  VALIDATE CONSTRAINT ap_messages_visibility_check;

CREATE INDEX IF NOT EXISTS idx_ap_messages_visibility_actor
  ON ap_messages(visibility, "actorUrl", published DESC NULLS LAST);

COMMIT;
