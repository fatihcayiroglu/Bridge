-- 085: P7 B5 evidence-safe message reports (issue #336).
--
-- 1. A report keeps a bounded snapshot of the reported message, taken when the
--    report is filed (server/lib/reportEvidence.ts). The author can still edit
--    or delete the message; the moderator reviews what was reported.
--    Existing reports are NOT backfilled: their evidence columns stay NULL
--    ("not captured"). Copying today's text into an old report would present a
--    later edit as the reported content.
--
-- 2. The message foreign key is dropped. With ON DELETE CASCADE, a hard delete
--    of the message deleted the report: a ban that removes the member's recent
--    messages, or an administrator's account purge, erased the open reports
--    that led to it. "messageId" keeps the reported id; the report and its
--    snapshot outlive the row. Channel, server and reporter foreign keys are
--    unchanged.
--
-- Older code can still write legacy reports without a snapshot. A database
-- trigger protects captured author identity if an older node erases an account.
-- Full evidence capture requires every reporting node to run the new code.

ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS "evidenceCapturedAt" BIGINT;
ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS "evidenceText" TEXT;
ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS "evidenceTextTruncated" BOOLEAN;
ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS "evidenceAuthorId" TEXT;
ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS "evidenceAuthorName" TEXT;
ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS "evidenceMessageType" TEXT;
ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS "evidenceMessageCreatedAt" BIGINT;
ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS "evidenceMessageEditedAt" BIGINT;
ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS "evidenceFileName" TEXT;
ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS "evidenceFileType" TEXT;
ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS "evidenceScrubbedAt" BIGINT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'message_reports'::regclass
                  AND conname = 'message_reports_evidence_bounds_check') THEN
    ALTER TABLE message_reports ADD CONSTRAINT message_reports_evidence_bounds_check CHECK (
      ("evidenceText" IS NULL OR char_length("evidenceText") <= 4000)
      AND ("evidenceAuthorId" IS NULL OR char_length("evidenceAuthorId") <= 256)
      AND ("evidenceAuthorName" IS NULL OR char_length("evidenceAuthorName") <= 256)
      AND ("evidenceMessageType" IS NULL OR char_length("evidenceMessageType") <= 32)
      AND ("evidenceFileName" IS NULL OR char_length("evidenceFileName") <= 512)
      AND ("evidenceFileType" IS NULL OR char_length("evidenceFileType") <= 255)
      AND ("evidenceCapturedAt" IS NULL OR ("evidenceCapturedAt" > 0 AND "evidenceCapturedAt" <= 9007199254740991))
      AND ("evidenceMessageCreatedAt" IS NULL OR ("evidenceMessageCreatedAt" > 0 AND "evidenceMessageCreatedAt" <= 9007199254740991))
      AND ("evidenceMessageEditedAt" IS NULL OR ("evidenceMessageEditedAt" > 0 AND "evidenceMessageEditedAt" <= 9007199254740991))
      AND ("evidenceScrubbedAt" IS NULL OR ("evidenceScrubbedAt" > 0 AND "evidenceScrubbedAt" <= 9007199254740991))
    );
  END IF;
  -- Evidence exists only with a capture time; a cleared snapshot holds no content.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'message_reports'::regclass
                  AND conname = 'message_reports_evidence_lifecycle_check') THEN
    ALTER TABLE message_reports ADD CONSTRAINT message_reports_evidence_lifecycle_check CHECK (
      ("evidenceText" IS NULL OR "evidenceCapturedAt" IS NOT NULL)
      AND ("evidenceScrubbedAt" IS NULL OR (
        "evidenceCapturedAt" IS NOT NULL
        AND "evidenceText" IS NULL AND "evidenceTextTruncated" IS NULL
        AND "evidenceAuthorId" IS NULL AND "evidenceAuthorName" IS NULL
        AND "evidenceMessageType" IS NULL AND "evidenceMessageCreatedAt" IS NULL
        AND "evidenceMessageEditedAt" IS NULL
        AND "evidenceFileName" IS NULL AND "evidenceFileType" IS NULL
      ))
    );
  END IF;
END $$;

ALTER TABLE message_reports DROP CONSTRAINT IF EXISTS "message_reports_messageId_fkey";

-- Erasure can run on an older application node during a rolling deployment.
-- Keep identity removal in the same transaction as DELETE FROM users even if
-- that node does not know about migration 085's columns.
CREATE OR REPLACE FUNCTION anonymize_report_evidence_on_user_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE message_reports SET "evidenceAuthorId" = 'deleted-user', "evidenceAuthorName" = ''
   WHERE "evidenceAuthorId" = OLD._id AND "evidenceScrubbedAt" IS NULL;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS message_reports_author_erasure ON users;
CREATE TRIGGER message_reports_author_erasure
  BEFORE DELETE ON users FOR EACH ROW
  EXECUTE FUNCTION anonymize_report_evidence_on_user_delete();
