import fs from 'fs';
import path from 'path';
import { reserveUploadReleaseKeys } from '../../lib/uploadReleaseFence';
import type { UploadReferenceQueryable } from '../../lib/uploadReferenceSafety';

const db = require('../../db/loader').default;
const RUN = process.env.PG_TEST_URL ? describe : describe.skip;
const P = 'pgt-release-reservation-' + process.pid + '-' + Date.now();
const down = fs.readFileSync(path.resolve(__dirname, '../../db/migrations_pg/rollback/091_upload_release_reservations.down.sql'), 'utf8');
const up = fs.readFileSync(path.resolve(__dirname, '../../db/migrations_pg/091_upload_release_reservations.sql'), 'utf8');

RUN('real PostgreSQL upload deletion reservations', () => {
  const q = async (sql: string, params: unknown[] = []) => (await db._pool.query(sql, params)).rows as Array<Record<string, unknown>>;
  let seq = 0;
  const key = () => `uploads/${P}-${++seq}.png`;
  beforeAll(async () => {
    await q('INSERT INTO users (_id, username, "displayName", password, "createdAt") VALUES ($1,$1,$1,$1,1)', [P]);
  });
  afterAll(async () => {
    await q('DELETE FROM users WHERE _id=$1', [P]);
    await q('DELETE FROM upload_release_keys WHERE key LIKE $1', [`uploads/${P}%`]);
  });

  it('retains shared keys and leaves their current and future references writable', async () => {
    const k = key();
    await q('UPDATE users SET "avatarUrl"=$1 WHERE _id=$2', ['/' + k, P]);
    expect(await reserveUploadReleaseKeys(db._pool, [k])).toEqual(new Set([k]));
    expect((await q('SELECT reserved FROM upload_release_keys WHERE key=$1', [k]))[0]).toEqual({ reserved: false });
    await q('UPDATE users SET "bannerUrl"=$1 WHERE _id=$2', ['https://assets.example/' + k, P]);
    await q('UPDATE users SET "avatarUrl"=NULL, "bannerUrl"=NULL WHERE _id=$1', [P]);
  });

  it('refuses relative and absolute late references after the deletion reservation commits', async () => {
    const k = key();
    expect(await reserveUploadReleaseKeys(db._pool, [k])).toEqual(new Set());
    for (const url of [k, '/' + k, 'https://assets.example/path/' + k]) {
      await expect(q('UPDATE users SET "avatarUrl"=$1 WHERE _id=$2', [url, P])).rejects.toThrow('upload_release_reserved');
    }
    // Retries keep the reservation; they must not reopen a deleted key.
    expect(await reserveUploadReleaseKeys(db._pool, [k])).toEqual(new Set());
    expect((await q('SELECT reserved FROM upload_release_keys WHERE key=$1', [k]))[0]).toEqual({ reserved: true });
  });

  it('waits for an in-flight referencing writer and retains its object after COMMIT', async () => {
    const k = key();
    const writer = await db._pool.connect();
    const reserver = await db._pool.connect();
    const pid = (await reserver.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    let reservation: Promise<Set<string>> | undefined;
    try {
      await writer.query('BEGIN');
      await writer.query('UPDATE users SET "avatarUrl"=$1 WHERE _id=$2', ['/' + k, P]);
      reservation = reserveUploadReleaseKeys({
        query: db._pool.query.bind(db._pool), connect: async () => reserver,
      } as UploadReferenceQueryable, [k]);
      const deadline = Date.now() + 5000;
      let waiting = false;
      while (Date.now() < deadline) {
        const row = (await q('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid]))[0];
        if (row?.wait_event_type === 'Lock') { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await writer.query('COMMIT');
      expect(await reservation).toEqual(new Set([k]));
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
      if (reservation) await reservation;
      else reserver.release();
      await q('UPDATE users SET "avatarUrl"=NULL WHERE _id=$1', [P]);
    }
  });

  it('does not let an older repeatable-read snapshot bypass the reservation', async () => {
    const k = key();
    const writer = await db._pool.connect();
    try {
      await writer.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await writer.query('SELECT _id FROM users WHERE _id=$1', [P]);
      await reserveUploadReleaseKeys(db._pool, [k]);
      await expect(writer.query('UPDATE users SET "avatarUrl"=$1 WHERE _id=$2', ['/' + k, P]))
        .rejects.toMatchObject({ code: '40001' });
    } finally { await writer.query('ROLLBACK'); writer.release(); }
  });

  it('rolls back reservations when reference evidence is unavailable', async () => {
    const k = key();
    const client = await db._pool.connect();
    const original = client.query.bind(client);
    // Actual INSERT/ROLLBACK on PostgreSQL, with failure injected at the scan.
    const wrapped = {
      async query(sql: string, params?: unknown[]) {
        if (sql.includes('WITH upload_refs')) throw new Error('reference evidence unavailable');
        return original(sql, params);
      },
      release() { client.release(); },
    };
    await expect(reserveUploadReleaseKeys({ query: db._pool.query.bind(db._pool), connect: async () => wrapped } as UploadReferenceQueryable, [k]))
      .rejects.toThrow('reference evidence unavailable');
    expect(await q('SELECT 1 FROM upload_release_keys WHERE key=$1', [k])).toEqual([]);
  });

  it('refuses a rollback that would discard durable deletion reservations', async () => {
    await reserveUploadReleaseKeys(db._pool, [key()]);
    const client = await db._pool.connect();
    try {
      await client.query('BEGIN');
      await expect(client.query(down)).rejects.toThrow('Cannot roll back 091');
      await client.query('ROLLBACK');
      expect((await q('SELECT COUNT(*)::int AS n FROM pg_trigger WHERE tgname=$1', ['guard_upload_release_reference']))[0]?.n).toBe(14);
    } finally { client.release(); }
  });

  it('preserves existing data through upgrade, empty rollback and roll-forward', async () => {
    const schema = P.replace(/[^a-z0-9_]/g, '_');
    const client = await db._pool.connect();
    const tables = ['messages', 'dm_messages', 'group_dm_messages', 'users', 'servers', 'members',
      'server_gifs', 'server_emojis', 'soundboard', 'voice_messages', 'sticker_pack_items',
      'podcast_settings', 'podcast_episodes', 'uploads'];
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}", public`);
      for (const table of tables) {
        await client.query(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
      }
      await client.query(`INSERT INTO "${schema}".users SELECT * FROM public.users WHERE _id=$1`, [P]);
      const before = (await client.query(`SELECT * FROM "${schema}".users`)).rows;
      expect(before).toHaveLength(1);
      await client.query(up);
      expect((await client.query('SELECT COUNT(*)::int AS n FROM upload_release_keys')).rows[0].n).toBe(0);
      expect((await client.query(`SELECT * FROM "${schema}".users`)).rows).toEqual(before);
      await client.query(down);
      expect((await client.query(`SELECT * FROM "${schema}".users`)).rows).toEqual(before);
      await client.query(up);
      expect((await client.query(`SELECT * FROM "${schema}".users`)).rows).toEqual(before);
      const guards = await client.query(`SELECT COUNT(*)::int AS n FROM pg_trigger t
        JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE t.tgname='guard_upload_release_reference' AND n.nspname=$1`, [schema]);
      expect(guards.rows[0].n).toBe(14);
    } finally {
      // The entire private test schema and its data are transaction-scoped.
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
