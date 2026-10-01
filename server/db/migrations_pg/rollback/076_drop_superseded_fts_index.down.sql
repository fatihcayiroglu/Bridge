-- 076_drop_superseded_fts_index.down.sql
--
-- Intentionally empty. On the canonical chain the index does not exist before 076
-- (027 dropped it), so the structurally lossless reversal is "nothing". Restoring the
-- old index is 027's rollback (rollback/027_search_index_alignment.down.sql).
SELECT 1;
