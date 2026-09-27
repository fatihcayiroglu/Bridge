DROP TABLE IF EXISTS soundboard_user_stats;
DROP INDEX IF EXISTS idx_soundboard_server_name;
DROP INDEX IF EXISTS idx_soundboard_server_page;

-- Additive sound metadata and its write constraints are intentionally retained.
--
-- There are two valid pre-059 states:
--   * clean installs already own these columns plus VALIDATED constraints via
--     schema.ts;
--   * legacy upgrades receive the same write constraints as NOT VALID so old
--     rows do not block rollout while every new/updated row is still checked.
--
-- Dropping and recreating the objects here destroyed that distinction: a clean
-- install came back NOT VALID, and the duration constraint's equivalent NULL
-- form acquired a different catalog definition. More importantly, dropping
-- the metadata columns would irreversibly erase uploaded-sound data during a
-- rollback. Older application binaries safely ignore additive columns, so a
-- correct/data-safe rollback removes the 059-only table/index behavior while
-- preserving the exact constraint validation state it found.
