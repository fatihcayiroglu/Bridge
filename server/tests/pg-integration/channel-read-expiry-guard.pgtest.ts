/**
 * P7 D2: real PostgreSQL + HTTP evidence.
 *
 * This deliberately seeds an expiry via SQL: no public API enables creating
 * ephemeral channels yet. Verify cached message bodies never bypass a live
 * channel expiry/tombstone preflight.
 */
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown; headers: Record<string, unknown> }, _res: unknown, next: () => void) => {
    const caller = req.headers['x-test-user'];
    req.user = { id: typeof caller === 'string' ? caller : OWNER };
    next();
  },
}));

import express from 'express';
import request from 'supertest';
import { channelLiveForMessageRead } from '../../lib/channelReadExpiryGuard';
import { cache } from '../../lib/redisAdapter';

const db = require('../../db/loader').default;
const messagesRouter = require('../../routes/messages');
const pinsRouter = require('../../routes/pins');
const PG_TEST_URL = process.env.PG_TEST_URL;
const RUN = PG_TEST_URL ? describe : describe.skip;
const STEM = 'pgt-d2-read-' + process.pid + '-' + Date.now();
const OWNER = STEM + '-owner';
const SERVER = STEM + '-server';
const OTHER_OWNER = STEM + '-other-owner';
const OTHER_SERVER = STEM + '-other-server';
const CHANNEL = STEM + '-channel';
const MESSAGE = STEM + '-msg';
const validTime = () => Date.now() + 120_000;

RUN('P7 D2 authoritative message read — real PostgreSQL', () => {
  const q = (sql: string, params: unknown[] = []) => db._pool.query(sql, params);
  const app = express();
  app.use(express.json());
  app.use('/api/channels', messagesRouter);
  app.use('/api/channels', pinsRouter);

  // The separate pin/file listings do not cache their own response. Keep the
  // existing channel and first-page caches populated while SQL changes the
  // authoritative lifecycle state, so those caches cannot mask the denial.
  async function primeCachedContent() {
    const channelKey = 'channel:' + CHANNEL;
    const messagesKey = 'messages:' + CHANNEL + ':first:50';
    await cache.del(channelKey);
    await cache.del(messagesKey);
    const first = await request(app).get('/api/channels/' + CHANNEL + '/messages');
    expect(first.status).toBe(200);
    expect(JSON.stringify(first.body)).toContain('pre-existing secret body');
    const cached = await request(app).get('/api/channels/' + CHANNEL + '/messages');
    expect(cached.status).toBe(200);
    expect(cached.headers['x-cache']).toBe('HIT');
    const channel = await cache.get(channelKey);
    const messages = await cache.get(messagesKey);
    expect(channel).toMatchObject({ _id: CHANNEL, serverId: SERVER });
    expect(JSON.stringify(messages)).toContain('pre-existing secret body');
    return { channelKey, messagesKey, channel, messages };
  }

  async function expectCachedContentUnchanged(snapshot: Awaited<ReturnType<typeof primeCachedContent>>) {
    expect(await cache.get(snapshot.channelKey)).toEqual(snapshot.channel);
    expect(await cache.get(snapshot.messagesKey)).toEqual(snapshot.messages);
  }

  async function cleanup() {
    await q('DELETE FROM channel_expiry_tombstones WHERE "channelId"=$1', [CHANNEL]);
    await q('DELETE FROM channel_read_positions WHERE "channelId"=$1', [CHANNEL]);
    await q('DELETE FROM messages WHERE "channelId"=$1', [CHANNEL]);
    await q('DELETE FROM channels WHERE _id=$1', [CHANNEL]);
    await q('DELETE FROM members WHERE "serverId" IN ($1,$2)', [SERVER, OTHER_SERVER]);
    await q('DELETE FROM servers WHERE _id IN ($1,$2)', [SERVER, OTHER_SERVER]);
    await q('DELETE FROM users WHERE _id IN ($1,$2)', [OWNER, OTHER_OWNER]);
  }

  beforeAll(async () => {
    await cleanup();
    await q('INSERT INTO users (_id,username,"displayName",password,"createdAt") VALUES ($1,$2,$3,$4,1)',
      [OWNER, 'owner', 'Owner', 'irrelevant']);
    await q('INSERT INTO users (_id,username,"displayName",password,"createdAt") VALUES ($1,$2,$3,$4,1)',
      [OTHER_OWNER, OTHER_OWNER, 'Other Owner', 'irrelevant']);
    await q('INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,$2,$3,1)',
      [SERVER, 'expiry-guard-server', OWNER]);
    await q('INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,$2,$3,1)',
      [OTHER_SERVER, 'expiry-guard-other-server', OTHER_OWNER]);
    await q('INSERT INTO members ("userId","serverId",roles,"joinedAt") VALUES ($1,$2,$3::jsonb,1)',
      [OWNER, SERVER, '[]']);
    await q('INSERT INTO members ("userId","serverId",roles,"joinedAt") VALUES ($1,$2,$3::jsonb,1)',
      [OTHER_OWNER, OTHER_SERVER, '[]']);
    await q('INSERT INTO channels (_id,"serverId",name,"createdAt") VALUES ($1,$2,$3,1)',
      [CHANNEL, SERVER, 'expiry-guard-channel']);
    await q('INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,"createdAt",type,pinned)' +
      ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [MESSAGE, CHANNEL, SERVER, OWNER, 'owner', 'Owner', 'pre-existing secret body', Date.now(), 'file', true]);
  });
  afterAll(cleanup);

  it('checks a tenant-scoped permanent channel on real PostgreSQL', async () => {
    expect(await channelLiveForMessageRead(db._pool, CHANNEL, SERVER)).toBe(true);
    expect(await channelLiveForMessageRead(db._pool, CHANNEL, OTHER_SERVER)).toBe(false);
    for (const listing of ['pins', 'files']) {
      const path = '/api/channels/' + CHANNEL + '/' + listing;
      const baseline = await request(app).get(path);
      expect(baseline.status).toBe(200);
      expect(JSON.stringify(baseline.body)).toContain('pre-existing secret body');
      const foreignTenant = await request(app).get(path).set('X-Test-User', OTHER_OWNER);
      expect(foreignTenant.status).toBe(403);
      expect(JSON.stringify(foreignTenant.body)).not.toContain('pre-existing secret body');
    }
  });

  it('blocks expired channel before cached first-page response is served', async () => {
    const baseline = await request(app).get('/api/channels/' + CHANNEL + '/messages');
    expect(baseline.status).toBe(200);
    expect(baseline.body.messages.some((m: { _id: string }) => m._id === MESSAGE)).toBe(true);

    const cached = await request(app).get('/api/channels/' + CHANNEL + '/messages');
    expect(cached.status).toBe(200);
    expect(cached.headers['x-cache']).toBe('HIT');
    expect(cached.body.messages.some((m: { _id: string }) => m._id === MESSAGE)).toBe(true);

    await q('UPDATE channels SET "expiresAt"=$1,"expiryVersion"=1 WHERE _id=$2',
      [Date.now() - 1000, CHANNEL]);
    const blocked = await request(app).get('/api/channels/' + CHANNEL + '/messages');
    expect(blocked.status).toBe(404);
    expect(JSON.stringify(blocked.body)).not.toContain('pre-existing secret body');
    expect(await channelLiveForMessageRead(db._pool, CHANNEL, SERVER)).toBe(false);

    await q('UPDATE channels SET "expiresAt"=$1,"expiryVersion"=2 WHERE _id=$2',
      [validTime(), CHANNEL]);
    const restored = await request(app).get('/api/channels/' + CHANNEL + '/messages');
    expect(restored.status).toBe(200);
  });

  it('blocks the separate pin and file listings after PostgreSQL expiry', async () => {
    const snapshot = await primeCachedContent();
    const paths = [
      '/api/channels/' + CHANNEL + '/pins',
      '/api/channels/' + CHANNEL + '/files',
    ];
    for (const path of paths) {
      const baseline = await request(app).get(path);
      expect({ path, status: baseline.status }).toEqual({ path, status: 200 });
      expect(JSON.stringify(baseline.body)).toContain('pre-existing secret body');
    }

    await q('UPDATE channels SET "expiresAt"=$1,"expiryVersion"=3 WHERE _id=$2',
      [Date.now() - 1000, CHANNEL]);
    await expectCachedContentUnchanged(snapshot);
    for (const path of paths) {
      const blocked = await request(app).get(path);
      expect({ path, status: blocked.status }).toEqual({ path, status: 404 });
      expect(JSON.stringify(blocked.body)).not.toContain('pre-existing secret body');
    }
    await q('UPDATE channels SET "expiresAt"=$1,"expiryVersion"=4 WHERE _id=$2',
      [validTime(), CHANNEL]);
  });

  it('rejects tombstoned channel across message, pinned and history endpoints', async () => {
    const snapshot = await primeCachedContent();
    // Positive controls ensure a preceding failed expiry test cannot make a
    // tombstone assertion pass merely because the channel was already denied.
    for (const listing of ['pins', 'files']) {
      const baseline = await request(app).get('/api/channels/' + CHANNEL + '/' + listing);
      expect(baseline.status).toBe(200);
      expect(JSON.stringify(baseline.body)).toContain('pre-existing secret body');
    }
    const expiredAt = Date.now() - 1000;
    await q('INSERT INTO channel_expiry_tombstones' +
      ' ("channelId","serverId","expiredAt","expiryVersion","recordedAt","cleanupState")' +
      ' VALUES ($1,$2,$3,2,$4,$5)',
      [CHANNEL, SERVER, expiredAt, Date.now(), 'pending']);
    await expectCachedContentUnchanged(snapshot);
    const paths = [
      '/api/channels/' + CHANNEL + '/messages',
      '/api/channels/' + CHANNEL + '/pinned',
      '/api/channels/' + CHANNEL + '/pins',
      '/api/channels/' + CHANNEL + '/files',
      '/api/channels/' + MESSAGE + '/history',
    ];
    for (const path of paths) {
      const reply = await request(app).get(path);
      expect({ path, status: reply.status }).toEqual({ path, status: 404 });
      expect(JSON.stringify(reply.body)).not.toContain('pre-existing secret body');
    }
    expect(await channelLiveForMessageRead(db._pool, CHANNEL, SERVER)).toBe(false);
  });
});
