-- 095: threads and replies must recheck admission after index/reference waits,
-- just like messages. Reuse 092's database-clock, tenant, tombstone, erasure and
-- snapshot-isolation policy; do not create a second expiry implementation.
-- 093 and 094 are reserved by the reporting and account-erasure index PRs.
-- Ordinary AFTER ROW triggers cannot be deferred with SET CONSTRAINTS.
-- No existing content, evidence, tombstones or release-outbox rows are changed.
DROP TRIGGER IF EXISTS zz_channel_final_admission ON threads;
CREATE TRIGGER zz_channel_final_admission
  AFTER INSERT OR UPDATE ON threads
  FOR EACH ROW EXECUTE FUNCTION bridge_channel_copy_source_barrier();

DROP TRIGGER IF EXISTS zz_channel_final_admission ON thread_messages;
CREATE TRIGGER zz_channel_final_admission
  AFTER INSERT OR UPDATE ON thread_messages
  FOR EACH ROW EXECUTE FUNCTION bridge_channel_copy_source_barrier();
