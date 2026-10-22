/**
 * P7 D2: real PostgreSQL + HTTP evidence for search, saved and inbox.
 *
 * Expiry is seeded through SQL because no public API creates ephemeral
 * channels yet. Every case asserts both the HTTP answer and that the private
 * message body never appears in the response.
 */
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: OWNER, username: 'owner' };
    next();
  },
}));

import express from 'express';
import request from 'supertest';
import { liveChannelIdsForRead } from '../../lib/channelReadExpiryGuard';

const db = require('../../db/loader').default;
const searchRouter = require('../../routes/search');
const savedRouter = require('../../routes/saved').default;
const inboxRouter = require('../../routes/inbox').default;
const PG_TEST_URL = process.env.PG_TEST_URL;
const RUN = PG_TEST_URL ? describe : describe.skip;
const STEM = 'pgt-d2-ssi-' + process.pid + '-' + Date.now();
const OWNER = STEM + '-owner';
const SERVER = STEM + '-server';
const OTHER_SERVER = STEM + '-other';
const LIVE = STEM + '-live';
const DOOMED = STEM + '-doomed';
const TOMB = STEM + '-tomb';
const FOREIGN = STEM + '-foreign';
const TERM = 'zq' + process.pid + 'quartz';
const msgId = (channel: string, n = 0) => channel + '-m' + n;
const body = (channel: string) => TERM + ' secret body of ' + channel;

RUN('P7 D2 search, saved and inbox expiry — real PostgreSQL', () => {
  const q = (sql: string, params: unknown[] = []) => db._pool.query(sql, params);
  const app = express();
  app.use(express.json());
  app.use('/api/search', searchRouter);
  app.use('/api/saved', savedRouter);
  app.use('/api/inbox', inboxRouter);

  async function cleanup() {
    const channels = [LIVE, DOOMED, TOMB, FOREIGN];
    await q('DELETE FROM notifications WHERE "userId"=$1', [OWNER]);
    await q('DELETE FROM saved_messages WHERE "userId"=$1', [OWNER]);
    await q('DELETE FROM channel_expiry_tombstones WHERE "channelId" = ANY($1::text[])', [channels]);
    await q('DELETE FROM messages WHERE "channelId" = ANY($1::text[])', [channels]);
    await q('DELETE FROM channels WHERE _id = ANY($1::text[])', [channels]);
    await q('DELETE FROM members WHERE "serverId" = ANY($1::text[])', [[SERVER, OTHER_SERVER]]);
    await q('DELETE FROM servers WHERE _id = ANY($1::text[])', [[SERVER, OTHER_SERVER]]);
    await q('DELETE FROM users WHERE _id=$1', [OWNER]);
  }

  async function message(channel: string, serverId: string, n: number, createdAt: number) {
    await q('INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,"createdAt")' +
      ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [msgId(channel, n), channel, serverId, OWNER, 'owner', 'Owner', body(channel), createdAt]);
  }

  async function mention(channel: string, serverId: string, n: number, createdAt: number) {
    await q('INSERT INTO notifications (_id,"userId",type,"serverId","channelId","messageId","actorId",read,"createdAt")' +
      ' VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE,$8)',
      [STEM + '-n-' + channel + '-' + n, OWNER, 'mention', serverId, channel, msgId(channel, n), OWNER, createdAt]);
  }

  // Idempotent: each case that needs DOOMED expired sets it, so cases do
  // not depend on running order.
  const expire = (channel: string) =>
    q('UPDATE channels SET "expiresAt"=$1,"expiryVersion"=GREATEST("expiryVersion",0)+1' +
      ' WHERE _id=$2 AND ("expiresAt" IS NULL OR "expiresAt" > $1)', [Date.now() - 1000, channel]);

  beforeAll(async () => {
    await cleanup();
    await q('INSERT INTO users (_id,username,"displayName",password,"createdAt") VALUES ($1,$2,$3,$4,1)',
      [OWNER, 'owner-' + process.pid, 'Owner', 'irrelevant']);
    for (const serverId of [SERVER, OTHER_SERVER]) {
      await q('INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,$2,$3,1)', [serverId, serverId, OWNER]);
      await q('INSERT INTO members ("userId","serverId",roles,"joinedAt") VALUES ($1,$2,$3::jsonb,1)', [OWNER, serverId, '[]']);
    }
    for (const channel of [LIVE, DOOMED, TOMB]) {
      await q('INSERT INTO channels (_id,"serverId",name,"createdAt") VALUES ($1,$2,$3,1)', [channel, SERVER, channel]);
    }
    await q('INSERT INTO channels (_id,"serverId",name,"createdAt") VALUES ($1,$2,$3,1)', [FOREIGN, OTHER_SERVER, FOREIGN]);
    const t = Date.now() - 600_000;
    await message(LIVE, SERVER, 0, t);
    await message(TOMB, SERVER, 0, t);
    // A message row that claims SERVER while its channel belongs to OTHER_SERVER.
    await message(FOREIGN, SERVER, 0, t);
    // 130 doomed messages, all newer than the live one: enough to fill the
    // 100-row inbox window ahead of the single live mention.
    for (let n = 0; n < 130; n++) await message(DOOMED, SERVER, n, t + 1000 + n);
    await q('INSERT INTO channel_expiry_tombstones' +
      ' ("channelId","serverId","expiredAt","expiryVersion","recordedAt","cleanupState")' +
      ' VALUES ($1,$2,$3,1,$4,$5)', [TOMB, SERVER, t, Date.now(), 'pending']);
  });
  afterAll(cleanup);

  it('the batch check reads live, expired, tombstoned and cross-tenant rows from PostgreSQL', async () => {
    const live = await liveChannelIdsForRead(db._pool, [
      { channelId: LIVE, serverId: SERVER }, { channelId: DOOMED, serverId: SERVER },
      { channelId: TOMB, serverId: SERVER }, { channelId: FOREIGN, serverId: SERVER },
    ]);
    expect([...live].sort()).toEqual([DOOMED, LIVE].sort());
  });

  it('saved: allows a live save, then hides it and refuses new saves and reminders after expiry', async () => {
    const saved = await request(app).post('/api/saved')
      .send({ destinationType: 'channel', destinationId: DOOMED, messageId: msgId(DOOMED, 0) });
    expect(saved.status).toBe(201);
    const before = await request(app).get('/api/saved');
    expect(before.status).toBe(200);
    expect(JSON.stringify(before.body)).toContain(TERM);

    await expire(DOOMED);
    const after = await request(app).get('/api/saved');
    expect(after.status).toBe(200);
    expect(after.body.items).toEqual([expect.objectContaining({ id: saved.body.id, unavailable: true })]);
    expect(JSON.stringify(after.body)).not.toContain(TERM);

    const again = await request(app).post('/api/saved')
      .send({ destinationType: 'channel', destinationId: DOOMED, messageId: msgId(DOOMED, 1) });
    expect(again.status).toBe(404);
    const reminder = await request(app).put('/api/saved/' + saved.body.id + '/reminder')
      .send({ remindAt: Date.now() + 3_600_000 });
    expect(reminder.status).toBe(404);
  });

  it('saved: refuses tombstoned and cross-tenant targets with the same answer as a missing message', async () => {
    for (const channel of [TOMB, FOREIGN]) {
      const reply = await request(app).post('/api/saved')
        .send({ destinationType: 'channel', destinationId: channel, messageId: msgId(channel, 0) });
      expect({ channel, status: reply.status }).toEqual({ channel, status: 404 });
    }
  });

  it('search: only the live channel reaches results on /, /unified and /context', async () => {
    await expire(DOOMED);
    const plain = await request(app).get('/api/search').query({ q: TERM, type: 'messages', limit: 50 });
    expect(plain.status).toBe(200);
    expect(plain.body.messages.map((m: { channelId: string }) => m.channelId)).toEqual([LIVE]);
    expect(JSON.stringify(plain.body)).not.toContain('secret body of ' + DOOMED);
    expect(JSON.stringify(plain.body)).not.toContain('secret body of ' + TOMB);

    const channels = await request(app).get('/api/search').query({ q: STEM, type: 'channels' });
    expect(channels.status).toBe(200);
    // FOREIGN is a genuine live channel of a server the user belongs to, so
    // its NAME is searchable; only expired and tombstoned channels vanish.
    expect(channels.body.channels.map((c: { _id: string }) => c._id).sort()).toEqual([FOREIGN, LIVE].sort());

    const scoped = await request(app).get('/api/search').query({ q: TERM, channelId: DOOMED });
    expect(scoped.status).toBe(200);
    expect(scoped.body.messages).toEqual([]);

    const unified = await request(app).get('/api/search/unified').query({ q: TERM, limit: 50 });
    expect(unified.status).toBe(200);
    expect([...new Set(unified.body.results.map((r: { channelId: string }) => r.channelId))]).toEqual([LIVE]);

    for (const channel of [DOOMED, TOMB]) {
      const ctx = await request(app).get('/api/search/context').query({ id: msgId(channel, 0), source: 'channel' });
      expect({ channel, status: ctx.status }).toEqual({ channel, status: 404 });
      expect(JSON.stringify(ctx.body)).not.toContain(TERM);
    }
    const liveCtx = await request(app).get('/api/search/context').query({ id: msgId(LIVE, 0), source: 'channel' });
    expect(liveCtx.status).toBe(200);
  });

  it('inbox: expired mentions cannot crowd a live mention out of the window', async () => {
    await expire(DOOMED);
    const t = Date.now() - 600_000;
    await mention(LIVE, SERVER, 0, t);
    await mention(TOMB, SERVER, 0, t + 500);
    await mention(FOREIGN, SERVER, 0, t + 600);
    for (let n = 0; n < 130; n++) await mention(DOOMED, SERVER, n, t + 1000 + n);

    const reply = await request(app).get('/api/inbox').query({ filter: 'mentions' });
    expect(reply.status).toBe(200);
    const channels = reply.body.items.map((item: { destination: { channelId: string } }) => item.destination.channelId);
    expect(channels).toEqual([LIVE]);
    expect(reply.body.counts.mentions).toBe(1);
    expect(JSON.stringify(reply.body)).not.toContain('secret body of ' + DOOMED);
  });
});
