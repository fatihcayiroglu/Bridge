/** Database statement admission, independent of voice HTTP preflights/storage. */
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { TOMBSTONE_USER_ID } from '../../lib/accountLifecycle';
if (!process.env.PG_TEST_URL) throw new Error('Voice write-barrier proof requires PG_TEST_URL');
const db = require('../../db/loader').default as typeof import('../../db/postgres').default;
const q = (sql: string, values: unknown[] = []) => db._pool.query(sql, values);
interface Fixture { user: string; server: string; other: string; channel: string; voice: string; message: string; thread: string; key: string }
const fixtures: Fixture[] = [];
async function seed(): Promise<Fixture> {
  const f = { user: randomUUID(), server: randomUUID(), other: randomUUID(), channel: randomUUID(),
    voice: randomUUID(), message: randomUUID(), thread: randomUUID(), key: `uploads/voice-barrier-${randomUUID()}.webm` };
  fixtures.push(f);
  await q('INSERT INTO users (_id,username,"displayName",password,"createdAt") VALUES ($1,$1,$1,$1,1)', [f.user]);
  await q('INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,$1,$3,1),($2,$2,$3,1)', [f.server, f.other, f.user]);
  await q('INSERT INTO channels (_id,"serverId",name,"createdAt") VALUES ($1,$2,$1,1)', [f.channel, f.server]);
  return f;
}
const insert = (f: Fixture, run = q, server = f.server) => run(
  `INSERT INTO voice_messages (_id,"channelId","serverId","userId","displayName",url,transcript,"createdAt")
   VALUES ($1,$2,$3,$4,'Stored author',$5,'existing transcript',1)`,
  [f.voice, f.channel, server, f.user, `/${f.key}`]);
const expire = (f: Fixture) => q(`UPDATE channels SET "expiresAt"=FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT-1000,
  "expiryVersion"=1 WHERE _id=$1`, [f.channel]);
const capture = (promise: Promise<unknown>): Promise<{ error?: unknown }> => promise.then(() => ({}), error => ({ error }));
async function waitForLock(name: string) {
  for (let i = 0; i < 150; i++) {
    const rows = await q(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
      AND application_name=$1 AND wait_event_type='Lock') AS waiting`, [name]);
    if (rows.rows[0].waiting) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Voice writer did not reach the controlled PostgreSQL lock wait');
}
async function writerFor(f: Fixture): Promise<PoolClient> {
  const writer = await db._pool.connect();
  await writer.query('BEGIN');
  await writer.query("SELECT set_config('application_name',$1,TRUE)", [f.voice]);
  return writer;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await q('DELETE FROM messages WHERE _id=$1', [f.message]);
    await q('DELETE FROM threads WHERE _id=$1', [f.thread]);
    await q('DELETE FROM voice_messages WHERE _id=$1', [f.voice]);
    await q('DELETE FROM channel_expiry_tombstones WHERE "channelId"=$1', [f.channel]);
    await q('DELETE FROM channels WHERE _id=$1', [f.channel]);
    await q('DELETE FROM servers WHERE _id IN ($1,$2)', [f.server, f.other]);
    await q('DELETE FROM users WHERE _id=$1', [f.user]);
    await q('DELETE FROM upload_release_keys WHERE key=$1', [f.key]);
  }
});
afterAll(async () => { await db._pool.end(); });

it.each(['expired', 'tombstoned', 'invalid-expiry', 'wrong-tenant'])('refuses a raw voice insert for %s authority', async state => {
  const f = await seed();
  if (state === 'expired') await expire(f);
  if (state === 'tombstoned') await q('INSERT INTO channel_expiry_tombstones ("channelId","serverId","expiredAt","expiryVersion","recordedAt") VALUES ($1,$2,1,1,2)', [f.channel, f.server]);
  if (state === 'invalid-expiry') await q('UPDATE channels SET "expiresAt"=FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT+120000,"expiryVersion"=0 WHERE _id=$1', [f.channel]);
  await expect(insert(f, q, state === 'wrong-tenant' ? f.other : f.server)).rejects.toMatchObject({ code: 'BX001', message: 'channel_unavailable' });
  expect((await q('SELECT _id FROM voice_messages WHERE _id=$1', [f.voice])).rows).toHaveLength(0);
});

it('preserves a permanent voice row and refuses a transcript rewrite once it expires', async () => {
  const f = await seed(); await insert(f); await expire(f);
  await expect(q('UPDATE voice_messages SET transcript=$1 WHERE _id=$2', ['late replacement', f.voice])).rejects.toMatchObject({ code: 'BX001', detail: 'expired' });
  expect((await q('SELECT transcript FROM voice_messages WHERE _id=$1', [f.voice])).rows).toEqual([{ transcript: 'existing transcript' }]);
});

it('rereads the database clock after waiting on the channel lock', async () => {
  const f = await seed(); const blocker = await db._pool.connect(); const writer = await writerFor(f);
  let pending: Promise<{ error?: unknown }> | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT _id FROM channels WHERE _id=$1 FOR UPDATE', [f.channel]);
    pending = capture(insert(f, (sql, values) => writer.query(sql, values)));
    await waitForLock(f.voice);
    await blocker.query('UPDATE channels SET "expiresAt"=1,"expiryVersion"=1 WHERE _id=$1', [f.channel]);
    await blocker.query('COMMIT');
    expect((await pending).error).toMatchObject({ code: 'BX001', detail: 'expired' });
  } finally {
    await blocker.query('ROLLBACK'); blocker.release();
    await pending; await writer.query('ROLLBACK'); writer.release();
  }
});

it('the final statement check refuses expiry during a later upload-reference lock wait', async () => {
  const f = await seed(); const blocker = await db._pool.connect(); const writer = await writerFor(f);
  let pending: Promise<{ error?: unknown }> | undefined;
  try {
    await q('INSERT INTO upload_release_keys (key,reserved) VALUES ($1,FALSE)', [f.key]);
    await blocker.query('BEGIN');
    await blocker.query('SELECT key FROM upload_release_keys WHERE key=$1 FOR UPDATE', [f.key]);
    pending = capture(insert(f, (sql, values) => writer.query(sql, values)));
    await waitForLock(f.voice); await expire(f);
    await blocker.query('COMMIT');
    expect((await pending).error).toMatchObject({ code: 'BX001', detail: 'expired' });
  } finally {
    await blocker.query('ROLLBACK'); blocker.release();
    await pending; await writer.query('ROLLBACK'); writer.release();
  }
});

it('a stale repeatable-read snapshot cannot authorize a new voice row', async () => {
  const f = await seed(); const writer = await db._pool.connect();
  try {
    await writer.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await writer.query('SELECT "expiresAt" FROM channels WHERE _id=$1', [f.channel]);
    await expire(f);
    await expect(insert(f, (sql, values) => writer.query(sql, values))).rejects.toMatchObject({ code: '40001' });
  } finally { await writer.query('ROLLBACK'); writer.release(); }
});

type AuthorTable = 'voice_messages' | 'messages' | 'threads';
async function authored(table: AuthorTable, f: Fixture) {
  if (table === 'voice_messages') await insert(f);
  else if (table === 'messages') await q(`INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,"createdAt")
    VALUES ($1,$2,$3,$4,'Stored author','Stored author','unchanged content',1)`, [f.message, f.channel, f.server, f.user]);
  else await q(`INSERT INTO threads (_id,"channelId","serverId","createdBy",name,"createdAt","lastMessageAt")
    VALUES ($1,$2,$3,$4,'unchanged title',1,1)`, [f.thread, f.channel, f.server, f.user]);
}
function anonymize(table: AuthorTable, f: Fixture, poison = false) {
  if (table === 'voice_messages') return q(`UPDATE voice_messages SET "userId"=$1,"displayName"=''${poison ? ",transcript='new content'" : ''} WHERE _id=$2`, [TOMBSTONE_USER_ID, f.voice]);
  if (table === 'messages') return q(`UPDATE messages SET "userId"=$1,username='',"displayName"='',"avatarColor"='#2d9cdb',"avatarUrl"=NULL${poison ? ",content='new content'" : ''} WHERE _id=$2`, [TOMBSTONE_USER_ID, f.message]);
  return q(`UPDATE threads SET "createdBy"=$1${poison ? ",name='new title'" : ''} WHERE _id=$2`, [TOMBSTONE_USER_ID, f.thread]);
}
it.each<AuthorTable>(['voice_messages', 'messages', 'threads'])('preserves exact account anonymization on expired %s', async table => {
  const f = await seed(); await authored(table, f); await expire(f);
  await expect(anonymize(table, f)).resolves.toMatchObject({ rowCount: 1 });
  const column = table === 'threads' ? 'createdBy' : 'userId';
  expect((await q(`SELECT "${column}" AS author FROM ${table} WHERE "channelId"=$1`, [f.channel])).rows).toEqual([{ author: TOMBSTONE_USER_ID }]);
});
it.each<AuthorTable>(['voice_messages', 'messages', 'threads'])('anonymization cannot smuggle new content into expired %s', async table => {
  const f = await seed(); await authored(table, f); await expire(f);
  await expect(anonymize(table, f, true)).rejects.toMatchObject({ code: 'BX001', detail: 'expired' });
});
it('an expired voice row cannot be reassigned to another author or incompletely anonymized', async () => {
  const f = await seed(); await insert(f); await expire(f);
  for (const author of [randomUUID(), TOMBSTONE_USER_ID])
    await expect(q('UPDATE voice_messages SET "userId"=$1 WHERE _id=$2', [author, f.voice])).rejects.toMatchObject({ code: 'BX001', detail: 'expired' });
});
