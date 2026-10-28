-- 085: P7 B5 evidence-safe message reports (issue #336), schema only.
-- Nullable snapshot columns on message_reports. Existing reports keep NULLs and
-- behave as before. The application writes a snapshot only when
-- REPORT_EVIDENCE_SNAPSHOT=1 (default off) and no retention, scrub or erasure
-- rule is defined here: those are owner decisions recorded on #336.
-- No FK from evidenceAuthorId to users: the snapshot must not be deleted by a
-- user-row cascade that this migration did not decide to add.
ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS "evidenceCapturedAt" BIGINT;
ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS "evidenceAuthorId" TEXT;
ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS "evidenceAuthorName" TEXT;
ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS "evidenceText" TEXT;
ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS "evidenceTextTruncated" BOOLEAN;
ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS "evidenceCreatedAt" BIGINT;
ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS "evidenceEditedAt" BIGINT;
ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS "evidenceFileName" TEXT;
ALTER TABLE message_reports ADD COLUMN IF NOT EXISTS "evidenceFileType" TEXT;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'message_reports'::regclass AND conname = 'message_reports_evidence_bounds_check'
  ) THEN
    ALTER TABLE message_reports ADD CONSTRAINT message_reports_evidence_bounds_check CHECK (
      ("evidenceText" IS NULL OR char_length("evidenceText") <= 4000)
      AND ("evidenceAuthorName" IS NULL OR char_length("evidenceAuthorName") <= 200)
      AND ("evidenceFileName" IS NULL OR char_length("evidenceFileName") <= 200)
      AND ("evidenceFileType" IS NULL OR char_length("evidenceFileType") <= 200)
    );
  END IF;
END $$;
