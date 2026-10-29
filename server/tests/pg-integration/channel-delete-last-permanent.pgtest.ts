/**
 * P7 D2: deleting a server's last permanent channel is refused while expiring
 * channels remain.
 *
 * The expiry worker claims an expired channel only while another live channel
 * survives in its server (CLAIM_EXPIRED_CHANNEL_SQL). The expiry API therefore
 * keeps one permanent channel per server (409 LAST_PERMANENT_CHANNEL), but
 * channel DELETION did not apply that rule (documented as a known gap in
 * P7_D2_CHANNEL_EXPIRY_API.md). A server left with only expiring channels
 * keeps its last one forever: once it expires the worker never claims it, so
 * its messages are never deleted, only hidden by the read guards.
 */
const mockActor = { id: '' };
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: mockActor.id };
    next();
  },
}));
// 40+ requests per suite: the per-user channel limiter is not what is under test.
jest.mock('../../middleware/rateLimit', () => ({
  limits: new Proxy({}, { get: () => () => (_req: unknown, _res: unknown, next: () => void) => next() }),
}));

import express from 'express';
import request from 'supertest';
import { claimExpiredChannel } from '../../lib/channelExpiryWorker';

const db = require('../../db/loader').default;
const channelsRouter = require('../../routes/servers/channels');

const PG_TEST_URL = process.env.PG_TEST_URL;
const RUN = PG_TEST_URL ? describe : describe.skip;
const P = 'pgt-d2-lpd-' + process.pid + '-' + Date.now();
const OWNER = P + '-owner';
let seq = 0;
const id = (label: string) => `${P}-${label}-${++seq}`;
const HOUR = 60 * 60 * 1000;

RUN('P7 D2: the last permanent channel cannot be deleted while expiring channels remain', () => {
  const q = (sql: string, params: unknown[] = []) => db._pool.query(sql, params);
  const app = express();
  app.use(express.json());
  app.use('/api/servers/:sid/channels', channelsRouter);
  app.set('io', { to: () => ({ emit: () => undefined }) });
  const del = (sid: string, cid: string) => {
    mockActor.id = OWNER;
    return request(app).delete(`/api/servers/${sid}/channels/${cid}`);
  };
  const expire = (sid: string, cid: string, expiresAt: number) => {
    mockActor.id = OWNER;
    return request(app).put(`/api/servers/${sid}/channels/${cid}/expiry`).send({ expiresAt });
  };

  async function server() {
    const sid = id('srv');
    await q('INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,$1,$2,1)', [sid, OWNER]);
    await q('INSERT INTO members ("userId","serverId",roles,"joinedAt") VALUES ($1,$2,$3::jsonb,1)', [OWNER, sid, '[]']);
    return sid;
  }
  async function channel(sid: string) {
    const cid = id('ch');
    await q('INSERT INTO channels (_id,"serverId",name,"createdAt") VALUES ($1,$2,$3,1)', [cid, sid, 'c']);
    return cid;
  }
  const permanentCount = async (sid: string) =>
    Number((await q('SELECT COUNT(*)::int AS n FROM channels WHERE "serverId"=$1 AND "expiresAt" IS NULL', [sid])).rows[0].n);
  const exists = async (cid: string) => (await q('SELECT 1 FROM channels WHERE _id=$1', [cid])).rows.length === 1;

  async function cleanup() {
    await q('DELETE FROM messages WHERE "channelId" LIKE $1', [P + '%']);
    await q('DELETE FROM channel_expiry_tombstones WHERE "channelId" LIKE $1', [P + '%']);
    await q('DELETE FROM channels WHERE _id LIKE $1', [P + '%']);
    await q('DELETE FROM members WHERE "serverId" LIKE $1', [P + '%']);
    await q('DELETE FROM servers WHERE _id LIKE $1', [P + '%']);
    await q('DELETE FROM users WHERE _id = $1', [OWNER]);
  }
  beforeAll(async () => {
    await cleanup();
    await q('INSERT INTO users (_id,username,"displayName",password,"createdAt") VALUES ($1,$1,$1,$2,1)', [OWNER, 'x']);
  });
  afterAll(cleanup);

  it('why the rule exists: the worker never claims a server\'s last live channel', async () => {
    // A server left with two expiring channels and nothing permanent: the
    // state a deleted last-permanent channel used to leave behind.
    const sid = await server();
    const first = await channel(sid);
    const last = await channel(sid);
    // Written while live (the 086 write barrier refuses writes into an expired channel).
    await q('INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,"createdAt") VALUES ($1,$2,$3,$4,$4,$4,$5,1)',
      [id('m'), last, sid, OWNER, 'expired text']);
    const claimFor = async () => {
      const claimed: string[] = [];
      for (let i = 0; i < 20; i++) {
        const out = await claimExpiredChannel(db._pool);
        if (out.state === 'none') break;
        if (out.state === 'claimed' && out.serverId === sid) claimed.push(out.channelId);
      }
      return claimed;
    };
    // The first expires while the other is still live: it is claimed.
    await q('UPDATE channels SET "expiresAt"=$2, "expiryVersion"=1 WHERE _id=$1', [first, Date.now() - HOUR]);
    await q('UPDATE channels SET "expiresAt"=$2, "expiryVersion"=1 WHERE _id=$1', [last, Date.now() + HOUR]);
    expect(await claimFor()).toEqual([first]);
    // Then the last one expires: no live channel survives it, so it is never claimed.
    await q('UPDATE channels SET "expiresAt"=$2 WHERE _id=$1', [last, Date.now() - HOUR]);
    expect(await claimFor()).toEqual([]);
    expect((await q('SELECT 1 FROM channel_expiry_tombstones WHERE "channelId"=$1', [last])).rows).toHaveLength(0);
    // Its expired message is still stored.
    expect((await q('SELECT content FROM messages WHERE "channelId"=$1', [last])).rows).toEqual([{ content: 'expired text' }]);
  });

  it('refuses deleting the only permanent channel while an expiring one remains (409, nothing deleted)', async () => {
    const sid = await server();
    const permanent = await channel(sid);
    const expiring = await channel(sid);
    expect((await expire(sid, expiring, Date.now() + 2 * HOUR)).status).toBe(200);

    const res = await del(sid, permanent);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'A server must keep at least one permanent channel', code: 'LAST_PERMANENT_CHANNEL' });
    expect(await exists(permanent)).toBe(true);
    expect(await permanentCount(sid)).toBe(1);
  });

  it('still deletes a permanent channel when another permanent one remains, and an expiring channel at any time', async () => {
    const sid = await server();
    const p1 = await channel(sid);
    const p2 = await channel(sid);
    const e = await channel(sid);
    expect((await expire(sid, e, Date.now() + 2 * HOUR)).status).toBe(200);
    expect((await del(sid, p1)).status).toBe(200);
    expect((await del(sid, e)).status).toBe(200);
    expect(await exists(p2)).toBe(true);
    // With no expiring channel left, the existing last-channel rule is what applies.
    expect((await del(sid, p2)).status).toBe(400);
  });

  it('concurrent deletes of the two permanent channels: exactly one wins (10 rounds)', async () => {
    for (let round = 0; round < 10; round++) {
      const sid = await server();
      const p1 = await channel(sid);
      const p2 = await channel(sid);
      const e = await channel(sid);
      expect((await expire(sid, e, Date.now() + 2 * HOUR)).status).toBe(200);
      const statuses = (await Promise.all([del(sid, p1), del(sid, p2)])).map(r => r.status).sort();
      expect(statuses).toEqual([200, 409]);
      expect(await permanentCount(sid)).toBe(1);
    }
  });

  it('two concurrent deletes of different channels both succeed: no deadlock (15 rounds)', async () => {
    // Before the server-row lock, each delete held its own channel row and
    // waited on the other's for the sibling lock: 40P01 and a 500 in 14 of 15 rounds.
    for (let round = 0; round < 15; round++) {
      const sid = await server();
      const a = await channel(sid);
      const b = await channel(sid);
      await channel(sid);
      const statuses = (await Promise.all([del(sid, a), del(sid, b)])).map(r => r.status);
      expect(statuses).toEqual([200, 200]);
      expect(await exists(a)).toBe(false);
      expect(await exists(b)).toBe(false);
    }
  });

  it('a delete racing an expiry change never leaves the server without a permanent channel (10 rounds)', async () => {
    for (let round = 0; round < 10; round++) {
      const sid = await server();
      const p1 = await channel(sid);
      const p2 = await channel(sid);
      const [d, x] = await Promise.all([del(sid, p1), expire(sid, p2, Date.now() + 2 * HOUR)]);
      // One of the two must be refused: either order alone would leave only an expiring channel.
      expect([d.status, x.status].sort()).toEqual([200, 409]);
      expect(await permanentCount(sid)).toBe(1);
    }
  });
});
