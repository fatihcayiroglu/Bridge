-- 043_protected_upload_authz_indexes.sql
-- Keep per-byte protected upload authorization current without caching stale
-- message/DM/GDM ownership relationships. Partial indexes make the exact
-- fileUrl lookups cheap while excluding the overwhelmingly common NULL rows.

CREATE INDEX IF NOT EXISTS idx_messages_file_url_authz
  ON messages("fileUrl") WHERE "fileUrl" IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dm_messages_file_url_authz
  ON dm_messages("fileUrl") WHERE "fileUrl" IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gdm_messages_file_url_authz
  ON group_dm_messages("fileUrl") WHERE "fileUrl" IS NOT NULL;
