-- 069_message_stickers.sql
-- Canonical message-level sticker snapshot. Sticker asset bytes remain immutable.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sticker JSONB;

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_sticker_shape_check;
ALTER TABLE messages ADD CONSTRAINT messages_sticker_shape_check CHECK (
  sticker IS NULL OR (
    jsonb_typeof(sticker) = 'object'
    AND jsonb_typeof(sticker->'id') = 'string'
    AND jsonb_typeof(sticker->'packId') = 'string'
    AND jsonb_typeof(sticker->'name') = 'string'
    AND jsonb_typeof(sticker->'url') = 'string'
    AND jsonb_typeof(sticker->'width') = 'number'
    AND jsonb_typeof(sticker->'height') = 'number'
  )
);
