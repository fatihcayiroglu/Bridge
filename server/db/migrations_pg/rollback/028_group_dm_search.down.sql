-- Rollback for 028_group_dm_search.sql
--
-- Group DM messages become unsearchable again (any query against them falls
-- back to a sequential scan).
--
-- ── DUZELTILDI: idx_gdm_members_user GERIDE BIRAKILIYORDU ───────────────────
-- Bu betik onceden su gerekceyle o indeksi BIRAKIYORDU:
--     "idx_gdm_members_user is left in place: it is declared by schema.sql"
-- Bu iddia YANLISTI. Depoda o indeksi olusturan TEK kaynak 028'in kendisidir
-- (schema.ts, migrations.ts ve diger migration'lar taranarak dogrulandi).
-- Dolayisiyla geri alma sonrasi 028 ONCESI duruma donulmuyor, indeks kaliyordu.
-- Rollback dogrulayicisinin DOWN_INCOMPLETE denetimi bunu yakaladi.
DROP INDEX IF EXISTS idx_gdm_members_user;
DROP INDEX IF EXISTS idx_group_dm_messages_trgm;
DROP INDEX IF EXISTS idx_group_dm_messages_fts_unaccent;
