// P7 D2 migration 084: REAL PostgreSQL proof, never a mock.
 // This suite is run by the mandatory test:pg job against PG_TEST_URL only.
 // All destructive DDL and fixtures are rolled back in one transaction.
import fs from 'fs';
import path from 'path';
import { Client } from 'pg';

const PG_URL = process.env.PG_TEST_URL;
const RUN = PG_URL ? describe : describe.skip;
const dir = path.resolve(__dirname, '../../db/migrations_pg');
const up = fs.readFileSync(path.join(dir, '084_channel_expiry_foundation.sql'), 'utf8');
const down = fs.readFileSync(path.join(dir, 'rollback/084_channel_expiry_foundation.down.sql'), 'utf8');

async function inDisposableTransaction(body: (client: Client) => Promise<void>): Promise<void> {
  // This is deliberately NOT connected to DATABASE_URL or any production pool.
  const client = new Client({ connectionString: PG_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    try {
      await body(client);
    } finally {
      await client.query('ROLLBACK');
    }
  } finally {
    await client.end();
  }
}

RUN('P7 D2 migration 084 — real PostgreSQL reversible schema-only foundation', () => {
  it('keeps legacy channels permanent and validates tombstone constraints', async () => {
    await inDisposableTransaction(async client => {
      const cols = await client.query(
        `SELECT column_name, is_nullable, column_default
           FROM information_schema.columns WHERE table_schema = 'public'
           AND table_name = 'channels' AND column_name IN ('expiresAt','expiryVersion')`,
      );
      expect(cols.rows).toHaveLength(2);
      const expiry = cols.rows.find(r => r.column_name === 'expiresAt');
      const version = cols.rows.find(r => r.column_name === 'expiryVersion');
      expect(expiry?.is_nullable).toBe('YES');
      expect(version?.is_nullable).toBe('NO');
      expect(version?.column_default).toMatch(/^(?:0|'0')(?:\:\:(?:pg_catalog\.)?(?:int8|bigint))?$/i);
      const found = await client.query(
        "SELECT to_regclass('public.channel_expiry_tombstones') IS NOT NULL AS exists",
      );
      expect(found.rows[0].exists).toBe(true);

      await client.query(
        `INSERT INTO channel_expiry_tombstones
         ("channelId","serverId","expiredAt","expiryVersion","recordedAt")
         VALUES ('pgt-d2-valid', 'pgt-d2-server', 10, 0, 11)`,
      );
      await client.query('SAVEPOINT invalid_state');
      await expect(client.query(
        `INSERT INTO channel_expiry_tombstones
         ("channelId","serverId","expiredAt","expiryVersion","recordedAt")
         VALUES ('pgt-d2-invalid', 'pgt-d2-server', 0, -1, 11)`,
      )).rejects.toThrow();
      await client.query('ROLLBACK TO SAVEPOINT invalid_state');
    });
  });

  it('reverses and re-applies an unused migration without schema drift', async () => {
    await inDisposableTransaction(async client => {
      const existing = await client.query(
        'SELECT COUNT(*)::integer AS n FROM channel_expiry_tombstones',
      );
      expect(existing.rows[0].n).toBe(0);
      const active = await client.query(
        'SELECT COUNT(*)::integer AS n FROM channels WHERE "expiresAt" IS NOT NULL OR "expiryVersion" <> 0',
      );
      expect(active.rows[0].n).toBe(0);

      await client.query(down);
      const absent = await client.query(
        `SELECT to_regclass('public.channel_expiry_tombstones') AS tomb,
           (SELECT COUNT(*)::integer FROM information_schema.columns
             WHERE table_name='channels'
               AND column_name IN ('expiresAt','expiryVersion')) AS cols`,
      );
      expect(absent.rows[0]).toMatchObject({ tomb: null, cols: 0 });

      await client.query(up);
      const restored = await client.query(
        `SELECT to_regclass('public.channel_expiry_tombstones') IS NOT NULL AS tomb,
           (SELECT COUNT(*)::integer FROM information_schema.columns
             WHERE table_name='channels'
               AND column_name IN ('expiresAt','expiryVersion')) AS cols`,
      );
      expect(restored.rows[0]).toMatchObject({ tomb: true, cols: 2 });
    });
  });

  it('refuses to drop a populated tombstone or expiry metadata', async () => {
    await inDisposableTransaction(async client => {
      await client.query(
        `INSERT INTO channel_expiry_tombstones
         ("channelId","serverId","expiredAt","expiryVersion","recordedAt")
         VALUES ('pgt-d2-kept', 'pgt-d2-server', 10, 0, 11)`,
      );
      await client.query('SAVEPOINT refuse_tombstone');
      await expect(client.query(down)).rejects.toThrow(/tombstones exist/i);
      await client.query('ROLLBACK TO SAVEPOINT refuse_tombstone');
      expect((await client.query(
        "SELECT COUNT(*)::integer AS n FROM channel_expiry_tombstones WHERE \"channelId\"='pgt-d2-kept'",
      )).rows[0].n).toBe(1);

      await client.query("DELETE FROM channel_expiry_tombstones WHERE \"channelId\"='pgt-d2-kept'");
      await client.query(
        `INSERT INTO servers (_id, name, "ownerId", "createdAt")
         VALUES ('pgt-d2-rollback-server', 'Rollback fixture', 'pgt-d2-owner', 1)`,
      );
      await client.query(
        `INSERT INTO channels (_id, "serverId", name, "createdAt", "expiresAt", "expiryVersion")
         VALUES ('pgt-d2-rollback-channel', 'pgt-d2-rollback-server',
                 'rollback-fixture', 1, 1800000000000, 1)`,
      );
      await client.query('SAVEPOINT refuse_active');
      await expect(client.query(down)).rejects.toThrow(/expiry metadata is in use/i);
      await client.query('ROLLBACK TO SAVEPOINT refuse_active');
      expect((await client.query(
        `SELECT "expiryVersion" FROM channels WHERE _id='pgt-d2-rollback-channel'`,
      )).rows[0].expiryVersion).toBe('1');
    });
  });
  it('real channel and server deletion leave durable expiry tombstones intact', async () => {
    const { Channels, Servers } = require('../../db/repositories');
    // Only disposable PG_TEST_URL is used. Cleanup is explicit even on fail;
    // the repositories themselves use independent, committed transactions.
    const client = new Client({ connectionString: PG_URL });
    const id = `pgt-d2-retain-${process.pid}-${Date.now()}`;
    const channel = `${id}-a`;
    const sibling = `${id}-b`;
    await client.connect();
    try {
      await client.query(
        'INSERT INTO servers (_id, name, "ownerId", "createdAt") VALUES ($1,$2,$3,1)',
        [id, 'D2 tombstone proof', 'pgt-d2-owner'],
      );
      await client.query(
        'INSERT INTO channels (_id, "serverId", name, "createdAt") VALUES ($1,$3,$1,1),($2,$3,$2,1)',
        [channel, sibling, id],
      );
      await client.query(
        `INSERT INTO channel_expiry_tombstones
         ("channelId","serverId","expiredAt","expiryVersion","recordedAt")
         VALUES ($1,$2,100,1,101)`,
        [channel, id],
      );

      await expect(Channels.deleteGraphAtomic(channel, id)).resolves.toBe('deleted');
      const retained = await client.query(
        'SELECT "channelId" FROM channel_expiry_tombstones WHERE "channelId"=$1', [channel],
      );
      expect(retained.rows).toHaveLength(1);
      expect((await client.query('SELECT _id FROM channels WHERE _id=$1', [channel])).rows).toHaveLength(0);
      expect((await client.query('SELECT _id FROM channels WHERE _id=$1', [sibling])).rows).toHaveLength(1);

      await expect(Servers.deleteGraphAtomic(id)).resolves.toBe('deleted');
      expect((await client.query(
        'SELECT "channelId" FROM channel_expiry_tombstones WHERE "channelId"=$1', [channel],
      )).rows).toHaveLength(1);
      expect((await client.query('SELECT _id FROM servers WHERE _id=$1', [id])).rows).toHaveLength(0);
    } finally {
      try {
        await client.query('DELETE FROM channel_expiry_tombstones WHERE "channelId"=$1', [channel]);
        await client.query('DELETE FROM channels WHERE "serverId"=$1', [id]);
        await client.query('DELETE FROM servers WHERE _id=$1', [id]);
      } finally {
        await client.end();
      }
    }
  });

});
