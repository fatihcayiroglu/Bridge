-- 089 down: refuse while objects are still waiting to be released; dropping the
-- table would orphan them silently. Finished rows are reconciliation history only.
LOCK TABLE channel_object_release_outbox IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM channel_object_release_outbox WHERE state = 'pending') THEN
    RAISE EXCEPTION 'Cannot roll back 089: expired-channel objects are still pending release';
  END IF;
END $$;
DROP TABLE IF EXISTS channel_object_release_outbox;
