-- P1 chat: durable per-user/per-channel chronological read position.
-- This is intentionally NOT stored in unread_counts; that table is an
-- attention/notification counter and cannot identify the first unread message.
CREATE TABLE IF NOT EXISTS channel_read_positions (
  "userId" TEXT NOT NULL REFERENCES users(_id) ON DELETE CASCADE,
  "channelId" TEXT NOT NULL REFERENCES channels(_id) ON DELETE CASCADE,
  "lastReadAt" BIGINT NOT NULL,
  "lastReadMessageId" TEXT NOT NULL,
  "updatedAt" BIGINT NOT NULL,
  PRIMARY KEY ("userId", "channelId")
);
CREATE INDEX IF NOT EXISTS idx_channel_read_positions_user
  ON channel_read_positions("userId", "updatedAt" DESC);
