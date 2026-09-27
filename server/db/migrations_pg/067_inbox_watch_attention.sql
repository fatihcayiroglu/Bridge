-- 067 — distinguish watch-word attention from explicit mentions in Inbox
DROP INDEX IF EXISTS idx_notifications_inbox_message;
DROP INDEX IF EXISTS idx_notifications_inbox_unread;
DROP INDEX IF EXISTS idx_notifications_inbox_channel;

CREATE UNIQUE INDEX idx_notifications_inbox_message
  ON notifications("userId", "messageId")
  WHERE "messageId" IS NOT NULL AND type IN ('mention', 'reply', 'watch');
CREATE INDEX idx_notifications_inbox_unread
  ON notifications("userId", read, "createdAt" DESC)
  WHERE type IN ('mention', 'reply', 'watch');
CREATE INDEX idx_notifications_inbox_channel
  ON notifications("userId", "channelId", read)
  WHERE "channelId" IS NOT NULL AND type IN ('mention', 'reply', 'watch');
