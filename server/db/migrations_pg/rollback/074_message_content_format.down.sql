-- 074_message_content_format.down.sql
--
-- Structurally lossless. Data consequence: rows written RAW after 074 lose their marker and
-- are read as LEGACY, i.e. decoded once. Text that literally contains an entity such as
-- "&amp;" would then be shown as "&". No markup is ever rendered either way.
ALTER TABLE messages DROP COLUMN IF EXISTS "contentFormat";
