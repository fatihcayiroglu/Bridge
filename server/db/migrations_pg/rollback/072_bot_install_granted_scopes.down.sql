-- 072_bot_install_granted_scopes.down.sql
ALTER TABLE server_bots DROP COLUMN IF EXISTS "grantedScopes";
