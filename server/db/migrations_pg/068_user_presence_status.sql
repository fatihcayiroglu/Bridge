-- P2: Persist the user's preferred presence independently from live connectivity.
-- `users.status` remains the effective/realtime state and may become `offline`
-- on disconnect or privacy hide. `presenceStatus` survives those transitions.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS "presenceStatus" TEXT NOT NULL DEFAULT 'online';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'users'::regclass
      AND conname = 'users_presenceStatus_check'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT "users_presenceStatus_check"
      CHECK ("presenceStatus" IN ('online', 'idle', 'dnd', 'offline')) NOT VALID;
  END IF;
END $$;

-- Existing rows did not have a separate preference. Preserve a meaningful
-- currently stored state when possible; disconnected `offline` remains a valid
-- explicit preference until the user changes it.
UPDATE users
SET "presenceStatus" = CASE
  WHEN status IN ('online', 'idle', 'dnd', 'offline') THEN status
  ELSE 'online'
END;

ALTER TABLE users VALIDATE CONSTRAINT "users_presenceStatus_check";
