// Real PostgreSQL negative controls for the P7 D3 upgrade-source guard.
// Only PG_TEST_URL is used; all synthetic schema/ledger writes are rolled back.
import { Client } from 'pg';
import type { MigrationQueryable } from '../../db/postgres/versionedMigrations';
import { UnverifiedUpgradeSourceError, verifyUpgradeSource } from '../../db/postgres/upgradePreflight';

const PG_URL = process.env.PG_TEST_URL;
if (!PG_URL) throw new Error('PG_TEST_URL is required for the real PostgreSQL upgrade-source suite');

async function inRolledBackTransaction(body: (c: Client) => Promise<void>): Promise<void> {
  const c = new Client({ connectionString: PG_URL });
  await c.connect();
  try {
    await c.query('BEGIN');
    try {
      await body(c);
    } finally {
      await c.query('ROLLBACK');
    }
  } finally {
    await c.end();
  }
}

describe('P7 D3 upgrade preflight — real PostgreSQL, rollback-only', () => {
  it.each([
    ['roles', "CREATE TABLE roles (_id TEXT PRIMARY KEY, name TEXT); INSERT INTO roles VALUES ('kept-role', 'kept')", 'SELECT * FROM roles'],
    ['ledger', "CREATE TABLE schema_migrations (id TEXT PRIMARY KEY); INSERT INTO schema_migrations VALUES ('045_partial.sql')", 'SELECT * FROM schema_migrations'],
    ['sequence', 'CREATE SEQUENCE existing_sequence START 41', 'SELECT last_value, is_called FROM existing_sequence'],
    ['view', 'CREATE VIEW existing_view AS SELECT 41 AS kept', 'SELECT * FROM existing_view'],
  ])('refuses a nonempty %s-only source without base tables or mutations', async (_kind, ddl, snapshotSql) => {
    await inRolledBackTransaction(async c => {
      await c.query('CREATE SCHEMA pgt_d3_nonempty_preflight');
      await c.query('SET LOCAL search_path TO pgt_d3_nonempty_preflight');
      await c.query(ddl);
      const before = await c.query(snapshotSql);
      const objectsBefore = await c.query(
        "SELECT relname, relkind FROM pg_class WHERE relnamespace = current_schema()::regnamespace ORDER BY relname",
      );
      await expect(verifyUpgradeSource(c as unknown as MigrationQueryable))
        .rejects.toBeInstanceOf(UnverifiedUpgradeSourceError);
      expect((await c.query(snapshotSql)).rows).toEqual(before.rows);
      expect((await c.query(
        "SELECT relname, relkind FROM pg_class WHERE relnamespace = current_schema()::regnamespace ORDER BY relname",
      )).rows).toEqual(objectsBefore.rows);
    });
  });

  it('admits an actually empty current schema even when a current installation exists elsewhere', async () => {
    await inRolledBackTransaction(async c => {
      await c.query('CREATE SCHEMA pgt_d3_empty_preflight');
      await c.query('SET LOCAL search_path TO pgt_d3_empty_preflight');
      await expect(verifyUpgradeSource(c as unknown as MigrationQueryable)).resolves.toBeUndefined();
      expect((await c.query(
        'SELECT relname FROM pg_class WHERE relnamespace = current_schema()::regnamespace',
      )).rows).toEqual([]);
    });
  });

  it('admits extension-owned views but still rejects application data beside them', async () => {
    await inRolledBackTransaction(async c => {
      await c.query('CREATE SCHEMA pgt_d3_extension_preflight');
      await c.query('SET LOCAL search_path TO pgt_d3_extension_preflight');
      await c.query('CREATE EXTENSION pg_stat_statements WITH SCHEMA pgt_d3_extension_preflight');
      const objectsBefore = await c.query(
        'SELECT relname FROM pg_class WHERE relnamespace = current_schema()::regnamespace ORDER BY relname',
      );
      expect(objectsBefore.rows.length).toBeGreaterThan(0);
      await expect(verifyUpgradeSource(c as unknown as MigrationQueryable)).resolves.toBeUndefined();
      expect((await c.query(
        'SELECT relname FROM pg_class WHERE relnamespace = current_schema()::regnamespace ORDER BY relname',
      )).rows).toEqual(objectsBefore.rows);

      await c.query('CREATE TABLE roles (_id TEXT PRIMARY KEY)');
      await c.query("INSERT INTO roles VALUES ('kept-extension-role')");
      await expect(verifyUpgradeSource(c as unknown as MigrationQueryable))
        .rejects.toBeInstanceOf(UnverifiedUpgradeSourceError);
      expect((await c.query('SELECT * FROM roles')).rows).toEqual([{ _id: 'kept-extension-role' }]);
    });
  });

  it('recognises the current 084 baseline without any schema changes', async () => {
    await inRolledBackTransaction(async c => {
      const before = await c.query(
        "SELECT COUNT(*)::integer AS n FROM schema_migrations WHERE split_part(id, '_', 1) = '084' AND rolled_back = FALSE",
      );
      expect(before.rows[0].n).toBe(1);
      await expect(verifyUpgradeSource(c as unknown as MigrationQueryable)).resolves.toBeUndefined();
      const after = await c.query(
        "SELECT COUNT(*)::integer AS n FROM schema_migrations WHERE split_part(id, '_', 1) = '084' AND rolled_back = FALSE",
      );
      expect(after.rows).toEqual(before.rows);
    });
  });

  it('refuses a synthetic release schema and leaves it byte-for-byte unchanged', async () => {
    await inRolledBackTransaction(async c => {
      await c.query('CREATE SCHEMA pgt_d3_legacy_preflight');
      await c.query('SET LOCAL search_path TO pgt_d3_legacy_preflight');
      await c.query('CREATE TABLE users (_id TEXT PRIMARY KEY, username TEXT)');
      await c.query('CREATE TABLE messages (_id TEXT PRIMARY KEY, content TEXT)');
      await c.query("INSERT INTO users (_id, username) VALUES ('legacy-user', 'kept')");
      const before = await c.query('SELECT * FROM users ORDER BY _id');
      const objectsBefore = await c.query(
        "SELECT relname FROM pg_class WHERE relnamespace = 'pgt_d3_legacy_preflight'::regnamespace ORDER BY relname",
      );

      await expect(verifyUpgradeSource(c as unknown as MigrationQueryable))
        .rejects.toBeInstanceOf(UnverifiedUpgradeSourceError);
      expect((await c.query('SELECT * FROM users ORDER BY _id')).rows).toEqual(before.rows);
      expect((await c.query(
        "SELECT relname FROM pg_class WHERE relnamespace = 'pgt_d3_legacy_preflight'::regnamespace ORDER BY relname",
      )).rows).toEqual(objectsBefore.rows);
    });
  });

  it('refuses the measured 084-complete staged release shape with NOT NULL embeds', async () => {
    await inRolledBackTransaction(async c => {
      await c.query('CREATE SCHEMA pgt_d3_staged_preflight');
      await c.query('SET LOCAL search_path TO pgt_d3_staged_preflight');
      await c.query('CREATE TABLE users ("ssoProvider" TEXT)');
      await c.query("CREATE TABLE messages (\"ackId\" TEXT, embeds JSONB NOT NULL DEFAULT '[]')");
      await c.query('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, rolled_back BOOLEAN NOT NULL DEFAULT FALSE)');
      await c.query("INSERT INTO schema_migrations (id, rolled_back) VALUES ('084_channel_expiry_foundation.sql', FALSE)");
      await expect(verifyUpgradeSource(c as unknown as MigrationQueryable))
        .rejects.toThrow('messages.embeds nullable');
      expect((await c.query('SELECT id, rolled_back FROM schema_migrations')).rows)
        .toEqual([{ id: '084_channel_expiry_foundation.sql', rolled_back: false }]);
    });
  });

  it('refuses a partially upgraded legacy ledger even when both markers exist', async () => {
    await inRolledBackTransaction(async c => {
      await c.query('CREATE SCHEMA pgt_d3_partial_preflight');
      await c.query('SET LOCAL search_path TO pgt_d3_partial_preflight');
      await c.query('CREATE TABLE users ("ssoProvider" TEXT)');
      await c.query('CREATE TABLE messages ("ackId" TEXT, embeds JSONB)');
      await c.query('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, rolled_back BOOLEAN NOT NULL DEFAULT FALSE)');
      await c.query("INSERT INTO schema_migrations (id, rolled_back) VALUES ('045_partial.sql', FALSE)");
      await expect(verifyUpgradeSource(c as unknown as MigrationQueryable))
        .rejects.toThrow('applied migration 084 baseline');
      const ledger = await c.query('SELECT id, rolled_back FROM schema_migrations');
      expect(ledger.rows).toEqual([{ id: '045_partial.sql', rolled_back: false }]);
    });
  });
});
