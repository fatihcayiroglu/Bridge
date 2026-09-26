-- Search index alignment — the FTS index was unusable by the query that needs it.
--
-- MEASURED DEFECT (10,302 rows, live database):
--   query as written (with unaccent) → Seq Scan, 46.751 ms, 10,301 rows discarded
--   query matching the index         → Bitmap Index Scan, 0.556 ms
--   = 84x slower, degrading linearly with table size.
--
-- ROOT CAUSE: the index was built on
--     to_tsvector('simple', content || ' ' || "displayName")
-- while db/postgres/fts.ts queries
--     to_tsvector('simple', unaccent(content || ' ' || "displayName"))
-- Different expressions, so the planner cannot use the index.
--
-- The original author had no choice: single-argument unaccent() is STABLE, not
-- IMMUTABLE (it resolves its dictionary through search_path at run time), and
-- PostgreSQL refuses to index a non-IMMUTABLE expression. Dropping unaccent
-- from the query instead would break accent-insensitive search, which is a
-- product requirement for Turkish content ("gunaydin" must match "günaydın").
--
-- FIX: an IMMUTABLE wrapper that names the dictionary explicitly. The
-- two-argument form takes a regdictionary, so the result no longer depends on
-- search_path and can be declared IMMUTABLE truthfully — this is the standard
-- PostgreSQL technique, not a volatility lie.

CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE OR REPLACE FUNCTION bridge_unaccent(text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

COMMENT ON FUNCTION bridge_unaccent(text) IS
  'IMMUTABLE unaccent wrapper so accent-insensitive text can be indexed. '
  'Uses the explicit dictionary form; the bare unaccent() is only STABLE.';

-- Accent-insensitive FTS index matching db/postgres/fts.ts exactly.
CREATE INDEX IF NOT EXISTS idx_messages_fts_unaccent
  ON messages USING GIN(
    to_tsvector('simple', bridge_unaccent(coalesce(content,'') || ' ' || coalesce("displayName",'')))
  );

-- The previous index is provably unreachable: every FTS query path in
-- fts.ts applies unaccent, and the trigram/ILIKE fallbacks use their own
-- indexes. Keeping it would cost write throughput on every message insert
-- for no read benefit. Restored by rollback/027_rollback.sql.
DROP INDEX IF EXISTS idx_messages_fts;

-- Direct messages and thread replies were never searchable: fts.ts only ever
-- queried `messages`. Same expression, so one code path can serve all three.
CREATE INDEX IF NOT EXISTS idx_dm_messages_fts_unaccent
  ON dm_messages USING GIN(
    to_tsvector('simple', bridge_unaccent(coalesce(content,'') || ' ' || coalesce("displayName",'')))
  );

CREATE INDEX IF NOT EXISTS idx_thread_messages_fts_unaccent
  ON thread_messages USING GIN(
    to_tsvector('simple', bridge_unaccent(coalesce(content,'') || ' ' || coalesce("displayName",'')))
  );

-- Trigram fallback (typo tolerance) for the two newly-searchable stores.
-- `messages` already has idx_messages_trgm.
CREATE INDEX IF NOT EXISTS idx_dm_messages_trgm
  ON dm_messages USING GIN(content gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_thread_messages_trgm
  ON thread_messages USING GIN(content gin_trgm_ops);
