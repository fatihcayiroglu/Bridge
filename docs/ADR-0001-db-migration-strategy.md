# ADR-0001: Database Migration Strategy

## Status
Accepted — updated for the PostgreSQL-only runtime

## Context
Bridge historically supported a SQLite runtime and carried a separate SQLite
migration runner. The production database loader is now PostgreSQL-only and fails
closed when `DATABASE_URL` is missing. Keeping a second, non-runnable SQLite
migration path makes release behavior ambiguous and allows documentation/scripts to
drift away from the production database contract.

## Decision
- PostgreSQL is the only runtime database engine.
- Ordered SQL migrations in `server/db/migrations_pg/` are the release migration
  source of truth.
- Every forward `.sql` migration must have a matching
  `server/db/migrations_pg/rollback/*.down.sql` file.
- Non-lossless or cross-migration rollback behavior must be explicitly classified
  in `rollback-classification.json`; unclassified rollback drift fails the gate.
- Production migration commands execute the compiled runner at
  `server/dist/db/migrate-postgres.js`.
- `server/scripts/copy-runtime-assets.cjs` copies SQL/JSON migration assets into
  `server/dist/db/migrations_pg/` after TypeScript compilation so a production
  install does not require `ts-node` or devDependencies.
- Source-mode migration commands are explicitly suffixed `:source` and are for
  development/CI only.

## Consequences
- There is one deployable database migration path instead of SQLite/PostgreSQL
  dual authority.
- Production migration execution works after devDependencies are pruned.
- Docker/runtime images carry the exact migration SQL and rollback assets needed by
  the compiled runner.
- Historical SQLite-to-PostgreSQL data conversion is not an automatic runtime
  fallback. Operators migrating data from an old SQLite-era release must use an
  export/import process appropriate to that historical version and verify it before
  cutover.
