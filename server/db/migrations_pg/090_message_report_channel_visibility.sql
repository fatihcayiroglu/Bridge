-- 090: P7 D2 x B5 — who may review a report once its channel is gone.
--
-- 088 keeps reports after their channel is deleted or expires. The channel's
-- permission overrides are deleted with it, so the moderation routes can no
-- longer tell whether a server-level moderator could see that channel; they
-- therefore allow only ADMIN for a gone channel's reports (a private channel
-- must never become readable to moderators it hid from).
--
-- This column records, at the moment the channel is claimed by the expiry
-- worker or deleted, whether any override (channel_permissions or the legacy
-- channel_overrides) denied VIEW_CHANNELS or MANAGE_MESSAGES in it:
--   'restricted' — some role or member was denied: ADMIN only, as before;
--   'open'       — no override narrowed it: server-level VIEW_CHANNELS +
--                  MANAGE_MESSAGES may keep reviewing its reports;
--   NULL         — live channel, or gone before this migration: ADMIN only.
-- Nothing is inferred for existing rows (fail closed).
ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS "channelVisibility" TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'message_reports'::regclass
                  AND conname = 'message_reports_channel_visibility_check') THEN
    ALTER TABLE message_reports ADD CONSTRAINT message_reports_channel_visibility_check
      CHECK ("channelVisibility" IS NULL OR "channelVisibility" IN ('open', 'restricted'));
  END IF;
END $$;
