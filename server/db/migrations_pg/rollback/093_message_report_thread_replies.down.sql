-- 093 down: refuse while a thread-reply report exists.
-- Dropping the column would turn such a report into a channel-message report
-- whose "messageId" points at no channel message. The moderator would lose
-- which thread it came from, and older code would mislabel it.
-- Resolve and remove those reports deliberately first; nothing is deleted here.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM message_reports WHERE "threadId" IS NOT NULL) THEN
    RAISE EXCEPTION '093 down refused: message_reports holds thread-reply reports ("threadId" IS NOT NULL)';
  END IF;
END $$;
ALTER TABLE message_reports DROP COLUMN IF EXISTS "threadId";
