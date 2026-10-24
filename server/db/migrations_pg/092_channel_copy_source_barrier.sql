-- 092: a live destination cannot authorize a deferred copy of expired content.
-- Reuse 086's database-clock/tenant/tombstone policy in the writing statement,
-- after BEFORE triggers and index/reference locks. Bridge forwarding, crossposts
-- and older application nodes share this enforcement. No existing
-- message is rewritten or deleted. A previously authorized permanent copy keeps
-- its own lifecycle; ordinary edits/erasure do not reread its historical source.
CREATE OR REPLACE FUNCTION bridge_channel_copy_source_barrier() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  source JSONB := to_jsonb(NEW)->'bridgedFrom';
  source_channel TEXT;
  source_server TEXT;
  check_source BOOLEAN := FALSE;
BEGIN
  -- Preserve the same narrow account-erasure/soft-delete exception as 086.
  IF TG_OP = 'UPDATE' AND bridge_channel_update_is_erasure(to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  check_source := source IS NOT NULL AND source <> 'null'::jsonb;
  IF TG_OP = 'UPDATE' AND source IS NOT DISTINCT FROM to_jsonb(OLD)->'bridgedFrom' THEN
    check_source := FALSE;
  END IF;
  IF check_source THEN
    IF jsonb_typeof(source) IS DISTINCT FROM 'object'
       OR jsonb_typeof(source->'channelId') IS DISTINCT FROM 'string'
       OR jsonb_typeof(source->'serverId') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION USING ERRCODE = 'BX001', MESSAGE = 'channel_unavailable', DETAIL = 'invalid_copy_source';
    END IF;
    source_channel := source->>'channelId';
    source_server := source->>'serverId';
    IF char_length(source_channel) NOT BETWEEN 1 AND 256
       OR char_length(source_server) NOT BETWEEN 1 AND 256 THEN
      RAISE EXCEPTION USING ERRCODE = 'BX001', MESSAGE = 'channel_unavailable', DETAIL = 'invalid_copy_source';
    END IF;

  END IF;
  -- At READ COMMITTED the volatile canonical policy reads fresh metadata after
  -- these waits. Preserve its KEY SHARE compatibility with ordinary metadata
  -- updates. Snapshot isolation needs FOR SHARE: KEY SHARE can keep using a
  -- pre-update tuple, whereas SHARE rejects that stale snapshot with 40001.
  IF current_setting('transaction_isolation') IN ('repeatable read', 'serializable') THEN
    PERFORM 1 FROM channels
      WHERE _id IN (NEW."channelId", CASE WHEN TG_OP = 'UPDATE' THEN OLD."channelId" END,
        CASE WHEN check_source THEN source_channel END)
      ORDER BY _id FOR SHARE;
  ELSE
    PERFORM 1 FROM channels
      WHERE _id IN (NEW."channelId", CASE WHEN TG_OP = 'UPDATE' THEN OLD."channelId" END,
        CASE WHEN check_source THEN source_channel END)
      ORDER BY _id FOR KEY SHARE;
  END IF;
  IF check_source THEN
    -- 086 intentionally permits legacy direct writes without a parent. A copy
    -- must prove a real source under the expected tenant.
    IF NOT EXISTS (SELECT 1 FROM channels WHERE _id = source_channel AND "serverId" = source_server) THEN
      RAISE EXCEPTION USING ERRCODE = 'BX001', MESSAGE = 'channel_unavailable', DETAIL = 'missing_or_mismatched_copy_source';
    END IF;
  END IF;
  -- The destination's earlier check may precede a wait in a later reference
  -- trigger, unique-index conflict, or source lock. Check the canonical policy
  -- again after those waits, with all channel locks now held by this statement.
  IF TG_OP = 'UPDATE' AND (OLD."channelId" IS DISTINCT FROM NEW."channelId" OR OLD."serverId" IS DISTINCT FROM NEW."serverId") THEN
    PERFORM bridge_channel_assert_writable(OLD."channelId", OLD."serverId");
  END IF;
  PERFORM bridge_channel_assert_writable(NEW."channelId", NEW."serverId");
  IF check_source THEN
    PERFORM bridge_channel_assert_writable(source_channel, source_server);
  END IF;
  RETURN NEW;
END $$;

-- Ordinary AFTER ROW triggers cannot be deferred with SET CONSTRAINTS. Failure
-- aborts the entire statement/transaction, including an idempotency-log INSERT.
DROP TRIGGER IF EXISTS zz_channel_final_admission ON messages;
CREATE TRIGGER zz_channel_final_admission
  AFTER INSERT OR UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION bridge_channel_copy_source_barrier();
