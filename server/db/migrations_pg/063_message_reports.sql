-- P1 moderation: durable, duplicate-safe user message reports.
CREATE TABLE IF NOT EXISTS message_reports (
  _id          TEXT PRIMARY KEY,
  "serverId"  TEXT NOT NULL REFERENCES servers(_id) ON DELETE CASCADE,
  "channelId" TEXT NOT NULL REFERENCES channels(_id) ON DELETE CASCADE,
  "messageId" TEXT NOT NULL REFERENCES messages(_id) ON DELETE CASCADE,
  "reporterId" TEXT NOT NULL REFERENCES users(_id) ON DELETE CASCADE,
  reason       TEXT NOT NULL,
  detail       TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'open',
  "createdAt" BIGINT NOT NULL,
  "resolvedAt" BIGINT,
  "resolvedBy" TEXT REFERENCES users(_id) ON DELETE SET NULL,
  resolution   TEXT,
  CHECK (reason IN ('spam','harassment','hate','sexual','violence','other')),
  CHECK (status IN ('open','resolved','dismissed')),
  CHECK (resolution IS NULL OR resolution IN ('resolved','dismissed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_reports_open_unique
  ON message_reports("reporterId", "messageId") WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_message_reports_server_open
  ON message_reports("serverId", status, "createdAt" DESC, _id DESC);
CREATE INDEX IF NOT EXISTS idx_message_reports_channel_open
  ON message_reports("channelId", status, "createdAt" DESC, _id DESC);
