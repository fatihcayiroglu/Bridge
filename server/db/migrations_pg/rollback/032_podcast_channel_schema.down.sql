-- Rollback migration 032.
-- Data-bearing legacy columns are intentionally retained; rollback removes only the
-- additive canonical indexes/columns where doing so is safe. Do not re-add NOT NULL
-- constraints to serverId/audioUrl because existing channel-scoped rows may violate them.
DROP INDEX IF EXISTS idx_podcast_episodes_published;
DROP INDEX IF EXISTS idx_podcast_episodes_channel;
DROP INDEX IF EXISTS idx_podcast_settings_channel;
ALTER TABLE podcast_episodes DROP COLUMN IF EXISTS "createdBy";
ALTER TABLE podcast_episodes DROP COLUMN IF EXISTS published;
ALTER TABLE podcast_episodes DROP COLUMN IF EXISTS episode;
ALTER TABLE podcast_episodes DROP COLUMN IF EXISTS season;
ALTER TABLE podcast_episodes DROP COLUMN IF EXISTS "durationSeconds";
ALTER TABLE podcast_episodes DROP COLUMN IF EXISTS "fileSize";
ALTER TABLE podcast_episodes DROP COLUMN IF EXISTS "mimeType";
ALTER TABLE podcast_episodes DROP COLUMN IF EXISTS filename;
ALTER TABLE podcast_episodes DROP COLUMN IF EXISTS "channelId";
ALTER TABLE podcast_settings DROP COLUMN IF EXISTS explicit;
ALTER TABLE podcast_settings DROP COLUMN IF EXISTS category;
ALTER TABLE podcast_settings DROP COLUMN IF EXISTS language;
ALTER TABLE podcast_settings DROP COLUMN IF EXISTS "imageUrl";
ALTER TABLE podcast_settings DROP COLUMN IF EXISTS author;
ALTER TABLE podcast_settings DROP COLUMN IF EXISTS "channelId";
