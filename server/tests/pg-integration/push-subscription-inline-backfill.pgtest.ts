// Real PostgreSQL coverage for the boot-time legacy push subscription backfill.
// Each synthetic schema is created inside a rollback-only transaction: neither
// existing user subscriptions nor production schema objects are touched.
import { Client } from 'pg';
import { LEGACY_PUSH_SUBSCRIPTIONS_BACKFILL_SQL } from '../../db/postgres/migrations';

const PG_URL = process.env.PG_TEST_URL;
if (!PG_URL) throw new Error('PG_TEST_URL is required for real PostgreSQL migration tests');

async function withSyntheticSchema(
  suffix: string,
  body: (client: Client) => Promise<void>,
): Promise<void> {
  const client = new Client({ connectionString: PG_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    try {
      // All suffixes are fixed, local test literals, not external identifiers.
      const schema = `pgt_push_backfill_${suffix}`;
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path TO ${schema}`);
      await body(client);
    } finally {
      await client.query('ROLLBACK');
    }
  } finally {
    await client.end();
  }
}

describe('inline push-subscription legacy backfill — real PostgreSQL', () => {
  it('is a clean no-op before the table exists and on the fresh endpoint/keys-only schema', async () => {
    await withSyntheticSchema('fresh', async c => {
      await expect(c.query(LEGACY_PUSH_SUBSCRIPTIONS_BACKFILL_SQL)).resolves.toBeDefined();
      await c.query(`CREATE TABLE push_subscriptions (
        _id TEXT PRIMARY KEY, endpoint TEXT, keys JSONB
      )`);
      await c.query(`INSERT INTO push_subscriptions VALUES
        ('new', 'https://push.example/new', '{"auth":"new"}')`);
      const before = (await c.query('SELECT * FROM push_subscriptions')).rows;
      await expect(c.query(LEGACY_PUSH_SUBSCRIPTIONS_BACKFILL_SQL)).resolves.toBeDefined();
      await expect(c.query(LEGACY_PUSH_SUBSCRIPTIONS_BACKFILL_SQL)).resolves.toBeDefined();
      expect((await c.query('SELECT * FROM push_subscriptions')).rows).toEqual(before);
    });
  });

  it('preserves current endpoints while recovering only missing legacy endpoint/keys', async () => {
    await withSyntheticSchema('legacy', async c => {
      await c.query(`CREATE TABLE push_subscriptions (
        _id TEXT PRIMARY KEY, subscription JSONB, endpoint TEXT, keys JSONB
      )`);
      await c.query(`INSERT INTO push_subscriptions VALUES
        ('old', '{"endpoint":"https://push.example/old","keys":{"auth":"old"}}', NULL, NULL),
        ('current', '{"endpoint":"https://push.example/stale","keys":{"auth":"stale"}}',
                    'https://push.example/current', '{"auth":"current"}'),
        ('empty', NULL, NULL, NULL)`);

      await c.query(LEGACY_PUSH_SUBSCRIPTIONS_BACKFILL_SQL);
      const first = (await c.query('SELECT _id, endpoint, keys FROM push_subscriptions ORDER BY _id')).rows;
      expect(first).toEqual([
        { _id: 'current', endpoint: 'https://push.example/current', keys: { auth: 'current' } },
        { _id: 'empty', endpoint: null, keys: null },
        { _id: 'old', endpoint: 'https://push.example/old', keys: { auth: 'old' } },
      ]);
      await c.query(LEGACY_PUSH_SUBSCRIPTIONS_BACKFILL_SQL);
      expect((await c.query('SELECT _id, endpoint, keys FROM push_subscriptions ORDER BY _id')).rows)
        .toEqual(first);
    });
  });

  it('does not disguise an incompatible legacy column type as a successful backfill', async () => {
    await withSyntheticSchema('incompatible', async c => {
      await c.query(`CREATE TABLE push_subscriptions (
        subscription TEXT, endpoint TEXT, keys JSONB
      )`);
      await c.query(`INSERT INTO push_subscriptions VALUES ('old-json', NULL, NULL)`);
      await expect(c.query(LEGACY_PUSH_SUBSCRIPTIONS_BACKFILL_SQL))
        .rejects.toThrow(/operator does not exist/);
    });
  });
});
