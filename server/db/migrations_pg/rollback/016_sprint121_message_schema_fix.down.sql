-- rollback/016_sprint121_message_schema_fix.down.sql
-- Sprint 121: mesaj/sunucu şema tamamlamasını geri al.

BEGIN;

ALTER TABLE messages DROP COLUMN IF EXISTS "deletedBy";
ALTER TABLE messages DROP COLUMN IF EXISTS "deletedAt";

ALTER TABLE servers  DROP COLUMN IF EXISTS "mfaLevel";

DROP INDEX IF EXISTS idx_rt_cleanup;
DROP INDEX IF EXISTS idx_rt_family;

ALTER TABLE messages DROP COLUMN IF EXISTS iv;
ALTER TABLE messages DROP COLUMN IF EXISTS "encryptedContent";
ALTER TABLE messages DROP COLUMN IF EXISTS embeds;
ALTER TABLE messages DROP COLUMN IF EXISTS "editedAt";
ALTER TABLE messages DROP COLUMN IF EXISTS "avatarUrl";

COMMIT;
