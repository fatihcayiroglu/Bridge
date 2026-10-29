-- 091: serialize upload-reference writers with post-commit object deletion.
-- A batch's negative reference result is unsafe unless new references cannot
-- appear before its storage calls finish. A durable reservation closes that
-- window and also refuses delayed references after the bytes have been deleted.
-- No existing objects or references are deleted or rewritten by this migration.
CREATE TABLE IF NOT EXISTS upload_release_keys (
  key TEXT PRIMARY KEY CHECK (char_length(key) BETWEEN 1 AND 512),
  reserved BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_upload_release_keys_unreserved
  ON upload_release_keys (key) WHERE NOT reserved;

CREATE OR REPLACE FUNCTION bridge_guard_upload_release_reference()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  doc JSONB := to_jsonb(NEW);
  field TEXT;
  value TEXT;
  upload_key TEXT;
  upload_keys TEXT[] := '{}';
  deleting BOOLEAN;
BEGIN
  FOREACH field IN ARRAY TG_ARGV LOOP
    IF TG_OP = 'UPDATE' AND doc->split_part(field, '.', 1)
       IS NOT DISTINCT FROM to_jsonb(OLD)->split_part(field, '.', 1) THEN CONTINUE; END IF;
    IF field LIKE 'serverProfile.%' THEN
      value := doc->'serverProfile'->>split_part(field, '.', 2);
    ELSIF field = 'filename' THEN
      value := 'uploads/' || (doc->>field);
    ELSE
      value := doc->>field;
    END IF;
    -- Same suffix equivalence as the live-reference check: canonical relative
    -- keys and absolute URLs ending with that key both retain the object.
    upload_key := substring(value FROM '(?:^|/)(uploads/(?:[^/]+/)?[^/]+)$');
    IF upload_key IS NULL OR char_length(upload_key) > 512
       OR upload_key !~ '^uploads/[A-Za-z0-9._/-]+$'
       OR upload_key ~ '(^|/)\.\.?(/|$)' THEN CONTINUE; END IF;
    upload_keys := array_append(upload_keys, upload_key);
  END LOOP;
  -- Match the releaser's order when one row references several objects.
  FOR upload_key IN SELECT DISTINCT unnest(upload_keys) ORDER BY 1 LOOP
    -- An UPSERT, rather than an advisory lock plus a snapshot read, also
    -- fails closed for a writer using REPEATABLE READ or SERIALIZABLE.
    -- Hold this row lock until the referencing write commits.
    INSERT INTO upload_release_keys AS k (key, reserved) VALUES (upload_key, FALSE)
      ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key
      RETURNING k.reserved INTO deleting;
    IF deleting THEN
      RAISE EXCEPTION 'upload_release_reserved' USING ERRCODE = '55000';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

-- Keep this inventory aligned with UPLOAD_REFS_CTE. Ownership metadata in
-- uploads is fenced too, although it is not itself a content reference.
CREATE TRIGGER guard_upload_release_reference BEFORE INSERT OR UPDATE OF "fileUrl"
  ON messages FOR EACH ROW EXECUTE FUNCTION bridge_guard_upload_release_reference('fileUrl');
CREATE TRIGGER guard_upload_release_reference BEFORE INSERT OR UPDATE OF "fileUrl"
  ON dm_messages FOR EACH ROW EXECUTE FUNCTION bridge_guard_upload_release_reference('fileUrl');
CREATE TRIGGER guard_upload_release_reference BEFORE INSERT OR UPDATE OF "fileUrl"
  ON group_dm_messages FOR EACH ROW EXECUTE FUNCTION bridge_guard_upload_release_reference('fileUrl');
CREATE TRIGGER guard_upload_release_reference BEFORE INSERT OR UPDATE OF "avatarUrl", "bannerUrl"
  ON users FOR EACH ROW EXECUTE FUNCTION bridge_guard_upload_release_reference('avatarUrl', 'bannerUrl');
CREATE TRIGGER guard_upload_release_reference BEFORE INSERT OR UPDATE OF "iconUrl", "bannerUrl"
  ON servers FOR EACH ROW EXECUTE FUNCTION bridge_guard_upload_release_reference('iconUrl', 'bannerUrl');
-- Use a row trigger for fields introduced by older reversible migrations:
-- pinning those columns with UPDATE OF would prevent their ordered rollback.
CREATE TRIGGER guard_upload_release_reference BEFORE INSERT OR UPDATE
  ON members FOR EACH ROW EXECUTE FUNCTION bridge_guard_upload_release_reference('serverProfile.avatarUrl', 'serverProfile.bannerUrl');
CREATE TRIGGER guard_upload_release_reference BEFORE INSERT OR UPDATE OF url
  ON server_gifs FOR EACH ROW EXECUTE FUNCTION bridge_guard_upload_release_reference('url');
CREATE TRIGGER guard_upload_release_reference BEFORE INSERT OR UPDATE OF url
  ON server_emojis FOR EACH ROW EXECUTE FUNCTION bridge_guard_upload_release_reference('url');
CREATE TRIGGER guard_upload_release_reference BEFORE INSERT OR UPDATE OF url
  ON soundboard FOR EACH ROW EXECUTE FUNCTION bridge_guard_upload_release_reference('url');
CREATE TRIGGER guard_upload_release_reference BEFORE INSERT OR UPDATE OF url
  ON voice_messages FOR EACH ROW EXECUTE FUNCTION bridge_guard_upload_release_reference('url');
CREATE TRIGGER guard_upload_release_reference BEFORE INSERT OR UPDATE OF url
  ON sticker_pack_items FOR EACH ROW EXECUTE FUNCTION bridge_guard_upload_release_reference('url');
CREATE TRIGGER guard_upload_release_reference BEFORE INSERT OR UPDATE
  ON podcast_settings FOR EACH ROW EXECUTE FUNCTION bridge_guard_upload_release_reference('coverUrl', 'imageUrl');
CREATE TRIGGER guard_upload_release_reference BEFORE INSERT OR UPDATE
  ON podcast_episodes FOR EACH ROW EXECUTE FUNCTION bridge_guard_upload_release_reference('audioUrl', 'filename');
CREATE TRIGGER guard_upload_release_reference BEFORE INSERT OR UPDATE OF key
  ON uploads FOR EACH ROW EXECUTE FUNCTION bridge_guard_upload_release_reference('key');
