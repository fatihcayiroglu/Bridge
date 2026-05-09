# ADR-0001: Database Migration Strategy

## Status
Accepted

## Context
Schema updates were historically created implicitly at runtime in `server/db/index.js` and `server/db/postgres.js`.
This creates risk in production because schema drift is harder to track and rollbacks are not explicit.

## Decision
- Use file-based, ordered SQL migrations as the source of truth for schema changes.
- Maintain separate runners:
  - `server/db/migrate.js` for SQLite migrations in `server/db/migrations`.
  - `server/db/migrate-postgres.js` for PostgreSQL migrations in `server/db/migrations_pg`.
- Track applied migrations in a `schema_migrations` table for each engine.

## Consequences
- Deployments become predictable and auditable.
- Runtime table creation should be gradually reduced and eventually removed.
- New schema changes must always be added as migration files before release.
