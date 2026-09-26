-- 069_message_stickers.down.sql
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_sticker_shape_check;
ALTER TABLE messages DROP COLUMN IF EXISTS sticker;
