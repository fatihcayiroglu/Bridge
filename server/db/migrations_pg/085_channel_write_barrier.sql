-- 085: P7 D2 authoritative channel write barrier.
--
-- Every write of channel content (messages, thread replies, threads) passes
-- through ONE BEFORE ROW trigger in the writing statement itself, whatever
-- application path issued it. Ordinary (non-constraint) triggers cannot be
-- deferred, so SET CONSTRAINTS cannot move or skip this check (the bypass
-- shown by the deferred-trigger experiment in #351 does not apply).
--
-- Lock order: the channel row is locked FOR KEY SHARE FIRST, then the
-- tombstone and expiry are read. FOR KEY SHARE conflicts with the expiry
-- worker's FOR UPDATE and with DELETE of the channel row, so:
--   * a writer that locked first finishes before the worker can claim, and
--     the worker's later DELETE removes what the writer committed;
--   * a writer that arrives while the worker holds the row waits, then finds
--     the row deleted and the tombstone committed, and is denied.
-- It does NOT conflict with ordinary channel UPDATEs (name, topic, ...), so
-- busy channels gain no contention against metadata edits.
--
-- Rules (mirrors classifyChannelExpiryWithTombstone):
--   tombstone for the channel id          -> denied (even if the id is reused)
--   channel row under another server      -> denied (tenant mismatch)
--   expiresAt set but expiryVersion <= 0  -> denied (corrupt metadata)
--   expiresAt <= database clock (ms)      -> denied
--   no channel row and no tombstone       -> allowed (pre-D2 behaviour; no FK)
--   expiresAt NULL                        -> allowed (permanent channel)
-- Denials raise SQLSTATE BX001 so applications can map them precisely.
--
-- UPDATE is denied by default. On an unavailable channel an UPDATE passes
-- only when EVERY column it changes is a recognised erasure step, judged per
-- column on the old and new row (bridge_channel_update_is_erasure):
--   author display fields (username, displayName, avatarColor, avatarUrl);
--   deletedAt set to a value (never cleared: no undelete), deletedBy with it;
--   payload columns scrubbed to NULL/empty/'[Mesaj silindi]' by a soft delete;
--   replyTo cleared, or narrowed to a subset of itself plus deleted=true;
--   embedding cleared (a vector of expired text is never written).
-- A soft delete therefore cannot carry new content, reactions, pins or edit
-- history, and nothing can be smuggled into the reply snapshot.
-- Changing channelId or serverId is a write to BOTH channels: content can be
-- neither moved into an unavailable channel nor rescued out of one before
-- cleanup. DELETE is never guarded.
-- The triggers name no columns (no UPDATE OF list): a column list would make
-- earlier migrations' rollbacks fail to drop those columns.
CREATE OR REPLACE FUNCTION bridge_channel_assert_writable(target_channel TEXT, target_server TEXT) RETURNS void
LANGUAGE plpgsql AS $assert$
DECLARE
  channel_server  TEXT;
  channel_expires BIGINT;
  channel_version BIGINT;
  channel_found   BOOLEAN;
BEGIN
  IF target_channel IS NULL THEN
    RETURN;
  END IF;

  SELECT c."serverId", c."expiresAt", c."expiryVersion"
    INTO channel_server, channel_expires, channel_version
    FROM channels c
   WHERE c._id = target_channel
     FOR KEY SHARE;
  channel_found := FOUND;

  -- Read AFTER the lock: if we waited on the expiry worker, this statement
  -- runs on a fresh snapshot and sees its committed tombstone.
  IF EXISTS (SELECT 1 FROM channel_expiry_tombstones t WHERE t."channelId" = target_channel) THEN
    RAISE EXCEPTION USING ERRCODE = 'BX001', MESSAGE = 'channel_unavailable', DETAIL = 'tombstoned';
  END IF;
  IF NOT channel_found THEN
    RETURN;
  END IF;
  IF channel_server IS DISTINCT FROM target_server THEN
    RAISE EXCEPTION USING ERRCODE = 'BX001', MESSAGE = 'channel_unavailable', DETAIL = 'tenant_mismatch';
  END IF;
  IF channel_expires IS NULL THEN
    RETURN;
  END IF;
  IF channel_version IS NULL OR channel_version <= 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'BX001', MESSAGE = 'channel_unavailable', DETAIL = 'invalid_expiry';
  END IF;
  IF channel_expires <= FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT THEN
    RAISE EXCEPTION USING ERRCODE = 'BX001', MESSAGE = 'channel_unavailable', DETAIL = 'expired';
  END IF;
END
$assert$;

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

CREATE OR REPLACE FUNCTION bridge_channel_write_barrier() RETURNS trigger
LANGUAGE plpgsql AS $barrier$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."channelId" IS DISTINCT FROM NEW."channelId" OR OLD."serverId" IS DISTINCT FROM NEW."serverId" THEN
      PERFORM bridge_channel_assert_writable(OLD."channelId", OLD."serverId");
      PERFORM bridge_channel_assert_writable(NEW."channelId", NEW."serverId");
      RETURN NEW;
    END IF;
    IF NEW."channelId" IS NULL OR bridge_channel_update_is_erasure(to_jsonb(OLD), to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  PERFORM bridge_channel_assert_writable(NEW."channelId", NEW."serverId");
  RETURN NEW;
END
$barrier$;

DROP TRIGGER IF EXISTS channel_write_barrier ON messages;
CREATE TRIGGER channel_write_barrier
  BEFORE INSERT OR UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION bridge_channel_write_barrier();

DROP TRIGGER IF EXISTS channel_write_barrier ON thread_messages;
CREATE TRIGGER channel_write_barrier
  BEFORE INSERT OR UPDATE ON thread_messages
  FOR EACH ROW EXECUTE FUNCTION bridge_channel_write_barrier();

DROP TRIGGER IF EXISTS channel_write_barrier ON threads;
CREATE TRIGGER channel_write_barrier
  BEFORE INSERT OR UPDATE ON threads
  FOR EACH ROW EXECUTE FUNCTION bridge_channel_write_barrier();
