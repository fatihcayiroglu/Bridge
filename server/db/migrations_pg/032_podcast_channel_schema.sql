-- Migration 032: align PodcastRepository/runtime with PostgreSQL schema.
-- The runtime is channel-scoped; the historical inline tables were server-scoped.
-- This is additive/non-destructive: legacy columns remain readable while new rows use
-- canonical channel-scoped fields.

ALTER TABLE podcast_settings ADD COLUMN IF NOT EXISTS "channelId" TEXT;
ALTER TABLE podcast_settings ADD COLUMN IF NOT EXISTS author TEXT;
ALTER TABLE podcast_settings ADD COLUMN IF NOT EXISTS "imageUrl" TEXT;
ALTER TABLE podcast_settings ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'tr';
ALTER TABLE podcast_settings ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'Technology';
ALTER TABLE podcast_settings ADD COLUMN IF NOT EXISTS explicit BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE podcast_settings ALTER COLUMN "serverId" DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_podcast_settings_channel
  ON podcast_settings("channelId") WHERE "channelId" IS NOT NULL;

ALTER TABLE podcast_episodes ADD COLUMN IF NOT EXISTS "channelId" TEXT;
ALTER TABLE podcast_episodes ADD COLUMN IF NOT EXISTS filename TEXT;
ALTER TABLE podcast_episodes ADD COLUMN IF NOT EXISTS "mimeType" TEXT NOT NULL DEFAULT 'audio/mpeg';
ALTER TABLE podcast_episodes ADD COLUMN IF NOT EXISTS "fileSize" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE podcast_episodes ADD COLUMN IF NOT EXISTS "durationSeconds" INTEGER;
ALTER TABLE podcast_episodes ADD COLUMN IF NOT EXISTS season INTEGER;
ALTER TABLE podcast_episodes ADD COLUMN IF NOT EXISTS episode INTEGER;
ALTER TABLE podcast_episodes ADD COLUMN IF NOT EXISTS published BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE podcast_episodes ADD COLUMN IF NOT EXISTS "createdBy" TEXT;
ALTER TABLE podcast_episodes ALTER COLUMN "serverId" DROP NOT NULL;
ALTER TABLE podcast_episodes ALTER COLUMN "audioUrl" DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_podcast_episodes_channel
  ON podcast_episodes("channelId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_podcast_episodes_published
  ON podcast_episodes("channelId", published, "publishedAt" DESC);
