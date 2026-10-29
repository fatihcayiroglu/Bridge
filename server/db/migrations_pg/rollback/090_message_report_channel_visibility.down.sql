-- 090 down: drop the recorded channel visibility of gone channels' reports.
-- Fail-safe: without it every gone channel's reports are ADMIN-only again
-- (the pre-090 rule); no report or evidence is removed.
ALTER TABLE message_reports DROP CONSTRAINT IF EXISTS message_reports_channel_visibility_check;
ALTER TABLE message_reports DROP COLUMN IF EXISTS "channelVisibility";
