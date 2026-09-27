-- Unified Inbox: persistent channel attention + canonical GDM read cursor.
--
-- Channel inbox rows intentionally store only canonical identifiers. The read
-- endpoint re-loads the message/channel and re-checks VIEW_CHANNELS, so a
-- later permission revocation cannot leave a metadata snapshot behind.

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS "serverId" TEXT,
  ADD COLUMN IF NOT EXISTS "channelId" TEXT,
  ADD COLUMN IF NOT EXISTS "messageId" TEXT,
  ADD COLUMN IF NOT EXISTS "actorId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_inbox_message
  ON notifications("userId", "messageId")
  WHERE "messageId" IS NOT NULL AND type IN ('mention', 'reply');

CREATE INDEX IF NOT EXISTS idx_notifications_inbox_unread
  ON notifications("userId", read, "createdAt" DESC)
  WHERE type IN ('mention', 'reply');

CREATE INDEX IF NOT EXISTS idx_notifications_inbox_channel
  ON notifications("userId", "channelId", read)
  WHERE "channelId" IS NOT NULL AND type IN ('mention', 'reply');

ALTER TABLE group_dm_members
  ADD COLUMN IF NOT EXISTS "readAt" BIGINT;

CREATE INDEX IF NOT EXISTS idx_gdm_members_unread_cursor
  ON group_dm_members("userId", "groupId", "readAt");
