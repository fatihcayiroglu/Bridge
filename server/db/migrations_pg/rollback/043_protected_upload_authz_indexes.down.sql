-- 043_protected_upload_authz_indexes.down.sql
DROP INDEX IF EXISTS idx_gdm_messages_file_url_authz;
DROP INDEX IF EXISTS idx_dm_messages_file_url_authz;
DROP INDEX IF EXISTS idx_messages_file_url_authz;
