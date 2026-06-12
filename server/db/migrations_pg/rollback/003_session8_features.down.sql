-- Rollback migration 003: dm readAt + canvas_strokes kaldır
BEGIN;
DROP INDEX IF EXISTS idx_canvas_ts;
DROP INDEX IF EXISTS idx_canvas_channel;
DROP TABLE IF EXISTS canvas_strokes;
ALTER TABLE dm_conversations DROP COLUMN IF EXISTS "readAt";
COMMIT;
