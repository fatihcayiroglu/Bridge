-- Migration 023 — Durable, per-user message idempotency.
--
-- The client already supplies a stable ackId for retries. The former dedup
-- record lived only in Redis/in-memory for five minutes, so a process restart
-- between INSERT and ACK could turn the replay into a second message.
--
-- Scope by user: two users may independently generate the same client UUID;
-- one user's ackId must never reveal or suppress another user's message.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS "ackId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_user_ack
  ON messages("userId", "ackId")
  WHERE "ackId" IS NOT NULL;
