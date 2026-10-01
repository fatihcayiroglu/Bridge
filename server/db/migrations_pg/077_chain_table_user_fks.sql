-- 077: user foreign keys on tables the versioned chain creates
--
-- P5 SH-04 follow-up. oauth_tokens and server_boosts are created by
-- 011_sprint93_boost_vanity_oauth, but their user FKs (fk_oauth_tokens_user,
-- fk_server_boosts_user — ON DELETE CASCADE) were owned only by the boot-time
-- inline USER_FK list. Before SH-04 a fresh install got them on its SECOND
-- boot; after SH-04 on its first. Either way no versioned migration owned
-- them, so an ordered rollback + re-apply of the chain lost them (measured by
-- scripts/verify-migration-rollback.js --ordered). The chain owns them now.
--
-- Same constraint names as the inline list: whichever runs second is a no-op.
-- Rows pointing at users that no longer exist are removed first — exactly what
-- ON DELETE CASCADE would have done — so an existing install whose tables hold
-- such rows can still apply this migration.

DELETE FROM oauth_tokens t
 WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u._id = t."userId");

DELETE FROM server_boosts b
 WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u._id = b."userId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_oauth_tokens_user') THEN
    ALTER TABLE oauth_tokens ADD CONSTRAINT fk_oauth_tokens_user
      FOREIGN KEY ("userId") REFERENCES users(_id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_server_boosts_user') THEN
    ALTER TABLE server_boosts ADD CONSTRAINT fk_server_boosts_user
      FOREIGN KEY ("userId") REFERENCES users(_id) ON DELETE CASCADE;
  END IF;
END $$;
