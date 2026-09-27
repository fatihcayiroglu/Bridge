-- Storage format of channel message text (Final21 Phase 16).
--
-- 0 = LEGACY: written through the HTML sanitizer; "<", ">", "&" kept as entities and
--     markup-looking text rewritten. Decoded once on read.
-- 1 = RAW:    the text as typed (bounded, invisible control characters removed).
--
-- Measured before this column: 3 of 13 ordinary inputs survived a write
-- (`Vec<String>` -> `Vec`, `if (a<b && c>d)` -> `if (a<b>d) {}</b>`). Every row that exists
-- today is LEGACY and keeps rendering exactly as it did; new writes store RAW. History is
-- deliberately not rewritten: the sanitizer's losses cannot be undone.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS "contentFormat" SMALLINT NOT NULL DEFAULT 0;
