-- 066 — durable per-server notification watch words
CREATE TABLE IF NOT EXISTS notification_keywords (
  "userId" TEXT NOT NULL REFERENCES users(_id) ON DELETE CASCADE,
  "serverId" TEXT NOT NULL REFERENCES servers(_id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL,
  PRIMARY KEY ("userId", "serverId", keyword),
  CONSTRAINT notification_keywords_length CHECK (char_length(keyword) BETWEEN 2 AND 32)
);
CREATE INDEX IF NOT EXISTS idx_notification_keywords_match
  ON notification_keywords("serverId", keyword);
