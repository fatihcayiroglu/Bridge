/**
 * P7 D2: real PostgreSQL + HTTP evidence that semantic search, digest,
 * engagement, AI channel reads, pins/files and announcement crossposts stop
 * serving a channel once it expires. Content is seeded before expiry.
 */
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: OWNER, username: 'owner' };
    next();
  },
}));

import express from 'express';
import request from 'supertest';
import { readChannelForAi } from '../../lib/aiContext';

const db = require('../../db/loader').default;
const unwrap = (m: { default?: unknown }) => m.default ?? m;
const semanticRouter = unwrap(require('../../routes/semantic'));
const aiRouter = unwrap(require('../../routes/ai'));
const pinsRouter = unwrap(require('../../routes/pins'));
const { router: announcementRouter } = require('../../routes/announcement');

const PG_TEST_URL = process.env.PG_TEST_URL;
const RUN = PG_TEST_URL ? describe : describe.skip;
const STEM = 'pgt-d2-ai-' + process.pid + '-' + Date.now();
const OWNER = STEM + '-owner';
const SERVER = STEM + '-server';
const LIVE = STEM + '-live';
const DOOMED = STEM + '-doomed';
const ANN = STEM + '-ann';
const FOLLOWER = STEM + '-follower';
const CHANNELS = [LIVE, DOOMED, ANN, FOLLOWER];
const TERM = 'zq' + process.pid + 'opal';
const secret = (channel: string) => `${TERM} secret body of ${channel}`;
const mid = (channel: string, kind: string) => `${channel}-${kind}`;

RUN('P7 D2 AI, semantic, pins and crosspost expiry — real PostgreSQL', () => {
  const q = (sql: string, params: unknown[] = []) => db._pool.query(sql, params);
  const app = express();
  app.use(express.json());
  app.use('/api/semantic', semanticRouter);
  app.use('/api/ai', aiRouter);
  app.use('/api/channels', pinsRouter);
  app.use('/api/channels', announcementRouter);

  async function cleanup() {
    await q('DELETE FROM crosspost_log WHERE "sourceChannelId" = ANY($1::text[])', [CHANNELS]).catch(() => undefined);
    await q('DELETE FROM channel_follows WHERE "sourceChannelId" = ANY($1::text[])', [CHANNELS]);
    await q('DELETE FROM messages WHERE "channelId" = ANY($1::text[])', [CHANNELS]);
    await q('DELETE FROM channel_expiry_tombstones WHERE "channelId" = ANY($1::text[])', [CHANNELS]);
    await q('DELETE FROM channels WHERE _id = ANY($1::text[])', [CHANNELS]);
    await q('DELETE FROM members WHERE "serverId"=$1', [SERVER]);
    await q('DELETE FROM servers WHERE _id=$1', [SERVER]);
    await q('DELETE FROM users WHERE _id=$1', [OWNER]);
  }
  async function message(channel: string, kind: string, extra: { pinned?: boolean; type?: string } = {}) {
    await q('INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,"createdAt",pinned,type)' +
      ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [mid(channel, kind), channel, SERVER, OWNER, 'owner', 'Owner', secret(channel), Date.now() - 60_000,
        extra.pinned ?? false, extra.type ?? 'text']);
  }
  const expire = (channel: string) =>
    q('UPDATE channels SET "expiresAt"=$1,"expiryVersion"=GREATEST("expiryVersion",0)+1 WHERE _id=$2' +
      ' AND ("expiresAt" IS NULL OR "expiresAt" > $1)', [Date.now() - 1000, channel]);
  const leaks = (res: { text: string }, channel: string) => res.text.includes(secret(channel));

  beforeAll(async () => {
    await cleanup();
    await q('INSERT INTO users (_id,username,"displayName",password,"createdAt") VALUES ($1,$2,$3,$4,1)',
      [OWNER, 'owner-' + process.pid, 'Owner', 'x']);
    await q('INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,$1,$2,1)', [SERVER, OWNER]);
    await q('INSERT INTO members ("userId","serverId",roles,"joinedAt") VALUES ($1,$2,$3::jsonb,1)', [OWNER, SERVER, '[]']);
    for (const channel of [LIVE, DOOMED, FOLLOWER]) {
      await q('INSERT INTO channels (_id,"serverId",name,type,"createdAt") VALUES ($1,$2,$3,$4,1)', [channel, SERVER, channel, 'text']);
    }
    await q('INSERT INTO channels (_id,"serverId",name,type,"createdAt") VALUES ($1,$2,$3,$4,1)', [ANN, SERVER, ANN, 'announcement']);
    for (const channel of [LIVE, DOOMED]) {
      await message(channel, 'pin', { pinned: true });
      await message(channel, 'file', { type: 'file' });
    }
    await message(ANN, 'post');
    await q('INSERT INTO channel_follows ("sourceChannelId","sourceServerId","targetChannelId","targetServerId","followedByUserId")' +
      ' VALUES ($1,$2,$3,$2,$4)', [ANN, SERVER, FOLLOWER, OWNER]);
  });
  afterAll(cleanup);

  it('semantic search stops matching an expired channel, including a cached answer', async () => {
    const search = () => request(app).post('/api/semantic/search').send({ query: TERM + ' secret', serverId: SERVER });
    const before = await search();
    expect(before.status).toBe(200);
    expect(leaks(before, LIVE) && leaks(before, DOOMED)).toBe(true);
    await expire(DOOMED);
    const after = await search();  // same key: the cached answer is revalidated
    expect(after.status).toBe(200);
    expect(leaks(after, LIVE)).toBe(true);
    expect(leaks(after, DOOMED)).toBe(false);
    const fresh = await request(app).post('/api/semantic/search').send({ query: TERM + ' body', serverId: SERVER });
    expect(fresh.status).toBe(200);
    expect(leaks(fresh, LIVE)).toBe(true);
    expect(leaks(fresh, DOOMED)).toBe(false);
    const scoped = await request(app).post('/api/semantic/search').send({ query: TERM + ' of', serverId: SERVER, channelId: DOOMED });
    expect(scoped.status).toBe(200);
    expect(scoped.body.matches).toEqual([]);
  });

  it('digest and engagement ignore an expired channel', async () => {
    await expire(DOOMED);
    const digest = await request(app).get('/api/semantic/digest/' + SERVER);
    expect(digest.status).toBe(200);
    expect(leaks(digest, DOOMED)).toBe(false);
    expect(JSON.stringify(digest.body)).not.toContain(DOOMED);
    const engagement = await request(app).get('/api/semantic/engagement/' + SERVER);
    expect(engagement.status).toBe(200);
    // Only the live channel's two messages (and the announcement post) count.
    expect(engagement.body.periods[0].messages).toBe(3);
  });

  it('AI channel reads, summaries, suggestions and moderation treat an expired channel as gone', async () => {
    expect(await readChannelForAi(OWNER, LIVE)).toMatchObject({ ok: true });
    await expire(DOOMED);
    expect(await readChannelForAi(OWNER, DOOMED)).toMatchObject({ ok: false, status: 404 });
    const live = await request(app).get('/api/ai/summarize/' + LIVE);
    expect(live.status).toBe(200);
    for (const res of [
      await request(app).get('/api/ai/summarize/' + DOOMED),
      await request(app).get('/api/ai/suggest-reply/' + DOOMED),
      await request(app).post('/api/ai/moderate').send({ messageId: mid(DOOMED, 'pin') }),
    ]) {
      expect(res.status).toBe(404);
      expect(leaks(res, DOOMED)).toBe(false);
    }
    expect((await request(app).post('/api/ai/moderate').send({ messageId: mid(LIVE, 'pin') })).status).toBe(200);
  });

  it('pins and files of an expired channel are not served', async () => {
    const pins = await request(app).get(`/api/channels/${LIVE}/pins`);
    expect(pins.status).toBe(200);
    expect(leaks(pins, LIVE)).toBe(true);
    await expire(DOOMED);
    for (const path of ['pins', 'files']) {
      const res = await request(app).get(`/api/channels/${DOOMED}/${path}`);
      expect(res.status).toBe(404);
      expect(leaks(res, DOOMED)).toBe(false);
    }
  });

  it('an expired announcement channel cannot crosspost or gain followers', async () => {
    await expire(ANN);
    const res = await request(app).post(`/api/channels/${ANN}/messages/${mid(ANN, 'post')}/crosspost`).send({});
    expect(res.status).toBe(404);
    const copies = await q('SELECT COUNT(*)::int AS n FROM messages WHERE "channelId"=$1', [FOLLOWER]);
    expect(copies.rows[0].n).toBe(0);
    const follow = await request(app).post(`/api/channels/${ANN}/follow`).send({ targetChannelId: LIVE });
    expect(follow.status).toBe(404);
    const edges = await q('SELECT COUNT(*)::int AS n FROM channel_follows WHERE "sourceChannelId"=$1 AND "targetChannelId"=$2', [ANN, LIVE]);
    expect(edges.rows[0].n).toBe(0);
  });

  it('a tombstoned id is gone even if a channel row with that id reappears', async () => {
    await q(`INSERT INTO channel_expiry_tombstones ("channelId","serverId","expiredAt","expiryVersion","recordedAt","cleanupState")
      VALUES ($1,$2,1,1,2,'pending') ON CONFLICT DO NOTHING`, [FOLLOWER, SERVER]);
    expect(await readChannelForAi(OWNER, FOLLOWER)).toMatchObject({ ok: false, status: 404 });
    expect((await request(app).get(`/api/channels/${FOLLOWER}/pins`)).status).toBe(404);
  });
});
