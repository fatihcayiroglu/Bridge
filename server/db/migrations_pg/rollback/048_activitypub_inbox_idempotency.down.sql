-- 048_activitypub_inbox_idempotency.down.sql
-- Conservative rollback: retain claim/audit columns because dropping them can
-- discard live retry state. Earlier code ignores additive columns.
DROP INDEX IF EXISTS idx_ap_activities_claim;
DROP INDEX IF EXISTS idx_ap_activities_inbound_unique;
