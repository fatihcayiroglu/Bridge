-- Schema-only reversal: no content, evidence, tombstones or pending releases
-- are removed. This weakens admission after waits; prefer roll-forward.
-- Reverse 095 before 092: the message barrier's shared function remains owned
-- by 092. Never CASCADE that function or remove unrelated guards.
DROP TRIGGER IF EXISTS zz_channel_final_admission ON thread_messages;
DROP TRIGGER IF EXISTS zz_channel_final_admission ON threads;
