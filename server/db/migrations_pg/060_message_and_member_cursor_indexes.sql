-- Composite keyset indexes for deterministic, bounded pagination.
--
-- Message cursors use `(createdAt, _id)` because millisecond timestamps are
-- not unique. Member cursors use `(joinedAt, userId)`. This index deliberately
-- is not partial: migration 029 owns the `banned` column, and a predicate on it
-- would make an isolated 029 rollback silently drop an object owned by 060.

CREATE INDEX IF NOT EXISTS idx_messages_channel_cursor
  ON messages("channelId", "createdAt" DESC, _id DESC);

CREATE INDEX IF NOT EXISTS idx_members_server_page
  ON members("serverId", "joinedAt" ASC, "userId" ASC);
