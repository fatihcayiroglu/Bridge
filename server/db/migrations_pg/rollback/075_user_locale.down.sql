-- 075_user_locale.down.sql
--
-- Structurally lossless. Data consequence: the server forgets which language each person reads
-- and falls back to its default locale for push copy.
ALTER TABLE users DROP COLUMN IF EXISTS locale;
