-- Built-in marketplace examples may only claim what Bridge bots can do (Final21 Phase 14).
--
-- Measured on a live server: the five seeded example listings were approved and shown
-- (three "featured", one "verified" by "Bridge Team") while none had a runnable bot
-- behind it, and they declared permissions Bridge neither implements nor enforces:
-- members:ban, members:timeout, roles:assign, voice:join, reactions:manage …
-- The only bot capabilities are "commands" and "messages:reply" (lib/botScopes.ts).
--
-- Only rows the seed itself created are touched ("submittedBy" IS NULL and a
-- built-in id); listings submitted by people are never modified here.

-- Examples whose described behaviour a Bridge bot cannot perform are withdrawn.
UPDATE bot_marketplace
   SET approved = FALSE, featured = FALSE
 WHERE "submittedBy" IS NULL
   AND id IN ('musicbot', 'modbot', 'welcomebot');

-- Examples a Bridge bot CAN implement keep their listing, declare real scopes, and stop
-- claiming verification or linking to repositories the project does not control.
UPDATE bot_marketplace
   SET permissions = '["commands", "messages:reply"]'::jsonb,
       verified = FALSE,
       "authorVerified" = FALSE,
       featured = FALSE,
       "supportUrl" = '#',
       "sourceUrl" = '#'
 WHERE "submittedBy" IS NULL
   AND id IN ('bridgebot', 'pollbot');
