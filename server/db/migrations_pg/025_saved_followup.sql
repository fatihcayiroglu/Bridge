-- Personal Saved / Follow-up items.
-- Only canonical identifiers are persisted. Message text, sender names,
-- channel names and attachment metadata are resolved after a fresh access
-- check on every read, so later permission loss cannot preserve a snapshot.

CREATE TABLE IF NOT EXISTS saved_messages (
  _id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "destinationType" TEXT NOT NULL CHECK ("destinationType" IN ('channel', 'dm', 'gdm')),
  "destinationId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_messages_owner_target
  ON saved_messages("userId", "destinationType", "messageId");

CREATE INDEX IF NOT EXISTS idx_saved_messages_owner_created
  ON saved_messages("userId", "createdAt" DESC, _id DESC);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_saved_messages_user') THEN
    ALTER TABLE saved_messages ADD CONSTRAINT fk_saved_messages_user
      FOREIGN KEY ("userId") REFERENCES users(_id) ON DELETE CASCADE;
  END IF;
END $$;
