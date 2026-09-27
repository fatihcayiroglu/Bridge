-- 073_marketplace_seed_truthfulness.down.sql
-- Data-only migration: restores the previous seeded example values.
UPDATE bot_marketplace
   SET approved = TRUE,
       featured = (id = 'musicbot')
 WHERE "submittedBy" IS NULL
   AND id IN ('musicbot', 'modbot', 'welcomebot');

UPDATE bot_marketplace
   SET permissions = '["messages:read", "messages:send"]'::jsonb,
       verified = TRUE,
       "authorVerified" = TRUE,
       featured = TRUE,
       "supportUrl" = 'https://github.com/bridge-app/bridge',
       "sourceUrl" = 'https://github.com/bridge-app/bridgebot'
 WHERE "submittedBy" IS NULL
   AND id = 'bridgebot';

UPDATE bot_marketplace
   SET permissions = '["messages:read", "messages:send", "reactions:manage"]'::jsonb,
       featured = TRUE
 WHERE "submittedBy" IS NULL
   AND id = 'pollbot';
