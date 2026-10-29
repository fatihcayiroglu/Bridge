-- 088 down: restore the CASCADE channel foreign key, refusing to destroy reports.
-- Restoring the key needs every report to point at an existing channel. Reports
-- of expired or deleted channels would have to be deleted first, which erases
-- moderation records and their evidence; the rollback refuses instead.
-- Lock channels before reports so a concurrent channel delete cannot slip in.
LOCK TABLE channels IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE message_reports IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM message_reports r
     WHERE NOT EXISTS (SELECT 1 FROM channels c WHERE c._id = r."channelId")
  ) THEN
    RAISE EXCEPTION 'Cannot roll back 088: message reports reference channels that no longer exist';
  END IF;
END $$;
ALTER TABLE message_reports ADD CONSTRAINT "message_reports_channelId_fkey"
  FOREIGN KEY ("channelId") REFERENCES channels(_id) ON DELETE CASCADE;
