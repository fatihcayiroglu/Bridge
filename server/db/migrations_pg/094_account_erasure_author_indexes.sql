-- 094: indexes for account erasure's author lookups.
--
-- Account erasure (lib/accountDeletion.ts eraseAccountData, with
-- lib/accountErasure.ts prepareAuthorErasure) runs these in one transaction:
--   · UPDATE messages … WHERE "replyTo" ? 'displayName'
--       AND "replyTo"->>'_id' IN (SELECT _id FROM messages WHERE "userId" = $1)
--   · SELECT array_agg(DISTINCT "channelId") … FROM messages WHERE "userId" = $1
--   · UPDATE messages / thread_messages … WHERE "userId" = $1   (anonymize)
--   · DELETE FROM messages WHERE "userId" = $1                  (admin purge)
-- `messages` has no usable index on "userId": idx_messages_user_ack is partial
-- (WHERE "ackId" IS NOT NULL). `thread_messages` has none. Every statement above
-- scanned the whole table.
--
-- Measured on PostgreSQL 16, 4 CPUs, a disposable copy holding 6.0M messages
-- (1.1 GB heap) and 500k thread replies, running the real eraseAccountData in a
-- rolled-back transaction (server/scripts/p7-d1-erasure-probe.ts, added with the D1 decision record):
--   without these indexes: 1.96-2.59 s per erasure (it grows with the table;
--     0.8-1.1 s at 2M);
--   with this file applied as written: 0.16-0.21 s.
--   Four-writer insert throughput with the same three indexes: 4,355 rows/s,
--   against 4,232-4,239 without (docs/P7_D1_PARTITION_DECISION.md).
--
-- Plain CREATE INDEX, as in 060 and 071: the runner wraps each migration in a
-- transaction, which CONCURRENTLY does not allow. schema.ts carries the same
-- three statements, and boot runs schema.ts (one multi-statement query, so one
-- implicit transaction) BEFORE the versioned chain: on an existing installation
-- the indexes are built there and this file then finds them. Either way, writes
-- to messages and thread_messages wait for the builds; reads do not.
-- Measured on the same copy:
--   this file alone, three rolled-back rounds: 5.55-5.62 s (messages("userId")
--   4.66-4.71 s, the replyTo index 0.54-0.55 s, thread replies 0.34-0.37 s);
--   an INSERT arriving 0.5 s in waited 5.06-5.12 s; a channel-history read in
--   the same window took 1.5-2.7 ms;
--   a real boot of this branch over that copy (db/postgres/index.ts, writer
--   inserting every 5 ms): one stall of 5.64 s during the schema pass, p50 1 ms
--   and p99 7 ms over 1,025 writes; 094 was then recorded with nothing to build.
-- The copy has no quoting messages, so the replyTo time there is the table
-- scan alone. Budget roughly a second of blocked writes per million messages.
-- On a large installation, build the same indexes CONCURRENTLY under these
-- names before upgrading; IF NOT EXISTS then makes both the schema pass and
-- this migration no-ops.
--
-- "replyTo" belongs to the base schema, not to an earlier migration, so no
-- isolated rollback can drop the column under this partial index (see 060).

CREATE INDEX IF NOT EXISTS idx_messages_author
  ON messages("userId");

CREATE INDEX IF NOT EXISTS idx_messages_reply_quote_ref
  ON messages(("replyTo"->>'_id')) WHERE "replyTo" ? 'displayName';

CREATE INDEX IF NOT EXISTS idx_thread_messages_author
  ON thread_messages("userId");
