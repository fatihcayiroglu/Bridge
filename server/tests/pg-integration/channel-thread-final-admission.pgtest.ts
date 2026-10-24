import type { PoolClient } from 'pg';
import fs from 'fs';
import path from 'path';

const db = require('../../db/loader').default;
if (!process.env.PG_TEST_URL) throw new Error('PG_TEST_URL is required for thread final-admission tests');

const P = 'pgt-d2-thread-final-' + process.pid + '-' + Date.now();
const SERVER = P + '-server';
const USER = P + '-owner';
let seq = 0;
const id = (label: string) => `${P}-${label}-${++seq}`;
const q = (sql: string, params: unknown[] = []) => db._pool.query(sql, params);
const up = fs.readFileSync(path.resolve(__dirname, '../../db/migrations_pg/095_channel_thread_final_admission.sql'), 'utf8');
const down = fs.readFileSync(path.resolve(__dirname, '../../db/migrations_pg/rollback/095_channel_thread_final_admission.down.sql'), 'utf8');
const CATALOG = `SELECT tgrelid::regclass::text AS tbl, pg_get_triggerdef(oid) AS definition,
  tgconstraint <> 0 AS is_constraint, tgdeferrable, tginitdeferred, tgenabled, tgtype
  FROM pg_trigger WHERE tgname='zz_channel_final_admission'
  AND tgrelid IN ('threads'::regclass, 'thread_messages'::regclass) ORDER BY tbl`;

async function waitForBlock(writerPid: number, blockerPid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = (await q('SELECT $2::int = ANY(pg_blocking_pids($1)) AS blocked', [writerPid, blockerPid])).rows[0];
    if (state?.blocked === true) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('thread writer did not wait on the competing unique-key transaction');
}

const cases = (['threads', 'thread_messages'] as const).flatMap(table =>
  (['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'] as const).flatMap(isolation =>
    [false, true].map(expire => ({ table, isolation, expire }))));

describe('D2 thread final admission after PostgreSQL waits', () => {
  beforeAll(async () => {
    await q('INSERT INTO users (_id,username,"displayName",password,"createdAt") VALUES ($1,$1,$1,$1,1)', [USER]);
    await q('INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,$1,$2,1)', [SERVER, USER]);
  });
  afterAll(async () => {
    await q('DELETE FROM thread_messages WHERE "serverId"=$1', [SERVER]);
    await q('DELETE FROM threads WHERE "serverId"=$1', [SERVER]);
    await q('DELETE FROM channels WHERE "serverId"=$1', [SERVER]);
    await q('DELETE FROM servers WHERE _id=$1', [SERVER]);
    await q('DELETE FROM users WHERE _id=$1', [USER]);
  });

  it.each(cases)('$table rechecks after a unique-key wait ($isolation, expire: $expire)', async ({ table, isolation, expire }) => {
    const cid = id('channel');
    const rowId = id('row');
    const parent = id('parent');
    await q(`INSERT INTO channels (_id,"serverId",name,"createdAt","expiresAt","expiryVersion")
      VALUES ($1,$2,$1,1,FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT+600000,1)`, [cid, SERVER]);
    const threadSql = `INSERT INTO threads (_id,"channelId","serverId",name,"createdBy","createdAt","lastMessageAt")
      VALUES ($1,$2,$3,'thread final admission',$4,1,1)`;
    if (table === 'thread_messages') await q(threadSql, [parent, cid, SERVER, USER]);
    const sql = table === 'threads' ? threadSql : `INSERT INTO thread_messages
      (_id,"channelId","serverId","userId","threadId",username,"displayName",content,"createdAt")
      VALUES ($1,$2,$3,$4,$5,'fixture','Fixture','reply final admission',1)`;
    const params = table === 'threads' ? [rowId, cid, SERVER, USER] : [rowId, cid, SERVER, USER, parent];
    const blocker: PoolClient = await db._pool.connect();
    const writer: PoolClient = await db._pool.connect();
    let pending: Promise<{ code: string | null }> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query(sql, params);
      const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      await writer.query('BEGIN ISOLATION LEVEL ' + isolation);
      await writer.query('SET CONSTRAINTS ALL DEFERRED');
      await writer.query("SET LOCAL statement_timeout = '8s'");
      pending = writer.query(sql, params).then(() => ({ code: null }), (error: { code: string }) => ({ code: error.code }));
      await waitForBlock(writerPid, blockerPid);

      // KEY SHARE admission is deliberately compatible with expiry metadata
      // changes. The statement must recheck after the unique-index wait.
      if (expire) {
        await q(`UPDATE channels SET "expiresAt"=FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT-1000,
          "expiryVersion"=2 WHERE _id=$1`, [cid]);
      }
      await blocker.query('ROLLBACK');
      const outcome = await pending;
      if (outcome.code === null) await writer.query('COMMIT');
      else await writer.query('ROLLBACK');
      expect(outcome.code).toBe(expire ? (isolation === 'READ COMMITTED' ? 'BX001' : '40001') : null);
      expect((await q(`SELECT _id FROM ${table} WHERE _id=$1`, [rowId])).rows)
        .toEqual(expire ? [] : [{ _id: rowId }]);
    } finally {
      await blocker.query('ROLLBACK');
      if (pending) await pending;
      await writer.query('ROLLBACK');
      blocker.release();
      writer.release();
    }
  });

  it('reverses and replays only its two ordinary triggers while preserving content and the message guard', async () => {
    const client: PoolClient = await db._pool.connect();
    const cid = id('recovery-channel');
    const threadId = id('recovery-thread');
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO channels (_id,"serverId",name,"createdAt") VALUES ($1,$2,$1,1)', [cid, SERVER]);
      await client.query(`INSERT INTO threads (_id,"channelId","serverId",name,"createdBy","createdAt","lastMessageAt")
        VALUES ($1,$2,$3,'preserved thread',$4,1,1)`, [threadId, cid, SERVER, USER]);
      await client.query(`INSERT INTO thread_messages (_id,"threadId","channelId","serverId","userId",username,"displayName",content,"createdAt")
        VALUES ($1,$2,$3,$4,$5,'fixture','Fixture','preserved reply',1)`, [id('recovery-reply'), threadId, cid, SERVER, USER]);
      const before = (await client.query(CATALOG)).rows;
      expect(before).toEqual([
        expect.objectContaining({ tbl: 'thread_messages', is_constraint: false, tgdeferrable: false, tginitdeferred: false, tgenabled: 'O', tgtype: 21 }),
        expect.objectContaining({ tbl: 'threads', is_constraint: false, tgdeferrable: false, tginitdeferred: false, tgenabled: 'O', tgtype: 21 }),
      ]);
      const rows = async () => (await client.query(`SELECT 'threads' AS tbl, to_jsonb(t) AS row FROM threads t WHERE "channelId"=$1
        UNION ALL SELECT 'thread_messages', to_jsonb(m) FROM thread_messages m WHERE "channelId"=$1 ORDER BY tbl`, [cid])).rows;
      const original = await rows();
      expect(original).toHaveLength(2);
      const messageGuard = `SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger
        WHERE tgname='zz_channel_final_admission' AND tgrelid='messages'::regclass`;
      const messageBefore = (await client.query(messageGuard)).rows;
      expect(messageBefore).toHaveLength(1);
      await client.query(down);
      expect((await client.query(CATALOG)).rows).toEqual([]);
      expect((await client.query(messageGuard)).rows).toEqual(messageBefore);
      expect(await rows()).toEqual(original);
      for (let replay = 0; replay < 2; replay++) {
        await client.query(up);
        expect((await client.query(CATALOG)).rows).toEqual(before);
        expect((await client.query(messageGuard)).rows).toEqual(messageBefore);
        expect(await rows()).toEqual(original);
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
