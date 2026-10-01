-- 076 — remove the superseded message FTS index that boot kept recreating (P5 SH-04).
--
-- Migration 027 replaced idx_messages_fts with idx_messages_fts_unaccent (the only
-- expression db/postgres/fts.ts can use) and dropped the old one as unreachable — a
-- write cost on every message insert with no read benefit. But the boot schema
-- (schema.ts) and an inline migration still created idx_messages_fts on EVERY start,
-- so any deployment that restarted after 027 carried it again. Measured on a fresh
-- install: first boot without it, second boot with it. Boot no longer creates it;
-- this removes the copies earlier boots recreated.
DROP INDEX IF EXISTS idx_messages_fts;
