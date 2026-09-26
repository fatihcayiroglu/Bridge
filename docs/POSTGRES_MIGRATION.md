# Bridge — PostgreSQL Schema Migration Guide

Bridge v1.125.0 is PostgreSQL-only. The server requires `DATABASE_URL`; there is no
SQLite runtime fallback and no current-tree automatic SQLite data-conversion runner.

## 1. Build before production migration

A source checkout does not ship `server/dist/`. Build with development dependencies
first, then prune them only after compilation:

```bash
npm ci
npm run build:ci
npm --prefix server ci
npm --prefix server run build
npm --prefix server prune --omit=dev
```

The server build compiles `db/migrate-postgres.ts` and copies the ordered SQL/JSON
migration assets to `server/dist/db/migrations_pg/`.

## 2. Configure PostgreSQL

Set a production connection string through the deployment secret mechanism:

```env
DATABASE_URL=postgresql://bridge_user:strong-password@db.example.net:5432/bridge
```

Use the SSL settings documented in `CONFIGURATION.md` when your provider requires
TLS. Do not commit a populated `.env` file.

## 3. Apply and inspect migrations

From the `server/` directory after a successful build:

```bash
npm run db:migrate:pg
npm run db:migrate:pg:status
```

Rollback commands are intentionally explicit:

```bash
npm run db:migrate:pg:down
npm run db:migrate:pg:rollback -- 3
```

The rollback verifier used by CI is stricter than the CLI: it checks each down file,
classification drift, and the ordered rollback/re-apply chain against PostgreSQL.

## 4. Development/source mode

When devDependencies are installed, developers may run the TypeScript source runner
without building first:

```bash
npm run db:migrate:pg:source
npm run db:migrate:pg:source:status
```

These commands are not the production deployment path.

## 5. Legacy SQLite data

Current Bridge does not start against SQLite and does not include a supported
`migrate-to-postgres.js` converter. If an installation still contains data created
by a SQLite-era Bridge version, keep that original database immutable, export it
with tooling from the matching historical release, import into a disposable
PostgreSQL database, reconcile row counts/constraints, and rehearse the cutover
before touching production. Do not infer success from server startup alone.
