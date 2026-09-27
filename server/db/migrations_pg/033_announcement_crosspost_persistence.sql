-- Migration 033: durable/idempotent announcement crossposts
BEGIN;

CREATE TABLE IF NOT EXISTS crosspost_log (
  _id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "messageId" TEXT NOT NULL,
  "sourceChannelId" TEXT NOT NULL,
  "sourceServerId" TEXT NOT NULL,
  "targetChannelId" TEXT NOT NULL,
  "targetServerId" TEXT NOT NULL,
  "bridgeMessageId" TEXT NOT NULL UNIQUE,
  "crosspostedAt" BIGINT NOT NULL,
  UNIQUE("messageId","targetChannelId")
);
CREATE INDEX IF NOT EXISTS idx_crosspost_log_source
  ON crosspost_log("messageId","sourceChannelId");
CREATE INDEX IF NOT EXISTS idx_crosspost_log_target
  ON crosspost_log("targetChannelId","crosspostedAt" DESC);

COMMIT;
