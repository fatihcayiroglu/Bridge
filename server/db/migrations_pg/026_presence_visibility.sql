-- Privacy-first presence visibility.
-- The preference is distinct from the transient online/idle/dnd status so it
-- survives disconnects without treating every returning user as invisible.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS "presenceVisibility" TEXT NOT NULL DEFAULT 'visible'
  CHECK ("presenceVisibility" IN ('visible', 'hidden'));

COMMENT ON COLUMN users."presenceVisibility" IS
  'Whether realtime presence may be shown to other users (visible|hidden).';
