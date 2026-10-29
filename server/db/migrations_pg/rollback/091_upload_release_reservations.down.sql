-- Dropping deletion reservations would permit stale writes to resurrect
-- references to objects whose bytes may already be gone. Refuse that loss.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM upload_release_keys WHERE reserved) THEN
    RAISE EXCEPTION 'Cannot roll back 091 while upload deletion reservations exist';
  END IF;
END $$;
DROP TRIGGER IF EXISTS guard_upload_release_reference ON messages;
DROP TRIGGER IF EXISTS guard_upload_release_reference ON dm_messages;
DROP TRIGGER IF EXISTS guard_upload_release_reference ON group_dm_messages;
DROP TRIGGER IF EXISTS guard_upload_release_reference ON users;
DROP TRIGGER IF EXISTS guard_upload_release_reference ON servers;
DROP TRIGGER IF EXISTS guard_upload_release_reference ON members;
DROP TRIGGER IF EXISTS guard_upload_release_reference ON server_gifs;
DROP TRIGGER IF EXISTS guard_upload_release_reference ON server_emojis;
DROP TRIGGER IF EXISTS guard_upload_release_reference ON soundboard;
DROP TRIGGER IF EXISTS guard_upload_release_reference ON voice_messages;
DROP TRIGGER IF EXISTS guard_upload_release_reference ON sticker_pack_items;
DROP TRIGGER IF EXISTS guard_upload_release_reference ON podcast_settings;
DROP TRIGGER IF EXISTS guard_upload_release_reference ON podcast_episodes;
DROP TRIGGER IF EXISTS guard_upload_release_reference ON uploads;
DROP FUNCTION IF EXISTS bridge_guard_upload_release_reference();
DROP TABLE upload_release_keys;
