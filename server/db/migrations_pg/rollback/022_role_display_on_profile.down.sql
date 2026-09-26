-- rollback/022_role_display_on_profile.down.sql
-- Rol rozetinin profilde gösterilme tercihini geri al.

BEGIN;

ALTER TABLE roles DROP COLUMN IF EXISTS "displayOnProfile";

COMMIT;
