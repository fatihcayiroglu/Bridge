-- 085: reversible only while no evidence snapshot exists. Fail closed rather
-- than destroy moderation evidence (issue #336); retention is an owner decision.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM message_reports WHERE "evidenceCapturedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'Cannot roll back 085: message report evidence snapshots exist';
  END IF;
END $$;

ALTER TABLE message_reports DROP CONSTRAINT IF EXISTS message_reports_evidence_bounds_check;
ALTER TABLE message_reports DROP COLUMN IF EXISTS "evidenceCapturedAt";
ALTER TABLE message_reports DROP COLUMN IF EXISTS "evidenceAuthorId";
ALTER TABLE message_reports DROP COLUMN IF EXISTS "evidenceAuthorName";
ALTER TABLE message_reports DROP COLUMN IF EXISTS "evidenceText";
ALTER TABLE message_reports DROP COLUMN IF EXISTS "evidenceTextTruncated";
ALTER TABLE message_reports DROP COLUMN IF EXISTS "evidenceCreatedAt";
ALTER TABLE message_reports DROP COLUMN IF EXISTS "evidenceEditedAt";
ALTER TABLE message_reports DROP COLUMN IF EXISTS "evidenceFileName";
ALTER TABLE message_reports DROP COLUMN IF EXISTS "evidenceFileType";
