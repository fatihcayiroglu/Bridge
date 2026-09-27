-- 056 rollback: remove validation constraints only; data is unchanged.
ALTER TABLE channel_permissions DROP CONSTRAINT IF EXISTS channel_permissions_masks_valid;
ALTER TABLE channel_overrides DROP CONSTRAINT IF EXISTS channel_overrides_masks_valid;
ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_permissions_valid;
