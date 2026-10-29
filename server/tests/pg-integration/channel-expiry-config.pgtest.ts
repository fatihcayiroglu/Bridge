import '../helpers/realRedisFixture';

/**
 * P7 D2: real PostgreSQL proof of the owner-only channel expiry API.
 */
const mockActor = { id: '' };
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: mockActor.id };
    next();
  },
}));

import express from 'express';
import request from 'supertest';
import type { PoolClient } from 'pg';
import { setChannelExpiry } from '../../lib/channelExpiryConfig';
import { MIN_CHANNEL_LIFETIME_MS, MAX_CHANNEL_LIFETIME_MS } from '../../lib/channelExpiry';

const db = require('../../db/loader').default;
const channelsRouter = require('../../routes/servers/channels');
const { isChannelWriteDenied } = require('../../lib/channelWriteBarrier');
const { runChannelExpiryJobTick, startChannelExpiryJob, stopChannelExpiryJob } = require('../../jobs/channelExpiry');

const PG_TEST_URL = process.env.PG_TEST_URL;
const RUN = PG_TEST_URL ? describe : describe.skip;
const P = 'pgt-d2-cfg-' + process.pid + '-' + Date.now();
const OWNER = P + '-owner';
const MEMBER = P + '-member';
const STRANGER = P + '-stranger';
let seq = 0;
const id = (label: string) => `${P}-${label}-${++seq}`;
const HOUR = 60 * 60 * 1000;

RUN('P7 D2 channel expiry configuration — real PostgreSQL', () => {
  const q = (sql: string, params: unknown[] = []) => db._pool.query(sql, params);
  const app = express();
  app.use(express.json());
  app.use('/api/servers/:sid/channels', channelsRouter);
  const emitted: Array<[string, string, unknown]> = [];
  app.set('io', { to: (room: string) => ({ emit: (event: string, payload: unknown) => emitted.push([room, event, payload]) }) });
  const put = (sid: string, cid: string, body: unknown, actor = OWNER) => {
    mockActor.id = actor;
    return request(app).put(`/api/servers/${sid}/channels/${cid}/expiry`).send(body as object);
  };
  const row = async (cid: string) => {
    const r = (await q('SELECT "expiresAt","expiryVersion" FROM channels WHERE _id=$1', [cid])).rows[0];
    return r && { expiresAt: r.expiresAt === null ? null : Number(r.expiresAt), expiryVersion: Number(r.expiryVersion) };
  };

  async function server() {
    const sid = id('srv');
    await q('INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,$1,$2,1)', [sid, OWNER]);
    for (const user of [OWNER, MEMBER]) {
      await q('INSERT INTO members ("userId","serverId",roles,"joinedAt") VALUES ($1,$2,$3::jsonb,1)', [user, sid, '[]']);
    }
    return sid;
  }
  async function channel(sid: string) {
    const cid = id('ch');
    await q('INSERT INTO channels (_id,"serverId",name,"createdAt") VALUES ($1,$2,$3,1)', [cid, sid, 'c']);
    return cid;
  }
  /** Wait until some other backend is blocked on a lock. */
  async function waitForLockWait() {
    for (let i = 0; i < 100; i++) {
      const r = await q(`SELECT COUNT(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FOR NO KEY UPDATE OF c%'`);
      if (r.rows[0].n > 0) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('expiry change never waited on the lock');
  }

  async function cleanup() {
    await q('DELETE FROM messages WHERE "channelId" LIKE $1', [P + '%']);
    await q('DELETE FROM channel_expiry_tombstones WHERE "channelId" LIKE $1', [P + '%']);
    await q('DELETE FROM channels WHERE _id LIKE $1', [P + '%']);
    await q('DELETE FROM members WHERE "serverId" LIKE $1', [P + '%']);
    await q('DELETE FROM servers WHERE _id LIKE $1', [P + '%']);
    await q('DELETE FROM users WHERE _id = ANY($1::text[])', [[OWNER, MEMBER, STRANGER]]);
  }
  beforeAll(async () => {
    await cleanup();
    for (const user of [OWNER, MEMBER, STRANGER]) {
      await q('INSERT INTO users (_id,username,"displayName",password,"createdAt") VALUES ($1,$1,$1,$2,1)', [user, 'x']);
    }
  });
  afterAll(cleanup);

  it('lets the owner set, change and clear an expiry, bumping the version each time', async () => {
    const sid = await server();
    await channel(sid);
    const cid = await channel(sid);
    const at = Date.now() + 2 * HOUR;
    const set = await put(sid, cid, { expiresAt: at });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ channelId: cid, expiresAt: at, expiryVersion: 1 });
    expect(await row(cid)).toEqual({ expiresAt: at, expiryVersion: 1 });

    const moved = await put(sid, cid, { expiresAt: at + HOUR, expectedVersion: 1 });
    expect(moved.status).toBe(200);
    expect(moved.body.expiryVersion).toBe(2);

    const stale = await put(sid, cid, { expiresAt: at, expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');

    const cleared = await put(sid, cid, { expiresAt: null, expectedVersion: 2 });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toEqual({ channelId: cid, expiresAt: null, expiryVersion: 3 });
    expect(await row(cid)).toEqual({ expiresAt: null, expiryVersion: 3 });
  });

  it('refuses members who are not the owner and hides the channel from outsiders', async () => {
    const sid = await server();
    await channel(sid);
    const cid = await channel(sid);
    const member = await put(sid, cid, { expiresAt: Date.now() + 2 * HOUR }, MEMBER);
    expect(member.status).toBe(403);
    const stranger = await put(sid, cid, { expiresAt: Date.now() + 2 * HOUR }, STRANGER);
    expect(stranger.status).toBe(404);
    const foreign = await put(id('other-srv'), cid, { expiresAt: Date.now() + 2 * HOUR });
    expect(foreign.status).toBe(404);
    expect(await row(cid)).toEqual({ expiresAt: null, expiryVersion: 0 });
  });

  it('enforces the lifetime window and strict input types', async () => {
    const sid = await server();
    await channel(sid);
    const cid = await channel(sid);
    const now = Date.now();
    const cases: Array<[unknown, number]> = [
      [{ expiresAt: now + MIN_CHANNEL_LIFETIME_MS - 60_000 }, 422],
      [{ expiresAt: now + MAX_CHANNEL_LIFETIME_MS + 60_000 }, 422],
      [{ expiresAt: now - 1000 }, 422],
      [{ expiresAt: String(now + 2 * HOUR) }, 400],
      [{ expiresAt: now + 2 * HOUR + 0.5 }, 400],
      [{ expiresAt: 0 }, 400],
      [{ expiresAt: now + 2 * HOUR, expectedVersion: '0' }, 400],
      [{}, 400],
    ];
    for (const [body, status] of cases) {
      const r = await put(sid, cid, body);
      expect([JSON.stringify(body), r.status]).toEqual([JSON.stringify(body), status]);
    }
    expect(await row(cid)).toEqual({ expiresAt: null, expiryVersion: 0 });
  });

  it('keeps one permanent channel per server, even under concurrent requests', async () => {
    const lonely = await server();
    const only = await channel(lonely);
    const r = await put(lonely, only, { expiresAt: Date.now() + 2 * HOUR });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('LAST_PERMANENT_CHANNEL');

    for (let round = 0; round < 5; round++) {
      const sid = await server();
      const a = await channel(sid);
      const b = await channel(sid);
      const at = Date.now() + 2 * HOUR;
      const results = await Promise.all([a, b].map(cid =>
        setChannelExpiry(db._pool, { serverId: sid, channelId: cid, actorId: OWNER, expiresAt: at })));
      expect(results.filter(x => x.ok)).toHaveLength(1);
      expect(results.filter(x => !x.ok && x.reason === 'last_permanent_channel')).toHaveLength(1);
      const permanent = await q('SELECT COUNT(*)::int AS n FROM channels WHERE "serverId"=$1 AND "expiresAt" IS NULL', [sid]);
      expect(permanent.rows[0].n).toBe(1);
    }
  });

  it('never revives an expired channel the worker has not claimed yet', async () => {
    const sid = await server();
    await channel(sid);
    const cid = await channel(sid);
    await q('UPDATE channels SET "expiresAt"=$1,"expiryVersion"=1 WHERE _id=$2', [Date.now() - 1000, cid]);
    for (const body of [{ expiresAt: null }, { expiresAt: Date.now() + 2 * HOUR }]) {
      const r = await put(sid, cid, body);
      expect(r.status).toBe(404);
    }
    expect((await row(cid)).expiryVersion).toBe(1);
  });

  it('answers not found when the expiry worker deletes the channel during the change', async () => {
    const sid = await server();
    await channel(sid);
    const cid = await channel(sid);
    await q('UPDATE channels SET "expiresAt"=$1,"expiryVersion"=1 WHERE _id=$2', [Date.now() + 2 * HOUR, cid]);
    const worker: PoolClient = await db._pool.connect();
    try {
      await worker.query('BEGIN');
      await worker.query('SELECT _id FROM channels WHERE _id=$1 FOR UPDATE', [cid]);
      const change = setChannelExpiry(db._pool, { serverId: sid, channelId: cid, actorId: OWNER, expiresAt: null });
      await waitForLockWait();
      await worker.query(`INSERT INTO channel_expiry_tombstones
        ("channelId","serverId","expiredAt","expiryVersion","recordedAt","cleanupState") VALUES ($1,$2,1,1,2,'pending')`, [cid, sid]);
      await worker.query('DELETE FROM channels WHERE _id=$1', [cid]);
      await worker.query('COMMIT');
      expect(await change).toEqual({ ok: false, reason: 'not_found' });
    } finally {
      await worker.query('ROLLBACK').catch(() => undefined);
      worker.release();
    }
    expect(await row(cid)).toBeUndefined();
  });

  it('does not wait for in-flight writers, and their writes stay valid', async () => {
    const sid = await server();
    await channel(sid);
    const cid = await channel(sid);
    const writer: PoolClient = await db._pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query('INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,"createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [id('m'), cid, sid, OWNER, 'o', 'O', 'in flight', Date.now()]);
      const timeout = new Promise(resolve => setTimeout(() => resolve('blocked'), 3000));
      const change = setChannelExpiry(db._pool, { serverId: sid, channelId: cid, actorId: OWNER, expiresAt: Date.now() + 2 * HOUR });
      const outcome = await Promise.race([change, timeout]);
      expect(outcome).toMatchObject({ ok: true, expiryVersion: 1 });
      await writer.query('COMMIT');
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
    }
    // Still before expiry: new writes are accepted; after expiry they are denied.
    await q('INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,"createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id('m'), cid, sid, OWNER, 'o', 'O', 'later', Date.now()]);
    await q('UPDATE channels SET "expiresAt"=$1 WHERE _id=$2', [Date.now() - 1000, cid]);
    let err: unknown = null;
    await q('INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,"createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id('m'), cid, sid, OWNER, 'o', 'O', 'too late', Date.now()]).catch((e: unknown) => { err = e; });
    expect(isChannelWriteDenied(err)).toBe(true);
  });

  it('hides an expired channel from listings at once, then announces its removal to the server room', async () => {
    const sid = await server();
    const keep = await channel(sid);
    const doomed = await channel(sid);
    mockActor.id = OWNER;
    const ids = (r: { body: Array<{ _id: string }> }) => r.body.map(c => c._id).sort();
    const listed = await request(app).get(`/api/servers/${sid}/channels`);  // also primes the list cache
    expect(ids(listed)).toEqual([keep, doomed].sort());

    // Real path: the API sets the expiry and invalidates the list cache; the
    // re-cached list carries expiresAt, and serving filters by the clock.
    const at = Date.now() + 2 * HOUR;
    expect((await put(sid, doomed, { expiresAt: at })).status).toBe(200);
    expect(ids(await request(app).get(`/api/servers/${sid}/channels`))).toEqual([keep, doomed].sort());
    const realNow = Date.now;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + 2 * HOUR + 1000);
    try {
      const afterExpiry = await request(app).get(`/api/servers/${sid}/channels`);
      expect(afterExpiry.status).toBe(200);
      expect(ids(afterExpiry)).toEqual([keep]);
      expect((await request(app).get(`/api/servers/${sid}/channels/${doomed}`)).status).toBe(404);
      expect((await request(app).patch(`/api/servers/${sid}/channels/${doomed}`).send({ name: 'revived' })).status).toBe(404);
      expect((await request(app).get(`/api/servers/${sid}/channels/${keep}`)).status).toBe(200);
    } finally {
      clock.mockRestore();
    }

    // The database clock decides the claim; move the stored expiry into its past.
    await q('UPDATE channels SET "expiresAt"=$1 WHERE _id=$2', [Date.now() - 1000, doomed]);

    const emitted: Array<[string, string, unknown]> = [];
    startChannelExpiryJob({ to: (room: string) => ({ emit: (event: string, payload: unknown) => emitted.push([room, event, payload]) }) });
    try {
      for (let i = 0; i < 20 && !emitted.some(([room]) => room === `server:${sid}`); i++) await runChannelExpiryJobTick();
    } finally {
      stopChannelExpiryJob();
    }
    expect(emitted.filter(([room]) => room === `server:${sid}`)).toEqual([[`server:${sid}`, 'channel:expired', { serverId: sid }]]);
    expect(await row(doomed)).toBeUndefined();
    expect(ids(await request(app).get(`/api/servers/${sid}/channels`))).toEqual([keep]);
  });

  it('announces every committed channel mutation to the server room with the server id only', async () => {
    const sid = await server();
    const keep = await channel(sid);
    mockActor.id = OWNER;
    const changes = () => emitted.filter(([room, event]) => room === `server:${sid}` && event === 'channels:changed');
    emitted.length = 0;

    const created = await request(app).post(`/api/servers/${sid}/channels`).send({ name: 'live-sync', type: 'text' });
    expect(created.status).toBe(201);
    expect(changes()).toEqual([[`server:${sid}`, 'channels:changed', { serverId: sid }]]);
    const cid = String(created.body._id);

    expect((await request(app).patch(`/api/servers/${sid}/channels/${cid}`).send({ name: 'renamed' })).status).toBe(200);
    expect((await put(sid, cid, { expiresAt: Date.now() + 2 * HOUR })).status).toBe(200);
    expect((await request(app).delete(`/api/servers/${sid}/channels/${cid}`)).status).toBe(200);
    expect(changes()).toHaveLength(4);
    for (const [, , payload] of changes()) expect(payload).toEqual({ serverId: sid });  // no name, id or type

    // Refused or no-op mutations announce nothing.
    emitted.length = 0;
    expect((await request(app).patch(`/api/servers/${sid}/channels/${keep}`).send({ name: 'x' }).then(r => r.status))).toBe(200);
    emitted.length = 0;
    mockActor.id = MEMBER;
    expect((await request(app).patch(`/api/servers/${sid}/channels/${keep}`).send({ name: 'nope' })).status).toBe(403);
    expect((await request(app).post(`/api/servers/${sid}/channels`).send({ name: 'nope', type: 'text' })).status).toBe(403);
    mockActor.id = OWNER;
    expect((await request(app).delete(`/api/servers/${sid}/channels/${keep}`)).status).toBe(400);  // last channel
    expect((await put(sid, keep, { expiresAt: Date.now() + 2 * HOUR })).status).toBe(409);  // last permanent
    expect(changes()).toEqual([]);
  });
});
