-- Roll back watch-word Inbox index coverage. Existing watch rows remain data,
-- but older code will no longer query them.
DROP INDEX IF EXISTS idx_notifications_inbox_message;
DROP INDEX IF EXISTS idx_notifications_inbox_unread;
DROP INDEX IF EXISTS idx_notifications_inbox_channel;

CREATE UNIQUE INDEX idx_notifications_inbox_message
  ON notifications("userId", "messageId")
  WHERE "messageId" IS NOT NULL AND type IN ('mention', 'reply');
CREATE INDEX idx_notifications_inbox_unread
  ON notifications("userId", read, "createdAt" DESC)
  WHERE type IN ('mention', 'reply');
CREATE INDEX idx_notifications_inbox_channel
  ON notifications("userId", "channelId", read)
  WHERE "channelId" IS NOT NULL AND type IN ('mention', 'reply');
