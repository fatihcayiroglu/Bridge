/** Real PostgreSQL snapshots held in transit until the database expiry clock passes. */
import { liveChannelIdsForRead, channelLiveWindowForRead, channelLiveForMessageRead, type ChannelReadQuery } from '../../lib/channelReadExpiryGuard';
const db = require('../../db/loader').default;
if (!process.env.PG_TEST_URL) throw new Error('channel-read-deadline requires a real PG_TEST_URL');

const stem = 'pgt-read-deadline-' + process.pid + '-' + Date.now();
const server = stem + '-server';
const user = stem + '-user';
const q = (sql: string, params: unknown[] = []) => db._pool.query(sql, params);
const clock = 'FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT';

describe('D2 read deadline — real PostgreSQL', () => {
  beforeAll(async () => {
    await q('INSERT INTO users (_id,username,"displayName",password,"createdAt") VALUES ($1,$1,$1,\'x\',1)', [user]);
    await q('INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,$1,$2,1)', [server, user]);
  });
  afterAll(async () => {
    await q('DELETE FROM channels WHERE "serverId"=$1', [server]);
    await q('DELETE FROM servers WHERE _id=$1', [server]);
    await q('DELETE FROM users WHERE _id=$1', [user]);
  });
  const insert = async (id: string, lifetime: number | null) => q(
    `INSERT INTO channels (_id,"serverId",name,"createdAt","expiresAt","expiryVersion")
     VALUES ($1,$2,$1,1,CASE WHEN $3::bigint IS NULL THEN NULL ELSE ${clock}+$3 END,
             CASE WHEN $3::bigint IS NULL THEN 0 ELSE 1 END)`, [id, server, lifetime]);
  const awaitExpiry = async (id: string) => {
    // The database chooses the wait from its persisted timestamp, not an
    // assumed host clock. Then independently assert the DB is past expiry.
    await q(`SELECT pg_sleep(GREATEST(0, ("expiresAt" - ${clock})::double precision / 1000) + 0.05)
               FROM channels WHERE _id=$1`, [id]);
    expect((await q(`SELECT "expiresAt" <= ${clock} AS expired FROM channels WHERE _id=$1`, [id])).rows[0].expired).toBe(true);
  };

  it('omits a live-at-SELECT row whose response is held until expiry, preserving permanent/future controls', async () => {
    const short = stem + '-short', permanent = stem + '-permanent', future = stem + '-future';
    await insert(permanent, null); await insert(future, 60_000); await insert(short, 800);
    let snapshots = 0;
    const delayed: ChannelReadQuery = { query: async (sql, params) => {
      const result = await q(sql, params);
      const captured = result.rows.find((r: { _id: string }) => r._id === short);
      expect(Number(captured.expiresAt)).toBeGreaterThan(Number(captured.nowMs));
      snapshots++;
      await awaitExpiry(short); // real result, delayed transport; no mocked PG row
      return result;
    } };
    const live = await liveChannelIdsForRead(delayed, [short, permanent, future].map(channelId => ({ channelId, serverId: server })));
    expect(snapshots).toBe(1);
    expect([...live].sort()).toEqual([permanent, future].sort());
  });

  it('omits an earlier chunk that expires while the second real query waits', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => stem + '-chunk-' + i);
    await q(`INSERT INTO channels (_id,"serverId",name,"createdAt")
             SELECT unnest($1::text[]),$2,'deadline',1`, [ids, server]);
    await q(`UPDATE channels SET "expiresAt"=${clock}+800,"expiryVersion"=1 WHERE _id=$1`, [ids[0]]);
    let calls = 0;
    const sizes: number[] = [];
    const delayed: ChannelReadQuery = { query: async (sql, params) => {
      sizes.push((params[0] as string[]).length);
      if (++calls === 2) await awaitExpiry(ids[0]);
      return q(sql, params);
    } };
    const live = await liveChannelIdsForRead(delayed, ids.map(channelId => ({ channelId, serverId: server })));
    expect(sizes).toEqual([500, 1]); expect(live.has(ids[0])).toBe(false);
    expect([...live].sort()).toEqual(ids.slice(1).sort());
  });

  it('denies single-message and media-window reads when the real response arrives after expiry', async () => {
    for (const [index, read] of [channelLiveWindowForRead, channelLiveForMessageRead].entries()) {
      const cid = stem + '-single-' + index;
      await insert(cid, 800);
      const delayed: ChannelReadQuery = { query: async (sql, params) => {
        const result = await q(sql, params);
        expect(Number(result.rows[0].expiresAt)).toBeGreaterThan(Number(result.rows[0].nowMs));
        await awaitExpiry(cid);
        return result;
      } };
      const value = await read(delayed, cid, server);
      expect(value).toEqual(index === 0 ? { live: false, remainingMs: 0 } : false);
    }
    const permanent = stem + '-single-permanent', active = stem + '-single-active';
    await insert(permanent, null); await insert(active, 60_000);
    expect(await channelLiveWindowForRead(db._pool, permanent, server)).toEqual({ live: true, remainingMs: null });
    expect(await channelLiveForMessageRead(db._pool, active, server)).toBe(true);
  });
});
