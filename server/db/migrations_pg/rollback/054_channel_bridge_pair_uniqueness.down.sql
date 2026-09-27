-- Rollback 054. Duplicate rows removed by the up migration are not
-- reconstructible; rollback only removes the uniqueness guard.
DROP INDEX IF EXISTS idx_channel_bridges_pair_unique;
