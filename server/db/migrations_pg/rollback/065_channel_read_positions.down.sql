-- Read positions contain only derived navigation state; rollback may drop them.
DROP INDEX IF EXISTS idx_channel_read_positions_user;
DROP TABLE IF EXISTS channel_read_positions;
