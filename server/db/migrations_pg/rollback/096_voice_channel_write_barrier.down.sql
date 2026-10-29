-- Schema-only reversal: no data or durable cleanup intents are removed.
-- Restore 086's previous erasure definition; remove only 096's voice triggers.
-- Reversal removes voice expiry admission and the exact author-erasure fix;
-- roll forward to restore both. No CASCADE or storage side effects.
DROP TRIGGER IF EXISTS zz_channel_final_admission ON voice_messages;
DROP TRIGGER IF EXISTS channel_write_barrier ON voice_messages;

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
    IF col IN ('username', 'displayName', 'avatarColor', 'avatarUrl') THEN
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
