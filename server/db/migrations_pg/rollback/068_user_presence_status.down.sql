-- Roll back only the P2 preference owner; effective `status` remains intact.
ALTER TABLE users DROP CONSTRAINT IF EXISTS "users_presenceStatus_check";
ALTER TABLE users DROP COLUMN IF EXISTS "presenceStatus";
