// server/db/postgres/versionedMigrations.ts
//
// The versioned SQL chain in `db/migrations_pg/*.sql`, shared by the boot path
// (`initSchema`) and the `migrate-postgres` CLI.
//
// P5 SH-01: a fresh install booted with the image's own command
// (`node server/dist/index.js`) applied only the base schema and the inline
// migrations. All 75 versioned migrations stayed pending (federation delivery
// queue, ActivityPub follows, OAuth tokens, server boosts, ...) while
// `/api/health/ready` answered 200. Nothing in the image, compose or k8s ran the
// chain. Boot now applies it (inside initSchema's advisory lock, so concurrent
// nodes serialise), and readiness refuses to report ready while any migration
// is pending.

import fs from 'fs';
import path from 'path';

/** Anything that can run a parameterised query (pg Client / PoolClient). */
export interface MigrationQueryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[] }>;
}

/** A versioned migration failed and was rolled back; names the file. */
export class MigrationFailedError extends Error {
  readonly migration: string;
  constructor(migration: string, cause: unknown) {
    super(`Versioned migration ${migration} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'MigrationFailedError';
    this.migration = migration;
  }
}

/** `db/migrations_pg` relative to this file — the same in source and in `dist`. */
export function migrationsDir(): string {
  return path.join(__dirname, '..', 'migrations_pg');
}

export function listMigrationFiles(dir: string = migrationsDir()): string[] {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
}

export async function ensureMigrationsTable(q: MigrationQueryable): Promise<void> {
  await q.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          TEXT    PRIMARY KEY,
      applied_at  BIGINT  NOT NULL,
      rolled_back BOOLEAN NOT NULL DEFAULT FALSE
    );
  `);
  // Older tables were created without `rolled_back`.
  await q.query(`
    ALTER TABLE schema_migrations
      ADD COLUMN IF NOT EXISTS rolled_back BOOLEAN NOT NULL DEFAULT FALSE;
  `);
}

/** Applied (not rolled back) migration ids, oldest first. */
export async function appliedMigrations(q: MigrationQueryable): Promise<string[]> {
  const res = await q.query<{ id: string }>(
    'SELECT id FROM schema_migrations WHERE rolled_back = FALSE ORDER BY applied_at ASC, id ASC',
  );
  return res.rows.map((r) => r.id);
}

export async function pendingMigrations(
  q: MigrationQueryable,
  files: string[] = listMigrationFiles(),
): Promise<string[]> {
  await ensureMigrationsTable(q);
  const applied = new Set(await appliedMigrations(q));
  return files.filter((f) => !applied.has(f));
}

/**
 * Applies every pending migration in order, each in its own transaction.
 * A failing migration is rolled back and rethrown with the file name; the ones
 * before it stay applied (the same contract as `migrate-postgres up`).
 * Callers that may race (several nodes booting) must hold a lock around this.
 */
export async function applyPendingMigrations(
  client: MigrationQueryable,
  opts: { dir?: string; onApplied?: (file: string) => void } = {},
): Promise<string[]> {
  const dir = opts.dir ?? migrationsDir();
  const pending = await pendingMigrations(client, listMigrationFiles(dir));
  const applied: string[] = [];
  for (const file of pending) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (id, applied_at, rolled_back) VALUES ($1, $2, FALSE) ' +
        'ON CONFLICT (id) DO UPDATE SET rolled_back = FALSE, applied_at = $2',
        [file, Date.now()],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new MigrationFailedError(file, err);
    }
    applied.push(file);
    opts.onApplied?.(file);
  }
  return applied;
}

let schemaComplete = false;

/**
 * Read-only pending count for readiness probes (no DDL). Once the chain is
 * complete the answer is cached for the life of the process: migrations are
 * only ever added by a new release, which means a new process.
 */
export async function countPendingMigrations(
  q: MigrationQueryable,
  files: string[] = listMigrationFiles(),
): Promise<number> {
  if (schemaComplete) return 0;
  let applied: Set<string>;
  try {
    applied = new Set(await appliedMigrations(q));
  } catch (err) {
    // 42P01: schema_migrations does not exist yet — nothing applied.
    if ((err as { code?: string }).code !== '42P01') throw err;
    applied = new Set();
  }
  const pending = files.filter((f) => !applied.has(f)).length;
  if (pending === 0) schemaComplete = true;
  return pending;
}

/** Test isolation only. */
export function _resetSchemaCompleteCache(): void {
  schemaComplete = false;
}

/** `BRIDGE_AUTO_MIGRATE=false` leaves the chain to an operator-run `migrate-postgres up`. */
export function autoMigrateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.BRIDGE_AUTO_MIGRATE ?? 'true').trim().toLowerCase() !== 'false';
}
