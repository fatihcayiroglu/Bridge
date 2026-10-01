// server/tests/versioned-migrations.test.ts
//
// P5 SH-01 — the versioned chain shared by boot (initSchema) and the
// `migrate-postgres` CLI. Real PostgreSQL behaviour (fresh install, upgrade of
// a boot-only database, two nodes booting at once, opt-out + readiness) is
// exercised by the self-host harness against real processes; this suite pins
// the contract of the module itself.
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  applyPendingMigrations,
  autoMigrateEnabled,
  countPendingMigrations,
  listMigrationFiles,
  migrationsDir,
  MigrationFailedError,
  _resetSchemaCompleteCache,
  type MigrationQueryable,
} from '../db/postgres/versionedMigrations';

function fakeDb(applied: string[] = []) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const q: MigrationQueryable & { calls: typeof calls; applied: string[]; failOn?: string } = {
    calls,
    applied: [...applied],
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (q.failOn && sql === q.failOn) throw new Error('DDL exploded');
      if (sql.startsWith('SELECT id FROM schema_migrations')) return { rows: q.applied.map(id => ({ id })) as never[] };
      if (sql.startsWith('INSERT INTO schema_migrations')) q.applied.push(String(params?.[0]));
      return { rows: [] };
    },
  };
  return q;
}

function tmpChain(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-chain-'));
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}

describe('versioned migration chain (P5 SH-01)', () => {
  afterEach(() => _resetSchemaCompleteCache());

  it('reads the real chain from db/migrations_pg in name order (what boot and the CLI apply)', () => {
    const files = listMigrationFiles();
    expect(files.length).toBeGreaterThanOrEqual(75);
    expect(files[0]).toBe('001_client_error_events.sql');
    expect([...files].sort()).toEqual(files);
    expect(files.every(f => f.endsWith('.sql'))).toBe(true);
    expect(fs.existsSync(path.join(migrationsDir(), files[0]!))).toBe(true);
  });

  it('applies only pending files, in order, each in its own transaction with durable metadata', async () => {
    const dir = tmpChain({ '002_b.sql': 'SQL B', '001_a.sql': 'SQL A', '003_c.sql': 'SQL C', 'README.md': 'x' });
    const db = fakeDb(['001_a.sql']);
    const seen: string[] = [];
    const applied = await applyPendingMigrations(db, { dir, onApplied: f => seen.push(f) });
    expect(applied).toEqual(['002_b.sql', '003_c.sql']);
    expect(seen).toEqual(applied);
    const sqls = db.calls.map(c => c.sql);
    const b = sqls.indexOf('SQL B');
    expect(sqls.slice(b - 1, b + 3).map(s => s.split(' ')[0])).toEqual(['BEGIN', 'SQL', 'INSERT', 'COMMIT']);
    expect(sqls).not.toContain('SQL A');
    expect(sqls.indexOf('SQL B')).toBeLessThan(sqls.indexOf('SQL C'));
  });

  it('rolls back a failing file, keeps the earlier ones, and names the file', async () => {
    const dir = tmpChain({ '001_a.sql': 'SQL A', '002_b.sql': 'SQL B', '003_c.sql': 'SQL C' });
    const db = fakeDb();
    db.failOn = 'SQL B';
    const err = await applyPendingMigrations(db, { dir }).catch(e => e);
    expect(err).toBeInstanceOf(MigrationFailedError);
    expect(err.migration).toBe('002_b.sql');
    expect(err.message).toContain('DDL exploded');
    expect(db.applied).toEqual(['001_a.sql']);
    expect(db.calls.map(c => c.sql)).toContain('ROLLBACK');
    expect(db.calls.map(c => c.sql)).not.toContain('SQL C');
  });

  it('counts pending without DDL, treats a missing schema_migrations table as nothing applied, and caches completion', async () => {
    const missing = fakeDb();
    missing.query = async () => { throw Object.assign(new Error('relation "schema_migrations" does not exist'), { code: '42P01' }); };
    expect(await countPendingMigrations(missing, ['001.sql', '002.sql'])).toBe(2);

    const partial = fakeDb(['001.sql']);
    expect(await countPendingMigrations(partial, ['001.sql', '002.sql'])).toBe(1);
    expect(partial.calls.every(c => c.sql.startsWith('SELECT'))).toBe(true);

    const complete = fakeDb(['001.sql', '002.sql']);
    expect(await countPendingMigrations(complete, ['001.sql', '002.sql'])).toBe(0);
    const later = fakeDb([]); // a complete chain does not become incomplete within one process
    expect(await countPendingMigrations(later, ['001.sql', '002.sql'])).toBe(0);
    expect(later.calls).toHaveLength(0);
  });

  it('propagates any other database error instead of guessing', async () => {
    const denied = fakeDb();
    denied.query = async () => { throw Object.assign(new Error('permission denied'), { code: '42501' }); };
    await expect(countPendingMigrations(denied, ['001.sql'])).rejects.toThrow('permission denied');
  });

  it('auto-migrate is on unless BRIDGE_AUTO_MIGRATE=false', () => {
    expect(autoMigrateEnabled({})).toBe(true);
    expect(autoMigrateEnabled({ BRIDGE_AUTO_MIGRATE: 'true' })).toBe(true);
    expect(autoMigrateEnabled({ BRIDGE_AUTO_MIGRATE: ' FALSE ' })).toBe(false);
    expect(autoMigrateEnabled({ BRIDGE_AUTO_MIGRATE: 'false' })).toBe(false);
  });
});
