-- Intentionally conservative rollback: do not drop columns that may now contain live data.
-- If a rollback is operationally required, roll back application code first and retain
-- these additive columns; they are backward-compatible with earlier Bridge versions.
DROP INDEX IF EXISTS idx_webhooks_token;
