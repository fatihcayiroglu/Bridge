-- 085: fail closed instead of destroying moderation evidence.
-- Run in one transaction. An application rollback loses report-time capture;
-- it must not be represented as an evidence-safe rolling deployment.
-- Lock users before reports, matching erasure's lock order. This also prevents
-- a concurrent old-node DELETE from running its evidence trigger mid-rollback.
-- The locks are held to COMMIT by the migration runner.
LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE message_reports IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM message_reports
     WHERE "evidenceCapturedAt" IS NOT NULL OR "evidenceScrubbedAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Cannot roll back 085: message reports hold captured evidence';
  END IF;
  -- Restoring the CASCADE foreign key needs every report to point at a message.
  -- Deleting the reports that do not would erase moderation records; refuse.
  IF EXISTS (
    SELECT 1 FROM message_reports r
     WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m._id = r."messageId")
  ) THEN
    RAISE EXCEPTION 'Cannot roll back 085: message reports reference messages that no longer exist';
  END IF;
END $$;

DROP TRIGGER IF EXISTS message_reports_author_erasure ON users;
DROP FUNCTION IF EXISTS anonymize_report_evidence_on_user_delete();

ALTER TABLE message_reports DROP CONSTRAINT IF EXISTS message_reports_evidence_lifecycle_check;
ALTER TABLE message_reports DROP CONSTRAINT IF EXISTS message_reports_evidence_bounds_check;
ALTER TABLE message_reports DROP COLUMN IF EXISTS "evidenceCapturedAt";
ALTER TABLE message_reports DROP COLUMN IF EXISTS "evidenceText";
ALTER TABLE message_reports DROP COLUMN IF EXISTS "evidenceTextTruncated";
ALTER TABLE message_reports DROP COLUMN IF EXISTS "evidenceAuthorId";
ALTER TABLE message_reports DROP COLUMN IF EXISTS "evidenceAuthorName";
ALTER TABLE message_reports DROP COLUMN IF EXISTS "evidenceMessageType";
ALTER TABLE message_reports DROP COLUMN IF EXISTS "evidenceMessageCreatedAt";
ALTER TABLE message_reports DROP COLUMN IF EXISTS "evidenceMessageEditedAt";
ALTER TABLE message_reports DROP COLUMN IF EXISTS "evidenceFileName";
ALTER TABLE message_reports DROP COLUMN IF EXISTS "evidenceFileType";
ALTER TABLE message_reports DROP COLUMN IF EXISTS "evidenceScrubbedAt";
ALTER TABLE message_reports ADD CONSTRAINT "message_reports_messageId_fkey"
  FOREIGN KEY ("messageId") REFERENCES messages(_id) ON DELETE CASCADE;
