-- Soundboard library completion: bounded pagination metadata and durable
-- per-user favorite/recent/frequency state. Built-in `global:*` sounds are
-- trusted application catalog IDs, so soundId intentionally has no FK to the
-- server-owned soundboard table.

ALTER TABLE soundboard ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'Server';
ALTER TABLE soundboard ADD COLUMN IF NOT EXISTS "durationSeconds" DOUBLE PRECISION;
ALTER TABLE soundboard ADD COLUMN IF NOT EXISTS "mimeType" TEXT;
ALTER TABLE soundboard ADD COLUMN IF NOT EXISTS "fileSize" BIGINT;
ALTER TABLE soundboard ADD COLUMN IF NOT EXISTS "updatedAt" BIGINT;

-- Upgrade constraints are added NOT VALID first. PostgreSQL still enforces
-- them for every new/updated row without letting dirty legacy data abort the
-- ADD. Each constraint is then validated in its own subtransaction: clean
-- upgrades converge to the fully validated fresh schema, while the one narrow
-- data-violation class leaves a dirty legacy constraint NOT VALID.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'soundboard_name_length' AND conrelid = 'soundboard'::regclass) THEN
    ALTER TABLE soundboard ADD CONSTRAINT soundboard_name_length CHECK (char_length(name) BETWEEN 1 AND 32) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'soundboard_emoji_length' AND conrelid = 'soundboard'::regclass) THEN
    ALTER TABLE soundboard ADD CONSTRAINT soundboard_emoji_length CHECK (char_length(emoji) BETWEEN 1 AND 32) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'soundboard_category_length' AND conrelid = 'soundboard'::regclass) THEN
    ALTER TABLE soundboard ADD CONSTRAINT soundboard_category_length CHECK (char_length(category) BETWEEN 1 AND 32) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'soundboard_duration_bounds' AND conrelid = 'soundboard'::regclass) THEN
    ALTER TABLE soundboard ADD CONSTRAINT soundboard_duration_bounds CHECK ("durationSeconds" > 0 AND "durationSeconds" <= 5) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'soundboard_file_size_bounds' AND conrelid = 'soundboard'::regclass) THEN
    ALTER TABLE soundboard ADD CONSTRAINT soundboard_file_size_bounds CHECK ("fileSize" IS NULL OR ("fileSize" > 0 AND "fileSize" <= 5242880)) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_soundboard_server' AND conrelid = 'soundboard'::regclass) THEN
    ALTER TABLE soundboard ADD CONSTRAINT fk_soundboard_server FOREIGN KEY ("serverId") REFERENCES servers(_id) ON DELETE CASCADE NOT VALID;
  END IF;

  BEGIN
    ALTER TABLE soundboard VALIDATE CONSTRAINT soundboard_name_length;
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'soundboard_name_length remains NOT VALID because legacy rows violate it';
  END;
  BEGIN
    ALTER TABLE soundboard VALIDATE CONSTRAINT soundboard_emoji_length;
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'soundboard_emoji_length remains NOT VALID because legacy rows violate it';
  END;
  BEGIN
    ALTER TABLE soundboard VALIDATE CONSTRAINT soundboard_category_length;
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'soundboard_category_length remains NOT VALID because legacy rows violate it';
  END;
  BEGIN
    ALTER TABLE soundboard VALIDATE CONSTRAINT soundboard_duration_bounds;
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'soundboard_duration_bounds remains NOT VALID because legacy rows violate it';
  END;
  BEGIN
    ALTER TABLE soundboard VALIDATE CONSTRAINT soundboard_file_size_bounds;
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'soundboard_file_size_bounds remains NOT VALID because legacy rows violate it';
  END;
  BEGIN
    ALTER TABLE soundboard VALIDATE CONSTRAINT fk_soundboard_server;
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'fk_soundboard_server remains NOT VALID because legacy rows violate it';
  END;
END $$;

CREATE INDEX IF NOT EXISTS idx_soundboard_server_page ON soundboard("serverId", "createdAt" DESC, _id DESC);
CREATE INDEX IF NOT EXISTS idx_soundboard_server_name ON soundboard("serverId", lower(name));

CREATE TABLE IF NOT EXISTS soundboard_user_stats (
  "userId" TEXT NOT NULL REFERENCES users(_id) ON DELETE CASCADE,
  "soundId" TEXT NOT NULL,
  "serverId" TEXT REFERENCES servers(_id) ON DELETE CASCADE,
  favorite BOOLEAN NOT NULL DEFAULT FALSE,
  "favoritedAt" BIGINT,
  "playCount" BIGINT NOT NULL DEFAULT 0 CHECK ("playCount" >= 0),
  "lastPlayedAt" BIGINT,
  PRIMARY KEY ("userId", "soundId"),
  CONSTRAINT soundboard_stats_favorite_time CHECK (favorite = ("favoritedAt" IS NOT NULL)),
  CONSTRAINT soundboard_stats_play_time CHECK (("playCount" = 0) = ("lastPlayedAt" IS NULL)),
  CONSTRAINT soundboard_stats_scope CHECK (("serverId" IS NULL AND "soundId" LIKE 'global:%') OR ("serverId" IS NOT NULL AND "soundId" NOT LIKE 'global:%'))
);

CREATE INDEX IF NOT EXISTS idx_soundboard_stats_favorites
  ON soundboard_user_stats("userId", "favoritedAt" DESC, "soundId" DESC)
  WHERE favorite = TRUE;
CREATE INDEX IF NOT EXISTS idx_soundboard_stats_recent
  ON soundboard_user_stats("userId", "lastPlayedAt" DESC, "soundId" DESC)
  WHERE "playCount" > 0;
CREATE INDEX IF NOT EXISTS idx_soundboard_stats_frequent
  ON soundboard_user_stats("userId", "playCount" DESC, "lastPlayedAt" DESC, "soundId" DESC)
  WHERE "playCount" > 0;
