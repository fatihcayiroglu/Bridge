-- 085 down: removes the D2 write barrier. Stored data is untouched.
DROP TRIGGER IF EXISTS channel_write_barrier ON threads;
DROP TRIGGER IF EXISTS channel_write_barrier ON thread_messages;
DROP TRIGGER IF EXISTS channel_write_barrier ON messages;
DROP FUNCTION IF EXISTS bridge_channel_write_barrier();
DROP FUNCTION IF EXISTS bridge_channel_update_is_erasure(JSONB, JSONB);
DROP FUNCTION IF EXISTS bridge_channel_assert_writable(TEXT, TEXT);
