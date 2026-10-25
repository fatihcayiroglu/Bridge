-- 089: P7 D2 durable object-release outbox for expired channels (#321).
--
-- Deleting stored objects (attachments, voice messages, podcast media) cannot be
-- atomic with PostgreSQL. The expiry cleanup therefore records every upload URL
-- of the rows it deletes IN THE SAME STATEMENT as the delete (a CTE), and a
-- separate leased phase releases the objects after COMMIT, with bounded batches,
-- retries with backoff and an explicit terminal state for reconciliation:
--   pending  -> released   object deleted, or already absent
--            -> retained   still referenced by a live row, or not a location
--                          Bridge owns (never deleted; reason in "lastError")
--            -> failed     still failing after the retry budget (operator action)
-- A crash between the object delete and the state update re-runs the release,
-- which then finds the object absent: idempotent. URLs only, never content.
CREATE TABLE IF NOT EXISTS channel_object_release_outbox (
  "channelId"     TEXT    NOT NULL,
  url             TEXT    NOT NULL CHECK (char_length(url) BETWEEN 1 AND 2048),
  "enqueuedAt"    BIGINT  NOT NULL CHECK ("enqueuedAt" > 0),
  state           TEXT    NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending', 'released', 'retained', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  "nextAttemptAt" BIGINT  NOT NULL CHECK ("nextAttemptAt" > 0),
  "finishedAt"    BIGINT  CHECK ("finishedAt" IS NULL OR "finishedAt" > 0),
  "lastError"     TEXT    CHECK ("lastError" IS NULL OR char_length("lastError") <= 500),
  PRIMARY KEY ("channelId", url),
  CHECK ((state = 'pending') = ("finishedAt" IS NULL))
);
-- Due work, oldest first; finished rows are excluded.
CREATE INDEX IF NOT EXISTS idx_channel_object_release_due
  ON channel_object_release_outbox ("nextAttemptAt") WHERE state = 'pending';
-- Pruning of finished rows.
CREATE INDEX IF NOT EXISTS idx_channel_object_release_finished
  ON channel_object_release_outbox ("finishedAt") WHERE state <> 'pending';
