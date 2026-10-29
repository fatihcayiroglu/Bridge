-- Schema-only reversal. No messages, tombstones, retained reports, upload
-- reservations or object-release outbox rows are removed. Reversal removes
-- the extra source-copy enforcement; 086's destination write barrier remains.
DROP TRIGGER IF EXISTS zz_channel_final_admission ON messages;
DROP FUNCTION IF EXISTS bridge_channel_copy_source_barrier();
