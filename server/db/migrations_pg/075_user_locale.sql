-- The language a person reads (Final21 Phase 16).
--
-- Everything the SERVER writes to a person — push notification titles — was Turkish only,
-- because nothing recorded which language they read. The client ships ten locales; this column
-- carries the reader's choice to the server.
--
-- NULL means "not told yet": the server falls back to its default locale rather than guessing.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS locale TEXT;
