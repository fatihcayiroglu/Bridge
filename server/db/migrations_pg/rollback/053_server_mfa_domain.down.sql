-- Rollback 053: keep the mfaLevel column introduced by migration 016, but
-- remove the stricter domain constraint. Values repaired to 2 cannot be
-- reconstructed because the original malformed value was not trustworthy.
ALTER TABLE servers DROP CONSTRAINT IF EXISTS servers_mfa_level_check;
