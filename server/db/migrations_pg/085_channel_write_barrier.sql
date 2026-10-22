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
-- UPDATE is denied by default. Two kinds stay possible on an unavailable
-- channel so privacy and cleanup work is never blocked: a soft delete (the
-- row gains deletedAt, which also scrubs its payload) and an update that
-- changes nothing but housekeeping columns (author display fields, replyTo
-- snapshots, deletedAt/deletedBy, embedding). DELETE is never guarded.
-- The triggers name no columns (no UPDATE OF list): a column list would make
-- earlier migrations' rollbacks fail to drop those columns.
CREATE OR REPLACE FUNCTION bridge_channel_write_barrier() RETURNS trigger
LANGUAGE plpgsql AS $barrier$
DECLARE
  channel_server  TEXT;
  channel_expires BIGINT;
  channel_version BIGINT;
  channel_found   BOOLEAN;
  housekeeping    CONSTANT TEXT[] := ARRAY['username', 'displayName', 'avatarColor', 'avatarUrl',
                                           'replyTo', 'deletedAt', 'deletedBy', 'embedding'];
BEGIN
  IF NEW."channelId" IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(OLD) ->> 'deletedAt') IS NULL AND (to_jsonb(NEW) ->> 'deletedAt') IS NOT NULL THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - housekeeping) = (to_jsonb(OLD) - housekeeping) THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT c."serverId", c."expiresAt", c."expiryVersion"
    INTO channel_server, channel_expires, channel_version
    FROM channels c
   WHERE c._id = NEW."channelId"
     FOR KEY SHARE;
  channel_found := FOUND;

  -- Read AFTER the lock: if we waited on the expiry worker, this statement
  -- runs on a fresh snapshot and sees its committed tombstone.
  IF EXISTS (SELECT 1 FROM channel_expiry_tombstones t WHERE t."channelId" = NEW."channelId") THEN
    RAISE EXCEPTION USING ERRCODE = 'BX001', MESSAGE = 'channel_unavailable', DETAIL = 'tombstoned';
  END IF;
  IF NOT channel_found THEN
    RETURN NEW;
  END IF;
  IF channel_server IS DISTINCT FROM NEW."serverId" THEN
    RAISE EXCEPTION USING ERRCODE = 'BX001', MESSAGE = 'channel_unavailable', DETAIL = 'tenant_mismatch';
  END IF;
  IF channel_expires IS NULL THEN
    RETURN NEW;
  END IF;
  IF channel_version IS NULL OR channel_version <= 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'BX001', MESSAGE = 'channel_unavailable', DETAIL = 'invalid_expiry';
  END IF;
  IF channel_expires <= FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT THEN
    RAISE EXCEPTION USING ERRCODE = 'BX001', MESSAGE = 'channel_unavailable', DETAIL = 'expired';
  END IF;
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
