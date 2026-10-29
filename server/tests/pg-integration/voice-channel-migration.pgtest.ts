/** Schema-only recovery on real PostgreSQL; every DDL cycle is rolled back. */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
if (!process.env.PG_TEST_URL) throw new Error('Voice migration proof requires PG_TEST_URL');
const db = require('../../db/loader').default as typeof import('../../db/postgres').default;
const read = (file: string) => fs.readFileSync(path.resolve(__dirname, '../../db/migrations_pg', file), 'utf8');
const up = read('096_voice_channel_write_barrier.sql');
const down = read('rollback/096_voice_channel_write_barrier.down.sql');
const original = read('086_channel_write_barrier.sql');
const erasureStart = original.indexOf('CREATE OR REPLACE FUNCTION bridge_channel_update_is_erasure');
const originalErasure = original.slice(erasureStart, original.indexOf('$erasure$;', erasureStart) + '$erasure$;'.length);
const functions = `SELECT p.proname,pg_get_functiondef(p.oid) AS definition,p.provolatile,p.prosecdef,p.proacl
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('bridge_channel_update_is_erasure','bridge_channel_write_barrier',
    'bridge_channel_copy_source_barrier') ORDER BY p.proname`;
const triggers = `SELECT t.tgname,pg_get_triggerdef(t.oid) AS definition,t.tgtype,t.tgenabled,t.tgdeferrable,t.tginitdeferred
  FROM pg_trigger t WHERE t.tgrelid='voice_messages'::regclass
    AND t.tgname IN ('channel_write_barrier','zz_channel_final_admission') ORDER BY t.tgname`;
afterAll(async () => { await db._pool.end(); });

it('replays and reverses 096 without changing voice data, retained evidence, tombstones or pending object releases', async () => {
  const client = await db._pool.connect();
  const id = randomUUID(); const url = `/uploads/voice-migration-${id}.webm`;
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO users (_id,username,"displayName",password,"createdAt") VALUES ($1,$1,$1,$1,1)', [id]);
    await client.query('INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,$1,$1,1)', [id]);
    await client.query('INSERT INTO channels (_id,"serverId",name,"createdAt") VALUES ($1,$1,$1,1)', [id]);
    await client.query(`INSERT INTO voice_messages (_id,"channelId","serverId","userId","displayName",url,transcript,"createdAt")
      VALUES ($1,$1,$1,$1,'Snapshot',$2,'Existing transcript',1)`, [id, url]);
    await client.query(`INSERT INTO message_reports (_id,"serverId","channelId","messageId","reporterId",reason,detail,"createdAt",
      "evidenceCapturedAt","evidenceText","channelVisibility") VALUES ($1,$1,$1,$1,$1,'other','Bounded fixture',1,1,'Retained fixture','restricted')`, [id]);
    await client.query('UPDATE channels SET "expiresAt"=1,"expiryVersion"=1 WHERE _id=$1', [id]);
    await client.query('INSERT INTO channel_expiry_tombstones ("channelId","serverId","expiredAt","expiryVersion","recordedAt") VALUES ($1,$1,1,1,2)', [id]);
    await client.query('INSERT INTO channel_object_release_outbox ("channelId",url,"enqueuedAt","nextAttemptAt") VALUES ($1,$2,1,1)', [id, url]);
    const rows = async () => {
      const result: Record<string, unknown[]> = {};
      for (const [table, field] of [['voice_messages', '_id'], ['message_reports', '_id'],
        ['channel_expiry_tombstones', 'channelId'], ['channel_object_release_outbox', 'channelId'], ['upload_release_keys', 'key']]) {
        result[table] = (await client.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE "${field}"=$1`,
          [table === 'upload_release_keys' ? url.slice(1) : id])).rows;
        expect(result[table]).toHaveLength(1);
      }
      return result;
    };
    const dataBefore = await rows();
    const functionBefore = (await client.query(functions)).rows;
    const triggerBefore = (await client.query(triggers)).rows;
    expect(functionBefore).toHaveLength(3);
    expect(triggerBefore).toEqual([
      expect.objectContaining({ tgname: 'channel_write_barrier', tgtype: 23, tgenabled: 'O', tgdeferrable: false, tginitdeferred: false }),
      expect.objectContaining({ tgname: 'zz_channel_final_admission', tgtype: 21, tgenabled: 'O', tgdeferrable: false, tginitdeferred: false }),
    ]);
    await client.query(down);
    expect((await client.query(triggers)).rows).toEqual([]);
    const afterDown = (await client.query(functions)).rows;
    // Compare the restored function to executing the exact previous definition.
    await client.query(originalErasure);
    expect((await client.query(functions)).rows).toEqual(afterDown);
    expect(await rows()).toEqual(dataBefore);
    for (let replay = 0; replay < 2; replay++) {
      await client.query(up);
      expect((await client.query(functions)).rows).toEqual(functionBefore);
      expect((await client.query(triggers)).rows).toEqual(triggerBefore);
      expect(await rows()).toEqual(dataBefore);
    }
    await client.query('SAVEPOINT admission');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    await expect(client.query('UPDATE voice_messages SET transcript=$1 WHERE _id=$2', ['Forbidden replacement', id]))
      .rejects.toMatchObject({ code: 'BX001', detail: 'tombstoned' });
    await client.query('ROLLBACK TO SAVEPOINT admission');
    expect(await rows()).toEqual(dataBefore);
  } finally { await client.query('ROLLBACK'); client.release(); }
});
