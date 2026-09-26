-- Group DM messages were the fourth message store, and the only one still
-- unsearchable after 027.
--
-- Messages live in FOUR tables: messages, dm_messages, thread_messages and
-- group_dm_messages. 027 aligned and indexed the first three; group DMs were
-- missed, so `unifiedFtsSearch` could not reach them without forcing a
-- sequential scan on every query.
--
-- Same expression as 027 — it must match db/postgres/fts.ts character for
-- character, or the planner cannot use the index (that mismatch was the
-- original defect 027 fixed).

CREATE INDEX IF NOT EXISTS idx_group_dm_messages_fts_unaccent
  ON group_dm_messages USING GIN(
    to_tsvector('simple', bridge_unaccent(coalesce(content,'') || ' ' || coalesce("displayName",'')))
  );

-- Trigram fallback (typo tolerance), matching the other three stores.
CREATE INDEX IF NOT EXISTS idx_group_dm_messages_trgm
  ON group_dm_messages USING GIN(content gin_trgm_ops);

-- Membership lookup: every group DM search joins group_dm_members on the
-- searching user. schema.sql declares this index, but it is created only on
-- a fresh install — existing databases predate it.
CREATE INDEX IF NOT EXISTS idx_gdm_members_user
  ON group_dm_members("userId");
