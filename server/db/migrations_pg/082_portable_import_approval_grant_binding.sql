-- 082: Bind one-use approval evidence to the exact mapped destination grants.
-- Historic 081 rows have NULL and can NEVER be claimed by the tightened CAS.
-- Nullable only for upgrade safety; all NEW writes must supply a verified digest.
ALTER TABLE portable_import_approvals
  ADD COLUMN target_grant_digest TEXT
    CONSTRAINT portable_import_approval_grant_digest_check
    CHECK (target_grant_digest IS NULL OR target_grant_digest ~ '^[0-9a-f]{64}$');
