-- 050_channel_settings_contract.sql
-- Canonical channel settings used by the live message slowmode engine and forum UI.
BEGIN;

ALTER TABLE channels ADD COLUMN IF NOT EXISTS slowmode INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS "forumTags" JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Fail-safe repair for databases that briefly carried an unconstrained
-- slowmode column in an earlier progress build. Unknown values become OFF
-- rather than preventing the production constraint from being installed.
UPDATE channels SET slowmode = 0
 WHERE slowmode NOT IN (0,5,10,15,30,60,120,300,600,900,1800,3600,7200,21600);

ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_slowmode_check;
ALTER TABLE channels ADD CONSTRAINT channels_slowmode_check CHECK (
  slowmode IN (0,5,10,15,30,60,120,300,600,900,1800,3600,7200,21600)
);

COMMIT;
