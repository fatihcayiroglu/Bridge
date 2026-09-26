-- Rollback for 027_search_index_alignment.sql
--
-- Restores the original (index-unusable) FTS index and removes the aligned
-- indexes plus the IMMUTABLE unaccent wrapper. Search returns to sequential
-- scans, and DM / thread replies become unsearchable again.

CREATE INDEX IF NOT EXISTS idx_messages_fts ON messages USING GIN(
  to_tsvector('simple', coalesce(content,'') || ' ' || coalesce("displayName",''))
);

DROP INDEX IF EXISTS idx_thread_messages_trgm;
DROP INDEX IF EXISTS idx_dm_messages_trgm;
DROP INDEX IF EXISTS idx_thread_messages_fts_unaccent;
DROP INDEX IF EXISTS idx_dm_messages_fts_unaccent;
DROP INDEX IF EXISTS idx_messages_fts_unaccent;

-- Dropped last: the indexes above depend on it.
DROP FUNCTION IF EXISTS bridge_unaccent(text);
