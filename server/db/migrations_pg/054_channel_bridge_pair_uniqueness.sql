-- 054_channel_bridge_pair_uniqueness.sql
-- A bridge is directional: source -> target. Historical duplicate rows for
-- the same ordered pair are collapsed to the newest row before enforcing the
-- multi-node create/reactivate invariant.
WITH ranked AS (
  SELECT _id,
         row_number() OVER (
           PARTITION BY "sourceChannelId", "targetChannelId"
           ORDER BY "createdAt" DESC NULLS LAST, _id DESC
         ) AS duplicate_rank
    FROM channel_bridges
)
DELETE FROM channel_bridges bridge
USING ranked
WHERE bridge._id = ranked._id
  AND ranked.duplicate_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_bridges_pair_unique
  ON channel_bridges("sourceChannelId", "targetChannelId");
