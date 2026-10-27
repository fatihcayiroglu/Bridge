-- 094_account_erasure_author_indexes.down.sql
-- Indexes only: no data changes. Account erasure goes back to full-table scans.
DROP INDEX IF EXISTS idx_thread_messages_author;
DROP INDEX IF EXISTS idx_messages_reply_quote_ref;
DROP INDEX IF EXISTS idx_messages_author;
