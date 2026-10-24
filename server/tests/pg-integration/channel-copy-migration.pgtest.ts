import fs from 'fs';
import path from 'path';
import { Messages } from '../../db/repositories';

const db = require('../../db/loader').default;
const P = 'pgt-d2-copy-schema-' + process.pid + '-' + Date.now();
const USER = P + '-owner';
const SERVER = P + '-server';
const SOURCE = P + '-source';
const TARGET = P + '-target';
const up = fs.readFileSync(path.resolve(__dirname, '../../db/migrations_pg/092_channel_copy_source_barrier.sql'), 'utf8');
const down = fs.readFileSync(path.resolve(__dirname, '../../db/migrations_pg/rollback/092_channel_copy_source_barrier.down.sql'), 'utf8');
const CATALOG = `SELECT pg_get_functiondef(p.oid) AS definition, p.provolatile, p.prosecdef,
  pg_get_triggerdef(t.oid) AS trigger, t.tgtype, t.tgenabled, t.tgdeferrable, t.tginitdeferred
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  JOIN pg_trigger t ON t.tgfoid=p.oid
  WHERE n.nspname='public' AND p.proname='bridge_channel_copy_source_barrier'
    AND t.tgrelid='messages'::regclass AND t.tgname='zz_channel_final_admission'`;

describe('D2 migration 092 executable recovery contract — real PostgreSQL', () => {
  const q = (sql: string, params: unknown[] = []) => db._pool.query(sql, params);
  beforeAll(async () => {
    await q('INSERT INTO users (_id,username,"displayName",password,"createdAt") VALUES ($1,$1,$1,$1,1)', [USER]);
    await q('INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,$1,$2,1)', [SERVER, USER]);
    await q('INSERT INTO channels (_id,"serverId",name,"createdAt") VALUES ($1,$3,$1,1),($2,$3,$2,1)', [SOURCE, TARGET, SERVER]);
    await Messages.create({ _id: P + '-message', channelId: SOURCE, serverId: SERVER, userId: USER,
      username: USER, displayName: 'Synthetic owner', content: 'original migration fixture', createdAt: 1 });
    await Messages.create({ _id: P + '-copy', channelId: TARGET, serverId: SERVER, userId: USER,
      username: USER, displayName: 'Synthetic owner', content: 'existing permanent migration copy', createdAt: 1,
      bridgedFrom: { channelId: SOURCE, serverId: SERVER } });
    await q(`UPDATE channels SET "expiresAt"=FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT-1000,
      "expiryVersion"=1 WHERE _id=$1`, [SOURCE]);
  });
  afterAll(async () => {
    await q('DELETE FROM messages WHERE "channelId" IN ($1,$2)', [SOURCE, TARGET]);
    await q('DELETE FROM channels WHERE "serverId"=$1', [SERVER]);
    await q('DELETE FROM servers WHERE _id=$1', [SERVER]);
    await q('DELETE FROM users WHERE _id=$1', [USER]);
  });

  it('restores identical function/trigger definitions and preserves existing data over down/up and replay', async () => {
    const client = await db._pool.connect();
    try {
      await client.query('BEGIN');
      const before = (await client.query(CATALOG)).rows;
      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({ provolatile: 'v', prosecdef: false, tgtype: 21,
        tgenabled: 'O', tgdeferrable: false, tginitdeferred: false });
      const rows = async () => (await client.query('SELECT to_jsonb(m) AS row FROM messages m WHERE "channelId" IN ($1,$2) ORDER BY _id', [SOURCE, TARGET])).rows;
      const original = await rows();
      expect(original).toHaveLength(2);
      await client.query(down);
      expect((await client.query(CATALOG)).rows).toEqual([]);
      await client.query(up);
      expect((await client.query(CATALOG)).rows).toEqual(before);
      expect(await rows()).toEqual(original);
      await client.query(up);
      expect((await client.query(CATALOG)).rows).toEqual(before);
      expect(await rows()).toEqual(original);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

  it('cannot defer the final source check with SET CONSTRAINTS ALL DEFERRED', async () => {
    const client = await db._pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      await expect(client.query(`INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,"createdAt","bridgedFrom")
        VALUES ($1,$2,$3,$4,$4,$4,'deferred source fixture',1,$5::jsonb)`,
      [P + '-deferred', TARGET, SERVER, USER, JSON.stringify({ channelId: SOURCE, serverId: SERVER })]))
        .rejects.toMatchObject({ code: 'BX001' });
    } finally { await client.query('ROLLBACK'); client.release(); }
    expect((await q('SELECT _id FROM messages WHERE _id=$1', [P + '-deferred'])).rows).toEqual([]);
  });
});
