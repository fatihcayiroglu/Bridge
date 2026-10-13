-- Revoking the grant-binding schema invalidates all affected consent evidence.
-- Only run after stopping any future import/approval endpoints.
ALTER TABLE portable_import_approvals
  DROP COLUMN IF EXISTS target_grant_digest;
