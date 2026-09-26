-- Referencing-column indexes for two ON DELETE CASCADE foreign keys.
--
-- PostgreSQL runs `DELETE FROM ONLY <child> WHERE $1 = "<column>"` for EVERY
-- deleted parent row. Without a leading index on the referencing column that is
-- one sequential scan per deleted parent. Measured on a disposable database
-- (Final21 Phase 11, F21-11-02; inside a rolled-back transaction, 3 repeats):
--
--   message_reports."messageId" -> messages, deleting 100 000 messages
--     20 000 reports: 103 424-106 576 ms without, 2 309-2 531 ms with the index
--   channel_read_positions."channelId" -> channels, 1M rows, 100 channels
--     explicit delete + channel delete: 5 662-5 842 ms without, 1 312-1 500 ms with
--
-- Server deletion (`ServerRepository.deleteGraphAtomic`) runs both inside ONE
-- transaction. Other foreign keys without a leading index were not measured
-- and are deliberately not indexed here.
--
-- Plain CREATE INDEX, as in 060: the runner wraps each migration in a
-- transaction, which CONCURRENTLY does not allow. The build holds a write lock
-- on each table for its duration (about a second per million rows locally).

CREATE INDEX IF NOT EXISTS idx_message_reports_message
  ON message_reports("messageId");

CREATE INDEX IF NOT EXISTS idx_channel_read_positions_channel
  ON channel_read_positions("channelId");
