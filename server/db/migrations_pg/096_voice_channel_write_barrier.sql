-- 096: voice attachments and transcripts share the canonical D2 write policy.
-- 093-095 are reserved by the existing P7 offline-grant review branch (#502).
-- Depends on 086 (initial admission/erasure) and 092 (final statement admission).
-- Do not duplicate their database-clock, tenant, tombstone or snapshot policy.
-- BEFORE locks the channel before upload references; AFTER rechecks after any
-- later upload/index wait and rejects stale repeatable-read snapshots.
-- This is schema-only: existing voice data, moderation evidence, tombstones,
-- reservations and pending object-release entries are never rewritten/deleted.

CREATE OR REPLACE FUNCTION bridge_channel_update_is_erasure(old_row JSONB, new_row JSONB) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $erasure$
DECLARE
  col       TEXT;
  new_value JSONB;
  old_value JSONB;
  deleting  BOOLEAN := (new_row ->> 'deletedAt') IS NOT NULL;
BEGIN
  FOR col, new_value IN SELECT key, value FROM jsonb_each(new_row) LOOP
    old_value := old_row -> col;
    CONTINUE WHEN new_value IS NOT DISTINCT FROM old_value;
    -- Match accountLifecycle.TOMBSTONE_USER_ID and accountErasure's snapshots.
    -- Changing only identity, retaining an author snapshot, or coupling new
    -- content/transcript/title to anonymization must not bypass expiry.
    IF col IN ('userId', 'createdBy') THEN
      CONTINUE WHEN new_value = '"deleted-user"'::jsonb
        AND (NOT new_row ? 'username' OR new_row -> 'username' = '""'::jsonb)
        AND (NOT new_row ? 'displayName' OR new_row -> 'displayName' = '""'::jsonb)
        AND (NOT new_row ? 'avatarColor' OR new_row -> 'avatarColor' = '"#2d9cdb"'::jsonb)
        AND (NOT new_row ? 'avatarUrl' OR new_row -> 'avatarUrl' = 'null'::jsonb);
    ELSIF col IN ('username', 'displayName', 'avatarColor', 'avatarUrl') THEN
      CONTINUE;
    ELSIF col = 'deletedAt' THEN
      CONTINUE WHEN deleting;
    ELSIF col = 'deletedBy' THEN
      CONTINUE WHEN deleting;
    ELSIF col = 'embedding' THEN
      CONTINUE WHEN new_value = 'null'::jsonb;
    ELSIF col = 'replyTo' THEN
      CONTINUE WHEN new_value = 'null'::jsonb;
      CONTINUE WHEN jsonb_typeof(new_value) = 'object' AND jsonb_typeof(old_value) = 'object'
                AND old_value @> (new_value - 'deleted')
                AND (NOT new_value ? 'deleted' OR new_value -> 'deleted' = 'true'::jsonb);
    ELSIF col IN ('content', 'embeds', 'encryptedContent', 'iv', 'fileUrl', 'fileName',
                  'fileType', 'editHistory', 'transcript') THEN
      CONTINUE WHEN deleting AND new_value IN ('null'::jsonb, '""'::jsonb, '[]'::jsonb, '{}'::jsonb,
                                               '"[Mesaj silindi]"'::jsonb);
    END IF;
    RETURN FALSE;
  END LOOP;
  RETURN TRUE;
END
$erasure$;

DROP TRIGGER IF EXISTS channel_write_barrier ON voice_messages;
CREATE TRIGGER channel_write_barrier
  BEFORE INSERT OR UPDATE ON voice_messages
  FOR EACH ROW EXECUTE FUNCTION bridge_channel_write_barrier();

DROP TRIGGER IF EXISTS zz_channel_final_admission ON voice_messages;
CREATE TRIGGER zz_channel_final_admission
  AFTER INSERT OR UPDATE ON voice_messages
  FOR EACH ROW EXECUTE FUNCTION bridge_channel_copy_source_barrier();
