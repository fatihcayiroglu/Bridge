-- Migration 012: Sprint 94 — Announcement Channel Follows
BEGIN;

CREATE TABLE IF NOT EXISTS channel_follows (
  _id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "sourceChannelId" TEXT NOT NULL,
  "sourceServerId"  TEXT NOT NULL,
  "targetChannelId" TEXT NOT NULL,
  "targetServerId"  TEXT NOT NULL,
  "followedAt"      BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
  "followedByUserId" TEXT NOT NULL,
  UNIQUE("sourceChannelId","targetChannelId")
);
CREATE INDEX IF NOT EXISTS idx_channel_follows_source ON channel_follows("sourceChannelId");
CREATE INDEX IF NOT EXISTS idx_channel_follows_target ON channel_follows("targetChannelId");

COMMIT;
