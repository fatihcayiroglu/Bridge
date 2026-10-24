-- 087: P7 D2 expiry worker support. The worker polls for channels whose
-- expiresAt has passed; permanent channels (NULL) are excluded from the
-- index, so the poll touches only expiring channels.
CREATE INDEX IF NOT EXISTS idx_channels_expires_at
  ON channels ("expiresAt", _id) WHERE "expiresAt" IS NOT NULL;
-- Cleanup ticks pick unfinished tombstones oldest first.
CREATE INDEX IF NOT EXISTS idx_channel_expiry_tombstones_pending
  ON channel_expiry_tombstones ("recordedAt", "channelId") WHERE "cleanupState" = 'pending';
